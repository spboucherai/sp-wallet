// Live READ-ONLY check of the NEAR adapter against mainnet: health + identity, balances, deposit scan (index + RPC re-verification),
// prepare() from a funded public implicit account (proves both sources agree at one final block) and tracking of a real, an
// unknown and an expired transaction. Nothing is signed or broadcast. The free FastNEAR endpoint is rate limited: run it once,
// not in a loop.  Run: npx tsx scripts/smoke-near.mts
import { createHash } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, formatUnits, intentHash, pluginFor, toHex } = await import('@spw/core');
const { nearAdapter } = await import('../services/api/src/chains/near.ts');

const n = NETWORKS.near, a = nearAdapter(n), near = (v: bigint) => `${formatUnits(v, 24)} NEAR`;
const FUNDED = process.env.NEAR_FROM ?? '5c33c6218d47e00ef229f60da78d0897e1ee9665312550b8afd5f9c7bc6957d2'; // long-lived public implicit account (exchange)
const NAMED = process.env.NEAR_TO ?? 'bridge-mng.near';
const FRESH = createHash('sha256').update(`spw-smoke-nonexistent-${Date.now()}`).digest('hex'); // an implicit account nobody has funded
const NO_SUCH_NAME = `spw-smoke-${Date.now()}.near`;
const AMOUNT = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(38), JSON.stringify(await f(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
  catch (e) { failed++; console.log(name.padEnd(38), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };
const rpc = async (url: string, method: string, params: unknown) => ((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: any }).result;
/** prepare, then rebuild the exact transaction with the plugin from the resulting intent (as the API does before approval) */
const prepareAndBuild = async (to: string, amount: bigint) => {
  const p = await a.prepare({ asset: 'native', from: FUNDED, to, amount });
  const now = Math.floor(Date.now() / 1000);
  const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'NEAR', decimals: 24,
    amount: amount.toString(), from: FUNDED, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 2, ...(p.section as { x: Record<string, string> }) };
  const built = pluginFor(n).build(intent, n);
  // independent cross-check of what was agreed: the reference block is final on both sources and the nonce follows the key's
  const blocks = await Promise.all(n.rpc.map((u) => rpc(u, 'block', { block_id: intent.x.blockHash })));
  if (blocks.some((b) => b?.header?.hash !== intent.x.blockHash || b.header.height !== blocks[0].header.height)) throw new Error('reference block not served identically by both sources');
  return { x: intent.x, refHeight: blocks[0].header.height, maxFee: near(p.maxFee), feeEstimate: near(p.feeEstimate), warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), txid: built.describe.txid };
};

await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
await step('balance (funded public account)', async () => { const b = await a.balances(FUNDED); if (b.native! <= 0n) throw new Error('zero'); return near(b.native!); });
await step('balance (account that does not exist)', async () => { const b = await a.balances(FRESH); if (b.native !== 0n) throw new Error('non-zero'); return near(b.native); });
let seen: { txid: string; from: string; amount: bigint; block: number } | undefined;
await step('deposits (first scan, re-verified)', async () => {
  const d = await a.deposits(FUNDED, null); seen = d.items[0];
  return { items: d.items.length, cursor: d.cursor, finalizedHeight: d.finalizedHeight, newest: d.items[0] && { ...d.items[0], amount: near(d.items[0].amount) } };
});
if (seen) await step('deposits (incremental, same rows)', async () => { const e = await a.deposits(FUNDED, seen!.block - 1); if (!e.items.some((i) => i.txid === seen!.txid)) throw new Error('missing'); return { items: e.items.length, cursor: e.cursor }; });
await step('deposits (account without history)', async () => { const d = await a.deposits(FRESH, null); if (d.items.length) throw new Error('unexpected'); return { items: 0, cursor: d.cursor }; });
await step('prepare → existing named account', async () => { const r = await prepareAndBuild(NAMED, AMOUNT); if (r.warnings.length) throw new Error('unexpected warning'); return r; });
await step('prepare → new implicit account', async () => { const r = await prepareAndBuild(FRESH, AMOUNT); if (!r.warnings.includes('near_creates_account')) throw new Error('expected creation warning'); return r; });
await step('prepare → named account that does not exist', expectErr('bad_destination', () => a.prepare({ asset: 'native', from: FUNDED, to: NO_SUCH_NAME, amount: AMOUNT })));
await step('prepare → Ethereum-style account', expectErr('bad_address', () => a.prepare({ asset: 'native', from: FUNDED, to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', amount: AMOUNT })));
await step('prepare ← unfunded source', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FRESH, to: NAMED, amount: AMOUNT })));
await step('prepare, more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: NAMED, amount: 10n ** 33n })));
const nowSec = Math.floor(Date.now() / 1000);
const final = await rpc(n.rpc[1]!, 'block', { finality: 'final' });
if (seen) await step('track (real transfer, days old)', async () => {
  const t = await a.track({ txid: seen!.txid, intent: { from: seen!.from, to: FUNDED, amount: seen!.amount.toString(), x: { nonce: '1', blockHash: final.header.hash }, createdAt: nowSec - 900 }, blockRef: null, broadcastAt: nowSec - 900 });
  if (t.state !== 'finalized') throw new Error(JSON.stringify(t)); return t;
});
// a well-formed transaction hash that no transaction has; the nonce is above anything the key has used
const unknown = (blockHash: string) => ({ txid: '11111111111111111111111111111112',
  intent: { from: FUNDED, to: NAMED, amount: '1', x: { nonce: '18446744073709551615', blockHash }, createdAt: nowSec - 900 }, blockRef: null, broadcastAt: nowSec - 900 });
await step('track (unknown, reference block recent)', async () => { const t = await a.track(unknown(final.header.hash)); if (t.state !== 'broadcast' || !t.rebroadcast) throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, reference block expired)', async () => {
  const old = await rpc(n.rpc[1]!, 'block', { block_id: final.header.height - 86_400 - 2_000 });
  const p = unknown(old.header.hash); p.txid = '11111111111111111111111111111113';
  const t = await a.track(p); if (t.state !== 'failed') throw new Error(JSON.stringify(t)); return { ...t, refHeight: old.header.height, finalHeight: final.header.height };
});
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing signed or broadcast)');
process.exit(failed ? 1 : 0);

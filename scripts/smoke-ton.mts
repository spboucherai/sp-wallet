// Live READ-ONLY check of the TON adapter against mainnet: health + chain identity (zero-state hash), balances, deposit scan,
// prepare() from a funded public wallet v4R2 (proves both sources agree on state, seqno and the bounce flag; runs estimateFee
// and the simulation), and tracking of a real / an unknown message. Nothing is signed with a real key and nothing is broadcast.
// Run: npx tsx scripts/smoke-ton.mts      (TON_FROM / TON_TO override the public addresses used)
import { createHash } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, formatUnits, intentHash, pluginFor, tonFormatAddress, tonNormalizeAddress, tonRawAddress, toHex } = await import('@spw/core');
const { tonAdapter } = await import('../services/api/src/chains/ton.ts');

const n = NETWORKS.ton, a = tonAdapter(n), ton = (v: bigint) => `${formatUnits(v, 9)} TON`;
// a public, active wallet v4R2 with the default subwallet id (picked from a recent block; any other such wallet works)
const FUNDED = tonNormalizeAddress(process.env.TON_FROM ?? '0:1de184a0c1767bcea7c803fdcbfe6304907a0cef39b117a664c0579150fe903b');
const ACTIVE = tonNormalizeAddress(process.env.TON_TO ?? 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'); // TON Foundation wallet (an initialized contract)
const FRESH = tonFormatAddress(createHash('sha256').update(`spw-smoke-nonexistent-${Date.now()}`).digest()); // nobody's address: no contract, no coins
const TEST_WALLET = 'UQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-RKY'; // v4R2 wallet of the public test mnemonic at m/44'/607'/0' (never funded)
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(40), JSON.stringify(await f(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
  catch (e) { failed++; console.log(name.padEnd(40), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };
/** prepare, then rebuild the exact signing message with the plugin from the resulting intent (as the API does before approval) */
const prepareAndBuild = async (to: string, amount: bigint, memo?: string) => {
  const p = await a.prepare({ asset: 'native', from: FUNDED, to, amount, memo });
  const now = Math.floor(Date.now() / 1000);
  const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'TON', decimals: 9,
    amount: amount.toString(), from: FUNDED, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 2, ...(memo ? { memo } : {}), ...(p.section as { x: Record<string, string> }) };
  const built = pluginFor(n).build(intent, n);
  return { x: intent.x, feeEstimate: ton(p.feeEstimate), maxFee: ton(p.maxFee), warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), signingHash: built.describe.signingHash };
};

console.log('sources', n.rpc.join(' , '), '| chainRef (zero-state root hash)', n.chainRef);
console.log('addresses', JSON.stringify({ FUNDED, ACTIVE, FRESH, TEST_WALLET }));
await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
let balance = 0n;
await step('balance (funded public wallet)', async () => { balance = (await a.balances(FUNDED)).native!; if (balance <= 0n) throw new Error('zero'); return ton(balance); });
await step('balance (address with nothing on it)', async () => { const b = await a.balances(FRESH); if (b.native !== 0n) throw new Error('non-zero'); return ton(b.native); });
await step('deposits (first scan)', async () => {
  const d = await a.deposits(FUNDED, null);
  if (d.items.length > 0) await step('deposits (incremental)', async () => { const e = await a.deposits(FUNDED, d.items[0]!.block - 1); if (!e.items.some((x) => x.txid === d.items[0]!.txid)) throw new Error('missed'); return { items: e.items.length, cursor: e.cursor }; });
  return { items: d.items.length, cursor: d.cursor, finalizedHeight: d.finalizedHeight, newest: d.items[0] && { ...d.items[0], amount: ton(d.items[0].amount) } };
});
const small = balance / 20n > 0n ? balance / 20n : 1n;
await step('prepare → initialized contract', async () => { const r = await prepareAndBuild(ACTIVE, small); if (r.x.bounce !== '1' || r.x.stateInit !== '0') throw new Error(JSON.stringify(r.x)); return r; });
await step('prepare → empty address, comment', async () => { const r = await prepareAndBuild(FRESH, small, 'smoke test ✓'); if (r.x.bounce !== '0') throw new Error('expected non-bounceable'); return r; });
await step('prepare ← wallet holding nothing', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: TEST_WALLET, to: ACTIVE, amount: 1_000_000n })));
await step('prepare, more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: ACTIVE, amount: balance + 1n })));
await step('prepare, a jetton', expectErr('unsupported_asset', () => a.prepare({ asset: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', from: FUNDED, to: ACTIVE, amount: 1n })));

// tracking: the wallet's latest outgoing transfer, straight from the second source (normalized message hash, destination, value)
const nowSec = Math.floor(Date.now() / 1000);
let recent: { transactions?: any[] } = {};
for (let k = 0; k < 6 && !recent.transactions; k++) { // keyless sources answer 429 after a burst
  const r = await fetch(`${n.rpc[1]}/blockchain/accounts/${tonRawAddress(FUNDED)}/transactions?limit=20`);
  if (r.ok) recent = (await r.json()) as { transactions: any[] }; else await new Promise((w) => setTimeout(w, 1500));
}
const sent = (recent.transactions ?? []).find((t) => t.in_msg?.msg_type === 'ext_in_msg' && t.out_msgs?.length === 1 && t.out_msgs[0].destination?.address?.startsWith('0:'));
const seqnoNow = Number((await a.prepare({ asset: 'native', from: FUNDED, to: ACTIVE, amount: small }).then((p) => (p.section as any).x.seqno)));
if (sent) {
  const real = { from: FUNDED, to: tonNormalizeAddress(sent.out_msgs[0].destination.address), amount: String(sent.out_msgs[0].value), x: { validUntil: String(sent.utime + 60), seqno: '0' } };
  await step('track (real included transfer)', async () => { const t = await a.track({ txid: sent.in_msg.hash, intent: real, blockRef: null, broadcastAt: sent.utime }); if (t.state !== 'finalized') throw new Error(JSON.stringify(t)); return { ...t, txid: sent.in_msg.hash }; });
  await step('track (same, other amount approved)', async () => { try { await a.track({ txid: sent.in_msg.hash, intent: { ...real, amount: '1' }, blockRef: null, broadcastAt: sent.utime }); } catch (e) { return `no verdict, as expected: ${(e as Error).message}`; } throw new Error('expected a refusal'); });
} else { failed++; console.log('track (real included transfer)'.padEnd(40), 'ERR no outgoing transfer among the last 20 transactions of this wallet'); }
const ghost = (validUntil: number, seqno: number) => ({ txid: 'ab'.repeat(32), intent: { from: FUNDED, to: ACTIVE, amount: '1', x: { validUntil: String(validUntil), seqno: String(seqno) } }, blockRef: null, broadcastAt: nowSec });
await step('track (unknown, still valid)', async () => { const t = await a.track(ghost(nowSec + 600, seqnoNow)); if (t.state !== 'broadcast' || !t.rebroadcast) throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, expired, seqno unused)', async () => { const t = await a.track(ghost(nowSec - 600, seqnoNow)); if (t.state !== 'failed') throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, expired, seqno used)', async () => { const t = await a.track(ghost(nowSec - 600, seqnoNow - 1)); if (t.state !== 'broadcast' || t.rebroadcast) throw new Error(JSON.stringify(t)); return t; });
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing signed or broadcast)');
process.exit(failed ? 1 : 0);

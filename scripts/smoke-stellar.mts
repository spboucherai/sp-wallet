// Live READ-ONLY check of the Stellar adapter against mainnet: health + identity, balances, deposit scan, prepare() from a funded
// public address (proves both sources agree) and tracking of a real / an unknown transaction. Nothing is signed or broadcast.
// Run: npx tsx scripts/smoke-stellar.mts
import { createHash } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, formatUnits, intentHash, pluginFor, stellarEncodeAccount, toHex } = await import('@spw/core');
const { stellarAdapter } = await import('../services/api/src/chains/stellar.ts');

const n = NETWORKS.stellar, a = stellarAdapter(n), xlm = (v: bigint) => `${formatUnits(v, 7)} XLM`;
const FUNDED = process.env.XLM_FROM ?? 'GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM'; // long-lived exchange account
const EXISTING = process.env.XLM_TO ?? 'GBN7BKMAFTQXLW27B4WYFU7VS34V422S6ZCD3GUCC4MY4UBGUMNNKCJR';
const FRESH = stellarEncodeAccount(createHash('sha256').update(`spw-smoke-nonexistent-${Date.now()}`).digest());
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(34), JSON.stringify(await f(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
  catch (e) { failed++; console.log(name.padEnd(34), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };
/** prepare, then rebuild the exact transaction with the plugin from the resulting intent (as the API does before approval) */
const prepareAndBuild = async (to: string, amount: bigint, memo?: string) => {
  const p = await a.prepare({ asset: 'native', from: FUNDED, to, amount, memo });
  const now = Math.floor(Date.now() / 1000);
  const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'XLM', decimals: 7,
    amount: amount.toString(), from: FUNDED, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 3, ...(memo ? { memo } : {}), ...(p.section as { x: Record<string, string> }) };
  const built = pluginFor(n).build(intent, n);
  return { x: intent.x, maxFee: p.maxFee, warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), txid: built.describe.txid };
};

await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
await step('balance (funded public account)', async () => { const b = await a.balances(FUNDED); if (b.native! <= 0n) throw new Error('zero'); return xlm(b.native!); });
await step('balance (account that does not exist)', async () => { const b = await a.balances(FRESH); if (b.native !== 0n) throw new Error('non-zero'); return xlm(b.native); });
let lastTx = '';
await step('deposits (first scan)', async () => {
  const d = await a.deposits(FUNDED, null); lastTx = d.items[0]?.txid ?? '';
  if (d.items.length > 0) await step('deposits (incremental)', async () => { const e = await a.deposits(FUNDED, d.items[d.items.length - 1]!.block - 1); return { items: e.items.length, cursor: e.cursor }; });
  return { items: d.items.length, cursor: d.cursor, finalizedHeight: d.finalizedHeight, newest: d.items[0] && { ...d.items[0], amount: xlm(d.items[0].amount) } };
});
await step('prepare → existing account', async () => { const r = await prepareAndBuild(EXISTING, 12_500_000n); if (r.x.op !== 'payment') throw new Error('expected payment'); return r; });
await step('prepare → existing, numeric memo', async () => { const r = await prepareAndBuild(EXISTING, 12_500_000n, '123456'); if (r.x.memoType !== 'id') throw new Error('expected id'); return r; });
await step('prepare → new account (2 XLM)', async () => { const r = await prepareAndBuild(FRESH, 20_000_000n, 'hello'); if (r.x.op !== 'createAccount') throw new Error('expected createAccount'); return r; });
await step('prepare → new account (0.5 XLM)', expectErr('below_reserve', () => a.prepare({ asset: 'native', from: FUNDED, to: FRESH, amount: 5_000_000n })));
await step('prepare ← unfunded source', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FRESH, to: EXISTING, amount: 5_000_000n })));
await step('prepare, more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: EXISTING, amount: 9_000_000_000_000_000_000n })));
const nowSec = Math.floor(Date.now() / 1000);
if (lastTx) await step('track (real included transaction)', async () => { const t = await a.track({ txid: lastTx, intent: { x: { maxTime: String(nowSec) } }, blockRef: null, broadcastAt: nowSec }); if (t.state !== 'finalized') throw new Error(t.state); return t; });
await step('track (unknown, time bound open)', async () => { const t = await a.track({ txid: 'ab'.repeat(32), intent: { x: { maxTime: String(nowSec + 600) } }, blockRef: null, broadcastAt: nowSec }); if (t.state !== 'broadcast') throw new Error(t.state); return t; });
await step('track (unknown, time bound passed)', async () => { const t = await a.track({ txid: 'ab'.repeat(32), intent: { x: { maxTime: String(nowSec - 600) } }, blockRef: null, broadcastAt: nowSec - 800 }); if (t.state !== 'failed') throw new Error(t.state); return t; });
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing signed or broadcast)');
process.exit(failed ? 1 : 0);

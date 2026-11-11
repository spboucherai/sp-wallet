// Live READ-ONLY check of the Aptos adapter against mainnet: health + identity, balances, deposit scan, prepare() from a funded
// public address (proves both sources agree and simulate the transfer), then the exact transaction built by the signer's plugin
// is simulated on both sources with the sender's public key and an all-zero signature, as /v1/transactions/simulate requires
// (such a payload cannot be submitted). Tracking of a real / an unknown transaction. Nothing is signed or broadcast.
// Run: npx tsx scripts/smoke-aptos.mts
import { createHash } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, aptosAddressOf, aptosSignedTx, aptosTxid, buildAptosTx, formatUnits, intentHash, pluginFor, toHex } = await import('@spw/core');
const { aptosAdapter } = await import('../services/api/src/chains/aptos.ts');

const n = NETWORKS.aptos!, a = aptosAdapter(n), apt = (v: bigint) => `${formatUnits(v, 8)} APT`;
const FUNDED = process.env.APT_FROM ?? '0x631cd86372d984f7ecac32d28d495404d87a395ab00e2efb41d76386673207a1'; // public account holding APT (seen sending on 2026-11-10)
const EXISTING = process.env.APT_TO ?? '0xd9815a5af17873faad0f9102d1ae4c3355ea0076ed4d6fb266208206cff75552'; // account that already holds APT
const FRESH = '0x' + createHash('sha256').update(`spw-smoke-nonexistent-${Date.now()}`).digest('hex');
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(40), JSON.stringify(await f(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
  catch (e) { failed++; console.log(name.padEnd(40), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };

/** the sender's ed25519 public key, read from its latest transaction on-chain and checked against the address */
async function publicKeyOf(addr: string): Promise<Uint8Array> {
  const txs = (await (await fetch(`${n.rpc[0]}/accounts/${addr}/transactions?limit=1`)).json()) as { signature?: { type?: string; public_key?: string } }[];
  const s = txs[0]?.signature;
  if (s?.type !== 'ed25519_signature' || !s.public_key) throw new Error('the funded account has no plain ed25519 transaction to read its public key from');
  const pub = Uint8Array.from(Buffer.from(s.public_key.slice(2), 'hex'));
  if (aptosAddressOf(pub) !== addr) throw new Error('public key does not derive the address (rotated key)');
  return pub;
}
/** prepare, rebuild the exact transaction with the plugin (as the API does before approval), simulate it on both sources */
const prepareBuildSimulate = async (to: string, amount: bigint) => {
  const p = await a.prepare({ asset: 'native', from: FUNDED, to, amount });
  const now = Math.floor(Date.now() / 1000);
  const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'APT', decimals: 8,
    amount: amount.toString(), from: FUNDED, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 3, ...(p.section as { x: Record<string, string> }) };
  pluginFor(n).build(intent, n);
  const body = aptosSignedTx(buildAptosTx(intent, n).rawTx, await publicKeyOf(FUNDED), new Uint8Array(64)); // exact transaction, zeroed signature
  const simulated: Record<string, unknown> = {};
  for (const u of n.rpc) {
    const r = await fetch(`${u}/transactions/simulate`, { method: 'POST', headers: { 'content-type': 'application/x.aptos.signed_transaction+bcs', accept: 'application/json' }, body });
    const j = (await r.json()) as { success?: boolean; vm_status?: string; gas_used?: string; hash?: string }[];
    const s = Array.isArray(j) ? j[0] : undefined;
    if (!r.ok || !s || s.success !== true) throw new Error(`simulation failed on ${new URL(u).host}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    if (s.hash !== aptosTxid(body)) throw new Error(`${new URL(u).host} computed another transaction hash`);
    if (BigInt(s.gas_used!) > BigInt(intent.x.max_gas_amount!)) throw new Error('gas used above the approved limit');
    simulated[new URL(u).host] = { success: s.success, vm_status: s.vm_status, gas_used: s.gas_used, hashMatchesOurs: true };
  }
  return { x: intent.x, maxFee: apt(p.maxFee), feeEstimate: apt(p.feeEstimate), warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), simulated };
};

await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
await step('balance (funded public account)', async () => { const b = await a.balances(FUNDED); if (b.native! <= 0n) throw new Error('zero'); return apt(b.native!); });
await step('balance (account that does not exist)', async () => { const b = await a.balances(FRESH); if (b.native !== 0n) throw new Error('non-zero'); return apt(b.native); });
let lastTx = '';
await step('deposits (first scan)', async () => {
  const d = await a.deposits(EXISTING, null); lastTx = d.items[d.items.length - 1]?.txid ?? '';
  if (d.items.length > 0) await step('deposits (incremental)', async () => { const e = await a.deposits(EXISTING, d.items[0]!.block - 1); if (e.items.length < 1) throw new Error('nothing after the cursor'); return { items: e.items.length, cursor: e.cursor }; });
  const newest = d.items[d.items.length - 1];
  return { items: d.items.length, cursor: d.cursor, finalizedHeight: d.finalizedHeight, newest: newest && { ...newest, amount: apt(newest.amount) } };
});
await step('prepare + exact simulation → existing', async () => { const r = await prepareBuildSimulate(EXISTING, 1_000_000n); if (BigInt(r.x.max_gas_amount!) > 2_000n) throw new Error('unexpected gas'); return r; });
await step('prepare + exact simulation → new account', () => prepareBuildSimulate(FRESH, 1_000_000n));
await step('prepare ← unfunded source', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FRESH, to: EXISTING, amount: 1_000_000n })));
await step('prepare, more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: EXISTING, amount: 9_000_000_000_000_000_000n })));
await step('prepare, to itself', expectErr('bad_address', () => a.prepare({ asset: 'native', from: FUNDED, to: FUNDED, amount: 1_000_000n })));
const nowSec = Math.floor(Date.now() / 1000);
if (lastTx) await step('track (real committed transaction)', async () => { const t = await a.track({ txid: lastTx, intent: { x: { expiration_timestamp_secs: String(nowSec) } }, blockRef: null, broadcastAt: nowSec }); if (t.state !== 'finalized') throw new Error(t.state); return t; });
await step('track (unknown, not expired)', async () => { const t = await a.track({ txid: '0x' + 'ab'.repeat(32), intent: { x: { expiration_timestamp_secs: String(nowSec + 600) } }, blockRef: null, broadcastAt: nowSec }); if (t.state !== 'broadcast') throw new Error(t.state); return t; });
await step('track (unknown, expired)', async () => { const t = await a.track({ txid: '0x' + 'ab'.repeat(32), intent: { x: { expiration_timestamp_secs: String(nowSec - 600) } }, blockRef: null, broadcastAt: nowSec - 800 }); if (t.state !== 'failed') throw new Error(t.state); return t; });
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing signed or broadcast)');
process.exit(failed ? 1 : 0);

// Live READ-ONLY check of the Sui adapter against mainnet: health + identity, balances, deposit scan, prepare() from a funded
// public address (proves both sources agree), the prepared bytes rebuilt by the official SDK (byte-identical) and dry-run on both
// sources (success, identical effects summary), and tracking of a real / an unknown transaction. Nothing is signed or broadcast.
// Run: npx tsx scripts/smoke-sui.mts
import { createHash } from 'node:crypto';
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { NETWORKS, buildSuiTx, formatUnits, intentHash, pluginFor, suiParsePayment, toHex } = await import('@spw/core');
const { suiAdapter } = await import('../services/api/src/chains/sui.ts');
const { grpcCall } = await import('../services/api/src/chains/sui-grpc.ts');
const { GrpcTypes } = await import('@mysten/sui/grpc');
const { Transaction } = await import('@mysten/sui/transactions');

const n = NETWORKS.sui!, a = suiAdapter(n), sui = (v: bigint) => `${formatUnits(v, 9)} SUI`;
const FUNDED = process.env.SUI_FROM ?? '0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd'; // long-lived public address holding a few SUI in coins
const DEST = process.env.SUI_TO ?? '0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1'; // address of the public test mnemonic
const FRESH = '0x' + createHash('sha256').update(`spw-smoke-nonexistent-${Date.now()}`).digest('hex');
let failed = 0;
const step = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(name.padEnd(38), JSON.stringify(await f(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
  catch (e) { failed++; console.log(name.padEnd(38), 'ERR', (e as { code?: string }).code ?? '', (e as Error).message); }
};
const expectErr = (code: string, f: () => Promise<unknown>) => async () => { try { await f(); } catch (e) { if ((e as { code?: string }).code === code) return `refused as expected: ${(e as Error).message}`; throw e; } throw new Error(`expected ${code}`); };

/** dry run of exact bytes on one source, decoded with the message types generated from the official .proto files */
async function dryRun(url: string, tx: Uint8Array) {
  const req = GrpcTypes.SimulateTransactionRequest.toBinary(GrpcTypes.SimulateTransactionRequest.create({ transaction: { bcs: { value: tx } }, checks: 0, doGasSelection: false,
    readMask: { paths: ['transaction.effects.status', 'transaction.effects.gas_used', 'transaction.effects.epoch', 'transaction.balance_changes'] } }));
  const [frame] = await grpcCall(url, '/sui.rpc.v2.TransactionExecutionService/SimulateTransaction', req);
  const t = GrpcTypes.SimulateTransactionResponse.fromBinary(frame!).transaction!, g = t.effects!.gasUsed!;
  return { success: t.effects!.status!.success, error: t.effects!.status!.error?.description ?? null, epoch: t.effects!.epoch,
    gas: { computation: g.computationCost, storage: g.storageCost, rebate: g.storageRebate, nonRefundable: g.nonRefundableStorageFee },
    balanceChanges: t.balanceChanges.map((c) => `${c.address} ${c.coinType?.split('::').slice(1).join('::')} ${c.amount}`).sort() };
}
/** prepare, then rebuild the exact transaction with the plugin from the resulting intent (as the API does before approval) */
const prepareAndBuild = async (to: string, amount: bigint) => {
  const p = await a.prepare({ asset: 'native', from: FUNDED, to, amount });
  const now = Math.floor(Date.now() / 1000);
  const intent = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-smoke-0000000', network: n.id, chainRef: n.chainRef, asset: 'native', symbol: 'SUI', decimals: 9,
    amount: amount.toString(), from: FUNDED, to, maxFee: p.maxFee.toString(), createdAt: now, expiresAt: now + p.ttlSec, policyVersion: 3, ...(p.section as { x: Record<string, string> }) };
  const built = pluginFor(n).build(intent, n);
  return { p, intent, built, tx: buildSuiTx(intent, n).tx };
};

await step('health', async () => { const h = await a.health(); if (!h.ok || !h.identityVerified) throw new Error(JSON.stringify(h)); return h; });
await step('balance (funded public address)', async () => { const b = await a.balances(FUNDED); if (b.native! <= 0n) throw new Error('zero'); return sui(b.native!); });
await step('balance (address never used)', async () => { const b = await a.balances(FRESH); if (b.native !== 0n) throw new Error('non-zero'); return sui(b.native); });
let lastTx = '';
await step('deposits (first scan)', async () => {
  const d = await a.deposits(FUNDED, null); lastTx = d.items[0]?.txid ?? '';
  if (d.items.length > 0) await step('deposits (incremental)', async () => { const e = await a.deposits(FUNDED, d.items[d.items.length - 1]!.block - 1); if (!e.items.some((x) => x.txid === d.items[d.items.length - 1]!.txid)) throw new Error('known deposit not found again'); return { items: e.items.length, cursor: e.cursor }; });
  return { items: d.items.length, cursor: d.cursor, finalizedHeight: d.finalizedHeight, newest: d.items[0] && { ...d.items[0], amount: sui(d.items[0].amount) } };
});
await step('deposits (cursor at the tip)', async () => { const h = (await a.health()).height!; const d = await a.deposits(FUNDED, h - 5); if (d.items.length !== 0 || d.cursor < h - 5) throw new Error(JSON.stringify(d)); return { items: 0, cursor: d.cursor }; });
await step('prepare → 0.25 SUI', async () => {
  const { p, intent, built, tx } = await prepareAndBuild(DEST, 250_000_000n);
  // the same transaction built offline by the official SDK from the prepared parameters
  const sdk = new Transaction();
  sdk.setSender(FUNDED); sdk.setGasPrice(BigInt(intent.x.gasPrice!)); sdk.setGasBudget(BigInt(intent.x.gasBudget!)); sdk.setExpiration({ Epoch: intent.x.expiration! });
  sdk.setGasPayment(suiParsePayment(intent.x.payment).map((r) => ({ objectId: r.objectId, version: r.version.toString(), digest: r.digest })));
  const [coin] = sdk.splitCoins(sdk.gas, [250_000_000n]); sdk.transferObjects([coin!], DEST);
  const sdkBytes = await sdk.build();
  if (toHex(sdkBytes) !== toHex(tx)) throw new Error('bytes differ from the SDK');
  if (await sdk.getDigest() !== built.describe.txid) throw new Error('digest differs from the SDK');
  // dry run of those exact bytes on each source
  const runs = await Promise.all(n.rpc.map((u) => dryRun(u, tx)));
  for (const r of runs) if (!r.success || JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) !== JSON.stringify(runs[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) throw new Error(`dry runs differ or failed: ${JSON.stringify(runs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return { x: intent.x, maxFee: p.maxFee, feeEstimate: p.feeEstimate, warnings: p.warnings, ttlSec: p.ttlSec, intentHash: toHex(intentHash(intent)), txid: built.describe.txid, txBytes: tx.length, sdkBytesIdentical: true,
    dryRunIdenticalOn: n.rpc.map((u) => new URL(u).host), effects: runs[0] };
});
await step('prepare → address never used', async () => { const { p, built } = await prepareAndBuild(FRESH, 1_000_000n); return { maxFee: p.maxFee, feeEstimate: p.feeEstimate, txid: built.describe.txid }; });
await step('prepare → an object id', expectErr('bad_address', async () => {
  const { intent } = await prepareAndBuild(DEST, 1_000_000n);
  return a.prepare({ asset: 'native', from: FUNDED, to: suiParsePayment(intent.x.payment)[0]!.objectId, amount: 1_000_000n }); // one of the sender's own coin objects
}));
await step('prepare → system object 0x5', expectErr('bad_address', () => a.prepare({ asset: 'native', from: FUNDED, to: '0x' + '0'.repeat(63) + '5', amount: 1_000_000n })));
await step('prepare ← address holding no coins', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FRESH, to: DEST, amount: 5_000_000n })));
await step('prepare, more than the balance', expectErr('insufficient_funds', () => a.prepare({ asset: 'native', from: FUNDED, to: DEST, amount: 9_000_000_000_000_000_000n })));
await step('prepare, a token', expectErr('unsupported_asset', () => a.prepare({ asset: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', from: FUNDED, to: DEST, amount: 1n })));
const nowSec = Math.floor(Date.now() / 1000);
if (lastTx) await step('track (real included transaction)', async () => { const t = await a.track({ txid: lastTx, intent: { createdAt: nowSec, x: { expiration: '1' } }, blockRef: null, broadcastAt: nowSec }); if (t.state !== 'finalized') throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, epoch still open)', async () => { const t = await a.track({ txid: n.chainRef, intent: { createdAt: nowSec, x: { expiration: '99999999' } }, blockRef: null, broadcastAt: nowSec }); if (t.state !== 'broadcast' || !t.rebroadcast) throw new Error(JSON.stringify(t)); return t; });
await step('track (unknown, expired last epoch)', async () => {
  const cur = BigInt((await prepareAndBuild(DEST, 1_000_000n)).intent.x.expiration!);
  // created inside the previous epoch (one hour before the current one began is not known here, so use "now - 23 h" only if that epoch covers it)
  const t = await a.track({ txid: n.chainRef, intent: { createdAt: nowSec, x: { expiration: (cur - 1n).toString() } }, blockRef: null, broadcastAt: nowSec - 90_000 });
  if (t.state !== 'failed') throw new Error(JSON.stringify(t));
  return t;
});
await step('track (unknown, expired, created earlier)', async () => {
  const cur = BigInt((await prepareAndBuild(DEST, 1_000_000n)).intent.x.expiration!);
  const t = await a.track({ txid: n.chainRef, intent: { createdAt: nowSec - 30 * 86_400, x: { expiration: (cur - 1n).toString() } }, blockRef: null, broadcastAt: nowSec - 30 * 86_400 });
  if (t.state !== 'broadcast' || t.rebroadcast) throw new Error(JSON.stringify(t)); // history does not prove it was never executed: no verdict
  return t;
});
console.log(failed ? `FAILED: ${failed} step(s)` : 'OK: all steps passed (read-only, nothing signed or broadcast)');
process.exit(failed ? 1 : 0);

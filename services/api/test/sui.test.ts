// Sui adapter against two scripted full nodes (no network): agreement rules, fail-closed paths, simulation, tracking, deposits.
// The scripted nodes decode every request and encode every answer with the message types generated from the official .proto
// files (@mysten/sui), so these tests also prove the hand-written protobuf layouts of src/chains/sui-grpc.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { bcs } from '@mysten/sui/bcs';
import { GrpcTypes as T } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { NETWORKS, pluginFor, suiFormatPayment, suiParsePayment, suiTxDigest, type Intent } from '@spw/core';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import type { Adapter } from '../src/chains/rpc.ts';
import { decode, encode, GrpcError, M, type GrpcCall } from '../src/chains/sui-grpc.ts';

const n = NETWORKS.sui, [A, B] = n.rpc as [string, string];
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeys(MNEMONIC);
const ME = keys.addresses.sui!, DEST = Ed25519Keypair.deriveKeypair(MNEMONIC, "m/44'/784'/1'/0'/0'").toSuiAddress();
const NOW = 1_800_000_000;
const SUI = `0x${'0'.repeat(63)}2::sui::SUI`, COIN_T = `0x${'0'.repeat(63)}2::coin::Coin<${SUI}>`;
const DIGEST = 'D5PWuxMQiHxxTp77DehNKAn4mNsUw8ifDwA7Efd5GVVg';
const oid = (k: number) => '0x' + k.toString(16).padStart(4, '0').repeat(16);

interface FCoin { objectId: string; version: bigint; digest: string; balance: bigint; owner?: string; type?: string }
interface FTx { success: boolean; checkpoint?: bigint; error?: string; sender?: string; time?: number; changes?: [string, string, string][]; digest?: string }
type Listing = { frames: Uint8Array[] } | { code: number } | null;
interface Fake {
  down: boolean; chainId: string; chain: string; epoch: bigint; height: bigint; time: number; lowest: bigint; gasPrice: bigint;
  coins: FCoin[]; addressBalance: bigint; objects: Set<string>; txs: Record<string, FTx>; epochs: Record<string, { first: bigint; last?: bigint; start: number }>;
  sim: ((tx: Uint8Array) => { success: boolean; error?: string; gas?: [bigint, bigint, bigint]; changes?: [string, string, string][] }) | null;
  exec: (digest: string) => string; executed: { tx: Uint8Array; sig: Uint8Array }[]; list: Listing | ((q: any) => Listing); seen: string[]; lists: any[];
}
const coin = (k: number, balance: bigint, version = 100n): FCoin => ({ objectId: oid(k), version, digest: DIGEST, balance });
const fresh = (): Fake => ({ down: false, chainId: n.chainRef, chain: 'mainnet', epoch: 1308n, height: 5000n, time: NOW - 1, lowest: 1000n, gasPrice: 100n,
  coins: [coin(1, 3_000_000_000n), coin(2, 1_000_000_000n)], addressBalance: 0n, objects: new Set(), txs: {}, epochs: { 1307: { first: 3000n, last: 3999n, start: NOW - 90_000 }, 1308: { first: 4000n, start: NOW - 3600 } },
  sim: null, exec: (d) => d, executed: [], list: null, seen: [], lists: [] });
let h: Record<string, Fake>;

/** what a real node computes for the pay-SUI transaction: gas smashing, split, transfer */
function defaultSim(f: Fake, tx: Uint8Array) {
  const d = bcs.TransactionData.parse(tx).V1!, ptb = d.kind.ProgrammableTransaction!;
  const amount = BigInt(bcs.u64().parse(Buffer.from(ptb.inputs[0]!.Pure!.bytes, 'base64'))), to = bcs.Address.parse(Buffer.from(ptb.inputs[1]!.Pure!.bytes, 'base64'));
  let sum = 0n;
  for (const p of d.gasData.payment!) {
    const c = f.coins.find((x) => x.objectId === p.objectId);
    if (!c || c.version.toString() !== p.version || c.digest !== p.digest) throw new GrpcError(3, `object ${p.objectId} is not available at that version`);
    sum += c.balance;
  }
  if (BigInt(d.gasData.price!) < f.gasPrice) throw new GrpcError(3, 'gas price below the reference gas price');
  if (BigInt(d.expiration.Epoch ?? 0) < f.epoch) throw new GrpcError(3, 'transaction expired');
  const budget = BigInt(d.gasData.budget!), comp = 1000n * f.gasPrice, storage = 1_976_000n, rebate = 978_120n * BigInt(d.gasData.payment!.length);
  if (sum < budget) throw new GrpcError(3, 'gas balance below the budget');
  if (budget < comp + storage) return { success: false, error: 'InsufficientGas', gas: [comp, 0n, 0n] as [bigint, bigint, bigint], changes: [[d.sender!, SUI, (-budget).toString()]] as [string, string, string][] };
  if (amount > sum - budget) return { success: false, error: 'InsufficientCoinBalance in command 0', gas: [comp, 988_000n, rebate] as [bigint, bigint, bigint], changes: [[d.sender!, SUI, (-(comp + 988_000n - rebate)).toString()]] as [string, string, string][] };
  return { success: true, gas: [comp, storage, rebate] as [bigint, bigint, bigint], changes: [[to, SUI, amount.toString()], [d.sender!, SUI, (-(amount + comp + storage - rebate)).toString()]] as [string, string, string][] };
}
const executed = (digest: string, t: FTx) => ({ digest: t.digest ?? digest, ...(t.checkpoint !== undefined ? { checkpoint: t.checkpoint } : {}), ...(t.time ? { timestamp: { seconds: BigInt(t.time), nanos: 0 } } : {}),
  ...(t.sender ? { transaction: { sender: t.sender } } : {}), effects: { status: { success: t.success, ...(t.success ? {} : { error: { description: t.error ?? 'MoveAbort', kind: 13 } }) } },
  balanceChanges: (t.changes ?? []).map(([address, coinType, amount]) => ({ address, coinType, amount })) });

const fake: GrpcCall = async (base, method, req) => {
  const f = h[base]!;
  if (!f || f.down) throw Object.assign(new Error('grpc: connect ECONNREFUSED'), { transport: true });
  const name = method.split('/').pop()!;
  f.seen.push(name);
  const one = (b: Uint8Array) => [b];
  switch (name) {
    case 'GetServiceInfo':
      return one(T.GetServiceInfoResponse.toBinary(T.GetServiceInfoResponse.create({ chainId: f.chainId, chain: f.chain, epoch: f.epoch, checkpointHeight: f.height, timestamp: { seconds: BigInt(f.time), nanos: 5 }, lowestAvailableCheckpoint: f.lowest, server: 'sui-node/test' })));
    case 'GetEpoch': {
      const r = T.GetEpochRequest.fromBinary(req), e = r.epoch ?? f.epoch, known = f.epochs[e.toString()];
      expect(r.readMask?.paths).toContain('reference_gas_price');
      if (!known) throw new GrpcError(5, `Epoch ${e} not found`);
      return one(T.GetEpochResponse.toBinary(T.GetEpochResponse.create({ epoch: { epoch: e, referenceGasPrice: f.gasPrice, firstCheckpoint: known.first, ...(known.last !== undefined ? { lastCheckpoint: known.last } : {}), start: { seconds: BigInt(known.start), nanos: 0 } } })));
    }
    case 'GetBalance': {
      const r = T.GetBalanceRequest.fromBinary(req);
      expect(r.coinType).toBe(SUI);
      const c = f.coins.filter((x) => (x.owner ?? ME) === r.owner).reduce((s, x) => s + x.balance, 0n), ab = r.owner === ME ? f.addressBalance : 0n;
      return one(T.GetBalanceResponse.toBinary(T.GetBalanceResponse.create({ balance: { coinType: SUI, balance: c + ab, addressBalance: ab, coinBalance: c } })));
    }
    case 'ListOwnedObjects': {
      const r = T.ListOwnedObjectsRequest.fromBinary(req);
      expect([r.objectType, r.readMask?.paths]).toEqual([COIN_T, ['object_id', 'version', 'digest', 'owner', 'object_type', 'balance']]);
      const mine = f.coins.filter((x) => (x.owner ?? ME) === r.owner), from = r.pageToken?.length ? Number(new TextDecoder().decode(r.pageToken)) : 0, size = r.pageSize ?? 50;
      return one(T.ListOwnedObjectsResponse.toBinary(T.ListOwnedObjectsResponse.create({
        objects: mine.slice(from, from + size).map((c) => ({ objectId: c.objectId, version: c.version, digest: c.digest, balance: c.balance, objectType: c.type ?? COIN_T, owner: { kind: 1, address: r.owner } })),
        ...(from + size < mine.length ? { nextPageToken: new TextEncoder().encode(String(from + size)) } : {}) })));
    }
    case 'GetObject': {
      const r = T.GetObjectRequest.fromBinary(req);
      if (!f.objects.has(r.objectId!) && !f.coins.some((c) => c.objectId === r.objectId)) throw new GrpcError(5, `Object ${r.objectId} not found`);
      return one(T.GetObjectResponse.toBinary(T.GetObjectResponse.create({ object: { objectId: r.objectId } })));
    }
    case 'GetTransaction': {
      const r = T.GetTransactionRequest.fromBinary(req), t = f.txs[r.digest!];
      expect(r.readMask?.paths).toEqual(['digest', 'checkpoint', 'effects.status']);
      if (!t) throw new GrpcError(5, `Transaction ${r.digest} not found`);
      return one(T.GetTransactionResponse.toBinary(T.GetTransactionResponse.create({ transaction: executed(r.digest!, t) })));
    }
    case 'SimulateTransaction': {
      const r = T.SimulateTransactionRequest.fromBinary(req), tx = r.transaction!.bcs!.value!;
      expect([r.checks, r.doGasSelection]).toEqual([T.SimulateTransactionRequest_TransactionChecks.ENABLED, false]);
      const s = (f.sim ?? ((b: Uint8Array) => defaultSim(f, b)))(tx), base = defaultSim(f, tx);
      const gas = s.gas ?? base.gas, changes = s.changes ?? base.changes;
      return one(T.SimulateTransactionResponse.toBinary(T.SimulateTransactionResponse.create({ transaction: { effects: { status: { success: s.success, ...(s.success ? {} : { error: { description: s.error, command: 0n, kind: 8 } }) },
        gasUsed: { computationCost: gas[0], storageCost: gas[1], storageRebate: gas[2], nonRefundableStorageFee: 99n }, epoch: f.epoch }, balanceChanges: changes.map(([address, coinType, amount]) => ({ address, coinType, amount })) } })));
    }
    case 'ExecuteTransaction': {
      const r = T.ExecuteTransactionRequest.fromBinary(req), tx = r.transaction!.bcs!.value!;
      expect(r.signatures).toHaveLength(1);
      f.executed.push({ tx, sig: r.signatures[0]!.bcs!.value! });
      return one(T.ExecuteTransactionResponse.toBinary(T.ExecuteTransactionResponse.create({ transaction: { digest: f.exec(suiTxDigest(tx)), effects: { status: { success: true } } } })));
    }
    case 'ListTransactions': {
      const q = T.ListTransactionsRequest.fromBinary(req), l = typeof f.list === 'function' ? f.list(q) : f.list;
      f.lists.push(q);
      if (!l) return [T.ListTransactionsResponse.toBinary(T.ListTransactionsResponse.create({ watermark: { checkpoint: f.height }, end: { reason: T.QueryEndReason.LEDGER_TIP } }))];
      if ('code' in l) throw new GrpcError(l.code, 'requested data below earliest available');
      return l.frames;
    }
    default: throw new GrpcError(12, 'unimplemented');
  }
};

let a: Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  a = (await import('../src/chains/sui.ts')).suiAdapter(n, fake);
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => { h = { [A]: fresh(), [B]: fresh() }; });
const both = (f: (x: Fake) => void) => { for (const u of [A, B]) f(h[u]!); };

const prep = (over: Partial<{ to: string; amount: bigint; memo: string; asset: string; from: string }> = {}) => a.prepare({ asset: 'native', from: ME, to: DEST, amount: 250_000_000n, ...over });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? `threw: ${(e as Error).message}`; } return 'ok'; };
const intentOf = (r: { section: Record<string, unknown>; maxFee: bigint; ttlSec: number }, amount = 250_000_000n, to = DEST): Intent => ({ v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'sui', chainRef: n.chainRef,
  asset: 'native', symbol: 'SUI', decimals: 9, amount: amount.toString(), from: ME, to, maxFee: r.maxFee.toString(), createdAt: NOW, expiresAt: NOW + r.ttlSec, policyVersion: 3, ...(r.section as { x: Record<string, string> }) });

describe('sui adapter: health and balances', () => {
  it('ok only when both sources are up, fresh and on the pinned chain', async () => {
    h[B]!.height = 5003n;
    expect(await a.health()).toMatchObject({ network: 'sui', ok: true, readable: true, identityVerified: true, height: 5003, endpoints: [{ url: new URL(A).host, ok: true }, { url: new URL(B).host, ok: true }] });
    h[B]!.chainId = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD'; // testnet
    expect(await a.health()).toMatchObject({ ok: false, readable: true, endpoints: [{ ok: true }, { ok: false }] });
    h[B] = { ...fresh(), chain: 'testnet' }; expect((await a.health()).ok).toBe(false);
    h[B] = { ...fresh(), time: NOW - 301 }; expect((await a.health()).ok).toBe(false);
    h[B] = fresh(); h[A]!.down = true; expect(await a.health()).toMatchObject({ ok: false, readable: true });
    h[B]!.down = true; expect(await a.health()).toMatchObject({ ok: false, readable: false, height: null });
  });
  it('reports everything the address owns, with failover', async () => {
    both((f) => { f.addressBalance = 7n; });
    expect(await a.balances(ME)).toEqual({ native: 4_000_000_007n });
    expect(await a.balances(DEST)).toEqual({ native: 0n });
    h[A]!.down = true;
    expect(await a.balances(ME)).toEqual({ native: 4_000_000_007n });
    h[B]!.down = true;
    await expect(a.balances(ME)).rejects.toThrow();
  });
});

describe('sui adapter: prepare', () => {
  it('agrees on both sources and returns the exact intent section', async () => {
    h[B]!.height = 5100n; h[B]!.lowest = 4990n; // some checkpoints apart, different retention: still fine
    const r = await prep();
    // largest coin first, budget = 2 × (computation + storage) = 2 × (100 000 + 1 976 000), expiration = current epoch
    expect(r.section).toEqual({ x: { payment: `${oid(1)}:100:${DIGEST}`, gasPrice: '100', gasBudget: '4152000', expiration: '1308' } });
    expect([r.maxFee, r.feeEstimate, r.ttlSec, r.warnings]).toEqual([4_152_000n, 1_097_880n, 120, []]);
    // the prepared section builds with the signer's plugin, and what was simulated last is exactly what will be signed
    const built = pluginFor(n).build(intentOf(r), n);
    expect(built.describe).toMatchObject({ amountMist: '250000000', gasBudgetMist: '4152000', gasCoins: '1', expirationEpoch: '1308' });
    for (const u of [A, B]) expect(h[u]!.seen.filter((m) => m === 'SimulateTransaction')).toHaveLength(2);
    for (const u of [A, B]) expect(h[u]!.seen[0]).toBe('GetServiceInfo'); // identity before anything else
  });
  it('simulates the exact bytes the signer will sign', async () => {
    const sims: string[] = [];
    both((f) => { f.sim = (tx) => { sims.push(Buffer.from(tx).toString('hex')); return defaultSim(f, tx); }; });
    const r = await prep();
    const signed = pluginFor(n).sign(intentOf(r), n, keys.handle(n));
    const txHex = Buffer.from(signed.raw.split(':')[0]!, 'base64').toString('hex');
    expect(sims).toHaveLength(4);
    expect(sims.slice(2)).toEqual([txHex, txHex]);
  });
  it('selects coins deterministically: largest first, only as many as needed, listed by id', async () => {
    both((f) => { f.coins = [coin(5, 100_000_000n), coin(3, 900_000_000n), coin(9, 900_000_000n), coin(7, 50_000_000n), coin(4, 0n)]; });
    expect(suiParsePayment(((await prep({ amount: 500_000_000n })).section as any).x.payment).map((p) => p.objectId)).toEqual([oid(3)]);
    const r = await prep({ amount: 1_790_000_000n }); // 900 + 900 + 100 needed for amount + probe budget
    expect(suiParsePayment((r.section as any).x.payment).map((p) => p.objectId)).toEqual([oid(3), oid(5), oid(9)]);
    expect(() => pluginFor(n).build(intentOf(r, 1_790_000_000n), n)).not.toThrow();
    h[B]!.coins.reverse(); // listing order does not matter
    expect((await prep({ amount: 1_790_000_000n })).section).toEqual(r.section);
  });
  it('reads every page of the coin list', async () => {
    both((f) => { f.coins = Array.from({ length: 450 }, (_v, k) => coin(k + 1, BigInt(1_000_000 + k))); });
    const r = await prep({ amount: 1_000_000n });
    expect(suiParsePayment((r.section as any).x.payment).map((p) => p.objectId).sort()).toEqual(Array.from({ length: 21 }, (_v, k) => oid(450 - k)).sort()); // 21 coins of about 0.001 SUI cover amount + first budget
    expect(h[A]!.seen.filter((m) => m === 'ListOwnedObjects')).toHaveLength(3);
    both((f) => { f.coins = Array.from({ length: 1001 }, (_v, k) => coin(k + 1, 1_000_000_000n)); });
    expect(await code(prep())).toBe('rpc_degraded'); // more coins than this adapter reads: refused, never a partial view
  });
  it('a tight balance gets the budget that is left, never more than the coins hold', async () => {
    both((f) => { f.coins = [coin(1, 250_000_000n + 3_000_000n)]; });
    const r = await prep();
    expect(r.maxFee).toBe(3_000_000n);
    expect(h[A]!.seen.filter((m) => m === 'SimulateTransaction')).toHaveLength(1); // the first simulation already ran the final bytes
    both((f) => { f.coins = [coin(1, 250_000_000n + 2_075_999n)]; });
    expect(await code(prep())).toBe('insufficient_funds'); // budget below computation + storage
    both((f) => { f.coins = [coin(1, 250_000_000n + 199_999n)]; });
    expect(await code(prep())).toBe('insufficient_funds');
  });
  it('fails closed when a source is down, lies about identity, is stale or disagrees', async () => {
    h[B]!.down = true; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), chainId: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' }; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), chain: 'testnet' }; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = fresh(); h[B]!.coins[0]!.version = 101n; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.coins[0]!.digest = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S'; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.coins[1]!.balance += 1n; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.coins.pop(); expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.addressBalance = 1n; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.gasPrice = 101n; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.epoch = 1309n; h[B]!.epochs[1309] = { first: 5000n, start: NOW - 5 }; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.height = 5241n; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.time = NOW - 61; expect(await code(prep())).toBe('rpc_degraded'); // stale source or wrong local clock
    h[B] = fresh(); h[B]!.coins[0]!.owner = DEST; h[B]!.coins[1]!.type = `0x${'0'.repeat(63)}2::coin::Coin<0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC>`;
    expect(await code(prep())).toBe('rpc_degraded'); // a coin list holding something that is not this wallet's SUI
    h[B] = fresh(); h[B]!.gasPrice = 0n; h[A]!.gasPrice = 0n; expect(await code(prep())).toBe('rpc_degraded');
    h[A] = fresh(); h[B] = fresh(); expect(await code(prep())).toBe('ok');
  });
  it('checks that coins cover amount plus budget, and names funds it cannot spend', async () => {
    expect(await code(prep({ amount: 3_997_924_000n }))).toBe('ok'); // 4 SUI in coins - (computation 100 000 + storage 1 976 000)
    expect(await code(prep({ amount: 3_997_924_001n }))).toBe('insufficient_funds');
    expect(await code(prep({ amount: 3_999_800_001n }))).toBe('insufficient_funds'); // not even the smallest budget
    both((f) => { f.coins = []; });
    expect(await code(prep())).toBe('insufficient_funds');
    both((f) => { f.addressBalance = 9_000_000_000n; });
    await expect(prep()).rejects.toMatchObject({ code: 'unsupported_funds', message: expect.stringMatching(/9 is held as an address balance/) });
    both((f) => { f.addressBalance = 0n; f.coins = Array.from({ length: 40 }, (_v, k) => coin(k + 1, 10_000_000n)); });
    expect(await code(prep({ amount: 300_000_000n }))).toBe('ok'); // 32 coins hold 320 000 000
    expect(await code(prep({ amount: 320_000_000n }))).toBe('too_many_coins');
  });
  it('refuses object ids, reserved addresses, memos, tokens and bad input', async () => {
    both((f) => { f.objects.add(DEST); });
    expect(await code(prep())).toBe('bad_address');
    h[B]!.objects.clear();
    expect(await code(prep())).toBe('rpc_disagreement');
    h[A]!.objects.clear();
    expect(await code(prep({ to: oid(2) }))).toBe('bad_address'); // one of the wallet's own coins
    expect(await code(prep({ to: '0x' + '0'.repeat(63) + '5' }))).toBe('bad_address');
    expect(await code(prep({ to: ME }))).toBe('bad_address');
    expect(await code(prep({ to: '0x' + DEST.slice(2).toUpperCase() }))).toBe('bad_address');
    expect(await code(prep({ to: '0x2' }))).toBe('bad_address');
    expect(await code(prep({ memo: '12345' }))).toBe('bad_memo');
    expect(await code(prep({ asset: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC' }))).toBe('unsupported_asset');
    expect(await code(prep({ amount: 0n }))).toBe('bad_amount');
  });
  it('requires a successful, identical simulation whose effects are exactly the requested payment', async () => {
    both((f) => { f.sim = () => ({ success: false, error: 'MoveAbort in command 1' }); });
    await expect(prep()).rejects.toMatchObject({ code: 'simulation_failed', message: expect.stringMatching(/MoveAbort/) });
    both((f) => { f.sim = null; });
    h[B]!.sim = (tx) => ({ ...defaultSim(h[B]!, tx), gas: [100_000n, 1_976_001n, 978_120n] }); expect(await code(prep())).toBe('rpc_disagreement');
    h[B]!.sim = () => ({ success: false, error: 'InsufficientGas' }); expect(await code(prep())).toBe('rpc_disagreement');
    h[B]!.sim = () => { throw Object.assign(new Error('grpc: timeout'), { transport: true }); }; expect(await code(prep())).toBe('rpc_degraded');
    h[B]!.sim = () => { throw new GrpcError(3, 'object is locked by another transaction'); }; expect(await code(prep())).toBe('rpc_degraded');
    h[A]!.sim = h[B]!.sim;
    await expect(prep()).rejects.toMatchObject({ code: 'simulation_failed', message: expect.stringMatching(/locked/) });
    // both nodes agree, but the effects are not this payment
    const tamper = (g: (c: [string, string, string][]) => [string, string, string][]) => both((f) => { f.sim = (tx) => { const s = defaultSim(f, tx); return { ...s, changes: g(s.changes) }; }; });
    tamper((c) => [[c[0]![0], c[0]![1], '249999999'], c[1]!]); expect(await code(prep())).toBe('simulation_failed');
    tamper((c) => [[ME, SUI, c[0]![2]], c[1]!]); expect(await code(prep())).toBe('simulation_failed');
    tamper((c) => [...c, [oid(77), SUI, '1']]); expect(await code(prep())).toBe('simulation_failed');
    tamper((c) => [c[0]!, [c[1]![0], c[1]![1], (BigInt(c[1]![2]) - 1n).toString()]]); expect(await code(prep())).toBe('simulation_failed');
    tamper((c) => [c[0]!, c[1]!, [ME, `0x${'0'.repeat(63)}2::other::COIN`, '-5']]); expect(await code(prep())).toBe('simulation_failed');
    tamper((c) => c); expect(await code(prep())).toBe('ok');
    // a stale object reference is refused by the nodes themselves
    both((f) => { f.sim = (tx) => { f.coins[0]!.version = 999n; return defaultSim(f, tx); }; });
    expect(await code(prep())).toBe('simulation_failed');
  });
});

describe('sui adapter: broadcast', () => {
  const x = { payment: suiFormatPayment([{ objectId: oid(1), version: 100n, digest: DIGEST }]), gasPrice: '100', gasBudget: '4152000', expiration: '1308' };
  const intent: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'sui', chainRef: n.chainRef, asset: 'native', symbol: 'SUI', decimals: 9, amount: '250000000',
    from: ME, to: DEST, maxFee: '4152000', createdAt: NOW, expiresAt: NOW + 120, policyVersion: 3, x };
  const signed = pluginFor(n).sign(intent, n, keys.handle(n));
  it('sends the exact bytes and signature to every source', async () => {
    await a.broadcast(signed.raw);
    for (const u of [A, B]) {
      expect(h[u]!.executed).toHaveLength(1);
      const { tx, sig } = h[u]!.executed[0]!;
      expect(`${Buffer.from(tx).toString('base64')}:${Buffer.from(sig).toString('base64')}`).toBe(signed.raw);
      expect((await verifyTransactionSignature(tx, Buffer.from(sig).toString('base64'), { address: ME })).toSuiAddress()).toBe(ME);
    }
    h[A]!.down = true;
    await a.broadcast(signed.raw); // one source is enough
  });
  it('a refusal is an error unless the ledger already contains the transaction', async () => {
    both((f) => { f.exec = () => { throw new GrpcError(3, 'transaction input objects are not available'); }; });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/not available/);
    h[B]!.txs[signed.txid] = { success: true, checkpoint: 4999n };
    await a.broadcast(signed.raw); // already executed
    both((f) => { f.txs = {}; f.exec = () => 'D5PWuxMQiHxxTp77DehNKAn4mNsUw8ifDwA7Efd5GVVg'; });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/another transaction/);
    await expect(a.broadcast('AAAA')).rejects.toThrow(/not a Sui signed transaction/);
    both((f) => { f.down = true; });
    await expect(a.broadcast(signed.raw)).rejects.toThrow();
  });
});

describe('sui adapter: track', () => {
  const txid = 'AbZJknbapHe7gJPNt6gSWXA9DrGTwAQz9qV4sPNUEi9w';
  const track = (expiration = '1308', createdAt = NOW - 60) => a.track({ txid, intent: { createdAt, x: { expiration } }, blockRef: null, broadcastAt: NOW });
  it('a hash alone is never success; executed is not final until it is in a checkpoint', async () => {
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true });
    h[A]!.txs[txid] = { success: true };
    expect(await track()).toEqual({ state: 'confirming', confirmations: 0 });
    h[A]!.txs[txid] = { success: true, checkpoint: 4999n };
    expect(await track()).toEqual({ state: 'confirming', confirmations: 1, blockRef: '4999' }); // the other source keeps that checkpoint but does not show it yet
    h[B]!.txs[txid] = { success: true };
    expect(await track()).toEqual({ state: 'confirming', confirmations: 0 });
    h[B]!.txs[txid] = { success: true, checkpoint: 4999n };
    expect(await track()).toEqual({ state: 'finalized', confirmations: 2, blockRef: '4999' });
    // every source reads its position before looking the transaction up
    for (const u of [A, B]) expect(h[u]!.seen.slice(-2)).toEqual(['GetServiceInfo', 'GetTransaction']);
  });
  it('a source that already pruned the checkpoint cannot veto; a down source does not block a success', async () => {
    h[A]!.txs[txid] = { success: true, checkpoint: 4999n };
    h[B]!.lowest = 5000n;
    expect(await track()).toEqual({ state: 'finalized', confirmations: 2, blockRef: '4999' });
    h[B]!.lowest = 4999n;
    expect((await track()).state).toBe('confirming');
    h[B]!.down = true;
    expect((await track()).state).toBe('finalized');
  });
  it('sources that disagree are an error, never a verdict', async () => {
    h[A]!.txs[txid] = { success: true, checkpoint: 4999n }; h[B]!.txs[txid] = { success: true, checkpoint: 4998n };
    await expect(track()).rejects.toThrow(/disagree/);
    h[B]!.txs[txid] = { success: false, checkpoint: 4999n };
    await expect(track()).rejects.toThrow(/disagree/);
    h[B]!.txs[txid] = { success: true, checkpoint: 4999n, digest: DIGEST };
    expect((await track()).state).toBe('finalized'); // a record for another digest is a failed lookup on that source, not a miss
    h[A]!.txs[txid] = { success: true, checkpoint: 4999n, digest: DIGEST };
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: false });
  });
  it('an on-chain failure is reported only when every source is reachable', async () => {
    both((f) => { f.txs[txid] = { success: false, checkpoint: 4999n, error: 'InsufficientCoinBalance in command 0' }; });
    expect(await track()).toMatchObject({ state: 'failed', blockRef: '4999', error: expect.stringMatching(/InsufficientCoinBalance.*no funds moved/) });
    h[B]!.down = true;
    expect((await track()).state).toBe('confirming');
  });
  it('expiry: failed only when every source is past the epoch and history proves it was never executed', async () => {
    const next = (f: Fake) => { f.epoch = 1309n; f.height = 5100n; f.epochs[1308] = { first: 4000n, last: 5050n, start: NOW - 3600 }; f.epochs[1309] = { first: 5051n, start: NOW }; };
    next(h[A]!);
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: false }); // one source still in the expiration epoch
    next(h[B]!);
    expect(await track()).toEqual({ state: 'failed', confirmations: 0, error: 'not executed before its expiration epoch ended; no funds moved' });
    both((f) => { f.height = 5089n; });
    expect((await track()).state).toBe('broadcast'); // not far enough past the last checkpoint of the epoch
    both((f) => { f.height = 5100n; f.lowest = 4001n; });
    expect((await track()).state).toBe('broadcast'); // no source keeps the whole epoch: a miss proves nothing
    h[A]!.lowest = 4000n;
    expect((await track()).state).toBe('failed'); // one source with complete history is enough, as long as none shows the transaction
    expect((await track('1308', NOW - 3601)).state).toBe('broadcast'); // created before the epoch began: an earlier execution is not covered
    h[B]!.down = true;
    expect((await track()).state).toBe('broadcast'); // never "failed" on a single source
    h[B] = fresh(); next(h[B]!); h[B]!.txs[txid] = { success: true, checkpoint: 5049n };
    expect((await track()).state).toBe('confirming'); // executed after all
    both((f) => { delete f.txs[txid]; delete f.epochs[1308]!.last; });
    expect((await track()).state).toBe('broadcast'); // epoch not closed according to the sources
    await expect(a.track({ txid, intent: { evm: {} }, blockRef: null, broadcastAt: NOW })).rejects.toThrow(/expiration epoch/);
  });
});

describe('sui adapter: deposits', () => {
  const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  const frame = (digest: string, t: FTx, watermark?: bigint, end?: number) => T.ListTransactionsResponse.toBinary(T.ListTransactionsResponse.create({ transaction: executed(digest, t),
    ...(watermark !== undefined ? { watermark: { checkpoint: watermark } } : {}), ...(end !== undefined ? { end: { reason: end } } : {}) }));
  const rows = (): Uint8Array[] => [
    frame('d1', { success: true, checkpoint: 4100n, time: NOW - 900, sender: DEST, changes: [[ME, SUI, '700'], [DEST, SUI, '-900']] }, 4099n),
    frame('d2', { success: true, checkpoint: 4200n, time: NOW - 800, sender: ME, changes: [[ME, SUI, '-5000'], [DEST, SUI, '4000']] }, 4199n), // sent by the wallet
    frame('d3', { success: false, checkpoint: 4300n, time: NOW - 700, sender: DEST, changes: [[ME, SUI, '1']] }, 4299n), // failed execution
    frame('d4', { success: true, checkpoint: 4400n, time: NOW - 600, sender: DEST, changes: [[ME, USDC, '5000000'], [ME, SUI, '-3']] }, 4399n), // a token, SUI going down
    frame('d5', { success: true, checkpoint: 4500n, time: NOW - 500, sender: oid(9), changes: [[ME, SUI, '40'], [ME, SUI, '2'], [oid(9), SUI, '-99']] }, 4499n),
    frame('d6', { success: true, time: NOW - 400, sender: DEST, changes: [[ME, SUI, '8']] }), // not in a checkpoint
  ];
  it('first scan lists the newest transfers received and starts the cursor near the tip', async () => {
    both((f) => { f.list = { frames: rows().reverse() }; });
    const d = await a.deposits(ME, null);
    expect(d.items).toEqual([
      { txid: 'd5', idx: 0, asset: 'native', amount: 42n, from: oid(9), block: 4500, time: NOW - 500 },
      { txid: 'd1', idx: 0, asset: 'native', amount: 700n, from: DEST, block: 4100, time: NOW - 900 },
    ]);
    expect([d.cursor, d.finalizedHeight]).toEqual([4998, 5000]);
    const q = h[A]!.lists[0];
    expect(q.filter.terms[0].literals[0].predicate).toEqual({ oneofKind: 'affectedAddress', affectedAddress: { address: ME } });
    expect([q.startCheckpoint, q.options.limit, q.options.ordering]).toEqual([undefined, 50, T.Ordering.DESCENDING]);
    expect(h[B]!.lists).toHaveLength(0); // display read: first source that answers
  });
  it('incremental scan starts after the cursor and resumes where a cut-short listing stopped', async () => {
    both((f) => { f.list = { frames: rows() }; });
    let d = await a.deposits(ME, 4050);
    expect(d.items.map((x) => x.txid)).toEqual(['d1', 'd5']);
    expect(d.cursor).toBe(4998);
    const q = h[A]!.lists[0];
    expect([q.startCheckpoint, q.options.limit, q.options.ordering]).toEqual([4051n, 200, T.Ordering.ASCENDING]);
    both((f) => { f.list = { frames: [...rows().slice(0, 3), T.ListTransactionsResponse.toBinary(T.ListTransactionsResponse.create({ watermark: { checkpoint: 4310n }, end: { reason: T.QueryEndReason.ITEM_LIMIT } }))] }; });
    d = await a.deposits(ME, 4050);
    expect([d.items.map((x) => x.txid), d.cursor]).toEqual([['d1'], 4309]);
    both((f) => { f.list = { frames: [frame('d1', { success: true, checkpoint: 4100n, sender: DEST, changes: [[ME, SUI, '700']] }, undefined, T.QueryEndReason.SCAN_LIMIT)] }; });
    d = await a.deposits(ME, 4050);
    expect([d.items.length, d.cursor]).toEqual([1, 4098]); // no watermark: resume just before the last item
    both((f) => { f.list = null; });
    expect(await a.deposits(ME, 4997)).toEqual({ items: [], cursor: 4998, finalizedHeight: 5000 });
    expect((await a.deposits(ME, 4999)).cursor).toBe(4999); // the cursor never moves back
  });
  it('fails over, and skips ahead only when no source holds the history any more', async () => {
    h[A]!.down = true; h[B]!.list = { frames: rows() };
    expect((await a.deposits(ME, 4050)).items).toHaveLength(2);
    h[A] = fresh(); h[A]!.list = { code: 11 }; // pruned on the first source, available on the second
    expect((await a.deposits(ME, 4050)).items).toHaveLength(2);
    h[B]!.down = true;
    await expect(a.deposits(ME, 4050)).rejects.toThrow(); // one pruned, one down: wait for the second rather than skip
    h[B] = fresh(); h[B]!.list = { code: 11 }; h[A]!.lowest = 4600n;
    h[A]!.list = (q) => (q.startCheckpoint <= 4600n ? { code: 11 } : null);
    const d = await a.deposits(ME, 4050);
    expect(d).toEqual({ items: [], cursor: 4998, finalizedHeight: 5000 });
    expect(h[A]!.lists.map((q) => q.startCheckpoint).slice(-2)).toEqual([4051n, 4601n]);
  });
});

describe('sui-grpc: protobuf layouts against the official generated types', () => {
  const pairs: [string, any, Record<string, unknown>][] = [
    ['GetEpochRequest', T.GetEpochRequest, { epoch: 1308n, readMask: { paths: ['epoch', 'reference_gas_price'] } }],
    ['GetBalanceRequest', T.GetBalanceRequest, { owner: ME, coinType: SUI }],
    ['ListOwnedObjectsRequest', T.ListOwnedObjectsRequest, { owner: ME, pageSize: 200, pageToken: Uint8Array.of(1, 2, 255), readMask: { paths: ['object_id'] }, objectType: COIN_T }],
    ['GetObjectRequest', T.GetObjectRequest, { objectId: DEST, readMask: { paths: ['object_id'] } }],
    ['GetTransactionRequest', T.GetTransactionRequest, { digest: DIGEST, readMask: { paths: ['digest', 'checkpoint'] } }],
    ['SimulateTransactionRequest', T.SimulateTransactionRequest, { transaction: { bcs: { value: Uint8Array.of(0, 1, 2, 3) } }, readMask: { paths: ['transaction.effects.status'] }, checks: 0, doGasSelection: false }],
    ['ExecuteTransactionRequest', T.ExecuteTransactionRequest, { transaction: { bcs: { value: Uint8Array.of(9, 8) } }, signatures: [{ bcs: { value: new Uint8Array(97) } }], readMask: { paths: ['digest'] } }],
    ['ListTransactionsRequest', T.ListTransactionsRequest, { readMask: { paths: ['digest'] }, startCheckpoint: (1n << 64n) - 1n, options: { limit: 200, ordering: 1 } }],
  ];
  const norm = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
  for (const [name, type, value] of pairs) it(`${name}: our bytes are the generated encoder's bytes`, () => {
    const ours = encode((M as any)[name], value);
    expect(Buffer.from(ours).toString('hex')).toBe(Buffer.from(type.toBinary(type.create(value))).toString('hex'));
    expect(norm(decode((M as any)[name], ours))).toBe(norm(value));
  });
  it('the transaction filter is the affected-address predicate', () => {
    const ours = encode(M.ListTransactionsRequest, { filter: { terms: [{ literals: [{ affectedAddress: { address: ME } }] }] } });
    expect(T.ListTransactionsRequest.fromBinary(ours).filter).toEqual({ terms: [{ literals: [{ negated: false, predicate: { oneofKind: 'affectedAddress', affectedAddress: { address: ME } } }] }] });
  });
  it('decodes full answers of the generated encoder, skipping every field it does not use', () => {
    const tx = T.ExecutedTransaction.create({ digest: DIGEST, checkpoint: 123n, timestamp: { seconds: 1_794_356_537n, nanos: 122_000_000 }, transaction: { sender: ME, digest: DIGEST, version: 1, gasPayment: { owner: ME, price: 100n, budget: 5n, objects: [] } },
      signatures: [{ bcs: { value: new Uint8Array(97) }, scheme: 0 }], balanceChanges: [{ address: ME, coinType: SUI, amount: '-251088099' }, { address: DEST, coinType: SUI, amount: '250000000' }],
      effects: { digest: DIGEST, version: 2, epoch: 1308n, status: { success: false, error: { description: 'InsufficientCoinBalance in command 0', command: 0n, kind: 8 } }, dependencies: [DIGEST],
        gasUsed: { computationCost: 100_000n, storageCost: 1_976_000n, storageRebate: 987_901n, nonRefundableStorageFee: 99n }, lamportVersion: 77n } });
    expect(decode(M.GetTransactionResponse, T.GetTransactionResponse.toBinary({ transaction: tx }))).toEqual({ transaction: {
      digest: DIGEST, checkpoint: 123n, timestamp: { seconds: 1_794_356_537n, nanos: 122_000_000 }, transaction: { sender: ME },
      balanceChanges: [{ address: ME, coinType: SUI, amount: '-251088099' }, { address: DEST, coinType: SUI, amount: '250000000' }],
      effects: { epoch: 1308n, status: { success: false, error: { description: 'InsufficientCoinBalance in command 0', command: 0n, kind: 8 } }, gasUsed: { computationCost: 100_000n, storageCost: 1_976_000n, storageRebate: 987_901n, nonRefundableStorageFee: 99n } } } });
    expect(decode(M.GetServiceInfoResponse, T.GetServiceInfoResponse.toBinary(T.GetServiceInfoResponse.create({ chainId: n.chainRef, chain: 'mainnet', epoch: 1308n, checkpointHeight: 343_891_027n, timestamp: { seconds: 5n, nanos: 0 }, lowestAvailableCheckpoint: 0n, lowestAvailableCheckpointObjects: 9n, server: 'x' }))))
      .toEqual({ chainId: n.chainRef, chain: 'mainnet', epoch: 1308n, checkpointHeight: 343_891_027n, timestamp: { seconds: 5n }, lowestAvailableCheckpoint: 0n }); // proto3 omits a zero `nanos`
    expect(decode(M.GetBalanceResponse, T.GetBalanceResponse.toBinary({ balance: { coinType: SUI, balance: (1n << 64n) - 1n, addressBalance: 4n, coinBalance: 5n } }))).toEqual({ balance: { coinType: SUI, balance: (1n << 64n) - 1n, addressBalance: 4n, coinBalance: 5n } });
    expect(decode(M.ListOwnedObjectsResponse, T.ListOwnedObjectsResponse.toBinary(T.ListOwnedObjectsResponse.create({ objects: [{ objectId: oid(1), version: 7n, digest: DIGEST, balance: 9n, objectType: COIN_T, owner: { kind: 1, address: ME }, hasPublicTransfer: true, storageRebate: 5n, previousTransaction: DIGEST }], nextPageToken: Uint8Array.of(7) }))))
      .toEqual({ objects: [{ objectId: oid(1), version: 7n, digest: DIGEST, balance: 9n, objectType: COIN_T, owner: { kind: 1, address: ME } }], nextPageToken: Uint8Array.of(7) });
    expect(decode(M.GetEpochResponse, T.GetEpochResponse.toBinary(T.GetEpochResponse.create({ epoch: { epoch: 1307n, firstCheckpoint: 1n, lastCheckpoint: 2n, start: { seconds: 3n, nanos: 4 }, end: { seconds: 5n, nanos: 6 }, referenceGasPrice: 100n, protocolConfig: { protocolVersion: 99n } } }))))
      .toEqual({ epoch: { epoch: 1307n, firstCheckpoint: 1n, lastCheckpoint: 2n, start: { seconds: 3n, nanos: 4 }, end: { seconds: 5n, nanos: 6 }, referenceGasPrice: 100n } });
    expect(decode(M.ListTransactionsResponse, T.ListTransactionsResponse.toBinary(T.ListTransactionsResponse.create({ watermark: { cursor: Uint8Array.of(1), checkpoint: 8n }, end: { reason: 5 } })))).toEqual({ watermark: { cursor: Uint8Array.of(1), checkpoint: 8n }, end: { reason: 5 } });
  });
  it('property: scalar round trip with the generated types', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), fc.string({ unit: 'grapheme' }), fc.integer({ min: 0, max: 5 }), (bal, cp, s, kind) => {
      const obj = { objects: [{ objectId: s, version: cp, balance: bal, owner: { kind, address: s } }] };
      const viaSdk = T.ListOwnedObjectsResponse.fromBinary(encode(M.ListOwnedObjectsResponse, obj)).objects[0]!;
      const back = decode<any>(M.ListOwnedObjectsResponse, T.ListOwnedObjectsResponse.toBinary(T.ListOwnedObjectsResponse.create(obj))).objects[0];
      return viaSdk.objectId === s && viaSdk.version === cp && viaSdk.balance === bal && viaSdk.owner?.kind === kind && back.objectId === s && back.version === cp && back.balance === bal && back.owner.kind === kind && back.owner.address === s;
    }));
  });
  it('refuses malformed input instead of guessing', () => {
    expect(() => decode(M.GetBalanceResponse, Uint8Array.of(0x0a, 0x05, 0x01))).toThrow(/truncated/);
    expect(() => decode(M.GetServiceInfoResponse, Uint8Array.of(0x18))).toThrow(/varint/);
    expect(() => decode(M.GetServiceInfoResponse, Uint8Array.of(0x1a, 0x01, 0x00))).toThrow(/wire type/); // epoch sent as bytes
    expect(() => decode(M.GetServiceInfoResponse, Uint8Array.of(0x08, 0x01))).toThrow(/wire type/); // chain_id sent as a number
    expect(() => decode(M.GetServiceInfoResponse, Uint8Array.of(0x0a, 0x02, 0xff, 0xfe))).toThrow(); // invalid UTF-8
    expect(() => decode(M.GetServiceInfoResponse, Uint8Array.of(0x0b))).toThrow(/wire type/); // groups
    expect(() => encode(M.GetBalanceRequest, { owner: ME, coin: SUI })).toThrow(/unknown field/);
    expect(() => encode(M.ListOwnedObjectsRequest, { pageSize: 2 ** 32 })).toThrow(/range/);
    expect(decode(M.GetServiceInfoResponse, new Uint8Array(0))).toEqual({});
  });
});

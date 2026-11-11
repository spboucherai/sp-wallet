// Aptos adapter against two scripted REST nodes (no network): agreement rules, simulation of the exact transaction, fail-closed
// paths, tracking, broadcast and deposits. The scripted nodes decode the simulated transaction with the official SDK.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deserializer, RawTransaction, type TransactionPayloadEntryFunction } from '@aptos-labs/ts-sdk';
import { aptosAptStore, aptosRawBytes, aptosTxid, buildAptosTx, NETWORKS, pluginFor, toHex, type Intent } from '@spw/core';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.aptos, [A, B] = n.rpc.map((u) => new URL(u).origin) as [string, string], ARCH = 'https://archive.mainnet.aptoslabs.com';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ME = keys.addresses.aptos!, DEST = '0x' + '5a'.repeat(32), NEW = '0x' + '6b'.repeat(32), LOWZ = '0x0' + '7c'.repeat(31) + '7';
const NOW = 1_800_000_000, GENESIS = '0xf650d76ea0a3176f0412b7e6bea5eb6fbf1d7adb0c39ab18e378adefb9247309';
/** the REST API prints addresses without leading zeros */
const short = (a: string) => '0x' + (a.slice(2).replace(/^0+/, '') || '0');

interface Sim { success: boolean; vm_status: string; gas_used: string; events?: any[]; patch?: Record<string, unknown> }
interface Fake {
  down: boolean; chainId: number; onChainId: number; version: number; height: number; epoch: number; timeSec: number; blockHash: string; genesis: string; gas: number;
  accounts: Record<string, { sequence_number: string; authentication_key: string }>; balances: Record<string, string>; hasStore: Set<string>;
  sim: (f: { sender: string; to: string; amount: bigint; maxGas: bigint }) => Sim; sims: string[]; versions: string[];
  txs: Record<string, any>; byVersion: Record<number, any>; pruned: Set<number>; submit: (hex: string) => { status: number; body: any }; posts: string[]; seen: string[];
  index: { last: number; rows: number[]; fail?: boolean; queries: string[] };
}
const fresh = (): Fake => ({
  down: false, chainId: 1, onChainId: 1, version: 8_000_000_500, height: 1_176_000_000, epoch: 17_960, timeSec: NOW - 1, blockHash: '0x' + 'b1'.repeat(32), genesis: GENESIS, gas: 100,
  accounts: { [ME]: { sequence_number: '7', authentication_key: ME } }, balances: { [ME]: '500000000' }, hasStore: new Set([DEST, LOWZ]),
  sim: () => ({ success: true, vm_status: 'Executed successfully', gas_used: '' }), sims: [], versions: [],
  txs: {}, byVersion: {}, pruned: new Set(), submit: () => ({ status: 202, body: {} }), posts: [], seen: [],
  index: { last: 8_000_000_400, rows: [], queries: [] },
});
let h: Record<string, Fake>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input)), f = h[url.origin];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (status: number, error_code: string) => json(status, { message: error_code, error_code, vm_error_code: null });
  if (!f || f.down) throw new TypeError('fetch failed');
  const p = url.pathname.replace(/^\/v1/, '') || '/';
  f.seen.push(p);
  const lv = url.searchParams.get('ledger_version');
  if (lv !== null) f.versions.push(lv);
  if (init?.method === 'POST') {
    if (p === '/graphql') {
      const q = JSON.parse(String(init.body)).query as string;
      f.index.queries.push(q);
      if (f.index.fail) return json(200, { errors: [{ message: 'rate limit' }] });
      const gt = Number(/transaction_version:\{_gt:(\d+)\}/.exec(q)?.[1] ?? -1), limit = Number(/limit:(\d+)/.exec(q)![1]), desc = /transaction_version:desc/.test(q);
      const rows = f.index.rows.filter((v) => v > gt).sort((x, y) => (desc ? y - x : x - y)).slice(0, limit);
      return json(200, { data: { processor_status: [{ last_success_version: f.index.last }], fungible_asset_activities: rows.map((v) => ({ transaction_version: v })) } });
    }
    if (p === '/view') { const b = JSON.parse(String(init.body)); return json(200, [f.balances[b.arguments[0]] ?? '0']); }
    const body = new Uint8Array(init.body as Uint8Array), hex = toHex(body);
    if (p === '/transactions') { f.posts.push('0x' + hex); const r = f.submit('0x' + hex); return json(r.status, r.body); }
    if (p === '/transactions/simulate') {
      f.sims.push(hex);
      const d = new Deserializer(body), tx = RawTransaction.deserialize(d);
      if (toHex(d.deserializeFixedBytes(d.remaining())) !== '0404') return err(400, 'invalid_input'); // only the keyless simulation authenticator
      const ef = (tx.payload as TransactionPayloadEntryFunction).entryFunction, sender = tx.sender.toStringLong();
      const to = '0x' + toHex(ef.args[0]!.bcsToBytes()), amount = Buffer.from(ef.args[1]!.bcsToBytes()).readBigUInt64LE();
      const s = f.sim({ sender, to, amount, maxGas: tx.max_gas_amount });
      const events = s.events ?? [
        { type: '0x1::fungible_asset::Withdraw', data: { amount: amount.toString(), store: short(aptosAptStore(sender)) } },
        { type: '0x1::fungible_asset::Deposit', data: { amount: amount.toString(), store: short(aptosAptStore(to)) } },
        { type: '0x1::transaction_fee::FeeStatement', data: { total_charge_gas_units: '0' } },
      ];
      return json(200, [{ type: 'user_transaction', hash: aptosTxid(body), success: s.success, vm_status: s.vm_status, gas_used: s.gas_used || (f.hasStore.has(to) ? '62' : '5414'), sender: short(sender),
        sequence_number: tx.sequence_number.toString(), max_gas_amount: tx.max_gas_amount.toString(), gas_unit_price: tx.gas_unit_price.toString(), expiration_timestamp_secs: tx.expiration_timestamp_secs.toString(),
        payload: { type: 'entry_function_payload', function: `${ef.module_name.address.toString()}::${ef.module_name.name.identifier}::${ef.function_name.identifier}`, type_arguments: [], arguments: [short(to), amount.toString()] },
        events: s.success ? events : [], ...s.patch }]);
    }
    return json(500, {});
  }
  if (p === '/') return json(200, { chain_id: f.chainId, epoch: String(f.epoch), ledger_version: String(f.version), ledger_timestamp: String(f.timeSec * 1_000_000 + 123), block_height: String(f.height), node_role: 'full_node' });
  if (p === '/estimate_gas_price') return json(200, { gas_estimate: f.gas, deprioritized_gas_estimate: 100, prioritized_gas_estimate: 150 });
  if (p === '/accounts/0x1/resource/0x1::chain_id::ChainId') return json(200, { type: '0x1::chain_id::ChainId', data: { id: f.onChainId } });
  let m = /^\/accounts\/(0x[0-9a-f]{64})$/.exec(p);
  if (m) return json(200, f.accounts[m[1]!] ?? { sequence_number: '0', authentication_key: m[1] });
  m = /^\/transactions\/by_hash\/(0x[0-9a-f]{64})$/.exec(p);
  if (m) return f.txs[m[1]!] ? json(200, f.txs[m[1]!]) : err(404, 'transaction_not_found');
  m = /^\/transactions\/by_version\/(\d+)$/.exec(p);
  if (m) { const v = Number(m[1]); return f.pruned.has(v) ? err(410, 'version_pruned') : v === 0 ? json(200, { version: '0', hash: f.genesis, type: 'genesis_transaction' }) : f.byVersion[v] ? json(200, f.byVersion[v]) : err(404, 'transaction_not_found'); }
  m = /^\/blocks\/by_height\/(\d+)$/.exec(p);
  if (m) return json(200, { block_height: m[1], block_hash: f.blockHash, block_timestamp: '1799999999000000', first_version: '8000000100', last_version: '8000000110' });
  return json(500, {});
}

let a: Adapter, make: () => Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  vi.stubGlobal('fetch', fakeFetch);
  const { aptosAdapter } = await import('../src/chains/aptos.ts');
  make = () => aptosAdapter(n);
  a = make();
});
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => { h = { [A]: fresh(), [B]: fresh() }; vi.setSystemTime(NOW * 1000); });

const prep = (over: Partial<{ to: string; amount: bigint; memo: string; asset: string; from: string }> = {}) => a.prepare({ asset: 'native', from: ME, to: DEST, amount: 10_000_000n, ...over });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? `threw: ${(e as Error).message}`; } return 'ok'; };
const intentOf = (r: Awaited<ReturnType<typeof prep>>, to = DEST, amount = '10000000'): Intent => ({ v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'aptos', chainRef: n.chainRef,
  asset: 'native', symbol: 'APT', decimals: 8, amount, from: ME, to, maxFee: r.maxFee.toString(), createdAt: NOW, expiresAt: NOW + r.ttlSec, policyVersion: 2, ...(r.section as { x: Record<string, string> }) });

describe('aptos adapter: prepare', () => {
  it('agrees on both sources at one ledger version and simulates the exact transaction the signer builds', async () => {
    h[B]!.version = 8_000_000_460; h[B]!.gas = 150; // sources a few versions apart, different gas estimates: still fine
    const r = await prep();
    expect(r.section).toEqual({ x: { sequence_number: '7', max_gas_amount: '200', gas_unit_price: '150', expiration_timestamp_secs: String(NOW + 180) } });
    expect([r.maxFee, r.feeEstimate, r.ttlSec, r.warnings]).toEqual([30_000n, 9_300n, 120, []]);
    // account and balance of both sources were read at the lower of the two ledger versions
    for (const u of [A, B]) expect(new Set(h[u]!.versions)).toEqual(new Set(['8000000460']));
    // the last simulation on each source is the transaction the signer's plugin rebuilds from the approved intent
    const intent = intentOf(r), built = buildAptosTx(intent, n);
    for (const u of [A, B]) { expect(h[u]!.sims).toHaveLength(2); expect(h[u]!.sims[1]).toBe(toHex(built.rawTx) + '0404'); }
    expect(() => pluginFor(n).build(intent, n)).not.toThrow();
    expect(built.maxFee).toBe(r.maxFee);
  });
  it('sizes the gas limit from the simulation (a recipient without an APT store costs a storage fee)', async () => {
    const r = await prep({ to: NEW });
    expect((r.section as any).x.max_gas_amount).toBe('8122');
    expect([r.maxFee, r.feeEstimate]).toEqual([812_200n, 541_400n]);
    expect(h[A]!.sims[1]).toBe(toHex(buildAptosTx(intentOf(r, NEW), n).rawTx) + '0404');
    // addresses the node prints without leading zeros are compared in canonical form
    expect(await code(prep({ to: LOWZ }))).toBe('ok');
  });
  it('gas price is floored at the network minimum and capped', async () => {
    for (const u of [A, B]) h[u]!.gas = 1;
    expect(((await prep()).section as any).x.gas_unit_price).toBe('100');
    h[A]!.gas = 5000;
    const r = await prep();
    expect([(r.section as any).x.gas_unit_price, r.warnings]).toEqual(['1000', ['network_congested']]);
    for (const u of [A, B]) h[u]!.sim = () => ({ success: true, vm_status: 'Executed successfully', gas_used: '9000' });
    expect(await code(prep())).toBe('fee_too_high'); // 13 501 units × 1 000 octas is above the 0.1 APT limit
  });
  it('fails closed when a source is down, is another chain, answers oddly or disagrees', async () => {
    h[B]!.down = true; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), chainId: 2 }; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), height: 1_174_999_999 }; expect(await code(prep())).toBe('rpc_degraded'); // behind the pinned checkpoint
    h[B] = fresh(); h[B]!.accounts[ME] = { sequence_number: '8', authentication_key: ME }; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.balances[ME] = '499999999'; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.accounts[ME] = { sequence_number: '7x', authentication_key: ME }; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = fresh(); h[B]!.timeSec = NOW - 61; expect(await code(prep())).toBe('rpc_degraded'); // stale source or wrong local clock
    h[B] = fresh(); h[B]!.gas = -1; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = fresh(); expect(await code(prep())).toBe('ok');
  });
  it('refuses when a simulation fails, is for another transaction, or does not credit the recipient exactly', async () => {
    const ok = { success: true, vm_status: 'Executed successfully', gas_used: '62' };
    h[B]!.sim = () => ({ success: false, vm_status: 'Move abort in 0x1::object: 0x60001', gas_used: '3' }); expect(await code(prep())).toBe('simulation_failed');
    h[B]!.sim = () => ({ success: false, vm_status: 'INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE', gas_used: '0' }); expect(await code(prep())).toBe('insufficient_funds');
    h[B]!.sim = () => ({ success: false, vm_status: 'SEQUENCE_NUMBER_TOO_OLD', gas_used: '0' }); expect(await code(prep())).toBe('pending_tx');
    h[B]!.sim = () => ({ ...ok, events: [] }); expect(await code(prep())).toBe('simulation_failed');
    h[B]!.sim = ({ to, amount }) => ({ ...ok, events: [{ type: '0x1::fungible_asset::Deposit', data: { amount: (amount - 1n).toString(), store: aptosAptStore(to) } }] }); expect(await code(prep())).toBe('simulation_failed');
    h[B]!.sim = ({ amount }) => ({ ...ok, events: [{ type: '0x1::fungible_asset::Deposit', data: { amount: amount.toString(), store: aptosAptStore(NEW) } }] }); expect(await code(prep())).toBe('simulation_failed');
    h[B]!.sim = ({ to, amount }) => ({ ...ok, events: [{ type: '0x1::coin::CoinDeposit', data: { amount: amount.toString(), account: to, coin_type: '0x1::aptos_coin::AptosCoin' } }] }); expect(await code(prep())).toBe('ok'); // legacy CoinStore recipient
    h[B]!.sim = ({ to, amount }) => ({ ...ok, events: [{ type: '0x1::coin::CoinDeposit', data: { amount: amount.toString(), account: to, coin_type: '0x1::other::Coin' } }] }); expect(await code(prep())).toBe('simulation_failed');
    h[B]!.sim = () => ({ ...ok, patch: { sequence_number: '8' } }); expect(await code(prep())).toBe('rpc_disagreement');
    h[B]!.sim = () => ({ ...ok, patch: { payload: { function: '0x1::coin::transfer', type_arguments: [], arguments: [DEST, '10000000'] } } }); expect(await code(prep())).toBe('rpc_disagreement');
    h[B]!.sim = () => ({ ...ok, patch: { hash: '0x' + 'cd'.repeat(32) } }); expect(await code(prep())).toBe('rpc_degraded');
    h[B]!.sim = ({ maxGas }) => ({ ...ok, gas_used: (maxGas + 1n).toString() }); expect(await code(prep())).toBe('rpc_degraded');
    h[B]!.sim = () => ok; expect(await code(prep())).toBe('ok');
  });
  it('checks the balance covers the amount plus the highest possible fee', async () => {
    const set = (v: string) => { for (const u of [A, B]) h[u]!.balances[ME] = v; };
    set('10020000'); expect(await code(prep())).toBe('ok'); // 0.1 APT + 200 units × 100 octas
    set('10019999'); expect(await code(prep())).toBe('insufficient_funds');
    set('10000000'); expect(await code(prep())).toBe('insufficient_funds');
    set('0'); expect(await code(prep())).toBe('insufficient_funds');
    expect(h[A]!.sims).toHaveLength(3); // nothing is simulated once the balance cannot even cover the amount
  });
  it('refuses rotated keys, tokens, memos and bad addresses', async () => {
    for (const u of [A, B]) h[u]!.accounts[ME] = { sequence_number: '7', authentication_key: DEST };
    expect(await code(prep())).toBe('unsupported_account');
    for (const u of [A, B]) h[u]!.accounts[ME] = { sequence_number: '7', authentication_key: ME };
    expect(await code(prep({ asset: '0x1::aptos_coin::AptosCoin' }))).toBe('unsupported_asset');
    expect(await code(prep({ memo: '12345' }))).toBe('bad_memo');
    expect(await code(prep({ to: ME }))).toBe('bad_address');
    expect(await code(prep({ to: '0x' + DEST.slice(2).toUpperCase() }))).toBe('bad_address');
    expect(await code(prep({ to: '0x1' }))).toBe('bad_address');
    expect(await code(prep({ to: '0x' + '0'.repeat(63) + 'a' }))).toBe('bad_address');
    expect(await code(prep({ amount: 0n }))).toBe('bad_amount');
    expect(await code(prep({ amount: 1n << 64n }))).toBe('bad_amount');
  });
});

describe('aptos adapter: health and identity', () => {
  it('ok only with both sources up, chain id 1 on-chain and the same block on both', async () => {
    expect(await make().health()).toMatchObject({ ok: true, readable: true, identityVerified: true, height: 1_176_000_000 });
    h[B]!.blockHash = '0x' + 'b2'.repeat(32);
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    h[B] = { ...fresh(), onChainId: 2 }; expect((await make().health()).ok).toBe(false);
    h[B] = { ...fresh(), chainId: 2 }; expect(await make().health()).toMatchObject({ ok: false, readable: true });
    h[B] = { ...fresh(), timeSec: NOW - 121 }; expect((await make().health()).ok).toBe(false); // stale
    h[B] = { ...fresh(), down: true }; expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    h[A]!.down = true; expect(await make().health()).toMatchObject({ ok: false, readable: false, height: null });
  });
  it('when the archive node answers, it must show the pinned genesis and the same block', async () => {
    h[ARCH] = fresh(); expect((await make().health()).ok).toBe(true);
    h[ARCH] = { ...fresh(), genesis: '0x' + 'ee'.repeat(32) }; expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    h[ARCH] = { ...fresh(), blockHash: '0x' + 'b3'.repeat(32) }; expect((await make().health()).ok).toBe(false);
  });
  it('re-verifies the identity periodically and withdraws it when the check fails', async () => {
    const ad = make();
    expect((await ad.health()).ok).toBe(true);
    h[B]!.blockHash = '0x' + 'b2'.repeat(32);
    expect((await ad.health()).ok).toBe(true); // within the re-check interval
    vi.setSystemTime((NOW + 601) * 1000);
    for (const u of [A, B]) h[u]!.timeSec = NOW + 600;
    expect(await ad.health()).toMatchObject({ ok: false, identityVerified: false });
  });
  it('reads a balance from any source', async () => {
    h[A]!.down = true;
    expect(await a.balances(ME)).toEqual({ native: 500_000_000n });
    expect(await a.balances(NEW)).toEqual({ native: 0n });
    await expect(a.balances('0x1')).rejects.toThrow(/Aptos address/);
  });
});

describe('aptos adapter: track', () => {
  const txid = '0x' + 'ab'.repeat(32), exp = NOW + 100;
  const track = () => a.track({ txid, intent: { x: { expiration_timestamp_secs: String(exp) } }, blockRef: null, broadcastAt: NOW });
  const rec = (success: boolean, version = '8000000300') => ({ type: 'user_transaction', hash: txid, success, version, vm_status: success ? 'Executed successfully' : 'Move abort' });
  it('finalized only when every reachable source shows a successful commit', async () => {
    h[A]!.txs[txid] = rec(true);
    expect(await track()).toEqual({ state: 'confirming', confirmations: 1, blockRef: '8000000300' }); // the other source has not caught up
    h[B]!.txs[txid] = { type: 'pending_transaction', hash: txid };
    expect((await track()).state).toBe('confirming');
    h[B]!.txs[txid] = rec(true);
    expect(await track()).toEqual({ state: 'finalized', confirmations: 201, blockRef: '8000000300' });
    h[B]!.down = true;
    expect((await track()).state).toBe('finalized');
    h[B] = fresh(); h[B]!.txs[txid] = rec(true, '8000000299');
    await expect(track()).rejects.toThrow(/disagree/);
    h[B]!.txs[txid] = { ...rec(true), hash: '0x' + 'cd'.repeat(32) };
    await expect(track()).rejects.toThrow(/bad transaction record/);
  });
  it('an on-chain failure is reported only when both sources agree', async () => {
    h[A]!.txs[txid] = rec(false); h[B]!.txs[txid] = rec(false);
    expect(await track()).toMatchObject({ state: 'failed', blockRef: '8000000300' });
    h[B]!.down = true;
    expect((await track()).state).toBe('confirming');
    h[B] = fresh(); h[B]!.txs[txid] = rec(true);
    await expect(track()).rejects.toThrow(/disagree/);
  });
  it('a hash alone is never success; expiry needs both sources past the expiration', async () => {
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true });
    h[A]!.txs[txid] = { type: 'pending_transaction', hash: txid };
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true }); // in a mempool is not committed
    for (const u of [A, B]) h[u]!.timeSec = exp + 21;
    vi.setSystemTime((exp + 25) * 1000);
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: false }); // still pending on one source: not failed
    delete h[A]!.txs[txid];
    h[A]!.timeSec = exp + 20; // exactly at the margin: not yet
    expect((await track()).state).toBe('broadcast');
    h[A]!.timeSec = exp + 21;
    expect(await track()).toMatchObject({ state: 'failed', confirmations: 0 });
    h[B]!.down = true;
    expect((await track()).state).toBe('broadcast'); // never "failed" on a single source
    h[B] = fresh(); h[B]!.timeSec = exp + 30; h[B]!.txs[txid] = rec(true);
    expect((await track()).state).toBe('confirming'); // committed after all on a source that was behind
    // every source reads its ledger position before looking the transaction up
    for (const u of [A, B]) expect(h[u]!.seen.slice(-2)).toEqual(['/', `/transactions/by_hash/${txid}`]);
    await expect(a.track({ txid, intent: { evm: {} }, blockRef: null, broadcastAt: NOW })).rejects.toThrow(/expiration/);
    await expect(a.track({ txid: 'ab'.repeat(32), intent: { x: { expiration_timestamp_secs: String(exp) } }, blockRef: null, broadcastAt: NOW })).rejects.toThrow(/transaction id/);
  });
});

describe('aptos adapter: broadcast', () => {
  const intent: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'aptos', chainRef: n.chainRef, asset: 'native', symbol: 'APT', decimals: 8, amount: '10000000',
    from: ME, to: DEST, maxFee: '20000', createdAt: NOW, expiresAt: NOW + 120, policyVersion: 2, x: { sequence_number: '7', max_gas_amount: '200', gas_unit_price: '100', expiration_timestamp_secs: String(NOW + 180) } };
  const signed = pluginFor(n).sign(intent, n, keys.handle(n));
  const accepted = { status: 202, body: { hash: signed.txid, type: 'pending_transaction' } };
  const tooOld = { status: 400, body: { message: 'Invalid transaction: Type: Validation Code: SEQUENCE_NUMBER_TOO_OLD', error_code: 'vm_error', vm_error_code: 3 } };
  it('sends the exact signed bytes to every source; one acceptance is enough', async () => {
    for (const u of [A, B]) h[u]!.submit = () => accepted;
    await a.broadcast(signed.raw);
    expect([h[A]!.posts, h[B]!.posts]).toEqual([[signed.raw], [signed.raw]]);
    expect(aptosTxid(aptosRawBytes(h[A]!.posts[0]!))).toBe(signed.txid);
    h[A]!.down = true;
    await a.broadcast(signed.raw);
    h[A] = fresh(); h[A]!.submit = () => tooOld; h[B]!.submit = () => accepted;
    await a.broadcast(signed.raw);
  });
  it('a refusal is an error unless a source already knows the transaction', async () => {
    for (const u of [A, B]) h[u]!.submit = () => tooOld;
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/SEQUENCE_NUMBER_TOO_OLD/);
    h[B]!.txs[signed.txid] = { type: 'user_transaction', hash: signed.txid, success: true, version: '8000000300' };
    await a.broadcast(signed.raw); // already known
    h[B]!.txs = {};
    for (const u of [A, B]) h[u]!.submit = () => ({ status: 202, body: { hash: '0x' + 'cd'.repeat(32) } });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/another transaction/);
    for (const u of [A, B]) h[u]!.submit = () => ({ status: 507, body: { message: 'Mempool is full', error_code: 'mempool_is_full' } });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/mempool_is_full/);
    await expect(a.broadcast('AAAA')).rejects.toThrow(/signed transaction/);
    await expect(a.broadcast(signed.raw.slice(2))).rejects.toThrow(/signed transaction/);
  });
});

describe('aptos adapter: deposits', () => {
  const SENDER = '0x' + '9d'.repeat(32);
  const tx = (v: number, events: any[], over: Record<string, unknown> = {}) => ({ type: 'user_transaction', version: String(v), hash: '0x' + v.toString(16).padStart(64, '0'), success: true, sender: SENDER, timestamp: String((NOW - 50) * 1_000_000), events, ...over });
  const fa = (amount: string, store = aptosAptStore(ME)) => ({ type: '0x1::fungible_asset::Deposit', data: { amount, store } });
  const put = (t: ReturnType<typeof tx>) => { for (const u of [A, B]) h[u]!.byVersion[Number(t.version)] = t; h[A]!.index.rows.push(Number(t.version)); };
  it('discovers through the index and records only what a full node shows', async () => {
    put(tx(8_000_000_100, [{ type: '0x1::fungible_asset::Withdraw', data: { amount: '5', store: aptosAptStore(SENDER) } }, fa('5'), fa('7', aptosAptStore(DEST))]));
    put(tx(8_000_000_200, [fa('11')], { success: false })); // aborted
    put(tx(8_000_000_210, [fa('13')], { sender: short(ME) })); // sent by this wallet
    put(tx(8_000_000_220, [fa('17', aptosAptStore(DEST))])); // the index names it, the node shows no credit to this wallet
    put(tx(8_000_000_230, [{ type: '0x1::coin::CoinDeposit', data: { amount: '19', account: short(ME), coin_type: '0x1::aptos_coin::AptosCoin' } }, { type: '0x1::coin::CoinDeposit', data: { amount: '23', account: ME, coin_type: '0x1::other::Coin' } }]));
    put(tx(8_000_000_450, [fa('29')])); // beyond what the index has fully processed (8 000 000 400): next pass
    const r = await a.deposits(ME, null);
    expect(r.items).toEqual([
      { txid: '0x' + (8_000_000_100).toString(16).padStart(64, '0'), idx: 1, asset: 'native', amount: 5n, from: SENDER, block: 8_000_000_100, time: NOW - 50 },
      { txid: '0x' + (8_000_000_230).toString(16).padStart(64, '0'), idx: 0, asset: 'native', amount: 19n, from: SENDER, block: 8_000_000_230, time: NOW - 50 },
    ]);
    expect([r.cursor, r.finalizedHeight]).toEqual([8_000_000_400, 8_000_000_500]);
    expect(h[B]!.seen.filter((p) => p.startsWith('/transactions/by_version/'))).toHaveLength(5); // verified on the source that is not the index
    expect(h[A]!.index.queries[0]).toContain(`owner_address:{_eq:"${ME}"}`);
    h[A]!.index.last = 8_000_000_480;
    const next = await a.deposits(ME, r.cursor);
    expect(next.items.map((d) => [d.block, d.amount])).toEqual([[8_000_000_450, 29n]]);
    expect(next.cursor).toBe(8_000_000_480);
    expect(h[A]!.index.queries.at(-1)).toContain('transaction_version:{_gt:8000000400}');
    expect((await a.deposits(ME, next.cursor)).items).toEqual([]);
  });
  it('pages through a long listing without skipping, and never moves the cursor past what it covered', async () => {
    for (let k = 0; k < 350; k++) put(tx(8_000_000_000 + k, [fa('1')]));
    const r = await a.deposits(ME, 7_999_999_999);
    expect([r.items.length, r.cursor]).toEqual([300, 8_000_000_299]);
    const s = await a.deposits(ME, r.cursor);
    expect([s.items.length, s.items[0]!.block, s.cursor]).toEqual([50, 8_000_000_300, 8_000_000_400]);
  });
  it('fails closed on index or node trouble; history older than the nodes keep comes from the archive', async () => {
    put(tx(8_000_000_100, [fa('5')]));
    h[A]!.index.fail = true;
    await expect(a.deposits(ME, 8_000_000_000)).rejects.toThrow(/index unavailable/);
    h[A]!.index.fail = false;
    for (const u of [A, B]) h[u]!.pruned.add(8_000_000_100);
    await expect(a.deposits(ME, 8_000_000_000)).rejects.toThrow(); // archive unreachable: nothing is skipped, the cursor does not move
    expect((await a.deposits(ME, null)).items).toEqual([]); // first scan: history only
    h[ARCH] = fresh(); h[ARCH]!.byVersion[8_000_000_100] = h[A]!.byVersion[8_000_000_100];
    expect((await a.deposits(ME, 8_000_000_000)).items.map((d) => d.amount)).toEqual([5n]);
    h[ARCH]!.byVersion[8_000_000_100] = { ...h[A]!.byVersion[8_000_000_100], version: '8000000101' };
    await expect(a.deposits(ME, 8_000_000_000)).rejects.toThrow(/bad transaction record/);
    h[B]!.down = true; h[B]!.pruned.clear(); h[A]!.pruned.clear();
    expect((await a.deposits(ME, 8_000_000_000)).items).toHaveLength(1); // the other source is down: the index operator's node verifies
    await expect(a.deposits('0x1', null)).rejects.toThrow(/Aptos address/);
  });
});

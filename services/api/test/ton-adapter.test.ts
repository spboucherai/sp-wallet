// TON adapter against a scripted TON Center v2 and a scripted TonAPI v2 (no network): agreement rules, bounce flag from on-chain
// state, wallet deployment, simulation, fail-closed paths, tracking, broadcast and deposits.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginCell, Cell, loadMessage, loadMessageRelaxed } from '@ton/core';
import { NETWORKS, pluginFor, TON_SUBWALLET_ID, TON_V4R2_CODE_BOC, tonFormatAddress, tonParseAddress, tonRawAddress, tonReadExternal, tonSerializeBoc, type Intent } from '@spw/core';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.ton, [A, B] = n.rpc as [string, string]; // A = TON Center, B = TonAPI
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const PUB = keys.handle(n).publicKey;
const ME = keys.addresses.ton!;
const DEST = tonFormatAddress(new Uint8Array(32).fill(0x21)), NEW = tonFormatAddress(new Uint8Array(32).fill(0x42)), THIRD = tonFormatAddress(new Uint8Array(32).fill(0x63));
const raw = tonRawAddress, eq = (addr: string) => tonFormatAddress(tonParseAddress(addr), { bounceable: true });
const NOW = 1_800_000_000, TON1 = 1_000_000_000n;
const CODE = Cell.fromBase64(TON_V4R2_CODE_BOC);

interface Acct { state: 'active' | 'uninit' | 'frozen'; balance: bigint; lastLt: number; seqno?: number; pub?: Uint8Array; walletType?: string; walletId?: number; code?: Cell }
interface Tx { lt: number; hash: string; utime: number; account: string; ext?: { body: string; norm: string }; from?: string; value?: bigint; outs: { to: string; value: bigint }[]; success?: boolean; aborted?: boolean }
interface Fake {
  down: boolean; zero: string; mc: number; time: number; accounts: Record<string, Acct>; txs: Tx[]; busy: number; seen: string[]; posts: { path: string; body: any }[];
  fees: Record<string, number>; emu: { status?: number; error?: string; skipped?: boolean; childAborted?: boolean; noChild?: boolean; value?: number };
  send: () => { status: number; body: any };
}
const wallet = (over: Partial<Acct> = {}): Acct => ({ state: 'active', balance: 10n * TON1, lastLt: 1000, seqno: 5, pub: PUB, walletType: 'wallet v4 r2', walletId: TON_SUBWALLET_ID, ...over });
const fresh = (): Fake => ({
  down: false, zero: n.chainRef, mc: 5000, time: NOW - 2, busy: 0, seen: [], posts: [], txs: [],
  accounts: { [raw(ME)]: wallet(), [raw(DEST)]: { state: 'active', balance: 3n * TON1, lastLt: 800 } },
  fees: { in_fwd_fee: 105334, storage_fee: 23, gas_fee: 220534, fwd_fee: 66667 }, emu: {}, send: () => ({ status: 200, body: { ok: true, result: { '@type': 'ok' } } }),
});
let h: Record<string, Fake>;
const dataOf = (a: Acct) => beginCell().storeUint(a.seqno ?? 0, 32).storeUint(a.walletId ?? TON_SUBWALLET_ID, 32).storeBuffer(Buffer.from(a.pub ?? new Uint8Array(32))).storeBit(0).endCell();
/** what the adapter posted for simulation, decoded by the official SDK */
function decodeTransfer(boc: string, external: boolean) {
  let body = Cell.fromBase64(boc);
  if (external) body = loadMessage(body.beginParse()).body;
  const s = body.beginParse();
  const signature = s.loadBuffer(64), signingHash = beginCell().storeSlice(s).endCell().hash().toString('hex'), head = [s.loadUint(32), s.loadUint(32), s.loadUint(32), s.loadUint(8), s.loadUint(8)];
  const out = loadMessageRelaxed(s.loadRef().beginParse());
  if (out.info.type !== 'internal') throw new Error('not internal');
  return { signature, signingHash, head, dest: out.info.dest.toRawString(), value: out.info.value.coins, bounce: out.info.bounce };
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input)), base = [A, B].find((u) => String(input).startsWith(u))!, f = h[base]!;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (!f || f.down) throw new TypeError('fetch failed');
  const path = url.pathname.slice(new URL(base).pathname.length), q = url.searchParams;
  f.seen.push(path + url.search);
  if (f.busy > 0) { f.busy--; return json(429, { ok: false, error: 'Ratelimit exceed' }); }
  const posted = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
  if (posted) f.posts.push({ path, body: posted });
  const acct = (r: string | null) => (r ? f.accounts[r] : undefined);
  if (base === A) {
    const ok = (result: unknown) => json(200, { ok: true, result });
    const a = acct(q.get('address')), state = !a ? 'uninitialized' : a.state === 'uninit' ? 'uninitialized' : a.state;
    const lastTx = { lt: String(a?.lastLt ?? 0), hash: Buffer.alloc(32, a ? 1 : 0).toString('base64') };
    if (path === '/getMasterchainInfo') return ok({ last: { seqno: f.mc }, init: { root_hash: Buffer.from(f.zero, 'hex').toString('base64') } });
    if (path === '/getAddressBalance') return ok(String(a?.balance ?? 0n));
    if (path === '/getWalletInformation') return ok({ wallet: a?.state === 'active', balance: String(a?.balance ?? 0n), account_state: state, last_transaction_id: lastTx,
      ...(a?.state === 'active' ? { wallet_type: a.walletType, seqno: a.seqno, wallet_id: a.walletId } : {}) });
    if (path === '/getAddressInformation') return ok({ state, balance: String(a?.balance ?? 0n), sync_utime: f.time, block_id: { seqno: f.mc }, last_transaction_id: lastTx,
      code: a?.state === 'active' ? (a.code ?? CODE).toBoc().toString('base64') : '', data: a?.state === 'active' ? dataOf(a).toBoc().toString('base64') : '' });
    if (path === '/getBlockHeader') return q.get('workchain') === '-1' && Number(q.get('seqno')) === f.mc ? ok({ gen_utime: f.time }) : json(500, { ok: false, error: 'block not found' });
    if (path === '/estimateFee') return ok({ '@type': 'query.fees', source_fees: f.fees, destination_fees: [] });
    if (path === '/sendBoc') { const r = f.send(); return json(r.status, r.body); }
    if (path === '/getTransactions') {
      let list = f.txs.filter((t) => t.account === q.get('address')).sort((x, y) => y.lt - x.lt);
      if (q.get('lt')) {
        const k = list.findIndex((t) => String(t.lt) === q.get('lt') && t.hash === q.get('hash'));
        if (k < 0) return json(500, { ok: false, error: 'LITE_SERVER_UNKNOWN: cannot locate transaction' });
        list = list.slice(k);
      }
      if (q.get('to_lt')) list = list.filter((t) => t.lt > Number(q.get('to_lt')));
      return ok(list.slice(0, Number(q.get('limit') ?? 10)).map((t) => ({
        utime: t.utime, transaction_id: { lt: String(t.lt), hash: Buffer.from(t.hash, 'hex').toString('base64') },
        in_msg: t.ext ? { source: '', destination: eq(t.account), value: '0', msg_data: { '@type': 'msg.dataRaw', body: t.ext.body } }
          : { source: eq(t.from!), destination: eq(t.account), value: String(t.value), msg_data: { '@type': 'msg.dataText', text: '' } },
        out_msgs: t.outs.map((o) => ({ source: eq(t.account), destination: eq(o.to), value: String(o.value) })),
      })));
    }
    return json(404, { ok: false, error: 'no such method' });
  }
  const taTx = (t: Tx) => ({
    hash: t.hash, lt: t.lt, utime: t.utime, success: t.success ?? true, aborted: t.aborted ?? false, account: { address: t.account },
    in_msg: t.ext ? { msg_type: 'ext_in_msg', value: 0, hash: t.ext.norm, destination: { address: t.account } } : { msg_type: 'int_msg', value: Number(t.value), bounce: true, source: { address: t.from }, destination: { address: t.account } },
    out_msgs: t.outs.map((o) => ({ msg_type: 'int_msg', value: Number(o.value), destination: { address: o.to }, source: { address: t.account } })),
  });
  if (path === '/liteserver/get_masterchain_info') return json(200, { last: { seqno: f.mc }, init: { workchain: -1, root_hash: f.zero } });
  if (path === '/blockchain/masterchain-head') return json(200, { seqno: f.mc, gen_utime: f.time });
  let m = /^\/blockchain\/accounts\/(0:[0-9a-f]{64})$/.exec(path);
  if (m) {
    const a = acct(m[1]!);
    if (!a) return json(404, { error: 'entity not found' });
    return json(200, { address: m[1], balance: Number(a.balance), status: a.state, last_transaction_lt: a.lastLt,
      ...(a.state === 'active' ? { code: (a.code ?? CODE).toBoc().toString('hex'), data: dataOf(a).toBoc().toString('hex') } : {}) });
  }
  m = /^\/blockchain\/messages\/([0-9a-f]{64})\/transaction$/.exec(path);
  if (m) { const t = f.txs.find((x) => x.ext?.norm === m![1]); return t ? json(200, taTx(t)) : json(404, { error: 'transaction not found' }); }
  m = /^\/blockchain\/accounts\/(0:[0-9a-f]{64})\/transactions$/.exec(path);
  if (m) {
    if (!acct(m[1]!)) return json(404, { error: 'entity not found' });
    let list = f.txs.filter((t) => t.account === m![1]).sort((x, y) => x.lt - y.lt);
    if (q.get('after_lt')) list = list.filter((t) => t.lt > Number(q.get('after_lt')));
    if (q.get('sort_order') !== 'asc') list.reverse();
    return json(200, { transactions: list.slice(0, Number(q.get('limit') ?? 100)).map(taTx) });
  }
  if (path === '/blockchain/message') { const r = f.send(); return r.status === 200 ? new Response(null, { status: 200 }) : json(r.status, r.body); }
  if (path === '/wallet/emulate') {
    if (f.emu.status) return json(f.emu.status, { error: f.emu.error });
    const t = decodeTransfer(posted.boc, true);
    const child = { transaction: { account: { address: t.dest }, aborted: f.emu.childAborted ?? false, in_msg: { msg_type: 'int_msg', value: f.emu.value ?? Number(t.value), bounce: t.bounce } } };
    return json(200, { trace: { transaction: { success: true, aborted: false, out_msgs: [], compute_phase: { success: true }, action_phase: { success: true, total_actions: 1, skipped_actions: f.emu.skipped ? 1 : 0 } },
      children: f.emu.skipped || f.emu.noChild ? [] : [child] } });
  }
  return json(404, { error: 'unknown route' });
}

let a: Adapter;
let make: () => Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  vi.stubGlobal('fetch', fakeFetch);
  const { tonAdapter } = await import('../src/chains/ton.ts');
  make = () => tonAdapter(n);
});
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => { h = { [A]: fresh(), [B]: fresh() }; a = make(); vi.setSystemTime(NOW * 1000); }); // a new adapter: no cached chain identity

const each = (f: (x: Fake) => void) => { for (const u of [A, B]) f(h[u]!); };
const prep = (over: Partial<{ to: string; amount: bigint; memo: string; asset: string; from: string }> = {}) => a.prepare({ asset: 'native', from: ME, to: DEST, amount: TON1, ...over });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? `threw: ${(e as Error).message}`; } return 'ok'; };
const intentOf = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'ton', chainRef: n.chainRef, asset: 'native', symbol: 'TON', decimals: 9,
  amount: TON1.toString(), from: ME, to: DEST, maxFee: '5000000', createdAt: NOW, expiresAt: NOW + 120, policyVersion: 4, x, ...over });

describe('ton adapter: prepare', () => {
  it('agrees on both sources and returns the exact intent section', async () => {
    h[B]!.mc = 5100; h[B]!.time = NOW - 30; // sources a few blocks apart: still fine
    const r = await prep({ memo: 'hello' });
    expect(r.section).toEqual({ x: { seqno: '5', validUntil: String(NOW + 300), bounce: '1', sendMode: '3', stateInit: '0' } });
    expect([r.maxFee, r.feeEstimate, r.ttlSec, r.warnings]).toEqual([5_000_000n, 392_558n, 120, []]);
    // the prepared section builds with the signer's plugin
    const intent = intentOf((r.section as { x: Record<string, string> }).x, { memo: 'hello', maxFee: r.maxFee.toString(), expiresAt: NOW + r.ttlSec });
    expect(() => pluginFor(n).build(intent, n)).not.toThrow();
    // both simulations received exactly the message that will be signed (zero signature in place of the real one)
    const est = h[A]!.posts.find((p) => p.path === '/estimateFee')!.body, emu = h[B]!.posts.find((p) => p.path === '/wallet/emulate')!.body;
    expect([est.address, est.ignore_chksig, est.init_code]).toEqual([raw(ME), true, undefined]);
    for (const t of [decodeTransfer(est.body, false), decodeTransfer(emu.boc, true)]) {
      expect(t.signature.equals(Buffer.alloc(64))).toBe(true);
      expect([t.head, t.dest, t.value, t.bounce]).toEqual([[TON_SUBWALLET_ID, NOW + 300, 5, 0, 3], raw(DEST), TON1, true]);
      expect(t.signingHash).toBe(Buffer.from(pluginFor(n).build(intent, n).signDocs[0]!).toString('hex'));
    }
    expect(tonReadExternal(emu.boc).stateInit).toBe(false);
  });
  it('chooses the bounce flag from the destination state on both sources', async () => {
    const r = await prep({ to: NEW }); // toncenter: "uninitialized", tonapi: 404 entity not found — the same thing
    expect((r.section as any).x).toMatchObject({ bounce: '0', stateInit: '0' });
    expect(r.warnings).toEqual(['destination_not_initialized']);
    each((f) => { f.accounts[raw(NEW)] = { state: 'uninit', balance: 5n, lastLt: 7 }; }); // holds coins, no contract
    expect((await prep({ to: NEW })).section).toMatchObject({ x: { bounce: '0' } });
    h[B]!.accounts[raw(NEW)] = { state: 'active', balance: 5n, lastLt: 7 };
    expect(await code(prep({ to: NEW }))).toBe('rpc_disagreement');
    h[A]!.accounts[raw(NEW)] = { state: 'active', balance: 5n, lastLt: 7 };
    expect((await prep({ to: NEW })).section).toMatchObject({ x: { bounce: '1' } });
    each((f) => { f.accounts[raw(NEW)]!.state = 'frozen'; });
    expect(await code(prep({ to: NEW }))).toBe('bad_destination');
  });
  it('first outgoing transfer: attaches the StateInit, seqno 0, no simulation possible', async () => {
    each((f) => { f.accounts[raw(ME)] = { state: 'uninit', balance: 2n * TON1, lastLt: 900 }; });
    const r = await prep({ to: NEW, memo: 'x'.repeat(50) });
    expect(r.section).toEqual({ x: { seqno: '0', validUntil: String(NOW + 300), bounce: '0', sendMode: '3', stateInit: '1' } });
    expect([r.feeEstimate, r.maxFee, r.warnings]).toEqual([2_000_000n, 6_000_000n, ['deploys_wallet', 'destination_not_initialized']]);
    expect([h[A]!.posts, h[B]!.posts]).toEqual([[], []]);
    const intent = intentOf((r.section as any).x, { to: NEW, memo: 'x'.repeat(50), maxFee: r.maxFee.toString() });
    expect(tonReadExternal(pluginFor(n).sign(intent, n, keys.handle(n)).raw).stateInit).toBe(true);
    // one source already sees the deployed contract: refuse
    h[A]!.accounts[raw(ME)] = wallet({ seqno: 1, balance: 2n * TON1, lastLt: 900 });
    expect(await code(prep())).toBe('rpc_disagreement');
  });
  it('checks the balance against amount plus fee budget, and refuses frozen or empty wallets', async () => {
    each((f) => { f.accounts[raw(ME)]!.balance = TON1 + 5_000_000n; });
    expect(await code(prep())).toBe('ok');
    each((f) => { f.accounts[raw(ME)]!.balance = TON1 + 4_999_999n; });
    expect(await code(prep())).toBe('insufficient_funds');
    expect([h[A]!.posts.length, h[B]!.posts.length]).toEqual([1, 1]); // not simulated when it cannot be paid
    each((f) => { f.accounts[raw(ME)]!.balance = 60n * TON1; f.fees.gas_fee = 3_000_000; }); // 3 × estimate above the floor
    expect((await prep()).maxFee).toBe(3n * (105334n + 23n + 3_000_000n + 66667n));
    each((f) => { f.fees.gas_fee = 20_000_000; });
    expect((await prep()).maxFee).toBe(50_000_000n); // capped
    each((f) => { f.fees.gas_fee = 50_000_000; });
    expect(await code(prep())).toBe('fee_too_high');
    each((f) => { delete f.accounts[raw(ME)]; });
    expect(await code(prep())).toBe('insufficient_funds'); // nothing at this address yet
    each((f) => { f.accounts[raw(ME)] = wallet({ state: 'frozen' }); });
    expect(await code(prep())).toBe('unsupported_account');
  });
  it('fails closed when a source is down, on another network, answers oddly or disagrees', async () => {
    h[B]!.down = true; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), zero: '823f81f306ff02694f935cf5021548e3ce2b86b529812af6a12148879e95a128' }; a = make(); expect(await code(prep())).toBe('rpc_degraded'); // testnet
    h[B] = fresh(); h[A] = { ...fresh(), zero: '823f81f306ff02694f935cf5021548e3ce2b86b529812af6a12148879e95a128' }; a = make(); expect(await code(prep())).toBe('rpc_degraded');
    h[A] = fresh(); a = make();
    const bad: [(f: Fake) => void, string][] = [
      [(f) => { f.accounts[raw(ME)]!.seqno = 6; }, 'rpc_disagreement'],
      [(f) => { f.accounts[raw(ME)]!.balance -= 1n; }, 'rpc_disagreement'],
      [(f) => { f.accounts[raw(ME)]!.lastLt = 1001; }, 'rpc_disagreement'],
      [(f) => { f.mc = 5151; }, 'rpc_disagreement'],
      [(f) => { f.time = NOW - 61; }, 'rpc_degraded'], // stale source or wrong local clock
      [(f) => { f.accounts[raw(ME)]!.walletId = 1; }, 'rpc_degraded'], // another subwallet: not this wallet contract
      [(f) => { f.accounts[raw(ME)]!.pub = new Uint8Array(32).fill(3); }, 'rpc_degraded'],
      [(f) => { f.accounts[raw(ME)]!.seqno = -1 as never; }, 'rpc_degraded'],
    ];
    for (const u of [A, B]) for (const [mutate, want] of bad) {
      h[A] = fresh(); h[B] = fresh(); mutate(h[u]!);
      // a wrong public key in the data only shows on the source that returns the data (TonAPI); TON Center reports the wallet type
      const expected = u === A && (mutate === bad[6]![0]) ? 'ok' : u === A && mutate === bad[7]![0] ? 'rpc_degraded' : want;
      expect(await code(prep()), `${u} ${bad.findIndex((b) => b[0] === mutate)}`).toBe(expected);
    }
    h[A] = fresh(); h[B] = fresh(); h[A]!.accounts[raw(ME)]!.walletType = 'wallet v3 r2'; expect(await code(prep())).toBe('rpc_degraded');
    h[A] = fresh(); h[B]!.accounts[raw(ME)]!.code = beginCell().storeUint(1, 8).endCell(); expect(await code(prep())).toBe('rpc_degraded'); // not the v4R2 code
    h[B] = fresh(); each((f) => { f.time = NOW + 61; }); expect(await code(prep())).toBe('rpc_degraded');
    h[A] = fresh(); h[B] = fresh(); expect(await code(prep())).toBe('ok');
  });
  it('re-verifies the chain identity when it is older than two minutes', async () => {
    expect(await code(prep())).toBe('ok');
    const calls = () => h[A]!.seen.filter((p) => p === '/getMasterchainInfo').length;
    expect(calls()).toBe(1);
    expect(await code(prep())).toBe('ok');
    expect(calls()).toBe(1);
    vi.setSystemTime((NOW + 121) * 1000); each((f) => { f.time = NOW + 120; });
    h[A]!.zero = 'ab'.repeat(32);
    expect(await code(prep())).toBe('rpc_degraded');
    expect(calls()).toBe(2);
  });
  it('simulation must show exactly this transfer leaving the wallet', async () => {
    h[A]!.fees.fwd_fee = 0; expect(await code(prep())).toBe('simulation_failed'); // estimateFee: no message was emitted
    h[A] = fresh(); h[A]!.fees.gas_fee = 0; expect(await code(prep())).toBe('simulation_failed'); // not even accepted
    h[A] = fresh(); h[B]!.emu = { status: 406, error: 'emulator: external message not accepted: exit code 33' };
    await expect(prep()).rejects.toThrow(/exit code 33/);
    expect(await code(prep())).toBe('simulation_failed');
    h[B]!.emu = { skipped: true }; expect(await code(prep())).toBe('simulation_failed'); // action skipped (send mode 3 hides it on-chain)
    h[B]!.emu = { noChild: true }; expect(await code(prep())).toBe('simulation_failed');
    h[B]!.emu = { value: 999 }; expect(await code(prep())).toBe('simulation_failed');
    h[B]!.emu = { childAborted: true }; expect(await code(prep())).toBe('simulation_failed'); // bounceable transfer the contract would return
    h[B]!.emu = { childAborted: true }; expect(await code(prep({ to: NEW }))).toBe('ok'); // nothing to bounce from: coins stay
    h[B]!.emu = { status: 500, error: 'internal' }; expect(await code(prep())).toBe('rpc_degraded');
    h[B]!.emu = {}; h[A]!.fees.gas_fee = 'x' as never; expect(await code(prep())).toBe('rpc_degraded');
  });
  it('waits and retries when a keyless source answers 429', async () => {
    h[A]!.busy = 1;
    expect(await code(prep())).toBe('ok');
    h[A]!.busy = 99;
    expect(await code(prep({ to: THIRD }))).toBe('rpc_degraded');
  }, 20_000);
  it('refuses jettons, bad or non-canonical addresses, bad amounts and bad comments', async () => {
    expect(await code(prep({ asset: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' }))).toBe('unsupported_asset');
    expect(await code(prep({ to: ME }))).toBe('bad_address');
    expect(await code(prep({ to: eq(DEST) }))).toBe('bad_address'); // must already be normalized
    expect(await code(prep({ to: raw(DEST) }))).toBe('bad_address');
    expect(await code(prep({ to: 'nope' }))).toBe('bad_address');
    expect(await code(prep({ amount: 0n }))).toBe('bad_amount');
    expect(await code(prep({ memo: '' }))).toBe('bad_memo');
    expect(await code(prep({ memo: 'a\ud800' }))).toBe('bad_memo');
    expect([h[A]!.seen, h[B]!.seen]).toEqual([[], []]); // refused before any request
  });
});

describe('ton adapter: track and broadcast', () => {
  const intent = intentOf({ seqno: '5', validUntil: String(NOW + 300), bounce: '1', sendMode: '3', stateInit: '0' });
  const signed = pluginFor(n).sign(intent, n, keys.handle(n));
  const body = Buffer.from(tonSerializeBoc(tonReadExternal(signed.raw).body)).toString('base64');
  const included = (over: Partial<Tx> = {}): Tx => ({ lt: 1100, hash: 'cd'.repeat(32), utime: NOW + 5, account: raw(ME), ext: { body, norm: signed.txid }, outs: [{ to: raw(DEST), value: TON1 }], ...over });
  const track = () => a.track({ txid: signed.txid, intent, blockRef: null, broadcastAt: NOW });

  it('finalized only when the masterchain-anchored source shows it and the indexer agrees', async () => {
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true }); // a returned hash is never success
    h[B]!.txs = [included()];
    expect(await track()).toEqual({ state: 'confirming', confirmations: 0, blockRef: '1100' }); // the indexer alone is not enough
    h[A]!.txs = [included()];
    expect(await track()).toEqual({ state: 'finalized', confirmations: 1, blockRef: '1100' });
    expect(h[A]!.seen.at(-1)).toContain(`limit=1&lt=1100&hash=${'cd'.repeat(32)}`); // asked for that exact transaction
    h[B]!.txs = [];
    expect((await track()).state).toBe('confirming'); // the reachable second source has not seen it
    h[B]!.down = true;
    expect((await track()).state).toBe('finalized'); // found by scanning the wallet's latest transactions
    expect(h[A]!.seen.at(-1)).toContain('limit=30');
    h[B] = fresh(); h[B]!.txs = [included({ lt: 1101 })];
    expect((await track()).state).toBe('confirming'); // TON Center cannot locate the transaction the indexer describes
    h[B]!.txs = [included({ outs: [] })];
    await expect(track()).rejects.toThrow(/disagree/);
    h[B]!.txs = [included({ account: raw(DEST) })];
    await expect(track()).rejects.toThrow(/another transaction/);
  });
  it('the wallet accepted the message but did not send the transfer: failed, on both sources only', async () => {
    // a signed message can only do what it says or nothing: any other reported effect means a source is wrong — no verdict
    for (const outs of [[{ to: raw(THIRD), value: TON1 }], [{ to: raw(DEST), value: TON1 - 1n }], [{ to: raw(DEST), value: TON1 }, { to: raw(THIRD), value: 1n }]]) {
      each((f) => { f.txs = [included({ outs })]; });
      await expect(track()).rejects.toThrow(/does not match/);
    }
    each((f) => { f.txs = [included({ outs: [] })]; });
    expect(await track()).toMatchObject({ state: 'failed', blockRef: '1100', error: expect.stringMatching(/not carried out/) });
    h[B]!.down = true;
    expect((await track()).state).toBe('confirming');
    h[B] = fresh(); h[B]!.txs = [included({ success: false, aborted: true })]; h[A]!.txs = [included()];
    await expect(track()).rejects.toThrow(/disagree/);
    h[B]!.txs = [included()]; h[A]!.txs = [included({ outs: [] })];
    await expect(track()).rejects.toThrow(/disagree/);
  });
  it('ignores other messages of the wallet and unreadable ones', async () => {
    const other = pluginFor(n).sign({ ...intent, amount: '5' }, n, keys.handle(n));
    const otherBody = Buffer.from(tonSerializeBoc(tonReadExternal(other.raw).body)).toString('base64');
    h[A]!.txs = [included({ lt: 1200, hash: 'ee'.repeat(32), ext: { body: otherBody, norm: other.txid } }), included({ lt: 1150, hash: 'ef'.repeat(32), ext: { body: 'AAAA', norm: 'x' } }),
      { lt: 1120, hash: 'aa'.repeat(32), utime: NOW, account: raw(ME), from: raw(DEST), value: 5n, outs: [] }];
    h[B]!.down = true;
    expect((await track()).state).toBe('broadcast');
    h[A]!.txs.push(included());
    expect(await track()).toMatchObject({ state: 'finalized', blockRef: '1100' });
  });
  it('expiry: failed only when both sources are past valid_until and the wallet seqno was never used', async () => {
    const validUntil = NOW + 300;
    vi.setSystemTime((validUntil + 60) * 1000); each((f) => { f.time = validUntil + 61; });
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: false }); // local clock exactly at the margin: not yet
    vi.setSystemTime((validUntil + 61) * 1000);
    expect(await track()).toEqual({ state: 'failed', confirmations: 0, error: 'not included before valid_until; no funds moved' });
    expect(h[A]!.seen.slice(-2)).toEqual([`/getAddressInformation?address=${raw(ME)}`, '/getBlockHeader?workchain=-1&shard=-9223372036854775808&seqno=5000']);
    h[A]!.time = validUntil + 60;
    expect((await track()).state).toBe('broadcast'); // the block the state was read at is not late enough
    h[A]!.time = validUntil + 61; h[B]!.time = validUntil + 60;
    expect((await track()).state).toBe('broadcast');
    h[B]!.time = validUntil + 61; h[B]!.accounts[raw(ME)]!.seqno = 6;
    expect((await track()).state).toBe('broadcast'); // the seqno was consumed: the message may have been included — never "failed"
    each((f) => { f.accounts[raw(ME)]!.seqno = 6; });
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: false });
    each((f) => { f.accounts[raw(ME)]!.seqno = 5; }); h[B]!.down = true;
    expect((await track()).state).toBe('broadcast'); // never "failed" on a single source
    h[B] = fresh(); h[B]!.time = validUntil + 61; h[B]!.txs = [included()];
    expect((await track()).state).toBe('confirming'); // included after all
    // a wallet that was never deployed still has seqno 0
    each((f) => { f.txs = []; f.accounts[raw(ME)] = { state: 'uninit', balance: TON1, lastLt: 1 }; });
    const first = intentOf({ ...intent.x!, seqno: '0', stateInit: '1' });
    expect((await a.track({ txid: 'ab'.repeat(32), intent: first, blockRef: null, broadcastAt: NOW })).state).toBe('failed');
    await expect(a.track({ txid: signed.txid, intent: { evm: {} }, blockRef: null, broadcastAt: NOW })).rejects.toThrow(/valid_until/);
    await expect(a.track({ txid: 'zz', intent, blockRef: null, broadcastAt: NOW })).rejects.toThrow();
  });

  it('broadcast: sends the exact bag of cells to every source', async () => {
    await a.broadcast(signed.raw);
    expect([h[A]!.posts, h[B]!.posts]).toEqual([[{ path: '/sendBoc', body: { boc: signed.raw } }], [{ path: '/blockchain/message', body: { boc: signed.raw } }]]);
    h[A]!.down = true;
    await a.broadcast(signed.raw);
    h[A] = fresh(); h[B]!.send = () => ({ status: 406, body: { error: 'rejected' } });
    await a.broadcast(signed.raw); // one acceptance is enough
  });
  it('broadcast: a refusal is an error unless the chain already contains the message', async () => {
    each((f) => { f.send = () => ({ status: 500, body: { ok: false, error: 'LITE_SERVER_UNKNOWN: cannot apply external message to current state : External message was not accepted', code: 500 } }); });
    h[B]!.send = () => ({ status: 406, body: { error: 'external message not accepted: exit code 33' } });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/not accepted/);
    h[B]!.txs = [included()];
    await a.broadcast(signed.raw); // already known (indexer)
    h[B]!.txs = []; h[A]!.txs = [included()];
    await a.broadcast(signed.raw); // already known (wallet history)
    await expect(a.broadcast('AAAA')).rejects.toThrow();
    await expect(a.broadcast(Buffer.from(beginCell().storeUint(0, 8).endCell().toBoc()).toString('base64'))).rejects.toThrow(/external message/);
  });
});

describe('ton adapter: balances, deposits, health', () => {
  const tx = (lt: number, o: Partial<Tx>): Tx => ({ lt, hash: lt.toString(16).padStart(64, '0'), utime: NOW - 100, account: raw(ME), outs: [], ...o });
  const history = (): Tx[] => [
    tx(2000, { from: raw(DEST), value: 1_500_000_000n }),
    tx(2100, { from: raw(DEST), value: 0n }), // no value
    tx(2200, { from: raw(DEST), value: 9n * TON1, outs: [{ to: raw(DEST), value: 9n * TON1 - 1000n }], aborted: true }), // bounced back: the wallet kept nothing
    tx(2300, { ext: { body: 'AAAA', norm: 'x' }, outs: [{ to: raw(DEST), value: 5n }] }), // our own outgoing transfer
    tx(2400, { from: raw(THIRD), value: 7n * TON1 }),
    tx(2450, { account: raw(DEST), from: raw(ME), value: 5n }), // someone else's account
  ];
  it('lists incoming Toncoin kept by the wallet, from the anchored source', async () => {
    each((f) => { f.txs = history(); });
    const first = await a.deposits(ME, null);
    expect(first.items.map((d) => [d.block, d.idx, d.amount, d.from, d.asset, d.txid, d.time])).toEqual([
      [2400, 0, 7n * TON1, THIRD, 'native', (2400).toString(16).padStart(64, '0'), NOW - 100], [2000, 0, 1_500_000_000n, DEST, 'native', (2000).toString(16).padStart(64, '0'), NOW - 100]]);
    expect([first.cursor, first.finalizedHeight]).toEqual([2400, 2400]);
    const next = await a.deposits(ME, 2000);
    expect([next.items.map((d) => d.block), next.cursor]).toEqual([[2400], 2400]);
    expect(h[A]!.seen.at(-1)).toContain('to_lt=2000');
    expect(await a.deposits(ME, 2400)).toEqual({ items: [], cursor: 2400, finalizedHeight: 2400 });
    expect(await a.deposits(NEW, null)).toEqual({ items: [], cursor: 0, finalizedHeight: 0 });
  });
  it('pages through a long history and falls back to the indexer (which leaves the last seconds for later)', async () => {
    const many = Array.from({ length: 120 }, (_, k) => tx(3000 + k, { from: raw(DEST), value: BigInt(k + 1) }));
    each((f) => { f.txs = many; });
    const r = await a.deposits(ME, 2999);
    expect([r.items.length, new Set(r.items.map((d) => d.block)).size, r.cursor]).toEqual([120, 120, 3119]);
    expect(h[A]!.seen.filter((p) => p.startsWith('/getTransactions')).length).toBe(3);
    h[A]!.down = true; h[B]!.txs = [...history(), tx(2500, { from: raw(DEST), value: 3n, utime: NOW - 5 })];
    const viaIndexer = await a.deposits(ME, 2000);
    expect([viaIndexer.items.map((d) => [d.block, d.amount, d.from]), viaIndexer.cursor, viaIndexer.finalizedHeight]).toEqual([[[2400, 7n * TON1, THIRD]], 2400, 2400]);
    expect((await a.deposits(ME, null)).items.map((d) => d.block)).toEqual([2000, 2400]);
    expect(await a.deposits(NEW, 77)).toEqual({ items: [], cursor: 77, finalizedHeight: 77 }); // "entity not found": no history
  });
  it('balances and health', async () => {
    expect(await a.balances(ME)).toEqual({ native: 10n * TON1 });
    expect(await a.balances(NEW)).toEqual({ native: 0n });
    h[A]!.down = true;
    expect(await a.balances(ME)).toEqual({ native: 10n * TON1 });
    expect(await a.balances(NEW)).toEqual({ native: 0n });
    h[A] = fresh();
    expect(await a.health()).toMatchObject({ network: 'ton', ok: true, readable: true, identityVerified: true, height: 5000, endpoints: [{ url: 'toncenter.com', ok: true }, { url: 'tonapi.io', ok: true }] });
    h[B]!.zero = '823f81f306ff02694f935cf5021548e3ce2b86b529812af6a12148879e95a128';
    expect((await a.health()).endpoints.map((e) => e.ok)).toEqual([true, false]);
    expect(await code(prep())).toBe('rpc_degraded'); // a failed identity check is not cached as good
    h[B] = fresh(); h[B]!.time = NOW - 121;
    expect((await a.health()).ok).toBe(false);
    h[B] = fresh(); h[B]!.mc = 5151;
    expect(await a.health()).toMatchObject({ ok: false, readable: true });
    h[A]!.down = true; h[B]!.down = true;
    expect(await a.health()).toMatchObject({ ok: false, readable: false });
  });
});

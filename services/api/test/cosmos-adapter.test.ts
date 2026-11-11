// Cosmos Hub adapter against two scripted REST sources (no network): agreement rules, refusals, fee and gas, tracking and broadcast outcomes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { cosmosTxid, NETWORKS } from '@spw/core';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.cosmos;
const [A, B] = n.rpc as [string, string];
const FROM = 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4', TO = 'cosmos1wnacchusmacys78rxcr640gjpz000f87gnz6zf', MODULE = 'cosmos13pxn9n3qw79e03844rdadagmg0nshmwf7qvuye';
const NEW = 'cosmos1uqdsdwwuujcrk95ur6wf6kwhjpajkmjmcjy3ed';
const TIP = 33_821_300;
const hashOf = (h: number) => Buffer.from(String(h).padStart(32, '0')).toString('base64');
const RAW = Buffer.from('signed transaction bytes').toString('base64'), TXID = cosmosTxid(RAW);

interface Req { url: string; base: string; path: string; query: URLSearchParams; height: number | undefined; body: any }
type Reply = { status?: number; body: unknown; height?: number | null } | 'down';
type Handler = (r: Req) => Reply;
const notFound = (message = 'not found'): Reply => ({ status: 404, body: { code: 5, message, details: [] } });
const txError = (message: string): Reply => ({ status: 500, body: { code: 2, message, details: [] } });
const base = (addr: string, accountNumber: string, sequence: string) => ({ account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', address: addr, pub_key: null, account_number: accountNumber, sequence } });

/** A healthy pair of sources; individual tests override routes per source. Routes are matched by path prefix. */
function world(over: Record<string, Handler> = {}, perUrl: Record<string, Record<string, Handler | 'down'>> = {}) {
  const state = { tip: { [A]: TIP, [B]: TIP } as Record<string, number>, now: Date.now(),
    accounts: { [FROM]: base(FROM, '1425847', '7'), [TO]: base(TO, '99', '0'),
      [MODULE]: { account: { '@type': '/cosmos.auth.v1beta1.ModuleAccount', base_account: { address: MODULE, account_number: '2844531', sequence: '0' }, name: 'feemarket-fee-collector' } } } as Record<string, unknown>,
    balances: { [FROM]: '30000000' } as Record<string, string> };
  const block = (r: Req, h: number): Reply => ({ body: { block_id: { hash: hashOf(h) }, block: { header: { height: String(h), chain_id: 'cosmoshub-4', time: new Date(state.now).toISOString() } } }, height: null });
  const routes: Record<string, Handler> = {
    '/cosmos/base/tendermint/v1beta1/node_info': () => ({ body: { default_node_info: { network: 'cosmoshub-4' } }, height: null }),
    '/cosmos/base/tendermint/v1beta1/blocks/latest': (r) => block(r, state.tip[r.base]!),
    '/cosmos/base/tendermint/v1beta1/blocks/': (r) => block(r, Number(r.path.split('/').pop())),
    '/cosmos/auth/v1beta1/accounts/': (r) => { const a = state.accounts[r.path.split('/').pop()!]; return a ? { body: a } : notFound('account not found'); },
    '/cosmos/bank/v1beta1/spendable_balances/': (r) => ({ body: { balance: { denom: 'uatom', amount: state.balances[r.path.split('/')[5]!] ?? '0' } } }),
    '/feemarket/v1/gas_price/uatom': () => ({ body: { price: { denom: 'uatom', amount: '0.005000000000000000' } } }),
    '/cosmos/base/node/v1beta1/config': (r) => ({ body: { minimum_gas_price: r.base === A ? '0.005000000000000000uatom' : '0.0025uatom,0.1ibc/ABC' } }),
    '/cosmos/tx/v1beta1/simulate': () => ({ body: { gas_info: { gas_wanted: '75000000', gas_used: '86054' } } }),
    '/cosmos/tx/v1beta1/txs/': () => notFound('tx not found'),
    '/cosmos/tx/v1beta1/txs': (r) => (r.body ? { body: { tx_response: { code: 0, txhash: TXID, raw_log: '' } } } : { body: { txs: [], tx_responses: [], total: '0' } }),
    ...over,
  };
  const find = (table: Record<string, Handler | 'down'>, path: string) => Object.keys(table).filter((k) => (k.endsWith('/') ? path.startsWith(k) : path === k)).sort((x, y) => y.length - x.length)[0];
  const calls: Req[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), baseUrl = [A, B].find((s) => url.startsWith(s))!;
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const req: Req = { url, base: baseUrl, path: u.pathname, query: u.searchParams, height: hdr['x-cosmos-block-height'] ? Number(hdr['x-cosmos-block-height']) : undefined, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const mine = perUrl[baseUrl] ?? {}, k = find(mine, u.pathname);
    const h = k !== undefined ? mine[k]! : routes[find(routes, u.pathname)!];
    if (h === 'down' || !h) throw new TypeError('fetch failed');
    const r = h(req);
    if (r === 'down') throw new TypeError('fetch failed');
    const height = r.height === undefined ? (req.height ?? state.tip[baseUrl]!) : r.height;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: height === null || (r.status ?? 200) !== 200 ? {} : { 'x-cosmos-block-height': String(height) } });
  });
  return { state, calls };
}

let make: () => Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const { cosmosAdapter } = await import('../src/chains/cosmos.ts');
  make = () => cosmosAdapter(n);
});
afterEach(() => vi.unstubAllGlobals());
const req = { asset: 'native', from: FROM, to: TO, amount: 2_000_000n };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? `error:${e.message}`);
const ACCOUNTS = '/cosmos/auth/v1beta1/accounts/', BLOCKS = '/cosmos/base/tendermint/v1beta1/blocks/', LATEST = BLOCKS + 'latest', SIM = '/cosmos/tx/v1beta1/simulate', TXS = '/cosmos/tx/v1beta1/txs';
const X = { account_number: '1425847', sequence: '7', gas_limit: '200000', fee_amount: '1500', timeout_height: String(TIP + 30) };

describe('cosmos adapter: health and identity', () => {
  it('is ok only when both sources are up, report the chain id and agree on a recent block', async () => {
    world();
    expect(await make().health()).toMatchObject({ ok: true, readable: true, identityVerified: true, height: TIP });
    world({}, { [B]: { [LATEST]: 'down' } });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    world({}, { [B]: { '/cosmos/base/tendermint/v1beta1/node_info': () => ({ body: { default_node_info: { network: 'theta-testnet-001' } } }) } });
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world({}, { [B]: { [BLOCKS]: (r) => ({ body: { block_id: { hash: hashOf(1) }, block: { header: { height: r.path.split('/').pop() === 'latest' ? String(TIP) : r.path.split('/').pop(), chain_id: 'cosmoshub-4', time: new Date().toISOString() } } } }) } });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false }); // same chain id, another block at that height (fork / impostor)
    world({}, { [A]: { [LATEST]: (r) => ({ body: { block_id: { hash: hashOf(TIP) }, block: { header: { height: String(TIP), chain_id: 'cosmoshub-4', time: new Date(Date.now() - 600_000).toISOString() } } } }) } });
    expect(await make().health()).toMatchObject({ ok: false, readable: true }); // a stalled node is not a source
    world({}, { [A]: { [LATEST]: 'down' }, [B]: { [LATEST]: 'down' } });
    expect(await make().health()).toMatchObject({ ok: false, readable: false });
  });
  it('prepare refuses when the identity cannot be verified on both sources', async () => {
    world({}, { [B]: { '/cosmos/base/tendermint/v1beta1/node_info': () => ({ body: { default_node_info: { network: 'cosmoshub-3' } } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
  });
});

describe('cosmos adapter: prepare', () => {
  it('returns account number, sequence, gas, fee and timeout = reference block + 30, all in the intent section', async () => {
    const w = world();
    const p = await make().prepare({ ...req, memo: '104588310' });
    // fee = ceil(200 000 gas × 0.005 uatom × 1.5)
    expect(p).toEqual({ section: { x: X }, maxFee: 1500n, feeEstimate: 1500n, warnings: [], ttlSec: 90 });
    // every state read that feeds the signature was made on both sources, pinned to the reference block
    for (const path of [ACCOUNTS + FROM, ACCOUNTS + TO, `/cosmos/bank/v1beta1/spendable_balances/${FROM}/by_denom`, '/feemarket/v1/gas_price/uatom'])
      expect(w.calls.filter((c) => c.path === path && c.height === TIP).map((c) => c.base).sort(), path).toEqual([A, B].sort());
    expect(w.calls.filter((c) => c.path === BLOCKS + TIP).length).toBe(2);
    // the dry run is this exact transfer, without key and signature, on both sources; nothing is broadcast
    const sims = w.calls.filter((c) => c.path === SIM);
    expect(sims.map((c) => c.base).sort()).toEqual([A, B].sort());
    const d = decodeTxRaw(Uint8Array.from(Buffer.from(sims[0]!.body.tx_bytes, 'base64')));
    expect(d.body).toMatchObject({ memo: '104588310', timeoutHeight: BigInt(TIP + 30) });
    expect(d.authInfo.fee).toMatchObject({ amount: [{ denom: 'uatom', amount: '1500' }], gasLimit: 200000n });
    expect(d.authInfo.signerInfos[0]).toMatchObject({ publicKey: undefined, sequence: 7n });
    expect(d.signatures.map((s) => s.length)).toEqual([0]);
    expect(w.calls.some((c) => c.path === TXS && c.body)).toBe(false);
  });
  it('uses the lower tip as the reference block, the highest gas of the two simulations and the highest required price', async () => {
    const w = world({}, { [B]: { [SIM]: () => ({ body: { gas_info: { gas_used: '130001' } } }) } });
    w.state.tip[B] = TIP - 2;
    const p = await make().prepare(req);
    expect(p.section).toEqual({ x: { ...X, gas_limit: '260002', fee_amount: '1951', timeout_height: String(TIP - 2 + 30) } }); // ceil(260002 × 0.0075)
    expect(p.maxFee).toBe(1951n);
    // a node whose own mempool floor is above the consensus price: its floor is what gets a transaction accepted there
    world({}, { [B]: { '/cosmos/base/node/v1beta1/config': () => ({ body: { minimum_gas_price: '0.02uatom' } }) } });
    expect((await make().prepare(req)).maxFee).toBe(6000n);
    world({ '/feemarket/v1/gas_price/uatom': () => ({ body: { price: { denom: 'uatom', amount: '0.2' } } }) });
    expect(await code(make().prepare(req))).toBe('fee_too_high'); // 60 000 uatom > ceiling: refuse rather than underpay or overpay
    world({ [SIM]: () => ({ body: { gas_info: { gas_used: '600000' } } }) });
    expect(await code(make().prepare(req))).toBe('simulation_failed'); // not what a plain send costs
  });
  it('fails closed when a source is down or the sources disagree on anything that feeds the signature', async () => {
    for (const m of [LATEST, BLOCKS, ACCOUNTS, '/cosmos/bank/v1beta1/spendable_balances/', '/feemarket/v1/gas_price/uatom', '/cosmos/base/node/v1beta1/config', SIM, '/cosmos/base/tendermint/v1beta1/node_info']) {
      world({}, { [B]: { [m]: 'down' } });
      expect(await code(make().prepare(req)), m).toBe('rpc_degraded');
    }
    const w = world(); w.state.tip[A] = TIP + 9;
    expect(await code(make().prepare(req))).toBe('rpc_disagreement'); // too far apart
    world({}, { [B]: { [BLOCKS]: (r) => ({ body: { block_id: { hash: hashOf(r.path.endsWith('latest') ? TIP : 1) }, block: { header: { height: r.path.endsWith('latest') ? String(TIP) : r.path.split('/').pop(), chain_id: 'cosmoshub-4', time: new Date().toISOString() } } } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement'); // different block at the reference height (fork)
    for (const lie of [base(FROM, '1425847', '8'), base(FROM, '1425848', '7')]) {
      world({}, { [B]: { [ACCOUNTS + FROM]: () => ({ body: lie }) } });
      expect(await code(make().prepare(req)), JSON.stringify(lie)).toBe('rpc_disagreement');
    }
    world({}, { [B]: { [ACCOUNTS + TO]: () => notFound() } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement'); // destination exists on one source only
    world({}, { [B]: { '/cosmos/bank/v1beta1/spendable_balances/': () => ({ body: { balance: { denom: 'uatom', amount: '30000001' } } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({}, { [B]: { '/feemarket/v1/gas_price/uatom': () => ({ body: { price: { denom: 'uatom', amount: '0.005000000000000001' } } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({}, { [B]: { [ACCOUNTS]: (r) => ({ body: base(FROM, '1425847', '7'), height: TIP - 3 }) } });
    expect(await code(make().prepare(req))).toBe('rpc_degraded'); // answered from another height than the one asked
    world({}, { [B]: { [LATEST]: () => ({ body: { block_id: { hash: hashOf(TIP) }, block: { header: { height: String(TIP), chain_id: 'cosmoshub-5', time: new Date().toISOString() } } } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_degraded'); // a source on another chain
    for (const bad of [{ balance: { denom: 'uatom', amount: '-5' } }, { balance: { denom: 'ibc/ABC', amount: '5' } }, {}]) {
      world({ '/cosmos/bank/v1beta1/spendable_balances/': () => ({ body: bad }) });
      expect(await code(make().prepare(req))).toBe('rpc_degraded');
    }
    world({ '/feemarket/v1/gas_price/uatom': () => ({ body: { price: { denom: 'uatom', amount: '0' } } }), '/cosmos/base/node/v1beta1/config': () => ({ body: { minimum_gas_price: '' } }) });
    expect(await code(make().prepare(req))).toBe('rpc_degraded'); // a zero price is not believable
    world({ [SIM]: () => ({ status: 502, body: 'bad gateway' }) });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
  });
  it('refuses what the chain would refuse, before anything is signed', async () => {
    world();
    expect(await code(make().prepare({ ...req, asset: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2' }))).toBe('unsupported_asset');
    expect(await code(make().prepare({ ...req, amount: 0n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, memo: ' 104588310' }))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, memo: '' }))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, to: FROM }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, to: 'osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8' }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, to: MODULE }))).toBe('bad_destination');
    expect(await code(make().prepare({ ...req, from: NEW }))).toBe('insufficient_funds'); // account not on chain yet
    expect(await code(make().prepare({ ...req, from: MODULE, to: TO }))).toBe('unsupported_account');
    expect(await code(make().prepare({ ...req, to: NEW }))).toBe('ok'); // the transfer creates the destination account
    expect(await code(make().prepare({ ...req, amount: 30_000_000n - 1500n }))).toBe('ok'); // exactly the balance
    expect(await code(make().prepare({ ...req, amount: 30_000_000n - 1499n }))).toBe('insufficient_funds');
    world({ [SIM]: () => txError('account sequence mismatch, expected 8, got 7: incorrect account sequence [cosmos/cosmos-sdk@v0.53.8/x/auth/ante/sigverify.go:370] with gas used: \'13750\'') });
    expect(await code(make().prepare(req))).toBe('pending_tx');
    world({}, { [B]: { [SIM]: () => txError('failed to execute message; message index: 0: spendable balance 3uatom is smaller than 2000000uatom: insufficient funds') } });
    expect(await code(make().prepare(req))).toBe('simulation_failed'); // one source's verdict is enough to refuse
  });
});

describe('cosmos adapter: tracking', () => {
  const tracked = (x: Record<string, string> = X) => make().track({ txid: TXID, intent: { from: FROM, x }, blockRef: null, broadcastAt: 0 });
  const found = (c: number, extra: object = {}): Handler => () => ({ body: { tx_response: { txhash: TXID, height: String(TIP + 3), code: c, raw_log: c ? 'out of gas' : '', ...extra } } });
  it('a transaction in a block with code 0 is final; any other code is a failure', async () => {
    world({ [TXS + '/']: found(0) });
    expect(await tracked()).toEqual({ state: 'finalized', confirmations: 1, blockRef: String(TIP + 3) });
    world({}, { [A]: { [TXS + '/']: 'down' }, [B]: { [TXS + '/']: found(0) } });
    expect(await tracked()).toMatchObject({ state: 'finalized' });
    world({ [TXS + '/']: found(11, { codespace: 'sdk' }) });
    expect(await tracked()).toMatchObject({ state: 'failed', blockRef: String(TIP + 3), error: expect.stringMatching(/code 11 sdk: out of gas.*only the network fee/) });
    world({ [TXS + '/']: () => ({ body: { tx_response: { txhash: 'CD'.repeat(32), height: '5', code: 0 } } }) });
    expect(await tracked()).toMatchObject({ state: 'broadcast' }); // an answer about another transaction proves nothing
  });
  it('declares it dead only past the timeout height, on both sources, with the sequence still unused', async () => {
    let w = world();
    expect(await tracked()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true }); // window still open
    w = world(); w.state.tip[A] = TIP + 31; w.state.tip[B] = TIP + 30;
    expect(await tracked()).toMatchObject({ state: 'broadcast' }); // one source has not passed the timeout yet
    w = world(); w.state.tip[A] = TIP + 31; w.state.tip[B] = TIP + 31;
    expect(await tracked()).toEqual({ state: 'failed', confirmations: 0, error: 'expired before inclusion (timeout height passed); no funds moved' });
    w = world({}, { [B]: { [TXS + '/']: 'down' } }); w.state.tip[A] = TIP + 99; w.state.tip[B] = TIP + 99;
    expect(await tracked()).toMatchObject({ state: 'broadcast' }); // one source cannot say: never "failed" on half the evidence
    w = world({}, { [B]: { [LATEST]: 'down' } }); w.state.tip[A] = TIP + 99;
    expect(await tracked()).toMatchObject({ state: 'broadcast' });
    // sequence consumed although neither index knows the hash: not provably ours → wait, then "replaced", never "failed"
    w = world(); w.state.tip[A] = TIP + 35; w.state.tip[B] = TIP + 35; w.state.accounts[FROM] = base(FROM, '1425847', '8');
    expect(await tracked()).toEqual({ state: 'broadcast', confirmations: 0 });
    w = world(); w.state.tip[A] = TIP + 51; w.state.tip[B] = TIP + 51; w.state.accounts[FROM] = base(FROM, '1425847', '8');
    expect(await tracked()).toEqual({ state: 'replaced', confirmations: 0, error: 'the sequence was consumed by another transaction' });
    w = world({}, { [B]: { [ACCOUNTS]: 'down' } }); w.state.tip[A] = TIP + 99; w.state.tip[B] = TIP + 99;
    expect(await tracked()).toEqual({ state: 'broadcast', confirmations: 0 });
  });
});

describe('cosmos adapter: broadcast, balances, deposits', () => {
  it('broadcasts to every source; success on one is enough, "already known" and "already in a block" are success', async () => {
    let w = world();
    await make().broadcast(RAW);
    expect(w.calls.filter((c) => c.path === TXS && c.body).map((c) => [c.base, c.body.tx_bytes, c.body.mode])).toEqual([[A, RAW, 'BROADCAST_MODE_SYNC'], [B, RAW, 'BROADCAST_MODE_SYNC']]);
    world({}, { [A]: { [TXS]: 'down' } });
    await make().broadcast(RAW);
    world({ [TXS]: () => ({ body: { tx_response: { code: 19, codespace: 'sdk', raw_log: 'tx already in mempool' } } }) });
    await make().broadcast(RAW);
    w = world({ [TXS]: () => ({ body: { tx_response: { code: 32, codespace: 'sdk', raw_log: 'account sequence mismatch, expected 8, got 7' } } }) });
    await expect(make().broadcast(RAW)).rejects.toThrow(/code 32 \(sdk\): account sequence mismatch/);
    world({ [TXS]: () => ({ body: { tx_response: { code: 32, codespace: 'sdk', raw_log: 'account sequence mismatch' } } }), [TXS + '/']: () => ({ body: { tx_response: { txhash: TXID, height: '5', code: 0 } } }) });
    await make().broadcast(RAW); // rejected because this very transaction is already in a block
    world({ [TXS]: () => ({ body: { tx_response: { code: 0, txhash: 'EF'.repeat(32) } } }) });
    await expect(make().broadcast(RAW)).rejects.toThrow(); // a source acknowledging another hash did not take ours
    world({ [TXS]: () => ({ body: { tx_response: { code: 13, codespace: 'sdk', raw_log: 'insufficient fee' } } }) });
    await expect(make().broadcast(RAW)).rejects.toThrow(/insufficient fee/);
    await expect(make().broadcast('not base64!')).rejects.toThrow(/invalid transaction payload/);
  });
  it('reads the spendable native balance with failover; an account not on chain reads as zero', async () => {
    world({}, { [A]: { '/cosmos/bank/v1beta1/spendable_balances/': 'down' } });
    expect(await make().balances(FROM)).toEqual({ native: 30_000_000n });
    expect(await make().balances(NEW)).toEqual({ native: 0n });
    await expect(make().balances('cosmos1xyz')).rejects.toThrow(/invalid address/);
  });
  it('lists incoming native transfers from committed, successful transactions only', async () => {
    const ev = (recipient: string, sender: string, amount: string) => ({ type: 'transfer', attributes: [{ key: 'recipient', value: recipient }, { key: 'sender', value: sender }, { key: 'amount', value: amount }] });
    const tx = (height: number, hash: string, c: number, events: unknown[]) => ({ height: String(height), txhash: hash, code: c, timestamp: '2026-11-11T00:21:53Z', events });
    const list = [
      tx(TIP - 1, 'A1'.repeat(32), 0, [ev(MODULE, TO, '700uatom'), ev(FROM, TO, '11952053uatom')]), // fee payment, then the send
      tx(TIP - 2, 'A2'.repeat(32), 0, [ev(FROM, TO, '5ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2,42uatom'), ev(FROM, MODULE, '8uatom')]), // mixed coins; two credits in one transaction
      tx(TIP - 3, 'A3'.repeat(32), 5, [ev(FROM, TO, '999uatom')]), // failed transaction
      tx(TIP - 4, 'A4'.repeat(32), 0, [ev(FROM, FROM, '1uatom'), ev(TO, FROM, '77uatom'), ev(FROM, TO, '9xuatom'), ev(FROM, TO, '0uatom')]), // self, outgoing, another denom, zero
      tx(TIP - 500, 'A5'.repeat(32), 0, [ev(FROM, TO, '3uatom')]),
      tx(TIP + 7, 'A6'.repeat(32), 0, [ev(FROM, TO, '4uatom')]), // "above the tip": not believable
    ];
    const w = world({ [TXS]: (r) => ({ body: { tx_responses: r.query.get('page') === '1' ? list : [], total: String(list.length) } }) });
    const first = await make().deposits(FROM, null);
    expect(first.cursor).toBe(TIP);
    expect(first.finalizedHeight).toBe(TIP);
    expect(first.items).toEqual([
      { txid: 'A1'.repeat(32), idx: 1, asset: 'native', amount: 11952053n, from: TO, block: TIP - 1, time: 1794356513 },
      { txid: 'A2'.repeat(32), idx: 0, asset: 'native', amount: 42n, from: TO, block: TIP - 2, time: 1794356513 },
      { txid: 'A2'.repeat(32), idx: 1, asset: 'native', amount: 8n, from: MODULE, block: TIP - 2, time: 1794356513 },
      { txid: 'A5'.repeat(32), idx: 0, asset: 'native', amount: 3n, from: TO, block: TIP - 500, time: 1794356513 },
    ]);
    const q = w.calls.find((c) => c.path === TXS)!.query;
    expect([q.get('query'), q.get('order_by'), q.get('page'), q.get('limit')]).toEqual([`transfer.recipient='${FROM}'`, 'ORDER_BY_DESC', '1', '50']);
    expect((await make().deposits(FROM, TIP - 2)).items.map((d) => d.txid)).toEqual(['A1'.repeat(32)]); // only what is above the cursor
    expect(await make().deposits(FROM, TIP)).toEqual({ items: [], cursor: TIP, finalizedHeight: TIP });
  });
});

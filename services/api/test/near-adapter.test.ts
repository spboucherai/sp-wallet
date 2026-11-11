// NEAR adapter against two scripted JSON-RPC sources, the archival node and the transfers index (no network):
// agreement rules, refusals, fee/reserve arithmetic, tracking verdicts, broadcast outcomes and deposit re-verification.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { NETWORKS, nearFeeCeiling } from '@spw/core';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.near;
const [A, B] = n.rpc as [string, string];
const ARCHIVAL = 'https://archival-rpc.mainnet.fastnear.com', INDEX = 'https://transfers.main.fastnear.com/v0/transfers';
const h = (label: string) => base58.encode(sha256(new TextEncoder().encode(label)));
const hex = (label: string) => Buffer.from(sha256(new TextEncoder().encode(label))).toString('hex');
const FROM = hex('from'), TO_IMPLICIT = hex('to'), TO = 'alice.near';
const FROM_KEY = 'ed25519:' + base58.encode(Buffer.from(FROM, 'hex'));
const TIP = 223_990_000, NONCE = 223_000_000_000_007;
const blockHash = (height: number) => h(`block-${height}`);
const ONE = 10n ** 24n;
/** the blocks the scripted nodes know by hash */
const HEIGHT_OF = new Map<string, number>([...Array.from({ length: 800 }, (_, k) => TIP - k), TIP - 86_400, TIP - 90_000].map((height) => [blockHash(height), height]));

type Handler = (params: any, url: string) => unknown;
class RpcErr { constructor(public cause: string, public data: unknown = '') {} }
const unknownTx = () => { throw new RpcErr('UNKNOWN_TRANSACTION'); };
const FEES = { execution: 108059500000, send_not_sir: 108059500000, send_sir: 108059500000 };
const protocol = (over: Record<string, unknown> = {}, costs: Record<string, unknown> = {}) => ({
  transaction_validity_period: 86400, ...over,
  runtime_config: { storage_amount_per_byte: '10000000000000000000', min_gas_purchase_price: '1000000000', account_creation_charge: '7000000000000000000000', ...(over.runtime ?? {}) as object,
    transaction_costs: { action_receipt_creation_config: FEES, action_creation_config: {
      transfer_cost: { execution: 115123062500, send_not_sir: 115123062500, send_sir: 115123062500 },
      create_account_cost: { execution: 7200000000000, send_not_sir: 500000000000, send_sir: 500000000000 },
      add_key_cost: { full_access_cost: { execution: 101765125000, send_not_sir: 101765125000, send_sir: 101765125000 } }, ...costs } } },
});

interface World { accounts: Record<string, { amount: string; locked: string; storage_usage: number } | undefined>; calls: { url: string; method: string; params: any }[]; tips: Record<string, number> }
/** A healthy pair of sources at the same final block; individual tests override methods per source. */
function world(over: Partial<Record<string, Handler>> = {}, perUrl: Record<string, Partial<Record<string, Handler | 'down'>>> = {}, index: (body: any) => unknown = () => ({ transfers: [], resume_token: null })): World {
  const w: World = {
    accounts: { [FROM]: { amount: (3n * ONE).toString(), locked: '0', storage_usage: 182 }, [TO]: { amount: '1', locked: '0', storage_usage: 5000 } },
    calls: [], tips: { [A]: TIP, [B]: TIP, [ARCHIVAL]: TIP },
  };
  const header = (height: number) => ({ header: { height, hash: blockHash(height), timestamp_nanosec: String(BigInt(Date.now() - (TIP - height) * 600) * 1_000_000n), gas_price: '100000000' } });
  const base: Record<string, Handler> = {
    status: (_p, url) => ({ chain_id: 'mainnet', genesis_hash: n.chainRef, sync_info: { latest_block_height: w.tips[url]! + 2, latest_block_time: new Date().toISOString(), syncing: false } }),
    block: (p, url) => {
      if (p.finality === 'final') return header(w.tips[url]!);
      if (typeof p.block_id === 'number') { if (p.block_id > w.tips[url]!) throw new RpcErr('UNKNOWN_BLOCK'); return header(p.block_id); }
      const height = HEIGHT_OF.get(p.block_id);
      if (height === undefined) throw new RpcErr('UNKNOWN_BLOCK');
      return header(height);
    },
    query: (p) => {
      if (p.request_type === 'view_account') { const a = w.accounts[p.account_id]; if (!a) throw new RpcErr('UNKNOWN_ACCOUNT'); return { ...a, code_hash: '1'.repeat(32), block_height: TIP, block_hash: blockHash(TIP) }; }
      if (p.request_type === 'view_access_key') return p.account_id === FROM && p.public_key === FROM_KEY && w.accounts[FROM] ? { nonce: NONCE, permission: 'FullAccess' } : { error: `access key ${p.public_key} does not exist while viewing`, logs: [] };
      throw new Error('unexpected query');
    },
    EXPERIMENTAL_protocol_config: () => protocol(),
    tx: unknownTx, EXPERIMENTAL_tx_status: unknownTx,
    send_tx: () => ({ final_execution_status: 'INCLUDED' }),
    ...over,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === INDEX) { w.calls.push({ url, method: 'index', params: body }); const r = index(body); if (r === 'down') throw new TypeError('fetch failed'); return new Response(JSON.stringify(r), { status: 200 }); }
    const { method, params } = body as { method: string; params: any };
    w.calls.push({ url, method, params });
    const f = perUrl[url]?.[method] ?? base[method];
    if (f === 'down' || !f) throw new TypeError('fetch failed');
    try { return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: f(params, url) }), { status: 200 }); }
    catch (e) {
      if (!(e instanceof RpcErr)) throw e;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: e.cause, info: {} }, code: -32000, message: 'Server error', data: e.data } }), { status: e.cause === 'UNKNOWN_BLOCK' ? 422 : 200 });
    }
  });
  return w;
}

let make: () => Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const { nearAdapter } = await import('../src/chains/near.ts');
  make = () => nearAdapter(n);
});
afterEach(() => vi.unstubAllGlobals());
const req = { asset: 'native', from: FROM, to: TO, amount: ONE };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? `error:${e.message}`);

describe('near adapter: health and identity', () => {
  it('is ok only when both sources are up, synced and on mainnet (chain id + genesis hash)', async () => {
    world();
    expect(await make().health()).toMatchObject({ network: 'near', ok: true, readable: true, identityVerified: true, height: TIP + 2 });
    world({}, { [B]: { status: 'down' } });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    world({}, { [B]: { status: () => ({ chain_id: 'testnet', genesis_hash: n.chainRef, sync_info: { latest_block_height: 5, latest_block_time: new Date().toISOString(), syncing: false } }) } });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    world({}, { [A]: { status: () => ({ chain_id: 'mainnet', genesis_hash: h('other genesis'), sync_info: { latest_block_height: 5, latest_block_time: new Date().toISOString(), syncing: false } }) } });
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world({}, { [A]: { status: () => ({ chain_id: 'mainnet', genesis_hash: n.chainRef, sync_info: { latest_block_height: 5, latest_block_time: new Date().toISOString(), syncing: true } }) } });
    expect(await make().health()).toMatchObject({ ok: false });
    world({}, { [A]: { status: () => ({ chain_id: 'mainnet', genesis_hash: n.chainRef, sync_info: { latest_block_height: 5, latest_block_time: new Date(Date.now() - 600_000).toISOString(), syncing: false } }) } });
    expect(await make().health()).toMatchObject({ ok: false }); // stale
    world({}, { [A]: { status: 'down' }, [B]: { status: 'down' } });
    expect(await make().health()).toMatchObject({ ok: false, readable: false, height: null });
  });
  it('balances: exact yoctoNEAR; an account that does not exist holds nothing; failover to the second source', async () => {
    const w = world();
    w.accounts[FROM] = { amount: '123456789012345678901234567', locked: '0', storage_usage: 182 };
    expect(await make().balances(FROM)).toEqual({ native: 123456789012345678901234567n });
    expect(await make().balances(TO_IMPLICIT)).toEqual({ native: 0n });
    world({}, { [A]: { query: 'down' } });
    expect(await make().balances(FROM)).toEqual({ native: 3n * ONE });
    world({}, { [A]: { query: 'down' }, [B]: { query: 'down' } });
    await expect(make().balances(FROM)).rejects.toThrow();
  });
});

describe('near adapter: prepare', () => {
  it('returns nonce + 1 and the agreed final block hash; the fee ceiling is the signer bound', async () => {
    const w = world();
    const p = await make().prepare(req);
    expect(p.section).toEqual({ x: { nonce: String(NONCE + 1), blockHash: blockHash(TIP) } });
    expect(p.maxFee).toBe(nearFeeCeiling(TO));
    expect(p.maxFee).toBe(2_000_000_000_000_000_000_000n);
    expect(p.feeEstimate).toBe(446_365_125_000n * 100_000_000n); // send + execution gas at the block price
    expect([p.warnings, p.ttlSec, p.aux]).toEqual([[], 120, undefined]);
    // every state read is pinned to the agreed block, on both sources
    const queries = w.calls.filter((c) => c.method === 'query');
    expect(queries).toHaveLength(6);
    expect(queries.every((c) => c.params.block_id === blockHash(TIP) && c.params.finality === undefined)).toBe(true);
    expect(new Set(queries.map((c) => c.url))).toEqual(new Set([A, B]));
    expect(w.calls.some((c) => c.method === 'send_tx')).toBe(false);
  });
  it('uses the older final block when the sources are a few blocks apart, after checking it is canonical on both', async () => {
    const w = world();
    w.tips[B] = TIP - 7;
    expect((await make().prepare(req)).section).toEqual({ x: { nonce: String(NONCE + 1), blockHash: blockHash(TIP - 7) } });
    expect(w.calls.filter((c) => c.method === 'block' && c.params.block_id === TIP - 7).map((c) => c.url).sort()).toEqual([A, B].sort());
    w.tips[B] = TIP - 101; // too far apart
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
  });
  it('a transfer that creates an implicit account: warning, higher ceiling, creation charge in the estimate', async () => {
    world();
    const p = await make().prepare({ ...req, to: TO_IMPLICIT });
    expect(p.warnings).toEqual(['near_creates_account']);
    expect(p.maxFee).toBe(20_000_000_000_000_000_000_000n);
    // (send + exec) × price + (0.007 NEAR − create_account execution at the block price)
    expect(p.feeEstimate).toBe(8_349_895_375_000n * 100_000_000n + (7_000_000_000_000_000_000_000n - 7_200_000_000_000n * 100_000_000n));
    const w = world();
    w.accounts[TO_IMPLICIT] = { amount: '5', locked: '0', storage_usage: 182 };
    const q = await make().prepare({ ...req, to: TO_IMPLICIT });
    expect([q.warnings, q.feeEstimate, q.maxFee]).toEqual([[], 8_349_895_375_000n * 100_000_000n, 20_000_000_000_000_000_000_000n]);
  });
  it('refuses a named destination that does not exist, and every malformed or unsupported request', async () => {
    world();
    expect(await code(make().prepare({ ...req, to: 'nobody-here.near' }))).toBe('bad_destination');
    expect(await code(make().prepare({ ...req, to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }))).toBe('bad_destination'); // an address of another chain is not a NEAR account
    for (const to of ['Alice.near', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', 'a', 'system', TO_IMPLICIT.toUpperCase(), 'alice..near']) expect(await code(make().prepare({ ...req, to })), to).toBe('bad_address');
    expect(await code(make().prepare({ ...req, to: FROM }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, from: 'bob.near' }))).toBe('bad_address');
    expect(await code(make().prepare({ ...req, asset: 'usdt.tether-token.near' }))).toBe('unsupported_asset');
    expect(await code(make().prepare({ ...req, amount: 0n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, memo: 'hi' }))).toBe('bad_memo');
  });
  it('fails closed when a source is down, on another chain, stale, or disagrees on anything', async () => {
    const cases: [string, Partial<Record<string, Handler | 'down'>>, string][] = [
      ['status down', { status: 'down' }, 'rpc_degraded'],
      ['testnet', { status: () => ({ chain_id: 'testnet', genesis_hash: h('testnet'), sync_info: { latest_block_height: 9, latest_block_time: new Date().toISOString(), syncing: false } }) }, 'rpc_degraded'],
      ['block down', { block: 'down' }, 'rpc_degraded'],
      ['query down', { query: 'down' }, 'rpc_degraded'],
      ['protocol config down', { EXPERIMENTAL_protocol_config: 'down' }, 'rpc_degraded'],
      ['rate limited', { query: () => { throw new Error('boom'); } }, 'rpc_degraded'],
      ['another block at the same height', { block: (p) => ({ header: { height: p.finality ? TIP : p.block_id, hash: h('fork'), timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n), gas_price: '100000000' } }) }, 'rpc_disagreement'],
      ['another nonce', { query: (p) => (p.request_type === 'view_access_key' ? { nonce: NONCE + 1, permission: 'FullAccess' } : { amount: (3n * ONE).toString(), locked: '0', storage_usage: p.account_id === FROM ? 182 : 5000 }) }, 'rpc_disagreement'],
      ['another balance', { query: (p) => (p.request_type === 'view_access_key' ? { nonce: NONCE, permission: 'FullAccess' } : { amount: (4n * ONE).toString(), locked: '0', storage_usage: p.account_id === FROM ? 182 : 5000 }) }, 'rpc_disagreement'],
      ['destination missing on one source', { query: (p) => { if (p.request_type === 'view_access_key') return { nonce: NONCE, permission: 'FullAccess' }; if (p.account_id === TO) throw new RpcErr('UNKNOWN_ACCOUNT'); return { amount: (3n * ONE).toString(), locked: '0', storage_usage: 182 }; } }, 'rpc_disagreement'],
      ['other fee parameters', { EXPERIMENTAL_protocol_config: () => protocol({}, { transfer_cost: { execution: 115123062501, send_not_sir: 115123062500, send_sir: 1 } }) }, 'rpc_disagreement'],
      ['malformed balance', { query: (p) => (p.request_type === 'view_access_key' ? { nonce: NONCE, permission: 'FullAccess' } : { amount: '1e24', locked: '0', storage_usage: 182 }) }, 'rpc_degraded'],
      ['nonce beyond exact integers', { query: (p) => (p.request_type === 'view_access_key' ? { nonce: 2 ** 60, permission: 'FullAccess' } : { amount: (3n * ONE).toString(), locked: '0', storage_usage: p.account_id === FROM ? 182 : 5000 }) }, 'rpc_degraded'],
    ];
    for (const [name, o, want] of cases) for (const src of [A, B]) { world({}, { [src]: o }); expect(await code(make().prepare(req)), `${name} on ${src}`).toBe(want); }
    // both sources stale in the same way: agreement is not enough
    world({ block: (p) => ({ header: { height: p.finality ? TIP : p.block_id, hash: blockHash(TIP), timestamp_nanosec: String(BigInt(Date.now() - 200_000) * 1_000_000n), gas_price: '100000000' } }) });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
  });
  it('refuses when the live protocol parameters leave the bounds the signer enforces', async () => {
    const outside: [string, Handler][] = [
      ['gas above the bound', () => protocol({}, { transfer_cost: { execution: 900_000_000_000, send_not_sir: 115123062500, send_sir: 1 } })],
      ['minimum purchase price above the price cap', () => protocol({ runtime: { min_gas_purchase_price: '2000000001' } })],
      ['another validity period', () => protocol({ transaction_validity_period: 43200 })],
      ['missing parameter', () => { const p = protocol(); delete (p.runtime_config as any).min_gas_purchase_price; return p; }],
    ];
    for (const [name, f] of outside) { world({ EXPERIMENTAL_protocol_config: f }); expect(await code(make().prepare(req)), name).toBe('rpc_degraded'); }
    world({ block: (p) => ({ header: { height: p.finality ? TIP : p.block_id, hash: blockHash(TIP), timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n), gas_price: '2000000001' } }) });
    expect(await code(make().prepare(req))).toBe('rpc_degraded'); // a gas price above the protocol cap means the pinned cap is wrong
  });
  it('account state: not activated, key missing or restricted', async () => {
    const w = world();
    delete w.accounts[FROM];
    expect(await code(make().prepare(req))).toBe('insufficient_funds');
    world({ query: (p) => (p.request_type === 'view_access_key' ? { error: 'access key does not exist while viewing', logs: [] } : { amount: (3n * ONE).toString(), locked: '0', storage_usage: 182 }) });
    expect(await code(make().prepare(req))).toBe('unsupported_account');
    world({ query: (p) => (p.request_type === 'view_access_key' ? { nonce: NONCE, permission: { FunctionCall: { allowance: null, receiver_id: 'x.near', method_names: [] } } } : { amount: (3n * ONE).toString(), locked: '0', storage_usage: 182 }) });
    expect(await code(make().prepare(req))).toBe('unsupported_account');
  });
  it('balance must cover amount + upfront gas purchase (+ storage when the account is not a zero-balance account), to the yoctoNEAR', async () => {
    // named destination at 10^8: burnt 223182562500 gas at 2×10^8 (headroom) + 223182562500 gas bought at 10^9
    const upfront = 223_182_562_500n * 200_000_000n + 223_182_562_500n * 1_000_000_000n;
    const w = world();
    w.accounts[FROM] = { amount: (ONE + upfront).toString(), locked: '0', storage_usage: 182 };
    expect(await code(make().prepare(req))).toBe('ok'); // a small account can be emptied (zero-balance account)
    w.accounts[FROM] = { amount: (ONE + upfront - 1n).toString(), locked: '0', storage_usage: 182 };
    expect(await code(make().prepare(req))).toBe('insufficient_funds');
    // 771 bytes: 771 × 10^19 yoctoNEAR must remain
    const reserve = 771n * 10_000_000_000_000_000_000n;
    w.accounts[FROM] = { amount: (ONE + upfront + reserve).toString(), locked: '0', storage_usage: 771 };
    expect(await code(make().prepare(req))).toBe('ok');
    w.accounts[FROM] = { amount: (ONE + upfront + reserve - 1n).toString(), locked: '0', storage_usage: 771 };
    expect(await code(make().prepare(req))).toBe('insufficient_funds');
    w.accounts[FROM] = { amount: (ONE + upfront).toString(), locked: reserve.toString(), storage_usage: 771 }; // a locked (staked) balance counts toward storage
    expect(await code(make().prepare(req))).toBe('ok');
    w.accounts[FROM] = { amount: (ONE + upfront).toString(), locked: '0', storage_usage: 770 };
    expect(await code(make().prepare(req))).toBe('ok');
    // creating an implicit account buys far more gas upfront
    const upfrontImplicit = 824_947_687_500n * 200_000_000n + 7_524_947_687_500n * 1_000_000_000n;
    w.accounts[FROM] = { amount: (ONE + upfrontImplicit - 1n).toString(), locked: '0', storage_usage: 182 };
    expect(await code(make().prepare({ ...req, to: TO_IMPLICIT }))).toBe('insufficient_funds');
    w.accounts[FROM] = { amount: (ONE + upfrontImplicit).toString(), locked: '0', storage_usage: 182 };
    expect(await code(make().prepare({ ...req, to: TO_IMPLICIT }))).toBe('ok');
  });
});

const AMOUNT = '1000000000000000000000000';
const txView = (o: { txid: string; final?: string; status?: object; to?: string; amount?: string; from?: string; receipts?: unknown[]; outcomes?: unknown[] }) => ({
  final_execution_status: o.final ?? 'FINAL', status: o.status ?? { SuccessValue: '' },
  transaction: { hash: o.txid, signer_id: o.from ?? FROM, receiver_id: o.to ?? TO, nonce: NONCE + 1, actions: [{ Transfer: { deposit: o.amount ?? AMOUNT } }] },
  transaction_outcome: { block_hash: blockHash(TIP - 3), id: o.txid, outcome: { status: { SuccessReceiptId: h('r') } } },
  receipts: o.receipts, receipts_outcome: o.outcomes ?? [],
});
const TXID = h('tx-1');
const tracked = (over: Record<string, unknown> = {}) => ({ txid: TXID, intent: { from: FROM, to: TO, amount: AMOUNT, createdAt: Math.floor(Date.now() / 1000) - 30, x: { nonce: String(NONCE + 1), blockHash: blockHash(TIP - 20) } },
  blockRef: null as string | null, broadcastAt: Date.now() / 1000 - 20, ...over });

describe('near adapter: track', () => {
  it('finalized only when every reachable source shows a final success; a hash alone is never success', async () => {
    world({ tx: () => txView({ txid: TXID }) });
    expect(await make().track(tracked())).toEqual({ state: 'finalized', confirmations: n.minConf, blockRef: blockHash(TIP - 3) });
    world({ tx: () => txView({ txid: TXID }) }, { [B]: { tx: unknownTx } });
    expect(await make().track(tracked())).toMatchObject({ state: 'confirming', confirmations: 1 });
    for (const final of ['NONE', 'INCLUDED', 'EXECUTED_OPTIMISTIC', 'INCLUDED_FINAL', 'EXECUTED']) {
      world({ tx: () => txView({ txid: TXID, final }) });
      expect((await make().track(tracked())).state, final).toBe('confirming');
    }
    world({ tx: () => txView({ txid: TXID, final: 'FINAL', status: { Unknown: null } }) });
    expect((await make().track(tracked())).state).toBe('confirming');
    world({ tx: () => txView({ txid: TXID }) }, { [B]: { tx: () => txView({ txid: TXID, final: 'EXECUTED_OPTIMISTIC' }) } });
    expect((await make().track(tracked())).state).toBe('confirming');
    world({ tx: () => txView({ txid: TXID }) }, { [B]: { tx: 'down', block: 'down' } }); // one source reachable and final: success may be shown
    expect((await make().track(tracked())).state).toBe('finalized');
  });
  it('failed when the transfer was included and failed, on both sources', async () => {
    const failure = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: TO } } } } };
    world({ tx: () => txView({ txid: TXID, status: failure }) });
    const t = await make().track(tracked());
    expect(t).toMatchObject({ state: 'failed', confirmations: 0, blockRef: blockHash(TIP - 3) });
    expect(t.error).toMatch(/AccountDoesNotExist/);
    world({ tx: () => txView({ txid: TXID, status: failure }) }, { [B]: { tx: 'down' } });
    expect((await make().track(tracked())).state).toBe('confirming'); // a failure verdict needs both sources
    world({ tx: () => txView({ txid: TXID, status: failure }) }, { [B]: { tx: () => txView({ txid: TXID }) } });
    expect((await make().track(tracked())).state).toBe('confirming'); // contradictory results are never announced
  });
  it('a record that is not the approved transfer is not accepted', async () => {
    for (const bad of [txView({ txid: TXID, to: 'mallory.near' }), txView({ txid: TXID, amount: '1' }), txView({ txid: h('other') }), txView({ txid: TXID, from: TO_IMPLICIT })]) {
      world({ tx: () => bad });
      expect((await make().track(tracked())).state).toBe('broadcast');
    }
  });
  it('unknown transaction: stays pending while it can still be included', async () => {
    world();
    expect(await make().track(tracked())).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true });
    world({}, { [B]: { tx: 'down' } });
    expect(await make().track(tracked({ intent: { ...tracked().intent, x: { nonce: String(NONCE + 1), blockHash: blockHash(TIP - 90_000) } } }))).toMatchObject({ state: 'broadcast' }); // never "failed" on one source
    world();
    expect(await make().track(tracked({ blockRef: blockHash(TIP - 3) }))).toMatchObject({ state: 'reorged', rebroadcast: true }); // it had been seen in a block
  });
  it('failed only when the nonce is still unused at a final block past the validity period, on both sources', async () => {
    const expired = () => tracked({ intent: { ...tracked().intent, x: { nonce: String(NONCE + 1), blockHash: blockHash(TIP - 90_000) } }, broadcastAt: Date.now() / 1000 - 60_000 });
    world();
    expect(await make().track(expired())).toMatchObject({ state: 'failed', confirmations: 0, error: expect.stringMatching(/no funds moved/) });
    const w = world();
    w.tips[B] = TIP - 3500; // the second source is not yet past reference + 86 400 + margin
    expect((await make().track({ ...expired(), txid: h('tx-2') })).state).toBe('broadcast');
    world();
    expect((await make().track({ ...tracked({ intent: { ...tracked().intent, x: { nonce: String(NONCE + 1), blockHash: blockHash(TIP - 86_400) } } }), txid: h('tx-3') })).state).toBe('broadcast'); // exactly at the limit: still valid
    world({}, { [A]: { query: 'down' } });
    expect((await make().track({ ...expired(), txid: h('tx-4') })).state).toBe('broadcast'); // nonce unreadable: no verdict
  });
  it('nonce already used: asks the archival node; included → final result, otherwise replaced (never before two minutes)', async () => {
    const used = (over: Record<string, unknown> = {}) => tracked({ intent: { ...tracked().intent, x: { nonce: String(NONCE), blockHash: blockHash(TIP - 20) } }, broadcastAt: Date.now() / 1000 - 600, ...over });
    world({}, { [ARCHIVAL]: { tx: () => txView({ txid: TXID }) } });
    expect(await make().track(used())).toMatchObject({ state: 'finalized', blockRef: blockHash(TIP - 3) });
    world({}, { [ARCHIVAL]: { tx: () => txView({ txid: TXID, status: { Failure: { ActionError: {} } } }) } });
    expect((await make().track(used())).state).toBe('failed');
    world({}, { [ARCHIVAL]: { tx: () => txView({ txid: TXID, final: 'EXECUTED' }) } });
    expect((await make().track(used())).state).toBe('confirming');
    world();
    expect(await make().track(used())).toMatchObject({ state: 'replaced', error: expect.stringMatching(/nonce was used/) });
    world();
    expect((await make().track(used({ blockRef: blockHash(TIP - 3) }))).state).toBe('failed'); // same verdict, legal transition from "reorged"
    world();
    expect((await make().track(used({ broadcastAt: Date.now() / 1000 - 60 }))).state).toBe('broadcast'); // too early to conclude
    world({}, { [ARCHIVAL]: { tx: 'down' } });
    expect(await make().track({ ...used(), txid: h('tx-5') })).toMatchObject({ state: 'broadcast', rebroadcast: false }); // archival unreachable: no verdict
  });
  it('rejects an intent without NEAR parameters', async () => {
    world();
    await expect(make().track(tracked({ intent: { from: FROM, to: TO, amount: AMOUNT, x: {} } }))).rejects.toThrow();
    await expect(make().track(tracked({ intent: { from: 'bob.near', to: TO, amount: AMOUNT, x: tracked().intent.x } }))).rejects.toThrow();
  });
});

describe('near adapter: broadcast', () => {
  // a syntactically valid SignedTransaction for FROM (the adapter derives the hash and the signer from the bytes)
  const body = Buffer.concat([Buffer.from([64, 0, 0, 0]), Buffer.from(FROM), Buffer.from([0]), Buffer.from(FROM, 'hex'), Buffer.alloc(8, 1), Buffer.from([10, 0, 0, 0]), Buffer.from('alice.near'),
    Buffer.alloc(32, 7), Buffer.from([1, 0, 0, 0, 3]), Buffer.alloc(16, 2)]);
  const RAW = Buffer.concat([body, Buffer.from([0]), Buffer.alloc(64, 9)]).toString('base64'), RAW_TXID = base58.encode(sha256(body));
  it('relays the exact bytes to both sources and waits for inclusion', async () => {
    const w = world();
    await make().broadcast(RAW);
    const sent = w.calls.filter((c) => c.method === 'send_tx');
    expect(sent.map((c) => c.url).sort()).toEqual([A, B].sort());
    expect(sent.every((c) => c.params.signed_tx_base64 === RAW && c.params.wait_until === 'INCLUDED')).toBe(true);
  });
  it('one source accepting is enough; a node timeout after validation counts as accepted', async () => {
    world({}, { [A]: { send_tx: 'down' } });
    await expect(make().broadcast(RAW)).resolves.toBeUndefined();
    world({ send_tx: () => { throw new RpcErr('TIMEOUT_ERROR'); } });
    await expect(make().broadcast(RAW)).resolves.toBeUndefined();
  });
  it('reports the network refusal; "already known" is success when the chain has the transaction', async () => {
    const invalid = () => { throw new RpcErr('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 9, tx_nonce: 8 } } } }); };
    world({ send_tx: invalid });
    await expect(make().broadcast(RAW)).rejects.toThrow(/rejected by the network: INVALID_TRANSACTION.*InvalidNonce/);
    const w = world({ send_tx: invalid, tx: (p) => txView({ txid: p.tx_hash }) });
    await expect(make().broadcast(RAW)).resolves.toBeUndefined();
    expect(w.calls.find((c) => c.method === 'tx')!.params).toEqual({ tx_hash: RAW_TXID, sender_account_id: FROM, wait_until: 'NONE' });
    world({}, { [A]: { send_tx: 'down' }, [B]: { send_tx: 'down' } });
    await expect(make().broadcast(RAW)).rejects.toThrow();
    await expect(make().broadcast('AAAA')).rejects.toThrow(/not a NEAR signed transaction/);
  });
});

describe('near adapter: deposits', () => {
  const ME = FROM, SENDER = TO_IMPLICIT;
  const row = (k: number, over: Record<string, unknown> = {}) => ({ block_height: String(TIP - 500 - k), transaction_id: h(`dtx-${k}`), receipt_id: h(`drc-${k}`), signer_id: SENDER, account_id: ME, asset_id: 'native:near',
    amount: '999', transfer_type: 'NativeTransfer', ...over });
  const receipt = (k: number, over: Record<string, unknown> = {}, actions: unknown[] = [{ Transfer: { deposit: String(BigInt(k + 1) * ONE + 7n) } }]) =>
    ({ predecessor_id: SENDER, receiver_id: ME, receipt_id: h(`drc-${k}`), receipt: { Action: { actions } }, ...over });
  const outcome = (k: number, status: object = { SuccessValue: '' }, executor = ME) => ({ id: h(`drc-${k}`), block_hash: blockHash(TIP - 100 - k), outcome: { executor_id: executor, status } });
  const status = (views: Record<string, unknown>): Handler => (p) => { const v = views[p.tx_hash]; if (!v) throw new RpcErr('UNKNOWN_TRANSACTION'); return v; };
  const view = (k: number, receipts: unknown[], outcomes: unknown[], final = 'FINAL') => ({ ...txView({ txid: h(`dtx-${k}`), from: SENDER, to: ME, receipts, outcomes, final }) });

  it('reports only transfers that RPC confirms: amount, sender and block come from the node, not from the index', async () => {
    const views = {
      [h('dtx-0')]: view(0, [receipt(0), { ...receipt(0), receipt_id: h('refund'), predecessor_id: 'system', receiver_id: SENDER }], [outcome(0)]),
      [h('dtx-1')]: view(1, [receipt(1, { predecessor_id: 'system' })], [outcome(1)]), // gas refund
      [h('dtx-2')]: view(2, [receipt(2)], [outcome(2, { Failure: { ActionError: {} } })]), // failed receipt
      [h('dtx-3')]: view(3, [receipt(3, { receiver_id: 'someone-else.near' })], [outcome(3, undefined, 'someone-else.near')]), // not to this account
      [h('dtx-4')]: view(4, [receipt(4, {}, [{ FunctionCall: { method_name: 'x', args: '', gas: 1, deposit: '5' } }])], [outcome(4)]), // not a plain transfer
      [h('dtx-5')]: view(5, [receipt(5, { predecessor_id: ME })], [outcome(5)]), // from the account itself
      [h('dtx-6')]: view(6, [receipt(6, {}, [{ Transfer: { deposit: '5' } }, { Transfer: { deposit: '6' } }])], [outcome(6)]), // two transfers in one receipt
      [h('dtx-7')]: view(7, [{ ...receipt(7), receipt_id: h('other') }], [outcome(7)]), // the indexed receipt is not in the transaction
      // dtx-8: unknown to every node
    };
    const w = world({ EXPERIMENTAL_tx_status: status(views) }, {}, () => ({ transfers: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => row(k)).concat([row(0), row(9, { account_id: 'x.near' }), row(10, { asset_id: 'usdt.tether-token.near' }), row(11, { transaction_id: null })] as never), resume_token: null }));
    const d = await make().deposits(ME, null);
    expect(d.items).toEqual([
      { txid: h('dtx-0'), idx: 0, asset: 'native', amount: ONE + 7n, from: SENDER, block: TIP - 100, time: expect.any(Number) },
      { txid: h('dtx-6'), idx: 0, asset: 'native', amount: 11n, from: SENDER, block: TIP - 106, time: expect.any(Number) },
    ]);
    expect([d.cursor, d.finalizedHeight]).toEqual([TIP - 3000, TIP]);
    expect(w.calls.find((c) => c.method === 'index')!.params).toEqual({ account_id: ME, direction: 'receiver', asset_id: 'native:near', ignore_system: true, desc: true, limit: 20 });
  });
  it('a transfer that is not final yet, or that no source can check, is not reported and the cursor waits for it', async () => {
    const pendingView = { [h('dtx-0')]: view(0, [receipt(0)], [outcome(0)], 'EXECUTED_OPTIMISTIC') };
    const old = { block_height: String(TIP - 4000) }; // older than the window that is re-read anyway
    world({ EXPERIMENTAL_tx_status: status(pendingView) }, {}, () => ({ transfers: [row(0, old)], resume_token: null }));
    const a = make();
    const d = await a.deposits(ME, TIP - 5000);
    expect([d.items, d.cursor]).toEqual([[], TIP - 4001]); // just below the unverified row
    world({ EXPERIMENTAL_tx_status: status({ [h('dtx-0')]: view(0, [receipt(0)], [outcome(0)]) }) }, {}, () => ({ transfers: [row(0, old)], resume_token: null }));
    const e = await a.deposits(ME, d.cursor);
    expect(e.items.map((i) => i.txid)).toEqual([h('dtx-0')]);
    expect(e.cursor).toBe(TIP - 3000);
    world({ EXPERIMENTAL_tx_status: 'down' as never }, {}, () => ({ transfers: [row(1, old)], resume_token: null }));
    expect(await make().deposits(ME, TIP - 5000)).toMatchObject({ items: [], cursor: TIP - 4001 });
    // a recent unverified row is inside the re-read window: the cursor advances normally and the row is read again next time
    world({ EXPERIMENTAL_tx_status: status(pendingView) }, {}, () => ({ transfers: [row(0)], resume_token: null }));
    expect(await make().deposits(ME, TIP - 5000)).toMatchObject({ items: [], cursor: TIP - 3000 });
    // a row that still cannot be checked after about three days no longer holds the cursor
    world({ EXPERIMENTAL_tx_status: 'down' as never }, {}, () => ({ transfers: [row(2, { block_height: String(TIP - 430_001) })], resume_token: null }));
    expect(await make().deposits(ME, TIP - 500_000)).toMatchObject({ items: [], cursor: TIP - 3000 });
  });
  it('reads only rows above the cursor, pages through the index, and never skips when there is more than one scan can read', async () => {
    const all = Array.from({ length: 250 }, (_, k) => row(k));
    const views = Object.fromEntries(all.map((_, k) => [h(`dtx-${k}`), view(k, [receipt(k)], [outcome(k)])]));
    const page = (b: any) => { const from = Number(b.resume_token ?? 0); return { transfers: all.slice(from, from + 100), resume_token: from + 100 < all.length ? String(from + 100) : null }; };
    const w = world({ EXPERIMENTAL_tx_status: status(views) }, {}, page);
    const d = await make().deposits(ME, TIP - 500 - 120); // rows 0..119 are above the cursor
    expect(d.items).toHaveLength(120);
    expect(w.calls.filter((c) => c.method === 'index')).toHaveLength(2);
    expect(d.cursor).toBe(TIP - 620); // a cursor never moves backwards
    world({}, {}, () => ({ transfers: [], resume_token: null }));
    expect((await make().deposits(ME, TIP - 10)).cursor).toBe(TIP - 10);
    // endless index: the cursor is held
    world({ EXPERIMENTAL_tx_status: unknownTx }, {}, (b) => ({ transfers: [row(Number(b.resume_token ?? 0))], resume_token: String(Number(b.resume_token ?? 0) + 1) }));
    expect((await make().deposits(ME, 5)).cursor).toBe(5);
  });
  it('fails (to be retried) when the index or every RPC source is unreachable', async () => {
    world({}, {}, () => 'down');
    await expect(make().deposits(ME, null)).rejects.toThrow();
    world({}, { [A]: { block: 'down' }, [B]: { block: 'down' } });
    await expect(make().deposits(ME, null)).rejects.toThrow();
  });
});

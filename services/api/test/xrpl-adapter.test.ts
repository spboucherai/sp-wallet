// XRP Ledger adapter against two scripted JSON-RPC sources (no network): agreement rules, refusals, tracking and broadcast outcomes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NETWORKS, xrplTxid } from '@spw/core';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.xrpl;
const [A, B] = n.rpc as [string, string];
const FROM = 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3', TO = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const TIP = 108_249_000, HASH = 'CD'.repeat(32);
type Handler = (params: Record<string, any>, url: string) => unknown;
const err = (error: string, extra: object = {}) => ({ status: 'error', error, error_message: error, ...extra });

/** A healthy pair of sources; individual tests override methods per source. */
function world(over: Partial<Record<string, Handler>> = {}, perUrl: Record<string, Partial<Record<string, Handler | 'down'>>> = {}) {
  const accounts: Record<string, { Sequence: number; Balance: string; Flags: number; OwnerCount: number } | undefined> = {
    [FROM]: { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2 }, [TO]: { Sequence: 1, Balance: '5000000', Flags: 0, OwnerCount: 0 } };
  const base: Record<string, Handler> = {
    ledger: (p) => (p.ledger_index === 32570 ? { ledger_hash: n.chainRef, ledger: { ledger_hash: n.chainRef, ledger_index: '32570' } }
      : { ledger_hash: HASH, ledger_index: TIP, validated: true, ledger: { ledger_hash: HASH, ledger_index: String(TIP) } }),
    server_state: () => ({ state: { network_id: 0, validated_ledger: { seq: TIP, hash: HASH, base_fee: 10, reserve_base: 1_000_000, reserve_inc: 200_000 } } }),
    fee: () => ({ drops: { base_fee: '10', minimum_fee: '10', open_ledger_fee: '10' } }),
    account_info: (p) => { const a = accounts[p.account]; if (!a) return err('actNotFound');
      return p.ledger_index === 'current' ? { account_data: a, ledger_current_index: TIP + 1 } : { account_data: a, ledger_hash: HASH, ledger_index: p.ledger_index === 'validated' ? TIP : p.ledger_index, validated: true }; },
    simulate: () => ({ engine_result: 'tesSUCCESS', applied: false }),
    tx: () => err('txnNotFound', { searched_all: true }),
    submit: () => ({ engine_result: 'tesSUCCESS' }),
    account_tx: () => ({ transactions: [] }),
    ...over,
  };
  const calls: { url: string; method: string; params: Record<string, any> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: [Record<string, any>] };
    calls.push({ url, method, params: params[0] });
    const h = perUrl[url]?.[method] ?? base[method];
    if (h === 'down' || !h) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ result: h(params[0], url) }), { status: 200 });
  });
  return { accounts, calls };
}

let make: () => Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const { xrplAdapter } = await import('../src/chains/xrpl.ts');
  make = () => xrplAdapter(n);
});
afterEach(() => vi.unstubAllGlobals());
const req = { asset: 'native', from: FROM, to: TO, amount: 2_000_000n };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message: string }) => e.code ?? `error:${e.message}`);

describe('xrpl adapter: health and identity', () => {
  it('is ok only when both sources are up and carry the pinned ledger', async () => {
    world();
    expect(await make().health()).toMatchObject({ ok: true, readable: true, identityVerified: true, height: TIP });
    world({}, { [B]: { ledger: 'down' } });
    expect(await make().health()).toMatchObject({ ok: false, readable: true, identityVerified: false });
    world({}, { [B]: { ledger: (p) => (p.ledger_index === 32570 ? { ledger_hash: 'EE'.repeat(32) } : { ledger_hash: HASH, ledger_index: TIP }) } }); // another network
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world({}, { [A]: { server_state: () => ({ state: { network_id: 1, validated_ledger: {} } }) } }); // testnet id
    expect(await make().health()).toMatchObject({ ok: false, identityVerified: false });
    world({}, { [A]: { ledger: 'down' }, [B]: { ledger: 'down' } });
    expect(await make().health()).toMatchObject({ ok: false, readable: false });
  });
  it('prepare refuses when the identity cannot be verified on both sources', async () => {
    world({}, { [B]: { ledger: (p) => (p.ledger_index === 32570 ? { ledger_hash: 'EE'.repeat(32) } : { ledger_hash: HASH, ledger_index: TIP }) } });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
  });
});

describe('xrpl adapter: prepare', () => {
  it('returns sequence, LastLedgerSequence = validated + 20 and the fee, all in the intent section', async () => {
    const w = world();
    const p = await make().prepare({ ...req, memo: '42' });
    expect(p).toEqual({ section: { x: { sequence: '7', lastLedgerSequence: String(TIP + 20), fee: '12' } }, maxFee: 12n, feeEstimate: 12n, warnings: [], ttlSec: 45 });
    const sim = w.calls.find((c) => c.method === 'simulate')!.params.tx_json;
    expect(sim).toEqual({ TransactionType: 'Payment', Account: FROM, Destination: TO, Amount: '2000000', Fee: '12', Flags: 0x80000000, Sequence: 7, LastLedgerSequence: TIP + 20, DestinationTag: 42 });
    expect(w.calls.some((c) => c.method === 'submit')).toBe(false);
    // both sources were asked for the account at the same explicit ledger
    expect(w.calls.filter((c) => c.method === 'account_info' && c.params.account === FROM && c.params.ledger_index === TIP).map((c) => c.url).sort()).toEqual([A, B].sort());
  });
  it('uses the lower validated ledger when one source is a ledger behind, and the higher open-ledger fee, capped', async () => {
    world({}, { [B]: { ledger: (p) => (p.ledger_index === 32570 ? { ledger_hash: n.chainRef } : { ledger_hash: 'AA'.repeat(32), ledger_index: TIP - 1 }),
      fee: () => ({ drops: { base_fee: '10', minimum_fee: '10', open_ledger_fee: '5020' } }) } });
    const p = await make().prepare(req);
    expect(p.section).toEqual({ x: { sequence: '7', lastLedgerSequence: String(TIP - 1 + 20), fee: '6024' } });
    world({ fee: () => ({ drops: { base_fee: '10', minimum_fee: '10', open_ledger_fee: '90000000' } }) });
    expect((await make().prepare(req)).maxFee).toBe(100_000n);
  });
  it('fails closed when a source is down or the sources disagree on anything that feeds the signature', async () => {
    for (const m of ['ledger', 'account_info', 'fee', 'server_state']) { world({}, { [B]: { [m]: 'down' } }); expect(await code(make().prepare(req)), m).toBe('rpc_degraded'); }
    world({}, { [A]: { ledger: (p) => (p.ledger_index === 32570 ? { ledger_hash: n.chainRef } : { ledger_hash: HASH, ledger_index: TIP + 9 }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement'); // too far apart
    const lying = (patch: object): Handler => (p) => (p.ledger_index === 'current' ? { account_data: { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2 } }
      : { account_data: { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2, ...(p.account === FROM ? patch : {}) }, ledger_hash: HASH, ledger_index: p.ledger_index });
    for (const patch of [{ Sequence: 8 }, { Balance: '30000001' }, { Flags: 0x00100000 }, { OwnerCount: 3 }]) {
      world({}, { [B]: { account_info: lying(patch) } });
      expect(await code(make().prepare(req)), JSON.stringify(patch)).toBe('rpc_disagreement');
    }
    world({}, { [B]: { account_info: (p) => ({ account_data: { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2 }, ledger_hash: 'BB'.repeat(32), ledger_index: p.ledger_index }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement'); // same numbers, different ledger hash (fork)
    world({}, { [B]: { account_info: (p) => ({ account_data: { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2 }, ledger_hash: HASH, ledger_index: TIP - 3 }) } });
    expect(await code(make().prepare(req))).toBe('rpc_degraded'); // answered for another ledger than the one asked
    world({}, { [B]: { account_info: (p) => (p.account === TO ? err('actNotFound') : { account_data: { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2 }, ledger_hash: HASH, ledger_index: p.ledger_index }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement'); // destination exists on one source only
    world({}, { [B]: { server_state: () => ({ state: { network_id: 0, validated_ledger: { base_fee: 10, reserve_base: 10_000_000, reserve_inc: 200_000 } } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({}, { [B]: { fee: () => ({ drops: { base_fee: '11', minimum_fee: '10', open_ledger_fee: '10' } }) } });
    expect(await code(make().prepare(req))).toBe('rpc_disagreement');
    world({ simulate: () => { throw new Error('boom'); } }, { [A]: { simulate: 'down' }, [B]: { simulate: 'down' } });
    expect(await code(make().prepare(req))).toBe('rpc_degraded');
  });
  it('keeps the reserve of the source account (base + owned objects)', async () => {
    const w = world(); // balance 30 XRP, reserve 1 + 2 × 0.2 = 1.4 XRP, fee 12 drops
    expect(await code(make().prepare({ ...req, amount: 30_000_000n - 1_400_000n - 12n }))).toBe('ok');
    expect(await code(make().prepare({ ...req, amount: 30_000_000n - 1_400_000n - 11n }))).toBe('insufficient_funds');
    w.accounts[FROM] = undefined;
    expect(await code(make().prepare(req))).toBe('insufficient_funds'); // not activated
  });
  it('refuses a destination that needs a tag, blocks deposits or refuses XRP; and a new account below the reserve', async () => {
    const w = world();
    w.accounts[TO]!.Flags = 0x00020000; // lsfRequireDestTag
    expect(await code(make().prepare(req))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, memo: '0' }))).toBe('ok');
    w.accounts[TO]!.Flags = 0x01000000; // lsfDepositAuth
    expect(await code(make().prepare({ ...req, memo: '1' }))).toBe('bad_destination');
    w.accounts[TO]!.Flags = 0x00080000; // lsfDisallowXRP
    expect(await code(make().prepare(req))).toBe('bad_destination');
    w.accounts[TO] = undefined;
    expect(await code(make().prepare({ ...req, amount: 999_999n }))).toBe('below_rent');
    expect(await code(make().prepare({ ...req, amount: 1_000_000n }))).toBe('ok');
  });
  it('refuses a disabled master key, a pending transaction, bad input and a failing simulation', async () => {
    const w = world();
    w.accounts[FROM]!.Flags = 0x00100000; // lsfDisableMaster
    expect(await code(make().prepare(req))).toBe('bad_source');
    world({}, { [B]: { account_info: (p) => (p.ledger_index === 'current' ? { account_data: { Sequence: 8, Balance: '1', Flags: 0, OwnerCount: 2 } }
      : { account_data: p.account === FROM ? { Sequence: 7, Balance: '30000000', Flags: 0, OwnerCount: 2 } : { Sequence: 1, Balance: '5000000', Flags: 0, OwnerCount: 0 }, ledger_hash: HASH, ledger_index: p.ledger_index }) } });
    expect(await code(make().prepare(req))).toBe('pending_tx');
    world({ simulate: () => ({ engine_result: 'tecNO_PERMISSION', engine_result_message: 'no' }) });
    expect(await code(make().prepare(req))).toBe('simulation_failed');
    world();
    expect(await code(make().prepare({ ...req, asset: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }))).toBe('unsupported_asset');
    expect(await code(make().prepare({ ...req, memo: '4294967296' }))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, memo: '1.5' }))).toBe('bad_memo');
    expect(await code(make().prepare({ ...req, amount: 0n }))).toBe('bad_amount');
    expect(await code(make().prepare({ ...req, to: FROM }))).toBe('bad_address');
  });
});

describe('xrpl adapter: tracking', () => {
  const TXID = 'AB'.repeat(32), intent = { x: { lastLedgerSequence: String(TIP - 5) } };
  const t = (a: Adapter, i: unknown = intent) => a.track({ txid: TXID, intent: i, blockRef: null, broadcastAt: 0 });
  const found = (result: string, validated = true) => () => ({ hash: TXID, validated, ledger_index: TIP - 8, meta: { TransactionResult: result, delivered_amount: '2000000' } });
  it('finalized only for a validated tesSUCCESS; a validated failure code is failed', async () => {
    world({ tx: found('tesSUCCESS') });
    expect(await t(make())).toEqual({ state: 'finalized', confirmations: 1, blockRef: String(TIP - 8) });
    world({}, { [B]: { tx: found('tesSUCCESS') } }); // one source has it validated: enough
    expect((await t(make())).state).toBe('finalized');
    world({ tx: found('tecNO_DST_INSUF_XRP') });
    expect(await t(make())).toMatchObject({ state: 'failed', blockRef: String(TIP - 8) });
    world({ tx: found('tesSUCCESS', false) }); // seen but not in a validated ledger
    expect(await t(make())).toEqual({ state: 'confirming', confirmations: 0 });
    world({ tx: () => ({ hash: 'EF'.repeat(32), validated: true, ledger_index: 1, meta: { TransactionResult: 'tesSUCCESS' } }) }); // answer for another hash
    await expect(t(make())).rejects.toThrow(/another hash/);
  });
  it('declares expiry only when every source searched the whole window and is past LastLedgerSequence', async () => {
    const w = world();
    expect(await t(make())).toMatchObject({ state: 'failed', error: expect.stringMatching(/expired.*no funds moved/) });
    expect(w.calls.filter((c) => c.method === 'tx').every((c) => c.params.max_ledger === TIP - 5 && c.params.min_ledger === TIP - 45)).toBe(true);
    const waiting = { state: 'broadcast', confirmations: 0, rebroadcast: true };
    world({}, { [B]: { tx: () => err('txnNotFound', { searched_all: false }) } });
    expect(await t(make())).toEqual(waiting);
    world({}, { [B]: { tx: () => err('txnNotFound') } });
    expect(await t(make())).toEqual(waiting);
    world({}, { [B]: { tx: 'down' } });
    expect(await t(make())).toEqual(waiting);
    world({}, { [B]: { ledger: 'down' } });
    expect(await t(make())).toEqual(waiting);
    world();
    expect(await t(make(), { x: { lastLedgerSequence: String(TIP) } })).toEqual(waiting); // LastLedgerSequence = tip: not past it yet
    expect(await t(make(), { x: { lastLedgerSequence: String(TIP + 10) } })).toEqual(waiting);
    expect(await t(make(), {})).toEqual(waiting); // no window known: never declared dead
  });
});

describe('xrpl adapter: broadcast, balances, deposits', () => {
  const RAW = '1200002280000000';
  it('accepts applied / queued / already-known; a rejection on every source is an error', async () => {
    for (const r of ['tesSUCCESS', 'terQUEUED', 'tefALREADY', 'tecUNFUNDED_PAYMENT']) { world({ submit: () => ({ engine_result: r }) }); await expect(make().broadcast(RAW), r).resolves.toBeUndefined(); }
    world({ submit: () => ({ engine_result: 'temBAD_SIGNATURE' }) }, { [B]: { submit: () => ({ engine_result: 'tesSUCCESS' }) } });
    await expect(make().broadcast(RAW)).resolves.toBeUndefined();
    for (const r of ['temBAD_SIGNATURE', 'tefPAST_SEQ', 'tefMAX_LEDGER', 'terPRE_SEQ', 'telINSUF_FEE_P', '']) { world({ submit: () => ({ engine_result: r, engine_result_message: 'm' }) }); await expect(make().broadcast(RAW), r).rejects.toThrow(); }
    world({ submit: () => err('invalidTransaction') });
    await expect(make().broadcast(RAW)).rejects.toThrow();
    world({}, { [A]: { submit: 'down' }, [B]: { submit: 'down' } });
    await expect(make().broadcast(RAW)).rejects.toThrow();
    // "sequence already used" is success only if this very transaction is on the ledger
    const w = world({ submit: () => ({ engine_result: 'tefPAST_SEQ' }), tx: (p) => (p.transaction === xrplTxid(RAW) ? { hash: xrplTxid(RAW), validated: true } : err('txnNotFound')) });
    await expect(make().broadcast(RAW)).resolves.toBeUndefined();
    expect(w.calls.find((c) => c.method === 'submit')!.params).toEqual({ tx_blob: RAW });
  });
  it('reads balances (0 for an account that does not exist) with failover', async () => {
    const w = world({}, { [A]: { account_info: 'down' } });
    expect(await make().balances(FROM)).toEqual({ native: 30_000_000n });
    w.accounts[FROM] = undefined;
    expect(await make().balances(FROM)).toEqual({ native: 0n });
  });
  it('lists validated incoming XRP payments only, by delivered_amount', async () => {
    const pay = (hash: string, over: object = {}, meta: object = {}, validated = true) => ({ validated, tx: { TransactionType: 'Payment', Account: TO, Destination: FROM, Amount: '9000000', hash, ledger_index: TIP - 3, date: 847_000_000, ...over },
      meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1500000', ...meta } });
    const H = (c: string) => c.repeat(64);
    const w = world({ account_tx: () => ({ transactions: [
      pay(H('1')), // good: amount is what was delivered, not the Amount field
      pay(H('2'), {}, { delivered_amount: { currency: 'USD', issuer: TO, value: '5' } }), // issued currency
      pay(H('3'), {}, { TransactionResult: 'tecPATH_DRY' }), // failed
      pay(H('4'), { Account: FROM, Destination: TO }), // outgoing
      pay(H('5'), { TransactionType: 'OfferCreate' }),
      pay(H('6'), {}, {}, false), // not validated
      pay(H('7'), {}, { delivered_amount: 'unavailable' }),
      pay(H('8'), { Destination: TO, Account: 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn' }), // between third parties
      { validated: true, hash: H('9'), ledger_index: TIP - 2, tx_json: { TransactionType: 'Payment', Account: TO, Destination: FROM, date: 847_000_001 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '7' } }, // API v2 shape
    ] }) });
    const d = await make().deposits(FROM, null);
    expect(d).toEqual({ cursor: TIP, finalizedHeight: TIP, items: [
      { txid: H('1'), idx: 0, asset: 'native', amount: 1_500_000n, from: TO, block: TIP - 3, time: 847_000_000 + 946_684_800 },
      { txid: H('9'), idx: 0, asset: 'native', amount: 7n, from: TO, block: TIP - 2, time: 847_000_001 + 946_684_800 }] });
    expect(w.calls.find((c) => c.method === 'account_tx')!.params).toMatchObject({ account: FROM, ledger_index_min: -1, ledger_index_max: TIP, forward: false });
    await make().deposits(FROM, TIP - 100);
    expect(w.calls.filter((c) => c.method === 'account_tx').at(-1)!.params).toMatchObject({ ledger_index_min: TIP - 99, ledger_index_max: TIP, forward: true });
    expect(await make().deposits(FROM, TIP)).toEqual({ items: [], cursor: TIP, finalizedHeight: TIP });
    world({ account_tx: () => err('actNotFound') });
    expect(await make().deposits(FROM, null)).toEqual({ items: [], cursor: TIP, finalizedHeight: TIP });
  });
});

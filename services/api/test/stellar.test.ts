// Stellar adapter against two scripted Horizon instances (no network): agreement rules, fail-closed paths, tracking and deposits.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NETWORKS, pluginFor, type Intent } from '@spw/core';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import type { Adapter } from '../src/chains/rpc.ts';

const n = NETWORKS.stellar, [A, B] = n.rpc as [string, string];
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ME = keys.addresses.stellar!, DEST = 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV', NEW = 'GBFPWBTN4AXHPWPTQVQBP4KRZ2YVYYOGRMV2PEYL2OBPPJDP7LECEVHR';
const NOW = 1_800_000_000;

interface Fake {
  down: boolean; passphrase: string; ledger: number; closedAt: number; baseReserve: number; p90: string;
  accounts: Record<string, any>; txs: Record<string, any>; payments: any[]; submit: (tx: string) => { status: number; body: any }; posts: string[]; raw404: boolean; seen: string[];
}
const acct = (id: string, over: Record<string, unknown> = {}) => ({ sequence: '1000', subentry_count: 0, num_sponsoring: 0, num_sponsored: 0, thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  signers: [{ key: id, weight: 1, type: 'ed25519_public_key' }], balances: [{ asset_type: 'credit_alphanum4', balance: '9.0000000' }, { asset_type: 'native', balance: '100.0000000', selling_liabilities: '0.0000000' }], data: {}, ...over });
const fresh = (): Fake => ({ down: false, passphrase: n.chainRef, ledger: 5000, closedAt: NOW - 3, baseReserve: 5_000_000, p90: '100', accounts: { [ME]: acct(ME), [DEST]: acct(DEST) }, txs: {}, payments: [],
  submit: () => ({ status: 201, body: { tx_status: 'PENDING' } }), posts: [], raw404: false, seen: [] });
let h: Record<string, Fake>;
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000', '');
const notFound = { type: 'https://stellar.org/horizon-errors/not_found', title: 'Resource Missing', status: 404 };

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input)), f = h[url.origin]!;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (!f || f.down) throw new TypeError('fetch failed');
  f.seen.push(url.pathname + url.search);
  const miss = () => (f.raw404 ? new Response('<html>not here</html>', { status: 404 }) : json(404, notFound));
  if (init?.method === 'POST') {
    const tx = new URLSearchParams(String(init.body)).get('tx')!;
    f.posts.push(tx);
    const r = f.submit(tx);
    return json(r.status, r.body);
  }
  const p = url.pathname;
  if (p === '/') return json(200, { network_passphrase: f.passphrase, history_latest_ledger: f.ledger, history_latest_ledger_closed_at: iso(f.closedAt), core_latest_ledger: f.ledger });
  if (p === '/ledgers') return json(200, { _embedded: { records: [{ sequence: f.ledger, closed_at: iso(f.closedAt), base_fee_in_stroops: 100, base_reserve_in_stroops: f.baseReserve }] } });
  if (p === '/fee_stats') return json(200, { last_ledger_base_fee: '100', fee_charged: { p90: f.p90 } });
  let m = /^\/accounts\/([A-Z0-9]+)$/.exec(p);
  if (m) return f.accounts[m[1]!] ? json(200, f.accounts[m[1]!]) : miss();
  m = /^\/transactions\/([0-9a-f]{64})$/.exec(p);
  if (m) return f.txs[m[1]!] ? json(200, f.txs[m[1]!]) : miss();
  if (/^\/accounts\/[A-Z0-9]+\/payments$/.test(p)) {
    const cur = url.searchParams.get('cursor');
    const recs = f.payments.filter((o) => !cur || BigInt(o.id) > BigInt(cur));
    return json(200, { _embedded: { records: url.searchParams.get('order') === 'desc' ? [...recs].reverse() : recs } });
  }
  return json(500, {});
}

let a: Adapter;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  vi.stubGlobal('fetch', fakeFetch);
  a = (await import('../src/chains/stellar.ts')).stellarAdapter(n);
});
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => { h = { [A]: fresh(), [B]: fresh() }; });

const prep = (over: Partial<{ to: string; amount: bigint; memo: string; asset: string }> = {}) => a.prepare({ asset: 'native', from: ME, to: DEST, amount: 10_000_000n, ...over });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? `threw: ${(e as Error).message}`; } return 'ok'; };

describe('stellar adapter: prepare', () => {
  it('agrees on both sources and returns the exact intent section', async () => {
    h[B]!.ledger = 5001; h[B]!.p90 = '5056'; // one ledger apart, different fee statistics: still fine
    const r = await prep();
    expect(r.section).toEqual({ x: { op: 'payment', sequence: '1001', fee: '10112', maxTime: String(NOW + 180), memoType: 'none' } });
    expect([r.maxFee, r.feeEstimate, r.ttlSec, r.warnings]).toEqual([10_112n, 10_112n, 120, []]);
    // the prepared section builds with the signer's plugin
    const intent: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'stellar', chainRef: n.chainRef, asset: 'native', symbol: 'XLM', decimals: 7, amount: '10000000',
      from: ME, to: DEST, maxFee: r.maxFee.toString(), createdAt: NOW, expiresAt: NOW + r.ttlSec, policyVersion: 3, ...(r.section as { x: Record<string, string> }) };
    expect(() => pluginFor(n).build(intent, n)).not.toThrow();
  });
  it('chooses CreateAccount only when both sources say the destination does not exist', async () => {
    const r = await prep({ to: NEW, amount: 10_000_000n, memo: '77' });
    expect((r.section as any).x).toMatchObject({ op: 'createAccount', memoType: 'id' });
    expect(r.warnings).toEqual(['memo_numeric_id', 'creates_account']);
    expect(await code(prep({ to: NEW, amount: 9_999_999n }))).toBe('below_reserve');
    h[B]!.accounts[NEW] = acct(NEW);
    expect(await code(prep({ to: NEW }))).toBe('rpc_disagreement');
  });
  it('fee bid is floored and capped', async () => {
    expect((await prep()).maxFee).toBe(1_000n);
    h[A]!.p90 = '250000';
    const r = await prep();
    expect([r.maxFee, r.warnings]).toEqual([200_000n, ['network_congested']]);
  });
  it('fails closed when a source is down, lies about identity, answers oddly or disagrees', async () => {
    h[B]!.down = true; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), passphrase: 'Test SDF Network ; September 2015' }; expect(await code(prep())).toBe('rpc_degraded');
    h[B] = { ...fresh(), raw404: true }; expect(await code(prep({ to: NEW }))).toBe('rpc_degraded'); // a 404 that is not Horizon's is not "account missing"
    h[B] = fresh(); h[B]!.accounts[ME] = acct(ME, { sequence: '1001' }); expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.accounts[ME].balances[1].balance = '99.9999999'; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.baseReserve = 10_000_000; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.ledger = 5007; expect(await code(prep())).toBe('rpc_disagreement');
    h[B] = fresh(); h[B]!.closedAt = NOW - 61; expect(await code(prep())).toBe('rpc_degraded'); // stale source or wrong local clock
    h[B] = fresh(); h[A]!.closedAt = NOW + 61; h[B]!.closedAt = NOW + 61; expect(await code(prep())).toBe('rpc_degraded');
    h[A] = fresh(); h[B] = fresh(); h[A]!.accounts[ME].sequence = '12x'; expect(await code(prep())).toBe('rpc_degraded');
    h[A] = fresh(); expect(await code(prep())).toBe('ok');
  });
  it('checks the spendable balance after the reserve, liabilities and fee', async () => {
    const set = (over: Record<string, unknown>, native: Record<string, string>) => { for (const u of [A, B]) h[u]!.accounts[ME] = acct(ME, { ...over, balances: [{ asset_type: 'native', selling_liabilities: '0.0000000', ...native }] }); };
    // reserve = (2 + 3 subentries + 2 sponsoring - 1 sponsored) × 0.5 = 3 XLM; fee 0.0001
    set({ subentry_count: 3, num_sponsoring: 2, num_sponsored: 1 }, { balance: '4.0001000' });
    expect(await code(prep({ amount: 10_000_000n }))).toBe('ok');
    expect(await code(prep({ amount: 10_000_001n }))).toBe('insufficient_funds');
    set({}, { balance: '2.0001000', selling_liabilities: '0.0000001' });
    expect(await code(prep({ amount: 10_000_000n }))).toBe('insufficient_funds');
    for (const u of [A, B]) delete h[u]!.accounts[ME];
    expect(await code(prep())).toBe('insufficient_funds'); // source account not activated
  });
  it('refuses multi-signature sources, missing required memos, bad memos, tokens and bad addresses', async () => {
    for (const u of [A, B]) h[u]!.accounts[ME] = acct(ME, { thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 } });
    expect(await code(prep())).toBe('unsupported_account');
    for (const u of [A, B]) h[u]!.accounts[ME] = acct(ME, { signers: [{ key: ME, weight: 0 }, { key: DEST, weight: 1 }] });
    expect(await code(prep())).toBe('unsupported_account');
    for (const u of [A, B]) { h[u]!.accounts[ME] = acct(ME); h[u]!.accounts[DEST] = acct(DEST, { data: { 'config.memo_required': 'MQ==' } }); }
    expect(await code(prep())).toBe('memo_required');
    expect(await code(prep({ memo: '12345' }))).toBe('ok');
    expect(await code(prep({ memo: 'x'.repeat(29) }))).toBe('bad_memo');
    expect(await code(prep({ asset: 'USDC' }))).toBe('unsupported_asset');
    expect(await code(prep({ to: ME }))).toBe('bad_address');
    expect(await code(prep({ to: DEST.toLowerCase() }))).toBe('bad_address');
    expect(await code(prep({ amount: 0n }))).toBe('bad_amount');
  });
});

describe('stellar adapter: track', () => {
  const txid = 'ab'.repeat(32), maxTime = NOW + 100;
  const track = () => a.track({ txid, intent: { x: { maxTime: String(maxTime) } }, blockRef: null, broadcastAt: NOW });
  const rec = (successful: boolean, ledger = 4999) => ({ hash: txid, successful, ledger });
  it('finalized only when every reachable source shows a successful inclusion', async () => {
    h[A]!.txs[txid] = rec(true);
    expect(await track()).toEqual({ state: 'confirming', confirmations: 1, blockRef: '4999' }); // the other source has not ingested it yet
    h[B]!.txs[txid] = rec(true);
    expect(await track()).toEqual({ state: 'finalized', confirmations: 2, blockRef: '4999' });
    h[B]!.down = true;
    expect((await track()).state).toBe('finalized');
    h[B] = fresh(); h[B]!.txs[txid] = rec(true, 4998);
    await expect(track()).rejects.toThrow(/disagree/);
    h[B]!.txs[txid] = { ...rec(true), hash: 'cd'.repeat(32) };
    await expect(track()).rejects.toThrow(/bad transaction record/);
  });
  it('an on-chain failure is reported only when both sources agree', async () => {
    h[A]!.txs[txid] = rec(false); h[B]!.txs[txid] = rec(false);
    expect(await track()).toMatchObject({ state: 'failed', blockRef: '4999' });
    h[B]!.down = true;
    expect((await track()).state).toBe('confirming');
    h[B] = fresh(); h[B]!.txs[txid] = rec(true);
    await expect(track()).rejects.toThrow(/disagree/);
  });
  it('a hash alone is never success; expiry needs both sources past the time bound', async () => {
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: true });
    for (const u of [A, B]) h[u]!.closedAt = maxTime + 20; // exactly at the margin: not yet
    vi.setSystemTime((maxTime + 25) * 1000);
    expect(await track()).toEqual({ state: 'broadcast', confirmations: 0, rebroadcast: false });
    h[A]!.closedAt = maxTime + 21;
    expect((await track()).state).toBe('broadcast'); // one source has not closed a late-enough ledger
    h[B]!.closedAt = maxTime + 21;
    expect(await track()).toMatchObject({ state: 'failed', confirmations: 0 });
    h[B]!.down = true;
    expect((await track()).state).toBe('broadcast'); // never "failed" on a single source
    h[B] = fresh(); h[B]!.closedAt = maxTime + 30; h[B]!.txs[txid] = rec(true);
    expect((await track()).state).toBe('confirming'); // late-ingesting source: included after all
    // every source reads its ledger position before looking the transaction up
    for (const u of [A, B]) expect(h[u]!.seen.slice(-2)).toEqual(['/', `/transactions/${txid}`]);
    vi.setSystemTime(NOW * 1000);
    await expect(a.track({ txid, intent: { evm: {} }, blockRef: null, broadcastAt: NOW })).rejects.toThrow(/time bound/);
  });
});

describe('stellar adapter: broadcast', () => {
  const intent: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: keys.keyId, network: 'stellar', chainRef: n.chainRef, asset: 'native', symbol: 'XLM', decimals: 7, amount: '10000000',
    from: ME, to: DEST, maxFee: '1000', createdAt: NOW, expiresAt: NOW + 120, policyVersion: 3, x: { op: 'payment', sequence: '1001', fee: '1000', maxTime: String(NOW + 180), memoType: 'none' } };
  const signed = pluginFor(n).sign(intent, n, keys.handle(n));
  const badSeq = { status: 400, body: { tx_status: 'ERROR', hash: signed.txid, errorResultXdr: 'AAAAAAAAAGT////7AAAAAA==' } }; // txBAD_SEQ
  it('sends the exact envelope to every source; pending or duplicate is accepted', async () => {
    h[A]!.submit = () => ({ status: 201, body: { tx_status: 'PENDING', hash: signed.txid } });
    h[B]!.submit = () => ({ status: 409, body: { tx_status: 'DUPLICATE', hash: signed.txid } });
    await a.broadcast(signed.raw);
    expect([h[A]!.posts, h[B]!.posts]).toEqual([[signed.raw], [signed.raw]]);
    h[A]!.down = true;
    await a.broadcast(signed.raw);
  });
  it('a refusal is an error unless the ledger already contains the transaction', async () => {
    for (const u of [A, B]) h[u]!.submit = () => badSeq;
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/tx_bad_seq/);
    h[B]!.txs[signed.txid] = { hash: signed.txid, successful: true, ledger: 4999 };
    await a.broadcast(signed.raw); // already known
    h[B]!.txs = {};
    for (const u of [A, B]) h[u]!.submit = () => ({ status: 503, body: { tx_status: 'TRY_AGAIN_LATER', hash: signed.txid } });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/busy/);
    for (const u of [A, B]) h[u]!.submit = () => ({ status: 201, body: { tx_status: 'PENDING', hash: 'cd'.repeat(32) } });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/another transaction/);
    for (const u of [A, B]) h[u]!.submit = () => ({ status: 400, body: { title: 'Transaction Malformed', status: 400 } });
    await expect(a.broadcast(signed.raw)).rejects.toThrow(/Malformed/);
    await expect(a.broadcast('AAAA')).rejects.toThrow(/envelope/);
  });
});

describe('stellar adapter: balances, deposits, health', () => {
  const op = (ledger: number, txOrder: number, idx: number, o: Record<string, unknown>) => { const id = ((BigInt(ledger) << 32n) | (BigInt(txOrder) << 12n) | BigInt(idx)).toString();
    return { id, paging_token: id, transaction_successful: true, transaction_hash: id.padStart(64, '0'), created_at: iso(NOW - 100), ...o }; };
  it('lists incoming native payments and account creations only', async () => {
    const pay = { type: 'payment', asset_type: 'native', from: DEST, to: ME, amount: '1.5000000' };
    h[A]!.payments = [
      op(4000, 1, 0, { type: 'create_account', funder: DEST, account: ME, starting_balance: '2.0000000' }),
      op(4500, 1, 0, pay), op(4500, 1, 3, { ...pay, amount: '0.0000001' }),
      op(4600, 2, 0, { ...pay, asset_type: 'credit_alphanum4', asset_code: 'USDC' }), // not XLM
      op(4700, 1, 0, { ...pay, from: ME, to: DEST }), // outgoing
      op(4800, 1, 0, { ...pay, transaction_successful: false }),
      op(4900, 1, 0, { type: 'create_account', funder: ME, account: DEST, starting_balance: '2.0000000' }), // we created someone else
      op(4950, 7, 1, { type: 'path_payment_strict_send', asset_type: 'native', from: DEST, to: ME, amount: '3.0000000' }),
      op(4990, 1, 0, { ...pay, amount: '7.0000000' }),
    ];
    const first = await a.deposits(ME, null);
    expect(first.items.map((d) => [d.block, d.idx, d.amount, d.from, d.asset])).toEqual([[4990, 0, 70_000_000n, DEST, 'native'], [4500, 3, 1n, DEST, 'native'], [4500, 0, 15_000_000n, DEST, 'native'], [4000, 0, 20_000_000n, DEST, 'native']]);
    expect([first.cursor, first.finalizedHeight, first.items[0]!.time]).toEqual([4998, 5000, NOW - 100]);
    const next = await a.deposits(ME, 4500);
    expect(next.items.map((d) => d.block)).toEqual([4990]);
    expect(h[A]!.seen.at(-1)).toContain(`cursor=${(4501n << 32n).toString()}`);
    h[A]!.down = true; // failover; an account that does not exist yet has no history
    expect(await a.deposits(NEW, 4998)).toEqual({ items: [], cursor: 4998, finalizedHeight: 5000 });
  });
  it('balances and health', async () => {
    expect(await a.balances(ME)).toEqual({ native: 1_000_000_000n });
    expect(await a.balances(NEW)).toEqual({ native: 0n });
    expect(await a.health()).toMatchObject({ ok: true, readable: true, identityVerified: true, height: 5000 });
    h[B]!.passphrase = 'Test SDF Network ; September 2015';
    expect((await a.health()).endpoints.map((e) => e.ok)).toEqual([true, false]);
    h[B] = fresh(); h[B]!.closedAt = NOW - 301;
    expect((await a.health()).ok).toBe(false);
    h[A]!.down = true; h[B]!.down = true;
    expect(await a.health()).toMatchObject({ ok: false, readable: false });
  });
});

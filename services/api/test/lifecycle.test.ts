// NEXT — transfer life cycle v2 (audit T1–T7). What is tested here is what the worker DECIDES from what the chain says:
// a scripted adapter stands for the network, a scripted JSON-RPC stands for the endpoints. Nothing is relayed anywhere.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canTransition, isTerminal, legacyState, lifecycleOf, NETWORKS, STATES, type NetworkDef } from '@spw/core';
import { useTestDatabase } from './test-db.ts';
import type { Adapter, Tracked } from '../src/chains/rpc.ts';

let sql: any, worker: typeof import('../src/worker.ts'), tr: typeof import('../src/transfers.ts'), chains: typeof import('../src/chains/index.ts'),
  evm: typeof import('../src/chains/evm.ts'), sol: typeof import('../src/chains/sol.ts'), btc: typeof import('../src/chains/btc.ts');
const realFetch = globalThis.fetch;
const saved: Record<string, Adapter> = {};

/** A network whose answers the test writes. */
class Net {
  next: Tracked | Error = { state: 'broadcast', confirmations: 0, seen: false, rebroadcast: true };
  relay: 'ok' | Error = 'ok'; relays = 0; tracks = 0;
  adapter(): Adapter {
    return { broadcast: async () => { this.relays += 1; if (this.relay !== 'ok') throw this.relay; },
      track: async () => { this.tracks += 1; if (this.next instanceof Error) throw this.next; return this.next; },
      utxos: async () => this.coins, health: async () => { throw new Error('unused'); }, balances: async () => ({}), prepare: async () => { throw new Error('unused'); },
      deposits: async () => ({ items: [], cursor: 0, finalizedHeight: 0 }) } as Adapter;
  }
  coins: { txid: string; vout: number; value: number; confirmed: boolean }[] = [];
}
let net: Net;
const use = (network: string) => { saved[network] ??= chains.adapters[network]!; chains.adapters[network] = net.adapter(); };

let seq = 0;
const TX = (k: number) => '0x' + k.toString(16).padStart(64, '0');
async function row(o: Record<string, unknown> = {}): Promise<any> {
  const id = `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;
  const base = { id, idempotency_key: 'k-' + id, state: 'signed', network: 'base', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1000', from_addr: '0xfrom', to_addr: '0xto',
    raw: '0xraw', txid: TX(seq), intent: sql.json({ from: '0xfrom', evm: { nonce: 7 } }), expires_at: new Date(Date.now() + 120_000), ...o };
  const [r] = await sql`insert into proposals ${sql(base)} returning *`;
  return r;
}
const get = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
const late = new Date(Date.now() - 11 * 60_000), ago = (min: number) => new Date(Date.now() - min * 60_000);

beforeAll(async () => {
  await useTestDatabase('lifecycle', { SPW_BROADCAST: 'on' });
  const db = await import('../src/db.ts'); sql = db.sql;
  await db.migrate();
  chains = await import('../src/chains/index.ts'); tr = await import('../src/transfers.ts'); worker = await import('../src/worker.ts');
  evm = await import('../src/chains/evm.ts'); sol = await import('../src/chains/sol.ts'); btc = await import('../src/chains/btc.ts');
});
afterAll(async () => { globalThis.fetch = realFetch; for (const [k, a] of Object.entries(saved)) chains.adapters[k] = a; await sql?.end(); });
beforeEach(async () => { await sql`delete from proposals`; net = new Net(); use('base'); });
afterEach(() => { globalThis.fetch = realFetch; });

describe('the state machine', () => {
  it('dropped is watched, not final; replaced can be corrected; nothing leads back to a draft', () => {
    expect(STATES).toContain('dropped');
    expect(isTerminal('dropped')).toBe(false);
    for (const to of ['confirming', 'finalized', 'failed', 'replaced'] as const) expect(canTransition('dropped', to), to).toBe(true);
    expect(canTransition('dropped', 'broadcast')).toBe(false); // a mempool sighting does not take the network's slot back
    expect(canTransition('replaced', 'finalized')).toBe(true);
    expect(canTransition('replaced', 'failed')).toBe(false);
    expect(canTransition('reorged', 'replaced')).toBe(true); // audit T5
    for (const s of STATES) expect(canTransition(s, 'draft'), s).toBe(false);
  });
  it('one vocabulary for clients; shipped clients keep the states they know', () => {
    expect(lifecycleOf('signed')).toBe('signed');
    expect(lifecycleOf('signed', { relayAttempted: true })).toBe('broadcasting');
    expect(lifecycleOf('broadcast')).toBe('pending');
    expect(lifecycleOf('reorged')).toBe('confirming');
    expect(lifecycleOf('confirming')).toBe('confirming');
    expect(lifecycleOf('finalized')).toBe('confirmed'); // said only of a final transaction
    expect(lifecycleOf('failed', { errorCode: 'expired_onchain' })).toBe('expired');
    expect(lifecycleOf('failed', { errorCode: 'tx_failed' })).toBe('failed');
    expect(lifecycleOf('not_broadcast')).toBe('not_sent');
    expect(legacyState('dropped')).toBe('failed');
    for (const s of STATES) if (s !== 'dropped') expect(legacyState(s)).toBe(s);
  });
});

describe('T1 — a relay whose answer was lost is never called a failure', () => {
  it('the relay errors but the network has the transaction: the row is `broadcast`, and the relay marker was written first', async () => {
    const p = await row();
    net.relay = new Error('nonce too low'); net.next = { state: 'confirming', confirmations: 1, blockRef: '0xb', seen: true };
    const q = await tr.broadcastNow(p);
    expect(q.state).toBe('broadcast');
    expect(q.relay_attempted_at).toBeInstanceOf(Date);
    expect(tr.view(q).lifecycle).toBe('pending');
  });
  it('the relay errors and nobody knows the transaction: it stays `signed` (shown as broadcasting) and is tried again', async () => {
    const p = await row();
    net.relay = new Error('rpc http 503');
    const q = await tr.broadcastNow(p);
    expect(q.state).toBe('signed'); expect(q.error_code).toBe('broadcast_attempt_failed');
    expect(tr.view(q).lifecycle).toBe('broadcasting');
    net.relay = 'ok';
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('broadcast');
    expect(net.relays).toBe(2);
  });
  it('window long gone, a relay had started, the chain has it: it is tracked — never "nothing was sent"', async () => {
    const p = await row({ expires_at: late, relay_attempted_at: ago(12) });
    net.next = { state: 'finalized', confirmations: 40, blockRef: '0xb', seen: true, feePaid: 21000n };
    await worker.reconcile();
    const q = await get(p.id);
    expect(q.state).toBe('finalized'); expect(q.fee_paid).toBe('21000'); expect(q.finalized_at).toBeInstanceOf(Date);
    expect(net.relays).toBe(0); // and it was not relayed again after its window
  });
  it('window long gone, a relay had started, every source says unknown: `dropped` — watched, slot freed, old clients read "failed" with the code', async () => {
    const p = await row({ expires_at: late, relay_attempted_at: ago(12) });
    await worker.reconcile();
    const q = await get(p.id), v = tr.view(q);
    expect(q.state).toBe('dropped'); expect(q.error_code).toBe('relay_unconfirmed');
    expect(v.state).toBe('failed'); expect(v.lifecycle).toBe('dropped'); expect(v.watched).toBe(true); expect(v.execution.state).toBe('unknown');
    await row({ state: 'approved' }); // the network is free again
    net.next = { state: 'confirming', confirmations: 2, blockRef: '0xb', seen: true }; // …and it is still watched: it appears after all
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('confirming');
  });
  it('window long gone, a source does not answer: nothing is decided', async () => {
    const p = await row({ expires_at: late, relay_attempted_at: ago(12) });
    net.next = { state: 'broadcast', confirmations: 0, seen: undefined };
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('signed');
    net.next = new Error('no endpoint answered');
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('signed');
  });
  it('window long gone and no relay ever started: "nothing was sent" is a fact', async () => {
    const p = await row({ expires_at: late });
    await worker.reconcile();
    const q = await get(p.id);
    expect(q.state).toBe('failed'); expect(q.error_code).toBe('not_broadcast_in_time'); expect(net.tracks).toBe(0);
  });
});

describe('T2 / T3 — a negative verdict must be repeated', () => {
  const sent = () => row({ state: 'broadcast', broadcast_at: ago(5), relay_attempted_at: ago(5), last_broadcast_at: new Date() });
  it('replaced: not on the first pass, not within the hold time, then yes — and a contrary pass starts the count again', async () => {
    const p = await sent();
    net.next = { state: 'replaced', confirmations: 0, seen: false, error: 'nonce was consumed by another transaction' };
    for (let k = 0; k < worker.NEG_PASSES + 2; k++) await worker.reconcile();
    let q = await get(p.id);
    expect(q.state).toBe('broadcast'); expect(q.neg_streak).toBe(worker.NEG_PASSES + 2); // repeated, but not for long enough
    net.next = { state: 'broadcast', confirmations: 0, seen: true };
    await worker.reconcile();
    q = await get(p.id);
    expect(q.neg_streak).toBe(0); expect(q.neg_verdict).toBeNull();
    net.next = { state: 'replaced', confirmations: 0, seen: false, error: 'nonce was consumed by another transaction' };
    await worker.reconcile(); await worker.reconcile();
    await sql`update proposals set neg_since = ${ago(2)} where id = ${p.id}`;
    await worker.reconcile();
    q = await get(p.id);
    expect(q.state).toBe('replaced'); expect(q.error_code).toBe('replaced_onchain');
  });
  it('a `replaced` verdict that was wrong is corrected when the transaction turns out to be in a block', async () => {
    const p = await row({ state: 'replaced', broadcast_at: ago(5), relay_attempted_at: ago(5) });
    net.next = { state: 'broadcast', confirmations: 0, seen: false };
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('replaced');
    net.next = { state: 'finalized', confirmations: 12, blockRef: '0xb', seen: true };
    await worker.reconcile();
    const q = await get(p.id);
    expect(q.state).toBe('finalized'); expect(q.error).toBeNull(); expect(q.error_code).toBeNull();
  });
  it('validity window closed on-chain: `failed` with its own code, shown as expired', async () => {
    const p = await sent();
    net.next = { state: 'failed', confirmations: 0, seen: false, expired: true, error: 'expired before inclusion (blockhash too old); no funds moved' };
    await worker.reconcile(); await worker.reconcile();
    await sql`update proposals set neg_since = ${ago(2)} where id = ${p.id}`;
    await worker.reconcile();
    const q = await get(p.id);
    expect(q.state).toBe('failed'); expect(q.error_code).toBe('expired_onchain'); expect(tr.view(q).lifecycle).toBe('expired');
  });
  it('a revert in a block is a fact: applied at once, with the fee it cost', async () => {
    const p = await sent();
    net.next = { state: 'failed', confirmations: 0, blockRef: '0xb', seen: true, error: 'transaction reverted on-chain', feePaid: 5n };
    await worker.reconcile();
    const q = await get(p.id);
    expect(q.state).toBe('failed'); expect(q.error_code).toBe('tx_failed'); expect(q.fee_paid).toBe('5');
  });
});

describe('T4 / T5 — dropped, and the way back', () => {
  it('unknown to every source: first noted, dropped only after the delay; a sighting in between resets it', async () => {
    const p = await row({ state: 'broadcast', broadcast_at: ago(50), relay_attempted_at: ago(50), last_broadcast_at: new Date() });
    await worker.reconcile();
    let q = await get(p.id);
    expect(q.state).toBe('broadcast'); expect(q.unseen_since).toBeInstanceOf(Date);
    net.next = { state: 'broadcast', confirmations: 0, seen: true };
    await worker.reconcile();
    expect((await get(p.id)).unseen_since).toBeNull();
    net.next = { state: 'broadcast', confirmations: 0, seen: false, rebroadcast: true };
    await worker.reconcile();
    await sql`update proposals set unseen_since = ${ago(31)} where id = ${p.id}`;
    await worker.reconcile();
    q = await get(p.id);
    expect(q.state).toBe('dropped'); expect(q.error_code).toBe('dropped');
  });
  it('a source that cannot tell (`seen` undefined) never leads to dropped', async () => {
    const p = await row({ state: 'broadcast', broadcast_at: ago(50), relay_attempted_at: ago(50), unseen_since: ago(40), last_broadcast_at: new Date() });
    net.next = { state: 'broadcast', confirmations: 0, seen: undefined };
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('broadcast');
  });
  it('a dropped row is not relayed again and ignores a mempool sighting; a block moves it', async () => {
    const p = await row({ state: 'dropped', broadcast_at: ago(50), relay_attempted_at: ago(50) });
    net.next = { state: 'broadcast', confirmations: 0, seen: true, rebroadcast: true };
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('dropped'); expect(net.relays).toBe(0);
    net.next = { state: 'finalized', confirmations: 9, blockRef: '0xb', seen: true };
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('finalized');
  });
  it('Bitcoin-style: a dropped transfer whose coin is gone from the agreed coin set is replaced (after repetition)', async () => {
    use('bitcoin');
    const coin = 'ab'.repeat(32);
    const p = await row({ state: 'dropped', network: 'bitcoin', symbol: 'BTC', decimals: 8, broadcast_at: ago(500), relay_attempted_at: ago(500),
      intent: sql.json({ from: 'bc1', btc: { inputs: [{ txid: coin, vout: 0, value: '5000' }], change: '0', fee: '300' } }) });
    net.coins = [{ txid: coin, vout: 0, value: 5000, confirmed: true }];
    net.next = { state: 'broadcast', confirmations: 0, seen: false };
    await worker.reconcile();
    expect((await get(p.id)).neg_streak).toBe(0); // its coin is still there: nothing to conclude
    net.coins = [];
    await worker.reconcile(); await worker.reconcile();
    await sql`update proposals set neg_since = ${ago(2)} where id = ${p.id}`;
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('replaced');
  });
  it('an adapter that only says "pending" about a confirmed transaction: reorged, not an exception on every pass (audit T3)', async () => {
    const p = await row({ state: 'confirming', block_ref: '0xb', broadcast_at: ago(2), relay_attempted_at: ago(2), last_broadcast_at: new Date() });
    net.next = { state: 'broadcast', confirmations: 0, rebroadcast: true };
    await worker.reconcile();
    expect((await get(p.id)).state).toBe('reorged');
  });
});

describe('T6 / T7 / T8 — one in flight, duplicates, what is recorded', () => {
  it('the database refuses a second transaction in flight on a network, as `pending_tx`', async () => {
    await row({ state: 'signed' });
    const second = await row({ state: 'pending_approval' });
    await expect(tr.move(second, 'approved')).rejects.toMatchObject({ code: 'pending_tx' });
    const other = await row({ state: 'pending_approval', network: 'ethereum' });
    expect((await tr.move(other, 'approved')).state).toBe('approved'); // another network is unaffected
  });
  it('the same payment as a recent one that may have happened is announced; one that certainly did not is not', async () => {
    const dup = () => tr.duplicateWarning('base', 'native', '0xto', '1000');
    expect(await dup()).toEqual([]);
    const a = await row({ state: 'failed' }); // failed before any relay: certainly not sent
    expect(await dup()).toEqual([]);
    await sql`update proposals set relay_attempted_at = now() where id = ${a.id}`; // failed after a relay started
    expect(await dup()).toEqual(['duplicate_recent']);
    await sql`delete from proposals`;
    await row({ state: 'dropped' });
    expect(await dup()).toEqual(['duplicate_recent']);
    expect(await tr.duplicateWarning('base', 'native', '0xto', '1001')).toEqual([]);
    await sql`update proposals set created_at = now() - interval '25 hours'`;
    expect(await dup()).toEqual([]);
  });
  it('every transition is an event with an increasing id', async () => {
    await sql`delete from wallet_events`;
    const p = await row();
    net.next = { state: 'confirming', confirmations: 1, blockRef: '0xb', seen: true };
    await worker.reconcile();
    const ev = await sql`select id, type, ref, data from wallet_events order by id`;
    expect(ev.map((e: any) => [e.type, e.data.lifecycle ?? null])).toEqual([['transfer.relay', 'broadcasting'], ['transfer.state', 'pending'], ['transfer.state', 'confirming']]);
    expect(ev.every((e: any) => e.ref === p.id)).toBe(true);
    expect(Number(ev[2].id)).toBeGreaterThan(Number(ev[0].id));
  });
});

// ── the adapters' own verdicts, against scripted endpoints ──────────────────────────────────────────────────────────────
type Script = (url: string, method: string, params: any[]) => unknown; // return a value, or throw { rpc: message } / Error('down')
function endpoints(script: Script) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input), body = JSON.parse(String(init?.body ?? '{}'));
    try { return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: script(url, body.method, body.params) }), { status: 200 }); }
    catch (e) { if ((e as any).rpc) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: (e as any).rpc } }), { status: 200 }); throw new TypeError('fetch failed'); }
  }) as typeof fetch;
}

describe('EVM adapter — verdicts need every endpoint', () => {
  const n = { ...(NETWORKS.base as NetworkDef), rpc: ['https://a.test', 'https://b.test'] };
  const ask = () => evm.evmAdapter(n).track({ txid: TX(1), intent: { from: '0x' + '11'.repeat(20), evm: { nonce: 7 } }, blockRef: null, broadcastAt: Date.now() / 1000 - 600 });
  const receipt = { status: '0x1', blockNumber: '0x64', blockHash: '0xbb', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', l1Fee: '0x10' };
  it('a lagging endpoint cannot hide a mined transaction; the fee paid includes the L1 data fee', async () => {
    endpoints((u, m) => m === 'eth_getTransactionReceipt' ? (u.includes('a.test') ? null : receipt) : m === 'eth_blockNumber' ? '0x6e' : m === 'eth_getBlockByNumber' ? { number: '0x65' } : null);
    const t = await ask();
    expect(t.state).toBe('finalized'); expect(t.seen).toBe(true); expect(t.feePaid).toBe(21000n * 1_000_000_000n + 16n);
  });
  it('unknown everywhere and the nonce is used, by every endpoint: replaced', async () => {
    endpoints((_u, m) => m === 'eth_getTransactionCount' ? '0x8' : null);
    expect(await ask()).toMatchObject({ state: 'replaced', seen: false });
  });
  it('the old false positive: one endpoint without the receipt while the nonce is used — but the other endpoint is down: pending, undecided', async () => {
    endpoints((u, m) => { if (u.includes('b.test')) throw new Error('down'); return m === 'eth_getTransactionCount' ? '0x8' : null; });
    const t = await ask();
    expect(t.state).toBe('broadcast'); expect(t.seen).toBeUndefined();
  });
  it('unknown everywhere, nonce unused: pending, and positively unseen', async () => {
    endpoints((_u, m) => m === 'eth_getTransactionCount' ? '0x7' : null);
    expect(await ask()).toMatchObject({ state: 'broadcast', seen: false, rebroadcast: true });
  });
  it('in one endpoint\'s mempool: seen', async () => {
    endpoints((u, m) => m === 'eth_getTransactionByHash' && u.includes('b.test') ? { hash: TX(1) } : m === 'eth_getTransactionCount' ? '0x8' : null);
    expect(await ask()).toMatchObject({ state: 'broadcast', seen: true });
  });
  it('relay: "already known" from the second endpoint is a relay; "nonce too low" is not, and every answer is reported', async () => {
    endpoints((u) => { throw { rpc: u.includes('a.test') ? 'nonce too low' : 'already known' }; });
    await expect(evm.evmAdapter(n).broadcast('0xraw')).resolves.toBeUndefined();
    endpoints(() => { throw { rpc: 'nonce too low' }; });
    await expect(evm.evmAdapter(n).broadcast('0xraw')).rejects.toThrow(/nonce too low/);
  });
});

describe('Solana adapter — "expired, nothing moved" needs every endpoint', () => {
  const n = { ...(NETWORKS.solana as NetworkDef), rpc: ['https://a.test', 'https://b.test'] };
  const ask = () => sol.solAdapter(n).track({ txid: 'sig', intent: { sol: { lastValidBlockHeight: 1000 } }, blockRef: null, broadcastAt: 0 });
  it('one endpoint knows the signature: it is placed, whatever the other says', async () => {
    endpoints((u, m) => m === 'getSignatureStatuses' ? { value: [u.includes('a.test') ? null : { confirmations: 3, err: null, confirmationStatus: 'confirmed', slot: 9 }] } : 2000);
    expect(await ask()).toMatchObject({ state: 'confirming', seen: true });
  });
  it('both unknown, both past the last valid height: expired', async () => {
    endpoints((_u, m) => m === 'getSignatureStatuses' ? { value: [null] } : 1001);
    expect(await ask()).toMatchObject({ state: 'failed', expired: true, seen: false });
  });
  it('both unknown but one endpoint is not past the height yet: still pending', async () => {
    endpoints((u, m) => m === 'getSignatureStatuses' ? { value: [null] } : u.includes('a.test') ? 1001 : 990);
    expect(await ask()).toMatchObject({ state: 'broadcast', seen: false });
  });
  it('one endpoint down: no verdict of absence', async () => {
    endpoints((u, m) => { if (u.includes('b.test')) throw new Error('down'); return m === 'getSignatureStatuses' ? { value: [null] } : 5000; });
    const t = await ask();
    expect(t.state).toBe('broadcast'); expect(t.seen).toBeUndefined();
  });
});

describe('Bitcoin-style adapter', () => {
  const n = NETWORKS.bitcoin as NetworkDef;
  const src = (o: Partial<import('../src/chains/btc.ts').Source>): import('../src/chains/btc.ts').Source => ({ name: 's', url: 'https://s.test', tip: async () => 900_000, balance: async () => 0n, utxos: async () => [], feeRate: async () => 2,
    broadcast: async () => {}, status: async () => ({ found: false, confirmed: false }), rawTx: async () => '00', tipHash: async () => 'h', blockHash: async () => 'h', ...o } as never);
  it('confirmed on one indexer places it; unknown needs every indexer; one indexer down = cannot tell', async () => {
    const a = btc.btcAdapter(n, [src({}), src({ status: async () => ({ found: true, confirmed: true, height: 899_990, hash: 'bh' }) })]);
    expect(await a.track({ txid: 't', intent: {}, blockRef: null, broadcastAt: 0 })).toMatchObject({ state: 'finalized', seen: true, blockRef: 'bh' });
    const b = btc.btcAdapter(n, [src({}), src({})]);
    expect(await b.track({ txid: 't', intent: {}, blockRef: null, broadcastAt: 0 })).toMatchObject({ state: 'broadcast', seen: false });
    const c = btc.btcAdapter(n, [src({}), src({ status: async () => { throw new Error('down'); } })]);
    expect((await c.track({ txid: 't', intent: {}, blockRef: null, broadcastAt: 0 })).seen).toBeUndefined();
  });
});

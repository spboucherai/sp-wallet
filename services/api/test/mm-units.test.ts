// Market making — the pieces of the integration that need no database: the hand-checked markout and attribution math, the
// provenance tie-break, the session schedule, the quote band, the stream-backed reconcile on RECORDED public frames, the rate
// budget, and the SIMULATED HOUR: the engine over the live adapter, the real signer code, the stream reconcile and the budget on
// the recorded tape, with every request the venue double saw weighted as the venue documents — the measured IP-weight budget.
import './agent-env.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHlStream, D, type HlStreamEvent, type HlWebSocketLike } from '@spw/derivatives';
import { hlPinnedAssets } from '@spw/derivatives/live';
import { markoutAddFill, markoutInit, markoutOnMid, pnlInit, pnlMarkToMarket, pnlOnFill, pnlOnMid, pnlReport, type QuotePolicy } from '@spw/trading/mm';
import { spreadInventoryPolicy, mmQuotes, quotePolicyOf } from '../src/agent-runtime/families.ts';
import { MmBudget, signerQuoteReadWeight } from '../src/mm/budget.ts';
import { MmEngine } from '../src/mm/engine.ts';
import { createLiveMmAdapter } from '../src/mm/live-adapter.ts';
import { marketDataPort, type BookSource } from '../src/mm/market-data.ts';
import { PaperVenue } from '../src/mm/paper-venue.ts';
import type { OrderPort, VenueFill, VenueOpenOrder } from '../src/mm/ports.ts';
import { inSessionHours, roundersFor, withinBand } from '../src/mm/runtime.ts';
import { markoutFromTape, MARKOUT_TOLERANCE_MS } from '../src/mm/sessions.ts';
import { streamReconciled, type UserFeedEvent } from '../src/mm/user-stream.ts';
import { attributable, fillOrder, replay, type LedgerFill } from '../src/orders/provenance.ts';
import { BREAKERS, engineConfig, INSTRUMENT, studyPolicy, tapeEvents, TAPE, ACCOUNT, AGENT } from './mm-harness.ts';
import { SimVenue } from './mm-sim-venue.ts';

describe('markouts and attribution — hand-checked', () => {
  it('markoutFromTape: the FIRST mid at or after each horizon, against the fill price, in bps; negative = adverse selection', () => {
    // a BUY at 100.00 at t = 1 000 000. Mids: +0.4 s 100.01 (before the 1 s horizon: not used), +1.0 s 99.98, +1.5 s 99.90, +10.2 s 99.95, +61 s 100.30
    const tape = [{ ts: 1_000_400, mid: '100.01' }, { ts: 1_001_000, mid: '99.98' }, { ts: 1_001_500, mid: '99.90' }, { ts: 1_010_200, mid: '99.95' }, { ts: 1_061_000, mid: '100.30' }];
    //   1 s: (99.98 − 100) / 100 × 10 000 = −2 bps      10 s: (99.95 − 100) / 100 × 10 000 = −5 bps      60 s: (100.30 − 100) / 100 × 10 000 = +30 bps
    expect(markoutFromTape({ ts: 1_000_000, side: 'buy', price: '100' }, tape)).toEqual(['-2', '-5', '30']);
    // the same tape for a SELL at 100.00: the signs flip (sold and the market went down = favourable)
    expect(markoutFromTape({ ts: 1_000_000, side: 'sell', price: '100' }, tape)).toEqual(['2', '5', '-30']);
    // a gap in the tape longer than the tolerance after a horizon is NO measure (null), never the next mid whenever it comes
    const gappy = [{ ts: 1_001_000, mid: '99.98' }, { ts: 1_010_000 + MARKOUT_TOLERANCE_MS + 1, mid: '99.95' }];
    expect(markoutFromTape({ ts: 1_000_000, side: 'buy', price: '100' }, gappy)).toEqual(['-2', null, null]);
    // 4 decimals, half-even: (65001.3 − 65000) / 65000 × 10 000 = 0.2 bps exactly
    expect(markoutFromTape({ ts: 0, side: 'buy', price: '65000' }, [{ ts: 1000, mid: '65001.3' }])[0]).toBe('0.2');
    // the same definition as the engine's in-memory markouts (packages/trading/src/mm/metrics.ts)
    let m = markoutAddFill(markoutInit(), { id: 'f', ts: 1_000_000, side: 'buy', price: '100', size: '1' });
    for (const p of tape) m = markoutOnMid(m, p.ts, p.mid);
    expect(m.fills[0]!.bps).toEqual(['-2', '-5', '30']);
  });

  it('attribution: buy 2 @ 99.98 with the mid at 100, the mid goes to 100.10, sell 2 @ 100.12 with the mid at 100.10 — spread 0.08, inventory 0.20, fees −0.06, total 0.22 = mark-to-market', () => {
    let p = pnlOnMid(pnlInit(), '100');
    p = pnlOnFill(p, { side: 'buy', price: '99.98', size: '2', fee: '0.03', mid: '100' });       // edge (100 − 99.98) × 2 = 0.04
    p = pnlOnMid(p, '100.10');                                                                    // inventory 2 × 0.10 = 0.20
    p = pnlOnFill(p, { side: 'sell', price: '100.12', size: '2', fee: '0.03', mid: '100.10' });  // edge (100.12 − 100.10) × 2 = 0.04
    const r = pnlReport(p);
    expect([r.spreadCaptureUsd, r.inventoryPnlUsd, r.feesUsd, r.fundingUsd, r.totalUsd, r.position, r.fills, r.volumeUsd]).toEqual(['0.08', '0.2', '-0.06', '0', '0.22', '0', 2, '400.2']);
    expect(pnlMarkToMarket(p)).toBe('0.22');                                                      // cash: −199.96 − 0.03 + 200.24 − 0.03 = 0.22
    expect(r.bpsOfVolume).toBe('5.4973');                                                         // 0.22 / 400.2 × 10 000
  });
});

describe('position provenance: a deterministic order for fills of one timestamp', () => {
  it('fillOrder: time, then the sequence in which the wallet stored the fill, then the fill id — total and stable', () => {
    const a = { ts: 5, seq: 2, fillId: 'zz' }, b = { ts: 5, seq: 10, fillId: 'aa' }, c = { ts: 4, seq: 99, fillId: 'mm' }, d = { ts: 5, seq: null, fillId: 'b' }, e = { ts: 5, seq: null, fillId: 'a' };
    expect([a, b, c, d, e].sort(fillOrder)).toEqual([c, a, b, e, d]);                               // seq 2 before seq 10 (numbers, not text); rows without a sequence last, by id
    expect([e, d, b, a, c].sort(fillOrder)).toEqual([c, a, b, e, d]);                               // whatever order the database returned them in
    expect(fillOrder({ ts: 1, seq: '9', fillId: 'x' }, { ts: 1, seq: '10', fillId: 'x' })).toBeLessThan(0);
  });
  it('the case the contract workstream reported: the owner closes and a key opens in the SAME millisecond — the ledger no longer depends on the order the rows come back in', () => {
    // the owner is long 1 (earlier). At t = 10, stored in this order: the owner's close (sell 1, seq 2), then a key's OPENING sell of 1 (seq 3) — a short of the key's
    const rows = [{ ts: 1, seq: 1, fillId: 'h1', f: { side: 'buy', size: '1', principal: null } }, { ts: 10, seq: 2, fillId: 'zz-close', f: { side: 'sell', size: '1', principal: null } }, { ts: 10, seq: 3, fillId: 'aa-open', f: { side: 'sell', size: '1', principal: 'api_key:k1' } }] as { ts: number; seq: number; fillId: string; f: LedgerFill }[];
    const lots = (order: typeof rows) => replay([...order].sort(fillOrder).map((r) => r.f));
    // whatever order the rows come back in, the ledger is the same: the venue's short of 1 is the KEY's
    for (const order of [rows, [rows[2]!, rows[1]!, rows[0]!], [rows[1]!, rows[0]!, rows[2]!], [rows[2]!, rows[0]!, rows[1]!]]) {
      const l = lots(order);
      expect(attributable(l, 'api_key:k1', '-1')).toBe('1'); expect(attributable(l, 'owner:owner', '-1')).toBe('0');
    }
    // what an arbitrary order did before: the key's sell replayed BEFORE the owner's close consumed the owner's long, and the owner's own sell then opened the short — the key was told nothing was its own
    const wrong = replay([rows[0]!, rows[2]!, rows[1]!].map((r) => r.f));
    expect([attributable(wrong, 'api_key:k1', '-1'), attributable(wrong, 'owner:owner', '-1')]).toEqual(['0', '1']);
  });
});

describe('ONE quoting rule, and the guards around it', () => {
  const inst = { tickSize: '0.1', lotSize: '0.00001', minNotional: '10' };
  it('spread_inventory behind QuotePolicy IS mmQuotes: the same prices and sizes, for the same mids and inventory', () => {
    const cfg = { quoteSizeUsd: 50, minHalfSpreadBps: 2, volMultiplier: 1.5, skewBps: 4, maxInventoryUsd: 250, volWindow: 30, decisionEveryMs: 1000 };
    const policy = spreadInventoryPolicy(cfg, inst), mids: number[] = [];
    let t = 0;
    for (const [bid, ask, inv] of [[73702, 73703, 0], [73650, 73651, 0.001], [73810, 73812, -0.002], [73790, 73791, 0.0034], [73700, 73701, 0.004]] as const) {
      t += 1000; mids.push((bid + ask) / 2);
      const want = mmQuotes(cfg, { bid, ask, instrument: inst as never }, mids, inv);
      const got = policy.quotes({ nowMs: t, book: { bid: String(bid), bidSize: '1', ask: String(ask), askSize: '1', ts: t }, inventory: String(inv), volBps: null });
      expect(got.quotes.find((q) => q.side === 'buy')?.price ?? null).toBe(want.bid ? String(want.bid.price) : null);
      expect(got.quotes.find((q) => q.side === 'sell')?.price ?? null).toBe(want.ask ? String(want.ask.price) : null);
      expect(got.quotes[0]?.size ?? null).toBe(want.bid || want.ask ? String((want.bid ?? want.ask)!.size) : null);
    }
    expect([policy.id, policy.version]).toEqual(['spread_inventory', '1']);
    // the second selectable policy: Avellaneda–Stoikov, from the agent's configuration
    const as = quotePolicyOf({ ...cfg, quoteSizeUsd: '50', minHalfSpreadBps: '2', maxInventoryUsd: '250', policy: 'avellaneda_stoikov', asGamma: '0.1', asTauIntervals: 12, asKappa: '0.69', maxHalfSpreadBps: '150' }, inst, 500);
    expect(as.id).toBe('avellaneda_stoikov');
    expect(quotePolicyOf({ ...cfg }, inst, 500).id).toBe('spread_inventory');
    expect(() => quotePolicyOf({ ...cfg, policy: 'martingale' }, inst, 500)).toThrow(/unknown quoting policy/);
  });
  it('withinBand: whatever the rule asks, a live quote is never closer than the mandate\'s minimum (+ margin) to the mid, nor further than its maximum (− margin)', () => {
    const rule = (bid: string, ask: string): QuotePolicy => ({ id: 'x', version: '1', quotes: () => ({ quotes: [{ side: 'buy', price: bid, size: '1', level: 0 }, { side: 'sell', price: ask, size: '1', level: 0 }], diagnostics: {}, notes: [] }) });
    const book = { bid: '99.99', bidSize: '1', ask: '100.01', askSize: '1', ts: 0 }, q = (p: QuotePolicy) => Object.fromEntries(p.quotes({ nowMs: 0, book, inventory: '0', volBps: null }).quotes.map((x) => [x.side, x.price]));
    // mid 100; min 1 bps + 0.5 margin → bid ≤ 99.985, ask ≥ 100.015; max 200 − 0.5 → bid ≥ 98.005, ask ≤ 101.995
    expect(q(withinBand(rule('99.999', '100.001'), 1, 200))).toEqual({ buy: '99.985', sell: '100.015' });
    expect(q(withinBand(rule('100.5', '99.5'), 1, 200))).toEqual({ buy: '99.985', sell: '100.015' });   // a rule that crosses the mid is moved to its own side
    expect(q(withinBand(rule('90', '110'), 1, 200))).toEqual({ buy: '98.005', sell: '101.995' });
    expect(q(withinBand(rule('99.9', '100.1'), 1, 200))).toEqual({ buy: '99.9', sell: '100.1' });       // inside: untouched
  });
  it('session hours: [start, end) in minutes of the UTC day, wrapping midnight; null = any time', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 16, h, m);
    expect(inSessionHours(null, at(3))).toBe(true);
    expect([at(13, 59), at(14), at(19, 59), at(20)].map((t) => inSessionHours({ startUtcMinute: 840, endUtcMinute: 1200 }, t))).toEqual([false, true, true, false]);
    expect([at(21, 59), at(22), at(1), at(5, 59), at(6)].map((t) => inSessionHours({ startUtcMinute: 1320, endUtcMinute: 360 }, t))).toEqual([false, true, true, true, false]);
  });
  it('rounding onto the venue\'s grid: a bid DOWN, an ask UP, a size DOWN — Hyperliquid by its own 5 significant figures, another venue by tick and lot', () => {
    const hl = roundersFor({ venue: 'hyperliquid', tickSize: '0.1', lotSize: '0.00001', minNotional: '10' } as never);
    expect(hl.round('buy', '73698.8', '0.000678')).toEqual({ ok: true, price: '73698', size: '0.00067' }); expect(hl.round('sell', '73706.2', '0.000678')).toEqual({ ok: true, price: '73707', size: '0.00067' });
    expect(hl.round('buy', '73698.8', '0.0001').ok).toBe(false);                                     // under the venue's 10 USD
    const other = roundersFor({ venue: 'edgex', tickSize: '0.5', lotSize: '0.001', minNotional: '5' } as never);
    expect(other.round('buy', '100.74', '0.1234')).toEqual({ ok: true, price: '100.5', size: '0.123' }); expect(other.round('sell', '100.74', '0.1234')).toEqual({ ok: true, price: '101', size: '0.123' });
    expect(other.roundReduce('sell', '100.74', '0.1234')).toEqual({ ok: true, price: '100.5', size: '0.123' });   // a reduction rounds TOWARDS execution
  });
});

describe('market data port: freshness guards', () => {
  it('a stream that is not connected, a book that is old, and the user stream\'s own status all fail closed', () => {
    let now = 10_000, user: 'connected' | 'reconnecting' = 'connected';
    const read = { status: 'connected' as 'connected' | 'reconnecting' | 'idle', top: { bid: '100', bidSize: '1', ask: '101', askSize: '1' } as null | { bid: string; bidSize: string; ask: string; askSize: string }, venueTs: 9_000, receivedAt: 9_500 };
    const source: BookSource = { read: (i) => (i === INSTRUMENT ? read : null) }, port = marketDataPort(source, { now: () => now, maxAgeMs: 5000, userStatus: () => user });
    expect(port.snapshot('hyperliquid:XYZ')).toEqual({ status: 'idle', book: null });
    expect(port.snapshot(INSTRUMENT)).toEqual({ status: 'connected', book: { bid: '100', bidSize: '1', ask: '101', askSize: '1', ts: 9_000 } });   // the OLDER of the venue's time and the time of receipt
    read.venueTs = 9_900; expect(port.snapshot(INSTRUMENT).book!.ts).toBe(9_500);
    now = 14_501; expect(port.snapshot(INSTRUMENT).status).toBe('stale');                           // received more than maxAgeMs ago
    now = 10_000; user = 'reconnecting'; expect(port.snapshot(INSTRUMENT).status).toBe('reconnecting');   // the session cannot see its own orders
    user = 'connected'; read.status = 'reconnecting'; expect(port.snapshot(INSTRUMENT)).toEqual({ status: 'reconnecting', book: null });   // the last book is NOT served
  });
});

describe('paper venue: the runtime\'s fill model, and only that one', () => {
  it('a touch is not a fill; a trade THROUGH the quote fills it at OUR price for at most the displayed size; never on the book it was priced from; the remainder is withdrawn', async () => {
    let now = 1000, book = { bid: '100', bidSize: '5', ask: '101', askSize: '5', ts: 1000 };
    const v = new PaperVenue({ instrument: INSTRUMENT, now: () => now, book: () => book, makerRate: '0.00015', takerRate: '0.00045', capitalUsd: '1000', minRestMs: 1000 });
    expect((await v.submitQuotes(INSTRUMENT, [{ clientId: '0xa', side: 'buy', price: '99.5', size: '2' }, { clientId: '0xb', side: 'sell', price: '100', size: '2' }])).kind).toBe('done');
    expect((await v.openOrders()).map((o) => o.clientId)).toEqual(['0xa']);                          // the ask AT the best bid would have matched: post-only rejected
    now = 1500; book = { bid: '99', bidSize: '5', ask: '99.4', askSize: '5', ts: 1500 }; expect(v.step()).toEqual([]);   // through the bid, but before minRestMs
    now = 2500; book = { bid: '99', bidSize: '5', ask: '99.5', askSize: '5', ts: 2500 }; expect(v.step()).toEqual([]);   // the ask AT our bid: a touch, not a fill
    now = 3000; book = { bid: '99', bidSize: '5', ask: '99.4', askSize: '1.5', ts: 3000 };
    const [f] = v.step();
    expect([f!.side, f!.price, f!.size, f!.maker, f!.fee]).toEqual(['buy', '99.5', '1.5', true, '0.0223875']);   // 99.5 × 1.5 × 0.00015
    expect(await v.openOrders()).toEqual([]);                                                         // the 0.5 that was left is withdrawn (no queue is modelled)
    expect((await v.account()).position).toBe('1.5'); expect(await v.lookup(INSTRUMENT, '0xa')).toBe('filled');
    // a reduce-only unwind: immediate, against the displayed best bid, at that price, taker fee; never more than the position
    const r = await v.submitReduces(INSTRUMENT, [{ clientId: '0xc', side: 'sell', price: '98.9', size: '9' }]);
    expect(r).toMatchObject({ kind: 'done', results: [{ outcome: 'filled', size: '1.5', price: '99' }] });
    expect((await v.account()).position).toBe('0');
    // the simulated dead man's switch cancels what rests when its time comes
    await v.submitQuotes(INSTRUMENT, [{ clientId: '0xd', side: 'buy', price: '98', size: '1' }]);
    expect((await v.scheduleCancel(now + 1000)).kind).toBe('refused'); expect((await v.scheduleCancel(now + 6000)).kind).toBe('done');
    now += 6000; v.step();
    expect(await v.openOrders()).toEqual([]); expect(v.triggersToday()).toBe(1); expect(await v.lookup(INSTRUMENT, '0xd')).toBe('cancelled');
  });
});

describe('reconcile from the venue\'s user streams', () => {
  const REC = JSON.parse(readFileSync(new URL('../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-ws.json', import.meta.url), 'utf8')) as { messages: any[] };
  class FakeSocket implements HlWebSocketLike { static last: FakeSocket; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null; sent: any[] = []; constructor(readonly url: string) { FakeSocket.last = this; } send(d: string) { this.sent.push(JSON.parse(d)); } close() {} push(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); } }
  const inner = (o: { open?: VenueOpenOrder[]; fills?: VenueFill[]; calls: string[] }): OrderPort => ({ actionTtlMs: 10_000, submitQuotes: async (_i, q) => ({ kind: 'done', results: q.map((x, k) => ({ clientId: x.clientId, outcome: 'resting' as const, venueOrderId: String(900 + k) })) }), submitReduces: async () => ({ kind: 'done', results: [] }),
    cancel: async (_i, ids) => ({ kind: 'done', results: ids.map((clientId) => ({ clientId, outcome: 'cancelled' as const })) }), scheduleCancel: async () => ({ kind: 'done' }),
    openOrders: async () => { o.calls.push('openOrders'); return o.open ?? []; }, account: async () => { o.calls.push('account'); return { position: '0', accountValue: '1000', ts: 0 }; }, fills: async () => { o.calls.push('fills'); return o.fills ?? []; },
    lookup: async () => { o.calls.push('lookup'); return 'not_found'; }, addressRequestsRemaining: async () => 10_000 });

  it('the RECORDED public userFills frame of mainnet (a snapshot) parses through the real stream client and lands in the reconcile state; the subscription messages are the documented ones', async () => {
    const frame = REC.messages.find((m) => m.channel === 'userFills'), user = frame.data.user as string;
    expect(frame.data.isSnapshot).toBe(true);                                                         // documented: "the first message has isSnapshot: true"
    const stream = createHlStream({ network: 'mainnet', WebSocket: FakeSocket, now: () => 1_794_400_000_000, random: () => 1 }), calls: string[] = [];
    const port = streamReconciled(inner({ calls }), { account: user, now: () => 1_794_400_000_000, feed: { subscribe: (account, on, onStatus) => stream.subscribe({ type: 'account', account }, (ev) => on(ev as UserFeedEvent), onStatus) } });
    FakeSocket.last.onopen?.({});
    expect(FakeSocket.last.sent.filter((m) => m.method === 'subscribe').map((m) => m.subscription)).toEqual([{ type: 'userFills', user }, { type: 'orderUpdates', user }, { type: 'userEvents', user }]);   // /api/websocket/subscriptions
    expect(port.status()).toBe('connected');
    FakeSocket.last.push(frame);
    const coin = frame.data.fills[0].coin as string, got = await port.fills(`hyperliquid:${coin}`, 0);
    expect(got.length).toBe(frame.data.fills.length);
    expect(got.map((f) => f.id).sort()).toEqual(frame.data.fills.map((f: any) => `${f.hash}-${f.tid}`).sort());
    expect(new Set(got.map((f) => f.side))).toEqual(new Set(frame.data.fills.map((f: any) => (f.side === 'B' ? 'buy' : 'sell'))));
    expect(port.stats().streamFills).toBe(frame.data.fills.length);
    // a session's engine asks for fills SINCE ITS START: the account's earlier history in the snapshot is not its own
    expect(await port.fills(`hyperliquid:${coin}`, 1_794_400_000_000)).toEqual([]);
    // an orderUpdates message in the DOCUMENTED shape (WsOrder[]: { order: WsBasicOrder, status, statusTimestamp }) — no public frame can be recorded without an account that trades
    FakeSocket.last.push({ channel: 'orderUpdates', data: [{ order: { coin: 'BTC', side: 'B', limitPx: '65000.0', sz: '0.0003', oid: 4242, timestamp: 1_794_400_000_100, origSz: '0.0003', cloid: `0x${'ab'.repeat(16)}` }, status: 'open', statusTimestamp: 1_794_400_000_100 }] });
    await port.openOrders(INSTRUMENT);                                                                // the first read is the REST snapshot (orderUpdates has none)
    FakeSocket.last.push({ channel: 'orderUpdates', data: [{ order: { coin: 'BTC', side: 'A', limitPx: '65100.0', sz: '0.0003', oid: 4243, timestamp: 1_794_400_000_200, origSz: '0.0003', cloid: `0x${'cd'.repeat(16)}` }, status: 'open', statusTimestamp: 1_794_400_000_200 }] });
    expect((await port.openOrders(INSTRUMENT)).map((o) => [o.venueOrderId, o.side, o.price])).toEqual([['4243', 'sell', '65100']]);
    FakeSocket.last.push({ channel: 'orderUpdates', data: [{ order: { coin: 'BTC', side: 'A', limitPx: '65100.0', sz: '0.0003', oid: 4243, timestamp: 1_794_400_000_200, origSz: '0.0003', cloid: `0x${'cd'.repeat(16)}` }, status: 'scheduledCancel', statusTimestamp: 1_794_400_000_900 }] });
    expect(await port.openOrders(INSTRUMENT)).toEqual([]);                                            // the dead man's switch firing is a cancellation
    expect(await port.lookup(INSTRUMENT, `0x${'cd'.repeat(16)}`)).toBe('cancelled');
    stream.close();
  });

  it('REST only at start-up, after a gap and on the safety cadence; a final state is never left; an order the venue answered `resting` is listed before the stream says so', async () => {
    let now = 0, onEv: (ev: UserFeedEvent) => void = () => {}, onSt: (s: 'connected' | 'reconnecting' | 'stale') => void = () => {};
    const calls: string[] = [], open: VenueOpenOrder[] = [];
    const port = streamReconciled(inner({ calls, open }), { account: '0x', now: () => now, auditEveryMs: 60_000, restMinIntervalMs: 10_000, accountMaxAgeMs: 15_000, feed: { subscribe: (_a, on, st) => { onEv = on; onSt = st; return () => {}; } } });
    onSt('connected');
    const tick = async () => { await port.openOrders(INSTRUMENT); await port.account(INSTRUMENT); await port.fills(INSTRUMENT, 0); };
    await tick();
    expect(calls).toEqual(['openOrders', 'fills', 'account']);                                        // start-up: one full REST read
    for (let k = 0; k < 29; k++) { now += 2000; await tick(); }
    expect(calls.filter((c) => c === 'openOrders').length).toBe(1); expect(calls.filter((c) => c === 'fills').length).toBe(1);   // 58 s of reads from memory
    expect(calls.filter((c) => c === 'account').length).toBe(1 + 3);                                  // the position is re-read every 15 s (weight 2)
    now += 2000; await tick();
    expect(calls.filter((c) => c === 'openOrders').length).toBe(2);                                   // the 60 s audit
    // an order placed: listed at once from the venue's own answer
    await port.submitQuotes(INSTRUMENT, [{ clientId: '0x1', side: 'buy', price: '100', size: '1' }]);
    expect((await port.openOrders(INSTRUMENT)).map((o) => o.clientId)).toEqual(['0x1']);
    // cancelled by the venue's answer; a LATE `open` update of the stream does not bring it back
    await port.cancel(INSTRUMENT, ['0x1']);
    onEv({ type: 'orders', orders: [{ instrument: INSTRUMENT, venueOrderId: '900', clientId: '0x1', side: 'buy', price: '100', size: '1', remaining: '1', status: 'open', venueStatus: 'open', createdAt: now, updatedAt: now + 5 }] });
    expect(await port.openOrders(INSTRUMENT)).toEqual([]); expect(await port.lookup(INSTRUMENT, '0x1')).toBe('cancelled');
    // a gap: nothing the stream said is trusted — REST at once, then at most every 10 s while it is down
    const before = calls.filter((c) => c === 'openOrders').length;
    onSt('reconnecting');
    for (let k = 0; k < 12; k++) { now += 2000; await tick(); }
    expect(calls.filter((c) => c === 'openOrders').length - before).toBe(3);                          // 24 s down: reads at +2 s, +12 s, +22 s
    onSt('connected'); onEv({ type: 'gap', reason: 'reconnected' });
    now += 2000; await tick();
    expect(calls.filter((c) => c === 'openOrders').length - before).toBe(4);                          // the snapshot after the reconnect
    expect(port.stats()).toMatchObject({ status: 'connected', synced: true });
  });
});

describe('rate budget', () => {
  it('the documented weights; a one-minute window; the signer\'s own reads counted as an estimate; the address budget follows what was sent', () => {
    let now = 0;
    const b = new MmBudget({ now: () => now });
    b.info('frontendOpenOrders'); b.info('clearinghouseState'); b.info('orderStatus'); b.info('userFillsByTime'); b.info('userRateLimit'); b.exchange('order', 2); b.exchange('cancelByCloid', 41);
    expect(b.used()).toBe(20 + 2 + 2 + 20 + 20 + 1 + 2);                                              // exchange: 1 + floor(batch / 40)
    expect(signerQuoteReadWeight({ flat: true, pendingQuotes: 2 })).toBe(20 + 2 + 20 + 4); expect(signerQuoteReadWeight({ flat: false, pendingQuotes: 0 })).toBe(22);
    b.signerQuoteBatch({ flat: true, pendingQuotes: 0 });
    expect(b.used()).toBe(67 + 42); expect(b.remaining()).toBe(1200 - 109);
    now = 60_001; expect(b.used()).toBe(0); expect(b.peakPerMinute()).toBe(109);
    expect(b.addressRemaining()).toBeNull();
    b.addressObserved(10_000); b.addressSpent('orders', 2); b.addressSpent('heartbeat', 1); b.addressSpent('cancels', 2);
    expect(b.addressRemaining()).toBe(9_997);                                                         // cancels have their own, larger allowance
    // with the process's own HTTP window (HlHttp.budget.used): that figure plus the signer's estimated share
    const p = new MmBudget({ now: () => now, processUsed: () => 300 });
    p.info('frontendOpenOrders'); p.signerQuoteBatch({ flat: false, pendingQuotes: 1 });
    expect(p.used()).toBe(300 + 24); expect(p.report().restWeight).toBe(20);
  });

  it('A SIMULATED HOUR stays inside the venue\'s limits: IP weight per minute (API + signer, as the venue would count it) and the address requests', async () => {
    // the 36-minute recorded tape, played twice end to end (the second pass shifted in time): 60 minutes of quoting
    const first = tapeEvents(0, Infinity), span = first[first.length - 1]!.t - first[0]!.t + 1000, tape = [...first, ...first.map((e) => ({ ...e, t: e.t + span }))];
    expect(tape.length).toBeGreaterThan(20_000);
    const h = await hourWorld(tape);
    const perMinute = new Map<number, { api: number; signer: number; exchange: number }>();
    const t0 = h.sim.now;
    h.engine.start();
    while (h.sim.now < t0 + 60 * 60_000) {
      h.sim.advance(h.sim.now + 1000); await h.engine.tick();
      // the live engine's own paced reconcile of the account (60 s while a session runs): account, positions, open orders, fills
      if (Math.floor((h.sim.now - t0) / 60_000) !== Math.floor((h.sim.now - 1000 - t0) / 60_000)) for (const type of ['clearinghouseState', 'clearinghouseState', 'frontendOpenOrders', 'userFillsByTime']) await h.apiInfo({ type, user: ACCOUNT, startTime: h.sim.now - 60_000 });
    }
    for (const r of h.requests) { const m = Math.floor((r.t - t0) / 60_000), c = perMinute.get(m) ?? { api: 0, signer: 0, exchange: 0 }; c[r.who === 'signer' ? 'signer' : r.kind === 'exchange' ? 'exchange' : 'api'] += r.weight; perMinute.set(m, c); }
    const mins = [...perMinute.values()], total = mins.map((m) => m.api + m.signer + m.exchange), sum = (k: 'api' | 'signer' | 'exchange') => mins.reduce((n, m) => n + m[k], 0), st = h.engine.status(), rep = h.budget.report();
    const figures = { minutes: mins.length, peakPerMinute: Math.max(...total), meanPerMinute: Math.round(total.reduce((a, b) => a + b, 0) / mins.length), apiRestMean: Math.round(sum('api') / mins.length), signerMean: Math.round(sum('signer') / mins.length), exchangeMean: Math.round(sum('exchange') / mins.length),
      quoteBatches: st.counters.quoteBatches, quotesPlaced: st.counters.quotesPlaced, cancels: st.counters.cancels, fills: st.counters.fills, heartbeats: st.counters.heartbeats, restOpenOrders: h.stream.stats().rest.openOrders, restAccount: h.stream.stats().rest.account,
      addressUsed: h.sim.rateLimit().nRequestsUsed, addressCap: h.sim.rateLimit().nRequestsCap, budgetPeakEstimate: rep.peakPerMinute, triggers: h.sim.triggersToday(), signerDenied: h.store.journalRecords().filter((j) => j.type === 'venue.quoting.sign.denied').length };
    console.log(`[mm] simulated hour — ${JSON.stringify(figures)}`);
    // the venue's IP limit is 1 200 per minute for the API AND the signer together: every minute stays under it with room to spare
    expect(figures.peakPerMinute).toBeLessThan(900);
    // the engine's own steady-state REST is small: the stream answers; REST is the 60 s audits, the position reads and the rate-limit read
    expect(figures.apiRestMean).toBeLessThan(140);
    expect(figures.restOpenOrders).toBeLessThanOrEqual(62);                                           // one audit a minute (+ the start)
    // the budget the engine keeps (its own requests measured, the signer's estimated) never under-estimates the truth by much
    expect(figures.budgetPeakEstimate).toBeGreaterThan(figures.peakPerMinute * 0.6);
    // address-based requests: inside the venue's cap at every moment (the venue double refuses beyond it)
    expect(figures.addressUsed).toBeLessThanOrEqual(figures.addressCap);
    expect(h.sim.log.filter((x) => x.result === 'rate_limited')).toHaveLength(0);
    expect(figures.triggers).toBe(0); expect(figures.signerDenied).toBe(0);
    expect(figures.quoteBatches).toBeGreaterThan(100);                                                // it did quote for the hour
  }, 300_000);
});

/** the harness world (real signer code, live adapter) on a given tape, with the stream reconcile and the budget in place, and every request the venue saw attributed to the API or to the signer */
async function hourWorld(tape: ReturnType<typeof tapeEvents>) {
  const { createHash } = await import('node:crypto'), { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { jurisdictionAck, venueAuthorizationHash, venueQuotingMandateHash } = await import('@spw/derivatives/live');
  const { Signer } = await import('../../isolated-signer/src/signer.ts'), { Store } = await import('../../isolated-signer/src/store.ts'), { hyperliquidReader, VENUE_INFO_URL } = await import('../../isolated-signer/src/venue-read.ts'), { TestPasskey } = await import('../../../tests/helpers/passkey.ts'), { keys } = await import('./mm-harness.ts');
  const sim = new SimVenue({ network: 'testnet', assets: hlPinnedAssets('testnet'), coin: 'BTC', account: ACCOUNT, agent: AGENT, tape, startEquity: '1000' });
  const requests: { t: number; who: 'api' | 'signer'; kind: 'info' | 'exchange'; type: string; weight: number }[] = [];
  /** every request the venue double sees while `fn` runs is `by`'s (calls never overlap: the engine is sequential) */
  const track = async <T>(by: 'api' | 'signer', fn: () => Promise<T>): Promise<T> => { const n = sim.requests.length; try { return await fn(); } finally { for (const r of sim.requests.slice(n)) requests.push({ ...r, who: by }); } };
  const apiInfo = (body: unknown) => track('api', () => sim.info(body));
  const dir = mkdtempSync(join(tmpdir(), 'spw-mm-hour-')), store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const nowSec = () => Math.floor(sim.now / 1000), RP = 'wallet.test', ORIGIN = 'https://wallet.test';
  const reader = hyperliquidReader(async (url, body) => { if (url !== VENUE_INFO_URL.testnet) throw new Error('wrong host'); return track('signer', () => sim.info(body)); });
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, nowSec, { get: async (s: string[]) => Object.fromEntries(s.map((k) => [k, Number(sim.mid())])) }, reader);
  const pk = new TestPasskey(RP, ORIGIN); await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const now = nowSec(), ACK = jurisdictionAck('hyperliquid', 'fr').sha256;
  const authorization = { v: 1 as const, authorizationId: '7c1e0d2a-3b4c-4d5e-8f60-0000000000a1', keyId: keys.keyId, venue: 'hyperliquid' as const, network: 'testnet' as const, account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-mm', mode: 'MANUAL_LIVE' as const,
    policy: { allowedInstruments: [INSTRUMENT], maxLeverage: 5, maxOrderNotional: '300', maxPositionNotional: '500', maxGrossExposure: '800', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 }, createdAt: now, expiresAt: now + 60 * 86400, approveNonce: now * 1000, ackSha256: ACK };
  await signer.venueAuthorize(authorization, pk.assert(venueAuthorizationHash(authorization)));
  const mandate = { v: 1 as const, mandateId: '7c1e0d2a-3b4c-4d5e-8f60-0000000000a2', authorizationId: authorization.authorizationId, keyId: keys.keyId, venue: 'hyperliquid' as const, network: 'testnet' as const, account: ACCOUNT, agentAddress: AGENT, strategySha256: 'ab'.repeat(32), agentId: 'mm-hour',
    instruments: [{ instrument: INSTRUMENT, maxLeverage: 3, maxQuoteNotional: '40', maxRestingPerSide: 2, maxRestingNotionalPerSide: '80', maxInventoryNotional: '200' }], maxRestingTotal: 4, maxGrossExposure: '300', minHalfSpreadBps: 1, maxDistanceBps: 200, maxReduceDeviationBps: 50, floorEquity: '500',
    rate: { burstActions: 20, actionsPerMinute: 60, ordersPerHour: 3600, ordersPerDay: 20_000, dailyTurnover: '500000' }, deadManSeconds: 30, createdAt: now, expiresAt: now + 5 * 86400, ackSha256: ACK };
  await signer.venueQuotingApprove(mandate, pk.assert(venueQuotingMandateHash(mandate)));
  const budget = new MmBudget({ now: () => sim.now });
  const engineRef: { e: MmEngine | null } = { e: null };
  const adapter = createLiveMmAdapter({ network: 'testnet', account: ACCOUNT, mandateId: mandate.mandateId, now: () => sim.now, actionTtlMs: 10_000, locks: { liveMainnet: () => false, mandateMainnet: () => false, mmMainnet: () => false },
    signer: { venueQuotingSign: async (p) => { const r = await signer.venueQuotingSign(p); if (r.kind === 'quotes') { const st = engineRef.e?.status(); budget.signerQuoteBatch({ flat: !st || D.isZero(D.from(st.position)), pendingQuotes: st?.orders.filter((o) => o.state !== 'resting').length ?? 0 }); } return r; } },
    venue: { info: (b) => { budget.info(String((b as { type: string }).type)); return apiInfo(b); }, exchange: (b, n) => { const t = String((b as { action: { type: string } }).action.type); budget.exchange(t, n); budget.addressSpent(t === 'order' ? 'orders' : t === 'scheduleCancel' ? 'heartbeat' : 'cancels', t === 'scheduleCancel' ? 1 : n); return track('api', () => sim.exchange(b)); } } });
  let onUser: (ev: UserFeedEvent) => void = () => {};
  sim.onUser = (ev) => onUser(ev as UserFeedEvent);
  const stream = streamReconciled({ ...adapter, actionTtlMs: adapter.actionTtlMs, addressRequestsRemaining: async () => { const n = await adapter.addressRequestsRemaining(); budget.addressObserved(n); return n; } }, { account: ACCOUNT, now: () => sim.now, feed: { subscribe: (_a, on, st) => { onUser = on; st('connected'); return () => {}; } } });
  const engine = new MmEngine(engineConfig({ breakers: BREAKERS, reconcileEveryMs: 2000, rateEveryMs: 120_000, ipWeightRemaining: () => budget.remaining() }), studyPolicy({ fallbackVolBps: 1.5 }), {
    market: { snapshot: () => ({ status: 'connected', book: sim.top().ts ? sim.top() : null }) }, orders: stream, clock: { now: () => sim.now }, journal: { record: () => {} },
    risk: { killSwitch: async () => false, evaluate: async () => ({ allow: true, code: null, message: null }) },
    mandate: { current: async () => { const s = signer.status().venueQuotingMandates.find((x) => x.mandate.mandateId === mandate.mandateId)!; return { mandateId: mandate.mandateId, phase: s.phase, expiresAt: mandate.expiresAt, deadManSeconds: 30, bucketActions: s.bucketActions, quotesLeftHour: 3600 - s.quotesThisHour, quotesLeftDay: 20_000 - s.today.quotes }; } } });
  engineRef.e = engine;
  return { sim, engine, stream, budget, requests, apiInfo, store };
}
void TAPE;

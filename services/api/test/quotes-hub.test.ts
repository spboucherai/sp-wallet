// Quote hub (services/api/src/quotes/hub.ts, upstreams.ts, ws-client.ts) — no network, no database.
// Scripted upstreams for the hub's own rules (reference counting, merge without invention, book snapshot / delta / gap,
// isolation, staleness, bounds), and the REAL venue stream clients on a scripted socket replaying REAL recorded frames
// (Hyperliquid and Coinbase: test/fixtures/quotes/, recorded 2026-11-15; edgeX and dYdX: packages/derivatives/test/fixtures).
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlStream, DydxStream, EdgeXStream } from '@spw/derivatives';
import { QuoteError, QuoteHub } from '../src/quotes/hub.ts';
import { BookSchema, QuoteSchema, TradeSchema, CandleSchema, StatusSchema, type BookMsg } from '../src/quotes/protocol.ts';
import { applyLevels, backoffMs, bookChecksum, channelKey, cmpDec, crc32, diffLevels, type Level } from '../src/quotes/shared.ts';
import { hyperliquidUpstream, spotUpstream, venueUpstream, QUOTE_CADENCE_MS } from '../src/quotes/upstreams.ts';
import { createReconnectingWs } from '../src/quotes/ws-client.ts';
import { collect, fakeUpstream, L, recording, ScriptedSocket } from './quotes-helpers.ts';

const T0 = Date.parse('2026-11-15T12:00:00Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); ScriptedSocket.reset(); });
afterEach(() => { vi.useRealTimers(); });

const hubOf = (...ups: ReturnType<typeof fakeUpstream>[]) => new QuoteHub({ upstreams: ups.map((u) => u.up), quoteMinIntervalMs: 0, idleGraceMs: 10_000, downAfterMs: 30_000 });
/** replays book messages the way a client does; throws when a delta does not follow the previous message */
function clientBook() {
  let bids: Level[] = [], asks: Level[] = [], seq: number | null = null;
  return { get bids() { return bids; }, get asks() { return asks; },
    apply(m: BookMsg): void {
      if (m.kind === 'snapshot') { bids = m.bids; asks = m.asks; }
      else { if (m.prevSeq !== seq) throw new Error(`gap: prevSeq ${m.prevSeq} after ${seq}`); bids = applyLevels(bids, m.bids, 'bids', m.depth); asks = applyLevels(asks, m.asks, 'asks', m.depth); }
      seq = m.seq;
      if (bookChecksum(bids, asks) !== m.checksum) throw new Error('checksum mismatch');
    } };
}

describe('shared helpers', () => {
  it('crc32 is the IEEE CRC-32; decimal strings compare without floats; a delta is the difference of two sides', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(cmpDec('65000.5', '65000.49')).toBe(1); expect(cmpDec('9', '10')).toBe(-1); expect(cmpDec('0.10', '0.1')).toBe(0); expect(cmpDec('-2', '1')).toBe(-1); expect(cmpDec('123456789012345678901234567890.1', '123456789012345678901234567890.2')).toBe(-1);
    const prev = L(['100', '1'], ['99', '2'], ['98', '3']), next = L(['100', '1.5'], ['98', '3'], ['97', '4']);
    const d = diffLevels(prev, next);
    expect(d).toEqual([['100', '1.5'], ['97', '4'], ['99', '0']]);
    expect(applyLevels(prev, d, 'bids', 20)).toEqual(next);
    expect(applyLevels(L(['101', '1'], ['102', '1']), L(['100.5', '2']), 'asks', 2)).toEqual([['100.5', '2'], ['101', '1']]);   // sorted, cut at the depth
    expect(channelKey({ type: 'book', id: 'x:BTC' })).toBe('book|x:BTC|20'); expect(channelKey({ type: 'candle', id: 'x:BTC', interval: '5m' })).toBe('candle|x:BTC|5m'); expect(channelKey({ type: 'quote', id: 'x:BTC' })).toBe('quote|x:BTC|');
    expect(backoffMs(0, 1000, 30_000, () => 0)).toBe(500); expect(backoffMs(0, 1000, 30_000, () => 1)).toBe(1000); expect(backoffMs(3, 1000, 30_000, () => 1)).toBe(8000); expect(backoffMs(20, 1000, 30_000, () => 1)).toBe(30_000);
  });
});

describe('book vectors shared with the Python SDK', () => {
  // sdk/python/tests/fixtures/stream-vectors.json: a book, a chain of deltas and the checksum after each, computed HERE with the
  // server's helpers. The Python client must find the same numbers (sdk/python/tests/test_stream.py). SPW_UPDATE_VECTORS=1 rewrites the file.
  it('the committed vectors are what the server computes', () => {
    let seed = 20261115; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const side = (base: number, dir: 1 | -1): [string, string][] => Array.from({ length: 20 }, (_, k): [string, string] => [(base + dir * k * 0.5).toFixed(1).replace(/\.0$/, ''), (rnd() * 10 + 0.01).toFixed(4)]);
    let bids = side(65000, -1), asks = side(65000.5, 1);
    const messages: unknown[] = [{ v: 1, type: 'book', id: 'hyperliquid:BTC', depth: 20, kind: 'snapshot', bids, asks, seq: 1, prevSeq: null, checksum: bookChecksum(bids, asks), venueTs: null, recvTs: 1, source: 'hyperliquid-ws', stale: false }];
    for (let seq = 2; seq <= 12; seq++) {
      const nb = side(65000 + Math.floor(rnd() * 6 - 3) * 0.5, -1), na = side(65000.5 + Math.floor(rnd() * 6) * 0.5, 1);
      messages.push({ v: 1, type: 'book', id: 'hyperliquid:BTC', depth: 20, kind: 'delta', bids: diffLevels(bids, nb), asks: diffLevels(asks, na), seq, prevSeq: seq - 1, checksum: bookChecksum(nb, na), venueTs: null, recvTs: seq, source: 'hyperliquid-ws', stale: false });
      bids = nb; asks = na;
    }
    const vectors = { note: 'generated by services/api/test/quotes-hub.test.ts (SPW_UPDATE_VECTORS=1) from services/api/src/quotes/shared.ts — do not edit by hand', crc32: { '123456789': crc32('123456789'), '': crc32('') },
      keys: [{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 5 }, { type: 'candle', id: 'dydx:BTC-USD', interval: '4h' }, { type: 'status', id: '*' }].map((c) => ({ channel: c, key: channelKey(c as never) })),
      messages, final: { bids, asks } };
    const file = new URL('../../../sdk/python/tests/fixtures/stream-vectors.json', import.meta.url), text = `${JSON.stringify(vectors, null, 1)}\n`;
    if (process.env.SPW_UPDATE_VECTORS === '1') writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('quote hub: reference counting', () => {
  it('the first subscriber opens the upstream feeds, the next ones share them, the last one leaving closes them after the idle grace', async () => {
    const hl = fakeUpstream('hyperliquid', { bbo: true }), hub = hubOf(hl), a = collect(), b = collect();
    await hub.validate({ type: 'quote', id: 'hyperliquid:BTC' });
    const s1 = hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, a.on);
    expect(hl.log).toEqual(['open ticker BTC', 'open bbo BTC']);
    const s2 = hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, b.on);
    expect(hl.log.length).toBe(2);                                               // shared
    expect(hub.listeners('quote|hyperliquid:BTC|')).toBe(2);
    hl.status('connected');
    hl.feed('ticker', 'BTC').sink.quote({ mark: '65000', index: '65010', mid: '65001', funding: '0.0000125', openInterest: '36000', venueTs: null });
    expect(a.of('quote').length).toBe(1); expect(b.of('quote').length).toBe(1);
    expect(a.frames[0]!.text).toBe(b.frames[0]!.text);                            // serialised once for both
    s1.unsubscribe(); s1.unsubscribe();                                           // idempotent
    hl.feed('ticker', 'BTC').sink.quote({ mark: '65001', venueTs: null });
    expect(a.of('quote').length).toBe(1); expect(b.of('quote').length).toBe(2);
    s2.unsubscribe();
    expect(hl.open().length).toBe(2);                                             // idle grace: nothing closed yet
    vi.advanceTimersByTime(9_000);
    // back within the grace: the same channel, its last value served at once, no new upstream subscription
    const c = collect(), s3 = hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, c.on);
    expect(hl.log.length).toBe(2);
    expect(s3.snapshot()).toMatchObject({ type: 'quote', mark: '65001', index: '65010' }); expect(s3.snapshotAgeMs()).toBe(9_000);
    s3.unsubscribe();
    vi.advanceTimersByTime(10_001);
    expect(hl.log.slice(2)).toEqual(['close ticker BTC', 'close bbo BTC']);
    expect(hub.stats()).toMatchObject({ channels: 0, feeds: 0, listeners: 0 });
    expect(hub.statuses().find((v) => v.venue === 'hyperliquid')!.status).toBe('idle');
  });

  it('a book at two depths and the quote of the same market share ONE upstream book feed', async () => {
    const dy = fakeUpstream('dydx'), hub = hubOf(dy), q = collect(), b5 = collect(), b20 = collect();
    hub.subscribe({ type: 'quote', id: 'dydx:BTC' }, q.on);
    hub.subscribe({ type: 'book', id: 'dydx:BTC', depth: 5 }, b5.on); hub.subscribe({ type: 'book', id: 'dydx:BTC', depth: 20 }, b20.on);
    expect(dy.log).toEqual(['open ticker BTC', 'open book BTC']);
    dy.status('connected');
    const bids = Array.from({ length: 12 }, (_, k): [string, string] => [String(100 - k), '1']), asks = Array.from({ length: 12 }, (_, k): [string, string] => [String(101 + k), '2']);
    dy.feed('book', 'BTC').sink.book({ bids, asks, venueTs: null });
    expect(b5.of('book')[0]).toMatchObject({ kind: 'snapshot', depth: 5, prevSeq: null }); expect(b5.of('book')[0]!.bids.length).toBe(5); expect(b20.of('book')[0]!.bids.length).toBe(12);
    // a venue without a best-bid/offer feed: the quote takes its two sides from the open book — and the mid is theirs
    expect(q.of('quote').at(-1)).toMatchObject({ bid: '100', bidSize: '1', ask: '101', askSize: '2', mid: '100.5', mark: null, last: null });
    // a change beyond the fifth level: the depth-5 channel says nothing, the depth-20 channel sends one delta
    dy.feed('book', 'BTC').sink.book({ bids: [...bids.slice(0, 8), ['92', '7'], ...bids.slice(9)], asks, venueTs: null });
    expect(b5.of('book').length).toBe(1); expect(b20.of('book').at(-1)).toMatchObject({ kind: 'delta', bids: [['92', '7']], asks: [] });
  });

  it('when the book feed closes, the quote stops showing the sides it was taking from it', () => {
    const dy = fakeUpstream('dydx'), hub = new QuoteHub({ upstreams: [dy.up], quoteMinIntervalMs: 0, idleGraceMs: 0 }), q = collect();
    hub.subscribe({ type: 'quote', id: 'dydx:BTC' }, q.on);
    const b = hub.subscribe({ type: 'book', id: 'dydx:BTC' }, () => {});
    dy.feed('ticker', 'BTC').sink.quote({ mark: '100.4', mid: null, venueTs: null });
    dy.feed('book', 'BTC').sink.book({ bids: L(['100', '1']), asks: L(['101', '1']), venueTs: null });
    expect(q.of('quote').at(-1)).toMatchObject({ bid: '100', ask: '101', mid: '100.5' });
    b.unsubscribe(); vi.advanceTimersByTime(1);
    expect(q.of('quote').at(-1)).toMatchObject({ bid: null, ask: null, mid: null, mark: '100.4' });   // never a bid/ask nobody maintains
  });
});

describe('quote hub: normalised messages', () => {
  it('a quote is the newest fields of the source, merged: nothing the source did not send, decimal strings only, schema-valid', () => {
    const hl = fakeUpstream('hyperliquid', { bbo: true }), hub = hubOf(hl), c = collect();
    const sub = hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, c.on);
    expect(sub.snapshot()).toBeNull(); expect(sub.snapshotAgeMs()).toBeNull();     // no data → no message
    hl.status('connected');
    hl.feed('bbo', 'BTC').sink.quote({ bid: '65085', bidSize: '11.88311', ask: '65086', askSize: '0.85252', venueTs: T0 - 40 });
    const q1 = QuoteSchema.parse(c.of('quote')[0]);
    expect(q1).toMatchObject({ id: 'hyperliquid:BTC', bid: '65085', ask: '65086', mid: '65085.5', mark: null, index: null, last: null, funding: null, openInterest: null, venueTs: T0 - 40, recvTs: T0, seq: 1, source: 'hyperliquid-ws', stale: false });
    vi.advanceTimersByTime(250);
    hl.feed('ticker', 'BTC').sink.quote({ mark: '65087', index: '65115', mid: '65075.5', funding: '0.0000125', openInterest: '36159.52766', change24h: '0.003067', volume24h: '3319784424.88', venueTs: null });
    const q2 = QuoteSchema.parse(c.of('quote')[1]);
    // the two sides stand; the mid stays THEIR mid (the venue's own mid is used only when a side is missing); venueTs is the newest stamp the venue gave
    expect(q2).toMatchObject({ bid: '65085', ask: '65086', mid: '65085.5', mark: '65087', index: '65115', funding: '0.0000125', openInterest: '36159.52766', change24h: '0.003067', venueTs: T0 - 40, recvTs: T0 + 250, seq: 2 });
    hl.feed('bbo', 'BTC').sink.quote({ bid: '65085', bidSize: '1', ask: null, askSize: null, venueTs: T0 + 300 });
    expect(c.of('quote')[2]).toMatchObject({ ask: null, askSize: null, mid: '65075.5', venueTs: T0 + 300, seq: 3 });   // one side gone: the venue's own mid, never (bid + old ask) / 2
    for (const m of c.msgs) for (const [k, v] of Object.entries(m)) if (['bid', 'ask', 'mid', 'mark', 'index', 'funding', 'openInterest'].includes(k)) expect(v === null || typeof v === 'string', k).toBe(true);
  });

  it('quotes are conflated at the hub: at most one message per interval, always the newest state, every sequence number accounted for', () => {
    const hl = fakeUpstream('hyperliquid'), hub = new QuoteHub({ upstreams: [hl.up], quoteMinIntervalMs: 100 }), c = collect();
    hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, c.on);
    const f = hl.feed('ticker', 'BTC');
    for (let k = 0; k < 50; k++) f.sink.quote({ mark: String(65000 + k), venueTs: null });
    expect(c.of('quote').map((q) => q.mark)).toEqual(['65000']);                    // the first at once
    vi.advanceTimersByTime(100);
    expect(c.of('quote').map((q) => q.mark)).toEqual(['65000', '65049']);            // then the newest, once
    vi.advanceTimersByTime(1000);
    expect(c.of('quote').length).toBe(2);                                           // nothing new → nothing sent
    expect(c.of('quote').map((q) => q.seq)).toEqual([1, 2]);
  });

  it('book: snapshot, contiguous deltas with a checksum, and a snapshot again after a gap', () => {
    const hl = fakeUpstream('hyperliquid'), hub = hubOf(hl), c = collect(), mine = clientBook();
    const sub = hub.subscribe({ type: 'book', id: 'hyperliquid:BTC', depth: 5 }, c.on);
    hl.status('connected');
    const f = hl.feed('book', 'BTC');
    f.sink.book({ bids: L(['100', '1'], ['99', '2'], ['98', '3']), asks: L(['101', '1'], ['102', '2']), venueTs: T0 - 5 });
    f.sink.book({ bids: L(['100', '0.4'], ['99', '2'], ['98', '3']), asks: L(['101', '1'], ['102', '2']), venueTs: T0 - 4 });
    f.sink.book({ bids: L(['100', '0.4'], ['99', '2'], ['98', '3']), asks: L(['101', '1'], ['102', '2']), venueTs: T0 - 3 });   // unchanged: no message
    f.sink.book({ bids: L(['99', '2'], ['98', '3'], ['97', '9']), asks: L(['100.5', '5'], ['101', '1'], ['102', '2']), venueTs: T0 - 2 });
    const msgs = c.of('book').map((m) => BookSchema.parse(m));
    expect(msgs.map((m) => [m.kind, m.seq, m.prevSeq])).toEqual([['snapshot', 1, null], ['delta', 2, 1], ['delta', 3, 2]]);
    expect(msgs[1]).toMatchObject({ bids: [['100', '0.4']], asks: [] });
    expect(msgs[2]).toMatchObject({ bids: [['97', '9'], ['100', '0']], asks: [['100.5', '5']], venueTs: T0 - 2, source: 'hyperliquid-ws' });
    for (const m of msgs) mine.apply(m);
    expect(mine.bids).toEqual([['99', '2'], ['98', '3'], ['97', '9']]); expect(mine.asks[0]).toEqual(['100.5', '5']);
    // a late joiner gets the whole book at the current sequence; the next delta follows it
    const snap = sub.snapshot() as BookMsg;
    expect(snap).toMatchObject({ kind: 'snapshot', seq: 3, prevSeq: null, bids: mine.bids, checksum: msgs[2]!.checksum });
    // a gap upstream: the next book restarts from a snapshot (a client that applied everything so far just replaces its copy)
    f.sink.gap('reconnected');
    f.sink.book({ bids: L(['99', '2']), asks: L(['101', '1']), venueTs: T0 });
    const after = c.of('book').at(-1)!;
    expect(after).toMatchObject({ kind: 'snapshot', seq: 4, prevSeq: null }); mine.apply(after);
    expect(hub.stats().counters).toMatchObject({ gaps: 1, book: 4, bookSnapshots: 2 });
    // a client that MISSED a message detects it: the delta's prevSeq is not its last seq
    f.sink.book({ bids: L(['99', '1']), asks: L(['101', '1']), venueTs: T0 });
    const stale = clientBook(); stale.apply(msgs[0]!);
    expect(() => stale.apply(c.of('book').at(-1)!)).toThrow(/gap/);
  });

  it('trades: de-duplicated, oldest first, the first batch flagged as history, 50 kept for late joiners', () => {
    const hl = fakeUpstream('hyperliquid'), hub = hubOf(hl), c = collect();
    const sub = hub.subscribe({ type: 'trades', id: 'hyperliquid:BTC' }, c.on);
    const f = hl.feed('trades', 'BTC'), t = (k: number) => ({ id: `t${k}`, price: String(65000 + k), size: '0.1', side: 'buy' as const, ts: T0 - 1000 + k });
    f.sink.trades([t(2), t(1)]);
    f.sink.trades([t(2), t(3)]);                                                   // t2 again: dropped
    f.sink.trades([t(3)]);                                                         // nothing new: no message
    const msgs = c.of('trade').map((m) => TradeSchema.parse(m));
    expect(msgs.map((m) => m.trades.map((x) => x.id))).toEqual([['t1', 't2'], ['t3']]);
    expect(msgs.map((m) => m.snapshot ?? false)).toEqual([true, false]);
    f.sink.trades(Array.from({ length: 80 }, (_, k) => t(10 + k)));
    const snap = sub.snapshot() as { trades: { id: string }[]; snapshot: boolean };
    expect(snap.trades.length).toBe(50); expect(snap.trades.at(-1)!.id).toBe('t89'); expect(snap.snapshot).toBe(true);
  });

  it('candle: the bar in progress is replaced, an older bar is ignored, an identical bar sends nothing', () => {
    const hl = fakeUpstream('hyperliquid'), hub = hubOf(hl), c = collect();
    hub.subscribe({ type: 'candle', id: 'hyperliquid:BTC', interval: '1m' }, c.on);
    expect(hl.feeds[0]!.spec).toEqual({ kind: 'candle', symbol: 'BTC', interval: '1m' });
    const f = hl.feeds[0]!, bar = (ts: number, close: string) => ({ ts, open: '65000', high: '65100', low: '64900', close, volume: '3.5' });
    f.sink.candle(bar(T0, '65010')); f.sink.candle(bar(T0, '65010')); f.sink.candle(bar(T0, '65020')); f.sink.candle(bar(T0 - 60_000, '64000')); f.sink.candle(bar(T0 + 60_000, '65030'));
    expect(c.of('candle').map((m) => [CandleSchema.parse(m).ts, m.close, m.seq])).toEqual([[T0, '65010', 1], [T0, '65020', 2], [T0 + 60_000, '65030', 3]]);
  });
});

describe('quote hub: validation, isolation, bounds', () => {
  it('refuses what it cannot serve before anything is opened upstream', async () => {
    const hl = fakeUpstream('hyperliquid'), gmx = fakeUpstream('gmx', { book: false }), hub = hubOf(hl, gmx);
    const code = async (ch: Parameters<QuoteHub['validate']>[0]) => hub.validate(ch).then(() => 'ok', (e) => (e as QuoteError).code);
    expect(await code({ type: 'quote', id: 'hyperliquid:BTC' })).toBe('ok');
    expect(await code({ type: 'quote', id: 'hyperliquid:NOPE' })).toBe('unknown_instrument');
    expect(await code({ type: 'quote', id: 'kraken:BTC' })).toBe('unknown_instrument');
    expect(await code({ type: 'quote', id: 'BTC' })).toBe('unknown_instrument');
    expect(await code({ type: 'book', id: 'gmx:BTC' })).toBe('unsupported_channel');   // no order book on GMX
    expect(await code({ type: 'status', id: '*' })).toBe('ok'); expect(await code({ type: 'status', id: 'gmx' })).toBe('ok'); expect(await code({ type: 'status', id: 'nope' })).toBe('unknown_instrument');
    expect(hl.feeds.length + gmx.feeds.length).toBe(0);
  });

  it('a venue that throws, cannot answer or floods costs the others nothing', async () => {
    const dead = fakeUpstream('edgex', { known: async () => { throw new Error('metadata unavailable'); }, failOpen: () => true }), ok = fakeUpstream('hyperliquid'), hub = hubOf(dead, ok), c = collect();
    await expect(hub.validate({ type: 'quote', id: 'edgex:BTC' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(() => hub.subscribe({ type: 'quote', id: 'edgex:BTC' }, () => {})).toThrow(QuoteError);   // open() throws: the channel is not created, nothing leaks
    expect(hub.stats()).toMatchObject({ channels: 0, feeds: 0 });
    hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, () => { throw new Error('a listener that throws'); });
    hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, c.on);
    ok.feed('ticker', 'BTC').sink.quote({ mark: '65000', venueTs: null });
    expect(c.of('quote').length).toBe(1); expect(hub.counters.listenerErrors).toBe(1);
    // an upstream event that the hub cannot digest is counted against ITS venue and goes no further
    ok.feed('ticker', 'BTC').sink.quote({ bid: 'not-a-number', ask: '1', venueTs: null } as never);
    expect(hub.stats().venues.find((v) => v.venue === 'hyperliquid')).toMatchObject({ errors: 1 });
    ok.feed('ticker', 'BTC').sink.quote({ bid: null, ask: null, mark: '65001', venueTs: null });
    expect(c.of('quote').at(-1)).toMatchObject({ mark: '65001' });
  });

  it('memory is bounded: channels in total and upstream feeds per venue', () => {
    const hl = fakeUpstream('hyperliquid', { known: async () => true }), hub = new QuoteHub({ upstreams: [hl.up], maxChannels: 3, maxFeedsPerVenue: 2 });
    hub.subscribe({ type: 'quote', id: 'hyperliquid:A' }, () => {}); hub.subscribe({ type: 'quote', id: 'hyperliquid:B' }, () => {});
    expect(() => hub.subscribe({ type: 'quote', id: 'hyperliquid:C' }, () => {})).toThrow(/upstream subscriptions are already open/);
    expect(hub.stats()).toMatchObject({ channels: 2, feeds: 2 });
    const big = new QuoteHub({ upstreams: [hl.up], maxChannels: 2 });
    big.subscribe({ type: 'quote', id: 'hyperliquid:A' }, () => {}); big.subscribe({ type: 'quote', id: 'hyperliquid:B' }, () => {});
    expect(() => big.subscribe({ type: 'quote', id: 'hyperliquid:C' }, () => {})).toThrow(/already serves 2 channels/);
  });

  it('close() releases every feed and closes every upstream', () => {
    const hl = fakeUpstream('hyperliquid'), hub = hubOf(hl);
    hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, () => {}); hub.subscribe({ type: 'trades', id: 'hyperliquid:BTC' }, () => {});
    hub.close();
    expect(hl.open().length).toBe(0); expect(hl.closed).toBe(true);
    expect(() => hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, () => {})).toThrow(/closed/);
  });
});

describe('quote hub: venue status and staleness', () => {
  it('one status per venue: reconnecting → connected, a gap flag on return, `down` when it does not come back, and the others untouched', () => {
    const hl = fakeUpstream('hyperliquid'), ed = fakeUpstream('edgex'), hub = hubOf(hl, ed), st = collect(), q = collect(), b = collect();
    const s = hub.subscribe({ type: 'status', id: '*' }, st.on);
    expect((s.snapshot() as { venue: string; status: string }[]).map((x) => [x.venue, x.status])).toEqual([['hyperliquid', 'idle'], ['edgex', 'idle']]);
    hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, q.on); hub.subscribe({ type: 'book', id: 'hyperliquid:BTC' }, b.on); hub.subscribe({ type: 'quote', id: 'edgex:BTC' }, () => {});
    hl.status('connected'); ed.status('connected');
    hl.feed('book', 'BTC').sink.book({ bids: L(['100', '1']), asks: L(['101', '1']), venueTs: null });
    hl.feed('ticker', 'BTC').sink.quote({ mark: '100.5', venueTs: null });
    expect(q.of('quote').at(-1)!.stale).toBe(false);
    hl.status('reconnecting', 'socket closed');
    expect(st.of('status').map((m) => `${m.venue}:${m.status}`)).toEqual(['hyperliquid:reconnecting', 'edgex:reconnecting', 'hyperliquid:connected', 'edgex:connected', 'hyperliquid:reconnecting']);
    expect(StatusSchema.parse(st.of('status').at(-1))).toMatchObject({ venue: 'hyperliquid', status: 'reconnecting', detail: 'socket closed', transport: 'stream', source: 'hyperliquid-ws' });
    // what a newcomer is given during the interruption says it is stale; edgeX is not concerned
    expect((hub.snapshotByKey('quote|hyperliquid:BTC|') as { stale: boolean }).stale).toBe(true);
    vi.advanceTimersByTime(31_000);
    expect(st.of('status').filter((m) => m.venue === 'hyperliquid').at(-1)).toMatchObject({ status: 'down' });
    expect(hub.statuses().find((v) => v.venue === 'edgex')!.status).toBe('connected');
    hl.status('stale');                                                           // still troubled: it stays down, it does not flap
    expect(hub.statuses().find((v) => v.venue === 'hyperliquid')!.status).toBe('down');
    hl.status('connected');
    expect(st.of('status').at(-1)).toMatchObject({ venue: 'hyperliquid', status: 'connected' });
    hl.feed('book', 'BTC').sink.book({ bids: L(['100', '2']), asks: L(['101', '1']), venueTs: null });
    expect(b.of('book').at(-1)).toMatchObject({ kind: 'snapshot' });                 // back from an interruption: books restart from a snapshot
    expect(hub.stats().venues.find((v) => v.venue === 'hyperliquid')).toMatchObject({ reconnects: 1, status: 'connected' });
  });

  it('a value older than the cadence of its source is flagged stale in the snapshot, with its age', () => {
    const gmx = fakeUpstream('gmx', { transport: 'poll', staleAfterMs: 20_000 }), hub = hubOf(gmx);
    const s = hub.subscribe({ type: 'quote', id: 'gmx:BTC' }, () => {});
    gmx.status('connected');
    gmx.feed('ticker', 'BTC').sink.quote({ mark: '65000', venueTs: null });
    expect(s.info).toMatchObject({ source: 'gmx-rest', transport: 'poll', staleAfterMs: 20_000 });
    vi.advanceTimersByTime(19_000); expect(s.snapshot()).toMatchObject({ stale: false }); expect(s.snapshotAgeMs()).toBe(19_000);
    vi.advanceTimersByTime(2_000); expect(s.snapshot()).toMatchObject({ stale: true, mark: '65000', recvTs: T0 }); expect(s.snapshotAgeMs()).toBe(21_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------- real clients, recorded frames
const hlData = { instruments: async () => ({ value: [{ symbol: 'BTC' }, { symbol: 'ETH' }] }) } as never;
describe('Hyperliquid upstream: the real stream client on a scripted socket, real frames (recorded 2026-11-15)', () => {
  const rec = recording('hyperliquid-ws');
  const of = (channel: string, coin: string) => rec.messages.filter((m) => m.channel === channel && (m.data?.coin ?? m.data?.s ?? m.data?.[0]?.coin) === coin);
  const setup = () => {
    const stream = createHlStream({ network: 'mainnet', WebSocket: ScriptedSocket as never, random: () => 1 });
    const up = hyperliquidUpstream({ data: hlData, stream, builderCoins: async () => new Map([['xyz:ANT', { isDelisted: false }], ['vntl:OPENAI', { isDelisted: true }]]) });
    return { stream, up, hub: new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }) };
  };

  it('the recording holds bbo, candle, activeAssetCtx, l2Book and trades for BTC and for a builder-dex coin', () => {
    expect(rec.url).toBe('wss://api.hyperliquid.xyz/ws');
    for (const coin of ['BTC', 'xyz:ANT']) for (const ch of ['bbo', 'activeAssetCtx', 'l2Book', 'trades', 'candle']) expect(of(ch, coin).length, `${ch} ${coin}`).toBeGreaterThan(0);
  });

  it('knows the main dex and the live builder-dex coins; a delisted or unknown coin is refused before any subscription', async () => {
    const { hub } = setup();
    await hub.validate({ type: 'quote', id: 'hyperliquid:BTC' }); await hub.validate({ type: 'quote', id: 'hyperliquid:xyz:ANT' });
    await expect(hub.validate({ type: 'quote', id: 'hyperliquid:vntl:OPENAI' })).rejects.toMatchObject({ code: 'unknown_instrument' });
    await expect(hub.validate({ type: 'quote', id: 'hyperliquid:NOPE' })).rejects.toMatchObject({ code: 'unknown_instrument' });
    expect(ScriptedSocket.instances.length).toBe(0);                                // the venue drops the whole connection on an unknown coin: nothing was sent
  });

  it('quote, book, trades and candle of BTC and of xyz:ANT from the recorded frames; reconnect → resubscribe → snapshot', () => {
    const { hub } = setup(), c = collect(), mine = clientBook();
    for (const id of ['hyperliquid:BTC', 'hyperliquid:xyz:ANT']) { hub.subscribe({ type: 'quote', id }, c.on); hub.subscribe({ type: 'trades', id }, c.on); }
    hub.subscribe({ type: 'book', id: 'hyperliquid:BTC', depth: 10 }, c.on); hub.subscribe({ type: 'candle', id: 'hyperliquid:BTC', interval: '1m' }, c.on);
    const s1 = ScriptedSocket.last;
    s1.open();
    const subs = (s: ScriptedSocket) => s.sent.filter((m) => m.method === 'subscribe').map((m) => `${m.subscription.type}:${m.subscription.coin}${m.subscription.interval ? `:${m.subscription.interval}` : ''}`).sort();
    const wanted = ['activeAssetCtx:BTC', 'activeAssetCtx:xyz:ANT', 'bbo:BTC', 'bbo:xyz:ANT', 'candle:BTC:1m', 'l2Book:BTC', 'trades:BTC', 'trades:xyz:ANT'];
    expect(subs(s1)).toEqual(wanted);
    expect(hub.statuses()[0]).toMatchObject({ venue: 'hyperliquid', status: 'connected' });
    for (const m of rec.messages) s1.serve(m);

    const btc = c.of('quote').filter((q) => q.id === 'hyperliquid:BTC'), ant = c.of('quote').filter((q) => q.id === 'hyperliquid:xyz:ANT');
    const bbo = of('bbo', 'BTC').at(-1)!.data, ctx = of('activeAssetCtx', 'BTC').at(-1)!.data.ctx;
    const lastBtc = QuoteSchema.parse(btc.at(-1));
    expect(lastBtc.bid).toBe(String(Number(bbo.bbo[0].px))); expect(lastBtc.ask).toBe(String(Number(bbo.bbo[1].px)));     // "65085.0" on the wire, canonical here
    expect(lastBtc).toMatchObject({ mark: String(Number(ctx.markPx)), index: String(Number(ctx.oraclePx)), funding: ctx.funding, source: 'hyperliquid-ws', last: null });
    expect(lastBtc.venueTs).toBe(Math.max(...of('bbo', 'BTC').map((m) => m.data.time)));                                 // the venue's own time of the best bid / offer
    expect(Number(lastBtc.mid)).toBeCloseTo((Number(bbo.bbo[0].px) + Number(bbo.bbo[1].px)) / 2, 6);
    expect(QuoteSchema.parse(ant.at(-1))).toMatchObject({ id: 'hyperliquid:xyz:ANT', mark: String(Number(of('activeAssetCtx', 'xyz:ANT').at(-1)!.data.ctx.markPx)) });
    const books = c.of('book'); expect(books.length).toBeGreaterThan(0); for (const b of books) mine.apply(BookSchema.parse(b));
    expect(books[0]).toMatchObject({ kind: 'snapshot', depth: 10, venueTs: of('l2Book', 'BTC')[0]!.data.time }); expect(mine.bids.length).toBe(10);
    const trades = c.of('trade').filter((t) => t.id === 'hyperliquid:BTC'); expect(trades[0]!.snapshot).toBe(true); expect(TradeSchema.parse(trades[0]).trades.length).toBeGreaterThan(0);
    const bar = of('candle', 'BTC').at(-1)!.data;
    expect(CandleSchema.parse(c.of('candle').at(-1))).toMatchObject({ id: 'hyperliquid:BTC', interval: '1m', ts: bar.t, close: String(Number(bar.c)), source: 'hyperliquid-ws' });

    // the venue drops the connection
    const st = collect(); hub.subscribe({ type: 'status', id: 'hyperliquid' }, st.on);
    s1.drop();
    expect(st.of('status').at(-1)).toMatchObject({ status: 'reconnecting' });
    expect((hub.snapshotByKey('quote|hyperliquid:BTC|') as { stale: boolean }).stale).toBe(true);
    vi.advanceTimersByTime(1000);                                                   // backoff: 1 s × (0.5 + 0.5 × random) with random = 1
    const s2 = ScriptedSocket.last; expect(s2).not.toBe(s1);
    s2.open();
    expect(subs(s2)).toEqual(wanted);                                               // every subscription sent again
    expect(st.of('status').at(-1)).toMatchObject({ status: 'connected' });
    const n = c.of('book').length;
    s2.serve(of('l2Book', 'BTC').at(-1));
    expect(c.of('book').length).toBe(n + 1); expect(c.of('book').at(-1)).toMatchObject({ kind: 'snapshot', prevSeq: null });   // after a gap: a snapshot, never a delta over a hole
    expect(hub.stats().venues[0]).toMatchObject({ reconnects: 1 }); expect(hub.counters.gaps).toBeGreaterThan(0);
    hub.close();
  });

  it('silence: the client pings every 15 s, the venue turns stale after 25 s without a frame and the connection is re-opened 10 s later', () => {
    const { hub } = setup(), st = collect();
    hub.subscribe({ type: 'status', id: '*' }, st.on); hub.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }, () => {});
    const s1 = ScriptedSocket.last; s1.open();
    vi.advanceTimersByTime(15_000); expect(s1.sent.filter((m) => m.method === 'ping').length).toBe(1);
    vi.advanceTimersByTime(11_000); expect(st.of('status').at(-1)).toMatchObject({ venue: 'hyperliquid', status: 'stale' });
    vi.advanceTimersByTime(10_000); expect(st.of('status').some((m) => m.status === 'reconnecting')).toBe(true); expect(s1.closed).toBe(true);
    hub.close();
  });
});

describe('edgeX and dYdX upstreams: the real stream clients, the frames recorded by the venue adapters\' tests', () => {
  const fixture = (venue: string, name: string) => JSON.parse(readFileSync(new URL(`../../../packages/derivatives/test/fixtures/${venue}/${name}.json`, import.meta.url), 'utf8')) as { url: string; messages: any[] };
  const dataFor = (venue: string, symbol: string, stream: (sub: { type: string; symbol: string }, on: (ev: unknown) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void) => () => void) => ({
    registry: { get: () => ({ id: venue, adapter: { stream, capabilities: { stream: true } }, facts: { hasOrderBook: true } }) }, instruments: async () => ({ value: [{ symbol }] }),
  }) as never;

  it('edgeX: ticker, 15-level depth (snapshot then deltas that rebuild the venue\'s book) and trades of the recorded contract', () => {
    const rec = fixture('edgex', 'ws-public'), A = '30000192';
    const es = new EdgeXStream({ url: rec.url, WebSocket: ScriptedSocket as never, random: () => 1 });
    const up = venueUpstream({ venue: 'edgex', data: dataFor('edgex', 'ANTHROPICUSDC', (sub, on, onStatus) => es.subscribe(sub.type === 'book' ? `depth.${A}.15` : sub.type === 'trades' ? `trades.${A}` : `ticker.${A}`, on as never, onStatus)) });
    const hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect(), mine = clientBook(), id = 'edgex:ANTHROPICUSDC';
    hub.subscribe({ type: 'quote', id }, c.on); hub.subscribe({ type: 'book', id }, c.on); hub.subscribe({ type: 'trades', id }, c.on);
    for (const m of rec.messages) ScriptedSocket.last.serve(m);
    const w = rec.messages.filter((m) => m.channel === `ticker.${A}` && m.type === 'quote-event');
    const q0 = QuoteSchema.parse(c.of('quote')[0]);
    expect(q0).toMatchObject({ id, mark: w[0].content.data[0].markPrice, index: w[0].content.data[0].indexPrice, funding: w[0].content.data[0].fundingRate, last: w[0].content.data[0].lastPrice, source: 'edgex-ws', venueTs: null });
    const books = c.of('book'); expect(books[0]!.kind).toBe('snapshot'); expect(books.some((b) => b.kind === 'delta')).toBe(true);
    for (const b of books) mine.apply(BookSchema.parse(b));                          // every delta follows its predecessor and every checksum holds
    expect(mine.bids.length).toBeGreaterThan(0);
    // with a book open, the quote of this venue shows the book's two sides
    expect(c.of('quote').at(-1)).toMatchObject({ bid: mine.bids[0]![0], ask: mine.asks[0]![0] });
    expect(c.of('trade')[0]).toMatchObject({ snapshot: true, source: 'edgex-ws' });
    expect(hub.statuses()[0]).toMatchObject({ venue: 'edgex', status: 'connected', transport: 'stream' });
    hub.close();
  });

  it('dYdX: v4_markets, v4_orderbook (154 recorded deltas) and v4_trades of BTC-USD; a crossed book is skipped, never repaired', () => {
    const rec = fixture('dydx', 'ws-mainnet-public');
    const ds = new DydxStream({ url: 'wss://indexer.dydx.trade/v4/ws', WebSocket: ScriptedSocket as never });
    const up = venueUpstream({ venue: 'dydx', data: dataFor('dydx', 'BTC-USD', (sub, on, onStatus) => (sub.type === 'book' ? ds.subscribe('v4_orderbook', sub.symbol, null, on as never, onStatus) : sub.type === 'trades' ? ds.subscribe('v4_trades', sub.symbol, null, on as never, onStatus) : ds.subscribe('v4_markets', null, sub.symbol, on as never, onStatus))) });
    const hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect(), mine = clientBook(), id = 'dydx:BTC-USD';
    hub.subscribe({ type: 'quote', id }, c.on); hub.subscribe({ type: 'book', id }, c.on); hub.subscribe({ type: 'trades', id }, c.on);
    for (const m of rec.messages) ScriptedSocket.last.serve(m);
    const market = rec.messages.find((m) => m.channel === 'v4_markets' && m.type === 'subscribed').contents.markets['BTC-USD'];
    // (the book snapshot arrived first in the recording: the first quotes carry the book's two sides only)
    expect(QuoteSchema.parse(c.of('quote').find((q) => q.mark !== null))).toMatchObject({ id, mark: market.oraclePrice, index: market.oraclePrice, openInterest: market.openInterest, source: 'dydx-ws', last: null });
    const books = c.of('book'); expect(books[0]).toMatchObject({ kind: 'snapshot', depth: 20 }); expect(books.length).toBeGreaterThan(20);
    for (const b of books) { mine.apply(BookSchema.parse(b)); expect(cmpDec(b.kind === 'snapshot' ? b.bids[0]![0] : mine.bids[0]![0], mine.asks[0]![0])).toBe(-1); }   // never crossed
    const skipped = hub.stats().venues[0]!.errors;                                   // crossed books the indexer published in the recording
    expect(books.length + skipped).toBeLessThanOrEqual(155);
    expect(c.of('trade')[0]).toMatchObject({ snapshot: true }); expect(TradeSchema.parse(c.of('trade')[0]).trades.length).toBeGreaterThan(10);
    hub.close();
  });

  it('a venue without a stream (GMX) is polled through the data service: a quote only when the figures change, `stale` on a last-good answer, `down` after three failures', async () => {
    let n = 0, mode: 'ok' | 'stale' | 'fail' = 'ok';
    const data = { registry: { get: () => ({ id: 'gmx', adapter: { capabilities: { stream: false } }, facts: { hasOrderBook: false } }) }, instruments: async () => ({ value: [{ symbol: 'BTC/USD [BTC-USDC]' }] }),
      tickers: async () => { if (mode === 'fail') throw new Error('gmx did not answer within 4000 ms'); n += 1; return { value: [{ instrument: 'gmx:BTC/USD [BTC-USDC]', mark: n < 3 ? '65000' : '65010', index: null, mid: null, funding: '0.00001', openInterest: '10', volume24h: null, change24h: null, ts: 1 }], ts: 1, stale: mode === 'stale' }; } } as never;
    const up = venueUpstream({ venue: 'gmx', data, pollMs: 3_000 }), hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect(), id = 'gmx:BTC/USD [BTC-USDC]';
    expect(up.feedsFor('book', 'x', '1m')).toEqual([]); expect(up.feedsFor('trades', 'x', '1m')).toEqual([]);
    await hub.validate({ type: 'quote', id });
    const sub = hub.subscribe({ type: 'quote', id }, c.on);
    expect(sub.info).toMatchObject({ source: 'gmx-rest', transport: 'poll', staleAfterMs: QUOTE_CADENCE_MS['gmx-rest'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.of('quote').length).toBe(1); expect(hub.statuses()[0]).toMatchObject({ status: 'connected', transport: 'poll' });
    await vi.advanceTimersByTimeAsync(3_000); expect(c.of('quote').length).toBe(1);   // same figures: nothing sent
    await vi.advanceTimersByTimeAsync(3_000); expect(c.of('quote').at(-1)).toMatchObject({ mark: '65010', seq: 2 });
    mode = 'stale'; await vi.advanceTimersByTimeAsync(3_000);
    expect(hub.statuses()[0]).toMatchObject({ status: 'stale' }); expect(c.of('quote').length).toBe(2);   // a last-good answer is not re-published as new
    mode = 'fail'; await vi.advanceTimersByTimeAsync(9_000);
    expect(hub.statuses()[0]).toMatchObject({ status: 'down' });
    mode = 'ok'; await vi.advanceTimersByTimeAsync(3_000);
    expect(hub.statuses()[0]).toMatchObject({ status: 'connected' });
    sub.unsubscribe(); hub.close();
  });
});

describe('spot upstream: Coinbase Exchange websocket (real frames) and the polled price module', () => {
  const rec = recording('coinbase-ws');
  const pairs = (s: string) => ({ BTC: 'BTC-USD', ETH: 'ETH-USD' } as Record<string, string>)[s];

  it('ticker frames become quotes with the venue\'s own time; reconnect with backoff + jitter, resubscribe, gap', async () => {
    const randoms = [0, 1]; let r = 0;
    const up = spotUpstream({ WebSocket: ScriptedSocket as never, pairs, random: () => randoms[r++ % 2]!, backoffMinMs: 1000 });
    const hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect(), st = collect();
    await hub.validate({ type: 'quote', id: 'spot:BTC' });
    await expect(hub.validate({ type: 'quote', id: 'spot:NOPE' })).rejects.toMatchObject({ code: 'unknown_instrument' });
    await expect(hub.validate({ type: 'book', id: 'spot:BTC' })).rejects.toMatchObject({ code: 'unsupported_channel' });
    hub.subscribe({ type: 'status', id: 'spot' }, st.on);
    hub.subscribe({ type: 'quote', id: 'spot:BTC' }, c.on); hub.subscribe({ type: 'quote', id: 'spot:ETH' }, c.on);
    const s1 = ScriptedSocket.last; expect(s1.url).toBe('wss://ws-feed.exchange.coinbase.com');
    s1.open();
    expect(s1.sent[0]).toEqual({ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker', 'heartbeat'] });
    for (const m of rec.messages) s1.serve(m);
    const w = rec.messages.filter((m) => m.type === 'ticker' && m.product_id === 'BTC-USD'), last = w.at(-1)!;
    const q = QuoteSchema.parse(c.of('quote').filter((x) => x.id === 'spot:BTC').at(-1));
    expect(q).toMatchObject({ source: 'coinbase-ws', venueTs: Date.parse(last.time), mark: null, index: null, funding: null, openInterest: null });
    expect(Number(q.bid)).toBe(Number(last.best_bid)); expect(Number(q.ask)).toBe(Number(last.best_ask)); expect(Number(q.last)).toBe(Number(last.price)); expect(Number(q.askSize)).toBe(Number(last.best_ask_size));
    expect(Number(q.change24h)).toBeCloseTo(Number(last.price) / Number(last.open_24h) - 1, 5);
    expect(c.of('quote').filter((x) => x.id === 'spot:BTC').length).toBe(w.length);
    expect((up.stats!() as any).coinbase).toMatchObject({ tickers: rec.messages.filter((m) => m.type === 'ticker').length, errors: 1 });   // the recorded "NOPE-USD is not a valid product"
    s1.serve({ type: 'ticker', product_id: 'BTC-USD', price: 'NaN', best_bid: '1', best_bid_size: '1', best_ask: '2', best_ask_size: '1' });   // a malformed frame is dropped, never half a quote
    expect(c.of('quote').filter((x) => x.id === 'spot:BTC').length).toBe(w.length);

    s1.drop();
    expect(st.of('status').at(-1)).toMatchObject({ status: 'reconnecting', source: 'coinbase-ws' });
    vi.advanceTimersByTime(499); expect(ScriptedSocket.last).toBe(s1);
    vi.advanceTimersByTime(1);                                                      // first retry: 1 s × (0.5 + 0.5 × 0) = 500 ms
    const s2 = ScriptedSocket.last; expect(s2).not.toBe(s1);
    s2.drop();                                                                      // refused again: the next delay doubles — 2 s × (0.5 + 0.5 × 1)
    vi.advanceTimersByTime(1999); expect(ScriptedSocket.last).toBe(s2);
    vi.advanceTimersByTime(1);
    const s3 = ScriptedSocket.last; s3.open();
    expect(s3.sent[0]).toEqual({ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker', 'heartbeat'] });
    expect(st.of('status').at(-1)).toMatchObject({ status: 'connected' }); expect(hub.counters.gaps).toBe(2);
    hub.close(); expect(s3.closed).toBe(true);
  });

  it('a symbol Coinbase does not list is polled from the wallet\'s price module, with that module\'s own date and stale flag', async () => {
    let px: Record<string, { usd: number; priceAt: string; stale: boolean; change24h: number }> | null = { WBTC: { usd: 64990.12, priceAt: '2026-11-15T11:58:00.000Z', stale: false, change24h: 1.25 } };
    const up = spotUpstream({ WebSocket: ScriptedSocket as never, pairs, prices: async () => px, geckoPollMs: 60_000 }), hub = new QuoteHub({ upstreams: [up], quoteMinIntervalMs: 0 }), c = collect();
    await hub.validate({ type: 'quote', id: 'spot:WBTC' });
    const sub = hub.subscribe({ type: 'quote', id: 'spot:WBTC' }, c.on);
    expect(sub.info).toMatchObject({ source: 'coingecko-rest', transport: 'poll', staleAfterMs: 900_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.of('quote')[0]).toMatchObject({ last: '64990.12', change24h: '0.0125', bid: null, ask: null, mid: null, venueTs: Date.parse('2026-11-15T11:58:00.000Z'), source: 'coingecko-rest', stale: false });
    await vi.advanceTimersByTimeAsync(60_000); expect(c.of('quote').length).toBe(1);   // the same price with the same date is not a new quote
    px = { WBTC: { ...px.WBTC!, stale: true } }; await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.statuses()[0]).toMatchObject({ venue: 'spot', status: 'stale' });
    px = null; await vi.advanceTimersByTimeAsync(60_000);                             // prices switched off: no message, a status
    expect(c.of('quote').length).toBe(1); expect(ScriptedSocket.instances.length).toBe(0);
    hub.close();
  });
});

describe('reconnecting websocket client', () => {
  it('heartbeat watchdog: stale after the quiet period, re-opened after the grace; a connection that lasted resets the backoff', () => {
    const status: string[] = [], opens: boolean[] = [];
    const ws = createReconnectingWs({ url: 'wss://x.invalid', WebSocket: ScriptedSocket as never, random: () => 1, staleAfterMs: 20_000, staleGraceMs: 10_000, pingIntervalMs: 5_000, ping: () => '{"op":"ping"}', onOpen: (again) => opens.push(again), onMessage: () => {}, onStatus: (s) => status.push(s) });
    expect(ws.send({ a: 1 })).toBe(false);
    ws.start(); ws.start();
    expect(ScriptedSocket.instances.length).toBe(1);
    const s1 = ScriptedSocket.last; s1.open(); expect(ws.send({ a: 1 })).toBe(true);
    vi.advanceTimersByTime(5_000); expect(s1.sent).toEqual([{ a: 1 }, { op: 'ping' }]);
    vi.advanceTimersByTime(16_000); expect(status).toEqual(['connected', 'stale']);
    s1.serve('{}'); expect(status).toEqual(['connected', 'stale', 'connected']);     // a frame on the same connection: live again, no gap
    vi.advanceTimersByTime(31_000); expect(status.at(-1)).toBe('reconnecting'); expect(s1.closed).toBe(true);
    vi.advanceTimersByTime(1_000);                                                   // the connection lasted > 10 s: the backoff restarted from its minimum
    const s2 = ScriptedSocket.last; expect(s2).not.toBe(s1); s2.open();
    expect(opens).toEqual([false, true]); expect(ws.stats()).toMatchObject({ connects: 2, reconnects: 1, status: 'connected' });
    ws.stop(); expect(s2.closed).toBe(true);
    vi.advanceTimersByTime(60_000); expect(ScriptedSocket.instances.length).toBe(2);   // stopped: no more attempts
  });
});

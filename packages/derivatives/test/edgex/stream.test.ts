/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/edgex/stream.test.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// edgeX public websocket client against REAL frames recorded on 2026-11-15/16 UTC (test/fixtures/edgex/ws-public.json:
// 20 s of the ANTHROPICUSDC ticker / depth / trades channels and of ticker.all.1s, with the server pings and an error frame).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { book as bookSchema, publicTrade, ticker, wsFx, FakeSocket } from '../venue-helpers.ts';
import { createEdgeXAdapter, D, EdgeXStream, VenueError, type EdgeXStreamEvent } from '../../src/index.ts';
import { fx, replay } from '../venue-helpers.ts';

const REC = wsFx('edgex', 'ws-public');
const A = '30000192', BTC = '30000001';
const CH = { ticker: `ticker.${A}`, depth: `depth.${A}.15`, trades: `trades.${A}`, all: 'ticker.all.1s', btcTrades: `trades.${BTC}` };
const frames = (channel: string) => REC.messages.filter((m) => m.channel === channel && m.type === 'quote-event') as any[];
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function setup(o: Partial<ConstructorParameters<typeof EdgeXStream>[0]> = {}) {
  const s = new EdgeXStream({ url: REC.url, WebSocket: FakeSocket as never, random: () => 1, ...o });
  const events: Record<string, EdgeXStreamEvent[]> = {}, status: Record<string, string[]> = {};
  const sub = (channel: string) => { events[channel] = []; status[channel] = []; return s.subscribe(channel, (ev) => events[channel]!.push(ev), (st) => status[channel]!.push(st)); };
  return { s, events, status, sub };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse(REC.recordedAt)); FakeSocket.reset(); });
afterEach(() => { vi.useRealTimers(); });

describe('edgeX stream: the recorded session, frame for frame', () => {
  it('the recording holds what the tests rely on', () => {
    expect(REC.url).toBe('wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws');
    expect(REC.messages[0]).toMatchObject({ type: 'connected' });
    expect(REC.sent.slice(0, 2)).toEqual([{ type: 'subscribe', channel: CH.ticker }, { type: 'subscribe', channel: CH.depth }]);
    expect(frames(CH.ticker)[0].content.dataType).toBe('Snapshot'); expect(frames(CH.ticker)[1].content.dataType).toBe('changed');   // lowercase, unlike the docs
    expect(frames(CH.depth).length).toBeGreaterThan(5); expect(frames(CH.all).length).toBe(3);
    expect(REC.messages.filter((m) => m.type === 'ping').length).toBeGreaterThanOrEqual(1);
    expect(REC.messages.some((m) => m.type === 'error')).toBe(true);
  });

  it('subscribes after `connected`, answers every ping with the same time, and normalises every frame', () => {
    const { s, events, status, sub } = setup();
    for (const c of Object.values(CH)) sub(c);
    const sock = FakeSocket.last;
    expect(FakeSocket.instances.length).toBe(1);                                                        // one connection for every channel
    expect(sock.sent).toEqual([]);                                                                      // nothing before the server says `connected`
    for (const m of REC.messages) sock.serve(m);
    expect(sock.sent.slice(0, 5)).toEqual(Object.values(CH).map((channel) => ({ type: 'subscribe', channel })));
    const pings = REC.messages.filter((m) => m.type === 'ping');
    expect(sock.sent.filter((m) => m.type === 'pong')).toEqual(pings.map((p) => ({ type: 'pong', time: p.time })));
    expect(s.stats()).toMatchObject({ connects: 1, invalid: 0, resyncs: 0, pongs: pings.length, status: 'connected', channels: 5 });
    for (const c of Object.values(CH)) expect(status[c]).toEqual(['connected']);

    // ticker: snapshot then increments
    const tk = events[CH.ticker]!.filter((e) => e.type === 'ticker') as Extract<EdgeXStreamEvent, { type: 'ticker' }>[];
    expect(tk.length).toBe(frames(CH.ticker).length);
    expect(tk.map((e) => e.snapshot)).toEqual([true, ...Array(tk.length - 1).fill(false)]);
    const w0 = frames(CH.ticker)[0].content.data[0];
    expect(ticker.parse(tk[0]!.ticker)).toMatchObject({ instrument: 'edgex:ANTHROPICUSDC', mark: w0.markPrice, index: w0.indexPrice, openInterest: w0.openInterest, volume24h: w0.value, nextFundingTs: Number(w0.nextFundingTime) });
    expect(tk[0]!.ticker.mid).toBe(D.str(D.div(D.add(D.from(w0.bestBidPrice), D.from(w0.bestAskPrice)), D.from(2n), 18, 'half_even')));
    expect(tk[1]!.ticker.mid).toBeNull();                                                               // increments carry no best bid / ask: no mid is invented

    // depth: a 15-level book maintained from the snapshot and the increments, never crossed
    const bk = events[CH.depth]!.filter((e) => e.type === 'book') as Extract<EdgeXStreamEvent, { type: 'book' }>[];
    expect(bk.length).toBe(frames(CH.depth).length);
    for (const e of bk) {
      const b = bookSchema.parse(e.book);
      expect(b.bids.length).toBe(15); expect(b.asks.length).toBe(15);
      expect(D.lt(D.from(b.bids[0]![0]), D.from(b.asks[0]![0]))).toBe(true);
      for (let k = 1; k < 15; k++) { expect(D.gt(D.from(b.bids[k - 1]![0]), D.from(b.bids[k]![0]))).toBe(true); expect(D.lt(D.from(b.asks[k - 1]![0]), D.from(b.asks[k]![0]))).toBe(true); }
    }
    const snap = frames(CH.depth)[0].content.data[0];
    expect(bk[0]!.book.asks[0]).toEqual([D.str(D.from(snap.asks[0].price)), D.str(D.from(snap.asks[0].size))]);

    // trades: the snapshot of recent trades, then one by one; the taker side from isBuyerMaker
    const tr = events[CH.trades]!.filter((e) => e.type === 'trades') as Extract<EdgeXStreamEvent, { type: 'trades' }>[];
    const wt = frames(CH.trades)[0].content.data;
    expect(tr[0]!.snapshot).toBe(true); expect(tr[0]!.trades.length).toBe(wt.length);
    for (const t of tr.flatMap((e) => e.trades)) publicTrade.parse(t);
    const first = wt.find((x: any) => x.ticketId === tr[0]!.trades.at(-1)!.id);
    expect(tr[0]!.trades.at(-1)).toMatchObject({ instrument: 'edgex:ANTHROPICUSDC', side: first.isBuyerMaker ? 'sell' : 'buy', ts: Number(first.time) });
    expect(s.recentTrades(CH.trades)!.length).toBe(Math.min(100, frames(CH.trades).reduce((n, f) => n + f.content.data.length, 0)));
    expect(s.recentTrades('trades.1')).toBeNull();

    // every contract at once
    const all = events[CH.all]!.filter((e) => e.type === 'tickers') as Extract<EdgeXStreamEvent, { type: 'tickers' }>[];
    expect(all.length).toBe(3);
    expect(all[0]!.tickers.map((t) => t.instrument)).toContain('edgex:ANTHROPICUSDC');
    for (const t of all.flatMap((e) => e.tickers)) ticker.parse(t);

    // the venue refused "bogus.channel", a channel nobody here holds: every consumer hears about it
    expect(events[CH.ticker]!.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'GATEWAY_INVALID_CHANNEL: invalid channel : bogus.channel' }]);
  });
});

describe('edgeX stream: gaps, reconnection, staleness', () => {
  it('a hole in the depth versions is a gap: nothing is patched, the channel is subscribed again', () => {
    const { s, events, sub } = setup();
    sub(CH.depth);
    const sock = FakeSocket.last, d = frames(CH.depth);
    sock.serve({ type: 'connected', sid: 'x' }); sock.serve(d[0]); sock.serve(d[1]);
    sock.serve(d[3]);                                                                                   // d[2] was lost
    expect(events[CH.depth]!.map((e) => e.type)).toEqual(['book', 'book', 'gap']);
    expect(events[CH.depth]!.at(-1)).toEqual({ type: 'gap', reason: 'book_sequence' });
    expect(sock.sent.slice(-2)).toEqual([{ type: 'unsubscribe', channel: CH.depth }, { type: 'subscribe', channel: CH.depth }]);
    sock.serve(d[4]);                                                                                   // an increment before the new snapshot is ignored
    expect(events[CH.depth]!.length).toBe(3);
    sock.serve(d[0]);                                                                                   // the fresh snapshot
    expect(events[CH.depth]!.at(-1)).toMatchObject({ type: 'book', snapshot: true });
    expect(s.stats().resyncs).toBe(1);
  });

  it('a crossed book or a malformed depth frame is not emitted: invalid + gap + fresh subscription', () => {
    const { events, sub } = setup();
    sub(CH.depth);
    const sock = FakeSocket.last, d = frames(CH.depth);
    sock.serve({ type: 'connected', sid: 'x' }); sock.serve(d[0]);
    const crossed = clone(d[1]); crossed.content.data[0].bids = [{ price: '999999', size: '1' }];
    sock.serve(crossed);
    expect(events[CH.depth]!.map((e) => e.type)).toEqual(['book', 'invalid', 'gap']);
    expect((events[CH.depth]![1] as any).reason).toMatch(/crossed book/);
    sock.serve(d[0]);
    const nan = clone(d[1]); nan.content.data[0].asks[0].price = 'NaN';
    sock.serve(nan);
    expect(events[CH.depth]!.map((e) => e.type)).toEqual(['book', 'invalid', 'gap', 'book', 'invalid', 'gap']);
  });

  it('a lost connection: reconnecting → backoff → connected, every channel subscribed again, consumers told of the gap', () => {
    const { s, events, status, sub } = setup();
    sub(CH.ticker); sub(CH.trades);
    const one = FakeSocket.last;
    one.serve({ type: 'connected', sid: 'a' }); one.serve(frames(CH.trades)[0]);
    one.drop();
    expect(status[CH.ticker]).toEqual(['connected', 'reconnecting']);
    expect(s.recentTrades(CH.trades)).toBeNull();                                                       // not live any more
    vi.advanceTimersByTime(999); expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(2); expect(FakeSocket.instances.length).toBe(2);                            // backoff 1 s
    const two = FakeSocket.last;
    two.drop();                                                                                         // refused again: the delay doubles
    vi.advanceTimersByTime(1_999); expect(FakeSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(2); expect(FakeSocket.instances.length).toBe(3);
    const three = FakeSocket.last;
    three.serve({ type: 'connected', sid: 'b' });
    expect(three.sent).toEqual([{ type: 'subscribe', channel: CH.ticker }, { type: 'subscribe', channel: CH.trades }]);
    expect(status[CH.ticker]).toEqual(['connected', 'reconnecting', 'connected']);
    expect(events[CH.ticker]!.at(-1)).toEqual({ type: 'gap', reason: 'reconnected' });
    // the snapshot after the reconnection repeats trades already delivered: none is emitted twice
    const before = events[CH.trades]!.filter((e) => e.type === 'trades').flatMap((e: any) => e.trades).length;
    three.serve(frames(CH.trades)[0]);
    expect(events[CH.trades]!.filter((e) => e.type === 'trades').flatMap((e: any) => e.trades).length).toBe(before);
    expect(s.stats().duplicates).toBe(frames(CH.trades)[0].content.data.length);
    expect(s.recentTrades(CH.trades)!.length).toBe(before);
  });

  it('silence: stale after 25 s without any frame (the server pings every 10 s), reconnection 10 s later; a frame in between recovers', () => {
    const { status, sub } = setup();
    sub(CH.ticker);
    const sock = FakeSocket.last;
    sock.serve({ type: 'connected', sid: 'a' });
    vi.advanceTimersByTime(24_000); expect(status[CH.ticker]).toEqual(['connected']);
    vi.advanceTimersByTime(2_500); expect(status[CH.ticker]).toEqual(['connected', 'stale']);
    sock.serve({ type: 'ping', time: '1' });
    expect(status[CH.ticker]).toEqual(['connected', 'stale', 'connected']);
    expect(sock.sent.at(-1)).toEqual({ type: 'pong', time: '1' });
    vi.advanceTimersByTime(36_500);
    expect(status[CH.ticker]).toEqual(['connected', 'stale', 'connected', 'stale', 'reconnecting']);
    expect(sock.closed).toBe(true);
  });

  it('malformed frames are dropped and reported; no NaN and no partial object reaches a consumer', () => {
    const { s, events, sub } = setup();
    sub(CH.ticker); sub(CH.all); sub(CH.trades);
    const sock = FakeSocket.last;
    sock.serve({ type: 'connected', sid: 'a' });
    sock.serve('<html>502 Bad Gateway</html>');
    sock.serve('{"no":"type"}');
    expect(events[CH.ticker]!.map((e) => e.type)).toEqual(['invalid', 'invalid']);
    for (const bad of ['NaN', '1e5', '']) { const f = clone(frames(CH.ticker)[0]); f.content.data[0].markPrice = bad; sock.serve(f); }
    expect(events[CH.ticker]!.filter((e) => e.type === 'ticker')).toEqual([]);
    expect(events[CH.ticker]!.filter((e) => e.type === 'invalid').length).toBe(5);
    const all = clone(frames(CH.all)[0]); all.content.data[0].markPrice = 'NaN';
    sock.serve(all);
    const got = events[CH.all]!.find((e) => e.type === 'tickers') as Extract<EdgeXStreamEvent, { type: 'tickers' }>;
    expect(got.tickers.length).toBe(all.content.data.length - 1);                                       // the others are still delivered
    expect(events[CH.all]!.some((e) => e.type === 'invalid' && /1 ticker/.test(e.reason))).toBe(true);
    const tr = clone(frames(CH.trades)[0]); tr.content.data[0].size = '-'; sock.serve(tr);
    expect(events[CH.trades]!.filter((e) => e.type === 'trades')).toEqual([]);
    const other = clone(frames(CH.btcTrades)[0]); other.channel = CH.trades; sock.serve(other);         // trades of another contract on our channel
    expect(events[CH.trades]!.filter((e) => e.type === 'trades')).toEqual([]);
    expect(s.stats().invalid).toBeGreaterThanOrEqual(8);
  });

  it('subscriptions are reference-counted; a late joiner gets the current state; the last one out closes the connection', async () => {
    const { s, sub } = setup();
    const off1 = sub(CH.depth);
    const sock = FakeSocket.last;
    sock.serve({ type: 'connected', sid: 'a' }); sock.serve(frames(CH.depth)[0]);
    const late: EdgeXStreamEvent[] = [], st: string[] = [];
    const off2 = s.subscribe(CH.depth, (e) => late.push(e), (x) => st.push(x));
    await Promise.resolve();
    expect(st).toEqual(['connected']);
    expect(late).toMatchObject([{ type: 'book', snapshot: true, symbol: 'ANTHROPICUSDC' }]);
    expect(sock.sent.filter((m) => m.type === 'subscribe').length).toBe(1);
    off1(); off1();
    expect(sock.closed).toBe(false);
    off2();
    expect(sock.sent.at(-1)).toEqual({ type: 'unsubscribe', channel: CH.depth });
    expect(sock.closed).toBe(true); expect(s.stats()).toMatchObject({ channels: 0, status: 'idle' });
  });

  it('refuses unknown channels and private ones; reports a missing WebSocket implementation', () => {
    const { s } = setup();
    for (const c of ['account', 'depth.1.50', 'kline.LAST_PRICE.1.MINUTE_1', 'ticker.all', '../private/ws', 'trades.x']) expect(() => s.subscribe(c, () => {}, () => {})).toThrow(VenueError);
    const none = new EdgeXStream({ url: REC.url, WebSocket: null });
    expect(none.available).toBe(false);
    expect(() => none.subscribe(CH.ticker, () => {}, () => {})).toThrow(/no WebSocket/);
  });
});

describe('edgeX adapter.stream(): the contract id comes from the metadata', () => {
  it('book / trades / ticker subscriptions name the channel by the live contract id; an unknown symbol is reported, not guessed', async () => {
    vi.useRealTimers();
    const r = replay([['/meta/getMetaData', fx('edgex', 'metaData')], ['/contract-labels', fx('edgex', 'contract-labels')]]);
    const a = createEdgeXAdapter({ fetch: r.fetch, WebSocket: FakeSocket as never });
    const got: any[] = [], st: string[] = [];
    const offs = (['book', 'trades', 'ticker'] as const).map((type) => a.stream({ type, symbol: 'ANTHROPICUSDC' }, (e) => got.push(e), (x) => st.push(x)));
    await new Promise((res) => setTimeout(res, 20));
    const sock = FakeSocket.last;
    sock.serve({ type: 'connected', sid: 'a' });
    expect(sock.sent).toEqual([{ type: 'subscribe', channel: CH.depth }, { type: 'subscribe', channel: CH.trades }, { type: 'subscribe', channel: CH.ticker }]);
    sock.serve(frames(CH.depth)[0]); sock.serve(frames(CH.trades)[0]); sock.serve(frames(CH.ticker)[0]);
    expect(got.map((e) => e.type)).toEqual(['book', 'trades', 'ticker']);                               // the shapes the data service consumes: { type, book | trades | ticker }
    expect(got[0].book.instrument).toBe('edgex:ANTHROPICUSDC'); expect(got[1].trades.length).toBeGreaterThan(0); expect(got[2].ticker.instrument).toBe('edgex:ANTHROPICUSDC');
    const bad: any[] = [], badSt: string[] = [];
    a.stream({ type: 'ticker', symbol: 'NOPEUSDC' }, (e) => bad.push(e), (x) => badSt.push(x));
    await new Promise((res) => setTimeout(res, 20));
    expect(bad).toMatchObject([{ type: 'error' }]); expect(bad[0].message).toMatch(/unknown contract/); expect(badSt).toEqual(['stale']);
    expect(() => a.stream({ type: 'book', symbol: 'not a symbol' }, () => {}, () => {})).toThrow(VenueError);
    const early = a.stream({ type: 'ticker', symbol: 'BTCUSDC' }, () => {}, () => {}); early();          // cancelled before the metadata answered: nothing is subscribed
    await new Promise((res) => setTimeout(res, 20));
    expect(sock.sent.some((m) => m.channel === `ticker.${BTC}`)).toBe(false);
    for (const off of offs) off();
    expect(sock.closed).toBe(true);
    a.close();
  });
});

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/quotes.test.ts
 * Module           : web
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

// V11 live quotes — the tab's websocket client (src/quotes.ts) on a scripted socket, a manual animation frame and fake timers:
// lazy connection, one socket for every subscriber, reconnect with backoff + jitter, resubscribe, heartbeat watchdog, tab
// visibility, fallback, one commit per frame whatever the number of ticks, book integrity (sequence + checksum → resync),
// freshness re-evaluated with the local clock. Then the helpers of the screens and the `qt` block of i18n.ts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookChecksum, type Level } from '../../../services/api/src/quotes/shared';
import { liveSpreadBps } from '../src/derivatives/Compare';
import { CLIENT, freshnessOf, QuoteClient, type Env, type LiveBook, type LiveQuote, type LiveTrade, type SocketLike } from '../src/quotes';
import { overlaySpot } from '../src/quotes-spot';
import { annualisedOf, liveIdOf, livePriceOf } from '../src/screens/Markets';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');
const T0 = Date.parse('2026-11-15T12:00:00Z');

class Sock implements SocketLike {
  static all: Sock[] = []; static failNext = 0;
  sent: any[] = []; readyState = 0; closed = false;
  onopen: ((ev: unknown) => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null; onclose: ((ev: { code?: number }) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { if (Sock.failNext > 0) { Sock.failNext -= 1; throw new Error('blocked'); } Sock.all.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; this.readyState = 3; }
  // --- the test's side
  accept(): void { this.readyState = 1; this.onopen?.({}); this.serve({ v: 1, type: 'hello', connId: 'c', heartbeatMs: 15_000, serverTs: Date.now(), limits: { maxSubscriptions: 300, maxFrameBytes: 16384, maxMessagesPerSec: 20, idleTimeoutMs: 120_000 } }); }
  serve(m: unknown): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }
  subs(op = 'subscribe'): string[] { return this.sent.filter((m) => m.op === op).flatMap((m) => m.channels.map((c: any) => `${c.type}:${c.id}${c.depth ? `:${c.depth}` : ''}`)); }
}
const last = () => Sock.all.at(-1)!;
function setup(o: { random?: () => number } = {}) {
  const frames: (() => void)[] = []; let hidden = false; const vis = new Set<() => void>();
  const env: Env = { WebSocket: Sock, url: () => 'wss://wallet.test/api/v1/stream', now: () => Date.now(), random: o.random ?? (() => 1), raf: (f) => { frames.push(f); },
    visibility: { hidden: () => hidden, on: (f) => { vis.add(f); return () => vis.delete(f); } } };
  const c = new QuoteClient(env);
  return { c, frame: () => { const n = frames.length; for (const f of frames.splice(0)) f(); return n; }, pendingFrames: () => frames.length, setHidden: (h: boolean) => { hidden = h; for (const f of [...vis]) f(); }, visListeners: () => vis.size };
}
const quote = (id: string, mark: string, seq: number, extra: Record<string, unknown> = {}) => ({ v: 1, type: 'quote', id, bid: null, bidSize: null, ask: null, askSize: null, mid: null, mark, index: null, last: null, funding: null, openInterest: null, change24h: null, volume24h: null, venueTs: null, recvTs: Date.now(), seq, source: 'hyperliquid-ws', stale: false, ...extra });
const book = (kind: 'snapshot' | 'delta', seq: number, prevSeq: number | null, bids: Level[], asks: Level[], after: { bids: Level[]; asks: Level[] }) => ({ v: 1, type: 'book', id: 'hyperliquid:BTC', depth: 20, kind, bids, asks, seq, prevSeq, checksum: bookChecksum(after.bids, after.asks), venueTs: null, recvTs: Date.now(), source: 'hyperliquid-ws', stale: false });
const subscribed = (key: string, snapshot: unknown = null, snapshotAgeMs: number | null = null, staleAfterMs = 15_000) => ({ v: 1, type: 'subscribed', channel: {}, key, staleAfterMs, source: 'hyperliquid-ws', snapshot, snapshotAgeMs });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); Sock.all = []; Sock.failNext = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('one lazy connection per tab', () => {
  it('nothing is opened before the first subscriber; every subscriber shares the socket; it closes a moment after the last one leaves', () => {
    const { c, frame, visListeners } = setup();
    expect(Sock.all.length).toBe(0); expect(c.state()).toBe('idle');
    const a = c.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }), b = c.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }), d = c.subscribe({ type: 'book', id: 'hyperliquid:BTC', depth: 20 });
    expect(Sock.all.length).toBe(1); expect(last().url).toBe('wss://wallet.test/api/v1/stream'); expect(c.state()).toBe('connecting'); expect(visListeners()).toBe(1);
    expect(last().sent).toEqual([]);                                               // nothing before the server says hello
    last().accept(); frame();
    expect(c.state()).toBe('live');
    expect(last().sent).toEqual([{ v: 1, op: 'subscribe', channels: [{ type: 'status', id: '*' }, { type: 'quote', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 20 }] }]);   // one frame, each channel once; the venue statuses always come along
    const e = c.subscribe({ type: 'trades', id: 'hyperliquid:BTC' }), f = c.subscribe({ type: 'quote', id: 'dydx:BTC-USD' });
    vi.advanceTimersByTime(0);
    expect(last().sent[1]).toEqual({ v: 1, op: 'subscribe', channels: [{ type: 'trades', id: 'hyperliquid:BTC' }, { type: 'quote', id: 'dydx:BTC-USD' }] });   // later subscriptions of one turn: one frame
    a(); a();
    vi.advanceTimersByTime(CLIENT.lingerMs + 1); expect(last().subs('unsubscribe')).toEqual([]);   // `b` still holds the quote
    b(); e(); f();
    vi.advanceTimersByTime(1000);
    const again = c.subscribe({ type: 'trades', id: 'hyperliquid:BTC' });           // back within the linger (a screen change): no unsubscribe, no new subscribe
    vi.advanceTimersByTime(CLIENT.lingerMs + 1);
    expect(last().subs('unsubscribe').sort()).toEqual(['quote:dydx:BTC-USD', 'quote:hyperliquid:BTC']); expect(last().subs().filter((s) => s === 'trades:hyperliquid:BTC').length).toBe(1);
    again(); d();
    vi.advanceTimersByTime(CLIENT.lingerMs + 1); frame();
    expect(last().closed).toBe(true); expect(c.state()).toBe('idle'); expect(visListeners()).toBe(0);
    vi.advanceTimersByTime(120_000); expect(Sock.all.length).toBe(1);               // no timer left behind
  });
});

describe('reconnection', () => {
  it('backoff with jitter, every subscription sent again, books restart from a snapshot, refused channels are not asked again', () => {
    const rnd = [0, 1, 0.5]; let k = 0;
    const { c, frame } = setup({ random: () => rnd[k++ % rnd.length]! });
    c.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }); c.subscribe({ type: 'book', id: 'hyperliquid:BTC', depth: 20 }); c.subscribe({ type: 'quote', id: 'hyperliquid:NOPE' });
    const s1 = last(); s1.accept();
    s1.serve({ v: 1, type: 'error', code: 'unknown_instrument', message: 'unknown', channel: { type: 'quote', id: 'hyperliquid:NOPE' } });
    const full = { bids: [['100', '1'], ['99', '2']] as Level[], asks: [['101', '1']] as Level[] };
    s1.serve(book('snapshot', 1, null, full.bids, full.asks, full)); s1.serve(quote('hyperliquid:BTC', '100.5', 1)); frame();
    expect(c.refusal({ type: 'quote', id: 'hyperliquid:NOPE' })).toBe('unknown_instrument');
    s1.drop(); frame();
    expect(c.state()).toBe('reconnecting');
    expect(c.get<LiveQuote>('quote|hyperliquid:BTC|')!.mark).toBe('100.5');          // the last value stays on screen — with its age
    vi.advanceTimersByTime(499); expect(Sock.all.length).toBe(1);
    vi.advanceTimersByTime(1);                                                      // 1 s × (0.5 + 0.5 × 0)
    const s2 = last(); expect(s2).not.toBe(s1);
    s2.drop();                                                                      // refused: the next delay doubles — 2 s × (0.5 + 0.5 × 1)
    vi.advanceTimersByTime(1999); expect(last()).toBe(s2);
    vi.advanceTimersByTime(1);
    const s3 = last(); s3.accept(); frame();
    expect(c.state()).toBe('live');
    expect(s3.subs()).toEqual(['status:*', 'quote:hyperliquid:BTC', 'book:hyperliquid:BTC:20']);  // not the refused one
    // a delta that arrives before the snapshot of the new connection is NOT applied to the old book
    s3.serve(book('delta', 7, 6, [['100', '9']], [], { bids: [['100', '9'], ['99', '2']], asks: full.asks })); frame();
    expect(c.get<LiveBook>('book|hyperliquid:BTC|20')!.bids[0]).toEqual(['100', '1']);
    const fresh = { bids: [['100', '3']] as Level[], asks: [['101', '2']] as Level[] };
    s3.serve(subscribed('book|hyperliquid:BTC|20', book('snapshot', 9, null, fresh.bids, fresh.asks, fresh), 40)); frame();
    expect(c.get<LiveBook>('book|hyperliquid:BTC|20')).toMatchObject({ bids: [['100', '3']], seq: 9, at: T0 + 2500 - 40 });
    expect(c.stats).toMatchObject({ connects: 3 });
  });

  it('three failed connections in a row: `fallback` (the screens\' REST polling stands in) while it keeps trying; the first success is live again', () => {
    const { c, frame } = setup();
    const seen: string[] = []; c.listen('@conn', () => seen.push(c.state()));
    Sock.failNext = 1;                                                              // e.g. a CSP or a proxy that refuses the websocket
    c.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }); frame();
    expect(c.state()).toBe('reconnecting');
    vi.advanceTimersByTime(1000); last().drop(); frame();                           // opened, closed before hello
    vi.advanceTimersByTime(2000); last().drop(); frame();
    expect(c.state()).toBe('fallback');
    vi.advanceTimersByTime(4000); last().drop(); frame(); expect(c.state()).toBe('fallback');
    vi.advanceTimersByTime(8000); last().accept(); frame();
    expect(c.state()).toBe('live'); expect(seen).toEqual(['reconnecting', 'fallback', 'live']);
    last().drop(); frame(); expect(c.state()).toBe('reconnecting');                  // a connection that worked resets the count
    vi.advanceTimersByTime(1000); expect(Sock.all.length).toBe(5);                   // … and the backoff
  });

  it('heartbeat watchdog: no frame for 2.5 heartbeat periods → the connection is considered frozen and re-opened', () => {
    const { c, frame } = setup();
    c.subscribe({ type: 'quote', id: 'hyperliquid:BTC' });
    const s1 = last(); s1.accept(); frame();
    vi.advanceTimersByTime(30_000); s1.serve({ v: 1, type: 'heartbeat', ts: Date.now(), subscriptions: 1 });
    vi.advanceTimersByTime(35_000); expect(last()).toBe(s1); expect(c.state()).toBe('live');   // 35 s since the heartbeat: still within 37.5 s
    vi.advanceTimersByTime(5_000); frame();
    expect(s1.closed).toBe(true); expect(c.state()).toBe('reconnecting'); expect(c.stats.watchdogReconnects).toBe(1);
    vi.advanceTimersByTime(1000); expect(last()).not.toBe(s1);
  });

  it('tab hidden for long: the socket is closed; visible again: reconnected at once, subscriptions sent again', () => {
    const { c, frame, setHidden } = setup();
    c.subscribe({ type: 'quote', id: 'hyperliquid:BTC' });
    const s1 = last(); s1.accept(); frame();
    setHidden(true); vi.advanceTimersByTime(10_000); setHidden(false);              // a short switch: nothing happens
    vi.advanceTimersByTime(20_000); expect(s1.closed).toBe(false);
    s1.serve({ v: 1, type: 'heartbeat', ts: Date.now(), subscriptions: 1 });
    setHidden(true); vi.advanceTimersByTime(CLIENT.hiddenPauseMs); frame();
    expect(s1.closed).toBe(true); expect(c.state()).toBe('paused');
    vi.advanceTimersByTime(300_000); expect(Sock.all.length).toBe(1);               // no reconnection while hidden
    setHidden(false); frame();
    expect(Sock.all.length).toBe(2); expect(c.state()).toBe('reconnecting');
    last().accept(); frame();
    expect(c.state()).toBe('live'); expect(last().subs()).toEqual(['status:*', 'quote:hyperliquid:BTC']);
  });
});

describe('rendering cost', () => {
  it('a burst of ticks on 150 markets is ONE commit: each listener is called once, with the latest value', () => {
    const { c, frame, pendingFrames } = setup();
    const ids = Array.from({ length: 150 }, (_, k) => `hyperliquid:M${k}`), calls = new Map<string, number>();
    for (const id of ids) { c.subscribe({ type: 'quote', id }); c.listen(`quote|${id}|`, () => calls.set(id, (calls.get(id) ?? 0) + 1)); }
    last().accept(); frame();
    expect(last().sent.map((m) => m.channels.length)).toEqual([100, 51]);            // subscriptions in frames of 100 (150 quotes + the statuses)
    const commits = c.stats.commits;
    for (let round = 1; round <= 20; round++) for (const id of ids) last().serve(quote(id, String(1000 + round), round));
    expect(pendingFrames()).toBe(1);                                                // 3000 messages → one animation frame requested
    expect(c.get(`quote|${ids[0]}|`)).toBeNull();                                   // nothing visible before the frame
    frame();
    expect(c.stats.commits).toBe(commits + 1); expect([...calls.values()].every((n) => n === 1)).toBe(true); expect(calls.size).toBe(150);
    expect(c.get<LiveQuote>(`quote|${ids[149]}|`)).toMatchObject({ mark: '1020', seq: 20 });
    last().serve(quote(ids[3]!, '1021', 21)); frame();
    expect(calls.get(ids[3]!)).toBe(2); expect(calls.get(ids[4]!)).toBe(1);          // a tick wakes its own cell only
  });
});

describe('order book and trades', () => {
  it('snapshot then deltas; a hole in the sequence or a wrong checksum is never patched over: the snapshot is asked again', () => {
    const { c, frame } = setup();
    c.subscribe({ type: 'book', id: 'hyperliquid:BTC', depth: 20 });
    const s = last(); s.accept();
    const b0 = { bids: [['100', '1'], ['99', '2']] as Level[], asks: [['101', '1'], ['102', '3']] as Level[] };
    s.serve(subscribed('book|hyperliquid:BTC|20', book('snapshot', 5, null, b0.bids, b0.asks, b0), 120));
    const b1 = { bids: [['100', '0.5'], ['99', '2']] as Level[], asks: [['100.5', '4'], ['101', '1'], ['102', '3']] as Level[] };
    s.serve(book('delta', 6, 5, [['100', '0.5']], [['100.5', '4']], b1)); frame();
    expect(c.get<LiveBook>('book|hyperliquid:BTC|20')).toMatchObject({ ...b1, seq: 6 });
    // a hole: seq 8 after 6
    s.serve(book('delta', 8, 7, [['99', '0']], [], { bids: [['100', '0.5']], asks: b1.asks })); frame();
    expect(c.get<LiveBook>('book|hyperliquid:BTC|20')).toMatchObject({ seq: 6, bids: b1.bids });   // untouched
    expect(s.sent.at(-1)).toEqual({ v: 1, op: 'subscribe', channels: [{ type: 'book', id: 'hyperliquid:BTC', depth: 20 }] }); expect(c.stats.resyncs).toBe(1);
    s.serve(book('delta', 9, 8, [['98', '1']], [], b1)); frame();                    // deltas are ignored until the snapshot comes
    expect(c.get<LiveBook>('book|hyperliquid:BTC|20')!.seq).toBe(6);
    const b2 = { bids: [['100', '0.5'], ['98', '1']] as Level[], asks: b1.asks };
    s.serve(subscribed('book|hyperliquid:BTC|20', book('snapshot', 9, null, b2.bids, b2.asks, b2), 0)); frame();
    expect(c.get<LiveBook>('book|hyperliquid:BTC|20')).toMatchObject({ seq: 9, bids: b2.bids });
    // a delta that applies but does not give the server's checksum: the copy is wrong
    s.serve({ ...book('delta', 10, 9, [['97', '5']], [], b2), checksum: 1 }); frame();
    expect(c.stats).toMatchObject({ resyncs: 2, checksumFailures: 1 }); expect(c.get<LiveBook>('book|hyperliquid:BTC|20')!.seq).toBe(9);
  });

  it('trades: newest first, de-duplicated, bounded; the server\'s `dropped` count is kept', () => {
    const { c, frame } = setup();
    c.subscribe({ type: 'trades', id: 'hyperliquid:BTC' });
    const s = last(); s.accept();
    const t = (k: number) => ({ id: `t${k}`, price: String(65000 + k), size: '0.1', side: 'buy', ts: T0 + k });
    s.serve(subscribed('trades|hyperliquid:BTC|', { v: 1, type: 'trade', id: 'hyperliquid:BTC', trades: [t(1), t(2)], seq: 1, recvTs: T0, source: 'hyperliquid-ws', snapshot: true }, 10));
    s.serve({ v: 1, type: 'trade', id: 'hyperliquid:BTC', trades: [t(2), t(3)], seq: 2, recvTs: T0, source: 'hyperliquid-ws' });
    s.serve({ v: 1, type: 'trade', id: 'hyperliquid:BTC', trades: Array.from({ length: 100 }, (_, k) => t(10 + k)), seq: 3, recvTs: T0, source: 'hyperliquid-ws' });
    s.serve({ v: 1, type: 'dropped', channel: 'trades', id: 'hyperliquid:BTC', count: 7, total: 7 }); frame();
    const list = c.get<LiveTrade[]>('trades|hyperliquid:BTC|')!;
    expect(list.length).toBe(CLIENT.tradesKept); expect(list[0]!.id).toBe('t109'); expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    expect(c.stats.tradesDropped).toBe(7);
  });
});

describe('freshness is re-evaluated with this clock', () => {
  it('live → delayed → stale by age; the server\'s flag; a connection that is not live; the age of a polled figure counts from the source\'s own date', () => {
    const q = { at: T0, stale: false, staleAfterMs: 15_000 };
    expect(freshnessOf(q, 'live', T0 + 1000)).toEqual({ state: 'live', ageMs: 1000 });
    expect(freshnessOf(q, 'live', T0 + 6000)).toEqual({ state: 'delayed', ageMs: 6000 });
    expect(freshnessOf(q, 'live', T0 + 16_000)).toEqual({ state: 'stale', ageMs: 16_000 });   // a frozen feed turns stale on screen without any message
    expect(freshnessOf({ ...q, stale: true }, 'live', T0 + 10)).toMatchObject({ state: 'stale' });
    expect(freshnessOf(q, 'reconnecting', T0 + 2000)).toMatchObject({ state: 'reconnecting' });
    // the venue of the figure is reconnecting while the tab's own connection is fine: said at once, then stale past the bound
    expect(freshnessOf(q, 'live', T0 + 2000, 'reconnecting')).toMatchObject({ state: 'reconnecting' }); expect(freshnessOf(q, 'live', T0 + 2000, 'down')).toMatchObject({ state: 'reconnecting' });
    expect(freshnessOf(q, 'live', T0 + 16_000, 'reconnecting')).toMatchObject({ state: 'stale' }); expect(freshnessOf(q, 'live', T0 + 2000, 'connected')).toMatchObject({ state: 'live' });
    expect(freshnessOf(q, 'fallback', T0 + 20_000)).toMatchObject({ state: 'stale' }); expect(freshnessOf(q, 'fallback', T0 + 2000)).toMatchObject({ state: 'reconnecting' });
    expect(freshnessOf(null, 'live', T0)).toEqual({ state: 'none', ageMs: null }); expect(freshnessOf(null, 'connecting', T0)).toMatchObject({ state: 'reconnecting' });
    expect(freshnessOf({ at: T0, stale: false, staleAfterMs: 4000 }, 'live', T0 + 2500)).toMatchObject({ state: 'delayed' });   // never « live » past half the source's bound
    // through the client: a quote whose source dated it 3 minutes before the server received it is 3 minutes old here too
    const { c, frame } = setup();
    c.subscribe({ type: 'quote', id: 'spot:WBTC' });
    last().accept(); last().serve(subscribed('quote|spot:WBTC|', null, null, 900_000));
    last().serve(quote('spot:WBTC', '65000', 1, { venueTs: Date.now() - 180_000, source: 'coingecko-rest' })); frame();
    const v = c.get<LiveQuote>('quote|spot:WBTC|')!;
    expect(v.staleAfterMs).toBe(900_000); expect(freshnessOf(v, 'live', Date.now())).toEqual({ state: 'delayed', ageMs: 180_000 });
    // a snapshot is as old as the server says
    last().serve(subscribed('quote|spot:WBTC|', quote('spot:WBTC', '65001', 2), 7000, 900_000)); frame();
    expect(freshnessOf(c.get<LiveQuote>('quote|spot:WBTC|'), 'live', Date.now())).toEqual({ state: 'delayed', ageMs: 7000 });
  });
});

describe('helpers of the screens', () => {
  it('which id a row ticks on, which price it shows, the yearly funding, the live spread, the spot overlay', () => {
    expect(liveIdOf({ id: 'hyperliquid:BTC', kind: 'perp', underlying: 'BTC' })).toBe('hyperliquid:BTC');
    expect(liveIdOf({ id: 'spot:WBTC', kind: 'spot', underlying: 'BTC' })).toBe('spot:BTC'); expect(liveIdOf({ id: 'spot:USDC', kind: 'spot', underlying: null })).toBeNull();
    expect(livePriceOf({ kind: 'perp' }, { mark: '65087', mid: '65085.5', last: null })).toBe('65087'); expect(livePriceOf({ kind: 'perp' }, { mark: null, mid: null, last: null })).toBeNull();   // nothing from the source → the listing's figure stays
    expect(livePriceOf({ kind: 'spot' }, { mark: null, mid: '65053.445', last: '65053.44' })).toBe('65053.44');
    expect(annualisedOf('0.0000125', 3600)).toBe('0.10950000'); expect(annualisedOf('-0.0001', 28_800)).toBe('-0.10950000');
    expect(liveSpreadBps('65085', '65086')).toBe('0.1536'); expect(liveSpreadBps('65085', null)).toBeNull(); expect(liveSpreadBps('65086', '65085')).toBeNull(); expect(liveSpreadBps('0', '1')).toBeNull();
    const polled = { BTC: { usd: 65000, cad: 91000, change24h: 1 }, USDC: { usd: 1, cad: 1.4, change24h: 0 } };
    const o = overlaySpot(polled, { BTC: { usd: 65100, at: T0, source: 'coinbase-ws' }, DOGE: { usd: 0.1, at: T0, source: 'coinbase-ws' } })!;
    expect(o.BTC).toMatchObject({ usd: 65100, live: true, change24h: 1 }); expect(o.BTC!.cad).toBeCloseTo(91140, 6);   // the stream is in USD: converted at the polled reading's own rate
    expect(o.USDC).toEqual(polled.USDC); expect(o.DOGE).toBeUndefined();              // no polled price for it: nothing is shown
    expect(overlaySpot(null, { BTC: { usd: 1, at: 0, source: 'x' } })).toBeNull();
  });
});

describe('source conventions', () => {
  const i18n = read('../src/i18n.ts');
  const a = i18n.indexOf('// >>> v11 live quotes (`qt` block)'), b = i18n.indexOf('// <<< end of the `qt` block');
  const block = i18n.slice(a, b);
  const pairs = [...block.matchAll(/\b(qt[A-Za-z0-9_]+): \['((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!, en: m[3]! }));
  const files = ['../src/quotes.ts', '../src/quotes-ui.tsx', '../src/quotes-spot.tsx', '../src/screens/Markets.tsx', '../src/screens/PrivateMarkets.tsx', '../src/screens/Home.tsx', '../src/screens/Asset.tsx', '../src/derivatives/Compare.tsx', '../src/derivatives/store.ts'];
  const sources = files.map(read).join('\n');

  it('the `qt` block: contiguous, two languages with the same placeholders, every key used, every used key present', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(pairs.length).toBeGreaterThanOrEqual(18); expect(new Set(pairs.map((p) => p.key)).size).toBe(pairs.length);
    expect([...block.matchAll(/\b(qt[A-Za-z0-9_]+): \[/g)].length).toBe(pairs.length);
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\bqt[A-Z][A-Za-z0-9_]*: \[/g)).toBeNull();
    const vars = (x: string) => [...x.matchAll(/\{([a-z]+)\}/gi)].map((m) => m[1]!).sort().join(',');
    for (const p of pairs) { expect(vars(p.fr), p.key).toBe(vars(p.en)); expect(p.fr.length, p.key).toBeGreaterThan(0); }
    const used = new Set<string>([...sources.matchAll(/'(qt[A-Z][A-Za-z0-9_]*)'/g)].map((m) => m[1]!));
    expect(sources).toContain('`qtVenue_${'); for (const s of ['reconnecting', 'stale', 'down']) used.add(`qtVenue_${s}`);
    const keys = new Set(pairs.map((p) => p.key));
    expect([...used].filter((k) => !keys.has(k)).sort()).toEqual([]); expect([...keys].filter((k) => !used.has(k)).sort()).toEqual([]);
  });

  it('the first chunk does not carry the quote client: Home and the asset page reach it through a dynamic import only', () => {
    for (const f of ['../src/App.tsx', '../src/screens/Home.tsx', '../src/screens/Asset.tsx', '../src/screens/Assets.tsx', '../src/screens/Gate.tsx', '../src/ui.tsx', '../src/hooks.ts', '../src/quotes-spot.tsx']) {
      const src = read(f);
      expect(src.match(/from '\.\.?\/(quotes|quotes-ui)'/), f).toBeNull();
    }
    expect(read('../src/quotes-spot.tsx')).toContain("import('./quotes')");
  });

  it('a state is never a colour alone, a tick respects reduced motion, and the terminal keeps its fallback', () => {
    const ui = read('../src/quotes-ui.tsx');
    expect(ui).toContain("prefers-reduced-motion: reduce"); expect(ui).toContain('aria-hidden="true"'); expect(ui).toContain("t('qtLive')");
    const store = read('../src/derivatives/store.ts');
    expect(store).toContain("st === 'fallback'"); expect(store).toContain('new EventSource(dapi.streamUrl(this.id))');   // the SSE stream is still there for when the socket cannot connect
    for (const f of ['../src/screens/Markets.tsx', '../src/screens/PrivateMarkets.tsx']) expect(read(f), f).toMatch(/refetchInterval: conn === 'live' \? \d+_000 : \d+_000/);   // REST polling stays, slower while the stream is live
  });
});

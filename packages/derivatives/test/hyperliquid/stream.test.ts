// Hyperliquid websocket client with an injected WebSocket: real messages recorded from mainnet / testnet (fixtures *-ws.json),
// simulated disconnects, reconnects, duplicate deliveries, silence and malformed messages. No network; fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookSchema, fillSchema, publicTradeSchema, tickerSchema, type Fill, type PublicTrade } from '../../src/index.ts';
import { createHlStream, createHyperliquidAdapter, type HlStreamEvent, type HlStreamStatus, type HlWebSocketLike } from '../../src/venues/hyperliquid/index.ts';
import { fx, raw, replay } from './helpers.ts';

class FakeSocket implements HlWebSocketLike {
  static all: FakeSocket[] = [];
  static failNext = 0;
  onopen: ((ev: unknown) => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
  sent: any[] = []; closed = false; readonly url: string;
  constructor(url: string) {
    if (FakeSocket.failNext > 0) { FakeSocket.failNext -= 1; throw new Error('connection refused'); }
    this.url = url; FakeSocket.all.push(this);
  }
  send(data: string): void { if (this.closed) throw new Error('socket is closed'); this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  // --- test controls ---
  open(): void { this.onopen?.({}); }
  push(msg: unknown): void { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  /** the server (or the network) drops the connection */
  drop(): void { this.closed = true; this.onerror?.({}); this.onclose?.({ code: 1006 }); }
  subs(method = 'subscribe'): any[] { return this.sent.filter((m) => m.method === method).map((m) => m.subscription); }
}
const last = () => FakeSocket.all.at(-1)!;

const ws = raw('mainnet-ws.json') as { subscriptions: any[]; messages: any[] };
const msg = (channel: string, n = 0) => structuredClone(ws.messages.filter((m) => m.channel === channel)[n]);
const USER = ws.subscriptions.find((s) => s.type === 'userFills').user as string;

function make(o: Partial<Parameters<typeof createHlStream>[0]> = {}) {
  const stream = createHlStream({ network: 'mainnet', WebSocket: FakeSocket, random: () => 1, ...o });
  const listen = () => { const events: HlStreamEvent[] = [], status: HlStreamStatus[] = []; return { events, status, on: (e: unknown) => { events.push(e as HlStreamEvent); }, onStatus: (s: HlStreamStatus) => { status.push(s); } }; };
  return { stream, listen };
}

beforeEach(() => { vi.useFakeTimers({ now: 1_794_366_000_000 }); FakeSocket.all = []; FakeSocket.failNext = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('hyperliquid stream — recorded messages', () => {
  it('connects lazily to the documented URL and subscribes', () => {
    const { stream, listen } = make();
    expect(FakeSocket.all.length).toBe(0);
    const l = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, l.on, l.onStatus);
    expect(last().url).toBe('wss://api.hyperliquid.xyz/ws');
    expect(l.status).toEqual([]);
    last().open();
    expect(l.status).toEqual(['connected']);
    expect(last().sent).toEqual([{ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }]);
    expect(createHlStream({ network: 'testnet', WebSocket: FakeSocket }).stats().status).toBe('idle');
  });

  it('book, trades, ticker and mids from real messages', () => {
    const { stream, listen } = make();
    const book = listen(), trades = listen(), ticker = listen(), mids = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, book.on, book.onStatus);
    stream.subscribe({ type: 'trades', symbol: 'BTC' }, trades.on, trades.onStatus);
    stream.subscribe({ type: 'ticker', symbol: 'BTC' }, ticker.on, ticker.onStatus);
    stream.subscribe({ type: 'mids' }, mids.on, mids.onStatus);
    const s = last();
    s.open();
    expect(s.subs()).toEqual([{ type: 'l2Book', coin: 'BTC' }, { type: 'trades', coin: 'BTC' }, { type: 'activeAssetCtx', coin: 'BTC' }, { type: 'allMids' }]);
    for (const m of ws.messages) s.push(m); // the whole recorded session, acks, pong and error messages included

    const b = book.events.filter((e) => e.type === 'book');
    expect(b.length).toBe(ws.messages.filter((m) => m.channel === 'l2Book').length);
    const rawBook = msg('l2Book').data, got = (b[0] as { book: unknown }).book as ReturnType<typeof bookSchema.parse>;
    bookSchema.parse(got);
    expect(got.ts).toBe(rawBook.time);
    expect(got.bids.length).toBe(rawBook.levels[0].length);
    expect(Number(got.bids[0]![0])).toBe(Number(rawBook.levels[0][0].px)); // display comparison only

    const t = trades.events.filter((e) => e.type === 'trades').flatMap((e) => (e as { trades: PublicTrade[] }).trades);
    const rawTrades = ws.messages.filter((m) => m.channel === 'trades').flatMap((m) => m.data);
    expect(t.length).toBe(new Set(rawTrades.map((x: any) => `${x.time}-${x.tid}`)).size);
    for (const x of t) publicTradeSchema.parse(x);

    const k = ticker.events.filter((e) => e.type === 'ticker');
    expect(k.length).toBe(ws.messages.filter((m) => m.channel === 'activeAssetCtx').length);
    tickerSchema.parse((k[0] as { ticker: unknown }).ticker);
    expect((k[0] as any).ticker.instrument).toBe('hyperliquid:BTC');
    expect((k[0] as any).ticker.ts).toBe(1_794_366_000_000);

    const m = mids.events.filter((e) => e.type === 'mids');
    expect(m.length).toBe(ws.messages.filter((x) => x.channel === 'allMids').length);
    expect(typeof (m[0] as any).mids.BTC === 'string' || Object.keys((m[0] as any).mids).length > 0).toBe(true);

    // each consumer only sees its own feed; the venue's `error` messages are reported to everyone as invalid
    expect(book.events.every((e) => e.type === 'book' || e.type === 'invalid')).toBe(true);
    expect(book.events.filter((e) => e.type === 'invalid').length).toBe(ws.messages.filter((x) => x.channel === 'error').length);
    expect(stream.stats()).toMatchObject({ connects: 1, messages: ws.messages.length, subscriptions: 4, status: 'connected' });
  });

  it('account feed: fills snapshot from a real message, then live fills, order updates, funding, venue cancels', () => {
    const { stream, listen } = make();
    const l = listen();
    stream.subscribe({ type: 'account', account: USER }, l.on, l.onStatus);
    const s = last();
    s.open();
    expect(s.subs()).toEqual([{ type: 'userFills', user: USER }, { type: 'orderUpdates', user: USER }, { type: 'userEvents', user: USER }]);
    const snap = msg('userFills');
    expect(snap.data.isSnapshot).toBe(true);
    s.push(snap);
    const first = l.events[0] as { type: 'fills'; fills: Fill[]; snapshot: boolean };
    expect(first.type).toBe('fills');
    expect(first.snapshot).toBe(true);
    expect(first.fills.length).toBe(snap.data.fills.length);
    for (const f of first.fills) fillSchema.parse(f);

    // shapes below follow the documented WsOrder / WsUserEvent types (no such message occurred while recording)
    const fill = { ...snap.data.fills[0], tid: 987654321, hash: `0x${'ab'.repeat(32)}`, time: 1_794_366_000_500 };
    s.push({ channel: 'userFills', data: { user: USER, fills: [fill] } });
    s.push({ channel: 'user', data: { fills: [fill] } }); // the same fill again through userEvents
    s.push({ channel: 'orderUpdates', data: [
      { order: { coin: 'BTC', side: 'B', limitPx: '73000.0', sz: '0.001', oid: 91, timestamp: 1_794_366_000_100, origSz: '0.001', cloid: `0x${'01'.repeat(16)}` }, status: 'open', statusTimestamp: 1_794_366_000_100 },
      { order: { coin: 'BTC', side: 'B', limitPx: '73000.0', sz: '0.0004', oid: 91, timestamp: 1_794_366_000_100, origSz: '0.001' }, status: 'open', statusTimestamp: 1_794_366_000_200 },
      { order: { coin: 'BTC', side: 'A', limitPx: '75000.0', sz: '0.0', oid: 92, timestamp: 1_794_366_000_100, origSz: '0.002' }, status: 'filled', statusTimestamp: 1_794_366_000_300 },
      { order: { coin: 'ETH', side: 'A', limitPx: '2000.0', sz: '1.0', oid: 93, timestamp: 1_794_366_000_100, origSz: '1.0' }, status: 'reduceOnlyCanceled', statusTimestamp: 1_794_366_000_400 },
    ] });
    s.push({ channel: 'user', data: { funding: { time: 1_794_366_000_000, coin: 'BTC', usdc: '-0.0123', szi: '0.3', fundingRate: '0.0000125' } } });
    s.push({ channel: 'user', data: { nonUserCancel: [{ coin: 'ETH', oid: 93 }] } });
    s.push({ channel: 'user', data: { liquidation: { lid: 1, liquidator: '0x1', liquidated_user: USER, liquidated_ntl_pos: '1.0', liquidated_account_value: '0.5' } } });

    const live = l.events.filter((e) => e.type === 'fills' && !e.snapshot) as { fills: Fill[] }[];
    expect(live.length).toBe(1); // delivered once, although it came on two channels
    expect(live[0]!.fills[0]).toMatchObject({ id: `0x${'ab'.repeat(32)}-987654321`, ts: 1_794_366_000_500 });
    const orders = (l.events.find((e) => e.type === 'orders') as { orders: any[] }).orders;
    expect(orders.map((o) => [o.venueOrderId, o.status, o.remaining])).toEqual([['91', 'open', '0.001'], ['91', 'partially_filled', '0.0004'], ['92', 'filled', '0'], ['93', 'cancelled', '1']]);
    expect(orders[0]).toMatchObject({ instrument: 'hyperliquid:BTC', side: 'buy', price: '73000', size: '0.001', clientId: `0x${'01'.repeat(16)}`, venueStatus: 'open' });
    expect(orders[3].venueStatus).toBe('reduceOnlyCanceled');
    expect(l.events.find((e) => e.type === 'funding')).toEqual({ type: 'funding', payment: { instrument: 'hyperliquid:BTC', amount: '-0.0123', rate: '0.0000125', size: '0.3', ts: 1_794_366_000_000 } });
    expect(l.events.find((e) => e.type === 'cancelled_by_venue')).toEqual({ type: 'cancelled_by_venue', orders: [{ instrument: 'hyperliquid:ETH', venueOrderId: '93' }] });
    expect(l.events.some((e) => e.type === 'liquidation')).toBe(true);
    expect(stream.stats().duplicates).toBe(1);
  });

  it('one account per connection; a malformed address is refused', () => {
    const { stream, listen } = make();
    const l = listen();
    stream.subscribe({ type: 'account', account: USER }, l.on, l.onStatus);
    expect(() => stream.subscribe({ type: 'account', account: `0x${'1'.repeat(40)}` }, l.on, l.onStatus)).toThrow(/one account per stream/);
    expect(() => stream.subscribe({ type: 'account', account: 'nope' }, l.on, l.onStatus)).toThrow(/20-byte hex address/);
    expect(() => stream.subscribe({ type: 'book', symbol: '' }, l.on, l.onStatus)).toThrow(/bad symbol/);
  });
});

describe('hyperliquid stream — heartbeat, silence, disconnects', () => {
  it('pings on the heartbeat period ({ "method": "ping" }) and stays connected while pongs arrive', () => {
    const { stream, listen } = make();
    const l = listen();
    stream.subscribe({ type: 'ticker', symbol: 'BTC' }, l.on, l.onStatus);
    const s = last();
    s.open();
    for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(15_000); s.push({ channel: 'pong' }); }
    expect(s.sent.filter((m) => m.method === 'ping')).toEqual(Array.from({ length: 8 }, () => ({ method: 'ping' })));
    expect(l.status).toEqual(['connected']);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('silence → stale; traffic again on the same connection → connected, with no gap', () => {
    const { stream, listen } = make();
    const l = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, l.on, l.onStatus);
    const s = last();
    s.open();
    vi.advanceTimersByTime(26_000);
    expect(l.status).toEqual(['connected', 'stale']);
    s.push(msg('l2Book'));
    expect(l.status).toEqual(['connected', 'stale', 'connected']);
    expect(l.events.some((e) => e.type === 'gap')).toBe(false);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('prolonged silence → the connection is dropped and re-opened: reconnecting, connected, gap', () => {
    const { stream, listen } = make();
    const l = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, l.on, l.onStatus);
    const first = last();
    first.open();
    vi.advanceTimersByTime(36_500);
    expect(l.status).toEqual(['connected', 'stale', 'reconnecting']);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1000); // first backoff step (random = 1 → the full delay)
    expect(FakeSocket.all.length).toBe(2);
    last().open();
    expect(l.status).toEqual(['connected', 'stale', 'reconnecting', 'connected']);
    expect(l.events.at(-1)).toEqual({ type: 'gap', reason: 'reconnected' });
    expect(last().subs()).toEqual([{ type: 'l2Book', coin: 'BTC' }]);
    first.push(msg('l2Book')); // a late message from the abandoned socket is ignored
    expect(l.events.filter((e) => e.type === 'book').length).toBe(0);
  });

  it('server-side disconnect: resubscribes everything and tells every consumer that a gap may exist', () => {
    const { stream, listen } = make();
    const a = listen(), b = listen(), c = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, a.on, a.onStatus);
    stream.subscribe({ type: 'trades', symbol: 'ETH' }, b.on, b.onStatus);
    stream.subscribe({ type: 'account', account: USER }, c.on, c.onStatus);
    last().open();
    last().push(msg('l2Book'));
    last().drop();
    expect([a.status, b.status, c.status]).toEqual([['connected', 'reconnecting'], ['connected', 'reconnecting'], ['connected', 'reconnecting']]);
    expect(FakeSocket.all.length).toBe(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(2);
    expect(a.events.some((e) => e.type === 'gap')).toBe(false); // not yet: nothing is connected
    last().open();
    expect(last().subs()).toEqual([{ type: 'l2Book', coin: 'BTC' }, { type: 'trades', coin: 'ETH' }, { type: 'userFills', user: USER }, { type: 'orderUpdates', user: USER }, { type: 'userEvents', user: USER }]);
    for (const l of [a, b, c]) { expect(l.status).toEqual(['connected', 'reconnecting', 'connected']); expect(l.events.filter((e) => e.type === 'gap')).toEqual([{ type: 'gap', reason: 'reconnected' }]); }
    last().push(msg('l2Book', 1));
    expect(a.events.map((e) => e.type)).toEqual(['book', 'gap', 'book']);
  });

  it('backoff doubles up to the cap while the venue stays unreachable, and starts again after a connection that lasted', () => {
    const { stream, listen } = make({ backoffMinMs: 1000, backoffMaxMs: 8000 });
    const l = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, l.on, l.onStatus);
    last().open();
    last().drop();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === n && waited < 60_000) { vi.advanceTimersByTime(250); waited += 250; }
      delays.push(waited);
      last().drop(); // accepted, then dropped at once (what the server does on a bad subscription)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(l.status).toEqual(['connected', 'reconnecting']);
    // constructor failures count too
    FakeSocket.failNext = 2;
    vi.advanceTimersByTime(30_000);
    expect(last().closed).toBe(false);
    last().open();
    expect(l.status.at(-1)).toBe('connected');
    vi.advanceTimersByTime(10_000); last().push({ channel: 'pong' }); vi.advanceTimersByTime(1000);
    last().drop();
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all.length).toBe(n + 1); // back to the minimum delay
  });

  it('jitter keeps the delay between half and the whole step', () => {
    const { stream, listen } = make({ random: () => 0 });
    const l = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, l.on, l.onStatus);
    last().open(); last().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(2);
  });

  it('duplicate deliveries: a fill or a trade is emitted once, also across a reconnect snapshot', () => {
    const { stream, listen } = make();
    const acct = listen(), trades = listen();
    stream.subscribe({ type: 'account', account: USER }, acct.on, acct.onStatus);
    stream.subscribe({ type: 'trades', symbol: 'BTC' }, trades.on, trades.onStatus);
    last().open();
    const snap = msg('userFills'), tr = msg('trades');
    last().push(snap); last().push(tr); last().push(tr); last().push(snap);
    const count = (l: ReturnType<typeof listen>, type: string, key: string) => l.events.filter((e) => e.type === type).reduce((n, e) => n + (e as any)[key].length, 0);
    expect(count(acct, 'fills', 'fills')).toBe(snap.data.fills.length);
    expect(count(trades, 'trades', 'trades')).toBe(new Set(tr.data.map((x: any) => `${x.time}-${x.tid}`)).size);

    // reconnect: the snapshot comes again, with one fill that happened during the gap — only that one is emitted
    last().drop(); vi.advanceTimersByTime(1000); last().open();
    const missed = { ...snap.data.fills[0], tid: 555, hash: `0x${'cd'.repeat(32)}`, time: snap.data.fills[0].time + 1 };
    const again = structuredClone(snap);
    again.data.fills.unshift(missed);
    const before = acct.events.length;
    last().push(again);
    const after = acct.events.slice(before).filter((e) => e.type === 'fills') as { fills: Fill[]; snapshot: boolean }[];
    expect(after.length).toBe(1);
    expect(after[0]!.snapshot).toBe(true);
    expect(after[0]!.fills.map((f) => f.id)).toEqual([`0x${'cd'.repeat(32)}-555`]);
    last().push(tr);
    expect(count(trades, 'trades', 'trades')).toBe(new Set(tr.data.map((x: any) => `${x.time}-${x.tid}`)).size);
    expect(stream.stats().duplicates).toBeGreaterThan(0);
  });

  it('malformed messages are dropped and reported, the stream goes on', () => {
    const { stream, listen } = make();
    const l = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, l.on, l.onStatus);
    const s = last();
    s.open();
    const crossed = msg('l2Book'); crossed.data.levels[0][0].px = '999999999';
    const numeric = msg('l2Book'); numeric.data.levels[1][0].px = 73700.5;
    for (const bad of ['not json', '{"no":"channel"}', { channel: 'l2Book', data: { coin: 'BTC' } }, crossed, numeric, { channel: 'l2Book' }, { channel: 'error', data: 'Already subscribed' }, 42, null]) s.push(bad as never);
    expect(l.events.every((e) => e.type === 'invalid')).toBe(true);
    expect(l.events.length).toBe(9);
    expect(stream.stats().invalid).toBe(9);
    s.push({ channel: 'somethingNew', data: {} }); // unknown channels and feeds we did not ask for are ignored silently
    s.push({ channel: 'l2Book', data: { ...msg('l2Book').data, coin: 'ETH' } });
    expect(l.events.length).toBe(9);
    s.push(msg('l2Book'));
    expect(l.events.at(-1)!.type).toBe('book');
    expect(l.status).toEqual(['connected']);
  });

  it('a consumer that throws does not break the others', () => {
    const { stream, listen } = make();
    const good = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, () => { throw new Error('consumer bug'); }, () => { throw new Error('consumer bug'); });
    stream.subscribe({ type: 'book', symbol: 'BTC' }, good.on, good.onStatus);
    last().open(); last().push(msg('l2Book'));
    expect(good.events.map((e) => e.type)).toEqual(['book']);
    expect(last().subs().length).toBe(1); // one wire subscription for two consumers
  });

  it('unsubscribe: the feed is released with the last consumer, the socket with the last feed', () => {
    const { stream, listen } = make();
    const a = listen(), b = listen(), c = listen();
    const ua = stream.subscribe({ type: 'book', symbol: 'BTC' }, a.on, a.onStatus), ub = stream.subscribe({ type: 'book', symbol: 'BTC' }, b.on, b.onStatus);
    const uc = stream.subscribe({ type: 'trades', symbol: 'BTC' }, c.on, c.onStatus);
    const s = last();
    s.open();
    ua(); ua();
    expect(s.subs('unsubscribe')).toEqual([]);
    s.push(msg('l2Book'));
    expect([a.events.length, b.events.length]).toEqual([0, 1]);
    ub();
    expect(s.subs('unsubscribe')).toEqual([{ type: 'l2Book', coin: 'BTC' }]);
    expect(s.closed).toBe(false);
    uc();
    expect(s.closed).toBe(true);
    expect(stream.stats().status).toBe('idle');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all.length).toBe(1); // no timer left, no reconnect
    // a new subscription starts a fresh connection, and it is a first connection again (no gap event)
    const d = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, d.on, d.onStatus);
    last().open();
    expect(d.events).toEqual([]);
    expect(d.status).toEqual(['connected']);
    stream.close();
    expect(last().closed).toBe(true);
  });

  it('a subscription made while reconnecting learns the state and is included in the next connection', () => {
    const { stream, listen } = make();
    const a = listen(), b = listen();
    stream.subscribe({ type: 'book', symbol: 'BTC' }, a.on, a.onStatus);
    last().open(); last().drop();
    stream.subscribe({ type: 'ticker', symbol: 'ETH' }, b.on, b.onStatus);
    expect(b.status).toEqual(['reconnecting']);
    vi.advanceTimersByTime(1000); last().open();
    expect(last().subs()).toEqual([{ type: 'l2Book', coin: 'BTC' }, { type: 'activeAssetCtx', coin: 'ETH' }]);
    expect(b.status).toEqual(['reconnecting', 'connected']);
  });
});

describe('hyperliquid adapter.stream', () => {
  it('checks the symbol against the venue table before subscribing (an unknown coin makes the server drop the connection)', async () => {
    vi.useRealTimers();
    FakeSocket.all = [];
    const r = replay({ meta: { body: fx('mainnet-meta').body } });
    const adapter = createHyperliquidAdapter({ network: 'mainnet', fetch: r.fetchImpl, stream: { WebSocket: FakeSocket } });
    const events: any[] = [], status: string[] = [];
    adapter.stream({ type: 'book', symbol: 'NOT-A-COIN' }, (e) => events.push(e), (s) => status.push(s));
    const stop = adapter.stream({ type: 'book', symbol: 'BTC' }, (e) => events.push(e), (s) => status.push(s));
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toEqual([{ type: 'invalid', channel: 'subscribe', reason: "unknown instrument 'NOT-A-COIN'" }]);
    expect(FakeSocket.all.length).toBe(1);
    last().open();
    expect(last().subs()).toEqual([{ type: 'l2Book', coin: 'BTC' }]);
    last().push(msg('l2Book'));
    expect(events.at(-1).type).toBe('book');
    expect(status).toEqual(['connected']);
    stop();
    expect(last().closed).toBe(true);
    // cancelled before the table arrived: never subscribes
    const cancel = adapter.stream({ type: 'trades', symbol: 'ETH' }, () => {}, () => {});
    cancel();
    await new Promise((res) => setTimeout(res, 20));
    expect(FakeSocket.all.length).toBe(1);
    adapter.close();
  });
});

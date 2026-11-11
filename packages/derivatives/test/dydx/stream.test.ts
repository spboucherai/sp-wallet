// dYdX indexer websocket: real frames recorded from mainnet (public channels) and testnet (subaccount channel), replayed
// through a scripted socket. Covers snapshot + deltas, out-of-order ids, duplicate delivery, gaps, reconnect and resubscribe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDydxAdapter, D, DydxStream, type DydxStreamEvent, type WebSocketCtor } from '../../src/index.ts';
import { FakeSocket, wsFx } from '../venue-helpers.ts';

const pub = wsFx('dydx', 'ws-mainnet-public'), acct = wsFx('dydx', 'ws-testnet-subaccount');
const WS = FakeSocket as unknown as WebSocketCtor;
const connected = (id = 0) => ({ type: 'connected', connection_id: 'c', message_id: id });
const frames = (channel: string, type?: string) => pub.messages.filter((m) => m.channel === channel && (!type || m.type === type));
const bookSnapshot = frames('v4_orderbook', 'subscribed')[0]!, bookDeltas = frames('v4_orderbook', 'channel_data');
const tradesSnapshot = frames('v4_trades', 'subscribed')[0]!, marketsSnapshot = frames('v4_markets', 'subscribed')[0]!;
let clock = 0;
const open = (o: Partial<ConstructorParameters<typeof DydxStream>[0]> = {}) => new DydxStream({ url: 'wss://example.invalid/v4/ws', WebSocket: WS, now: () => clock, ...o });

beforeEach(() => { vi.useFakeTimers(); FakeSocket.reset(); clock = 1_000_000; });
afterEach(() => { vi.useRealTimers(); });

describe('dYdX stream: recorded mainnet frames', () => {
  it('the recording really has out-of-order message ids (why order is not enforced)', () => {
    const ids = pub.messages.map((m) => m.message_id as number).filter((x) => x !== undefined);
    expect(ids.some((id, i) => i > 0 && id < ids[i - 1]!)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('replays the whole recording: book snapshot + 150 deltas, trades, markets — no gap, no reconnect', () => {
    const s = open(), events: DydxStreamEvent[] = [], status: string[] = [];
    const on = (e: DydxStreamEvent) => events.push(e), st = (x: string) => status.push(x);
    s.subscribe('v4_orderbook', 'BTC-USD', null, on, st);
    s.subscribe('v4_trades', 'BTC-USD', null, on, st);
    s.subscribe('v4_markets', null, 'BTC-USD', on, st);
    s.subscribe('v4_orderbook', 'NOPE-USD', null, on, st);
    const sock = FakeSocket.last;
    expect(sock.sent).toEqual([]);                               // nothing is sent before the server says `connected`
    for (const m of pub.messages) sock.serve(m);
    expect(sock.subscriptions()).toEqual(['v4_orderbook|BTC-USD', 'v4_trades|BTC-USD', 'v4_markets|', 'v4_orderbook|NOPE-USD']);
    expect(sock.sent.every((m) => m.type !== 'subscribe' || m.batched === true)).toBe(true);
    vi.advanceTimersByTime(6_000);                               // past the gap window: every id arrived, so no stale
    expect(FakeSocket.instances.length).toBe(1);
    expect(new Set(status)).toEqual(new Set(['connected']));

    const books = events.filter((e) => e.type === 'book');
    expect(books.length).toBe(1 + bookDeltas.length);
    expect(books[0]).toMatchObject({ symbol: 'BTC-USD', snapshot: true });
    const last = books.at(-1)!;
    if (last.type !== 'book') throw new Error('unreachable');
    expect(last.book.instrument).toBe('dydx:BTC-USD');
    expect(last.book.bids.length).toBeGreaterThan(10);
    for (let i = 1; i < last.book.bids.length; i++) expect(D.cmp(D.from(last.book.bids[i - 1]![0]), D.from(last.book.bids[i]![0]))).toBe(1);
    for (let i = 1; i < last.book.asks.length; i++) expect(D.cmp(D.from(last.book.asks[i - 1]![0]), D.from(last.book.asks[i]![0]))).toBe(-1);
    for (const [, size] of [...last.book.bids, ...last.book.asks]) expect(D.isZero(D.from(size))).toBe(false);   // removed levels are gone

    const trades = events.filter((e) => e.type === 'trades');
    expect(trades[0]).toMatchObject({ symbol: 'BTC-USD', snapshot: true });
    if (trades[0]!.type === 'trades') expect(trades[0]!.trades.length).toBe((tradesSnapshot.contents as any).trades.length);

    const tick = events.find((e) => e.type === 'ticker');
    if (tick?.type !== 'ticker') throw new Error('no ticker');
    expect(tick.ticker).toMatchObject({ instrument: 'dydx:BTC-USD', mid: null });
    expect(tick.ticker.mark).toBe((marketsSnapshot.contents as any).markets['BTC-USD'].oraclePrice);
    expect(events.filter((e) => e.type === 'ticker').every((e) => e.type === 'ticker' && e.symbol === 'BTC-USD')).toBe(true);

    // the invalid subscription is reported to its own subscriber only
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'Invalid subscription id for channel: (v4_orderbook-NOPE-USD)' }]);
  });

  it('applies a delta exactly: a level is set, then removed by size 0', () => {
    const s = open(), books: any[] = [];
    s.subscribe('v4_orderbook', 'BTC-USD', null, (e) => { if (e.type === 'book') books.push(e.book); }, () => {});
    const sock = FakeSocket.last;
    sock.serve(connected());
    sock.serve({ type: 'subscribed', message_id: 1, channel: 'v4_orderbook', id: 'BTC-USD', contents: { bids: [{ price: '100', size: '1' }, { price: '99', size: '2' }], asks: [{ price: '101', size: '3' }] } });
    sock.serve({ type: 'channel_batch_data', message_id: 2, channel: 'v4_orderbook', id: 'BTC-USD', contents: [{ bids: [['99.5', '0.250', '7']] }, { asks: [['101', '0']] }, { asks: [['102.0', '4']] }] });
    expect(books.at(-1)).toMatchObject({ bids: [['100', '1'], ['99.5', '0.25'], ['99', '2']], asks: [['102', '4']] });
    sock.serve({ type: 'channel_data', message_id: 3, channel: 'v4_orderbook', id: 'BTC-USD', contents: { bids: [['100.00', '0']] } });
    expect(books.at(-1).bids).toEqual([['99.5', '0.25'], ['99', '2']]);
  });

  it('flags a crossed book instead of hiding it', () => {
    const s = open(), ev: any[] = [];
    s.subscribe('v4_orderbook', 'BTC-USD', null, (e) => ev.push(e), () => {});
    FakeSocket.last.serve(connected());
    FakeSocket.last.serve({ type: 'subscribed', message_id: 1, channel: 'v4_orderbook', id: 'BTC-USD', contents: { bids: [{ price: '101', size: '1' }], asks: [{ price: '100', size: '1' }] } });
    expect(ev[0]).toMatchObject({ crossed: true });
  });

  it('markets channel: partial updates are merged, the ticker is re-emitted only for the watched symbol', () => {
    const s = open(), ticks: any[] = [];
    s.subscribe('v4_markets', null, 'BTC-USD', (e) => { if (e.type === 'ticker') ticks.push(e); }, () => {});
    const sock = FakeSocket.last;
    sock.serve(connected());
    sock.serve({ ...marketsSnapshot, message_id: 1 });
    expect(ticks.length).toBe(1);
    sock.serve({ type: 'channel_batch_data', message_id: 2, channel: 'v4_markets', contents: [{ oraclePrices: { 'ETH-USD': { oraclePrice: '2000.5', effectiveAt: 'x' } } }] });
    expect(ticks.length).toBe(1);
    sock.serve({ type: 'channel_batch_data', message_id: 3, channel: 'v4_markets', contents: [{ oraclePrices: { 'BTC-USD': { oraclePrice: '70000.123456789', effectiveAt: 'x' } } }, { trading: { 'BTC-USD': { openInterest: '250.5', nextFundingRate: '-0.00001' } } }] });
    expect(ticks.length).toBe(3);
    expect(ticks.at(-1)).toMatchObject({ snapshot: false, ticker: { mark: '70000.123456789', index: '70000.123456789', openInterest: '250.5', funding: '-0.00001' } });
  });
});

describe('dYdX stream: duplicates, gaps, reconnect', () => {
  const start = () => {
    const s = open(), events: DydxStreamEvent[] = [], status: string[] = [];
    const off = s.subscribe('v4_trades', 'BTC-USD', null, (e) => events.push(e), (x) => status.push(x));
    const sock = FakeSocket.last;
    sock.serve(connected());
    sock.serve({ ...tradesSnapshot, message_id: 1 });
    return { s, events, status, off, sock };
  };
  const trade = (id: string, at = '2026-11-11T03:00:00.000Z') => ({ id, side: 'BUY', size: '0.001', price: '73500', type: 'LIMIT', createdAt: at, createdAtHeight: '1' });

  it('a frame delivered twice (same message id) is applied once', () => {
    const { events, sock } = start();
    const upd = { type: 'channel_data', message_id: 2, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('new-1')] } };
    sock.serve(upd); sock.serve(upd); sock.serve({ ...tradesSnapshot, message_id: 1 });
    expect(events.filter((e) => e.type === 'trades').length).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'trades', snapshot: false, trades: [{ id: 'new-1', price: '73500', size: '0.001', side: 'buy' }] });
  });

  it('the same trade under a new message id is not emitted again', () => {
    const { events, sock } = start();
    sock.serve({ type: 'channel_data', message_id: 2, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('new-1')] } });
    sock.serve({ type: 'channel_data', message_id: 3, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('new-1'), trade('new-2')] } });
    sock.serve({ type: 'channel_data', message_id: 4, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('new-2')] } });
    const upd = events.filter((e) => e.type === 'trades' && !e.snapshot) as Extract<DydxStreamEvent, { type: 'trades' }>[];
    expect(upd.map((e) => e.trades.map((t) => t.id))).toEqual([['new-1'], ['new-2']]);
  });

  it('ids that arrive out of order within the window are fine; an id still missing after the window is a gap → stale → reconnect', () => {
    const { status, sock } = start();
    sock.serve({ type: 'channel_data', message_id: 4, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('a')] } });
    sock.serve({ type: 'channel_data', message_id: 2, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('b')] } });
    sock.serve({ type: 'channel_data', message_id: 3, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('c')] } });
    vi.advanceTimersByTime(10_000);
    expect(status).toEqual(['connected']);
    expect(FakeSocket.instances.length).toBe(1);

    sock.serve({ type: 'channel_data', message_id: 7, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('d')] } });   // 5 and 6 never come
    vi.advanceTimersByTime(4_999);
    expect(status).toEqual(['connected']);
    vi.advanceTimersByTime(1);
    expect(status).toEqual(['connected', 'stale', 'reconnecting']);
    expect(sock.closed).toBe(true);
    vi.advanceTimersByTime(500);                                 // first backoff step
    expect(FakeSocket.instances.length).toBe(2);
  });

  it('reconnects with backoff, resubscribes everything, and does not replay trades already delivered', () => {
    const { s, events, status, sock } = start();
    const books: any[] = [];
    s.subscribe('v4_orderbook', 'ETH-USD', null, (e) => { if (e.type === 'book') books.push(e); }, () => {});
    expect(sock.subscriptions()).toEqual(['v4_trades|BTC-USD', 'v4_orderbook|ETH-USD']);
    sock.serve({ type: 'channel_data', message_id: 2, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('live-1')] } });
    const before = events.length;

    sock.drop();                                                 // connection lost
    expect(status.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    const second = FakeSocket.last;
    expect(FakeSocket.instances.length).toBe(2);
    second.drop();                                               // fails again before `connected`: the delay doubles
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    const third = FakeSocket.last;
    expect(FakeSocket.instances.length).toBe(3);
    expect(third.sent).toEqual([]);
    third.serve(connected(0));
    expect(third.subscriptions()).toEqual(['v4_trades|BTC-USD', 'v4_orderbook|ETH-USD']);
    expect(status.at(-1)).toBe('connected');

    // message ids restart on the new connection; the snapshot repeats trades we already delivered plus one new
    const snap = structuredClone(tradesSnapshot) as any;
    snap.message_id = 1;
    snap.contents.trades = [trade('after-gap', '2026-11-11T03:05:00.000Z'), trade('live-1'), ...snap.contents.trades];
    third.serve(snap);
    const fresh = events.slice(before);
    expect(fresh).toEqual([{ type: 'trades', symbol: 'BTC-USD', snapshot: true, trades: [expect.objectContaining({ id: 'after-gap' })] }]);
    // deltas that arrive before the new snapshot of a channel are not applied to a stale book
    third.serve({ type: 'channel_data', message_id: 2, channel: 'v4_orderbook', id: 'ETH-USD', contents: { bids: [['2000', '1']] } });
    expect(books.length).toBe(0);
    third.serve({ type: 'subscribed', message_id: 3, channel: 'v4_orderbook', id: 'ETH-USD', contents: { bids: [{ price: '2000', size: '1' }], asks: [] } });
    expect(books.length).toBe(1);
  });

  it('silence is detected: no frame for 40 s → stale, then reconnect; pings are sent meanwhile', () => {
    const { status, sock } = start();
    for (let i = 0; i < 2; i++) { clock += 15_000; vi.advanceTimersByTime(15_000); }
    expect(sock.sent.filter((m) => m.type === 'ping').length).toBe(2);
    expect(status).toEqual(['connected']);
    clock += 15_000; vi.advanceTimersByTime(15_000);             // 45 s without any frame
    expect(status).toEqual(['connected', 'stale', 'reconnecting']);
    clock += 500; vi.advanceTimersByTime(500);
    expect(FakeSocket.instances.length).toBe(2);
  });

  it('a pong keeps the connection alive', () => {
    const { status, sock } = start();
    for (let i = 0; i < 6; i++) { clock += 15_000; vi.advanceTimersByTime(15_000); sock.serve({ type: 'pong', connection_id: 'c', message_id: 2 + i }); }
    expect(status).toEqual(['connected']);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('an unreadable or malformed frame is treated as a gap, not ignored', () => {
    const a = start();
    a.sock.serve('not json');
    expect(a.status).toEqual(['connected', 'stale', 'reconnecting']);
    FakeSocket.reset();
    const b = start();
    b.sock.serve({ type: 'channel_data', message_id: 2, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [{ id: 'x', side: 'BUY', size: 1, price: '1', type: 'LIMIT', createdAt: '2026-11-11T03:00:00.000Z', createdAtHeight: '1' }] } });
    expect(b.status).toEqual(['connected', 'stale', 'reconnecting']);
  });

  it('unsubscribing tells the server, and the last unsubscribe closes the socket and stops every timer', () => {
    const { s, off, sock, events } = start();
    const off2 = s.subscribe('v4_orderbook', 'BTC-USD', null, () => {}, () => {});
    off();
    expect(sock.sent.at(-1)).toEqual({ type: 'unsubscribe', channel: 'v4_trades', id: 'BTC-USD' });
    const n = events.length;
    sock.serve({ type: 'channel_data', message_id: 2, channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [trade('late')] } });
    expect(events.length).toBe(n);
    off2();
    expect(sock.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('two subscribers of one channel share one server subscription; a late joiner gets the current book', async () => {
    const s = open(), a: any[] = [], b: any[] = [];
    s.subscribe('v4_orderbook', 'BTC-USD', null, (e) => a.push(e), () => {});
    const sock = FakeSocket.last;
    sock.serve(connected());
    sock.serve({ ...bookSnapshot, message_id: 1 });
    s.subscribe('v4_orderbook', 'BTC-USD', null, (e) => b.push(e), () => {});
    await Promise.resolve();
    expect(sock.subscriptions()).toEqual(['v4_orderbook|BTC-USD']);
    expect(b.length).toBe(1);
    expect(b[0]).toMatchObject({ type: 'book', snapshot: true });
    expect(b[0].book.bids).toEqual(a[0].book.bids);
  });
});

describe('dYdX stream: subaccount channel (recorded testnet frames) through the adapter', () => {
  it('snapshot carries the subaccount and its open orders; updates carry changed orders', () => {
    const a = createDydxAdapter({ network: 'testnet', WebSocket: WS, now: () => clock });
    const id = (acct.sent[0] as any).id as string, events: any[] = [], status: string[] = [];
    const off = a.stream({ type: 'account', account: id }, (e) => events.push(e), (s) => status.push(s));
    const sock = FakeSocket.last;
    expect(sock.url).toBe('wss://indexer.v4testnet.dydx.exchange/v4/ws');
    for (const m of acct.messages) sock.serve(m);
    expect(sock.subscriptions()).toEqual([`v4_subaccounts|${id}`]);
    expect(status).toEqual(['connected']);
    expect(events[0]).toMatchObject({ type: 'account', account: id, snapshot: true, hasFills: false });
    expect(events[0].subaccount.equity).toMatch(/^\d+(\.\d+)?$/);
    const snapOrders = (acct.messages[1]!.contents as any).orders as any[];
    expect(events[0].orders.map((o: any) => o.venueOrderId)).toEqual(snapOrders.map((o) => o.id));
    const updates = events.slice(1);
    expect(updates.length).toBe(acct.messages.filter((m) => m.type === 'channel_data' || m.type === 'channel_batch_data').length);
    // the recorded updates are partial objects of three different shapes (cancel with optimistic fill, cancel with final fill, placement)
    const ups = updates.flatMap((u) => u.orderUpdates);
    expect(ups.length).toBe(updates.length);
    expect(updates.every((u) => u.orders.length === 0 && u.subaccount === null && u.blockHeight !== null)).toBe(true);
    expect(new Set(ups.map((u: any) => u.venueStatus))).toEqual(new Set(['CANCELED', 'OPEN']));
    expect(ups.every((u: any) => u.instrument === 'dydx:TAO-USD' && /^\d+$/.test(u.clientId))).toBe(true);
    expect(ups.find((u: any) => u.venueStatus === 'OPEN').filled).toBeNull();          // a placement carries no fill figure
    expect(ups.find((u: any) => u.venueOrderId === '33914979-282d-535a-a907-bfb90982f4d3').filled).toBe('0.11');
    expect(ups.find((u: any) => u.venueStatus === 'CANCELED').removalReason).toBe('ORDER_REMOVAL_REASON_EXPIRED');
    off();
    expect(sock.closed).toBe(true);
  });

  it('book / trades / ticker subscriptions map to the indexer channels', () => {
    const a = createDydxAdapter({ WebSocket: WS, now: () => clock });
    a.stream({ type: 'book', symbol: 'BTC-USD' }, () => {}, () => {});
    a.stream({ type: 'trades', symbol: 'ETH-USD' }, () => {}, () => {});
    a.stream({ type: 'ticker', symbol: 'BTC-USD' }, () => {}, () => {});
    expect(FakeSocket.instances.length).toBe(1);                 // one shared connection
    FakeSocket.last.serve(connected());
    expect(FakeSocket.last.url).toBe('wss://indexer.dydx.trade/v4/ws');
    expect(FakeSocket.last.subscriptions()).toEqual(['v4_orderbook|BTC-USD', 'v4_trades|ETH-USD', 'v4_markets|']);
    expect(() => a.stream({ type: 'book', symbol: 'bad symbol' }, () => {}, () => {})).toThrow(/invalid market ticker/);
  });
});

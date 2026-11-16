// Backpressure of one client connection (services/api/src/quotes/outbox.ts) on a socket whose buffer the test controls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from '../src/quotes/hub.ts';
import { Outbox } from '../src/quotes/outbox.ts';
import type { BookMsg, DataMessage, QuoteMsg, TradeMsg } from '../src/quotes/protocol.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

class SlowSocket { sent: any[] = []; bufferedAmount = 0; send(data: string): void { this.sent.push(JSON.parse(data)); } }
const frame = (msg: DataMessage, key: string): Frame => ({ key, msg, text: JSON.stringify(msg), lagTs: null });
const quote = (id: string, mark: string, seq: number): Frame => frame({ v: 1, type: 'quote', id, bid: null, bidSize: null, ask: null, askSize: null, mid: null, mark, index: null, last: null, funding: null, openInterest: null, change24h: null, volume24h: null, venueTs: null, recvTs: 0, seq, source: 't', stale: false } satisfies QuoteMsg, `quote|${id}|`);
const book = (id: string, kind: 'snapshot' | 'delta', seq: number, prevSeq: number | null): Frame => frame({ v: 1, type: 'book', id, depth: 20, kind, bids: [['100', String(seq)]], asks: [], seq, prevSeq, checksum: seq, venueTs: null, recvTs: 0, source: 't', stale: false } satisfies BookMsg, `book|${id}|20`);
const trade = (id: string, n: number, seq: number): Frame => frame({ v: 1, type: 'trade', id, trades: Array.from({ length: n }, (_, k) => ({ id: `${seq}-${k}`, price: '1', size: '1', side: 'buy' as const, ts: 0 })), seq, recvTs: 0, source: 't' } satisfies TradeMsg, `trades|${id}|`);

function setup(o: Partial<ConstructorParameters<typeof Outbox>[1]> = {}) {
  const sock = new SlowSocket(), overflow = vi.fn(), snaps = new Map<string, DataMessage>();
  const out = new Outbox(sock, { lowWaterBytes: 1000, highWaterBytes: 10_000, overMs: 5_000, flushMs: 25, snapshot: (k) => snaps.get(k) ?? null, onOverflow: overflow, ...o });
  return { sock, out, overflow, snaps };
}

describe('outbox', () => {
  it('a client that keeps up receives every frame, in order, untouched', () => {
    const { sock, out } = setup();
    out.data(quote('a', '1', 1)); out.data(book('a', 'snapshot', 1, null)); out.data(book('a', 'delta', 2, 1)); out.data(trade('a', 2, 1)); out.data(quote('a', '2', 2));
    expect(sock.sent.map((m) => `${m.type}:${m.seq}`)).toEqual(['quote:1', 'book:1', 'book:2', 'trade:1', 'quote:2']);
    expect(out.stats).toMatchObject({ sent: 5, conflated: 0, tradesDropped: 0, queuedNow: 0 });
  });

  it('a slow client: quotes are conflated to the newest per market, trades are dropped and counted, nothing is sent out of order', () => {
    const { sock, out } = setup();
    out.data(quote('a', '1', 1));
    sock.bufferedAmount = 5000;                                                    // over the low-water mark: the client is behind
    for (let k = 2; k <= 500; k++) { out.data(quote('a', String(k), k)); out.data(quote('b', String(k), k)); }
    out.data(trade('a', 3, 1)); out.data(trade('a', 2, 2)); out.data(trade('b', 1, 1));
    expect(sock.sent.length).toBe(1);                                             // nothing written while the socket is full
    expect(out.stats).toMatchObject({ queuedNow: 2, queuedMax: 2, conflated: 996, tradesDropped: 6 });   // bounded: one entry per subscription
    vi.advanceTimersByTime(100); expect(sock.sent.length).toBe(1);                 // still full: the timer waits
    sock.bufferedAmount = 0; vi.advanceTimersByTime(25);
    expect(sock.sent.slice(1)).toEqual([
      { v: 1, type: 'dropped', channel: 'trades', id: 'a', count: 5, total: 5 }, { v: 1, type: 'dropped', channel: 'trades', id: 'b', count: 1, total: 1 },
      expect.objectContaining({ type: 'quote', id: 'a', mark: '500', seq: 500 }), expect.objectContaining({ type: 'quote', id: 'b', mark: '500', seq: 500 }),
    ]);
    // drained: direct again; a later drop is counted on top of the total
    out.data(quote('a', '501', 501)); expect(sock.sent.at(-1)).toMatchObject({ mark: '501' });
    sock.bufferedAmount = 5000; out.data(trade('a', 4, 3)); sock.bufferedAmount = 0; vi.advanceTimersByTime(25);
    expect(sock.sent.at(-1)).toEqual({ v: 1, type: 'dropped', channel: 'trades', id: 'a', count: 4, total: 9 });
  });

  it('book: one queued delta is sent as it is; two or more become ONE snapshot of the current book — never a delta over a hole', () => {
    const { sock, out, snaps } = setup();
    out.data(book('a', 'snapshot', 1, null));
    sock.bufferedAmount = 5000;
    out.data(book('a', 'delta', 2, 1));                                            // alone in the queue: its predecessor was sent
    sock.bufferedAmount = 0; vi.advanceTimersByTime(25);
    expect(sock.sent.at(-1)).toMatchObject({ kind: 'delta', seq: 2, prevSeq: 1 });
    sock.bufferedAmount = 5000;
    out.data(book('a', 'delta', 3, 2)); out.data(book('a', 'delta', 4, 3)); out.data(book('a', 'delta', 5, 4));
    snaps.set('book|a|20', book('a', 'snapshot', 5, null).msg);                     // what the hub holds when the client finally drains
    sock.bufferedAmount = 0; vi.advanceTimersByTime(25);
    expect(sock.sent.at(-1)).toMatchObject({ kind: 'snapshot', seq: 5, prevSeq: null });
    expect(sock.sent.filter((m) => m.type === 'book').map((m) => m.seq)).toEqual([1, 2, 5]);
    expect(out.stats).toMatchObject({ conflated: 2, bookResyncs: 1 });
    out.data(book('a', 'delta', 6, 5)); expect(sock.sent.at(-1)).toMatchObject({ kind: 'delta', seq: 6, prevSeq: 5 });   // the chain goes on from the snapshot
  });

  it('a client that stays over the high-water mark is cut; one far beyond it is cut at once', () => {
    const a = setup();
    a.sock.bufferedAmount = 20_000;
    a.out.data(quote('a', '1', 1)); expect(a.overflow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_000); a.out.data(quote('a', '2', 2)); expect(a.overflow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_100);                                                 // the flush timer notices by itself
    expect(a.overflow).toHaveBeenCalledTimes(1); expect(a.out.stats).toMatchObject({ overflowed: true, queuedNow: 0 });
    a.out.data(quote('a', '3', 3)); expect(a.sock.sent.length).toBe(0);            // closed: nothing more is written
    const b = setup();
    b.sock.bufferedAmount = 5000; b.out.data(quote('a', '1', 1)); vi.advanceTimersByTime(3_000);
    b.sock.bufferedAmount = 500; vi.advanceTimersByTime(25);                        // it recovered before the delay: not cut, the timer of the mark is reset
    expect(b.overflow).not.toHaveBeenCalled(); expect(b.sock.sent.length).toBe(1);
    const c = setup();
    c.sock.bufferedAmount = 40_001; c.out.data(quote('a', '1', 1)); expect(c.overflow).toHaveBeenCalledTimes(1);
  });

  it('control frames are always written; a channel the client left is forgotten', () => {
    const { sock, out } = setup();
    sock.bufferedAmount = 5000;
    out.data(quote('a', '1', 1)); out.data(quote('b', '1', 1));
    out.control({ v: 1, type: 'pong', t: 1, ts: 0 }); expect(sock.sent).toEqual([{ v: 1, type: 'pong', t: 1, ts: 0 }]);
    out.forget('quote|a|');
    sock.bufferedAmount = 0; vi.advanceTimersByTime(25);
    expect(sock.sent.slice(1).map((m) => m.id)).toEqual(['b']);
  });
});

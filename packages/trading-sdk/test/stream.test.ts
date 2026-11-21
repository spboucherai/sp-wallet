/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/test/stream.test.ts
 * Module           : trading-sdk
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

// SPWalletStream against a local fake server (a scripted socket in this process): the handshake by header or by ticket,
// never the key in the URL, subscribe / acknowledge / refuse, typed messages, callbacks and the async iterator, reconnection
// with backoff and resubscription, the heartbeat watchdog, credentials that must not be retried — and that the SDK's own
// message types and book checksum are those of the server (drift against services/api/src/quotes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerMessageSchema } from '../../../services/api/src/quotes/protocol.ts';
import * as shared from '../../../services/api/src/quotes/shared.ts';
import { bookChecksum, channelKey, OrderBook, SPWalletStream, STREAM_PATH, STREAM_PROTOCOL_VERSION, STREAM_TICKET_PATH, StreamError, type BookMessage, type StreamDataMessage, type StreamOptions, type WebSocketLike } from '../src/stream.ts';

const KEY = 'spw_live_spk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const HELLO = { v: 1, type: 'hello', connId: 'c1', heartbeatMs: 15_000, serverTs: 0, limits: { maxSubscriptions: 300, maxFrameBytes: 16384, maxMessagesPerSec: 20, idleTimeoutMs: 120_000 } };
/** the fake server's end of one connection */
class Server implements WebSocketLike {
  static all: Server[] = []; static refuse = 0;
  readyState = 0; received: any[] = []; closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: any) => void) | null = null; onmessage: ((ev: any) => void) | null = null; onclose: ((ev: any) => void) | null = null; onerror: ((ev: any) => void) | null = null;
  constructor(readonly url: string, readonly options?: any) {
    Server.all.push(this);
    if (Server.refuse > 0) { Server.refuse -= 1; queueMicrotask(() => { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006, reason: '' }); }); }
  }
  send(data: string): void { this.received.push(JSON.parse(data)); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; this.readyState = 3; }
  accept(): void { this.readyState = 1; this.onopen?.({}); this.push(HELLO); }
  push(m: unknown): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(code = 1006, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  ack(snapshots: Record<string, unknown> = {}): void { for (const f of this.received.filter((m) => m.op === 'subscribe')) for (const c of f.channels) { const key = channelKey(c); if (!this.acked.has(key)) { this.acked.add(key); this.push({ v: 1, type: 'subscribed', channel: c, key, staleAfterMs: 15_000, source: 'hyperliquid-ws', snapshot: snapshots[key] ?? null, snapshotAgeMs: snapshots[key] ? 12 : null }); } } }
  private acked = new Set<string>();
}
const last = () => Server.all.at(-1)!;
const quote = (id: string, mark: string, seq: number) => ({ v: 1, type: 'quote', id, bid: '64999', bidSize: '1', ask: '65001', askSize: '2', mid: '65000', mark, index: null, last: null, funding: '0.0000125', openInterest: null, change24h: null, volume24h: null, venueTs: 1, recvTs: 2, seq, source: 'hyperliquid-ws', stale: false }) as const;
const flush = async (n = 6) => { for (let k = 0; k < n; k++) await Promise.resolve(); };
const make = (o: Partial<StreamOptions> = {}) => new SPWalletStream({ apiKey: KEY, baseUrl: 'https://wallet.test', WebSocket: Server as never, random: () => 1, ...o });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); Server.all = []; Server.refuse = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('handshake', () => {
  it('Node: the key goes in the Authorization header of the handshake — never in the URL', async () => {
    const s = make();
    const p = s.connect(); await flush();
    expect(last().url).toBe(`wss://wallet.test${STREAM_PATH}`); expect(last().url).not.toContain('spw_live'); expect(last().options).toEqual({ headers: { authorization: `Bearer ${KEY}` } });
    last().accept(); await p;
    expect(s.state).toBe('open'); expect(s.hello).toMatchObject({ connId: 'c1', heartbeatMs: 15_000 });
    await expect(s.connect()).resolves.toBeUndefined();                            // idempotent
    expect(Server.all.length).toBe(1);
    s.close(); expect(last().closed).toEqual({ code: 1000, reason: 'client closed' }); expect(s.state).toBe('closed');
    await expect(s.connect()).rejects.toMatchObject({ code: 'closed' });
  });

  it('browser: a single-use ticket per connection — from the caller\'s function, or asked from the API with the key in a header', async () => {
    let n = 0;
    const a = make({ apiKey: undefined, ticket: async () => `spw_tkt_${++n}` });
    void a.connect(); await flush();
    expect(last().url).toBe(`wss://wallet.test${STREAM_PATH}?ticket=spw_tkt_1`); expect(last().options).toBeUndefined();
    last().accept(); await flush();
    last().drop(); vi.advanceTimersByTime(500); await flush();
    expect(last().url).toBe(`wss://wallet.test${STREAM_PATH}?ticket=spw_tkt_2`);     // a ticket is used once: a reconnection asks for a new one
    a.close();
    const calls: { url: string; init: RequestInit }[] = [];
    const b = make({ auth: 'ticket', fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ ticket: 'spw_tkt_from_api' }), { status: 200 }); }) as never });
    b.connect().catch(() => {}); await flush(12);
    expect(calls[0]).toMatchObject({ url: `https://wallet.test${STREAM_TICKET_PATH}`, init: { method: 'POST', headers: { authorization: `Bearer ${KEY}` } } });
    expect(last().url).toBe(`wss://wallet.test${STREAM_PATH}?ticket=spw_tkt_from_api`); expect(last().url).not.toContain(KEY);
    b.close();
  });

  it('a refused credential is not retried: the ticket endpoint says 401 / 403, or the stream never opens in three attempts', async () => {
    const a = make({ auth: 'ticket', fetch: (async () => new Response(JSON.stringify({ error: 'insufficient_scope', message: 'this key lacks the scope markets:read' }), { status: 403 })) as never });
    const errors: StreamError[] = []; a.on('error', (e) => errors.push(e));
    await expect(a.connect()).rejects.toMatchObject({ code: 'insufficient_scope' });
    expect(a.state).toBe('closed'); expect(Server.all.length).toBe(0); expect(errors[0]).toBeInstanceOf(StreamError);
    vi.advanceTimersByTime(120_000); expect(Server.all.length).toBe(0);
    Server.refuse = 99;
    const b = make(); const p = b.connect(); p.catch(() => {});
    for (let k = 0; k < 6; k++) { await flush(); vi.advanceTimersByTime(4000); }
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
    expect(Server.all.length).toBe(3); expect(b.state).toBe('closed');
    expect(() => new SPWalletStream({ baseUrl: 'https://wallet.test', apiKey: undefined, WebSocket: Server as never })).toThrow(/API key/);
    expect(() => make({ baseUrl: 'wallet.test' })).toThrow(/baseUrl/);
  });
});

describe('subscriptions and messages', () => {
  it('subscribe resolves on the acknowledgements, a refusal rejects with its code; callbacks and the iterator receive typed messages, snapshot first', async () => {
    const s = make(), quotes: string[] = [];
    s.on('quote', (q) => quotes.push(`${q.id}@${q.mark}`));
    const p = s.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 10 }]); await flush();
    last().accept(); await flush();
    expect(last().received).toEqual([{ v: STREAM_PROTOCOL_VERSION, op: 'subscribe', channels: [{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 10 }] }]);
    last().ack({ 'quote|hyperliquid:BTC|': quote('hyperliquid:BTC', '65000', 4) });
    await p;
    const bad = s.subscribe({ type: 'quote', id: 'hyperliquid:NOPE' }); await flush();
    last().push({ v: 1, type: 'error', code: 'unknown_instrument', message: "unknown instrument 'hyperliquid:NOPE'", channel: { type: 'quote', id: 'hyperliquid:NOPE' } });
    await expect(bad).rejects.toMatchObject({ name: 'StreamError', code: 'unknown_instrument', channel: { id: 'hyperliquid:NOPE' } });
    expect(s.subscriptions().map(channelKey)).toEqual(['quote|hyperliquid:BTC|', 'book|hyperliquid:BTC|10']);   // a refused channel is not kept
    last().push(quote('hyperliquid:BTC', '65010', 5)); last().push({ v: 1, type: 'heartbeat', ts: 1, subscriptions: 2 });
    last().push({ v: 1, type: 'dropped', channel: 'trades', id: 'hyperliquid:BTC', count: 3, total: 3 });
    expect(quotes).toEqual(['hyperliquid:BTC@65000', 'hyperliquid:BTC@65010']); expect(s.stats.tradesDroppedByServer).toBe(3);
    const got: StreamDataMessage[] = [];
    const loop = (async () => { for await (const m of s) { got.push(m); if (got.length === 3) break; } })();
    await flush(); last().push(quote('hyperliquid:BTC', '65020', 6)); await loop;
    expect(got.map((m) => (m.type === 'quote' ? m.mark : m.type))).toEqual(['65000', '65010', '65020']);   // nothing lost between subscribe and the loop
    s.unsubscribe({ type: 'quote', id: 'hyperliquid:BTC' });
    expect(last().received.at(-1)).toEqual({ v: 1, op: 'unsubscribe', channels: [{ type: 'quote', id: 'hyperliquid:BTC' }] });
    const ended = (async () => { let n = 0; for await (const _ of s) n += 1; return n; })();
    await flush(); s.close();
    expect(await ended).toBe(0);                                                    // close() ends the loops
  });

  it('a slow `for await` is bounded: the oldest messages leave and are counted', async () => {
    const s = make({ bufferSize: 100 }); void s.subscribe({ type: 'quote', id: 'hyperliquid:BTC' }).catch(() => {}); await flush(); last().accept(); await flush();
    const it = s[Symbol.asyncIterator]();
    for (let k = 1; k <= 250; k++) last().push(quote('hyperliquid:BTC', String(k), k));
    expect(s.stats.iteratorDropped).toBe(150);
    expect(((await it.next()).value as { mark: string }).mark).toBe('151');
    s.close();
  });
});

describe('reconnection', () => {
  it('backoff with jitter, every subscription sent again, pending subscribe calls told, the watchdog re-opens a frozen connection', async () => {
    const rnd = [0, 1]; let k = 0;
    const s = make({ random: () => rnd[k++ % 2]!, backoffMinMs: 1000 }), closes: any[] = [], opens: string[] = [];
    s.on('close', (c) => closes.push(c)); s.on('open', (h) => opens.push(h.connId));
    const p = s.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'trades', id: 'hyperliquid:BTC' }]); await flush();
    const s1 = last(); s1.accept(); s1.ack(); await p;
    s1.drop(1001, 'server shutting down');
    expect(closes).toEqual([{ code: 1001, reason: 'server shutting down', willReconnect: true }]); expect(s.state).toBe('reconnecting');
    vi.advanceTimersByTime(499); await flush(); expect(last()).toBe(s1);
    vi.advanceTimersByTime(1); await flush();                                       // 1 s × (0.5 + 0.5 × 0)
    const s2 = last(); expect(s2).not.toBe(s1);
    s2.drop();                                                                      // refused: 2 s × (0.5 + 0.5 × 1)
    vi.advanceTimersByTime(1999); await flush(); expect(last()).toBe(s2);
    vi.advanceTimersByTime(1); await flush();
    const s3 = last(); s3.accept(); await flush();
    expect(s3.received).toEqual([{ v: 1, op: 'subscribe', channels: [{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'trades', id: 'hyperliquid:BTC' }] }]);
    expect(s.state).toBe('open'); expect(opens.length).toBe(2); expect(s.stats).toMatchObject({ connects: 3, resubscribed: 2 });
    // frozen: no frame for 2.5 heartbeat periods
    vi.advanceTimersByTime(30_000); s3.push({ v: 1, type: 'heartbeat', ts: 1, subscriptions: 2 });
    vi.advanceTimersByTime(37_000); expect(s.state).toBe('open');
    vi.advanceTimersByTime(6_000); expect(s.state).toBe('reconnecting'); expect(closes.at(-1)).toMatchObject({ reason: 'no frame from the server (heartbeat watchdog)', willReconnect: true });
    // a revoked key or an ended session (4001) is final
    vi.advanceTimersByTime(1000); await flush(); last().accept(); await flush();
    const errors: StreamError[] = []; s.on('error', (e) => errors.push(e));
    last().drop(4001, 'the API key is no longer active');
    expect(s.state).toBe('closed'); expect(errors[0]).toMatchObject({ code: 'unauthorized', message: 'the API key is no longer active' });
    vi.advanceTimersByTime(120_000); await flush(); expect(Server.all.length).toBe(4);
  });
});

describe('the SDK and the server agree', () => {
  it('every message type of the SDK is a message of the server\'s protocol, version included', () => {
    expect(STREAM_PROTOCOL_VERSION).toBe(shared.QUOTE_PROTOCOL_VERSION);
    const samples: unknown[] = [HELLO, quote('hyperliquid:BTC', '65000', 1),
      { v: 1, type: 'book', id: 'x:BTC', depth: 20, kind: 'delta', bids: [['1', '0']], asks: [], seq: 2, prevSeq: 1, checksum: 3, venueTs: null, recvTs: 1, source: 's', stale: false } satisfies BookMessage,
      { v: 1, type: 'trade', id: 'x:BTC', trades: [{ id: 't', price: '1', size: '2', side: 'buy', ts: 1 }], seq: 1, recvTs: 1, source: 's', snapshot: true },
      { v: 1, type: 'candle', id: 'x:BTC', interval: '1m', ts: 1, open: '1', high: '2', low: '1', close: '2', volume: '3', seq: 1, recvTs: 1, source: 's' },
      { v: 1, type: 'status', venue: 'x', status: 'down', since: 1, ageMs: null, transport: 'poll', source: 's', detail: null, ts: 1 },
      { v: 1, type: 'dropped', channel: 'trades', id: 'x:BTC', count: 1, total: 1 }, { v: 1, type: 'error', code: 'restricted', message: 'm', channel: { type: 'quote', id: 'x:BTC' } }];
    for (const m of samples) expect(ServerMessageSchema.safeParse(m).success, JSON.stringify(m).slice(0, 60)).toBe(true);
    for (const c of [{ type: 'quote', id: 'a:B' }, { type: 'book', id: 'a:B' }, { type: 'book', id: 'a:B', depth: 5 }, { type: 'candle', id: 'a:B' }, { type: 'candle', id: 'a:B', interval: '4h' }, { type: 'status', id: '*' }] as const) expect(channelKey(c)).toBe(shared.channelKey(c));
  });

  it('OrderBook: the same checksum and the same merge as the server\'s helpers on random books; a hole or a wrong checksum is refused', () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const side = (base: number, dir: 1 | -1): [string, string][] => Array.from({ length: 20 }, (_, k): [string, string] => [(base + dir * k * 0.5).toFixed(1).replace(/\.0$/, ''), (rnd() * 10 + 0.01).toFixed(4)]);
    let bids = side(65000, -1), asks = side(65000.5, 1);
    const book = new OrderBook();
    expect(book.apply({ v: 1, type: 'book', id: 'x', depth: 20, kind: 'snapshot', bids, asks, seq: 1, prevSeq: null, checksum: shared.bookChecksum(bids, asks), venueTs: null, recvTs: 0, source: 's', stale: false })).toBe(true);
    for (let seq = 2; seq <= 200; seq++) {
      const nb = side(65000 + Math.floor(rnd() * 6 - 3) * 0.5, -1), na = side(65000.5 + Math.floor(rnd() * 6) * 0.5, 1);
      const m: BookMessage = { v: 1, type: 'book', id: 'x', depth: 20, kind: 'delta', bids: shared.diffLevels(bids, nb) as [string, string][], asks: shared.diffLevels(asks, na) as [string, string][], seq, prevSeq: seq - 1, checksum: shared.bookChecksum(nb, na), venueTs: null, recvTs: 0, source: 's', stale: false };
      expect(bookChecksum(nb, na)).toBe(m.checksum);
      expect(book.apply(m), `delta ${seq}`).toBe(true); expect(book.bids).toEqual(nb); expect(book.asks).toEqual(na);
      bids = nb; asks = na;
    }
    expect(book.apply({ v: 1, type: 'book', id: 'x', depth: 20, kind: 'delta', bids: [], asks: [], seq: 300, prevSeq: 299, checksum: 0, venueTs: null, recvTs: 0, source: 's', stale: false })).toBe(false);   // a hole
    expect(book.ready).toBe(false);
    expect(book.apply({ v: 1, type: 'book', id: 'x', depth: 20, kind: 'snapshot', bids, asks, seq: 301, prevSeq: null, checksum: 1, venueTs: null, recvTs: 0, source: 's', stale: false })).toBe(false);   // a snapshot whose checksum does not match
  });
});

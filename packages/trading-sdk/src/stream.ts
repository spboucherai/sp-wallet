// SPWalletStream — live public market data of the SP Wallet quote engine over a websocket (protocol version 1).
//
//   const stream = new SPWalletStream({ apiKey: 'spw_live_…', baseUrl: 'https://wallet.example' });
//   await stream.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 10 }]);
//   stream.on('quote', (q) => console.log(q.id, q.bid, q.ask, q.stale));
//   for await (const m of stream) { … }            // every data message, in order
//   stream.close();
//
// READ-ONLY: quotes, order books, trades, candles and venue statuses. Nothing here places, signs or cancels anything.
// Zero runtime dependency. Every price, size and rate is a decimal STRING: never parse it into a float to compute with it.
//
// Authentication (the key needs the scope `markets:read`; it is NEVER put in the URL):
//   - Node >= 22 (global WebSocket of undici) or the `ws` package passed as `WebSocket`: `Authorization: Bearer <key>` on the handshake;
//   - browsers cannot set a header on a websocket: the stream is opened with a single-use ticket (valid 30 s). Give `ticket`,
//     a function that returns a fresh one — your backend calls `POST /api/v1/trading/stream/ticket` with the key — or, when the
//     page is served by the wallet's own origin, give `apiKey` and the SDK asks for the ticket itself (`fetch`).
// It reconnects by itself (exponential backoff with jitter), subscribes again and keeps a watchdog on the server's heartbeat.
// After a reconnection the server sends fresh snapshots; a book is restarted from its snapshot (`OrderBook` below does it).
// Reference: docs/V11-QUOTE-ENGINE.md.

export const STREAM_PROTOCOL_VERSION = 1;
export const STREAM_PATH = '/api/v1/trading/stream';
export const STREAM_TICKET_PATH = '/api/v1/trading/stream/ticket';

export type StreamChannelType = 'quote' | 'book' | 'trades' | 'candle' | 'status';
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
/** `id` is `venue:symbol` as returned by GET /markets (`hyperliquid:BTC`, `dydx:BTC-USD`, `spot:BTC`…); for `status`, a venue id or `*` */
export interface StreamChannel { type: StreamChannelType; id: string; /** book: levels per side (default 20) */ depth?: 5 | 10 | 20; /** candle (default 1m) */ interval?: CandleInterval }
/** canonical decimal string */
export type Dec = string;
export type BookLevel = [price: Dec, size: Dec];

export interface QuoteMessage { v: 1; type: 'quote'; id: string; bid: Dec | null; bidSize: Dec | null; ask: Dec | null; askSize: Dec | null; mid: Dec | null; mark: Dec | null; index: Dec | null; last: Dec | null;
  funding: Dec | null; openInterest: Dec | null; change24h: Dec | null; volume24h: Dec | null;
  /** the venue's own timestamp (ms), null when it gives none */ venueTs: number | null; /** when the server received it (ms) */ recvTs: number; seq: number; source: string; stale: boolean }
export interface BookMessage { v: 1; type: 'book'; id: string; depth: number; kind: 'snapshot' | 'delta'; bids: BookLevel[]; asks: BookLevel[]; seq: number; prevSeq: number | null; checksum: number;
  venueTs: number | null; recvTs: number; source: string; stale: boolean }
export interface TradeMessage { v: 1; type: 'trade'; id: string; trades: { id: string; price: Dec; size: Dec; side: 'buy' | 'sell'; ts: number }[]; seq: number; recvTs: number; source: string; /** recent history sent on subscription */ snapshot?: boolean }
export interface CandleMessage { v: 1; type: 'candle'; id: string; interval: CandleInterval; ts: number; open: Dec; high: Dec; low: Dec; close: Dec; volume: Dec; seq: number; recvTs: number; source: string }
export interface StatusMessage { v: 1; type: 'status'; venue: string; status: 'connected' | 'reconnecting' | 'stale' | 'down' | 'idle'; since: number; ageMs: number | null; transport: 'stream' | 'poll'; source: string; detail: string | null; ts: number }
export type StreamDataMessage = QuoteMessage | BookMessage | TradeMessage | CandleMessage | StatusMessage;
export interface DroppedMessage { v: 1; type: 'dropped'; channel: 'trades'; id: string; count: number; total: number }
export interface StreamErrorMessage { v: 1; type: 'error'; code: string; message: string; channel?: StreamChannel; reqId?: string | number }
export interface SubscribedMessage { v: 1; type: 'subscribed'; channel: StreamChannel; key: string; reqId?: string | number; staleAfterMs: number | null; source: string | null; snapshot: StreamDataMessage | StreamDataMessage[] | null; snapshotAgeMs: number | null }
export interface HelloMessage { v: 1; type: 'hello'; connId: string; heartbeatMs: number; serverTs: number; limits: { maxSubscriptions: number; maxFrameBytes: number; maxMessagesPerSec: number; idleTimeoutMs: number } }
export type StreamServerMessage = StreamDataMessage | DroppedMessage | StreamErrorMessage | SubscribedMessage | HelloMessage
  | { v: 1; type: 'unsubscribed'; channel: StreamChannel; key: string; reqId?: string | number } | { v: 1; type: 'heartbeat'; ts: number; subscriptions: number } | { v: 1; type: 'pong'; t: number | null; ts: number };

export class StreamError extends Error {
  constructor(readonly code: string, message: string, readonly channel?: StreamChannel) { super(message); this.name = 'StreamError'; }
}

/** the part of a WebSocket the SDK uses (browsers, Node >= 22, the `ws` package) */
export interface WebSocketLike { send(data: string): void; close(code?: number, reason?: string): void; readyState: number;
  onopen: ((ev: any) => void) | null; onmessage: ((ev: any) => void) | null; onclose: ((ev: any) => void) | null; onerror: ((ev: any) => void) | null }
export type WebSocketCtor = new (url: string, options?: any) => WebSocketLike;

export interface StreamOptions {
  /** `spw_live_…` with the scope markets:read; default: the environment variable SP_WALLET_API_KEY (Node) */ apiKey?: string;
  /** where the API is served, e.g. `https://wallet.example` */ baseUrl: string;
  /** a function that returns a fresh single-use ticket; used instead of the header (browsers) */ ticket?: () => Promise<string>;
  /** `header` (Node), `ticket` (browsers); default: `ticket` when `ticket` is given or the code runs in a browser, else `header` */ auth?: 'header' | 'ticket';
  WebSocket?: WebSocketCtor; fetch?: typeof fetch;
  /** default true */ reconnect?: boolean; backoffMinMs?: number; backoffMaxMs?: number;
  /** data messages kept for `for await` when the consumer is slower than the feed (oldest dropped, counted in `iteratorDropped`). Default 10 000. */ bufferSize?: number;
  /** test hooks */ random?: () => number; now?: () => number;
}
export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
interface Events { quote: QuoteMessage; book: BookMessage; trade: TradeMessage; candle: CandleMessage; status: StatusMessage; dropped: DroppedMessage; error: StreamError; message: StreamServerMessage;
  open: HelloMessage; close: { code: number; reason: string; willReconnect: boolean }; subscribed: SubscribedMessage }

export const channelKey = (c: StreamChannel): string => `${c.type}|${c.id}|${c.type === 'book' ? c.depth ?? 20 : c.type === 'candle' ? c.interval ?? '1m' : ''}`;
const isData = (m: StreamServerMessage): m is StreamDataMessage => m.type === 'quote' || m.type === 'book' || m.type === 'trade' || m.type === 'candle' || m.type === 'status';
/** close codes and refusals after which trying again with the same credential is pointless */
const FATAL_CLOSE = new Set([4001]);
const FATAL_CODES = new Set(['configuration', 'unauthenticated', 'insufficient_scope', 'ip_not_allowed', 'mixed_credentials', 'key_path_forbidden']);

export class SPWalletStream implements AsyncIterable<StreamDataMessage> {
  state: StreamState = 'idle';
  /** counters: connections made, frames received, data messages dropped from the `for await` buffer, trades the SERVER dropped for this client */
  readonly stats = { connects: 0, frames: 0, iteratorDropped: 0, tradesDroppedByServer: 0, resubscribed: 0 };
  hello: HelloMessage | null = null;
  private readonly o: StreamOptions; private readonly key: string | undefined;
  private ws: WebSocketLike | null = null;
  private readonly subs = new Map<string, StreamChannel>();
  private readonly handlers = new Map<string, Set<(x: any) => void>>();
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }[]>();
  private opening: Promise<void> | null = null; private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private attempt = 0; private retry: ReturnType<typeof setTimeout> | null = null; private watchdog: ReturnType<typeof setInterval> | null = null; private lastFrameAt = 0;
  private buffer: StreamDataMessage[] = []; private waiters: ((r: IteratorResult<StreamDataMessage>) => void)[] = [];

  constructor(o: StreamOptions) {
    this.o = o;
    this.key = o.apiKey ?? ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SP_WALLET_API_KEY || undefined);   // no Node typing here: the package builds without @types/node
    if (!o.baseUrl || !/^https?:\/\//.test(o.baseUrl)) throw new StreamError('configuration', 'baseUrl must be an http(s) URL');
    if (!this.key && !o.ticket) throw new StreamError('configuration', 'an API key (apiKey or SP_WALLET_API_KEY) or a ticket function is required');
  }

  on<K extends keyof Events>(event: K, handler: (x: Events[K]) => void): () => void {
    let s = this.handlers.get(event);
    if (!s) { s = new Set(); this.handlers.set(event, s); }
    s.add(handler);
    return () => { s!.delete(handler); };
  }
  private emit<K extends keyof Events>(event: K, x: Events[K]): void { for (const h of [...(this.handlers.get(event) ?? [])]) { try { h(x); } catch { /* a handler must not break the stream */ } } }
  private now(): number { return (this.o.now ?? Date.now)(); }

  /** opens the connection (idempotent); resolves once the server said hello */
  connect(): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(new StreamError('closed', 'the stream was closed'));
    const p = new Promise<void>((resolve, reject) => { this.openWaiters.push({ resolve, reject }); });
    if (!this.ws && !this.opening && !this.retry) this.open();
    return p;
  }

  private async url(): Promise<{ url: string; options: unknown }> {
    const base = this.o.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws'), mode = this.o.auth ?? (this.o.ticket || typeof (globalThis as { document?: unknown }).document !== 'undefined' ? 'ticket' : 'header');
    if (mode === 'header') return { url: `${base}${STREAM_PATH}`, options: { headers: { authorization: `Bearer ${this.key}` } } };
    let ticket: string;
    if (this.o.ticket) ticket = await this.o.ticket();
    else {
      const f = this.o.fetch ?? fetch, r = await f(`${this.o.baseUrl.replace(/\/+$/, '')}${STREAM_TICKET_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({})) as { ticket?: string; error?: string; message?: string };
      if (!r.ok || !j.ticket) throw new StreamError(j.error ?? 'ticket_refused', j.message ?? `the stream ticket was refused (HTTP ${r.status})`);
      ticket = j.ticket;
    }
    return { url: `${base}${STREAM_PATH}?ticket=${encodeURIComponent(ticket)}`, options: undefined };
  }

  private open(): void {
    if (this.state !== 'reconnecting') this.state = 'connecting';
    this.opening = (async () => {
      const Ctor = this.o.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
      if (!Ctor) throw new StreamError('configuration', 'no WebSocket implementation: Node >= 22, a browser, or pass the `ws` package as the WebSocket option');
      const { url, options } = await this.url();
      if (this.state === 'closed') return;
      const ws = options === undefined ? new Ctor(url) : new Ctor(url, options);
      this.ws = ws; this.stats.connects += 1; this.lastFrameAt = this.now();
      let greeted = false;
      ws.onmessage = (ev) => { if (this.ws === ws) { greeted = this.onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data)) || greeted; } };
      ws.onerror = () => { /* a close follows */ };
      ws.onclose = (ev) => { if (this.ws === ws) { this.ws = null; this.onClose(Number(ev?.code ?? 1006), String(ev?.reason ?? ''), greeted); } };
    })().catch((e: unknown) => { this.ws = null; this.onClose(1006, e instanceof Error ? e.message : 'connection failed', false, e instanceof StreamError ? e : undefined); }).finally(() => { this.opening = null; });
  }

  private onClose(code: number, reason: string, greeted: boolean, cause?: StreamError): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.hello = null;
    if (this.state === 'closed') return;
    // a revoked credential, a refused ticket, or a stream that never opened in three attempts (a websocket handshake refused with
    // 401 / 403 gives the client no status to read): trying again would fail the same way. A stream that HAS worked keeps trying.
    const fatal = FATAL_CLOSE.has(code) || (cause !== undefined && FATAL_CODES.has(cause.code)) || (!greeted && this.stats.frames === 0 && this.attempt >= 2);
    const again = this.o.reconnect !== false && !fatal;
    this.emit('close', { code, reason, willReconnect: again });
    const err = cause ?? new StreamError(code === 4001 ? 'unauthorized' : 'disconnected', reason || `the connection was closed (${code})`);
    for (const list of this.pending.values()) for (const p of list) p.reject(err);
    this.pending.clear();
    if (!again) {
      this.state = 'closed';
      for (const w of this.openWaiters.splice(0)) w.reject(err);
      this.emit('error', err); this.finish();
      return;
    }
    this.state = 'reconnecting';
    const min = this.o.backoffMinMs ?? 500, max = this.o.backoffMaxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 16)) * (0.5 + 0.5 * (this.o.random ?? Math.random)());
    this.attempt += 1;
    this.retry = setTimeout(() => { this.retry = null; if (this.state !== 'closed') this.open(); }, delay);
  }

  /** returns true for the `hello` frame */
  private onFrame(text: string): boolean {
    let m: StreamServerMessage;
    try { m = JSON.parse(text) as StreamServerMessage; } catch { return false; }
    this.lastFrameAt = this.now(); this.stats.frames += 1;
    this.emit('message', m);
    if (m.type === 'hello') {
      this.hello = m; this.state = 'open'; this.attempt = 0;
      const wd = m.heartbeatMs * 2.5;
      this.watchdog = setInterval(() => { if (this.ws && this.now() - this.lastFrameAt > wd) { const ws = this.ws; this.ws = null; ws.onclose = null; try { ws.close(); } catch { /* gone */ } this.onClose(1006, 'no frame from the server (heartbeat watchdog)', true); } }, Math.max(250, m.heartbeatMs / 3));
      (this.watchdog as { unref?: () => void }).unref?.();
      const all = [...this.subs.values()];
      if (all.length) { this.stats.resubscribed += this.stats.connects > 1 ? all.length : 0; for (let i = 0; i < all.length; i += 100) this.send({ v: STREAM_PROTOCOL_VERSION, op: 'subscribe', channels: all.slice(i, i + 100) }); }
      for (const w of this.openWaiters.splice(0)) w.resolve();
      this.emit('open', m);
      return true;
    }
    if (m.type === 'subscribed') {
      for (const p of this.pending.get(m.key) ?? []) p.resolve();
      this.pending.delete(m.key);
      this.emit('subscribed', m);
      const snap = m.snapshot;
      if (snap) for (const s of Array.isArray(snap) ? snap : [snap]) this.data(s);
    } else if (m.type === 'error') {
      const e = new StreamError(m.code, m.message, m.channel);
      if (m.channel) { const k = channelKey(m.channel); for (const p of this.pending.get(k) ?? []) p.reject(e); this.pending.delete(k); if (['unknown_instrument', 'unsupported_channel', 'restricted'].includes(m.code)) this.subs.delete(k); }
      this.emit('error', e);
    } else if (m.type === 'dropped') { this.stats.tradesDroppedByServer += m.count; this.emit('dropped', m); }
    else if (isData(m)) this.data(m);
    return false;
  }
  private data(m: StreamDataMessage): void {
    this.emit(m.type, m as never);
    const w = this.waiters.shift();
    if (w) { w({ value: m, done: false }); return; }
    // kept for `for await` — bounded: when the consumer is slower than the feed (or never iterates) the oldest message leaves
    this.buffer.push(m);
    if (this.buffer.length > (this.o.bufferSize ?? 10_000)) { this.buffer.shift(); if (this.iterating) this.stats.iteratorDropped += 1; }
  }
  private iterating = false;
  private send(m: unknown): void { try { this.ws?.send(JSON.stringify(m)); } catch { /* the close handler reconnects */ } }

  /** subscribes (and stays subscribed across reconnections); resolves when the server acknowledged every channel, rejects with the first refusal */
  async subscribe(channels: StreamChannel | StreamChannel[]): Promise<void> {
    const list = Array.isArray(channels) ? channels : [channels];
    const waits = list.map((c) => new Promise<void>((resolve, reject) => { const k = channelKey(c); this.subs.set(k, c); const l = this.pending.get(k) ?? []; l.push({ resolve, reject }); this.pending.set(k, l); }));
    for (const w of waits) w.catch(() => {});
    const wasOpen = this.state === 'open';
    await this.connect();
    // a connection that just opened already sent every subscription in its hello handler
    if (wasOpen) for (let i = 0; i < list.length; i += 100) this.send({ v: STREAM_PROTOCOL_VERSION, op: 'subscribe', channels: list.slice(i, i + 100) });
    await Promise.all(waits);
  }
  unsubscribe(channels: StreamChannel | StreamChannel[]): void {
    const list = Array.isArray(channels) ? channels : [channels];
    for (const c of list) this.subs.delete(channelKey(c));
    if (this.state === 'open') this.send({ v: STREAM_PROTOCOL_VERSION, op: 'unsubscribe', channels: list });
  }
  /** asks for the snapshot of a channel again (a book whose sequence broke) */
  resync(channel: StreamChannel): void { if (this.state === 'open') this.send({ v: STREAM_PROTOCOL_VERSION, op: 'subscribe', channels: [channel] }); }
  subscriptions(): StreamChannel[] { return [...this.subs.values()]; }

  private finish(): void { for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  /** closes for good: no reconnection; pending `for await` loops end */
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(1000, 'client closed'); } catch { /* gone */ } }
    const err = new StreamError('closed', 'the stream was closed');
    for (const w of this.openWaiters.splice(0)) w.reject(err);
    for (const l of this.pending.values()) for (const p of l) p.reject(err);
    this.pending.clear(); this.finish();
  }

  /** every data message (quote, book, trade, candle, status), in order, until `close()` */
  [Symbol.asyncIterator](): AsyncIterator<StreamDataMessage> {
    this.iterating = true;
    return {
      next: (): Promise<IteratorResult<StreamDataMessage>> => {
        const m = this.buffer.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.state === 'closed') return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiters.push(resolve); });
      },
      return: (): Promise<IteratorResult<StreamDataMessage>> => { this.iterating = false; this.buffer = []; return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------- order book helper
const CRC = /* @__PURE__ */ (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
/** CRC-32 of `p:s|p:s…;p:s|…` over the best 10 levels of each side, bids first — the `checksum` of a book message */
export function bookChecksum(bids: readonly BookLevel[], asks: readonly BookLevel[]): number {
  const side = (l: readonly BookLevel[]): string => l.slice(0, 10).map((x) => `${x[0]}:${x[1]}`).join('|'), s = `${side(bids)};${side(asks)}`;
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = CRC[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const cmp = (a: string, b: string): number => {
  const [ai = '', af = ''] = a.split('.'), [bi = '', bf = ''] = b.split('.');
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const n = Math.max(af.length, bf.length), x = af.padEnd(n, '0'), y = bf.padEnd(n, '0');
  return x === y ? 0 : x < y ? -1 : 1;
};
/**
 * A local order book kept from the stream: `apply(message)` returns false when the message cannot be applied (a hole in the
 * sequence or a checksum that does not match) — call `stream.resync(channel)` then, and do not read the book until the next
 * snapshot made `ready` true again. Prices are positive decimal strings; nothing is converted to a float.
 */
export class OrderBook {
  bids: BookLevel[] = []; asks: BookLevel[] = []; seq: number | null = null; ready = false;
  apply(m: BookMessage): boolean {
    if (m.kind === 'snapshot') { this.bids = m.bids.slice(); this.asks = m.asks.slice(); }
    else {
      if (!this.ready || m.prevSeq !== this.seq) { this.ready = false; return false; }
      const merge = (levels: BookLevel[], changes: BookLevel[], desc: boolean): BookLevel[] => {
        const map = new Map<string, string>(levels.map((l) => [l[0], l[1]]));
        for (const [p, s] of changes) { if (s === '0') map.delete(p); else map.set(p, s); }
        return ([...map.entries()] as BookLevel[]).sort((x, y) => (desc ? cmp(y[0], x[0]) : cmp(x[0], y[0]))).slice(0, m.depth);
      };
      this.bids = merge(this.bids, m.bids, true); this.asks = merge(this.asks, m.asks, false);
    }
    this.seq = m.seq;
    this.ready = bookChecksum(this.bids, this.asks) === m.checksum;
    return this.ready;
  }
}

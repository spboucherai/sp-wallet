// dYdX v4 indexer websocket (https://docs.dydx.xyz/indexer-client/websockets): one connection, many subscriptions.
// Channels: v4_orderbook, v4_trades (per ticker), v4_markets (all markets), v4_subaccounts (`<address>/<subaccountNumber>`).
//
// Reliability model
// - Every server message carries a per-connection `message_id`. Ids were observed OUT OF ORDER around subscriptions (the
//   snapshot of a slow channel arrives after later ids), so order is not enforced; instead an id that is still missing
//   `gapMs` after a later one arrived is a gap → status `stale` → reconnect and resubscribe (fresh snapshots).
// - An id already seen is a duplicate delivery and is dropped. Trades are also de-duplicated by trade id across reconnects.
// - No message at all for `staleMs` (the client pings every `pingMs`) → `stale` → reconnect.
// - Reconnect uses exponential backoff; every subscription is re-sent after `connected`.
import { z } from 'zod';
import { D } from '../../decimal.ts';
import type { Book, PublicTrade, Ticker } from '../../models.ts';
import type { StreamStatus } from '../../venue.ts';
import { instrumentId, orderOf, tickerOf, tradeOf, type DydxOrder } from './map.ts';
import * as W from './wire.ts';

export interface WebSocketLike {
  send(data: string): void; close(): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export type DydxStreamEvent =
  | { type: 'book'; symbol: string; snapshot: boolean; crossed: boolean; book: Book }
  | { type: 'trades'; symbol: string; snapshot: boolean; trades: PublicTrade[] }
  | { type: 'ticker'; symbol: string; snapshot: boolean; ticker: Ticker }
  /** account events are a trigger to re-read the account over REST: they carry the changed orders and flags, not a full state */
  | { type: 'account'; account: string; snapshot: boolean; subaccount: W.Subaccount | null;
      /** complete open orders, in the snapshot only */ orders: DydxOrder[];
      /** order changes: the indexer sends PARTIAL objects here (fields vary by cause), so only the identity and the venue status are normalized */
      orderUpdates: DydxOrderUpdate[]; hasFills: boolean; hasPositionChange: boolean; blockHeight: string | null; raw: unknown }
  | { type: 'error'; message: string };

export interface DydxStreamOptions {
  url: string; WebSocket?: WebSocketCtor; now?: () => number;
  /** levels per side in emitted books (default 50) */ depth?: number;
  pingMs?: number; staleMs?: number; gapMs?: number; backoffMs?: number; maxBackoffMs?: number;
}
export interface DydxOrderUpdate { venueOrderId: string; clientId: string; instrument: string; venueStatus: string; filled: string | null; removalReason: string | null; raw: unknown }
type Handler = { symbol: string | null; on: (ev: DydxStreamEvent) => void; onStatus: (s: StreamStatus) => void };
interface Sub { channel: 'v4_orderbook' | 'v4_trades' | 'v4_markets' | 'v4_subaccounts'; id: string | null; handlers: Set<Handler>;
  bids: Map<string, string>; asks: Map<string, string>; markets: Map<string, Record<string, unknown>>; live: boolean }

const envelope = z.object({ type: z.string(), message_id: z.number().int().nonnegative().optional(), channel: z.string().optional(), id: z.string().optional(), contents: z.unknown().optional(), message: z.string().optional() });
const bookSnapshot = W.orderbook;
const bookDelta = z.object({ bids: z.array(z.tuple([W.dec, W.dec]).rest(z.unknown())).optional(), asks: z.array(z.tuple([W.dec, W.dec]).rest(z.unknown())).optional() });
const marketsDelta = z.object({
  trading: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  oraclePrices: z.record(z.string(), z.object({ oraclePrice: W.dec })).optional(),
});
const accountSnapshot = z.object({ subaccount: W.subaccount, orders: z.array(W.order).optional(), blockHeight: z.string().optional() });
const orderUpdate = z.looseObject({ id: z.string().min(1), clientId: z.string().regex(/^\d+$/), ticker: z.string().min(1), status: z.string().min(1),
  totalFilled: W.dec.optional(), totalOptimisticFilled: W.dec.optional(), removalReason: z.string().optional() });
const accountDelta = z.object({ orders: z.array(orderUpdate).optional(), fills: z.array(z.unknown()).optional(), perpetualPositions: z.array(z.unknown()).optional(),
  assetPositions: z.array(z.unknown()).optional(), blockHeight: z.string().optional() });

const cmpDesc = (a: [string, string], b: [string, string]) => D.cmp(D.from(b[0]), D.from(a[0]));
const cmpAsc = (a: [string, string], b: [string, string]) => D.cmp(D.from(a[0]), D.from(b[0]));

export class DydxStream {
  private readonly o: Required<Omit<DydxStreamOptions, 'WebSocket'>> & { WebSocket: WebSocketCtor };
  private readonly subs = new Map<string, Sub>();
  private ws: WebSocketLike | null = null;
  private connected = false;
  private attempt = 0;
  private nextId = 0;
  private readonly ahead = new Set<number>();
  private lastMessageAt = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly seenTrades = new Map<string, Set<string>>();

  constructor(o: DydxStreamOptions) {
    const WS = o.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!WS) throw new Error('no WebSocket implementation available');
    this.o = { url: o.url, WebSocket: WS, now: o.now ?? Date.now, depth: o.depth ?? 50, pingMs: o.pingMs ?? 15_000, staleMs: o.staleMs ?? 40_000,
      gapMs: o.gapMs ?? 5_000, backoffMs: o.backoffMs ?? 500, maxBackoffMs: o.maxBackoffMs ?? 30_000 };
  }

  /** Subscribe; returns the unsubscribe function. `symbol` filters v4_markets events to one ticker. */
  subscribe(channel: Sub['channel'], id: string | null, symbol: string | null, on: Handler['on'], onStatus: Handler['onStatus']): () => void {
    const key = `${channel}|${id ?? ''}`;
    let sub = this.subs.get(key);
    const h: Handler = { symbol, on, onStatus };
    if (!sub) {
      sub = { channel, id, handlers: new Set(), bids: new Map(), asks: new Map(), markets: new Map(), live: false };
      this.subs.set(key, sub);
      if (this.connected) this.sendSub(sub);
    } else if (sub.live) {
      // late joiner on a channel that is already live: give it the current state as a snapshot
      queueMicrotask(() => { if (sub!.handlers.has(h)) this.replay(sub!, h); });
    }
    sub.handlers.add(h);
    if (!this.ws && !this.retryTimer) this.open();
    else if (this.connected) onStatus('connected');
    return () => {
      const s = this.subs.get(key);
      if (!s || !s.handlers.delete(h)) return;
      if (s.handlers.size === 0) {
        this.subs.delete(key);
        if (this.connected) this.send({ type: 'unsubscribe', channel: s.channel, ...(s.id === null ? {} : { id: s.id }) });
      }
      if (this.subs.size === 0) this.shutdown();
    };
  }

  private send(m: unknown): void { try { this.ws?.send(JSON.stringify(m)); } catch { /* the close handler reconnects */ } }
  private sendSub(s: Sub): void { this.send({ type: 'subscribe', channel: s.channel, ...(s.id === null ? {} : { id: s.id }), batched: true }); }
  private status(s: StreamStatus): void { for (const sub of this.subs.values()) for (const h of sub.handlers) h.onStatus(s); }

  private open(): void {
    this.retryTimer = null;
    const ws = new this.o.WebSocket(this.o.url);
    this.ws = ws;
    this.connected = false;
    this.lastMessageAt = this.o.now();
    ws.onmessage = (ev) => { if (this.ws === ws) this.onMessage(ev.data); };
    ws.onclose = () => { if (this.ws === ws) this.reconnect('reconnecting'); };
    ws.onerror = () => { if (this.ws === ws) this.reconnect('reconnecting'); };
    ws.onopen = () => { /* the server announces readiness with a `connected` message */ };
    if (!this.tick) {
      this.tick = setInterval(() => {
        if (!this.ws) return;
        if (this.o.now() - this.lastMessageAt > this.o.staleMs) { this.reconnect('stale'); return; }
        if (this.connected) this.send({ type: 'ping' });
      }, this.o.pingMs);
    }
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    this.ahead.clear();
    for (const s of this.subs.values()) s.live = false;
    if (ws) { ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null; try { ws.close(); } catch { /* already closed */ } }
  }
  private reconnect(why: StreamStatus): void {
    this.drop();
    if (this.subs.size === 0) { this.shutdown(); return; }
    this.status(why);
    if (why === 'stale') this.status('reconnecting');
    if (this.retryTimer) return;
    const delay = Math.min(this.o.maxBackoffMs, this.o.backoffMs * 2 ** this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }
  private shutdown(): void {
    this.drop();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    this.attempt = 0;
  }

  /** true when this message id was already delivered */
  private track(id: number): boolean {
    if (id < this.nextId || this.ahead.has(id)) return true;
    if (id === this.nextId) {
      this.nextId += 1;
      while (this.ahead.delete(this.nextId)) this.nextId += 1;
      if (this.ahead.size === 0 && this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    } else {
      this.ahead.add(id);
      if (!this.gapTimer) this.gapTimer = setTimeout(() => { this.gapTimer = null; if (this.ahead.size > 0) this.reconnect('stale'); }, this.o.gapMs);
    }
    return false;
  }

  private onMessage(data: unknown): void {
    this.lastMessageAt = this.o.now();
    let env: z.infer<typeof envelope>;
    try { env = envelope.parse(JSON.parse(typeof data === 'string' ? data : String(data))); }
    catch { this.reconnect('stale'); return; }                    // an unreadable frame may hide a state change
    if (env.type === 'connected') {
      this.connected = true;
      this.attempt = 0;
      this.nextId = (env.message_id ?? 0) + 1;
      this.ahead.clear();
      for (const s of this.subs.values()) this.sendSub(s);
      this.status('connected');
      return;
    }
    if (env.message_id !== undefined && this.track(env.message_id)) return;
    if (env.type === 'pong' || env.type === 'unsubscribed') return;
    if (env.type === 'error') {
      // e.g. "Invalid subscription id for channel: (v4_orderbook-NOPE-USD)"
      const m = /\((v4_[a-z]+)-([^)]+)\)/.exec(env.message ?? '');
      const target = m ? this.subs.get(`${m[1]}|${m[2]}`) : undefined;
      for (const s of target ? [target] : this.subs.values()) for (const h of s.handlers) h.on({ type: 'error', message: env.message ?? 'error' });
      return;
    }
    const sub = env.channel ? this.subs.get(`${env.channel}|${env.id ?? ''}`) : undefined;
    if (!sub) return;                                             // late data for a channel we left
    try {
      if (env.type === 'subscribed') this.snapshot(sub, env.contents);
      else if (env.type === 'channel_data') this.delta(sub, env.contents);
      else if (env.type === 'channel_batch_data') for (const c of z.array(z.unknown()).parse(env.contents)) this.delta(sub, c);
    } catch { this.reconnect('stale'); }                          // malformed contents: the local state can no longer be trusted
  }

  private book(sub: Sub): { book: Book; crossed: boolean } {
    const bids = [...sub.bids.entries()].sort(cmpDesc).slice(0, this.o.depth), asks = [...sub.asks.entries()].sort(cmpAsc).slice(0, this.o.depth);
    const crossed = bids.length > 0 && asks.length > 0 && D.cmp(D.from(bids[0]![0]), D.from(asks[0]![0])) >= 0;
    return { book: { instrument: instrumentId(sub.id!), bids, asks, ts: this.o.now() }, crossed };
  }
  private emit(sub: Sub, ev: DydxStreamEvent, only?: Handler): void { for (const h of only ? [only] : sub.handlers) h.on(ev); }
  private emitTicker(sub: Sub, symbol: string, snapshot: boolean, only?: Handler): void {
    const raw = sub.markets.get(symbol);
    if (!raw) return;
    const m = W.perpetualMarket.parse(raw);
    for (const h of only ? [only] : sub.handlers) if (h.symbol === symbol) h.on({ type: 'ticker', symbol, snapshot, ticker: tickerOf(m, this.o.now()) });
  }
  private replay(sub: Sub, h: Handler): void {
    if (sub.channel === 'v4_orderbook') this.emit(sub, { type: 'book', symbol: sub.id!, snapshot: true, ...this.book(sub) }, h);
    else if (sub.channel === 'v4_markets' && h.symbol) this.emitTicker(sub, h.symbol, true, h);
    h.onStatus('connected');
  }

  private newTrades(symbol: string, list: z.infer<typeof W.trade>[]): PublicTrade[] {
    let seen = this.seenTrades.get(symbol);
    if (!seen) { seen = new Set(); this.seenTrades.set(symbol, seen); }
    const out: PublicTrade[] = [];
    for (const t of list) { if (seen.has(t.id)) continue; seen.add(t.id); out.push(tradeOf(symbol, t)); }
    if (seen.size > 4000) { const keep = [...seen].slice(-2000); seen.clear(); for (const k of keep) seen.add(k); }
    return out.sort((a, b) => a.ts - b.ts);
  }

  private snapshot(sub: Sub, contents: unknown): void {
    sub.live = true;
    switch (sub.channel) {
      case 'v4_orderbook': {
        const b = bookSnapshot.parse(contents);
        sub.bids = new Map(b.bids.map((l) => [l.price, l.size]));
        sub.asks = new Map(b.asks.map((l) => [l.price, l.size]));
        this.emit(sub, { type: 'book', symbol: sub.id!, snapshot: true, ...this.book(sub) });
        return;
      }
      case 'v4_trades': {
        const t = W.trades.parse(contents);
        this.emit(sub, { type: 'trades', symbol: sub.id!, snapshot: true, trades: this.newTrades(sub.id!, t.trades) });
        return;
      }
      case 'v4_markets': {
        const m = z.object({ markets: z.record(z.string(), z.record(z.string(), z.unknown())) }).parse(contents);
        sub.markets = new Map(Object.entries(m.markets));
        for (const symbol of new Set([...sub.handlers].map((h) => h.symbol))) if (symbol) this.emitTicker(sub, symbol, true);
        return;
      }
      case 'v4_subaccounts': {
        const a = accountSnapshot.parse(contents);
        this.emit(sub, { type: 'account', account: sub.id!, snapshot: true, subaccount: a.subaccount, orders: (a.orders ?? []).map(orderOf), orderUpdates: [],
          hasFills: false, hasPositionChange: false, blockHeight: a.blockHeight ?? null, raw: contents });
        return;
      }
    }
  }

  private delta(sub: Sub, contents: unknown): void {
    if (!sub.live) return;                                        // data before the snapshot cannot be applied
    switch (sub.channel) {
      case 'v4_orderbook': {
        const d = bookDelta.parse(contents);
        for (const [side, levels] of [[sub.bids, d.bids], [sub.asks, d.asks]] as const) {
          for (const [price, size] of levels ?? []) {
            const p = W.canon(price), s = W.canon(size);
            if (D.isZero(D.from(s))) side.delete(p); else side.set(p, s);
          }
        }
        this.emit(sub, { type: 'book', symbol: sub.id!, snapshot: false, ...this.book(sub) });
        return;
      }
      case 'v4_trades': {
        const fresh = this.newTrades(sub.id!, W.trades.parse(contents).trades);
        if (fresh.length) this.emit(sub, { type: 'trades', symbol: sub.id!, snapshot: false, trades: fresh });
        return;
      }
      case 'v4_markets': {
        const d = marketsDelta.parse(contents);
        const touched = new Set<string>();
        for (const [t, patch] of Object.entries(d.trading ?? {})) { sub.markets.set(t, { ...(sub.markets.get(t) ?? {}), ...patch }); touched.add(t); }
        for (const [t, p] of Object.entries(d.oraclePrices ?? {})) { const cur = sub.markets.get(t); if (cur) { sub.markets.set(t, { ...cur, oraclePrice: p.oraclePrice }); touched.add(t); } }
        for (const t of touched) this.emitTicker(sub, t, false);
        return;
      }
      case 'v4_subaccounts': {
        const d = accountDelta.parse(contents);
        this.emit(sub, { type: 'account', account: sub.id!, snapshot: false, subaccount: null, orders: [],
          orderUpdates: (d.orders ?? []).map((u): DydxOrderUpdate => ({ venueOrderId: u.id, clientId: u.clientId, instrument: instrumentId(u.ticker), venueStatus: u.status,
            filled: u.totalFilled !== undefined ? W.canon(u.totalFilled) : u.totalOptimisticFilled !== undefined ? W.canon(u.totalOptimisticFilled) : null,
            removalReason: u.removalReason ?? null, raw: u })),
          hasFills: (d.fills?.length ?? 0) > 0, hasPositionChange: (d.perpetualPositions?.length ?? 0) > 0 || (d.assetPositions?.length ?? 0) > 0,
          blockHeight: d.blockHeight ?? null, raw: contents });
        return;
      }
    }
  }
}

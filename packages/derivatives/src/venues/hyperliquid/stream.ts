// Hyperliquid websocket client: l2Book, trades, activeAssetCtx, allMids and the user feeds (userFills, orderUpdates, userEvents).
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket (+ /subscriptions, /timeouts-and-heartbeats)
//   "The server will close any connection if it hasn't sent a message to it in the last 60 seconds" → { "method": "ping" } /
//   { "channel": "pong" }.   "all automated users should handle disconnects from the server side and gracefully reconnect …
//   Missed data during the reconnect will be present in the snapshot ack on reconnect."
// One connection per adapter, shared by every subscription. It reconnects by itself (exponential backoff with jitter),
// subscribes again, and tells each consumer that a GAP may exist: status 'reconnecting' → 'connected' plus a `{ type: 'gap' }`
// event. A consumer must then take a fresh snapshot (REST) before trusting its local state. Fills and public trades are
// de-duplicated by id across messages, snapshots and reconnects.
import type { z } from 'zod';
import type { DecStr } from '../../decimal.ts';
import type { Book, Fill, FundingPayment, PublicTrade, Ticker } from '../../models.ts';
import { VenueError } from '../../venue.ts';
import { hlAccount, hlBook, hlFillId, hlFillOf, hlOrderStatus, hlPublicTrade, hlTicker, hlTradeId } from './mappers.ts';
import { HL_WS } from './http.ts';
import { hlL2Book, hlTrades, hlWsActiveAssetCtx, hlWsAllMids, hlWsEnvelope, hlWsOrders, hlWsUserEvent, hlWsUserFills } from './schemas.ts';
import type { HlNetwork } from './signing.ts';

/** the part of the WHATWG WebSocket that is used; tests inject a fake */
export interface HlWebSocketLike {
  send(data: string): void; close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export type HlWebSocketCtor = new (url: string) => HlWebSocketLike;

export interface HlStreamOptions {
  network: HlNetwork; now?: () => number; url?: string;
  /** defaults to the global WebSocket (Node ≥ 22, browsers) */
  WebSocket?: HlWebSocketCtor;
  /** heartbeat period; the server drops a connection it has sent nothing to for 60 s. Default 15 s. */
  pingIntervalMs?: number;
  /** no message at all (data or pong) for this long → 'stale'. Default 25 s. */
  staleAfterMs?: number;
  /** still nothing this long after 'stale' → the connection is dropped and re-opened. Default 10 s. */
  staleGraceMs?: number;
  /** reconnect backoff bounds; the venue allows 30 new connections per minute. Default 1 s … 30 s. */
  backoffMinMs?: number; backoffMaxMs?: number;
  random?: () => number;
  /** how many fill / trade ids are remembered per feed. Default 5000. */
  dedupeSize?: number;
}

export interface HlOrderUpdate { instrument: string; venueOrderId: string; clientId: string | null; side: 'buy' | 'sell'; price: DecStr; size: DecStr; remaining: DecStr;
  status: 'open' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected' | 'triggered' | 'pending'; venueStatus: string; createdAt: number; updatedAt: number }
export type HlStreamEvent =
  | { type: 'book'; book: Book }
  | { type: 'trades'; trades: PublicTrade[] }
  | { type: 'ticker'; ticker: Ticker }
  | { type: 'mids'; mids: Record<string, DecStr>; ts: number }
  | { type: 'fills'; fills: Fill[]; snapshot: boolean }
  | { type: 'orders'; orders: HlOrderUpdate[] }
  | { type: 'funding'; payment: FundingPayment }
  | { type: 'liquidation'; raw: unknown }
  | { type: 'cancelled_by_venue'; orders: { instrument: string; venueOrderId: string }[] }
  /** the connection was lost and re-established: anything may have been missed — take a snapshot again */
  | { type: 'gap'; reason: 'reconnected' }
  /** a message that failed validation was dropped */
  | { type: 'invalid'; channel: string; reason: string };

export type HlStreamSub = { type: 'book' | 'trades' | 'ticker'; symbol: string } | { type: 'account'; account: string } | { type: 'mids' };
export type HlStreamStatus = 'connected' | 'reconnecting' | 'stale';

export interface HlStream {
  subscribe(sub: HlStreamSub, on: (ev: unknown) => void, onStatus: (s: HlStreamStatus) => void): () => void;
  close(): void;
  stats(): { connects: number; messages: number; invalid: number; duplicates: number; subscriptions: number; status: HlStreamStatus | 'idle' };
}

type WireSub = Record<string, string>;
interface Consumer { keys: string[]; on: (ev: HlStreamEvent) => void; onStatus: (s: HlStreamStatus) => void; status: HlStreamStatus | null }

/** a connection must have lasted this long before the reconnect backoff starts again from its minimum */
const STABLE_MS = 10_000;
const keyOf = (s: WireSub): string => `${s.type}:${s.coin ?? s.user ?? ''}`;

class Seen {
  private readonly set = new Set<string>(); private readonly max: number;
  constructor(max: number) { this.max = max; }
  /** true the first time an id is offered */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value!);
    return true;
  }
}

export function createHlStream(o: HlStreamOptions): HlStream {
  const now = o.now ?? Date.now, url = o.url ?? HL_WS[o.network], random = o.random ?? Math.random;
  const pingIntervalMs = o.pingIntervalMs ?? 15_000, staleAfterMs = o.staleAfterMs ?? 25_000, staleGraceMs = o.staleGraceMs ?? 10_000;
  const backoffMinMs = o.backoffMinMs ?? 1000, backoffMaxMs = o.backoffMaxMs ?? 30_000, dedupeSize = o.dedupeSize ?? 5000;

  const consumers = new Set<Consumer>();
  const wire = new Map<string, { sub: WireSub; refs: number }>();
  const seen = new Map<string, Seen>(); // per feed, kept across reconnects
  const seenFor = (k: string): Seen => { let s = seen.get(k); if (!s) { s = new Seen(dedupeSize); seen.set(k, s); } return s; };
  let ws: HlWebSocketLike | null = null, open = false, everConnected = false, attempt = 0, lastMessageAt = 0, openedAt = 0, user: string | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null, watchTimer: ReturnType<typeof setInterval> | null = null, retryTimer: ReturnType<typeof setTimeout> | null = null;
  const st = { connects: 0, messages: 0, invalid: 0, duplicates: 0 };
  let status: HlStreamStatus | 'idle' = 'idle';

  const setStatus = (s: HlStreamStatus): void => {
    status = s;
    for (const c of consumers) if (c.status !== s) { c.status = s; try { c.onStatus(s); } catch { /* a consumer must not break the stream */ } }
  };
  const emit = (key: string | null, ev: HlStreamEvent): void => {
    for (const c of consumers) if (key === null || c.keys.includes(key)) { try { c.on(ev); } catch { /* idem */ } }
  };
  const send = (msg: unknown): void => { if (ws && open) { try { ws.send(JSON.stringify(msg)); } catch { /* the close handler reconnects */ } } };

  const stopTimers = (): void => {
    if (pingTimer) clearInterval(pingTimer); if (watchTimer) clearInterval(watchTimer);
    pingTimer = watchTimer = null;
  };
  const drop = (): void => { // forget the current socket without reacting to its late events
    stopTimers();
    if (ws) { const old = ws; ws = null; open = false; old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* already closed */ } }
  };
  const scheduleReconnect = (): void => {
    // the backoff starts again only after a connection that lasted: a server that accepts and drops at once (which is what it
    // does on a subscription to an unknown coin) must not be hammered — the venue allows 30 new connections per minute
    if (open && now() - openedAt >= STABLE_MS) attempt = 0;
    drop();
    if (consumers.size === 0) { status = 'idle'; return; }
    setStatus('reconnecting');
    if (retryTimer) return;
    const delay = Math.min(backoffMaxMs, backoffMinMs * 2 ** Math.min(attempt, 16)) * (0.5 + 0.5 * random());
    attempt += 1;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };

  const invalid = (channel: string, key: string | null, reason: string): void => { st.invalid += 1; emit(key, { type: 'invalid', channel, reason: reason.slice(0, 160) }); };
  const parse = <S extends z.ZodType>(schema: S, data: unknown, channel: string, key: (d: z.output<S>) => string | null): { data: z.output<S>; key: string } | null => {
    const r = schema.safeParse(data);
    if (!r.success) { invalid(channel, null, r.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')); return null; }
    const k = key(r.data);
    if (k === null || !wire.has(k)) return null; // not (or no longer) subscribed: ignore
    return { data: r.data, key: k };
  };
  const fresh = <T>(feed: string, items: T[], id: (x: T) => string): T[] => {
    const s = seenFor(feed);
    const out = items.filter((x) => s.add(id(x)));
    st.duplicates += items.length - out.length;
    return out;
  };
  const fillsOut = (fills: z.output<typeof hlWsUserFills>['fills'], snapshot: boolean): void => {
    if (user === null) return;
    const key = `userFills:${user}`, out = fresh(`fills:${user}`, fills, hlFillId);
    if (out.length || snapshot) emit(key, { type: 'fills', fills: out.map(hlFillOf).sort((a, b) => a.ts - b.ts), snapshot });
  };

  const onMessage = (raw: unknown): void => {
    lastMessageAt = now(); st.messages += 1;
    if (status === 'stale') setStatus('connected'); // same connection, the transport is ordered and lossless: no gap
    let msg: unknown;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { invalid('?', null, 'message is not JSON'); return; }
    const env = hlWsEnvelope.safeParse(msg);
    if (!env.success) { invalid('?', null, 'message has no channel'); return; }
    const { channel, data } = env.data;
    try {
      switch (channel) {
        case 'pong': case 'subscriptionResponse': return;
        case 'error': invalid('error', null, typeof data === 'string' ? data : JSON.stringify(data ?? null)); return;
        case 'l2Book': { const p = parse(hlL2Book, data, channel, (d) => `l2Book:${d.coin}`); if (p) emit(p.key, { type: 'book', book: hlBook(p.data) }); return; }
        case 'trades': {
          const p = parse(hlTrades, data, channel, (d) => (d[0] ? `trades:${d[0].coin}` : null));
          if (!p) return;
          if (p.data.some((t) => t.coin !== p.data[0]!.coin)) { invalid(channel, p.key, 'trades of several coins in one message'); return; }
          const out = fresh(p.key, p.data, hlTradeId);
          if (out.length) emit(p.key, { type: 'trades', trades: out.map(hlPublicTrade).sort((a, b) => a.ts - b.ts) });
          return;
        }
        case 'activeAssetCtx': { const p = parse(hlWsActiveAssetCtx, data, channel, (d) => `activeAssetCtx:${d.coin}`); if (p) emit(p.key, { type: 'ticker', ticker: hlTicker(p.data.coin, p.data.ctx, now()) }); return; }
        case 'allMids': { const p = parse(hlWsAllMids, data, channel, () => 'allMids:'); if (p) emit(p.key, { type: 'mids', mids: p.data.mids, ts: now() }); return; }
        case 'userFills': { const p = parse(hlWsUserFills, data, channel, (d) => `userFills:${d.user}`); if (p && p.data.user === user) fillsOut(p.data.fills, p.data.isSnapshot === true); return; }
        case 'orderUpdates': {
          const p = parse(hlWsOrders, data, channel, () => (user ? `orderUpdates:${user}` : null));
          if (!p) return;
          emit(p.key, { type: 'orders', orders: p.data.map((u): HlOrderUpdate => {
            const s = hlOrderStatus(u.status).status, partly = s === 'open' && u.order.sz !== u.order.origSz;
            return { instrument: `hyperliquid:${u.order.coin}`, venueOrderId: String(u.order.oid), clientId: u.order.cloid ?? null, side: u.order.side === 'B' ? 'buy' : 'sell',
              price: u.order.limitPx, size: u.order.origSz, remaining: u.order.sz, status: partly ? 'partially_filled' : s, venueStatus: u.status, createdAt: u.order.timestamp, updatedAt: u.statusTimestamp };
          }) });
          return;
        }
        case 'user': { // userEvents: fills (also delivered by userFills — de-duplicated), funding, liquidation, nonUserCancel
          const p = parse(hlWsUserEvent, data, channel, () => (user ? `userEvents:${user}` : null));
          if (!p) return;
          const d = p.data;
          if (d.fills) fillsOut(d.fills, false);
          if (d.funding) emit(p.key, { type: 'funding', payment: { instrument: `hyperliquid:${d.funding.coin}`, amount: d.funding.usdc, rate: d.funding.fundingRate, size: d.funding.szi, ts: d.funding.time } });
          if (d.liquidation) emit(p.key, { type: 'liquidation', raw: d.liquidation });
          if (d.nonUserCancel) emit(p.key, { type: 'cancelled_by_venue', orders: d.nonUserCancel.map((c) => ({ instrument: `hyperliquid:${c.coin}`, venueOrderId: String(c.oid) })) });
          return;
        }
        default: return; // a channel we did not ask for
      }
    } catch (e) {
      invalid(channel, null, e instanceof Error ? e.message : 'handler error'); // e.g. a crossed book or an unknown order status
    }
  };

  function connect(): void {
    if (ws || consumers.size === 0) return;
    const Ctor = o.WebSocket ?? (globalThis as { WebSocket?: HlWebSocketCtor }).WebSocket;
    if (!Ctor) throw new VenueError('hyperliquid', 'unsupported', 'no WebSocket implementation available');
    let sock: HlWebSocketLike;
    try { sock = new Ctor(url); } catch { scheduleReconnect(); return; }
    ws = sock; st.connects += 1;
    sock.onopen = () => {
      if (ws !== sock) return;
      open = true; lastMessageAt = openedAt = now();
      for (const w of wire.values()) send({ method: 'subscribe', subscription: w.sub });
      pingTimer = setInterval(() => send({ method: 'ping' }), pingIntervalMs);
      watchTimer = setInterval(() => {
        const quiet = now() - lastMessageAt;
        if (quiet > staleAfterMs + staleGraceMs) scheduleReconnect();
        else if (quiet > staleAfterMs && status === 'connected') setStatus('stale');
      }, Math.max(250, Math.min(1000, Math.floor(staleGraceMs / 4))));
      const again = everConnected;
      everConnected = true;
      setStatus('connected');
      if (again) emit(null, { type: 'gap', reason: 'reconnected' });
    };
    sock.onmessage = (ev) => { if (ws === sock) onMessage(ev.data); };
    sock.onclose = () => { if (ws === sock) scheduleReconnect(); };
    sock.onerror = () => { if (ws === sock) scheduleReconnect(); };
  }

  const wireSubs = (sub: HlStreamSub): WireSub[] => {
    if (sub.type === 'mids') return [{ type: 'allMids' }];
    if (sub.type === 'account') {
      const u = hlAccount(sub.account);
      // orderUpdates and userEvents messages do not name their user: one account per connection keeps them unambiguous
      if (user !== null && user !== u) throw new VenueError('hyperliquid', 'unsupported', 'one account per stream connection; create another adapter for a second account');
      return [{ type: 'userFills', user: u }, { type: 'orderUpdates', user: u }, { type: 'userEvents', user: u }];
    }
    if (typeof sub.symbol !== 'string' || !/^[A-Za-z0-9:_./@-]{1,40}$/.test(sub.symbol)) throw new VenueError('hyperliquid', 'unsupported', 'bad symbol');
    if (sub.type === 'book') return [{ type: 'l2Book', coin: sub.symbol }];
    if (sub.type === 'trades') return [{ type: 'trades', coin: sub.symbol }];
    if (sub.type === 'ticker') return [{ type: 'activeAssetCtx', coin: sub.symbol }];
    throw new VenueError('hyperliquid', 'unsupported', `unknown subscription type '${String((sub as { type: unknown }).type)}'`);
  };

  return {
    subscribe(sub, on, onStatus) {
      const subs = wireSubs(sub);
      if (sub.type === 'account') user = hlAccount(sub.account);
      const c: Consumer = { keys: subs.map(keyOf), on: on as (ev: HlStreamEvent) => void, onStatus, status: null };
      consumers.add(c);
      for (const s of subs) {
        const k = keyOf(s), w = wire.get(k);
        if (w) w.refs += 1; else { wire.set(k, { sub: s, refs: 1 }); send({ method: 'subscribe', subscription: s }); }
      }
      if (status !== 'idle') { c.status = status; onStatus(status); } // late joiner on a live connection
      if (!ws && !retryTimer) connect();
      let done = false;
      return () => {
        if (done) return;
        done = true; consumers.delete(c);
        for (const k of c.keys) {
          const w = wire.get(k);
          if (!w) continue;
          w.refs -= 1;
          if (w.refs <= 0) { wire.delete(k); send({ method: 'unsubscribe', subscription: w.sub }); }
        }
        if (![...wire.keys()].some((k) => k.startsWith('userFills:'))) user = null;
        if (consumers.size === 0) { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } drop(); status = 'idle'; everConnected = false; attempt = 0; }
      };
    },
    close() {
      consumers.clear(); wire.clear(); user = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      drop(); status = 'idle'; everConnected = false; attempt = 0;
    },
    stats: () => ({ ...st, subscriptions: wire.size, status }),
  };
}

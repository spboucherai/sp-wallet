/**
 * V11 live quotes — the browser side of the quote engine (docs/V11-QUOTE-ENGINE.md §7).
 *
 * ONE websocket per tab (`/api/v1/stream`, the owner's session cookie; the server checks the Origin), shared by every screen:
 * opened by the first subscriber, closed a moment after the last one leaves. It reconnects by itself (exponential backoff with
 * jitter), subscribes again, watches the server's heartbeat (no frame for 2.5 periods → reconnect), closes while the tab is
 * hidden for long and comes back with fresh snapshots. When it cannot connect at all (a proxy that refuses websockets) the
 * state is `fallback`: every screen keeps the REST polling it had before, and says so.
 *
 * Messages only fill a pending buffer; ONE requestAnimationFrame commits them and wakes the components subscribed to the keys
 * that changed (`useSyncExternalStore`): a hundred ticking rows cost a hundred small cell renders per frame at most, never a
 * render of the screen per message.
 *
 * Nothing here invents a figure: a field the server sends as null stays null, a book is only shown when every delta applied
 * and its checksum matched, and freshness is re-evaluated with THIS clock — a frozen connection turns stale on screen.
 * This module is not part of the first chunk: screens that are import it; Home and the asset page load it on demand (quotes-spot.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CandleMsg, Channel, QuoteMsg, ServerMessage, StatusMsg } from '../../../services/api/src/quotes/protocol';
import { applyLevels, backoffMs, bookChecksum, channelKey, HEARTBEAT_MS, QUOTE_PROTOCOL_VERSION as V, type Level } from '../../../services/api/src/quotes/shared';

export type Conn = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'fallback' | 'paused';
export type Fresh = 'live' | 'delayed' | 'stale' | 'reconnecting' | 'none';
/** a quote as received, plus: `at` = this clock when it arrived (a snapshot: minus its age), `staleAfterMs` = the cadence of its source */
export interface LiveQuote extends QuoteMsg { at: number; staleAfterMs: number | null }
export interface LiveBook { id: string; depth: number; bids: Level[]; asks: Level[]; seq: number; at: number; venueTs: number | null; source: string; stale: boolean }
export interface LiveTrade { id: string; price: string; size: string; side: 'buy' | 'sell'; ts: number }
export type LiveCandle = CandleMsg & { at: number };
export type { Channel, StatusMsg };

export interface SocketLike { send(data: string): void; close(code?: number, reason?: string): void; readyState: number;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: ((ev: { code?: number }) => void) | null; onerror: ((ev: unknown) => void) | null }
/** everything the client takes from the browser — tests give it a scripted socket and their own clock and frame */
export interface Env {
  WebSocket: new (url: string) => SocketLike; url: () => string; now: () => number; random: () => number;
  raf: (f: () => void) => void;
  /** `hidden()` and a subscription to its changes; absent outside a browser */
  visibility?: { hidden: () => boolean; on: (f: () => void) => () => void };
}
export const CLIENT = {
  /** consecutive failed connections before the state says `fallback` (the client keeps trying, slowly) */ fallbackAfter: 3,
  backoffMinMs: 1000, backoffMaxMs: 30_000,
  /** no frame at all for this long → the connection is considered frozen and re-opened */ watchdogMs: HEARTBEAT_MS * 2.5,
  /** the tab hidden this long → the socket is closed until it is visible again */ hiddenPauseMs: 30_000,
  /** a channel nobody reads any more is kept this long (a screen change must not cost a subscription) */ lingerMs: 2500,
  tradesKept: 60,
  /** shown as « delayed » past this age, before the source's own staleness bound */ delayedAfterMs: 5000,
} as const;
const CONN = '@conn', STATUS = '@status', CLOCK = '@clock';

/** live / delayed / stale / reconnecting for one value, with its age — the server's verdict AND this clock's */
export function freshnessOf(v: { at: number; stale: boolean; staleAfterMs?: number | null } | null | undefined, conn: Conn, now: number): { state: Fresh; ageMs: number | null } {
  if (!v) return { state: conn === 'reconnecting' || conn === 'connecting' ? 'reconnecting' : 'none', ageMs: null };
  const ageMs = Math.max(0, now - v.at), bound = v.staleAfterMs ?? 30_000;
  if (ageMs > bound || (v.stale && conn === 'live')) return { state: 'stale', ageMs };
  if (conn !== 'live') return { state: ageMs > bound ? 'stale' : 'reconnecting', ageMs };
  return { state: ageMs > Math.min(CLIENT.delayedAfterMs, bound / 2) ? 'delayed' : 'live', ageMs };
}

interface Ref { ch: Channel; n: number; linger: ReturnType<typeof setTimeout> | null; dead: string | null; staleAfterMs: number | null }
interface BookState { bids: Level[]; asks: Level[]; seq: number; awaiting: boolean }

export class QuoteClient {
  private ws: SocketLike | null = null;
  private conn: Conn = 'idle';
  private readonly refs = new Map<string, Ref>();
  private readonly values = new Map<string, unknown>();
  private readonly pending = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly books = new Map<string, BookState>();
  private statuses: Record<string, StatusMsg> = {};
  private toSubscribe: Channel[] = []; private toUnsubscribe: Channel[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null; private retry: ReturnType<typeof setTimeout> | null = null; private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null; private clock: ReturnType<typeof setInterval> | null = null;
  private frame = false; private tried = false; private attempt = 0; private failures = 0; private greeted = false; private lastFrameAt = 0; private offVisibility: (() => void) | null = null; private clockNow = 0;
  /** counters for tests and the diagnostics line of the status sheet */
  readonly stats = { connects: 0, frames: 0, commits: 0, notified: 0, resyncs: 0, checksumFailures: 0, tradesDropped: 0, watchdogReconnects: 0, errors: 0 };

  constructor(private readonly env: Env) { this.clockNow = env.now(); }

  // ------------------------------------------------------------------------------------------------ store
  listen(key: string, f: () => void): () => void {
    let s = this.listeners.get(key);
    if (!s) { s = new Set(); this.listeners.set(key, s); }
    s.add(f);
    if (key === CLOCK) this.startClock();
    return () => { s!.delete(f); if (key === CLOCK && s!.size === 0 && this.clock) { clearInterval(this.clock); this.clock = null; } };
  }
  get<T>(key: string): T | null { return (this.values.get(key) as T | undefined) ?? null; }
  state(): Conn { return this.conn; }
  venueStatuses(): Record<string, StatusMsg> { return this.statuses; }
  now(): number { return this.clockNow; }
  private startClock(): void { if (!this.clock) this.clock = setInterval(() => { this.clockNow = this.env.now(); this.mark(CLOCK); }, 1000); }
  private mark(key: string, value?: unknown): void {
    if (value !== undefined) this.pending.set(key, value); else if (!this.pending.has(key)) this.pending.set(key, this.values.get(key));
    if (this.frame) return;
    this.frame = true;
    this.env.raf(() => this.commit());
  }
  /** one commit per animation frame: the pending values become visible and each listener of a changed key is called once */
  private commit(): void {
    this.frame = false; this.stats.commits += 1; this.clockNow = this.env.now();
    const keys = [...this.pending.keys()];
    for (const k of keys) { const v = this.pending.get(k); if (v === undefined) this.values.delete(k); else this.values.set(k, v); }
    this.pending.clear();
    for (const k of keys) for (const f of [...(this.listeners.get(k) ?? [])]) { this.stats.notified += 1; f(); }
  }
  private setConn(c: Conn): void { if (this.conn !== c) { this.conn = c; this.mark(CONN, c); } }

  // ------------------------------------------------------------------------------------------------ subscriptions
  /** reference-counted; returns the function that releases it */
  subscribe(ch: Channel): () => void {
    const key = channelKey(ch);
    let r = this.refs.get(key);
    if (!r) { r = { ch, n: 0, linger: null, dead: null, staleAfterMs: null }; this.refs.set(key, r); this.toSubscribe.push(ch); this.scheduleSend(); }
    if (r.linger) { clearTimeout(r.linger); r.linger = null; }
    r.n += 1;
    this.ensure();
    let done = false;
    return () => {
      if (done) return;
      done = true; r!.n -= 1;
      if (r!.n > 0 || r!.linger) return;
      r!.linger = setTimeout(() => {
        r!.linger = null;
        if (r!.n > 0 || this.refs.get(key) !== r) return;
        this.refs.delete(key); this.books.delete(key); this.values.delete(key); this.pending.delete(key);
        this.toUnsubscribe.push(ch); this.scheduleSend();
        if (this.refs.size === 0) this.stop();
      }, CLIENT.lingerMs);
    };
  }
  /** why the server refused this channel (`unknown_instrument`, `unsupported_channel`, `restricted`…), or null */
  refusal(ch: Channel): string | null { return this.refs.get(channelKey(ch))?.dead ?? null; }
  private scheduleSend(): void { if (!this.sendTimer) this.sendTimer = setTimeout(() => { this.sendTimer = null; this.flushSends(); }, 0); }
  private flushSends(): void {
    const subs = this.toSubscribe, unsubs = this.toUnsubscribe;
    this.toSubscribe = []; this.toUnsubscribe = [];
    if (!this.ws || this.ws.readyState !== 1 || !this.greeted) return;   // on (re)connection everything still referenced is sent anyway
    const live = subs.filter((c) => this.refs.has(channelKey(c)));
    for (let i = 0; i < live.length; i += 100) this.send({ v: V, op: 'subscribe', channels: live.slice(i, i + 100) });
    const gone = unsubs.filter((c) => !this.refs.has(channelKey(c)));
    for (let i = 0; i < gone.length; i += 100) this.send({ v: V, op: 'unsubscribe', channels: gone.slice(i, i + 100) });
  }
  private send(m: unknown): void { try { this.ws?.send(JSON.stringify(m)); } catch { /* the close handler reconnects */ } }

  // ------------------------------------------------------------------------------------------------ connection
  private ensure(): void {
    if (this.ws || this.retry || this.conn === 'paused') return;
    if (this.env.visibility && !this.offVisibility) this.offVisibility = this.env.visibility.on(() => this.onVisibility());
    this.open();
  }
  private open(): void {
    if (this.ws || this.refs.size === 0) return;
    if (this.conn !== 'fallback') this.setConn(this.tried ? 'reconnecting' : 'connecting');
    this.tried = true;
    let ws: SocketLike;
    try { ws = new this.env.WebSocket(this.env.url()); } catch { this.failed(); return; }
    this.ws = ws; this.greeted = false; this.stats.connects += 1; this.lastFrameAt = this.env.now();
    ws.onmessage = (ev) => { if (this.ws === ws) this.onFrame(ev.data); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.failed(); } };
    ws.onerror = () => { /* a close always follows */ };
    if (!this.watchdog) this.watchdog = setInterval(() => {
      if (this.ws && this.env.now() - this.lastFrameAt > CLIENT.watchdogMs) { this.stats.watchdogReconnects += 1; this.drop(); this.failed(); }   // frozen: nothing for 2.5 heartbeats
    }, 5000);
  }
  private drop(): void { const ws = this.ws; this.ws = null; if (ws) { ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null; try { ws.close(); } catch { /* gone */ } } }
  private failed(): void {
    if (this.refs.size === 0) { this.stop(); return; }
    if (this.conn === 'paused') return;
    if (!this.greeted) this.failures += 1;
    this.greeted = false;
    // what is on screen is no longer maintained: books must restart from a snapshot, quotes keep their age
    for (const b of this.books.values()) b.awaiting = true;
    this.setConn(this.failures >= CLIENT.fallbackAfter ? 'fallback' : 'reconnecting');
    if (this.retry) return;
    const delay = backoffMs(this.attempt, CLIENT.backoffMinMs, CLIENT.backoffMaxMs, this.env.random);
    this.attempt += 1;
    this.retry = setTimeout(() => { this.retry = null; this.open(); }, delay);
  }
  /** nobody is subscribed any more: everything is released */
  private stop(): void {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.hiddenTimer) { clearTimeout(this.hiddenTimer); this.hiddenTimer = null; }
    this.offVisibility?.(); this.offVisibility = null;
    this.drop(); this.attempt = 0; this.failures = 0; this.greeted = false; this.tried = false;
    this.setConn('idle');
  }
  private onVisibility(): void {
    const hidden = this.env.visibility!.hidden();
    if (hidden) {
      if (!this.hiddenTimer) this.hiddenTimer = setTimeout(() => { this.hiddenTimer = null; if (this.retry) { clearTimeout(this.retry); this.retry = null; } this.drop(); for (const b of this.books.values()) b.awaiting = true; this.setConn('paused'); }, CLIENT.hiddenPauseMs);
      return;
    }
    if (this.hiddenTimer) { clearTimeout(this.hiddenTimer); this.hiddenTimer = null; }
    if (this.conn === 'paused') { this.attempt = 0; this.conn = 'reconnecting'; this.mark(CONN, 'reconnecting'); this.open(); }   // fresh snapshots come with the subscriptions
  }

  // ------------------------------------------------------------------------------------------------ frames
  private onFrame(data: unknown): void {
    let m: ServerMessage;
    try { m = JSON.parse(String(data)) as ServerMessage; } catch { return; }
    const now = this.env.now();
    this.lastFrameAt = now; this.stats.frames += 1;
    switch (m.type) {
      case 'hello': {
        this.greeted = true; this.attempt = 0; this.failures = 0; this.setConn('live');
        this.toSubscribe = []; this.toUnsubscribe = [];
        const all = [...this.refs.values()].filter((r) => r.dead === null).map((r) => r.ch);
        for (let i = 0; i < all.length; i += 100) this.send({ v: V, op: 'subscribe', channels: all.slice(i, i + 100) });
        return;
      }
      case 'subscribed': {
        const r = this.refs.get(m.key);
        if (!r) return;
        r.staleAfterMs = m.staleAfterMs;
        const at = now - (m.snapshotAgeMs ?? 0), snap = m.snapshot as ServerMessage | ServerMessage[] | null;
        if (r.ch.type === 'book') { const b = this.books.get(m.key); if (b) b.awaiting = snap === null; }
        if (snap) for (const s of Array.isArray(snap) ? snap : [snap]) this.onData(s, at);
        return;
      }
      case 'error': { this.stats.errors += 1; if (m.channel) { const r = this.refs.get(channelKey(m.channel as Channel)); if (r && ['unknown_instrument', 'unsupported_channel', 'restricted'].includes(m.code)) r.dead = m.code; } return; }
      case 'dropped': this.stats.tradesDropped += m.count; return;
      case 'heartbeat': case 'pong': case 'unsubscribed': return;
      default: this.onData(m, now);
    }
  }
  private onData(m: ServerMessage, at: number): void {
    if (m.type === 'quote') {
      // `at` is the age of the FIGURE on this clock: the time it arrived, minus what the server measured between the source's own date and its receipt
      const key = `quote|${m.id}|`, r = this.refs.get(key), lag = m.venueTs !== null ? Math.max(0, m.recvTs - m.venueTs) : 0;
      if (r) this.mark(key, { ...m, at: at - lag, staleAfterMs: r.staleAfterMs } satisfies LiveQuote);
    }
    else if (m.type === 'book') {
      const key = `book|${m.id}|${m.depth}`;
      if (!this.refs.has(key)) return;
      let b = this.books.get(key);
      if (m.kind === 'snapshot') { b = { bids: m.bids, asks: m.asks, seq: m.seq, awaiting: false }; this.books.set(key, b); }
      else {
        if (!b || b.awaiting) return;                              // waiting for the snapshot it asked for
        if (m.prevSeq !== b.seq) { this.resync(key, b); return; }   // a hole: never patch across it
        b.bids = applyLevels(b.bids, m.bids, 'bids', m.depth); b.asks = applyLevels(b.asks, m.asks, 'asks', m.depth); b.seq = m.seq;
      }
      if (bookChecksum(b.bids, b.asks) !== m.checksum) { this.stats.checksumFailures += 1; this.resync(key, b); return; }
      this.mark(key, { id: m.id, depth: m.depth, bids: b.bids, asks: b.asks, seq: b.seq, at, venueTs: m.venueTs, source: m.source, stale: m.stale } satisfies LiveBook);
    } else if (m.type === 'trade') {
      const key = `trades|${m.id}|`;
      if (!this.refs.has(key)) return;
      const have = (this.pending.get(key) ?? this.values.get(key) ?? []) as LiveTrade[], seen = new Set(have.map((t) => t.id));
      const fresh = m.trades.filter((t) => !seen.has(t.id));
      if (fresh.length) this.mark(key, [...fresh.reverse(), ...have].slice(0, CLIENT.tradesKept));   // newest first
    } else if (m.type === 'candle') { const key = `candle|${m.id}|${m.interval}`; if (this.refs.has(key)) this.mark(key, { ...m, at } satisfies LiveCandle); }
    else if (m.type === 'status') { this.statuses = { ...this.statuses, [m.venue]: m }; this.mark(STATUS, this.statuses); }
  }
  /** the local book can no longer be trusted: it is hidden from nobody (its age shows) but not patched until a fresh snapshot arrives */
  private resync(key: string, b: BookState): void {
    b.awaiting = true; this.stats.resyncs += 1;
    const r = this.refs.get(key);
    if (r) this.send({ v: V, op: 'subscribe', channels: [r.ch] });
  }
}

// ---------------------------------------------------------------------------------------------------------------- the tab's client
let shared: QuoteClient | null = null;
export function quoteClient(): QuoteClient {
  return (shared ??= new QuoteClient({
    WebSocket: WebSocket as unknown as Env['WebSocket'], now: Date.now, random: Math.random, raf: (f) => { requestAnimationFrame(f); },
    url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/stream`,
    visibility: { hidden: () => document.visibilityState === 'hidden', on: (f) => { document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); } },
  }));
}
/** tests: replace the tab's client */
export const setQuoteClient = (c: QuoteClient | null): void => { shared = c; };

export interface LiveSpot { usd: number; at: number; source: string }
/**
 * Spot prices in USD for the screens of the first chunk (Home, the asset page — quotes-spot.ts loads this module on demand):
 * `on` is called at most once per `everyMs` with the symbols that have a STREAMED quote which is live or merely delayed.
 * A polled or stale quote is left out — those screens keep the polled price and its own date for it.
 */
export function watchSpot(symbols: string[], on: (v: Record<string, LiveSpot>) => void, everyMs = 1000): () => void {
  const c = quoteClient(), offs = symbols.map((s) => c.subscribe({ type: 'quote', id: `spot:${s}` }));
  let last = '';
  const tick = (): void => {
    const out: Record<string, LiveSpot> = {}, now = Date.now();
    for (const s of symbols) {
      const q = c.get<LiveQuote>(`quote|spot:${s}|`), p = q ? q.last ?? q.mid : null, f = freshnessOf(q, c.state(), now).state;
      if (q && p !== null && q.source.endsWith('-ws') && (f === 'live' || f === 'delayed') && Number.isFinite(Number(p))) out[s] = { usd: Number(p), at: q.at, source: q.source };
    }
    const sig = JSON.stringify(out);
    if (sig !== last) { last = sig; on(out); }
  };
  const h = setInterval(tick, everyMs);
  return () => { clearInterval(h); for (const off of offs) off(); };
}

// ---------------------------------------------------------------------------------------------------------------- hooks
function useKey<T>(key: string | null): T | null {
  const c = quoteClient();
  // the third argument is what a render outside a browser shows (the repository's component tests render to a string): no live value
  return useSyncExternalStore(useCallback((f: () => void) => (key ? c.listen(key, f) : () => {}), [c, key]), () => (key ? c.get<T>(key) : null), () => null);
}
/** subscribes to channels for as long as the component is mounted (one frame for all of them); the values are read with `useQuote` & co */
export function useSubscriptions(channels: Channel[]): void {
  const sig = channels.map(channelKey).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` is the identity of the list
  useEffect(() => { const c = quoteClient(), offs = channels.map((ch) => c.subscribe(ch)); return () => { for (const off of offs) off(); }; }, [sig]);
}
export const useQuoteSubscriptions = (ids: string[]): void => useSubscriptions(useMemo(() => ids.map((id) => ({ type: 'quote' as const, id })), [ids.join('\n')]));   // eslint-disable-line react-hooks/exhaustive-deps
/** the live quote of one market (`venue:symbol`, the ids of the markets hub), or null while there is none */
export function useQuote(id: string | null | undefined): LiveQuote | null {
  useSubscriptions(useMemo(() => (id ? [{ type: 'quote' as const, id }] : []), [id]));
  return useKey<LiveQuote>(id ? `quote|${id}|` : null);
}
/** the live quotes of several markets, by id. The component re-renders at most once per frame, whatever the number of ticks. */
export function useQuotes(ids: string[]): Record<string, LiveQuote> {
  const c = quoteClient(), sig = ids.join('\n');
  useQuoteSubscriptions(ids);
  const cache = useRef<{ sig: string; v: Record<string, LiveQuote>; parts: (LiveQuote | null)[] }>({ sig: '', v: {}, parts: [] });
  return useSyncExternalStore(
    useCallback((f: () => void) => { const offs = ids.map((id) => c.listen(`quote|${id}|`, f)); return () => { for (const off of offs) off(); }; }, [c, sig]),   // eslint-disable-line react-hooks/exhaustive-deps
    () => {
      const parts = ids.map((id) => c.get<LiveQuote>(`quote|${id}|`)), k = cache.current;
      if (k.sig === sig && parts.length === k.parts.length && parts.every((p, i) => p === k.parts[i])) return k.v;
      const v: Record<string, LiveQuote> = {};
      parts.forEach((p, i) => { if (p) v[ids[i]!] = p; });
      cache.current = { sig, v, parts };
      return v;
    }, () => NO_QUOTES);
}
export function useBook(id: string | null | undefined, depth: 5 | 10 | 20 = 20): LiveBook | null {
  useSubscriptions(useMemo(() => (id ? [{ type: 'book' as const, id, depth }] : []), [id, depth]));
  return useKey<LiveBook>(id ? `book|${id}|${depth}` : null);
}
const NO_TRADES: LiveTrade[] = [], NO_QUOTES: Record<string, LiveQuote> = {}, NO_STATUS: Record<string, StatusMsg> = {};
export function useTrades(id: string | null | undefined): LiveTrade[] {
  useSubscriptions(useMemo(() => (id ? [{ type: 'trades' as const, id }] : []), [id]));
  return useKey<LiveTrade[]>(id ? `trades|${id}|` : null) ?? NO_TRADES;
}
/** the state of each venue's upstream, by venue id (subscribes to the `status` channel while mounted) */
export function useVenueStatus(): Record<string, StatusMsg> {
  useSubscriptions(STATUS_CHANNEL);
  const c = quoteClient();
  return useSyncExternalStore(useCallback((f: () => void) => c.listen(STATUS, f), [c]), () => c.venueStatuses(), () => NO_STATUS);
}
const STATUS_CHANNEL: Channel[] = [{ type: 'status', id: '*' }];
/** the state of the tab's connection: live, reconnecting, `fallback` (REST polling stands in), paused (tab hidden), idle */
export function useConn(): Conn { const c = quoteClient(); return useSyncExternalStore(useCallback((f: () => void) => c.listen(CONN, f), [c]), () => c.state(), () => 'idle' as Conn); }
/** this clock, once a second — for ages on screen */
export function useClock(): number { const c = quoteClient(); return useSyncExternalStore(useCallback((f: () => void) => c.listen(CLOCK, f), [c]), () => c.now(), () => 0); }
/** freshness of one live value, re-evaluated every second with this clock and at every connection change */
export function useFresh(v: { at: number; stale: boolean; staleAfterMs?: number | null } | null | undefined): { state: Fresh; ageMs: number | null } {
  const conn = useConn(), now = useClock();
  return freshnessOf(v, conn, Math.max(now, v?.at ?? 0));
}

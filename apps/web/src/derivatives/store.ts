/**
 * Live market state of ONE instrument, outside React. Stream events only fill a pending buffer; a requestAnimationFrame loop
 * commits it at most every BOOK_MS (ticker, book and trades together; connection changes at once) and wakes only the
 * components subscribed to the slice that changed (`useSlice`). Twenty book updates a second therefore cost a handful of small
 * renders, never a render of the screen.
 *
 * Freshness is never taken on trust: `freshness()` is 'live' only while the stream says `connected` AND an event arrived less
 * than STALE_MS ago. Anything else is shown as reconnecting or stale, with the age of the last data.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { dapi } from './api';
import { mergeBook, mergeTrades } from './reducers';
import type { Book, Instrument, Liquidity, PublicTrade, StreamStatus, Ticker } from './types';

export const STALE_MS = 10_000;
export const BOOK_MS = 125;
export type Slice = 'ticker' | 'book' | 'trades' | 'meta';
export type Conn = 'connecting' | StreamStatus | 'error';
export type Fresh = 'connecting' | 'live' | 'reconnecting' | 'stale';
export interface Meta { instrument: Instrument | null; liquidity: Liquidity | null; conn: Conn; error: string | null }
export interface Perf { events: number; commits: number; bookCommits: number; since: number }

export class MarketStore {
  readonly id: string;
  ticker: Ticker | null = null;
  book: Book | null = null;
  trades: PublicTrade[] = [];
  meta: Meta = { instrument: null, liquidity: null, conn: 'connecting', error: null };
  /** wall-clock time of the last stream event (not a slice: read by `freshness()` once a second) */
  lastEventAt = 0;
  perf: Perf = { events: 0, commits: 0, bookCommits: 0, since: Date.now() };

  private listeners: Record<Slice, Set<() => void>> = { ticker: new Set(), book: new Set(), trades: new Set(), meta: new Set() };
  private pTicker: Ticker | null = null;
  private pBook: Book | null = null;
  private pTrades: PublicTrade[] = [];
  private pMeta: Partial<Meta> | null = null;
  private raf = 0;
  private lastBookCommit = 0;
  private es: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(id: string) { this.id = id; }

  subscribe = (slice: Slice, f: () => void): (() => void) => { this.listeners[slice].add(f); return () => { this.listeners[slice].delete(f); }; };
  private emit(slice: Slice) { for (const f of this.listeners[slice]) f(); }

  start(): void {
    this.closed = false;
    if (import.meta.env.DEV) (window as unknown as { __spwStore?: MarketStore }).__spwStore = this;   // development only: lets the e2e test read `perf`
    void this.load();
    this.open();
    // safety net when the stream is silent: one snapshot every 5 s keeps the age honest and recovers after an outage
    this.poll = setInterval(() => { if (Date.now() - this.lastEventAt > 5000 && document.visibilityState === 'visible') void this.load(); }, 5000);
  }
  stop(): void {
    this.closed = true;
    this.es?.close(); this.es = null;
    if (this.poll) clearInterval(this.poll);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0; this.poll = null;
  }

  private async load(): Promise<void> {
    try {
      const m = await dapi.market(this.id);
      if (this.closed) return;
      // a snapshot proves the data path works, not that the stream is live: it never moves `lastEventAt` forward on its own
      this.pMeta = { ...(this.pMeta ?? {}), instrument: m.instrument, liquidity: m.liquidity, error: null };
      if (m.ticker && (!this.ticker || m.ticker.ts >= this.ticker.ts)) this.pTicker = m.ticker;
      if (m.book) this.pBook = m.book;
      if (m.trades.length) this.pTrades.push(...m.trades);
      this.schedule();
    } catch (e) {
      if (this.closed) return;
      this.pMeta = { ...(this.pMeta ?? {}), error: (e as { code?: string })?.code ?? 'error' };
      this.schedule();
    }
  }

  private open(): void {
    let es: EventSource;
    try { es = new EventSource(dapi.streamUrl(this.id)); } catch { this.setConn('error'); return; }
    this.es = es;
    const parse = (e: Event): any => { try { return JSON.parse((e as MessageEvent).data); } catch { return null; } };
    const seen = () => { this.perf.events++; this.lastEventAt = Date.now(); };
    es.addEventListener('open', () => this.setConn('connected'));
    es.addEventListener('ticker', (e) => { const t = parse(e); if (t && t.instrument === this.id) { seen(); this.pTicker = t; this.schedule(); } });
    es.addEventListener('book', (e) => { const b = parse(e); if (b && b.instrument === this.id) { seen(); this.pBook = b; this.schedule(); } });
    es.addEventListener('trades', (e) => { const t = parse(e); if (t) { seen(); this.pTrades.push(...(Array.isArray(t) ? t : [t])); this.schedule(); } });
    es.addEventListener('status', (e) => { const s = parse(e); const v = typeof s === 'string' ? s : s?.status ?? s?.state; if (v === 'connected' || v === 'reconnecting' || v === 'stale') this.setConn(v); });
    // the browser reconnects by itself; until it does, nothing on screen may pass for current
    es.addEventListener('error', () => this.setConn(es.readyState === EventSource.CLOSED ? 'error' : 'reconnecting'));
  }
  private setConn(conn: Conn) { this.pMeta = { ...(this.pMeta ?? {}), conn }; this.schedule(); }

  private schedule(): void { if (!this.raf && !this.closed) this.raf = requestAnimationFrame(this.flush); }
  private flush = (): void => {
    this.raf = 0;
    const now = performance.now();
    this.perf.commits++;
    if (this.pMeta) { const m = this.pMeta; this.pMeta = null; this.meta = { ...this.meta, ...m }; this.emit('meta'); }
    if (this.pTicker || this.pBook || this.pTrades.length) {
      if (now - this.lastBookCommit >= BOOK_MS) {
        this.lastBookCommit = now;
        if (this.pTicker) { const t = this.pTicker; this.pTicker = null; if (!this.ticker || t.ts >= this.ticker.ts) { this.ticker = t; this.emit('ticker'); } }
        if (this.pBook) { const next = mergeBook(this.book, this.pBook, this.id); this.pBook = null; if (next !== this.book) { this.book = next; this.perf.bookCommits++; this.emit('book'); } }
        if (this.pTrades.length) { const next = mergeTrades(this.trades, this.pTrades); this.pTrades = []; if (next !== this.trades) { this.trades = next; this.emit('trades'); } }
      } else this.schedule();
    }
  };

  freshness(now = Date.now()): { state: Fresh; ageMs: number | null } {
    const { conn } = this.meta, lastEventAt = this.lastEventAt;
    const dataTs = Math.max(lastEventAt, 0);
    const ageMs = dataTs ? Math.max(0, now - dataTs) : this.ticker ? Math.max(0, now - this.ticker.ts) : null;
    if (conn === 'stale' || conn === 'error') return { state: 'stale', ageMs };
    if (conn === 'reconnecting') return { state: ageMs !== null && ageMs > STALE_MS ? 'stale' : 'reconnecting', ageMs };
    if (!lastEventAt) return { state: conn === 'connected' && this.ticker && now - this.perf.since > STALE_MS ? 'stale' : 'connecting', ageMs };
    return { state: ageMs !== null && ageMs > STALE_MS ? 'stale' : 'live', ageMs };
  }
}

const sliceOf = { ticker: (s: MarketStore) => s.ticker, book: (s: MarketStore) => s.book, trades: (s: MarketStore) => s.trades, meta: (s: MarketStore) => s.meta } as const;
type SliceValue = { ticker: Ticker | null; book: Book | null; trades: PublicTrade[]; meta: Meta };
/** re-renders the calling component only when this slice changes */
export function useSlice<K extends Slice>(store: MarketStore, slice: K): SliceValue[K] {
  return useSyncExternalStore((f) => store.subscribe(slice, f), () => sliceOf[slice](store) as SliceValue[K]);
}
/** freshness re-evaluated every second and on every connection change */
export function useFreshness(store: MarketStore): { state: Fresh; ageMs: number | null } {
  const [f, setF] = useState(() => store.freshness());
  useEffect(() => {
    const tick = () => setF((p) => { const n = store.freshness(); return n.state === p.state && (n.state === 'live' || Math.floor((n.ageMs ?? 0) / 1000) === Math.floor((p.ageMs ?? 0) / 1000)) ? p : n; });
    tick();
    const h = setInterval(tick, 1000), off = store.subscribe('meta', tick);
    return () => { clearInterval(h); off(); };
  }, [store]);
  return f;
}
/** one store per instrument, started on mount and closed on unmount */
export function useMarketStore(id: string): MarketStore {
  const store = useMemo(() => new MarketStore(id), [id]);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  return store;
}

// Perpetuals market data on top of the venue adapters (sp-market-data, perps): short caches, explicit ages, one shared
// upstream stream per instrument, and the venue comparison table.
//
// Freshness rule: every answer carries the time it was read (`ts`). A cached value is served while it is younger than its
// `ttlMs`; when the venue cannot be reached an older value is served only while it is younger than `maxAgeMs`, with its real
// `ts`; beyond that the request fails with 503 — old data is never presented as current.
import { D, VenueError, type Book, type Candle, type DecStr, type GmxLiquidity, type Instrument, type PublicTrade, type Ticker, type VenueId } from '@spw/derivatives';
import { UserError } from '../config.ts';
import type { ReadAdapter, VenueRegistry } from './venues.ts';

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

/** cache ages, in milliseconds: `ttl` = how long a value is reused, `maxAge` = oldest value that may still be served when the venue fails */
export const DATA_BOUNDS = {
  instruments: { ttl: 600_000, maxAge: 3_600_000 },
  tickers: { ttl: 3_000, maxAge: 15_000 },
  book: { ttl: 1_000, maxAge: 10_000 },
  trades: { ttl: 2_000, maxAge: 15_000 },
  liquidity: { ttl: 5_000, maxAge: 30_000 },
  candles: { ttl: 10_000, maxAge: 120_000 },
  funding: { ttl: 60_000, maxAge: 900_000 },
  watch: { ttl: 5_000, maxAge: 5_000 },
} as const;
/** a venue failure is remembered this long: a venue that is down is not hammered by every request */
export const FAILURE_BACKOFF_MS = 1_000;
/** a book whose own (venue) timestamp is older than this is refused, whatever the cache says */
export const BOOK_MAX_VENUE_AGE_MS = 15_000;
/** levels per side sent to stream listeners and returned by /market */
export const BOOK_DEPTH = 20;
/** Hyperliquid's fundingHistory answers at most 500 rows from the start time: more hours than that would lose the newest rows */
export const FUNDING_MAX_HOURS = 480;
const STREAM_POLL_MS = 3_000;
const BPS = D.from(10000n);

export interface Stamped<T> { value: T; ts: number; stale: boolean }
export type StreamEvent =
  | { event: 'status'; data: { status: 'connected' | 'reconnecting' | 'stale'; ts: number } }
  | { event: 'ticker'; data: Ticker & { source: 'venue' } }
  | { event: 'book'; data: Book & { source: 'venue' } }
  | { event: 'trades'; data: { instrument: string; trades: PublicTrade[]; source: 'venue' } }
  | { event: 'error'; data: { message: string; ts: number } };
export type StreamListener = (ev: StreamEvent) => void;

export interface CompareRow {
  venue: VenueId; instrument: string; mark: DecStr; index: DecStr | null;
  /** fraction of notional that longs pay per HOUR (negative: longs receive); null when the venue publishes none */
  funding: DecStr | null;
  /** the venue's own figure and interval, before normalisation */
  fundingVenue: { rate: DecStr | null; intervalSec: number };
  spreadBps: DecStr | null; depthUsd1pct: DecStr | null; depthBidUsd1pct: DecStr | null; depthAskUsd1pct: DecStr | null;
  takerFeeBps: DecStr | null; maxLeverage: DecStr; collateral: string; settlement: string;
  restriction: string | null; notes: string[]; ts: number; source: 'venue';
}

/** VenueError → what the API answers. A venue that cannot be read is a 503, a request the venue refuses is a 422. */
export function venueFailure(e: unknown): unknown {
  if (!(e instanceof VenueError)) return e;
  const msg = e.message.slice(0, 240);
  if (e.code === 'rate_limited') return new UserError('venue_rate_limited', msg, 503);
  if (e.code === 'rejected' || e.code === 'unsupported') return new UserError('venue_rejected', msg, 422);
  return new UserError('venue_unavailable', msg, 503);
}

export function splitInstrumentId(id: string): { venue: string; symbol: string } {
  const k = id.indexOf(':');
  if (k < 1 || k === id.length - 1) throw new UserError('bad_instrument', 'instrument must be "<venue>:<symbol>"', 400);
  return { venue: id.slice(0, k), symbol: id.slice(k + 1) };
}

interface Slot { value: unknown; at: number }
interface Hub {
  inst: Instrument; listeners: Set<StreamListener>; closers: (() => void)[]; status: 'connected' | 'reconnecting' | 'stale' | null;
  everConnected: boolean; ticker: Ticker | null; book: Book | null; trades: PublicTrade[]; closed: boolean; timer: ReturnType<typeof setInterval> | null;
}

export class DerivData {
  readonly registry: VenueRegistry;
  readonly now: () => number;
  private readonly slots = new Map<string, Slot>();
  private readonly inflight = new Map<string, Promise<Slot>>();
  private readonly failed = new Map<string, { until: number; error: unknown }>();
  private readonly hubs = new Map<string, Hub>();
  /** upstream stream subscriptions opened since start (tests and diagnostics) */
  readonly streamStats = { opened: 0, closed: 0 };

  constructor(registry: VenueRegistry, o: { now?: () => number } = {}) { this.registry = registry; this.now = o.now ?? Date.now; }

  // ------------------------------------------------------------------ cache

  /**
   * `within`: the caller needs a value read at most that many ms ago (order flow, snapshot after a gap). Such a caller is never
   * given an older value when the venue fails — it gets the failure.
   */
  private async cached<T>(key: string, venue: VenueId, bounds: { ttl: number; maxAge: number }, fn: (a: ReadAdapter) => Promise<T>, o: { within?: number } = {}): Promise<Stamped<T>> {
    const slot = this.slots.get(key), now = this.now(), strict = o.within !== undefined;
    if (slot && now - slot.at < (o.within ?? bounds.ttl)) return { value: slot.value as T, ts: slot.at, stale: false };
    const serveOld = (err: unknown): Stamped<T> => {
      // an older value may stand in for a venue that cannot be reached, with its real time — never beyond its bound
      const s = this.slots.get(key);
      if (s && !strict && this.now() - s.at <= bounds.maxAge) return { value: s.value as T, ts: s.at, stale: true };
      throw venueFailure(err);
    };
    const f = this.failed.get(key);
    if (f && now < f.until) return serveOld(f.error);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.registry.call(venue, fn).then((value) => {
        const s = { value, at: this.now() };
        this.slots.set(key, s); this.failed.delete(key);
        return s;
      }, (err) => {
        if (err instanceof VenueError && err.code !== 'rejected' && err.code !== 'unsupported') this.failed.set(key, { until: this.now() + FAILURE_BACKOFF_MS, error: err });
        throw err;
      }).finally(() => { this.inflight.delete(key); });
      this.inflight.set(key, p);
    }
    try { const s = await p; return { value: s.value as T, ts: s.at, stale: false }; } catch (err) { return serveOld(err); }
  }

  // ------------------------------------------------------------------ reads

  async instruments(venue: VenueId): Promise<Stamped<Instrument[]>> {
    this.registry.get(venue);
    return this.cached(`instruments:${venue}`, venue, DATA_BOUNDS.instruments, async (a) => {
      const rank = (i: Instrument): number => (i.status === 'active' ? 0 : i.status === 'reduce_only' ? 1 : 2);
      return (await a.instruments()).map((i, k) => ({ i, k })).sort((x, y) => rank(x.i) - rank(y.i) || x.k - y.k).map((x) => x.i);
    });
  }

  async instrument(id: string): Promise<Instrument> {
    const { venue } = splitInstrumentId(id);
    const list = await this.instruments(this.registry.get(venue).id);
    const inst = list.value.find((i) => i.id === id);
    if (!inst) throw new UserError('unknown_instrument', `unknown instrument '${id.slice(0, 80)}'`, 404);
    return inst;
  }

  async tickers(venue: VenueId, o: { within?: number } = {}): Promise<Stamped<Ticker[]>> {
    this.registry.get(venue);
    return this.cached(`tickers:${venue}`, venue, DATA_BOUNDS.tickers, (a) => a.tickers(), o);
  }

  async ticker(inst: Instrument, o: { within?: number } = {}): Promise<Ticker> {
    const all = await this.tickers(inst.venue, o);
    const t = all.value.find((x) => x.instrument === inst.id);
    if (!t) throw new UserError('venue_unavailable', `${inst.venue} publishes no ticker for ${inst.symbol}`, 503);
    return t;
  }

  hasBook(inst: Instrument): boolean { return this.registry.get(inst.venue).facts.hasOrderBook; }

  /** the order book, or null on a venue that has none (GMX). Refused when the venue's own timestamp is too old. */
  async book(inst: Instrument, o: { within?: number } = {}): Promise<Book | null> {
    if (!this.hasBook(inst)) return null;
    const b = await this.cached(`book:${inst.id}`, inst.venue, DATA_BOUNDS.book, (a) => a.book(inst.symbol), o);
    const age = this.now() - b.value.ts;
    if (age > BOOK_MAX_VENUE_AGE_MS) throw new UserError('stale_data', `the ${inst.venue} order book of ${inst.symbol} is ${Math.round(age / 1000)} s old (limit ${BOOK_MAX_VENUE_AGE_MS / 1000} s)`, 503);
    return b.value;
  }

  async trades(inst: Instrument, limit = 50): Promise<PublicTrade[]> {
    const t = await this.cached(`trades:${inst.id}`, inst.venue, DATA_BOUNDS.trades, (a) => a.trades(inst.symbol, 100));
    return [...t.value].sort((x, y) => y.ts - x.ts).slice(0, limit);
  }

  /** what GMX has instead of a book; null on order-book venues */
  async liquidity(inst: Instrument): Promise<GmxLiquidity | null> {
    if (!this.registry.get(inst.venue).adapter.liquidity) return null;
    // one read for every market of the venue, shared by all its instruments
    const all = await this.cached(`liquidity:${inst.venue}`, inst.venue, DATA_BOUNDS.liquidity, (a) => a.liquidity!());
    return all.value.find((x) => x.instrument === inst.id) ?? null;
  }

  async candles(inst: Instrument, interval: CandleInterval, limit: number): Promise<Stamped<Candle[]>> {
    return this.cached(`candles:${inst.id}:${interval}:${limit}`, inst.venue, DATA_BOUNDS.candles, async (a) => (await a.candles(inst.symbol, interval, { limit })).slice(-limit));   // a venue may answer more bars than asked
  }

  async funding(inst: Instrument, hours: number): Promise<Stamped<{ ts: number; rate: DecStr }[]>> {
    return this.cached(`funding:${inst.id}:${hours}`, inst.venue, DATA_BOUNDS.funding, async (a) =>
      (await a.fundingHistory(inst.symbol, { start: this.now() - hours * 3_600_000 })).map((x) => ({ ts: x.ts, rate: x.rate })));
  }

  /** uncached funding rates applied by the venue since `start` (paper worker: the rate of each funding time) */
  async fundingSince(inst: Instrument, start: number): Promise<{ ts: number; rate: DecStr }[]> {
    try { return (await this.registry.call(inst.venue, (a) => a.fundingHistory(inst.symbol, { start }))).map((x) => ({ ts: x.ts, rate: x.rate })); }
    catch (e) { throw venueFailure(e); }
  }

  async market(id: string): Promise<{ instrument: Instrument; ticker: Ticker & { source: 'venue' }; book: (Book & { source: 'venue' }) | null; liquidity: (GmxLiquidity & { source: 'venue' }) | null;
    trades: PublicTrade[]; errors: Record<string, string>; ts: number; source: 'venue' }> {
    const inst = await this.instrument(id);
    const errors: Record<string, string> = {};
    const soft = async <T>(what: string, p: Promise<T>, dflt: T): Promise<T> => p.catch((e: unknown) => { errors[what] = e instanceof Error ? e.message.slice(0, 200) : 'error'; return dflt; });
    // the ticker is the minimum: without it there is nothing honest to show. Book, liquidity and trades fail separately.
    const [ticker, book, liquidity, trades] = await Promise.all([
      this.ticker(inst), soft('book', this.book(inst), null), soft('liquidity', this.liquidity(inst), null), soft('trades', this.trades(inst), [] as PublicTrade[]),
    ]);
    return { instrument: inst, ticker: { ...ticker, source: 'venue' }, book: book ? { ...capBook(book), source: 'venue' } : null,
      liquidity: liquidity ? { ...liquidity, source: 'venue' } : null, trades, errors, ts: this.now(), source: 'venue' };
  }

  /** read-only view of a public address on a venue that allows account reads */
  async watch(venue: VenueId, account: string) {
    this.registry.assertAccountAllowed(venue);
    const r = await this.cached(`watch:${venue}:${account.toLowerCase()}`, venue, DATA_BOUNDS.watch, async (a) => {
      const [state, positions, openOrders] = await Promise.all([a.account(account), a.positions(account), a.openOrders(account)]);
      return { state, positions, openOrders };
    });
    return { venue, account, ...r.value, ts: r.ts, source: 'venue' as const };
  }

  // ------------------------------------------------------------------ comparison

  /** One row per instrument on `base` across the venues. A table of facts and live figures — never a recommendation. */
  async compare(base: string): Promise<{ base: string; rows: CompareRow[]; errors: { venue: VenueId; message: string }[]; ts: number }> {
    const want = base.toUpperCase(), rows: CompareRow[] = [], errors: { venue: VenueId; message: string }[] = [];
    await Promise.all(this.registry.list().map(async (v) => {
      try {
        const insts = (await this.instruments(v.id)).value.filter((i) => i.base.toUpperCase() === want && i.status !== 'halted');
        if (insts.length === 0) return;
        const tickers = await this.tickers(v.id);
        for (const inst of insts) {
          const t = tickers.value.find((x) => x.instrument === inst.id);
          if (!t) continue;
          const notes = [...v.facts.notes];
          let spreadBps: DecStr | null = null, bid: DecStr | null = null, ask: DecStr | null = null, takerFeeBps = v.facts.takerFeeBps;
          if (v.facts.hasOrderBook) {
            const book = await this.book(inst).catch((e: unknown) => { notes.push(`order book unavailable: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`); return null; });
            if (book) {
              const m = bookMetrics(book);
              spreadBps = m.spreadBps; bid = m.depthBidUsd1pct; ask = m.depthAskUsd1pct;
              if (m.partial) notes.push(`The book snapshot (${book.bids.length} bids, ${book.asks.length} asks) does not reach 1 % from the mid on at least one side: the depth within 1 % is a lower bound.`);
            }
          } else {
            const l = await this.liquidity(inst).catch((e: unknown) => { notes.push(`liquidity figures unavailable: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`); return null; });
            if (l) {
              takerFeeBps = D.str(D.mul(D.from(l.positionFeeFactor.balanceNotImproved), BPS));
              notes.push(`No spread and no book depth on this venue. Capacity still open: long ${usd0(l.capacityLongUsd)} USD (limited by ${l.capacityLimitedBy.long}), short ${usd0(l.capacityShortUsd)} USD (limited by ${l.capacityLimitedBy.short}).`);
              notes.push(`Open interest: long ${usd0(l.openInterestLongUsd)} USD, short ${usd0(l.openInterestShortUsd)} USD. Oracle range ${l.oracleMin} – ${l.oracleMax}.`);
              notes.push(`Price impact: factor ${l.priceImpact.factorNegative} (negative) / ${l.priceImpact.factorPositive} (positive) × imbalance^${l.priceImpact.exponentNegative}, capped at ${pct(l.priceImpact.maxFactorNegative)} % against and ${pct(l.priceImpact.maxFactorPositive)} % in favour of the trade.`);
              notes.push(`Position fee ${pct(l.positionFeeFactor.balanceImproved)} % when the trade improves the long/short balance, ${pct(l.positionFeeFactor.balanceNotImproved)} % otherwise. Borrowing rate per hour as the venue publishes it: long ${l.borrowingRateLongPerHour}, short ${l.borrowingRateShortPerHour} (a cost carried by the larger open-interest side, on top of funding).`);
            }
          }
          rows.push({
            venue: v.id, instrument: inst.id, mark: t.mark, index: t.index,
            funding: t.funding === null ? null : D.str(D.div(D.mul(D.from(t.funding), D.from(3600n)), D.from(BigInt(inst.fundingIntervalSec)), 12, 'half_even')),
            fundingVenue: { rate: t.funding, intervalSec: inst.fundingIntervalSec },
            spreadBps, depthUsd1pct: bid !== null && ask !== null ? D.str(D.add(D.from(bid), D.from(ask))) : null, depthBidUsd1pct: bid, depthAskUsd1pct: ask,
            takerFeeBps, maxLeverage: inst.maxLeverage, collateral: inst.collateral, settlement: inst.settlement,
            restriction: v.restriction, notes, ts: t.ts, source: 'venue',
          });
        }
      } catch (e) { errors.push({ venue: v.id, message: e instanceof Error ? e.message.slice(0, 200) : 'error' }); }
    }));
    const order = this.registry.list().map((v) => v.id);
    rows.sort((a, b) => order.indexOf(a.venue) - order.indexOf(b.venue) || a.instrument.localeCompare(b.instrument));
    return { base: want, rows, errors, ts: this.now() };
  }

  // ------------------------------------------------------------------ shared stream

  /**
   * Live data of one instrument for a listener. The first listener opens the upstream (the adapter's stream when it has one,
   * a poll of the cached reads otherwise); the following ones share it; the upstream is closed when the last one leaves.
   * A newcomer is told the current status and, unless the upstream is in a gap, the last ticker, book and trades.
   */
  subscribe(inst: Instrument, listener: StreamListener): () => void {
    let hub = this.hubs.get(inst.id);
    if (!hub) { hub = this.openHub(inst); this.hubs.set(inst.id, hub); }
    const h = hub;
    h.listeners.add(listener);
    listener({ event: 'status', data: { status: h.status ?? 'reconnecting', ts: this.now() } });
    // not during a gap (the hub was connected and is not any more): what it holds then may be wrong, the snapshot after the gap follows
    if (h.status === 'connected' || !h.everConnected) {
      if (h.ticker) listener({ event: 'ticker', data: { ...h.ticker, source: 'venue' } });
      if (h.book) listener({ event: 'book', data: { ...h.book, source: 'venue' } });
      if (h.trades.length) listener({ event: 'trades', data: { instrument: inst.id, trades: h.trades, source: 'venue' } });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true; h.listeners.delete(listener);
      if (h.listeners.size === 0) this.closeHub(h);
    };
  }

  listeners(instrumentId: string): number { return this.hubs.get(instrumentId)?.listeners.size ?? 0; }
  /** closes every upstream (shutdown) */
  close(): void { for (const h of [...this.hubs.values()]) this.closeHub(h); }

  private emit(h: Hub, ev: StreamEvent): void { for (const l of [...h.listeners]) { try { l(ev); } catch { /* a listener must not break the others */ } } }

  private closeHub(h: Hub): void {
    if (h.closed) return;
    h.closed = true; this.hubs.delete(h.inst.id);
    if (h.timer) clearInterval(h.timer);
    for (const c of h.closers) { try { c(); } catch { /* already closed */ } this.streamStats.closed += 1; }
    h.closers = []; h.listeners.clear();
  }

  private setStatus(h: Hub, s: 'connected' | 'reconnecting' | 'stale'): void {
    if (h.closed || h.status === s) return;
    const again = s === 'connected' && h.everConnected;
    h.status = s;
    if (s === 'connected') h.everConnected = true;
    this.emit(h, { event: 'status', data: { status: s, ts: this.now() } });
    // back from a gap: what the listeners hold may be wrong — a fresh snapshot follows the status
    if (again) void this.snapshot(h);
  }

  private take(h: Hub, ev: { type?: unknown; ticker?: Ticker; book?: Book; trades?: PublicTrade[]; reason?: unknown; message?: unknown }): void {
    if (h.closed) return;
    if (ev.type === 'ticker' && ev.ticker) { h.ticker = ev.ticker; this.emit(h, { event: 'ticker', data: { ...ev.ticker, source: 'venue' } }); }
    else if (ev.type === 'book' && ev.book) { h.book = capBook(ev.book); this.emit(h, { event: 'book', data: { ...h.book, source: 'venue' } }); }
    else if (ev.type === 'trades' && ev.trades && ev.trades.length) {
      const trades = [...ev.trades].sort((a, b) => b.ts - a.ts);
      const seen = new Set(trades.map((t) => t.id));
      h.trades = [...trades, ...h.trades.filter((t) => !seen.has(t.id))].slice(0, 50);
      this.emit(h, { event: 'trades', data: { instrument: h.inst.id, trades, source: 'venue' } });
    } else if (ev.type === 'gap') void this.snapshot(h);
    else if (ev.type === 'invalid' || ev.type === 'error') this.emit(h, { event: 'error', data: { message: String(ev.reason ?? ev.message ?? 'stream error').slice(0, 200), ts: this.now() } });
  }

  /** fresh REST reads pushed to every listener (first data of a hub, and after any gap) */
  private async snapshot(h: Hub): Promise<void> {
    const part = async (fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (e) { if (!h.closed) this.emit(h, { event: 'error', data: { message: e instanceof Error ? e.message.slice(0, 200) : 'snapshot failed', ts: this.now() } }); }
    };
    await Promise.all([
      part(async () => { const t = await this.ticker(h.inst, { within: 0 }); this.take(h, { type: 'ticker', ticker: t }); }),
      part(async () => { const b = await this.book(h.inst, { within: 0 }); if (b) this.take(h, { type: 'book', book: b }); }),
      part(async () => { const t = await this.trades(h.inst, 50); if (t.length) { h.trades = []; this.take(h, { type: 'trades', trades: t }); } }),
    ]);
  }

  private openHub(inst: Instrument): Hub {
    const h: Hub = { inst, listeners: new Set(), closers: [], status: null, everConnected: false, ticker: null, book: null, trades: [], closed: false, timer: null };
    const a = this.registry.get(inst.venue).adapter;
    if (a.stream && a.capabilities.stream) {
      const types = this.hasBook(inst) ? ['ticker', 'book', 'trades'] as const : ['ticker', 'trades'] as const;
      for (const type of types) {
        try {
          h.closers.push(a.stream({ type, symbol: inst.symbol }, (ev) => this.take(h, ev as Parameters<DerivData['take']>[1]), (s) => this.setStatus(h, s)));
          this.streamStats.opened += 1;
        } catch (e) { queueMicrotask(() => this.emit(h, { event: 'error', data: { message: e instanceof Error ? e.message.slice(0, 200) : 'stream unavailable', ts: this.now() } })); }
      }
      void this.snapshot(h);
    } else {
      // no venue stream (GMX): the hub polls the cached reads and reports a failed poll as `stale`
      const poll = async (): Promise<void> => {
        try {
          const t = await this.ticker(inst);
          if (h.closed) return;
          this.setStatus(h, 'connected');
          if (!h.ticker || h.ticker.ts !== t.ts) this.take(h, { type: 'ticker', ticker: t });
        } catch { if (!h.closed) this.setStatus(h, 'stale'); }
      };
      h.timer = setInterval(() => { void poll(); }, STREAM_POLL_MS);
      h.timer.unref?.();
      this.streamStats.opened += 1;
      h.closers.push(() => {});
      void poll();
    }
    return h;
  }
}

const capBook = (b: Book): Book => ({ instrument: b.instrument, bids: b.bids.slice(0, BOOK_DEPTH), asks: b.asks.slice(0, BOOK_DEPTH), ts: b.ts });
const usd0 = (x: DecStr): string => D.str(D.quantize(D.from(x), D.one, 'down'));
const pct = (fraction: DecStr): string => D.str(D.mul(D.from(fraction), D.from(100n)));

/** spread and depth within 1 % of the mid, from the real book. `partial`: a side ends before 1 % (the depth is a lower bound). */
export function bookMetrics(book: Book): { mid: DecStr | null; spreadBps: DecStr | null; depthBidUsd1pct: DecStr | null; depthAskUsd1pct: DecStr | null; partial: boolean } {
  const bb = book.bids[0], ba = book.asks[0];
  if (!bb || !ba) return { mid: null, spreadBps: null, depthBidUsd1pct: null, depthAskUsd1pct: null, partial: true };
  const bid = D.from(bb[0]), ask = D.from(ba[0]), mid = D.div(D.add(bid, ask), D.from(2n), 18, 'half_even');
  const spreadBps = D.div(D.mul(D.sub(ask, bid), BPS), mid, 4, 'half_even');
  const lo = D.mul(mid, D.from('0.99')), hi = D.mul(mid, D.from('1.01'));
  let dBid = D.zero, dAsk = D.zero;
  for (const [p, s] of book.bids) { const px = D.from(p); if (D.lt(px, lo)) break; dBid = D.add(dBid, D.mul(px, D.from(s))); }
  for (const [p, s] of book.asks) { const px = D.from(p); if (D.gt(px, hi)) break; dAsk = D.add(dAsk, D.mul(px, D.from(s))); }
  const lastBid = D.from(book.bids[book.bids.length - 1]![0]), lastAsk = D.from(book.asks[book.asks.length - 1]![0]);
  return { mid: D.str(mid), spreadBps: D.str(spreadBps), depthBidUsd1pct: D.str(D.quantize(dBid, D.from('0.01'), 'down')), depthAskUsd1pct: D.str(D.quantize(dAsk, D.from('0.01'), 'down')),
    partial: D.gte(lastBid, lo) || D.lte(lastAsk, hi) };
}

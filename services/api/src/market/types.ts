// Market data engine (V3, docs/v3/ARCHITECTURE.md "Market data"): shared types, the time grid and the typed errors.
// Prices and volumes are floats: this is market data, never a custody amount. Nothing here may feed a transaction amount.

import { hasMarketData } from '@spw/core';

/** The base set (V3): always ingested, at every interval. The full set is derived from the token registry: see symbols.ts. */
export const SYMBOLS: readonly string[] = ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE', 'AVAX', 'BNB', 'DOGE', 'LTC', 'XRP'];
/** A ticker with a USD pair on at least two of the three exchanges (static table packages/core/src/market-listings.ts). */
export type MarketSymbol = string;
export const INTERVAL_MS = { '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000 } as const;
export type Interval = keyof typeof INTERVAL_MS;
export const INTERVALS = Object.keys(INTERVAL_MS) as Interval[];
/** the three exchanges read directly (public, keyless): the sources of every bar until V11 */
export const BASE_SOURCE_IDS = ['coinbase', 'bitstamp', 'kraken'] as const;
export type BaseSourceId = (typeof BASE_SOURCE_IDS)[number];
/** every source a stored bar may name. `apibricks` (V11, optional, keyed): bars of ONE exchange the wallet does not read itself,
 *  relayed by API Bricks — present only when APIBRICKS_API_KEY is set (apibricks/market-source.ts); always ranked last */
export const SOURCE_IDS = [...BASE_SOURCE_IDS, 'apibricks'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const isSymbol = (s: string): s is MarketSymbol => hasMarketData(s);
export const isInterval = (s: string): s is Interval => Object.hasOwn(INTERVAL_MS, s);

/** One bar. `ts` is the bar-OPEN time, UTC milliseconds, on the interval grid (1d bars open at 00:00 UTC on every source). */
export interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number }
/** A bar of the consolidated series: every field comes from the one source named here. */
export interface SeriesBar extends Candle { source: SourceId }
export type BySource = Partial<Record<SourceId, Candle[]>>;

/** A bar is only trusted as closed once the exchange has had this long to print its last trade. */
export const SETTLE_MS = 10_000;
export const isClosed = (ts: number, interval: Interval, now: number): boolean => ts + INTERVAL_MS[interval] + SETTLE_MS <= now;
/** Bar-open time of the most recent bar that must be closed at `now`. */
export function expectedLastTs(interval: Interval, now: number): number {
  const iv = INTERVAL_MS[interval];
  return Math.floor((now - SETTLE_MS) / iv) * iv - iv;
}

export type HttpJson = (url: string) => Promise<{ status: number; body: unknown }>;
export type SourceErrorKind = 'rate_limited' | 'http' | 'schema' | 'unsupported';
export class SourceError extends Error {
  constructor(public source: SourceId, public kind: SourceErrorKind, message: string) { super(`${source}: ${message}`); }
}

export interface MarketSource {
  id: SourceId;
  /** maximum bars per request */
  maxBars: number;
  /** only this many most recent bars can ever be fetched (Kraken: 720); null = full history is pageable */
  historyBars: number | null;
  /** exchange pair for each symbol the exchange really lists against USD */
  pairs: Record<MarketSymbol, string | undefined>;
  /** CLOSED bars whose bar-open time lies in [start, end] (inclusive, ms, at most maxBars slots), oldest first. Not yet validated. */
  candles(symbol: MarketSymbol, interval: Interval, range: { start: number; end: number }, now: number): Promise<Candle[]>;
  /** pause this source (after a rate-limit answer) */
  penalize(ms: number): void;
  /** intervals this source serves; absent = all (a metered source is kept to the intervals its budget allows) */
  intervals?: readonly Interval[];
  /** false = leave this source alone for now (its budget is spent): the pass skips it without an error */
  ready?(): boolean;
}

export type MarketErrorCode = 'unsupported' | 'no_data' | 'stale' | 'gap' | 'insufficient_history' | 'insufficient_sources' | 'disagreement';
/** Thrown by assertFresh: the series must not be used for a decision. */
export class MarketDataError extends Error {
  constructor(public code: MarketErrorCode, message: string, public report: unknown = null) { super(message); this.name = 'MarketDataError'; }
}

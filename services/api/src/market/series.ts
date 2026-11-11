// In-process consumer API of the market data engine. The trading engine calls assertFresh before every decision.
import { DEFAULT_PRIORITY, DEFAULT_QUALITY, consolidate, evaluate, type QualityOpts, type QualityReport } from './quality.ts';
import { loadBySource, loadLastBySource } from './store.ts';
import { findGaps } from './validate.ts';
import { INTERVAL_MS, MarketDataError, expectedLastTs, isInterval, isSymbol, type Interval, type MarketSymbol, type SeriesBar, type SourceId } from './types.ts';

export interface Series {
  symbol: MarketSymbol; interval: Interval; priority: readonly SourceId[];
  /** closed bars, oldest first; each one names the single source it comes from */
  bars: SeriesBar[];
  /** missing bar-open times between the first and the last bar returned */
  gaps: number;
  /** how many of the bars each source provided */
  provided: Partial<Record<SourceId, number>>;
}

function check(symbol: string, interval: string): asserts symbol is MarketSymbol {
  if (!isSymbol(symbol) || !isInterval(interval)) throw new MarketDataError('unsupported', `no market data for ${symbol} ${interval}`);
}

/** The consolidated series (rule in quality.ts: whole bar from the highest-ranked source that has it, never a blend):
 *  the `limit` most recent closed bars whose bar-open time is at or before `until` (default: no bound).
 *  This does NOT say the series is usable for a decision: call assertFresh for that. */
export async function getSeries(symbol: MarketSymbol, interval: Interval, o: { limit: number; until?: number; priority?: readonly SourceId[] }): Promise<Series> {
  check(symbol, interval);
  const limit = Math.max(1, Math.min(Math.floor(o.limit), 50_000)), priority = o.priority ?? DEFAULT_PRIORITY;
  const bars = consolidate(await loadLastBySource(symbol, interval, limit, o.until), priority).slice(-limit);
  const provided: Series['provided'] = {};
  for (const b of bars) provided[b.source] = (provided[b.source] ?? 0) + 1;
  return { symbol, interval, priority, bars, gaps: findGaps(bars.map((b) => b.ts), interval).gaps, provided };
}

/** The verdict at `now`, computed from the stored bars (never from the cached market_quality row). */
export async function checkQuality(symbol: MarketSymbol, interval: Interval, now: number = Date.now(), o: Partial<QualityOpts> = {}): Promise<QualityReport> {
  check(symbol, interval);
  const opts = { ...DEFAULT_QUALITY, ...o };
  const from = expectedLastTs(interval, now) - (opts.lookback + Math.max(opts.maxLagBars, 0) + 1) * INTERVAL_MS[interval];
  return evaluate(await loadBySource(symbol, interval, from), interval, now, opts);
}

/** Fails closed. Resolves (with the report) only if, at `now`:
 *  - the latest consolidated bar is the one that should be the latest closed bar, or the one before (`maxLagBars`, default 1);
 *  - the `lookback` bars (default 200) ending at that bar are all there: no hole, and the history is that long;
 *  - each of the last `agreeBars` bars (default 3) exists on at least `minSources` sources (default 2), and the bar the
 *    series uses is confirmed by `minSources - 1` other sources within `maxDeviationBps` (default 50); a further source
 *    that disagrees is recorded, not blocking.
 *  Otherwise throws MarketDataError (code stale | gap | insufficient_history | insufficient_sources | disagreement | no_data |
 *  unsupported) carrying the full report. A database failure also throws: no answer is never a yes. */
export async function assertFresh(symbol: MarketSymbol, interval: Interval, now: number = Date.now(), o: Partial<QualityOpts> = {}): Promise<QualityReport> {
  const report = await checkQuality(symbol, interval, now, o);
  const f = report.failures[0];
  if (f || report.status !== 'ok') throw new MarketDataError(f?.code ?? 'no_data', `${symbol} ${interval}: ${report.failures.map((x) => x.message).join('; ') || 'not usable'}`, report);
  return report;
}

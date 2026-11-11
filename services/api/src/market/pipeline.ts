// Pipeline ingest -> validate -> normalise -> store, as incremental updates (forward) and backfill (backward), plus the
// recomputation of the quality record. Requests to one exchange are sequential and paced by its adapter.
import { evaluate, type QualityReport } from './quality.ts';
import { earliestTs, latestTs, loadBySource, saveQuality, upsertCandles } from './store.ts';
import { normalise, validateBars, type RejectReason, type Rejected } from './validate.ts';
import { configuredSymbols } from './symbols.ts';
import { INTERVAL_MS, SourceError, expectedLastTs, type Interval, type MarketSource, type MarketSymbol, type SourceId } from './types.ts';

const DAY = 86_400_000;
export interface MarketConfig {
  symbols: readonly MarketSymbol[]; intervals: readonly Interval[];
  /** backfill depth per interval; null = everything the source has */
  depthMs: Record<Interval, number | null>;
  /** intervals ingested for a subset only (default: every symbol). 5m is kept to the base set: no agent decides on it. */
  only?: Partial<Record<Interval, readonly MarketSymbol[]>>;
  /** symbols served before the others in every pass (those an agent trades): their update and backfill never wait */
  first?: readonly MarketSymbol[];
  /** left out by the size limit (reported by the status route) */
  dropped?: readonly MarketSymbol[];
}
const days = (k: string, d: number | null): number | null => { const v = process.env[k]; return v === undefined || v === '' ? (d === null ? null : d * DAY) : v === 'all' ? null : Number(v) * DAY; };
/** Defaults: two years of 1h, all available 1d, 30 days of 5m. Override with SPW_MARKET_DEPTH_{1H,1D,5M}_DAYS (a number of days, or "all").
 *  The symbol set is the registry-derived one (symbols.ts); the worker uses activeMarketConfig(), which puts the agents' symbols first. */
export const marketConfig = (agentSymbols: readonly string[] = []): MarketConfig => {
  const set = configuredSymbols(agentSymbols);
  return { symbols: set.symbols, intervals: ['1h', '1d', '5m'], only: { '5m': set.fiveMinute }, first: set.first, dropped: set.dropped,
    depthMs: { '1h': days('SPW_MARKET_DEPTH_1H_DAYS', 730), '1d': days('SPW_MARKET_DEPTH_1D_DAYS', null), '5m': days('SPW_MARKET_DEPTH_5M_DAYS', 30) } };
};
/** Series of a configuration in service order: every interval of the `first` symbols, then the rest, interval by interval. */
export function seriesOrder(cfg: MarketConfig): [Interval, MarketSymbol][] {
  const first = new Set(cfg.first ?? []);
  const all = cfg.intervals.flatMap((i) => (cfg.only?.[i] ?? cfg.symbols).map((s): [Interval, MarketSymbol] => [i, s]));
  return [...all.filter(([, s]) => first.has(s)), ...all.filter(([, s]) => !first.has(s))];
}

/** bars refused by validation since the process started */
export const rejectedCount: Partial<Record<RejectReason, number>> = {};
/** 1h/1d/5m history starts no earlier than this (Bitstamp BTC/USD, the oldest pair, starts in August 2011) */
const EPOCH_FLOOR = Date.UTC(2010, 0, 1);
const key = (s: SourceId, symbol: string, interval: string) => `${s}:${symbol}:${interval}`;
const log = (m: string) => console.log(`[market] ${m}`);

export interface IngestResult { fetched: number; valid: number; written: number; rejected: Rejected[] }
/** One request to one source for [start, end], through the whole pipeline. */
export async function ingest(src: MarketSource, symbol: MarketSymbol, interval: Interval, range: { start: number; end: number }, now: number): Promise<IngestResult> {
  const raw = await src.candles(symbol, interval, range, now);
  const { bars, rejected } = validateBars(raw, interval, now);
  for (const r of rejected) rejectedCount[r.reason] = (rejectedCount[r.reason] ?? 0) + 1;
  if (rejected.length) log(`${key(src.id, symbol, interval)}: ${rejected.length} bars rejected (${[...new Set(rejected.map((r) => r.reason))].join(', ')})`);
  const written = await upsertCandles(src.id, symbol, interval, normalise(bars));
  return { fetched: raw.length, valid: bars.length, written, rejected };
}

export interface PassSummary { requests: number; written: number; rejected: number; errors: string[] }
const summary = (): PassSummary => ({ requests: 0, written: 0, rejected: 0, errors: [] });
const add = (s: PassSummary, r: IngestResult) => { s.requests++; s.written += r.written; s.rejected += r.rejected.length; };

/** Runs `each` for every series of every source, sources in parallel. A source that answers "rate limited", or fails three
 *  times in a row, is left alone for the rest of the pass so that it cannot hold the others back. */
async function forEachSeries(sources: MarketSource[], cfg: MarketConfig, s: PassSummary, each: (src: MarketSource, symbol: MarketSymbol, interval: Interval) => Promise<boolean | void>): Promise<void> {
  await Promise.all(sources.map(async (src) => {
    let failures = 0;
    for (const [interval, symbol] of seriesOrder(cfg)) {
      if (!src.pairs[symbol]) continue;
      try { if ((await each(src, symbol, interval)) === false) return; failures = 0; }
      catch (e) {
        s.errors.push(`${key(src.id, symbol, interval)}: ${(e as Error).message.slice(0, 160)}`);
        if (e instanceof SourceError && e.kind === 'rate_limited') { src.penalize(30_000); return; }
        if (++failures >= 3) return;
      }
    }
  }));
}

/** Incremental update: for each series that lacks the latest closed bar, fetch forward from the last stored bar
 *  (re-reading the two before it, so a late correction by the exchange is picked up). Nothing is requested when up to date. */
export async function updateAll(sources: MarketSource[], cfg: MarketConfig, clock: () => number = Date.now, maxPages = 4): Promise<PassSummary> {
  const s = summary();
  await forEachSeries(sources, cfg, s, async (src, symbol, interval) => {
    const iv = INTERVAL_MS[interval], expected = expectedLastTs(interval, clock());
    const latest = await latestTs(src.id, symbol, interval);
    if (latest !== null && latest >= expected) return undefined;
    const oldest = expected - (src.maxBars - 1) * iv;
    let start = latest === null ? oldest : latest - 2 * iv;
    if (src.historyBars !== null) start = Math.max(start, oldest);
    for (let page = 0; page < maxPages && start <= expected; page++) {
      const end = Math.min(start + (src.maxBars - 1) * iv, expected);
      add(s, await ingest(src, symbol, interval, { start, end }, clock()));
      start = end + iv;
    }
    return undefined;
  });
  return s;
}

export interface BackfillBudget { /** series already complete (kept by the caller between passes) */ done: Set<string>; /** per source and per pass */ maxRequests: number; deadline?: number }
/** Backfill: for each series, page backward from the oldest stored bar down to the configured depth, or until the source
 *  has nothing older (an empty page). Bounded by `maxRequests` per source and by `deadline`; call again to continue. */
export async function backfill(sources: MarketSource[], cfg: MarketConfig, budget: BackfillBudget, clock: () => number = Date.now): Promise<PassSummary & { complete: boolean }> {
  const s = summary();
  let pending = false;
  const left = new Map(sources.map((src) => [src.id, budget.maxRequests]));
  await forEachSeries(sources, cfg, s, async (src, symbol, interval) => {
    const k = key(src.id, symbol, interval);
    if (budget.done.has(k)) return undefined;
    const iv = INTERVAL_MS[interval], now = clock(), expected = expectedLastTs(interval, now), depth = cfg.depthMs[interval];
    let target = depth === null ? EPOCH_FLOOR : Math.max(EPOCH_FLOOR, Math.ceil((now - depth) / iv) * iv);
    if (src.historyBars !== null) target = Math.max(target, expected - (src.historyBars - 1) * iv);
    const earliest = await earliestTs(src.id, symbol, interval);
    let end = earliest === null ? expected : earliest - iv;
    while (end >= target) {
      if (left.get(src.id)! <= 0 || (budget.deadline !== undefined && clock() > budget.deadline)) { pending = true; return false; }
      const start = Math.max(target, end - (src.maxBars - 1) * iv);
      left.set(src.id, left.get(src.id)! - 1);
      const r = await ingest(src, symbol, interval, { start, end }, clock());
      add(s, r);
      if (r.valid === 0) break; // nothing older on this source
      end = start - iv;
    }
    budget.done.add(k);
    return undefined;
  });
  if (s.errors.length) pending = true;
  return { ...s, complete: !pending };
}

export const QUALITY_WINDOW = 720;
/** Recomputes and stores the quality record of every (symbol, interval): the last 720 bars, history shorter than that tolerated. */
export async function recomputeQuality(cfg: MarketConfig, priority: readonly SourceId[], now: number = Date.now()): Promise<Record<string, QualityReport>> {
  const out: Record<string, QualityReport> = {};
  for (const [interval, symbol] of seriesOrder(cfg)) {
    const from = expectedLastTs(interval, now) - (QUALITY_WINDOW + 2) * INTERVAL_MS[interval];
    const report = evaluate(await loadBySource(symbol, interval, from), interval, now, { lookback: QUALITY_WINDOW, requireHistory: false, priority });
    await saveQuality(symbol, report);
    out[`${symbol}:${interval}`] = report;
  }
  return out;
}

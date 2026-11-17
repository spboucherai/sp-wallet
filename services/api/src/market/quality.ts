// Consolidation rule, cross-source deviation and the quality verdict. Pure functions over bars already validated and stored.
//
// CONSOLIDATION RULE (the only one): sources are ranked (default coinbase > bitstamp > kraken). For each bar-open time,
// the consolidated bar is the WHOLE bar (open, high, low, close, volume) of the highest-ranked source that has one, and
// it carries that source's name. Fields of two sources are never combined inside one bar, and nothing is interpolated:
// a time no source has is a gap. Volume is therefore the volume of one venue, not a market total, and it changes scale
// where the series falls back to another source (Coinbase omits intervals without a trade; the others print them with volume 0).
import { findGaps, type GapRange } from './validate.ts';
import { BASE_SOURCE_IDS, INTERVAL_MS, SOURCE_IDS, expectedLastTs, type BySource, type Candle, type Interval, type MarketErrorCode, type SeriesBar, type SourceId } from './types.ts';

const priority: SourceId[] = [...BASE_SOURCE_IDS];
/** the sources in force, best first. The three exchanges; an optional source (V11: `apibricks`) is appended — always LAST — by
 *  `addConfirmingSource` when it is configured, so that without it every verdict is exactly what it was. */
export const DEFAULT_PRIORITY: readonly SourceId[] = priority;
/** An additional source may CONFIRM a bar (and fill a slot no exchange has); ranked last, it is never preferred to an exchange read directly. */
export function addConfirmingSource(id: SourceId): void { if (!priority.includes(id)) priority.push(id); }
/** tests: back to the three exchanges */
export function resetConfirmingSources(): void { priority.length = BASE_SOURCE_IDS.length; }

export function consolidate(bySource: BySource, priority: readonly SourceId[] = DEFAULT_PRIORITY): SeriesBar[] {
  const out = new Map<number, SeriesBar>();
  for (const source of priority) for (const c of bySource[source] ?? []) if (!out.has(c.ts)) out.set(c.ts, { ...c, source });
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

/** Spread of the closes of one bar across sources, in basis points of their midpoint: (max - min) / ((max + min) / 2) * 10^4. */
export function spreadBps(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const lo = Math.min(...closes), hi = Math.max(...closes);
  return ((hi - lo) / ((hi + lo) / 2)) * 1e4;
}

export interface Deviation { ts: number; bps: number; closes: Partial<Record<SourceId, number>> }
/** Close-price deviation for every bar that at least two sources have, oldest first. */
export function deviations(bySource: BySource, from = -Infinity): Deviation[] {
  const at = new Map<number, Partial<Record<SourceId, number>>>();
  for (const s of SOURCE_IDS) for (const c of bySource[s] ?? []) if (c.ts >= from) at.set(c.ts, { ...at.get(c.ts), [s]: c.close });
  const out: Deviation[] = [];
  for (const [ts, closes] of at) { const bps = spreadBps(Object.values(closes)); if (bps !== null) out.push({ ts, bps, closes }); }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface QualityOpts {
  /** bars, ending at the latest one, that must form an unbroken series */
  lookback: number;
  /** when false, a history shorter than `lookback` is not a failure (status display); assertFresh requires it */
  requireHistory: boolean;
  /** number of most recent bars on which the sources must agree */
  agreeBars: number;
  maxDeviationBps: number;
  /** sources that must have each of those bars */
  minSources: number;
  /** bars of ingestion delay tolerated behind the bar that should be the latest closed one */
  maxLagBars: number;
  priority: readonly SourceId[];
}
export const DEFAULT_QUALITY: QualityOpts = { lookback: 200, requireHistory: true, agreeBars: 3, maxDeviationBps: 50, minSources: 2, maxLagBars: 1, priority: DEFAULT_PRIORITY };

export interface QualityReport {
  interval: Interval; checkedAt: number;
  /** bar-open time of the bar that should be the latest closed one */
  expectedTs: number; lastTs: number | null; lagBars: number | null; fresh: boolean;
  /** consolidated bars inside the window, and missing slots between the first of them and the last */
  bars: number; gaps: number; gapRanges: GapRange[];
  /** slots missing before the first bar of the window (history shorter than the lookback) */
  missingHistory: number;
  /** largest close deviation over the last `agreeBars` bars; null when no bar had two sources */
  maxDeviationBps: number | null;
  agreement: { ts: number; closes: Partial<Record<SourceId, number>>; bps: number | null }[];
  /** deviation statistics over the whole window */
  window: { compared: number; p50: number | null; p99: number | null; max: number | null };
  /** consolidated bars of the window by providing source, and state of each source */
  provided: Partial<Record<SourceId, number>>;
  sources: Partial<Record<SourceId, { lastTs: number | null; bars: number; gaps: number }>>;
  status: 'ok' | MarketErrorCode; failures: { code: MarketErrorCode; message: string }[];
}

const iso = (ts: number) => new Date(ts).toISOString();
const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);

/** The verdict for one (symbol, interval) at `now`. `status` is 'ok' only when `failures` is empty. */
export function evaluate(bySource: BySource, interval: Interval, now: number, o: Partial<QualityOpts> = {}): QualityReport {
  const opts = { ...DEFAULT_QUALITY, ...o }, iv = INTERVAL_MS[interval], expectedTs = expectedLastTs(interval, now);
  const known: BySource = {};
  for (const s of opts.priority) known[s] = (bySource[s] ?? []).filter((c) => c.ts <= expectedTs);
  const cons = consolidate(known, opts.priority);
  const failures: QualityReport['failures'] = [];
  const fail = (code: MarketErrorCode, message: string) => failures.push({ code, message });
  const lastTs = cons.at(-1)?.ts ?? null;
  const report: QualityReport = { interval, checkedAt: now, expectedTs, lastTs, lagBars: null, fresh: false, bars: 0, gaps: 0, gapRanges: [], missingHistory: 0,
    maxDeviationBps: null, agreement: [], window: { compared: 0, p50: null, p99: null, max: null }, provided: {}, sources: {}, status: 'no_data', failures };
  if (lastTs === null) { fail('no_data', 'no closed bar is stored'); return report; }

  report.lagBars = Math.round((expectedTs - lastTs) / iv);
  report.fresh = report.lagBars <= opts.maxLagBars;
  if (!report.fresh) fail('stale', `latest bar ${iso(lastTs)} is ${report.lagBars} bars behind ${iso(expectedTs)} (allowed: ${opts.maxLagBars})`);

  const from = lastTs - (opts.lookback - 1) * iv;
  const win = cons.filter((c) => c.ts >= from);
  const g = findGaps(win.map((c) => c.ts), interval);
  // slots missing at the start of the window are a hole if an older bar is known, a short history otherwise
  const head = Math.round((win[0]!.ts - from) / iv);
  if (head > 0 && cons[0]!.ts < from) { g.gaps += head; g.ranges.unshift({ from, to: win[0]!.ts - iv, missing: head }); } else report.missingHistory = head;
  report.bars = win.length; report.gaps = g.gaps; report.gapRanges = g.ranges.slice(-20);
  if (g.gaps > 0) fail('gap', `${g.gaps} missing bars in the last ${opts.lookback} (latest hole ${iso(g.ranges.at(-1)!.from)})`);
  if (opts.requireHistory && report.missingHistory > 0) fail('insufficient_history', `only ${win.length} of ${opts.lookback} bars are available`);
  for (const c of win) report.provided[c.source] = (report.provided[c.source] ?? 0) + 1;
  for (const s of opts.priority) {
    const own = known[s]!.filter((c) => c.ts >= from);
    report.sources[s] = { lastTs: known[s]!.at(-1)?.ts ?? null, bars: own.length, gaps: findGaps(own.map((c) => c.ts), interval).gaps };
  }

  const devs = deviations(known, from), byTs = new Map(devs.map((d) => [d.ts, d]));
  const sorted = devs.map((d) => d.bps).sort((a, b) => a - b);
  report.window = { compared: devs.length, p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99), max: sorted.at(-1) ?? null };
  let alone = 0;
  for (let k = opts.agreeBars - 1; k >= 0; k--) {
    const ts = lastTs - k * iv, closes: Partial<Record<SourceId, number>> = {};
    for (const s of opts.priority) { const c = bar(known[s]!, ts); if (c) closes[s] = c.close; }
    // The bar the series actually uses is the one of the highest-ranked source that has it. It must be corroborated: at least
    // `minSources - 1` OTHER sources within the tolerance of it. A further source that disagrees (typically a thin venue whose
    // last trade is old) is recorded but does not block; the deviation that gates is the one to the nearest corroborators.
    const used = opts.priority.find((s) => closes[s] !== undefined);
    const others = used === undefined ? [] : opts.priority.filter((s) => s !== used && closes[s] !== undefined)
      .map((s) => (Math.abs(closes[s]! - closes[used]!) / ((closes[s]! + closes[used]!) / 2)) * 1e4).sort((x, y) => x - y);
    const need = opts.minSources - 1, bps = others.length >= need && need > 0 ? others[need - 1]! : byTs.get(ts)?.bps ?? null;
    report.agreement.push({ ts, closes, bps });
    if (Object.keys(closes).length < opts.minSources) alone++;
    if (bps !== null) report.maxDeviationBps = Math.max(report.maxDeviationBps ?? 0, bps);
  }
  if (alone > 0) fail('insufficient_sources', `${alone} of the last ${opts.agreeBars} bars are confirmed by fewer than ${opts.minSources} sources`);
  if (report.maxDeviationBps !== null && report.maxDeviationBps > opts.maxDeviationBps)
    fail('disagreement', `the bar used is not confirmed: the nearest confirming source differs by ${report.maxDeviationBps.toFixed(1)} bps on the last ${opts.agreeBars} bars (allowed: ${opts.maxDeviationBps})`);
  report.status = failures[0]?.code ?? 'ok';
  return report;
}

/** Bars are sorted: binary search by bar-open time. */
function bar(bars: Candle[], ts: number): Candle | undefined {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, t = bars[mid]!.ts; if (t === ts) return bars[mid]; if (t < ts) lo = mid + 1; else hi = mid - 1; }
  return undefined;
}

/**
 * Geometry of the multi-series comparison chart (`MultiSeriesChart` in chart.tsx) — pure, so that it is tested without a
 * browser. Display numbers only (floats): nothing here feeds an amount.
 */
export interface SeriesPoint { t: number; v: number }
export interface SeriesIn { id: string; label: string; points: SeriesPoint[] }
export interface Pad { t: number; r: number; b: number; l: number }
export interface SeriesPath { id: string; d: string; last: { x: number; y: number; v: number; t: number } | null }
export interface Geometry { t0: number; t1: number; min: number; max: number; x: (t: number) => number; y: (v: number) => number; paths: SeriesPath[]; /** every time of every series, ascending, without duplicates */ times: number[]; zeroY: number | null }

const clean = (p: readonly SeriesPoint[]): SeriesPoint[] => p.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);

/** null when no series has two points. `zero`: the value range always contains 0 (rates, differences). */
export function multiSeriesGeometry(series: readonly SeriesIn[], w: number, h: number, pad: Pad, o: { zero?: boolean } = {}): Geometry | null {
  const all = series.map((s) => ({ id: s.id, points: clean(s.points) })).filter((s) => s.points.length >= 2);
  if (all.length === 0 || !(w > pad.l + pad.r) || !(h > pad.t + pad.b)) return null;
  const flat = all.flatMap((s) => s.points);
  const t0 = Math.min(...flat.map((p) => p.t)), t1 = Math.max(...flat.map((p) => p.t));
  let min = Math.min(...flat.map((p) => p.v)), max = Math.max(...flat.map((p) => p.v));
  if (o.zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (max === min) { const d = Math.abs(max) > 0 ? Math.abs(max) * 0.01 : 1; min -= d; max += d; }
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b, span = t1 - t0 || 1;
  const x = (t: number): number => pad.l + ((t - t0) / span) * pw, y = (v: number): number => pad.t + (1 - (v - min) / (max - min)) * ph;
  const paths = series.map((s): SeriesPath => {
    const pts = all.find((a) => a.id === s.id)?.points;
    if (!pts) return { id: s.id, d: '', last: null };
    const lastP = pts[pts.length - 1]!;
    return { id: s.id, d: pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(''), last: { x: x(lastP.t), y: y(lastP.v), v: lastP.v, t: lastP.t } };
  });
  return { t0, t1, min, max, x, y, paths, times: [...new Set(flat.map((p) => p.t))].sort((a, b) => a - b), zeroY: min <= 0 && max >= 0 ? y(0) : null };
}

/** the time of `times` (ascending) closest to `t` */
export function nearestTime(times: readonly number[], t: number): number | null {
  if (times.length === 0) return null;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid]! <= t) lo = mid; else hi = mid; }
  return Math.abs(times[lo]! - t) <= Math.abs(times[hi]! - t) ? times[lo]! : times[hi]!;
}
/** the point of a series at `t`, or the latest one before it when the series has none at exactly that time and one within `tolerance`; null otherwise */
export function valueAt(points: readonly SeriesPoint[], t: number, tolerance: number): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  for (const p of points) if (p.t <= t && t - p.t <= tolerance && (best === null || p.t > best.t)) best = p;
  return best;
}

/**
 * Each series as its distance from the median of the series at the same time, in basis points — what « price across
 * venues » is about: the levels overlap, the differences are the information. A time held by fewer than two series is dropped.
 */
export function gapToMedianBps(series: readonly SeriesIn[]): SeriesIn[] {
  const by = new Map<number, { id: string; v: number }[]>();
  for (const s of series) for (const p of clean(s.points)) if (p.v > 0) by.set(p.t, [...(by.get(p.t) ?? []), { id: s.id, v: p.v }]);
  const out = new Map<string, SeriesPoint[]>(series.map((s) => [s.id, []]));
  for (const [t, xs] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
    if (xs.length < 2) continue;
    const sorted = xs.map((x) => x.v).sort((a, b) => a - b), h = sorted.length >> 1, median = sorted.length % 2 ? sorted[h]! : (sorted[h - 1]! + sorted[h]!) / 2;
    for (const x of xs) out.get(x.id)!.push({ t, v: (x.v / median - 1) * 10_000 });
  }
  return series.map((s) => ({ id: s.id, label: s.label, points: out.get(s.id)! }));
}
/** a funding history (rate per `intervalSec`) as an annualised percentage series — simple, not compounded */
export const fundingSeries = (history: readonly { ts: number; rate: string }[], intervalSec: number): SeriesPoint[] =>
  history.map((h) => ({ t: h.ts, v: Number(h.rate) * (3600 / intervalSec) * 8760 * 100 })).filter((p) => Number.isFinite(p.v));

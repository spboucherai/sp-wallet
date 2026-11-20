/**
 * NEXT — geometry of the value chart (pure: tested without a browser). The numbers here are for DRAWING only: every value
 * the owner reads is the server's own string (`label`), carried next to the float used to place the point.
 */
export interface VPoint { t: number; v: number; /** the server's exact figure for this point */ total: string }
export interface VPad { t: number; r: number; b: number; l: number }

export const toPoints = (rows: readonly { t: string; total: string }[]): VPoint[] =>
  rows.map((r) => ({ t: new Date(r.t).getTime(), v: Number(r.total), total: r.total })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);

/**
 * The longest distance between two points that is still « the same line ». The server only sends complete snapshots: a
 * missing stretch (a network was unreadable, the service was down) is a hole in time. A hole is anything clearly longer than
 * the usual spacing of THIS series (three times its median step — the history thins out with age, so a fixed duration would
 * be wrong), and never less than three snapshot intervals.
 */
export function gapThreshold(points: readonly VPoint[], snapshotEveryMs: number): number {
  if (points.length < 3) return Number.POSITIVE_INFINITY;
  const steps = points.slice(1).map((p, k) => p.t - points[k]!.t).sort((a, b) => a - b), median = steps[steps.length >> 1]!;
  return Math.max(3 * median, 3 * snapshotEveryMs);
}
/** the series cut at its holes: each part is drawn as its own line, and nothing is drawn across a hole */
export function segments(points: readonly VPoint[], maxGapMs: number): VPoint[][] {
  const out: VPoint[][] = [];
  for (const p of points) { const cur = out[out.length - 1]; if (cur && p.t - cur[cur.length - 1]!.t <= maxGapMs) cur.push(p); else out.push([p]); }
  return out;
}
export interface VGeometry { x: (t: number) => number; y: (v: number) => number; lines: string[]; areas: string[]; /** lone points (a part of one point has no line) */ dots: { x: number; y: number }[]; gaps: { x0: number; x1: number }[]; min: VPoint; max: VPoint; baseline: number }
/** null under two points (nothing to draw as a line) */
export function valueGeometry(points: readonly VPoint[], w: number, h: number, pad: VPad, maxGapMs: number): VGeometry | null {
  if (points.length < 2 || !(w > pad.l + pad.r) || !(h > pad.t + pad.b)) return null;
  const t0 = points[0]!.t, t1 = points[points.length - 1]!.t;
  let min = points[0]!, max = points[0]!; for (const p of points) { if (p.v < min.v) min = p; if (p.v > max.v) max = p; }
  // a flat series sits in the middle; a real one keeps a little air above and below
  const span = max.v - min.v, lo = span > 0 ? min.v - span * 0.08 : min.v - (Math.abs(min.v) * 0.01 || 1), hi = span > 0 ? max.v + span * 0.08 : max.v + (Math.abs(max.v) * 0.01 || 1);
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b, ts = t1 - t0 || 1;
  const x = (t: number): number => pad.l + ((t - t0) / ts) * pw, y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo)) * ph, baseline = h - pad.b;
  const parts = segments(points, maxGapMs), lines: string[] = [], areas: string[] = [], dots: { x: number; y: number }[] = [], gaps: { x0: number; x1: number }[] = [];
  parts.forEach((part, k) => {
    if (k > 0) gaps.push({ x0: x(parts[k - 1]![parts[k - 1]!.length - 1]!.t), x1: x(part[0]!.t) });
    if (part.length === 1) { dots.push({ x: x(part[0]!.t), y: y(part[0]!.v) }); return; }
    const d = part.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
    lines.push(d); areas.push(`${d}L${x(part[part.length - 1]!.t).toFixed(1)} ${baseline}L${x(part[0]!.t).toFixed(1)} ${baseline}Z`);
  });
  return { x, y, lines, areas, dots, gaps, min, max, baseline };
}
/** index of the point closest in TIME to an x position (the scrub snaps to real points; it never interpolates a value) */
export function nearestIndex(points: readonly VPoint[], g: Pick<VGeometry, 'x'>, px: number): number {
  let best = 0, d = Number.POSITIVE_INFINITY;
  for (let k = 0; k < points.length; k++) { const dx = Math.abs(g.x(points[k]!.t) - px); if (dx < d) { d = dx; best = k; } }
  return best;
}
/** the next index for a key of the scrub: arrows move by one (ten with Shift / Page keys), Home and End go to the ends; null for another key */
export function scrubKey(key: string, at: number | null, n: number, big = false): number | null {
  if (n === 0) return null;
  const cur = at ?? n - 1, step = big ? 10 : 1;
  switch (key) {
    case 'ArrowLeft': case 'ArrowDown': return Math.max(0, cur - step);
    case 'ArrowRight': case 'ArrowUp': return Math.min(n - 1, at === null ? n - 1 : cur + step);
    case 'PageDown': return Math.max(0, cur - 10);
    case 'PageUp': return Math.min(n - 1, cur + 10);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

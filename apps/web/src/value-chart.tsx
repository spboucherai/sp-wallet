/**
 * NEXT — the value chart of the dashboard (design system §4): one line in the accent colour over a soft area, no grid.
 *  - scrub by pointer (mouse hover, touch drag) AND by keyboard (the chart is one tab stop: ← → move point by point, Shift or
 *    Page keys by ten, Home / End to the ends, Escape leaves); the value and the date of the point are shown and announced;
 *  - a hole in the series (the server never sends an incomplete snapshot) is drawn as a hole — nothing joins its two sides;
 *  - what entered and left the wallet is marked on the time axis (▲ in, ▼ out), so that a deposit never reads as a gain;
 *  - a text summary (first, last, lowest, highest, change) is the chart's accessible description.
 * Hand-written SVG, like every chart of the app; the figures shown are the server's strings, floats only place the points.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { gapThreshold, nearestIndex, scrubKey, toPoints, valueGeometry, type VPoint } from './value-geom';

export interface FlowMark { t: number; direction: 'in' | 'out'; /** what the marker says (amount, asset, time) */ label: string }
export function ValueChart({ rows, snapshotEveryMs, format, formatTime, flows = [], summary, scrubHint, onScrub, height = 200, testid = 'value-chart' }: {
  rows: readonly { t: string; total: string }[]; snapshotEveryMs: number; format: (total: string) => string; formatTime: (t: number) => string; flows?: readonly FlowMark[];
  /** the accessible description: first, last, lowest, highest, change — written by the screen, in its language */ summary: string; /** how to use the keyboard, appended to the description */ scrubHint: string;
  onScrub?: (p: VPoint | null) => void; height?: number; testid?: string }): ReactNode {
  const box = useRef<HTMLDivElement>(null), id = useId();
  const [w, setW] = useState(340), [at, setAt] = useState<number | null>(null);
  const pad = { t: 26, r: 6, b: 22, l: 6 };
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); setW(el.clientWidth); return () => ro.disconnect(); }, []);
  const points = useMemo(() => toPoints(rows), [rows]);
  const g = useMemo(() => valueGeometry(points, w, height, pad, gapThreshold(points, snapshotEveryMs)), [points, w, height, snapshotEveryMs]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAt(null); }, [rows]);
  const pick = (k: number | null) => { setAt(k); onScrub?.(k === null ? null : points[k] ?? null); };
  const move = (clientX: number) => { const el = box.current; if (!el || !g) return; pick(nearestIndex(points, g, clientX - el.getBoundingClientRect().left)); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (at !== null) { e.preventDefault(); pick(null); } return; }
    const k = scrubKey(e.key, at, points.length, e.shiftKey); if (k === null) return;
    e.preventDefault(); pick(k);
  };
  if (!g) return <div ref={box} data-testid={testid} data-points={points.length} className="t-footnote grid place-items-center text-mute" style={{ height }} role="img" aria-label={summary}>{summary}</div>;
  const cur = at === null ? null : points[at]!, last = points[points.length - 1]!, t0 = points[0]!.t, t1 = last.t;
  const marks = flows.filter((f) => f.t >= t0 && f.t <= t1);
  return (
    <div ref={box} className="vchart" data-testid={testid} data-points={points.length} data-gaps={g.gaps.length} data-flows={marks.length} data-at={at ?? ''} style={{ height }}
      role="application" tabIndex={0} aria-roledescription="chart" aria-describedby={`${id}-sum`} aria-label={cur ? `${formatTime(cur.t)} : ${format(cur.total)}` : summary} onKeyDown={key} onBlur={() => pick(null)}
      onPointerDown={(e) => move(e.clientX)} onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) move(e.clientX); }}
      onPointerUp={(e) => { if (e.pointerType !== 'mouse') pick(null); }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') pick(null); }} onPointerCancel={() => pick(null)}>
      <p id={`${id}-sum`} className="sr-only">{summary} {scrubHint}{marks.length > 0 ? ` ${marks.map((m) => m.label).join(' ; ')}` : ''}</p>
      <span className="sr-only" aria-live="polite" data-testid={`${testid}-live`}>{cur ? `${formatTime(cur.t)} : ${format(cur.total)}` : ''}</span>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} className="block overflow-visible" aria-hidden="true">
        <defs><linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {g.areas.map((d, k) => <path key={`a${k}`} d={d} fill={`url(#${id}-a)`} />)}
        {g.lines.map((d, k) => <path key={`l${k}`} d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" data-testid={`${testid}-line`} />)}
        {g.dots.map((d, k) => <circle key={`d${k}`} cx={d.x} cy={d.y} r="2.5" fill="var(--accent)" />)}
        {/* the time axis: a hairline, broken where the series has a hole */}
        <line x1={pad.l} x2={w - pad.r} y1={g.baseline} y2={g.baseline} stroke="var(--line)" strokeWidth="1" />
        {g.gaps.map((gp, k) => <line key={`g${k}`} x1={gp.x0} x2={gp.x1} y1={g.baseline} y2={g.baseline} stroke="var(--surface)" strokeWidth="3" data-testid={`${testid}-gap`} />)}
        {marks.map((m, k) => { const x = g.x(m.t), y = g.baseline; return <path key={`f${k}`} data-testid={`${testid}-flow`} data-direction={m.direction}
          d={m.direction === 'in' ? `M${x - 4.5} ${y + 9}L${x} ${y + 2}L${x + 4.5} ${y + 9}Z` : `M${x - 4.5} ${y + 2}L${x} ${y + 9}L${x + 4.5} ${y + 2}Z`} fill={m.direction === 'in' ? 'var(--positive)' : 'var(--mute)'}><title>{m.label}</title></path>; })}
        {cur && at !== null ? <>
          <line x1={g.x(cur.t)} x2={g.x(cur.t)} y1={pad.t - 4} y2={g.baseline} stroke="var(--mute)" strokeWidth="1" />
          <circle cx={g.x(cur.t)} cy={g.y(cur.v)} r="5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" /></>
          : <circle cx={g.x(last.t)} cy={g.y(last.v)} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />}
      </svg>
      <div className="t-micro pointer-events-none absolute inset-x-0 bottom-0 flex justify-between pl-1 pr-1 text-mute" aria-hidden="true"><span>{formatTime(t0)}</span><span>{formatTime(t1)}</span></div>
      {cur && at !== null && <div className="vchart-tip" aria-hidden="true" data-testid={`${testid}-tip`} style={{ left: Math.max(70, Math.min(w - 70, g.x(cur.t))) }}>{formatTime(cur.t)} · {format(cur.total)}</div>}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';

// v11: the multi-series comparison chart (same approach: hand-written SVG, no library) is `MultiSeriesChart` in chart-multi.tsx — a
// module of its own so that it stays out of the first chunk (this file is loaded with Home and the asset page).
export interface Pt { t: number; p: number }
export { Spark } from './spark';

export interface Part { id: string; label: string; /** 0…1, the server's own figure */ share: number; /** the part's value, already written as money (optional) */ value?: string }
/**
 * Allocation (design system §4): ONE horizontal bar in the series colours and a legend LIST that carries each part's name, value
 * and share in text colour — the hue only keys the swatch, so nothing depends on telling two hues apart. Six parts at most,
 * then « other ». Not a donut. Hover or focus on a part emphasises it in the bar and in the list.
 */
export function Allocation({ parts, otherLabel, label, pct, hidden }: { parts: Part[]; otherLabel: string; label: string; pct: (share: number) => string; /** hide-balances mode: values are masked, shares stay */ hidden?: boolean }) {
  const [on, setOn] = useState<string | null>(null);
  const sorted = parts.filter((p) => p.share > 0).sort((a, b) => b.share - a.share);
  if (sorted.length === 0) return null;
  const head = sorted.slice(0, 6), rest = sorted.slice(6), restShare = rest.reduce((s, p) => s + p.share, 0);
  const segs = [...head.map((p, k) => ({ ...p, color: `var(--series-s${k + 1})` })), ...(rest.length > 0 ? [{ id: '__other', label: `${otherLabel} (${rest.length})`, share: restShare, value: undefined, color: 'var(--series-other)' }] : [])];
  return (
    <div data-testid="allocation">
      <div className="flex h-2.5 gap-[2px]" role="img" aria-label={`${label} : ${segs.map((s) => `${s.label} ${pct(s.share)}`).join(', ')}`}>
        {segs.map((s) => <span key={s.id} onPointerEnter={() => setOn(s.id)} onPointerLeave={() => setOn(null)} className="h-full min-w-[3px] rounded-full transition-opacity"
          style={{ flexGrow: s.share, flexBasis: 0, background: s.color, opacity: on && on !== s.id ? 0.35 : 1 }} />)}
      </div>
      <ul className="mt-3 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">{segs.map((s) =>
        <li key={s.id} tabIndex={0} data-part={s.id} onFocus={() => setOn(s.id)} onBlur={() => setOn(null)} onPointerEnter={() => setOn(s.id)} onPointerLeave={() => setOn(null)}
          className={`t-callout flex min-h-9 flex-wrap items-center gap-x-2.5 rounded-md transition-opacity ${on && on !== s.id ? 'opacity-55' : ''}`}>
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" /><span className="min-w-[3rem] flex-1 truncate">{s.label}</span>
          {s.value && <span className={`shrink-0 text-mute ${hidden ? 'mask' : ''}`} aria-hidden={hidden || undefined}>{s.value}</span>}<span className="min-w-[3.25rem] shrink-0 text-right font-semibold">{pct(s.share)}</span></li>)}</ul>
    </div>
  );
}

/**
 * Single-series price line: 2px line, ~10% area wash, hairline reference at the period's opening price,
 * crosshair that snaps to the nearest point (mouse or touch), value read-out in ink colour above the plot.
 */
export function PriceChart({ points, format, formatTime, onHover }: { points: Pt[]; format: (v: number) => string; formatTime: (t: number) => string; onHover?: (p: Pt | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340), [at, setAt] = useState<number | null>(null);
  const H = 210, padT = 14, padB = 22;
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const g = useMemo(() => {
    if (points.length < 2) return null;
    const ps = points.map((p) => p.p), min = Math.min(...ps), max = Math.max(...ps), span = max - min || max || 1;
    const x = (k: number) => (k / (points.length - 1)) * w, y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const line = points.map((p, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(p.p).toFixed(1)}`).join('');
    return { min, max, x, y, line, area: `${line}L${w} ${H - padB}L0 ${H - padB}Z`, open: y(points[0]!.p) };
  }, [points, w]);
  const move = (clientX: number) => {
    const el = box.current; if (!el || !g) return;
    const r = el.getBoundingClientRect();
    const k = Math.max(0, Math.min(points.length - 1, Math.round(((clientX - r.left) / r.width) * (points.length - 1))));
    setAt(k); onHover?.(points[k]!);
  };
  const leave = () => { setAt(null); onHover?.(null); };
  if (!g) return <div ref={box} className="grid h-[210px] place-items-center text-[0.8125rem] text-mute">—</div>;
  const first = points[0]!, last = points[points.length - 1]!;
  const cur = at === null ? null : points[at]!;
  return (
    <div ref={box} className="chart-box relative touch-pan-y select-none" role="img"
      aria-label={`${formatTime(first.t)} → ${formatTime(last.t)} : ${format(first.p)} → ${format(last.p)} (min ${format(g.min)}, max ${format(g.max)})`}
      onPointerDown={(e) => move(e.clientX)} onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) move(e.clientX); }}
      onPointerUp={(e) => { if (e.pointerType !== 'mouse') leave(); }} onPointerLeave={leave} onPointerCancel={leave}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="block overflow-visible">
        <defs><linearGradient id="spw-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        <line x1="0" x2={w} y1={g.open} y2={g.open} stroke="var(--line)" strokeWidth="1" />
        <path d={g.area} fill="url(#spw-area)" />
        <path d={g.line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {cur && at !== null && <>
          <line x1={g.x(at)} x2={g.x(at)} y1={padT - 6} y2={H - padB} stroke="var(--mute)" strokeWidth="1" />
          <circle cx={g.x(at)} cy={g.y(cur.p)} r="5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
        </>}
        {at === null && <circle cx={w - 1} cy={g.y(last.p)} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between text-[0.6875rem] text-mute"><span>{formatTime(first.t)}</span><span>{formatTime(last.t)}</span></div>
      <div className="pointer-events-none absolute right-0 top-0 text-right text-[0.6875rem] leading-tight text-mute"><div>max {format(g.max)}</div></div>
      <div className="pointer-events-none absolute bottom-6 right-0 text-right text-[0.6875rem] leading-tight text-mute"><div>min {format(g.min)}</div></div>
      {cur && at !== null && <div className="vchart-tip"
        style={{ left: Math.max(46, Math.min(w - 46, g.x(at))) }}>{formatTime(cur.t)}</div>}
    </div>
  );
}

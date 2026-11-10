import { useEffect, useMemo, useRef, useState } from 'react';

export interface Pt { t: number; p: number }
/** Tiny trend line for list rows. Decorative: the adjacent text carries the value. */
export function Spark({ data, w = 64, h = 26 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return <span style={{ width: w, height: h }} className="inline-block" />;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const d = data.map((v, k) => `${k ? 'L' : 'M'}${((k / (data.length - 1)) * (w - 2) + 1).toFixed(1)} ${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join('');
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0 text-mute"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
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
  if (!g) return <div ref={box} className="grid h-[210px] place-items-center text-[13px] text-mute">—</div>;
  const first = points[0]!, last = points[points.length - 1]!;
  const cur = at === null ? null : points[at]!;
  return (
    <div ref={box} className="relative touch-pan-y select-none" role="img"
      aria-label={`${formatTime(first.t)} → ${formatTime(last.t)} : ${format(first.p)} → ${format(last.p)} (min ${format(g.min)}, max ${format(g.max)})`}
      onPointerDown={(e) => move(e.clientX)} onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) move(e.clientX); }}
      onPointerUp={(e) => { if (e.pointerType !== 'mouse') leave(); }} onPointerLeave={leave} onPointerCancel={leave}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="block overflow-visible">
        <defs><linearGradient id="spw-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--blue)" stopOpacity="0.16" /><stop offset="1" stopColor="var(--blue)" stopOpacity="0" /></linearGradient></defs>
        <line x1="0" x2={w} y1={g.open} y2={g.open} stroke="var(--line)" strokeWidth="1" />
        <path d={g.area} fill="url(#spw-area)" />
        <path d={g.line} fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {cur && at !== null && <>
          <line x1={g.x(at)} x2={g.x(at)} y1={padT - 6} y2={H - padB} stroke="var(--mute)" strokeWidth="1" />
          <circle cx={g.x(at)} cy={g.y(cur.p)} r="5" fill="var(--blue)" stroke="var(--surface)" strokeWidth="2" />
        </>}
        {at === null && <circle cx={w - 1} cy={g.y(last.p)} r="4" fill="var(--blue)" stroke="var(--surface)" strokeWidth="2" />}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between text-[11px] text-mute"><span>{formatTime(first.t)}</span><span>{formatTime(last.t)}</span></div>
      <div className="pointer-events-none absolute right-0 top-0 text-right text-[11px] leading-tight text-mute"><div>max {format(g.max)}</div></div>
      <div className="pointer-events-none absolute bottom-6 right-0 text-right text-[11px] leading-tight text-mute"><div>min {format(g.min)}</div></div>
      {cur && at !== null && <div className="pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-lg bg-primary px-2 py-1 text-[11.5px] font-medium text-onprimary"
        style={{ left: Math.max(46, Math.min(w - 46, g.x(at))) }}>{formatTime(cur.t)}</div>}
    </div>
  );
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/chart-multi.tsx
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// v11 — the multi-series comparison chart. Same approach as chart.tsx (hand-written SVG, no chart library); kept in its own
// module so that the first chunk (Home, the asset page) does not carry it. Geometry: chart-geom.ts (pure, tested).
import { useEffect, useMemo, useRef, useState } from 'react';
import { multiSeriesGeometry, nearestTime, valueAt, type SeriesPoint } from './chart-geom';

export interface ChartSeries { id: string; label: string; /** a CSS colour; the series slots `var(--s1)` … `var(--s5)` of the design system */ color: string; points: SeriesPoint[] }
/**
 * Several series on one time axis and ONE value axis (v11: funding history and price across venues) — the same hand-written
 * SVG as `PriceChart`, no library. 2 px lines in the fixed series slots, no area wash (lines cross), a hairline at zero when
 * the range holds it, a crosshair that snaps to the nearest time of any series, and a legend that carries each series' name
 * and its value (at the crosshair, else its last one) in text colour — nothing depends on telling two hues apart.
 * A series without data stays in the legend with « — », so a venue that could not be read is visible, not silently missing.
 */
export function MultiSeriesChart({ series, format, formatTime, label, zero, tolerance = 2 * 3_600_000, height = 200, empty }: { series: ChartSeries[]; format: (v: number) => string; formatTime: (t: number) => string; label: string; zero?: boolean; tolerance?: number; height?: number; empty: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340), [at, setAt] = useState<number | null>(null);
  const pad = { t: 12, r: 6, b: 20, l: 6 };
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const g = useMemo(() => multiSeriesGeometry(series, w, height, pad, zero ? { zero: true } : {}), [series, w, height, zero]);   // eslint-disable-line react-hooks/exhaustive-deps -- `pad` is a constant
  const move = (clientX: number) => {
    const el = box.current; if (!el || !g) return;
    const r = el.getBoundingClientRect(), t = g.t0 + Math.max(0, Math.min(1, (clientX - r.left - pad.l) / Math.max(1, r.width - pad.l - pad.r))) * (g.t1 - g.t0);
    setAt(nearestTime(g.times, t));
  };
  const leave = () => setAt(null);
  const shown = series.map((s) => { const p = at === null ? s.points[s.points.length - 1] ?? null : valueAt(s.points, at, tolerance); return { ...s, p }; });
  const legend = <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[0.78125rem]" data-testid="msc-legend">{shown.map((s) =>
    <li key={s.id} className="inline-flex items-center gap-1.5"><span className="h-[3px] w-3.5 rounded-full" style={{ background: s.color }} aria-hidden="true" /><span className="text-mute">{s.label}</span><span className="font-semibold tabular-nums">{s.p ? format(s.p.v) : '—'}</span></li>)}</ul>;
  if (!g) return <div ref={box} data-testid="msc"><div className="grid place-items-center text-[0.8125rem] text-mute" style={{ height }}>{empty}</div>{legend}</div>;
  return (
    <div data-testid="msc">
      <div ref={box} className="relative touch-pan-y select-none" role="img"
        aria-label={`${label} — ${formatTime(g.t0)} → ${formatTime(g.t1)} : ${series.map((s) => { const l = s.points[s.points.length - 1]; return `${s.label} ${l ? format(l.v) : '—'}`; }).join(', ')}`}
        onPointerDown={(e) => move(e.clientX)} onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) move(e.clientX); }}
        onPointerUp={(e) => { if (e.pointerType !== 'mouse') leave(); }} onPointerLeave={leave} onPointerCancel={leave}>
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} className="block overflow-visible">
          {g.zeroY !== null && <line x1={pad.l} x2={w - pad.r} y1={g.zeroY} y2={g.zeroY} stroke="var(--line)" strokeWidth="1" />}
          {g.paths.map((p) => { const s = series.find((x) => x.id === p.id)!; return p.d ? <path key={p.id} d={p.d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null; })}
          {at !== null && <line x1={g.x(at)} x2={g.x(at)} y1={pad.t - 4} y2={height - pad.b} stroke="var(--mute)" strokeWidth="1" />}
          {at !== null && shown.map((s) => (s.p ? <circle key={s.id} cx={g.x(s.p.t)} cy={g.y(s.p.v)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" /> : null))}
          {at === null && g.paths.map((p) => (p.last ? <circle key={p.id} cx={p.last.x} cy={p.last.y} r="3" fill={series.find((x) => x.id === p.id)!.color} stroke="var(--surface)" strokeWidth="1.5" /> : null))}
        </svg>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between text-[0.6875rem] text-mute"><span>{formatTime(g.t0)}</span><span>{formatTime(g.t1)}</span></div>
        <div className="pointer-events-none absolute right-0 top-0 text-right text-[0.6875rem] leading-tight text-mute">max {format(g.max)}</div>
        <div className="pointer-events-none absolute bottom-5 right-0 text-right text-[0.6875rem] leading-tight text-mute">min {format(g.min)}</div>
        {at !== null && <div className="pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-lg bg-primary px-2 py-1 text-[0.71875rem] font-medium text-onprimary" style={{ left: Math.max(46, Math.min(w - 46, g.x(at))) }}>{formatTime(at)}</div>}
      </div>
      {legend}
    </div>
  );
}

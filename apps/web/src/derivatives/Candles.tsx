/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/Candles.tsx
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

/**
 * Candlestick chart on a canvas, in the house style (no charting dependency): candles + volume, moving averages, crosshair with
 * an OHLC read-out, and horizontal markers for the paper account (entry, liquidation ESTIMATE, resting orders, stops).
 * Live prices redraw the canvas directly inside requestAnimationFrame: no React render per tick, no render on pointer moves.
 * Rising candles are hollow and falling candles are filled, so direction does not rest on colour alone.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT, type Key } from '../i18n';
import { Icon } from '../ui';
import { dapi } from './api';
import { Seg, useLocalState } from './bits';
import { applyTick, sma, toBars, type Bar } from './reducers';
import type { MarketStore } from './store';
import { INTERVAL_MS, INTERVALS, type Interval } from './types';

export interface Overlay { price: number; label: string; kind: 'entry' | 'liq' | 'order' | 'stop' | 'tp' }
const AXIS_W = 62, AXIS_H = 20, PAD_T = 10;
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
/** the chart's colours, read from the theme's tokens ONCE per theme (not on every frame: the canvas redraws up to 60 times a second) */
type Palette = { up: string; down: string; line: string; mute: string; ink: string; surface: string; blue: string; warn: string; onp: string; primary: string };
let palette: { key: string; c: Palette } | null = null;
const DARK = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
function colours(): Palette {
  const key = `${document.documentElement.getAttribute('data-theme') ?? ''}|${DARK?.matches ? 'd' : 'l'}`;
  if (palette?.key !== key) palette = { key, c: { up: cssVar('--emerald'), down: cssVar('--danger'), line: cssVar('--line'), mute: cssVar('--mute'), ink: cssVar('--ink'), surface: cssVar('--surface'), blue: cssVar('--blue'), warn: cssVar('--warn'), onp: cssVar('--onprimary'), primary: cssVar('--primary') } };
  return palette.c;
}

export function Candles({ store, interval, onInterval, overlays, priceDp, locale, stale, height }: { store: MarketStore; interval: Interval; onInterval: (i: Interval) => void; overlays: Overlay[]; priceDp: number; locale: string; stale: boolean; height: number }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), readout = useRef<HTMLDivElement>(null);
  const bars = useRef<Bar[]>([]), hover = useRef<number | null>(null), raf = useRef(0), lastTrade = useRef(0), geom = useRef<{ first: number; n: number; cw: number; plotW: number } | null>(null);
  const [zoom, setZoom] = useLocalState<number>('spw-fut-zoom', 7);
  const [ma, setMa] = useLocalState<{ a: boolean; b: boolean }>('spw-fut-ma', { a: true, b: false });
  const [summary, setSummary] = useState('');
  const q = useQuery({ queryKey: ['deriv', 'candles', store.id, interval], queryFn: () => dapi.candles(store.id, interval, 300), refetchInterval: 60_000, staleTime: 0 });
  const nf = useMemo(() => new Intl.NumberFormat(locale === 'en' ? 'en-CA' : 'fr-CA', { minimumFractionDigits: priceDp, maximumFractionDigits: priceDp }), [locale, priceDp]);
  const vf = useMemo(() => new Intl.NumberFormat(locale === 'en' ? 'en-CA' : 'fr-CA', { notation: 'compact', maximumFractionDigits: 2 }), [locale]);
  const tf = useCallback((ts: number, long = false) => new Date(ts).toLocaleString(locale === 'en' ? 'en-CA' : 'fr-CA', INTERVAL_MS[interval] >= 86_400_000 ? { month: 'short', day: 'numeric' } : long ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }), [locale, interval]);

  const draw = useCallback(() => {
    raf.current = 0;
    const cv = canvas.current, el = box.current; if (!cv || !el) return;
    const W = el.clientWidth, H = height, dpr = Math.min(3, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const C = colours();
    const all = bars.current, plotW = W - AXIS_W, plotH = H - AXIS_H - PAD_T, volH = Math.round(plotH * 0.2), priceH = plotH - volH - 8;
    g.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'; g.textBaseline = 'middle';
    if (all.length < 2) { geom.current = null; g.fillStyle = C.mute; g.textAlign = 'center'; if (q.isError) g.fillText(t('fxChartError'), W / 2, H / 2); return; }
    const cw = zoom, n = Math.max(10, Math.min(all.length, Math.floor((plotW - 6) / cw))), first = all.length - n, vis = all.slice(first);
    geom.current = { first, n, cw, plotW };
    const ma1 = ma.a ? sma(all, 20).slice(first) : null, ma2 = ma.b ? sma(all, 50).slice(first) : null;
    let lo = Infinity, hi = -Infinity, vmax = 0;
    for (const b of vis) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); vmax = Math.max(vmax, b.v); }
    const padY = (hi - lo || hi * 0.001) * 0.07; lo -= padY; hi += padY;
    const x = (i: number) => plotW - (n - i) * cw + cw / 2, y = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * priceH;
    // grid and price axis
    const rough = (hi - lo) / 5, mag = 10 ** Math.floor(Math.log10(rough)), stepV = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? rough;
    g.strokeStyle = C.line; g.lineWidth = 1; g.fillStyle = C.mute; g.textAlign = 'left';
    for (let v = Math.ceil(lo / stepV) * stepV; v < hi; v += stepV) { const yy = Math.round(y(v)) + 0.5; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.fillText(nf.format(v), plotW + 6, yy); }
    // time axis
    g.textAlign = 'center';
    const every = Math.max(1, Math.round(84 / cw));
    for (let i = n - 1 - Math.floor(every / 2); i >= 0; i -= every) { const xx = x(i); if (xx > 26 && xx < plotW - 22) g.fillText(tf(vis[i]!.ts), xx, H - AXIS_H / 2); }
    // volume and candles
    const bw = Math.max(1, Math.min(cw - 2, Math.floor(cw * 0.72)));
    for (let i = 0; i < n; i++) {
      const b = vis[i]!, up = b.c >= b.o, xx = Math.round(x(i)), col = up ? C.up : C.down;
      if (vmax > 0 && b.v > 0) { const vh = Math.max(1, (b.v / vmax) * volH); g.globalAlpha = 0.28; g.fillStyle = col; g.fillRect(xx - bw / 2, PAD_T + plotH - vh, bw, vh); g.globalAlpha = 1; }
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(xx + 0.5, y(b.h)); g.lineTo(xx + 0.5, y(b.l)); g.stroke();
      const top = y(Math.max(b.o, b.c)), hgt = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      if (up && bw >= 3 && hgt >= 2) { g.fillStyle = C.surface; g.fillRect(xx - bw / 2, top, bw, hgt); g.strokeRect(xx - bw / 2 + 0.5, top + 0.5, bw - 1, hgt - 1); }
      else g.fillRect(xx - bw / 2, top, bw, hgt);
    }
    // moving averages (solid and dashed: two strokes, not only two colours)
    const line = (vals: (number | null)[], col: string, dash: number[]) => { g.strokeStyle = col; g.lineWidth = 1.4; g.setLineDash(dash); g.beginPath(); let pen = false;
      vals.forEach((v, i) => { if (v === null) return; if (pen) g.lineTo(x(i), y(v)); else { g.moveTo(x(i), y(v)); pen = true; } }); g.stroke(); g.setLineDash([]); };
    if (ma1) line(ma1, C.blue, []);
    if (ma2) line(ma2, C.warn, [5, 3]);
    // markers: entry, liquidation estimate, orders, stops
    const chip = (text: string, xx: number, yy: number, bg: string, fg: string, align: 'left' | 'right') => { const w = g.measureText(text).width + 10, x0 = align === 'left' ? xx : xx - w; g.fillStyle = bg; g.beginPath(); g.roundRect(x0, yy - 9, w, 18, 5); g.fill(); g.fillStyle = fg; g.textAlign = 'left'; g.fillText(text, x0 + 5, yy + 0.5); return w; };
    const colOf = { entry: C.blue, liq: C.down, order: C.mute, stop: C.warn, tp: C.up } as const;
    let edgeTop = PAD_T + 10, edgeBottom = PAD_T + priceH - 10;
    for (const o of overlays) {
      if (!Number.isFinite(o.price) || o.price <= 0) continue;
      const col = colOf[o.kind], text = `${o.label} ${nf.format(o.price)}`;
      if (o.price > hi) { chip(`▲ ${text}`, 4, edgeTop, col, C.surface, 'left'); edgeTop += 20; continue; }
      if (o.price < lo) { chip(`▼ ${text}`, 4, edgeBottom, col, C.surface, 'left'); edgeBottom -= 20; continue; }
      const yy = Math.round(y(o.price)) + 0.5;
      g.strokeStyle = col; g.lineWidth = 1; g.setLineDash(o.kind === 'entry' ? [] : [4, 3]); g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.setLineDash([]);
      chip(text, 4, yy, col, C.surface, 'left');
    }
    // last price
    const last = vis[n - 1]!, ly = Math.round(y(last.c)) + 0.5;
    g.strokeStyle = C.ink; g.globalAlpha = 0.5; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, ly); g.lineTo(plotW, ly); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    chip(nf.format(last.c), plotW + 2, ly, C.primary, C.onp, 'left');
    // crosshair
    const h = hover.current, cur = h !== null && h >= 0 && h < n ? vis[h]! : null;
    if (cur && h !== null) { const xx = Math.round(x(h)) + 0.5; g.strokeStyle = C.mute; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xx, PAD_T); g.lineTo(xx, PAD_T + plotH); const cy = Math.round(y(cur.c)) + 0.5; g.moveTo(0, cy); g.lineTo(plotW, cy); g.stroke(); g.setLineDash([]);
      chip(nf.format(cur.c), plotW + 2, cy, C.ink, C.surface, 'left');
      const lbl = tf(cur.ts, true), w = g.measureText(lbl).width + 10; chip(lbl, Math.max(0, Math.min(plotW - w, xx - w / 2)), H - AXIS_H / 2, C.primary, C.onp, 'left'); }
    // read-out (DOM text, so it is selectable and read by assistive tech on demand)
    const b = cur ?? last, prev = vis[(cur && h !== null ? h : n - 1) - 1], ch = prev ? ((b.c - prev.c) / prev.c) * 100 : 0;
    if (readout.current) readout.current.textContent = `${cur ? tf(b.ts, true) + ' · ' : ''}${t('fxO')} ${nf.format(b.o)}  ${t('fxH')} ${nf.format(b.h)}  ${t('fxL')} ${nf.format(b.l)}  ${t('fxC')} ${nf.format(b.c)}  ${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(2).replace('.', locale === 'en' ? '.' : ',')} %${b.v > 0 ? `  ${t('fxVol')} ${vf.format(b.v)}` : ''}`;
  }, [height, zoom, ma, overlays, nf, vf, tf, t, q.isError, locale]);
  const loading = q.isLoading;
  const redraw = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(draw); }, [draw]);

  // a new market or interval starts from an empty series (declared before the history effect: it must run first)
  useEffect(() => { bars.current = []; hover.current = null; redraw(); }, [store, interval]);   // eslint-disable-line react-hooks/exhaustive-deps
  // history
  useEffect(() => {
    if (!q.data) return;
    bars.current = toBars(q.data);
    const tk = store.ticker; if (tk) bars.current = applyTick(bars.current, INTERVAL_MS[interval], Number(tk.mark), tk.ts);
    const f = bars.current[0], l = bars.current[bars.current.length - 1];
    if (f && l) setSummary(t('fxChartAria', { n: bars.current.length, interval, from: tf(f.ts, true), to: tf(l.ts, true), close: nf.format(l.c) }));
    redraw();
  }, [q.data, interval, store]);   // eslint-disable-line react-hooks/exhaustive-deps
  // live: mark price and trades go straight to the canvas
  useEffect(() => {
    const ms = INTERVAL_MS[interval];
    const onTicker = () => { const tk = store.ticker; if (!tk || !bars.current.length) return; const next = applyTick(bars.current, ms, Number(tk.mark), tk.ts); if (next !== bars.current) { bars.current = next; redraw(); } };
    const onTrades = () => { let next = bars.current; if (!next.length) return; const since = lastTrade.current;
      for (const tr of store.trades) { if (tr.ts <= since) break; lastTrade.current = Math.max(lastTrade.current, tr.ts); if (since) next = applyTick(next, ms, Number(tr.price), tr.ts, Number(tr.size)); }
      if (next !== bars.current) { bars.current = next; redraw(); } };
    lastTrade.current = 0;
    const a = store.subscribe('ticker', onTicker), b = store.subscribe('trades', onTrades);
    return () => { a(); b(); };
  }, [store, interval, redraw]);
  useEffect(() => { redraw(); const el = box.current; if (!el) return; const ro = new ResizeObserver(redraw); ro.observe(el); return () => { ro.disconnect(); if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; }; }, [redraw]);

  const at = (clientX: number) => { const el = box.current, gm = geom.current; if (!el || !gm) return; const px = clientX - el.getBoundingClientRect().left; const i = Math.round((px - (gm.plotW - gm.n * gm.cw) - gm.cw / 2) / gm.cw); hover.current = Math.max(0, Math.min(gm.n - 1, i)); redraw(); };
  const leave = () => { hover.current = null; redraw(); };
  const key = (e: React.KeyboardEvent) => { const gm = geom.current; if (!gm) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const cur = hover.current ?? gm.n - 1; hover.current = Math.max(0, Math.min(gm.n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))); redraw(); }
    else if (e.key === 'Escape') leave(); };
  const tog = 'press inline-flex min-h-11 items-center rounded-xl px-2.5 text-[0.78125rem] font-semibold';
  const zoomBtn = 'press grid h-11 w-11 place-items-center rounded-xl text-mute hover:bg-elev disabled:opacity-40';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Seg size="sm" label={t('fxInterval')} value={interval} onChange={onInterval} options={INTERVALS.map((i) => ({ id: i, label: i, aria: t(`fxInt_${i}` as Key) }))} className="w-full sm:w-[330px]" />
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('dzFxChartTools')}>
          <button type="button" aria-pressed={ma.a} onClick={() => setMa({ ...ma, a: !ma.a })} title={t('fxMaA')} aria-label={t('fxMaA')} className={`${tog} ${ma.a ? 'bg-blue/10 text-blue' : 'text-mute hover:bg-elev'}`}><span className="mr-1.5 inline-block h-0.5 w-3.5 rounded-full bg-current" aria-hidden="true" />{t('fxMaShortA')}</button>
          <button type="button" aria-pressed={ma.b} onClick={() => setMa({ ...ma, b: !ma.b })} title={t('fxMaB')} aria-label={t('fxMaB')} className={`${tog} ${ma.b ? 'bg-warn/12 text-warn' : 'text-mute hover:bg-elev'}`}><span className="mr-1.5 inline-block h-0 w-3.5 border-t-2 border-dashed border-current" aria-hidden="true" />{t('fxMaShortB')}</button>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          <button type="button" onClick={() => setZoom(Math.max(3, zoom - 2))} disabled={zoom <= 3} aria-label={t('fxZoomOut')} className={zoomBtn}><Icon n="minus" className="h-4 w-4" /></button>
          <button type="button" onClick={() => setZoom(Math.min(19, zoom + 2))} disabled={zoom >= 19} aria-label={t('fxZoomIn')} className={zoomBtn}><Icon n="plus" className="h-4 w-4" /></button>
        </div>
      </div>
      {/* the read-out wraps on a narrow screen (two lines are reserved): no figure is ever cut */}
      <div ref={readout} className="mt-2 min-h-[34px] whitespace-pre-wrap text-[0.71875rem] leading-[17px] text-mute sm:min-h-[17px]" data-testid="ohlc" />
      <div ref={box} tabIndex={0} role="img" aria-label={summary || t('fxChart')} onKeyDown={key} onBlur={leave}
        className={`relative mt-1 touch-pan-y select-none rounded-xl outline-offset-2 ${stale ? 'opacity-50 grayscale' : ''}`} style={{ height }}
        onPointerDown={(e) => at(e.clientX)} onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) at(e.clientX); }}
        onPointerUp={(e) => { if (e.pointerType !== 'mouse') leave(); }} onPointerLeave={leave} onPointerCancel={leave}>
        <canvas ref={canvas} className="block" data-testid="candles" />
        {loading && <div className="pointer-events-none absolute inset-0 flex items-end gap-[3%] pb-6 pr-16" aria-hidden="true" data-testid="candles-skeleton">{[38, 52, 44, 63, 58, 71, 49, 66, 78, 61, 84, 73].map((h, k) => <div key={k} className="skel flex-1 !rounded-md" style={{ height: `${h}%` }} />)}</div>}
      </div>
      {overlays.length > 0 && <ul className="sr-only">{overlays.map((o, i) => <li key={i}>{o.label} {nf.format(o.price)}</li>)}</ul>}
    </div>
  );
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/screens/agentBits.tsx
 * Module           : screens
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// v10 design pass — pieces shared by the agent screens (spot and perp): local to this area, candidates for ui.tsx.
// Presentation only: nothing here reads the API, parses an amount or decides anything.
import { useState, type ReactNode } from 'react';
import { PriceChart, type Pt } from '../chart';
import { D, dec } from '../derivatives/dec';
import { Pnl, SideTag } from '../derivatives/bits';
import type { Position } from '../derivatives/types';
import { useT } from '../i18n';
import { AssetIcon, Card, Change, Icon, inputCls, NetworkIcon, VenueIcon } from '../ui';

/** An agent's universe as overlapping logos: at most `max`, then « +n ». Decorative: the symbols are written beside it. */
export function LogoStack({ syms, size = 36, max = 3 }: { syms: string[]; size?: number; max?: number }) {
  const shown = syms.slice(0, max), more = syms.length - shown.length, lap = -Math.round(size * 0.34);
  return <span className="flex shrink-0 items-center" aria-hidden="true">
    {shown.map((s, k) => <span key={s} className="rounded-full ring-2 ring-surface" style={k ? { marginLeft: lap } : undefined}><AssetIcon sym={s} size={size} /></span>)}
    {more > 0 && <span className="grid place-items-center rounded-full bg-elev text-[0.71875rem] font-semibold text-mute ring-2 ring-surface" style={{ width: size, height: size, marginLeft: lap }}>+{more}</span>}</span>;
}

/** A card's heading whose trailing tag (the mode of the money it counts) drops under a long title instead of squeezing it. */
export function CardHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"><h2 className="min-w-0 text-[1.0625rem] font-semibold tracking-[-0.015em]">{children}</h2>{right}</div>;
}

/**
 * The equity curve as a card: title (and the mode tag of the money it counts), the latest figure — or the one under the
 * finger — the change since the first point with sign and arrow, then the system's chart. Fewer than two points: a designed
 * empty state instead of an empty plot.
 */
export function EquityCard({ title, right, points, format, formatTime, testid }: { title: ReactNode; right?: ReactNode; points: Pt[]; format: (v: number) => string; formatTime: (t: number) => string; testid?: string }) {
  const t = useT(); const [hover, setHover] = useState<Pt | null>(null);
  const first = points[0], last = points[points.length - 1], cur = hover ?? last;
  const pct = first && cur && first.p > 0 ? ((cur.p - first.p) / first.p) * 100 : null;
  return <Card className="!pb-4"><div data-testid={testid}><CardHead right={right}>{title}</CardHead>
    {points.length < 2 || !first || !cur ? <div className="flex items-center gap-3.5 rounded-2xl bg-elev/60 px-4 py-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface text-mute"><Icon n="chart" /></span>
      <div className="min-w-0"><p className="text-[0.90625rem] font-semibold">{t('dzAgEqEmptyTitle')}</p><p className="mt-0.5 text-[0.8125rem] leading-snug text-mute">{t('dzAgEqEmpty')}</p></div></div>
      : <>
        <div className="text-[0.8125rem] text-mute">{hover ? formatTime(hover.t) : t('dzAgEqNow')}</div>
        <div className="t-num mt-1 text-[1.875rem]">{format(cur.p)}</div>
        <div className="mt-1.5 min-h-5">{pct !== null && <Change pct={pct} suffix={` ${t('dzAgEqSince', { date: formatTime(first.t) })}`} />}</div>
        <div className="mt-3"><PriceChart points={points} format={format} formatTime={formatTime} onHover={setHover} /></div></>}
  </div></Card>;
}

/** A titled group of a creation form: eyebrow label, then its fields. */
export function FormGroup({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return <div role="group" aria-label={title} className="space-y-3.5"><div className="flex min-h-6 items-center justify-between gap-3"><h3 className="t-eyebrow">{title}</h3>{right}</div>{children}</div>;
}

/** A field's input with its unit written inside, on the right (USD, %, ×, bps). */
export function UnitInput({ value, onChange, unit, unitTestid, ...rest }: { value: string; onChange: (v: string) => void; unit: string; unitTestid?: string; inputMode?: 'decimal' | 'numeric'; disabled?: boolean; 'aria-label'?: string }) {
  return <span className="relative block"><input {...rest} className={`${inputCls} t-num !font-semibold`} style={{ paddingRight: `${Math.max(3, unit.length * 0.62 + 2)}rem` }} inputMode={rest.inputMode ?? 'decimal'} value={value} onChange={(e) => onChange(e.target.value)} />
    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[0.8125rem] font-medium text-mute" data-testid={unitTestid}>{unit}</span></span>;
}

/** The one network an agent lives on: chips with the network's logo. A network that cannot host an agent is shown, disabled, and the reason is written under the group. */
export function NetworkChips({ value, options, onChange, label, offNote }: { value: string; options: { id: string; name: string; enabled: boolean }[]; onChange: (id: string) => void; label: string; offNote: string }) {
  const off = options.filter((o) => !o.enabled);
  return <div><div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">{options.map((o) => { const on = value === o.id; return (
    <button key={o.id} type="button" role="radio" aria-checked={on} disabled={!o.enabled} onClick={() => { if (!on) onChange(o.id); }}
      className={`press inline-flex min-h-11 items-center gap-2 rounded-full border pl-2 pr-4 text-[0.875rem] font-medium disabled:opacity-45 ${on ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface text-ink'}`}>
      <NetworkIcon net={o.id} size={26} />{o.name}</button>); })}</div>
    {off.length > 0 && <p className="mt-2 text-[0.78125rem] leading-snug text-mute">{off.map((o) => o.name).join(', ')} — {offNote}</p>}</div>;
}

/** The agent's journal: newest first, one dot per entry on a hairline rail. */
export function Journal({ items, empty }: { items: { key: string; title: ReactNode; time: string; body?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }[]; empty: string }) {
  if (!items.length) return <p className="text-[0.875rem] text-mute">{empty}</p>;
  return <ol className="space-y-0">{items.map((x, k) => <li key={x.key} className="relative pb-4 pl-6 last:pb-0">
    {k < items.length - 1 && <span className="absolute bottom-0 left-[4.5px] top-[18px] w-px bg-line" aria-hidden="true" />}
    <span className={`absolute left-0 top-[6px] h-2.5 w-2.5 rounded-full ${x.tone === 'ok' ? 'bg-emerald' : x.tone === 'warn' ? 'bg-warn' : x.tone === 'danger' ? 'bg-danger' : 'bg-line ring-1 ring-mute/40'}`} aria-hidden="true" />
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"><span className="min-w-0 text-[0.875rem] font-semibold leading-snug">{x.title}</span><span className="shrink-0 text-[0.75rem] text-mute">{x.time}</span></div>
    {x.body && <div className="mt-1 min-w-0 text-[0.8125rem] leading-snug text-mute">{x.body}</div>}</li>)}</ol>;
}

/** A signed amount with its arrow: direction is written twice (sign, arrow), the colour only repeats it. */
export function PnlArrow({ value, locale, dp }: { value: string | null | undefined; locale: string; dp?: number }) {
  const d = dec(value), s = d ? D.sign(D.div(d, D.one, dp ?? 2, 'half_even')) : 0;   // the arrow follows the ROUNDED figure, like the sign: no arrow beside « 0,00 »
  return <span className="inline-flex items-center gap-1 whitespace-nowrap">{s !== 0 && <svg viewBox="0 0 12 12" className={`h-2.5 w-2.5 ${s > 0 ? 'text-emerald' : 'text-danger'}`} aria-hidden="true"><path d={s > 0 ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>}<Pnl value={value} locale={locale} dp={dp} /></span>;
}

/** Open positions as dense rows: the market's logo with the venue's badge, side and leverage, the figures on one tidy line, the latent result with sign and arrow. */
export function PositionRows({ positions, venue, locale, px, empty, approxLiq, liqTitle, label }: { positions: Position[]; venue: string; locale: string; px: (x: string | null | undefined) => string; empty: string; approxLiq?: boolean; liqTitle?: string; label: string }) {
  const t = useT();
  if (!positions.length) return <p className="rounded-2xl bg-elev/60 px-4 py-5 text-center text-[0.84375rem] text-mute">{empty}</p>;
  const sym = (i: string) => i.slice(i.indexOf(':') + 1);
  return <ul className="divide-y divide-line" aria-label={label}>{positions.map((p) => <li key={p.instrument} className="py-3 first:pt-1 last:pb-1">
    <div className="flex items-center gap-3">
      <span className="relative shrink-0"><AssetIcon sym={sym(p.instrument)} size={38} /><span className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-surface"><VenueIcon venue={venue} size={16} /></span></span>
      <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="text-[0.96875rem] font-semibold">{sym(p.instrument)}</span><SideTag side={p.side} /><span className="text-[0.78125rem] font-medium text-mute">{px(p.leverage)}×</span></span>
        <span className="block text-[0.78125rem] text-mute">{t('paColSize')} <span className="font-medium text-ink">{px(p.size)}</span></span></span>
      <span className="shrink-0 text-right"><span className="block text-[0.71875rem] text-mute">{t('paColPnl')}</span><span className="text-[0.9375rem] font-semibold"><PnlArrow value={p.unrealizedPnl} locale={locale} /></span></span></div>
    <dl className="mt-2 grid grid-cols-3 gap-2 pl-[50px] text-[0.78125rem]">
      <div className="min-w-0"><dt className="text-[0.71875rem] text-mute">{t('paColEntry')}</dt><dd className="font-medium [overflow-wrap:anywhere]">{px(p.entryPrice)}</dd></div>
      <div className="min-w-0"><dt className="text-[0.71875rem] text-mute">{t('paColMark')}</dt><dd className="font-medium [overflow-wrap:anywhere]">{px(p.markPrice)}</dd></div>
      <div className="min-w-0"><dt className="text-[0.71875rem] text-mute">{t('paColLiq')}</dt><dd className="font-medium [overflow-wrap:anywhere]" title={liqTitle}>{p.liquidationPrice ? `${approxLiq ? '≈ ' : ''}${px(p.liquidationPrice)}` : <span className="text-mute">—</span>}</dd></div></dl></li>)}</ul>;
}

/** One figure of a backtest report with what it is compared to: label left, value and its benchmark right. Wrap several in a <dl>. */
export function Metric({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 border-t border-line py-2 first:border-t-0"><dt className="text-[0.84375rem] text-mute">{label}</dt>
    <dd className="min-w-0 text-right"><span className="t-num block text-[1rem]">{value}</span>{sub && <span className="block text-[0.75rem] leading-snug text-mute">{sub}</span>}</dd></div>;
}

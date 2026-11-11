import { useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { I18n, useT, type Key } from '../i18n';
import { Icon } from '../ui';
import { D, dec, fmt, usd } from './dec';
import type { VenueId } from './types';

/** viewport test without rendering both layouts: one tree on a phone, another on a desktop */
export function useMedia(query: string): boolean {
  return useSyncExternalStore((f) => { const m = matchMedia(query); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, () => matchMedia(query).matches);
}
export const useLocalState = <T,>(key: string, initial: T): [T, (v: T) => void] => {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s === null ? initial : (JSON.parse(s) as T); } catch { return initial; } });
  return [v, (n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* private mode */ } }];
};

/** every money-like number of the simulated account carries this mark */
export function PaperTag({ className = '' }: { className?: string }) {
  const t = useT();
  return <span className={`inline-flex shrink-0 items-center rounded-md border border-blue/35 bg-blue/8 px-1.5 py-px text-[10.5px] font-bold uppercase tracking-[0.06em] text-blue ${className}`} title={t('fxPaperTitle')}>{t('fxPaper')}</span>;
}
export const VENUE_NAME: Record<VenueId, string> = { hyperliquid: 'Hyperliquid', dydx: 'dYdX v4', gmx: 'GMX v2' };
const VENUE_DOT: Record<VenueId, string> = { hyperliquid: '#1f9e8f', dydx: '#6966ff', gmx: '#2d6be0' };
export function VenueBadge({ venue, className = '' }: { venue: VenueId; className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-ink ${className}`}>
    <span className="h-2 w-2 rounded-full" style={{ background: VENUE_DOT[venue] ?? '#667085' }} aria-hidden="true" />{VENUE_NAME[venue] ?? venue}</span>;
}

/** Long / short: a word and an arrow, the colour only repeats them */
export function SideTag({ side }: { side: 'long' | 'short' | 'buy' | 'sell' }) {
  const t = useT(); const up = side === 'long' || side === 'buy';
  return <span className={`inline-flex items-center gap-1 text-[12.5px] font-semibold ${up ? 'text-emerald' : 'text-danger'}`}>
    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={up ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>{t(`fxSide_${side}` as Key)}</span>;
}
/** signed amount: '+' or '−' is always written, the colour only repeats it */
export function Pnl({ value, locale, unit = 'usd', dp = 2 }: { value: string | null | undefined; locale: string; unit?: 'usd' | 'plain'; dp?: number }) {
  const d = dec(value);
  if (!d) return <span className="text-mute">—</span>;
  const s = D.sign(D.div(d, D.one, dp, 'half_even'));
  return <span className={s > 0 ? 'text-emerald' : s < 0 ? 'text-danger' : 'text-ink'}>{unit === 'usd' ? usd(d, locale, true) : fmt(d, { dp, locale, sign: true })}</span>;
}

/** segmented control; `tabs` makes it a tablist */
export function Seg<T extends string>({ value, options, onChange, label, tabs, size = 'md', className = '' }: { value: T; options: { id: T; label: ReactNode; aria?: string }[]; onChange: (v: T) => void; label: string; tabs?: boolean; size?: 'sm' | 'md'; className?: string }) {
  return <div role={tabs ? 'tablist' : 'radiogroup'} aria-label={label} className={`no-scrollbar flex gap-1 overflow-x-auto rounded-2xl bg-elev p-1 ${className}`}>{options.map((o) => { const on = value === o.id; return (
    <button key={o.id} type="button" role={tabs ? 'tab' : 'radio'} aria-selected={tabs ? on : undefined} aria-checked={tabs ? undefined : on} aria-label={o.aria} onClick={() => onChange(o.id)}
      className={`min-h-11 flex-[1_0_auto] whitespace-nowrap rounded-xl px-3 font-semibold transition ${size === 'sm' ? 'min-w-11 text-[13px]' : 'text-[14px]'} ${on ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(15,23,42,0.12)]' : 'text-mute hover:text-ink'}`}>{o.label}</button>); })}</div>;
}
export function Stat({ label, children, className = '', wrap }: { label: ReactNode; children: ReactNode; className?: string; wrap?: boolean }) {
  return <div className={`min-w-0 ${className}`}><div className="truncate text-[11.5px] text-mute">{label}</div><div className={`text-[13.5px] font-medium ${wrap ? 'whitespace-nowrap' : 'truncate'}`}>{children}</div></div>;
}
export function Row({ label, children, strong }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return <div className="flex items-baseline justify-between gap-3 py-1 text-[13.5px]"><span className="text-mute">{label}</span><span className={`text-right ${strong ? 'font-semibold' : 'font-medium'}`}>{children}</span></div>;
}

/** bottom sheet on a phone, centred dialog on a desktop; Escape closes, focus stays inside */
export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const t = useT(); const box = useRef<HTMLDivElement>(null);
  // the second click of a double click on the button that opened the sheet lands on the backdrop: it must not close it
  const openedAt = useRef(Date.now());
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]')];
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    const o = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = o; prev?.focus?.(); };
  }, [onClose]);
  // rendered under <body>: <main> animates with a transform, which would trap a fixed layer under the bottom navigation
  return createPortal(<div className="fixed inset-0 z-40 flex items-end justify-center bg-[rgba(8,11,18,0.45)] sm:items-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget && Date.now() - openedAt.current > 500) onClose(); }}>
    <div ref={box} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={`safe-b flex max-h-[92dvh] w-full flex-col rounded-t-[26px] bg-surface shadow-2xl outline-none sm:rounded-[26px] ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}>
      <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4"><h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t('fxClose')} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-mute hover:bg-elev"><Icon n="x" /></button></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
    </div></div>, document.body);
}

export interface Col<T> { id: string; label: ReactNode; cell: (row: T) => ReactNode; num?: boolean; /** on a phone: shown in the card's title line instead of the grid */ head?: boolean; /** on a phone: takes the whole width of the card */ full?: boolean }
/** a real table on wide screens, one card per row on a phone (never both in the DOM) */
export function DataTable<T>({ cols, rows, rowKey, empty, label }: { cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; empty: string; label: string }) {
  const wide = useMedia('(min-width: 768px)');
  if (!rows.length) return <p className="py-8 text-center text-[13.5px] text-mute">{empty}</p>;
  if (wide) return <div className="overflow-x-auto"><table className="w-full min-w-max border-separate border-spacing-0 text-[13px]" aria-label={label}>
    <thead><tr>{cols.map((c) => <th key={c.id} scope="col" className={`whitespace-nowrap border-b border-line px-2.5 py-2 text-[11.5px] font-medium text-mute ${c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr></thead>
    <tbody>{rows.map((r) => <tr key={rowKey(r)}>{cols.map((c) => <td key={c.id} className={`whitespace-nowrap border-b border-line/70 px-2.5 py-2 align-middle ${c.num ? 'text-right' : 'text-left'}`}>{c.cell(r)}</td>)}</tr>)}</tbody></table></div>;
  return <ul className="space-y-2.5" aria-label={label}>{rows.map((r) => <li key={rowKey(r)} className="rounded-2xl border border-line p-3.5">
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">{cols.filter((c) => c.head).map((c) => <span key={c.id} className="text-[14px] font-semibold">{c.cell(r)}</span>)}</div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">{cols.filter((c) => !c.head).map((c) => <div key={c.id} className={c.label === '' || c.full ? 'col-span-2' : 'min-w-0'}>{c.label !== '' && <dt className="text-[11.5px] text-mute">{c.label}</dt>}<dd className="min-w-0 break-words font-medium">{c.cell(r)}</dd></div>)}</dl></li>)}</ul>;
}
const p2 = (n: number) => String(n).padStart(2, '0');
/** 24-hour clock « 14:05:09 »; with the date: « 10 nov. 14:05 » */
export const timeOf = (ts: number, locale: string, withDate = false) => { const d = new Date(ts); return withDate ? `${d.toLocaleDateString(locale === 'fr' ? 'fr-CA' : 'en-CA', { month: 'short', day: 'numeric' })} ${p2(d.getHours())}:${p2(d.getMinutes())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
/** « 14 s », « 3 min », « 2 h » */
export const ageText = (ms: number | null): string => (ms === null ? '—' : ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

/** A sentence written by the server, in English. Where the interface already says the same thing in the owner's language
 *  (every use of this component follows such a sentence), the English original is only shown in the English interface. */
export function ServerSays({ text, className, mono }: { text: string; className: string; mono?: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (locale !== 'en') return null;
  return <span className={`block ${className}`}>{t('fxServerSays')} {mono ? <span className="font-mono text-[11px]">{text}</span> : text}</span>;
}

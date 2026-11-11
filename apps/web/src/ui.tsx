import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useContext } from 'react';
import { I18n, stateKey, useT } from './i18n';
import { AssetIcon, NetworkIcon } from './icons';
export { AssetIcon, NetworkIcon, ProviderIcon, VenueIcon } from './icons';

/** Haptic-like tick where the platform has one (Android; iOS ignores it): confirms a tap, never replaces a visible state. */
export const haptic = (ms = 8): void => { try { if (!matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate?.(ms); } catch { /* not available */ } };

const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z', down: 'M12 4v13m0 0l-5-5m5 5l5-5M5 21h14', up: 'M12 20V7m0 0l-5 5m5-5l5 5M5 3h14',
  list: 'M4 6h16M4 12h16M4 18h10', shield: 'M12 3l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zm8-3l2-1-2-4-2 1a7 7 0 00-2-1l-.5-2h-4L11 7a7 7 0 00-2 1L7 7 5 11l2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1l.5 2h4l.5-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z', eyeOff: 'M3 3l18 18M10.6 6.2A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.5 7.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004-.9',
  check: 'M5 12.5l4.5 4.5L19 7.5', x: 'M6 6l12 12M18 6L6 18', warn: 'M12 3l10 18H2zM12 10v5m0 3v.01', copy: 'M9 9h10v11H9zM5 15V4h10', ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  key: 'M15 7a4 4 0 11-3.9 5H8v3H5v3H2v-3l7.2-7.2A4 4 0 0115 7z', clock: 'M12 7v5l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z', stop: 'M8 3h8l5 5v8l-5 5H8l-5-5V8zM9 9l6 6m0-6l-6 6',
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z', search: 'M11 18a7 7 0 100-14 7 7 0 000 14zm5-2l4.5 4.5', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', bars: 'M4 20V11m5.5 9V4m5.5 16v-7m5 7V8',
  bell: 'M6 16V11a6 6 0 1112 0v5l1.5 2h-15zM10 20a2 2 0 004 0',
  chev: 'M9 6l6 6-6 6', swap: 'M7 8h11l-3-3M17 16H6l3 3', book: 'M5 4h13v16H5zM9 4v16M12 9h3', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3', spin: 'M12 3a9 9 0 109 9',
  share: 'M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v8h14v-8', cloudOff: 'M3 3l18 18M8 18h9a4 4 0 001.6-7.7M16 8.5A6 6 0 006.3 7M5.2 9.6A4.5 4.5 0 007 18', refresh: 'M20 12a8 8 0 11-2.6-5.9M20 4v5h-5',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z', robot: 'M12 3v3M7 6h10a2 2 0 012 2v8a2 2 0 01-2 2H7a2 2 0 01-2-2V8a2 2 0 012-2zM9 11v2m6-2v2M9 21h6M3 11v3m18-3v3', chart: 'M4 19h16M6 16l4-5 3 3 5-7',
};
export function Icon({ n, className = 'h-5 w-5' }: { n: keyof typeof P | string; className?: string }) {
  return <svg viewBox="0 0 24 24" className={`${className} ${n === 'spin' ? 'spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card p-5 ${className}`}>{children}</section>;
}
export function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-[17px] font-semibold tracking-[-0.015em]">{children}</h2>{right}</div>;
}
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'soft'; busy?: boolean; full?: boolean };
export function Btn({ kind = 'primary', busy, full, className = '', children, disabled, ...rest }: BtnProps) {
  const k = { primary: 'bg-primary text-onprimary font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]', ghost: 'border border-line text-ink font-medium', danger: 'bg-danger text-[var(--ondanger)] font-semibold', soft: 'bg-elev text-ink font-medium' }[kind];
  return <button {...rest} disabled={disabled || busy} className={`press inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl px-5 text-[15.5px] disabled:opacity-45 ${k} ${full ? 'w-full' : ''} ${className}`}>
    {busy && <Icon n="spin" className="h-4 w-4" />}{children}</button>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[13px] font-medium text-mute">{label}</span>{children}{hint && <span className="mt-1.5 block text-xs text-mute">{hint}</span>}</label>;
}
export const inputCls = 'w-full rounded-2xl border border-line bg-elev/60 px-4 py-3.5 outline-none transition placeholder:text-mute/70 focus:border-blue focus:bg-surface focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--blue)_16%,transparent)]';

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const c = { info: 'border-blue/20 bg-blue/[0.07]', warn: 'border-warn/30 bg-warn/[0.09]', danger: 'border-danger/40 bg-danger/[0.09]', ok: 'border-emerald/25 bg-emerald/[0.07]' }[tone];
  const ic = { info: 'shield', warn: 'warn', danger: 'warn', ok: 'check' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'note'} className={`flex gap-3 rounded-2xl border p-3.5 text-[13.5px] leading-snug ${c}`}><Icon n={ic} className={`mt-0.5 h-4 w-4 shrink-0 ${ {info:'text-blue',warn:'text-warn',danger:'text-danger',ok:'text-emerald'}[tone] }`} /><div className="min-w-0">{children}</div></div>;
}

const TONE: Record<string, [string, string]> = {
  finalized: ['text-emerald bg-emerald/10', 'check'], confirming: ['text-blue bg-blue/10', 'clock'], broadcast: ['text-blue bg-blue/10', 'up'],
  signed: ['text-blue bg-blue/10', 'key'], approved: ['text-blue bg-blue/10', 'key'], pending_approval: ['text-warn bg-warn/12', 'clock'], draft: ['text-mute bg-elev', 'list'],
  failed: ['text-danger bg-danger/10', 'x'], rejected: ['text-danger bg-danger/10', 'x'], expired: ['text-mute bg-elev', 'clock'], replaced: ['text-warn bg-warn/12', 'warn'], reorged: ['text-warn bg-warn/12', 'warn'],
};
/** Status is always icon + text, never colour alone. */
export function StatePill({ state }: { state: string }) {
  const t = useT(); const [cls, ic] = TONE[state] ?? TONE.draft!;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${cls}`}><Icon n={ic} className="h-3 w-3" />{t(stateKey(state))}</span>;
}

export function Addr({ value }: { value: string }) {
  const a = value.slice(0, 6), z = value.slice(-6), m = value.slice(6, -6);
  return <span className="break-all font-mono text-[13.5px] leading-relaxed"><b className="text-blue">{a}</b><span className="text-ink/75">{m}</span><b className="text-blue">{z}</b></span>;
}
export const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

export function CopyBtn({ text, full }: { text: string; full?: boolean }) {
  const t = useT(); const [ok, setOk] = useState(false);
  useEffect(() => { if (!ok) return; const h = setTimeout(() => setOk(false), 1600); return () => clearTimeout(h); }, [ok]);
  return <Btn kind="soft" full={full} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setOk(true); haptic(); }); }}><Icon n={ok ? 'check' : 'copy'} className={`h-4 w-4 ${ok ? 'pop text-emerald' : ''}`} />{ok ? t('copied') : t('copy')}</Btn>;
}

/** Token logo with its network badge — the real logos (src/icons.tsx). Kept under its historical name: every screen uses it. */
export function Coin({ sym, net, size = 44 }: { sym: string; net?: string; size?: number }) { return <AssetIcon sym={sym} net={net} size={size} />; }
/** A network's logo at text size (historical name: it used to be a coloured dot). */
export function NetDot({ net, size = 16 }: { net: string; size?: number }) { return <NetworkIcon net={net} size={size} />; }
/** Horizontal chip selector (scrolls on small screens). */
export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; net?: string; sym?: string }[]; onChange: (v: T) => void; label: string }) {
  return <div role="radiogroup" aria-label={label} className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5">{options.map((o) =>
    <button key={o.id} role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
      className={`press inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border text-[14px] font-medium ${o.net || o.sym ? 'pl-2 pr-4' : 'px-4'} ${value === o.id ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface text-ink'}`}>
      {o.sym ? <AssetIcon sym={o.sym} size={26} /> : o.net && <NetworkIcon net={o.net} size={26} />}{o.label}</button>)}</div>;
}
/** Signed percentage with an arrow icon: direction is never carried by colour alone. */
export function Change({ pct, suffix }: { pct: number; suffix?: string }) {
  const up = pct > -0.005; const { locale } = useContext(I18n); // −0.001 % is not a fall: no "−0,00 %"
  return <span className={`inline-flex items-center gap-1 text-[13.5px] font-semibold ${up ? 'text-emerald' : 'text-danger'}`}>
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true"><path d={up ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>
    {up ? '+' : '−'}{numFmt(Math.abs(pct), locale, 2, 2)} %{suffix && <span className="font-normal text-mute">{suffix}</span>}</span>;
}
export function Money({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return <span className={hidden ? 'mask' : ''} aria-hidden={hidden || undefined}>{children}</span>;
}
export const trimAmt = (s: string, max = 6) => { const [i, f = ''] = s.split('.'); const ff = f.slice(0, max).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i!; };
/** A plain number in the owner's locale (decimal comma in French): percentages, ratios, small USD figures inside sentences. */
export const numFmt = (n: number, locale: string, max = 2, min = 0) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: max, minimumFractionDigits: Math.min(min, max) }).format(n);
export const fiat = (n: number, cur: string, locale: string) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur }).format(n);
export const when = (d: string | Date, locale: string) => new Date(d).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' });
/** A transfer signed on a server that does not broadcast (test stack): it will never confirm, and must not read as "sent". */
export const testNotSent = (p: { state?: string; error?: string | null } | null | undefined): boolean => !!p && p.state === 'broadcast' && /broadcast disabled/i.test(p.error ?? '');
export function Skeleton({ h = 'h-16', className = '' }: { h?: string; className?: string }) { return <div className={`skel ${h} ${className}`} aria-hidden="true" />; }

// ── v9 design system: shared pieces every screen composes ────────────────────────────────────────────────────────────────
/** Skeleton of a list card: rows shaped like the final rows (logo, two lines, amount), so nothing jumps when data lands. */
export function SkeletonRows({ n = 4 }: { n?: number }) {
  return <div className="card divide-y divide-line overflow-hidden" aria-hidden="true">{Array.from({ length: n }, (_, k) => <div key={k} className="flex items-center gap-3.5 px-5 py-3.5">
    <div className="skel h-11 w-11 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-3.5 w-28 !rounded-md" /><div className="skel h-3 w-20 !rounded-md" /></div><div className="space-y-2"><div className="skel ml-auto h-3.5 w-16 !rounded-md" /><div className="skel ml-auto h-3 w-12 !rounded-md" /></div></div>)}</div>;
}
/** Large page title of the type scale, with an optional back button and trailing slot. */
export function PageTitle({ children, onBack, backLabel, right }: { children: ReactNode; onBack?: () => void; backLabel?: string; right?: ReactNode }) {
  return <div className="flex items-center gap-1 pt-2">
    {onBack && <button onClick={onBack} aria-label={backLabel} className="press -ml-2.5 grid h-11 w-11 shrink-0 place-items-center rounded-full"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>}
    <h1 className="t-title min-w-0 flex-1">{children}</h1>{right}</div>;
}
/** Designed empty / error / offline state: icon, one sentence, optional action. */
export function EmptyState({ icon = 'list', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="card flex flex-col items-center px-6 py-10 text-center">
    <span className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-elev text-mute"><Icon n={icon} className="h-6 w-6" /></span>
    <p className="text-[15.5px] font-semibold">{title}</p>{children && <p className="mt-1.5 max-w-[32ch] text-[13.5px] text-mute">{children}</p>}{action && <div className="mt-5">{action}</div>}</div>;
}
/** Segmented control: ranges, filters, language, theme. */
export function Seg<T extends string>({ value, options, onChange, label, role = 'radiogroup' }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label?: string; role?: 'radiogroup' | 'tablist' }) {
  const tab = role === 'tablist';
  return <div className="flex rounded-2xl bg-elev p-1" role={role} aria-label={label}>{options.map(([v, l]) =>
    <button key={v} role={tab ? 'tab' : 'radio'} {...(tab ? { 'aria-selected': value === v } : { 'aria-checked': value === v })} onClick={() => { if (value !== v) { haptic(); onChange(v); } }}
      className={`min-h-11 flex-1 rounded-xl px-2 text-[13.5px] transition ${value === v ? 'bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(13,18,32,0.14)]' : 'text-mute'}`}>{l}</button>)}</div>;
}
/**
 * A displayed figure that glides to its new value (0.5 s) when the data refreshes. For read-only figures only (a total, a
 * price): a figure the owner is about to approve is never animated — an intermediate value there would be a wrong amount.
 * Screen readers get the final text at once (aria-label); reduced motion shows it at once.
 */
export function AnimatedNumber({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value); const from = useRef(value);
  useEffect(() => {
    const a = from.current, b = value; from.current = value;
    if (a === b || !Number.isFinite(a) || !Number.isFinite(b) || matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState !== 'visible') { setShown(b); return; }
    let raf = 0; const t0 = performance.now(), D = 520;
    const step = (now: number) => { const k = Math.min(1, (now - t0) / D), e = 1 - (1 - k) ** 3; setShown(k === 1 ? b : a + (b - a) * e); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <><span className="sr-only">{format(value)}</span><span aria-hidden="true">{format(shown)}</span></>;
}
/**
 * Bottom sheet: scrim, spring, grabber, drag down to dismiss (touch), Escape, keyboard-safe height.
 * `dismissable={false}` for approval sheets: they close only through their own buttons.
 */
export function Sheet({ title, onClose, children, dismissable = true, wide }: { title: string; onClose: () => void; children: ReactNode; dismissable?: boolean; wide?: boolean }) {
  const t = useT(); const panel = useRef<HTMLDivElement>(null); const drag = useRef<{ y: number; dy: number } | null>(null);
  useEffect(() => { panel.current?.focus(); const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose(); }; addEventListener('keydown', key); return () => removeEventListener('keydown', key); }, [onClose, dismissable]);
  const end = () => { const el = panel.current, d = drag.current; drag.current = null; if (!el || !d) return; el.classList.remove('sheet-dragging'); if (d.dy > 110) { haptic(); onClose(); } else el.style.transform = ''; };
  return <div className="fixed inset-0 z-30 flex items-end justify-center lg:items-center" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { if (dismissable && e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} tabIndex={-1} className={`safe-b flex w-full flex-col overflow-hidden rounded-t-[28px] bg-surface outline-none transition-transform duration-300 lg:rounded-[28px] ${wide ? 'lg:max-w-2xl' : 'lg:max-w-md'}`}>
      <div className="shrink-0 touch-none px-5 pb-2 pt-6 lg:pt-5"
        onPointerDown={(e) => { if (!dismissable || e.pointerType === 'mouse' || (e.target as Element).closest('button')) return; drag.current = { y: e.clientY, dy: 0 }; panel.current?.classList.add('sheet-dragging'); e.currentTarget.setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d || !panel.current) return; d.dy = Math.max(0, e.clientY - d.y); panel.current.style.transform = `translateY(${d.dy}px)`; }}
        onPointerUp={end} onPointerCancel={end}>
        <div className="flex items-center justify-between gap-3"><h2 className="text-[19px] font-semibold tracking-[-0.02em]">{title}</h2>
          {dismissable && <button onClick={onClose} aria-label={t('cancel')} className="press -mr-2 grid h-11 w-11 place-items-center rounded-full text-mute"><Icon n="x" /></button>}</div></div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
    </div></div>;
}
/** Pull down at the top of the page to refresh (touch). Returns the indicator to render; listeners are passive (scrolling is never blocked). */
export function usePullToRefresh(enabled: boolean, refresh: () => Promise<unknown> | void): ReactNode {
  const [pull, setPull] = useState(0), [busy, setBusy] = useState(false); const start = useRef<number | null>(null), cur = useRef(0), fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const down = (e: TouchEvent) => { start.current = scrollY <= 0 && !document.querySelector('[role=dialog]') ? e.touches[0]!.clientY : null; };
    const move = (e: TouchEvent) => { if (start.current === null) return; const dy = e.touches[0]!.clientY - start.current; const p = dy > 0 && scrollY <= 0 ? Math.min(96, dy * 0.45) : 0; if (p !== cur.current) { cur.current = p; setPull(p); } };
    const up = () => { const p = cur.current; start.current = null; cur.current = 0; setPull(0); if (p >= 64) { haptic(12); setBusy(true); void Promise.resolve(fn.current()).finally(() => setTimeout(() => setBusy(false), 450)); } };
    addEventListener('touchstart', down, { passive: true }); addEventListener('touchmove', move, { passive: true }); addEventListener('touchend', up); addEventListener('touchcancel', up);
    return () => { removeEventListener('touchstart', down); removeEventListener('touchmove', move); removeEventListener('touchend', up); removeEventListener('touchcancel', up); };
  }, [enabled]);
  if (!enabled || (!busy && pull <= 0)) return null;
  return <div className="ptr" role="status" data-testid="ptr" style={{ transform: `translateY(${busy ? 28 : pull - 20}px)`, opacity: busy ? 1 : Math.min(1, pull / 64) }}>
    <span style={busy ? undefined : { transform: `rotate(${pull * 4}deg)`, display: 'grid' }}><Icon n={busy ? 'spin' : 'refresh'} className="h-[18px] w-[18px]" /></span></div>;
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/ui.tsx
 * Module           : web
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

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useContext } from 'react';
import { I18n, useT } from './i18n';
import { AssetIcon, NetworkIcon } from './icons';
export { AssetIcon, NetworkIcon, ProviderIcon, VenueIcon } from './icons';

/** Haptic-like tick where the platform has one (Android; iOS ignores it): confirms a tap, never replaces a visible state. */
export const haptic = (ms = 8): void => { try { if (!matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate?.(ms); } catch { /* not available */ } };
import { amountLocale, formatAmount, type AmountLocale } from './amount';
import { lifecycleIcon, lifecycleLabel, lifecycleOf, type HasLifecycle } from './lifecycle';

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
  // NEXT: life-cycle symbols (lifecycle.ts), appearance, contacts, search
  pencil: 'M4 20l1-4L16.5 4.5a2 2 0 013 3L8 19zM14 7l3 3', tap: 'M9 11V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V11m0-.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L5 14.5a1.5 1.5 0 012.4-1.7L9 14.5',
  seal: 'M12 3l2.2 1.6 2.7-.1.9 2.6 2.2 1.6-.8 2.6.8 2.6-2.2 1.6-.9 2.6-2.7-.1L12 21l-2.2-1.6-2.7.1-.9-2.6L4 15.3l.8-2.6L4 10.1l2.2-1.6.9-2.6 2.7.1zM9 12.3l2.1 2.1L15.2 10', radio: 'M12 13a1 1 0 100-2 1 1 0 000 2zM8.5 15.5a5 5 0 010-7m7 0a5 5 0 010 7M5.6 18.4a9 9 0 010-12.8m12.8 0a9 9 0 010 12.8',
  clockCheck: 'M12 7v5l2.5 1.5M20.5 10.5A9 9 0 1013 20.9M15.5 18.5l2 2 3.5-4', checkCircle: 'M12 21a9 9 0 100-18 9 9 0 000 18zM8 12.3l2.7 2.7L16 9.7', question: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.5a2.5 2.5 0 114 2c-.9.6-1.6 1.1-1.6 2.2m0 2.8v.01',
  hourglass: 'M6 3h12M6 21h12M7 3v3.5a5 5 0 002 4l3 1.5 3-1.5a5 5 0 002-4V3M7 21v-3.5a5 5 0 012-4l3-1.5 3 1.5a5 5 0 012 4V21', hand: 'M7 12V6.5a1.5 1.5 0 013 0V11m0-.5v-6a1.5 1.5 0 013 0v6m0-4.5a1.5 1.5 0 013 0V13m0-2.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1.5a6 6 0 01-5-2.7L4 14.5a1.5 1.5 0 012.4-1.7L7 13.5',
  pauseCircle: 'M12 21a9 9 0 100-18 9 9 0 000 18zM10 9v6m4-6v6', info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5m0-8v.01',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6L7 7m10 10l1.4 1.4M5.6 18.4L7 17m10-10l1.4-1.4', moon: 'M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z', device: 'M4 5h16v11H4zM9 20h6M12 16v4',
  users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 11a3 3 0 100-6M17.5 14.2A5.5 5.5 0 0121.5 20', trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6m4-6v6', filter: 'M4 6h16M7 12h10M10 18h4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h3v3h-3zM20 14v.01M20 20v.01M17 20v.01M20 17v.01', globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  starFill: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z', arrowUp: 'M12 19V5m0 0l-6 6m6-6l6 6', arrowDown: 'M12 5v14m0 0l-6-6m6 6l6-6',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z', robot: 'M12 3v3M7 6h10a2 2 0 012 2v8a2 2 0 01-2 2H7a2 2 0 01-2-2V8a2 2 0 012-2zM9 11v2m6-2v2M9 21h6M3 11v3m18-3v3', chart: 'M4 19h16M6 16l4-5 3 3 5-7',
};
export function Icon({ n, className = 'h-5 w-5' }: { n: keyof typeof P | string; className?: string }) {
  return <svg viewBox="0 0 24 24" className={`${className} ${n === 'spin' ? 'spin' : ''}`} fill={n === 'starFill' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card p-[var(--card-padding)] ${className}`}>{children}</section>;
}
export function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><h2 className="t-headline">{children}</h2>{right}</div>;
}
/**
 * Buttons (design system §4): `primary` (one per screen), `soft` (secondary, elev fill), `ghost` (outlined), `quiet` (text),
 * `danger` (destructive). 48 px tall. BUSY keeps the label and adds a spinner WITHOUT changing the button's width: the
 * spinner sits in the space of the leading padding, just before the label.
 */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'soft' | 'quiet'; busy?: boolean; full?: boolean };
export function Btn({ kind = 'primary', busy, full, className = '', children, disabled, ...rest }: BtnProps) {
  const k = { primary: 'bg-primary text-onprimary font-semibold', ghost: 'border border-line text-ink font-medium', danger: 'bg-negative text-[var(--on-negative)] font-semibold', soft: 'bg-elev text-ink font-medium', quiet: 'text-accent font-semibold' }[kind];
  return <button {...rest} disabled={disabled || busy} aria-busy={busy || undefined} className={`btn press inline-flex min-h-12 items-center justify-center rounded-[var(--radius-md)] px-5 text-[0.96875rem] disabled:opacity-45 ${k} ${full ? 'w-full' : ''} ${className}`}>
    <span className="relative inline-flex min-w-0 items-center justify-center gap-2">{busy && <span className="btn-spin" aria-hidden="true"><Icon n="spin" className="h-3.5 w-3.5" /></span>}{children}</span></button>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <label className="block"><span className="t-footnote mb-1.5 block font-medium text-mute">{label}</span>{children}{hint && <span className="t-footnote mt-1.5 block text-mute">{hint}</span>}</label>;
}
export const inputCls = 'w-full rounded-[var(--radius-md)] border border-line bg-elev/60 px-4 py-3.5 outline-none transition placeholder:text-mute/70 focus:border-accent focus:bg-surface focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_16%,transparent)]';

/**
 * Notice / banner (design system §4): tone bar, symbol, sentence, optional action. Levels: info, caution (`warn`), negative
 * (`danger`), and `ok` for a confirmation. The symbol and the words carry the level; the colour only repeats it.
 */
export function Notice({ tone = 'info', children, action, testid }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; action?: ReactNode; testid?: string }) {
  const ic = { info: 'info', warn: 'warn', danger: 'warn', ok: 'check' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'note'} className="notice" data-tone={tone} data-testid={testid}><Icon n={ic} className="notice-icon mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0 flex-1">{children}</div>{action && <div className="shrink-0 self-center">{action}</div>}</div>;
}

/**
 * Status pill of a transfer (design system §3 / §4): symbol + word, the tone's tint with the tone's own text. Driven by the
 * API's `lifecycle`; a row of a server older than `lifecycle` gives `state` and is mapped exactly as the server maps it.
 */
export function StatusPill({ of, testid }: { of: HasLifecycle; testid?: string }) {
  const { locale } = useContext(I18n); const l = lifecycleOf(of);
  return <span className="status-pill" data-lifecycle={l} data-testid={testid ?? 'status-pill'}><Icon n={lifecycleIcon(l)} className="h-3 w-3" />{lifecycleLabel(l, locale)}</span>;
}
/** v9 name: a pill from a stored `state` alone (kept for the screens that only have that) — the same vocabulary as StatusPill. */
export function StatePill({ state }: { state: string }) { return <StatusPill of={{ state }} />; }

export function Addr({ value }: { value: string }) {
  const a = value.slice(0, 6), z = value.slice(-6), m = value.slice(6, -6);
  return <span className="t-mono break-all leading-relaxed"><b className="text-accent">{a}</b><span className="text-ink/75">{m}</span><b className="text-accent">{z}</b></span>;
}
export const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/**
 * Copy a text. NEXT W5: the clipboard API can be missing (insecure context, old WebView) or refuse (permission, document not
 * focused) — the older selection-based copy is tried, and a failure is SAID (the button never claims a copy that did not happen).
 */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* refused: try the older way */ }
  try {
    const el = document.createElement('textarea'); el.value = text; el.setAttribute('readonly', ''); el.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(el); el.select(); const ok = document.execCommand('copy'); el.remove(); return ok;
  } catch { return false; }
}
export function CopyBtn({ text, full, label, small }: { text: string; full?: boolean; /** the button's words when idle (default: « Copier ») */ label?: string; /** a compact button, for a line of a detail list */ small?: boolean }) {
  const t = useT(); const [st, setSt] = useState<'' | 'ok' | 'fail'>('');
  useEffect(() => { if (!st) return; const h = setTimeout(() => setSt(''), st === 'ok' ? 1600 : 4000); return () => clearTimeout(h); }, [st]);
  return <Btn kind="soft" full={full} className={small ? '!min-h-11 !px-3.5 !text-[0.84375rem]' : ''} data-copy={st || 'idle'} onClick={() => { void copyText(text).then((ok) => { setSt(ok ? 'ok' : 'fail'); if (ok) haptic(); }); }}>
    <Icon n={st === 'ok' ? 'check' : st === 'fail' ? 'warn' : 'copy'} className={`h-4 w-4 ${st === 'ok' ? 'pop text-positive' : st === 'fail' ? 'text-caution' : ''}`} /><span aria-live="polite">{st === 'ok' ? t('copied') : st === 'fail' ? t('nxCopyFailed') : label ?? t('copy')}</span></Btn>;
}
/**
 * NEXT (accessibility): arrow keys inside a radio group or a tab list — Left / Up and Right / Down move to the neighbour (and wrap),
 * Home / End go to the ends; the option reached is selected, as a native radio group does. One tab stop per group (`tabIndex`).
 */
export function roveKeys(e: React.KeyboardEvent<HTMLElement>): void {
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!dir && e.key !== 'Home' && e.key !== 'End') return;
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]:not(:disabled),[role=tab]:not(:disabled)')]; if (!all.length) return;
  const at = all.indexOf(document.activeElement as HTMLButtonElement);
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : roveIndex(at, dir, all.length);
  e.preventDefault(); const el = all[to]!; el.focus(); if (to !== at) el.click(); el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
/** the index reached from `at` (−1: nothing focused) by one step in `dir`, wrapping around `n` options */
export const roveIndex = (at: number, dir: number, n: number): number => (at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n);

/** Token logo with its network badge — the real logos (src/icons.tsx). Kept under its historical name: every screen uses it. */
export function Coin({ sym, net, size = 44 }: { sym: string; net?: string; size?: number }) { return <AssetIcon sym={sym} net={net} size={size} />; }
/** A network's logo at text size (historical name: it used to be a coloured dot). */
export function NetDot({ net, size = 16 }: { net: string; size?: number }) { return <NetworkIcon net={net} size={size} />; }
/** Horizontal chip selector (scrolls on small screens). */
export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; net?: string; sym?: string }[]; onChange: (v: T) => void; label: string }) {
  const has = options.some((o) => o.id === value);   // one tab stop: the checked chip, or the first when none is
  return <div role="radiogroup" aria-label={label} onKeyDown={roveKeys} className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5">{options.map((o, k) =>
    <button key={o.id} role="radio" aria-checked={value === o.id} tabIndex={value === o.id || (!has && k === 0) ? 0 : -1} onClick={() => onChange(o.id)}
      className={`press inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border text-[0.875rem] font-medium ${o.net || o.sym ? 'pl-2 pr-4' : 'px-4'} ${value === o.id ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface text-ink'}`}>
      {o.sym ? <AssetIcon sym={o.sym} size={26} /> : o.net && <NetworkIcon net={o.net} size={26} />}{o.label}</button>)}</div>;
}
/** Signed percentage with an arrow icon: direction is never carried by colour alone. */
export function Change({ pct, suffix }: { pct: number; suffix?: string }) {
  const up = pct > -0.005; const { locale } = useContext(I18n); // −0.001 % is not a fall: no "−0,00 %"
  return <span className={`inline-flex items-center gap-1 text-[0.84375rem] font-semibold ${up ? 'text-positive' : 'text-negative'}`}>
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true"><path d={up ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>
    {up ? '+' : '−'}{numFmt(Math.abs(pct), locale, 2, 2)} %{suffix && <span className="font-normal text-mute">{suffix}</span>}</span>;
}
/** An amount of the owner. Hide-balances mode (design system §4): the figure is REPLACED by « •••• » — it is not in the page at all, not merely blurred. */
export function Money({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  const t = useT();
  return hidden ? <span data-hidden-amount="" aria-label={t('nwHiddenAmount')}>••••</span> : <span>{children}</span>;
}
/** A crypto amount for DISPLAY: truncated to `max` decimals (never rounded up), trailing zeros dropped, written in the screen's language (rule: amount.ts). */
export const trimAmt = (s: string, max = 6, locale: AmountLocale = amountLocale()) => {
  const out = formatAmount(s, locale, { maxDecimals: max });
  // NEXT W5: an amount that is not zero never reads "0" — below the last decimal shown it is "< 0.000001" (the truncation rule is unchanged)
  if (max > 0 && !/[1-9]/.test(out) && /^-?\d+\.\d*[1-9]/.test(s)) return `${s.startsWith('-') ? '> −' : '<\u00a0'}${formatAmount(`0.${'0'.repeat(max - 1)}1`, locale)}`;
  return out;
};
/** The EXACT amount of a review screen (what is signed): every digit the server gave, in the screen's language. */
export const exactAmt = (s: string, locale: AmountLocale = amountLocale()) => formatAmount(s, locale, { trim: false });
/** A plain number in the owner's locale (decimal comma in French): percentages, ratios, small USD figures inside sentences. */
export const numFmt = (n: number, locale: string, max = 2, min = 0) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: max, minimumFractionDigits: Math.min(min, max) }).format(n);
export const fiat = (n: number, cur: string, locale: string) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur }).format(n);
/** An agent's allocated capital: a USD figure whatever its cash leg (USDC, a bridged or pegged dollar, 6 or 18 decimals) — « 100,00 $ US » / "US$100.00". */
export const usdCapital = (capital: string | number, locale: string): string => { const n = Number(capital); return Number.isFinite(n) ? fiat(n, 'USD', locale) : '—'; };
export const when = (d: string | Date, locale: string) => new Date(d).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' });
/**
 * A transfer signed on a server that does not broadcast: it will never confirm, and must not read as "sent".
 * v11 (B2): keyed on the proposal's own terminal STATE `not_broadcast` (error code `broadcast_disabled`) — never on the
 * wording of the server's English sentence, which may change or be translated.
 */
export const testNotSent = (p: { state?: string; errorCode?: string | null } | null | undefined): boolean => !!p && (p.state === 'not_broadcast' || p.errorCode === 'broadcast_disabled');
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
    <h1 className="t-title t-title1 min-w-0 flex-1">{children}</h1>{right}</div>;
}
/** Designed empty / error / offline state: icon, one sentence, optional action. */
export function EmptyState({ icon = 'list', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="card flex flex-col items-center px-6 py-10 text-center">
    <span className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-elev text-mute"><Icon n={icon} className="h-6 w-6" /></span>
    <p className="t-headline">{title}</p>{children && <p className="t-callout mt-1.5 max-w-[36ch] text-mute">{children}</p>}{action && <div className="mt-5">{action}</div>}</div>;
}
/** Segmented control — THE one of the app: ranges, filters, language, appearance. Arrow keys move and select (roveKeys). */
export function Seg<T extends string>({ value, options, onChange, label, role = 'radiogroup', testid, compact }: { value: T; options: readonly (readonly [T, string, string?])[]; onChange: (v: T) => void; label?: string; role?: 'radiogroup' | 'tablist'; testid?: string; /** 36 px segments (a range selector above a chart) */ compact?: boolean }) {
  const tab = role === 'tablist', has = options.some(([v]) => v === value);
  return <div className="seg bg-elev" role={role} aria-label={label} data-testid={testid} onKeyDown={roveKeys}>{options.map(([v, l, aria], k) =>
    <button key={v} role={tab ? 'tab' : 'radio'} {...(tab ? { 'aria-selected': value === v } : { 'aria-checked': value === v })} aria-label={aria} data-value={v} tabIndex={value === v || (!has && k === 0) ? 0 : -1} onClick={() => { if (value !== v) { haptic(); onChange(v); } }}
      className={`seg-item ${compact ? 'seg-compact' : ''} ${value === v ? 'bg-surface font-semibold text-ink' : 'text-mute'}`}>{l}</button>)}</div>;
}
/** Switch — THE one of the app. 44 px target; the state is `aria-checked`, the knob's position only repeats it. */
export function Toggle({ on, onChange, label, disabled, testid }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testid?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} data-testid={testid} onClick={() => { haptic(); onChange(!on); }} className="toggle"><span className="toggle-track"><span className="toggle-knob" /></span></button>;
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
const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])';
/** what Tab can reach inside `el`, in order (hidden elements and those of a closed <details> left out) */
export const focusables = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);
/**
 * Focus trap: where Tab must go instead of leaving the dialog — the first element after the last one, the last before the first,
 * and back inside when the focus is outside. `null`: the browser's own move stays inside, nothing to do. Pure (tested).
 */
export function trapTarget<T>(list: readonly T[], active: unknown, back: boolean, panel: T): T | null {
  if (list.length === 0) return active === panel ? null : panel;
  const at = list.indexOf(active as T), first = list[0]!, last = list[list.length - 1]!;
  if (at < 0) return back ? last : first;   // on the panel itself, or outside: back inside
  if (back && at === 0) return last;
  if (!back && at === list.length - 1) return first;
  return null;
}
/** Make everything that is not on the path from <body> to `el` inert; returns the elements changed (to be restored). */
export function inertOutside(el: HTMLElement | null): HTMLElement[] {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node && node !== document.body && node.parentElement; node = node.parentElement)
    for (const sib of node.parentElement.children) if (sib !== node && sib instanceof HTMLElement && !sib.inert && sib.tagName !== 'SCRIPT' && sib.tagName !== 'STYLE') { sib.inert = true; changed.push(sib); }
  return changed;
}
/**
 * Bottom sheet: scrim, spring, grabber, drag down to dismiss (touch), Escape, keyboard-safe height.
 * `dismissable={false}` for approval sheets: they close only through their own buttons.
 * v10: `sub` (one line under the title), `footer` (the sheet's action, kept in reach under the scrolling body), `testid`
 * (on the dialog), `busy` (nothing dismisses a sheet while its request is in flight). Keyboard-safe: when the on-screen
 * keyboard covers the bottom of the layout viewport (iOS does not resize it), the panel is lifted by exactly that much,
 * so the focused field and the footer stay visible. The sheet is `position: fixed` at z-30, above the tab bar (z-10).
 */
export function Sheet({ title, onClose, children, dismissable = true, wide, sub, footer, testid, busy }: { title: string; onClose: () => void; children: ReactNode; dismissable?: boolean; wide?: boolean; sub?: ReactNode; footer?: ReactNode; testid?: string; busy?: boolean }) {
  const t = useT(); const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null); const drag = useRef<{ y: number; dy: number } | null>(null);
  const can = dismissable && !busy, close = useRef(onClose); close.current = onClose; const canRef = useRef(can); canRef.current = can;
  // NEXT (accessibility): a modal for real — focus goes into the sheet and comes BACK to what opened it; Tab stays inside (focus
  // trap); everything behind is `inert` (not focusable, not read, not clickable); Escape closes when the sheet may be dismissed.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      // only the sheet on top has the keyboard: one opened from this one (in its subtree or in a portal after it) answers instead
      const open = document.querySelectorAll('[role=dialog][aria-modal=true]'); if (open[open.length - 1] !== root.current) return;
      if (e.key === 'Escape' && canRef.current) { close.current(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const next = trapTarget(focusables(panel.current), document.activeElement, e.shiftKey, panel.current);
      if (next) { e.preventDefault(); next.focus(); }
    };
    addEventListener('keydown', key);
    const hidden = inertOutside(root.current);
    return () => { removeEventListener('keydown', key); for (const el of hidden) el.inert = false; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const f = () => { const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)); if (root.current) root.current.style.paddingBottom = kb > 40 ? `${kb}px` : ''; };
    f(); vv.addEventListener('resize', f); vv.addEventListener('scroll', f);
    return () => { vv.removeEventListener('resize', f); vv.removeEventListener('scroll', f); };
  }, []);
  const end = () => { const el = panel.current, d = drag.current; drag.current = null; if (!el || !d) return; el.classList.remove('sheet-dragging'); if (d.dy > 110) { haptic(); onClose(); } else el.style.transform = ''; };
  return <div ref={root} className="fixed inset-0 z-30 flex items-end justify-center lg:items-center" role="dialog" aria-modal="true" aria-label={title} data-testid={testid} onClick={(e) => { if (can && e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} tabIndex={-1} className={`safe-b flex w-full flex-col overflow-hidden rounded-t-[var(--radius-xl)] bg-surface outline-none transition-transform duration-300 lg:rounded-[var(--radius-xl)] ${wide ? 'lg:max-w-2xl' : 'lg:max-w-md'}`}>
      <div className="shrink-0 touch-none px-5 pb-2 pt-6 lg:pt-5"
        onPointerDown={(e) => { if (!can || e.pointerType === 'mouse' || (e.target as Element).closest('button')) return; drag.current = { y: e.clientY, dy: 0 }; panel.current?.classList.add('sheet-dragging'); e.currentTarget.setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d || !panel.current) return; d.dy = Math.max(0, e.clientY - d.y); panel.current.style.transform = `translateY(${d.dy}px)`; }}
        onPointerUp={end} onPointerCancel={end}>
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="t-title2">{title}</h2>{sub && <div className="sheet-sub">{sub}</div>}</div>
          {dismissable && <button onClick={() => { if (can) onClose(); }} disabled={busy} aria-label={t('cancel')} className="press -mt-1.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-mute disabled:opacity-40"><Icon n="x" /></button>}</div></div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
      {footer && <div className="sheet-foot">{footer}</div>}
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

// ── v10 design pass: pieces shared by Swap, plans, agents, Futures, Alerts, Monitor, Research ────────────────────────────
export type Tone = 'mute' | 'ok' | 'info' | 'warn' | 'danger';
/** A small state pill: icon + word (never colour alone). */
export function Tag({ tone = 'mute', icon, children, testid }: { tone?: Tone; icon?: string; children: ReactNode; testid?: string }) {
  return <span className="tag" data-tone={tone} data-testid={testid}>{icon && <Icon n={icon} className="h-3 w-3" />}{children}</span>;
}
/** A figure with its label, in a quiet tile. `value` is shown whole (it wraps); tone colours the value only with its sign/word present. */
export function Stat({ label, value, sub, tone, testid }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'danger' | 'warn'; testid?: string }) {
  return <div className="stat" data-testid={testid}><span className="stat-label">{label}</span><span className={`stat-value ${tone === 'ok' ? 'text-emerald' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</span>{sub != null && sub !== false && <span className="stat-sub">{sub}</span>}</div>;
}
export function StatGrid({ children, cols = 2, className = '' }: { children: ReactNode; cols?: 2 | 3 | 4; className?: string }) {
  return <div className={`grid gap-2.5 ${cols === 4 ? 'grid-cols-2 lg:grid-cols-4' : cols === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'} ${className}`}>{children}</div>;
}
/** One line of a receipt or of a detail list — wrap several in <dl className="receipt"> (dashed) or a plain <dl>. The value is never truncated. */
export function Fact({ k, children, mono, testid, stack }: { k: ReactNode; children: ReactNode; mono?: boolean; testid?: string; /** label above, the whole value below (addresses, hashes, long values) */ stack?: boolean }) {
  return <div className={`fact ${stack ? 'fact-stack' : ''}`} data-testid={testid}><dt>{k}</dt><dd className={mono ? 't-mono' : ''}>{children}</dd></div>;
}
/** Stat tile (design system §4): eyebrow label · headline value · footnote context. The value is whole (it wraps). */
export function StatTile({ label, value, note, tone, testid }: { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: 'positive' | 'negative' | 'caution'; testid?: string }) {
  const tc = tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : tone === 'caution' ? 'text-caution' : '';
  return <div className="stat-tile" data-testid={testid}><span className="t-eyebrow block">{label}</span><span className={`t-headline amt mt-1 block ${tc}`}>{value}</span>{note != null && note !== false && <span className="t-footnote mt-0.5 block text-mute">{note}</span>}</div>;
}
/** A titled group inside a page: eyebrow label, optional trailing control. */
export function Section({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={className}><div className="mb-2 flex min-h-6 items-center justify-between gap-3 px-1"><h2 className="t-eyebrow">{title}</h2>{right}</div>{children}</section>;
}
export type StepState = 'done' | 'current' | 'next' | 'failed';
const STEP_ICON: Record<StepState, string> = { done: 'check', current: 'clock', next: 'minus', failed: 'x' };
/**
 * Timeline (legs of a plan, steps of a flow). Each item says its state with an icon and — through `stateLabel` — a word; the
 * rail and the colours only repeat it. `node` replaces the state icon (a network logo, a step number).
 */
export function Timeline({ items, label }: { items: { key: string; state: StepState; title: ReactNode; stateLabel?: ReactNode; node?: ReactNode; children?: ReactNode; testid?: string }[]; label?: string }) {
  return <ol className="tl" aria-label={label}>{items.map((it) => <li key={it.key} className="tl-item" data-state={it.state} data-testid={it.testid} aria-current={it.state === 'current' ? 'step' : undefined}>
    <span className="tl-node" aria-hidden="true">{it.node ?? <Icon n={STEP_ICON[it.state]} className="h-[18px] w-[18px]" />}</span>
    <div className="tl-body"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="t-body-strong leading-snug">{it.title}</span>
      {it.stateLabel && <Tag tone={it.state === 'done' ? 'ok' : it.state === 'current' ? 'info' : it.state === 'failed' ? 'danger' : 'mute'} icon={STEP_ICON[it.state]}>{it.stateLabel}</Tag>}</div>
      {it.children && <div className="mt-1.5 space-y-1.5 text-[0.84375rem] leading-snug text-mute">{it.children}</div>}</div></li>)}</ol>;
}
/** "3 / 4" as a ring: the count is written in it; `label` is the accessible sentence. */
export function ProgressRing({ done, total, size = 52, label }: { done: number; total: number; size?: number; label?: string }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r, k = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  return <span className="pring" style={{ width: size, height: size }} role="img" aria-label={label ?? `${done} / ${total}`} data-done={done} data-total={total}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true"><circle className="pring-track" cx={size / 2} cy={size / 2} r={r} /><circle className="pring-bar" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - k)} /></svg>
    <span className="pring-text" aria-hidden="true">{done}/{total}</span></span>;
}
/** Disclosure for what is secondary but must stay reachable (comparison-only routes, technical details). Never use it for a fee, a minimum or a warning. */
export function Fold({ summary, children, open, testid, className = '' }: { summary: ReactNode; children: ReactNode; open?: boolean; testid?: string; className?: string }) {
  return <details className={`fold ${className}`} open={open} data-testid={testid}><summary>{summary}</summary><div className="pb-1 pt-1">{children}</div></details>;
}
/** A request failed or the device is offline: say it, say that nothing was sent when that is true, offer to retry. */
export function ErrorState({ title, children, onRetry, offline }: { title: string; children?: ReactNode; onRetry?: () => void; offline?: boolean }) {
  const t = useT();
  return <EmptyState icon={offline ? 'cloudOff' : 'warn'} title={title} action={onRetry && <Btn kind="soft" onClick={onRetry}><Icon n="refresh" className="h-4 w-4" />{t('retry')}</Btn>}>{children}</EmptyState>;
}
/** Skeleton of a card with a title line and `lines` text lines — for cards that are not lists. */
export function SkeletonCard({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return <div className={`card space-y-3 p-5 ${className}`} aria-hidden="true"><div className="skel h-4 w-32 !rounded-md" />{Array.from({ length: lines }, (_, k) => <div key={k} className="skel h-3.5 !rounded-md" style={{ width: `${[92, 78, 64, 85][k % 4]}%` }} />)}</div>;
}
/** Skeleton of a row of stat tiles. */
export function SkeletonStats({ n = 4 }: { n?: number }) {
  return <div className="grid grid-cols-2 gap-2.5" aria-hidden="true">{Array.from({ length: n }, (_, k) => <div key={k} className="skel h-[62px] !rounded-2xl" />)}</div>;
}

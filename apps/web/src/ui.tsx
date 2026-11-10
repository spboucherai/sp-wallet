import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { stateKey, useT } from './i18n';

const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z', down: 'M12 4v13m0 0l-5-5m5 5l5-5M5 21h14', up: 'M12 20V7m0 0l-5 5m5-5l5 5M5 3h14',
  list: 'M4 6h16M4 12h16M4 18h10', shield: 'M12 3l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zm8-3l2-1-2-4-2 1a7 7 0 00-2-1l-.5-2h-4L11 7a7 7 0 00-2 1L7 7 5 11l2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1l.5 2h4l.5-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z', eyeOff: 'M3 3l18 18M10.6 6.2A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.5 7.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004-.9',
  check: 'M5 12.5l4.5 4.5L19 7.5', x: 'M6 6l12 12M18 6L6 18', warn: 'M12 3l10 18H2zM12 10v5m0 3v.01', copy: 'M9 9h10v11H9zM5 15V4h10', ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  key: 'M15 7a4 4 0 11-3.9 5H8v3H5v3H2v-3l7.2-7.2A4 4 0 0115 7z', clock: 'M12 7v5l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z', stop: 'M8 3h8l5 5v8l-5 5H8l-5-5V8zM9 9l6 6m0-6l-6 6',
  chev: 'M9 6l6 6-6 6', book: 'M5 4h13v16H5zM9 4v16M12 9h3', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3', spin: 'M12 3a9 9 0 109 9',
};
export function Icon({ n, className = 'h-5 w-5' }: { n: keyof typeof P | string; className?: string }) {
  return <svg viewBox="0 0 24 24" className={`${className} ${n === 'spin' ? 'spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>{children}</section>;
}
export function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="mb-3 flex items-center justify-between"><h2 className="text-[13px] font-semibold uppercase tracking-wider text-mute">{children}</h2>{right}</div>;
}
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'soft'; busy?: boolean; full?: boolean };
export function Btn({ kind = 'primary', busy, full, className = '', children, disabled, ...rest }: BtnProps) {
  const k = { primary: 'bg-emerald text-[#04130d] font-semibold', ghost: 'border border-line text-ink', danger: 'bg-danger text-[#1c0508] font-semibold', soft: 'bg-elev text-ink' }[kind];
  return <button {...rest} disabled={disabled || busy} className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-[15px] transition active:scale-[0.98] disabled:opacity-45 ${k} ${full ? 'w-full' : ''} ${className}`}>
    {busy && <Icon n="spin" className="h-4 w-4" />}{children}</button>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[13px] text-mute">{label}</span>{children}{hint && <span className="mt-1.5 block text-xs text-mute">{hint}</span>}</label>;
}
export const inputCls = 'w-full rounded-xl border border-line bg-bg px-3.5 py-3 outline-none focus:border-blue';

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const c = { info: 'border-blue/40 bg-blue/10', warn: 'border-warn/50 bg-warn/10', danger: 'border-danger/60 bg-danger/10', ok: 'border-emerald/40 bg-emerald/10' }[tone];
  const ic = { info: 'shield', warn: 'warn', danger: 'warn', ok: 'check' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'note'} className={`flex gap-2.5 rounded-xl border p-3 text-[13.5px] leading-snug ${c}`}><Icon n={ic} className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0">{children}</div></div>;
}

const TONE: Record<string, [string, string]> = {
  finalized: ['text-emerald border-emerald/40', 'check'], confirming: ['text-blue border-blue/40', 'clock'], broadcast: ['text-blue border-blue/40', 'up'],
  signed: ['text-blue border-blue/40', 'key'], approved: ['text-blue border-blue/40', 'key'], pending_approval: ['text-warn border-warn/50', 'clock'], draft: ['text-mute border-line', 'list'],
  failed: ['text-danger border-danger/50', 'x'], rejected: ['text-danger border-danger/50', 'x'], expired: ['text-mute border-line', 'clock'], replaced: ['text-warn border-warn/50', 'warn'], reorged: ['text-warn border-warn/50', 'warn'],
};
/** Status is always icon + text, never colour alone. */
export function StatePill({ state }: { state: string }) {
  const t = useT(); const [cls, ic] = TONE[state] ?? TONE.draft!;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${cls}`}><Icon n={ic} className="h-3 w-3" />{t(stateKey(state))}</span>;
}

export function Addr({ value }: { value: string }) {
  const a = value.slice(0, 6), z = value.slice(-6), m = value.slice(6, -6);
  return <span className="break-all font-mono text-[13.5px] leading-relaxed"><b className="text-emerald">{a}</b><span className="text-ink/80">{m}</span><b className="text-emerald">{z}</b></span>;
}
export const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

export function CopyBtn({ text, full }: { text: string; full?: boolean }) {
  const t = useT(); const [ok, setOk] = useState(false);
  useEffect(() => { if (!ok) return; const h = setTimeout(() => setOk(false), 1600); return () => clearTimeout(h); }, [ok]);
  return <Btn kind="soft" full={full} onClick={() => { void navigator.clipboard.writeText(text).then(() => setOk(true)); }}><Icon n={ok ? 'check' : 'copy'} className="h-4 w-4" />{ok ? t('copied') : t('copy')}</Btn>;
}

const COIN: Record<string, string> = { USDC: '#2775CA', ETH: '#627EEA', BTC: '#F7931A', SOL: '#9945FF', POL: '#8247E5' };
export function Coin({ sym }: { sym: string }) {
  return <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: COIN[sym] ?? '#445' }} aria-hidden="true">{sym.slice(0, 4)}</span>;
}
export function Money({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return <span className={hidden ? 'mask' : ''} aria-hidden={hidden || undefined}>{children}</span>;
}
export const trimAmt = (s: string, max = 6) => { const [i, f = ''] = s.split('.'); const ff = f.slice(0, max).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i!; };
export const fiat = (n: number, cur: string, locale: string) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur }).format(n);
export const when = (d: string | Date, locale: string) => new Date(d).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' });
export function Skeleton({ h = 'h-16' }: { h?: string }) { return <div className={`animate-pulse rounded-2xl bg-surface ${h}`} />; }

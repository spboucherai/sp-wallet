import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { stateKey, useT } from './i18n';

const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z', down: 'M12 4v13m0 0l-5-5m5 5l5-5M5 21h14', up: 'M12 20V7m0 0l-5 5m5-5l5 5M5 3h14',
  list: 'M4 6h16M4 12h16M4 18h10', shield: 'M12 3l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zm8-3l2-1-2-4-2 1a7 7 0 00-2-1l-.5-2h-4L11 7a7 7 0 00-2 1L7 7 5 11l2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1l.5 2h4l.5-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z', eyeOff: 'M3 3l18 18M10.6 6.2A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.5 7.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004-.9',
  check: 'M5 12.5l4.5 4.5L19 7.5', x: 'M6 6l12 12M18 6L6 18', warn: 'M12 3l10 18H2zM12 10v5m0 3v.01', copy: 'M9 9h10v11H9zM5 15V4h10', ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  key: 'M15 7a4 4 0 11-3.9 5H8v3H5v3H2v-3l7.2-7.2A4 4 0 0115 7z', clock: 'M12 7v5l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z', stop: 'M8 3h8l5 5v8l-5 5H8l-5-5V8zM9 9l6 6m0-6l-6 6',
  chev: 'M9 6l6 6-6 6', swap: 'M7 8h11l-3-3M17 16H6l3 3', book: 'M5 4h13v16H5zM9 4v16M12 9h3', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3', spin: 'M12 3a9 9 0 109 9',
};
export function Icon({ n, className = 'h-5 w-5' }: { n: keyof typeof P | string; className?: string }) {
  return <svg viewBox="0 0 24 24" className={`${className} ${n === 'spin' ? 'spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card p-5 ${className}`}>{children}</section>;
}
export function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="mb-3 flex items-center justify-between"><h2 className="text-[17px] font-semibold tracking-tight">{children}</h2>{right}</div>;
}
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'soft'; busy?: boolean; full?: boolean };
export function Btn({ kind = 'primary', busy, full, className = '', children, disabled, ...rest }: BtnProps) {
  const k = { primary: 'bg-primary text-onprimary font-semibold', ghost: 'border border-line text-ink', danger: 'bg-danger text-white font-semibold', soft: 'bg-elev text-ink font-medium' }[kind];
  return <button {...rest} disabled={disabled || busy} className={`inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl px-5 text-[15.5px] transition active:scale-[0.98] disabled:opacity-45 ${k} ${full ? 'w-full' : ''} ${className}`}>
    {busy && <Icon n="spin" className="h-4 w-4" />}{children}</button>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[13px] text-mute">{label}</span>{children}{hint && <span className="mt-1.5 block text-xs text-mute">{hint}</span>}</label>;
}
export const inputCls = 'w-full rounded-2xl border border-line bg-elev/60 px-4 py-3.5 outline-none transition focus:border-blue focus:bg-surface';

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const c = { info: 'border-blue/25 bg-blue/8', warn: 'border-warn/30 bg-warn/10', danger: 'border-danger/40 bg-danger/10', ok: 'border-emerald/30 bg-emerald/8' }[tone];
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
  return <Btn kind="soft" full={full} onClick={() => { void navigator.clipboard.writeText(text).then(() => setOk(true)); }}><Icon n={ok ? 'check' : 'copy'} className="h-4 w-4" />{ok ? t('copied') : t('copy')}</Btn>;
}

const COIN: Record<string, [string, string]> = {
  USDC: ['#2775CA', 'M12 6.2v1.5m0 8.6v1.5M14.6 9.6c-.3-1-1.3-1.6-2.6-1.6-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.7.8 2.7 2-1.2 2-2.7 2c-1.4 0-2.4-.7-2.7-1.7'],
  ETH: ['#627EEA', 'M12 4.5l4.6 7.6L12 14.8l-4.6-2.7zM7.4 13.4L12 19.5l4.6-6.1L12 16.1z'],
  BTC: ['#F7931A', 'M9.5 7h3.7a2.2 2.2 0 010 4.5H9.5zm0 4.5h4.2a2.3 2.3 0 010 4.7H9.5zM9.5 7v9.2M11 5.5V7m2-1.5V7m-2 9.2v1.5m2-1.5v1.5'],
  SOL: ['#9945FF', 'M7.6 8h9.6l-1.7 1.9H5.9zM7.6 16h9.6l-1.7-1.9H5.9zM16.4 11.05H6.8l1.7 1.9h9.6z'],
  BNB: ['#F0B90B', 'M12 5.5l2.2 2.2L12 9.9 9.8 7.7zM7.2 10.3l2.2 2.2-2.2 2.2L5 12.5zM16.8 10.3l2.2 2.2-2.2 2.2-2.2-2.2zM12 15.1l2.2 2.2L12 19.5l-2.2-2.2zM12 10.3l2.2 2.2L12 14.7l-2.2-2.2z'],
  AVAX: ['#E84142', 'M12 5.5L5.5 17h4l2.5-4.5L14.5 17h4z'],
  USDT: ['#26A17B', 'M7.5 7.5h9M12 7.5V18M7 11.5c0 .8 2.2 1.5 5 1.5s5-.7 5-1.5'],
  DAI: ['#F5AC37', 'M8 6.5h4.5a5.5 5.5 0 010 11H8zM6 10.5h12M6 13.5h12'],
  LINK: ['#2A5ADA', 'M12 5l6 3.5v7L12 19l-6-3.5v-7z'],
  WBTC: ['#201A2D', 'M9.5 7h3.7a2.2 2.2 0 010 4.5H9.5zm0 4.5h4.2a2.3 2.3 0 010 4.7H9.5zM9.5 7v9.2M11 5.5V7m2-1.5V7m-2 9.2v1.5m2-1.5v1.5'],
  WETH: ['#3C3C3D', 'M12 4.5l4.6 7.6L12 14.8l-4.6-2.7zM7.4 13.4L12 19.5l4.6-6.1L12 16.1z'],
  POL: ['#8247E5', 'M9 9.2l-2.5 1.4v2.8L9 14.8l2.5-1.4V9.2L15 7.8l2.5 1.4V12L15 13.4l-1-.6'],
};
const NETC: Record<string, string> = { ethereum: '#627EEA', base: '#0052FF', arbitrum: '#28A0F0', polygon: '#8247E5', optimism: '#FF0420', bsc: '#F0B90B', avalanche: '#E84142', hyperevm: '#50D2C1', bitcoin: '#F7931A', solana: '#14F195',
  litecoin: '#345D9D', dogecoin: '#C2A633', bitcoincash: '#0AC18E', tron: '#EB0029', xrpl: '#23292F', stellar: '#7D00FF', sui: '#4DA2FF', aptos: '#06B6A6', ton: '#0098EA', near: '#00C08B', cosmos: '#2E3148', cardano: '#0033AD', polkadot: '#E6007A' };
/** Token mark with an optional network badge. Original simplified glyphs, not vendor logos. */
export function Coin({ sym, net, size = 44 }: { sym: string; net?: string; size?: number }) {
  const known = COIN[sym];
  let hue = 0; for (const ch of sym) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const [bg, d] = known ?? [`hsl(${hue} 55% 42%)`, ''];
  return <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
    <span className="grid h-full w-full place-items-center rounded-full" style={{ background: bg }}>
      {known ? <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
        : <span className="font-bold leading-none text-white" style={{ fontSize: Math.max(9, size * (sym.length > 4 ? 0.22 : sym.length > 3 ? 0.26 : 0.3)) }}>{sym.slice(0, 5)}</span>}</span>
    {net && <span className="absolute -bottom-0.5 -right-0.5 h-[15px] w-[15px] rounded-full border-2 border-surface" style={{ background: NETC[net] ?? '#667085' }} />}
  </span>;
}
export function NetDot({ net }: { net: string }) { return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: NETC[net] ?? '#667085' }} aria-hidden="true" />; }
/** Horizontal chip selector (scrolls on small screens). */
export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; net?: string }[]; onChange: (v: T) => void; label: string }) {
  return <div role="radiogroup" aria-label={label} className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5">{options.map((o) =>
    <button key={o.id} role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
      className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[14px] font-medium transition ${value === o.id ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface text-ink'}`}>
      {o.net && <NetDot net={o.net} />}{o.label}</button>)}</div>;
}
/** Signed percentage with an arrow icon: direction is never carried by colour alone. */
export function Change({ pct, suffix }: { pct: number; suffix?: string }) {
  const up = pct >= 0;
  return <span className={`inline-flex items-center gap-1 text-[13.5px] font-semibold ${up ? 'text-emerald' : 'text-danger'}`}>
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true"><path d={up ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>
    {up ? '+' : '−'}{Math.abs(pct).toFixed(2)} %{suffix && <span className="font-normal text-mute">{suffix}</span>}</span>;
}
export function Money({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return <span className={hidden ? 'mask' : ''} aria-hidden={hidden || undefined}>{children}</span>;
}
export const trimAmt = (s: string, max = 6) => { const [i, f = ''] = s.split('.'); const ff = f.slice(0, max).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i!; };
export const fiat = (n: number, cur: string, locale: string) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur }).format(n);
export const when = (d: string | Date, locale: string) => new Date(d).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' });
export function Skeleton({ h = 'h-16' }: { h?: string }) { return <div className={`animate-pulse rounded-[22px] bg-elev ${h}`} />; }

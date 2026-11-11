/**
 * Small pieces shared by the live screens. The most important one is the MODE BAND: which money the selected account moves is
 * written in words, with its own icon and its own pattern, on a band that is always on screen and cannot be dismissed —
 * « SIMULATION », « TESTNET — argent fictif », « RÉEL — argent réel ». Colour only repeats what the words say.
 *
 * v10: the band's look lives in styles.css (`.mode-band`, `.mode-tag`): SIMULATION is a dashed blue outline over a dotted
 * ground, TESTNET crisp violet stripes, RÉEL a solid deep red with a hazard edge. The colours of TESTNET and RÉEL are fixed
 * (not theme variables): they read the same in the light and the dark theme, white text ≥ 4.5 : 1 (scripts/contrast.mjs).
 * `LiveSheet` is the sheet of every live / GMX flow: the shared `Sheet` under <body>, with the mode tag in its title area.
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { I18n, useT, type Key } from '../i18n';
import { AssetIcon, Fact, Icon, Notice, Sheet, VenueIcon, type StepState } from '../ui';
import { RISK_CODES } from './api';
import { fmt, priceDp } from './dec';
import { clock, inFlight, remainingMs, type LiveErr, type LiveOrder, type LiveState, type Tone, type VenueOrder } from './live';
import type { Instrument } from './types';

// each tone has its own icon; its pattern and its colours are in styles.css (`.mode-band[data-tone]`, `.mode-tag[data-tone]`)
const BAND_ICON: Record<Tone, string> = { paper: 'eye', testnet: 'book', mainnet: 'warn' };
export const toneWord = (tone: Tone): Key => (tone === 'paper' ? 'flToneSim' : tone === 'testnet' ? 'flToneTestnet' : 'flToneReal');

/** always visible, never dismissible: there is no close control on purpose */
export function ModeBand({ tone, label, compact, className = '' }: { tone: Tone; label?: string; /** one line: the words and the account, without the sentence (the terminal's sticky band) */ compact?: boolean; className?: string }) {
  const t = useT();
  return <div role="status" data-testid="mode-band" data-tone={tone} className={`mode-band ${className}`}>
    <div className="flex min-h-6 items-center gap-2.5"><span className="mode-band-icon" aria-hidden="true"><Icon n={BAND_ICON[tone]} className="h-4 w-4" /></span><span className="shrink-0 whitespace-nowrap text-[13.5px] font-extrabold uppercase tracking-[0.07em]">{t(toneWord(tone))}</span>
      {label ? <span className="min-w-0 flex-1 truncate text-right text-[12.5px] font-semibold">{label}</span> : null}</div>
    {!compact && <p className="mt-1 text-[12.5px] font-medium leading-snug">{t(tone === 'paper' ? 'flBandSim' : tone === 'testnet' ? 'flBandTestnet' : 'flBandReal')}</p>}</div>;
}
/** the same statement as a tag, beside a title or inside a sheet */
export function ModeTag({ tone, className = '' }: { tone: Tone; className?: string }) {
  const t = useT();
  return <span data-testid="mode-tag" data-tone={tone} className={`mode-tag ${className}`}><Icon n={BAND_ICON[tone]} className="h-3 w-3" />{t(toneWord(tone))}</span>;
}
const SRC_ICON = { venue: 'check', local: 'clock', estimate: 'chart' } as const;
/** where a figure comes from: the venue itself, the wallet's own record, or an estimate — a word, with its icon */
export function SourceTag({ source = 'venue' }: { source?: 'venue' | 'local' | 'estimate' }) {
  const t = useT();
  return <span className="src-tag" data-source={source} title={t(source === 'venue' ? 'flSrcVenueTitle' : source === 'local' ? 'flSrcLocalTitle' : 'flSrcEstimateTitle')}><Icon n={SRC_ICON[source]} className="h-2.5 w-2.5" />{t(source === 'venue' ? 'flSrcVenue' : source === 'local' ? 'flSrcLocal' : 'estimate')}</span>;
}

/**
 * The sheet of the live and GMX flows: the shared `Sheet` (grabber, spring, keyboard-safe), rendered under <body> so that no
 * ancestor can trap it, with the mode tag in the title area. It closes exactly as these sheets always did — the close button,
 * Escape, the backdrop, and never while `busy`; the second click of a double click on the button that opened it lands on the
 * backdrop and must not close it (500 ms). The page behind does not scroll; focus returns to where it was.
 */
export function LiveSheet({ title, tone, label, onClose, busy, wide, children }: { title: string; /** which money: shown as a tag under the title */ tone?: Tone; /** the account's name, beside the tag */ label?: string; onClose: () => void; busy?: boolean; wide?: boolean; children: ReactNode }) {
  const openedAt = useRef(Date.now());
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null, o = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = o; prev?.focus?.(); };
  }, []);
  return createPortal(<div className="live-sheet"><Sheet title={title} wide={wide} busy={busy} onClose={() => { if (Date.now() - openedAt.current > 500) onClose(); }}
    sub={tone ? <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><ModeTag tone={tone} />{label ? <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{label}</span> : null}</span> : undefined}>{children}</Sheet></div>, document.body);
}
/** an eyebrow-titled group inside a sheet or a panel (h3: the sheet's own title is the h2) */
export function Group({ title, right, children, className = '', label }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return <section className={className} aria-label={label}><div className="mb-1.5 flex min-h-6 items-center justify-between gap-3 px-0.5"><h3 className="t-eyebrow min-w-0">{title}</h3>{right}</div>{children}</section>;
}
/** the plate of a receipt: quiet ground, dashed rows inside (`<dl className="receipt">` + `Fact`) */
export const TICKET = 'rounded-[18px] bg-elev/60 px-4 py-1.5';
/** the server's own words, a code, a hash: small, monospaced, wrapped — never cut */
export const WORDS = 'block break-words font-mono text-[11.5px] leading-snug text-mute';
/** the fingerprint the passkey commits to */
export function Fingerprint({ children, testid }: { children: ReactNode; testid?: string }) {
  return <p className="flex items-start gap-1.5 break-all font-mono text-[10.5px] leading-snug text-mute" data-testid={testid}><Icon n="lock" className="mt-px h-3 w-3 shrink-0" /><span className="min-w-0">{children}</span></p>;
}
/** "waiting…" line with a spinner */
export function Waiting({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`flex items-center gap-2.5 text-[13.5px] text-mute ${className}`}><Icon n="spin" className="h-4 w-4 shrink-0" />{children}</p>;
}
/** a compact horizontal stepper for lists: each step has its icon and its name; the rail only repeats the state */
export function StepBar({ items, label }: { items: { key: string; state: StepState; title: ReactNode }[]; label: string }) {
  return <ol className="stepbar" aria-label={label} style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>{items.map((it) => <li key={it.key} data-state={it.state} aria-current={it.state === 'current' ? 'step' : undefined}>
    <span className="stepbar-rail" /><span className="stepbar-name"><Icon n={it.state === 'done' ? 'check' : it.state === 'current' ? 'clock' : it.state === 'failed' ? 'x' : 'minus'} className="mt-px h-3 w-3 shrink-0" /><span className="min-w-0">{it.title}</span></span></li>)}</ol>;
}

/** our sentence for the code, then the server's own words */
export function LiveErrNotice({ err, tone = 'danger', children }: { err: LiveErr; tone?: 'danger' | 'warn'; children?: ReactNode }) {
  const t = useT();
  const risk = RISK_CODES.has(err.code) && err.status === 422 && err.key === 'other';
  const text = risk ? t(`rk_${err.code}` as Key) : t(`flE_${err.key}` as Key);
  return <Notice tone={tone}><div data-testid="live-error" data-code={err.code}>
    {risk && <b className="font-semibold">{t('fxRefused')} </b>}{text}
    {err.detail && <span className={`mt-1.5 ${WORDS}`}>{err.code}{err.status ? ` (${err.status})` : ''} — {err.detail}</span>}{children}</div></Notice>;
}

const ST_ICON: Record<string, string> = { open: 'check', filled: 'check', partially_filled: 'warn', rejected: 'x', cancelled: 'x', unknown: 'clock', submitted: 'clock', signed: 'clock', authorized: 'clock', risk_checked: 'key', proposed: 'key' };
const ST_TONE: Record<string, string> = { open: 'ok', filled: 'ok', partially_filled: 'warn', rejected: 'danger', cancelled: 'mute', unknown: 'warn' };
/** a live order's state: icon + word, never colour alone */
export function LiveStatePill({ state }: { state: LiveState }) {
  const t = useT();
  return <span data-state={state} className="tag" data-tone={ST_TONE[state] ?? (inFlight(state) ? 'warn' : 'info')}><Icon n={ST_ICON[state] ?? 'clock'} className="h-3 w-3" />{t(`flSt_${state}` as Key)}</span>;
}
/** what happened to an order, in one sentence, from the server's state */
export function OrderOutcome({ order, instrument }: { order: LiveOrder; instrument?: Instrument }) {
  const t = useT(); const { locale } = useContext(I18n);
  const base = instrument?.base ?? order.instrument.slice(order.instrument.indexOf(':') + 1);
  const px = (v: string | null) => (v ? fmt(v, { dp: priceDp(instrument?.tickSize, v), locale }) : '—'), sz = (v: string) => fmt(v, { locale, trim: true });
  const tone = order.state === 'rejected' ? 'danger' : order.state === 'open' || order.state === 'filled' ? 'ok' : 'warn';
  return <Notice tone={tone}><div data-testid="live-outcome" data-state={order.state} aria-live="polite">
    <div className="mb-1.5 flex flex-wrap items-center gap-2"><LiveStatePill state={order.state} /><SourceTag source={order.source} /></div>
    {t(`flOut_${order.state}${order.state === 'partially_filled' && order.final ? '_final' : ''}` as Key, { filled: sz(order.filled), size: sz(order.size), base, price: px(order.avgFillPrice ?? order.price) })}
    {order.reason && <span className={`mt-1.5 ${WORDS}`}>{order.state === 'rejected' ? `${t('flVenueSays')} ` : ''}{order.reason}</span>}</div></Notice>;
}

/** EXACTLY the canonical order the passkey signs — every field, as sent to the venue */
export function CanonicalRows({ c, instrument }: { c: VenueOrder; instrument?: Instrument }) {
  const t = useT(); const { locale } = useContext(I18n);
  const px = (v: string) => fmt(v, { dp: Math.max(priceDp(instrument?.tickSize, v), 0), locale });
  const cut = c.instrument.indexOf(':'), venue = cut > 0 ? c.instrument.slice(0, cut) : '', base = instrument?.base ?? c.instrument.slice(cut + 1), market = c.type === 'limit' && c.tif === 'ioc', buy = c.side === 'buy';
  return <dl className="receipt" data-testid="canonical">
    <Fact k={t('flCInstrument')}><span className="inline-flex items-center justify-end gap-1.5 font-semibold">{venue && <VenueIcon venue={venue} size={18} />}{c.instrument}</span></Fact>
    <Fact k={t('flCSide')}><span className={`inline-flex items-center gap-1.5 font-semibold ${buy ? 'text-emerald' : 'text-danger'}`}><svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={buy ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>{t(buy ? 'flCBuy' : 'flCSell')}</span></Fact>
    <Fact k={t('flCType')}>{t(`fxType_${c.type}` as Key)}{market ? <span className="block text-[11.5px] font-normal leading-snug text-mute">{t('flCMarketNote')}</span> : null}</Fact>
    <Fact k={t('flCSize')}><span className="inline-flex items-center justify-end gap-1.5 font-semibold"><AssetIcon sym={base} size={18} />{fmt(c.size, { locale, trim: true })} {base}</span></Fact>
    <Fact k={t(market || c.type.endsWith('_market') ? 'flCWorstPrice' : 'flCPrice')}><span className="font-semibold">{px(c.price)}</span></Fact>
    <Fact k={t('flCTrigger')}>{c.triggerPrice ? px(c.triggerPrice) : t('flCNone')}</Fact>
    <Fact k={t('flCReduceOnly')}>{t(c.reduceOnly ? 'flYes' : 'flNo')}</Fact>
    <Fact k={t('flCTif')}>{t(`flTif_${c.tif}` as Key)}</Fact>
    <Fact k={t('flCNetwork')}>{c.network}</Fact>
    <Fact k={t('flCClientId')}><span className="break-all font-mono text-[11px] font-normal">{c.clientId}</span></Fact>
    <Fact k={t('flCNonce')}><span className="font-mono text-[11px] font-normal">{c.nonce}</span></Fact>
  </dl>;
}

/** time left to approve; calls `onExpire` once when it reaches zero */
export function Countdown({ expiresAt, skewMs, ttlMs = 90_000, onExpire }: { expiresAt: number; skewMs: number; ttlMs?: number; onExpire: () => void }) {
  const t = useT();
  const [left, setLeft] = useState(() => remainingMs(expiresAt, Date.now(), skewMs));
  useEffect(() => {
    let done = false;
    const tick = () => { const l = remainingMs(expiresAt, Date.now(), skewMs); setLeft(l); if (l <= 0 && !done) { done = true; onExpire(); } };
    tick(); const h = setInterval(tick, 250); return () => clearInterval(h);
  }, [expiresAt, skewMs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const low = left < 15_000;
  return <div data-testid="countdown" role="timer" aria-label={t('flExpiresIn', { time: clock(left) })}>
    <div className={`flex items-center justify-between text-[13px] font-semibold ${low ? 'text-danger' : 'text-ink'}`}><span className="inline-flex items-center gap-1.5"><Icon n="clock" className="h-4 w-4" />{t('flExpiresIn', { time: clock(left) })}</span></div>
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elev"><div className={`h-full rounded-full ${low ? 'bg-danger' : 'bg-blue'}`} style={{ width: `${Math.max(0, Math.min(100, (left / ttlMs) * 100))}%` }} /></div></div>;
}

/** label + explanation list item */
export function Bullet({ icon = 'check', tone = 'text-mute', children }: { icon?: string; tone?: string; children: ReactNode }) {
  return <li className="flex gap-2.5"><Icon n={icon} className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} /><span className="min-w-0">{children}</span></li>;
}

/** the terminal's account switcher: paper AND venue accounts, each named with the money it moves */
export function AccountSwitch({ value, choices, onChange }: { value: string; choices: { id: string; label: string; tone: Tone }[]; onChange: (id: string) => void }) {
  const t = useT();
  const cur = choices.find((c) => c.id === value);
  if (choices.length <= 1) return <div className="flex min-h-9 items-center gap-2 text-[14px] font-semibold">{cur && <ModeTag tone={cur.tone} />}<span className="min-w-0 truncate">{cur?.label ?? '—'}</span></div>;
  return <label className="block text-[12px] font-medium text-mute">{t('fxAccount')}
    <select aria-label={t('fxAccount')} data-testid="account-switch" value={value} onChange={(e) => onChange(e.target.value)} className="mt-1.5 min-h-11 w-full rounded-2xl border border-line bg-surface px-3.5 text-[15px] font-medium text-ink outline-none focus:border-blue">
      {choices.map((c) => <option key={c.id} value={c.id}>{t(toneWord(c.tone))} — {c.label}</option>)}</select></label>;
}

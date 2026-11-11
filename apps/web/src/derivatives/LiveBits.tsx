/**
 * Small pieces shared by the live screens. The most important one is the MODE BAND: which money the selected account moves is
 * written in words, with its own icon and its own pattern, on a band that is always on screen and cannot be dismissed —
 * « SIMULATION », « TESTNET — argent fictif », « RÉEL — argent réel ». Colour only repeats what the words say.
 */
import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Icon, Notice } from '../ui';
import { RISK_CODES } from './api';
import { Row } from './bits';
import { fmt, priceDp } from './dec';
import { clock, inFlight, remainingMs, type LiveErr, type LiveOrder, type LiveState, type Tone, type VenueOrder } from './live';
import type { Instrument } from './types';

// fixed colours (not theme variables): the band must read the same in the light and the dark theme
const BAND: Record<Tone, { cls: string; style?: CSSProperties; icon: string }> = {
  paper: { cls: 'border border-blue/35 bg-blue/8 text-blue', icon: 'eye' },
  testnet: { cls: 'text-white', style: { background: 'repeating-linear-gradient(135deg, #5b34c9 0 14px, #6f49dc 14px 28px)' }, icon: 'book' },
  mainnet: { cls: 'text-white', style: { background: '#b3122b' }, icon: 'warn' },
};
export const toneWord = (tone: Tone): Key => (tone === 'paper' ? 'flToneSim' : tone === 'testnet' ? 'flToneTestnet' : 'flToneReal');

/** always visible, never dismissible: there is no close control on purpose */
export function ModeBand({ tone, label, compact, className = '' }: { tone: Tone; label?: string; /** one line: the words and the account, without the sentence (the terminal's sticky band) */ compact?: boolean; className?: string }) {
  const t = useT(); const b = BAND[tone];
  return <div role="status" data-testid="mode-band" data-tone={tone} style={b.style} className={`rounded-xl px-3.5 py-2 leading-tight ${b.cls} ${className}`}>
    <div className="flex min-h-6 items-center gap-2"><Icon n={b.icon} className="h-4 w-4 shrink-0" /><span className="shrink-0 whitespace-nowrap text-[13px] font-extrabold uppercase tracking-[0.07em]">{t(toneWord(tone))}</span>
      {label ? <span className="min-w-0 flex-1 truncate text-right text-[12.5px] font-semibold">{label}</span> : null}</div>
    {!compact && <p className="mt-0.5 text-[12.5px] font-medium opacity-95">{t(tone === 'paper' ? 'flBandSim' : tone === 'testnet' ? 'flBandTestnet' : 'flBandReal')}</p>}</div>;
}
/** the same statement as a tag, beside a title or inside a sheet */
export function ModeTag({ tone, className = '' }: { tone: Tone; className?: string }) {
  const t = useT(); const b = BAND[tone];
  return <span data-testid="mode-tag" data-tone={tone} style={b.style} className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[0.06em] ${b.cls} ${className}`}>
    <Icon n={b.icon} className="h-3 w-3" />{t(toneWord(tone))}</span>;
}
export function SourceTag({ source = 'venue' }: { source?: 'venue' | 'local' | 'estimate' }) {
  const t = useT();
  return <span className="inline-flex items-center rounded border border-line px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-mute" title={t(source === 'venue' ? 'flSrcVenueTitle' : source === 'local' ? 'flSrcLocalTitle' : 'flSrcEstimateTitle')}>{t(source === 'venue' ? 'flSrcVenue' : source === 'local' ? 'flSrcLocal' : 'estimate')}</span>;
}

/** our sentence for the code, then the server's own words */
export function LiveErrNotice({ err, tone = 'danger', children }: { err: LiveErr; tone?: 'danger' | 'warn'; children?: ReactNode }) {
  const t = useT();
  const risk = RISK_CODES.has(err.code) && err.status === 422 && err.key === 'other';
  const text = risk ? t(`rk_${err.code}` as Key) : t(`flE_${err.key}` as Key);
  return <Notice tone={tone}><div data-testid="live-error" data-code={err.code}>
    {risk && <b className="font-semibold">{t('fxRefused')} </b>}{text}
    {err.detail && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{err.code}{err.status ? ` (${err.status})` : ''} — {err.detail}</span>}{children}</div></Notice>;
}

const ST_ICON: Record<string, string> = { open: 'check', filled: 'check', partially_filled: 'warn', rejected: 'x', cancelled: 'x', unknown: 'clock', submitted: 'clock', signed: 'clock', authorized: 'clock', risk_checked: 'key', proposed: 'key' };
const ST_CLS: Record<string, string> = { open: 'text-emerald bg-emerald/10', filled: 'text-emerald bg-emerald/10', partially_filled: 'text-warn bg-warn/12', rejected: 'text-danger bg-danger/10', cancelled: 'text-mute bg-elev', unknown: 'text-warn bg-warn/12' };
/** a live order's state: icon + word, never colour alone */
export function LiveStatePill({ state }: { state: LiveState }) {
  const t = useT();
  return <span data-state={state} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${ST_CLS[state] ?? (inFlight(state) ? ST_CLS.unknown : 'text-blue bg-blue/10')}`}><Icon n={ST_ICON[state] ?? 'clock'} className="h-3 w-3" />{t(`flSt_${state}` as Key)}</span>;
}
/** what happened to an order, in one sentence, from the server's state */
export function OrderOutcome({ order, instrument }: { order: LiveOrder; instrument?: Instrument }) {
  const t = useT(); const { locale } = useContext(I18n);
  const base = instrument?.base ?? order.instrument.slice(order.instrument.indexOf(':') + 1);
  const px = (v: string | null) => (v ? fmt(v, { dp: priceDp(instrument?.tickSize, v), locale }) : '—'), sz = (v: string) => fmt(v, { locale, trim: true });
  const tone = order.state === 'rejected' ? 'danger' : order.state === 'open' || order.state === 'filled' ? 'ok' : 'warn';
  return <Notice tone={tone}><div data-testid="live-outcome" data-state={order.state} aria-live="polite">
    <div className="mb-1 flex flex-wrap items-center gap-2"><LiveStatePill state={order.state} /><SourceTag source={order.source} /></div>
    {t(`flOut_${order.state}${order.state === 'partially_filled' && order.final ? '_final' : ''}` as Key, { filled: sz(order.filled), size: sz(order.size), base, price: px(order.avgFillPrice ?? order.price) })}
    {order.reason && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{order.state === 'rejected' ? `${t('flVenueSays')} ` : ''}{order.reason}</span>}</div></Notice>;
}

/** EXACTLY the canonical order the passkey signs — every field, as sent to the venue */
export function CanonicalRows({ c, instrument }: { c: VenueOrder; instrument?: Instrument }) {
  const t = useT(); const { locale } = useContext(I18n);
  const px = (v: string) => fmt(v, { dp: Math.max(priceDp(instrument?.tickSize, v), 0), locale });
  const base = instrument?.base ?? c.instrument.slice(c.instrument.indexOf(':') + 1), market = c.type === 'limit' && c.tif === 'ioc';
  return <div data-testid="canonical">
    <Row label={t('flCInstrument')} strong>{c.instrument}</Row>
    <Row label={t('flCSide')} strong><span className={c.side === 'buy' ? 'text-emerald' : 'text-danger'}>{t(c.side === 'buy' ? 'flCBuy' : 'flCSell')}</span></Row>
    <Row label={t('flCType')}>{t(`fxType_${c.type}` as Key)}{market ? <span className="block text-[11.5px] font-normal text-mute">{t('flCMarketNote')}</span> : null}</Row>
    <Row label={t('flCSize')} strong>{fmt(c.size, { locale, trim: true })} {base}</Row>
    <Row label={t(market || c.type.endsWith('_market') ? 'flCWorstPrice' : 'flCPrice')} strong>{px(c.price)}</Row>
    <Row label={t('flCTrigger')}>{c.triggerPrice ? px(c.triggerPrice) : t('flCNone')}</Row>
    <Row label={t('flCReduceOnly')}>{t(c.reduceOnly ? 'flYes' : 'flNo')}</Row>
    <Row label={t('flCTif')}>{t(`flTif_${c.tif}` as Key)}</Row>
    <Row label={t('flCNetwork')}>{c.network}</Row>
    <Row label={t('flCClientId')}><span className="break-all font-mono text-[11px]">{c.clientId}</span></Row>
    <Row label={t('flCNonce')}><span className="font-mono text-[11px]">{c.nonce}</span></Row>
  </div>;
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
    <div className={`flex items-center justify-between text-[12.5px] font-semibold ${low ? 'text-danger' : 'text-ink'}`}><span className="inline-flex items-center gap-1.5"><Icon n="clock" className="h-3.5 w-3.5" />{t('flExpiresIn', { time: clock(left) })}</span></div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-elev"><div className={`h-full rounded-full transition-[width] duration-200 ${low ? 'bg-danger' : 'bg-blue'}`} style={{ width: `${Math.max(0, Math.min(100, (left / ttlMs) * 100))}%` }} /></div></div>;
}

/** label + explanation list item */
export function Bullet({ icon = 'check', tone = 'text-mute', children }: { icon?: string; tone?: string; children: ReactNode }) {
  return <li className="flex gap-2.5"><Icon n={icon} className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} /><span className="min-w-0">{children}</span></li>;
}

/** the terminal's account switcher: paper AND venue accounts, each named with the money it moves */
export function AccountSwitch({ value, choices, onChange }: { value: string; choices: { id: string; label: string; tone: Tone }[]; onChange: (id: string) => void }) {
  const t = useT();
  const cur = choices.find((c) => c.id === value);
  if (choices.length <= 1) return <div className="flex items-center gap-2 text-[13px] font-semibold">{cur && <ModeTag tone={cur.tone} />}<span className="truncate">{cur?.label ?? '—'}</span></div>;
  return <label className="block text-[12px] text-mute">{t('fxAccount')}
    <select aria-label={t('fxAccount')} data-testid="account-switch" value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-[14px] text-ink">
      {choices.map((c) => <option key={c.id} value={c.id}>{t(toneWord(c.tone))} — {c.label}</option>)}</select></label>;
}

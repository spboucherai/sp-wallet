/**
 * The SIMPLE way to trade on a venue account (Hyperliquid), for an owner who is not a professional trader — the default of the
 * order panel; « Avancé » keeps the full form (limit, stop, take-profit, reduce-only, post-only) untouched.
 *
 *   SimpleOrderForm   two big directions, an amount (in USD on a real account, with quick amounts), the venue's leverage,
 *                     a summary in plain words (what is bought, margin, fees, estimated liquidation), then « Vérifier ».
 *                     It only fills the SAME form state as the advanced panel (a market order of a size): the body is built by
 *                     `buildLive`, previewed by the server, and approved in the same sheet with the passkey. Nothing new is sent.
 *   PositionCards     each open position of the venue as a card: direction, value, gain or loss, « Fermer » in one tap
 *                     (which opens the approval sheet of a reduce-only close — the passkey is still asked).
 *
 * Amount in USD: only on a MAINNET account. The terminal's price is the venue's mainnet mark; a testnet account trades at testnet
 * prices, so there the amount is typed in the asset (as in the advanced form) — a USD amount converted at another network's
 * price would be the wrong size. Rules of every derived figure: simple.ts.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { amountInputText } from '../amount';
import { AmountProblem } from '../amountUi';
import { I18n, useT, type Key } from '../i18n';
import { AssetIcon, Btn, Icon, Notice } from '../ui';
import { RISK_CODES } from './api';
import { Pnl, Row, SideTag } from './bits';
import { D, dec, dpOf, fmt, parseInput, pct, priceDp, usd, usdToSize, type Dec } from './dec';
import { ApprovalSheet } from './LiveApproval';
import { LiveErrNotice, OrderOutcome, SourceTag, Waiting, WORDS } from './LiveBits';
import { LIVE_SLIPPAGE_BPS, toneOf, type BuildProblem, type LiveDetail, type LiveErr, type LiveForm, type LiveOrder, type LiveOrderBody, type LivePreview, type LiveSummary } from './live';
import { refreshLive } from './liveStore';
import { drifted, liqEstimate, maxUsd, usdChips, type LiqEstimate } from './simple';
import { useSlice, type MarketStore } from './store';
import type { Instrument, Position, RiskResult } from './types';

const sym = (id: string) => id.slice(id.indexOf(':') + 1);
const arrow = (up: boolean) => <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true"><path d={up ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>;
const CHIP = 'press min-h-11 shrink-0 rounded-full border border-line bg-surface px-4 text-[14.5px] font-semibold text-ink disabled:opacity-45';

/** the estimated liquidation price as a line of text, or why there is none */
export function liqText(e: LiqEstimate, t: ReturnType<typeof useT>, px: (v: Dec) => string): string {
  if (!e.ok) return t(e.why === 'has_position' ? 'hl1LiqHasPosition' : e.why === 'other_positions' ? 'hl1LiqOthers' : 'hl1LiqUnknown');
  return e.price === null ? t('hl1LiqNone') : `≈ ${px(e.price)}`;
}

export interface SimpleProps {
  instrument: Instrument; account: LiveSummary | LiveDetail; detail: LiveDetail | undefined; store: MarketStore;
  f: LiveForm; set: (p: Partial<LiveForm>) => void; built: { body: LiveOrderBody | null; problem: BuildProblem | null };
  preview: LivePreview | undefined; refused: (RiskResult & { ok: false }) | null; pvErr: LiveErr | null;
  /** the venue's own leverage setting for this instrument (null until a preview read it) */ venueLev: { leverage: string; marginMode: string } | null;
  /** the most the owner may set: his authorization, the account's policy, the venue's maximum for the asset */ maxLev: number; venueMax: number | null;
  onLeverage: () => void; onReview: (liq: ReactNode) => void; reviewing: boolean; lastOrder: LiveOrder | undefined; /** the id of the order that was just sent: the amount is cleared */ sentId: string | null;
}
export function SimpleOrderForm({ instrument, account, detail, store, f, set, built, preview, refused, pvErr, venueLev, maxLev, venueMax, onLeverage, onReview, reviewing, lastOrder, sentId }: SimpleProps) {
  const t = useT(); const { locale } = useContext(I18n);
  const real = toneOf(account) === 'mainnet';
  const ticker = useSlice(store, 'ticker');
  // USD only where the terminal's price IS the account's price (mainnet); a testnet account types the size in the asset
  const mark = real ? dec(ticker?.mark) : null;
  const [unit, setUnit] = useState<'usd' | 'coin'>(real ? 'usd' : 'coin'), [text, setText] = useState('');
  const snap = useRef<{ key: string; mark: Dec } | null>(null);
  const lot = dec(instrument.lotSize), sdp = dpOf(instrument.lotSize), est = preview?.estimate ?? null;
  const pdp = priceDp(instrument.tickSize, est?.mark ?? ticker?.mark ?? null), px = (v: Dec | string) => fmt(v, { dp: pdp, locale });
  useEffect(() => { setText(''); snap.current = null; setUnit(real ? 'usd' : 'coin'); }, [instrument.id, account.id, real]);
  useEffect(() => { if (sentId) { setText(''); snap.current = null; } }, [sentId]);   // an order was sent: the amount starts again from nothing

  /** the typed USD amount → the size that is sent: amount ÷ mark, rounded down to the lot; computed again when the amount changes or the price moved more than 0.5 % */
  const fromUsd = (raw: string, force = false) => {
    const u = parseInput(raw);
    if (!u || !mark || !lot) { snap.current = null; if (f.size !== '') set({ size: '' }); return; }
    const key = `${instrument.id}|${u}`;
    if (!force && snap.current && snap.current.key === key && !drifted(snap.current.mark, mark)) return;
    snap.current = { key, mark };
    const size = usdToSize(D.from(u), mark, lot), s = amountInputText(D.str(size), locale);
    if (s !== f.size) set({ size: s });
  };
  useEffect(() => { if (unit === 'usd' && text) fromUsd(text); }, [ticker?.mark]);   // eslint-disable-line react-hooks/exhaustive-deps
  const type = (raw: string) => { const v = raw.replace(/[^0-9.,\s ]/g, ''); setText(v); if (unit === 'usd') fromUsd(v, true); else set({ size: v }); };
  const flip = () => { const next = unit === 'usd' ? 'coin' : 'usd'; setUnit(next); setText(''); snap.current = null; set({ size: '' }); };

  const state = detail?.venueState.error ? null : detail?.venueState.state ?? null, positions = detail?.venueState.error ? null : detail?.venueState.positions ?? null;
  // the per-order limit: the smaller of what the passkey approved and the account's own policy
  const limits = [account.authorization?.policy.maxOrderNotional, account.policy.maxOrderNotional].map((x) => dec(x)).filter((x): x is Dec => !!x && D.isPos(x));
  const orderLimit = limits.length ? D.str(limits.reduce((a, b) => D.min(a, b))) : null;
  const max = maxUsd({ orderLimit, freeCollateral: state?.freeCollateral, leverage: venueLev?.leverage });
  const chips = unit === 'usd' ? usdChips(max, instrument.minNotional) : [];
  const typedUsd = unit === 'usd' ? dec(parseInput(text)) : null, min = dec(instrument.minNotional);
  const belowMin = !!typedUsd && !!min && D.lt(typedUsd, min);
  const long = f.side === 'buy', base = instrument.base;
  const liq = built.body && est ? liqEstimate({ instrument: instrument.id, side: f.side, size: built.body.size, mark: est.mark, leverage: est.leverage, marginMode: est.marginMode, venueMaxLeverage: venueMax, equity: state?.equity, positions }) : null;
  const liqLine = liq ? liqText(liq, t, px) : null;
  const sizeText = built.body ? `${fmt(built.body.size, { dp: sdp, locale, trim: true })} ${base}` : null;
  // why the button cannot be pressed, in words — the first that applies
  const why: Key | null = instrument.status === 'halted' ? 'hl1WhyHalted' : !text.trim() ? 'hl1WhyAmount' : unit === 'usd' && !mark ? 'hl1WhyPrice' : belowMin ? null : built.problem === 'fxErrSizeSmall' ? 'hl1WhySmall' : built.problem ? built.problem : !built.body ? 'hl1WhyAmount' : refused ? null : pvErr ? null : !preview ? 'hl1WhyChecking' : null;
  const ready = !!built.body && !!preview && !refused && !reviewing && !belowMin && instrument.status !== 'halted';

  const side = (s: 'buy' | 'sell') => { const on = f.side === s, up = s === 'buy'; return <button key={s} type="button" role="radio" aria-checked={on} onClick={() => set({ side: s })} data-testid={`simple-side-${s}`}
    className={`press flex min-h-[64px] flex-col items-center justify-center rounded-2xl border px-2 ${on ? (up ? 'border-emerald bg-emerald text-onprimary' : 'border-danger bg-danger text-[var(--ondanger)]') : 'border-line text-ink'}`}>
    <span className="inline-flex items-center gap-1.5 text-[16.5px] font-semibold">{arrow(up)}{t(up ? 'hl1Long' : 'hl1Short')}</span>
    <span className={`mt-0.5 text-[12px] leading-tight ${on ? 'opacity-85' : 'text-mute'}`}>{t(up ? 'hl1LongSub' : 'hl1ShortSub')}</span></button>; };

  return <div className="space-y-3.5" data-testid="simple-form" data-unit={unit}>
    <div role="radiogroup" aria-label={t('fxDirection')} className="grid grid-cols-2 gap-2">{side('buy')}{side('sell')}</div>

    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2"><label htmlFor="hl1-amount" className="text-[13px] font-medium text-mute">{t(unit === 'usd' ? 'hl1Amount' : 'hl1AmountCoin', { base })}</label>
        {real && <button type="button" onClick={flip} className="-my-2 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-blue" data-testid="simple-unit"><Icon n="swap" className="h-3.5 w-3.5" />{t(unit === 'usd' ? 'hl1InCoin' : 'hl1InUsd', { base })}</button>}</div>
      <div className="relative"><span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center">{unit === 'usd' ? <AssetIcon sym="USDC" size={28} /> : <AssetIcon sym={base} size={28} />}</span>
        <input id="hl1-amount" className="w-full rounded-2xl border border-line bg-elev/60 py-3.5 pl-[54px] pr-[68px] text-[24px] font-semibold tracking-[-0.02em] outline-none transition placeholder:text-mute/70 focus:border-blue focus:bg-surface focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--blue)_16%,transparent)]"
          inputMode="decimal" autoComplete="off" placeholder="0" value={text} onChange={(e) => type(e.target.value)} data-testid="simple-amount" />
        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[14px] font-medium text-mute">{unit === 'usd' ? 'USD' : base}</span></div>
      <AmountProblem ambiguousOnly text={text} />
      {chips.length > 0 && <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1" role="group" aria-label={t('hl1Quick')}>{chips.map((c) => <button key={c.usd} type="button" className={CHIP} data-testid={c.max ? 'simple-chip-max' : 'simple-chip'} onClick={() => type(amountInputText(c.usd, locale))}>{c.max ? t('max') : usd(c.usd, locale).replace(/[.,]00(?=\D*$)/, '')}</button>)}</div>}
      <p className="mt-2 text-[12.5px] leading-snug text-mute" data-testid="simple-derived">
        {belowMin ? <span className="text-danger" data-testid="simple-min">{t('hl1Min', { min: usd(instrument.minNotional, locale) })}</span>
          : unit === 'usd' ? (sizeText && snap.current ? t('hl1Derived', { size: sizeText, price: px(snap.current.mark) }) : mark ? t('hl1DerivedHint', { base, price: px(mark) }) : t('hl1WhyPrice'))
          : t(real ? 'hl1CoinHint' : 'hl1CoinHintTestnet', { lot: fmt(instrument.lotSize, { locale, trim: true }), base })}
        {orderLimit && !belowMin && <span className="block">{t('hl1Limit', { limit: usd(orderLimit, locale) })}</span>}</p>
    </div>

    <div className="flex items-center justify-between gap-3 rounded-2xl border border-line py-2 pl-3.5 pr-2" data-testid="venue-leverage">
      <div className="min-w-0 text-[13px]"><div className="text-mute">{t('hl1Leverage')}</div>
        <div className="text-[15.5px] font-semibold">{venueLev ? `${fmt(venueLev.leverage, { locale, trim: true })}× · ${t(venueLev.marginMode === 'cross' ? 'fxCross' : 'fxIsolated')}` : t('hl1LevUnknown')}</div>
        {venueLev && Number(venueLev.leverage) > maxLev ? <div className="mt-0.5 text-[12px] font-medium leading-snug text-warn" data-testid="simple-lev-above">{t('hl1LevAbove', { lev: fmt(venueLev.leverage, { locale, trim: true }), max: maxLev })}</div>
          : <div className="mt-0.5 text-[12px] leading-snug text-mute" data-testid="simple-lev-max">{t('hl1LevMax', { max: maxLev })}</div>}</div>
      <button type="button" disabled={!!account.halted} onClick={onLeverage} className="press min-h-11 shrink-0 rounded-xl border border-line px-3.5 text-[13.5px] font-semibold text-ink disabled:opacity-45">{t('flLevChange')}</button></div>

    {built.body && !belowMin && <div className="rounded-[18px] border border-line px-3.5 py-3" aria-live="polite" data-testid="preview">
      <div className="mb-1.5 flex items-center justify-between gap-2"><span className="t-eyebrow">{t('hl1Summary')}</span><SourceTag source="estimate" /></div>
      {est ? <>
        <p className="pb-1.5 text-[14.5px] font-semibold leading-snug" data-testid="simple-sentence">{t(long ? 'hl1SayLong' : 'hl1SayShort', { size: sizeText ?? '', usd: usd(est.notional, locale), base })}</p>
        {positions?.some((p) => p.instrument === instrument.id && (p.side === 'long') !== long) && <p className="pb-1.5 text-[13px] leading-snug text-warn" data-testid="simple-against">{t('hl1SayAgainst', { base })}</p>}
        <Row label={t('hl1Margin', { lev: fmt(est.leverage, { locale, trim: true }) })}>{usd(est.initialMargin, locale)}</Row>
        <Row label={t('hl1Fee')}>{usd(est.fee, locale)}</Row>
        <Row label={t('hl1Liq')}><span data-testid="simple-liq" data-ok={liq?.ok ? '1' : '0'}>{liqLine}</span></Row>
        <Row label={t('fxWorstPrice')}>{fmt(preview?.request.price ?? null, { dp: pdp, locale })}</Row>
        <Row label={t('fxFreeAfter')}>{usd(est.freeCollateralAfter, locale)}</Row>
        <p className="mt-1.5 text-[12px] leading-snug text-mute">{t(liq?.ok ? (liq.basis === 'cross' ? 'hl1LiqRuleCross' : 'hl1LiqRuleIsolated') : 'hl1LiqRuleNone')} {t('hl1MarketRule', { pct: fmt(String(LIVE_SLIPPAGE_BPS / 100), { locale, trim: true }) })}</p></>
        : pvErr ? <p className="py-2 text-[13px] text-mute">{t('fxPreviewError')}</p> : <Waiting className="py-2">{t('hl1WhyChecking')}</Waiting>}
    </div>}
    {pvErr && <LiveErrNotice err={pvErr} />}
    {refused && <Notice tone="danger"><div data-testid="risk-refusal"><b className="font-semibold">{t('fxRefused')}</b> {RISK_CODES.has(refused.code) && !['halted', 'mode_read_only'].includes(refused.code) ? t(`rk_${refused.code}` as Key) : t(`flE_${refused.code}` as Key)}
      {refused.code === 'order_notional_exceeded' && <span className="mt-1 block">{t('flNotionalSigner')}</span>}
      <span className={`mt-1.5 ${WORDS}`}>{refused.code} — {refused.reason}</span></div></Notice>}
    {lastOrder && <OrderOutcome order={lastOrder} instrument={instrument} />}

    <button type="button" data-testid="live-review" disabled={!ready} onClick={() => onReview(liqLine)}
      className={`press inline-flex min-h-[58px] w-full items-center justify-center gap-2 rounded-2xl px-5 text-[16.5px] font-semibold disabled:opacity-45 ${long ? 'bg-emerald text-onprimary' : 'bg-danger text-[var(--ondanger)]'}`}>
      {arrow(long)}<span>{t(long ? 'hl1GoLong' : 'hl1GoShort', { base })}</span></button>
    {why && !ready && <p className="text-center text-[12.5px] leading-snug text-mute" data-testid="simple-why">{t(why)}</p>}
    <p className="text-center text-[12px] font-medium leading-snug" data-testid="live-foot"><span className={real ? 'text-danger' : 'text-mute'}>{t(real ? 'hl1FootReal' : 'hl1FootTestnet')}</span></p>
  </div>;
}

/** the venue's open positions as cards: what is held, what it is worth, the gain or the loss, and one tap to close */
export function PositionCards({ account, detail, instruments, ttlMs, onSelect }: { account: LiveSummary; detail: LiveDetail | undefined; instruments: Map<string, Instrument>; ttlMs: number; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [closing, setClosing] = useState<{ position: Position; fraction: string } | null>(null);
  const a = detail ?? account, st = detail?.venueState;
  if (!st || st.error) return null;
  const off = account.network === 'mainnet' && !account.mainnetEnabled, canAct = a.mode === 'MANUAL_LIVE' && !off;
  const px = (id: string, v: string | null | undefined) => (v ? fmt(v, { dp: priceDp(instruments.get(id)?.tickSize, v), locale }) : '—');
  return <div data-testid="position-cards">
    <h3 className="t-eyebrow mb-2.5 flex items-center justify-between gap-2"><span>{t('hl1Positions', { n: st.positions.length })}</span><SourceTag /></h3>
    {st.positions.length === 0 ? <p className="text-[13.5px] leading-snug text-mute" data-testid="position-none">{t('hl1NoPosition')}</p> : <ul className="space-y-3">{st.positions.map((p) => {
      const inst = instruments.get(p.instrument), s = sym(p.instrument), value = D.mul(dec(p.size) ?? D.zero, dec(p.markPrice) ?? D.zero), pnl = dec(p.unrealizedPnl), margin = dec(p.margin);
      const onMargin = pnl && margin && D.isPos(margin) ? D.div(pnl, margin, 6, 'half_even') : null, gain = pnl ? D.sign(D.div(pnl, D.one, 2, 'half_even')) : 0;   // the sign of the amount as it is shown, to the cent
      return <li key={p.instrument} className="rounded-[18px] border border-line p-3.5" data-testid="position-card" data-id={p.instrument}>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => onSelect(p.instrument)} aria-label={t('fxOpenMarket', { symbol: s })} className="press flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"><AssetIcon sym={inst?.base ?? s} size={38} />
            <span className="min-w-0"><span className="flex items-center gap-2 text-[16px] font-semibold leading-tight"><span className="truncate">{s}</span><SideTag side={p.side} /></span>
              <span className="mt-0.5 block truncate text-[12.5px] text-mute">{fmt(p.size, { dp: Math.min(8, dpOf(inst?.lotSize ?? '0.0001')), locale, trim: true })} {inst?.base ?? s} ≈ {usd(value, locale)} · {fmt(p.leverage, { dp: 1, locale, trim: true })}×</span></span></button>
          <div className="shrink-0 text-right" data-testid="position-pnl" data-sign={gain}><div className="inline-flex items-center gap-1 text-[17px] font-semibold">{gain !== 0 && <span className={gain > 0 ? 'text-emerald' : 'text-danger'}>{arrow(gain > 0)}</span>}<Pnl value={p.unrealizedPnl} locale={locale} /></div>
            <div className="text-[12px] text-mute">{t(gain > 0 ? 'hl1Gain' : gain < 0 ? 'hl1Loss' : 'hl1Flat')}{onMargin ? ` · ${pct(onMargin, 1, locale, true)}` : ''}</div></div>
        </div>
        <dl className="mt-2.5 grid grid-cols-3 gap-2 text-[12.5px]"><div><dt className="text-mute">{t('fxEntry')}</dt><dd className="font-medium">{px(p.instrument, p.entryPrice)}</dd></div><div><dt className="text-mute">{t('hl1Now')}</dt><dd className="font-medium">{px(p.instrument, p.markPrice)}</dd></div>
          <div><dt className="text-mute">{t('hl1LiqVenue')}</dt><dd className="font-medium">{px(p.instrument, p.liquidationPrice)}</dd></div></dl>
        <div className="mt-3 flex items-center gap-2" role="group" aria-label={t('fxCloseAria', { symbol: s })}>
          <Btn kind="soft" full disabled={!canAct || !!closing} onClick={() => setClosing({ position: p, fraction: '1' })} data-testid="position-close" aria-label={t('fxCloseFrac', { pct: 100, symbol: s })}>{t('hl1Close')}</Btn>
          {(['0.5', '0.25'] as const).map((fr) => <button key={fr} type="button" disabled={!canAct || !!closing} onClick={() => setClosing({ position: p, fraction: fr })} className="press min-h-11 shrink-0 rounded-2xl border border-line px-3.5 text-[13.5px] font-semibold text-ink disabled:opacity-45"
            aria-label={t('fxCloseFrac', { pct: fr === '0.5' ? 50 : 25, symbol: s })}>{fr === '0.5' ? '50' : '25'} %</button>)}</div>
        {onMargin && <p className="mt-2 text-[11.5px] leading-snug text-mute">{t('hl1PnlRule')}</p>}
      </li>; })}</ul>}
    {!canAct && st.positions.length > 0 && <p className="mt-2.5 text-[12.5px] leading-snug text-warn" data-testid="position-locked">{t('hl1CloseLocked')}</p>}
    {closing && <ApprovalSheet account={a} instrument={instruments.get(closing.position.instrument)} request={{ kind: 'close', position: closing.position, fraction: closing.fraction }} orders={detail?.orders ?? []} ttlMs={ttlMs} onClose={() => { setClosing(null); void refreshLive(qc, account.id); }} />}
  </div>;
}

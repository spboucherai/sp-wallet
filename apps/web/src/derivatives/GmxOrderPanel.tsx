/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/GmxOrderPanel.tsx
 * Module           : derivatives
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

/**
 * The GMX order panel (v8) — shown only when `GmxStatus.tradable` is true. Market, long / short, collateral in USDC, then
 * either a leverage (size = collateral × leverage) or the size itself: on GMX leverage is not a setting, it is size ÷ collateral.
 * The slippage bound gives the acceptable price. Every change asks the server for a preview (debounced): the fee breakdown,
 * all of it labelled as an estimate, the verdict of the risk engine and the refusal the signer would give. « Vérifier et
 * signer » only opens the confirm sheet: nothing is built before, nothing leaves without the passkey.
 *
 * v10: the collateral is a large field with the USDC logo, the leverage a slider with a 44 px touch area and its figure, the
 * derived size a set of facts; the estimate keeps every line and its « estimation » label, the two-step notice stays on screen.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { AssetIcon, Btn, Fact, Field, Icon, inputCls, Notice, VenueIcon } from '../ui';
import { Seg } from './bits';
import { fmt, parseInput, usd } from './dec';
import { amountInputText, sanitizeAmountText } from '../amount';   // v8 hardening: the wallet's single rule for typed amounts
import { AmountProblem } from '../amountUi';
import { buildGmx, clearGmxPrefill, gapi, gmxError, peekGmxPrefill, type GmxForm, type GmxMarket, type GmxStatus } from './gmx';
import { EstimateRows, eth, GmxErrNotice, lev as levText, px, TwoStep, usdc } from './GmxBits';
import { GmxConfirm, type GmxRequest } from './GmxConfirm';
import { ModeTag, TICKET, Waiting, WORDS } from './LiveBits';

function useDebounced<T>(v: T, ms: number): T { const [d, setD] = useState(v); useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]); return d; }

export function GmxOrderPanel({ status, market, onMarket }: { status: GmxStatus; market: GmxMarket; onMarket: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const policy = status.authorization?.policy, maxLev = Math.max(1, Math.min(20, policy?.maxLeverage ?? 1)), w = status.wallet;
  const [f, setF] = useState<GmxForm>(() => { const p = peekGmxPrefill(market.instrument);   // coming from the router: a pre-filled form, nothing more
    return p ? { side: p.side, collateral: amountInputText(p.collateral, locale), mode: 'size', leverage: amountInputText(p.leverage, locale), sizeUsd: amountInputText(p.sizeUsd, locale), slippageBps: '50' } : { side: 'long', collateral: '', mode: 'leverage', leverage: String(Math.min(2, maxLev)), sizeUsd: '', slippageBps: '50' }; });
  const [prefilled] = useState(() => peekGmxPrefill(market.instrument) !== null);
  useEffect(() => { clearGmxPrefill(market.instrument); }, [market.instrument]);
  const [request, setRequest] = useState<GmxRequest | null>(null);
  const set = (p: Partial<GmxForm>) => setF({ ...f, ...p });
  const built = buildGmx(f, market.market, status), latest = useRef(built); latest.current = built;
  const stable = useDebounced(built.body ? JSON.stringify(built.body) : '', 400);
  const pv = useQuery({ queryKey: ['deriv', 'gmx', 'preview', stable], enabled: !!stable && !request, retry: 0, staleTime: 0, gcTime: 0, refetchInterval: 8000, placeholderData: keepPreviousData,
    queryFn: () => { const b = latest.current.body; if (!b) throw new Error('no order'); return Promise.race([gapi.preview(b), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 12_000))]); } });
  const current = !!built.body && stable === JSON.stringify(built.body), preview = current ? pv.data : undefined;
  const risk = preview?.risk, refused = risk && !risk.ok ? risk : null;
  const can = current && !!preview && !!risk?.ok && !preview.signerWould && preview.blockers.length === 0;
  const allowed = status.markets.filter((m) => m.allowed);
  const levNow = Math.max(1, Math.min(maxLev, Number(parseInput(f.leverage, locale) ?? '1') || 1));
  const arrow = (up: boolean) => <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={up ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>;

  return <div className="min-w-0 space-y-3.5" data-testid="gmx-order-panel" data-market={market.market}>
    <div className="flex items-center justify-between gap-2"><h3 className="flex min-w-0 items-center gap-2 text-[1rem] font-semibold tracking-[-0.01em]"><VenueIcon venue="gmx" size={22} /><span className="min-w-0">{t('gxPanelTitle')}</span></h3></div>
    <div className="!mt-1.5 flex flex-wrap items-center justify-between gap-2"><span className="text-[0.78125rem] text-mute">{t('gxPanelSub')}</span><ModeTag tone="mainnet" /></div>
    {prefilled && <Notice tone="info"><div data-testid="gmx-prefilled">{t('gxPrefilled')}</div></Notice>}
    <label className="block text-[0.8125rem] font-medium text-mute">{t('gxMarket')}
      <span className="relative mt-1.5 block"><span className="pointer-events-none absolute inset-y-0 left-3 flex items-center"><AssetIcon sym={market.base} size={26} /></span>
        <select aria-label={t('gxMarket')} data-testid="gmx-market" value={market.instrument} onChange={(e) => onMarket(e.target.value)} className="min-h-12 w-full rounded-2xl border border-line bg-surface pl-[50px] pr-3 text-[0.9375rem] font-semibold text-ink outline-none focus:border-blue">
          {(allowed.some((m) => m.market === market.market) ? allowed : [market, ...allowed]).map((m) => <option key={m.market} value={m.instrument}>{m.name}</option>)}</select></span></label>
    {!market.allowed && <Notice tone="warn"><div data-testid="gmx-market-not-allowed">{t('gxMarketNotAllowed')}</div></Notice>}

    <div role="radiogroup" aria-label={t('fxDirection')} className="grid grid-cols-2 gap-2">{(['long', 'short'] as const).map((s) =>
      <button key={s} type="button" role="radio" aria-checked={f.side === s} onClick={() => set({ side: s })} data-testid={`gmx-side-${s}`}
        className={`press inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border text-[0.9375rem] font-semibold ${f.side === s ? (s === 'long' ? 'border-emerald bg-emerald text-onprimary' : 'border-danger bg-danger text-[var(--ondanger)]') : 'border-line text-mute'}`}>{arrow(s === 'long')}{t(s === 'long' ? 'gxLong' : 'gxShort')}</button>)}</div>

    <Field label={t('gxCollateralIn')} hint={w ? t('gxCollateralHint', { have: fmt(w.usdc, { locale, dp: 2 }), max: fmt(w.limits.maxNow, { locale, dp: 2 }) }) : undefined}>
      <div className="amount-box amount-box-sm"><AssetIcon sym="USDC" net="arbitrum" size={36} /><input inputMode="decimal" autoComplete="off" placeholder="0" aria-label={t('gxCollateralIn')} value={f.collateral} onChange={(e) => set({ collateral: sanitizeAmountText(e.target.value) })} data-testid="gmx-collateral" />
        <span className="shrink-0 text-[0.90625rem] font-semibold text-mute">USDC</span></div><AmountProblem ambiguousOnly text={f.collateral} /></Field>

    <Seg size="sm" label={t('gxSizeMode')} value={f.mode} onChange={(m) => set({ mode: m })} options={[{ id: 'leverage', label: t('gxModeLeverage') }, { id: 'size', label: t('gxModeSize') }]} />
    {f.mode === 'leverage' ? <div>
      <div className="flex items-end justify-between gap-3"><label htmlFor="gx-lev" className="text-[0.8125rem] font-medium text-mute">{t('gxLeverage')}</label>
        <span className="flex items-baseline gap-1"><input aria-label={t('gxLeverage')} inputMode="decimal" value={f.leverage} onChange={(e) => set({ leverage: sanitizeAmountText(e.target.value).slice(0, 4) })} data-testid="gmx-leverage" className="t-num h-11 w-[84px] rounded-xl border border-line bg-elev/60 px-2 text-right text-[1.5rem] outline-none focus:border-blue focus:bg-surface" /><span className="t-num text-[1.5rem]">×</span></span></div>
      <input id="gx-lev" type="range" min={1} max={maxLev} step={0.5} value={levNow} disabled={maxLev <= 1} onChange={(e) => set({ leverage: amountInputText(e.target.value, locale) })} className="lev-range" style={{ '--fill': `${maxLev > 1 ? ((levNow - 1) / (maxLev - 1)) * 100 : 0}%` } as CSSProperties} aria-valuetext={`${f.leverage}×`} />
      <p className="text-[0.75rem] leading-snug text-mute">{t('gxLeverageNote', { max: maxLev })}</p></div>
      : <Field label={t('gxSizeUsd')} hint={t('gxSizeHint', { max: policy ? fmt(policy.maxOrderSizeUsd, { locale, trim: true }) : '—' })}>
        <div className="relative"><input className={`${inputCls} pr-16 font-semibold`} inputMode="decimal" autoComplete="off" aria-label={t('gxSizeUsd')} value={f.sizeUsd} onChange={(e) => set({ sizeUsd: sanitizeAmountText(e.target.value) })} data-testid="gmx-size" /><span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[0.8125rem] font-medium text-mute">USD</span></div><AmountProblem ambiguousOnly text={f.sizeUsd} /></Field>}
    <div className={TICKET} data-testid="gmx-derived"><dl>
      <Fact k={t('gxEstSize')}><span className="t-num text-[1.1875rem]">{built.sizeUsd ? usd(built.sizeUsd, locale) : '—'}</span></Fact>
      <Fact k={t('gxEstLeverage')}>{levText(built.leverage, locale)}</Fact>
      <Fact k={t('gxMark')}>{px(market.mark, locale)}</Fact></dl></div>

    <Field label={t('gxSlippage')} hint={t('gxSlippageHint')}>
      <div className="relative"><input className={`${inputCls} pr-32 font-semibold`} inputMode="numeric" autoComplete="off" aria-label={t('gxSlippage')} value={f.slippageBps} onChange={(e) => set({ slippageBps: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} data-testid="gmx-slippage" />
        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[0.8125rem] font-medium text-mute">{t('gxBps')} · {fmt(String((Number(f.slippageBps) || 0) / 100), { locale, trim: true })} %</span></div></Field>

    {built.problem && <Notice tone="danger"><div data-testid="gmx-problem" data-problem={built.problem}>{t(built.problem as Key, { have: w ? fmt(w.usdc, { locale, dp: 2 }) : '—', max: w ? fmt(w.limits.maxNow, { locale, dp: 2 }) : '—', lev: maxLev, size: policy ? fmt(policy.maxOrderSizeUsd, { locale, trim: true }) : '—' })}</div></Notice>}

    {built.body && <div className="rounded-[18px] border border-line px-3.5 py-3" data-testid="gmx-preview" data-ready={preview ? '1' : '0'} aria-live="polite">
      {preview ? <EstimateRows e={preview.estimate} /> : pv.isError && current ? <GmxErrNotice err={gmxError(pv.error)} raw={pv.error} /> : <Waiting className="py-3">{t('gxPreviewing')}</Waiting>}</div>}
    {preview && <div data-testid="gmx-verdict" data-ok={can ? '1' : '0'} className="space-y-2.5">
      {refused ? <Notice tone="danger"><div data-testid="gmx-risk" data-code={refused.code}><b className="font-semibold">{t('gxRiskRefused')}</b> {refused.reason}<span className={`mt-1.5 ${WORDS}`}>{refused.code}</span></div></Notice>
        : <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-emerald" data-testid="gmx-risk" data-code="ok"><Icon n="check" className="h-4 w-4 shrink-0" />{t('gxRiskOk')}</p>}
      {preview.signerWould && <Notice tone="danger"><div data-testid="gmx-signer-would"><b className="font-semibold">{t('gxSignerWould')}</b> <span className="break-words">{preview.signerWould}</span></div></Notice>}
      {preview.blockers.length > 0 && <Notice tone="warn"><div data-testid="gmx-preview-blockers">{t('gxPreviewBlocked')} <span className="font-mono text-[0.71875rem]">{preview.blockers.join(', ')}</span></div></Notice>}
    </div>}

    <TwoStep expirationSec={status.facts.requestExpirationSec} />
    <Btn full className="!min-h-[54px] !text-[1rem]" kind="danger" disabled={!can} onClick={() => { if (built.body) setRequest({ kind: 'order', body: built.body }); }} data-testid="gmx-review"><Icon n="key" className="h-[18px] w-[18px]" />{t('gxReview')}</Btn>
    <p className="text-center text-[0.75rem] leading-snug text-mute">{t('gxReviewNote')}</p>
    {w && <p className="text-[0.75rem] leading-snug text-mute">{t('gxFeesFrom', { eth: eth(w.eth, locale), usdc: usdc(w.usdc, locale) })}</p>}
    {request && <GmxConfirm status={status} request={request} onClose={() => { setRequest(null); set({ collateral: '' }); }} />}
  </div>;
}

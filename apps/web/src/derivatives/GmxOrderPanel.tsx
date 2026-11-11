/**
 * The GMX order panel (v8) — shown only when `GmxStatus.tradable` is true. Market, long / short, collateral in USDC, then
 * either a leverage (size = collateral × leverage) or the size itself: on GMX leverage is not a setting, it is size ÷ collateral.
 * The slippage bound gives the acceptable price. Every change asks the server for a preview (debounced): the fee breakdown,
 * all of it labelled as an estimate, the verdict of the risk engine and the refusal the signer would give. « Vérifier et
 * signer » only opens the confirm sheet: nothing is built before, nothing leaves without the passkey.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Field, Icon, inputCls, Notice } from '../ui';
import { Row, Seg } from './bits';
import { fmt, parseInput, usd } from './dec';
import { amountInputText, sanitizeAmountText } from '../amount';   // v8 hardening: the wallet's single rule for typed amounts
import { AmountProblem } from '../amountUi';
import { buildGmx, clearGmxPrefill, gapi, gmxError, peekGmxPrefill, type GmxForm, type GmxMarket, type GmxStatus } from './gmx';
import { EstimateRows, eth, GmxErrNotice, lev as levText, px, TwoStep, usdc } from './GmxBits';
import { GmxConfirm, type GmxRequest } from './GmxConfirm';

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

  return <div className="min-w-0 space-y-3" data-testid="gmx-order-panel" data-market={market.market}>
    <div className="flex items-center justify-between gap-2"><h3 className="text-[15px] font-semibold">{t('gxPanelTitle')}</h3><span className="text-[12px] text-mute">{t('gxPanelSub')}</span></div>
    {prefilled && <Notice tone="info"><div data-testid="gmx-prefilled">{t('gxPrefilled')}</div></Notice>}
    <label className="block text-[12px] text-mute">{t('gxMarket')}
      <select aria-label={t('gxMarket')} data-testid="gmx-market" value={market.instrument} onChange={(e) => onMarket(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-[14px] text-ink">
        {(allowed.some((m) => m.market === market.market) ? allowed : [market, ...allowed]).map((m) => <option key={m.market} value={m.instrument}>{m.name}</option>)}</select></label>
    {!market.allowed && <Notice tone="warn"><div data-testid="gmx-market-not-allowed">{t('gxMarketNotAllowed')}</div></Notice>}

    <div role="radiogroup" aria-label={t('fxDirection')} className="grid grid-cols-2 gap-2">{(['long', 'short'] as const).map((s) =>
      <button key={s} type="button" role="radio" aria-checked={f.side === s} onClick={() => set({ side: s })} data-testid={`gmx-side-${s}`}
        className={`min-h-12 rounded-2xl border text-[15px] font-semibold transition ${f.side === s ? (s === 'long' ? 'border-emerald bg-emerald/10 text-emerald' : 'border-danger bg-danger/10 text-danger') : 'border-line text-mute'}`}>{t(s === 'long' ? 'gxLong' : 'gxShort')}</button>)}</div>

    <Field label={t('gxCollateralIn')} hint={w ? t('gxCollateralHint', { have: fmt(w.usdc, { locale, dp: 2 }), max: fmt(w.limits.maxNow, { locale, dp: 2 }) }) : undefined}>
      <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" aria-label={t('gxCollateralIn')} value={f.collateral} onChange={(e) => set({ collateral: sanitizeAmountText(e.target.value) })} data-testid="gmx-collateral" />
        <span className="w-12 shrink-0 text-[12.5px] text-mute">USDC</span></div><AmountProblem ambiguousOnly text={f.collateral} /></Field>

    <Seg size="sm" label={t('gxSizeMode')} value={f.mode} onChange={(m) => set({ mode: m })} options={[{ id: 'leverage', label: t('gxModeLeverage') }, { id: 'size', label: t('gxModeSize') }]} />
    {f.mode === 'leverage' ? <div>
      <div className="mb-1 flex items-baseline justify-between text-[13px]"><label htmlFor="gx-lev" className="text-mute">{t('gxLeverage')}</label>
        <span className="flex items-center gap-1"><input aria-label={t('gxLeverage')} inputMode="decimal" value={f.leverage} onChange={(e) => set({ leverage: sanitizeAmountText(e.target.value).slice(0, 4) })} data-testid="gmx-leverage" className="h-9 w-16 rounded-lg border border-line bg-elev/60 px-2 text-right text-[14px] font-semibold outline-none focus:border-blue" /><span className="font-semibold">×</span></span></div>
      <input id="gx-lev" type="range" min={1} max={maxLev} step={0.5} value={Math.max(1, Math.min(maxLev, Number(parseInput(f.leverage, locale) ?? '1') || 1))} disabled={maxLev <= 1} onChange={(e) => set({ leverage: amountInputText(e.target.value, locale) })} className="h-11 w-full accent-[var(--blue)]" aria-valuetext={`${f.leverage}×`} />
      <p className="text-[11.5px] leading-snug text-mute">{t('gxLeverageNote', { max: maxLev })}</p></div>
      : <Field label={t('gxSizeUsd')} hint={t('gxSizeHint', { max: policy ? fmt(policy.maxOrderSizeUsd, { locale, trim: true }) : '—' })}>
        <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" aria-label={t('gxSizeUsd')} value={f.sizeUsd} onChange={(e) => set({ sizeUsd: sanitizeAmountText(e.target.value) })} data-testid="gmx-size" /><span className="w-12 shrink-0 text-[12.5px] text-mute">USD</span></div><AmountProblem ambiguousOnly text={f.sizeUsd} /></Field>}
    <div className="rounded-2xl bg-elev/70 p-3" data-testid="gmx-derived">
      <Row label={t('gxEstSize')} strong>{built.sizeUsd ? usd(built.sizeUsd, locale) : '—'}</Row>
      <Row label={t('gxEstLeverage')}>{levText(built.leverage, locale)}</Row>
      <Row label={t('gxMark')}>{px(market.mark, locale)}</Row></div>

    <Field label={t('gxSlippage')} hint={t('gxSlippageHint')}>
      <div className="flex items-center gap-2"><input className={inputCls} inputMode="numeric" autoComplete="off" aria-label={t('gxSlippage')} value={f.slippageBps} onChange={(e) => set({ slippageBps: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} data-testid="gmx-slippage" />
        <span className="w-24 shrink-0 text-[12.5px] text-mute">{t('gxBps')} · {fmt(String((Number(f.slippageBps) || 0) / 100), { locale, trim: true })} %</span></div></Field>

    {built.problem && <Notice tone="danger"><div data-testid="gmx-problem" data-problem={built.problem}>{t(built.problem as Key, { have: w ? fmt(w.usdc, { locale, dp: 2 }) : '—', max: w ? fmt(w.limits.maxNow, { locale, dp: 2 }) : '—', lev: maxLev, size: policy ? fmt(policy.maxOrderSizeUsd, { locale, trim: true }) : '—' })}</div></Notice>}

    {built.body && <div className="rounded-2xl border border-line p-3" data-testid="gmx-preview" data-ready={preview ? '1' : '0'} aria-live="polite">
      {preview ? <EstimateRows e={preview.estimate} /> : pv.isError && current ? <GmxErrNotice err={gmxError(pv.error)} raw={pv.error} /> : <p className="flex items-center gap-2 py-3 text-[13px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('gxPreviewing')}</p>}</div>}
    {preview && <div data-testid="gmx-verdict" data-ok={can ? '1' : '0'} className="space-y-2">
      {refused ? <Notice tone="danger"><div data-testid="gmx-risk" data-code={refused.code}><b className="font-semibold">{t('gxRiskRefused')}</b> {refused.reason}<span className="mt-1 block font-mono text-[11.5px] text-mute">{refused.code}</span></div></Notice>
        : <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald" data-testid="gmx-risk" data-code="ok"><Icon n="check" className="h-4 w-4" />{t('gxRiskOk')}</p>}
      {preview.signerWould && <Notice tone="danger"><div data-testid="gmx-signer-would"><b className="font-semibold">{t('gxSignerWould')}</b> <span className="break-words">{preview.signerWould}</span></div></Notice>}
      {preview.blockers.length > 0 && <Notice tone="warn"><div data-testid="gmx-preview-blockers">{t('gxPreviewBlocked')} <span className="font-mono text-[11.5px]">{preview.blockers.join(', ')}</span></div></Notice>}
    </div>}

    <TwoStep expirationSec={status.facts.requestExpirationSec} />
    <Btn full kind="danger" disabled={!can} onClick={() => { if (built.body) setRequest({ kind: 'order', body: built.body }); }} data-testid="gmx-review"><Icon n="key" className="h-4 w-4" />{t('gxReview')}</Btn>
    <p className="text-center text-[11.5px] leading-snug text-mute">{t('gxReviewNote')}</p>
    {w && <p className="text-[11.5px] leading-snug text-mute">{t('gxFeesFrom', { eth: eth(w.eth, locale), usdc: usdc(w.usdc, locale) })}</p>}
    {request && <GmxConfirm status={status} request={request} onClose={() => { setRequest(null); set({ collateral: '' }); }} />}
  </div>;
}

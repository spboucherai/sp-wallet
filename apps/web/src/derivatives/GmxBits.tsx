/**
 * Small pieces shared by the GMX screens (v8): the two-step explanation that is always on screen, the estimate rows (every
 * figure labelled as an estimate), the error notice, and the card that says where an operation is. A `created` order is shown
 * as « en attente d'exécution par le réseau GMX », never as executed; « garantie revenue au portefeuille » is written only when
 * the server saw the balance move back (`outcome.collateralReturned === true`). Every sentence is in the `gx` block of i18n.ts.
 */
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Icon, Notice } from '../ui';
import { Row, SideTag } from './bits';
import { fmt, pct, usd } from './dec';
import { gmxOpDone, gmxOpWords, type GmxErr, type GmxEstimate, type GmxOperation } from './gmx';
import { LiveErrNotice, SourceTag } from './LiveBits';
import { clock, liveError } from './live';

export const TONE_CLS = { ok: 'text-emerald bg-emerald/10', info: 'text-blue bg-blue/10', warn: 'text-warn bg-warn/12', danger: 'text-danger bg-danger/10', mute: 'text-mute bg-elev' } as const;
export const usdc = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, dp: 2 })} USDC`);
export const eth = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, dp: 6, trim: true })} ETH`);
export const px = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : usd(x, locale));
export const lev = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, dp: 2, trim: true })}×`);
/** milliseconds left until `at` (unix ms), re-read twice a second; 0 when it has passed or is unknown */
export function useLeft(at: number | null | undefined): number {
  const [left, setLeft] = useState(() => (at ? Math.max(0, at - Date.now()) : 0));
  useEffect(() => { if (!at) { setLeft(0); return; } const tick = () => setLeft(Math.max(0, at - Date.now())); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [at]);
  return left;
}
export function ChainTag() {
  const t = useT();
  return <span className="inline-flex items-center rounded border border-line px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-mute" title={t('gxSrcChainTitle')}>{t('gxSrcChain')}</span>;
}

/** always on screen where an order can be made or followed: what « ordre en deux temps » means */
export function TwoStep({ expirationSec, className = '' }: { expirationSec: number; className?: string }) {
  const t = useT();
  return <div className={`rounded-2xl border border-line p-3 ${className}`} data-testid="gmx-two-step">
    <div className="text-[12.5px] font-semibold">{t('gxTwoStepTitle')}</div>
    <ol className="mt-1.5 space-y-1.5 text-[12.5px] leading-snug">
      <li className="flex gap-2"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-elev text-[11px] font-bold">1</span><span className="min-w-0">{t('gxTwoStep1')}</span></li>
      <li className="flex gap-2"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-elev text-[11px] font-bold">2</span><span className="min-w-0">{t('gxTwoStep2')}</span></li>
    </ol>
    <p className="mt-1.5 text-[11.5px] leading-snug text-mute">{t('gxTwoStepCancel', { seconds: expirationSec })}</p></div>;
}

/** our sentence for the code, then the server's own words; anything that is not a GMX code goes to the live notice */
export function GmxErrNotice({ err, raw, children }: { err: GmxErr; /** the thrown error, for the passkey / transport cases */ raw?: unknown; children?: ReactNode }) {
  const t = useT();
  if (err.generic) { const le = liveError(raw); return <LiveErrNotice err={le} tone={le.key === 'passkey_cancelled' ? 'warn' : 'danger'}>{children}</LiveErrNotice>; }
  return <Notice tone="danger"><div data-testid="gmx-error" data-code={err.code}>{t(err.key as Key)}
    {err.detail && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{err.code} ({err.status}) — {err.detail}</span>}{children}</div></Notice>;
}

/** the fee breakdown of an order — every line is an estimate, and says so */
export function EstimateRows({ e, action = 'increase' }: { e: GmxEstimate; action?: 'increase' | 'decrease' }) {
  const t = useT(); const { locale } = useContext(I18n);
  const R = ({ label, note, strong, children }: { label: ReactNode; note?: ReactNode; strong?: boolean; children: ReactNode }) => <div className="py-1">
    <div className="flex items-baseline justify-between gap-3 text-[13.5px]"><span className="min-w-0 text-mute">{label}</span><span className={`shrink-0 whitespace-nowrap text-right ${strong ? 'font-semibold' : 'font-medium'}`}>{children}</span></div>
    {note ? <div className="text-right text-[11.5px] leading-snug text-mute">{note}</div> : null}</div>;
  const rate = (r: { perHour: string; usdPerDay: string }) => `≈ ${usd(r.usdPerDay, locale, true)} ${t('gxPerDay')}`;
  return <div data-testid="gmx-estimate">
    <div className="mb-1 flex items-center justify-between"><span className="text-[12.5px] font-semibold">{t('gxEstTitle')}</span><SourceTag source="estimate" /></div>
    <R label={t('gxEstSize')} strong note={`≈ ${fmt(e.sizeTokens, { locale, dp: 6, trim: true })}`}>{usd(e.sizeUsd, locale)}</R>
    {e.leverage && <R label={t('gxEstLeverage')} note={t('gxEstLeverageNote')}>{lev(e.leverage, locale)}</R>}
    <R label={t('gxEstReference')} note={`${t('gxEstOracle')} ${px(e.oracleMin, locale)} – ${px(e.oracleMax, locale)}`}>{px(e.referencePrice, locale)}</R>
    <R label={t('gxEstAcceptable')} strong note={t(action === 'increase' ? 'gxEstAcceptableNote' : 'gxEstAcceptableNoteClose', { bps: e.slippageBps })}>{px(e.acceptablePrice, locale)}</R>
    <R label={t('gxEstPositionFee')} note={`${fmt(String(e.positionFee.bps), { locale, dp: 2, trim: true })} ${t('gxBpsOfSize')}`}>{usd(e.positionFee.usd, locale)}</R>
    <R label={t('gxEstImpact')} note={`${t('gxEstImpactNote')}${e.priceImpact.capped ? ` ${t('gxEstImpactCapped')}` : ''}`}>{usd(e.priceImpact.usd, locale, true)} ± {usd(e.priceImpact.uncertaintyUsd, locale)}</R>
    <R label={t('gxEstExecFee')} note={t('gxEstExecFeeNote')}>{eth(e.executionFee.eth, locale)}{e.executionFee.usd ? ` · ${usd(e.executionFee.usd, locale)}` : ''}</R>
    <R label={t('gxEstGas')} note={`${t('gxEstGasMax')} ${eth(e.gas.maxEth, locale)}${e.approval ? ` · ${t('gxEstApproval')}` : ''}`}>≈ {eth(e.gas.expectedEth, locale)}{e.gas.usd ? ` · ${usd(e.gas.usd, locale)}` : ''}</R>
    {action === 'increase' && <><R label={t('gxEstFunding')} note={rate(e.funding)}>{pct(e.funding.perHour, 4, locale, true)} / h</R>
      <R label={t('gxEstBorrow')} note={rate(e.borrow)}>{pct(e.borrow.perHour, 4, locale, true)} / h</R>
      <R label={t('gxEstLiq')} note={t('gxEstLiqNote')}>{e.liquidationPrice ? px(e.liquidationPrice, locale) : '—'}</R></>}
    {e.totalAtEntryUsd && <R label={t(action === 'increase' ? 'gxEstTotal' : 'gxEstTotalClose')} strong>{usd(e.totalAtEntryUsd, locale)}</R>}
    <p className="mt-1 text-[11.5px] leading-snug text-mute">{t('gxEstFoot')}</p>
  </div>;
}

/** where an operation is: three steps, one sentence, the reconciled outcome, and the owner's cancel when the delay has passed */
export function GmxOpCard({ op, onCancel }: { op: GmxOperation; onCancel?: (op: GmxOperation) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const w = gmxOpWords(op), done = gmxOpDone(op), dead = op.final && !done, o = op.outcome, order = op.kind !== 'cancel';
  const left = useLeft(op.state === 'created' ? op.cancellableAt : null);
  const steps = (order ? ['gxStepSigned', 'gxStepCreated', 'gxStepExecuted'] : ['gxStepSigned', 'gxStepSent', 'gxStepCancelled']) as Key[];
  return <div className="min-w-0 rounded-2xl border border-line p-3.5" data-testid="gmx-op" data-kind={op.kind} data-state={op.state} data-done={done ? '1' : '0'}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[14px] font-semibold">{t(`gxKind_${op.kind}` as Key)}</span>{op.side && <SideTag side={op.side} />}
      {op.marketName && <span className="min-w-0 truncate text-[12.5px] text-mute">{op.marketName}</span>}
      <span className={`ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${TONE_CLS[w.tone]}`}><Icon n={w.tone === 'ok' ? 'check' : w.tone === 'danger' ? 'x' : 'clock'} className="h-3 w-3" />{t(`gxState_${op.state}` as Key)}</span></div>
    {!dead && op.state !== 'pending_approval' && <ol className="mt-2.5 grid grid-cols-3 gap-1.5" aria-label={t('gxSteps')}>{steps.map((k, n) => { const on = n < w.step || done, cur = n === w.step && !done;
      return <li key={k} className="min-w-0" aria-current={cur ? 'step' : undefined}><div className={`h-1.5 rounded-full ${on ? 'bg-emerald' : cur ? 'bg-blue' : 'bg-elev'}`} /><div className={`mt-1 text-[11px] leading-tight ${on || cur ? 'font-semibold text-ink' : 'text-mute'}`}>{t(k)}</div></li>; })}</ol>}
    <p className="mt-2.5 text-[13px] leading-snug" data-testid="gmx-op-words" role="status">{t(w.key as Key)}</p>
    {o?.reason && <p className="mt-1.5 break-words rounded-lg bg-elev/70 px-2 py-1.5 text-[12px] leading-snug" data-testid="gmx-op-reason"><span className="text-mute">{t('gxReason')} </span>{o.reason}{o.reasonCode ? <span className="block font-mono text-[11px] text-mute">{o.reasonCode}</span> : null}</p>}
    {op.state === 'cancelled' && op.kind === 'increase' && <p className={`mt-1.5 flex items-start gap-1.5 text-[12.5px] font-medium leading-snug ${o?.collateralReturned === true ? 'text-emerald' : 'text-warn'}`} data-testid="gmx-collateral-returned" data-returned={String(o?.collateralReturned ?? null)}>
      <Icon n={o?.collateralReturned === true ? 'check' : 'warn'} className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t(o?.collateralReturned === true ? 'gxReturnedYes' : o?.collateralReturned === false ? 'gxReturnedNo' : 'gxReturnedUnknown', { amount: usdc(o?.collateralOut ?? op.collateral, locale) })}</p>}
    {op.error && <p className="mt-2 break-words rounded-lg bg-elev/70 px-2 py-1.5 font-mono text-[11.5px] text-mute" data-testid="gmx-op-error">{op.error}</p>}
    {order && <div className="mt-2">
      {op.sizeUsd && <Row label={t('gxSize')} strong>{usd(op.sizeUsd, locale)}{op.leverage ? ` · ${lev(op.leverage, locale)}` : ''}</Row>}
      {op.collateral && op.kind === 'increase' && <Row label={t('gxCollateral')}>{usdc(op.collateral, locale)}</Row>}
      {op.state !== 'executed' && op.acceptablePrice && <Row label={t('gxAcceptable')}>{px(op.acceptablePrice, locale)}</Row>}
      {op.state === 'executed' && o && <div data-testid="gmx-outcome">
        <Row label={t('gxExecPrice')} strong>{px(o.executionPrice, locale)}</Row>
        {o.positionFeeUsd && <Row label={t('gxEstPositionFee')}>{usd(o.positionFeeUsd, locale)}</Row>}
        {o.priceImpactUsd && <Row label={t('gxImpactNow')}>{usd(o.priceImpactUsd, locale, true)}</Row>}
        {o.pnlUsd && <Row label={t('gxPnlRealized')}>{usd(o.pnlUsd, locale, true)}</Row>}
        {o.collateralOut && <Row label={t('gxCollateralOut')} strong>{usdc(o.collateralOut, locale)}</Row>}
        {o.executionFeeRefundEth && <Row label={t('gxRefund')}>{eth(o.executionFeeRefundEth, locale)}</Row>}
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mute"><ChainTag />{t('gxOutcomeSource')}</p></div>}
    </div>}
    {op.state === 'created' && order && onCancel && <div className="mt-2 space-y-1">
      <Btn kind="soft" className="!min-h-11 !text-[14px]" disabled={op.cancellableAt === null || left > 0} onClick={() => onCancel(op)} data-testid="gmx-op-cancel"><Icon n="x" className="h-4 w-4" />{t('gxCancelOrder')}</Btn>
      <p className="text-[11.5px] leading-snug text-mute" data-testid="gmx-cancel-wait">{op.cancellableAt === null ? t('gxCancelUnknown') : left > 0 ? t('gxCancelIn', { time: clock(left) }) : t('gxCancelNow')}</p></div>}
    {(o?.explorer ?? op.explorer) && <a href={(o?.explorer ?? op.explorer)!} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] font-medium text-blue underline-offset-2 hover:underline">{t('gxSeeTx')}<Icon n="chev" className="h-3.5 w-3.5" /></a>}
  </div>;
}

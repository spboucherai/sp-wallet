/**
 * Small pieces shared by the GMX screens (v8): the two-step explanation that is always on screen, the estimate rows (every
 * figure labelled as an estimate), the error notice, and the card that says where an operation is. A `created` order is shown
 * as « en attente d'exécution par le réseau GMX », never as executed; « garantie revenue au portefeuille » is written only when
 * the server saw the balance move back (`outcome.collateralReturned === true`). Every sentence is in the `gx` block of i18n.ts.
 *
 * v10: restyled to the design system (venue logo, state tags with icon + word, facts, a stepper whose last step is « fait »
 * only for `executed` / `done`). The state mapping (`gmxOpWords`, `gmxOpDone`) and every sentence are unchanged.
 */
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Fact, Icon, Notice, Tag, Timeline, VenueIcon, type StepState } from '../ui';
import { SideTag } from './bits';
import { fmt, pct, usd } from './dec';
import { gmxOpDone, gmxOpWords, type GmxErr, type GmxEstimate, type GmxOperation } from './gmx';
import { LiveErrNotice, SourceTag, StepBar, WORDS } from './LiveBits';
import { clock, liveError } from './live';

export const TONE_CLS = { ok: 'text-emerald bg-emerald/10', info: 'text-blue bg-blue/10', warn: 'text-warn bg-warn/12', danger: 'text-danger bg-danger/10', mute: 'text-mute bg-elev' } as const;
export const usdc = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, dp: 2 })} USDC`);
export const eth = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, dp: 6, trim: true })} ETH`);
export const px = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : usd(x, locale));
export const lev = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, dp: 2, trim: true })}×`);
/** the venue account of every GMX screen: the band's label, the sheets' sub-title */
export const GMX_LABEL = 'GMX v2 · Arbitrum';
/** « BTC/USD [WBTC.b-USDC] » → BTC: the index asset of a GMX market, for its logo */
export const gmxBase = (marketName: string | null | undefined): string => (marketName ?? '').split('/')[0]!.trim();
/** milliseconds left until `at` (unix ms), re-read twice a second; 0 when it has passed or is unknown */
export function useLeft(at: number | null | undefined): number {
  const [left, setLeft] = useState(() => (at ? Math.max(0, at - Date.now()) : 0));
  useEffect(() => { if (!at) { setLeft(0); return; } const tick = () => setLeft(Math.max(0, at - Date.now())); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [at]);
  return left;
}
export function ChainTag() {
  const t = useT();
  return <span className="src-tag" data-source="chain" title={t('gxSrcChainTitle')}><Icon n="check" className="h-2.5 w-2.5" />{t('gxSrcChain')}</span>;
}

/** always on screen where an order can be made or followed: what « ordre en deux temps » means */
export function TwoStep({ expirationSec, className = '' }: { expirationSec: number; className?: string }) {
  const t = useT();
  const n = (k: number) => <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-elev text-[12px] font-bold" aria-hidden="true">{k}</span>;
  return <div className={`rounded-[18px] border border-line p-3.5 ${className}`} data-testid="gmx-two-step">
    <div className="flex items-center gap-2 text-[13.5px] font-semibold"><Icon n="clock" className="h-4 w-4 shrink-0 text-mute" />{t('gxTwoStepTitle')}</div>
    <ol className="mt-2.5 space-y-2 text-[13px] leading-snug">
      <li className="flex gap-2.5">{n(1)}<span className="min-w-0 pt-0.5">{t('gxTwoStep1')}</span></li>
      <li className="flex gap-2.5">{n(2)}<span className="min-w-0 pt-0.5">{t('gxTwoStep2')}</span></li>
    </ol>
    <p className="mt-2.5 text-[12px] leading-snug text-mute">{t('gxTwoStepCancel', { seconds: expirationSec })}</p></div>;
}

/** our sentence for the code, then the server's own words; anything that is not a GMX code goes to the live notice */
export function GmxErrNotice({ err, raw, children }: { err: GmxErr; /** the thrown error, for the passkey / transport cases */ raw?: unknown; children?: ReactNode }) {
  const t = useT();
  if (err.generic) { const le = liveError(raw); return <LiveErrNotice err={le} tone={le.key === 'passkey_cancelled' ? 'warn' : 'danger'}>{children}</LiveErrNotice>; }
  return <Notice tone="danger"><div data-testid="gmx-error" data-code={err.code}>{t(err.key as Key)}
    {err.detail && <span className={`mt-1.5 ${WORDS}`}>{err.code} ({err.status}) — {err.detail}</span>}{children}</div></Notice>;
}

/** the fee breakdown of an order — every line is an estimate, and says so */
export function EstimateRows({ e, action = 'increase' }: { e: GmxEstimate; action?: 'increase' | 'decrease' }) {
  const t = useT(); const { locale } = useContext(I18n);
  const R = ({ label, note, strong, children }: { label: ReactNode; note?: ReactNode; strong?: boolean; children: ReactNode }) => <div className="border-t border-dashed border-line py-2 first:border-t-0">
    <div className="flex items-baseline justify-between gap-3 text-[14px]"><span className="min-w-0 text-mute">{label}</span><span className={`shrink-0 whitespace-nowrap text-right ${strong ? 'font-semibold' : 'font-medium'}`}>{children}</span></div>
    {note ? <div className="mt-0.5 text-right text-[12px] leading-snug text-mute">{note}</div> : null}</div>;
  const rate = (r: { perHour: string; usdPerDay: string }) => `≈ ${usd(r.usdPerDay, locale, true)} ${t('gxPerDay')}`;
  return <div data-testid="gmx-estimate">
    <div className="mb-1 flex items-center justify-between gap-2"><span className="t-eyebrow">{t('gxEstTitle')}</span><SourceTag source="estimate" /></div>
    <div>
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
    </div>
    <p className="mt-1.5 text-[12px] leading-snug text-mute">{t('gxEstFoot')}</p>
  </div>;
}

/** where an operation is: three steps (icon + word each), one sentence, the reconciled outcome, and the owner's cancel when the delay has passed */
export function GmxOpCard({ op, onCancel, timeline }: { op: GmxOperation; onCancel?: (op: GmxOperation) => void; /** in its own sheet: the steps as a timeline instead of the compact bar of a list */ timeline?: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const w = gmxOpWords(op), done = gmxOpDone(op), dead = op.final && !done, o = op.outcome, order = op.kind !== 'cancel';
  const left = useLeft(op.state === 'created' ? op.cancellableAt : null);
  const steps = (order ? ['gxStepSigned', 'gxStepCreated', 'gxStepExecuted'] : ['gxStepSigned', 'gxStepSent', 'gxStepCancelled']) as Key[];
  // the same mapping as ever: a step is done when the operation went past it, or when the whole operation is done (gmxOpDone);
  // the step a `created` order is at — the keeper's execution — is « en attente », never anything that reads as executed
  const items = steps.map((k, n) => { const state: StepState = n < w.step || done ? 'done' : n === w.step ? 'current' : 'next'; return { key: k, state, title: t(k), stateLabel: t(state === 'done' ? 'dzLvStepDone' : state === 'current' ? 'dzLvStepWait' : 'dzLvStepNext') }; });
  const returned = o?.collateralReturned;
  return <div className="min-w-0 rounded-[18px] border border-line p-4" data-testid="gmx-op" data-kind={op.kind} data-state={op.state} data-done={done ? '1' : '0'}>
    <div className="flex items-start gap-3"><VenueIcon venue="gmx" size={36} />
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="text-[15.5px] font-semibold leading-tight">{t(`gxKind_${op.kind}` as Key)}</span>{op.side && <SideTag side={op.side} />}</div>
        {op.marketName && <div className="mt-0.5 text-[12.5px] leading-snug text-mute [overflow-wrap:anywhere]">{op.marketName}</div>}
        <div className="mt-1.5"><Tag tone={w.tone} icon={w.tone === 'ok' ? 'check' : w.tone === 'danger' ? 'x' : 'clock'}>{t(`gxState_${op.state}` as Key)}</Tag></div></div></div>
    <p className="mt-3 text-[13.5px] leading-snug" data-testid="gmx-op-words" role="status">{t(w.key as Key)}</p>
    {!dead && op.state !== 'pending_approval' && <div className="mt-3.5">{timeline ? <Timeline label={t('gxSteps')} items={items} /> : <StepBar label={t('gxSteps')} items={items} />}</div>}
    {o?.reason && <p className="mt-2.5 break-words rounded-xl bg-elev/70 px-2.5 py-2 text-[12.5px] leading-snug" data-testid="gmx-op-reason"><span className="text-mute">{t('gxReason')} </span>{o.reason}{o.reasonCode ? <span className="block font-mono text-[11px] text-mute">{o.reasonCode}</span> : null}</p>}
    {op.state === 'cancelled' && op.kind === 'increase' && <p className={`mt-2.5 flex items-start gap-2 rounded-xl px-2.5 py-2 text-[13px] font-medium leading-snug ${returned === true ? 'bg-emerald/[0.08] text-emerald' : 'bg-warn/[0.1] text-warn'}`} data-testid="gmx-collateral-returned" data-returned={String(returned ?? null)}>
      <Icon n={returned === true ? 'check' : 'warn'} className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0">{t(returned === true ? 'gxReturnedYes' : returned === false ? 'gxReturnedNo' : 'gxReturnedUnknown', { amount: usdc(o?.collateralOut ?? op.collateral, locale) })}</span></p>}
    {op.error && <p className="mt-2.5 break-words rounded-xl bg-elev/70 px-2.5 py-2 font-mono text-[11.5px] text-mute" data-testid="gmx-op-error">{op.error}</p>}
    {order && <div className="mt-2">
      <dl>
        {op.sizeUsd && <Fact k={t('gxSize')}><span className="font-semibold">{usd(op.sizeUsd, locale)}{op.leverage ? ` · ${lev(op.leverage, locale)}` : ''}</span></Fact>}
        {op.collateral && op.kind === 'increase' && <Fact k={t('gxCollateral')}>{usdc(op.collateral, locale)}</Fact>}
        {op.state !== 'executed' && op.acceptablePrice && <Fact k={t('gxAcceptable')}>{px(op.acceptablePrice, locale)}</Fact>}
      </dl>
      {op.state === 'executed' && o && <div className="border-t border-line" data-testid="gmx-outcome">
        <dl>
          <Fact k={t('gxExecPrice')}><span className="font-semibold">{px(o.executionPrice, locale)}</span></Fact>
          {o.positionFeeUsd && <Fact k={t('gxEstPositionFee')}>{usd(o.positionFeeUsd, locale)}</Fact>}
          {o.priceImpactUsd && <Fact k={t('gxImpactNow')}>{usd(o.priceImpactUsd, locale, true)}</Fact>}
          {o.pnlUsd && <Fact k={t('gxPnlRealized')}>{usd(o.pnlUsd, locale, true)}</Fact>}
          {o.collateralOut && <Fact k={t('gxCollateralOut')}><span className="font-semibold">{usdc(o.collateralOut, locale)}</span></Fact>}
          {o.executionFeeRefundEth && <Fact k={t('gxRefund')}>{eth(o.executionFeeRefundEth, locale)}</Fact>}
        </dl>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-mute"><ChainTag />{t('gxOutcomeSource')}</p></div>}
    </div>}
    {op.state === 'created' && order && onCancel && <div className="mt-3 space-y-1.5">
      <Btn kind="soft" className="!min-h-11 !text-[14px]" disabled={op.cancellableAt === null || left > 0} onClick={() => onCancel(op)} data-testid="gmx-op-cancel"><Icon n="x" className="h-4 w-4" />{t('gxCancelOrder')}</Btn>
      <p className="text-[12px] leading-snug text-mute" data-testid="gmx-cancel-wait">{op.cancellableAt === null ? t('gxCancelUnknown') : left > 0 ? t('gxCancelIn', { time: clock(left) }) : t('gxCancelNow')}</p></div>}
    {(o?.explorer ?? op.explorer) && <a href={(o?.explorer ?? op.explorer)!} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-blue underline-offset-2 hover:underline">{t('gxSeeTx')}<Icon n="ext" className="h-3.5 w-3.5" /></a>}
  </div>;
}

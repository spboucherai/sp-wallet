/**
 * « Déposer » / « Retirer » of a venue account (Hyperliquid): the collateral path between the wallet and the venue.
 *  - Deposit: review (amount, route, who is credited, time, minimum and what happens below it, network fee, venue balance) →
 *    passkey → progress. The screen says « en attente du crédit par la plateforme » until the VENUE's ledger shows the credit;
 *    it never says the money arrived before that, and after the stated time it says exactly what to check.
 *  - Withdrawal: review (amount, the venue's fee, what arrives, the only possible destination: this wallet) → passkey →
 *    progress until the wallet's own chain scan sees the USDC.
 * The real-money band is at the top of both sheets and has no close control. Every sentence is in the `hlc` block of i18n.ts.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Addr, Btn, Field, Icon, inputCls, Notice, Skeleton } from '../ui';
import { ageText, Row, Sheet, timeOf } from './bits';
import { bridgeLink, capi, COLLATERAL_CODES, depositIntegrity, depositProblem, opDone, opWords, withdrawIntegrity, withdrawProblem, type CollateralOp, type CollateralStatus, type DepositPrepared, type WithdrawPrepared } from './collateral';
import { fmt, usd } from './dec';
import { Bullet, LiveErrNotice, ModeBand, SourceTag } from './LiveBits';
import { liveError, toneOf, type LiveErr, type LiveSummary } from './live';
import { refreshLive } from './liveStore';

const statusKey = (id: string) => ['deriv', 'live', 'collateral', 'status', id] as const;
const TONE_CLS = { ok: 'text-emerald bg-emerald/10', info: 'text-blue bg-blue/10', warn: 'text-warn bg-warn/12', danger: 'text-danger bg-danger/10' } as const;
const usdc = (x: string | null | undefined, locale: string) => (x === null || x === undefined ? '—' : `${fmt(x, { locale, trim: true })} USDC`);
const dur = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

function ErrNotice({ err }: { err: LiveErr }) {
  const t = useT();
  if (!COLLATERAL_CODES.has(err.code)) return <LiveErrNotice err={err} tone={err.key === 'passkey_cancelled' ? 'warn' : 'danger'} />;
  return <Notice tone="danger"><div data-testid="collateral-error" data-code={err.code}>{t(`hlcE_${err.code}` as Key)}
    {err.detail && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{err.code} ({err.status}) — {err.detail}</span>}</div></Notice>;
}

/** where an operation is: four steps, one sentence, the venue balance before and after, and what to check when it is late */
export function OpProgress({ op }: { op: CollateralOp }) {
  const t = useT(); const { locale } = useContext(I18n);
  const w = opWords(op), steps = (op.kind === 'deposit' ? ['hlcStepSigned', 'hlcStepOnChain', 'hlcStepAwaitCredit', 'hlcStepCredited'] : ['hlcStepSigned', 'hlcStepVenue', 'hlcStepPayout', 'hlcStepArrived']) as Key[];
  const dead = op.final && !opDone(op);
  return <div className="min-w-0 rounded-2xl border border-line p-3.5" data-testid="collateral-op" data-kind={op.kind} data-state={op.state} data-done={opDone(op) ? '1' : '0'}>
    <div className="flex flex-wrap items-center gap-2"><span className="text-[14px] font-semibold">{t(op.kind === 'deposit' ? 'hlcDeposit' : 'hlcWithdraw')} · {usdc(op.amount, locale)}</span>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${TONE_CLS[w.tone]}`}><Icon n={w.tone === 'ok' ? 'check' : w.tone === 'danger' ? 'x' : 'clock'} className="h-3 w-3" />{t(`hlcState_${w.tone === 'ok' ? 'done' : dead ? 'stopped' : op.overdue ? 'late' : 'progress'}` as Key)}</span></div>
    {!dead && <ol className="mt-2.5 grid grid-cols-4 gap-1.5" aria-label={t('hlcSteps')}>{steps.map((k, n) => { const on = n < w.step || opDone(op), cur = n === w.step && !opDone(op);
      return <li key={k} className="min-w-0" aria-current={cur ? 'step' : undefined}><div className={`h-1.5 rounded-full ${on ? 'bg-emerald' : cur ? 'bg-blue' : 'bg-elev'}`} /><div className={`mt-1 text-[11px] leading-tight ${on || cur ? 'font-semibold text-ink' : 'text-mute'}`}>{t(k)}</div></li>; })}</ol>}
    <p className="mt-2.5 text-[13px] leading-snug" data-testid="collateral-op-words" role="status">{t(w.key as Key, { seconds: dur(op.expectedSeconds), network: op.chainNetworkName ?? '' })}</p>
    {op.overdue && <div className="mt-2"><Notice tone="warn"><div data-testid="collateral-overdue"><b className="font-semibold">{t('hlcCheckTitle', { age: ageText(op.sentAt === null ? null : Date.now() - op.sentAt) })}</b>
      <ol className="mt-1.5 list-decimal space-y-1 pl-5 [overflow-wrap:anywhere]">{op.check.map((c) => <li key={c}>{t(`hlcCheck_${c}` as Key)}</li>)}</ol></div></Notice></div>}
    {op.error && <p className="mt-2 break-words rounded-lg bg-elev/70 px-2 py-1.5 font-mono text-[11.5px] text-mute" data-testid="collateral-op-error">{op.error}</p>}
    <div className="mt-2">
      {op.balanceBefore && <Row label={t('hlcBalBefore')}>{usdc(op.balanceBefore.total, locale)}</Row>}
      <Row label={t('hlcBalAfter')} strong>{op.balanceAfter ? usdc(op.balanceAfter.total, locale) : t(opDone(op) ? 'hlcBalUnread' : 'hlcBalNotYet')}</Row>
      {op.kind === 'withdraw' && op.fee && <Row label={t('hlcFeeVenue')}>{usdc(op.ledger?.fee ?? op.fee, locale)}{op.ledger?.fee ? ` · ${t('hlcFeeCharged')}` : ''}</Row>}
      {op.kind === 'withdraw' && <Row label={t(op.arrival ? 'hlcReceived' : 'hlcReceiveExpected')}>{op.arrival ? usdc(String(Number(op.arrival.amount) / 1e6), locale) : usdc(op.expectedReceive, locale)}</Row>}
      {op.venueAt && <Row label={t('hlcVenueAt')}>{timeOf(op.venueAt, locale, true)}</Row>}
    </div>
    {op.explorer && <a href={op.explorer} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] font-medium text-blue underline-offset-2 hover:underline">{t('hlcSeeTx', { network: op.chainNetworkName ?? '' })}<Icon n="chev" className="h-3.5 w-3.5" /></a>}
    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-mute"><SourceTag />{t('hlcOpSource')}</p>
  </div>;
}

type Step = 'form' | 'preparing' | 'review' | 'passkey' | 'sending' | 'progress';
function useOp(accountId: string, opId: string | null) {
  // while the money is on its way the operation is read every few seconds; the server re-reads the venue and the chain each time
  return useQuery({ queryKey: ['deriv', 'live', 'collateral', 'op', opId], enabled: !!opId, queryFn: () => capi.operation(accountId, opId!), refetchInterval: (q) => (q.state.data?.final ? false : 4000), retry: 0 });
}
const useCountdown = (expiresAt: number | null | undefined) => {
  const [left, setLeft] = useState(0);
  useEffect(() => { if (!expiresAt) return; const tick = () => setLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000))); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [expiresAt]);
  return left;
};

function DepositSheet({ account, status, onClose }: { account: LiveSummary; status: CollateralStatus; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const r = status.route!, wl = status.wallet!, tone = toneOf(account);
  const [raw, setRaw] = useState(''), [step, setStep] = useState<Step>('form'), [prep, setPrep] = useState<DepositPrepared | null>(null), [err, setErr] = useState<LiveErr | null>(null), [bad, setBad] = useState<string | null>(null), [opId, setOpId] = useState<string | null>(null);
  const lock = useRef(false);
  const once = async (fn: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await fn(); } finally { lock.current = false; } };
  const v = depositProblem(raw, status), busy = step === 'preparing' || step === 'passkey' || step === 'sending';
  const op = useOp(account.id, opId), left = useCountdown(step === 'review' || step === 'passkey' ? prep?.operation.expiresAt : null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: statusKey(account.id) }); void refreshLive(qc, account.id); };
  useEffect(() => { if (op.data?.final) refresh(); }, [op.data?.final]); // eslint-disable-line react-hooks/exhaustive-deps

  const prepare = () => once(async () => {
    if (!v.amount) return;
    setStep('preparing'); setErr(null); setBad(null);
    try { const p = await capi.prepareDeposit(account.id, v.amount); setBad(depositIntegrity(p, status, v.amount)); setPrep(p); setStep('review'); }
    catch (e) { setErr(liveError(e)); setStep('form'); }
  });
  const approve = () => once(async () => {
    if (!prep || bad) return;
    setStep('passkey'); setErr(null);
    let assertion: unknown;
    try { assertion = await startAuthentication({ optionsJSON: prep.options }); }
    catch (e) { setErr(liveError(e)); setStep('review'); return; }               // nothing was sent
    setStep('sending');
    try { await capi.approveDeposit(account.id, prep.operation.id, assertion); setOpId(prep.operation.id); setStep('progress'); refresh(); }
    catch (e) { setErr(liveError(e, 'approve')); setOpId(prep.operation.id); setStep('progress'); refresh(); }   // the operation itself says what happened (refused: nothing left the wallet)
  });
  const back = () => { if (prep) void capi.cancel(account.id, prep.operation.id).catch(() => {}); setPrep(null); setStep('form'); setErr(null); };

  return <Sheet title={t('hlcDepositTitle', { network: account.network })} onClose={() => { if (!busy) { if (prep && step === 'review') void capi.cancel(account.id, prep.operation.id).catch(() => {}); onClose(); } }}>
    <div className="min-w-0 space-y-3" data-testid="deposit-sheet" data-step={step}>
      <ModeBand tone={tone} label={account.label} />
      {(step === 'form' || step === 'preparing') && <>
        <Field label={t('hlcAmount')} hint={t('hlcDepositHint', { min: r.minimum, venueMin: r.venueMinimum, max: fmt(wl.limits.maxNow, { locale, trim: true }) })}>
          <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" aria-label={t('hlcAmount')} value={raw} onChange={(e) => { setRaw(e.target.value.replace(/[^0-9.,]/g, '')); setErr(null); }} data-testid="deposit-amount" /><span className="w-12 shrink-0 text-[12.5px] text-mute">USDC</span></div></Field>
        <div className="rounded-2xl bg-elev/70 p-3"><Row label={t('hlcWalletHas', { network: r.networkName })} strong>{usdc(wl.usdc, locale)}</Row><Row label={t('hlcWalletGas')}>{fmt(wl.gas, { locale, dp: 6, trim: true })} {wl.gasSymbol}</Row>
          <Row label={t('hlcLimitTx')}>{usdc(wl.limits.perTransfer, locale)}</Row><Row label={t('hlcLimitDay')}>{usdc(wl.limits.perDay, locale)} · {t('hlcLimitSpent', { spent: fmt(wl.limits.spentToday, { locale, trim: true }) })}</Row></div>
        <Notice tone="warn"><div data-testid="deposit-minimum"><b className="font-semibold">{t('hlcMinTitle', { min: r.minimum })}</b> {t('hlcMinBody', { venueMin: r.venueMinimum, min: r.minimum })}</div></Notice>
        {v.problem && <Notice tone="danger"><div data-testid="deposit-problem">{t(v.problem, { min: r.minimum, venueMin: r.venueMinimum, have: fmt(wl.usdc, { locale, trim: true }), limit: fmt(wl.limits.perTransfer, { locale, trim: true }), network: r.networkName })}</div></Notice>}
        {err && <ErrNotice err={err} />}
        <Btn full busy={step === 'preparing'} disabled={!v.amount} onClick={() => void prepare()} data-testid="deposit-review">{t('hlcReview')}</Btn>
        {step === 'preparing' && <p className="text-center text-[12px] text-mute">{t('hlcPreparing')}</p>}
      </>}

      {prep && (step === 'review' || step === 'passkey' || step === 'sending') && <>
        <div className="rounded-2xl border border-line p-3.5" data-testid="deposit-facts">
          <Row label={t('hlcAmount')} strong>{usdc(prep.operation.amount, locale)}</Row>
          <Row label={t('hlcRoute')}>{t('hlcRouteValue', { network: prep.route.networkName })}</Row>
          <Row label={t('hlcTime')}>{t('hlcTimeDeposit', { seconds: dur(prep.route.expectedSeconds) })}</Row>
          <Row label={t('hlcMinimum')}>{usdc(prep.route.minimum, locale)} · {t('hlcMinimumVenue', { venueMin: prep.route.venueMinimum })}</Row>
          <Row label={t('hlcFeeNetwork', { network: prep.route.networkName })}>≈ {fmt(prep.fee.estimate, { locale, dp: 7, trim: true })} {prep.fee.symbol} · max {fmt(prep.fee.max, { locale, dp: 7, trim: true })}</Row>
          <Row label={t('hlcFeeVenue')}>0 USDC</Row>
          <Row label={t('hlcBalBefore')}>{usdc(prep.venueBalance.total, locale)}</Row>
        </div>
        <ul className="space-y-2 text-[13px] leading-snug" data-testid="deposit-says">
          <Bullet icon="key">{t('hlcCreditsSender')}<span className="mt-1 block"><Addr value={prep.intent.from} /></span></Bullet>
          <Bullet icon="shield">{t('hlcBridgePinned')}<span className="mt-1 block"><Addr value={prep.intent.to} /></span></Bullet>
          <Bullet icon="warn" tone="text-warn">{t('hlcLostBelow', { venueMin: prep.route.venueMinimum, min: prep.route.minimum })}</Bullet>
          <Bullet icon="clock">{t('hlcNotBefore')}</Bullet>
          <Bullet icon="check" tone="text-emerald">{t('hlcLiveness')}<span className="mt-0.5 block break-words font-mono text-[11px] text-mute">{prep.liveness.detail} · {timeOf(prep.liveness.checkedAt, locale)}</span></Bullet>
        </ul>
        <p className="break-all font-mono text-[10.5px] text-mute">{t('fingerprint')} SHA-256 {prep.operation.hash}</p>
        {bad && <Notice tone="danger"><div data-testid="collateral-integrity">{t(`hlcIntegrity_${bad}` as Key)}</div></Notice>}
        {step === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
        {err && <ErrNotice err={err} />}
        <Btn full kind={tone === 'mainnet' ? 'danger' : 'primary'} busy={step !== 'review'} disabled={!!bad || left === 0} onClick={() => void approve()} data-testid="deposit-approve"><Icon n="key" className="h-4 w-4" />{t('hlcDepositApprove', { amount: fmt(prep.operation.amount, { locale, trim: true }) })}</Btn>
        <p className="text-center text-[12px] text-mute">{left > 0 ? `${t('expiresIn')} ${left} s` : t('hlcExpired')}</p>
        <Btn full kind="ghost" disabled={busy} onClick={back}>{t('hlcBack')}</Btn>
      </>}

      {step === 'progress' && <div className="space-y-3" data-testid="deposit-progress">
        {op.data ? <OpProgress op={op.data} /> : <Skeleton h="h-32" />}
        {err && !op.data?.final && <ErrNotice err={err} />}
        <p className="text-[12px] leading-snug text-mute">{t('hlcCloseSafe')}</p>
        <Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></div>}
    </div>
  </Sheet>;
}

function WithdrawSheet({ account, status, onClose }: { account: LiveSummary; status: CollateralStatus; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const wd = status.withdrawal, tone = toneOf(account);
  const [raw, setRaw] = useState(''), [step, setStep] = useState<Step>('form'), [prep, setPrep] = useState<WithdrawPrepared | null>(null), [err, setErr] = useState<LiveErr | null>(null), [bad, setBad] = useState<string | null>(null), [opId, setOpId] = useState<string | null>(null);
  const lock = useRef(false);
  const once = async (fn: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await fn(); } finally { lock.current = false; } };
  const v = withdrawProblem(raw, status), busy = step === 'preparing' || step === 'passkey' || step === 'sending';
  const op = useOp(account.id, opId), left = useCountdown(step === 'review' || step === 'passkey' ? prep?.operation.expiresAt : null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: statusKey(account.id) }); void refreshLive(qc, account.id); };
  useEffect(() => { if (op.data?.final) { refresh(); void qc.invalidateQueries({ queryKey: ['portfolio'] }); } }, [op.data?.final]); // eslint-disable-line react-hooks/exhaustive-deps

  const prepare = () => once(async () => {
    if (!v.amount) return;
    setStep('preparing'); setErr(null); setBad(null);
    try { const p = await capi.prepareWithdraw(account.id, v.amount); setBad(withdrawIntegrity(p, status, v.amount)); setPrep(p); setStep('review'); }
    catch (e) { setErr(liveError(e)); setStep('form'); }
  });
  const approve = () => once(async () => {
    if (!prep || bad) return;
    setStep('passkey'); setErr(null);
    let assertion: unknown;
    try { assertion = await startAuthentication({ optionsJSON: prep.options }); }
    catch (e) { setErr(liveError(e)); setStep('review'); return; }
    setStep('sending');
    try { await capi.approveWithdraw(account.id, prep.operation.id, assertion); } catch (e) { setErr(liveError(e, 'approve')); }
    setOpId(prep.operation.id); setStep('progress'); refresh();
  });
  const back = () => { if (prep) void capi.cancel(account.id, prep.operation.id).catch(() => {}); setPrep(null); setStep('form'); setErr(null); };

  return <Sheet title={t('hlcWithdrawTitle', { network: account.network })} onClose={() => { if (!busy) { if (prep && step === 'review') void capi.cancel(account.id, prep.operation.id).catch(() => {}); onClose(); } }}>
    <div className="min-w-0 space-y-3" data-testid="withdraw-sheet" data-step={step}>
      <ModeBand tone={tone} label={account.label} />
      {(step === 'form' || step === 'preparing') && <>
        <Field label={t('hlcAmount')} hint={t('hlcWithdrawHint', { fee: wd.fee })}>
          <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" aria-label={t('hlcAmount')} value={raw} onChange={(e) => { setRaw(e.target.value.replace(/[^0-9.,]/g, '')); setErr(null); }} data-testid="withdraw-amount" /><span className="w-12 shrink-0 text-[12.5px] text-mute">USDC</span></div></Field>
        <div className="rounded-2xl bg-elev/70 p-3"><Row label={t('hlcVenueAvailable')} strong>{usdc(wd.available, locale)}</Row><Row label={t('hlcFeeVenue')}>{usdc(wd.fee, locale)}</Row>
          <Row label={t('hlcReceiveExpected')} strong>{v.receive ? usdc(v.receive, locale) : '—'}</Row></div>
        {v.problem && <Notice tone="danger"><div data-testid="withdraw-problem">{t(v.problem, { fee: wd.fee, have: fmt(wd.available ?? '0', { locale, trim: true }) })}</div></Notice>}
        {err && <ErrNotice err={err} />}
        <Btn full busy={step === 'preparing'} disabled={!v.amount} onClick={() => void prepare()} data-testid="withdraw-review">{t('hlcReview')}</Btn>
      </>}

      {prep && (step === 'review' || step === 'passkey' || step === 'sending') && <>
        <div className="rounded-2xl border border-line p-3.5" data-testid="withdraw-facts">
          <Row label={t('hlcAmount')} strong>{usdc(prep.withdrawal.amount, locale)}</Row>
          <Row label={t('hlcFeeVenue')}>{usdc(prep.withdrawal.fee, locale)}</Row>
          <Row label={t('hlcReceiveExpected')} strong>{usdc(prep.receive, locale)}</Row>
          <Row label={t('hlcRoute')}>{t('hlcRouteBack', { network: wd.payoutNetworkName })}</Row>
          <Row label={t('hlcTime')}>{t('hlcTimeWithdraw', { seconds: dur(wd.expectedSeconds) })}</Row>
          <Row label={t('hlcBalBefore')}>{usdc(prep.venueBalance.total, locale)}</Row>
        </div>
        <ul className="space-y-2 text-[13px] leading-snug" data-testid="withdraw-says">
          <Bullet icon="shield">{t('hlcOwnOnly')}<span className="mt-1 block"><Addr value={prep.withdrawal.destination} /></span></Bullet>
          <Bullet icon="key">{t('hlcSignedMain')}<span className="mt-0.5 block break-words font-mono text-[11px] text-mute">{prep.whatIsSigned.byMainKey}</span></Bullet>
          <Bullet icon="clock">{t(wd.arrivalTracked ? 'hlcNotBeforeArrival' : 'hlcUntracked', { network: wd.payoutNetworkName })}</Bullet>
        </ul>
        <p className="break-all font-mono text-[10.5px] text-mute">{t('fingerprint')} SHA-256 {prep.hash}</p>
        {bad && <Notice tone="danger"><div data-testid="collateral-integrity">{t(`hlcIntegrity_${bad}` as Key)}</div></Notice>}
        {step === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
        {err && <ErrNotice err={err} />}
        <Btn full kind={tone === 'mainnet' ? 'danger' : 'primary'} busy={step !== 'review'} disabled={!!bad || left === 0} onClick={() => void approve()} data-testid="withdraw-approve"><Icon n="key" className="h-4 w-4" />{t('hlcWithdrawApprove', { amount: fmt(prep.withdrawal.amount, { locale, trim: true }) })}</Btn>
        <p className="text-center text-[12px] text-mute">{left > 0 ? `${t('expiresIn')} ${left} s` : t('hlcExpired')}</p>
        <Btn full kind="ghost" disabled={busy} onClick={back}>{t('hlcBack')}</Btn>
      </>}

      {step === 'progress' && <div className="space-y-3" data-testid="withdraw-progress">
        {op.data ? <OpProgress op={op.data} /> : <Skeleton h="h-32" />}
        {err && !op.data?.final && <ErrNotice err={err} />}
        <p className="text-[12px] leading-snug text-mute">{t('hlcCloseSafe')}</p>
        <Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></div>}
    </div>
  </Sheet>;
}

/** inside a venue account card: the venue balance, the two buttons with the reason when one is closed, and the operations */
export function CollateralPanel({ account }: { account: LiveSummary }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: statusKey(account.id), queryFn: () => capi.status(account.id), retry: 0,
    refetchInterval: (x) => (x.state.data?.operations.some((o) => !o.final && o.state !== 'pending_approval') ? 5000 : 30_000) });
  const [sheet, setSheet] = useState<'deposit' | 'withdraw' | null>(null);
  const s = q.data;
  if (q.isLoading) return <Skeleton h="h-20" />;
  if (!s) return <Notice tone="warn"><div data-testid="collateral-unavailable">{t('hlcUnavailable')}{q.error ? <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{liveError(q.error).detail || liveError(q.error).code}</span> : null}</div></Notice>;
  const shown = s.operations.filter((o) => o.state !== 'cancelled' && o.state !== 'pending_approval' && o.state !== 'expired').slice(0, 3);
  const dep = s.deposit, wd = s.withdraw;
  return <div className="min-w-0 rounded-2xl border border-line p-3.5" data-testid="collateral-panel">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13.5px] font-semibold">{t('hlcTitle')}</span>
      <span className="text-[13px]">{t('hlcAtVenue')} <b className="font-semibold" data-testid="collateral-venue-balance">{s.venueBalance.error ? '—' : usd(s.venueBalance.total, locale)}</b></span></div>
    <div className="mt-2.5 flex flex-wrap gap-2">
      <Btn disabled={!dep.available} onClick={() => setSheet('deposit')} data-testid="collateral-deposit"><Icon n="down" className="h-4 w-4" />{t('hlcDeposit')}</Btn>
      <Btn kind="soft" disabled={!wd.available} onClick={() => setSheet('withdraw')} data-testid="collateral-withdraw"><Icon n="up" className="h-4 w-4" />{t('hlcWithdraw')}</Btn>
    </div>
    {!dep.available && dep.reason && <p className="mt-2 text-[12.5px] leading-snug text-mute" data-testid="deposit-why" data-reason={dep.reason}>{t(`hlcWhy_${dep.reason}` as Key, { network: s.route?.networkName ?? '', min: s.route?.minimum ?? '' })}
      {s.walletError && dep.reason === 'wallet_unreadable' ? <span className="mt-0.5 block break-words font-mono text-[11px]">{s.walletError}</span> : null}</p>}
    {dep.reason === 'usdc_elsewhere' && s.route && <ul className="mt-1.5 space-y-1" data-testid="collateral-bridge-links">{dep.bridgeFrom.map((b) => <li key={b.network}>
      <a href={bridgeLink(b.network, s.route!.network)} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] font-medium text-blue">
        <Icon n="swap" className="h-4 w-4" />{t('hlcBridgeLink', { from: b.name, to: s.route!.networkName, amount: fmt(b.usdc, { locale, trim: true }) })}</a></li>)}</ul>}
    {!wd.available && wd.reason && wd.reason !== dep.reason && <p className="mt-2 text-[12.5px] leading-snug text-mute" data-testid="withdraw-why">{t(`hlcWhy_${wd.reason}` as Key, { network: '', min: '' })}</p>}
    {s.route && <p className="mt-2 text-[12px] leading-snug text-mute">{t('hlcPanelNote', { min: s.route.minimum, network: s.route.networkName, fee: s.withdrawal.fee })}</p>}
    {s.venueBalance.abstraction && s.venueBalance.abstraction !== 'default' && <p className="mt-1 text-[12px] leading-snug text-mute">{t('hlcUnifiedNote')} <span className="font-mono text-[11px]">{s.venueBalance.abstraction}</span></p>}
    {shown.length > 0 && <ul className="mt-3 space-y-2" data-testid="collateral-ops">{shown.map((o) => <li key={o.id}><OpProgress op={o} /></li>)}</ul>}
    {sheet === 'deposit' && s.route && s.wallet && <DepositSheet account={account} status={s} onClose={() => { setSheet(null); void q.refetch(); }} />}
    {sheet === 'withdraw' && <WithdrawSheet account={account} status={s} onClose={() => { setSheet(null); void q.refetch(); }} />}
  </div>;
}

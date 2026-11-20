/**
 * The venue policy of GMX (v8), approved once with the passkey together with the jurisdiction acknowledgement:
 *   form (markets, maximum leverage, maximum order size, orders per day, price band, duration) → POST /authorization/prepare →
 *   the acknowledgement text of the server, in full, in a box that must be read (a checkbox), and the exact policy that will be
 *   enforced by the signer → passkey → POST /authorization/approve. The passkey is asked for nothing the sheet did not show.
 *
 * v10: same fields, same order — the policy as a receipt under its eyebrow title, the acknowledgement checkbox as a large
 * row, one unmistakable real-money approval button; the sheet is `LiveSheet` with the real-money tag in its title area.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { ApprovalOutcomePanel, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says

import { useQueryClient } from '@tanstack/react-query';
import { useContext, useRef, useState } from 'react';
import { amountInputText, sanitizeAmountText } from '../amount';   // v8 hardening: the wallet's single rule for typed amounts
import { AmountProblem } from '../amountUi';
import { I18n, useT, type Key } from '../i18n';
import { AssetIcon, Btn, Fact, Field, Icon, inputCls, Notice } from '../ui';
import { timeOf } from './bits';
import { fmt, usd } from './dec';
import { gapi, GMX_STATUS_KEY, gmxAuthFromForm, gmxError, type GmxAuthForm, type GmxAuthPrepared, type GmxErr, type GmxStatus } from './gmx';
import { eth, GMX_LABEL, GmxErrNotice } from './GmxBits';
import { Bullet, Fingerprint, Group, LiveSheet, ModeBand, TICKET } from './LiveBits';

type Step = 'form' | 'preparing' | 'review' | 'passkey' | 'sending' | 'done';
const digits = (s: string) => s.replace(/[^0-9]/g, '');

export function GmxAuthorize({ status, onClose }: { status: GmxStatus; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const prev = status.authorization?.policy;
  const [f, setF] = useState<GmxAuthForm>(() => ({ markets: (prev?.allowedMarkets.length ? status.markets.filter((m) => prev.allowedMarkets.some((a) => a.toLowerCase() === m.market.toLowerCase())) : status.markets).map((m) => m.market),
    maxLeverage: String(prev?.maxLeverage ?? 3), maxOrderSizeUsd: amountInputText(prev?.maxOrderSizeUsd ?? '100', locale), maxOrdersPerDay: String(prev?.maxOrdersPerDay ?? 10), bandBps: String(prev?.maxPriceDeviationBps ?? 100), days: '30' }));
  const [step, setStep] = useState<Step>('form'), [p, setP] = useState<GmxAuthPrepared | null>(null), [read, setRead] = useState(false), [err, setErr] = useState<{ e: GmxErr; raw: unknown } | null>(null);
  const lock = useRef(false);
  const ap = useApprovalOutcome<GmxStatus>();
  const once = async (fn: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await fn(); } finally { lock.current = false; } };
  const v = gmxAuthFromForm(f, locale), busy = step === 'preparing' || step === 'passkey' || step === 'sending';
  const set = (k: keyof GmxAuthForm, val: string) => { setF({ ...f, [k]: val }); setErr(null); };
  const toggle = (m: string) => { setF({ ...f, markets: f.markets.includes(m) ? f.markets.filter((x) => x !== m) : [...f.markets, m] }); setErr(null); };

  const prepare = () => once(async () => {
    if (!v.ok) return;
    setStep('preparing'); setErr(null); setRead(false);
    try { setP(await gapi.prepareAuthorization(v.body)); setStep('review'); }
    catch (e) { setErr({ e: gmxError(e), raw: e }); setStep('form'); }
  });
  const approve = () => once(async () => {
    if (!p || !read) return;
    setStep('passkey'); setErr(null);
    let a: unknown;
    try { a = await startAuthentication({ optionsJSON: p.options }); }
    catch (e) { setErr({ e: gmxError(e), raw: e }); setStep('review'); return; }   // nothing was approved
    setStep('sending');
    // NEXT W1: a lost answer is settled by the status read from the server (is a NEW authorization active?), never by the error
    const before = status.authorization, took = (s: GmxStatus) => { qc.setQueryData([...GMX_STATUS_KEY, locale], s); void qc.invalidateQueries({ queryKey: GMX_STATUS_KEY }); setStep('done'); };
    await ap.run({ submit: () => gapi.approveAuthorization(p.authorization, a), read: () => gapi.status(locale),
      applied: (s) => s.authorization?.state === 'active' && (s.authorization.id !== before?.id || s.authorization.createdAt !== before?.createdAt) }, (o) => {
      if (o.kind === 'refused') { setErr({ e: gmxError(o.error), raw: o.error }); setStep('review'); }
      else if (o.kind === 'read' && !o.applied) setStep('review');
      else took(o.kind === 'answered' ? o.value : o.state);
    });
  });

  const pol = p ? { ...(v.ok ? v.body : {}), ...(p.authorization.policy ?? {}) } as Partial<GmxAuthPrepared['authorization']['policy'] & { days: number }> : null;
  const name = (m: string) => status.markets.find((x) => x.market.toLowerCase() === m.toLowerCase())?.name ?? m;
  const num = (k: keyof GmxAuthForm, label: Key, hint: Key, unit: string, testid: string) => <Field label={t(label)} hint={t(hint)}>
    <div className="relative"><input className={`${inputCls} pr-16 font-semibold`} inputMode="numeric" autoComplete="off" aria-label={t(label)} value={f[k] as string} onChange={(e) => set(k, k === 'maxOrderSizeUsd' ? sanitizeAmountText(e.target.value) : digits(e.target.value))} data-testid={testid} />
      <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[0.8125rem] font-medium text-mute">{unit}</span></div>{k === 'maxOrderSizeUsd' && <AmountProblem ambiguousOnly text={f.maxOrderSizeUsd} />}</Field>;
  return <LiveSheet title={t('gxAuthTitle')} wide tone="mainnet" label={GMX_LABEL} busy={busy} onClose={onClose}>
    <div className="min-w-0 space-y-4" data-testid="gmx-authorize" data-step={step}>
      <ModeBand tone="mainnet" label={GMX_LABEL} compact />
      <ApprovalOutcomePanel ap={ap} />
      {(step === 'form' || step === 'preparing') && <>
        <p className="text-[0.84375rem] leading-snug">{t('gxAuthIntro')}</p>
        <fieldset className="min-w-0"><legend className="mb-2 text-[0.8125rem] font-medium text-mute">{t('gxAuthMarkets')}</legend>
          <div className="space-y-2">{status.markets.map((m) => { const on = f.markets.includes(m.market); return <label key={m.market} className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2 text-[0.90625rem] ${on ? 'border-ink bg-elev/50' : 'border-line'}`}>
            <AssetIcon sym={m.base} size={32} /><span className="min-w-0 flex-1"><span className="block font-semibold leading-tight [overflow-wrap:anywhere]">{m.name}</span><span className="block text-[0.75rem] text-mute">{m.collateral.map((c) => c.symbol).join(', ')}</span></span>
            <input type="checkbox" className="h-[22px] w-[22px] shrink-0 accent-[var(--blue)]" checked={on} onChange={() => toggle(m.market)} data-testid={`gmx-auth-market-${m.base}`} /></label>; })}</div></fieldset>
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
          {num('maxLeverage', 'gxAuthLeverage', 'gxAuthLeverageHint', '×', 'gmx-auth-leverage')}
          {num('maxOrderSizeUsd', 'gxAuthOrder', 'gxAuthOrderHint', 'USD', 'gmx-auth-order')}
          {num('maxOrdersPerDay', 'gxAuthPerDay', 'gxAuthPerDayHint', t('gxPerDayUnit'), 'gmx-auth-perday')}
          {num('bandBps', 'gxAuthBand', 'gxAuthBandHint', t('gxBps'), 'gmx-auth-band')}
          {num('days', 'gxAuthDays', 'gxAuthDaysHint', t('gxDaysUnit'), 'gmx-auth-days')}
        </div>
        {!v.ok && <Notice tone="warn"><div data-testid="gmx-auth-problem" data-problem={v.problem}>{t(`gxAuthP_${v.problem}` as Key)}</div></Notice>}
        {err && <GmxErrNotice err={err.e} raw={err.raw} />}
        <Btn full busy={step === 'preparing'} disabled={!v.ok} onClick={() => void prepare()} data-testid="gmx-auth-prepare">{t('gxAuthPrepare')}</Btn>
      </>}

      {p && pol && (step === 'review' || step === 'passkey' || step === 'sending') && <>
        <Group title={t('gxAckTitle')}>
          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-[18px] border border-line bg-elev/50 p-4 text-[0.84375rem] leading-relaxed" tabIndex={0} data-testid="gmx-ack-text">{p.ack.text}</div>
          <p className="mt-1.5 break-all font-mono text-[0.65625rem] leading-snug text-mute">{t('gxAckVersion', { version: p.ack.version })} · SHA-256 {p.ack.sha256}</p></Group>
        <Group title={t('gxAuthPolicyTitle')}>
          <div className={TICKET}><dl className="receipt" data-testid="gmx-auth-policy">
            <Fact k={t('gxAuthMarkets')}><span className="block font-semibold">{(pol.allowedMarkets ?? []).map((m) => <span key={m} className="block">{name(m)}</span>)}</span></Fact>
            <Fact k={t('gxAuthCollateral')}><span className="inline-flex items-center justify-end gap-1.5"><AssetIcon sym="USDC" net="arbitrum" size={18} />USDC</span></Fact>
            <Fact k={t('gxAuthLeverage')}><span className="font-semibold">{pol.maxLeverage}×</span></Fact>
            <Fact k={t('gxAuthOrder')}><span className="font-semibold">{usd(pol.maxOrderSizeUsd, locale)}</span></Fact>
            <Fact k={t('gxAuthPerDay')}>{pol.maxOrdersPerDay}</Fact>
            <Fact k={t('gxAuthBand')}>{pol.maxPriceDeviationBps} {t('gxBps')} ({fmt(String((pol.maxPriceDeviationBps ?? 0) / 100), { locale, trim: true })} %)</Fact>
            <Fact k={t('gxAuthExecFee')}>{eth(p.maxExecutionFeeEth, locale)}</Fact>
            <Fact k={t('gxAuthUntil')}>{p.authorization.expiresAt ? timeOf(p.authorization.expiresAt * 1000, locale, true) : t('gxAuthDaysValue', { days: v.ok ? v.body.days : '—' })}</Fact>
          </dl></div></Group>
        <ul className="space-y-2 text-[0.8125rem] leading-snug text-mute">
          <Bullet icon="shield">{t('gxAuthSigner')}</Bullet>
          <Bullet icon="key">{t('gxAuthEach')}</Bullet>
          <Bullet icon="x">{t('gxAuthRevocable')}</Bullet></ul>
        <Fingerprint>{t('fingerprint')} SHA-256 {p.hash}</Fingerprint>
        <label className="ack-row !items-start !font-medium">
          <input type="checkbox" className="mt-0.5" checked={read} disabled={busy} onChange={(e) => setRead(e.target.checked)} data-testid="gmx-ack-check" /><span className="min-w-0 text-[0.875rem]">{t('gxAckCheck')}</span></label>
        {step === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
        {err && <GmxErrNotice err={err.e} raw={err.raw} />}
        <div className="space-y-2.5">
          <Btn full className="!min-h-[56px] !text-[1rem]" kind="danger" busy={step !== 'review'} disabled={!read} onClick={() => void approve()} data-testid="gmx-auth-approve"><Icon n="key" className="h-[18px] w-[18px]" />{t('gxAuthApprove')}</Btn>
          <Btn full kind="ghost" disabled={busy} onClick={() => { setP(null); setStep('form'); setErr(null); }}>{t('back')}</Btn>
        </div>
      </>}

      {step === 'done' && <><Notice tone="ok"><div data-testid="gmx-auth-done">{t('gxAuthDone')}</div></Notice><Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></>}
    </div>
  </LiveSheet>;
}

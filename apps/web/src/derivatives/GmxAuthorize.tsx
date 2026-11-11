/**
 * The venue policy of GMX (v8), approved once with the passkey together with the jurisdiction acknowledgement:
 *   form (markets, maximum leverage, maximum order size, orders per day, price band, duration) → POST /authorization/prepare →
 *   the acknowledgement text of the server, in full, in a box that must be read (a checkbox), and the exact policy that will be
 *   enforced by the signer → passkey → POST /authorization/approve. The passkey is asked for nothing the sheet did not show.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Field, Icon, inputCls, Notice } from '../ui';
import { Row, Sheet, timeOf } from './bits';
import { fmt, usd } from './dec';
import { gapi, GMX_STATUS_KEY, gmxAuthFromForm, gmxError, type GmxAuthForm, type GmxAuthPrepared, type GmxErr, type GmxStatus } from './gmx';
import { eth, GmxErrNotice } from './GmxBits';
import { ModeBand } from './LiveBits';

type Step = 'form' | 'preparing' | 'review' | 'passkey' | 'sending' | 'done';
const digits = (s: string) => s.replace(/[^0-9]/g, '');

export function GmxAuthorize({ status, onClose }: { status: GmxStatus; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const prev = status.authorization?.policy;
  const [f, setF] = useState<GmxAuthForm>(() => ({ markets: (prev?.allowedMarkets.length ? status.markets.filter((m) => prev.allowedMarkets.some((a) => a.toLowerCase() === m.market.toLowerCase())) : status.markets).map((m) => m.market),
    maxLeverage: String(prev?.maxLeverage ?? 3), maxOrderSizeUsd: prev?.maxOrderSizeUsd ?? '100', maxOrdersPerDay: String(prev?.maxOrdersPerDay ?? 10), bandBps: String(prev?.maxPriceDeviationBps ?? 100), days: '30' }));
  const [step, setStep] = useState<Step>('form'), [p, setP] = useState<GmxAuthPrepared | null>(null), [read, setRead] = useState(false), [err, setErr] = useState<{ e: GmxErr; raw: unknown } | null>(null);
  const lock = useRef(false);
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
    try { const s = await gapi.approveAuthorization(p.authorization, a); qc.setQueryData([...GMX_STATUS_KEY, locale], s); void qc.invalidateQueries({ queryKey: GMX_STATUS_KEY }); setStep('done'); }
    catch (e) { setErr({ e: gmxError(e), raw: e }); setStep('review'); }
  });

  const pol = p ? { ...(v.ok ? v.body : {}), ...(p.authorization.policy ?? {}) } as Partial<GmxAuthPrepared['authorization']['policy'] & { days: number }> : null;
  const name = (m: string) => status.markets.find((x) => x.market.toLowerCase() === m.toLowerCase())?.name ?? m;
  const num = (k: keyof GmxAuthForm, label: Key, hint: Key, unit: string, testid: string) => <Field label={t(label)} hint={t(hint)}>
    <div className="flex items-center gap-2"><input className={inputCls} inputMode="numeric" autoComplete="off" aria-label={t(label)} value={f[k] as string} onChange={(e) => set(k, k === 'maxOrderSizeUsd' ? e.target.value.replace(/[^0-9.,]/g, '') : digits(e.target.value))} data-testid={testid} />
      <span className="w-12 shrink-0 text-[12.5px] text-mute">{unit}</span></div></Field>;
  return <Sheet title={t('gxAuthTitle')} wide onClose={() => { if (!busy) onClose(); }}>
    <div className="min-w-0 space-y-3" data-testid="gmx-authorize" data-step={step}>
      <ModeBand tone="mainnet" label="GMX v2 · Arbitrum" compact />
      {(step === 'form' || step === 'preparing') && <>
        <p className="text-[13px] leading-snug">{t('gxAuthIntro')}</p>
        <fieldset><legend className="mb-1.5 text-[13px] text-mute">{t('gxAuthMarkets')}</legend>
          <div className="space-y-2">{status.markets.map((m) => <label key={m.market} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line px-3.5 text-[14px]">
            <input type="checkbox" className="h-5 w-5 accent-[var(--blue)]" checked={f.markets.includes(m.market)} onChange={() => toggle(m.market)} data-testid={`gmx-auth-market-${m.base}`} />
            <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span><span className="text-[12px] text-mute">{m.collateral.map((c) => c.symbol).join(', ')}</span></label>)}</div></fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <h3 className="text-[13px] font-semibold">{t('gxAckTitle')}</h3>
        <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-elev/50 p-3 text-[12.5px] leading-relaxed" tabIndex={0} data-testid="gmx-ack-text">{p.ack.text}</div>
        <p className="break-all font-mono text-[10.5px] text-mute">{t('gxAckVersion', { version: p.ack.version })} · SHA-256 {p.ack.sha256}</p>
        <h3 className="text-[13px] font-semibold">{t('gxAuthPolicyTitle')}</h3>
        <div className="rounded-2xl bg-elev/70 p-3" data-testid="gmx-auth-policy">
          <Row label={t('gxAuthMarkets')} strong><span className="block">{(pol.allowedMarkets ?? []).map((m) => <span key={m} className="block">{name(m)}</span>)}</span></Row>
          <Row label={t('gxAuthCollateral')}>USDC</Row>
          <Row label={t('gxAuthLeverage')} strong>{pol.maxLeverage}×</Row>
          <Row label={t('gxAuthOrder')} strong>{usd(pol.maxOrderSizeUsd, locale)}</Row>
          <Row label={t('gxAuthPerDay')}>{pol.maxOrdersPerDay}</Row>
          <Row label={t('gxAuthBand')}>{pol.maxPriceDeviationBps} {t('gxBps')} ({fmt(String((pol.maxPriceDeviationBps ?? 0) / 100), { locale, trim: true })} %)</Row>
          <Row label={t('gxAuthExecFee')}>{eth(p.maxExecutionFeeEth, locale)}</Row>
          <Row label={t('gxAuthUntil')}>{p.authorization.expiresAt ? timeOf(p.authorization.expiresAt * 1000, locale, true) : t('gxAuthDaysValue', { days: v.ok ? v.body.days : '—' })}</Row>
        </div>
        <ul className="space-y-1.5 text-[12.5px] leading-snug text-mute">
          <li className="flex gap-2"><Icon n="shield" className="mt-0.5 h-4 w-4 shrink-0" /><span>{t('gxAuthSigner')}</span></li>
          <li className="flex gap-2"><Icon n="key" className="mt-0.5 h-4 w-4 shrink-0" /><span>{t('gxAuthEach')}</span></li>
          <li className="flex gap-2"><Icon n="x" className="mt-0.5 h-4 w-4 shrink-0" /><span>{t('gxAuthRevocable')}</span></li></ul>
        <p className="break-all font-mono text-[10.5px] text-mute">{t('fingerprint')} SHA-256 {p.hash}</p>
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line p-3.5 text-[13.5px] leading-snug">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]" checked={read} disabled={busy} onChange={(e) => setRead(e.target.checked)} data-testid="gmx-ack-check" /><span>{t('gxAckCheck')}</span></label>
        {step === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
        {err && <GmxErrNotice err={err.e} raw={err.raw} />}
        <Btn full kind="danger" busy={step !== 'review'} disabled={!read} onClick={() => void approve()} data-testid="gmx-auth-approve"><Icon n="key" className="h-4 w-4" />{t('gxAuthApprove')}</Btn>
        <Btn full kind="ghost" disabled={busy} onClick={() => { setP(null); setStep('form'); setErr(null); }}>{t('back')}</Btn>
      </>}

      {step === 'done' && <><Notice tone="ok"><div data-testid="gmx-auth-done">{t('gxAuthDone')}</div></Notice><Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></>}
    </div>
  </Sheet>;
}

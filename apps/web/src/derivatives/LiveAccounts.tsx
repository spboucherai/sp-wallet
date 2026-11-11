/**
 * « Négociation réelle » of the Accounts view: the venue accounts (one per network), their state as the venue reports it, the
 * dedicated trading key, how to fund the account (explained — deposits and withdrawals are not built, so there is no button),
 * the authorization flow (limits → review: jurisdiction text, what is signed, key and expiry, limits → passkey) and revocation.
 * Mainnet is shown, and blocked with the reason, while the server setting keeps it off: that setting is the owner's, on the
 * server — there is no switch for it here.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Addr, Btn, Card, Field, H, Icon, inputCls, Notice, Skeleton, when } from '../ui';
import { Row, ServerSays, Sheet, Stat, timeOf } from './bits';
import { fmt, usd } from './dec';
import { Bullet, LiveErrNotice, ModeBand, ModeTag, SourceTag } from './LiveBits';
import { defaultPolicyForm, isUnfunded, lapi, liveError, policyFromForm, samePolicy, sha256Hex, toneOf, venueWords, type Collateral, type LiveConfig, type LiveErr, type LiveNetwork, type LiveSummary, type PolicyForm, type Prepared, type Revoked, type VenuePolicy } from './live';
import { HaltBanner } from './LiveOrderPanel';
import { liveKey, refreshLive } from './liveStore';

const sym = (id: string) => id.slice(id.indexOf(':') + 1);
const NETWORKS: LiveNetwork[] = ['testnet', 'mainnet'];
/** the server's English capability words, in the screen's language; unknown words are shown as the server wrote them */
const CAN: Record<string, Key> = { 'place orders': 'flCan_place', 'cancel orders': 'flCan_cancel', 'change leverage': 'flCan_leverage', withdraw: 'flCannot_withdraw', 'transfer to another address': 'flCannot_transfer' };

/** how the venue account is funded: an explanation, never a button (deposits and withdrawals are not built) */
export function FundingBox({ network, collateral }: { network: LiveNetwork; collateral?: Collateral }) {
  const t = useT();
  return <div className="rounded-2xl border border-line p-3.5 text-[13px] leading-snug" data-testid="funding-box">
    <div className="mb-1.5 text-[13.5px] font-semibold">{t('flFundTitle')}</div>
    <ul className="space-y-1.5">
      {(network === 'mainnet' ? (['flFundMain1', 'flFundMain2', 'flFundMain3'] as const) : (['flFundTest1', 'flFundTest2'] as const)).map((k) => <Bullet key={k} icon="chev">{t(k)}</Bullet>)}
      <Bullet icon="lock">{t('flFundNotBuilt')}</Bullet>
    </ul>
    {collateral && <p className="mt-2 break-words text-[11.5px] text-mute">{t('fxServerSays')} <span className="font-mono text-[11px]">{collateral.deposits.how}</span></p>}
    {collateral && <p className="mt-1 break-words text-[11.5px] text-mute">{t('flWithdrawalsServer')} <span className="font-mono text-[11px]">{collateral.withdrawals.how}</span></p>}
  </div>;
}

function PolicyRows({ p }: { p: VenuePolicy }) {
  const t = useT(); const { locale } = useContext(I18n);
  return <div data-testid="policy-rows">
    <Row label={t('flLimInstruments')} strong>{p.allowedInstruments.map(sym).join(', ')}</Row>
    <Row label={t('flLim_maxLeverage')} strong>{p.maxLeverage}×</Row>
    <Row label={t('flLim_maxOrderNotional')} strong>{usd(p.maxOrderNotional, locale)}</Row>
    <Row label={t('flLim_maxPositionNotional')}>{usd(p.maxPositionNotional, locale)}</Row>
    <Row label={t('flLim_maxGrossExposure')}>{usd(p.maxGrossExposure, locale)}</Row>
    <Row label={t('flLim_maxOrdersPerDay')}>{p.maxOrdersPerDay}</Row>
    <Row label={t('flLim_bandBps')}>{p.maxPriceDeviationBps} {t('fxBps')} ({fmt(String(p.maxPriceDeviationBps / 100), { locale, trim: true })} %)</Row>
  </div>;
}

type Step = 'form' | 'preparing' | 'review' | 'passkey' | 'sending' | 'refused';
function AuthorizeSheet({ account, config, collateral, onClose }: { account: LiveSummary; config: LiveConfig; collateral?: Collateral; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const pinned = config.pinnedAssets[account.network], b = config.bounds, tone = toneOf(account);
  const [f, setF] = useState<PolicyForm>(() => defaultPolicyForm(account.network, pinned));
  const [step, setStep] = useState<Step>('form'), [prep, setPrep] = useState<Prepared | null>(null), [read, setRead] = useState(false), [err, setErr] = useState<LiveErr | null>(null), [integrity, setIntegrity] = useState<string | null>(null);
  const lock = useRef(false);
  const once = async (fn: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await fn(); } finally { lock.current = false; } };
  const parsed = policyFromForm(f, b, pinned);
  const busy = step === 'preparing' || step === 'passkey' || step === 'sending';
  const field = (k: Exclude<keyof PolicyForm, 'instruments'>, unit: string, hintVars: Record<string, string | number> = {}) => <Field label={t(`flLim_${k}` as Key)} hint={t(`flLimHint_${k}` as Key, hintVars)}>
    <div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" autoComplete="off" aria-label={t(`flLim_${k}` as Key)} value={f[k]} onChange={(e) => { setF({ ...f, [k]: e.target.value.replace(/[^0-9.,]/g, '') }); setErr(null); }} /><span className="w-10 shrink-0 text-[12.5px] text-mute">{unit}</span></div></Field>;

  const prepare = () => once(async () => {
    if (!parsed.ok) return;
    setStep('preparing'); setErr(null); setRead(false); setIntegrity(null);
    try {
      const p = await lapi.prepare(account.id, { policy: parsed.policy, days: parsed.days, locale });
      // what is displayed must be what the passkey commits to: the text's own hash, the hash inside the authorization, the limits asked for
      const textHash = await sha256Hex(p.acknowledgement.text);
      const bad = textHash !== p.acknowledgement.sha256 || p.authorization.ackSha256 !== p.acknowledgement.sha256 ? 'ack' : !samePolicy(p.authorization.policy, parsed.policy) ? 'policy'
        : p.authorization.agentAddress.toLowerCase() !== account.agentAddress.toLowerCase() || p.authorization.account.toLowerCase() !== account.account.toLowerCase() || p.authorization.network !== account.network ? 'account' : null;
      setIntegrity(bad); setPrep(p); setStep('review');
    } catch (e) { setErr(liveError(e)); setStep('form'); }
  });
  const approve = () => once(async () => {
    if (!prep || !read || integrity) return;
    setStep('passkey'); setErr(null);
    let assertion: unknown;
    try { assertion = await startAuthentication({ optionsJSON: prep.options }); }
    catch (e) { setErr(liveError(e)); setStep('review'); return; }               // nothing was sent: the prepared authorization is still the one on screen
    setStep('sending');
    try { await lapi.approveAuthorization(account.id, assertion); await refreshLive(qc, account.id); onClose(); }
    catch (e) { const le = liveError(e); setErr(le); setStep(le.status === 0 ? 'review' : 'refused'); void refreshLive(qc, account.id); }   // an answered refusal consumed the prepared authorization
  });
  const unfunded = err?.code === 'venue_rejected' && isUnfunded(err.detail);

  return <Sheet wide title={t('flAuthTitle', { network: account.network })} onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-3" data-testid="authorize-sheet" data-step={step}>
      <ModeBand tone={tone} label={account.label} />
      {(step === 'form' || step === 'preparing') && <>
        <p className="text-[13px] leading-snug text-mute">{t('flAuthIntro')}</p>
        <div data-testid="auth-instruments"><div className="mb-1.5 text-[13px] text-mute">{t('flLimInstruments')}</div>
          <div className="flex flex-wrap gap-2">{pinned.map((p) => { const on = f.instruments.includes(p.instrument); return <button key={p.instrument} type="button" role="checkbox" aria-checked={on} onClick={() => setF({ ...f, instruments: on ? f.instruments.filter((x) => x !== p.instrument) : [...f.instruments, p.instrument] })}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'}`}>{sym(p.instrument)}<span className={`text-[11.5px] ${on ? 'opacity-80' : 'text-mute'}`}>≤ {p.maxLeverage}×</span></button>; })}</div>
          <p className="mt-1.5 text-[12px] leading-snug text-mute">{t('flLimHint_instruments', { date: config.pinnedAssets.pinnedAt })}</p></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field('maxLeverage', '×', { max: b.maxLeverage })}{field('maxOrderNotional', 'USDC')}{field('maxPositionNotional', 'USDC')}{field('maxGrossExposure', 'USDC')}
          {field('maxOrdersPerDay', t('fxPerDay'), { max: b.maxOrdersPerDay })}{field('bandBps', t('fxBps'), { min: b.minPriceBandBps, max: b.maxPriceBandBps })}{field('days', t('flDaysUnit'), { max: b.maxAuthorizationDays })}
        </div>
        {account.network === 'testnet' && <p className="text-[12px] leading-snug text-mute">{t('flBandTestnetNote')}</p>}
        {!parsed.ok && <Notice tone="warn"><div data-testid="policy-problem">{t(`flPol_${parsed.problem}` as Key, { maxLev: b.maxLeverage, maxOrders: b.maxOrdersPerDay, minBand: b.minPriceBandBps, maxBand: b.maxPriceBandBps, maxDays: b.maxAuthorizationDays, maxInst: b.maxInstruments })}</div></Notice>}
        {err && <LiveErrNotice err={err} />}
        <Btn full busy={step === 'preparing'} disabled={!parsed.ok} onClick={() => void prepare()}>{t('flAuthContinue')}</Btn>
      </>}

      {prep && (step === 'review' || step === 'passkey' || step === 'sending') && <>
        <section aria-label={t('flAckTitle')}><h3 className="mb-1.5 text-[14px] font-semibold">1. {t('flAckTitle')}</h3>
          <div tabIndex={0} className="max-h-[38dvh] overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-elev/50 p-3.5 text-[13px] leading-relaxed" data-testid="ack-text">{prep.acknowledgement.text}</div>
          <p className="mt-1 break-all font-mono text-[10.5px] text-mute">SHA-256 {prep.acknowledgement.sha256} · {prep.acknowledgement.version}</p>
          <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 text-[14px] font-medium"><input type="checkbox" checked={read} disabled={busy} onChange={(e) => setRead(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--blue)]" data-testid="ack-check" /><span>{t('flAckCheck')}</span></label>
          <p className="text-[12px] leading-snug text-mute">{t('flAckSigned')}</p></section>
        <section><h3 className="mb-1.5 text-[14px] font-semibold">2. {t('flSignedTitle')}</h3>
          <ul className="space-y-2 text-[13px] leading-snug" data-testid="what-is-signed">
            <Bullet icon="key">{t('flSignedMain')}<span className="mt-0.5 block break-words font-mono text-[11px] text-mute">{prep.whatIsSigned.byMainKey}</span></Bullet>
            <Bullet icon="shield">{t('flSignedPasskey')}<span className="mt-0.5 block break-words font-mono text-[11px] text-mute">{prep.whatIsSigned.byPasskey}</span></Bullet></ul></section>
        <section><h3 className="mb-1.5 text-[14px] font-semibold">3. {t('flKeyTitle')}</h3>
          <div className="rounded-2xl bg-elev/70 p-3"><Addr value={prep.agent.address} />
            <div className="mt-1 text-[12.5px] text-mute">{t('flKeyExpiry', { date: when(new Date(prep.agent.validUntil), locale) })} · {prep.agent.wireName}</div></div>
          <div className="mt-2 grid grid-cols-1 gap-2 text-[13px] leading-snug sm:grid-cols-2" data-testid="agent-can">
            <div><div className="mb-1 text-[12px] font-semibold text-emerald">{t('flCan')}</div><ul className="space-y-1">{prep.agent.can.map((c) => <Bullet key={c} icon="check" tone="text-emerald">{CAN[c] ? t(CAN[c]!) : c}</Bullet>)}</ul></div>
            <div><div className="mb-1 text-[12px] font-semibold text-danger">{t('flCannot')}</div><ul className="space-y-1">{prep.agent.cannot.map((c) => <Bullet key={c} icon="x" tone="text-danger">{CAN[c] ? t(CAN[c]!) : c}</Bullet>)}</ul></div></div>
          <p className="mt-1.5 text-[12px] leading-snug text-mute">{t('flKeyNote')}<span className="mt-0.5 block break-words font-mono text-[11px]">{prep.agent.note}</span></p></section>
        <section><h3 className="mb-1.5 text-[14px] font-semibold">4. {t('flLimitsTitle')}</h3>
          <div className="rounded-2xl border border-line p-3"><PolicyRows p={prep.authorization.policy} /><Row label={t('flAuthExpires')}>{when(new Date(prep.authorization.expiresAt * 1000), locale)}</Row></div>
          <p className="mt-1.5 text-[12px] leading-snug text-mute">{t('flLimitsWho')}</p>
          <p className="mt-1 break-all font-mono text-[10.5px] text-mute">{t('fingerprint')} SHA-256 {prep.hash}</p></section>
        {integrity && <Notice tone="danger"><div data-testid="integrity">{t(`flIntegrity_${integrity}` as Key)}</div></Notice>}
        {step === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
        {err && <LiveErrNotice err={err} tone={err.key === 'passkey_cancelled' ? 'warn' : 'danger'} />}
        <Btn full kind={tone === 'mainnet' ? 'danger' : 'primary'} busy={step !== 'review'} disabled={!read || !!integrity} onClick={() => void approve()} data-testid="auth-approve"><Icon n="key" className="h-4 w-4" />{t(tone === 'mainnet' ? 'flAuthApproveReal' : 'flAuthApproveTestnet')}</Btn>
        {!read && <p className="text-center text-[12px] text-mute">{t('flAckNeeded')}</p>}
        <Btn full kind="ghost" disabled={busy} onClick={() => { setStep('form'); setErr(null); }}>{t('flBackToLimits')}</Btn>
      </>}

      {step === 'refused' && err && <div className="space-y-3" data-testid="auth-refused">
        {err.code === 'venue_rejected' ? <Notice tone="danger"><b className="font-semibold">{t('flVenueRefusedTitle')}</b> {t('flVenueRefused')}
          <span className="mt-2 block text-[12px] text-mute">{t('flVenueSays')}</span>
          <span className="block break-words rounded-lg bg-surface/70 px-2 py-1.5 font-mono text-[12px] text-ink" data-testid="venue-words">{venueWords(err.detail)}</span></Notice> : <LiveErrNotice err={err} />}
        {unfunded && <><Notice tone="info">{t('flUnfundedNote')}</Notice><FundingBox network={account.network} collateral={collateral} /></>}
        <Btn full kind="soft" onClick={() => { setStep('form'); setErr(null); setPrep(null); }}>{t('flAuthPrepareAgain')}</Btn>
        <Btn full kind="ghost" onClick={onClose}>{t('fxClose')}</Btn></div>}
    </div>
  </Sheet>;
}

function RevokeSheet({ account, onClose }: { account: LiveSummary; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient();
  // how many orders rest on the venue right now (the venue's own list); unknown stays unknown
  const d = useQuery({ queryKey: liveKey(account.id), queryFn: () => lapi.account(account.id), retry: 0 });
  const openOrders = d.data && !d.data.venueState.error ? d.data.venueState.openOrders.length : null;
  const [cancelFirst, setCancelFirst] = useState(true), [busy, setBusy] = useState(false), [err, setErr] = useState<LiveErr | null>(null), [done, setDone] = useState<Revoked | null>(null);
  const lock = useRef(false);
  const revoke = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setErr(null);
    try { setDone(await lapi.revoke(account.id, cancelFirst)); } catch (e) { setErr(liveError(e)); } finally { lock.current = false; setBusy(false); void refreshLive(qc, account.id); }
  };
  return <Sheet title={t('flRevokeTitle')} onClose={() => { if (!busy) onClose(); }}><div className="space-y-3" data-testid="revoke-sheet">
    <ModeBand tone={toneOf(account)} label={account.label} />
    {!done && <>
      <Notice tone="warn">{t('flRevokeBody')}</Notice>
      <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-[13.5px]"><input type="checkbox" checked={cancelFirst} onChange={(e) => setCancelFirst(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]" data-testid="revoke-cancel-first" />
        <span>{t('flRevokeCancelFirst')}{openOrders !== null && <span className="block text-[12px] text-mute">{t('flRevokeOpenNow', { n: openOrders })}</span>}</span></label>
      {!cancelFirst && (openOrders ?? 0) > 0 && <Notice tone="danger">{t('flRevokeLeaves', { n: openOrders ?? 0 })}</Notice>}
      {err && <LiveErrNotice err={err} />}
      <Btn full kind="danger" busy={busy} onClick={() => void revoke()}><Icon n="stop" className="h-4 w-4" />{t('flRevokeConfirm')}</Btn>
      <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Btn></>}
    {done && <div className="space-y-3" data-testid="revoke-done">
      <Notice tone="ok">{t('flRevoked')}</Notice>
      {done.cancelled && <p className="text-[13px] leading-snug">{t('flCancelAllDone', { requested: done.cancelled.requested, accepted: done.cancelled.accepted, remaining: done.cancelled.remaining === null ? '?' : done.cancelled.remaining.length })}</p>}
      {done.warning && <Notice tone="danger"><div data-testid="revoke-warning"><b className="font-semibold">{t('flRevokeWarnTitle')}</b> {t('flRevokeWarn')}<span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{done.warning}</span></div></Notice>}
      <p className="text-[12.5px] leading-snug text-mute">{t('flRevokeAgent')}<span className="mt-0.5 block break-words font-mono text-[11px]">{done.venueAgent}</span></p>
      <Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></div>}
  </div></Sheet>;
}

function LiveAccountCard({ a, config, selected, onSelect }: { a: LiveSummary; config: LiveConfig; selected: boolean; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const tone = toneOf(a), off = a.network === 'mainnet' && !a.mainnetEnabled, auth = a.authorization, live = a.mode === 'MANUAL_LIVE';
  const col = useQuery({ queryKey: ['deriv', 'live', 'collateral', a.id], queryFn: () => lapi.collateral(a.id), refetchInterval: 30_000, retry: 0 });
  const [sheet, setSheet] = useState<'authorize' | 'revoke' | null>(null);
  const c = col.data;
  return <li className={`rounded-2xl border p-4 ${selected ? 'border-ink' : 'border-line'}`} data-testid={`live-account-${a.network}`} data-mode={a.mode}>
    <ModeBand tone={tone} className="mb-3" />
    <div className="flex flex-wrap items-center gap-2"><span className="text-[15.5px] font-semibold">{a.label}</span>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${live && !auth?.expired ? 'bg-emerald/10 text-emerald' : 'bg-elev text-mute'}`} data-testid="live-mode"><Icon n={live ? 'key' : 'lock'} className="h-3 w-3" />{t(live ? (auth?.expired ? 'flModeExpired' : 'flModeLive') : 'flModeReadOnly')}</span>
      {selected && <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink"><Icon n="check" className="h-3.5 w-3.5" />{t('fxSelected')}</span>}</div>

    {off && <div className="mt-3"><Notice tone="warn"><div data-testid="mainnet-off"><b className="font-semibold">{t('flMainnetOffTitle')}</b> {t('flMainnetOff')}</div></Notice></div>}
    <div className="mt-3" data-testid="venue-state">
      {col.isLoading ? <Skeleton h="h-12" /> : !c || c.error || col.isError ? <Notice tone="danger">{t('flUnreadable')} <span className="break-words font-mono text-[11.5px] text-mute">{c?.error ?? (col.error ? liveError(col.error).detail || liveError(col.error).code : '')}</span></Notice> : <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label={t('fxEquity')}>{usd(c.equity, locale)}</Stat><Stat label={t('fxCollateral')}>{usd(c.collateral, locale)}</Stat><Stat label={t('fxFreeCollateral')}>{usd(c.freeCollateral, locale)}</Stat><Stat label={t('fxWithdrawable')}>{usd(c.withdrawable, locale)}</Stat></div>
        <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-mute"><SourceTag />{t('flReadAt', { time: timeOf(c.ts, locale) })} · {c.asset}</p></>}
    </div>
    <HaltBanner account={a} />

    <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="rounded-2xl bg-elev/70 p-3"><div className="mb-1 text-[12px] text-mute">{t('flAccountAddr')}</div><Addr value={a.account} /><p className="mt-1 text-[12px] leading-snug text-mute">{t('flAccountAddrNote')}</p></div>
      <div className="rounded-2xl bg-elev/70 p-3" data-testid="trading-key"><div className="mb-1 text-[12px] text-mute">{t('flTradingKey')}</div><Addr value={a.agentAddress} />
        <p className="mt-1 text-[12px] leading-snug text-mute">{t('flTradingKeyNote')}</p></div>
    </div>

    {live && auth && <div className="mt-3 rounded-2xl border border-line p-3" data-testid="live-authorization"><div className="mb-1 text-[13px] font-semibold">{t('flAuthActive')}</div>
      <PolicyRows p={auth.policy} /><Row label={t('flAuthExpires')}>{when(new Date(auth.expiresAt), locale)}</Row>
      <p className="mt-1 text-[12px] leading-snug text-mute">{t('flLimitsWho')}</p></div>}
    {!live && auth?.revokedAt && <p className="mt-3 text-[12.5px] text-mute">{t('flRevokedAt', { date: when(new Date(auth.revokedAt), locale) })}</p>}

    <div className="mt-3"><FundingBox network={a.network} collateral={c} /></div>

    <div className="mt-3 flex flex-wrap gap-2">
      {!selected && <Btn kind="soft" onClick={() => onSelect(a.id)}>{t('fxUse')}</Btn>}
      {!live && <Btn disabled={off} onClick={() => setSheet('authorize')} data-testid="authorize"><Icon n="key" className="h-4 w-4" />{t('flAuthorize')}</Btn>}
      {(live || a.pendingAuthorization) && <Btn kind="danger" onClick={() => setSheet('revoke')} data-testid="revoke"><Icon n="stop" className="h-4 w-4" />{t('flRevoke')}</Btn>}
    </div>
    {off && !live && <p className="mt-2 text-[12px] leading-snug text-mute">{t('flMainnetBlocked')}</p>}
    {sheet === 'authorize' && <AuthorizeSheet account={a} config={config} collateral={c} onClose={() => setSheet(null)} />}
    {sheet === 'revoke' && <RevokeSheet account={a} onClose={() => setSheet(null)} />}
  </li>;
}

export function LiveSection({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const t = useT(); const qc = useQueryClient();
  const config = useQuery({ queryKey: ['deriv', 'live', 'config'], queryFn: lapi.config, staleTime: 10_000, refetchInterval: 30_000, retry: 0 });
  const accounts = useQuery({ queryKey: ['deriv', 'live', 'accounts'], queryFn: lapi.accounts, refetchInterval: 15_000, retry: 0 });
  const [busy, setBusy] = useState(''), [err, setErr] = useState<LiveErr | null>(null);
  const lock = useRef(false);
  useEffect(() => { setErr(null); }, [accounts.data?.length]);
  const cfg = config.data, list = accounts.data ?? [];
  const anyLive = list.some((a) => a.mode === 'MANUAL_LIVE' && !a.authorization?.expired);
  const create = async (network: LiveNetwork) => {
    if (lock.current) return; lock.current = true; setBusy(network); setErr(null);
    try { const a = await lapi.create(network, t(network === 'testnet' ? 'flLabelTestnet' : 'flLabelMainnet')); await refreshLive(qc); onSelect(a.id); }
    catch (e) { setErr(liveError(e)); } finally { lock.current = false; setBusy(''); }
  };
  return <Card><div data-testid="live-card">
    <H right={<span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${anyLive ? 'bg-emerald/10 text-emerald' : 'bg-elev text-mute'}`} data-testid="live-status"><Icon n={anyLive ? 'key' : 'lock'} className="h-3.5 w-3.5" />{t(anyLive ? 'flLiveOn' : 'fxLiveOff')}</span>}>{t('fxLive')}</H>
    <p className="text-[13.5px] leading-snug">{t('flIntro')}</p>
    <ul className="mt-3 space-y-2 text-[13.5px] leading-snug">{(['fxLiveReq1', 'flReq2', 'fxLiveReq3', 'fxLiveReq4'] as const).map((k) => <Bullet key={k} icon="key">{t(k)}</Bullet>)}</ul>
    {config.isError || accounts.isError ? <div className="mt-3"><LiveErrNotice err={liveError(config.error ?? accounts.error)} /></div> : !cfg || accounts.isLoading ? <div className="mt-3"><Skeleton h="h-24" /></div> : <>
      {!cfg.mainnetEnabled && <div className="mt-3"><Notice tone="info"><div data-testid="mainnet-setting">{t('flMainnetSetting')}</div></Notice></div>}
      <ul className="mt-4 space-y-3">{NETWORKS.map((n) => { const a = list.find((x) => x.network === n);
        if (a) return <LiveAccountCard key={n} a={a} config={cfg} selected={a.id === selected} onSelect={onSelect} />;
        const off = n === 'mainnet' && !cfg.mainnetEnabled;
        return <li key={n} className="rounded-2xl border border-dashed border-line p-4" data-testid={`live-create-${n}`}>
          <div className="flex flex-wrap items-center gap-2"><ModeTag tone={n === 'mainnet' ? 'mainnet' : 'testnet'} /><span className="text-[14.5px] font-semibold">{t(n === 'testnet' ? 'flCreateTestnetTitle' : 'flCreateMainnetTitle')}</span></div>
          <p className="mt-1.5 text-[13px] leading-snug text-mute">{t(n === 'testnet' ? 'flCreateTestnetBody' : 'flCreateMainnetBody')}</p>
          {off && <p className="mt-1.5 text-[12.5px] font-medium leading-snug text-warn" data-testid="mainnet-blocked">{t('flMainnetBlocked')}</p>}
          <Btn className="mt-3" kind={n === 'testnet' ? 'primary' : 'soft'} busy={busy === n} disabled={off || !!busy} onClick={() => void create(n)}><Icon n="plus" className="h-4 w-4" />{t(n === 'testnet' ? 'flCreateTestnet' : 'flCreateMainnet')}</Btn></li>; })}</ul>
      {err && <div className="mt-3"><LiveErrNotice err={err} /></div>}
      <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('flMandateNote')} {t('fxLiveNote')}</p>
      {!cfg.mandateLive.available && <ServerSays mono text={cfg.mandateLive.reason} className="mt-1 break-words text-[11.5px] text-mute" />}
    </>}</div>
  </Card>;
}

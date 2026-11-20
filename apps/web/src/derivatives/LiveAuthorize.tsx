/**
 * The authorization of a venue account: its limits as a receipt (`PolicyRows`), how the account is funded (`FundingBox`) and the
 * sheet that grants it (`AuthorizeSheet`: limits → review: jurisdiction text, what is signed, key and expiry, limits → passkey).
 * Moved out of LiveAccounts.tsx so that the order panel can open the same sheet (an asset outside the authorization).
 *
 * Assets (2026-11-17, the venue's whole own dex is pinned — 179 perpetuals, not three):
 *  - « All assets » is the default: every pinned instrument whose venue maximum leverage is at least the leverage chosen. ONE
 *    authorization carries ONE maximum leverage and the signer refuses it when it exceeds the venue maximum of ANY allowed
 *    instrument, so a higher leverage leaves assets out: the form says how many, which ones, and how to include them;
 *  - « Choose » is a searchable list with a tick per asset.
 *
 * Changing the assets of an account that already has an authorization (`replace`): the server refuses to prepare a new
 * authorization while one is active, and the signer refuses a second active one. The sheet therefore does both steps in order —
 * it revokes the present authorization (no passkey: revoking only removes), then prepares the new one, which is read and approved
 * with the passkey exactly like a first one. Between the two the account is read-only: the sheet says so before and after.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { ApprovalOutcomePanel, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Addr, AssetIcon, Btn, Fact, Field, Fold, Icon, inputCls, Notice, when } from '../ui';
import { fmt, usd } from './dec';
import { Bullet, Fingerprint, Group, LiveErrNotice, LiveSheet, ModeBand, TICKET, WORDS } from './LiveBits';
import { assetsAtLeverage, defaultPolicyForm, isUnfunded, lapi, liveError, policyFormOf, policyFromForm, samePolicy, sha256Hex, toneOf, venueWords, type Collateral, type LiveConfig, type LiveDetail, type LiveErr, type LiveNetwork, type LiveSummary, type PolicyForm, type Prepared, type Revoked, type VenuePolicy } from './live';
import { liveKey, refreshLive } from './liveStore';

const sym = (id: string) => id.slice(id.indexOf(':') + 1);
/** the server's English capability words, in the screen's language; unknown words are shown as the server wrote them */
const CAN: Record<string, Key> = { 'place orders': 'flCan_place', 'cancel orders': 'flCan_cancel', 'change leverage': 'flCan_leverage', withdraw: 'flCannot_withdraw', 'transfer to another address': 'flCannot_transfer' };
/** a quiet inner plate (an address, a key) */
export const PLATE = 'min-w-0 rounded-[18px] bg-elev/60 p-3.5';
/** up to this many assets are named on the row itself; beyond, the row gives the count and the names follow in full underneath */
const INLINE_ASSETS = 6;

/** how the venue account is funded: the explanation. The buttons (« Déposer », « Retirer ») are in CollateralPanel, LiveCollateral.tsx */
export function FundingBox({ network, collateral }: { network: LiveNetwork; collateral?: Collateral }) {
  const t = useT();
  return <div className="rounded-[18px] border border-line p-4 text-[0.84375rem] leading-snug" data-testid="funding-box">
    <div className="mb-2 flex items-center gap-2 text-[0.90625rem] font-semibold"><AssetIcon sym="USDC" size={22} />{t('flFundTitle')}</div>
    <ul className="space-y-2">
      {(network === 'mainnet' ? (['flFundMain1', 'flFundMain2', 'flFundMain3'] as const) : (['flFundTest1', 'flFundTest2'] as const)).map((k) => <Bullet key={k} icon="chev">{t(k)}</Bullet>)}
      <Bullet icon="key">{t('hlcFundBuilt')}</Bullet>
    </ul>
    {/* v8 hardening: the server's note names files and routes — a developer note. It stays available, folded, in the screen's language; the sentences above are the owner's explanation */}
    {collateral && <Fold className="mt-1.5" testid="funding-tech-note" summary={t('hdServerTechNote')}>
      <p className="break-words text-[0.75rem] text-mute">{t('hdTechDeposits')} <span className="font-mono text-[0.6875rem]">{collateral.deposits.how}</span></p>
      <p className="mt-1 break-words text-[0.75rem] text-mute">{t('flWithdrawalsServer')} <span className="font-mono text-[0.6875rem]">{collateral.withdrawals.how}</span></p></Fold>}
  </div>;
}

/**
 * The limits the signer enforces, as a receipt; `expires` is the last line when the authorization has one. A few assets are named
 * on their row; a long list gives its count there and EVERY name underneath — in a box that scrolls on a review (nothing folded
 * before an approval), folded on the account card (`fold`). `total` = the number of pinned assets: says « all ».
 */
export function PolicyRows({ p, expires, total, fold }: { p: VenuePolicy; expires?: string; total?: number; fold?: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const n = p.allowedInstruments.length, names = p.allowedInstruments.map(sym).join(', ');
  const box = <div tabIndex={0} className="max-h-[22dvh] overflow-y-auto rounded-[14px] bg-surface/70 px-3 py-2.5 text-[0.78125rem] leading-relaxed" data-testid="policy-assets" aria-label={t('hl1Assets')}>{names}</div>;
  return <>
    <dl className="receipt" data-testid="policy-rows">
      <Fact k={t('hl1Assets')}><span className="font-semibold" data-testid="policy-assets-count">{n <= INLINE_ASSETS ? names : t(total !== undefined && n === total ? 'hl1AssetsAllN' : 'hl1AssetsN', { n })}</span></Fact>
      <Fact k={t('flLim_maxLeverage')}><span className="font-semibold">{p.maxLeverage}×</span></Fact>
      <Fact k={t('flLim_maxOrderNotional')}><span className="font-semibold">{usd(p.maxOrderNotional, locale)}</span></Fact>
      <Fact k={t('flLim_maxPositionNotional')}>{usd(p.maxPositionNotional, locale)}</Fact>
      <Fact k={t('flLim_maxGrossExposure')}>{usd(p.maxGrossExposure, locale)}</Fact>
      <Fact k={t('flLim_maxOrdersPerDay')}>{p.maxOrdersPerDay}</Fact>
      <Fact k={t('flLim_bandBps')}>{p.maxPriceDeviationBps} {t('fxBps')} ({fmt(String(p.maxPriceDeviationBps / 100), { locale, trim: true })} %)</Fact>
      {expires !== undefined && <Fact k={t('flAuthExpires')}>{expires}</Fact>}
    </dl>
    {n > INLINE_ASSETS && (fold ? <Fold testid="policy-assets-fold" summary={t('hl1AssetsSee', { n })}>{box}</Fold> : <div className="pb-2.5 pt-1"><div className="mb-1.5 text-[0.75rem] text-mute">{t('hl1AssetsNames', { n })}</div>{box}</div>)}
  </>;
}

type Step = 'form' | 'revoking' | 'preparing' | 'review' | 'passkey' | 'sending' | 'refused';
export function AuthorizeSheet({ account, config, collateral, replace = false, ensure, onClose }: { account: LiveSummary; config: LiveConfig; collateral?: Collateral;
  /** the account has an authorization: this sheet changes its assets (revokes it, then grants the new one) */ replace?: boolean; /** an asset the owner came here to add: ticked in « choose », and named when the leverage leaves it out */ ensure?: string | undefined;
  onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const pinned = config.pinnedAssets[account.network], b = config.bounds, tone = toneOf(account);
  const [f, setF] = useState<PolicyForm>(() => {
    const cur = replace ? account.authorization?.policy : undefined;
    const base = cur ? policyFormOf(cur, account.network, pinned) : defaultPolicyForm(account.network, pinned);
    const instruments = ensure && pinned.some((p) => p.instrument === ensure) && !base.instruments.includes(ensure) ? [...base.instruments, ensure] : base.instruments;
    return { ...base, scope: 'all', instruments };
  });
  const [step, setStep] = useState<Step>('form'), [prep, setPrep] = useState<Prepared | null>(null), [read, setRead] = useState(false), [err, setErr] = useState<LiveErr | null>(null), [integrity, setIntegrity] = useState<string | null>(null);
  const [q, setQ] = useState(''), [cancelFirst, setCancelFirst] = useState(true), [revoked, setRevoked] = useState<Revoked | null>(null);
  // changing the assets: how many orders rest on the venue right now (the venue's own list); unknown stays unknown
  const d = useQuery({ queryKey: liveKey(account.id), queryFn: () => lapi.account(account.id), retry: 0, enabled: replace });
  const openOrders = d.data && !d.data.venueState.error ? d.data.venueState.openOrders.length : null;
  const lock = useRef(false);
  const ap = useApprovalOutcome<LiveDetail>();
  const once = async (fn: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await fn(); } finally { lock.current = false; } };
  const parsed = policyFromForm(f, b, pinned);
  const busy = step === 'revoking' || step === 'preparing' || step === 'passkey' || step === 'sending';
  const pending = replace && !revoked;   // the present authorization is still in force
  const patch = (p: Partial<PolicyForm>) => { setF((x) => ({ ...x, ...p })); setErr(null); };
  const field = (k: Exclude<keyof PolicyForm, 'instruments' | 'scope'>, unit: string, hintVars: Record<string, string | number> = {}) => <Field label={t(`flLim_${k}` as Key)} hint={t(`flLimHint_${k}` as Key, hintVars)}>
    <div className="relative"><input className={`${inputCls} pr-16 font-semibold`} inputMode="decimal" autoComplete="off" aria-label={t(`flLim_${k}` as Key)} value={f[k]} onChange={(e) => patch({ [k]: e.target.value.replace(/[^0-9.,]/g, '') })} /><span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[0.8125rem] font-medium text-mute">{unit}</span></div></Field>;

  // ---- the assets: « all » follows the leverage; « choose » is the ticked list
  const split = assetsAtLeverage(pinned, f.maxLeverage), lev = /^\d{1,6}$/.test(f.maxLeverage.trim()) ? Number(f.maxLeverage.trim()) : null;
  const lowest = pinned.reduce((m, p) => Math.min(m, p.maxLeverage), Infinity);
  const ticked = f.instruments.filter((i) => pinned.some((p) => p.instrument === i));
  const tooLow = lev === null ? [] : pinned.filter((p) => ticked.includes(p.instrument) && p.maxLeverage < lev);
  const found = (() => { const s = q.trim().toLowerCase(); return s ? pinned.filter((p) => sym(p.instrument).toLowerCase().includes(s)) : pinned; })();
  const ensureOut = f.scope === 'all' && ensure ? split.leftOut.find((p) => p.instrument === ensure) : undefined;
  const scopeBtn = (id: PolicyForm['scope'], title: string, sub: string) => { const on = f.scope === id; return <button type="button" role="radio" aria-checked={on} disabled={busy} onClick={() => patch({ scope: id })} data-testid={`auth-scope-${id}`}
    className={`press flex min-h-[64px] min-w-0 items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 text-left ${on ? 'border-ink bg-elev/60' : 'border-line'}`}>
    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${on ? 'border-ink bg-ink text-surface' : 'border-line'}`}>{on && <Icon n="check" className="h-3 w-3" />}</span>
    <span className="min-w-0"><span className="block text-[0.9375rem] font-semibold leading-tight">{title}</span><span className="mt-0.5 block text-[0.78125rem] leading-snug text-mute">{sub}</span></span></button>; };

  const prepare = () => once(async () => {
    if (!parsed.ok) return;
    setErr(null); setRead(false); setIntegrity(null);
    if (pending) {                                                               // step 1 of a change: the present authorization goes (no passkey — revoking only removes)
      setStep('revoking');
      try { setRevoked(await lapi.revoke(account.id, cancelFirst, locale)); }
      catch (e) { setErr(liveError(e)); setStep('form'); void refreshLive(qc, account.id); return; }   // nothing changed: the present authorization is still in force
      void refreshLive(qc, account.id);
    }
    setStep('preparing');
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
    // NEXT W1: a lost answer is settled by the account read from the server (is the prepared authorization the active one?)
    const wanted = prep.authorization.authorizationId, was = account.authorization?.id;
    await ap.run({ submit: () => lapi.approveAuthorization(account.id, assertion), read: () => lapi.account(account.id),
      applied: (d) => !!d.authorization?.active && (d.authorization.id === wanted || d.authorization.id !== was) }, (o) => {
      void refreshLive(qc, account.id);
      if (o.kind === 'refused') { setErr(liveError(o.error)); setStep('refused'); return; }   // an answered refusal consumed the prepared authorization
      if (o.kind === 'read' && !o.applied) { setStep('review'); return; }
      onClose();
    });
  });
  const unfunded = err?.code === 'venue_rejected' && isUnfunded(err.detail);
  /** said from the moment the old authorization is gone until the new one is approved */
  const gap = replace && revoked ? <Notice tone="warn"><div data-testid="auth-replaced"><b className="font-semibold">{t('hl1ChgGapTitle')}</b> {t('hl1ChgGap')}
    {revoked.cancelled && <span className="mt-1 block">{t('flCancelAllDone', { requested: revoked.cancelled.requested, accepted: revoked.cancelled.accepted, remaining: revoked.cancelled.remaining === null ? '?' : revoked.cancelled.remaining.length })}</span>}
    {revoked.warning && <span className={`mt-1.5 ${WORDS}`}>{revoked.warning}</span>}</div></Notice> : null;

  return <LiveSheet wide title={replace ? t('hl1ChgTitle') : t('flAuthTitle', { network: account.network })} tone={tone} label={account.label} busy={busy} onClose={onClose}>
    <div className="min-w-0 space-y-4" data-testid="authorize-sheet" data-step={step} data-replace={replace || undefined}>
      <ModeBand tone={tone} label={account.label} />
      <ApprovalOutcomePanel ap={ap} />
      {(step === 'form' || step === 'revoking' || step === 'preparing') && <>
        {gap}
        {pending ? <Notice tone="info"><div data-testid="auth-change-intro">{t('hl1ChgIntro')}</div></Notice> : !replace && <p className="text-[0.84375rem] leading-snug text-mute">{t('flAuthIntro')}</p>}
        {field('maxLeverage', '×', { max: b.maxLeverage })}
        <div data-testid="auth-instruments"><div className="mb-2 text-[0.8125rem] font-medium text-mute">{t('hl1Assets')}</div>
          <div role="radiogroup" aria-label={t('hl1Assets')} className="grid grid-cols-2 gap-2">
            {scopeBtn('all', t('hl1ScopeAll'), t('hl1ScopeAllSub', { n: split.allowed.length }))}{scopeBtn('choose', t('hl1ScopeChoose'), t('hl1ScopeChooseSub', { n: ticked.length }))}</div>
          {f.scope === 'all' && <div className="mt-2.5 space-y-2">
            <p className="text-[0.84375rem] leading-snug" data-testid="auth-all-count" data-n={split.allowed.length}>{t(split.leftOut.length ? 'hl1AllSome' : 'hl1AllEvery', { n: split.allowed.length, total: pinned.length, lev: lev ?? '—' })}</p>
            {split.leftOut.length > 0 && <Notice tone="warn"><div data-testid="auth-left-out" data-n={split.leftOut.length}>
              <b className="font-semibold">{t('hl1LeftOut', { n: split.leftOut.length, lev: lev ?? '—' })}</b> {t('hl1LeftOutHow', { lev: lowest })}
              <span className="mt-1.5 block max-h-[16dvh] overflow-y-auto text-[0.78125rem] leading-relaxed" tabIndex={0}>{split.leftOut.map((p) => `${sym(p.instrument)} (${p.maxLeverage}×)`).join(', ')}</span></div></Notice>}
            {ensureOut && <Notice tone="danger"><div data-testid="auth-ensure-out">{t('hl1EnsureOut', { symbol: sym(ensureOut.instrument), max: ensureOut.maxLeverage })}</div></Notice>}
          </div>}
          {f.scope === 'choose' && <div className="mt-2.5 space-y-2">
            <div className="relative"><Icon n="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
              <input type="search" role="searchbox" aria-label={t('hl1AssetSearch')} placeholder={t('hl1AssetSearch')} className={`${inputCls} !py-2.5 pl-10`} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" data-testid="auth-asset-search" /></div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]"><span className="font-medium" data-testid="auth-ticked" data-n={ticked.length}>{t('hl1Ticked', { n: ticked.length, total: pinned.length })}</span>
              <button type="button" className="min-h-11 font-medium text-blue" onClick={() => patch({ instruments: split.allowed.map((p) => p.instrument) })}>{t('hl1TickAll')}</button>
              <button type="button" className="min-h-11 font-medium text-blue" onClick={() => patch({ instruments: [] })}>{t('hl1TickNone')}</button></div>
            <ul className="max-h-[38dvh] divide-y divide-line/70 overflow-y-auto rounded-[18px] border border-line" data-testid="auth-asset-list">{found.length === 0 ? <li className="px-4 py-4 text-[0.84375rem] text-mute">{t('hl1AssetNone')}</li> : found.map((p) => { const on = ticked.includes(p.instrument), low = lev !== null && p.maxLeverage < lev; return <li key={p.instrument}>
              <label className="row-press flex min-h-[52px] cursor-pointer items-center gap-3 px-3.5"><input type="checkbox" checked={on} onChange={() => patch({ instruments: on ? f.instruments.filter((x) => x !== p.instrument) : [...f.instruments, p.instrument] })} className="h-5 w-5 shrink-0 accent-[var(--blue)]" data-testid="auth-asset" data-id={p.instrument} />
                <AssetIcon sym={sym(p.instrument)} size={28} /><span className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold">{sym(p.instrument)}</span><span className={`shrink-0 text-[0.78125rem] ${low ? 'font-medium text-warn' : 'text-mute'}`}>{t('hl1AssetMax', { max: p.maxLeverage })}</span></label></li>; })}</ul>
            {tooLow.length > 0 && <Notice tone="warn"><div data-testid="auth-too-low">{t('hl1TooLow', { lev: lev ?? '—', list: tooLow.map((p) => `${sym(p.instrument)} (${p.maxLeverage}×)`).join(', ') })}</div></Notice>}
          </div>}
          <p className="mt-2 text-[0.75rem] leading-snug text-mute">{t('hl1AssetsHint', { date: config.pinnedAssets.pinnedAt })}</p></div>
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
          {field('maxOrderNotional', 'USDC')}{field('maxPositionNotional', 'USDC')}{field('maxGrossExposure', 'USDC')}
          {field('maxOrdersPerDay', t('fxPerDay'), { max: b.maxOrdersPerDay })}{field('bandBps', t('fxBps'), { min: b.minPriceBandBps, max: b.maxPriceBandBps })}{field('days', t('flDaysUnit'), { max: b.maxAuthorizationDays })}
        </div>
        {account.network === 'testnet' && <p className="text-[0.75rem] leading-snug text-mute">{t('flBandTestnetNote')}</p>}
        {!parsed.ok && <Notice tone="warn"><div data-testid="policy-problem">{t(`flPol_${parsed.problem}` as Key, { maxLev: b.maxLeverage, maxOrders: b.maxOrdersPerDay, minBand: b.minPriceBandBps, maxBand: b.maxPriceBandBps, maxDays: b.maxAuthorizationDays, maxInst: b.maxInstruments })}</div></Notice>}
        {pending && <div className="space-y-2.5" data-testid="auth-change-effects">
          {(openOrders ?? 0) > 0 && <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-line p-3.5 text-[0.875rem] leading-snug"><input type="checkbox" checked={cancelFirst} disabled={busy} onChange={(e) => setCancelFirst(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]" data-testid="change-cancel-first" />
            <span className="min-w-0 font-medium">{t('flRevokeCancelFirst')}<span className="mt-0.5 block text-[0.78125rem] font-normal text-mute">{t('flRevokeOpenNow', { n: openOrders ?? 0 })}</span></span></label>}
          {!cancelFirst && (openOrders ?? 0) > 0 && <Notice tone="danger">{t('flRevokeLeaves', { n: openOrders ?? 0 })}</Notice>}
          {account.mandate && account.mandate.phase !== 'ended' && <Notice tone="danger"><div data-testid="auth-change-mandate">{t('hl1ChgMandate')}</div></Notice>}
        </div>}
        {err && <LiveErrNotice err={err} />}
        <Btn full busy={step === 'revoking' || step === 'preparing'} disabled={!parsed.ok} onClick={() => void prepare()} data-testid="auth-continue">{t(pending ? 'hl1ChgContinue' : 'flAuthContinue')}</Btn>
        {pending && <p className="text-center text-[0.78125rem] leading-snug text-mute">{t('hl1ChgContinueNote')}</p>}
      </>}

      {prep && (step === 'review' || step === 'passkey' || step === 'sending') && <>
        {gap}
        <Group label={t('flAckTitle')} title={<>1. {t('flAckTitle')}</>}>
          <div tabIndex={0} className="max-h-[38dvh] overflow-y-auto whitespace-pre-wrap rounded-[18px] border border-line bg-elev/50 p-4 text-[0.84375rem] leading-relaxed" data-testid="ack-text">{prep.acknowledgement.text}</div>
          <p className="mt-1.5 break-all font-mono text-[0.65625rem] leading-snug text-mute">SHA-256 {prep.acknowledgement.sha256} · {prep.acknowledgement.version}</p>
          <label className="ack-row mt-2.5"><input type="checkbox" checked={read} disabled={busy} onChange={(e) => setRead(e.target.checked)} data-testid="ack-check" /><span>{t('flAckCheck')}</span></label>
          <p className="mt-1.5 text-[0.75rem] leading-snug text-mute">{t('flAckSigned')}</p></Group>
        <Group title={<>2. {t('flSignedTitle')}</>}>
          <ul className="space-y-2.5 text-[0.84375rem] leading-snug" data-testid="what-is-signed">
            <Bullet icon="key">{t('flSignedMain')}<span className={`mt-1 ${WORDS}`}>{prep.whatIsSigned.byMainKey}</span></Bullet>
            <Bullet icon="shield">{t('flSignedPasskey')}<span className={`mt-1 ${WORDS}`}>{prep.whatIsSigned.byPasskey}</span></Bullet></ul></Group>
        <Group title={<>3. {t('flKeyTitle')}</>}>
          <div className={PLATE}><Addr value={prep.agent.address} />
            <div className="mt-1.5 text-[0.78125rem] text-mute">{t('flKeyExpiry', { date: when(new Date(prep.agent.validUntil), locale) })} · {prep.agent.wireName}</div></div>
          <div className="mt-3 grid grid-cols-1 gap-3 text-[0.84375rem] leading-snug sm:grid-cols-2" data-testid="agent-can">
            <div><div className="mb-1.5 text-[0.78125rem] font-semibold text-emerald">{t('flCan')}</div><ul className="space-y-1.5">{prep.agent.can.map((c) => <Bullet key={c} icon="check" tone="text-emerald">{CAN[c] ? t(CAN[c]!) : c}</Bullet>)}</ul></div>
            <div><div className="mb-1.5 text-[0.78125rem] font-semibold text-danger">{t('flCannot')}</div><ul className="space-y-1.5">{prep.agent.cannot.map((c) => <Bullet key={c} icon="x" tone="text-danger">{CAN[c] ? t(CAN[c]!) : c}</Bullet>)}</ul></div></div>
          <p className="mt-2 text-[0.75rem] leading-snug text-mute">{t('flKeyNote')}<span className="mt-0.5 block break-words font-mono text-[0.6875rem]">{prep.agent.note}</span></p></Group>
        <Group title={<>4. {t('flLimitsTitle')}</>}>
          <div className={TICKET}><PolicyRows p={prep.authorization.policy} total={pinned.length} expires={when(new Date(prep.authorization.expiresAt * 1000), locale)} /></div>
          <p className="mt-2 text-[0.75rem] leading-snug text-mute">{t('flLimitsWho')}</p>
          <div className="mt-1.5"><Fingerprint>{t('fingerprint')} SHA-256 {prep.hash}</Fingerprint></div></Group>
        {integrity && <Notice tone="danger"><div data-testid="integrity">{t(`flIntegrity_${integrity}` as Key)}</div></Notice>}
        {step === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
        {err && <LiveErrNotice err={err} tone={err.key === 'passkey_cancelled' ? 'warn' : 'danger'} />}
        <div className="space-y-2.5">
          <Btn full className="!min-h-[56px] !text-[1rem]" kind={tone === 'mainnet' ? 'danger' : 'primary'} busy={step !== 'review'} disabled={!read || !!integrity} onClick={() => void approve()} data-testid="auth-approve"><Icon n="key" className="h-[18px] w-[18px]" />{t(tone === 'mainnet' ? 'flAuthApproveReal' : 'flAuthApproveTestnet')}</Btn>
          {!read && <p className="text-center text-[0.78125rem] text-mute">{t('flAckNeeded')}</p>}
          <Btn full kind="ghost" disabled={busy} onClick={() => { setStep('form'); setErr(null); }}>{t('flBackToLimits')}</Btn>
        </div>
      </>}

      {step === 'refused' && err && <div className="space-y-3" data-testid="auth-refused">
        {gap}
        {err.code === 'venue_rejected' ? <Notice tone="danger"><b className="font-semibold">{t('flVenueRefusedTitle')}</b> {t('flVenueRefused')}
          <span className="mt-2 block text-[0.75rem] text-mute">{t('flVenueSays')}</span>
          <span className="mt-0.5 block break-words rounded-xl bg-surface/70 px-2.5 py-2 font-mono text-[0.75rem] text-ink" data-testid="venue-words">{venueWords(err.detail)}</span></Notice> : <LiveErrNotice err={err} />}
        {unfunded && <><Notice tone="info">{t('flUnfundedNote')}</Notice><FundingBox network={account.network} collateral={collateral} /></>}
        <Btn full kind="soft" onClick={() => { setStep('form'); setErr(null); setPrep(null); }}><Icon n="refresh" className="h-4 w-4" />{t('flAuthPrepareAgain')}</Btn>
        <Btn full kind="ghost" onClick={onClose}>{t('fxClose')}</Btn></div>}
    </div>
  </LiveSheet>;
}

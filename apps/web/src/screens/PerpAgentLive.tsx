/**
 * v7 perp live — the REAL mode of a perp agent: the go-live checklist, the mandate review (one passkey), and the LIVE page
 * (venue account, mandate card with the signer's counters, held / refused orders in plain words, pause / resume / stop).
 *
 * Which money the agent moves is said by the same band as the live terminal (`ModeBand`): SIMULATION, TESTNET — play money,
 * REAL — real money. Anything that is not known to be the testnet is shown as real money.
 * Everything here comes from the server (`GET /agents/:id`, `GET /agents/:id/perp/live`); nothing is predicted locally, and
 * nothing is signed by this screen: the passkey assertion is passed on untouched.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { RISK_CODES } from '../derivatives/api';
import { DataTable, Pnl, Seg, SideTag, timeOf, type Col } from '../derivatives/bits';
import { D, dec, fmt, usd } from '../derivatives/dec';
import { liveError, sha256Hex, type LiveConfig, type LiveDetail, type LiveErr, type LiveFunding, type LiveLocale, type LiveNetwork, type LiveOrder, type LiveRiskEvent, type MandateBody, type MandatePrepared, type SignerMandate, type Tone, type VenueMandate } from '../derivatives/live';
import { Bullet, LiveErrNotice, LiveStatePill, ModeBand, ModeTag, SourceTag } from '../derivatives/LiveBits';
import type { Fill } from '../derivatives/types';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Card, Fact, Field, H, Icon, inputCls, Notice, ProgressRing, Sheet, Stat, StatGrid, Tag, when, type Tone as PillTone } from '../ui';
import { srvText } from '../srvText'; // v11 interface (audit B3): a server sentence without a code is translated when known, quoted as English otherwise
import { CardHead, EquityCard, PnlArrow, PositionRows } from './agentBits'; // v10 design pass

// ------------------------------------------------------------------------------------------------ shapes of the server's answers
export interface AgentLive { available: boolean; reason: string | null; active: boolean; accountId: string | null; network: LiveNetwork | null; mandateId: string | null; strategySha256: string | null; since: number | null; capital: string | null;
  paused: boolean; exit: { ts: number; code: string; reason: string } | null; account: LiveDetail | null; signer: SignerMandate | null; holds: { ts: number; bar: string; symbol: string; code: string; reason: string }[] }
interface ReadyAccount { id: string; network: LiveNetwork; label: string; account: string; mode: string; modes: string[]; tradable: boolean; authorization: { active: boolean; expiresAt: number } | null; mandate: { id: string; phase: string; agentId: string } | null;
  usedBy: { agentId: string; name: string } | null; equity: string | null; error: string | null }
interface Proposal { capital: string; days: number; maxDays: number; body: MandateBody; derived: { field: string; value: string; from: string }[]; notes: string[] }
export interface Readiness { agentId: string; locale: LiveLocale; config: LiveConfig; accounts: ReadyAccount[]; accountId: string | null;
  steps: { strategy: { ok: boolean; versionId: string | null; sha256: string | null; name: string | null; version: string | null; reason: string | null };
    account: { ok: boolean; code: string | null; reason: string | null; network: LiveNetwork | null; authorization: { active: boolean; expiresAt: number; maxMandateDays: number } | null; instrumentsMissing: string[] };
    funded: { ok: boolean; code: string | null; equity: string | null; minEquity: string; basis: { instruments: { instrument: string; minOrder: string }[]; ordersPerPosition: number; grossX: number; floor: string }; reason: string | null };
    mandate: { ok: boolean; phase: string | null; mandateId: string | null; lock: { code: string; reason: string } | null } };
  next: 'strategy' | 'account' | 'fund' | 'mandate' | 'live' | 'locked'; proposal: Proposal | null; ts: number }

// ------------------------------------------------------------------------------------------------ codes → sentences (unit-tested: every code has a French and an English sentence)
/** every refusal code of the signer under a mandate (docs/v6/DERIVATIVE-MANDATE.md §2), relayed by the API as `signer_<code>` */
export const SIGNER_CODES = ['not_found', 'no_authorization', 'revoked', 'expired', 'wind_down', 'halted', 'bad_request', 'wrong_venue', 'rejected', 'unsupported', 'policy', 'expired_action', 'stale_nonce', 'replay', 'mismatch', 'instrument',
  'order_notional', 'price', 'no_price', 'orders_day', 'orders_hour', 'turnover', 'venue_unreachable', 'venue_stale', 'venue_inconsistent', 'unpriced_position', 'floor_equity', 'leverage_setting', 'position_exceeded', 'gross_exceeded',
  'leverage_exceeded', 'leverage_rate', 'margin_mode'] as const;
/** the live executor's own reasons for not sending an order now */
export const EXECUTOR_CODES = ['live_cooldown', 'live_unknown_pending', 'floor_guard', 'leverage_not_set', 'venue_rejected', 'never_placed'] as const;
const OTHER_REFUSALS = ['signer_unreachable', 'rejected_earlier', 'withdrawn', 'not_signed', 'rejected', 'mandate_floor_equity', 'mandate_wind_down', 'mandate_none', 'halted'];
/** why an agent left real mode (`live.exit.code`) */
export const EXIT_CODES = ['owner_stop', 'mandate_revoked', 'mandate_expired', 'mandate_ended', 'authorization_ended', 'mainnet_disabled', 'mandate_mainnet_disabled', 'halted', 'divergence', 'manual_order', 'liquidation', 'strategy_changed',
  'loss_limit', 'engine_stop', 'signer_revoked', 'signer_expired', 'signer_wind_down', 'signer_no_authorization', 'signer_halted', 'signer_not_found'] as const;
const REFUSALS = new Set<string>([...SIGNER_CODES.map((c) => `signer_${c}`), ...EXECUTOR_CODES, ...OTHER_REFUSALS]), EXITS = new Set<string>(EXIT_CODES);
/** our sentence for a held or refused order: what happened and what to do */
export const refusalKey = (code: string): Key => (REFUSALS.has(code) ? `plR_${code}` : RISK_CODES.has(code) ? `rk_${code}` : code.startsWith('signer_') ? 'plR_signer_other' : 'plR_other') as Key;
export const exitKey = (code: string): Key => (EXITS.has(code) ? `plX_${code}` : 'plX_other') as Key;
/** codes that only mean "wait": shown as information, not as a failure */
const WAITS = new Set(['live_cooldown', 'live_unknown_pending', 'signer_position_exceeded', 'signer_gross_exceeded', 'signer_orders_hour', 'signer_orders_day', 'signer_turnover', 'floor_guard']);

/** which money the agent moves. A live agent whose network is not known to be the testnet is shown as real money. */
export const agentTone = (a: { mode?: string; live?: { network?: string | null } | null; liveNetwork?: string | null }): Tone => (a.mode !== 'LIVE' ? 'paper' : (a.live?.network ?? a.liveNetwork) === 'testnet' ? 'testnet' : 'mainnet');
const sym = (instrument: string) => instrument.slice(instrument.indexOf(':') + 1);
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 12)}…${h.slice(-6)}` : '—');
/** « 23 h 59 min », « 4 min » */
const span = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60_000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; };
function useNow(everyMs = 30_000) { const [n, setN] = useState(() => Date.now()); useEffect(() => { const h = setInterval(() => setN(Date.now()), everyMs); return () => clearInterval(h); }, [everyMs]); return n; }

// ------------------------------------------------------------------------------------------------ band and state

/** the permanent band of a LIVE agent: never dismissible, stays on screen while the page scrolls */
export function AgentModeBand({ a }: { a: any }) {
  const t = useT(); const tone = agentTone(a), L = a.live as AgentLive | undefined;
  // only the band itself stays on screen; the sentence under it scrolls away with the page
  return <><div className="sticky top-1 z-20" data-testid="agent-band" data-tone={tone}><ModeBand tone={tone} label={L?.account?.label ?? undefined} className="shadow-md" /></div>
    <p className="-mt-2 text-[12.5px] leading-snug text-mute">{a.state === 'STOPPING' ? '' : t(L?.active ? 'plBandLive' : 'plBandEnded')} <span data-testid="pl-signal-note">{t(tone === 'testnet' ? 'plSignalNote' : 'plSignalNoteReal')}</span></p></>;
}
const ST_PILL: Record<string, [PillTone, string]> = { LIVE: ['ok', 'check'], PAUSED: ['warn', 'clock'], STOPPING: ['warn', 'clock'], STOPPED: ['mute', 'x'] };
/** the state of an agent in real mode — it never says « réel » by itself: the money is named by the tag beside it */
export function PerpLiveState({ a }: { a: { state: string; mode?: string; live?: { network?: string | null } | null; liveNetwork?: string | null } }) {
  const t = useT(); const [tone, icon] = ST_PILL[a.state] ?? (['mute', 'clock'] as [PillTone, string]);
  return <span className="inline-flex shrink-0 flex-wrap items-center justify-end gap-1.5" data-testid="agent-live-state" data-state={a.state}>
    <Tag tone={tone} icon={icon}>{t(`plSt_${a.state}` as Key)}</Tag>
    <ModeTag tone={agentTone(a)} /></span>;
}

/** a server setting, shown as such: there is no control here that could change it */
function ServerLock({ title, reason }: { title: string; reason: string }) {
  const t = useT();
  return <div role="note" data-testid="server-lock" className="rounded-2xl border-2 border-dashed border-line bg-elev/60 p-3.5 text-[13px] leading-snug">
    <div className="flex items-start gap-2"><Icon n="lock" className="mt-0.5 h-4 w-4 shrink-0" /><b className="font-semibold">{title}</b></div>
    <p className="mt-1.5">{t('plLockBody')}</p>
    <p className="mt-1.5 text-[12px] text-mute">{t('plLockSays')}</p><p className="break-words rounded-lg bg-surface/70 px-2 py-1.5 font-mono text-[11.5px]" data-testid="server-lock-reason">{reason}</p></div>;
}

// ------------------------------------------------------------------------------------------------ go live: the checklist

type StepState = 'done' | 'next' | 'later' | 'locked';
const STEP_PILL: Record<StepState, [PillTone, string, Key]> = { done: ['ok', 'check', 'plStepDone'], next: ['info', 'chev', 'plStepNext'], later: ['mute', 'minus', 'plStepLater'], locked: ['mute', 'lock', 'plStepLocked'] };
function Step({ n, id, state, title, children }: { n: number; id: string; state: StepState; title: string; children: React.ReactNode }) {
  const t = useT(); const [tone, icon, word] = STEP_PILL[state];
  return <li data-testid={`pl-step-${id}`} data-state={state} className={`flex gap-3.5 py-3.5 first:pt-1 ${state === 'later' ? 'opacity-70' : ''}`}>
    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-bold ${state === 'done' ? 'bg-emerald/12 text-emerald' : state === 'next' ? 'bg-primary text-onprimary shadow-[0_0_0_5px_color-mix(in_srgb,var(--primary)_14%,transparent)]' : 'bg-elev text-mute'}`} aria-hidden="true">
      {state === 'done' ? <Icon n="check" className="h-[18px] w-[18px]" /> : state === 'locked' ? <Icon n="lock" className="h-4 w-4" /> : n}</span>
    <div className="min-w-0 flex-1 pt-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[15px] font-semibold leading-snug">{title}</span>
      <Tag tone={tone} icon={icon}>{t(word)}</Tag></div>
      <div className="mt-1.5 space-y-2 text-[13.5px] leading-snug text-mute">{children}</div></div></li>;
}

export function GoLiveCard({ a, id, nav }: { a: any; id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const L = a.live as AgentLive;
  const [accountId, setAccountId] = useState<string | null>(null), [sheet, setSheet] = useState(false);
  const q = useQuery({ queryKey: ['agent', id, 'live-ready', accountId, locale], enabled: !!L?.available, retry: 0, refetchInterval: sheet ? false : 15_000,
    queryFn: () => get<Readiness>(`/agents/${id}/perp/live?locale=${locale}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`) });
  if (!L?.available) return <div data-testid="pl-golive" data-next="unavailable"><div className="flex items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-elev text-mute"><Icon n="lock" /></span><span className="text-[16.5px] font-semibold">{t('plTitle')}</span></div>
    <p className="mt-2.5 text-[13.5px] leading-snug text-mute">{t('plUnavailable')}</p>{L?.reason && <p className="mt-1.5 break-words rounded-lg bg-elev/60 px-2.5 py-2 font-mono text-[11.5px] text-mute">{srvText(t, locale, L.reason)}</p>}</div>;
  const r = q.data, s = r?.steps, sel = r?.accounts.find((x) => x.id === r.accountId) ?? null;
  const order = ['strategy', 'account', 'fund', 'mandate'] as const, at = r ? (r.next === 'locked' || r.next === 'live' ? 3 : order.indexOf(r.next)) : -1;
  const st = (k: number, ok: boolean): StepState => (ok ? 'done' : k === at ? (r?.next === 'locked' ? 'locked' : 'next') : 'later');
  const accounts = () => nav({ tab: 'futures', view: 'accounts' });
  const tone: Tone = sel ? (sel.network === 'testnet' ? 'testnet' : 'mainnet') : 'testnet';
  const markets = s ? s.funded.basis.instruments.map((i) => sym(i.instrument)).join(', ') : '';
  const stepsDone = s ? [s.strategy.ok, s.account.ok, s.funded.ok, s.mandate.ok].filter(Boolean).length : 0;
  return <div className="border-t border-line pt-4" data-testid="pl-golive" data-next={r?.next ?? 'loading'}>
    <div className="flex items-center gap-3.5">{r && s ? <ProgressRing done={stepsDone} total={4} size={56} /> : <span className="skel h-14 w-14 !rounded-full" aria-hidden="true" />}
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[17px] font-semibold tracking-[-0.015em]">{t('paGoLive')}</span>{sel && <ModeTag tone={tone} />}</div></div></div>
    <p className="mt-2.5 text-[13.5px] leading-snug text-mute">{t('plIntro')}</p>
    {q.isError ? <div className="mt-3"><LiveErrNotice err={liveError(q.error)} /></div> : !r || !s ? <div className="mt-3 space-y-3" aria-hidden="true">{[0, 1, 2, 3].map((k) => <div key={k} className="flex gap-3.5"><div className="skel h-9 w-9 !rounded-full" /><div className="flex-1 space-y-2 pt-1"><div className="skel h-4 w-40 !rounded-md" /><div className="skel h-3 w-full !rounded-md" /></div></div>)}</div> : <>
      {r.accounts.length > 1 && <label className="mt-3 block text-[13px] font-medium text-mute">{t('plAccountPick')}
        <select data-testid="pl-account" value={r.accountId ?? ''} onChange={(e) => setAccountId(e.target.value)} className={`${inputCls} mt-1.5 min-h-11 !py-2.5 text-[14.5px] text-ink`}>
          {r.accounts.map((x) => <option key={x.id} value={x.id}>{x.label} — {t(x.network === 'testnet' ? 'plNetTestnet' : 'plNetMainnet')}</option>)}</select></label>}
      <ol className="mt-3 divide-y divide-line">
        <Step n={1} id="strategy" state={st(0, s.strategy.ok)} title={t('plStepStrategy')}>
          {s.strategy.ok ? <p className="break-words">{t('plStrategyOk', { name: s.strategy.name ?? '', version: s.strategy.version ?? '', sha: short(s.strategy.sha256) })}</p> : <p>{t('plStrategyNo')}</p>}</Step>
        <Step n={2} id="account" state={st(1, s.account.ok)} title={t('plStepAccount')}>
          {s.account.ok && sel && s.account.authorization ? <p>{t('plAccountOk', { label: sel.label, date: when(new Date(s.account.authorization.expiresAt), locale) })} <span className="font-semibold text-ink">{t(sel.network === 'testnet' ? 'plNetTestnet' : 'plNetMainnet')}</span></p>
            : <><p data-testid="pl-account-why" data-code={s.account.code ?? ''}>{t(`plAcc_${s.account.code ?? 'no_account'}` as Key, { list: s.account.instrumentsMissing.map(sym).join(', ') })}</p>
              {s.account.code === 'mainnet_disabled' && s.account.reason && <p className="break-words font-mono text-[11.5px]">{t('plLockSays')} {s.account.reason}</p>}
              {/* an account that never deposited cannot even be authorised: said here, where the owner is stopped */}
              {s.account.code === 'read_only' && s.funded.code === 'unfunded' && <p className="font-medium text-warn" data-testid="pl-unfunded-auth">{t('plFund_unfunded')}</p>}</>}</Step>
        <Step n={3} id="funded" state={st(2, s.funded.ok)} title={t('plStepFunded')}>
          {s.funded.ok ? <p>{t('plFundedOk', { equity: fmt(s.funded.equity, { locale, dp: 2 }), min: fmt(s.funded.minEquity, { locale, trim: true }) })} <SourceTag /></p>
            : s.account.ok || s.funded.code === 'unfunded' ? <p data-testid="pl-funded-why" data-code={s.funded.code ?? ''}>{t(`plFund_${s.funded.code ?? 'unfunded'}` as Key, { equity: fmt(s.funded.equity, { locale, dp: 2 }), min: fmt(s.funded.minEquity, { locale, trim: true }) })}</p> : null}
          <p className="text-[12.5px]" data-testid="pl-fund-why">{t('plFundWhy', { min: fmt(s.funded.minEquity, { locale, trim: true }), n: s.funded.basis.ordersPerPosition, markets, gross: fmt(String(s.funded.basis.grossX), { locale, trim: true }) })}</p>
          {sel?.network === 'testnet' && !s.funded.ok && <p className="text-[12.5px]">{t('plFundTestnetNote')}</p>}</Step>
        <Step n={4} id="mandate" state={st(3, s.mandate.ok)} title={t('plStepMandate')}>
          {s.mandate.lock ? <ServerLock title={t('plLockTitle')} reason={s.mandate.lock.reason || r.config.reasons?.[s.mandate.lock.code]?.[locale] || s.mandate.lock.code} />
            : <p>{t('plMandateTodo')}</p>}</Step>
      </ol>
      <div className="mt-3 empty:hidden">
        {r.next === 'strategy' && <Btn full data-testid="pl-next" onClick={() => document.getElementById('pl-strategy')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{t('plGoStrategy')}</Btn>}
        {r.next === 'account' && <Btn full data-testid="pl-next" onClick={accounts}><Icon n="chev" className="h-4 w-4" />{t('plGoAccounts')}</Btn>}
        {r.next === 'fund' && <Btn full data-testid="pl-next" onClick={accounts}><Icon n="down" className="h-4 w-4" />{t('plGoFund')}</Btn>}
        {r.next === 'mandate' && <Btn full data-testid="pl-next" kind={tone === 'mainnet' ? 'danger' : 'primary'} onClick={() => setSheet(true)}><Icon n="key" className="h-4 w-4" />{t('plGoMandate')}</Btn>}
      </div>
      <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('plManualWarn')}</p>
      {sheet && sel && r.proposal && <MandateSheet id={id} r={r} account={sel} onClose={() => { setSheet(false); void qc.invalidateQueries({ queryKey: ['agent', id] }); void qc.invalidateQueries({ queryKey: ['agents'] }); void qc.invalidateQueries({ queryKey: ['deriv', 'live'] }); }} />}
    </>}
  </div>;
}

// ------------------------------------------------------------------------------------------------ the mandate: review, ONE passkey

/** hairline rows of a mandate, inside a <dl>: every limit, in full */
const FACTS = '[&_.fact]:border-t [&_.fact]:border-line [&>.fact:first-child]:border-t-0';
function MandateRows({ m }: { m: VenueMandate }) {
  const t = useT(); const { locale } = useContext(I18n);
  return <div data-testid="mandate-limits">
    {m.instruments.map((i) => <Fact key={i.instrument} k={t('plShInstrument', { symbol: sym(i.instrument) })}><b className="font-semibold">{i.maxLeverage}× / {usd(i.maxPositionNotional, locale)}</b></Fact>)}
    <Fact k={t('plShOrder')}>{usd(m.maxOrderNotional, locale)}</Fact><Fact k={t('plShGross')}>{usd(m.maxGrossExposure, locale)}</Fact>
    <Fact k={t('plShPerDay')}>{m.maxOrdersPerDay}</Fact><Fact k={t('plShPerHour')}>{m.maxOrdersPerHour}</Fact><Fact k={t('plShTurnover')}>{usd(m.maxDailyTurnover, locale)}</Fact>
    <Fact k={t('plShFloor')}><b className="font-semibold">{usd(m.floorEquity, locale)}</b></Fact><Fact k={t('plShBand')}>{m.maxPriceDeviationBps} pb</Fact>
    <Fact k={t('plShExpires')}><b className="font-semibold">{when(new Date(m.expiresAt * 1000), locale)}</b></Fact></div>;
}

type MPhase = 'form' | 'preparing' | 'review' | 'passkey' | 'sending' | 'done' | 'void';
function MandateSheet({ id, r, account, onClose }: { id: string; r: Readiness; account: ReadyAccount; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const p0 = r.proposal!, tone: Tone = account.network === 'testnet' ? 'testnet' : 'mainnet';
  const [days, setDays] = useState(String(p0.days));
  const [phase, setPhase] = useState<MPhase>('form'), [prep, setPrep] = useState<(MandatePrepared & { proposal: Proposal }) | null>(null), [read, setRead] = useState(false);
  const [err, setErr] = useState<LiveErr | null>(null), [integrity, setIntegrity] = useState<string | null>(null);
  const lock = useRef(false), busy = phase === 'preparing' || phase === 'passkey' || phase === 'sending';
  const nDays = /^\d{1,2}$/.test(days.trim()) ? Number(days.trim()) : 0, daysOk = nDays >= 1 && nDays <= p0.maxDays;
  const once = async (f: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await f(); } finally { lock.current = false; } };
  const prepare = () => once(async () => {
    setPhase('preparing'); setErr(null); setIntegrity(null); setRead(false);
    try {
      const p = await post<MandatePrepared & { proposal: Proposal }>(`/agents/${id}/perp/live/prepare`, { accountId: account.id, days: nDays, locale });
      // what the passkey will sign must be THIS agent, THIS strategy version, THIS account's network, and the text on screen
      const why = p.mandate.agentId !== id ? 'agent' : p.mandate.strategySha256 !== r.steps.strategy.sha256 ? 'strategy' : p.mandate.network !== account.network ? 'network'
        : p.acknowledgement.sha256 !== p.mandate.ackSha256 || (await sha256Hex(p.acknowledgement.text)) !== p.mandate.ackSha256 ? 'ack' : null;
      setIntegrity(why); setPrep(p); setPhase('review');
    } catch (e) { setErr(liveError(e, 'propose')); setPhase('form'); }
  });
  const approve = () => once(async () => {
    if (phase !== 'review' || !prep || !read || integrity) return;
    setPhase('passkey'); setErr(null);
    let assertion: unknown, bindingAssertion: unknown;
    // V11.2: two prompts — the signer's (the derivative mandate it will enforce), then the API's (the full trading mandate hash)
    try { assertion = await startAuthentication({ optionsJSON: prep.options }); const b = (prep as unknown as { binding?: { options: Parameters<typeof startAuthentication>[0]['optionsJSON'] } }).binding; if (b) bindingAssertion = await startAuthentication({ optionsJSON: b.options }); }
    catch (e) { setErr(liveError(e, 'approve')); setPhase('void'); return; }
    setPhase('sending');
    try { await post(`/agents/${id}/perp/live/approve`, { accountId: account.id, assertion, ...(bindingAssertion ? { bindingAssertion } : {}), acknowledged: true }); setPhase('done'); }
    catch (e) { setErr(liveError(e, 'approve')); setPhase('void'); }      // a refused approval consumes the preparation
  });
  const m = prep?.mandate, lockCode = err && (err.code === 'mandate_mainnet_disabled' || err.code === 'mainnet_disabled') ? err.code : null;
  const list = (title: string, items: string[], icon: string, cls: string, testid: string) => <section><h3 className="t-eyebrow mb-2">{title}</h3>
    <ul className="space-y-2 text-[13.5px] leading-snug" data-testid={testid}>{items.map((x) => <Bullet key={x} icon={icon} tone={cls}>{x}</Bullet>)}</ul></section>;
  const h3 = 't-eyebrow mb-2';
  // an APPROVAL sheet: no close control, no tap-outside, no drag — it closes only through its own buttons
  return <Sheet title={t('plShTitle')} onClose={() => { if (!busy) onClose(); }} wide dismissable={false} busy={busy}>
    <div className="space-y-4" data-testid="mandate-sheet" data-phase={phase}>
      <ModeBand tone={tone} label={account.label} />
      {(phase === 'form' || phase === 'preparing') && <>
        <div className="rounded-2xl bg-elev/60 p-3.5 text-[13.5px] leading-snug" data-testid="mandate-capital"><div className="t-eyebrow mb-1">{t('plShCapital')}</div>{t('plShCapitalIs', { capital: fmt(p0.capital, { locale, dp: 2 }) })}</div>
        <Field label={t('plShDays')} hint={t('plShDaysHint', { max: p0.maxDays })}><span className="relative block">
          <input className={`${inputCls} t-num !py-3 pr-20 text-[22px]`} inputMode="numeric" aria-label={t('plShDays')} value={days} disabled={busy} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))} /><span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-medium text-mute">{t('plShDaysUnit')}</span></span></Field>
        {!daysOk && <Notice tone="warn"><div data-testid="mandate-problem">{t('plShBadDays', { max: p0.maxDays })}</div></Notice>}
        {lockCode ? <ServerLock title={t('plLockTitle')} reason={r.config.reasons?.[lockCode]?.[locale] ?? err!.detail} /> : err && <LiveErrNotice err={err} />}
        <div className="space-y-2.5 pt-1"><Btn full busy={phase === 'preparing'} disabled={!daysOk} onClick={() => void prepare()} data-testid="mandate-continue">{t('plShContinue')}</Btn>
          <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Btn></div>
      </>}

      {prep && m && (phase === 'review' || phase === 'passkey' || phase === 'sending' || phase === 'void') && <div className={`space-y-5 ${phase === 'void' ? 'opacity-60' : ''}`}>
        <Notice tone="warn"><div data-testid="mandate-warning"><b className="font-semibold">{t('plShWarning')}</b><span className="mt-0.5 block">{prep.warning}</span></div></Notice>
        <section><h3 className={h3}>1. {t('plShLimits')}</h3>
          <dl className={`rounded-2xl border border-line px-4 py-1 ${FACTS}`}>
            <Fact k={t('plShNetwork')}><b className="font-semibold" data-testid="mandate-network">{t(m.network === 'testnet' ? 'plNetTestnet' : 'plNetMainnet')}</b></Fact>
            <Fact k={t('plShAccount')}><span className="break-all font-mono text-[11.5px] font-normal">{m.account}</span></Fact>
            <Fact k={t('plShStrategy')}><span className="break-all font-mono text-[11.5px] font-normal" data-testid="mandate-sha">{m.strategySha256}</span></Fact>
            <Fact k={t('plShAgent')}><span className="break-all font-mono text-[11.5px] font-normal">{m.agentId}</span></Fact>
            <MandateRows m={m} />
            <Fact k={t('plShAuthExpires')}>{when(new Date(prep.authorization.expiresAt), locale)}</Fact></dl>
          <p className="mt-2 text-[12.5px] leading-snug text-mute">{t('plShFloorNote')}</p>
          {prep.proposal.notes.length > 0 && <p className="mt-1 text-[12.5px] font-medium leading-snug text-warn">{t('plShTighter')}</p>}
          <details className="mt-2 rounded-2xl bg-elev/60 p-3.5 text-[12.5px]"><summary className="flex min-h-6 cursor-pointer items-center font-semibold">{t('plShDerived')}</summary>
            <ul className="mt-2 space-y-1.5" data-testid="mandate-derived">{prep.proposal.derived.map((x) => { const k = t(`plD_${x.field}` as Key); return <li key={x.field}><span className="break-all font-mono text-[11.5px]">{x.field} = {x.value}</span><span className="block text-mute">{k.startsWith('plD') || k.startsWith('lD') ? x.from : k}</span></li>; })}</ul></details></section>
        <section aria-label={t('flAckTitle')}><h3 className={h3}>2. {t('flAckTitle')}</h3>
          <div tabIndex={0} className="max-h-[34dvh] overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-elev/50 p-3.5 text-[13.5px] leading-relaxed" data-testid="ack-text">{prep.acknowledgement.text}</div>
          <p className="mt-1.5 break-all font-mono text-[10.5px] text-mute">SHA-256 {prep.acknowledgement.sha256} · {prep.acknowledgement.version}</p>
          <label className="mt-2.5 flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl border border-line px-3.5 py-2.5 text-[14.5px] font-medium"><input type="checkbox" checked={read} disabled={phase !== 'review'} onChange={(e) => setRead(e.target.checked)} className="h-[22px] w-[22px] shrink-0 accent-[var(--blue)]" data-testid="ack-check" /><span>{t('flAckCheck')}</span></label>
          <p className="mt-1.5 text-[12.5px] leading-snug text-mute">{t('plShAckSigned')}</p></section>
        {list(`3. ${t('plShEnforced')}`, prep.enforcedBySigner, 'shield', 'text-emerald', 'mandate-enforced')}
        {list(`4. ${t('plShTrusted')}`, prep.trustedBySigner, 'eye', 'text-mute', 'mandate-trusted')}
        {list(`5. ${t('plShNotEnforced')}`, prep.notEnforced, 'warn', 'text-warn', 'mandate-not-enforced')}
        <section><h3 className={h3}>6. {t('plShWindDown')}</h3><p className="text-[13.5px] leading-snug" data-testid="mandate-winddown">{prep.windDown.text}</p></section>
        <section><h3 className={h3}>7. {t('plShSigned')}</h3><p className="text-[13.5px] leading-snug">{prep.whatIsSigned.byPasskey}</p>
          <p className="mt-1.5 break-all font-mono text-[10.5px] text-mute">{t('fingerprint')} SHA-256 {prep.hash}</p></section>
      </div>}
      {integrity && phase !== 'form' && <Notice tone="danger"><div data-testid="mandate-integrity">{t(`plShInt_${integrity}` as Key)}</div></Notice>}
      {phase === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
      {phase === 'sending' && <p className="flex items-center gap-2 text-[13.5px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('plShSending')}</p>}
      {phase !== 'form' && phase !== 'preparing' && (lockCode ? <ServerLock title={t('plLockTitle')} reason={r.config.reasons?.[lockCode]?.[locale] ?? err!.detail} /> : err && <LiveErrNotice err={err} tone={err.key === 'passkey_cancelled' ? 'warn' : 'danger'}>
        {phase === 'void' && <span className="mt-1 block">{t('plShConsumed')}</span>}</LiveErrNotice>)}
      {phase === 'done' && <Notice tone="ok"><div data-testid="mandate-done">{t('plShDone')}</div></Notice>}

      {(phase === 'review' || phase === 'passkey' || phase === 'sending') && <div className="space-y-2.5">
        <Btn full kind={tone === 'mainnet' ? 'danger' : 'primary'} busy={phase !== 'review'} disabled={!read || !!integrity} onClick={() => void approve()} data-testid="mandate-approve"><Icon n="key" className="h-4 w-4" />{t(tone === 'mainnet' ? 'plShApproveReal' : 'plShApproveTestnet')}</Btn>
        <p className="text-center text-[12.5px] text-mute">{read ? t('plShOne') : t('flAckNeeded')}</p>
        <Btn full kind="ghost" disabled={busy} onClick={() => { setPhase('form'); setErr(null); setPrep(null); }}>{t('plShBack')}</Btn></div>}
      {phase === 'void' && <Btn full kind="soft" data-testid="mandate-again" onClick={() => { setPhase('form'); setPrep(null); }}>{t('plShAgain')}</Btn>}
      {(phase === 'done' || phase === 'void') && <Btn full kind={phase === 'done' ? 'soft' : 'ghost'} onClick={onClose} data-testid="mandate-close">{t('fxClose')}</Btn>}
    </div>
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------ LIVE: the venue account, the mandate, holds, controls

/** a held or refused order in plain words: ours first, then the server's own */
export function Refusal({ code, reason }: { code: string; reason?: string }) {
  const t = useT();
  return <span data-testid="pl-refusal" data-code={code}>{t(refusalKey(code))}
    <span className="mt-1 block break-words font-mono text-[11px] text-mute">{t('plServerDetail')} {code}{reason ? ` — ${reason}` : ''}</span></span>;
}

function MandateCard({ a }: { a: any }) {
  const t = useT(); const { locale } = useContext(I18n); const now = useNow();
  const L = a.live as AgentLive, ms = L.account?.mandate ?? null, sg = L.signer, m = ms?.limits ?? sg?.mandate ?? null;
  if (!m) return null;
  const phase = ms?.phase ?? sg?.phase ?? 'ended', until = ms?.windDownUntil ?? (sg?.windDownUntil ? sg.windDownUntil * 1000 : null), equity = L.account?.venueState.state?.equity ?? null;
  const bar = (used: number, max: number) => <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-elev"><span className={`block h-full rounded-full ${used >= max ? 'bg-danger' : used >= 0.8 * max ? 'bg-warn' : 'bg-blue'}`} style={{ width: `${Math.max(0, Math.min(100, max > 0 ? (used / max) * 100 : 0))}%` }} /></span>;
  const [ptone, picon]: [PillTone, string] = phase === 'active' ? ['ok', 'key'] : phase === 'wind_down' ? ['warn', 'clock'] : ['mute', 'lock'];
  return <Card><div data-testid="pl-mandate" data-phase={phase}>
    <H right={<Tag tone={ptone} icon={picon} testid="pl-mandate-phase">{t(`plPhase_${phase}` as Key)}</Tag>}>{t('plMandate')}</H>
    {phase === 'wind_down' && <Notice tone="warn"><div data-testid="pl-winddown"><b className="font-semibold">{until ? t('plWindDownLeft', { time: span(until - now) }) : t('plPhase_wind_down')}</b><span className="mt-0.5 block">{t('plWindDownText')}</span></div></Notice>}
    <dl className={`${phase === 'wind_down' ? 'mt-3' : ''} ${FACTS}`}>
      <Fact k={t('plShNetwork')}><b className="font-semibold">{t(m.network === 'testnet' ? 'plNetTestnet' : 'plNetMainnet')}</b></Fact>
      <Fact k={t('plShStrategy')}><span className="break-all font-mono text-[11.5px] font-normal">{short(m.strategySha256)}</span></Fact>
      <MandateRows m={m} /></dl>
    {equity && <p className="mt-2 text-[12.5px] leading-snug text-mute" data-testid="pl-floor">{t('plFloorNow', { floor: fmt(m.floorEquity, { locale, dp: 2 }), equity: fmt(equity, { locale, dp: 2 }) })}</p>}
    <div className="mt-4 border-t border-line pt-4" data-testid="pl-usage"><div className="t-eyebrow mb-2.5">{t('plUsage')}</div>
      {!sg ? <p className="text-[13px] text-mute">{t('plUsageNone')}</p> : <div className="grid grid-cols-1 gap-x-5 gap-y-3 text-[13.5px] sm:grid-cols-3">
        <div><div className="flex justify-between gap-2"><span className="text-mute">{t('plUsageOrders')}</span><span className="shrink-0 font-semibold">{sg.today.orders} / {m.maxOrdersPerDay}</span></div>{bar(sg.today.orders, m.maxOrdersPerDay)}</div>
        <div><div className="flex justify-between gap-2"><span className="text-mute">{t('plUsageHour')}</span><span className="shrink-0 font-semibold">{sg.ordersLastHour} / {m.maxOrdersPerHour}</span></div>{bar(sg.ordersLastHour, m.maxOrdersPerHour)}</div>
        <div><div className="flex flex-wrap justify-between gap-x-2"><span className="text-mute">{t('plUsageTurnover')}</span><span className="font-semibold">{usd(sg.today.turnover, locale)} / {usd(m.maxDailyTurnover, locale)}</span></div>{bar(Number(sg.today.turnover), Number(m.maxDailyTurnover))}</div>
        <div className="flex justify-between gap-2 sm:col-span-2"><span className="text-mute">{t('plUsageReduce')}</span><span className="font-semibold">{sg.today.reduceOnly}</span></div>
        <div className="flex justify-between gap-2"><span className="text-mute">{t('plUsageLeverage')}</span><span className="font-semibold">{sg.today.leverage} / 20</span></div></div>}
    </div></div></Card>;
}

function StopSheet({ a, id, onClose }: { a: any; id: string; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const L = a.live as AgentLive, n = L.account?.venueState.error ? null : L.account?.venueState.positions.length ?? null;
  const [busy, setBusy] = useState(false), [err, setErr] = useState<LiveErr | null>(null), [done, setDone] = useState<{ windDown: { until: number | null; text: string; openPositions: number | null; openOrders: number | null } | null; result?: string } | null>(null);
  const lock = useRef(false);
  const stop = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setErr(null);
    try { setDone(await post(`/agents/${id}/perp/live/stop`, { locale })); } catch (e) { setErr(liveError(e)); }
    finally { lock.current = false; setBusy(false); void qc.invalidateQueries({ queryKey: ['agent', id] }); void qc.invalidateQueries({ queryKey: ['agents'] }); void qc.invalidateQueries({ queryKey: ['deriv', 'live'] }); }
  };
  // a CONFIRMATION sheet: it closes only through its own buttons
  return <Sheet title={t('plStopTitle')} onClose={() => { if (!busy) onClose(); }} dismissable={false} busy={busy}><div className="space-y-3.5" data-testid="pl-stop-sheet">
    <ModeBand tone={agentTone(a)} label={L.account?.label} />
    {!done ? <>
      <Notice tone="warn">{t('plStopBody')}</Notice>
      {n !== null && <p className="rounded-2xl bg-elev/60 px-3.5 py-3 text-[14.5px] font-semibold">{t('plStopOpen', { n })}</p>}
      <p className="text-[12.5px] leading-snug text-mute">{t('plManual')}</p>
      {err && <LiveErrNotice err={err} />}
      <div className="space-y-2.5 pt-1"><Btn full kind="danger" busy={busy} onClick={() => void stop()} data-testid="pl-stop-confirm"><Icon n="stop" className="h-4 w-4" />{t('plStopConfirm')}</Btn>
        <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Btn></div></> : <div className="space-y-3.5" data-testid="pl-stop-done">
      <Notice tone="ok">{t('plStopping')}</Notice>
      {done.windDown && <p className="text-[13.5px] leading-snug">{done.windDown.text}</p>}
      {done.result && <p className="break-words rounded-lg bg-elev/60 px-2.5 py-2 font-mono text-[11.5px] text-mute" data-testid="pl-stop-result">{t('plStopResult')} {done.result}</p>}
      <Btn full kind="soft" onClick={onClose}>{t('fxClose')}</Btn></div>}
  </div></Sheet>;
}

/**
 * The top of the page in real mode — what the agent is in (why it left, what is still open), then the money: the venue
 * account, its curve, the mandate with the signer's counters, the held or refused orders.
 */
export function LivePanel({ a, id, nav }: { a: any; id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const now = useNow();
  const L = a.live as AgentLive, acct = L.account, vs = acct?.venueState, state = vs?.state ?? null, tone = agentTone(a);
  const px = (x: string | null | undefined) => fmt(x, { locale, trim: true });
  const result = state && L.capital ? D.sub(D.from(state.equity), D.from(L.capital)) : null;
  const eq = (acct?.equity ?? []).map((e) => ({ t: e.ts, p: Number(e.equity) }));
  const until = acct?.mandate?.windDownUntil ?? (L.signer?.windDownUntil ? L.signer.windDownUntil * 1000 : null);
  void id;
  return <>
    {L.exit && <Notice tone={a.state === 'STOPPED' ? 'warn' : 'danger'}><div data-testid="pl-exit" data-code={L.exit.code}>
      <b className="font-semibold">{t('plExitTitle')}</b><span className="mt-0.5 block">{t(exitKey(L.exit.code))}</span>
      <span className="mt-1.5 block text-[11.5px] text-mute">{t('plServerDetail')}</span>
      <span className="block break-words font-mono text-[11px] text-mute" data-testid="pl-exit-detail">{L.exit.code} — {a.state === 'STOPPED' && a.stopReason ? a.stopReason : L.exit.reason} ({when(new Date(L.exit.ts), locale)})</span></div></Notice>}
    {a.state === 'STOPPING' && <Notice tone="warn"><div data-testid="pl-stopping"><b className="font-semibold">{t('plStopping')}</b>
      {vs && !vs.error && <span className="mt-0.5 block">{t('plStoppingLeft', { n: vs.positions.length })}</span>}
      {until && <span className="mt-0.5 block">{t('plWindDownLeft', { time: span(until - now) })}</span>}
      <span className="mt-1 block text-[12.5px]">{t('plManual')}</span></div></Notice>}
    {a.state === 'STOPPED' && vs && !vs.error && vs.positions.length > 0 && <div role="alert" data-testid="pl-open-left" className="rounded-[22px] border-2 border-danger bg-danger/10 p-4 text-[14px] leading-snug">
      <b className="flex items-start gap-2 text-[15.5px] font-bold text-danger"><Icon n="warn" className="mt-0.5 h-5 w-5 shrink-0" />{t('plOpenLeftTitle', { n: vs.positions.length })}</b>
      <ul className="mt-2 space-y-0.5 font-mono text-[12.5px]">{vs.positions.map((p) => <li key={p.instrument}>{p.side} {px(p.size)} {sym(p.instrument)}</li>)}</ul>
      <p className="mt-2">{t('plOpenLeft')}</p>
      <Btn kind="danger" full className="mt-3" onClick={() => nav({ tab: 'futures' })}>{t('plOpenTerminal')}</Btn></div>}
    {a.state === 'PAUSED' && L.active && <Notice tone="warn"><div data-testid="pl-paused">{t('plPaused')}</div></Notice>}
    {acct?.halted && <Notice tone="danger"><span className="break-words">{t('plR_halted')} <span className="font-mono text-[11.5px]">{acct.halted}</span></span></Notice>}

    <div className="space-y-4">
    <Card><div data-testid="pl-account" data-network={L.network ?? ''}><CardHead right={<ModeTag tone={tone} />}>{t('plVenueAccount')}</CardHead>
      {!acct ? <div className="flex items-center gap-3.5 rounded-2xl bg-elev/60 px-4 py-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface text-mute"><Icon n="cloudOff" /></span><p className="text-[14px] leading-snug text-mute">{t('plNoAccount')}</p></div> : vs?.error || !state ? <Notice tone="danger">{t('flUnreadable')} <span className="break-words font-mono text-[11.5px] text-mute">{vs?.error}</span></Notice> : <>
        <div className="text-[13px] text-mute">{t('plValue')}</div>
        <div className="t-display mt-1.5 text-[clamp(34px,10.5vw,44px)]" data-testid="pl-equity">{usd(state.equity, locale)}</div>
        <div className="mt-2 space-y-0.5 text-[13.5px] text-mute">{L.capital ? <div>{t('plCapitalRef', { capital: fmt(L.capital, { locale, dp: 2 }) })}</div> : null}<div>{t('plResult')} <span className="font-semibold"><PnlArrow value={result ? D.str(result) : null} locale={locale} /></span></div></div>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-mute"><SourceTag />{t('flReadAt', { time: timeOf(vs!.ts, locale) })}{L.since ? ` · ${t('plSince', { date: when(new Date(L.since), locale) })}` : ''}</p>
        <StatGrid cols={4} className="mt-4">
          <Stat label={t('paCollateral')} value={usd(state.collateral, locale)} /><Stat label={t('paMarginUsed')} value={usd(state.marginUsed, locale)} />
          <Stat label={t('paFree')} value={usd(state.freeCollateral, locale)} /><Stat label={t('paLastBar')} value={<span className="text-[15px]">{a.lastBar ? when(a.lastBar, locale) : '—'}</span>} /></StatGrid>
        <div className="mt-5"><div className="t-eyebrow mb-2">{t('paPositions')}</div>
          <PositionRows positions={vs!.positions} venue="hyperliquid" locale={locale} px={px} empty={t('paNoPositions')} label={t('paPositions')} /></div>
      </>}
      <button type="button" onClick={() => nav({ tab: 'futures' })} className="press mt-3 inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-blue">{t('plOpenTerminal')}<Icon n="chev" className="h-4 w-4" /></button>
      <p className="text-[12.5px] leading-snug text-mute">{t('plManual')}</p>
    </div></Card>

    <div className="min-w-0 space-y-4">
    {acct && <EquityCard title={t('plEquity')} right={<ModeTag tone={tone} />} points={eq} format={(v) => usd(dec(v.toFixed(2)), locale)} formatTime={(ts) => timeOf(ts, locale, true)} testid="pl-equity-card" />}

    <Card><div data-testid="pl-holds"><H>{t('plHolds')}</H>
      {L.holds.length === 0 ? <p className="text-[13.5px] leading-snug text-mute">{t('plHoldsNone')}</p> : <ul className="divide-y divide-line">{L.holds.slice(0, 12).map((h, k) => { const wait = WAITS.has(h.code); return <li key={k} className="flex gap-3 py-3 text-[13.5px] leading-snug first:pt-0 last:pb-0">
        <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${wait ? 'bg-blue/10 text-blue' : 'bg-danger/10 text-danger'}`} aria-hidden="true"><Icon n={wait ? 'clock' : 'x'} className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1"><div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5"><span className="text-[14.5px] font-semibold">{h.symbol}</span><span className="text-[12px] text-mute">{t('plHoldBar', { bar: when(h.bar, locale) })}</span></div>
          <Refusal code={h.code} reason={h.reason} /></div></li>; })}</ul>}</div></Card>
    </div></div>

    <MandateCard a={a} />
  </>;
}

type ATab = 'orders' | 'fills' | 'funding' | 'events';
/** what the agent did on the venue account: orders, fills, funding, risk events */
export function LiveActivity({ a }: { a: any }) {
  const t = useT(); const { locale } = useContext(I18n);
  const L = a.live as AgentLive, acct = L.account, tone = agentTone(a);
  const [tab, setTab] = useState<ATab>('orders');
  const px = (x: string | null | undefined) => fmt(x, { locale, trim: true });
  const ordCols: Col<LiveOrder>[] = [
    { id: 't', label: t('paColTime'), cell: (o) => timeOf(o.createdAt, locale, true) }, { id: 'i', label: t('paColInst'), head: true, cell: (o) => <span className="font-semibold">{sym(o.instrument)}</span> },
    { id: 's', label: t('paColSide'), head: true, cell: (o) => <span className="inline-flex items-center gap-2"><SideTag side={o.side} />{o.reduceOnly && <span className="rounded bg-elev px-1.5 text-[11px] font-semibold text-mute">{t('paReduceOnly')}</span>}</span> },
    { id: 'z', label: t('paColSize'), num: true, cell: (o) => `${px(o.filled)} / ${px(o.size)}` }, { id: 'p', label: t('paColAvg'), num: true, cell: (o) => px(o.avgFillPrice) }, { id: 'w', label: t('paColWorst'), num: true, cell: (o) => px(o.price) },
    { id: 'x', label: t('paColStatus'), cell: (o) => <span className="inline-flex items-center gap-1.5" title={o.reason ?? ''}><LiveStatePill state={o.state} /><SourceTag source={o.source} /></span> },
    { id: 'o', label: '', cell: (o) => <span className={`rounded px-1.5 text-[11px] font-semibold ${o.origin === 'mandate' ? 'bg-elev text-mute' : 'bg-warn/12 text-warn'}`} title={o.origin === 'mandate' ? '' : t('plNotFromAgent')}>{t(o.origin === 'mandate' ? 'plOriginAgent' : 'plOriginOwner')}</span> }];
  const fillCols: Col<Fill>[] = [
    { id: 't', label: t('paColTime'), cell: (x) => timeOf(x.ts, locale, true) }, { id: 'i', label: t('paColInst'), head: true, cell: (x) => <span className="font-semibold">{sym(x.instrument)}</span> }, { id: 's', label: t('paColSide'), head: true, cell: (x) => <SideTag side={x.side} /> },
    { id: 'z', label: t('paColSize'), num: true, cell: (x) => px(x.size) }, { id: 'p', label: t('paColPrice'), num: true, cell: (x) => px(x.price) }, { id: 'f', label: t('paColFee'), num: true, cell: (x) => usd(x.fee, locale) },
    { id: 'c', label: t('paColClosed'), num: true, cell: (x) => <Pnl value={x.closedPnl} locale={locale} /> }];
  const fundCols: Col<LiveFunding>[] = [
    { id: 't', label: t('paColTime'), cell: (x) => timeOf(x.ts, locale, true) }, { id: 'i', label: t('paColInst'), head: true, cell: (x) => <span className="font-semibold">{sym(x.instrument)}</span> },
    { id: 'r', label: t('paColRate'), num: true, cell: (x) => `${fmt(D.mul(D.from(x.rate), D.from(100n)), { dp: 5, locale })} %` }, { id: 'z', label: t('paColSize'), num: true, cell: (x) => px(x.size) },
    { id: 'a', label: t('paColAmount'), num: true, cell: (x) => <Pnl value={x.amount} locale={locale} dp={4} /> }];
  const evCols: Col<LiveRiskEvent>[] = [
    { id: 't', label: t('paColTime'), cell: (x) => timeOf(x.ts, locale, true) }, { id: 'k', label: t('paColKind'), head: true, cell: (x) => <span className="font-semibold">{x.kind}</span> },
    { id: 'm', label: '', full: true, cell: (x) => <span className="whitespace-normal text-mute">{x.code && x.kind === 'order_refused' ? <Refusal code={x.code} reason={x.message} /> : x.message}</span> }];
  if (!acct) return null;
  return <Card><CardHead right={<ModeTag tone={tone} />}>{t('plActivity')}</CardHead>
    <Seg<ATab> value={tab} onChange={setTab} label={t('plActivity')} tabs size="sm" className="mb-3" options={[{ id: 'orders', label: `${t('paOrders')} (${acct.orders.length})` }, { id: 'fills', label: `${t('paFills')} (${acct.fills.length})` },
      { id: 'funding', label: `${t('paFunding')} (${acct.funding.length})` }, { id: 'events', label: `${t('paEvents')} (${acct.riskEvents.length})` }]} />
    {tab === 'orders' && <DataTable cols={ordCols} rows={acct.orders} rowKey={(o) => o.clientId} empty={t('paNone')} label={t('paOrders')} />}
    {tab === 'fills' && <DataTable cols={fillCols} rows={acct.fills} rowKey={(x) => x.id} empty={t('paNone')} label={t('paFills')} />}
    {tab === 'funding' && <DataTable cols={fundCols} rows={acct.funding} rowKey={(x) => `${x.instrument}:${x.ts}`} empty={t('paNone')} label={t('paFunding')} />}
    {tab === 'events' && <DataTable cols={evCols} rows={acct.riskEvents} rowKey={(x) => String(x.id)} empty={t('paNone')} label={t('paEvents')} />}
  </Card>;
}

/** the controls of a live agent, last on the page: pause / resume, and stop (danger) behind a confirmation sheet */
export function LiveControls({ a, id }: { a: any; id: string }) {
  const t = useT(); const qc = useQueryClient();
  const L = a.live as AgentLive;
  const [busy, setBusy] = useState(''), [err, setErr] = useState<LiveErr | null>(null), [stop, setStop] = useState(false);
  const act = async (name: string, path: string) => { setBusy(name); setErr(null); try { await post(`/agents/${id}/perp/live/${path}`, {}); } catch (e) { setErr(liveError(e)); } finally { setBusy(''); void qc.invalidateQueries({ queryKey: ['agent', id] }); void qc.invalidateQueries({ queryKey: ['agents'] }); } };
  return <>
    {err && <LiveErrNotice err={err} />}
    {L.active && (a.state === 'LIVE' || a.state === 'PAUSED') && <Card><div data-testid="pl-controls"><CardHead right={<ModeTag tone={agentTone(a)} />}>{t('plControl')}</CardHead>
      <div className="space-y-2.5">
        {a.state === 'LIVE' && <><Btn kind="ghost" full busy={busy === 'pause'} onClick={() => void act('pause', 'pause')} data-testid="pl-pause"><Icon n="clock" className="h-4 w-4 shrink-0" />{t('plPause')}</Btn><p className="text-[12.5px] leading-snug text-mute">{t('plPauseNote')}</p></>}
        {a.state === 'PAUSED' && <Btn kind="soft" full busy={busy === 'resume'} onClick={() => void act('resume', 'resume')} data-testid="pl-resume">{t('plResume')}</Btn>}
      </div>
      {(a.state === 'LIVE' || a.state === 'PAUSED') && <div className="mt-4 space-y-2.5 border-t border-line pt-4"><Btn kind="danger" full onClick={() => setStop(true)} data-testid="pl-stop"><Icon n="stop" className="h-4 w-4" />{t('plStop')}</Btn><p className="text-[12.5px] leading-snug text-mute">{t('plStopNote')}</p></div>}
      <div className="mt-3"><Notice tone="warn"><div data-testid="pl-manual-warn">{t('plManualWarn')}</div></Notice></div>
    </div></Card>}
    {stop && <StopSheet a={a} id={id} onClose={() => setStop(false)} />}
  </>;
}

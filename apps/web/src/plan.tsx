/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/plan.tsx
 * Module           : web
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

// Any-to-any plans (V7): candidate plans for a cross-network pair, the start sheet, and the progress view that drives one
// passkey approval per leg. Shared by Swap (plan cards), Activity (open and recent plans) and the /plan/<id> page.
// A plan never approves anything: every leg is an ordinary proposal reviewed and approved here, when its turn comes.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post } from './api';
import { proposalApplied } from './approval';
import { ApprovalOutcomePanel, useApprovalOutcome } from './approvalUi';
import { errText, useT, type Key } from './i18n';
import { AssetIcon, Btn, Card, ErrorState, Fact, Field, Icon, inputCls, Notice, PageTitle, ProgressRing, ProviderIcon, Section, Sheet, Stat, StatePill, StatGrid, Tag, Timeline, trimAmt, type StepState, type Tone } from './ui';
import { amountInputText, amountLocale, amountOf, formatAmount, sanitizeAmountText } from './amount'; // v8 hardening: one rule for typed amounts
import { AmountProblem } from './amountUi';
import { LongFact } from './bridge';
import { ExecutionTimeline, type ExecutionV } from './execution'; // v11: the unified status of the leg's proposal
import { pauseText, svText } from './sv';                          // v11: server texts by code

interface AssetV { key: string; network: string; networkName: string; asset: string; symbol: string; decimals: number }
interface FeeV { kind: string; symbol: string; network: string; networkName: string; display: string; usd: number | null; includedInOutput: boolean; estimated: boolean }
interface IssueV { code: string; blocking: boolean; leg: number | null; network: string; networkName: string; symbol: string; needDisplay: string; haveDisplay: string }
export interface PlanQ {
  id: string; executable: boolean; approvals: number; seconds: number | null; extraFeesUsd: number | null; from: AssetV; to: AssetV; amountInDisplay: string;
  expectedOut: string; worstOut: string; expectedOutDisplay: string; worstOutDisplay: string; expectedUsd: number | null; worstUsd: number | null;
  legs: { kind: 'swap' | 'bridge' | 'xswap'; via: string; label: string; speed: 'standard' | 'fast' | null; from: AssetV; to: AssetV; expectedInDisplay: string; worstInDisplay: string; expectedOutDisplay: string; worstOutDisplay: string; seconds: number | null; fees: FeeV[] }[];
  requirements: { gas: { network: string; networkName: string; symbol: string; needDisplay: string; haveDisplay: string | null; ok: boolean }[]; limits: { leg: number; networkName: string; symbol: string; needDisplay: string; perTransferDisplay: string; leftTodayDisplay: string; ok: boolean }[] };
  issues: IssueV[];
}
interface QuoteR { plans: PlanQ[]; notExecutable: { code: string; network?: string } | null; skipped: { id: string; leg: number; code: string; message: string }[] }
export interface PlanV {
  id: string; state: 'active' | 'paused' | 'done' | 'stopped'; next: 'prepare' | 'approve' | 'wait' | 'paused' | 'done' | 'stopped'; current: number; steps: number; replans: number; createdAt: string;
  from: AssetV; to: AssetV; amountInDisplay: string; floorDisplay: string | null; holding: AssetV & { amountDisplay: string }; pause: { code: string; message: string; leg: number; params?: Record<string, string | number> | null; reason?: { code: string; params?: Record<string, string | number> | null } | null } | null;
  estimate: { expectedOutDisplay: string; worstOutDisplay: string } | null; plannedExpectedDisplay: string; plannedWorstDisplay: string; receivedDisplay: string | null;
  legs: { index: number; state: 'pending' | 'ready' | 'proposed' | 'in_flight' | 'settled'; kind: string; label: string; speed: string | null; from: AssetV; to: AssetV; seconds: number | null;
    planned: { expectedInDisplay: string; expectedOutDisplay: string; worstOutDisplay: string }; actual: { inDisplay: string | null; outDisplay: string | null }; attempts: { outcome: string | null; error: string | null; errorCode?: string | null; errorParams?: Record<string, string | number> | null }[]; proposalId?: string | null; execution?: ExecutionV }[];
  proposal: any | null;
}
type T = (k: Key, v?: Record<string, string | number>) => string;
const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
/** in-app navigation without a prop: the shell listens to popstate */
export const goPath = (path: string) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); };
const kindKey = (k: string): Key => (k === 'bridge' ? 'pnKindBridge' : k === 'xswap' ? 'pnKindXswap' : 'pnKindSwap');

function Pair({ a, b }: { a: AssetV; b: AssetV }) {
  const chip = (x: AssetV) => <span className="inline-flex items-center gap-1.5 text-[0.84375rem] font-medium text-ink"><AssetIcon sym={x.symbol} net={x.network} size={22} />{x.symbol}<span className="font-normal text-mute">· {x.networkName}</span></span>;
  return <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{chip(a)}<span className="inline-flex items-center gap-2"><Icon n="chev" className="h-3 w-3 text-mute" />{chip(b)}</span></span>;
}
const issueText = (t: T, i: IssueV) => t(`pnIssue_${i.code}` as Key, { step: (i.leg ?? 0) + 1, need: trimAmt(i.needDisplay, 8), have: trimAmt(i.haveDisplay, 8), sym: i.symbol, net: i.networkName });
/** The providers of a plan's legs, as overlapping logos. */
function Vias({ vias, size = 34 }: { vias: string[]; size?: number }) {
  return <span className="flex shrink-0 items-center">{vias.map((v, k) => <ProviderIcon key={v + k} provider={v} size={size} className={k ? '-ml-2.5 ring-2 ring-surface' : ''} />)}</span>;
}
/** Skeleton of a plan card: same blocks as the final card (logos, title, the figure, two lines). */
function PlanSkeleton() {
  return <div className="card p-4" aria-hidden="true"><div className="flex items-center gap-3"><div className="skel h-[34px] w-[52px] !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-3.5 w-40 !rounded-md" /><div className="skel h-3 w-24 !rounded-md" /></div></div>
    <div className="skel mt-4 h-7 w-44 !rounded-lg" /><div className="skel mt-2.5 h-3 w-32 !rounded-md" /><div className="skel mt-3 h-10 !rounded-2xl" /></div>;
}

/** Candidate plans for a cross-network pair. Single-leg operations keep their existing screens; this shows the multi-leg plans. */
export function PlanCards({ from, to, amount, slip, routes, money, pname, onCount }: { from: { key: string; network: string; symbol: string }; to: { key: string; network: string; symbol: string }; amount: string; slip: number;
  routes: { id: string; executable: boolean; providers: string[]; amountOutDisplay: string; minAmountOutDisplay: string }[]; money: (usd: number | null) => string | null; pname: (id: string) => string; onCount?: (n: number) => void }) {
  const t = useT(); const qc = useQueryClient();
  const ok = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  const [deb, setDeb] = useState(amount);
  useEffect(() => { const h = setTimeout(() => setDeb(amount), 600); return () => clearTimeout(h); }, [amount]);
  const q = useQuery({ queryKey: ['plan-quote', from.key, to.key, deb, slip], enabled: ok && deb === amount, staleTime: 20_000, retry: false, queryFn: () => post<QuoteR>('/plans/quote', { from: from.key, to: to.key, amount: deb, slippageBps: slip }) });
  const openQ = useQuery({ queryKey: ['plans-open'], queryFn: () => get<{ plans: PlanV[] }>('/plans?open=1'), refetchInterval: 15_000 });
  const [start, setStart] = useState<PlanQ | null>(null), [show, setShow] = useState<string | null>(null), [open, setOpen] = useState('');
  const plans = (q.data?.plans ?? []).filter((p) => p.legs.length > 1);
  useEffect(() => { onCount?.(ok ? plans.filter((p) => p.executable).length : 0); }, [plans.length, q.dataUpdatedAt, ok]);
  const running = openQ.data?.plans[0];
  // a quote the wallet cannot execute is never hidden, even when it guarantees more than the best plan: it is said, and labelled
  const best = plans.find((p) => p.executable) ?? plans[0];
  const better = best ? routes.filter((r) => !r.executable && !r.providers.every((x) => ['cctp', 'kyberswap', 'jupiter', 'thorchain'].includes(x)) && Number(r.minAmountOutDisplay) > Number(best.worstOutDisplay)).sort((a, b) => Number(b.minAmountOutDisplay) - Number(a.minAmountOutDisplay))[0] : undefined;
  return (
    <div className="space-y-3" data-testid="plan-cards">
      {running && <div className="card flex flex-wrap items-center gap-3 p-4" role="note">
        <span className="sw-ring"><ProgressRing done={running.legs.filter((l) => l.state === 'settled').length} total={running.steps} size={44} /></span>
        <span className="min-w-[12ch] flex-1 text-[0.875rem] font-medium leading-snug">{t('pnOpenBanner', { from: running.from.symbol, to: running.to.symbol, k: Math.min(running.current + 1, running.steps), n: running.steps })}</span>
        <Btn kind="soft" className="!min-h-11" onClick={() => setShow(running.id)}>{t('pnResume')}</Btn></div>}
      {ok && (q.isLoading || deb !== amount) && <div className="space-y-3" role="status" aria-label={t('pnSearching')}><p className="flex items-center gap-2 px-1 text-[0.8125rem] text-mute"><Icon n="spin" className="h-4 w-4 shrink-0" />{t('pnSearching')}</p><PlanSkeleton /><PlanSkeleton /></div>}
      {q.error ? <Notice tone="danger">{errText(t, q.error)}</Notice> : null}
      {ok && q.data?.notExecutable && <Notice tone="warn"><span data-testid="plan-not-executable"><b>{t('pnNotExecTitle')}</b> {t(`pnNo_${q.data.notExecutable.code}` as Key, { net: q.data.notExecutable.network ?? '' })}</span></Notice>}
      {ok && q.data && !q.data.notExecutable && plans.length === 0 && q.data.plans.length === 0 && q.data.skipped.length > 0 && <Notice tone="warn">{t('pnNoQuote')} {svText(t, q.data.skipped[0]!.code, null, q.data.skipped[0]!.message)}</Notice>}
      {ok && plans.length > 0 && <Section title={t('pnTitle')}>
        <div className="space-y-3">
        <p className="px-1 text-[0.8125rem] text-mute">{t('pnIntro')}</p>
        {plans.map((p, k) => { const isOpen = open === p.id || (open === '' && k === 0); const blocking = p.issues.filter((i) => i.blocking), warns = p.issues.filter((i) => !i.blocking && i.code === 'limit_margin');
          const simple = p.legs.length === 2 && p.legs[0]!.kind === 'bridge' && p.legs[1]!.kind === 'swap';
          return (
          <section key={p.id} data-testid="plan-card" data-executable={p.executable} className={`card overflow-hidden ${k === 0 && p.executable ? 'sw-chosen' : ''}`}>
            <button className="row-press w-full p-4 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '-' : p.id)}>
              <div className="flex items-center gap-3">
                <Vias vias={p.legs.map((l) => l.via)} />
                <div className="min-w-0 flex-1"><div className="text-[0.9375rem] font-semibold leading-tight">{simple ? t('pnSimple') : p.legs.map((l) => t(kindKey(l.kind))).join(' → ')}</div>
                  <div className="mt-0.5 text-[0.8125rem] text-mute">{t('pnApprovals', { n: p.approvals })} · <Icon n="clock" className="mr-0.5 inline h-3.5 w-3.5 align-[-2px]" />{dur(p.seconds)}</div></div>
                <Icon n="chev" className={`h-4 w-4 shrink-0 text-mute transition-transform ${isOpen ? '-rotate-90' : 'rotate-90'}`} />
              </div>
              {((k === 0 && p.executable) || !p.executable) && <div className="mt-3 flex flex-wrap gap-1.5">
                {k === 0 && p.executable && <span className="tag bg-primary text-onprimary"><Icon n="star" className="h-3 w-3" />{t('pnBest')}</span>}
                {!p.executable && <Tag tone="warn" icon="warn">{t('pnBlocked')}</Tag>}</div>}
              <div className="t-num mt-3 break-words text-[1.75rem]">{trimAmt(p.expectedOutDisplay, 8)} <span className="text-mute">{p.to.symbol}</span></div>
              <div className="mt-1 text-[0.8125rem] text-mute">{t('pnExpected')}{p.expectedUsd != null ? ` · ≈ ${money(p.expectedUsd)}` : ''}</div>
              <div className="mt-2.5 flex gap-2 rounded-2xl bg-elev/60 px-3 py-2.5 text-[0.84375rem] leading-snug"><Icon n="shield" className="mt-0.5 h-4 w-4 shrink-0 text-emerald" /><span className="min-w-0"><span className="font-semibold">{trimAmt(p.worstOutDisplay, 8)} {p.to.symbol}</span> <span className="text-mute">{t('pnWorst')}</span></span></div>
            </button>
            {isOpen && <div className="space-y-4 border-t border-line p-4 text-[0.84375rem]">
              <ol className="tl" aria-label={t('pnSteps')}>{p.legs.map((l, i) => <li key={i} className="tl-item">
                <span className="tl-node" aria-hidden="true"><ProviderIcon provider={l.via} size={26} /></span>
                <div className="tl-body"><div className="text-[0.9375rem] font-semibold leading-snug">{i + 1}. {t(kindKey(l.kind))} <span className="font-normal text-mute">· {l.label}{l.speed ? ` · ${t(l.speed === 'fast' ? 'pnFast' : 'pnStandard')}` : ''}</span></div>
                  <div className="mt-1.5 space-y-1.5 leading-snug">
                    <Pair a={l.from} b={l.to} />
                    <div className="text-mute">{trimAmt(l.expectedInDisplay, 8)} {l.from.symbol} → <span className="font-medium text-ink">{trimAmt(l.expectedOutDisplay, 8)} {l.to.symbol}</span> · {t('pnWorstShort')} {trimAmt(l.worstOutDisplay, 8)}</div>
                    <div className="text-[0.8125rem] text-mute">{dur(l.seconds)} · {l.fees.length === 0 ? t('pnNoFee') : l.fees.map((f) => `${t(`pnFee_${f.kind}` as Key)} ${trimAmt(f.display, 8)} ${f.symbol}${f.network !== l.from.network || f.kind === 'network' ? ` (${f.networkName})` : ''}${f.includedInOutput ? ` ${t('pnInOutput')}` : ''}`).join(' · ')}</div>
                  </div></div></li>)}</ol>
              <StatGrid><Stat label={t('pnTotalTime')} value={dur(p.seconds)} /><Stat label={t('pnTotalFees')} value={p.extraFeesUsd === null ? '—' : money(p.extraFeesUsd) ?? `${p.extraFeesUsd.toFixed(2)} USD`} /></StatGrid>
              <div><div className="t-eyebrow mb-2">{t('pnRequired')}</div>
                <ul className="space-y-2">
                  {p.requirements.gas.map((g) => <li key={g.network} className="flex gap-2.5" data-testid="plan-gas" data-ok={g.ok}><Icon n={g.ok ? 'check' : 'warn'} className={`mt-0.5 h-4 w-4 shrink-0 ${g.ok ? 'text-emerald' : 'text-danger'}`} />
                    <span className="min-w-0">{t('pnGasLine', { sym: g.symbol, net: g.networkName, need: trimAmt(g.needDisplay, 6), have: g.haveDisplay === null ? '?' : trimAmt(g.haveDisplay, 6) })}
                      {!g.ok && <> <span className="text-mute">{t('pnGasHelp', { sym: g.symbol, net: g.networkName })}</span> <button className="block min-h-11 text-left font-semibold text-blue underline" onClick={() => goPath(`/receive?n=${g.network}`)}>{t('pnGasReceive', { sym: g.symbol, net: g.networkName })}</button></>}</span></li>)}
                  {p.requirements.limits.map((l) => <li key={l.leg} className="flex gap-2.5"><Icon n={l.ok ? 'check' : 'warn'} className={`mt-0.5 h-4 w-4 shrink-0 ${l.ok ? 'text-emerald' : 'text-danger'}`} />
                    <span className="min-w-0">{t('pnLimitLine', { step: l.leg + 1, need: trimAmt(l.needDisplay, 6), sym: l.symbol, net: l.networkName, per: trimAmt(l.perTransferDisplay, 6), left: trimAmt(l.leftTodayDisplay, 6) })}</span></li>)}
                </ul></div>
              {blocking.length > 0 && <Notice tone="warn"><ul className="space-y-1" data-testid="plan-issues">{blocking.map((i, n) => <li key={n}>{issueText(t, i)}</li>)}</ul></Notice>}
              {warns.length > 0 && <p className="text-[0.8125rem] text-mute">{warns.map((i) => issueText(t, i)).join(' ')}</p>}
              <Btn full disabled={!p.executable || !!running} onClick={() => setStart(p)}><Icon n="swap" className="h-4 w-4" />{t('pnStart', { n: p.approvals })}</Btn>
              {!!running && <p className="text-[0.8125rem] text-mute">{t('pnOneAtATime')}</p>}
            </div>}
          </section>); })}
        {better && <Notice tone="info"><span data-testid="plan-comparison">{t('pnComparison', { via: better.providers.map(pname).join(' → '), min: trimAmt(better.minAmountOutDisplay, 8), sym: to.symbol })}</span></Notice>}
        </div>
      </Section>}
      {start && <StartSheet plan={start} slip={slip} amount={deb} onClose={() => setStart(null)} onStarted={(id) => { setStart(null); void qc.invalidateQueries({ queryKey: ['plans-open'] }); setShow(id); }} />}
      {show && <PlanSheet id={show} onClose={() => { setShow(null); void qc.invalidateQueries({ queryKey: ['plans-open'] }); }} />}
    </div>);
}

/** Start confirmation: nothing is signed here. It closes only through its own buttons, and not while the request is in flight. */
function StartSheet({ plan: p, slip, amount, onClose, onStarted }: { plan: PlanQ; slip: number; amount: string; onClose: () => void; onStarted: (id: string) => void }) {
  const t = useT(); const [floor, setFloor] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const floorC = amountOf(floor, amountLocale()), floorBad = floor.trim() !== '' && floorC === null;   // v8: the floor as typed → canonical; unreadable = no start
  const go = async () => { setBusy(true); setErr('');
    try { const r = await post<PlanV>('/plans', { from: p.from.key, to: p.to.key, amount, slippageBps: slip, plan: p.id, ...(floorC ? { floor: floorC } : {}) }); onStarted(r.id); }
    catch (e) { setErr(errText(t, e)); } finally { setBusy(false); } };
  return (
    <Sheet title={t('pnStartTitle')} onClose={onClose} dismissable={false} busy={busy} testid="plan-start" wide>
      <div className="rounded-[20px] bg-elev/60 p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-mute"><Vias vias={p.legs.map((l) => l.via)} size={24} /><span className="min-w-0">{trimAmt(p.amountInDisplay, 8)} {p.from.symbol} · {p.from.networkName} → {p.to.networkName}</span></div>
        <div className="mt-3 flex items-start gap-3.5"><AssetIcon sym={p.to.symbol} net={p.to.network} size={44} ring="var(--elev)" />
          <div className="min-w-0"><div className="t-display break-words text-[clamp(1.5625rem,7.6vw,2rem)] !leading-[1.12]">{trimAmt(p.expectedOutDisplay, 8)} <span className="text-mute">{p.to.symbol}</span></div>
            <div className="mt-1 text-[0.8125rem] text-mute">{t('pnExpected')} · {t('pnWorstShort')} {trimAmt(p.worstOutDisplay, 8)} {p.to.symbol}</div></div></div>
      </div>
      <div className="mt-3 space-y-3 text-[0.84375rem]">
        <Notice tone="info">{t('pnGuarantee', { n: p.approvals })}</Notice>
        <Notice tone="ok">{t('pnBetween')}</Notice>
        <div><Field label={t('pnFloorLabel', { sym: p.to.symbol })}>
          <input className={inputCls} inputMode="decimal" placeholder={t('pnFloorNone')} aria-label={t('pnFloorLabel', { sym: p.to.symbol })} value={floor} onChange={(e) => setFloor(sanitizeAmountText(e.target.value))} autoComplete="off" />
          <AmountProblem text={floor} />
          <span className="mt-1.5 block text-[0.78125rem] text-mute">{t('pnFloorHint', { worst: trimAmt(p.worstOutDisplay, 8), sym: p.to.symbol })}</span></Field>
          <button type="button" className="press inline-flex min-h-11 items-center gap-1.5 text-[0.84375rem] font-semibold text-blue" onClick={() => setFloor(amountInputText(formatAmount(p.worstOutDisplay, 'en', { maxDecimals: 8, group: false }), amountLocale()))}><Icon n="lock" className="h-4 w-4" />{t('pnFloorUseWorst')}</button></div>
        {err && <Notice tone="danger">{err}</Notice>}
      </div>
      <div className="mt-4 space-y-2.5">
        <Btn full busy={busy} disabled={floorBad} onClick={() => void go()}>{t('pnStartConfirm')}</Btn>
        <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Btn>
      </div>
    </Sheet>);
}

const PLAN_TONE: Record<PlanV['state'], [Tone, string]> = { active: ['info', 'clock'], paused: ['warn', 'warn'], done: ['ok', 'check'], stopped: ['mute', 'stop'] };
function PlanPill({ p }: { p: PlanV }) {
  const t = useT(); const [tone, ic] = PLAN_TONE[p.state];
  return <span data-testid="plan-state" data-state={p.state} className="tag shrink-0" data-tone={tone}><Icon n={ic} className="h-3 w-3" />{t(`pnState_${p.state}` as Key)}</span>;
}
const settledCount = (p: PlanV) => p.legs.filter((l) => l.state === 'settled').length;
/** the provider of a leg of a running plan (the server names it in `label`; the kind decides for transfers and native swaps) */
const legVia = (l: { kind: string; label: string }) => (l.kind === 'bridge' ? 'cctp' : l.kind === 'xswap' ? 'thorchain' : /jupiter/i.test(l.label) ? 'jupiter' : /kyber/i.test(l.label) ? 'kyberswap' : l.label);

/** The plan's progress: timeline (planned vs actual), where the funds are, and the one action available now. */
export function PlanBody({ id, onGone }: { id: string; onGone?: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plan', id], queryFn: () => get<PlanV>(`/plans/${id}`), refetchInterval: (x) => (x.state.data && ['done', 'stopped'].includes(x.state.data.state) ? false : 3000), retry: false });
  const [prep, setPrep] = useState<{ proposal: any; options: any } | null>(null), [busy, setBusy] = useState(''), [err, setErr] = useState(''), [left, setLeft] = useState(0), [floor, setFloor] = useState('');
  const p = q.data; const ap = useApprovalOutcome<{ state: string }>();
  const mine = prep && p?.proposal?.id === prep.proposal.id && p?.proposal?.state === 'pending_approval' ? prep : null;   // the challenge held here matches the step awaiting approval
  useEffect(() => { if (!mine) return; const tick = () => setLeft(Math.max(0, Math.round((new Date(mine.proposal.expiresAt).getTime() - Date.now()) / 1000))); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [mine?.proposal.id]);
  useEffect(() => { if (p?.state === 'done' || p?.state === 'stopped') { void qc.invalidateQueries({ queryKey: ['portfolio'] }); void qc.invalidateQueries({ queryKey: ['activity'] }); } }, [p?.state, qc]);
  if (q.isLoading) return <div className="space-y-4" role="status" aria-label={t('pnLoading')}><div className="skel h-[132px] !rounded-[20px]" />{[0, 1].map((k) => <div key={k} className="flex gap-3.5" aria-hidden="true"><div className="skel h-9 w-9 !rounded-full" /><div className="flex-1 space-y-2 pt-1.5"><div className="skel h-3.5 w-44 !rounded-md" /><div className="skel h-3 w-56 max-w-full !rounded-md" /><div className="skel h-3 w-36 !rounded-md" /></div></div>)}</div>;
  if (q.error || !p) return <div className="space-y-3"><Notice tone="danger">{errText(t, q.error)}</Notice>{onGone ? <Btn full kind="ghost" onClick={onGone}>{t('swClose')}</Btn> : <ErrorState title={t('dzPnLoadFailed')} offline={!navigator.onLine} onRetry={() => void q.refetch()}>{t('dzPnLoadFailedBody')}</ErrorState>}</div>;
  const set = (v: PlanV) => qc.setQueryData(['plan', id], v);
  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); setErr(''); try { await fn(); } catch (e) { const m = errText(t, e); if (m) setErr(m); void q.refetch(); } finally { setBusy(''); } };
  const prepare = () => act('prepare', async () => { const r = await post<{ plan: PlanV; proposal: any | null; options: any | null }>(`/plans/${id}/prepare`, {}); set(r.plan); setPrep(r.proposal ? { proposal: r.proposal, options: r.options } : null); });
  const approve = () => act('passkey', async () => { if (!mine) return;
    const assertion = await startAuthentication({ optionsJSON: mine.options });   // the challenge is the fingerprint of this exact step
    // NEXT W1: the approval leaves the browser — a lost answer is settled by the step's proposal read from the server, never by the error
    setBusy('submit'); const pid = mine.proposal.id;
    await ap.run({ submit: () => post<{ state: string }>(`/transfers/proposals/${pid}/approve`, { assertion }), read: () => get<{ state: string }>(`/transfers/proposals/${pid}`), applied: proposalApplied }, (o) => {
      if (o.kind === 'refused') { const m = errText(t, o.error); if (m) setErr(m); }
      else if (o.kind === 'read' && !o.applied) return;   // the server still awaits the approval: the challenge held here stays
      else setPrep(null);
      void q.refetch();
    }); });
  const simple = (path: string, body: unknown = {}) => act(path, async () => { set(await post<PlanV>(`/plans/${id}/${path}`, body)); setPrep(null); });
  const cur = p.legs[p.current], pr = p.proposal, step = Math.min(p.current + 1, p.steps);
  const wait = pr?.bridge ? t(`brStage_${pr.bridge.stage}` as Key) : pr?.xswap ? t(`xsStage_${pr.xswap.stage}` as Key) : null;
  // v10 — what the next passkey approval covers, said on the current step (the step's full receipt is shown before the passkey is asked)
  const give = pr ? `${trimAmt(pr.amountDisplay, 10)} ${pr.symbol} · ${pr.networkName}` : '';
  const minOut = pr?.bridge ? `${trimAmt(pr.bridge.minReceiveDisplay, 10)} USDC · ${pr.bridge.toNetworkName}` : pr?.swap ? `${trimAmt(pr.swap.minOutDisplay, 10)} ${pr.swap.toSymbol}` : null;
  const signs = (l: PlanV['legs'][number]): string | null => (p.next === 'approve' && pr && mine
    ? (minOut ? t('dzPnSignNow', { give, min: minOut }) : t('dzPnSignNowPlain', { give }))
    : p.next === 'prepare' || p.next === 'approve'
      ? t('dzPnSignPrepare', { kind: t(kindKey(l.kind)), from: l.from.symbol, fromNet: l.from.networkName, to: l.to.symbol, toNet: l.to.networkName, amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol })
      : null);
  return (
    <div className="space-y-4" data-testid="plan-progress" data-next={p.next} data-current={p.current}>
      <div className="rounded-[20px] bg-elev/60 p-4">
        <div className="flex items-center gap-3 text-[0.8125rem] text-mute"><span className="sw-ring"><ProgressRing done={settledCount(p)} total={p.steps} size={42} /></span>
          <span className="min-w-0 flex-1 leading-snug">{trimAmt(p.amountInDisplay, 8)} {p.from.symbol} · {p.from.networkName} → {p.to.symbol} · {p.to.networkName}</span><PlanPill p={p} /></div>
        <div className="mt-3.5 flex items-center gap-3.5">
          {p.state === 'done' ? <AssetIcon sym={p.to.symbol} net={p.to.network} size={44} ring="var(--elev)" /> : <AssetIcon sym={p.holding.symbol} net={p.holding.network} size={44} ring="var(--elev)" />}
          {p.state === 'done' ? <div className="min-w-0 flex-1"><div className="text-[0.8125rem] text-mute">{t('pnReceived')}</div><div className="t-num break-words text-[1.625rem]" data-testid="plan-received">{trimAmt(p.receivedDisplay ?? '', 10)} <span className="text-mute">{p.to.symbol}</span></div></div>
            : <div className="min-w-0 flex-1"><div className="text-[0.8125rem] leading-snug text-mute">{t('pnHolding')}</div><div className="t-num mt-0.5 break-words text-[1.5rem]" data-testid="plan-holding">{trimAmt(p.holding.amountDisplay, 8)} <span className="text-mute">{p.holding.symbol} · {p.holding.networkName}</span></div></div>}
        </div>
        <div className="mt-3 border-t border-line pt-3 text-[0.8125rem] leading-snug text-mute">{p.estimate && p.state !== 'done' ? t('pnEstimateNow', { exp: trimAmt(p.estimate.expectedOutDisplay, 8), worst: trimAmt(p.estimate.worstOutDisplay, 8), sym: p.to.symbol }) : t('pnPlannedLine', { exp: trimAmt(p.plannedExpectedDisplay, 8), worst: trimAmt(p.plannedWorstDisplay, 8), sym: p.to.symbol })}</div>
        {p.floorDisplay ? <div className="mt-2 flex items-center gap-1.5 text-[0.8125rem] font-semibold" data-testid="plan-floor"><Icon n="lock" className="h-4 w-4 shrink-0 text-mute" />{t('pnFloorIs', { floor: trimAmt(p.floorDisplay, 8), sym: p.to.symbol })}</div> : null}
      </div>

      <div className="sw-tl"><Timeline label={t('pnSteps')} items={p.legs.map((l) => { const here = l.index === p.current && (p.state === 'active' || p.state === 'paused');
        const state: StepState = l.state === 'settled' ? 'done' : here ? 'current' : 'next'; const sign = here && p.state === 'active' ? signs(l) : null;
        return { key: String(l.index), state, node: <ProviderIcon provider={legVia(l)} size={26} />, stateLabel: t(`pnLeg_${l.state}` as Key),
          title: <>{l.index + 1}. {t(kindKey(l.kind))} <span className="font-normal text-mute">· {l.label}{l.speed ? ` · ${t(l.speed === 'fast' ? 'pnFast' : 'pnStandard')}` : ''}</span></>,
          children: <div className="space-y-1.5" data-testid="plan-leg" data-state={l.state}>
            <Pair a={l.from} b={l.to} />
            {l.state === 'settled'
              ? <dl className="sw-pva"><div><dt>{t('dzPnActual')}</dt><dd className="text-ink">{trimAmt(l.actual.inDisplay ?? '', 8)} {l.from.symbol} → <span className="font-semibold">{trimAmt(l.actual.outDisplay ?? '', 8)} {l.to.symbol}</span></dd></div><div><dt>{t('pnPlanned')}</dt><dd>{trimAmt(l.planned.expectedOutDisplay, 8)} {l.to.symbol}</dd></div></dl>
              : <div>{t('pnPlanned')} {trimAmt(l.planned.expectedInDisplay, 8)} {l.from.symbol} → {trimAmt(l.planned.expectedOutDisplay, 8)} {l.to.symbol} · {t('pnWorstShort')} {trimAmt(l.planned.worstOutDisplay, 8)} · {dur(l.seconds)}</div>}
            {sign && <div className="sw-sign" data-testid="plan-signs"><Icon n="key" className="mt-0.5 h-4 w-4 shrink-0 text-blue" /><span className="min-w-0">{sign}</span></div>}
            {l.attempts.filter((a) => a.outcome && a.outcome !== 'settled' && a.error).slice(-1).map((a, n) => <div key={n} className="flex gap-1.5 text-[0.8125rem]"><Icon n="warn" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" /><span className="min-w-0">{t('pnLastAttempt')} {svText(t, a.errorCode, a.errorParams, a.error)}</span></div>)}
            {/* the step in flight, transaction by transaction — the same status object as a single swap or transfer */}
            {here && l.proposalId && l.execution && l.execution.steps.some((s) => s.txid) && <ExecutionTimeline exec={l.execution} testid="plan-leg-execution" />}
          </div> }; })} /></div>

      {p.next === 'prepare' && cur && <div className="space-y-3">
        <Notice tone="info">{t('pnReadyNote', { k: step, n: p.steps, amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol })}</Notice>
        <Btn full busy={busy === 'prepare'} disabled={ap.locked} onClick={() => void prepare()} data-testid="plan-prepare"><Icon n="swap" className="h-4 w-4" />{t('pnPrepare', { k: step, n: p.steps })}</Btn></div>}

      {/* the receipt of the step the passkey signs: every field in full, nothing animated */}
      {p.next === 'approve' && pr && <div className="space-y-3" data-testid="plan-review">
        <div className="rounded-[20px] border border-line p-4">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><span className="text-[0.9375rem] font-semibold">{t('pnReview', { k: step, n: p.steps })}</span><StatePill state={pr.state} /></div>
          <dl className="receipt">
            <Fact k={t('pnYouGive')}>{trimAmt(pr.amountDisplay, 10)} {pr.symbol} · {pr.networkName}</Fact>
            {pr.bridge ? <Fact k={t('pnMinGuaranteed')}>{trimAmt(pr.bridge.minReceiveDisplay, 10)} USDC · {pr.bridge.toNetworkName}</Fact>
              : pr.swap ? <><Fact k={t('pnMinGuaranteed')}><span data-testid="plan-minout">{trimAmt(pr.swap.minOutDisplay, 10)} {pr.swap.toSymbol}</span></Fact>
                <Fact k={t('pnExpectedShort')}>{trimAmt(pr.swap.expectedOutDisplay, 10)} {pr.swap.toSymbol}</Fact></> : null}
            <Fact k={t('feeMax')}>{pr.maxFeeDisplay ? `${trimAmt(pr.maxFeeDisplay, 9)} ${pr.feeSymbol}` : '—'}</Fact>
            {pr.intentHash && <LongFact k={t('fingerprint')} mute>{pr.intentHash}</LongFact>}
          </dl>
        </div>
        {mine ? <><Notice tone="ok">{t('pnStepGuarantee')}</Notice>
          <Btn full busy={busy === 'passkey' || busy === 'submit'} disabled={left === 0 || ap.locked} onClick={() => void approve()} data-testid="plan-approve"><Icon n="key" />{busy === 'passkey' ? t('approving') : `${t('approve')} · ${left} s`}</Btn></>
          : <><Notice tone="info">{t('pnReprepare')}</Notice><Btn full busy={busy === 'prepare'} disabled={ap.locked} onClick={() => void prepare()} data-testid="plan-prepare"><Icon n="swap" className="h-4 w-4" />{t('pnPrepare', { k: step, n: p.steps })}</Btn></>}
      </div>}

      {p.next === 'wait' && <div className="flex items-start gap-3 rounded-[20px] bg-elev/60 p-4 text-[0.84375rem] leading-snug text-mute" data-testid="plan-wait"><Icon n="spin" className="mt-0.5 h-4 w-4 shrink-0 text-blue" /><span className="min-w-0">{t('pnWaiting', { k: step, n: p.steps })}{wait ? ` — ${wait}` : pr ? ` — ${t(`s_${pr.state}` as Key)}` : ''}. {t('pnWaitingNote')}</span></div>}

      {p.state === 'paused' && p.pause && <div className="space-y-3" data-testid="plan-paused" data-code={p.pause.code}>
        <Notice tone="warn"><b>{t(`pnPause_${['floor', 'refused', 'refunded', 'no_funds'].includes(p.pause.code) ? p.pause.code : 'other'}` as Key, { k: p.pause.leg + 1 })}</b> <span data-testid="plan-pause-text">{pauseText(t, p.pause)}</span> {t('pnPausedFunds', { amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol, net: p.holding.networkName })}</Notice>
        {p.pause.code === 'floor' && <Field label={t('pnFloorChange', { sym: p.to.symbol })}>
          <input className={inputCls} inputMode="decimal" placeholder={amountInputText(p.floorDisplay ?? '', amountLocale())} aria-label={t('pnFloorChange', { sym: p.to.symbol })} value={floor} onChange={(e) => setFloor(sanitizeAmountText(e.target.value))} autoComplete="off" /><AmountProblem text={floor} /></Field>}
        <Btn full busy={busy === 'retry'} disabled={!!busy || (p.pause.code === 'floor' && floor.trim() !== '' && amountOf(floor, amountLocale()) === null)} onClick={() => { const f = amountOf(floor, amountLocale()); void simple('retry', p.pause?.code === 'floor' && f !== null ? { floor: /[1-9]/.test(f) ? f : null } : {}); }} data-testid="plan-retry"><Icon n="refresh" className="h-4 w-4" />{t('pnRetry')}</Btn>
        <Btn full kind="soft" busy={busy === 'replan'} disabled={!!busy} onClick={() => void simple('replan')} data-testid="plan-replan">{t('pnReplan', { sym: p.holding.symbol, net: p.holding.networkName })}</Btn>
        <Btn full kind="ghost" busy={busy === 'stop'} disabled={!!busy || ap.locked} onClick={() => void simple('stop')} data-testid="plan-stop">{t('pnStop')}</Btn>
      </div>}

      {p.state === 'done' && <Notice tone="ok">{t('pnDone', { n: p.steps })}</Notice>}
      {p.state === 'stopped' && <Notice tone="info">{t('pnStopped', { amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol, net: p.holding.networkName })}</Notice>}
      {err && !ap.locked && <Notice tone="danger">{err}</Notice>}
      <ApprovalOutcomePanel ap={ap} />
      {p.state === 'active' && p.next !== 'wait' && <button className="press min-h-11 w-full text-center text-[0.84375rem] font-medium text-mute underline disabled:opacity-45" disabled={!!busy || ap.locked} onClick={() => void simple('stop')} data-testid="plan-stop-link">{t('pnStopHere')}</button>}
      {(p.state === 'active' || p.state === 'paused') && <p className="text-[0.78125rem] text-mute">{t('pnResumable')}</p>}
    </div>);
}

/** The progress view as a sheet. A step is approved from here, so it closes only through its own « Fermer » button (the plan stays resumable). */
export function PlanSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  return <Sheet title={t('pnProgress')} onClose={onClose} dismissable={false} wide footer={<Btn full kind="ghost" onClick={onClose}>{t('swClose')}</Btn>}><PlanBody id={id} onGone={onClose} /></Sheet>;
}

/** /plan/<id>: the progress view as a page (opened from an alert or a notification). */
export function PlanScreen({ id }: { id: string }) {
  const t = useT();
  return <div className="space-y-4"><PageTitle onBack={() => goPath('/activity')} backLabel={t('activity')}>{t('pnProgress')}</PageTitle><Card><PlanBody id={id} /></Card></div>;
}

/** Activity: plans in progress first, then the recent ones. Tapping one opens its progress view (and resumes it). */
export function PlanList() {
  const t = useT(); const [show, setShow] = useState<string | null>(null); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => get<{ plans: PlanV[] }>('/plans?limit=5'), refetchInterval: 20_000 });
  const plans = q.data?.plans ?? [];
  if (plans.length === 0) return null;
  return (<>
    <Section title={t('pnListTitle')}><Card className="!p-0 overflow-hidden">
      <ul className="divide-y divide-line" data-testid="plan-list">{plans.map((p) => { const needs = p.next === 'prepare' || p.next === 'approve'; return <li key={p.id}>
        <button className="row-press flex min-h-[68px] w-full items-center gap-3.5 px-4 py-3 text-left" onClick={() => setShow(p.id)}>
          <span className="flex shrink-0 items-center gap-1" aria-hidden="true"><AssetIcon sym={p.from.symbol} net={p.from.network} size={32} /><Icon n="chev" className="h-3 w-3 text-mute" /><AssetIcon sym={p.to.symbol} net={p.to.network} size={32} /></span>
          <span className="min-w-0 flex-1"><span className="block text-[0.9375rem] font-semibold leading-snug">{p.from.symbol} ({p.from.networkName}) → {p.to.symbol} ({p.to.networkName})</span>
            <span className="mt-0.5 block text-[0.8125rem] leading-snug text-mute">{t('pnStepOf', { k: Math.min(p.current + 1, p.steps), n: p.steps })} · {trimAmt(p.amountInDisplay, 6)} {p.from.symbol}</span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5"><PlanPill p={p} />{needs && <Tag tone="warn" icon="key">{t('pnNeedsYou')}</Tag>}</span></span>
          <Icon n="chev" className="h-4 w-4 shrink-0 text-mute" /></button></li>; })}</ul></Card></Section>
    {show && <PlanSheet id={show} onClose={() => { setShow(null); void qc.invalidateQueries({ queryKey: ['plans'] }); }} />}
  </>);
}

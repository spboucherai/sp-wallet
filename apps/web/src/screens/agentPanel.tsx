/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/screens/agentPanel.tsx
 * Module           : screens
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// V11 — the Agents panel: one page for ANY agent (spot, perp, stream, supervisor) and the creation flow from the seven templates.
//
// Rules this file keeps (apps/web/test/agents-v11.test.ts):
//   - ONE MODE PER REQUEST AND PER VIEW. Performance, orders, signals, journal and timeline are fetched with exactly one `mode=`;
//     paper and live are two tabs, each with its own curve and its own figures — never one chart, never one sum.
//   - a BACKTEST is labelled backtest wherever it shows, and is never in the performance tabs. The laboratory's out-of-sample
//     results on the template cards and the version-3 sections of a report (labReport.tsx) are backtests and carry that label.
//   - a template whose strategy is not installed cannot be created; a family that cannot go live says why, in the server's words.
//   - nothing here approves a mandate: "request live" shows the draft and hands over to the approval surface.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, EmptyState, ErrorState, Fact, Field, fiat, Fold, Icon, inputCls, Notice, numFmt, PageTitle, Section, Seg, Sheet, SkeletonCard, SkeletonRows, Stat, StatGrid, Tag, Timeline, usdCapital, when, type StepState, type Tone } from '../ui';
import { srvText } from '../srvText'; // v11 interface (audit B3): a server sentence without a code is translated when known, quoted as English otherwise
import { CardHead, EquityCard, FormGroup, LogoStack, UnitInput } from './agentBits';
import { venueShown } from '../venues';
import { LabVerdicts, ReportV3, type LabVerdict, type ReportSummary } from './labReport';
// V11 market making: the session view, the go-live checklist and the quoting mandate — a chunk of its own, loaded for a market-making agent only
const MmSection = lazy(() => import('./mmPanel').then((m) => ({ default: m.MmSection })));

// ------------------------------------------------------------------------------------------------------------------ types (the server's shapes)
export type Mode = 'research' | 'paper' | 'live';
export type Life = 'active' | 'paused' | 'stopped';
export interface Num { value: number | null; reason: string | null }
export interface Perf { mode: Mode; label: string; points: number; from: number | null; to: number | null; equityCurve: { ts: number; equity: number }[];
  totalReturn: Num; volatility: Num; sharpe: Num; sortino: Num; maxDrawdown: Num; winRate: Num; profitFactor: Num; turnover: Num; feesUsd: Num; fundingUsd: Num; slippageUsd: Num; netPnlUsd: Num;
  closedTrades: number; orders: number; warnings: { code: string; message: string }[] }
export interface Installed { path: string; name: string; version: string; sha256: string; universe: string[]; interval: string; liveCapable: boolean; liveReason: string | null;
  /** universe ['*']: the instruments are the agent's, between minSymbols and maxSymbols of them; live only if they are all pinned (liveCondition) */
  generic?: boolean; minSymbols?: number; maxSymbols?: number; defaultUniverse?: string[] | null; liveCondition?: string | null }
export interface Template { id: string; family: string; engine: 'bar' | 'stream' | 'supervisor'; kind: string; name: { fr: string; en: string }; summary: { fr: string; en: string }; modes: Mode[]; liveReason: string | null;
  strategyNames: string[]; installed: Installed[]; strategyInstalled: boolean; rule: { name: string; version: string; sha256: string } | null; labBacktest: { wanted: string[]; installed: string[]; agentRunnable?: false };
  /** model studies / policies of the laboratory behind the family, and the laboratory's results (BACKTEST, out of sample) for the template */
  labStudies?: { name: string; kind: 'study' | 'policy'; installed: boolean }[]; labVerdicts?: LabVerdict[];
  defaults: { universe: string[]; venues: string[]; interval: string; capitalUsdc: string; config: Record<string, unknown>; risk: Record<string, number | string | boolean> } }
export interface TimelineItem { ts: number; type: string; severity: string; code: string | null; title: string; body: string; configVersion: number | null }
export interface Overview { id: string; name: string; kind: string; family: string; template: string | null; engine: string; state: Life; phase: string; mode: Mode; venue: string; universe: string[]; interval: string; capitalUsd: string;
  riskLimits: Record<string, number | string | boolean>; configVersion: number; strategy: { name: string; version: string; sha256: string; status: string; kind: string } | null; mandate: { kind: string; id: string } | null; pausedFrom: string | null;
  live: { capable: boolean; code: string | null; reason: string | null }; stopReason: string | null; familyModes: { modes: Mode[]; liveReason: string | null };
  backtests: { label: string; note: string; versions: { id: string; name: string; version: string; sha256: string; status: string; approvedBy: string | null; hasReport: boolean; notes: string; checks: Record<string, unknown> | null; metrics: Record<string, Record<string, unknown>> | null }[];
    recorded: null | { kind: string; label: string; instruments: string[]; from: number | null; to: number | null; snapshots: number; expected: number; missing: number; gaps: number; decisions: number; actions: number; fills: number; model: string[]; warnings: string[]; performance: Perf } };
  runtime: null | { venues: string[]; rule: string | null; config: Record<string, unknown>; counters: { decisions: number; acted: number; skippedStale: number; skippedGap: number; fills: number } | null; hold: { code: string; since: number } | null;
    lastPass: { ts: number; findings: number } | null; book: null | { simulated: boolean; positions: Record<string, { size: number; avgPrice: number }>; quotes: { id: string; side: string; price: number; size: number; instrument: string }[]; pair: { longInstrument: string; shortInstrument: string; sizeBase: number } | null; realizedPnl: number; fees: number; funding: number } };
  worker: { lease: { owner: string; active: boolean } | null; tick: { state: string; last_error: string | null } | null };
  jobs: { id: string; kind: string; status: string; error: string | null }[]; killSwitch: { engaged: boolean; reason: string | null; at: number | null; by: string | null } }
export interface Draft { draft: string; available: boolean; kind?: string; reason: string | null; fields: Record<string, unknown> | null; approval: { route: string; note: string }; existingFlow?: string;
  /** V11.2 perp: a trading mandate already created for the agent (approve it in Risk), or how to create it from this draft */
  pending?: { mandateId: string; state: string } | null; create?: { path: string; body: Record<string, unknown> } | null }

// ------------------------------------------------------------------------------------------------------------------ pure helpers (tested)
/** every mode-scoped read names exactly ONE mode */
export const scopedUrl = (id: string, what: 'performance' | 'orders' | 'signals' | 'journal' | 'timeline', mode: Mode, limit?: number): string => `/agents/${id}/${what}?mode=${mode}${limit ? `&limit=${limit}` : ''}`;
export const LIFE_TAG: Record<Life, { tone: Tone; icon: string; key: Key }> = { active: { tone: 'ok', icon: 'check', key: 'ag2LifeActive' }, paused: { tone: 'warn', icon: 'clock', key: 'ag2LifePaused' }, stopped: { tone: 'mute', icon: 'stop', key: 'ag2LifeStopped' } };
/** three modes, three distinct tones: research is neutral, paper is informational, live is the only one that moves money */
export const MODE_TAG: Record<Mode, { tone: Tone; icon: string; key: Key }> = { research: { tone: 'mute', icon: 'search', key: 'ag2ModeResearch' }, paper: { tone: 'info', icon: 'eye', key: 'ag2ModePaper' }, live: { tone: 'danger', icon: 'bolt', key: 'ag2ModeLive' } };
export const PERF_TAB: Record<'paper' | 'live', Key> = { paper: 'ag2TabPaper', live: 'ag2TabLive' };
export const FAMILY_KEY = (family: string): Key => (`ag2Fam_${family}` as Key);

export type PerfUnit = 'pct' | 'num' | 'usd';
export const PERF_FIELDS: readonly { field: keyof Perf; key: Key; unit: PerfUnit }[] = [
  { field: 'netPnlUsd', key: 'ag2PfNet', unit: 'usd' }, { field: 'totalReturn', key: 'ag2PfReturn', unit: 'pct' }, { field: 'maxDrawdown', key: 'ag2PfDrawdown', unit: 'pct' }, { field: 'volatility', key: 'ag2PfVol', unit: 'pct' },
  { field: 'sharpe', key: 'ag2PfSharpe', unit: 'num' }, { field: 'sortino', key: 'ag2PfSortino', unit: 'num' }, { field: 'winRate', key: 'ag2PfWin', unit: 'pct' }, { field: 'profitFactor', key: 'ag2PfPf', unit: 'num' },
  { field: 'turnover', key: 'ag2PfTurnover', unit: 'num' }, { field: 'feesUsd', key: 'ag2PfFees', unit: 'usd' }, { field: 'fundingUsd', key: 'ag2PfFunding', unit: 'usd' }, { field: 'slippageUsd', key: 'ag2PfSlippage', unit: 'usd' }];
export interface PerfRow { key: Key; unit: PerfUnit; value: number | null; reason: string | null; mode: Mode }
/** The stat rows of ONE performance answer. Every row carries the mode of the answer it came from; a null figure keeps its reason. */
export function perfRows(p: Perf): PerfRow[] { return PERF_FIELDS.map((f) => { const n = p[f.field] as Num; return { key: f.key, unit: f.unit, value: n?.value ?? null, reason: n?.value === null || n?.value === undefined ? n?.reason ?? null : null, mode: p.mode }; }); }
export const fmtPerf = (r: Pick<PerfRow, 'unit' | 'value'>, locale: string): string => (r.value === null ? '—' : r.unit === 'pct' ? `${numFmt(r.value * 100, locale, 2)} %` : r.unit === 'usd' ? fiat(r.value, 'USD', locale) : numFmt(r.value, locale, 2));
/** a backtest never borrows the word "performance": its title and its tag are these two keys, whatever the report */
export const BACKTEST_KEYS = { title: 'ag2BtTitle', tag: 'ag2BtTag', note: 'ag2BtNote' } as const satisfies Record<string, Key>;
export const isBacktestLabel = (label: string | undefined | null): boolean => label === 'backtest';

export interface CreateDraft { template: string; name: string; mission: string; strategyPath: string; base: string; venues: string[]; capital: string; risk: Record<string, string>;
  /** the instruments of an agent on a GENERIC strategy, as typed (« BTC ETH SOL »); unused by a fixed-universe strategy */
  universe?: string }
/** the instruments typed for a generic strategy: upper-case tickers, in order, once each */
export const parseUniverse = (text: string | undefined): string[] => [...new Set((text ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean))];
export const emptyDraft = (tp: Template): CreateDraft => ({ template: tp.id, name: '', mission: '', strategyPath: tp.installed[0]?.path ?? '', base: tp.defaults.universe[0] ?? 'BTC', venues: [...tp.defaults.venues], capital: tp.defaults.capitalUsdc,
  ...(tp.installed.some((s) => s.generic) ? { universe: (tp.installed.find((s) => s.generic)?.defaultUniverse ?? tp.defaults.universe).join(' ') } : {}),
  risk: Object.fromEntries(Object.entries(tp.defaults.risk).map(([k, v]) => [k, String(v)])) });
export const venuesNeeded = (tp: Template): number => (tp.engine !== 'stream' ? 0 : tp.rule?.name === 'spread_inventory' ? 1 : 2);
/** Why the form cannot be sent, or null. A template without an installed strategy can NEVER be sent. */
export function createProblem(tp: Template, d: CreateDraft): 'not_installed' | 'name' | 'strategy' | 'universe' | 'venues' | 'base' | 'capital' | 'risk' | null {
  if (!tp.strategyInstalled) return 'not_installed';
  if (d.name.trim().length < 2) return 'name';
  if (tp.engine === 'bar' && !tp.installed.some((s) => s.path === d.strategyPath)) return 'strategy';
  const g = tp.engine === 'bar' ? tp.installed.find((s) => s.path === d.strategyPath && s.generic) : undefined;
  if (g) { const u = parseUniverse(d.universe); if (u.length < (g.minSymbols ?? 1) || u.length > (g.maxSymbols ?? 8) || u.some((x) => !/^[A-Z0-9]{2,10}$/.test(x))) return 'universe'; }
  if (tp.engine === 'stream') { if (d.venues.length !== venuesNeeded(tp) || new Set(d.venues).size !== d.venues.length) return 'venues'; if (!/^[A-Z0-9]{2,10}$/.test(d.base)) return 'base'; }
  if (tp.engine !== 'supervisor' && !(Number(d.capital) >= 50)) return 'capital';
  if (Object.values(d.risk).some((v) => v.trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0)) return 'risk';
  return null;
}
export function createBody(tp: Template, d: CreateDraft): Record<string, unknown> {
  const risk = Object.fromEntries(Object.entries(d.risk).map(([k, v]) => [k, Number(v)]));
  // a generic strategy has no instruments of its own: the agent's are sent; a fixed one sends none (the server uses the strategy's)
  const generic = tp.engine === 'bar' && tp.installed.some((s) => s.path === d.strategyPath && s.generic);
  return { template: tp.id, name: d.name.trim(), mission: d.mission.trim(), risk, ...(tp.engine === 'bar' ? { strategyPath: d.strategyPath } : {}), ...(generic ? { universe: parseUniverse(d.universe) } : {}), ...(tp.engine === 'stream' ? { universe: [d.base], venues: d.venues } : {}), ...(tp.engine !== 'supervisor' ? { capitalUsdc: d.capital } : {}) };
}
/** what the "live" entry of an agent (or of a template) says when live is not possible: the server's sentence, verbatim */
export const liveBlock = (x: { modes?: Mode[]; liveReason?: string | null; live?: { capable: boolean; reason: string | null }; familyModes?: { modes: Mode[]; liveReason: string | null } }): string | null => {
  const modes = x.familyModes?.modes ?? x.modes ?? [], reason = x.familyModes?.liveReason ?? x.liveReason ?? null;
  if (!modes.includes('live')) return reason ?? '';
  return x.live && !x.live.capable ? x.live.reason ?? '' : null;
};
const DECISION_ORDER = ['signal', 'decision', 'order', 'fill'];
export const timelineState = (it: Pick<TimelineItem, 'severity' | 'type'>): StepState => (it.severity === 'error' || it.type === 'error' ? 'failed' : it.severity === 'warning' || it.type === 'hold' || it.type === 'risk' ? 'current' : DECISION_ORDER.includes(it.type) || it.type === 'state' || it.type === 'mandate' ? 'done' : 'next');
export const ORDER_TONE: Record<string, Tone> = { FILLED: 'ok', PARTIALLY_FILLED: 'info', SUBMITTED: 'info', SUBMITTING: 'info', APPROVED: 'info', VALIDATED: 'info', CREATED: 'mute', AWAITING_APPROVAL: 'warn', CANCELLED: 'mute', REJECTED: 'danger', FAILED: 'danger', UNKNOWN: 'warn' };
/** the actions offered for an agent, from its life cycle, mode and what it came from */
export function actionsOf(o: Pick<Overview, 'state' | 'mode' | 'pausedFrom' | 'kind' | 'familyModes' | 'phase'>): { research: boolean; paper: boolean; live: boolean; pause: boolean; resume: boolean; resumeNeedsMandate: boolean; stop: boolean } {
  const m = o.familyModes.modes, resumeNeedsMandate = o.state === 'paused' && o.pausedFrom === 'LIVE' && o.kind === 'spot';
  return { research: o.state !== 'active' && m.includes('research'), paper: o.state !== 'active' && m.includes('paper') && o.mode !== 'live' || (o.state === 'stopped' && m.includes('paper')), live: o.state !== 'active' || o.mode !== 'live',
    pause: o.state === 'active' && o.phase !== 'STOPPING', resume: o.state === 'paused' && !resumeNeedsMandate, resumeNeedsMandate, stop: o.state !== 'stopped' };
}
const RISK_UNIT: Record<string, string> = { maxLeverage: '×', maxGrossExposureX: '×', maxPositionX: '×', maxDailyLossPct: '%', maxTotalLossPct: '%', slippageBps: 'bps', minTradePct: '%', maxPositionUsd: 'USD', maxGrossUsd: 'USD', maxDataAgeMs: 'ms',
  maxAgentDrawdownPct: '%', maxPortfolioDailyLossPct: '%', minLiquidationDistanceBps: 'bps', maxFundingBleedBpsPerDay: 'bps', killSwitchDailyLossPct: '%' };
export const riskUnit = (k: string): string => RISK_UNIT[k] ?? '';
export const riskKey = (k: string): Key => (`ag2R_${k}` as Key);
export const PERP_RISK_KEYS = ['maxLeverage', 'maxGrossExposureX', 'maxPositionX', 'maxDailyLossPct', 'maxTotalLossPct', 'slippageBps', 'minTradePct'] as const;
export const shortSha = (s: string): string => s.slice(0, 10);

// ------------------------------------------------------------------------------------------------------------------ small pieces
/** the venues an agent can be given: those the owner is offered (venues.ts) */
const VENUES = (['hyperliquid', 'edgex', 'dydx', 'gmx'] as const).filter(venueShown);
const VENUE_NAME: Record<string, string> = { hyperliquid: 'Hyperliquid', edgex: 'edgeX', dydx: 'dYdX v4', gmx: 'GMX v2' };
export function LifeTag({ state }: { state: Life }) { const t = useT(), x = LIFE_TAG[state]; return <Tag tone={x.tone} icon={x.icon} testid="ag2-life">{t(x.key)}</Tag>; }
export function ModeTag({ mode }: { mode: Mode }) { const t = useT(), x = MODE_TAG[mode]; return <Tag tone={x.tone} icon={x.icon} testid={`ag2-mode-${mode}`}>{t(x.key)}</Tag>; }
function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" role="checkbox" aria-checked={on} disabled={disabled} onClick={onClick} className={`press min-h-11 rounded-full border px-4 text-[0.875rem] font-medium disabled:opacity-40 ${on ? 'border-blue bg-blue/10 text-blue' : 'border-line text-mute'}`}>{children}</button>;
}
function RiskFields({ risk, onChange }: { risk: Record<string, string>; onChange: (r: Record<string, string>) => void }) {
  const t = useT();
  return <div className="grid grid-cols-2 gap-3">{Object.keys(risk).map((k) => <Field key={k} label={t(riskKey(k))}><UnitInput value={risk[k]!} unit={riskUnit(k)} onChange={(v) => onChange({ ...risk, [k]: v.replace(',', '.').replace(/[^0-9.]/g, '') })} /></Field>)}</div>;
}

// ------------------------------------------------------------------------------------------------------------------ creation from a template
export function TemplateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['agent-templates'], queryFn: () => get<{ templates: Template[] }>('/agents/templates'), staleTime: 60_000 });
  const [tp, setTp] = useState<Template | null>(null), [d, setD] = useState<CreateDraft | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const pick = (x: Template) => { const d0 = emptyDraft(x); setTp(x); setD({ ...d0, venues: d0.venues.filter(venueShown) }); setErr(''); };
  const problem = tp && d ? createProblem(tp, d) : 'name';
  const create = async () => { if (!tp || !d || problem) return; setBusy(true); setErr('');
    try { const r = await post<{ agent: { id: string } }>('/agents/from-template', createBody(tp, d)); onCreated(r.agent.id); } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); } };
  const strat = tp && d ? tp.installed.find((s) => s.path === d.strategyPath) : undefined;
  return <Sheet title={tp ? tp.name[locale] : t('ag2TplTitle')} sub={tp ? t(FAMILY_KEY(tp.family)) : t('ag2TplSub')} onClose={onClose} wide busy={busy} testid="ag2-template-sheet"
    footer={tp && d ? <div className="flex gap-2"><Btn kind="ghost" onClick={() => { setTp(null); setD(null); }}>{t('ag2Back')}</Btn><Btn full busy={busy} disabled={problem !== null} onClick={() => void create()}>{t('ag2Create')}</Btn></div> : undefined}>
    {q.isLoading ? <SkeletonRows n={5} /> : q.isError ? <ErrorState title={t('ag2LoadErr')} onRetry={() => void q.refetch()} /> : !tp || !d ? <div className="grid gap-2.5">
      {/* step 1 — the family */}
      {/* a template that needs more venues than the owner is offered cannot be configured: it is not listed */}
      {q.data!.templates.filter((x) => venuesNeeded(x) <= VENUES.length).map((x) => <button key={x.id} type="button" disabled={!x.strategyInstalled} onClick={() => pick(x)} data-testid={`ag2-tpl-${x.id}`} className="card row-press block w-full p-4 text-left disabled:opacity-70">
        <span className="flex items-start justify-between gap-3"><span className="min-w-0"><span className="block text-[1rem] font-semibold">{x.name[locale]}</span><span className="mt-1 block text-[0.84375rem] leading-snug text-mute">{x.summary[locale]}</span></span>{x.strategyInstalled && <Icon n="chev" className="mt-1 h-4 w-4 shrink-0 text-mute" />}</span>
        <span className="mt-2.5 flex flex-wrap items-center gap-1.5">{x.modes.map((m) => <ModeTag key={m} mode={m} />)}{!x.strategyInstalled && <Tag tone="warn" icon="x" testid="ag2-not-installed">{t('ag2NotInstalled')}</Tag>}</span>
        {!x.strategyInstalled && <span className="mt-2 block text-[0.78125rem] leading-snug text-mute">{t('ag2NotInstalledNote', { names: x.strategyNames.join(', ') })}</span>}
        {!x.modes.includes('live') && x.liveReason && <span className="mt-2 block text-[0.78125rem] leading-snug text-mute" data-testid="ag2-live-reason">{x.liveReason}</span>}
        {/* the laboratory's out-of-sample result for this template: a BACKTEST, labelled, with its stops */}
        <LabVerdicts verdicts={x.labVerdicts} /></button>)}
    </div> : <div className="space-y-6">
      <FormGroup title={t('ag2StepIdentity')}>
        <Field label={t('agName')}><input className={inputCls} maxLength={40} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label={t('agMission')}><textarea className={`${inputCls} min-h-[64px] resize-none`} maxLength={400} value={d.mission} onChange={(e) => setD({ ...d, mission: e.target.value })} /></Field>
      </FormGroup>
      {/* step 2 — the strategy (bar) or the rule (stream, supervisor) */}
      <FormGroup title={t('ag2StepStrategy')}>
        {tp.engine === 'bar' ? <div className="grid gap-2" role="radiogroup" aria-label={t('ag2StepStrategy')}>{tp.installed.map((s) => { const on = s.path === d.strategyPath; return <button key={s.path} type="button" role="radio" aria-checked={on} onClick={() => setD({ ...d, strategyPath: s.path })}
          className={`press rounded-2xl border p-3.5 text-left ${on ? 'border-blue bg-blue/5' : 'border-line'}`}>
          <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[0.84375rem] font-semibold">{s.path}</span><Tag tone={s.liveCapable ? 'ok' : 'info'} icon={s.liveCapable ? 'bolt' : 'eye'}>{t(s.liveCapable ? 'ag2CanLive' : 'ag2PaperOnly')}</Tag></span>
          <span className="mt-1 block text-[0.8125rem] text-mute">{s.generic ? t('ag2GenericUniverse', { min: s.minSymbols ?? 1, max: s.maxSymbols ?? 8 }) : s.universe.join(' · ')} — {s.interval} — {shortSha(s.sha256)}…</span>
          {s.generic && s.liveCondition && <span className="mt-1.5 block text-[0.78125rem] leading-snug text-mute">{s.liveCondition}</span>}
          {/* audit D1: the refusal is said BEFORE anything is approved */}
          {!s.liveCapable && s.liveReason && <span className="mt-1.5 block text-[0.78125rem] leading-snug text-warn">{s.liveReason}</span>}</button>; })}</div>
          : <dl><Fact k={t('ag2Rule')} mono>{tp.rule?.name}@{tp.rule?.version}</Fact><Fact k={t('ag2RuleHash')} mono>{shortSha(tp.rule?.sha256 ?? '')}…</Fact>
            {tp.labBacktest.wanted.length > 0 && <Fact k={t('ag2LabBacktest')}>{tp.labBacktest.installed.length ? tp.labBacktest.installed.join(', ') : t('ag2LabBacktestNone', { names: tp.labBacktest.wanted.join(', ') })}</Fact>}
            {(tp.labStudies ?? []).length > 0 && <Fact k={t('ag2LabStudies')}>{tp.labStudies!.map((x) => x.name).join(', ')}</Fact>}</dl>}
        {tp.labBacktest.wanted.length > 0 && <p className="text-[0.78125rem] leading-snug text-mute">{t('ag2LabBacktestOnly')}</p>}
        <LabVerdicts verdicts={tp.labVerdicts} detail />
      </FormGroup>
      {/* step 3 — the markets */}
      {tp.engine !== 'supervisor' && <FormGroup title={t('ag2StepMarkets')}>
        {tp.engine === 'bar' ? (strat?.generic ? <><Field label={t('ag2GenericField')} hint={t('ag2GenericUniverse', { min: strat.minSymbols ?? 1, max: strat.maxSymbols ?? 8 })}><input className={`${inputCls} uppercase`} maxLength={90} value={d.universe ?? ''} onChange={(e) => setD({ ...d, universe: e.target.value.toUpperCase().replace(/[^A-Z0-9 ,]/g, '') })} data-testid="ag2-generic-universe" /></Field>
            <div className="flex items-center gap-3"><LogoStack syms={parseUniverse(d.universe)} /><span className="text-[0.9375rem] font-semibold">{parseUniverse(d.universe).join(' · ')}</span></div>{strat.liveCondition && <p className="text-[0.78125rem] leading-snug text-mute">{strat.liveCondition}</p>}</>
          : <><div className="flex items-center gap-3"><LogoStack syms={strat?.universe ?? []} /><span className="text-[0.9375rem] font-semibold">{(strat?.universe ?? []).join(' · ')}</span></div><p className="text-[0.78125rem] leading-snug text-mute">{t('ag2UniverseFixed')}</p></>)
          : <><Field label={t('ag2Base')}><input className={`${inputCls} uppercase`} maxLength={10} value={d.base} onChange={(e) => setD({ ...d, base: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></Field>
            <div><div className="mb-2 text-[0.8125rem] font-medium text-mute">{t('ag2Venues', { n: venuesNeeded(tp) })}</div><div className="flex flex-wrap gap-2">{VENUES.map((v) => { const on = d.venues.includes(v); return <Chip key={v} on={on} onClick={() => setD({ ...d, venues: on ? d.venues.filter((x) => x !== v) : [...d.venues, v].slice(-venuesNeeded(tp)) })}>{VENUE_NAME[v]}</Chip>; })}</div></div></>}
        <div className="flex flex-wrap items-center gap-1.5">{tp.modes.map((m) => <ModeTag key={m} mode={m} />)}</div>
        {!tp.modes.includes('live') && tp.liveReason && <Notice tone="info"><span data-testid="ag2-live-reason">{tp.liveReason}</span></Notice>}
      </FormGroup>}
      {/* step 4 — the capital */}
      {tp.engine !== 'supervisor' && <FormGroup title={t('ag2StepCapital')}><Field label={t('ag2CapitalSim')}><UnitInput value={d.capital} unit="USDC" onChange={(v) => setD({ ...d, capital: v.replace(',', '.').replace(/[^0-9.]/g, '') })} /></Field></FormGroup>}
      {/* step 5 — the limits */}
      <FormGroup title={t('ag2StepLimits')}><RiskFields risk={d.risk} onChange={(risk) => setD({ ...d, risk })} />{tp.engine === 'supervisor' && <Notice tone="info">{t('ag2SupNote')}</Notice>}</FormGroup>
      {problem && problem !== 'name' && <Notice tone="warn">{t(`ag2Problem_${problem}` as Key)}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
    </div>}
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------------------------ performance, one mode
function PerfView({ id, mode }: { id: string; mode: 'paper' | 'live' }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['ag2-perf', id, mode], queryFn: () => get<Perf>(scopedUrl(id, 'performance', mode)), refetchInterval: 30_000 });
  if (q.isLoading) return <SkeletonCard lines={4} />;
  if (q.isError || !q.data) return <ErrorState title={t('ag2LoadErr')} onRetry={() => void q.refetch()} />;
  const p = q.data, rows = perfRows(p);
  return <div className="space-y-3" data-testid={`ag2-perf-${p.mode}`} data-mode={p.mode}>
    <EquityCard title={t(mode === 'paper' ? 'ag2EqPaper' : 'ag2EqLive')} right={<ModeTag mode={p.mode} />} points={p.equityCurve.map((e) => ({ t: e.ts, p: e.equity }))} format={(v) => fiat(v, 'USD', locale)} formatTime={(x) => when(new Date(x), locale)} />
    <p className="px-1 text-[0.78125rem] leading-snug text-mute">{p.label}</p>
    {p.warnings.map((w) => <Notice key={w.code} tone="warn">{srvText(t, locale, w.message)}</Notice>)}
    <StatGrid>{rows.map((r) => <Stat key={r.key} label={t(r.key)} value={fmtPerf(r, locale)} sub={r.reason ?? undefined} />)}
      <Stat label={t('ag2PfTrades')} value={String(p.closedTrades)} /><Stat label={t('ag2PfOrders')} value={String(p.orders)} /></StatGrid>
  </div>;
}

function ModeLists({ id, mode }: { id: string; mode: Mode }) {
  const t = useT(); const { locale } = useContext(I18n);
  const tl = useQuery({ queryKey: ['ag2-timeline', id, mode], queryFn: () => get<{ mode: Mode; items: TimelineItem[] }>(scopedUrl(id, 'timeline', mode, 80)), refetchInterval: 20_000 });
  const od = useQuery({ queryKey: ['ag2-orders', id, mode], queryFn: () => get<{ mode: Mode; orders: any[] }>(scopedUrl(id, 'orders', mode, 50)), refetchInterval: 20_000, enabled: mode !== 'research' });
  return <div className="space-y-4" data-mode={mode}>
    <Section title={t('ag2Timeline')} right={<ModeTag mode={mode} />}><Card>
      {tl.isLoading ? <SkeletonRows n={4} /> : !tl.data?.items.length ? <p className="text-[0.875rem] text-mute">{t('ag2TimelineEmpty')}</p> :
        <Timeline label={t('ag2Timeline')} items={tl.data.items.map((it, k) => ({ key: `${it.ts}-${k}`, state: timelineState(it), title: it.title, stateLabel: t(`ag2Ty_${['signal', 'decision', 'order', 'fill', 'error', 'risk', 'mandate', 'state', 'proposal', 'hold', 'stop'].includes(it.type) ? it.type : 'other'}` as Key),
          children: <><span className="block">{when(new Date(it.ts), locale)}{it.configVersion ? ` · ${t('ag2ConfigV', { n: it.configVersion })}` : ''}{it.code ? ` · ${it.code}` : ''}</span>{it.body && <span className="block [overflow-wrap:anywhere]">{it.body}</span>}</> }))} />}</Card></Section>
    {mode !== 'research' && <Section title={t('ag2Orders')} right={<ModeTag mode={mode} />}><Card>
      {od.isLoading ? <SkeletonRows n={3} /> : !od.data?.orders.length ? <p className="text-[0.875rem] text-mute">{t('ag2OrdersEmpty')}</p> : <ul className="divide-y divide-line">{od.data.orders.map((o) => <li key={o.id} className="py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[0.90625rem] font-semibold">{t(o.side === 'buy' ? 'ag2Buy' : 'ag2Sell')} {o.instrument}{o.reduceOnly ? ` · ${t('ag2ReduceOnly')}` : ''}</span><Tag tone={ORDER_TONE[o.state] ?? 'mute'}>{o.state}</Tag></div>
        <div className="mt-0.5 text-[0.78125rem] text-mute">{when(new Date(o.ts), locale)} · {o.size ?? o.notional ?? '—'}{Number(o.filledSize) > 0 ? ` · ${t('ag2Filled', { size: o.filledSize, price: o.avgFillPrice ?? '—' })}` : ''}</div>
        {o.detail && <div className="mt-0.5 text-[0.78125rem] text-mute [overflow-wrap:anywhere]">{o.detail}</div>}</li>)}</ul>}</Card></Section>}
  </div>;
}

// ------------------------------------------------------------------------------------------------------------------ backtest
function BacktestCard({ o, id, refresh }: { o: Overview; id: string; refresh: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [job, setJob] = useState<{ id: string; status: string; error?: string | null } | null>(null), [err, setErr] = useState('');
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return;
    const h = setInterval(() => { void get<{ job: { id: string; status: string; error: string | null } }>(`/agents/jobs/${job.id}`).then((r) => { setJob(r.job); if (r.job.status === 'done' || r.job.status === 'failed') refresh(); }, () => {}); }, 2000);
    return () => clearInterval(h);
  }, [job, refresh]);
  const run = async () => { setErr(''); try { const r = await post<{ job: { id: string; status: string } }>(`/agents/${id}/backtest`, {}); setJob(r.job); } catch (e) { setErr(errText(t, e)); } };
  // the version-3 sections of a perp report (execution model, engine parity, data bias, journal) come with the perp agent's own
  // detail (`versions[].summary`); the overview carries the metrics only — gross to net per split is shown from those in any case
  const detail = useQuery({ queryKey: ['agent', id], queryFn: () => get<{ versions?: { id: string; summary: ReportSummary | null }[] }>(`/agents/${id}`), enabled: o.kind === 'perp', staleTime: 30_000 });
  const summaryOf = (v: { id: string; metrics: Record<string, Record<string, unknown>> | null }): ReportSummary => detail.data?.versions?.find((x) => x.id === v.id)?.summary ?? { schemaVersion: null, metrics: v.metrics };
  const running = !!job && (job.status === 'queued' || job.status === 'running'), rec = o.backtests.recorded, pct = (x: unknown) => (typeof x === 'number' ? `${numFmt(x * 100, locale, 1)} %` : '—'), n2 = (x: unknown) => (typeof x === 'number' ? numFmt(x, locale, 2) : '—');
  if (o.engine === 'supervisor') return null;
  return <Card><div data-testid="ag2-backtest" data-label={o.backtests.label}>
    <CardHead right={<Tag tone="warn" icon="chart" testid="ag2-backtest-tag">{t(BACKTEST_KEYS.tag)}</Tag>}>{t(BACKTEST_KEYS.title)}</CardHead>
    <p className="text-[0.8125rem] leading-snug text-mute">{t(BACKTEST_KEYS.note)}</p>
    <div className="mt-3 space-y-3">
      {o.backtests.versions.filter((v) => v.hasReport).slice(0, 2).map((v) => <div key={v.id} className="rounded-2xl bg-elev/60 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[0.8125rem] font-semibold">{v.name}@{v.version} · {shortSha(v.sha256)}…</span><Tag tone={v.status === 'approved' ? 'ok' : 'mute'}>{v.status}{v.approvedBy && v.approvedBy !== 'owner' ? ` (${t('ag2ApprovedPaperOnly')})` : ''}</Tag></div>
        <StatGrid cols={3} className="mt-2.5">{(['train', 'validation', 'test'] as const).map((s) => <Stat key={s} label={`${t('ag2BtSplit')} ${s}`} value={pct(v.metrics?.[s]?.total_return)} sub={`Sharpe ${n2(v.metrics?.[s]?.sharpe)} · DD ${pct(v.metrics?.[s]?.max_drawdown)}`} />)}</StatGrid>
        {v.checks && <p className="mt-2 text-[0.78125rem] text-mute">{Object.entries(v.checks).filter(([, x]) => typeof x === 'string').map(([k, x]) => `${k}: ${String(x)}`).join(' · ')}</p>}
        {o.kind === 'perp' && <ReportV3 summary={summaryOf(v)} />}</div>)}
      {o.backtests.versions.filter((v) => !v.hasReport && v.notes).slice(0, 1).map((v) => <Notice key={v.id} tone="warn">{v.notes}</Notice>)}
      {rec && isBacktestLabel(rec.label) && <div className="rounded-2xl bg-elev/60 p-3.5">
        <div className="text-[0.84375rem] font-semibold">{t('ag2BtRecorded', { n: rec.snapshots, missing: rec.missing })}</div>
        <StatGrid cols={3} className="mt-2.5">{perfRows(rec.performance).slice(0, 6).map((r) => <Stat key={r.key} label={t(r.key)} value={fmtPerf(r, locale)} sub={r.reason ?? undefined} />)}</StatGrid>
        {rec.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
        <Fold summary={t('ag2BtModel')}><ul className="list-disc space-y-1 pl-5 text-[0.78125rem] text-mute">{rec.model.map((m) => <li key={m}>{m}</li>)}</ul></Fold></div>}
      {!rec && !o.backtests.versions.some((v) => v.hasReport) && <p className="text-[0.84375rem] text-mute">{t('ag2BtNone')}</p>}
      {job && <Notice tone={job.status === 'failed' ? 'danger' : job.status === 'done' ? 'ok' : 'info'}>{t(`ag2Job_${job.status === 'cancelled' ? 'failed' : job.status}` as Key)}{job.error ? ` — ${srvText(t, locale, job.error)}` : ''}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      <Btn kind="ghost" full busy={running} disabled={running} onClick={() => void run()}><Icon n="chart" className="h-4 w-4" />{t('ag2BtRun')}</Btn>
    </div></div></Card>;
}

// ------------------------------------------------------------------------------------------------------------------ mandate request (live)
function MandateSheet({ o, onClose, onLegacy }: { o: Overview; onClose: () => void; onLegacy?: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['ag2-draft', o.id], queryFn: () => get<Draft>(`/agents/${o.id}/mandate-draft?locale=${locale}`) });
  const block = liveBlock(o), d = q.data;
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  // the mandate is CREATED from the draft (nothing is approved), then the Risk screen opens on it: the passkey step is there
  const create = async () => { if (!d?.create) return; setBusy(true); setErr(''); try { const r = await post<{ approval: { route: string } }>(d.create.path.replace('/api/v1', ''), d.create.body); window.location.assign(r.approval.route); } catch (e) { setErr(errText(t, e)); setBusy(false); } };
  const flat = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return <Sheet title={t('ag2MandateTitle')} sub={t('ag2MandateSub')} onClose={onClose} wide testid="ag2-mandate-sheet">
    {block !== null ? <Notice tone="warn"><span data-testid="ag2-live-reason">{block || t('ag2LiveUnavailable')}</span></Notice> : q.isLoading ? <SkeletonRows n={4} /> : !d ? <ErrorState title={t('ag2LoadErr')} onRetry={() => void q.refetch()} /> : <div className="space-y-4">
      {!d.available && d.reason && <Notice tone="warn">{srvText(t, locale, d.reason)}</Notice>}
      {o.pausedFrom === 'LIVE' && <Notice tone="info">{t('ag2ResumeNewMandate')}</Notice>}
      <Notice tone="info">{t('ag2MandateNote')}</Notice>
      {d.fields && <dl className="receipt">{Object.entries(d.fields).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v)).map(([k, v]) => <Fact key={k} k={k} mono>{Array.isArray(v) ? v.map(flat).join(', ') : flat(v)}</Fact>)}</dl>}
      {d.fields && Object.entries(d.fields).some(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) && <Fold summary={t('ag2MandateDetail')}><pre className="overflow-x-auto whitespace-pre-wrap text-[0.75rem] text-mute">{JSON.stringify(d.fields, null, 2)}</pre></Fold>}
      <dl><Fact k={t('ag2MandateDraft')} mono>{d.draft}</Fact></dl>
      {d.pending && <Notice tone="info"><span data-testid="ag2-mandate-pending">{t(d.pending.state === 'active' ? 'ag2MandateApproved' : 'ag2MandatePending', { id: d.pending.mandateId.slice(0, 8) })}</span></Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      {d.create && <Btn full busy={busy} onClick={() => void create()} data-testid="ag2-mandate-create">{t('ag2MandateCreate')}</Btn>}
      <a className={`press inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl px-5 text-[0.96875rem] font-semibold ${d.create ? 'border border-line' : 'bg-primary text-onprimary'}`} href={d.approval.route} data-testid="ag2-mandate-link">{t('ag2MandateOpen')}</a>
      <p className="text-[0.78125rem] leading-snug text-mute">{t('ag2MandateUntilMerge')}{d.existingFlow ? ` ${d.existingFlow}.` : ''}</p>
      {onLegacy && (o.kind === 'spot' || o.kind === 'perp') && <Btn kind="ghost" full onClick={onLegacy}>{t('ag2MandateLegacy')}</Btn>}
    </div>}
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------------------------ D14: perp limits, vault withdrawals
function PerpRiskSheet({ o, onClose, onSaved }: { o: Overview; onClose: () => void; onSaved: () => void }) {
  const t = useT(); const [risk, setRisk] = useState<Record<string, string>>(Object.fromEntries(PERP_RISK_KEYS.map((k) => [k, String(o.riskLimits[k] ?? '')]))), [lift, setLift] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const save = async () => { setBusy(true); setErr(''); try { await post(`/agents/${o.id}/perp/risk`, { risk: Object.fromEntries(Object.entries(risk).map(([k, v]) => [k, Number(v)])), liftHalt: lift }); onSaved(); } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); } };
  return <Sheet title={t('ag2EditLimits')} sub={t('ag2EditLimitsSub')} onClose={onClose} busy={busy} footer={<Btn full busy={busy} onClick={() => void save()}>{t('ag2Save')}</Btn>} testid="ag2-risk-sheet">
    <div className="space-y-4"><RiskFields risk={risk} onChange={setRisk} />
      <label className="flex min-h-11 items-center gap-3 text-[0.875rem]"><input type="checkbox" checked={lift} onChange={(e) => setLift(e.target.checked)} />{t('ag2LiftHalt')}</label>
      {err && <Notice tone="danger">{err}</Notice>}</div></Sheet>;
}
function Withdrawals({ id }: { id: string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useQuery({ queryKey: ['ag2-withdrawals', id], queryFn: () => get<{ withdrawals: { id: string; symbol?: string; state: string; createdAt?: string; created_at?: string; display?: string; txid?: string | null }[] }>(`/agents/${id}/withdrawals`) });
  return <Fold summary={t('ag2Withdrawals')} testid="ag2-withdrawals">{q.isLoading ? <SkeletonRows n={2} /> : !q.data?.withdrawals.length ? <p className="text-[0.84375rem] text-mute">{t('ag2WithdrawalsNone')}</p> :
    <ul className="divide-y divide-line">{q.data.withdrawals.map((w) => <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[0.84375rem]"><span>{w.display ?? ''} {w.symbol ?? ''} · {when(w.createdAt ?? w.created_at ?? new Date(), locale)}</span><Tag tone={w.state === 'confirmed' ? 'ok' : w.state === 'failed' ? 'danger' : 'info'}>{w.state}</Tag></li>)}</ul>}</Fold>;
}

// ------------------------------------------------------------------------------------------------------------------ the panel
export function AgentPanel({ id, nav, onLegacy }: { id: string; nav: Nav; onLegacy?: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ag2-overview', id], queryFn: () => get<Overview>(`/agents/${id}/overview`), refetchInterval: 15_000 });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [sheet, setSheet] = useState<'' | 'mandate' | 'risk' | 'kill'>(''), [tab, setTab] = useState<'paper' | 'live' | null>(null), [killReason, setKillReason] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ag2-overview', id] }); void qc.invalidateQueries({ queryKey: ['agents'] }); void qc.invalidateQueries({ queryKey: ['agent', id] }); };
  // market making: "request live" (and a refused live start) opens the go-live checklist of the Market making section, never the generic mandate sheet
  const isMm = q.data?.family === 'market_making'; const [mmFocus, setMmFocus] = useState(0);
  useEffect(() => { if (isMm && sheet === 'mandate') { setSheet(''); setMmFocus((n) => n + 1); } }, [isMm, sheet]);
  if (q.isLoading) return <div className="space-y-4"><SkeletonCard lines={3} /><SkeletonCard lines={4} /></div>;
  if (q.isError || !q.data) return <ErrorState title={t('ag2LoadErr')} onRetry={() => void q.refetch()} />;
  const o = q.data, acts = actionsOf(o), block = liveBlock(o);
  // the tab shown: the agent's own mode first; a research agent has no performance tab selected by default
  const view: 'paper' | 'live' = tab ?? (o.mode === 'live' ? 'live' : 'paper'), listMode: Mode = tab ?? o.mode;
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr('');
    try { await fn(); refresh(); } catch (e) { if ((e as { code?: string }).code === 'mandate_required') setSheet('mandate'); else setErr(errText(t, e)); } finally { setBusy(''); } };
  const start = (mode: Mode) => act(`start-${mode}`, () => post(`/agents/${id}/start`, { mode }));
  const revoke = () => act('revoke', () => (o.kind === 'spot' ? post(`/agents/${id}/revoke`) : post(`/agents/${id}/stop`, { reason: 'permissions revoked by the owner' })));
  const book = o.runtime?.book, c = o.runtime?.counters;
  return <div className="space-y-4" data-testid="ag2-panel">
    <PageTitle onBack={() => (onLegacy ? onLegacy() : nav({ tab: 'agents' }))} backLabel={t('agents')}>{o.name}</PageTitle>
    <Card><div className="flex items-center gap-3.5">{o.universe.length > 0 && <LogoStack syms={o.universe} size={40} />}
      <div className="min-w-0 flex-1"><div className="text-[0.9375rem] font-semibold">{t(FAMILY_KEY(o.family))}</div><div className="text-[0.8125rem] text-mute [overflow-wrap:anywhere]">{o.universe.join(' · ') || t('ag2AllAgents')} · {o.venue}</div></div></div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5"><LifeTag state={o.state} /><ModeTag mode={o.mode} /><Tag tone="mute" icon="list">{t('ag2ConfigV', { n: o.configVersion })}</Tag>{o.mandate && <Tag tone="danger" icon="key">{t('ag2MandateActive')}</Tag>}</div>
      <dl className="mt-3">
        <Fact k={t('ag2Strategy')} mono>{o.strategy ? `${o.strategy.name}@${o.strategy.version} · ${shortSha(o.strategy.sha256)}…` : t('ag2NoStrategy')}</Fact>
        {o.engine !== 'supervisor' && <Fact k={t('ag2Capital')}>{usdCapital(o.capitalUsd, locale)}</Fact>}
        {o.stopReason && o.state === 'stopped' && <Fact k={t('ag2StopReason')}>{srvText(t, locale, o.stopReason)}</Fact>}
        {o.worker.tick?.last_error && <Fact k={t('ag2LastError')}>{o.worker.tick.last_error}</Fact>}
      </dl>
      {block !== null && <p className="mt-2 text-[0.78125rem] leading-snug text-mute" data-testid="ag2-live-reason">{block}</p>}
      {onLegacy && <Btn kind="ghost" full className="mt-3" onClick={onLegacy}>{t('ag2OpenLegacy')}</Btn>}</Card>

    {o.killSwitch.engaged && <Notice tone="danger">{t('ag2KillOn', { reason: o.killSwitch.reason ?? '—' })}</Notice>}
    {err && <Notice tone="danger">{err}</Notice>}

    <Section title={t('ag2Actions')}><Card className="space-y-2.5">
      {acts.research && <Btn kind="ghost" full busy={busy === 'start-research'} onClick={() => void start('research')}>{t('ag2StartResearch')}</Btn>}
      {acts.paper && <Btn full busy={busy === 'start-paper'} onClick={() => void start('paper')}>{t('ag2StartPaper')}</Btn>}
      {acts.resume && <Btn full busy={busy === 'resume'} onClick={() => void act('resume', () => post(`/agents/${id}/resume`))}>{t('ag2Resume')}</Btn>}
      {acts.resumeNeedsMandate && <Btn full onClick={() => setSheet('mandate')} data-testid="ag2-resume-mandate">{t('ag2ResumeMandate')}</Btn>}
      {acts.live && <Btn kind="ghost" full onClick={() => setSheet('mandate')} data-testid="ag2-request-live">{t('ag2RequestLive')}</Btn>}
      {acts.pause && <Btn kind="ghost" full busy={busy === 'pause'} onClick={() => void act('pause', () => post(`/agents/${id}/pause`, {}))}>{t('ag2Pause')}</Btn>}
      {acts.stop && <Btn kind="danger" full busy={busy === 'stop'} onClick={() => void act('stop', () => post(`/agents/${id}/stop`, {}))}>{t('ag2Stop')}</Btn>}
      {o.mandate && <Btn kind="danger" full busy={busy === 'revoke'} onClick={() => void revoke()}>{t('ag2Revoke')}</Btn>}
      {o.kind === 'perp' && !o.mandate && <Btn kind="ghost" full onClick={() => setSheet('risk')}>{t('ag2EditLimits')}</Btn>}
      <p className="text-[0.78125rem] leading-snug text-mute">{t('ag2ActionsNote')}</p></Card></Section>

    {isMm && <Suspense fallback={<SkeletonCard lines={4} />}><MmSection id={id} agent={{ strategySha256: o.strategy?.sha256 ?? '', capitalUsd: o.capitalUsd, mode: o.mode }} focus={mmFocus} onChanged={refresh} /></Suspense>}

    <Section title={t('ag2Limits')}><Card><dl>{Object.entries(o.riskLimits).map(([k, v]) => <Fact key={k} k={t(riskKey(k))}>{String(v)} {riskUnit(k)}</Fact>)}</dl>
      {o.kind === 'spot' && <Withdrawals id={id} />}</Card></Section>

    {o.engine === 'stream' && o.runtime && <Section title={t('ag2SimBook')} right={<Tag tone="info" icon="eye" testid="ag2-simulated">{t('ag2Simulated')}</Tag>}><Card className="space-y-3">
      {o.runtime.hold && <Notice tone="warn">{t('ag2Hold', { code: o.runtime.hold.code, since: when(new Date(o.runtime.hold.since), locale) })}</Notice>}
      <dl><Fact k={t('ag2Rule')} mono>{o.runtime.rule}</Fact><Fact k={t('ag2VenuesLabel')}>{o.runtime.venues.map((v) => VENUE_NAME[v] ?? v).join(' + ')}</Fact></dl>
      {c && <StatGrid><Stat label={t('ag2CtDecisions')} value={String(c.decisions)} sub={t('ag2CtActed', { n: c.acted })} /><Stat label={t('ag2CtFills')} value={String(c.fills)} /><Stat label={t('ag2CtStale')} value={String(c.skippedStale)} /><Stat label={t('ag2CtGap')} value={String(c.skippedGap)} /></StatGrid>}
      {book ? <><StatGrid cols={3}><Stat label={t('ag2BkRealized')} value={fiat(book.realizedPnl, 'USD', locale)} /><Stat label={t('ag2PfFees')} value={fiat(book.fees, 'USD', locale)} /><Stat label={t('ag2PfFunding')} value={fiat(book.funding, 'USD', locale)} /></StatGrid>
        <dl>{Object.entries(book.positions).filter(([, p]) => p.size !== 0).map(([k, p]) => <Fact key={k} k={k} mono>{numFmt(p.size, locale, 6)} @ {numFmt(p.avgPrice, locale, 2)}</Fact>)}
          {book.quotes.map((x) => <Fact key={x.id} k={`${t(x.side === 'buy' ? 'ag2QuoteBid' : 'ag2QuoteAsk')} ${x.instrument}`} mono>{numFmt(x.size, locale, 6)} @ {numFmt(x.price, locale, 2)}</Fact>)}
          {book.pair && <Fact k={t('ag2Pair')} mono>+{book.pair.longInstrument} / −{book.pair.shortInstrument} · {numFmt(book.pair.sizeBase, locale, 6)}</Fact>}</dl></> : <p className="text-[0.84375rem] text-mute">{t('ag2BkNone')}</p>}
      {o.runtime.rule === 'spread_inventory' && <Fold summary={t('ag2FillModel')}><p className="text-[0.78125rem] leading-snug text-mute">{t('ag2FillModelText')}</p></Fold>}</Card></Section>}

    {o.engine === 'supervisor' && <Section title={t('ag2KillSwitch')}><Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><Tag tone={o.killSwitch.engaged ? 'danger' : 'ok'} icon={o.killSwitch.engaged ? 'stop' : 'check'} testid="ag2-kill-state">{t(o.killSwitch.engaged ? 'ag2KillEngaged' : 'ag2KillOff')}</Tag>{o.runtime?.lastPass && <span className="text-[0.78125rem] text-mute">{t('ag2SupLast', { n: o.runtime.lastPass.findings, at: when(new Date(o.runtime.lastPass.ts), locale) })}</span>}</div>
      <p className="text-[0.78125rem] leading-snug text-mute">{t('ag2SupNote')}</p>
      {/* V11.2: ONE kill switch, the risk engine's. It is engaged from here; it is released in Risk, with the passkey — never here */}
      {o.killSwitch.engaged ? <a className="press inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl border border-line px-5 text-[0.96875rem] font-semibold" href="/risk" data-testid="ag2-kill-release-link">{t('ag2KillRelease')}</a> : <Btn kind="danger" full onClick={() => setSheet('kill')}>{t('ag2KillEngage')}</Btn>}</Card></Section>}

    <BacktestCard o={o} id={id} refresh={refresh} />

    {/* performance: two tabs, two requests, two curves — never one */}
    <Section title={t('ag2Performance')}>
      <Seg<'paper' | 'live'> value={view} onChange={(v) => setTab(v)} label={t('ag2Performance')} options={[['paper', t(PERF_TAB.paper)], ['live', t(PERF_TAB.live)]] as const} />
      <div className="mt-3">{o.mode === 'research' && tab === null ? <Notice tone="info">{t('ag2ResearchNoPerf')}</Notice> : view === 'live' && block !== null && o.mode !== 'live' ? <EmptyState icon="chart" title={t('ag2NoLivePerf')}>{block || t('ag2LiveUnavailable')}</EmptyState> : <PerfView key={view} id={id} mode={view} />}</div>
    </Section>
    <ModeLists key={listMode} id={id} mode={listMode} />

    {sheet === 'mandate' && !isMm && <MandateSheet o={o} onClose={() => setSheet('')} {...(onLegacy ? { onLegacy: () => { setSheet(''); onLegacy(); } } : {})} />}
    {sheet === 'risk' && <PerpRiskSheet o={o} onClose={() => setSheet('')} onSaved={() => { setSheet(''); refresh(); }} />}
    {sheet === 'kill' && <Sheet title={t('ag2KillEngage')} sub={t('ag2KillConfirm')} onClose={() => setSheet('')} busy={busy === 'kill'}
      footer={<Btn kind="danger" full busy={busy === 'kill'} disabled={killReason.trim().length < 3} onClick={() => void act('kill', async () => { await post('/agents/kill-switch/engage', { reason: killReason.trim() }); setSheet(''); })}>{t('ag2KillEngage')}</Btn>}>
      <Field label={t('ag2KillReason')}><input className={inputCls} maxLength={200} value={killReason} onChange={(e) => setKillReason(e.target.value)} /></Field></Sheet>}
  </div>;
}

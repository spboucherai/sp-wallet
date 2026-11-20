// V11 — live market making on Hyperliquid: the "Market making" section of a market-making agent's page, its go-live checklist,
// the quoting mandate form and its approval sheet, and the block the Risk screen shows for quoting mandates.
// A chunk of its own: imported lazily by screens/agentPanel.tsx and screens/Risk.tsx, never by the app shell.
//
// Rules this file keeps (apps/web/test/mm.test.ts):
//   - PAPER is labelled SIMULATED wherever a paper figure shows; paper and live are two tabs, two requests, never one sum.
//   - nothing suggests a profit: the laboratory study and the simulation are shown as the server sends them (both NEGATIVE), and
//     the owner ticks the server's exact statement; a positive figure is never coloured.
//   - the checklist is ordered; a step is acted on only when the steps before it are done — the server's `goLive.steps` decide.
//   - every field of the quoting mandate shows its compiled bound; a refusal shows the server's code and sentence verbatim;
//     the approval sheet shows the enforced-by table row by row, the four hashes and the acknowledgement BEFORE the two
//     passkey prompts, and no prompt is reachable past a refusal.
//   - "pull" and "flatten" stay enabled under every lock and halt.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApprovalOutcomePanel, inDoubt, useApprovalOutcome } from '../approvalUi';   // NEXT W1: the outcome of an approval is what the server says

import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { get, post } from '../api';
import { I18n, useT, type Key } from '../i18n';
import {
  ageText, baseOf, boundText, breakerChoices, canApprove, canRevoke, checklist, cleanDec, cleanInt, commandState, draftProblems, emptyQuotingDraft, fieldKey, FIELDS, flatFigures, goLivePath, groupKey, GROUPS, hmsUtc, HORIZONS, horizonOf, isNegative,
  markoutCell, mmAgentUrl, mmEvidenceUrl, mmFillsUrl, mmPerfUrl, MONEY_FIELDS, PHASE_TONE, pollInterval, positionLimit, quotingAgent, quotingBody, quotingMandates, refusalOf, stepKey, stepState, switchFacts, tableRows, TESTNET_CHECKS, testnetCheckKey, testnetNoteOk,
  type BreakerAction, type MandateRow, type MmBounds, type MmEvidence, type MmFills, type MmMode, type MmPerformance, type MmSwitch, type MmView, type NumField, type QuotingAgent, type QuotingApproval, type QuotingDraft, type Refusal, type SessionView, type StepGate,
} from '../mm';
import { Btn, Card, EmptyState, ErrorState, Fact, Field, Fold, Icon, inputCls, Notice, numFmt, Section, Seg, Sheet, SkeletonCard, SkeletonRows, Stat, StatGrid, Tag, Timeline, when } from '../ui';

// ------------------------------------------------------------------------------------------------------------------ small pieces
const usd = (x: string | number | null | undefined, locale: string): string => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? '—' : `${numFmt(Number(x), locale, 4)} USD`);
const bps = (x: string | null | undefined): string => (x === null || x === undefined ? '—' : `${x} bps`);
/** a negative figure is red; a positive one is never green (nothing here suggests a profit) */
const neg = (x: string | null | undefined): 'danger' | undefined => (isNegative(x) ? 'danger' : undefined);
const Mono = ({ children, testid }: { children: ReactNode; testid?: string }) => <span className="break-all font-mono text-[12.5px]" data-testid={testid}>{children}</span>;

/** The server's refusal, as it came: the code, then its sentence. */
export function RefusalNotice({ r }: { r: Refusal | null }) {
  if (!r) return null;
  return <div data-testid="mm-refusal" data-code={r.code}><Notice tone="danger"><span className="block font-mono text-[13px] font-semibold" data-testid="mm-refusal-code">{r.code}</span><span className="mt-1 block [overflow-wrap:anywhere]" data-testid="mm-refusal-message">{r.message}</span>
    {r.steps && <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12.5px]">{r.steps.filter((s) => !s.done && s.missing).map((s) => <li key={s.id}><span className="font-mono">{s.id}</span> — {s.missing}</li>)}</ul>}</Notice></div>;
}
export function SimulatedTag() { const t = useT(); return <Tag tone="info" icon="eye" testid="mm-simulated">{t('mmSimulated')}</Tag>; }
const ModeMark = ({ mode }: { mode: MmMode }) => { const t = useT(); return mode === 'paper' ? <SimulatedTag /> : <Tag tone="danger" icon="bolt" testid="mm-live-tag">{t('mmLiveTag')}</Tag>; };

/** the dead man's switch: armed until HH:MM:SS, and the day's triggers against the venue's 10 and the signer's stop at 8 */
export function SwitchLine({ sw }: { sw: MmSwitch | undefined | null }) {
  const t = useT(), f = switchFacts(sw);
  if (!f) return null;
  return <div data-testid="mm-switch" data-armed={String(f.armed)} className="space-y-1">
    <div className="flex flex-wrap items-center gap-2"><Tag tone={f.armed ? 'ok' : 'warn'} icon={f.armed ? 'check' : 'clock'}>{f.armed ? t('mmSwitchArmed', { time: f.until ?? '—' }) : t('mmSwitchNotArmed')}</Tag></div>
    <p className={`text-[12.5px] leading-snug ${f.atStop ? 'font-semibold text-danger' : 'text-mute'}`} data-testid="mm-switch-triggers">{t('mmSwitchTriggers', { n: f.used, of: f.of, stop: f.stopsAt })}</p></div>;
}

// ------------------------------------------------------------------------------------------------------------------ the session NOW
export function SessionNow({ s, tab }: { s: SessionView; tab: MmMode }) {
  const t = useT(); const { locale } = useContext(I18n);
  const st = s.status ?? {}, quotes = st.quotes ?? [], base = baseOf(s.instrument), phase = st.phase ?? s.state, b = s.budget ?? {}, refusals = Object.entries(s.refusals ?? {}), active = st.activeBreakers ?? [];
  return <div className="space-y-4" data-testid="mm-session" data-mode={s.mode} data-phase={phase} data-simulated={String(s.simulated)}>
    <div className="flex flex-wrap items-center gap-1.5"><Tag tone={PHASE_TONE[phase] ?? 'mute'} testid="mm-phase">{phase}</Tag><ModeMark mode={tab} />{st.halted ? <Tag tone="danger" icon="stop" testid="mm-halted">{t('mmHalted')}{typeof st.halted === 'string' ? ` · ${st.halted}` : ''}</Tag> : null}
      {st.manual && <Tag tone="warn">{t(st.manual === 'pull' ? 'mmManualPull' : 'mmManualFlatten')}</Tag>}{st.lock && <Tag tone="warn" icon="lock" testid="mm-session-lock">{st.lock}</Tag>}{s.stale && <Tag tone="danger" icon="clock" testid="mm-stale">{t('mmStale')}</Tag>}</div>
    <p className="text-[12.5px] leading-snug text-mute" data-testid="mm-session-label">{s.label} · {s.instrument} · {s.policy} · {t('mmSince', { at: when(new Date(s.startedAt), locale) })}</p>
    {st.reason && <Notice tone="warn"><span data-testid="mm-reason">{t('mmReason')} {st.reason}</span></Notice>}
    {typeof st.ending === 'string' && st.ending && <Notice tone="info">{t('mmEnding')} {st.ending}</Notice>}
    <StatGrid><Stat label={t('mmInventory', { base })} value={st.position ?? '—'} testid="mm-position" /><Stat label={t('mmInventoryUsd')} value={usd(st.positionUsd, locale)} testid="mm-position-usd" />
      <Stat label={t('mmMid')} value={st.mid ?? '—'} /><Stat label={t('mmResting')} value={String(quotes.length)} sub={(st.blockedSides ?? []).length ? t('mmBlocked', { sides: (st.blockedSides ?? []).join(', ') }) : undefined} /></StatGrid>

    <div><h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmQuotes')}</h3>
      {quotes.length === 0 ? <p className="text-[13.5px] text-mute" data-testid="mm-no-quotes">{t('mmNoQuotes')}</p> : <ul className="divide-y divide-line" data-testid="mm-quotes">{quotes.map((q) => <li key={q.clientId} className="py-2" data-testid="mm-quote" data-side={q.side}>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[14.5px] font-semibold">{t(q.side === 'buy' ? 'mmBid' : 'mmAsk')} · <span className="font-mono">{q.price}</span></span><Tag tone={q.state === 'resting' ? 'ok' : 'info'}>{q.state}</Tag></div>
        <div className="mt-0.5 text-[12.5px] text-mute">{t('mmQuoteLine', { size: q.size, base, age: ageText(q.ageMs), bps: q.distanceBps ?? '—' })}</div></li>)}</ul>}</div>

    <div data-testid="mm-breakers"><h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmBreakers')}</h3>
      <div className="flex flex-wrap items-center gap-1.5">{active.length === 0 ? <span className="text-[13.5px] text-mute">{t('mmNoBreaker')}</span> : active.map((c) => <Tag key={c} tone="warn" icon="stop">{c}</Tag>)}</div>
      {(s.breakers ?? []).length > 0 && <Fold summary={t('mmBreakerEvents', { n: s.breakers.length })} testid="mm-breaker-events"><ul className="divide-y divide-line">{s.breakers.slice(-30).reverse().map((e, k) => <li key={`${e.ts}-${e.code}-${k}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12.5px]">
        <span className="font-mono">{e.code}</span><span className="text-mute">{e.action} · {hmsUtc(e.ts)} UTC</span></li>)}</ul></Fold>}</div>

    {(tab === 'live' || st.switch?.deadline != null) && <div><h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmSwitch')}</h3><SwitchLine sw={st.switch} /></div>}

    <div data-testid="mm-refusals"><h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmRefusals')}</h3>
      {refusals.length === 0 ? <p className="text-[13.5px] text-mute">{t('mmNoRefusal')}</p> : <dl>{refusals.map(([code, n]) => <Fact key={code} k={<Mono>{code}</Mono>}>{String(n)}</Fact>)}</dl>}</div>

    <div data-testid="mm-budget"><h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmBudget')}</h3>
      <StatGrid cols={3}><Stat label={t('mmBudgetUsed')} value={`${b.usedLastMinute ?? '—'} / ${numFmt(b.limitPerMinute ?? 1200, locale)}`} /><Stat label={t('mmBudgetPeak')} value={String(b.peakPerMinute ?? '—')} />
        <Stat label={t('mmBudgetAddress')} value={b.address?.remaining === null || b.address?.remaining === undefined ? '—' : numFmt(b.address.remaining, locale)} sub={b.address ? t('mmBudgetSent', { orders: b.address.orders, cancels: b.address.cancels, heartbeats: b.address.heartbeats }) : undefined} /></StatGrid>
      <p className="mt-1.5 text-[12.5px] text-mute">{t('mmBudgetSplit', { rest: b.restWeight ?? 0, exchange: b.exchangeWeight ?? 0, signer: b.signerWeightEstimate ?? 0 })}</p></div>

    <div data-testid="mm-stream"><h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmStream')}</h3>
      {st.stream ? <dl><Fact k={t('mmStreamStatus')}>{typeof st.stream.status === 'string' ? st.stream.status : JSON.stringify(st.stream.status)} · {t(st.stream.synced ? 'mmStreamSynced' : 'mmStreamNotSynced')}</Fact>
        <Fact k={t('mmStreamCounts')}>{t('mmStreamLine', { orders: st.stream.streamOrders, fills: st.stream.streamFills, audits: st.stream.audits, div: st.stream.divergences, gaps: st.stream.gaps })}</Fact></dl>
        : <p className="text-[13.5px] text-mute">{t(tab === 'paper' ? 'mmStreamPaper' : 'mmStreamNone')}</p>}</div>

    <div data-testid="mm-session-pnl"><h3 className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmSessionPnl')}{tab === 'paper' && <SimulatedTag />}</h3>
      <StatGrid cols={3}><Stat label={t('mmPnlTotal')} value={usd(s.pnl?.totalUsd, locale)} tone={neg(s.pnl?.totalUsd)} /><Stat label={t('mmPnlFills')} value={String(s.pnl?.fills ?? 0)} /><Stat label={t('mmPnlVolume')} value={usd(s.pnl?.volumeUsd, locale)} /></StatGrid>
      {Object.keys(s.counters ?? {}).length > 0 && <Fold summary={t('mmCounters')}><dl>{Object.entries(s.counters).map(([k, v]) => <Fact key={k} k={<Mono>{k}</Mono>}>{String(v)}</Fact>)}</dl></Fold>}</div>
  </div>;
}

// ------------------------------------------------------------------------------------------------------------------ pull / flatten / resume
export function CommandBar({ view, tab, busy, confirming, note, refusal, on }: { view: Pick<MmView, 'mode' | 'session'>; tab: MmMode; busy: string; confirming: boolean; note: string; refusal: Refusal | null;
  on: { pull: () => void; flatten: () => void; confirm: () => void; cancel: () => void; resume: () => void } }) {
  const t = useT(), cs = commandState(view, tab);
  return <div className="space-y-2.5" data-testid="mm-commands">
    <div className="grid grid-cols-2 gap-2.5">
      <Btn kind="soft" busy={busy === 'pull'} disabled={!cs.pull} onClick={on.pull} data-testid="mm-pull">{t('mmPull')}</Btn>
      <Btn kind="danger" busy={busy === 'flatten'} disabled={!cs.flatten} onClick={on.flatten} data-testid="mm-flatten">{t('mmFlatten')}</Btn></div>
    {confirming && <Notice tone="warn"><span className="block">{t('mmFlattenConfirm')}</span><span className="mt-2 flex flex-wrap gap-2"><Btn kind="danger" busy={busy === 'flatten'} onClick={on.confirm} data-testid="mm-flatten-confirm">{t('mmFlattenYes')}</Btn><Btn kind="ghost" onClick={on.cancel}>{t('cancel')}</Btn></span></Notice>}
    <Btn kind="ghost" full busy={busy === 'resume'} disabled={!cs.resume} onClick={on.resume} data-testid="mm-resume">{t('mmResume')}</Btn>
    <p className="text-[12.5px] leading-snug text-mute" data-testid="mm-commands-note">{t('mmCommandsNote')}</p>
    {note && <Notice tone="info"><span data-testid="mm-command-result">{note}</span></Notice>}
    <RefusalNotice r={refusal} /></div>;
}
function Commands({ id, view, tab, onDone }: { id: string; view: MmView; tab: MmMode; onDone: () => void }) {
  const t = useT(); const [busy, setBusy] = useState(''), [confirming, setConfirming] = useState(false), [note, setNote] = useState(''), [refusal, setRefusal] = useState<Refusal | null>(null);
  const send = async (command: 'pull' | 'flatten' | 'resume') => { setBusy(command); setNote(''); setRefusal(null); setConfirming(false);
    try { const r = await post<{ taken: string; note?: string }>(`/mm/agents/${id}/command`, { command }); setNote(`${t(`mmTaken_${['engine', 'queued', 'direct', 'nothing'].includes(r.taken) ? r.taken : 'engine'}` as Key)}${r.note ? ` — ${r.note}` : ''}`); onDone(); }
    catch (e) { setRefusal(refusalOf(e)); } finally { setBusy(''); } };
  return <CommandBar view={view} tab={tab} busy={busy} confirming={confirming} note={note} refusal={refusal} on={{ pull: () => void send('pull'), flatten: () => setConfirming(true), confirm: () => void send('flatten'), cancel: () => setConfirming(false), resume: () => void send('resume') }} />;
}

// ------------------------------------------------------------------------------------------------------------------ fills, attribution, past sessions
export function FillsTable({ data }: { data: MmFills }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (data.fills.length === 0) return <p className="text-[13.5px] text-mute" data-testid="mm-no-fills">{t('mmNoFills')}</p>;
  return <div className="overflow-x-auto" data-testid="mm-fills" data-mode={data.mode} data-simulated={String(data.simulated)}><table className="w-full min-w-[520px] text-left text-[12.5px]">
    <thead><tr className="text-mute"><th className="py-1.5 pr-2 font-medium">{t('mmFillWhen')}</th><th className="py-1.5 pr-2 font-medium">{t('mmFillSide')}</th><th className="py-1.5 pr-2 font-medium">{t('mmFillPrice')}</th><th className="py-1.5 pr-2 font-medium">{t('mmFillSize')}</th><th className="py-1.5 pr-2 font-medium">{t('mmFillFee')}</th>
      {HORIZONS.map((h) => <th key={h} className="py-1.5 pr-2 font-medium">{t('mmMarkoutAt', { h })}</th>)}</tr></thead>
    <tbody className="divide-y divide-line">{data.fills.map((f) => <tr key={f.id} data-testid="mm-fill">
      <td className="py-1.5 pr-2 text-mute">{when(new Date(f.ts), locale)}</td><td className="py-1.5 pr-2">{t(f.side === 'buy' ? 'mmBuy' : 'mmSell')}{f.reduce ? ` · ${t('mmReduce')}` : ''}{f.maker ? '' : ` · ${t('mmTaker')}`}</td>
      <td className="py-1.5 pr-2 font-mono">{f.price}</td><td className="py-1.5 pr-2 font-mono">{f.size}</td><td className="py-1.5 pr-2 font-mono">{f.fee}</td>
      {HORIZONS.map((h) => { const c = markoutCell(f.markoutsBps?.[h], f.markoutsDone); return <td key={h} className={`py-1.5 pr-2 font-mono ${c.kind === 'value' && isNegative(c.text) ? 'text-danger' : c.kind === 'value' ? '' : 'text-mute'}`} data-markout={c.kind}>{c.kind === 'pending' ? t('mmPending') : c.text}</td>; })}</tr>)}</tbody></table></div>;
}
export function Attribution({ p }: { p: MmPerformance }) {
  const t = useT(); const { locale } = useContext(I18n), a = p.attribution;
  return <div className="space-y-3" data-testid="mm-attribution" data-mode={p.mode}>
    <p className="text-[12.5px] leading-snug text-mute" data-testid="mm-attribution-label">{p.label}</p>
    <StatGrid cols={3}><Stat label={t('mmPnlSpread')} value={usd(a.spreadCaptureUsd, locale)} tone={neg(a.spreadCaptureUsd)} /><Stat label={t('mmPnlInventory')} value={usd(a.inventoryPnlUsd, locale)} tone={neg(a.inventoryPnlUsd)} /><Stat label={t('mmPnlFees')} value={usd(a.feesUsd, locale)} tone={neg(a.feesUsd)} />
      <Stat label={t('mmPnlFunding')} value={usd(a.fundingUsd, locale)} tone={neg(a.fundingUsd)} /><Stat label={t('mmPnlTotal')} value={usd(a.totalUsd, locale)} tone={neg(a.totalUsd)} testid="mm-attribution-total" /><Stat label={t('mmPnlBps')} value={bps(a.bpsOfVolume)} tone={neg(a.bpsOfVolume)} /></StatGrid>
    <StatGrid cols={3}>{p.markouts.map((m) => <Stat key={m.horizon} label={t('mmMarkoutMean', { h: m.horizon })} value={bps(m.meanBps)} tone={neg(m.meanBps)} sub={t('mmMarkoutFills', { n: m.fills })} />)}</StatGrid>
    <p className="text-[12.5px] leading-snug text-mute">{t('mmAttributionLine', { sessions: p.sessions, fills: p.fills, volume: usd(p.volumeUsd, locale) })} {p.note}</p></div>;
}
export function PastSessions({ sessions, tab }: { sessions: SessionView[]; tab: MmMode }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (sessions.length === 0) return <p className="text-[13.5px] text-mute">{t('mmNoSessions')}</p>;
  return <ul className="divide-y divide-line" data-testid="mm-sessions" data-mode={tab}>{sessions.map((s) => <li key={s.id} className="py-2.5" data-testid="mm-past-session" data-state={s.state}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[14px] font-semibold">{when(new Date(s.startedAt), locale)}</span><span className="flex flex-wrap items-center gap-1.5"><Tag tone={s.state === 'running' ? 'ok' : s.state === 'abandoned' ? 'warn' : 'mute'}>{t(`mmState_${s.state}` as Key)}</Tag>{s.simulated && <SimulatedTag />}</span></div>
    <div className="mt-0.5 text-[12.5px] text-mute">{s.instrument} · {s.network} · {s.policy} · {t('mmPastLine', { total: usd(s.pnl?.totalUsd, locale), fills: s.pnl?.fills ?? 0, volume: usd(s.pnl?.volumeUsd, locale) })}</div>
    {s.endReason && <div className="mt-0.5 text-[12.5px] text-mute [overflow-wrap:anywhere]">{s.endedAt ? `${when(new Date(s.endedAt), locale)} · ` : ''}{s.endReason}</div>}</li>)}</ul>;
}

// ------------------------------------------------------------------------------------------------------------------ the evidence, as it is
/** The laboratory study and the simulation with every figure the server sends, unrounded, negative ones marked. */
export function EvidenceBlock({ ev }: { ev: MmEvidence }) {
  const t = useT(), e = ev.evidence;
  const figures = (o: Record<string, unknown>) => <dl>{flatFigures(o).map((f) => <Fact key={f.path} k={<Mono>{f.path}</Mono>}><span className={`font-mono text-[13px] ${isNegative(f.value) || /^between -/.test(f.value) ? 'font-semibold text-danger' : ''}`} data-figure={f.path}>{f.value}</span></Fact>)}</dl>;
  return <div className="space-y-3" data-testid="mm-evidence" data-version={e.version}>
    <div className="rounded-2xl bg-elev/60 p-3.5" data-testid="mm-evidence-lab"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[14px] font-semibold text-ink">{t('mmEvLab')}</span><Tag tone="danger" icon="x">{t('mmEvNegative')}</Tag></div>
      <p className="mt-1.5 font-semibold text-danger" data-testid="mm-evidence-lab-result">{e.lab.result}</p><p className="mt-1 text-[12.5px]">{e.lab.sample} · {e.lab.ranOn} · <span className="font-mono">{e.lab.source}</span></p>{figures(e.lab.figures)}</div>
    <div className="rounded-2xl bg-elev/60 p-3.5" data-testid="mm-evidence-sim"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[14px] font-semibold text-ink">{t('mmEvSim')}</span><Tag tone="danger" icon="x">{t('mmEvNegative')}</Tag></div>
      <p className="mt-1.5 font-semibold text-danger" data-testid="mm-evidence-sim-result">{e.simulation.result}</p><p className="mt-1 text-[12.5px] [overflow-wrap:anywhere]">{e.simulation.source}</p>{figures(e.simulation.figures)}</div>
    <p className="text-[12.5px] leading-snug" data-testid="mm-evidence-fees">{t('mmEvFees')} {e.fees}</p></div>;
}

// ------------------------------------------------------------------------------------------------------------------ the go-live checklist
export interface GoLiveState { busy: string; refusal: Refusal | null; refusalAt: string; evidenceChecked: boolean; jurisdictionChecked: boolean; note: string }
export interface GoLiveActions { check: (k: 'evidence' | 'jurisdiction', v: boolean) => void; note: (s: string) => void; ack: (step: 'evidence' | 'jurisdiction' | 'testnet') => void; form: (testnetOnly: boolean) => void; review: () => void; revoke: () => void; recover: () => void; start: () => void; stop: () => void }
const Check = ({ checked, onChange, children, testid, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testid: string; disabled?: boolean }) =>
  <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5"><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-[18px] w-[18px] shrink-0 accent-blue" data-testid={testid} /><span className="text-[14px] text-ink">{children}</span></label>;

/** The six steps, in order. Presentation only: what is done is `view.goLive.steps`; the forms of a step appear only when it is the step to act on. */
export function GoLiveList({ view, ev, bounds, st, on }: { view: MmView; ev: MmEvidence | null; bounds: MmBounds | null; st: GoLiveState; on: GoLiveActions }) {
  const t = useT(); const { locale } = useContext(I18n);
  const steps = checklist(view.goLive), by = (id: StepGate['id']) => steps.find((s) => s.id === id)!, m = view.mandate, net = view.goLive.network;
  const at = (x: unknown) => (typeof x === 'number' ? when(new Date(x), locale) : '—');
  const refusal = (where: string) => (st.refusalAt === where ? <RefusalNotice r={st.refusal} /> : null);
  const locked = (s: StepGate) => s.locked && <p className="text-[12.5px]" data-testid={`mm-step-locked-${s.id}`}>{t('mmStepLocked')}</p>;
  const missing = (s: StepGate) => !s.done && s.missing && <p className="[overflow-wrap:anywhere]" data-testid={`mm-step-missing-${s.id}`}>{t('mmMissing')} {s.missing}</p>;
  const body: Record<StepGate['id'], (s: StepGate) => ReactNode> = {
    paper: (s) => { const e = s.evidence as { requiredMinutes?: number; instrument?: string; session?: { id: string; minutes: number; fills: number; startedAt: number } | null }; return <>
      <p>{t('mmPaperNeed', { n: e.requiredMinutes ?? ev?.minPaperMinutes ?? 30, instrument: e.instrument ?? '' })}</p>
      {e.session ? <p className="text-ink" data-testid="mm-paper-evidence">{t('mmPaperSession', { minutes: e.session.minutes, fills: e.session.fills, at: at(e.session.startedAt) })} <SimulatedTag /></p> : <p data-testid="mm-paper-evidence">{t('mmPaperNone')}</p>}{missing(s)}</>; },
    evidence: (s) => { const e = s.evidence as { acknowledgedAt?: number | null; sha256?: string | null }; return <>
      <p>{t('mmEvLead')}</p>
      {ev ? <EvidenceBlock ev={ev} /> : <SkeletonRows n={3} />}
      {s.done ? <p className="text-ink" data-testid="mm-evidence-acked">{t('mmAckedAt', { at: at(e.acknowledgedAt) })} <Mono>{String(e.sha256 ?? '').slice(0, 16)}…</Mono></p>
        : s.actionable && ev ? <><Check checked={st.evidenceChecked} onChange={(v) => on.check('evidence', v)} testid="mm-evidence-check"><span data-testid="mm-evidence-statement">{ev.statement}</span></Check>
          <Btn full busy={st.busy === 'ack-evidence'} disabled={!st.evidenceChecked} onClick={() => on.ack('evidence')} data-testid="mm-evidence-ack">{t('mmAckRecord')}</Btn></> : <>{ev && <p className="rounded-2xl bg-elev/60 p-3 text-[13px]" data-testid="mm-evidence-statement">{ev.statement}</p>}{locked(s)}</>}{refusal('evidence')}</>; },
    jurisdiction: (s) => { const e = s.evidence as { acknowledgedAt?: number | null; sha256?: string | null }; return <>
      {ev ? <p className="whitespace-pre-wrap rounded-2xl bg-elev p-3 text-[13px] leading-relaxed text-ink" data-testid="mm-jurisdiction-text">{ev.jurisdiction.text}</p> : <SkeletonRows n={2} />}
      {ev && <p className="text-[12px]">{ev.jurisdiction.source} · {ev.jurisdiction.version} · <Mono>{ev.jurisdiction.sha256.slice(0, 16)}…</Mono></p>}
      {s.done ? <p className="text-ink" data-testid="mm-jurisdiction-acked">{t('mmAckedAt', { at: at(e.acknowledgedAt) })}</p>
        : s.actionable && ev ? <><Check checked={st.jurisdictionChecked} onChange={(v) => on.check('jurisdiction', v)} testid="mm-jurisdiction-check">{t('mmJurCheck')}</Check>
          <Btn full busy={st.busy === 'ack-jurisdiction'} disabled={!st.jurisdictionChecked} onClick={() => on.ack('jurisdiction')} data-testid="mm-jurisdiction-ack">{t('mmAckRecord')}</Btn></> : locked(s)}{refusal('jurisdiction')}</>; },
    testnet: (s) => { const e = s.evidence as { session?: { id: string; startedAt: number } | null; attestedAt?: number | null; note?: string | null }; return <>
      <p>{t('mmTnLead')}</p><p>{t('mmTnNeeds')}</p>
      <ol className="list-decimal space-y-1 pl-5" data-testid="mm-testnet-checks">{TESTNET_CHECKS.map((c) => <li key={c}>{t(testnetCheckKey(c))}</li>)}</ol>
      {e.session && <p className="text-ink" data-testid="mm-testnet-session">{t('mmTnSession', { at: at(e.session.startedAt) })}</p>}
      {e.note && <p className="text-ink [overflow-wrap:anywhere]" data-testid="mm-testnet-attested">{t('mmTnAttested', { at: at(e.attestedAt) })} {e.note}</p>}
      {s.skipped && <p data-testid="mm-testnet-skipped">{t('mmTnSkipped')}</p>}
      {s.actionable ? <><Btn kind="ghost" full onClick={() => on.form(true)} data-testid="mm-testnet-mandate">{t('mmTnMandate')}</Btn>
        <Field label={t('mmTnNote')} hint={t('mmTnNoteHint')}><textarea className={`${inputCls} min-h-[84px] resize-none`} maxLength={500} value={st.note} onChange={(x) => on.note(x.target.value)} data-testid="mm-testnet-note" /></Field>
        <Btn full busy={st.busy === 'ack-testnet'} disabled={!testnetNoteOk(st.note)} onClick={() => on.ack('testnet')} data-testid="mm-testnet-ack">{t('mmTnAttest')}</Btn></> : !s.done && locked(s)}{refusal('testnet')}</>; },
    mandate: (s) => <>
      <p>{t('mmMdLead')}</p>
      {m ? <dl data-testid="mm-mandate" data-state={m.state}><Fact k={t('mmMdState')}>{m.state} · {m.phase}{net ? ` · ${net}` : ''}</Fact><Fact k={t('mmMdExpires')}>{at(m.expiresAt)}</Fact>
        <Fact k={t('mmMdIntegrity')}>{m.integrity ? <span className="font-semibold text-danger" data-testid="mm-mandate-integrity">{m.integrity}</span> : t('mmMdIntegrityOk')}</Fact><Fact k={t('mmHashTrading')}><Mono>{m.hash}</Mono></Fact>
        {m.quoting && <Fact k={t('mmHashSection')}><Mono>{m.quoting.hash}</Mono></Fact>}</dl> : <p data-testid="mm-mandate-none">{t('mmMdNone')}</p>}
      {m?.quoting && <Fold summary={t('mmMdMaxima')} testid="mm-mandate-maxima"><dl>{Object.entries(m.quoting.maxima).map(([k, v]) => <Fact key={k} k={<Mono>{k}</Mono>}><Mono>{v}</Mono></Fact>)}</dl></Fold>}
      {missing(s)}
      {m && canApprove(m) && (s.actionable || s.done) && <Btn full busy={st.busy === 'review'} onClick={on.review} data-testid="mm-mandate-review">{t('mmMdReview')}</Btn>}
      {m && m.state === 'pending_signer' && <Btn kind="ghost" full busy={st.busy === 'recover'} onClick={on.recover} data-testid="mm-mandate-recover">{t('mmRecover')}</Btn>}
      {s.actionable && (!m || !canApprove(m)) && <Btn full onClick={() => on.form(false)} data-testid="mm-mandate-create">{t('mmMdCreate')}</Btn>}
      {m && canRevoke(m) && <Btn kind="ghost" full className="!text-danger" busy={st.busy === 'revoke'} onClick={on.revoke} data-testid="mm-mandate-revoke">{t('mmMdRevoke')}</Btn>}
      {locked(s)}{refusal('mandate')}</>,
    locks: (s) => { const e = s.evidence as { network?: string | null; code?: string | null; setting?: string | null }, nets = bounds ? (net ? [bounds.locks[net]] : [bounds.locks.mainnet, bounds.locks.testnet]) : []; return <>
      <p>{t('mmLkLead')}</p>
      {nets.map((n) => <div key={n.network} className="rounded-2xl bg-elev/60 p-3" data-testid={`mm-locks-${n.network}`} data-open={String(n.lock === null)}>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13.5px] font-semibold text-ink">{n.network}</span><Tag tone={n.lock ? 'warn' : 'ok'} icon={n.lock ? 'lock' : 'check'}>{t(n.lock ? 'mmLkClosed' : 'mmLkOpen')}</Tag></div>
        <ul className="mt-1.5 space-y-0.5">{n.consulted.map((c) => <li key={c} className="font-mono text-[12.5px]" data-testid="mm-lock-setting" data-closed={String(n.lock?.setting === c)}>{c}{n.lock?.setting === c ? ` — ${t('mmLkOff')}` : ''}</li>)}</ul>
        {n.lock && <p className="mt-1.5 [overflow-wrap:anywhere]"><span className="font-mono font-semibold text-danger" data-testid="mm-lock-code">{n.lock.code}</span> — <span data-testid="mm-lock-message">{n.lock.message}</span></p>}</div>)}
      {e.code && <p className="[overflow-wrap:anywhere]" data-testid="mm-step-lock"><span className="font-mono font-semibold text-danger">{e.code}</span>{e.setting ? ` · ${e.setting}` : ''}</p>}{missing(s)}
      {view.state === 'STOPPING' && <Notice tone="warn"><span data-testid="mm-stopping">{t('mmStopping')}</span></Notice>}
      <div className="grid grid-cols-2 gap-2.5"><Btn busy={st.busy === 'start'} disabled={!view.goLive.ready || view.state === 'LIVE' || view.state === 'STOPPING'} onClick={on.start} data-testid="mm-start-live">{t('mmStartLive')}</Btn>
        <Btn kind="danger" busy={st.busy === 'stop'} disabled={!(view.mode === 'LIVE' && view.state !== 'STOPPED')} onClick={on.stop} data-testid="mm-stop-live">{t('mmStopLive')}</Btn></div>
      {!view.goLive.ready && <p className="text-[12.5px]" data-testid="mm-start-blocked">{t('mmStartBlocked')}</p>}{refusal('locks')}</>; },
  };
  return <div data-testid="mm-golive" data-ready={String(view.goLive.ready)}><Timeline label={t('mmGoLive')} items={steps.map((s) => ({ key: s.id, state: stepState(s), testid: `mm-step-${s.id}`, node: <span className="text-[13px] font-semibold">{s.n}</span>, title: t(stepKey(s.id)),
    stateLabel: t(s.done ? 'mmStepDone' : s.skipped ? 'mmStepSkipped' : s.actionable ? 'mmStepNow' : 'mmStepWaiting'), children: <div data-step={s.id} data-done={String(s.done)} data-actionable={String(s.actionable)} className="space-y-2">{body[s.id](s)}</div> }))} /></div>;
}

function GoLive({ id, view, agent, onChanged }: { id: string; view: MmView; agent: QuotingAgent; onChanged: () => void }) {
  const { locale } = useContext(I18n); const qc = useQueryClient();
  const evq = useQuery({ queryKey: ['mm-evidence', locale], queryFn: () => get<MmEvidence>(mmEvidenceUrl(locale)), staleTime: 300_000 });
  const bq = useQuery({ queryKey: ['mm-bounds'], queryFn: () => get<MmBounds>('/mm/bounds'), staleTime: 30_000 });
  const [st, setSt] = useState<GoLiveState>({ busy: '', refusal: null, refusalAt: '', evidenceChecked: false, jurisdictionChecked: false, note: '' });
  const [form, setForm] = useState<null | { testnetOnly: boolean }>(null), [sheet, setSheet] = useState<QuotingApproval | null>(null);
  const done = () => { void qc.invalidateQueries({ queryKey: ['mm-agent', id] }); void qc.invalidateQueries({ queryKey: ['mm-bounds'] }); void qc.invalidateQueries({ queryKey: ['risk'] }); onChanged(); };
  const run = async (busy: string, where: string, fn: () => Promise<unknown>) => { setSt((s) => ({ ...s, busy, refusal: null, refusalAt: '' }));
    try { await fn(); done(); } catch (e) { setSt((s) => ({ ...s, refusal: refusalOf(e), refusalAt: where })); } finally { setSt((s) => ({ ...s, busy: '' })); } };
  const review = (mandateId: string) => run('review', 'mandate', async () => { setSheet(await post<QuotingApproval>(`/mandates/${mandateId}/approve/prepare`, { locale })); });
  const on: GoLiveActions = {
    check: (k, v) => setSt((s) => ({ ...s, [k === 'evidence' ? 'evidenceChecked' : 'jurisdictionChecked']: v })), note: (note) => setSt((s) => ({ ...s, note })),
    ack: (step) => void run(`ack-${step}`, step, () => post(`/mm/agents/${id}/golive/ack`, { step, locale, acknowledged: true, ...(step === 'testnet' ? { note: st.note.trim() } : {}) })),
    form: (testnetOnly) => setForm({ testnetOnly }), review: () => { if (view.mandate) void review(view.mandate.id); },
    revoke: () => { if (view.mandate) void run('revoke', 'mandate', () => post(`/mandates/${view.mandate!.id}/revoke`, {})); }, recover: () => void run('recover', 'mandate', () => post('/mm/recover', {})),
    start: () => void run('start', 'locks', () => post(`/agents/${id}/start`, { mode: 'live' })), stop: () => void run('stop', 'locks', () => post(`/agents/${id}/stop`, {})),
  };
  return <>
    <GoLiveList view={view} ev={evq.data ?? null} bounds={bq.data ?? null} st={st} on={on} />
    {form && bq.data && <QuotingMandateForm agent={agent} bounds={bq.data} testnetOnly={form.testnetOnly} onClose={() => setForm(null)} onCreated={(mid) => { setForm(null); done(); void review(mid); }} />}
    {sheet && <QuotingApprovalSheet sheet={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); done(); }} />}
  </>;
}

// ------------------------------------------------------------------------------------------------------------------ the quoting mandate form
interface LiveAccount { id: string; venue: string; network: string; label?: string; account?: string; authorization: { active?: boolean; expiresAt?: number } | null }
/** The numeric fields, group by group; EACH shows its compiled bound, and the bound again in red when the typed value is outside it. */
export function QuotingFields({ d, bounds, agent, onChange }: { d: QuotingDraft; bounds: MmBounds; agent: QuotingAgent; onChange: (d: QuotingDraft) => void }) {
  const t = useT(), problems = new Map(draftProblems(d, bounds, agent).map((p) => [p.field, p.bound]));
  const set = (k: NumField, v: string) => onChange({ ...d, [k]: (MONEY_FIELDS as readonly string[]).includes(k) ? cleanDec(v) : cleanInt(v) });
  return <>{GROUPS.map((g) => <fieldset key={g} className="space-y-3" data-testid={`mm-form-group-${g}`}><legend className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t(groupKey(g))}</legend>
    {FIELDS.filter((f) => f.group === g).map((f) => { const bound = boundText(f, bounds, d, agent), bad = problems.has(f.key); return <Field key={f.key} label={`${t(fieldKey(f.key))}${f.unit ? ` (${f.unit})` : ''}`}>
      <input className={inputCls} inputMode={(MONEY_FIELDS as readonly string[]).includes(f.key) ? 'decimal' : 'numeric'} autoComplete="off" value={d[f.key]} aria-invalid={bad} onChange={(e) => set(f.key, e.target.value)} data-testid={`mm-f-${f.key}`} />
      <span className={`mt-1.5 block text-[12.5px] ${bad ? 'font-semibold text-danger' : 'text-mute'}`} data-testid={`mm-max-${f.key}`} data-bad={String(bad)}>{t('mmBound')} <span className="font-mono">{bad ? problems.get(f.key) || bound : bound}</span></span></Field>; })}</fieldset>)}</>;
}
export function QuotingMandateForm({ agent, bounds, testnetOnly, onClose, onCreated }: { agent: QuotingAgent; bounds: MmBounds; testnetOnly: boolean; onClose: () => void; onCreated: (mandateId: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const aq = useQuery({ queryKey: ['risk', 'live-accounts'], queryFn: () => get<{ accounts: LiveAccount[] }>('/derivatives/live/accounts') });
  const [d, setD] = useState<QuotingDraft>(() => emptyQuotingDraft(agent, bounds)), [busy, setBusy] = useState(false), [refusal, setRefusal] = useState<Refusal | null>(null);
  const accounts = (aq.data?.accounts ?? []).filter((a) => a.venue === 'hyperliquid' && a.authorization && (!testnetOnly || a.network === 'testnet'));
  const acc = accounts.find((a) => a.id === d.accountId) ?? null, lock = acc ? bounds.locks[acc.network === 'testnet' ? 'testnet' : 'mainnet'] : null;
  const problems = draftProblems(d, bounds, agent), pos = positionLimit(d, agent);
  const create = async () => { setBusy(true); setRefusal(null);
    try { const r = await post<{ mandate: { id: string } }>('/mandates', quotingBody(d, agent, locale)); onCreated(r.mandate.id); } catch (e) { setRefusal(refusalOf(e)); } finally { setBusy(false); } };
  return <Sheet title={t(testnetOnly ? 'mmFormTitleTestnet' : 'mmFormTitle')} sub={agent.instrument} onClose={onClose} busy={busy} wide testid="mm-form"
    footer={<Btn full busy={busy} disabled={problems.length > 0} onClick={() => void create()} data-testid="mm-form-create">{t('mmFormCreate')}</Btn>}>
    <div className="space-y-4">
      <Notice tone="warn">{t('mmFormLead')}</Notice>
      <Field label={t('mmFormAccount')} hint={aq.isLoading ? undefined : accounts.length === 0 ? <span data-testid="mm-form-no-account">{t(testnetOnly ? 'mmFormNoTestnet' : 'mmFormNoAccount')}</span> : undefined}>
        <select className={inputCls} value={d.accountId} onChange={(e) => setD({ ...d, accountId: e.target.value })} data-testid="mm-form-account"><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label || a.venue} · {a.venue} {a.network}</option>)}</select></Field>
      {lock?.lock && <div data-testid="mm-form-lock" data-code={lock.lock.code}><Notice tone="warn"><span className="block font-mono text-[13px] font-semibold">{lock.lock.code}</span><span className="mt-1 block [overflow-wrap:anywhere]">{lock.lock.message}</span><span className="mt-1 block text-[12.5px]">{t('mmFormLockNote')}</span></Notice></div>}
      <dl data-testid="mm-form-fixed"><Fact k={t('mmFormInstrument')}><Mono>{agent.instrument}</Mono></Fact><Fact k={t('mmFormPolicy')}><Mono>{agent.policy}</Mono></Fact>
        <Fact k={t('mmFormQuoteSize')}><Mono>{agent.quoteSizeUsd} USD</Mono><span className="mt-0.5 block text-[12.5px] text-mute" data-testid="mm-max-quoteSizeUsd">{t('mmBound')} <span className="font-mono">{bounds.section.minQuoteSizeUsd}…{bounds.signer.maxQuoteNotional}</span> · {t('mmFormFromConfig')}</span></Fact>
        <Fact k={t('mmFormPosition')}><Mono testid="mm-form-position">{pos ?? '—'} USD</Mono><span className="mt-0.5 block text-[12.5px] text-mute" data-testid="mm-max-maxPositionNotionalUsd">{t('mmBound')} <span className="font-mono">≤ {bounds.signer.maxInventoryNotional}</span> · {t('mmFormPositionNote')}</span></Fact></dl>
      <Field label={t('mmFormLabel')}><input className={inputCls} maxLength={60} value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} data-testid="mm-f-label" /></Field>
      <QuotingFields d={d} bounds={bounds} agent={agent} onChange={setD} />
      <fieldset className="space-y-3"><legend className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmFormHours')}</legend>
        <p className="text-[12.5px] leading-snug text-mute">{t('mmFormHoursNote')}</p>
        <div className="grid grid-cols-2 gap-2.5"><Field label={t('mmFormHoursStart')}><input className={inputCls} placeholder="HH:MM" inputMode="numeric" maxLength={5} value={d.hoursStart} onChange={(e) => setD({ ...d, hoursStart: e.target.value.replace(/[^0-9:]/g, '') })} data-testid="mm-f-hoursStart" /></Field>
          <Field label={t('mmFormHoursEnd')}><input className={inputCls} placeholder="HH:MM" inputMode="numeric" maxLength={5} value={d.hoursEnd} onChange={(e) => setD({ ...d, hoursEnd: e.target.value.replace(/[^0-9:]/g, '') })} data-testid="mm-f-hoursEnd" /></Field></div></fieldset>
      <fieldset className="space-y-3" data-testid="mm-form-breakers"><legend className="text-[13px] font-semibold uppercase tracking-wide text-mute">{t('mmFormBreakers')}</legend>
        <p className="text-[12.5px] leading-snug text-mute">{t('mmFormBreakersNote')}</p>
        {bounds.breakers.map((x) => <Field key={x.code} label={x.code} hint={x.alwaysStops ? t('mmFormAlwaysStops') : undefined}>
          <select className={inputCls} value={d.breakers[x.code] ?? x.default} onChange={(e) => setD({ ...d, breakers: { ...d.breakers, [x.code]: e.target.value as BreakerAction } })} data-testid={`mm-f-breaker-${x.code}`}>{breakerChoices(x).map((a) => <option key={a} value={a}>{t(`mmAct_${a}` as Key)}</option>)}</select></Field>)}</fieldset>
      <Check checked={d.flattenOnStop} onChange={(v) => setD({ ...d, flattenOnStop: v })} testid="mm-f-flattenOnStop">{t('mmFormFlattenOnStop')}</Check>
      {problems.length > 0 && <p className="text-[12.5px] leading-snug text-mute" data-testid="mm-form-problems">{t('mmFormTodo')} <span className="font-mono">{problems.map((p) => p.field).join(', ')}</span></p>}
      <RefusalNotice r={refusal} />
    </div></Sheet>;
}

// ------------------------------------------------------------------------------------------------------------------ the approval sheet
/** What the owner reads BEFORE any passkey prompt: the enforced-by table row by row, the four hashes, the acknowledgement. */
export function ApprovalBody({ sheet }: { sheet: QuotingApproval }) {
  const t = useT(), rows = tableRows(sheet.quoting.table), h = sheet.hashes;
  return <div className="space-y-3">
    <Notice tone="warn">{sheet.note}</Notice>
    <h3 className="text-[14px] font-semibold">{t('mmApHashes')}</h3>
    <dl data-testid="mm-approval-hashes"><Fact k={t('mmHashTrading')}><Mono testid="mm-hash-trading">{h.tradingMandate}</Mono></Fact><Fact k={t('mmHashSection')}><Mono testid="mm-hash-section">{h.quotingSection}</Mono></Fact>
      <Fact k={t('mmHashSigner')}><Mono testid="mm-hash-signer">{h.signerMandate}</Mono></Fact><Fact k={t('mmHashIntent')}><Mono testid="mm-hash-intent">{h.approvalIntent}</Mono></Fact></dl>
    <h3 className="text-[14px] font-semibold">{t('mmApTable')}</h3>
    <p className="text-[12.5px] leading-snug text-mute">{t('mmApTableNote')}</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-[12.5px]" data-testid="mm-approval-table"><tbody className="divide-y divide-line">{rows.map((r, k) => <tr key={k} data-testid="mm-approval-row" data-header={String(r.header)}>
      {r.cells.map((c, j) => (r.header ? <th key={j} className="py-1.5 pr-3 align-top font-semibold">{c}</th> : <td key={j} className={`py-1.5 pr-3 align-top [overflow-wrap:anywhere] ${j === 0 ? 'font-mono' : ''}`}>{c}</td>))}</tr>)}</tbody></table></div>
    <Fold summary={t('mmMdMaxima')}><dl>{Object.entries(sheet.quoting.maxima).map(([k, v]) => <Fact key={k} k={<Mono>{k}</Mono>}><Mono>{v}</Mono></Fact>)}</dl></Fold>
    {sheet.signer.exclusivity && <p className="text-[12.5px] leading-snug text-mute">{sheet.signer.exclusivity}</p>}
    <h3 className="text-[14px] font-semibold">{t('mmApAck')}</h3>
    <p className="whitespace-pre-wrap rounded-2xl bg-elev p-3 text-[13px] leading-relaxed" data-testid="mm-approval-ack-text">{sheet.signer.acknowledgement.text}</p></div>;
}
export function QuotingApprovalSheet({ sheet, onClose, onDone }: { sheet: QuotingApproval; onClose: () => void; onDone: () => void }) {
  const t = useT(); const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [step, setStep] = useState(0), [refusal, setRefusal] = useState<Refusal | null>(null), [recovered, setRecovered] = useState('');
  const ap = useApprovalOutcome<{ id: string; state: string }>(); const pending = (s: string) => s === 'created' || s === 'pending_signer', readMandate = async () => { const m = (await get<{ mandates: { id: string; state: string }[] }>('/mandates')).mandates.find((x) => x.id === sheet.mandateId); if (!m) throw new Error('mandate not listed'); return m; };
  // a refusal ends this sheet's approval: the button is gone, and a new approval starts from a new preparation
  const approve = async () => { setBusy(true); setRefusal(null);
    try {
      setStep(1); const assertion = await startAuthentication({ optionsJSON: sheet.signer.options as never });            // 1 — the isolated signer: the quoting mandate
      setStep(2); const bindingAssertion = await startAuthentication({ optionsJSON: sheet.binding.options as never });   // 2 — the API: the full hash, the section hash, the signer mandate hash
      // NEXT W1: a lost answer is settled by the mandate read from the server (is it still awaiting its approval?)
      await ap.send<unknown>({ submit: () => post(`/mandates/${sheet.mandateId}/approve`, { assertion, bindingAssertion, acknowledged: true }), read: readMandate, applied: (m) => !pending(m.state), late: onDone }); onDone();
    } catch (e) { if (!inDoubt(e)) setRefusal(refusalOf(e)); } finally { setBusy(false); setStep(0); } };
  const recover = async () => { setBusy(true);
    try { const r = await post<{ adopted: string[]; revoked: string[]; pending: string[] }>('/mm/recover', {}); setRecovered(t('mmRecovered', { adopted: r.adopted.length, revoked: r.revoked.length, pending: r.pending.length })); if (r.adopted.includes(sheet.mandateId)) onDone(); }
    catch (e) { setRefusal(refusalOf(e)); } finally { setBusy(false); } };
  return <Sheet title={t('mmApTitle')} sub={String(sheet.mandate.label ?? '')} onClose={onClose} busy={busy || ap.locked} wide testid="mm-approval"
    footer={refusal ? (refusal.code === 'quoting_approval_unknown' ? <Btn full busy={busy} onClick={() => void recover()} data-testid="mm-approval-recover">{t('mmRecover')}</Btn> : <Btn kind="ghost" full onClick={onClose}>{t('mmApClose')}</Btn>)
      : <Btn full busy={busy} disabled={!ack || ap.locked} onClick={() => void approve()} data-testid="mm-approval-approve"><Icon n="key" className="h-4 w-4" />{step ? t('mmApStep', { n: step }) : t('mmApApprove')}</Btn>}>
    <div className="space-y-3"><ApprovalBody sheet={sheet} />
      <Check checked={ack} onChange={setAck} testid="mm-approval-ack" disabled={!!refusal}>{t('mmApAckCheck')}</Check>
      <ApprovalOutcomePanel ap={ap} /><RefusalNotice r={refusal} />{recovered && <Notice tone="info"><span data-testid="mm-recovered">{recovered}</span></Notice>}</div></Sheet>;
}

// ------------------------------------------------------------------------------------------------------------------ the section of the agent page
/** true while the element is on screen and the page is visible: the 2 s poll runs only then */
function useOnScreen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null); const [seen, setSeen] = useState(true), [shown, setShown] = useState(typeof document === 'undefined' ? true : document.visibilityState !== 'hidden');
  useEffect(() => {
    const vis = () => setShown(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', vis);
    const io = typeof IntersectionObserver === 'undefined' || !ref.current ? null : new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { rootMargin: '200px' });
    if (io && ref.current) io.observe(ref.current);
    return () => { document.removeEventListener('visibilitychange', vis); io?.disconnect(); };
  }, []);
  return [ref, seen && shown];
}
const tabFromUrl = (): MmMode | null => (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mm') === 'live' ? 'live' : null);

export function MmSection({ id, agent, focus = 0, onChanged }: { id: string; agent: { strategySha256: string; capitalUsd: string; mode: string }; /** bumped by the page to open the live tab on the checklist */ focus?: number; onChanged: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const [tab, setTab] = useState<MmMode>(() => tabFromUrl() ?? (agent.mode === 'live' ? 'live' : 'paper'));
  const [ref, visible] = useOnScreen<HTMLDivElement>(); const flow = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (focus > 0) { setTab('live'); setTimeout(() => flow.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 60); } }, [focus]);
  // ONE mode per request: the key and the URL carry the tab; switching tab is another query, never a merge
  const q = useQuery({ queryKey: ['mm-agent', id, tab], queryFn: () => get<MmView>(mmAgentUrl(id, tab)), refetchInterval: pollInterval(visible), refetchIntervalInBackground: false });
  const fq = useQuery({ queryKey: ['mm-fills', id, tab], queryFn: () => get<MmFills>(mmFillsUrl(id, tab)), refetchInterval: visible ? 10_000 : false });
  const pq = useQuery({ queryKey: ['mm-perf', id, tab], queryFn: () => get<MmPerformance>(mmPerfUrl(id, tab)), refetchInterval: visible ? 15_000 : false });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['mm-agent', id] }); onChanged(); };
  const v = q.data;
  return <div ref={ref} className="space-y-4" data-testid="mm-section" data-mode={tab} data-polling={String(visible)}>
    <Section title={t('mmTitle')} right={<ModeMark mode={tab} />}>
      <Seg<MmMode> value={tab} onChange={setTab} label={t('mmTitle')} options={[['paper', t('mmTabPaper')], ['live', t('mmTabLive')]] as const} />
      <div className="mt-3 space-y-4" key={tab}>
        {tab === 'paper' ? <Notice tone="info"><span data-testid="mm-paper-note">{t('mmPaperNote')}</span></Notice> : <Notice tone="warn"><span data-testid="mm-live-note">{t('mmLiveNote')}</span></Notice>}
        {q.isLoading ? <SkeletonCard lines={5} /> : q.isError || !v ? <ErrorState title={t('mmLoadErr')} onRetry={() => void q.refetch()}>{(() => { const r = refusalOf(q.error); return r ? `${r.code} — ${r.message}` : ''; })()}</ErrorState> : <>
          <Card className="space-y-4">{v.session ? <SessionNow s={v.session} tab={tab} /> : <EmptyState icon="chart" title={t('mmNoSession')}>{t(tab === 'paper' ? 'mmNoSessionPaper' : 'mmNoSessionLive')}</EmptyState>}
            <Commands id={id} view={v} tab={tab} onDone={refresh} /></Card>
          {tab === 'live' && <div ref={flow}><Section title={t('mmGoLive')}><Card><GoLive id={id} view={v} agent={quotingAgent(v, agent)} onChanged={refresh} /></Card></Section></div>}
          <Section title={t('mmFills')} right={<ModeMark mode={tab} />}><Card>{fq.isLoading ? <SkeletonRows n={3} /> : fq.data ? <FillsTable data={fq.data} /> : <ErrorState title={t('mmLoadErr')} onRetry={() => void fq.refetch()} />}</Card></Section>
          <Section title={t('mmAttribution')} right={<ModeMark mode={tab} />}><Card>{pq.isLoading ? <SkeletonRows n={3} /> : pq.data ? <Attribution p={pq.data} /> : <ErrorState title={t('mmLoadErr')} onRetry={() => void pq.refetch()} />}</Card></Section>
          <Section title={t('mmSessions')} right={<ModeMark mode={tab} />}><Card><PastSessions sessions={v.sessions} tab={tab} /></Card></Section>
        </>}
      </div>
    </Section>
  </div>;
}

// ------------------------------------------------------------------------------------------------------------------ Risk: quoting mandates
/** The quoting mandates of the wallet, in the Risk screen: state, expiry, integrity, revoke, approval (the quoting sheet), and the way to the agent's go-live flow. */
export function QuotingMandatesBlock({ mandates, onChanged }: { mandates: readonly MandateRow[]; onChanged: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const rows = quotingMandates(mandates), focus = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mandate');
  const [busy, setBusy] = useState(''), [refusal, setRefusal] = useState<Refusal | null>(null), [sheet, setSheet] = useState<QuotingApproval | null>(null), [note, setNote] = useState('');
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setRefusal(null); setNote(''); try { await fn(); onChanged(); } catch (e) { setRefusal(refusalOf(e)); } finally { setBusy(''); } };
  return <Section title={t('mmRkTitle')}><Card className="space-y-3"><div data-testid="mm-risk-block" className="space-y-3">
    <p className="text-[13px] leading-snug text-mute">{t('mmRkLead')}</p>
    {rows.length === 0 ? <p className="text-[13.5px] text-mute" data-testid="mm-risk-none">{t('mmRkNone')}</p> : <ul className="divide-y divide-line">{rows.map((m) => { const until = m.notAfter ?? (m.mandate?.notAfter ? m.mandate.notAfter * 1000 : null); return <li key={m.id} className="space-y-2 py-3" data-testid={`mm-risk-mandate-${m.id}`} data-focus={String(focus === m.id)} data-state={m.state}>
      <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words text-[15px] font-semibold">{m.label}</h3><p className="break-all font-mono text-[12px] text-mute">{m.principal.kind}:{m.principal.id}</p></div><Tag tone={m.phase === 'active' ? 'ok' : m.phase === 'wind_down' ? 'warn' : canApprove(m) ? 'info' : 'mute'}>{m.state} · {m.phase}</Tag></div>
      <dl><Fact k={t('mmMdExpires')}>{until ? when(new Date(until), locale) : '—'}</Fact><Fact k={t('mmMdIntegrity')}>{m.integrity ? (m.integrity.ok ? t('mmMdIntegrityOk') : <span className="font-semibold text-danger">{m.integrity.reason}</span>) : t('mmRkNotApproved')}</Fact></dl>
      <div className="grid grid-cols-2 gap-2.5"><a className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-line px-4 text-[14.5px] font-semibold" href={goLivePath(m.principal.id)} data-testid={`mm-risk-golive-${m.id}`}>{t('mmRkOpen')}</a>
        {canRevoke(m) && <Btn kind="ghost" className="!text-danger" busy={busy === `rev-${m.id}`} onClick={() => void run(`rev-${m.id}`, () => post(`/mandates/${m.id}/revoke`, {}))} data-testid={`mm-risk-revoke-${m.id}`}><Icon n="stop" className="h-4 w-4" />{t('mmMdRevoke')}</Btn>}
        {canApprove(m) && <Btn busy={busy === `prep-${m.id}`} onClick={() => void run(`prep-${m.id}`, async () => { setSheet(await post<QuotingApproval>(`/mandates/${m.id}/approve/prepare`, { locale })); })} data-testid={`mm-risk-review-${m.id}`}>{t('mmMdReview')}</Btn>}
        {m.state === 'pending_signer' && <Btn kind="ghost" busy={busy === `rec-${m.id}`} onClick={() => void run(`rec-${m.id}`, async () => { const r = await post<{ adopted: string[]; revoked: string[]; pending: string[] }>('/mm/recover', {}); setNote(t('mmRecovered', { adopted: r.adopted.length, revoked: r.revoked.length, pending: r.pending.length })); })}>{t('mmRecover')}</Btn>}</div></li>; })}</ul>}
    {note && <Notice tone="info">{note}</Notice>}<RefusalNotice r={refusal} /></div></Card>
    {sheet && <QuotingApprovalSheet sheet={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); onChanged(); }} />}</Section>;
}

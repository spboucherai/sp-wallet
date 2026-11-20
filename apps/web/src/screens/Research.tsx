// V7 research runtime — the owner's side of autonomous research jobs: describe a mission in plain language, set budgets,
// watch the job's log, read the submission. The screen keeps two things apart everywhere: what the AI agent WROTE (its
// hypothesis, its notes, the numbers it claims) and what THIS SERVER MEASURED on data the job never had. Only the second
// one can be approved. Every string is in the `rj` block of i18n.ts (v10 design strings: `dzRj…`).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { errText, I18n, useT, type Key } from '../i18n';
import { AssetIcon, Btn, Card, ErrorState, Field, Fold, H, Icon, inputCls, Notice, PageTitle, Section, Skeleton, SkeletonCard, Stat, Tag, when, type Tone } from '../ui';
import { srvText } from '../srvText'; // v11 interface (audit B3): a server sentence without a code is translated when known, quoted as English otherwise
import { amountLocale, amountOf, sanitizeAmountText } from '../amount'; // v8 hardening
import { AmountProblem } from '../amountUi';

interface Budgets { wallSeconds: number; maxTrials: number; maxDiskMb: number; maxModelTokens: number; maxModelUsd: number }
interface Usage { wallMs: number; trials: number; diskMb: number; modelTokens: number; modelRequests: number; modelUsd: number | null; ledgerTampered: boolean; sandbox: 'sandbox-exec' | 'none'; agent: string; labCommit: string | null }
interface JobV { id: string; agentId: string | null; kind: 'spot' | 'perp'; mission: string; universe: string[]; interval: string; capitalUsd: number; budgets: Budgets; state: string; reason: string | null; strategy: string;
  runnerId: string | null; cancelRequested: boolean; usage: Usage | null; versionId: string | null; createdAt: string; finishedAt: string | null; serverStatus?: string | null; trialsTotal?: number | null; deflatedSharpe?: number | null; claimsDiffer?: boolean | null }
type Nums = Partial<Record<'total_return' | 'sharpe' | 'max_drawdown' | 'trades', number | null>>;
interface Server { status: 'ok' | 'failed'; reason?: string; sha256?: string; sandbox?: string; holdout?: { testStart: string; testEnd: string; bars: number }; trials?: { job: number; server: number; total: number; ledgerTampered: boolean };
  deflatedSharpe?: number | null; sharpeCi?: [number | null, number | null] | null; metrics?: Record<'train' | 'validation' | 'test', Nums>; benchmark?: Nums; checks?: Record<string, unknown>; replication?: Record<string, Nums>;
  comparison?: { split: string; metric: string; claimed: number | null; measured: number | null; differs: boolean }[]; claimsDiffer?: boolean; claimsProblem?: string | null }
interface Detail extends JobV { holdout: { start: string; devEnd: string; end: string; devBars: number; testBars: number } | null; dataReady: boolean | null; dataError: string | null; agent: { id: string; name: string; state: string } | null;
  version: { id: string; status: string; notes: string } | null; submission: { sha256: string; path: string; files: Record<string, string>; claims: { summary?: string; trials?: number } | null; claimsProblem: string | null } | null; server: Server | null }
interface LogLine { id: number; ts: number; s: string; t: string }

const FINAL = ['submitted', 'failed', 'cancelled', 'over_budget'];
/** a job's state: icon + word (the colour only repeats it) */
const STATE: Record<string, [Tone, string]> = { submitted: ['ok', 'check'], failed: ['danger', 'x'], over_budget: ['warn', 'warn'], cancelled: ['mute', 'stop'], running: ['info', 'spin'], evaluating: ['info', 'clock'], preparing: ['info', 'clock'], queued: ['mute', 'clock'] };
export function JobState({ state }: { state: string }) {
  const t = useT(), [tone, icon] = STATE[state] ?? STATE.queued!;
  return <span data-testid="rj-state" data-state={state} data-tone={tone} className="tag shrink-0"><Icon n={icon} className="h-3 w-3" />{t(`rjS_${state}` as Key)}</span>;
}
const pct = (x: number | null | undefined) => (typeof x === 'number' ? `${(x * 100).toFixed(1)} %` : '—');
const num = (x: number | null | undefined, d = 2) => (typeof x === 'number' ? x.toFixed(d) : '—');
const fmt = (metric: string, x: number | null) => (x === null ? '—' : metric === 'sharpe' ? x.toFixed(2) : metric === 'trades' ? String(Math.round(x)) : `${(x * 100).toFixed(1)} %`);
const dur = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** the assets a job works on, as logo chips (an unknown symbol keeps its neutral letter disc) */
function Universe({ symbols, size = 22 }: { symbols: string[]; size?: number }) {
  return <span className="flex flex-wrap gap-1.5" data-testid="rj-universe">{symbols.map((s) => <span key={s} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-1 pr-2.5 text-[0.8125rem] font-medium"><AssetIcon sym={s} size={size} />{s}</span>)}</span>;
}
/** overlapping logos of a job's universe, for a list row */
function UniverseStack({ symbols }: { symbols: string[] }) {
  const shown = symbols.slice(0, 3);
  return <span className="flex shrink-0 items-center" aria-hidden="true">{shown.map((s, i) => <span key={s} className={i ? '-ml-2.5' : ''}><AssetIcon sym={s} size={32} /></span>)}{symbols.length > 3 && <span className="-ml-2.5 grid h-8 w-8 place-items-center rounded-full bg-elev text-[0.6875rem] font-semibold text-mute ring-2 ring-surface">+{symbols.length - 3}</span>}</span>;
}
/** an input with its unit written inside, on the right */
function Unit({ unit, children }: { unit: string; children: ReactNode }) {
  return <div className="relative">{children}<span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-[0.8125rem] text-mute">{unit}</span></div>;
}

/** The form: a mission in the owner's words and the budgets the runner enforces from outside the agent. */
export function ResearchForm({ agent, onCreated }: { agent?: { id: string; kind?: string; universe: string[]; interval: string }; onCreated: (id: string) => void }) {
  const t = useT();
  const [f, setF] = useState({ mission: '', kind: 'spot' as 'spot' | 'perp', symbols: 'BTC, ETH', interval: '1h', capital: '1000', minutes: 60, maxTrials: 200, tokensM: 5, usd: 10, diskMb: 512 });
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const universe = f.symbols.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const n = (k: 'minutes' | 'maxTrials' | 'tokensM' | 'usd' | 'diskMb', label: string, suffix: string, min: number, max: number) => <Field label={label}><Unit unit={suffix}>
    <input data-testid={`rj-budget-${k}`} className={`${inputCls} !pr-16 font-medium`} inputMode="decimal" value={String(f[k])} onChange={(e) => setF({ ...f, [k]: Math.max(0, Math.min(max, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)) })} onBlur={() => setF((x) => ({ ...x, [k]: Math.max(min, x[k]) }))} /></Unit></Field>;
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const j = await post<JobV>('/research/jobs', { mission: f.mission.trim(), ...(agent ? { agentId: agent.id, universe: agent.universe } : { kind: f.kind, universe, interval: f.interval }), capitalUsd: Number(amountOf(f.capital, amountLocale()) ?? '') || 1000,
        budgets: { wallSeconds: Math.round(f.minutes * 60), maxTrials: Math.round(f.maxTrials), maxDiskMb: Math.round(f.diskMb), maxModelTokens: Math.round(f.tokensM * 1_000_000), maxModelUsd: f.usd } });
      setF((x) => ({ ...x, mission: '' })); onCreated(j.id);
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-5" data-testid="rj-form">
      <Field label={t('rjMission')} hint={t('rjMissionHint')}><textarea data-testid="rj-mission" className={`${inputCls} min-h-[128px] resize-none text-[1rem] leading-snug`} maxLength={2000} value={f.mission} placeholder={t('rjMissionExample')} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
      {agent ? <div className="space-y-2"><Universe symbols={agent.universe} /><p className="text-[0.8125rem] text-mute">{t('rjForAgent', { assets: agent.universe.join(', '), interval: agent.interval, kind: agent.kind === 'perp' ? t('rjKindPerp') : t('rjKindSpot') })}</p></div> : <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><Field label={t('rjSymbols')} hint={t('rjSymbolsHint')}><input data-testid="rj-symbols" className={inputCls} autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={f.symbols} onChange={(e) => setF({ ...f, symbols: e.target.value })} /></Field>
          {universe.length > 0 && <div className="mt-2.5"><Universe symbols={universe} /></div>}</div>
        <Field label={t('rjKind')}><select data-testid="rj-kind" className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'spot' | 'perp' })}><option value="spot">{t('rjKindSpot')}</option><option value="perp">{t('rjKindPerp')}</option></select></Field>
        <Field label={t('rjInterval')}><select className={inputCls} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="1h">1 h</option>{f.kind === 'perp' ? <option value="4h">4 h</option> : <option value="1d">1 j / 1 d</option>}</select></Field></div>}
      <Field label={t('rjCapital')} hint={t('rjCapitalHint')}><Unit unit="USD"><input className={`${inputCls} !pr-16 font-medium`} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: sanitizeAmountText(e.target.value) })} /></Unit><AmountProblem text={f.capital} /></Field>
      <div><div className="t-eyebrow mb-2">{t('rjBudgets')}</div>
        <div className="grid grid-cols-2 gap-3">{n('minutes', t('rjBudgetTime'), 'min', 1, 1440)}{n('maxTrials', t('rjBudgetTrials'), t('rjTrialsUnit'), 1, 5000)}{n('tokensM', t('rjBudgetTokens'), 'M', 0.01, 500)}{n('usd', t('rjBudgetUsd'), 'USD', 0.05, 1000)}</div>
        <p className="mt-2.5 text-[0.78125rem] leading-snug text-mute">{t('rjBudgetsNote')}</p></div>
      <Notice tone="info">{t('rjFormNote')}</Notice>
      {err && <Notice tone="danger">{err}</Notice>}
      <Btn full busy={busy} data-testid="rj-create" disabled={f.mission.trim().length < 10 || (!agent && universe.length === 0) || (f.capital.trim() !== '' && amountOf(f.capital, amountLocale()) === null)} onClick={() => void create()}><Icon n="key" className="h-4 w-4" />{t('rjCreate')}</Btn>
    </div>
  );
}

/** The job's log, live while it runs (Server-Sent Events through the owner session), read once when it is finished. */
function JobLog({ id, live, onState }: { id: string; live: boolean; onState: () => void }) {
  const t = useT();
  const [lines, setLines] = useState<LogLine[]>([]), box = useRef<HTMLPreElement>(null), seen = useRef(0);
  useEffect(() => {
    let closed = false, es: EventSource | null = null;
    const add = (l: LogLine[]) => { const fresh = l.filter((x) => x.id > seen.current); if (!fresh.length) return; seen.current = fresh.at(-1)!.id; setLines((p) => [...p, ...fresh].slice(-1500)); };
    const load = () => get<{ lines: LogLine[] }>(`/research/jobs/${id}/log?after=${seen.current}&limit=1000`).then((r) => { if (!closed) add(r.lines); }).catch(() => {});
    void load().then(() => {
      if (closed || !live || typeof EventSource === 'undefined') return;
      es = new EventSource(`/api/v1/research/jobs/${id}/log/stream?after=${seen.current}`);
      es.addEventListener('log', (e) => { try { add([JSON.parse((e as MessageEvent).data) as LogLine]); } catch { /* not a line */ } });
      es.addEventListener('state', () => onState());
      es.addEventListener('end', () => { es?.close(); onState(); });
    });
    return () => { closed = true; es?.close(); };
  }, [id, live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [lines.length]);
  // a console: a title bar, then the lines in a block that scrolls inside itself (never the page)
  return <div className="overflow-hidden rounded-2xl border border-line bg-bg">
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line px-3.5 text-[0.75rem] font-medium text-mute"><span className="flex items-center gap-2"><Icon n="list" className="h-3.5 w-3.5" />{t('rjLog')}</span>
      {live ? <span className="inline-flex items-center gap-1.5 text-emerald"><span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald" aria-hidden="true" />{t('dzRjLive')}</span> : lines.length > 0 && <span>{t('dzRjLines', { n: lines.length })}</span>}</div>
    <pre ref={box} tabIndex={0} data-testid="rj-log" aria-label={t('rjLog')} className="max-h-72 min-h-[88px] overflow-auto overscroll-contain whitespace-pre-wrap break-words p-3.5 font-mono text-[0.71875rem] leading-[1.55]">
      {lines.length === 0 ? <span className="text-mute">{t('rjLogEmpty')}</span> : lines.map((l) => <span key={l.id} className={l.s === 'err' ? 'text-danger' : l.s === 'sys' || l.s === 'api' ? 'text-mute' : ''}>{l.s === 'api' ? '[api] ' : l.s === 'sys' ? '[runner] ' : ''}{l.t}{'\n'}</span>)}</pre></div>;
}

/** a titled panel of the job's story; `tone` marks whose words these are: the agent's (unverified) or the server's (measured) */
function Panel({ tone, tag, title, children, testid }: { tone: 'warn' | 'ok'; tag: string; title: string; children: ReactNode; testid: string }) {
  return <div className={`space-y-3 rounded-[20px] border p-4 ${tone === 'warn' ? 'border-warn/30 bg-warn/[0.045]' : 'border-emerald/35 bg-emerald/[0.045]'}`} data-testid={testid}>
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5"><Tag tone={tone} icon={tone === 'warn' ? 'warn' : 'check'}>{tag}</Tag><h3 className="text-[1rem] font-semibold tracking-[-0.015em]">{title}</h3></div>{children}</div>;
}
const proseCls = 'max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-2xl border border-line bg-surface p-3 text-[0.78125rem] leading-[1.5]';

/** One job: state, budgets used, log, and — for a submission — the agent's statements next to the server's measurements. */
export function ResearchJob({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['research-job', id], queryFn: () => get<Detail>(`/research/jobs/${id}`), refetchInterval: (x) => (x.state.data && FINAL.includes(x.state.data.state) ? false : 4000) });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<{ agents: { id: string; name: string; universe: string[]; interval: string; kind?: string }[] }>('/agents'), enabled: !!q.data && q.data.state === 'submitted' && !q.data.agentId });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [attached, setAttached] = useState('');
  if (q.isLoading || !q.data) return q.isError ? <Notice tone="danger">{errText(t, q.error)}</Notice> : <div className="space-y-3" aria-hidden="true"><div className="skel h-4 w-3/4 !rounded-md" /><div className="skel h-3 w-1/2 !rounded-md" /><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">{[0, 1, 2, 3].map((k) => <div key={k} className="skel h-[76px] !rounded-2xl" />)}</div><div className="skel h-40 !rounded-2xl" /></div>;
  const j = q.data, s = j.server, sub = j.submission, u = j.usage, live = !FINAL.includes(j.state);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['research-job', id] }); void qc.invalidateQueries({ queryKey: ['research-jobs'] }); if (j.agentId) void qc.invalidateQueries({ queryKey: ['agent', j.agentId] }); };
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); try { await fn(); refresh(); } catch (e) { setErr(errText(t, e)); } finally { setBusy(''); } };
  const fits = (agents.data?.agents ?? []).filter((a) => (a.kind ?? 'spot') === j.kind && a.interval === j.interval && [...a.universe].sort().join() === [...j.universe].sort().join());
  return (
    <div className="space-y-4" data-testid="rj-job" data-job={j.id}>
      {/* 1 · the mission and where the job stands */}
      <div className="space-y-2"><div className="flex"><JobState state={j.state} /></div>
        <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-snug">{j.mission}</p>
        <div className="break-words text-[0.78125rem] text-mute">{j.kind === 'perp' ? t('rjKindPerp') : t('rjKindSpot')} · {j.universe.join(' · ')} · {j.interval} · {when(j.createdAt, locale)}{j.agent ? ` · ${j.agent.name}` : ` · ${t('rjLibraryDraft')}`}</div></div>
      {j.reason && <Notice tone={j.state === 'cancelled' ? 'info' : 'warn'}>{srvText(t, locale, j.reason)}</Notice>}
      {j.dataError && <Notice tone="danger">{j.dataError}</Notice>}
      {/* 2 · the budgets, used / allowed */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-testid="rj-usage">
        <Stat label={t('rjBudgetTime')} value={u ? dur(u.wallMs) : '—'} sub={`/ ${dur(j.budgets.wallSeconds * 1000)}`} /><Stat label={t('rjBudgetTrials')} value={u ? String(u.trials) : '—'} sub={`/ ${j.budgets.maxTrials}`} />
        <Stat label={t('rjBudgetTokens')} value={u ? `${(u.modelTokens / 1e6).toFixed(2)} M` : '—'} sub={`/ ${(j.budgets.maxModelTokens / 1e6).toFixed(2)} M`} /><Stat label={t('rjBudgetUsd')} value={u?.modelUsd != null ? u.modelUsd.toFixed(2) : '—'} sub={`/ ${j.budgets.maxModelUsd}`} /></div>
      {j.holdout && <p className="flex gap-2 text-[0.78125rem] leading-snug text-mute" data-testid="rj-holdout"><Icon n="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{t('rjHoldout', { dev: j.holdout.devBars, test: j.holdout.testBars, from: when(j.holdout.devEnd, locale) })}</span></p>}
      {u && <p className="flex gap-2 text-[0.78125rem] leading-snug text-mute" data-testid="rj-isolation"><Icon n="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{u.sandbox === 'sandbox-exec' ? t('rjSandboxOn', { agent: u.agent }) : t('rjSandboxOff', { agent: u.agent })}{u.ledgerTampered ? ` ${t('rjTampered')}` : ''}</span></p>}
      {u && u.sandbox !== 'sandbox-exec' && <Notice tone="warn">{t('rjSandboxOffNote')}</Notice>}
      {/* 3 · the log */}
      <JobLog id={j.id} live={live} onState={refresh} />
      {live && j.state !== 'evaluating' && <Btn kind="ghost" full busy={busy === 'cancel'} disabled={j.cancelRequested} data-testid="rj-cancel" onClick={() => void act('cancel', () => post(`/research/jobs/${j.id}/cancel`))}><Icon n="stop" className="h-4 w-4" />{j.cancelRequested ? t('rjCancelling') : t('rjCancel')}</Btn>}
      {err && <Notice tone="danger">{err}</Notice>}

      {/* 4 · what the agent wrote — statements, not measurements */}
      {sub && <Panel tone="warn" tag={t('rjClaimedTag')} title={t('rjClaimedTitle')} testid="rj-claims">
        <p className="text-[0.78125rem] leading-snug text-mute">{t('rjClaimedNote')}</p>
        <pre className={proseCls} data-testid="rj-readme">{sub.files['README.md']}</pre>
        {sub.claims?.summary && <blockquote className="border-l-2 border-warn/60 pl-3 text-[0.84375rem] italic leading-snug" data-testid="rj-summary">{sub.claims.summary}</blockquote>}
        {sub.claimsProblem && <p className="flex gap-2 text-[0.78125rem] leading-snug text-warn"><Icon n="warn" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-words">{sub.claimsProblem}</span></p>}
        <div className="divide-y divide-line border-t border-line">
          {sub.files['NOTES.md'] && <Fold summary={t('rjNotes')}><pre className={`${proseCls} mb-2 text-[0.75rem]`}>{sub.files['NOTES.md']}</pre></Fold>}
          <Fold summary={t('rjCode')} testid="rj-code">
            <div className="break-all font-mono text-[0.6875rem] text-mute">sha256 {sub.sha256}</div>
            <pre className="mb-2 mt-2 max-h-80 overflow-auto overscroll-contain rounded-2xl border border-line bg-surface p-3 font-mono text-[0.71875rem] leading-[1.45]">{sub.files['strategy.py']}</pre></Fold></div>
      </Panel>}

      {/* 5 · what the server measured, and the agent's numbers next to the server's */}
      {s && s.status === 'failed' && <Notice tone="danger"><span data-testid="rj-refused">{t('rjRefused')} {srvText(t, locale, s.reason)}</span></Notice>}
      {s && s.status === 'ok' && <Panel tone="ok" tag={t('rjMeasuredTag')} title={t('rjMeasuredTitle')} testid="rj-measured">
        <p className="text-[0.78125rem] leading-snug text-mute">{t('rjMeasuredNote', { from: s.holdout ? when(s.holdout.testStart, locale) : '?', to: s.holdout ? when(s.holdout.testEnd, locale) : '?', bars: s.holdout?.bars ?? '?' })}</p>
        <div className="grid grid-cols-2 gap-2.5"><Stat label={t('agRet')} value={pct(s.metrics?.test.total_return)} sub={`${t('agVs')} ${pct(s.benchmark?.total_return)}`} /><Stat label={t('agDD')} value={pct(s.metrics?.test.max_drawdown)} sub={`${t('agVs')} ${pct(s.benchmark?.max_drawdown)}`} />
          <Stat label="Sharpe" value={num(s.metrics?.test.sharpe)} sub={s.sharpeCi ? `[${num(s.sharpeCi[0])} ; ${num(s.sharpeCi[1])}]` : undefined} />
          <Stat label={t('rjDsr')} value={num(s.deflatedSharpe, 3)} sub={typeof s.deflatedSharpe === 'number' && s.deflatedSharpe < 0.95 ? t('rjDsrLow') : t('rjDsrOk')} tone={typeof s.deflatedSharpe === 'number' && s.deflatedSharpe < 0.95 ? 'warn' : undefined} />
          <div className="col-span-2"><Stat label={t('rjTrials')} value={String(s.trials?.total ?? '—')} sub={t('rjTrialsSplit', { job: s.trials?.job ?? '?', server: s.trials?.server ?? '?' })} /></div></div>
        <p className="text-[0.78125rem] leading-snug text-mute">{t('rjSplits', { train: pct(s.metrics?.train.total_return), val: pct(s.metrics?.validation.total_return), test: pct(s.metrics?.test.total_return) })} {s.sharpeCi && (s.sharpeCi[0] ?? 0) <= 0 && (s.sharpeCi[1] ?? 0) >= 0 ? t('rjCiZero') : ''}</p>
        <p className="break-words text-[0.75rem] leading-snug text-mute">{t('rjChecks')}: {Object.entries(s.checks ?? {}).filter(([, v]) => v === 'pass' || v === 'fail').map(([k, v]) => `${k} ${v === 'pass' ? '✓' : '✗'}`).join(' · ')} · {s.sandbox === 'sandbox-exec' ? t('rjServerSandbox') : t('rjServerNoSandbox')}</p>
        <div className="space-y-2.5 border-t border-emerald/25 pt-3.5" data-testid="rj-compare"><h4 className="text-[0.875rem] font-semibold leading-snug">{t('rjCompareTitle')}</h4>
          {s.claimsDiffer ? <Notice tone="danger"><span className="font-semibold" data-testid="rj-differs">{t('rjDiffers')}</span></Notice> : <p className="flex gap-2 text-[0.8125rem] leading-snug text-mute" data-testid="rj-agrees"><Icon n="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald" /><span>{t('rjAgrees')}</span></p>}
          <div className="overflow-hidden rounded-2xl border border-line bg-surface"><table className="w-full text-[0.8125rem]"><thead><tr className="bg-elev/70 text-left text-xs text-mute"><th className="px-3 py-2 font-medium">{t('rjColSplit')}</th><th className="px-2 py-2 text-right font-medium">{t('rjColAgent')}</th><th className="px-3 py-2 text-right font-medium">{t('rjColServer')}</th></tr></thead>
            <tbody>{(s.comparison ?? []).filter((c) => c.metric !== 'trades').map((c) => <tr key={c.split + c.metric} className={`border-t border-line ${c.differs ? 'bg-danger/[0.07] font-semibold text-danger' : ''}`} data-differs={c.differs}>
              <td className="px-3 py-2">{t(`rjSplit_${c.split}` as Key)} · {c.metric === 'total_return' ? t('agRet') : c.metric === 'sharpe' ? 'Sharpe' : t('agDD')}</td><td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{fmt(c.metric, c.claimed)}</td><td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{fmt(c.metric, c.measured)}{c.differs ? ' ≠' : ''}</td></tr>)}</tbody></table></div>
          {sub?.claims?.trials !== undefined && <p className="text-[0.75rem] leading-snug text-mute">{t('rjTrialsClaim', { claimed: sub.claims.trials, counted: s.trials?.job ?? '?' })}</p>}</div>
      </Panel>}

      {/* 6 · the owner's decision: approving is an explicit action, nothing advances by itself */}
      {j.state === 'submitted' && s?.status === 'ok' && j.agent && j.version && <div className="space-y-3 rounded-[20px] border border-line bg-surface p-4" data-testid="rj-actions">
        <div className="t-eyebrow">{t('dzRjDecision')}</div>
        {j.version.status === 'draft' && <><Notice tone="info">{t('rjApproveNote')}</Notice>
          <Btn full busy={busy === 'approve'} data-testid="rj-approve" onClick={() => void act('approve', () => post(`/agents/${j.agent!.id}/strategies/${j.version!.id}/approve`))}><Icon n="check" className="h-4 w-4" />{t('rjApprove')}</Btn></>}
        {j.version.status === 'approved' && <><Notice tone="ok"><span data-testid="rj-approved">{t('rjApproved')}</span></Notice>
          {j.agent.state !== 'PAPER_TRADING' && j.agent.state !== 'LIVE' && <Btn full kind="soft" busy={busy === 'paper'} data-testid="rj-paper" onClick={() => void act('paper', () => post(`/agents/${j.agent!.id}/mode`, { mode: 'PAPER' }))}>{t('rjStartPaper')}</Btn>}
          {j.agent.state === 'PAPER_TRADING' && <p className="flex items-center gap-2 text-[0.84375rem] text-mute" data-testid="rj-paper-on"><span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-blue" aria-hidden="true" />{t('rjPaperOn')}</p>}</>}
        <Btn full kind="ghost" onClick={() => nav({ tab: 'agent', asset: j.agent!.id })}>{t('rjOpenAgent', { name: j.agent.name })}<Icon n="chev" className="h-4 w-4" /></Btn></div>}
      {j.state === 'submitted' && s?.status === 'ok' && !j.agentId && <div className="space-y-3 rounded-[20px] border border-line bg-surface p-4" data-testid="rj-attach">
        <div className="t-eyebrow">{t('rjAttachTitle')}</div>
        {attached ? <Notice tone="ok">{t('rjAttached')}</Notice> : fits.length === 0 ? <p className="text-[0.8125rem] leading-snug text-mute">{t('rjAttachNone', { assets: j.universe.join(', '), interval: j.interval })}</p> :
          fits.map((a) => <Btn key={a.id} kind="soft" full busy={busy === `at${a.id}`} onClick={() => void act(`at${a.id}`, async () => { await post(`/agents/${a.id}/strategies`, { path: j.strategy }); setAttached(a.id); })}>{t('rjAttachTo', { name: a.name })}</Btn>)}</div>}
    </div>
  );
}

/** The jobs as cards: logos, state pill (icon + word), the mission, the server's key figures. `inset`: inside a card already (the agent page). */
function JobList({ jobs, open, setOpen, nav, inset, noRunner }: { jobs: JobV[]; open: string; setOpen: (id: string) => void; nav: Nav; inset?: boolean; noRunner?: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (jobs.length === 0) return <div className={`flex flex-col items-center px-6 text-center ${inset ? 'rounded-2xl bg-elev/50 py-7' : 'card py-10'}`} data-testid="rj-none">
    <span className={`mb-3.5 grid place-items-center rounded-full text-mute ${inset ? 'h-11 w-11 bg-surface' : 'h-14 w-14 bg-elev'}`}><Icon n={noRunner ? 'cloudOff' : 'chart'} className={inset ? 'h-5 w-5' : 'h-6 w-6'} /></span>
    <p className="text-[0.9375rem] font-semibold">{t('rjNone')}</p><p className="mt-1.5 max-w-[34ch] text-[0.84375rem] leading-snug text-mute">{t(noRunner ? 'dzRjNoneNoRunner' : 'dzRjNoneBody')}</p></div>;
  return <ul className="space-y-3" data-testid="rj-list">{jobs.map((j) => { const isOpen = open === j.id;
    return <li key={j.id} className={inset ? 'rounded-[20px] bg-elev/55' : 'card'} data-job={j.id}>
      <button className="press flex w-full items-start gap-3 p-4 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : j.id)}>
        <UniverseStack symbols={j.universe} />
        <span className="min-w-0 flex-1">
          {isOpen ? <span className="flex min-h-8 items-center text-[0.8125rem] font-medium text-mute">{j.universe.join(' · ')} · {j.interval}</span> : <>
            <span className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1"><Tag tone={(STATE[j.state] ?? STATE.queued!)[0]} icon={(STATE[j.state] ?? STATE.queued!)[1]}>{t(`rjS_${j.state}` as Key)}</Tag><span className="text-xs text-mute">{when(j.createdAt, locale)}</span></span>
            <span className="mt-1 line-clamp-2 break-words text-[0.9375rem] font-medium leading-snug">{j.mission}</span>
            <span className="mt-1 block text-[0.78125rem] text-mute">{j.universe.join(' · ')} · {j.interval}</span>
            {(j.serverStatus === 'ok' || j.claimsDiffer) && <span className="mt-2 flex flex-wrap items-center gap-1.5">
              {j.serverStatus === 'ok' && <Tag tone="mute" icon="chart">{t('rjListMeasured', { trials: j.trialsTotal ?? '?', dsr: typeof j.deflatedSharpe === 'number' ? j.deflatedSharpe.toFixed(2) : '—' })}</Tag>}
              {j.claimsDiffer && <Tag tone="danger" icon="warn">{t('rjListDiffers')}</Tag>}</span>}</>}
        </span>
        <Icon n="chev" className={`mt-2 h-4 w-4 shrink-0 text-mute transition ${isOpen ? 'rotate-90' : ''}`} /></button>
      {isOpen && <div className="border-t border-line p-4"><ResearchJob id={j.id} nav={nav} /></div>}</li>; })}</ul>;
}

/** On an agent's page: start a research job for exactly what this agent trades, and follow its jobs. */
export function ResearchPanel({ agent, nav }: { agent: { id: string; kind?: string; universe: string[]; interval: string; state: string }; nav: Nav }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['research-jobs', agent.id], queryFn: () => get<{ jobs: JobV[] }>(`/research/jobs?agentId=${agent.id}`), refetchInterval: 10_000 });
  const st = useQuery({ queryKey: ['research-status'], queryFn: () => get<{ runnerConfigured: boolean }>('/research/status'), staleTime: 60_000 });
  const [form, setForm] = useState(false), [open, setOpen] = useState('');
  const noRunner = !!st.data && !st.data.runnerConfigured;
  return (
    <Card><div data-testid="rj-panel"><H right={<button className="press -mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-[0.84375rem] font-semibold text-blue" data-testid="rj-new" onClick={() => setForm(!form)}><Icon n={form ? 'x' : 'plus'} className="h-4 w-4" />{form ? t('cancel') : t('rjNew')}</button>}>{t('rjTitle')}</H>
      <p className="mb-4 text-[0.8125rem] leading-snug text-mute">{t('rjPanelIntro')}</p>
      {noRunner && <div className="mb-4"><Notice tone="warn">{t('rjNoRunner')}</Notice></div>}
      {form && <div className="mb-5 border-b border-line pb-5"><ResearchForm agent={agent} onCreated={(id) => { setForm(false); setOpen(id); void qc.invalidateQueries({ queryKey: ['research-jobs', agent.id] }); }} /></div>}
      {q.isLoading ? <Skeleton h="h-[92px]" className="!rounded-[20px]" /> : <JobList inset jobs={q.data?.jobs ?? []} open={open} setOpen={setOpen} nav={nav} noRunner={noRunner} />}
      <button className="press -mb-2 -ml-1 mt-2 inline-flex min-h-11 items-center gap-1 rounded-full px-1 text-[0.84375rem] font-semibold text-blue" onClick={() => nav({ tab: 'research' })}>{t('rjAll')}<Icon n="chev" className="h-3.5 w-3.5" /></button></div>
    </Card>
  );
}

/** The "Recherche" view: every job, and jobs that are not tied to an agent (library drafts). */
export function Research({ nav, job }: { nav: Nav; job?: string }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['research-jobs'], queryFn: () => get<{ jobs: JobV[] }>('/research/jobs'), refetchInterval: 10_000 });
  const st = useQuery({ queryKey: ['research-status'], queryFn: () => get<{ runnerConfigured: boolean; lastRunnerContact: string | null; openJobs: number; maxOpenJobs: number; labCommit: string | null }>('/research/status'), refetchInterval: 30_000 });
  const [form, setForm] = useState(false), [open, setOpen] = useState(job ?? '');
  const sd = st.data, noRunner = !!sd && !sd.runnerConfigured, seen = !!sd && sd.runnerConfigured && !!sd.lastRunnerContact;
  return (
    <div className="space-y-5" data-testid="rj-screen">
      <PageTitle onBack={() => nav({ tab: 'agents' })} backLabel={t('back')} right={<Btn kind="soft" className="!min-h-11 shrink-0 !px-4 !text-[0.875rem]" data-testid="rj-new" onClick={() => setForm(!form)}><Icon n={form ? 'x' : 'plus'} className="h-4 w-4" />{form ? t('cancel') : t('rjNew')}</Btn>}>{t('rjScreen')}</PageTitle>
      <Notice tone="info">{t('rjIntro')}</Notice>
      {/* the research node: seen / never seen / not configured — and how many jobs are open */}
      {sd && <div className={`flex items-start gap-3 rounded-2xl border p-3.5 text-[0.84375rem] leading-snug ${noRunner ? 'border-warn/30 bg-warn/[0.09]' : 'border-line bg-surface'}`} role="note">
        <Icon n={noRunner ? 'warn' : seen ? 'check' : 'clock'} className={`mt-0.5 h-4 w-4 shrink-0 ${noRunner ? 'text-warn' : seen ? 'text-emerald' : 'text-mute'}`} />
        <span className="min-w-0" data-testid="rj-status">{sd.runnerConfigured ? (sd.lastRunnerContact ? t('rjRunnerSeen', { when: when(sd.lastRunnerContact, locale) }) : t('rjRunnerNever')) : t('rjNoRunner')} · {t('rjOpenJobs', { n: sd.openJobs, max: sd.maxOpenJobs })}</span></div>}
      {form && <Section title={t('rjNewTitle')}><Card><ResearchForm onCreated={(id) => { setForm(false); setOpen(id); void qc.invalidateQueries({ queryKey: ['research-jobs'] }); }} /></Card></Section>}
      <Section title={t('rjJobs')}>{q.isLoading ? <div className="space-y-3"><SkeletonCard lines={2} /><SkeletonCard lines={2} /></div> : q.isError && !q.data ? <ErrorState title={t('dzRjLoadFailed')} onRetry={() => void q.refetch()}>{t('dzRjLoadFailedBody')}</ErrorState>
        : <JobList jobs={q.data?.jobs ?? []} open={open} setOpen={setOpen} nav={nav} noRunner={noRunner} />}</Section>
      <Section title={t('rjHowTitle')}><Card className="!py-2"><ol className="divide-y divide-line">{(['rjHow1', 'rjHow2', 'rjHow3', 'rjHow4', 'rjHow5'] as const).map((k, i) => <li key={k} className="flex gap-3 py-3 text-[0.84375rem] leading-snug">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-elev text-[0.75rem] font-semibold text-mute" aria-hidden="true">{i + 1}</span><span className="min-w-0">{t(k)}</span></li>)}</ol></Card></Section>
    </div>
  );
}

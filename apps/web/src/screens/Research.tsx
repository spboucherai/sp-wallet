// V7 research runtime — the owner's side of autonomous research jobs: describe a mission in plain language, set budgets,
// watch the job's log, read the submission. The screen keeps two things apart everywhere: what the AI agent WROTE (its
// hypothesis, its notes, the numbers it claims) and what THIS SERVER MEASURED on data the job never had. Only the second
// one can be approved. Every string is in the `rj` block of i18n.ts.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Field, H, Icon, inputCls, Notice, Skeleton, when } from '../ui';
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
const TONE: Record<string, string> = { submitted: 'text-emerald bg-emerald/10', failed: 'text-danger bg-danger/10', over_budget: 'text-warn bg-warn/12', cancelled: 'text-mute bg-elev', running: 'text-blue bg-blue/10', evaluating: 'text-blue bg-blue/10', preparing: 'text-blue bg-blue/10', queued: 'text-mute bg-elev' };
export function JobState({ state }: { state: string }) {
  const t = useT();
  return <span data-testid="rj-state" data-state={state} className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${TONE[state] ?? 'text-mute bg-elev'}`}>
    <Icon n={state === 'submitted' ? 'check' : state === 'failed' ? 'x' : 'clock'} className="h-3 w-3" />{t(`rjS_${state}` as Key)}</span>;
}
const pct = (x: number | null | undefined) => (typeof x === 'number' ? `${(x * 100).toFixed(1)} %` : '—');
const num = (x: number | null | undefined, d = 2) => (typeof x === 'number' ? x.toFixed(d) : '—');
const fmt = (metric: string, x: number | null) => (x === null ? '—' : metric === 'sharpe' ? x.toFixed(2) : metric === 'trades' ? String(Math.round(x)) : `${(x * 100).toFixed(1)} %`);
const dur = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** The form: a mission in the owner's words and the budgets the runner enforces from outside the agent. */
export function ResearchForm({ agent, onCreated }: { agent?: { id: string; kind?: string; universe: string[]; interval: string }; onCreated: (id: string) => void }) {
  const t = useT();
  const [f, setF] = useState({ mission: '', kind: 'spot' as 'spot' | 'perp', symbols: 'BTC, ETH', interval: '1h', capital: '1000', minutes: 60, maxTrials: 200, tokensM: 5, usd: 10, diskMb: 512 });
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const universe = f.symbols.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const n = (k: 'minutes' | 'maxTrials' | 'tokensM' | 'usd' | 'diskMb', label: string, suffix: string, min: number, max: number) => <Field label={label}><div className="flex items-center gap-2">
    <input data-testid={`rj-budget-${k}`} className={inputCls} inputMode="decimal" value={String(f[k])} onChange={(e) => setF({ ...f, [k]: Math.max(0, Math.min(max, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)) })} onBlur={() => setF((x) => ({ ...x, [k]: Math.max(min, x[k]) }))} />
    <span className="w-14 shrink-0 text-[13px] text-mute">{suffix}</span></div></Field>;
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const j = await post<JobV>('/research/jobs', { mission: f.mission.trim(), ...(agent ? { agentId: agent.id, universe: agent.universe } : { kind: f.kind, universe, interval: f.interval }), capitalUsd: Number(amountOf(f.capital, amountLocale()) ?? '') || 1000,
        budgets: { wallSeconds: Math.round(f.minutes * 60), maxTrials: Math.round(f.maxTrials), maxDiskMb: Math.round(f.diskMb), maxModelTokens: Math.round(f.tokensM * 1_000_000), maxModelUsd: f.usd } });
      setF((x) => ({ ...x, mission: '' })); onCreated(j.id);
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4" data-testid="rj-form">
      <Field label={t('rjMission')} hint={t('rjMissionHint')}><textarea data-testid="rj-mission" className={`${inputCls} min-h-[104px] resize-none`} maxLength={2000} value={f.mission} placeholder={t('rjMissionExample')} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
      {agent ? <p className="text-[13px] text-mute">{t('rjForAgent', { assets: agent.universe.join(', '), interval: agent.interval, kind: agent.kind === 'perp' ? t('rjKindPerp') : t('rjKindSpot') })}</p> : <div className="grid grid-cols-2 gap-3">
        <Field label={t('rjKind')}><select data-testid="rj-kind" className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'spot' | 'perp' })}><option value="spot">{t('rjKindSpot')}</option><option value="perp">{t('rjKindPerp')}</option></select></Field>
        <Field label={t('rjInterval')}><select className={inputCls} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="1h">1 h</option>{f.kind === 'perp' ? <option value="4h">4 h</option> : <option value="1d">1 j / 1 d</option>}</select></Field>
        <div className="col-span-2"><Field label={t('rjSymbols')} hint={t('rjSymbolsHint')}><input data-testid="rj-symbols" className={inputCls} value={f.symbols} onChange={(e) => setF({ ...f, symbols: e.target.value })} /></Field></div></div>}
      <Field label={t('rjCapital')} hint={t('rjCapitalHint')}><div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: sanitizeAmountText(e.target.value) })} /><span className="w-14 shrink-0 text-[13px] text-mute">USD</span></div><AmountProblem text={f.capital} /></Field>
      <div><div className="mb-2 text-[13px] font-semibold text-mute">{t('rjBudgets')}</div>
        <div className="grid grid-cols-2 gap-3">{n('minutes', t('rjBudgetTime'), 'min', 1, 1440)}{n('maxTrials', t('rjBudgetTrials'), t('rjTrialsUnit'), 1, 5000)}{n('tokensM', t('rjBudgetTokens'), 'M', 0.01, 500)}{n('usd', t('rjBudgetUsd'), 'USD', 0.05, 1000)}</div>
        <p className="mt-2 text-[12.5px] text-mute">{t('rjBudgetsNote')}</p></div>
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
  return <pre ref={box} data-testid="rj-log" aria-label={t('rjLog')} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-elev/70 p-3 font-mono text-[11.5px] leading-[1.5]">
    {lines.length === 0 ? <span className="text-mute">{t('rjLogEmpty')}</span> : lines.map((l) => <span key={l.id} className={l.s === 'err' ? 'text-danger' : l.s === 'sys' || l.s === 'api' ? 'text-mute' : ''}>{l.s === 'api' ? '[api] ' : l.s === 'sys' ? '[runner] ' : ''}{l.t}{'\n'}</span>)}</pre>;
}

/** One job: state, budgets used, log, and — for a submission — the agent's statements next to the server's measurements. */
export function ResearchJob({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['research-job', id], queryFn: () => get<Detail>(`/research/jobs/${id}`), refetchInterval: (x) => (x.state.data && FINAL.includes(x.state.data.state) ? false : 4000) });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<{ agents: { id: string; name: string; universe: string[]; interval: string; kind?: string }[] }>('/agents'), enabled: !!q.data && q.data.state === 'submitted' && !q.data.agentId });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [attached, setAttached] = useState('');
  if (q.isLoading || !q.data) return <Skeleton h="h-40" />;
  const j = q.data, s = j.server, sub = j.submission, u = j.usage, live = !FINAL.includes(j.state);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['research-job', id] }); void qc.invalidateQueries({ queryKey: ['research-jobs'] }); if (j.agentId) void qc.invalidateQueries({ queryKey: ['agent', j.agentId] }); };
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); try { await fn(); refresh(); } catch (e) { setErr(errText(t, e)); } finally { setBusy(''); } };
  const fits = (agents.data?.agents ?? []).filter((a) => (a.kind ?? 'spot') === j.kind && a.interval === j.interval && [...a.universe].sort().join() === [...j.universe].sort().join());
  const row = (label: string, value: string, sub2?: string) => <div className="rounded-xl bg-surface p-2 text-center"><div className="text-[12px] text-mute">{label}</div><div className="text-[14px] font-semibold">{value}</div>{sub2 && <div className="text-[11px] text-mute">{sub2}</div>}</div>;
  return (
    <div className="space-y-3" data-testid="rj-job" data-job={j.id}>
      <div className="flex items-start justify-between gap-3"><p className="min-w-0 flex-1 whitespace-pre-wrap text-[14px]">{j.mission}</p><JobState state={j.state} /></div>
      <div className="text-[12.5px] text-mute">{j.kind === 'perp' ? t('rjKindPerp') : t('rjKindSpot')} · {j.universe.join(' · ')} · {j.interval} · {when(j.createdAt, locale)}{j.agent ? ` · ${j.agent.name}` : ` · ${t('rjLibraryDraft')}`}</div>
      {j.reason && <Notice tone={j.state === 'cancelled' ? 'info' : 'warn'}>{j.reason}</Notice>}
      {j.dataError && <Notice tone="danger">{j.dataError}</Notice>}
      {j.holdout && <p className="text-[12.5px] text-mute" data-testid="rj-holdout">{t('rjHoldout', { dev: j.holdout.devBars, test: j.holdout.testBars, from: when(j.holdout.devEnd, locale) })}</p>}
      <div className="grid grid-cols-2 gap-2 text-[12.5px] sm:grid-cols-4" data-testid="rj-usage">
        {row(t('rjBudgetTime'), u ? dur(u.wallMs) : '—', `/ ${dur(j.budgets.wallSeconds * 1000)}`)}{row(t('rjBudgetTrials'), u ? String(u.trials) : '—', `/ ${j.budgets.maxTrials}`)}
        {row(t('rjBudgetTokens'), u ? `${(u.modelTokens / 1e6).toFixed(2)} M` : '—', `/ ${(j.budgets.maxModelTokens / 1e6).toFixed(2)} M`)}{row(t('rjBudgetUsd'), u?.modelUsd != null ? u.modelUsd.toFixed(2) : '—', `/ ${j.budgets.maxModelUsd}`)}</div>
      {u && <p className="text-[12px] text-mute" data-testid="rj-isolation">{u.sandbox === 'sandbox-exec' ? t('rjSandboxOn', { agent: u.agent }) : t('rjSandboxOff', { agent: u.agent })}{u.ledgerTampered ? ` ${t('rjTampered')}` : ''}</p>}
      {u && u.sandbox !== 'sandbox-exec' && <Notice tone="warn">{t('rjSandboxOffNote')}</Notice>}
      <JobLog id={j.id} live={live} onState={refresh} />
      {live && j.state !== 'evaluating' && <Btn kind="ghost" full busy={busy === 'cancel'} disabled={j.cancelRequested} data-testid="rj-cancel" onClick={() => void act('cancel', () => post(`/research/jobs/${j.id}/cancel`))}><Icon n="stop" className="h-4 w-4" />{j.cancelRequested ? t('rjCancelling') : t('rjCancel')}</Btn>}
      {err && <Notice tone="danger">{err}</Notice>}

      {sub && <div className="space-y-3 rounded-2xl border border-line p-3.5" data-testid="rj-claims">
        <div className="flex items-center gap-2"><span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('rjClaimedTag')}</span><span className="text-[15px] font-semibold">{t('rjClaimedTitle')}</span></div>
        <p className="text-[12.5px] text-mute">{t('rjClaimedNote')}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-elev/70 p-3 text-[12.5px] leading-[1.5]" data-testid="rj-readme">{sub.files['README.md']}</pre>
        {sub.claims?.summary && <blockquote className="border-l-2 border-warn/60 pl-3 text-[13px] italic" data-testid="rj-summary">{sub.claims.summary}</blockquote>}
        {sub.claimsProblem && <p className="text-[12.5px] text-warn">{sub.claimsProblem}</p>}
        {sub.files['NOTES.md'] && <details><summary className="cursor-pointer text-[13px] font-medium">{t('rjNotes')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-elev/70 p-3 text-[12px]">{sub.files['NOTES.md']}</pre></details>}
        <details data-testid="rj-code"><summary className="cursor-pointer text-[13px] font-medium">{t('rjCode')}</summary>
          <div className="mt-2 break-all font-mono text-[11px] text-mute">sha256 {sub.sha256}</div>
          <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-elev/70 p-3 font-mono text-[11.5px] leading-[1.45]">{sub.files['strategy.py']}</pre></details>
      </div>}

      {s && s.status === 'failed' && <Notice tone="danger"><span data-testid="rj-refused">{t('rjRefused')} {s.reason}</span></Notice>}
      {s && s.status === 'ok' && <div className="space-y-3 rounded-2xl border border-emerald/40 p-3.5" data-testid="rj-measured">
        <div className="flex items-center gap-2"><span className="rounded-full bg-emerald/10 px-2 py-0.5 text-[11.5px] font-semibold text-emerald">{t('rjMeasuredTag')}</span><span className="text-[15px] font-semibold">{t('rjMeasuredTitle')}</span></div>
        <p className="text-[12.5px] text-mute">{t('rjMeasuredNote', { from: s.holdout ? when(s.holdout.testStart, locale) : '?', to: s.holdout ? when(s.holdout.testEnd, locale) : '?', bars: s.holdout?.bars ?? '?' })}</p>
        <div className="grid grid-cols-3 gap-2">{row(t('agRet'), pct(s.metrics?.test.total_return), `${t('agVs')} ${pct(s.benchmark?.total_return)}`)}
          {row('Sharpe', num(s.metrics?.test.sharpe), s.sharpeCi ? `[${num(s.sharpeCi[0])} ; ${num(s.sharpeCi[1])}]` : undefined)}{row(t('agDD'), pct(s.metrics?.test.max_drawdown), `${t('agVs')} ${pct(s.benchmark?.max_drawdown)}`)}</div>
        <div className="grid grid-cols-2 gap-2">{row(t('rjTrials'), String(s.trials?.total ?? '—'), t('rjTrialsSplit', { job: s.trials?.job ?? '?', server: s.trials?.server ?? '?' }))}
          {row(t('rjDsr'), num(s.deflatedSharpe, 3), typeof s.deflatedSharpe === 'number' && s.deflatedSharpe < 0.95 ? t('rjDsrLow') : t('rjDsrOk'))}</div>
        <p className="text-[12.5px] text-mute">{t('rjSplits', { train: pct(s.metrics?.train.total_return), val: pct(s.metrics?.validation.total_return), test: pct(s.metrics?.test.total_return) })} {s.sharpeCi && (s.sharpeCi[0] ?? 0) <= 0 && (s.sharpeCi[1] ?? 0) >= 0 ? t('rjCiZero') : ''}</p>
        <p className="text-[12px] text-mute">{t('rjChecks')}: {Object.entries(s.checks ?? {}).filter(([, v]) => v === 'pass' || v === 'fail').map(([k, v]) => `${k} ${v === 'pass' ? '✓' : '✗'}`).join(' · ')} · {s.sandbox === 'sandbox-exec' ? t('rjServerSandbox') : t('rjServerNoSandbox')}</p>
        <div data-testid="rj-compare"><div className="mb-1.5 text-[13px] font-semibold">{t('rjCompareTitle')}</div>
          {s.claimsDiffer ? <Notice tone="warn"><span data-testid="rj-differs">{t('rjDiffers')}</span></Notice> : <p className="text-[12.5px] text-mute" data-testid="rj-agrees">{t('rjAgrees')}</p>}
          <table className="mt-2 w-full text-[12.5px]"><thead><tr className="text-left text-mute"><th className="py-1 font-medium">{t('rjColSplit')}</th><th className="font-medium">{t('rjColAgent')}</th><th className="font-medium">{t('rjColServer')}</th></tr></thead>
            <tbody>{(s.comparison ?? []).filter((c) => c.metric !== 'trades').map((c) => <tr key={c.split + c.metric} className={`border-t border-line ${c.differs ? 'text-danger' : ''}`} data-differs={c.differs}>
              <td className="py-1">{t(`rjSplit_${c.split}` as Key)} · {c.metric === 'total_return' ? t('agRet') : c.metric === 'sharpe' ? 'Sharpe' : t('agDD')}</td><td>{fmt(c.metric, c.claimed)}</td><td className="font-semibold">{fmt(c.metric, c.measured)}{c.differs ? ' ≠' : ''}</td></tr>)}</tbody></table>
          {sub?.claims?.trials !== undefined && <p className="mt-1.5 text-[12px] text-mute">{t('rjTrialsClaim', { claimed: sub.claims.trials, counted: s.trials?.job ?? '?' })}</p>}</div>
      </div>}

      {j.state === 'submitted' && s?.status === 'ok' && j.agent && j.version && <div className="space-y-2.5" data-testid="rj-actions">
        {j.version.status === 'draft' && <><Notice tone="info">{t('rjApproveNote')}</Notice>
          <Btn full busy={busy === 'approve'} data-testid="rj-approve" onClick={() => void act('approve', () => post(`/agents/${j.agent!.id}/strategies/${j.version!.id}/approve`))}><Icon n="check" className="h-4 w-4" />{t('rjApprove')}</Btn></>}
        {j.version.status === 'approved' && <><Notice tone="ok"><span data-testid="rj-approved">{t('rjApproved')}</span></Notice>
          {j.agent.state !== 'PAPER_TRADING' && j.agent.state !== 'LIVE' && <Btn full kind="soft" busy={busy === 'paper'} data-testid="rj-paper" onClick={() => void act('paper', () => post(`/agents/${j.agent!.id}/mode`, { mode: 'PAPER' }))}>{t('rjStartPaper')}</Btn>}
          {j.agent.state === 'PAPER_TRADING' && <p className="text-[13px] text-mute" data-testid="rj-paper-on">{t('rjPaperOn')}</p>}</>}
        <Btn full kind="ghost" onClick={() => nav({ tab: 'agent', asset: j.agent!.id })}>{t('rjOpenAgent', { name: j.agent.name })}</Btn></div>}
      {j.state === 'submitted' && s?.status === 'ok' && !j.agentId && <div className="space-y-2" data-testid="rj-attach">
        <div className="text-[13px] font-semibold">{t('rjAttachTitle')}</div>
        {attached ? <Notice tone="ok">{t('rjAttached')}</Notice> : fits.length === 0 ? <p className="text-[12.5px] text-mute">{t('rjAttachNone', { assets: j.universe.join(', '), interval: j.interval })}</p> :
          fits.map((a) => <Btn key={a.id} kind="soft" full busy={busy === `at${a.id}`} onClick={() => void act(`at${a.id}`, async () => { await post(`/agents/${a.id}/strategies`, { path: j.strategy }); setAttached(a.id); })}>{t('rjAttachTo', { name: a.name })}</Btn>)}</div>}
    </div>
  );
}

function JobList({ jobs, open, setOpen, nav }: { jobs: JobV[]; open: string; setOpen: (id: string) => void; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (jobs.length === 0) return <p className="py-2 text-[14px] text-mute" data-testid="rj-none">{t('rjNone')}</p>;
  return <ul className="space-y-2.5" data-testid="rj-list">{jobs.map((j) => <li key={j.id} className="rounded-2xl bg-elev/60 p-3.5" data-job={j.id}>
    <button className="flex w-full items-center gap-3 text-left" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? '' : j.id)}>
      <span className="min-w-0 flex-1"><span className="block truncate text-[14.5px] font-medium">{j.mission}</span>
        <span className="block truncate text-[12px] text-mute">{j.universe.join(' · ')} · {j.interval} · {when(j.createdAt, locale)}{j.serverStatus === 'ok' ? ` · ${t('rjListMeasured', { trials: j.trialsTotal ?? '?', dsr: typeof j.deflatedSharpe === 'number' ? j.deflatedSharpe.toFixed(2) : '—' })}` : ''}{j.claimsDiffer ? ` · ${t('rjListDiffers')}` : ''}</span></span>
      <JobState state={j.state} /><Icon n="chev" className={`h-4 w-4 shrink-0 text-mute transition ${open === j.id ? 'rotate-90' : ''}`} /></button>
    {open === j.id && <div className="mt-3 border-t border-line pt-3"><ResearchJob id={j.id} nav={nav} /></div>}</li>)}</ul>;
}

/** On an agent's page: start a research job for exactly what this agent trades, and follow its jobs. */
export function ResearchPanel({ agent, nav }: { agent: { id: string; kind?: string; universe: string[]; interval: string; state: string }; nav: Nav }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['research-jobs', agent.id], queryFn: () => get<{ jobs: JobV[] }>(`/research/jobs?agentId=${agent.id}`), refetchInterval: 10_000 });
  const st = useQuery({ queryKey: ['research-status'], queryFn: () => get<{ runnerConfigured: boolean }>('/research/status'), staleTime: 60_000 });
  const [form, setForm] = useState(false), [open, setOpen] = useState('');
  return (
    <Card><div data-testid="rj-panel"><H right={<button className="text-[13px] font-semibold text-blue" data-testid="rj-new" onClick={() => setForm(!form)}>{form ? t('cancel') : t('rjNew')}</button>}>{t('rjTitle')}</H>
      <p className="mb-3 text-[13px] text-mute">{t('rjPanelIntro')}</p>
      {st.data && !st.data.runnerConfigured && <div className="mb-3"><Notice tone="warn">{t('rjNoRunner')}</Notice></div>}
      {form && <div className="mb-4"><ResearchForm agent={agent} onCreated={(id) => { setForm(false); setOpen(id); void qc.invalidateQueries({ queryKey: ['research-jobs', agent.id] }); }} /></div>}
      {q.isLoading ? <Skeleton h="h-16" /> : <JobList jobs={q.data?.jobs ?? []} open={open} setOpen={setOpen} nav={nav} />}
      <button className="mt-3 text-[13px] font-semibold text-blue" onClick={() => nav({ tab: 'research' })}>{t('rjAll')}</button></div>
    </Card>
  );
}

/** The "Recherche" view: every job, and jobs that are not tied to an agent (library drafts). */
export function Research({ nav, job }: { nav: Nav; job?: string }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['research-jobs'], queryFn: () => get<{ jobs: JobV[] }>('/research/jobs'), refetchInterval: 10_000 });
  const st = useQuery({ queryKey: ['research-status'], queryFn: () => get<{ runnerConfigured: boolean; lastRunnerContact: string | null; openJobs: number; maxOpenJobs: number; labCommit: string | null }>('/research/status'), refetchInterval: 30_000 });
  const [form, setForm] = useState(false), [open, setOpen] = useState(job ?? '');
  return (
    <div className="space-y-4" data-testid="rj-screen">
      <div className="flex items-center gap-2 pt-1"><button onClick={() => nav({ tab: 'agents' })} aria-label={t('back')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>
        <h1 className="min-w-0 flex-1 text-[28px] font-semibold tracking-[-0.02em]">{t('rjScreen')}</h1>
        <Btn kind="soft" data-testid="rj-new" onClick={() => setForm(!form)}><Icon n={form ? 'x' : 'key'} className="h-4 w-4" />{form ? t('cancel') : t('rjNew')}</Btn></div>
      <Notice tone="info">{t('rjIntro')}</Notice>
      {st.data && <p className="text-[12.5px] text-mute" data-testid="rj-status">{st.data.runnerConfigured ? (st.data.lastRunnerContact ? t('rjRunnerSeen', { when: when(st.data.lastRunnerContact, locale) }) : t('rjRunnerNever')) : t('rjNoRunner')} · {t('rjOpenJobs', { n: st.data.openJobs, max: st.data.maxOpenJobs })}</p>}
      {form && <Card><H>{t('rjNewTitle')}</H><ResearchForm onCreated={(id) => { setForm(false); setOpen(id); void qc.invalidateQueries({ queryKey: ['research-jobs'] }); }} /></Card>}
      <Card><H>{t('rjJobs')}</H>{q.isLoading ? <Skeleton h="h-24" /> : <JobList jobs={q.data?.jobs ?? []} open={open} setOpen={setOpen} nav={nav} />}</Card>
      <Card><H>{t('rjHowTitle')}</H><ul className="list-disc space-y-1.5 pl-5 text-[13px] text-mute">{(['rjHow1', 'rjHow2', 'rjHow3', 'rjHow4', 'rjHow5'] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul></Card>
    </div>
  );
}

// Any-to-any plans (V7): candidate plans for a cross-network pair, the start sheet, and the progress view that drives one
// passkey approval per leg. Shared by Swap (plan cards), Activity (open and recent plans) and the /plan/<id> page.
// A plan never approves anything: every leg is an ordinary proposal reviewed and approved here, when its turn comes.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post } from './api';
import { errText, useT, type Key } from './i18n';
import { Btn, Card, Icon, inputCls, NetDot, Notice, StatePill, trimAmt } from './ui';

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
  from: AssetV; to: AssetV; amountInDisplay: string; floorDisplay: string | null; holding: AssetV & { amountDisplay: string }; pause: { code: string; message: string; leg: number } | null;
  estimate: { expectedOutDisplay: string; worstOutDisplay: string } | null; plannedExpectedDisplay: string; plannedWorstDisplay: string; receivedDisplay: string | null;
  legs: { index: number; state: 'pending' | 'ready' | 'proposed' | 'in_flight' | 'settled'; kind: string; label: string; speed: string | null; from: AssetV; to: AssetV; seconds: number | null;
    planned: { expectedInDisplay: string; expectedOutDisplay: string; worstOutDisplay: string }; actual: { inDisplay: string | null; outDisplay: string | null }; attempts: { outcome: string | null; error: string | null }[] }[];
  proposal: any | null;
}
type T = (k: Key, v?: Record<string, string | number>) => string;
const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
/** in-app navigation without a prop: the shell listens to popstate */
export const goPath = (path: string) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); };
const kindKey = (k: string): Key => (k === 'bridge' ? 'pnKindBridge' : k === 'xswap' ? 'pnKindXswap' : 'pnKindSwap');

function Pair({ a, b }: { a: AssetV; b: AssetV }) {
  const chip = (x: AssetV) => <span className="inline-flex items-center gap-1 rounded-full bg-elev px-2 py-0.5 text-[12.5px] font-medium"><NetDot net={x.network} />{x.symbol}<span className="font-normal text-mute">· {x.networkName}</span></span>;
  return <span className="flex flex-wrap items-center gap-1">{chip(a)}<Icon n="chev" className="h-3 w-3 text-mute" />{chip(b)}</span>;
}
const issueText = (t: T, i: IssueV) => t(`pnIssue_${i.code}` as Key, { step: (i.leg ?? 0) + 1, need: trimAmt(i.needDisplay, 8), have: trimAmt(i.haveDisplay, 8), sym: i.symbol, net: i.networkName });

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
      {running && <Notice tone="info"><div className="flex flex-wrap items-center justify-between gap-2"><span>{t('pnOpenBanner', { from: running.from.symbol, to: running.to.symbol, k: Math.min(running.current + 1, running.steps), n: running.steps })}</span>
        <button className="min-h-11 font-semibold text-blue" onClick={() => setShow(running.id)}>{t('pnResume')}</button></div></Notice>}
      {ok && (q.isLoading || deb !== amount) && <Card><div className="flex items-center gap-3 text-[14px] text-mute"><Icon n="spin" className="h-5 w-5" />{t('pnSearching')}</div></Card>}
      {q.error ? <Notice tone="danger">{errText(t, q.error)}</Notice> : null}
      {ok && q.data?.notExecutable && <Notice tone="warn"><span data-testid="plan-not-executable"><b>{t('pnNotExecTitle')}</b> {t(`pnNo_${q.data.notExecutable.code}` as Key, { net: q.data.notExecutable.network ?? '' })}</span></Notice>}
      {ok && q.data && !q.data.notExecutable && plans.length === 0 && q.data.plans.length === 0 && q.data.skipped.length > 0 && <Notice tone="warn">{t('pnNoQuote')} {q.data.skipped[0]!.message}</Notice>}
      {ok && plans.length > 0 && <>
        <h2 className="px-1 pt-1 text-[16px] font-semibold">{t('pnTitle')}</h2>
        <p className="px-1 text-[12.5px] text-mute">{t('pnIntro')}</p>
        {plans.map((p, k) => { const isOpen = open === p.id || (open === '' && k === 0); const blocking = p.issues.filter((i) => i.blocking), warns = p.issues.filter((i) => !i.blocking && i.code === 'limit_margin');
          const simple = p.legs.length === 2 && p.legs[0]!.kind === 'bridge' && p.legs[1]!.kind === 'swap';
          return (
          <section key={p.id} data-testid="plan-card" data-executable={p.executable} className={`card overflow-hidden ${k === 0 && p.executable ? 'ring-2 ring-primary' : ''}`}>
            <button className="w-full p-4 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '-' : p.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] text-mute">{simple ? t('pnSimple') : p.legs.map((l) => t(kindKey(l.kind))).join(' → ')} · {t('pnApprovals', { n: p.approvals })}</div>
                  <div className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight">{trimAmt(p.expectedOutDisplay, 8)} <span className="text-mute">{p.to.symbol}</span></div>
                  <div className="text-[12.5px] text-mute">{t('pnExpected')}{p.expectedUsd != null ? ` · ≈ ${money(p.expectedUsd)}` : ''}</div>
                  <div className="mt-1 text-[13.5px]"><span className="font-semibold">{trimAmt(p.worstOutDisplay, 8)} {p.to.symbol}</span> <span className="text-mute">{t('pnWorst')}</span></div></div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {k === 0 && p.executable && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-onprimary">{t('pnBest')}</span>}
                  {!p.executable && <span className="inline-flex items-center gap-1 rounded-full bg-warn/12 px-2 py-0.5 text-[11px] font-semibold text-warn"><Icon n="warn" className="h-3 w-3" />{t('pnBlocked')}</span>}
                  <span className="text-[12.5px] text-mute"><Icon n="clock" className="mr-1 inline h-3.5 w-3.5" />{dur(p.seconds)}</span>
                </div>
              </div>
            </button>
            {isOpen && <div className="space-y-4 border-t border-line bg-elev/40 p-4 text-[13px]">
              <ol className="relative space-y-4" aria-label={t('pnSteps')}>{p.legs.map((l, i) => <li key={i} className="flex gap-3">
                <span className="flex flex-col items-center"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-semibold text-onprimary">{i + 1}</span>{i < p.legs.length - 1 && <span className="mt-1 w-px flex-1 bg-line" aria-hidden="true" />}</span>
                <div className="min-w-0 flex-1 pb-1"><div className="font-medium">{t(kindKey(l.kind))} · <span className="text-mute">{l.label}{l.speed ? ` · ${t(l.speed === 'fast' ? 'pnFast' : 'pnStandard')}` : ''}</span></div>
                  <div className="mt-1"><Pair a={l.from} b={l.to} /></div>
                  <div className="mt-1 text-mute">{trimAmt(l.expectedInDisplay, 8)} {l.from.symbol} → <span className="text-ink">{trimAmt(l.expectedOutDisplay, 8)} {l.to.symbol}</span> · {t('pnWorstShort')} {trimAmt(l.worstOutDisplay, 8)}</div>
                  <div className="mt-0.5 text-[12.5px] text-mute">{dur(l.seconds)} · {l.fees.length === 0 ? t('pnNoFee') : l.fees.map((f) => `${t(`pnFee_${f.kind}` as Key)} ${trimAmt(f.display, 8)} ${f.symbol}${f.network !== l.from.network || f.kind === 'network' ? ` (${f.networkName})` : ''}${f.includedInOutput ? ` ${t('pnInOutput')}` : ''}`).join(' · ')}</div>
                </div></li>)}</ol>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-mute"><span>{t('pnTotalTime')} <span className="text-ink">{dur(p.seconds)}</span></span><span>{t('pnTotalFees')} <span className="text-ink">{p.extraFeesUsd === null ? '—' : money(p.extraFeesUsd) ?? `${p.extraFeesUsd.toFixed(2)} USD`}</span></span></div>
              <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('pnRequired')}</div>
                <ul className="space-y-1.5">
                  {p.requirements.gas.map((g) => <li key={g.network} className="flex gap-2" data-testid="plan-gas" data-ok={g.ok}><Icon n={g.ok ? 'check' : 'warn'} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${g.ok ? 'text-emerald' : 'text-danger'}`} />
                    <span>{t('pnGasLine', { sym: g.symbol, net: g.networkName, need: trimAmt(g.needDisplay, 6), have: g.haveDisplay === null ? '?' : trimAmt(g.haveDisplay, 6) })}
                      {!g.ok && <> <span className="text-mute">{t('pnGasHelp', { sym: g.symbol, net: g.networkName })}</span> <button className="font-semibold text-blue underline" onClick={() => goPath(`/receive?n=${g.network}`)}>{t('pnGasReceive', { sym: g.symbol, net: g.networkName })}</button></>}</span></li>)}
                  {p.requirements.limits.map((l) => <li key={l.leg} className="flex gap-2"><Icon n={l.ok ? 'check' : 'warn'} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${l.ok ? 'text-emerald' : 'text-danger'}`} />
                    <span>{t('pnLimitLine', { step: l.leg + 1, need: trimAmt(l.needDisplay, 6), sym: l.symbol, net: l.networkName, per: trimAmt(l.perTransferDisplay, 6), left: trimAmt(l.leftTodayDisplay, 6) })}</span></li>)}
                </ul></div>
              {blocking.length > 0 && <Notice tone="warn"><ul className="space-y-1" data-testid="plan-issues">{blocking.map((i, n) => <li key={n}>{issueText(t, i)}</li>)}</ul></Notice>}
              {warns.length > 0 && <p className="text-[12.5px] text-mute">{warns.map((i) => issueText(t, i)).join(' ')}</p>}
              <Btn full disabled={!p.executable || !!running} onClick={() => setStart(p)}><Icon n="swap" className="h-4 w-4" />{t('pnStart', { n: p.approvals })}</Btn>
              {!!running && <p className="text-[12.5px] text-mute">{t('pnOneAtATime')}</p>}
            </div>}
          </section>); })}
        {better && <Notice tone="info"><span data-testid="plan-comparison">{t('pnComparison', { via: better.providers.map(pname).join(' → '), min: trimAmt(better.minAmountOutDisplay, 8), sym: to.symbol })}</span></Notice>}
      </>}
      {start && <StartSheet plan={start} slip={slip} amount={deb} onClose={() => setStart(null)} onStarted={(id) => { setStart(null); void qc.invalidateQueries({ queryKey: ['plans-open'] }); setShow(id); }} />}
      {show && <PlanSheet id={show} onClose={() => { setShow(null); void qc.invalidateQueries({ queryKey: ['plans-open'] }); }} />}
    </div>);
}

function StartSheet({ plan: p, slip, amount, onClose, onStarted }: { plan: PlanQ; slip: number; amount: string; onClose: () => void; onStarted: (id: string) => void }) {
  const t = useT(); const [floor, setFloor] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const go = async () => { setBusy(true); setErr('');
    try { const r = await post<PlanV>('/plans', { from: p.from.key, to: p.to.key, amount, slippageBps: slip, plan: p.id, ...(floor ? { floor } : {}) }); onStarted(r.id); }
    catch (e) { setErr(errText(t, e)); } finally { setBusy(false); } };
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('pnStartTitle')}>
      <div className="rise max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 lg:rounded-3xl" data-testid="plan-start">
        <h2 className="mb-3 text-[20px] font-semibold tracking-tight">{t('pnStartTitle')}</h2>
        <div className="rounded-2xl bg-elev/70 p-4">
          <div className="text-[13px] text-mute">{trimAmt(p.amountInDisplay, 8)} {p.from.symbol} · {p.from.networkName} → {p.to.networkName}</div>
          <div className="text-[24px] font-semibold tracking-tight">{trimAmt(p.expectedOutDisplay, 8)} <span className="text-mute">{p.to.symbol}</span></div>
          <div className="text-[13px] text-mute">{t('pnExpected')} · {t('pnWorstShort')} {trimAmt(p.worstOutDisplay, 8)} {p.to.symbol}</div>
        </div>
        <div className="mt-3 space-y-3 text-[13.5px]">
          <Notice tone="info">{t('pnGuarantee', { n: p.approvals })}</Notice>
          <Notice tone="ok">{t('pnBetween')}</Notice>
          <label className="block"><span className="mb-1.5 block text-[13px] text-mute">{t('pnFloorLabel', { sym: p.to.symbol })}</span>
            <input className={inputCls} inputMode="decimal" placeholder={t('pnFloorNone')} aria-label={t('pnFloorLabel', { sym: p.to.symbol })} value={floor} onChange={(e) => setFloor(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))} autoComplete="off" />
            <span className="mt-1.5 block text-xs text-mute">{t('pnFloorHint', { worst: trimAmt(p.worstOutDisplay, 8), sym: p.to.symbol })} <button type="button" className="font-semibold text-blue" onClick={() => setFloor(trimAmt(p.worstOutDisplay, 8))}>{t('pnFloorUseWorst')}</button></span></label>
          {err && <Notice tone="danger">{err}</Notice>}
        </div>
        <div className="mt-4 space-y-2.5">
          <Btn full busy={busy} onClick={() => void go()}>{t('pnStartConfirm')}</Btn>
          <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Btn>
        </div>
      </div>
    </div>);
}

const LEG_TONE: Record<string, [string, string]> = { settled: ['bg-emerald text-white', 'check'], ready: ['bg-warn text-white', 'key'], proposed: ['bg-warn text-white', 'key'], in_flight: ['bg-blue text-white', 'clock'], pending: ['bg-elev text-mute', ''] };
function PlanPill({ p }: { p: PlanV }) {
  const t = useT(); const cls = { active: 'text-blue bg-blue/10', paused: 'text-warn bg-warn/12', done: 'text-emerald bg-emerald/10', stopped: 'text-mute bg-elev' }[p.state];
  return <span data-testid="plan-state" data-state={p.state} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${cls}`}><Icon n={p.state === 'done' ? 'check' : p.state === 'paused' ? 'warn' : p.state === 'stopped' ? 'stop' : 'clock'} className="h-3 w-3" />{t(`pnState_${p.state}` as Key)}</span>;
}

/** The plan's progress: timeline (planned vs actual), where the funds are, and the one action available now. */
export function PlanBody({ id, onGone }: { id: string; onGone?: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plan', id], queryFn: () => get<PlanV>(`/plans/${id}`), refetchInterval: (x) => (x.state.data && ['done', 'stopped'].includes(x.state.data.state) ? false : 3000), retry: false });
  const [prep, setPrep] = useState<{ proposal: any; options: any } | null>(null), [busy, setBusy] = useState(''), [err, setErr] = useState(''), [left, setLeft] = useState(0), [floor, setFloor] = useState('');
  const p = q.data;
  const mine = prep && p?.proposal?.id === prep.proposal.id && p?.proposal?.state === 'pending_approval' ? prep : null;   // the challenge held here matches the step awaiting approval
  useEffect(() => { if (!mine) return; const tick = () => setLeft(Math.max(0, Math.round((new Date(mine.proposal.expiresAt).getTime() - Date.now()) / 1000))); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [mine?.proposal.id]);
  useEffect(() => { if (p?.state === 'done' || p?.state === 'stopped') { void qc.invalidateQueries({ queryKey: ['portfolio'] }); void qc.invalidateQueries({ queryKey: ['activity'] }); } }, [p?.state, qc]);
  if (q.isLoading) return <div className="flex items-center gap-3 py-6 text-[14px] text-mute"><Icon n="spin" className="h-5 w-5" />{t('pnLoading')}</div>;
  if (q.error || !p) return <div className="space-y-3"><Notice tone="danger">{errText(t, q.error)}</Notice>{onGone && <Btn full kind="ghost" onClick={onGone}>{t('swClose')}</Btn>}</div>;
  const set = (v: PlanV) => qc.setQueryData(['plan', id], v);
  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); setErr(''); try { await fn(); } catch (e) { const m = errText(t, e); if (m) setErr(m); void q.refetch(); } finally { setBusy(''); } };
  const prepare = () => act('prepare', async () => { const r = await post<{ plan: PlanV; proposal: any | null; options: any | null }>(`/plans/${id}/prepare`, {}); set(r.plan); setPrep(r.proposal ? { proposal: r.proposal, options: r.options } : null); });
  const approve = () => act('passkey', async () => { if (!mine) return;
    const assertion = await startAuthentication({ optionsJSON: mine.options });   // the challenge is the fingerprint of this exact step
    setBusy('submit'); await post(`/transfers/proposals/${mine.proposal.id}/approve`, { assertion }); setPrep(null); await q.refetch(); });
  const simple = (path: string, body: unknown = {}) => act(path, async () => { set(await post<PlanV>(`/plans/${id}/${path}`, body)); setPrep(null); });
  const cur = p.legs[p.current], pr = p.proposal, step = Math.min(p.current + 1, p.steps);
  const wait = pr?.bridge ? t(`brStage_${pr.bridge.stage}` as Key) : pr?.xswap ? t(`xsStage_${pr.xswap.stage}` as Key) : null;
  return (
    <div className="space-y-4" data-testid="plan-progress" data-next={p.next} data-current={p.current}>
      <div className="rounded-2xl bg-elev/70 p-4">
        <div className="flex items-center justify-between gap-2 text-[13px] text-mute"><span>{trimAmt(p.amountInDisplay, 8)} {p.from.symbol} · {p.from.networkName} → {p.to.symbol} · {p.to.networkName}</span><PlanPill p={p} /></div>
        {p.state === 'done' ? <><div className="mt-1 text-[13px] text-mute">{t('pnReceived')}</div><div className="text-[24px] font-semibold tracking-tight" data-testid="plan-received">{trimAmt(p.receivedDisplay ?? '', 10)} <span className="text-mute">{p.to.symbol}</span></div></>
          : <><div className="mt-1 text-[13px] text-mute">{t('pnHolding')}</div><div className="text-[22px] font-semibold tracking-tight" data-testid="plan-holding">{trimAmt(p.holding.amountDisplay, 8)} <span className="text-mute">{p.holding.symbol} · {p.holding.networkName}</span></div></>}
        <div className="mt-1 text-[12.5px] text-mute">{p.estimate && p.state !== 'done' ? t('pnEstimateNow', { exp: trimAmt(p.estimate.expectedOutDisplay, 8), worst: trimAmt(p.estimate.worstOutDisplay, 8), sym: p.to.symbol }) : t('pnPlannedLine', { exp: trimAmt(p.plannedExpectedDisplay, 8), worst: trimAmt(p.plannedWorstDisplay, 8), sym: p.to.symbol })}
          {p.floorDisplay ? ` · ${t('pnFloorIs', { floor: trimAmt(p.floorDisplay, 8), sym: p.to.symbol })}` : ''}</div>
      </div>

      <ol className="space-y-4" aria-label={t('pnSteps')}>{p.legs.map((l) => { const [cls, ic] = LEG_TONE[l.state] ?? LEG_TONE.pending!; const here = l.index === p.current && (p.state === 'active' || p.state === 'paused'); return (
        <li key={l.index} className="flex gap-3" data-testid="plan-leg" data-state={l.state}>
          <span className="flex flex-col items-center"><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${cls}`}>{ic ? <Icon n={ic} className="h-3.5 w-3.5" /> : l.index + 1}</span>{l.index < p.legs.length - 1 && <span className="mt-1 w-px flex-1 bg-line" aria-hidden="true" />}</span>
          <div className={`min-w-0 flex-1 pb-1 text-[13px] ${here ? '' : l.state === 'pending' ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-center justify-between gap-x-2"><span className="font-medium">{l.index + 1}. {t(kindKey(l.kind))} · <span className="text-mute">{l.label}{l.speed ? ` · ${t(l.speed === 'fast' ? 'pnFast' : 'pnStandard')}` : ''}</span></span><span className="text-[12px] text-mute">{t(`pnLeg_${l.state}` as Key)}</span></div>
            <div className="mt-1"><Pair a={l.from} b={l.to} /></div>
            {l.state === 'settled'
              ? <div className="mt-1">{trimAmt(l.actual.inDisplay ?? '', 8)} {l.from.symbol} → <span className="font-semibold">{trimAmt(l.actual.outDisplay ?? '', 8)} {l.to.symbol}</span> <span className="text-mute">· {t('pnPlanned')} {trimAmt(l.planned.expectedOutDisplay, 8)}</span></div>
              : <div className="mt-1 text-mute">{t('pnPlanned')} {trimAmt(l.planned.expectedInDisplay, 8)} {l.from.symbol} → {trimAmt(l.planned.expectedOutDisplay, 8)} {l.to.symbol} · {t('pnWorstShort')} {trimAmt(l.planned.worstOutDisplay, 8)} · {dur(l.seconds)}</div>}
            {l.attempts.filter((a) => a.outcome && a.outcome !== 'settled' && a.error).slice(-1).map((a, n) => <div key={n} className="mt-1 text-[12.5px] text-mute">{t('pnLastAttempt')} {a.error}</div>)}
          </div></li>); })}</ol>

      {p.next === 'prepare' && cur && <div className="space-y-3">
        <Notice tone="info">{t('pnReadyNote', { k: step, n: p.steps, amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol })}</Notice>
        <Btn full busy={busy === 'prepare'} onClick={() => void prepare()} data-testid="plan-prepare"><Icon n="swap" className="h-4 w-4" />{t('pnPrepare', { k: step, n: p.steps })}</Btn></div>}

      {p.next === 'approve' && pr && <div className="space-y-3" data-testid="plan-review">
        <div className="rounded-2xl border border-line p-4 text-[13.5px]">
          <div className="mb-2 flex items-center justify-between"><span className="font-semibold">{t('pnReview', { k: step, n: p.steps })}</span><StatePill state={pr.state} /></div>
          <dl className="space-y-1.5">
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('pnYouGive')}</dt><dd className="text-right font-medium">{trimAmt(pr.amountDisplay, 10)} {pr.symbol} · {pr.networkName}</dd></div>
            {pr.bridge ? <div className="flex justify-between gap-3"><dt className="text-mute">{t('pnMinGuaranteed')}</dt><dd className="text-right font-medium">{trimAmt(pr.bridge.minReceiveDisplay, 10)} USDC · {pr.bridge.toNetworkName}</dd></div>
              : pr.swap ? <><div className="flex justify-between gap-3"><dt className="text-mute">{t('pnMinGuaranteed')}</dt><dd className="text-right font-medium" data-testid="plan-minout">{trimAmt(pr.swap.minOutDisplay, 10)} {pr.swap.toSymbol}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-mute">{t('pnExpectedShort')}</dt><dd className="text-right">{trimAmt(pr.swap.expectedOutDisplay, 10)} {pr.swap.toSymbol}</dd></div></> : null}
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('feeMax')}</dt><dd className="text-right">{pr.maxFeeDisplay ? `${trimAmt(pr.maxFeeDisplay, 9)} ${pr.feeSymbol}` : '—'}</dd></div>
            {pr.intentHash && <div><dt className="text-mute">{t('fingerprint')}</dt><dd className="break-all font-mono text-[11px] text-mute">{pr.intentHash}</dd></div>}
          </dl>
        </div>
        {mine ? <><Notice tone="ok">{t('pnStepGuarantee')}</Notice>
          <Btn full busy={busy === 'passkey' || busy === 'submit'} disabled={left === 0} onClick={() => void approve()} data-testid="plan-approve"><Icon n="key" />{busy === 'passkey' ? t('approving') : `${t('approve')} · ${left} s`}</Btn></>
          : <><Notice tone="info">{t('pnReprepare')}</Notice><Btn full busy={busy === 'prepare'} onClick={() => void prepare()} data-testid="plan-prepare"><Icon n="swap" className="h-4 w-4" />{t('pnPrepare', { k: step, n: p.steps })}</Btn></>}
      </div>}

      {p.next === 'wait' && <div className="flex items-center gap-2 rounded-2xl border border-line p-4 text-[13.5px] text-mute" data-testid="plan-wait"><Icon n="spin" className="h-4 w-4 shrink-0" /><span>{t('pnWaiting', { k: step, n: p.steps })}{wait ? ` — ${wait}` : pr ? ` — ${t(`s_${pr.state}` as Key)}` : ''}. {t('pnWaitingNote')}</span></div>}

      {p.state === 'paused' && p.pause && <div className="space-y-3" data-testid="plan-paused" data-code={p.pause.code}>
        <Notice tone="warn"><b>{t(`pnPause_${['floor', 'refused', 'refunded', 'no_funds'].includes(p.pause.code) ? p.pause.code : 'other'}` as Key, { k: p.pause.leg + 1 })}</b> {p.pause.message} {t('pnPausedFunds', { amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol, net: p.holding.networkName })}</Notice>
        {p.pause.code === 'floor' && <label className="block"><span className="mb-1.5 block text-[13px] text-mute">{t('pnFloorChange', { sym: p.to.symbol })}</span>
          <input className={inputCls} inputMode="decimal" placeholder={p.floorDisplay ?? ''} aria-label={t('pnFloorChange', { sym: p.to.symbol })} value={floor} onChange={(e) => setFloor(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))} autoComplete="off" /></label>}
        <Btn full busy={busy === 'retry'} disabled={!!busy} onClick={() => void simple('retry', p.pause?.code === 'floor' && floor !== '' ? { floor: Number(floor) > 0 ? floor : null } : {})} data-testid="plan-retry">{t('pnRetry')}</Btn>
        <Btn full kind="soft" busy={busy === 'replan'} disabled={!!busy} onClick={() => void simple('replan')} data-testid="plan-replan">{t('pnReplan', { sym: p.holding.symbol, net: p.holding.networkName })}</Btn>
        <Btn full kind="ghost" busy={busy === 'stop'} disabled={!!busy} onClick={() => void simple('stop')} data-testid="plan-stop">{t('pnStop')}</Btn>
      </div>}

      {p.state === 'done' && <Notice tone="ok">{t('pnDone', { n: p.steps })}</Notice>}
      {p.state === 'stopped' && <Notice tone="info">{t('pnStopped', { amt: trimAmt(p.holding.amountDisplay, 8), sym: p.holding.symbol, net: p.holding.networkName })}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}
      {p.state === 'active' && p.next !== 'wait' && <button className="min-h-11 w-full text-center text-[13.5px] font-medium text-mute underline" disabled={!!busy} onClick={() => void simple('stop')} data-testid="plan-stop-link">{t('pnStopHere')}</button>}
      {(p.state === 'active' || p.state === 'paused') && <p className="text-[12.5px] text-mute">{t('pnResumable')}</p>}
    </div>);
}

export function PlanSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('pnProgress')}>
      <div className="rise max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 lg:rounded-3xl">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-[20px] font-semibold tracking-tight">{t('pnProgress')}</h2>
          <button onClick={onClose} aria-label={t('swClose')} className="grid h-11 w-11 place-items-center rounded-full text-mute"><Icon n="x" /></button></div>
        <PlanBody id={id} onGone={onClose} />
        <div className="mt-4"><Btn full kind="ghost" onClick={onClose}>{t('swClose')}</Btn></div>
      </div>
    </div>);
}

/** /plan/<id>: the progress view as a page (opened from an alert or a notification). */
export function PlanScreen({ id }: { id: string }) {
  const t = useT();
  return <div className="space-y-4"><h1 className="pt-2 text-[30px] font-semibold tracking-[-0.02em]">{t('pnProgress')}</h1><Card><PlanBody id={id} /></Card>
    <Btn full kind="ghost" onClick={() => goPath('/activity')}>{t('activity')}</Btn></div>;
}

/** Activity: plans in progress first, then the recent ones. Tapping one opens its progress view (and resumes it). */
export function PlanList() {
  const t = useT(); const [show, setShow] = useState<string | null>(null); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => get<{ plans: PlanV[] }>('/plans?limit=5'), refetchInterval: 20_000 });
  const plans = q.data?.plans ?? [];
  if (plans.length === 0) return null;
  return (<>
    <Card className="!p-0"><div className="px-4 pt-3 text-[11.5px] uppercase tracking-wide text-mute">{t('pnListTitle')}</div>
      <ul className="divide-y divide-line" data-testid="plan-list">{plans.map((p) => <li key={p.id}>
        <button className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setShow(p.id)}>
          <span className="min-w-0 flex-1"><span className="block font-medium">{p.from.symbol} ({p.from.networkName}) → {p.to.symbol} ({p.to.networkName})</span>
            <span className="block truncate text-xs text-mute">{t('pnStepOf', { k: Math.min(p.current + 1, p.steps), n: p.steps })} · {trimAmt(p.amountInDisplay, 6)} {p.from.symbol}{p.next === 'prepare' || p.next === 'approve' ? ` · ${t('pnNeedsYou')}` : ''}</span></span>
          <PlanPill p={p} /></button></li>)}</ul></Card>
    {show && <PlanSheet id={show} onClose={() => { setShow(null); void qc.invalidateQueries({ queryKey: ['plans'] }); }} />}
  </>);
}

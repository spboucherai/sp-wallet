// Perp agents (V6): creation form and detail page. SIMULATION only — every figure here belongs to a derivatives paper account.
// Reuses the Futures terminal's building blocks (exact decimals, side / PnL tags, tables) and the agent screen's cards.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { DataTable, PaperTag, Pnl, Seg, SideTag, timeOf, VenueBadge, type Col } from '../derivatives/bits';
import { D, dec, fmt, usd } from '../derivatives/dec';
import type { Fill, FundingPayment, Order, Position, RiskPolicy } from '../derivatives/types';
import { errText, I18n, useT, type Key } from '../i18n';
import { AssetIcon, Btn, Card, Fact, Field, H, Icon, inputCls, Notice, PageTitle, Stat, StatGrid, Tag, usdCapital, when, type Tone } from '../ui';
import { srvText } from '../srvText'; // v11 interface (audit B3): a server sentence without a code is translated when known, quoted as English otherwise
import { amountLocale, amountOf, sanitizeAmountText } from '../amount'; // v8 hardening
import { AmountProblem } from '../amountUi';
import { AgentState, VersionTag } from './Agents';
import { AgentModeBand, GoLiveCard, LiveActivity, LiveControls, LivePanel, PerpLiveState, Refusal } from './PerpAgentLive';   // v7 perp live: the real mode
import { ResearchPanel } from './Research'; // v7 research runtime
import { CardHead, EquityCard, FormGroup, Journal, LogoStack, Metric, PnlArrow, PositionRows, UnitInput } from './agentBits'; // v10 design pass
import { ReportV3, SPLITS, StoppedTag, stopOfSplit } from './labReport'; // v11: the version-3 sections of a backtest report

interface PerpRisk { maxLeverage: number; maxGrossExposureX: number; maxPositionX: number; maxDailyLossPct: number; maxTotalLossPct: number; slippageBps: number; minTradePct: number }
interface VenueInst { symbol: string; id: string; maxLeverage: string; lotSize: string; mark: string | null; volume24h: string | null; eligible: boolean; why: string | null }
interface Venues { venues: { id: string; name: string; instruments: VenueInst[] }[]; maxInstruments: number; intervals: string[]; riskDefaults: PerpRisk; minCapital: string; live: { available: boolean; reason: string } }
const sym = (instrument: string) => instrument.slice(instrument.indexOf(':') + 1);

/** the label nobody can miss: this agent trades a simulated account. No close control: it stays as long as the page is a simulation. */
export function SimulationBanner() {
  const t = useT();
  return <div role="note" data-testid="simulation-banner" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border-2 border-blue/50 bg-blue/10 px-4 py-3" style={{ backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 12px, color-mix(in srgb, var(--blue) 7%, transparent) 12px 24px)' }}>
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue px-2.5 py-1 text-surface"><Icon n="eye" className="h-4 w-4" /><span className="text-[13.5px] font-extrabold uppercase tracking-[0.12em]">{t('paSim')}</span></span>
    <span className="min-w-[12rem] flex-1 text-[13.5px] font-medium leading-snug">{t('paSimText')}</span></div>;
}

// ------------------------------------------------------------------ creation

export function PerpAgentForm({ nav, onCreated }: { nav: Nav; onCreated: () => Promise<void> }) {
  const t = useT();
  const q = useQuery({ queryKey: ['perp-venues'], queryFn: () => get<Venues>('/agents/perp/venues'), staleTime: 60_000 });
  const [f, setF] = useState({ name: '', mission: '', capital: '1000', interval: '1h', instruments: [] as string[], search: '' });
  const [risk, setRisk] = useState<PerpRisk | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const r = risk ?? q.data?.riskDefaults ?? { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };
  const capital = amountOf(f.capital, amountLocale());   // v8: the typed capital → canonical; null while it cannot be read
  const max = q.data?.maxInstruments ?? 8, cap = Number(capital ?? '') || 0;
  const all = q.data?.venues[0]?.instruments ?? [];
  const shown = all.filter((x) => x.eligible && (f.search ? x.symbol.includes(f.search.toUpperCase()) : true)).slice(0, f.search ? 40 : 24);
  const num = (k: keyof PerpRisk, label: string, hint: string, suffix: string, min: number, mx: number, int = false) => <Field label={label} hint={hint}>
    <UnitInput value={String(r[k])} unit={suffix} onChange={(raw) => { const v = Number(raw.replace(',', '.').replace(/[^0-9.]/g, '')) || 0; setRisk({ ...r, [k]: Math.max(min, Math.min(mx, int ? Math.round(v) : v)) }); }} /></Field>;
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const a = await post<{ id: string }>('/agents', { kind: 'perp', name: f.name.trim(), mission: f.mission.trim(), instruments: f.instruments, interval: f.interval, capitalUsdc: capital ?? f.capital, risk: r });
      await onCreated(); nav({ tab: 'agent', asset: a.id });
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const money = (x: number) => x.toLocaleString('fr-CA', { maximumFractionDigits: 0 });
  return (
    <div className="space-y-7">
      <SimulationBanner />
      <FormGroup title={t('dzAgSecIdentity')}>
        <Field label={t('agName')}><input className={inputCls} maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="BTC–ETH pairs" /></Field>
        <Field label={t('agMission')}><textarea className={`${inputCls} min-h-[72px] resize-none`} maxLength={400} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
      </FormGroup>

      <FormGroup title={t('paInstruments', { max })} right={<VenueBadge venue="hyperliquid" />}>
        <span className="relative block"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
          <input className={`${inputCls} !pl-11`} value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} placeholder={t('paSearch')} aria-label={t('paSearch')} /></span>
        {q.isLoading ? <div className="flex flex-wrap gap-2" aria-hidden="true">{[92, 88, 96, 84, 100, 90].map((w, k) => <div key={k} className="skel h-11 !rounded-full" style={{ width: w }} />)}</div> : q.isError ? <Notice tone="danger">{errText(t, q.error)}</Notice> : <div className="flex flex-wrap gap-2">{shown.map((x) => { const on = f.instruments.includes(x.symbol), full = !on && f.instruments.length >= max; return (
          <button key={x.symbol} type="button" role="checkbox" aria-checked={on} disabled={full} title={`max ${x.maxLeverage}x · lot ${x.lotSize}`} onClick={() => setF({ ...f, instruments: on ? f.instruments.filter((s) => s !== x.symbol) : [...f.instruments, x.symbol] })}
            className={`press inline-flex min-h-11 items-center gap-2 rounded-full border py-1 pl-2 pr-3.5 text-[14px] font-medium ${on ? 'border-primary bg-primary text-onprimary' : 'border-line bg-surface'} ${full ? 'opacity-40' : ''}`}><AssetIcon sym={x.symbol} size={26} />{x.symbol}<span className="text-[11.5px] font-normal opacity-75">{x.maxLeverage}x</span>{on && <Icon n="check" className="h-4 w-4" />}</button>); })}</div>}
        {f.instruments.length > 0 && <p className="flex flex-wrap items-center gap-2 text-[13.5px]"><LogoStack syms={f.instruments} size={22} max={8} /><span>{t('paChosen')} <span className="font-semibold">{f.instruments.join(' · ')}</span></span></p>}
        <p className="text-[12.5px] leading-snug text-mute">{t('paInstrumentsNote')}</p>
      </FormGroup>

      <FormGroup title={t('dzAgSecCapital')}>
        <Field label={t('paCapital')} hint={t('paCapitalHint', { min: q.data?.minCapital ?? '50' })}><span className="relative block"><input className={`${inputCls} t-num !py-3 pr-20 text-[22px]`} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: sanitizeAmountText(e.target.value) })} /><span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-medium text-mute">USDC</span></span><AmountProblem text={f.capital} /></Field>
        <div><div className="mb-1.5 text-[13px] font-medium text-mute">{t('agInterval')}</div>
          <Seg<string> value={f.interval} onChange={(v) => setF({ ...f, interval: v })} label={t('agInterval')} options={(q.data?.intervals ?? ['1h', '4h']).map((i) => ({ id: i, label: i.replace('h', ' h') }))} />
          <p className="mt-1.5 text-xs text-mute">{t('paIntervalHint')}</p></div>
      </FormGroup>

      <FormGroup title={t('paLimits')}>
        <p className="text-[12.5px] leading-snug text-mute">{t('paLimitsNote')}</p>
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
          {num('maxLeverage', t('paMaxLev'), t('paMaxLevHint', { usd: money(cap * r.maxLeverage) }), '×', 1, 5, true)}
          {num('maxGrossExposureX', t('paMaxGross'), t('paMaxGrossHint', { usd: money(cap * r.maxGrossExposureX) }), '× cap.', 0.1, 5)}
          {num('maxPositionX', t('paMaxPos'), t('paMaxPosHint', { usd: money(cap * r.maxPositionX) }), '× cap.', 0.05, 5)}
          {num('slippageBps', t('paSlip'), t('paSlipHint'), 'bps', 5, 100, true)}
          {num('maxDailyLossPct', t('paDailyLoss'), t('paDailyLossHint', { usd: money((cap * r.maxDailyLossPct) / 100) }), '%', 0.5, 50)}
          {num('maxTotalLossPct', t('paTotalLoss'), t('paTotalLossHint', { usd: money((cap * r.maxTotalLossPct) / 100) }), '%', 1, 90)}
        </div>
        <Notice tone="warn">{t('paLossNote')}</Notice>
      </FormGroup>
      {err && <Notice tone="danger">{err}</Notice>}
      <Btn full busy={busy} disabled={f.name.trim().length < 2 || !f.instruments.length || f.instruments.length > max || cap < Number(q.data?.minCapital ?? 50) || r.maxDailyLossPct > r.maxTotalLossPct} onClick={() => void create()}>{t('paCreate')}</Btn>
    </div>
  );
}

// ------------------------------------------------------------------ detail

const SIG_TONE: Record<string, [Tone, string]> = { done: ['ok', 'check'], hold: ['warn', 'clock'], decided: ['info', 'key'] };
type Tab = 'orders' | 'fills' | 'funding' | 'events';
export function PerpAgentDetail({ a, id, nav }: { a: any; id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const lib = useQuery({ queryKey: ['strategies-perp'], queryFn: () => get<{ strategies: any[] }>('/strategies?kind=perp'), staleTime: 300_000 });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [note, setNote] = useState(''), [tab, setTab] = useState<Tab>('orders');
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); setNote(''); try { await fn(); await qc.invalidateQueries({ queryKey: ['agent', id] }); await qc.invalidateQueries({ queryKey: ['agents'] }); } catch (e) { const m = errText(t, e); if (m) setErr(m); } finally { setBusy(''); } };
  const acct = a.account as null | { state: any; policy: RiskPolicy; totals: any; positions: Position[]; orders: Order[]; fills: Fill[]; funding: FundingPayment[]; riskEvents: { id: number; ts: number; kind: string; code: string | null; message: string }[]; equity: { ts: number; equity: string }[] };
  const risk = a.risk as PerpRisk, approved = (a.versions as any[]).find((v) => v.id === a.strategyVersionId);
  // >>> v7 perp live: in real mode the page shows the VENUE account (PerpAgentLive.tsx); the paper account is not shown as if it were it
  const isLive = a.mode === 'LIVE', liveActive = !!a.live?.active, pol = isLive ? undefined : acct?.policy;
  // <<< v7 perp live
  const eq = (acct?.equity ?? []).map((e) => ({ t: e.ts, p: Number(e.equity) }));
  const result = acct ? D.sub(D.from(acct.state.equity), D.from(a.capitalUsdc)) : null;
  const pctOf = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)} %` : '—'), n2 = (x: unknown) => (typeof x === 'number' ? x.toFixed(2) : '—');
  const px = (x: string | null | undefined) => fmt(x, { locale, trim: true });

  const ordCols: Col<Order>[] = [
    { id: 't', label: t('paColTime'), cell: (o) => timeOf(o.createdAt, locale, true) },
    { id: 'i', label: t('paColInst'), head: true, cell: (o) => <span className="font-semibold">{sym(o.instrument)}</span> },
    { id: 's', label: t('paColSide'), head: true, cell: (o) => <span className="inline-flex items-center gap-2"><SideTag side={o.side} />{o.reduceOnly && <span className="rounded bg-elev px-1.5 text-[11px] font-semibold text-mute">{t('paReduceOnly')}</span>}</span> },
    { id: 'z', label: t('paColSize'), num: true, cell: (o) => `${px(o.filled)} / ${px(o.size)}` },
    { id: 'p', label: t('paColAvg'), num: true, cell: (o) => px(o.avgFillPrice) },
    { id: 'w', label: t('paColWorst'), num: true, cell: (o) => px(o.price) },
    { id: 'x', label: t('paColStatus'), cell: (o) => <span title={o.rejectReason ?? ''}>{o.status}{o.rejectReason ? ' ⓘ' : ''}</span> },
  ];
  const fillCols: Col<Fill>[] = [
    { id: 't', label: t('paColTime'), cell: (x) => timeOf(x.ts, locale, true) },
    { id: 'i', label: t('paColInst'), head: true, cell: (x) => <span className="font-semibold">{sym(x.instrument)}</span> },
    { id: 's', label: t('paColSide'), head: true, cell: (x) => <SideTag side={x.side} /> },
    { id: 'z', label: t('paColSize'), num: true, cell: (x) => px(x.size) },
    { id: 'p', label: t('paColPrice'), num: true, cell: (x) => px(x.price) },
    { id: 'f', label: t('paColFee'), num: true, cell: (x) => usd(x.fee, locale) },
    { id: 'c', label: t('paColClosed'), num: true, cell: (x) => <Pnl value={x.closedPnl} locale={locale} /> },
  ];
  const fundCols: Col<FundingPayment>[] = [
    { id: 't', label: t('paColTime'), cell: (x) => timeOf(x.ts, locale, true) },
    { id: 'i', label: t('paColInst'), head: true, cell: (x) => <span className="font-semibold">{sym(x.instrument)}</span> },
    { id: 'r', label: t('paColRate'), num: true, cell: (x) => `${fmt(D.mul(D.from(x.rate), D.from(100n)), { dp: 5, locale })} %` },
    { id: 'z', label: t('paColSize'), num: true, cell: (x) => px(x.size) },
    { id: 'a', label: t('paColAmount'), num: true, cell: (x) => <Pnl value={x.amount} locale={locale} dp={4} /> },
  ];
  const evCols: Col<{ id: number; ts: number; kind: string; code: string | null; message: string }>[] = [
    { id: 't', label: t('paColTime'), cell: (x) => timeOf(x.ts, locale, true) },
    { id: 'k', label: t('paColKind'), head: true, cell: (x) => <span className="font-semibold">{x.kind}{x.code ? ` · ${x.code}` : ''}</span> },
    { id: 'm', label: '', full: true, cell: (x) => <span className="whitespace-normal text-mute" lang="en">{x.message}</span> },
  ];

  const have = new Set((a.versions as any[]).map((v) => v.code_sha256)), uni = [...(a.universe as string[])].sort().join();
  // v11: a universe-generic strategy (['*']) fits any agent whose number of instruments is within its bounds; a fixed one needs exactly these
  const nInst = (a.universe as string[]).length;
  const fit = (lib.data?.strategies ?? []).filter((x) => !have.has(x.sha256) && !x.spotLegs && x.meta.interval === a.interval && (x.generic ? nInst >= x.minSymbols && nInst <= x.maxSymbols : [...x.meta.universe].sort().join() === uni));

  return (
    <div className="space-y-4">
      {/* 1 — the state: the agent, the money it moves (SIMULATION, or the band of the real mode) */}
      <div><PageTitle onBack={() => nav({ tab: 'agents' })} backLabel={t('back')}>{a.name}</PageTitle>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13.5px] text-mute"><LogoStack syms={a.universe as string[]} size={24} max={5} /><span>{(a.universe as string[]).join(' · ')} · {a.interval} · {t('paPerps')}</span><VenueBadge venue="hyperliquid" />
          {/* v7 perp live: the state and the money it moves (the title keeps its width on a phone) */}
          {isLive ? <PerpLiveState a={a} /> : <AgentState state={a.state} />}</div>
        {a.mission && <p className="mt-2.5 text-[14.5px] leading-snug text-mute">{a.mission}</p>}</div>
      {isLive ? <AgentModeBand a={a} /> : <SimulationBanner />}
      {a.stopReason && !(isLive && a.live?.exit) && <Notice tone="warn">{srvText(t, locale, a.stopReason)}</Notice>}{/* v7: a live agent's stop is said in the screen's language by LivePanel; the server's sentence is its detail */}
      {a.flattening && a.state !== 'STOPPED' && <Notice tone="danger">{t('paFlattening')} {srvText(t, locale, a.flattening.reason)}</Notice>}
      {a.flag && <Notice tone="warn">{t('paFlag')} {srvText(t, locale, a.flag.message)} ({when(new Date(a.flag.ts), locale)})</Notice>}
      {a.hold && (a.state === 'PAPER_TRADING' || a.state === 'LIVE') && <Notice tone="info">{t('paHold')} {srvText(t, locale, a.hold.reason)}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}{note && <Notice tone="ok">{note}</Notice>}

      {/* 2 — the money: the venue account in real mode, the paper account in simulation; then its curve */}
      {isLive && <LivePanel a={a} id={id} nav={nav} />}
      {!isLive && <div className="space-y-4">
        <Card><CardHead right={<PaperTag />}>{t('paAccount')}</CardHead>
          {!acct ? <div className="flex items-center gap-3.5 rounded-2xl bg-elev/60 px-4 py-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface text-mute"><Icon n="eye" /></span><p className="text-[14px] leading-snug text-mute">{t('paNoAccount')}</p></div> : <>
            <div className="t-display text-[clamp(34px,10.5vw,44px)]">{usd(acct.state.equity, locale)}</div>
            <div className="mt-2 space-y-0.5 text-[13.5px] text-mute"><div>{t('hdPaAllocated', { capital: usdCapital(a.capitalUsdc, locale) })}</div><div>{t('paResult')} <span className="font-semibold"><PnlArrow value={result ? D.str(result) : null} locale={locale} /></span></div></div>
            <StatGrid cols={4} className="mt-4">
              <Stat label={t('paCollateral')} value={usd(acct.state.collateral, locale)} /><Stat label={t('paMarginUsed')} value={usd(acct.state.marginUsed, locale)} />
              <Stat label={t('paFree')} value={usd(acct.state.freeCollateral, locale)} /><Stat label={t('paRealised')} value={<PnlArrow value={acct.totals?.realizedPnl} locale={locale} />} />
              <Stat label={t('paFees')} value={usd(acct.totals?.feesPaid, locale)} /><Stat label={t('paFundingNet')} value={<PnlArrow value={acct.totals?.fundingNet} locale={locale} dp={4} />} />
              <Stat label={t('paLiquidations')} value={acct.totals?.liquidations ?? 0} /><Stat label={t('paLastBar')} value={<span className="text-[15px]">{a.lastBar ? when(a.lastBar, locale) : '—'}</span>} />
            </StatGrid>
            <div className="mt-5"><div className="t-eyebrow mb-2">{t('paPositions')}</div>
              <PositionRows positions={acct.positions} venue="hyperliquid" locale={locale} px={px} empty={t('paNoPositions')} approxLiq liqTitle={t('paLiqTitle')} label={t('paPositions')} /></div>
            <p className="mt-3 text-[12.5px] leading-snug text-mute">{t('paSimplifications')}</p>
            {acct.positions.length > 0 && <Btn kind="ghost" full className="mt-3" busy={busy === 'flat'} onClick={() => act('flat', async () => { const r = await post<{ orders: unknown[]; positionsLeft: number }>(`/agents/${id}/perp/flatten`); setNote(t('paFlattened', { n: r.orders.length, left: r.positionsLeft })); })}>{t('paFlatten')}</Btn>}
          </>}
        </Card>
        <EquityCard title={t('paEquity')} right={<PaperTag />} points={eq} format={(v) => usd(dec(v.toFixed(2)), locale)} formatTime={(ts) => timeOf(ts, locale, true)} testid="pa-equity" />
      </div>}

      {/* 3 — what it is doing: its limits, its strategy, the research */}
      <div className="space-y-4">
      <div className="min-w-0 space-y-4">
      <Card><H>{t('paLimits')}</H>
        <dl>
          <Fact k={t('paMaxLev')}>{risk.maxLeverage}× <span className="font-normal text-mute">{!isLive && <>({t('paPolicy')} {pol?.maxLeverage ?? '—'}×)</>}</span></Fact>
          <Fact k={t('paMaxGross')}>{risk.maxGrossExposureX}×{!isLive && <> → {usd(pol?.maxGrossExposure, locale)}</>}</Fact>
          <Fact k={t('paMaxPos')}>{risk.maxPositionX}×{!isLive && <> → {usd(pol?.maxPositionNotional, locale)}</>}</Fact>
          <Fact k={t('paDailyLoss')}>{risk.maxDailyLossPct} %{!isLive && <> → {usd(pol?.maxDailyLoss, locale)}</>}</Fact>
          <Fact k={t('paTotalLoss')}>{risk.maxTotalLossPct} %{!isLive && <> → {usd(pol?.maxTotalLoss, locale)}</>}</Fact>
          <Fact k={t('paSlip')}>{risk.slippageBps} bps</Fact>
        </dl>
        {pol?.halt && <div className="mt-2"><Notice tone="danger">{t('paHalt')} {pol.halt}</Notice></div>}
        <p className="mt-2 text-[12.5px] leading-snug text-mute">{t('paLimitsNote')}</p>
      </Card>

      <div id="pl-strategy" className="scroll-mt-24" /><Card><H>{t('agStrategy')}</H>
        {(a.versions as any[]).length === 0 ? <p className="text-[14px] leading-snug text-mute">{t('paNoStrategy')}</p> : <ul className="space-y-3">{(a.versions as any[]).map((v) => { const s = v.summary; return <li key={v.id} className={`rounded-2xl border p-4 ${v.id === a.strategyVersionId ? 'border-emerald/35' : 'border-line'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[15.5px] font-semibold">{v.name} <span className="font-normal text-mute">v{v.version}</span></span><VersionTag status={v.status} /></div>
          <div className="mt-1 break-all font-mono text-[11px] text-mute">sha256 {v.code_sha256}</div>
          {s ? <>
            <dl className="mt-3 rounded-2xl bg-elev/60 px-3.5 py-1">
              <Metric label={t('agRet')} value={pctOf(s.metrics.test?.total_return)} sub={<>{t('paVsPerp')} {pctOf(s.benchmarks.perp_long_1x?.total_return)}</>} />
              <Metric label="Sharpe" value={n2(s.metrics.test?.sharpe)} sub={<>[{n2(s.robustness?.bootstrap_sharpe_ci?.[0])} … {n2(s.robustness?.bootstrap_sharpe_ci?.[1])}]</>} />
              <Metric label={t('agDD')} value={pctOf(s.metrics.test?.max_drawdown)} sub={<>{t('paIntrabar')} {pctOf(s.metrics.test?.worst_intrabar_drawdown)}</>} /></dl>
            {/* v11: a split the engine's own loss limit ended reads as a flat curve — it is said next to the figures, not left to be guessed */}
            {SPLITS.map((k) => { const st = stopOfSplit(s, k); return st ? <div key={k} className="mt-2"><StoppedTag split={k} stop={st} /></div> : null; })}
            <ReportV3 summary={s} />
            <div className="mt-3 rounded-2xl border border-warn/30 bg-warn/[0.09] p-3.5 text-[13px] leading-snug"><div className="mb-1.5 flex items-center gap-2 font-semibold"><Icon n="warn" className="h-4 w-4 shrink-0 text-warn" />{t('paCaveats')}</div><ul className="list-disc space-y-1.5 pl-5">
              <li>{t('paCavHistory', { days: s.historyDays ?? '?', bars: s.config?.bars ?? '?', interval: s.config?.interval ?? a.interval })}</li>
              <li>{t('paCavEstimates', { fee: s.config?.fee_bps ?? '?', slip: s.config?.slippage_bps ?? '?', pen: s.config?.liquidation_penalty_bps ?? '?' })}</li>
              <li className={s.liquidations.train + s.liquidations.validation + s.liquidations.test > 0 || s.metrics.test?.wiped_out ? 'font-semibold text-danger' : ''}>{t('paCavLiq', { train: s.liquidations.train, val: s.liquidations.validation, test: s.liquidations.test })}{s.metrics.test?.wiped_out ? ` ${t('paCavWiped')}` : ''}</li>
              <li>{t('paCavDsr', { dsr: typeof s.robustness?.deflated_sharpe === 'number' ? s.robustness.deflated_sharpe.toFixed(3) : '?', trials: s.robustness?.trials_tested ?? '?' })}</li>
              <li>{t('paCavChecks', { look: s.checks?.lookahead ?? '?', data: s.checks?.data_quality ?? '?', ledger: s.checks?.ledger ?? '?', fund: s.checks?.funding_alignment ?? '?' })}</li>
              {!s.buyAndHoldIsSpot && <li>{t('paCavNoSpot')}</li>}
              <li>{t('paCavNever')}</li></ul></div>
            {s.problem && <div className="mt-2"><Notice tone="danger">{t('paNotApprovable')} {s.problem}</Notice></div>}
          </> : <p className="mt-2 flex items-start gap-2 text-[13px] leading-snug text-mute">{v.status === 'backtesting' && <Icon n="spin" className="mt-0.5 h-4 w-4 shrink-0" />}<span>{v.status === 'backtesting' ? t('paBacktesting') : v.notes ? v.notes : t('agNoReport')}</span></p>}
          {v.status !== 'approved' && s && !s.problem && !liveActive && <Btn kind="soft" full className="mt-3" busy={busy === `a${v.id}`} onClick={() => act(`a${v.id}`, () => post(`/agents/${id}/strategies/${v.id}/approve`))}>{t('agApproveVersion')}</Btn>}
        </li>; })}</ul>}
        <div className="mt-5 border-t border-line pt-4"><div className="t-eyebrow mb-2.5">{t('paLibrary')}</div>
          {lib.isLoading ? <div className="space-y-2" aria-hidden="true"><div className="skel h-[68px] !rounded-2xl" /></div> : fit.length === 0 ? <p className="text-[13.5px] leading-snug text-mute">{t('paLibNone', { assets: (a.universe as string[]).join(', '), interval: a.interval })}</p> :
            <ul className="divide-y divide-line">{fit.map((x) => <li key={x.sha256} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">{x.meta.name} <span className="font-normal text-mute">v{x.meta.version}</span></span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-mute [overflow-wrap:anywhere]">{x.generic ? (a.universe as string[]).join(' · ') : x.meta.universe.join(' · ')} · {x.meta.interval} · {t('paBounds', { lev: x.meta.max_leverage, gross: x.meta.max_gross_exposure })}</span></span>
              <Btn kind="soft" className="shrink-0" busy={busy === `r${x.sha256}`} onClick={() => act(`r${x.sha256}`, () => post(`/agents/${id}/strategies`, { path: x.path.replace(/^strategies\//, '') }))}>{t('agLibTest')}</Btn></li>)}</ul>}</div>
      </Card>
      </div>

      {/* v7 research runtime */}<ResearchPanel agent={a} nav={nav} />
      </div>

      {/* 4 — what it did: the account's activity, the signals, the journal */}
      {isLive && <LiveActivity a={a} />}
      {acct && !isLive && <Card><CardHead right={<PaperTag />}>{t('paActivity')}</CardHead>
        <Seg<Tab> value={tab} onChange={setTab} label={t('paActivity')} tabs size="sm" className="mb-3" options={[{ id: 'orders', label: `${t('paOrders')} (${acct.orders.length})` }, { id: 'fills', label: `${t('paFills')} (${acct.fills.length})` }, { id: 'funding', label: `${t('paFunding')} (${acct.funding.length})` }, { id: 'events', label: `${t('paEvents')} (${acct.riskEvents.length})` }]} />
        {tab === 'orders' && <DataTable cols={ordCols} rows={acct.orders} rowKey={(o) => o.clientId} empty={t('paNone')} label={t('paOrders')} />}
        {tab === 'fills' && <DataTable cols={fillCols} rows={acct.fills} rowKey={(x) => x.id} empty={t('paNone')} label={t('paFills')} />}
        {tab === 'funding' && <DataTable cols={fundCols} rows={acct.funding} rowKey={(x) => `${x.instrument}:${x.ts}`} empty={t('paNone')} label={t('paFunding')} />}
        {tab === 'events' && <DataTable cols={evCols} rows={acct.riskEvents} rowKey={(x) => String(x.id)} empty={t('paNone')} label={t('paEvents')} />}
      </Card>}

      <div className="space-y-4">
      <Card><H>{t('paSignals')}</H>
        {(a.signals as any[]).length === 0 ? <p className="text-[14px] leading-snug text-mute">{t('paNoSignals')}</p> : <ul className="divide-y divide-line text-[13px]">{(a.signals as any[]).slice(0, 24).map((s) => { const [tone, icon] = SIG_TONE[s.status] ?? (['mute', 'minus'] as [Tone, string]); return <li key={s.bar} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[14px] font-semibold">{when(s.bar, locale)}</span><Tag tone={tone} icon={icon}>{s.status === 'decided' ? t('plSig_decided') : t(`paSig_${s.status}` as Key)}</Tag></div>
          {s.reason && <div className="mt-1 leading-snug text-mute">{srvText(t, locale, s.reason)}</div>}
          {s.weights && <div className="mt-1 font-mono text-[11.5px] text-mute [overflow-wrap:anywhere]">{t('paWeights')} {Object.entries(s.weights as Record<string, number>).map(([k, w]) => `${k} ${w >= 0 ? '+' : ''}${w.toFixed(3)}`).join('  ')}{s.scale && s.scale !== '1' ? `  × ${Number(s.scale).toFixed(3)} (${s.orders?.binding})` : ''}</div>}
          {s.targets && <div className="font-mono text-[11.5px] text-mute [overflow-wrap:anywhere]">{t('paTargets')} {Object.entries(s.targets as Record<string, string>).map(([k, z]) => `${k} ${z}`).join('  ')}</div>}
          {(s.orders?.list ?? []).length > 0 && <ul className="mt-1.5 space-y-1">{(s.orders.list as any[]).map((o, k) => <li key={k} className="text-[12.5px]"><SideTag side={o.side} /> {o.symbol} {o.size}{o.reduceOnly ? ` · ${t('paReduceOnly')}` : ''} → <span className="font-medium">{o.status === 'deferred' ? t('plSig_deferred') : o.status}</span>{o.code && isLive ? <span className="mt-0.5 block text-mute"><Refusal code={String(o.code)} reason={o.why ? String(o.why).slice(0, 200) : undefined} /></span> : o.why ? <span className="text-mute"> — {String(o.why).slice(0, 160)}</span> : null}</li>)}</ul>}
        </li>; })}</ul>}
      </Card>

      <Card><H>{t('agLog')}</H>
        <Journal empty={t('agNoLog')} items={(a.log as any[]).map((l, k) => ({ key: String(k), title: l.title, time: when(l.ts, locale), body: l.body ? <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String(l.body).slice(0, 600)}</span> : undefined }))} /></Card>
      </div>

      {/* 5 — the controls, last */}
      {isLive && <LiveControls a={a} id={id} />}
      {/* >>> v7 perp live: while a mandate is in force the controls are LiveControls above; the go-live checklist comes back when it ends */}
      {liveActive ? <p className="px-1 text-[13.5px] leading-snug text-mute">{t('plBandLive')}</p> : <Card><H>{t('agControl')}</H>
        <div className="grid gap-2.5 empty:hidden">
          {approved && ['AWAITING_APPROVAL', 'PAUSED', 'STOPPED', 'CREATED'].includes(a.state) && <Btn kind="soft" full busy={busy === 'paper'} onClick={() => act('paper', () => post(`/agents/${id}/mode`, { mode: 'PAPER' }))} data-testid="pa-start-paper">{t(isLive ? 'plBackPaper' : 'paStart')}</Btn>}
          {a.state === 'PAPER_TRADING' && <Btn kind="ghost" full busy={busy === 'pause'} onClick={() => act('pause', () => post(`/agents/${id}/mode`, { mode: 'PAUSED' }))}><Icon n="clock" className="h-4 w-4 shrink-0" />{t('agPause')}</Btn>}
          {['PAPER_TRADING', 'PAUSED'].includes(a.state) && <Btn kind="ghost" full className="!border-danger/40 !text-danger" busy={busy === 'stop'} onClick={() => act('stop', () => post(`/agents/${id}/mode`, { mode: 'STOPPED' }))}><Icon n="stop" className="h-4 w-4 shrink-0" />{t('paStop')}</Btn>}
        </div>
        {!approved && <p className="text-[13.5px] leading-snug text-mute">{t('agNeedsStrategy')}</p>}
        <div className="mt-4"><GoLiveCard a={a} id={id} nav={nav} /></div>
      </Card>}
      {/* <<< v7 perp live */}
    </div>
  );
}

// Perp agents (V6): creation form and detail page. SIMULATION only — every figure here belongs to a derivatives paper account.
// Reuses the Futures terminal's building blocks (exact decimals, side / PnL tags, tables) and the agent screen's cards.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { PriceChart } from '../chart';
import { DataTable, PaperTag, Pnl, Row, Seg, SideTag, Stat, timeOf, VenueBadge, type Col } from '../derivatives/bits';
import { D, dec, fmt, usd } from '../derivatives/dec';
import type { Fill, FundingPayment, Order, Position, RiskPolicy } from '../derivatives/types';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Field, H, Icon, inputCls, Notice, Skeleton, when } from '../ui';
import { AgentState } from './Agents';
import { AgentModeBand, GoLiveCard, LivePanel, PerpLiveState, Refusal } from './PerpAgentLive';   // v7 perp live: the real mode
import { ResearchPanel } from './Research'; // v7 research runtime

interface PerpRisk { maxLeverage: number; maxGrossExposureX: number; maxPositionX: number; maxDailyLossPct: number; maxTotalLossPct: number; slippageBps: number; minTradePct: number }
interface VenueInst { symbol: string; id: string; maxLeverage: string; lotSize: string; mark: string | null; volume24h: string | null; eligible: boolean; why: string | null }
interface Venues { venues: { id: string; name: string; instruments: VenueInst[] }[]; maxInstruments: number; intervals: string[]; riskDefaults: PerpRisk; minCapital: string; live: { available: boolean; reason: string } }
const sym = (instrument: string) => instrument.slice(instrument.indexOf(':') + 1);

/** the label nobody can miss: this agent trades a simulated account */
export function SimulationBanner() {
  const t = useT();
  return <div role="note" className="flex items-center gap-3 rounded-2xl border-2 border-blue/50 bg-blue/10 px-4 py-3">
    <span className="rounded-md bg-blue px-2.5 py-1 text-[13px] font-extrabold uppercase tracking-[0.12em] text-white">{t('paSim')}</span>
    <span className="text-[13.5px] leading-snug">{t('paSimText')}</span></div>;
}

// ------------------------------------------------------------------ creation

export function PerpAgentForm({ nav, onCreated }: { nav: Nav; onCreated: () => Promise<void> }) {
  const t = useT();
  const q = useQuery({ queryKey: ['perp-venues'], queryFn: () => get<Venues>('/agents/perp/venues'), staleTime: 60_000 });
  const [f, setF] = useState({ name: '', mission: '', capital: '1000', interval: '1h', instruments: [] as string[], search: '' });
  const [risk, setRisk] = useState<PerpRisk | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const r = risk ?? q.data?.riskDefaults ?? { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };
  const max = q.data?.maxInstruments ?? 8, cap = Number(f.capital) || 0;
  const all = q.data?.venues[0]?.instruments ?? [];
  const shown = all.filter((x) => x.eligible && (f.search ? x.symbol.includes(f.search.toUpperCase()) : true)).slice(0, f.search ? 40 : 24);
  const num = (k: keyof PerpRisk, label: string, hint: string, suffix: string, min: number, mx: number, int = false) => <Field label={label} hint={hint}><div className="flex items-center gap-2">
    <input className={inputCls} inputMode="decimal" value={String(r[k])} onChange={(e) => { const v = Number(e.target.value.replace(',', '.').replace(/[^0-9.]/g, '')) || 0; setRisk({ ...r, [k]: Math.max(min, Math.min(mx, int ? Math.round(v) : v)) }); }} />
    <span className="w-12 shrink-0 text-[13px] text-mute">{suffix}</span></div></Field>;
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const a = await post<{ id: string }>('/agents', { kind: 'perp', name: f.name.trim(), mission: f.mission.trim(), instruments: f.instruments, interval: f.interval, capitalUsdc: f.capital, risk: r });
      await onCreated(); nav({ tab: 'agent', asset: a.id });
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const money = (x: number) => x.toLocaleString('fr-CA', { maximumFractionDigits: 0 });
  return (
    <div className="space-y-4">
      <SimulationBanner />
      <Field label={t('agName')}><input className={inputCls} maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="BTC–ETH pairs" /></Field>
      <Field label={t('agMission')}><textarea className={`${inputCls} min-h-[72px] resize-none`} maxLength={400} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
      <div><div className="mb-2 flex items-center justify-between gap-2 text-[13px] text-mute"><span>{t('paInstruments', { max })}</span><VenueBadge venue="hyperliquid" /></div>
        <input className={`${inputCls} mb-2`} value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} placeholder={t('paSearch')} aria-label={t('paSearch')} />
        {q.isLoading ? <Skeleton h="h-16" /> : q.isError ? <Notice tone="danger">{errText(t, q.error)}</Notice> : <div className="flex flex-wrap gap-2">{shown.map((x) => { const on = f.instruments.includes(x.symbol), full = !on && f.instruments.length >= max; return (
          <button key={x.symbol} type="button" role="checkbox" aria-checked={on} disabled={full} title={`max ${x.maxLeverage}x · lot ${x.lotSize}`} onClick={() => setF({ ...f, instruments: on ? f.instruments.filter((s) => s !== x.symbol) : [...f.instruments, x.symbol] })}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'} ${full ? 'opacity-40' : ''}`}>{x.symbol}<span className="text-[11.5px] font-normal opacity-75">{x.maxLeverage}x</span></button>); })}</div>}
        {f.instruments.length > 0 && <p className="mt-2 text-[13px]">{t('paChosen')} <span className="font-semibold">{f.instruments.join(' · ')}</span></p>}
        <p className="mt-2 text-[12.5px] text-mute">{t('paInstrumentsNote')}</p></div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('paCapital')} hint={t('paCapitalHint', { min: q.data?.minCapital ?? '50' })}><div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: e.target.value.replace(',', '.').replace(/[^0-9.]/g, '') })} /><span className="w-12 shrink-0 text-[13px] text-mute">USDC</span></div></Field>
        <Field label={t('agInterval')} hint={t('paIntervalHint')}><select className={inputCls} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}>{(q.data?.intervals ?? ['1h', '4h']).map((i) => <option key={i} value={i}>{i.replace('h', ' h')}</option>)}</select></Field>
      </div>
      <div><div className="mb-2 text-[15px] font-semibold">{t('paLimits')}</div><p className="mb-3 text-[12.5px] text-mute">{t('paLimitsNote')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {num('maxLeverage', t('paMaxLev'), t('paMaxLevHint', { usd: money(cap * r.maxLeverage) }), '×', 1, 5, true)}
          {num('maxGrossExposureX', t('paMaxGross'), t('paMaxGrossHint', { usd: money(cap * r.maxGrossExposureX) }), '× cap.', 0.1, 5)}
          {num('maxPositionX', t('paMaxPos'), t('paMaxPosHint', { usd: money(cap * r.maxPositionX) }), '× cap.', 0.05, 5)}
          {num('slippageBps', t('paSlip'), t('paSlipHint'), 'bps', 5, 100, true)}
          {num('maxDailyLossPct', t('paDailyLoss'), t('paDailyLossHint', { usd: money((cap * r.maxDailyLossPct) / 100) }), '%', 0.5, 50)}
          {num('maxTotalLossPct', t('paTotalLoss'), t('paTotalLossHint', { usd: money((cap * r.maxTotalLossPct) / 100) }), '%', 1, 90)}
        </div></div>
      <Notice tone="warn">{t('paLossNote')}</Notice>
      {err && <Notice tone="danger">{err}</Notice>}
      <Btn full busy={busy} disabled={f.name.trim().length < 2 || !f.instruments.length || f.instruments.length > max || cap < Number(q.data?.minCapital ?? 50) || r.maxDailyLossPct > r.maxTotalLossPct} onClick={() => void create()}>{t('paCreate')}</Btn>
    </div>
  );
}

// ------------------------------------------------------------------ detail

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

  const posCols: Col<Position>[] = [
    { id: 'i', label: t('paColInst'), head: true, cell: (p) => <span className="font-semibold">{sym(p.instrument)}</span> },
    { id: 's', label: t('paColSide'), head: true, cell: (p) => <SideTag side={p.side} /> },
    { id: 'z', label: t('paColSize'), num: true, cell: (p) => px(p.size) },
    { id: 'e', label: t('paColEntry'), num: true, cell: (p) => px(p.entryPrice) },
    { id: 'm', label: t('paColMark'), num: true, cell: (p) => px(p.markPrice) },
    { id: 'l', label: t('paColLev'), num: true, cell: (p) => `${px(p.leverage)}×` },
    { id: 'q', label: t('paColLiq'), num: true, cell: (p) => (p.liquidationPrice ? <span title={t('paLiqTitle')}>≈ {px(p.liquidationPrice)}</span> : <span className="text-mute">—</span>) },
    { id: 'u', label: t('paColPnl'), num: true, cell: (p) => <Pnl value={p.unrealizedPnl} locale={locale} /> },
  ];
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
    { id: 'm', label: '', full: true, cell: (x) => <span className="whitespace-normal text-mute">{x.message}</span> },
  ];

  const have = new Set((a.versions as any[]).map((v) => v.code_sha256)), uni = [...(a.universe as string[])].sort().join();
  const fit = (lib.data?.strategies ?? []).filter((x) => !have.has(x.sha256) && !x.spotLegs && x.meta.interval === a.interval && [...x.meta.universe].sort().join() === uni);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pt-1"><button onClick={() => nav({ tab: 'agents' })} aria-label={t('back')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-[24px] font-semibold tracking-tight">{a.name}</h1><div className="flex flex-wrap items-center gap-2 text-[13px] text-mute"><VenueBadge venue="hyperliquid" />{(a.universe as string[]).join(' · ')} · {a.interval} · {t('paPerps')}</div></div>{!isLive && <AgentState state={a.state} />}</div>
      {/* v7 perp live: the state and the money it moves, on their own line (the title keeps its width on a phone) */}
      {isLive && <div className="flex justify-start"><PerpLiveState a={a} /></div>}
      {isLive ? <AgentModeBand a={a} /> : <SimulationBanner />}
      {a.mission && <p className="text-[14px] text-mute">{a.mission}</p>}
      {a.stopReason && !(isLive && a.live?.exit) && <Notice tone="warn">{a.stopReason}</Notice>}{/* v7: a live agent's stop is said in the screen's language by LivePanel; the server's sentence is its detail */}
      {a.flattening && a.state !== 'STOPPED' && <Notice tone="danger">{t('paFlattening')} {a.flattening.reason}</Notice>}
      {a.flag && <Notice tone="warn">{t('paFlag')} {a.flag.message} ({when(new Date(a.flag.ts), locale)})</Notice>}
      {a.hold && (a.state === 'PAPER_TRADING' || a.state === 'LIVE') && <Notice tone="info">{t('paHold')} {a.hold.reason}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}{note && <Notice tone="ok">{note}</Notice>}

      {isLive && <LivePanel a={a} id={id} nav={nav} />}
      {!isLive && <Card><H right={<PaperTag />}>{t('paAccount')}</H>
        {!acct ? <p className="text-[14px] text-mute">{t('paNoAccount')}</p> : <>
          <div className="text-[30px] font-semibold tracking-tight">{usd(acct.state.equity, locale)}</div>
          <div className="text-[13px] text-mute">{t('paAllocated', { capital: a.capitalUsdc })} · {t('paResult')} <Pnl value={result ? D.str(result) : null} locale={locale} /></div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Stat label={t('paCollateral')}>{usd(acct.state.collateral, locale)}</Stat><Stat label={t('paMarginUsed')}>{usd(acct.state.marginUsed, locale)}</Stat>
            <Stat label={t('paFree')}>{usd(acct.state.freeCollateral, locale)}</Stat><Stat label={t('paRealised')}><Pnl value={acct.totals?.realizedPnl} locale={locale} /></Stat>
            <Stat label={t('paFees')}>{usd(acct.totals?.feesPaid, locale)}</Stat><Stat label={t('paFundingNet')}><Pnl value={acct.totals?.fundingNet} locale={locale} dp={4} /></Stat>
            <Stat label={t('paLiquidations')}>{acct.totals?.liquidations ?? 0}</Stat><Stat label={t('paLastBar')}>{a.lastBar ? when(a.lastBar, locale) : '—'}</Stat>
          </div>
          <div className="mt-4"><div className="mb-1 text-[13px] font-semibold text-mute">{t('paPositions')}</div>
            <DataTable cols={posCols} rows={acct.positions} rowKey={(p) => p.instrument} empty={t('paNoPositions')} label={t('paPositions')} /></div>
          <p className="mt-3 text-[12px] text-mute">{t('paSimplifications')}</p>
          {acct.positions.length > 0 && <Btn kind="ghost" full className="mt-3" busy={busy === 'flat'} onClick={() => act('flat', async () => { const r = await post<{ orders: unknown[]; positionsLeft: number }>(`/agents/${id}/perp/flatten`); setNote(t('paFlattened', { n: r.orders.length, left: r.positionsLeft })); })}>{t('paFlatten')}</Btn>}
        </>}
      </Card>}

      {!isLive && eq.length > 1 && <Card><H right={<PaperTag />}>{t('paEquity')}</H><PriceChart points={eq} format={(v) => usd(dec(v.toFixed(2)), locale)} formatTime={(ts) => timeOf(ts, locale, true)} /></Card>}

      <Card><H>{t('paLimits')}</H>
        <Row label={t('paMaxLev')}>{risk.maxLeverage}× <span className="text-mute">{!isLive && <>({t('paPolicy')} {pol?.maxLeverage ?? '—'}×)</>}</span></Row>
        <Row label={t('paMaxGross')}>{risk.maxGrossExposureX}×{!isLive && <> → {usd(pol?.maxGrossExposure, locale)}</>}</Row>
        <Row label={t('paMaxPos')}>{risk.maxPositionX}×{!isLive && <> → {usd(pol?.maxPositionNotional, locale)}</>}</Row>
        <Row label={t('paDailyLoss')}>{risk.maxDailyLossPct} %{!isLive && <> → {usd(pol?.maxDailyLoss, locale)}</>}</Row>
        <Row label={t('paTotalLoss')}>{risk.maxTotalLossPct} %{!isLive && <> → {usd(pol?.maxTotalLoss, locale)}</>}</Row>
        <Row label={t('paSlip')}>{risk.slippageBps} bps</Row>
        {pol?.halt && <div className="mt-2"><Notice tone="danger">{t('paHalt')} {pol.halt}</Notice></div>}
        <p className="mt-2 text-[12px] text-mute">{t('paLimitsNote')}</p>
      </Card>

      <div id="pl-strategy" className="scroll-mt-24" /><Card><H>{t('agStrategy')}</H>
        {(a.versions as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('paNoStrategy')}</p> : <ul className="space-y-3">{(a.versions as any[]).map((v) => { const s = v.summary; return <li key={v.id} className="rounded-2xl bg-elev/70 p-3.5">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{v.name} <span className="font-normal text-mute">v{v.version}</span></span><span className="rounded-full bg-surface px-2 py-0.5 text-[11.5px] font-semibold">{t(`agV_${v.status}` as Key)}</span></div>
          <div className="mt-1 break-all font-mono text-[11px] text-mute">sha256 {v.code_sha256}</div>
          {s ? <>
            <div className="mt-2.5 grid grid-cols-3 gap-2 text-center text-[12.5px]">
              <div className="rounded-xl bg-surface p-2"><div className="text-mute">{t('agRet')}</div><div className="text-[14px] font-semibold">{pctOf(s.metrics.test?.total_return)}</div><div className="text-[11px] text-mute">{t('paVsPerp')} {pctOf(s.benchmarks.perp_long_1x?.total_return)}</div></div>
              <div className="rounded-xl bg-surface p-2"><div className="text-mute">Sharpe</div><div className="text-[14px] font-semibold">{n2(s.metrics.test?.sharpe)}</div><div className="text-[11px] text-mute">[{n2(s.robustness?.bootstrap_sharpe_ci?.[0])} … {n2(s.robustness?.bootstrap_sharpe_ci?.[1])}]</div></div>
              <div className="rounded-xl bg-surface p-2"><div className="text-mute">{t('agDD')}</div><div className="text-[14px] font-semibold">{pctOf(s.metrics.test?.max_drawdown)}</div><div className="text-[11px] text-mute">{t('paIntrabar')} {pctOf(s.metrics.test?.worst_intrabar_drawdown)}</div></div></div>
            <div className="mt-2.5 rounded-xl border border-warn/30 bg-warn/8 p-3 text-[12.5px] leading-snug"><div className="mb-1 font-semibold">{t('paCaveats')}</div><ul className="list-disc space-y-1 pl-4">
              <li>{t('paCavHistory', { days: s.historyDays ?? '?', bars: s.config?.bars ?? '?', interval: s.config?.interval ?? a.interval })}</li>
              <li>{t('paCavEstimates', { fee: s.config?.fee_bps ?? '?', slip: s.config?.slippage_bps ?? '?', pen: s.config?.liquidation_penalty_bps ?? '?' })}</li>
              <li className={s.liquidations.train + s.liquidations.validation + s.liquidations.test > 0 || s.metrics.test?.wiped_out ? 'font-semibold text-danger' : ''}>{t('paCavLiq', { train: s.liquidations.train, val: s.liquidations.validation, test: s.liquidations.test })}{s.metrics.test?.wiped_out ? ` ${t('paCavWiped')}` : ''}</li>
              <li>{t('paCavDsr', { dsr: typeof s.robustness?.deflated_sharpe === 'number' ? s.robustness.deflated_sharpe.toFixed(3) : '?', trials: s.robustness?.trials_tested ?? '?' })}</li>
              <li>{t('paCavChecks', { look: s.checks?.lookahead ?? '?', data: s.checks?.data_quality ?? '?', ledger: s.checks?.ledger ?? '?', fund: s.checks?.funding_alignment ?? '?' })}</li>
              {!s.buyAndHoldIsSpot && <li>{t('paCavNoSpot')}</li>}
              <li>{t('paCavNever')}</li></ul></div>
            {s.problem && <div className="mt-2"><Notice tone="danger">{t('paNotApprovable')} {s.problem}</Notice></div>}
          </> : <p className="mt-2 text-[12.5px] text-mute">{v.status === 'backtesting' ? t('paBacktesting') : v.notes ? v.notes : t('agNoReport')}</p>}
          {v.status !== 'approved' && s && !s.problem && !liveActive && <Btn kind="soft" full className="mt-3" busy={busy === `a${v.id}`} onClick={() => act(`a${v.id}`, () => post(`/agents/${id}/strategies/${v.id}/approve`))}>{t('agApproveVersion')}</Btn>}
        </li>; })}</ul>}
        <div className="mt-4"><div className="mb-2 text-[13px] font-semibold text-mute">{t('paLibrary')}</div>
          {lib.isLoading ? <Skeleton h="h-16" /> : fit.length === 0 ? <p className="text-[13px] text-mute">{t('paLibNone', { assets: (a.universe as string[]).join(', '), interval: a.interval })}</p> :
            <ul className="space-y-2">{fit.map((x) => <li key={x.sha256} className="flex items-center gap-3 rounded-2xl border border-line p-3">
              <span className="min-w-0 flex-1"><span className="block font-semibold">{x.meta.name} <span className="font-normal text-mute">v{x.meta.version}</span></span>
                <span className="block truncate text-[12px] text-mute">{x.meta.universe.join(' · ')} · {x.meta.interval} · {t('paBounds', { lev: x.meta.max_leverage, gross: x.meta.max_gross_exposure })}</span></span>
              <Btn kind="soft" busy={busy === `r${x.sha256}`} onClick={() => act(`r${x.sha256}`, () => post(`/agents/${id}/strategies`, { path: x.path.replace(/^strategies\//, '') }))}>{t('agLibTest')}</Btn></li>)}</ul>}</div>
      </Card>

      {/* v7 research runtime */}<ResearchPanel agent={a} nav={nav} />

      <Card><H>{t('agControl')}</H>
        <div className="space-y-2.5">
          {approved && !liveActive && ['AWAITING_APPROVAL', 'PAUSED', 'STOPPED', 'CREATED'].includes(a.state) && <Btn kind="soft" full busy={busy === 'paper'} onClick={() => act('paper', () => post(`/agents/${id}/mode`, { mode: 'PAPER' }))} data-testid="pa-start-paper">{t(isLive ? 'plBackPaper' : 'paStart')}</Btn>}
          {a.state === 'PAPER_TRADING' && <Btn kind="ghost" full busy={busy === 'pause'} onClick={() => act('pause', () => post(`/agents/${id}/mode`, { mode: 'PAUSED' }))}>{t('agPause')}</Btn>}
          {!liveActive && ['PAPER_TRADING', 'PAUSED'].includes(a.state) && <Btn kind="ghost" full busy={busy === 'stop'} onClick={() => act('stop', () => post(`/agents/${id}/mode`, { mode: 'STOPPED' }))}>{t('paStop')}</Btn>}
          {!approved && <p className="text-[13.5px] text-mute">{t('agNeedsStrategy')}</p>}
        </div>
        {/* >>> v7 perp live: the go-live checklist (the pause / resume / stop of a live agent are in LivePanel) */}
        {liveActive ? <p className="text-[13.5px] text-mute">{t('plBandLive')}</p> : <div className="mt-4"><GoLiveCard a={a} id={id} nav={nav} /></div>}
        {/* <<< v7 perp live */}
      </Card>

      {acct && !isLive && <Card><H right={<PaperTag />}>{t('paActivity')}</H>
        <Seg<Tab> value={tab} onChange={setTab} label={t('paActivity')} tabs size="sm" className="mb-3" options={[{ id: 'orders', label: `${t('paOrders')} (${acct.orders.length})` }, { id: 'fills', label: `${t('paFills')} (${acct.fills.length})` }, { id: 'funding', label: `${t('paFunding')} (${acct.funding.length})` }, { id: 'events', label: `${t('paEvents')} (${acct.riskEvents.length})` }]} />
        {tab === 'orders' && <DataTable cols={ordCols} rows={acct.orders} rowKey={(o) => o.clientId} empty={t('paNone')} label={t('paOrders')} />}
        {tab === 'fills' && <DataTable cols={fillCols} rows={acct.fills} rowKey={(x) => x.id} empty={t('paNone')} label={t('paFills')} />}
        {tab === 'funding' && <DataTable cols={fundCols} rows={acct.funding} rowKey={(x) => `${x.instrument}:${x.ts}`} empty={t('paNone')} label={t('paFunding')} />}
        {tab === 'events' && <DataTable cols={evCols} rows={acct.riskEvents} rowKey={(x) => String(x.id)} empty={t('paNone')} label={t('paEvents')} />}
      </Card>}

      <Card><H>{t('paSignals')}</H>
        {(a.signals as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('paNoSignals')}</p> : <ul className="space-y-2.5 text-[13px]">{(a.signals as any[]).slice(0, 24).map((s) => <li key={s.bar} className="rounded-2xl border border-line p-3">
          <div className="flex justify-between gap-2"><span className="font-semibold">{when(s.bar, locale)}</span><span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${s.status === 'done' ? 'bg-emerald/10 text-emerald' : s.status === 'hold' ? 'bg-warn/12 text-warn' : 'bg-elev text-mute'}`}>{s.status === 'decided' ? t('plSig_decided') : t(`paSig_${s.status}` as Key)}</span></div>
          {s.reason && <div className="mt-1 text-mute">{s.reason}</div>}
          {s.weights && <div className="mt-1 font-mono text-[11.5px] text-mute">{t('paWeights')} {Object.entries(s.weights as Record<string, number>).map(([k, w]) => `${k} ${w >= 0 ? '+' : ''}${w.toFixed(3)}`).join('  ')}{s.scale && s.scale !== '1' ? `  × ${Number(s.scale).toFixed(3)} (${s.orders?.binding})` : ''}</div>}
          {s.targets && <div className="font-mono text-[11.5px] text-mute">{t('paTargets')} {Object.entries(s.targets as Record<string, string>).map(([k, z]) => `${k} ${z}`).join('  ')}</div>}
          {(s.orders?.list ?? []).length > 0 && <ul className="mt-1.5 space-y-0.5">{(s.orders.list as any[]).map((o, k) => <li key={k} className="text-[12px]"><SideTag side={o.side} /> {o.symbol} {o.size}{o.reduceOnly ? ` · ${t('paReduceOnly')}` : ''} → <span className="font-medium">{o.status === 'deferred' ? t('plSig_deferred') : o.status}</span>{o.code && isLive ? <span className="mt-0.5 block text-mute"><Refusal code={String(o.code)} reason={o.why ? String(o.why).slice(0, 200) : undefined} /></span> : o.why ? <span className="text-mute"> — {String(o.why).slice(0, 160)}</span> : null}</li>)}</ul>}
        </li>)}</ul>}
      </Card>

      <Card><H>{t('agLog')}</H>
        {(a.log as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('agNoLog')}</p> : <ul className="space-y-2.5 text-[13px]">{(a.log as any[]).map((l, k) => <li key={k}><div className="flex justify-between gap-2"><span className="font-medium">{l.title}</span><span className="shrink-0 text-[12px] text-mute">{when(l.ts, locale)}</span></div>{l.body && <div className="whitespace-pre-wrap text-mute">{String(l.body).slice(0, 600)}</div>}</li>)}</ul>}</Card>
    </div>
  );
}

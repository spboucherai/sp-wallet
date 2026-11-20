// V11 — what the quant lab measured, shown where a decision is taken. Two things, both BACKTESTS and labelled so everywhere:
//   1. LabVerdicts   the lab's out-of-sample results for a template's strategies and studies (GET /agents/templates →
//                    `labVerdicts`, read by the API from research/results/<run>/summary.json). No figure and no result sentence is
//                    written in this file: the numbers, the stop reasons and the studies' statements are the API's, i.e. the
//                    lab's files; the sentences here are templates filled with those numbers.
//   2. ReportV3      the version-3 sections of ONE backtest report (perp agent page, agent panel): gross-to-net per split, the
//                    execution model, engine parity with "stopped by the engine's loss limit" next to the split it ended, data
//                    bias, journal. A version-2 report (stored before V11) has none of them and says so.
// Loaded with the Agents chunk only (imported by agentPanel.tsx and PerpAgent.tsx): nothing here is in the app shell.
import { useContext } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Fact, fiat, Fold, Notice, numFmt, Tag } from '../ui';

// ------------------------------------------------------------------------------------------------------------------ the server's shapes
export const SPLITS = ['train', 'validation', 'test'] as const;
export type Split = (typeof SPLITS)[number];
export interface LabStop { code: string; reason: string; ts?: string | null }
export interface LabGrossToNet { pricePnl: number | null; funding: number | null; fees: number | null; liquidationPenalties: number | null; slippage: number | null; latency: number | null; netPnl: number | null }
export interface LabSplit { netReturn: number | null; netSharpe: number | null; grossSharpe: number | null; maxDrawdown: number | null; trades: number | null; stop: LabStop | null; grossToNet: LabGrossToNet | null }
export interface LabStrategyVerdict { available: true; kind: 'strategy'; backtest: true; name: string; version: string; strategy: string; sha256: string | null; symbols: string[];
  where: string | null; installedHashMatches: boolean | null; scope: 'agent' | 'backtest_only' | 'research_only'; liveCapable: boolean;
  deflatedSharpe: number | null; deflatedSharpeThreshold: number; significant: boolean | null; trialsTested: number | null; ownTrials: number | null; testSharpeCi: [number, number] | null;
  splits: Record<Split, LabSplit | null>; stoppedSplits: Split[]; checks: Record<string, string> | null;
  window: { start: string | null; end: string | null; interval: string | null; bars: number | null } | null; splitDates: Record<string, [string, string]> | null;
  dataSha256: string | null; codeSha256: string | null; engineParityApplied: boolean | null;
  results: { dir: string; file: string | null; fileSha256: string | null; matchesManifest: boolean | null } }
export interface LabStudyVerdict { available: true; kind: 'study'; backtest: false; name: string; statement: string | null; assumptions: string[]; fillsAreModelled: boolean | null;
  results: { dir: string; file: string; fileSha256: string; matchesManifest: boolean | null } }
export interface LabUnavailable { available: false; kind: 'strategy' | 'study' | 'policy'; name: string; reason: string }
export type LabVerdict = LabStrategyVerdict | LabStudyVerdict | LabUnavailable;

/** the perp report summary of the API (perp-routes.ts `perpReportSummary`): the v3 sections are null for a version-2 report */
export interface ReportSummary { schemaVersion: number | null; metrics?: Record<string, Record<string, any> | null> | null;
  executionModel?: Record<string, any> | null; engineParity?: Record<string, any> | null; dataBias?: Record<string, any> | null; journal?: Record<string, any> | null }

// ------------------------------------------------------------------------------------------------------------------ pure helpers (tested)
export const isStrategyVerdict = (v: LabVerdict): v is LabStrategyVerdict => v.available && v.kind === 'strategy';
export const isStudyVerdict = (v: LabVerdict): v is LabStudyVerdict => v.available && v.kind === 'study';
/** the scope tag of a lab result: only `agent` + liveCapable is an executable universe; everything else says what it is */
export const scopeKey = (v: Pick<LabStrategyVerdict, 'scope' | 'liveCapable'>): Key => (v.scope === 'agent' ? (v.liveCapable ? 'ag2LabScope_live' : 'ag2LabScope_paper') : v.scope === 'backtest_only' ? 'ag2LabScope_backtest' : 'ag2LabScope_research');
/** the sentence of a lab result, composed from ITS numbers: significance is the lab's rule (deflated Sharpe against its threshold) */
export const edgeKey = (v: Pick<LabStrategyVerdict, 'significant'>): Key => (v.significant === true ? 'ag2LabEdgeYes' : v.significant === false ? 'ag2LabEdgeNo' : 'ag2LabEdgeUnknown');
export const splitKey = (s: Split | string): Key => (`ag2V3Split_${s === 'train' || s === 'validation' ? s : 'test'}` as Key);

export type GtnLine = 'price' | 'funding' | 'fees' | 'liquidation' | 'slippage' | 'latency' | 'net';
export const GTN_ORDER: readonly GtnLine[] = ['price', 'funding', 'fees', 'slippage', 'latency', 'liquidation', 'net'];
export const gtnKey = (l: GtnLine): Key => (`ag2V3L_${l}` as Key);
const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** Gross to net as SIGNED lines, in the order money is lost: price PnL → funding → fees → slippage → latency → (liquidation
 *  penalties, shown only when there are any) → net. The report stores costs as positive amounts: they are shown negative.
 *  Accepts the report's snake_case block (`metrics.<split>.gross_to_net`) and the lab verdict's camelCase one. */
export function grossToNetRows(g: Record<string, unknown> | LabGrossToNet | null | undefined): { line: GtnLine; value: number | null }[] | null {
  if (!g) return null;
  const x = g as Record<string, unknown>, cost = (v: unknown): number | null => { const n = fin(v); return n === null ? null : n === 0 ? 0 : -n; };
  const liq = cost(x.liquidation_penalties ?? x.liquidationPenalties);
  const rows: { line: GtnLine; value: number | null }[] = [{ line: 'price', value: fin(x.price_pnl ?? x.pricePnl) }, { line: 'funding', value: fin(x.funding) }, { line: 'fees', value: cost(x.trading_fees ?? x.fees) },
    { line: 'slippage', value: cost(x.slippage) }, { line: 'latency', value: cost(x.latency) }, ...(liq ? [{ line: 'liquidation' as const, value: liq }] : []), { line: 'net', value: fin(x.net_pnl ?? x.netPnl) }];
  return rows.every((r) => r.value === null) ? null : rows;
}
/** the stop the ENGINE's own rules put on a split of a version-3 report (null: the split ran to its end, or the report has no parity block) */
export function stopOfSplit(s: Pick<ReportSummary, 'engineParity'> | null | undefined, split: Split): LabStop | null {
  const st = s?.engineParity?.observed?.[split]?.stop;
  return st && typeof st === 'object' && typeof st.code === 'string' ? { code: st.code, reason: typeof st.reason === 'string' ? st.reason : st.code, ts: typeof st.ts === 'string' ? st.ts : null } : null;
}
/** which version-3 sections a summary carries; a version-2 report carries none */
export function v3Sections(s: ReportSummary | null | undefined): { v3: boolean; grossToNet: boolean; executionModel: boolean; engineParity: boolean; parityApplied: boolean; dataBias: boolean; journal: boolean } {
  const gtn = SPLITS.some((k) => !!grossToNetRows(s?.metrics?.[k]?.gross_to_net));
  return { v3: s?.schemaVersion === 3, grossToNet: gtn, executionModel: !!s?.executionModel, engineParity: !!s?.engineParity, parityApplied: s?.engineParity?.applied === true, dataBias: !!s?.dataBias, journal: !!s?.journal };
}
export const shortHash = (h: unknown): string => (typeof h === 'string' && h.length > 12 ? `${h.slice(0, 12)}…` : typeof h === 'string' ? h : '—');
const day = (iso: string | null | undefined): string => (typeof iso === 'string' ? iso.slice(0, 10) : '—');

// ------------------------------------------------------------------------------------------------------------------ pieces
const pct = (x: number | null | undefined, locale: string, dp = 2): string => (typeof x === 'number' ? `${x > 0 ? '+' : ''}${numFmt(x * 100, locale, dp, dp)} %` : '—');
const n2 = (x: number | null | undefined, locale: string, dp = 2): string => (typeof x === 'number' ? numFmt(x, locale, dp, dp) : '—');
const money = (x: number | null, locale: string): string => (x === null ? '—' : `${x > 0 ? '+' : ''}${fiat(x, 'USD', locale)}`);

/** "stopped by the engine's loss limit (<reason>)" — the same words wherever a split was ended by the engine's own rules */
export function StoppedTag({ split, stop }: { split: Split | string; stop: LabStop }) {
  const t = useT();
  return <span className="block text-[0.78125rem] font-semibold leading-snug text-danger" data-testid="ag2-lab-stopped" data-split={split}>{t('ag2LabStopped', { split: t(splitKey(split)), reason: stop.reason })}</span>;
}

/** the gross-to-net table of every split that has one, each column a split, each row a line; a stop is written under its split */
export function GrossToNetTable({ bySplit, stops }: { bySplit: Partial<Record<Split, ReturnType<typeof grossToNetRows>>>; stops?: Partial<Record<Split, LabStop | null>> }) {
  const t = useT(); const { locale } = useContext(I18n);
  const splits = SPLITS.filter((s) => bySplit[s]), lines = GTN_ORDER.filter((l) => splits.some((s) => bySplit[s]!.some((r) => r.line === l)));
  if (!splits.length) return null;
  return <div data-testid="ag2-v3-gtn"><div className="overflow-x-auto"><table className="w-full min-w-[300px] text-[0.78125rem]"><caption className="sr-only">{t('ag2V3GrossToNet')}</caption>
    <thead><tr className="text-mute"><th scope="col" className="py-1 pr-2 text-left font-medium">{t('ag2V3GrossToNet')}</th>{splits.map((s) => <th key={s} scope="col" className="py-1 pl-2 text-right font-medium">{t(splitKey(s))}</th>)}</tr></thead>
    <tbody>{lines.map((l) => <tr key={l} className={l === 'net' ? 'border-t border-line font-semibold' : ''}><th scope="row" className="py-1 pr-2 text-left font-normal">{t(gtnKey(l))}</th>
      {splits.map((s) => { const v = bySplit[s]!.find((r) => r.line === l)?.value ?? null; return <td key={s} className={`t-num py-1 pl-2 text-right ${l === 'net' && v !== null ? (v < 0 ? 'text-danger' : 'text-emerald') : ''}`}>{money(v, locale)}</td>; })}</tr>)}</tbody></table></div>
    {splits.map((s) => (stops?.[s] ? <StoppedTag key={s} split={s} stop={stops[s]!} /> : null))}</div>;
}

// ------------------------------------------------------------------------------------------------------------------ 1. the lab's verdicts (template cards)
function StrategyVerdict({ v, detail }: { v: LabStrategyVerdict; detail: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const test = v.splits.test, live = v.scope === 'agent' && v.liveCapable;
  return <div className="rounded-xl bg-elev/60 p-3" data-testid="ag2-lab-verdict" data-strategy={v.strategy}>
    <div className="flex flex-wrap items-center justify-between gap-1.5"><span className="font-mono text-[0.78125rem] font-semibold">{v.strategy}</span><Tag tone={live ? 'ok' : 'mute'} icon={live ? 'bolt' : 'eye'}>{t(scopeKey(v))}</Tag></div>
    <div className="mt-1 text-[0.78125rem] leading-snug text-mute [overflow-wrap:anywhere]">{v.symbols.join(' · ')}</div>
    <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[0.78125rem]">
      <div><dt className="text-mute">{t('ag2LabDsr')}</dt><dd className="t-num font-semibold" data-testid="ag2-lab-dsr">{n2(v.deflatedSharpe, locale, 3)}</dd></div>
      <div><dt className="text-mute">{t('ag2LabNetReturn')}</dt><dd className="t-num font-semibold">{pct(test?.netReturn, locale)}</dd></div>
      {detail && <><div><dt className="text-mute">{t('ag2LabSharpe')}</dt><dd className="t-num">{n2(test?.netSharpe, locale)} / {n2(test?.grossSharpe, locale)}</dd></div>
        <div><dt className="text-mute">{t('ag2LabMaxDd')}</dt><dd className="t-num">{typeof test?.maxDrawdown === 'number' ? pct(-test.maxDrawdown, locale) : '—'}</dd></div></>}</dl>
    <p className="mt-1.5 text-[0.78125rem] leading-snug">{t(edgeKey(v), { dsr: n2(v.deflatedSharpe, locale, 3), min: n2(v.deflatedSharpeThreshold, locale), trials: v.trialsTested ?? '?' })}</p>
    {v.stoppedSplits.map((s) => (v.splits[s]?.stop ? <StoppedTag key={s} split={s} stop={v.splits[s]!.stop!} /> : null))}
    {detail && <>
      <div className="mt-2"><GrossToNetTable bySplit={Object.fromEntries(SPLITS.map((s) => [s, grossToNetRows(v.splits[s]?.grossToNet)]))} /></div>
      <p className="mt-1.5 text-[0.71875rem] leading-snug text-mute [overflow-wrap:anywhere]">{t('ag2LabWindow', { start: day(v.window?.start), end: day(v.window?.end), from: day(v.splitDates?.test?.[0]), to: day(v.splitDates?.test?.[1]) })} · {t('ag2LabSource', { file: `${v.results.dir}/${v.results.file ?? 'summary.json'}`, sha: shortHash(v.results.fileSha256) })}</p>
      {v.results.matchesManifest === false && <p className="mt-1 text-[0.75rem] font-semibold text-warn">{t('ag2LabManifestMismatch')}</p>}
      {v.installedHashMatches === false && <p className="mt-1 text-[0.75rem] font-semibold text-warn">{t('ag2LabHashMismatch')}</p>}</>}
  </div>;
}

/** The lab's results for one template. `detail` (the creation form) adds the per-split table, the window and the file hashes. */
export function LabVerdicts({ verdicts, detail = false }: { verdicts: LabVerdict[] | undefined; detail?: boolean }) {
  const t = useT();
  const list = verdicts ?? [], strategies = list.filter(isStrategyVerdict), studies = list.filter(isStudyVerdict);
  if (!list.length) return null;
  if (!strategies.length && !studies.length) return detail ? <p className="text-[0.78125rem] leading-snug text-mute" data-testid="ag2-lab-unavailable">{t('ag2LabUnavailable')}</p> : null;
  return <div className="mt-2.5 space-y-2 border-t border-line pt-2.5 text-left" data-testid="ag2-lab" data-label="backtest">
    <div className="flex flex-wrap items-center justify-between gap-1.5"><span className="t-eyebrow">{t('ag2LabTitle')}</span><Tag tone="warn" icon="chart" testid="ag2-lab-tag">{t('ag2LabTag')}</Tag></div>
    {strategies.map((v) => <StrategyVerdict key={v.strategy} v={v} detail={detail} />)}
    {studies.map((s) => <div key={s.name} className="rounded-xl bg-elev/60 p-3" data-testid="ag2-lab-study"><div className="flex flex-wrap items-center justify-between gap-1.5"><span className="font-mono text-[0.78125rem] font-semibold">{s.name}</span><Tag tone="mute" icon="search">{t('ag2LabStudy')}</Tag></div>
      {/* the study's own statement, verbatim from its result file */}
      {s.statement && <p className="mt-1.5 text-[0.78125rem] leading-snug text-mute">{detail || s.statement.length <= 260 ? s.statement : `${s.statement.slice(0, 260)}…`}</p>}
      {s.fillsAreModelled && <p className="mt-1 text-[0.78125rem] font-semibold text-warn">{t('ag2LabModelled')}</p>}</div>)}
    <p className="text-[0.71875rem] leading-snug text-mute">{t('ag2LabNote')}</p>
  </div>;
}

// ------------------------------------------------------------------------------------------------------------------ 2. the version-3 sections of one report
const flat = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The V11 sections of a backtest report. Always under a BACKTEST tag; a split the engine stopped says so next to its figures. */
export function ReportV3({ summary }: { summary: ReportSummary | null | undefined }) {
  const t = useT(); const { locale } = useContext(I18n);
  if (!summary) return null;
  const has = v3Sections(summary);
  if (!has.v3 && !has.grossToNet) return <p className="mt-2 text-[0.78125rem] leading-snug text-mute" data-testid="ag2-v3-old">{t('ag2V3Old')}</p>;
  const ex = summary.executionModel ?? {}, par = summary.engineParity ?? {}, bias = summary.dataBias ?? {}, j = summary.journal ?? {};
  const stops = Object.fromEntries(SPLITS.map((s) => [s, stopOfSplit(summary, s)])) as Record<Split, LabStop | null>;
  const params = Object.entries((par.parameters ?? {}) as Record<string, { value?: unknown; source?: unknown }>), perSym = Object.entries((bias.per_symbol ?? {}) as Record<string, Record<string, unknown>>);
  const ratio = (x: unknown) => (typeof x === 'number' ? `${numFmt(x * 100, locale, 2)} %` : '—');
  return <div className="mt-3 space-y-2.5 rounded-2xl border border-line p-3.5" data-testid="ag2-v3" data-label="backtest">
    <div className="flex flex-wrap items-center justify-between gap-1.5"><span className="text-[0.84375rem] font-semibold">{t('ag2V3Title')}</span><Tag tone="warn" icon="chart" testid="ag2-v3-tag">{t('ag2LabTag')}</Tag></div>
    <GrossToNetTable bySplit={Object.fromEntries(SPLITS.map((s) => [s, grossToNetRows(summary.metrics?.[s]?.gross_to_net)]))} stops={stops} />
    {has.engineParity && <div data-testid="ag2-v3-parity"><div className="flex flex-wrap items-center gap-2"><span className="text-[0.8125rem] font-semibold">{t('ag2V3Parity')}</span><Tag tone={has.parityApplied ? 'ok' : 'danger'} icon={has.parityApplied ? 'check' : 'x'}>{t(has.parityApplied ? 'ag2V3ParityOn' : 'ag2V3ParityOff')}</Tag></div>
      <p className="mt-1 text-[0.78125rem] leading-snug text-mute">{t('ag2V3ParityNote')}</p>
      {SPLITS.every((s) => !stops[s]) && <p className="mt-1 text-[0.78125rem] text-mute">{t('ag2V3NoStop')}</p>}
      {params.length > 0 && <Fold summary={t('ag2V3ParityParams', { n: params.length })}><dl>{params.map(([k, p]) => <Fact key={k} k={k} mono>{flat(p?.value)} <span className="font-normal text-mute">· {flat(p?.source)}</span></Fact>)}</dl></Fold>}</div>}
    {has.v3 && !has.engineParity && <Notice tone="danger">{t('ag2V3ParityOff')}</Notice>}
    {has.executionModel && <Fold summary={t('ag2V3Exec')} testid="ag2-v3-exec"><dl>
      <Fact k={t('ag2V3ExLatency')}>{flat(ex.latency?.model)} · {flat(ex.latency?.latency_s)} s</Fact>
      <Fact k={t('ag2V3ExSlippage')}>{flat(ex.slippage?.model)}{ex.slippage?.book_based ? ` · ${t('ag2V3ExBook')}` : ''}</Fact>
      <Fact k={t('ag2V3ExFees')}>{flat(ex.fees?.liquidity)} · {Object.entries((ex.fees?.fee_table ?? {}) as Record<string, { taker_bps?: unknown; maker_bps?: unknown }>).map(([v, f]) => `${v} ${flat(f?.taker_bps)} / ${flat(f?.maker_bps)} bps`).join(' · ') || '—'}</Fact>
      <Fact k={t('ag2V3ExFunding')}>{Object.entries((ex.funding ?? {}) as Record<string, { interval_s?: unknown }>).map(([v, f]) => `${v} ${typeof f?.interval_s === 'number' ? f.interval_s / 3600 : '?'} h`).join(' · ') || '—'}</Fact>
      <Fact k={t('ag2V3ExAccounts')}>{flat(ex.accounts?.model)}</Fact></dl>
      {/* the lab's own statements of its model, verbatim */}
      {[ex.latency?.statement, ex.slippage?.statement, ex.accounts?.statement, typeof ex.liquidation === 'string' ? ex.liquidation : null].filter((x): x is string => typeof x === 'string').map((x) => <p key={x} className="mt-1.5 text-[0.75rem] leading-snug text-mute">{x}</p>)}</Fold>}
    {has.dataBias && <Fold summary={t('ag2V3Bias')} testid="ag2-v3-bias">
      {[bias.survivorship?.statement, bias.listing_date_truncation?.statement, bias.common_clock?.statement].filter((x): x is string => typeof x === 'string').map((x) => <p key={x} className="mb-1.5 text-[0.75rem] leading-snug text-mute">{x}</p>)}
      <dl><Fact k={t('ag2V3BiasDropped')}>{ratio(bias.common_clock?.dropped_fraction)}</Fact>
        {perSym.map(([s, p]) => <Fact key={s} k={s}>{t('ag2V3BiasSym', { missing: ratio(p.missing_bar_ratio), stale: ratio(p.stale_price_ratio), first: day(typeof p.first_bar === 'string' ? p.first_bar : null) })}</Fact>)}</dl></Fold>}
    {has.journal && <Fold summary={t('ag2V3Journal')} testid="ag2-v3-journal"><dl>
      <Fact k={t('ag2V3JStrategy')} mono>{flat(j.strategy?.name)}@{flat(j.strategy?.version)} · {shortHash(j.strategy?.sha256)}</Fact>
      <Fact k={t('ag2V3JCode')} mono>{shortHash(j.code?.code_sha256)}</Fact>
      <Fact k={t('ag2V3JData')} mono>{shortHash(j.data?.sha256)}{Array.isArray(j.data?.range) ? ` · ${day(j.data.range[0])} → ${day(j.data.range[1])}` : ''}</Fact>
      <Fact k={t('ag2V3JSeed')} mono>{flat(j.seed)}</Fact></dl>
      {typeof j.reproducibility === 'string' && <p className="mt-1.5 text-[0.75rem] leading-snug text-mute">{j.reproducibility}</p>}</Fold>}
  </div>;
}

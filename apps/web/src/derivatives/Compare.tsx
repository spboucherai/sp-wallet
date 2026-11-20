/**
 * The `compare` table for one base asset across venues — a table, never a recommendation: no ranking, no "best" mark. Under
 * it, the contract differences in words (collateral, settlement, funding, leverage, fees) and the reminder that these
 * contracts are not interchangeable (docs/v4/venues/contract-differences.md).
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { sanitizeAmountText } from '../amount';
import { AmountProblem } from '../amountUi';
import { fundingSeries, gapToMedianBps, type SeriesPoint } from '../chart-geom';
import { MultiSeriesChart } from '../chart-multi';
import { errText, I18n, useT, type Key } from '../i18n';
import { ageLabel, compareParams, costItems, defaultCompareForm, mapi, pctText, reasonKey, textKey, topDiscrepancies, type Coded, type CompareForm, type CompareRow as CostRow, type Figure } from '../markets';
import { useQuoteSubscriptions } from '../quotes';   // v11 live quotes: prices and spreads tick; the cost comparison is recomputed on its own cadence or on demand, never per tick
import { LiveCell, LiveStatus } from '../quotes-ui';
import { Btn, Card, Coin, H, inputCls, Notice, numFmt, VenueIcon } from '../ui';
import { dapi } from './api';
import { DataTable, Seg, timeOf, VENUE_NAME, VenueBadge, type Col } from './bits';
import { compactUsd, D, dec, fmt, pct, priceDp, usd } from './dec';
import type { CompareRow, Instrument, VenueId } from './types';

const ORDER: VenueId[] = ['hyperliquid', 'gmx', 'dydx', 'edgex'];   // v11: edgeX last (market data only)
const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LINK', 'AVAX', 'ARB'];
const FIELDS = ['collateral', 'settlement', 'funding', 'leverage', 'fee', 'price'] as const;
/**
 * The « open this market » link of a row. A short symbol (« BTC ») is about 28 px wide: the target is padded to 44 × 44 CSS px
 * (min-h-11 and min-w-11 = 2.75 rem), the text stays left-aligned with the column.
 */
export const COMPARE_OPEN_CLS = '-my-2 inline-flex min-h-11 min-w-11 items-center text-left font-semibold underline decoration-line underline-offset-4';
/** spread of a live best bid / offer in basis points of their mid — null unless the source gives both sides (decimal strings in, a decimal string out) */
export function liveSpreadBps(bid: string | null, ask: string | null): string | null {
  const b = dec(bid ?? ''), a = dec(ask ?? '');
  if (!b || !a || !D.gt(b, D.zero) || !D.gt(a, b)) return null;
  return D.str(D.div(D.mul(D.sub(a, b), D.from(20000n)), D.add(a, b), 4, 'half_even'));
}
const intervalText = (sec: number | null) => (sec === null ? '—' : sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);

export function CompareView({ instruments, base, onBase, onOpen }: { instruments: Instrument[]; base: string; onBase: (b: string) => void; onOpen: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const bases = useMemo(() => { const m = new Map<string, Set<string>>(); for (const i of instruments) if (i.status !== 'halted') (m.get(i.base) ?? m.set(i.base, new Set()).get(i.base)!).add(i.venue);
    const rank = (b: string) => { const i = MAJORS.indexOf(b); return i < 0 ? MAJORS.length : i; };   // a fixed, familiar order of assets — not a ranking of venues
    return [...m.entries()].filter(([, v]) => v.size > 1).sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([b]) => b).slice(0, 8); }, [instruments]);
  const q = useQuery({ queryKey: ['deriv', 'compare', base, locale], queryFn: () => dapi.compare(base, locale), refetchInterval: 15_000 });   // v8: the server's sentences in the screen's language
  const rows = useMemo(() => [...(q.data?.rows ?? [])].sort((a, b) => ORDER.indexOf(a.venue) - ORDER.indexOf(b.venue) || a.instrument.localeCompare(b.instrument)), [q.data]);   // fixed venue order: never by "quality"
  const cols: Col<CompareRow>[] = [
    { id: 'v', label: t('fxVenue'), head: true, cell: (r) => <><VenueBadge venue={r.venue} />{r.restriction ? <span className="mt-1 block text-[0.71875rem] font-normal text-warn" data-testid={r.venue === 'edgex' ? 'edgex-unavailable' : undefined}>{t(r.venue === 'edgex' ? 'exTradingUnavailable' : 'fxDataOnly')}</span> : null}</> },
    { id: 'i', label: t('fxInstrument'), head: true, cell: (r) => <button type="button" onClick={() => onOpen(r.instrument)} className={COMPARE_OPEN_CLS} data-testid="compare-open" aria-label={t('fxOpenMarket', { symbol: r.instrument })}>{r.instrument.slice(r.instrument.indexOf(':') + 1)}</button> },
    { id: 'mark', label: t('fxMark'), num: true, cell: (r) => <LiveCell id={r.instrument} flash={(q) => q.mark} render={(q) => (q.mark ? <span className="font-semibold">{fmt(q.mark, { dp: priceDp('0.01', q.mark), locale })}</span> : null)}><span className="font-semibold">{fmt(r.mark, { dp: priceDp('0.01', r.mark), locale })}</span></LiveCell> },
    { id: 'index', label: t('fxIndex'), num: true, cell: (r) => <LiveCell id={r.instrument} render={(q) => (q.index ? fmt(q.index, { dp: priceDp('0.01', q.index), locale }) : null)}>{r.index ? fmt(r.index, { dp: priceDp('0.01', r.index), locale }) : '—'}</LiveCell> },
    { id: 'fund', label: t('fxFundingPerHour'), num: true, cell: (r) => (r.funding ? <>{pct(r.funding, 5, locale, true)}<span className="block text-[0.71875rem] font-normal text-mute">{r.venue === 'gmx' ? t('fxContinuousShort') : t('fxEveryShort', { interval: intervalText(r.fundingVenue.intervalSec) })}</span></> : '—') },
    { id: 'spread', label: t('fxSpreadBps'), num: true, cell: (r) => <LiveCell id={r.instrument} render={(q) => { const s = liveSpreadBps(q.bid, q.ask); return s === null ? null : fmt(s, { dp: 2, locale }); }}>{r.spreadBps ? fmt(r.spreadBps, { dp: 2, locale }) : <span className="font-normal text-mute">{r.venue === 'gmx' ? t('fxNoBookShort') : '—'}</span>}</LiveCell> },
    { id: 'depth', label: t('fxDepth1pct'), num: true, cell: (r) => (r.depthUsd1pct ? compactUsd(r.depthUsd1pct, locale) : <span className="font-normal text-mute">{r.venue === 'gmx' ? t('fxNoBookShort') : '—'}</span>) },
    { id: 'fee', label: t('fxTakerFeeBps'), num: true, cell: (r) => (r.takerFeeBps ? fmt(r.takerFeeBps, { dp: 2, locale, trim: true }) : '—') },
    { id: 'lev', label: t('fxMaxLeverage'), num: true, cell: (r) => `${fmt(r.maxLeverage, { dp: 1, locale, trim: true })}×` },
    { id: 'coll', label: t('fxCollateral'), cell: (r) => r.collateral || '—' },
    { id: 'settle', label: t('fxSettlement'), full: true, cell: (r) => <span className="block max-w-[320px] whitespace-normal text-[0.78125rem] font-normal leading-snug text-mute md:w-[280px]">{r.settlement || '—'}</span> },
    { id: 'notes', label: t('fxNotes'), full: true, cell: (r) => (r.notes.length ? <details className="max-w-[360px] whitespace-normal md:w-[320px]"><summary className="flex min-h-11 cursor-pointer items-center text-[0.8125rem] font-medium text-blue">{t('fxNotesCount', { n: r.notes.length })}</summary>
      <ul className="list-disc space-y-1 pb-1 pl-4 text-[0.78125rem] font-normal leading-snug text-mute">{r.restriction ? <li>{r.restriction}</li> : null}{r.notes.map((n) => <li key={n}>{n}</li>)}</ul></details> : '—') },
  ];
  const present = ORDER.filter((v) => rows.some((r) => r.venue === v));
  const shown = bases.includes(base) ? bases : [base, ...bases];
  useQuoteSubscriptions(useMemo(() => rows.map((r) => r.instrument), [rows]));
  return (
    <div className="space-y-4" data-testid="compare-view">
      {/* v11: what the position would cost on each venue (estimates from real books), above the table of contract facts */}
      <CostCompare underlying={base} onUnderlying={onBase} onOpen={onOpen} />
      <Card>
        <H>{t('fxCompareTitle', { base })}</H>
        <div className="mb-3"><LiveStatus venues={present} names={VENUE_NAME} /></div>
        {bases.length > 0 && <Seg size="sm" label={t('fxBaseAsset')} value={base} onChange={onBase} options={shown.map((b) => ({ id: b, label: <span className="inline-flex items-center gap-1.5"><Coin sym={b} size={18} />{b}</span>, aria: b }))} className="mb-3 max-w-2xl" />}
        <div className="mb-3"><Notice tone="warn"><b className="font-semibold">{t('fxNotInterchangeable')}</b> {t('fxNotInterchangeableBody')}</Notice></div>
        {(q.data?.errors.length ?? 0) > 0 && <div className="mb-3"><Notice tone="warn">{t('fxVenueErrors', { venues: q.data!.errors.map((e) => VENUE_NAME[e.venue as VenueId] ?? e.venue).join(', ') })}</Notice></div>}
        {q.isLoading ? <div className="space-y-3 py-1" aria-hidden="true">{[0, 1, 2].map((k) => <div key={k} className="flex items-center gap-3"><div className="skel h-6 w-28 !rounded-full" /><div className="skel h-4 w-14 !rounded-md" /><div className="skel h-4 flex-1 !rounded-md" /></div>)}</div>
          : q.isError ? <Notice tone="danger">{errText(t, q.error) || t('fxErrGeneric')}</Notice>
          : <DataTable label={t('fxCompareTitle', { base })} cols={cols} rows={rows} rowKey={(r) => r.instrument} empty={t('fxCompareEmpty', { base })} emptyIcon="bars" />}
        <p className="mt-3 text-[0.75rem] leading-snug text-mute">{t('fxCompareNote')}</p>
      </Card>
      <Card>
        <H>{t('fxDiffTitle')}</H>
        <div className={`grid grid-cols-1 gap-x-8 gap-y-6 ${present.length > 3 ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>{(present.length ? present : ORDER).map((v) => <section key={v} className="min-w-0 border-line max-xl:border-t max-xl:pt-5 max-xl:first:border-t-0 max-xl:first:pt-0 xl:border-l xl:pl-8 xl:first:border-l-0 xl:first:pl-0" aria-label={VENUE_NAME[v]}>
          <div className="flex items-center gap-2.5"><VenueIcon venue={v} size={32} /><h3 className="text-[1rem] font-semibold tracking-[-0.01em]">{VENUE_NAME[v]}</h3></div>
          <dl className="mt-3 space-y-3">{FIELDS.map((k) => <div key={k}><dt className="t-eyebrow">{t(`fxDiffField_${k}` as Key)}</dt><dd className="mt-0.5 text-[0.84375rem] leading-snug">{t((v === 'edgex' ? `exDiff_${k}` : `fxDiff_${v}_${k}`) as Key)}</dd></div>)}</dl>
        </section>)}</div>
        <ul className="mt-5 list-disc space-y-1.5 border-t border-line pl-5 pt-4 text-[0.84375rem] leading-snug">{(['fxNever1', 'fxNever2', 'fxNever3', 'fxNever4'] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul>
        <p className="mt-3 text-[0.75rem] leading-snug text-mute">{t('fxDiffSource')}</p>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------ v11 — cost comparator
// What holding ONE position would cost on each venue: `GET /markets-hub/compare`, computed by the server from the real
// instrument, book (GMX: pool figures), ticker, fee schedule and funding rate. Everything shown is an ESTIMATE; a figure the
// server could not compute is « — » with its reason; a venue the wallet cannot trade on is shown and flagged. A table, never a
// recommendation: fixed venue order, no "best" mark, and no word that promises an outcome (apps/web/test/markets.test.ts).

const VENUE_COLOR: Record<string, string> = { hyperliquid: 'var(--s1)', gmx: 'var(--s2)', dydx: 'var(--s3)', edgex: 'var(--s4)' };
const CHART_HOURS = 72;
type ChartMode = 'funding' | 'gap' | 'price';

function Fig({ f, children }: { f: Figure | undefined; children: (v: string) => ReactNode }) {
  if (f && f.value !== null) return <>{children(f.value)}</>;
  return <span className="font-normal text-mute" title={f?.reason ?? undefined}>—{f?.reason ? <span className="block max-w-[220px] whitespace-normal text-[0.6875rem] leading-snug">{f.reason}</span> : null}</span>;
}
/** the row's marks: not tradable (with the reason), stale, price far from the other venues */
function RowFlags({ r }: { r: CostRow }) {
  const t = useT(); const { locale } = useContext(I18n);
  return <>{!r.tradable && <span className="mt-1 block max-w-[220px] whitespace-normal text-[0.71875rem] font-normal leading-snug text-warn" data-testid="cp-not-tradable"><b className="font-semibold">{t('cpNotTradable')}</b> {t(reasonKey(r.tradableReason) as Key)}</span>}
    {r.stale && <span className="mt-1 block text-[0.71875rem] font-normal text-warn" data-testid="cp-stale">{t('mkStale', { age: ageLabel(r.ageMs, locale) })}</span>}
    {r.priceOutlier && <span className="mt-1 block max-w-[220px] whitespace-normal text-[0.71875rem] font-normal leading-snug text-danger">{t('cpOutlier')}</span>}</>;
}
const coded = (t: (k: Key) => string, c: Coded): string => { const k = textKey(c.code); return k ? t(k as Key) : c.text; };

export function CostCompare({ underlying, onUnderlying, onOpen }: { underlying: string; onUnderlying: (u: string) => void; onOpen: (instrument: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [form, setForm] = useState<CompareForm>(() => defaultCompareForm(underlying));
  const [mode, setMode] = useState<ChartMode>('funding');
  useEffect(() => { setForm((f) => (f.underlying === underlying ? f : { ...f, underlying })); }, [underlying]);
  const parsed = useMemo(() => compareParams(form, locale), [form, locale]);
  // the last readable form is what is computed: a half-typed number does not blank the table
  const [params, setParams] = useState(() => (parsed.ok ? parsed.params : null));
  useEffect(() => { if (parsed.ok) setParams(parsed.params); }, [parsed]);
  const list = useQuery({ queryKey: ['mh', 'underlyings'], queryFn: mapi.underlyings, staleTime: 60_000 });
  const q = useQuery({ queryKey: ['mh', 'compare', params], queryFn: () => mapi.compare(params!), enabled: params !== null, refetchInterval: 15_000, placeholderData: (prev) => prev });
  const rows = q.data?.rows ?? [];
  useQuoteSubscriptions(useMemo(() => (q.data?.rows ?? []).map((r) => r.instrument), [q.data]));
  const picks = useMemo(() => { const c = (list.data ?? []).filter((u) => u.comparable).map((u) => u.underlying).slice(0, 10); return c.includes(underlying) ? c : [underlying, ...c]; }, [list.data, underlying]);
  const more = useMemo(() => (list.data ?? []).filter((u) => !picks.includes(u.underlying)), [list.data, picks]);

  // history for the comparison chart: one read per venue, each on its own (a venue that cannot be read stays in the legend with « — »)
  const hist = useQueries({ queries: rows.map((r) => ({ queryKey: ['mh', 'hist', mode === 'funding' ? 'f' : 'c', r.instrument], staleTime: 60_000, retry: false,
    queryFn: async (): Promise<SeriesPoint[]> => (mode === 'funding' ? (async () => { const f = await dapi.funding(r.instrument, CHART_HOURS); return fundingSeries(f.history, f.intervalSec); })()
      : (async () => (await dapi.candles(r.instrument, '1h', CHART_HOURS)).map((c) => ({ t: c.ts, v: Number(c.close) / Number(r.multiplier || '1') })).filter((p) => Number.isFinite(p.v)))()) })) });
  const series = useMemo(() => { const raw = rows.map((r, k) => ({ id: r.venue, label: VENUE_NAME[r.venue as VenueId] ?? r.venueName, color: VENUE_COLOR[r.venue] ?? 'var(--s5)', points: hist[k]?.data ?? [] }));
    if (mode !== 'gap') return raw; const g = gapToMedianBps(raw); return raw.map((s, k) => ({ ...s, points: g[k]!.points })); }, [rows, hist, mode]);   // eslint-disable-line react-hooks/exhaustive-deps -- `hist` changes identity with its data
  const timeFmt = (ts: number) => timeOf(ts, locale, true);
  const valFmt = (v: number) => (mode === 'funding' ? `${numFmt(v, locale, 2, 2)} %` : mode === 'gap' ? `${numFmt(v, locale, 1, 1)} ${t('cpBps')}` : numFmt(v, locale, v < 1 ? 6 : 2));

  const field = (id: 'notional' | 'leverage' | 'horizon', label: string, suffix: string, maxDecimals: number) => {
    const bad = !parsed.ok && parsed.problem.field === id ? parsed.problem.error : null;
    return <label className="block min-w-0"><span className="mb-1 block text-[0.75rem] font-medium text-mute">{label}</span>
      <span className="relative block"><input inputMode="decimal" autoComplete="off" value={form[id]} aria-invalid={bad !== null} data-testid={`cp-${id}`}
        onChange={(e) => setForm({ ...form, [id]: sanitizeAmountText(e.target.value) })} className={`${inputCls} !py-2.5 pr-12 text-[0.9375rem] tabular-nums ${bad ? '!border-danger' : ''}`} />
        <span className="pointer-events-none absolute inset-y-0 right-3.5 grid place-items-center text-[0.78125rem] text-mute">{suffix}</span></span>
      {bad === 'range' || bad === 'empty' ? <span role="alert" className="mt-1.5 block text-[0.78125rem] leading-snug text-danger">{t(`cpRange_${id}` as Key)}</span> : <AmountProblem text={form[id]} maxDecimals={maxDecimals} />}</label>;
  };

  const cols: Col<CostRow>[] = [
    { id: 'v', label: t('fxVenue'), head: true, cell: (r) => <><VenueBadge venue={r.venue as VenueId} /><RowFlags r={r} /></> },
    { id: 'i', label: t('fxInstrument'), head: true, cell: (r) => <><button type="button" onClick={() => onOpen(r.instrument)} className={COMPARE_OPEN_CLS} data-testid="cp-open" aria-label={t('fxOpenMarket', { symbol: r.instrument })}>{r.symbol}</button>
      {r.multiplier !== '1' && <span className="block text-[0.71875rem] font-normal text-mute">{t('mkMultiplier', { n: r.multiplier, u: r.underlying })}</span>}{r.alternatives.length > 0 && <span className="block text-[0.71875rem] font-normal text-mute">{t('cpAlternatives', { n: r.alternatives.length })}</span>}</> },
    { id: 'px', label: t('cpPrice'), num: true, cell: (r) => <><Fig f={r.cost?.midPrice}>{(v) => <span className="font-semibold">{fmt(v, { dp: priceDp('0.01', v), locale })}</span>}</Fig>
      {/* v11 live quotes: the price NOW, next to the one the estimate was computed on — the estimate itself is not recomputed per tick */}
      <LiveCell id={r.instrument} flash={(q) => q.mid ?? q.mark} render={(q) => { const p = q.mid ?? q.mark; return p ? <span className="block text-[0.71875rem] font-normal text-mute" data-testid="cp-live">{t('qtLiveNow', { value: fmt(p, { dp: priceDp('0.01', p), locale }) })}</span> : null; }}>{null}</LiveCell></> },
    { id: 'spread', label: t('fxSpreadBps'), num: true, cell: (r) => <Fig f={r.cost?.spreadBps}>{(v) => fmt(v, { dp: 2, locale })}</Fig> },
    { id: 'depth', label: t('cpDepth'), num: true, cell: (r) => (r.depth ? <span className="block text-[0.78125rem] leading-snug">{r.depth.map((l) => <span key={l.bps} className="block whitespace-nowrap"><span className="text-mute">{l.bps} {t('cpBps')}</span> {compactUsd(l.bidUsd, locale)}{l.bidComplete ? '' : '+'} / {compactUsd(l.askUsd, locale)}{l.askComplete ? '' : '+'}</span>)}</span>
      : <span className="block max-w-[200px] whitespace-normal text-[0.71875rem] font-normal leading-snug text-mute">{r.cost?.executionModel === 'pool' ? t('cpNoBook') : r.depthReason ?? '—'}</span>) },
    { id: 'slip', label: t('cpSlippage'), num: true, cell: (r) => <Fig f={r.cost?.entrySlippageUsd}>{(v) => <>{usd(v, locale)}<span className="block text-[0.71875rem] font-normal text-mute">{fmt(r.cost?.entrySlippageBps.value ?? null, { dp: 2, locale })} {t('cpBps')}</span></>}</Fig> },
    { id: 'fees', label: t('cpFees'), num: true, cell: (r) => <Fig f={r.cost?.entryFeeUsd}>{(v) => <>{usd(D.add(dec(v)!, dec(r.cost?.exitFeeUsd.value ?? '0') ?? D.zero), locale)}
      {r.fees && <span className="block text-[0.71875rem] font-normal text-mute" title={r.fees.source}>{pct(r.fees.takerRate, 3, locale)} · {t('cpAsOf', { date: r.fees.asOf })}</span>}</>}</Fig> },
    { id: 'fund', label: t('cpFunding'), num: true, cell: (r) => <Fig f={r.cost?.fundingUsd}>{(v) => <>{usd(v, locale, true)}{r.funding && <span className="block text-[0.71875rem] font-normal text-mute">{pctText(r.funding.annualised, 2, locale, true)} {t('cpPerYear')} · {t('fxEveryShort', { interval: intervalText(r.funding.intervalSec) })}</span>}</>}</Fig> },
    { id: 'lev', label: t('fxMaxLeverage'), num: true, cell: (r) => <Fig f={r.cost?.maxLeverage}>{(v) => `${fmt(v, { dp: 1, locale, trim: true })}×`}</Fig> },
    { id: 'coll', label: t('cpCollateral'), num: true, cell: (r) => <Fig f={r.cost?.collateralRequiredUsd}>{(v) => usd(v, locale)}</Fig> },
    { id: 'liq', label: t('cpLiquidation'), num: true, cell: (r) => <Fig f={r.cost?.liquidationPrice}>{(v) => <>{fmt(v, { dp: priceDp('0.01', v), locale })}<span className="block text-[0.71875rem] font-normal text-mute">{t('cpLiqDistance', { pct: pctText(r.cost?.liquidationDistanceBps.value ? String(Number(r.cost.liquidationDistanceBps.value) / 10_000) : null, 1, locale) })}</span></>}</Fig> },
    { id: 'total', label: t('cpTotal'), num: true, cell: (r) => <Fig f={r.cost?.totalCostUsd}>{(v) => <span data-testid="cp-total"><b className="font-semibold">{usd(v, locale)}</b><span className="block text-[0.71875rem] font-normal text-mute">{fmt(r.cost?.totalCostBps.value ?? null, { dp: 2, locale })} {t('cpBps')}</span></span>}</Fig> },
    { id: 'items', label: t('cpItemised'), full: true, cell: (r) => <details className="max-w-[340px] whitespace-normal md:w-[300px]"><summary className="flex min-h-11 cursor-pointer items-center text-[0.8125rem] font-medium text-blue">{t('cpItemisedOpen')}</summary>
      <dl className="space-y-1.5 pb-1 text-[0.78125rem] font-normal leading-snug">{costItems(r.cost).map((it) => <div key={it.id} className="flex justify-between gap-3"><dt className="text-mute">{t(`cpItem_${it.id}` as Key)}</dt>
        <dd className="text-right font-medium" title={it.basis ?? undefined}>{it.usd !== null ? usd(it.usd, locale, it.id === 'fundingUsd') : <span className="font-normal text-mute">— {it.reason ?? r.error ?? ''}</span>}</dd></div>)}
        {r.maintenance && <div className="pt-1 text-[0.71875rem] text-mute">{t('cpMaintenance', { pct: pct(r.maintenance.fraction, 2, locale) })}</div>}</dl></details> },
  ];
  const disc = topDiscrepancies(q.data?.discrepancies ?? []), flagged = disc.filter((d) => d.flagged).length;
  const venueName = (v: string) => VENUE_NAME[v as VenueId] ?? v;
  return (
    <div className="space-y-4" data-testid="cost-compare">
      <Card>
        <H>{t('cpTitle', { u: underlying })}</H>
        <Seg size="sm" label={t('cpUnderlying')} value={underlying} onChange={onUnderlying} options={picks.map((b) => ({ id: b, label: <span className="inline-flex items-center gap-1.5"><Coin sym={b} size={18} />{b}</span>, aria: b }))} className="mb-3 max-w-3xl" />
        {more.length > 0 && <label className="mb-3 flex max-w-xs items-center gap-2 text-[0.8125rem] text-mute"><span className="shrink-0">{t('cpOther')}</span>
          <select aria-label={t('cpUnderlying')} value="" onChange={(e) => { if (e.target.value) onUnderlying(e.target.value); }} className={`${inputCls} !py-2 text-[0.875rem]`} data-testid="cp-underlying-more"><option value="">—</option>
            {more.map((u) => <option key={u.underlying} value={u.underlying}>{u.underlying}{u.category && u.category !== 'crypto' ? ` · ${t(`mkCat_${u.category}` as Key)}` : ''} ({u.venues.length})</option>)}</select></label>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1"><span className="mb-1 block text-[0.75rem] font-medium text-mute">{t('fxDirection')}</span>
            <Seg size="sm" label={t('fxDirection')} value={form.side} onChange={(side) => setForm({ ...form, side })} options={[{ id: 'long', label: t('fxLong') }, { id: 'short', label: t('fxShort') }]} /></div>
          {field('notional', t('cpNotional'), 'USD', 8)}{field('leverage', t('cpLeverage'), '×', 8)}{field('horizon', t('rxHorizon'), 'h', 4)}
        </div>
        <p className="mt-2 text-[0.75rem] leading-snug text-mute">{t('cpFormNote')}</p>
      </Card>
      <Card>
        <H right={q.data ? <span className="inline-flex flex-wrap items-center justify-end gap-2 text-[0.75rem] font-normal text-mute">{t('cpAsOfNow', { time: timeOf(q.data.ts, locale) })}
          <Btn kind="soft" onClick={() => void q.refetch()} disabled={q.isFetching} data-testid="cp-recompute">{t('qtRecompute')}</Btn></span> : undefined}>{t('cpTableTitle')}</H>
        <div className="mb-3"><Notice tone="info">{t('cpDisclaimer')}</Notice></div>
        {(q.data?.errors.length ?? 0) > 0 && <div className="mb-3"><Notice tone="warn">{t('fxVenueErrors', { venues: q.data!.errors.map((e) => venueName(e.source)).join(', ') })}</Notice></div>}
        {q.isLoading ? <div className="space-y-3 py-1" aria-hidden="true">{[0, 1, 2, 3].map((k) => <div key={k} className="flex items-center gap-3"><div className="skel h-6 w-28 !rounded-full" /><div className="skel h-4 flex-1 !rounded-md" /></div>)}</div>
          : q.isError && !q.data ? <Notice tone="danger">{errText(t, q.error) || t('fxErrGeneric')}</Notice>
          : <DataTable label={t('cpTableTitle')} cols={cols} rows={rows} rowKey={(r) => r.instrument} empty={t('cpEmpty', { u: underlying })} emptyIcon="bars" />}
        <p className="mt-3 text-[0.75rem] leading-snug text-mute">{t('cpTableNote')}</p>
        {q.data && <details className="mt-2"><summary className="flex min-h-11 cursor-pointer items-center text-[0.8125rem] font-medium text-blue" data-testid="cp-assumptions">{t('cpAssumptions', { n: q.data.texts.assumptions.length })}</summary>
          <ul className="list-disc space-y-1 pb-1 pl-5 text-[0.78125rem] leading-snug text-mute">{q.data.texts.assumptions.map((a) => <li key={a.code}>{coded(t, a)}</li>)}</ul></details>}
      </Card>
      <Card>
        <H>{t('cpChartTitle', { u: underlying, h: CHART_HOURS })}</H>
        <Seg size="sm" tabs label={t('cpChartTitle', { u: underlying, h: CHART_HOURS })} value={mode} onChange={setMode} className="mb-3 max-w-md" options={[{ id: 'funding', label: t('cpChartFunding') }, { id: 'gap', label: t('cpChartGap') }, { id: 'price', label: t('cpChartPrice') }]} />
        <MultiSeriesChart series={series} format={valFmt} formatTime={timeFmt} label={t(`cpChart_${mode}` as Key)} zero={mode !== 'price'} empty={hist.some((h) => h.isLoading) ? t('loading') : t('cpChartEmpty')} />
        <p className="mt-2 text-[0.75rem] leading-snug text-mute">{t(`cpChart_${mode}` as Key)}</p>
      </Card>
      <Card>
        <H>{t('cpDiscTitle')}</H>
        <p className="mb-3 text-[0.8125rem] leading-snug text-mute">{t('cpDiscIntro')}</p>
        {disc.length === 0 ? <p className="text-[0.84375rem]" data-testid="cp-disc-none">{t('cpDiscNone')}</p> : <>
          <p className="mb-2 text-[0.84375rem] font-medium" data-testid="cp-disc-summary">{flagged ? t('cpDiscFlagged', { n: flagged }) : t('cpDiscNoneAbove')}</p>
          <ul className="divide-y divide-line">{disc.map((d) => <li key={`${d.longInstrument}>${d.shortInstrument}`} className="py-3 first:pt-0" data-testid="cp-disc">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><span className="text-[0.875rem] font-semibold">{t('cpDiscPair', { long: venueName(d.longVenue), short: venueName(d.shortVenue) })}</span>
              <span className="text-[0.84375rem] tabular-nums"><span className="text-mute">{t('cpDiscNet')}</span> <b className="font-semibold">{fmt(d.netEdgeEstimateBps, { dp: 2, locale, sign: true })} {t('cpBps')}</b></span></div>
            <p className="mt-1 text-[0.78125rem] leading-snug text-mute">{t('cpDiscGross', { bps: fmt(d.grossGapBps, { dp: 2, locale, sign: true }) })}{d.costsUsd ? ` · ${t('cpDiscCosts', { fees: usd(d.costsUsd.feesUsd, locale), slip: usd(d.costsUsd.exitSlippageUsd, locale), funding: usd(d.costsUsd.fundingUsd, locale, true) })}` : ''}</p>
            {d.flagged && <p className="mt-1 text-[0.78125rem] font-medium text-warn">{t('cpDiscAbove')}</p>}
            {!d.actionableFromWallet && <p className="mt-1 text-[0.78125rem] text-warn">{t('cpDiscNotActionable')}</p>}
            <details className="mt-1"><summary className="flex min-h-11 cursor-pointer items-center text-[0.8125rem] font-medium text-blue">{t('cpDiscDetails', { a: d.assumptions.length, r: d.risks.length })}</summary>
              <div className="grid gap-4 pb-1 md:grid-cols-2"><div><div className="t-eyebrow mb-1">{t('cpAssumptionsHead')}</div><ul className="list-disc space-y-1 pl-5 text-[0.78125rem] leading-snug text-mute">{d.assumptions.map((a) => <li key={a.code}>{coded(t, a)}</li>)}</ul></div>
                <div><div className="t-eyebrow mb-1">{t('cpRisksHead')}</div><ul className="list-disc space-y-1 pl-5 text-[0.78125rem] leading-snug text-mute">{d.risks.map((a) => <li key={a.code}>{coded(t, a)}</li>)}</ul></div></div></details>
          </li>)}</ul></>}
      </Card>
    </div>
  );
}

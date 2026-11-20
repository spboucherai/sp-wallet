/**
 * V11 Markets — the universal explorer (spot assets of the wallet's registry and the perpetuals of the four venues, in one
 * list) and the entry to the venue comparator. READ-ONLY: `GET /markets-hub`. A row leads to the existing Asset screen (spot),
 * to the Futures terminal (a perp the wallet can trade), or to a read-only market sheet — chart, book, funding — for a market
 * the wallet cannot trade; that sheet has no order form and no button that would suggest one.
 * Every row says how old its figure is; a venue that cannot be read is named, the others stay on screen.
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import type { Nav } from '../App';
import { fundingSeries, type SeriesPoint } from '../chart-geom';
import { MultiSeriesChart } from '../chart-multi';
import { CompareView } from '../derivatives/Compare';
import { dapi } from '../derivatives/api';
import { DataTable, Seg, timeOf, VENUE_NAME, VenueBadge, type Col } from '../derivatives/bits';
import { compactUsd, fmt, priceDp } from '../derivatives/dec';
import type { VenueId } from '../derivatives/types';
import { errText, I18n, useT, type Key } from '../i18n';
import { ageLabel, CATEGORIES, defaultFilters, freshness, SHOWN_HUB_VENUES, mapi, nextSort, pctText, reasonKey, rowTarget, unmappedKey, type Category, type HubFilters, type HubRow, type HubSort } from '../markets';
import { useConn, useQuoteSubscriptions, type LiveQuote } from '../quotes';   // v11 live quotes
import { LiveCell, LiveStatus, QuoteDot } from '../quotes-ui';
import { hubVenueParam, MULTI_VENUE, venueShown } from '../venues';   // which venues the owner is offered
import { Btn, Card, Chips, Coin, ErrorState, Fact, Icon, inputCls, Notice, numFmt, PageTitle, Sheet, Stat, StatGrid, Tag } from '../ui';

export type MarketsView = 'explorer' | 'compare';
const PAGE = 50;
const TONE = { fresh: 'ok', aging: 'mute', stale: 'warn', none: 'mute' } as const;
// v11 live quotes. The id a row ticks on: its own for a perpetual; for a spot asset, the symbol it is priced as (WBTC ticks as BTC).
// A row without one (a cash leg) keeps the listing's figure.
export const liveIdOf = (r: Pick<HubRow, 'id' | 'kind' | 'underlying'>): string | null => (r.kind === 'perp' ? r.id : r.underlying ? `spot:${r.underlying}` : null);
/** the price a row shows from a quote: the mark for a perpetual (as the listing does), the last trade for spot — null when the source gives neither */
export const livePriceOf = (r: Pick<HubRow, 'kind'>, q: Pick<LiveQuote, 'mark' | 'mid' | 'last'>): string | null => (r.kind === 'perp' ? q.mark ?? q.mid ?? q.last : q.last ?? q.mid);
/** the venue's funding rate per interval as a simple yearly fraction (the listing's `annualised`), for the live cell */
export const annualisedOf = (rate: string, intervalSec: number): string => ((Number(rate) * 31_536_000) / intervalSec).toFixed(8);

/** freshness of one row: a dot is never alone — the age is written next to it, and « périmé » in words when it is */
function Fresh({ r }: { r: HubRow }) {
  const t = useT(); const { locale } = useContext(I18n);
  const f = freshness(r);
  if (f === 'none') return <span className="text-[0.75rem] text-mute" data-testid="mk-fresh" data-fresh="none">{t('mkNoData')}</span>;
  return <span className={`inline-flex items-center gap-1.5 text-[0.75rem] ${f === 'stale' ? 'font-medium text-warn' : 'text-mute'}`} data-testid="mk-fresh" data-fresh={f} title={r.sourceTs ? timeOf(r.sourceTs, locale, true) : undefined}>
    <span className={`h-1.5 w-1.5 rounded-full ${f === 'fresh' ? 'bg-emerald' : f === 'aging' ? 'bg-mute' : 'bg-warn'}`} aria-hidden="true" />{f === 'stale' ? t('mkStale', { age: ageLabel(r.ageMs, locale) }) : ageLabel(r.ageMs, locale)}</span>;
}
function NotTradable({ r, long }: { r: HubRow; long?: boolean }) {
  const t = useT();
  if (r.tradable) return null;
  return <span className={`mt-1 block text-[0.71875rem] font-normal leading-snug text-warn ${long ? '' : 'max-w-[240px] whitespace-normal'}`} data-testid="mk-not-tradable" data-reason={r.tradableReason ?? ''}>
    <b className="font-semibold">{t(r.kind === 'spot' ? 'mkNotSwappable' : 'mkNotTradable')}</b> {t(reasonKey(r.tradableReason) as Key)}{r.paper ? ` ${t('mkPaperOk')}` : ''}</span>;
}

export function Markets({ view: asked, underlying, nav }: { view: MarketsView; underlying?: string; nav: Nav }) {
  const view: MarketsView = MULTI_VENUE ? asked : 'explorer';   // comparing venues needs two of them (venues.ts)
  const t = useT(); const { locale } = useContext(I18n);
  const [f, setF] = useState<HubFilters>(() => ({ ...defaultFilters('perp'), limit: PAGE }));
  const [sheet, setSheet] = useState<HubRow | null>(null);
  const set = (patch: Partial<HubFilters>) => setF((x) => ({ ...x, offset: 0, ...patch }));
  // v11 live quotes: the rows tick from the websocket; the listing itself (order, pages, volumes) is re-read less often while the stream is live,
  // and at the cadence it always had when the stream cannot connect
  const conn = useConn();
  const q = useQuery({ queryKey: ['mh', 'list', f], queryFn: async () => { const d = await mapi.list({ ...f, venue: hubVenueParam(f.venue) }); return { ...d, rows: d.rows.filter((r) => r.kind !== 'perp' || venueShown(r.venue)) }; }, refetchInterval: conn === 'live' ? 30_000 : 10_000, placeholderData: (prev) => prev, enabled: view === 'explorer' });
  useQuoteSubscriptions(useMemo(() => (view === 'explorer' ? (q.data?.rows ?? []).map(liveIdOf).filter((x): x is string => x !== null) : []), [q.data, view]));
  const instruments = useQuery({ queryKey: ['deriv', 'instruments', locale], queryFn: () => dapi.instruments(undefined, locale), staleTime: 60_000, enabled: view === 'compare' });
  const open = (r: HubRow) => { const to = rowTarget(r); if (to.kind === 'asset') nav({ tab: 'asset', network: to.network, asset: to.asset }); else if (to.kind === 'futures') nav({ tab: 'futures', asset: to.instrument }); else setSheet(r); };
  const base = (underlying ?? 'BTC').toUpperCase();

  const sortHead = (col: HubSort, label: string): ReactNode => { const on = f.sort === col; return (
    <button type="button" onClick={() => set(nextSort(f, col))} aria-pressed={on} data-testid={`mk-sort-${col}`} aria-label={`${label} — ${t(on ? (f.dir === 'desc' ? 'mkSortedDesc' : 'mkSortedAsc') : 'mkSortBy')}`}
      className={`-my-1 inline-flex min-h-9 items-center gap-1 rounded-md ${on ? 'font-semibold text-ink' : ''}`}>{label}{on && <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={f.dir === 'desc' ? 'M6 10L1.5 3h9z' : 'M6 2l4.5 7h-9z'} fill="currentColor" /></svg>}</button>); };
  const perp = f.kind === 'perp';
  const cols: Col<HubRow>[] = [
    { id: 'm', label: sortHead('symbol', t('fxMarket')), head: true, cell: (r) => <span className="inline-flex min-w-0 flex-col"><button type="button" onClick={() => open(r)} data-testid="mk-open" aria-label={t('mkOpen', { symbol: r.symbol })}
      className="-my-1 inline-flex min-h-11 min-w-11 items-center gap-2 text-left font-semibold"><Coin sym={r.underlying ?? r.base} size={22} /><span className="underline decoration-line underline-offset-4">{r.symbol}</span></button>
      {r.kind === 'perp' && r.multiplier !== null && r.multiplier !== '1' && <span className="text-[0.71875rem] font-normal text-mute">{t('mkMultiplier', { n: r.multiplier, u: r.underlying ?? '' })}</span>}
      {r.kind === 'perp' && r.underlying === null && <span className="max-w-[240px] whitespace-normal text-[0.71875rem] font-normal leading-snug text-mute" data-testid="mk-unmapped">{t(unmappedKey(r.mapping.unmapped) as Key)}</span>}
      <NotTradable r={r} /></span> },
    ...(perp && MULTI_VENUE ? [{ id: 'v', label: t('fxVenue'), head: true, cell: (r: HubRow) => <VenueBadge venue={r.venue as VenueId} /> } satisfies Col<HubRow>] : []),
    { id: 'px', label: t('mkPrice'), num: true, cell: (r) => <LiveCell id={liveIdOf(r)} flash={(q) => livePriceOf(r, q)} render={(q) => { const p = livePriceOf(r, q); return p ? <span className="font-semibold tabular-nums">{fmt(p, { dp: priceDp('0.01', p), locale })}</span> : null; }}>
      {r.price ? <span className="font-semibold tabular-nums">{fmt(r.price, { dp: priceDp('0.01', r.price), locale })}</span> : <span className="text-mute">—</span>}</LiveCell> },
    { id: 'chg', label: sortHead('change', t('mkChange')), num: true, cell: (r) => <LiveCell id={liveIdOf(r)} render={(q) => (q.change24h === null ? null : <span className={Number(q.change24h) < -0.00005 ? 'text-danger' : 'text-emerald'}>{pctText(q.change24h, 2, locale, true)}</span>)}>
      {r.change24h === null ? <span className="text-mute">—</span> : <span className={Number(r.change24h) < -0.00005 ? 'text-danger' : 'text-emerald'}>{pctText(r.change24h, 2, locale, true)}</span>}</LiveCell> },
    { id: 'vol', label: sortHead('volume', t('mkVolume')), num: true, cell: (r) => compactUsd(r.volume24hUsd, locale) },
    ...(perp ? [
      { id: 'oi', label: sortHead('openInterest', t('mkOpenInterest')), num: true, cell: (r: HubRow) => compactUsd(r.openInterestUsd, locale) },
      { id: 'fund', label: sortHead('funding', t('mkFunding')), num: true, cell: (r: HubRow) => (r.funding ? <LiveCell id={r.id} render={(q) => (q.funding === null ? null : <>{pctText(annualisedOf(q.funding, r.funding!.intervalSec), 2, locale, true)}<span className="block text-[0.71875rem] font-normal text-mute" data-testid="mk-funding-raw">{t('mkFundingRaw', { rate: pctText(q.funding, 4, locale, true), interval: r.funding!.intervalSec % 3600 === 0 ? `${r.funding!.intervalSec / 3600} h` : `${Math.round(r.funding!.intervalSec / 60)} min` })}</span></>)}><>{pctText(r.funding.annualised, 2, locale, true)}<span className="block text-[0.71875rem] font-normal text-mute" data-testid="mk-funding-raw">{t('mkFundingRaw', { rate: pctText(r.funding.rate, 4, locale, true), interval: r.funding.intervalSec % 3600 === 0 ? `${r.funding.intervalSec / 3600} h` : `${Math.round(r.funding.intervalSec / 60)} min` })}</span></></LiveCell> : <span className="text-mute">—</span>) },
      { id: 'lev', label: t('fxMaxLeverage'), num: true, cell: (r: HubRow) => (r.maxLeverage ? `${fmt(r.maxLeverage, { dp: 1, locale, trim: true })}×` : '—') },
    ] satisfies Col<HubRow>[] : []),
    { id: 'age', label: t('mkFreshness'), num: true, cell: (r) => { const id = liveIdOf(r); return id ? <QuoteDot id={id}><Fresh r={r} /></QuoteDot> : <Fresh r={r} />; } },
  ];
  const d = q.data, from = d ? (d.total === 0 ? 0 : d.offset + 1) : 0, to = d ? Math.min(d.total, d.offset + d.rows.length) : 0;
  return (
    <div className="space-y-4" data-testid="markets">
      <PageTitle>{t('mkTitle')}</PageTitle>
      {/* v11 interface: Explorer · Compare · Private markets are the sub-views of the Markets area — the shell lists them above this title (App.tsx) */}
      {view === 'compare' ? <CompareView instruments={instruments.data?.instruments ?? []} base={base} onBase={(b) => nav({ tab: 'markets', view: 'compare', asset: b })} onOpen={(m) => nav({ tab: 'futures', asset: m })} />
        : <>
          <Card>
            <div className="flex flex-wrap items-center gap-3">
              <Seg tabs size="sm" label={t('mkKind')} value={f.kind} onChange={(kind) => setF({ ...defaultFilters(kind), limit: PAGE, q: f.q })} className="w-full sm:w-auto sm:min-w-[220px]" options={[{ id: 'perp', label: t('mkPerps') }, { id: 'spot', label: t('mkSpot') }]} />
              <label className="relative min-w-[180px] flex-1"><span className="sr-only">{t('mkSearch')}</span><Icon n="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
                <input type="search" value={f.q} onChange={(e) => set({ q: e.target.value.slice(0, 40) })} placeholder={t('mkSearch')} data-testid="mk-search" className={`${inputCls} !py-2.5 pl-10 text-[0.9375rem]`} /></label>
            </div>
            {perp && <div className="mt-3 space-y-2">
              {MULTI_VENUE && <Chips label={t('fxVenue')} value={f.venue} onChange={(venue) => set({ venue })} options={[{ id: '', label: t('mkAllVenues') }, ...SHOWN_HUB_VENUES.map((v) => ({ id: v as string, label: VENUE_NAME[v] }))]} />}
              <Chips label={t('mkCategory')} value={f.category} onChange={(category) => set({ category: category as Category | '' })} options={[{ id: '', label: t('mkAllCategories') }, ...CATEGORIES.map((c) => ({ id: c as string, label: t(`mkCat_${c}` as Key) }))]} />
            </div>}
            <div className="mt-3"><Chips label={t('mkTradable')} value={f.tradable} onChange={(tradable) => set({ tradable: tradable as HubFilters['tradable'] })}
              options={[{ id: '', label: t('mkTradableAll') }, { id: 'yes', label: t(perp ? 'mkTradableYes' : 'mkSwappableYes') }, { id: 'no', label: t(perp ? 'mkTradableNo' : 'mkSwappableNo') }]} /></div>
          </Card>
          <div className="px-1"><LiveStatus venues={perp ? [...SHOWN_HUB_VENUES] : ['spot']} names={{ ...VENUE_NAME, spot: t('mkSpotSource') }} /></div>
          {d && <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-[0.78125rem] text-mute" data-testid="mk-venues" aria-label={t('mkSources')}>{d.venues.filter((v) => (perp ? v.id !== 'spot' && venueShown(v.id) : v.id === 'spot')).map((v) =>
            <span key={v.id} className="inline-flex items-center gap-1.5" title={v.error ?? undefined}>{v.id === 'spot' ? t('mkSpotSource') : VENUE_NAME[v.id as VenueId] ?? v.name}
              <Tag tone={v.status === 'ok' ? 'ok' : v.status === 'stale' ? 'warn' : 'danger'} testid={`mk-venue-${v.id}`}>{t(`mkVenue_${v.status}` as Key)}{v.ageMs !== null && v.status !== 'error' ? ` · ${ageLabel(v.ageMs, locale)}` : ''}</Tag></span>)}</div>}
          {d && d.errors.filter((e) => e.source === 'spot' || venueShown(e.source)).length > 0 && <Notice tone="warn">{t('mkSourceErrors', { sources: [...new Set(d.errors.filter((e) => e.source === 'spot' || venueShown(e.source)).map((e) => (e.source === 'spot' ? t('mkSpotSource') : VENUE_NAME[e.source as VenueId] ?? e.source)))].join(', ') })}</Notice>}
          <Card>
            {q.isLoading ? <div className="space-y-3 py-1" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((k) => <div key={k} className="flex items-center gap-3"><div className="skel h-6 w-28 !rounded-full" /><div className="skel h-4 w-14 !rounded-md" /><div className="skel h-4 flex-1 !rounded-md" /></div>)}</div>
              : q.isError && !d ? <ErrorState title={t('mkLoadError')} onRetry={() => void q.refetch()}>{errText(t, q.error)}</ErrorState>
              : <DataTable label={t('mkTitle')} cols={cols} rows={d?.rows ?? []} rowKey={(r) => r.id} empty={t('mkEmpty')} emptyIcon="search" />}
            {d && d.total > 0 && <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3 text-[0.8125rem] text-mute">
              <span data-testid="mk-range" aria-live="polite">{t('mkRange', { from, to, total: numFmt(d.total, locale, 0) })}</span>
              <span className="flex gap-2"><Btn kind="soft" disabled={f.offset === 0} onClick={() => setF({ ...f, offset: Math.max(0, f.offset - PAGE) })} data-testid="mk-prev">{t('mkPrev')}</Btn>
                <Btn kind="soft" disabled={to >= d.total} onClick={() => setF({ ...f, offset: f.offset + PAGE })} data-testid="mk-next">{t('mkNext')}</Btn></span></div>}
            <p className="mt-3 text-[0.75rem] leading-snug text-mute">{t(perp ? 'mkNotePerp' : 'mkNoteSpot')}</p>
          </Card>
        </>}
      {sheet && <MarketSheet row={sheet} onClose={() => setSheet(null)} onCompare={MULTI_VENUE && sheet.underlying ? () => { const u = sheet.underlying!; setSheet(null); nav({ tab: 'markets', view: 'compare', asset: u }); } : undefined} />}
    </div>
  );
}

/** Read-only view of a market the wallet cannot trade: what it is, why it cannot be traded here, its chart, book and funding. No order form. */
export function MarketSheet({ row: r, onClose, onCompare }: { row: HubRow; onClose: () => void; onCompare?: (() => void) | undefined }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [mode, setMode] = useState<'price' | 'funding'>('price');
  const perp = r.kind === 'perp';
  const market = useQuery({ queryKey: ['mh', 'sheet', r.id], queryFn: () => dapi.market(r.id), enabled: perp, refetchInterval: 10_000, retry: false });
  const hist = useQuery({ queryKey: ['mh', 'sheet-hist', mode, r.id], enabled: perp, staleTime: 60_000, retry: false,
    queryFn: async (): Promise<SeriesPoint[]> => (mode === 'funding' ? (async () => { const h = await dapi.funding(r.id, 72); return fundingSeries(h.history, h.intervalSec); })() : (async () => (await dapi.candles(r.id, '1h', 72)).map((c) => ({ t: c.ts, v: Number(c.close) })))()) });
  const series = useMemo(() => [{ id: r.id, label: r.symbol, color: 'var(--s1)', points: hist.data ?? [] }], [hist.data, r.id, r.symbol]);
  const book = market.data?.book ?? null, dp = priceDp('0.01', r.price);
  const side = (levels: readonly (readonly [string, string])[], cls: string) => <ul className="space-y-0.5 text-[0.78125rem] tabular-nums">{levels.slice(0, 8).map(([p, s]) => <li key={p} className="flex justify-between gap-3"><span className={`font-semibold ${cls}`}>{fmt(p, { dp, locale })}</span><span className="text-mute">{fmt(s, { locale, trim: true })}</span></li>)}</ul>;
  return (
    <Sheet title={r.symbol} sub={<span className="inline-flex flex-wrap items-center gap-2">{perp ? <VenueBadge venue={r.venue as VenueId} /> : null}<Tag tone="mute" icon="eye">{t('mkReadOnly')}</Tag></span>} onClose={onClose} wide testid="mk-sheet"
      footer={onCompare ? <Btn kind="soft" full onClick={onCompare} data-testid="mk-sheet-compare">{t('mkCompareUnderlying', { u: r.underlying ?? '' })}</Btn> : undefined}>
      <div className="space-y-4">
        {!r.tradable && <Notice tone="warn"><NotTradable r={r} long /></Notice>}
        <StatGrid cols={3}>
          <Stat label={t('mkPrice')} value={r.price ? fmt(r.price, { dp, locale }) : '—'} sub={<Fresh r={r} />} />
          <Stat label={t('mkChange')} value={pctText(r.change24h, 2, locale, true)} />
          <Stat label={t('mkVolume')} value={compactUsd(r.volume24hUsd, locale)} />
          {perp && <Stat label={t('mkFunding')} value={r.funding ? pctText(r.funding.annualised, 2, locale, true) : '—'} sub={r.funding ? t('mkFundingRaw', { rate: pctText(r.funding.rate, 4, locale, true), interval: `${r.funding.intervalSec / 3600} h` }) : undefined} />}
          {perp && <Stat label={t('mkOpenInterest')} value={compactUsd(r.openInterestUsd, locale)} />}
          {perp && <Stat label={t('fxMaxLeverage')} value={r.maxLeverage ? `${fmt(r.maxLeverage, { dp: 1, locale, trim: true })}×` : '—'} />}
        </StatGrid>
        {perp && <div>
          <Seg tabs size="sm" label={t('mkChart')} value={mode} onChange={setMode} className="mb-2 max-w-xs" options={[{ id: 'price', label: t('mkChartPrice') }, { id: 'funding', label: t('mkChartFunding') }]} />
          <MultiSeriesChart series={series} label={`${r.symbol} — ${t(mode === 'price' ? 'mkChartPrice' : 'mkChartFunding')}`} zero={mode === 'funding'} format={(v) => (mode === 'funding' ? `${numFmt(v, locale, 2, 2)} %` : numFmt(v, locale, v < 1 ? 6 : 2))}
            formatTime={(ts) => timeOf(ts, locale, true)} empty={hist.isLoading ? t('loading') : t('mkChartEmpty')} />
        </div>}
        {perp && <div data-testid="mk-sheet-book">
          <div className="t-eyebrow mb-1.5">{t('mkBook')}</div>
          {market.isLoading ? <div className="skel h-24 !rounded-xl" aria-hidden="true" /> : book ? <div className="grid grid-cols-2 gap-6"><div><div className="mb-1 text-[0.71875rem] text-mute">{t('mkBids')}</div>{side(book.bids, 'text-emerald')}</div><div><div className="mb-1 text-[0.71875rem] text-mute">{t('mkAsks')}</div>{side(book.asks, 'text-danger')}</div></div>
            : <p className="text-[0.8125rem] text-mute">{market.isError ? errText(t, market.error) || t('fxErrGeneric') : t('mkNoBook')}</p>}
        </div>}
        <dl className="space-y-2">
          <Fact k={t('mkUnderlying')}>{r.underlying ? `${r.underlying}${r.multiplier && r.multiplier !== '1' ? ` — ${t('mkMultiplier', { n: r.multiplier, u: r.underlying })}` : ''}` : t(unmappedKey(r.mapping.unmapped) as Key)}</Fact>
          {r.category && <Fact k={t('mkCategory')}>{t(`mkCat_${r.category}` as Key)}</Fact>}
          {r.restriction && <Fact k={t('mkRestriction')}>{t(reasonKey(r.tradableReason) as Key)}</Fact>}
        </dl>
      </div>
    </Sheet>
  );
}

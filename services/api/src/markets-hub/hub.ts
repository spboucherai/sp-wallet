// Markets hub — ONE explorer over what the wallet can see: the perpetuals of the four venues (derivatives data service) and
// the spot assets of the wallet's registry, priced from the multi-source bars the market module stores.
//
// READ-ONLY public market data. No account, no order, no signer.
//
// Resilience rules (docs/v11/work/markets-compare.md):
//   - every venue is read on its own, inside a short budget (HUB_BUDGET_MS). A venue that hangs or throws costs the others
//     nothing: its rows come from the last good read, marked stale with their real age, or the venue is listed in `errors`;
//   - the whole listing is built once and kept HUB_TTL_MS: concurrent requests share one build (and so one upstream call per
//     venue), whatever their filters — filters, sort and pagination are applied on the snapshot;
//   - every row carries the time its source produced it (`sourceTs`), its age and a `stale` flag per the venue's cadence.
import { CASH_SYMBOLS, hasMarketData, KYBER_ENABLED, marketSymbolOf, NETWORKS, type NetworkDef } from '@spw/core';
import { D, type DecStr, type Instrument, type InstrumentCategory, type Ticker, type VenueId } from '@spw/derivatives';
import { gmxMarketByInstrument, hlPinnedAsset } from '@spw/derivatives/live';
import { annualiseFunding, groupByUnderlying, normaliseSymbols, priceOutliers, unitPrice, type SymbolMapping } from '@spw/trading';
import { capabilities } from '../capabilities.ts';
import { UserError } from '../config.ts';
import type { Derivatives } from '../derivatives/index.ts';
import type { VenueEntry } from '../derivatives/venues.ts';
import { getSeries } from '../market/series.ts';
import { listQuality } from '../market/store.ts';
import { activeMarketConfig } from '../market/symbols.ts';
import { INTERVAL_MS, expectedLastTs, isSymbol } from '../market/types.ts';
import { HUB_SORTS, type HubSort } from './schema.ts';

export { HUB_SORTS, type HubSort };

/** how long one hub request waits for a venue (shorter than the data service's own budget) */
export const HUB_BUDGET_MS = 2_500;
/** the built listing is reused this long */
export const HUB_TTL_MS = 2_000;
/** the spot part (hourly bars read from the database) is reused this long */
export const SPOT_TTL_MS = 60_000;
/**
 * A row is stale when its source figure is older than this. Per venue, from how the wallet reads it: Hyperliquid and dYdX
 * publish every ticker in one request (re-read every 3 s); edgeX needs one request per contract or its websocket; GMX is
 * polled over REST and its oracle tickers are cached upstream. Spot: an hourly bar, late once the next one should be there.
 */
export const HUB_CADENCE_MS: Record<VenueId | 'spot', number> = { hyperliquid: 15_000, dydx: 15_000, edgex: 30_000, gmx: 30_000, spot: 2 * INTERVAL_MS['1h'] + 60_000 };
export const SPOT = 'spot';

export type TradableReason = 'dydx_jurisdiction' | 'edgex_jurisdiction' | 'hl_builder_dex' | 'hl_asset_not_pinned' | 'gmx_market_not_pinned' | 'instrument_halted' | 'instrument_reduce_only'
  | 'spot_no_swap_route' | 'spot_cash_leg';
export interface HubFunding {
  /** the venue's own figure: rate per `intervalSec` that longs pay (negative: longs receive) */
  rate: DecStr; intervalSec: number;
  /** the same rate per hour and per year — simple, not compounded: the current rate held constant */
  perHour: DecStr; annualised: DecStr;
}
export interface HubRow {
  id: string; kind: 'spot' | 'perp'; venue: string; venueName: string; symbol: string; base: string; quote: string; status: string;
  /** common underlying, or null when the instrument is not mapped with certainty (then it is never compared) */
  underlying: string | null; category: InstrumentCategory | null; multiplier: DecStr | null;
  mapping: { rule: SymbolMapping['rule']; unmapped: SymbolMapping['unmapped']; note: string };
  price: DecStr | null; priceKind: 'mark' | 'close_1h';
  /** price of ONE unit of the underlying (price / multiplier) */
  unitPrice: DecStr | null;
  /** fraction (0.01 = 1 %) */
  change24h: DecStr | null;
  volume24hUsd: DecStr | null;
  funding: HubFunding | null;
  /** base units of the contract, and the same in USD at the price shown */
  openInterest: DecStr | null; openInterestUsd: DecStr | null;
  maxLeverage: DecStr | null;
  /** can the WALLET trade it: the live path exists in the code for this instrument. Server locks are reported apart (`locks`). */
  tradable: boolean; tradableReason: TradableReason | null;
  /** a paper account can trade it */
  paper: boolean;
  restriction: string | null;
  sourceTs: number | null; ageMs: number | null; stale: boolean; staleAfterMs: number; source: 'venue' | 'market-data';
  /** spot only: where the wallet holds the asset, and which exchange the bar came from */
  networks?: { network: string; asset: string }[]; priceSource?: string | null;
}
export interface VenueState { id: string; name: string; status: 'ok' | 'stale' | 'error'; rows: number; /** age of the tickers read, ms */ ageMs: number | null; restriction: string | null; error: string | null }
export interface HubSnapshot { rows: HubRow[]; venues: VenueState[]; errors: { source: string; message: string }[]; mappings: SymbolMapping[]; builtAt: number }

/** what the hub needs from the spot market-data engine (tests inject recorded bars) */
export interface SpotPort {
  ingested(): Promise<string[]>;
  quality(): Promise<{ symbol: string; interval: string; fresh: boolean; status: string }[]>;
  /** the `limit` most recent consolidated 1 h bars, oldest first */
  bars(symbol: string, limit: number): Promise<{ ts: number; close: number; volume: number; source: string }[]>;
}
export const defaultSpotPort: SpotPort = {
  ingested: async () => (await activeMarketConfig()).symbols.filter(isSymbol),
  quality: async () => (await listQuality()).map((q) => ({ symbol: q.symbol, interval: q.interval, fresh: q.fresh, status: q.status })),
  bars: async (symbol, limit) => (await getSeries(symbol, '1h', { limit })).bars,
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const mulStr = (a: DecStr, b: DecStr): DecStr => D.str(D.div(D.mul(D.from(a), D.from(b)), D.one, 2, 'half_even'));
/** a float of the market-data engine as a decimal string (market data, never an amount of custody) */
const num = (x: number, dp = 10): DecStr | null => (Number.isFinite(x) ? D.str(D.from(x.toFixed(dp))) : null);

/** can the wallet trade this perpetual, and if not, why (one stable code) */
export function perpTradability(i: Instrument, v: Pick<VenueEntry, 'id' | 'restriction'>): { tradable: boolean; reason: TradableReason | null } {
  const no = (reason: TradableReason) => ({ tradable: false, reason });
  if (v.id === 'dydx') return no('dydx_jurisdiction');
  if (v.id === 'edgex') return no('edgex_jurisdiction');
  if (v.id === 'hyperliquid' && i.symbol.includes(':')) return no('hl_builder_dex');
  if (i.status === 'halted') return no('instrument_halted');
  if (v.id === 'hyperliquid' && !hlPinnedAsset('mainnet', i.id)) return no('hl_asset_not_pinned');
  if (v.id === 'gmx' && !gmxMarketByInstrument(i.id)) return no('gmx_market_not_pinned');
  if (i.status === 'reduce_only') return no('instrument_reduce_only');
  return { tradable: true, reason: null };
}

export function perpRow(i: Instrument, t: Ticker | undefined, v: VenueEntry, m: SymbolMapping, o: { now: number; readTs: number | null; readStale: boolean }): HubRow {
  const f = t && t.funding !== null ? { rate: t.funding, intervalSec: i.fundingIntervalSec, ...(({ perHour, perYear }) => ({ perHour, annualised: perYear }))(annualiseFunding(t.funding, i.fundingIntervalSec)) } : null;
  const sourceTs = t && o.readTs !== null ? Math.min(t.ts, o.readTs) : null, ageMs = sourceTs === null ? null : Math.max(0, o.now - sourceTs), cadence = HUB_CADENCE_MS[v.id];
  const tr = perpTradability(i, v);
  return {
    id: i.id, kind: 'perp', venue: v.id, venueName: v.name, symbol: i.symbol, base: i.base, quote: i.quote, status: i.status,
    underlying: m.underlying, category: m.category, multiplier: m.multiplier, mapping: { rule: m.rule, unmapped: m.unmapped, note: m.note },
    price: t?.mark ?? null, priceKind: 'mark', unitPrice: t && m.multiplier !== null ? unitPrice(t.mark, m.multiplier) : null,
    change24h: t?.change24h ?? null, volume24hUsd: t?.volume24h ?? null, funding: f,
    openInterest: t?.openInterest ?? null, openInterestUsd: t && t.openInterest !== null ? mulStr(t.openInterest, t.mark) : null, maxLeverage: i.maxLeverage,
    tradable: tr.tradable, tradableReason: tr.reason, paper: v.restriction === null && v.facts.paperFees !== null && v.facts.hasOrderBook && i.status === 'active',
    restriction: v.restriction, sourceTs, ageMs, stale: !t || o.readStale || ageMs === null || ageMs > cadence, staleAfterMs: cadence, source: 'venue',
  };
}

const NETS = Object.values(NETWORKS) as NetworkDef[];
/** networks on which the wallet can execute a swap (KyberSwap pins) plus Solana (Jupiter) — docs/V11-AUDIT.md §1 */
const SWAP_NETWORKS = new Set<string>([...Object.keys(KYBER_ENABLED), 'solana']);
/** native coins with a pinned THORChain pair */
const THOR_NATIVE = new Set(['bitcoin:native', 'litecoin:native', 'ethereum:native']);

export class MarketsHub {
  private readonly deps: { derivatives: () => Derivatives; spot: SpotPort; now: () => number; ttlMs: number; budgetMs: number; spotTtlMs: number };
  private snap: HubSnapshot | null = null;
  private building: Promise<HubSnapshot> | null = null;
  private spot: { at: number; rows: HubRow[] } | null = null;
  private spotBuilding: Promise<HubRow[]> | null = null;
  /** diagnostics and tests: how many listings were built, and how many requests were answered */
  readonly stats = { builds: 0, served: 0, spotBuilds: 0 };

  constructor(o: { derivatives: () => Derivatives; spot?: SpotPort; now?: () => number; ttlMs?: number; budgetMs?: number; spotTtlMs?: number }) {
    this.deps = { derivatives: o.derivatives, spot: o.spot ?? defaultSpotPort, now: o.now ?? ((): number => o.derivatives().data.now()), ttlMs: o.ttlMs ?? HUB_TTL_MS, budgetMs: o.budgetMs ?? HUB_BUDGET_MS, spotTtlMs: o.spotTtlMs ?? SPOT_TTL_MS };
  }
  get now(): () => number { return this.deps.now; }
  get derivatives(): Derivatives { return this.deps.derivatives(); }
  get budgetMs(): number { return this.deps.budgetMs; }

  /** the whole listing; concurrent callers share one build, later ones reuse it for `ttlMs` */
  async snapshot(): Promise<HubSnapshot> {
    this.stats.served += 1;
    if (this.snap && this.deps.now() - this.snap.builtAt < this.deps.ttlMs) return this.snap;
    return (this.building ??= this.build().then((s) => { this.snap = s; return s; }).finally(() => { this.building = null; }));
  }

  private async build(): Promise<HubSnapshot> {
    this.stats.builds += 1;
    const d = this.deps.derivatives(), opts = { budgetMs: this.deps.budgetMs, lastGood: true };
    const errors: HubSnapshot['errors'] = [];
    // each venue on its own: nothing a venue does can delay or break another one
    const parts = await Promise.all(d.registry.list().map(async (v) => {
      try {
        const inst = await d.data.instruments(v.id, opts);
        const tick = await d.data.tickers(v.id, opts).catch((e: unknown) => { errors.push({ source: v.id, message: `tickers: ${msg(e)}` }); return null; });
        return { v, inst, tick, error: null as string | null };
      } catch (e) { errors.push({ source: v.id, message: msg(e) }); return { v, inst: null, tick: null, error: msg(e) }; }
    }));
    const spot = await this.spotRows().catch((e: unknown) => { errors.push({ source: SPOT, message: msg(e) }); return [] as HubRow[]; });
    const now = this.deps.now();
    const mappings = normaliseSymbols(parts.flatMap((p) => p.inst?.value ?? []));
    const byId = new Map(mappings.map((m) => [m.instrument, m]));
    const rows: HubRow[] = [...spot], venues: VenueState[] = [];
    for (const p of parts) {
      const tById = new Map((p.tick?.value ?? []).map((t) => [t.instrument, t]));
      const mine = (p.inst?.value ?? []).map((i) => perpRow(i, tById.get(i.id), p.v, byId.get(i.id)!, { now, readTs: p.tick?.ts ?? null, readStale: (p.tick?.stale ?? true) || p.inst!.stale }));
      rows.push(...mine);
      venues.push({ id: p.v.id, name: p.v.name, rows: mine.length, restriction: p.v.restriction, error: p.error ?? (p.tick === null ? 'tickers unavailable' : null), ageMs: p.tick ? Math.max(0, now - p.tick.ts) : null,
        status: p.inst === null ? 'error' : p.tick === null || p.tick.stale || p.inst.stale ? 'stale' : 'ok' });
    }
    venues.unshift({ id: SPOT, name: 'Spot (wallet registry, multi-source bars)', rows: spot.length, restriction: null, error: errors.find((e) => e.source === SPOT)?.message ?? null, ageMs: this.spot ? Math.max(0, now - this.spot.at) : null,
      status: errors.some((e) => e.source === SPOT) ? 'error' : spot.some((r) => r.price !== null && !r.stale) ? 'ok' : 'stale' });
    return { rows, venues, errors, mappings, builtAt: now };
  }

  /** the wallet's registry assets, priced from the consolidated 1 h bars the market module stores (close, 24 h change and volume) */
  private async spotRows(): Promise<HubRow[]> {
    const now = this.deps.now();
    if (this.spot && now - this.spot.at < this.deps.spotTtlMs) return this.spot.rows;
    return (this.spotBuilding ??= this.buildSpot().then((rows) => { this.spot = { at: this.deps.now(), rows }; return rows; }).finally(() => { this.spotBuilding = null; }));
  }
  private async buildSpot(): Promise<HubRow[]> {
    this.stats.spotBuilds += 1;
    const now = this.deps.now(), H = INTERVAL_MS['1h'];
    // registry assets by their own ticker, with every network where the wallet holds them
    const assets = new Map<string, { symbol: string; tracks: string | null; nets: { network: string; asset: string }[] }>();
    for (const n of NETS) for (const a of [n.native, ...n.tokens]) {
      const e = assets.get(a.symbol) ?? { symbol: a.symbol, tracks: CASH_SYMBOLS.includes(a.symbol) ? null : marketSymbolOf(a), nets: [] };
      e.nets.push({ network: n.id, asset: a.id }); assets.set(a.symbol, e);
    }
    const [ingested, quality] = await Promise.all([this.deps.spot.ingested(), this.deps.spot.quality()]);
    const wanted = [...new Set([...assets.values()].map((a) => a.tracks).filter((s): s is string => s !== null && ingested.includes(s)))];
    const series = new Map(await Promise.all(wanted.map(async (s) => [s, await this.deps.spot.bars(s, 25).catch(() => [])] as const)));
    const cadence = HUB_CADENCE_MS.spot;
    return [...assets.values()].map((a): HubRow => {
      const bars = a.tracks === null ? [] : series.get(a.tracks) ?? [], last = bars.at(-1) ?? null;
      // the bar that opened 24 h before the last one: present only when the stored series has no hole there
      const ref = last ? bars.find((b) => b.ts === last.ts - 24 * H) ?? null : null, day = last ? bars.filter((b) => b.ts > last.ts - 24 * H) : [];
      const q = a.tracks === null ? undefined : quality.find((x) => x.symbol === a.tracks && x.interval === '1h');
      const sourceTs = last ? last.ts + H : null, ageMs = sourceTs === null ? null : Math.max(0, now - sourceTs);
      const cash = a.tracks === null, swappable = a.nets.some((n) => SWAP_NETWORKS.has(n.network) || THOR_NATIVE.has(`${n.network}:${n.asset}`));
      return {
        id: `${SPOT}:${a.symbol}`, kind: 'spot', venue: SPOT, venueName: 'Spot', symbol: a.symbol, base: a.symbol, quote: 'USD', status: cash ? 'cash' : !hasMarketData(a.tracks!) ? 'no_market_data' : !ingested.includes(a.tracks!) ? 'not_ingested' : q?.status ?? 'no_data',
        underlying: a.tracks, category: 'crypto', multiplier: '1', mapping: { rule: null, unmapped: null, note: a.tracks !== null && a.tracks !== a.symbol ? `${a.symbol} is priced as ${a.tracks} (wrapped or pegged representation of the registry)` : 'wallet registry asset' },
        price: last ? num(last.close) : null, priceKind: 'close_1h', unitPrice: last ? num(last.close) : null,
        change24h: last && ref && ref.close > 0 ? num(last.close / ref.close - 1, 6) : null,
        // each bar is the bar of ONE exchange (never a blend): this is the volume of the exchanges that provided the bars, not a market total
        volume24hUsd: day.length ? num(day.reduce((s, b) => s + b.volume * b.close, 0), 2) : null,
        funding: null, openInterest: null, openInterestUsd: null, maxLeverage: null,
        tradable: !cash && swappable, tradableReason: cash ? 'spot_cash_leg' : swappable ? null : 'spot_no_swap_route', paper: false, restriction: null,
        sourceTs, ageMs, stale: !last || q?.fresh === false || ageMs === null || ageMs > cadence || last.ts < expectedLastTs('1h', now) - H, staleAfterMs: cadence, source: 'market-data',
        networks: a.nets, priceSource: last?.source ?? null,
      };
    });
  }

  // ------------------------------------------------------------------ explorer

  async list(q: HubQuery) {
    const s = await this.snapshot();
    if (q.venue !== undefined && q.venue !== SPOT) this.deps.derivatives().registry.get(q.venue);   // 404 unknown_venue
    const needle = q.q?.trim().toLowerCase();
    const rows = s.rows.filter((r) => (q.kind === undefined || r.kind === q.kind) && (q.venue === undefined || r.venue === q.venue) && (q.category === undefined || r.category === q.category)
      && (q.tradable === undefined || r.tradable === (q.tradable === 'yes'))
      && (!needle || r.id.toLowerCase().includes(needle) || r.symbol.toLowerCase().includes(needle) || r.base.toLowerCase().includes(needle) || (r.underlying ?? '').toLowerCase() === needle));
    const sorted = sortRows(rows, q.sort, q.dir);
    const asked = s.venues.filter((v) => (q.venue === undefined || v.id === q.venue) && (q.kind === undefined || (q.kind === 'spot') === (v.id === SPOT)));
    if (asked.length > 0 && asked.every((v) => v.status === 'error')) throw new UserError('markets_unavailable', `no market source could be read: ${s.errors.map((e) => `${e.source}: ${e.message}`).join('; ').slice(0, 300)}`, 503);
    const now = this.deps.now();
    return {
      rows: sorted.slice(q.offset, q.offset + q.limit), total: sorted.length, offset: q.offset, limit: q.limit,
      counts: { spot: rows.filter((r) => r.kind === 'spot').length, perp: rows.filter((r) => r.kind === 'perp').length, tradable: rows.filter((r) => r.tradable).length, stale: rows.filter((r) => r.stale).length },
      venues: s.venues, errors: s.errors, locks: tradingLocks(), cadenceMs: HUB_CADENCE_MS,
      cache: { builtAt: s.builtAt, ageMs: Math.max(0, now - s.builtAt), ttlMs: this.deps.ttlMs }, ts: now, source: 'markets-hub' as const,
    };
  }

  /** every underlying the venues' instruments were mapped to, with the venues that list it */
  async underlyings() {
    const s = await this.snapshot(), now = this.deps.now();
    const byId = new Map(s.rows.map((r) => [r.id, r]));
    const out = [...groupByUnderlying(s.mappings).entries()].map(([underlying, g]) => {
      const live = g.filter((m) => byId.get(m.instrument)?.status !== 'halted');
      const venues = [...new Set(live.map((m) => m.venue))];
      return { underlying, category: g[0]!.category, venues, instruments: live.length, comparable: venues.length > 1,
        volume24hUsd: live.reduce<DecStr | null>((acc, m) => { const v = byId.get(m.instrument)?.volume24hUsd; return v ? D.str(D.add(D.from(acc ?? '0'), D.from(v))) : acc; }, null) };
    }).filter((u) => u.instruments > 0)
      .sort((a, b) => Number(b.comparable) - Number(a.comparable) || b.venues.length - a.venues.length || cmpDec(b.volume24hUsd, a.volume24hUsd) || a.underlying.localeCompare(b.underlying));
    return { underlyings: out, errors: s.errors, ts: now };
  }

  /** all venues' instruments for one underlying (and the spot assets priced as it) */
  async underlying(symbol: string) {
    const s = await this.snapshot(), want = symbol.toUpperCase();
    const rows = s.rows.filter((r) => r.underlying !== null && r.underlying.toUpperCase() === want);
    // same letters, not mapped: shown so that nobody wonders where they went, never compared
    const notCompared = s.rows.filter((r) => r.kind === 'perp' && r.underlying === null && r.base.toUpperCase() === want);
    if (rows.length === 0 && notCompared.length === 0) {
      if (s.errors.length) throw new UserError('venue_unavailable', `'${symbol.slice(0, 20)}' was not found on the sources that answered; unread: ${s.errors.map((e) => e.source).join(', ')}`, 503);
      throw new UserError('unknown_underlying', `no instrument is mapped to '${symbol.slice(0, 20)}'`, 404);
    }
    const perps = rows.filter((r) => r.kind === 'perp');
    const outliers = priceOutliers(perps.filter((r) => r.unitPrice !== null && r.status !== 'halted' && !r.stale).map((r) => ({ instrument: r.id, unitPrice: r.unitPrice! })));
    return { underlying: rows[0]?.underlying ?? want, category: rows[0]?.category ?? null, spot: rows.filter((r) => r.kind === 'spot'), instruments: sortRows(perps, 'volume', 'desc').map((r) => ({ ...r, priceOutlier: outliers.has(r.id) })),
      notCompared, venues: s.venues, errors: s.errors, locks: tradingLocks(), ts: this.deps.now(), source: 'markets-hub' as const };
  }
}

export interface HubQuery { kind?: 'spot' | 'perp'; venue?: string; category?: InstrumentCategory; q?: string; tradable?: 'yes' | 'no'; sort: HubSort; dir: 'asc' | 'desc'; limit: number; offset: number }

const cmpDec = (a: DecStr | null, b: DecStr | null): number => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : D.cmp(D.from(a), D.from(b)));
/** rows without the figure always come last, whatever the direction; ties keep a stable order by id */
export function sortRows<T extends HubRow>(rows: readonly T[], sort: HubSort, dir: 'asc' | 'desc'): T[] {
  const key = (r: HubRow): DecStr | null => (sort === 'volume' ? r.volume24hUsd : sort === 'openInterest' ? r.openInterestUsd : sort === 'funding' ? r.funding?.annualised ?? null : sort === 'change' ? r.change24h : null);
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort === 'symbol') return sign * a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id);
    const x = key(a), y = key(b);
    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.id.localeCompare(b.id);
    return sign * D.cmp(D.from(x), D.from(y)) || a.id.localeCompare(b.id);
  });
}

/** the server locks of live trading, by name and state only (capabilities.ts): a tradable row still needs them on */
export function tradingLocks(): { id: string; on: boolean }[] {
  return capabilities().filter((c) => ['deriv_live_mainnet', 'deriv_gmx_live', 'broadcast'].includes(c.id)).map((c) => ({ id: c.id, on: c.on }));
}

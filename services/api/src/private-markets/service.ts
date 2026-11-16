// Private Markets & Synthetic Valuation — the service behind /api/v1/private-markets (docs/V11-SYNTHETIC-MARKETS.md).
//
// READ-ONLY: public market data of two venues the wallet already has an adapter for — Hyperliquid's builder-deployed dexes
// (`adapter.builder`) and edgeX (the derivatives data service). No account, no order, no signed action; none of these
// instruments is tradable from the wallet.
//
// Discovery is LIVE (Hyperliquid `perpCategories` = preipo, edgeX `category: 'pre_ipo'`); what a price MEANS comes from the
// reviewed table only (contracts.ts). Five quantities are kept apart for every instrument: the synthetic price, the market
// value of one contract, the notional exposure of a position, the implied valuation estimate, and the last known private
// valuation — plus the premium between the last two when both exist. Each venue is shown on its own: prices of the same
// company on different venues are never averaged and never fill each other's gaps.
import { createHash } from 'node:crypto';
import { D, HL_BUILDER_NOT_TRADABLE, type Book, type Candle, type DecStr, type HlBuilderMarket, type Instrument, type Ticker, type VenueId } from '@spw/derivatives';
import { impliedValuation, VALUATION_CAVEATS, type ContractDescriptor } from '@spw/trading';
import { UserError } from '../config.ts';
import { DATA_BOUNDS, venueFailure } from '../derivatives/data.ts';
import type { Derivatives } from '../derivatives/index.ts';
import { EDGEX_RESTRICTION, type ReadAdapter } from '../derivatives/venues.ts';
import { COMPANIES, EXCLUDED_PUBLIC, REVIEWED_CONTRACTS, VENUES_WITHOUT_ADAPTER, VENUE_MULTIPLIER, reviewState, reviewedContract, type LiveFingerprint, type ReviewState, type ReviewedContract, type UnitKind } from './contracts.ts';
import { lastPrivateValuation, referencesOf, toTradingReference, type ReferenceValuation } from './references.ts';

/** cache ages in milliseconds. `ttl`: a value is reused; `maxAge`: oldest value still served (flagged stale) when the venue fails. */
export const PM_BOUNDS = {
  /** Hyperliquid perpDexs / perpCategories / allPerpMetas: which coins are pre-IPO, delisted, and their asset ids */
  discovery: { ttl: 60_000, maxAge: 900_000 },
  /** Hyperliquid metaAndAssetCtxs of a builder dex with a live pre-IPO market (weight 20 per dex: three dexes every 20 s = 180 / 1200 per minute) */
  markets: { ttl: 20_000, maxAge: 120_000 },
  /** a dex whose pre-IPO markets are all delisted: frozen data */
  delisted: { ttl: 600_000, maxAge: 3_600_000 },
  /** perpAnnotation (the fingerprint of the reviewed definition) */
  annotation: { ttl: 600_000, maxAge: 3_600_000 },
  book: { ttl: 5_000, maxAge: 30_000 },
  candles: { ttl: 60_000, maxAge: 600_000 },
  /** edgeX goes through the derivatives data service and its bounds */
  edgexTickers: DATA_BOUNDS.tickers, edgexInstruments: DATA_BOUNDS.instruments,
  /** a market datum older than this is flagged `stale`, whatever the cache says */
  staleAfter: { hyperliquid: 60_000, edgex: DATA_BOUNDS.tickers.maxAge },
} as const;
/** display thresholds of the "thin market" caveat (USD) */
export const THIN = { openInterestUsd: '1000000', volume24hUsd: '100000' } as const;
const FAILURE_BACKOFF_MS = 1_000;

export interface Datum { value: DecStr | null; source: string; ts: number | null; stale: boolean }
export interface PositionInput { side: 'long' | 'short'; size: DecStr }
export type NoValuationCode = 'not_reviewed' | 'under_review' | 'per_share_no_share_count' | 'unit_not_published' | 'delisted_frozen' | 'no_price' | 'no_formula';
export interface Caveat { code: 'synthetic' | 'arithmetic' | 'thin_market' | 'cross_venue' | 'unit_mismatch' | 'frozen' | 'unconfirmed_convention' | 'company_note' | 'reference_kind' | 'stale'; text: string; data?: Record<string, unknown> }

export interface Valuation {
  /** 1 — the price the contract trades at, in the contract's own unit */
  syntheticPrice: Datum & { unit: UnitKind; unitLabel: string; priceKind: 'mark' | 'frozen mark' };
  /** 2 — USD value of ONE contract */
  contractMarketValue: { value: DecStr | null; formula: string | null; reason: string | null; source: string | null; ts: number | null };
  /** 3 — USD exposure of a position (signed; negative = short). Always hypothetical: nothing can be held through the wallet. */
  notionalExposure: { value: DecStr | null; formula: string | null; reason: string | null; position: PositionInput; hypothetical: true; ts: number | null };
  /** 4 — the company valuation the price implies, ONLY when the reviewed definition gives the formula */
  impliedValuation: { value: DecStr | null; formula: string | null; formulaId: string | null; formulaSource: { url: string; quote: string; readAt: string } | null; asOf: number | null;
    label: string | null; reason: string | null; reasonCode: NoValuationCode | null };
  /** 5 — reference data, not market data */
  lastPrivateValuation: (Pick<ReferenceValuation, 'kind' | 'detail' | 'date' | 'sourceUrl' | 'confidence'> & { value: DecStr }) | null;
  lastPrivateValuationReason: string | null;
  /** (4) against (5), when both exist. premiumBps > 0: the contract implies more than the reference. */
  premiumDiscount: { premiumBps: DecStr | null; reason: string | null; caveat: string | null };
  caveats: Caveat[];
}

export interface PrivateMarketRow {
  id: string; venue: VenueId; platform: string; operator: string | null; symbol: string;
  company: { slug: string; name: string } | null;
  status: 'live' | 'delisted' | 'halted' | 'reduce_only';
  review: ReviewState & { fingerprintChecked: boolean };
  contract: {
    nature: string; unit: { kind: UnitKind; label: string }; quoteCurrency: string; collateral: string | null; underlying: string | null;
    /** contract size = lot of one contract in the venue's own terms */
    contractSize: string; multiplier: { value: string; source: string } | null;
    settlement: string; ipoConversion: string; oracle: string; liquidation: string;
    maxLeverage: DecStr | null; margin: string | null; lotSize: DecStr | null; szDecimals: number | null; fundingIntervalSec: number | null;
    /** Hyperliquid only, informational: the integer an order action would carry — never used by the wallet */
    assetId: number | null; dex: string | null; oiCapUsd: DecStr | null; fundingMultiplier: DecStr | null;
    onChainDescription: string | null; unconfirmedConvention: { text: string; url: string } | null; sources: string[];
  };
  market: {
    price: Datum; oracle: Datum; mid: Datum; funding: Datum & { intervalSec: number | null };
    /** contracts */
    openInterest: Datum;
    /** contracts × mark × multiplier — the wallet's arithmetic, not a venue field */
    openInterestUsd: Datum;
    /** quote currency (USD notional) */
    volume24h: Datum; volumeBase24h: Datum;
    /** frozen: last values of a delisted market */
    frozen: boolean;
  };
  valuation: Valuation;
  tradable: false;
  notTradable: { code: string; reasons: string[] };
  /** the venue (or this instrument's data) could not be read */
  error: string | null;
}

export interface VenueReport { venue: VenueId; name: string; status: 'ok' | 'stale' | 'error'; error: string | null; ts: number | null; instruments: number }
export interface ListAnswer {
  markets: PrivateMarketRow[];
  companies: { slug: string; name: string; note: string | null; contracts: string[]; lastPrivateValuation: Valuation['lastPrivateValuation']; divergence: Divergence[] }[];
  excluded: { id: string; company: string; reason: string; liveCategory: string | null; delisted: boolean }[];
  venues: VenueReport[];
  venuesWithoutAdapter: typeof VENUES_WITHOUT_ADAPTER;
  notice: { tradable: false; code: string; text: string };
  filter: { delisted: boolean }; position: PositionInput;
  cache: typeof PM_BOUNDS; reviewedTable: { entries: number; reviewedAt: string };
  ts: number; source: 'venue';
}
export interface Divergence { unit: UnitKind; unitLabel: string; contracts: { id: string; price: DecStr; ts: number | null }[]; spreadBps: DecStr; note: string }

export const NOTICE = 'Displayed for information only — not tradable from this wallet. These are synthetic derivative contracts: they give no claim on any share. Trading is disabled for two reasons: jurisdiction (trade.xyz\'s terms name Canada as a restricted jurisdiction for its interface, EntropyIO names Ontario, edgeX excludes Canada) and contract definition (units differ between venues, some are not published, and the Anthropic contracts change oracle or unit around its IPO).';
const JURISDICTION: Record<string, string> = {
  xyz: 'trade.xyz Terms of Use §2.2 (updated 6 Sep 2026) name Canada among the restricted jurisdictions of its interface (https://trade.xyz/terms).',
  io: 'EntropyIO lists Ontario among its restricted jurisdictions (https://docs.entropy.io/legal-and-disclaimers/restricted-jurisdictions); whether offering this market in Québec is lawful is not established.',
  para: 'Paragon\'s restricted list does not name Canada, but its terms require that access not violate local law (https://docs.paragon.trade/legal/terms_of_use); whether offering this market in Québec is lawful is not established.',
};

const DEFAULT_POSITION: PositionInput = { side: 'long', size: '1' };
const msg = (e: unknown): string => { const f = venueFailure(e); return (f instanceof Error ? f.message : String(f)).slice(0, 240); };
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const datum = (value: DecStr | null | undefined, source: string, ts: number | null, stale: boolean): Datum => ({ value: value ?? null, source, ts: value == null ? null : ts, stale: value == null ? false : stale });
const none = (source: string): Datum => ({ value: null, source, ts: null, stale: false });

interface Stamped<T> { value: T; ts: number; stale: boolean }
interface RowInput {
  id: string; venue: VenueId; symbol: string; reviewed: ReviewedContract | null;
  live: LiveFingerprint | null; delisted: boolean; instrument: Instrument | null; ticker: Ticker | null; stamp: { ts: number; stale: boolean } | null;
  hl: HlBuilderMarket | null; description: string | null; volumeBase24h: DecStr | null; error: string | null;
}

export class PrivateMarkets {
  private readonly d: Derivatives;
  readonly now: () => number;
  private readonly slots = new Map<string, { value: unknown; at: number }>();
  private readonly failed = new Map<string, { until: number; error: unknown }>();
  private readonly inflight = new Map<string, Promise<{ value: unknown; at: number }>>();

  constructor(d: Derivatives, o: { now?: () => number } = {}) { this.d = d; this.now = o.now ?? d.data.now; }

  // ---------------------------------------------------------------------------------------------------------------- cache
  /** same contract as the derivatives data service: reuse within `ttl`; when the venue fails, an older value within `maxAge` is served and flagged */
  private async cached<T>(key: string, venue: VenueId, bounds: { ttl: number; maxAge: number }, fn: (a: ReadAdapter) => Promise<T>): Promise<Stamped<T>> {
    const slot = this.slots.get(key), now = this.now();
    if (slot && now - slot.at < bounds.ttl) return { value: slot.value as T, ts: slot.at, stale: false };
    const serveOld = (err: unknown): Stamped<T> => {
      const s = this.slots.get(key);
      if (s && this.now() - s.at <= bounds.maxAge) return { value: s.value as T, ts: s.at, stale: true };
      throw err;
    };
    const f = this.failed.get(key);
    if (f && now < f.until) return serveOld(f.error);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.d.registry.call(venue, fn).then((value) => { const s = { value: value as unknown, at: this.now() }; this.slots.set(key, s); this.failed.delete(key); return s; },
        (err) => { this.failed.set(key, { until: this.now() + FAILURE_BACKOFF_MS, error: err }); throw err; }).finally(() => { this.inflight.delete(key); });
      this.inflight.set(key, p);
    }
    try { const s = await p; return { value: s.value as T, ts: s.at, stale: false }; } catch (err) { return serveOld(err); }
  }
  private builder(a: ReadAdapter) { if (!a.builder) throw new UserError('venue_unavailable', 'the Hyperliquid adapter of this instance does not read builder dexes', 503); return a.builder; }

  // ---------------------------------------------------------------------------------------------------------------- Hyperliquid
  private async hyperliquid(includeDelisted: boolean): Promise<{ inputs: RowInput[]; excluded: ListAnswer['excluded']; report: VenueReport | null }> {
    const venue = 'hyperliquid' as const, name = 'Hyperliquid (builder-deployed dexes)';
    const reviewedHl = REVIEWED_CONTRACTS.filter((c) => c.venue === venue);
    const failedRows = (error: string): RowInput[] => reviewedHl.filter((c) => includeDelisted ? c.status === 'delisted' : c.status === 'live')
      .map((c) => ({ id: c.id, venue, symbol: c.id.slice(venue.length + 1), reviewed: c, live: null, delisted: c.status === 'delisted', instrument: null, ticker: null, stamp: null, hl: null, description: null, volumeBase24h: null, error }));
    if (!this.d.registry.has(venue)) return { inputs: [], excluded: [], report: null };   // a venue this instance does not have is not reported at all
    let cats, ids;
    try {
      [cats, ids] = await Promise.all([this.cached('hl:categories', venue, PM_BOUNDS.discovery, (a) => this.builder(a).categories()), this.cached('hl:assetIds', venue, PM_BOUNDS.discovery, (a) => this.builder(a).assetIds())]);
    } catch (e) { const error = msg(e); return { inputs: failedRows(error), excluded: [], report: { venue, name, status: 'error', error, ts: null, instruments: 0 } }; }

    // discovery: every coin the deployers categorise pre-IPO, plus every reviewed coin (a reviewed coin that left the category is shown "under review")
    const coins = new Set<string>([...cats.value].filter(([, c]) => c.category === 'preipo').map(([coin]) => coin));
    for (const c of reviewedHl) coins.add(c.id.slice(venue.length + 1));
    const excluded: ListAnswer['excluded'] = [];
    for (const [id, x] of Object.entries(EXCLUDED_PUBLIC)) {
      const coin = id.slice(venue.length + 1);
      if (id.startsWith(`${venue}:`) && ids.value.has(coin)) excluded.push({ id, company: x.company, reason: x.reason, liveCategory: cats.value.get(coin)?.raw ?? null, delisted: ids.value.get(coin)!.isDelisted });
      coins.delete(coin);
    }
    const wanted = [...coins].filter((coin) => ids.value.has(coin)).filter((coin) => ids.value.get(coin)!.isDelisted === includeDelisted).sort();
    const dexes = [...new Set(wanted.map((coin) => ids.value.get(coin)!.dex))];
    let worst: { status: VenueReport['status']; error: string | null } = { status: cats.stale || ids.stale ? 'stale' : 'ok', error: null };
    let oldest = Math.min(cats.ts, ids.ts);
    const perDex = new Map<string, Stamped<HlBuilderMarket[]> | { error: string }>();
    await Promise.all(dexes.map(async (dex) => {
      try { perDex.set(dex, await this.cached(`hl:markets:${dex}`, venue, includeDelisted ? PM_BOUNDS.delisted : PM_BOUNDS.markets, (a) => this.builder(a).markets(dex))); }
      catch (e) { perDex.set(dex, { error: msg(e) }); }
    }));
    const inputs = await Promise.all(wanted.map(async (coin): Promise<RowInput> => {
      const id = `${venue}:${coin}`, reviewed = reviewedContract(id), meta = ids.value.get(coin)!, got = perDex.get(meta.dex)!;
      const base = { id, venue, symbol: coin, reviewed, delisted: meta.isDelisted };
      if ('error' in got) { worst = { status: 'error', error: got.error }; return { ...base, live: null, instrument: null, ticker: null, stamp: null, hl: null, description: null, volumeBase24h: null, error: got.error }; }
      const m = got.value.find((x) => x.coin === coin);
      if (!m) return { ...base, live: null, instrument: null, ticker: null, stamp: null, hl: null, description: null, volumeBase24h: null, error: `the dex '${meta.dex}' no longer lists ${coin}` };
      if (got.stale && worst.status === 'ok') worst = { status: 'stale', error: null };
      oldest = Math.min(oldest, got.ts);
      // the annotation is the fingerprint of the reviewed definition; `null` after the retries = unknown (the last value read, if any, stands in within its bound)
      let annotation: { description: string } | null = null;
      try { annotation = (await this.cached(`hl:annotation:${coin}`, venue, PM_BOUNDS.annotation, async (a) => { const r = await this.builder(a).annotation(coin); if (r.annotation === null) throw new UserError('annotation_unknown', 'the venue answered null', 503); return r.annotation; })).value; } catch { annotation = null; }
      const live: LiveFingerprint = { category: cats.value.get(coin)?.category ?? null, szDecimals: m.szDecimals, collateral: m.collateral, annotationSha256: annotation === null ? null : sha256(annotation.description) };
      return { ...base, live, instrument: m.instrument, ticker: m.ticker, stamp: { ts: got.ts, stale: got.stale || this.now() - got.ts > PM_BOUNDS.staleAfter.hyperliquid }, hl: m, description: annotation?.description ?? null, volumeBase24h: m.volumeBase24h, error: null };
    }));
    return { inputs, excluded, report: { venue, name, status: worst.status, error: worst.error, ts: oldest, instruments: inputs.length } };
  }

  // ---------------------------------------------------------------------------------------------------------------- edgeX
  private async edgex(includeDelisted: boolean): Promise<{ inputs: RowInput[]; report: VenueReport | null }> {
    const venue = 'edgex' as const, name = 'edgeX';
    if (!this.d.registry.has(venue)) return { inputs: [], report: null };
    if (includeDelisted) return { inputs: [], report: { venue, name, status: 'ok', error: null, ts: null, instruments: 0 } };   // edgeX publishes no delisted pre-IPO contract
    const reviewedEx = REVIEWED_CONTRACTS.filter((c) => c.venue === venue);
    const blank = { live: null, delisted: false, instrument: null, ticker: null, stamp: null, hl: null, description: null, volumeBase24h: null };
    let inst;
    try { inst = await this.d.data.instruments(venue); }
    catch (e) { const error = msg(e); return { inputs: reviewedEx.map((c) => ({ ...blank, id: c.id, venue, symbol: c.id.slice(venue.length + 1), reviewed: c, error })), report: { venue, name, status: 'error', error, ts: null, instruments: 0 } }; }
    const reviewedIds = new Set(reviewedEx.map((c) => c.id));
    const list = inst.value.filter((i) => i.category === 'pre_ipo' || reviewedIds.has(i.id));
    let tick: Stamped<Ticker[]> | null = null, tickError: string | null = null;
    try { tick = await this.d.data.tickers(venue); } catch (e) { tickError = msg(e); }
    const inputs = list.map((i): RowInput => {
      const t = tick?.value.find((x) => x.instrument === i.id) ?? null;
      const stamp = tick && t ? { ts: Math.min(t.ts, tick.ts), stale: tick.stale || this.now() - Math.min(t.ts, tick.ts) > PM_BOUNDS.staleAfter.edgex } : null;
      return { id: i.id, venue, symbol: i.symbol, reviewed: reviewedContract(i.id), live: { category: i.category ?? null, lotSize: i.lotSize, collateral: i.collateral }, delisted: false, instrument: i, ticker: t, stamp,
        hl: null, description: null, volumeBase24h: t?.volumeBase24h ?? null, error: t ? null : tickError ?? 'the venue publishes no ticker for this contract' };
    });
    return { inputs, report: { venue, name, status: tickError ? 'error' : tick?.stale || inst.stale ? 'stale' : 'ok', error: tickError, ts: tick ? tick.ts : inst.ts, instruments: inputs.length } };
  }

  // ---------------------------------------------------------------------------------------------------------------- rows
  private row(x: RowInput, position: PositionInput): PrivateMarketRow {
    const c = x.reviewed, now = this.now(), src = x.venue === 'hyperliquid' ? `Hyperliquid info metaAndAssetCtxs (dex ${x.hl?.dex ?? x.symbol.split(':')[0]})` : 'edgeX public quote API (ticker)';
    const review: PrivateMarketRow['review'] = x.live ? { ...reviewState(c, x.live, now), fingerprintChecked: true }
      // the venue could not be read: the table entry is shown, unconfirmed — and there is no price to value anyway
      : { state: c ? (c.validUntil !== null && now >= Date.parse(c.validUntil) ? 'under_review' : 'reviewed') : 'not_reviewed', reasons: c ? ['live metadata could not be read: the reviewed definition is not confirmed against the venue'] : [], reviewedAt: c?.reviewedAt ?? null, validUntil: c?.validUntil ?? null, fingerprintChecked: false };
    const company = c ? COMPANIES[c.company] ?? null : null, t = x.ticker, ts = x.stamp?.ts ?? null, stale = x.stamp?.stale ?? false, i = x.instrument;
    const mult = VENUE_MULTIPLIER[x.venue as 'hyperliquid' | 'edgex'] ?? null;
    const unit: PrivateMarketRow['contract']['unit'] = c && review.state !== 'not_reviewed' ? c.unit : { kind: 'unknown', label: 'contract definition not reviewed' };
    const oiUsd = t?.openInterest != null && mult ? D.str(D.mul(D.mul(D.from(t.openInterest), D.from(t.mark)), D.from(mult.value))) : null;
    const frozen = x.delisted;
    const market: PrivateMarketRow['market'] = {
      price: t ? datum(t.mark, `${src} — mark price${frozen ? ' (frozen: delisted)' : ''}`, ts, stale) : none(src), oracle: t ? datum(t.index, `${src} — ${x.venue === 'hyperliquid' ? 'oracle price' : 'index price'}`, ts, stale) : none(src),
      mid: t ? datum(t.mid, `${src} — book mid`, ts, stale) : none(src), funding: { ...(t ? datum(t.funding, `${src} — funding rate per interval`, ts, stale) : none(src)), intervalSec: i?.fundingIntervalSec ?? null },
      openInterest: t ? datum(t.openInterest, `${src} — open interest, contracts`, ts, stale) : none(src),
      openInterestUsd: datum(oiUsd, 'wallet arithmetic: open interest × mark × contract multiplier (not a venue field)', ts, stale),
      volume24h: t ? datum(t.volume24h, `${src} — 24 h notional volume, ${c?.quoteCurrency ?? i?.quote ?? 'USD'}`, ts, stale) : none(src),
      volumeBase24h: datum(x.volumeBase24h, `${src} — 24 h volume, contracts`, ts, stale), frozen,
    };
    const jur = x.hl ? JURISDICTION[x.hl.dex] : undefined;
    const notTradable = x.venue === 'hyperliquid'
      ? { code: HL_BUILDER_NOT_TRADABLE.code, reasons: [HL_BUILDER_NOT_TRADABLE.reason, ...(jur ? [jur] : []), ...(review.state !== 'reviewed' ? ['The contract definition is not confirmed (see review).'] : [])] }
      : { code: 'venue_restricted', reasons: [EDGEX_RESTRICTION, 'edgeX publishes no contract specification for its pre-IPO perpetuals.'] };
    return {
      id: x.id, venue: x.venue, platform: c?.platform ?? (x.hl ? `Hyperliquid · dex ${x.hl.dex}` : x.venue === 'edgex' ? 'edgeX' : x.venue), operator: c?.operator ?? null, symbol: x.symbol,
      company: company ? { slug: company.slug, name: company.name } : null,
      status: x.delisted ? 'delisted' : i?.status === 'halted' ? 'halted' : i?.status === 'reduce_only' ? 'reduce_only' : c?.status === 'delisted' ? 'delisted' : 'live',
      review,
      contract: {
        nature: c?.nature ?? 'synthetic perpetual contract (the venue\'s metadata); exact nature not reviewed', unit, quoteCurrency: c?.quoteCurrency ?? i?.quote ?? 'USD', collateral: i?.collateral ?? c?.fingerprint.collateral ?? null,
        underlying: company?.name ?? null, contractSize: `1 contract = 1 unit of ${i?.base ?? x.symbol}; smallest size ${i?.lotSize ?? 'not read'}`, multiplier: mult,
        settlement: c?.settlement ?? i?.settlement ?? 'not reviewed', ipoConversion: c?.ipoConversion ?? 'not reviewed', oracle: c?.oracle ?? i?.markPriceMethod ?? 'not reviewed', liquidation: c?.liquidation ?? 'not reviewed',
        maxLeverage: i?.maxLeverage ?? null, margin: x.hl ? x.hl.margin : i ? i.marginModes.join(' / ') : null, lotSize: i?.lotSize ?? null, szDecimals: x.hl?.szDecimals ?? null, fundingIntervalSec: i?.fundingIntervalSec ?? null,
        assetId: x.hl?.assetId ?? null, dex: x.hl?.dex ?? null, oiCapUsd: x.hl?.oiCapUsd ?? null, fundingMultiplier: x.hl?.fundingMultiplier ?? null,
        onChainDescription: x.description, unconfirmedConvention: c?.unconfirmedConvention ?? null, sources: c?.sources ?? [],
      },
      market, valuation: this.valuation(x, review, unit, market, position), tradable: false, notTradable, error: x.error,
    };
  }

  private valuation(x: RowInput, review: ReviewState, unit: { kind: UnitKind; label: string }, market: PrivateMarketRow['market'], position: PositionInput): Valuation {
    const c = x.reviewed, t = x.ticker, ts = market.price.ts;
    const ref = c ? lastPrivateValuation(c.company) : null;
    const lastPrivate: Valuation['lastPrivateValuation'] = ref ? { value: ref.valueUsd!, kind: ref.kind, detail: ref.detail, date: ref.date, sourceUrl: ref.sourceUrl, confidence: ref.confidence } : null;
    const lastReason = lastPrivate ? null : c ? `no private valuation of ${COMPANIES[c.company]?.name ?? c.company} was researched (docs/v11/research/private-markets.md §4)` : 'the company is not identified: the contract definition is not reviewed';
    const caveats: Caveat[] = [{ code: 'synthetic', text: VALUATION_CAVEATS[0] }, { code: 'arithmetic', text: VALUATION_CAVEATS[1] }];
    const synthetic: Valuation['syntheticPrice'] = { ...market.price, unit: unit.kind, unitLabel: unit.label, priceKind: x.delisted ? 'frozen mark' : 'mark' };
    const refuse = (code: NoValuationCode, reason: string): Valuation['impliedValuation'] => ({ value: null, formula: null, formulaId: null, formulaSource: c?.formulaSource ?? null, asOf: null, label: null, reason, reasonCode: code });
    const blank = (reason: string, implied: Valuation['impliedValuation']): Valuation => ({
      syntheticPrice: synthetic, contractMarketValue: { value: null, formula: null, reason, source: null, ts: null },
      notionalExposure: { value: null, formula: null, reason, position, hypothetical: true, ts: null }, impliedValuation: implied,
      lastPrivateValuation: lastPrivate, lastPrivateValuationReason: lastReason, premiumDiscount: { premiumBps: null, reason: implied.reason, caveat: null }, caveats,
    });
    if (!t || market.price.value === null) return blank('no price: the venue could not be read', refuse('no_price', `no price: ${x.error ?? 'the venue could not be read'}`));
    if (x.delisted) {
      caveats.push({ code: 'frozen', text: 'Delisted market: the price is the last value before delisting, kept by the venue. It is not a current price and must not be read as a valuation.' });
      return blank('delisted market: the frozen price is not the value of a contract that can be held', refuse('delisted_frozen', c?.noFormulaReason ?? 'delisted market: frozen price'));
    }
    if (market.price.stale) caveats.push({ code: 'stale', text: 'The market data of this venue could not be refreshed: the figures are older than their freshness bound.' });

    // what the reviewed table allows the engine to derive — nothing for an unreviewed or under-review definition
    const trusted = c !== null && review.state === 'reviewed';
    const descriptor: ContractDescriptor = {
      venue: x.venue, symbol: x.symbol, dilutedShares: null,     // no publishable fully diluted share count (references.ts)
      priceUnit: !trusted ? { kind: 'unknown' } : c.valuationFormula === 'price_x_1e9' ? { kind: 'valuation_usd_billions' } : c.unit.kind === 'usd_per_share' ? { kind: 'usd_per_share' } : { kind: 'unknown' },
      formulaSource: trusted && c.formulaSource ? c.formulaSource.url : null, multiplier: VENUE_MULTIPLIER[x.venue as 'hyperliquid' | 'edgex'] ?? null,
    };
    const r = impliedValuation(descriptor, { price: t.mark, ts: ts ?? this.now(), source: market.price.source }, { position, ...(ref ? { lastPrivate: toTradingReference(ref) } : {}) });
    let implied: Valuation['impliedValuation'];
    if (r.implied.impliedValuation !== null && trusted && c.formulaSource) {
      implied = { value: r.implied.impliedValuation.value, formula: 'implied fully diluted valuation (USD) = price × 1 000 000 000', formulaId: c.valuationFormula, formulaSource: c.formulaSource, asOf: ts,
        label: `market-implied, from the price of a derivative on ${c.platform} — not a company figure`, reason: null, reasonCode: null };
    } else if (!c || review.state === 'not_reviewed') implied = refuse('not_reviewed', review.reasons[0] ?? 'contract definition not reviewed — no valuation');
    else if (review.state === 'under_review') implied = refuse('under_review', `definition under review — no valuation: ${review.reasons.join('; ')}`);
    else implied = refuse(c.unit.kind === 'usd_per_share' ? 'per_share_no_share_count' : c.unit.kind === 'unknown' ? 'unit_not_published' : 'no_formula', c.noFormulaReason ?? r.implied.reason ?? 'the reviewed definition gives no valuation formula');

    if (c?.unconfirmedConvention) caveats.push({ code: 'unconfirmed_convention', text: c.unconfirmedConvention.text, data: { url: c.unconfirmedConvention.url } });
    const note = c ? COMPANIES[c.company]?.note : null;
    if (note) caveats.push({ code: 'company_note', text: note });
    const oi = market.openInterestUsd.value, vol = market.volume24h.value;
    if ((oi !== null && D.lt(D.from(oi), D.from(THIN.openInterestUsd))) || (vol !== null && D.lt(D.from(vol), D.from(THIN.volume24hUsd))))
      caveats.push({ code: 'thin_market', text: `Thin market: open interest ≈ ${oi === null ? 'unknown' : `$${fmtUsd(oi)}`}, 24 h volume ≈ ${vol === null ? 'unknown' : `$${fmtUsd(vol)}`}. A small order moves this price.`, data: { openInterestUsd: oi, volume24hUsd: vol, thresholds: THIN } });
    if (r.versusPrivate && implied.value !== null) caveats.push({ code: 'reference_kind', text: r.versusPrivate.caveat });
    return {
      syntheticPrice: synthetic,
      contractMarketValue: { value: r.contractMarketValue.value, formula: r.contractMarketValue.formula, reason: r.contractMarketValue.reason, source: descriptor.multiplier?.source ?? null, ts },
      notionalExposure: { value: r.notionalExposure?.value ?? null, formula: r.notionalExposure?.formula ?? null, reason: r.notionalExposure?.reason ?? null, position, hypothetical: true, ts },
      impliedValuation: implied, lastPrivateValuation: lastPrivate, lastPrivateValuationReason: lastReason,
      premiumDiscount: implied.value !== null && r.versusPrivate ? { premiumBps: r.versusPrivate.premiumBps, reason: r.versusPrivate.reason, caveat: r.versusPrivate.caveat }
        : { premiumBps: null, reason: implied.value === null ? `no implied valuation: ${implied.reason}` : lastReason, caveat: null },
      caveats,
    };
  }

  /** same company, several contracts: each stays on its own line. A spread is computed inside ONE unit only; nothing is averaged. */
  private crossVenue(rows: PrivateMarketRow[]): Map<string, Divergence[]> {
    const out = new Map<string, Divergence[]>();
    const live = rows.filter((r) => r.company && r.status !== 'delisted' && r.market.price.value !== null);
    for (const slug of new Set(live.map((r) => r.company!.slug))) {
      const group = live.filter((r) => r.company!.slug === slug), div: Divergence[] = [];
      for (const kind of ['usd_per_share', 'valuation_usd_billions'] as const) {
        const same = group.filter((r) => r.contract.unit.kind === kind && r.review.state === 'reviewed');
        if (same.length < 2) continue;
        const prices = same.map((r) => D.from(r.market.price.value!)), min = prices.reduce((a, b) => (D.lt(b, a) ? b : a)), max = prices.reduce((a, b) => (D.gt(b, a) ? b : a));
        div.push({ unit: kind, unitLabel: same[0]!.contract.unit.label, contracts: same.map((r) => ({ id: r.id, price: r.market.price.value!, ts: r.market.price.ts })),
          spreadBps: D.str(D.div(D.mul(D.sub(max, min), D.from(10000n)), min, 2, 'half_even')), note: 'spread between the highest and the lowest mark of contracts quoted in the same unit; different contracts with different settlement rules — shown side by side, never averaged' });
      }
      out.set(slug, div);
      if (group.length < 2) continue;
      for (const r of group) {
        const others = group.filter((o) => o.id !== r.id).map((o) => `${o.id} ${o.market.price.value} (${o.contract.unit.label})`).join('; ');
        const d = div.find((x) => x.contracts.some((k) => k.id === r.id));
        r.valuation.caveats.push({ code: 'cross_venue', text: `Other contracts on ${r.company!.name}, each a different contract on its own venue: ${others}.${d ? ` Spread within this unit: ${d.spreadBps} bps.` : ''} Prices are never averaged across venues and never used to fill another venue's gap.`,
          data: { others: group.filter((o) => o.id !== r.id).map((o) => ({ id: o.id, price: o.market.price.value, unit: o.contract.unit.kind })), spreadBps: d?.spreadBps ?? null } });
        if (new Set(group.map((o) => o.contract.unit.kind)).size > 1) r.valuation.caveats.push({ code: 'unit_mismatch', text: `The contracts on ${r.company!.name} are quoted in different units (${[...new Set(group.map((o) => o.contract.unit.label))].join(' | ')}): their prices are not comparable with each other.` });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------- public
  async list(o: { delisted?: boolean; position?: PositionInput } = {}): Promise<ListAnswer> {
    const delisted = o.delisted === true, position = o.position ?? DEFAULT_POSITION;
    const [hl, ex] = await Promise.all([this.hyperliquid(delisted), this.edgex(delisted)]);
    const markets = [...hl.inputs, ...ex.inputs].map((x) => this.row(x, position));
    const divergence = this.crossVenue(markets);
    const slugs = [...new Set(markets.flatMap((m) => (m.company ? [m.company.slug] : [])))];
    const order = Object.keys(COMPANIES);
    slugs.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    markets.sort((a, b) => (a.company ? order.indexOf(a.company.slug) : 99) - (b.company ? order.indexOf(b.company.slug) : 99) || a.id.localeCompare(b.id));
    return {
      markets,
      companies: slugs.map((slug) => { const ref = lastPrivateValuation(slug); return { slug, name: COMPANIES[slug]!.name, note: COMPANIES[slug]!.note, contracts: markets.filter((m) => m.company?.slug === slug).map((m) => m.id),
        lastPrivateValuation: ref ? { value: ref.valueUsd!, kind: ref.kind, detail: ref.detail, date: ref.date, sourceUrl: ref.sourceUrl, confidence: ref.confidence } : null, divergence: divergence.get(slug) ?? [] }; }),
      excluded: hl.excluded.filter((e) => e.delisted === delisted),
      venues: [hl.report, ex.report].filter((v): v is VenueReport => v !== null), venuesWithoutAdapter: VENUES_WITHOUT_ADAPTER, notice: { tradable: false, code: 'private_markets_display_only', text: NOTICE },
      filter: { delisted }, position, cache: PM_BOUNDS, reviewedTable: { entries: REVIEWED_CONTRACTS.length, reviewedAt: '2026-11-15' }, ts: this.now(), source: 'venue',
    };
  }

  /** one instrument, live or delisted */
  private async find(id: string, position: PositionInput): Promise<{ row: PrivateMarketRow; all: ListAnswer }> {
    const live = await this.list({ position });
    const hit = live.markets.find((m) => m.id === id);
    if (hit) return { row: hit, all: live };
    const old = await this.list({ delisted: true, position }), was = old.markets.find((m) => m.id === id);
    if (was) return { row: was, all: old };
    const ex = EXCLUDED_PUBLIC[id];
    if (ex) throw new UserError('not_a_private_market', ex.reason, 404);
    const failing = [...live.venues, ...old.venues].find((v) => v.status === 'error' && id.startsWith(`${v.venue}:`));
    if (failing) throw new UserError('venue_unavailable', `${failing.name} could not be read: ${failing.error ?? 'error'}`, 503);
    throw new UserError('unknown_private_market', `'${id.slice(0, 80)}' is not a private-company market known to the venues read by this wallet`, 404);
  }

  async detail(id: string, o: { position?: PositionInput; interval?: '1h' | '1d'; limit?: number } = {}) {
    const position = o.position ?? DEFAULT_POSITION, { row, all } = await this.find(id, position);
    const interval = o.interval ?? (row.status === 'delisted' ? '1d' : '1h'), limit = o.limit ?? (row.status === 'delisted' ? 400 : 72);
    const soft = async <T>(p: () => Promise<T>): Promise<T | { error: string }> => { try { return await p(); } catch (e) { return { error: msg(e) }; } };
    const top = (b: Book, ts: number, stale: boolean) => ({ bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5), ts: b.ts || ts, stale, source: row.venue === 'hyperliquid' ? 'Hyperliquid info l2Book' : 'edgeX public quote API (depth)' });
    let book: unknown, candles: unknown;
    if (row.error && row.market.price.value === null) { book = { error: row.error }; candles = { error: row.error }; }
    else if (row.venue === 'hyperliquid') {
      const coin = row.symbol;
      [book, candles] = await Promise.all([
        soft(async () => { const b = await this.cached(`hl:book:${coin}`, 'hyperliquid', PM_BOUNDS.book, (a) => this.builder(a).book(coin, 5)); return top(b.value, b.ts, b.stale); }),
        soft(async () => { const c = await this.cached(`hl:candles:${coin}:${interval}:${limit}`, 'hyperliquid', PM_BOUNDS.candles, (a) => this.builder(a).candles(coin, interval, { limit })); return { interval, candles: c.value as Candle[], ts: c.ts, stale: c.stale, source: 'Hyperliquid info candleSnapshot' }; }),
      ]);
    } else {
      const inst = await this.d.data.instrument(row.id);
      [book, candles] = await Promise.all([
        soft(async () => { const b = await this.d.data.book(inst); if (!b) throw new UserError('no_orderbook', 'no order book', 422); return top(b, this.now(), false); }),
        soft(async () => { const c = await this.d.data.candles(inst, interval, limit); return { interval, candles: c.value, ts: c.ts, stale: c.stale, source: 'edgeX public quote API (kline)' }; }),
      ]);
    }
    const slug = row.company?.slug ?? null;
    return { market: row, book, candles, references: slug ? referencesOf(slug) : [], company: slug ? all.companies.find((c) => c.slug === slug) ?? null : null,
      sameCompany: slug ? all.markets.filter((m) => m.company?.slug === slug && m.id !== row.id).map((m) => ({ id: m.id, platform: m.platform, price: m.market.price, unit: m.contract.unit, review: m.review.state })) : [],
      notice: all.notice, position, ts: this.now(), source: 'venue' as const };
  }

  /** every contract on one company, venue by venue — never merged into one figure */
  async company(slug: string, o: { position?: PositionInput } = {}) {
    const c = COMPANIES[slug];
    if (!c) throw new UserError('unknown_company', `no reviewed private-company contract for '${slug.slice(0, 40)}'`, 404);
    const [live, old] = await Promise.all([this.list({ position: o.position }), this.list({ delisted: true, position: o.position })]);
    const contracts = live.markets.filter((m) => m.company?.slug === slug), delisted = old.markets.filter((m) => m.company?.slug === slug);
    return { company: c, contracts, delisted, references: referencesOf(slug), lastPrivateValuation: live.companies.find((x) => x.slug === slug)?.lastPrivateValuation ?? (() => { const r = lastPrivateValuation(slug); return r ? { value: r.valueUsd!, kind: r.kind, detail: r.detail, date: r.date, sourceUrl: r.sourceUrl, confidence: r.confidence } : null; })(),
      divergence: live.companies.find((x) => x.slug === slug)?.divergence ?? [], merged: null, mergedReason: 'contracts of different venues are different instruments: no average, no blended price, no cross-fill',
      venues: live.venues, notice: live.notice, position: live.position, ts: this.now(), source: 'venue' as const };
  }
}

/** 1234567.891 → "1.23M" (display inside a caveat sentence only; the exact figure is in `data`) */
function fmtUsd(x: DecStr): string {
  const n = Number(x);
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
}

const services = new WeakMap<Derivatives, PrivateMarkets>();
/** one service per derivatives instance (shared caches and rate-limit budget; tests get their own) */
export function privateMarketsFor(d: Derivatives): PrivateMarkets {
  let s = services.get(d);
  if (!s) { s = new PrivateMarkets(d); services.set(d, s); }
  return s;
}

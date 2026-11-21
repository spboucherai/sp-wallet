/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/markets-hub/compare.ts
 * Module           : markets-hub
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Venue comparator — what holding ONE position would cost on each venue, from REAL inputs read now: the venue's instrument,
// its order book (or, on GMX, the pool figures), its ticker, its fee schedule and its funding rate. The arithmetic is the pure
// code of @spw/trading (compare/cost.ts: compareVenues, findDiscrepancies) — this file only gathers the inputs.
//
// READ-ONLY public market data: no account, no order, no signer. Every figure is an ESTIMATE from one snapshot; a component
// whose input is missing is null WITH the reason, and a total that lacks a component is null. A venue the wallet cannot trade
// on is shown and flagged. Nothing here is a recommendation, and no wording promises an outcome (test: forbidden words).
import {
  D, ROUTER_FACTS, ROUTER_FACTS_CHECKED, type Book, type DecStr, type GmxLiquidity, type Instrument, type Ticker, type VenueId,
} from '@spw/derivatives';
import {
  annualiseFunding, compareVenues, COST_ASSUMPTIONS, depthWithin, DISCREPANCY_ASSUMPTIONS, DISCREPANCY_RISKS, findDiscrepancies, gmxFeeSchedule, gmxFunding, gmxPoolExecution, POOL_ASSUMPTIONS,
  PRICE_GUARD_BPS, priceOutliers, routerFeeSchedule, toUnderlyingUnits, type CostRequest, type DepthLevel, type FeeSchedule, type SymbolMapping, type VenueCostInput, type VenueCostRow,
} from '@spw/trading';
import { UserError } from '../config.ts';
import { HUB_CADENCE_MS, sortRows, tradingLocks, type HubRow, type MarketsHub, type TradableReason } from './hub.ts';

export const COMPARE_TTL_MS = 1_500;
export const DEPTH_BPS: readonly DecStr[] = ['10', '25', '50'];
/** the distance used for the single depth figure of the cost row (the three distances are in `depth`) */
const ROW_DEPTH_BPS = '10';

/** every sentence the comparator can say about its own method, with a stable code (the web app translates by code) */
const coded = (prefix: string, texts: readonly string[]): { code: string; text: string }[] => texts.map((text, k) => ({ code: `${prefix}_${k + 1}`, text }));
export const COMPARE_TEXTS = {
  disclaimer: 'Estimates computed from one snapshot of public market data. Not a quote and not a recommendation: the contracts differ between venues (collateral, price used for liquidation, funding rule, execution).',
  cost: coded('cost', COST_ASSUMPTIONS), pool: coded('pool', POOL_ASSUMPTIONS),
  discrepancyAssumptions: coded('disc_assume', DISCREPANCY_ASSUMPTIONS), discrepancyRisks: coded('disc_risk', DISCREPANCY_RISKS),
  priceGuard: { code: 'price_guard', text: `an instrument whose unit price is more than ${D.str(D.div(D.from(PRICE_GUARD_BPS), D.from(100n), 2, 'half_even'))} % away from the median of the venues is left out of the cross-venue estimates: a difference that large is more likely a mapping or a unit problem than a market fact` },
  notTradable: { code: 'not_tradable', text: 'a venue the wallet cannot trade on is shown for information and flagged; an estimate that needs a leg on it cannot be acted on from the wallet' },
  discrepancy: 'netEdgeEstimateBps is the price difference between two venues net of fees on four legs, the exit slippage on both and the net funding over the horizon. It is an estimate under the assumptions listed, with the risks listed; `flagged` only says the estimate is above the threshold.',
} as const;

export interface CompareQuery { underlying: string; side: 'long' | 'short'; notionalUsd: DecStr; leverage: DecStr; horizonHours: DecStr; liquidity: 'taker' | 'maker'; minNetEdgeBps: DecStr }
export interface CompareRow {
  venue: VenueId; venueName: string; instrument: string; symbol: string; underlying: string; multiplier: DecStr;
  /** other instruments of the venue on the same underlying (GMX: one per pool); the row is the wallet-tradable one, else the most traded */
  alternatives: string[];
  tradable: boolean; tradableReason: TradableReason | null; restriction: string | null;
  /** mark, index and mid as the venue publishes them, per unit of the underlying */
  price: { mark: DecStr | null; index: DecStr | null; mid: DecStr | null };
  /** USD resting within 10, 25 and 50 bps of the mid; null on a venue without a book, or when the book could not be read */
  depth: DepthLevel[] | null; depthReason: string | null;
  fees: { takerRate: DecStr; makerRate: DecStr; source: string; asOf: string } | null;
  /** the venue's own funding figure and its normalisations; the expected amount over the horizon is `cost.fundingUsd` */
  funding: { rate: DecStr; intervalSec: number; perHour: DecStr; annualised: DecStr; assumption: string } | null;
  maintenance: { fraction: DecStr; basis: string } | null;
  /** the itemised estimate: slippage, fees, funding, margin, liquidation, total — each a figure or null with its reason */
  cost: VenueCostRow | null;
  /** left out of the cross-venue estimates: its unit price is far from the median of the venues */
  priceOutlier: boolean;
  sourceTs: { ticker: number | null; book: number | null; pool: number | null }; ageMs: number | null; stale: boolean; staleAfterMs: number;
  /** why the row has no estimate at all (venue unreadable) */
  error: string | null;
}
export interface CompareDiscrepancy {
  longVenue: string; shortVenue: string; longInstrument: string; shortInstrument: string;
  grossGapBps: DecStr | null; netEdgeEstimateBps: DecStr | null; costsUsd: { feesUsd: DecStr; exitSlippageUsd: DecStr; fundingUsd: DecStr } | null;
  flagged: boolean; reason: string | null;
  /** false when a leg is on a venue the wallet cannot trade on */
  actionableFromWallet: boolean;
  assumptions: { code: string; text: string }[]; risks: { code: string; text: string }[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const iso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** the fee schedule of a venue for one instrument, with where it comes from and when it was read or checked */
export function feesFor(inst: Instrument, liq: GmxLiquidity | null, readTs: number): (FeeSchedule & { asOf: string }) | null {
  const ex = (inst as Instrument & { edgex?: { takerFeeRate?: DecStr; makerFeeRate?: DecStr } }).edgex;
  if (inst.venue === 'edgex' && ex?.takerFeeRate && ex.makerFeeRate) return { takerRate: ex.takerFeeRate, makerRate: ex.makerFeeRate, source: 'default rates of this contract in the edgeX venue metadata (getMetaData), read live; VIP tiers are not applied', asOf: iso(readTs) };
  if (inst.venue === 'gmx') return liq ? { ...gmxFeeSchedule(liq), asOf: iso(liq.ts) } : null;
  const s = routerFeeSchedule(inst.venue);
  return s ? { ...s, asOf: ROUTER_FACTS_CHECKED } : null;
}
/** maintenance margin as a fraction of notional, when the wallet knows it for this venue */
export function maintenanceFor(inst: Instrument, liq: GmxLiquidity | null, notionalUsd: DecStr): { fraction: DecStr; basis: string } | null {
  const f = ROUTER_FACTS[inst.venue];
  if (f.maintenance === 'half_initial_at_max') return { fraction: D.str(D.div(D.one, D.mul(D.from(2n), D.from(inst.maxLeverage)), 18, 'half_even')), basis: `1 / (2 × maximum leverage ${inst.maxLeverage}): ${f.maintenanceText}` };
  if (f.maintenance === 'gmx_min_collateral') return liq ? { fraction: liq.minCollateralFactorForLiquidation, basis: `minCollateralFactorForLiquidation of the market, read from the venue: ${f.maintenanceText}` } : null;
  const tiers = (inst as Instrument & { edgex?: { riskTiers?: { maintenanceMarginRate: DecStr; positionValueUpperBound: DecStr }[] } }).edgex?.riskTiers;
  if (inst.venue === 'edgex' && tiers?.length) {
    const n = D.from(notionalUsd), t = tiers.find((x) => D.lte(n, D.from(x.positionValueUpperBound))) ?? tiers[tiers.length - 1]!;
    return { fraction: t.maintenanceMarginRate, basis: `maintenance margin rate of the risk tier for a position of ${notionalUsd} USD (venue metadata, riskTierList)` };
  }
  return typeof f.maintenance === 'string' ? { fraction: f.maintenance, basis: f.maintenanceText } : null;   // dYdX: per market, not carried by the adapter
}

export class CompareService {
  private readonly cache = new Map<string, { at: number; v: Promise<CompareAnswer> }>();
  readonly stats = { computed: 0, served: 0 };
  constructor(private readonly hub: MarketsHub, private readonly ttlMs: number = COMPARE_TTL_MS) {}

  /** concurrent identical requests share one computation; a result is reused for `ttlMs` */
  compare(q: CompareQuery): Promise<CompareAnswer> {
    this.stats.served += 1;
    const key = JSON.stringify([q.underlying.toUpperCase(), q.side, q.notionalUsd, q.leverage, q.horizonHours, q.liquidity, q.minNetEdgeBps]), now = this.hub.now(), hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.v;
    for (const [k, c] of this.cache) if (now - c.at >= this.ttlMs) this.cache.delete(k);
    const v = this.compute(q);
    this.cache.set(key, { at: now, v });
    v.catch(() => { if (this.cache.get(key)?.v === v) this.cache.delete(key); });   // a failure is not kept
    return v;
  }

  private async compute(q: CompareQuery): Promise<CompareAnswer> {
    this.stats.computed += 1;
    const s = await this.hub.snapshot(), d = this.hub.derivatives, want = q.underlying.toUpperCase();
    const perps = s.rows.filter((r) => r.kind === 'perp' && r.underlying !== null && r.underlying.toUpperCase() === want && r.status !== 'halted');
    if (perps.length === 0) {
      if (s.errors.length) throw new UserError('venue_unavailable', `no perpetual on '${q.underlying.slice(0, 20)}' on the venues that answered; unread: ${s.errors.map((e) => e.source).join(', ')}`, 503);
      throw new UserError('unknown_underlying', `no perpetual is mapped to '${q.underlying.slice(0, 20)}'`, 404);
    }
    const underlying = perps[0]!.underlying!;
    // one row per venue: the instrument the wallet can trade, else the most traded one; the others are listed
    const order = d.registry.list().map((v) => v.id as string);
    const byVenue = new Map<string, HubRow[]>();
    for (const r of sortRows(perps, 'volume', 'desc')) byVenue.set(r.venue, [...(byVenue.get(r.venue) ?? []), r]);
    const picks = order.filter((v) => byVenue.has(v)).map((v) => { const all = byVenue.get(v)!, pick = all.find((r) => r.tradable) ?? all[0]!; return { pick, alternatives: all.filter((r) => r !== pick).map((r) => r.id) }; });
    const outliers = priceOutliers(picks.filter((p) => p.pick.unitPrice !== null && !p.pick.stale).map((p) => ({ instrument: p.pick.id, unitPrice: p.pick.unitPrice! })));
    const mapOf = new Map(s.mappings.map((m) => [m.instrument, m]));
    const now = this.hub.now();
    const base: Omit<CostRequest, 'maxAgeMs'> = { side: q.side, notionalUsd: q.notionalUsd, leverage: q.leverage, horizonHours: q.horizonHours, depthBps: ROW_DEPTH_BPS, liquidity: q.liquidity, now };

    const built = await Promise.all(picks.map(async ({ pick, alternatives }): Promise<{ row: CompareRow; input: VenueCostInput | null }> => {
      const venue = pick.venue as VenueId, cadence = HUB_CADENCE_MS[venue], m = mapOf.get(pick.id)!;
      const head = { venue, venueName: pick.venueName, instrument: pick.id, symbol: pick.symbol, underlying, multiplier: m.multiplier!, alternatives, tradable: pick.tradable, tradableReason: pick.tradableReason, restriction: pick.restriction,
        priceOutlier: outliers.has(pick.id), staleAfterMs: cadence };
      try {
        const gathered = await this.gather(pick, m, q.notionalUsd);
        const cost = compareVenues([gathered.input], { ...base, maxAgeMs: cadence })[0]!;
        const t = gathered.input.ticker, f = gathered.fundingShown;
        const sourceTs = { ticker: t?.ts ?? null, book: gathered.input.book?.ts ?? null, pool: gathered.input.pool?.ts ?? null };
        const oldest = [sourceTs.ticker, sourceTs.book, sourceTs.pool].filter((x): x is number => x !== null), ageMs = oldest.length ? Math.max(0, now - Math.min(...oldest)) : null;
        return { input: gathered.input, row: { ...head, price: { mark: t?.mark ?? null, index: t?.index ?? null, mid: cost.midPrice.value },
          depth: gathered.input.book ? depthWithin(gathered.input.book, DEPTH_BPS) : null, depthReason: gathered.input.book ? null : gathered.bookReason,
          fees: gathered.fees, funding: f, maintenance: gathered.maintenance, cost, sourceTs, ageMs, stale: pick.stale || ageMs === null || ageMs > cadence, error: null } };
      } catch (e) {
        return { input: null, row: { ...head, price: { mark: pick.unitPrice, index: null, mid: null }, depth: null, depthReason: msg(e), fees: null, funding: null, maintenance: null, cost: null,
          sourceTs: { ticker: pick.sourceTs, book: null, pool: null }, ageMs: pick.ageMs, stale: true, error: msg(e) } };
      }
    }));

    // cross-venue estimates: only between rows that have a price of their own, are fresh and are not price outliers
    const usable = built.filter((b) => b.input !== null && b.row.cost?.midPrice.value != null && !b.row.priceOutlier && !b.row.stale);
    const tradable = new Map(built.map((b) => [b.row.instrument, b.row.tradable]));
    const { side: _side, ...noSide } = base;
    const discrepancies: CompareDiscrepancy[] = usable.length < 2 ? [] : findDiscrepancies(usable.map((b) => b.input!), { ...noSide, maxAgeMs: Math.max(...usable.map((b) => b.row.staleAfterMs)) }, q.minNetEdgeBps).map((x) => ({
      longVenue: x.longVenue, shortVenue: x.shortVenue, longInstrument: x.longInstrument, shortInstrument: x.shortInstrument, grossGapBps: x.grossGapBps, netEdgeEstimateBps: x.netEdgeEstimateBps, costsUsd: x.costsUsd,
      flagged: x.flagged, reason: x.reason, actionableFromWallet: tradable.get(x.longInstrument) === true && tradable.get(x.shortInstrument) === true,
      assumptions: [...COMPARE_TEXTS.discrepancyAssumptions], risks: [...COMPARE_TEXTS.discrepancyRisks] }));
    const unread = s.venues.filter((v) => v.status === 'error' && v.id !== 'spot').map((v) => v.id);
    return {
      underlying, category: perps[0]!.category, request: { ...q, underlying, depthBps: [...DEPTH_BPS] }, rows: built.map((b) => b.row), discrepancies,
      texts: { disclaimer: COMPARE_TEXTS.disclaimer, discrepancy: COMPARE_TEXTS.discrepancy, assumptions: [...COMPARE_TEXTS.cost, ...(built.some((b) => b.row.cost?.executionModel === 'pool') ? COMPARE_TEXTS.pool : []), COMPARE_TEXTS.priceGuard, COMPARE_TEXTS.notTradable] },
      warnings: [...(unread.length ? [`Not read: ${unread.join(', ')}. The comparison is missing those venues.`] : []), ...built.filter((b) => b.row.priceOutlier).map((b) => `${b.row.instrument} is left out of the cross-venue estimates: its unit price is far from the median of the venues.`)],
      errors: s.errors, locks: tradingLocks(), ts: now, source: 'estimate',
    };
  }

  /** the real inputs of one venue, restated in units of the underlying */
  private async gather(pick: HubRow, m: SymbolMapping, notionalUsd: DecStr) {
    const d = this.hub.derivatives, venue = pick.venue as VenueId, opts = { budgetMs: this.hub.budgetMs };
    const insts = await d.data.instruments(venue, { ...opts, lastGood: true }), inst = insts.value.find((i) => i.id === pick.id);
    if (!inst) throw new Error(`${pick.id} is no longer listed`);
    const tickers = await d.data.tickers(venue, opts).catch(() => null), ticker: Ticker | null = tickers?.value.find((t) => t.instrument === inst.id) ?? null;
    let book: Book | null = null, liq: GmxLiquidity | null = null, bookReason: string | null = null;
    if (d.data.hasBook(inst)) book = await d.data.book(inst, opts).catch((e: unknown) => { bookReason = `order book unavailable: ${msg(e)}`; return null; });
    else { liq = await d.data.liquidity(inst, opts).catch((e: unknown) => { bookReason = `pool figures unavailable: ${msg(e)}`; return null; }); bookReason ??= liq ? 'this venue has no order book: trades execute against a liquidity pool at the oracle price' : 'the venue published no pool figures for this market'; }
    if (liq && m.multiplier !== '1') throw new Error('a pool market with a contract multiplier is not supported');
    const fees = feesFor(inst, liq, insts.ts), maintenance = maintenanceFor(inst, liq, notionalUsd);
    const gf = liq ? gmxFunding(liq) : null;
    const input: VenueCostInput = toUnderlyingUnits({ instrument: inst, book, ticker, fees: fees ? { takerRate: fees.takerRate, makerRate: fees.makerRate, source: `${fees.source} (as of ${fees.asOf})` } : null,
      funding: gf ? gf.long : null, ...(gf ? { fundingShort: gf.short } : {}), maintenanceMarginFraction: maintenance?.fraction ?? null, pool: liq ? gmxPoolExecution(liq) : null }, m);
    const raw = gf ? { rate: gf.long.rate, intervalSec: 3600 } : ticker && ticker.funding !== null ? { rate: ticker.funding, intervalSec: inst.fundingIntervalSec } : null;
    const fundingShown = raw ? { ...raw, ...(({ perHour, perYear }) => ({ perHour, annualised: perYear }))(annualiseFunding(raw.rate, raw.intervalSec)),
      assumption: gf ? 'GMX net rate of the long side per hour (funding and borrowing fee together), the current rate held constant; the short side has its own rate' : 'the venue\'s current rate held constant over the horizon; funding rates change every interval' } : null;
    return { input, fees, maintenance, bookReason, fundingShown };
  }
}

export interface CompareAnswer {
  underlying: string; category: string | null; request: CompareQuery & { depthBps: DecStr[] }; rows: CompareRow[]; discrepancies: CompareDiscrepancy[];
  texts: { disclaimer: string; discrepancy: string; assumptions: { code: string; text: string }[] };
  warnings: string[]; errors: { source: string; message: string }[]; locks: { id: string; on: boolean }[]; ts: number; source: 'estimate';
}

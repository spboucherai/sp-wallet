/**
 * Total cost of holding a perp position, venue by venue, from what the caller supplies: Instrument, Book, Ticker, fee schedule
 * and funding. Nothing is fetched and nothing is assumed in silence: a component whose inputs are missing is `null` WITH the
 * reason, and a total that lacks a component is `null` and lists what is missing.
 *
 * Every figure is an ESTIMATE of a cost, not a quote. The book walk, the margin and the liquidation price are the functions of
 * packages/derivatives (router.walkBook; margin.initialMargin, liquidationPriceAtLeverage, notional) — imported, not copied.
 * The base fee tiers of the venues the router knows are available through `routerFeeSchedule` (router.ROUTER_FACTS).
 *
 * `crossVenueDiscrepancy` flags a price difference between two venues net of all the costs above. Its output is an estimate
 * of an edge under stated assumptions, with the risks listed next to it.
 *
 * Pure: the clock is `request.now`.
 */
import {
  D, initialMargin, liquidationPriceAtLeverage, notional as notionalOf, ROUTER_FACTS, ROUTER_FACTS_CHECKED, walkBook,
  type Book, type Dec, type DecStr, type Instrument, type Side, type Ticker, type VenueId,
} from '@spw/derivatives';
import { bpsStr, ratioBps, SCALE, usd } from '../dec.ts';

export interface FeeSchedule { takerRate: DecStr; makerRate: DecStr; source: string }
export interface FundingInput {
  /** rate per funding interval that LONGS PAY (negative = longs receive), as the venue publishes it */
  rate: DecStr;
  intervalSec: number;
  /** unix ms of the reading */
  ts: number;
  source: string;
}
export interface VenueCostInput {
  instrument: Instrument;
  book: Book | null;
  ticker: Ticker | null;
  fees: FeeSchedule | null;
  /** null → `ticker.funding` (per `instrument.fundingIntervalSec`) is used when present */
  funding: FundingInput | null;
  /** maintenance margin as a fraction of notional; null = unknown (then no liquidation estimate) */
  maintenanceMarginFraction: DecStr | null;
}
export interface CostRequest {
  side: Side;
  notionalUsd: DecStr;
  leverage: DecStr;
  /** expected holding period, hours (a decimal string; '0' = entry and exit only) */
  horizonHours: DecStr;
  /** depth is measured within this distance of the mid, basis points */
  depthBps: DecStr;
  /** how the entry and the exit are executed, for the fee */
  liquidity: 'taker' | 'maker';
  now: number;
  /** oldest book / ticker accepted, ms; older inputs are treated as missing */
  maxAgeMs: number;
}

/** a figure, or null with the reason; `basis` says how a non-null figure was obtained and what it assumes */
export interface Figure { value: DecStr | null; reason: string | null; basis: string | null }
const fig = (value: DecStr, basis: string): Figure => ({ value, reason: null, basis });
const none = (reason: string): Figure => ({ value: null, reason, basis: null });

export const COST_COMPONENTS = ['entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'exitFeeUsd', 'fundingUsd'] as const;
export type CostComponentId = (typeof COST_COMPONENTS)[number];

export interface VenueCostRow {
  venue: string; instrument: string;
  /** reference: the book's mid */
  midPrice: Figure;
  /** (best ask − best bid) / mid, basis points */
  spreadBps: Figure;
  /** USD resting within `depthBps` of the mid, each side */
  depthBidUsd: Figure; depthAskUsd: Figure;
  /** size of the position in base units: notional / mid, rounded down to the lot */
  sizeBase: Figure;
  /** average execution price of the entry by walking the book, and its distance from the mid (half the spread included) */
  entryAvgPrice: Figure; entrySlippageBps: Figure;
  /** positive = a cost */
  entrySlippageUsd: Figure; exitSlippageUsd: Figure; entryFeeUsd: Figure; exitFeeUsd: Figure;
  /** expected funding over the horizon; positive = paid, negative = received */
  fundingUsd: Figure;
  fundingRatePerHour: Figure;
  collateralRequiredUsd: Figure;
  liquidationPrice: Figure; liquidationDistanceBps: Figure;
  maxLeverage: Figure;
  /** entry + exit + funding: the sum of COST_COMPONENTS, or null when one is missing */
  totalCostUsd: Figure; totalCostBps: Figure;
  /** components that are null, so that an incomplete row is never ranked as if it were cheap */
  missing: CostComponentId[];
  assumptions: string[];
}

const TWO = D.from(2n), TEN_K = D.from(10000n), HOUR = D.from(3600n);

/** the base fee tier the router's reviewed table holds for a venue, or null (GMX reads its fee factors from the market) */
export function routerFeeSchedule(venue: VenueId): FeeSchedule | null {
  const f = ROUTER_FACTS[venue];
  if (f.takerRate === null || f.makerRate === null) return null;
  return { takerRate: f.takerRate, makerRate: f.makerRate, source: `${f.feeSource} (constants checked ${ROUTER_FACTS_CHECKED})` };
}

function depthUsd(levels: readonly [DecStr, DecStr][], mid: Dec, bps: Dec, side: 'bid' | 'ask'): Dec {
  // price within bps of the mid, cross-multiplied: ask ≤ mid · (10000 + bps) / 10000; bid ≥ mid · (10000 − bps) / 10000
  const bound = side === 'ask' ? D.mul(mid, D.add(TEN_K, bps)) : D.mul(mid, D.sub(TEN_K, bps));
  let total = D.zero;
  for (const [p, s] of levels) { const px = D.from(p), scaled = D.mul(px, TEN_K); if (side === 'ask' ? D.lte(scaled, bound) : D.gte(scaled, bound)) total = D.add(total, D.mul(px, D.from(s))); }
  return total;
}

export const COST_ASSUMPTIONS = [
  'the position is opened and closed in full, each in one order',
  'the exit is priced on the CURRENT book: the book at the time of the exit is not known',
  'the book supplied is the whole book seen by the caller; liquidity beyond its last level is unknown',
  'fees are the schedule supplied; volume tiers, rebates and discounts are not applied',
  'funding is the CURRENT rate held constant over the whole horizon; funding rates change every interval',
  'initial margin is notional / leverage (no size tiers); the liquidation price is the isolated-margin estimate at that leverage, with no fee and no funding accrual',
] as const;

/** one row of the comparison table. Never throws on market conditions: what cannot be computed is null with its reason. */
export function venueCost(input: VenueCostInput, req: CostRequest, o: { /** size in base units, instead of notional / mid (used to give two venues the same size) */ sizeBase?: DecStr } = {}): VenueCostRow {
  const i = input.instrument, n = D.from(req.notionalUsd), lev = D.from(req.leverage), hours = D.from(req.horizonHours), depthB = D.from(req.depthBps);
  if (!D.isPos(n) || !D.isPos(lev) || D.isNeg(hours) || D.isNeg(depthB)) throw new RangeError('notional and leverage must be positive; horizon and depth must not be negative');
  if (!Number.isSafeInteger(req.now) || !Number.isInteger(req.maxAgeMs) || req.maxAgeMs < 0) throw new RangeError('bad clock or maximum age');
  const book = input.book, age = (ts: number) => Math.abs(req.now - ts);
  const bookWhy = book === null ? 'no order book was supplied' : book.instrument !== i.id ? 'the order book is for another instrument' : age(book.ts) > req.maxAgeMs ? `the order book is ${age(book.ts)} ms old (limit ${req.maxAgeMs})`
    : book.bids.length === 0 || book.asks.length === 0 ? 'the order book has an empty side' : null;
  const bid = bookWhy === null ? D.from(book!.bids[0]![0]) : null, ask = bookWhy === null ? D.from(book!.asks[0]![0]) : null;
  const crossed = bid !== null && ask !== null && (!D.isPos(bid) || D.gt(bid, ask));
  const why = bookWhy ?? (crossed ? 'the order book is crossed or has a non-positive price' : null);
  const mid = why === null && bid !== null && ask !== null ? D.div(D.add(bid, ask), TWO, SCALE, 'half_even') : null;

  const lot = D.from(i.lotSize);
  const size = mid === null ? null : D.isPos(lot) ? D.quantize(o.sizeBase !== undefined ? D.from(o.sizeBase) : D.div(n, mid, SCALE, 'down'), lot, 'down') : null;
  const sizeWhy = why ?? (size === null ? 'the lot size is not positive' : !D.isPos(size) ? 'the notional is below one lot' : null);
  const entrySide = req.side === 'long' ? 'buy' as const : 'sell' as const, exitSide = req.side === 'long' ? 'sell' as const : 'buy' as const;
  const leg = (side: 'buy' | 'sell'): { avg: Dec | null; cost: Dec | null; why: string | null } => {
    if (sizeWhy !== null || size === null || mid === null || book === null) return { avg: null, cost: null, why: sizeWhy };
    const w = walkBook(side === 'buy' ? book.asks : book.bids, size, side, null);
    if (w.stoppedBy !== 'filled' || w.avg === null) return { avg: null, cost: null, why: `the supplied book fills only ${D.str(w.filled)} of ${D.str(size)} on the ${side === 'buy' ? 'ask' : 'bid'} side` };
    // slippage from the mid, in USD: |avg − mid| · size on the adverse side (never negative)
    const diff = side === 'buy' ? D.sub(w.avg, mid) : D.sub(mid, w.avg);
    return { avg: w.avg, cost: D.mul(D.max(diff, D.zero), size), why: null };
  };
  const entry = leg(entrySide), exit = leg(exitSide);

  const positionNotional = size !== null && mid !== null && sizeWhy === null ? notionalOf(size, mid) : null;
  const rate = input.fees === null ? null : D.from(req.liquidity === 'taker' ? input.fees.takerRate : input.fees.makerRate);
  const fee = (): Figure => (input.fees === null || rate === null ? none('no fee schedule was supplied') : positionNotional === null ? none(sizeWhy ?? 'the position cannot be sized')
    : fig(usd(D.mul(positionNotional, rate)), `${req.liquidity} rate ${req.liquidity === 'taker' ? input.fees.takerRate : input.fees.makerRate} × notional — ${input.fees.source}`));

  // funding: per-hour rate that longs pay, from the input or from the ticker
  const tickerOk = input.ticker !== null && input.ticker.instrument === i.id && age(input.ticker.ts) <= req.maxAgeMs;
  const f: FundingInput | null = input.funding ?? (tickerOk && input.ticker!.funding !== null ? { rate: input.ticker!.funding, intervalSec: i.fundingIntervalSec, ts: input.ticker!.ts, source: 'ticker.funding of the venue' } : null);
  const fundingWhy = f === null ? (input.ticker === null ? 'no funding rate and no ticker were supplied' : !tickerOk ? 'the ticker is stale or for another instrument, and no funding rate was supplied' : 'the venue publishes no funding rate in its ticker')
    : !Number.isInteger(f.intervalSec) || f.intervalSec <= 0 ? 'the funding interval is not a positive number of seconds' : age(f.ts) > req.maxAgeMs ? `the funding rate is ${age(f.ts)} ms old (limit ${req.maxAgeMs})` : null;
  const perHour = f !== null && fundingWhy === null ? D.div(D.mul(D.from(f.rate), HOUR), D.from(BigInt(f.intervalSec)), 30, 'half_even') : null;
  const fundingUsd: Figure = perHour === null ? none(fundingWhy!) : positionNotional === null ? none(sizeWhy ?? 'the position cannot be sized')
    : fig(usd(D.mul(D.mul(D.mul(positionNotional, perHour), hours), req.side === 'long' ? D.one : D.neg(D.one))), `current rate ${f!.rate} per ${f!.intervalSec} s (${f!.source}) held constant for ${req.horizonHours} h on the position's notional; ${req.side === 'long' ? 'longs pay a positive rate' : 'shorts receive a positive rate'}`);

  // margin and liquidation at the chosen leverage
  const maxLev = D.from(i.maxLeverage), levWhy = D.gt(lev, maxLev) ? `the leverage ${req.leverage} is above the venue's maximum ${i.maxLeverage}` : null;
  const collateral: Figure = positionNotional === null ? none(sizeWhy ?? 'the position cannot be sized') : levWhy !== null ? none(levWhy) : fig(usd(initialMargin(positionNotional, lev)), 'notional / leverage, rounded up (margin.initialMargin)');
  let liq: Figure = none(sizeWhy ?? 'the position cannot be sized'), liqDist: Figure = none(liq.reason!);
  if (mid !== null && sizeWhy === null) {
    if (levWhy !== null) liq = liqDist = none(levWhy);
    else if (input.maintenanceMarginFraction === null) liq = liqDist = none('the maintenance margin fraction was not supplied');
    else {
      const e = liquidationPriceAtLeverage({ side: req.side, entryPrice: entry.avg ?? mid, leverage: lev, maintenanceFraction: D.from(input.maintenanceMarginFraction) });
      if (e.value === null) liq = liqDist = none(`no liquidation price: ${e.method}`);
      else {
        const ref = entry.avg ?? mid;
        liq = fig(D.str(D.div(e.value, D.one, 10, 'half_even')), `${e.method}; entry at ${entry.avg === null ? 'the mid' : 'the estimated average entry price'}`);
        liqDist = fig(bpsStr(ratioBps(D.abs(D.sub(ref, e.value)), ref)), '|entry − liquidation price| / entry');
      }
    }
  }

  const slip = (l: { cost: Dec | null; why: string | null }, what: string): Figure => (l.cost === null ? none(l.why ?? 'the book cannot be walked') : fig(usd(l.cost), `${what}: average price of walking the book for the whole size vs the mid, half the spread included (router.walkBook)`));
  const row: VenueCostRow = {
    venue: i.venue, instrument: i.id,
    midPrice: mid === null ? none(why!) : fig(D.str(D.div(mid, D.one, 10, 'half_even')), '(best bid + best ask) / 2'),
    spreadBps: mid === null || bid === null || ask === null ? none(why!) : fig(bpsStr(ratioBps(D.sub(ask, bid), mid)), '(best ask − best bid) / mid'),
    depthBidUsd: mid === null ? none(why!) : fig(usd(depthUsd(book!.bids, mid, depthB, 'bid')), `Σ price × size of the bids within ${req.depthBps} bps of the mid, in the supplied book`),
    depthAskUsd: mid === null ? none(why!) : fig(usd(depthUsd(book!.asks, mid, depthB, 'ask')), `Σ price × size of the asks within ${req.depthBps} bps of the mid, in the supplied book`),
    sizeBase: size === null || sizeWhy !== null ? none(sizeWhy!) : fig(D.str(size), o.sizeBase !== undefined ? 'the size given, rounded down to the lot' : 'notional / mid, rounded down to the lot'),
    entryAvgPrice: entry.avg === null ? none(entry.why ?? 'the book cannot be walked') : fig(D.str(D.div(entry.avg, D.one, 10, 'half_even')), 'average price of walking the book for the whole size'),
    entrySlippageBps: entry.avg === null || mid === null ? none(entry.why ?? 'the book cannot be walked') : fig(bpsStr(ratioBps(D.max(entrySide === 'buy' ? D.sub(entry.avg, mid) : D.sub(mid, entry.avg), D.zero), mid)), '|average entry price − mid| / mid'),
    entrySlippageUsd: slip(entry, 'entry'), exitSlippageUsd: slip(exit, 'exit, on the current book'),
    entryFeeUsd: fee(), exitFeeUsd: fee(),
    fundingUsd,
    fundingRatePerHour: perHour === null ? none(fundingWhy!) : fig(D.str(D.div(perHour, D.one, 12, 'half_even')), `rate per ${f!.intervalSec} s × 3600 / ${f!.intervalSec}`),
    collateralRequiredUsd: collateral, liquidationPrice: liq, liquidationDistanceBps: liqDist,
    maxLeverage: fig(i.maxLeverage, 'the venue\'s maximum for the instrument'),
    totalCostUsd: none(''), totalCostBps: none(''), missing: [], assumptions: [...COST_ASSUMPTIONS],
  };
  row.missing = COST_COMPONENTS.filter((c) => row[c].value === null);
  if (row.missing.length) row.totalCostUsd = row.totalCostBps = none(`incomplete: ${row.missing.map((c) => `${c} (${row[c].reason})`).join('; ')}`);
  else {
    const total = COST_COMPONENTS.reduce((acc, c) => D.add(acc, D.from(row[c].value!)), D.zero);
    row.totalCostUsd = fig(usd(total), `sum of ${COST_COMPONENTS.join(' + ')}`);
    row.totalCostBps = fig(bpsStr(ratioBps(total, positionNotional!)), 'total cost / position notional');
  }
  return row;
}

/** one row per venue, in the order given: a table to compare, not a ranking (the contracts differ) */
export function compareVenues(inputs: readonly VenueCostInput[], req: CostRequest): VenueCostRow[] { return inputs.map((x) => venueCost(x, req)); }

export interface DiscrepancyResult {
  /** buy (long) on this venue, sell (short) on the other */
  longVenue: string; shortVenue: string; longInstrument: string; shortInstrument: string;
  /** (average sell price on the short venue − average buy price on the long venue) / buy price, before costs; null when it cannot be computed */
  grossGapBps: DecStr | null;
  /** the gap net of fees on four legs, the exit slippage on both venues and the net funding over the horizon. An ESTIMATE under `assumptions`. */
  netEdgeEstimateBps: DecStr | null;
  /** costs subtracted from the gap, USD */
  costsUsd: { feesUsd: DecStr; exitSlippageUsd: DecStr; fundingUsd: DecStr } | null;
  /** true when netEdgeEstimateBps is above the threshold the caller gave */
  flagged: boolean;
  reason: string | null;
  assumptions: string[];
  risks: string[];
}

export const DISCREPANCY_ASSUMPTIONS = [
  'both legs are opened at the same time, in full, at the average prices of walking the two CURRENT books',
  'both legs are closed at the same time, at ONE common price: the two venues\' prices are assumed to converge by the end of the horizon',
  'the exit slippage is the one of the current books',
  'funding on both venues is the current rate held constant over the horizon',
  'the two instruments track the same underlying with the same contract size; differences in index, mark-price rule and collateral are ignored',
  'collateral is already on both venues: no transfer, bridge or gas cost is counted',
] as const;
export const DISCREPANCY_RISKS = [
  'execution risk: one leg can fill and the other not, or at a worse price; the books move between the two orders',
  'convergence risk: the price difference can persist or widen for longer than the horizon',
  'funding risk: rates change every interval and can reverse the sign of the carry',
  'liquidation risk: each leg is margined on its own venue; a sharp move can liquidate one leg while the other gains',
  'venue risk: an outage, a halt, a withdrawal freeze or a smart-contract failure on either venue breaks the hedge',
  'model risk: every figure here is an estimate from a snapshot, not a quote',
] as const;

/**
 * Price discrepancy between two venues for the same notional: long on `a`, short on `b`. Returns the estimate with its
 * assumptions and risks; `flagged` only says that the estimate is above `minNetEdgeBps`.
 */
export function crossVenueDiscrepancy(a: VenueCostInput, b: VenueCostInput, req: Omit<CostRequest, 'side'>, minNetEdgeBps: DecStr): DiscrepancyResult {
  // first pass: the size each venue would take for the notional; the hedge is the smaller one, on both venues' lots
  let long = venueCost(a, { ...req, side: 'long' }), short = venueCost(b, { ...req, side: 'short' });
  if (long.sizeBase.value !== null && short.sizeBase.value !== null) {
    const la = D.from(a.instrument.lotSize), lb = D.from(b.instrument.lotSize);
    const hedge = D.str(D.quantize(D.quantize(D.min(D.from(long.sizeBase.value), D.from(short.sizeBase.value)), la, 'down'), lb, 'down'));
    // second pass: both legs priced for exactly that size
    long = venueCost(a, { ...req, side: 'long' }, { sizeBase: hedge }); short = venueCost(b, { ...req, side: 'short' }, { sizeBase: hedge });
  }
  const base: DiscrepancyResult = { longVenue: long.venue, shortVenue: short.venue, longInstrument: long.instrument, shortInstrument: short.instrument, grossGapBps: null, netEdgeEstimateBps: null, costsUsd: null,
    flagged: false, reason: null, assumptions: [...DISCREPANCY_ASSUMPTIONS], risks: [...DISCREPANCY_RISKS] };
  if (a.instrument.base !== b.instrument.base) return { ...base, reason: `the instruments do not have the same base asset (${a.instrument.base} and ${b.instrument.base})` };
  const need: [Figure, string][] = [[long.entryAvgPrice, `${long.venue} entry price`], [short.entryAvgPrice, `${short.venue} entry price`], [long.sizeBase, `${long.venue} size`], [short.sizeBase, `${short.venue} size`],
    [long.entryFeeUsd, `${long.venue} fee`], [short.entryFeeUsd, `${short.venue} fee`], [long.exitSlippageUsd, `${long.venue} exit slippage`], [short.exitSlippageUsd, `${short.venue} exit slippage`],
    [long.fundingUsd, `${long.venue} funding`], [short.fundingUsd, `${short.venue} funding`]];
  const missing = need.filter(([f]) => f.value === null);
  if (missing.length) return { ...base, reason: `incomplete: ${missing.map(([f, what]) => `${what} (${f.reason})`).join('; ')}` };
  const buy = D.from(long.entryAvgPrice.value!), sell = D.from(short.entryAvgPrice.value!);
  const size = D.min(D.from(long.sizeBase.value!), D.from(short.sizeBase.value!));
  const notional = D.mul(size, buy);
  if (!D.isPos(notional)) return { ...base, reason: 'the hedged size is zero' };
  const gross = D.mul(D.sub(sell, buy), size);
  const fees = [long.entryFeeUsd, long.exitFeeUsd, short.entryFeeUsd, short.exitFeeUsd].reduce((acc, f) => D.add(acc, D.from(f.value!)), D.zero);
  const exitSlip = D.add(D.from(long.exitSlippageUsd.value!), D.from(short.exitSlippageUsd.value!));
  const funding = D.add(D.from(long.fundingUsd.value!), D.from(short.fundingUsd.value!));
  const net = D.sub(D.sub(D.sub(gross, fees), exitSlip), funding);
  const netBps = ratioBps(net, notional);
  return { ...base, grossGapBps: bpsStr(ratioBps(gross, notional)), netEdgeEstimateBps: bpsStr(netBps), costsUsd: { feesUsd: usd(fees), exitSlippageUsd: usd(exitSlip), fundingUsd: usd(funding) },
    flagged: D.gt(netBps, D.from(minNetEdgeBps)) };
}

/** every ordered pair of venues, flagged ones first by estimate; pairs that cannot be estimated are kept with their reason */
export function findDiscrepancies(inputs: readonly VenueCostInput[], req: Omit<CostRequest, 'side'>, minNetEdgeBps: DecStr): DiscrepancyResult[] {
  const out: DiscrepancyResult[] = [];
  for (let x = 0; x < inputs.length; x++) for (let y = 0; y < inputs.length; y++) if (x !== y) out.push(crossVenueDiscrepancy(inputs[x]!, inputs[y]!, req, minNetEdgeBps));
  const key = (r: DiscrepancyResult): Dec | null => (r.netEdgeEstimateBps === null ? null : D.from(r.netEdgeEstimateBps));
  return out.sort((p, q) => { const a = key(p), b = key(q); return a === null ? (b === null ? 0 : 1) : b === null ? -1 : D.cmp(b, a); });
}

/**
 * Independent risk engine of the V11 trading layer. Deterministic and pure: no clock (the caller's `context.now`), no network,
 * no state. One question — may this request be executed, given this context and these limits? — and one answer that lists
 * EVERY check with what was observed and what the limit was.
 *
 * Principles
 *  1. Every limit is explicit. A limit that is not configured is a DENY for anything that can increase risk; it is never read
 *     as "unlimited". The same holds for a context value the engine needs and cannot read.
 *  2. `reducing` is decided here, from the positions in the context — never from a flag alone. An order is strictly reducing
 *     when it is a perp order, carries `reduceOnly` (so the venue itself refuses to increase or flip), is on the opposite side
 *     of an existing position on the same venue and instrument, and its size is at most that position. A cancel is always
 *     reducing.
 *  3. A strictly reducing order is exempt from every exposure, leverage, loss, rate, allow-list and kill-switch check: the way
 *     out must stay open. It remains subject only to the checks listed in REDUCING_ORDER_CHECKS (see RISK_CHECKS[*].reducing).
 *  4. `killSwitch` blocks every request that is not strictly reducing. `readOnly` blocks everything except a cancel.
 *  5. Fail closed: a request, context or limit set the engine cannot read is a denial (`input_valid`).
 *
 * Formulas are the ones of packages/derivatives (margin.ts: exposures, leverage, initial margin, liquidation prices; router.ts:
 * the order-book walk). They are imported, not copied. Valuation follows risk.ts: positions at their mark; the order at the
 * highest of the fresh reference prices, its limit price and its trigger price; resting orders are not counted.
 */
import { z } from 'zod';
import {
  BookSchema, D, DecStrSchema, effectiveLeverage, exposureByAsset, grossExposure, liquidationPriceAtLeverage, liquidationPriceCross, netExposure, PositionSchema, signedSize, walkBook,
  type AccountState, type Dec, type DecStr, type ExposureInput, type Instrument,
} from '@spw/derivatives';
import { bpsStr, exceedsBps, NonNegDecSchema, PosDecSchema, ratioBps, SCALE, TsMsSchema } from '../dec.ts';
import { CanonicalOrderSchema, type CanonicalOrder } from '../orders/canonical.ts';

// ------------------------------------------------------------------------------------------------------------------ inputs

export type RiskRequest = { kind: 'order'; order: CanonicalOrder } | { kind: 'cancel'; venue: string; clientOrderId: string };

/** the derivatives `Instrument`, with the venue open to venues the derivatives package does not know and to spot */
export type RiskInstrument = Omit<Instrument, 'venue' | 'kind'> & { venue: string; kind: 'perpetual' | 'spot' };
/** the derivatives `AccountState` fields the engine reads, per venue */
export type RiskAccount = Pick<AccountState, 'account' | 'equity' | 'collateral' | 'freeCollateral' | 'marginUsed' | 'ts'> & { venue: string };

const Count = z.number().int().nonnegative();
const InstrumentIn = z.object({
  venue: z.string().min(1), symbol: z.string().min(1), id: z.string().min(1), base: z.string().min(1), quote: z.string().min(1), kind: z.enum(['perpetual', 'spot']),
  tickSize: DecStrSchema, lotSize: DecStrSchema, maxLeverage: DecStrSchema, status: z.enum(['active', 'reduce_only', 'halted']),
});
export const TradingRiskContextSchema = z.object({
  /** the caller's clock, unix ms */
  now: TsMsSchema,
  /** blocks all new risk, on every venue */
  killSwitch: z.boolean(),
  /** blocks everything except a cancel */
  readOnly: z.boolean(),
  /** the order's instrument (null for a cancel) and its asset under the caller's normalization (e.g. 'BTC' for hyperliquid:BTC and gmx:BTC-USD) */
  instrument: InstrumentIn.nullable(),
  asset: z.string().min(1).nullable(),
  /** positions on ALL venues; `asset` is the caller's normalized symbol. Spot holdings the limits should see are given as long positions. */
  positions: z.array(z.object({ venue: z.string().min(1), account: z.string().min(1), asset: z.string().min(1), position: PositionSchema })),
  /** balances / collateral per venue */
  accounts: z.array(z.object({ venue: z.string().min(1), account: z.string().min(1), equity: DecStrSchema, collateral: DecStrSchema, freeCollateral: DecStrSchema, marginUsed: DecStrSchema, ts: TsMsSchema })),
  /** reference prices of the order's instrument, one per source, each with its own time */
  marks: z.array(z.object({ instrument: z.string().min(1), source: z.string().min(1), price: DecStrSchema, ts: TsMsSchema })),
  book: BookSchema.nullable(),
  /** PnL in USD, negative = loss; fees and funding included by the caller */
  pnl: z.object({ realizedToday: DecStrSchema, unrealizedToday: DecStrSchema, realizedInception: DecStrSchema, unrealizedInception: DecStrSchema }),
  /** total equity the limits apply to (the caller says what it covers: venue accounts, wallet) and its highest value so far */
  equity: z.object({ current: DecStrSchema, peak: DecStrSchema }),
  signer: z.object({ reachable: z.boolean(), halted: z.boolean() }),
  /** per venue: is the connection to the venue usable now */
  connections: z.record(z.string(), z.object({ connected: z.boolean() })),
  /** orders already accepted, NOT counting this one; notional of today's accepted orders, USD */
  usage: z.object({ ordersLastMinute: Count, ordersLastHour: Count, ordersToday: Count, notionalToday: NonNegDecSchema }),
  /** the venue's current leverage setting for the instrument, when the caller knows it */
  leverageSetting: PosDecSchema.nullable().optional(),
  /** maintenance margin fraction of the instrument; default 1 / (2 · instrument.maxLeverage), as risk.ts */
  maintenanceMarginFraction: NonNegDecSchema.optional(),
});
export type TradingRiskContext = z.infer<typeof TradingRiskContextSchema>;
export type RiskPosition = TradingRiskContext['positions'][number];
export type MarkQuote = TradingRiskContext['marks'][number];

const Keyed = z.strictObject({ per: z.record(z.string(), NonNegDecSchema), default: NonNegDecSchema.optional() });
/** every member is optional ON PURPOSE: an absent member is a missing limit, and a missing limit denies (principle 1) */
export const RiskLimitsSchema = z.strictObject({
  allowedVenues: z.array(z.string().min(1)).optional(),
  allowedInstruments: z.array(z.string().min(1)).optional(),
  /** resulting position per instrument, USD at the reference price: by instrument id, with an optional default */
  maxPositionNotional: Keyed.optional(),
  /** leverage setting of one order */
  maxOrderLeverage: PosDecSchema.optional(),
  /** gross exposure after the order / total equity */
  maxAccountLeverage: PosDecSchema.optional(),
  /** positive amounts, USD: denied once the loss REACHES them */
  maxDailyLoss: NonNegDecSchema.optional(),
  maxTotalLoss: NonNegDecSchema.optional(),
  /** drawdown from the peak equity, basis points of the peak: denied once reached */
  maxDrawdownBps: NonNegDecSchema.optional(),
  maxGrossExposure: NonNegDecSchema.optional(),
  /** |long − short| over all positions */
  maxNetExposure: NonNegDecSchema.optional(),
  /** |net| exposure per normalized asset, all venues together */
  maxAssetExposure: Keyed.optional(),
  /** gross exposure per venue */
  maxVenueExposure: Keyed.optional(),
  /** share of the total equity held on the order's venue, basis points */
  maxVenueCollateralShareBps: NonNegDecSchema.optional(),
  minLiquidationDistanceBps: NonNegDecSchema.optional(),
  /** estimated slippage of the order against the supplied book, basis points from the mid */
  maxSlippageBps: NonNegDecSchema.optional(),
  /** oldest acceptable price per source (ms), with an optional default; and the oldest acceptable book */
  maxPriceAgeMs: z.strictObject({ per: z.record(z.string(), Count), default: Count.optional() }).optional(),
  maxBookAgeMs: Count.optional(),
  /** number of FRESH sources required */
  minPriceSources: z.number().int().min(1).optional(),
  /** (highest − lowest) / lowest over the fresh sources, basis points */
  maxSourceDeviationBps: NonNegDecSchema.optional(),
  maxOrdersPerMinute: Count.optional(), maxOrdersPerHour: Count.optional(), maxOrdersPerDay: Count.optional(),
  maxOrderNotional: NonNegDecSchema.optional(),
  maxDailyNotional: NonNegDecSchema.optional(),
  /** book depth on the taking side within `withinBps` of the mid must be at least `multiple` × the order's size */
  minLiquidity: z.strictObject({ withinBps: NonNegDecSchema, multiple: PosDecSchema }).optional(),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

// ------------------------------------------------------------------------------------------------------------------ checks

export const RISK_CHECK_IDS = [
  'input_valid', 'read_only', 'kill_switch', 'reduce_only_valid', 'venue_allowed', 'instrument_allowed', 'instrument_status', 'signer_status', 'venue_connection',
  'price_freshness', 'price_consistency', 'order_notional', 'daily_notional', 'order_rate_minute', 'order_rate_hour', 'order_rate_day',
  'position_size', 'order_leverage', 'account_leverage', 'gross_exposure', 'net_exposure', 'asset_exposure', 'venue_exposure', 'collateral_concentration',
  'daily_loss', 'total_loss', 'drawdown', 'liquidation_distance', 'slippage', 'min_liquidity',
] as const;
export type RiskCheckId = (typeof RISK_CHECK_IDS)[number];

/** `always`: applied to a strictly reducing order too. `no_limit_price`: applied to it only when it has no limit price. `never`: exempt. */
export type ReducingRule = 'always' | 'no_limit_price' | 'never';
export interface RiskCheckSpec { id: RiskCheckId; reducing: ReducingRule; limit: string; inputs: string; rule: string }
export const RISK_CHECKS: readonly RiskCheckSpec[] = [
  { id: 'input_valid', reducing: 'always', limit: '—', inputs: 'request, context, limits', rule: 'the three inputs parse; the order\'s instrument is the context\'s; at most one position per venue and instrument; a spot sell does not exceed the holding supplied' },
  { id: 'read_only', reducing: 'always', limit: 'context.readOnly', inputs: 'readOnly', rule: 'read-only mode denies every order, reducing or not; only a cancel passes' },
  { id: 'kill_switch', reducing: 'never', limit: 'context.killSwitch', inputs: 'killSwitch', rule: 'the kill switch denies every order that is not strictly reducing' },
  { id: 'reduce_only_valid', reducing: 'always', limit: '—', inputs: 'order, positions', rule: 'an order flagged reduce-only must be opposite to an existing position and no larger than it (it can neither increase nor flip)' },
  { id: 'venue_allowed', reducing: 'never', limit: 'allowedVenues', inputs: 'order.venue', rule: 'the venue is in the allow-list' },
  { id: 'instrument_allowed', reducing: 'never', limit: 'allowedInstruments', inputs: 'order.instrument', rule: 'the instrument is in the allow-list' },
  { id: 'instrument_status', reducing: 'never', limit: '—', inputs: 'instrument.status', rule: 'the instrument is active on the venue (a halted or reduce-only instrument takes no new risk)' },
  { id: 'signer_status', reducing: 'never', limit: '—', inputs: 'signer.reachable, signer.halted, order.mode', rule: 'live orders: the signer is reachable and not halted' },
  { id: 'venue_connection', reducing: 'never', limit: '—', inputs: 'connections[venue], order.mode', rule: 'live orders: the venue connection is up' },
  { id: 'price_freshness', reducing: 'no_limit_price', limit: 'maxPriceAgeMs, minPriceSources', inputs: 'marks[].ts, now', rule: 'at least minPriceSources sources of the instrument are no older (and no further in the future) than their maximum age' },
  { id: 'price_consistency', reducing: 'no_limit_price', limit: 'maxSourceDeviationBps', inputs: 'fresh marks', rule: '(highest − lowest) / lowest over the fresh sources is within the limit; inconsistent data denies' },
  { id: 'order_notional', reducing: 'never', limit: 'maxOrderNotional', inputs: 'order, reference price', rule: 'notional of the order (its own notional, or size × the highest of reference, limit and trigger price)' },
  { id: 'daily_notional', reducing: 'never', limit: 'maxDailyNotional', inputs: 'usage.notionalToday, order notional', rule: 'today\'s accepted notional plus this order' },
  { id: 'order_rate_minute', reducing: 'never', limit: 'maxOrdersPerMinute', inputs: 'usage.ordersLastMinute', rule: 'orders already accepted in the last minute are below the limit' },
  { id: 'order_rate_hour', reducing: 'never', limit: 'maxOrdersPerHour', inputs: 'usage.ordersLastHour', rule: 'orders already accepted in the last hour are below the limit' },
  { id: 'order_rate_day', reducing: 'never', limit: 'maxOrdersPerDay', inputs: 'usage.ordersToday', rule: 'orders already accepted today are below the limit' },
  { id: 'position_size', reducing: 'never', limit: 'maxPositionNotional', inputs: 'positions, order, reference price', rule: 'resulting position on the instrument, at the reference price' },
  { id: 'order_leverage', reducing: 'never', limit: 'maxOrderLeverage', inputs: 'order.leverage | leverageSetting | position.leverage, instrument.maxLeverage', rule: 'perp: the leverage setting the order runs under is known, within the limit and within the venue\'s maximum' },
  { id: 'account_leverage', reducing: 'never', limit: 'maxAccountLeverage', inputs: 'positions after the order, equity.current', rule: 'gross exposure after the order / total equity (margin.effectiveLeverage); equity ≤ 0 denies' },
  { id: 'gross_exposure', reducing: 'never', limit: 'maxGrossExposure', inputs: 'positions after the order', rule: 'Σ |size| · mark over all venues (margin.grossExposure)' },
  { id: 'net_exposure', reducing: 'never', limit: 'maxNetExposure', inputs: 'positions after the order', rule: '|Σ long − Σ short| over all venues (margin.netExposure)' },
  { id: 'asset_exposure', reducing: 'never', limit: 'maxAssetExposure', inputs: 'positions after the order, by normalized asset', rule: '|net| exposure of the order\'s asset over all venues (margin.exposureByAsset)' },
  { id: 'venue_exposure', reducing: 'never', limit: 'maxVenueExposure', inputs: 'positions after the order on the order\'s venue', rule: 'gross exposure on the order\'s venue' },
  { id: 'collateral_concentration', reducing: 'never', limit: 'maxVenueCollateralShareBps', inputs: 'accounts[venue].equity, equity.current', rule: 'share of the total equity held on the order\'s venue' },
  { id: 'daily_loss', reducing: 'never', limit: 'maxDailyLoss', inputs: 'pnl.realizedToday + pnl.unrealizedToday', rule: 'today\'s loss has not reached the limit' },
  { id: 'total_loss', reducing: 'never', limit: 'maxTotalLoss', inputs: 'pnl.realizedInception + pnl.unrealizedInception', rule: 'the loss since inception has not reached the limit' },
  { id: 'drawdown', reducing: 'never', limit: 'maxDrawdownBps', inputs: 'equity.peak, equity.current', rule: '(peak − current) / peak has not reached the limit' },
  { id: 'liquidation_distance', reducing: 'never', limit: 'minLiquidationDistanceBps', inputs: 'resulting position, leverage, venue account equity, maintenance fraction', rule: 'perp: estimated liquidation price after the order (margin.liquidationPriceCross / liquidationPriceAtLeverage) is at least the limit away from the reference price' },
  { id: 'slippage', reducing: 'never', limit: 'maxSlippageBps (and the order\'s own maxSlippageBps when lower)', inputs: 'book, order size', rule: 'average price of walking the book (router.walkBook) vs the mid; a book that cannot fill a market order denies' },
  { id: 'min_liquidity', reducing: 'never', limit: 'minLiquidity', inputs: 'book, order size', rule: 'depth on the taking side within withinBps of the mid ≥ multiple × order size' },
];
/** the checks a strictly reducing order is still subject to (the rest is exempt) */
export const REDUCING_ORDER_CHECKS: readonly RiskCheckId[] = RISK_CHECKS.filter((c) => c.reducing !== 'never').map((c) => c.id);

export interface RiskCheck { id: RiskCheckId; ok: boolean; observed: string | null; limit: string | null; detail: string; /** true when the check was not applied because the request strictly reduces risk */ exempt: boolean }
export interface RiskEvaluation {
  decision: 'allow' | 'deny';
  checks: RiskCheck[];
  /** decided from the positions in the context (principle 2) */
  reducing: boolean;
  /** what the engine derived for the order; null members could not be computed */
  derived: { size: DecStr | null; notional: DecStr | null; referencePrice: DecStr | null; positionBefore: DecStr; positionAfter: DecStr | null };
}

const MISSING = 'no limit is configured: denied (a missing limit is never read as unlimited)';
const EXEMPT = 'exempt: the order strictly reduces an existing position';
const TWO = D.from(2n);

class Collector {
  readonly checks: RiskCheck[] = [];
  add(id: RiskCheckId, ok: boolean, observed: string | null, limit: string | null, detail: string): void { this.checks.push({ id, ok, observed, limit, detail, exempt: false }); }
  pass(id: RiskCheckId, detail: string, observed: string | null = null, limit: string | null = null): void { this.add(id, true, observed, limit, detail); }
  fail(id: RiskCheckId, detail: string, observed: string | null = null, limit: string | null = null): void { this.add(id, false, observed, limit, detail); }
  exempt(id: RiskCheckId): void { this.checks.push({ id, ok: true, observed: null, limit: null, detail: EXEMPT, exempt: true }); }
  /** observed ≤ limit; a missing limit fails */
  max(id: RiskCheckId, observed: Dec | null, limit: DecStr | undefined, what: string, why?: string): void {
    if (limit === undefined) return this.fail(id, MISSING, observed === null ? null : D.str(observed));
    if (observed === null) return this.fail(id, why ?? `${what} cannot be computed from the context`, null, limit);
    const ok = D.lte(observed, D.from(limit));
    this.add(id, ok, D.str(observed), limit, ok ? `${what} is within the limit` : `${what} exceeds the limit`);
  }
  sorted(): RiskCheck[] { return [...this.checks].sort((a, b) => RISK_CHECK_IDS.indexOf(a.id) - RISK_CHECK_IDS.indexOf(b.id)); }
}

function denyInput(detail: string): RiskEvaluation {
  return { decision: 'deny', reducing: false, checks: [{ id: 'input_valid', ok: false, observed: null, limit: null, detail, exempt: false }], derived: { size: null, notional: null, referencePrice: null, positionBefore: '0', positionAfter: null } };
}
const issue = (e: z.ZodError): string => `${e.issues[0]?.path.join('.') ?? ''} ${e.issues[0]?.message ?? ''}`.trim();
const keyed = (k: { per: Record<string, DecStr>; default?: DecStr | undefined } | undefined, key: string): DecStr | undefined => (k === undefined ? undefined : Object.hasOwn(k.per, key) ? k.per[key] : k.default);

export function evaluate(request: RiskRequest, context: TradingRiskContext, limits: RiskLimits): RiskEvaluation {
  try {
    const l = RiskLimitsSchema.safeParse(limits);
    if (!l.success) return denyInput(`invalid limits: ${issue(l.error)}`);
    const c = TradingRiskContextSchema.safeParse(context);
    if (!c.success) return denyInput(`invalid context: ${issue(c.error)}`);
    if (request === null || typeof request !== 'object') return denyInput('invalid request');
    if (request.kind === 'cancel') {
      if (typeof request.venue !== 'string' || !request.venue || typeof request.clientOrderId !== 'string' || !request.clientOrderId) return denyInput('a cancel names a venue and a client order id');
      // a cancel removes a resting order: it can only lower what may still execute. It passes the kill switch and read-only mode.
      return { decision: 'allow', reducing: true, checks: [{ id: 'input_valid', ok: true, observed: null, limit: null, detail: 'a cancel is always permitted', exempt: false }],
        derived: { size: null, notional: null, referencePrice: null, positionBefore: '0', positionAfter: null } };
    }
    if (request.kind !== 'order') return denyInput('unknown request kind');
    const o = CanonicalOrderSchema.safeParse(request.order);
    if (!o.success) return denyInput(`invalid order: ${issue(o.error)}`);
    return run(o.data, c.data, l.data);
  } catch (e) {
    return denyInput(`the request could not be evaluated: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function run(o: CanonicalOrder, ctx: TradingRiskContext, lim: RiskLimits): RiskEvaluation {
  const inst = ctx.instrument;
  if (inst === null || ctx.asset === null) return denyInput('the context names no instrument for the order');
  if (inst.id !== o.instrument || inst.venue !== o.venue) return denyInput(`the order is for ${o.instrument} on ${o.venue}; the context is for ${inst.id} on ${inst.venue}`);
  if ((inst.kind === 'spot') !== (o.marketKind === 'spot')) return denyInput('the order\'s market kind is not the instrument\'s');
  const own = ctx.positions.filter((p) => p.venue === o.venue && p.position.instrument === o.instrument);
  if (own.length > 1) return denyInput(`several positions on ${o.instrument} were supplied; the engine needs one per venue and instrument`);
  const pos = own[0]?.position ?? null;
  const k = new Collector();

  // ---- prices: fresh sources of the order's instrument
  const quotes = ctx.marks.filter((m) => m.instrument === o.instrument);
  const fresh: { source: string; price: Dec }[] = [], stale: string[] = [], unbounded: string[] = [];
  for (const m of quotes) {
    const maxAge = lim.maxPriceAgeMs === undefined ? undefined : Object.hasOwn(lim.maxPriceAgeMs.per, m.source) ? lim.maxPriceAgeMs.per[m.source] : lim.maxPriceAgeMs.default;
    const price = D.from(m.price);
    if (!D.isPos(price)) { stale.push(`${m.source} (price not positive)`); continue; }
    if (maxAge === undefined) { unbounded.push(m.source); continue; }
    if (Math.abs(ctx.now - m.ts) > maxAge) { stale.push(`${m.source} (${ctx.now - m.ts} ms)`); continue; }
    fresh.push({ source: m.source, price });
  }
  const refHigh = fresh.length ? fresh.reduce((a, x) => D.max(a, x.price), fresh[0]!.price) : null;
  const refLow = fresh.length ? fresh.reduce((a, x) => D.min(a, x.price), fresh[0]!.price) : null;

  // ---- size, position before and after
  const named = [o.limitPrice, o.triggerPrice].filter((x): x is DecStr => x !== null).map((x) => D.from(x));
  // a notional is turned into a size at the LOWEST fresh price, rounded up: the largest size the notional can buy
  const size: Dec | null = o.size !== null ? D.from(o.size) : refLow !== null ? D.div(D.from(o.notional!), refLow, SCALE, 'up') : null;
  const valuePrice: Dec | null = refHigh !== null ? named.reduce((a, x) => D.max(a, x), refHigh) : null;
  const orderNotional: Dec | null = o.notional !== null ? (size !== null && valuePrice !== null ? D.max(D.from(o.notional), D.mul(size, valuePrice)) : D.from(o.notional)) : size !== null && valuePrice !== null ? D.mul(size, valuePrice) : null;
  const before = signedSize(pos ? { side: pos.side, size: D.from(pos.size) } : null);
  const after: Dec | null = size === null ? null : o.side === 'buy' ? D.add(before, size) : D.sub(before, size);
  const opposite = !D.isZero(before) && (D.isPos(before) ? o.side === 'sell' : o.side === 'buy');
  const reduces = opposite && size !== null && D.lte(size, D.abs(before));
  const reducing = o.marketKind === 'perp' && o.reduceOnly && reduces;
  const derived = { size: size === null ? null : D.str(size), notional: orderNotional === null ? null : D.str(orderNotional), referencePrice: refHigh === null ? null : D.str(refHigh), positionBefore: D.str(before), positionAfter: after === null ? null : D.str(after) };

  // ---- input_valid
  if (o.marketKind === 'spot' && o.side === 'sell' && (after === null || D.isNeg(after))) k.fail('input_valid', 'a spot sell must not exceed the holding supplied in the context (a spot holding is given as a long position)', derived.size, D.str(D.max(before, D.zero)));
  else k.pass('input_valid', 'request, context and limits are well formed');

  // ---- read-only, kill switch
  k.add('read_only', !ctx.readOnly, String(ctx.readOnly), 'false', ctx.readOnly ? 'read-only mode: only a cancel is permitted' : 'not in read-only mode');
  if (reducing) k.exempt('kill_switch'); else k.add('kill_switch', !ctx.killSwitch, String(ctx.killSwitch), 'false', ctx.killSwitch ? 'the kill switch is on: no new risk' : 'the kill switch is off');

  // ---- reduce-only validity
  if (!o.reduceOnly) k.pass('reduce_only_valid', 'not a reduce-only order');
  else if (reduces) k.pass('reduce_only_valid', 'the order is opposite to the position and no larger than it', derived.size, D.str(D.abs(before)));
  else k.fail('reduce_only_valid', size === null ? 'the size of the order cannot be derived (no fresh price): it cannot be shown to reduce' : !opposite ? 'a reduce-only order must be opposite to an existing position: this one would open or increase' : 'the order is larger than the position: it would flip it', derived.size, D.str(D.abs(before)));

  const exemptAll = (ids: readonly RiskCheckId[]) => { for (const id of ids) k.exempt(id); };

  // ---- price freshness and consistency (a reducing order with a limit price carries its own bound: exempt)
  const pricesApply = !reducing || o.limitPrice === null;
  if (!pricesApply) exemptAll(['price_freshness', 'price_consistency']);
  else {
    const seen = `${fresh.length} fresh of ${quotes.length}${stale.length ? `; stale: ${stale.join(', ')}` : ''}${unbounded.length ? `; no maximum age configured: ${unbounded.join(', ')}` : ''}`;
    if (lim.maxPriceAgeMs === undefined || lim.minPriceSources === undefined) k.fail('price_freshness', MISSING, seen);
    else k.add('price_freshness', fresh.length >= lim.minPriceSources, seen, `${lim.minPriceSources} fresh source(s)`, fresh.length >= lim.minPriceSources ? 'enough fresh price sources' : 'not enough fresh price sources');
    if (lim.maxSourceDeviationBps === undefined) k.fail('price_consistency', MISSING);
    else if (refHigh === null || refLow === null) k.fail('price_consistency', 'no fresh price to compare', null, lim.maxSourceDeviationBps);
    else {
      const spread = D.sub(refHigh, refLow), bad = exceedsBps(spread, refLow, D.from(lim.maxSourceDeviationBps));
      k.add('price_consistency', !bad, bpsStr(ratioBps(spread, refLow)), lim.maxSourceDeviationBps, fresh.length === 1 ? 'a single fresh source: nothing to cross-check' : bad ? 'the price sources disagree: inconsistent data' : 'the price sources agree');
    }
  }

  if (reducing) {
    exemptAll(['venue_allowed', 'instrument_allowed', 'instrument_status', 'signer_status', 'venue_connection', 'order_notional', 'daily_notional', 'order_rate_minute', 'order_rate_hour', 'order_rate_day',
      'position_size', 'order_leverage', 'account_leverage', 'gross_exposure', 'net_exposure', 'asset_exposure', 'venue_exposure', 'collateral_concentration', 'daily_loss', 'total_loss', 'drawdown',
      'liquidation_distance', 'slippage', 'min_liquidity']);
    return finish(k, reducing, derived);
  }

  // ---- allow-lists, instrument status
  if (lim.allowedVenues === undefined) k.fail('venue_allowed', MISSING, o.venue); else k.add('venue_allowed', lim.allowedVenues.includes(o.venue), o.venue, lim.allowedVenues.join(', '), lim.allowedVenues.includes(o.venue) ? 'the venue is allowed' : 'the venue is not in the allow-list');
  if (lim.allowedInstruments === undefined) k.fail('instrument_allowed', MISSING, o.instrument); else k.add('instrument_allowed', lim.allowedInstruments.includes(o.instrument), o.instrument, `${lim.allowedInstruments.length} instrument(s)`, lim.allowedInstruments.includes(o.instrument) ? 'the instrument is allowed' : 'the instrument is not in the allow-list');
  k.add('instrument_status', inst.status === 'active', inst.status, 'active', inst.status === 'active' ? 'the instrument is active' : inst.status === 'halted' ? 'the instrument is halted on the venue' : 'the instrument only accepts orders that reduce a position');

  // ---- signer and venue connection (live only: a paper or research order reaches neither)
  if (o.mode !== 'live') { k.pass('signer_status', `not applicable to a ${o.mode} order`); k.pass('venue_connection', `not applicable to a ${o.mode} order`); }
  else {
    const sOk = ctx.signer.reachable && !ctx.signer.halted;
    k.add('signer_status', sOk, `reachable=${ctx.signer.reachable} halted=${ctx.signer.halted}`, 'reachable and not halted', sOk ? 'the signer is available' : !ctx.signer.reachable ? 'the signer is unreachable' : 'the signer is halted');
    const conn = Object.hasOwn(ctx.connections, o.venue) ? ctx.connections[o.venue] : undefined;
    k.add('venue_connection', conn?.connected === true, conn === undefined ? 'unknown' : String(conn.connected), 'connected', conn?.connected === true ? 'the venue connection is up' : conn === undefined ? 'the connection status of the venue is not in the context' : 'the venue connection is down');
  }

  // ---- notional and rates
  k.max('order_notional', orderNotional, lim.maxOrderNotional, 'the order\'s notional', 'no fresh price: the order cannot be valued');
  k.max('daily_notional', orderNotional === null ? null : D.add(D.from(ctx.usage.notionalToday), orderNotional), lim.maxDailyNotional, 'today\'s notional with this order', 'no fresh price: the order cannot be valued');
  const rate = (id: RiskCheckId, used: number, limit: number | undefined, window: string) => {
    if (limit === undefined) return k.fail(id, MISSING, String(used));
    k.add(id, used < limit, String(used), String(limit), used < limit ? `orders in ${window} are below the limit` : `the order rate limit of ${window} is reached`);
  };
  rate('order_rate_minute', ctx.usage.ordersLastMinute, lim.maxOrdersPerMinute, 'the last minute');
  rate('order_rate_hour', ctx.usage.ordersLastHour, lim.maxOrdersPerHour, 'the last hour');
  rate('order_rate_day', ctx.usage.ordersToday, lim.maxOrdersPerDay, 'the day');

  // ---- positions after the order
  const NO_PRICE = 'no fresh price: the resulting position cannot be valued';
  const others: (ExposureInput & { venue: string })[] = ctx.positions.filter((p) => p.position !== pos).map((p) => ({ venue: p.venue, asset: p.asset, side: p.position.side, size: D.from(p.position.size), markPrice: D.from(p.position.markPrice) }));
  const all: (ExposureInput & { venue: string })[] | null = after === null || refHigh === null ? null
    : D.isZero(after) ? others : [...others, { venue: o.venue, asset: ctx.asset, side: D.isPos(after) ? 'long' : 'short', size: D.abs(after), markPrice: refHigh }];
  const afterNotional = after === null || refHigh === null ? null : D.mul(D.abs(after), refHigh);
  k.max('position_size', afterNotional, keyed(lim.maxPositionNotional, o.instrument), 'the resulting position', NO_PRICE);

  // ---- leverage
  const equity = D.from(ctx.equity.current);
  const levStr = o.leverage ?? ctx.leverageSetting ?? pos?.leverage ?? null;
  if (o.marketKind === 'spot') k.pass('order_leverage', 'not applicable to a spot order');
  else if (lim.maxOrderLeverage === undefined) k.fail('order_leverage', MISSING, levStr);
  else if (levStr === null) k.fail('order_leverage', 'the leverage setting the order would run under is not known', null, lim.maxOrderLeverage);
  else {
    const lev = D.from(levStr), cap = D.min(D.from(lim.maxOrderLeverage), D.from(inst.maxLeverage)), ok = D.isPos(lev) && D.lte(lev, cap);
    k.add('order_leverage', ok, levStr, D.str(cap), ok ? 'the leverage setting is within the limit' : 'the leverage setting exceeds the limit or the venue\'s maximum');
  }
  if (lim.maxAccountLeverage === undefined) k.fail('account_leverage', MISSING);
  else if (all === null) k.fail('account_leverage', NO_PRICE, null, lim.maxAccountLeverage);
  else {
    const gross = grossExposure(all), lev = effectiveLeverage(equity, all);
    // gross / equity ≤ max ⇔ gross ≤ max · equity; equity ≤ 0 denies any exposure
    const ok = lev !== null ? D.lte(gross, D.mul(D.from(lim.maxAccountLeverage), equity)) : D.isZero(gross);
    k.add('account_leverage', ok, lev === null ? 'undefined (equity ≤ 0)' : D.str(lev), lim.maxAccountLeverage, ok ? 'account leverage after the order is within the limit' : lev === null ? 'the equity is not positive: no exposure is permitted' : 'account leverage after the order exceeds the limit');
  }

  // ---- exposures
  k.max('gross_exposure', all === null ? null : grossExposure(all), lim.maxGrossExposure, 'gross exposure after the order', NO_PRICE);
  k.max('net_exposure', all === null ? null : D.abs(netExposure(all)), lim.maxNetExposure, 'net exposure after the order', NO_PRICE);
  const byAsset = all === null ? null : exposureByAsset(all)[ctx.asset] ?? null;
  k.max('asset_exposure', all === null ? null : byAsset === null ? D.zero : D.abs(byAsset.net), keyed(lim.maxAssetExposure, ctx.asset), `net exposure to ${ctx.asset} on all venues`, NO_PRICE);
  k.max('venue_exposure', all === null ? null : grossExposure(all.filter((p) => p.venue === o.venue)), keyed(lim.maxVenueExposure, o.venue), `gross exposure on ${o.venue}`, NO_PRICE);

  // ---- collateral concentration
  const venueAccounts = ctx.accounts.filter((a) => a.venue === o.venue);
  if (lim.maxVenueCollateralShareBps === undefined) k.fail('collateral_concentration', MISSING);
  else if (!D.isPos(equity)) k.fail('collateral_concentration', 'the total equity is not positive', null, lim.maxVenueCollateralShareBps);
  else {
    const onVenue = venueAccounts.reduce((a, x) => D.add(a, D.from(x.equity)), D.zero), bad = exceedsBps(onVenue, equity, D.from(lim.maxVenueCollateralShareBps));
    k.add('collateral_concentration', !bad, bpsStr(ratioBps(onVenue, equity)), lim.maxVenueCollateralShareBps, bad ? `too large a share of the equity is held on ${o.venue}` : `the share of the equity held on ${o.venue} is within the limit`);
  }

  // ---- losses and drawdown: denied once the limit is REACHED
  const loss = (id: RiskCheckId, pnl: Dec, limit: DecStr | undefined, what: string) => {
    if (limit === undefined) return k.fail(id, MISSING, D.str(pnl));
    const reached = D.lte(pnl, D.neg(D.from(limit)));
    k.add(id, !reached, D.str(pnl), `-${limit}`, reached ? `${what} has reached the loss limit` : `${what} is above the loss limit`);
  };
  loss('daily_loss', D.add(D.from(ctx.pnl.realizedToday), D.from(ctx.pnl.unrealizedToday)), lim.maxDailyLoss, 'today\'s PnL');
  loss('total_loss', D.add(D.from(ctx.pnl.realizedInception), D.from(ctx.pnl.unrealizedInception)), lim.maxTotalLoss, 'the PnL since inception');
  const peak = D.from(ctx.equity.peak);
  if (lim.maxDrawdownBps === undefined) k.fail('drawdown', MISSING);
  else if (!D.isPos(peak)) k.fail('drawdown', 'the peak equity is not positive', ctx.equity.peak, lim.maxDrawdownBps);
  else {
    const dd = D.max(D.sub(peak, equity), D.zero), reached = D.isPos(dd) && D.gte(D.mul(dd, D.from(10000n)), D.mul(D.from(lim.maxDrawdownBps), peak));
    k.add('drawdown', !reached, bpsStr(ratioBps(dd, peak)), lim.maxDrawdownBps, reached ? 'the drawdown from the peak equity has reached the limit' : 'the drawdown from the peak equity is below the limit');
  }

  // ---- liquidation distance after the order
  if (o.marketKind === 'spot') k.pass('liquidation_distance', 'not applicable to a spot order');
  else if (lim.minLiquidationDistanceBps === undefined) k.fail('liquidation_distance', MISSING);
  else if (after === null || refHigh === null) k.fail('liquidation_distance', NO_PRICE, null, lim.minLiquidationDistanceBps);
  else if (D.isZero(after)) k.pass('liquidation_distance', 'no position remains after the order', null, lim.minLiquidationDistanceBps);
  else {
    const side = D.isPos(after) ? 'long' as const : 'short' as const, mode = o.marginMode ?? pos?.marginMode ?? 'cross';
    const instMax = D.from(inst.maxLeverage);
    const mmf = ctx.maintenanceMarginFraction !== undefined ? D.from(ctx.maintenanceMarginFraction) : D.isPos(instMax) ? D.div(D.one, D.mul(TWO, instMax), SCALE, 'up') : null;
    const account = venueAccounts[0];
    let liq: { value: Dec | null; method: string } | null = null, why = '';
    if (mmf === null) why = 'the maintenance margin fraction is not known';
    else if (mode === 'isolated') {
      if (levStr === null) why = 'the leverage of the isolated position is not known';
      else liq = liquidationPriceAtLeverage({ side, entryPrice: refHigh, leverage: D.from(levStr), maintenanceFraction: mmf });
    } else if (venueAccounts.length !== 1 || account === undefined) why = `exactly one account on ${o.venue} is needed to estimate a cross-margin liquidation price`;
    else liq = liquidationPriceCross({ side, size: D.abs(after), entryPrice: refHigh, accountCollateral: D.from(account.equity), maintenanceFraction: mmf });
    if (liq === null) k.fail('liquidation_distance', why, null, lim.minLiquidationDistanceBps);
    else if (liq.value === null) k.pass('liquidation_distance', `no liquidation price (${liq.method})`, 'none', lim.minLiquidationDistanceBps);
    else {
      const wrongSide = side === 'long' ? D.gte(liq.value, refHigh) : D.lte(liq.value, refHigh), dist = D.abs(D.sub(refHigh, liq.value));
      const tooClose = wrongSide || D.lt(D.mul(dist, D.from(10000n)), D.mul(D.from(lim.minLiquidationDistanceBps), refHigh));
      k.add('liquidation_distance', !tooClose, wrongSide ? `already past the estimate ${D.str(liq.value)}` : bpsStr(ratioBps(dist, refHigh)), lim.minLiquidationDistanceBps,
        `${tooClose ? 'the estimated liquidation price is too close' : 'the estimated liquidation price is far enough'}: ${D.str(D.div(liq.value, D.one, 10, 'half_even'))} (${liq.method})`);
    }
  }

  // ---- slippage and liquidity against the supplied book
  const triggered = o.type === 'stop' || o.type === 'take_profit';
  const book = ctx.book, bookOk = book !== null && book.instrument === o.instrument && lim.maxBookAgeMs !== undefined && Math.abs(ctx.now - book.ts) <= lim.maxBookAgeMs;
  const bestBid = book?.bids[0]?.[0], bestAsk = book?.asks[0]?.[0];
  const mid = bestBid !== undefined && bestAsk !== undefined ? D.div(D.add(D.from(bestBid), D.from(bestAsk)), TWO, SCALE, 'half_even') : null;
  const bookWhy = book === null ? 'no order book was supplied' : book.instrument !== o.instrument ? 'the order book is for another instrument' : lim.maxBookAgeMs === undefined ? 'no maximum age is configured for the order book: denied'
    : !bookOk ? `the order book is ${ctx.now - book.ts} ms old (limit ${lim.maxBookAgeMs})` : mid === null || !D.isPos(mid) ? 'the order book has an empty side' : size === null ? 'the size of the order cannot be derived' : null;
  const levels = book === null ? [] : o.side === 'buy' ? book.asks : book.bids;
  if (triggered) k.pass('slippage', 'not estimated: the order executes at a future trigger; its own maxSlippageBps bounds it then', null, lim.maxSlippageBps ?? null);
  else if (lim.maxSlippageBps === undefined) k.fail('slippage', MISSING);
  else if (bookWhy !== null || mid === null || size === null) k.fail('slippage', bookWhy ?? 'the order book cannot be read', null, lim.maxSlippageBps);
  else {
    const cap = D.min(D.from(lim.maxSlippageBps), D.from(BigInt(o.maxSlippageBps)));
    const w = walkBook(levels, size, o.side, o.limitPrice === null ? null : D.from(o.limitPrice));
    if (o.type === 'market' && w.stoppedBy !== 'filled') k.fail('slippage', `the supplied book fills only ${D.str(w.filled)} of ${D.str(size)}`, null, D.str(cap));
    else if (w.avg === null) k.pass('slippage', 'nothing would execute now: the limit order rests', '0', D.str(cap));
    else {
      const diff = o.side === 'buy' ? D.sub(w.avg, mid) : D.sub(mid, w.avg), cost = D.max(diff, D.zero), bad = exceedsBps(cost, mid, cap);
      k.add('slippage', !bad, bpsStr(ratioBps(cost, mid)), D.str(cap), bad ? 'the estimated slippage against the book exceeds the limit' : 'the estimated slippage against the book is within the limit');
    }
  }
  if (triggered) k.pass('min_liquidity', 'not estimated: the order executes at a future trigger');
  else if (lim.minLiquidity === undefined) k.fail('min_liquidity', MISSING);
  else if (bookWhy !== null || mid === null || size === null) k.fail('min_liquidity', bookWhy ?? 'the order book cannot be read');
  else {
    // depth within X bps of the mid on the taking side: price ≤ mid · (1 + X/10000) for asks, ≥ mid · (1 − X/10000) for bids — cross-multiplied
    const x = D.from(lim.minLiquidity.withinBps), tenK = D.from(10000n);
    const bound = o.side === 'buy' ? D.mul(mid, D.add(tenK, x)) : D.mul(mid, D.sub(tenK, x));
    let depth = D.zero;
    for (const [p, s] of levels) { const px = D.mul(D.from(p), tenK); if (o.side === 'buy' ? D.lte(px, bound) : D.gte(px, bound)) depth = D.add(depth, D.from(s)); }
    const need = D.mul(D.from(lim.minLiquidity.multiple), size), ok = D.gte(depth, need);
    k.add('min_liquidity', ok, D.str(depth), D.str(need), ok ? `depth within ${lim.minLiquidity.withinBps} bps of the mid covers ${lim.minLiquidity.multiple} × the order` : `depth within ${lim.minLiquidity.withinBps} bps of the mid is below ${lim.minLiquidity.multiple} × the order`);
  }
  return finish(k, reducing, derived);
}

function finish(k: Collector, reducing: boolean, derived: RiskEvaluation['derived']): RiskEvaluation {
  const checks = k.sorted();
  return { decision: checks.every((x) => x.ok) ? 'allow' : 'deny', checks, reducing, derived };
}

/** `evaluate` under a name that does not collide in a file that also imports the derivatives risk engine */
export const evaluateRisk = evaluate;

/** the catalogue of checks as Markdown (embedded in docs/V11-RISK-MODEL.md; a test compares) */
export function renderRiskChecks(): string {
  const applies = (r: ReducingRule) => (r === 'always' ? 'yes' : r === 'no_limit_price' ? 'only without a limit price' : 'no (exempt)');
  return ['| Check | Limit | Inputs | Rule | Applied to a strictly reducing order |', '|---|---|---|---|---|',
    ...RISK_CHECKS.map((c) => `| \`${c.id}\` | ${c.limit === '—' ? '—' : `\`${c.limit}\``} | ${c.inputs} | ${c.rule} | ${applies(c.reducing)} |`)].join('\n');
}

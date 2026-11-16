import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, liquidationPriceCross } from '@spw/derivatives';
import {
  canonicalOrder, evaluate, evaluateRisk, REDUCING_ORDER_CHECKS, renderRiskChecks, RISK_CHECK_IDS, RISK_CHECKS, RiskLimitsSchema,
  type CanonicalOrderInput, type RiskCheckId, type RiskEvaluation, type RiskLimits, type TradingRiskContext,
} from '../src/index.ts';
import { book, BTC, context, limits, NOW, order, position } from './fixtures.ts';

const ev = (o: Partial<CanonicalOrderInput> = {}, c: Partial<TradingRiskContext> = {}, l: Partial<RiskLimits> = {}): RiskEvaluation => evaluate({ kind: 'order', order: canonicalOrder(order(o)) }, context(c), limits(l));
const failed = (r: RiskEvaluation): RiskCheckId[] => r.checks.filter((x) => !x.ok).map((x) => x.id);
const check = (r: RiskEvaluation, id: RiskCheckId) => r.checks.find((x) => x.id === id)!;
const longPos = (over = {}) => [{ venue: 'hyperliquid', account: '0xabc', asset: 'BTC', position: position(over) }];
/** a reduce-only sell of 0.2 against the 0.5 long */
const closeOrder = (over: Partial<CanonicalOrderInput> = {}): Partial<CanonicalOrderInput> => ({ side: 'sell', size: '0.2', reduceOnly: true, limitPrice: '49990', ...over });

describe('risk engine — the base case', () => {
  const r = ev();
  it('allows an order inside every limit and reports every check', () => {
    expect(failed(r)).toEqual([]);
    expect(r.decision).toBe('allow');
    expect(r.reducing).toBe(false);
    expect(r.checks.map((x) => x.id)).toEqual([...RISK_CHECK_IDS]);
    expect(r.checks.every((x) => !x.exempt && typeof x.detail === 'string' && x.detail.length > 0)).toBe(true);
  });
  it('derives the size, the notional and the reference price', () => {
    // valued at the highest of the fresh marks (50 010), the limit (50 000): 0.1 × 50 010
    expect(r.derived).toEqual({ size: '0.1', notional: '5001', referencePrice: '50010', positionBefore: '0', positionAfter: '0.1' });
    expect(check(r, 'order_notional')).toMatchObject({ observed: '5001', limit: '10000' });
    expect(check(r, 'position_size')).toMatchObject({ observed: '5001', limit: '40000' });
    expect(check(r, 'price_consistency')).toMatchObject({ observed: '2', limit: '20' });            // (50 010 − 50 000) / 50 000 = 2 bps
    expect(check(r, 'slippage')).toMatchObject({ observed: '0', limit: '30' });                      // a buy limited at 50 000 crosses nothing (best ask 50 005)
  });
  it('is deterministic and does not touch its inputs', () => {
    const c = context(), l = limits(), o = canonicalOrder(order()), snap = JSON.stringify([c, l, o]);
    expect(evaluate({ kind: 'order', order: o }, c, l)).toEqual(evaluate({ kind: 'order', order: o }, c, l));
    expect(JSON.stringify([c, l, o])).toBe(snap);
    expect(evaluateRisk).toBe(evaluate);
  });
  it('turns a notional into a size at the lowest fresh price, rounded up', () => {
    const n = ev({ size: null, notional: '5000' });
    expect(n.derived.size).toBe('0.1'); expect(n.decision).toBe('allow');
    expect(D.gte(D.from(ev({ size: null, notional: '5001' }).derived.size!), D.from('0.10002'))).toBe(true);
  });
});

describe('risk engine — every limit is explicit', () => {
  const keys = Object.keys(RiskLimitsSchema.shape) as (keyof RiskLimits)[];
  const expected: Record<keyof RiskLimits, RiskCheckId[]> = {
    allowedVenues: ['venue_allowed'], allowedInstruments: ['instrument_allowed'], maxPositionNotional: ['position_size'], maxOrderLeverage: ['order_leverage'], maxAccountLeverage: ['account_leverage'],
    maxDailyLoss: ['daily_loss'], maxTotalLoss: ['total_loss'], maxDrawdownBps: ['drawdown'], maxGrossExposure: ['gross_exposure'], maxNetExposure: ['net_exposure'], maxAssetExposure: ['asset_exposure'],
    maxVenueExposure: ['venue_exposure'], maxVenueCollateralShareBps: ['collateral_concentration'], minLiquidationDistanceBps: ['liquidation_distance'], maxSlippageBps: ['slippage'],
    // without a maximum age no price is usable: everything that needs a price fails with it
    maxPriceAgeMs: ['price_freshness', 'price_consistency', 'order_notional', 'daily_notional', 'position_size', 'account_leverage', 'gross_exposure', 'net_exposure', 'asset_exposure', 'venue_exposure', 'liquidation_distance'],
    maxBookAgeMs: ['slippage', 'min_liquidity'], minPriceSources: ['price_freshness'], maxSourceDeviationBps: ['price_consistency'], maxOrdersPerMinute: ['order_rate_minute'], maxOrdersPerHour: ['order_rate_hour'],
    maxOrdersPerDay: ['order_rate_day'], maxOrderNotional: ['order_notional'], maxDailyNotional: ['daily_notional'], minLiquidity: ['min_liquidity'],
  };
  it('the test names every limit of the schema', () => { expect(Object.keys(expected).sort()).toEqual([...keys].sort()); });
  it.each(keys)('a missing %s denies', (key) => {
    const l = limits(); delete l[key];
    const r = evaluate({ kind: 'order', order: canonicalOrder(order()) }, context(), l);
    expect(r.decision).toBe('deny');
    expect(failed(r)).toEqual(expected[key]);
  });
  it('no limits at all: denied, with every limit-bearing check failed', () => {
    const r = evaluate({ kind: 'order', order: canonicalOrder(order()) }, context(), {});
    expect(r.decision).toBe('deny');
    expect(failed(r).length).toBeGreaterThanOrEqual(20);
    expect(r.checks.filter((x) => !x.ok && /no limit is configured/.test(x.detail)).length).toBeGreaterThanOrEqual(18);
  });
  it('a per-key limit without a default does not cover another key', () => {
    expect(failed(ev({}, {}, { maxAssetExposure: { per: { ETH: '50000' } } }))).toEqual(['asset_exposure']);
    expect(failed(ev({}, {}, { maxPositionNotional: { per: { 'hyperliquid:ETH': '1' } } }))).toEqual(['position_size']);
    expect(failed(ev({}, {}, { maxPositionNotional: { per: { 'hyperliquid:BTC': '6000' }, default: '1' } }))).toEqual([]);
    expect(failed(ev({}, {}, { maxPriceAgeMs: { per: { coinbase: 10_000 } } }))).toContain('price_freshness');           // the 'hyperliquid' source has no maximum age
  });
  it('unknown limit names and malformed limits are refused', () => {
    expect(evaluate({ kind: 'order', order: canonicalOrder(order()) }, context(), { ...limits(), maxEverything: '1' } as RiskLimits)).toMatchObject({ decision: 'deny', checks: [{ id: 'input_valid', ok: false }] });
    expect(evaluate({ kind: 'order', order: canonicalOrder(order()) }, context(), { ...limits(), maxOrderNotional: 'Infinity' })).toMatchObject({ decision: 'deny', checks: [{ id: 'input_valid' }] });
  });
});

describe('risk engine — each check', () => {
  const cases: [string, RiskCheckId[], Partial<CanonicalOrderInput>, Partial<TradingRiskContext>, Partial<RiskLimits>][] = [
    ['read-only mode', ['read_only'], {}, { readOnly: true }, {}],
    ['kill switch', ['kill_switch'], {}, { killSwitch: true }, {}],
    ['venue outside the allow-list', ['venue_allowed'], {}, {}, { allowedVenues: ['gmx'] }],
    ['instrument outside the allow-list', ['instrument_allowed'], {}, {}, { allowedInstruments: ['hyperliquid:ETH'] }],
    ['instrument halted', ['instrument_status'], {}, { instrument: { ...BTC, status: 'halted' } }, {}],
    ['instrument in reduce-only status', ['instrument_status'], {}, { instrument: { ...BTC, status: 'reduce_only' } }, {}],
    ['signer unreachable', ['signer_status'], {}, { signer: { reachable: false, halted: false } }, {}],
    ['signer halted', ['signer_status'], {}, { signer: { reachable: true, halted: true } }, {}],
    ['venue connection down', ['venue_connection'], {}, { connections: { hyperliquid: { connected: false } } }, {}],
    ['venue connection unknown', ['venue_connection'], {}, { connections: {} }, {}],
    ['order notional', ['order_notional'], {}, {}, { maxOrderNotional: '5000' }],
    ['daily notional', ['daily_notional'], {}, { usage: { ordersLastMinute: 0, ordersLastHour: 0, ordersToday: 0, notionalToday: '45000' } }, {}],
    ['orders per minute', ['order_rate_minute'], {}, { usage: { ordersLastMinute: 5, ordersLastHour: 5, ordersToday: 5, notionalToday: '0' } }, {}],
    ['orders per hour', ['order_rate_hour'], {}, { usage: { ordersLastMinute: 0, ordersLastHour: 50, ordersToday: 50, notionalToday: '0' } }, {}],
    ['orders per day', ['order_rate_day'], {}, { usage: { ordersLastMinute: 0, ordersLastHour: 0, ordersToday: 200, notionalToday: '0' } }, {}],
    ['position size', ['position_size'], {}, {}, { maxPositionNotional: { per: { 'hyperliquid:BTC': '5000.99' }, default: '40000' } }],
    ['order leverage above the limit', ['order_leverage'], { leverage: '6' }, {}, {}],
    ['order leverage above the venue maximum', ['order_leverage'], { leverage: '50' }, {}, { maxOrderLeverage: '100' }],
    ['unknown leverage', ['order_leverage'], { leverage: null }, {}, {}],
    ['account leverage', ['account_leverage'], {}, {}, { maxAccountLeverage: '0.05' }],
    ['gross exposure', ['gross_exposure'], {}, {}, { maxGrossExposure: '5000' }],
    ['net exposure', ['net_exposure'], {}, {}, { maxNetExposure: '5000' }],
    ['asset exposure', ['asset_exposure'], {}, {}, { maxAssetExposure: { per: { BTC: '5000' } } }],
    ['venue exposure', ['venue_exposure'], {}, {}, { maxVenueExposure: { per: { hyperliquid: '5000' }, default: '60000' } }],
    ['collateral concentration', ['collateral_concentration'], {}, {}, { maxVenueCollateralShareBps: '1999' }],              // 20 000 of 100 000 = 2000 bps
    ['daily loss reached', ['daily_loss'], {}, { pnl: { realizedToday: '-600', unrealizedToday: '-400', realizedInception: '0', unrealizedInception: '0' } }, {}],
    ['total loss reached', ['total_loss'], {}, { pnl: { realizedToday: '0', unrealizedToday: '0', realizedInception: '-4000', unrealizedInception: '-1000' } }, {}],
    ['drawdown reached', ['drawdown'], {}, { equity: { current: '90000', peak: '100000' } }, {}],
    ['liquidation too close', ['liquidation_distance'], { size: '1', limitPrice: '50000' }, { accounts: [{ venue: 'hyperliquid', account: '0xabc', equity: '3000', collateral: '3000', freeCollateral: '3000', marginUsed: '0', ts: NOW }] },
      { maxOrderNotional: '100000', maxDailyNotional: '100000', maxAssetExposure: { per: { BTC: '100000' } }, maxPositionNotional: { per: {}, default: '100000' }, minLiquidity: { withinBps: '10', multiple: '1' } }],
    ['slippage against the book', ['slippage'], { type: 'market', limitPrice: null, size: '5', tif: 'ioc' }, {},
      { maxSlippageBps: '2', maxOrderNotional: '1000000', maxPositionNotional: { per: {}, default: '1000000' }, maxAccountLeverage: '10', maxGrossExposure: '1000000', maxNetExposure: '1000000', maxAssetExposure: { per: { BTC: '1000000' } },
        maxVenueExposure: { per: {}, default: '1000000' }, maxDailyNotional: '1000000', minLiquidity: { withinBps: '100', multiple: '1' }, minLiquidationDistanceBps: '0' }],
    ['thin book', ['min_liquidity'], {}, {}, { minLiquidity: { withinBps: '1', multiple: '11' } }],                             // 1 BTC within 1 bps of the mid vs 11 × 0.1
    ['one stale source of two required', ['price_freshness'], {}, { marks: [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '50000', ts: NOW - 1000 }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '50010', ts: NOW - 10_001 }] }, {}],
    ['a price from the future', ['price_freshness'], {}, { marks: [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '50000', ts: NOW + 5_001 }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '50010', ts: NOW }] }, {}],
    ['sources that disagree', ['price_consistency'], {}, { marks: [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '50000', ts: NOW }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '50101', ts: NOW }] }, {}],
    ['a stale book', ['slippage', 'min_liquidity'], {}, { book: book({ ts: NOW - 5_001 }) }, {}],
    ['no book', ['slippage', 'min_liquidity'], {}, { book: null }, {}],
    ['a book with an empty side', ['slippage', 'min_liquidity'], {}, { book: book({ bids: [] }) }, {}],
    ['a book for another instrument', ['slippage', 'min_liquidity'], {}, { book: book({ instrument: 'hyperliquid:ETH' }) }, {}],
  ];
  it.each(cases)('%s → exactly %j fails', (_n, ids, o, c, l) => {
    const r = ev(o, c, l);
    expect(failed(r)).toEqual(ids);
    expect(r.decision).toBe('deny');
  });
  it('limits are inclusive: at the limit passes, one step above fails', () => {
    expect(ev({}, {}, { maxOrderNotional: '5001' }).decision).toBe('allow');
    expect(failed(ev({}, {}, { maxOrderNotional: '5000.999999' }))).toEqual(['order_notional']);
    expect(ev({}, {}, { maxVenueCollateralShareBps: '2000' }).decision).toBe('allow');
    expect(ev({}, { usage: { ordersLastMinute: 4, ordersLastHour: 49, ordersToday: 199, notionalToday: '44999' } }).decision).toBe('allow');
  });
  it('loss and drawdown limits deny when REACHED, pass just before', () => {
    expect(ev({}, { pnl: { realizedToday: '-999.99', unrealizedToday: '0', realizedInception: '-4999.99', unrealizedInception: '0' } }).decision).toBe('allow');
    expect(failed(ev({}, { pnl: { realizedToday: '-1000', unrealizedToday: '0', realizedInception: '0', unrealizedInception: '0' } }))).toEqual(['daily_loss']);
    expect(ev({}, { equity: { current: '90000.01', peak: '100000' } }).decision).toBe('allow');
    expect(ev({}, { equity: { current: '120000', peak: '100000' } }).decision).toBe('allow');                                   // above the peak: no drawdown
    expect(failed(ev({}, { equity: { current: '100000', peak: '0' } }))).toEqual(['drawdown']);
  });
  it('equity ≤ 0 denies any exposure', () => {
    const r = ev({}, { equity: { current: '0', peak: '100000' } });
    expect(failed(r)).toEqual(expect.arrayContaining(['account_leverage', 'collateral_concentration', 'drawdown']));
    expect(check(r, 'account_leverage').observed).toMatch(/equity ≤ 0/);
  });
  it('paper orders need neither the signer nor the venue connection', () => {
    const r = ev({ mode: 'paper' }, { signer: { reachable: false, halted: true }, connections: {} });
    expect(r.decision).toBe('allow');
    expect(check(r, 'signer_status').detail).toMatch(/not applicable/);
  });
  it('the order\'s own slippage bound tightens the limit', () => {
    const big = { maxOrderNotional: '1000000', maxPositionNotional: { per: {}, default: '1000000' }, maxDailyNotional: '1000000', maxAccountLeverage: '10', maxGrossExposure: '1000000', maxNetExposure: '1000000',
      maxAssetExposure: { per: { BTC: '1000000' } }, maxVenueExposure: { per: {}, default: '1000000' }, minLiquidity: { withinBps: '100', multiple: '1' }, minLiquidationDistanceBps: '0' };
    // market buy of 3 BTC walks 50 005, 50 010, 50 015: average 50 010 vs mid 50 000 = 2 bps
    const ok = ev({ type: 'market', limitPrice: null, size: '3', tif: 'ioc', maxSlippageBps: 50 }, {}, big);
    expect(check(ok, 'slippage')).toMatchObject({ ok: true, observed: '2', limit: '30' });
    const tight = ev({ type: 'market', limitPrice: null, size: '3', tif: 'ioc', maxSlippageBps: 1 }, {}, big);
    expect(check(tight, 'slippage')).toMatchObject({ ok: false, observed: '2', limit: '1' });
  });
  it('a market order the book cannot fill is denied', () => {
    const r = ev({ type: 'market', limitPrice: null, size: '11', tif: 'ioc' });
    expect(check(r, 'slippage')).toMatchObject({ ok: false }); expect(check(r, 'slippage').detail).toMatch(/fills only 10 of 11/);
  });
  it('trigger orders are not priced against today\'s book', () => {
    const r = ev({ type: 'stop', triggerPrice: '50500', limitPrice: null });
    expect(check(r, 'slippage')).toMatchObject({ ok: true }); expect(check(r, 'min_liquidity').detail).toMatch(/future trigger/);
    expect(r.derived.notional).toBe('5050');                                                                                     // valued at the trigger, the highest price named
  });
  it('liquidation distance uses the margin engine of @spw/derivatives', () => {
    const acct = [{ venue: 'hyperliquid', account: '0xabc', equity: '3000', collateral: '3000', freeCollateral: '3000', marginUsed: '0', ts: NOW }];
    const r = ev({ size: '1' }, { accounts: acct }, { maxOrderNotional: '100000', maxPositionNotional: { per: {}, default: '100000' }, minLiquidity: { withinBps: '10', multiple: '1' } });
    const liq = liquidationPriceCross({ side: 'long', size: D.from('1'), entryPrice: D.from('50010'), accountCollateral: D.from('3000'), maintenanceFraction: D.div(D.one, D.from(80n), 18, 'up') }).value!;
    expect(check(r, 'liquidation_distance').detail).toContain(D.str(D.div(liq, D.one, 10, 'half_even')));
    // isolated at 3x: about 3 200 bps away → passes a 1 000 bps minimum
    expect(check(ev({ marginMode: 'isolated' }), 'liquidation_distance')).toMatchObject({ ok: true });
    expect(check(ev({ marginMode: 'isolated', leverage: '5' }, {}, { minLiquidationDistanceBps: '2500' }), 'liquidation_distance')).toMatchObject({ ok: false });
    // cross with two accounts on the venue: the estimate is not defined → denied
    expect(failed(ev({}, { accounts: [...context().accounts, { ...context().accounts[0]!, account: '0xdef' }] }))).toContain('liquidation_distance');
  });
  it('aggregates exposure per asset across venues, with the caller\'s normalization', () => {
    const gmx = { venue: 'gmx', account: '0xabc', asset: 'BTC', position: position({ instrument: 'gmx:BTC-USD', size: '0.8', markPrice: '50000' }) };
    const eth = { venue: 'gmx', account: '0xabc', asset: 'ETH', position: position({ instrument: 'gmx:ETH-USD', size: '10', markPrice: '2500' }) };
    const r = ev({}, { positions: [gmx, eth] });
    expect(check(r, 'asset_exposure')).toMatchObject({ observed: '45001', limit: '50000', ok: true });                          // 40 000 on GMX + 5 001 on Hyperliquid
    expect(check(r, 'gross_exposure').observed).toBe('70001');
    expect(check(r, 'venue_exposure').observed).toBe('5001');
    expect(failed(ev({ size: '0.2' }, { positions: [gmx] }, { maxOrderNotional: '20000' }))).toEqual(['asset_exposure']);                                      // 40 000 + 10 002 > 50 000
    // a short elsewhere hedges the asset: net falls, gross does not
    const hedge = { venue: 'gmx', account: '0xabc', asset: 'BTC', position: position({ instrument: 'gmx:BTC-USD', side: 'short', size: '0.8', markPrice: '50000' }) };
    const h = ev({}, { positions: [hedge] });
    expect(check(h, 'asset_exposure').observed).toBe('34999'); expect(check(h, 'gross_exposure').observed).toBe('45001'); expect(check(h, 'net_exposure').observed).toBe('34999');
  });
});

describe('risk engine — reducing orders', () => {
  it('reducing is decided from the positions, not from the flag', () => {
    expect(ev(closeOrder(), { positions: longPos() }).reducing).toBe(true);
    expect(ev(closeOrder({ size: '0.5' }), { positions: longPos() }).reducing).toBe(true);                                      // closes it exactly
    // the flag alone, with no position: not reducing, and refused as an invalid reduce-only
    const noPos = ev(closeOrder());
    expect(noPos.reducing).toBe(false); expect(failed(noPos)).toContain('reduce_only_valid');
    // an opposite order WITHOUT the flag is not strictly reducing (several resting ones could flip the position)
    expect(ev(closeOrder({ reduceOnly: false }), { positions: longPos() }).reducing).toBe(false);
    // a position on another venue or instrument does not count
    expect(ev(closeOrder(), { positions: [{ venue: 'gmx', account: '0xabc', asset: 'BTC', position: position({ instrument: 'gmx:BTC-USD' }) }] }).reducing).toBe(false);
  });
  it('a reduce-only order that would flip or increase is denied', () => {
    const flip = ev(closeOrder({ size: '0.501' }), { positions: longPos() });
    expect(flip.reducing).toBe(false); expect(check(flip, 'reduce_only_valid')).toMatchObject({ ok: false }); expect(check(flip, 'reduce_only_valid').detail).toMatch(/flip/);
    const inc = ev({ reduceOnly: true }, { positions: longPos() });
    expect(check(inc, 'reduce_only_valid').detail).toMatch(/open or increase/); expect(inc.decision).toBe('deny');
    expect(ev({ side: 'buy', size: '0.2', reduceOnly: true, limitPrice: '50010' }, { positions: longPos({ side: 'short' }) }).reducing).toBe(true);
  });
  it('passes the kill switch, every exposure, loss and rate limit, a halted signer and a missing allow-list', () => {
    const hostile: Partial<TradingRiskContext> = { positions: longPos(), killSwitch: true, signer: { reachable: false, halted: true }, connections: {}, book: null,
      pnl: { realizedToday: '-99999', unrealizedToday: '-99999', realizedInception: '-99999', unrealizedInception: '-99999' }, equity: { current: '-5', peak: '100000' },
      usage: { ordersLastMinute: 999, ordersLastHour: 999, ordersToday: 999, notionalToday: '99999999' }, instrument: { ...BTC, status: 'reduce_only' }, marks: [] };
    const r = evaluate({ kind: 'order', order: canonicalOrder(order(closeOrder())) }, context(hostile), {});
    expect(r).toMatchObject({ decision: 'allow', reducing: true });
    expect(r.checks.filter((x) => !x.exempt).map((x) => x.id)).toEqual(['input_valid', 'read_only', 'reduce_only_valid']);
    expect(r.checks.filter((x) => x.exempt).every((x) => x.ok)).toBe(true);
  });
  it('stays subject to exactly the documented checks', () => {
    expect(REDUCING_ORDER_CHECKS).toEqual(['input_valid', 'read_only', 'reduce_only_valid', 'price_freshness', 'price_consistency']);
    expect(RISK_CHECKS.filter((c) => c.reducing === 'no_limit_price').map((c) => c.id)).toEqual(['price_freshness', 'price_consistency']);
  });
  it('without a limit price it needs fresh, consistent prices (its bound is derived from them); with one it does not', () => {
    const market = closeOrder({ type: 'market', limitPrice: null, tif: 'ioc' });
    expect(ev(market, { positions: longPos(), killSwitch: true })).toMatchObject({ decision: 'allow', reducing: true });
    const stale = [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '50000', ts: NOW - 60_000 }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '50010', ts: NOW }];
    expect(failed(ev(market, { positions: longPos(), marks: stale }))).toEqual(['price_freshness']);
    const split = [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '50000', ts: NOW }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '51000', ts: NOW }];
    expect(failed(ev(market, { positions: longPos(), marks: split }))).toEqual(['price_consistency']);
    expect(ev(closeOrder(), { positions: longPos(), marks: split }).decision).toBe('allow');
    expect(ev(closeOrder(), { positions: longPos(), marks: stale }).decision).toBe('allow');
    expect(failed(evaluate({ kind: 'order', order: canonicalOrder(order(market)) }, context({ positions: longPos() }), {}))).toEqual(['price_freshness', 'price_consistency']);
  });
  it('read-only mode blocks it; only a cancel passes', () => {
    const r = ev(closeOrder(), { positions: longPos(), readOnly: true });
    expect(r).toMatchObject({ decision: 'deny', reducing: true }); expect(failed(r)).toEqual(['read_only']);
  });
  it('a reduce-only order given as a notional is sized cautiously', () => {
    // 0.5 BTC at 50 000 (lowest price) = 25 000: a notional of 25 000 is exactly the position; 25 001 could exceed it
    expect(ev(closeOrder({ size: null, notional: '25000' }), { positions: longPos() }).reducing).toBe(true);
    expect(ev(closeOrder({ size: null, notional: '25001' }), { positions: longPos() }).reducing).toBe(false);
    expect(ev(closeOrder({ size: null, notional: '100' }), { positions: longPos(), marks: [] })).toMatchObject({ reducing: false, decision: 'deny' });
  });
});

describe('risk engine — cancel, kill switch, read-only', () => {
  const cancel = { kind: 'cancel' as const, venue: 'hyperliquid', clientOrderId: '0xabc' };
  it('a cancel passes everything, with no limit and in any mode', () => {
    const r = evaluate(cancel, context({ killSwitch: true, readOnly: true, instrument: null, asset: null, signer: { reachable: false, halted: true } }), {});
    expect(r).toMatchObject({ decision: 'allow', reducing: true });
    expect(r.checks).toEqual([expect.objectContaining({ id: 'input_valid', ok: true })]);
  });
  it('a malformed cancel is refused', () => { expect(evaluate({ kind: 'cancel', venue: '', clientOrderId: 'x' }, context(), limits()).decision).toBe('deny'); });
  it('the kill switch blocks every order that adds risk, on any venue and in any mode', () => {
    for (const o of [{}, { mode: 'paper' as const }, { side: 'sell' as const }, { type: 'market' as const, limitPrice: null }, { size: '0.001' }]) {
      const r = ev(o, { killSwitch: true });
      expect(r.decision).toBe('deny'); expect(failed(r)).toContain('kill_switch');
    }
  });
});

describe('risk engine — spot', () => {
  const spotInst = { ...BTC, venue: 'kyberswap', symbol: 'WETH-USDC', id: 'kyberswap:WETH-USDC', base: 'WETH', quote: 'USDC', kind: 'spot' as const, maxLeverage: '1' };
  const spot: Partial<CanonicalOrderInput> = { venue: 'kyberswap', network: 'base', instrument: 'kyberswap:WETH-USDC', marketKind: 'spot', leverage: null, marginMode: null, size: '1', limitPrice: '2500' };
  const sctx: Partial<TradingRiskContext> = { instrument: spotInst, asset: 'ETH', marks: [{ instrument: 'kyberswap:WETH-USDC', source: 'coinbase', price: '2500', ts: NOW }, { instrument: 'kyberswap:WETH-USDC', source: 'kraken', price: '2501', ts: NOW }],
    book: { instrument: 'kyberswap:WETH-USDC', bids: [['2499', '100']], asks: [['2501', '100']], ts: NOW }, connections: { kyberswap: { connected: true } },
    accounts: [{ venue: 'kyberswap', account: 'vault-1', equity: '10000', collateral: '10000', freeCollateral: '10000', marginUsed: '0', ts: NOW }] };
  const slim: Partial<RiskLimits> = { allowedVenues: ['kyberswap'], allowedInstruments: ['kyberswap:WETH-USDC'], maxAssetExposure: { per: { ETH: '50000' } }, maxPriceAgeMs: { per: {}, default: 5000 } };
  it('a spot buy passes; leverage and liquidation do not apply', () => {
    const r = ev(spot, sctx, slim);
    expect(failed(r)).toEqual([]);
    expect(check(r, 'order_leverage').detail).toMatch(/not applicable/); expect(check(r, 'liquidation_distance').detail).toMatch(/not applicable/);
  });
  it('a spot sell must be covered by a holding supplied as a long position', () => {
    expect(failed(ev({ ...spot, side: 'sell' }, sctx, slim))).toContain('input_valid');
    const held = [{ venue: 'kyberswap', account: 'vault-1', asset: 'ETH', position: position({ instrument: 'kyberswap:WETH-USDC', size: '2', markPrice: '2500', leverage: '1' }) }];
    const r = ev({ ...spot, side: 'sell' }, { ...sctx, positions: held }, slim);
    expect(failed(r)).toEqual([]); expect(r.reducing).toBe(false); expect(r.derived.positionAfter).toBe('1');
    expect(failed(ev({ ...spot, side: 'sell', size: '2.5' }, { ...sctx, positions: held }, slim))).toContain('input_valid');
  });
  it('a market kind that is not the instrument\'s is refused', () => { expect(ev(spot, { ...sctx, instrument: { ...spotInst, kind: 'perpetual' } }, slim).checks[0]).toMatchObject({ id: 'input_valid', ok: false }); });
});

describe('risk engine — fails closed', () => {
  it('on a context for another instrument, duplicate positions, or unreadable values', () => {
    expect(ev({ instrument: 'hyperliquid:ETH' }).checks).toEqual([expect.objectContaining({ id: 'input_valid', ok: false })]);
    expect(ev({}, { positions: [...longPos(), ...longPos()] }).decision).toBe('deny');
    expect(ev({}, { instrument: null }).decision).toBe('deny');
    expect(ev({}, { equity: { current: 'NaN', peak: '1' } }).decision).toBe('deny');
    expect(ev({}, { now: -1 }).decision).toBe('deny');
    expect(evaluate({ kind: 'order', order: { ...canonicalOrder(order()), size: '-1' } }, context(), limits()).decision).toBe('deny');
    expect(evaluate({ kind: 'transfer' } as never, context(), limits()).decision).toBe('deny');
    expect(evaluate(null as never, context(), limits()).decision).toBe('deny');
    expect(evaluate({ kind: 'order', order: canonicalOrder(order()) }, null as never, limits()).decision).toBe('deny');
  });
  it('a non-positive price is not a price', () => {
    const r = ev({}, { marks: [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '0', ts: NOW }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '50010', ts: NOW }] });
    expect(failed(r)).toEqual(['price_freshness']);
  });
  it('property: arbitrary garbage never yields "allow"', () => {
    fc.assert(fc.property(fc.anything(), fc.anything(), fc.anything(), (a, b, c) => {
      const r = evaluate(a as never, b as never, c as never);
      expect(r.decision).toBe('deny');
    }), { numRuns: 300 });
  });
});

describe('risk engine — properties', () => {
  const amount = fc.integer({ min: 1, max: 5_000_000 }).map((n) => D.str(D.div(D.from(BigInt(n)), D.from(1000n), 3, 'down')));
  const price = fc.integer({ min: 40_000, max: 60_000 }).map(String);
  const ctxArb = fc.record({
    killSwitch: fc.boolean(), posSize: amount, posSide: fc.constantFrom('long' as const, 'short' as const), equity: fc.integer({ min: -1000, max: 1_000_000 }).map(String), mark: price,
    age: fc.integer({ min: 0, max: 20_000 }), lossToday: fc.integer({ min: -5000, max: 100 }).map(String), orders: fc.integer({ min: 0, max: 400 }), hasPos: fc.boolean(), signerOk: fc.boolean(),
  });
  type Ctx = typeof ctxArb extends fc.Arbitrary<infer T> ? T : never;
  const build = (x: Ctx): TradingRiskContext => context({
    killSwitch: x.killSwitch, positions: x.hasPos ? [{ venue: 'hyperliquid', account: '0xabc', asset: 'BTC', position: position({ side: x.posSide, size: x.posSize, markPrice: x.mark }) }] : [],
    equity: { current: x.equity, peak: '1000000' }, marks: [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: x.mark, ts: NOW - x.age }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: x.mark, ts: NOW - x.age }],
    pnl: { realizedToday: x.lossToday, unrealizedToday: '0', realizedInception: x.lossToday, unrealizedInception: '0' }, usage: { ordersLastMinute: x.orders, ordersLastHour: x.orders, ordersToday: x.orders, notionalToday: '0' },
    signer: { reachable: x.signerOk, halted: !x.signerOk },
  });
  const ordArb = fc.record({ side: fc.constantFrom('buy' as const, 'sell' as const), size: amount, reduceOnly: fc.boolean(), limitPrice: price });

  it('a limit reduce-only order no larger than the opposite position is always allowed outside read-only mode — whatever the limits', () => {
    fc.assert(fc.property(ctxArb, amount, fc.boolean(), (x, frac, noLimits) => {
      const c = build({ ...x, hasPos: true });
      const size = D.str(D.min(D.from(frac), D.from(x.posSize)));
      const o = canonicalOrder(order({ side: x.posSide === 'long' ? 'sell' : 'buy', size, reduceOnly: true, limitPrice: x.mark }));
      const r = evaluate({ kind: 'order', order: o }, c, noLimits ? {} : limits());
      expect(r.reducing).toBe(true); expect(r.decision).toBe('allow');
    }), { numRuns: 300 });
  });
  it('with the kill switch on, nothing that is not strictly reducing is allowed; in read-only mode nothing is', () => {
    fc.assert(fc.property(ctxArb, ordArb, fc.boolean(), (x, o, ro) => {
      const c = { ...build(x), killSwitch: true, readOnly: ro };
      const r = evaluate({ kind: 'order', order: canonicalOrder(order(o)) }, c, limits());
      if (r.decision === 'allow') { expect(r.reducing).toBe(true); expect(ro).toBe(false); }
    }), { numRuns: 400 });
  });
  it('`reducing` equals: reduce-only, opposite to the position, and no larger than it', () => {
    fc.assert(fc.property(ctxArb, ordArb, (x, o) => {
      const r = evaluate({ kind: 'order', order: canonicalOrder(order(o)) }, build(x), limits());
      const opposite = x.hasPos && (x.posSide === 'long' ? o.side === 'sell' : o.side === 'buy');
      expect(r.reducing).toBe(o.reduceOnly && opposite && D.lte(D.from(o.size), D.from(x.posSize)));
      if (o.reduceOnly && !r.reducing) expect(r.decision).toBe('deny');
    }), { numRuns: 400 });
  });
  it('removing a limit never turns a denial into an allowance, and never allows an order that adds risk', () => {
    const keys = Object.keys(RiskLimitsSchema.shape) as (keyof RiskLimits)[];
    fc.assert(fc.property(ctxArb, ordArb, fc.subarray(keys, { minLength: 1 }), (x, o, drop) => {
      const c = build(x), req = { kind: 'order' as const, order: canonicalOrder(order(o)) };
      const full = evaluate(req, c, limits()), l = limits();
      for (const k of drop) delete l[k];
      const less = evaluate(req, c, l);
      if (full.decision === 'deny') expect(less.decision).toBe('deny');
      if (!less.reducing) expect(less.decision).toBe('deny');
    }), { numRuns: 400 });
  });
  it('tightening a numeric limit never turns a denial into an allowance', () => {
    const numeric = ['maxOrderNotional', 'maxGrossExposure', 'maxNetExposure', 'maxDailyNotional', 'maxDailyLoss', 'maxTotalLoss', 'maxAccountLeverage', 'maxOrderLeverage', 'maxSlippageBps', 'maxDrawdownBps'] as const;
    fc.assert(fc.property(ctxArb, ordArb, fc.constantFrom(...numeric), (x, o, key) => {
      const c = build(x), req = { kind: 'order' as const, order: canonicalOrder(order(o)) };
      const loose = evaluate(req, c, limits()), l = limits();
      l[key] = D.str(D.div(D.from(l[key]!), D.from(2n), 6, 'down'));
      if (l[key] === '0' && (key === 'maxAccountLeverage' || key === 'maxOrderLeverage')) return;
      const tight = evaluate(req, c, l);
      if (loose.decision === 'deny') expect(tight.decision).toBe('deny');
    }), { numRuns: 300 });
  });
  it('every evaluation is deterministic and lists each check at most once, in the catalogue\'s order', () => {
    fc.assert(fc.property(ctxArb, ordArb, (x, o) => {
      const c = build(x), req = { kind: 'order' as const, order: canonicalOrder(order(o)) };
      const a = evaluate(req, c, limits());
      expect(a).toEqual(evaluate(req, c, limits()));
      const ids = a.checks.map((k) => k.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(RISK_CHECK_IDS.filter((id) => ids.includes(id)));
      expect(a.decision).toBe(a.checks.every((k) => k.ok) ? 'allow' : 'deny');
    }), { numRuns: 200 });
  });
});

describe('risk engine — catalogue', () => {
  it('describes every check id exactly once, in order', () => { expect(RISK_CHECKS.map((c) => c.id)).toEqual([...RISK_CHECK_IDS]); });
  it('renders one row per check', () => { const md = renderRiskChecks(); for (const id of RISK_CHECK_IDS) expect(md).toContain(`\`${id}\``); expect(md.split('\n')).toHaveLength(RISK_CHECK_IDS.length + 2); });
});

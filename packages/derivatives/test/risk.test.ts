import { describe, expect, it } from 'vitest';
import {
  checkOrder, RISK_CODES, RiskPolicySchema,
  type AccountState, type Book, type Instrument, type Order, type OrderRequest, type Position, type RiskCode, type RiskContext, type RiskPolicy, type RiskResult, type Ticker,
} from '../src/index.ts';

const ID = 'hyperliquid:BTC';
const NOW = 1_700_000_000_000;

const instrument: Instrument = {
  venue: 'hyperliquid', symbol: 'BTC', id: ID, base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: 'USDC',
  tickSize: '1', lotSize: '0.001', minOrderSize: '0.001', minNotional: '10', maxLeverage: '50', marginModes: ['cross', 'isolated'],
  fundingIntervalSec: 3600, markPriceMethod: 'oracle median', status: 'active',
};
const ticker: Ticker = { instrument: ID, mark: '60000', index: '60000', mid: '60000', funding: '0.00001', openInterest: null, volume24h: null, change24h: null, ts: NOW - 500 };
const book: Book = { instrument: ID, bids: [['59999', '5']], asks: [['60001', '5']], ts: NOW - 500 };
const account: AccountState = { venue: 'hyperliquid', account: '0xabc', equity: '10000', collateral: '10000', freeCollateral: '10000', marginUsed: '0', maintenanceMargin: '0', withdrawable: '10000', ts: NOW - 500, source: 'venue' };

/** the policy under test: every limit is binding somewhere below */
const policy: RiskPolicy = {
  mode: 'PAPER', allowedInstruments: [ID], halt: null, maxDataAgeMs: 5000, maxDeviationBps: '100', maxMarkIndexBps: '50', maxLeverage: '5',
  maxOrderNotional: '20000', maxGrossExposure: '40000', maxPositionNotional: '30000', minFreeCollateral: '1000', minLiquidationDistanceBps: '500',
  maxDailyLoss: '500', maxTotalLoss: '2000', maxOrdersPerMinute: 10, maxOrdersPerDay: 100,
};
/** a policy with every limit out of the way, to isolate one rule */
const loose: RiskPolicy = {
  ...policy, maxDeviationBps: '5000', maxMarkIndexBps: '5000', maxLeverage: '1000', maxOrderNotional: '1000000000', maxGrossExposure: '1000000000',
  maxPositionNotional: '1000000000', minFreeCollateral: '0', minLiquidationDistanceBps: '0', maxDailyLoss: '1000000000', maxTotalLoss: '1000000000',
  maxOrdersPerMinute: 1000000, maxOrdersPerDay: 1000000,
};

const order = (o: Partial<OrderRequest> = {}): OrderRequest => ({ instrument: ID, side: 'buy', type: 'limit', size: '0.1', price: '60000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'c-1', ...o });
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  instrument, account, positions: [], openOrders: [], book, ticker, now: NOW,
  usage: { realizedToday: '0', realizedTotal: '0', ordersLastMinute: 0, ordersToday: 0 }, ...o,
});
const position = (o: Partial<Position> = {}): Position => ({
  instrument: ID, side: 'long', size: '0.5', entryPrice: '60000', markPrice: '60000', liquidationPrice: null, leverage: '5', marginMode: 'cross',
  margin: '6000', unrealizedPnl: '0', realizedPnl: null, fundingPaid: null, source: 'venue', ...o,
});
const eth = (o: Partial<Position> = {}): Position => position({ instrument: 'hyperliquid:ETH', size: '10', entryPrice: '2500', markPrice: '2500', margin: '5000', ...o });

const ok = (r: RiskResult): void => { expect(r).toEqual({ ok: true }); };
const refused = (r: RiskResult, code: RiskCode): void => {
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.code).toBe(code); expect(r.reason.length).toBeGreaterThan(5); }
};

describe('risk: policy schema', () => {
  it('accepts the policy and rejects malformed ones', () => {
    expect(RiskPolicySchema.parse(policy)).toEqual(policy);
    for (const bad of [{ ...policy, mode: 'LIVE' }, { ...policy, maxLeverage: '0' }, { ...policy, maxLeverage: 5 }, { ...policy, maxDailyLoss: '-1' }, { ...policy, maxOrderNotional: '1e6' },
      { ...policy, halt: undefined }, { ...policy, maxDataAgeMs: 1.5 }, { ...policy, allowedInstruments: 'all' }]) {
      expect(RiskPolicySchema.safeParse(bad).success).toBe(false);
    }
    expect(new Set(RISK_CODES).size).toBe(RISK_CODES.length);
  });

  it('refuses when the policy, the order or the context cannot be read (fail closed)', () => {
    refused(checkOrder({ ...policy, maxLeverage: 'x' } as RiskPolicy, order(), ctx()), 'bad_policy');
    refused(checkOrder(policy, order({ size: '1e-1' }), ctx()), 'bad_order');
    refused(checkOrder(policy, order({ size: '0' }), ctx()), 'bad_order');
    refused(checkOrder(policy, order({ price: '0' }), ctx()), 'bad_order');
    refused(checkOrder(policy, order({ triggerPrice: '59000' }), ctx()), 'bad_order');
    refused(checkOrder(policy, order(), ctx({ ticker: { ...ticker, mark: 'abc' } })), 'bad_input');
    refused(checkOrder(policy, order(), ctx({ account: { ...account, equity: 'NaN' } })), 'bad_input');
    refused(checkOrder(policy, order(), ctx({ now: Number.NaN })), 'bad_input');
    refused(checkOrder(policy, order(), ctx({ ticker: { ...ticker, mark: '0' } })), 'bad_mark');
  });
});

describe('risk: one test per rule (accepted just inside, refused just outside)', () => {
  it('baseline order is accepted', () => { ok(checkOrder(policy, order(), ctx())); });

  it('1 — mode', () => {
    refused(checkOrder({ ...policy, mode: 'READ_ONLY' }, order(), ctx()), 'mode_read_only');
    for (const mode of ['PAPER', 'MANUAL_LIVE', 'MANDATE_LIVE'] as const) ok(checkOrder({ ...policy, mode }, order(), ctx()));
  });

  it('1 — circuit breaker', () => {
    refused(checkOrder({ ...policy, halt: 'daily loss breaker' }, order(), ctx()), 'halted');
    const r = checkOrder({ ...policy, halt: 'daily loss breaker' }, order(), ctx());
    expect(!r.ok && r.reason).toMatch(/daily loss breaker/);
    // a halt stops new risk, not the way out: a reduce-only order that reduces still passes, one that does not is refused
    expect(checkOrder({ ...policy, halt: 'venue down' }, order({ side: 'sell', reduceOnly: true }), ctx({ positions: [position()] })).ok).toBe(true);
    expect(checkOrder({ ...policy, halt: 'venue down' }, order({ side: 'sell', reduceOnly: true }), ctx()).ok).toBe(false);
  });

  it('2 — instrument allowed and active', () => {
    refused(checkOrder({ ...policy, allowedInstruments: ['hyperliquid:ETH'] }, order(), ctx()), 'instrument_not_allowed');
    refused(checkOrder({ ...policy, allowedInstruments: [] }, order(), ctx()), 'instrument_not_allowed');
    refused(checkOrder(policy, order({ instrument: 'hyperliquid:ETH' }), ctx()), 'instrument_mismatch');
    refused(checkOrder(policy, order(), ctx({ instrument: { ...instrument, status: 'halted' } })), 'instrument_halted');
    // reduce_only instrument: opening is refused, reducing is accepted (flagged or not)
    const ro = { ...instrument, status: 'reduce_only' as const };
    refused(checkOrder(policy, order(), ctx({ instrument: ro })), 'instrument_reduce_only');
    ok(checkOrder(policy, order({ side: 'sell', size: '0.2', reduceOnly: true }), ctx({ instrument: ro, positions: [position()] })));
    ok(checkOrder(policy, order({ side: 'sell', size: '0.2' }), ctx({ instrument: ro, positions: [position({ size: '0.3' })] })));
    refused(checkOrder(policy, order({ side: 'buy', size: '0.1' }), ctx({ instrument: ro, positions: [position({ size: '0.3' })] })), 'instrument_reduce_only');
  });

  it('3 — data age (stale price)', () => {
    ok(checkOrder(policy, order(), ctx({ ticker: { ...ticker, ts: NOW - 5000 } })));
    refused(checkOrder(policy, order(), ctx({ ticker: { ...ticker, ts: NOW - 5001 } })), 'stale_ticker');
    ok(checkOrder(policy, order(), ctx({ book: { ...book, ts: NOW - 5000 } })));
    refused(checkOrder(policy, order(), ctx({ book: { ...book, ts: NOW - 5001 } })), 'stale_book');
    // data from the future beyond the tolerance is not trusted either
    refused(checkOrder(policy, order(), ctx({ ticker: { ...ticker, ts: NOW + 5001 } })), 'stale_ticker');
    refused(checkOrder(policy, order(), ctx({ ticker: { ...ticker, instrument: 'hyperliquid:ETH' } })), 'data_mismatch');
    refused(checkOrder(policy, order(), ctx({ book: { ...book, instrument: 'hyperliquid:ETH' } })), 'data_mismatch');
  });

  it('4 — price within maxDeviationBps of the mark (excessive slippage bound)', () => {
    // 100 bps of 60 000 = 600
    ok(checkOrder(policy, order({ price: '60600' }), ctx()));
    refused(checkOrder(policy, order({ price: '60601' }), ctx()), 'price_deviation');
    ok(checkOrder(policy, order({ side: 'sell', price: '59400', reduceOnly: true }), ctx({ positions: [position()] })));
    refused(checkOrder(policy, order({ side: 'sell', price: '59399', reduceOnly: true }), ctx({ positions: [position()] })), 'price_deviation');
    // a market order must carry its worst price, and that bound is checked the same way
    refused(checkOrder(policy, order({ type: 'market', tif: 'ioc', price: null }), ctx()), 'price_required');
    ok(checkOrder(policy, order({ type: 'market', tif: 'ioc', price: '60300' }), ctx()));
    refused(checkOrder(policy, order({ type: 'market', tif: 'ioc', price: '63000' }), ctx()), 'price_deviation');
  });

  it('4 — trigger orders: the price is compared with the trigger', () => {
    const pos = [position()];
    const stop = (o: Partial<OrderRequest>) => order({ side: 'sell', type: 'stop_limit', reduceOnly: true, size: '0.5', triggerPrice: '57000', price: '56900', ...o });
    ok(checkOrder(policy, stop({}), ctx({ positions: pos })));
    // 100 bps of 57 000 = 570
    ok(checkOrder(policy, stop({ price: '56430' }), ctx({ positions: pos })));
    refused(checkOrder(policy, stop({ price: '56429' }), ctx({ positions: pos })), 'price_deviation');
    refused(checkOrder(policy, stop({ triggerPrice: null }), ctx({ positions: pos })), 'trigger_required');
    refused(checkOrder(policy, stop({ type: 'take_profit_market', triggerPrice: null }), ctx({ positions: pos })), 'trigger_required');
  });

  it('4 — mark within maxMarkIndexBps of the index', () => {
    // 50 bps of 60 000 = 300
    ok(checkOrder(policy, order({ price: '60300' }), ctx({ ticker: { ...ticker, mark: '60300' } })));
    refused(checkOrder(policy, order({ price: '60301' }), ctx({ ticker: { ...ticker, mark: '60301' } })), 'mark_index_divergence');
    ok(checkOrder(policy, order({ price: '59700' }), ctx({ ticker: { ...ticker, mark: '59700' } })));
    refused(checkOrder(policy, order({ price: '59699' }), ctx({ ticker: { ...ticker, mark: '59699' } })), 'mark_index_divergence');
    // no index published: the check is skipped
    ok(checkOrder(policy, order({ price: '60301' }), ctx({ ticker: { ...ticker, mark: '60301', index: null } })));
  });

  it('5 — tick, lot, minimum size, minimum notional', () => {
    const half = { ...instrument, tickSize: '0.5' };
    ok(checkOrder(policy, order({ price: '60000.5' }), ctx({ instrument: half })));
    refused(checkOrder(policy, order({ price: '60000.3' }), ctx({ instrument: half })), 'price_not_on_tick');
    refused(checkOrder(policy, order({ price: '60000.5' }), ctx()), 'price_not_on_tick');
    refused(checkOrder(policy, order({ side: 'sell', type: 'stop_market', triggerPrice: '59000.5', price: '58900', reduceOnly: true }), ctx({ positions: [position()] })), 'price_not_on_tick');
    ok(checkOrder(policy, order({ size: '0.101' }), ctx()));
    refused(checkOrder(policy, order({ size: '0.1005' }), ctx()), 'size_not_on_lot');
    const fine = { ...instrument, lotSize: '0.0001' };
    ok(checkOrder(policy, order({ size: '0.001' }), ctx({ instrument: fine })));
    refused(checkOrder(policy, order({ size: '0.0009' }), ctx({ instrument: fine })), 'below_min_size');
    // 0.001 · 60 000 = 60
    ok(checkOrder(policy, order({ size: '0.001' }), ctx({ instrument: { ...instrument, minNotional: '60' } })));
    refused(checkOrder(policy, order({ size: '0.001' }), ctx({ instrument: { ...instrument, minNotional: '60.01' } })), 'below_min_notional');
    ok(checkOrder(policy, order({ size: '0.001' }), ctx({ instrument: { ...instrument, minOrderSize: null, minNotional: null } })));
  });

  it('6 — leverage after the order', () => {
    // equity 10 000, limit 5x → gross ≤ 50 000 ; 0.833 · 60 000 = 49 980 ; 0.834 · 60 000 = 50 040
    const p = { ...loose, maxLeverage: '5' };
    ok(checkOrder(p, order({ size: '0.833' }), ctx({ leverage: '50' })));
    refused(checkOrder(p, order({ size: '0.834' }), ctx({ leverage: '50' })), 'leverage_exceeded');
    // other positions count: 10 ETH · 2 500 = 25 000 → BTC up to 25 000 = 0.416 (24 960) ; 0.417 = 25 020
    ok(checkOrder(p, order({ size: '0.416' }), ctx({ leverage: '50', positions: [eth()] })));
    refused(checkOrder(p, order({ size: '0.417' }), ctx({ leverage: '50', positions: [eth()] })), 'leverage_exceeded');
    // no equity: nothing may be opened
    refused(checkOrder(p, order({ size: '0.001' }), ctx({ account: { ...account, equity: '0' } })), 'leverage_exceeded');
  });

  it('7 — notional per order', () => {
    // 0.333 · 60 000 = 19 980 ; 0.334 · 60 000 = 20 040 ; limit 20 000
    ok(checkOrder(policy, order({ size: '0.333' }), ctx()));
    refused(checkOrder(policy, order({ size: '0.334' }), ctx()), 'order_notional_exceeded');
    // the order is valued at its price when that is above the mark: 0.333 · 60 100 = 20 013.3
    refused(checkOrder(policy, order({ size: '0.333', price: '60100' }), ctx()), 'order_notional_exceeded');
  });

  it('8 — resulting gross exposure (limit exceeded)', () => {
    // ETH 25 000 already there ; limit 40 000 → BTC up to 15 000 = 0.25 ; 0.251 = 15 060
    ok(checkOrder(policy, order({ size: '0.25' }), ctx({ positions: [eth()] })));
    refused(checkOrder(policy, order({ size: '0.251' }), ctx({ positions: [eth()] })), 'gross_exposure_exceeded');
    // a short adds to gross exposure just the same
    refused(checkOrder(policy, order({ side: 'sell', size: '0.251' }), ctx({ positions: [eth()] })), 'gross_exposure_exceeded');
  });

  it('9 — resulting position per instrument', () => {
    // long 0.4 (24 000) ; limit 30 000 → +0.1 = 30 000 ; +0.101 = 30 060
    const pos = [position({ size: '0.4' })];
    ok(checkOrder(policy, order({ size: '0.1' }), ctx({ positions: pos })));
    refused(checkOrder(policy, order({ size: '0.101' }), ctx({ positions: pos })), 'position_notional_exceeded');
    // a flip is judged on the position it leaves: long 0.4, sell 0.9 → short 0.5 = 30 000 ; sell 0.901 → 30 060
    const p = { ...policy, maxOrderNotional: '100000' };
    ok(checkOrder(p, order({ side: 'sell', size: '0.9' }), ctx({ positions: pos })));
    refused(checkOrder(p, order({ side: 'sell', size: '0.901' }), ctx({ positions: pos })), 'position_notional_exceeded');
  });

  it('10 — free collateral after initial margin (insufficient collateral)', () => {
    // 0.1 · 60 000 / 5x = 1 200 of initial margin ; minimum free collateral 1 000
    ok(checkOrder(policy, order(), ctx({ account: { ...account, freeCollateral: '2200' } })));
    refused(checkOrder(policy, order(), ctx({ account: { ...account, freeCollateral: '2199.99' } })), 'insufficient_collateral');
    // the leverage setting of the instrument changes the margin: at 2x it is 3 000
    ok(checkOrder(policy, order(), ctx({ leverage: '2', account: { ...account, freeCollateral: '4000' } })));
    refused(checkOrder(policy, order(), ctx({ leverage: '2', account: { ...account, freeCollateral: '3999' } })), 'insufficient_collateral');
    // an order that only reduces needs no margin, even unflagged
    ok(checkOrder(policy, order({ side: 'sell', size: '0.2' }), ctx({ positions: [position({ size: '0.4' })], account: { ...account, freeCollateral: '1000' } })));
  });

  it('11 — estimated liquidation distance', () => {
    // cross, single position, maintenance 1 %: long 0.5 @ 60 000 (30 000) on equity E liquidates at (30 000 − E) / (0.5 · 0.99)
    //   E = 1 785    → 28 215 / 0.495 = 57 000 → distance 3 000 / 60 000 = 500 bps exactly → accepted
    //   E = 1 784.99 → 28 215.01 / 0.495 = 57 000.02… → below 500 bps → refused
    const p = { ...loose, minLiquidationDistanceBps: '500' };
    const c = (equity: string) => ctx({ leverage: '50', maintenanceMarginFraction: '0.01', account: { ...account, equity, freeCollateral: equity } });
    ok(checkOrder(p, order({ size: '0.5' }), c('1785')));
    refused(checkOrder(p, order({ size: '0.5' }), c('1784.99')), 'liquidation_too_close');
    // short: (30 000 + E) / (0.5 · 1.01) ; E = 1 815 → 31 815 / 0.505 = 63 000 → 500 bps exactly
    ok(checkOrder(p, order({ side: 'sell', size: '0.5' }), c('1815')));
    refused(checkOrder(p, order({ side: 'sell', size: '0.5' }), c('1814.99')), 'liquidation_too_close');
    // default maintenance fraction = 1 / (2 · maxLeverage) = 1 % for a 50x instrument: same boundary
    ok(checkOrder(p, order({ size: '0.5' }), ctx({ leverage: '50', account: { ...account, equity: '1785', freeCollateral: '1785' } })));
    refused(checkOrder(p, order({ size: '0.5' }), ctx({ leverage: '50', account: { ...account, equity: '1784.99', freeCollateral: '1784.99' } })), 'liquidation_too_close');
    // isolated position: long 0.5 with 3 000 of margin, +0.5 at 20x adds 1 500 → 1.0 @ 60 000 with 4 500:
    //   (60 000 − 4 500) / 0.99 = 56 060.6… → 656 bps → accepted at 500, refused at 700
    const iso = [position({ marginMode: 'isolated', margin: '3000', leverage: '20' })];
    ok(checkOrder(p, order({ size: '0.5' }), ctx({ positions: iso, maintenanceMarginFraction: '0.01' })));
    refused(checkOrder({ ...p, minLiquidationDistanceBps: '700' }, order({ size: '0.5' }), ctx({ positions: iso, maintenanceMarginFraction: '0.01' })), 'liquidation_too_close');
  });

  it('12 — daily loss', () => {
    const u = (realizedToday: string) => ({ realizedToday, realizedTotal: '0', ordersLastMinute: 0, ordersToday: 0 });
    ok(checkOrder(policy, order(), ctx({ usage: u('-499.99') })));
    refused(checkOrder(policy, order(), ctx({ usage: u('-500') })), 'daily_loss_exceeded');
    // unrealized PnL counts: −400 realised and −100 unrealised reach the limit
    const losing = [position({ size: '0.1', unrealizedPnl: '-100' })];
    refused(checkOrder(policy, order(), ctx({ usage: u('-400'), positions: losing })), 'daily_loss_exceeded');
    ok(checkOrder(policy, order(), ctx({ usage: u('-399.99'), positions: losing })));
    ok(checkOrder(policy, order(), ctx({ usage: u('-600'), positions: [position({ size: '0.1', unrealizedPnl: '100.01' })] })));
  });

  it('13 — total loss', () => {
    const u = (realizedTotal: string) => ({ realizedToday: '0', realizedTotal, ordersLastMinute: 0, ordersToday: 0 });
    ok(checkOrder(policy, order(), ctx({ usage: u('-1999.99') })));
    refused(checkOrder(policy, order(), ctx({ usage: u('-2000') })), 'total_loss_exceeded');
  });

  it('14 — order rate', () => {
    const u = (ordersLastMinute: number, ordersToday: number) => ({ realizedToday: '0', realizedTotal: '0', ordersLastMinute, ordersToday });
    ok(checkOrder(policy, order(), ctx({ usage: u(9, 99) })));
    refused(checkOrder(policy, order(), ctx({ usage: u(10, 50) })), 'order_rate_minute');
    refused(checkOrder(policy, order(), ctx({ usage: u(5, 100) })), 'order_rate_day');
    refused(checkOrder(policy, order(), ctx({ usage: u(1.5, 0) })), 'bad_input');
  });

  it('15 — duplicate clientId', () => {
    const open: Order = { ...order({ clientId: 'dup', price: '59000' }), venueOrderId: '1', status: 'open', filled: '0', avgFillPrice: null, createdAt: NOW, updatedAt: NOW, rejectReason: null };
    refused(checkOrder(policy, order({ clientId: 'dup' }), ctx({ openOrders: [open] })), 'duplicate_client_id');
    ok(checkOrder(policy, order({ clientId: 'other' }), ctx({ openOrders: [open] })));
    refused(checkOrder(policy, order({ clientId: 'old' }), ctx({ usage: { realizedToday: '0', realizedTotal: '0', ordersLastMinute: 0, ordersToday: 0, clientIds: ['old'] } })), 'duplicate_client_id');
  });
});

describe('risk: reduce-only', () => {
  /** an account in bad shape: every exposure and loss limit is already exceeded */
  const stressed = (o: Partial<RiskContext> = {}): RiskContext => ctx({
    positions: [position({ size: '2', unrealizedPnl: '-5000' }), eth({ size: '40' })],     // BTC 120 000 + ETH 100 000 of exposure
    account: { ...account, equity: '100', freeCollateral: '-4000' },
    usage: { realizedToday: '-900', realizedTotal: '-9000', ordersLastMinute: 0, ordersToday: 0 },
    maintenanceMarginFraction: '0.01',
    ...o,
  });
  const reduce = (o: Partial<OrderRequest> = {}): OrderRequest => order({ side: 'sell', size: '0.5', reduceOnly: true, ...o });

  it('an order that really reduces stays possible when exposure and loss limits are exceeded', () => {
    ok(checkOrder(policy, reduce(), stressed()));
    ok(checkOrder(policy, reduce({ size: '2' }), stressed()));                                   // full close
    ok(checkOrder(policy, reduce({ type: 'market', tif: 'ioc', price: '59500' }), stressed()));
    // the same order without the flag is judged like any other
    refused(checkOrder(policy, reduce({ reduceOnly: false }), stressed()), 'leverage_exceeded');
    // and so is an opening order
    refused(checkOrder(policy, order({ size: '0.001' }), stressed()), 'leverage_exceeded');
  });

  it('each exposure and loss limit is skipped for a reducing reduce-only order, enforced otherwise', () => {
    const pos = [position({ size: '0.4' })];
    const sell = (reduceOnly: boolean) => order({ side: 'sell', size: '0.1', reduceOnly });
    const cases: [RiskCode, RiskPolicy, Partial<RiskContext>][] = [
      ['leverage_exceeded', { ...loose, maxLeverage: '1' }, { positions: pos, account: { ...account, equity: '100' } }],
      ['order_notional_exceeded', { ...loose, maxOrderNotional: '100' }, { positions: pos }],
      ['gross_exposure_exceeded', { ...loose, maxGrossExposure: '100' }, { positions: pos }],
      ['position_notional_exceeded', { ...loose, maxPositionNotional: '100' }, { positions: pos }],
      ['insufficient_collateral', { ...loose, minFreeCollateral: '100' }, { positions: pos, account: { ...account, freeCollateral: '50' } }],
      ['liquidation_too_close', { ...loose, minLiquidationDistanceBps: '9000' }, { positions: pos, account: { ...account, equity: '2000' } }],
      ['daily_loss_exceeded', { ...loose, maxDailyLoss: '10' }, { positions: pos, usage: { realizedToday: '-50', realizedTotal: '0', ordersLastMinute: 0, ordersToday: 0 } }],
      ['total_loss_exceeded', { ...loose, maxTotalLoss: '10' }, { positions: pos, usage: { realizedToday: '0', realizedTotal: '-50', ordersLastMinute: 0, ordersToday: 0 } }],
    ];
    for (const [code, p, c] of cases) {
      refused(checkOrder(p, sell(false), ctx(c)), code);
      ok(checkOrder(p, sell(true), ctx(c)));
    }
  });

  it('a reduce-only order that would increase or flip the position is refused', () => {
    refused(checkOrder(policy, reduce({ size: '2.001' }), stressed()), 'reduce_only_would_flip');
    refused(checkOrder(policy, reduce({ side: 'buy' }), stressed()), 'reduce_only_would_increase');
    refused(checkOrder(policy, reduce(), ctx()), 'reduce_only_would_increase');                  // no position at all
    refused(checkOrder(policy, reduce({ side: 'buy' }), ctx({ positions: [position()] })), 'reduce_only_would_increase');
    ok(checkOrder(policy, reduce({ side: 'buy' }), ctx({ positions: [position({ side: 'short' })] })));
    refused(checkOrder(policy, reduce({ side: 'buy', size: '0.501' }), ctx({ positions: [position({ side: 'short' })] })), 'reduce_only_would_flip');
  });

  it('it must still pass data freshness, price sanity and tick/lot', () => {
    refused(checkOrder(policy, reduce(), stressed({ ticker: { ...ticker, ts: NOW - 60_000 } })), 'stale_ticker');
    refused(checkOrder(policy, reduce(), stressed({ book: { ...book, ts: NOW - 60_000 } })), 'stale_book');
    refused(checkOrder(policy, reduce({ price: '50000' }), stressed()), 'price_deviation');
    refused(checkOrder(policy, reduce(), stressed({ ticker: { ...ticker, mark: '61000' } })), 'price_deviation');
    refused(checkOrder(policy, reduce({ price: '60301' }), stressed({ ticker: { ...ticker, mark: '60301' } })), 'mark_index_divergence');
    refused(checkOrder(policy, reduce({ price: '60000.5' }), stressed()), 'price_not_on_tick');
    refused(checkOrder(policy, reduce({ size: '0.5005' }), stressed()), 'size_not_on_lot');
    refused(checkOrder(policy, reduce({ price: null }), stressed()), 'price_required');
    refused(checkOrder({ ...policy, mode: 'READ_ONLY' }, reduce(), stressed()), 'mode_read_only');
    refused(checkOrder(policy, reduce(), stressed({ instrument: { ...instrument, status: 'halted' } })), 'instrument_halted');
    // the order-rate budget does not block the way out; a duplicate client id still does
    expect(checkOrder(policy, reduce(), stressed({ usage: { realizedToday: '0', realizedTotal: '0', ordersLastMinute: 10, ordersToday: 10 } })).ok).toBe(true);
    refused(checkOrder(policy, reduce(), stressed({ usage: { realizedToday: '0', realizedTotal: '0', ordersLastMinute: 0, ordersToday: 0, clientIds: ['c-1'] } })), 'duplicate_client_id');
  });

  it('dust below the minimums can be closed in full, not in part', () => {
    const fine = { ...instrument, lotSize: '0.0001' };
    const dust = [position({ size: '0.0005' })];
    ok(checkOrder(policy, reduce({ size: '0.0005' }), ctx({ instrument: fine, positions: dust })));
    refused(checkOrder(policy, reduce({ size: '0.0002' }), ctx({ instrument: fine, positions: dust })), 'below_min_size');
    refused(checkOrder(policy, order({ size: '0.0005' }), ctx({ instrument: fine })), 'below_min_size');
  });
});

describe('risk: order of the checks', () => {
  it('reports the first failing rule in the documented order', () => {
    const everythingWrong: RiskContext = ctx({
      instrument: { ...instrument, status: 'halted' },
      ticker: { ...ticker, ts: NOW - 60_000, mark: '70000' }, book: { ...book, ts: NOW - 60_000 },
      account: { ...account, equity: '1', freeCollateral: '0' },
      usage: { realizedToday: '-9999', realizedTotal: '-9999', ordersLastMinute: 999, ordersToday: 999, clientIds: ['c-1'] },
    });
    const bad = order({ size: '5.0005', price: '60000.5' });
    const sequence: [RiskCode, RiskPolicy, RiskContext][] = [
      ['mode_read_only', { ...policy, mode: 'READ_ONLY', halt: 'x', allowedInstruments: [] }, everythingWrong],
      ['halted', { ...policy, halt: 'x', allowedInstruments: [] }, everythingWrong],
      ['instrument_not_allowed', { ...policy, allowedInstruments: [] }, everythingWrong],
      ['instrument_halted', policy, everythingWrong],
      ['stale_ticker', policy, { ...everythingWrong, instrument }],
      ['stale_book', policy, { ...everythingWrong, instrument, ticker: { ...ticker, mark: '70000' } }],
      ['price_deviation', policy, { ...everythingWrong, instrument, ticker: { ...ticker, mark: '70000' }, book }],
      ['mark_index_divergence', { ...policy, maxDeviationBps: '5000' }, { ...everythingWrong, instrument, ticker: { ...ticker, mark: '70000' }, book }],
      ['price_not_on_tick', policy, { ...everythingWrong, instrument, ticker, book }],
    ];
    for (const [code, p, c] of sequence) refused(checkOrder(p, bad, c), code);
    const c: RiskContext = { ...everythingWrong, instrument, ticker, book };
    refused(checkOrder(policy, order({ size: '5.0005' }), c), 'size_not_on_lot');
    refused(checkOrder(policy, order({ size: '5' }), c), 'leverage_exceeded');
    const rich: RiskContext = { ...c, account: { ...account, equity: '1000000', freeCollateral: '0' } };
    refused(checkOrder(policy, order({ size: '5' }), rich), 'order_notional_exceeded');
    refused(checkOrder({ ...policy, maxOrderNotional: '1000000' }, order({ size: '5' }), rich), 'gross_exposure_exceeded');
    refused(checkOrder({ ...policy, maxOrderNotional: '1000000', maxGrossExposure: '1000000' }, order({ size: '5' }), rich), 'position_notional_exceeded');
    refused(checkOrder(policy, order(), rich), 'insufficient_collateral');
    const funded: RiskContext = { ...rich, account: { ...account, equity: '6100', freeCollateral: '100000' } };
    // long 0.1 @ 60 000 on 6 100 of equity: margin covers the notional → no liquidation price → next rule
    refused(checkOrder(policy, order(), funded), 'daily_loss_exceeded');
    refused(checkOrder({ ...policy, maxDailyLoss: '100000' }, order(), funded), 'total_loss_exceeded');
    refused(checkOrder({ ...policy, maxDailyLoss: '100000', maxTotalLoss: '100000' }, order(), funded), 'order_rate_minute');
    refused(checkOrder({ ...policy, maxDailyLoss: '100000', maxTotalLoss: '100000', maxOrdersPerMinute: 1000 }, order(), funded), 'order_rate_day');
    refused(checkOrder({ ...policy, maxDailyLoss: '100000', maxTotalLoss: '100000', maxOrdersPerMinute: 1000, maxOrdersPerDay: 1000 }, order(), funded), 'duplicate_client_id');
    ok(checkOrder({ ...policy, maxDailyLoss: '100000', maxTotalLoss: '100000', maxOrdersPerMinute: 1000, maxOrdersPerDay: 1000 }, order({ clientId: 'fresh' }), funded));
  });

  it('is pure: same inputs, same answer, inputs untouched', () => {
    const c = ctx({ positions: [position()] });
    const before = JSON.stringify([policy, order(), c]);
    const a = checkOrder(policy, order(), c), b = checkOrder(policy, order(), c);
    expect(a).toEqual(b);
    expect(JSON.stringify([policy, order(), c])).toBe(before);
  });
});

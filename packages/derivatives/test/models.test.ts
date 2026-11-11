import { describe, expect, it } from 'vitest';
import {
  AccountStateSchema, BookSchema, CandleSchema, DecStrSchema, FillSchema, FundingPaymentSchema, InstrumentSchema, OrderRequestSchema, OrderSchema,
  PositionSchema, PublicTradeSchema, TickerSchema, VenueError, VENUE_ERROR_CODES,
  type Capabilities, type Instrument, type Order, type OrderRequest, type VenueAdapter,
} from '../src/index.ts';

const instrument: Instrument = {
  venue: 'hyperliquid', symbol: 'BTC', id: 'hyperliquid:BTC', base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC',
  settlement: 'USDC, continuous', tickSize: '1', lotSize: '0.00001', minOrderSize: null, minNotional: '10', maxLeverage: '40',
  marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: 'median of oracle, book and CEX perps', status: 'active',
};
const request: OrderRequest = { instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.01', price: '60000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'c-1' };

describe('models', () => {
  it('DecStr accepts canonical decimals only', () => {
    for (const ok of ['0', '-0', '1', '-1.5', '0.001', '123456789.000000001', '9'.repeat(60)]) expect(DecStrSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '+1', '1e5', 'NaN', '.5', '1.', '01', ' 1', '1,5', '9'.repeat(61), 1, null, undefined, 1.5]) expect(DecStrSchema.safeParse(bad).success, String(bad)).toBe(false);
  });

  it('parses every model and strips unknown fields', () => {
    expect(InstrumentSchema.parse({ ...instrument, extra: 1 })).toEqual(instrument);
    expect(TickerSchema.parse({ instrument: 'hyperliquid:BTC', mark: '60000', index: null, mid: '60000.5', funding: '0.0000125', openInterest: '1000', volume24h: null, change24h: '-0.01', ts: 1 }).mark).toBe('60000');
    expect(BookSchema.parse({ instrument: 'hyperliquid:BTC', bids: [['59999', '1.5']], asks: [['60001', '2']], ts: 1 }).bids[0]).toEqual(['59999', '1.5']);
    expect(PublicTradeSchema.parse({ instrument: 'x', price: '1', size: '2', side: 'sell', ts: 1, id: 't' }).side).toBe('sell');
    expect(CandleSchema.parse({ ts: 0, open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' }).high).toBe('2');
    expect(AccountStateSchema.parse({ venue: 'dydx', account: 'dydx1abc/0', equity: '100', collateral: '100', freeCollateral: '90', marginUsed: '10', maintenanceMargin: null, withdrawable: null, ts: 5, source: 'venue' }).source).toBe('venue');
    expect(PositionSchema.parse({ instrument: 'x', side: 'short', size: '1', entryPrice: '2', markPrice: '2', liquidationPrice: null, leverage: '3', marginMode: 'isolated', margin: '1', unrealizedPnl: '-0.5', realizedPnl: null, fundingPaid: null, source: 'paper' }).side).toBe('short');
    expect(OrderRequestSchema.parse(request)).toEqual(request);
    const order: Order = { ...request, venueOrderId: null, status: 'pending', filled: '0', avgFillPrice: null, createdAt: 1, updatedAt: 1, rejectReason: null };
    expect(OrderSchema.parse(order)).toEqual(order);
    expect(FillSchema.parse({ instrument: 'x', orderId: null, clientId: null, side: 'buy', price: '1', size: '1', fee: '0.001', feeAsset: 'USDC', closedPnl: null, ts: 1, id: 'f', liquidation: false }).liquidation).toBe(false);
    expect(FundingPaymentSchema.parse({ instrument: 'x', amount: '-0.01', rate: '0.0001', size: '1', ts: 1 }).amount).toBe('-0.01');
  });

  it('rejects missing or mistyped fields', () => {
    const { tickSize: _t, ...noTick } = instrument;
    expect(InstrumentSchema.safeParse(noTick).success).toBe(false);
    expect(InstrumentSchema.safeParse({ ...instrument, tickSize: 0.5 }).success).toBe(false);
    expect(InstrumentSchema.safeParse({ ...instrument, id: 'dydx:BTC' }).success).toBe(false);
    expect(InstrumentSchema.safeParse({ ...instrument, kind: 'future' }).success).toBe(false);
    expect(InstrumentSchema.safeParse({ ...instrument, venue: 'binance' }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...request, size: '1e-2' }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...request, side: 'long' }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...request, tif: 'fok' }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...request, clientId: '' }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...request, price: undefined }).success).toBe(false);
    expect(BookSchema.safeParse({ instrument: 'x', bids: [['1']], asks: [], ts: 1 }).success).toBe(false);
    expect(BookSchema.safeParse({ instrument: 'x', bids: [[1, 2]], asks: [], ts: 1 }).success).toBe(false);
    expect(TickerSchema.safeParse({ instrument: 'x', mark: '1', ts: 1 }).success).toBe(false);
    expect(TickerSchema.safeParse({ instrument: 'x', mark: '1', index: null, mid: null, funding: null, openInterest: null, volume24h: null, change24h: null, ts: 1.5 }).success).toBe(false);
  });

  it('VenueError carries a code', () => {
    const e = new VenueError('bad_answer', 'missing field', { venue: 'hyperliquid', detail: { path: 'x' } });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(VenueError);
    expect(e.name).toBe('VenueError');
    expect(e.code).toBe('bad_answer');
    expect(e.venue).toBe('hyperliquid');
    expect(e.message).toBe('missing field');
    expect(new VenueError('stale', 'old').venue).toBeNull();
    expect([...VENUE_ERROR_CODES].sort()).toEqual(['bad_answer', 'rate_limited', 'rejected', 'stale', 'unavailable', 'unsupported']);
  });

  it('the venue contract is implementable (compile-time check)', () => {
    const capabilities: Capabilities = { marketData: true, account: false, orders: false, orderTypes: ['limit'], tif: ['gtc'], modify: false, leverage: false, marginModes: ['cross'], subaccounts: false, testnet: true, stream: false, notes: [] };
    const none = async (): Promise<never> => { throw new VenueError('unsupported', 'not implemented'); };
    const adapter: VenueAdapter = {
      id: 'hyperliquid', network: 'testnet', capabilities,
      instruments: async () => [instrument], tickers: none, book: none, trades: none, candles: none, fundingHistory: none,
      account: none, positions: none, openOrders: none, orderHistory: none, fills: none, funding: none,
    };
    expect(adapter.trading).toBeUndefined();
    return expect(adapter.tickers()).rejects.toMatchObject({ code: 'unsupported' });
  });
});

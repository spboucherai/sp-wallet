// V11 market making — the Hyperliquid primitives a quoting engine adds, against the OFFICIAL SDK:
//  A. every action shape (post-only batches, reduce-only batches, cancel batches by oid and by cloid, scheduleCancel with and
//     without a time, with and without expiresAfter) built by OUR builder equals, byte for byte and key for key, the action the
//     official Python SDK built; its hash equals the SDK's `action_hash`; the signature made over our typed data with the
//     vector's throwaway key equals the SDK's. Vectors: fixtures/hyperliquid/sdk-vectors-mm.json (generator next to it).
//  B. `describe` reads each of them back, and refuses anything smuggled into them.
//  C. rounding of quotes can only move a bid down and an ask up (property), and stays on the venue's grid.
//  D. reconciliation parsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { D } from '../../src/decimal.ts';
import {
  createHlTrading, hlAddressRateLimit, hlAddressRequests, hlBatchAnswer, hlExchangeWeight, hlFormatPrice, hlFormatSize, hlMeetsMinNotional, hlOrderErrorKind, hlOrderLookup, hlOrderStatus, hlRoundAsk, hlRoundBid,
  hlRoundQuote, hlRoundSize, l1ActionHash, l1SignPayload, type HlAsset, type HlL1SignPayload, type MsgpackValue,
} from '../../src/venues/hyperliquid/index.ts';
import type { Instrument, OrderRequest, SignRequest } from '../../src/index.ts';
import { raw, sameSig, signWith } from './helpers.ts';

interface Vector { name: string; action: any; vaultAddress: null; nonce: number; expiresAfter: number | null; network: 'mainnet' | 'testnet'; connectionId: string; signature: { r: string; s: string; v: number } }
const V = raw('sdk-vectors-mm.json') as { sdk: string; key: `0x${string}`; address: string; l1: Vector[] };

// the asset indices the generator used (a table of its own: the vectors are about encoding, not about a network's listing)
const ASSETS: HlAsset[] = [
  { symbol: 'BTC', asset: 0, szDecimals: 5, maxLeverage: 40, isolatedOnly: false, delisted: false }, { symbol: 'XONE', asset: 1, szDecimals: 4, maxLeverage: 25, isolatedOnly: false, delisted: false },
  { symbol: 'ETH', asset: 4, szDecimals: 4, maxLeverage: 25, isolatedOnly: false, delisted: false }, { symbol: 'SOL', asset: 5, szDecimals: 2, maxLeverage: 20, isolatedOnly: false, delisted: false },
];
const inst = (a: HlAsset): Instrument => ({ venue: 'hyperliquid', symbol: a.symbol, id: `hyperliquid:${a.symbol}`, base: a.symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0.1',
  lotSize: a.szDecimals === 0 ? '1' : `0.${'0'.repeat(a.szDecimals - 1)}1`, minOrderSize: null, minNotional: '10', maxLeverage: String(a.maxLeverage), marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' });
const byAsset = (n: number) => inst(ASSETS.find((a) => a.asset === n)!);
const tradingFor = (v: Vector) => createHlTrading({ network: v.network, assets: ASSETS, expiresAfterMs: v.expiresAfter === null ? null : v.expiresAfter - v.nonce, describeScheduleCancel: true });

/** rebuild the SDK's action with OUR builder, from what the action says */
function rebuild(v: Vector): { action: unknown; sign: SignRequest } {
  const t = tradingFor(v), a = v.action;
  if (a.type === 'order') {
    const items = (a.orders as any[]).map((w) => ({ instrument: byAsset(w.a), req: { instrument: byAsset(w.a).id, side: w.b ? 'buy' : 'sell', type: 'limit', size: w.s, price: w.p, triggerPrice: null, reduceOnly: w.r,
      tif: w.t.limit.tif === 'Alo' ? 'alo' : w.t.limit.tif === 'Ioc' ? 'ioc' : 'gtc', clientId: w.c } as OrderRequest }));
    return t.buildOrders(items, { nonce: v.nonce });
  }
  if (a.type === 'cancel') return t.buildCancels((a.cancels as any[]).map((c) => ({ instrument: byAsset(c.a), venueOrderId: String(c.o) })), { nonce: v.nonce });
  if (a.type === 'cancelByCloid') return t.buildCancels((a.cancels as any[]).map((c) => ({ instrument: byAsset(c.asset), clientId: c.cloid })), { nonce: v.nonce });
  if (a.type === 'scheduleCancel') return t.buildScheduleCancel({ time: a.time ?? null, nonce: v.nonce });
  throw new Error(`no builder for ${a.type}`);
}

describe('A. official SDK cross-vectors for the market-making actions', () => {
  it('the fixture was produced by the official SDK with a throwaway key', () => {
    expect(V.sdk).toBe('hyperliquid-python-sdk 0.24.0');
    expect(V.l1.length).toBe(22);
    expect(new Set(V.l1.map((v) => v.action.type))).toEqual(new Set(['order', 'cancel', 'cancelByCloid', 'scheduleCancel']));
  });
  for (const v of V.l1) {
    it(`${v.name} (${v.network}): same action, same hash, same signature`, async () => {
      const built = rebuild(v);
      expect(JSON.stringify(built.action)).toBe(JSON.stringify(v.action));                       // values AND key order
      expect(l1ActionHash(v.action as MsgpackValue, null, v.nonce, v.expiresAfter)).toBe(v.connectionId);
      const p = built.sign.payload as HlL1SignPayload;
      expect(p.typedData.message.connectionId).toBe(v.connectionId);
      expect(p.expiresAfter).toBe(v.expiresAfter);
      expect(sameSig(await signWith(V.key, p.typedData), v.signature)).toBe(true);
    });
  }
});

describe('B. describe() reads the new actions back, and nothing else', () => {
  const pick = (name: string, network = 'mainnet') => V.l1.find((v) => v.name === name && v.network === network)!;
  it('a batch of post-only orders: every order, in order', () => {
    const v = pick('alo ladder of four'), d = tradingFor(v).describe(rebuild(v).sign);
    expect(d.kind).toBe('order');
    expect(d.orders!.map((o) => [o.instrument, o.side, o.price, o.size, o.tif, o.reduceOnly, o.type])).toEqual([
      ['hyperliquid:ETH', 'buy', '1999.5', '0.01', 'alo', false, 'limit'], ['hyperliquid:ETH', 'buy', '1998.9', '0.01', 'alo', false, 'limit'],
      ['hyperliquid:ETH', 'sell', '2000.5', '0.01', 'alo', false, 'limit'], ['hyperliquid:ETH', 'sell', '2001.1', '0.0125', 'alo', false, 'limit']]);
    expect(new Set(d.orders!.map((o) => o.clientId)).size).toBe(4);
  });
  it('cancel batches by oid and by cloid', () => {
    const a = pick('cancel batch by oid'), da = tradingFor(a).describe(rebuild(a).sign);
    expect(da).toMatchObject({ kind: 'cancel', detail: { cancels: [{ instrument: 'hyperliquid:BTC', venueOrderId: '601262932710' }, { instrument: 'hyperliquid:BTC', venueOrderId: '601262932711' }, { instrument: 'hyperliquid:XONE', venueOrderId: '7' }] } });
    const b = pick('cancel batch by cloid'), db = tradingFor(b).describe(rebuild(b).sign);
    expect(db).toMatchObject({ kind: 'cancel', detail: { cancels: [{ instrument: 'hyperliquid:BTC', clientId: '0x00000000000000000000000000000002' }, { instrument: 'hyperliquid:BTC', clientId: '0x00000000000000000000000000000003' }] } });
  });
  it('scheduleCancel: its own kind, with the time or null', () => {
    const a = pick('scheduleCancel with time'), b = pick('scheduleCancel unset');
    expect(tradingFor(a).describe(rebuild(a).sign)).toMatchObject({ kind: 'schedule_cancel', detail: { time: 1794800060000, nonce: a.nonce, expiresAfter: a.expiresAfter, vaultAddress: null } });
    expect(tradingFor(b).describe(rebuild(b).sign)).toMatchObject({ kind: 'schedule_cancel', detail: { time: null } });
  });
  it('without the option, a scheduleCancel is read as `other`, exactly as before this work (every existing caller)', () => {
    const a = pick('scheduleCancel with time'), plain = createHlTrading({ network: a.network, assets: ASSETS, expiresAfterMs: a.expiresAfter! - a.nonce });
    expect(plain.describe(rebuild(a).sign)).toMatchObject({ kind: 'other', detail: { type: 'scheduleCancel' } });
  });
  it('refuses a smuggled field, a wrong key order, a mixed-up type — the hash is valid, the action is not one we build', () => {
    const v = pick('alo two-sided batch'), t = tradingFor(v);
    const l1 = (action: unknown): SignRequest => ({ venue: 'hyperliquid', network: v.network, kind: 'hl_l1',
      payload: { scheme: 'l1', action, nonce: v.nonce, vaultAddress: null, expiresAfter: v.expiresAfter, typedData: l1SignPayload(action as never, { network: v.network, nonce: v.nonce, vaultAddress: null, expiresAfter: v.expiresAfter }).typedData } });
    expect(t.describe(l1(v.action)).kind).toBe('order');
    expect(() => t.describe(l1({ ...v.action, builder: { b: `0x${'11'.repeat(20)}`, f: 10 } }))).toThrow(/order action/);                 // builder fee
    expect(() => t.describe(l1({ ...v.action, grouping: { p: 12345 } }))).toThrow(/order action/);                                          // priority fee
    expect(() => t.describe(l1({ ...v.action, grouping: 'normalTpsl' }))).toThrow(/order action/);
    expect(() => t.describe(l1({ type: 'order', grouping: 'na', orders: v.action.orders }))).toThrow(/canonical order/);
    expect(() => t.describe(l1({ ...v.action, orders: [{ ...v.action.orders[0], extra: 1 }] }))).toThrow(/order action/);
    expect(() => t.describe(l1({ ...v.action, orders: [{ ...v.action.orders[0], a: 99 }] }))).toThrow(/not in the mainnet asset table/);
    expect(() => t.describe(l1({ type: 'scheduleCancel', time: 1794800060000, extra: true }))).toThrow(/scheduleCancel action/);
    expect(() => t.describe(l1({ time: 1794800060000, type: 'scheduleCancel' }))).toThrow(/canonical order/);
    expect(() => t.describe(l1({ type: 'scheduleCancel', time: -1 }))).toThrow(/scheduleCancel action/);
    expect(() => t.describe(l1({ type: 'cancel', cancels: [{ a: 0, o: 1 }], f: true }))).toThrow(/cancel action/);                          // the fast flag is not built
    for (const type of ['modify', 'batchModify', 'twapOrder', 'updateIsolatedMargin', 'reserveRequestWeight', 'noop', 'vaultTransfer', 'agentSendAsset'])
      expect(t.describe(l1({ type, oid: 1, order: v.action.orders[0], modifies: [], weight: 1 })).kind).toBe('other');
  });
  it('the builders refuse a mixed cancel batch, an empty or oversized batch, a duplicate client id', () => {
    const t = createHlTrading({ network: 'mainnet', assets: ASSETS, expiresAfterMs: 10_000 }), BTC = byAsset(0);
    const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({ instrument: BTC.id, side: 'buy', type: 'limit', size: '0.001', price: '65000', triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: 'a', ...o });
    expect(() => t.buildOrders([], { nonce: 1794800000000 })).toThrow(/1 to 40/);
    expect(() => t.buildOrders(Array.from({ length: 41 }, (_, i) => ({ req: req({ clientId: `c${i}` }), instrument: BTC })), { nonce: 1794800000000 })).toThrow(/1 to 40/);
    expect(() => t.buildOrders([{ req: req(), instrument: BTC }, { req: req(), instrument: BTC }], { nonce: 1794800000000 })).toThrow(/same client id/);
    expect(() => t.buildOrders([{ req: req({ price: '65000.55' }), instrument: BTC }], { nonce: 1794800000000 })).toThrow(/price/);           // off the grid: refused, never rounded
    expect(() => t.buildCancels([{ instrument: BTC, venueOrderId: '1' }, { instrument: BTC, clientId: 'x' }], { nonce: 1794800000000 })).toThrow(/all by venueOrderId or all by clientId/);
    expect(() => t.buildCancels([{ instrument: BTC }], { nonce: 1794800000000 })).toThrow(/exactly one/);
    expect(() => t.buildScheduleCancel({ time: 0, nonce: 1794800000000 })).toThrow(/unix milliseconds/);
    expect(t.buildScheduleCancel({ time: null, nonce: 1794800000000 }).action).toEqual({ type: 'scheduleCancel' });
  });
});

describe('C. rounding of quotes: a bid only down, an ask only up, a size only down', () => {
  it('examples on the BTC grid (szDecimals 5: integers above 10 000; 5 significant figures)', () => {
    expect(hlRoundBid('64990.7', 5)).toBe('64990'); expect(hlRoundAsk('64990.2', 5)).toBe('64991');
    expect(hlRoundBid('64990', 5)).toBe('64990'); expect(hlRoundAsk('64990', 5)).toBe('64990');
    expect(hlRoundBid('1999.57', 4)).toBe('1999.5'); expect(hlRoundAsk('1999.51', 4)).toBe('1999.6');
    expect(hlRoundAsk('99999.2', 5)).toBe('100000'); expect(hlRoundBid('100000.9', 5)).toBe('100000');
    expect(hlRoundBid('150.256', 2)).toBe('150.25'); expect(hlRoundAsk('150.251', 2)).toBe('150.26');
    expect(hlRoundSize('0.000169', 5)).toBe('0.00016'); expect(hlRoundSize('0.000009', 5)).toBeNull();
    expect(hlRoundBid('0', 5)).toBeNull(); expect(hlRoundAsk('-1', 5)).toBeNull(); expect(hlRoundSize('abc', 5)).toBeNull();
    expect(hlMeetsMinNotional('65000', '0.00016')).toBe(true); expect(hlMeetsMinNotional('65000', '0.00015')).toBe(false);          // 10.4 / 9.75 USD
    expect(hlRoundQuote('buy', '64990.7', '0.000169', 5)).toEqual({ ok: true, quote: { side: 'buy', price: '64990', size: '0.00016' } });
    expect(hlRoundQuote('sell', '64990.2', '0.000159', 5)).toEqual({ ok: false, reason: 'min_notional' });                           // dropped, never enlarged
    expect(hlRoundQuote('buy', '64990', '0.000001', 5)).toEqual({ ok: false, reason: 'size' });
  });
  const price = fc.tuple(fc.integer({ min: 1, max: 9_999_999 }), fc.integer({ min: 0, max: 8 })).map(([m, s]) => D.str(D.div(D.from(BigInt(m)), D.from(10n ** BigInt(s)), 8, 'down'))).filter((p) => p !== '0');
  it('property: rounded prices are on the grid; bid ≤ input ≤ ask; idempotent; a bid/ask pair never crosses after rounding', () => {
    fc.assert(fc.property(price, fc.integer({ min: 0, max: 5 }), (p, szDecimals) => {
      const bid = hlRoundBid(p, szDecimals), ask = hlRoundAsk(p, szDecimals);
      if (bid !== null) {
        expect(hlFormatPrice(bid, szDecimals)).toEqual({ ok: true, wire: bid });
        expect(D.lte(D.from(bid), D.from(p))).toBe(true);
        expect(hlRoundBid(bid, szDecimals)).toBe(bid);
      }
      expect(ask).not.toBeNull();
      expect(hlFormatPrice(ask!, szDecimals)).toEqual({ ok: true, wire: ask });
      expect(D.gte(D.from(ask!), D.from(p))).toBe(true);
      expect(hlRoundAsk(ask!, szDecimals)).toBe(ask);
      if (bid !== null) expect(D.lte(D.from(bid), D.from(ask!))).toBe(true);
    }), { numRuns: 2000 });
  });
  it('property: a desired bid strictly below a desired ask stays at or below it after rounding (rounding never makes a pair cross)', () => {
    fc.assert(fc.property(price, price, fc.integer({ min: 0, max: 5 }), (x, y, szDecimals) => {
      const [lo, hi] = D.lte(D.from(x), D.from(y)) ? [x, y] : [y, x];
      const bid = hlRoundBid(lo, szDecimals), ask = hlRoundAsk(hi, szDecimals);
      if (bid !== null && ask !== null) expect(D.lte(D.from(bid), D.from(ask))).toBe(true);
    }), { numRuns: 1000 });
  });
  it('property: a size is rounded down onto the lot, never up', () => {
    fc.assert(fc.property(price, fc.integer({ min: 0, max: 5 }), (s, szDecimals) => {
      const r = hlRoundSize(s, szDecimals);
      if (r === null) return;
      expect(hlFormatSize(r, szDecimals)).toEqual({ ok: true, wire: r });
      expect(D.lte(D.from(r), D.from(s))).toBe(true);
    }), { numRuns: 1000 });
  });
});

describe('D. reconciliation parsers', () => {
  const ok = (statuses: unknown[]) => ({ status: 'ok', response: { type: 'order', data: { statuses } } });
  it('batch answer: one entry per order, in order; one error for the whole payload; anything else is UNKNOWN', () => {
    const alo = 'Post only order would have immediately matched, bbo was 64990@64991.';
    expect(hlBatchAnswer(ok([{ resting: { oid: 77 } }, { error: alo }]), 2)).toEqual({ kind: 'per_order', entries: [{ outcome: 'resting', oid: '77' }, { outcome: 'error', error: alo, kind: 'post_only_would_cross' }] });
    expect(hlBatchAnswer(ok([{ filled: { oid: 5, totalSz: '0.02', avgPx: '1891.4' } }]), 1)).toEqual({ kind: 'per_order', entries: [{ outcome: 'filled', oid: '5', totalSz: '0.02', avgPx: '1891.4' }] });
    expect(hlBatchAnswer({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success', { error: 'Order was never placed, already canceled, or filled.' }] } } }, 2))
      .toEqual({ kind: 'per_order', entries: [{ outcome: 'success' }, { outcome: 'error', error: 'Order was never placed, already canceled, or filled.', kind: 'missing_order' }] });
    expect(hlBatchAnswer(ok([{ error: 'Order must have minimum value of $10.' }]), 4)).toEqual({ kind: 'rejected', error: 'Order must have minimum value of $10.', errorKind: 'min_notional' });   // pre-validation
    expect(hlBatchAnswer({ status: 'err', response: 'Action already expired' }, 2)).toMatchObject({ kind: 'rejected', errorKind: 'expired' });
    expect(hlBatchAnswer({ status: 'err', response: 'User or API Wallet 0xabc does not exist.' }, 2)).toMatchObject({ kind: 'rejected', errorKind: 'signature' });
    expect(hlBatchAnswer({ status: 'err', response: 'Too many cumulative requests sent (1 > 0) for cumulative volume traded $0.' }, 1)).toMatchObject({ kind: 'rejected', errorKind: 'rate_limited' });
    expect(hlBatchAnswer(ok([{ resting: { oid: 1 } }]), 2)).toEqual({ kind: 'unknown' });           // fewer statuses than orders: not trusted
    expect(hlBatchAnswer({ status: 'ok', response: { type: 'default' } }, 1)).toEqual({ kind: 'unknown' });
    expect(hlBatchAnswer('<html>502</html>', 1)).toEqual({ kind: 'unknown' });
    expect(hlBatchAnswer(null, 1)).toEqual({ kind: 'unknown' });
    expect(hlOrderErrorKind('Insufficient margin to place order.')).toBe('margin');
    expect(hlOrderErrorKind('Reduce only order would increase position.')).toBe('reduce_only');
    expect(hlOrderErrorKind('Price must be divisible by tick size.')).toBe('tick');
    expect(hlOrderErrorKind('something new')).toBe('other');
  });
  it('order status by client id, and the address rate limit — public shapes recorded read-only', () => {
    const f = raw('mm-info-shapes.json');
    expect(hlOrderLookup(f.orderStatusUnknownByCloid.body)).toEqual({ found: false });
    expect(hlOrderLookup(f.orderStatusUnknownByOid.body)).toEqual({ found: false });
    expect(hlOrderLookup(f.orderStatusOrder.body)).toMatchObject({ found: true, oid: '1', cloid: '0x00000000000000000000000000000009', coin: 'ETH', side: 'sell', state: 'filled', venueStatus: 'filled', origSize: '0.0076', reduceOnly: true });
    expect(() => hlOrderLookup({ status: 'order' })).toThrow();
    expect(hlAddressRateLimit(f.userRateLimit.body)).toEqual({ cumVolume: '137296626.3600000143', used: 0, cap: 137306626, remaining: 137306626 });
    expect(hlAddressRateLimit({ cumVlm: '0.0', nRequestsUsed: 10050, nRequestsCap: 10000 }).remaining).toBe(0);
    expect(() => hlAddressRateLimit({ cumVlm: '0.0' })).toThrow();
    expect([hlExchangeWeight(1), hlExchangeWeight(20), hlExchangeWeight(40), hlExchangeWeight(79)]).toEqual([1, 1, 2, 2]);         // "1 + floor(batch_length / 40)"
    expect([hlAddressRequests(1), hlAddressRequests(20)]).toEqual([1, 20]);
  });
  it('every documented order status maps to a state; the dead man\'s switch status is a cancellation', () => {
    expect(hlOrderStatus('scheduledCancel')).toEqual({ status: 'cancelled', rejectReason: 'scheduledCancel' });
    for (const s of ['open', 'filled', 'canceled', 'triggered', 'rejected', 'marginCanceled', 'vaultWithdrawalCanceled', 'openInterestCapCanceled', 'selfTradeCanceled', 'reduceOnlyCanceled', 'siblingFilledCanceled', 'delistedCanceled',
      'liquidatedCanceled', 'scheduledCancel', 'tickRejected', 'minTradeNtlRejected', 'perpMarginRejected', 'reduceOnlyRejected', 'badAloPxRejected', 'iocCancelRejected', 'badTriggerPxRejected', 'marketOrderNoLiquidityRejected',
      'positionIncreaseAtOpenInterestCapRejected', 'positionFlipAtOpenInterestCapRejected', 'tooAggressiveAtOpenInterestCapRejected', 'openInterestIncreaseRejected', 'insufficientSpotBalanceRejected', 'oracleRejected', 'perpMaxPositionRejected'])
      expect(() => hlOrderStatus(s)).not.toThrow();
    expect(hlOrderStatus('badAloPxRejected')).toEqual({ status: 'rejected', rejectReason: 'badAloPxRejected' });
  });
});

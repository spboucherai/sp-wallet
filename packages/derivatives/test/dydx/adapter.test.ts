// dYdX v4 read adapter against real indexer answers recorded on 2026-11-10/11 (test/fixtures/record.mjs).
// Market data: mainnet. Account reads: public testnet accounts (mainnet account endpoints answered 403 GEOBLOCKED from the
// recording location; that answer is a fixture too).
import { describe, expect, it } from 'vitest';
import { accountState, candle, fill, fundingPayment, instrument, order, position, publicTrade, ticker, book as bookSchema } from '../venue-helpers.ts';
import { canonDec, createDydxAdapter, D, VenueError,
  priceToSubticks, quantumsToSize, quoteQuantumsToUsdc, sizeToQuantums, stepSizeOf, subticksToPrice, tickSizeOf, DYDX_CAPABILITIES } from '../../src/index.ts';
import { fx, replay, type Route } from '../venue-helpers.ts';
import { ds } from '../../src/venues/http.ts';

const MAIN: Route[] = [
  [/\/v4\/perpetualMarkets$/, fx('dydx', 'perpetualMarkets')], ['/orderbooks/perpetualMarket/BTC-USD', fx('dydx', 'orderbook-BTC-USD')],
  ['/orderbooks/perpetualMarket/NOPE-USD', fx('dydx', 'orderbook-unknown')], ['/trades/perpetualMarket/', fx('dydx', 'trades-BTC-USD')],
  ['/candles/perpetualMarkets/', fx('dydx', 'candles-BTC-USD-1HOUR')], ['/historicalFunding/', fx('dydx', 'historicalFunding-BTC-USD')],
  ['/height', fx('dydx', 'height')], ['/addresses/', fx('dydx', 'mainnet-account-geoblocked')],
];
const TEST: Route[] = [
  [/\/v4\/perpetualMarkets$/, fx('dydx', 'testnet-perpetualMarkets')], ['dydx1qqqq', fx('dydx', 'testnet-subaccount-unknown')], ['/subaccountNumber/', fx('dydx', 'testnet-subaccount')],
  ['status=OPEN', fx('dydx', 'testnet-orders-open')], ['/orders', fx('dydx', 'testnet-orders-history')], ['/fills', fx('dydx', 'testnet-fills')],
  ['/fundingPayments', fx('dydx', 'testnet-fundingPayments')], [/\/addresses\/dydx1\w+$/, fx('dydx', 'testnet-address')],
];
const NOW = Date.parse('2026-11-11T03:00:00Z');
const mainnet = (patch?: (url: string, body: any) => unknown) => { const r = replay(MAIN, patch); return { a: createDydxAdapter({ fetch: r.fetch, now: () => NOW }), calls: r.calls }; };
const testnet = (patch?: (url: string, body: any) => unknown) => { const r = replay(TEST, patch); return { a: createDydxAdapter({ network: 'testnet', fetch: r.fetch, now: () => NOW }), calls: r.calls }; };
const ACCOUNT = 'dydx1zzz66hkkjy6apat9w2enw37484v3xhqnlducf7';
const rejects = async (p: Promise<unknown>, code: string, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(VenueError);
  expect((e as VenueError).code).toBe(code);
  if (re) expect((e as VenueError).message).toMatch(re);
};
const rawMarkets = JSON.parse(fx('dydx', 'perpetualMarkets').text).markets as Record<string, any>;

describe('dYdX units: quantums and subticks (bigint only)', () => {
  const BTC = { atomicResolution: -10, quantumConversionExponent: -9, stepBaseQuantums: 1_000_000, subticksPerTick: 100_000 };
  it('converts BTC-USD sizes and prices exactly, both ways', () => {
    expect(BTC).toEqual({ atomicResolution: rawMarkets['BTC-USD'].atomicResolution, quantumConversionExponent: rawMarkets['BTC-USD'].quantumConversionExponent,
      stepBaseQuantums: rawMarkets['BTC-USD'].stepBaseQuantums, subticksPerTick: rawMarkets['BTC-USD'].subticksPerTick });
    expect(sizeToQuantums('0.0001', BTC)).toBe(1_000_000n);
    expect(sizeToQuantums('1.2345', BTC)).toBe(12_345_000_000n);
    expect(quantumsToSize(12_345_000_000n, BTC)).toBe('1.2345');
    expect(priceToSubticks('73650', BTC)).toBe(7_365_000_000n);
    expect(subticksToPrice(7_365_000_000n, BTC)).toBe('73650');
    expect(tickSizeOf(BTC)).toBe('1');
    expect(stepSizeOf(BTC)).toBe('0.0001');
    expect(quoteQuantumsToUsdc(2_639_091_750n)).toBe('2639.09175');
  });
  it('stays exact beyond 2^53 (a JS number would round these)', () => {
    const q = 9_007_199_254_740_993_000_000n;                    // 2^53 + 1, times the step
    expect(Number(q) === Number(q + 1n)).toBe(true);             // proof that a double cannot hold it
    expect(quantumsToSize(q, BTC)).toBe('900719925474.0993');
    expect(sizeToQuantums('900719925474.0993', BTC)).toBe(q);
    expect(subticksToPrice(123_456_789_012_345_678_900_000n, BTC)).toBe('1234567890123456789');
    expect(priceToSubticks('1234567890123456789', BTC)).toBe(123_456_789_012_345_678_900_000n);
  });
  it('refuses values that are not on the lot or the tick, instead of rounding', () => {
    expect(() => sizeToQuantums('0.00015', BTC)).toThrow(/multiple of the step/);
    expect(() => sizeToQuantums('0.00000000001', BTC)).toThrow();
    expect(() => priceToSubticks('73650.5', BTC)).toThrow(/multiple of the tick/);
    expect(() => priceToSubticks('1e5', BTC)).toThrow();
  });
  it('the protocol parameters reproduce the indexer tick and step of every market (296 markets, positive and negative exponents)', () => {
    const all = Object.values(rawMarkets);
    expect(all.length).toBe(296);
    for (const m of all) {
      expect(D.cmp(D.from(tickSizeOf(m)), D.from(m.tickSize)), m.ticker).toBe(0);
      expect(D.cmp(D.from(stepSizeOf(m)), D.from(m.stepSize)), m.ticker).toBe(0);
      // round trip of one tick above the oracle price, quantized down
      const p = ds(D.quantize(D.from(m.oraclePrice), D.from(tickSizeOf(m)), 'down'));
      if (p !== '0') expect(subticksToPrice(priceToSubticks(p, m), m)).toBe(p);
    }
  });
});

describe('dYdX market data (mainnet fixtures)', () => {
  it('lists every perpetual with all Instrument fields from the venue', async () => {
    const { a } = mainnet();
    const list = await a.instruments();
    expect(list.length).toBe(296);
    for (const i of list) expect(instrument.safeParse(i).success, i.symbol).toBe(true);
    expect(list.filter((i) => i.status === 'active').length).toBe(57);
    const btc = list.find((i) => i.symbol === 'BTC-USD')!;
    expect(btc).toMatchObject({ venue: 'dydx', id: 'dydx:BTC-USD', base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC', tickSize: '1', lotSize: '0.0001',
      minOrderSize: '0.0001', minNotional: null, maxLeverage: '50', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, status: 'active' });
    expect(list.find((i) => i.symbol === 'ETH-USD')).toMatchObject({ tickSize: '0.1', lotSize: '0.001', maxLeverage: '50' });
    const iso = list.find((i) => rawMarkets[i.symbol].marketType === 'ISOLATED')!;
    expect(iso.marginModes).toEqual(['isolated']);
    expect(list.find((i) => rawMarkets[i.symbol].status === 'FINAL_SETTLEMENT')!.status).toBe('halted');
  });
  it('tickers: oracle price as mark and index, hourly funding, open interest, 24 h volume — strings straight from the venue', async () => {
    const { a } = mainnet();
    const t = (await a.tickers()).find((x) => x.instrument === 'dydx:BTC-USD')!;
    expect(ticker.safeParse(t).success).toBe(true);
    const raw = rawMarkets['BTC-USD'];
    expect(t).toMatchObject({ mark: raw.oraclePrice, index: raw.oraclePrice, mid: null, funding: canonDec(raw.nextFundingRate), openInterest: canonDec(raw.openInterest), volume24h: canonDec(raw.volume24H), ts: NOW });
    // change is a fraction of the price 24 h earlier, computed in decimals: change / (oracle − change)
    const prev = D.sub(D.from(raw.oraclePrice), D.from(raw.priceChange24H));
    expect(t.change24h).toBe(ds(D.div(D.from(raw.priceChange24H), prev, 8, 'half_even')));
    expect(Number(t.change24h)).toBeLessThan(0);
  });
  it('order book: real levels, best first on both sides, depth honoured', async () => {
    const { a } = mainnet();
    const b = await a.book('BTC-USD', 5);
    expect(bookSchema.safeParse(b).success).toBe(true);
    expect(b.bids.length).toBe(5); expect(b.asks.length).toBe(5);
    for (let i = 1; i < 5; i++) {
      expect(D.cmp(D.from(b.bids[i - 1]![0]), D.from(b.bids[i]![0]))).toBe(1);
      expect(D.cmp(D.from(b.asks[i - 1]![0]), D.from(b.asks[i]![0]))).toBe(-1);
    }
    expect(D.cmp(D.from(b.bids[0]![0]), D.from(b.asks[0]![0]))).toBe(-1);
    const raw = JSON.parse(fx('dydx', 'orderbook-BTC-USD').text);
    expect(b.bids[0]).toEqual([raw.bids[0].price, raw.bids[0].size]);
    expect((await a.book('BTC-USD')).bids.length).toBe(50);
  });
  it('an unknown market is the venue refusing, not a broken answer', async () => {
    await rejects(mainnet().a.book('NOPE-USD'), 'rejected', /NOPE-USD not found/);
    await rejects(mainnet().a.book('BTC USD/../x'), 'rejected', /invalid market ticker/);
  });
  it('trades, candles (oldest first, base volume) and applied funding history', async () => {
    const { a, calls } = mainnet();
    const tr = await a.trades('BTC-USD', 50);
    expect(tr.length).toBe(50);
    for (const t of tr) expect(publicTrade.safeParse(t).success).toBe(true);
    expect(new Set(tr.map((t) => t.id)).size).toBe(50);
    const cs = await a.candles('BTC-USD', '1h', { limit: 24 });
    expect(cs.length).toBe(24);
    for (const c of cs) expect(candle.safeParse(c).success).toBe(true);
    for (let i = 1; i < cs.length; i++) expect(cs[i]!.ts - cs[i - 1]!.ts).toBe(3_600_000);
    expect(calls.find((c) => c.url.includes('/candles/'))!.url).toMatch(/resolution=1HOUR&limit=24$/);
    const all = await a.fundingHistory('BTC-USD', { start: 0 });
    expect(all.length).toBe(48);
    for (let i = 1; i < all.length; i++) expect(all[i]!.ts).toBeGreaterThan(all[i - 1]!.ts);
    expect(all.every((x) => x.premium === null && /^-?\d+(\.\d+)?$/.test(x.rate))).toBe(true);
    const cut = all[40]!.ts;
    expect((await a.fundingHistory('BTC-USD', { start: cut })).length).toBe(8);
    expect((await a.fundingHistory('BTC-USD', { start: all[10]!.ts, end: all[20]!.ts })).length).toBe(11);
  });
  it('reports how far the indexer has processed', async () => {
    const h = await mainnet().a.height();
    expect(h.height).toMatch(/^\d+$/);
    expect(Math.abs(h.ts - Date.parse(fx('dydx', 'height').recordedAt))).toBeLessThan(60_000);
  });
  it('capabilities are honest: read-only, real stream, no trading', () => {
    const { a } = mainnet();
    expect(a.capabilities).toBe(DYDX_CAPABILITIES);
    expect(a.capabilities).toMatchObject({ marketData: true, account: true, orders: false, orderTypes: [], tif: [], modify: false, stream: true, testnet: true, subaccounts: true });
    expect(a.trading).toBeUndefined();
    expect(a.capabilities.notes.join(' ')).toMatch(/SIGN_DIRECT/);
    expect(a.capabilities.notes.join(' ')).toMatch(/GEOBLOCKED/);
  });
});

describe('dYdX account reads (testnet fixtures)', () => {
  it('account state: equity and free collateral as reported, margin used by exact subtraction', async () => {
    const { a, calls } = testnet();
    const s = await a.account(ACCOUNT);
    expect(accountState.safeParse(s).success).toBe(true);
    const raw = JSON.parse(fx('dydx', 'testnet-subaccount').text).subaccount;
    expect(s).toMatchObject({ venue: 'dydx', account: `${ACCOUNT}/0`, equity: raw.equity, freeCollateral: raw.freeCollateral, collateral: raw.assetPositions.USDC.size,
      maintenanceMargin: null, withdrawable: null, source: 'venue' });
    expect(D.cmp(D.add(D.from(s.marginUsed), D.from(s.freeCollateral)), D.from(s.equity))).toBe(0);
    expect(calls[0]!.url).toMatch(new RegExp(`/addresses/${ACCOUNT}/subaccountNumber/0$`));
    await a.account(`${ACCOUNT}/128`);
    expect(calls[1]!.url).toMatch(/subaccountNumber\/128$/);
  });
  it('positions: venue fields kept, derived fields computed in decimals', async () => {
    const ps = await testnet().a.positions(ACCOUNT);
    expect(ps.map((p) => p.instrument).sort()).toEqual(['dydx:ETH-USD', 'dydx:LINK-USD', 'dydx:TRX-USD']);
    for (const p of ps) expect(position.safeParse(p).success).toBe(true);
    const trx = ps.find((p) => p.instrument === 'dydx:TRX-USD')!;
    const oracle = JSON.parse(fx('dydx', 'testnet-perpetualMarkets').text).markets['TRX-USD'].oraclePrice;
    expect(trx).toMatchObject({ side: 'short', size: '100', entryPrice: '0.10285', markPrice: oracle, liquidationPrice: null, marginMode: 'cross', realizedPnl: '0', fundingPaid: '-4.508714', source: 'venue' });
    expect(trx.dydx.notional).toBe(ds(D.mul(D.from('100'), D.from(oracle))));
    const eq = JSON.parse(fx('dydx', 'testnet-subaccount').text).subaccount.equity;
    expect(trx.leverage).toBe(ds(D.div(D.from(trx.dydx.notional), D.from(eq), 4, 'half_even')));
    expect(ps.find((p) => p.instrument === 'dydx:LINK-USD')!.fundingPaid).toBe('0.405107');
  });
  it('orders: history and open orders mapped without losing the venue status', async () => {
    const { a, calls } = testnet();
    const hist = await a.orderHistory(ACCOUNT, { limit: 20 });
    for (const o of hist) expect(order.safeParse(o).success).toBe(true);
    const stop = hist.find((o) => o.dydx.type === 'STOP_LIMIT')!;
    expect(stop).toMatchObject({ instrument: 'dydx:BTC-USD', type: 'stop_limit', side: 'sell', status: 'cancelled', tif: 'ioc', triggerPrice: '3', price: '2', filled: '0', clientId: '309878392', createdAt: 0 });
    expect(stop.dydx).toMatchObject({ status: 'CANCELED', orderFlags: '32', timeInForce: 'IOC' });
    expect(hist.filter((o) => o.status === 'filled').every((o) => o.filled === o.size)).toBe(true);
    const open = await a.openOrders(ACCOUNT);
    expect(open.length).toBe(1);
    expect(open[0]).toMatchObject({ instrument: 'dydx:TAO-USD', type: 'limit', tif: 'gtc', reduceOnly: false, rejectReason: null });
    expect(['open', 'partially_filled']).toContain(open[0]!.status);
    expect(open[0]!.dydx.orderFlags).toBe('64');                 // long-term (stateful) order
    expect(calls.at(-1)!.url).toContain('status=OPEN%2CUNTRIGGERED%2CBEST_EFFORT_OPENED');
  });
  it('unconfirmed indexer states are never reported as final', async () => {
    const { a } = testnet((url, body) => (url.includes('status=OPEN') ? body.map((o: any) => ({ ...o, status: 'BEST_EFFORT_CANCELED' })) : undefined));
    expect((await a.openOrders(ACCOUNT))[0]!.status).toBe('pending');
    const u = testnet((url, body) => (url.includes('status=OPEN') ? body.map((o: any) => ({ ...o, type: 'TWAP' })) : undefined));
    await rejects(u.a.openOrders(ACCOUNT), 'unsupported', /TWAP/);
  });
  it('fills and funding payments', async () => {
    const { a } = testnet();
    const fs = await a.fills(ACCOUNT);
    for (const f of fs) expect(fill.safeParse(f).success).toBe(true);
    const taker = fs.find((f) => f.instrument === 'dydx:TRX-USD')!;
    expect(taker).toMatchObject({ side: 'sell', price: '0.10285', size: '100', fee: '0.005143', feeAsset: 'USDC', liquidation: false, closedPnl: null });
    expect(taker.dydx.liquidity).toBe('TAKER');
    expect((await a.fills(ACCOUNT, { start: Date.parse('2026-01-01') })).every((f) => f.ts >= Date.parse('2026-01-01'))).toBe(true);
    const fp = await a.funding(ACCOUNT);
    expect(fp.length).toBeGreaterThan(5);
    for (const p of fp) expect(fundingPayment.safeParse(p).success).toBe(true);
    const raw = JSON.parse(fx('dydx', 'testnet-fundingPayments').text).fundingPayments[0];
    expect(fp[0]).toEqual({ instrument: `dydx:${raw.ticker}`, amount: raw.payment, rate: raw.rate, size: raw.size, ts: Date.parse(raw.createdAt) });
  });
  it('lists the subaccounts of an address; refuses malformed account identifiers before any request', async () => {
    const { a, calls } = testnet();
    expect(await a.subaccounts(ACCOUNT)).toEqual([0]);
    const n = calls.length;
    await rejects(a.account('0x46a3BA57e146A4906bc68759Fb7ad1E74d3B66f6'), 'rejected');
    await rejects(a.positions(`${ACCOUNT}/999999`), 'rejected');
    await rejects(a.account('dydx1short'), 'rejected');
    expect(calls.length).toBe(n);
  });
  it('an unknown subaccount and a geoblocked request are refusals with the venue reason', async () => {
    await rejects(testnet().a.account('dydx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd4mhgw'), 'rejected', /No subaccount found/);
    await rejects(mainnet().a.account(ACCOUNT), 'rejected', /GEOBLOCKED/);
    await rejects(mainnet().a.positions(ACCOUNT), 'rejected', /GEOBLOCKED/);
  });
});

describe('dYdX malformed or failing answers', () => {
  const drop = (path: string, mutate: (body: any) => void) => (url: string, body: any) => { if (url.includes(path)) { mutate(body); return body; } return undefined; };
  it('missing or mistyped fields are bad_answer, never a default value', async () => {
    await rejects(mainnet(drop('/perpetualMarkets', (b) => { delete b.markets['BTC-USD'].oraclePrice; })).a.tickers(), 'bad_answer', /oraclePrice/);
    await rejects(mainnet(drop('/perpetualMarkets', (b) => { b.markets['BTC-USD'].tickSize = 1; })).a.instruments(), 'bad_answer', /tickSize/);
    await rejects(mainnet(drop('/perpetualMarkets', (b) => { b.markets['BTC-USD'].oraclePrice = '7.3e4'; })).a.tickers(), 'bad_answer');
    await rejects(mainnet(drop('/perpetualMarkets', (b) => { b.markets['BTC-USD'].status = 'WHATEVER'; })).a.instruments(), 'bad_answer');
    await rejects(mainnet(drop('/orderbooks/', (b) => { b.bids[3].size = null; })).a.book('BTC-USD'), 'bad_answer');
    await rejects(mainnet(drop('/orderbooks/', (b) => { delete b.asks; })).a.book('BTC-USD'), 'bad_answer');
    await rejects(mainnet(drop('/trades/', (b) => { b.trades[0].side = 'UP'; })).a.trades('BTC-USD'), 'bad_answer');
    await rejects(mainnet(drop('/candles/', (b) => { b.candles[0].startedAt = 'yesterday'; })).a.candles('BTC-USD', '1h', {}), 'bad_answer');
    await rejects(mainnet(drop('/historicalFunding/', (b) => { b.historicalFunding[0].rate = 0.0001; })).a.fundingHistory('BTC-USD', { start: 0 }), 'bad_answer');
    await rejects(testnet(drop('/subaccountNumber/', (b) => { delete b.subaccount.equity; })).a.account(ACCOUNT), 'bad_answer', /equity/);
    await rejects(testnet(drop('/fills', (b) => { b.fills[0].fee = 12; })).a.fills(ACCOUNT), 'bad_answer');
    await rejects(testnet(drop('/orders', (b) => { delete b[0].clientId; })).a.orderHistory(ACCOUNT), 'bad_answer');
    await rejects(testnet(drop('/orders', (b) => { b[0].status = 'SOMETHING_NEW'; })).a.orderHistory(ACCOUNT), 'bad_answer');
  });
  it('a tick that disagrees with the protocol parameters is refused', async () => {
    await rejects(mainnet(drop('/perpetualMarkets', (b) => { b.markets['BTC-USD'].tickSize = '0.5'; })).a.instruments(), 'bad_answer', /tickSize 0.5/);
    await rejects(mainnet(drop('/perpetualMarkets', (b) => { b.markets['BTC-USD'].initialMarginFraction = '0'; })).a.instruments(), 'bad_answer');
  });
  it('a position in a market the venue does not list is refused', async () => {
    await rejects(testnet(drop('/perpetualMarkets', (b) => { delete b.markets['TRX-USD']; })).a.positions(ACCOUNT), 'bad_answer', /TRX-USD/);
  });
  it('unknown extra fields are tolerated', async () => {
    const { a } = mainnet(drop('/perpetualMarkets', (b) => { b.markets['BTC-USD'].somethingNew = { x: 1 }; b.extra = true; }));
    expect((await a.instruments()).length).toBe(296);
  });
  it('transport and status errors map to the contract codes', async () => {
    const one = (answer: Route[1]) => createDydxAdapter({ fetch: replay([[/./, answer]]).fetch });
    await rejects(one({ status: 429, text: 'slow down' }).tickers(), 'rate_limited');
    await rejects(one({ status: 503, text: 'upstream' }).tickers(), 'unavailable');
    await rejects(one({ status: 200, text: '<html>maintenance</html>' }).tickers(), 'bad_answer', /non-JSON/);
    await rejects(one({ status: 200, text: 'null' }).tickers(), 'bad_answer');
    await rejects(one(() => { throw new TypeError('fetch failed'); }).tickers(), 'unavailable', /fetch failed/);
    await rejects(one({ status: 400, text: '{"errors":[{"msg":"limit must be a positive integer"}]}' }).trades('BTC-USD'), 'rejected', /limit must be/);
  });
});

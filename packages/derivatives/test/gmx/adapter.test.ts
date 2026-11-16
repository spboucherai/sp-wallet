// GMX v2 read adapter against real answers of the GMX API, the Oracle API and the Subsquid GraphQL endpoint (Arbitrum),
// recorded on 2026-11-10/11 (test/fixtures/record.mjs). The account is a public address seen in the trade feed that day.
import { describe, expect, it } from 'vitest';
import { accountState, candle, fill, instrument, order, position, publicTrade, ticker } from '../venue-helpers.ts';
import { createGmxAdapter, D, VenueError, GMX_CAPABILITIES,
  gmxApiPrice, gmxBps, gmxContractPrice, gmxPerSecondToHourly, gmxPriceStep, gmxToContractPrice, gmxTokenAmount, gmxUsd, MAX_UINT256,
  fixed, toRaw, parseJsonExact, jsonNumberToDecStr, JsonNumber, canonDec } from '../../src/index.ts';
import { oracleCandles } from '../../src/venues/gmx/wire.ts';
import { fx, replay, type Route } from '../venue-helpers.ts';

const ROUTES: Route[] = [
  ['/markets/tickers', fx('gmx', 'v1-markets-tickers')], ['/markets/config', fx('gmx', 'v1-markets-config')], [/\/v1\/markets$/, fx('gmx', 'v1-markets')],
  ['/tokens/info', fx('gmx', 'v1-tokens-info')], ['/pairs', fx('gmx', 'v1-pairs')], ['symbol=NOPE', fx('gmx', 'v1-ohlcv-unknown')], ['/prices/ohlcv', fx('gmx', 'v1-ohlcv-BTC-1h')],
  ['/rates', fx('gmx', 'v1-rates-BTC-7d')], ['gmxinfra.io/prices/tickers', fx('gmx', 'oracle-prices-tickers')], ['gmxinfra.io/tokens', fx('gmx', 'oracle-tokens')],
  ['squids.live', fx('gmx', 'graphql-tradeActions-BTC')], ['address=0x123', fx('gmx', 'v1-positions-bad-address')],
  ['/positions?address=0x1111', fx('gmx', 'v1-positions-empty')], ['/positions', fx('gmx', 'v1-positions')], ['/orders', fx('gmx', 'v1-orders')], ['/trades', fx('gmx', 'v1-trades')],
];
const NOW = Date.parse('2026-11-11T03:00:00Z');
const gmx = (patch?: (url: string, body: any) => unknown, routes: Route[] = ROUTES) => { const r = replay(routes, patch); return { a: createGmxAdapter({ fetch: r.fetch, now: () => NOW }), calls: r.calls }; };
const BTC = 'BTC/USD [BTC-USDC]', ETH = 'ETH/USD [WETH-USDC]', BTC_MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703';
const ACCOUNT = '0x46a3BA57e146A4906bc68759Fb7ad1E74d3B66f6';
const rejects = async (p: Promise<unknown>, code: string, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(VenueError);
  expect((e as VenueError).code).toBe(code);
  if (re) expect((e as VenueError).message).toMatch(re);
};
const body = (name: string) => JSON.parse(fx('gmx', name).text);
const patchAt = (path: string, mutate: (b: any) => void) => (url: string, b: any) => { if (url.includes(path)) { mutate(b); return b; } return undefined; };

describe('GMX units (bigint only)', () => {
  it('30-decimal USD values', () => {
    expect(gmxUsd('9025899364919955331133472800000000000')).toBe('9025899.3649199553311334728');
    expect(gmxUsd('1')).toBe('0.000000000000000000000000000001');
    expect(gmxUsd('-31220937718530059282206175000000')).toBe('-31.220937718530059282206175');
    expect(gmxUsd('1000000000000000000000000000000')).toBe('1');
    expect(gmxUsd('0')).toBe('0');
    // a double keeps ~16 significant digits: this value would be corrupted by Number()
    const raw = '73634340805077142500000000000000001';
    expect(BigInt(Math.round(Number(raw))).toString()).not.toBe(raw);
    expect(toRaw(gmxUsd(raw), 30).toString()).toBe(raw);
  });
  it('per-token price precision: contract prices are scaled by 10^(30 − token decimals)', () => {
    expect(gmxContractPrice('736743447840545300000000000', 8)).toBe('73674.34478405453');       // BTC, 8 decimals → 22
    expect(gmxContractPrice('2060052770660954', 18)).toBe('2060.052770660954');                  // ETH, 18 decimals → 12
    expect(gmxContractPrice('999780700000000000000000', 6)).toBe('0.9997807');                   // USDC, 6 decimals → 24
    expect(gmxToContractPrice('73674.34478405453', 8)).toBe(736743447840545300000000000n);
    expect(gmxToContractPrice('2060.052770660954', 18)).toBe(2060052770660954n);
    expect(() => gmxToContractPrice('2060.0527706609541', 18)).toThrow(/more than 12 decimals/);
    expect(() => gmxContractPrice('1', 31)).toThrow();
    expect(gmxPriceStep(8)).toBe('0.0000000000000000000001');
    expect(gmxPriceStep(18)).toBe('0.000000000001');
    // the same BTC price in the two API formats differs by exactly 10^8
    expect(gmxApiPrice('73674344784054530000000000000000000')).toBe(gmxContractPrice('736743447840545300000000000', 8));
  });
  it('token amounts, basis points, rates', () => {
    expect(gmxTokenAmount('23559543727', 8)).toBe('235.59543727');
    expect(gmxTokenAmount('342804064', 6)).toBe('342.804064');
    expect(gmxBps('384930')).toBe('38.493');
    expect(gmxBps('2000000')).toBe('200');
    expect(gmxBps('-150')).toBe('-0.015');
    expect(gmxPerSecondToHourly('3478489931057503807801')).toBe('0.0000125225637518070137080836');
    expect(MAX_UINT256.toString()).toBe('115792089237316195423570985008687907853269984665640564039457584007913129639935');
    expect(fixed(-5n, 0)).toBe('-5');
    expect(() => toRaw('1.23', 1)).toThrow();
  });
  it('JSON numbers are read from their source text, never through a double', () => {
    const p = parseJsonExact('{"a": 73503.65, "b": 0.1, "c": 12345678901234567890.123456789, "d": 1.5e-7, "e": -2E3, "f": "x", "g": [1e21, 0.30000000000000004]}') as any;
    expect(p.a).toBeInstanceOf(JsonNumber);
    expect(jsonNumberToDecStr(p.a)).toBe('73503.65');
    expect(jsonNumberToDecStr(p.b)).toBe('0.1');
    expect(jsonNumberToDecStr(p.c)).toBe('12345678901234567890.123456789');
    expect(jsonNumberToDecStr(p.d)).toBe('0.00000015');
    expect(jsonNumberToDecStr(p.e)).toBe('-2000');
    expect(p.f).toBe('x');
    expect(jsonNumberToDecStr(p.g[0])).toBe('1000000000000000000000');
    expect(jsonNumberToDecStr(p.g[1])).toBe('0.30000000000000004');
    expect(canonDec('-0.0')).toBe('0');
  });
  it('Oracle API candles (JSON floats) parse exactly', () => {
    const f = fx('gmx', 'oracle-candles-BTC-1h');
    const c = oracleCandles.parse(parseJsonExact(f.text));
    expect(c.candles.length).toBe(24);
    for (const row of c.candles) for (const n of row) expect(f.text).toContain(n.text);
    const [ts, open] = c.candles[0]!;
    expect(jsonNumberToDecStr(ts)).toMatch(/^17\d{8}$/);
    expect(jsonNumberToDecStr(open)).toMatch(/^\d{5}(\.\d+)?$/);
  });
});

describe('GMX market data', () => {
  it('one instrument per GM market, swap-only markets excluded, every field from the venue', async () => {
    const { a } = gmx();
    const list = await a.instruments();
    const raw = body('v1-markets') as any[];
    expect(list.length).toBe(raw.filter((m) => !m.isSpotOnly).length);
    expect(list.some((i) => i.symbol.startsWith('SWAP-ONLY'))).toBe(false);
    for (const i of list) expect(instrument.safeParse(i).success, i.symbol).toBe(true);
    expect(list.find((i) => i.symbol === BTC)).toMatchObject({ venue: 'gmx', id: `gmx:${BTC}`, base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'BTC or USDC',
      tickSize: '0.0000000000000000000001', lotSize: '0.00000001', minOrderSize: null, minNotional: '1', maxLeverage: '200', marginModes: ['isolated'], fundingIntervalSec: 3600, status: 'active' });
    expect(list.find((i) => i.symbol === ETH)).toMatchObject({ base: 'ETH', collateral: 'WETH or USDC', tickSize: '0.000000000001', lotSize: '0.000000000000000001' });
    // the same index against another pool is another instrument, with its own collateral
    expect(list.find((i) => i.symbol === 'BTC/USD [BTC-BTC]')).toMatchObject({ base: 'BTC', collateral: 'BTC' });
    expect(list.filter((i) => i.base === 'BTC').length).toBeGreaterThan(2);
  });
  it('tickers: 30-decimal prices and rates converted exactly; funding normalized to "what longs pay per hour"', async () => {
    const { a } = gmx();
    const t = (await a.tickers()).find((x) => x.instrument === `gmx:${BTC}`)!;
    expect(ticker.safeParse(t).success).toBe(true);
    const raw = (body('v1-markets-tickers') as any[]).find((x) => x.symbol === BTC);
    expect(toRaw(t.mark, 30).toString()).toBe(raw.markPrice);
    expect(t.index).toBe(t.mark);
    expect(t.mid).toBeNull();
    expect(toRaw(t.funding!, 30)).toBe(-BigInt(raw.fundingRateLong));
    expect(toRaw(t.openInterest!, 8)).toBe(BigInt(raw.longInterestInTokens) + BigInt(raw.shortInterestInTokens));
    expect(t.change24h).toBe(gmxBps(raw.priceChangePercent24hBps));
    // 24 h volume is the listing feed's number, taken from the response text digit for digit
    const pairText = fx('gmx', 'v1-pairs').text, at = pairText.indexOf(`"pool_id":"${BTC_MARKET}"`);
    const vol = /"target_volume":([-0-9.eE+]+)/.exec(pairText.slice(pairText.lastIndexOf('{', at), pairText.indexOf('}', at)))![1]!;
    expect(t.volume24h).toBe(canonDec(vol));
    expect(D.cmp(D.from(t.mark), D.from('10000'))).toBe(1);
    expect(D.cmp(D.abs(D.from(t.funding!)), D.from('0.001'))).toBe(-1);           // an hourly rate, not an annual one
  });
  it('tickers survive the listing feed being down: volume is null, nothing is invented', async () => {
    const routes = ROUTES.map((r): Route => (r[0] === '/pairs' ? ['/pairs', { status: 503, text: 'down' }] : r));
    const t = (await gmx(undefined, routes).a.tickers()).find((x) => x.instrument === `gmx:${BTC}`)!;
    expect(t.volume24h).toBeNull();
    expect(t.mark).toMatch(/^\d+\.\d+$/);
  });
  it('has no order book and says so; exposes liquidity, open interest, rates and price-impact parameters instead', async () => {
    const { a } = gmx();
    await rejects(a.book(BTC), 'unsupported', /no order book/);
    const [l] = await a.liquidity(BTC);
    const tk = (body('v1-markets-tickers') as any[]).find((x) => x.symbol === BTC), cf = (body('v1-markets-config') as any[]).find((x) => x.name === BTC);
    expect(l).toMatchObject({ instrument: `gmx:${BTC}`, market: BTC_MARKET, capacityLimitedBy: { long: 'reserve', short: 'reserve' },
      priceImpact: { maxFactorPositive: '0.004', maxFactorNegative: '0.005' }, positionFeeFactor: { balanceImproved: '0.0004', balanceNotImproved: '0.0006' },
      minCollateralFactor: '0.005', minCollateralFactorForLiquidation: '0.005' });
    expect(toRaw(l!.openInterestLongUsd, 30).toString()).toBe(tk.longInterestUsd);
    expect(toRaw(l!.availableLiquidityShortUsd, 30).toString()).toBe(tk.availableLiquidityShort);
    expect(toRaw(l!.capacityLongUsd, 30).toString()).toBe(tk.capacityLong.availableLiquidity);
    expect(toRaw(l!.maxOpenInterestLongUsd, 30).toString()).toBe(cf.maxOpenInterestLong);
    // open interest in index tokens, and the market's flag saying that the balance (price impact, fee tier) is measured on it × price
    expect(toRaw(l!.openInterestLongTokens, 8).toString()).toBe(tk.longInterestInTokens); expect(toRaw(l!.openInterestShortTokens, 8).toString()).toBe(tk.shortInterestInTokens);
    expect(l!.useOpenInterestInTokensForBalance).toBe(true); expect(cf.useOpenInterestInTokensForBalance).toBe(true);
    expect(toRaw(l!.priceImpact.factorNegative, 30).toString()).toBe(cf.positionImpactFactorNegative);
    expect(toRaw(l!.priceImpact.exponentPositive, 30).toString()).toBe(cf.positionImpactExponentFactorPositive);
    // venue sign kept here: net = funding − borrowing for each side
    expect(toRaw(l!.netRateShortPerHour, 30)).toBe(BigInt(tk.fundingRateShort) - BigInt(tk.borrowingRateShort));
    expect((await a.liquidity()).length).toBe((body('v1-markets-tickers') as any[]).filter((x) => !x.symbol.startsWith('SWAP-ONLY')).length);
    await rejects(a.liquidity('BTC/USD [NOPE]'), 'rejected', /unknown perpetual market/);
    await rejects(a.liquidity('SWAP-ONLY [USDC-USDT]'), 'rejected');
  });
  it('oracle prices in contract precision agree with the GMX API price of the same token (two formats, one value)', async () => {
    const { a } = gmx();
    const ps = await a.oraclePrices();
    const btc = ps.find((p) => p.symbol === 'BTC')!, eth = ps.find((p) => p.symbol === 'ETH')!, usdc = ps.find((p) => p.symbol === 'USDC')!;
    const raw = (body('oracle-prices-tickers') as any[]).find((x) => x.tokenSymbol === 'BTC');
    expect(toRaw(btc.min, 22).toString()).toBe(raw.minPrice);
    expect(D.cmp(D.from(btc.min), D.from(btc.max))).toBeLessThanOrEqual(0);
    const mark = (await a.tickers()).find((x) => x.instrument === `gmx:${BTC}`)!.mark;
    const ratio = D.div(D.from(btc.min), D.from(mark), 6, 'half_even');             // recorded seconds apart
    expect(D.cmp(ratio, D.from('0.99'))).toBe(1); expect(D.cmp(ratio, D.from('1.01'))).toBe(-1);
    expect(D.cmp(D.from(eth.min), D.from('100'))).toBe(1); expect(D.cmp(D.from(eth.min), D.from('100000'))).toBe(-1);
    expect(D.cmp(D.from(usdc.min), D.from('0.9'))).toBe(1); expect(D.cmp(D.from(usdc.max), D.from('1.1'))).toBe(-1);
  });
  it('public trades from the Subsquid feed: execution price in contract precision, size in tokens, no zero-size rows', async () => {
    const { a, calls } = gmx();
    const tr = await a.trades(BTC, 30);
    for (const t of tr) expect(publicTrade.safeParse(t).success).toBe(true);
    const raw = body('graphql-tradeActions-BTC').data.tradeActions as any[];
    expect(tr.length).toBe(raw.filter((x) => BigInt(x.sizeDeltaInTokens) > 0n).length);
    expect(tr.every((t) => !D.isZero(D.from(t.size)))).toBe(true);
    const first = raw.find((x) => BigInt(x.sizeDeltaInTokens) > 0n);
    expect(tr[0]).toEqual({ instrument: `gmx:${BTC}`, price: gmxContractPrice(first.executionPrice, 8), size: gmxTokenAmount(first.sizeDeltaInTokens, 8),
      side: ([2, 3, 8].includes(first.orderType)) === first.isLong ? 'buy' : 'sell', ts: first.timestamp * 1000, id: first.id });
    const call = calls.find((c) => c.url.includes('squids.live'))!;
    expect(call.method).toBe('POST');
    expect(call.body).toContain(BTC_MARKET);
    expect(call.body).toContain('OrderExecuted');
  });
  it('candles (string prices, no volume published) and hourly funding history', async () => {
    const { a, calls } = gmx();
    const cs = await a.candles(BTC, '1h', { limit: 24 });
    expect(cs.length).toBe(24);
    for (const c of cs) { expect(candle.safeParse(c).success).toBe(true); expect(c.volume).toBe('0'); }
    for (let i = 1; i < cs.length; i++) expect(cs[i]!.ts - cs[i - 1]!.ts).toBe(3_600_000);
    expect(calls.find((c) => c.url.includes('/prices/ohlcv'))!.url).toMatch(/symbol=BTC&timeframe=1h&limit=24$/);
    await a.candles(BTC, '5m', { start: 1794300000000 });
    expect(calls.at(-1)!.url).toMatch(/timeframe=5m&limit=500&since=1794300000000$/);
    const fh = await a.fundingHistory(BTC, { start: NOW - 6 * 86_400_000 });
    expect(calls.at(-1)!.url).toMatch(new RegExp(`/rates\\?period=7d&address=${BTC_MARKET}$`));
    expect(fh.length).toBeGreaterThan(100);
    for (let i = 1; i < fh.length; i++) expect(fh[i]!.ts - fh[i - 1]!.ts).toBe(3_600_000);
    const raw = body('v1-rates-BTC-7d')[0].ratesSnapshots as any[];
    const last = raw.reduce((m, x) => (x.timestamp > m.timestamp ? x : m));
    expect(fh.at(-1)).toEqual({ ts: last.timestamp * 1000, rate: gmxPerSecondToHourly(-BigInt(last.fundingRateLong)), premium: null });
    // per-second snapshots × 3600 land on the same scale as the ticker's hourly rate
    const now = (await a.tickers()).find((x) => x.instrument === `gmx:${BTC}`)!.funding!;
    const ratio = D.div(D.from(fh.at(-1)!.rate), D.from(now), 4, 'half_even');
    expect(D.cmp(ratio, D.from('0.5'))).toBe(1); expect(D.cmp(ratio, D.from('2'))).toBe(-1);
  });
  it('capabilities are honest', () => {
    const { a } = gmx();
    expect(a.capabilities).toBe(GMX_CAPABILITIES);
    expect(a.capabilities).toMatchObject({ marketData: true, account: true, orders: true, orderTypes: ['market'], tif: [], stream: false, testnet: false, marginModes: ['isolated'], subaccounts: false });
    expect(a.stream).toBeUndefined();
    expect(a.trading).toBeUndefined();
    expect(a.capabilities.notes.join(' ')).toMatch(/NO ORDER BOOK/);
    expect(a.capabilities.notes.join(' ')).toMatch(/keeper/);
  });
});

describe('GMX account reads by EVM address', () => {
  it('positions keep the fee and price-impact fields', async () => {
    const { a } = gmx();
    const ps = await a.positions(ACCOUNT);
    const raw = body('v1-positions') as any[];
    expect(ps.length).toBe(raw.length);
    for (const p of ps) expect(position.safeParse(p).success).toBe(true);
    const p = ps[0]!, r = raw[0];
    expect(p).toMatchObject({ instrument: 'gmx:LTC/USD [WETH-USDC]', side: r.isLong ? 'long' : 'short', marginMode: 'isolated', realizedPnl: null, source: 'venue' });
    expect(toRaw(p.size, 8).toString()).toBe(r.sizeInTokens);
    expect(toRaw(p.entryPrice, 30).toString()).toBe(r.entryPrice);
    expect(toRaw(p.markPrice, 30).toString()).toBe(r.markPrice);
    expect(toRaw(p.liquidationPrice!, 30).toString()).toBe(r.liquidationPrice);
    expect(p.leverage).toBe(gmxBps(r.leverage));
    expect(toRaw(p.unrealizedPnl, 30).toString()).toBe(r.pnl);
    expect(toRaw(p.gmx.sizeUsd, 30).toString()).toBe(r.sizeInUsd);
    expect(toRaw(p.gmx.collateralAmount, 6).toString()).toBe(r.collateralAmount);
    expect(p.gmx.collateralSymbol).toBe('USDC');
    expect(toRaw(p.gmx.closingFeeUsd, 30).toString()).toBe(r.closingFeeUsd);
    expect(toRaw(p.gmx.pendingImpactUsd, 30).toString()).toBe(r.pendingImpactUsd);
    expect(toRaw(p.gmx.closePriceImpactDeltaUsd, 30).toString()).toBe(r.closePriceImpactDeltaUsd);
    expect(toRaw(p.gmx.netPriceImpactDeltaUsd, 30).toString()).toBe(r.netPriceImapctDeltaUsd);
    expect(toRaw(p.gmx.pnlAfterAllFeesUsd, 30).toString()).toBe(r.pnlAfterAllFees);
    expect(p.gmx.contractKey).toBe(r.contractKey);
    // sanity: size × mark ≈ USD size (within 2 %), all in decimals
    const ratio = D.div(D.mul(D.from(p.size), D.from(p.markPrice)), D.from(p.gmx.sizeUsd), 6, 'half_even');
    expect(D.cmp(ratio, D.from('0.98'))).toBe(1); expect(D.cmp(ratio, D.from('1.02'))).toBe(-1);
  });
  it('account state is the exact sum of the positions (GMX has no account-level margin)', async () => {
    const { a } = gmx();
    const s = await a.account(ACCOUNT);
    expect(accountState.safeParse(s).success).toBe(true);
    const raw = body('v1-positions') as any[];
    expect(toRaw(s.equity, 30)).toBe(raw.reduce((x, p) => x + BigInt(p.netValue), 0n));
    expect(toRaw(s.collateral, 30)).toBe(raw.reduce((x, p) => x + BigInt(p.collateralUsd), 0n));
    expect(s).toMatchObject({ venue: 'gmx', account: ACCOUNT, freeCollateral: '0', marginUsed: s.collateral, maintenanceMargin: null, withdrawable: null, source: 'venue' });
    expect(await gmx().a.account('0x1111111111111111111111111111111111111111')).toMatchObject({ equity: '0', collateral: '0' });
    expect(await gmx().a.positions('0x1111111111111111111111111111111111111111')).toEqual([]);
  });
  it('open orders: trigger price in contract precision, USD size, whole-position sentinel resolved against the position', async () => {
    const { a } = gmx();
    const os = await a.openOrders(ACCOUNT);
    const raw = body('v1-orders') as any[], pos = (body('v1-positions') as any[])[0];
    expect(os.length).toBe(raw.length);
    for (const o of os) expect(order.safeParse(o).success).toBe(true);
    const stop = os.find((o) => o.gmx.orderType === 'StopLossDecrease')!, rs = raw.find((x) => x.orderType === 6);
    expect(BigInt(rs.sizeDeltaUsd)).toBe(MAX_UINT256);
    expect(stop).toMatchObject({ type: 'stop_market', side: 'buy', reduceOnly: true, price: null, status: 'open', tif: 'gtc', venueOrderId: rs.key, clientId: rs.key, filled: '0' });
    expect(stop.triggerPrice).toBe(gmxContractPrice(rs.triggerPrice, 8));
    expect(stop.gmx).toMatchObject({ closesWholePosition: true, sizeUnit: 'usd', collateralSymbol: 'USDC', autoCancel: true, isFrozen: false, receiver: ACCOUNT });
    expect(toRaw(stop.size, 30).toString()).toBe(pos.sizeInUsd);
    expect(toRaw(stop.gmx.executionFee!, 18).toString()).toBe(rs.executionFee);
    const partial = os.find((o) => !o.gmx.closesWholePosition)!, rp = raw.find((x) => BigInt(x.sizeDeltaUsd) !== MAX_UINT256);
    expect(partial.type).toBe('take_profit_market');
    expect(toRaw(partial.size, 30).toString()).toBe(rp.sizeDeltaUsd);
  });
  it('a whole-position order without a matching position keeps size 0 and the flag — no guess', async () => {
    const { a } = gmx(patchAt('/positions', (b) => { b.length = 0; }));
    const stop = (await a.openOrders(ACCOUNT)).find((o) => o.gmx.orderType === 'StopLossDecrease')!;
    expect(stop.size).toBe('0');
    expect(stop.gmx.closesWholePosition).toBe(true);
  });
  it('swap orders are not derivatives: left out; a market order still listed is pending its keeper', async () => {
    const { a } = gmx(patchAt('/orders', (b) => {
      b.push({ ...b[0], key: `0x${'ab'.repeat(32)}`, orderType: 0, marketAddress: '0x0000000000000000000000000000000000000000' });
      b.push({ ...b[0], key: `0x${'cd'.repeat(32)}`, orderType: 2, sizeDeltaUsd: '5000000000000000000000000000000000', acceptablePrice: '520000000000000000000000', triggerPrice: '0' });
    }));
    const os = await a.openOrders(ACCOUNT);
    expect(os.length).toBe((body('v1-orders') as any[]).length + 1);
    expect(os.at(-1)).toMatchObject({ type: 'market', status: 'pending', side: 'sell', reduceOnly: false, size: '5000', price: '52', triggerPrice: null });
  });
  it('fills: executed position orders with fees in the collateral token and price impact in USD', async () => {
    const { a } = gmx();
    const fs = await a.fills(ACCOUNT);
    expect(fs.length).toBeGreaterThan(1);
    for (const f of fs) expect(fill.safeParse(f).success).toBe(true);
    const raw = (body('v1-trades').trades as any[]).filter((t) => t.eventName === 'OrderExecuted' && t.orderType >= 2 && t.orderType <= 8 && BigInt(t.sizeDeltaInTokens ?? '0') > 0n);
    expect(fs.length).toBe(Math.min(raw.length, 100));
    const dec = raw.find((t) => t.orderType === 4)!, f = fs.find((x) => x.id === dec.id)!;
    expect(f).toMatchObject({ orderId: dec.orderKey, clientId: null, feeAsset: 'USDC', liquidation: false, side: dec.isLong ? 'sell' : 'buy' });
    expect(toRaw(f.price, 22).toString()).toBe(dec.executionPrice);
    expect(toRaw(f.size, 8).toString()).toBe(dec.sizeDeltaInTokens);
    expect(toRaw(f.fee, 6).toString()).toBe(dec.positionFeeAmount);
    expect(toRaw(f.closedPnl!, 30).toString()).toBe(dec.pnlUsd);
    expect(toRaw(f.gmx.borrowingFeeAmount, 6).toString()).toBe(dec.borrowingFeeAmount);
    expect(toRaw(f.gmx.fundingFeeAmount, 6).toString()).toBe(dec.fundingFeeAmount);
    expect(toRaw(f.gmx.priceImpactUsd!, 30).toString()).toBe(dec.priceImpactUsd);
    expect(toRaw(f.gmx.totalImpactUsd!, 30).toString()).toBe(dec.totalImpactUsd);
    expect(f.gmx.txHash).toBe(dec.transactionHash);
    const inc = fs.find((x) => x.gmx.orderType === 'MarketIncrease')!;
    expect(inc.closedPnl).toBeNull();
    const cutoff = fs[1]!.ts;
    expect((await a.fills(ACCOUNT, { start: cutoff })).every((x) => x.ts >= cutoff)).toBe(true);
    expect((await a.fills(ACCOUNT, { limit: 1 })).length).toBe(1);
  });
  it('order history rebuilt from trade actions: executed, cancelled (with the venue reason), still waiting', async () => {
    const { a } = gmx();
    const hist = await a.orderHistory(ACCOUNT, { limit: 50 });
    for (const o of hist) expect(order.safeParse(o).success).toBe(true);
    expect(new Set(hist.map((o) => o.venueOrderId)).size).toBe(hist.length);
    for (let i = 1; i < hist.length; i++) expect(hist[i - 1]!.updatedAt).toBeGreaterThanOrEqual(hist[i]!.updatedAt);
    const filled = hist.find((o) => o.status === 'filled')!;
    expect(filled.avgFillPrice).toMatch(/^\d+\.\d+$/);
    const cancelled = hist.find((o) => o.status === 'cancelled');
    if (cancelled) expect(cancelled.rejectReason).toBeTruthy();
    expect(hist.every((o) => o.createdAt <= o.updatedAt)).toBe(true);
  });
  it('funding payments are not a list on this venue: unsupported, with where to look', async () => {
    await rejects(gmx().a.funding(ACCOUNT), 'unsupported', /fundingFeeAmount/);
  });
  it('refuses a non-EVM account before any request; a venue 400 is a refusal', async () => {
    const { a, calls } = gmx();
    await rejects(a.positions('dydx1zzz66hkkjy6apat9w2enw37484v3xhqnlducf7'), 'rejected', /EVM address/);
    expect(calls.filter((c) => c.url.includes('/positions')).length).toBe(0);
    const direct = createGmxAdapter({ fetch: replay([[/./, fx('gmx', 'v1-positions-bad-address')]]).fetch });
    await rejects(direct.instruments(), 'rejected', /Invalid address/);
    await rejects(gmx().a.candles('NOPE/USD [X-Y]', '1h', {}), 'rejected', /unknown perpetual market/);
  });
});

describe('GMX malformed or failing answers', () => {
  it('missing or mistyped fields are bad_answer', async () => {
    await rejects(gmx(patchAt('/markets/tickers', (b) => { delete b[0].markPrice; })).a.tickers(), 'bad_answer', /markPrice/);
    await rejects(gmx(patchAt('/markets/tickers', (b) => { b[0].markPrice = 73634.2; })).a.tickers(), 'bad_answer');
    await rejects(gmx(patchAt('/markets/tickers', (b) => { b[0].fundingRateLong = '1.5e25'; })).a.tickers(), 'bad_answer');
    await rejects(gmx(patchAt('/v1/markets', (b) => { if (Array.isArray(b) && b[0].leverageTiers) b[0].leverageTiers = []; })).a.instruments(), 'bad_answer');
    await rejects(gmx(patchAt('/tokens/info', (b) => { b.find((t: any) => t.symbol === 'USDC').decimals = '6'; })).a.instruments(), 'bad_answer');
    await rejects(gmx(patchAt('/positions', (b) => { delete b[0].collateralUsd; })).a.positions(ACCOUNT), 'bad_answer', /collateralUsd/);
    await rejects(gmx(patchAt('/positions', (b) => { b[0].sizeInUsd = 11990.45; })).a.account(ACCOUNT), 'bad_answer');
    await rejects(gmx(patchAt('/orders', (b) => { b[0].triggerPrice = null; })).a.openOrders(ACCOUNT), 'bad_answer');
    await rejects(gmx(patchAt('/trades', (b) => { delete b.trades; })).a.fills(ACCOUNT), 'bad_answer');
    await rejects(gmx(patchAt('/trades', (b) => { for (const t of b.trades) if (t.eventName === 'OrderExecuted') delete t.executionPrice; })).a.fills(ACCOUNT), 'bad_answer', /missing execution fields/);
    await rejects(gmx(patchAt('/prices/ohlcv', (b) => { b[0].close = 'n/a'; })).a.candles(BTC, '1h', {}), 'bad_answer');
    await rejects(gmx(patchAt('/rates', (b) => { b[0].ratesSnapshots[0].fundingRateLong = 12; })).a.fundingHistory(BTC, { start: 0 }), 'bad_answer');
    await rejects(gmx(patchAt('squids.live', (b) => { delete b.data; })).a.trades(BTC), 'bad_answer');
    await rejects(gmx(patchAt('/markets/config', (b) => { b.length = 0; })).a.liquidity(BTC), 'bad_answer', /no configuration/);
  });
  it('a position or order in a market or token the venue does not list is refused', async () => {
    await rejects(gmx(patchAt('/positions', (b) => { b[0].marketAddress = '0x00000000000000000000000000000000000000Aa'; })).a.positions(ACCOUNT), 'bad_answer', /unknown market/);
    await rejects(gmx(patchAt('/positions', (b) => { b[0].collateralTokenAddress = '0x00000000000000000000000000000000000000Bb'; })).a.positions(ACCOUNT), 'bad_answer', /unknown token/);
  });
  it('unknown extra fields are tolerated; transport and status errors map to the contract codes', async () => {
    expect((await gmx(patchAt('/markets/tickers', (b) => { b[0].brandNew = [1, 2]; })).a.tickers()).length).toBeGreaterThan(5);
    const one = (answer: Route[1]) => createGmxAdapter({ fetch: replay([[/./, answer]]).fetch });
    await rejects(one({ status: 429, text: '' }).instruments(), 'rate_limited');
    await rejects(one({ status: 504, text: '<html>' }).instruments(), 'unavailable');
    await rejects(one({ status: 200, text: 'oops' }).instruments(), 'bad_answer', /non-JSON/);
    await rejects(one(() => { throw new TypeError('fetch failed'); }).instruments(), 'unavailable');
  });
  it('the market catalogue is cached for a minute and refetched after a failure', async () => {
    let t = NOW;
    const r = replay(ROUTES);
    const a = createGmxAdapter({ fetch: r.fetch, now: () => t });
    await a.instruments(); await a.instruments();
    expect(r.calls.filter((c) => /\/v1\/markets$/.test(c.url)).length).toBe(1);
    t += 61_000;
    await a.instruments();
    expect(r.calls.filter((c) => /\/v1\/markets$/.test(c.url)).length).toBe(2);
    let fail = true;
    const flaky = createGmxAdapter({ now: () => NOW, fetch: (async (url: string, init: RequestInit) => {
      if (fail && /\/v1\/markets$/.test(String(url))) { fail = false; return new Response('down', { status: 503 }); }
      return r.fetch(url, init);
    }) as unknown as typeof fetch });
    await rejects(flaky.instruments(), 'unavailable');
    expect((await flaky.instruments()).length).toBeGreaterThan(50);
  });
});

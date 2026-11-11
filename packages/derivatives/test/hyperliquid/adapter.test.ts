// Hyperliquid read side against real answers recorded from the public info endpoint of mainnet and testnet
// (fixtures/hyperliquid/record.mts, 2026-11-10/11). No network.
import { describe, expect, it } from 'vitest';
import { D, VenueError, accountStateSchema, bookSchema, candleSchema, fillSchema, fundingPaymentSchema, instrumentSchema, orderSchema, positionSchema, publicTradeSchema, tickerSchema } from '../../src/index.ts';
import { HlWeightBudget, createHyperliquidAdapter, hlExchangeWeight, hlInfoExtraWeight, hlInfoWeight, hlOrderStatus } from '../../src/venues/hyperliquid/index.ts';
import { fx, replay, type Route } from './helpers.ts';

const NETWORKS = ['mainnet', 'testnet'] as const;
const routesOf = (network: 'mainnet' | 'testnet', extra: Record<string, Route> = {}): Record<string, Route> => {
  const f = (n: string) => { const x = fx(`${network}-${n}`); return { status: x.status, body: x.body }; };
  return {
    meta: f('meta'), metaAndAssetCtxs: f('metaAndAssetCtxs'), l2Book: f('l2Book-BTC'), recentTrades: f('recentTrades-BTC'), candleSnapshot: f('candleSnapshot-BTC-1h'),
    fundingHistory: f('fundingHistory-BTC'), clearinghouseState: f('clearinghouseState'), frontendOpenOrders: f('frontendOpenOrders'), historicalOrders: f('historicalOrders'),
    userFills: f('userFills'), userFillsByTime: f('userFillsByTime'), userFunding: f('userFunding'), ...extra,
  };
};
const make = (network: 'mainnet' | 'testnet', extra: Record<string, Route> = {}, now = Date.parse(fx(`${network}-meta`).recordedAt)) => {
  const r = replay(routesOf(network, extra));
  let t = now;
  const adapter = createHyperliquidAdapter({ network, fetch: r.fetchImpl, now: () => t });
  return { adapter, calls: r.calls, advance: (ms: number) => { t += ms; } };
};
const canon = (s: string) => D.str(D.from(s));
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'no error'; } catch (e) { return e instanceof VenueError ? e.code : `not a VenueError: ${e}`; } };

describe.each(NETWORKS)('hyperliquid read side — %s fixtures', (network) => {
  const account = (fx(`${network}-clearinghouseState`).request as { user: string }).user;

  it('instruments: lot from szDecimals, finest tick, leverage, isolated-only and delisted flags', async () => {
    const { adapter, calls } = make(network);
    const list = await adapter.instruments(), rawU = fx(`${network}-meta`).body.universe as any[];
    expect(calls[0]!.url).toBe(`https://api.hyperliquid${network === 'testnet' ? '-testnet' : ''}.xyz/info`);
    expect(calls[0]!.body).toEqual({ type: 'meta' });
    expect(list.length).toBe(rawU.length);
    for (const i of list) instrumentSchema.parse(i);
    const btc = list.find((i) => i.symbol === 'BTC')!, rawBtc = rawU.find((u) => u.name === 'BTC');
    expect(rawBtc.szDecimals).toBe(5);
    expect(btc).toMatchObject({ id: 'hyperliquid:BTC', venue: 'hyperliquid', base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC', lotSize: '0.00001', tickSize: '0.1', minNotional: '10', minOrderSize: null,
      maxLeverage: String(rawBtc.maxLeverage), marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, status: 'active' });
    for (const u of rawU) {
      const i = list.find((x) => x.symbol === u.name)!;
      expect(i.status).toBe(u.isDelisted ? 'halted' : 'active');
      expect(i.marginModes).toEqual(u.onlyIsolated || u.marginMode === 'strictIsolated' || u.marginMode === 'noCross' ? ['isolated'] : ['cross', 'isolated']);
      expect(D.str(D.mul(D.from(i.lotSize), D.from(`1${'0'.repeat(u.szDecimals)}`)))).toBe('1');
      expect(D.str(D.mul(D.from(i.tickSize), D.from(`1${'0'.repeat(6 - u.szDecimals)}`)))).toBe('1');
    }
    expect(list.some((i) => i.status === 'halted')).toBe(true);
    expect(list.some((i) => i.marginModes.length === 1)).toBe(true);
  });

  it('tickers: mark, oracle as index, mid, hourly funding, open interest, 24 h notional volume and change', async () => {
    const { adapter } = make(network);
    const t = await adapter.tickers(), [meta, ctxs] = fx(`${network}-metaAndAssetCtxs`).body as [any, any[]];
    expect(t.length).toBe(meta.universe.length);
    for (const x of t) tickerSchema.parse(x);
    const i = meta.universe.findIndex((u: any) => u.name === 'BTC'), btc = t[i]!, c = ctxs[i];
    expect(btc).toMatchObject({ instrument: 'hyperliquid:BTC', mark: canon(c.markPx), index: canon(c.oraclePx), mid: canon(c.midPx), funding: canon(c.funding), openInterest: canon(c.openInterest), volume24h: canon(c.dayNtlVlm) });
    // change = (mark − prevDayPx) / prevDayPx rounded to 6 decimals: |change × prev − (mark − prev)| ≤ prev × 0.0000005
    const mark = D.from(canon(c.markPx)), prev = D.from(canon(c.prevDayPx));
    const residual = D.abs(D.sub(D.mul(D.from(btc.change24h!), prev), D.sub(mark, prev)));
    expect(D.cmp(residual, D.mul(prev, D.from('0.0000005')))).toBeLessThanOrEqual(0);
    expect(D.from(btc.change24h!).s).toBeLessThanOrEqual(6);
    // an asset without a book has no mid and no premium: null, not zero
    const dead = ctxs.findIndex((x: any) => x.midPx === null);
    if (dead >= 0) expect(t[dead]!.mid).toBeNull();
    expect(typeof JSON.stringify(t)).toBe('string');
    for (const x of t) for (const k of ['mark', 'index', 'mid', 'funding', 'openInterest', 'volume24h', 'change24h'] as const) expect(x[k] === null || typeof x[k] === 'string').toBe(true);
  });

  it('book: bids descending, asks ascending, depth cut, venue timestamp', async () => {
    const { adapter, calls } = make(network);
    const b = await adapter.book('BTC'), rawB = fx(`${network}-l2Book-BTC`).body;
    bookSchema.parse(b);
    expect(calls.at(-1)!.body).toEqual({ type: 'l2Book', coin: 'BTC' });
    expect(b.ts).toBe(rawB.time);
    expect(b.bids.length).toBe(rawB.levels[0].length);
    expect(b.bids[0]).toEqual([canon(rawB.levels[0][0].px), canon(rawB.levels[0][0].sz)]);
    expect(b.asks[0]).toEqual([canon(rawB.levels[1][0].px), canon(rawB.levels[1][0].sz)]);
    expect(D.cmp(D.from(b.bids[0]![0]), D.from(b.asks[0]![0]))).toBe(-1);
    const top = await adapter.book('BTC', 3);
    expect([top.bids.length, top.asks.length]).toEqual([3, 3]);
  });

  it('trades: side of the aggressor, unique id from (time, tid), newest first', async () => {
    const { adapter } = make(network);
    const t = await adapter.trades('BTC'), rawT = fx(`${network}-recentTrades-BTC`).body as any[];
    expect(t.length).toBe(rawT.length);
    for (const x of t) publicTradeSchema.parse(x);
    const r0 = rawT[0], mine = t.find((x) => x.id === `${r0.time}-${r0.tid}`)!;
    expect(mine).toMatchObject({ instrument: 'hyperliquid:BTC', price: canon(r0.px), size: canon(r0.sz), side: r0.side === 'B' ? 'buy' : 'sell', ts: r0.time });
    for (let i = 1; i < t.length; i++) expect(t[i - 1]!.ts).toBeGreaterThanOrEqual(t[i]!.ts);
    expect((await adapter.trades('BTC', 2)).length).toBe(2);
  });

  it('candles: request shape, ascending, limit', async () => {
    const { adapter, calls } = make(network);
    const end = Date.parse(fx(`${network}-candleSnapshot-BTC-1h`).recordedAt);
    const c = await adapter.candles('BTC', '1h', { end, limit: 10 }), rawC = fx(`${network}-candleSnapshot-BTC-1h`).body as any[];
    expect(calls.at(-1)!.body).toEqual({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: end - 10 * 3_600_000, endTime: end } });
    expect(c.length).toBe(10);
    for (const x of c) candleSchema.parse(x);
    const last = rawC.at(-1);
    expect(c.at(-1)).toEqual({ ts: last.t, open: canon(last.o), high: canon(last.h), low: canon(last.l), close: canon(last.c), volume: canon(last.v) });
    for (let i = 1; i < c.length; i++) expect(c[i]!.ts - c[i - 1]!.ts).toBe(3_600_000);
    expect(await code(adapter.candles('BTC', '2h' as never, {}))).toBe('unsupported');
    expect(await code(adapter.candles('BTC', '1h', { limit: 5001 }))).toBe('unsupported');
  });

  it('funding history: hourly rate and premium', async () => {
    const { adapter, calls } = make(network);
    const f = await adapter.fundingHistory('BTC', { start: 1 }), rawF = fx(`${network}-fundingHistory-BTC`).body as any[];
    expect(calls.at(-1)!.body).toEqual({ type: 'fundingHistory', coin: 'BTC', startTime: 1 });
    expect(f.length).toBe(rawF.length);
    expect(f[0]).toEqual({ ts: rawF[0].time, rate: canon(rawF[0].fundingRate), premium: canon(rawF[0].premium) });
    await adapter.fundingHistory('BTC', { start: 1, end: 2 });
    expect(calls.at(-1)!.body).toEqual({ type: 'fundingHistory', coin: 'BTC', startTime: 1, endTime: 2 });
  });

  it('account state: account value, margin used, withdrawable, cross maintenance margin', async () => {
    const { adapter, calls } = make(network);
    const a = await adapter.account(account.toUpperCase().replace('0X', '0x')), s = fx(`${network}-clearinghouseState`).body;
    accountStateSchema.parse(a);
    expect(calls.at(-1)!.body).toEqual({ type: 'clearinghouseState', user: account.toLowerCase() });
    expect(a).toMatchObject({ venue: 'hyperliquid', account: account.toLowerCase(), equity: canon(s.marginSummary.accountValue), marginUsed: canon(s.marginSummary.totalMarginUsed),
      withdrawable: canon(s.withdrawable), maintenanceMargin: canon(s.crossMaintenanceMarginUsed), ts: s.time, source: 'venue' });
    const upnl = (s.assetPositions as any[]).reduce((n, p) => D.add(n, D.from(canon(p.position.unrealizedPnl))), D.from('0'));
    expect(a.collateral).toBe(D.str(D.sub(D.from(a.equity), upnl)));
    expect(D.str(D.add(D.from(a.freeCollateral), D.from(a.marginUsed)))).toBe(a.equity);
  });

  it('positions: side, size, entry, venue mark, liquidation price, leverage, margin mode, PnL, funding', async () => {
    const { adapter } = make(network);
    const p = await adapter.positions(account), s = fx(`${network}-clearinghouseState`).body, [meta, ctxs] = fx(`${network}-metaAndAssetCtxs`).body as [any, any[]];
    expect(p.length).toBe(s.assetPositions.length);
    expect(p.length).toBeGreaterThan(0);
    for (const x of p) positionSchema.parse(x);
    for (const { position: r } of s.assetPositions as any[]) {
      const x = p.find((y) => y.instrument === `hyperliquid:${r.coin}`)!, szi = D.from(canon(r.szi));
      expect(x).toMatchObject({ side: szi.m > 0n ? 'long' : 'short', size: D.str(D.abs(szi)), entryPrice: canon(r.entryPx), liquidationPrice: r.liquidationPx === null ? null : canon(r.liquidationPx),
        leverage: String(r.leverage.value), marginMode: r.leverage.type, margin: canon(r.marginUsed), unrealizedPnl: canon(r.unrealizedPnl), realizedPnl: null, fundingPaid: canon(r.cumFunding.sinceOpen), source: 'venue' });
      expect(x.markPrice).toBe(canon(ctxs[meta.universe.findIndex((u: any) => u.name === r.coin)].markPx));
    }
  });

  it('an account without positions: empty list, no second request', async () => {
    const empty = fx(`${network}-clearinghouseState-empty`);
    const { adapter, calls } = make(network, { clearinghouseState: { body: empty.body } });
    expect(await adapter.positions(account)).toEqual([]);
    expect(calls.map((c) => c.body.type)).toEqual(['clearinghouseState']);
    const a = await adapter.account(account);
    expect(a.marginUsed).toBe('0');
    expect(a.equity).toBe(a.collateral);
  });

  it('open orders: trigger orders, reduce-only, time in force, cloid', async () => {
    const { adapter, calls } = make(network);
    const o = await adapter.openOrders(account), rawO = fx(`${network}-frontendOpenOrders`).body as any[];
    expect(calls.at(-1)!.body).toEqual({ type: 'frontendOpenOrders', user: account.toLowerCase() });
    expect(o.length).toBe(rawO.length);
    expect(o.length).toBeGreaterThan(0);
    for (const x of o) orderSchema.parse(x);
    const types: Record<string, string> = { Limit: 'limit', 'Stop Market': 'stop_market', 'Stop Limit': 'stop_limit', 'Take Profit Market': 'take_profit_market', 'Take Profit Limit': 'take_profit_limit', Market: 'market' };
    for (const r of rawO) {
      const x = o.find((y) => y.venueOrderId === String(r.oid))!;
      expect(x).toMatchObject({ instrument: `hyperliquid:${r.coin}`, side: r.side === 'B' ? 'buy' : 'sell', type: types[r.orderType], size: canon(r.origSz), price: canon(r.limitPx), reduceOnly: r.reduceOnly,
        triggerPrice: r.isTrigger ? canon(r.triggerPx) : null, tif: r.tif === null ? 'gtc' : r.tif.toLowerCase(), clientId: r.cloid ?? '', createdAt: r.timestamp, rejectReason: null });
      expect(x.filled).toBe(D.str(D.sub(D.from(canon(r.origSz)), D.from(canon(r.sz)))));
      expect(x.status).toBe(x.filled === '0' ? 'open' : 'partially_filled');
    }
    expect(o.some((x) => x.triggerPrice !== null && x.reduceOnly)).toBe(true);
  });

  it('order history: one entry per order with its latest status', async () => {
    const { adapter } = make(network);
    const h = await adapter.orderHistory(account), rawH = fx(`${network}-historicalOrders`).body as any[];
    for (const x of h) orderSchema.parse(x);
    expect(new Set(h.map((x) => x.venueOrderId)).size).toBe(h.length);
    expect(h.length).toBe(new Set(rawH.map((x) => x.order.oid)).size);
    const statuses = new Set(h.map((x) => x.status));
    expect(statuses.has('filled') || statuses.has('cancelled')).toBe(true);
    const cancelledByVenue = rawH.find((x) => /Canceled$/.test(x.status));
    if (cancelledByVenue) expect(h.find((x) => x.venueOrderId === String(cancelledByVenue.order.oid))).toMatchObject({ status: 'cancelled', rejectReason: cancelledByVenue.status });
    const filled = rawH.find((x) => x.status === 'filled');
    if (filled) expect(h.find((x) => x.venueOrderId === String(filled.order.oid))).toMatchObject({ status: 'filled', filled: canon(filled.order.origSz), size: canon(filled.order.origSz) });
    for (let i = 1; i < h.length; i++) expect(h[i - 1]!.updatedAt).toBeGreaterThanOrEqual(h[i]!.updatedAt);
    expect((await adapter.orderHistory(account, { limit: 3 })).length).toBe(3);
  });

  it('fills: userFills, and userFillsByTime when a start is given', async () => {
    const { adapter, calls } = make(network);
    const f = await adapter.fills(account), rawF = fx(`${network}-userFills`).body as any[];
    expect(calls.at(-1)!.body).toEqual({ type: 'userFills', user: account.toLowerCase() });
    expect(f.length).toBe(rawF.length);
    for (const x of f) fillSchema.parse(x);
    expect(new Set(f.map((x) => x.id)).size).toBe(f.length);
    const r = rawF[0], x = f.find((y) => y.id === `${r.hash}-${r.tid}`)!;
    expect(x).toMatchObject({ instrument: `hyperliquid:${r.coin}`, orderId: String(r.oid), clientId: r.cloid ?? null, side: r.side === 'B' ? 'buy' : 'sell', price: canon(r.px), size: canon(r.sz), fee: canon(r.fee),
      feeAsset: r.feeToken, closedPnl: canon(r.closedPnl), ts: r.time, liquidation: false });
    const g = await adapter.fills(account, { start: 123, limit: 5 });
    expect(calls.at(-1)!.body).toEqual({ type: 'userFillsByTime', user: account.toLowerCase(), startTime: 123 });
    expect(g.length).toBe(5);
  });

  it('a liquidation fill is flagged', async () => {
    const body = structuredClone(fx(`${network}-userFills`).body);
    body[0].liquidation = { liquidatedUser: account, markPx: '1.0', method: 'market' };
    const { adapter } = make(network, { userFills: { body } });
    const f = await adapter.fills(account);
    expect(f.filter((x) => x.liquidation).length).toBe(1);
  });

  it('funding payments: signed amount, rate, signed position', async () => {
    const { adapter, calls, advance } = make(network);
    const f = await adapter.funding(account, { start: 5 }), rawF = fx(`${network}-userFunding`).body as any[];
    expect(calls.at(-1)!.body).toEqual({ type: 'userFunding', user: account.toLowerCase(), startTime: 5 });
    expect(f.length).toBe(rawF.length);
    for (const x of f) fundingPaymentSchema.parse(x);
    const r = rawF[0];
    expect(f.find((x) => x.ts === r.time && x.instrument === `hyperliquid:${r.delta.coin}`)).toEqual({ instrument: `hyperliquid:${r.delta.coin}`, amount: canon(r.delta.usdc), rate: canon(r.delta.fundingRate), size: canon(r.delta.szi), ts: r.time });
    advance(0);
    await adapter.funding(account);
    expect(calls.at(-1)!.body.startTime).toBe(Date.parse(fx(`${network}-meta`).recordedAt) - 7 * 86_400_000);
  });

  it('recorded error answers: unknown coin is HTTP 500 "null", bad type and bad user are HTTP 422', async () => {
    const unknown = fx(`${network}-error-unknown-coin`), badType = fx(`${network}-error-bad-type`), badUser = fx(`${network}-error-bad-user`);
    expect([unknown.status, unknown.body]).toEqual([500, null]);
    expect([badType.status, badUser.status]).toEqual([422, 422]);
    expect(badType.body).toBe('Failed to deserialize the JSON body into the target type');
    // the adapter never sends an unknown coin or a malformed address: both are refused locally
    const { adapter, calls } = make(network);
    expect(await code(adapter.book('NOT-A-COIN'))).toBe('unsupported');
    expect(calls.map((c) => c.body.type)).toEqual(['meta']);
    expect(await code(adapter.account('not-an-address'))).toBe('unsupported');
    expect(calls.length).toBe(1);
    // and if the venue answers that way anyway
    const a = make(network, { l2Book: { status: unknown.status, body: 'null' } });
    expect(await code(a.adapter.book('BTC'))).toBe('unavailable');
    const b = make(network, { clearinghouseState: { status: 422, body: badUser.body } });
    expect(await code(b.adapter.account(account))).toBe('bad_answer');
  });
});

describe('hyperliquid read side — malformed, delayed and rate-limited answers', () => {
  const account = (fx('mainnet-clearinghouseState').request as { user: string }).user;
  const patched = (name: string, patch: (b: any) => void) => { const b = structuredClone(fx(`mainnet-${name}`).body); patch(b); return { body: b }; };

  it.each([
    ['meta without szDecimals', 'instruments', { meta: patched('meta', (b) => { delete b.universe[0].szDecimals; }) }],
    ['meta with a float leverage', 'instruments', { meta: patched('meta', (b) => { b.universe[0].maxLeverage = 2.5; }) }],
    ['a price sent as a JSON number', 'book', { l2Book: patched('l2Book-BTC', (b) => { b.levels[0][0].px = 73699.5; }) }],
    ['a price in exponent notation', 'book', { l2Book: patched('l2Book-BTC', (b) => { b.levels[0][0].px = '7.3e4'; }) }],
    ['a crossed book', 'book', { l2Book: patched('l2Book-BTC', (b) => { b.levels[0][0].px = '999999999'; }) }],
    ['bids out of order', 'book', { l2Book: patched('l2Book-BTC', (b) => { b.levels[0].reverse(); }) }],
    ['a book for another coin', 'book', { l2Book: patched('l2Book-BTC', (b) => { b.coin = 'ETH'; }) }],
    ['a book without time', 'book', { l2Book: patched('l2Book-BTC', (b) => { delete b.time; }) }],
    ['contexts shorter than the universe', 'tickers', { metaAndAssetCtxs: patched('metaAndAssetCtxs', (b) => { b[1].pop(); }) }],
    ['a context without mark price', 'tickers', { metaAndAssetCtxs: patched('metaAndAssetCtxs', (b) => { delete b[1][0].markPx; }) }],
    ['a trade with an unknown side', 'trades', { recentTrades: patched('recentTrades-BTC', (b) => { b[0].side = 'X'; }) }],
    ['a candle with low above high', 'candles', { candleSnapshot: patched('candleSnapshot-BTC-1h', (b) => { b[0].l = '999999999'; }) }],
    ['an account state without withdrawable', 'account', { clearinghouseState: patched('clearinghouseState', (b) => { delete b.withdrawable; }) }],
    ['a position with a non-numeric size', 'positions', { clearinghouseState: patched('clearinghouseState', (b) => { b.assetPositions[0].position.szi = 'NaN'; }) }],
    ['an order with an unknown status', 'orderHistory', { historicalOrders: patched('historicalOrders', (b) => { b[0].status = 'somethingNew'; }) }],
    ['a fill without a trade id', 'fills', { userFills: patched('userFills', (b) => { delete b[0].tid; }) }],
    ['a funding payment without rate', 'funding', { userFunding: patched('userFunding', (b) => { delete b[0].delta.fundingRate; }) }],
    ['an HTML page', 'instruments', { meta: { body: '<html>maintenance</html>' } }],
    ['an empty body', 'instruments', { meta: { body: '' } }],
    ['null', 'tickers', { metaAndAssetCtxs: { body: 'null' } }],
  ] as [string, string, Record<string, Route>][])('%s → bad_answer', async (_n, method, extra) => {
    const { adapter } = make('mainnet', extra);
    const call: Record<string, () => Promise<unknown>> = {
      instruments: () => adapter.instruments(), tickers: () => adapter.tickers(), book: () => adapter.book('BTC'), trades: () => adapter.trades('BTC'), candles: () => adapter.candles('BTC', '1h', {}),
      account: () => adapter.account(account), positions: () => adapter.positions(account), orderHistory: () => adapter.orderHistory(account), fills: () => adapter.fills(account), funding: () => adapter.funding(account),
    };
    expect(await code(call[method]!())).toBe('bad_answer');
  });

  it('unknown fields are tolerated', async () => {
    const { adapter } = make('mainnet', { l2Book: patched('l2Book-BTC', (b) => { b.somethingNew = { a: 1 }; b.levels[0][0].extra = true; }) });
    expect((await adapter.book('BTC')).bids.length).toBeGreaterThan(0);
  });

  it('an order type that cannot be represented is not hidden: unsupported', async () => {
    const { adapter } = make('mainnet', { frontendOpenOrders: patched('frontendOpenOrders', (b) => { b[0].orderType = 'Trailing Stop'; }) });
    expect(await code(adapter.openOrders(account))).toBe('unsupported');
  });

  it('a delayed answer is cut at the timeout: unavailable', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(init.signal!.reason)); })) as unknown as typeof fetch;
    const adapter = createHyperliquidAdapter({ network: 'mainnet', fetch: fetchImpl, timeoutMs: 30 });
    const t0 = Date.now();
    try { await adapter.instruments(); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(VenueError); expect((e as VenueError).code).toBe('unavailable'); expect((e as VenueError).detail.timeout).toBe(true); }
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a network failure and an HTTP 502 are unavailable', async () => {
    const down = createHyperliquidAdapter({ network: 'mainnet', fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    expect(await code(down.instruments())).toBe('unavailable');
    expect(await code(make('mainnet', { meta: { status: 502, body: 'Bad Gateway' } }).adapter.instruments())).toBe('unavailable');
  });

  it('HTTP 429 is rate_limited and closes the local budget for a minute', async () => {
    const { adapter, advance } = make('mainnet', { meta: { status: 429, body: '' } });
    try { await adapter.instruments(); expect.unreachable(); }
    catch (e) { expect((e as VenueError).code).toBe('rate_limited'); expect((e as VenueError).detail.retryAfterMs).toBe(60_000); }
    expect(adapter.http.budget.used()).toBe(1200);
    try { await adapter.book('BTC'); expect.unreachable(); }
    catch (e) { expect((e as VenueError).code).toBe('rate_limited'); expect((e as VenueError).detail.local).toBe(true); }
    advance(60_001);
    expect(adapter.http.budget.used()).toBe(0);
  });

  it('documented weights: 2 / 20 / 60, per-item surcharges, exchange batches', () => {
    for (const t of ['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']) expect(hlInfoWeight(t)).toBe(2);
    for (const t of ['meta', 'metaAndAssetCtxs', 'recentTrades', 'candleSnapshot', 'frontendOpenOrders', 'historicalOrders', 'userFills', 'userFunding', 'fundingHistory']) expect(hlInfoWeight(t)).toBe(20);
    expect(hlInfoWeight('userRole')).toBe(60);
    expect(hlInfoExtraWeight('userFills', 2000)).toBe(100);
    expect(hlInfoExtraWeight('recentTrades', 19)).toBe(0);
    expect(hlInfoExtraWeight('candleSnapshot', 5000)).toBe(83);
    expect(hlInfoExtraWeight('meta', 5000)).toBe(0);
    expect([hlExchangeWeight(1), hlExchangeWeight(39), hlExchangeWeight(40), hlExchangeWeight(79), hlExchangeWeight(80)]).toEqual([1, 1, 2, 2, 3]);
  });

  it('the local budget refuses the request that would pass 1200 per minute, before sending it', async () => {
    const { adapter, calls, advance } = make('mainnet');
    for (let i = 0; i < 60; i++) await adapter.instruments(); // 60 × 20 = 1200
    expect(calls.length).toBe(60);
    try { await adapter.instruments(); expect.unreachable(); }
    catch (e) { expect((e as VenueError).code).toBe('rate_limited'); expect((e as VenueError).detail.retryAfterMs).toBeGreaterThan(0); }
    expect(calls.length).toBe(60);
    advance(60_001);
    await adapter.instruments();
    expect(calls.length).toBe(61);
  });

  it('per-item surcharge is charged after the answer', async () => {
    const { adapter } = make('mainnet');
    await adapter.fills(account); // 20 + floor(40 / 20)
    expect(adapter.http.budget.used()).toBe(22);
    const b = new HlWeightBudget(100, () => 0);
    b.take(90, 'x');
    expect(b.retryAfterMs(10)).toBe(0);
    expect(b.retryAfterMs(11)).toBe(60_000);
  });

  it('order status strings of the documentation', () => {
    expect(hlOrderStatus('open').status).toBe('open');
    expect(hlOrderStatus('filled').status).toBe('filled');
    expect(hlOrderStatus('canceled').status).toBe('cancelled');
    expect(hlOrderStatus('triggered').status).toBe('triggered');
    expect(hlOrderStatus('rejected')).toEqual({ status: 'rejected', rejectReason: 'rejected' });
    for (const s of ['marginCanceled', 'vaultWithdrawalCanceled', 'openInterestCapCanceled', 'selfTradeCanceled', 'reduceOnlyCanceled', 'siblingFilledCanceled', 'delistedCanceled', 'liquidatedCanceled'])
      expect(hlOrderStatus(s)).toEqual({ status: 'cancelled', rejectReason: s });
    expect(hlOrderStatus('tickRejected')).toEqual({ status: 'rejected', rejectReason: 'tickRejected' });
  });
});

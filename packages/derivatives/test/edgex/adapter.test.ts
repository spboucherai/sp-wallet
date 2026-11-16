// edgeX read-only adapter against REAL answers of the public endpoints recorded on 2026-11-15/16 UTC
// (test/fixtures/edgex/record.mjs; trimmed lists are declared in each fixture's `trimmed` field). No network, no key, no account.
import { afterEach, describe, expect, it } from 'vitest';
import { book as bookSchema, candle, instrument, publicTrade, ticker, fx, replay, wsFx, FakeSocket, type Route } from '../venue-helpers.ts';
import { createEdgeXAdapter, D, EDGEX_BLOCKED_JURISDICTION, EDGEX_CAPABILITIES, EDGEX_REASONS, VenueError, VenueUnavailable, VENUE_IDS, type EdgeXAdapter, type EdgeXAdapterOptions } from '../../src/index.ts';

const F = (n: string) => fx('edgex', n);
const NAMES = ['BTCUSDC', 'AAPLUSDC', 'SPYUSDC', 'XAUUSDC', 'USDJPYUSDC', 'ANTHROPICUSDC', 'JPYUSDC'];
const raw = (n: string) => JSON.parse(F(n).text).data;
const META = raw('metaData') as { contractList: any[]; coinList: any[] };
const ID = Object.fromEntries(META.contractList.map((c) => [c.contractName, c.contractId])) as Record<string, string>;
const A = ID.ANTHROPICUSDC!;
const NOW = Date.parse(F('metaData').recordedAt) + 60_000;

const ROUTES: Route[] = [
  ['/meta/getMetaData', F('metaData')], ['/contract-labels', F('contract-labels')],
  ...NAMES.map((n): Route => [`getTicker?contractId=${ID[n]}`, F(`ticker-${n}`)]),
  [/getDepth\?contractId=\d+&level=15$/, F('depth-ANTHROPICUSDC-15')], [/getDepth\?contractId=\d+&level=200$/, F('depth-ANTHROPICUSDC-200')],
  [/getKline.*offsetData=/, F('kline-ANTHROPICUSDC-HOUR_1-p2')], ['/quote/getKline', F('kline-ANTHROPICUSDC-HOUR_1-p1')],
  [/getFundingRatePage.*offsetData=/, F('funding-ANTHROPICUSDC-p2')], ['/funding/getFundingRatePage', F('funding-ANTHROPICUSDC-p1')],
];
const open: EdgeXAdapter[] = [];
afterEach(() => { for (const a of open.splice(0)) a.close(); FakeSocket.reset(); });
/** adapter over the recorded answers; no websocket unless a test injects one */
function make(o: { routes?: Route[]; patch?: (url: string, body: any) => unknown; clock?: { t: number } } & EdgeXAdapterOptions = {}) {
  const { routes, patch, clock, ...rest } = o;
  const r = replay([...(routes ?? []), ...ROUTES], patch), c = clock ?? { t: NOW };
  const a = createEdgeXAdapter({ fetch: r.fetch, now: () => c.t, WebSocket: null, sleep: async () => {}, ...rest });
  open.push(a);
  return { a, calls: r.calls, clock: c };
}
const fails = async (p: Promise<unknown>, code: string, re?: RegExp): Promise<VenueError> => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(VenueError);
  expect((e as VenueError).code).toBe(code);
  expect((e as VenueError).venue).toBe('edgex');
  if (re) expect((e as VenueError).message).toMatch(re);
  return e as VenueError;
};
const tick = (ms = 0) => new Promise<void>((r) => { setTimeout(r, ms); });

describe('edgeX: a read-only venue', () => {
  it('is a registered venue id with market data only: no account, no orders, no trading object, and the jurisdiction reason in its notes', () => {
    const { a } = make();
    expect(VENUE_IDS).toContain('edgex');
    expect(a.id).toBe('edgex'); expect(a.network).toBe('mainnet'); expect(a.trading).toBeUndefined();
    expect(a.capabilities).toBe(EDGEX_CAPABILITIES);
    expect(a.capabilities).toMatchObject({ marketData: true, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, testnet: false, stream: true });
    expect(a.capabilities.notes[0]).toContain(EDGEX_REASONS.trading); expect(a.capabilities.notes[0]).toContain('Canada');
    expect(a.capabilities.notes[1]).toContain(EDGEX_REASONS.account);
    expect(EDGEX_BLOCKED_JURISDICTION).toMatchObject({ venue: 'edgex', reason: EDGEX_REASONS.trading, readOn: '2026-11-15' });
    expect(EDGEX_BLOCKED_JURISDICTION.clauses[0]).toContain('UNITED STATES OF AMERICA OR CANADA');
    expect(EDGEX_BLOCKED_JURISDICTION.notice.en).toContain('edgeX\'s terms exclude Canada'); expect(EDGEX_BLOCKED_JURISDICTION.notice.fr).toContain('excluent le Canada');
    // the adapter exposes nothing that could build, sign or send an order
    expect(Object.keys(a).filter((k) => /order|sign|submit|cancel|place|withdraw|deposit|transfer/i.test(k)).sort()).toEqual(['openOrders', 'orderHistory']);
  });

  it('every account method throws VenueUnavailable(edgex_account_restricted_jurisdiction) without any request', async () => {
    const { a, calls } = make();
    for (const call of [a.account('x'), a.positions('x'), a.openOrders('x'), a.orderHistory('x'), a.fills('x'), a.funding('x')]) {
      const e = await fails(call, 'unsupported', /Canada/);
      expect(e).toBeInstanceOf(VenueUnavailable); expect((e as VenueUnavailable).reason).toBe('edgex_account_restricted_jurisdiction');
    }
    expect(() => a.stream({ type: 'account', account: 'x' }, () => {}, () => {})).toThrow(VenueUnavailable);
    expect(calls).toEqual([]);
  });

  it('only public GET endpoints are ever called', async () => {
    const { a, calls } = make();
    await a.instruments(); await a.tickers(); await a.book('ANTHROPICUSDC'); await a.candles('ANTHROPICUSDC', '1h', { limit: 5 }); await a.fundingHistory('ANTHROPICUSDC', { start: NOW - 86_400_000 });
    expect(calls.length).toBeGreaterThan(8);
    for (const c of calls) { expect(c.method).toBe('GET'); expect(c.body).toBeNull(); expect(c.url).toMatch(/^https:\/\/edgex-prod-v2\.edgex\.exchange\/api\/v2\/public\//); expect(c.url).not.toMatch(/private|account|order/i); }
  });
});

describe('edgeX instruments (getMetaData + category tabs)', () => {
  it('lists the displayed contracts with ids resolved from live metadata; every one is a valid Instrument', async () => {
    const { a } = make();
    const list = await a.instruments();
    expect(list.map((i) => i.symbol).sort()).toEqual(NAMES.filter((n) => n !== 'JPYUSDC').sort());      // JPYUSDC has enableDisplay false
    for (const i of list) { expect(instrument.parse(i)).toMatchObject({ venue: 'edgex', id: `edgex:${i.symbol}`, kind: 'perpetual', quote: 'USDC', collateral: 'USDC', fundingIntervalSec: 14_400, status: 'active' }); expect(i.edgex.contractId).toBe(ID[i.symbol]); }
  });

  it('ANTHROPICUSDC: sizes, leverage tiers, fees, funding and flags exactly as the venue publishes them', async () => {
    const { a } = make();
    const i = (await a.instruments()).find((x) => x.symbol === 'ANTHROPICUSDC')!, c = META.contractList.find((x) => x.contractName === 'ANTHROPICUSDC');
    expect(i).toMatchObject({ id: 'edgex:ANTHROPICUSDC', base: 'ANTHROPIC', quote: 'USDC', tickSize: '0.001', lotSize: '0.01', minOrderSize: '0.03', minNotional: null, maxLeverage: '5', category: 'pre_ipo', marginModes: ['cross', 'isolated'] });
    expect(i.edgex).toMatchObject({ contractId: '30000192', makerFeeRate: '0.0004', takerFeeRate: '0.00045', liquidationFeeRate: '0.01', maxOrderSize: c.maxOrderSize, maxPositionSize: c.maxPositionSize,
      fundingRateCap: { min: '-0.02', max: '0.02' }, isStock: true, isFx: false, categorySource: 'contract-labels' });
    expect(i.edgex.riskTiers).toEqual([{ tier: 1, maxLeverage: '5', maintenanceMarginRate: '0.1', positionValueUpperBound: '100000' }, { tier: 2, maxLeverage: '4', maintenanceMarginRate: '0.125', positionValueUpperBound: c.riskTierList[1].positionValueUpperBound }]);
    expect(i.settlement).toMatch(/no claim on the underlying/);
  });

  it('category: crypto, equity (stock and ETF), commodity, fx and pre_ipo from the tabs', async () => {
    const { a } = make();
    const cat = Object.fromEntries((await a.instruments()).map((i) => [i.symbol, i.category]));
    expect(cat).toEqual({ BTCUSDC: 'crypto', AAPLUSDC: 'equity', SPYUSDC: 'equity', XAUUSDC: 'commodity', USDJPYUSDC: 'fx', ANTHROPICUSDC: 'pre_ipo' });
    const btc = (await a.instruments()).find((x) => x.symbol === 'BTCUSDC')!;
    expect(btc).toMatchObject({ base: 'BTC', tickSize: '0.1', lotSize: '0.001', maxLeverage: '100' });
  });

  it('the metadata flags win over the tabs, and only the Perps V2 tabs are read', async () => {
    // live on 2026-11-15: the "commodities" tab of another product of the app lists the stocks JPM and KO
    const other = make({ patch: (url, body) => { if (url.includes('contract-labels')) { body.data.push({ multiLanguageKey: 'tabs.commodities', productCategory: 'AppTradFi', contracts: [{ contractId: ID.BTCUSDC }] }); return body; } return undefined; } });
    expect((await other.a.instruments()).find((i) => i.symbol === 'BTCUSDC')!.category).toBe('crypto');
    const wrong = make({ patch: (url, body) => { if (url.includes('contract-labels')) { body.data.find((l: any) => l.multiLanguageKey === 'tabs.commodities').contracts.push({ contractId: ID.AAPLUSDC }, { contractId: ID.USDJPYUSDC }); return body; } return undefined; } });
    const cat = Object.fromEntries((await wrong.a.instruments()).map((i) => [i.symbol, i.category]));
    expect(cat.AAPLUSDC).toBe('equity'); expect(cat.USDJPYUSDC).toBe('fx'); expect(cat.XAUUSDC).toBe('commodity');
  });

  it('without the (undocumented) tabs endpoint: only what the flags prove — no category for crypto or commodities', async () => {
    for (const labels of [{ status: 404, text: 'not found' }, F('old-host-html')]) {
      const { a } = make({ routes: [['/contract-labels', labels]] });
      const list = await a.instruments();
      expect(Object.fromEntries(list.map((i) => [i.symbol, i.category]))).toEqual({ BTCUSDC: undefined, AAPLUSDC: 'equity', SPYUSDC: 'equity', XAUUSDC: undefined, USDJPYUSDC: 'fx', ANTHROPICUSDC: 'equity' });
      expect(list.every((i) => i.edgex.categorySource === 'flags' && instrument.safeParse(i).success)).toBe(true);
    }
    const { a, calls } = make({ labels: false });
    await a.instruments();
    expect(calls.map((c) => c.url).some((u) => u.includes('contract-labels'))).toBe(false);
  });

  it('a contract whose name is not ASCII (two live listings have Chinese names) is listed and readable under that name', async () => {
    const name = '牛来USDC';
    const { a, calls } = make({ patch: (url, body) => { if (url.includes('getMetaData')) { body.data.contractList.find((c: any) => c.contractName === 'XAUUSDC').contractName = name; return body; } return undefined; } });
    const i = (await a.instruments()).find((x) => x.symbol === name)!;
    expect(instrument.parse(i)).toMatchObject({ id: `edgex:${name}`, base: 'XAU' });                    // the base is the coin's name, not a slice of the contract name
    await a.candles(name, '1h', { limit: 1 });
    expect(calls.at(-1)!.url).toContain(`contractId=${ID.XAUUSDC}`);
  });

  it('metadata is cached, and an unknown symbol is refused without guessing an id', async () => {
    const { a, calls, clock } = make();
    await a.instruments(); await a.instruments(); await a.book('ANTHROPICUSDC', 15);
    expect(calls.filter((c) => c.url.includes('getMetaData')).length).toBe(1);
    await fails(a.book('NOPEUSDC'), 'rejected', /unknown contract/);
    await fails(a.book('bad symbol'), 'rejected', /invalid contract name/);
    clock.t += 300_001;
    await a.instruments();
    expect(calls.filter((c) => c.url.includes('getMetaData')).length).toBe(2);
  });
});

describe('edgeX tickers', () => {
  it('REST fallback: one getTicker per displayed contract, cached between sweeps; figures unchanged, receive time as ts', async () => {
    const { a, calls, clock } = make({ tickerConcurrency: 2 });
    const list = await a.tickers();
    expect(a.diagnostics().tickerSource).toBe('rest');
    expect(list.length).toBe(6);
    for (const t of list) expect(ticker.parse(t)).toMatchObject({ ts: NOW, mid: null });
    const t = list.find((x) => x.instrument === 'edgex:ANTHROPICUSDC')!, w = raw('ticker-ANTHROPICUSDC')[0];
    expect(t).toMatchObject({ mark: w.markPrice, index: w.indexPrice, last: w.lastPrice, openInterest: w.openInterest, volume24h: w.value, volumeBase24h: w.size,
      funding: D.str(D.from(w.fundingRate)), change24h: D.str(D.from(w.priceChangePercent)), nextFundingTs: Number(w.nextFundingTime) });
    const n = () => calls.filter((c) => c.url.includes('getTicker')).length;
    expect(n()).toBe(6);
    expect(calls.some((c) => c.url.includes(`contractId=${ID.JPYUSDC}`))).toBe(false);                 // a hidden contract is not asked for
    clock.t += 5_000; await a.tickers(); expect(n()).toBe(6);                                           // inside the sweep interval: served from the cache
    clock.t += 10_001; expect((await a.tickers())[0]!.ts).toBe(clock.t); expect(n()).toBe(12);
  });

  it('websocket (ticker.all.1s): every contract in one frame, mid from the best bid and ask; hidden contracts dropped', async () => {
    const { a, calls } = make({ WebSocket: FakeSocket as never, tickerStreamWaitMs: 2_000, sleep: (ms) => tick(ms) });
    const p = a.tickers();
    await tick(5);
    const sock = FakeSocket.last, rec = wsFx('edgex', 'ws-public');
    expect(sock.url).toBe('wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws');
    sock.serve(rec.messages.find((m) => m.type === 'connected')!);
    expect(sock.sent).toEqual([{ type: 'subscribe', channel: 'ticker.all.1s' }]);
    const frame = rec.messages.find((m) => m.channel === 'ticker.all.1s' && m.type === 'quote-event') as any;
    sock.serve(frame);
    const list = await p;
    expect(a.diagnostics().tickerSource).toBe('websocket');
    expect(list.map((t) => t.instrument).sort()).toEqual(NAMES.filter((n) => n !== 'JPYUSDC').map((n) => `edgex:${n}`).sort());
    const w = frame.content.data.find((x: any) => x.contractName === 'ANTHROPICUSDC'), t = list.find((x) => x.instrument === 'edgex:ANTHROPICUSDC')!;
    expect(ticker.parse(t)).toMatchObject({ mark: w.markPrice, last: D.str(D.from(w.lastPrice)) });
    expect(t.mid).toBe(D.str(D.div(D.add(D.from(w.bestBidPrice), D.from(w.bestAskPrice)), D.from(2n), 18, 'half_even')));
    expect(calls.some((c) => c.url.includes('getTicker'))).toBe(false);                                 // no REST sweep when the feed answers
  });

  it('a websocket that never answers falls back to REST instead of failing', async () => {
    const { a } = make({ WebSocket: FakeSocket as never, tickerStreamWaitMs: 20, sleep: (ms) => tick(ms) });
    expect((await a.tickers()).length).toBe(6);
    expect(a.diagnostics().tickerSource).toBe('rest');
  });
});

describe('edgeX book, candles, funding', () => {
  it('book: only levels 15 and 200 are requested; best first on both sides, not crossed', async () => {
    const { a, calls } = make();
    const b15 = bookSchema.parse(await a.book('ANTHROPICUSDC', 15)), d = raw('depth-ANTHROPICUSDC-15')[0];
    expect(calls.at(-1)!.url).toMatch(new RegExp(`getDepth\\?contractId=${A}&level=15$`));
    expect(b15).toMatchObject({ instrument: 'edgex:ANTHROPICUSDC', ts: NOW });
    expect(b15.bids.length).toBe(15); expect(b15.asks.length).toBe(15);
    expect(b15.bids[0]).toEqual([D.str(D.from(d.bids[0].price)), D.str(D.from(d.bids[0].size))]);
    for (const [side, dir] of [[b15.bids, -1], [b15.asks, 1]] as const) for (let k = 1; k < side.length; k++) expect(D.cmp(D.from(side[k - 1]![0]), D.from(side[k]![0]))).toBe(-dir);
    expect(D.lt(D.from(b15.bids[0]![0]), D.from(b15.asks[0]![0]))).toBe(true);
    for (const depth of [16, 50, 500]) { await a.book('ANTHROPICUSDC', depth); expect(calls.at(-1)!.url).toMatch(/level=200$/); }
    const b = await a.book('ANTHROPICUSDC');
    expect(b.bids.length).toBe(Math.min(50, raw('depth-ANTHROPICUSDC-200')[0].bids.length));
  });

  it('book: the venue\'s refusal of another level is reported as rejected, a crossed book as bad_answer', async () => {
    await fails(make({ routes: [['/quote/getDepth', F('depth-bad-level')]] }).a.book('ANTHROPICUSDC'), 'rejected', /INVALID_DEPTH_LEVEL/);
    const crossed = make({ patch: (url, body) => { if (url.includes('getDepth')) { body.data[0].bids[0].price = '999999'; return body; } return undefined; } });
    await fails(crossed.a.book('ANTHROPICUSDC'), 'bad_answer', /crossed book/);
  });

  it('candles: interval mapping, newest-first pages joined through offsetData, returned oldest first', async () => {
    const { a, calls } = make();
    const c = await a.candles('ANTHROPICUSDC', '1h', { limit: 10 });
    const kl = calls.filter((x) => x.url.includes('getKline')).map((x) => new URL(x.url).searchParams);
    expect(kl.length).toBe(2);
    expect(Object.fromEntries(kl[0]!)).toEqual({ contractId: A, klineType: 'HOUR_1', priceType: 'LAST_PRICE', size: '10' });
    expect(kl[1]!.get('offsetData')).toBe(raw('kline-ANTHROPICUSDC-HOUR_1-p1').nextPageOffsetData); expect(kl[1]!.get('size')).toBe('5');
    expect(c.length).toBe(10);
    for (const x of c) candle.parse(x);
    for (let k = 1; k < c.length; k++) expect(c[k]!.ts - c[k - 1]!.ts).toBe(3_600_000);
    const first = raw('kline-ANTHROPICUSDC-HOUR_1-p1').dataList[0];
    expect(c.at(-1)).toEqual({ ts: Number(first.klineTime), open: D.str(D.from(first.open)), high: D.str(D.from(first.high)), low: D.str(D.from(first.low)), close: D.str(D.from(first.close)), volume: D.str(D.from(first.size)) });
    await a.candles('ANTHROPICUSDC', '1d', { limit: 5000, start: 1, end: 2 });
    const last = new URL(calls.filter((x) => x.url.includes('getKline')).at(-2)!.url).searchParams;
    expect([last.get('klineType'), last.get('size'), last.get('filterBeginKlineTimeInclusive'), last.get('filterEndKlineTimeExclusive')]).toEqual(['DAY_1', '1000', '1', '2']);   // never above 1000 per page
    for (const [i, k] of [['1m', 'MINUTE_1'], ['5m', 'MINUTE_5'], ['15m', 'MINUTE_15'], ['4h', 'HOUR_4']] as const) { await a.candles('ANTHROPICUSDC', i, { limit: 1 }); expect(calls.at(-1)!.url).toContain(`klineType=${k}`); }
  });

  it('candles: the venue\'s own errors (bad enum, page too large) are rejected with its code', async () => {
    await fails(make({ routes: [['/quote/getKline', F('kline-bad-enum')]] }).a.candles('ANTHROPICUSDC', '1h', {}), 'rejected', /GATEWAY_INVALID_REQUEST/);
    await fails(make({ routes: [['/quote/getKline', F('kline-too-large')]] }).a.candles('ANTHROPICUSDC', '1h', {}), 'rejected', /INVALID_GET_PAGE_SIZE/);
  });

  it('funding history: settlements only, 4 h apart, paged until the start time', async () => {
    const p1 = raw('funding-ANTHROPICUSDC-p1').dataList, p2 = raw('funding-ANTHROPICUSDC-p2').dataList;
    const { a, calls } = make();
    const all = await a.fundingHistory('ANTHROPICUSDC', { start: Number(p2.at(-1).fundingTime) });
    const pages = calls.filter((x) => x.url.includes('getFundingRatePage')).map((x) => new URL(x.url).searchParams);
    expect(pages.length).toBe(2);
    expect(Object.fromEntries(pages[0]!)).toEqual({ contractId: A, size: '100', filterSettlementFundingRate: 'true' });
    expect(pages[1]!.get('offsetData')).toBe(raw('funding-ANTHROPICUSDC-p1').nextPageOffsetData);
    expect(all.length).toBe(10);
    for (let k = 1; k < all.length; k++) expect(all[k]!.ts - all[k - 1]!.ts).toBe(14_400_000);
    expect(all.at(-1)).toEqual({ ts: Number(p1[0].fundingTime), rate: D.str(D.from(p1[0].fundingRate)), premium: D.str(D.from(p1[0].premiumIndex)) });
    const { a: b, calls: c2 } = make();
    const recent = await b.fundingHistory('ANTHROPICUSDC', { start: Number(p1[2].fundingTime), end: Number(p1[1].fundingTime) });
    expect(recent.map((x) => x.ts)).toEqual([Number(p1[2].fundingTime), Number(p1[1].fundingTime)]);
    expect(c2.filter((x) => x.url.includes('getFundingRatePage')).length).toBe(1);                      // the first page already reaches the start
  });
});

describe('edgeX trades (websocket only: there is no REST endpoint)', () => {
  it('without a websocket: a typed "unavailable" error, never an empty success', async () => {
    const { a } = make();
    const e = await fails(a.trades('ANTHROPICUSDC'), 'unsupported', /no REST endpoint/);
    expect(e).toBeInstanceOf(VenueUnavailable); expect((e as VenueUnavailable).reason).toBe('edgex_trades_unavailable');
  });

  it('a short-lived subscription returns the snapshot of recent trades, newest first; the next call is served from the stream cache', async () => {
    const { a } = make({ WebSocket: FakeSocket as never, sleep: (ms) => tick(ms) });
    const rec = wsFx('edgex', 'ws-public'), snap = rec.messages.find((m) => m.channel === `trades.${A}` && m.type === 'quote-event') as any;
    const p = a.trades('ANTHROPICUSDC', 10);
    await tick(5);
    const sock = FakeSocket.last;
    sock.serve({ type: 'connected', sid: 'x' });
    expect(sock.sent).toEqual([{ type: 'subscribe', channel: `trades.${A}` }]);
    sock.serve(snap);
    const t = await p;
    expect(t.length).toBe(10);
    for (const x of t) publicTrade.parse(x);
    for (let k = 1; k < t.length; k++) expect(t[k - 1]!.ts).toBeGreaterThanOrEqual(t[k]!.ts);
    const w = snap.content.data[0];
    expect(t[0]).toEqual({ instrument: 'edgex:ANTHROPICUSDC', price: D.str(D.from(w.price)), size: D.str(D.from(w.size)), side: w.isBuyerMaker ? 'sell' : 'buy', ts: Number(w.time), id: w.ticketId });
    expect((await a.trades('ANTHROPICUSDC')).length).toBe(snap.content.data.length);
    expect(sock.sent.length).toBe(1);                                                                   // no second subscription
  });

  it('a websocket that does not deliver in time, or refuses the channel: the same typed error (code unavailable)', async () => {
    const quiet = make({ WebSocket: FakeSocket as never, tradesWaitMs: 30, sleep: (ms) => tick(ms) });
    const e = await fails(quiet.a.trades('ANTHROPICUSDC'), 'unavailable', /in time/);
    expect((e as VenueUnavailable).reason).toBe('edgex_trades_unavailable');
    const refused = make({ WebSocket: FakeSocket as never, tradesWaitMs: 500, sleep: (ms) => tick(ms) });
    const p = refused.a.trades('ANTHROPICUSDC');
    await tick(5);
    FakeSocket.last.serve({ type: 'connected', sid: 'x' });
    FakeSocket.last.serve({ type: 'error', request: JSON.stringify({ type: 'subscribe', channel: `trades.${A}` }), content: { code: 'GATEWAY_INVALID_CHANNEL', msg: 'invalid channel' } });
    await fails(p, 'unavailable', /GATEWAY_INVALID_CHANNEL/);
  });
});

describe('edgeX error paths', () => {
  it('HTTP 429: rate_limited, then nothing is sent during the backoff, which doubles and ends', async () => {
    let limited = true, hits = 0;
    const { a, calls, clock } = make({ routes: [['/quote/getDepth', () => { hits += 1; return limited ? new Response('slow down', { status: 429 }) : new Response(F('depth-ANTHROPICUSDC-15').text, { status: 200 }); }]] });
    await a.instruments();
    await fails(a.book('ANTHROPICUSDC', 15), 'rate_limited', /429/);
    expect(hits).toBe(1);                                                                               // a 429 is not retried
    const before = calls.length;
    await fails(a.book('ANTHROPICUSDC', 15), 'rate_limited', /backing off .* 5 s/);
    await fails(a.candles('ANTHROPICUSDC', '1h', {}), 'rate_limited', /backing off/);                   // the backoff covers every endpoint
    expect(calls.length).toBe(before);
    expect(a.diagnostics().rateLimitedUntil).toBe(NOW + 5_000);
    clock.t += 5_001;
    await fails(a.book('ANTHROPICUSDC', 15), 'rate_limited', /429/);
    expect(a.diagnostics().rateLimitedUntil).toBe(clock.t + 10_000);                                    // doubled
    clock.t += 10_001; limited = false;
    expect((await a.book('ANTHROPICUSDC', 15)).bids.length).toBe(15);
  });

  it('a 429 during the ticker sweep stops the sweep at once', async () => {
    let n = 0;
    const { a } = make({ tickerConcurrency: 1, routes: [['/quote/getTicker', () => { n += 1; return new Response('', { status: 429 }); }]] });
    await fails(a.tickers(), 'rate_limited');
    expect(n).toBe(1);
  });

  it('an HTML body (the old host answers its web app with HTTP 200) is bad_answer, not a parse crash', async () => {
    expect(F('old-host-html').text).toMatch(/^<!DOCTYPE html>/);
    await fails(make({ routes: [['/meta/getMetaData', F('old-host-html')]] }).a.instruments(), 'bad_answer', /non-JSON answer \(HTTP 200\)/);
    await fails(make({ routes: [['/quote/getDepth', F('old-host-html')]] }).a.book('ANTHROPICUSDC'), 'bad_answer', /non-JSON/);
    await fails(make({ routes: [['/quote/getDepth', { status: 200, text: '{"hello":1}' }]] }).a.book('ANTHROPICUSDC'), 'bad_answer', /envelope/);
    await fails(make({ routes: [['/quote/getDepth', { status: 200, text: '{"code":"SUCCESS","data":[]}' }]] }).a.book('ANTHROPICUSDC'), 'bad_answer', /no book/);
  });

  it('a timeout or a 5xx is unavailable, after exactly one retry', async () => {
    let n = 0;
    const timeout = make({ routes: [['/quote/getDepth', () => { n += 1; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }]] });
    await fails(timeout.a.book('ANTHROPICUSDC'), 'unavailable', /network error/);
    expect(n).toBe(2);
    let m = 0;
    const flaky = make({ routes: [['/quote/getDepth', () => { m += 1; return m === 1 ? new Response('bad gateway', { status: 502 }) : new Response(F('depth-ANTHROPICUSDC-200').text, { status: 200 }); }]] });
    expect((await flaky.a.book('ANTHROPICUSDC')).asks.length).toBeGreaterThan(0);                      // the retry succeeded
    expect(m).toBe(2);
    const down = make({ retries: 0, routes: [['/quote/getDepth', { status: 503, text: 'maintenance' }]] });
    await fails(down.a.book('ANTHROPICUSDC'), 'unavailable', /HTTP 503/);
  });

  it('malformed numbers fail validation — they never become NaN', async () => {
    for (const bad of ['NaN', '1e3', '', ' 1', '0x10', 'Infinity', '1,5']) {
      // one unreadable listing is left out and reported — the others are still served; nothing readable at all is bad_answer
      const meta = make({ patch: (url, body) => { if (url.includes('getMetaData')) { body.data.contractList[0].tickSize = bad; return body; } return undefined; } });
      const gone = META.contractList[0].contractName, list = await meta.a.instruments();
      expect(list.map((i) => i.symbol)).not.toContain(gone); expect(list.length).toBe(5);
      expect(meta.a.diagnostics().skippedContracts).toEqual([{ contract: gone, reason: expect.stringMatching(/^tickSize /) }]);
      await fails(meta.a.book(gone), 'rejected', /unknown contract/);
      const allBad = make({ patch: (url, body) => { if (url.includes('getMetaData')) { for (const c of body.data.contractList) c.stepSize = bad; return body; } return undefined; } });
      await fails(allBad.a.instruments(), 'bad_answer', /no readable contract .*stepSize/);
      const depth = make({ patch: (url, body) => { if (url.includes('getDepth')) { body.data[0].asks[0].price = bad; return body; } return undefined; } });
      await fails(depth.a.book('ANTHROPICUSDC'), 'bad_answer', /price/);
      const kline = make({ patch: (url, body) => { if (url.includes('getKline')) { body.data.dataList[0].close = bad; return body; } return undefined; } });
      await fails(kline.a.candles('ANTHROPICUSDC', '1h', {}), 'bad_answer', /close/);
      const tk = make({ patch: (url, body) => { if (url.includes('getTicker')) { body.data[0].markPrice = bad; return body; } return undefined; } });
      await fails(tk.a.tickers(), 'bad_answer', /markPrice/);
    }
    const num = make({ patch: (url, body) => { if (url.includes('getFundingRatePage')) { body.data.dataList[0].fundingRate = 0.0001; return body; } return undefined; } });
    await fails(num.a.fundingHistory('ANTHROPICUSDC', { start: 0 }), 'bad_answer', /fundingRate/);    // a JSON number where a string is expected
    const time = make({ patch: (url, body) => { if (url.includes('getKline')) { body.data.dataList[0].klineTime = 'yesterday'; return body; } return undefined; } });
    await fails(time.a.candles('ANTHROPICUSDC', '1h', {}), 'bad_answer', /klineTime/);
  });

  it('one bad ticker does not hide the others in the REST sweep', async () => {
    const { a } = make({ patch: (url, body) => { if (url.includes(`getTicker?contractId=${ID.AAPLUSDC}`)) { body.data[0].markPrice = 'NaN'; return body; } return undefined; } });
    const list = await a.tickers();
    expect(list.map((t) => t.instrument)).not.toContain('edgex:AAPLUSDC');
    expect(list.length).toBe(5);
    for (const t of list) expect(Number.isNaN(Number(t.mark))).toBe(false);
  });
});

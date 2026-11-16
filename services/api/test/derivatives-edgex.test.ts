// V11 — edgeX in the derivatives READ routes, through the real server: the REAL edgeX adapter over answers recorded from its
// public endpoints (packages/derivatives/test/fixtures/edgex/), next to the three fixture-backed venues of the other tests.
// edgeX is market data only (its Terms of Use exclude Canada): the tests check that it is served, that trading and accounts
// are refused with that reason in French and in English, and that an edgeX that throws or times out degrades ALONE.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEdgeXAdapter, VenueError, type VenueAdapter } from '@spw/derivatives';
import { fx, replay, type Route } from '../../../packages/derivatives/test/venue-helpers.ts';
import { BTC, Clock, fixtureVenues, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', P = '/api/v1/derivatives';
const ANTH = 'edgex:ANTHROPICUSDC', NAMES = ['BTCUSDC', 'AAPLUSDC', 'SPYUSDC', 'XAUUSDC', 'USDJPYUSDC', 'ANTHROPICUSDC'];
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, d: import('../src/derivatives/index.ts').Derivatives, mod: typeof import('../src/derivatives/index.ts');
/** scripted failure of the edgeX venue: every request throws at once, or never answers until the adapter's own timeout aborts it */
const edgex = { mode: 'ok' as 'ok' | 'throw' | 'timeout', requests: [] as string[] };

async function api(method: 'GET' | 'POST', path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie };
  if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; headers['idempotency-key'] = `edgex-${Math.random().toString(36).slice(2, 12)}`; }
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const get = (path: string) => api('GET', path);
const q = (o: Record<string, string | number>) => `?${Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(String(x))}`).join('&')}`;

function edgexAdapter(now: () => number): VenueAdapter {
  const F = (n: string) => fx('edgex', n);
  const ids = Object.fromEntries((JSON.parse(F('metaData').text).data.contractList as any[]).map((c) => [c.contractName, c.contractId]));
  const routes: Route[] = [
    ['/meta/getMetaData', F('metaData')], ['/contract-labels', F('contract-labels')],
    ...NAMES.map((n): Route => [`getTicker?contractId=${ids[n]}`, F(`ticker-${n}`)]),
    [`getDepth?contractId=${ids.ANTHROPICUSDC}&level=15`, F('depth-ANTHROPICUSDC-15')], [`getDepth?contractId=${ids.ANTHROPICUSDC}&level=200`, F('depth-ANTHROPICUSDC-200')],
    [/getKline.*offsetData=/, F('kline-ANTHROPICUSDC-HOUR_1-p2')], ['/quote/getKline', F('kline-ANTHROPICUSDC-HOUR_1-p1')],
    [/getFundingRatePage.*offsetData=/, { status: 200, text: JSON.stringify({ code: 'SUCCESS', data: { dataList: [], nextPageOffsetData: '' } }) }], ['/funding/getFundingRatePage', F('funding-ANTHROPICUSDC-p1')],
  ];
  const r = replay(routes);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    edgex.requests.push(String(url));
    if (/private|account|order/i.test(String(url))) throw new Error('an edgeX private endpoint must never be called');
    if (edgex.mode === 'throw') throw new TypeError('fetch failed (scripted outage)');
    if (edgex.mode === 'timeout') return new Promise<Response>((_, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)); });   // never answers: only the adapter's timeout ends it
    return r.fetch(url, init);
  }) as unknown as typeof fetch;
  // no websocket in tests: tickers come from the REST fallback, trades are reported unavailable
  return createEdgeXAdapter({ fetch: fetchImpl, now, WebSocket: null, timeoutMs: 80, sleep: async () => {} });
}

beforeAll(async () => {
  await useDatabase('deriv_edgex');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await sql`truncate deriv_paper_accounts cascade`;
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  mod = await import('../src/derivatives/index.ts');
  clock = new Clock(Date.parse(fx('edgex', 'metaData').recordedAt) + 60_000); v = fixtureVenues(clock);
  d = mod.createDerivatives({ registry: mod.createRegistry({ ...v.adapters, edgex: edgexAdapter(clock.now) }, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: d });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); await sql?.end(); });

describe('edgeX is served as a market-data venue', () => {
  it('GET /venues: edgeX listed last, restricted, with the notice and the reason code; no account, no orders, no paper', async () => {
    const r = await get(P + '/venues');
    expect(r.status).toBe(200);
    expect(r.json.venues.map((x: any) => x.id)).toEqual(['hyperliquid', 'gmx', 'dydx', 'edgex']);
    const e = r.json.venues[3];
    expect(e).toMatchObject({ id: 'edgex', name: 'edgeX', network: 'mainnet', status: 'ok', paper: false, orderBook: true });
    expect(e.restriction).toBe(mod.EDGEX_RESTRICTION);
    expect(e.restriction).toMatch(/^Trading unavailable: edgeX's terms exclude Canada\./);
    expect(e.capabilities).toMatchObject({ marketData: true, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false });
    expect(e.capabilities.notes[0]).toBe(e.restriction);
    expect(e.capabilities.notes.join(' ')).toContain('edgex_trading_restricted_jurisdiction'); expect(e.capabilities.notes.join(' ')).toContain('edgex_account_restricted_jurisdiction');
  });

  it('GET /instruments and /tickers: edgeX among the others, with its categories; French sentences on request', async () => {
    const all = await get(P + '/instruments');
    expect(all.json.errors).toEqual([]);
    expect(new Set(all.json.instruments.map((i: any) => i.venue))).toEqual(new Set(['hyperliquid', 'gmx', 'dydx', 'edgex']));
    const one = await get(P + `/instruments${q({ venue: 'edgex' })}`);
    expect(one.json.instruments.map((i: any) => i.symbol).sort()).toEqual([...NAMES].sort());
    expect(Object.fromEntries(one.json.instruments.map((i: any) => [i.symbol, i.category]))).toEqual({ BTCUSDC: 'crypto', AAPLUSDC: 'equity', SPYUSDC: 'equity', XAUUSDC: 'commodity', USDJPYUSDC: 'fx', ANTHROPICUSDC: 'pre_ipo' });
    const a = one.json.instruments.find((i: any) => i.id === ANTH);
    expect(a).toMatchObject({ base: 'ANTHROPIC', quote: 'USDC', collateral: 'USDC', tickSize: '0.001', lotSize: '0.01', minOrderSize: '0.03', maxLeverage: '5', fundingIntervalSec: 14_400, status: 'active' });
    expect(a.edgex).toMatchObject({ contractId: '30000192', makerFeeRate: '0.0004', takerFeeRate: '0.00045', isStock: true });
    const { hasFrench } = await import('../src/derivatives/market-texts.ts');
    const fr = (await get(P + `/instruments${q({ venue: 'edgex', locale: 'fr' })}`)).json.instruments.find((i: any) => i.id === ANTH);
    expect(hasFrench(a.settlement)).toBe(true); expect(hasFrench(a.markPriceMethod)).toBe(true);
    expect(fr.settlement).toMatch(/aucun droit sur le sous-jacent/); expect(fr.markPriceMethod).not.toBe(a.markPriceMethod);

    const t = await get(P + `/tickers${q({ venue: 'edgex' })}`);
    expect(t.json.tickers.length).toBe(6);
    const w = JSON.parse(fx('edgex', 'ticker-ANTHROPICUSDC').text).data[0];
    expect(t.json.tickers.find((x: any) => x.instrument === ANTH)).toMatchObject({ mark: w.markPrice, index: w.indexPrice, last: w.lastPrice, openInterest: w.openInterest, volume24h: w.value, nextFundingTs: Number(w.nextFundingTime), ts: clock.now() });
    expect((await get(P + '/tickers')).json.errors).toEqual([]);
  });

  it('GET /market, /candles, /funding: book and history are real; trades without a websocket are an explicit error, not an empty list passed off as data', async () => {
    const m = await get(P + `/market${q({ instrument: ANTH })}`);
    expect(m.status).toBe(200);
    expect(m.json.instrument.id).toBe(ANTH); expect(m.json.ticker.source).toBe('venue');
    expect(m.json.book.bids.length).toBe(20); expect(Number(m.json.book.bids[0][0])).toBeLessThan(Number(m.json.book.asks[0][0]));
    expect(m.json.trades).toEqual([]); expect(m.json.errors.trades).toMatch(/recent trades are unavailable/);
    const c = await get(P + `/candles${q({ instrument: ANTH, interval: '1h', limit: 10 })}`);
    expect(c.json.candles.length).toBe(10); expect(c.json.candles[1].ts - c.json.candles[0].ts).toBe(3_600_000);
    const f = await get(P + `/funding${q({ instrument: ANTH, hours: 48 })}`);
    expect(f.json.intervalSec).toBe(14_400); expect(f.json.history.length).toBe(5); expect(f.json.history[1].ts - f.json.history[0].ts).toBe(14_400_000);
  });

  it('GET /compare: the edgeX row carries the restriction; in French the notice and every note are translated', async () => {
    const en = (await get(P + `/compare${q({ base: 'ANTHROPIC' })}`)).json, fr = (await get(P + `/compare${q({ base: 'ANTHROPIC', locale: 'fr' })}`)).json;
    expect(en.errors).toEqual([]);
    expect(en.rows.map((r: any) => r.instrument)).toEqual([ANTH]);
    expect(en.rows[0]).toMatchObject({ venue: 'edgex', takerFeeBps: '4.5', maxLeverage: '5', collateral: 'USDC', restriction: mod.EDGEX_RESTRICTION, fundingVenue: { intervalSec: 14_400 } });
    expect(Number(en.rows[0].spreadBps)).toBeGreaterThan(0);
    const { hasFrench } = await import('../src/derivatives/market-texts.ts');
    expect(fr.rows[0].restriction).toMatch(/^Négociation indisponible : les conditions d’edgeX excluent le Canada\./);
    expect(hasFrench(en.rows[0].settlement)).toBe(true);
    for (const [k, n] of en.rows[0].notes.entries()) { expect(hasFrench(n), n).toBe(true); expect(fr.rows[0].notes[k]).not.toBe(n); }
  });

  it('the router lists edgeX-only assets as not available to the owner, and shows edgeX without ever ranking it', async () => {
    const a = (await get(P + '/route/assets')).json.assets.find((x: any) => x.base === 'ANTHROPIC');
    expect(a).toMatchObject({ candidateVenues: 0, venues: [{ venue: 'edgex', name: 'edgeX', instruments: [ANTH], restriction: mod.EDGEX_RESTRICTION }] });
    const { ROUTER_FACTS } = await import('@spw/derivatives'), { hasFrench } = await import('../src/derivatives/market-texts.ts');
    for (const s of [...Object.values(ROUTER_FACTS.edgex.terms), ROUTER_FACTS.edgex.maintenanceText]) expect(hasFrench(s), s).toBe(true);
    expect(ROUTER_FACTS.edgex.collateral.route).toMatch(/not offered/);
  });
});

describe('trading and accounts on edgeX are unavailable, with the reason — never simulated', () => {
  it('no account read, no paper account, no order: 403 venue_restricted with the notice; nothing reaches the venue', async () => {
    const before = edgex.requests.length;
    const w = await get(P + `/watch${q({ account: '0x46a3BA57e146A4906bc68759Fb7ad1E74d3B66f6', venue: 'edgex' })}`);
    expect(w.status).toBe(403); expect(w.json.error).toBe('venue_restricted'); expect(w.json.message).toMatch(/Trading unavailable: edgeX's terms exclude Canada/);
    const p = await api('POST', P + '/accounts', { venue: 'edgex', label: 'x', collateral: '1000' });
    expect(p.status).toBe(403); expect(p.json.error).toBe('venue_restricted'); expect(p.json.message).toContain('Canada');
    expect((await get(P + '/accounts')).json.accounts.filter((x: any) => x.venue === 'edgex')).toEqual([]);
    const direct = await d.registry.get('edgex').adapter.account('x').then(() => null, (e: any) => e);
    expect(direct).toMatchObject({ code: 'venue_restricted', status: 403 });
    expect(d.registry.accountAllowed('edgex')).toBe(false);
    expect('trading' in d.registry.get('edgex').adapter).toBe(false);
    expect(edgex.requests.length).toBe(before);
    expect(edgex.requests.every((u) => u.startsWith('https://edgex-prod-v2.edgex.exchange/api/v2/public/'))).toBe(true);
  });
});

describe('a failing edgeX degrades alone', () => {
  const others = ['hyperliquid', 'gmx', 'dydx'];
  /** past every cache bound: nothing old may stand in for the venue any more */
  const expire = () => clock.advance(3_600_001);

  it('edgeX throwing: the other venues still answer; edgeX is named in `errors` and its health drops', async () => {
    expire(); edgex.mode = 'throw';
    try {
      const i = await get(P + '/instruments');
      expect(i.status).toBe(200);
      expect(new Set(i.json.instruments.map((x: any) => x.venue))).toEqual(new Set(others));
      expect(i.json.errors).toMatchObject([{ venue: 'edgex' }]); expect(i.json.errors[0].message).toMatch(/edgex: network error/);
      const t = await get(P + '/tickers');
      expect(t.status).toBe(200); expect(new Set(t.json.tickers.map((x: any) => x.instrument.split(':')[0]))).toEqual(new Set(others)); expect(t.json.errors.map((e: any) => e.venue)).toEqual(['edgex']);
      const c = await get(P + '/compare');
      expect(c.status).toBe(200); expect(c.json.rows.length).toBeGreaterThan(0); expect(c.json.rows.some((r: any) => r.venue === 'edgex')).toBe(false); expect(c.json.errors.map((e: any) => e.venue)).toEqual(['edgex']);
      expect((await get(P + `/market${q({ instrument: BTC })}`)).status).toBe(200);
      const a = await get(P + '/route/assets');
      expect(a.status).toBe(200); expect(a.json.errors.map((e: any) => e.venue)).toEqual(['edgex']); expect(a.json.assets.some((x: any) => x.base === 'BTC')).toBe(true);
      // asked alone, edgeX fails as itself: a 503, never old data passed off as current
      const alone = await get(P + `/tickers${q({ venue: 'edgex' })}`);
      expect(alone.status).toBe(503); expect(alone.json.error).toBe('venue_unavailable');
      clock.advance(1_500); await get(P + '/instruments'); clock.advance(1_500); await get(P + '/instruments');
      const venues = (await get(P + '/venues')).json.venues;
      expect(Object.fromEntries(venues.map((x: any) => [x.id, x.status]))).toMatchObject({ hyperliquid: 'ok', gmx: 'ok', dydx: 'ok', edgex: 'down' });
      expect(venues[3].lastError).toMatch(/unavailable: edgex: network error/);
    } finally { edgex.mode = 'ok'; }
    clock.advance(1_500);
    expect((await get(P + '/instruments')).json.errors).toEqual([]);                                   // back as soon as it answers
    expect((await get(P + '/venues')).json.venues[3].status).toBe('ok');
  });

  it('edgeX timing out: its own request timeout ends the wait, the other venues are answered, the timeout is reported', async () => {
    expire(); edgex.mode = 'timeout';
    try {
      const t0 = Date.now(), i = await get(P + '/instruments'), took = Date.now() - t0;
      expect(i.status).toBe(200);
      expect(new Set(i.json.instruments.map((x: any) => x.venue))).toEqual(new Set(others));
      expect(i.json.errors.map((e: any) => e.venue)).toEqual(['edgex']); expect(i.json.errors[0].message).toMatch(/network error/);
      expect(took).toBeLessThan(2_000);                                                                 // 80 ms timeout × (1 try + 1 retry), not forever
      clock.advance(1_500);
      const t = await get(P + '/tickers');
      expect(t.status).toBe(200); expect(t.json.tickers.length).toBeGreaterThan(0); expect(t.json.errors.map((e: any) => e.venue)).toEqual(['edgex']);
    } finally { edgex.mode = 'ok'; }
  });

  it('an adapter that throws something that is not a VenueError is contained the same way', async () => {
    expire();
    const bad: VenueAdapter = { ...edgexAdapter(clock.now), instruments: async () => { throw new Error('boom'); }, tickers: async () => { throw new VenueError('bad_answer', 'edgex: HTML instead of JSON', { venue: 'edgex' }); } };
    const local = mod.createDerivatives({ registry: mod.createRegistry({ ...v.adapters, edgex: bad }, clock.now), now: clock.now });
    const all = await Promise.allSettled(local.registry.list().map((x) => local.data.instruments(x.id)));
    expect(all.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
    const tk = await Promise.allSettled(local.registry.list().map((x) => local.data.tickers(x.id)));
    expect(tk.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
    expect((tk[3] as PromiseRejectedResult).reason).toMatchObject({ code: 'venue_unavailable', status: 503 });
    expect(local.registry.health('edgex').status).toBe('degraded'); expect(local.registry.health('hyperliquid').status).toBe('ok');
    local.data.close();
  });
});

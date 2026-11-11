// Every route of the derivatives API contract (docs/v4/DERIVATIVES-ARCHITECTURE.md, wave 2) through the real server: owner
// session required, zod validation, happy paths on fixture-backed venue adapters; the market-data service (caches, stale
// bounds, venue health, comparison) and the shared stream. Database spw_deriv_test (created here if missing). No network.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BTC, Clock, DYDX_BTC, GMX_ACCOUNT, GMX_BTC, HL_ACCOUNT, T0, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', P = '/api/v1/derivatives';
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, d: import('../src/derivatives/index.ts').Derivatives, mod: typeof import('../src/derivatives/index.ts');
let seq = 0;
const key = () => `api-key-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function api(method: 'GET' | 'POST', path: string, body?: unknown, opts: { cookie?: string | null; idem?: string; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {};
  const c = opts.cookie === undefined ? cookie : opts.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET') { headers.origin = ORIGIN; if (opts.csrf !== false) headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const get = (path: string) => api('GET', path);
const q = (o: Record<string, string | number>) => `?${Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(String(x))}`).join('&')}`;

beforeAll(async () => {
  await useDatabase('deriv_api');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await sql`truncate deriv_paper_accounts cascade`;
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  d = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: d });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); await sql?.end(); });

describe('access', () => {
  it('every derivatives route needs the owner session; writes need the CSRF header', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const gets = ['/venues', '/instruments', '/tickers', `/market${q({ instrument: BTC })}`, `/candles${q({ instrument: BTC })}`, `/funding${q({ instrument: BTC })}`, `/stream${q({ instrument: BTC })}`,
      '/compare', '/accounts', `/accounts/${id}`, `/watch${q({ account: HL_ACCOUNT, venue: 'hyperliquid' })}`];
    for (const p of gets) expect((await api('GET', P + p, undefined, { cookie: null })).status, p).toBe(401);
    const posts = ['/accounts', `/accounts/${id}/policy`, `/accounts/${id}/orders/preview`, `/accounts/${id}/orders`, `/accounts/${id}/orders/abc/cancel`, `/accounts/${id}/close`, `/accounts/${id}/reset`];
    for (const p of posts) {
      expect((await api('POST', P + p, {}, { cookie: null, idem: key() })).status, p).toBe(401);
      expect((await api('POST', P + p, {}, { csrf: false, idem: key() })).status, p).toBe(403);
    }
    expect((await api('GET', P + '/venues', undefined, { cookie: 'spw=forged; __Host-spw=forged' })).status).toBe(401);
    expect(v.hl.calls).toEqual({});                                  // nothing reached a venue
  });
});

describe('venues and market data', () => {
  it('GET /venues: three venues, capabilities as offered, dYdX restricted to market data with the reason', async () => {
    const r = await get(P + '/venues');
    expect(r.status).toBe(200);
    expect(r.json.venues.map((x: any) => [x.id, x.network, x.status, x.paper, x.orderBook])).toEqual([['hyperliquid', 'mainnet', 'ok', true, true], ['gmx', 'mainnet', 'ok', false, false], ['dydx', 'mainnet', 'ok', false, true]]);
    const [hl, gmx, dydx] = r.json.venues;
    expect(hl).toMatchObject({ name: 'Hyperliquid', restriction: null, lastOkAt: T0 });
    expect(hl.capabilities).toMatchObject({ marketData: true, account: true, stream: true });
    expect(gmx.capabilities).toMatchObject({ marketData: true, account: true, stream: false, orders: false });
    expect(dydx.restriction).toContain('Canada'); expect(dydx.restriction).toContain('geoblocks');
    expect(dydx.capabilities).toMatchObject({ marketData: true, account: false, orders: false, orderTypes: [] });
    expect(dydx.capabilities.notes[0]).toBe(dydx.restriction);
    expect(r.json.bounds.tickers).toEqual({ ttl: 3000, maxAge: 15000 });
    expect(r.json.ts).toBe(T0);
  });

  it('GET /instruments: per venue or all, active first, cached 10 minutes', async () => {
    const hl = await get(P + '/instruments?venue=hyperliquid');
    expect(hl.status).toBe(200);
    expect(hl.json.instruments[0]).toMatchObject({ id: BTC, venue: 'hyperliquid', symbol: 'BTC', base: 'BTC', collateral: 'USDC', lotSize: '0.00001', minNotional: '10', fundingIntervalSec: 3600, status: 'active' });
    const st = hl.json.instruments.map((i: any) => i.status), firstHalted = st.indexOf('halted');
    expect(firstHalted).toBeGreaterThan(0);
    expect(st.slice(firstHalted).every((s: string) => s === 'halted')).toBe(true);
    const metaCalls = v.hl.calls.meta;
    clock.advance(9 * 60_000);
    expect((await get(P + '/instruments?venue=hyperliquid')).json.ts).toBe(hl.json.ts);
    expect(v.hl.calls.meta).toBe(metaCalls);                          // served from the cache
    clock.advance(61_000);
    expect((await get(P + '/instruments?venue=hyperliquid')).json.ts).toBe(clock.t);
    const all = await get(P + '/instruments');
    expect(new Set(all.json.instruments.map((i: any) => i.venue))).toEqual(new Set(['hyperliquid', 'gmx', 'dydx']));
    expect(all.json.errors).toEqual([]);
    expect(all.json.instruments.find((i: any) => i.id === GMX_BTC)).toMatchObject({ base: 'BTC', collateral: 'BTC or USDC', marginModes: ['isolated'] });
    expect(all.json.instruments.find((i: any) => i.id === DYDX_BTC)).toMatchObject({ base: 'BTC', tickSize: '1', lotSize: '0.0001' });
    expect((await get(P + '/instruments?venue=binance')).status).toBe(404);
    expect((await get(P + `/instruments?venue=${'x'.repeat(50)}`)).status).toBe(400);
  });

  it('GET /tickers: cached at most 3 s, every ticker and the answer carry their time', async () => {
    setMarket(v, 50_000);
    clock.advance(4_000);
    const a = await get(P + '/tickers?venue=hyperliquid');
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ ts: clock.t, source: 'venue' });
    expect(a.json.tickers.find((t: any) => t.instrument === BTC)).toEqual({ instrument: BTC, mark: '50000', index: '50000', mid: '50000', funding: '0.0000125', openInterest: expect.any(String), volume24h: expect.any(String), change24h: expect.any(String), ts: clock.t });
    const calls = v.hl.calls.metaAndAssetCtxs, t1 = clock.t;
    setMarket(v, 50_100); clock.advance(2_900);
    const b = await get(P + '/tickers?venue=hyperliquid');
    expect(b.json.ts).toBe(t1); expect(v.hl.calls.metaAndAssetCtxs).toBe(calls);                 // within 3 s: the cached answer, with its own time
    clock.advance(200);
    const c = await get(P + '/tickers?venue=hyperliquid');
    expect(c.json.ts).toBe(clock.t);
    expect(c.json.tickers.find((t: any) => t.instrument === BTC).mark).toBe('50100');
    const all = await get(P + '/tickers');
    expect(all.json.errors).toEqual([]);
    expect(all.json.tickers.find((t: any) => t.instrument === DYDX_BTC)).toMatchObject({ mid: null });
    expect(all.json.tickers.find((t: any) => t.instrument === GMX_BTC)).toMatchObject({ mid: null });
    expect((await get(P + '/tickers?venue=nope')).status).toBe(404);
  });

  it('GET /market: ticker, book and trades on a book venue; liquidity instead of a book on GMX', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const m = await get(P + `/market${q({ instrument: BTC })}`);
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ instrument: { id: BTC }, ticker: { mark: '50000', source: 'venue', ts: clock.t }, liquidity: null, errors: {}, ts: clock.t, source: 'venue' });
    expect(m.json.book).toEqual({ instrument: BTC, bids: [['49995', '1'], ['49990', '2']], asks: [['50005', '1'], ['50010', '2']], ts: clock.t, source: 'venue' });
    expect(m.json.trades.length).toBeGreaterThan(0);
    expect(m.json.trades[0]).toMatchObject({ instrument: BTC, price: expect.any(String), side: expect.stringMatching(/^(buy|sell)$/) });
    expect(m.json.trades[0].ts).toBeGreaterThanOrEqual(m.json.trades.at(-1).ts);
    const g = await get(P + `/market${q({ instrument: GMX_BTC })}`);
    expect(g.status).toBe(200);
    expect(g.json.book).toBeNull();
    expect(g.json.liquidity).toMatchObject({ instrument: GMX_BTC, source: 'venue', capacityLongUsd: expect.any(String), priceImpact: { factorNegative: expect.any(String) }, positionFeeFactor: { balanceImproved: '0.0004', balanceNotImproved: '0.0006' } });
    expect(g.json.ticker.mid).toBeNull();
    const dy = await get(P + `/market${q({ instrument: DYDX_BTC })}`);
    expect(dy.json.book.bids[0]).toEqual(['73587', '0.1358']);
    expect(dy.json.book.bids.length).toBeLessThanOrEqual(20);
    expect((await get(P + `/market${q({ instrument: 'hyperliquid:NOPE' })}`)).status).toBe(404);
    expect((await get(P + `/market${q({ instrument: 'nowhere:BTC' })}`)).status).toBe(404);
    expect((await get(P + `/market${q({ instrument: 'BTC' })}`)).json.error).toBe('bad_instrument');
    expect((await get(P + '/market')).status).toBe(400);
  });

  it('GET /candles and GET /funding', async () => {
    const c = await get(P + `/candles${q({ instrument: BTC, interval: '1h', limit: 5 })}`);
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ instrument: BTC, interval: '1h', source: 'venue', ts: clock.t });
    expect(c.json.candles).toHaveLength(5);
    expect(c.json.candles[0]).toEqual({ ts: expect.any(Number), open: expect.any(String), high: expect.any(String), low: expect.any(String), close: expect.any(String), volume: expect.any(String) });
    expect(c.json.candles[4].ts).toBeGreaterThan(c.json.candles[0].ts);
    expect((await get(P + `/candles${q({ instrument: GMX_BTC, interval: '1h', limit: 3 })}`)).json.candles).toHaveLength(3);
    for (const bad of [{ instrument: BTC, interval: '2h' }, { instrument: BTC, limit: 0 }, { instrument: BTC, limit: 5000 }, { interval: '1h' }])
      expect((await get(P + `/candles${q(bad as never)}`)).status, JSON.stringify(bad)).toBe(400);
    expect((await get(P + `/candles${q({ instrument: 'hyperliquid:NOPE' })}`)).status).toBe(404);

    const f = await get(P + `/funding${q({ instrument: BTC, hours: 24 })}`);
    expect(f.status).toBe(200);
    expect(f.json).toMatchObject({ instrument: BTC, intervalSec: 3600, source: 'venue' });
    expect(f.json.history.length).toBeGreaterThan(0);
    expect(f.json.history[0]).toEqual({ ts: expect.any(Number), rate: expect.stringMatching(/^-?\d+(\.\d+)?$/) });
    expect((await get(P + `/funding${q({ instrument: DYDX_BTC, hours: 48 })}`)).json).toMatchObject({ intervalSec: 3600 });
    for (const bad of [{ instrument: BTC, hours: 0 }, { instrument: BTC, hours: 481 }, { instrument: BTC, hours: 'x' }, { hours: 2 }])
      expect((await get(P + `/funding${q(bad as never)}`)).status, JSON.stringify(bad)).toBe(400);
  });

  it('GET /compare: one row per instrument, funding per hour with the venue interval, spread and depth from the real book, null on GMX — a table, not advice', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const r = await get(P + '/compare?base=btc');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ base: 'BTC', errors: [], ts: clock.t });
    const hl = r.json.rows.find((x: any) => x.venue === 'hyperliquid'), dy = r.json.rows.find((x: any) => x.venue === 'dydx'), gm = r.json.rows.filter((x: any) => x.venue === 'gmx');
    expect(Object.keys(hl).sort()).toEqual(['collateral', 'depthAskUsd1pct', 'depthBidUsd1pct', 'depthUsd1pct', 'funding', 'fundingVenue', 'index', 'instrument', 'mark', 'maxLeverage', 'notes', 'restriction', 'settlement',
      'source', 'spreadBps', 'takerFeeBps', 'ts', 'venue'].sort());
    expect(hl).toMatchObject({ instrument: BTC, mark: '50000', index: '50000', funding: '0.0000125', fundingVenue: { rate: '0.0000125', intervalSec: 3600 }, spreadBps: '2', depthBidUsd1pct: '149975', depthAskUsd1pct: '150025',
      depthUsd1pct: '300000', takerFeeBps: '4.5', maxLeverage: '40', collateral: 'USDC', restriction: null, source: 'venue' });
    expect(hl.notes.join(' ')).toMatch(/lower bound/);                 // the two-level book ends before 1 %
    expect(dy).toMatchObject({ instrument: DYDX_BTC, takerFeeBps: '5', maxLeverage: '50', collateral: 'USDC' });
    expect(dy.restriction).toContain('Canada');
    expect(Number(dy.spreadBps)).toBeGreaterThan(0); expect(Number(dy.depthUsd1pct)).toBeGreaterThan(0);
    expect(gm.length).toBeGreaterThan(1);                              // one instrument per pool
    const pool = gm.find((x: any) => x.instrument === GMX_BTC);
    expect(pool).toMatchObject({ spreadBps: null, depthUsd1pct: null, depthBidUsd1pct: null, depthAskUsd1pct: null, takerFeeBps: '6', fundingVenue: { intervalSec: 3600 } });
    expect(pool.notes.join(' ')).toMatch(/Capacity still open: long \d+ USD/);
    expect(pool.notes.join(' ')).toMatch(/Price impact/);
    expect(JSON.stringify(r.json)).not.toMatch(/recommend|best|cheapest|winner/i);
    expect(r.json.rows.map((x: any) => x.venue)).toEqual([...r.json.rows.map((x: any) => x.venue)].sort((a: string, b: string) => ['hyperliquid', 'gmx', 'dydx'].indexOf(a) - ['hyperliquid', 'gmx', 'dydx'].indexOf(b)));
    expect((await get(P + '/compare?base=ZZZZ')).json).toMatchObject({ rows: [], errors: [] });
    expect((await get(P + '/compare?base=B/TC')).status).toBe(400);
  });

  // v8 hardening (D2): the server-authored sentences of the read routes follow `?locale=`
  it('GET /compare and /instruments follow ?locale=: default en is the same strings, fr translates every sentence and nothing else', async () => {
    const { hasFrench } = await import('../src/derivatives/market-texts.ts');
    const en = (await get(P + '/compare?base=btc')).json, dflt = (await get(P + '/compare?base=btc&locale=en')).json, fr = (await get(P + '/compare?base=btc&locale=fr')).json;
    expect(en.locale).toBe('en'); expect(fr.locale).toBe('fr');
    expect(dflt).toEqual(en);                                                                              // `en` is the default
    expect((await get(P + '/compare?base=btc&locale=de')).json.locale).toBe('en');                         // an unknown language is English, not an error
    const { locale: _l, ...enRest } = en;
    expect(enRest).toEqual(await d.data.compare('btc'));                                                   // default: the service's own answer, untouched
    expect(fr.rows.length).toBe(en.rows.length);
    for (const [i, r] of fr.rows.entries()) {
      const e = en.rows[i];
      const { settlement: _s, notes: _n, restriction: _r, collateral: _c, ...figures } = r, { settlement: _es, notes: _en, restriction: _er, collateral: _ec, ...enFigures } = e;
      expect(r.collateral).toBe(e.collateral.replace(' or ', ' ou '));                                     // symbols stay; only the « or » of a two-token collateral is a word
      expect(figures).toEqual(enFigures);                                                                  // codes, ids and numbers never change with the language
      expect(r.settlement).not.toBe(e.settlement);
      expect(r.notes.length).toBe(e.notes.length);
      for (const [k, n] of e.notes.entries()) { expect(hasFrench(n), n).toBe(true); expect(r.notes[k]).not.toBe(n); }   // every note the table shows has its French sentence
      if (e.restriction !== null) expect(r.restriction).not.toBe(e.restriction); else expect(r.restriction).toBeNull();
    }
    const hl = fr.rows.find((x: any) => x.venue === 'hyperliquid'), dy = fr.rows.find((x: any) => x.venue === 'dydx'), pool = fr.rows.find((x: any) => x.instrument === GMX_BTC);
    expect(hl.settlement).toMatch(/^Contrat perpétuel linéaire/); expect(hl.notes.join(' ')).toMatch(/borne inférieure/);
    expect(dy.restriction).toMatch(/exclu.*Canada/);
    const enPool = en.rows.find((x: any) => x.instrument === GMX_BTC);
    const figuresOf = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(',', '.'));
    expect(pool.notes.join(' ')).toMatch(/Capacité encore ouverte : long \d+ USD/); expect(enPool.collateral).toMatch(/ or /); expect(pool.collateral).toMatch(/^\S+ ou \S+$/);
    expect(pool.notes.map(figuresOf)).toEqual(enPool.notes.map(figuresOf));                                // the figures inside a sentence are carried over unchanged
    expect(JSON.stringify(fr)).not.toMatch(/recommand|meilleur|gagnant/i);

    const ie = (await get(P + '/instruments')).json, ifr = (await get(P + '/instruments?locale=fr')).json;
    expect(ie.locale).toBe('en'); expect(ifr.locale).toBe('fr'); expect(ifr.instruments.length).toBe(ie.instruments.length);
    for (const [i, x] of ifr.instruments.entries()) {
      const e = ie.instruments[i];
      expect({ ...x, settlement: e.settlement, markPriceMethod: e.markPriceMethod, collateral: e.collateral }).toEqual(e); expect(x.collateral).toBe(e.collateral.replace(' or ', ' ou '));
      expect(x.settlement).not.toBe(e.settlement); expect(x.markPriceMethod).not.toBe(e.markPriceMethod);
    }
    expect((await get(P + '/instruments?venue=gmx&locale=fr')).json.instruments[0].markPriceMethod).toMatch(/^pas de carnet d’ordres/);
  });

  it('GET /watch: a public address on Hyperliquid or GMX; refused on dYdX with the restriction text, without calling it', async () => {
    const r = await get(P + `/watch${q({ account: HL_ACCOUNT, venue: 'hyperliquid' })}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ venue: 'hyperliquid', account: HL_ACCOUNT, source: 'venue', ts: clock.t, state: { venue: 'hyperliquid', source: 'venue', equity: '6515.769962' } });
    expect(r.json.positions.map((p: any) => p.instrument).slice(0, 2)).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH']);
    expect(r.json.positions[0].source).toBe('venue');
    expect(r.json.openOrders).toHaveLength(7);
    const g = await get(P + `/watch${q({ account: GMX_ACCOUNT, venue: 'gmx' })}`);
    expect(g.status).toBe(200);
    expect(g.json.positions.length).toBeGreaterThan(0);
    expect(g.json.state).toMatchObject({ venue: 'gmx', freeCollateral: '0' });
    const dy = await get(P + `/watch${q({ account: 'dydx1zzz66hkkjy6apat9w2enw37484v3xhqnlducf7', venue: 'dydx' })}`);
    expect(dy.status).toBe(403);
    expect(dy.json.error).toBe('venue_restricted');
    expect(dy.json.message).toContain('Canada'); expect(dy.json.message).toContain('market data only');
    expect((await get(P + `/watch${q({ account: HL_ACCOUNT, venue: 'dydx' })}`)).status).toBe(403);
    expect(v.dydx.accountCalls).toBe(0);
    // even reaching past the routes, the adapter view refuses
    const direct = await d.registry.get('dydx').adapter.account('dydx1zzz66hkkjy6apat9w2enw37484v3xhqnlducf7').then(() => null, (e: any) => e);
    expect(direct).toMatchObject({ code: 'venue_restricted', status: 403 });
    expect(v.dydx.accountCalls).toBe(0);
    expect((await get(P + `/watch${q({ account: '0x1234', venue: 'hyperliquid' })}`)).json.error).toBe('bad_account');
    expect((await get(P + `/watch${q({ account: HL_ACCOUNT, venue: 'nope' })}`)).status).toBe(404);
    expect((await get(P + `/watch${q({ account: HL_ACCOUNT })}`)).status).toBe(400);
    // the read view exposes no trading object and no raw client
    for (const e of d.registry.list()) expect(Object.keys(e.adapter).filter((k) => /trading|http|loadTrading|close/i.test(k))).toEqual([]);
    expect(v.hl.calls.exchange).toBeUndefined();
  });
});

describe('paper account routes', () => {
  let id = '';
  it('POST /accounts creates a paper account; GET /accounts and /accounts/:id read it', async () => {
    for (const bad of [{}, { venue: 'hyperliquid', label: 'x' }, { venue: 'hyperliquid', label: '', collateral: '1000' }, { venue: 'hyperliquid', label: 'x', collateral: 'abc' }, { venue: 'hyperliquid', label: 'x', collateral: '-5' },
      { venue: 'hyperliquid', label: 'x', collateral: '5' }, { venue: 'hyperliquid', label: 'x', collateral: 1000 }, { venue: 'hyperliquid', label: 'x', collateral: '1000', mode: 'MANUAL_LIVE' },
      { venue: 'hyperliquid', label: 'x', collateral: '1000', policy: { maxLeverage: '-1' } }, { venue: 'hyperliquid', label: 'x', collateral: '1000', policy: { unknown: 1 } }])
      expect((await api('POST', P + '/accounts', bad)).status, JSON.stringify(bad)).toBe(400);
    const dy = await api('POST', P + '/accounts', { venue: 'dydx', label: 'x', collateral: '1000' });
    expect(dy.status).toBe(403); expect(dy.json.error).toBe('venue_restricted'); expect(dy.json.message).toContain('Canada');
    expect((await api('POST', P + '/accounts', { venue: 'gmx', label: 'x', collateral: '1000' })).json.error).toBe('paper_unsupported');
    expect((await api('POST', P + '/accounts', { venue: 'hyperliquid', label: 'x', collateral: '1000', policy: { mode: 'MANDATE_LIVE' } })).json.error).toBe('live_not_available');

    const r = await api('POST', P + '/accounts', { venue: 'hyperliquid', label: 'Main paper', collateral: '10000' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ venue: 'hyperliquid', network: 'mainnet', kind: 'paper', mode: 'PAPER', label: 'Main paper', policy: { mode: 'PAPER', maxLeverage: '3', halt: null },
      state: { equity: '10000', source: 'paper' }, positions: [], openOrders: [] });
    id = r.json.id;
    const list = await get(P + '/accounts');
    expect(list.json.accounts).toHaveLength(1);
    expect(Object.keys(list.json.accounts[0])).toEqual(expect.arrayContaining(['id', 'venue', 'network', 'kind', 'mode', 'label', 'policy', 'state', 'positions', 'openOrders']));
    const one = await get(P + `/accounts/${id}`);
    expect(one.status).toBe(200);
    expect(Object.keys(one.json)).toEqual(expect.arrayContaining(['orders', 'fills', 'funding', 'riskEvents', 'equity']));
    expect((await get(P + '/accounts/not-a-uuid')).status).toBe(400);
    expect((await get(P + '/accounts/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('POST /accounts/:id/orders/preview estimates without placing', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const body = { instrument: BTC, side: 'buy', type: 'market', size: '0.1', price: '50200', triggerPrice: null, reduceOnly: false, tif: 'ioc' };
    const r = await api('POST', P + `/accounts/${id}/orders/preview`, body);
    expect(r.status).toBe(200);
    expect(r.json.risk).toEqual({ ok: true });
    expect(Object.keys(r.json.estimate)).toEqual(expect.arrayContaining(['notional', 'initialMargin', 'fee', 'avgFillPrice', 'slippageBps', 'liquidationPrice', 'freeCollateralAfter']));
    expect(r.json.estimate).toMatchObject({ notional: '5000.5', fee: '2.250225', avgFillPrice: '50005', slippageBps: '1', source: 'estimate' });
    const lev = await api('POST', P + `/accounts/${id}/orders/preview`, { ...body, leverage: '2' });
    expect(lev.json.estimate).toMatchObject({ leverage: '2', initialMargin: '2500.25' });
    const refused = await api('POST', P + `/accounts/${id}/orders/preview`, { ...body, size: '0.5' });
    expect(refused.status).toBe(200);
    expect(refused.json.risk).toMatchObject({ ok: false, code: 'order_notional_exceeded', reason: expect.any(String) });
    for (const bad of [{}, { ...body, side: 'long' }, { ...body, size: '0' }, { ...body, size: 0.1 }, { ...body, size: '1e-3' }, { ...body, type: 'twap' }, { ...body, tif: 'fok' }, { ...body, clientId: 'x' }, { ...body, leverage: '0' },
      { ...body, slippageBps: 5000 }, { ...body, price: '-1' }])
      expect((await api('POST', P + `/accounts/${id}/orders/preview`, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await api('POST', P + '/accounts/00000000-0000-4000-8000-000000000000/orders/preview', body)).status).toBe(404);
    expect((await get(P + `/accounts/${id}`)).json).toMatchObject({ orders: [], positions: [] });
  });

  it('POST /accounts/:id/orders: Idempotency-Key required, risk engine then paper engine, refusals are 422 with the risk code', async () => {
    const body = { instrument: BTC, side: 'buy', type: 'market', size: '0.1', price: '50200', triggerPrice: null, reduceOnly: false, tif: 'ioc' };
    const noKey = await api('POST', P + `/accounts/${id}/orders`, body);
    expect(noKey.status).toBe(400); expect(noKey.json.error).toBe('idempotency');
    expect((await api('POST', P + `/accounts/${id}/orders`, body, { idem: 'short' })).json.error).toBe('idempotency');
    expect((await api('POST', P + `/accounts/${id}/orders`, { ...body, size: 'x' }, { idem: key() })).status).toBe(400);
    const k = key(), r = await api('POST', P + `/accounts/${id}/orders`, body, { idem: k });
    expect(r.status).toBe(200);
    expect(r.json.order).toMatchObject({ clientId: k, status: 'filled', filled: '0.1', avgFillPrice: '50005', instrument: BTC, side: 'buy', venueOrderId: 'paper-o-1' });
    expect(r.json.fills).toHaveLength(1);
    expect(r.json.fills[0]).toMatchObject({ price: '50005', size: '0.1', fee: '2.250225', clientId: k });
    const again = await api('POST', P + `/accounts/${id}/orders`, { ...body, size: '0.05' }, { idem: k });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ idempotent: true, order: r.json.order, fills: r.json.fills });
    for (const [patch, code] of [[{ size: '0.3' }, 'order_notional_exceeded'], [{ price: '60000' }, 'price_deviation'], [{ size: '0.000001' }, 'size_not_on_lot'], [{ instrument: 'hyperliquid:ATOM' }, null],
      [{ type: 'limit', price: '49900.5', tif: 'gtc' }, 'price_not_on_tick'], [{ leverage: '10' }, 'leverage_exceeded'], [{ reduceOnly: true }, 'reduce_only_would_increase']] as const) {
      const x = await api('POST', P + `/accounts/${id}/orders`, { ...body, ...patch }, { idem: key() });
      if (code === null) { expect(x.status).toBeGreaterThanOrEqual(400); continue; }
      expect(x.status, JSON.stringify(patch)).toBe(422);
      expect(x.json).toEqual({ error: code, message: expect.any(String) });
    }
    const a = (await get(P + `/accounts/${id}`)).json;
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0]).toMatchObject({ instrument: BTC, side: 'long', size: '0.1', source: 'paper' });
    expect(a.orders).toHaveLength(1); expect(a.fills).toHaveLength(1);
    expect(a.riskEvents.filter((e: any) => e.kind === 'order_refused').length).toBe(6);
    expect(a.equity.length).toBeGreaterThan(0);
  });

  it('POST …/orders/:clientId/cancel, /close, /policy, /reset', async () => {
    const k = key();
    const lim = await api('POST', P + `/accounts/${id}/orders`, { instrument: BTC, side: 'buy', type: 'limit', size: '0.05', price: '49900' }, { idem: k });
    expect(lim.json.order.status).toBe('open');
    expect((await get(P + '/accounts')).json.accounts[0].openOrders).toHaveLength(1);
    const c = await api('POST', P + `/accounts/${id}/orders/${k}/cancel`);
    expect(c.status).toBe(200); expect(c.json.order).toMatchObject({ clientId: k, status: 'cancelled' });
    expect((await api('POST', P + `/accounts/${id}/orders/unknown-order/cancel`)).status).toBe(404);
    expect((await api('POST', P + `/accounts/not-a-uuid/orders/${k}/cancel`)).status).toBe(400);

    for (const bad of [{}, { instrument: BTC }, { instrument: BTC, fraction: '0' }, { instrument: BTC, fraction: '1.5' }, { instrument: BTC, fraction: 0.5 }, { instrument: BTC, fraction: '0.5', extra: 1 }])
      expect((await api('POST', P + `/accounts/${id}/close`, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await api('POST', P + `/accounts/${id}/close`, { instrument: 'hyperliquid:ETH', fraction: '1' })).json.error).toBe('no_position');
    const half = await api('POST', P + `/accounts/${id}/close`, { instrument: BTC, fraction: '0.5' });
    expect(half.status).toBe(200);
    expect(half.json).toMatchObject({ worstPrice: '49746', slippageBoundBps: 50, order: { side: 'sell', type: 'market', reduceOnly: true, size: '0.05', status: 'filled', avgFillPrice: '49995' } });
    expect(half.json.fills).toHaveLength(1);
    const ck = key(), rest = await api('POST', P + `/accounts/${id}/close`, { instrument: BTC, fraction: '1', slippageBps: 100 }, { idem: ck });
    expect(rest.json).toMatchObject({ slippageBoundBps: 100, worstPrice: '49496', order: { size: '0.05', status: 'filled' } });
    expect((await api('POST', P + `/accounts/${id}/close`, { instrument: BTC, fraction: '1' }, { idem: ck })).json).toMatchObject({ idempotent: true, order: rest.json.order });
    expect((await get(P + `/accounts/${id}`)).json.positions).toEqual([]);

    const policy = (await get(P + `/accounts/${id}`)).json.policy;
    for (const bad of [{}, { ...policy, maxLeverage: '0' }, { ...policy, extra: true }, { ...policy, mode: 'TURBO' }, { maxLeverage: '2' }])
      expect((await api('POST', P + `/accounts/${id}/policy`, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await api('POST', P + `/accounts/${id}/policy`, { ...policy, mode: 'MANUAL_LIVE' })).json.error).toBe('live_not_available');
    const ro = await api('POST', P + `/accounts/${id}/policy`, { ...policy, mode: 'READ_ONLY', maxLeverage: '2' });
    expect(ro.status).toBe(200);
    expect(ro.json).toMatchObject({ mode: 'READ_ONLY', policy: { mode: 'READ_ONLY', maxLeverage: '2' } });
    const blocked = await api('POST', P + `/accounts/${id}/orders`, { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 50 }, { idem: key() });
    expect(blocked.status).toBe(422); expect(blocked.json.error).toBe('mode_read_only');
    expect((await api('POST', P + `/accounts/${id}/policy`, policy)).json.mode).toBe('PAPER');
    expect((await api('POST', P + '/accounts/00000000-0000-4000-8000-000000000000/policy', policy)).status).toBe(404);

    const reset = await api('POST', P + `/accounts/${id}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.json).toMatchObject({ state: { collateral: '10000', equity: '10000' }, orders: [], fills: [], positions: [] });
    expect((await api('POST', P + '/accounts/00000000-0000-4000-8000-000000000000/reset')).status).toBe(404);
    const types = (await sql`select type from audit_events where data->>'account' = ${id} order by seq`).map((x: any) => x.type);
    expect(types).toEqual(['deriv.paper.account_created', 'deriv.paper.order', 'deriv.paper.order', 'deriv.paper.cancel', 'deriv.paper.close', 'deriv.paper.close',
      'deriv.paper.policy_replaced', 'deriv.paper.policy_replaced', 'deriv.paper.reset']);
  });
});

describe('shared stream', () => {
  it('two listeners share one upstream; a gap is announced and followed by a fresh snapshot; the upstream closes with the last listener', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const inst = await d.data.instrument(BTC), opened = d.data.streamStats.opened, closed = d.data.streamStats.closed;
    const a: any[] = [], b: any[] = [];
    const offA = d.data.subscribe(inst, (e) => a.push(e));
    expect(v.hl.stream.open().map((s) => s.type).sort()).toEqual(['book', 'ticker', 'trades']);
    expect(v.hl.stream.open().every((s) => s.symbol === 'BTC')).toBe(true);
    expect(a[0]).toEqual({ event: 'status', data: { status: 'reconnecting', ts: clock.t } });      // not connected yet: said so
    v.hl.stream.status('connected');
    await settle();
    expect(a.map((e) => e.event)).toEqual(expect.arrayContaining(['status', 'ticker', 'book', 'trades']));
    expect(a.find((e) => e.event === 'ticker').data).toMatchObject({ instrument: BTC, mark: '50000', source: 'venue' });
    // a second listener: no new upstream; it is told the status and the last ticker and book at once
    const offB = d.data.subscribe(inst, (e) => b.push(e));
    expect(v.hl.stream.open()).toHaveLength(3);
    expect(d.data.streamStats.opened - opened).toBe(3);
    expect(d.data.listeners(BTC)).toBe(2);
    expect(b.map((e) => e.event)).toEqual(['status', 'ticker', 'book', 'trades']);
    expect(b[0].data.status).toBe('connected');
    // an upstream event reaches both
    a.length = 0; b.length = 0;
    v.hl.stream.emit({ type: 'ticker', ticker: { instrument: BTC, mark: '50010', index: '50000', mid: '50010', funding: '0.0000125', openInterest: '1', volume24h: '1', change24h: '0', ts: clock.t } });
    v.hl.stream.emit({ type: 'book', book: { instrument: BTC, bids: Array.from({ length: 30 }, (_, k) => [String(50000 - k), '1']), asks: Array.from({ length: 30 }, (_, k) => [String(50020 + k), '1']), ts: clock.t } });
    v.hl.stream.emit({ type: 'trades', trades: [{ instrument: BTC, price: '50010', size: '0.5', side: 'buy', ts: clock.t, id: 't1' }] });
    for (const l of [a, b]) {
      expect(l.map((e) => e.event)).toEqual(['ticker', 'book', 'trades']);
      expect(l[0].data.mark).toBe('50010');
      expect(l[1].data.bids).toHaveLength(20);                         // depth sent to listeners is capped
      expect(l[2].data.trades[0].id).toBe('t1');
    }
    // stale: both are told; back to connected: the status, then a fresh snapshot read from the venue
    a.length = 0; b.length = 0;
    v.hl.stream.status('stale');
    expect(a).toEqual([{ event: 'status', data: { status: 'stale', ts: clock.t } }]); expect(b).toEqual(a);
    setMarket(v, 50_300); clock.advance(1_000);
    const calls = v.hl.calls.metaAndAssetCtxs;
    v.hl.stream.status('connected');
    await settle();
    for (const l of [a, b]) {
      expect(l.map((e) => e.event).slice(0, 2)).toEqual(['status', 'status']);
      expect(l[1].data.status).toBe('connected');
      expect(l.find((e) => e.event === 'ticker').data.mark).toBe('50300');
      expect(l.find((e) => e.event === 'book').data.bids[0]).toEqual(['50295', '1']);
    }
    expect(v.hl.calls.metaAndAssetCtxs).toBe(calls! + 1);             // read again, not served from the cache
    // reconnecting: same
    a.length = 0; b.length = 0;
    v.hl.stream.status('reconnecting'); setMarket(v, 50_400); clock.advance(500); v.hl.stream.status('connected');
    await settle();
    expect(a.map((e) => e.data.status).filter(Boolean)).toEqual(['reconnecting', 'connected']);
    expect(b.find((e) => e.event === 'ticker').data.mark).toBe('50400');
    // one leaves: the upstream stays; the last leaves: closed
    offA();
    expect(v.hl.stream.open()).toHaveLength(3); expect(d.data.listeners(BTC)).toBe(1);
    offB(); offB();
    expect(v.hl.stream.open()).toHaveLength(0);
    expect(d.data.streamStats.closed - closed).toBe(3);
    expect(d.data.listeners(BTC)).toBe(0);
    // a later listener opens a new upstream
    const offC = d.data.subscribe(inst, () => {});
    expect(v.hl.stream.open()).toHaveLength(3);
    offC();
    expect(v.hl.stream.open()).toHaveLength(0);
  });

  it('GET /stream: Server-Sent Events to two clients over one upstream, closed when both disconnect; GMX is polled', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const connect = async (instrument: string) => {
      const ac = new AbortController();
      const res = await fetch(`${base}${P}/stream${q({ instrument })}`, { headers: { cookie }, signal: ac.signal });
      const reader = res.body!.getReader(), dec = new TextDecoder();
      let text = '';
      void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); } } catch { /* aborted */ } })();
      const events = () => text.split('\n\n').filter((x) => x.startsWith('event: ')).map((x) => ({ event: x.split('\n')[0]!.slice(7), data: JSON.parse(x.split('\n')[1]!.slice(6)) }));
      const until = async (pred: (e: ReturnType<typeof events>) => boolean) => { for (let k = 0; k < 80 && !pred(events()); k++) await settle(); return events(); };
      return { res, events, until, close: () => ac.abort() };
    };
    expect((await fetch(`${base}${P}/stream${q({ instrument: BTC })}`)).status).toBe(401);
    expect((await fetch(`${base}${P}/stream${q({ instrument: 'hyperliquid:NOPE' })}`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}${P}/stream`, { headers: { cookie } })).status).toBe(400);

    const one = await connect(BTC), two = await connect(BTC);
    expect(one.res.status).toBe(200);
    expect(one.res.headers.get('content-type')).toContain('text/event-stream');
    expect(v.hl.stream.open()).toHaveLength(3);                        // one upstream for the two clients
    v.hl.stream.status('connected');
    v.hl.stream.emit({ type: 'ticker', ticker: { instrument: BTC, mark: '50020', index: '50000', mid: '50020', funding: '0.0000125', openInterest: '1', volume24h: '1', change24h: '0', ts: clock.t } });
    for (const c of [one, two]) {
      const ev = await c.until((e) => e.some((x) => x.event === 'ticker' && x.data.mark === '50020') && e.some((x) => x.event === 'book'));
      expect(ev.map((x) => x.event), JSON.stringify(ev).slice(0, 600)).toContain('book');
      expect(ev[0]).toMatchObject({ event: 'status' });
      expect(ev.some((x) => x.event === 'status' && x.data.status === 'connected')).toBe(true);
      expect(ev.find((x) => x.event === 'book')!.data).toMatchObject({ instrument: BTC, source: 'venue' });
    }
    v.hl.stream.status('stale');
    for (const c of [one, two]) expect((await c.until((e) => e.some((x) => x.event === 'status' && x.data.status === 'stale'))).some((x) => x.data.status === 'stale')).toBe(true);
    one.close();
    for (let k = 0; k < 80 && d.data.listeners(BTC) !== 1; k++) await settle();
    expect(d.data.listeners(BTC)).toBe(1); expect(v.hl.stream.open()).toHaveLength(3);
    two.close();
    for (let k = 0; k < 80 && v.hl.stream.open().length; k++) await settle();
    expect(v.hl.stream.open()).toHaveLength(0);                        // upstream closed after the last client left

    const g = await connect(GMX_BTC);
    const ev = await g.until((e) => e.some((x) => x.event === 'ticker'));
    expect(ev.some((x) => x.event === 'status' && x.data.status === 'connected')).toBe(true);
    expect(ev.find((x) => x.event === 'ticker')!.data).toMatchObject({ instrument: GMX_BTC, source: 'venue' });
    g.close();
    for (let k = 0; k < 80 && d.data.listeners(GMX_BTC); k++) await settle();
    expect(d.data.listeners(GMX_BTC)).toBe(0);
  });
});

describe('a venue that fails', () => {
  it('degraded then down; data is served with its real time inside the stated bound and refused with 503 beyond it', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const fresh = await get(P + '/tickers?venue=hyperliquid');
    expect(fresh.json.ts).toBe(clock.t);
    const t0 = clock.t;
    await get(P + `/market${q({ instrument: BTC })}`);
    v.hl.down = true;
    // 5 s later: the venue fails, the 5-second-old tickers are served — stamped with the time they were read, not now
    clock.advance(5_000);
    const old = await get(P + '/tickers?venue=hyperliquid');
    expect(old.status).toBe(200);
    expect(old.json.ts).toBe(t0);
    expect(old.json.tickers.find((t: any) => t.instrument === BTC).ts).toBe(t0);
    expect((await get(P + '/venues')).json.venues[0]).toMatchObject({ id: 'hyperliquid', status: 'degraded', lastOkAt: t0 });
    // the book is bounded at 10 s, the tickers at 15 s
    clock.advance(6_000);
    const m = await get(P + `/market${q({ instrument: BTC })}`);
    expect(m.status).toBe(200);
    expect(m.json.ticker.ts).toBe(t0);
    expect(m.json.book).toBeNull();
    expect(m.json.errors.book).toMatch(/hyperliquid/);
    clock.advance(5_000);
    const gone = await get(P + '/tickers?venue=hyperliquid');
    expect(gone.status).toBe(503);
    expect(gone.json.error).toBe('venue_unavailable');
    expect((await get(P + `/market${q({ instrument: BTC })}`)).status).toBe(503);
    expect((await get(P + `/candles${q({ instrument: BTC, interval: '5m' })}`)).status).toBe(503);
    const venues = (await get(P + '/venues')).json.venues;
    expect(venues[0]).toMatchObject({ id: 'hyperliquid', status: 'down', lastOkAt: t0 });
    expect(venues[0].lastError).toMatch(/unavailable/);
    expect(venues.slice(1).map((x: any) => x.status)).toEqual(['ok', 'ok']);                      // the others are not affected
    // all venues at once: the healthy ones answer, the failing one is named
    const all = await get(P + '/tickers');
    expect(all.status).toBe(200);
    expect(all.json.errors.map((e: any) => e.venue)).toEqual(['hyperliquid']);
    expect(all.json.tickers.some((t: any) => t.instrument.startsWith('hyperliquid:'))).toBe(false);
    const cmp = await get(P + '/compare?base=BTC');
    expect(cmp.json.errors.map((e: any) => e.venue)).toEqual(['hyperliquid']);
    expect(cmp.json.rows.some((r: any) => r.venue === 'hyperliquid')).toBe(false);
    // paper orders need a live book: refused, nothing placed
    const acct = (await api('POST', P + '/accounts', { venue: 'hyperliquid', label: 'outage', collateral: '1000' })).json.id;
    const o = await api('POST', P + `/accounts/${acct}/orders`, { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 50 }, { idem: key() });
    expect(o.status).toBe(503);
    // back
    v.hl.down = false; clock.advance(2_000);
    expect((await get(P + '/tickers?venue=hyperliquid')).json.ts).toBe(clock.t);
    expect((await get(P + '/venues')).json.venues[0]).toMatchObject({ status: 'ok', lastOkAt: clock.t, lastError: null });

    // a book whose own timestamp is old is not a live book, even if the venue answers
    v.hl.bookAgeMs = 20_000; clock.advance(2_000);
    const stale = await get(P + `/market${q({ instrument: BTC })}`);
    expect(stale.json.book).toBeNull();
    expect(stale.json.errors.book).toMatch(/20 s old/);
    const so = await api('POST', P + `/accounts/${acct}/orders`, { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 50 }, { idem: key() });
    expect(so.status).toBe(503); expect(so.json.error).toBe('stale_data');
    v.hl.bookAgeMs = 0;
    expect((await get(P + `/accounts/${acct}`)).json.orders).toEqual([]);

    // the adapter's own rate-limit budget refusing requests: 503 with its own code; the venue is degraded, never reported down for it
    v.hl.rateLimited = true;
    for (let k = 0; k < 5; k++) { clock.advance(20_000); expect((await get(P + '/tickers?venue=hyperliquid')).json.error).toBe('venue_rate_limited'); }
    expect((await get(P + '/tickers?venue=hyperliquid')).status).toBe(503);
    expect((await get(P + '/venues')).json.venues[0].status).toBe('degraded');
    v.hl.rateLimited = false; clock.advance(2_000);
    expect((await get(P + '/tickers?venue=hyperliquid')).status).toBe(200);

    // GMX answering 502
    v.gmx.down = true; clock.advance(20_000);
    expect((await get(P + '/tickers?venue=gmx')).status).toBe(503);
    expect((await get(P + '/venues')).json.venues[1].status).not.toBe('ok');
    v.gmx.down = false; clock.advance(2_000);
    expect((await get(P + '/tickers?venue=gmx')).status).toBe(200);
  });
});

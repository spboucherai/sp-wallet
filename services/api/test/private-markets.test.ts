// V11 — Private Markets & Synthetic Valuation through the real server. The REAL Hyperliquid adapter replays the answers of
// the public info endpoint recorded on 2026-11-16 (packages/derivatives/test/fixtures/hyperliquid/builder-*.json) and the
// REAL edgeX adapter replays its recorded public answers. No network. The tests script what changes at a venue (annotation,
// category, a new instrument, an outage) and move the clock past the validity of the reviewed table.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEdgeXAdapter, createHyperliquidAdapter, type VenueAdapter } from '@spw/derivatives';
import { fx, replay, type Route } from '../../../packages/derivatives/test/venue-helpers.ts';
import { Clock, fixtureVenues, useDatabase } from './derivatives-helpers.ts';
import { COMPANIES, EXCLUDED_PUBLIC, REVIEWED_CONTRACTS, reviewState, reviewedContract, type LiveFingerprint } from '../src/private-markets/contracts.ts';
import { REFERENCE_VALUATIONS, lastPrivateValuation, toTradingReference } from '../src/private-markets/references.ts';

const P = '/api/v1/private-markets', T = '/api/v1/trading/private-markets';
const hlFx = (name: string): { recordedAt: string; body: any } => JSON.parse(readFileSync(new URL(`../../../packages/derivatives/test/fixtures/hyperliquid/${name}.json`, import.meta.url), 'utf8'));
const B = (n: string) => hlFx(`builder-${n}`);
const T0 = Date.parse(B('perpDexs').recordedAt) + 20_000;           // 2026-11-16 00:42 UTC: inside the validity of every reviewed entry
const ANNOT = B('perpAnnotation').body as Record<string, { attempts: any[] }>;

let app: any, sql: any, cookie = '', clock: Clock;
/** what the test changes at the venues */
const hl = { down: false, annotation: {} as Record<string, unknown>, categories: null as null | ((list: [string, string][]) => [string, string][]), calls: [] as string[] };
const edgex = { down: false };

function hyperliquidAdapter(now: () => number): VenueAdapter {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (!String(url).endsWith('/info')) throw new Error('only the public info endpoint may be called');
    const b = JSON.parse(String(init.body));
    hl.calls.push(b.type);
    if (hl.down) throw new TypeError('fetch failed (scripted outage)');
    const body = b.type === 'perpDexs' ? B('perpDexs').body : b.type === 'allPerpMetas' ? B('allPerpMetas').body
      : b.type === 'perpCategories' ? (hl.categories ? hl.categories(B('perpCategories').body) : B('perpCategories').body)
      : b.type === 'metaAndAssetCtxs' ? (b.dex ? B(`metaAndAssetCtxs-${b.dex}`).body : hlFx('mainnet-metaAndAssetCtxs').body) : b.type === 'meta' ? hlFx('mainnet-meta').body
      : b.type === 'perpAnnotation' ? (b.coin in hl.annotation ? hl.annotation[b.coin] : ANNOT[b.coin]?.attempts.at(-1) ?? null)
      : b.type === 'l2Book' ? B(`l2Book-${b.coin.replace(':', '-')}`).body : b.type === 'candleSnapshot' ? B(`candleSnapshot-${b.req.coin.replace(':', '-')}-${b.req.interval}`).body : undefined;
    if (body === undefined) throw new Error(`no fixture for ${b.type}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return createHyperliquidAdapter({ network: 'mainnet', fetch: fetchImpl, now, sleep: async () => {} });
}
function edgexAdapter(now: () => number): VenueAdapter {
  const F = (n: string) => fx('edgex', n), names = ['BTCUSDC', 'AAPLUSDC', 'SPYUSDC', 'XAUUSDC', 'USDJPYUSDC', 'ANTHROPICUSDC'];
  const ids = Object.fromEntries((JSON.parse(F('metaData').text).data.contractList as any[]).map((c) => [c.contractName, c.contractId]));
  const routes: Route[] = [['/meta/getMetaData', F('metaData')], ['/contract-labels', F('contract-labels')], ...names.map((n): Route => [`getTicker?contractId=${ids[n]}`, F(`ticker-${n}`)]),
    [`getDepth?contractId=${ids.ANTHROPICUSDC}&level=15`, F('depth-ANTHROPICUSDC-15')], [`getDepth?contractId=${ids.ANTHROPICUSDC}&level=200`, F('depth-ANTHROPICUSDC-200')],
    [/getKline.*offsetData=/, F('kline-ANTHROPICUSDC-HOUR_1-p2')], ['/quote/getKline', F('kline-ANTHROPICUSDC-HOUR_1-p1')]];
  const r = replay(routes);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (/private|account|order/i.test(String(url))) throw new Error('an edgeX private endpoint must never be called');
    if (edgex.down) throw new TypeError('fetch failed (scripted outage)');
    return r.fetch(url, init);
  }) as unknown as typeof fetch;
  return createEdgeXAdapter({ fetch: fetchImpl, now, WebSocket: null, timeoutMs: 80, sleep: async () => {} });
}

async function get(path: string) {
  const r = await app.inject({ method: 'GET', url: path, headers: { cookie } });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), body: r.body as string };
}
const byId = (json: any, id: string) => json.markets.find((m: any) => m.id === id);
/** past every cache bound (annotation: 1 h) — the next call reads everything again */
const flush = () => clock.advance(2 * 3_600_000);

beforeAll(async () => {
  await useDatabase('private_markets');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(T0);
  const v = fixtureVenues(clock);
  const d = mod.createDerivatives({ registry: mod.createRegistry({ gmx: v.adapters.gmx, dydx: v.adapters.dydx, hyperliquid: hyperliquidAdapter(clock.now), edgex: edgexAdapter(clock.now) }, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: d });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); await sql?.end(); });

describe('GET /api/v1/private-markets — live inventory', () => {
  it('needs the owner session', async () => { expect((await app.inject({ method: 'GET', url: P })).statusCode).toBe(401); });

  it('lists the pre-IPO contracts the venues categorise today, venue by venue, with the display-only notice', async () => {
    const r = await get(P);
    expect(r.status, r.body.slice(0, 300)).toBe(200);
    expect(r.json.markets.map((m: any) => m.id).sort()).toEqual(['edgex:ANTHROPICUSDC', 'hyperliquid:io:ANTH', 'hyperliquid:io:OAI', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:ANT', 'hyperliquid:xyz:OURA']);
    expect(r.json.venues).toMatchObject([{ venue: 'hyperliquid', status: 'ok', error: null, instruments: 5 }, { venue: 'edgex', status: 'ok', error: null, instruments: 1 }]);
    expect(r.json.notice).toMatchObject({ tradable: false, code: 'private_markets_display_only' }); expect(r.json.notice.text).toMatch(/not tradable from this wallet/); expect(r.json.notice.text).toMatch(/Canada/);
    expect(r.json.venuesWithoutAdapter.map((x: any) => x.venue)).toEqual(['Aster', 'Lighter', 'Polymarket Perps']);
    expect(r.json.cache.markets).toEqual({ ttl: 20_000, maxAge: 120_000 });
    for (const m of r.json.markets) {
      expect(m.tradable).toBe(false); expect(m.notTradable.reasons.length).toBeGreaterThan(0); expect(m.review.state).toBe('reviewed'); expect(m.error).toBeNull();
      // every market datum carries its source, its time and a stale flag
      for (const k of ['price', 'oracle', 'funding', 'openInterest', 'openInterestUsd', 'volume24h']) { expect(m.market[k].source, `${m.id} ${k}`).toBeTruthy(); expect(typeof m.market[k].ts).toBe('number'); expect(m.market[k].stale).toBe(false); }
      for (const k of ['nature', 'settlement', 'ipoConversion', 'oracle', 'liquidation', 'quoteCurrency', 'contractSize']) expect(m.contract[k], `${m.id} ${k}`).toBeTruthy();
      expect(m.contract.multiplier).toMatchObject({ value: '1' });
    }
    expect(r.json.markets.filter((m: any) => m.venue === 'hyperliquid').every((m: any) => m.notTradable.code === 'builder_dex_read_only')).toBe(true);
    expect(byId(r.json, 'edgex:ANTHROPICUSDC').notTradable.code).toBe('venue_restricted');
    expect(byId(r.json, 'hyperliquid:xyz:ANT').notTradable.reasons.join(' ')).toMatch(/trade\.xyz Terms of Use.*Canada/);
  });

  it('platform, symbol, contract metadata and market data of xyz:ANT are the recorded ones', async () => {
    const m = byId((await get(P)).json, 'hyperliquid:xyz:ANT');
    expect(m).toMatchObject({ venue: 'hyperliquid', platform: 'Hyperliquid · trade.xyz (dex xyz)', symbol: 'xyz:ANT', company: { slug: 'anthropic', name: 'Anthropic, PBC' }, status: 'live' });
    expect(m.contract).toMatchObject({ unit: { kind: 'usd_per_share' }, quoteCurrency: 'USD', collateral: 'USDC', maxLeverage: '10', margin: 'cross_allowed', szDecimals: 2, assetId: 110138, dex: 'xyz', oiCapUsd: '150000000', fundingMultiplier: '0.005', fundingIntervalSec: 3600 });
    expect(m.contract.onChainDescription).toMatch(/^ANT references 1 share of Anthropic/);
    expect(m.market.price.value).toBe('102.27'); expect(m.market.oracle.value).toBe('102'); expect(m.market.funding).toMatchObject({ value: '0.0000000625', intervalSec: 3600 });
    expect(m.market.openInterest.value).toBe('1088440.8199999982'); expect(m.market.volume24h.value).toBe('8681326.6791999917'); expect(m.market.frozen).toBe(false);
    expect(m.market.openInterestUsd.source).toMatch(/wallet arithmetic/);
  });

  it('public companies are excluded with the reason; delisted markets are not in the live list', async () => {
    const r = await get(P);
    expect(r.json.excluded.map((e: any) => e.id).sort()).toEqual(['hyperliquid:xyz:CBRS', 'hyperliquid:xyz:JIO', 'hyperliquid:xyz:QNT', 'hyperliquid:xyz:SKHY', 'hyperliquid:xyz:SPCX']);
    expect(r.json.excluded.find((e: any) => e.id === 'hyperliquid:xyz:SPCX')).toMatchObject({ company: 'SpaceX', liveCategory: 'stocks', reason: expect.stringMatching(/Nasdaq: SPCX.*Not a private market/) });
    expect(r.json.markets.some((m: any) => /SPCX|SPACEX|vntl/.test(m.id))).toBe(false);
    const d = await get(`${P}/hyperliquid:xyz:SPCX`);
    expect(d.status).toBe(404); expect(d.json.error).toBe('not_a_private_market');
  });
});

describe('valuation — five separate quantities', () => {
  it('io:ANTH (USD billions, formula in Entropy\'s documentation): implied valuation = price × 1e9, with formula, source and date', async () => {
    const m = byId((await get(`${P}?size=2.5&side=short`)).json, 'hyperliquid:io:ANTH'), v = m.valuation;
    expect(v.syntheticPrice).toMatchObject({ value: '1776.6', unit: 'valuation_usd_billions', priceKind: 'mark', stale: false });
    expect(v.contractMarketValue).toMatchObject({ value: '1776.6', reason: null }); expect(v.contractMarketValue.formula).toMatch(/price × 1 /);
    expect(v.notionalExposure).toMatchObject({ value: '-4441.5', hypothetical: true, position: { side: 'short', size: '2.5' } });
    expect(v.impliedValuation).toMatchObject({ value: '1776600000000', formulaId: 'price_x_1e9', reason: null, reasonCode: null, formulaSource: { url: 'https://docs.entropy.io/market-types/pre-ipo-perpetuals', readAt: '2026-11-15' } });
    expect(v.impliedValuation.formula).toMatch(/price × 1 000 000 000/); expect(v.impliedValuation.formulaSource.quote).toMatch(/a price of \$1 represents \$1B/); expect(v.impliedValuation.label).toMatch(/market-implied/);
    expect(v.impliedValuation.asOf).toBe(m.market.price.ts);
    expect(v.lastPrivateValuation).toMatchObject({ value: '965000000000', kind: 'primary_round', date: '2026-05-28', sourceUrl: 'https://www.anthropic.com/news/series-h', confidence: 'high' });
    expect(v.premiumDiscount.premiumBps).toBe('8410.3627');                       // 1776.6 / 965 − 1 = 84.10 %
    expect(v.premiumDiscount.caveat).toMatch(/different kinds and dates/);
  });
  it('io:OAI: valued, against the most recent round (reported, medium confidence)', async () => {
    const v = byId((await get(P)).json, 'hyperliquid:io:OAI').valuation;
    expect(v.impliedValuation.value).toBe('1313900000000');
    expect(v.lastPrivateValuation).toMatchObject({ value: '1250000000000', date: '2026-11-06', confidence: 'medium' });
    expect(v.premiumDiscount.premiumBps).toBe('511.2');
  });
  it('per-share contracts (xyz:ANT, para:ANTH, xyz:OURA): NO implied valuation, with the operator\'s reason; contract value and exposure are still given', async () => {
    const j = (await get(`${P}?size=10`)).json;
    for (const id of ['hyperliquid:xyz:ANT', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:OURA']) {
      const v = byId(j, id).valuation;
      expect(v.impliedValuation, id).toMatchObject({ value: null, formula: null, formulaId: null, reasonCode: 'per_share_no_share_count' }); expect(v.impliedValuation.reason).toMatch(/per share/);
      expect(v.premiumDiscount.premiumBps, id).toBeNull(); expect(v.premiumDiscount.reason).toMatch(/no implied valuation/);
      expect(v.contractMarketValue.value, id).toBe(byId(j, id).market.price.value);
      expect(v.lastPrivateValuation, id).not.toBeNull();                          // the reference is shown on its own
    }
    expect(byId(j, 'hyperliquid:xyz:ANT').valuation.notionalExposure.value).toBe('1022.7');
  });
  it('edgeX ANTHROPICUSDC: unit not published → null; the ×1e9 press convention is quoted as unconfirmed and never applied', async () => {
    const r = await get(P), m = byId(r.json, 'edgex:ANTHROPICUSDC'), v = m.valuation;
    expect(m.contract.unit).toEqual({ kind: 'unknown', label: 'unit not published by the venue' });
    expect(v.impliedValuation).toMatchObject({ value: null, reasonCode: 'unit_not_published', formulaSource: null }); expect(v.impliedValuation.reason).toMatch(/unit not published by the venue/);
    expect(v.premiumDiscount.premiumBps).toBeNull();
    expect(m.contract.unconfirmedConvention.text).toMatch(/Unconfirmed convention.*does not apply it/); expect(m.contract.unconfirmedConvention.url).toMatch(/^https:\/\//);
    expect(v.caveats.map((c: any) => c.code)).toContain('unconfirmed_convention');
    const price = m.market.price.value as string, times1e9 = String(BigInt(price.split('.')[0]!) * 10n ** 9n).slice(0, 4);
    for (const k of ['impliedValuation', 'premiumDiscount', 'contractMarketValue']) expect(JSON.stringify(v[k])).not.toMatch(new RegExp(`${times1e9}\\d{9}`));
    expect(v.contractMarketValue.value).toBe(price); expect(v.syntheticPrice.value).toBe(price);
    expect(v.caveats.find((c: any) => c.code === 'thin_market').text).toMatch(/Thin market/);
  });
  it('caveats: thin markets carry their open interest and volume; the same company on several venues is shown side by side, never averaged', async () => {
    const j = (await get(P)).json;
    const para = byId(j, 'hyperliquid:para:ANTH').valuation.caveats, xyz = byId(j, 'hyperliquid:xyz:ANT').valuation.caveats, io = byId(j, 'hyperliquid:io:ANTH').valuation.caveats;
    expect(para.find((c: any) => c.code === 'thin_market').data).toMatchObject({ volume24hUsd: '7654.77277', thresholds: { openInterestUsd: '1000000', volume24hUsd: '100000' } });
    expect(xyz.some((c: any) => c.code === 'thin_market')).toBe(false);
    const cross = io.find((c: any) => c.code === 'cross_venue');
    expect(cross.text).toMatch(/never averaged across venues/);
    expect(cross.data.others.map((o: any) => o.id).sort()).toEqual(['edgex:ANTHROPICUSDC', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:ANT']);
    expect(io.some((c: any) => c.code === 'unit_mismatch')).toBe(true);
    const anthropic = j.companies.find((c: any) => c.slug === 'anthropic');
    expect(anthropic.contracts.length).toBe(4);
    // a spread is computed only between contracts quoted in the SAME unit: 102.27 vs 101.87 per share
    expect(anthropic.divergence).toEqual([expect.objectContaining({ unit: 'usd_per_share', spreadBps: '39.27', contracts: [expect.objectContaining({ id: 'hyperliquid:para:ANTH', price: '101.87' }), expect.objectContaining({ id: 'hyperliquid:xyz:ANT', price: '102.27' })] })]);
    // no field anywhere blends two venues: every price in the answer is one venue's own
    const own = new Set(j.markets.flatMap((m: any) => [m.market.price.value, m.market.oracle.value, m.market.mid.value]));
    for (const c of j.companies) for (const d of c.divergence) for (const k of d.contracts) expect(own.has(k.price)).toBe(true);
    expect(JSON.stringify(j)).not.toMatch(/"(average|mean|blended|consensus)[A-Za-z]*":/i);
  });
});

describe('delisted filter', () => {
  it('?delisted=true lists only delisted markets, labelled, with frozen prices and no valuation', async () => {
    const r = await get(`${P}?delisted=true`);
    expect(r.status).toBe(200);
    expect(r.json.markets.map((m: any) => m.id)).toEqual(['hyperliquid:vntl:ANTHROPIC', 'hyperliquid:vntl:OPENAI']);
    expect(r.json.filter).toEqual({ delisted: true });
    for (const m of r.json.markets) {
      expect(m.status).toBe('delisted'); expect(m.market.frozen).toBe(true); expect(m.market.price.source).toMatch(/frozen: delisted/); expect(m.valuation.syntheticPrice.priceKind).toBe('frozen mark');
      expect(m.valuation.impliedValuation).toMatchObject({ value: null, reasonCode: 'delisted_frozen' }); expect(m.valuation.contractMarketValue.value).toBeNull(); expect(m.valuation.notionalExposure.value).toBeNull();
      expect(m.valuation.caveats.map((c: any) => c.code)).toContain('frozen');
    }
    expect(byId(r.json, 'hyperliquid:vntl:ANTHROPIC').market.price.value).toBe('1619.3');
    expect(JSON.stringify(r.json.markets.map((m: any) => m.valuation))).not.toContain('1619300000000');
    expect(r.json.excluded).toEqual([expect.objectContaining({ id: 'hyperliquid:vntl:SPACEX', company: 'SpaceX', delisted: true })]);   // SpaceX is public today
  });
});

describe('detail and company views', () => {
  it('GET /:id — valuation breakdown, top of book, candles, references, the other venues\' contracts', async () => {
    const r = await get(`${P}/hyperliquid:io:ANTH?size=3`);
    expect(r.status, r.body.slice(0, 300)).toBe(200);
    expect(r.json.market.id).toBe('hyperliquid:io:ANTH'); expect(r.json.market.valuation.notionalExposure.value).toBe('5329.8');
    expect(r.json.book.bids.length).toBe(5); expect(r.json.book.asks.length).toBe(5); expect(r.json.book.source).toMatch(/l2Book/);
    expect(r.json.candles).toMatchObject({ interval: '1h', stale: false }); expect(r.json.candles.candles.length).toBeGreaterThan(20);
    expect(r.json.references.map((x: any) => x.kind)).toEqual(['primary_round', 'ipo_range', 'press_estimate']);
    expect(r.json.sameCompany.map((x: any) => x.id).sort()).toEqual(['edgex:ANTHROPICUSDC', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:ANT']);
    expect(r.json.notice.tradable).toBe(false);
  });
  it('a delisted market is reachable by id, with its last daily candles and an empty book', async () => {
    const r = await get(`${P}/hyperliquid:vntl:ANTHROPIC`);
    expect(r.status).toBe(200); expect(r.json.market.status).toBe('delisted');
    expect(r.json.book).toMatchObject({ bids: [], asks: [] }); expect(r.json.candles.interval).toBe('1d');
    expect(new Date(r.json.candles.candles.at(-1).ts).toISOString().slice(0, 10)).toBe('2026-06-15');
  });
  it('edgeX detail; unknown ids and malformed ids', async () => {
    const r = await get(`${P}/edgex:ANTHROPICUSDC`);
    expect(r.status).toBe(200); expect(r.json.market.valuation.impliedValuation.value).toBeNull(); expect(r.json.candles.candles.length).toBeGreaterThan(0);
    expect((await get(`${P}/hyperliquid:xyz:NOPE`)).json.error).toBe('unknown_private_market');
    expect((await get(`${P}/hyperliquid:BTC`)).status).toBe(404);
    expect((await get(`${P}/not an id`)).status).toBe(400);
    expect((await get(`${P}?size=-1`)).status).toBe(400); expect((await get(`${P}?size=0`)).status).toBe(400); expect((await get(`${P}?side=up`)).status).toBe(400);
  });
  it('GET /companies/:slug — all venues side by side, delisted apart, nothing merged', async () => {
    const r = await get(`${P}/companies/anthropic`);
    expect(r.status).toBe(200);
    expect(r.json.contracts.map((m: any) => m.id).sort()).toEqual(['edgex:ANTHROPICUSDC', 'hyperliquid:io:ANTH', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:ANT']);
    expect(r.json.delisted.map((m: any) => m.id)).toEqual(['hyperliquid:vntl:ANTHROPIC']);
    expect(r.json.merged).toBeNull(); expect(r.json.mergedReason).toMatch(/no average/);
    expect(r.json.references.length).toBe(3); expect(r.json.lastPrivateValuation.value).toBe('965000000000'); expect(r.json.company.note).toMatch(/18 Nov 2026/);
    expect(r.json.contracts.filter((m: any) => m.valuation.impliedValuation.value !== null).map((m: any) => m.id)).toEqual(['hyperliquid:io:ANTH']);
    expect((await get(`${P}/companies/spacex`)).json.error).toBe('unknown_company');
  });
  it('the trading API serves the same answers under markets:read (owner session here; key scopes in trading-api.test.ts)', async () => {
    const spec = await import('../src/trading-api/spec.ts');
    for (const id of ['listPrivateMarkets', 'getPrivateMarket', 'getPrivateMarketCompany']) expect(spec.operation(id)).toMatchObject({ scope: 'markets:read', method: 'GET', implemented: true });
    const list = await get(T), det = await get(`${T}/hyperliquid:io:ANTH`), co = await get(`${T}/companies/openai`);
    expect(list.status).toBe(200); expect(det.status).toBe(200); expect(co.status).toBe(200);
    expect(spec.operation('listPrivateMarkets').response!.safeParse(list.json).success).toBe(true);
    expect(spec.operation('getPrivateMarket').response!.safeParse(det.json).success).toBe(true);
    expect(spec.operation('getPrivateMarketCompany').response!.safeParse(co.json).success).toBe(true);
    expect(byId(list.json, 'hyperliquid:io:ANTH').valuation.impliedValuation.value).toBe('1776600000000');
    expect((await app.inject({ method: 'GET', url: T })).statusCode).toBe(401);
  });
});

describe('the reviewed table against the live venue', () => {
  it('annotation text changed since the review → definition under review, NO valuation (the price is still shown)', async () => {
    flush(); hl.annotation['io:ANTH'] = { ...ANNOT['io:ANTH']!.attempts[0], description: 'ANTH now references 1 share of Anthropic.' };
    const m = byId((await get(P)).json, 'hyperliquid:io:ANTH');
    expect(m.review).toMatchObject({ state: 'under_review', fingerprintChecked: true }); expect(m.review.reasons.join(' ')).toMatch(/on-chain description of the market changed/);
    expect(m.valuation.impliedValuation).toMatchObject({ value: null, reasonCode: 'under_review' }); expect(m.valuation.impliedValuation.reason).toMatch(/definition under review/);
    expect(m.valuation.premiumDiscount.premiumBps).toBeNull(); expect(m.market.price.value).toBe('1776.6'); expect(m.notTradable.reasons.join(' ')).toMatch(/not confirmed/);
    delete hl.annotation['io:ANTH'];
  });
  it('annotation unreadable (null on every attempt) → under review, never read as "unchanged"', async () => {
    flush(); hl.annotation['io:OAI'] = null;
    const m = byId((await get(P)).json, 'hyperliquid:io:OAI');
    expect(m.review.state).toBe('under_review'); expect(m.review.reasons.join(' ')).toMatch(/could not be read/); expect(m.valuation.impliedValuation.value).toBeNull();
    delete hl.annotation['io:OAI'];
  });
  it('category changed (the deployer converts the market to a stock) → under review, no valuation', async () => {
    flush(); hl.categories = (list) => list.map(([c, k]) => (c === 'io:ANTH' ? [c, 'stocks'] : [c, k]));
    const m = byId((await get(P)).json, 'hyperliquid:io:ANTH');
    expect(m.review.state).toBe('under_review'); expect(m.review.reasons.join(' ')).toMatch(/no longer categorises this market as pre-IPO.*stocks/); expect(m.valuation.impliedValuation.value).toBeNull();
    hl.categories = null;
  });
  it('an instrument the venue categorises pre-IPO but absent from the table → listed with its market data, "not reviewed", no valuation', async () => {
    const other = (B('metaAndAssetCtxs-io').body[0].universe as any[]).find((u) => !u.isDelisted && !['io:ANTH', 'io:OAI'].includes(u.name)).name as string;
    expect(reviewedContract(`hyperliquid:${other}`)).toBeNull();
    flush(); hl.categories = (list) => [...list.filter(([c]) => c !== other), [other, 'preipo']];
    const r = await get(P), m = byId(r.json, `hyperliquid:${other}`);
    expect(m).toBeTruthy();
    expect(m.review).toMatchObject({ state: 'not_reviewed', reviewedAt: null }); expect(m.review.reasons[0]).toMatch(/contract definition not reviewed — no valuation/);
    expect(m.company).toBeNull(); expect(m.contract.unit.kind).toBe('unknown');
    expect(m.market.price.value).toBeTruthy(); expect(m.market.price.stale).toBe(false);          // market data is live
    expect(m.valuation.impliedValuation).toMatchObject({ value: null, reasonCode: 'not_reviewed' }); expect(m.valuation.lastPrivateValuation).toBeNull(); expect(m.valuation.premiumDiscount.premiumBps).toBeNull();
    hl.categories = null;
  });
});

describe('per-venue failure isolation and explicit cache ages', () => {
  it('within the cache bound an unreachable venue is served stale and flagged; edgeX is unaffected', async () => {
    flush(); expect((await get(P)).json.venues[0].status).toBe('ok');
    hl.down = true; clock.advance(30_000);                                                       // past the 20 s ttl, inside the 120 s bound
    const r = await get(P), m = byId(r.json, 'hyperliquid:io:ANTH');
    expect(r.status).toBe(200); expect(r.json.venues[0]).toMatchObject({ venue: 'hyperliquid', status: 'stale' });
    expect(m.market.price).toMatchObject({ value: '1776.6', stale: true }); expect(m.valuation.caveats.map((c: any) => c.code)).toContain('stale');
    expect(r.json.ts - m.market.price.ts).toBe(30_000);                                          // the datum keeps the time it was read
    expect(byId(r.json, 'edgex:ANTHROPICUSDC').error).toBeNull();
  });
  it('Hyperliquid down beyond the bound: its rows carry the error and no price, edgeX still answers', async () => {
    flush();
    const r = await get(P);
    expect(r.status).toBe(200);
    expect(r.json.venues).toMatchObject([{ venue: 'hyperliquid', status: 'error', error: expect.stringMatching(/network error/) }, { venue: 'edgex', status: 'ok' }]);
    const hlRows = r.json.markets.filter((m: any) => m.venue === 'hyperliquid');
    expect(hlRows.map((m: any) => m.id).sort()).toEqual(['hyperliquid:io:ANTH', 'hyperliquid:io:OAI', 'hyperliquid:para:ANTH', 'hyperliquid:xyz:ANT', 'hyperliquid:xyz:OURA']);
    for (const m of hlRows) { expect(m.error).toMatch(/network error/); expect(m.market.price.value).toBeNull(); expect(m.valuation.impliedValuation).toMatchObject({ value: null, reasonCode: 'no_price' }); expect(m.review.fingerprintChecked).toBe(false); }
    const ex = byId(r.json, 'edgex:ANTHROPICUSDC');
    expect(ex.error).toBeNull(); expect(ex.market.price.value).toBeTruthy();
    // no cross-fill: the Anthropic rows of the failing venue did not borrow edgeX's price
    expect(hlRows.every((m: any) => m.valuation.syntheticPrice.value === null)).toBe(true);
    expect((await get(`${P}/companies/anthropic`)).status).toBe(200);
    const det = await get(`${P}/hyperliquid:io:ANTH`);
    expect(det.status).toBe(200); expect(det.json.book.error).toBeTruthy(); expect(det.json.market.error).toBeTruthy();
    hl.down = false;
  });
  it('edgeX down: its row carries the error, Hyperliquid answers with valuations', async () => {
    flush(); edgex.down = true;
    const r = await get(P);
    expect(r.status).toBe(200);
    expect(r.json.venues).toMatchObject([{ venue: 'hyperliquid', status: 'ok' }, { venue: 'edgex', status: 'error' }]);
    expect(byId(r.json, 'edgex:ANTHROPICUSDC')).toMatchObject({ error: expect.any(String), market: { price: { value: null } } });
    expect(byId(r.json, 'hyperliquid:io:ANTH').valuation.impliedValuation.value).toBe('1776600000000');
    edgex.down = false;
  });
  it('past validUntil (18 Nov 2026 00:00 UTC, the Anthropic IPO week): every Anthropic contract is under review and loses its valuation; OpenAI keeps its own', async () => {
    clock.t = Date.parse('2026-11-18T00:00:01Z');
    const j = (await get(P)).json;
    for (const id of ['hyperliquid:io:ANTH', 'hyperliquid:xyz:ANT', 'hyperliquid:para:ANTH', 'edgex:ANTHROPICUSDC']) {
      const m = byId(j, id);
      expect(m.review.state, id).toBe('under_review'); expect(m.review.reasons.join(' '), id).toMatch(/valid until 2026-11-18T00:00:00Z/);
      expect(m.valuation.impliedValuation, id).toMatchObject({ value: null, reasonCode: 'under_review' }); expect(m.market.price.value, id).toBeTruthy();
    }
    expect(byId(j, 'hyperliquid:io:OAI').valuation.impliedValuation.value).toBe('1313900000000');
    expect(JSON.stringify(j.markets.filter((m: any) => m.company?.slug === 'anthropic').map((m: any) => m.valuation.impliedValuation))).not.toContain('1776600000000');
    // only public info requests ever left the adapter
    expect(new Set(hl.calls)).toEqual(new Set(['perpCategories', 'perpDexs', 'allPerpMetas', 'metaAndAssetCtxs', 'perpAnnotation', 'l2Book', 'candleSnapshot']));
  });
});

describe('the reviewed table and the reference data (pure)', () => {
  const live = (id: string): LiveFingerprint => { const c = reviewedContract(id)!; return { category: c.fingerprint.category, collateral: c.fingerprint.collateral, ...(c.fingerprint.szDecimals !== undefined ? { szDecimals: c.fingerprint.szDecimals } : {}), ...(c.fingerprint.lotSize !== undefined ? { lotSize: c.fingerprint.lotSize } : {}), ...(c.fingerprint.annotationSha256 !== undefined ? { annotationSha256: c.fingerprint.annotationSha256 } : {}) }; };
  it('every entry is dated, sourced, and consistent: a formula needs its quoted source; no formula needs its reason', () => {
    expect(new Set(REVIEWED_CONTRACTS.map((c) => c.id)).size).toBe(REVIEWED_CONTRACTS.length);
    for (const c of REVIEWED_CONTRACTS) {
      expect(c.id.startsWith(`${c.venue}:`)).toBe(true); expect(COMPANIES[c.company], c.id).toBeTruthy(); expect(c.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(c.sources.every((s) => s.startsWith('https://'))).toBe(true);
      for (const k of ['nature', 'settlement', 'ipoConversion', 'oracle', 'liquidation'] as const) expect(c[k].length, `${c.id} ${k}`).toBeGreaterThan(10);
      if (c.valuationFormula !== null) { expect(c.unit.kind, c.id).toBe('valuation_usd_billions'); expect(c.formulaSource?.quote, c.id).toBeTruthy(); expect(c.formulaSource?.readAt).toMatch(/^\d{4}-/); expect(c.noFormulaReason).toBeNull(); }
      else expect(c.noFormulaReason, c.id).toBeTruthy();
      if (c.status === 'live') { expect(c.validUntil, c.id).toBeTruthy(); expect(c.validUntilReason).toBeTruthy(); } else expect(c.valuationFormula, c.id).toBeNull();
      if (c.unit.kind === 'unknown') expect(c.formulaSource).toBeNull();
      expect(EXCLUDED_PUBLIC[c.id]).toBeUndefined();
    }
    // only the two Entropy contracts carry a formula; edgeX never does
    expect(REVIEWED_CONTRACTS.filter((c) => c.valuationFormula !== null).map((c) => c.id)).toEqual(['hyperliquid:io:ANTH', 'hyperliquid:io:OAI']);
    expect(REVIEWED_CONTRACTS.filter((c) => c.venue === 'edgex').every((c) => c.unit.kind === 'unknown' && c.valuationFormula === null && c.unconfirmedConvention !== null)).toBe(true);
    // the fingerprints are the hashes of the annotations recorded on 2026-11-16
    for (const c of REVIEWED_CONTRACTS.filter((x) => x.venue === 'hyperliquid')) expect(c.fingerprint.annotationSha256, c.id).toBe(createHash('sha256').update(ANNOT[c.id.slice(12)]!.attempts.at(-1).description).digest('hex'));
  });
  it('reviewState: matching fingerprint → reviewed; each mismatch, the validity date and an unknown instrument are refused', () => {
    const id = 'hyperliquid:io:ANTH', c = reviewedContract(id)!, now = Date.parse('2026-11-16T00:00:00Z');
    expect(reviewState(c, live(id), now)).toMatchObject({ state: 'reviewed', reasons: [], reviewedAt: '2026-11-15', validUntil: '2026-11-18T00:00:00Z' });
    expect(reviewState(c, live(id), Date.parse('2026-11-17T23:59:59Z')).state).toBe('reviewed');
    expect(reviewState(c, live(id), Date.parse('2026-11-18T00:00:00Z'))).toMatchObject({ state: 'under_review', reasons: [expect.stringMatching(/valid until/)] });
    expect(reviewState(c, { ...live(id), szDecimals: 2 }, now)).toMatchObject({ state: 'under_review', reasons: [expect.stringMatching(/size decimals changed/)] });
    expect(reviewState(c, { ...live(id), annotationSha256: 'f'.repeat(64) }, now).state).toBe('under_review');
    expect(reviewState(c, { ...live(id), annotationSha256: null }, now).reasons[0]).toMatch(/could not be read/);
    expect(reviewState(c, { ...live(id), category: 'stocks' }, now).reasons[0]).toMatch(/no longer categorises/);
    expect(reviewState(c, { ...live(id), collateral: 'USDH' }, now).state).toBe('under_review');
    const e = reviewedContract('edgex:ANTHROPICUSDC')!;
    expect(reviewState(e, live(e.id), now).state).toBe('reviewed');
    expect(reviewState(e, { ...live(e.id), lotSize: '1' }, now).reasons[0]).toMatch(/lot size changed/);
    expect(reviewState(e, { ...live(e.id), category: 'equity' }, now).state).toBe('under_review');
    expect(reviewState(null, { category: 'preipo', collateral: 'USDC' }, now)).toMatchObject({ state: 'not_reviewed', reasons: [expect.stringMatching(/not reviewed — no valuation/)] });
    expect(reviewState(reviewedContract('hyperliquid:vntl:OPENAI')!, live('hyperliquid:vntl:OPENAI'), Date.parse('2030-01-01T00:00:00Z')).state).toBe('reviewed');   // settled: no expiry
  });
  it('references: kinds, dates, sources; the "last private valuation" is the latest round or tender, never an IPO range or a press estimate', () => {
    for (const r of REFERENCE_VALUATIONS) { expect(COMPANIES[r.company]).toBeTruthy(); expect(r.sourceUrl).toMatch(/^https:\/\//); expect(r.date).toMatch(/^\d{4}-\d{2}(-\d{2})?$/); if (r.valueUsd !== null) expect(r.valueUsd).toMatch(/^\d+$/); }
    expect(lastPrivateValuation('anthropic')).toMatchObject({ valueUsd: '965000000000', kind: 'primary_round', date: '2026-05-28' });
    expect(lastPrivateValuation('openai')).toMatchObject({ valueUsd: '1250000000000', date: '2026-11-06', confidence: 'medium' });
    expect(lastPrivateValuation('oura')).toMatchObject({ valueUsd: '11000000000', date: '2025-10' });
    expect(lastPrivateValuation('polymarket')!.valueUsd).toBe('21000000000'); expect(lastPrivateValuation('moonshot')).toBeNull();
    expect(toTradingReference(lastPrivateValuation('oura')!)).toMatchObject({ date: '2025-10-01', kind: 'press_report' });
    expect(toTradingReference(lastPrivateValuation('anthropic')!).kind).toBe('priced_round_post_money');
    expect(JSON.stringify(REFERENCE_VALUATIONS)).not.toMatch(/17498334025|dilutedShares/);       // no fully diluted share count is recorded
  });
});

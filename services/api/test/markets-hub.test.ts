// V11 markets hub and venue comparator, on what the four venues REALLY answered on 2026-11-15 (recorded read-only, see
// markets-hub-helpers.ts): the per-venue budget of the derivatives data service (a hanging venue), the explorer (filters,
// sort, pagination, staleness, isolation, request de-duplication), the comparator on the real BTC and ETH books (with
// hand-checked figures), the wording, and the routes through the real server. No network.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, type Book } from '@spw/derivatives';
import { COST_ASSUMPTIONS, DISCREPANCY_ASSUMPTIONS, DISCREPANCY_RISKS, POOL_ASSUMPTIONS } from '@spw/trading';
import { Clock, recordedVenues, spotPort, VENUES, type RecordedVenues } from './markets-hub-helpers.ts';
import { useTestDatabase } from './test-db.ts';

type Deriv = typeof import('../src/derivatives/index.ts');
type Hub = typeof import('../src/markets-hub/index.ts');
let deriv: Deriv, hubMod: Hub, sql: any;
const T0 = Date.parse('2026-11-15T20:00:30Z');
const BUDGET = 60;
const FORBIDDEN = /profit|guarant|risk[- ]?free|riskless|sans risque|garanti|b[ée]n[ée]fice|gain assur/i;

function world(o: { budgetMs?: number; ttlMs?: number } = {}) {
  const clock = new Clock(T0), v = recordedVenues(clock);
  const registry = deriv.createRegistry(v.adapters, clock.now);
  const data = new deriv.DerivData(registry, { now: clock.now, budgetMs: o.budgetMs ?? 5_000 });
  const d = { registry, data, paper: null as never };
  const spot = spotPort(clock);
  const hub = new hubMod.MarketsHub({ derivatives: () => d, spot, now: clock.now, budgetMs: o.budgetMs ?? 5_000, ...(o.ttlMs === undefined ? {} : { ttlMs: o.ttlMs }) });
  return { clock, v, data, hub, compare: new hubMod.CompareService(hub), spot, d };
}
const elapsed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; out: T | null; err: any }> => { const t = performance.now(); try { const out = await fn(); return { ms: performance.now() - t, out, err: null }; } catch (err) { return { ms: performance.now() - t, out: null, err }; } };
const Q = { sort: 'volume' as const, dir: 'desc' as const, limit: 500, offset: 0 };
const CQ = { underlying: 'BTC', side: 'long' as const, notionalUsd: '1000', leverage: '3', horizonHours: '24', liquidity: 'taker' as const, minNetEdgeBps: '0' };

beforeAll(async () => {
  await useTestDatabase('markets_hub');
  deriv = await import('../src/derivatives/index.ts'); hubMod = await import('../src/markets-hub/index.ts');
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
});
afterAll(async () => { await sql?.end(); });

describe('derivatives data service — per-venue budget (a venue that hangs)', () => {
  it('cold: the request stops waiting at the budget and answers 503 venue_timeout; the upstream call is shared, not repeated', async () => {
    const w = world({ budgetMs: BUDGET }); w.v.ctl.edgex.mode = 'hang';
    const a = await elapsed(() => w.data.tickers('edgex'));
    expect(a.err).toMatchObject({ code: 'venue_timeout', status: 503 }); expect(a.err.message).toMatch(/edgex did not answer within 60 ms/);
    expect(a.ms).toBeGreaterThanOrEqual(BUDGET - 5); expect(a.ms).toBeLessThan(BUDGET + 400);
    // the budget of that upstream call is spent: a second request does not wait for it again, and does not call the venue again
    const b = await elapsed(() => w.data.tickers('edgex'));
    expect(b.err).toMatchObject({ code: 'venue_timeout' }); expect(b.ms).toBeLessThan(BUDGET / 2);
    expect(w.v.ctl.edgex.calls.tickers).toBe(1); expect(w.data.budgetStats.exceeded).toBe(2);
    // the other venues are unaffected
    const c = await elapsed(() => w.data.tickers('hyperliquid'));
    expect(c.out!.stale).toBe(false); expect(c.ms).toBeLessThan(BUDGET);
    // when the venue finally answers, the call that nobody waits for fills the cache
    w.v.ctl.edgex.mode = 'ok'; w.v.ctl.edgex.release(); await new Promise((r) => setTimeout(r, 5));
    const dn = await w.data.tickers('edgex');
    expect(dn.stale).toBe(false); expect(dn.value.length).toBe(157); expect(w.v.ctl.edgex.calls.tickers).toBe(1);
  });
  it('warm: the last good value stands in, marked stale with its real time — within its bound, or whatever its age when the caller asks for it', async () => {
    const w = world({ budgetMs: BUDGET });
    const first = await w.data.tickers('dydx'); expect(first.stale).toBe(false);
    w.v.ctl.dydx.mode = 'hang'; w.clock.advance(5_000);                                   // past the 3 s reuse, inside the 15 s bound
    const a = await elapsed(() => w.data.tickers('dydx'));
    expect(a.out).toMatchObject({ stale: true, ts: first.ts }); expect(a.out!.value).toBe(first.value); expect(a.ms).toBeLessThan(BUDGET + 400);
    w.clock.advance(60_000);                                                              // beyond the bound: old data is not presented as current
    expect((await elapsed(() => w.data.tickers('dydx'))).err).toMatchObject({ code: 'venue_timeout', status: 503 });
    const lg = await w.data.tickers('dydx', { lastGood: true });
    expect(lg).toMatchObject({ stale: true, ts: first.ts });
    // a strict caller (order flow) is never given an older value
    expect((await elapsed(() => w.data.tickers('dydx', { within: 0, lastGood: true }))).err).toMatchObject({ code: 'venue_timeout' });
    w.v.ctl.dydx.release();
  });
  it('a caller can bring its own, shorter budget; a venue that throws still answers at once', async () => {
    const w = world({ budgetMs: 5_000 }); w.v.ctl.gmx.mode = 'hang';
    const a = await elapsed(() => w.data.instruments('gmx', { budgetMs: 30 }));
    expect(a.err).toMatchObject({ code: 'venue_timeout' }); expect(a.ms).toBeLessThan(430);
    w.v.ctl.hyperliquid.mode = 'throw';
    const b = await elapsed(() => w.data.tickers('hyperliquid'));
    expect(b.err).toMatchObject({ code: 'venue_unavailable', status: 503 }); expect(b.ms).toBeLessThan(50);
    w.v.ctl.gmx.release();
  });
  it('the all-venue comparison of the existing data service is no longer held by one hanging venue', async () => {
    const w = world({ budgetMs: BUDGET }); w.v.ctl.edgex.mode = 'hang';
    const r = await elapsed(() => w.data.compare('BTC'));
    expect(r.ms).toBeLessThan(BUDGET + 500);
    expect(r.out!.rows.map((x) => x.venue)).toEqual(expect.arrayContaining(['hyperliquid', 'gmx', 'dydx'])); expect(r.out!.rows.some((x) => x.venue === 'edgex')).toBe(false);
    expect(r.out!.errors).toEqual([expect.objectContaining({ venue: 'edgex' })]);
    // the hourly funding of that table is the shared normalisation: edgeX publishes a 4 h rate
    w.v.ctl.edgex.release();
    const hl = r.out!.rows.find((x) => x.instrument === 'hyperliquid:BTC')!;
    expect(hl.funding).toBe('0.0000125'); expect(hl.fundingVenue).toEqual({ rate: '0.0000125', intervalSec: 3600 });
  });
});

describe('markets hub — explorer', () => {
  it('one listing over spot and the perps of the four venues, each row with price, funding (raw and annualised), ages and tradability', async () => {
    const w = world(), r = await w.hub.list(Q);
    expect(r.venues.map((v) => [v.id, v.status, v.rows])).toEqual([['spot', 'ok', 95], ['hyperliquid', 'ok', 235], ['gmx', 'ok', 124], ['dydx', 'ok', 296], ['edgex', 'ok', 157]]);
    expect(r.total).toBe(95 + 235 + 124 + 296 + 157); expect(r.rows).toHaveLength(500); expect(r.errors).toEqual([]);
    const all = (await w.hub.list({ ...Q, limit: 500, offset: 500 })).rows.concat(r.rows);
    const by = (id: string) => all.find((x) => x.id === id)!;
    const hl = by('hyperliquid:BTC');
    expect(hl).toMatchObject({ kind: 'perp', venue: 'hyperliquid', underlying: 'BTC', category: 'crypto', multiplier: '1', price: '64726', unitPrice: '64726', change24h: '0.01496', maxLeverage: '40', tradable: true, tradableReason: null, paper: true,
      stale: false, staleAfterMs: 15_000, source: 'venue' });
    expect(hl.funding).toEqual({ rate: '0.0000125', intervalSec: 3600, perHour: '0.0000125', annualised: '0.1095' });               // 0.0000125 × 8760
    expect(hl.openInterestUsd).toBe(D.str(D.div(D.mul(D.from(hl.openInterest!), D.from('64726')), D.one, 2, 'half_even')));
    expect(hl.ageMs).toBeGreaterThanOrEqual(0); expect(hl.ageMs).toBeLessThan(15_000); expect(hl.sourceTs).toBe(w.clock.now() - hl.ageMs!);
    // edgeX publishes a 4 h rate: the raw figure is kept, the annualised one is rate × 2190
    expect(by('edgex:BTCUSDC').funding).toEqual({ rate: '0.00005', intervalSec: 14400, perHour: '0.0000125', annualised: '0.1095' });
    expect(by('edgex:BTCUSDC')).toMatchObject({ tradable: false, tradableReason: 'edgex_jurisdiction', paper: false, staleAfterMs: 30_000 }); expect(by('edgex:BTCUSDC').restriction).toMatch(/exclude Canada/);
    expect(by('dydx:BTC-USD')).toMatchObject({ tradable: false, tradableReason: 'dydx_jurisdiction' });
    expect(by('hyperliquid:kPEPE')).toMatchObject({ underlying: 'PEPE', multiplier: '1000', price: '0.003802', unitPrice: '0.000003802', tradable: false, tradableReason: 'hl_asset_not_pinned', paper: true });
    expect(by('hyperliquid:kLUNC')).toMatchObject({ underlying: null, category: null, multiplier: null, unitPrice: null }); expect(by('hyperliquid:kLUNC').mapping.unmapped).toBe('multiplier_unreviewed');
    expect(by('gmx:BTC/USD [BTC-USDC]')).toMatchObject({ tradable: true, underlying: 'BTC' }); expect(by('gmx:BTC/USD [BTC-BTC]')).toMatchObject({ tradable: false, tradableReason: 'gmx_market_not_pinned', underlying: 'BTC' });
    expect(r.locks.map((l) => l.id)).toEqual(['deriv_live_mainnet', 'deriv_gmx_live', 'broadcast']);
  });

  it('spot: the wallet registry priced from the stored multi-source bars — close, 24 h change, volume of the providing exchanges, freshness', async () => {
    const w = world(), r = await w.hub.list({ ...Q, kind: 'spot' });
    expect(r.total).toBe(95); expect(r.counts).toMatchObject({ spot: 95, perp: 0 });
    const by = (s: string) => r.rows.find((x) => x.symbol === s)!;
    expect(by('BTC')).toMatchObject({ id: 'spot:BTC', kind: 'spot', underlying: 'BTC', price: '64720', priceKind: 'close_1h', change24h: '0.01125', volume24hUsd: '15450000', tradable: true, stale: false, source: 'market-data', priceSource: 'kraken' });   // 64 720 / 64 000 − 1; Σ 10 × close of the last 24 bars
    expect(by('BTC').networks).toEqual(expect.arrayContaining([{ network: 'bitcoin', asset: 'native' }]));
    expect(by('BTC').sourceTs).toBe(Math.floor((w.clock.now() - 10_000) / 3_600_000) * 3_600_000);                                   // the close time of the last bar
    expect(by('WBTC')).toMatchObject({ underlying: 'BTC', price: '64720' }); expect(by('WBTC').mapping.note).toMatch(/priced as BTC/);
    expect(by('USDC')).toMatchObject({ underlying: null, price: null, tradable: false, tradableReason: 'spot_cash_leg', status: 'cash' });
    expect(by('XLM')).toMatchObject({ tradable: false, tradableReason: 'spot_no_swap_route', price: null, stale: true });           // held and sent only; not among the ingested symbols of this test
    expect(by('SOL').status).toBe('not_ingested');
    // the spot part is read once and reused (hourly bars)
    await w.hub.list({ ...Q, kind: 'spot' }); w.clock.advance(5_000); await w.hub.list(Q);
    expect(w.hub.stats.spotBuilds).toBe(1); expect(w.spot.calls).toBe(2);
  });

  it('filters: kind, venue, category, search, tradable from the wallet — with the reason code when not', async () => {
    const w = world();
    const eq = await w.hub.list({ ...Q, kind: 'perp', venue: 'edgex', category: 'equity' });
    expect(eq.total).toBe(71); expect(eq.rows.every((x) => x.venue === 'edgex' && x.category === 'equity' && x.tradableReason === 'edgex_jurisdiction')).toBe(true);
    expect((await w.hub.list({ ...Q, category: 'pre_ipo' })).rows.map((x) => x.symbol).sort()).toEqual(['ANTHROPICUSDC', 'MOONSHOTUSDC', 'POLYMARKETUSDC']);
    expect((await w.hub.list({ ...Q, category: 'commodity' })).total).toBe(8); expect((await w.hub.list({ ...Q, category: 'fx' })).total).toBe(1);
    const pepe = await w.hub.list({ ...Q, kind: 'perp', q: 'PePe' });
    expect((await w.hub.list({ ...Q, q: 'pepe' })).rows.some((x) => x.id === 'spot:PEPE')).toBe(true);
    expect(pepe.rows.map((x) => x.id).sort()).toEqual(['dydx:PEPE-USD', 'edgex:1000PEPEUSDC', 'gmx:kPEPE/USD [PEPE-USDC]', 'gmx:kPEPE/USD [WETH-USDC]', 'hyperliquid:kPEPE']);
    const yes = await w.hub.list({ ...Q, kind: 'perp', tradable: 'yes' });
    expect(yes.rows.map((x) => x.id).sort()).toEqual(['gmx:BTC/USD [BTC-USDC]', 'gmx:ETH/USD [WETH-USDC]', 'hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL']);
    const no = await w.hub.list({ ...Q, kind: 'perp', tradable: 'no', limit: 500 }), rest = await w.hub.list({ ...Q, kind: 'perp', tradable: 'no', limit: 500, offset: 500 });
    const reasons = new Set([...no.rows, ...rest.rows].map((x) => x.tradableReason));
    expect([...reasons].sort()).toEqual(['dydx_jurisdiction', 'edgex_jurisdiction', 'gmx_market_not_pinned', 'hl_asset_not_pinned', 'instrument_halted']);
    expect(no.total + yes.total).toBe(235 + 124 + 296 + 157);
    await expect(w.hub.list({ ...Q, venue: 'binance' })).rejects.toMatchObject({ code: 'unknown_venue', status: 404 });
    // a builder-dex symbol is flagged, never offered (the main-dex adapter lists none today)
    expect(hubMod.perpTradability({ ...w.v.rec.hyperliquid.instruments[0]!, symbol: 'xyz:NVDA', id: 'hyperliquid:xyz:NVDA' }, { id: 'hyperliquid', restriction: null })).toEqual({ tradable: false, reason: 'hl_builder_dex' });
  });

  it('sort by volume, open interest, funding, 24 h change — rows without the figure last in both directions — and stable pagination', async () => {
    const w = world();
    const num = (x: string | null | undefined) => (x == null ? null : Number(x));
    for (const [sort, key] of [['volume', (r: any) => num(r.volume24hUsd)], ['openInterest', (r: any) => num(r.openInterestUsd)], ['funding', (r: any) => num(r.funding?.annualised)], ['change', (r: any) => num(r.change24h)]] as const) {
      for (const dir of ['desc', 'asc'] as const) {
        const pages = [await w.hub.list({ ...Q, kind: 'perp', sort, dir }), await w.hub.list({ ...Q, kind: 'perp', sort, dir, offset: 500 })];
        const vals = pages.flatMap((p) => p.rows).map(key), firstNull = vals.indexOf(null);
        expect(vals.length).toBe(812);
        if (firstNull >= 0) expect(vals.slice(firstNull).every((x) => x === null), `${sort} ${dir}: nulls last`).toBe(true);
        const real = vals.filter((x): x is number => x !== null);
        for (let k = 1; k < real.length; k++) expect(dir === 'desc' ? real[k - 1]! >= real[k]! : real[k - 1]! <= real[k]!, `${sort} ${dir} at ${k}`).toBe(true);
      }
    }
    expect((await w.hub.list({ ...Q, kind: 'perp' })).rows[0]!.id).toBe('hyperliquid:BTC');                                            // the most traded perp of the recording
    const a = await w.hub.list({ ...Q, kind: 'perp', limit: 20 }), b = await w.hub.list({ ...Q, kind: 'perp', limit: 20, offset: 20 }), both = await w.hub.list({ ...Q, kind: 'perp', limit: 40 });
    expect([...a.rows, ...b.rows].map((x) => x.id)).toEqual(both.rows.map((x) => x.id)); expect(a.total).toBe(812); expect(b.offset).toBe(20);
    expect((await w.hub.list({ ...Q, sort: 'symbol', dir: 'asc', kind: 'spot', limit: 3 })).rows.map((x) => x.symbol)).toEqual(['AAVE', 'ADA', 'AERO']);
  });

  it('request de-duplication: concurrent reads with different filters share ONE build and one upstream call per venue; the listing is reused for its TTL with an explicit age', async () => {
    const w = world();
    const rs = await Promise.all([w.hub.list(Q), w.hub.list({ ...Q, kind: 'perp' }), w.hub.list({ ...Q, venue: 'edgex' }), w.hub.underlying('BTC'), w.hub.underlyings(), w.compare.compare(CQ), w.compare.compare(CQ)]);
    expect(w.hub.stats.builds).toBe(1); expect(w.hub.stats.served).toBeGreaterThanOrEqual(6); expect(w.compare.stats).toEqual({ computed: 1, served: 2 });
    for (const v of VENUES) { expect(w.v.ctl[v].calls.instruments, v).toBe(1); expect(w.v.ctl[v].calls.tickers, v).toBe(1); }
    expect((rs[0] as any).cache).toMatchObject({ ageMs: 0, ttlMs: 2_000 });
    w.clock.advance(1_500);
    expect((await w.hub.list(Q)).cache.ageMs).toBe(1_500); expect(w.hub.stats.builds).toBe(1);
    w.clock.advance(1_000);                                                                                                             // past the TTL: rebuilt; the data service's own caches decide what is re-read
    expect((await w.hub.list(Q)).cache.ageMs).toBe(0); expect(w.hub.stats.builds).toBe(2);
    expect(w.v.ctl.hyperliquid.calls.instruments).toBe(1); expect(w.v.ctl.hyperliquid.calls.tickers).toBe(1);                         // tickers are reused 3 s, instruments 10 min
    w.clock.advance(3_000); await w.hub.list(Q);
    expect(w.v.ctl.hyperliquid.calls.tickers).toBe(2); expect(w.v.ctl.hyperliquid.calls.instruments).toBe(1);
  });

  it('staleness and isolation: a venue that throws, then one that hangs — its rows are served from the last good read, marked stale with their real age; the others stay fresh and are not delayed', async () => {
    const w = world({ budgetMs: BUDGET });
    await w.hub.list(Q);
    w.v.ctl.edgex.mode = 'throw'; w.clock.advance(20_000);
    const a = await elapsed(() => w.hub.list({ ...Q, kind: 'perp' }));
    const ex = a.out!.rows.filter((x) => x.venue === 'edgex'), others = a.out!.rows.filter((x) => x.venue !== 'edgex');
    expect(ex.length).toBeGreaterThan(0); expect(ex.every((x) => x.stale && x.ageMs! >= 20_000 && x.price !== null)).toBe(true);
    expect(others.filter((x) => x.price !== null && x.status !== 'halted').every((x) => !x.stale || x.ageMs! > x.staleAfterMs)).toBe(true);
    expect(others.find((x) => x.id === 'hyperliquid:BTC')).toMatchObject({ stale: false });
    expect(a.out!.venues.find((v) => v.id === 'edgex')).toMatchObject({ status: 'stale' }); expect(a.out!.venues.find((v) => v.id === 'hyperliquid')).toMatchObject({ status: 'ok' });
    expect(a.out!.counts.stale).toBeGreaterThanOrEqual(157);
    // now a venue that never answers: the listing comes back within the budget
    w.v.ctl.edgex.mode = 'ok'; w.v.ctl.gmx.mode = 'hang'; w.clock.advance(20_000);
    const b = await elapsed(() => w.hub.list({ ...Q, kind: 'perp' }));
    expect(b.ms).toBeLessThan(BUDGET * 2 + 500);
    expect(b.out!.venues.find((v) => v.id === 'gmx')).toMatchObject({ status: 'stale' }); expect(b.out!.rows.filter((x) => x.venue === 'gmx').every((x) => x.stale && x.ageMs! >= 20_000)).toBe(true);   // last read 20 s ago, when it still answered
    expect(b.out!.rows.find((x) => x.id === 'edgex:BTCUSDC')).toMatchObject({ stale: false }); expect(b.out!.rows.find((x) => x.id === 'hyperliquid:BTC')).toMatchObject({ stale: false });
    w.v.ctl.gmx.release();
  });

  it('cold start with a hanging venue and a throwing one: they are named in `errors`, the rest is answered inside the budget; no source at all is a 503', async () => {
    const w = world({ budgetMs: BUDGET }); w.v.ctl.dydx.mode = 'hang'; w.v.ctl.gmx.mode = 'throw';
    const r = await elapsed(() => w.hub.list(Q));
    expect(r.ms).toBeLessThan(BUDGET + 500);
    expect(r.out!.venues.map((v) => [v.id, v.status])).toEqual([['spot', 'ok'], ['hyperliquid', 'ok'], ['gmx', 'error'], ['dydx', 'error'], ['edgex', 'ok']]);
    expect(r.out!.errors.map((e) => e.source).sort()).toEqual(['dydx', 'gmx']); expect(r.out!.total).toBe(95 + 235 + 157);
    await expect(w.hub.list({ ...Q, venue: 'gmx' })).rejects.toMatchObject({ code: 'markets_unavailable', status: 503 });
    // tickers alone failing: the instruments are listed without a price, stale
    const w2 = world({ budgetMs: BUDGET }); w2.v.ctl.hyperliquid.mode = 'throw'; w2.v.ctl.hyperliquid.only = ['tickers'];
    const r2 = await w2.hub.list({ ...Q, venue: 'hyperliquid' });
    expect(r2.total).toBe(235); expect(r2.rows.every((x) => x.price === null && x.stale && x.ageMs === null)).toBe(true); expect(r2.venues.find((v) => v.id === 'hyperliquid')!.status).toBe('stale');
    w.v.ctl.dydx.release();
  });

  it('GET underlyings/:symbol — every venue\'s instruments for one underlying, the spot assets priced as it, and the same letters that are NOT compared', async () => {
    const w = world(), r = await w.hub.underlying('btc');
    expect(r.underlying).toBe('BTC'); expect(r.category).toBe('crypto');
    expect(new Set(r.instruments.map((x) => x.venue))).toEqual(new Set(VENUES)); expect(r.instruments.filter((x) => x.venue === 'gmx').length).toBeGreaterThan(1);
    expect(r.instruments.every((x) => !x.priceOutlier)).toBe(true);
    expect(r.spot.map((x) => x.symbol).sort()).toEqual(expect.arrayContaining(['BTC', 'WBTC', 'cbBTC']));
    const spy = await w.hub.underlying('SPY');
    expect(spy.instruments.map((x) => x.id)).toEqual(['edgex:SPYUSDC']); expect(spy.category).toBe('equity');
    expect(spy.notCompared.length).toBeGreaterThan(0); expect(spy.notCompared.every((x) => x.venue !== 'edgex' && x.underlying === null && x.mapping.unmapped === 'no_category_metadata')).toBe(true);
    const pepe = await w.hub.underlying('PEPE');
    expect(pepe.instruments.map((x) => `${x.id} ×${x.multiplier}`).sort()).toEqual(['dydx:PEPE-USD ×1', 'edgex:1000PEPEUSDC ×1000', 'gmx:kPEPE/USD [PEPE-USDC] ×1', 'gmx:kPEPE/USD [WETH-USDC] ×1', 'hyperliquid:kPEPE ×1000']);
    expect(pepe.instruments.every((x) => !x.priceOutlier && Math.abs(Number(x.unitPrice) / 0.0000038 - 1) < 0.01)).toBe(true);
    await expect(w.hub.underlying('NOPE')).rejects.toMatchObject({ code: 'unknown_underlying', status: 404 });
    const list = await w.hub.underlyings();
    expect(list.underlyings[0]).toMatchObject({ underlying: 'BTC', comparable: true }); expect(list.underlyings.find((u) => u.underlying === 'ANTHROPIC')).toMatchObject({ category: 'pre_ipo', comparable: false, venues: ['edgex'] });
  });
});

describe('comparator — real books and tickers of the four venues', () => {
  const val = (f: { value: string | null } | undefined) => f?.value ?? null;

  it('BTC long 1 000 USD ×3 over 24 h: one row per venue, itemised; Hyperliquid hand-checked against its recorded book', async () => {
    const w = world(), r = await w.compare.compare(CQ);
    expect(r.rows.map((x) => x.venue)).toEqual(VENUES); expect(r.underlying).toBe('BTC'); expect(r.source).toBe('estimate');
    const hl = r.rows[0]!, c = hl.cost!;
    // recorded book: best bid 64 711 × 7.5225, best ask 64 712 × 5.62655 → mid 64 711.5, spread 1 / 64 711.5 = 0.1545 bps
    expect(val(c.midPrice)).toBe('64711.5'); expect(val(c.spreadBps)).toBe('0.1545');
    // size = 1 000 / 64 711.5 = 0.015453… → 0.01545 (lot 0.00001); it fills in the first level on each side
    expect(val(c.sizeBase)).toBe('0.01545'); expect(val(c.entryAvgPrice)).toBe('64712');
    expect(val(c.entrySlippageUsd)).toBe('0.007725'); expect(val(c.exitSlippageUsd)).toBe('0.007725'); expect(val(c.entrySlippageBps)).toBe('0.0773');   // 0.5 × 0.01545; 0.5 / 64 711.5
    // notional 0.01545 × 64 711.5 = 999.792675; taker 0.045 % → 0.449907 a leg; funding 0.00125 % / h × 24 h → 0.299938
    expect(val(c.entryFeeUsd)).toBe('0.449907'); expect(val(c.exitFeeUsd)).toBe('0.449907'); expect(val(c.fundingUsd)).toBe('0.299938');
    expect(val(c.totalCostUsd)).toBe('1.215202'); expect(val(c.totalCostBps)).toBe('12.1545'); expect(c.missing).toEqual([]);
    expect(val(c.collateralRequiredUsd)).toBe('333.264225'); expect(val(c.maxLeverage)).toBe('40');
    // maintenance 1 / (2 × 40) = 1.25 %: liquidation ≈ entry × (1 − 1/3) / (1 − 0.0125)
    expect(hl.maintenance!.fraction).toBe('0.0125'); expect(Number(val(c.liquidationPrice))).toBeCloseTo(64712 * (1 - 1 / 3) / (1 - 0.0125), 0); expect(Number(val(c.liquidationDistanceBps))).toBeGreaterThan(3000);
    expect(hl).toMatchObject({ tradable: true, tradableReason: null, priceOutlier: false, stale: false, error: null, multiplier: '1' });
    expect(hl.fees).toMatchObject({ takerRate: '0.00045', makerRate: '0.00015', asOf: '2026-11-10' }); expect(hl.fees!.source).toMatch(/hyperliquid\.gitbook\.io/);
    expect(hl.funding).toMatchObject({ rate: '0.0000125', intervalSec: 3600, perHour: '0.0000125', annualised: '0.1095' }); expect(hl.funding!.assumption).toMatch(/held constant/); expect(c.fundingUsd.basis).toMatch(/held constant for 24 h/);
    // the recorded Hyperliquid snapshot is 20 levels a side and ends about 3 bps from the mid: the depth figures are lower bounds, and say so
    expect(hl.depth!.map((x) => x.bps)).toEqual(['10', '25', '50']); expect(hl.depth![0]).toMatchObject({ askComplete: false, bidComplete: false }); expect(Number(hl.depth![0]!.askUsd)).toBeGreaterThan(100_000);
    // dYdX's book is deeper in distance: complete at 10 bps
    const dy = r.rows.find((x) => x.venue === 'dydx')!;
    expect(dy.depth![0]).toMatchObject({ askComplete: true, bidComplete: true }); expect(Number(dy.depth![2]!.askUsd)).toBeGreaterThanOrEqual(Number(dy.depth![0]!.askUsd));
    expect(dy).toMatchObject({ tradable: false, tradableReason: 'dydx_jurisdiction', maintenance: null }); expect(dy.cost!.liquidationPrice).toMatchObject({ value: null, reason: 'the maintenance margin fraction was not supplied' });
    expect(dy.cost!.missing).toEqual([]); expect(val(dy.cost!.totalCostUsd)).not.toBeNull();
    // edgeX: fees from its own metadata, 4 h funding, risk-tier maintenance; shown and flagged
    const ex = r.rows.find((x) => x.venue === 'edgex')!;
    expect(ex).toMatchObject({ tradable: false, tradableReason: 'edgex_jurisdiction' }); expect(ex.fees).toMatchObject({ takerRate: '0.00045', makerRate: '0.0004', asOf: '2026-11-15' });
    expect(ex.funding).toMatchObject({ rate: '0.00005', intervalSec: 14400, annualised: '0.1095' }); expect(ex.maintenance!.fraction).toBe('0.005'); expect(val(ex.cost!.totalCostUsd)).not.toBeNull();
    // GMX: no book — the pinned pool, priced at the oracle range plus the pool's impact
    const gx = r.rows.find((x) => x.venue === 'gmx')!;
    expect(gx.instrument).toBe('gmx:BTC/USD [BTC-USDC]'); expect(gx.alternatives.length).toBeGreaterThan(0); expect(gx.tradable).toBe(true);
    expect(gx.cost!.executionModel).toBe('pool'); expect(gx.depth).toBeNull(); expect(gx.depthReason).toMatch(/no order book/); expect(gx.cost!.depthAskUsd.reason).toMatch(/no order book/);
    expect(gx.cost!.missing).toEqual([]); expect(Number(val(gx.cost!.totalCostBps))).toBeGreaterThan(0); expect(gx.sourceTs.pool).not.toBeNull();
    expect(r.texts.assumptions.map((a) => a.code)).toEqual(['cost_1', 'cost_2', 'cost_3', 'cost_4', 'cost_5', 'cost_6', 'pool_1', 'pool_2', 'price_guard', 'not_tradable']);
  });

  it('slippage by walking several levels of a real book — dYdX BTC, 30 000 USD, hand-checked', async () => {
    const w = world(), r = await w.compare.compare({ ...CQ, notionalUsd: '30000' }), c = r.rows.find((x) => x.venue === 'dydx')!.cost!;
    const b = w.v.rec.dydx.books['BTC-USD']!;
    expect(b.bids.slice(0, 1)).toEqual([['64718', '0.1545']]); expect(b.asks.slice(0, 3)).toEqual([['64738', '0.1544'], ['64761', '0.3088'], ['64772', '0.2295']]);
    // mid (64 718 + 64 738) / 2 = 64 728; size 30 000 / 64 728 = 0.46347… → 0.4634 (lot 0.0001)
    expect(val(c.midPrice)).toBe('64728'); expect(val(c.sizeBase)).toBe('0.4634');
    // buy: 0.1544 @ 64 738 + 0.3088 @ 64 761 + 0.0002 @ 64 772 = 30 006.6984; at the mid 0.4634 × 64 728 = 29 994.9552 → 11.7432 USD
    expect(val(c.entrySlippageUsd)).toBe('11.7432'); expect(Number(val(c.entryAvgPrice))).toBeCloseTo(30006.6984 / 0.4634, 6);
    expect(val(c.entrySlippageBps)).toBe(D.str(D.div(D.mul(D.from('11.7432'), D.from('10000')), D.from('29994.9552'), 4, 'half_even')));          // 3.9151 bps
    expect(val(c.entryFeeUsd)).toBe('14.997478');                                                                                                      // 29 994.9552 × 0.05 %
  });

  it('ETH: the same table; short side — funding changes sign, GMX uses its short-side net rate', async () => {
    const w = world(), long = await w.compare.compare({ ...CQ, underlying: 'ETH' }), short = await w.compare.compare({ ...CQ, underlying: 'eth', side: 'short' });
    expect(long.rows.map((x) => x.instrument)).toEqual(['hyperliquid:ETH', 'gmx:ETH/USD [WETH-USDC]', 'dydx:ETH-USD', 'edgex:ETHUSDC']);
    for (const x of long.rows) { expect(x.cost!.missing, x.venue).toEqual([]); expect(Number(val(x.cost!.totalCostBps)), x.venue).toBeGreaterThan(0); expect(Number(val(x.cost!.totalCostBps)), x.venue).toBeLessThan(40); }
    const hlL = long.rows[0]!.cost!, hlS = short.rows[0]!.cost!;
    expect(val(hlL.midPrice)).toBe('1807.25'); expect(val(hlL.sizeBase)).toBe('0.5533'); expect(val(hlS.fundingUsd)).toBe(D.str(D.neg(D.from(val(hlL.fundingUsd)!))));
    const l = w.v.rec.gmx.liquidity!.find((x) => x.instrument === 'gmx:ETH/USD [WETH-USDC]')!, gS = short.rows[1]!.cost!;
    // GMX short: net rate −0.0000249820574… per hour (the side PAYS) on 0.5533… ETH of notional for 24 h
    expect(l.netRateShortPerHour.startsWith('-')).toBe(true); expect(Number(val(gS.fundingUsd))).toBeCloseTo(-Number(l.netRateShortPerHour) * 24 * Number(val(gS.sizeBase)) * Number(val(gS.midPrice)), 4);
    expect(Number(val(long.rows[1]!.cost!.fundingUsd))).toBeCloseTo(-Number(l.netRateLongPerHour) * 24 * Number(val(gS.sizeBase)) * Number(val(gS.midPrice)), 4);
  });

  it('a missing input gives null WITH the reason, never a silent zero; the total is then null and says what is missing', async () => {
    const w = world(); w.v.ctl.hyperliquid.mode = 'throw'; w.v.ctl.hyperliquid.only = ['book'];
    const r = await w.compare.compare(CQ), hl = r.rows[0]!;
    expect(hl.error).toBeNull(); expect(hl.depth).toBeNull(); expect(hl.depthReason).toMatch(/order book unavailable/);
    expect(hl.cost!.entrySlippageUsd).toMatchObject({ value: null, reason: 'no order book was supplied' }); expect(hl.cost!.totalCostUsd.value).toBeNull();
    expect(hl.cost!.totalCostUsd.reason).toMatch(/^incomplete: entrySlippageUsd/); expect(hl.cost!.missing).toEqual(['entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'exitFeeUsd', 'fundingUsd']);
    expect(hl.fees).not.toBeNull();                                                              // the schedule is known; the amount needs a size, which needs a price
    // the venue without a price of its own is in no cross-venue estimate; the others still are
    expect(r.discrepancies.some((x) => x.longVenue === 'hyperliquid' || x.shortVenue === 'hyperliquid')).toBe(false); expect(r.discrepancies).toHaveLength(6);
    // leverage above a venue's maximum: no collateral and no liquidation figure for that venue, with the reason
    const lev = await w.compare.compare({ ...CQ, leverage: '60' }), dy = lev.rows.find((x) => x.venue === 'dydx')!;
    expect(dy.cost!.collateralRequiredUsd).toMatchObject({ value: null, reason: 'the leverage 60 is above the venue\'s maximum 50' });
    expect(lev.rows.find((x) => x.venue === 'edgex')!.cost!.collateralRequiredUsd.value).not.toBeNull();
    await expect(w.compare.compare({ ...CQ, underlying: 'NOPE' })).rejects.toMatchObject({ code: 'unknown_underlying', status: 404 });
    // an underlying listed by one venue: one row, no cross-venue estimate; no recorded book for it → the reason, not a number
    const one = await w.compare.compare({ ...CQ, underlying: 'ANTHROPIC' });
    expect(one.rows.map((x) => x.venue)).toEqual(['edgex']); expect(one.discrepancies).toEqual([]); expect(one.rows[0]!.cost!.totalCostUsd.value).toBeNull();
  });

  it('a hanging venue: the comparison comes back inside the budget, with that venue\'s row stale and out of the estimates', async () => {
    const w = world({ budgetMs: BUDGET });
    await w.compare.compare(CQ);
    w.v.ctl.edgex.mode = 'hang'; w.clock.advance(40_000);
    const r = await elapsed(() => w.compare.compare(CQ));
    expect(r.ms).toBeLessThan(BUDGET * 3 + 600);
    const ex = r.out!.rows.find((x) => x.venue === 'edgex')!;
    expect(ex.stale).toBe(true); expect(ex.cost!.totalCostUsd.value).toBeNull();
    expect(r.out!.rows.filter((x) => x.venue !== 'edgex').every((x) => !x.stale && x.cost!.totalCostUsd.value !== null)).toBe(true);
    expect(r.out!.discrepancies.some((x) => x.longVenue === 'edgex' || x.shortVenue === 'edgex')).toBe(false);
    w.v.ctl.edgex.release();
  });

  it('cross-venue discrepancy: an estimate with its assumptions and risks; on the recorded books no pair is above zero net of costs', async () => {
    const w = world(), r = await w.compare.compare(CQ);
    expect(r.discrepancies).toHaveLength(12);                                                    // every ordered pair of the four venues
    for (const x of r.discrepancies) {
      expect(x.netEdgeEstimateBps, `${x.longVenue}→${x.shortVenue}: ${x.reason}`).not.toBeNull(); expect(x.flagged).toBe(false); expect(Number(x.netEdgeEstimateBps)).toBeLessThan(0);
      expect(x.assumptions.map((a) => a.text)).toEqual([...DISCREPANCY_ASSUMPTIONS]); expect(x.risks.map((a) => a.text)).toEqual([...DISCREPANCY_RISKS]);
      expect(x.assumptions.map((a) => a.code)).toEqual(['disc_assume_1', 'disc_assume_2', 'disc_assume_3', 'disc_assume_4', 'disc_assume_5', 'disc_assume_6']); expect(x.risks).toHaveLength(6);
      expect(x.costsUsd).not.toBeNull();
    }
    expect(r.discrepancies.find((x) => x.longVenue === 'hyperliquid' && x.shortVenue === 'gmx')!.actionableFromWallet).toBe(true);
    expect(r.discrepancies.find((x) => x.longVenue === 'hyperliquid' && x.shortVenue === 'dydx')!.actionableFromWallet).toBe(false);
    // sorted by estimate, highest first
    const est = r.discrepancies.map((x) => Number(x.netEdgeEstimateBps)); expect([...est].sort((a, b) => b - a)).toEqual(est);
  });

  it('a scripted 1 % price difference is flagged — as an estimate, not actionable when a leg is on a restricted venue; a 6 % one is treated as a data problem', async () => {
    const shift = (pct: number) => (b: Book): Book => ({ ...b, bids: b.bids.map(([p, s]) => [D.str(D.div(D.mul(D.from(p), D.from(String(1 + pct / 100))), D.one, 0, 'half_even')), s] as [string, string]),
      asks: b.asks.map(([p, s]) => [D.str(D.div(D.mul(D.from(p), D.from(String(1 + pct / 100))), D.one, 0, 'half_even')), s] as [string, string]) });
    const w = world(); w.v.ctl.dydx.bookPatch = shift(1);
    const r = await w.compare.compare(CQ), top = r.discrepancies[0]!;
    expect(top).toMatchObject({ shortVenue: 'dydx', flagged: true, actionableFromWallet: false }); expect(Number(top.netEdgeEstimateBps)).toBeGreaterThan(50); expect(Number(top.grossGapBps)).toBeGreaterThan(Number(top.netEdgeEstimateBps));
    expect(top.assumptions.length).toBe(6); expect(top.risks.length).toBe(6);
    expect(r.discrepancies.filter((x) => x.flagged).every((x) => x.shortVenue === 'dydx')).toBe(true);
    // a threshold above the estimate: not flagged
    expect((await w.compare.compare({ ...CQ, minNetEdgeBps: '500' })).discrepancies.every((x) => !x.flagged)).toBe(true);
    // the ticker itself 6 % away from the median of the venues: more likely a mapping or a unit problem than a market fact
    const w2 = world(); w2.v.rec.dydx.tickers = w2.v.rec.dydx.tickers.map((t) => (t.instrument === 'dydx:BTC-USD' ? { ...t, mark: D.str(D.mul(D.from(t.mark), D.from('1.06'))) } : t)); w2.v.ctl.dydx.bookPatch = shift(6);
    const r2 = await w2.compare.compare(CQ);
    expect(r2.rows.find((x) => x.venue === 'dydx')).toMatchObject({ priceOutlier: true }); expect(r2.discrepancies.some((x) => x.longVenue === 'dydx' || x.shortVenue === 'dydx')).toBe(false);
    expect(r2.discrepancies).toHaveLength(6); expect(r2.warnings.join(' ')).toMatch(/dydx:BTC-USD is left out/);
  });

  it('wording: no text of the comparator — constants or a whole answer — promises an outcome', async () => {
    const w = world(); w.v.ctl.dydx.bookPatch = (b) => ({ ...b, bids: b.bids.map(([p, s]) => [String(Number(p) + 700), s] as [string, string]), asks: b.asks.map(([p, s]) => [String(Number(p) + 700), s] as [string, string]) });
    const answers = [await w.compare.compare(CQ), await w.compare.compare({ ...CQ, underlying: 'ETH', side: 'short' }), await w.hub.list(Q), await w.hub.underlying('BTC')];
    const texts = [JSON.stringify(hubMod.COMPARE_TEXTS), ...COST_ASSUMPTIONS, ...POOL_ASSUMPTIONS, ...DISCREPANCY_ASSUMPTIONS, ...DISCREPANCY_RISKS, ...answers.map((a) => JSON.stringify(a))];
    for (const t of texts) expect(t.match(FORBIDDEN)?.[0] ?? null).toBeNull();
    expect((answers[0] as any).discrepancies.some((x: any) => x.flagged)).toBe(true);                // the flagged case is part of what was scanned
    expect(JSON.stringify(answers[0])).toMatch(/estimate/i); expect(hubMod.COMPARE_TEXTS.disclaimer).toMatch(/Not a quote and not a recommendation/);
    for (const bad of ['a guaranteed return', 'risk-free', 'riskless carry', 'profit', 'sans risque', 'bénéfice garanti']) expect(FORBIDDEN.test(bad), bad).toBe(true);
  });
});

describe('routes — through the real server', () => {
  let app: any, cookie = '', w: ReturnType<typeof world>;
  const get = async (url: string, o: { cookie?: boolean } = {}) => { const r = await app.inject({ method: 'GET', url, headers: o.cookie === false ? {} : { cookie } }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() }; };
  beforeAll(async () => {
    const token = randomBytes(32).toString('base64url');
    await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
    cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
    w = world();
    const d = deriv.createDerivatives({ registry: w.d.registry, now: w.clock.now });
    app = await (await import('../src/server.ts')).buildServer({ derivatives: d });
  });
  afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); });

  it('GET /api/v1/markets-hub — owner session only; filters, sort and pagination from the query; spot rows come from the database (empty here: listed, no price)', async () => {
    expect((await get('/api/v1/markets-hub', { cookie: false })).status).toBe(401);
    const r = await get('/api/v1/markets-hub?kind=perp&venue=edgex&category=pre_ipo&sort=symbol&dir=asc&limit=2');
    expect(r.status).toBe(200); expect(r.json.rows.map((x: any) => x.symbol)).toEqual(['ANTHROPICUSDC', 'MOONSHOTUSDC']); expect(r.json).toMatchObject({ total: 3, limit: 2, offset: 0, source: 'markets-hub' });
    expect(r.json.rows[0]).toMatchObject({ tradable: false, tradableReason: 'edgex_jurisdiction', category: 'pre_ipo' }); expect(typeof r.json.rows[0].ageMs).toBe('number');
    const spot = await get('/api/v1/markets-hub?kind=spot&limit=500');
    expect(spot.status).toBe(200); expect(spot.json.total).toBe(95); expect(spot.json.rows.every((x: any) => x.price === null && x.stale)).toBe(true);
    for (const bad of ['?kind=option', '?sort=price', '?limit=0', '?limit=501', '?category=bond', '?tradable=maybe']) expect((await get(`/api/v1/markets-hub${bad}`)).status, bad).toBe(400);
    expect((await get('/api/v1/markets-hub?venue=binance')).status).toBe(404);
  });
  it('GET /underlyings, /underlyings/:symbol and /compare', async () => {
    const u = await get('/api/v1/markets-hub/underlyings');
    expect(u.status).toBe(200); expect(u.json.underlyings[0].underlying).toBe('BTC');
    const one = await get('/api/v1/markets-hub/underlyings/ETH');
    expect(one.status).toBe(200); expect(one.json.instruments.length).toBeGreaterThan(4);
    expect((await get('/api/v1/markets-hub/underlyings/NOPE')).status).toBe(404); expect((await get('/api/v1/markets-hub/underlyings/a%20b')).status).toBe(400);
    const c = await get('/api/v1/markets-hub/compare?underlying=BTC&side=long&notional=1000&leverage=3&horizonHours=24');
    expect(c.status).toBe(200); expect(c.json.rows.map((x: any) => x.venue)).toEqual(VENUES); expect(c.json.rows[0].cost.totalCostUsd.value).toBe('1.215202');
    expect(c.json.request).toMatchObject({ underlying: 'BTC', side: 'long', notionalUsd: '1000', leverage: '3', horizonHours: '24', liquidity: 'taker', depthBps: ['10', '25', '50'] });
    expect(c.json.discrepancies).toHaveLength(12);
    const dflt = await get('/api/v1/markets-hub/compare');
    expect(dflt.json.request).toMatchObject({ underlying: 'BTC', notionalUsd: '1000', leverage: '1' });
    for (const bad of ['?notional=0', '?notional=-5', '?notional=1e3', '?leverage=0', '?leverage=500', '?side=buy', '?horizonHours=99999', '?underlying=BTC-USD', '?liquidity=free']) expect((await get(`/api/v1/markets-hub/compare${bad}`)).status, bad).toBe(400);
    expect((await get('/api/v1/markets-hub/compare?underlying=NOPE')).status).toBe(404);
  });
  it('trading API: GET /api/v1/trading/markets/compare is the same computation; /markets is the same listing as before', async () => {
    const c = await get('/api/v1/trading/markets/compare?underlying=BTC&side=long&notional=1000&leverage=3&horizonHours=24');
    expect(c.status).toBe(200); expect(c.json.rows[0].cost.totalCostUsd.value).toBe('1.215202'); expect(c.json.source).toBe('estimate');
    const spec = await import('../src/trading-api/spec.ts');
    expect(spec.operation('compareMarkets')).toMatchObject({ method: 'GET', path: '/markets/compare', scope: 'markets:read', implemented: true });
    spec.operation('compareMarkets').response!.parse(c.json);
    // the static path is not swallowed by /markets/:symbol
    expect((await get('/api/v1/trading/markets/hyperliquid:BTC')).json.market.id).toBe('hyperliquid:BTC');
    const m = await get('/api/v1/trading/markets?venue=hyperliquid&q=btc');
    expect(m.status).toBe(200); expect(m.json.markets.map((x: any) => x.id)).toContain('hyperliquid:BTC'); expect(m.json.markets[0]).toMatchObject({ kind: 'perpetual', venue: 'hyperliquid', stale: false });
    expect((await get('/api/v1/derivatives/compare?base=BTC')).json.rows.map((x: any) => x.venue)).toEqual(expect.arrayContaining(VENUES));
  });
});

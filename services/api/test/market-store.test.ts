// Market data engine against PostgreSQL (database spw_market_test, created here if missing; never spw_test, which other
// suites reset concurrently) with scripted exchanges (no network): idempotent storage, the pipeline (incremental update,
// backfill), getSeries, assertFresh in every failing situation, the quality record and the routes.
import Fastify from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INTERVAL_MS, MarketDataError, SourceError, expectedLastTs, isClosed, type Candle, type Interval, type MarketSource, type MarketSymbol, type SourceId } from '../src/market/types.ts';

const H = INTERVAL_MS['1h'], D = INTERVAL_MS['1d'];
const T0 = Date.UTC(2026, 5, 1), NOW = T0 + 1000 * H + 60_000; // latest closed hourly bar: T0 + 999 h
const LAST = T0 + 999 * H;
let sql: any, store: typeof import('../src/market/store.ts'), pipe: typeof import('../src/market/pipeline.ts'), series: typeof import('../src/market/series.ts');
let routes: typeof import('../src/market/routes.ts');

beforeAll(async () => {
  const admin = postgres('postgres:///postgres', { max: 1, onnotice: () => {} });
  const [db] = await admin`select 1 from pg_database where datname = 'spw_market_test'`;
  if (!db) await admin.unsafe('create database spw_market_test').catch((e: Error) => { if (!/already exists/.test(e.message)) throw e; });
  await admin.end();
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///spw_market_test', SPW_SIGNER_SECRET: 'k'.repeat(48),
    SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db2 = await import('../src/db.ts');
  sql = db2.sql;
  await db2.migrate();
  await db2.migrate(); // the schema is idempotent
  store = await import('../src/market/store.ts'); pipe = await import('../src/market/pipeline.ts'); series = await import('../src/market/series.ts');
  routes = await import('../src/market/routes.ts');
});
beforeEach(async () => { await sql`truncate candles, market_quality`; });
afterAll(async () => { await sql?.end(); });

const mk = (ts: number, close = 100): Candle => ({ ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 5 });
/** A scripted exchange: a bar exists for every closed slot from `listedFrom`, except those in `missing`. */
function fake(id: SourceId, o: { close?: (ts: number) => number; maxBars?: number; historyBars?: number | null; listedFrom?: number; missing?: Set<number>; fail?: () => Error | null; symbols?: MarketSymbol[]; bad?: (c: Candle) => Candle } = {}) {
  const calls: { symbol: string; interval: Interval; start: number; end: number }[] = [];
  const penalties: number[] = [];
  const src: MarketSource = {
    id, maxBars: o.maxBars ?? 300, historyBars: o.historyBars ?? null, pairs: Object.fromEntries((o.symbols ?? ['BTC', 'ETH']).map((s) => [s, `${s}-USD`])),
    penalize: (ms) => { penalties.push(ms); },
    async candles(symbol, interval, range, now) {
      calls.push({ symbol, interval, ...range });
      const err = o.fail?.();
      if (err) throw err;
      const iv = INTERVAL_MS[interval], out: Candle[] = [];
      const oldest = this.historyBars === null ? -Infinity : expectedLastTs(interval, now) - (this.historyBars - 1) * iv;
      for (let ts = range.start; ts <= range.end; ts += iv) {
        if (ts < (o.listedFrom ?? T0) || ts < oldest || o.missing?.has(ts) || !isClosed(ts, interval, now)) continue;
        const c = mk(ts, (o.close ?? (() => 100))(ts) + (symbol === 'ETH' ? 1 : 0));
        out.push(o.bad ? o.bad(c) : c);
      }
      return out;
    },
  };
  return Object.assign(src, { calls, penalties });
}
const cfg = (over: Partial<import('../src/market/pipeline.ts').MarketConfig> = {}) => ({ symbols: ['BTC'] as MarketSymbol[], intervals: ['1h'] as Interval[], depthMs: { '1h': 600 * H, '1d': null, '5m': 30 * D }, ...over });
const count = async (source?: string) => (await sql`select count(*)::int as n from candles where ${source ? sql`source = ${source}` : sql`true`}`)[0].n as number;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (!(e instanceof MarketDataError)) throw e; return e.code; } };

describe('storage', () => {
  it('upsert is idempotent and corrects a bar that changed', async () => {
    const bars = Array.from({ length: 2500 }, (_, i) => mk(T0 + i * H, 100 + i / 10));
    expect(await store.upsertCandles('coinbase', 'BTC', '1h', bars)).toBe(2500);
    expect(await store.upsertCandles('coinbase', 'BTC', '1h', bars)).toBe(0);
    expect(await count()).toBe(2500);
    const fixed = { ...bars[7]!, close: 100.9, high: 102 };
    expect(await store.upsertCandles('coinbase', 'BTC', '1h', [bars[6]!, fixed])).toBe(1);
    expect(await count()).toBe(2500);
    const [row] = await sql`select * from candles where ts = ${new Date(fixed.ts)}`;
    expect(row).toMatchObject({ source: 'coinbase', symbol: 'BTC', interval: '1h', open: fixed.open, high: 102, low: fixed.low, close: 100.9, volume: 5 });
    expect(row.ts.getTime()).toBe(fixed.ts);
    // the key is (source, symbol, interval, ts): the same bar time elsewhere is another row
    await store.upsertCandles('bitstamp', 'BTC', '1h', [bars[0]!]); await store.upsertCandles('coinbase', 'ETH', '1h', [bars[0]!]); await store.upsertCandles('coinbase', 'BTC', '1d', [bars[0]!]);
    expect(await count()).toBe(2503);
    expect(await store.latestTs('coinbase', 'BTC', '1h')).toBe(T0 + 2499 * H);
    expect(await store.earliestTs('coinbase', 'BTC', '1h')).toBe(T0);
    expect(await store.latestTs('kraken', 'BTC', '1h')).toBeNull();
    expect(await store.upsertCandles('coinbase', 'BTC', '1h', [])).toBe(0);
  });

  it('floats survive the round trip exactly', async () => {
    const c: Candle = { ts: T0, open: 0.123456789012345, high: 73929.39, low: 1e-7, close: 0.1 + 0.2, volume: 250.45835878 };
    await store.upsertCandles('coinbase', 'DOGE', '1h', [c]);
    expect((await store.loadBySource('DOGE', '1h', T0)).coinbase).toEqual([c]);
  });
});

describe('pipeline', () => {
  it('incremental update: first pass fetches the recent page, then nothing until a new bar closes', async () => {
    const a = fake('coinbase'), b = fake('bitstamp', { maxBars: 1000 });
    let now = NOW;
    const first = await pipe.updateAll([a, b], cfg(), () => now);
    expect(first).toMatchObject({ requests: 2, written: 300 + 1000, rejected: 0, errors: [] });
    expect(a.calls).toEqual([{ symbol: 'BTC', interval: '1h', start: LAST - 299 * H, end: LAST }]);
    expect(await pipe.updateAll([a, b], cfg(), () => now)).toMatchObject({ requests: 0, written: 0 });
    expect(a.calls).toHaveLength(1);
    now += H;
    expect(await pipe.updateAll([a, b], cfg(), () => now)).toMatchObject({ requests: 2, written: 2 });
    // it re-reads the two bars before the last stored one
    expect(a.calls[1]).toEqual({ symbol: 'BTC', interval: '1h', start: LAST - 2 * H, end: LAST + H });
    expect(await store.latestTs('coinbase', 'BTC', '1h')).toBe(LAST + H);
  });

  it('incremental update catches up page by page after a long stop', async () => {
    const a = fake('coinbase', { maxBars: 100 });
    let now = NOW;
    await pipe.updateAll([a], cfg(), () => now);
    now += 250 * H;
    expect(await pipe.updateAll([a], cfg(), () => now, 2)).toMatchObject({ requests: 2 });
    expect(await store.latestTs('coinbase', 'BTC', '1h')).toBe(LAST - 2 * H + 199 * H);
    await pipe.updateAll([a], cfg(), () => now, 2);
    expect(await store.latestTs('coinbase', 'BTC', '1h')).toBe(LAST + 250 * H);
    const { gaps } = await series.getSeries('BTC', '1h', { limit: 350, priority: ['coinbase'] });
    expect(gaps).toBe(0);
  });

  it('rejected bars are counted and never stored', async () => {
    const a = fake('coinbase', { bad: (c) => (c.ts === LAST - 5 * H ? { ...c, high: c.low / 2 } : c.ts === LAST - 6 * H ? { ...c, close: -1 } : c) });
    const r = await pipe.updateAll([a], cfg(), () => NOW);
    expect(r).toMatchObject({ rejected: 2, written: 298 });
    expect((await sql`select 1 from candles where ts in (${new Date(LAST - 5 * H)}, ${new Date(LAST - 6 * H)})`).length).toBe(0);
    expect(pipe.rejectedCount.high_below_low).toBeGreaterThanOrEqual(1);
  });

  it('a failing exchange does not stop the others, and is left alone after a rate-limit answer', async () => {
    const down = fake('coinbase', { fail: () => new TypeError('fetch failed'), symbols: ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE'] });
    const limited = fake('kraken', { fail: () => new SourceError('kraken', 'rate_limited', 'too many requests') });
    const ok = fake('bitstamp');
    const r = await pipe.updateAll([down, limited, ok], cfg({ symbols: ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE'] }), () => NOW);
    expect(down.calls).toHaveLength(3); // three failures in a row: given up for this pass
    expect(limited.calls).toHaveLength(1);
    expect(limited.penalties).toEqual([30_000]);
    expect(ok.calls).toHaveLength(2);
    expect(r.errors).toHaveLength(4);
    expect(await count('bitstamp')).toBe(600);
    expect(await count('coinbase')).toBe(0);
  });

  it('backfill pages backward to the configured depth, within a request budget, and resumes', async () => {
    const a = fake('coinbase', { maxBars: 100 });
    await pipe.updateAll([a], cfg(), () => NOW); // 100 most recent bars
    const done = new Set<string>();
    const one = await pipe.backfill([a], cfg(), { done, maxRequests: 2 }, () => NOW);
    expect(one).toMatchObject({ requests: 2, written: 200, complete: false });
    expect(await count()).toBe(300);
    const two = await pipe.backfill([a], cfg(), { done, maxRequests: 50 }, () => NOW);
    expect(two.complete).toBe(true);
    // depth 600 h from NOW (T0 + 1000 h + 1 min): the oldest bar wanted opens at T0 + 401 h
    expect(await store.earliestTs('coinbase', 'BTC', '1h')).toBe(T0 + 401 * H);
    expect(await count()).toBe(599);
    expect((await series.getSeries('BTC', '1h', { limit: 1000, priority: ['coinbase'] })).gaps).toBe(0);
    // nothing more to do, with or without the memory of the previous passes
    a.calls.length = 0;
    expect(await pipe.backfill([a], cfg(), { done, maxRequests: 50 }, () => NOW)).toMatchObject({ requests: 0, complete: true });
    expect(await pipe.backfill([a], cfg(), { done: new Set(), maxRequests: 50 }, () => NOW)).toMatchObject({ requests: 0, complete: true });
    expect(a.calls).toHaveLength(0);
    // running everything again changes nothing
    const before = await count();
    await pipe.updateAll([a], cfg(), () => NOW);
    expect(await count()).toBe(before);
  });

  it('backfill of "all available" stops at the listing date; a source with a short memory is not asked for more', async () => {
    const a = fake('coinbase', { maxBars: 100, listedFrom: T0 + 730 * H });
    const k = fake('kraken', { maxBars: 720, historyBars: 720 });
    const c = cfg({ depthMs: { '1h': null, '1d': null, '5m': null } });
    await pipe.updateAll([a, k], c, () => NOW);
    expect(k.calls).toHaveLength(1);
    expect(await count('kraken')).toBe(720);
    const r = await pipe.backfill([a, k], c, { done: new Set(), maxRequests: 50 }, () => NOW);
    expect(r.complete).toBe(true);
    expect(k.calls).toHaveLength(1);
    expect(await store.earliestTs('coinbase', 'BTC', '1h')).toBe(T0 + 730 * H);
    expect(a.calls.at(-1)).toMatchObject({ end: T0 + 699 * H }); // the empty page that proved there is nothing older
    expect(await count('coinbase')).toBe(270);
  });

  it('backfill respects a deadline', async () => {
    const a = fake('coinbase', { maxBars: 100 });
    let t = NOW;
    const r = await pipe.backfill([a], cfg(), { done: new Set(), maxRequests: 50, deadline: NOW + 2500 }, () => (t += 1000));
    expect(r.complete).toBe(false);
    expect(r.requests).toBeLessThan(3);
  });
});

describe('getSeries', () => {
  beforeEach(async () => {
    await store.upsertCandles('coinbase', 'BTC', '1h', [0, 1, 2, 4, 5].map((i) => mk(T0 + i * H, 100 + i)));
    await store.upsertCandles('bitstamp', 'BTC', '1h', [0, 1, 2, 3, 4, 5].map((i) => mk(T0 + i * H, 200 + i)));
    await store.upsertCandles('kraken', 'BTC', '1h', [3, 4, 5, 8].map((i) => mk(T0 + i * H, 300 + i)));
    await store.upsertCandles('coinbase', 'ETH', '1h', [mk(T0, 9)]);
    await store.upsertCandles('coinbase', 'BTC', '1d', [mk(T0, 7)]);
  });

  it('returns one consolidated series: whole bars of the best-ranked source, labelled', async () => {
    const s = await series.getSeries('BTC', '1h', { limit: 100 });
    expect(s.bars.map((b) => [(b.ts - T0) / H, b.source, b.close])).toEqual([[0, 'coinbase', 100], [1, 'coinbase', 101], [2, 'coinbase', 102], [3, 'bitstamp', 203], [4, 'coinbase', 104], [5, 'coinbase', 105], [8, 'kraken', 308]]);
    expect(s.bars[3]).toEqual({ ...mk(T0 + 3 * H, 203), source: 'bitstamp' });
    expect(s).toMatchObject({ symbol: 'BTC', interval: '1h', gaps: 2, provided: { coinbase: 5, bitstamp: 1, kraken: 1 }, priority: ['coinbase', 'bitstamp', 'kraken'] });
  });

  it('applies limit and until on the consolidated bars', async () => {
    expect((await series.getSeries('BTC', '1h', { limit: 3 })).bars.map((b) => (b.ts - T0) / H)).toEqual([4, 5, 8]);
    const s = await series.getSeries('BTC', '1h', { limit: 3, until: T0 + 5 * H });
    expect(s.bars.map((b) => (b.ts - T0) / H)).toEqual([3, 4, 5]);
    expect(s.gaps).toBe(0);
    expect((await series.getSeries('BTC', '1h', { limit: 2, until: T0 + 3 * H + 1 })).bars.map((b) => b.source)).toEqual(['coinbase', 'bitstamp']);
    expect((await series.getSeries('BTC', '1h', { limit: 5, until: T0 - 1 })).bars).toEqual([]);
    expect((await series.getSeries('BTC', '1h', { limit: 100, priority: ['kraken', 'bitstamp'] })).bars.map((b) => b.source)).toEqual(['bitstamp', 'bitstamp', 'bitstamp', 'kraken', 'kraken', 'kraken', 'kraken']);
    expect((await series.getSeries('BTC', '1d', { limit: 10 })).bars).toHaveLength(1);
    expect((await series.getSeries('SOL', '1h', { limit: 10 })).bars).toEqual([]);
  });

  it('refuses an unknown symbol or interval', async () => {
    expect(await code(series.getSeries('NOPE' as never, '1h', { limit: 1 }))).toBe('unsupported');
    expect(await code(series.getSeries('BTC', '2h' as never, { limit: 1 }))).toBe('unsupported');
  });
});

describe('assertFresh', () => {
  const fill = async (o: Partial<Record<SourceId, Parameters<typeof fake>[1]>> = {}, now = NOW) => {
    const srcs = (['coinbase', 'bitstamp', 'kraken'] as SourceId[]).map((id) => fake(id, o[id]));
    await pipe.updateAll(srcs, cfg(), () => now);
    return srcs;
  };

  it('passes when the series is fresh, complete and confirmed, and returns the report', async () => {
    await fill({ bitstamp: { close: () => 100.2 } });
    const r = await series.assertFresh('BTC', '1h', NOW);
    expect(r).toMatchObject({ status: 'ok', fresh: true, lastTs: LAST, gaps: 0, bars: 200 });
    expect(r.maxDeviationBps).toBe(0); // coinbase is confirmed exactly by kraken; bitstamp's 20 bps are recorded in `agreement`
    expect(r.agreement.at(-1)!.closes).toMatchObject({ coinbase: 100, bitstamp: 100.2 });
  });

  it('stale: the latest bar is missing for more than one bar', async () => {
    await fill();
    expect(await code(series.assertFresh('BTC', '1h', NOW + H))).toBe('ok');
    expect(await code(series.assertFresh('BTC', '1h', NOW + 2 * H))).toBe('stale');
    expect(await code(series.assertFresh('BTC', '1h', NOW + H, { maxLagBars: 0 }))).toBe('stale');
    const e = await series.assertFresh('BTC', '1h', NOW + 5 * H).catch((x) => x);
    expect(e).toBeInstanceOf(MarketDataError);
    expect(e.report).toMatchObject({ status: 'stale', lagBars: 5, lastTs: LAST });
    expect(e.message).toContain('5 bars behind');
  });

  it('gap: a hole inside the requested window, on every source', async () => {
    const missing = new Set([LAST - 20 * H]);
    await fill({ coinbase: { missing }, bitstamp: { missing }, kraken: { missing } });
    expect(await code(series.assertFresh('BTC', '1h', NOW))).toBe('gap');
    expect(await code(series.assertFresh('BTC', '1h', NOW, { lookback: 20 }))).toBe('ok');
    expect(await code(series.assertFresh('BTC', '1h', NOW, { lookback: 21 }))).toBe('gap');
  });

  it('a hole on the primary source alone is not a gap: the next source provides that bar', async () => {
    await fill({ coinbase: { missing: new Set([LAST - 20 * H]) } });
    expect(await series.assertFresh('BTC', '1h', NOW)).toMatchObject({ provided: { coinbase: 199, bitstamp: 1 } });
    expect((await series.getSeries('BTC', '1h', { limit: 21 })).bars[0]).toMatchObject({ ts: LAST - 20 * H, source: 'bitstamp' });
  });

  it('insufficient history: the window asked for is longer than what is stored', async () => {
    await fill();
    expect(await code(series.assertFresh('BTC', '1h', NOW, { lookback: 300 }))).toBe('ok');
    expect(await code(series.assertFresh('BTC', '1h', NOW, { lookback: 301 }))).toBe('insufficient_history');
  });

  it('disagreement: sources apart by more than 50 bps on one of the last bars', async () => {
    await fill({ coinbase: { close: (ts) => (ts === LAST - H ? 100.6 : 100) } }); // the bar the series uses is the one that is off
    const e = await series.assertFresh('BTC', '1h', NOW).catch((x) => x);
    expect(e).toMatchObject({ code: 'disagreement' });
    expect(e.report.agreement[1]).toMatchObject({ ts: LAST - H, closes: { coinbase: 100.6, bitstamp: 100, kraken: 100 } });
    expect(await code(series.assertFresh('BTC', '1h', NOW, { maxDeviationBps: 100 }))).toBe('ok');
    expect(await code(series.assertFresh('BTC', '1h', NOW, { agreeBars: 1 }))).toBe('ok');
  });

  it('single source down: with two sources configured, the survivor alone is refused', async () => {
    const two = { priority: ['coinbase', 'bitstamp'] as SourceId[] };
    const [a, b] = await fill();
    expect(await code(series.assertFresh('BTC', '1h', NOW, two))).toBe('ok');
    const now = NOW + 2 * H;
    await pipe.updateAll([a!, fake('bitstamp', { fail: () => new TypeError('fetch failed') })], cfg(), () => now);
    expect(await store.latestTs('coinbase', 'BTC', '1h')).toBe(LAST + 2 * H);
    expect(await store.latestTs('bitstamp', 'BTC', '1h')).toBe(LAST);
    expect(await code(series.assertFresh('BTC', '1h', now, two))).toBe('insufficient_sources');
    // and the other way round: the primary is down, the fallback serves the bars but nobody confirms them
    await sql`truncate candles`;
    await fill();
    await pipe.updateAll([fake('coinbase', { fail: () => new TypeError('fetch failed') }), b!], cfg(), () => now);
    expect(await code(series.assertFresh('BTC', '1h', now, two))).toBe('insufficient_sources');
    expect((await series.getSeries('BTC', '1h', { limit: 1, ...two })).bars[0]).toMatchObject({ ts: LAST + 2 * H, source: 'bitstamp' });
    // once it is back and has caught up, the series is usable again
    await pipe.updateAll([fake('coinbase'), b!], cfg(), () => now);
    expect(await code(series.assertFresh('BTC', '1h', now, two))).toBe('ok');
  });

  it('with three sources one may be down, not two', async () => {
    const [a, b, k] = await fill();
    const now = NOW + 3 * H, dead = (id: SourceId) => fake(id, { fail: () => new TypeError('fetch failed') });
    await pipe.updateAll([dead('coinbase'), b!, k!], cfg(), () => now);
    expect(await series.assertFresh('BTC', '1h', now)).toMatchObject({ status: 'ok', provided: { coinbase: 197, bitstamp: 3 } });
    await pipe.updateAll([a!, dead('bitstamp'), dead('kraken')], cfg(), () => now + H);
    expect(await code(series.assertFresh('BTC', '1h', now + H))).toBe('insufficient_sources');
  });

  it('no data, unknown series, and a database that does not answer: never a yes', async () => {
    expect(await code(series.assertFresh('BTC', '1h', NOW))).toBe('no_data');
    await fill();
    expect(await code(series.assertFresh('ETH', '1d', NOW))).toBe('no_data');
    expect(await code(series.assertFresh('NOPE' as never, '1h', NOW))).toBe('unsupported');
    expect(await code(series.assertFresh('BTC', '1w' as never, NOW))).toBe('unsupported');
    await sql`alter table candles rename to candles_gone`;
    try { await expect(series.assertFresh('BTC', '1h', NOW)).rejects.toThrow(/candles/); }
    finally { await sql`alter table candles_gone rename to candles`; }
  });

  it('uses the stored bars, not the cached quality record', async () => {
    await fill();
    await pipe.recomputeQuality(cfg(), ['coinbase', 'bitstamp', 'kraken'], NOW);
    expect((await store.listQuality())[0]).toMatchObject({ symbol: 'BTC', interval: '1h', status: 'ok', fresh: true });
    expect(await code(series.assertFresh('BTC', '1h', NOW + 6 * H))).toBe('stale');
  });
});

describe('quality record and routes', () => {
  it('stores one row per (symbol, interval), replaced at each recomputation', async () => {
    const srcs = [fake('coinbase'), fake('bitstamp', { close: (ts) => (ts === LAST ? 101 : 100) })];
    const c = cfg({ symbols: ['BTC', 'ETH'] });
    await pipe.updateAll(srcs, c, () => NOW);
    const r = await pipe.recomputeQuality(c, ['coinbase', 'bitstamp'], NOW);
    expect(r['BTC:1h']).toMatchObject({ status: 'disagreement', bars: 300, missingHistory: 420 });
    let rows = await store.listQuality();
    expect(rows.map((q: any) => [q.symbol, q.interval, q.status, q.fresh, q.gaps])).toEqual([['BTC', '1h', 'disagreement', true, 0], ['ETH', '1h', 'disagreement', true, 0]]);
    expect(rows[0]!.last_ts!.getTime()).toBe(LAST);
    expect(rows[0]!.checked_at.getTime()).toBe(NOW);
    expect(rows[0]!.max_deviation_bps).toBeCloseTo((1 / 100.5) * 1e4, 6);
    expect(rows[0]!.detail.failures[0]!.code).toBe('disagreement');
    await pipe.recomputeQuality(c, ['coinbase', 'bitstamp'], NOW + 4 * H);
    rows = await store.listQuality();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'stale', fresh: false });
    await sql`truncate candles`;
    await pipe.recomputeQuality(c, ['coinbase', 'bitstamp'], NOW);
    expect((await store.listQuality())[0]).toMatchObject({ status: 'no_data', fresh: false, last_ts: null, max_deviation_bps: null });
  });

  it('GET /market-data/candles and /market-data/status', async () => {
    const srcs = [fake('coinbase', { missing: new Set([LAST - H]) }), fake('bitstamp'), fake('kraken')];
    await pipe.updateAll(srcs, cfg(), () => NOW);
    await pipe.recomputeQuality(cfg(), ['coinbase', 'bitstamp', 'kraken'], NOW);
    const app = Fastify();
    routes.marketDataRoutes(app);
    const candles = (await app.inject({ method: 'GET', url: '/api/v1/market-data/candles?symbol=BTC&interval=1h&limit=3' })).json();
    expect(candles).toMatchObject({ symbol: 'BTC', interval: '1h', gaps: 0, priority: ['coinbase', 'bitstamp', 'kraken'], provided: { coinbase: 2, bitstamp: 1 } });
    expect(candles.bars.map((b: any) => [b.ts, b.source])).toEqual([[LAST - 2 * H, 'coinbase'], [LAST - H, 'bitstamp'], [LAST, 'coinbase']]);
    expect(Object.keys(candles.bars[0]).sort()).toEqual(['close', 'high', 'low', 'open', 'source', 'ts', 'volume']);
    expect((await app.inject({ method: 'GET', url: '/api/v1/market-data/candles?symbol=BTC&interval=1h' })).json().bars).toHaveLength(300);
    for (const bad of ['symbol=NOPE&interval=1h', 'symbol=BTC&interval=2h', 'symbol=BTC&interval=1h&limit=0', 'symbol=BTC&interval=1h&limit=9999999', 'interval=1h'])
      expect((await app.inject({ method: 'GET', url: `/api/v1/market-data/candles?${bad}` })).statusCode).not.toBe(200);
    const status = (await app.inject({ method: 'GET', url: '/api/v1/market-data/status' })).json();
    // V5: the base ten plus every symbol the token registry makes tradable on an execution-enabled network
    const BASE = ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE', 'AVAX', 'BNB', 'DOGE', 'LTC', 'XRP'];
    expect(status.symbols.slice(0, 10)).toEqual(BASE);
    expect(status.symbols.length).toBeGreaterThan(10);
    expect(status.symbols).toEqual(expect.arrayContaining(['UNI', 'POL', 'HYPE']));
    expect(status.only['5m']).toEqual(BASE);
    expect(status.sources.map((s: any) => s.id)).toEqual(['coinbase', 'bitstamp', 'kraken']);
    for (const s of status.sources) { for (const b of BASE) expect(s.pairs[b]).toBeTruthy(); for (const k of Object.keys(s.pairs)) expect(status.symbols).toContain(k); }
    for (const sym of status.symbols) expect(status.sources.filter((s: any) => s.pairs[sym]).length).toBeGreaterThanOrEqual(2); // two exchanges at least
    expect(status.coverage).toEqual([
      { source: 'bitstamp', symbol: 'BTC', interval: '1h', bars: 300, first: new Date(LAST - 299 * H).toISOString(), last: new Date(LAST).toISOString() },
      { source: 'coinbase', symbol: 'BTC', interval: '1h', bars: 299, first: new Date(LAST - 299 * H).toISOString(), last: new Date(LAST).toISOString() },
      { source: 'kraken', symbol: 'BTC', interval: '1h', bars: 300, first: new Date(LAST - 299 * H).toISOString(), last: new Date(LAST).toISOString() },
    ]);
    expect(status.quality).toHaveLength(1);
    expect(status.quality[0]).toMatchObject({ symbol: 'BTC', interval: '1h', status: 'ok', fresh: true, gaps: 0, lastTs: new Date(LAST).toISOString(), provided: { coinbase: 299, bitstamp: 1 } });
    expect(status.thresholds).toMatchObject({ maxDeviationBps: 50, minSources: 2, maxLagBars: 1 });
    await app.close();
  });

  it('both routes are behind the session check of the real server, and the old chart route is untouched', async () => {
    const { buildServer } = await import('../src/server.ts');
    const app = await buildServer();
    for (const url of ['/api/v1/market-data/status', '/api/v1/market-data/candles?symbol=BTC&interval=1h'])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/market/:symbol' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/market-data/status' })).toBe(true);
    await app.close();
  });
});

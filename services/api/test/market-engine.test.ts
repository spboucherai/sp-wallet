// Market data engine, pure parts (no network, no database): the three exchange adapters replayed against answers recorded
// live (scripts/record-market-fixtures.mts), bar validation, gap counting, cross-source deviation, the consolidation rule
// and the quality verdict behind assertFresh.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { consolidate, deviations, evaluate, spreadBps } from '../src/market/quality.ts';
import { INTERVAL_MS, SourceError, expectedLastTs, isClosed, type BySource, type Candle, type HttpJson, type Interval, type MarketSource, type SourceId } from '../src/market/types.ts';
import { findGaps, normalise, validateBars } from '../src/market/validate.ts';

type Fixture = { source: SourceId; interval: Interval; recordedAt: number; range: { start: number; end: number }; url: string; status: number; body: any };
const fx = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/market/${name}.json`, import.meta.url), 'utf8'));
const replay = (f: { url: string; status: number; body: unknown }): HttpJson => async (url) => { expect(url).toBe(f.url); return { status: f.status, body: structuredClone(f.body) }; };
const answer = (status: number, body: unknown): HttpJson => async () => ({ status, body });

let make: Record<SourceId, (o: { get: HttpJson; spacingMs: number }) => MarketSource>;
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///spw_market_test', SPW_SIGNER_SECRET: 'k'.repeat(48) });
  const s = await import('../src/market/sources.ts');
  make = { coinbase: s.coinbaseSource, bitstamp: s.bitstampSource, kraken: s.krakenSource };
});

const H = INTERVAL_MS['1h'];
const T0 = Date.UTC(2026, 5, 1, 0, 0), NOW = T0 + 100 * H + 60_000; // 100 closed hourly bars: T0 .. T0 + 99 h
const mk = (ts: number, close = 100, o: Partial<Candle> = {}): Candle => ({ ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 5, ...o });
const run = (n: number, close: (i: number) => number = () => 100, from = T0 + (100 - n) * H): Candle[] => Array.from({ length: n }, (_, i) => mk(from + i * H, close(i)));

describe('adapters against recorded answers', () => {
  const SOURCES: SourceId[] = ['coinbase', 'bitstamp', 'kraken'];
  const PLAN: [Interval, number][] = [['1h', 48], ['1d', 30], ['5m', 24]];

  for (const id of SOURCES) for (const [interval, n] of PLAN) {
    it(`${id} BTC ${interval}: closed bars only, oldest first, on the grid, all valid`, async () => {
      const f = fx(`${id}-BTC-${interval}`), iv = INTERVAL_MS[interval];
      const bars = await make[id]({ get: replay(f), spacingMs: 0 }).candles('BTC', interval, f.range, f.recordedAt);
      expect(bars).toHaveLength(n);
      expect(bars[0]!.ts).toBe(f.range.start);
      // the request reached one bar past the last closed one: the answer contains the open bar, the adapter drops it
      expect(bars.at(-1)!.ts).toBe(expectedLastTs(interval, f.recordedAt));
      expect(bars.at(-1)!.ts).toBe(f.range.end - iv);
      expect(JSON.stringify(f.body)).toContain(String(f.range.end / 1000));
      expect(bars.every((b, i) => i === 0 || b.ts === bars[i - 1]!.ts + iv)).toBe(true);
      expect(bars.every((b) => isClosed(b.ts, interval, f.recordedAt))).toBe(true);
      expect(Object.keys(bars[0]!).sort()).toEqual(['close', 'high', 'low', 'open', 'ts', 'volume']);
      expect(validateBars(bars, interval, f.recordedAt).rejected).toEqual([]);
      expect(bars.every((b) => b.close > 10_000 && b.close < 1_000_000 && b.volume >= 0)).toBe(true);
    });
  }

  it('maps each exchange layout to the same fields (first recorded bar, by hand)', async () => {
    const c = fx('coinbase-BTC-1h'), b = fx('bitstamp-BTC-1h'), k = fx('kraken-BTC-1h');
    const cRow = (c.body as number[][]).find((r) => r[0] === c.range.start / 1000)!; // [time, low, high, open, close, volume]
    expect((await make.coinbase({ get: replay(c), spacingMs: 0 }).candles('BTC', '1h', c.range, c.recordedAt))[0])
      .toEqual({ ts: c.range.start, low: cRow[1], high: cRow[2], open: cRow[3], close: cRow[4], volume: cRow[5] });
    const bRow = b.body.data.ohlc.find((r: any) => Number(r.timestamp) === b.range.start / 1000);
    expect((await make.bitstamp({ get: replay(b), spacingMs: 0 }).candles('BTC', '1h', b.range, b.recordedAt))[0])
      .toEqual({ ts: b.range.start, open: Number(bRow.open), high: Number(bRow.high), low: Number(bRow.low), close: Number(bRow.close), volume: Number(bRow.volume) });
    const kRow = k.body.result.XXBTZUSD.find((r: any) => r[0] === k.range.start / 1000); // [time, open, high, low, close, vwap, volume, count]
    expect((await make.kraken({ get: replay(k), spacingMs: 0 }).candles('BTC', '1h', k.range, k.recordedAt))[0])
      .toEqual({ ts: k.range.start, open: Number(kRow[1]), high: Number(kRow[2]), low: Number(kRow[3]), close: Number(kRow[4]), volume: Number(kRow[6]) });
  });

  it('the three exchanges, recorded at the same moment, agree within 50 bps on every hourly close', async () => {
    const by: BySource = {};
    for (const id of SOURCES) { const f = fx(`${id}-BTC-1h`); by[id] = await make[id]({ get: replay(f), spacingMs: 0 }).candles('BTC', '1h', f.range, f.recordedAt); }
    const d = deviations(by);
    expect(d).toHaveLength(48);
    expect(Math.max(...d.map((x) => x.bps))).toBeLessThan(50);
    expect(evaluate(by, '1h', fx('coinbase-BTC-1h').recordedAt, { lookback: 48 }).status).toBe('ok');
  });

  it('kraken: a bar newer than `last` is never returned, even if the local clock says it is closed', async () => {
    const f = fx('kraken-BTC-1h');
    const bars = await make.kraken({ get: replay(f), spacingMs: 0 }).candles('BTC', '1h', f.range, f.recordedAt + 2 * H);
    expect(bars.at(-1)!.ts).toBe(f.body.result.last * 1000);
    expect(bars).toHaveLength(48);
  });

  it('refuses an unknown pair as each exchange really answers it', async () => {
    for (const id of SOURCES) {
      const f = fx(`${id}-unknown-pair`);
      await expect(make[id]({ get: answer(f.status, f.body), spacingMs: 0 }).candles('BTC', '1h', { start: T0, end: T0 + H }, NOW)).rejects.toMatchObject({ source: id, kind: 'http' });
    }
  });

  it('reports rate limiting, malformed answers, unlisted symbols and oversized ranges as typed errors', async () => {
    const range = { start: T0, end: T0 + H };
    await expect(make.coinbase({ get: answer(429, { message: 'Too Many Requests' }), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'rate_limited' });
    // observed live on 2026-11-10 after ten unpaced calls: HTTP 200 with this body
    await expect(make.kraken({ get: answer(200, { error: ['EGeneral:Too many requests'] }), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(make.bitstamp({ get: answer(400, { status: 'error', code: '400.002', reason: 'Request rejected due to exceeded rate limit.' }), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(make.coinbase({ get: answer(200, [[T0 / 1000, '1', 2, 1, 2, 3]]), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'schema' });
    await expect(make.coinbase({ get: answer(200, { message: 'maintenance' }), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'schema' });
    await expect(make.bitstamp({ get: answer(200, { data: { ohlc: [{ timestamp: String(T0 / 1000), open: 'abc', high: '2', low: '1', close: '2', volume: '1' }] } }), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'schema' });
    await expect(make.kraken({ get: answer(200, { error: [], result: { XXBTZUSD: [[T0 / 1000, '1', '2', '1', '2', '1', '1', 3]] } }), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toMatchObject({ kind: 'schema' });
    await expect(make.bitstamp({ get: answer(503, null), spacingMs: 0 }).candles('BTC', '1h', range, NOW)).rejects.toBeInstanceOf(SourceError);
    const never: HttpJson = async () => { throw new Error('must not be called'); };
    await expect(make.coinbase({ get: never, spacingMs: 0 }).candles('NOPE' as never, '1h', range, NOW)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(make.coinbase({ get: never, spacingMs: 0 }).candles('BTC', '1h', { start: T0, end: T0 + 298 * H }, NOW)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(make.coinbase({ get: never, spacingMs: 0 }).candles('BTC', '1h', { start: T0 + 1000, end: T0 + H }, NOW)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('builds the documented requests', async () => {
    const urls: string[] = [];
    const get: HttpJson = async (url) => { urls.push(url); return { status: 200, body: url.includes('kraken') ? { error: [], result: { XDGUSD: [], last: 0 } } : url.includes('bitstamp') ? { data: { ohlc: [] } } : [] }; };
    const past = { start: T0, end: T0 + 297 * H };
    await make.coinbase({ get, spacingMs: 0 }).candles('ETH', '1h', past, NOW + 1000 * H);
    await make.coinbase({ get, spacingMs: 0 }).candles('ETH', '1h', { start: T0, end: T0 + 99 * H }, NOW);
    await make.bitstamp({ get, spacingMs: 0 }).candles('ETH', '1d', { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 10) }, NOW);
    await make.kraken({ get, spacingMs: 0 }).candles('DOGE', '5m', { start: T0, end: T0 + H }, NOW);
    expect(urls).toEqual([
      'https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600&start=2026-06-01T00:00:00.000Z&end=2026-06-13T09:00:00.000Z',
      // a window touching the present ends at the current second, so that the CDN cache cannot serve an older copy
      'https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600&start=2026-06-01T00:00:00.000Z&end=2026-06-05T04:01:00.000Z',
      'https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=86400&limit=10&end=1768003200',
      `https://api.kraken.com/0/public/OHLC?pair=XDGUSD&interval=5&since=${T0 / 1000 - 1}`,
    ]);
  });

  it('paces the calls to one exchange', async () => {
    const at: number[] = [];
    const src = make.coinbase({ get: async () => { at.push(Date.now()); return { status: 200, body: [] }; }, spacingMs: 60 });
    await Promise.all([0, 1, 2].map(() => src.candles('BTC', '1h', { start: T0, end: T0 + H }, NOW)));
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(55);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(55);
  });
});

describe('validation', () => {
  const ts = T0 + 10 * H, good = mk(ts);
  const cases: [string, Candle, string][] = [
    ['zero open', { ...good, open: 0 }, 'non_positive_price'],
    ['negative low', { ...good, low: -1 }, 'non_positive_price'],
    ['zero close', { ...good, close: 0, low: 0 }, 'non_positive_price'],
    ['negative volume', { ...good, volume: -0.1 }, 'negative_volume'],
    ['high below low', { ...good, high: 98, low: 99, open: 98.5, close: 98.5 }, 'high_below_low'],
    ['open above high', { ...good, open: 102 }, 'open_out_of_range'],
    ['open below low', { ...good, open: 98 }, 'open_out_of_range'],
    ['close above high', { ...good, close: 101.5 }, 'close_out_of_range'],
    ['close below low', { ...good, close: 98.9 }, 'close_out_of_range'],
    ['timestamp off the grid', { ...good, ts: ts + 60_000 }, 'off_grid'],
    ['fractional timestamp', { ...good, ts: ts + 0.5 }, 'off_grid'],
    ['bar from the future', { ...good, ts: T0 + 200 * H }, 'future'],
    ['bar still open', { ...good, ts: T0 + 100 * H }, 'not_closed'],
    ['NaN price', { ...good, high: NaN }, 'not_finite'],
    ['infinite volume', { ...good, volume: Infinity }, 'not_finite'],
  ];
  for (const [name, bar, reason] of cases) it(`rejects: ${name}`, () => {
    const r = validateBars([mk(ts - H), bar, mk(ts + H)], '1h', NOW);
    expect(r.rejected).toEqual([{ ts: bar.ts, reason }]);
    expect(r.bars.map((b) => b.ts)).toEqual([ts - H, ts + H]);
  });

  it('accepts a flat bar without volume and a bar that closed just long enough ago', () => {
    expect(validateBars([{ ts, open: 5, high: 5, low: 5, close: 5, volume: 0 }], '1h', NOW).rejected).toEqual([]);
    const last = T0 + 99 * H;
    expect(validateBars([mk(last)], '1h', last + H + 9_999).rejected).toEqual([{ ts: last, reason: 'not_closed' }]);
    expect(validateBars([mk(last)], '1h', last + H + 10_000).rejected).toEqual([]);
  });

  it('rejects every copy of a duplicated timestamp', () => {
    const r = validateBars([mk(ts, 100), mk(ts + H, 100), mk(ts, 101)], '1h', NOW);
    expect(r.rejected).toEqual([{ ts, reason: 'duplicate' }, { ts, reason: 'duplicate' }]);
    expect(r.bars.map((b) => b.ts)).toEqual([ts + H]);
  });

  it('normalises: oldest first, the six fields only', () => {
    const out = normalise([{ ...mk(ts + H), extra: 1 } as Candle, mk(ts)]);
    expect(out.map((b) => b.ts)).toEqual([ts, ts + H]);
    expect(Object.keys(out[1]!)).toEqual(['ts', 'open', 'high', 'low', 'close', 'volume']);
  });

  it('daily bars must open at 00:00 UTC', () => {
    const day = Date.UTC(2026, 5, 1);
    expect(validateBars([mk(day)], '1d', NOW).rejected).toEqual([]);
    expect(validateBars([mk(day + 4 * H)], '1d', NOW).rejected).toEqual([{ ts: day + 4 * H, reason: 'off_grid' }]);
  });
});

describe('gaps', () => {
  it('counts every missing slot and reports the holes', () => {
    expect(findGaps([T0, T0 + H, T0 + 2 * H], '1h')).toEqual({ gaps: 0, ranges: [] });
    expect(findGaps([T0, T0 + 2 * H, T0 + 3 * H, T0 + 7 * H], '1h')).toEqual({ gaps: 4, ranges: [{ from: T0 + H, to: T0 + H, missing: 1 }, { from: T0 + 4 * H, to: T0 + 6 * H, missing: 3 }] });
    expect(findGaps([], '1h').gaps).toBe(0);
    expect(findGaps([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 4)], '1d').gaps).toBe(2);
  });
});

describe('cross-source deviation', () => {
  it('is the spread of the closes in basis points of their midpoint', () => {
    expect(spreadBps([100])).toBeNull();
    expect(spreadBps([100, 100])).toBe(0);
    expect(spreadBps([99.75, 100.25])).toBeCloseTo(50, 9);
    expect(spreadBps([100, 100.1, 101])).toBeCloseTo((1 / 100.5) * 1e4, 9);
  });
  it('is computed per bar, only where at least two sources have the bar', () => {
    const d = deviations({ coinbase: [mk(T0, 100), mk(T0 + H, 100), mk(T0 + 2 * H, 100)], bitstamp: [mk(T0, 100.5), mk(T0 + 2 * H, 100)], kraken: [mk(T0, 99.5)] });
    expect(d.map((x) => x.ts)).toEqual([T0, T0 + 2 * H]);
    expect(d[0]!.bps).toBeCloseTo(100, 9);
    expect(d[0]!.closes).toEqual({ coinbase: 100, bitstamp: 100.5, kraken: 99.5 });
    expect(d[1]!.bps).toBe(0);
  });
});

describe('consolidation rule', () => {
  const by: BySource = {
    coinbase: [mk(T0, 100, { volume: 1 }), mk(T0 + 2 * H, 102, { volume: 1 })],
    bitstamp: [mk(T0, 100.2, { volume: 2 }), mk(T0 + H, 101.2, { volume: 2 }), mk(T0 + 2 * H, 102.2, { volume: 2 })],
    kraken: [mk(T0 + H, 101.4, { volume: 3 }), mk(T0 + 4 * H, 104.4, { volume: 3 })],
  };
  it('takes the whole bar of the highest-ranked source that has it, and says which', () => {
    const s = consolidate(by);
    expect(s.map((b) => [b.ts, b.source])).toEqual([[T0, 'coinbase'], [T0 + H, 'bitstamp'], [T0 + 2 * H, 'coinbase'], [T0 + 4 * H, 'kraken']]);
    // no field of another source leaks into a bar
    for (const b of s) { const { source, ...rest } = b; expect(by[source]!.find((c) => c.ts === b.ts)).toEqual(rest); }
    expect(s[1]).toEqual({ ...mk(T0 + H, 101.2, { volume: 2 }), source: 'bitstamp' });
  });
  it('does not invent a bar no source has, and follows the given priority', () => {
    expect(consolidate(by).some((b) => b.ts === T0 + 3 * H)).toBe(false);
    expect(consolidate(by, ['kraken', 'bitstamp']).map((b) => b.source)).toEqual(['bitstamp', 'kraken', 'bitstamp', 'kraken']);
    expect(consolidate({})).toEqual([]);
  });
});

describe('quality verdict (the logic of assertFresh)', () => {
  const three = (): BySource => ({ coinbase: run(100), bitstamp: run(100, () => 100.1), kraken: run(100, () => 99.95) });
  const O = { lookback: 100 };

  it('ok: fresh, complete, sources in agreement', () => {
    const r = evaluate(three(), '1h', NOW, O);
    expect(r).toMatchObject({ status: 'ok', failures: [], fresh: true, lagBars: 0, gaps: 0, bars: 100, missingHistory: 0, lastTs: T0 + 99 * H, expectedTs: T0 + 99 * H, provided: { coinbase: 100 } });
    expect(r.maxDeviationBps).toBeCloseTo(spreadBps([99.95, 100])!, 9); // the bar used (coinbase) against its nearest confirming source
    expect(r.agreement).toHaveLength(3);
    expect(r.window.compared).toBe(100);
  });

  it('stale: one bar of delay is tolerated, two are not', () => {
    expect(evaluate(three(), '1h', NOW + H, O)).toMatchObject({ status: 'ok', lagBars: 1 });
    const r = evaluate(three(), '1h', NOW + 2 * H, O);
    expect(r).toMatchObject({ status: 'stale', fresh: false, lagBars: 2 });
    expect(evaluate(three(), '1h', NOW, { ...O, maxLagBars: 0 }).status).toBe('ok');
    expect(evaluate(three(), '1h', NOW + H, { ...O, maxLagBars: 0 }).status).toBe('stale');
    expect(evaluate(three(), '1h', NOW + 30 * 24 * H, O).status).toBe('stale');
  });

  it('a bar that is not closed yet, or dated in the future, never counts as the latest bar', () => {
    const by = three();
    by.coinbase!.push(mk(T0 + 100 * H), mk(T0 + 500 * H));
    expect(evaluate(by, '1h', NOW, O)).toMatchObject({ status: 'ok', lastTs: T0 + 99 * H });
  });

  it('gap: a bar missing on every source inside the window', () => {
    const hole = T0 + 50 * H, by = three();
    for (const s of Object.keys(by) as SourceId[]) by[s] = by[s]!.filter((c) => c.ts !== hole);
    const r = evaluate(by, '1h', NOW, O);
    expect(r).toMatchObject({ status: 'gap', gaps: 1, gapRanges: [{ from: hole, to: hole, missing: 1 }] });
    // outside the requested window the hole does not matter
    expect(evaluate(by, '1h', NOW, { lookback: 40 }).status).toBe('ok');
  });

  it('a bar missing on the primary source only is filled by the next source, visibly', () => {
    const hole = T0 + 50 * H, by = three();
    by.coinbase = by.coinbase!.filter((c) => c.ts !== hole);
    const r = evaluate(by, '1h', NOW, O);
    expect(r).toMatchObject({ status: 'ok', gaps: 0, provided: { coinbase: 99, bitstamp: 1 } });
    expect(r.sources.coinbase).toMatchObject({ gaps: 1, bars: 99 });
  });

  it('insufficient history: fewer bars than the lookback (unless the caller only wants a status)', () => {
    expect(evaluate(three(), '1h', NOW, { lookback: 150 })).toMatchObject({ status: 'insufficient_history', missingHistory: 50, gaps: 0 });
    expect(evaluate(three(), '1h', NOW, { lookback: 150, requireHistory: false }).status).toBe('ok');
  });

  it('disagreement: closes further apart than the threshold on any of the last bars', () => {
    const by = three();
    // the bar the series uses (coinbase, first in priority) is the one that is off: no other source confirms it
    by.coinbase = run(100, (i) => (i === 98 ? 100.9 : 100));
    const r = evaluate(by, '1h', NOW, O);
    expect(r.status).toBe('disagreement');
    expect(r.maxDeviationBps).toBeGreaterThan(50);
    expect(evaluate(by, '1h', NOW, { ...O, maxDeviationBps: 100 }).status).toBe('ok');
    // a third source that is off while the bar used is confirmed by another one does not block
    const outlier = three(); outlier.bitstamp = run(100, (i) => (i === 98 ? 100.9 : 100.1));
    expect(evaluate(outlier, '1h', NOW, O).status).toBe('ok');
    // …but with only two sources there is nothing else to confirm the bar
    expect(evaluate({ coinbase: outlier.coinbase, bitstamp: outlier.bitstamp }, '1h', NOW, O).status).toBe('disagreement');
    by.coinbase = run(100);
    // an old disagreement (outside the last bars) is reported in the window statistics but does not block
    by.bitstamp = run(100, (i) => (i === 50 ? 103 : 100.1));
    const old = evaluate(by, '1h', NOW, O);
    expect(old.status).toBe('ok');
    expect(old.window.max).toBeGreaterThan(250);
    // exactly at the threshold passes, just above fails
    expect(evaluate({ coinbase: run(100, () => 99.75), bitstamp: run(100, () => 100.25) }, '1h', NOW, O).status).toBe('ok');
    expect(evaluate({ coinbase: run(100, () => 99.75), bitstamp: run(100, () => 100.26) }, '1h', NOW, O).status).toBe('disagreement');
  });

  it('single source down: with two sources, losing one fails; the series is never trusted on one source alone', () => {
    const two = { priority: ['coinbase', 'bitstamp'] as SourceId[], ...O };
    expect(evaluate({ coinbase: run(100), bitstamp: run(100) }, '1h', NOW, two).status).toBe('ok');
    // bitstamp stopped two hours ago
    expect(evaluate({ coinbase: run(100), bitstamp: run(98, () => 100, T0) }, '1h', NOW, two)).toMatchObject({ status: 'insufficient_sources', maxDeviationBps: 0 });
    // the primary stopped: the series falls back to bitstamp, which nobody confirms
    expect(evaluate({ coinbase: run(98, () => 100, T0), bitstamp: run(100) }, '1h', NOW, two)).toMatchObject({ status: 'insufficient_sources', provided: { coinbase: 98, bitstamp: 2 } });
    expect(evaluate({ coinbase: run(100) }, '1h', NOW, two)).toMatchObject({ status: 'insufficient_sources', maxDeviationBps: null });
    // a third source that is not in the configured list cannot vouch
    expect(evaluate({ coinbase: run(100), kraken: run(100) }, '1h', NOW, two).status).toBe('insufficient_sources');
  });

  it('with three sources, one down is tolerated as long as the two others agree; two down is not', () => {
    const by = three();
    by.coinbase = run(90, () => 100, T0);
    expect(evaluate(by, '1h', NOW, O)).toMatchObject({ status: 'ok', provided: { coinbase: 90, bitstamp: 10 } });
    by.kraken = run(97, () => 99.95, T0);
    expect(evaluate(by, '1h', NOW, O).status).toBe('insufficient_sources');
    expect(evaluate(three(), '1h', NOW, { ...O, minSources: 3 }).status).toBe('ok');
    by.kraken = run(100, () => 99.95);
    expect(evaluate(by, '1h', NOW, { ...O, minSources: 3 }).status).toBe('insufficient_sources');
  });

  it('no data', () => {
    expect(evaluate({}, '1h', NOW)).toMatchObject({ status: 'no_data', fresh: false, lastTs: null });
    expect(evaluate({ coinbase: [mk(T0 + 100 * H)] }, '1h', NOW).status).toBe('no_data');
  });

  it('several failures are all listed; the status is the first', () => {
    const r = evaluate({ coinbase: run(50, () => 100, T0).filter((_, i) => i !== 20) }, '1h', NOW, O);
    expect(r.failures.map((f) => f.code)).toEqual(['stale', 'gap', 'insufficient_history', 'insufficient_sources']);
    expect(r.status).toBe('stale');
  });
});

describe('market configuration defaults', () => {
  it('default depths are days, not milliseconds: two years of 1h, 30 days of 5m, all of 1d', async () => {
    const { marketConfig } = await import('../src/market/pipeline.ts');
    for (const k of ['SPW_MARKET_DEPTH_1H_DAYS', 'SPW_MARKET_DEPTH_1D_DAYS', 'SPW_MARKET_DEPTH_5M_DAYS']) delete process.env[k];
    expect(marketConfig().depthMs).toEqual({ '1h': 730 * 86_400_000, '1d': null, '5m': 30 * 86_400_000 });
  });
});

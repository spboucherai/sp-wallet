// Live READ-ONLY check of the market data sources (public endpoints, no key, no database): for every symbol and interval,
// the last closed bars of each exchange through the real adapters and the validation, then the cross-source deviation of
// the closes and the verdict the trading engine would get on those bars.
// Run: npx tsx scripts/smoke-market.mts [--bars 6] [--symbols BTC,ETH] [--intervals 1h,1d,5m]
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { defaultSources } = await import('../services/api/src/market/sources.ts');
const { evaluate } = await import('../services/api/src/market/quality.ts');
const { validateBars } = await import('../services/api/src/market/validate.ts');
const { INTERVAL_MS, SYMBOLS, expectedLastTs } = await import('../services/api/src/market/types.ts');
type Interval = keyof typeof INTERVAL_MS;
type Sym = (typeof SYMBOLS)[number];

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const N = Number(arg('bars', '6')), symbols = arg('symbols', SYMBOLS.join(',')).split(',') as Sym[], intervals = arg('intervals', '1h,1d,5m').split(',') as Interval[];
const sources = defaultSources();
// one clock reading for the whole run: every source is asked for the same bars, whatever its pacing (kraken: one call every 3 s)
const t0 = Date.now(), now = t0;
type Cell = { bars: { ts: number; close: number; volume: number }[]; rejected: number; ms: number; error?: string };
const cells = new Map<string, Cell>();

await Promise.all(sources.map(async (src) => {
  for (const interval of intervals) for (const symbol of symbols) {
    const iv = INTERVAL_MS[interval], end = expectedLastTs(interval, now), t = Date.now();
    try {
      const raw = await src.candles(symbol, interval, { start: end - (N - 1) * iv, end }, now);
      const v = validateBars(raw, interval, now);
      cells.set(`${src.id}:${symbol}:${interval}`, { bars: v.bars, rejected: v.rejected.length, ms: Date.now() - t });
    } catch (e) { cells.set(`${src.id}:${symbol}:${interval}`, { bars: [], rejected: 0, ms: Date.now() - t, error: (e as Error).message.slice(0, 60) }); }
  }
}));

console.log(`market smoke at ${new Date(now).toISOString()} - last ${N} closed bars per source (close of the latest bar / number of bars received)\n`);
console.log(['symbol', 'int', ...sources.map((s) => s.id.padEnd(22)), 'latest closed bar   ', 'max dev bps', 'verdict'].join(' | '));
const worst: Record<string, number> = {};
let failures = 0, requests = 0, rejected = 0;
for (const interval of intervals) for (const symbol of symbols) {
  const by: Record<string, any> = {};
  const cols = sources.map((s) => {
    const c = cells.get(`${s.id}:${symbol}:${interval}`)!;
    requests++; rejected += c.rejected;
    by[s.id] = c.bars;
    return (c.error ? `ERROR ${c.error}` : `${String(c.bars.at(-1)?.close ?? '-').padStart(12)} / ${c.bars.length}${c.rejected ? ` (${c.rejected} rejected)` : ''}`).padEnd(22);
  });
  const r = evaluate(by, interval, now, { lookback: N, agreeBars: N });
  if (r.status !== 'ok') failures++;
  worst[interval] = Math.max(worst[interval] ?? 0, r.maxDeviationBps ?? 0);
  console.log([symbol.padEnd(6), interval.padEnd(3), ...cols, r.lastTs === null ? '-'.padEnd(20) : new Date(r.lastTs).toISOString().slice(0, 16).padEnd(20),
    (r.maxDeviationBps === null ? '-' : r.maxDeviationBps.toFixed(1)).padStart(11), r.status === 'ok' ? 'ok' : `${r.status}: ${r.failures.map((f) => f.message).join('; ')}`].join(' | '));
}
const lat = [...cells.values()].map((c) => c.ms).sort((a, b) => a - b);
console.log(`\n${requests} requests in ${((Date.now() - t0) / 1000).toFixed(1)} s (pacing included; median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat.at(-1)} ms), ${rejected} bars rejected by validation`);
console.log(`worst deviation over the last ${N} bars: ${Object.entries(worst).map(([k, v]) => `${k} ${v.toFixed(1)} bps`).join(', ')}`);
console.log(`${failures} of ${symbols.length * intervals.length} series would be refused by assertFresh on these ${N} bars (threshold 50 bps, 2 sources, 1 bar of delay)`);

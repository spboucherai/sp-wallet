// Real backfill of the market data engine into a LOCAL database (public exchange endpoints, read-only; nothing is traded),
// then coverage, gaps and cross-source deviation statistics. Safe to run again: it resumes and every write is an upsert.
// Run: npx tsx scripts/market-backfill.mts [--symbols BTC,ETH] [--intervals 1h,1d,5m] [--days-1h 730] [--days-1d all] [--days-5m 30]
// Database: DATABASE_URL, default postgres:///spw_market_dev (created if missing).
import { execFileSync } from 'node:child_process';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://backfill.invalid', SPW_RP_ID: 'backfill.invalid', DATABASE_URL: 'postgres:///spw_market_dev', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const dbName = new URL(process.env.DATABASE_URL!.replace(/^postgres:\/\/\//, 'postgres://localhost/')).pathname.slice(1);
if (/^postgres:\/\/\//.test(process.env.DATABASE_URL!)) {
  // local socket database: create it when missing (createdb comes with PostgreSQL)
  try { execFileSync('createdb', [dbName], { stdio: 'pipe' }); console.log(`created database ${dbName}`); }
  catch (e) { if (!/already exists/.test(String((e as { stderr?: Buffer }).stderr))) throw e; }
}
const { migrate, sql } = await import('../services/api/src/db.ts');
const { backfill, marketConfig, recomputeQuality, rejectedCount, updateAll } = await import('../services/api/src/market/pipeline.ts');
const { defaultSources } = await import('../services/api/src/market/sources.ts');
const { INTERVAL_MS, SYMBOLS } = await import('../services/api/src/market/types.ts');
type Interval = keyof typeof INTERVAL_MS;

const DAY = 86_400_000, depth = (v: string) => (v === 'all' ? null : Number(v) * DAY);
const cfg = { ...marketConfig(), symbols: arg('symbols', SYMBOLS.join(',')).split(',') as (typeof SYMBOLS)[number][], intervals: arg('intervals', '1h,1d,5m').split(',') as Interval[],
  depthMs: { '1h': depth(arg('days-1h', '730')), '1d': depth(arg('days-1d', 'all')), '5m': depth(arg('days-5m', '30')) } };
const sources = defaultSources(), priority = sources.map((s) => s.id);
await migrate();
const before = (await sql`select count(*)::int as n from candles`)[0]!.n as number;
console.log(`database ${dbName}: ${before} bars before; symbols ${cfg.symbols.join(',')}; depth ${cfg.intervals.map((i) => `${i}=${cfg.depthMs[i] === null ? 'all' : cfg.depthMs[i]! / DAY + 'd'}`).join(' ')}`);

const t0 = Date.now();
let requests = 0, written = 0, rejected = 0;
const errors: string[] = [];
const u = await updateAll(sources, cfg);
requests += u.requests; written += u.written; rejected += u.rejected; errors.push(...u.errors);
console.log(`update   +${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  ${u.requests} requests, ${u.written} bars written, ${u.errors.length} errors`);
const done = new Set<string>();
for (let pass = 1; pass <= 200; pass++) {
  const b = await backfill(sources, cfg, { done, maxRequests: 150 });
  requests += b.requests; written += b.written; rejected += b.rejected; errors.push(...b.errors);
  console.log(`backfill +${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  pass ${pass}: ${b.requests} requests, ${b.written} bars written, ${b.errors.length} errors${b.errors[0] ? ` (${b.errors[0]})` : ''}`);
  if (b.complete) break;
  if (b.errors.length) await new Promise((r) => setTimeout(r, 15_000));
}
const again = await updateAll(sources, cfg); // bars that closed meanwhile
requests += again.requests; written += again.written;
const secs = (Date.now() - t0) / 1000;
const quality = await recomputeQuality(cfg, priority);
const after = (await sql`select count(*)::int as n from candles`)[0]!.n as number;
const [size] = await sql`select pg_size_pretty(pg_total_relation_size('candles')) as s`;
console.log(`\nDONE in ${secs.toFixed(0)} s: ${requests} requests, ${written} bars written (${after} stored, table ${size!.s}), ${rejected} rejected by validation ${JSON.stringify(rejectedCount)}, ${errors.length} request errors`);
for (const e of [...new Set(errors)].slice(0, 8)) console.log(`  error: ${e}`);

const d = (x: Date) => x.toISOString().slice(0, 10);
console.log('\nCOVERAGE per source (bars, first .. last bar, holes = grid slots without a bar between first and last)');
const cov = await sql`select source, symbol, interval, count(*)::int as bars, min(ts) as first, max(ts) as last,
  (extract(epoch from max(ts) - min(ts)) / (case interval when '5m' then 300 when '1h' then 3600 else 86400 end))::int + 1 - count(*)::int as holes
  from candles group by 1, 2, 3 order by interval, symbol, source`;
for (const interval of cfg.intervals) {
  console.log(`\n  ${interval}    ${priority.map((p) => p.padEnd(40)).join('')}`);
  for (const symbol of cfg.symbols) console.log(`  ${symbol.padEnd(5)} ${priority.map((p) => { const c = cov.find((x) => x.source === p && x.symbol === symbol && x.interval === interval);
    return (c ? `${String(c.bars).padStart(6)} ${d(c.first)}..${d(c.last)} holes ${c.holes}` : 'none').padEnd(40); }).join('')}`);
}

console.log('\nCONSOLIDATED series (rule: whole bar of coinbase, else bitstamp, else kraken) and close deviation between sources over the whole history');
console.log('  int symbol   bars   gaps  from        provided by (coinbase/bitstamp/kraken)   compared    p50    p99     max bps   bars > 50 bps');
const cons = await sql`with ranked as (select symbol, interval, ts, source, row_number() over (partition by symbol, interval, ts order by array_position(${priority}::text[], source)) as rk from candles)
  select symbol, interval, count(*)::int as bars, min(ts) as first,
    (extract(epoch from max(ts) - min(ts)) / (case interval when '5m' then 300 when '1h' then 3600 else 86400 end))::int + 1 - count(*)::int as gaps,
    count(*) filter (where source = 'coinbase')::int as coinbase, count(*) filter (where source = 'bitstamp')::int as bitstamp, count(*) filter (where source = 'kraken')::int as kraken
  from ranked where rk = 1 group by 1, 2`;
const dev = await sql`select symbol, interval, count(*)::int as n, percentile_cont(0.5) within group (order by bps) as p50, percentile_cont(0.99) within group (order by bps) as p99,
    max(bps) as max, count(*) filter (where bps > 50)::int as over
  from (select symbol, interval, ts, (max(close) - min(close)) / ((max(close) + min(close)) / 2) * 1e4 as bps from candles group by 1, 2, 3 having count(*) >= 2) t group by 1, 2`;
for (const interval of cfg.intervals) for (const symbol of cfg.symbols) {
  const c = cons.find((x) => x.symbol === symbol && x.interval === interval), v = dev.find((x) => x.symbol === symbol && x.interval === interval);
  if (!c) { console.log(`  ${interval.padEnd(3)} ${symbol.padEnd(5)} none`); continue; }
  console.log(`  ${interval.padEnd(3)} ${symbol.padEnd(5)} ${String(c.bars).padStart(7)} ${String(c.gaps).padStart(6)}  ${d(c.first)}  ${`${c.coinbase}/${c.bitstamp}/${c.kraken}`.padEnd(38)}` +
    (v ? `${String(v.n).padStart(9)} ${v.p50.toFixed(1).padStart(6)} ${v.p99.toFixed(1).padStart(6)} ${v.max.toFixed(1).padStart(9)}   ${v.over} (${((100 * v.over) / v.n).toFixed(2)} %)` : ''));
}

console.log('\nQUALITY now (last 720 bars; what GET /api/v1/market-data/status reports)');
const tally: Record<string, number> = {};
for (const [k, r] of Object.entries(quality)) {
  tally[r.status] = (tally[r.status] ?? 0) + 1;
  if (r.status !== 'ok') console.log(`  ${k.padEnd(9)} ${r.status}: ${r.failures.map((f) => f.message).join('; ')}`);
}
console.log(`  ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(', ')} (of ${Object.keys(quality).length} series)`);
await sql.end();

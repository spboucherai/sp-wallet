/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-markets-hub.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Live READ-ONLY smoke of the markets hub and the venue comparator: the REAL adapters of the four venues on their public
// endpoints, through the same services the API uses (DerivData with its per-venue budget, MarketsHub, CompareService).
// No key, no account, no order, no signer, no database: the spot rows are listed from the registry without prices (their
// bars live in the wallet's database). Every outgoing request is recorded by host and checked: a trading or account endpoint
// would fail the run.
// Run: npx tsx scripts/smoke-markets-hub.mts [--underlying BTC] [--notional 1000] [--leverage 3] [--hours 24] [--side long]
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
Object.assign(process.env, { SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'unused-'.repeat(8),
  SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });

const hosts = new Map<string, number>(), bad: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url), method = (init?.method ?? 'GET').toUpperCase();
  hosts.set(`${method} ${u.host}`, (hosts.get(`${method} ${u.host}`) ?? 0) + 1);
  // Hyperliquid's public data endpoint is POST /info; anything else that is not a GET, or that names an account or a trading path, fails the run
  if ((method !== 'GET' && !(method === 'POST' && (u.pathname === '/info' || u.host.includes('squid')))) || /\/exchange|\/private\/|\/orders?\b|\/addresses\//i.test(u.pathname)) bad.push(`${method} ${u.host}${u.pathname}`);
  return realFetch(input as never, init);
}) as typeof fetch;

const { createDefaultRegistry } = await import('../services/api/src/derivatives/venues.ts');
const { DerivData } = await import('../services/api/src/derivatives/data.ts');
const { MarketsHub, CompareService, HUB_BUDGET_MS } = await import('../services/api/src/markets-hub/index.ts');

const registry = createDefaultRegistry(), data = new DerivData(registry);
const d = { registry, data, paper: null as never };
const hub = new MarketsHub({ derivatives: () => d, spot: { ingested: async () => [], quality: async () => [], bars: async () => [] }, budgetMs: 8_000 });
const compare = new CompareService(hub);
const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(30)} ${String(v)}`);
const n = (x: string | null | undefined, dp = 2) => (x == null ? '—' : Number(x).toLocaleString('en-CA', { maximumFractionDigits: dp }));
const count = <T,>(xs: T[], key: (x: T) => string) => Object.entries(xs.reduce<Record<string, number>>((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(', ');
let failed = 0;
const step = async (name: string, fn: () => Promise<void>) => { console.log(`\n== ${name}`); try { await fn(); } catch (e) { failed += 1; console.log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`); } };

console.log(`markets-hub smoke (read-only)  ${new Date().toISOString()}   hub budget in the API: ${HUB_BUDGET_MS} ms (this run: 8000 ms, cold caches)`);

await step('explorer: one listing over the four venues', async () => {
  const t = performance.now(), r = await hub.list({ sort: 'volume', dir: 'desc', limit: 500, offset: 0 });
  line('built in', `${Math.round(performance.now() - t)} ms; rows ${r.total} (spot ${r.counts.spot}, perps ${r.counts.perp}); tradable from the wallet ${r.counts.tradable}; stale ${r.counts.stale}`);
  for (const v of r.venues) line(`  ${v.id}`, `${v.status}, ${v.rows} rows, tickers age ${v.ageMs ?? '—'} ms${v.error ? `, error: ${v.error}` : ''}`);
  const all = [...r.rows, ...(await hub.list({ sort: 'volume', dir: 'desc', limit: 500, offset: 500 })).rows, ...(await hub.list({ sort: 'volume', dir: 'desc', limit: 500, offset: 1000 })).rows], perps = all.filter((x) => x.kind === 'perp');
  for (const v of ['hyperliquid', 'gmx', 'dydx', 'edgex']) {
    const mine = perps.filter((x) => x.venue === v);
    line(`${v} by category`, count(mine, (x) => x.category ?? `unmapped:${x.mapping.unmapped}`));
    line(`${v} status / stale`, `${count(mine, (x) => x.status)}; stale ${mine.filter((x) => x.stale).length}; with price ${mine.filter((x) => x.price !== null).length}`);
  }
  line('perps by category', count(perps, (x) => x.category ?? '(not mapped)'));
  line('not tradable, by reason', count(perps.filter((x) => !x.tradable), (x) => x.tradableReason ?? '?'));
  line('tradable perps', perps.filter((x) => x.tradable).map((x) => x.id).join(', '));
  line('mapping rules', count(perps, (x) => x.mapping.rule ?? `unmapped:${x.mapping.unmapped}`));
  console.log('  top 8 perps by 24 h volume:');
  for (const x of perps.slice(0, 8)) console.log(`    ${x.id.padEnd(28)} ${n(x.price, 4).padStart(12)}  24h ${x.change24h === null ? '—' : `${(Number(x.change24h) * 100).toFixed(2)} %`}  vol ${n(x.volume24hUsd, 0)} USD  OI ${n(x.openInterestUsd, 0)} USD  funding ${x.funding ? `${x.funding.rate}/${x.funding.intervalSec}s = ${(Number(x.funding.annualised) * 100).toFixed(2)} %/y` : '—'}  age ${x.ageMs} ms${x.stale ? ' STALE' : ''}  ${x.tradable ? 'tradable' : x.tradableReason}`);
  const u = await hub.underlyings();
  line('underlyings', `${u.underlyings.length}; on several venues ${u.underlyings.filter((x) => x.comparable).length}; on all four ${u.underlyings.filter((x) => x.venues.length === 4).length}`);
  const pepe = await hub.underlying('PEPE');
  line('PEPE (multiplier check)', pepe.instruments.map((x) => `${x.id} ×${x.multiplier} → ${x.unitPrice}${x.priceOutlier ? ' OUTLIER' : ''}`).join(' | '));
});

for (const underlying of [arg('underlying', 'BTC'), 'ETH']) {
  await step(`compare ${underlying} ${arg('side', 'long')} ${arg('notional', '1000')} USD ×${arg('leverage', '3')} over ${arg('hours', '24')} h`, async () => {
    const t = performance.now();
    const r = await compare.compare({ underlying, side: arg('side', 'long') as 'long' | 'short', notionalUsd: arg('notional', '1000'), leverage: arg('leverage', '3'), horizonHours: arg('hours', '24'), liquidity: 'taker', minNetEdgeBps: '0' });
    line('computed in', `${Math.round(performance.now() - t)} ms`);
    for (const x of r.rows) {
      const c = x.cost, v = (f: { value: string | null; reason: string | null } | undefined, dp = 4) => (f?.value != null ? n(f.value, dp) : `null (${f?.reason ?? x.error})`);
      console.log(`  ${x.venue} — ${x.instrument}${x.tradable ? '' : `  [not tradable from the wallet: ${x.tradableReason}]`}${x.stale ? '  [STALE]' : ''}${x.priceOutlier ? '  [PRICE OUTLIER]' : ''}  age ${x.ageMs} ms`);
      console.log(`      mid ${v(c?.midPrice, 2)}  mark ${n(x.price.mark, 2)}  spread ${v(c?.spreadBps)} bps  depth ${x.depth ? x.depth.map((l) => `${l.bps}bps bid ${n(l.bidUsd, 0)}${l.bidComplete ? '' : '+'} / ask ${n(l.askUsd, 0)}${l.askComplete ? '' : '+'}`).join('; ') : `null (${x.depthReason})`}`);
      console.log(`      size ${v(c?.sizeBase, 6)}  entry slippage ${v(c?.entrySlippageUsd, 6)} USD (${v(c?.entrySlippageBps)} bps)  exit slippage ${v(c?.exitSlippageUsd, 6)} USD`);
      console.log(`      fees ${x.fees ? `taker ${x.fees.takerRate} maker ${x.fees.makerRate} (as of ${x.fees.asOf})` : 'null'}: entry ${v(c?.entryFeeUsd, 6)} + exit ${v(c?.exitFeeUsd, 6)} USD`);
      console.log(`      funding ${x.funding ? `${x.funding.rate} per ${x.funding.intervalSec} s = ${(Number(x.funding.annualised) * 100).toFixed(2)} %/y` : 'null'} → expected ${v(c?.fundingUsd, 6)} USD over the horizon (current rate held constant)`);
      console.log(`      max leverage ${v(c?.maxLeverage, 0)}×  collateral ${v(c?.collateralRequiredUsd, 2)} USD  liquidation ${v(c?.liquidationPrice, 2)} (${v(c?.liquidationDistanceBps, 0)} bps away)`);
      console.log(`      TOTAL ${v(c?.totalCostUsd, 6)} USD = ${v(c?.totalCostBps)} bps${c && c.missing.length ? `   missing: ${c.missing.join(', ')}` : ''}`);
    }
    const flagged = r.discrepancies.filter((x) => x.flagged);
    line('discrepancy estimates', `${r.discrepancies.length} ordered pairs; with an estimate ${r.discrepancies.filter((x) => x.netEdgeEstimateBps !== null).length}; flagged (net estimate > 0 bps) ${flagged.length}`);
    for (const x of r.discrepancies.slice(0, 4)) console.log(`    long ${x.longVenue} / short ${x.shortVenue}: gross gap ${x.grossGapBps ?? '—'} bps, netEdgeEstimateBps ${x.netEdgeEstimateBps ?? `null (${x.reason})`}${x.flagged ? '  FLAGGED' : ''}${x.actionableFromWallet ? '' : '  [a leg is not tradable from the wallet]'}`);
    if (r.discrepancies[0]) console.log(`    each with ${r.discrepancies[0].assumptions.length} assumptions and ${r.discrepancies[0].risks.length} risks, e.g. « ${r.discrepancies[0].assumptions[1]!.text} » / « ${r.discrepancies[0].risks[0]!.text} »`);
    for (const wn of r.warnings) console.log(`    warning: ${wn}`);
  });
}

await step('request de-duplication and cache', async () => {
  const before = { builds: hub.stats.builds, computed: compare.stats.computed };
  await new Promise((r) => setTimeout(r, 2_100));   // past the hub TTL
  const q = { underlying: 'BTC', side: 'long' as const, notionalUsd: '1000', leverage: '3', horizonHours: '24', liquidity: 'taker' as const, minNetEdgeBps: '0' };
  await Promise.all([hub.list({ sort: 'volume', dir: 'desc', limit: 10, offset: 0 }), hub.list({ sort: 'funding', dir: 'asc', limit: 10, offset: 0, kind: 'perp' }), hub.underlying('ETH'), compare.compare(q), compare.compare(q), compare.compare(q)]);
  line('6 concurrent reads', `${hub.stats.builds - before.builds} listing build, ${compare.stats.computed - before.computed} comparison computed`);
});

console.log('\n== outgoing requests (host, count)');
for (const [h, c] of [...hosts.entries()].sort()) line(h, c);
if (bad.length) { failed += 1; console.log(`  FORBIDDEN REQUESTS: ${bad.join(', ')}`); } else line('trading / account endpoints', 'none');
data.close();
console.log(failed ? `\nFAILED: ${failed} step(s)` : '\nOK');
process.exit(failed ? 1 : 0);

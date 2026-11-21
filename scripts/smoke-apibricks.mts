/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-apibricks.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// Live READ-ONLY check of API Bricks (CoinAPI), the wallet's optional second market-data source — through the REAL modules
// (client, budget, second price list, cross-check rule, market source and validation). No database, no order, no account.
// Needs APIBRICKS_API_KEY in the environment; the key is never printed and is sent only to the provider's official hosts.
// Cost: 3 credits (one batched rate list, one OHLCV page, one metadata row); `--all-products` adds one cheap call on each
// of the provider's other products to see what the key unlocks (7 more calls).
// Run: set -a; . <secrets file>; set +a; npx tsx scripts/smoke-apibricks.mts [--all-products]
for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://smoke.invalid', SPW_RP_ID: 'smoke.invalid', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { createBudget } = await import('../services/api/src/apibricks/budget.ts');
const { APIBRICKS_HOST, APIBRICKS_KEY_HEADER, createApiBricksClient } = await import('../services/api/src/apibricks/client.ts');
const { createApiBricksPrices } = await import('../services/api/src/apibricks/prices.ts');
const { apiBricksMarketSource } = await import('../services/api/src/apibricks/market-source.ts');
const { ASSET_MAP, MARKET_PAIRS } = await import('../services/api/src/apibricks/asset-map.ts');
const { redact } = await import('../services/api/src/apibricks/redact.ts');
const { crossCheck } = await import('../services/api/src/prices/cross.ts');
const { COINGECKO } = await import('../services/api/src/prices/coingecko-ids.ts');
const { validateBars } = await import('../services/api/src/market/validate.ts');
const { INTERVAL_MS, expectedLastTs } = await import('../services/api/src/market/types.ts');

const key = (process.env.APIBRICKS_API_KEY ?? '').trim();
if (!key) { console.log('APIBRICKS_API_KEY is not set: the provider is absent (needsKey). Nothing was called.'); process.exit(2); }
const say = (s: string) => console.log(redact(s, key));
const budget = createBudget({ dailyCredits: 6 }), client = createApiBricksClient({ key, budget });
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'USDC'];
let failed = false;

say(`API Bricks smoke — ${new Date().toISOString()} — host ${APIBRICKS_HOST}, key in header ${APIBRICKS_KEY_HEADER} (not shown)`);

// 1. what the key unlocks
say('\n1. Products');
const products: [string, string][] = [['Market Data REST (CoinAPI)', `https://${APIBRICKS_HOST}/v1/exchanges/GEMINI`]];
if (process.argv.includes('--all-products')) products.push(
  ['Exchange Rates, realtime (CoinAPI)', 'https://api-realtime.exrates.coinapi.io/v1/exchangerate/BTC/USD'],
  ['Exchange Rates, historical (CoinAPI)', 'https://api-historical.exrates.coinapi.io/v1/exchangerate/BTC/USD/history?period_id=1DAY&limit=1'],
  ['Indexes (CoinAPI)', 'https://rest-api.indexes.coinapi.io/v1/indexes/IDX_REFRATE_VWAP_BTC/current'],
  ['Currencies / FX (FinFeedAPI)', 'https://api-realtime.fx.finfeedapi.com/v1/exchangerate/EUR/USD'],
  ['Stocks, historical (FinFeedAPI)', 'https://api-historical.stock.finfeedapi.com/v1/ohlcv/exchange-symbol/IEXG/AAPL/history?period_id=1DAY&limit=1'],
  ['SEC filings (FinFeedAPI)', 'https://api.sec.finfeedapi.com/v1/filings?limit=1'],
  ['Prediction markets (FinFeedAPI)', 'https://api.prediction-markets.finfeedapi.com/v1/exchanges']);
let extraCalls = 0, tier = '';
for (const [name, url] of products) {
  try {
    extraCalls += 1;
    const r = await fetch(url, { headers: { accept: 'application/json', [APIBRICKS_KEY_HEADER]: key }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    tier ||= `per-minute limit ${r.headers.get('x-tierlimit-rpm-limit') ?? '?'}, concurrency ${r.headers.get('x-tierlimit-concurrency-limit') ?? '?'}`;
    const quota = ['x-ratelimit-remaining', 'x-ratelimit-quota-remaining', 'x-credits-remaining'].map((h) => r.headers.get(h)).find((x) => x !== null);
    say(`   ${r.status === 200 ? 'available  ' : `HTTP ${r.status}   `} ${name}${r.headers.get('x-ratelimit-request-cost') ? ` (cost ${r.headers.get('x-ratelimit-request-cost')})` : ''}${quota ? ` — provider says remaining: ${quota}` : ''}`);
    if (r.status !== 200) say(`               ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (e) { say(`   failed      ${name}: ${(e as Error).message}`); failed = true; }
}

// 2. prices from both sources
say('\n2. Prices (primary CoinGecko, second API Bricks) — nothing is averaged');
const second = await createApiBricksPrices({ client, consumer: 'smoke' }).read();
const ids = SYMBOLS.map((s) => COINGECKO[s]!);
const g = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd,cad&include_last_updated_at=true`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  .then(async (r) => (r.ok ? (await r.json()) as Record<string, { usd: number; cad: number; last_updated_at: number }> : null), () => null);
const primary = g ? Object.fromEntries(SYMBOLS.flatMap((s) => { const m = g[COINGECKO[s]!]; return m ? [[s, { usd: m.usd, cad: m.cad, priceAt: new Date(m.last_updated_at * 1000).toISOString(), stale: Date.now() - m.last_updated_at * 1000 > 15 * 60_000 }]] : []; })) : null;
if (!primary) say('   CoinGecko refused or did not answer: the second source alone is shown (this is the failover case)');
if (!second) { say(`   API Bricks gave no price: ${client.stats().lastError ?? 'unknown'}`); failed = true; }
const px = crossCheck(primary, second ? Object.fromEntries(SYMBOLS.flatMap((s) => (second.prices[s] ? [[s, second.prices[s]!]] : []))) : null, { thresholdBps: 100 }, (_s, x) => (x.cad === null ? null : { usd: x.usd, cad: x.cad, priceAt: x.priceAt, stale: false }));
for (const s of SYMBOLS) {
  const m = px?.[s];
  if (!m) { say(`   ${s.padEnd(5)} no price`); failed = true; continue; }
  const of = (id: string) => { const x = m.sources.find((y) => y.source === id); return x ? `${String(x.usd).padEnd(18)} at ${x.priceAt}${x.stale ? ' STALE' : ''}` : 'none'.padEnd(18); };
  say(`   ${s.padEnd(5)} coingecko ${of('coingecko')} | apibricks ${of('apibricks')} | divergence ${m.divergenceBps === null ? 'not compared' : `${m.divergenceBps} bps`}${m.divergent ? ' DIVERGENT' : ''} | displayed: ${m.source}${m.fallback ? ' (fallback)' : ''} — mapping ${ASSET_MAP[s]?.evidence ?? 'none'}`);
}

// 3. one OHLCV sample through the market source and the validation
say('\n3. Market source (an exchange the wallet does not read itself)');
try {
  const src = apiBricksMarketSource({ client, symbols: ['BTC'], intervals: ['1d'], spacingMs: 0 }), now = Date.now(), end = expectedLastTs('1d', now);
  const v = validateBars(await src.candles('BTC', '1d', { start: end - 2 * INTERVAL_MS['1d'], end }, now), '1d', now);
  say(`   ${MARKET_PAIRS.BTC} 1d: ${v.bars.length} closed bars, ${v.rejected.length} rejected by validation`);
  for (const b of v.bars) say(`   ${new Date(b.ts).toISOString().slice(0, 10)}  open ${b.open}  high ${b.high}  low ${b.low}  close ${b.close}  volume ${b.volume.toFixed(4)}`);
  if (v.bars.length === 0) failed = true;
} catch (e) { say(`   failed: ${(e as Error).message}`); failed = true; }

// 4. quota
const b = budget.snapshot(), st = client.stats();
say('\n4. Quota');
say(`   this run: ${st.calls + extraCalls} calls, ${st.credits + extraCalls} credits (${st.credits} through the metered client, as the provider's x-ratelimit-request-cost says; ${extraCalls} product probes counted 1 each)`);
say(`   local budget of this run: ${b.used} / ${b.ceiling} used, ${b.remaining} remaining`);
say(`   provider: ${tier || 'no tier header'}; remaining credits are NOT reported in any response header on this plan — only the provider's console shows the balance`);
say(`\n${failed ? 'FAILED' : 'OK'}`);
process.exit(failed ? 1 : 0);

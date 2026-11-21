/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/gen-apibricks-assets.mts
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

// Build-time mapping of the wallet's symbols onto API Bricks (CoinAPI) assets, and of the market symbols onto exchange-specific
// series of exchanges the wallet does not read. Writes services/api/src/apibricks/asset-map.ts (static, reviewed in the diff;
// nothing is discovered at run time) and the trimmed metadata fixtures the mapping tests replay.
//
// READ-ONLY. Needs APIBRICKS_API_KEY in the environment (never printed, never written). Four provider calls (four credits):
//   /v1/assets?filter_asset_id=…   /v1/exchangerate/USD?invert=true&filter_asset_id=…   /v1/symbols?filter_exchange_id=GEMINI|BITFINEX&filter_asset_id=USD
// and one keyless CoinGecko call for the reference prices, all read within the same seconds (rule 3 of mapping.ts).
// Run: npx tsx scripts/gen-apibricks-assets.mts [--cache /tmp/dir]     (with --cache, answers already in the directory are reused)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const [k, v] of Object.entries({ SPW_ORIGIN: 'https://gen.invalid', SPW_RP_ID: 'gen.invalid', DATABASE_URL: 'postgres://unused', SPW_SIGNER_SECRET: 'unused' })) process.env[k] ??= v;
const { TOKENS, MARKET_LISTINGS } = await import('@spw/core');
const { COINGECKO } = await import('../services/api/src/prices/coingecko-ids.ts');
const { createBudget } = await import('../services/api/src/apibricks/budget.ts');
const { createApiBricksClient } = await import('../services/api/src/apibricks/client.ts');
const { buildAssetMap, PRICE_CHECK_BPS } = await import('../services/api/src/apibricks/mapping.ts');
const { INDEPENDENT_EXCHANGES, pickMarketPairs } = await import('../services/api/src/apibricks/venues.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ci = process.argv.indexOf('--cache'), cacheDir = ci > 0 ? process.argv[ci + 1]! : null;
if (cacheDir) mkdirSync(cacheDir, { recursive: true });
const key = process.env.APIBRICKS_API_KEY ?? '';
const client = key ? createApiBricksClient({ key, budget: createBudget({ dailyCredits: 8 }) }) : null;
async function cached<T>(name: string, read: () => Promise<T>): Promise<T> {
  const f = cacheDir ? join(cacheDir, `gen-${name}.json`) : null;
  if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as T;
  const v = await read();
  if (f) writeFileSync(f, JSON.stringify(v));
  return v;
}
const provider = <T,>(name: string, path: string): Promise<T> => cached(name, async () => { if (!client) throw new Error('APIBRICKS_API_KEY is not set'); return client.get<T>(path, { consumer: 'smoke' }); });

const symbols = Object.keys(COINGECKO), exact = symbols.filter((s) => /^[A-Za-z0-9]+$/.test(s));
const ids = [...new Set([...exact, 'USD', 'CAD'])].join(';');
const now = Date.now();
type Asset = { asset_id: string; name?: string | null; type_is_crypto?: number; chain_addresses?: { chain_id: string; network_id: string; address: string }[] | null };
type Rates = { asset_id_base: string; rates: { time: string; asset_id_quote: string; rate: number }[] };
type Sym = { symbol_id: string; exchange_id: string; symbol_type: string; asset_id_base: string; asset_id_quote: string; data_trade_end?: string; volume_1day_usd?: number; price?: number };
const [assetsRaw, rates, gecko, ...symLists] = await Promise.all([
  provider<Asset[]>('assets', `/v1/assets?filter_asset_id=${ids}`),
  provider<Rates>('rates', `/v1/exchangerate/USD?invert=true&filter_asset_id=${ids}`),
  cached('coingecko', async () => { const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(Object.values(COINGECKO))].join(',')}&vs_currencies=usd`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`coingecko: HTTP ${r.status}`); return (await r.json()) as Record<string, { usd?: number }>; }),
  ...INDEPENDENT_EXCHANGES.map((ex) => provider<Sym[]>(`symbols-${ex}`, `/v1/symbols?filter_exchange_id=${ex}&filter_asset_id=USD`)),
]);
const capturedAt = cacheDir && existsSync(join(cacheDir, 'gen-at.txt')) ? Number(readFileSync(join(cacheDir, 'gen-at.txt'), 'utf8')) : now;
if (cacheDir && !existsSync(join(cacheDir, 'gen-at.txt'))) writeFileSync(join(cacheDir, 'gen-at.txt'), String(now));

// trimmed to what the mapping reads: market metadata only (no icon ids, no raw exchange payloads)
const assets = assetsRaw.map((a) => ({ asset_id: a.asset_id, name: a.name ?? null, type_is_crypto: a.type_is_crypto, chain_addresses: a.chain_addresses ?? null }));
const syms = symLists.flat().filter((s) => s.symbol_type === 'SPOT' && s.asset_id_quote === 'USD')
  .map((s) => ({ symbol_id: s.symbol_id, exchange_id: s.exchange_id, symbol_type: s.symbol_type, asset_id_base: s.asset_id_base, asset_id_quote: s.asset_id_quote, data_trade_end: s.data_trade_end ?? null, volume_1day_usd: s.volume_1day_usd ?? null, price: s.price ?? null }));
const providerUsd = Object.fromEntries(rates.rates.map((r) => [r.asset_id_quote, r.rate]));
const referenceUsd = Object.fromEntries(Object.entries(COINGECKO).flatMap(([s, id]) => (typeof gecko[id]?.usd === 'number' ? [[s, gecko[id]!.usd!]] : [])));

const map = buildAssetMap({ identities: COINGECKO, assets, tokens: TOKENS, providerUsd, referenceUsd });
const certain = Object.fromEntries(map.mapped.filter((m) => m.evidence !== 'alias' && Object.hasOwn(MARKET_LISTINGS, m.symbol)).map((m) => [m.symbol, m.assetId]));
const market = pickMarketPairs({ assets: certain, symbols: syms, referenceUsd, now: capturedAt, priceCheckBps: PRICE_CHECK_BPS });

const day = new Date(capturedAt).toISOString().slice(0, 10), q = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : `'${s}'`);
const out = `// GENERATED by scripts/gen-apibricks-assets.mts on ${day} from the provider's own metadata (/v1/assets, /v1/symbols), its rates and
// the wallet's existing prices read together — do not edit by hand; rules in mapping.ts and venues.ts, reviewed in the diff.
// ${map.mapped.length} of ${symbols.length} wallet symbols map with certainty; the other ${map.unmapped.length} keep ONE price source (listed at the end, with the reason).
import type { Evidence } from './mapping.ts';

/** wallet symbol → provider asset. \`checkBps\`: distance to the wallet's existing price when the table was generated. */
export const ASSET_MAP: Record<string, { assetId: string; evidence: Evidence; proof: string; checkBps: number }> = {
${map.mapped.map((m) => `  ${q(m.symbol)}: { assetId: '${m.assetId}', evidence: '${m.evidence}', proof: '${m.proof}', checkBps: ${m.checkBps} },`).join('\n')}
};

/** market symbol → the provider's symbol of ONE exchange the wallet does not read itself (venues.ts: the independence rule) */
export const MARKET_PAIRS: Record<string, string> = {
${Object.entries(market.pairs).map(([s, id]) => `  ${q(s)}: '${id}',`).join('\n')}
};

/** not mapped, and why (kept for the reader; nothing reads it at run time) */
export const UNMAPPED: Record<string, string> = {
${map.unmapped.map((u) => `  ${q(u.symbol)}: '${u.reason}: ${u.detail.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n')}
};
`;
writeFileSync(join(root, 'services/api/src/apibricks/asset-map.ts'), out);

const fx = join(root, 'services/api/test/fixtures/apibricks');
mkdirSync(fx, { recursive: true });
const write = (name: string, v: unknown) => writeFileSync(join(fx, name), `${JSON.stringify(v, null, 1)}\n`);
write('meta-assets.json', { capturedAt, endpoint: 'GET /v1/assets?filter_asset_id=<wallet symbols>', note: 'trimmed to asset_id, name, type_is_crypto, chain_addresses', body: assets });
write('meta-symbols.json', { capturedAt, endpoint: 'GET /v1/symbols?filter_exchange_id=<GEMINI|BITFINEX>&filter_asset_id=USD', note: 'spot USD pairs only, trimmed to the fields the selection reads', body: syms });
write('rates-usd.json', { capturedAt, endpoint: 'GET /v1/exchangerate/USD?invert=true&filter_asset_id=<wallet symbols>', body: rates });
write('reference-usd.json', { capturedAt, endpoint: 'GET api.coingecko.com/api/v3/simple/price?ids=<wallet ids>&vs_currencies=usd', body: referenceUsd });

console.log(`mapped ${map.mapped.length} / ${symbols.length} (address ${map.mapped.filter((m) => m.evidence === 'address').length}, reviewed ${map.mapped.filter((m) => m.evidence === 'reviewed').length}, alias ${map.mapped.filter((m) => m.evidence === 'alias').length})`);
for (const u of map.unmapped) console.log(`  - ${u.symbol}: ${u.reason} (${u.detail})`);
console.log(`market pairs ${Object.keys(market.pairs).length} / ${Object.keys(certain).length}`);
for (const s of market.skipped) console.log(`  - ${s.symbol}: ${s.reason}`);
if (client) console.log(`provider calls ${client.stats().calls}, credits ${client.stats().credits}`);

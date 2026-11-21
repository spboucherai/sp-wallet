/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/scripts/fetch-cg.mts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Second source of the token rule: refreshes research/cg.json from the public CoinGecko API (no key).
//   node packages/core/scripts/fetch-cg.mts [--all]        (run from the repository root)
//   node packages/core/scripts/fetch-cg.mts --list         one request instead: GET /coins/list?include_platform=true gives the
//                                                          platform addresses of every coin (no decimals); ids filled this way are
//                                                          marked `from: 'coins/list'` and replaced by the detailed record on a later run
// For every coin id named in research/candidates.json (`cg` of a token or of one deployment) it stores
// { symbol, name, platforms: detail_platforms } of GET /api/v3/coins/<id>. Ids already present are kept unless --all is given.
// The public API allows only a few requests per minute: one request every 7 s, longer waits after a 429.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'research/cg.json';
const cand = JSON.parse(readFileSync('research/candidates.json', 'utf8'));
const cg: Record<string, any> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const ids = new Set<string>();
for (const t of cand.tokens) { if (t.cg) ids.add(t.cg); for (const d of Object.values(t.d as Record<string, any>)) if (typeof d === 'object' && d.cg) ids.add(d.cg); }
const todo = [...ids].filter((id) => process.argv.includes('--all') || !cg[id]?.platforms || cg[id].from).sort();
console.log(`${ids.size} coin ids, ${todo.length} to fetch`);
if (process.argv.includes('--list')) {
  // an already downloaded response can be given as a file (the endpoint is the first one to be rate-limited): --list <file>
  const saved = process.argv[process.argv.indexOf('--list') + 1];
  const all = (saved ? JSON.parse(readFileSync(saved, 'utf8')) : await (await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(120000) })).json()) as { id: string; symbol: string; name: string; platforms: Record<string, string> }[];
  if (!Array.isArray(all)) throw new Error('coins/list did not return a list (rate limit?)');
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const id of todo) {
    const c = byId.get(id); if (!c) { console.log('MISSING', id); continue; }
    cg[id] = { symbol: c.symbol, name: c.name, from: 'coins/list', platforms: Object.fromEntries(Object.entries(c.platforms).filter(([, a]) => a).map(([p, a]) => [p, { contract_address: a }])) };
  }
  writeFileSync(OUT, JSON.stringify(cg, null, 1) + '\n');
  process.exit(0);
}
for (const id of todo) {
  for (let k = 0; ; k++) {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (r?.ok) { const j = await r.json() as any; cg[id] = { symbol: j.symbol, name: j.name, platforms: j.detail_platforms }; console.log('ok ', id, j.symbol, Object.keys(j.detail_platforms ?? {}).length); break; }
    if (r?.status === 404) { console.log('MISSING', id); break; }
    if (k === 6) { console.log('FAILED', id, r?.status); break; }
    await new Promise((res) => setTimeout(res, 20000 * (k + 1)));
  }
  writeFileSync(OUT, JSON.stringify(cg, null, 1) + '\n');
  await new Promise((res) => setTimeout(res, 7000));
}

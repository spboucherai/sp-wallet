/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-swap-odos.mts
 * Module           : scripts
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

// Odos has no adapter: the company permanently shut down its quoting/routing API on 2026-07-30 (docs/swap/providers/odos.md).
// This READ-ONLY probe re-checks that state, so the decision can be revisited the day it changes. It asks only for public
// metadata (GET), never for a quote with a wallet address, and builds nothing.
// Exit 0 = still offline (expected). Exit 1 = something answers again: re-read the official site before doing anything.
// Run: npx tsx scripts/smoke-swap-odos.mts
const probes: [label: string, url: string][] = [
  ['API: supported chains', 'https://api.odos.xyz/info/chains'],
  ['API: v2 router info (Ethereum)', 'https://api.odos.xyz/info/router/v2/1'],
  ['API: v3 quote endpoint', 'https://api.odos.xyz/sor/quote/v3'],
  ['Enterprise API: supported chains', 'https://enterprise-api.odos.xyz/info/chains'],
  ['Documentation', 'https://docs.odos.xyz/'],
];
let alive = 0;
console.log(`Odos liveness probe  ${new Date().toISOString()}`);
for (const [label, url] of probes) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const text = (await r.text()).replace(/\s+/g, ' ').slice(0, 80);
    if (r.ok) alive++;
    console.log(`${r.ok ? 'ALIVE  ' : 'offline'} ${label.padEnd(34)} HTTP ${r.status}  ${Date.now() - t0} ms  ${JSON.stringify(text)}`);
  } catch (e) { console.log(`offline ${label.padEnd(34)} ${(e as Error).name}: ${(e as Error).message}  ${Date.now() - t0} ms`); }
}
try {
  const html = await (await fetch('https://odos.xyz/', { signal: AbortSignal.timeout(10_000) })).text();
  console.log(`official site title: ${JSON.stringify(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null)}`);
} catch (e) { console.log(`official site unreachable: ${(e as Error).message}`); }
console.log(alive ? `${alive} endpoint(s) answer again — Odos must be re-evaluated from its official documentation` : 'Odos API is offline, as announced: no adapter, no quotes');
process.exit(alive ? 1 : 0);

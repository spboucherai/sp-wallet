/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/scripts/chunk-report.mts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
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

// What is in each JS chunk of the web build, module by module (rendered bytes before minification of the chunk as a whole,
// so the figures are relative weights, not the gzip of the file). Nothing is written: the build runs in memory.
//   cd apps/web && node --experimental-strip-types scripts/chunk-report.mts [chunk-name-prefix=index] [top=25]
import { build } from 'vite';

const [prefix = 'index', top = '25'] = process.argv.slice(2);
const out = await build({ logLevel: 'silent', build: { write: false } });
const bundles = Array.isArray(out) ? out : [out as { output: unknown[] }];
for (const b of bundles) for (const c of (b as { output: { type: string; name?: string; fileName: string; code?: string; modules?: Record<string, { renderedLength: number }> }[] }).output) {
  if (c.type !== 'chunk' || !c.fileName.includes(`/${prefix}`)) continue;
  const mods = Object.entries(c.modules ?? {}).map(([id, m]) => [id.replace(/^.*\/sp-wallet\/[^]*?\/(apps|packages|node_modules)\//, '$1/').replace(/^.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'npm:'), m.renderedLength] as const).sort((x, y) => y[1] - x[1]);
  console.log(`${c.fileName}  ${(c.code!.length / 1000).toFixed(2)} kB  (${mods.length} modules)`);
  for (const [id, n] of mods.slice(0, Number(top))) console.log(`  ${String(n).padStart(8)}  ${id}`);
}

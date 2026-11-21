/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/scripts/i18n-split.mts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// v10 performance pass: `src/i18n.ts` keeps both languages side by side in `D` (370 kB). The web build and the dev server
// take the literal out of the app's chunk and write it as two tables, one per language (vite.config.ts `spw-i18n-split`,
// src/i18n-load.ts). This is the pure part: source text in, two tables and the source without the literal out.
// The literal must be plain data — `key: ['français', 'English'],` — a key without its two non-empty strings is an error.
const OPEN = 'const D = {', CLOSE = '\n} as const;';
export function i18nTables(source: string): { fr: Record<string, string>; en: Record<string, string>; stripped: string } {
  const a = source.indexOf(OPEN), b = source.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error('i18n: the `const D = { … } as const;` literal was not found in src/i18n.ts');
  const rows = new Function(`return ({${source.slice(a + OPEN.length, b)}\n})`)() as Record<string, unknown>;
  const fr: Record<string, string> = {}, en: Record<string, string> = {};
  for (const [k, v] of Object.entries(rows)) {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string' || !v[0] || !v[1]) throw new Error(`i18n: ${k} must be ['français', 'English']`);
    fr[k] = v[0]; en[k] = v[1];
  }
  return { fr, en, stripped: `${source.slice(0, a)}const D = {${source.slice(b)}` };
}

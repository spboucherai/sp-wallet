/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/scripts/first-paint.mjs
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// What blocks the first paint of a production build: `node apps/web/scripts/first-paint.mjs [dist/web]`.
// The entry script and every `modulepreload` of index.html (gzip), the stylesheet, and the language file the entry awaits
// before drawing (one of the two `spw-i18n-*` chunks). Nothing is written.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/web'));
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const gz = (f) => gzipSync(readFileSync(resolve(dist, f.replace(/^\//, '')))).length;
const js = [...html.matchAll(/<(?:script|link rel="modulepreload")[^>]*(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/g)].map((m) => m[1]);
const lang = readdirSync(resolve(dist, 'assets')).filter((f) => /spw-i18n-(fr|en)/.test(f));
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const code = js.reduce((s, f) => s + gz(f), 0), style = css.reduce((s, f) => s + gz(f), 0);
console.log(`code (entry + ${js.length - 1} preloads)  ${kb(code)} gzip`);
for (const f of js) console.log(`   ${kb(gz(f)).padStart(9)}  ${f}`);
console.log(`css                         ${kb(style)} gzip`);
for (const f of lang) console.log(`language ${/-fr-/.test(f) ? 'fr' : 'en'}                 ${kb(gz(`assets/${f}`))} gzip`);

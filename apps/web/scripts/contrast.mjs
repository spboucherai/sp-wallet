/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/scripts/contrast.mjs
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

import { readFileSync } from 'node:fs';
// WCAG contrast ratios of the design tokens (text and essential icons on the surfaces they sit on)
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const mix = (fg, bg, a) => fg.map((c, k) => Math.round(c * a + bg[k] * (1 - a)));
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// NEXT: the palette is READ from design/tokens.json (the single source of the design system) — the v9 names used below are
// its aliases (emerald = positive, blue = accent, warn = caution, danger = negative). The token generator already refuses a
// text pair under 4.5 : 1 (`node scripts/gen-design-tokens.mjs --check`); this script adds the pairs the WEB component layer
// composes itself: tone text on its own wash (status pill 11 %, notice 7 %), and the fixed colours of the mode bands.
const tokens = JSON.parse(readFileSync(new URL('../../../design/tokens.json', import.meta.url), 'utf8')).color;
const pick = (k) => ({ bg: tokens.bg[k], surface: tokens.surface[k], elev: tokens.elev[k], ink: tokens.ink[k], mute: tokens.mute[k], emerald: tokens.positive[k], blue: tokens.accent[k], warn: tokens.caution[k], danger: tokens.negative[k],
  primary: tokens.primary[k], onprimary: tokens.onPrimary[k], ondanger: tokens.onNegative[k], heroBase: tokens.heroBase[k], heroInk: tokens.heroInk[k], heroMute: tokens.heroMute[k] });
const T = { light: pick('light'), dark: pick('dark') };
for (const [name, t] of Object.entries(T)) {
  const rows = [];
  for (const fg of ['ink', 'mute', 'emerald', 'blue', 'warn', 'danger']) for (const bg of ['surface', 'bg', 'elev']) rows.push([`${fg} on ${bg}`, ratio(hex(t[fg]), hex(t[bg]))]);
  rows.push(['onprimary on primary', ratio(hex(t.onprimary), hex(t.primary))], ['ondanger on danger', ratio(hex(t.ondanger), hex(t.danger))]);
  // tinted notices / pills: the tone's text on a 9-12 % wash of itself over the surface
  for (const fg of ['emerald', 'blue', 'warn', 'danger']) rows.push([`${fg} on its 10 % wash`, ratio(hex(t[fg]), mix(hex(t[fg]), hex(t.surface), 0.1))]);
  for (const fg of ['emerald', 'blue', 'warn', 'danger', 'mute']) rows.push([`${fg} on its 11 % wash (status pill)`, ratio(hex(t[fg]), mix(hex(t[fg]), hex(t.surface), 0.11))], [`ink on the 7 % wash of ${fg} (notice)`, ratio(hex(t.ink), mix(hex(t[fg]), hex(t.surface), 0.07))]);
  rows.push(['balance card: hero ink on hero base', ratio(hex(t.heroInk), hex(t.heroBase))], ['balance card: hero mute on hero base', ratio(hex(t.heroMute), hex(t.heroBase))], ['balance card: hero ink on its chip (13 % ink over the base)', ratio(hex(t.heroInk), mix(hex(t.heroInk), hex(t.heroBase), 0.13))]);
  if (rows.some(([k, v]) => v < 4.5 && !/ on elev$| on bg$/.test(k))) { console.error(`${name}: a text pair of the component layer is below 4.5 : 1`); process.exitCode = 1; }
  console.log(name); for (const [k, v] of rows) console.log(`  ${v < 4.5 ? (v < 3 ? 'FAIL' : 'AA-large only') : 'AA'}  ${v.toFixed(2)}  ${k}`);
}
// v10 futures-live — the mode bands (styles.css `.mode-band`, `.mode-tag`). TESTNET and RÉEL use FIXED colours, the same in
// both themes: white text on each stripe of the testnet pattern and on the real-money red. SIMULATION is the theme's blue on
// its own 8 % wash (dotted ground: the dots are 11 % blue over that wash — the worst case under a letter).
{
  const white = [255, 255, 255], rows = [
    ['band TESTNET: white on stripe #5b34c9', ratio(white, hex('#5b34c9'))], ['band TESTNET: white on stripe #6f49dc', ratio(white, hex('#6f49dc'))],
    ['band RÉEL: white on #b3122b', ratio(white, hex('#b3122b'))],
  ];
  for (const [name, t] of Object.entries(T)) { const wash = mix(hex(t.blue), hex(t.surface), 0.08);
    rows.push([`band SIMULATION (${name}): blue on its 8 % wash`, ratio(hex(t.blue), wash)], [`band SIMULATION (${name}): blue on a dot of the ground`, ratio(hex(t.blue), mix(hex(t.blue), wash, 0.11))]); }
  console.log('mode bands (fixed colours)'); for (const [k, v] of rows) console.log(`  ${v < 4.5 ? (v < 3 ? 'FAIL' : 'AA-large only') : 'AA'}  ${v.toFixed(2)}  ${k}`);
  if (rows.some(([k, v]) => v < 4.5)) { console.error('a mode band is below 4.5 : 1'); process.exitCode = 1; }
}

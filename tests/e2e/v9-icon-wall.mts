/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v9-icon-wall.mts
 * Module           : tests
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

// v9: the visual sheet of the logo set. Starts the Vite dev server of the web app (the wall exists only in development),
// opens /__icons at phone and desktop sizes, light and dark, checks that every logo actually loaded from this origin, and
// writes the four sheets to docs/v9/logo-wall/. LOOK at them after any change to the set.
//
//   npx tsx tests/e2e/v9-icon-wall.mts [port]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const PORT = Number(process.argv[2] ?? 5239), OUT = resolve('docs/v9/logo-wall'); mkdirSync(OUT, { recursive: true });
const vite = spawn(resolve('apps/web/node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: resolve('apps/web'), stdio: 'ignore' });
let failed = false;
try {
  for (let k = 0; k < 80; k++) { try { if ((await fetch(`http://localhost:${PORT}/__icons`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  const browser = await chromium.launch();
  for (const [id, viewport, dsf] of [['phone', { width: 390, height: 844 }, 3], ['desktop', { width: 1440, height: 900 }, 2]] as const) for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf }); await ctx.addInitScript((t) => localStorage.setItem('spw-theme', t), theme);
    const page = await ctx.newPage(); const remote: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).origin !== `http://localhost:${PORT}`) remote.push(r.url()); });
    await page.goto(`http://localhost:${PORT}/__icons`); await page.getByTestId('icon-wall').waitFor();
    await page.evaluate(async () => { for (const i of Array.from(document.images)) { i.loading = 'eager'; if (!i.complete) await new Promise((r) => { i.onload = i.onerror = r; }); } }); await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({ imgs: document.images.length, broken: Array.from(document.images).filter((i) => i.naturalWidth === 0).map((i) => i.src), fallbacks: Array.from(document.querySelectorAll('[data-fallback]')).map((e) => e.textContent) }));
    console.log(`${id}-${theme}: ${r.imgs} images, broken ${r.broken.length}, generic fallbacks shown: ${r.fallbacks.join(', ')}, requests to another origin: ${remote.length}`);
    if (r.broken.length || remote.length || r.fallbacks.some((f) => !['KPEPE', 'FARTC'].includes(f ?? ''))) { failed = true; console.log(r.broken, remote); }
    const png = join(tmpdir(), `wall-${process.pid}.png`); await page.screenshot({ path: png, fullPage: true });
    try { execFileSync('cwebp', ['-quiet', '-q', '82', ...(id === 'phone' ? ['-resize', '780', '0'] : ['-resize', '1440', '0']), png, '-o', join(OUT, `wall-${id}-${theme}.webp`)]); } catch { await page.screenshot({ path: join(OUT, `wall-${id}-${theme}.png`), fullPage: true }); }
    rmSync(png, { force: true }); await ctx.close();
  }
  await browser.close();
} finally { vite.kill(); }
process.exit(failed ? 1 : 0);

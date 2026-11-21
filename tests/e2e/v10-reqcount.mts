/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v10-reqcount.mts
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

// v10 diagnostic: how many requests does one browser session send to the API's rate limiter (240 a minute per client, static
// files included)? Counts by path for a fresh load of Home, then 30 idle seconds, then the agent list and one agent page.
//   npx tsx tests/e2e/qa-real-server.mts --port 8790 --db spw_v10_qa --fork base,arbitrum     (another terminal)
//   QA_BASE=http://localhost:8790 npx tsx tests/e2e/v10-reqcount.mts
import { chromium } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

const BASE = process.env.QA_BASE ?? 'http://localhost:8790', PORT = Number(new URL(BASE).port);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, locale: 'fr-CA' });
const page = await context.newPage();
let bucket: Record<string, number> = {};
page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== BASE) return; const k = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '.$1'); bucket[k] = (bucket[k] ?? 0) + 1; });
const flush = (label: string) => { const n = Object.values(bucket).reduce((a, b) => a + b, 0); console.log(`\n${label}: ${n} requests`); for (const [k, v] of Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${String(v).padStart(4)}  ${k}`); bucket = {}; };
const pk = await virtualPasskey(context, page, passkeyFile(PORT));
await enter(page, pk, process.env.QA_SETUP_TOKEN ?? 'qa-setup-token');
await page.waitForTimeout(4000);
flush('enter + Home, first 4 s');
await page.waitForTimeout(30_000);
flush('Home, 30 idle seconds');
await page.goto('/agents'); await page.waitForTimeout(8000);
flush('/agents (full load), 8 s');
await page.goto('/swap'); await page.getByLabel('Montant').fill('25'); await page.waitForTimeout(15_000);
flush('/swap with an amount, 15 s');
await page.goto('/futures'); await page.waitForTimeout(15_000);
flush('/futures, 15 s');
await browser.close();

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v11-shots.mts
 * Module           : tests
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

// V11 interface pass — the pictures of docs/v11/screens/: one phone picture (390 × 844 @2x, light, French) per section, taken
// on a real local stack with a throwaway wallet, one paper account and one open paper position. The same script takes the
// « before » set (a stack built from the `v11` branch as it was before the pass) and the « after » set (this branch):
//   npx tsx tests/e2e/v11-shots.mts --base http://localhost:8840 --dir /tmp/spw-ui-ui --out docs/v11/screens/after
// PNG files are written to <out>; they are converted to WebP afterwards (cwebp -q 78) and the PNGs removed.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const BASE = arg('base', 'http://localhost:8840'), DIR = arg('dir', '/tmp/spw-ui-ui'), OUT = arg('out', 'docs/v11/screens/after');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-CA', timezoneId: 'America/Toronto' });
await context.addInitScript(() => { localStorage.setItem('spw-locale', 'fr'); localStorage.setItem('spw-theme', 'light'); });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto('/');
await page.getByRole('textbox').fill(readFileSync(`${DIR}/setup-token`, 'utf8').trim());
await page.getByRole('button', { name: /Créer ma clé/ }).click();
await page.getByText('Valeur totale estimée').waitFor({ timeout: 30_000 });

const headers = () => ({ origin: BASE, 'x-spw-csrf': '1', 'idempotency-key': `v11-shots-${randomUUID()}` });
const acct = (await (await page.request.post('/api/v1/derivatives/accounts', { headers: headers(), data: { venue: 'hyperliquid', label: 'Simulation', collateral: '10000' } })).json()).id as string;
await page.request.post(`/api/v1/derivatives/accounts/${acct}/orders`, { headers: headers(), data: { instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01', slippageBps: 100 } });
await page.addInitScript((id) => { localStorage.setItem('spw-fut-account', JSON.stringify(id)); }, acct);

const settle = async (ms = 2500) => { await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); await page.waitForTimeout(ms); };
const shot = async (name: string, path: string, o: { full?: boolean; wait?: string; before?: () => Promise<void> } = {}) => {
  await page.goto(path);
  if (o.wait) await page.locator(o.wait).first().waitFor({ timeout: 40_000 }).catch(() => console.log(`  (${name}: ${o.wait} not found — picture taken as the screen is)`));
  await settle();
  if (o.before) await o.before().catch((e: Error) => console.log(`  (${name}: ${e.message.split('\n')[0]})`));
  await page.screenshot({ path: `${OUT}/${name}-phone-light.png`, fullPage: o.full ?? false });
  console.log(`${name}  ${path}`);
};
await shot('dashboard', '/', { full: true, wait: '[data-testid=dashboard][data-state=ready], [data-testid=home-shortcuts]' });
await shot('markets', '/markets', { wait: '[data-testid=mk-open]' });
await shot('compare', '/markets?v=compare&u=BTC', { wait: '[data-testid=cp-total]' });
await shot('private-markets', '/private-markets', { wait: '[data-testid=pm-row-valuation]' });
await shot('trade-terminal', '/futures/hyperliquid%3ABTC', { wait: '[data-testid=terminal]' });
await shot('trade-positions', '/futures/hyperliquid%3ABTC', { full: true, wait: '[data-testid=terminal]', before: async () => { await page.getByRole('tab', { name: /^Positions/ }).first().click({ timeout: 5000 }); await settle(1500); } });
await shot('swap', '/swap', { wait: 'main input' });
await shot('agents', '/agents', { wait: 'main h1' });
await shot('risk', '/risk', { wait: '[data-testid=risk]' });
await shot('activity', '/activity', { full: true, wait: 'main h1' });
await shot('developer', '/developer', { wait: '[data-testid=dev-new-key]' });
await shot('settings', '/settings', { wait: 'main h1' });
await browser.close();

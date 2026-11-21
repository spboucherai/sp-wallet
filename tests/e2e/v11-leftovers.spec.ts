/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v11-leftovers.spec.ts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
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

// V11 interface pass — audit leftovers in a browser.
//  1. `/risk?mandate=<id>` on a REAL local stack (tests/e2e/ui-stack.sh: real API and signer, throwaway keystore and database,
//     paper only): the mandate of the link is scrolled into view, focused and opened; nothing is approved by the link; an
//     unknown id says so.
//        tests/e2e/ui-stack.sh lo 8830
//        SPW_E2E_BASE=http://localhost:8830 SPW_DEV_DIR=/tmp/spw-ui-lo pnpm e2e v11-leftovers.spec.ts
//  2. The development mock (`?mock=1`, Vite dev server, no backend): Home, Markets, Private markets and Risk draw their normal
//     states, the quote stream settles in `fallback`, and the console stays clean.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { deviceUse, expectNoOverflow, openWallet, paperAccount } from './v11-helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), PORT = 5183, MOCK = process.env.V11_MOCK_URL ?? `http://localhost:${PORT}`;
const STACK = existsSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`);

// 2026-11-17: the app now offers Hyperliquid alone (apps/web/src/venues.ts) and opens a venue account on the SIMPLE order form
// (tests/e2e/futures-hl-simple.spec.ts covers both). This spec covers the code kept behind those two choices, so it runs with the
// four venues shown — the development-only override of venues.ts — and with the full order form.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { sessionStorage.setItem('spw-venues', 'all'); localStorage.setItem('spw-fut-simple', 'false'); }); });

test.describe('/risk?mandate=<id> (real stack, paper)', () => {
  test.use(deviceUse('phone', 'fr'));
  test.skip(!STACK, 'needs a local stack (tests/e2e/ui-stack.sh) and its SPW_DEV_DIR');
  test('the mandate of the link is scrolled to, focused and opened; the approval is never opened by the link; an unknown id says so', async ({ page, context, baseURL }) => {
    const s = await openWallet(page, context, baseURL, { lang: 'fr' });
    const account = await paperAccount(page, s, 'Mandat e2e');
    // a mandate names a principal that exists: a perp agent created in research mode (it is never started)
    const made = await page.request.post('/api/v1/trading/agents', { headers: s.headers(), data: { kind: 'perp', name: `Agent e2e ${randomUUID().slice(0, 6)}`, universe: ['BTC'], venues: ['hyperliquid'] } });
    expect(made.status(), await made.text()).toBe(200);
    const agent = (await made.json()).agent.id as string;
    const body = (label: string) => ({ mode: 'paper', principal: { kind: 'agent', id: agent }, strategySha256: 'ab'.repeat(32), accountIds: [account], instruments: ['hyperliquid:BTC'], orderTypes: ['market', 'limit'], maxCapitalUsd: '5000', maxOrderNotionalUsd: '2000',
      maxPositionNotionalUsd: '4000', maxLeverage: '3', maxDailyLossUsd: '500', floorEquityUsd: '1000', days: 7, frequency: { perMinute: 30, perHour: 200, perDay: 400 }, maxSlippageBps: 100, maxFeeUsd: '10', label });
    const ids: string[] = [];
    for (const label of ['Mandat A (lien)', 'Mandat B', 'Mandat C']) { const r = await page.request.post('/api/v1/mandates', { headers: s.headers(), data: body(label) }); expect(r.status(), await r.text()).toBe(200); ids.push((await r.json()).mandate.id as string); }
    const wanted = ids[0]!;   // the list is newest first: the first created is the lowest on the page

    await page.goto(`/risk?mandate=${wanted}`);
    const card = page.getByTestId(`rk-mandate-${wanted}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveAttribute('data-wanted', 'true');
    await expect(card).toBeInViewport({ timeout: 10_000 });
    await expect(card).toBeFocused();
    // its two detail sections are open, those of another mandate are not
    const open = (id: string) => page.locator(`section.card:has([data-testid="rk-mandate-${id}"]) details[open]`).count();
    expect(await open(wanted)).toBe(2);
    expect(await open(ids[1]!)).toBe(0);
    // a link approves nothing: no dialog is open, the mandate still waits for its review
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId(`rk-approve-${wanted}`)).toBeVisible();
    await expectNoOverflow(page, '/risk?mandate');

    await page.goto(`/risk?mandate=${randomUUID()}`);
    await expect(page.getByTestId('rk-mandate-unknown')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(s.errors()).toEqual([]);
  });
});

test.describe('development mock: the V11 sections', () => {
  let vite: ChildProcess | null = null;
  test.use({ ...deviceUse('phone', 'fr'), baseURL: MOCK });
  test.beforeAll(async () => {
    if (process.env.V11_MOCK_URL) return;
    vite = spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${MOCK}/`)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
    throw new Error('the Vite dev server did not start');
  });
  test.afterAll(() => { vite?.kill(); });

  test('Home, Markets, Private markets and Risk draw without a backend; the quote stream falls back quietly; no console error', async ({ page }) => {
    const errors: string[] = [], failed: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
    page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()}`));

    await page.goto('/markets?mock=1');
    await expect(page.getByTestId('markets')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mk-open').first()).toBeVisible({ timeout: 20_000 });
    expect(await page.getByTestId('mk-open').count()).toBeGreaterThan(3);
    await expect(page.getByTestId('mk-not-tradable').first()).toBeVisible();   // the dYdX rows say why they cannot be traded
    // three failed connections, each closed without the network, then the client says the stream is unavailable
    await expect(page.getByTestId('qt-conn')).toHaveAttribute('data-state', 'fallback', { timeout: 40_000 });
    await page.getByTestId('mk-search').fill('ETH');
    await expect(page.getByTestId('mk-open').first()).toContainText('ETH');

    await page.goto('/private-markets');
    await expect(page.getByTestId('pm-notice')).toBeVisible({ timeout: 20_000 });

    await page.goto('/risk');
    await expect(page.getByTestId('risk')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rk-kill-state')).toBeVisible();
    await page.getByTestId('rk-kill-engage').click();   // a write is refused cleanly: an error line, not a crash
    await expect(page.getByRole('alert').first()).toBeVisible();

    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('section.hero')).toBeVisible({ timeout: 20_000 });

    expect(errors, errors.join('\n')).toEqual([]);
    expect(failed.filter((u) => /\/api\/v1\//.test(u)), failed.join('\n')).toEqual([]);
  });
});

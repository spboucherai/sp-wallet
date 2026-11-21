/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/risk.spec.ts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// V11 Risk on a real stack (scripts/dev-stack.sh: real API, real isolated signer, throwaway keystore and database; PAPER only —
// the paper engine fills against the venue's public market data, nothing is signed and nothing is sent to a venue).
//   engage the kill switch → a paper order that adds risk is refused in the terminal, with the failing check → closing the
//   position still works → releasing the switch asks for the passkey (virtual authenticator via CDP).
// Also: the limits are a form (no JSON), and a tightening is saved without a passkey.
//   createdb spw_dev_risk; SPW_DEV_PORT=8790 SPW_DEV_DB=spw_dev_risk SPW_DEV_DIR=/tmp/spw-dev-risk scripts/dev-stack.sh
//   SPW_E2E_BASE=http://localhost:8790 SPW_DEV_DIR=/tmp/spw-dev-risk pnpm e2e risk.spec.ts
const SHOTS = 'test-results/shots', BTC = 'hyperliquid:BTC';
test.use({ locale: 'fr-CA' });

test('Risk: kill switch refuses a paper order that adds risk, lets a close through, and is released with the passkey; limits are a form', async ({ page, context, baseURL }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByText('Configuration initiale')).toBeVisible();
  await page.getByRole('textbox').fill(readFileSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`, 'utf8').trim());
  await page.getByRole('button', { name: /Créer ma clé/ }).click();
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 30_000 });

  // a paper account with an open position (owner session; the same routes the terminal uses)
  const headers = () => ({ origin: baseURL!, 'x-spw-csrf': '1', 'idempotency-key': `risk-e2e-${randomUUID()}` });
  const created = await page.request.post('/api/v1/derivatives/accounts', { headers: headers(), data: { venue: 'hyperliquid', label: 'Risque e2e', collateral: '10000' } });
  expect(created.status(), await created.text()).toBe(200);
  const acct = (await created.json()).id as string;
  const opened = await page.request.post(`/api/v1/derivatives/accounts/${acct}/orders`, { headers: headers(), data: { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 100 } });
  expect(opened.status(), await opened.text()).toBe(200);

  // Settings → Risk
  await page.goto('/risk');
  await expect(page.getByTestId('risk')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('rk-kill-state')).toContainText('Désactivé');
  // live limits were never set on this wallet: the banner names every missing limit (nothing here is a JSON field)
  await expect(page.getByTestId('rk-live-banner')).toContainText('Ordres réels refusés tant que ces limites ne sont pas définies');
  await expect(page.getByTestId('rk-missing-owner').locator('li')).toHaveCount(15);
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/risk-01.png`, fullPage: true });

  // the paper book shows the position, per asset and per venue
  await page.getByRole('radio', { name: 'Simulation' }).first().click();
  await expect(page.getByTestId('rk-by-asset')).toContainText('BTC');
  await expect(page.getByTestId('rk-by-venue')).toContainText('hyperliquid');
  await expect(page.getByTestId('rk-liquidation')).toContainText(BTC);

  // limits form (paper): a tightening is saved at once, without a passkey
  await page.getByRole('radio', { name: 'Simulation' }).last().click();
  await page.getByTestId('rk-limits-edit').click();
  await expect(page.getByTestId('rk-limits-form')).toBeVisible();
  await page.getByTestId('rk-lim-maxOrderNotional').fill('5000');
  await page.getByTestId('rk-limits-save').click();
  await expect(page.getByTestId('rk-limits-form')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('rk-limit-maxOrderNotional')).toContainText('5000');
  await expect(page.getByTestId('rk-limit-maxOrderNotional')).toContainText('définie par vous');

  // engage the kill switch
  await page.getByTestId('rk-kill-reason').fill('e2e');
  await page.getByTestId('rk-kill-engage').click();
  await expect(page.getByTestId('rk-kill-state')).toContainText('Activé', { timeout: 15_000 });
  await expect(page.getByTestId('rk-alerts')).toContainText('Le coupe-circuit est activé');
  await page.screenshot({ path: `${SHOTS}/risk-02-kill.png`, fullPage: true });

  // the terminal: an order that adds risk is refused, and the failing check is shown
  await page.goto('/futures');
  await expect(page.getByTestId('terminal')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: /^Ordre$/ }).click();
  await page.getByRole('textbox', { name: 'Taille' }).fill('500');
  const review = page.getByRole('button', { name: /vérifier l’ordre BTC/ });
  await expect(page.getByTestId('order-panel')).toContainText(/kill_switch/, { timeout: 20_000 }).catch(async () => {
    // no pre-check sentence: the order is refused when it is placed
    await review.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Placer l’ordre simulé' }).click();
  });
  await expect(page.getByTestId('order-panel')).toContainText(/kill_switch/, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/risk-03-refused.png`, fullPage: true });
  // through the route itself, to pin the code: 422 kill_switch_active, nothing was filled
  const denied = await page.request.post(`/api/v1/derivatives/accounts/${acct}/orders`, { headers: headers(), data: { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 100 } });
  expect([denied.status(), (await denied.json()).error]).toEqual([422, 'kill_switch_active']);

  // a close still works under the kill switch
  await page.getByRole('tab', { name: /^Positions( \(\d+\))?$/ }).click();
  const blotter = page.getByTestId('blotter');
  await blotter.getByRole('button', { name: 'Fermer 100 % de la position BTC' }).click();
  await expect(blotter).toContainText('Aucune position.', { timeout: 20_000 });

  // back on Risk: the last decisions say it — denied on kill_switch, then an allowed reduction
  await page.goto('/risk');
  await expect(page.getByTestId('rk-kill-state')).toContainText('Activé', { timeout: 20_000 });
  await expect(page.locator('[data-testid="rk-decision"][data-decision="deny"][data-failed*="kill_switch"]').first()).toContainText('kill_switch');
  await expect(page.locator('[data-testid="rk-decision"][data-decision="allow"][data-reducing="true"]').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/risk-04-decisions.png`, fullPage: true });

  // release: the server prepares the intent and the passkey signs it; without a passkey the route refuses
  const noKey = await page.request.post('/api/v1/risk/kill-switch/release', { headers: headers(), data: {} });
  expect([noKey.status(), (await noKey.json()).error]).toEqual([403, 'passkey_required']);
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/risk/kill-switch/release')) asked.push(`${r.url().split('/api/v1')[1]} ${r.postData() ?? ''}`); });
  await page.getByTestId('rk-kill-release').click();
  await expect(page.getByTestId('rk-kill-state')).toContainText('Désactivé', { timeout: 20_000 });
  expect(asked[0]).toContain('/risk/kill-switch/release/prepare');
  expect(asked[1]).toMatch(/\/risk\/kill-switch\/release \{"assertion":\{/);                 // the release carried a passkey assertion
  expect(errors).toEqual([]);
});

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/agents-bind.spec.ts
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

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// V11.2 — the Agents panel in a real browser on a real stack (scripts/dev-stack.sh: real API with its agent workers, real isolated
// signer, throwaway keystore and database, the real laboratory of this checkout). PAPER only: the backtest and the signal read
// Hyperliquid's PUBLIC market data, the paper engine fills against the public book; nothing is signed, nothing reaches a venue's
// trading endpoint.
//   create from the Momentum template (momentum_xs_perp/2) → backtest through the job queue → the report, labelled BACKTEST,
//   with its version-3 sections → start paper (a paper trading mandate is created) → the timeline shows signal → order → fill
//   → the order is a row of the unified table (Risk reads the same mandate) → pause → stop;
//   "request live" shows the mandate requirement and links to /risk.
//   createdb spw_dev_agents; SPW_DEV_PORT=8792 SPW_DEV_DB=spw_dev_agents SPW_DEV_DIR=/tmp/spw-dev-agents scripts/dev-stack.sh
//   SPW_E2E_BASE=http://localhost:8792 SPW_DEV_DIR=/tmp/spw-dev-agents pnpm e2e agents-bind.spec.ts
const SHOTS = 'test-results/shots';
test.use({ locale: 'fr-CA' });
test.setTimeout(20 * 60_000);

test('Agents: template → backtest (labelled) → paper → signal, order, fill in the timeline → pause → stop; live asks for a mandate and links to Risk', async ({ page, context, baseURL }) => {
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

  // ---- create from the template: the laboratory's out-of-sample verdict is next to it, labelled
  await page.goto('/agents');
  await page.getByTestId('ag2-from-template').click();
  const sheet = page.getByTestId('ag2-template-sheet');
  const card = sheet.getByTestId('ag2-tpl-momentum');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId('ag2-lab')).toBeVisible();
  await expect(card.getByTestId('ag2-lab-dsr').first()).toContainText('0,07');                     // momentum_xs_perp/2: deflated Sharpe 0.074, read from the committed results
  await page.screenshot({ path: `${SHOTS}/agents-bind-01-templates.png`, fullPage: true });
  await card.click();
  await sheet.getByRole('textbox').first().fill('Momentum e2e');
  await sheet.getByRole('radio', { name: /momentum_xs_perp.*2/ }).first().click();
  await page.screenshot({ path: `${SHOTS}/agents-bind-02-form.png`, fullPage: true });
  await sheet.getByRole('button', { name: 'Créer l’agent' }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}/, { timeout: 120_000 });
  const id = /\/agents\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  // ---- the panel: the backtest runs through the job queue; the report is labelled BACKTEST and shows the v3 sections
  await page.getByTestId('ag2-open-panel').click();
  await expect(page.getByTestId('ag2-panel')).toBeVisible({ timeout: 30_000 });
  const report = async () => (await (await page.request.get(`/api/v1/agents/${id}/overview`)).json()).backtests.versions.find((v: { hasReport: boolean }) => v.hasReport);
  await expect.poll(async () => !!(await report()), { timeout: 12 * 60_000, intervals: [5000] }).toBe(true);
  await page.reload();
  await page.getByTestId('ag2-open-panel').click();
  const bt = page.getByTestId('ag2-backtest');
  await expect(bt).toHaveAttribute('data-label', 'backtest');
  await expect(bt.getByTestId('ag2-backtest-tag')).toBeVisible();
  await expect(bt.getByTestId('ag2-v3')).toBeVisible({ timeout: 30_000 });
  await expect(bt.getByTestId('ag2-v3-gtn')).toBeVisible();
  await expect(bt.getByTestId('ag2-v3-parity')).toBeVisible();
  await bt.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/agents-bind-03-backtest.png`, fullPage: true });

  // ---- start paper: a paper trading mandate exists for the agent (the Risk screen lists it), nothing is signed
  await page.getByRole('button', { name: /Démarrer en simulation/ }).click();
  await expect(page.getByTestId('ag2-life')).toContainText(/Acti/i, { timeout: 30_000 });
  const mandates = (await (await page.request.get('/api/v1/mandates')).json()).mandates as { mode: string; state: string; principal: { kind: string; id: string }; id: string }[];
  const paper = mandates.find((m) => m.principal.id === id)!;
  expect(paper).toMatchObject({ mode: 'paper', state: 'active', principal: { kind: 'agent', id } });

  // ---- the engine (one pass a minute): signal → order → fill in the timeline; the order is a row of the unified table
  const orders = async () => ((await (await page.request.get(`/api/v1/agents/${id}/orders?mode=paper`)).json()).orders ?? []) as { state: string; source?: string }[];
  await expect.poll(async () => (await orders()).some((o) => o.state === 'FILLED'), { timeout: 5 * 60_000, intervals: [5000] }).toBe(true);
  expect((await orders()).every((o) => o.source === 'orders')).toBe(true);
  const unified = (await (await page.request.get('/api/v1/trading/orders?mode=paper', { headers: { origin: baseURL! } })).json()).orders as { principal: { kind: string; id: string }; mandateId: string; origin: string }[];
  expect(unified.filter((o) => o.principal.kind === 'agent' && o.principal.id === id && o.mandateId === paper.id && o.origin === 'agent').length).toBeGreaterThan(0);
  await page.reload();
  await page.getByTestId('ag2-open-panel').click();
  const tl = page.getByRole('list', { name: 'Chronologie des décisions' }).or(page.getByLabel('Chronologie des décisions')).first();
  await expect(tl).toContainText(/Signal/i, { timeout: 30_000 });
  await expect(tl).toContainText(/Order filled|Ordre/i);
  await expect(tl).toContainText(/Filled|Exécution/i);
  await expect(page.getByTestId('ag2-perf-paper')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/agents-bind-04-paper-timeline.png`, fullPage: true });

  // ---- live: the mandate requirement, with the link to Risk
  await page.getByTestId('ag2-request-live').click();
  const ms = page.getByTestId('ag2-mandate-sheet');
  await expect(ms).toBeVisible();
  await expect(ms.getByTestId('ag2-mandate-link')).toHaveAttribute('href', /^\/risk\?mandate=/);
  await page.screenshot({ path: `${SHOTS}/agents-bind-05-mandate.png`, fullPage: true });
  await ms.getByTestId('ag2-mandate-link').click();
  await expect(page.getByTestId('risk')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`rk-mandate-${paper.id}`)).toBeVisible();                           // the agent's paper mandate, in the Risk screen
  await page.screenshot({ path: `${SHOTS}/agents-bind-06-risk.png`, fullPage: true });

  // ---- pause, then stop
  await page.goto(`/agents/${id}`);
  await page.getByTestId('ag2-open-panel').click();
  await page.getByRole('button', { name: 'Mettre en pause' }).click();
  await expect(page.getByTestId('ag2-life')).toContainText(/pause/i, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Arrêter' }).click();
  await expect(page.getByTestId('ag2-life')).toContainText(/Arrêt/i, { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/agents-bind-07-stopped.png`, fullPage: true });
  expect(errors).toEqual([]);
});

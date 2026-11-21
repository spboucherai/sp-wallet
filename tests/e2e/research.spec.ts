/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/research.spec.ts
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

// V7 research jobs in the browser, against the real API and the REAL research runner (tests/e2e/research-server.mts): the
// runner launches the deterministic fake agent under the OS sandbox, the server re-evaluates what it hands in. No model.
// The owner: describes a mission on the agent's page, sets budgets, watches the log, reads "what the agent claims" next to
// "what the server measured", approves, starts paper trading. Then, in the Recherche view: an agent whose numbers differ
// from the server's, a submission refused for purity, a cancelled job.
//
//   (cd apps/web && node_modules/.bin/vite build) && npx playwright test -c tests/e2e/playwright.config.ts research.spec.ts
//   RESEARCH_SHOTS=1 … writes docs/v7/screens/research-<size>-*.png
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), SHOTS = resolve(ROOT, 'docs/v7/screens');
const SIZES = [
  { name: 'phone', port: 8691, use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', port: 8692, use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;
const MISSION = 'Développe une stratégie statistique BTC/ETH, teste-la sur données historiques et prépare une simulation avec un capital virtuel de 1 000 USDC';

for (const size of SIZES) {
  const BASE = `http://localhost:${size.port}`;
  test.describe(`research jobs — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA', baseURL: BASE });
    let server: ChildProcess | null = null, log = '', token = '', agent = '';
    test.beforeAll(async () => {
      if (!existsSync(resolve(ROOT, 'dist/web/index.html'))) throw new Error('dist/web is missing: build the web bundle first (cd apps/web && node_modules/.bin/vite build)');
      server = spawn(resolve(ROOT, 'node_modules/.bin/tsx'), ['tests/e2e/research-server.mts', '--port', String(size.port), '--db', `spw_v7_research_e2e_${size.name}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout!.on('data', (d) => { log += String(d); }); server.stderr!.on('data', (d) => { log += String(d); });
      for (let i = 0; i < 240 && !/READY/.test(log); i++) { if (server.exitCode !== null) break; await new Promise((r) => setTimeout(r, 250)); }
      const m = /READY \S+ token (\S+) agent (\S+)/.exec(log);
      if (!m) throw new Error(`the research backend did not start:\n${log.slice(-2000)}`);
      token = m[1]!; agent = m[2]!;
    });
    test.afterAll(async () => { server?.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); });
    const shot = async (page: Page, name: string) => { if (process.env.RESEARCH_SHOTS !== '1') return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/research-${size.name}-${name}.png`, fullPage: true }); };
    const fakeMode = (page: Page, mode: string) => page.evaluate(async (m) => { await fetch('/api/v1/__e2e/fake-mode', { method: 'POST', headers: { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) }); }, mode);

    test('mission → job → log → claims vs server measurements → approval → paper trading; then a lying agent, a refused strategy, a cancel', async ({ page, context }) => {
      test.setTimeout(420_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      await context.addCookies([{ name: 'spw', value: token, url: BASE }]);

      // ---- on the agent's page: a research job for exactly what this agent trades
      await page.goto(`/agents/${agent}`);
      const panel = page.getByTestId('rj-panel');
      await expect(panel).toContainText('Recherche autonome');
      await expect(panel.getByTestId('rj-none')).toBeVisible();
      await panel.getByTestId('rj-new').click();
      const form = panel.getByTestId('rj-form');
      await expect(form.getByTestId('rj-create')).toBeDisabled();           // no mission, no job
      await form.getByTestId('rj-mission').fill(MISSION);
      await expect(form).toContainText('Pour cet agent : BTC, ETH · 1h · Au comptant.');
      await form.getByTestId('rj-budget-minutes').fill('5'); await form.getByTestId('rj-budget-maxTrials').fill('80');
      await expect(form).toContainText('Pas d’accès au Web.');
      await shot(page, '01-form');
      await form.getByTestId('rj-create').click();
      const job = panel.getByTestId('rj-job');
      await expect(job).toBeVisible();
      await expect(job.getByTestId('rj-log')).toContainText('job created by the owner', { timeout: 20_000 });
      // the log arrives while the job runs (the runner pushes it; the page reads the stream)
      await expect(job.getByTestId('rj-log')).toContainText('starting the agent (command) under sandbox-exec', { timeout: 60_000 });
      await expect(job.getByTestId('rj-log')).toContainText('trial 0', { timeout: 60_000 });
      await shot(page, '02-running');
      await expect(job.getByTestId('rj-state')).toHaveAttribute('data-state', 'submitted', { timeout: 240_000 });
      await expect(job.getByTestId('rj-holdout')).toContainText(/880 barres remises à l’agent ; 220 barres gardées sur le serveur/);
      await expect(job.getByTestId('rj-isolation')).toContainText('bac à sable du système (sandbox-exec)');
      // what the agent claims — clearly marked as unverified
      const claims = job.getByTestId('rj-claims');
      await expect(claims).toContainText('NON VÉRIFIÉ'); await expect(claims).toContainText('Ce que l’agent affirme');
      await expect(claims.getByTestId('rj-readme')).toContainText('What would refute it');
      // what the server measured — its own report
      const measured = job.getByTestId('rj-measured');
      await expect(measured).toContainText('MESURÉ'); await expect(measured).toContainText('Ce que le serveur a mesuré');
      await expect(measured).toContainText('l’agent ne l’a jamais eue');
      await expect(measured).toContainText(/Essais comptés\s*\d+\s*\d+ par la tâche \+ \d+ par le serveur/);
      await expect(measured).toContainText('Sharpe déflaté');
      await expect(measured.getByTestId('rj-agrees')).toBeVisible();
      await expect(measured.locator('tr[data-differs="true"]')).toHaveCount(0);
      await claims.getByTestId('rj-code').locator('summary').click();
      await expect(claims.getByTestId('rj-code')).toContainText('def target_weights(data, params)');
      await shot(page, '03-submitted');
      // the existing flow: approve the version (it has the server's report), start paper trading
      await job.getByTestId('rj-approve').click();
      await expect(job.getByTestId('rj-approved')).toBeVisible({ timeout: 15_000 });
      await job.getByTestId('rj-paper').click();
      await expect(job.getByTestId('rj-paper-on')).toBeVisible({ timeout: 15_000 });
      await shot(page, '04-approved-paper');

      // ---- the Recherche view: a library draft whose agent reports other numbers than the server measures
      await fakeMode(page, 'lie');
      await page.goto('/research');
      const screen = page.getByTestId('rj-screen');
      await expect(screen.getByTestId('rj-status')).toContainText('Nœud de recherche vu le');
      await expect(screen.getByTestId('rj-list').locator('li')).toHaveCount(1);
      await screen.getByTestId('rj-new').click();
      await screen.getByTestId('rj-mission').fill('Même mission, sans agent : un brouillon de bibliothèque sur BTC et ETH.');
      await screen.getByTestId('rj-symbols').fill('btc, eth');
      await screen.getByTestId('rj-create').click();
      const lie = screen.getByTestId('rj-job');
      await expect(lie.getByTestId('rj-state')).toHaveAttribute('data-state', 'submitted', { timeout: 240_000 });
      await expect(lie.getByTestId('rj-differs')).toContainText('Les chiffres déclarés par l’agent diffèrent de ceux du serveur. Seuls ceux du serveur comptent.');
      await expect(lie.getByTestId('rj-summary')).toContainText('Extremely profitable. Guaranteed.');
      expect(await lie.locator('tr[data-differs="true"]').count()).toBeGreaterThanOrEqual(4);
      await expect(lie.getByTestId('rj-attach')).toContainText('Attacher à Momentum BTC/ETH');
      await shot(page, '05-claims-differ');

      // ---- a strategy the server refuses before running anything
      await fakeMode(page, 'impure');
      await screen.getByTestId('rj-new').click();
      await screen.getByTestId('rj-mission').fill('Une stratégie qui tente de lire un fichier.');
      await screen.getByTestId('rj-create').click();
      const bad = screen.getByTestId('rj-job');
      await expect(bad.getByTestId('rj-state')).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
      await expect(bad.getByTestId('rj-refused')).toContainText(/fails the purity check: line \d+: use of 'open' is not allowed/);
      await expect(bad.getByTestId('rj-measured')).toHaveCount(0);
      await shot(page, '06-refused');

      // ---- cancel a running job
      await fakeMode(page, 'hang');
      await screen.getByTestId('rj-new').click();
      await screen.getByTestId('rj-mission').fill('Une tâche qui ne finit pas : elle sera annulée.');
      await screen.getByTestId('rj-create').click();
      const hang = screen.getByTestId('rj-job');
      await expect(hang.getByTestId('rj-state')).toHaveAttribute('data-state', 'running', { timeout: 60_000 });
      await hang.getByTestId('rj-cancel').click();
      await expect(hang.getByTestId('rj-state')).toHaveAttribute('data-state', 'cancelled', { timeout: 60_000 });
      await expect(screen.getByTestId('rj-list').locator('li')).toHaveCount(4);
      await shot(page, '07-list');

      // English
      await page.evaluate(() => localStorage.setItem('spw-locale', 'en')); await page.reload();
      await expect(page.getByTestId('rj-screen')).toContainText('What is guaranteed, and by what');
      await page.getByTestId('rj-list').locator('li').nth(2).locator('button').first().click();
      await expect(page.getByTestId('rj-differs')).toContainText('Only the server’s count.');
      await shot(page, '08-english');
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}

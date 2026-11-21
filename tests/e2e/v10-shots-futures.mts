/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v10-shots-futures.mts
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

// v10 design pass — screenshots of the Futures area (paper terminal, compare, router, accounts), dev mock only (`?mock=1`).
//   npx tsx tests/e2e/v10-shots-futures.mts before|after [only-name,…] [phone-light,desktop-dark…]
//   npx tsx tests/e2e/v10-shots-futures.mts perf        → frame times of the chart pane and of the book pane (phone, CPU ×4) and of the desktop grid
// The Vite dev server is the area's own (port 5330, or V10_FUTURES_PORT). The mock's prices move: pictures are for human eyes.
import { chromium, type Page } from '@playwright/test';
import { runShots, startVite, type Cfg, type Scenario } from './v10-shots-lib.mts';

const PORT = Number(process.env.V10_FUTURES_PORT ?? 5330);
const T = '/futures?mock=1';
const tab = async (page: Page, cfg: Cfg, name: string) => { if (cfg.mobile) await page.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click(); };
const live = (page: Page) => page.waitForSelector('[data-testid="freshness"][data-state="live"]', { timeout: 15_000 });
const size = async (page: Page, v: string) => { await page.getByRole('textbox', { name: 'Taille' }).fill(v); };
const place = async (page: Page, cfg: Cfg) => {
  await tab(page, cfg, 'Ordre'); await size(page, '1500');
  await page.getByTestId('preview').getByText('Marge initiale').waitFor();
  await page.getByRole('button', { name: /vérifier l’ordre BTC/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Placer l’ordre simulé' }).click();
  await page.getByTestId('order-result').waitFor();
};

const scenarios: Scenario[] = [
  { name: 'terminal-chart', path: T, act: async (p) => { await live(p); }, full: true },
  { name: 'terminal-book', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Carnet'); }, skip: (c) => !c.mobile },
  { name: 'terminal-order', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Ordre'); }, skip: (c) => !c.mobile, full: true },
  { name: 'terminal-positions-empty', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Positions'); if (!c.mobile) await p.getByTestId('blotter').scrollIntoViewIfNeeded(); } },
  { name: 'order-preview', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Ordre'); await size(p, '1500'); await p.getByTestId('preview').getByText('Marge initiale').waitFor(); if (c.mobile) await p.getByTestId('preview').scrollIntoViewIfNeeded(); }, full: true },
  { name: 'order-refused', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Ordre'); await size(p, '80000'); await p.getByTestId('risk-refusal').waitFor(); await p.getByTestId('risk-refusal').scrollIntoViewIfNeeded(); } },
  { name: 'order-limit', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Ordre'); await p.getByRole('radio', { name: 'À cours limité' }).click(); await p.getByRole('textbox', { name: /Prix limite/ }).fill('60000'); await size(p, '500'); }, skip: (c) => !c.mobile, full: true },
  { name: 'order-confirm', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Ordre'); await size(p, '1500'); await p.getByTestId('preview').getByText('Marge initiale').waitFor(); await p.getByRole('button', { name: /vérifier l’ordre BTC/ }).click(); await p.getByRole('dialog').waitFor(); } },
  { name: 'position-open', path: T, act: async (p, c) => { await live(p); await place(p, c); await tab(p, c, 'Positions'); await p.getByTestId('blotter').getByRole('button', { name: 'Ouvrir le marché BTC' }).waitFor(); if (!c.mobile) await p.getByTestId('blotter').scrollIntoViewIfNeeded(); }, full: true },
  { name: 'position-chart', path: T, act: async (p, c) => { await live(p); await place(p, c); await tab(p, c, 'Graphique'); if (!c.mobile) await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(3500); } },
  { name: 'blotter-fills', path: T, act: async (p, c) => { await live(p); await place(p, c); await tab(p, c, 'Positions'); await p.getByTestId('blotter').getByRole('tab', { name: /^Exécutions/ }).click(); if (!c.mobile) await p.getByTestId('blotter').scrollIntoViewIfNeeded(); } },
  { name: 'blotter-pnl', path: T, act: async (p, c) => { await live(p); await place(p, c); await tab(p, c, 'Positions'); await p.getByTestId('blotter').getByRole('tab', { name: /^(PnL|Résultat)/ }).click().catch(() => {}); if (!c.mobile) await p.getByTestId('blotter').scrollIntoViewIfNeeded(); } },
  { name: 'market-picker', path: T, act: async (p) => { await live(p); await p.getByTestId('market-picker').click(); await p.getByRole('dialog', { name: 'Choisir un marché' }).waitFor(); await p.waitForTimeout(600); } },
  { name: 'stale', path: T, act: async (p) => { await live(p); await p.evaluate(() => (window as unknown as { __spwMock: { stale(): void } }).__spwMock.stale()); await p.getByTestId('stale-banner').waitFor(); await p.waitForTimeout(1500); } },
  { name: 'stale-book', path: T, act: async (p, c) => { await live(p); await tab(p, c, 'Carnet'); await p.evaluate(() => (window as unknown as { __spwMock: { stale(): void } }).__spwMock.stale()); await p.getByTestId('stale-banner').waitFor(); }, skip: (c) => !c.mobile },
  { name: 'gmx-liquidity', path: `/futures/${encodeURIComponent('gmx:BTC/USD [BTC-USDC]')}?mock=1`, act: async (p, c) => { if (c.mobile) await p.getByRole('tab', { name: 'Liquidité' }).click(); }, full: true },
  { name: 'dydx-order', path: '/futures/dydx%3ABTC-USD?mock=1', act: async (p, c) => { await tab(p, c, 'Ordre'); } },
  { name: 'not-allowed', path: '/futures/hyperliquid%3ASOL?mock=1', act: async (p, c) => { await tab(p, c, 'Ordre'); } },
  { name: 'compare', path: `${T}&v=compare`, full: true },
  { name: 'router-form', path: `${T}&v=router`, full: true },
  { name: 'router-results', path: `${T}&v=router`, act: async (p) => { await p.getByTestId('router-run').click(); await p.getByTestId('router-results').waitFor(); } },
  { name: 'router-card', path: `${T}&v=router`, act: async (p) => { await p.getByTestId('router-run').click(); await p.getByTestId('router-results').waitFor(); await p.locator('[data-testid="router-card"][data-instrument="hyperliquid:BTC"]').scrollIntoViewIfNeeded(); await p.evaluate(() => scrollBy(0, 240)); } },
  { name: 'router-risk', path: `${T}&v=router`, act: async (p) => {
    await p.getByRole('textbox', { name: 'Taille' }).fill('2000'); await p.getByRole('textbox', { name: 'Levier' }).fill('5');
    await p.getByRole('combobox', { name: 'Compte pour la vue risque' }).selectOption({ label: 'Simulation Hyperliquid — Hyperliquid' });
    await p.getByTestId('router-run').click(); await p.getByTestId('router-policy').first().waitFor(); await p.getByTestId('router-policy').first().scrollIntoViewIfNeeded(); await p.evaluate(() => scrollBy(0, 160)); } },
  { name: 'accounts', path: `${T}&v=accounts`, full: true },
  { name: 'account-create', path: `${T}&v=accounts`, act: async (p) => { await p.getByTestId('accounts-view').getByRole('button', { name: 'Nouveau compte' }).click(); await p.getByTestId('account-form').waitFor(); await p.getByRole('textbox', { name: 'Nom du compte' }).fill('Essai 2'); } },
  { name: 'account-limits', path: `${T}&v=accounts`, act: async (p) => { await p.getByTestId('accounts-view').getByRole('button', { name: 'Modifier les limites' }).first().click(); await p.getByRole('dialog').waitFor(); } },
  { name: 'account-reset', path: `${T}&v=accounts`, act: async (p) => { await p.getByTestId('accounts-view').getByRole('button', { name: 'Remettre à zéro' }).first().click(); await p.getByRole('dialog').waitFor(); } },
  // no paper account at all (kept last: `empty=1` stays for the tab until another `mock=1` navigation)
  { name: 'no-account-order', path: `${T}&empty=1`, act: async (p, c) => { await tab(p, c, 'Ordre'); } },
  { name: 'no-account-positions', path: `${T}&empty=1`, act: async (p, c) => { await tab(p, c, 'Positions'); }, skip: (c) => !c.mobile },
  { name: 'no-account-accounts', path: `${T}&empty=1&v=accounts` },
];

/** frame times over 8 s (requestAnimationFrame deltas), the method of futures.spec.ts, on one pane at a time */
async function perf(base: string): Promise<void> {
  const browser = await chromium.launch();
  const measure = async (name: string, phone: boolean, pane?: string) => {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, locale: 'fr-CA' });
    const page = await context.newPage();
    await page.goto(`${base}/futures?mock=1&rate=20`); await live(page);
    if (pane) await page.getByRole('tab', { name: new RegExp(`^${pane}`) }).click();
    if (phone) { const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
    await page.waitForTimeout(800);
    // a string, not a function: tsx rewrites named inner functions with a helper that does not exist in the page
    const r = await page.evaluate(`(async () => {
      const frames = [], long = []; let mutations = 0;
      const mo = new MutationObserver((l) => { mutations += l.length; }); mo.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true, attributes: true });
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); }); po.observe({ entryTypes: ['longtask'] });
      const t0 = performance.now(); let last = t0;
      await new Promise((done) => { const f = (t) => { frames.push(t - last); last = t; if (t - t0 < 8000) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
      mo.disconnect(); po.disconnect();
      const s = [...frames].sort((a, b) => a - b), sec = (performance.now() - t0) / 1000;
      return { fps: +(frames.length / sec).toFixed(1), frameP50: +s[Math.floor(s.length * 0.5)].toFixed(1), frameP95: +s[Math.floor(s.length * 0.95)].toFixed(1), frameP99: +s[Math.floor(s.length * 0.99)].toFixed(1), frameMax: +s[s.length - 1].toFixed(1), longTasks: long.length, domMutationsPerSec: +(mutations / sec).toFixed(0) };
    })()`);
    console.log(`[perf ${name}] ${JSON.stringify(r)}`);
    await context.close();
  };
  await measure('phone ×4 · chart pane', true, 'Graphique');
  await measure('phone ×4 · book pane', true, 'Carnet');
  await measure('phone ×4 · order pane', true, 'Ordre');
  await measure('desktop · whole grid', false);
  await browser.close();
}

const base = await startVite(PORT);
if (process.argv[2] === 'perf') { await perf(base); process.exit(0); }
await runShots('futures', [{ base, scenarios }]);

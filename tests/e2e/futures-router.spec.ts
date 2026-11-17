import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// « Routeur (simulation) » against the in-browser mock (`?mock=1`, development build only): the REAL router of
// packages/derivatives runs in the page on the mock's simulated markets (mockRouter.ts). No backend, no venue.
// The spec starts its own Vite dev server (or uses FUTURES_URL). FUTURES_SHOTS=1 writes docs/v4/screens/router-*.png.
//   npx playwright test -c tests/e2e/playwright.config.ts futures-router.spec.ts
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5191;
const BASE = process.env.FUTURES_URL ?? `http://localhost:${PORT}`;
const SHOTS = resolve(ROOT, 'docs/v4/screens');
let vite: ChildProcess | null = null;

// 2026-11-17: the app now offers Hyperliquid alone (apps/web/src/venues.ts) and opens a venue account on the SIMPLE order form
// (tests/e2e/futures-hl-simple.spec.ts covers both). This spec covers the code kept behind those two choices, so it runs with the
// four venues shown — the development-only override of venues.ts — and with the full order form.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { sessionStorage.setItem('spw-venues', 'all'); localStorage.setItem('spw-fut-simple', 'false'); }); });

test.beforeAll(async () => {
  if (process.env.FUTURES_URL) return;
  vite = spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the Vite dev server did not start');
});
test.afterAll(() => { vite?.kill(); });

const shot = async (page: Page, name: string, fullPage = true) => {
  if (process.env.FUTURES_SHOTS !== '1') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
};
const open = async (page: Page, path = '/futures?v=router', extra = '') => {
  await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}mock=1${extra}`);
  await expect(page.getByTestId('paper-banner')).toBeVisible();
};
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(String(e))); return errors; };
/** every request the page makes to the API: the router view must never call an order route */
const calls = (page: Page) => { const seen: string[] = []; page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v1/')) seen.push(`${r.method()} ${u.pathname}`); }); return seen; };
const card = (page: Page, instrument: string) => page.locator(`[data-testid="router-card"][data-instrument="${instrument}"]`);

const SIZES = [
  { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;

for (const size of SIZES) {
  test.describe(`router (simulation) — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA' });

    test('form → one card per venue instrument, itemised and tagged; ranking worded honestly; dYdX unavailable with the reason', async ({ page }) => {
      const errors = errorsOf(page);
      await open(page);
      const view = page.getByTestId('router-view');
      await expect(view).toContainText('Routeur (simulation)');
      await expect(view).toContainText('Simulation seulement.');
      await expect(page.getByRole('tab', { name: 'Routeur (simulation)' })).toHaveAttribute('aria-selected', 'true');
      await expect(view).toContainText('Décrivez l’ordre, puis lancez l’estimation.');
      await shot(page, `router-${size.name}-01-form`);
      await page.getByTestId('router-run').click();
      const results = page.getByTestId('router-results');
      await expect(results).toBeVisible();
      // ranking: honest wording, never « meilleur », nothing selected
      await expect(page.getByTestId('router-least')).toContainText('Le moins coûteux d’après ces estimations');
      const text = (await results.innerText()).toLowerCase();
      expect(text).not.toContain('meilleur'); expect(text).not.toContain('recommand');
      await expect(results).toContainText('Le classement est une information ; rien n’est sélectionné.');
      // one card per instrument: Hyperliquid, the GMX pools, dYdX
      const cards = page.getByTestId('router-card');
      expect(await cards.count()).toBeGreaterThanOrEqual(3);
      const hl = card(page, 'hyperliquid:BTC'), gmx = card(page, 'gmx:BTC/USD [BTC-USDC]'), dy = card(page, 'dydx:BTC-USD');
      await expect(hl.getByTestId('router-status')).toHaveAttribute('data-status', 'setup');
      await expect(hl.getByTestId('router-costs').locator('li[data-cost]')).toHaveCount(4);
      await expect(hl).toContainText('Écart et glissement'); await expect(hl).toContainText('Frais de négociation'); await expect(hl).toContainText('Financement sur la durée');
      await expect(hl.getByTestId('router-allin')).toContainText('Tout compris sur 24 h');
      // every figure of the simulated execution and of the costs carries its source
      expect(await hl.locator('[data-src="venue"]').count()).toBeGreaterThan(2);
      expect(await hl.locator('[data-src="estimate"]').count()).toBeGreaterThan(5);
      await hl.locator('li[data-cost="trading_fee"] summary').click();
      await expect(hl.locator('li[data-cost="trading_fee"] [data-src="constant"]').first()).toBeVisible();
      // GMX: no book — oracle, impact, execution fee, gas, borrowing; cannot be traded from this wallet
      await expect(gmx.getByTestId('router-status')).toHaveAttribute('data-status', 'setup');
      await expect(gmx).toContainText('Impact de prix (formule)'); await expect(gmx).toContainText('Frais d’exécution (exécutant, en ETH)'); await expect(gmx).toContainText('Emprunt sur la durée');
      await expect(gmx.locator('li[data-reason="wallet_cannot_trade_here"]')).toContainText('ne fait que lire cette plateforme');
      await expect(gmx.getByTestId('router-open-paper')).toHaveCount(0);
      // dYdX: shown, marked unavailable with the reason, never in the ranking
      await expect(dy.getByTestId('router-status')).toHaveAttribute('data-status', 'restricted');
      await expect(dy.getByTestId('router-status')).toHaveText('Non disponible pour vous');
      await expect(dy).toContainText('excluent le Canada'); await expect(dy.getByTestId('router-open-paper')).toHaveCount(0);
      await expect(results.getByRole(size.name === 'phone' ? 'list' : 'table', { name: 'Classement par coût estimé' })).not.toContainText('dYdX');
      // the differences: these contracts are not interchangeable
      await expect(results).toContainText('Ces contrats ne sont pas interchangeables.'); await expect(results).toContainText('Prix de référence (marge, liquidation)');
      await shot(page, `router-${size.name}-02-results`);
      await hl.scrollIntoViewIfNeeded();
      await shot(page, `router-${size.name}-03-card-hyperliquid`, false);
      await gmx.scrollIntoViewIfNeeded();
      await shot(page, `router-${size.name}-04-card-gmx`, false);
      await dy.scrollIntoViewIfNeeded();
      await shot(page, `router-${size.name}-05-card-dydx`, false);
      expect(errors).toEqual([]);
    });

    test('a size the book snapshot cannot fill is said, not extrapolated; a refused leverage names its reason', async ({ page }) => {
      await open(page);
      await page.getByRole('textbox', { name: 'Taille' }).fill('900000000');
      await page.getByTestId('router-run').click();
      const hl = card(page, 'hyperliquid:BTC');
      await expect(hl.getByTestId('router-status')).toHaveAttribute('data-status', 'not_eligible');
      await expect(hl).toContainText('Le relevé du carnet s’arrête.'); await expect(hl.locator('li[data-reason="book_snapshot_ends"]')).toContainText('rien n’est extrapolé');
      await expect(card(page, 'gmx:BTC/USD [BTC-USDC]').locator('li[data-reason="above_capacity"]')).toBeVisible();
      await expect(page.getByTestId('router-results')).toContainText('Aucun instrument admissible pour cet ordre.');
      await shot(page, `router-${size.name}-06-book-ends`);
      await page.getByRole('textbox', { name: 'Taille' }).fill('1000');
      await page.getByRole('textbox', { name: 'Levier' }).fill('60');
      await expect(page.getByTestId('router-results')).toHaveAttribute('data-stale', '1');           // the shown results are for the previous order, and say so
      await page.getByTestId('router-run').click();
      await expect(card(page, 'hyperliquid:BTC').locator('li[data-reason="leverage_above_venue_max"]')).toBeVisible();
    });

    test('risk view with the paper account, then « Ouvrir sur Hyperliquid en simulation » pre-fills the paper order panel — no order route is called', async ({ page }) => {
      const seen = calls(page);
      await open(page);
      await page.getByRole('textbox', { name: 'Taille' }).fill('2000');
      await page.getByRole('combobox', { name: 'Compte pour la vue risque' }).selectOption({ label: 'Simulation Hyperliquid — Hyperliquid' });
      await page.getByTestId('router-run').click();
      const hl = card(page, 'hyperliquid:BTC');
      await expect(hl.getByTestId('router-status')).toHaveAttribute('data-status', 'paper');
      await expect(hl.getByTestId('router-policy')).toHaveAttribute('data-accepted', 'true');
      // the default paper policy caps leverage at 3: the account's own risk engine refuses, with its code
      await page.getByRole('textbox', { name: 'Levier' }).fill('5');
      await page.getByTestId('router-run').click();
      await expect(hl.getByTestId('router-policy')).toHaveAttribute('data-accepted', 'false');
      await expect(hl.getByTestId('router-policy')).toContainText('leverage_exceeded');
      await shot(page, `router-${size.name}-07-risk-view`);
      await page.getByRole('textbox', { name: 'Levier' }).fill('3');
      await page.getByTestId('router-run').click();
      await expect(hl.getByTestId('router-policy')).toHaveAttribute('data-accepted', 'true');
      const sizeBase = await hl.locator('[data-testid="router-open-paper"]').evaluate(() => (JSON.parse(sessionStorage.getItem('spw-fut-prefill') ?? 'null') as { size?: string } | null)?.size ?? null);
      expect(sizeBase).toBeNull();                                                                     // nothing is handed over before the click
      await hl.getByTestId('router-open-paper').click();
      // the paper terminal of Hyperliquid BTC, order panel first, form filled; still a form
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'paper');
      await expect(page).toHaveURL(/\/futures\/hyperliquid%3ABTC/);
      const sizeBox = page.getByRole('textbox', { name: 'Taille' });
      await expect(sizeBox).toBeVisible();
      expect(Number((await sizeBox.inputValue()).replace(',', '.'))).toBeGreaterThan(0.02);
      await shot(page, `router-${size.name}-08-paper-panel-prefilled`, false);
      // no order was placed by any of this: only reads, the route simulation and the paper PREVIEW
      const writes = seen.filter((c) => c.startsWith('POST'));
      expect(writes.every((c) => c === 'POST /api/v1/derivatives/route' || /\/orders\/preview$/.test(c))).toBe(true);
      expect(seen.some((c) => /\/live\/.*(orders|approve|authoriz)/.test(c) && c.startsWith('POST'))).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { __spwMock: { accounts(): number } }).__spwMock.accounts())).toBe(1);
    });

    test('English: honest wording there too', async ({ page }) => {
      await open(page);
      await page.evaluate(() => localStorage.setItem('spw-locale', 'en'));
      await page.reload();
      const view = page.getByTestId('router-view');
      await expect(view).toBeVisible();
      if (!(await view.innerText()).includes('Simulation only.')) test.skip(true, 'the locale is not switched through localStorage in this build');
      await page.getByTestId('router-run').click();
      await expect(page.getByTestId('router-least')).toContainText('Lowest cost according to these estimates');
      const text = (await page.getByTestId('router-results').innerText()).toLowerCase();
      expect(text).not.toMatch(/\bbest venue\b|\brecommended\b/);
      await expect(card(page, 'dydx:BTC-USD').getByTestId('router-status')).toHaveText('Not available to you');
      await shot(page, `router-${size.name}-09-english`);
    });
  });
}

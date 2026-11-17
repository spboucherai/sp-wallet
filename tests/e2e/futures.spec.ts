import { navTo } from './v11-helpers.ts';   // v11 interface: the shell's navigation (five areas, header menu)
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Futures terminal against the in-browser mock (`?mock=1`, development build only): no backend, no venue, no dev stack needed.
// The spec starts its own Vite dev server (or uses FUTURES_URL). FUTURES_SHOTS=1 writes the screenshots to docs/v4/screens/.
//   npx playwright test -c tests/e2e/playwright.config.ts futures.spec.ts
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5188;
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

const shot = async (page: Page, name: string, fullPage = false) => {
  if (process.env.FUTURES_SHOTS !== '1') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
};
const open = async (page: Page, path = '/futures', extra = '') => {
  await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}mock=1${extra}`);
  await expect(page.getByTestId('paper-banner')).toBeVisible();
};
const mark = (page: Page, id = 'hyperliquid:BTC') => page.evaluate(async (i) => Number((await (await fetch(`/api/v1/derivatives/market?instrument=${encodeURIComponent(i)}`)).json()).ticker.mark), id);
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(String(e))); return errors; };

const SIZES = [
  { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;

for (const size of SIZES) {
  const phone = size.name === 'phone';
  test.describe(`futures terminal — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA' });
    /** on a phone the terminal is one panel at a time */
    const panel = async (page: Page, name: 'Graphique' | 'Carnet' | 'Ordre' | 'Positions') => { if (phone) await page.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click(); };
    const blotterTab = (page: Page, name: RegExp) => page.getByTestId('blotter').getByRole('tab', { name }).click();
    const fillSize = async (page: Page, v: string) => { await page.getByRole('textbox', { name: 'Taille' }).fill(v); };

    test('opens, shows live data, switches market and interval', async ({ page }) => {
      const errors = errorsOf(page);
      await open(page);
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-layout', phone ? 'phone' : 'desktop');
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
      await expect(page.getByTestId('mark-price')).toHaveText(/^\d{2}\s\d{3}/);
      await expect(page.getByTestId('market-picker')).toContainText('BTC-USD');
      await expect(page.getByTestId('ohlc')).toContainText(/O .* H .* B .* C /);
      if (!phone) await expect(page.getByTestId('venue-strip')).toContainText('données de marché seulement');   // on a phone the strip is on the Compare and Accounts views
      await shot(page, `${size.name}-01-terminal-chart`);
      await panel(page, 'Carnet');
      await expect(page.getByTestId('spread')).toContainText(/pb/);
      await expect(page.getByTestId('trades')).toBeVisible();
      await shot(page, `${size.name}-02-book`);
      // market switch through the picker (search + venue filter + favourite)
      await page.getByTestId('market-picker').click();
      const dialog = page.getByRole('dialog', { name: 'Choisir un marché' });
      await dialog.getByRole('searchbox').fill('eth');
      await dialog.getByRole('radio', { name: 'Hyperliquid' }).click();
      await dialog.getByRole('button', { name: /Ajouter ETH Hyperliquid aux favoris/ }).click();
      await expect(dialog.getByRole('button', { name: /Retirer ETH Hyperliquid des favoris/ })).toBeVisible();
      await shot(page, `${size.name}-03-market-picker`);
      await dialog.getByRole('button', { name: /^ETH-USD/ }).first().click();
      await expect(page).toHaveURL(/\/futures\/hyperliquid%3AETH/);
      await expect(page.getByTestId('market-picker')).toContainText('ETH-USD');
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('spw-fut-favs') ?? '[]'))).toContain('hyperliquid:ETH');
      // interval switch
      await panel(page, 'Graphique');
      await page.getByRole('radio', { name: '15 minutes' }).click();
      await expect(page.getByRole('radio', { name: '15 minutes' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('ohlc')).toContainText(/O \d/);
      await expect(page.getByRole('img', { name: /chandeliers de 15m/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);   // no horizontal overflow
      expect(errors).toEqual([]);
    });

    test('paper market order → position on the chart and in the blotter → close', async ({ page }) => {
      const errors = errorsOf(page);
      await open(page);
      await panel(page, 'Ordre');
      await fillSize(page, '1500');
      await page.getByRole('textbox', { name: 'Stop de protection' }).fill(String(Math.round((await mark(page)) * 0.97)));
      await expect(page.getByTestId('preview')).toContainText('Marge initiale');
      await expect(page.getByTestId('preview')).toContainText(/Prix de liquidation \(estimation\)/);
      await shot(page, `${size.name}-04-order-preview`, phone);
      await page.getByRole('button', { name: /vérifier l’ordre BTC/ }).click();
      const sheet = page.getByRole('dialog', { name: 'Confirmer l’ordre simulé' });
      await expect(sheet).toContainText('Simulation');
      await shot(page, `${size.name}-05-confirm`);
      await sheet.getByRole('button', { name: 'Placer l’ordre simulé' }).click();
      await expect(page.getByTestId('order-result')).toContainText('Ordre simulé exécuté');
      await panel(page, 'Positions');
      const blotter = page.getByTestId('blotter');
      await expect(blotter.getByRole('button', { name: 'Ouvrir le marché BTC' })).toBeVisible();
      await expect(blotter).toContainText('Long');
      await expect(blotter).toContainText(/Liquidation\s+\(estimation\)/);
      await shot(page, `${size.name}-06-position`, phone);
      await blotterTab(page, /^Ordres ouverts \(1\)/);                        // the attached stop is a separate reduce-only order
      await expect(blotter).toContainText('Stop au marché');
      await blotterTab(page, /^Exécutions/);
      await expect(blotter).toContainText('Achat');
      await blotterTab(page, /^Positions/);
      await blotter.getByRole('button', { name: 'Fermer 100 % de la position BTC' }).click();
      await expect(blotter).toContainText('Aucune position.');
      expect(errors).toEqual([]);
    });

    test('limit order: place, see it resting, cancel it', async ({ page }) => {
      await open(page);
      await panel(page, 'Ordre');
      await page.getByRole('radio', { name: 'À cours limité' }).click();
      await page.getByRole('textbox', { name: /Prix limite/ }).fill(String(Math.round((await mark(page)) * 0.985)));
      await page.getByRole('radio', { name: 'BTC', exact: true }).click();
      await fillSize(page, '0,01');
      await expect(page.getByTestId('preview')).toContainText('Valeur notionnelle');
      await page.getByRole('button', { name: /vérifier l’ordre BTC/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Placer l’ordre simulé' }).click();
      await expect(page.getByTestId('order-result')).toContainText('placé dans le carnet');
      await panel(page, 'Positions');
      const blotter = page.getByTestId('blotter');
      await blotterTab(page, /^Ordres ouverts \(1\)/);
      await expect(blotter).toContainText('ouvert');
      await shot(page, `${size.name}-07-open-order`, phone);
      await blotter.getByRole('button', { name: 'Annuler l’ordre sur BTC' }).click();
      await expect(blotter).toContainText('Aucun ordre ouvert.');
      await blotterTab(page, /^Historique/);
      await expect(blotter).toContainText('annulé');
    });

    test('a refused order says why, in plain words', async ({ page }) => {
      await open(page);
      await panel(page, 'Ordre');
      await fillSize(page, '80000');
      const refusal = page.getByTestId('risk-refusal');
      await expect(refusal).toContainText('Ordre refusé par le moteur de risque.');
      await expect(refusal).toContainText(/le levier du compte dépasserait votre limite/);
      await expect(refusal).toContainText('leverage_exceeded');
      await expect(page.getByRole('button', { name: /vérifier l’ordre BTC/ })).toBeDisabled();
      await shot(page, `${size.name}-08-refused`, phone);
    });

    test('a stale stream is shown as stale, greyed, with its age', async ({ page }) => {
      await open(page);
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
      await page.evaluate(() => window.__spwMock!.stale());
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'stale');
      await expect(page.getByTestId('freshness')).toContainText(/Données périmées · il y a \d+\s(s|min)/);
      await expect(page.getByTestId('stale-banner')).toContainText('n’est plus à jour');
      await expect(page.locator('[data-stale]').first()).toHaveClass(/grayscale/);
      await page.waitForTimeout(2200);
      await shot(page, `${size.name}-09-stale`);
      await page.evaluate(() => window.__spwMock!.reconnect());
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', /reconnecting|stale/);
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
      await expect(page.getByTestId('stale-banner')).toHaveCount(0);
    });

    test('compare view: a table and the differences, no recommendation', async ({ page }) => {
      await open(page, '/futures?v=compare');
      const view = page.getByTestId('compare-view');
      await expect(view).toContainText('Ces contrats ne sont pas interchangeables.');
      for (const v of ['Hyperliquid', 'GMX v2', 'dYdX v4']) await expect(view.getByText(v).first()).toBeVisible();
      await expect(view).toContainText('pas de carnet');
      await expect(view).toContainText('Ce qui diffère d’un contrat à l’autre');
      // nothing is recommended. (The comparator's own notice says « ni une cotation ni une recommandation »: the word in a denial is not a recommendation.)
      await expect(view.locator('text=/\\bbest\\b|recommandé|recommended|nous recommandons/i')).toHaveCount(0);
      // v8 hardening (D3): the « open this market » link of a row is a 44 × 44 target, however short the symbol
      for (const link of await view.getByTestId('compare-open').all()) { const b = await link.boundingBox(); expect(b!.width).toBeGreaterThanOrEqual(43.5); expect(b!.height).toBeGreaterThanOrEqual(43.5); }
      await shot(page, `${size.name}-10-compare`, true);
      await view.getByRole('radio', { name: 'ETH' }).last().click();   // the table's own selector (the cost comparator above it has one too since the mock serves the hub's underlyings)
      await expect(view).toContainText('Contrats perpétuels ETH par plateforme');
    });

    test('accounts: create a paper account, watch an address, live trading is off; GMX and dYdX say what they are', async ({ page }) => {
      await open(page, '/futures?v=accounts');
      const view = page.getByTestId('accounts-view');
      await expect(view.getByTestId('venue-list')).toContainText('excluent le Canada');
      await view.getByRole('button', { name: 'Nouveau compte' }).click();
      await view.getByRole('textbox', { name: 'Nom du compte' }).fill('Essai 2');
      await expect(view.getByTestId('account-form').getByRole('option', { name: /dYdX v4 — non offert/ })).toBeDisabled();
      await shot(page, `${size.name}-11-account-form`, true);
      await view.getByRole('button', { name: 'Créer le compte de simulation' }).click();
      await expect(view.getByText('Essai 2')).toBeVisible();
      await view.getByRole('textbox', { name: 'Adresse du compte' }).fill('0x3d62aa392daa9cc4cbe9e11d57681ea1371f3447');
      await view.getByRole('button', { name: 'Observer' }).click();
      await expect(view.getByTestId('watch-result')).toContainText('lecture seule');
      const live = view.getByTestId('live-card');
      await expect(live).toContainText('désactivée');
      await expect(live.getByRole('button', { name: 'Créer le compte réel' })).toBeDisabled();   // mainnet: shown, blocked by the server setting (live flows: futures-live.spec.ts)
      await shot(page, `${size.name}-12-accounts`, true);
      // GMX: no order book → liquidity panel; no paper trading
      await open(page, `/futures/${encodeURIComponent('gmx:BTC/USD [BTC-USDC]')}`);
      if (phone) await page.getByRole('tab', { name: 'Liquidité' }).click();
      await expect(page.getByTestId('gmx-liquidity')).toContainText('GMX n’a pas de carnet d’ordres');
      await shot(page, `${size.name}-13-gmx`, phone);
      await panel(page, 'Ordre');
      await expect(page.getByTestId('order-panel')).toContainText('GMX est en lecture seule');
      // a market outside the account's allowed list says so and offers to allow it (default policy: BTC and ETH only)
      await open(page, '/futures/hyperliquid%3ASOL');
      await panel(page, 'Ordre');
      await expect(page.getByTestId('not-allowed')).toContainText('SOL ne fait pas partie des marchés autorisés');
      await page.getByRole('button', { name: 'Autoriser SOL sur ce compte simulé' }).click();
      await expect(page.getByTestId('not-allowed')).toHaveCount(0);
      // dYdX: market data only, with the reason
      await open(page, '/futures/dydx%3ABTC-USD');
      await panel(page, 'Ordre');
      await expect(page.getByTestId('order-panel')).toContainText('excluent le Canada');
      await expect(page.getByTestId('order-panel').getByRole('textbox')).toHaveCount(0);
      await shot(page, `${size.name}-14-dydx`, phone);
    });

    test('language switch', async ({ page }) => {
      await open(page);
      await navTo(page, 'settings');
      await page.getByRole('radio', { name: 'English' }).click();
      await navTo(page, 'swap');
      await page.getByRole('tab', { name: 'Futures' }).click();
      await expect(page.getByTestId('paper-banner')).toContainText('live trading is not enabled');
      await expect(page.getByTestId('freshness')).toHaveText('Live', { timeout: 15_000 });
      if (phone) await page.getByRole('tab', { name: 'Trade' }).click();
      await expect(page.getByTestId('order-panel')).toContainText('Simulated order');
      await expect(page.getByTestId('order-panel')).toContainText('Paper only: nothing is sent to the venue.');
      await shot(page, `${size.name}-15-english`, phone);
    });

    test('20 book updates per second stay smooth (measurement)', async ({ page, context }) => {
      await open(page, '/futures', '&rate=20');
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
      await panel(page, 'Carnet');
      if (phone) { const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }   // a mid-range phone
      const r = await page.evaluate(async () => {
        const store = (window as unknown as { __spwStore: { perf: { events: number; commits: number; bookCommits: number } } }).__spwStore;
        const p0 = { ...store.perf }, frames: number[] = [], long: number[] = [];
        let mutations = 0;
        const mo = new MutationObserver((l) => { mutations += l.length; }); mo.observe(document.querySelector('main')!, { subtree: true, childList: true, characterData: true, attributes: true });
        const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); }); po.observe({ entryTypes: ['longtask'] });
        const t0 = performance.now(); let last = t0;
        await new Promise<void>((done) => { const f = (t: number) => { frames.push(t - last); last = t; if (t - t0 < 8000) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
        mo.disconnect(); po.disconnect();
        const sorted = [...frames].sort((a, b) => a - b), s = (performance.now() - t0) / 1000;
        return { seconds: +s.toFixed(1), streamEventsPerSec: +((store.perf.events - p0.events) / s).toFixed(1), bookCommitsPerSec: +((store.perf.bookCommits - p0.bookCommits) / s).toFixed(1), fps: +(frames.length / s).toFixed(1),
          frameP50: +sorted[Math.floor(sorted.length * 0.5)]!.toFixed(1), frameP95: +sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1), frameMax: +sorted[sorted.length - 1]!.toFixed(1),
          longTasks: long.length, longTaskMax: +(Math.max(0, ...long)).toFixed(0), domMutationsPerSec: +(mutations / s).toFixed(0) };
      });
      console.log(`[perf ${size.name}${phone ? ', CPU ×4 slower' : ''}] ${JSON.stringify(r)}`);
      test.info().annotations.push({ type: 'perf', description: JSON.stringify(r) });
      expect(r.streamEventsPerSec).toBeGreaterThan(30);        // ~20 tickers + ~20 books (+ trades) per second really arrive
      expect(r.bookCommitsPerSec).toBeLessThanOrEqual(9);      // …and the book is committed at most 8 times a second
      expect(r.frameP95).toBeLessThan(50);
    });
  });
}

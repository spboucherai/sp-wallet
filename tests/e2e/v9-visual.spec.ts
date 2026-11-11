// v9 — visual regression of the key screens and checks of the design system, on the BUILT bundle with the API replayed
// from recorded answers (tests/e2e/fixtures/v9/api.json, see v9-record-fixtures.mts): no backend, no passkey, no network,
// a frozen clock — so a picture only changes when the interface does. Thresholds are tolerant (font rasterisation differs
// between machines); the baselines live in tests/e2e/v9-visual.spec.ts-snapshots/ and are for macOS Chromium.
//
//   (cd apps/web && node_modules/.bin/vite build) && npx playwright test -c tests/e2e/playwright.config.ts v9-visual
//   … --update-snapshots      after an intended visual change (look at the new pictures before committing them)
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), PORT = 5263, BASE = process.env.V9_URL ?? `http://localhost:${PORT}`;
const FIX = JSON.parse(readFileSync(resolve(ROOT, 'tests/e2e/fixtures/v9/api.json'), 'utf8')) as { recordedAt: string; answers: Record<string, unknown> };
let server: ChildProcess | undefined;
test.beforeAll(async () => {
  if (process.env.V9_URL) return;
  server = spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' });
  for (let k = 0; k < 80; k++) { try { if ((await fetch(BASE)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('vite preview did not start (is the web app built?)');
});
test.afterAll(() => { server?.kill(); });
test.use({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-CA', timezoneId: 'America/Toronto' });

async function open(page: Page, path: string, o: { theme?: 'light' | 'dark'; authenticated?: boolean } = {}) {
  const remote: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(BASE).origin && !r.url().startsWith('data:')) remote.push(r.url()); });
  await page.clock.install({ time: new Date(FIX.recordedAt) });
  await page.addInitScript((t) => { localStorage.setItem('spw-theme', t); localStorage.setItem('spw-locale', 'fr'); }, o.theme ?? 'light');
  await page.route('**/api/v1/**', (route) => {
    const u = new URL(route.request().url()), key = u.pathname.replace('/api/v1', '') + u.search;
    if (key === '/auth/state') return route.fulfill({ json: { setupRequired: false, authenticated: o.authenticated !== false } });
    if (key.startsWith('/alerts/stream')) return route.abort();
    const hit = FIX.answers[key] ?? (key.startsWith('/market/') ? FIX.answers['/market/ETH?days=7&currency=cad'] : undefined);
    return hit !== undefined && route.request().method() === 'GET' ? route.fulfill({ json: hit }) : route.fulfill({ status: 404, json: { error: 'not_found', message: 'not in the v9 fixtures' } });
  });
  await page.goto(path);
  return { remote };
}
const settled = async (page: Page) => { await expect(page.locator('.skel')).toHaveCount(0, { timeout: 15_000 }); await page.evaluate(() => document.fonts.ready); };
const shot = (page: Page, name: string) => expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.03, threshold: 0.25, animations: 'disabled', caret: 'hide' });

for (const theme of ['light', 'dark'] as const) {
  test(`key screens look as recorded (${theme})`, async ({ page }) => {
    const { remote } = await open(page, '/', { theme });
    await expect(page.getByText('Valeur totale estimée')).toBeVisible(); await settled(page); await shot(page, `home-${theme}.png`);
    await page.getByRole('button', { name: /Tous les actifs/ }).click(); await settled(page); await shot(page, `assets-${theme}.png`);
    await page.getByRole('button', { name: 'Retour' }).click();
    await page.getByRole('button', { name: /USD Coin/ }).first().click(); await expect(page.getByText('Votre solde')).toBeVisible(); await settled(page); await shot(page, `asset-${theme}.png`);
    await page.getByRole('button', { name: 'Retour' }).click();
    await page.getByRole('main').getByRole('button', { name: 'Recevoir' }).click(); await expect(page.locator('img[alt^="QR 0x"]')).toBeVisible(); await settled(page); await shot(page, `receive-${theme}.png`);
    await page.getByRole('navigation').getByRole('button', { name: 'Envoyer' }).click(); await expect(page.getByTestId('send-steps')).toBeVisible(); await settled(page); await shot(page, `send-${theme}.png`);
    await page.getByRole('navigation').getByRole('button', { name: 'Activité' }).click(); await expect(page.getByRole('heading', { name: 'Activité' })).toBeVisible(); await settled(page); await shot(page, `activity-${theme}.png`);
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages' }).click(); await expect(page.getByRole('radio', { name: 'Français' })).toBeVisible(); await shot(page, `settings-${theme}.png`);
    expect(remote, 'no request leaves the origin (logos are self-hosted)').toEqual([]);
  });
}

test('lock screen', async ({ page }) => {
  await open(page, '/', { authenticated: false });
  await expect(page.getByRole('button', { name: /Déverrouiller/ })).toBeVisible(); await shot(page, 'gate-light.png');
});

test('logos: real files from this origin, the network badge where two deployments could be confused', async ({ page }) => {
  // v10: the app now draws after its language table arrived (the page's load event comes first), and the logo set is asked
  // for once the first paint is done — so wait for the list itself, then for every logo plate to have its image
  await open(page, '/assets'); await expect(page.getByRole('searchbox')).toBeVisible(); await settled(page);
  await page.getByRole('searchbox').fill('usdc');
  const rows = page.getByRole('main').locator('li');
  await expect(rows.first()).toBeVisible(); await settled(page);
  const info = await page.evaluate(() => Array.from(document.querySelectorAll('main li [data-asset]')).map((e) => ({ sym: e.getAttribute('data-asset'), net: e.getAttribute('data-net'), imgs: Array.from(e.querySelectorAll('img')).map((i) => ({ ok: i.complete && i.naturalWidth > 0, data: i.src.startsWith('data:image/') })) })));
  expect(info.length).toBeGreaterThan(8);
  for (const r of info) { expect(r.imgs.length, `${r.sym} on ${r.net}: logo + badge`).toBe(2); for (const i of r.imgs) expect(i, `${r.sym} on ${r.net}`).toEqual({ ok: true, data: true }); }
  expect(new Set(info.map((r) => r.net)).size).toBeGreaterThan(6);                         // one badge per network, never a bare USDC
  expect(await page.locator('main [data-fallback]').count()).toBe(0);                        // no generic disc for a registry asset
  // a coin on its home network carries no badge; the same coin elsewhere does
  await page.getByRole('searchbox').fill('ether');
  const eth = await page.evaluate(() => Array.from(document.querySelectorAll('main li [data-asset="ETH"]')).map((e) => e.getAttribute('data-net')));
  expect(eth).toContain(null); expect(eth).toContain('base'); expect(eth).toContain('bsc');
});

test('phone ergonomics: touch targets, no horizontal overflow, long French strings, reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/'); await settled(page);
  for (const path of ['/', '/assets', '/receive', '/send', '/activity', '/settings', '/security']) {
    await page.goto(path); await settled(page); await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const vw = innerWidth, small: string[] = [];
      for (const e of Array.from(document.querySelectorAll('button, a[href], select, [role=radio], [role=tab], [role=switch]'))) { const b = e.getBoundingClientRect(); if (b.width > 0 && b.height > 0 && (b.height < 43.5 || b.width < 43.5)) small.push(`${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)} ${Math.round(b.width)}×${Math.round(b.height)}`); }
      return { overflow: document.documentElement.scrollWidth > vw, small, animated: getComputedStyle(document.querySelector('.hero') ?? document.body, '::before').animationName };
    });
    expect(r.overflow, `${path}: horizontal overflow`).toBe(false);
    expect(r.small, `${path}: targets under 44 px`).toEqual([]);
    expect(['none', undefined]).toContain(r.animated === 'none' ? 'none' : path === '/' ? r.animated : 'none');
  }
});

test('the header condenses on scroll and the tab bar keeps its five entries', async ({ page }) => {
  await open(page, '/'); await settled(page);
  await expect(page.getByRole('navigation').getByRole('button')).toHaveText(['Accueil', 'Échanger', 'Envoyer', 'Activité', 'Réglages']);
  await expect(page.locator('header.app-header')).not.toHaveAttribute('data-scrolled', '');
  await page.evaluate(() => scrollTo(0, 400));
  await expect(page.locator('header.app-header')).toHaveAttribute('data-scrolled', '');
  await expect(page.getByTestId('allocation')).toBeVisible();
  await expect(page.getByTestId('allocation').getByRole('img')).toHaveAttribute('aria-label', /USDC \d+ %, ETH \d+ %/);
});

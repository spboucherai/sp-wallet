// v10 — visual regression of the screens of the SECOND design pass (Swap, agents, alerts, system status, research) and
// checks of what the pass added to the shell (large-title collapse, lazily loaded screens, one language at a time), on the
// BUILT bundle with the API replayed from recorded answers (tests/e2e/fixtures/v10/api.json — v10-record-fixtures.mts):
// no backend, no passkey, no network, a frozen clock. Same method and tolerances as v9-visual.spec.ts; baselines in
// tests/e2e/v10-visual.spec.ts-snapshots/ (macOS Chromium).
// The Futures terminal is not here: it only has data in the development mock, whose prices move — its screens are checked
// by behaviour (futures*.spec.ts) and shown in docs/v10/screens/.
//
//   (cd apps/web && node_modules/.bin/vite build) && npx playwright test -c tests/e2e/playwright.config.ts v10-visual
//   … --update-snapshots      after an intended visual change (look at the new pictures before committing them)
import { navTo } from './v11-helpers.ts';   // v11 interface: the shell's navigation (five areas, header menu)
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), PORT = 5264, BASE = process.env.V10_URL ?? `http://localhost:${PORT}`;
const FIX = JSON.parse(readFileSync(resolve(ROOT, 'tests/e2e/fixtures/v10/api.json'), 'utf8')) as { recordedAt: string; agent: string; answers: Record<string, unknown> };
const V9 = (JSON.parse(readFileSync(resolve(ROOT, 'tests/e2e/fixtures/v9/api.json'), 'utf8')) as { answers: Record<string, unknown> }).answers;
let server: ChildProcess | undefined;
test.beforeAll(async () => {
  if (process.env.V10_URL) return;
  server = spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' });
  for (let k = 0; k < 80; k++) { try { if ((await fetch(BASE)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('vite preview did not start (is the web app built?)');
});
test.afterAll(() => { server?.kill(); });
test.use({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-CA', timezoneId: 'America/Toronto' });

async function open(page: Page, path: string, o: { theme?: 'light' | 'dark'; locale?: 'fr' | 'en' } = {}) {
  const remote: string[] = [], scripts: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== new URL(BASE).origin && !r.url().startsWith('data:')) remote.push(r.url()); if (u.pathname.startsWith('/assets/') && u.pathname.endsWith('.js')) scripts.push(u.pathname.replace(/^\/assets\//, '').replace(/-[A-Za-z0-9_-]{8}\.js$/, '')); });
  await page.clock.install({ time: new Date(FIX.recordedAt) });
  await page.addInitScript(([t, l]) => { localStorage.setItem('spw-theme', t!); localStorage.setItem('spw-locale', l!); }, [o.theme ?? 'light', o.locale ?? 'fr']);
  await page.route('**/api/v1/**', (route) => {
    const u = new URL(route.request().url()), key = u.pathname.replace('/api/v1', '') + u.search;
    if (key.startsWith('/alerts/stream') || key.includes('/stream')) return route.abort();
    const hit = FIX.answers[key] ?? V9[key];
    return hit !== undefined && route.request().method() === 'GET' ? route.fulfill({ json: hit }) : route.fulfill({ status: 404, json: { error: 'not_found', message: 'not in the v10 fixtures' } });
  });
  await page.goto(path);
  return { remote, scripts };
}
const settled = async (page: Page) => { await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 15_000 }); await expect(page.locator('.skel')).toHaveCount(0, { timeout: 15_000 }); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(250); };
const shot = (page: Page, name: string) => expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.03, threshold: 0.25, animations: 'disabled', caret: 'hide' });
const SCREENS: [string, string][] = [['swap', '/swap'], ['agents', '/agents'], ['agent', `/agents/${FIX.agent}`], ['alerts', '/alerts'], ['alerts-settings', '/alerts?v=settings'], ['monitor', '/monitor'], ['research', '/research']];

for (const theme of ['light', 'dark'] as const) {
  test(`screens of the second pass look as recorded (${theme})`, async ({ page }) => {
    const { remote } = await open(page, '/swap', { theme });
    for (const [name, path] of SCREENS) {
      if (path !== '/swap') await page.goto(path);
      await settled(page); await shot(page, `${name}-${theme}.png`);
    }
    expect(remote, 'no request leaves the origin').toEqual([]);
  });
}

test('phone ergonomics of the second pass: targets ≥ 44 px, no horizontal overflow, reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/swap');
  for (const [name, path] of SCREENS) {
    await page.goto(path); await settled(page);
    const r = await page.evaluate(() => {
      const vw = innerWidth, small: string[] = [];
      for (const e of Array.from(document.querySelectorAll('main button, main a[href], main select, main summary, main [role=radio], main [role=tab], main [role=switch]'))) { const b = e.getBoundingClientRect(); if (b.width > 0 && b.height > 0 && (b.height < 43.5 || b.width < 43.5)) small.push(`${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)} ${Math.round(b.width)}×${Math.round(b.height)}`); }
      return { overflow: document.documentElement.scrollWidth > vw, small };
    });
    expect(r.overflow, `${name}: horizontal overflow`).toBe(false);
    expect(r.small, `${name}: targets under 44 px`).toEqual([]);
  }
});

test('large title: it collapses into the header once it has scrolled under it, and comes back', async ({ page }) => {
  await open(page, `/agents/${FIX.agent}`); await settled(page);
  const header = page.locator('header.app-header'), mini = page.getByTestId('mini-title');
  await expect(header).not.toHaveAttribute('data-titled', '');
  const title = (await page.locator('main h1.t-title').first().textContent())!.trim();
  await page.evaluate(() => scrollTo(0, 500));
  await expect(header).toHaveAttribute('data-titled', '');
  await expect(mini).toHaveText(title);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(header).not.toHaveAttribute('data-titled', '');
});

test('first load: only the first screen\'s code and ONE language; the other screens arrive when idle or when opened', async ({ page }) => {
  const { scripts } = await open(page, '/');
  await expect(page.getByText('Valeur totale estimée')).toBeVisible();
  const first = [...scripts];
  expect(first.some((s) => s.includes('spw-i18n-fr'))).toBe(true);
  expect(first.some((s) => s.includes('spw-i18n-en')), 'the English table is not fetched on a French screen').toBe(false);
  for (const s of ['Swap', 'Agents', 'Futures', 'Research', 'Send', 'Security']) expect(first, `${s} is not part of the first load`).not.toContain(s);
  // opened: the screen's own chunk comes, and the screen is there
  await navTo(page, 'swap');
  await expect(page.getByRole('heading', { name: 'Échanger' })).toBeVisible();
  expect(scripts).toContain('Swap');
  // a change of language fetches the other table, then takes effect
  await navTo(page, 'settings');
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  expect(scripts.some((s) => s.includes('spw-i18n-en'))).toBe(true);
});

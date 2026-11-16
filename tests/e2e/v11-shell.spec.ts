// V11 interface — the shell: five areas (phone tab bar and desktop sidebar), their sub-views, the risk indicator that is on
// every screen, the header menu, the old paths that still open their screen. Real local stack (see v11-helpers.ts).
//   tests/e2e/ui-stack.sh ui 8840 && SPW_E2E_BASE=http://localhost:8840 SPW_DEV_DIR=/tmp/spw-ui-ui pnpm e2e v11-shell.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { deviceUse, expectNoOverflow, MATRIX, openWallet, SHOTS } from './v11-helpers.ts';

const W = {
  fr: { areas: ['Accueil', 'Marchés', 'Négocier', 'Agents', 'Activité'], markets: ['Explorer', 'Comparer', 'Marchés privés'], trade: ['Au comptant', 'Contrats à terme'], menu: 'Menu', settings: 'Réglages', risk: /Risque/, lock: 'Verrouiller', unlock: /Déverrouiller/ },
  en: { areas: ['Home', 'Markets', 'Trade', 'Agents', 'Activity'], markets: ['Explore', 'Compare', 'Private markets'], trade: ['Spot', 'Futures'], menu: 'Menu', settings: 'Settings', risk: /Risk/, lock: 'Lock', unlock: /Unlock/ },
} as const;
const path = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;

for (const { device, lang } of MATRIX) {
  test.describe(`shell · ${device} · ${lang}`, () => {
    test.use(deviceUse(device, lang));
    test('five areas, sub-views, risk indicator, menu, old paths', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      const w = W[lang], nav = page.getByTestId(device === 'phone' ? 'nav-tabbar' : 'nav-areas');
      // exactly five entries, in the same order on both devices
      await expect(nav.getByRole('button')).toHaveText([...w.areas]);
      await expect(nav.locator('[data-area=home]')).toHaveAttribute('aria-current', 'page');
      await expectNoOverflow(page, 'home');

      // Markets: explorer, compare and private markets are sub-views of ONE area
      await nav.locator('[data-area=markets]').click();
      await expect(page.getByTestId('markets')).toBeVisible({ timeout: 20_000 });
      expect(path(page)).toBe('/markets');
      const sub = page.getByTestId('nav-sub');
      await expect(sub.getByRole('tab')).toHaveText([...w.markets]);
      await sub.locator('[data-sub=compare]').click();
      await expect.poll(() => path(page)).toContain('/markets?v=compare');
      await expect(nav.locator('[data-area=markets]')).toHaveAttribute('aria-current', 'page');
      await sub.locator('[data-sub=private]').click();
      await expect.poll(() => path(page)).toBe('/private-markets');
      await expect(nav.locator('[data-area=markets]')).toHaveAttribute('aria-current', 'page');
      await expect(sub.locator('[data-sub=private]')).toHaveAttribute('aria-selected', 'true');
      await expectNoOverflow(page, 'private markets');

      // Trade: spot and the terminal are sub-views; the area reopens where it was left
      await nav.locator('[data-area=trade]').click();
      await expect.poll(() => path(page)).toBe('/swap');
      await expect(page.getByTestId('nav-sub').getByRole('tab')).toHaveText([...w.trade]);
      await page.getByTestId('nav-sub').locator('[data-sub=futures]').click();
      await expect(page.getByTestId('terminal')).toBeVisible({ timeout: 30_000 });
      await expect(nav.locator('[data-area=trade]')).toHaveAttribute('aria-current', 'page');
      await nav.locator('[data-area=agents]').click();
      await expect.poll(() => path(page)).toBe('/agents');
      await nav.locator('[data-area=trade]').click();
      await expect.poll(() => path(page)).toMatch(/^\/futures/);                     // where Trade was left
      await page.getByTestId('nav-sub').locator('[data-sub=swap]').click();
      await expect.poll(() => path(page)).toBe('/swap');
      await nav.locator('[data-area=activity]').click();
      await expect(page.getByTestId('activity')).toBeVisible({ timeout: 20_000 });

      // the risk indicator is on every screen and opens Risk
      const pill = page.getByTestId('risk-indicator').locator('visible=true');
      await expect(pill).toHaveAttribute('data-level', /^(ok|limits)$/, { timeout: 15_000 });
      await expect(pill).toHaveAccessibleName(w.risk);
      await pill.click();
      await expect(page.getByTestId('risk')).toBeVisible({ timeout: 20_000 });
      expect(path(page)).toBe('/risk');

      // settings, security, developer, system status: the header menu on a phone, the sidebar on a desktop
      if (device === 'phone') {
        await page.getByTestId('nav-menu').click();
        const sheet = page.getByTestId('nav-menu-sheet');
        for (const id of ['receive', 'send', 'risk', 'alerts', 'settings', 'security', 'developer', 'monitor', 'research', 'lock']) await expect(sheet.locator(`[data-menu=${id}]`)).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/v11-shell-menu-${device}-${lang}.png` });
        await sheet.locator('[data-menu=developer]').click();
        await expect.poll(() => path(page)).toBe('/developer');
        await page.getByTestId('nav-menu').click();
        await page.getByTestId('nav-menu-sheet').locator('[data-menu=settings]').click();
      } else await page.getByRole('navigation').getByRole('button', { name: w.settings, exact: true }).click();
      await expect.poll(() => path(page)).toBe('/settings');

      // old and area paths still open their screen
      for (const [from, to] of [['/trade', /^\/(swap|futures)/], ['/dashboard', /^\/$/], ['/compare', /^\/markets\?v=compare/], ['/futures?v=accounts', /^\/futures\?v=accounts/], ['/monitor', /^\/monitor$/], ['/research', /^\/research$/], ['/security', /^\/security$/], ['/assets', /^\/assets$/]] as const) {
        await page.goto(from);
        await expect(page.locator('main')).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => path(page)).toMatch(to);
      }
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    if (device === 'phone') test('no horizontal overflow from 320 to 430 px on the screens of the five areas', async ({ page, context, baseURL }) => {
      test.setTimeout(240_000);
      const s = await openWallet(page, context, baseURL, { lang });
      for (const width of [320, 360, 430]) {
        await page.setViewportSize({ width, height: 800 });
        for (const p of ['/', '/markets', '/markets?v=compare', '/private-markets', '/swap', '/futures', '/agents', '/activity', '/risk', '/settings', '/developer', '/monitor']) {
          // in-app navigation (the API limits a client to 240 requests a minute, static files included: 36 full page loads would exceed it)
          await page.evaluate((to) => { history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')); }, p);
          await expect(page.locator('main h1, main [data-testid=home]').first()).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(700);
          if (width === 320) await page.screenshot({ path: `${SHOTS}/v11-shell-320${p.replace(/[/?=]/g, '-')}-${lang}.png` });
          await expectNoOverflow(page, `${p} @ ${width}`);
          // the header never wraps: brand, risk indicator, alerts, menu on one row
          const h = await page.locator('header.app-header').boundingBox();
          expect(h!.height, `header height at ${width} on ${p}`).toBeLessThan(72);
        }
      }
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });
  });
}

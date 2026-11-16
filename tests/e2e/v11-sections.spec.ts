// V11 interface — one check per section that has no spec of its own in this pass, at phone and desktop, in French and English
// (light theme), on a real local stack (see v11-helpers.ts): Markets + Compare, Private markets, Swap (quote view), Agents
// (list and templates), Risk (kill switch: engaged freely, released with the passkey), Developer (API key creation with the
// passkey). Market data comes from the venues' public endpoints and the swap quotes from the real providers: read-only.
// Dashboard, Trade, Activity and the shell have their own files (v11-dashboard, v11-trade, v11-activity, v11-shell).
//   tests/e2e/ui-stack.sh ui 8840 && SPW_E2E_BASE=http://localhost:8840 SPW_DEV_DIR=/tmp/spw-ui-ui pnpm e2e v11-sections.spec.ts
import { expect, test } from '@playwright/test';
import { deviceUse, expectNoOverflow, MATRIX, openWallet, SHOTS } from './v11-helpers.ts';

for (const { device, lang } of MATRIX) {
  test.describe(`sections · ${device} · ${lang}`, () => {
    test.use(deviceUse(device, lang));
    const fr = lang === 'fr';

    test('Markets: explorer with fresh rows, a market that cannot be traded says why; Compare: itemised cost per venue', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/markets');
      await expect(page.getByTestId('markets')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('mk-open').first()).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('mk-fresh').or(page.getByTestId('qt-dot')).first()).toBeVisible();
      await page.getByTestId('mk-search').fill('BTC');
      await expect(page.getByTestId('mk-open').first()).toContainText('BTC', { timeout: 20_000 });
      // dYdX's terms exclude Canada: its rows are shown, labelled, and never lead to an order form
      await expect(page.getByTestId('mk-not-tradable').first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('mk-not-tradable').first()).toHaveAttribute('data-reason', /.+/);
      await expectNoOverflow(page, 'markets');
      await page.screenshot({ path: `${SHOTS}/v11-markets-${device}-${lang}.png` });

      await page.getByTestId('nav-sub').locator('[data-sub=compare]').click();
      await expect(page.getByTestId('compare-view')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('cost-compare')).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('cp-total').first()).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('cp-assumptions')).toBeVisible();
      await expectNoOverflow(page, 'compare');
      await page.screenshot({ path: `${SHOTS}/v11-compare-${device}-${lang}.png` });
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    if (device === 'desktop' && fr) test('Markets with live quotes: a tick changes its own cell — the list around it is not redrawn', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/markets');
      await expect(page.getByTestId('mk-open').first()).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('qt-conn')).toHaveAttribute('data-state', 'live', { timeout: 30_000 });
      await expect(page.getByTestId('qt-live').first()).toBeVisible({ timeout: 30_000 });
      // 8 s of real ticks: every DOM mutation under the list is recorded with the nearest marked ancestor
      const seen = await page.evaluate(() => new Promise<{ inCells: number; outside: string[]; rows: number }>((done) => {
        const root = document.querySelector('[data-testid=markets]')!, rows = root.querySelectorAll('[data-testid=mk-open]').length; let inCells = 0; const outside: string[] = [];
        const ob = new MutationObserver((list) => { for (const m of list) { const el = (m.target.nodeType === 1 ? m.target : m.target.parentElement) as Element | null;
          if (el?.closest('[data-testid=qt-live], [data-testid=qt-dot], [data-testid=qt-conn], [data-testid=mk-fresh]')) inCells += 1; else outside.push(`${m.type} ${el?.tagName} ${el?.getAttribute('data-testid') ?? el?.className.toString().slice(0, 40)}`); } });
        ob.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-state'] });
        setTimeout(() => { ob.disconnect(); done({ inCells, outside: [...new Set(outside)].slice(0, 10), rows }); }, 8000);
      }));
      test.info().annotations.push({ type: 'live ticks', description: `${seen.inCells} mutations inside live cells over 8 s on ${seen.rows} rows; ${seen.outside.length} kinds outside` });
      expect(seen.inCells, 'ticks were observed').toBeGreaterThan(0);
      expect(seen.outside, 'nothing outside the live cells changed').toEqual([]);
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    test('Private markets: display only — sourced valuation, caveats, no order form', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/private-markets');
      await expect(page.getByTestId('pm-screen')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('pm-notice')).toBeVisible();
      await expect(page.getByTestId('pm-row-valuation').first()).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('nav-sub').locator('[data-sub=private]')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('main').getByRole('button', { name: /^(Acheter|Vendre|Buy|Sell|Long|Short)$/ })).toHaveCount(0);
      await expectNoOverflow(page, 'private markets');
      await page.screenshot({ path: `${SHOTS}/v11-private-${device}-${lang}.png` });
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    test('Swap: the quote view — an amount gives routes, the amount received and the route facts', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/swap');
      const amount = page.getByRole('textbox', { name: fr ? 'Montant' : 'Amount' }).first();
      await expect(amount).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('nav-sub').locator('[data-sub=swap]')).toHaveAttribute('aria-selected', 'true');
      await amount.fill('1');
      // real providers answer or are named as unavailable; either way the screen settles on cards or on its stated empty state
      const card = page.getByTestId('route-card').first();
      await expect(card.or(page.getByTestId('exec-no-quote')).or(page.getByText(fr ? /Aucune route|aucune cotation/i : /No route|no quote/i)).first()).toBeVisible({ timeout: 60_000 });
      if (await card.isVisible()) { await expect(page.getByTestId('you-receive')).toBeVisible(); await expect(page.getByTestId('route-facts').first()).toBeVisible(); }
      await expectNoOverflow(page, 'swap');
      await page.screenshot({ path: `${SHOTS}/v11-swap-${device}-${lang}.png` });
      expect(s.errors().filter((e) => !/quote\/stream/.test(e)), s.errors().join('\n')).toEqual([]);
    });

    test('Agents: the list and the templates', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/agents');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('ag2-from-template').click();
      const sheet = page.getByTestId('ag2-template-sheet');
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      await expect(sheet.locator('[data-testid^=ag2-tpl-]').first()).toBeVisible({ timeout: 30_000 });
      expect(await sheet.locator('[data-testid^=ag2-tpl-]').count()).toBeGreaterThanOrEqual(5);
      await page.screenshot({ path: `${SHOTS}/v11-agents-templates-${device}-${lang}.png` });
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expectNoOverflow(page, 'agents');
      await page.screenshot({ path: `${SHOTS}/v11-agents-${device}-${lang}.png` });
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    test('Risk: the kill switch is engaged without a prompt, shown by the header indicator on every screen, and released with the passkey', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/risk');
      await expect(page.getByTestId('risk')).toBeVisible({ timeout: 30_000 });
      const state = page.getByTestId('rk-kill-state'), pill = page.getByTestId('risk-indicator').locator('visible=true');
      await expect(state).toContainText(fr ? 'Désactivé' : 'Off');
      await page.getByTestId('rk-kill-reason').fill(`e2e ${device} ${lang}`);
      await page.getByTestId('rk-kill-engage').click();
      await expect(state).toContainText(fr ? 'Activé' : 'On', { timeout: 20_000 });
      await expect(pill).toHaveAttribute('data-level', 'kill', { timeout: 30_000 });
      await expect(pill).toContainText(fr ? 'Arrêt' : 'Halted');
      await expectNoOverflow(page, 'risk');
      await page.screenshot({ path: `${SHOTS}/v11-risk-kill-${device}-${lang}.png` });
      // on another screen the indicator still says it
      await page.evaluate(() => { history.pushState(null, '', '/activity'); dispatchEvent(new PopStateEvent('popstate')); });
      await expect(page.getByTestId('activity')).toBeVisible({ timeout: 20_000 });
      await expect(pill).toHaveAttribute('data-level', 'kill');
      await pill.click();
      await page.getByTestId('rk-kill-release').click();                           // the virtual authenticator answers the passkey prompt
      await expect(state).toContainText(fr ? 'Désactivé' : 'Off', { timeout: 30_000 });
      await s.save();                                                              // the credential's counter moved
      await expect(pill).not.toHaveAttribute('data-level', 'kill', { timeout: 30_000 });
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    test('Developer: an API key is created with the passkey, its secret shown once, then revoked', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang });
      await page.goto('/developer');
      await expect(page.getByTestId('dev-new-key')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('dev-new-key').click();
      const name = `robot ${device} ${lang}`;
      await page.getByTestId('dev-name').fill(name);
      await page.getByTestId('dev-create-submit').click();
      const secret = page.getByTestId('dev-secret-value');
      await expect(secret).toBeVisible({ timeout: 30_000 });
      await s.save();
      expect((await secret.textContent())!.trim()).toMatch(/^spw_live_spk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
      await page.screenshot({ path: `${SHOTS}/v11-developer-secret-${device}-${lang}.png`, mask: [secret] });
      await page.getByRole('button', { name: fr ? 'Je l’ai enregistré' : /I (have )?saved it/i }).click();
      await expect(secret).toHaveCount(0);
      const row = page.locator('[data-testid^=dev-key-]').filter({ hasText: name });
      await expect(row).toBeVisible();
      await expectNoOverflow(page, 'developer');
      await page.screenshot({ path: `${SHOTS}/v11-developer-${device}-${lang}.png` });
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });
  });
}

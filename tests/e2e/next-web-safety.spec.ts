// NEXT W3 / W4 / W5 and the behavioural accessibility fixes, on a real local stack (session, portfolio, networks are real;
// failures are provoked with `page.route`):
//
//   tests/e2e/ui-stack.sh websafety 8790
//   SPW_E2E_BASE=http://localhost:8790 SPW_DEV_DIR=/tmp/spw-ui-websafety pnpm e2e next-web-safety.spec.ts
import { expect, test } from '@playwright/test';
import { roomInRateLimit } from './qa-helpers.ts';
import { openWallet } from './v11-helpers.ts';

test.describe.configure({ mode: 'serial' });

test('unknown asset / network in the address → « not found », not a skeleton for ever; back goes where the owner came from', async ({ page, context, baseURL }) => {
  await openWallet(page, context, baseURL);
  await page.goto('/asset/base/0x000000000000000000000000000000000000dEaD');
  await expect(page.getByTestId('asset-not-found')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Actif introuvable')).toBeVisible();
  await page.goto('/asset/no-such-network/native');
  await expect(page.getByTestId('asset-not-found')).toBeVisible({ timeout: 60_000 });
  await page.goto('/receive?n=no-such-network');
  await expect(page.getByTestId('receive-not-found')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('radio', { name: 'Solana' }).click();
  await expect(page.locator('img[alt^="QR "]')).toBeVisible();
  // back: from the asset list to an asset and back to the LIST (it used to go Home)
  await page.goto('/assets');
  await page.getByRole('searchbox').fill('usd coin');
  await page.getByRole('button', { name: /USD Coin/ }).first().click();
  await expect(page.getByText('Votre solde')).toBeVisible();
  await page.getByTestId('asset-back').click();
  await expect(page.getByRole('searchbox')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/assets');
});

test('portfolio: a first load that fails is an error with a retry; a refresh that fails keeps the values and says since when', async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await openWallet(page, context, baseURL);
  let fail = true;
  await page.route('**/api/v1/portfolio', (route) => (fail ? route.abort('failed') : route.fallback()));
  await page.goto('/');
  await expect(page.locator('[data-testid="home"][data-state="error"]')).toBeVisible({ timeout: 60_000 });
  await page.goto('/assets'); await expect(page.getByTestId('assets-error')).toBeVisible({ timeout: 60_000 });
  fail = false;
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByRole('searchbox')).toBeVisible({ timeout: 60_000 });
  await roomInRateLimit(page, 100);   // NEXT: the dashboard reads more routes per load (history, preferences, movements, contacts, events) — the limiter (240 a minute) needs room for this fourth reload
  await page.goto('/');
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('balances-at')).toContainText(/Soldes lus à/);
  await expect(page.getByTestId('stale-banner')).toHaveCount(0);
  // the refresh fails (one retry): the total stays, the banner says since when. NEXT: with the wallet event stream connected the
  // timed re-read is a slow fallback (90 s); coming back to the tab re-reads at once, as it always did — that is what is provoked here
  fail = true;
  await page.waitForTimeout(6000);   // past the 5 s during which a reading counts as fresh
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); });
  await expect(page.getByTestId('stale-banner')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('stale-banner')).toContainText(/Pas à jour depuis/);
  await expect(page.getByText('Valeur totale estimée')).toBeVisible();
  fail = false;
  await page.getByTestId('stale-banner').getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByTestId('stale-banner')).toHaveCount(0, { timeout: 30_000 });
});

test('a network whose balance is unavailable → the total is labelled partial; signer unreachable → send disabled with its reason, everywhere', async ({ page, context, baseURL }) => {
  test.setTimeout(300_000);   // NEXT: with request interception the browser cache is off, every reload re-reads every file — the limiter (240 a minute) makes this test wait
  await openWallet(page, context, baseURL);
  await page.route('**/api/v1/portfolio', async (route) => {
    const r = await route.fetch(), j = await r.json();
    for (const b of j.balances) if (b.network === 'solana') { b.amount = null; b.display = null; b.error = 'unavailable'; }
    j.signer = { reachable: false, addressesAsOf: new Date().toISOString() }; j.halted = null;
    await route.fulfill({ response: r, json: j });
  });
  await page.goto('/');
  await expect(page.getByTestId('partial-note')).toContainText('Solana', { timeout: 60_000 });
  await expect(page.getByTestId('send-blocked')).toContainText(/signataire est injoignable/);
  await expect(page.getByRole('main').getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await roomInRateLimit(page, 100);   // NEXT: more routes are read per load — room for the two reloads that follow
  await page.goto('/asset/base/native');
  await expect(page.getByTestId('asset-send')).toBeDisabled({ timeout: 60_000 }); await expect(page.getByTestId('send-blocked')).toBeVisible();
  await roomInRateLimit(page, 100);
  await page.goto('/send');
  await expect(page.getByTestId('send-blocked')).toBeVisible({ timeout: 60_000 });
  await page.locator('textarea').fill('0x1111111111111111111111111111111111111111'); await page.getByPlaceholder('0.00').fill('0.01');
  await expect(page.getByTestId('send-review')).toBeDisabled();
});

test('sheet: focus goes in, Tab stays in, the background is inert, Escape closes and the focus comes back; arrow keys in a chip group; version from the build', async ({ page, context, baseURL }) => {
  await openWallet(page, context, baseURL);
  await page.goto('/');
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 60_000 });
  const menu = page.getByTestId('nav-menu');
  await menu.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => !!document.querySelector('#main')?.closest('[inert]'))).toBe(true);
  for (let k = 0; k < 25; k++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true); }
  await page.keyboard.press('Shift+Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('nav-menu');
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);

  await page.goto('/receive');
  const checked = page.getByRole('radio', { checked: true });
  await expect(checked).toHaveCount(1, { timeout: 60_000 });
  const first = await checked.getAttribute('aria-label') ?? await checked.innerText();
  await checked.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(1);
  expect(await page.getByRole('radio', { checked: true }).innerText()).not.toBe(first);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked'))).toBe('true');   // the selection followed the focus
  await page.keyboard.press('ArrowLeft');
  expect(await page.getByRole('radio', { checked: true }).innerText()).toBe(first);

  await page.goto('/settings');
  await expect(page.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+ \([0-9a-f]{7}\)$/, { timeout: 60_000 });
});

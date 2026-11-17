import { navTo } from './v11-helpers.ts';   // v11 interface: the shell's navigation (five areas, header menu)
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// GMX v2 trading (v8) in a browser, against the in-browser mock (`?mock=1&gmx=<scenario>`, development build only): no backend,
// no chain, no keeper, no signer, a simulated passkey — apps/web/src/derivatives/mockGmx.ts says what it is (time stands in for
// the network; the shapes are those of docs/v4/API-LIVE-NOTES.md, "GMX v2 trading (v8)"). What this spec checks is the SCREEN:
// that a closed lock is explained (a server setting is named and said not to be changeable from the app), what is shown before
// each passkey prompt (the acknowledgement and the policy; the signed fields AND the ones the signer fixes), that a `created`
// order is never called executed, that « garantie revenue au portefeuille » appears only when the server saw it come back, and
// that the owner's cancel waits for the delay.
//   npx playwright test -c tests/e2e/playwright.config.ts futures-gmx.spec.ts        (FUTURES_SHOTS=1 writes docs/v8/screens/gmx-*.png)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5193;
const BASE = process.env.FUTURES_URL ?? `http://localhost:${PORT}`;
const SHOTS = resolve(ROOT, 'docs/v8/screens');
const ETH = 'gmx:ETH/USD [WETH-USDC]', BTC = 'gmx:BTC/USD [BTC-USDC]';
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

const gmx = (page: Page, name: string, ...args: unknown[]) => page.evaluate(([n, a]) => (window as any).__spwMock.gmx[n as string](...(a as unknown[])), [name, args] as const);
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message)); return errors; };

for (const size of [
  { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const) {
  test.describe(`futures GMX — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA' });
    const phone = size.name === 'phone';
    const shot = async (page: Page, name: string, fullPage = false) => { if (process.env.FUTURES_SHOTS !== '1') return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/gmx-${phone ? '' : 'desktop-'}${name}.png`, fullPage }); };
    const panel = async (page: Page, name: 'Ordre' | 'Positions') => { if (phone) await page.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click(); };
    const terminal = async (page: Page, instrument: string, scenario: string) => { await page.goto(`${BASE}/futures/${encodeURIComponent(instrument)}?mock=1&gmx=${scenario}`); await expect(page.getByTestId('terminal')).toBeVisible(); };
    const accounts = async (page: Page, scenario: string) => { await page.goto(`${BASE}/futures?v=accounts&mock=1&gmx=${scenario}`); await expect(page.getByTestId('gmx-card')).toBeVisible(); return page.getByTestId('gmx-card'); };
    /** fills the order panel (25 USDC × 2) and opens the confirm sheet, checked field by field */
    const review = async (page: Page) => {
      await panel(page, 'Ordre');
      const op = page.getByTestId('gmx-order-panel');
      await expect(op).toBeVisible();
      await op.getByTestId('gmx-collateral').fill('25');
      await expect(op.getByTestId('gmx-preview')).toHaveAttribute('data-ready', '1');
      await expect(op.getByTestId('gmx-verdict')).toHaveAttribute('data-ok', '1');
      await op.getByTestId('gmx-review').click();
      const sheet = page.getByTestId('gmx-confirm');
      await expect(sheet).toHaveAttribute('data-phase', 'ready');
      return sheet;
    };

    test('settings off: the card names the server setting, says it cannot be changed from the app; no order panel', async ({ page }) => {
      const errors = errorsOf(page), card = await accounts(page, 'off');
      await expect(card).toHaveAttribute('data-tradable', '0');
      await expect(card.getByTestId('gmx-account')).toContainText('Le compte est l’adresse du portefeuille');
      await expect(card.getByTestId('gmx-wallet')).toContainText('250,00 USDC');
      const off = card.locator('[data-testid="gmx-blocker"][data-code="gmx_setting_off"]');
      await expect(off).toContainText('SPW_DERIV_GMX_LIVE');
      await expect(off.getByTestId('gmx-setting-note')).toContainText('C’est un réglage du serveur : il ne peut pas être changé depuis l’application');
      await expect(card.locator('[data-testid="gmx-blocker"][data-code="mainnet_setting_off"]')).toContainText('SPW_DERIV_LIVE_MAINNET');
      await expect(card.getByTestId('gmx-setting-gmx')).toHaveText('désactivé');
      await expect(card.getByTestId('gmx-authorize-open')).toHaveCount(0);       // a server setting is not lifted by the owner's passkey
      await expect(card.getByTestId('mode-band')).toHaveCount(0);
      await card.getByTestId('gmx-blockers').scrollIntoViewIfNeeded();
      await shot(page, 'locked-setting');
      // the terminal: the reason, and no GMX order panel; positions are still read from the chain
      await terminal(page, ETH, 'off');
      await panel(page, 'Ordre');
      await expect(page.getByTestId('gmx-locked')).toContainText('SPW_DERIV_GMX_LIVE');
      await expect(page.getByTestId('gmx-order-panel')).toHaveCount(0);
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'paper');
      await shot(page, 'locked-terminal');
      // the server refuses too, whatever the screen does
      const refused = await page.evaluate(async () => { const r = await fetch('/api/v1/derivatives/gmx/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-12345678' }, body: '{}' }); return { status: r.status, ...(await r.json()) }; });
      expect(refused).toMatchObject({ status: 403, error: 'gmx_disabled' });
      // one setting on, the other off: still closed, and it says which
      await gmx(page, 'scenario', 'mainnet-off');
      await expect(page.getByTestId('gmx-locked').locator('[data-code="gmx_setting_off"]')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId('gmx-locked').locator('[data-code="mainnet_setting_off"]')).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('authorization: policy form → acknowledgement that must be read → passkey → tradable; revoke without passkey', async ({ page }) => {
      const errors = errorsOf(page), card = await accounts(page, 'on');
      await expect(card.locator('[data-testid="gmx-blocker"][data-code="not_authorized"]')).toBeVisible();
      await card.getByTestId('gmx-authorize-open').click();
      const sheet = page.getByTestId('gmx-authorize');
      await sheet.getByTestId('gmx-auth-leverage').fill('25');
      await expect(sheet.getByTestId('gmx-auth-problem')).toHaveAttribute('data-problem', 'leverage');
      await expect(sheet.getByTestId('gmx-auth-prepare')).toBeDisabled();
      await sheet.getByTestId('gmx-auth-leverage').fill('4');
      await sheet.getByTestId('gmx-auth-order').fill('200');
      await sheet.getByTestId('gmx-auth-perday').fill('8');
      await sheet.getByTestId('gmx-auth-band').fill('150');
      await sheet.getByTestId('gmx-auth-days').fill('14');
      await sheet.getByTestId('gmx-auth-market-BTC').uncheck();
      await sheet.getByTestId('gmx-auth-prepare').click();
      await expect(sheet).toHaveAttribute('data-step', 'review');
      await expect(sheet.getByTestId('gmx-ack-text')).toContainText('Vous êtes seul responsable');
      const policy = sheet.getByTestId('gmx-auth-policy');
      await expect(policy).toContainText('ETH/USD [WETH-USDC]'); await expect(policy).not.toContainText('BTC/USD');
      await expect(policy).toContainText('4×'); await expect(policy).toContainText('200,00 $'); await expect(policy).toContainText('150 pb');
      await expect(sheet.getByTestId('gmx-auth-approve')).toBeDisabled();        // not before the text is acknowledged
      await shot(page, 'authorize');
      await sheet.getByTestId('gmx-ack-check').check();
      await sheet.getByTestId('gmx-ack-check').scrollIntoViewIfNeeded();
      await shot(page, 'authorize-ack');
      await sheet.getByTestId('gmx-auth-approve').click();
      await expect(sheet.getByTestId('gmx-auth-done')).toBeVisible();
      await sheet.getByRole('button', { name: 'Fermer' }).last().click();
      await expect(card).toHaveAttribute('data-tradable', '1');
      await expect(card.getByTestId('mode-band')).toHaveAttribute('data-tone', 'mainnet');
      await expect(card.getByTestId('gmx-auth-state')).toHaveAttribute('data-state', 'active');
      await expect(card.getByTestId('gmx-policy')).toContainText('4×');
      await expect(card.getByTestId('gmx-trade-ETH')).toBeVisible(); await expect(card.getByTestId('gmx-trade-BTC')).toHaveCount(0);
      await shot(page, 'account-tradable', true);
      // revoke: two clicks, no passkey
      await card.getByTestId('gmx-revoke').click();
      await card.getByTestId('gmx-revoke-confirm').click();
      await expect(card).toHaveAttribute('data-tradable', '0');
      await expect(card.locator('[data-testid="gmx-blocker"][data-code="authorization_revoked"]')).toBeVisible();
      await expect(card.getByTestId('gmx-authorize-open')).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('increase: preview → confirm (signed and fixed fields) → created is « en attente » → executed with the reconciled outcome', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = errorsOf(page);
      await terminal(page, ETH, 'ready');
      await gmx(page, 'delays', { keeperMs: 6000 });
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'mainnet');
      await expect(page.getByTestId('terminal').getByTestId('mode-band').first()).toContainText(/Réel — argent réel/i);
      await expect(page.getByTestId('paper-banner')).toContainText('Marché GMX RÉEL');
      await panel(page, 'Ordre');
      const op = page.getByTestId('gmx-order-panel');
      await expect(op.getByTestId('gmx-two-step')).toContainText('deux temps');
      await expect(op.getByTestId('gmx-review')).toBeDisabled();
      // refusals known before anything is built: the wallet's balance, then the policy's leverage
      await op.getByTestId('gmx-collateral').fill('900');
      await expect(op.getByTestId('gmx-problem')).toHaveAttribute('data-problem', 'gxErrAboveWallet');
      await op.getByTestId('gmx-collateral').fill('25');
      await op.getByTestId('gmx-leverage').fill('9');
      await expect(op.getByTestId('gmx-problem')).toHaveAttribute('data-problem', 'gxErrLevPolicy');
      await op.getByTestId('gmx-leverage').fill('2');
      await expect(op.getByTestId('gmx-preview')).toHaveAttribute('data-ready', '1');
      const est = op.getByTestId('gmx-estimate');
      await expect(op.getByTestId('gmx-derived')).toContainText('50,00 $');
      for (const s of ['Frais de position', 'Impact de prix', 'réglé à la clôture', 'la part non utilisée est remboursée', 'Frais de réseau (gaz)', 'Financement', 'Emprunt', 'par jour', 'Prix de liquidation', 'Prix acceptable', 'estimation']) await expect(est).toContainText(s);
      await expect(op.getByTestId('gmx-risk')).toHaveAttribute('data-code', 'ok');
      await est.scrollIntoViewIfNeeded();
      await shot(page, 'order-panel');
      await shot(page, 'order-panel-full', true);
      const sheet = await review(page);
      const fields = sheet.getByTestId('gmx-fields'), fixed = sheet.getByTestId('gmx-fixed');
      for (const l of ['action', 'market', 'side', 'orderType', 'collateral', 'sizeUsd', 'acceptablePrice', 'executionFee', 'maxFee', 'network', 'exchangeRouter', 'orderVault', 'expiresAt']) await expect(fields.locator(`[data-label="${l}"]`)).toBeVisible();
      await expect(fields).toContainText('25 USDC'); await expect(fields).toContainText('50 USD'); await expect(fields).toContainText('MarketIncrease');
      for (const l of ['receiver', 'cancellationReceiver', 'callbackContract', 'uiFeeReceiver', 'swapPath', 'referralCode', 'minOutputAmount']) await expect(fixed.locator(`[data-label="${l}"]`)).toBeVisible();
      await expect(fixed).toContainText('0x8E2a4cB1f0d35A7c9F1e6b0D4a3C5e7F9b1D2a3C');
      await expect(sheet.getByTestId('gmx-hash')).toContainText(/[0-9a-f]{64}/);
      await expect(sheet.getByTestId('countdown')).toBeVisible();
      await shot(page, 'confirm');
      await shot(page, 'confirm-full', true);
      await sheet.getByTestId('gmx-approve').click();
      const card = sheet.getByTestId('gmx-op');
      await expect(card).toHaveAttribute('data-state', 'created', { timeout: 15_000 });
      await expect(card.getByTestId('gmx-op-words')).toContainText('en attente d’exécution par le réseau GMX');
      await expect(card.getByTestId('gmx-op-words')).toContainText('Il n’est pas exécuté');
      await expect(card).toHaveAttribute('data-done', '0');
      await expect(card.getByTestId('gmx-outcome')).toHaveCount(0);
      await shot(page, 'pending');
      await expect(card).toHaveAttribute('data-state', 'executed', { timeout: 20_000 });
      await expect(card.getByTestId('gmx-op-words')).toContainText('Exécuté par le réseau GMX');
      await expect(card.getByTestId('gmx-outcome')).toContainText('Prix d’exécution'); await expect(card.getByTestId('gmx-outcome')).toContainText('Frais d’exécution remboursés');
      await shot(page, 'executed');
      await sheet.getByTestId('gmx-confirm-close').click();
      await panel(page, 'Positions');
      const pos = page.getByTestId('gmx-position');
      await expect(pos).toHaveCount(1, { timeout: 15_000 });
      await expect(pos).toContainText('ETH/USD [WETH-USDC]'); await expect(pos).toContainText('50,00 $');
      expect(await gmx(page, 'state')).toMatchObject({ positions: 1, usdc: '225' });
      expect(errors).toEqual([]);
    });

    test('an order cancelled by the keeper: the reason, and the collateral back in the wallet', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = errorsOf(page);
      await terminal(page, ETH, 'keeper-cancel');
      const sheet = await review(page);
      await sheet.getByTestId('gmx-approve').click();
      const card = sheet.getByTestId('gmx-op');
      await expect(card).toHaveAttribute('data-state', 'cancelled', { timeout: 25_000 });
      await expect(card.getByTestId('gmx-op-words')).toContainText('annulé par le réseau GMX');
      await expect(card.getByTestId('gmx-op-reason')).toContainText('acceptable price'); await expect(card.getByTestId('gmx-op-reason')).toContainText('OrderNotFulfillableAtAcceptablePrice');
      await expect(card.getByTestId('gmx-collateral-returned')).toHaveAttribute('data-returned', 'true');
      await expect(card.getByTestId('gmx-collateral-returned')).toContainText('Garantie revenue au portefeuille : 25,00 USDC');
      await expect(card).toHaveAttribute('data-done', '0');
      await shot(page, 'cancelled');
      await sheet.getByTestId('gmx-confirm-close').click();
      await panel(page, 'Positions');
      await expect(page.getByTestId('gmx-positions')).toContainText('Aucune position GMX');
      expect(await gmx(page, 'state')).toMatchObject({ positions: 0, usdc: '250' });
      // a refused passkey check: nothing leaves, the operation says so
      await gmx(page, 'signerRefuses');
      const again = await review(page);
      await again.getByTestId('gmx-approve').click();
      await expect(again.getByTestId('gmx-op')).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
      await expect(again.getByTestId('gmx-error')).toHaveAttribute('data-code', 'signer_bad_approval');
      expect(errors).toEqual([]);
    });

    test('the owner cancels a pending order: not before the delay, then with the passkey', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = errorsOf(page);
      await terminal(page, ETH, 'pending');
      await gmx(page, 'delays', { cancelMs: 9000 });
      const sheet = await review(page);
      // « retirer » before the passkey: the proposal is gone, nothing was signed
      await sheet.getByTestId('gmx-withdraw').click();
      await expect(page.getByTestId('gmx-confirm')).toHaveCount(0);
      await expect.poll(async () => ((await gmx(page, 'state')) as any).operations.map((o: any) => o.state).join()).toBe('withdrawn');
      const second = await review(page);
      await second.getByTestId('gmx-approve').click();
      await expect(second.getByTestId('gmx-op')).toHaveAttribute('data-state', 'created', { timeout: 15_000 });
      await second.getByTestId('gmx-confirm-close').click();
      await panel(page, 'Positions');
      const card = page.getByTestId('gmx-operations').getByTestId('gmx-op').first();
      await expect(card).toHaveAttribute('data-state', 'created');
      await expect(card.getByTestId('gmx-op-cancel')).toBeDisabled();
      await expect(card.getByTestId('gmx-cancel-wait')).toContainText(/Annulation possible dans 0:0\d/);
      const early = await page.evaluate(async (id) => { const r = await fetch(`/api/v1/derivatives/gmx/orders/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, ...(await r.json()) }; },
        ((await gmx(page, 'state')) as any).operations.find((o: any) => o.state === 'created').id);
      expect(early).toMatchObject({ status: 409, error: 'not_yet_cancellable' });
      await card.scrollIntoViewIfNeeded();
      await shot(page, 'cancel-wait');
      await expect(card.getByTestId('gmx-op-cancel')).toBeEnabled({ timeout: 15_000 });
      await card.getByTestId('gmx-op-cancel').click();
      const cancel = page.getByTestId('gmx-confirm');
      await expect(cancel).toHaveAttribute('data-kind', 'cancel'); await expect(cancel).toHaveAttribute('data-phase', 'ready');
      await expect(cancel.getByTestId('gmx-fields').locator('[data-label="orderKey"]')).toBeVisible();
      await shot(page, 'cancel-confirm');
      await cancel.getByTestId('gmx-approve').click();
      await expect(cancel.getByTestId('gmx-op')).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
      await cancel.getByTestId('gmx-confirm-close').click();
      const target = page.getByTestId('gmx-operations').locator('[data-testid="gmx-op"][data-kind="increase"]').first();
      await expect(target).toHaveAttribute('data-state', 'cancelled', { timeout: 15_000 });
      await expect(target.getByTestId('gmx-op-words')).toContainText('annulé à votre demande');
      await expect(target.getByTestId('gmx-collateral-returned')).toHaveAttribute('data-returned', 'true');
      await target.scrollIntoViewIfNeeded();
      await shot(page, 'cancelled-owner');
      expect(((await gmx(page, 'state')) as any).usdc).toBe('250');
      expect(errors).toEqual([]);
    });

    test('a position read from the chain, cross-checked, closed through the same confirm sheet', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = errorsOf(page);
      await terminal(page, BTC, 'position');
      await panel(page, 'Positions');
      const pos = page.getByTestId('gmx-position');
      await expect(pos).toHaveCount(1);
      await expect(pos).toContainText('BTC/USD [WBTC.b-USDC]'); await expect(pos).toContainText('120,00 $');
      await expect(pos.getByTestId('gmx-crosscheck')).toHaveAttribute('data-agrees', 'true');
      await expect(page.getByTestId('gmx-positions')).toContainText('Positions lues sur la chaîne');
      await pos.scrollIntoViewIfNeeded();
      await shot(page, 'positions');
      await pos.getByTestId('gmx-position-close').click();
      const sheet = page.getByTestId('gmx-confirm');
      await expect(sheet).toHaveAttribute('data-kind', 'close'); await expect(sheet).toHaveAttribute('data-phase', 'ready');
      await expect(sheet.getByTestId('gmx-fields')).toContainText('MarketDecrease'); await expect(sheet.getByTestId('gmx-fields')).toContainText('120 USD');
      await expect(sheet.getByTestId('gmx-fixed')).toContainText('0x8E2a4cB1f0d35A7c9F1e6b0D4a3C5e7F9b1D2a3C');
      await shot(page, 'close-confirm');
      await sheet.getByTestId('gmx-approve').click();
      const card = sheet.getByTestId('gmx-op');
      await expect(card).toHaveAttribute('data-state', 'executed', { timeout: 25_000 });
      await expect(card.getByTestId('gmx-outcome')).toContainText('Revenu au portefeuille'); await expect(card.getByTestId('gmx-outcome')).toContainText('Résultat réalisé');
      await shot(page, 'close-executed');
      await sheet.getByTestId('gmx-confirm-close').click();
      await expect(page.getByTestId('gmx-positions')).toContainText('Aucune position GMX', { timeout: 15_000 });
      expect(((await gmx(page, 'state')) as any).positions).toBe(0);
      expect(errors).toEqual([]);
    });

    test('contracts changed: a new review is needed — no authorization button, no order panel', async ({ page }) => {
      const errors = errorsOf(page), card = await accounts(page, 'contracts');
      const b = card.locator('[data-testid="gmx-blocker"][data-code="contracts_changed"]');
      await expect(b).toContainText('GMX a publié de nouveaux contrats : nouvelle revue nécessaire');
      await expect(card.getByTestId('gmx-pins')).toHaveAttribute('data-ok', 'false');
      await expect(card.getByTestId('gmx-auth-state')).toHaveAttribute('data-state', 'stale');
      await expect(card.getByTestId('gmx-authorize-open')).toHaveCount(0);
      await expect(card).toHaveAttribute('data-tradable', '0');
      await b.scrollIntoViewIfNeeded();
      await shot(page, 'contracts-changed');
      await terminal(page, ETH, 'contracts');
      await panel(page, 'Ordre');
      await expect(page.getByTestId('gmx-locked').locator('[data-code="contracts_changed"]')).toBeVisible();
      await expect(page.getByTestId('gmx-order-panel')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('router hand-over when GMX is tradable; English', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = errorsOf(page);
      // the router: a GMX candidate opens the GMX order panel, pre-filled — only when GMX is tradable
      await page.goto(`${BASE}/futures?v=router&mock=1&gmx=ready`);
      await page.getByTestId('router-run').click();
      const cand = page.locator(`[data-testid="router-card"][data-instrument="${BTC}"]`);
      await expect(cand.getByTestId('router-open-gmx')).toBeVisible({ timeout: 20_000 });
      await expect(cand.getByTestId('router-open-paper')).toHaveCount(0);
      await cand.getByTestId('router-open-gmx').click();
      const op = page.getByTestId('gmx-order-panel');
      await expect(op).toBeVisible();
      await expect(op.getByTestId('gmx-prefilled')).toBeVisible();
      await expect(op.getByTestId('gmx-size')).not.toHaveValue('');
      await expect(op.getByTestId('gmx-collateral')).not.toHaveValue('');
      // English
      await navTo(page, 'settings');
      await page.getByRole('radio', { name: 'English' }).click();
      await navTo(page, 'swap');
      await page.getByRole('tab', { name: 'Futures' }).click();
      if (phone) await page.getByRole('tab', { name: /^Trade/ }).click();
      const en = page.getByTestId('gmx-order-panel');
      await expect(en.getByTestId('gmx-two-step')).toContainText('A GMX order happens in two steps');
      await en.getByTestId('gmx-collateral').fill('20');
      await expect(en.getByTestId('gmx-preview')).toHaveAttribute('data-ready', '1');
      await expect(en.getByTestId('gmx-estimate')).toContainText('the unused part is refunded'); await expect(en.getByTestId('gmx-estimate')).toContainText('settled at close');
      await en.getByTestId('gmx-estimate').scrollIntoViewIfNeeded();
      await shot(page, 'english-order-panel');
      await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Accounts' }).click();
      const card = page.getByTestId('gmx-card');
      await expect(card.getByTestId('gmx-account')).toContainText('The account is the wallet’s address');
      await gmx(page, 'scenario', 'off');
      await expect(card.locator('[data-testid="gmx-blocker"][data-code="gmx_setting_off"]').getByTestId('gmx-setting-note')).toContainText('This is a server setting: it cannot be changed from the app', { timeout: 20_000 });
      await card.getByTestId('gmx-blockers').scrollIntoViewIfNeeded();
      await shot(page, 'english-locked');
      expect(errors).toEqual([]);
    });
  });
}

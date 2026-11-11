import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// « Déposer » / « Retirer » of a venue account, in a browser, against the in-browser mock (`?mock=1`, development build only):
// no backend, no chain, no venue, no signer, a simulated passkey — apps/web/src/derivatives/mockCollateral.ts says what is real
// in it (pinned route, floor, fee, canonical withdrawal and its hash, withdraw3 action, passkey challenge) and what is not (time
// stands in for the chain and the venue). What this spec checks is the SCREEN: what it shows before the passkey, that it never
// announces a deposit before the venue credited it nor a withdrawal before it arrived, and what it says when it is late.
//   npx playwright test -c tests/e2e/playwright.config.ts futures-collateral.spec.ts        (FUTURES_SHOTS=1 writes docs/v4/screens/collateral-*.png)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5191;
const BASE = process.env.FUTURES_URL ?? `http://localhost:${PORT}`;
const SHOTS = resolve(ROOT, 'docs/v4/screens');
const BRIDGE = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
let vite: ChildProcess | null = null;

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

const live = (page: Page, name: string, ...args: unknown[]) => page.evaluate(([n, a]) => (window as any).__spwMock.live[n as string](...(a as unknown[])), [name, args] as const);
const coll = (page: Page, name: string, ...args: unknown[]) => page.evaluate(([n, a]) => (window as any).__spwMock.live.collateral[n as string](...(a as unknown[])), [name, args] as const);
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message)); return errors; };

for (const size of [
  { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const) {
  test.describe(`futures collateral — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA' });
    const shot = async (page: Page, name: string) => { if (process.env.FUTURES_SHOTS !== '1') return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/collateral-${size.name}-${name}.png`, fullPage: false }); };
    /** a real-money account that never deposited (the mock's server setting is on), with 40 USDC in the wallet on Arbitrum */
    const open = async (page: Page, network: 'mainnet' | 'testnet' = 'mainnet') => {
      await page.goto(`${BASE}/futures?v=accounts&mock=1&mainnet=1`);
      await expect(page.getByTestId('live-card')).toBeVisible();
      await live(page, 'fund', network, '0');
      await page.getByTestId(`live-create-${network}`).getByRole('button').click();
      const card = page.getByTestId(`live-account-${network}`);
      await expect(card.getByTestId('collateral-panel')).toBeVisible();
      return card;
    };

    test('deposit: minimum refused, review says everything, waits for the venue, then credited; withdrawal: fee, own address, arrives', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = errorsOf(page), card = await open(page), panel = card.getByTestId('collateral-panel');
      await expect(card.getByTestId('mode-band')).toHaveAttribute('data-tone', 'mainnet');
      await expect(panel.getByTestId('collateral-venue-balance')).toContainText(/0,00\s\$/);
      await expect(card.getByTestId('funding-box').getByRole('button')).toHaveCount(0);
      await panel.getByTestId('collateral-deposit').click();
      const sheet = page.getByTestId('deposit-sheet');
      await expect(sheet).toHaveAttribute('data-step', 'form');
      // the real-money band is in the sheet and cannot be dismissed
      await expect(sheet.getByTestId('mode-band')).toContainText(/Réel — argent réel/i);
      await expect(sheet.getByTestId('mode-band').getByRole('button')).toHaveCount(0);
      await expect(sheet.getByTestId('deposit-minimum')).toContainText('perdu pour toujours');
      // below the minimum: refused before anything is prepared
      await sheet.getByTestId('deposit-amount').fill('5');
      await expect(sheet.getByTestId('deposit-problem')).toContainText('Refusé : sous 6 USDC');
      await expect(sheet.getByTestId('deposit-review')).toBeDisabled();
      await sheet.getByTestId('deposit-amount').fill('60');
      await expect(sheet.getByTestId('deposit-problem')).toContainText('n’a que 40 USDC');
      await shot(page, '01-deposit-form');
      await sheet.getByTestId('deposit-amount').fill('10');
      await expect(sheet.getByTestId('deposit-problem')).toHaveCount(0);
      await sheet.getByTestId('deposit-review').click();
      await expect(sheet).toHaveAttribute('data-step', 'review');
      const facts = sheet.getByTestId('deposit-facts'), says = sheet.getByTestId('deposit-says');
      await expect(facts).toContainText('10 USDC');
      await expect(facts).toContainText('USDC natif sur Arbitrum One → pont de Hyperliquid → votre compte');
      await expect(facts).toContainText('moins de 60 s');
      await expect(facts).toContainText('6 USDC');
      await expect(says).toContainText('La plateforme crédite l’adresse qui envoie');
      await expect(says).toContainText(BRIDGE.slice(0, 8));
      await expect(says).toContainText('Sous 5 USDC, un dépôt n’est pas crédité et est perdu');
      await expect(says).toContainText('en attente du crédit par la plateforme');
      await expect(sheet.getByTestId('collateral-integrity')).toHaveCount(0);
      await expect(sheet.getByTestId('mode-band')).toBeVisible();
      await shot(page, '02-deposit-review');
      await sheet.getByTestId('deposit-approve').click();
      await expect(sheet).toHaveAttribute('data-step', 'progress', { timeout: 10_000 });
      const op = sheet.getByTestId('collateral-op');
      // sent, then confirmed on-chain: NOT done, the balance after is "not yet"
      await expect(op).toHaveAttribute('data-state', /^(sent|awaiting_credit)$/);
      await expect(op).toHaveAttribute('data-done', '0');
      await expect(op).toContainText('pas encore — en attente');
      await expect(op).not.toContainText('Crédité :');
      await shot(page, '03-deposit-waiting');
      // the venue credits: only now is it announced
      await expect(op).toHaveAttribute('data-state', 'credited', { timeout: 20_000 });
      await expect(op).toHaveAttribute('data-done', '1');
      await expect(op.getByTestId('collateral-op-words')).toContainText('Crédité : la plateforme a inscrit ce dépôt sur votre compte.');
      await expect(op).toContainText(/Solde sur la plateforme, après\s*10 USDC/);
      await shot(page, '04-deposit-credited');
      await sheet.getByRole('button', { name: 'Fermer' }).last().click();
      await expect(panel.getByTestId('collateral-venue-balance')).toContainText(/10,00\s\$/, { timeout: 15_000 });
      await expect(panel.getByTestId('collateral-ops').getByTestId('collateral-op').first()).toHaveAttribute('data-state', 'credited');

      // withdrawal
      await panel.getByTestId('collateral-withdraw').click();
      const ws = page.getByTestId('withdraw-sheet');
      await expect(ws.getByTestId('mode-band')).toContainText(/Réel — argent réel/i);
      await ws.getByTestId('withdraw-amount').fill('1');
      await expect(ws.getByTestId('withdraw-problem')).toContainText('dépasser les frais de 1 USDC');
      await ws.getByTestId('withdraw-amount').fill('11');
      await expect(ws.getByTestId('withdraw-problem')).toContainText('10 USDC retirables');
      await ws.getByTestId('withdraw-amount').fill('4');
      await ws.getByTestId('withdraw-review').click();
      await expect(ws).toHaveAttribute('data-step', 'review');
      await expect(ws.getByTestId('withdraw-facts')).toContainText(/Frais de la plateforme\s*1 USDC/);
      await expect(ws.getByTestId('withdraw-facts')).toContainText(/Vous recevrez\s*3 USDC/);
      await expect(ws.getByTestId('withdraw-says')).toContainText('l’adresse de ce portefeuille, et aucune autre');
      await expect(ws.getByTestId('withdraw-says')).toContainText('withdraw3 (Mainnet): 4 USDC to 0x5ad0c0ffee');
      await expect(ws.getByTestId('collateral-integrity')).toHaveCount(0);
      await shot(page, '05-withdraw-review');
      await ws.getByTestId('withdraw-approve').click();
      await expect(ws).toHaveAttribute('data-step', 'progress', { timeout: 10_000 });
      const wop = ws.getByTestId('collateral-op');
      await expect(wop).toHaveAttribute('data-state', 'submitted');
      await expect(wop).toHaveAttribute('data-done', '0');
      await expect(wop.getByTestId('collateral-op-words')).toContainText('l’USDC n’est pas encore arrivé sur ce portefeuille');
      await expect(wop).toHaveAttribute('data-state', 'completed', { timeout: 20_000 });
      await expect(wop.getByTestId('collateral-op-words')).toContainText('Arrivé : ce portefeuille a reçu l’USDC du pont.');
      await expect(wop).toContainText(/Reçu sur le portefeuille\s*3 USDC/);
      await shot(page, '06-withdraw-arrived');
      await ws.getByRole('button', { name: 'Fermer' }).last().click();
      await expect(panel.getByTestId('collateral-venue-balance')).toContainText(/6,00\s\$/, { timeout: 15_000 });
      expect(errors).toEqual([]);
    });

    test('a credit that does not come is never announced: after ten minutes the screen says what to check; a wrong passkey sends nothing', async ({ page }) => {
      test.setTimeout(90_000);
      const errors = errorsOf(page), card = await open(page), panel = card.getByTestId('collateral-panel');
      // wrong passkey first: the operation ends, nothing left the wallet
      await live(page, 'passkey', 'bad');
      await panel.getByTestId('collateral-deposit').click();
      let sheet = page.getByTestId('deposit-sheet');
      await sheet.getByTestId('deposit-amount').fill('10');
      await sheet.getByTestId('deposit-review').click();
      await sheet.getByTestId('deposit-approve').click();
      await expect(sheet).toHaveAttribute('data-step', 'progress', { timeout: 10_000 });
      await expect(sheet.getByTestId('collateral-op')).toHaveAttribute('data-state', 'failed');
      await expect(sheet.getByTestId('collateral-op')).toHaveAttribute('data-done', '0');
      await expect(sheet.getByTestId('collateral-op-words')).toContainText('Le dépôt n’a pas eu lieu. Rien n’a atteint la plateforme.');
      await sheet.getByRole('button', { name: 'Fermer' }).last().click();
      // now a deposit whose credit never comes, seen eleven minutes later
      await coll(page, 'creditAfter', null); await coll(page, 'age', 11 * 60_000);
      await panel.getByTestId('collateral-deposit').click();
      sheet = page.getByTestId('deposit-sheet');
      await sheet.getByTestId('deposit-amount').fill('12');
      await sheet.getByTestId('deposit-review').click();
      await sheet.getByTestId('deposit-approve').click();
      await expect(sheet).toHaveAttribute('data-step', 'progress', { timeout: 10_000 });
      const op = sheet.getByTestId('collateral-op');
      await expect(op).toHaveAttribute('data-state', 'awaiting_credit');
      await expect(op).toHaveAttribute('data-done', '0');
      await expect(op.getByTestId('collateral-op-words')).toContainText('Le dépôt n’est PAS annoncé comme arrivé');
      await expect(op.getByTestId('collateral-overdue')).toContainText('À vérifier, dans l’ordre');
      await expect(op.getByTestId('collateral-overdue')).toContainText(BRIDGE);
      await expect(op.getByTestId('collateral-overdue').getByRole('listitem')).toHaveCount(5);
      await expect(op).toContainText('pas encore — en attente');
      await shot(page, '07-deposit-overdue');
      expect(await page.getByRole('dialog').evaluate((d) => d.scrollWidth <= d.clientWidth + 1 && [...d.querySelectorAll('*')].every((e) => e.scrollWidth <= e.clientWidth + 1 || getComputedStyle(e).overflowX !== 'visible' || e.clientWidth === 0))).toBe(true);
      await sheet.getByRole('button', { name: 'Fermer' }).last().click();
      // the account card keeps saying so, and a second deposit is refused while this one is on its way
      await expect(panel.getByTestId('collateral-ops').getByTestId('collateral-op').first()).toHaveAttribute('data-state', 'awaiting_credit');
      await expect(panel.getByTestId('collateral-venue-balance')).toContainText(/0,00\s\$/);
      await panel.getByTestId('collateral-deposit').click();
      sheet = page.getByTestId('deposit-sheet');
      await sheet.getByTestId('deposit-amount').fill('10');
      await sheet.getByTestId('deposit-review').click();
      await expect(sheet.getByTestId('collateral-error')).toContainText('Un dépôt est déjà en route');
      expect(errors).toEqual([]);
    });

    test('USDC on another network: nothing is bridged silently, a pre-filled link to the cross-network transfer; testnet has no deposit', async ({ page }) => {
      await page.goto(`${BASE}/futures?v=accounts&mock=1&mainnet=1`);
      await expect(page.getByTestId('live-card')).toBeVisible();
      await live(page, 'fund', 'mainnet', '0');
      await coll(page, 'wallet', '2', [{ network: 'base', name: 'Base', usdc: '31.5' }]);    // 2 USDC on Arbitrum, 31.5 on Base
      await page.getByTestId('live-create-mainnet').getByRole('button').click();
      const panel = page.getByTestId('live-account-mainnet').getByTestId('collateral-panel');
      await expect(panel.getByTestId('deposit-why')).toHaveAttribute('data-reason', 'usdc_elsewhere');
      await expect(panel.getByTestId('collateral-deposit')).toBeDisabled();
      await expect(panel.getByTestId('deposit-why')).toContainText('Rien n’est transféré automatiquement');
      const link = panel.getByTestId('collateral-bridge-links').getByRole('link');
      await expect(link).toHaveAttribute('href', '/swap?bridgeFrom=base&bridgeTo=arbitrum');
      await expect(link).toContainText('Amener de l’USDC de Base vers Arbitrum One (31,5 USDC disponibles)');
      await shot(page, '08-usdc-elsewhere');
      await live(page, 'fund', 'testnet', '100');
      await page.getByTestId('live-create-testnet').getByRole('button').click();
      const t = page.getByTestId('live-account-testnet').getByTestId('collateral-panel');
      await expect(t.getByTestId('collateral-deposit')).toBeDisabled();
      await expect(t.getByTestId('deposit-why')).toHaveAttribute('data-reason', 'no_route');
      await expect(t.getByTestId('collateral-withdraw')).toBeEnabled();
      // no horizontal overflow on any size: a long address must wrap
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    });
  });
}

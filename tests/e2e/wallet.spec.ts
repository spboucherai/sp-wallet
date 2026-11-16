import { navTo } from './v11-helpers.ts';   // v11 interface: the shell's navigation (five areas, header menu)
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Requires scripts/dev-stack.sh (throwaway signer keystore, broadcast off). Uses a virtual passkey via CDP.
const SHOTS = 'test-results/shots';
test('owner setup, lock/unlock, every screen on a phone viewport, send guarded by real chain checks', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByText('Configuration initiale')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-setup.png` });
  await page.getByRole('textbox').fill('definitely-wrong-token');
  await page.getByRole('button', { name: /Créer ma clé/ }).click();
  await expect(page.getByRole('alert')).toContainText(/Jeton de configuration invalide/);
  await page.getByRole('textbox').fill(readFileSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`, 'utf8').trim());
  await page.getByRole('button', { name: /Créer ma clé/ }).click();
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Actifs' })).toBeVisible();
  await expect(page.getByText(/23\/23 réseaux opérationnels/)).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/02-home.png`, fullPage: true });

  // dedicated asset page: price, chart, balance, details
  await page.getByRole('button', { name: /USD Coin/ }).first().click();
  await expect(page.getByText('Votre solde')).toBeVisible();
  await expect(page.getByText('Contrat du jeton')).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/02b-asset.png`, fullPage: true });
  await page.getByRole('button', { name: 'Retour' }).click();
  await page.getByRole('button', { name: /Tous les actifs/ }).click();
  await page.getByRole('searchbox').fill('pepe');
  await expect(page.getByRole('button', { name: /Pepe/ })).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/02c-assets.png` });
  await page.getByRole('button', { name: 'Retour' }).click();

  // no horizontal overflow on a phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // lock, then unlock with the passkey
  await navTo(page, 'lock');
  await expect(page.getByRole('button', { name: /Déverrouiller/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-lock.png` });
  await page.getByRole('button', { name: /Déverrouiller/ }).click();
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 30_000 });

  // receive: signer-derived address + QR
  await navTo(page, 'home');
  await page.getByRole('main').getByRole('button', { name: 'Recevoir' }).click();
  await expect(page.locator('img[alt^="QR 0x"]')).toBeVisible();
  await expect(page.getByText(/Envoyez uniquement ETH \/ USDC \/ .*sur le réseau Base/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-receive.png`, fullPage: true });
  await page.getByRole('radio', { name: 'Solana' }).click();
  await expect(page.getByText(/Envoyez uniquement SOL \/ USDC \/ .*sur le réseau Solana/)).toBeVisible();
  await page.getByRole('radio', { name: 'Bitcoin', exact: true }).click();
  await expect(page.locator('img[alt^="QR bc1q"]')).toBeVisible();
  for (const [name, prefix] of [['Bitcoin Cash', 'bitcoincash:q'], ['Dogecoin', 'D'], ['Litecoin', 'ltc1q'], ['TRON', 'T'], ['XRP Ledger', 'r'], ['Sui', '0x'], ['Aptos', '0x'], ['Cosmos Hub', 'cosmos1'], ['NEAR Protocol', ''], ['TON', 'UQ'], ['Stellar', 'G']] as const) {
    await page.getByRole('radio', { name, exact: true }).click();
    await expect(page.locator(`img[alt^="QR ${prefix}"]`)).toBeVisible();
  }
  await expect(page.getByText(/un compte doit détenir au moins 1 XLM/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04b-receive-stellar.png`, fullPage: true });

  // swap: route comparison screen (no provider is wired in this build: it must say so, and execution must be visibly disabled)
  await navTo(page, 'swap');
  await expect(page.getByText(/Devis en direct de plusieurs fournisseurs/)).toBeVisible();
  await page.getByLabel('Montant').fill('25');
  // live quotes from real providers (USDC -> ETH on Base); the empty test wallet cannot execute, and must be told why
  await expect(page.getByText('kyberswap').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/min\. garanti/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04c-swap.png`, fullPage: true });
  await page.getByRole('button', { name: /Échanger via KyberSwap/ }).click();
  await expect(page.getByRole('alert')).toContainText(/Solde insuffisant/, { timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // send: invalid address is refused, then an empty wallet cannot draft a transfer (live mainnet balance check)
  await navTo(page, 'send');
  await page.locator('textarea').fill('0x1234');
  await page.getByRole('radio', { name: 'USDC', exact: true }).click();
  await page.getByPlaceholder('0.00').fill('5');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert')).toContainText(/Adresse invalide/);
  await page.locator('textarea').fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert')).toContainText(/Solde insuffisant/, { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/05-send.png`, fullPage: true });

  await navTo(page, 'activity');
  // v11 interface: Activity is the timeline of every operation — a new wallet already has its setup in it, and the audit chain is intact
  await expect(page.getByTestId('activity')).toBeVisible();
  await expect(page.getByTestId('ac-audit')).toContainText('Chaîne d’audit intacte', { timeout: 20_000 });
  await navTo(page, 'security');
  await expect(page.getByText('Signature active')).toBeVisible();
  await expect(page.getByText('Chaîne d’empreintes intacte')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-security.png`, fullPage: true });

  // English + light theme
  await navTo(page, 'settings');
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.screenshot({ path: `${SHOTS}/07-settings-en-dark.png`, fullPage: true });
  await navTo(page, 'home');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/08-home-dark.png`, fullPage: true });
  await navTo(page, 'settings');
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.getByRole('radio', { name: 'Français' }).click();

  // emergency halt from the phone
  await navTo(page, 'security');
  await page.getByRole('button', { name: 'Arrêt d’urgence' }).click();
  await page.getByLabel('STOP').fill('stop');
  await page.getByRole('button', { name: 'Arrêt d’urgence' }).click();
  await expect(page.getByText('Signature arrêtée')).toBeVisible();
  await navTo(page, 'home');
  await expect(page.getByText(/Arrêt d’urgence actif/)).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: 'Envoyer' })).toBeDisabled();

  expect(errors.filter((e) => !/status of 4\d\d/.test(e))).toEqual([]);
});

test('a second browser without the passkey cannot get in', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Déverrouiller/ })).toBeVisible();
  await expect(page.getByText('Configuration initiale')).toHaveCount(0); // setup is closed for good
  for (const p of ['/api/v1/portfolio', '/api/v1/accounts', '/api/v1/security/audit', '/api/v1/export/activity.csv'])
    expect((await page.request.get(p)).status()).toBe(401);
  expect((await page.request.post('/api/v1/auth/setup/options', { headers: { 'x-spw-csrf': '1', origin: process.env.SPW_E2E_BASE ?? 'http://localhost:8650' }, data: {} })).status()).toBe(403);
  await ctx.close();
});

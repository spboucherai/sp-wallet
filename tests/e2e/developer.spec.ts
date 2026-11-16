import { readFileSync } from 'node:fs';
import { expect, request as playwrightRequest, test } from '@playwright/test';

// V11 Developer / API on a real stack (scripts/dev-stack.sh: real API, real isolated signer, throwaway keystore and database).
// The owner creates a key with his passkey (virtual authenticator via CDP), the secret is shown once, a program WITHOUT any
// cookie uses it on /api/v1/trading and is refused everywhere else, then the owner revokes it.
//   SPW_DEV_PORT=8760 SPW_DEV_DB=spw_dev_v11api SPW_DEV_DIR=/tmp/spw-dev-v11api scripts/dev-stack.sh
//   SPW_E2E_BASE=http://localhost:8760 SPW_DEV_DIR=/tmp/spw-dev-v11api pnpm e2e developer.spec.ts
const SHOTS = 'test-results/shots';
test('Developer / API: create a key with the passkey, use it without a session, see usage, docs and status, revoke it', async ({ page, context, baseURL }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByText('Configuration initiale')).toBeVisible();
  await page.getByRole('textbox').fill(readFileSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`, 'utf8').trim());
  await page.getByRole('button', { name: /Créer ma clé/ }).click();
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 30_000 });

  // Settings → Developer / API
  await page.getByRole('navigation').getByRole('button', { name: 'Réglages' }).click();
  await page.getByRole('button', { name: 'Développeur / API' }).click();
  await expect(page).toHaveURL(/\/developer$/);
  await expect(page.getByRole('heading', { name: 'Développeur / API' })).toBeVisible();
  await expect(page.getByText('Aucune clé d’API')).toBeVisible();
  await expect(page.getByText('Exécution non branchée.')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dev-01-empty.png`, fullPage: true });

  // create: a name is required; then the passkey approves the canonical request and the secret is shown once
  await page.getByTestId('dev-new-key').click();
  await page.getByTestId('dev-create-submit').click();
  await expect(page.getByText('Donnez un nom (60 caractères au plus).')).toBeVisible();
  await page.getByTestId('dev-name').fill('robot e2e');
  await page.getByLabel(/Lire les agents/).check();
  await page.screenshot({ path: `${SHOTS}/dev-02-create.png` });
  await page.getByTestId('dev-create-submit').click();
  const secretEl = page.getByTestId('dev-secret-value');
  await expect(secretEl).toBeVisible({ timeout: 20_000 });
  const secret = (await secretEl.textContent())!.trim();
  expect(secret).toMatch(/^spw_live_spk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText(/il ne sera plus jamais affiché/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dev-03-secret.png`, mask: [secretEl] });
  await page.getByRole('button', { name: 'Je l’ai enregistré' }).click();
  await expect(secretEl).toHaveCount(0);
  const keyId = secret.split('_').slice(2, 4).join('_');
  await expect(page.getByTestId(`dev-key-${keyId}`)).toContainText('robot e2e');
  await expect(page.getByTestId(`dev-key-${keyId}`)).toContainText('active');
  expect(await page.content()).not.toContain(secret);                                   // the secret is nowhere in the page any more

  // a program with the key and NO cookie
  const bot = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  const agents = await bot.get('/api/v1/trading/agents');
  expect(agents.status()).toBe(200);
  expect(agents.headers()['ratelimit-limit']).toBe('120');
  expect((await bot.get('/api/v1/trading/openapi.json')).status()).toBe(200);
  expect((await bot.get('/api/v1/trading/orders')).status()).toBe(403);                  // scope not granted
  expect((await (await bot.get('/api/v1/trading/orders')).json()).error).toBe('insufficient_scope');
  for (const outside of ['/api/v1/security/overview', '/api/v1/developer/keys', '/api/v1/portfolio', '/api/v1/accounts']) {
    const r = await bot.get(outside);
    expect(r.status(), outside).toBe(403);
    expect((await r.json()).error).toBe('key_path_forbidden');
  }
  expect((await bot.post('/api/v1/security/emergency-halt', { data: {} })).status()).toBe(403);
  const noKey = await playwrightRequest.newContext({ baseURL });
  expect((await noKey.get('/api/v1/trading/agents')).status()).toBe(401);

  // usage: the calls above, by route pattern and status
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.getByText('GET /api/v1/trading/agents')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('GET /api/v1/trading/orders').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dev-04-usage.png`, fullPage: true });

  // documentation: rendered in-app from the server's own OpenAPI document (nothing from another origin)
  await page.getByRole('tab', { name: 'Documentation' }).click();
  await expect(page.getByTestId('dev-op-listMarkets')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('dev-op-placeOrder').locator('summary').click();
  await expect(page.getByTestId('dev-op-placeOrder')).toContainText('orders:execute');
  await expect(page.getByTestId('dev-op-placeOrder')).toContainText('non branchée');
  await expect(page.getByText('import os, uuid, requests')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dev-05-docs.png`, fullPage: true });

  // status: execution is reported as not wired
  await page.getByRole('tab', { name: 'État' }).click();
  await expect(page.getByTestId('dev-svc-database')).toContainText('opérationnel');
  await expect(page.getByTestId('dev-svc-execution')).toContainText('non branchée');
  await page.screenshot({ path: `${SHOTS}/dev-06-status.png`, fullPage: true });

  // webhooks tab renders its events and the empty state
  await page.getByRole('tab', { name: 'Webhooks' }).click();
  await expect(page.getByText('Aucun webhook')).toBeVisible();
  await expect(page.getByText('key.revoked').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);   // no horizontal overflow on a phone

  // revoke: session only, effective at once
  await page.getByRole('tab', { name: 'Clés' }).click();
  await page.getByRole('button', { name: 'Révoquer' }).click();
  await page.getByRole('button', { name: 'Révoquer la clé' }).click();
  await expect(page.getByTestId(`dev-key-${keyId}`)).toContainText('révoquée', { timeout: 20_000 });
  expect((await bot.get('/api/v1/trading/agents')).status()).toBe(401);
  await page.screenshot({ path: `${SHOTS}/dev-07-revoked.png`, fullPage: true });
  expect(errors).toEqual([]);
});

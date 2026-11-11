import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// One pass of the live screens against the REAL backend, booted in-process by tests/e2e/live-real-server.mts: real API routes,
// real isolated signer (throwaway seed in memory), PostgreSQL, the BUILT web bundle (no mock), and Hyperliquid's TESTNET.
// The passkey is a Chrome virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`): the browser's own WebAuthn path runs,
// from the one-time owner setup to the approval of the venue authorization.
//
// The throwaway account never deposited, so the venue refuses the trading-key approval with "Must deposit before performing
// actions": the spec checks that the screens show that refusal, in the venue's words, with the funding explanation — and that
// nothing else breaks. Nothing is ever sent to the mainnet exchange endpoint (the server process refuses it, and the traffic
// it records is checked at the end).
//
// Off by default (it needs PostgreSQL, the network, and `dist/web`):
//   (cd apps/web && node_modules/.bin/vite build) && LIVE_REAL=1 npx playwright test -c tests/e2e/playwright.config.ts futures-live-real.spec.ts
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = resolve(ROOT, 'docs/v4/screens'), TRAFFIC = resolve(ROOT, 'test-results/live-real-traffic.json');
const SIZES = [
  { name: 'phone', port: 8672, use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', port: 8673, use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;

test.skip(process.env.LIVE_REAL !== '1', 'set LIVE_REAL=1 to run against the real backend and the Hyperliquid testnet');

for (const size of SIZES) {
  const phone = size.name === 'phone', BASE = `http://localhost:${size.port}`;
  test.describe(`futures live, real backend — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA', baseURL: BASE });
    let server: ChildProcess | null = null, log = '';
    test.beforeAll(async () => {
      if (!existsSync(resolve(ROOT, 'dist/web/index.html'))) throw new Error('dist/web is missing: build the web bundle first (cd apps/web && node_modules/.bin/vite build)');
      mkdirSync(dirname(TRAFFIC), { recursive: true });
      server = spawn(resolve(ROOT, 'node_modules/.bin/tsx'), ['tests/e2e/live-real-server.mts', '--port', String(size.port), '--db', `spw_live_ui_e2e_${size.name}`, '--traffic', TRAFFIC], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout!.on('data', (d) => { log += String(d); }); server.stderr!.on('data', (d) => { log += String(d); });
      for (let i = 0; i < 240 && !log.includes('READY'); i++) { if (server.exitCode !== null) break; await new Promise((r) => setTimeout(r, 250)); }
      if (!log.includes('READY')) throw new Error(`the real backend did not start:\n${log.slice(-2000)}`);
    });
    test.afterAll(async () => { server?.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); });
    const shot = async (page: Page, name: string, fullPage = false) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/live-real-${size.name}-${name}.png`, fullPage }); };

    test('owner setup with a virtual passkey → testnet account → authorization refused by the venue (unfunded), shown with the funding explanation', async ({ page, context }) => {
      test.setTimeout(180_000);
      const errors: string[] = [], refused: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) refused.push(`${r.status()} ${new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, ':id')}`); });
      // the browser's own WebAuthn, answered by a virtual platform authenticator with user verification
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

      // ---- one-time owner setup: the real signer enrols the passkey
      await page.goto('/');
      await page.getByRole('textbox').fill('e2e-setup-token');
      await page.getByRole('button', { name: 'Créer ma clé d’accès' }).click();
      await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 30_000 });

      // ---- accounts: live trading is off, mainnet is shown and blocked (the server setting is off)
      await page.goto('/futures?v=accounts');
      const live = page.getByTestId('live-card');
      await expect(live.getByTestId('live-status')).toContainText('désactivée', { timeout: 30_000 });
      await expect(live.getByTestId('mainnet-setting')).toContainText('SPW_DERIV_LIVE_MAINNET');
      await expect(live.getByTestId('live-create-mainnet').getByRole('button', { name: 'Créer le compte réel' })).toBeDisabled();
      await live.getByRole('button', { name: 'Créer le compte testnet' }).click();
      const card = page.getByTestId('live-account-testnet');
      await expect(card).toHaveAttribute('data-mode', 'READ_ONLY', { timeout: 30_000 });
      await expect(card.getByTestId('mode-band')).toContainText(/Testnet — argent fictif/i);
      // the venue's own state of the throwaway account: nothing, read from the testnet
      await expect(card.getByTestId('venue-state')).toContainText(/0,00\s\$/, { timeout: 30_000 });
      await expect(card.getByTestId('venue-state')).toContainText('plateforme');
      const account = /account (0x[0-9a-f]{40})/.exec(log)![1]!;
      await expect(card).toContainText(account.slice(0, 6));
      await expect(card.getByTestId('funding-box')).toContainText('section 15');             // the server's own words about deposits
      await expect(card.getByTestId('funding-box').getByRole('button')).toHaveCount(0);
      await card.scrollIntoViewIfNeeded();
      await shot(page, '01-account-readonly', true);

      // ---- authorization: limits → review (acknowledgement, what is signed, key, limits) → the REAL passkey prompt
      await card.getByTestId('authorize').click();
      const sheet = page.getByTestId('authorize-sheet');
      await sheet.getByRole('button', { name: /Continuer/ }).click();
      await expect(sheet).toHaveAttribute('data-step', 'review', { timeout: 30_000 });
      await expect(sheet.getByTestId('ack-text')).toContainText('Hyperliquid — conditions de la plateforme et votre juridiction (Québec, Canada)');
      await expect(sheet.getByTestId('integrity')).toHaveCount(0);                              // the displayed text hashes to what the authorization commits to
      await expect(sheet.getByTestId('what-is-signed')).toContainText('approveAgent');
      await expect(sheet.getByTestId('agent-can')).toContainText('placer des ordres');
      await expect(sheet.getByTestId('agent-can')).toContainText('retirer des fonds');
      await expect(sheet.getByTestId('auth-approve')).toBeDisabled();
      await shot(page, '02-authorize-review');
      await sheet.getByTestId('ack-check').check();
      await sheet.getByTestId('auth-approve').click();
      // the signer verified the passkey and signed approveAgent with the (throwaway) wallet key; the testnet refuses: no deposit
      await expect(sheet).toHaveAttribute('data-step', 'refused', { timeout: 60_000 });
      await expect(sheet.getByTestId('venue-words')).toContainText(`Must deposit before performing actions. User: ${account}`);
      await expect(sheet.getByTestId('auth-refused')).toContainText('La plateforme a refusé d’enregistrer la clé de négociation.');
      await expect(sheet.getByTestId('auth-refused')).toContainText('n’accepte aucune action d’un compte qui n’a jamais reçu de dépôt');
      await expect(sheet.getByTestId('funding-box')).toContainText('« Déposer » et « Retirer » se font ci-dessous');
      await shot(page, '03-venue-refused');
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await expect(card).toHaveAttribute('data-mode', 'READ_ONLY');
      await expect(live.getByTestId('live-status')).toContainText('désactivée');
      await expect(card.getByTestId('revoke')).toHaveCount(0);                                 // nothing is left to revoke

      // ---- the terminal with the testnet account: the band, real market data, and no way to send an order
      await page.getByRole('tablist', { name: 'Vues' }).getByRole('tab', { name: 'Terminal' }).click();
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'testnet');
      await expect(page.getByTestId('terminal').getByTestId('mode-band').first()).toContainText(/Testnet — argent fictif/i);
      await expect(page.getByTestId('freshness')).toHaveAttribute('data-state', 'live', { timeout: 30_000 });
      await shot(page, '04-terminal-testnet');
      if (phone) await page.getByRole('tab', { name: /^Ordre/ }).click();
      const panel = page.getByTestId('order-panel');
      await expect(panel).toHaveAttribute('data-account-kind', 'venue');
      await expect(panel.getByTestId('live-readonly')).toContainText('lecture seule');
      await expect(panel.getByRole('textbox')).toHaveCount(0);
      await expect(panel.getByTestId('live-review')).toHaveCount(0);
      await shot(page, '05-order-panel-readonly', phone);
      if (phone) await page.getByRole('tab', { name: /^Positions/ }).click();
      await expect(page.getByTestId('blotter')).toHaveAttribute('data-account-kind', 'venue');
      await expect(page.getByTestId('blotter')).toContainText('Aucune position.');
      // the server refuses an order on a READ_ONLY account whatever the screen does
      const direct = await page.evaluate(async () => { const id = (await (await fetch('/api/v1/derivatives/live/accounts')).json()).accounts[0].id;
        const r = await fetch(`/api/v1/derivatives/live/accounts/${id}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spw-csrf': '1', 'idempotency-key': `e2e-${crypto.randomUUID()}` }, body: JSON.stringify({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '50000' }) });
        return { status: r.status, error: (await r.json()).error }; });
      expect(direct).toEqual({ status: 422, error: 'mode_read_only' });

      // ---- what happened on the wire
      await page.waitForTimeout(1500);
      const traffic = JSON.parse(readFileSync(TRAFFIC, 'utf8')) as Record<string, number>;
      console.log(`[live-real ${size.name}] outgoing requests of the backend: ${JSON.stringify(traffic)}`);
      console.log(`[live-real ${size.name}] API answers ≥ 400 seen by the page: ${JSON.stringify(refused)}`);
      expect(Object.keys(traffic).filter((k) => k.startsWith('REFUSED'))).toEqual([]);          // nothing even tried the mainnet exchange endpoint
      expect(traffic['api.hyperliquid.xyz/exchange']).toBeUndefined();
      expect(traffic['api.hyperliquid-testnet.xyz/exchange']).toBe(1);                         // exactly one action reached the testnet: the approveAgent the venue refused
      expect(refused.filter((r) => !/^422 .*authorization\/approve$/.test(r) && !/^422 .*\/orders$/.test(r))).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

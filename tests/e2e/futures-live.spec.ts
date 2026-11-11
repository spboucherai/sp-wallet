import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Controlled LIVE trading screens of the Futures terminal against the in-browser mock (`?mock=1`, development build only):
// no backend, no venue, no signer, a simulated passkey — see apps/web/src/derivatives/mockLive.ts for what is real in it
// (canonical objects and hashes, acknowledgement text, risk engine, order of the backend's checks) and what is not.
// The spec starts its own Vite dev server (or uses FUTURES_URL). FUTURES_SHOTS=1 writes docs/v4/screens/live-*.png.
//   npx playwright test -c tests/e2e/playwright.config.ts futures-live.spec.ts
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5190;
const BASE = process.env.FUTURES_URL ?? `http://localhost:${PORT}`;
const SHOTS = resolve(ROOT, 'docs/v4/screens');
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

const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(String(e))); return errors; };
const mark = (page: Page, id = 'hyperliquid:BTC') => page.evaluate(async (i) => Number((await (await fetch(`/api/v1/derivatives/market?instrument=${encodeURIComponent(i)}`)).json()).ticker.mark), id);
type Hook = 'mainnet' | 'fund' | 'passkey' | 'venue' | 'signerOffsetBps' | 'signerDown' | 'ttl' | 'diverge' | 'settle' | 'unreadable';
const hook = (page: Page, name: Hook, ...args: unknown[]) => page.evaluate(([n, a]) => (window as any).__spwMock.live[n as string](...(a as unknown[])), [name, args] as const);
const liveAccounts = (page: Page): Promise<{ id: string; network: string; mode: string; orders: number }[]> => page.evaluate(() => (window as any).__spwMock.live.accounts());

const SIZES = [
  { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;

for (const size of SIZES) {
  const phone = size.name === 'phone';
  test.describe(`futures live — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA' });
    const shot = async (page: Page, name: string, fullPage = false) => {
      if (process.env.FUTURES_SHOTS !== '1') return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/live-${size.name}-${name}.png`, fullPage });
    };
    const panel = async (page: Page, name: 'Graphique' | 'Carnet' | 'Ordre' | 'Positions') => { if (phone) await page.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click(); };
    const view = async (page: Page, name: 'Terminal' | 'Comptes') => { await page.getByRole('tablist', { name: 'Vues' }).getByRole('tab', { name }).click(); };
    const blotterTab = (page: Page, name: RegExp) => page.getByTestId('blotter').getByRole('tab', { name }).click();
    const openAccounts = async (page: Page) => { await page.goto(`${BASE}/futures?v=accounts&mock=1`); await expect(page.getByTestId('live-card')).toBeVisible(); await expect(page.getByTestId('live-create-testnet')).toBeVisible(); };
    /** the limits form with room for the test orders, then the review, the acknowledgement and the (simulated) passkey */
    const authorize = async (page: Page, card: Locator, o: { shots?: boolean } = {}) => {
      await card.getByTestId('authorize').click();
      const sheet = page.getByTestId('authorize-sheet');
      await expect(sheet).toHaveAttribute('data-step', 'form');
      if (o.shots) await shot(page, '03-authorize-form');
      // the per-order limit may not exceed the per-position limit: the form says so and offers nothing to approve
      await sheet.getByRole('textbox', { name: 'Valeur maximale par ordre' }).fill('200');
      await expect(sheet.getByTestId('policy-problem')).toContainText('ne peut pas dépasser la limite par position');
      await expect(sheet.getByRole('button', { name: /Continuer/ })).toBeDisabled();
      await sheet.getByRole('textbox', { name: 'Position maximale par marché' }).fill('400');
      await sheet.getByRole('textbox', { name: 'Exposition brute maximale' }).fill('600');
      await sheet.getByRole('button', { name: /Continuer/ }).click();
      await expect(sheet).toHaveAttribute('data-step', 'review');
      // 1. the jurisdiction text, in full, in the screen's language; nothing can be approved before it is acknowledged
      await expect(sheet.getByTestId('ack-text')).toContainText('Hyperliquid — conditions de la plateforme et votre juridiction (Québec, Canada)');
      await expect(sheet.getByTestId('ack-text')).toContainText('En approuvant, vous confirmez avoir lu ce résumé');
      await expect(sheet.getByTestId('auth-approve')).toBeDisabled();
      // 2. what is signed, 3. the trading key, what it can and cannot do, 4. the limits as the server recorded them
      await expect(sheet.getByTestId('what-is-signed')).toContainText('approveAgent');
      await expect(sheet.getByTestId('agent-can')).toContainText('placer des ordres');
      await expect(sheet.getByTestId('agent-can')).toContainText('retirer des fonds');
      await expect(sheet.getByTestId('policy-rows')).toContainText(/200,00\s\$/);
      await expect(sheet.getByTestId('integrity')).toHaveCount(0);
      if (o.shots) await shot(page, '04-authorize-review');
      await sheet.getByTestId('ack-check').check();
      if (o.shots) { await sheet.getByTestId('auth-approve').scrollIntoViewIfNeeded(); await shot(page, '05-authorize-ready'); }
      await sheet.getByTestId('auth-approve').click();
    };
    const setup = async (page: Page, o: { shots?: boolean } = {}) => {
      await openAccounts(page);
      await page.getByTestId('live-create-testnet').getByRole('button', { name: 'Créer le compte testnet' }).click();
      const card = page.getByTestId('live-account-testnet');
      await expect(card).toHaveAttribute('data-mode', 'READ_ONLY');
      await authorize(page, card, o);
      await expect(card).toHaveAttribute('data-mode', 'MANUAL_LIVE', { timeout: 10_000 });
      return card;
    };
    const toTerminal = async (page: Page) => {
      await view(page, 'Terminal');
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'testnet');
      await panel(page, 'Ordre');
      await expect(page.getByTestId('order-panel')).toHaveAttribute('data-account-kind', 'venue');
    };
    const form = async (page: Page, o: { kind?: 'Au marché' | 'À cours limité'; price?: string; size: string; side?: 'Short' }) => {
      const p = page.getByTestId('order-panel');
      if (o.side) await p.getByRole('radio', { name: o.side }).click();
      if (o.kind) await p.getByRole('radio', { name: o.kind, exact: true }).click();
      if (o.price !== undefined) await p.getByRole('textbox', { name: /Prix limite/ }).fill(o.price);
      await p.getByRole('textbox', { name: 'Taille' }).fill(o.size);
    };
    const review = async (page: Page) => {
      await expect(page.getByTestId('preview')).toContainText('Valeur notionnelle');
      await expect(page.getByTestId('live-review')).toBeEnabled();
      await page.getByTestId('live-review').click();
      const sheet = page.getByTestId('approval-sheet');
      await expect(sheet).toHaveAttribute('data-phase', 'ready');
      return sheet;
    };
    const approve = async (sheet: Locator) => { await sheet.getByRole('button', { name: /Approuver avec la clé d’accès/ }).click(); };
    const limitPrice = async (page: Page, factor: number) => String(Math.round((await mark(page)) * factor));

    test('testnet: create → authorise → limit order open → cancel → market → position → halt blocks a new order, allows the close → revoke', async ({ page }) => {
      test.setTimeout(150_000);
      const errors = errorsOf(page);
      await openAccounts(page);
      // before anything: off, mainnet shown and blocked with the reason, nothing that pretends
      const live = page.getByTestId('live-card');
      await expect(live.getByTestId('live-status')).toContainText('désactivée');
      await expect(live.getByTestId('mainnet-setting')).toContainText('n’est pas un interrupteur de cette interface');
      await expect(live.getByTestId('live-create-mainnet').getByRole('button', { name: 'Créer le compte réel' })).toBeDisabled();
      await expect(live.getByTestId('mainnet-blocked')).toContainText('le serveur garde le réseau principal désactivé');
      await live.scrollIntoViewIfNeeded();
      await shot(page, '01-accounts-off');
      await live.getByRole('button', { name: 'Créer le compte testnet' }).click();
      const card = page.getByTestId('live-account-testnet');
      await expect(card).toHaveAttribute('data-mode', 'READ_ONLY');
      await expect(card.getByTestId('mode-band')).toHaveAttribute('data-tone', 'testnet');
      await expect(card.getByTestId('mode-band')).toContainText(/Testnet — argent fictif/i);
      await expect(card.getByTestId('venue-state')).toContainText(/1\s000,00\s\$/);
      await expect(card.getByTestId('venue-state')).toContainText('plateforme');
      await expect(card.getByTestId('trading-key')).toContainText('0x7e57');
      await expect(card.getByTestId('trading-key')).toContainText('Elle ne peut ni retirer des fonds');
      // funding is explained, never offered: deposits and withdrawals are not built
      await expect(card.getByTestId('funding-box')).toContainText('« Déposer » et « Retirer » se font ci-dessous');
      await expect(card.getByTestId('funding-box').getByRole('button')).toHaveCount(0);
      await card.scrollIntoViewIfNeeded();
      await shot(page, '02-account-readonly', true);
      await authorize(page, card, { shots: true });
      await expect(card).toHaveAttribute('data-mode', 'MANUAL_LIVE', { timeout: 10_000 });
      await expect(live.getByTestId('live-status')).toContainText('autorisée');
      await expect(card.getByTestId('live-authorization')).toContainText('BTC');
      await card.scrollIntoViewIfNeeded();
      await shot(page, '06-account-authorized', true);

      // ---- the terminal: the band says which money, permanently
      await toTerminal(page);
      const band = page.getByTestId('terminal').getByTestId('mode-band').first();
      await expect(band).toContainText(/Testnet — argent fictif/i);
      await expect(band.getByRole('button')).toHaveCount(0);                                  // nothing dismisses it
      await expect(page.getByTestId('paper-banner')).toContainText('Compte TESTNET');
      await expect(page.getByTestId('order-panel').getByTestId('free-collateral')).toContainText(/1\s000,00\s\$/);

      // ---- limit order: preview → proposal → the canonical order → passkey → open (from the server)
      await form(page, { price: await limitPrice(page, 0.99), size: '0,001' });
      await expect(page.getByTestId('preview')).toContainText('estimation');
      await shot(page, '07-order-preview', phone);
      let sheet = await review(page);
      await expect(page.getByTestId('live-review')).toBeDisabled();                           // a proposal is pending: no second one
      const canonical = sheet.getByTestId('canonical');
      await expect(canonical).toContainText('hyperliquid:BTC');
      await expect(canonical).toContainText('Achat');
      await expect(canonical).toContainText('Limite');
      await expect(canonical).toContainText('0,001 BTC');
      await expect(canonical).toContainText('jusqu’à annulation (GTC)');
      await expect(canonical).toContainText('testnet');
      await expect(sheet.getByTestId('countdown')).toContainText(/Approbation possible encore 1:\d\d/);
      await expect(sheet.getByTestId('mode-band')).toHaveAttribute('data-tone', 'testnet');
      await shot(page, '08-approve-sheet');
      await approve(sheet);
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'open', { timeout: 10_000 });
      await expect(sheet.getByTestId('live-outcome')).toContainText('Ordre ouvert sur la plateforme');
      await shot(page, '09-order-open');
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await expect(page.getByTestId('order-panel').getByTestId('live-outcome')).toHaveAttribute('data-state', 'open');
      await panel(page, 'Positions');
      const blotter = page.getByTestId('blotter');
      await blotterTab(page, /^Ordres ouverts \(1\)/);
      await expect(blotter).toContainText('ouvert');
      await expect(blotter).toContainText('plateforme');
      await shot(page, '10-open-order', phone);
      await blotter.getByRole('button', { name: 'Annuler l’ordre sur BTC' }).click();          // no passkey
      await expect(blotter).toContainText('Aucun ordre ouvert.');
      await blotterTab(page, /^Historique/);
      await expect(blotter.locator('[data-state="cancelled"]').first()).toBeVisible();

      // ---- market order: it is a limit IOC at its worst price, and the sheet says so
      await panel(page, 'Ordre');
      await form(page, { kind: 'Au marché', size: '0,002' });
      sheet = await review(page);
      await expect(sheet.getByTestId('canonical')).toContainText('ordre au marché = limite « immédiat ou annulé » au pire prix');
      await expect(sheet.getByTestId('canonical')).toContainText('Pire prix accepté');
      await expect(sheet.getByTestId('canonical')).toContainText('immédiat ou annulé (IOC)');
      await approve(sheet);
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'filled', { timeout: 10_000 });
      await expect(sheet.getByTestId('live-outcome')).toContainText(/Ordre exécuté\s: 0,002 BTC à/);
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await panel(page, 'Positions');
      await blotterTab(page, /^Positions \(1\)/);
      await expect(blotter).toContainText('Long');
      await shot(page, '11-position', phone);
      await blotterTab(page, /^Exécutions/);
      await expect(blotter).toContainText('Achat');

      // ---- halt: a new order is refused, the close still passes
      await panel(page, 'Ordre');
      await page.getByTestId('live-controls').getByRole('button', { name: 'Suspendre les nouveaux ordres' }).click();
      await expect(page.getByTestId('halt-banner').first()).toContainText('Négociation suspendue sur ce compte.');
      await form(page, { kind: 'À cours limité', price: await limitPrice(page, 0.99), size: '0,001' });
      await expect(page.getByTestId('risk-refusal')).toContainText('La négociation est suspendue sur ce compte');
      await expect(page.getByTestId('live-review')).toBeDisabled();
      await page.getByTestId('halt-banner').first().scrollIntoViewIfNeeded();
      await shot(page, '12-halted', phone);
      await panel(page, 'Positions');
      await blotterTab(page, /^Positions \(1\)/);
      await blotter.getByRole('button', { name: 'Fermer 100 % de la position BTC' }).click();
      sheet = page.getByTestId('approval-sheet');
      await expect(sheet).toHaveAttribute('data-phase', 'ready');
      await expect(sheet.getByTestId('canonical')).toContainText('Vente');
      await expect(sheet.getByTestId('canonical')).toContainText(/Réduction seulement\s*oui/);
      await shot(page, '13-close-sheet');
      await approve(sheet);
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'filled', { timeout: 10_000 });
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await expect(blotter).toContainText('Aucune position.');
      await blotterTab(page, /^Risque/);
      await expect(blotter).toContainText('Négociation suspendue');
      await panel(page, 'Ordre');
      await page.getByTestId('halt-banner').first().getByRole('button', { name: 'Reprendre la négociation' }).click();
      await expect(page.getByTestId('halt-banner')).toHaveCount(0);

      // ---- revoke: no passkey, the account is read-only again
      await view(page, 'Comptes');
      await page.getByTestId('live-account-testnet').getByTestId('revoke').click();
      const rv = page.getByTestId('revoke-sheet');
      await expect(rv).toContainText('pas même une annulation');
      await expect(rv.getByTestId('revoke-cancel-first')).toBeChecked();
      await shot(page, '14-revoke');
      await rv.getByRole('button', { name: 'Révoquer maintenant' }).click();
      await expect(rv.getByTestId('revoke-done')).toContainText('Autorisation révoquée');
      await rv.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await expect(page.getByTestId('live-account-testnet')).toHaveAttribute('data-mode', 'READ_ONLY');
      await view(page, 'Terminal');
      await panel(page, 'Ordre');
      await expect(page.getByTestId('live-readonly')).toContainText('révoquée');
      await expect(page.getByTestId('order-panel').getByRole('textbox')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });

    test('refusals: price band (risk engine, then signer), order notional, cancelled passkey, expired proposal', async ({ page }) => {
      test.setTimeout(150_000);
      await setup(page);
      await toTerminal(page);
      // far from the market: the risk engine refuses in the preview, and nothing can be reviewed
      await form(page, { price: await limitPrice(page, 0.9), size: '0,001' });
      await expect(page.getByTestId('risk-refusal')).toContainText('price_deviation');
      await expect(page.getByTestId('live-review')).toBeDisabled();
      // above the notional the signer will sign per order
      await form(page, { price: await limitPrice(page, 0.99), size: '0,01' });
      await expect(page.getByTestId('risk-refusal')).toContainText('order_notional_exceeded');
      await expect(page.getByTestId('risk-refusal')).toContainText('Le signataire plafonne chaque ordre');
      await expect(page.getByTestId('live-review')).toBeDisabled();
      await shot(page, '15-refused-notional', phone);
      // the signer's own price is elsewhere: the API accepts, the signer refuses at approval, the proposal is consumed
      await hook(page, 'signerOffsetBps', 1500);
      await form(page, { price: await limitPrice(page, 0.99), size: '0,001' });
      let sheet = await review(page);
      await approve(sheet);
      await expect(sheet).toHaveAttribute('data-phase', 'void', { timeout: 10_000 });
      await expect(sheet.getByTestId('live-error')).toHaveAttribute('data-code', 'signer_price');
      await expect(sheet.getByTestId('live-error')).toContainText('sort de la bande de prix');
      await expect(sheet.getByRole('button', { name: /Approuver avec la clé d’accès/ })).toHaveCount(0);
      await shot(page, '16-refused-signer');
      await hook(page, 'signerOffsetBps', 0);
      // a dismissed passkey prompt: nothing was sent, the proposal is withdrawn, "prepare again" makes a new one
      await hook(page, 'passkey', 'cancel');
      await sheet.getByTestId('prepare-again').click();
      await expect(sheet).toHaveAttribute('data-phase', 'ready');
      await approve(sheet);
      await expect(sheet.getByTestId('live-error')).toHaveAttribute('data-code', 'passkey_cancelled');
      await expect(sheet.getByTestId('live-error')).toContainText('Rien n’a été signé ni envoyé');
      await shot(page, '17-passkey-cancelled');
      await sheet.getByTestId('prepare-again').click();
      await expect(sheet).toHaveAttribute('data-phase', 'ready');
      await approve(sheet);
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'open', { timeout: 10_000 });
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      // an expired proposal cannot be approved: the button goes away, "prepare again" is offered
      await hook(page, 'ttl', 7000);
      await form(page, { price: await limitPrice(page, 0.99), size: '0,001' });
      sheet = await review(page);
      await expect(sheet).toHaveAttribute('data-phase', 'void', { timeout: 12_000 });
      await expect(sheet.getByTestId('live-error')).toHaveAttribute('data-code', 'proposal_expired');
      await expect(sheet.getByRole('button', { name: /Approuver avec la clé d’accès/ })).toHaveCount(0);
      await shot(page, '18-expired');
      await hook(page, 'ttl', 90_000);
      await sheet.getByRole('button', { name: 'Annuler', exact: true }).click();
      // every proposal of this test has its own key; the three that were given up are withdrawn or refused, one order rests
      await panel(page, 'Positions');
      await blotterTab(page, /^Ordres ouverts \(1\)/);
      await blotterTab(page, /^Historique/);
      const states = await page.getByTestId('blotter').locator('[data-state]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
      expect(states.filter((s) => s === 'open')).toHaveLength(1);
      expect(states.filter((s) => s === 'risk_checked' || s === 'proposed')).toHaveLength(0);
    });

    test('venue answers: unknown → reconciled, a venue refusal in its own words; double click makes one proposal; leverage change', async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page);
      await toTerminal(page);
      const before = (await liveAccounts(page))[0]!.orders;
      await form(page, { price: await limitPrice(page, 0.99), size: '0,001' });
      await expect(page.getByTestId('preview')).toContainText('Valeur notionnelle');
      await expect(page.getByTestId('live-review')).toBeEnabled();
      await page.getByTestId('live-review').dblclick();                                        // two clicks, one review, one Idempotency-Key
      let sheet = page.getByTestId('approval-sheet');
      await expect(sheet).toHaveAttribute('data-phase', 'ready');
      expect((await liveAccounts(page))[0]!.orders).toBe(before + 1);
      await hook(page, 'venue', 'unknown');
      await sheet.getByRole('button', { name: /Approuver avec la clé d’accès/ }).dblclick();     // two clicks, one prompt, one approval
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'unknown', { timeout: 10_000 });
      await expect(sheet.getByTestId('live-outcome')).toContainText('En cours de vérification auprès de la plateforme — ne pas renvoyer');
      await expect(sheet.getByTestId('prepare-again')).toHaveCount(0);                        // nothing that could send it again
      await shot(page, '19-unknown');
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'open', { timeout: 15_000 });   // resolved by reconciliation, from the server
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      expect((await liveAccounts(page))[0]!.orders).toBe(before + 1);
      // the venue refuses: its words are shown
      await hook(page, 'venue', 'reject');
      await form(page, { price: await limitPrice(page, 0.985), size: '0,001' });
      sheet = await review(page);
      await approve(sheet);
      await expect(sheet.getByTestId('live-outcome')).toHaveAttribute('data-state', 'rejected', { timeout: 10_000 });
      await expect(sheet.getByTestId('live-outcome')).toContainText('Order has invalid price.');
      await shot(page, '20-venue-rejected');
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      // leverage: a venue setting, changed with the passkey, read back from the venue
      const lev = page.getByTestId('venue-leverage');
      await expect(lev).toContainText('20×');
      await lev.getByRole('button', { name: 'Modifier…' }).click();
      const ls = page.getByTestId('leverage-sheet');
      await ls.getByRole('slider').fill('2');
      await ls.getByRole('button', { name: 'Préparer le changement' }).click();
      await expect(ls).toHaveAttribute('data-phase', 'ready');
      await expect(ls.getByTestId('canonical')).toContainText('2×');
      await shot(page, '21-leverage');
      await ls.getByRole('button', { name: /Approuver avec la clé d’accès/ }).click();
      await expect(ls.getByTestId('leverage-result')).toHaveAttribute('data-state', 'confirmed', { timeout: 10_000 });
      await ls.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await expect(lev).toContainText('2×', { timeout: 10_000 });
    });

    test('an unfunded account: the venue refuses the authorization, in its words, with the funding explanation', async ({ page }) => {
      await openAccounts(page);
      await hook(page, 'fund', 'testnet', '0');
      await page.getByTestId('live-create-testnet').getByRole('button', { name: 'Créer le compte testnet' }).click();
      const card = page.getByTestId('live-account-testnet');
      await expect(card.getByTestId('venue-state')).toContainText(/0,00\s\$/);
      await authorize(page, card);
      const sheet = page.getByTestId('authorize-sheet');
      await expect(sheet).toHaveAttribute('data-step', 'refused', { timeout: 10_000 });
      await expect(sheet.getByTestId('venue-words')).toContainText('Must deposit before performing actions. User: 0x5ad0');
      await expect(sheet.getByTestId('auth-refused')).toContainText('La plateforme a refusé d’enregistrer la clé de négociation.');
      await expect(sheet.getByTestId('auth-refused')).toContainText('n’accepte aucune action d’un compte qui n’a jamais reçu de dépôt');
      await expect(sheet.getByTestId('funding-box')).toContainText('robinet');
      await shot(page, '22-unfunded');
      await sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
      await expect(card).toHaveAttribute('data-mode', 'READ_ONLY');
      await expect(page.getByTestId('live-status')).toContainText('désactivée');
    });

    test('mainnet: real-money band when enabled; blocked with the reason when the server setting is off; divergence; English', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(`${BASE}/futures?v=accounts&mock=1&mainnet=1`);                         // the mock starts with the server setting ON
      await expect(page.getByTestId('live-create-mainnet').getByRole('button', { name: 'Créer le compte réel' })).toBeEnabled();
      await expect(page.getByTestId('mainnet-setting')).toHaveCount(0);
      await page.getByTestId('live-create-mainnet').getByRole('button', { name: 'Créer le compte réel' }).click();
      const card = page.getByTestId('live-account-mainnet');
      await expect(card.getByTestId('mode-band')).toHaveAttribute('data-tone', 'mainnet');
      await expect(card.getByTestId('mode-band')).toContainText(/Réel — argent réel/i);
      await authorize(page, card);
      await expect(card).toHaveAttribute('data-mode', 'MANUAL_LIVE', { timeout: 10_000 });
      await view(page, 'Terminal');
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'mainnet');
      await expect(page.getByTestId('terminal').getByTestId('mode-band').first()).toContainText(/Réel — argent réel/i);
      await panel(page, 'Ordre');
      await expect(page.getByTestId('live-foot')).toContainText('ARGENT RÉEL');
      await form(page, { price: await limitPrice(page, 0.99), size: '0,001' });
      const sheet = await review(page);
      await expect(sheet.getByTestId('mode-band')).toHaveAttribute('data-tone', 'mainnet');
      await expect(sheet.getByRole('button', { name: 'Approuver avec la clé d’accès — ARGENT RÉEL' })).toBeVisible();
      await shot(page, '23-real-approve');
      await sheet.getByRole('button', { name: 'Annuler', exact: true }).click();              // withdraws the proposal: nothing is signed
      await expect(sheet).toHaveCount(0);
      if (phone) await page.getByRole('tab', { name: /^Graphique/ }).click();
      await shot(page, '24-real-terminal');
      // a difference with the venue stops new orders; "accept the venue's state" is explained and confirmed
      await panel(page, 'Ordre');
      await hook(page, 'diverge', 'mainnet', 'position');
      const hb = page.getByTestId('halt-banner').first();
      await expect(hb).toHaveAttribute('data-kind', 'divergence', { timeout: 15_000 });
      await expect(hb).toContainText('ne concordent pas');
      await hb.scrollIntoViewIfNeeded();
      await shot(page, '25-divergence', phone);
      await hb.getByRole('button', { name: 'Revérifier maintenant' }).click();
      await expect(hb).toContainText('l’écart est toujours là');
      await hb.getByRole('button', { name: 'Accepter l’état de la plateforme…' }).click();
      await page.getByRole('dialog', { name: 'Accepter l’état de la plateforme' }).getByRole('button', { name: /Oui, prendre l’état de la plateforme/ }).click();
      await expect(page.getByTestId('halt-banner')).toHaveCount(0, { timeout: 10_000 });
      // the server setting goes off: the account is shown, every action is blocked with the reason
      await hook(page, 'mainnet', false);
      await expect(page.getByTestId('order-panel').getByTestId('mainnet-off')).toContainText('Réseau principal désactivé sur le serveur.', { timeout: 30_000 });
      await expect(page.getByTestId('order-panel').getByRole('textbox')).toHaveCount(0);
      const refused = await page.evaluate(async () => { const id = (window as any).__spwMock.live.accounts().find((a: any) => a.network === 'mainnet').id;
        const r = await fetch(`/api/v1/derivatives/live/accounts/${id}/orders/preview`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spw-csrf': '1' }, body: JSON.stringify({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '70000' }) });
        return { status: r.status, error: (await r.json()).error }; });
      expect(refused).toEqual({ status: 403, error: 'mainnet_disabled' });
      await shot(page, '26-mainnet-off', phone);
      await view(page, 'Comptes');
      await expect(page.getByTestId('live-account-mainnet').getByTestId('mainnet-off')).toBeVisible();
      await expect(page.getByTestId('live-account-mainnet').getByTestId('revoke')).toBeEnabled();   // stopping is always possible
      // English
      await page.getByRole('navigation').getByRole('button', { name: 'Réglages' }).click();
      await page.getByRole('radio', { name: 'English' }).click();
      await page.getByRole('navigation').getByRole('button', { name: 'Swap' }).click();
      await page.getByRole('tab', { name: 'Futures' }).click();
      await expect(page.getByTestId('terminal').getByTestId('mode-band').first()).toContainText(/Real — real money/i);
      await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: 'Accounts' }).click();
      await expect(page.getByTestId('live-account-mainnet')).toContainText('Main network disabled on the server.');
      await page.getByTestId('live-account-mainnet').scrollIntoViewIfNeeded();
      await shot(page, '27-english', true);
    });
  });
}

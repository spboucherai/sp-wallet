import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

// « Hyperliquid only, every asset, a simple order form » (2026-11-17) against the in-browser mock (`?mock=1`, development build
// only — apps/web/src/derivatives/mockLive.ts: no backend, no venue, no signer, a simulated passkey). Phone width, French.
//   1. one venue: no Compare, no Router, no venue filter, only Hyperliquid markets;
//   2. the authorization: « all assets » by default (179 pinned on mainnet), what a higher leverage leaves out, « choose » with a search;
//   3. the simple order: Long / Short, an amount in USD with quick amounts, the summary in plain words, the passkey, the position
//      as a card, « Fermer » in one tap;
//   4. an asset outside the authorization: said on the order panel, and the guided change (revoke → new authorization).
// The spec starts its own Vite dev server (or uses FUTURES_URL). Screenshots: test-results/hl-simple/*.png (always written).
//   npx playwright test -c tests/e2e/playwright.config.ts futures-hl-simple.spec.ts
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5196;
const BASE = process.env.FUTURES_URL ?? `http://localhost:${PORT}`;
const SHOTS = resolve(ROOT, 'test-results/hl-simple');
let vite: ChildProcess | null = null;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  if (process.env.FUTURES_URL) return;
  vite = spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the Vite dev server did not start');
});
test.afterAll(() => { vite?.kill(); });

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-CA', colorScheme: 'light' });
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(String(e))); return errors; };
const shot = async (page: Page, name: string, fullPage = false) => { await page.waitForTimeout(450); /* a sheet's opening spring */ await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }); };
const view = (page: Page, name: 'Terminal' | 'Comptes') => page.getByRole('tablist', { name: 'Vues' }).getByRole('tab', { name }).click();
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Panneaux' }).getByRole('tab', { name: new RegExp(`^${name}`) }).click();
const pinnedMainnet = (page: Page): Promise<{ instrument: string; maxLeverage: number }[]> => page.evaluate(async () => (await (await fetch('/api/v1/derivatives/live/config')).json()).pinnedAssets.mainnet);

/** the real account, created; the authorization sheet open on its form */
async function openAuthorize(page: Page): Promise<{ card: Locator; sheet: Locator }> {
  await page.goto(`${BASE}/futures?v=accounts&mock=1&mainnet=1`);
  await page.getByTestId('live-create-mainnet').getByRole('button', { name: 'Créer le compte réel' }).click();
  const card = page.getByTestId('live-account-mainnet');
  await expect(card).toHaveAttribute('data-mode', 'READ_ONLY');
  await card.getByTestId('authorize').click();
  const sheet = page.getByTestId('authorize-sheet');
  await expect(sheet).toHaveAttribute('data-step', 'form');
  return { card, sheet };
}
/** limits with room for the test orders, then the review, the acknowledgement and the (simulated) passkey */
async function finishAuthorize(page: Page, sheet: Locator, card: Locator) {
  await sheet.getByRole('textbox', { name: 'Valeur maximale par ordre' }).fill('200');
  await sheet.getByRole('textbox', { name: 'Position maximale par marché' }).fill('400');
  await sheet.getByRole('textbox', { name: 'Exposition brute maximale' }).fill('600');
  await sheet.getByTestId('auth-continue').click();
  await expect(sheet).toHaveAttribute('data-step', 'review');
  await expect(sheet.getByTestId('integrity')).toHaveCount(0);
  return async () => { await sheet.getByTestId('ack-check').check(); await sheet.getByTestId('auth-approve').click(); await expect(card).toHaveAttribute('data-mode', 'MANUAL_LIVE', { timeout: 10_000 }); };
}

test('one venue: Hyperliquid only — no Compare, no Router, no venue filter; every market of the picker is Hyperliquid’s', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`${BASE}/futures?mock=1`);
  await expect(page.getByTestId('terminal')).toBeVisible();
  const views = page.getByRole('tablist', { name: 'Vues' }).getByRole('tab');
  await expect(views).toHaveText(['Terminal', 'Comptes']);
  // the picker: search, favourites, every market — no venue to choose
  await page.getByTestId('market-picker').click();
  const rows = page.getByTestId('market-row');
  await expect(rows.first()).toBeVisible();
  const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
  expect(ids.length).toBeGreaterThan(20);
  expect(ids.every((i) => i.startsWith('hyperliquid:'))).toBe(true);
  await expect(page.getByTestId('market-count')).toContainText(`${ids.length} marchés`);
  await expect(page.getByRole('radiogroup', { name: 'Filtrer par plateforme' }).getByRole('radio')).toHaveCount(2);      // « Tous », « ★ Favoris »
  await expect(rows.first()).toContainText(/Volume 24 h/);
  await shot(page, '01-picker');
  await page.getByRole('searchbox', { name: 'Rechercher un marché' }).fill('sol');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page.getByTestId('market-header')).toContainText('SOL-USD');
  // the addresses of the cross-venue views open the terminal; a market of a venue that is not offered opens the default one
  for (const v of ['compare', 'router']) { await page.goto(`${BASE}/futures?v=${v}&mock=1`); await expect(page.getByTestId('terminal')).toBeVisible(); await expect(page.getByRole('tablist', { name: 'Vues' }).getByRole('tab', { selected: true })).toHaveText('Terminal'); }
  await page.goto(`${BASE}/futures/${encodeURIComponent('dydx:BTC-USD')}?mock=1`);
  await expect(page.getByTestId('market-header')).toContainText('BTC-USD');
  await expect(page.getByTestId('market-header')).toContainText('Hyperliquid');
  // the accounts view: Hyperliquid alone among the venues, no GMX card
  await view(page, 'Comptes');
  await expect(page.getByTestId('live-card')).toBeVisible();
  await expect(page.getByTestId('venue-list').getByRole('listitem')).toHaveCount(1);
  await expect(page.getByTestId('venue-list')).toContainText('Hyperliquid');
  await expect(page.getByText(/GMX|dYdX|edgeX/)).toHaveCount(0);
  await shot(page, '02-accounts', true);
  // the Markets hub: Explorer and Private markets — no Compare; no venue filter, no venue column; Hyperliquid's perpetuals only
  await page.goto(`${BASE}/markets?mock=1`);
  await expect(page.getByTestId('markets')).toBeVisible();
  await expect(page.getByTestId('mk-open').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Comparer' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Comparer' })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Plateforme' })).toHaveCount(0);
  await expect(page.getByTestId('markets').getByText(/GMX|dYdX|edgeX/)).toHaveCount(0);
  await shot(page, '08-markets');
  await page.goto(`${BASE}/markets?v=compare&mock=1`);
  await expect(page.getByTestId('mk-search')).toBeVisible();                                   // the Compare address opens the explorer
  expect(errors).toEqual([]);
});

test('authorization: « all assets » by default, what a higher leverage leaves out, « choose » with a search', async ({ page }) => {
  const errors = errorsOf(page);
  const { card, sheet } = await openAuthorize(page);
  const pinned = await pinnedMainnet(page);
  expect(pinned.length).toBeGreaterThan(150);                                                 // the venue's whole own dex
  // default: all assets, at leverage 2 — nothing is left out
  await expect(sheet.getByTestId('auth-scope-all')).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByTestId('auth-all-count')).toHaveAttribute('data-n', String(pinned.length));
  await expect(sheet.getByTestId('auth-all-count')).toContainText(`Les ${pinned.length} actifs de Hyperliquid sont autorisés`);
  await expect(sheet.getByTestId('auth-left-out')).toHaveCount(0);
  await shot(page, '03-authorize-all');
  // a higher leverage: the assets whose venue maximum is lower are left out — how many, which, and how to include them
  const lev = sheet.getByRole('textbox', { name: 'Levier maximal' });
  await lev.fill('5');
  const out = pinned.filter((p) => p.maxLeverage < 5);
  expect(out.length).toBeGreaterThan(0);
  await expect(sheet.getByTestId('auth-all-count')).toHaveAttribute('data-n', String(pinned.length - out.length));
  await expect(sheet.getByTestId('auth-left-out')).toHaveAttribute('data-n', String(out.length));
  await expect(sheet.getByTestId('auth-left-out')).toContainText(`Laissés de côté : ${out.length}`);
  await expect(sheet.getByTestId('auth-left-out')).toContainText(out[0]!.instrument.replace('hyperliquid:', ''));
  await sheet.getByTestId('auth-left-out').scrollIntoViewIfNeeded();
  await shot(page, '04-authorize-left-out');
  // « choose »: a searchable list; an asset below the leverage is flagged and the form refuses it with the reason
  await sheet.getByTestId('auth-scope-choose').click();
  await expect(sheet.getByTestId('auth-ticked')).toHaveAttribute('data-n', '1');                // BTC, the starting tick
  await sheet.getByTestId('auth-asset-search').fill(out[0]!.instrument.replace('hyperliquid:', ''));
  await sheet.locator(`[data-testid="auth-asset"][data-id="${out[0]!.instrument}"]`).check();
  await expect(sheet.getByTestId('auth-too-low')).toContainText('Hyperliquid ne permet pas 5×');
  await expect(sheet.getByTestId('auth-continue')).toBeDisabled();
  await sheet.getByTestId('auth-asset-list').scrollIntoViewIfNeeded();
  await shot(page, '05-authorize-choose');
  // back to « all » at leverage 2: every asset, and the review names them all (nothing folded before an approval)
  await sheet.getByTestId('auth-scope-all').click();
  await lev.fill('2');
  const approve = await finishAuthorize(page, sheet, card);
  await expect(sheet.getByTestId('policy-assets-count')).toHaveText(`Tous les actifs (${pinned.length})`);
  const names = (await sheet.getByTestId('policy-assets').innerText()).split(', ');
  expect(names.length).toBe(pinned.length);
  expect(names).toEqual(pinned.map((p) => p.instrument.replace('hyperliquid:', '')));
  await sheet.getByTestId('policy-rows').scrollIntoViewIfNeeded();
  await shot(page, '06-authorize-review-assets');
  await approve();
  await expect(card.getByTestId('live-authorization').getByTestId('policy-assets-count')).toHaveText(`Tous les actifs (${pinned.length})`);
  await expect(card.getByTestId('change-assets')).toBeVisible();
  await card.getByTestId('live-authorization').scrollIntoViewIfNeeded();
  await shot(page, '07-account-authorized');
  expect(errors).toEqual([]);
});

test('simple order: Long, an amount in USD, the summary in plain words, the passkey, the position card, « Fermer » in one tap', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = errorsOf(page);
  const { card, sheet } = await openAuthorize(page);
  await (await finishAuthorize(page, sheet, card))();
  await view(page, 'Terminal');
  const term = page.getByTestId('terminal');
  await expect(term).toHaveAttribute('data-tone', 'mainnet');
  // a venue account in simple mode opens on the order form: Ordre · Positions · Graphique · Carnet
  await expect(page.getByRole('tablist', { name: 'Panneaux' }).getByRole('tab').first()).toHaveText('Ordre');
  await expect(page.getByRole('tablist', { name: 'Panneaux' }).getByRole('tab', { selected: true })).toHaveText('Ordre');
  const panel = page.getByTestId('order-panel'), form = page.getByTestId('simple-form');
  await expect(page.getByTestId('order-level')).toHaveAttribute('data-level', 'simple');
  await expect(form).toHaveAttribute('data-unit', 'usd');
  await expect(form.getByTestId('simple-side-buy')).toHaveAttribute('aria-checked', 'true');
  await expect(form.getByTestId('simple-why')).toHaveText('Entrez un montant pour continuer.');
  await expect(page.getByTestId('live-review')).toBeDisabled();
  await expect(page.getByTestId('position-none')).toBeVisible();
  await shot(page, '10-simple-empty');
  // below the venue minimum: said, nothing to review
  await form.getByTestId('simple-amount').fill('5');
  await expect(form.getByTestId('simple-min')).toContainText('Le minimum sur Hyperliquid est de 10,00');
  await expect(page.getByTestId('live-review')).toBeDisabled();
  // a quick amount: the size is derived and shown, the server's preview gives the figures
  await form.getByTestId('simple-chip').filter({ hasText: /^100\s\$$/ }).click();
  await expect(form.getByTestId('simple-amount')).toHaveValue('100');
  await expect(form.getByTestId('simple-derived')).toContainText(/Soit 0,\d+ BTC, au prix actuel de/);
  await expect(form.getByTestId('simple-derived')).toContainText(/Votre limite par ordre : 200,00\s\$/);
  const preview = page.getByTestId('preview');
  await expect(form.getByTestId('simple-sentence')).toContainText(/Vous achetez 0,\d+ BTC, soit environ \d+,\d\d\s\$/);
  await expect(preview).toContainText('Marge immobilisée'); await expect(preview).toContainText('Frais, au plus'); await expect(preview).toContainText('Liquidation estimée');
  await expect(form.getByTestId('simple-liq')).toHaveAttribute('data-ok', '1');
  await expect(page.getByTestId('live-review')).toHaveText('Vérifier l’achat de BTC');
  await page.getByTestId('live-review').scrollIntoViewIfNeeded();
  await shot(page, '11-simple-filled');
  // the size sent is the amount ÷ the mark, rounded down to the lot: never more than what was typed
  const sizeText = (await form.getByTestId('simple-sentence').innerText()).match(/Vous achetez (0,\d+) BTC/)![1]!;
  const markNow = await page.evaluate(async () => Number((await (await fetch('/api/v1/derivatives/market?instrument=hyperliquid%3ABTC')).json()).ticker.mark));
  expect(Number(sizeText.replace(',', '.')) * markNow).toBeLessThanOrEqual(100 * 1.006);        // within the 0.5 % re-computation band
  expect(Number(sizeText.replace(',', '.')) * markNow).toBeGreaterThan(98);
  // the approval: one plain sentence written from the canonical order, the canonical order itself, the estimate, then the passkey
  await page.getByTestId('live-review').click();
  const approval = page.getByTestId('approval-sheet');
  await expect(approval).toHaveAttribute('data-phase', 'ready');
  await expect(approval.getByTestId('approval-plain')).toContainText(new RegExp(`Vous achetez ${sizeText} BTC \\(environ \\d+,\\d\\d\\s\\$\\) au prix du marché, au pire à`));
  await expect(approval.getByTestId('approval-liq')).toBeVisible();
  await expect(approval.getByRole('button', { name: 'Approuver avec la clé d’accès — ARGENT RÉEL' })).toBeVisible();
  await shot(page, '12-simple-approval');
  await approval.getByRole('button', { name: /Approuver avec la clé d’accès/ }).click();
  await expect(approval).toHaveAttribute('data-phase', 'done', { timeout: 15_000 });
  await approval.getByRole('button', { name: 'Fermer', exact: true }).last().click();
  await expect(approval).toHaveCount(0);
  await expect(form.getByTestId('simple-amount')).toHaveValue('');                              // the amount starts again from nothing
  // the position, as a card: direction, value, gain or loss in words, and « Fermer » in one tap
  const pos = page.getByTestId('position-card');
  await expect(pos).toHaveCount(1, { timeout: 15_000 });
  await expect(pos).toHaveAttribute('data-id', 'hyperliquid:BTC');
  await expect(pos).toContainText('Long'); await expect(pos.getByTestId('position-pnl')).toContainText(/gain|perte|à l’équilibre/);
  await pos.scrollIntoViewIfNeeded();
  await shot(page, '13-position-card');
  // an order against the position is said to reduce it; a second order has no liquidation estimate of its own (the venue gives the position's)
  await form.getByTestId('simple-side-sell').click();
  await form.getByTestId('simple-amount').fill('20');
  await expect(form.getByTestId('simple-against')).toContainText('à l’inverse de votre position actuelle sur BTC');
  await expect(form.getByTestId('simple-liq')).toHaveAttribute('data-ok', '0');
  await form.getByTestId('simple-amount').fill('');
  // a risk refusal is shown with its code and the server's sentence
  await form.getByTestId('simple-side-buy').click();
  await form.getByTestId('simple-unit').click();                                                // enter in BTC
  await expect(form).toHaveAttribute('data-unit', 'coin');
  await form.getByTestId('simple-amount').fill('0,003');                                        // about 220 USD: above the 200 USD per-order limit
  await expect(page.getByTestId('risk-refusal')).toContainText('order_notional_exceeded', { timeout: 10_000 });
  await expect(page.getByTestId('live-review')).toBeDisabled();
  await page.getByTestId('risk-refusal').scrollIntoViewIfNeeded();
  await shot(page, '14-simple-refused');
  await form.getByTestId('simple-amount').fill('');
  // close: one tap opens the approval of a reduce-only order on the whole position; the passkey is still asked
  await pos.getByTestId('position-close').click();
  const closing = page.getByTestId('approval-sheet');
  await expect(closing).toHaveAttribute('data-phase', 'ready');
  await expect(closing.getByTestId('approval-plain')).toContainText(/Vous fermez 0,\d+ BTC de votre position/);
  await expect(closing.getByTestId('canonical')).toContainText('Réduction seulement');
  await shot(page, '15-close-approval');
  await closing.getByRole('button', { name: /Approuver avec la clé d’accès/ }).click();
  await expect(closing).toHaveAttribute('data-phase', 'done', { timeout: 15_000 });
  await closing.getByRole('button', { name: 'Fermer', exact: true }).last().click();
  await expect(page.getByTestId('position-none')).toBeVisible({ timeout: 15_000 });
  // « Avancé » keeps the full form
  await panel.getByRole('radio', { name: 'Avancé' }).click();
  await expect(page.getByTestId('simple-form')).toHaveCount(0);
  await expect(panel.getByRole('radio', { name: 'À cours limité', exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Taille' })).toBeVisible();
  await tab(page, 'Positions');
  await expect(page.getByTestId('blotter')).toHaveAttribute('data-account-kind', 'venue');
  expect(errors).toEqual([]);
});

test('an asset outside the authorization: said on the order panel, then the guided change — revoke, new authorization, one passkey prompt', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = errorsOf(page);
  const { card, sheet } = await openAuthorize(page);
  // an authorization for BTC alone (« choose », the starting tick)
  await sheet.getByTestId('auth-scope-choose').click();
  await expect(sheet.getByTestId('auth-ticked')).toHaveAttribute('data-n', '1');
  const approve = await finishAuthorize(page, sheet, card);
  await expect(sheet.getByTestId('policy-assets-count')).toHaveText('BTC');
  await approve();
  await expect(card.getByTestId('live-authorization')).toContainText('Autorisés aujourd’hui : 1 sur');
  await view(page, 'Terminal');
  await expect(page.getByTestId('simple-form')).toBeVisible();
  // the picker says which markets are outside the authorization; ETH can still be opened
  await page.getByTestId('market-picker').click();
  const eth = page.locator('[data-testid="market-row"][data-id="hyperliquid:ETH"]');
  await expect(eth.getByTestId('market-unauthorized')).toContainText('hors autorisation');
  await expect(page.locator('[data-testid="market-row"][data-id="hyperliquid:BTC"]').getByTestId('market-unauthorized')).toHaveCount(0);
  await shot(page, '20-picker-unauthorized');
  await eth.click();
  await expect(page.getByTestId('market-header')).toContainText('ETH-USD');
  // no order form: the reason, and one button to add the asset
  await expect(page.getByTestId('simple-form')).toHaveCount(0);
  await expect(page.getByTestId('live-not-allowed')).toContainText('ETH n’est pas dans votre autorisation');
  await shot(page, '21-not-allowed');
  await page.getByTestId('live-add-asset').click();
  const change = page.getByTestId('authorize-sheet');
  await expect(change).toHaveAttribute('data-replace', 'true');
  await expect(change.getByTestId('auth-change-intro')).toContainText('l’autorisation actuelle est retirée, puis vous approuvez la nouvelle avec votre clé d’accès (une seule demande)');
  await expect(change.getByTestId('auth-scope-all')).toHaveAttribute('aria-checked', 'true');   // all assets is the proposal
  await expect(change.getByRole('textbox', { name: 'Valeur maximale par ordre' })).toHaveValue('200');   // the present limits are kept
  await expect(change.getByTestId('auth-continue')).toHaveText('Retirer l’ancienne et préparer la nouvelle');
  await shot(page, '22-change-form');
  await change.getByTestId('auth-continue').click();
  await expect(change).toHaveAttribute('data-step', 'review');
  // from here until the approval the account is read-only, and the sheet says so
  await expect(change.getByTestId('auth-replaced')).toContainText('L’ancienne autorisation est retirée');
  expect((await page.evaluate(() => (window as any).__spwMock.live.accounts())).find((a: { network: string }) => a.network === 'mainnet').mode).toBe('READ_ONLY');
  await expect(change.getByTestId('policy-assets-count')).toContainText('Tous les actifs');
  await shot(page, '23-change-review');
  await change.getByTestId('ack-check').check();
  await change.getByTestId('auth-approve').click();
  await expect(change).toHaveCount(0, { timeout: 10_000 });
  // ETH can now be traded
  await expect(page.getByTestId('live-not-allowed')).toHaveCount(0);
  await expect(page.getByTestId('simple-form')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('simple-amount').fill('50');
  await expect(page.getByTestId('simple-sentence')).toContainText(/Vous achetez 0,\d+ ETH/);
  await expect(page.getByTestId('live-review')).toBeEnabled();
  await page.getByTestId('live-review').scrollIntoViewIfNeeded();
  await shot(page, '24-eth-allowed');
  expect(errors).toEqual([]);
});

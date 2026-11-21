/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/next-web.spec.ts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// NEXT web — the core screens on a real local stack (real API, real isolated signer, throwaway keystore and database,
// broadcast off). What a throwaway wallet cannot show — holdings, a value history, movements, a second passkey — is laid over
// the real answers with the fixtures of tests/e2e/fixtures/next/wallet.ts; everything else (asset preferences, contacts,
// sessions, settings, the session itself) goes through the REAL routes.
//
//   tests/e2e/ui-stack.sh nextweb 8870
//   SPW_E2E_BASE=http://localhost:8870 SPW_DEV_DIR=/tmp/spw-ui-nextweb pnpm e2e next-web.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { ADDR, fixtureTotal, IDS, movements, populate, timeline } from './fixtures/next/wallet.ts';
import { roomInRateLimit } from './qa-helpers.ts';
import { deviceUse, expectNoOverflow, openWallet, type Session } from './v11-helpers.ts';

// one worker (playwright.config.ts): the tests share the stack's single owner account and run one after the other
test.use(deviceUse('desktop', 'fr'));
/** in-app navigation (no reload: the API allows 240 requests a minute per client, static files included) */
const nav = async (page: Page, path: string) => { await page.evaluate((p) => { history.pushState({ spw: 1 }, '', p); dispatchEvent(new PopStateEvent('popstate')); scrollTo(0, 0); }, path); };
const reload = async (page: Page) => { await roomInRateLimit(page, 80); await page.reload(); await page.getByTestId('balance-card').waitFor({ timeout: 30_000 }); };
const api = (page: Page, s: Session) => ({
  get: async (p: string) => (await page.request.get(`/api/v1${p}`)).json(),
  send: (method: 'post' | 'put' | 'patch' | 'delete', p: string, data?: unknown) => page.request[method](`/api/v1${p}`, { headers: s.headers(), data: data ?? {} }),
});

test('dashboard, populated: the server’s total, a partial total said plainly, the six ranges, the chart by keyboard, allocation by asset and by network', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL);
  await populate(page, { missing: 'solana' }); await reload(page);
  // the total is the SERVER's figure (the fixture's summary), written digit for digit — not a sum made on the client
  const total = page.getByTestId('total'); await expect(total).toHaveAttribute('data-total', /^\d+\.\d{2}$/);
  const shown = await total.getAttribute('data-total'); expect(Number(shown)).toBeLessThan(Number(fixtureTotal()));   // Solana is missing from it
  await expect(total).toContainText(new RegExp(`${shown!.split('.')[0]!.slice(-3)},${shown!.split('.')[1]}`));
  // partial: the chip on the card, the freshness line and the notice name what is missing
  await expect(page.getByTestId('total-partial')).toBeVisible(); await expect(page.getByTestId('freshness-partial')).toContainText(/Partiel : \d+ réseaux? indisponibles?/); await expect(page.getByTestId('partial-note')).toContainText('Solana');
  await expect(page.getByTestId('change-chip')).toContainText('24 h'); await expect(page.getByTestId('balances-at')).toContainText(/Soldes lus à/);
  // value history: the range selector is a radio group; a click and the arrow keys change the range
  const history = page.getByTestId('history'); await expect(history).toHaveAttribute('data-range', '1W', { timeout: 30_000 });
  await expect(page.getByTestId('value-chart')).toHaveAttribute('data-gaps', '1');                       // the 1W fixture has a hole: drawn as a hole
  await expect(page.getByTestId('history-omitted')).toBeVisible(); await expect(page.getByTestId('est-market')).toContainText('≈');
  await page.getByTestId('range').getByRole('radio', { name: '1 mois' }).click(); await expect(history).toHaveAttribute('data-range', '1M'); await expect(page.getByTestId('value-chart')).toHaveAttribute('data-gaps', '0');
  await page.keyboard.press('ArrowRight'); await expect(history).toHaveAttribute('data-range', '3M');
  await page.keyboard.press('End'); await expect(history).toHaveAttribute('data-range', 'ALL'); await page.keyboard.press('Home'); await expect(history).toHaveAttribute('data-range', '1D');
  for (const r of ['1 semaine', '1 mois', '3 mois', '1 an', 'tout l’historique']) await expect(page.getByTestId('range').getByRole('radio', { name: r })).toBeVisible();
  await expect(page.getByTestId('tiles')).toContainText('Sur 1 jour');
  // the chart is one tab stop: arrows scrub point by point, the value and its date are shown; Escape leaves
  const chart = page.getByTestId('value-chart'); await chart.focus(); await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('value-chart-tip')).toBeVisible(); await expect(page.getByTestId('value-chart-live')).toContainText('$'); const at = await chart.getAttribute('data-at');
  await page.keyboard.press('ArrowLeft'); expect(Number(await chart.getAttribute('data-at'))).toBe(Number(at) - 1);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('value-chart-tip')).toHaveCount(0);
  // allocation: by asset, then by network — the server's own split
  await expect(page.getByTestId('allocation')).toContainText('BTC'); await page.getByTestId('alloc-split').getByRole('radio', { name: 'Par réseau' }).click(); await expect(page.getByTestId('allocation')).toContainText('Ethereum');
  await expect(page.getByTestId('held-assets').getByTestId('asset-row')).toHaveCount(6); await expect(page.getByTestId('recent-activity').getByTestId('tx-row')).toHaveCount(5);
  // an internal deposit is not « received »: the swap's result is inside the swap, an agent's return is named
  await expect(page.getByTestId('recent-activity')).not.toContainText('Produit d’un échange');
  await expectNoOverflow(page, 'dashboard desktop');
  expect(s.errors()).toEqual([]);
});

test('dashboard on a phone: one column, nothing wider than the screen, the amount whole at 200 % text size', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWallet(page, context, baseURL); await populate(page); await reload(page);
  await expect(page.getByTestId('history')).toBeVisible({ timeout: 30_000 });
  await expectNoOverflow(page, 'dashboard phone');
  // the reader's text size doubled (the browser setting): sizes are in rem, the total wraps instead of being cut
  await page.addStyleTag({ content: 'html{font-size:200%}' }); await page.waitForTimeout(300);
  const fits = await page.getByTestId('total').evaluate((el) => { const r = el.getBoundingClientRect(), card = el.closest('[data-testid=balance-card]')!.getBoundingClientRect(); return { inCard: r.left >= card.left - 1 && r.right <= card.right + 1, clipped: el.scrollWidth > el.clientWidth + 1, size: parseFloat(getComputedStyle(el).fontSize) }; });
  expect(fits.inCard, 'the total stays inside its card').toBe(true); expect(fits.clipped, 'the total is not cut').toBe(false); expect(fits.size).toBeGreaterThan(50);
  const rowOk = await page.getByTestId('held-assets').getByTestId('asset-row').first().evaluate((el) => [...el.querySelectorAll('.amt')].every((x) => x.scrollWidth <= x.clientWidth + 1));
  expect(rowOk, 'amounts of a row are whole').toBe(true);
  expect((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))).toBeLessThanOrEqual(1);
});

test('assets: favourite and hide are kept by the server, optimistic with rollback; a hidden asset is said to be still counted', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL), a = api(page, s);
  await populate(page); await reload(page); await nav(page, '/assets');
  const held = page.getByTestId('assets-held'); await expect(held.getByTestId('asset-row')).toHaveCount(7, { timeout: 30_000 });
  // search by contract address
  await page.getByRole('searchbox').fill('0x833589fcd6'); await expect(held.getByTestId('asset-row')).toHaveCount(1); await expect(held).toContainText('USD Coin'); await page.getByRole('searchbox').fill('');
  const btc = held.locator('[data-asset="bitcoin:native"]');
  await btc.getByTestId('asset-fav').click(); await expect(btc.getByTestId('asset-fav')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => ((await a.get('/assets/prefs')).prefs as { network: string; favorite: boolean }[]).some((p) => p.network === 'bitcoin' && p.favorite)).toBe(true);
  await page.locator('[data-filter=fav]').click(); await expect(held.getByTestId('asset-row')).toHaveCount(1); await page.locator('[data-filter=all]').click();
  // hide: the row leaves « Vos actifs » for « Masqués », and the screen says it is still in the total
  await btc.getByTestId('asset-hide').click();
  const hidden = page.getByTestId('assets-hidden'); await expect(hidden.locator('[data-asset="bitcoin:native"]')).toBeVisible(); await expect(held.locator('[data-asset="bitcoin:native"]')).toHaveCount(0);
  await expect(page.getByTestId('hidden-note')).toContainText('restent comptés dans le total');
  await nav(page, '/'); await expect(page.getByTestId('held-more')).toContainText('1 actif masqué est compté dans le total'); await expect(page.getByTestId('held-assets').locator('[data-asset="bitcoin:native"]')).toHaveCount(0);
  await expect(page.getByTestId('total')).toHaveAttribute('data-total', fixtureTotal());   // hiding changed nothing to the total
  // a save that fails: the row goes back where it was, and the failure is said
  await nav(page, '/assets'); await page.route('**/api/v1/assets/prefs/**', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal","message":"x"}' }) : route.fallback()));
  const sol = page.getByTestId('assets-held').locator('[data-asset="solana:native"]'); await sol.getByTestId('asset-fav').click();
  await expect(page.getByTestId('pref-failed')).toBeVisible(); await expect(sol.getByTestId('asset-fav')).toHaveAttribute('aria-pressed', 'false');
  await page.unroute('**/api/v1/assets/prefs/**');
  // show it again from « Masqués »; leave the account as it was found
  await page.getByTestId('assets-hidden').locator('[data-asset="bitcoin:native"]').getByTestId('asset-hide').click(); await expect(page.getByTestId('assets-held').locator('[data-asset="bitcoin:native"]')).toBeVisible();
  await a.send('put', '/assets/prefs/bitcoin/native', { favorite: false, hidden: false });
  expect(s.errors().filter((e) => !/500/.test(e))).toEqual([]);
});

test('contacts: add, edit, favourite, the guarded change of address (old and new shown, stale and duplicate refused), delete — on the real routes', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL), a = api(page, s);
  for (const c of (await a.get('/contacts')).contacts as { id: string }[]) await a.send('delete', `/addressbook/${c.id}`);
  await nav(page, '/contacts'); await expect(page.getByText('Aucun contact')).toBeVisible({ timeout: 30_000 });
  const add = async (address: string, label: string) => { await page.getByTestId('contact-add').click(); await page.getByTestId('contact-address').fill(address); await page.getByTestId('contact-add-sheet').getByTestId('contact-label').fill(label); await page.getByTestId('contact-save').click(); };
  // a refused address is said in the sheet, nothing is created
  await add('0x1234', 'Faux'); await expect(page.getByTestId('contact-err')).toContainText('Adresse invalide'); await page.getByTestId('contact-address').fill(ADDR.rent); await page.getByTestId('contact-add-sheet').getByTestId('contact-label').fill('Loyer'); await page.getByTestId('contact-save').click();
  await expect(page.getByTestId('contact-row')).toHaveCount(1); await add(ADDR.friend, 'Mathieu'); await expect(page.getByTestId('contact-row')).toHaveCount(2);
  // edit: label, note, favourite
  await page.getByTestId('contact-row').filter({ hasText: 'Mathieu' }).getByRole('button').first().click();
  const sheet = page.getByTestId('contact-edit-sheet'); await sheet.getByTestId('contact-label').fill('Mathieu B.'); await sheet.getByTestId('contact-note').fill('Remboursements'); await sheet.getByTestId('contact-fav-toggle').click(); await sheet.getByTestId('contact-save').click();
  await expect(page.getByTestId('contact-row').first()).toContainText('Mathieu B.'); await expect(page.getByTestId('contact-row').first()).toContainText('Remboursements');   // favourites first
  const mathieu = ((await a.get('/contacts')).contacts as { id: string; label: string; favorite: boolean; note: string }[]).find((c) => c.label === 'Mathieu B.')!; expect(mathieu).toMatchObject({ favorite: true, note: 'Remboursements' });
  // change of address: the two values in full, an explicit confirmation
  await page.getByTestId('contact-row').filter({ hasText: 'Mathieu B.' }).getByRole('button').first().click(); await sheet.getByTestId('contact-move').click();
  await sheet.getByTestId('contact-new-address').fill(ADDR.rent);   // the address of « Loyer »
  await expect(sheet.getByTestId('contact-old')).toHaveText(ADDR.friend); await expect(sheet.getByTestId('contact-new')).toHaveText(ADDR.rent); await expect(sheet.getByTestId('contact-save')).toBeDisabled();
  await sheet.getByTestId('contact-move-check').check(); await sheet.getByTestId('contact-save').click();
  await expect(sheet.getByTestId('contact-err')).toContainText('Un autre contact a déjà cette adresse'); expect(((await a.get('/contacts')).contacts as { id: string; address: string }[]).find((c) => c.id === mathieu.id)!.address).toBe(ADDR.friend);
  // stale: the contact was changed elsewhere since this sheet read it — refused, nothing overwritten, and a reload is offered
  await a.send('patch', `/addressbook/${mathieu.id}`, { address: ADDR.exchange, currentAddress: ADDR.friend });
  await sheet.getByTestId('contact-new-address').fill('0x52908400098527886E0F7030069857D2E4169EE7'); await sheet.getByTestId('contact-move-check').check(); await sheet.getByTestId('contact-save').click();
  await expect(sheet.getByTestId('contact-err')).toContainText('a changé depuis son affichage'); await sheet.getByTestId('contact-reload').click();
  // with the fresh contact the change goes through
  await page.getByTestId('contact-row').filter({ hasText: 'Mathieu B.' }).getByRole('button').first().click(); await expect(sheet.getByTestId('contact-current')).toContainText(ADDR.exchange.slice(-6));
  await sheet.getByTestId('contact-move').click(); await sheet.getByTestId('contact-new-address').fill('0x52908400098527886E0F7030069857D2E4169EE7'); await sheet.getByTestId('contact-move-check').check(); await sheet.getByTestId('contact-save').click();
  await expect(sheet).toHaveCount(0); expect(((await a.get('/contacts')).contacts as { id: string; address: string }[]).find((c) => c.id === mathieu.id)!.address).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
  // delete, in two steps
  await page.getByTestId('contact-row').filter({ hasText: 'Loyer' }).getByRole('button').first().click(); await sheet.getByTestId('contact-delete').click(); await sheet.getByTestId('contact-delete-confirm').click();
  await expect(page.getByTestId('contact-row')).toHaveCount(1);
  for (const c of (await a.get('/contacts')).contacts as { id: string }[]) await a.send('delete', `/addressbook/${c.id}`);
  expect(s.errors()).toEqual([]);
});

test('Security Center: the passkeys of the signer, a mismatch said, sessions with the current one marked, ONE session revoked on the real route, sign-ins', async ({ page, context, baseURL, browser }) => {
  const s = await openWallet(page, context, baseURL), a = api(page, s);
  // a second REAL session (another browser context, the same throwaway passkey)
  const other = await browser.newContext(); const p2 = await other.newPage(); await openWallet(p2, other, baseURL);
  expect((await p2.request.get('/api/v1/settings')).status()).toBe(200);
  await nav(page, '/security'); await expect(page.getByTestId('security')).toBeVisible({ timeout: 30_000 });
  const ov = await a.get('/security/overview') as { sessions: { id: string; current: boolean }[]; signerCredentials: { id: string }[] };
  await expect(page.getByTestId('session')).toHaveCount(ov.sessions.length); await expect(page.locator('[data-testid=session][data-current=true]')).toHaveCount(1); await expect(page.getByTestId('session-current')).toBeVisible();
  // real stack: one passkey, the signer's — it is the last one and cannot be revoked
  await expect(page.getByTestId('passkey')).toHaveCount(ov.signerCredentials.length); if (ov.signerCredentials.length === 1) await expect(page.getByTestId('passkey-last')).toBeVisible();
  await expect(page.getByTestId('recovery-exported')).toContainText('jamais'); await expect(page.getByTestId('logins').locator('li').first()).toBeVisible();
  // revoke ONE session that is not this one
  const before = ov.sessions.length; await page.locator('[data-testid=session][data-current=false]').first().getByTestId('session-revoke').click();
  await expect(page.getByTestId('session-sheet')).toContainText('devra déverrouiller de nouveau'); await page.getByTestId('session-confirm').click();
  await expect(page.getByTestId('session')).toHaveCount(before - 1); await expect(page.getByTestId('balance-card')).toHaveCount(0);   // still on Security, still signed in
  expect(((await a.get('/security/overview')) as typeof ov).sessions.length).toBe(before - 1);
  await other.close();
  expect(s.errors()).toEqual([]);
});

test('passkey revocation: the list of the signer, ANOTHER passkey is asked for, the three refusals are explained (fixture: a second passkey)', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL), a = api(page, s);
  const real = (await a.get('/security/overview') as { devices: { credentialId: string }[] }).devices[0]!.credentialId;
  await populate(page, { mismatch: true }); await reload(page); await nav(page, '/security');
  await expect(page.getByTestId('passkey')).toHaveCount(3, { timeout: 30_000 }); await expect(page.getByTestId('cred-mismatch')).toContainText('que l’application ne connaît pas');
  await expect(page.getByTestId('key-unknown')).toBeVisible(); await expect(page.getByTestId('key-cooldown')).toBeVisible();
  const second = page.getByTestId('passkey').filter({ hasText: 'iPhone de Simon' });
  // 1. the server refuses: the last passkey, no approver — each said in words, in the sheet
  let refuse: string | null = 'last_credential';
  let confirmBody: { challengeId?: string; assertion?: { id?: string } } | null = null;
  const challenge = Buffer.from('spw-next-e2e-revoke-challenge-0001').toString('base64url');
  await page.route('**/api/v1/security/devices/revoke/options', (route) => (refuse
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: refuse, message: 'refused' }) })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ challengeId: '9f0c2f7e-1111-4222-8333-444455556666', request: {}, options: { challenge, rpId: 'localhost', timeout: 60_000, userVerification: 'required', allowCredentials: [{ id: real, type: 'public-key' }] } }) })));
  await page.route('**/api/v1/security/devices/revoke/confirm', (route) => { confirmBody = route.request().postDataJSON(); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'self_approval', message: 'a passkey cannot approve its own revocation' }) }); });
  await second.getByTestId('passkey-revoke').click(); const sheet = page.getByTestId('revoke-sheet'); await expect(sheet).toContainText('Une AUTRE clé d’accès doit approuver');
  await sheet.getByTestId('revoke-confirm').click(); await expect(sheet.getByTestId('revoke-err')).toContainText('dernière clé d’accès du signataire');
  refuse = 'no_approver'; await sheet.getByTestId('revoke-confirm').click(); await expect(sheet.getByTestId('revoke-err')).toContainText('Aucune autre clé d’accès ne peut approuver');
  // 2. the options arrive: the passkey prompt is answered by the virtual authenticator (the real, other passkey), and the
  //    assertion is what is submitted — through the shared approval-outcome helper (an answered refusal is shown as such)
  refuse = null; await sheet.getByTestId('revoke-confirm').click();
  await expect(page.getByTestId('security-err')).toContainText('ne peut pas approuver sa propre révocation', { timeout: 20_000 });
  expect(confirmBody).not.toBeNull(); expect(confirmBody!.challengeId).toBe('9f0c2f7e-1111-4222-8333-444455556666'); expect(confirmBody!.assertion?.id).toBe(real);
  await expect(page.getByTestId('approval-unknown')).toHaveCount(0); await expect(page.getByTestId('passkey')).toHaveCount(3);
  // 3. a LOST answer to the confirmation: the outcome is read from the server (the passkey is still listed → not received), never guessed
  await page.unroute('**/api/v1/security/devices/revoke/confirm'); await page.route('**/api/v1/security/devices/revoke/confirm', (route) => route.abort('failed'));
  await second.getByTestId('passkey-revoke').click(); await sheet.getByTestId('revoke-confirm').click();
  await expect(page.getByTestId('approval-checking').or(page.getByTestId('approval-not-received'))).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('approval-not-received')).toBeVisible({ timeout: 40_000 }); await expect(page.getByTestId('passkey')).toHaveCount(3);
  await s.save();
});

test('search: ⌘K / Ctrl-K, the keyboard alone — an asset, a transaction by its hash, a setting; Escape gives the focus back', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL); await populate(page); await reload(page);
  const input = page.getByTestId('search-input');
  await page.getByTestId('search-open').first().focus(); await page.keyboard.press('Control+k'); await expect(input).toBeFocused();
  await page.keyboard.type('usd'); const results = page.getByTestId('search-results'); await expect(results.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(results).toHaveAttribute('data-server', 'no');   // GET /search is not on this branch: the local index answers
  await page.keyboard.press('ArrowDown'); await expect(results.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true'); await page.keyboard.press('ArrowUp');
  const path = await results.getByRole('option').first().getAttribute('data-path'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('search')).toHaveCount(0); expect(new URL(page.url()).pathname).toBe(decodeURIComponent(path!).split('?')[0] === path ? path : new URL(path!, page.url()).pathname); await expect(page.getByTestId('asset')).toBeVisible({ timeout: 30_000 });
  // a transaction by a part of its hash → Activity opens that movement
  await page.keyboard.press('Meta+k'); await expect(input).toBeFocused(); await page.keyboard.type('bbbbbbbb'); await expect(results.locator('[data-type=transaction]')).toHaveCount(1); await page.keyboard.press('Enter');
  await expect(page.getByTestId('ac-detail')).toBeVisible({ timeout: 30_000 }); await expect(page.getByTestId('ac-fee-paid')).toContainText('0,00000184'); await expect(page.getByTestId('ac-contact')).toContainText('Loyer');
  // a setting, without accents
  await page.keyboard.press('Control+k'); await expect(input).toBeFocused(); await page.keyboard.type('securite'); await expect(results.locator('[data-type=setting]').first()).toBeVisible(); await page.keyboard.press('Enter'); await expect(page.getByTestId('security')).toBeVisible({ timeout: 30_000 });
  // Escape closes and the focus goes back to what opened the search
  await page.getByTestId('search-open').first().focus(); await page.keyboard.press('Enter'); await expect(input).toBeFocused(); await page.keyboard.type('zzzzzz'); await expect(page.getByTestId('search-empty')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByTestId('search')).toHaveCount(0); await expect(page.getByTestId('search-open').first()).toBeFocused();
  expect(s.errors()).toEqual([]);
});

test('activity: life-cycle pills, a dropped transfer explained and still watched, and a row that changes from a scripted event stream — without a reload or a timer', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL); await populate(page);
  // the scripted stream: nothing at first; once `fire` is set, the next connection delivers one transfer.state event, and from
  // then on the timeline answers the BTC transfer as final. The client reconnects by itself (the server ended the stream).
  let fire = false, streams = 0; const headers: (string | undefined)[] = [];
  await page.route('**/api/v1/events/stream*', (route) => { streams += 1; headers.push(route.request().headers()['x-spw-interaction']);
    const body = fire ? `retry: 3000\n\nevent: hello\ndata: {"from":40}\n\nid: 41\nevent: transfer.state\ndata: ${JSON.stringify({ id: 41, at: new Date().toISOString(), type: 'transfer.state', ref: IDS.confirming, data: { lifecycle: 'confirmed' } })}\n\n` : 'retry: 3000\n\nevent: hello\ndata: {"from":40}\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body }); });
  let reads = 0;
  await page.route('**/api/v1/dashboard/activity?*', (route) => { reads += 1; const t = timeline();
    if (fire) for (const i of t.items as { wallet: { id: string; lifecycle: string; state: string; finalized: boolean; confirmations: number; finalizedAt: string } }[]) if (i.wallet.id === IDS.confirming) Object.assign(i.wallet, { lifecycle: 'confirmed', state: 'finalized', finalized: true, confirmations: 6, finalizedAt: new Date().toISOString() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(t) }); });
  await reload(page); await nav(page, '/activity');
  const row = page.locator(`[data-testid=ac-item][data-item="w:${IDS.confirming}"]`); await expect(row.getByTestId('status-pill')).toHaveText('En confirmation', { timeout: 30_000 });
  // every pill is a word of the ONE vocabulary
  const dropped = page.locator(`[data-testid=ac-item][data-item="w:${IDS.dropped}"]`); await expect(dropped.getByTestId('status-pill')).toHaveText('Non incluse'); await expect(page.locator(`[data-item="w:${IDS.replaced}"]`).getByTestId('status-pill')).toHaveText('Remplacée');
  await expect(page.locator(`[data-item="w:${IDS.rent}"]`).getByTestId('status-pill')).toHaveText('Confirmée'); await expect(page.locator(`[data-item="w:${IDS.failed}"]`).getByTestId('status-pill')).toHaveText('Échouée');
  await expect(page.locator(`[data-item="w:${IDS.rent}"]`)).toContainText('Envoi à Loyer');   // the contact's label, not the raw address
  // the internal deposit of the swap is not a row; it is the swap's result
  await expect(page.locator('[data-item="w:base:0xcc:0"]')).toHaveCount(0); await page.locator(`[data-item="w:${IDS.swap}"]`).getByTestId('tx-row').click(); await expect(page.getByTestId('ac-result')).toContainText('812,403311 USDC');
  // dropped: its explanation and « still watched », the timeline ends on it, the estimate is labelled an estimate
  await dropped.getByTestId('tx-row').click(); const detail = dropped.getByTestId('ac-detail');
  await expect(detail.getByTestId('lifecycle-explain')).toContainText('Le réseau ne la connaît plus'); await expect(detail.getByTestId('still-watched')).toBeVisible();
  await expect(detail.getByTestId('lifecycle').locator('li').last()).toHaveAttribute('data-step', 'dropped'); await expect(detail.getByTestId('ac-fee-estimate')).toContainText('≈'); await expect(detail.getByTestId('ac-fee-paid')).toHaveCount(0);
  await expect(detail.getByTestId('ac-txid')).toHaveText('5'.repeat(64));
  // LIVE: the event arrives on the stream → the row is re-read and becomes « Confirmée » — well inside the 20 s of the fallback timer
  const readsBefore = reads, t0 = Date.now(); fire = true;
  await expect(row.getByTestId('status-pill')).toHaveText('Confirmée', { timeout: 12_000 });
  expect(Date.now() - t0, 'updated by the event, not by the timer').toBeLessThan(12_000); expect(reads).toBeGreaterThan(readsBefore); expect(streams).toBeGreaterThanOrEqual(2);
  expect(headers.every((h) => h === undefined), 'the event stream never counts as an interaction').toBe(true);
  expect(movements().length).toBeGreaterThan(5);
  expect(s.errors()).toEqual([]);
});

test('appearance: « Système » is saved in the ACCOUNT and follows the device’s colour scheme; the interaction header marks what the owner does, not what the app reads by itself', async ({ page, context, baseURL }) => {
  const s = await openWallet(page, context, baseURL), a = api(page, s);
  const marks: { path: string; method: string; mark: string | undefined }[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v1/')) marks.push({ path: u.pathname, method: r.method(), mark: r.headers()['x-spw-interaction'] }); });
  await nav(page, '/settings'); const seg = page.getByTestId('theme-seg'); await expect(seg.getByRole('radio', { name: 'Clair' })).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  const html = page.locator('html'); await expect(html).toHaveAttribute('data-theme', 'light'); await expect(html).toHaveAttribute('data-scheme', 'light');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await seg.getByRole('radio', { name: 'Système' }).click();
  await expect(html).toHaveAttribute('data-theme', 'system'); await expect.poll(async () => (await a.get('/settings')).theme).toBe('system');
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(html).toHaveAttribute('data-scheme', 'dark'); await expect.poll(bg).not.toBe(light);
  expect(await page.evaluate(() => document.querySelector('meta[name=theme-color]')!.getAttribute('content'))).not.toBe('#f3f4f7');
  await page.emulateMedia({ colorScheme: 'light' }); await expect(html).toHaveAttribute('data-scheme', 'light'); await expect.poll(bg).toBe(light);
  // « Sombre » is dark whatever the device says; a reload keeps the account's choice (the cache only serves the lock screen)
  await seg.getByRole('radio', { name: 'Sombre' }).click(); await expect(html).toHaveAttribute('data-scheme', 'dark'); await expect.poll(async () => (await a.get('/settings')).theme).toBe('dark');
  // the PUT caused by the click carries the mark; the settings read by the app itself a moment before did not have to
  const put = marks.filter((m) => m.method === 'PUT' && m.path === '/api/v1/settings'); expect(put.length).toBeGreaterThanOrEqual(2); expect(put.every((m) => m.mark === '1')).toBe(true);
  expect(marks.filter((m) => m.path.startsWith('/api/v1/events')).every((m) => m.mark === undefined)).toBe(true);
  await a.send('put', '/settings', { theme: 'light' });
  expect(s.errors()).toEqual([]);
});

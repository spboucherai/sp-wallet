/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/nft-send.spec.ts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// NFT delivery 2 in a real browser, on the stack of tests/e2e/nft-send-server.mts: real API + real signer process + built web
// app; Ethereum is a LOCAL anvil fork (the wallet holds BAYC #1 and #2 there), Bitcoin a scripted Esplora (three outputs).
// The passkey is a virtual authenticator: every approval below is a real WebAuthn assertion verified by the signer.
//   pkill -f anvil; sleep 3; npx tsx tests/e2e/nft-send-server.mts --port 8880 &
//   SPW_E2E_BASE=http://localhost:8880 SPW_DEV_DIR=/tmp/spw-nft-send-e2e-8880 pnpm e2e nft-send.spec.ts
// What it shows: Send from the item page (on-chain identifiers in full on the form, the review sheet and the passkey summary;
// creator metadata small and labelled unverified), the simulation verdict before the passkey, pending → confirmed at finality
// on the fork, the inventory after it; a refusal caught by the simulation with no passkey prompt; a blocked asset with its
// exact reason instead of a dead button; the Bitcoin protected outputs: heuristic said as such, lock / unlock with the
// passkey, and an ordinary BTC send that cannot select a protected output.
// Nothing here reaches a real network; a fork is not a mainnet execution.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { deviceUse, expectNoOverflow, openWallet } from './v11-helpers.ts';

const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const key = (id: string) => `evm:ethereum:${BAYC.toLowerCase()}/${id}`;
const T = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

test.describe.configure({ mode: 'serial' });
test.describe('NFT send · phone · fr', () => {
  test.use(deviceUse('phone', 'fr'));

  test('ERC-721 on the fork: item page → form → review (on-chain identifiers) → passkey → pending → confirmed at finality → inventory', async ({ page, context, baseURL }) => {
    test.setTimeout(360_000);
    const s = await openWallet(page, context, baseURL, { lang: 'fr' });
    for (const id of ['1', '2']) expect((await page.request.post('/api/v1/nfts/manual', { headers: s.headers(), data: { chain: 'ethereum', address: BAYC, tokenId: id } })).status(), `track #${id}`).toBe(200);
    await page.goto(`/nft/${encodeURIComponent(key('1'))}`);
    const send = page.getByTestId('nft-send');
    await expect(send).toBeEnabled({ timeout: 30_000 }); await expect(send).toHaveAttribute('data-transferable', 'true');
    await expect(page.getByTestId('nft-send-route')).toContainText('safeTransferFrom(address,address,uint256)');
    await expect(page.getByTestId('nft-send-why')).toHaveCount(0);
    await send.click();

    // form: the asset is identified by what the CHAIN says, in full
    const form = page.getByTestId('nft-send-form');
    await expect(form).toBeVisible();
    const identity = page.getByTestId('nft-send-identity');
    await expect(identity).toContainText(BAYC); await expect(identity).toContainText('ERC-721'); await expect(page.getByTestId('nft-send-quantity')).toHaveText('1');
    await expect(page.getByTestId('nft-send-creator-label')).toHaveText(/métadonnée du créateur, non vérifiée/i);
    await expect(page.getByTestId('nft-send-qty')).toHaveCount(0); // ERC-721: one unit, no quantity field
    await expect(page.getByTestId('nft-send-review')).toBeDisabled();
    await expectNoOverflow(page, 'send form');
    await page.screenshot({ path: 'test-results/shots/nft-send-form-phone-fr.png', fullPage: true });

    // a refusal caught by the SIMULATION: a contract that does not implement the receiver interface — said before any passkey prompt
    await page.getByTestId('nft-send-to').fill(WETH);
    await page.getByTestId('nft-send-review').click();
    await expect(page.getByTestId('nft-send-error')).toContainText('Le transfert échouerait', { timeout: 60_000 });
    await expect(page.getByTestId('nft-send-reviewsheet')).toHaveCount(0);
    // an invalid address
    await page.getByTestId('nft-send-to').fill('0x1234');
    await page.getByTestId('nft-send-review').click();
    await expect(page.getByTestId('nft-send-error')).toBeVisible();

    // a fresh ordinary account
    const dest = '0x' + randomBytes(20).toString('hex');
    await page.getByTestId('nft-send-to').fill(dest);
    await page.getByTestId('nft-send-review').click();
    const sheet = page.getByTestId('nft-send-reviewsheet');
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    const review = page.getByTestId('nft-review-identity');
    await expect(review).toContainText(BAYC); await expect(review).toContainText('Ethereum'); await expect(review).toContainText('ERC-721'); await expect(review).toContainText('safeTransferFrom(address,address,uint256)');
    await expect(review.getByTestId('nft-id').nth(1)).toHaveText('1'); // the token id, as its own full identifier
    expect((await page.getByTestId('nft-review-to').innerText()).replace(/\s/g, '').toLowerCase()).toContain(dest.slice(2, 12));
    await expect(page.getByTestId('nft-review-tokind')).toHaveText('Compte ordinaire');
    await expect(page.getByTestId('nft-review-sim')).toHaveText(/Simulation réussie/);
    await expect(page.getByTestId('nft-review-verified')).toContainText('2 points d’accès');
    await expect(page.getByTestId('nft-review-hash')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId('nft-review-feemax')).toContainText('ETH');
    await expect(page.getByTestId('nft-review-irreversible')).toContainText('irréversible');
    await expect(page.getByTestId('nft-send-creator-label')).toBeVisible();
    // the creator-declared name is not what the sheet is titled with: the on-chain block comes first in the page
    const order = await page.evaluate(() => { const a = document.querySelector('[data-testid=nft-review-identity]')!.getBoundingClientRect().top, b = document.querySelector('[data-testid=nft-send-creator]')!.getBoundingClientRect().top; return a < b; });
    expect(order).toBe(true);
    await expect(page.getByTestId('nft-send-approve')).toBeDisabled(); // a new destination: the owner confirms he checked it
    await page.getByTestId('nft-review-check').check();
    await expectNoOverflow(page, 'review sheet');
    await page.screenshot({ path: 'test-results/shots/nft-send-review-phone-fr.png', fullPage: true });
    // what the server stored for this proposal is what the sheet shows (the hash on screen is the passkey challenge)
    const stored = await (await page.request.get('/api/v1/nfts/transfers?key=' + encodeURIComponent(key('1')))).json();
    expect(stored.items[0]).toMatchObject({ kind: 'nft', state: 'pending_approval', nft: { asset: BAYC, tokenId: '1', quantity: '1', to: expect.stringMatching(new RegExp(dest.slice(2), 'i')) } });
    expect(stored.items[0].intentHash).toBe(await page.getByTestId('nft-review-hash').innerText());

    await page.getByTestId('nft-send-approve').click(); // the virtual authenticator answers the WebAuthn request
    const track = page.getByTestId('nft-send-track');
    await expect(track).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('nft-track-identity')).toContainText(BAYC);
    await expect(page.getByTestId('nft-track-txid')).toHaveText(/^0x[0-9a-f]{64}$/);
    // pending first (never "sent"), then confirmed only when the chain (the fork) reaches finality
    await expect(track).toHaveAttribute('data-state', 'finalized', { timeout: 180_000 });
    await expect(page.getByTestId('nft-track-done')).toContainText('Confirmé à la finalité');
    await page.screenshot({ path: 'test-results/shots/nft-send-confirmed-phone-fr.png', fullPage: true });
    await s.save();
    // the inventory after finality: read again on-chain — it has left the wallet, and Send now says why it is not available
    await page.getByTestId('nft-send-close').click();
    await expect(page.getByTestId('nft-detail')).toBeVisible();
    await expect(page.getByTestId('nft-send')).toBeDisabled({ timeout: 30_000 });
    await expect(page.getByTestId('nft-send-why').locator('[data-reason=not_in_wallet]')).toContainText('n’est pas détenu par ce portefeuille');
    const item = await (await page.request.get('/api/v1/nfts/item?key=' + encodeURIComponent(key('1')))).json();
    expect(item.ownership.heldByWallet).toBe(false);
    expect(s.errors()).toEqual([]);
  });

  test('a token of another holder is not sendable: the exact reason replaces the button; the API refuses a forged request for it', async ({ page, context, baseURL }) => {
    const s = await openWallet(page, context, baseURL, { lang: 'fr' });
    expect((await page.request.post('/api/v1/nfts/lookup', { headers: s.headers(), data: { chain: 'ethereum', address: BAYC, tokenId: '3' } })).status()).toBe(200);
    await page.goto(`/nft/${encodeURIComponent(key('3'))}`);
    await expect(page.getByTestId('nft-send')).toBeDisabled({ timeout: 30_000 });
    await expect(page.getByTestId('nft-send-why').locator('li')).toHaveCount(1);
    await expect(page.getByTestId('nft-send-why')).not.toContainText('pas pris en charge dans cette version');
    const forged = await page.request.post('/api/v1/nfts/transfer/prepare', { headers: s.headers(), data: { key: key('3'), to: '0x' + randomBytes(20).toString('hex') } });
    expect(forged.status()).toBe(422); expect((await forged.json()).error).toBe('nft_transfer_not_in_wallet');
    // no calldata, method or owner can be supplied to the route
    for (const extra of [{ data: '0x00' }, { method: 'approve' }, { from: WETH }]) expect((await page.request.post('/api/v1/nfts/transfer/prepare', { headers: s.headers(), data: { key: key('2'), to: '0x' + randomBytes(20).toString('hex'), ...extra } })).status()).toBe(400);
  });

  test('Bitcoin: protected outputs — heuristic said as such, lock and unlock with the passkey, an ordinary BTC send cannot select a protected output', async ({ page, context, baseURL }) => {
    test.setTimeout(180_000);
    const s = await openWallet(page, context, baseURL, { lang: 'fr' });
    await page.goto('/nfts?v=receive');
    await expect(page.getByTestId('nft-receive')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('nft-receive').getByRole('radio', { name: 'Bitcoin', exact: true }).click();
    await expect(page.getByTestId('nft-receive-warn-ordinals_heuristic_only')).toContainText('HEURISTIQUE');
    await expect(page.getByTestId('nft-receive-warn-ordinals_no_transfer')).toContainText('ne transfère pas d’inscription');
    await expect(page.getByTestId('nft-receive-noclaim')).toContainText('non pris en charge');
    await page.getByTestId('nft-receive-locks').click();
    const locks = page.getByTestId('utxo-locks');
    await expect(locks).toBeVisible({ timeout: 30_000 }); await expect(locks).toHaveAttribute('data-mode', 'heuristic');
    await expect(page.getByTestId('utxo-mode')).toContainText('HEURISTIQUE, pas une détection');
    const row = (n: number, vout: number) => locks.locator(`[data-outpoint="${T(n)}:${vout}"]`);
    await expect(locks.locator('[data-outpoint]')).toHaveCount(3);
    await expect(row(0xa1, 0)).toHaveAttribute('data-spendable', 'true');
    await expect(row(0xa2, 1)).toHaveAttribute('data-spendable', 'false'); await expect(row(0xa2, 1)).toContainText('possiblement une inscription');
    await expect(row(0xa3, 0)).toHaveAttribute('data-spendable', 'false'); await expect(row(0xa3, 0)).toContainText('0.00000546 BTC');
    await expectNoOverflow(page, 'protected outputs');
    await page.screenshot({ path: 'test-results/shots/nft-utxo-locks-phone-fr.png', fullPage: true });

    // an ordinary send of 0.00065 BTC needs the 60 000-sat coin AND a small one: both small ones are held back → refused, with the reason
    const sendBtc = () => page.request.post('/api/v1/transfers/proposals', { headers: { ...s.headers(), 'idempotency-key': randomUUID() }, data: { network: 'bitcoin', asset: 'native', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.00065' } });
    const refused = await sendBtc();
    expect(refused.status()).toBe(400); expect(await refused.json()).toMatchObject({ error: 'insufficient_unlocked_funds', data: { protectedOutputs: 2 } });
    expect((await page.request.post('/api/v1/transfers/proposals', { headers: { ...s.headers(), 'idempotency-key': randomUUID() }, data: { network: 'bitcoin', asset: 'native', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: '0.0003' } })).status()).toBe(200); // the large coin alone: as before

    // lock the 546-sat output with the passkey: the SIGNER now holds it
    await row(0xa3, 0).getByTestId('utxo-lock').click();
    await expect(row(0xa3, 0)).toHaveAttribute('data-locked', 'true', { timeout: 60_000 });
    await expect(row(0xa3, 0)).toContainText('Verrouillée (signataire)'); await expect(row(0xa3, 0).getByTestId('utxo-review')).toHaveCount(0);
    const st = await (await page.request.get('/api/v1/utxo-locks?network=bitcoin')).json();
    expect(st.utxos.find((u: { outpoint: string }) => u.outpoint === `${T(0xa3)}:0`)).toMatchObject({ signerLock: { reason: 'heuristic' }, spendable: false });
    // the owner declares the 9 000-sat output an ordinary coin: it becomes spendable; the locked one does not
    await row(0xa2, 1).getByTestId('utxo-review').click();
    await expect(row(0xa2, 1)).toHaveAttribute('data-spendable', 'true', { timeout: 30_000 });
    expect((await sendBtc()).status()).toBe(200);
    await page.screenshot({ path: 'test-results/shots/nft-utxo-locked-phone-fr.png', fullPage: true });
    // a lock-list change without a passkey assertion is refused by the signer, through the API too
    const prep = await (await page.request.post('/api/v1/utxo-locks/prepare', { headers: s.headers(), data: { network: 'bitcoin', action: 'unlock', outpoints: [`${T(0xa3)}:0`] } })).json();
    const noKey = await page.request.post('/api/v1/utxo-locks/approve', { headers: s.headers(), data: { intent: prep.intent, assertion: {} } });
    expect(noKey.status()).toBe(422);
    await expect(row(0xa3, 0)).toHaveAttribute('data-locked', 'true');
    // unlock with the passkey
    await row(0xa3, 0).getByTestId('utxo-unlock').click();
    await expect(row(0xa3, 0)).toHaveAttribute('data-locked', 'false', { timeout: 60_000 });
    await s.save();
    expect(s.errors()).toEqual([]);
  });
});

test.describe('NFT send · desktop · en · dark', () => {
  test.use(deviceUse('desktop', 'en'));
  test('the form in English on a desktop: identifiers in full, the creator label, no overflow', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'en', theme: 'dark' });
    await page.goto(`/nft/${encodeURIComponent(key('2'))}`);
    await expect(page.getByTestId('nft-send')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('nft-send').click();
    await expect(page.getByTestId('nft-send-identity')).toContainText(BAYC);
    await expect(page.getByTestId('nft-send-creator-label')).toHaveText(/creator metadata, not verified/i);
    await page.getByTestId('nft-send-to').focus(); await expect(page.getByTestId('nft-send-to')).toBeFocused();
    await expectNoOverflow(page, 'send form desktop');
    await page.screenshot({ path: 'test-results/shots/nft-send-form-desktop-en-dark.png', fullPage: true });
  });
});

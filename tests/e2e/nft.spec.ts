// NFT delivery 1 (read-only) in a real browser, on the stack of tests/e2e/nft-server.mts (real API + signer + built web app;
// real Solana / EVM reads; one scripted chain with hostile metadata). Phone first, French; one pass on desktop in English.
//   npx tsx tests/e2e/nft-server.mts --port 8870 &
//   SPW_E2E_BASE=http://localhost:8870 SPW_DEV_DIR=/tmp/spw-nft-e2e-8870 pnpm e2e nft.spec.ts
// What it shows: the gallery's states for a wallet that holds nothing (per-chain: supported / blocked by provider / not
// supported — never a bare "no NFT"); the reference mint of the brief looked up live — real fields, or a clean failure, never
// an invented value; hostile metadata rendered without one script of it running, in the page or out of its sandbox.
import { expect, test, type Page } from '@playwright/test';
import { deviceUse, expectNoOverflow, openWallet } from './v11-helpers.ts';

const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j';
const guard = (page: Page) => { const seen: string[] = []; page.on('dialog', (d) => { seen.push(`dialog:${d.message()}`); void d.dismiss(); }); return seen; };

test.describe('NFT · phone · fr', () => {
  test.use(deviceUse('phone', 'fr'));

  test('Assets → NFT: gallery states, per-chain truth, receive with the Ordinals warning', async ({ page, context, baseURL }) => {
    const s = await openWallet(page, context, baseURL, { lang: 'fr' });
    await page.goto('/assets');
    await expect(page.getByTestId('assets-nft-link')).toContainText('Valeur non disponible');
    await page.getByTestId('assets-nft-link').click();
    await expect(page).toHaveURL(/\/nfts$/);
    const g = page.getByTestId('nft-gallery');
    await expect(g).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('nft-valuation')).toContainText('Valeur des NFT : non disponible');
    // the throwaway wallet holds nothing: after the first synchronisation the gallery says what was READ — not "you have no NFT"
    await page.getByTestId('nft-sync').click().catch(() => {});
    await expect(page.getByTestId('nft-syncing')).toHaveCount(0, { timeout: 90_000 });
    await expect(page.getByTestId('nft-count')).toContainText('0 NFT', { timeout: 30_000 });
    await expect(page.getByTestId('nft-empty')).toContainText(/ne veut pas dire qu.il ne contient aucun NFT|se construit à partir des chaînes/);
    const chains = page.getByTestId('nft-chains');
    await expect(chains).toBeVisible();
    await expect(chains.locator('[data-chain=solana]')).toHaveAttribute('data-inventory', /supported|partial/);
    for (const n of ['ethereum', 'base', 'hyperevm']) { await expect(chains.locator(`[data-chain=${n}]`)).toHaveAttribute('data-inventory', 'blocked_by_provider'); await expect(chains.locator(`[data-chain=${n}]`)).toContainText('NFT_EVM_INDEXER_URLS'); }
    await expect(chains.locator('[data-chain=bitcoin]')).toHaveAttribute('data-inventory', 'blocked_by_provider');
    for (const n of ['cardano', 'sui', 'ton', 'xrpl']) await expect(chains.locator(`[data-chain=${n}]`)).toHaveAttribute('data-inventory', 'unsupported');
    await expect(chains.locator('li')).toHaveCount(24); // the 23 networks of the registry + the scripted test chain of this stack
    await expectNoOverflow(page, 'gallery');
    await page.screenshot({ path: 'test-results/shots/nft-gallery-phone-fr.png', fullPage: true });

    // receive: the wallet's own address; Bitcoin carries the Ordinals warning; no arrival is claimed
    await page.getByRole('tab', { name: 'Recevoir' }).click();
    await expect(page.getByTestId('nft-receive')).toBeVisible();
    const accounts = await (await page.request.get('/api/v1/accounts')).json() as { accounts: { network: string; address: string }[] };
    await expect(page.getByTestId('nft-receive-address')).toHaveText(accounts.accounts.find((a) => a.network === 'solana')!.address);
    await expect(page.getByTestId('nft-receive-noclaim')).toContainText('jamais avant');
    await page.getByTestId('nft-receive').getByRole('radio', { name: 'Bitcoin', exact: true }).click();
    await expect(page.getByTestId('nft-receive-warn-ordinals_heuristic_only')).toContainText('HEURISTIQUE'); // delivery 2: the heuristic and the lock list replace the bare warning
    await expect(page.getByTestId('nft-receive-address')).toHaveText(accounts.accounts.find((a) => a.network === 'bitcoin')!.address);
    await expectNoOverflow(page, 'receive');
    expect(s.errors()).toEqual([]);
  });

  test('the reference mint, looked up: real fields with their provenance — or a clean failure; nothing invented', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'fr' });
    await page.goto('/nfts?v=lookup');
    await page.getByTestId('nft-lookup-address').fill(REF);
    await page.getByTestId('nft-lookup-go').click();
    const detail = page.getByTestId('nft-detail'), failure = page.getByTestId('nft-lookup-error');
    await expect(detail.or(failure)).toBeVisible({ timeout: 60_000 });
    if (await failure.isVisible()) {
      // the public endpoints did not answer: a code, and no item page
      await expect(failure).toHaveAttribute('data-code', /^(provider_unavailable|provider_rate_limited|provider_bad_answer|not_found)$/);
      await expect(detail).toHaveCount(0);
      test.info().annotations.push({ type: 'reference-mint', description: `clean failure: ${await failure.getAttribute('data-code')}` });
      return;
    }
    await expect(page).toHaveURL(new RegExp(`/nft/sol%3Asolana%3A${REF}$`));
    await expect(detail).toHaveAttribute('data-key', `sol:solana:${REF}`);
    await expect(page.getByTestId('nft-not-in-wallet')).toContainText('n’est pas dans ce portefeuille');
    await expect(detail.getByTestId('nft-id').first()).toHaveText(REF); // the full identifier
    await expect(detail).toContainText('Metaplex Core');
    await expect(detail.getByTestId('nft-prov').first()).toBeVisible();
    await expect(detail.locator('[data-testid=nft-prov][data-category=onchain]').first()).toContainText('Confirmé on-chain');
    await expect(page.getByTestId('nft-held')).toHaveText('non');
    // what is shown as the name is what the chain or the creator's document says — compared with the API's own answer
    const api = await (await page.request.get(`/api/v1/nfts/item?key=${encodeURIComponent(`sol:solana:${REF}`)}`)).json() as { metadata: { name: string | null; onchainName: string | null; status: string; attributes: unknown[] }; market: unknown; ownership: { owner: { value?: string } } };
    expect(api.metadata.onchainName).toBeTruthy();
    await expect(page.getByTestId('nft-name')).toHaveText(api.metadata.name ?? api.metadata.onchainName!);
    if (api.metadata.status === 'ok') await expect(page.getByTestId('nft-traits').locator('li')).toHaveCount(api.metadata.attributes.length); else await expect(page.getByTestId('nft-metadata-status')).toBeVisible();
    expect(api.market).toBeNull(); await expect(page.getByTestId('nft-market-none')).toBeVisible(); await expect(detail).toContainText('Valeur de cet objet : non disponible');
    await expect(page.getByTestId('nft-rarity')).toContainText('non calculées');
    await expect(page.getByTestId('nft-send')).toBeDisabled(); await expect(page.getByTestId('nft-market-actions')).toBeDisabled();
    await expect(page.getByTestId('nft-send-why').locator('[data-reason=not_in_wallet]')).toBeVisible();
    await expect(page.getByTestId('nft-send-why').locator('li')).toHaveCount(1); await expect(page.getByTestId('nft-send-why')).not.toContainText('pas pris en charge dans cette version'); // delivery 2: the factual reason only
    await expect(page.getByTestId('nft-outside-warning')).toContainText('hors de SP Wallet');
    await expect(page.getByTestId('nft-activity').or(page.getByTestId('nft-activity-error'))).toBeVisible({ timeout: 60_000 });
    await expectNoOverflow(page, 'detail');
    await page.screenshot({ path: 'test-results/shots/nft-reference-phone-fr.png', fullPage: true });
    test.info().annotations.push({ type: 'reference-mint', description: `shown: ${api.metadata.onchainName} — owner ${api.ownership.owner.value}` });
  });

  test('hostile metadata: text stays text, blocked media say so, HTML only in a sandbox — not one script reaches the wallet', async ({ page, context, baseURL }) => {
    const s = await openWallet(page, context, baseURL, { lang: 'fr' }), seen = guard(page);
    const r = await page.request.post('/api/v1/nfts/lookup', { headers: s.headers(), data: { chain: 'testnet', address: 'hostile'.padEnd(30, '_') } });
    expect(r.status(), await r.text()).toBe(200);
    const a = await r.json() as { key: string; media: { id: string; sourceUri: string; status: string }[] };
    await page.goto(`/nft/${encodeURIComponent(a.key)}`);
    const detail = page.getByTestId('nft-detail');
    await expect(detail).toBeVisible({ timeout: 20_000 });
    // name / description / traits: the markup is shown as characters
    await expect(page.getByTestId('nft-name')).toHaveText('<img src=x onerror="document.title=\'PWNED\'">');
    await expect(page.getByTestId('nft-description')).toContainText('<script>document.title="PWNED"</script>');
    await expect(page.getByTestId('nft-traits')).toContainText('"><svg onload="document.title=\'PWNED\'">');
    await expect(page.locator('img[src="x"]')).toHaveCount(0); await expect(detail.locator('script')).toHaveCount(0); await expect(detail.locator('svg[onload]')).toHaveCount(0);
    await expect(page.getByTestId('nft-external-link')).toHaveCount(0); // javascript: is not a link
    await expect(detail.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
    // the HTML animation is locked; nothing of it is loaded until asked
    await expect(page.getByTestId('nft-media-active')).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    // blocked media (http scheme / cloud-metadata address, private address, an HTML file posing as a PNG) answer JSON refusals
    const by = (frag: string) => a.media.find((m) => m.sourceUri.includes(frag))!;
    for (const [frag, code] of [['169.254.169.254', 'scheme_not_allowed'], ['10.0.0.5', 'private_address'], ['fake.png', 'mime_mismatch']] as const) {
      const m = await page.request.get(`/api/v1/nfts/media/${by(frag).id}`); expect(m.status(), frag).toBe(403); expect(((await m.json()) as { data: { code: string } }).data.code, frag).toBe(code);
    }
    // the SVG is an image: served with a sandboxing CSP; in an <img> its script does not run
    const svg = await page.request.get(`/api/v1/nfts/media/${by('pic.svg').id}`);
    expect(svg.headers()['content-type']).toBe('image/svg+xml; charset=utf-8'); expect(svg.headers()['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    await expect(detail.locator(`img[src="/api/v1/nfts/media/${by('pic.svg').id}"]`).first()).toBeVisible();
    // 1) shown WITHOUT scripts
    await page.getByTestId('nft-media-show').click();
    const frame = page.getByTestId('nft-media-frame');
    await expect(frame).toHaveAttribute('sandbox', ''); await expect(frame).toHaveAttribute('data-mode', 'static');
    const inner = page.frameLocator('[data-testid=nft-media-frame]');
    await expect(inner.locator('#art')).toHaveText('art', { timeout: 15_000 });
    await expect(inner.locator('#js')).toHaveText('no-js');
    // 2) the owner's explicit "run this content": scripts run INSIDE the sandbox only
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.getByTestId('nft-media-run').click();
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts'); await expect(frame).toHaveAttribute('data-mode', 'run');
    await expect(inner.locator('#js')).toHaveText('js-ran', { timeout: 15_000 });
    await expect(inner.locator('#parent')).toHaveText('parent-blocked');   // no access to the wallet's page (opaque origin)
    await expect(inner.locator('#net')).toHaveText('net-blocked');         // no request to the API (or anywhere): connect-src 'none'
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe(`/nft/${encodeURIComponent(a.key)}`); // top navigation did not happen
    expect(await page.title()).not.toContain('PWNED');
    expect(seen).toEqual([]); // no dialog of the hostile content ever reached the page
    await expect(page.getByTestId('nft-send')).toBeDisabled();
    await expectNoOverflow(page, 'hostile detail');
    await page.screenshot({ path: 'test-results/shots/nft-hostile-phone-fr.png', fullPage: true });
    // the app's own CSP is unchanged and still forbids framing the wallet
    const doc = await page.request.get('/nfts'); expect(doc.headers()['content-security-policy']).toContain("frame-ancestors 'none'"); expect(doc.headers()['x-frame-options']).toBe('DENY');
    expect(s.errors().filter((e) => !/sandbox|Blocked script execution|Content Security Policy|Refused to|net::ERR|Unsafe attempt|navigate the top-level/i.test(e))).toEqual([]);
  });
});

test.describe('NFT · desktop · en · dark', () => {
  test.use(deviceUse('desktop', 'en'));
  test('gallery, lookup form and per-chain states in English', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'en', theme: 'dark' });
    await page.goto('/nfts');
    await expect(page.getByTestId('nft-gallery')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('nft-valuation')).toContainText('NFT value: unavailable');
    await expect(page.getByTestId('nft-chains').locator('[data-chain=ethereum]')).toContainText('Blocked by provider');
    await expect(page.getByTestId('nft-chains').locator('[data-chain=cardano]')).toContainText('Not supported');
    await page.getByRole('tab', { name: 'Open an NFT' }).click();
    await expect(page.getByTestId('nft-lookup')).toBeVisible();
    // keyboard: the form is reachable and operable without a pointer
    await page.getByTestId('nft-lookup-address').focus(); await page.keyboard.type('not-an-address-but-long-enough-0000'); await page.keyboard.press('Enter');
    await expect(page.getByTestId('nft-lookup-error')).toHaveAttribute('data-code', 'bad_identifier', { timeout: 20_000 });
    await expect(page.getByTestId('nft-lookup-error')).toContainText('Invalid identifier');
    await expectNoOverflow(page, 'lookup desktop');
    await page.screenshot({ path: 'test-results/shots/nft-lookup-desktop-en-dark.png', fullPage: true });
  });
});

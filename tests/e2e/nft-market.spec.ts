// NFT delivery 3 (market READ) in a real browser, on the stack of tests/e2e/nft-server.mts.
//
//   A. no market provider (the default stack — a server without keys):
//        npx tsx tests/e2e/nft-server.mts --port 8870 &
//        SPW_E2E_BASE=http://localhost:8870 SPW_DEV_DIR=/tmp/spw-nft-e2e-8870 pnpm e2e nft-market.spec.ts
//      the reference Core item: every market field is "unavailable" WITH ITS REASON; the Market screen's actions are disabled
//      with the exact reason; the external links are a separate group with the outside-the-wallet facts; the sources fold and
//      the floor estimate (off by default).
//   B. scripted providers (`--market scripted`: the real OpenSea adapter over its live-recorded answers, a Magic Eden host that
//      does not answer):
//        npx tsx tests/e2e/nft-server.mts --port 8872 --market scripted &
//        SPW_E2E_MARKET=scripted SPW_E2E_BASE=http://localhost:8872 SPW_DEV_DIR=/tmp/spw-nft-e2e-8872 pnpm e2e nft-market.spec.ts
//      the same item: what OpenSea reported (a last sale in USDC, nothing listed, "verified by OpenSea"), Magic Eden in error —
//      side by side; trait frequency with its denominator; the collection page.
// The item itself is read live from the public Solana endpoints: when they do not answer, the test records a clean failure.
import { expect, test, type Page } from '@playwright/test';
import { deviceUse, expectNoOverflow, openWallet } from './v11-helpers.ts';

const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', SCRIPTED = process.env.SPW_E2E_MARKET === 'scripted';
/** opens the reference item through the lookup; false when the public endpoints did not answer (a clean failure, recorded) */
async function openReference(page: Page): Promise<boolean> {
  await page.goto('/nfts?v=lookup');
  await page.getByTestId('nft-lookup-address').fill(REF);
  await page.getByTestId('nft-lookup-go').click();
  const detail = page.getByTestId('nft-detail'), failure = page.getByTestId('nft-lookup-error');
  await expect(detail.or(failure)).toBeVisible({ timeout: 60_000 });
  if (await failure.isVisible()) { test.info().annotations.push({ type: 'reference-mint', description: `clean failure: ${await failure.getAttribute('data-code')}` }); return false; }
  await expect(page.getByTestId('nft-market')).toBeVisible({ timeout: 30_000 });
  return true;
}
const AMOUNT = /\d[\d.,]*\s?(SOL|USDC|ETH|USD)\b/;

test.describe('NFT market · no provider configured · phone · fr', () => {
  test.skip(SCRIPTED, 'this block runs on the default stack (no market provider)');
  test.use(deviceUse('phone', 'fr'));

  test('the reference Core item: every market field unavailable with its reason; the Market screen: disabled actions, external group apart', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'fr' });
    if (!await openReference(page)) return;
    const market = page.getByTestId('nft-market');
    await expect(market).toHaveAttribute('data-ok', '0'); await expect(market).toHaveAttribute('data-sources', '2');
    await expect(market.locator('[data-testid=nft-market-source][data-provider=opensea]')).toHaveAttribute('data-state', 'needs_key');
    await expect(market.locator('[data-testid=nft-market-source][data-provider=magiceden]')).toHaveAttribute('data-state', 'off');
    await expect(market).toContainText('OPENSEA_API_KEY'); await expect(market).toContainText('NFT_MARKET_MAGICEDEN'); await expect(page.getByTestId('nft-market-unavailable')).toBeVisible();
    expect(await market.innerText()).not.toMatch(AMOUNT);
    await expect(page.getByTestId('nft-market-value')).toContainText('Valeur de cet objet : non disponible');
    await expect(page.getByTestId('nft-rarity')).toContainText('non calculées'); await expect(page.getByTestId('nft-trait-frequency')).toHaveCount(0);
    // the API says the same thing: no figure anywhere in the market answer
    const api = await (await page.request.get(`/api/v1/nfts/market?key=${encodeURIComponent(`sol:solana:${REF}`)}`)).json() as { sources: { status: { state: string }; ask: { state: string }; lastSale: { state: string }; collectionFloor: { state: string } }[]; rates: object; actions: { available: boolean }[] };
    expect(api.sources.map((s) => s.status.state)).toEqual(['needs_key', 'off']); expect(api.sources.every((s) => s.ask.state === 'unknown' && s.lastSale.state === 'unknown' && s.collectionFloor.state === 'unknown')).toBe(true);
    expect(api.rates).toEqual({}); expect(api.actions.every((a) => a.available === false)).toBe(true);
    await page.screenshot({ path: 'test-results/shots/nft-market-none-phone-fr.png', fullPage: true });

    // the Market screen (brief §10.6)
    await page.getByTestId('nft-market-open').click();
    const screen = page.getByTestId('nft-market-screen');
    await expect(screen).toBeVisible(); await expect(page.getByTestId('nft-market-screen-id')).toHaveText(`sol:solana:${REF}`);
    await expect(page.getByTestId('nft-market-listings')).toContainText('Marché indisponible : clé manquante'); await expect(page.getByTestId('nft-market-offers')).toContainText('Marché indisponible : source désactivée');
    const internal = page.getByTestId('nft-market-actions-internal'), external = page.getByTestId('nft-market-actions-external');
    await expect(internal.getByRole('button')).toHaveCount(7);
    for (const b of await internal.getByRole('button').all()) await expect(b).toBeDisabled();
    await expect(page.getByTestId('nft-market-actions-why')).toHaveAttribute('data-reason', 'market_writes_not_built'); await expect(page.getByTestId('nft-market-actions-why')).toContainText('SP Wallet ne signe donc aucun ordre');
    await expect(external).toContainText('hors de SP Wallet'); await expect(external).toContainText('ni WalletConnect ni export de clé');
    const links = external.getByTestId('nft-market-link'); await expect(links).toHaveCount(2);
    for (const l of await links.all()) { await expect(l).toHaveAttribute('target', '_blank'); await expect(l).toHaveAttribute('rel', /noopener/); }
    await expect(links.last()).toHaveAttribute('href', `https://opensea.io/item/solana/${REF}`);
    // keyboard: the disabled actions are skipped, the first external link is reachable
    await links.first().focus(); await expect(links.first()).toBeFocused();
    await expectNoOverflow(page, 'market screen');
    await page.screenshot({ path: 'test-results/shots/nft-market-screen-none-phone-fr.png', fullPage: true });
  });

  test('the gallery: market sources with what each key would unlock; the floor estimate is off by default and labelled when turned on', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'fr' });
    await page.goto('/nfts');
    await expect(page.getByTestId('nft-gallery')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('nft-market-sources-fold').locator('summary').click();
    const prov = page.getByTestId('nft-market-providers');
    await expect(prov.locator('[data-provider=opensea]')).toHaveAttribute('data-state', 'needs_key'); await expect(prov.locator('[data-provider=opensea]')).toContainText('OPENSEA_API_KEY'); await expect(prov.locator('[data-provider=opensea]')).toContainText('Apporterait');
    await expect(prov.locator('[data-provider=magiceden]')).toHaveAttribute('data-state', 'off');
    await page.getByTestId('nft-estimate-fold').locator('summary').click();
    const est = page.getByTestId('nft-estimate');
    await expect(est).toHaveAttribute('data-enabled', 'false'); await expect(est).toContainText('Désactivée par défaut'); await expect(page.getByTestId('nft-estimate-label')).toHaveCount(0);
    await page.getByTestId('nft-estimate-toggle').click();
    await expect(est).toHaveAttribute('data-enabled', 'true'); await expect(page.getByTestId('nft-estimate-label')).toContainText('n’entre dans aucun total du portefeuille');
    await expect(page.getByTestId('nft-valuation')).toContainText('Valeur des NFT : non disponible');             // the gallery's own line does not change
    await page.getByTestId('nft-estimate-toggle').click(); await expect(est).toHaveAttribute('data-enabled', 'false');
    await expectNoOverflow(page, 'gallery market');
  });
});

test.describe('NFT market · scripted providers · phone · fr', () => {
  test.skip(!SCRIPTED, 'this block needs the stack started with --market scripted (SPW_E2E_MARKET=scripted)');
  test.use(deviceUse('phone', 'fr'));

  test('the reference item: what OpenSea reported beside a source in error; frequency with its denominator; the collection page', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'fr' });
    if (!await openReference(page)) return;
    const market = page.getByTestId('nft-market'), os = market.locator('[data-testid=nft-market-row][data-provider=opensea]'), me = market.locator('[data-testid=nft-market-row][data-provider=magiceden]');
    await expect(market).toHaveAttribute('data-ok', '1');
    await expect(os.getByTestId('nft-market-source')).toHaveAttribute('data-state', 'ok'); await expect(me.getByTestId('nft-market-source')).toHaveAttribute('data-state', 'error'); await expect(me).toContainText('Marché indisponible : erreur de la source');
    await expect(os.getByTestId('nft-market-listed')).toHaveText('non');
    await expect(os.getByTestId('nft-market-last-sale')).toHaveAttribute('data-amount', '14500000000'); await expect(os.getByTestId('nft-market-last-sale')).toHaveAttribute('data-currency', 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    await expect(os.getByTestId('nft-market-last-sale')).toContainText('14500 USDC'); await expect(os.getByTestId('nft-market-fiat')).toContainText('≈ 14 494.20 USD'); await expect(os.getByTestId('nft-market-fiat')).toContainText('taux coingecko');
    await expect(os.getByTestId('nft-market-ask')).toHaveCount(0); await expect(os).toContainText('aucun, selon la source'); await expect(os.getByTestId('nft-market-badge')).toHaveText('Collection vérifiée par OpenSea');
    await expect(os).toContainText('Market data: OpenSea'); await expect(page.getByTestId('nft-market-value')).toContainText('Valeur de cet objet : non disponible');
    // trait frequency: only with the source's stated total
    await expect(page.getByTestId('nft-rarity')).toHaveAttribute('data-computed', 'true', { timeout: 30_000 }); await expect(page.getByTestId('nft-rarity')).toContainText('sur 344 673 objets');
    await expect(page.getByTestId('nft-trait-frequency').filter({ hasText: '20,61 % de 344 673 objets indexés' })).toHaveCount(1);
    // market events: the sale, apart from the chain's transfers
    const ev = page.getByTestId('nft-market-activity');
    await expect(ev.locator('[data-type=sale]')).toHaveCount(1, { timeout: 30_000 }); await expect(ev.locator('[data-type=transfer]')).toHaveCount(0); await expect(ev).toContainText('distincts des transferts lus sur la chaîne');
    await expectNoOverflow(page, 'detail with market');
    await page.screenshot({ path: 'test-results/shots/nft-market-scripted-phone-fr.png', fullPage: true });
    // the collection page: verification with its source, floor and volume apart
    await page.getByTestId('nft-collection-link').click();
    const coll = page.getByTestId('nft-collection-market');
    await expect(coll).toBeVisible({ timeout: 30_000 }); await expect(page.getByTestId('nft-collection-verif')).toHaveAttribute('data-kind', 'verified_by'); await expect(page.getByTestId('nft-collection-verif')).toContainText('Collection vérifiée par OpenSea');
    await expect(coll.getByTestId('nft-collection-floor')).toHaveAttribute('data-amount', '360000'); await expect(coll.getByTestId('nft-collection-volume').first()).toContainText('tel que rapporté');
    await expect(coll.getByTestId('nft-collection-traits')).toContainText('344673'); await expect(coll.getByTestId('nft-collection-fees')).toContainText('1.00 %');
    // the logo and banner are loaded from this origin's proxy, never from the marketplace
    for (const img of await coll.locator('img').all()) expect(await img.getAttribute('src')).toMatch(/^\/api\/v1\/nfts\/media\/m[0-9a-f]{40}$/);
    await expectNoOverflow(page, 'collection market');
    await page.screenshot({ path: 'test-results/shots/nft-collection-market-phone-fr.png', fullPage: true });
  });
});

test.describe('NFT market · desktop · en · dark', () => {
  test.skip(SCRIPTED, 'default stack');
  test.use({ ...deviceUse('desktop', 'en'), colorScheme: 'dark' });
  test('the unavailable states in English on a desktop', async ({ page, context, baseURL }) => {
    await openWallet(page, context, baseURL, { lang: 'en', theme: 'dark' });
    if (!await openReference(page)) return;
    await expect(page.getByTestId('nft-market')).toContainText('Market unavailable: key missing'); await expect(page.getByTestId('nft-market-unavailable')).toContainText('nothing is made up in their place');
    await page.getByTestId('nft-open-market').click();
    await expect(page.getByTestId('nft-market-actions-why')).toContainText('SP Wallet therefore signs no order'); await expect(page.getByTestId('nft-market-actions-external')).toContainText('no WalletConnect and no key export');
    await expectNoOverflow(page, 'market screen en');
    await page.screenshot({ path: 'test-results/shots/nft-market-screen-none-desktop-en-dark.png', fullPage: true });
  });
});

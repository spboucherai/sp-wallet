// QA pass of 2026-11-11, kept as a spec: the screens that were merged without ever being opened in a browser, against the
// REAL local stack (real API, real signer with a throwaway in-memory seed, public read-only network access, broadcast OFF).
//
//   npx tsx tests/e2e/qa-real-server.mts --port 8690 --db spw_qa_polish --fork base,arbitrum     (a fresh stack, another terminal)
//   QA_REAL=1 npx playwright test -c tests/e2e/playwright.config.ts qa-agent-fund qa-real
//
// Runs after qa-agent-fund.spec.ts on the same stack (file order); the last test here leaves a signed, never-broadcast
// transfer behind, which blocks the network for anything that would run after it.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { NETWORKS } from '@spw/core';
import { enter, passkeyFile, probe, unexpectedErrors, virtualPasskey, watch } from './qa-helpers.ts';

// every deployment of the registry: one native asset per network plus its tokens. 249 when this spec was written; Cardano and
// Polkadot (v8) made it 251. Counted from the registry, so that a new network cannot leave a stale number here.
const DEPLOYMENTS = Object.values(NETWORKS).reduce((n, x) => n + 1 + x.tokens.length, 0);

const BASE = process.env.QA_BASE ?? 'http://localhost:8690', PORT = Number(new URL(BASE).port);
test.skip(!process.env.QA_REAL, 'needs the real local stack: set QA_REAL=1 (see the header)');
test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

async function start(page: Page, context: BrowserContext) {
  const pk = await virtualPasskey(context, page, passkeyFile(PORT));
  const w = watch(page);
  await enter(page, pk, process.env.QA_SETUP_TOKEN ?? 'qa-setup-token');
  return { pk, w };
}
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => { const r = await fetch('/api/v1' + p, { method: m as string, credentials: 'same-origin', headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) as any }; }, [method, path, body] as const);
const clean = async (page: Page) => { const p = await probe(page); expect(p.overflow, p.wide.join(' | ')).toBe(false); return p; };
const BSC_ETH = '0x2170Ed0880ac9A755fd29B2688956BD959F933F8';

test('registry of every deployment (251 since Cardano and Polkadot): issuer of pegged tokens, ordering, picker above the navigation, French numbers', async ({ page, context }) => {
  test.setTimeout(180_000);
  const { pk, w } = await start(page, context);
  await expect(page.getByText(/[+−]\d+,\d{2} % aujourd’hui/)).toBeVisible({ timeout: 60_000 });         // decimal comma in French
  // popular assets show the original issue, not a bridged copy
  await expect(page.getByRole('button', { name: /Tether USD/ })).toBeVisible();
  await expect(page.getByRole('main').getByText(/Bridged USDT/)).toHaveCount(0);

  // a token that keeps the underlying's ticker says who issues it
  await page.goto(`/asset/bsc/${BSC_ETH}`);
  await expect(page.getByRole('heading', { name: 'Binance-Peg Ethereum' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('asset-issuer')).toContainText('n’est pas l’émission d’origine de ETH');
  await expect(page.getByTestId('asset-issuer')).toContainText('Binance');
  await clean(page);

  // the full list: balances first, then majors by market rank; smooth with every row
  await page.goto('/assets');
  const rows = page.locator('main li');
  expect(DEPLOYMENTS).toBeGreaterThanOrEqual(251);
  await expect(rows).toHaveCount(DEPLOYMENTS, { timeout: 30_000 });
  // textContent, not innerText: since the v9 redesign the rows below the fold are `content-visibility: auto` (they are in the
  // document and in the accessibility tree, but not laid out until scrolled to), and innerText is empty for a row that is not laid out
  const order = await rows.evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ')));
  const at = (s: string) => order.findIndex((x) => x.includes(s));
  expect(at('USDC · Base')).toBeLessThan(3);                                                             // held
  expect(at('BTC · Bitcoin')).toBeGreaterThan(-1);
  expect(at('BTC · Bitcoin')).toBeLessThan(at('APT · Aptos'));                                           // rank, not alphabet
  const ms = await page.evaluate(`(async () => { const i = document.querySelector('input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const t0 = performance.now(); set.call(i, 'usd'); i.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t0; })()`) as number;
  expect(ms).toBeLessThan(250);
  await clean(page);

  // swap: the picker is a sheet ABOVE the bottom navigation, and names the issuer
  await page.goto('/swap');
  await page.getByRole('button', { name: /^Vous recevez/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('searchbox').fill('eth');
  await expect(dlg.getByText(/BNB Smart Chain · adossé — Binance/).first()).toBeVisible();
  const top = await page.evaluate(() => { const e = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 24); return !!e?.closest('[role=dialog]'); });
  expect(top).toBe(true);
  await dlg.getByRole('button', { name: 'Annuler' }).click();
  // a same-network route says it is executable here; the slippage control stays on one line and is 44 px high
  await page.getByLabel('Montant').fill('25');
  await expect(page.getByText('exécutable ici').first()).toBeVisible({ timeout: 40_000 });
  const slip = await page.getByRole('radio', { name: '0,5 %' }).boundingBox();
  expect(slip!.height).toBeGreaterThanOrEqual(44); expect(slip!.height).toBeLessThan(50);
  const p = await clean(page);
  expect(p.small).toEqual([]);                                                                            // every control on this screen is at least 44 px
  await pk.save();
  expect(unexpectedErrors(w)).toEqual([]);
});

test('agent creation: BNB Chain cash leg and representations, warnings kept on the agent page', async ({ page, context }) => {
  test.setTimeout(180_000);
  const { pk, w } = await start(page, context);
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Nouvel agent' }).click();
  // v10: the network is a group of chips with the networks' logos (it was a <select>): same eight networks, one tap
  const net = page.getByRole('radiogroup', { name: 'Réseau' });
  await expect(net.getByRole('radio')).toHaveCount(8, { timeout: 60_000 });
  await net.getByRole('radio', { name: 'BNB Smart Chain', exact: true }).click();
  await expect(net.getByRole('radio', { name: 'BNB Smart Chain', exact: true })).toHaveAttribute('aria-checked', 'true');
  // the 18-decimal Binance-Peg cash leg is named, with its issuer
  await expect(page.getByTestId('cash-issuer')).toContainText('USDC est « Binance-Peg USD Coin »');
  await expect(page.getByTestId('cash-issuer')).toContainText('18 décimales');
  await page.getByPlaceholder('ETH Trend').fill('QA BNB repr');
  await page.getByRole('checkbox', { name: /^BTC/ }).click();
  // both representations are shown; the default rule is unchanged (WBTC), the liquid one is pointed out
  const group = page.getByTestId('repr-BTC');
  await expect(group.getByRole('radio')).toHaveCount(2);
  await expect(group.getByRole('radio', { name: /WBTC/ })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio', { name: /WBTC/ })).toContainText('choix par défaut');
  await expect(group.getByRole('radio', { name: /BTCB/ })).toContainText('le plus liquide sur BNB Smart Chain');
  await expect(group).toContainText('BTCB est la forme la plus liquide de BTC ; la règle par défaut retient WBTC');
  await group.getByRole('radio', { name: /BTCB/ }).click();
  await expect(group.getByRole('radio', { name: /BTCB/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('checkbox', { name: /^ETH/ }).click();
  await clean(page);
  await page.getByRole('button', { name: 'Créer l’agent' }).click();
  await expect(page.getByRole('heading', { name: 'QA BNB repr' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/sous forme de BTCB — Binance-Peg BTCB · Émetteur : Binance/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/sous forme de ETH — Binance-Peg Ethereum · Émetteur : Binance/)).toBeVisible();
  await expect(page.getByText(/sous forme de USDC — Binance-Peg USD Coin/)).toBeVisible();
  await expect(page.getByRole('main').getByText('{native}')).toHaveCount(0);                              // no raw placeholder
  await clean(page);

  // Ethereum, small orders and a paper-only symbol: what the creation answer warned about stays on the page, in French
  const r = await api(page, 'POST', '/agents', { name: 'QA Eth avert', mission: '', network: 'ethereum', universe: ['ETH', 'EUR'], interval: '1h', capitalUsdc: '100', risk: { maxExposurePct: 50, maxLossPct: 5, maxOrderUsd: 1, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 50 } });
  expect(r.status).toBe(200);
  expect((r.json.warnings as { code: string }[]).map((x) => x.code)).toContain('paper_only');
  await page.goto(`/agents/${r.json.id}`);
  const warn = page.getByTestId('agent-warnings');
  await expect(warn).toContainText('EUR : le signataire ne peut pas en vérifier le prix', { timeout: 60_000 });
  if ((r.json.warnings as { code: string }[]).some((x) => x.code === 'fees')) await expect(warn).toContainText(/Sur Ethereum, un ordre coûte environ .* \$ US de frais de réseau/);
  await pk.save();
  expect(unexpectedErrors(w)).toEqual([]);
});

test('security: the limits of every deployment can be searched, by network name', async ({ page, context }) => {
  test.setTimeout(180_000);   // may wait for room in the rate limiter (qa-helpers.ts roomInRateLimit)
  const { pk } = await start(page, context);
  await page.goto('/security');
  await page.getByRole('button', { name: `Tout afficher (${DEPLOYMENTS})` }).click();
  await expect(page.locator('main [role=progressbar]')).toHaveCount(DEPLOYMENTS);
  await page.getByRole('searchbox').fill('bnb');
  await expect(page.getByText(new RegExp(`\\d+ sur ${DEPLOYMENTS}`))).toBeVisible();
  expect(await page.locator('main [role=progressbar]').count()).toBeLessThan(40);
  await expect(page.getByText('USDC · BNB Smart Chain')).toBeVisible();
  await expect(page.getByRole('main').getByText('· Bsc')).toHaveCount(0);
  await clean(page);
  await pk.save();
});

test('broadcast off: a transfer ends as "signed, not sent" — never as sent', async ({ page, context }) => {
  test.setTimeout(240_000);
  const { pk } = await start(page, context);
  await page.goto('/send');
  await page.locator('textarea').fill('0x1234');
  await page.getByPlaceholder('0.00').fill('5');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert')).toHaveText('Adresse invalide pour ce réseau.');                   // no English server sentence appended
  await page.locator('textarea').fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  // the API allows 240 requests a minute; the tests before this one can have used them up: wait and try again
  const review = page.getByRole('heading', { name: 'Vérification' }), limited = page.getByRole('alert').filter({ hasText: 'Trop de requêtes' });
  for (let k = 0; k < 5; k++) {
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await review.or(limited).first().waitFor({ timeout: 40_000 });
    if (await review.isVisible()) break;
    await page.waitForTimeout(20_000);
  }
  await expect(review).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Approuver/ }).click();
  await expect(page.getByText('Signé, non envoyé (test)')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText(/Mode test : la diffusion est désactivée sur ce serveur/)).toBeVisible();
  await expect(page.getByText('Voir dans l’explorateur')).toHaveCount(0);
  await page.goto('/activity');
  await expect(page.getByText('Signé, non envoyé (test)').first()).toBeVisible({ timeout: 30_000 });
  await clean(page);
  await pk.save();
});

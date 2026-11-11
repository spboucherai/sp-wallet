// "Financer l'agent" against the REAL local stack (real API, real signer, virtual passkey), broadcasting OFF.
//
//   npx tsx tests/e2e/qa-real-server.mts --port 8690 --db spw_qa_polish --fork base,arbitrum      (in another terminal; a FRESH
//   stack for every run: the signer's daily counters and the one-shot owner setup are part of what is asserted)
//   QA_REAL=1 npx playwright test -c tests/e2e/playwright.config.ts qa-agent-fund
//
// The stack points Base and Arbitrum at local anvil forks where the throwaway wallet holds 0.05 ETH (and 250 USDC on Base).
// Because broadcasting is off, a signed transfer never reaches any chain: the flow must say so and stop in a clear state.
// To walk the second step as well, `settle()` plays the network's part ON THE LOCAL FORK ONLY: it moves the amount with
// anvil's impersonation and marks the proposal finalized in the scratch database. Nothing here can touch a real network.
import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { enter, passkeyFile, probe, unexpectedErrors, virtualPasskey, watch } from './qa-helpers.ts';

const BASE = process.env.QA_BASE ?? 'http://localhost:8690', DB = process.env.QA_DB ?? 'spw_qa_polish', PORT = Number(new URL(BASE).port);
const FORK: Record<string, string> = { base: `http://127.0.0.1:${PORT + 1}`, arbitrum: `http://127.0.0.1:${PORT + 2}` };
const SHOTS = process.env.QA_SHOTS ?? 'test-results/qa-fund';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
test.skip(!process.env.QA_REAL, 'needs the real local stack: set QA_REAL=1 (see the header)');
test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

let rid = 0;
const rpc = async <T>(net: string, method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK[net]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as { result?: T; error?: { message: string } }; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T; };
const psql = (q: string) => execSync(`psql -At -d ${DB}`, { input: q, encoding: 'utf8' }).trim();
const hex = (v: bigint) => '0x' + v.toString(16);
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** Test-only stand-in for the network: apply the newest signed-but-not-broadcast transfer on the local fork and finalize it. */
async function settle(): Promise<void> {
  const row = psql(`select id, network, asset, amount, from_addr, to_addr from proposals where state = 'broadcast' order by updated_at desc limit 1`);
  if (!row) throw new Error('no signed transfer to settle');
  const [id, net, asset, amount, from, to] = row.split('|') as [string, string, string, string, string, string];
  if (asset === 'native') { const cur = BigInt(await rpc<string>(net, 'eth_getBalance', [to, 'latest'])); await rpc(net, 'anvil_setBalance', [to, hex(cur + BigInt(amount))]); }
  else { await rpc(net, 'anvil_impersonateAccount', [from]); await rpc(net, 'eth_sendTransaction', [{ from, to: asset, data: `0xa9059cbb${pad(to)}${BigInt(amount).toString(16).padStart(64, '0')}` }]); await rpc(net, 'anvil_stopImpersonatingAccount', [from]); }
  psql(`update proposals set state = 'finalized', error = null, finalized_at = now(), version = version + 1 where id = '${id}'`);
}
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => { const r = await fetch('/api/v1' + p, { method: m as string, credentials: 'same-origin', headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) as any }; }, [method, path, body] as const);
const createAgent = async (page: Page, name: string, network: string, universe: string[], capital = '60') => { const r = await api(page, 'POST', '/agents', { name, mission: '', network, universe, interval: '1h', capitalUsdc: capital }); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json as { id: string; vaultAddress: string }; };
async function start(page: Page, context: import('@playwright/test').BrowserContext) {
  const pk = await virtualPasskey(context, page, passkeyFile(PORT));
  const w = watch(page);
  await enter(page, pk, process.env.QA_SETUP_TOKEN ?? 'qa-setup-token');
  return { pk, w };
}
const shot = async (page: Page, name: string) => { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
const noOverflow = async (page: Page) => { const p = await probe(page); expect(p.overflow, p.wide.join(' | ')).toBe(false); };

test('fund an agent on its own network: fixed network, limits, two transfers one after the other, resume, checklist', async ({ page, context }) => {
  test.setTimeout(240_000);
  const { pk, w } = await start(page, context);
  const ag = await createAgent(page, 'QA Fonds', 'base', ['ETH', 'LINK']);
  await page.goto(`/agents/${ag.id}`);
  const list = page.getByTestId('agent-checklist');
  await expect(list.locator('[data-check=funds]')).toHaveAttribute('data-ok', 'false');
  await expect(list.locator('[data-check=gas]')).toHaveAttribute('data-ok', 'false');
  await expect(list.getByRole('button', { name: 'Financer l’agent' })).toBeVisible();   // the next action is the primary button
  await shot(page, '01-agent-checklist');

  await list.getByRole('button', { name: 'Financer l’agent' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Sur Base uniquement')).toBeVisible();
  await expect(sheet.getByText(ag.vaultAddress.slice(0, 6))).toBeVisible();
  await expect(sheet.getByRole('textbox')).toHaveCount(2);                              // two amounts; no network, no address to type
  await expect(sheet.getByText(/Votre portefeuille principal détient 250 USDC sur Base/)).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText(/Limite du signataire : 50 USDC par transfert, 100 par jour/)).toBeVisible();
  // suggested: the planned capital capped by the per-transfer limit, and what is missing to reach the gas reserve
  await expect(sheet.locator('#qa-fund-cash')).toHaveValue('50');
  const reserve = await sheet.locator('#qa-fund-gas').inputValue(); expect(Number(reserve.replace(',', '.'))).toBeGreaterThan(0);   // v8: a suggested amount is written with the screen's decimal comma
  await expect(sheet.getByText(/Ce serveur est en mode test/)).toBeVisible();
  await shot(page, '02-fund-sheet'); await noOverflow(page);

  // refusals in plain words, before anything is prepared
  await sheet.locator('#qa-fund-cash').fill('80');
  await expect(sheet.getByRole('alert')).toContainText('50 USDC au plus par transfert');
  await expect(sheet.getByRole('button', { name: /Envoyer .* à l’agent/ })).toBeDisabled();
  await sheet.locator('#qa-fund-cash').fill('300');
  await expect(sheet.getByRole('alert')).toContainText('Solde de USDC insuffisant sur Base');
  await shot(page, '03-fund-refusal');
  await sheet.getByRole('button', { name: 'Max' }).click();
  await expect(sheet.locator('#qa-fund-cash')).toHaveValue('50');
  await sheet.locator('#qa-fund-cash').fill('40');
  await expect(sheet.getByText(/Après le financement/)).toBeVisible();
  await expect(sheet.getByText(new RegExp(`40 USDC · ${reserve.replace('.', '\\.')} ETH`))).toBeVisible();

  // step 1/2: USDC, with the passkey; broadcasting is off here, so the flow stops in a clear state
  await sheet.getByRole('button', { name: /Envoyer 40 USDC \+ .* ETH à l’agent/ }).click();
  await expect(sheet.locator('[data-leg=cash]')).toHaveAttribute('data-state', 'test', { timeout: 40_000 });
  await expect(sheet.getByText(/Mode test : la diffusion est désactivée/)).toBeVisible();
  await expect(sheet.locator('[data-leg=gas]')).toHaveAttribute('data-state', 'todo');
  await shot(page, '04-fund-test-mode');

  // the network's part, on the local fork: the sheet picks the confirmation up and offers step 2/2
  await settle();
  await expect(sheet.locator('[data-leg=cash]')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  const step2 = sheet.getByRole('button', { name: /Étape 2\/2 : envoyer .* ETH/ });
  await expect(step2).toBeVisible();
  await shot(page, '05-fund-step2');

  // close and resume: nothing is lost
  await sheet.getByRole('button', { name: 'Fermer et reprendre plus tard' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Reprendre le financement' }).first().click();
  await expect(sheet.locator('[data-leg=cash]')).toHaveAttribute('data-state', 'done');
  await step2.click();
  await expect(sheet.locator('[data-leg=gas]')).toHaveAttribute('data-state', 'test', { timeout: 40_000 });
  await settle();
  await expect(sheet.getByText(/Financement envoyé sur Base/)).toBeVisible({ timeout: 20_000 });
  await shot(page, '06-fund-done');
  await sheet.getByRole('button', { name: 'Terminer' }).click();

  // the vault really holds the funds (on the fork), the checklist moved, the next action changed
  await expect(list.locator('[data-check=gas]')).toHaveAttribute('data-ok', 'true', { timeout: 30_000 });
  await expect(list.locator('[data-check=funds]')).toHaveAttribute('data-ok', 'part');
  await expect(list.getByText(/40 \$ US sur 60 prévus, en USDC sur Base/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reprendre le financement' })).toHaveCount(0);
  await shot(page, '07-agent-funded');

  // daily limit: 40 of 100 spent, so 60 left — and at most 50 per transfer
  await page.getByRole('button', { name: 'Financer l’agent' }).first().click();
  await expect(sheet.getByText(/reste 60 aujourd’hui/)).toBeVisible({ timeout: 20_000 });
  await expect(sheet.getByText(/La réserve de frais .* est déjà là/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Annuler' }).click();

  // withdraw to the main wallet: one asset at a time, the native coin last; signed but not sent on this server, and said so
  await page.getByRole('button', { name: 'Retirer', exact: true }).click();
  await expect(sheet.getByText(/De « QA Fonds » sur Base vers votre portefeuille principal/)).toBeVisible();
  await shot(page, '08-withdraw-sheet');
  await sheet.locator('li').filter({ hasText: 'USDC' }).getByRole('button', { name: 'Retirer' }).click();
  await expect(sheet.getByText(/Retrait de 40 USDC signé, mais non envoyé/)).toBeVisible({ timeout: 40_000 });
  await shot(page, '09-withdraw-test');
  await noOverflow(page);
  await pk.save();
  expect(unexpectedErrors(w)).toEqual([]);
});

test('funds on another network: explained, fee top-up offered, then withdrawal; Send names the agent and warns', async ({ page, context }) => {
  test.setTimeout(240_000);
  const { pk, w } = await start(page, context);
  const ag = await createAgent(page, 'QA Ailleurs', 'base', ['ETH']);
  // 20 USDC at the vault's address on ARBITRUM (the owner's mistake), and no ETH there: balance slot of Circle's FiatToken (mapping at slot 9)
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ag.vaultAddress as `0x${string}`, 9n]));
  await rpc('arbitrum', 'anvil_setStorageAt', [USDC_ARB, slot, '0x' + (20_000000n).toString(16).padStart(64, '0')]);
  await page.goto(`/agents/${ag.id}`);
  const box = page.getByTestId('agent-elsewhere');
  await expect(box.getByText('Fonds sur d’autres réseaux')).toBeVisible({ timeout: 60_000 });
  await expect(box.getByText('20 USDC')).toBeVisible();
  await expect(box.getByText(/L’agent ne peut pas les utiliser/)).toBeVisible();
  await expect(box.getByText(/Le retrait coûte des frais en ETH sur Arbitrum One/)).toBeVisible();
  await expect(box.getByRole('button', { name: 'Retirer' })).toBeDisabled();
  await box.scrollIntoViewIfNeeded(); await shot(page, '10-elsewhere-no-gas');
  await box.getByRole('button', { name: /Envoyer .* ETH pour les frais sur Arbitrum One/ }).click();
  await expect(box.getByText(/Mode test : la diffusion est désactivée/)).toBeVisible({ timeout: 40_000 });
  await settle();                                                                       // the fee arrives (local fork)
  await page.reload();
  await expect(box.getByRole('button', { name: 'Retirer' }).first()).toBeEnabled({ timeout: 60_000 });
  await box.getByRole('button', { name: 'Retirer' }).first().click();
  await expect(box.getByText(/Retrait de 20 USDC signé, mais non envoyé/)).toBeVisible({ timeout: 40_000 });
  await box.scrollIntoViewIfNeeded(); await shot(page, '11-elsewhere-withdrawn');

  // generic Send screen: the recipient is recognised; the wrong network is called out (not blocked)
  await page.goto('/send?n=ethereum');
  await page.locator('textarea').fill(ag.vaultAddress);
  await expect(page.getByRole('alert')).toContainText('portefeuille de votre agent « QA Ailleurs », qui vit sur Base — pas sur Ethereum');
  await shot(page, '12-send-wrong-network');
  await page.getByRole('radio', { name: 'Base', exact: true }).click();
  await page.locator('textarea').fill(ag.vaultAddress);
  await expect(page.getByText(/portefeuille de votre agent « QA Ailleurs », qui vit sur Base\. Pour le financer/)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await noOverflow(page);
  await pk.save();
  expect(unexpectedErrors(w)).toEqual([]);
});

test('no cash on the agent network: USDC elsewhere is listed and CCTP is offered prefilled; 18-decimal cash leg on BNB Chain', async ({ page, context }) => {
  test.setTimeout(180_000);
  const { pk } = await start(page, context);
  const arb = await createAgent(page, 'QA Arbitrum', 'arbitrum', ['ETH']);
  await page.goto(`/agents/${arb.id}`);
  await page.getByRole('button', { name: 'Financer l’agent' }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Sur Arbitrum One uniquement')).toBeVisible();
  await expect(sheet.getByText(/Pas assez de USDC sur Arbitrum One dans votre portefeuille principal/)).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText(/USDC · Base/)).toBeVisible();
  await shot(page, '13-fund-usdc-elsewhere');
  await sheet.getByRole('button', { name: /Transférer des USDC de Base vers Arbitrum One/ }).click();
  await expect(page.getByRole('button', { name: /^Vous payez: USDC Base/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^Vous recevez.*: USDC Arbitrum One/ })).toBeVisible();

  const bnb = await createAgent(page, 'QA BNB', 'bsc', ['BNB']);
  await page.goto(`/agents/${bnb.id}`);
  await page.getByRole('button', { name: 'Financer l’agent' }).first().click();
  await expect(sheet.getByText('Sur BNB Smart Chain uniquement')).toBeVisible();
  await expect(sheet.getByText(/Binance-Peg USD Coin/)).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText(/Il vous faut du BNB sur BNB Smart Chain/)).toBeVisible();
  // 18 decimals: an amount with 18 places is kept exactly, and the limit is the same 50 units
  await sheet.locator('#qa-fund-cash').fill('1.000000000000000001');
  await expect(sheet.getByText(/Limite du signataire : 50 USDC par transfert/)).toBeVisible();
  await expect(sheet.getByRole('alert').first()).toContainText('Solde de USDC insuffisant sur BNB Smart Chain');
  await shot(page, '14-fund-bnb');
  await noOverflow(page);
  await pk.save();
});

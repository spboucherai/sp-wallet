// Any-to-any plans in the UI, against the REAL local stack (real API, real signer, real quotes, virtual passkey), broadcasting OFF.
//
//   node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)
//   npx tsx tests/e2e/qa-real-server.mts --port 8760 --db spw_qa_plan --fork base,arbitrum     (another terminal; a FRESH stack per run)
//   QA_REAL=1 QA_BASE=http://localhost:8760 QA_DB=spw_qa_plan npx playwright test -c tests/e2e/playwright.config.ts qa-plan
//
// The stack points Base and Arbitrum at local anvil forks where the throwaway wallet holds 0.05 ETH (and 250 USDC on Base).
// Because broadcasting is off, a signed leg never reaches any chain: the plan must say it is waiting and stay resumable.
// To walk the next leg, `settle()` plays the network's part ON THE LOCAL FORK AND THE SCRATCH DATABASE ONLY: it gives the
// wallet what the leg would have delivered and marks the leg's proposal as settled. Nothing here can touch a real network.
// (The real chain behaviour of every leg is proven end to end by scripts/fork-plan.mts.)
import { execSync } from 'node:child_process';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { enter, passkeyFile, probe, virtualPasskey, watch } from './qa-helpers.ts';

const BASE = process.env.QA_BASE ?? 'http://localhost:8760', DB = process.env.QA_DB ?? 'spw_qa_plan', PORT = Number(new URL(BASE).port);
const FORK: Record<string, string> = { base: `http://127.0.0.1:${PORT + 1}`, arbitrum: `http://127.0.0.1:${PORT + 2}` };
const SHOTS = process.env.QA_SHOTS ?? 'docs/v7/screens';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
test.skip(!process.env.QA_REAL, 'needs the real local stack: set QA_REAL=1 (see the header)');
test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

let rid = 0;
const rpc = async <T>(net: string, method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK[net]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as { result?: T; error?: { message: string } }; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T; };
const psql = (q: string) => execSync(`psql -At -d ${DB}`, { input: q, encoding: 'utf8' }).trim();
/** Test-only stand-in for the network: the newest signed-but-not-broadcast leg is given its outcome (fork + scratch database). */
async function settle(): Promise<void> {
  const row = psql(`select id, kind, amount, from_addr, coalesce(swap->>'expectedOut', '') from proposals where state = 'broadcast' order by updated_at desc limit 1`);
  if (!row) throw new Error('no signed leg to settle');
  const [id, kind, amount, me, expected] = row.split('|') as [string, string, string, string, string];
  if (kind === 'bridge') { // the USDC "arrives" on the Arbitrum fork (FiatToken balance mapping at slot 9)
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [me as `0x${string}`, 9n]));
    const cur = BigInt(await rpc<string>('arbitrum', 'eth_getStorageAt', [USDC_ARB, slot, 'latest']));
    await rpc('arbitrum', 'anvil_setStorageAt', [USDC_ARB, slot, '0x' + (cur + BigInt(amount)).toString(16).padStart(64, '0')]);
    psql(`update proposals set state = 'finalized', error = null, finalized_at = now(), version = version + 1, out_amount = ${amount}, bridge = jsonb_set(bridge, '{phase}', '"done"') where id = '${id}'`);
  } else psql(`update proposals set state = 'finalized', error = null, finalized_at = now(), version = version + 1, out_amount = ${expected} where id = '${id}'`);
}
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => { const r = await fetch('/api/v1' + p, { method: m as string, credentials: 'same-origin', headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) as any }; }, [method, path, body] as const);
async function start(page: Page, context: BrowserContext) {
  const pk = await virtualPasskey(context, page, passkeyFile(PORT));
  const w = watch(page);
  await enter(page, pk, process.env.QA_SETUP_TOKEN ?? 'qa-setup-token');
  return { pk, w };
}
const shot = async (page: Page, name: string, full = false) => { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/plan-${name}.png`, fullPage: full }); };
const noOverflow = async (page: Page) => { const p = await probe(page); expect(p.overflow, p.wide.join(' | ')).toBe(false); };
/** choose the destination asset in the Swap screen's picker */
async function pickTo(page: Page, search: string, row: RegExp) {
  await page.getByRole('button', { name: /^Vous recevez/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('searchbox').fill(search);
  await dlg.getByRole('button', { name: row }).first().click();
}
const amount = (page: Page) => page.getByRole('textbox', { name: 'Montant' });
const cards = (page: Page) => page.getByTestId('plan-card');
const progress = (page: Page) => page.getByTestId('plan-progress');

test('USDC on Base → LINK on Arbitrum: "bridge then swap", two approvals, planned vs actual, resumable; refusals and non-executable pairs are said', async ({ page, context, browser }) => {
  test.setTimeout(420_000);
  const { pk, w } = await start(page, context);

  // ── the plans for a cross-network pair ───────────────────────────────────────────────────────────────────────────────
  await page.goto('/swap');
  await pickTo(page, 'LINK', /LINK.*Arbitrum/);
  await amount(page).fill('20');
  await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });
  await expect(cards(page)).toHaveCount(2);                                         // CCTP Standard and Fast, each followed by the swap
  const first = cards(page).first();
  await expect(first).toHaveAttribute('data-executable', 'true');
  await expect(first).toContainText('Transférer puis échanger'); await expect(first).toContainText('2 approbations');
  await expect(first).toContainText('attendu'); await expect(first).toContainText('garanti au pire');
  await expect(first).toContainText('Circle CCTP'); await expect(first).toContainText('KyberSwap');
  await expect(first.getByTestId('plan-gas')).toHaveCount(2);                       // ETH on Base and ETH on Arbitrum
  for (const g of await first.getByTestId('plan-gas').all()) await expect(g).toHaveAttribute('data-ok', 'true');
  await expect(first).toContainText(/Étape 1 : 20 USDC sur Base — limite 50 par transfert/);
  await expect(page.getByText('Exécution non activée')).toHaveCount(0);            // a startable plan replaces the dead end
  await first.scrollIntoViewIfNeeded(); await shot(page, '01-cards-phone', true);
  await noOverflow(page);

  // ── start: the guarantees are said before anything exists ───────────────────────────────────────────────────────────
  await first.getByRole('button', { name: /Démarrer ce plan \(2 approbations\)/ }).click();
  const sheet = page.getByTestId('plan-start');
  await expect(sheet).toContainText('Le minimum de bout en bout n’est PAS garanti à l’avance');
  await expect(sheet).toContainText('Si vous abandonnez, rien n’est bloqué');
  await shot(page, '02-start-phone');
  await sheet.getByRole('button', { name: /Démarrer — rien n’est signé maintenant/ }).click();
  await expect(progress(page)).toHaveAttribute('data-next', 'prepare');
  expect((await api(page, 'GET', '/activity')).json.items.filter((i: any) => i.kind !== 'receive')).toHaveLength(0);   // starting prepared nothing
  await expect(progress(page).getByTestId('plan-leg')).toHaveCount(2);
  await shot(page, '03-progress-ready-phone');

  // ── leg 1: prepare, review, passkey ─────────────────────────────────────────────────────────────────────────────────
  await page.getByTestId('plan-prepare').click();
  await expect(page.getByTestId('plan-review')).toContainText('Étape 1 sur 2 à approuver', { timeout: 60_000 });
  await expect(page.getByTestId('plan-review')).toContainText('20 USDC · Base');
  await shot(page, '04-leg1-review-phone');
  await page.getByTestId('plan-approve').click();                                   // the virtual authenticator answers
  await expect(progress(page)).toHaveAttribute('data-next', 'wait', { timeout: 60_000 });
  await expect(page.getByTestId('plan-wait')).toContainText('Étape 1 sur 2 en cours');
  await pk.save();
  await shot(page, '05-leg1-waiting-phone');
  // closing and coming back: the plan is found again from Activity
  await page.goto('/activity');
  await expect(page.getByTestId('plan-list')).toContainText('USDC (Base) → LINK (Arbitrum One)');
  await shot(page, '06-activity-phone');
  await settle();                                                                   // FORK + SCRATCH DB ONLY: the transfer "arrives"
  await page.getByTestId('plan-list').getByRole('button').first().click();
  await expect(progress(page)).toHaveAttribute('data-current', '1', { timeout: 30_000 });
  await expect(progress(page)).toHaveAttribute('data-next', 'prepare');
  await expect(progress(page).getByTestId('plan-leg').first()).toHaveAttribute('data-state', 'settled');
  await expect(page.getByTestId('plan-holding')).toContainText('20 USDC · Arbitrum One');
  await shot(page, '07-leg2-ready-phone');

  // ── leg 2: a fresh quote on what was received, its own minimum, its own passkey ─────────────────────────────────────
  await page.getByTestId('plan-prepare').click();
  await expect(page.getByTestId('plan-review')).toContainText('Étape 2 sur 2 à approuver', { timeout: 90_000 });
  await expect(page.getByTestId('plan-minout')).toContainText('LINK');
  await shot(page, '08-leg2-review-phone');
  await page.getByTestId('plan-approve').click();
  await expect(progress(page)).toHaveAttribute('data-next', 'wait', { timeout: 60_000 });
  await pk.save();
  await settle();
  await expect(progress(page).getByTestId('plan-state')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('plan-received')).toContainText('LINK');
  await shot(page, '09-done-phone');
  await noOverflow(page);
  const doneId = (await api(page, 'GET', '/plans')).json.plans[0].id as string;

  // ── a refused step pauses the plan: retry, re-plan, stop ────────────────────────────────────────────────────────────
  await page.goto('/swap');
  await pickTo(page, 'LINK', /LINK.*Arbitrum/);
  await amount(page).fill('10');
  await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });
  await cards(page).first().getByRole('button', { name: /Démarrer ce plan/ }).click();
  await page.getByTestId('plan-start').getByRole('button', { name: /Utiliser ce pire cas/ }).click();   // an overall floor
  await page.getByTestId('plan-start').getByRole('button', { name: /Démarrer — rien n’est signé maintenant/ }).click();
  await page.getByTestId('plan-prepare').click();
  await expect(page.getByTestId('plan-approve')).toBeVisible({ timeout: 60_000 });
  const open = (await api(page, 'GET', '/plans?open=1')).json.plans[0];
  expect(open.floorDisplay).not.toBeNull();
  await api(page, 'POST', `/transfers/proposals/${open.proposal.id}/reject`);       // the owner declines the step
  await expect(page.getByTestId('plan-paused')).toHaveAttribute('data-code', 'refused', { timeout: 20_000 });
  await expect(page.getByTestId('plan-paused')).toContainText('Les fonds sont à votre adresse : 10 USDC sur Base');
  for (const id of ['plan-retry', 'plan-replan', 'plan-stop']) await expect(page.getByTestId(id)).toBeVisible();
  await shot(page, '10-paused-phone');
  await page.getByTestId('plan-stop').click();
  await expect(progress(page).getByTestId('plan-state')).toHaveAttribute('data-state', 'stopped');
  await expect(progress(page)).toContainText('10 USDC restent sur Base, à votre adresse, comme un solde ordinaire');
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).last().click();

  // ── what is not executable is said, with the reason; what is missing is named ───────────────────────────────────────
  // (v8: Solana ↔ EVM became executable through CCTP, so the example of a pair without execution is now Tron)
  await pickTo(page, 'TRX', /TRX\b.*Tron/i);
  await amount(page).fill('10');
  await expect(page.getByTestId('plan-not-executable')).toContainText('Pas encore exécutable', { timeout: 30_000 });
  await expect(page.getByTestId('plan-not-executable')).toContainText('n’exécute encore aucun échange ni transfert entre réseaux');
  await expect(cards(page)).toHaveCount(0);
  await shot(page, '11-network-not-executable-phone');
  await pickTo(page, 'OP', /^OP\b.*OP Mainnet|OP.*Optimism/);                       // a network where the throwaway wallet holds no ETH
  await amount(page).fill('12');
  await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });
  await expect(cards(page).first()).toHaveAttribute('data-executable', 'false');
  await expect(cards(page).first().getByTestId('plan-issues')).toContainText(/Il manque du ETH sur (OP Mainnet|Optimism)/);
  await expect(cards(page).first().getByRole('button', { name: /Recevoir du ETH sur/ })).toBeVisible();
  await expect(cards(page).first().getByRole('button', { name: /Démarrer ce plan/ })).toBeDisabled();
  await cards(page).first().getByTestId('plan-issues').scrollIntoViewIfNeeded();
  await shot(page, '12-gas-missing-phone');
  await noOverflow(page);
  expect(w.errors.filter((e) => !/Failed to load resource/.test(e) && !/bad HTTP response code \(429\) was received when fetching the script/.test(e)), w.errors.join('\n')).toEqual([]);

  // ── desktop ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const dctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1360, height: 900 } }), d = await dctx.newPage();
  const dpk = await virtualPasskey(dctx, d, passkeyFile(PORT));
  await enter(d, dpk, 'unused');
  await d.goto(`/plan/${doneId}`);
  await expect(progress(d).getByTestId('plan-state')).toHaveAttribute('data-state', 'done');
  await shot(d, '13-progress-desktop');
  await d.goto('/swap');
  await pickTo(d, 'LINK', /LINK.*Arbitrum/);
  await amount(d).fill('15');
  await expect(cards(d).first()).toBeVisible({ timeout: 60_000 });
  await shot(d, '14-cards-desktop', true);
  await dctx.close();
});

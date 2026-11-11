// v10 design pass — screenshots of the Swap area (Swap, the asset picker, the review receipt, the CCTP bridge, any-to-any
// plans, the plan list in Activity), BEFORE and AFTER, against two throwaway QA stacks (broadcast OFF, local forks):
//
//   (cd apps/web && node_modules/.bin/vite build)
//   npx tsx tests/e2e/qa-real-server.mts --port 8810 --db spw_v10_swap --fork base,arbitrum            (single-leg screens)
//   npx tsx tests/e2e/qa-real-server.mts --port 8815 --db spw_v10_swap_plan --fork base,arbitrum       (plans)
//   npx tsx tests/e2e/v10-shots-swap.mts before|after [only-name,…] [phone-light,…]
//
// Nothing is broadcast. Like qa-plan.spec.ts, `settle()` plays the network's part ON THE LOCAL FORK AND THE SCRATCH
// DATABASE ONLY, so that a plan can be shown with a finished first leg. Every scenario starts by withdrawing what the
// previous one left open (pending proposals are rejected, an open plan is stopped).
//
// The plan stack is good for ONE configuration: `plan-leg2` signs a transfer that is never broadcast, and the signer will not
// sign a second one on that network afterwards. Restart it (fresh) before each configuration of the plan scenarios:
//   for c in phone-light phone-dark desktop-light desktop-dark; do <restart the 8815 stack>; npx tsx tests/e2e/v10-shots-swap.mts after \
//     plans,plan-start,plan-ready,plan-leg-review,plan-paused,plan-leg2,activity-plans,plan-page,swap-plan-open,plan-stopped $c; done
import { execSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { roomInRateLimit } from './qa-helpers.ts';
import { api, qaEnter, runShots, type Scenario } from './v10-shots-lib.mts';

const A = process.env.V10_SWAP_BASE ?? 'http://localhost:8810', B = process.env.V10_PLAN_BASE ?? 'http://localhost:8815', PLAN_DB = process.env.V10_PLAN_DB ?? 'spw_v10_swap_plan';
const FORK_ARB = `http://127.0.0.1:${Number(new URL(B).port) + 2}`, USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const psql = (q: string) => execSync(`psql -At -d ${PLAN_DB}`, { input: q, encoding: 'utf8' }).trim();
let rid = 0;
const rpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK_ARB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as { result?: T; error?: { message: string } }; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T; };
/** the newest signed-but-never-broadcast bridge leg "arrives" (fork + scratch database of the plan stack only) */
async function settle(): Promise<void> {
  const row = psql(`select id, kind, amount, from_addr from proposals where state = 'broadcast' order by updated_at desc limit 1`);
  if (!row) throw new Error('no signed leg to settle');
  const [id, kind, amount, me] = row.split('|') as [string, string, string, string];
  if (kind !== 'bridge') throw new Error('only the bridge leg is settled here');
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [me as `0x${string}`, 9n]));
  const cur = BigInt(await rpc<string>('eth_getStorageAt', [USDC_ARB, slot, 'latest']));
  await rpc('anvil_setStorageAt', [USDC_ARB, slot, '0x' + (cur + BigInt(amount)).toString(16).padStart(64, '0')]);
  psql(`update proposals set state = 'finalized', error = null, finalized_at = now(), version = version + 1, out_amount = ${amount}, bridge = jsonb_set(bridge, '{phase}', '"done"') where id = '${id}'`);
}
/** withdraw what an earlier scenario left: routes, pending approvals, an open plan */
async function clear(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await roomInRateLimit(page, 90);   // the API allows a client 240 requests a minute: a scenario starts when the window has room
  const open = (await api(page, 'GET', '/plans?open=1')).json?.plans ?? [];
  for (const p of open) { const r = await api(page, 'POST', `/plans/${p.id}/stop`); if (r.status >= 400) { await settle().catch(() => {}); await page.waitForTimeout(5000); await api(page, 'POST', `/plans/${p.id}/stop`); } }   // a leg in flight is settled first (fork + scratch database)
  const items = (await api(page, 'GET', '/activity')).json?.items ?? [];
  for (const i of items) if (i.state === 'pending_approval') await api(page, 'POST', `/transfers/proposals/${i.id}/reject`);
}
const amount = (page: Page) => page.getByLabel('Montant');
async function pickTo(page: Page, search: string, row: RegExp) {
  await page.getByRole('button', { name: /^Vous recevez/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('searchbox').fill(search);
  await dlg.getByRole('button', { name: row }).first().click();
}
const quotes = async (page: Page, n = '25') => { await clear(page); await amount(page).fill(n); await page.getByText('exécutable ici').first().waitFor({ timeout: 45_000 }); };
const top = (page: Page) => page.evaluate(() => window.scrollTo(0, 0));
const plans = async (page: Page, n = '6') => { await clear(page); await pickTo(page, 'LINK', /LINK.*Arbitrum/); await amount(page).fill(n); await page.getByTestId('plan-card').first().waitFor({ timeout: 70_000 }); };
const startPlan = async (page: Page) => {
  await plans(page);
  await page.getByTestId('plan-card').first().getByRole('button', { name: /Démarrer ce plan/ }).click();
  await page.getByTestId('plan-start').getByRole('button', { name: /Démarrer — rien n’est signé maintenant/ }).click();
  await page.getByTestId('plan-progress').waitFor({ timeout: 30_000 });
};
/** a plan whose first leg (the transfer) is finished and whose second leg waits for its preparation */
const legTwo = async (page: Page) => {
  await startPlan(page);
  await page.getByTestId('plan-prepare').click();
  await page.getByTestId('plan-approve').click({ timeout: 70_000 });
  await page.locator('[data-testid=plan-progress][data-next=wait]').waitFor({ timeout: 70_000 });
  await settle();
  await page.locator('[data-testid=plan-progress][data-current="1"][data-next=prepare]').waitFor({ timeout: 40_000 });
};

const single: Scenario[] = [
  { name: 'empty', path: '/swap', full: true, act: clear },
  { name: 'quotes', path: '/swap', full: true, act: async (page) => { await quotes(page); await top(page); } },
  { name: 'route-open', path: '/swap', act: async (page) => { await quotes(page); const b = page.locator('section.card button[aria-expanded]').first(); await b.click(); await b.scrollIntoViewIfNeeded(); } },
  { name: 'picker', path: '/swap', act: async (page) => { await clear(page); await page.getByRole('button', { name: /^Vous recevez/ }).click(); await page.getByRole('dialog').getByRole('searchbox').fill('eth'); } },
  { name: 'insufficient', path: '/swap', act: async (page) => { await quotes(page, '300'); await page.getByRole('button', { name: /Échanger via/ }).click(); await page.getByRole('alert').first().waitFor({ timeout: 45_000 }); await page.getByRole('alert').first().scrollIntoViewIfNeeded(); } },
  { name: 'review', path: '/swap', act: async (page) => { await quotes(page); await page.getByRole('button', { name: /Échanger via/ }).click(); await page.getByRole('dialog').getByRole('button', { name: /Approuver/ }).waitFor({ timeout: 45_000 }); } },
  { name: 'review-end', path: '/swap', skip: (c) => !c.mobile, act: async (page) => { await quotes(page); await page.getByRole('button', { name: /Échanger via/ }).click(); const ok = page.getByRole('dialog').getByRole('button', { name: /Approuver/ }); await ok.waitFor({ timeout: 45_000 }); await ok.scrollIntoViewIfNeeded(); } },
  { name: 'bridge', path: '/swap?bridgeFrom=base&bridgeTo=arbitrum&amount=25', full: true, act: async (page) => { await clear(page); await page.getByRole('button', { name: /Transférer vers/ }).waitFor({ timeout: 45_000 }); await top(page); } },
  { name: 'bridge-review', path: '/swap?bridgeFrom=base&bridgeTo=arbitrum&amount=25', act: async (page) => { await clear(page); await page.getByRole('button', { name: /Transférer vers/ }).click({ timeout: 45_000 }); await page.getByRole('dialog').getByRole('button', { name: /Approuver/ }).waitFor({ timeout: 45_000 }); } },
  { name: 'loading', path: '/swap', wait: 1200, full: true, act: async (page) => { await clear(page); await page.route('**/swap/quote/stream*', () => { /* never answered: the skeletons stay */ }); await amount(page).fill('25'); await page.waitForTimeout(1500); } },
  { name: 'error', path: '/swap', full: true, act: async (page) => { await clear(page); await page.route('**/swap/quote/stream*', (r) => r.abort()); await amount(page).fill('25'); await page.waitForTimeout(2500); } },
  // last of its group: the context stays offline
  { name: 'offline', path: '/swap', full: true, act: async (page) => { await clear(page); await page.context().setOffline(true); await amount(page).fill('25'); await page.waitForTimeout(2500); } },
];
const multi: Scenario[] = [
  { name: 'plans', path: '/swap', full: true, act: async (page) => { await plans(page); await page.getByTestId('plan-card').first().scrollIntoViewIfNeeded(); } },
  { name: 'plan-start', path: '/swap', act: async (page) => { await plans(page); await page.getByTestId('plan-card').first().getByRole('button', { name: /Démarrer ce plan/ }).click(); await page.getByTestId('plan-start').waitFor(); } },
  { name: 'plan-ready', path: '/swap', act: startPlan },
  { name: 'plan-leg-review', path: '/swap', act: async (page) => { await startPlan(page); await page.getByTestId('plan-prepare').click(); await page.getByTestId('plan-approve').waitFor({ timeout: 70_000 }); await page.getByTestId('plan-review').scrollIntoViewIfNeeded(); } },
  { name: 'plan-paused', path: '/swap', act: async (page) => { await startPlan(page); await page.getByTestId('plan-prepare').click(); await page.getByTestId('plan-approve').waitFor({ timeout: 70_000 });
    const open = (await api(page, 'GET', '/plans?open=1')).json.plans[0]; await api(page, 'POST', `/transfers/proposals/${open.proposal.id}/reject`); await page.getByTestId('plan-paused').waitFor({ timeout: 30_000 }); await page.getByTestId('plan-paused').scrollIntoViewIfNeeded(); } },
  { name: 'plan-leg2', path: '/swap', act: legTwo },
  // the three next ones show the plan left open by plan-leg2
  { name: 'activity-plans', path: '/activity', act: async (page) => { await page.getByTestId('plan-list').waitFor({ timeout: 30_000 }); } },
  { name: 'plan-page', path: '/swap', full: true, act: async (page) => { const id = (await api(page, 'GET', '/plans?open=1')).json.plans[0].id as string; await page.goto(`/plan/${id}`); await page.getByTestId('plan-progress').waitFor({ timeout: 30_000 }); await page.waitForTimeout(1500); } },
  { name: 'swap-plan-open', path: '/swap', act: async (page) => { await pickTo(page, 'LINK', /LINK.*Arbitrum/); await page.getByTestId('plan-cards').waitFor({ timeout: 30_000 }); await page.waitForTimeout(1200); } },
  { name: 'plan-stopped', path: '/activity', act: async (page) => { await clear(page); await page.reload(); await page.getByTestId('plan-list').getByRole('button').first().click({ timeout: 30_000 }); await page.getByTestId('plan-progress').waitFor({ timeout: 30_000 }); } },
];

await runShots('swap', [{ base: B, setup: qaEnter, scenarios: multi }, { base: A, setup: qaEnter, scenarios: single }]);

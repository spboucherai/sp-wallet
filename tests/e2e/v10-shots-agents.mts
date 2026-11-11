// v10 design pass — screenshots of the AGENTS area (agents list, creation forms, spot agent page, checklist, funding and
// withdraw sheets, perp agent in simulation and live), BEFORE and AFTER, phone and desktop, light and dark, French.
//
//   (cd apps/web && node_modules/.bin/vite build)
//   npx tsx tests/e2e/qa-real-server.mts --port 8820 --db spw_v10_agents --workers on --fork base,arbitrum      (another terminal)
//   npx tsx tests/e2e/v10-shots-agents.mts before|after [only-name,…] [phone-light,…]
//
// Spot agents: the REAL local QA stack (throwaway in-memory seed, broadcast off, local forks). The stack is seeded through the
// API from the page; the funded vault is written on the LOCAL fork only (anvil storage / balance), nothing touches a network.
// Perp agents: the in-browser mock of the Vite dev server (`?mock=1&perp=<scenario>`), on this area's own port (5320).
import type { BrowserContext, Page } from '@playwright/test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { api, qaEnter, runShots, settle, startVite, type Cfg, type Scenario } from './v10-shots-lib.mts';

const QA = process.env.QA_BASE ?? 'http://localhost:8820', QA_PORT = Number(new URL(QA).port), VITE_PORT = 5320;
const FORK_BASE = `http://127.0.0.1:${QA_PORT + 1}`, USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PERP = '7e57a9e1-0000-4000-8000-000000000001';

let rid = 0;
const rpc = async (method: string, params: unknown[]): Promise<unknown> => { const r = await fetch(FORK_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); return ((await r.json()) as { result?: unknown }).result; };
/** the agent's vault, funded on the local fork only: USDC (Circle's FiatToken keeps balances in the mapping at slot 9) and the native coin */
async function fundOnFork(vault: string, usdc: bigint, wei: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [vault as `0x${string}`, 9n]));
  await rpc('anvil_setStorageAt', [USDC_BASE, slot, '0x' + usdc.toString(16).padStart(64, '0')]);
  await rpc('anvil_setBalance', [vault, '0x' + wei.toString(16)]);
}

const ids: { funded?: string; fresh?: string } = {};
/** two agents: one funded on Base with a tested, approved strategy running on paper; one just created on Arbitrum */
async function seed(page: Page, context: BrowserContext, cfg: Cfg, base: string): Promise<void> {
  await qaEnter(page, context, cfg, base);
  let list = ((await api(page, 'GET', '/agents')).json?.agents ?? []) as { id: string; name: string; vaultAddress: string }[];
  if (!list.length) {
    await api(page, 'POST', '/agents', { name: 'Momentum Base', mission: 'Suivre la tendance sur ETH et BTC, prudemment.', network: 'base', universe: ['ETH', 'BTC'], interval: '1h', capitalUsdc: '60' });
    await api(page, 'POST', '/agents', { name: 'Panier Arbitrum', mission: '', network: 'arbitrum', universe: ['ETH', 'ARB', 'LINK'], interval: '1h', capitalUsdc: '40' });
    list = ((await api(page, 'GET', '/agents')).json?.agents ?? []) as never;
    const a = list.find((x) => x.name === 'Momentum Base');
    if (a) {
      await fundOnFork(a.vaultAddress, 60_000000n, 10_000000000000000n).catch((e) => console.log(`fork funding failed: ${String(e).slice(0, 120)}`));
      // a strategy of the laboratory that fits, backtested then approved, and the agent started on paper (best effort: needs research/.venv and candles)
      try {
        const lib = ((await api(page, 'GET', '/strategies')).json?.strategies ?? []) as { path: string; generic: boolean; minSymbols: number; maxSymbols: number; meta: { interval: string; universe: string[] } }[];
        const fit = lib.find((x) => x.meta.interval === '1h' && (x.generic ? x.minSymbols <= 2 && x.maxSymbols >= 2 : [...x.meta.universe].sort().join() === 'BTC,ETH'));
        if (fit) {
          await api(page, 'POST', `/agents/${a.id}/strategies`, { path: fit.path.replace(/^strategies\//, '') });
          for (let k = 0; k < 40; k++) {
            const v = ((await api(page, 'GET', `/agents/${a.id}`)).json?.versions ?? [])[0] as { id: string; metrics: unknown; status: string } | undefined;
            if (v?.metrics) { await api(page, 'POST', `/agents/${a.id}/strategies/${v.id}/approve`); await api(page, 'POST', `/agents/${a.id}/mode`, { mode: 'PAPER' }); break; }
            if (v && !['backtesting', 'draft'].includes(v.status)) break;
            await page.waitForTimeout(3000);
          }
        }
      } catch (e) { console.log(`strategy seeding skipped: ${String(e).slice(0, 120)}`); }
    }
  }
  ids.funded = list.find((x) => x.name === 'Momentum Base')?.id; ids.fresh = list.find((x) => x.name === 'Panier Arbitrum')?.id;
}
/** a scenario on one of the seeded agents: its id is only known after the group's setup, so the page is opened by the act */
const onAgent = (k: 'funded' | 'fresh', then?: (p: Page) => Promise<void>) => ({ path: '/agents', wait: 400, act: async (p: Page) => { await p.goto(`/agents/${ids[k] ?? 'none'}`); await settle(p, 3200); await then?.(p); } });
const openFund = async (p: Page) => { await p.getByRole('button', { name: /Financer l’agent|Reprendre le financement/ }).first().click(); await p.locator('#qa-fund-cash').waitFor({ timeout: 30_000 }); await p.waitForTimeout(1500); };
const pickNetwork = async (p: Page, id: string, name: string) => { const sel = p.locator('main select').first(); if (await p.getByRole('radio', { name, exact: true }).count()) await p.getByRole('radio', { name, exact: true }).click(); else await sel.selectOption(id); };

const qa: Scenario[] = [
  { name: 'list', path: '/agents' },
  { name: 'create-spot', path: '/agents', full: true, act: async (p) => {
    await p.getByRole('button', { name: 'Nouvel agent' }).first().click();
    await p.getByPlaceholder('ETH Trend').fill('Tendance BNB');
    await p.locator('main textarea').first().fill('Suivre la tendance sur BTC et ETH, sans levier.');
    await p.getByRole('checkbox').first().waitFor({ timeout: 60_000 });
    await pickNetwork(p, 'bsc', 'BNB Smart Chain');
    await p.getByRole('checkbox', { name: /^BTC/ }).click(); await p.getByRole('checkbox', { name: /^ETH/ }).click();
  } },
  { name: 'agent-running', ...onAgent('funded'), full: true },
  { name: 'agent-new', ...onAgent('fresh'), full: true },
  { name: 'checklist', ...onAgent('fresh', async (p) => { await p.getByTestId('agent-checklist').scrollIntoViewIfNeeded(); }) },
  { name: 'fund-sheet', ...onAgent('funded', async (p) => { await openFund(p); await p.locator('#qa-fund-cash').fill('25'); }) },
  { name: 'fund-refusal', ...onAgent('funded', async (p) => { await openFund(p); await p.locator('#qa-fund-cash').fill('300'); }) },
  { name: 'fund-elsewhere', ...onAgent('fresh', openFund) },
  { name: 'golive-sheet', ...onAgent('funded', async (p) => {
    const b = p.getByRole('button', { name: /Passer en réel : préparer le mandat/ }).first();
    if (await b.count()) { await b.click(); await p.getByText('Mandat de trading').first().waitFor({ timeout: 30_000 }).catch(() => {}); await p.getByText('Mandat de trading').first().scrollIntoViewIfNeeded().catch(() => {}); }
  }) },
  { name: 'withdraw-sheet', ...onAgent('funded', async (p) => { await p.getByRole('button', { name: 'Retirer', exact: true }).first().click(); await p.getByRole('dialog').waitFor(); }) },
  // LAST of the stack's scenarios that signs something: a withdrawal signed on a server that does not broadcast (tracked state: not sent)
  { name: 'withdraw-tracked', ...onAgent('funded', async (p) => {
    await p.getByRole('button', { name: 'Retirer', exact: true }).first().click(); const d = p.getByRole('dialog'); await d.waitFor();
    await d.locator('li').filter({ hasText: 'USDC' }).getByRole('button', { name: 'Retirer' }).click();
    await d.locator('[data-testid=wd-state], [role=alert]').first().waitFor({ timeout: 40_000 }).catch(() => {});
  }) },
  { name: 'list-empty', path: '/agents', act: async (p) => { await p.route('**/api/v1/agents', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { agents: [] } }) : r.continue())); await p.reload(); await p.waitForTimeout(1500); } },
];

const perpAgent = (s: string) => `/agents/${PERP}?mock=1&perp=${s}`;
const golive = async (p: Page) => { await p.getByTestId('pl-golive').scrollIntoViewIfNeeded(); };
const hook = (p: Page, name: string, ...args: unknown[]) => p.evaluate(([n, a]) => (window as any).__spwMock.perp[n as string](...(a as unknown[])), [name, args] as const);
const mock: Scenario[] = [
  { name: 'perp-list', path: '/agents?mock=1&perp=live', wait: 2500 },
  { name: 'perp-create', path: '/agents?mock=1&perp=paper', full: true, wait: 2500, act: async (p) => {
    await p.getByRole('button', { name: 'Nouvel agent' }).first().click(); await p.getByRole('radio', { name: 'Perpétuels (simulation)' }).click();
    await p.getByPlaceholder('BTC–ETH pairs').fill('BTC momentum 2'); await p.getByRole('checkbox', { name: /^BTC/ }).first().click();
  } },
  { name: 'perp-sim', path: perpAgent('paper'), full: true, wait: 3000 },
  { name: 'perp-golive', path: perpAgent('ready'), wait: 3000, act: golive },
  { name: 'perp-golive-fund', path: perpAgent('small'), wait: 3000, act: golive },
  { name: 'perp-locked', path: perpAgent('mainnet_locked'), wait: 3000, act: golive },
  { name: 'perp-mandate-form', path: perpAgent('ready'), wait: 3000, act: async (p) => { await p.getByTestId('pl-next').click(); await p.getByTestId('mandate-sheet').waitFor(); } },
  { name: 'perp-mandate-review', path: perpAgent('ready'), wait: 3000, act: async (p) => { await p.getByTestId('pl-next').click(); await p.getByTestId('mandate-continue').click(); await p.getByTestId('mandate-warning').waitFor(); } },
  { name: 'perp-mandate-approve', path: perpAgent('ready'), wait: 3000, act: async (p) => { await p.getByTestId('pl-next').click(); await p.getByTestId('mandate-continue').click(); await p.getByTestId('ack-check').check(); await p.getByTestId('mandate-approve').scrollIntoViewIfNeeded(); } },
  { name: 'perp-live', path: perpAgent('live'), full: true, wait: 3000 },
  { name: 'perp-live-scrolled', path: perpAgent('live'), wait: 3000, act: async (p) => { await p.getByTestId('pl-mandate').scrollIntoViewIfNeeded(); } },
  { name: 'perp-stop-sheet', path: perpAgent('live'), wait: 3000, act: async (p) => { await p.getByTestId('pl-stop').click(); await p.getByTestId('pl-stop-sheet').waitFor(); } },
  { name: 'perp-stopping', path: perpAgent('live'), wait: 3000, act: async (p) => {
    await hook(p, 'holdStop', true); await p.getByTestId('pl-stop').click(); await p.getByTestId('pl-stop-confirm').click(); await p.getByTestId('pl-stop-done').waitFor();
    await p.getByTestId('pl-stop-sheet').getByRole('button', { name: 'Fermer' }).last().click(); await p.getByTestId('pl-stopping').waitFor(); await p.evaluate(() => scrollTo(0, 0));
  } },
];

const which = process.env.V10_GROUPS ?? 'qa,mock';
await runShots('agents', [
  ...(which.includes('qa') ? [{ base: QA, setup: seed, scenarios: qa }] : []),
  ...(which.includes('mock') ? [{ base: await startVite(VITE_PORT), scenarios: mock }] : []),
]);

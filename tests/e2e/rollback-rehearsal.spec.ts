// Rollback rehearsal (V11 final validation; docs/V11-DEPLOYMENT.md §9) — ONE driver for the four stages, run against a stack
// started by scripts/rollback-rehearsal-stack.sh on a signer directory and a database that survive from stage to stage:
//
//   RB_STAGE=seed-v10     V10 bundles, fresh:   owner setup, a paper derivative account with a filled and a resting order,
//                                               an address-book entry, a spot agent (vault from the signer), a transfer draft
//   RB_STAGE=write-v11    V11 bundles, same DB: the V10 rows are read back; V11 writes unified orders, risk decisions, live
//                                               limits; the kill switch is engaged, and released with the passkey
//   RB_STAGE=check-v10    V10 bundles again:    health, portfolio, agents, a paper order, a close, a transfer draft
//   RB_STAGE=resume-v11   V11 bundles again:    the projection catches up, nothing is duplicated
//
// The file uses only what BOTH versions have: tests/e2e/qa-helpers.ts and owner routes called with the browser's session. It
// is copied as it is into a checkout of a118e3e for the two V10 stages. Paper only, broadcast off, throwaway keystore; the
// only network reads are the public market data the paper engine fills against. Skipped unless RB_STAGE is set.
// What each stage observed is appended to $RB_OUT (JSON lines) — the evidence quoted in docs/v11/work/final-validation.md.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

const STAGE = process.env.RB_STAGE ?? '', BASE = process.env.RB_BASE ?? 'http://localhost:8770', DIR = process.env.RB_DIR ?? '/tmp/spw-rollback';
const OUT = process.env.RB_OUT ?? `${DIR}/observed.jsonl`, BTC = 'hyperliquid:BTC';
test.skip(!STAGE, 'rollback rehearsal: set RB_STAGE (see the header)');
test.use({ baseURL: BASE });

const note = (what: string, data: unknown): void => { appendFileSync(OUT, `${JSON.stringify({ stage: STAGE, at: new Date().toISOString(), what, data })}\n`); };
const headers = () => ({ origin: BASE, 'x-spw-csrf': '1', 'idempotency-key': `rollback-${randomUUID()}` });
async function call(page: Page, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; json: any }> {
  const r = method === 'GET' ? await page.request.get(`/api/v1${path}`) : await page.request.post(`/api/v1${path}`, { headers: headers(), data: data ?? {} });
  return { status: r.status(), json: await r.json().catch(() => null) };
}
const brief = (x: any): unknown => (x && typeof x === 'object' ? JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…` : v))) : x);
/** the routes both versions have, read after every start: status and a figure that shows the rows are still there */
async function common(page: Page): Promise<Record<string, unknown>> {
  const o: Record<string, unknown> = {};
  for (const p of ['/health/live', '/health/ready', '/portfolio', '/activity', '/agents', '/derivatives/accounts', '/addressbook', '/security/overview', '/settings']) {
    const r = await call(page, 'GET', p);
    o[p] = { status: r.status, size: Array.isArray(r.json) ? r.json.length : r.json?.accounts?.length ?? r.json?.agents?.length ?? r.json?.items?.length ?? (r.json && typeof r.json === 'object' ? Object.keys(r.json).length : null),
      ...(r.status >= 400 ? { body: brief(r.json) } : {}) };
  }
  return o;
}
async function paperTrade(page: Page, acct: string, label: string): Promise<void> {
  const buy = await call(page, 'POST', `/derivatives/accounts/${acct}/orders`, { instrument: BTC, side: 'buy', type: 'market', size: '0.001', slippageBps: 100 });
  note(`${label}: paper market buy 0.001 BTC`, { status: buy.status, body: brief(buy.json?.order ?? buy.json) });
  const a = await call(page, 'GET', `/derivatives/accounts/${acct}`);
  note(`${label}: account after the buy`, { status: a.status, positions: (a.json?.positions ?? []).map((p: any) => ({ instrument: p.instrument, size: p.size })), openOrders: (a.json?.openOrders ?? a.json?.orders ?? []).length });
  const draft = await call(page, 'POST', '/transfers/proposals', { network: 'base', asset: 'native', to: '0x000000000000000000000000000000000000dEaD', amount: '0.0001', note: 'rollback rehearsal' });
  note(`${label}: transfer draft (the throwaway wallet holds nothing: a refusal for insufficient funds IS the route working)`, { status: draft.status, body: brief(draft.json) });
}

test(`rollback rehearsal — ${STAGE}`, async ({ page, context }) => {
  test.setTimeout(240_000);
  const pk = await virtualPasskey(context, page, passkeyFile(new URL(BASE).port));
  const how = await enter(page, pk, readFileSync(`${DIR}/setup-token`, 'utf8').trim());
  note('entered the wallet', how);
  note('routes common to both versions', await common(page));

  if (STAGE === 'seed-v10') {
    expect(how).toBe('setup');
    const created = await call(page, 'POST', '/derivatives/accounts', { venue: 'hyperliquid', label: 'Rollback rehearsal', collateral: '10000' });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const acct = created.json.id as string;
    await paperTrade(page, acct, 'V10');
    const rest = await call(page, 'POST', `/derivatives/accounts/${acct}/orders`, { instrument: BTC, side: 'buy', type: 'limit', size: '0.001', price: '20000', tif: 'gtc' });
    note('V10: resting paper limit order far from the market', { status: rest.status, body: brief(rest.json?.order ?? rest.json) });
    const ab = await call(page, 'POST', '/addressbook', { network: 'base', address: '0x000000000000000000000000000000000000dEaD', label: 'Rehearsal' });
    note('V10: address-book entry', { status: ab.status });
    const agent = await call(page, 'POST', '/agents', { name: 'Rehearsal spot', mission: 'rollback rehearsal', network: 'base', universe: ['ETH'], capitalUsdc: '100' });
    note('V10: spot agent (vault address derived by the signer)', { status: agent.status, id: agent.json?.id, state: agent.json?.state, vault: agent.json?.vault?.address ?? agent.json?.vaultAddress ?? null, body: agent.status >= 400 ? brief(agent.json) : undefined });
    const perp = await call(page, 'POST', '/agents', { kind: 'perp', name: 'Rehearsal perp', mission: 'rollback rehearsal', venue: 'hyperliquid', instruments: ['BTC', 'ETH'], interval: '1h', capitalUsdc: '10000' });
    note('V10: perp agent (its own paper account)', { status: perp.status, id: perp.json?.id, state: perp.json?.state, body: perp.status >= 400 ? brief(perp.json) : undefined });
  }

  if (STAGE === 'write-v11' || STAGE === 'resume-v11') {
    expect(how).toBe('unlock');
    const accounts = (await call(page, 'GET', '/derivatives/accounts')).json.accounts as { id: string; label: string }[];
    const acct = accounts.find((a) => a.label === 'Rollback rehearsal')!.id;
    const orders = await call(page, 'GET', '/trading/orders?limit=100');
    note('V11: unified orders visible at entry (the projection of the rows written before this start)', { status: orders.status, count: orders.json?.data?.orders?.length ?? orders.json?.orders?.length ?? null,
      states: (orders.json?.data?.orders ?? orders.json?.orders ?? []).map((o: any) => `${o.status ?? o.state}:${o.origin ?? ''}`) });
    const state0 = await call(page, 'GET', '/risk/state');
    note('V11: risk state at entry', { status: state0.status, killSwitch: state0.json?.switches?.killSwitch?.on, readOnly: state0.json?.switches?.readOnly?.on, locks: (state0.json?.locks ?? []).map((l: any) => `${l.id}=${l.on}`) });
    // a unified order through the trading API (owner session), then the same through the venue route the terminal uses
    const viaApi = await call(page, 'POST', '/trading/orders', { mode: 'paper', accountId: acct, instrument: BTC, side: 'buy', type: 'market', size: '0.001', slippageBps: 100, clientOrderId: `rb-${randomUUID().slice(0, 18)}` });
    note('V11: paper order through POST /trading/orders', { status: viaApi.status, body: brief(viaApi.json?.data ?? viaApi.json) });
    await paperTrade(page, acct, 'V11');
    if (STAGE === 'write-v11') {
      const on = await call(page, 'POST', '/risk/kill-switch', { reason: 'rollback rehearsal' });
      note('V11: kill switch engaged', { status: on.status, on: on.json?.killSwitch?.on ?? on.json?.switches?.killSwitch?.on ?? brief(on.json) });
      const denied = await call(page, 'POST', `/derivatives/accounts/${acct}/orders`, { instrument: BTC, side: 'buy', type: 'market', size: '0.001', slippageBps: 100 });
      note('V11: paper buy under the kill switch', { status: denied.status, code: denied.json?.error?.code ?? denied.json?.code ?? brief(denied.json) });
      if (process.env.RB_KEEP_KILL !== '1') {
        // release in the page: prepare → passkey → release (the Risk screen's own button)
        await page.goto('/risk');
        await page.getByTestId('rk-kill-release').click();
        await expect.poll(async () => (await call(page, 'GET', '/risk/state')).json?.switches?.killSwitch?.on, { timeout: 30_000 }).toBe(false);
        await pk.save();
        note('V11: kill switch released with the passkey', { on: false });
      } else note('V11: kill switch LEFT ENGAGED for the next stage (RB_KEEP_KILL=1)', { on: true });
    }
    const dec = await call(page, 'GET', '/risk/decisions?limit=5');
    note('V11: last risk decisions', { status: dec.status, last: (dec.json?.decisions ?? []).map((d: any) => `${d.decision}${d.preview ? ' (preview)' : ''} ${d.failed?.join('+') ?? ''}`) });
  }

  if (STAGE === 'check-v10') {
    expect(how).toBe('unlock');
    const accounts = (await call(page, 'GET', '/derivatives/accounts')).json.accounts as { id: string; label: string }[];
    const acct = accounts.find((a) => a.label === 'Rollback rehearsal')!.id;
    await paperTrade(page, acct, 'V10 after V11');
    const close = await call(page, 'POST', `/derivatives/accounts/${acct}/close`, { instrument: BTC });
    note('V10 after V11: close of the BTC paper position', { status: close.status, body: brief(close.json?.order ?? close.json) });
    const agents = await call(page, 'GET', '/agents');
    note('V10 after V11: agents', { status: agents.status, agents: (agents.json?.agents ?? []).map((a: any) => `${a.name}:${a.state}`) });
    const detail = [];
    for (const a of agents.json?.agents ?? []) { const d = await call(page, 'GET', `/agents/${a.id}`); detail.push({ name: a.name, status: d.status, body: d.status >= 400 ? brief(d.json) : undefined }); }
    note('V10 after V11: agent detail routes', detail);
    const sec = await call(page, 'GET', '/security/overview');
    note('V10 after V11: signer seen by the API', { status: sec.status, reachable: sec.json?.signer?.reachable ?? sec.json?.signerReachable ?? null, keyId: sec.json?.signer?.keyId ?? sec.json?.keyId ?? null, halted: sec.json?.signer?.halted ?? sec.json?.halted ?? null });
  }
  await pk.save();
});

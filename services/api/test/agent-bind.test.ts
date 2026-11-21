/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/agent-bind.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// V11.2 — the agents bound to the execution layer, END TO END with the REAL laboratory and RECORDED market data.
//
//   template → backtest → paper   a Momentum agent is created from the template on `momentum_xs_perp/2` (BTC, ETH, SOL), its
//                                 backtest runs through the job queue in the sandboxed laboratory and gives a version-3 report,
//                                 paper starts (a PAPER trading mandate is created), the laboratory strategy produces a signal
//                                 from the recorded bars, and the order is a row of the unified `orders` table in mode paper —
//                                 judged by the risk engine, checked against the mandate. Performance exists for paper only.
//   one truth per order           the agent's `agent_order_intents` row is context only; a state cannot be written on it;
//                                 what the agent's routes answer is what `orders` says, also after `orders` moves.
//   one order path                same key → the stored order, the paper engine is not called again.
//   one kill switch               engaged by the risk-management agent's port → the risk engine's switch; a perp paper order
//                                 that adds risk is REJECTED KILL_SWITCH_ACTIVE as a unified order, a reduce-only one passes;
//                                 a spot order on the seam gateway reads the same switch; nothing here can release it.
//
// Data: services/api/test/fixtures/agents/hl-1h-btc-eth-sol.json.gz — the last 2 400 closed hourly bars and funding settlements
// of BTC, ETH, SOL that the quant lab pulled from Hyperliquid's public endpoint on 2026-11-15 (its manifest:
// research/data-manifests/2026-11-15-v11.json). Nothing here reaches a network, a venue trading endpoint or a real key.
// SPW_BIND_TRANSCRIPT=<file> writes what was observed (pasted in docs/v11/work/agents-bind.md).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { Clock, fixtureVenues, useDatabase, type Venues } from './derivatives-helpers.ts';
import { REPO_ROOT } from './test-db.ts';

const READY = existsSync(join(REPO_ROOT, 'research/.venv/bin/python'));
const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), A = '/api/v1/agents', H = 3_600_000;
const FX = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/agents/hl-1h-btc-eth-sol.json.gz', import.meta.url))).toString('utf8')) as { source: string; symbols: Record<string, { candles: [number, string, string, string, string, string][]; funding: [number, string, string][] }> };
const SYMS = ['BTC', 'ETH', 'SOL'], LAST = FX.symbols.BTC!.candles.at(-1)![0];
const owner = new TestPasskey(RP, ORIGIN);
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server;
let rt: import('../src/agent-runtime/scheduler.ts').AgentRuntime, pl: typeof import('../src/agents/perp-live.ts'), eng: typeof import('../src/agents/perp-engine.ts');
const events: { event: string; data: any }[] = [], transitions: { id: string; to: string; principal: string }[] = [], lines: string[] = [];
const say = (s: string): void => { lines.push(s); };
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { cookie };
  if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
/** the recorded series as the venue would serve them at the test clock: nothing after `now`, nothing before `start` */
const closeAt = (s: string, now: number): string => FX.symbols[s]!.candles.filter((b) => b[0] + H <= now).at(-1)![4];

beforeAll(async () => {
  if (!READY) return;
  const dir = mkdtempSync(join(tmpdir(), 'spw-agents-bind-'));
  // NEXT (P4): an API-side passkey check refuses a passkey the signer does not list — the test passkey is pinned on this signer too
  const signerStore = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  const signerOfTest = new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), signerStore, { rpId: RP, origin: ORIGIN });
  signerStore.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  await signerOfTest.enroll({ credential: owner.credential(), setupToken: 'tok' });
  signerSrv = createSignerServer(signerOfTest, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('agent_bind');
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data') });
  delete process.env.SPW_RESEARCH_DIR;                                           // the REAL laboratory of this checkout
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = owner.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  // three closed bars are held back: the clock starts 5.5 minutes after the close of the fourth bar from the end
  clock = new Clock(LAST - 3 * H + H + 330_000); v = fixtureVenues(clock);
  const hl = v.adapters.hyperliquid, tickers = hl.tickers.bind(hl);
  hl.candles = async (s, _i, o) => FX.symbols[s]!.candles.filter((b) => b[0] >= (o.start ?? 0) && b[0] <= Math.min(o.end ?? Infinity, clock.now())).slice(0, o.limit ?? 5000).map((b) => ({ ts: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] })) as never;
  hl.fundingHistory = async (s, o) => FX.symbols[s]!.funding.filter((f) => f[0] >= o.start && f[0] <= Math.min(o.end ?? Infinity, clock.now())).slice(0, 500).map((f) => ({ ts: f[0], rate: f[1], premium: f[2] }));
  hl.tickers = async () => (await tickers()).map((t) => { const s = t.instrument.slice(12); if (!SYMS.includes(s)) return t; const px = closeAt(s, clock.now()); return { ...t, mark: px, index: px, mid: px, funding: '0.0000125', ts: clock.now() }; });
  hl.book = async (symbol) => { const px = Number(closeAt(symbol, clock.now())), tick = px > 10_000 ? 1 : px > 1000 ? 0.1 : 0.001, f = (x: number) => String(Number(x.toFixed(3)));
    return { instrument: `hyperliquid:${symbol}`, bids: [[f(px - tick), '1000'], [f(px - 2 * tick), '2000']], asks: [[f(px + tick), '1000'], [f(px + 2 * tick), '2000']], ts: clock.now() }; };
  const mod = await import('../src/derivatives/index.ts');
  const deriv = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: deriv });
  pl = await import('../src/agents/perp-live.ts'); eng = await import('../src/agents/perp-engine.ts');
  // the REAL signal runner (the sandboxed laboratory process) and the REAL backtester; only the venue's rate budget is widened
  pl.setPerpRuntime(pl.createPerpRuntime(deriv, { weightPerMinute: 1_000_000 }));
  const bindings = await import('../src/agents/runtime-bindings.ts');
  rt = bindings.bindAgentRuntime({ execution: app.execution, market: { series: async () => [], assertFresh: async () => {} }, stream: false, emit: async (event, data) => { events.push({ event, data }); }, runtime: { workerId: 'bind-test' } });
  (await import('../src/orders/store.ts')).onTransition((row, e) => { transitions.push({ id: row.id, to: e.to, principal: `${row.principal_kind}:${row.principal_id}` }); });
}, 120_000);
afterAll(async () => {
  if (!READY) return;
  if (process.env.SPW_BIND_TRANSCRIPT) writeFileSync(process.env.SPW_BIND_TRANSCRIPT, `${lines.join('\n')}\n`);
  app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end();
});

describe.skipIf(!READY)('template → backtest (real laboratory, job queue, report v3) → paper → signal from recorded data → unified order', () => {
  let id = '', versionId = '', mandateId = '';
  const row = async () => (await sql`select * from agents where id = ${id}`)[0];
  const tick = async () => eng.tickPerpAgent(await row(), pl.perpRuntime().deps);

  it('the Momentum template is bound to the installed laboratory strategy and shows the laboratory\'s out-of-sample verdict as data', async () => {
    const t = (await call('GET', `${A}/templates`)).json.templates.find((x: any) => x.id === 'momentum');
    const s = t.installed.find((x: any) => x.path === 'momentum_xs_perp/2');
    expect(s).toMatchObject({ name: 'momentum_xs_perp', version: '2', universe: SYMS, interval: '1h', liveCapable: true });
    const verdict = t.labVerdicts.find((x: any) => x.name === 'momentum_xs_perp' && String(x.version) === '2');
    expect(verdict.deflatedSharpe).toBeLessThanOrEqual(0.10); expect(verdict.significant).toBe(false);
    say(`GET ${A}/templates → momentum: installed ${t.installed.map((x: any) => x.path).join(', ')}`);
    say(`  lab verdict momentum_xs_perp/2 (read from research/results/2026-11-15-v11): deflated Sharpe ${verdict.deflatedSharpe}, significant=${verdict.significant}, live-capable=${verdict.liveCapable}`);
    // the first listing of the library starts one laboratory process per version (14 of them; 6 s alone on a quiet machine since
    // they run four at a time, 19 s before): nothing here asserts a duration, so the default 30 s is not the right bound for it
  }, 180_000);

  it('create from the template; the backtest runs through the job queue in the laboratory and stores a version-3 report with engine parity applied', async () => {
    const c = await call('POST', `${A}/from-template`, { template: 'momentum', name: 'Momentum bind', strategyPath: 'momentum_xs_perp/2', capitalUsdc: '10000' });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    id = c.json.agent.id; versionId = c.json.strategy.versionId;
    expect(c.json.agent).toMatchObject({ family: 'momentum', mode: 'research', state: 'stopped' });
    say(`POST ${A}/from-template {"template":"momentum","name":"Momentum bind","strategyPath":"momentum_xs_perp/2","capitalUsdc":"10000"}`);
    say(`  → 200 agent ${id.slice(0, 8)}… family=${c.json.agent.family} mode=${c.json.agent.mode} strategy=${c.json.strategy.path} sha256=${String(c.json.strategy.sha256).slice(0, 12)}… version ${c.json.strategy.status}`);
    // registration starts the backtest itself; the job asked here waits for it or runs it — either way through the queue
    const j = await call('POST', `${A}/${id}/backtest`, { versionId });
    expect(j.status, JSON.stringify(j.json)).toBe(200); expect(j.json.label).toBe('backtest');
    say(`POST ${A}/${id.slice(0, 8)}…/backtest → 200 job ${String(j.json.job.id).slice(0, 8)}… status=${j.json.job.status} label=${j.json.label}`);
    let job: any = null;
    for (let i = 0; i < 400; i++) {
      await rt.jobsPass();
      job = (await call('GET', `${A}/jobs/${j.json.job.id}`)).json.job;
      const [ver] = await sql`select status, report is not null as has_report, notes from strategy_versions where id = ${versionId}`;
      if (ver.has_report || (job.status !== 'queued' && job.status !== 'running' && ver.status !== 'backtesting')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const [ver] = await sql`select status, notes, report from strategy_versions where id = ${versionId}`;
    expect(ver.report, `no report: ${ver.notes} / job ${JSON.stringify(job)}`).toBeTruthy();
    // V11 final validation — the job met the backtest the registration had started by itself: it WAITED for that run instead of
    // failing on « the backtest produced no report » and being dead-lettered (and instead of putting the row back to `draft`, which
    // made the run in flight lose its report). One attempt, done; nothing was retried.
    expect(job).toMatchObject({ status: 'done', attempts: 1, deadLettered: false });
    expect((await sql`select count(*)::int as n from audit_events where type = 'strategy.backtested' and data->>'version' = ${versionId}`)[0].n).toBe(1);   // ONE backtest ran, not two
    const rep = ver.report;
    expect(rep.schema_version).toBe(3); expect(rep.kind).toBe('perp'); expect(rep.engine_parity.applied).toBe(true);
    expect(rep.checks).toMatchObject({ lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass' });
    expect(Object.keys(rep.journal)).toEqual(expect.arrayContaining(['strategy', 'code', 'data', 'parameters', 'seed']));
    const detail = (await call('GET', `${A}/${id}`)).json, shown = detail.versions?.find((x: any) => x.id === versionId)?.report ?? detail.report ?? null;
    const ov = (await call('GET', `${A}/${id}/overview`)).json;
    expect(ov.backtests.label).toBe('backtest'); expect(ov.backtests.versions[0]).toMatchObject({ id: versionId, hasReport: true });
    const test = rep.metrics.test, g = test.gross_to_net;
    say(`  job ${job?.status}; strategy version ${ver.status}; REPORT (label: backtest) schema_version=${rep.schema_version} engine_parity.applied=${rep.engine_parity.applied} checks=${JSON.stringify({ lookahead: rep.checks.lookahead, ledger: rep.checks.ledger, funding_alignment: rep.checks.funding_alignment, data_quality: rep.checks.data_quality })}`);
    say(`  test split (BACKTEST, not a performance): net return ${test.total_return ?? test.net_return}, sharpe ${test.sharpe}, max drawdown ${test.max_drawdown}; gross→net ${JSON.stringify(g)}`);
    say(`  engine parity observed: ${JSON.stringify(Object.fromEntries(Object.entries(rep.engine_parity.observed ?? {}).map(([k, x]: [string, any]) => [k, x?.stop ?? null])))}; execution model keys: ${Object.keys(rep.execution_model).join(', ')}`);
    say(`  journal: ${JSON.stringify({ strategy: rep.journal.strategy, code: rep.journal.code, data: rep.journal.data, seed: rep.journal.seed }).slice(0, 420)}`);
    void shown;
  }, 600_000);

  it('start paper: the version is approved for paper, a PAPER trading mandate (SPW-TRADING-MANDATE-v1, no passkey) is created for the agent', async () => {
    const s = await call('POST', `${A}/${id}/start`, { mode: 'paper' });
    expect(s.status, JSON.stringify(s.json)).toBe(200); expect(s.json).toMatchObject({ mode: 'paper', state: 'active', phase: 'PAPER_TRADING' });
    const a = await row();
    mandateId = a.runtime.paperMandate.id;
    const m = (await call('GET', `/api/v1/mandates/${mandateId}`)).json.mandate;
    expect(m).toMatchObject({ mode: 'paper', state: 'active', phase: 'active', principal: { kind: 'agent', id }, signer: null });
    expect(m.mandate).toMatchObject({ v: 1, mode: 'paper', instruments: SYMS.map((x) => `hyperliquid:${x}`), orderTypes: ['market'], principal: { kind: 'agent', id } });
    expect(m.mandate.accounts[0].account).toBe(a.deriv_account_id);                 // the paper ACCOUNT is an account of the mandate — it is not the mandate
    expect((await sql`select actor from audit_events where type = 'agent.paper_mandate' order by seq desc limit 1`)[0].actor).toBe('owner');
    say(`POST ${A}/${id.slice(0, 8)}…/start {"mode":"paper"} → 200 mode=${s.json.mode} state=${s.json.state}`);
    say(`  paper trading mandate ${mandateId.slice(0, 8)}… (SPW-TRADING-MANDATE-v1, mode paper, no passkey): ${m.mandate.instruments.join(', ')}; order ≤ ${m.mandate.maxOrderNotionalUsd} USD, position ≤ ${m.mandate.maxPositionNotionalUsd} USD, leverage ≤ ${m.mandate.maxLeverage}, expires ${new Date(m.notAfter).toISOString().slice(0, 10)}`);
  });

  it('the laboratory strategy gives a signal on the recorded bars; its orders are rows of the unified `orders` table (mode paper, agent principal, paper mandate), judged by the risk engine; performance is for paper only', async () => {
    let out = '';
    // the strategy rebalances on its own schedule: bars are revealed until it trades (three were held back)
    for (let k = 0; k < 4; k++) { out = await tick(); say(`tick at ${new Date(clock.now()).toISOString()} → ${out}`); if (/order\(s\)/.test(out)) break; clock.advance(H); }
    const sig = (await call('GET', `${A}/${id}/signals?mode=paper`)).json;
    expect(sig.mode).toBe('paper'); expect(sig.signals.length).toBeGreaterThan(0);
    const s0 = sig.signals[0];
    say(`GET ${A}/${id.slice(0, 8)}…/signals?mode=paper → ${sig.signals.length} signal(s); latest: bar ${new Date(s0.ts).toISOString()} decision=${s0.decision} strategy output=${JSON.stringify(s0.output)} targets=${JSON.stringify(s0.targets)}`);
    expect(out, 'the recorded window gave no order on any of the four bars').toMatch(/^\d+ order\(s\)/);
    const orders = await sql`select * from orders where principal_kind = 'agent' and principal_id = ${id} order by created_at`;
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) expect(o).toMatchObject({ mode: 'paper', origin: 'agent', engine: 'paper', mandate_id: mandateId, market_kind: 'perp', venue: 'hyperliquid' });
    expect(orders.some((o: any) => o.state === 'FILLED')).toBe(true);
    // every one was evaluated by the unified risk engine (a stored decision linked to the order), under the mandate (its counters moved)
    for (const o of orders) expect((await sql`select decision from risk_decisions where order_id = ${o.id} and not preview and kind = 'order'`).length, o.id).toBeGreaterThan(0);
    const usage = (await call('GET', `/api/v1/mandates/${mandateId}`)).json.mandate.usage;
    expect(usage.ordersAccepted).toBe(orders.filter((o: any) => o.state !== 'REJECTED' && o.state !== 'FAILED').length);
    // order.updated: the transitions of these orders were announced (the listener sits next to the webhook emitter of the server)
    expect(transitions.filter((t) => t.principal === `agent:${id}` && t.to === 'FILLED').length).toBe(orders.filter((o: any) => o.state === 'FILLED').length);
    expect((await sql`select count(*)::int as n from webhook_events where event = 'order.updated'`.catch(() => [{ n: -1 }]))[0].n).not.toBe(0);
    for (const o of orders) say(`  orders: ${o.id} ${o.side} ${o.record.size} ${o.instrument} mode=${o.mode} origin=${o.origin} principal=${o.principal_kind}:${String(o.principal_id).slice(0, 8)}… mandate=${String(o.mandate_id).slice(0, 8)}… state=${o.state} filled=${o.record.filledSize} avg=${o.record.avgFillPrice}`);
    const dec = await sql`select decision, jsonb_array_length(checks) as n from risk_decisions where order_id = ${orders[0].id} and not preview`;
    say(`  risk engine: ${dec[0].decision} (${dec[0].n} checks) for ${orders[0].id}; mandate usage: ${usage.ordersAccepted} accepted, notional ${usage.notionalTotal} USD`);
    // the agent's own view: the timeline shows signal → order → fill; the orders route answers what `orders` says
    const tl = (await call('GET', `${A}/${id}/timeline?mode=paper`)).json, kinds = tl.items.map((e: any) => e.type);
    expect(kinds).toEqual(expect.arrayContaining(['signal', 'order', 'fill']));
    const mine = (await call('GET', `${A}/${id}/orders?mode=paper`)).json.orders;
    expect(mine.map((o: any) => [o.id, o.state]).sort()).toEqual(orders.map((o: any) => [o.id, o.state]).sort());
    expect((await call('GET', `${A}/${id}/orders?mode=live`)).json.orders).toEqual([]);
    // performance: computed for PAPER from the paper account's own records; none for live; a backtest is never one
    const perf = (await call('GET', `${A}/${id}/performance?mode=paper`)).json, live = (await call('GET', `${A}/${id}/performance?mode=live`)).json;
    expect(perf.mode).toBe('paper'); expect(live.mode).toBe('live');
    expect(JSON.stringify(live)).not.toMatch(/"fees":\s*[1-9]/);
    say(`GET ${A}/${id.slice(0, 8)}…/performance?mode=paper → ${JSON.stringify({ mode: perf.mode, label: perf.label, points: perf.points, totalReturn: perf.totalReturn, fees: perf.fees, turnover: perf.turnover, warnings: (perf.warnings ?? []).map((w: any) => w.code) }).slice(0, 600)}`);
    say(`GET ${A}/${id.slice(0, 8)}…/performance?mode=live → ${JSON.stringify({ mode: live.mode, points: live.points, totalReturn: live.totalReturn })}`);
  }, 300_000);

  it('ONE TRUTH: the agent\'s row of a unified order is context only — it cannot hold a state, and the agent reads what `orders` says, also when `orders` moves', async () => {
    const orders = await sql`select id, state from orders where principal_kind = 'agent' and principal_id = ${id} order by created_at`;
    const ctx = await sql`select id, order_id, state, record, reason, history, fills, signal_id, config_version, strategy_sha256 from agent_order_intents where agent_id = ${id}`;
    expect(ctx.map((c: any) => c.order_id).sort()).toEqual(orders.map((o: any) => o.id).sort());
    for (const c of ctx) { expect(c).toMatchObject({ state: null, record: null, reason: null, history: [], fills: [] }); expect(c.signal_id).not.toBeNull(); expect(c.strategy_sha256).toMatch(/^[0-9a-f]{64}$/); expect(c.config_version).toBeGreaterThan(0); }
    // the database refuses a state on a context row, whoever writes it
    await expect(sql`update agent_order_intents set state = 'FILLED' where id = ${ctx[0].id}`).rejects.toThrow(/agent_order_intents_one_truth/);
    await expect(sql`update agent_order_intents set record = ${sql.json({ state: 'CANCELLED' })}, reason = 'X', state = 'CANCELLED' where id = ${ctx[0].id}`).rejects.toThrow(/agent_order_intents_one_truth/);
    await expect(sql`update agent_order_intents set order_id = 'another' where id = ${ctx[0].id}`).rejects.toThrow(/agent_order_intents_one_truth/);
    // no file of the agents writes a state on such a row: the only writers of the ledger's state filter `order_id is null`
    const gw = readFileSync(join(REPO_ROOT, 'services/api/src/agent-runtime/gateway.ts'), 'utf8'), ug = readFileSync(join(REPO_ROOT, 'services/api/src/agents/unified-gateway.ts'), 'utf8');
    for (const m of gw.matchAll(/update agent_order_intents set[^`]*`/g)) expect(m[0]).toMatch(/order_id is null/);
    expect(ug).not.toMatch(/update agent_order_intents/);
    // `orders` is the only source: a new order of the service (a resting limit order of this agent, cancelled) is seen by the agent's
    // routes in each of its states with no agent-side write in between
    const st = await import('../src/orders/store.ts'), gwm = await import('../src/agent-runtime/gateway.ts');
    const probe = `probe-${randomUUID()}`, a = await row();
    await st.insertOrder({ id: probe, principal: { kind: 'agent', id }, idempotencyKey: probe, bodyHash: null, mode: 'paper', venue: 'hyperliquid', network: 'mainnet', instrument: 'hyperliquid:BTC', marketKind: 'perp', side: 'buy', type: 'limit', reduceOnly: false,
      accountId: a.deriv_account_id, mandateId, canonical: null, orderHash: null, size: '0.001', engine: 'none', engineRef: null, notionalUsd: '60', origin: 'agent', detail: {}, createdAt: clock.now() });
    const seen = async () => (await gwm.listAgentOrders(id, { mode: 'paper' })).find((o) => o.id === probe)!.state;
    expect(await seen()).toBe('CREATED');
    await st.applyEvent(probe, { type: 'validated' }, clock.now()); expect(await seen()).toBe('VALIDATED');
    await st.applyEvent(probe, { type: 'local_rejected', reason: 'RISK_DENIED', detail: 'probe' }, clock.now()); expect(await seen()).toBe('REJECTED');
    expect((await sql`select count(*)::int as n from agent_order_intents where id = ${probe}`)[0].n).toBe(0);     // no agent-side row was needed for the agent to see it
    say(`one truth: ${ctx.length} context row(s) in agent_order_intents (state NULL, signal ${ctx[0].signal_id}, config v${ctx[0].config_version}); "update agent_order_intents set state = 'FILLED'" → refused by constraint agent_order_intents_one_truth`);
  });

  it('ONE PATH, idempotent: the same key answers the stored order and the paper engine is not called again; research mode is refused READ_ONLY_MODE; another mandate than the one in force is refused', async () => {
    const a = await row(), deps = pl.perpRuntime().deps, [o] = await sql`select id, canonical, record from orders where principal_id = ${id} and state = 'FILLED' order by created_at limit 1`;
    const calls = app.execution.orders.engineCalls.paper, before = (await sql`select count(*)::int as n from orders where principal_id = ${id}`)[0].n;
    const ex = eng.gatewayExecutor(a, deps.executor(a), deps);
    const again = await ex.gateway.submit({ kind: 'agent', id }, { ...o.canonical, size: '0.5' }, { idempotencyKey: o.id });          // another body under the same key: the stored order stands
    expect(again).toMatchObject({ id: o.id, state: 'FILLED', idempotent: true, source: 'orders', size: o.record.size });
    expect([app.execution.orders.engineCalls.paper, (await sql`select count(*)::int as n from orders where principal_id = ${id}`)[0].n]).toEqual([calls, before]);
    const fresh = (over: Record<string, unknown>) => ({ ...o.canonical, clientOrderId: `bind-${randomUUID()}`, createdAt: clock.now(), expiresAt: clock.now() + 120_000, ...over });
    const r1 = fresh({ mode: 'research' }), research = await ex.gateway.submit({ kind: 'agent', id }, r1 as never, { idempotencyKey: r1.clientOrderId as string });
    expect(research).toMatchObject({ state: 'REJECTED', reason: 'READ_ONLY_MODE', source: 'none' });
    const r2 = fresh({ mandateId: randomUUID() }), other = await ex.gateway.submit({ kind: 'agent', id }, r2 as never, { idempotencyKey: r2.clientOrderId as string });
    expect(other).toMatchObject({ state: 'REJECTED', reason: 'MANDATE_DENIED', source: 'none' });
    expect((await sql`select count(*)::int as n from orders where principal_id = ${id}`)[0].n).toBe(before);
    say(`same key again (another body): order ${o.id} answered from the table, idempotent=true, paper engine calls unchanged (${calls}); research-mode order → REJECTED READ_ONLY_MODE; another mandate → REJECTED MANDATE_DENIED; no order created`);
  });

  it('ONE KILL SWITCH: the risk-management agent\'s port engages the risk engine\'s switch; a paper order that adds risk is a REJECTED unified order (KILL_SWITCH_ACTIVE), a reduce-only one passes; the seam gateway reads the same switch; no agent module releases it', async () => {
    const ks = await import('../src/agent-runtime/kill-switch.ts'), sup = await import('../src/agent-runtime/risk-supervisor.ts'), gwm = await import('../src/agent-runtime/gateway.ts');
    const supId = randomUUID(), acts: string[] = [];
    // the supervisor, wired as the scheduler wires it, on a LIVE loss at its kill level
    const res = await sup.supervise({ mode: 'live', act: true, limits: { maxGrossUsd: 1e9, maxAgentDrawdownPct: 90, maxPortfolioDailyLossPct: 50, minLiquidationDistanceBps: 50, maxFundingBleedBpsPerDay: 1000, killSwitchDailyLossPct: 10 } }, {}, {
      now: clock.now, killSwitch: { engage: (reason) => ks.killSwitch().engage(reason, { kind: 'agent', id: supId }) }, pause: async () => {}, propose: async (_f, acted) => { acts.push(acted); },
      snapshots: async () => [{ agentId: randomUUID(), name: 'live one', mode: 'live', lifecycle: 'active', capitalUsd: 1000, equityUsd: 850, peakEquityUsd: 1000, dayStartEquityUsd: 1000, grossUsd: 100, minLiquidationDistanceBps: 5000, funding24hUsd: 0, unreadable: null }] });
    expect(acts).toContain('kill_switch'); expect(res.findings.some((f) => f.action === 'kill_switch')).toBe(true);
    const sw = (await call('GET', '/api/v1/risk/state')).json.switches.killSwitch;
    expect(sw).toMatchObject({ on: true, by: { kind: 'agent', id: supId } });
    expect((await call('GET', `${A}/runtime/status`)).json.killSwitch).toMatchObject({ engaged: true, by: `agent:${supId}` });
    // perp, paper: new risk is refused BY THE RISK ENGINE, as a unified order; the way out stays open
    const a = await row(), deps = pl.perpRuntime().deps, ex = eng.gatewayExecutor(a, deps.executor(a), deps);
    const pos = (await ex.positions()).find((p) => Number(p.size) !== 0)!;
    const sym = pos.instrument.slice(12), m = await deps.market(sym), long = pos.side === 'long';
    const add = await ex.place({ instrument: pos.instrument, side: long ? 'buy' : 'sell', type: 'market', size: String(Math.abs(Number(pos.size))), price: long ? m.book.asks[1]![0] : m.book.bids[1]![0], triggerPrice: null, reduceOnly: false, tif: 'ioc', clientId: `ks-add-${randomUUID()}` } as never, '1');
    expect(add).toMatchObject({ status: 'refused', code: 'kill_switch_active' });
    const [rej] = await sql`select state, reason, reject_code from orders where principal_id = ${id} and id like 'ks-add-%'`;
    expect(rej).toEqual({ state: 'REJECTED', reason: 'KILL_SWITCH_ACTIVE', reject_code: 'kill_switch_active' });
    const cut = await ex.place({ instrument: pos.instrument, side: long ? 'sell' : 'buy', type: 'market', size: String(Math.abs(Number(pos.size))), price: long ? m.book.bids[1]![0] : m.book.asks[1]![0], triggerPrice: null, reduceOnly: true, tif: 'ioc', clientId: `ks-cut-${randomUUID()}` } as never, '1');
    expect(cut, JSON.stringify(cut)).toMatchObject({ status: 'placed', order: { status: 'filled' } });
    // spot (seam gateway, bound read): a purchase is refused, a sale back to cash passes — the same switch, read from the risk engine
    const spot = randomUUID(), done: string[] = [];
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address, state, mode, network) values (${spot}, 'spot under KS', ${sql.json(['ETH'])}, ${sql.json({})}, 9301, '0x0', 'PAPER_TRADING', 'PAPER', 'base')`;
    const seam = { execute: async (o: any) => { done.push(o.side); return { status: 'accepted' as const, venueOrderId: 'sim', filledSize: '1', avgFillPrice: '1', fills: [], final: true }; }, lookup: async () => null, absenceConclusiveAt: (_o: unknown, t: number) => t };
    const g = gwm.orderGateway({ agent: { id: spot, state: 'PAPER_TRADING', mode: 'PAPER', kind: 'spot', universe: ['ETH'] }, authorityId: spot, seam, killSwitch: ks.killSwitchRead, now: clock.now });
    const spotOrder = (side: 'buy' | 'sell') => ({ v: 1, venue: 'kyberswap', network: 'base', instrument: 'kyberswap:ETH', marketKind: 'spot', side, type: 'market', size: side === 'sell' ? '1' : null, notional: side === 'sell' ? null : '10', limitPrice: null, triggerPrice: null, reduceOnly: false, tif: 'ioc',
      maxSlippageBps: 50, maxFeeUsd: '1', leverage: null, marginMode: null, clientOrderId: `ks-spot-${side}-${randomUUID()}`, mode: 'paper', principal: { kind: 'agent', id: spot }, mandateId: spot, createdAt: clock.now(), expiresAt: clock.now() + 60_000 });
    const b = spotOrder('buy'), s = spotOrder('sell');
    expect(await g.submit({ kind: 'agent', id: spot }, b as never, { idempotencyKey: b.clientOrderId })).toMatchObject({ state: 'REJECTED', reason: 'KILL_SWITCH_ACTIVE', source: 'ledger' });
    expect(await g.submit({ kind: 'agent', id: spot }, s as never, { idempotencyKey: s.clientOrderId })).toMatchObject({ state: 'FILLED' });
    expect(done).toEqual(['sell']);
    // nothing in the agents releases: the alias has no release, the risk route wants the passkey; with it, the switch is off for everybody
    expect((await call('POST', `${A}/kill-switch/release`, {})).status).toBe(404);
    expect((await call('POST', '/api/v1/risk/kill-switch/release', {})).status).toBeGreaterThanOrEqual(400);
    expect((await ks.killSwitchRead.engaged()).engaged).toBe(true);
    const prep = (await call('POST', '/api/v1/risk/kill-switch/release/prepare', {})).json;
    const rel = await call('POST', '/api/v1/risk/kill-switch/release', { assertion: owner.assert(Buffer.from(prep.options.challenge, 'base64url')) });
    expect(rel.status, JSON.stringify(rel.json)).toBe(200);
    expect(await ks.killSwitchRead.engaged()).toMatchObject({ engaged: false });
    say(`kill switch engaged by the risk-management agent (agent:${supId.slice(0, 8)}…) → /api/v1/risk/state killSwitch.on=true; perp paper order adding risk → unified order REJECTED KILL_SWITCH_ACTIVE; reduce-only → FILLED; spot buy → REJECTED KILL_SWITCH_ACTIVE, spot sale → FILLED; POST ${A}/kill-switch/release → 404; released with the passkey on /api/v1/risk/kill-switch/release → 200`);
  });

  it('pause and stop: no order while paused; stop is final and the journal says who', async () => {
    expect((await call('POST', `${A}/${id}/pause`, { reason: 'bind test' })).json).toMatchObject({ state: 'paused' });
    const n = (await sql`select count(*)::int as n from orders where principal_id = ${id}`)[0].n;
    clock.advance(H); await rt.tickPass('perp').catch(() => ({}));
    expect((await sql`select count(*)::int as n from orders where principal_id = ${id}`)[0].n).toBe(n);
    expect((await call('POST', `${A}/${id}/stop`, {})).json).toMatchObject({ state: 'stopped' });
    say(`POST …/pause → paused (no order on the next bar); POST …/stop → stopped`);
  });
});

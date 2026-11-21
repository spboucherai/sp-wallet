/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/agent-migration.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// V11 agent model — migration of a database in the PRE-V11 shape (the SCHEMA of the production commit a118e3e, fixtures/agents/),
// holding production-like agents: "Test" (spot, Base: paper, then LIVE under a mandate, stopped), "Eth test" (spot, paper,
// running) and a perp agent with rows in the old signal table. Then: the modes derived for every shared record, the mode-scoped
// read model on those records (no answer carries two modes), and the migrated paper agent goes on ticking — with a restart in
// the middle of a bar. Own database; no network, no signer, no laboratory process.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from './test-db.ts';

const TEST = '11111111-1111-4111-8111-111111111111', ETH_TEST = '22222222-2222-4222-8222-222222222222', PERP = '33333333-3333-4333-8333-333333333333';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/agents/${name}`, import.meta.url), 'utf8');
let sql: any, db: typeof import('../src/db.ts'), store: typeof import('../src/agent-runtime/store.ts'), eng: typeof import('../src/agents/engine.ts'), gwm: typeof import('../src/agent-runtime/gateway.ts');

beforeAll(async () => {
  await useTestDatabase('agent_migration');
  db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe(fixture('pre-v11-schema.sql'));
  await sql.unsafe(fixture('pre-v11-data.sql'));
});
afterAll(async () => { await sql?.end(); });

describe('migration of a pre-V11 database', () => {
  it('the fixture is really the old shape: none of the V11 columns or tables exist yet', async () => {
    const cols = (await sql`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'`).map((r: any) => r.c);
    for (const c of ['agents.family', 'agents.config_version', 'research_log.mode', 'agent_orders.client_order_id', 'strategy_versions.approved_by']) expect(cols, c).not.toContain(c);
    const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public'`).map((r: any) => r.table_name);
    for (const t of ['agent_signals', 'agent_config_versions', 'agent_leases', 'agent_jobs', 'agent_order_intents', 'market_snapshots', 'api_keys']) expect(tables, t).not.toContain(t);
    expect(tables).toContain('perp_agent_signals');
  });

  it('migrates (twice: idempotent) without touching what the agents were', async () => {
    const before = await sql`select id, name, state, mode, universe, risk, capital_usdc::text as capital, strategy_version_id, mandate_id, last_bar, stop_reason from agents order by created_at`;
    await db.migrate(); await db.migrate();
    const after = await sql`select id, name, state, mode, universe, risk, capital_usdc::text as capital, strategy_version_id, mandate_id, last_bar, stop_reason from agents order by created_at`;
    expect(after).toEqual(before);
    expect(after.map((a: any) => [a.name, a.state, a.mode])).toEqual([['Test', 'STOPPED', 'LIVE'], ['Perp fixture', 'STOPPED', 'LIVE'], ['Eth test', 'PAPER_TRADING', 'PAPER']]);
    store = await import('../src/agent-runtime/store.ts'); eng = await import('../src/agents/engine.ts'); gwm = await import('../src/agent-runtime/gateway.ts');
    (await import('../src/agents/execution-bind.ts')).bindExecution((await import('../src/orders/index.ts')).createExecution());   // V11.2: bound as a process binds it (spot swaps stay on the seam gateway)
  });

  it('every agent gets a family (from its strategy), the bar engine, and configuration version 1 — once', async () => {
    const rows = await sql`select name, family, template, engine, config_version, runtime from agents order by name`;
    expect(rows.map((r: any) => [r.name, r.family, r.template, r.engine, r.config_version, r.runtime])).toEqual([['Eth test', 'momentum', null, 'bar', 1, {}], ['Perp fixture', 'stat_arb', null, 'bar', 1, {}], ['Test', 'mean_reversion', null, 'bar', 1, {}]]);
    const cv = await sql`select agent_id, version, config, config_sha256, actor from agent_config_versions order by agent_id`;
    expect(cv.map((r: any) => [r.agent_id, r.version, r.actor])).toEqual([[TEST, 1, 'migration'], [ETH_TEST, 1, 'migration'], [PERP, 1, 'migration']]);
    expect(cv[1].config).toMatchObject({ kind: 'spot', family: 'momentum', network: 'base', universe: ['ETH'], interval: '1h', cash: 'USDC', capitalUsdc: '100000000', strategyVersionId: 'aaaaaaaa-2222-4222-8222-222222222222' });
    expect(cv[1].config.risk).toMatchObject({ maxOrderUsd: 25, maxLossPct: 5 });
    expect(cv.every((r: any) => /^[0-9a-f]{64}$/.test(r.config_sha256))).toBe(true);
    expect((await sql`select approved_by from strategy_versions`).every((r: any) => r.approved_by === 'owner')).toBe(true);   // approvals made before V11 were the owner's
  });

  it('D5 — the journal gets its mode from the agent\'s history: research before any trading, paper, live — and stays live after the stop', async () => {
    const rows = await sql`select agent_id, ts, mode, severity, title from research_log order by ts, id`;
    expect(rows.filter((r: any) => r.agent_id === TEST).map((r: any) => [r.ts.toISOString().slice(0, 10), r.mode])).toEqual([['2026-11-01', 'RESEARCH'], ['2026-11-03', 'PAPER'], ['2026-11-06', 'LIVE'], ['2026-11-08', 'LIVE'], ['2026-11-09', 'LIVE']]);
    expect(rows.filter((r: any) => r.agent_id === ETH_TEST).map((r: any) => r.mode)).toEqual(['PAPER']);
    expect(rows.filter((r: any) => r.agent_id === null).map((r: any) => r.mode)).toEqual([null]);       // not an agent's line
    expect(rows.every((r: any) => r.severity === 'info')).toBe(true);
    // a derivative mandate approved by the live module (no `agent` in its audit record) did not make anybody "live"
    expect((await sql`select spw_agent_mode_at(${ETH_TEST}::uuid, '2026-11-11T00:00:00Z'::timestamptz) as m`)[0].m).toBe('PAPER');
  });

  it('D5 — perp_agent_signals is generalised into agent_signals, each row with the mode it was decided in and its decision', async () => {
    const rows = await sql`select bar, mode, kind, status, decision, reason_code, strategy_sha256, config_version, weights, orders from agent_signals where agent_id = ${PERP} order by bar`;
    expect(rows.map((r: any) => [r.bar.toISOString().slice(0, 10), r.mode, r.kind, r.status, r.decision, r.reason_code])).toEqual([
      ['2026-11-05', 'PAPER', 'perp', 'done', 'acted', null], ['2026-11-06', 'PAPER', 'perp', 'hold', 'skipped', 'no_valid_signal'], ['2026-11-08', 'LIVE', 'perp', 'done', 'skipped', 'at_target']]);
    expect(rows[0].weights).toEqual({ BTC: 0.5, ETH: -0.4 }); expect(rows[0].orders.list).toHaveLength(1);
    expect((await sql`select count(*)::int as n from perp_agent_signals`)[0].n).toBe(3);                // the old table is kept as it was
    expect((await sql`select count(*)::int as n from agent_signals`)[0].n).toBe(3);                     // and a second migration copied nothing twice
  });

  it('a journal line written without a mode (an older call site) gets the agent\'s current one from the database', async () => {
    await sql`insert into research_log (agent_id, kind, title) values (${TEST}, 'hold', 'legacy writer'), (${ETH_TEST}, 'hold', 'legacy writer')`;
    const rows = await sql`select agent_id, mode, config_version from research_log where title = 'legacy writer' order by agent_id`;
    expect(rows.map((r: any) => [r.mode, r.config_version])).toEqual([['LIVE', 1], ['PAPER', 1]]);
    await sql`delete from research_log where title = 'legacy writer'`;
  });
});

describe('mode separation on the migrated records — the read model', () => {
  it('journal, orders and signals answer ONE mode; the same agent\'s paper and live rows never appear together', async () => {
    const a = await store.loadAgent(TEST);
    const [jr, jp, jl] = await Promise.all([store.agentJournal(a.id, 'research'), store.agentJournal(a.id, 'paper'), store.agentJournal(a.id, 'live')]);
    expect([jr.length, jp.length, jl.length]).toEqual([1, 1, 3]);
    expect([...jr, ...jp, ...jl].map((x) => x.mode)).toEqual(['research', 'paper', 'live', 'live', 'live']);
    const [op, ol] = await Promise.all([store.agentOrders(a, 'paper'), store.agentOrders(a, 'live')]);
    expect(op.map((o) => [o.mode, o.state, o.instrument, o.side, o.venueOrderId])).toEqual([['paper', 'FILLED', 'kyberswap:ETH', 'buy', null]]);
    expect(ol.map((o) => [o.mode, o.state, o.venueOrderId])).toEqual([['live', 'FILLED', '0xfeed']]);
    expect(await store.agentOrders(a, 'research')).toEqual([]);
    const p = await store.loadAgent(PERP);
    expect((await store.agentSignals(p.id, 'paper')).map((s) => [s.mode, s.decision])).toEqual([['paper', 'skipped'], ['paper', 'acted']]);
    expect((await store.agentSignals(p.id, 'live')).map((s) => [s.mode, s.decision, s.reasonCode])).toEqual([['live', 'skipped', 'at_target']]);
  });

  it('performance is computed per mode, from that mode\'s equity only: paper +4 %, live −6 %, and no figure adds the two', async () => {
    const a = await store.loadAgent(TEST);
    const paper = await store.agentPerformance(a, 'paper'), live = await store.agentPerformance(a, 'live'), research = await store.agentPerformance(a, 'research');
    expect(paper.equityCurve.map((x) => x.equity)).toEqual([100, 104]); expect(live.equityCurve.map((x) => x.equity)).toEqual([50, 47]);
    expect(paper.totalReturn.value).toBeCloseTo(0.04, 12); expect(live.totalReturn.value).toBeCloseTo(-0.06, 12);
    expect(paper.netPnlUsd.value).toBeCloseTo(4, 12); expect(live.netPnlUsd.value).toBeCloseTo(-3, 12);
    expect([paper.mode, live.mode, research.mode]).toEqual(['paper', 'live', 'research']);
    expect(paper.label).toMatch(/^PAPER — simulated/); expect(live.label).toMatch(/^LIVE — real orders/); expect(research.label).toMatch(/^RESEARCH/);
    expect(research.points).toBe(0); expect(research.label).toMatch(/backtest reports .* are not performance/);
    // two points: every ratio is flagged
    expect(paper.warnings.map((w) => w.code)).toContain('small_sample');
    expect(paper.orders).toBe(1); expect(live.orders).toBe(1);
    // the timeline of one mode holds that mode's journal, signals and orders
    const tl = await store.agentTimeline(a, 'live');
    expect(tl.mode).toBe('live'); expect(tl.items.map((i) => i.title)).toEqual(['Mandate not revoked yet', 'Agent stopped', 'Order filled: buy kyberswap:ETH', 'Order not placed']);
  });

  it('the summary: active | paused | stopped, the mode, the strategy pinned by its hash, the mandate reference, and whether it can go live', async () => {
    const t = await store.agentSummary(await store.loadAgent(TEST)), e = await store.agentSummary(await store.loadAgent(ETH_TEST)), p = await store.agentSummary(await store.loadAgent(PERP));
    expect([t.state, t.phase, t.mode, t.family, t.mandate]).toEqual(['stopped', 'STOPPED', 'live', 'mean_reversion', null]);      // stopped: the mandate id it once held is not a mandate in force
    expect([e.state, e.phase, e.mode, e.family, e.configVersion]).toEqual(['active', 'PAPER_TRADING', 'paper', 'momentum', 1]);
    expect(e.strategy).toMatchObject({ name: 'ma_trend', version: '3', sha256: '2'.repeat(64), status: 'approved', kind: 'python' });
    expect(p.live).toEqual({ capable: true, code: null, reason: null });        // BTC, ETH: pinned
    expect(e.live.capable).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the migrated agent keeps running

const H = 3_600_000, BAR = Date.parse('2026-11-12T09:00:00Z');
function deps(o: { weights: Record<string, number>; bar?: number; gateway?: any } ) {
  const calls = { signal: 0, quote: 0 }, bar = o.bar ?? BAR;
  const d: any = {
    series: async () => Array.from({ length: 60 }, (_, i) => ({ ts: bar - (59 - i) * H, open: 2500, high: 2500, low: 2500, close: 2500, volume: 1 })),
    assertFresh: async () => {},
    signal: async () => { calls.signal += 1; return o.weights; },
    holdings: async (a: any) => eng.paperHoldings(a),
    quote: async (_a: any, from: string, _to: string, amt: bigint) => { calls.quote += 1; return from === 'native' ? (amt * 2500n) / 10n ** 12n : amt * 10n ** 12n / 2500n; },   // 2 500 USDC per ETH
    placeLive: async () => { throw new Error('a paper agent never reaches the live path'); },
    inFlight: async () => false, halted: async () => false, now: () => bar + 120_000,
    ...(o.gateway ? { gateway: o.gateway } : {}),
  };
  return { d, calls };
}
const row = async (id: string) => (await sql`select * from agents where id = ${id}`)[0];

describe('"Eth test" (paper) goes on ticking after the migration', () => {
  it('a new bar: the signal is STORED (D8) with its mode, configuration version, code hash and inputs digest; the order goes through the gateway', async () => {
    const { d, calls } = deps({ weights: { ETH: 0.5 } });
    // 75 USDC + 0.01 ETH at 2 500 = 100 USD; target 50 % → buy 25 USD of ETH
    expect(await eng.tickAgent(await row(ETH_TEST), d)).toBe('1 order(s)');
    expect(calls.signal).toBe(1);
    const [s] = await sql`select * from agent_signals where agent_id = ${ETH_TEST}`;
    expect([s.mode, s.kind, s.status, s.decision, s.reason_code, s.config_version, s.strategy_sha256, s.bar.getTime()]).toEqual(['PAPER', 'spot', 'decided', 'acted', 'acted', 1, '2'.repeat(64), BAR]);
    expect(s.weights).toEqual({ ETH: 0.5 }); expect(s.inputs_digest).toMatch(/^[0-9a-f]{64}$/); expect(Number(s.equity)).toBeCloseTo(100, 6);
    const [o] = await sql`select * from agent_orders where agent_id = ${ETH_TEST} and bar = ${new Date(BAR)}`;
    expect([o.mode, o.state, o.from_symbol, o.to_symbol, o.amount_in, o.client_order_id, Number(o.signal_id), o.config_version, o.strategy_sha256]).toEqual(['PAPER', 'filled', 'USDC', 'ETH', '25000000', `sp-${ETH_TEST}-p-${BAR / 1000}-0`, Number(s.id), 1, '2'.repeat(64)]);
    const [i] = await sql`select * from agent_order_intents where agent_id = ${ETH_TEST}`;
    expect([i.mode, i.state, i.reason, i.venue, i.instrument, i.side, i.client_order_id]).toEqual(['PAPER', 'FILLED', 'VENUE_FILLED', 'kyberswap', 'kyberswap:ETH', 'buy', o.client_order_id]);
    expect(i.history.map((h: any) => h.to)).toEqual(['VALIDATED', 'APPROVED', 'SUBMITTING', 'FILLED']);
    expect(i.record.filledSize).toBe('0.01'); expect(i.order_json.mandateId).toBe(ETH_TEST);        // paper: the simulated account, not a mandate
    // the paper book moved in the same transaction, the equity point of the bar is PAPER, the journal lines are PAPER
    expect(Object.fromEntries((await sql`select symbol, units from agent_paper where agent_id = ${ETH_TEST}`).map((r: any) => [r.symbol, r.units]))).toEqual({ USDC: 50, ETH: 0.02 });
    expect((await sql`select mode, equity_usd from agent_equity where agent_id = ${ETH_TEST} and ts = ${new Date(BAR)}`)[0]).toMatchObject({ mode: 'PAPER', equity_usd: 100 });
    const j = await sql`select kind, mode, code, title from research_log where agent_id = ${ETH_TEST} and ts > '2026-11-12T00:00:00Z' order by id`;
    expect(j.map((x: any) => [x.kind, x.mode, x.code])).toEqual([['order', 'PAPER', 'FILLED'], ['fill', 'PAPER', 'FILL']]);
    expect((await row(ETH_TEST)).last_bar.getTime()).toBe(BAR);
    // same bar again: nothing
    expect(await eng.tickAgent(await row(ETH_TEST), d)).toBe('waiting for the next bar');
    // and the read model of this agent shows the old (pre-ledger) order and the new one, both PAPER, in the unified states
    expect((await store.agentOrders(await store.loadAgent(ETH_TEST), 'paper')).map((x) => [x.source, x.state])).toEqual([['gateway', 'FILLED'], ['legacy', 'FILLED']]);
  });

  it('RESTART between the signal and the order: the stored decision is read back — the strategy is not asked again, the order is placed once', async () => {
    const bar = BAR + H;
    // the process "dies" when the first order is about to be submitted
    const dying = deps({ weights: { ETH: 0 }, bar, gateway: () => ({ submit: async () => { throw new Error('process died'); } }) });
    await expect(eng.tickAgent(await row(ETH_TEST), dying.d)).rejects.toThrow('process died');
    const [s] = await sql`select id, decision, status, weights from agent_signals where agent_id = ${ETH_TEST} and bar = ${new Date(bar)}`;
    expect([s.status, s.decision, s.weights]).toEqual(['decided', 'pending', { ETH: 0 }]);
    expect((await row(ETH_TEST)).last_bar.getTime()).toBe(BAR);                  // the bar is still open
    expect((await sql`select count(*)::int as n from agent_orders where agent_id = ${ETH_TEST} and bar = ${new Date(bar)}`)[0].n).toBe(0);
    // restart: a strategy that would now say something else is not consulted for this bar
    const again = deps({ weights: { ETH: 0.5 }, bar });
    expect(await eng.tickAgent(await row(ETH_TEST), again.d)).toBe('2 order(s)');     // sells the 0.02 ETH (50 USD) in two orders of at most 25 USD
    expect(again.calls.signal).toBe(0);
    const orders = await sql`select from_symbol, to_symbol, client_order_id, signal_id from agent_orders where agent_id = ${ETH_TEST} and bar = ${new Date(bar)} order by client_order_id`;
    expect(orders.map((o: any) => [o.from_symbol, o.to_symbol, o.client_order_id, Number(o.signal_id)])).toEqual([['ETH', 'USDC', `sp-${ETH_TEST}-p-${bar / 1000}-0`, Number(s.id)], ['ETH', 'USDC', `sp-${ETH_TEST}-p-${bar / 1000}-1`, Number(s.id)]]);
    expect((await sql`select decision from agent_signals where id = ${s.id}`)[0].decision).toBe('acted');
    // a second process ticking the same bar with the same client ids cannot fill twice: the ledger answers the first record
    const [first] = await sql`select order_json from agent_order_intents where client_order_id = ${`sp-${ETH_TEST}-p-${bar / 1000}-0`}`;
    const a = await row(ETH_TEST), seam = { execute: async () => { throw new Error('must not run'); }, lookup: async () => null, absenceConclusiveAt: () => 0 };
    const rec = await gwm.orderGateway({ agent: a, seam, authorityId: a.id }).submit({ kind: 'agent', id: a.id }, first.order_json, { idempotencyKey: first.order_json.clientOrderId });
    expect([rec.state, rec.idempotent]).toEqual(['FILLED', true]);
  });

  it('a strategy that answers nothing valid is a recorded HOLD (skipped / no_valid_signal), and the bar is closed', async () => {
    const bar = BAR + 2 * H, { d } = deps({ weights: { DOGE: 1 } as never, bar });
    expect(await eng.tickAgent(await row(ETH_TEST), d)).toBe('hold: no valid signal');
    const [s] = await sql`select status, decision, reason_code, reason, weights from agent_signals where agent_id = ${ETH_TEST} and bar = ${new Date(bar)}`;
    expect([s.status, s.decision, s.reason_code, s.weights]).toEqual(['hold', 'skipped', 'no_valid_signal', null]); expect(s.reason).toMatch(/DOGE/);
    expect((await sql`select mode, code from research_log where agent_id = ${ETH_TEST} and title = 'No valid signal: holding' and ts > '2026-11-12T00:00:00Z'`)[0]).toMatchObject({ mode: 'PAPER', code: 'no_valid_signal' });
  });

  it('the kill switch stops what adds risk and lets a sale back to cash through', async () => {
    const on = { engaged: async () => ({ engaged: true, reason: 'test' }) };
    const buy = deps({ weights: { ETH: 0.5 }, bar: BAR + 3 * H }); buy.d.killSwitch = on;
    expect(await eng.tickAgent(await row(ETH_TEST), buy.d)).toMatch(/^order rejected: the kill switch is engaged/);
    expect((await sql`select decision, reason_code from agent_signals where agent_id = ${ETH_TEST} and bar = ${new Date(BAR + 3 * H)}`)[0]).toEqual({ decision: 'skipped', reason_code: 'kill_switch' });
    expect((await sql`select state, reason from agent_order_intents where agent_id = ${ETH_TEST} order by created_at desc limit 1`)[0]).toEqual({ state: 'REJECTED', reason: 'KILL_SWITCH_ACTIVE' });
    // give the agent something to sell, then a bar whose target is flat: the sale passes under the same switch
    await sql`update agent_paper set units = 0.01 where agent_id = ${ETH_TEST} and symbol = 'ETH'`;
    const sell = deps({ weights: { ETH: 0 }, bar: BAR + 4 * H }); sell.d.killSwitch = on;
    expect(await eng.tickAgent(await row(ETH_TEST), sell.d)).toBe('1 order(s)');
  });
});

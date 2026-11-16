// Perp agents LIVE (V7): `LivePerpExecutor` and the life cycle, inside the process — the REAL engine (perp-engine.ts), the REAL
// live execution engine and mandate helpers, the REAL isolated signer class with its own venue reader and a software passkey
// (perp-live-world.ts), PostgreSQL (database spw_perp_live_test, created here if missing) and the scripted Hyperliquid fake
// that derivatives-mandate.test.ts uses (hl-fake.ts). The gate and the signal are scripted. No network.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import { useDatabase } from './derivatives-helpers.ts';
import { BTC, liveWorld, type LiveWorld } from './perp-live-world.ts';

let sql: any, cyc: typeof import('../src/agents/perp-live-cycle.ts'), mw: typeof import('../src/agents/mandate-write.ts'), xl: typeof import('../src/agents/perp-exec-live.ts'), eng: typeof import('../src/agents/perp-engine.ts'),
  pl: typeof import('../src/agents/perp-live.ts'), pp: typeof import('../src/derivatives/paper.ts');

beforeAll(async () => {
  await useDatabase('perp_live');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate(); await db.migrate();
  eng = await import('../src/agents/perp-engine.ts');
  await import('../src/agents/perp-strategies.ts');                            // module order of the agents' routes (as in perp-agent.test.ts)
  pl = await import('../src/agents/perp-live.ts'); cyc = await import('../src/agents/perp-live-cycle.ts'); mw = await import('../src/agents/mandate-write.ts'); xl = await import('../src/agents/perp-exec-live.ts'); pp = await import('../src/derivatives/paper.ts');
});
/** an empty database: every world starts with its own venue account (the test mnemonic is the same in all of them) */
const reset = async () => {
  await sql`truncate deriv_accounts, deriv_orders, deriv_fills, deriv_funding, deriv_risk_events, deriv_equity, deriv_actions, deriv_mandates`;
  await sql`delete from agent_signals`; await sql`delete from agent_equity`; await sql`delete from research_log`; await sql`delete from strategy_versions`; await sql`delete from agents`;
};
beforeEach(reset);
afterAll(async () => { await sql?.end(); });

const H = 3_600_000;
const RISK = { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };

interface Agent { id: string; sha: string; bar: number; weights: Record<string, number> | Error; signals: number; rt: import('../src/agents/perp-live-cycle.ts').PerpLiveRuntime;
  row: () => Promise<any>; tick: () => Promise<string>; pass: () => Promise<string>; nextBar: (w: Record<string, number>) => Promise<string>; signalRows: () => Promise<any[]> }

/**
 * V11.2 — the agents are bound to the execution layer: a live agent's order is `orders.submitCanonical` (unified table, risk
 * engine, trading mandate) on the world's own live service and signer. As the owner would have done: his live risk limits are
 * stored (none binding here), and live execution through the order service is switched on for the suite.
 */
async function bindWorld(w: LiveWorld): Promise<void> {
  const ord = await import('../src/orders/index.ts'), bind = await import('../src/agents/execution-bind.ts');
  process.env.SPW_TRADING_API_EXECUTION = 'on';
  await (await import('./derivatives-helpers.ts')).openLiveLimits(sql);
  // one clock for the mandate service and the live engine: the world's (the paper side is never used by a live agent)
  const h = await import('./derivatives-helpers.ts'), dm = await import('../src/derivatives/index.ts');
  const derivatives = dm.createDerivatives({ registry: dm.createRegistry(h.fixtureVenues(w.clock as never).adapters, w.clock.now), now: w.clock.now });
  const ex = ord.createExecution({ live: w.svc, derivatives, signerStatus: async () => ({ halted: false }) });
  w.svc.preTrade = ex.risk.gate; w.svc.newRiskBlock = ex.risk.newRiskBlock;
  bind.bindExecution(ex);
}

/** a perp agent on BTC with an approved contract-2 version; the gate and the signal are scripted */
async function agent(w: LiveWorld, o: { risk?: Partial<typeof RISK>; approved?: boolean; name?: string } = {}): Promise<Agent> {
  await bindWorld(w);
  const id = randomUUID(), sv = randomUUID(), sha = createHash('sha256').update(id).digest('hex');
  const [{ next }] = await sql`select least(coalesce(min(vault_index), 0), 0) - 1 as next from agents`;
  await sql`insert into agents (id, kind, name, network, universe, interval, risk, vault_index, vault_address, capital_usdc, deriv_account_id, state, mode, strategy_version_id)
    values (${id}, 'perp', ${o.name ?? 'live-test'}, 'hyperliquid', ${sql.json(['BTC'])}, '1h', ${sql.json({ ...RISK, ...o.risk })}, ${next}, '', '1000000000', ${randomUUID()}, 'AWAITING_APPROVAL', 'PAPER', ${o.approved === false ? null : sv})`;
  await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${id}, 'fixed_perp', '1', ${sha}, 'strategies/fixed_perp/1',
    ${sql.json({ kind: 'perp', lookback: 10, max_leverage: 2, max_gross_exposure: 2 })}, ${o.approved === false ? 'draft' : 'approved'}, ${sql.json({})})`;
  const never = async (): Promise<never> => { throw new Error('the paper side of the runtime must not be used by a live agent'); };
  const a: Agent = { id, sha, bar: Math.floor(w.clock.now() / H) * H - H, weights: { BTC: 0.5 }, signals: 0,
    rt: { live: () => w.svc, deps: { now: w.clock.now, gate: async () => ({ bar: a.bar, data: {} }), market: never, executor: () => { throw new Error('no paper executor'); },
      signal: async () => { a.signals += 1; if (a.weights instanceof Error) throw a.weights; return { weights: a.weights, maxLeverage: 2, maxGrossExposure: 2 }; } } },
    row: async () => (await sql`select * from agents where id = ${id}`)[0],
    tick: async () => cyc.tickLivePerpAgent(await a.row(), a.rt),
    pass: async () => { w.next(); return a.tick(); },
    nextBar: async (weights) => { a.bar += H; a.weights = weights; w.next(); return a.tick(); },
    signalRows: () => sql`select bar, status, orders, targets from agent_signals where agent_id = ${id} order by bar` };
  return a;
}
/** the ONE passkey: prepare the mandate derived from the agent's limits, approve it */
async function goLive(w: LiveWorld, a: Agent, accountId: string) {
  const prep = await mw.prepareLive(await a.row(), a.rt, { accountId, locale: 'fr' });
  const row = await mw.approveLive(await a.row(), a.rt, { accountId, assertion: w.pk.assert(w.b64(prep.hash)) as never, acknowledged: true });
  return { prep, row };
}
async function liveAgent(o: { risk?: Partial<typeof RISK>; fund?: string } = {}) {
  await reset();
  const w = await liveWorld(), acct = await w.authorise('testnet', o.fund ?? '1000'), a = await agent(w, o.risk ? { risk: o.risk } : {});
  const { prep } = await goLive(w, a, acct);
  return { w, a, acct, prep };
}
/** the market moves away between the engine's read of the book and the venue's matching: every order finds nothing to match */
function noLiquidity(w: LiveWorld): () => void {
  const real = w.t.fetch;
  w.t.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/exchange') || JSON.parse(String(init?.body)).action?.type !== 'order') return real(url as never, init);
    const saved = [w.t.bids, w.t.asks] as const;
    w.t.bids = [['61000', '1']]; w.t.asks = [['79000', '1']];
    try { return await real(url as never, init); } finally { [w.t.bids, w.t.asks] = [saved[0], saved[1]]; }
  }) as never;
  return () => { w.t.fetch = real; };
}
const refusal = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? { code: e.code as string, status: e.status as number, message: e.message as string } : null; };
const pos = (w: LiveWorld) => w.t.user(w.ACCOUNT).positions.get('BTC')?.szi ?? '0';
const orders = (acct: string) => sql`select client_id, side, reduce_only, state, final, size::text, filled::text, origin, reject_reason from deriv_orders where account_id = ${acct} order by created_at, nonce` as Promise<any[]>;
const leverageActions = async (acct: string) => (await sql`select count(*)::int as n from deriv_actions where account_id = ${acct} and kind = 'leverage'`)[0].n as number;
const logs = async (id: string) => (await sql`select kind, title, body from research_log where agent_id = ${id} order by ts, id`) as { kind: string; title: string; body: string }[];
const statuses = async (a: Agent) => (await a.signalRows()).map((r: any) => (r.orders?.list ?? []).map((x: any) => `${x.side}${x.reduceOnly ? ' RO' : ''} ${x.status}${x.code ? `:${x.code}` : ''}`));

describe('going live: the checklist, the mandate derived from the limits, one passkey', () => {
  it('readiness says what is missing, step by step, and computes the funding minimum and the mandate', async () => {
    const w = await liveWorld(), draft = await agent(w, { approved: false }), a = await agent(w);
    const ready = async (x: Agent, account?: string) => cyc.liveReadiness(await x.row(), x.rt, { account, locale: 'fr' });
    expect(await ready(draft)).toMatchObject({ next: 'strategy', steps: { strategy: { ok: false }, account: { ok: false, code: 'no_account' } }, proposal: null, accounts: [] });
    expect(await ready(a)).toMatchObject({ next: 'account', steps: { strategy: { ok: true, sha256: a.sha }, account: { code: 'no_account' }, funded: { ok: false } } });
    // a venue account that the owner has not authorised yet
    const ro = (await w.svc.createAccount({ venue: 'hyperliquid', network: 'testnet', label: 'Testnet' })).id as string;
    expect(await ready(a)).toMatchObject({ next: 'account', accountId: ro, steps: { account: { ok: false, code: 'read_only', network: 'testnet', authorization: null }, funded: { ok: false, code: 'unfunded' } } });
    await expect(mw.prepareLive(await a.row(), a.rt, { accountId: ro, locale: 'en' })).rejects.toMatchObject({ code: 'not_ready', status: 409 });
    // authorised (the owner's passkey, in Futures → Accounts), then the funding step from the venue's own account value
    const acct = await w.authorise('testnet', '1000');
    expect(acct).toBe(ro);
    w.t.user(w.ACCOUNT).usdc = '0';
    expect(await ready(a)).toMatchObject({ next: 'fund', steps: { account: { ok: true, authorization: { active: true, maxMandateDays: 29 } }, funded: { ok: false, code: 'unfunded', equity: '0', minEquity: '50' } } });
    w.t.user(w.ACCOUNT).usdc = '49.5';
    const low = await ready(a);
    expect(low.steps.funded).toMatchObject({ ok: false, code: 'below_minimum', equity: '49.5', minEquity: '50', basis: { instruments: [{ instrument: BTC, minOrder: '10.5' }], ordersPerPosition: 5, grossX: 1.5, floor: '50' } });
    w.t.user(w.ACCOUNT).usdc = '1000';
    const r = await ready(a);
    expect(r).toMatchObject({ next: 'mandate', accountId: acct, locale: 'fr', config: { locale: 'fr', mandateLive: { available: true } }, steps: { strategy: { ok: true }, account: { ok: true }, funded: { ok: true, equity: '1000' }, mandate: { ok: false, lock: null } },
      accounts: [{ id: acct, network: 'testnet', equity: '1000', usedBy: null, mandate: null, authorization: { active: true } }] });
    // the mandate is DERIVED from the agent's limits on the venue's account value — nothing is chosen freely
    expect(r.proposal).toMatchObject({ capital: '1000', days: 29, maxDays: 29, notes: [],
      body: { instruments: [{ instrument: BTC, maxLeverage: 2, maxPositionNotional: '1000' }], maxOrderNotional: '1000', maxGrossExposure: '1500', maxDailyTurnover: '6000', floorEquity: '900',
        maxOrdersPerDay: 48, maxOrdersPerHour: 4, days: 29, strategySha256: a.sha, agentId: a.id } });
    expect(r.proposal!.derived.map((d) => d.field)).toEqual(['capital', 'instruments', 'maxLeverage', 'maxPositionNotional', 'maxOrderNotional', 'maxGrossExposure', 'maxOrdersPerDay', 'maxOrdersPerHour', 'maxDailyTurnover', 'floorEquity', 'days']);
    // a larger agent on a tighter authorization: clamped, and said
    const big = cyc.deriveMandate({ id: a.id, universe: ['BTC'], interval: '4h', risk: { ...RISK, maxLeverage: 5, maxPositionX: 3, maxGrossExposureX: 4 } }, a.sha, 'testnet', '1000.129',
      { expiresAt: w.clock.now() + 3 * 86_400_000, policy: { maxLeverage: 3, maxOrderNotional: '1000', maxPositionNotional: '1000', maxGrossExposure: '1500', maxOrdersPerDay: 50 } }, w.clock.now(), 30);
    expect(big).toMatchObject({ capital: '1000.12', days: 2, maxDays: 2, body: { instruments: [{ maxLeverage: 3, maxPositionNotional: '1000' }], maxOrderNotional: '1000', maxGrossExposure: '1500', floorEquity: '900.11', maxOrdersPerDay: 12, maxOrdersPerHour: 4 } });
    expect(big.notes.join(' ')).toMatch(/gross exposure: 4000\.48 from the agent's limits, lowered to the venue authorization's 1500/);
    // an account that is not flat, an authorization about to expire, instruments outside the pinned table
    w.t.forcePosition(w.ACCOUNT, 'BTC', '0.001');
    expect((await ready(a)).steps.account).toMatchObject({ ok: false, code: 'account_not_flat' });
    w.t.forcePosition(w.ACCOUNT, 'BTC', '0');
    w.clock.advance(28.5 * 86_400_000);
    expect((await ready(a)).steps.account).toMatchObject({ ok: false, code: 'authorization_too_short', authorization: { maxMandateDays: 0 } });
    w.clock.advance(-28.5 * 86_400_000);
    await sql`update agents set universe = ${sql.json(['BTC', 'DOGE'])} where id = ${a.id}`;
    expect((await ready(a)).steps.account).toMatchObject({ ok: false, code: 'instruments_not_pinned', instrumentsMissing: ['hyperliquid:DOGE'] });
    await sql`update agents set universe = ${sql.json(['BTC', 'ETH'])} where id = ${a.id}`;
    expect((await ready(a)).steps.account).toMatchObject({ ok: false, code: 'instruments_not_allowed', instrumentsMissing: ['hyperliquid:ETH'] });
  });

  it('prepare shows what the signer will enforce; ONE passkey makes the agent LIVE; one agent per venue account', async () => {
    const w = await liveWorld(), acct = await w.authorise(), a = await agent(w), b = await agent(w, { name: 'second' });
    const exchangeBefore = w.t.exchangeCalls();
    const prep = await mw.prepareLive(await a.row(), a.rt, { accountId: acct, locale: 'fr', days: 7 });
    expect(prep).toMatchObject({ locale: 'fr', windDown: { seconds: 86400 }, proposal: { capital: '1000', days: 7 },
      mandate: { network: 'testnet', account: w.ACCOUNT, strategySha256: a.sha, agentId: a.id, maxOrderNotional: '1000', maxGrossExposure: '1500', floorEquity: '900', maxOrdersPerHour: 4 } });
    expect(prep.mandate.expiresAt - prep.mandate.createdAt).toBe(7 * 86400);
    expect(prep.acknowledgement.text.length).toBeGreaterThan(200);
    expect(prep.enforcedBySigner.length).toBeGreaterThan(4); expect(prep.trustedBySigner.length).toBeGreaterThan(1); expect(prep.notEnforced.length).toBeGreaterThan(1);
    expect(prep.options.challenge).toBe(w.b64(prep.hash).toString('base64url'));                                         // the passkey signs the mandate hash
    // a passkey assertion over something else, the checkbox, another agent's preparation
    expect(cyc.LiveApproveBody.safeParse({ accountId: acct, assertion: {}, acknowledged: false }).success).toBe(false);
    expect(await refusal(mw.approveLive(await b.row(), b.rt, { accountId: acct, assertion: w.pk.assert(w.b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'not_ready', status: 409 });
    expect(await refusal(mw.approveLive(await a.row(), a.rt, { accountId: acct, assertion: w.pk.assert(Buffer.alloc(32, 7)) as never, acknowledged: true }))).toMatchObject({ code: 'signer_bad_approval' });
    expect(await a.row()).toMatchObject({ state: 'AWAITING_APPROVAL', mode: 'PAPER', live_account_id: null });           // a refused approval leaves the agent in simulation and releases the account
    expect(await refusal(mw.approveLive(await a.row(), a.rt, { accountId: acct, assertion: w.pk.assert(w.b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'not_ready' });   // consumed: prepare again

    const { row } = await goLive(w, a, acct);
    expect(row).toMatchObject({ state: 'LIVE', mode: 'LIVE', live_account_id: acct, perp: { live: { accountId: acct, network: 'testnet', strategySha256: a.sha, capital: '1000', exit: null } } });
    expect(w.signer.status().venueMandates).toHaveLength(1);
    expect(w.t.exchangeCalls()).toBe(exchangeBefore);                                                                     // going live sends nothing to the venue
    expect(await cyc.liveReadiness(await a.row(), a.rt, { locale: 'en' })).toMatchObject({ next: 'live', accountId: acct, steps: { mandate: { ok: true, phase: 'active' } }, proposal: null,
      accounts: [{ usedBy: { agentId: a.id, name: 'live-test' }, mandate: { agentId: a.id, phase: 'active' } }] });
    // the second agent sees the account as taken; a live agent cannot be prepared again
    expect((await cyc.liveReadiness(await b.row(), b.rt, { locale: 'en' })).steps.account).toMatchObject({ ok: false, code: 'used_by_other_agent' });
    expect(await refusal(mw.prepareLive(await b.row(), b.rt, { accountId: acct, locale: 'en' }))).toMatchObject({ code: 'not_ready' });
    expect(await refusal(mw.prepareLive(await a.row(), a.rt, { accountId: acct, locale: 'en' }))).toMatchObject({ code: 'bad_state' });
    await expect(sql`update agents set live_account_id = ${acct} where id = ${b.id}`).rejects.toMatchObject({ code: '23505' });   // the database itself: one agent per venue account
    const block = await cyc.liveBlock(await a.row(), a.rt, true);
    expect(block).toMatchObject({ available: true, active: true, network: 'testnet', capital: '1000', paused: false, exit: null, holds: [],
      account: { id: acct, modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: { agentId: a.id, phase: 'active' }, venueState: { source: 'venue', positions: [] } }, signer: { phase: 'active', today: { orders: 0 } } });
  });

  it('mainnet autonomous trading is a SERVER setting: with it off nothing is prepared, whatever the owner does', async () => {
    const w = await liveWorld(), a = await agent(w);
    w.flags.mainnet = true;                                                                                               // SPW_DERIV_LIVE_MAINNET=on (manual live), SPW_DERIV_MANDATE_MAINNET off
    const acct = await w.authorise('mainnet');
    const r = await cyc.liveReadiness(await a.row(), a.rt, { account: acct, locale: 'fr' });
    expect(r).toMatchObject({ next: 'locked', steps: { strategy: { ok: true }, account: { ok: true, network: 'mainnet' }, funded: { ok: true }, mandate: { ok: false, lock: { code: 'mandate_mainnet_disabled' } } } });
    expect(r.steps.mandate.lock!.reason).toBe(r.config.reasons.mandate_mainnet_disabled.fr);
    expect(r.steps.mandate.lock!.reason).toMatch(/SPW_DERIV_MANDATE_MAINNET=on/);
    expect(r.proposal).not.toBeNull();                                                                                    // what WOULD be approved is shown
    expect(await refusal(mw.prepareLive(await a.row(), a.rt, { accountId: acct, locale: 'fr' }))).toMatchObject({ code: 'mandate_mainnet_disabled', status: 403 });
    expect(await a.row()).toMatchObject({ mode: 'PAPER', live_account_id: null });
    expect(w.m.exchangeCalls('order')).toBe(0); expect(w.mandateSigns).toHaveLength(0);
    // manual live off too: the account step says so with the server's sentence
    w.flags.mainnet = false;
    expect((await cyc.liveReadiness(await a.row(), a.rt, { account: acct, locale: 'en' })).steps.account).toMatchObject({ ok: false, code: 'mainnet_disabled', reason: expect.stringMatching(/SPW_DERIV_LIVE_MAINNET/) });
  });
});

describe('LivePerpExecutor through the engine: the venue decides', () => {
  it('long, then a flip to short as close-then-open over two passes, then flat — decisions from the VENUE\'s state, leverage set once, no order storm', async () => {
    const { w, a, acct } = await liveAgent();
    // bar 1: long 0.5 × the venue's account value. The venue's default leverage is 20×: set to the agent's 2× first, once.
    expect(await a.tick()).toBe('1 order(s)');
    expect(pos(w)).toBe('0.00714');                                                                                       // 0.5 × 1 000 / 70 000, on the lot
    // V11.2: the trading mandate states capital × leverage; with gross 1.5 × capital and a floor at 0.9 × capital the only whole
    // leverage whose compiled gross bound does not exceed the agent's limit is 1× (mandate-write.ts `tradingMandateBody`)
    expect(w.t.user(w.ACCOUNT).leverage.get('BTC')).toEqual({ type: 'cross', value: 1 });
    expect([await leverageActions(acct), w.orderSigns(), w.mandateSigns.length]).toEqual([1, 1, 2]);
    expect(w.signs).toHaveLength(0);                                                                                      // never the passkey path
    const [o1] = await orders(acct);
    expect(o1).toMatchObject({ side: 'buy', reduce_only: false, state: 'filled', final: true, origin: 'mandate', size: '0.00714', filled: '0.00714' });
    expect(o1.client_id).toBe(eng.orderClientId(a.id, a.sha, a.bar, 'BTC', 'open'));
    expect((await a.signalRows())[0]).toMatchObject({ status: 'done', targets: { BTC: '0.00714' } });
    expect((await sql`select mode, equity_usd from agent_equity where agent_id = ${a.id}`)[0]).toMatchObject({ mode: 'LIVE' });
    // the same bar, many passes: one decision per bar, and the signer is not asked again
    for (let k = 0; k < 5; k++) expect(await a.pass()).toBe('waiting for the next bar');
    expect([a.signals, w.orderSigns(), w.t.exchangeCalls('order')]).toEqual([1, 1, 1]);

    // bar 2: short. The reduce-only close goes now; the open waits for the next pass (the signer still counts what it just signed)
    expect(await a.nextBar({ BTC: -0.5 })).toBe('1 order(s), 1 waiting for the next pass');
    expect(pos(w)).toBe('0');
    expect(await statuses(a)).toEqual([['buy filled'], ['sell RO filled', 'sell deferred:live_cooldown']]);
    expect((await a.row()).last_bar.getTime()).toBe(a.bar - H);                                                           // the bar stays open
    expect(await a.tick()).toBe('0 order(s), 1 waiting for the next pass');                                               // asked again at once: still waiting, nothing signed
    expect(w.orderSigns()).toBe(2);
    expect(await a.pass()).toBe('1 order(s)');                                                                            // a minute later: planned again from the venue's real (flat) position
    expect(D.isNeg(D.from(pos(w)))).toBe(true);
    expect((await orders(acct)).map((o) => `${o.side}${o.reduce_only ? ' RO' : ''} ${o.state}`)).toEqual(['buy filled', 'sell RO filled', 'sell filled']);
    expect((await statuses(a))[1]).toEqual(['sell RO filled', 'sell filled']);                                            // the log of the bar keeps the close sent on the earlier pass
    expect([a.signals, w.orderSigns(), await leverageActions(acct)]).toEqual([2, 3, 1]);                                  // one signal per bar; leverage was set once
    expect(await a.pass()).toBe('waiting for the next bar');

    // bar 3: flat — a full close is never blocked
    expect(await a.nextBar({ BTC: 0 })).toBe('1 order(s)');
    expect(pos(w)).toBe('0');
    expect(w.signer.status().venueMandates[0]).toMatchObject({ today: { orders: 2, reduceOnly: 2 } });
    expect((await w.svc.reconcile(acct)).divergence).toBeNull();                                                          // the agent's orders are the wallet's own
    expect((await a.row()).state).toBe('LIVE');
    // the leverage setting changed on the venue (someone else): brought back before the next order that adds exposure
    w.t.user(w.ACCOUNT).leverage.set('BTC', { type: 'cross', value: 3 });
    expect(await a.nextBar({ BTC: 0.5 })).toBe('1 order(s)');
    expect([await leverageActions(acct), w.t.user(w.ACCOUNT).leverage.get('BTC')!.value]).toEqual([2, 1]);
  });

  // V11.2 — this test used to show an IOC order partly filled by a thin book. The unified risk engine now judges every agent
  // order BEFORE the signer: a book that cannot fill the order inside its slippage bound is a refusal (`slippage`), recorded
  // as a REJECTED unified order — nothing is signed, nothing is chased inside the bar, and the next bar plans from the venue's
  // real position. (A partial fill the venue reports is still read from the venue: perp-gateway.ts `toPlace`, execution-unit tests.)
  it('a book too thin for the order: refused by the risk engine before anything is signed; the next bar plans from the real position', async () => {
    const { w, a, acct } = await liveAgent();
    w.t.asks = [['70005', '0.003']];                                                                                      // a thin book: it could fill 0.003 of 0.00714
    expect(await a.tick()).toBe('1 order(s) not sent');
    expect([pos(w), w.orderSigns(), (await orders(acct)).length]).toEqual(['0', 0, 0]);
    expect(await statuses(a)).toEqual([['buy refused:risk_denied']]);
    const [u] = await sql`select state, reason, reject_code, principal_kind, principal_id, mode, origin, record->>'detail' as detail from orders where principal_id = ${a.id}`;
    expect(u).toMatchObject({ state: 'REJECTED', reason: 'RISK_DENIED', reject_code: 'risk_denied', principal_kind: 'agent', mode: 'live', origin: 'agent' });
    expect(u.detail).toMatch(/slippage: the supplied book fills only 0\.003 of 0\.00714/);
    expect(await a.pass()).toBe('waiting for the next bar');                                                              // not chased inside the bar
    w.t.asks = [['70005', '1']];
    expect(await a.nextBar({ BTC: 0.5 })).toBe('1 order(s)');
    expect((await orders(acct))[0]).toMatchObject({ side: 'buy', state: 'filled' });
    expect((await orders(acct))[0].size).toBe(pos(w));                                                                    // the whole target: the venue's position was 0
    expect(w.orderSigns()).toBe(1);
  });

  it('a venue refusal is a refusal, not a retry: nothing more on that bar', async () => {
    const { w, a, acct } = await liveAgent();
    const back = noLiquidity(w);                                                                                          // nothing to match: the venue refuses the IOC order
    expect(await a.tick()).toBe('1 order(s) not sent');
    expect((await orders(acct))[0]).toMatchObject({ state: 'rejected', final: true });
    expect((await orders(acct))[0].reject_reason).toMatch(/refused by the venue.*could not immediately match/i);
    expect(await statuses(a)).toEqual([['buy refused:venue_rejected']]);
    for (let k = 0; k < 3; k++) expect(await a.pass()).toBe('waiting for the next bar');
    expect([w.orderSigns(), w.t.exchangeCalls('order'), pos(w)]).toEqual([1, 1, '0']);
    expect((await logs(a.id)).filter((l) => l.title.startsWith('Order refused'))).toHaveLength(1);                        // said once
    back();
    expect(await a.nextBar({ BTC: 0.5 })).toBe('1 order(s)');
    expect(pos(w)).toBe('0.00714');
  });

  it('`unknown`: no further order on that instrument until the venue resolves it — to filled, or to "never placed"', async () => {
    const { w, a, acct } = await liveAgent();
    await a.tick();                                                                                                       // long (and the leverage is set)
    // the answer is lost AFTER the venue took the order, and the venue cannot be asked right now
    w.t.fault = 'lost_after'; w.faults.info = 'orderStatus';
    expect(await a.nextBar({ BTC: 0 })).toBe('0 order(s), 1 waiting for the next pass');
    expect((await orders(acct))[1]).toMatchObject({ side: 'sell', reduce_only: true, state: 'unknown', final: false });
    expect(await statuses(a)).toEqual([['buy filled'], ['sell RO deferred:live_unknown_pending']]);
    expect(await a.tick()).toBe('0 order(s), 1 waiting for the next pass');                                               // still unknown: nothing is sent again
    expect(w.t.exchangeCalls('order')).toBe(2);
    w.faults.info = null;
    expect(await a.pass()).toBe('portfolio already at target');                                                           // the venue's own record: it had filled — no second close
    expect([(await orders(acct))[1].state, pos(w), w.t.exchangeCalls('order'), w.orderSigns()]).toEqual(['filled', '0', 2, 2]);
    expect((await a.signalRows())[1].status).toBe('done');

    // the request is lost BEFORE the venue saw it: unknown, never re-sent; after the signature's venue expiry it was never placed
    w.t.fault = 'lost_before';
    expect(await a.nextBar({ BTC: 0.5 })).toBe('0 order(s), 1 waiting for the next pass');
    expect((await orders(acct))[2]).toMatchObject({ side: 'buy', state: 'unknown' });
    w.clock.advance(20_000);
    expect(await a.tick()).toBe('0 order(s), 1 waiting for the next pass');
    expect(await a.pass()).toBe('1 order(s) not sent');                                                                   // > 35 s: final
    expect((await orders(acct))[2]).toMatchObject({ state: 'rejected', final: true });
    expect((await statuses(a))[2]).toEqual(['buy refused:never_placed']);
    expect([pos(w), w.t.exchangeCalls('order'), w.orderSigns()]).toEqual(['0', 3, 3]);
    expect(await a.pass()).toBe('waiting for the next bar');
    expect(await a.nextBar({ BTC: 0.5 })).toBe('1 order(s)');                                                             // the next bar trades normally
  });

  it('restart between signing and reconciliation: the stored order is looked up on the venue, never placed twice', async () => {
    const { w, a, acct } = await liveAgent();
    await a.tick();
    const before = [w.t.exchangeCalls('order'), w.orderSigns()];
    // the process died after the order was signed and sent, before it was reconciled and before the bar was marked complete
    await sql`update deriv_orders set state = 'signed', status = 'pending', final = false, filled = 0, avg_fill_price = null, venue_order_id = null where account_id = ${acct}`;
    await sql`update agents set last_bar = null where id = ${a.id}`;
    await sql`update agent_signals set status = 'decided', orders = null where agent_id = ${a.id}`;
    a.weights = { BTC: -1 };                                                                                              // a strategy that would now answer something else is not asked again
    expect(await a.pass()).toBe('portfolio already at target');
    expect((await orders(acct))[0]).toMatchObject({ state: 'filled', final: true, filled: '0.00714' });
    expect([w.t.exchangeCalls('order'), w.orderSigns(), a.signals, pos(w)]).toEqual([...before, 1, '0.00714']);
    // … and when the venue's positions were not visible either (worst case), the same key answers the same order
    await sql`update agents set last_bar = null where id = ${a.id}`; await sql`update agent_signals set status = 'decided' where agent_id = ${a.id}`;
    const ex = new xl.LivePerpExecutor(w.svc, { accountId: acct, agentId: a.id, strategySha256: a.sha, symbols: ['BTC'], risk: RISK, capital: '1000' });
    const again = await ex.place({ instrument: BTC, side: 'buy', type: 'market', size: '0.00714', price: '70215', triggerPrice: null, reduceOnly: false, tif: 'ioc', clientId: (await orders(acct))[0].client_id }, '2');
    expect(again).toMatchObject({ status: 'placed', idempotent: true, order: { status: 'filled', filled: '0.00714' } });
    expect([w.t.exchangeCalls('order'), w.orderSigns()]).toEqual(before);
  });
});

describe('signer refusals: hold until the next bar, or leave LIVE', () => {
  it('position limit, orders per hour, daily turnover: one refusal per bar, logged once, the agent stays LIVE', async () => {
    const { w, a, acct } = await liveAgent();
    for (const c of ['signer_position_exceeded', 'signer_gross_exceeded', 'signer_orders_hour', 'signer_turnover', 'signer_orders_day', 'signer_price', 'signer_venue_unreachable']) expect(xl.LIVE_EXIT_CODES.has(c)).toBe(false);
    // an order resting on the venue that the wallet did not place: the signer counts it (700) on top of the candidate (≈ 977)
    w.t.foreignOrder(w.ACCOUNT, { px: '60000', sz: '0.01' });
    a.weights = { BTC: 1 };
    expect(await a.tick()).toBe('1 order(s) not sent');
    expect(await statuses(a)).toEqual([['buy refused:signer_position_exceeded']]);
    expect((await orders(acct))[0]).toMatchObject({ state: 'rejected', final: true });
    const signs = w.orderSigns();
    for (let k = 0; k < 4; k++) expect(await a.pass()).toBe('waiting for the next bar');                                  // no storm: the signer is asked once per bar
    expect(w.orderSigns()).toBe(signs);
    expect(await a.nextBar({ BTC: 1 })).toBe('1 order(s) not sent');
    expect(w.orderSigns()).toBe(signs + 1);
    expect((await logs(a.id)).filter((l) => l.title.startsWith('Order refused')).length).toBe(1);                         // the same refusal is not logged again
    expect((await a.row()).state).toBe('LIVE');
    expect((await cyc.liveBlock(await a.row(), a.rt, true)).holds[0]).toMatchObject({ symbol: 'BTC', code: 'signer_position_exceeded', reason: expect.stringMatching(/worst-case BTC position/) });
    w.t.removeOrder(w.ACCOUNT, w.t.openOrders(w.ACCOUNT)[0]!.oid);

    // four orders that add exposure in the hour are the mandate's limit: the fifth is refused by the signer, the agent holds
    const opens = async () => (await orders(acct)).filter((o) => !o.reduce_only && o.state === 'filled').length;
    let side = 1;
    while (await opens() < 4) {
      const r = await a.nextBar({ BTC: 0.9 * side });
      if (/waiting for the next pass/.test(r)) await a.pass();
      side = -side;
    }
    const r5 = await a.nextBar({ BTC: 0.9 * side });
    if (/waiting for the next pass/.test(r5)) expect(await a.pass()).toBe('1 order(s) not sent');
    // V11.2: the trading mandate says four orders an hour, and the API checks it BEFORE the signer is asked (the signer's own
    // hourly count — `signer_orders_hour` — stays behind it as the second line)
    expect((await statuses(a)).at(-1)!.at(-1)).toMatch(/refused:mandate_denied/);
    expect(await opens()).toBe(4);
    expect((await a.row()).state).toBe('LIVE');
    // an hour later the hourly allowance is back: the agent trades again
    w.clock.advance(H);
    const before = await opens();
    const r6 = await a.nextBar({ BTC: 0.9 * side });
    if (/waiting for the next pass/.test(r6)) await a.pass();
    expect(await opens()).toBe(before + 1);
    // V11.2: the signer's daily-turnover bound is COMPILED from the trading mandate (order limit × orders per day) — no longer
    // max(order, gross × N) of the agent's own derivation; the mandate's frequency (above) is what binds first
    const vm = w.signer.status().venueMandates[0]! as unknown as { today: { turnover: string } };
    const [dm] = await sql`select mandate from deriv_mandates where id = ${(await a.row()).perp.live.mandateId}`;
    expect(dm.mandate.maxDailyTurnover).toBe(D.str(D.mul(D.from(dm.mandate.maxOrderNotional), D.from(String(dm.mandate.maxOrdersPerDay)))));
    expect(Number(vm.today.turnover)).toBeLessThanOrEqual(Number(dm.mandate.maxDailyTurnover));
    expect((await a.row()).state).toBe('LIVE');
  });

  it('the floor: no exposure is added well before the signer refuses; a loss limit takes the agent out', async () => {
    const { w, a, acct } = await liveAgent({ risk: { maxDailyLossPct: 10, maxTotalLossPct: 10 } });                       // floor 900, guard 925
    await a.tick();
    w.t.user(w.ACCOUNT).usdc = '920';                                                                                     // account value ≈ 920: above the floor and the loss limit, inside the guard
    const signs = w.orderSigns();
    expect(await a.nextBar({ BTC: 1 })).toBe('1 order(s) not sent');
    expect((await statuses(a))[1]).toEqual(['buy refused:floor_guard']);
    expect([w.orderSigns(), (await a.row()).state]).toEqual([signs, 'LIVE']);                                             // the signer was not even asked
    expect(await a.nextBar({ BTC: 0.2 })).toBe('1 order(s)');                                                             // reducing still passes
    // below the total-loss limit (= the mandate's floor): the mandate is revoked, the position closed, the agent stopped
    w.t.user(w.ACCOUNT).usdc = '890';
    expect(await a.pass()).toBe('stopped');
    const row = await a.row();
    expect(row).toMatchObject({ state: 'STOPPED', live_account_id: null, perp: { live: { exit: { code: 'loss_limit' } } } });
    expect(row.stop_reason).toMatch(/total loss limit reached.*every position was closed with reduce-only orders/);
    expect(pos(w)).toBe('0');
    expect(w.signer.status().venueMandates[0]).toMatchObject({ revoked: true, phase: 'wind_down' });
    expect((await w.svc.get(acct)).modes).toEqual(['MANUAL_LIVE']);
  });

  it('refusals that mean the mandate is over: the agent leaves LIVE, closes with reduce-only orders if the signer still signs, and stops with the reason', async () => {
    // the mandate was revoked on the signer (the API does not know): the signer refuses new exposure, the wind-down still signs the close
    {
      const { w, a } = await liveAgent();
      await a.tick();
      await w.signer.venueMandateRevoke((await a.row()).perp.live.mandateId);
      expect(await a.nextBar({ BTC: 1 })).toBe('stopped');
      const row = await a.row();
      expect(row).toMatchObject({ state: 'STOPPED', mode: 'LIVE', live_account_id: null, perp: { live: { exit: { code: 'signer_wind_down' } } } });
      expect(row.stop_reason).toMatch(/the signer only signs reduce-only orders.*every position was closed with reduce-only orders/);
      expect(pos(w)).toBe('0');
      expect(await a.pass()).toBe('idle');
    }
    // the signer's emergency halt: reduce-only orders are still signed
    {
      const { w, a } = await liveAgent();
      await a.tick();
      w.signer.halt();
      expect(await a.nextBar({ BTC: 1 })).toBe('stopped');
      expect(await a.row()).toMatchObject({ state: 'STOPPED', perp: { live: { exit: { code: 'signer_halted' } } } });
      expect(pos(w)).toBe('0');
    }
    // the venue authorization is gone on the signer: nothing can be signed — the agent stops and SAYS that the position remains
    {
      const { w, a, acct } = await liveAgent();
      await a.tick();
      await w.signer.venueRevoke((await w.svc.get(acct)).authorization!.id);
      expect(await a.nextBar({ BTC: 1 })).toBe('stopped');
      const row = await a.row();
      expect(row.perp.live.exit.code).toMatch(/^signer_(revoked|no_authorization)$/);
      expect(row.stop_reason).toMatch(/1 position\(s\) REMAIN OPEN on the venue account \(long 0\.00714 BTC\).*close them in the Futures terminal with your passkey/);
      expect(pos(w)).toBe('0.00714');
      expect(row).toMatchObject({ state: 'STOPPED', live_account_id: null });
    }
    // the mandate expires: no new exposure from that instant; the wind-down closes
    {
      const { w, a } = await liveAgent();
      await a.tick();
      w.clock.advance(29 * 86_400_000 + 60_000);
      w.t.setMid(70_000);
      a.bar = Math.floor(w.clock.now() / H) * H - H;
      expect(await a.tick()).toBe('stopped');
      expect(await a.row()).toMatchObject({ state: 'STOPPED', perp: { live: { exit: { code: 'mandate_expired' } } } });
      expect(pos(w)).toBe('0');
    }
  });

  it('owner halt, divergence, a manual order, the server lock: each takes the agent out of LIVE with its own reason', async () => {
    {
      const { w, a, acct } = await liveAgent();
      await a.tick();
      await w.svc.halt(acct, { reason: 'test' });
      expect(await a.pass()).toBe('stopped');
      const row = await a.row();
      expect(row).toMatchObject({ state: 'STOPPED', perp: { live: { exit: { code: 'halted' } } } });
      expect(row.stop_reason).toMatch(/trading was halted on the venue account — halted by the owner: test.*closed with reduce-only orders/);
      expect(pos(w)).toBe('0');
    }
    {
      // a position the wallet did not create (a trade from the venue's own interface): seen by the reconciliation worker on two passes
      const { w, a, acct } = await liveAgent();
      await a.tick();
      w.t.forcePosition(w.ACCOUNT, 'BTC', '0.012');
      await w.svc.reconcile(acct); w.next(); await w.svc.reconcile(acct);
      expect(await a.pass()).toBe('stopped');
      const row = await a.row();
      expect(row.perp.live.exit).toMatchObject({ code: 'divergence' });
      expect(row.stop_reason).toMatch(/the venue's state and the wallet's records differ/);
      expect(pos(w)).toBe('0');                                                                                           // closed in full, with a reduce-only order under the wind-down
    }
    {
      // the owner places a manual order (passkey) on the account while the agent is live
      const { w, a, acct } = await liveAgent();
      await a.tick();
      w.next();
      const prop = await w.svc.propose(acct, pp.OrderBodySchema.parse({ instrument: BTC, side: 'buy', type: 'limit', size: '0.001', price: '69000' }), 'manual-order-key-1');
      await a.tick();
      expect((await a.row()).state).toBe('LIVE');                                                                         // a proposal that is not approved is nothing
      await w.svc.approveOrder(acct, 'manual-order-key-1', w.pk.assert(w.b64(prop.hash!)) as never);
      expect(await a.pass()).toBe('stopped');
      const row = await a.row();
      expect(row.perp.live.exit).toMatchObject({ code: 'manual_order' });
      expect(row.stop_reason).toMatch(/a manual order was placed on the venue account while the agent was live/);
      expect([pos(w), w.t.openOrders(w.ACCOUNT).length]).toEqual(['0', 0]);                                               // the resting manual order was cancelled with the revocation
    }
    {
      // mainnet (the fake): both server settings on, then autonomous trading is switched off on the server
      const w = await liveWorld(), a = await agent(w);
      w.flags.mainnet = true; w.flags.mandateMainnet = true;
      const acct = await w.authorise('mainnet');
      await goLive(w, a, acct);
      expect(await a.tick()).toBe('1 order(s)');
      expect(w.m.user(w.ACCOUNT).positions.get('BTC')?.szi).toBe('0.00714');
      w.flags.mandateMainnet = false;
      expect(await a.pass()).toBe('stopped');
      const row = await a.row();
      expect(row.perp.live.exit).toMatchObject({ code: 'mandate_mainnet_disabled' });
      // V11 (B-02): the lock stops new exposure, not the agent's way out — before, the position was left open ("1 position(s) REMAIN OPEN")
      expect(row.stop_reason).toMatch(/autonomous \(mandate\) trading on mainnet is switched off on the server.*every position was closed with reduce-only orders/);
      expect(w.m.user(w.ACCOUNT).positions.get('BTC')?.szi ?? '0').toMatch(/^0(\.0+)?$/);
      expect(w.m.exchangeCalls('order')).toBe(2);                                                                         // the entry, and the reduce-only close sent with the lock closed
      expect(w.signer.status().venueMandates[0]).toMatchObject({ revoked: true });                                        // revoked on the signer all the same
      expect(w.t.exchangeCalls()).toBe(0);
    }
  });
});

describe('stop, pause, wind-down', () => {
  it('"stop": no passkey — the mandate is revoked, the engine closes with reduce-only orders, in parts when the book is thin, then STOPPED', async () => {
    const { w, a, acct } = await liveAgent();
    a.weights = { BTC: 1 };
    await a.tick();
    expect(pos(w)).toBe('0.01395');
    w.next();
    w.t.bids = [['69995', '0.005']];                                                                                      // only part of the close can fill now
    const stale = await a.row();                                                                                          // a pass that read the agent just before the owner stopped it
    const r = await cyc.stopLive(await a.row(), a.rt, 'fr');
    expect(r.result).toMatch(/stopping: 1 position\(s\) still open \(long 0\.00895 BTC\)/);
    expect(r.windDown).toMatchObject({ openPositions: 1, openOrders: 0 });
    expect(r.windDown.text).toMatch(/Pendant 24 heures/);
    expect(r.windDown.until).toBe(w.clock.now() + 86_400_000);
    let row = await a.row();
    expect(row).toMatchObject({ state: 'STOPPING', mode: 'LIVE', live_account_id: acct, stop_reason: 'stopped by the owner', perp: { live: { exit: { code: 'owner_stop' } } } });
    expect(w.signer.status().venueMandates[0]).toMatchObject({ revoked: true, phase: 'wind_down' });
    expect(w.signs).toHaveLength(0);                                                                                      // no passkey anywhere
    // the pass that was already running finishes with its stale view: it cannot undo the stop, change its reason or add exposure
    const signsBefore = w.orderSigns();
    expect(await cyc.tickLivePerpAgent(stale, a.rt)).toMatch(/^stopping: /);
    const ex = new xl.LivePerpExecutor(w.svc, { accountId: acct, agentId: a.id, strategySha256: a.sha, symbols: ['BTC'], risk: RISK, capital: '1000' });
    expect(await eng.tickPerpAgent(stale, { ...a.rt.deps, executor: () => ex }, { capital: '1000', onBreach: async () => 'breach' })).toBe('waiting for the next bar');
    expect(await a.row()).toMatchObject({ state: 'STOPPING', stop_reason: 'stopped by the owner', perp: { live: { exit: { code: 'owner_stop' } } } });
    expect(w.orderSigns()).toBe(signsBefore);
    // a new signal that wants exposure changes nothing: a stopping agent only closes
    w.t.bids = [['69995', '1']];
    expect(await a.nextBar({ BTC: 1 })).toBe('stopped');
    row = await a.row();
    expect(row).toMatchObject({ state: 'STOPPED', live_account_id: null, stop_reason: 'stopped by the owner; every position was closed with reduce-only orders' });
    expect([pos(w), a.signals]).toEqual(['0', 1]);
    expect((await orders(acct)).slice(1).every((o) => o.reduce_only && o.origin === 'mandate')).toBe(true);
    expect(await refusal(cyc.stopLive(row, a.rt, 'en'))).toMatchObject({ code: 'bad_state' });
    // the account is free again; the agent can return to simulation or go live again with a NEW mandate
    expect((await cyc.liveReadiness(row, a.rt, { locale: 'en' })).next).toBe('mandate');
    await goLive(w, a, acct);
    expect(await a.row()).toMatchObject({ state: 'LIVE', perp: { live: { exit: null } } });
  });

  it('a close larger than the mandate\'s notional per order is cut, not refused; when the wind-down ends with a position open, the agent says so', async () => {
    const { w, a } = await liveAgent();
    a.weights = { BTC: 1 };
    await a.tick();                                                                                                       // long 0.01395 ≈ 977
    w.next(); w.t.setMid(72_000); w.px.BTC = 72_000;                                                                      // now worth 1 004: above the 1 000 per order
    w.t.bids = [['71995', '1']];
    const r = await cyc.stopLive(await a.row(), a.rt, 'en');
    expect(r.result).toMatch(/stopping: 1 position\(s\) still open/);
    const left = pos(w);
    expect(D.gt(D.from(left), D.zero) && D.lt(D.from(left), D.from('0.001'))).toBe(true);                                 // 99 % of the per-order bound went in the first order
    // nothing to match any more: the venue refuses every close; retried at most every five minutes, then the wind-down ends
    noLiquidity(w);
    const before = w.orderSigns();
    expect(await a.pass()).toMatch(/stopping: 1 position\(s\) still open/);
    expect(await a.pass()).toMatch(/next closing attempt at/);
    expect(await a.pass()).toMatch(/next closing attempt at/);
    expect(w.orderSigns()).toBe(before + 1);
    w.clock.advance(86_400_000);
    expect(await a.tick()).toBe('stopped');
    const row = await a.row();
    expect(row.stop_reason).toMatch(/stopped by the owner; 1 position\(s\) REMAIN OPEN on the venue account \(long 0\.000\d+ BTC\) and the signer no longer signs for this mandate.*close them in the Futures terminal with your passkey/);
    expect(row).toMatchObject({ state: 'STOPPED', live_account_id: null });
  });

  it('"pause": no new exposure and no signal, positions KEPT, loss limits still watched; resume trades again', async () => {
    const { w, a } = await liveAgent();
    await a.tick();
    expect(await cyc.pauseLive(await a.row())).toMatchObject({ state: 'PAUSED', mode: 'LIVE' });
    const signs = w.orderSigns();
    expect(await a.nextBar({ BTC: -0.5 })).toMatch(/^paused: positions kept, no new exposure/);
    expect([pos(w), w.orderSigns(), a.signals]).toEqual(['0.00714', signs, 1]);
    expect((await logs(a.id)).find((l) => l.title === 'Paused by the owner')!.body).toMatch(/Positions are KEPT/);
    expect(w.signer.status().venueMandates[0]).toMatchObject({ phase: 'active' });                                        // a pause does not revoke
    expect((await cyc.resumeLive(await a.row(), a.rt)).state).toBe('LIVE');
    expect(await a.tick()).toMatch(/1 order\(s\), 1 waiting/);                                                            // the bar that closed during the pause is decided now
    // a paused agent is still protected: a loss limit closes and stops
    await cyc.pauseLive(await a.row());
    w.t.user(w.ACCOUNT).usdc = '850';
    expect(await a.pass()).toBe('stopped');
    expect(await a.row()).toMatchObject({ state: 'STOPPED', perp: { live: { exit: { code: 'loss_limit' } } } });
    expect(await refusal(cyc.resumeLive(await a.row(), a.rt))).toMatchObject({ code: 'bad_state' });
  });
});

describe('the engine pass: paper agents are unaffected', () => {
  it('a paper agent and a live agent in the same pass: the paper one never reaches the signer or the venue account', async () => {
    const { w, a, acct } = await liveAgent();
    // a paper agent (state PAPER_TRADING) with a fake paper executor, as in perp-agent.test.ts
    const paper = await agent(w, { name: 'paper' }), placed: string[] = [];
    await sql`update agents set state = 'PAPER_TRADING' where id = ${paper.id}`;
    const fakeExec = { account: async () => ({ state: { venue: 'hyperliquid', account: 'paper', equity: '1000', collateral: '1000', freeCollateral: '1000', marginUsed: '0', maintenanceMargin: null, withdrawable: null, ts: 0, source: 'paper' },
      policy: eng.perpPolicy(['BTC'], '1000', RISK), events: [] }), positions: async () => [], place: async (o: any) => { placed.push(o.clientId); return { status: 'refused', code: 'test', reason: 'paper test' }; } };
    const inst = await w.svc.deps.venues.get('testnet').instrument(BTC);
    const rt = { ...a.rt, deps: { ...a.rt.deps, executor: () => fakeExec, market: async () => ({ inst, ...(await w.svc.deps.venues.get('testnet').market(inst)) }) } } as unknown as import('../src/agents/perp-live.ts').PerpRuntime;
    const out = await pl.perpEnginePass(rt, w.clock.now());
    expect(out[a.id]).toBe('1 order(s)');
    expect(out[paper.id]).toBe('1 order(s) not sent');
    // V11.2: a paper order is an order of the unified order service under the agent's PAPER trading mandate. This paper agent was
    // put in PAPER_TRADING by hand, without one: its order is refused before any executor — and nothing of it reaches the signer
    expect(placed).toHaveLength(0);
    expect([w.orderSigns(), (await orders(acct)).length]).toEqual([1, 1]);                                                // the signer and the venue account saw the live agent's order only
    expect(await eng.tickPerpAgent(await a.row(), rt.deps)).toBe('idle');                                                 // the paper entry point never runs a live agent
    expect(await eng.tickPerpAgent({ ...(await paper.row()), mode: 'LIVE' }, a.rt.deps)).toBe('idle');
    expect(await cyc.tickLivePerpAgent(await paper.row(), a.rt)).toBe('idle');                                            // and the live one never runs a paper agent
  });
});

describe('through the API routes: the owner\'s session, CSRF, no route that places an order', () => {
  it('create → checklist → prepare → approve (one passkey) → page → pause/resume → stop → back to simulation', async () => {
    await reset();
    const { randomBytes } = await import('node:crypto'), { fixtureVenues } = await import('./derivatives-helpers.ts'), mod = await import('../src/derivatives/index.ts');
    const w = await liveWorld(), ORIGIN = 'https://wallet.test';
    const dv = mod.createDerivatives({ registry: mod.createRegistry(fixtureVenues(w.clock as never).adapters, w.clock.now), now: w.clock.now });
    const app = await (await import('../src/server.ts')).buildServer({ derivatives: dv, live: w.svc });
    await (await import('./derivatives-helpers.ts')).openLiveLimits(sql);   // V11: the owner's limits of the unified risk engine (absent = every new live order is denied)
    const script = { bar: Math.floor(w.clock.now() / H) * H - H, weights: { BTC: 0.5 } as Record<string, number> };
    const rt = pl.createPerpRuntime(dv, { live: w.svc, gate: async () => ({ bar: script.bar, data: {} }), signal: async () => ({ weights: script.weights, maxLeverage: 2, maxGrossExposure: 2 }) });
    pl.setPerpRuntime(rt);
    try {
      const token = randomBytes(32).toString('base64url');
      await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
      const cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
      const api = async (method: 'GET' | 'POST', url: string, body?: unknown, auth = true) => {
        const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(auth ? { cookie } : {}), ...(method === 'POST' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
        return { status: r.statusCode, json: r.json() as any };
      };
      const a = (await api('POST', '/agents', { kind: 'perp', name: 'Routes live', instruments: ['BTC'], interval: '1h', capitalUsdc: '1000', risk: RISK })).json;
      expect(a).toMatchObject({ kind: 'perp', mode: 'PAPER', simulation: true });
      expect((await api('GET', `/agents/${a.id}/perp/live`, undefined, false)).status).toBe(401);                         // the owner's session, like every route
      expect((await api('GET', `/agents/${a.id}/perp/live?locale=fr`)).json).toMatchObject({ next: 'strategy', locale: 'fr' });
      const sv = randomUUID(), sha = 'ab'.repeat(32);
      await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${a.id}, 'fixed_perp', '1', ${sha}, 'strategies/fixed_perp/1', ${sql.json({ kind: 'perp', lookback: 10, max_leverage: 2, max_gross_exposure: 2 })}, 'approved', ${sql.json({})})`;
      await sql`update agents set strategy_version_id = ${sv}, state = 'AWAITING_APPROVAL' where id = ${a.id}`;
      const acct = await w.authorise();
      expect((await api('GET', `/agents/${a.id}/perp/live?account=${acct}&days=5`)).json).toMatchObject({ next: 'mandate', proposal: { days: 5, maxDays: 29 } });
      expect((await api('POST', `/agents/${a.id}/perp/live/prepare`, { accountId: acct, locale: 'fr', capitalUsdc: '5' })).status).toBe(400);   // nothing but the account, the duration and the language is chosen
      const prep = (await api('POST', `/agents/${a.id}/perp/live/prepare`, { accountId: acct, locale: 'fr' })).json;
      expect(prep).toMatchObject({ locale: 'fr', mandate: { agentId: a.id, strategySha256: sha }, proposal: { capital: '1000' } });
      expect((await api('POST', `/agents/${a.id}/perp/live/approve`, { accountId: acct, assertion: w.pk.assert(w.b64(prep.hash)), acknowledged: false })).status).toBe(400);
      const live = await api('POST', `/agents/${a.id}/perp/live/approve`, { accountId: acct, assertion: w.pk.assert(w.b64(prep.hash)), acknowledged: true });
      expect(live.json).toMatchObject({ state: 'LIVE', mode: 'LIVE', simulation: false, execution: { kind: 'live', network: 'testnet' },
        live: { available: true, active: true, accountId: acct, network: 'testnet', capital: '1000', account: { id: acct, mandate: { phase: 'active' } }, signer: { phase: 'active' } } });
      expect(live.json.execution.note).toMatch(/test network: the money is not real/);
      expect((await api('GET', '/agents')).json.agents.find((x: any) => x.id === a.id)).toMatchObject({ mode: 'LIVE', simulation: false, state: 'LIVE', liveNetwork: 'testnet' });
      // the engine pass (the worker's): an order on the venue account, visible on the page as the venue reports it
      expect((await pl.perpEnginePass(rt, w.clock.now()))[a.id]).toBe('1 order(s)');
      const det = (await api('GET', `/agents/${a.id}`)).json;
      expect(det.live.account.venueState).toMatchObject({ source: 'venue', positions: [{ instrument: BTC, side: 'long', size: '0.00714', source: 'venue' }] });
      expect(det.live.account.orders[0]).toMatchObject({ origin: 'mandate', state: 'filled' });
      expect(det.live.signer.today).toMatchObject({ orders: 1 });
      // what a live agent refuses: limits, the paper flatten, a return to simulation — and there is no route that places an order
      expect((await api('POST', `/agents/${a.id}/perp/risk`, { risk: RISK })).json).toMatchObject({ error: 'bad_state' });
      expect((await api('POST', `/agents/${a.id}/perp/flatten`)).json).toMatchObject({ error: 'bad_state' });
      expect((await api('POST', `/agents/${a.id}/mode`, { mode: 'PAPER' })).json).toMatchObject({ error: 'bad_state' });
      for (const r of ['orders', 'order', 'place']) expect((await api('POST', `/agents/${a.id}/perp/live/${r}`, {})).status).toBe(404);
      expect((await api('POST', `/agents/${a.id}/perp/live/pause`, {})).json).toMatchObject({ state: 'PAUSED', mode: 'LIVE', live: { paused: true, active: true } });
      expect((await api('POST', `/agents/${a.id}/perp/live/resume`, {})).json).toMatchObject({ state: 'LIVE', live: { paused: false } });
      w.next();
      const stop = (await api('POST', `/agents/${a.id}/perp/live/stop`, { locale: 'fr' })).json;
      expect(stop).toMatchObject({ state: 'STOPPED', mode: 'LIVE', result: 'stopped', live: { active: false, exit: { code: 'owner_stop' } }, stopReason: 'stopped by the owner; every position was closed with reduce-only orders', windDown: { openPositions: 0 } });
      expect(stop.windDown.text).toMatch(/Pendant 24 heures/);
      expect(w.signs).toHaveLength(0);                                                                                    // pause, resume and stop never asked for the passkey
      expect((await api('POST', `/agents/${a.id}/mode`, { mode: 'PAUSED' })).json).toMatchObject({ mode: 'PAPER', state: 'PAUSED', simulation: true });   // stopped: back to simulation
      expect((await api('GET', `/agents/${a.id}/perp/live?account=${acct}`)).json).toMatchObject({ next: 'mandate', steps: { mandate: { ok: false } } });
    } finally { pl.setPerpRuntime(null); app.server.closeAllConnections?.(); await app.close(); }
  });
});

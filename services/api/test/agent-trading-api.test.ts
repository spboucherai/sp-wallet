// V11 agents through the REAL server: the trading API with a real API key (passkey-approved, no mandate bound) and the owner's
// routes of the agent panel. Fixture-backed venues (recorded answers), a real signer process, own database, no network, and no
// laboratory process (SPW_RESEARCH_DIR points at an empty directory: no strategy is installed — which is itself a case).
//   create from a template → backtest JOB → start paper → signals from recorded data → mode-scoped reads → pause → stop
//   LIVE: refused for a family that cannot go live, refused without an owner-approved mandate (perp and spot), never approvable
//   scopes, idempotent replays, what a key can never do, the risk-management agent end to end, webhooks, the kill switch
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { Clock, fixtureVenues, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer', A = '/api/v1/agents';
const owner = new TestPasskey(RP, ORIGIN);
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server;
let rt: import('../src/agent-runtime/scheduler.ts').AgentRuntime;
const events: { event: string; data: any }[] = [];
let ipSeq = 0;
interface Res { status: number; json: any; headers: Record<string, any> }
async function call(method: string, path: string, o: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`; else { headers.cookie = cookie; if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; } }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && path.startsWith(T) && !headers['idempotency-key']) headers['idempotency-key'] = `test-${randomUUID()}`;
  const ip = path.startsWith(DEV) ? `10.201.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), headers: r.headers };
}
async function newKey(scopes: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'agents key', scopes, expiresInDays: 30, rateLimitPerMin: 600, ...extra } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: owner.assert(Buffer.from(p.json.options.challenge, 'base64url')) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return c.json.secret;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MM = { quoteSizeUsd: '50', minHalfSpreadBps: '0.5', volMultiplier: '0', skewBps: '1', maxInventoryUsd: '250', volWindow: 30, decisionEveryMs: 1000 };
let KEY = '', READER = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-agents-api-'));
  mkdirSync(join(dir, 'empty-lab', 'strategies'), { recursive: true });
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('agent_trading_api');
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data'), SPW_RESEARCH_DIR: join(dir, 'empty-lab') });
  delete process.env.SPW_API_KEY_PEPPER;
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = owner.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  const deriv = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: deriv });
  // the agent runtime, bound as main.ts binds it (seam gateway, local kill switch, webhook emitter) — its loops are driven by hand here
  const bindings = await import('../src/agents/runtime-bindings.ts'), sched = await import('../src/agent-runtime/scheduler.ts');
  rt = bindings.bindAgentRuntime({ market: { series: async () => [], assertFresh: async () => {} }, stream: false, emit: async (event, data) => { events.push({ event, data }); },
    runtime: { workerId: 'test-worker', stream: { snapshotMs: 1000, equityEveryMs: 1000 } } });
  // …with the production feed (the derivatives data service) over the fixture-backed Hyperliquid adapter and its scripted stream
  rt = sched.createAgentRuntime({ ...bindings.runtimeHandlers({ market: { series: async () => [], assertFresh: async () => {} }, stream: false, emit: async (event, data) => { events.push({ event, data }); } }), feed: sched.derivFeed(deriv.data as never) },
    { workerId: 'test-worker', stream: { snapshotMs: 1000, equityEveryMs: 1000 } });   // queue and leases on the real clock; the venues and the stream engine on the fixtures' clock
  KEY = await newKey(['agents:read', 'agents:manage', 'strategies:read', 'strategies:manage']);
  READER = await newKey(['agents:read', 'strategies:read']);
});
afterAll(async () => { rt?.stream?.close(); app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

let mm = '';
describe('trading API — an agent from a template, with a key that holds no mandate', () => {
  it('GET /agents/templates: the seven agents; a bar template whose laboratory strategy is not installed says so — nothing is substituted', async () => {
    const r = await call('GET', `${T}/agents/templates`, { key: READER });
    expect(r.status).toBe(200);
    expect(r.json.templates.map((t: any) => [t.id, t.engine, t.strategyInstalled])).toEqual([['stat-arb', 'bar', false], ['funding-arb', 'stream', true], ['market-making', 'stream', true], ['momentum', 'bar', false], ['mean-reversion', 'bar', false],
      ['cross-exchange', 'stream', true], ['risk-manager', 'supervisor', true]]);
    const by = Object.fromEntries(r.json.templates.map((t: any) => [t.id, t]));
    expect(by.momentum.installed).toEqual([]); expect(by.momentum.strategyNames).toEqual(['momentum_xs_perp', 'ts_momentum_perp', 'ma_trend_perp', 'vol_breakout_perp']);
    expect(by['market-making'].modes).toEqual(['research', 'paper']); expect(by['cross-exchange'].liveReason).toBe('mode réel indisponible : une seule plateforme autorise l\'exécution sous mandat');
    expect(by['market-making'].rule).toMatchObject({ name: 'spread_inventory', version: '1' }); expect(by['market-making'].labBacktest).toEqual({ wanted: ['market_making_as'], installed: [] });
    const refused = await call('POST', `${T}/agents`, { key: KEY, body: { template: 'momentum', name: 'Momentum' } });
    expect([refused.status, refused.json.error]).toEqual([409, 'strategy_not_installed']); expect(refused.json.message).toMatch(/momentum_xs_perp, ts_momentum_perp/);
    expect((await sql`select count(*)::int as n from agents`)[0].n).toBe(0);
  });

  it('create → the agent exists in RESEARCH, stopped: family, hash-pinned rule, configuration version 1, limits, no mandate', async () => {
    const r = await call('POST', `${T}/agents`, { key: KEY, body: { template: 'market-making', name: 'MM via API', venues: ['hyperliquid'], universe: ['BTC'], capitalUsdc: '1000', config: MM, risk: { maxDataAgeMs: 5000 } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    mm = r.json.agent.id;
    expect(r.json.agent).toMatchObject({ kind: 'stream', family: 'market_making', engine: 'stream', state: 'stopped', mode: 'research', configVersion: 1, capitalUsd: '1000', mandate: null, live: { capable: false, code: 'family_not_live' } });
    expect(r.json.agent.strategy).toMatchObject({ name: 'spread_inventory', kind: 'rule' }); expect(r.json.agent.riskLimits).toMatchObject({ maxPositionUsd: 500, maxDataAgeMs: 5000 });
    expect((await sql`select actor from audit_events where type = 'agent.created' order by seq desc limit 1`)[0].actor).toMatch(/^key:/);
    const list = await call('GET', `${T}/agents`, { key: READER });
    expect(list.json.agents.map((a: any) => [a.id, a.kind, a.family, a.lifecycle, a.tradingMode, a.state, a.mode])).toEqual([[mm, 'stream', 'market_making', 'stopped', 'research', 'CREATED', 'RESEARCH']]);
    const one = await call('GET', `${T}/agents/${mm}`, { key: READER });
    expect(one.json.agent.backtests).toMatchObject({ label: 'backtest', recorded: null }); expect(one.json.mandateDraft).toMatchObject({ available: false, code: 'family_not_live' });
  });

  it('backtest → an asynchronous JOB with an id and a status; its result is a BACKTEST report, labelled, with its warnings', async () => {
    const r = await call('POST', `${T}/agents/${mm}/backtest`, { key: KEY, body: { hours: 1 } });
    expect([r.status, r.json.label, r.json.job.status, r.json.job.kind]).toEqual([200, 'backtest', 'queued', 'backtest']);
    const again = await call('POST', `${T}/agents/${mm}/backtest`, { key: KEY, body: { hours: 1 } });
    expect(again.json.job.id).toBe(r.json.job.id);                              // one pending backtest per agent
    expect((await call('GET', `${T}/jobs/${r.json.job.id}`, { key: READER })).json.job.status).toBe('queued');
    await rt.jobsPass();
    const done = await call('GET', `${T}/jobs/${r.json.job.id}`, { key: READER });
    expect(done.json.job).toMatchObject({ status: 'done', attempts: 1, result: { kind: 'recorded_replay', label: 'backtest', snapshots: 0 } });
    expect(done.json.job.result.warnings.join(' ')).toMatch(/far too few/);
    const o = await call('GET', `${T}/agents/${mm}`, { key: READER });
    expect(o.json.agent.backtests.recorded).toMatchObject({ kind: 'recorded_replay', label: 'backtest', rule: 'spread_inventory', instruments: ['hyperliquid:BTC'] });
    expect(o.json.agent.backtests.note).toMatch(/not a track record and is never shown as performance/);
    // a backtest is not performance: the performance answers stay empty
    expect((await call('GET', `${T}/agents/${mm}/performance?mode=paper`, { key: READER })).json.points).toBe(0);
    expect((await call('GET', `${T}/jobs/${randomUUID()}`, { key: READER })).status).toBe(404);
  });

  it('start paper → signals and simulated orders appear from the recorded Hyperliquid data; every read answers ONE mode', async () => {
    const s = await call('POST', `${T}/agents/${mm}/start`, { key: KEY, body: { mode: 'paper' } });
    expect([s.status, s.json.agent.state, s.json.agent.mode]).toEqual([200, 'active', 'paper']);
    await rt.streamPass();                                                      // subscribes to the venue's stream
    v.hl.stream.status('connected'); await sleep(60);                           // the data service takes its snapshot: the RECORDED l2Book and asset context of the fixtures
    clock.advance(1100);
    const out = await rt.streamPass();
    expect(out[mm]).toMatch(/^acted: quotes/);
    const sig = await call('GET', `${T}/agents/${mm}/signals?mode=paper`, { key: READER });
    expect(sig.json.mode).toBe('paper');
    expect(sig.json.signals.map((x: any) => [x.mode, x.decision, x.reasonCode, x.configVersion])).toEqual([['paper', 'acted', 'acted', 1], ['paper', 'skipped', 'data_gap', 1]]);
    expect(sig.json.signals[0].strategySha256).toMatch(/^[0-9a-f]{64}$/); expect(sig.json.signals[0].inputsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.json.signals[0].output.bid.price).toBeLessThan(sig.json.signals[0].output.mid); expect(sig.json.signals[0].output.ask.price).toBeGreaterThan(sig.json.signals[0].output.mid);
    const ord = await call('GET', `${T}/agents/${mm}/orders?mode=paper`, { key: READER });
    expect(ord.json.orders.map((o: any) => [o.mode, o.state, o.side, o.instrument, o.source]).sort()).toEqual([['paper', 'SUBMITTED', 'buy', 'hyperliquid:BTC', 'gateway'], ['paper', 'SUBMITTED', 'sell', 'hyperliquid:BTC', 'gateway']]);
    expect(ord.json.orders[0].signalId).toBe(sig.json.signals[0].id);            // signal → order
    const j = await call('GET', `${T}/agents/${mm}/journal?mode=paper`, { key: READER });
    expect(j.json.entries.every((e: any) => e.mode === 'paper')).toBe(true); expect(j.json.entries.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['order', 'state', 'hold']));
    // the same agent's other modes: empty — nothing of the simulation leaks into live, nothing is summed
    for (const what of ['signals', 'orders', 'journal']) { const r = await call('GET', `${T}/agents/${mm}/${what}?mode=live`, { key: READER }); expect([r.json.mode, (r.json.signals ?? r.json.orders ?? r.json.entries).length], what).toEqual(['live', 0]); }
    const perf = await call('GET', `${T}/agents/${mm}/performance`, { key: READER });      // no mode given: the agent's current one, and the answer says which
    expect([perf.json.mode, perf.json.points >= 1]).toEqual(['paper', true]); expect(perf.json.label).toMatch(/^PAPER — simulated/);
    const live = await call('GET', `${T}/agents/${mm}/performance?mode=live`, { key: READER });
    expect([live.json.mode, live.json.points, live.json.equityCurve, live.json.netPnlUsd.value]).toEqual(['live', 0, [], null]);
    expect((await call('GET', `${T}/agents/${mm}/performance?mode=all`, { key: READER })).status).toBe(400);            // there is no "all modes"
    // what the engine consumed was recorded
    expect((await sql`select count(*)::int as n from market_snapshots where venue = 'hyperliquid' and symbol = 'BTC'`)[0].n).toBeGreaterThanOrEqual(1);
  });

  it('LIVE is refused for this family with the reason; pause and stop always work; a replayed call is answered from the record', async () => {
    const live = await call('POST', `${T}/agents/${mm}/start`, { key: KEY, body: { mode: 'live' } });
    expect([live.status, live.json.error]).toEqual([409, 'live_unavailable']); expect(live.json.message).toMatch(/^mode réel indisponible/);
    expect((await call('POST', `${A}/${mm}/start`, { body: { mode: 'live' } })).json.error).toBe('live_unavailable');   // the owner neither: it is not a permission, it does not exist
    const p = await call('POST', `${T}/agents/${mm}/pause`, { key: KEY, body: { reason: 'lunch' } });
    expect([p.status, p.json.agent.state, p.json.agent.pausedFrom]).toEqual([200, 'paused', 'PAPER']);
    expect((await sql`select runtime->'book'->'quotes' as q from agents where id = ${mm}`)[0].q).toEqual([]);
    const idem = { 'idempotency-key': `stop-${randomUUID()}` };
    const s1 = await call('POST', `${T}/agents/${mm}/stop`, { key: KEY, body: { reason: 'done' }, headers: idem });
    const s2 = await call('POST', `${T}/agents/${mm}/stop`, { key: KEY, body: { reason: 'done' }, headers: idem });
    expect([s1.status, s1.json.agent.state, s2.status, s2.headers['idempotent-replay'], s2.json.agent.state]).toEqual([200, 'stopped', 200, 'true', 'stopped']);
    expect((await call('POST', `${T}/agents/${mm}/stop`, { key: KEY, body: {} })).json.agent.state).toBe('stopped');     // stopping a stopped agent is not an error
    expect((await sql`select count(*)::int as n from audit_events where type = 'agent.stop' and data->>'id' = ${mm}`)[0].n).toBe(1);
    expect(events.filter((e) => e.event === 'agent.updated' && e.data.agentId === mm).map((e) => e.data.state)).toEqual(['PAPER_TRADING', 'PAUSED', 'STOPPED']);
  });
});

describe('LIVE needs a mandate the owner approved — and nothing under the trading API can approve one', () => {
  let perp = '', spot = '';
  it('a perp agent created with a key: paper needs a backtest report first; LIVE answers 409 mandate_required; stop is allowed', async () => {
    const c = await call('POST', `${T}/agents`, { key: KEY, body: { kind: 'perp', name: 'Perp via API', universe: ['BTC'], capitalUsdc: '1000' } });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    perp = c.json.agent.id;
    expect(c.json.agent).toMatchObject({ kind: 'perp', state: 'stopped', live: { capable: true } });
    const live = await call('POST', `${T}/agents/${perp}/start`, { key: KEY, body: { mode: 'live' } });
    expect([live.status, live.json.error]).toEqual([409, 'mandate_required']);
    expect(live.json.message).toMatch(/approved by the owner with the passkey/); expect(live.json.message).toMatch(/can never approve one/);
    expect((await call('POST', `${T}/agents/${perp}/start`, { key: KEY, body: { mode: 'paper' } })).json.error).toBe('no_strategy');
    expect((await sql`select state, mode from agents where id = ${perp}`)[0]).toEqual({ state: 'CREATED', mode: 'PAPER' });   // nothing changed
    expect((await call('POST', `${T}/agents/${perp}/stop`, { key: KEY, body: {} })).json.agent.state).toBe('stopped');
    // the mandate draft is READ-only information for the owner's approval surface
    const d = await call('GET', `${A}/${perp}/mandate-draft`);
    expect(d.json).toMatchObject({ draft: `agent:${perp}`, kind: 'derivative', shape: 'SPW-VENUE-MANDATE-v1', approval: { route: `/risk?mandate=agent:${perp}` } });
  });

  it('D9 — a spot agent paused while LIVE: its mandate was revoked, so "resume" is a new owner approval; neither the key nor the owner\'s resume route goes around it', async () => {
    spot = randomUUID();
    const sv = randomUUID();
    await sql`insert into agents (id, name, network, universe, interval, risk, vault_index, vault_address, capital_usdc, state, mode, strategy_version_id, mandate_id, cash, runtime)
      values (${spot}, 'Spot live', 'base', ${sql.json(['ETH'])}, '1h', ${sql.json({ maxExposurePct: 50, maxLossPct: 5, maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 50 })}, 7, '0x7777777777777777777777777777777777777777', '100000000', 'LIVE', 'LIVE', ${sv}, ${randomUUID()}, 'USDC', '{}')`;
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status, report, approved_at, approved_by) values (${sv}, ${spot}, 'ma_trend', '3', ${'a'.repeat(64)}, 'strategies/ma_trend/3', 'approved', ${sql.json({ checks: { lookahead: 'pass' } })}, now(), 'owner')`;
    // the owner pauses the live agent: the mandate is revoked at the (real) signer — unknown there, which is "nothing to revoke" — and the agent remembers where it came from
    const p = await call('POST', `${A}/${spot}/pause`, { body: {} });
    expect([p.status, p.json.state, p.json.mode, p.json.pausedFrom, p.json.mandate]).toEqual([200, 'paused', 'live', 'LIVE', null]);
    expect((await sql`select mode, code from research_log where agent_id = ${spot} and code = 'state_paused'`)[0]).toEqual({ mode: 'LIVE', code: 'state_paused' });
    for (const r of [await call('POST', `${A}/${spot}/resume`, { body: {} }), await call('POST', `${T}/agents/${spot}/start`, { key: KEY, body: { mode: 'live' } }), await call('POST', `${T}/strategies/${sv}/start`, { key: KEY, body: { mode: 'live' } })]) {
      expect([r.status, r.json.error]).toEqual([409, 'mandate_required']); expect(r.json.message).toMatch(/revoked when it left LIVE/);
    }
    expect((await sql`select state from agents where id = ${spot}`)[0].state).toBe('PAUSED');
    const d = await call('GET', `${A}/${spot}/mandate-draft`);
    expect(d.json).toMatchObject({ kind: 'spot', shape: 'SPW-MANDATE-v1', available: true, fields: { network: 'base', symbols: ['ETH'], maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12, days: 30, strategySha256: 'a'.repeat(64) } });
    // from the pause it can go back to paper (nothing is signed), started by the key
    const paper = await call('POST', `${T}/strategies/${sv}/start`, { key: KEY, body: { mode: 'paper' } });
    expect([paper.status, paper.json.agent.state, paper.json.agent.mode]).toEqual([200, 'active', 'paper']);
  });

  it('a version started on paper BY A KEY is not an owner approval: no live mandate can be prepared on it', async () => {
    const id = randomUUID(), sv = randomUUID();
    await sql`insert into agents (id, name, network, universe, interval, risk, vault_index, vault_address, capital_usdc, state, mode, cash) values (${id}, 'Key paper', 'base', ${sql.json(['ETH'])}, '1h',
      ${sql.json({ maxExposurePct: 50, maxLossPct: 5, maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 50 })}, 8, '0x8888888888888888888888888888888888888888', '100000000', 'CREATED', 'RESEARCH', 'USDC')`;
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status, report) values (${sv}, ${id}, 'ma_trend', '3', ${'b'.repeat(64)}, 'strategies/ma_trend/3', 'draft', ${sql.json({ checks: { lookahead: 'fail' } })})`;
    await (await import('../src/agent-runtime/store.ts')).bumpConfig(id, 'owner', 'created');
    // a report whose own look-ahead check failed runs nowhere, not even on paper
    expect((await call('POST', `${T}/agents/${id}/start`, { key: KEY, body: { mode: 'paper' } })).json.error).toBe('bad_report');
    await sql`update strategy_versions set report = ${sql.json({ checks: { lookahead: 'pass' } })} where id = ${sv}`;
    const s = await call('POST', `${T}/agents/${id}/start`, { key: KEY, body: { mode: 'paper' } });
    expect([s.status, s.json.agent.state, s.json.agent.mode, s.json.agent.configVersion]).toEqual([200, 'active', 'paper', 2]);       // the strategy became the agent's: a new configuration version
    expect((await sql`select status, approved_by from strategy_versions where id = ${sv}`)[0].approved_by).toMatch(/^key:/);
    // the owner tries to prepare the live mandate: refused until the OWNER approves the version
    const prep = await call('POST', `${A}/${id}/mandate/prepare`, { body: {} });
    expect([prep.status, prep.json.error]).toEqual([409, 'owner_approval_required']);
    expect((await call('GET', `${A}/${id}/mandate-draft`)).json.reason).toMatch(/approved for paper by an API key/);
  });

  it('what a key can never do: create a spot agent, reach a mandate route, act without its scope, release the kill switch', async () => {
    const spotCreate = await call('POST', `${T}/agents`, { key: KEY, body: { kind: 'spot', name: 'Spot', universe: ['ETH'] } });
    expect([spotCreate.status, spotCreate.json.error]).toEqual([403, 'owner_required']);
    for (const path of [`${A}/${spot}/mandate/prepare`, `${A}/${spot}/mandate/approve`, `${A}/${perp}/perp/live/prepare`, `${A}/${perp}/perp/live/approve`, `${A}/kill-switch/release`, `${A}/${spot}/start`, `${A}/from-template`])
      expect([(await call('POST', path, { key: KEY, body: {} })).json.error, path]).toEqual(['key_path_forbidden', path]);
    // no route under /api/v1/trading mentions a mandate approval
    const { OPERATIONS } = await import('../src/trading-api/spec.ts');
    // the one exception, by design: a key may ENGAGE the global kill switch (it only removes risk); nothing releases it or approves anything
    expect(OPERATIONS.filter((o) => /mandate|approve|kill|release/i.test(o.id) || /mandate|approve|kill|release/i.test(o.path)).map((o) => o.id)).toEqual(['engageKillSwitch']);
    for (const [m, p, body] of [['POST', `/agents/${mm}/start`, { mode: 'paper' }], ['POST', `/agents/${mm}/stop`, {}], ['POST', '/agents', { template: 'market-making', name: 'no' }], ['POST', `/agents/${mm}/backtest`, {}], ['POST', `/agents/${mm}/pause`, {}]] as const) {
      const r = await call(m, T + p, { key: READER, body }); expect([r.status, r.json.error], p).toEqual([403, 'insufficient_scope']);
    }
    const none = await newKey(['markets:read']);
    for (const p of [`/agents/${mm}`, `/agents/${mm}/signals`, `/agents/${mm}/performance`, '/agents/templates', '/agents']) expect((await call('GET', T + p, { key: none })).status, p).toBe(403);
    // a key restricted to another venue does not see, nor move, a Hyperliquid agent
    const gmxOnly = await newKey(['agents:read', 'agents:manage'], { restrictions: { venues: ['gmx'] } });
    expect((await call('GET', `${T}/agents`, { key: gmxOnly })).json.agents.map((a: any) => a.id)).not.toContain(mm);
    expect((await call('POST', `${T}/agents/${mm}/stop`, { key: gmxOnly, body: {} })).json.error).toBe('restricted');
    expect((await call('GET', `${T}/agents/not-a-uuid`, { key: READER })).status).toBe(404);
  });
});

describe('the risk-management agent, end to end', () => {
  let sup = '', victim = '';
  it('created from its template; only the owner may let it act on live agents; in paper mode it pauses a paper agent in drawdown and says why on both timelines', async () => {
    const c = await call('POST', `${T}/agents`, { key: KEY, body: { template: 'risk-manager', name: 'Risk', config: { act: true }, risk: { maxAgentDrawdownPct: 8 } } });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    sup = c.json.agent.id;
    expect(c.json.agent).toMatchObject({ kind: 'supervisor', family: 'risk_manager', engine: 'supervisor', state: 'stopped' });
    expect((await call('POST', `${T}/agents`, { key: KEY, body: { template: 'risk-manager', name: 'Risk 2' } })).json.error).toBe('exists');
    const live = await call('POST', `${T}/agents/${sup}/start`, { key: KEY, body: { mode: 'live' } });
    expect([live.status, live.json.error]).toEqual([403, 'owner_required']);
    expect((await call('POST', `${T}/agents/${sup}/start`, { key: KEY, body: { mode: 'paper' } })).json.agent).toMatchObject({ state: 'active', mode: 'paper' });
    // a paper market maker that lost 12 % from its peak (equity points of the PAPER mode)
    const v2 = await call('POST', `${T}/agents`, { key: KEY, body: { template: 'market-making', name: 'Losing MM', venues: ['hyperliquid'], universe: ['BTC'], mode: 'paper' } });
    victim = v2.json.agent.id;
    expect(v2.json.agent).toMatchObject({ state: 'active', mode: 'paper' });
    const t = clock.now();
    await sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${victim}, ${new Date(t - 7_200_000)}, 'PAPER', 1000, '{}'), (${victim}, ${new Date(t - 3_600_000)}, 'PAPER', 880, '{}'),
      (${victim}, ${new Date(t - 7_200_000)}, 'LIVE', 5, '{}')`;                                  // a LIVE row of the same agent must not enter the paper judgement
    const out = await rt.supervisorPass();
    expect(out[sup]).toBe('1 finding(s), 1 action(s)');
    expect((await sql`select state, runtime->>'pausedFrom' as paused_from from agents where id = ${victim}`)[0]).toEqual({ state: 'PAUSED', paused_from: 'PAPER' });
    const own = await call('GET', `${T}/agents/${sup}/journal?mode=paper`, { key: READER });
    expect(own.json.entries.filter((e: any) => e.kind === 'proposal').map((e: any) => [e.code, e.severity, e.title])).toEqual([['agent_drawdown', 'error', 'Risk manager: agent PAUSED']]);
    expect(own.json.entries.find((e: any) => e.kind === 'proposal').body).toMatch(/drawdown 12\.00 % from its peak equity \(1000\.00 → 880\.00 USD\), limit 8\.00 %/);
    const theirs = await call('GET', `${T}/agents/${victim}/journal?mode=paper`, { key: READER });
    expect(theirs.json.entries.map((e: any) => e.code)).toEqual(expect.arrayContaining(['supervisor_agent_drawdown', 'paused']));
    expect(events.filter((e) => e.event === 'risk.proposal').map((e) => [e.data.agentId, e.data.action, e.data.acted, e.data.mode])).toEqual([[victim, 'pause', 'paused', 'paper']]);
    expect((await sql`select actor from audit_events where type = 'agent.mode' and data->>'id' = ${victim} order by seq desc limit 1`)[0].actor).toBe(`agent:${sup}`);
    // it said it once: a second pass repeats nothing, and it never resumes what it paused
    expect((await rt.supervisorPass())[sup]).toBe('1 finding(s), 0 action(s)');     // the drawdown is still there (a paused agent stays supervised): found again, said and done once
    expect((await sql`select state from agents where id = ${victim}`)[0].state).toBe('PAUSED');
  });

  it('the kill switch: engaged through the port, visible in the runtime status, refusing what adds risk; released by the owner only', async () => {
    const e = await call('POST', `${A}/kill-switch/engage`, { body: { reason: 'drill' } });
    expect(e.json).toMatchObject({ engaged: true, reason: 'owner: drill' });
    expect(events.filter((x) => x.event === 'risk.kill_switch')).toHaveLength(1);
    const st = await call('GET', `${A}/runtime/status`);
    expect(st.json.killSwitch.engaged).toBe(true); expect(st.json.queue).toMatchObject({ queued: expect.any(Number), running: 0 }); expect(Array.isArray(st.json.leases)).toBe(true);
    // a running paper market maker: its quotes add risk → refused by the gateway while the switch is on
    const r = await call('POST', `${T}/agents`, { key: KEY, body: { template: 'market-making', name: 'MM under KS', venues: ['hyperliquid'], universe: ['BTC'], config: MM, mode: 'paper' } });
    clock.advance(1100); await rt.streamPass(); await sleep(40); clock.advance(1100); await rt.streamPass();
    const ord = await call('GET', `${T}/agents/${r.json.agent.id}/orders?mode=paper`, { key: READER });
    expect(ord.json.orders.length).toBeGreaterThan(0); expect(ord.json.orders.every((o: any) => o.state === 'REJECTED' && o.reason === 'KILL_SWITCH_ACTIVE')).toBe(true);
    expect((await call('GET', `${A}/${r.json.agent.id}/overview`)).json.killSwitch.engaged).toBe(true);
    const rel = await call('POST', `${A}/kill-switch/release`, { body: {} });
    expect(rel.json.engaged).toBe(false);
    expect((await sql`select type, actor from audit_events where type like 'agents.kill_switch%' order by seq`).map((x: any) => [x.type, x.actor])).toEqual([['agents.kill_switch_engaged', 'agent:risk'], ['agents.kill_switch_released', 'owner']]);
  });

  it('the owner\'s panel routes: overview, timeline of one mode, configuration versions; a configuration change is a new version and needs the agent stopped', async () => {
    const o = await call('GET', `${A}/${mm}/overview`);
    expect(o.json).toMatchObject({ id: mm, state: 'stopped', mode: 'paper', familyModes: { modes: ['research', 'paper'] }, runtime: { rule: 'spread_inventory', venues: ['hyperliquid'], book: { simulated: true } } });
    expect(o.json.jobs.map((j: any) => [j.kind, j.status])).toEqual([['backtest', 'done']]);
    const tl = await call('GET', `${A}/${mm}/timeline?mode=paper`);
    expect(tl.json.mode).toBe('paper'); expect(tl.json.items.map((i: any) => i.type)).toEqual(expect.arrayContaining(['signal', 'order', 'state', 'hold']));
    expect([...tl.json.items].sort((x: any, y: any) => y.ts - x.ts)).toEqual(tl.json.items);                // newest first
    expect((await call('GET', `${A}/${mm}/timeline?mode=live`)).json.items).toEqual([]);
    const cfg = await call('POST', `${A}/${mm}/config`, { body: { config: { quoteSizeUsd: '75' }, risk: { maxPositionUsd: 300 } } });
    expect([cfg.status, cfg.json.configVersion, cfg.json.agent.riskLimits.maxPositionUsd]).toEqual([200, 2, 300]);
    const vs = await call('GET', `${A}/${mm}/config-versions`);
    expect(vs.json.versions.map((x: any) => [x.version, x.actor, x.config.config.quoteSizeUsd])).toEqual([[2, 'owner', '75'], [1, expect.stringMatching(/^key:/), '50']]);
    expect((await call('POST', `${A}/${victim}/resume`, { body: {} })).json.state).toBe('active');
    expect((await call('POST', `${A}/${victim}/config`, { body: { config: { quoteSizeUsd: '60' } } })).json.error).toBe('bad_state');
    // the legacy list of the web app carries the new kinds without breaking the old ones
    const list = await call('GET', A);
    expect(list.status).toBe(200); expect(new Set(list.json.agents.map((a: any) => a.kind))).toEqual(new Set(['stream', 'supervisor', 'perp', undefined]));
  });
});

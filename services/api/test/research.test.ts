// V7 research runtime, API side, end to end and in one process: the real routes on a scratch database, the REAL runner
// (services/research-runner) talking to them through app.inject, the deterministic fake agent under the real sandbox, the
// real laboratory. No model, no network, no signer. Covers: who can call what (the runner's secret opens three routes and
// nothing else; a job token opens one job), the holdout (the runner never receives the test split), the submission pipeline
// (static purity check before anything runs, server-side backtests, claims versus measurements, trial count → deflated
// Sharpe), failures (malformed, oversized, impure, network imports, wrong META), cancel, budgets, alerts, approval.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunnerJob, type RunnerResult } from '@spw/core';
import type { RunnerApi } from '../../research-runner/src/api-client.ts';
import { processJob } from '../../research-runner/src/runner.ts';
import { labReady, LAB, testConfig } from '../../research-runner/test/helpers.ts';
import { addAgent, ownerCookie, world, type World } from './alerts-helpers.ts';

const ORIGIN = 'https://wallet.test', SECRET = 'runner-secret-'.padEnd(48, 'x'), T = 240_000;
let w: World, sql: any, app: any, cookie = '', d: any;
const MISSION = 'Développe une stratégie statistique BTC/ETH, teste-la sur données historiques et prépare une simulation avec un capital virtuel de 1 000 USDC';

async function owner(method: string, url: string, body?: unknown, o: { cookie?: string | null } = {}) {
  const headers: Record<string, string> = {}, c = o.cookie === undefined ? cookie : o.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
  const r = await app.inject({ method, url: `/api/v1${url}`, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), raw: r.body as string };
}
async function runner(url: string, body: unknown, o: { secret?: string | null; token?: string; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.headers ?? {}) };
  if (o.secret !== null) headers.authorization = `Bearer ${o.secret ?? SECRET}`;
  if (o.token) headers['x-spw-job-token'] = o.token;
  const r = await app.inject({ method: o.method ?? 'POST', url: `/api/v1/research/runner${url}`, headers, payload: o.method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
/** the runner's API client, over app.inject — optionally rewriting the result on its way (a dishonest or broken runner) */
const injectApi = (o: { alter?: (r: RunnerResult) => RunnerResult } = {}): RunnerApi & { last: RunnerJob | null } => ({
  last: null,
  async claim() { const r = await runner('/claim', { runnerId: 'test-runner' }); if (r.status !== 200) throw new Error(`claim ${r.status}`); return (this.last = r.json.job ? RunnerJob.parse(r.json.job) : null); },
  async log(job, lines, state) { const r = await runner(`/jobs/${job.id}/log`, { lines, ...(state ? { state } : {}) }, { token: job.token }); if (r.status !== 200) throw new Error(`log ${r.status}`); return { cancel: r.json.cancel === true }; },
  async result(job, result) { const r = await runner(`/jobs/${job.id}/result`, o.alter ? o.alter(result) : result, { token: job.token }); if (r.status !== 200 && r.status !== 202) throw new Error(`result ${r.status} ${JSON.stringify(r.json)}`); },
});
/** wait on the database (not through the API: the rate limit of the real routes applies to this test too), then read the detail */
const waitFor = async (id: string, done: (j: any) => boolean, ms = 180_000): Promise<any> => { const t0 = Date.now(); for (;;) {
  const [r] = await sql`select state, reason, dataset from research_jobs where id = ${id}`;
  const j = { state: r?.state, reason: r?.reason, dataReady: r?.dataset?.ready ?? null, dataError: r?.dataset?.error ?? null };
  if (done(j)) return (await owner('GET', `/research/jobs/${id}`)).json;
  if (Date.now() - t0 > ms) throw new Error(`job ${id} stayed ${j.state}: ${JSON.stringify(j.dataError ?? j.reason)}`);
  await new Promise((res) => setTimeout(res, 200)); } };
const final = (j: any) => ['submitted', 'failed', 'cancelled', 'over_budget'].includes(j.state);
/** create a job, let the real runner run it with the fake agent in `mode`, wait for the API to finish with it */
async function runFlow(mode: string, o: { agentId?: string; universe?: string[]; extra?: unknown; alter?: (r: RunnerResult) => RunnerResult; budgets?: Record<string, number> } = {}) {
  const c = await owner('POST', '/research/jobs', { mission: MISSION, universe: o.universe ?? ['BTC', 'ETH'], ...(o.agentId ? { agentId: o.agentId } : {}), ...(o.budgets ? { budgets: o.budgets } : {}) });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  await waitFor(c.json.id, (j) => j.dataReady !== null);
  const api = injectApi({ alter: o.alter }), job = await api.claim();
  expect(job?.id).toBe(c.json.id);
  const result = await processJob(job!, testConfig(mode, o.extra ?? {}), api);
  await api.result(job!, result);
  return { id: c.json.id as string, job: job!, result, detail: await waitFor(c.json.id, final) };
}
const stratDir = (name: string) => path.join(LAB, 'strategies', name);

beforeAll(async () => {
  w = await world('spw_v7_research_test'); sql = w.sql;
  Object.assign(process.env, { SPW_RESEARCH_RUNNER_SECRET: SECRET, SPW_RESEARCH_LAB_COMMIT: '' });
  // candles: 1 000 closed hourly bars of BTC and ETH from one source (a deterministic random walk)
  const H = 3_600_000, end = Math.floor(Date.now() / H) * H - 2 * H, rows: Record<string, unknown>[] = [];
  for (const [sym, seed, p0] of [['BTC', 11, 60_000], ['ETH', 23, 3000]] as const) {
    let s = seed; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
    let close = p0;
    for (let i = 0; i < 1000; i++) { const open = close; close = open * Math.exp(0.0001 + 0.01 * (rnd() + rnd() + rnd() - 1.5));
      rows.push({ source: 'coinbase', symbol: sym, interval: '1h', ts: new Date(end - (999 - i) * H), open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 + rnd() }); }
  }
  for (let i = 0; i < rows.length; i += 500) await sql`insert into candles ${sql(rows.slice(i, i + 500))}`;
  app = await (await import('../src/server.ts')).buildServer();
  cookie = await ownerCookie(sql);
  d = w.dispatcher({ now: Date.now }); await d.tail();                // the alert cursors start at the present
}, 60_000);
afterAll(async () => {
  await app?.close();
  // the strategies this run installed in the laboratory's library (rj_*) are removed
  const rows = await sql`select strategy_name from research_jobs`;
  const { rmSync } = await import('node:fs');
  for (const r of rows) rmSync(stratDir(r.strategy_name), { recursive: true, force: true });
  await sql?.end();
});

describe.skipIf(!labReady())('research jobs — who can call what', () => {
  it('owner routes need the owner session; the runner secret does not open them', async () => {
    for (const p of ['/research/jobs', '/research/status', '/research/jobs/00000000-0000-4000-8000-000000000000', '/research/jobs/00000000-0000-4000-8000-000000000000/log', '/research/jobs/00000000-0000-4000-8000-000000000000/log/stream'])
      expect((await owner('GET', p, undefined, { cookie: null })).status, p).toBe(401);
    expect((await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC'] }, { cookie: null })).status).toBe(401);
    for (const p of ['/api/v1/research/jobs', '/api/v1/agents', '/api/v1/research/status', '/api/v1/security/overview', '/api/v1/strategies']) {
      const r = await app.inject({ method: 'GET', url: p, headers: { authorization: `Bearer ${SECRET}`, 'x-spw-job-token': 'x'.repeat(64) } });
      expect(r.statusCode, p).toBe(401);
    }
    const post = await app.inject({ method: 'POST', url: '/api/v1/research/jobs', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, payload: JSON.stringify({ mission: MISSION, universe: ['BTC'] }) });
    expect(post.statusCode).toBe(403);                                  // not even the CSRF check is passed: the secret is not a session
  });

  it('runner routes need the runner secret — not the owner session, not a wrong secret, POST only; without a configured secret they do not exist', async () => {
    expect((await runner('/claim', { runnerId: 'r' }, { secret: null })).status).toBe(401);
    expect((await runner('/claim', { runnerId: 'r' }, { secret: 'wrong'.repeat(10) })).status).toBe(401);
    expect((await runner('/claim', { runnerId: 'r' }, { secret: null, headers: { cookie, origin: ORIGIN, 'x-spw-csrf': '1' } })).status).toBe(401);
    expect((await runner('/claim', undefined, { method: 'GET' })).status).toBe(401);
    expect((await runner('/anything-else', {})).status).toBe(404);
    expect((await runner('/jobs', {})).status).toBe(404);
    expect((await runner('/claim', { runnerId: 'r' })).json).toEqual({ job: null });
    process.env.SPW_RESEARCH_RUNNER_SECRET = '';
    expect((await runner('/claim', { runnerId: 'r' })).status).toBe(404);
    expect((await owner('GET', '/research/status')).json.runnerConfigured).toBe(false);
    process.env.SPW_RESEARCH_RUNNER_SECRET = 'too-short';
    expect((await runner('/claim', { runnerId: 'r' }, { secret: 'too-short' })).status).toBe(404);
    process.env.SPW_RESEARCH_RUNNER_SECRET = SECRET;
    expect((await owner('GET', '/research/status')).json).toMatchObject({ runnerConfigured: true, openJobs: 0 });
  });

  it('a job token opens ONE job: no log or result on another job, none without it, none after the result; the claim carries no test-split bar', async () => {
    const a = (await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC', 'ETH'] })).json, b = (await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC'] })).json;
    await waitFor(a.id, (j) => j.dataReady === true); await waitFor(b.id, (j) => j.dataReady === true);
    const ja = RunnerJob.parse((await runner('/claim', { runnerId: 'r1' })).json.job), jb = RunnerJob.parse((await runner('/claim', { runnerId: 'r2' })).json.job);
    expect([ja.id, jb.id]).toEqual([a.id, b.id]);                       // oldest first
    expect((await runner('/claim', { runnerId: 'r3' })).json).toEqual({ job: null }); // a claimed job is not handed out twice
    // the data: only bars strictly before the held-out period
    const detail = (await owner('GET', `/research/jobs/${a.id}`)).json, cut = Date.parse(detail.holdout.devEnd) / 1000;
    expect(detail.holdout).toMatchObject({ devBars: 800, testBars: 200 });
    if (ja.data.kind !== 'spot') throw new Error('spot expected');
    for (const f of ja.data.files) { const ts = f.csv.trim().split('\n').slice(1).map((l) => Number(l.split(',')[0])); expect(ts).toHaveLength(800); expect(Math.max(...ts)).toBeLessThan(cut); }
    expect(JSON.stringify(ja)).not.toContain('token_hash');
    const line = { lines: [{ s: 'out', t: 'hello' }] };
    expect((await runner(`/jobs/${ja.id}/log`, line, { token: ja.token })).json).toEqual({ cancel: false });
    for (const [id, token] of [[jb.id, ja.token], [ja.id, jb.token], [ja.id, ''], [ja.id, 'x'.repeat(64)], ['00000000-0000-4000-8000-000000000000', ja.token], ['not-a-uuid', ja.token]] as const) {
      expect((await runner(`/jobs/${id}/log`, line, { token })).status, `${id} ${token.slice(0, 4)}`).toBe(403);
      expect((await runner(`/jobs/${id}/result`, { outcome: 'failed', reason: 'x', usage: {} }, { token })).status).toBe(403);
    }
    expect((await sql`select line from research_job_log where job_id = ${jb.id} and stream = 'out'`).length).toBe(0);
    // an owner's cancel reaches the runner through the log answer; the runner's result then ends the job as cancelled
    expect((await owner('POST', `/research/jobs/${a.id}/cancel`, {})).json).toMatchObject({ state: 'preparing', cancelRequested: true });
    expect((await runner(`/jobs/${ja.id}/log`, line, { token: ja.token })).json).toEqual({ cancel: true });
    const usage = { wallMs: 10, trials: 0, diskMb: 0, modelTokens: 0, modelRequests: 0, modelUsd: null, ledgerTampered: false, sandbox: 'none', agent: 'x', labCommit: null, exitCode: null, signal: 'SIGKILL' };
    expect((await runner(`/jobs/${ja.id}/result`, { outcome: 'cancelled', reason: 'cancelled by the owner', usage, ledger: '' }, { token: ja.token })).json).toMatchObject({ state: 'cancelled' });
    expect((await runner(`/jobs/${ja.id}/log`, line, { token: ja.token })).status).toBe(403);       // the token died with the job
    expect((await runner(`/jobs/${ja.id}/result`, { outcome: 'failed', reason: 'again', usage, ledger: '' }, { token: ja.token })).status).toBe(403);
    // an over-budget result is recorded with what was consumed
    expect((await runner(`/jobs/${jb.id}/result`, { outcome: 'over_budget', reason: '900 trials, budget 200', usage: { ...usage, trials: 900 }, ledger: '{"kind":"trial"}\n' }, { token: jb.token })).json).toMatchObject({ state: 'over_budget' });
    const over = (await owner('GET', `/research/jobs/${jb.id}`)).json;
    expect(over).toMatchObject({ state: 'over_budget', reason: '900 trials, budget 200', submission: null, server: null, version: null });
    expect(over.usage.trials).toBe(900);
    expect((await owner('POST', `/research/jobs/${jb.id}/cancel`, {})).status).toBe(409);
    // a queued job is cancelled at once
    const c = (await owner('POST', '/research/jobs', { mission: MISSION, universe: ['ETH'] })).json;
    expect((await owner('POST', `/research/jobs/${c.id}/cancel`, {})).json).toMatchObject({ state: 'cancelled' });
    expect((await runner('/claim', { runnerId: 'r' })).json).toEqual({ job: null });
  }, T);

  it('job creation is validated: mission, symbols with market data, budgets within bounds, no web tool, an agent\'s job takes the agent\'s universe', async () => {
    for (const bad of [{ mission: 'short', universe: ['BTC'] }, { mission: MISSION, universe: [] }, { mission: MISSION, universe: ['btc'] }, { mission: MISSION, universe: ['BTC'], tools: ['WebFetch'] }, { mission: MISSION, universe: ['BTC'], tools: ['WebSearch', 'Bash'] },
      { mission: MISSION, universe: ['BTC'], budgets: { wallSeconds: 10 ** 7 } }, { mission: MISSION, universe: ['BTC'], budgets: { maxTrials: 0 } }, { mission: MISSION, universe: ['BTC'], extra: 1 }])
      expect((await owner('POST', '/research/jobs', bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC', 'NOSUCHCOIN'] })).json.error).toBe('no_data');
    expect((await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC'], agentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    // a symbol without stored candles: the job fails while its data set is prepared, before any runner sees it
    const nodata = (await owner('POST', '/research/jobs', { mission: MISSION, universe: ['SOL'] })).json;
    const d = await waitFor(nodata.id, final);
    expect(d).toMatchObject({ state: 'failed', dataReady: false }); expect(d.reason).toMatch(/no data set: no 1h candles of SOL/);
  }, T);
});

describe.skipIf(!labReady())('research jobs — submission pipeline (real runner, fake agent, real laboratory)', () => {
  let okSummary: any;
  it('success for an agent: the server re-computes the hash, re-runs the backtest on data the job never had, counts the job\'s trials, and leaves a draft for the owner', async () => {
    const agentId = await addAgent(sql, { name: 'Momentum BTC/ETH', state: 'CREATED', universe: ['BTC', 'ETH'] });
    // before any research: no version, nothing to approve, no paper trading
    expect((await owner('POST', `/agents/${agentId}/mode`, { mode: 'PAPER' })).json.error).toBe('no_strategy');
    const { id, job, result, detail } = await runFlow('ok', { agentId });
    expect(detail.state, JSON.stringify(detail.server)).toBe('submitted');
    expect(result.outcome).toBe('submission');
    const s = okSummary = detail.server;
    expect(s.status).toBe('ok');
    expect(s.sandbox).toBe(process.platform === 'darwin' ? 'sandbox-exec' : 'none');
    // identity: hash recomputed by the server from the installed file
    const { createHash } = await import('node:crypto'), { readFileSync } = await import('node:fs');
    const installed = path.join(stratDir(job.strategyName), '1');
    expect(readdirSync(installed).sort()).toEqual(['NOTES.md', 'README.md', 'strategy.py']);      // claims.json is a statement: stored, not installed
    expect(s.sha256).toBe(createHash('sha256').update(readFileSync(path.join(installed, 'strategy.py'))).digest('hex'));
    expect(detail.submission.sha256).toBe(s.sha256);
    expect(detail.submission.files['README.md']).toMatch(/\*\*Hypothesis\.\*\*[\s\S]*\*\*What would refute it\.\*\*/);
    // out of sample: the server's test split starts exactly where the agent's data ended
    expect(Date.parse(s.holdout.testStart)).toBe(Date.parse(detail.holdout.devEnd));
    expect(detail.report.splits.test[0]).toBe(s.holdout.testStart);
    expect(detail.report.research_job).toMatchObject({ id, trials_job: result.usage.trials, ledger_tampered: false });
    // trials: this run's own configurations plus EVERY trial the job consumed
    expect(s.trials.job).toBe(result.usage.trials);
    expect(s.trials.total).toBe(s.trials.job + s.trials.server);
    expect(detail.report.robustness.trials_tested).toBe(s.trials.total);
    expect(detail.report.robustness.deflated_sharpe_detail).toMatchObject({ n_trials: s.trials.total, n_trials_job: s.trials.job });
    // claims versus measurements: the honest agent's numbers are the laboratory's, and the server reproduces them exactly
    expect(s.claimsDiffer).toBe(false);
    expect(s.comparison).toHaveLength(12);
    for (const c of s.comparison) { expect(c.differs).toBe(false); if (c.claimed !== null) expect(c.claimed).toBe(c.measured); }
    expect(s.comparison.filter((c: any) => c.claimed !== null).length).toBeGreaterThanOrEqual(6);
    // the version: draft, with the SERVER's report, awaiting approval
    expect(detail.version).toMatchObject({ status: 'draft', notes: '' });
    const [v] = await sql`select status, report->>'strategy_sha256' as sha, report->'research_job'->>'id' as job, meta from strategy_versions where id = ${detail.version.id}`;
    expect(v).toMatchObject({ status: 'draft', sha: s.sha256, job: id }); expect(v.meta.researchJob).toBe(id);
    const agent = (await owner('GET', `/agents/${agentId}`)).json;
    expect(agent.versions[0]).toMatchObject({ id: detail.version.id, status: 'draft' });
    expect(agent.log.some((l: any) => l.title === 'Research job submitted' && /Awaiting your approval/.test(l.body))).toBe(true);
    // the audit chain and the alerts layer
    const types = (await sql`select type from audit_events order by seq`).map((r: any) => r.type);
    for (const t of ['research.job_created', 'strategy.registered', 'strategy.backtested', 'research.submitted']) expect(types).toContain(t);
    await d.tail();
    const [alert] = await w.alerts(`kind = 'agent.research_submitted'`);
    expect(alert).toMatchObject({ severity: 'info', subject: { type: 'agent', id: agentId } }); expect(alert.params).toMatchObject({ name: 'Momentum BTC/ETH', count: s.trials.total });
    // the existing flow: the owner approves → paper trading
    expect((await owner('POST', `/agents/${agentId}/strategies/${detail.version.id}/approve`, {})).status).toBe(200);
    expect((await owner('POST', `/agents/${agentId}/mode`, { mode: 'PAPER' })).json.state).toBe('PAPER_TRADING');
    // the log, plain and as a stream (a finished job's stream ends by itself)
    const log = (await owner('GET', `/research/jobs/${id}/log`)).json;
    expect(log.lines.map((l: any) => l.t).join('\n')).toMatch(/job created by the owner[\s\S]*data set frozen: 800 bars for the agent[\s\S]*claimed by runner[\s\S]*starting the agent[\s\S]*trial 0[\s\S]*submission collected[\s\S]*passed the static purity check[\s\S]*server evaluation done/);
    const stream = await owner('GET', `/research/jobs/${id}/log/stream`);
    expect(stream.raw).toMatch(/event: log\ndata: .*job created by the owner/); expect(stream.raw).toMatch(/event: state\ndata: \{"state":"submitted"/); expect(stream.raw).toMatch(/event: end/);
    const after = await owner('GET', `/research/jobs/${id}/log/stream?after=${log.lines.at(-1).id}`);
    expect(after.raw).not.toMatch(/event: log/);
    expect((await owner('GET', '/research/jobs')).json.jobs.find((j: any) => j.id === id)).toMatchObject({ state: 'submitted', serverStatus: 'ok', trialsTotal: s.trials.total, claimsDiffer: false });
  }, T);

  it('an agent that reports other numbers than the server measures: both are shown, the server\'s are the report', async () => {
    const agentId = await addAgent(sql, { name: 'Liar', state: 'CREATED', universe: ['BTC', 'ETH'] });
    const { detail } = await runFlow('lie', { agentId });
    expect(detail.state).toBe('submitted');
    const s = detail.server;
    expect(s.claimsDiffer).toBe(true);
    const train = s.comparison.find((c: any) => c.split === 'train' && c.metric === 'sharpe');
    expect(train).toMatchObject({ claimed: 12.5, differs: true }); expect(train.measured).not.toBe(12.5);
    expect(detail.submission.claims.summary).toBe('Extremely profitable. Guaranteed.');
    // the same rule on the same data: the server's numbers are those of the honest run, whatever was claimed
    expect(s.metrics).toEqual(okSummary.metrics); expect(s.replication).toEqual(okSummary.replication);
    const [v] = await sql`select report->'metrics'->'train'->>'sharpe' as sharpe from strategy_versions where id = ${detail.version.id}`;
    expect(Number(v.sharpe)).toBe(s.metrics.train.sharpe);
    expect(JSON.stringify(detail.report)).not.toContain('12.5');
    const log = await sql`select body from research_log where agent_id = ${agentId} and title = 'Research job submitted'`;
    expect(log[0].body).toMatch(/the agent's reported numbers differ from the server's/);
  }, T);

  it('the deflated Sharpe ratio counts every trial of the job: the same strategy with 400 more ledger lines is held to a higher bar', async () => {
    const more = Array.from({ length: 400 }, (_, i) => JSON.stringify({ kind: 'trial', strategy: 'x', sha256: 'e'.repeat(64), params: { i }, interval: '1h', validation_sharpe_per_bar: (i % 2 ? 1 : -1) * 0.05 })).join('\n') + '\n';
    const { detail, result } = await runFlow('ok', { alter: (r) => (r.outcome === 'submission' ? { ...r, usage: { ...r.usage, trials: r.usage.trials + 400 }, archive: { ...r.archive, ledger: r.archive.ledger + more } } : r) });
    expect(detail.state, JSON.stringify(detail.server)).toBe('submitted');
    const s = detail.server, d = detail.report.robustness.deflated_sharpe_detail;
    expect(s.trials.job).toBe(result.usage.trials + 400);
    expect(s.trials.total).toBe(okSummary.trials.total + 400);
    expect(d.expected_max_sharpe_per_bar).toBeGreaterThan(0);
    expect(d.var_trial_sharpes).toBeGreaterThanOrEqual(d.var_trial_sharpes_this_run);
    if (typeof s.deflatedSharpe === 'number' && typeof okSummary.deflatedSharpe === 'number') expect(s.deflatedSharpe).toBeLessThanOrEqual(okSummary.deflatedSharpe);
    expect(s.metrics).toEqual(okSummary.metrics);                       // only the statistical bar moved
    // a library draft (no agent): no version row; the strategy is not offered by the ordinary listing…
    expect(detail.version).toBeNull();
    const lib = (await owner('GET', '/strategies')).json.strategies.map((x: any) => x.path);
    expect(lib.some((p: string) => p.includes('rj_'))).toBe(false); expect(lib.length).toBeGreaterThan(5);
    // …and can be attached to an agent with the same symbols — with the job's server report, nothing re-run
    const same = await addAgent(sql, { name: 'Adopter', state: 'CREATED', universe: ['BTC', 'ETH'] }), other = await addAgent(sql, { name: 'Other', state: 'CREATED', universe: ['BTC', 'LINK'] });
    const rel = detail.strategy;
    expect((await owner('POST', `/agents/${other}/strategies`, { path: rel })).json.error).toBe('universe_mismatch');
    const att = await owner('POST', `/agents/${same}/strategies`, { path: rel });
    expect(att.json).toMatchObject({ sha256: s.sha256, status: 'draft' });
    const [v] = await sql`select report->'robustness'->>'trials_tested' as n from strategy_versions where id = ${att.json.id}`;
    expect(Number(v.n)).toBe(s.trials.total);
  }, T);

  it('refused before anything runs: a strategy that reads a file, one that imports network and OS modules', async () => {
    for (const [mode, re] of [['impure', /fails the purity check: line \d+: use of 'open' is not allowed/], ['netimport', /fails the purity check: line \d+: import of 'socket' is not allowed; line \d+: import of 'urllib.request' is not allowed; line \d+: import of 'os' is not allowed/]] as const) {
      const agentId = await addAgent(sql, { name: `Bad ${mode}`, state: 'CREATED', universe: ['BTC', 'ETH'] });
      const { detail, job } = await runFlow(mode, { agentId });
      expect(detail.state, mode).toBe('failed');
      expect(detail.reason, mode).toMatch(re);
      expect(detail.server).toMatchObject({ status: 'failed' });
      expect(detail.version).toBeNull();                                // no version row at all
      expect(existsSync(stratDir(job.strategyName))).toBe(false);       // nothing was installed in the library
      expect((await sql`select 1 from strategy_versions where agent_id = ${agentId}`).length).toBe(0);
      expect((await owner('POST', `/agents/${agentId}/mode`, { mode: 'PAPER' })).json.error).toBe('no_strategy');
    }
    await d.tail();
    expect((await w.alerts(`kind = 'agent.research_failed'`)).length).toBeGreaterThanOrEqual(2);
  }, 2 * T);

  it('refused: archives a broken or hostile runner could push — other paths, oversized or duplicated files, binary content, a META that is not the job\'s', async () => {
    const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
    const usage = { wallMs: 10, trials: 0, diskMb: 0, modelTokens: 0, modelRequests: 0, modelUsd: null, ledgerTampered: false, sandbox: 'none', agent: 'x', labCommit: null, exitCode: 0, signal: null };
    const push = async (files: { path: string; b64: string }[], extra: Record<string, unknown> = {}) => {
      const c = (await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC', 'ETH'] })).json; await waitFor(c.id, (j) => j.dataReady === true);
      const job = RunnerJob.parse((await runner('/claim', { runnerId: 'evil' })).json.job);
      const r = await runner(`/jobs/${job.id}/result`, { outcome: 'submission', usage, archive: { v: 1, files, ledger: '', ...extra } }, { token: job.token });
      if (r.status === 400) { await runner(`/jobs/${job.id}/result`, { outcome: 'failed', reason: 'test cleanup', usage, ledger: '' }, { token: job.token }); return { status: 400, job, detail: null as any }; }
      return { status: r.status, job, detail: await waitFor(job.id, final) };
    };
    const readme = { path: 'README.md', b64: b64('# x\n') }, good = (name: string) => `META = {"name": "${name}", "version": "1", "universe": ["BTC", "ETH"], "interval": "1h", "lookback": 50, "params": {}}\n\n\ndef target_weights(data, params):\n    return {s: 0.0 for s in data}\n`;
    // shapes the schema refuses outright (HTTP 400, nothing stored)
    for (const files of [[{ path: '../../evil.py', b64: b64('x') }, readme], [{ path: 'strategy.py', b64: b64('x') }, { path: 'run.sh', b64: b64('x') }], [{ path: 'strategies/ma_trend/1/strategy.py', b64: b64('x') }],
      [{ path: 'strategy.py', b64: 'not base64 !!' }, readme], [{ path: 'strategy.py', b64: b64('x'.repeat(400_000)) }, readme]])
      expect((await push(files)).status, JSON.stringify(files).slice(0, 80)).toBe(400);
    expect((await push([{ path: 'strategy.py', b64: b64('x') }, readme], { extra: 1 })).status).toBe(400);
    // shapes that pass the schema and are refused by the pipeline, with a reason, without installing anything
    const cases: [string, { path: string; b64: string }[], RegExp][] = [
      ['oversized', [{ path: 'strategy.py', b64: b64(`${good('x')}#${'y'.repeat(70_000)}\n`) }, readme], /malformed submission: strategy.py is \d+ bytes \(limit 65536\)/],
      ['duplicate', [{ path: 'strategy.py', b64: b64(good('x')) }, { path: 'strategy.py', b64: b64(good('y')) }, readme], /contains strategy.py twice/],
      ['no strategy', [readme], /the submission has no strategy.py/],
      ['binary', [{ path: 'strategy.py', b64: b64(Buffer.from([0x4d, 0x5a, 0x00, 0xff, 0xfe])) }, readme], /strategy.py contains a NUL byte/],
      ['not utf-8', [{ path: 'strategy.py', b64: b64(Buffer.from([0xff, 0xfe, 0x41])) }, readme], /strategy.py is not UTF-8 text/],
      ['syntax', [{ path: 'strategy.py', b64: b64('def (:\n') }, readme], /fails the purity check: syntax error/],
    ];
    for (const [name, files, re] of cases) { const r = await push(files); expect(r.status, name).toBe(202); expect(r.detail.state, name).toBe('failed'); expect(r.detail.reason, name).toMatch(re); expect(existsSync(stratDir(r.job.strategyName)), name).toBe(false); }
    // a well-formed strategy that does not carry the job's name: installed for the description, then removed
    const wrong = await push([{ path: 'strategy.py', b64: b64(good('ma_trend')) }, readme]);
    expect(wrong.detail.reason).toMatch(/META must carry the job's name and version/);
    expect(existsSync(stratDir(wrong.job.strategyName))).toBe(false);
    expect(existsSync(path.join(LAB, 'strategies', 'ma_trend', '1', 'strategy.py'))).toBe(true);     // the real library was not touched
    // a ledger that under-reports is refused: the count the runner states must be in the ledger it pushes
    const c = (await owner('POST', '/research/jobs', { mission: MISSION, universe: ['BTC', 'ETH'] })).json; await waitFor(c.id, (j) => j.dataReady === true);
    const job = RunnerJob.parse((await runner('/claim', { runnerId: 'evil' })).json.job);
    await runner(`/jobs/${job.id}/result`, { outcome: 'submission', usage: { ...usage, trials: 50 }, archive: { v: 1, files: [{ path: 'strategy.py', b64: b64(good(job.strategyName)) }, readme], ledger: '' } }, { token: job.token });
    const d = await waitFor(job.id, final);
    expect(d.state).toBe('failed'); expect(d.reason).toMatch(/does not count the trials the job consumed/);
  }, 3 * T);

  it('a version without a server report cannot be approved', async () => {
    const agentId = await addAgent(sql, { name: 'No report', state: 'CREATED', universe: ['BTC', 'ETH'] });
    const { randomUUID } = await import('node:crypto'), vid = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, notes) values (${vid}, ${agentId}, 'rj_x', '1', ${'a'.repeat(64)}, 'strategies/rj_000000000000/1', '{}', 'draft', 'research job refused: x')`;
    expect((await owner('POST', `/agents/${agentId}/strategies/${vid}/approve`, {})).json.error).toBe('no_report');
    expect((await owner('POST', `/agents/${agentId}/mode`, { mode: 'PAPER' })).json.error).toBe('no_strategy');
    // and a research strategy that has no finished job cannot be attached through the ordinary route
    expect((await owner('POST', `/agents/${agentId}/strategies`, { path: 'rj_000000000000/1' })).status).toBe(404);
  });
});

describe.skipIf(!labReady())('research jobs — perpetual futures (contract 2)', () => {
  it('a perp job: venue candles and funding frozen as files, cut before the test split for the runner, the version-2 report computed by the server', async () => {
    // a stand-in for the venue's read-only data store: 1 000 closed hourly bars and funding settlements of two perpetuals
    const H = 3_600_000, end = Math.floor(Date.now() / H) * H - 2 * H, n = 1000;
    const series = (seed: number, p0: number) => { let s = seed, close = p0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
      const candles: [number, string, string, string, string, string][] = [], funding: [number, string, string | null][] = [];
      for (let i = 0; i < n; i++) { const ts = end - (n - 1 - i) * H, open = close; close = open * Math.exp(0.012 * (rnd() + rnd() + rnd() - 1.5));
        candles.push([ts, open.toFixed(4), (Math.max(open, close) * 1.002).toFixed(4), (Math.min(open, close) * 0.998).toFixed(4), close.toFixed(4), (10 + rnd()).toFixed(3)]); funding.push([ts, (0.0000125 * (rnd() - 0.3)).toFixed(8), null]); }
      return { candles, funding }; };
    const data: Record<string, ReturnType<typeof series>> = { BTC: series(5, 60_000), ETH: series(9, 3000) };
    const live = await import('../src/agents/perp-live.ts');
    live.setPerpRuntime({ lab: { data: { instrument: async (id: string) => { const symbol = id.split(':')[1]!; if (!data[symbol]) throw new Error(`unknown instrument ${id}`); return { venue: 'hyperliquid', symbol, maxLeverage: '40', lotSize: '0.0001' }; } },
      store: { now: () => Date.now(), backfill: async () => {}, exact: async (inst: { symbol: string }) => data[inst.symbol]! } } } as never);
    try {
      expect((await owner('POST', '/research/jobs', { mission: MISSION, kind: 'perp', universe: ['BTC', 'ETH'], interval: '1d' })).json.error).toBe('bad_interval');
      const c = await owner('POST', '/research/jobs', { mission: MISSION, kind: 'perp', universe: ['BTC', 'ETH'], interval: '1h' });
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      const ready = await waitFor(c.json.id, (j) => j.dataReady !== null);
      expect(ready.dataError).toBeNull(); expect(ready.holdout).toMatchObject({ devBars: 800, testBars: 200 });
      const api = injectApi(), job = await api.claim();
      expect(job?.kind).toBe('perp');
      if (job!.data.kind !== 'perp') throw new Error('perp expected');
      // the runner's bundle holds no bar and no funding settlement of the held-out period
      const cut = Date.parse(ready.holdout.devEnd), b = job!.data.bundle as { as_of_ms: number; candles: Record<string, [number][]>; funding: Record<string, [number][]> };
      expect(b.as_of_ms).toBe(cut);
      for (const sym of ['BTC', 'ETH']) { expect(b.candles[sym]).toHaveLength(800); expect(Math.max(...b.candles[sym]!.map((r) => r[0]))).toBeLessThan(cut); expect(Math.max(...b.funding[sym]!.map((r) => r[0]))).toBeLessThan(cut); }
      const result = await processJob(job!, testConfig('ok'), api);
      expect(result.outcome, JSON.stringify(result).slice(0, 400)).toBe('submission');
      await api.result(job!, result);
      const d = await waitFor(c.json.id, final);
      expect(d.state, JSON.stringify(d.server)).toBe('submitted');
      expect(d.report.splits.test[0]).toBe(d.server.holdout.testStart); expect(Date.parse(d.server.holdout.testStart)).toBe(cut);
      expect(d.server.checks).toMatchObject({ lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass' });
      expect(d.server.meta).toMatchObject({ kind: 'perp', max_leverage: 2 });
      expect(d.server.trials.total).toBe(d.server.trials.job + d.server.trials.server); expect(d.server.trials.job).toBe(result.usage.trials);
      expect(d.server.claimsDiffer).toBe(false);
      expect((await owner('GET', '/strategies?kind=perp')).json.strategies.some((x: any) => String(x.path).includes('rj_'))).toBe(false);
    } finally { live.setPerpRuntime(null); }
  }, T);
});

describe.skipIf(!labReady())('research jobs — the installed strategies survive a redeployment', () => {
  it('a missing strategy file of an evaluated job is put back byte for byte from the database; an altered copy is not', async () => {
    const { restoreJobStrategies } = await import('../src/research/evaluate.ts'), { createHash } = await import('node:crypto'), { readFileSync, rmSync } = await import('node:fs');
    const rows = await sql`select id, strategy_name, server->>'sha256' as sha from research_jobs where state = 'submitted' and server->>'status' = 'ok' order by created_at limit 2`;
    expect(rows.length).toBe(2);
    for (const r of rows) rmSync(stratDir(r.strategy_name), { recursive: true, force: true });
    // the second job's stored code is altered in the database: it must NOT be written back under the evaluated hash
    await sql`update research_jobs set submission = jsonb_set(submission, '{files,strategy.py}', to_jsonb((submission->'files'->>'strategy.py') || E'\n# changed\n')) where id = ${rows[1].id}`;
    expect(await restoreJobStrategies()).toBe(1);
    const f = path.join(stratDir(rows[0].strategy_name), '1', 'strategy.py');
    expect(createHash('sha256').update(readFileSync(f)).digest('hex')).toBe(rows[0].sha);
    expect(existsSync(stratDir(rows[1].strategy_name))).toBe(false);
    expect(await restoreJobStrategies()).toBe(0);                       // nothing to do twice
  });
});

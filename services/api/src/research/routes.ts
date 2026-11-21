/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/research/routes.ts
 * Module           : research
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// V7 research runtime — HTTP.
//
// Owner side (behind the owner session and the CSRF check of server.ts, like every other route):
//   POST   /api/v1/research/jobs               create a job from a mission in natural language, with budgets
//   GET    /api/v1/research/jobs[?agentId=]    list            GET /api/v1/research/jobs/:id   detail (submission + SERVER report)
//   POST   /api/v1/research/jobs/:id/cancel    cancel          GET /api/v1/research/jobs/:id/log[/stream]   the job's log (SSE)
//   GET    /api/v1/research/status             is a runner configured, did one show up
//
// Runner side — `/api/v1/research/runner/*`, the ONLY routes that accept the runner's shared secret (SPW_RESEARCH_RUNNER_SECRET,
// `Authorization: Bearer …`). They accept nothing else: no owner cookie works here, and the secret works nowhere else
// (server.ts sends these paths to runnerGate() and every other path to the owner session). With the secret a caller can:
//   POST …/runner/claim               take the oldest queued job (its mission, budgets and the DEVELOPMENT part of its data)
//   POST …/runner/jobs/:id/log        append log lines to THAT job (needs the job's own token) — answers whether to cancel
//   POST …/runner/jobs/:id/result     push the result of THAT job (token again): a submission archive, or why there is none
// It cannot read a job it did not claim, list jobs, read a report, or reach any other route.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobStrategyName, MAX_LOG_BATCH, MAX_LOG_LINE, MAX_SUBMISSION_BODY, RESEARCH_FINAL, ResearchJobCreate, RunnerResult, type RunnerJob } from '@spw/core';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { RESEARCH_DIR } from '../agents/live.ts';
import { PERP_INTERVALS } from '../agents/perp-data.ts';
import type { PerpLabDeps } from '../agents/perp-strategies.ts';
import { agentSymbols, type AgentRow } from '../agents/routes.ts';
import { backtestSource } from '../agents/strategies.ts';
import { dropDataset, prepareDataset, runnerData } from './dataset.ts';
import { evaluateSubmission, restoreJobStrategies } from './evaluate.ts';
import { appendLog, jobList, loadJob, migrateResearch, move, newToken, sameSecret, sha256Hex, sysLog, type JobRow } from './store.ts';

export const RUNNER_PREFIX = '/api/v1/research/runner/';
const MAX_OPEN_JOBS = 6, MAX_STREAMS = 6, STREAM_MAX_MS = 10 * 60_000, RUNNER_LOST_MS = 5 * 60_000;
const runnerSecret = (): string | null => { const s = process.env.SPW_RESEARCH_RUNNER_SECRET; return s && s.length >= 32 ? s : null; };

/** The gate of the runner endpoints (called by server.ts INSTEAD of the owner-session check for these paths, and for no other). */
export function runnerGate(req: FastifyRequest): void {
  const secret = runnerSecret();
  if (!secret) throw new UserError('not_found', 'not found', 404);              // no runner configured: the endpoints do not exist
  const h = req.headers.authorization ?? '';
  if (req.method !== 'POST' || !h.startsWith('Bearer ') || !sameSecret(h.slice(7), secret)) throw new UserError('unauthenticated', 'authentication required', 401);
}

let labCommitCache: string | null | undefined;
/** the laboratory commit a job is pinned to: SPW_RESEARCH_LAB_COMMIT, else the HEAD of the deployed checkout, else none */
export function labCommit(): string | null {
  if (labCommitCache !== undefined) return labCommitCache;
  const env = process.env.SPW_RESEARCH_LAB_COMMIT;
  if (env !== undefined) return (labCommitCache = /^[0-9a-f]{7,40}$/.test(env) ? env : null);
  try { labCommitCache = execFileSync('git', ['-C', RESEARCH_DIR, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim(); if (!/^[0-9a-f]{40}$/.test(labCommitCache)) labCommitCache = null; } catch { labCommitCache = null; }
  return labCommitCache;
}

const view = (j: JobRow | Omit<JobRow, 'ledger' | 'submission' | 'server' | 'report' | 'dataset' | 'token_hash'>) => ({ id: j.id, agentId: j.agent_id, kind: j.kind, mission: j.mission, universe: j.universe, interval: j.interval, capitalUsd: j.capital_usd, budgets: j.budgets, tools: j.tools,
  state: j.state, reason: j.reason, strategy: `${j.strategy_name}/${j.strategy_version}`, labCommit: j.lab_commit, runnerId: j.runner_id, claimedAt: j.claimed_at, heartbeatAt: j.heartbeat_at, cancelRequested: j.cancel_requested,
  usage: j.usage, versionId: j.version_id, createdAt: j.created_at, updatedAt: j.updated_at, finishedAt: j.finished_at });

/** jobs whose runner stopped talking: failed, so they do not stay "running" for ever */
async function reapLost(): Promise<void> {
  const lost = await sql<{ id: string; state: 'preparing' | 'running' }[]>`select id, state from research_jobs where state in ('preparing', 'running') and coalesce(heartbeat_at, claimed_at) < ${new Date(Date.now() - RUNNER_LOST_MS)}`;
  for (const j of lost) if (await move(j.id, j.state, 'failed', { reason: 'the runner stopped reporting (no log line or heartbeat for 5 minutes)' })) { await sysLog(j.id, 'runner lost: job failed'); await audit('research.failed', 'research', { job: j.id, state: 'failed', reason: 'runner lost' }); }
}

export interface ResearchDeps { perp?: () => PerpLabDeps }
export async function researchRoutes(app: FastifyInstance, deps: ResearchDeps = {}): Promise<void> {
  await migrateResearch();
  await restoreJobStrategies().catch(() => 0); // a fresh checkout or a redeployment: the evaluated strategies are put back, byte for byte
  const P = '/api/v1/research';
  const evaluating = new Set<Promise<void>>();
  app.addHook('onClose', async () => { await Promise.allSettled([...evaluating]); });

  // ------------------------------------------------------------------------------------------------------------ owner
  app.get(`${P}/status`, async () => {
    const [r] = await sql<{ last: Date | null; open: number }[]>`select max(heartbeat_at) as last, (count(*) filter (where state in ('queued','preparing','running','evaluating')))::int as open from research_jobs`;
    return { runnerConfigured: runnerSecret() !== null, lastRunnerContact: r?.last ?? null, openJobs: r?.open ?? 0, maxOpenJobs: MAX_OPEN_JOBS, labCommit: labCommit() };
  });

  app.post(`${P}/jobs`, async (req) => {
    const b = ResearchJobCreate.parse(req.body);
    let agent: AgentRow | null = null, universe = b.universe, interval: string = b.interval, kind = b.kind;
    if (b.agentId) {
      [agent = null] = await sql<AgentRow[]>`select * from agents where id = ${b.agentId}`;
      if (!agent) throw new UserError('not_found', 'agent not found', 404);
      // a job for an agent develops a strategy for exactly what that agent trades
      kind = agent.kind === 'perp' ? 'perp' : 'spot'; universe = kind === 'perp' ? agent.universe : agentSymbols(agent); interval = agent.interval;
    }
    if (kind === 'perp') { if (!(PERP_INTERVALS as readonly string[]).includes(interval)) throw new UserError('bad_interval', `perpetual-futures jobs run at ${PERP_INTERVALS.join(' or ')}`, 422); if (universe.length > 8) throw new UserError('too_many_symbols', 'at most 8 perpetuals', 422); }
    else { if (!['1h', '1d'].includes(interval)) throw new UserError('bad_interval', 'spot jobs run at 1h or 1d', 422);
      if (!backtestSource(universe)) throw new UserError('no_data', `no single exchange lists every symbol (${universe.join(', ')}); the laboratory does not mix candle sources`, 422); }
    const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`select count(*)::int as n from research_jobs where state in ('queued', 'preparing', 'running', 'evaluating')`;
    if (n >= MAX_OPEN_JOBS) throw new UserError('too_many_jobs', `at most ${MAX_OPEN_JOBS} research jobs at once`, 429);
    const id = randomUUID();
    const [row] = await sql<JobRow[]>`insert into research_jobs (id, agent_id, kind, mission, universe, interval, capital_usd, budgets, tools, strategy_name, lab_commit)
      values (${id}, ${agent?.id ?? null}, ${kind}, ${b.mission}, ${sql.json(universe)}, ${interval}, ${b.capitalUsd}, ${sql.json(b.budgets as never)}, ${sql.json(b.tools)}, ${jobStrategyName(id)}, ${labCommit()}) returning *`;
    await audit('research.job_created', 'owner', { job: id, agent: agent?.id ?? null, kind, universe, interval, budgets: b.budgets });
    await sysLog(id, `job created by the owner: ${kind}, ${universe.join(', ')} at ${interval}; budgets ${b.budgets.wallSeconds} s, ${b.budgets.maxTrials} trials, ${b.budgets.maxDiskMb} MB, ${b.budgets.maxModelTokens} tokens, ${b.budgets.maxModelUsd} USD`);
    // freeze the data set now (the test split is cut off here); a job is only handed to a runner once its data are ready
    const p = prepareDataset(row!, deps.perp).then(async (ds) => { if (!ds.ready && await move(id, 'queued', 'failed', { reason: `no data set: ${ds.error}` })) await audit('research.failed', 'research', { job: id, agent: agent?.id ?? null, name: row!.strategy_name, state: 'failed', reason: String(ds.error).slice(0, 200) }); }).catch(() => {});
    evaluating.add(p); void p.finally(() => evaluating.delete(p));
    return { ...view(row!), runnerConfigured: runnerSecret() !== null };
  });

  app.get(`${P}/jobs`, async (req) => {
    const q = z.object({ agentId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    await reapLost();
    const rows = await sql<JobRow[]>`select ${jobList()}, server->>'status' as server_status, (server->'trials'->>'total')::int as trials_total, (server->>'deflatedSharpe')::float8 as deflated_sharpe, (server->>'claimsDiffer')::boolean as claims_differ
      from research_jobs ${q.agentId ? sql`where agent_id = ${q.agentId}` : sql``} order by created_at desc limit ${q.limit}`;
    return { jobs: rows.map((j) => ({ ...view(j), serverStatus: (j as never as { server_status: string | null }).server_status, trialsTotal: (j as never as { trials_total: number | null }).trials_total,
      deflatedSharpe: (j as never as { deflated_sharpe: number | null }).deflated_sharpe, claimsDiffer: (j as never as { claims_differ: boolean | null }).claims_differ })) };
  });

  app.get(`${P}/jobs/:id`, async (req) => {
    const j = await loadJob((req.params as { id: string }).id);
    await reapLost();
    const [v] = j.version_id ? await sql<{ id: string; status: string; notes: string; approved_at: Date | null }[]>`select id, status, notes, approved_at from strategy_versions where id = ${j.version_id}` : [];
    const [a] = j.agent_id ? await sql<{ id: string; name: string; state: string; kind: string }[]>`select id, name, state, kind from agents where id = ${j.agent_id}` : [];
    const r = j.report as Record<string, any> | null;
    return { ...view(j), holdout: j.dataset?.holdout ?? null, dataReady: j.dataset?.ready ?? null, dataError: j.dataset?.error ?? null,
      agent: a ?? null, version: v ?? null,
      /** written by the AI agent: statements, not measurements */
      submission: j.submission,
      /** measured by this server on its own data */
      server: j.server,
      report: r ? { splits: r.splits, config: r.config, metrics: r.metrics, benchmarks: r.benchmarks, robustness: r.robustness, checks: r.checks, equity_curve: r.equity_curve, research_job: r.research_job } : null };
  });

  app.post(`${P}/jobs/:id/cancel`, async (req) => {
    const j = await loadJob((req.params as { id: string }).id);
    if (RESEARCH_FINAL.includes(j.state)) throw new UserError('bad_state', `this job is already ${j.state}`, 409);
    if (j.state === 'evaluating') throw new UserError('bad_state', 'the agent has finished; the server is evaluating the submission', 409);
    if (j.state === 'queued') { if (await move(j.id, 'queued', 'cancelled', { reason: 'cancelled by the owner' })) dropDataset(j.id); }
    else await sql`update research_jobs set cancel_requested = true, updated_at = now() where id = ${j.id}`; // the runner kills the agent at its next report
    await audit('research.job_cancelled', 'owner', { job: j.id });
    await sysLog(j.id, 'cancel requested by the owner');
    return view(await loadJob(j.id));
  });

  const LogQ = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) });
  const readLog = (id: string, after: number, limit: number) => sql<{ id: string; ts: Date; stream: string; line: string }[]>`select id, ts, stream, line from research_job_log where job_id = ${id} and id > ${after} order by id limit ${limit}`;
  const logView = (r: { id: string; ts: Date; stream: string; line: string }) => ({ id: Number(r.id), ts: r.ts.getTime(), s: r.stream, t: r.line });
  app.get(`${P}/jobs/:id/log`, async (req) => {
    const j = await loadJob((req.params as { id: string }).id), q = LogQ.parse(req.query);
    return { state: j.state, lines: (await readLog(j.id, q.after, q.limit)).map(logView) };
  });
  // Server-Sent Events: `log` for each new line, `state` when it changes; ends with the job (or after ten minutes: the browser
  // reconnects through the session check with Last-Event-ID).
  let streams = 0;
  app.get(`${P}/jobs/:id/log/stream`, async (req, reply) => {
    const j = await loadJob((req.params as { id: string }).id);
    if (streams >= MAX_STREAMS) throw new UserError('too_many_streams', `at most ${MAX_STREAMS} log streams at once`, 429);
    let after = Math.max(LogQ.parse(req.query).after, Number(req.headers['last-event-id'] ?? 0) || 0), state = '', done = false, busy = false;
    streams += 1;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (chunk: string): void => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(chunk); };
    const end = (): void => { if (done) return; done = true; streams -= 1; clearInterval(poll); clearTimeout(stop); if (!reply.raw.writableEnded) reply.raw.end(); };
    const pass = async (): Promise<void> => {
      if (busy || done) return; busy = true;
      try {
        for (;;) { const rows = await readLog(j.id, after, 500); for (const r of rows) { after = Number(r.id); write(`id: ${after}\nevent: log\ndata: ${JSON.stringify(logView(r))}\n\n`); } if (rows.length < 500) break; }
        const [cur] = await sql<{ state: string; reason: string | null }[]>`select state, reason from research_jobs where id = ${j.id}`;
        if (cur && cur.state !== state) { state = cur.state; write(`event: state\ndata: ${JSON.stringify({ state: cur.state, reason: cur.reason })}\n\n`); }
        if (!cur || (RESEARCH_FINAL as readonly string[]).includes(cur.state)) { write('event: end\ndata: {}\n\n'); end(); }
      } catch { end(); } finally { busy = false; }
    };
    write('retry: 3000\n\n');
    const poll = setInterval(() => { void pass(); }, 1000), stop = setTimeout(end, STREAM_MAX_MS);
    poll.unref(); stop.unref();
    req.raw.on('close', end); reply.raw.on('close', end); reply.raw.on('error', end);
    void pass();
  });

  // ----------------------------------------------------------------------------------------------------------- runner
  const R = RUNNER_PREFIX.replace(/\/$/, '');
  /** the job of a runner call: the id in the path AND the token handed out when it was claimed */
  const jobOf = async (req: FastifyRequest): Promise<JobRow> => {
    const id = (req.params as { id: string }).id, token = String(req.headers['x-spw-job-token'] ?? '');
    const [j] = /^[0-9a-f-]{36}$/.test(id) ? await sql<JobRow[]>`select * from research_jobs where id = ${id}` : [];
    // one answer for "no such job", "not yours" and "finished": a runner learns nothing about other jobs
    if (!j || !j.token_hash || token.length < 32 || !sameSecret(sha256Hex(token), j.token_hash)) throw new UserError('forbidden', 'not your job', 403);
    return j;
  };

  app.post(`${R}/claim`, async (req) => {
    const b = z.strictObject({ runnerId: z.string().min(1).max(40).regex(/^[\w.-]+$/) }).parse(req.body);
    await reapLost();
    const token = newToken();
    const [j] = await sql<JobRow[]>`update research_jobs set state = 'preparing', token_hash = ${sha256Hex(token)}, runner_id = ${b.runnerId}, claimed_at = now(), heartbeat_at = now(), updated_at = now()
      where id = (select id from research_jobs where state = 'queued' and (dataset->>'ready')::boolean is true order by created_at limit 1 for update skip locked) returning *`;
    if (!j) return { job: null };
    let data;
    try { data = runnerData(j); } catch (e) { await move(j.id, 'preparing', 'failed', { reason: (e as Error).message.slice(0, 200) }); return { job: null }; }
    await sysLog(j.id, `claimed by runner "${b.runnerId}"`);
    const job: RunnerJob = { id: j.id, token, kind: j.kind, mission: j.mission, universe: j.universe, interval: j.interval, capitalUsd: j.capital_usd, budgets: j.budgets, tools: j.tools as RunnerJob['tools'],
      strategyName: j.strategy_name, strategyVersion: j.strategy_version, labCommit: j.lab_commit, holdout: j.dataset!.holdout!, data };
    return { job };
  });

  app.post(`${R}/jobs/:id/log`, async (req) => {
    const j = await jobOf(req);
    const b = z.strictObject({ lines: z.array(z.strictObject({ s: z.enum(['out', 'err', 'sys']), t: z.string().max(MAX_LOG_LINE) })).max(MAX_LOG_BATCH), state: z.literal('running').optional() }).parse(req.body);
    if (j.state !== 'preparing' && j.state !== 'running') throw new UserError('forbidden', 'not your job', 403);
    if (b.state === 'running' && j.state === 'preparing') await move(j.id, 'preparing', 'running');
    await appendLog(j.id, b.lines);
    await sql`update research_jobs set heartbeat_at = now() where id = ${j.id}`;
    return { cancel: j.cancel_requested };
  });

  app.post(`${R}/jobs/:id/result`, { bodyLimit: MAX_SUBMISSION_BODY }, async (req, reply) => {
    const j = await jobOf(req);
    if (j.state !== 'preparing' && j.state !== 'running') throw new UserError('forbidden', 'not your job', 403);
    const r = RunnerResult.parse(req.body);
    const ledger = r.outcome === 'submission' ? r.archive.ledger : r.ledger;
    await sql`update research_jobs set usage = ${sql.json(r.usage as never)}, ledger = ${ledger}, heartbeat_at = now() where id = ${j.id}`;
    if (r.outcome !== 'submission') {
      // an owner's cancel wins over whatever the runner says happened; nothing was submitted in any case
      const to = j.cancel_requested ? 'cancelled' : r.outcome;
      if (await move(j.id, j.state, to, { reason: to === 'cancelled' && r.outcome !== 'cancelled' ? 'cancelled by the owner' : r.reason })) {
        dropDataset(j.id);
        await sql`insert into research_log (agent_id, kind, title, body, data) values (${j.agent_id}, 'research', ${`Research job ${to.replace('_', ' ')}`}, ${r.reason}, ${sql.json({ job: j.id, usage: r.usage } as never)})`;
        if (to !== 'cancelled') await audit('research.failed', 'research', { job: j.id, agent: j.agent_id, name: j.strategy_name, state: to, reason: r.reason.slice(0, 200) });
      }
      return { ok: true, state: to };
    }
    if (j.cancel_requested) { if (await move(j.id, j.state, 'cancelled', { reason: 'cancelled by the owner' })) dropDataset(j.id); return { ok: true, state: 'cancelled' }; }
    if (j.state === 'preparing') await move(j.id, 'preparing', 'running');
    if (!(await move(j.id, 'running', 'evaluating'))) throw new UserError('forbidden', 'not your job', 403);
    await sysLog(j.id, `submission received from the runner (${r.usage.trials} trials, ${Math.round(r.usage.wallMs / 1000)} s, sandbox: ${r.usage.sandbox}); evaluating on the server`);
    const p = evaluateSubmission(j.id, r).then(() => { dropDataset(j.id); }).catch(() => {});
    evaluating.add(p); void p.finally(() => evaluating.delete(p));
    return reply.status(202).send({ ok: true, state: 'evaluating' });
  });
}

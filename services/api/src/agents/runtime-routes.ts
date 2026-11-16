// V11 agent panel — the owner's routes (session cookie + CSRF, like every /api/v1 route outside the trading API).
// Every read that touches a table shared by paper and live takes `mode` and answers ONE mode. No route here approves a mandate:
// going live hands over to the Risk screen — `/risk?mandate=<trading mandate id>` once the mandate was created from the draft
// (POST /agents/:id/perp/live/mandate, perp-routes.ts), `/risk?mandate=agent:<id>` before — or to the agent page's own passkey
// step, which approves the SAME trading mandate through the mandate service.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits } from '@spw/core';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { loopStats } from '../loop-stats.ts';
import { killSwitchState } from '../agent-runtime/kill-switch.ts';
import { listLeases } from '../agent-runtime/leases.ts';
import { FAMILY_MODES, liveVerdict, type Family } from '../agent-runtime/model.ts';
import { enqueue, getJob, jobView, queueStats } from '../agent-runtime/queue.ts';
import { agentJournal, agentOrders, agentPerformance, agentSignals, agentSummary, agentTimeline, configVersions, loadAgent, parseMode, type RuntimeAgentRow } from '../agent-runtime/store.ts';
import { pauseAgent, resumeAgent, startAgent, stopAgent, type Actor } from './lifecycle.ts';
import { bindExecution, executionBound } from './execution-bind.ts';
import { agentRuntime } from './runtime-bindings.ts';
import { createFromTemplate, templatesView, updateRuntimeConfig } from './templates.ts';

const Page = z.object({ mode: z.enum(['research', 'paper', 'live']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().positive().optional(), open: z.enum(['true', 'false']).optional() });
const idOf = (req: { params: unknown }): string => (req.params as { id: string }).id;
const OWNER: Actor = { kind: 'owner' };
const currentMode = (a: RuntimeAgentRow): 'research' | 'paper' | 'live' => (a.mode === 'LIVE' ? 'live' : a.mode === 'PAPER' ? 'paper' : 'research');

/** What the owner would have to approve for this agent to go live — the FIELDS, read-only. Nothing is prepared at the signer here. */
export async function mandateDraft(a: RuntimeAgentRow, locale: 'fr' | 'en' = 'en') {
  const family = (a.family ?? 'custom') as Family, kind = a.kind ?? 'spot', lv = liveVerdict(family, kind, a.universe);
  const base = { draft: `agent:${a.id}`, agentId: a.id, family, approval: { route: `/risk?mandate=agent:${a.id}`, note: 'the mandate is approved by the owner with the passkey; the signer judges the approval and enforces the mandate on every order' } };
  if (!lv.capable) return { ...base, available: false as const, code: lv.code, reason: lv.reason, fields: null };
  if (kind === 'perp') {
    const { liveReadiness } = await import('./perp-live-cycle.ts'), { perpRuntime } = await import('./perp-live.ts');
    const r = await liveReadiness(a as never, perpRuntime(), { locale }).catch((e: Error) => ({ error: e.message.slice(0, 200) }));
    // a trading mandate already created for this agent and not approved yet: the Risk screen shows it under its id
    const pend = (a as unknown as { perp?: { livePending?: { mandateId: string; accountId: string; unified?: boolean } } }).perp?.livePending;
    const [tm] = pend?.unified ? await sql<{ id: string; state: string }[]>`select id, state from trading_mandates where id = ${pend.mandateId} and principal_kind = 'agent' and principal_id = ${a.id}` : [];
    const pending = tm && ['created', 'pending_signer', 'active'].includes(tm.state) ? { mandateId: tm.id, state: tm.state, accountId: pend!.accountId } : null;
    return { ...base, approval: { ...base.approval, route: pending ? `/risk?mandate=${pending.mandateId}` : base.approval.route }, pending,
      create: !pending && !('error' in r) && r.next === 'mandate' && r.accountId ? { method: 'POST' as const, path: `/api/v1/agents/${a.id}/perp/live/mandate`, body: { accountId: r.accountId, locale } } : null,
      available: !('error' in r), kind: 'derivative' as const, shape: 'SPW-TRADING-MANDATE-v1 → SPW-VENUE-MANDATE-v1', readiness: 'error' in r ? null : { next: r.next, steps: r.steps, accounts: r.accounts }, fields: 'error' in r ? null : r.proposal, reason: 'error' in r ? r.error : null,
      existingFlow: 'agent page → Live: venue account, funding, then the mandate (one passkey)' };
  }
  if (kind === 'spot') {
    const r = a.risk as { maxOrderUsd?: number; maxDailyUsd?: number; maxOrdersPerDay?: number; slippageBps?: number; mandateDays?: number; maxLossPct?: number };
    const [v] = a.strategy_version_id ? await sql<{ code_sha256: string; status: string; approved_by: string | null }[]>`select code_sha256, status, approved_by from strategy_versions where id = ${a.strategy_version_id}` : [];
    return { ...base, available: !!v && v.status === 'approved', kind: 'spot' as const, shape: 'SPW-MANDATE-v1', reason: !v || v.status !== 'approved' ? 'no approved strategy version' : v.approved_by && v.approved_by !== 'owner' ? 'the strategy version was approved for paper by an API key: the owner must approve it first' : null,
      fields: { network: a.network, vaultIndex: (a as unknown as { vault_index: number }).vault_index, vault: (a as unknown as { vault_address: string }).vault_address, provider: 'kyberswap', symbols: a.universe, cash: a.cash ?? 'USDC',
        maxOrderUsd: r.maxOrderUsd ?? null, maxDailyUsd: r.maxDailyUsd ?? null, maxOrdersPerDay: r.maxOrdersPerDay ?? null, maxSlippageBps: r.slippageBps === undefined ? null : Math.min(500, Math.max(150, r.slippageBps + 80)), days: r.mandateDays ?? null,
        strategySha256: v?.code_sha256 ?? null, engineLossLimitPct: r.maxLossPct ?? null, note: 'USD caps become per-asset base-unit caps at the prices of the moment the mandate is prepared; the loss limit is the engine\'s, not the signer\'s' },
      existingFlow: 'agent page → Go live: mandate prepared from these limits, approved with the passkey' };
  }
  return { ...base, available: true as const, kind: 'none' as const, fields: null, reason: 'the risk-management agent holds no mandate: letting it act on LIVE agents is an owner action (start in live mode)' };
}

export async function overview(a: RuntimeAgentRow) {
  const jobs = await sql`select id, kind, state, attempts, max_attempts, run_at, last_error, result, created_at, finished_at from agent_jobs where agent_id = ${a.id} and kind <> 'tick' order by created_at desc limit 10`;
  const [tick] = await sql`select state, attempts, run_at, last_error, updated_at from agent_jobs where agent_id = ${a.id} and kind = 'tick' order by created_at desc limit 1`;
  const [lease] = await sql`select owner, heartbeat_at, expires_at, expires_at > now() as active from agent_leases where agent_id = ${a.id}`;
  const versions = await sql`select id, name, version, code_sha256, status, approved_by, notes, created_at, approved_at, report is not null as has_report, report->'checks' as checks, report->'config' as config, report->'metrics' as metrics, report->'robustness' as robustness
    from strategy_versions where agent_id = ${a.id} order by created_at desc limit 20`;
  const run = (a.runtime ?? {}) as { venues?: string[]; rule?: string; config?: unknown; counters?: unknown; hold?: unknown; backtest?: unknown; book?: { positions?: unknown; quotes?: unknown; pair?: unknown; realizedPnl?: number; fees?: number; funding?: number }; lastPass?: unknown };
  return { ...(await agentSummary(a)), familyModes: FAMILY_MODES[(a.family ?? 'custom') as Family],
    // BACKTEST reports: always labelled, never a performance figure
    backtests: { label: 'backtest', note: 'A backtest is a simulation on historical data under stated assumptions. It is not a track record and is never shown as performance.',
      versions: versions.map((v) => ({ id: v.id, name: v.name, version: v.version, sha256: v.code_sha256, status: v.status, approvedBy: v.approved_by, notes: v.notes, hasReport: v.has_report, checks: v.checks, config: v.config, metrics: v.metrics, robustness: v.robustness, createdAt: v.created_at, approvedAt: v.approved_at })),
      recorded: run.backtest ?? null },
    runtime: a.engine === 'bar' ? null : { venues: run.venues ?? [], rule: run.rule ?? null, config: run.config ?? {}, counters: run.counters ?? null, hold: run.hold ?? null, lastPass: run.lastPass ?? null,
      book: run.book ? { simulated: true, positions: run.book.positions ?? {}, quotes: run.book.quotes ?? [], pair: run.book.pair ?? null, realizedPnl: run.book.realizedPnl ?? 0, fees: run.book.fees ?? 0, funding: run.book.funding ?? 0 } : null },
    worker: { lease: lease ? { owner: lease.owner, heartbeatAt: lease.heartbeat_at, expiresAt: lease.expires_at, active: lease.active } : null, tick: tick ?? null },
    jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.state === 'dead' ? 'failed' : j.state, attempts: j.attempts, error: j.last_error, result: j.result, createdAt: j.created_at, finishedAt: j.finished_at })),
    killSwitch: await killSwitchState() };
}

export function runtimeRoutes(app: FastifyInstance): void {
  // a server instance binds the agents to ITS execution layer (orders, risk, mandates) once it is ready — unless the process
  // already bound that same instance (main.ts: bindAgentRuntime)
  app.addHook('onReady', async () => { if (app.hasDecorator('execution') && executionBound() !== app.execution) bindExecution(app.execution); });
  app.get('/api/v1/agents/templates', async () => ({ templates: await templatesView(), families: FAMILY_MODES }));
  app.post('/api/v1/agents/from-template', async (req) => createFromTemplate(req.body, 'owner'));

  app.get('/api/v1/agents/:id/overview', async (req) => overview(await loadAgent(idOf(req))));
  app.get('/api/v1/agents/:id/config-versions', async (req) => ({ versions: await configVersions((await loadAgent(idOf(req))).id) }));
  app.post('/api/v1/agents/:id/config', async (req) => updateRuntimeConfig(idOf(req), req.body, 'owner'));
  app.get('/api/v1/agents/:id/mandate-draft', async (req) => mandateDraft(await loadAgent(idOf(req)), z.object({ locale: z.enum(['fr', 'en']).default('en') }).parse(req.query).locale));

  // mode-scoped reads: `mode` defaults to the agent's CURRENT mode; one answer never carries two modes
  app.get('/api/v1/agents/:id/signals', async (req) => { const a = await loadAgent(idOf(req)), q = Page.parse(req.query), mode = parseMode(q.mode, currentMode(a)); return { mode, signals: await agentSignals(a.id, mode, q) }; });
  app.get('/api/v1/agents/:id/journal', async (req) => { const a = await loadAgent(idOf(req)), q = Page.parse(req.query), mode = parseMode(q.mode, currentMode(a)); return { mode, entries: await agentJournal(a.id, mode, q) }; });
  app.get('/api/v1/agents/:id/orders', async (req) => { const a = await loadAgent(idOf(req)), q = Page.parse(req.query), mode = parseMode(q.mode, currentMode(a)); return { mode, orders: await agentOrders(a, mode, { ...q, open: q.open === 'true' }) }; });
  app.get('/api/v1/agents/:id/performance', async (req) => { const a = await loadAgent(idOf(req)), q = Page.parse(req.query); return agentPerformance(a, parseMode(q.mode, currentMode(a))); });
  app.get('/api/v1/agents/:id/timeline', async (req) => { const a = await loadAgent(idOf(req)), q = Page.parse(req.query); return agentTimeline(a, parseMode(q.mode, currentMode(a)), q); });

  // life cycle: start (research | paper | live), pause, resume, stop. LIVE without an owner-approved mandate answers 409 mandate_required.
  app.post('/api/v1/agents/:id/start', async (req) => agentSummary(await startAgent(idOf(req), z.strictObject({ mode: z.enum(['research', 'paper', 'live']) }).parse(req.body).mode, OWNER)));
  app.post('/api/v1/agents/:id/pause', async (req) => agentSummary(await pauseAgent(idOf(req), OWNER, z.strictObject({ reason: z.string().max(200).default('') }).parse(req.body ?? {}).reason)));
  app.post('/api/v1/agents/:id/resume', async (req) => agentSummary(await resumeAgent(idOf(req), OWNER)));
  app.post('/api/v1/agents/:id/stop', async (req) => { const r = await stopAgent(idOf(req), OWNER, z.strictObject({ reason: z.string().max(200).default('') }).parse(req.body ?? {}).reason); return { ...(await agentSummary(r)), windDown: r.windDown ?? null }; });

  // backtests: asynchronous, through the job queue; the answer is a job id
  app.post('/api/v1/agents/:id/backtest', async (req) => {
    const a = await loadAgent(idOf(req)), b = z.strictObject({ versionId: z.uuid().optional(), hours: z.number().int().min(1).max(168).optional() }).parse(req.body ?? {});
    if (a.engine === 'supervisor') throw new UserError('wrong_kind', 'the risk-management agent has no backtest', 409);
    const j = await enqueue('backtest', { agentId: a.id, payload: a.engine === 'stream' ? { hours: b.hours ?? 24 } : { versionId: b.versionId ?? a.strategy_version_id }, dedupeKey: `backtest:${a.id}:${b.versionId ?? 'current'}` });
    await audit('agent.backtest_requested', 'owner', { id: a.id, job: j.id });
    return { job: jobView((await getJob(j.id))!), label: 'backtest' };
  });
  app.get('/api/v1/agents/jobs/:jobId', async (req) => { const j = await getJob(z.uuid().parse((req.params as { jobId: string }).jobId)); if (!j) throw new UserError('not_found', 'job not found', 404); return { job: jobView(j) }; });

  // the workers, as the monitor and the panel see them
  app.get('/api/v1/agents/runtime/status', async () => ({
    workers: { inProcess: !!agentRuntime(), worker: agentRuntime()?.worker ?? null, mode: process.env.SPW_WORKERS ?? 'on' },
    loops: [...loopStats.values()].filter((l) => l.name.startsWith('agent') || l.name === 'perp-agent-engine').map((l) => ({ name: l.name, everyMs: l.everyMs, runs: l.runs, lastOkAt: l.lastOkAt, lastErrorAt: l.lastErrorAt, lastError: l.lastError, failures: l.failures })),
    leases: await listLeases(), queue: await queueStats(), killSwitch: await killSwitchState(), streams: agentRuntime()?.stream?.marketStatus() ?? [], streamStats: agentRuntime()?.stream?.stats ?? null }));

  // THE kill switch (the risk engine's — there is no other). Engaging from the Agents panel is a thin alias of
  // POST /api/v1/risk/kill-switch: it only removes the ability to add risk. There is NO release here: the switch is released
  // with the owner's passkey in the Risk screen (/api/v1/risk/kill-switch/release/prepare → release).
  app.post('/api/v1/agents/kill-switch/engage', async (req) => { const b = z.strictObject({ reason: z.string().min(3).max(200) }).parse(req.body); await app.execution.risk.engageKillSwitch({ kind: 'owner', id: 'owner' }, b.reason); return killSwitchState(); });
}
export const capitalUsd = (a: RuntimeAgentRow): string => formatUnits(BigInt(a.capital_usdc), 6);

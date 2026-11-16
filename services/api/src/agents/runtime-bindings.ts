// Composition root of the agent runtime: the REAL engines, data and services bound to the scheduler's handlers, to the order
// gateway factory and to the kill switch port. main.ts (in-process workers) and agent-worker-main.ts (separate process) call
// `bindAgentRuntime()` and nothing else.
//
// BOUND TO THE EXECUTION LAYER (V11.2): `execution` is required. `bindExecution` (execution-bind.ts) binds
//   the order gateway factory  →  `unifiedGatewayFactory(execution)`: perp agents through orders.submitCanonical
//   the kill switch            →  `riskKillSwitch(execution)`: the risk engine's switch — the only one
import type { Position } from '@spw/derivatives';
import { sql } from '../db.ts';
import { derivatives } from '../derivatives/index.ts';
import type { OrderGatewayFactory } from '../agent-runtime/gateway.ts';
import type { KillSwitchPort } from '../agent-runtime/kill-switch.ts';
import type { Execution } from '../orders/index.ts';
import { bindExecution } from './execution-bind.ts';
import { RULES } from '../agent-runtime/model.ts';
import type { JobRow } from '../agent-runtime/queue.ts';
import { createAgentRuntime, derivFeed, type AgentRuntime, type RuntimeHandlers, type RuntimeOptions, type SnapshotAgent } from '../agent-runtime/scheduler.ts';
import { replayRecorded, type StreamAgentRow } from '../agent-runtime/stream-engine.ts';
import { loadAgent } from '../agent-runtime/store.ts';
import { onAgentChange, pauseAgent } from './lifecycle.ts';
import { recordSpotTickError, revokeStaleMandates, spotAgentsToTick, tickSpotAgentOnce, type MarketDeps } from './live.ts';
import type { PerpInterval } from './perp-data.ts';
import { tickPerpAgent, type PerpAgentRow } from './perp-engine.ts';
import { perpRuntime, type PerpRuntime } from './perp-live.ts';
import { tickLivePerpAgent } from './perp-live-cycle.ts';
import type { AgentRow } from './routes.ts';

export interface BindOptions { market: MarketDeps;
  /** the execution layer of this process (orders, risk, mandates): the agents' ONE order path and ONE kill switch */
  execution: Execution; perp?: () => PerpRuntime; gateway?: OrderGatewayFactory; killSwitch?: KillSwitchPort; emit?: (event: 'agent.updated' | 'risk.kill_switch' | 'risk.proposal', data: Record<string, unknown>) => Promise<unknown>; runtime?: RuntimeOptions; stream?: boolean }

const symbolOf = (instrument: string): string => instrument.slice(instrument.indexOf(':') + 1);
function exposure(positions: Position[]): { grossUsd: number; minLiquidationDistanceBps: number | null } {
  let gross = 0, min: number | null = null;
  for (const p of positions) {
    const mark = Number(p.markPrice), size = Number(p.size);
    gross += Math.abs(size) * mark;
    if (p.liquidationPrice !== null && mark > 0) { const d = (Math.abs(mark - Number(p.liquidationPrice)) / mark) * 1e4; min = min === null ? d : Math.min(min, d); }
  }
  return { grossUsd: gross, minLiquidationDistanceBps: min };
}

export function runtimeHandlers(o: BindOptions): RuntimeHandlers {
  const rt = o.perp ?? perpRuntime;
  const emit = o.emit ?? (async () => {});
  return {
    spotAgents: async () => (await spotAgentsToTick()).map((a) => ({ id: a.id, kind: a.kind ?? 'spot', engine: a.engine ?? 'bar', state: a.state, mode: a.mode, name: a.name })),
    perpAgents: async () => sql`select id, kind, engine, state, mode, name from agents where kind = 'perp' and ((state = 'PAPER_TRADING' and mode <> 'LIVE') or (mode = 'LIVE' and state in ('LIVE', 'PAUSED', 'STOPPING'))) order by created_at`,
    beforeSpotPass: async (now) => { await revokeStaleMandates(undefined, now); },
    async tickSpot(agentId, now) {
      const [a] = await sql<AgentRow[]>`select * from agents where id = ${agentId}`;
      if (!a || a.kind === 'perp' || (a.state !== 'PAPER_TRADING' && a.state !== 'LIVE')) return 'idle';
      try { return await tickSpotAgentOnce(a, o.market, now); } catch (e) { await recordSpotTickError(a, e); throw e; }
    },
    async tickPerp(agentId) {
      const [a] = await sql<PerpAgentRow[]>`select * from agents where id = ${agentId}`;
      if (!a || a.kind !== 'perp') return 'idle';
      try { return a.mode === 'LIVE' ? await tickLivePerpAgent(a, rt()) : await tickPerpAgent(a, rt().deps); }
      catch (e) { await sql`insert into research_log (agent_id, kind, title, body, severity, code) values (${a.id}, 'hold', 'Engine pass interrupted', ${(e as Error).message.slice(0, 300)}, 'error', 'tick_error')`.catch(() => {}); throw e; }
    },
    backtest: (job) => runBacktestJob(job, rt),
    async windDown(job) {
      const [a] = await sql<PerpAgentRow[]>`select * from agents where id = ${job.agent_id}`;
      if (!a || a.kind !== 'perp' || a.mode !== 'LIVE' || a.state !== 'STOPPING') return { state: a?.state ?? 'gone' };
      const r = await tickLivePerpAgent(a, rt());
      const [now] = await sql<{ state: string }[]>`select state from agents where id = ${a.id}`;
      if (now?.state === 'STOPPING') throw new Error(`still winding down: ${r}`);            // retried with backoff until the agent is flat (or nothing can be signed)
      return { state: now?.state, result: r };
    },
    async snapshot(a: SnapshotAgent) {
      if (a.kind === 'perp') {
        const lb = (a.perp as { live?: { accountId: string } } | null)?.live;
        if (a.mode === 'LIVE' && lb) {
          const { mandateAccountState } = await import('../derivatives/mandate.ts');
          const s = await mandateAccountState(lb.accountId, rt().live());
          if (s.error !== null) return { unreadable: s.error.slice(0, 160) };
          const [f] = await sql<{ sum: number | null }[]>`select sum(amount)::float as sum from deriv_funding where account_id = ${lb.accountId} and ts > now() - interval '24 hours'`;
          return { ...exposure(s.positions), funding24hUsd: f?.sum ?? 0, ...(s.state ? { equityUsd: Number(s.state.equity) } : {}) };
        }
        if (!a.deriv_account_id) return {};
        const acct = await rt().deriv.paper.get(a.deriv_account_id);
        const [f] = await sql<{ sum: number | null }[]>`select sum(amount)::float as sum from deriv_funding where account_id = ${a.deriv_account_id} and ts > now() - interval '24 hours'`;
        return { ...exposure(acct.positions), funding24hUsd: f?.sum ?? 0 };
      }
      if (a.kind === 'stream') {
        const book = a.runtime?.book as { positions?: Record<string, { size: number; avgPrice: number }> } | undefined;
        return { grossUsd: Object.values(book?.positions ?? {}).reduce((s, p) => s + Math.abs(p.size) * p.avgPrice, 0) };
      }
      // spot: what is not the cash leg, from the last equity point of the agent's CURRENT mode
      const [e] = await sql<{ equity_usd: number; positions: Record<string, number> }[]>`select equity_usd, positions from agent_equity where agent_id = ${a.id} and mode = ${a.mode} order by ts desc limit 1`;
      if (!e) return {};
      const cash = Object.entries(e.positions).filter(([k]) => k === 'USDC' || k === 'USDT').reduce((s, [, v]) => s + Number(v), 0);
      return { grossUsd: Math.max(0, e.equity_usd - cash) };
    },
    pause: async (agentId, reason, supervisorId) => { await pauseAgent(agentId, { kind: 'agent', id: supervisorId }, reason); },
    notify: async (event, data) => { await emit(event, data); },
    ...(o.stream === false ? {} : { feed: derivFeed(derivatives().data as never) }),
  };
}

/** A backtest job. Bar agents: the laboratory's backtest of a registered strategy version (the existing path, asynchronous).
 *  Stream agents: the rule replayed on the snapshots the stream engine recorded. The result is a REPORT, never a performance. */
async function runBacktestJob(job: JobRow, rt: () => PerpRuntime): Promise<unknown> {
  const a = await loadAgent(String(job.agent_id));
  if (a.engine === 'stream') {
    const run = a.runtime as unknown as StreamAgentRow['runtime'], hours = Math.min(Math.max(Number(job.payload.hours ?? 24), 1), 24 * 7), feed = derivFeed(rt().deriv.data as never), to = Date.now();
    if (!RULES[run.rule]) throw new Error(`unknown rule ${run.rule}`);
    const instruments = [];
    for (const v of run.venues) { const i = await feed.resolve(v, a.universe[0]!); if (!i) throw new Error(`${v} does not list a perpetual on ${a.universe[0]}`); instruments.push(i); }
    const report = await replayRecorded({ rule: run.rule, config: run.config, risk: a.risk as never, capital: Number(a.capital_usdc) / 1e6, instruments, fees: feed.fees, from: to - hours * 3_600_000, to });
    await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ backtest: { ...report, performance: { ...report.performance, equityCurve: report.performance.equityCurve.slice(-500), returns: [] }, generatedAt: to, job: job.id } } as never)}, updated_at = now() where id = ${a.id}`;
    return { kind: report.kind, label: 'backtest', snapshots: report.snapshots, missing: report.missing, warnings: report.warnings };
  }
  const versionId = String(job.payload.versionId ?? a.strategy_version_id ?? '');
  const [v] = await sql<{ id: string; path: string; code_sha256: string; status: string; meta: { kind?: string; symbols?: string[] } }[]>`select id, path, code_sha256, status, meta from strategy_versions where id = ${versionId} and agent_id = ${a.id}`;
  if (!v) throw new Error('strategy version not found for this agent');
  if (v.status === 'approved' || v.status === 'retired') return { status: v.status, note: 'an approved version keeps the report it was approved with; register the version again on another agent to backtest it anew' };
  const rel = v.path.replace(/^strategies\//, '');
  await sql`update strategy_versions set status = 'draft' where id = ${v.id} and status = 'backtesting'`;   // a run that died with its process
  if (a.kind === 'perp') {
    const { describePerp, perpBacktest } = await import('./perp-strategies.ts'); const info = await describePerp(rel);
    if (info.sha256 !== v.code_sha256) throw new Error('the strategy file changed since it was registered (another hash): register it again');
    await perpBacktest(v.id, info, a.universe, a.interval as PerpInterval, rt().lab);
  } else {
    const { backtest, describe } = await import('./strategies.ts'); const info = await describe(rel);
    if (info.sha256 !== v.code_sha256) throw new Error('the strategy file changed since it was registered (another hash): register it again');
    await backtest(v.id, info, a.universe.filter((s) => s !== 'USDC' && s !== 'USDT'));
  }
  const [after] = await sql<{ status: string; notes: string; has_report: boolean }[]>`select status, notes, report is not null as has_report from strategy_versions where id = ${v.id}`;
  if (!after?.has_report) throw new Error(after?.notes || 'the backtest produced no report');
  return { status: after.status, hasReport: true, versionId: v.id, label: 'backtest' };
}

let current: AgentRuntime | null = null;
/** Bind the gateway, the kill switch and the webhook emitter, and build the runtime. Idempotent per process. */
export function bindAgentRuntime(o: BindOptions): AgentRuntime {
  const emit = o.emit ?? (async () => {});
  // tests may pass their own gateway factory or kill switch port; production passes neither
  bindExecution(o.execution, { ...(o.gateway ? { gateway: o.gateway } : {}), ...(o.killSwitch ? { killSwitch: o.killSwitch } : {}) });
  onAgentChange(async (a) => { await emit('agent.updated', { agentId: a.id, kind: a.kind ?? 'spot', state: a.state, mode: a.mode }); });
  current = createAgentRuntime(runtimeHandlers(o), o.runtime);
  return current;
}
export const agentRuntime = (): AgentRuntime | null => current;
export { symbolOf };

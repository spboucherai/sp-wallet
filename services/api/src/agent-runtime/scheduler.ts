// Persistent agent workers (V11). The agents never depended on a browser; what this adds is isolation and a second process.
//
//   every pass   1. reap jobs whose worker died   2. one `tick` job per runnable agent (a database constraint keeps it to one)
//                3. claim due jobs (`for update skip locked`) and run them CONCURRENTLY, each under its agent's LEASE and with
//                   a deadline — a slow or failing agent delays nobody (audit D7), and two processes never tick one agent
//   on failure   the job goes back to the queue with a backoff (it survives a restart, unlike the old in-memory map); after
//                `max_attempts` it is dead-lettered: journaled on the agent (an alert follows) and counted by the monitor
//   heartbeats   `agent-engine`, `perp-agent-engine` (the names the monitor and the `system.worker_failing` alert already
//                know), `agent-stream-engine`, `agent-supervisor`
//
// Where it runs: `startAgentRuntime` is called by the API process (main.ts, SPW_WORKERS=on — the default, as before) or by the
// separate worker process (agent-worker-main.ts, SPW_WORKERS=agents). Both may run at once: the leases and the queue decide.
import { hostname } from 'node:os';
import type { Instrument, VenueId } from '@spw/derivatives';
import { routerFeeSchedule } from '@spw/trading';
import { sql } from '../db.ts';
import { engineLoop, heartbeat } from '../loop-stats.ts';
import { journal } from './journal.ts';
import { killSwitch } from './kill-switch.ts';
import { acquireLease, newWorkerId, releaseLease, renewLease, withLease, type Lease } from './leases.ts';
import { apiMode, lifecycleOf } from './model.ts';
import { claim, complete, enqueue, fail, reap, type JobKind, type JobRow } from './queue.ts';
import { supervise, type AgentSnapshot, type Finding, type SupervisorLimits, type SupervisorPorts, type SupervisorState } from './risk-supervisor.ts';
import { StreamEngine, type FeedEvent, type StreamAgentRow, type StreamFeed, type StreamOptions } from './stream-engine.ts';

export interface AgentRowLite { id: string; kind: string | null; engine: string; state: string; mode: string; name: string }
/** What the scheduler needs from the engines. main.ts binds the real ones (agents/runtime-bindings.ts); tests bind fakes. */
export interface RuntimeHandlers {
  /** agents the spot / perp engines must tick now */
  spotAgents(): Promise<AgentRowLite[]>; perpAgents(): Promise<AgentRowLite[]>;
  /** one engine step of one agent; throws on an error */
  tickSpot(agentId: string, now: number): Promise<string>; tickPerp(agentId: string, now: number): Promise<string>;
  /** before a spot pass: mandates no live agent holds are revoked at the signer (V11 Phase B) */
  beforeSpotPass?(now: number): Promise<void>;
  /** job handlers of the other kinds */
  backtest?(job: JobRow): Promise<unknown>; windDown?(job: JobRow): Promise<unknown>;
  /** the supervisor's view of one agent and its two permitted actions */
  snapshot?(a: SnapshotAgent): Promise<Partial<AgentSnapshot>>; pause?(agentId: string, reason: string, supervisorId: string): Promise<void>;
  notify?(event: 'risk.proposal', data: Record<string, unknown>): Promise<void>;
  feed?: StreamFeed;
}
export interface SnapshotAgent { id: string; name: string; kind: string | null; mode: string; state: string; capital_usdc: string; deriv_account_id: string | null; perp: unknown; runtime: Record<string, unknown> | null }
export interface RuntimeOptions { workerId?: string; concurrency?: number; tickTimeoutMs?: number; now?: () => number; stream?: StreamOptions; leaseTtlMs?: number }
export const TICK_TIMEOUT_MS = 150_000;

export function createAgentRuntime(h: RuntimeHandlers, o: RuntimeOptions = {}) {
  const worker = o.workerId ?? newWorkerId(process.env.SPW_WORKERS === 'agents' ? 'agents' : 'api'), now = o.now ?? Date.now;
  const concurrency = o.concurrency ?? 4, deadline = o.tickTimeoutMs ?? TICK_TIMEOUT_MS;
  /** the queue's clock: the DATABASE's own (`now()`) unless a clock was injected — a job enqueued with the database's microsecond clock must not
   *  look "not due yet" to a JavaScript millisecond read in the same instant */
  const qnow = (): number | undefined => (o.now ? now() : undefined);
  const stream = h.feed ? new StreamEngine(h.feed, o.stream) : null, streamLeases = new Map<string, Lease>();
  /** ticks still running after their deadline: their lease is kept until they really end */
  const overrun = new Set<Promise<unknown>>();

  async function runJob(job: JobRow, handler: () => Promise<unknown>): Promise<string> {
    const t = now();
    const real = job.agent_id
      ? withLease(job.agent_id, worker, handler, { ...(o.now ? { now: o.now } : {}), ...(o.leaseTtlMs ? { ttlMs: o.leaseTtlMs } : {}) })
      : handler().then((value) => ({ held: true as const, value }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), deadline); timer.unref(); });
    try {
      const r = await Promise.race([real, late]);
      if (r === 'timeout') {
        // the engine step cannot be interrupted: it keeps its lease until it ends (nobody else may tick this agent meanwhile); the JOB is failed
        const p = real.catch(() => {}).finally(() => overrun.delete(p)); overrun.add(p);
        const st = await fail(job, worker, `the ${job.kind} did not finish within ${deadline} ms`, qnow());
        if (job.agent_id) await journal(job.agent_id, { kind: 'error', code: 'tick_timeout', severity: 'error', title: `Engine ${job.kind} timed out`, body: `after ${deadline} ms; ${st === 'dead' ? 'dead-lettered' : 'it will be retried'}`, ref: { job: job.id } });
        return `error: timed out after ${deadline} ms`;
      }
      if (!r.held) { await complete(job, worker, { skipped: 'leased by another worker' }, qnow()); return 'leased by another worker'; }
      await complete(job, worker, r.value ?? null, qnow());
      return typeof r.value === 'string' ? r.value : 'done';
    } catch (e) {
      const msg = (e as Error).message ?? String(e), st = await fail(job, worker, msg, qnow());
      if (job.agent_id && st === 'dead') await journal(job.agent_id, { kind: 'error', code: 'job_dead_letter', severity: 'error', title: `${job.kind} job dead-lettered after ${job.attempts} attempt(s)`, body: msg.slice(0, 300), ref: { job: job.id }, data: { ms: now() - t } });
      return `error: ${msg.slice(0, 160)}`;
    } finally { if (timer) clearTimeout(timer); }
  }

  /** claim and run every due job of these kinds; jobs run `concurrency` at a time, in isolation */
  async function drain(kinds: readonly JobKind[], handlerOf: (j: JobRow) => (() => Promise<unknown>) | null, limit = 200): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let seen = 0;
    for (;;) {
      const jq = qnow(), jobs = await claim(worker, { kinds, limit: concurrency, ...(jq === undefined ? {} : { now: jq }) });
      if (!jobs.length || seen >= limit) break;
      seen += jobs.length;
      await Promise.all(jobs.map(async (j) => {
        const fn = handlerOf(j);
        const r = fn ? await runJob(j, fn) : await fail(j, worker, `no handler for ${j.kind}`, qnow()).then(() => 'error: no handler');
        out[j.agent_id ?? j.id] = r;
      }));
    }
    return out;
  }

  // the two bar engines share the `tick` kind: each pass only runs ITS jobs and leaves the other engine's in the queue
  const tickPass = async (engine: 'spot' | 'perp'): Promise<Record<string, string>> => {
    const t = now();
    if (engine === 'spot') await h.beforeSpotPass?.(t).catch(() => {});
    const agents = engine === 'spot' ? await h.spotAgents() : await h.perpAgents();
    const tq = qnow(), at = tq === undefined ? null : new Date(tq);
    for (const a of agents) await enqueue('tick', { agentId: a.id, payload: { engine }, dedupeKey: `tick:${a.id}`, ...(tq === undefined ? {} : { runAt: tq }) });
    const mine = new Set(agents.map((a) => a.id)), out: Record<string, string> = {};
    const due = await sql<JobRow[]>`select * from agent_jobs where state = 'queued' and kind = 'tick' and payload->>'engine' = ${engine} and run_at <= coalesce(${at}, now()) order by run_at limit 500`;
    const ids = due.map((j) => j.id);
    for (let i = 0; i < ids.length; i += concurrency) {
      const claimed = await claimIds(ids.slice(i, i + concurrency));
      await Promise.all(claimed.map(async (j) => { out[j.agent_id!] = await runJob(j, () => (engine === 'spot' ? h.tickSpot(j.agent_id!, now()) : h.tickPerp(j.agent_id!, now()))); }));
    }
    for (const id of mine) out[id] ??= 'backing off after an error';
    return out;
  };
  async function claimIds(ids: string[]): Promise<JobRow[]> {
    if (!ids.length) return [];
    const tq = qnow(), at = tq === undefined ? null : new Date(tq);
    return sql<JobRow[]>`update agent_jobs set state = 'running', attempts = attempts + 1, locked_by = ${worker}, locked_until = coalesce(${at}, now()) + interval '180 seconds', updated_at = coalesce(${at}, now())
      where id in ${sql(ids)} and state = 'queued' returning *` as unknown as Promise<JobRow[]>;
  }

  /** the other job kinds: backtests and wind-downs asked for through the API */
  const jobsPass = async (): Promise<Record<string, string>> => {
    const r = await reap(qnow());
    for (const j of r.dead) if (j.agent_id) await journal(j.agent_id, { kind: 'error', code: 'job_dead_letter', severity: 'error', title: `${j.kind} job dead-lettered: its worker stopped answering`, body: j.last_error ?? '', ref: { job: j.id } });
    return drain(['backtest', 'wind_down'], (j) => (j.kind === 'backtest' && h.backtest ? () => h.backtest!(j) : j.kind === 'wind_down' && h.windDown ? () => h.windDown!(j) : null));
  };

  /** stream agents: a lease held across passes (renewed every pass), then the stream engine's own pass */
  const streamPass = async (): Promise<Record<string, string>> => {
    if (!stream) return {};
    const agents = await sql<StreamAgentRow[]>`select id, name, state, mode, kind, engine, family, universe, risk, capital_usdc::text as capital_usdc, config_version, runtime from agents where engine = 'stream' and state in ('PAPER_TRADING', 'RUNNING') order by created_at`;
    const active = new Set(agents.map((a) => a.id)), t = o.now ? now() : undefined;
    for (const [id, l] of streamLeases) if (!active.has(id)) { await releaseLease(l, t).catch(() => {}); streamLeases.delete(id); }
    const mine: StreamAgentRow[] = [];
    for (const a of agents) {
      let l = streamLeases.get(a.id);
      if (l && !(await renewLease(l, { ttlMs: 30_000, ...(t === undefined ? {} : { now: t }) }))) { streamLeases.delete(a.id); l = undefined; }
      if (!l) { l = (await acquireLease(a.id, worker, { ttlMs: 30_000, ...(t === undefined ? {} : { now: t }) })) ?? undefined; if (l) streamLeases.set(a.id, l); }
      if (l) mine.push(a);
    }
    if (!agents.length) stream.retain(new Set());
    return stream.pass(mine);
  };

  /** the risk-management agent(s) */
  const supervisorPass = async (): Promise<Record<string, string>> => {
    const sups = await sql<{ id: string; name: string; mode: string; risk: SupervisorLimits; runtime: { config?: { act?: boolean }; supervisor?: SupervisorState } | null }[]>`select id, name, mode, risk, runtime from agents where engine = 'supervisor' and state = 'RUNNING' order by created_at`;
    const out: Record<string, string> = {};
    for (const s of sups) {
      const r = await withLease(s.id, worker, async () => {
        const ports: SupervisorPorts = {
          now, killSwitch: killSwitch(),
          snapshots: () => snapshots(s.id),
          pause: async (agentId, reason) => { if (!h.pause) throw new Error('no pause handler bound'); await h.pause(agentId, reason, s.id); },
          propose: (f, acted, note) => propose(s.id, f, acted, note),
        };
        const res = await supervise({ mode: apiMode(s.mode), act: s.runtime?.config?.act === true, limits: s.risk }, s.runtime?.supervisor ?? {}, ports);
        await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ supervisor: res.state, lastPass: { ts: now(), findings: res.findings.length, actions: res.actions } } as never)}, last_bar = ${new Date(now())}, updated_at = now() where id = ${s.id}`;
        return `${res.findings.length} finding(s), ${res.actions.filter((a) => a.action === 'paused' || a.action === 'kill_switch').length} action(s)`;
      }, { ...(o.now ? { now: o.now } : {}) }).catch((e: Error) => ({ held: true as const, value: `error: ${e.message.slice(0, 160)}` }));
      out[s.id] = r.held ? r.value : 'leased by another worker';
    }
    return out;
  };

  async function snapshots(self: string): Promise<AgentSnapshot[]> {
    const rows = await sql<SnapshotAgent[]>`select id, name, kind, mode, state, capital_usdc::text as capital_usdc, deriv_account_id, perp, runtime from agents where id <> ${self} and engine <> 'supervisor' and mode in ('PAPER', 'LIVE') and state not in ('STOPPED', 'CREATED', 'AWAITING_APPROVAL', 'FAILED')`;
    const day = new Date(now()); day.setUTCHours(0, 0, 0, 0);
    const out: AgentSnapshot[] = [];
    for (const a of rows) {
      // every figure below is read for the agent's CURRENT mode only
      const [e] = await sql<{ last: number | null; peak: number | null; day_start: number | null }[]>`select (select equity_usd from agent_equity where agent_id = ${a.id} and mode = ${a.mode} order by ts desc limit 1) as last,
        (select max(equity_usd) from agent_equity where agent_id = ${a.id} and mode = ${a.mode}) as peak,
        coalesce((select equity_usd from agent_equity where agent_id = ${a.id} and mode = ${a.mode} and ts < ${day} order by ts desc limit 1), (select equity_usd from agent_equity where agent_id = ${a.id} and mode = ${a.mode} and ts >= ${day} order by ts limit 1)) as day_start`;
      const extra = await (h.snapshot?.(a).catch((err: Error) => ({ unreadable: err.message.slice(0, 160) })) ?? Promise.resolve({}));
      out.push({ agentId: a.id, name: a.name, mode: a.mode === 'LIVE' ? 'live' : 'paper', lifecycle: lifecycleOf(a.state), capitalUsd: Number(a.capital_usdc) / 1e6, equityUsd: e?.last ?? null, peakEquityUsd: e?.peak ?? null, dayStartEquityUsd: e?.day_start ?? null,
        grossUsd: null, minLiquidationDistanceBps: null, funding24hUsd: null, unreadable: null, ...extra });
    }
    return out;
  }
  async function propose(self: string, f: Finding, acted: string, note: string): Promise<void> {
    const mode = f.mode === 'live' ? 'LIVE' : 'PAPER', title = acted === 'paused' ? 'Risk manager: agent PAUSED' : acted === 'kill_switch' ? 'Risk manager: KILL SWITCH engaged' : `Risk manager proposes: ${f.action === 'reduce' ? 'reduce' : f.action === 'pause' ? 'pause' : 'kill switch'}`;
    await journal(self, { mode, kind: 'proposal', code: f.code, severity: f.severity, title, body: `${f.message} — ${note}`, data: { finding: f, acted }, ref: f.agentId ? { agent: f.agentId } : null });
    if (f.agentId) await journal(f.agentId, { mode, kind: 'risk', code: `supervisor_${f.code}`, severity: f.severity, title, body: `${f.message} — ${note}`, ref: { supervisor: self } });
    await h.notify?.('risk.proposal', { supervisorId: self, agentId: f.agentId, mode: f.mode, action: f.action, code: f.code, acted, message: f.message, metrics: f.metrics }).catch(() => {});
  }

  return {
    worker, stream, tickPass, jobsPass, streamPass, supervisorPass, snapshots, overrun,
    /** start the loops; returns the stop function */
    start(every: { barMs?: number; streamMs?: number; supervisorMs?: number; jobsMs?: number } = {}): () => void {
      const stops = [
        engineLoop('agent-engine', every.barMs ?? 60_000, () => tickPass('spot')),
        engineLoop('perp-agent-engine', every.barMs ?? 60_000, () => tickPass('perp')),
        engineLoop('agent-jobs', every.jobsMs ?? 5_000, jobsPass),
        engineLoop('agent-supervisor', every.supervisorMs ?? 60_000, supervisorPass),
        ...(stream ? [engineLoop('agent-stream-engine', every.streamMs ?? 1_000, streamPass)] : []),
      ];
      const hb = heartbeat('agent-runtime', 60_000); hb.start(); hb.ok();
      return () => { for (const s of stops) s(); stream?.close(); for (const l of streamLeases.values()) void releaseLease(l).catch(() => {}); streamLeases.clear(); };
    },
  };
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;

/** The market-data side of the stream engine on the derivatives data service (WebSocket where the venue has one, polling otherwise). */
export function derivFeed(data: { now: () => number; instruments(venue: VenueId): Promise<{ value: Instrument[] }>; subscribe(inst: Instrument, l: (ev: never) => void): () => void }): StreamFeed {
  return {
    now: data.now,
    async resolve(venue, base) {
      const list = (await data.instruments(venue as VenueId)).value.filter((i) => i.base === base && i.status === 'active');
      // one perpetual per base asset and venue: the USD-quoted one first (a venue may also list a second collateral)
      return list.find((i) => ['USD', 'USDC', 'USDT'].includes(i.quote)) ?? list[0] ?? null;
    },
    subscribe: (inst, on) => data.subscribe(inst, on as (ev: never) => void),
    fees: (venue) => { try { return routerFeeSchedule(venue as VenueId); } catch { return null; } },
  };
}
export const runtimeHost = (): string => hostname();
export type { FeedEvent };

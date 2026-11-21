/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agent-runtime/queue.ts
 * Module           : agent-runtime
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-17
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

// Durable job queue of the agents (table agent_jobs): `tick`, `backtest`, `wind_down`, `supervise`, `stream`.
//
//   enqueue    a row; `dedupeKey` makes "one pending job of this kind for this agent" a database constraint (partial unique index)
//   claim      `for update skip locked`: N workers never take the same job; a claimed job is locked until `locked_until`
//   complete   state done (+ result)
//   fail       attempts < max → back to `queued` at now + backoff(attempt) (exponential, capped); else `dead` — the dead-letter
//              state: it stays in the table with its last error, is counted by the monitor and journaled on the agent
//   reap       a job whose worker died (lock expired) goes back to `queued`, attempts counted — or to `dead` at the limit
//
// A job never carries a secret, an order or a signature: it says WHAT to do (tick agent X); the handler reads the truth from
// the database when it runs. Handlers must be idempotent — the engines are (one decision per bar, deterministic client ids).
import { randomUUID } from 'node:crypto';
import { sql } from '../db.ts';

export const JOB_KINDS = ['tick', 'backtest', 'wind_down', 'supervise', 'stream'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobState = 'queued' | 'running' | 'done' | 'dead' | 'cancelled';
export interface JobRow { id: string; agent_id: string | null; kind: JobKind; payload: Record<string, unknown>; state: JobState; attempts: number; max_attempts: number; run_at: Date;
  locked_by: string | null; locked_until: Date | null; last_error: string | null; result: unknown; dedupe_key: string | null; created_at: Date; updated_at: Date; finished_at: Date | null }

/** retry delays by job kind, milliseconds: attempt 1 → [0], attempt 2 → [1], … (the last value repeats) */
export const BACKOFF_MS: Readonly<Record<JobKind, readonly number[]>> = {
  tick: [120_000, 300_000, 600_000, 900_000], backtest: [60_000, 300_000], wind_down: [30_000, 60_000, 120_000, 300_000], supervise: [60_000, 120_000], stream: [10_000, 30_000, 60_000],
};
export const MAX_ATTEMPTS: Readonly<Record<JobKind, number>> = { tick: 5, backtest: 2, wind_down: 20, supervise: 5, stream: 5 };
export const LOCK_MS: Readonly<Record<JobKind, number>> = { tick: 180_000, backtest: 30 * 60_000, wind_down: 180_000, supervise: 120_000, stream: 120_000 };
export const backoffMs = (kind: JobKind, attempt: number): number => { const b = BACKOFF_MS[kind]; return b[Math.min(Math.max(attempt, 1), b.length) - 1]!; };
const at = (now: number | undefined) => (now === undefined ? null : new Date(now));

export async function enqueue(kind: JobKind, o: { agentId?: string | null; payload?: Record<string, unknown>; dedupeKey?: string; runAt?: number; maxAttempts?: number } = {}): Promise<{ id: string; created: boolean }> {
  const id = randomUUID();
  const rows = await sql<{ id: string }[]>`insert into agent_jobs (id, agent_id, kind, payload, run_at, max_attempts, dedupe_key)
    values (${id}, ${o.agentId ?? null}, ${kind}, ${sql.json((o.payload ?? {}) as never)}, coalesce(${at(o.runAt)}, now()), ${o.maxAttempts ?? MAX_ATTEMPTS[kind]}, ${o.dedupeKey ?? null})
    on conflict (dedupe_key) where dedupe_key is not null and state in ('queued', 'running') do nothing returning id`;
  if (rows[0]) return { id, created: true };
  const [cur] = await sql<{ id: string }[]>`select id from agent_jobs where dedupe_key = ${o.dedupeKey ?? null} and state in ('queued', 'running') limit 1`;
  return { id: cur?.id ?? id, created: false };
}

/** Take up to `limit` due jobs for this worker. */
export async function claim(worker: string, o: { limit?: number; kinds?: readonly JobKind[]; now?: number } = {}): Promise<JobRow[]> {
  const t = at(o.now), kinds = [...(o.kinds ?? JOB_KINDS)];
  return sql.begin(async (tx) => {
    const due = await tx<JobRow[]>`select * from agent_jobs where state = 'queued' and run_at <= coalesce(${t}, now()) and kind in ${tx(kinds)} order by run_at, created_at limit ${o.limit ?? 8} for update skip locked`;
    const out: JobRow[] = [];
    for (const j of due) {
      const [r] = await tx<JobRow[]>`update agent_jobs set state = 'running', attempts = attempts + 1, locked_by = ${worker}, locked_until = coalesce(${t}, now()) + ${`${LOCK_MS[j.kind]} milliseconds`}::interval, updated_at = coalesce(${t}, now()) where id = ${j.id} returning *`;
      if (r) out.push(r);
    }
    return out;
  }) as unknown as Promise<JobRow[]>;
}

export async function complete(job: Pick<JobRow, 'id'>, worker: string, result: unknown = null, now?: number): Promise<boolean> {
  const t = at(now);
  return (await sql`update agent_jobs set state = 'done', result = ${sql.json((result ?? null) as never)}, locked_by = null, locked_until = null, finished_at = coalesce(${t}, now()), updated_at = coalesce(${t}, now())
    where id = ${job.id} and state = 'running' and locked_by = ${worker} returning id`).length > 0;
}

/** A failed attempt: retry later, or dead-letter. Returns the state the job is in now. */
export async function fail(job: Pick<JobRow, 'id' | 'kind' | 'attempts' | 'max_attempts'>, worker: string, error: string, now?: number): Promise<'queued' | 'dead' | 'lost'> {
  const t = at(now), dead = job.attempts >= job.max_attempts, wait = `${backoffMs(job.kind, job.attempts)} milliseconds`;
  const rows = dead
    ? await sql`update agent_jobs set state = 'dead', last_error = ${error.slice(0, 500)}, locked_by = null, locked_until = null, finished_at = coalesce(${t}, now()), updated_at = coalesce(${t}, now()) where id = ${job.id} and state = 'running' and locked_by = ${worker} returning id`
    : await sql`update agent_jobs set state = 'queued', last_error = ${error.slice(0, 500)}, locked_by = null, locked_until = null, run_at = coalesce(${t}, now()) + ${wait}::interval, updated_at = coalesce(${t}, now()) where id = ${job.id} and state = 'running' and locked_by = ${worker} returning id`;
  return rows.length ? (dead ? 'dead' : 'queued') : 'lost';
}

/** Jobs whose worker stopped answering (lock expired): back to the queue, or dead at the attempt limit. */
export async function reap(now?: number): Promise<{ requeued: JobRow[]; dead: JobRow[] }> {
  const t = at(now);
  const dead = await sql<JobRow[]>`update agent_jobs set state = 'dead', last_error = coalesce(last_error, 'the worker stopped answering while running this job'), locked_by = null, locked_until = null, finished_at = coalesce(${t}, now()), updated_at = coalesce(${t}, now())
    where state = 'running' and locked_until < coalesce(${t}, now()) and attempts >= max_attempts returning *`;
  const requeued = await sql<JobRow[]>`update agent_jobs set state = 'queued', last_error = 'the worker stopped answering while running this job', locked_by = null, locked_until = null, run_at = coalesce(${t}, now()), updated_at = coalesce(${t}, now())
    where state = 'running' and locked_until < coalesce(${t}, now()) and attempts < max_attempts returning *`;
  return { requeued, dead };
}

export async function cancelJobs(agentId: string, kinds: readonly JobKind[]): Promise<number> {
  return (await sql`update agent_jobs set state = 'cancelled', finished_at = now(), updated_at = now() where agent_id = ${agentId} and kind in ${sql([...kinds])} and state = 'queued' returning id`).length;
}
export const getJob = async (id: string): Promise<JobRow | null> => (await sql<JobRow[]>`select * from agent_jobs where id = ${id}`)[0] ?? null;
/** What a job is for a client. The contract's `status` has no `dead`: a dead-lettered job (every attempt failed, or its worker stopped
 *  answering) is `failed`, with `deadLettered: true` — V11 final validation: the raw `dead` was sent to API keys, outside the enum of
 *  the OpenAPI document, and the Python SDK (strict by design) refused the whole answer. */
export const jobView = (j: JobRow) => ({ id: j.id, agentId: j.agent_id, kind: j.kind, status: j.state === 'dead' ? 'failed' as const : j.state, deadLettered: j.state === 'dead', attempts: j.attempts, maxAttempts: j.max_attempts, runAt: j.run_at.getTime(), error: j.last_error, result: j.result ?? null,
  createdAt: j.created_at.getTime(), updatedAt: j.updated_at.getTime(), finishedAt: j.finished_at?.getTime() ?? null });

export async function queueStats(): Promise<{ queued: number; running: number; dead24h: number; oldestQueuedMs: number | null }> {
  const [r] = await sql<{ queued: number; running: number; dead: number; oldest: Date | null }[]>`select count(*) filter (where state = 'queued')::int as queued, count(*) filter (where state = 'running')::int as running,
    count(*) filter (where state = 'dead' and finished_at > now() - interval '24 hours')::int as dead, min(run_at) filter (where state = 'queued') as oldest from agent_jobs`;
  return { queued: r?.queued ?? 0, running: r?.running ?? 0, dead24h: r?.dead ?? 0, oldestQueuedMs: r?.oldest ? Math.max(0, Date.now() - r.oldest.getTime()) : null };
}
/** retention: finished jobs older than `days` */
export const pruneJobs = async (days = 14): Promise<number> => (await sql`delete from agent_jobs where state in ('done', 'cancelled', 'dead') and finished_at < now() - ${`${days} days`}::interval`).count;

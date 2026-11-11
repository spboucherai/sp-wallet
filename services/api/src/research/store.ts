// V7 research runtime — tables and state machine of research jobs. Own tables, created here (not in db.ts): nothing of the
// money code reads them. A job is a request to an AI coding agent on ANOTHER machine; what comes back is untrusted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { canMove, RESEARCH_FINAL, type ResearchBudgets, type ResearchState, type RunnerUsage } from '@spw/core';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';

const SCHEMA = `
create table if not exists research_jobs (
  id uuid primary key, agent_id uuid references agents(id), kind text not null, mission text not null, universe jsonb not null, interval text not null,
  capital_usd double precision not null, budgets jsonb not null, tools jsonb not null,
  state text not null default 'queued', reason text,
  strategy_name text not null unique, strategy_version text not null default '1', lab_commit text,
  dataset jsonb, token_hash text, runner_id text, claimed_at timestamptz, heartbeat_at timestamptz, cancel_requested boolean not null default false,
  usage jsonb, ledger text, submission jsonb, server jsonb, report jsonb, version_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), finished_at timestamptz);
create index if not exists research_jobs_state on research_jobs (state, created_at);
create index if not exists research_jobs_agent on research_jobs (agent_id, created_at desc);
create table if not exists research_job_log (
  id bigserial primary key, job_id uuid not null references research_jobs(id) on delete cascade, ts timestamptz not null default now(), stream text not null, line text not null);
create index if not exists research_job_log_job on research_job_log (job_id, id);
`;
let migrated: Promise<unknown> | null = null;
export function migrateResearch(force = false): Promise<unknown> { if (force || !migrated) migrated = sql.unsafe(SCHEMA); return migrated; }

export interface Holdout { start: string; devEnd: string; end: string; devBars: number; testBars: number }
export interface Dataset { ready: boolean; error?: string; dir?: string; source?: string | null; holdout?: Holdout }
export interface JobRow {
  id: string; agent_id: string | null; kind: 'spot' | 'perp'; mission: string; universe: string[]; interval: string; capital_usd: number; budgets: ResearchBudgets; tools: string[];
  state: ResearchState; reason: string | null; strategy_name: string; strategy_version: string; lab_commit: string | null;
  dataset: Dataset | null; token_hash: string | null; runner_id: string | null; claimed_at: Date | null; heartbeat_at: Date | null; cancel_requested: boolean;
  usage: RunnerUsage | null; ledger: string | null; submission: Record<string, unknown> | null; server: Record<string, unknown> | null; report: Record<string, unknown> | null; version_id: string | null;
  created_at: Date; updated_at: Date; finished_at: Date | null;
}
/** columns of a list (no ledger, no full report, no file bodies) */
export const jobList = () => sql`id, agent_id, kind, mission, universe, interval, capital_usd, budgets, tools, state, reason, strategy_name, strategy_version, lab_commit, runner_id, claimed_at, heartbeat_at, cancel_requested, usage, version_id, created_at, updated_at, finished_at`;

export const loadJob = async (id: string): Promise<JobRow> => {
  const [j] = /^[0-9a-f-]{36}$/.test(id) ? await sql<JobRow[]>`select * from research_jobs where id = ${id}` : [];
  if (!j) throw new UserError('not_found', 'research job not found', 404);
  return j;
};

/** Move a job along the only transitions that exist. Returns false when the job was not in `from` any more (someone else moved it). */
export async function move(id: string, from: ResearchState, to: ResearchState, set: { reason?: string | null } = {}): Promise<boolean> {
  if (!canMove(from, to)) throw new Error(`research job: ${from} → ${to} is not a transition`);
  const final = RESEARCH_FINAL.includes(to);
  const r = await sql`update research_jobs set state = ${to}, reason = ${set.reason ?? null}, updated_at = now(), finished_at = ${final ? sql`now()` : sql`finished_at`}, token_hash = ${final || to === 'evaluating' ? null : sql`token_hash`}
    where id = ${id} and state = ${from} returning id`;
  return r.length === 1;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newToken = (): string => randomBytes(32).toString('hex');
export const sameSecret = (a: string, b: string): boolean => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };

export const researchDataDir = (): string => path.join(process.env.SPW_DATA_DIR || path.join(homedir(), '.config', 'sp-wallet'), 'research-jobs');
export async function appendLog(jobId: string, lines: { s: string; t: string }[]): Promise<void> {
  if (!lines.length) return;
  await sql`insert into research_job_log ${sql(lines.map((l) => ({ job_id: jobId, stream: l.s, line: l.t })))}`;
}
export const sysLog = (jobId: string, text: string): Promise<void> => appendLog(jobId, [{ s: 'api', t: text.slice(0, 2000) }]).catch(() => {});

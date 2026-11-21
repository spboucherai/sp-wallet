/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/research/evaluate.ts
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

// V7 research runtime — what the API does with a submission. Nothing in it is trusted:
//   1. the archive is decoded and bounded (only the expected files, sizes, UTF-8);
//   2. strategy.py is checked STATICALLY (spq.lint: parsed and hashed, never imported) before anything runs;
//   3. it is installed under research/strategies/rj_<job>/<version>/ — the API is the only writer there, the path is built from
//      the job row, never from the archive;
//   4. the laboratory describes it (META, hash) in the OS sandbox; name, version, kind, interval and universe must be the job's;
//   5. the SERVER backtests it, twice, in the sandbox, from files, with no network and no database URL:
//        - replication: the standard evaluation on the data the agent had → compared with what the agent claims;
//        - holdout: the report on the full frozen data set, whose test split the job never had, with the deflated Sharpe ratio
//          computed over this run's trials PLUS every trial the job consumed (the runner's append-only ledger);
//   6. the server's report — never the agent's numbers — is attached to a strategy version left in `draft` for the owner.
// A failure at any step leaves no report: a version without a server report cannot be approved, paper-traded or mandated.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { compareClaim, decodeSubmission, JOB_STRATEGY_RE, parseClaims, type AgentClaims, type RunnerResult, type SubmissionArchive } from '@spw/core';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { RESEARCH_DIR } from '../agents/live.ts';
import { perpReportProblem } from '../agents/perp-strategies.ts';
import type { AgentRow } from '../agents/routes.ts';
import { agentSymbols } from '../agents/routes.ts';
import { dataDirs } from './dataset.ts';
import { dropScratch, labRun, lastLine, scratchDir } from './lab.ts';
import { loadJob, move, sysLog, type JobRow } from './store.ts';

const STRATEGIES = path.join(existsSync(RESEARCH_DIR) ? realpathSync(RESEARCH_DIR) : RESEARCH_DIR, 'strategies');
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const Meta = z.object({ name: z.string().max(40), version: z.string().max(12), kind: z.string().optional(), universe: z.array(z.string().max(16)).min(1).max(24), interval: z.string().max(4), lookback: z.number().int().positive().max(100_000),
  max_leverage: z.number().positive().optional(), max_gross_exposure: z.number().positive().optional(), min_symbols: z.number().int().optional(), max_symbols: z.number().int().optional(), params: z.record(z.string(), z.unknown()) });
const Described = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), meta: Meta, generic: z.boolean().optional(), kind: z.enum(['spot', 'perp']).optional(), contract: z.number().int().optional() });
type Described = z.infer<typeof Described>;
const SPLIT_KEYS = ['total_return', 'sharpe', 'max_drawdown', 'trades'] as const;
type SplitNums = Partial<Record<(typeof SPLIT_KEYS)[number], number | null>>;
const pick = (m: unknown): SplitNums => Object.fromEntries(SPLIT_KEYS.map((k) => [k, typeof (m as Record<string, unknown> | undefined)?.[k] === 'number' ? (m as Record<string, number>)[k]! : null]));

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

/** job-scoped directory of a job's strategy inside the laboratory's library; built from the job row only */
export function installDir(job: Pick<JobRow, 'strategy_name' | 'strategy_version'>): { rel: string; dir: string } {
  if (!JOB_STRATEGY_RE.test(job.strategy_name) || !/^[a-z0-9_]{1,12}$/.test(job.strategy_version)) throw new Error('bad job strategy name');
  const dir = path.resolve(STRATEGIES, job.strategy_name, job.strategy_version);
  if (!dir.startsWith(STRATEGIES + path.sep)) throw new Error('strategy path escapes the library');
  return { rel: `${job.strategy_name}/${job.strategy_version}`, dir };
}

/** The arguments of the standard evaluation of a job — the same as spq.job.backtest_argv on the laboratory side. */
export function backtestArgs(job: Pick<JobRow, 'kind' | 'universe' | 'interval' | 'capital_usd' | 'dataset'>, strategyDir: string, sha256: string, dataDir: string, out: string, o: { resamples?: number; folds?: number; ledger?: string; jobLedger?: string }): string[] {
  return [job.kind === 'perp' ? 'spq.perp_backtest' : 'spq.backtest', '--strategy', strategyDir, '--sha256', sha256, '--symbols', job.universe.join(','), '--interval', job.interval, '--data-dir', dataDir,
    '--initial-cash', String(job.capital_usd), '--out', out, ...(job.kind === 'spot' && job.dataset?.source ? ['--source', job.dataset.source] : []),
    ...(o.resamples ? ['--resamples', String(o.resamples)] : []), ...(o.folds ? ['--folds', String(o.folds)] : []), ...(o.ledger ? ['--ledger', o.ledger] : []), ...(o.jobLedger ? ['--job-ledger', o.jobLedger] : [])];
}

export interface ServerSummary {
  status: 'ok' | 'failed'; reason?: string; sha256?: string; sandbox?: 'sandbox-exec' | 'none'; meta?: Record<string, unknown>;
  holdout?: { testStart: string; testEnd: string; bars: number };
  trials?: { job: number; server: number; total: number; ledgerTampered: boolean };
  deflatedSharpe?: number | null; sharpeCi?: [number | null, number | null] | null;
  metrics?: Record<'train' | 'validation' | 'test', SplitNums>; benchmark?: SplitNums; checks?: Record<string, unknown>;
  /** the standard evaluation re-run by the server on the data the agent had */
  replication?: Record<'train' | 'validation' | 'inner_test', SplitNums>;
  /** what the agent claims next to what the server measured on the same data */
  comparison?: { split: string; metric: string; claimed: number | null; measured: number | null; differs: boolean }[];
  claimsDiffer?: boolean; claimsProblem?: string | null;
}

async function describeSandboxed(dir: string, kind: 'spot' | 'perp', scratch: string): Promise<{ d: Described; sandbox: 'sandbox-exec' | 'none' }> {
  const r = await labRun(['spq.describe', '--strategy', dir, ...(kind === 'perp' ? ['--contract', '2'] : [])], { timeoutMs: 60_000, scratch, strategyDir: dir });
  if (r.code !== 0) refuse(`the laboratory refused this strategy: ${lastLine(r.err, 200)}`);
  const p = Described.safeParse((() => { try { return JSON.parse(r.out); } catch { return null; } })());
  if (!p.success) return refuse('the laboratory\'s description of the strategy is not readable');
  return { d: p.data, sandbox: r.sandbox };
}

/** Steps 1–3: decode, static check, install. Returns the code hash. Throws Refused with a reason the owner can read. */
export async function installSubmission(job: JobRow, archive: SubmissionArchive, scratch: string): Promise<{ sha256: string; files: Record<string, string>; claimsText: string | null }> {
  let sub; try { sub = decodeSubmission(archive); } catch (e) { return refuse(`malformed submission: ${(e as Error).message}`); }
  const text = (n: 'strategy.py' | 'README.md' | 'NOTES.md' | 'claims.json'): string | null => (sub.files[n] ? new TextDecoder().decode(sub.files[n]) : null);
  const stage = path.join(scratch, 'stage'); mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, 'strategy.py'), sub.files['strategy.py']!);
  const lint = await labRun(['spq.lint', '--strategy', stage], { timeoutMs: 30_000, scratch });
  let parsed: { sha256?: string; problems?: string[] } = {};
  try { parsed = JSON.parse(lint.out) as typeof parsed; } catch { /* handled below */ }
  if (lint.code === 3 && parsed.problems?.length) refuse(`strategy.py fails the purity check: ${parsed.problems.slice(0, 6).join('; ').slice(0, 500)}`);
  if (lint.code !== 0 || !parsed.sha256 || !/^[0-9a-f]{64}$/.test(parsed.sha256)) refuse(`strategy.py could not be checked: ${lastLine(lint.err, 200)}`);
  const { dir } = installDir(job);
  if (existsSync(dir)) refuse('a strategy is already installed for this job');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const n of ['strategy.py', 'README.md', 'NOTES.md'] as const) if (sub.files[n]) writeFileSync(path.join(dir, n), sub.files[n], { flag: 'wx', mode: 0o644 });
  return { sha256: parsed.sha256!, files: { 'strategy.py': text('strategy.py')!, 'README.md': text('README.md')!, ...(text('NOTES.md') ? { 'NOTES.md': text('NOTES.md')! } : {}) }, claimsText: text('claims.json') };
}
const uninstall = (job: JobRow): void => { try { const { dir } = installDir(job); rmSync(path.dirname(dir), { recursive: true, force: true }); } catch { /* nothing installed */ } };

function compare(claims: AgentClaims | null, rep: NonNullable<ServerSummary['replication']>): NonNullable<ServerSummary['comparison']> {
  const out: NonNullable<ServerSummary['comparison']> = [];
  for (const split of ['train', 'validation', 'inner_test'] as const) for (const metric of SPLIT_KEYS) {
    const c = compareClaim(claims?.[split]?.[metric], rep[split][metric]);
    out.push({ split, metric, ...c });
  }
  return out;
}

/** The whole pipeline for one submission. Never throws; the job ends `submitted` (server report attached) or `failed`. */
export async function evaluateSubmission(jobId: string, result: Extract<RunnerResult, { outcome: 'submission' }>): Promise<void> {
  const job = await loadJob(jobId);
  if (job.state !== 'evaluating') return;
  const scratch = scratchDir();
  let versionId: string | null = null, installed = false;
  const summary: ServerSummary = { status: 'failed' };
  try {
    const inst = await installSubmission(job, result.archive, scratch); installed = true;
    const { claims, problem: claimsProblem } = parseClaims(inst.claimsText);
    const { rel, dir } = installDir(job);
    await sql`update research_jobs set submission = ${sql.json({ sha256: inst.sha256, path: `strategies/${rel}`, files: inst.files, claims, claimsProblem, bytes: Object.fromEntries(Object.entries(inst.files).map(([k, v]) => [k, v.length])) } as never)} where id = ${job.id}`;
    await sysLog(job.id, `submission accepted for evaluation: strategy.py ${inst.sha256.slice(0, 16)}… passed the static purity check and was installed as strategies/${rel}`);

    // 4 — describe (the first time any of the submitted code runs: module level only, in the sandbox)
    const { d, sandbox } = await describeSandboxed(dir, job.kind, scratch);
    summary.sha256 = d.sha256; summary.sandbox = sandbox; summary.meta = d.meta;
    if (d.sha256 !== inst.sha256) refuse('the installed file does not have the hash that was checked');
    if (d.meta.name !== job.strategy_name || d.meta.version !== job.strategy_version) refuse(`META must carry the job's name and version ("${job.strategy_name}" / "${job.strategy_version}"), got "${d.meta.name.slice(0, 40)}" / "${d.meta.version.slice(0, 12)}"`);
    const kind = d.meta.kind === 'perp' ? 'perp' : 'spot';
    if (kind !== job.kind) refuse(`this is a ${kind} strategy; the job asked for a ${job.kind} strategy`);
    if (d.meta.interval !== job.interval) refuse(`the strategy decides every ${d.meta.interval}; the job is at ${job.interval}`);
    const generic = d.meta.universe.length === 1 && d.meta.universe[0] === '*';
    if (job.kind === 'perp') {
      if (d.meta.max_leverage === undefined || d.meta.max_gross_exposure === undefined) refuse('a perp strategy declares max_leverage and max_gross_exposure');
      if (d.meta.universe.some((s) => s.endsWith('.SPOT'))) refuse('spot legs (X.SPOT) are not supported by perp agents');
      if (!sameSet(d.meta.universe, job.universe)) refuse(`the strategy trades ${d.meta.universe.join(', ')}; the job's instruments are ${job.universe.join(', ')}`);
    } else if (generic) {
      const lo = d.meta.min_symbols ?? 1, hi = d.meta.max_symbols ?? 12;
      if (job.universe.length < lo || job.universe.length > hi) refuse(`the strategy takes between ${lo} and ${hi} symbols; the job has ${job.universe.length}`);
    } else if (!sameSet(d.meta.universe, job.universe)) refuse(`the strategy trades ${d.meta.universe.join(', ')}; the job's symbols are ${job.universe.join(', ')}`);

    // a version row for the agent (status backtesting: not approvable until the server's report is attached)
    if (job.agent_id) {
      const [a] = await sql<AgentRow[]>`select * from agents where id = ${job.agent_id}`;
      if (!a) refuse('the agent of this job no longer exists');
      const symbols = a!.kind === 'perp' ? a!.universe : agentSymbols(a!);
      if ((a!.kind ?? 'spot') !== job.kind || a!.interval !== job.interval || !sameSet(symbols, job.universe)) refuse('the agent changed since the job was created (kind, interval or symbols): the strategy was not attached');
      const [row] = await sql<{ id: string; status: string }[]>`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, notes)
        values (${randomUUID()}, ${a!.id}, ${d.meta.name}, ${d.meta.version}, ${d.sha256}, ${`strategies/${rel}`}, ${sql.json({ ...d.meta, ...(job.kind === 'spot' ? { generic } : {}), symbols: job.universe, researchJob: job.id } as never)}, 'backtesting', '')
        on conflict (agent_id, code_sha256) do update set path = excluded.path returning id, status`;
      if (row!.status === 'approved') refuse('this exact code is already approved for the agent');
      versionId = row!.id;
      await sql`update research_jobs set version_id = ${versionId} where id = ${job.id}`;
      await audit('strategy.registered', 'research', { agent: a!.id, version: versionId, path: `strategies/${rel}`, sha256: d.sha256, job: job.id });
    }

    // 5 — the server's own backtests, from files, sandboxed
    const dirs = dataDirs(job), rep = path.join(scratch, 'replication.json'), out = path.join(scratch, 'report.json'), jobLedger = path.join(scratch, 'job-ledger.jsonl');
    writeFileSync(jobLedger, result.archive.ledger);
    const r1 = await labRun(backtestArgs(job, dir, d.sha256, dirs.dev, rep, { resamples: 300, folds: 3 }), { timeoutMs: 20 * 60_000, scratch, readable: [dirs.dev], strategyDir: dir });
    if (r1.code !== 0 || !existsSync(rep)) refuse(`the server could not reproduce the evaluation on the agent's data: ${lastLine(r1.err)}`);
    const repReport = JSON.parse(readFileSync(rep, 'utf8')) as { metrics?: Record<string, unknown> };
    summary.replication = { train: pick(repReport.metrics?.train), validation: pick(repReport.metrics?.validation), inner_test: pick(repReport.metrics?.test) };
    const r2 = await labRun(backtestArgs(job, dir, d.sha256, dirs.full, out, { ledger: path.join(scratch, 'server-ledger.jsonl'), jobLedger }), { timeoutMs: 30 * 60_000, scratch, readable: [dirs.full], strategyDir: dir });
    if (r2.code !== 0 || !existsSync(out)) refuse(`the server-side backtest failed: ${lastLine(r2.err)}`);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Record<string, any>;
    if (report.strategy_sha256 !== d.sha256) refuse('the server report is for another code hash');
    if (!Array.isArray(report.config?.symbols) || !sameSet(report.config.symbols, job.universe)) refuse('the server report is for other symbols than the job\'s');
    if (job.kind === 'perp') { const why = perpReportProblem(report, d.sha256, job.universe); if (why) refuse(why); }
    // the test split of the server's report must start exactly where the agent's data ended
    const testStart = Date.parse(String(report.splits?.test?.[0])), cut = Date.parse(job.dataset!.holdout!.devEnd);
    if (!(testStart >= cut)) refuse(`the server's test split starts at ${String(report.splits?.test?.[0])}, inside the data the agent had (it ended at ${job.dataset!.holdout!.devEnd}): this is not an out-of-sample test`);
    const detail = report.robustness?.deflated_sharpe_detail ?? {};
    if (!(Number(detail.n_trials_job) >= result.usage.trials && Number(report.robustness?.trials_tested) >= Number(detail.n_trials_job))) refuse('the report does not count the trials the job consumed');
    report.research_job = { id: job.id, trials_job: detail.n_trials_job, ledger_tampered: result.usage.ledgerTampered, holdout_start: job.dataset!.holdout!.devEnd, agent_data_end: job.dataset!.holdout!.devEnd };

    summary.holdout = { testStart: String(report.splits.test[0]), testEnd: String(report.splits.test[1]), bars: job.dataset!.holdout!.testBars };
    summary.trials = { job: Number(detail.n_trials_job), server: Number(detail.n_trials_this_run), total: Number(report.robustness.trials_tested), ledgerTampered: result.usage.ledgerTampered };
    summary.deflatedSharpe = typeof report.robustness.deflated_sharpe === 'number' ? report.robustness.deflated_sharpe : null;
    summary.sharpeCi = Array.isArray(report.robustness.bootstrap_sharpe_ci) ? report.robustness.bootstrap_sharpe_ci : null;
    summary.metrics = { train: pick(report.metrics?.train), validation: pick(report.metrics?.validation), test: pick(report.metrics?.test) };
    summary.benchmark = pick(report.benchmarks?.[job.kind === 'perp' ? 'perp_long_1x' : 'buy_and_hold']);
    summary.checks = report.checks ?? {};
    summary.comparison = compare(claims, summary.replication); summary.claimsDiffer = summary.comparison.some((c) => c.differs) || (claims?.trials !== undefined && claims.trials < result.usage.trials);
    summary.claimsProblem = claimsProblem;
    summary.status = 'ok';

    // 6 — attach the SERVER's report; the version stays a draft for the owner
    if (versionId) await sql`update strategy_versions set status = 'draft', report = ${sql.json(report as never)}, notes = '' where id = ${versionId} and status = 'backtesting'`;
    await sql`update research_jobs set server = ${sql.json(summary as never)}, report = ${sql.json(report as never)}, updated_at = now() where id = ${job.id}`;
    const dsr = typeof summary.deflatedSharpe === 'number' ? summary.deflatedSharpe.toFixed(3) : 'n/a';
    await sql`insert into research_log (agent_id, kind, title, body, data) values (${job.agent_id}, 'research', 'Research job submitted', ${`${job.strategy_name}/${job.strategy_version} (${d.sha256.slice(0, 12)}…): server-side backtest on held-out data done; ${summary.trials.total} trials counted (${summary.trials.job} by the job), deflated Sharpe ${dsr}${summary.claimsDiffer ? '; the agent\'s reported numbers differ from the server\'s' : ''}. Awaiting your approval.`},
      ${sql.json({ job: job.id, version: versionId, sha256: d.sha256, trials: summary.trials, deflatedSharpe: summary.deflatedSharpe, claimsDiffer: summary.claimsDiffer } as never)})`;
    if (versionId) await audit('strategy.backtested', 'engine', { version: versionId, sha256: d.sha256, job: job.id, ...(job.kind === 'perp' ? { kind: 'perp' } : {}) });
    await move(job.id, 'evaluating', 'submitted');
    await audit('research.submitted', 'research', { job: job.id, agent: job.agent_id, version: versionId, name: job.strategy_name, sha256: d.sha256, trials: summary.trials.total, claimsDiffer: summary.claimsDiffer });
    await sysLog(job.id, `server evaluation done: ${summary.trials.total} trials counted, deflated Sharpe ${dsr}; the version is a draft awaiting the owner's approval`);
  } catch (e) {
    const reason = e instanceof Refused ? e.message : e instanceof UserError ? e.message : `evaluation error: ${(e as Error).message.slice(0, 200)}`;
    summary.status = 'failed'; summary.reason = reason.slice(0, 600);
    // a version that got no server report stays an un-approvable draft with the reason; a strategy nobody references is removed
    if (versionId) await sql`update strategy_versions set status = 'draft', notes = ${`research job refused: ${reason}`.slice(0, 400)} where id = ${versionId} and status = 'backtesting'`.catch(() => {});
    else if (installed) uninstall(job);
    await sql`update research_jobs set server = ${sql.json(summary as never)}, updated_at = now() where id = ${job.id}`.catch(() => {});
    await move(job.id, 'evaluating', 'failed', { reason: summary.reason }).catch(() => {});
    await sql`insert into research_log (agent_id, kind, title, body, data) values (${job.agent_id}, 'research', 'Research job refused', ${summary.reason}, ${sql.json({ job: job.id } as never)})`.catch(() => {});
    await audit('research.failed', 'research', { job: job.id, agent: job.agent_id, name: job.strategy_name, state: 'failed', reason: summary.reason.slice(0, 200) }).catch(() => {});
    await sysLog(job.id, `submission refused: ${summary.reason}`);
  } finally { dropScratch(scratch); }
}

/** Attach a job's evaluated strategy to an agent through the ordinary route (POST /agents/:id/strategies with an rj_* path):
 *  no code runs — the server report of the job is reused, so it is valid only for exactly the job's symbols and interval. */
export async function attachJobStrategy(a: AgentRow, rel: string): Promise<{ id: string; sha256: string; symbols: string[]; status: string }> {
  const [name, version] = rel.split('/');
  const [job] = await sql<JobRow[]>`select * from research_jobs where strategy_name = ${name ?? ''} and strategy_version = ${version ?? ''}`;
  if (!job || job.state !== 'submitted' || !job.report || job.server?.status !== 'ok') throw new UserError('not_found', 'this research strategy has no server-side report: it cannot be attached', 404);
  const symbols = a.kind === 'perp' ? a.universe : agentSymbols(a);
  if ((a.kind ?? 'spot') !== job.kind) throw new UserError('wrong_kind', `this research strategy is a ${job.kind} strategy`, 422);
  if (a.interval !== job.interval || !sameSet(symbols, job.universe)) throw new UserError('universe_mismatch', `the server evaluated this strategy on ${job.universe.join(', ')} at ${job.interval}; this agent trades ${symbols.join(', ')} at ${a.interval}. Start a research job for this agent instead.`, 422);
  const sha = String(job.server.sha256), meta = job.server.meta as Record<string, unknown>;
  const [row] = await sql<{ id: string; status: string }[]>`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report)
    values (${randomUUID()}, ${a.id}, ${job.strategy_name}, ${job.strategy_version}, ${sha}, ${`strategies/${rel}`}, ${sql.json({ ...meta, symbols, researchJob: job.id } as never)}, 'draft', ${sql.json(job.report as never)})
    on conflict (agent_id, code_sha256) do update set path = excluded.path returning id, status`;
  await audit('strategy.registered', 'owner', { agent: a.id, version: row!.id, path: `strategies/${rel}`, sha256: sha, job: job.id });
  return { id: row!.id, sha256: sha, symbols, status: row!.status };
}

/** Put back the strategy files of evaluated jobs that are missing from the laboratory's library (a fresh checkout, a
 *  redeployment): the API stored what it installed, and only writes a file whose SHA-256 is the one it evaluated. */
export async function restoreJobStrategies(): Promise<number> {
  const rows = await sql<{ strategy_name: string; strategy_version: string; submission: { files?: Record<string, string> } | null; server: { sha256?: string } | null }[]>`
    select strategy_name, strategy_version, submission, server from research_jobs where state = 'submitted' and server->>'status' = 'ok'`;
  let n = 0;
  for (const r of rows) {
    try {
      const { dir } = installDir(r), code = r.submission?.files?.['strategy.py'];
      if (existsSync(path.join(dir, 'strategy.py')) || typeof code !== 'string') continue;
      const { createHash } = await import('node:crypto');
      if (createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex') !== r.server?.sha256) continue; // not byte-identical: leave it missing (the engine then holds)
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      for (const f of ['strategy.py', 'README.md', 'NOTES.md']) if (typeof r.submission?.files?.[f] === 'string') writeFileSync(path.join(dir, f), r.submission.files[f]!, { flag: 'wx', mode: 0o644 });
      n += 1;
    } catch { /* one job's files never block the others */ }
  }
  return n;
}

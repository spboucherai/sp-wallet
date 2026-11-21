/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/research-job.ts
 * Module           : core
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

// V7 research runtime — the protocol shared by the API (services/api/src/research), the job runner
// (services/research-runner) and the web app: what a research job is, its budgets, what the runner receives, and the
// submission archive. Pure (zod only): no file system, no network.
//
// Trust: everything that comes back from a job is UNTRUSTED (it was written by an AI coding agent). The schemas below bound
// sizes and shapes; they say nothing about the content being true. The API re-computes every number it shows as measured.
import { z } from 'zod';

export const RESEARCH_STATES = ['queued', 'preparing', 'running', 'evaluating', 'submitted', 'failed', 'cancelled', 'over_budget'] as const;
export type ResearchState = (typeof RESEARCH_STATES)[number];
/** states in which a job is finished: nothing moves it again */
export const RESEARCH_FINAL: readonly ResearchState[] = ['submitted', 'failed', 'cancelled', 'over_budget'];
/** the only transitions that exist (the API enforces them; the runner can only ask for the ones marked runner) */
export const RESEARCH_TRANSITIONS: Record<ResearchState, readonly ResearchState[]> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'failed', 'cancelled', 'over_budget'],
  running: ['evaluating', 'failed', 'cancelled', 'over_budget'],
  evaluating: ['submitted', 'failed'],
  submitted: [], failed: [], cancelled: [], over_budget: [],
};
export const canMove = (from: ResearchState, to: ResearchState): boolean => RESEARCH_TRANSITIONS[from].includes(to);

/** Tools of the coding agent an owner may allow. There is deliberately NO web tool in this list: a job has no web access. */
export const RESEARCH_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
export type ResearchTool = (typeof RESEARCH_TOOLS)[number];

/** Set by the owner per job, enforced by the runner from OUTSIDE the agent process (kill on overrun). The agent cannot change them. */
export const ResearchBudgets = z.strictObject({
  /** wall-clock seconds of the agent process */
  wallSeconds: z.number().int().min(30).max(86_400).default(3600),
  /** lines of the job's trial ledger (every configuration backtested on train + validation, every look at the inner test split) */
  maxTrials: z.number().int().min(1).max(5000).default(200),
  /** size of the job directory */
  maxDiskMb: z.number().int().min(16).max(10_240).default(512),
  /** model tokens (input + output + cache writes and reads) counted by the runner's model gateway */
  maxModelTokens: z.number().int().min(10_000).max(500_000_000).default(5_000_000),
  /** US dollars as reported by the coding agent's CLI (when it reports a cost); also given to the CLI as its own cap */
  maxModelUsd: z.number().min(0.05).max(1000).default(10),
});
export type ResearchBudgets = z.infer<typeof ResearchBudgets>;

export const RESEARCH_INTERVALS = ['1h', '4h', '1d'] as const;
const Sym = z.string().regex(/^[A-Z0-9]{2,10}$/);
export const ResearchJobCreate = z.strictObject({
  /** the agent the strategy is developed for; without it the result is a library draft */
  agentId: z.uuid().optional(),
  kind: z.enum(['spot', 'perp']).default('spot'),
  /** the owner's own words; given to the coding agent as the task */
  mission: z.string().trim().min(10).max(2000),
  universe: z.array(Sym).min(1).max(12).refine((u) => new Set(u).size === u.length, 'distinct symbols'),
  interval: z.enum(RESEARCH_INTERVALS).default('1h'),
  /** virtual capital of the simulation the owner asks for (reports are computed from this starting cash) */
  capitalUsd: z.number().min(10).max(10_000_000).default(1000),
  budgets: ResearchBudgets.default(ResearchBudgets.parse({})),
  tools: z.array(z.enum(RESEARCH_TOOLS)).min(1).max(RESEARCH_TOOLS.length).default([...RESEARCH_TOOLS]),
});
export type ResearchJobCreate = z.infer<typeof ResearchJobCreate>;

// ---- what the runner receives when it claims a job ------------------------------------------------------------------------
/** candles the agent may see: train + validation only. The server keeps the test split (see `holdout`). */
export const ResearchData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spot'), source: z.string().regex(/^[a-z]{2,20}$/), interval: z.string(),
    /** CSV text per symbol: header `ts,open,high,low,close,volume`, ts = bar-open time in seconds UTC */
    files: z.array(z.object({ symbol: Sym, csv: z.string().max(40_000_000) })).min(1).max(12) }),
  /** the input of `python -m spq.data.hl_import` (candles + funding of the venue, optional spot candles) */
  z.object({ kind: z.literal('perp'), bundle: z.record(z.string(), z.unknown()) }),
]);
export type ResearchData = z.infer<typeof ResearchData>;

export const RunnerJob = z.object({
  id: z.uuid(),
  /** secret of THIS job: required to append its log and to push its result; useless for any other job */
  token: z.string().min(32).max(128),
  kind: z.enum(['spot', 'perp']), mission: z.string(), universe: z.array(Sym), interval: z.string(), capitalUsd: z.number(),
  budgets: ResearchBudgets, tools: z.array(z.enum(RESEARCH_TOOLS)),
  /** META["name"] and META["version"] the strategy must carry (job-scoped: the API installs it under strategies/<name>/<version>) */
  strategyName: z.string().regex(/^[a-z0-9_]{1,40}$/), strategyVersion: z.string().regex(/^[a-z0-9_]{1,12}$/),
  /** commit of the laboratory the job must run on (null: whatever the runner has, recorded with the result) */
  labCommit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  /** what the agent is given, and what it is not: bars before `devEnd` only; the server tests on [devEnd, end) */
  holdout: z.object({ start: z.string(), devEnd: z.string(), end: z.string(), devBars: z.number().int(), testBars: z.number().int() }),
  data: ResearchData,
});
export type RunnerJob = z.infer<typeof RunnerJob>;

// ---- the submission archive -----------------------------------------------------------------------------------------------
export const SUBMISSION_FILES = {
  'strategy.py': { max: 64 * 1024, required: true },
  'README.md': { max: 32 * 1024, required: true },
  'NOTES.md': { max: 256 * 1024, required: false },
  'claims.json': { max: 16 * 1024, required: false },
} as const;
export type SubmissionFileName = keyof typeof SUBMISSION_FILES;
export const MAX_LEDGER_BYTES = 6 * 1024 * 1024;
export const MAX_SUBMISSION_BODY = 10 * 1024 * 1024;
export const MAX_LOG_LINE = 2000;
export const MAX_LOG_BATCH = 200;

const B64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** what the runner measured from outside the agent (the API stores it; it trusts none of it for money decisions) */
export const RunnerUsage = z.object({
  wallMs: z.number().int().min(0), trials: z.number().int().min(0), diskMb: z.number().min(0),
  modelTokens: z.number().int().min(0), modelRequests: z.number().int().min(0), modelUsd: z.number().min(0).nullable(),
  /** the agent's own ledger file was truncated or rewritten while the runner was copying it */
  ledgerTampered: z.boolean(),
  /** 'sandbox-exec' when the agent ran under the macOS sandbox profile; 'none' when the platform offered nothing (said in the UI) */
  sandbox: z.enum(['sandbox-exec', 'none']), agent: z.string().max(40), labCommit: z.string().max(64).nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().max(20).nullable(),
});
export type RunnerUsage = z.infer<typeof RunnerUsage>;

export const SubmissionArchive = z.strictObject({
  v: z.literal(1),
  /** exactly the expected files, each base64; anything else is refused */
  files: z.array(z.strictObject({ path: z.enum(Object.keys(SUBMISSION_FILES) as [SubmissionFileName, ...SubmissionFileName[]]), b64: B64.max(400_000) })).min(1).max(4),
  /** the runner's append-only copy of the trial ledger (JSON lines) */
  ledger: z.string().max(MAX_LEDGER_BYTES),
});
export type SubmissionArchive = z.infer<typeof SubmissionArchive>;

export const RunnerResult = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('submission'), usage: RunnerUsage, archive: SubmissionArchive }),
  z.strictObject({ outcome: z.enum(['failed', 'cancelled', 'over_budget']), usage: RunnerUsage, reason: z.string().max(600),
    /** the ledger is kept even when nothing was submitted: the trials were consumed */
    ledger: z.string().max(MAX_LEDGER_BYTES).default('') }),
]);
export type RunnerResult = z.infer<typeof RunnerResult>;

export interface DecodedSubmission { files: Partial<Record<SubmissionFileName, Uint8Array>>; ledger: string }
const fromB64 = (s: string): Uint8Array => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
/** Decode and bound an archive: only the expected names, once each, within their size limits, text files valid UTF-8 without NUL.
 *  Throws an Error whose message can be shown to the owner. Nothing is written anywhere. */
export function decodeSubmission(a: SubmissionArchive): DecodedSubmission {
  const files: Partial<Record<SubmissionFileName, Uint8Array>> = {};
  for (const f of a.files) {
    if (files[f.path]) throw new Error(`the archive contains ${f.path} twice`);
    const bytes = fromB64(f.b64), spec = SUBMISSION_FILES[f.path];
    if (bytes.length > spec.max) throw new Error(`${f.path} is ${bytes.length} bytes (limit ${spec.max})`);
    if (bytes.length === 0) throw new Error(`${f.path} is empty`);
    if (bytes.includes(0)) throw new Error(`${f.path} contains a NUL byte`);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${f.path} is not UTF-8 text`); }
    files[f.path] = bytes;
  }
  for (const [name, spec] of Object.entries(SUBMISSION_FILES)) if (spec.required && !files[name as SubmissionFileName]) throw new Error(`the submission has no ${name}`);
  return { files, ledger: a.ledger };
}

// ---- what the agent CLAIMS (claims.json) — shown next to what the server measured, never instead of it --------------------
const Num = z.number().refine((x) => Number.isFinite(x)).nullable().optional();
const ClaimSplit = z.object({ total_return: Num, sharpe: Num, max_drawdown: Num, trades: Num }).partial();
export const AgentClaims = z.object({
  train: ClaimSplit.optional(), validation: ClaimSplit.optional(),
  /** the agent's own inner test split (a part of the data it was given) — NOT the server's test split, which it never saw */
  inner_test: ClaimSplit.optional(),
  trials: z.number().int().min(0).max(1_000_000).optional(),
  summary: z.string().max(4000).optional(),
});
export type AgentClaims = z.infer<typeof AgentClaims>;
/** Parse claims.json leniently: a malformed file is "no claims" plus a note, never an error (it is only a statement). */
export function parseClaims(text: string | null): { claims: AgentClaims | null; problem: string | null } {
  if (text === null) return { claims: null, problem: null };
  try { const r = AgentClaims.safeParse(JSON.parse(text)); return r.success ? { claims: r.data, problem: null } : { claims: null, problem: 'claims.json does not follow the expected shape; it was ignored' }; }
  catch { return { claims: null, problem: 'claims.json is not valid JSON; it was ignored' }; }
}

/** Compare one claimed metric with the server's (both may be missing). The laboratory is deterministic: an honest claim is the
 *  server's number to the last digits, so the tolerance only absorbs floating-point noise between two machines.
 *  `differs` only when both exist and disagree beyond it. */
export function compareClaim(claimed: number | null | undefined, measured: number | null | undefined, tol = 1e-4): { claimed: number | null; measured: number | null; differs: boolean } {
  const c = typeof claimed === 'number' && Number.isFinite(claimed) ? claimed : null, m = typeof measured === 'number' && Number.isFinite(measured) ? measured : null;
  return { claimed: c, measured: m, differs: c !== null && m !== null && Math.abs(c - m) > tol * Math.max(1, Math.abs(m)) };
}

/** job-scoped strategy directory name: `rj_<first 12 hex of the job id>` — the API is the only writer of research/strategies/rj_* */
export const jobStrategyName = (jobId: string): string => `rj_${jobId.replace(/-/g, '').slice(0, 12)}`;
export const JOB_STRATEGY_RE = /^rj_[0-9a-f]{12}$/;

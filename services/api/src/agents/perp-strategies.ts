/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-strategies.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// Strategy library and backtests for perp agents (contract 2). The two libraries never mix:
//  - the spot listing (strategies.ts) calls `spq.describe` WITHOUT `--contract 2`, which refuses every perp strategy;
//  - this listing calls it WITH `--contract 2` and keeps only `kind: perp`; a spot strategy offered to a perp agent is refused.
//
// Backtest data: PRE-FETCHED HERE and handed to the laboratory as a file. The alternative — letting the laboratory's own
// downloader reach the venue from the API's Python process — would mean giving a network exception to the process that runs
// strategy code, with a per-host filter the OS does not offer in a dependable way (macOS has no supported hostname
// firewall for a child process). Pre-fetching keeps the laboratory process offline (v8: inside the OS sandbox of lab.ts, no socket at all, no database
// URL either), reuses the adapter that is already validated (zod), read-only (no trading object) and rate-budgeted, and makes
// the backtest run on exactly the series the engine stores and trades on.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_AGENT_SYMBOLS } from '@spw/core';
import type { Instrument } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import type { DerivData } from '../derivatives/data.ts';
import { dropScratch, RESEARCH_DIR, scratchDir } from './lab.ts';
import { VENUE_MAX_BARS, type PerpDataStore, type PerpInterval } from './perp-data.ts';
import { PERP_VENUE, type PerpAgentRow } from './perp-engine.ts';
import { py, stageLedger } from './strategies.ts';
import { inLibraryManifest } from '../agent-runtime/model.ts';
import { z } from 'zod';

const ROOT = path.join(RESEARCH_DIR, 'strategies');
const Rel = z.string().regex(/^[a-z0-9_]{1,40}\/[a-z0-9_]{1,12}$/);
const Info = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(['spot', 'perp']), contract: z.number().int(),
  meta: z.object({ name: z.string(), version: z.string(), kind: z.string().optional(), universe: z.array(z.string()).min(1), interval: z.string(), lookback: z.number().int().positive(),
    max_leverage: z.number().positive().optional(), max_gross_exposure: z.number().positive().optional(), params: z.record(z.string(), z.unknown()),
    min_symbols: z.number().int().min(1).max(64).optional(), max_symbols: z.number().int().min(1).max(64).optional() }) });
/** the most instruments a perp agent can hold (perp-routes.ts MAX_PERP_INSTRUMENTS; repeated here: that module imports this one) */
const PERP_MAX_INSTRUMENTS = Math.min(8, MAX_AGENT_SYMBOLS);
/** Generic = exactly ['*'] (decided here from META, as strategies.ts does for spot). */
export const isGenericPerp = (universe: string[]): boolean => universe.length === 1 && universe[0] === '*';

export interface PerpStrategyInfo {
  path: string; sha256: string; kind: 'perp';
  /** has 'X.SPOT' legs: a perp agent's paper account cannot hold them */
  spotLegs: boolean;
  /** universe-generic: META['universe'] == ['*'] — the instruments are the AGENT's (between minSymbols and maxSymbols of them) */
  generic: boolean; minSymbols: number; maxSymbols: number;
  meta: { name: string; version: string; kind: 'perp'; universe: string[]; interval: string; lookback: number; max_leverage: number; max_gross_exposure: number; params: Record<string, unknown>; min_symbols?: number; max_symbols?: number };
}

/** Describe a library version under contract 2 and require a perpetual-futures strategy. */
export async function describePerp(rel: string): Promise<PerpStrategyInfo> {
  Rel.parse(rel);
  const dir = path.join(ROOT, rel);
  if (!existsSync(path.join(dir, 'strategy.py'))) throw new UserError('not_found', 'strategy version not found', 404);
  const r = await py(['spq.describe', '--strategy', dir, '--contract', '2'], { timeoutMs: 60_000, strategyDir: dir });
  if (r.code !== 0) throw new UserError('bad_strategy', `the laboratory refused this strategy: ${r.err.trim().split('\n').pop()?.slice(0, 160) ?? ''}`, 422);
  const p = Info.parse(JSON.parse(r.out));
  if (p.kind !== 'perp' || p.contract !== 2 || p.meta.kind !== 'perp') throw new UserError('wrong_kind', 'this is a spot strategy (long-only weights in [0, 1]): it cannot be attached to a perp agent', 422);
  if (p.meta.max_leverage === undefined || p.meta.max_gross_exposure === undefined) throw new UserError('bad_strategy', 'a perp strategy declares max_leverage and max_gross_exposure', 422);
  const generic = isGenericPerp(p.meta.universe);
  if (!generic && p.meta.universe.includes('*')) throw new UserError('bad_strategy', 'a universe is a list of instruments or exactly ["*"]', 422);
  const minSymbols = generic ? p.meta.min_symbols ?? 1 : p.meta.universe.length, maxSymbols = generic ? Math.min(p.meta.max_symbols ?? PERP_MAX_INSTRUMENTS, PERP_MAX_INSTRUMENTS) : p.meta.universe.length;
  if (minSymbols > maxSymbols) throw new UserError('bad_strategy', `this strategy needs at least ${minSymbols} instruments; a perp agent holds ${PERP_MAX_INSTRUMENTS} at most`, 422);
  return { path: `strategies/${rel}`, sha256: p.sha256, kind: 'perp', spotLegs: p.meta.universe.some((s) => s.endsWith('.SPOT')), generic, minSymbols, maxSymbols,
    meta: { ...p.meta, kind: 'perp', max_leverage: p.meta.max_leverage, max_gross_exposure: p.meta.max_gross_exposure } };
}

/** `fn` over `items`, at most `limit` at a time; the answers are in the order of `items` whatever the order of completion. Pure. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  const worker = async (): Promise<void> => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!, i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length)) }, worker));
  return out;
}
/** laboratory processes started at once by a library listing (one `spq.describe` per version: ≈ 1 s each on a quiet machine) */
const DESCRIBE_CONCURRENCY = 4;

export async function perpLibrary(): Promise<(PerpStrategyInfo & { readme: string })[]> {
  if (!existsSync(ROOT)) return [];
  const rels: { name: string; ver: string }[] = [];
  for (const name of readdirSync(ROOT).sort()) { if (!/^[a-z0-9_]{1,40}$/.test(name)) continue;
    if (/^rj_[0-9a-f]{12}$/.test(name)) continue; // v7: a research job's strategy is listed by the research routes
    if (!inLibraryManifest(name)) continue;       // V11 (D10): the production library is an explicit manifest
    for (const ver of readdirSync(path.join(ROOT, name)).sort()) { if (/^[a-z0-9_]{1,12}$/.test(ver)) rels.push({ name, ver }); } }
  // V11 final validation: the versions were described one after the other (19 s for the 14 versions of the library, measured;
  // the first GET /agents/templates of every minute waited for it). Same answers, same order, four processes at a time.
  const described = await mapLimit(rels, DESCRIBE_CONCURRENCY, async ({ name, ver }) => {
    try { const i = await describePerp(`${name}/${ver}`); let readme = '';
      try { readme = readFileSync(path.join(ROOT, name, ver, 'README.md'), 'utf8').slice(0, 1500); } catch { /* none */ }
      return { ...i, readme }; } catch { return null; /* spot, or not loadable: not offered to perp agents */ } });
  return described.filter((x): x is PerpStrategyInfo & { readme: string } => x !== null);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
/** Can this perp version run on an agent trading these instruments at this interval? Pure. A fixed universe must equal the
 *  agent's instruments; a generic one (['*']) fits any agent whose number of instruments is within its bounds. `generic`,
 *  `minSymbols` and `maxSymbols` are read from META when the caller did not derive them (describePerp does). */
export function fitsPerpAgent(info: Pick<PerpStrategyInfo, 'spotLegs' | 'meta'> & Partial<Pick<PerpStrategyInfo, 'generic' | 'minSymbols' | 'maxSymbols'>>, symbols: string[], interval: string): { ok: true } | { ok: false; code: string; message: string } {
  if (info.spotLegs) return { ok: false, code: 'spot_leg_unsupported', message: 'this strategy holds spot legs (X.SPOT) next to the perpetuals; a perp agent\'s paper account holds perpetuals only' };
  if (info.meta.interval !== interval) return { ok: false, code: 'interval_mismatch', message: `this strategy decides every ${info.meta.interval}; the agent is set to ${interval}` };
  if (info.generic ?? isGenericPerp(info.meta.universe)) {
    const min = info.minSymbols ?? info.meta.min_symbols ?? 1, max = info.maxSymbols ?? Math.min(info.meta.max_symbols ?? PERP_MAX_INSTRUMENTS, PERP_MAX_INSTRUMENTS);
    if (symbols.length < min || symbols.length > max) return { ok: false, code: 'universe_size', message: `this strategy needs between ${min} and ${max} instruments; the agent trades ${symbols.length} (${symbols.join(', ')})` };
    if (symbols.some((s) => s.endsWith('.SPOT') || s.includes('@'))) return { ok: false, code: 'universe_mismatch', message: 'a perp agent trades the perpetuals of ONE venue: no spot leg, no second venue' };
    return { ok: true };
  }
  if (!sameSet(info.meta.universe, symbols)) return { ok: false, code: 'universe_mismatch', message: `this strategy trades ${info.meta.universe.join(', ')}; the agent's instruments are ${symbols.join(', ')}` };
  return { ok: true };
}

/** Report schema versions a perp agent accepts: 2 (pre-V11, still stored in existing databases) and 3 (V11: execution model,
 *  engine parity, gross-to-net, data bias, journal — research/schema/backtest-report-v3.schema.json, additive over 2). */
export const isPerpReportVersion = (v: unknown): v is 2 | 3 => v === 2 || v === 3;
/** What a perp report must be before the owner can approve the version (the report's own integrity checks must pass). */
export function perpReportProblem(report: unknown, sha256: string, symbols: string[]): string | null {
  const r = report as { schema_version?: number; kind?: string; strategy_sha256?: string; config?: { symbols?: string[] }; checks?: Record<string, unknown>; engine_parity?: { applied?: unknown } } | null;
  if (!r || !isPerpReportVersion(r.schema_version) || r.kind !== 'perp') return 'the report is not a version-2 or version-3 (perpetual futures) report';
  if (r.strategy_sha256 !== sha256) return 'the report is for another code hash';
  if (!Array.isArray(r.config?.symbols) || !sameSet(r.config.symbols, symbols)) return 'the report is for other instruments than the agent\'s';
  for (const k of ['lookahead', 'ledger', 'funding_alignment']) if (r.checks?.[k] !== 'pass') return `the report's own check "${k}" did not pass: it is not evidence of anything`;
  // V11: a version-3 report is evidence about THIS engine only when the engine's own sizing and stop rules were applied to it
  if (r.schema_version === 3 && r.engine_parity?.applied !== true) return 'this version-3 report was produced WITHOUT engine parity (the live engine\'s sizing, order pacing and loss-limit stops were not applied): its figures are not those of an agent run';
  return null;
}

export interface PerpLabDeps { data: DerivData; store: PerpDataStore; spotCandles?: (symbol: string, interval: string, fromMs: number) => Promise<[number, number, number, number, number, number][]> }
const sizeDecimals = (lot: string): number => { const i = lot.indexOf('.'); return i < 0 ? 0 : lot.length - i - 1; };
const fail = (versionId: string, why: string) => sql`update strategy_versions set status = 'draft', notes = ${`backtest failed: ${why}`.slice(0, 400)} where id = ${versionId} and status = 'backtesting'`;

// One run per version in this process. V11 final validation: a second caller used to get an immediate, empty return while the first
// run was still going — the backtest JOB asked right after a creation (whose registration starts the backtest itself) then found no
// report, failed, and was dead-lettered. A second caller now WAITS for the run in flight and reads its outcome.
const running = new Map<string, Promise<void>>();
/** is a backtest of this version running in THIS process? */
export const perpBacktestInFlight = (versionId: string): boolean => running.has(versionId);
/** Backtest a registered perp version on the venue's own data and attach the version-3 report (V11 execution model + engine
 *  parity). Never throws. */
export function perpBacktest(versionId: string, info: PerpStrategyInfo, symbols: string[], interval: PerpInterval, d: PerpLabDeps): Promise<void> {
  const inFlight = running.get(versionId);
  if (inFlight) return inFlight;
  const run = runPerpBacktest(versionId, info, symbols, interval, d).finally(() => { running.delete(versionId); });
  running.set(versionId, run);
  return run;
}
async function runPerpBacktest(versionId: string, info: PerpStrategyInfo, symbols: string[], interval: PerpInterval, d: PerpLabDeps): Promise<void> {
  const tmp = scratchDir(), out = path.join(tmp, 'report.json'), bundle = path.join(tmp, 'bundle.json'), store = path.join(tmp, 'data');
  try {
    await sql`update strategy_versions set status = 'backtesting', notes = '' where id = ${versionId} and status in ('draft', 'backtesting')`;
    // 1 — the venue's history, through the read-only adapter and the store's rate budget (as much as the venue serves)
    const insts: Instrument[] = [];
    for (const s of symbols) insts.push(await d.data.instrument(`${PERP_VENUE}:${s}`));
    await d.store.backfill(insts, interval, VENUE_MAX_BARS - 1, { deadlineMs: 15 * 60_000 });
    const candles: Record<string, unknown> = {}, funding: Record<string, unknown> = {}, meta: Record<string, unknown> = {};
    let first = Infinity;
    for (const inst of insts) {
      const x = await d.store.exact(inst, interval, VENUE_MAX_BARS);
      if (x.candles.length < info.meta.lookback + 200 || !x.funding.length) return void (await fail(versionId, `${inst.symbol}: only ${x.candles.length} closed ${interval} bars on the venue; not enough for a backtest`));
      candles[inst.symbol] = x.candles; funding[inst.symbol] = x.funding; first = Math.min(first, x.candles[0]![0]);
      meta[inst.symbol] = { max_leverage: Number(inst.maxLeverage), size_decimals: sizeDecimals(inst.lotSize) };
    }
    // spot candles for the buy-and-hold benchmark, when the market engine has them for every symbol (the report says so when not)
    let spot: { source: string; candles: Record<string, unknown> } | undefined;
    if (d.spotCandles) {
      const got: Record<string, unknown> = {};
      for (const s of symbols) { const rows = await d.spotCandles(s, interval, first).catch(() => []); if (rows.length > 500) got[s] = rows; }
      if (Object.keys(got).length === symbols.length) spot = { source: 'coinbase', candles: got };
    }
    writeFileSync(bundle, JSON.stringify({ interval, as_of_ms: d.store.now(), meta, candles, funding, ...(spot ? { spot } : {}) }));
    // 2 — the laboratory, offline: file → store, then the perp backtester. No database URL, no network.
    const imp = await py(['spq.data.hl_import', '--input', bundle, '--out', store], { timeoutMs: 120_000, scratch: tmp });
    if (imp.code !== 0) return void (await fail(versionId, imp.err.trim().split('\n').pop()?.slice(0, 300) ?? 'import'));
    const ledger = stageLedger(tmp), dir = path.join(RESEARCH_DIR, info.path); // v8: the sandboxed process works on a copy of the ledger
    const r = await py(['spq.perp_backtest', '--strategy', dir, '--sha256', info.sha256, '--symbols', symbols.join(','), '--interval', interval, '--data-dir', store, '--out', out,
      '--ledger', ledger.copy, '--report-version', '3'], { timeoutMs: 20 * 60_000, strategyDir: dir, scratch: tmp });
    if (r.code !== 0 || !existsSync(out)) return void (await fail(versionId, r.err.trim().split('\n').pop()?.slice(0, 300) ?? 'no report'));
    ledger.merge();
    const report = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    const r0 = report as { schema_version?: number; kind?: string; strategy_sha256?: string; config?: { symbols?: string[] }; engine_parity?: { applied?: unknown } };
    if (!isPerpReportVersion(r0.schema_version) || r0.kind !== 'perp' || r0.strategy_sha256 !== info.sha256 || !Array.isArray(r0.config?.symbols) || !sameSet(r0.config.symbols, symbols)) return void (await fail(versionId, 'the report is not a version-2 or version-3 report for this code hash and these instruments'));
    if (r0.schema_version === 3 && r0.engine_parity?.applied !== true) return void (await fail(versionId, 'the version-3 report was produced without engine parity: refused'));
    await sql`update strategy_versions set status = 'draft', report = ${sql.json(report as never)}, notes = '' where id = ${versionId} and status = 'backtesting'`;
    await audit('strategy.backtested', 'engine', { version: versionId, sha256: info.sha256, kind: 'perp' });
  } catch (e) { await fail(versionId, (e as Error).message.slice(0, 200)).catch(() => {}); }
  finally { dropScratch(tmp); }
}

/** Pin a perp library version to a perp agent and backtest it; approval stays a separate owner action and needs the report. */
export async function registerPerpStrategy(a: PerpAgentRow, rel: string, d: PerpLabDeps): Promise<{ id: string; sha256: string; kind: 'perp'; symbols: string[]; status: string }> {
  const info = await describePerp(rel);
  const symbols = a.universe, fit = fitsPerpAgent(info, symbols, a.interval);
  if (!fit.ok) throw new UserError(fit.code, fit.message, 422);
  const [row] = await sql<{ id: string; status: string; has_report: boolean }[]>`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta)
    values (${randomUUID()}, ${a.id}, ${info.meta.name}, ${info.meta.version}, ${info.sha256}, ${info.path}, ${sql.json({ ...info.meta, generic: info.generic, symbols } as never)})
    on conflict (agent_id, code_sha256) do update set path = excluded.path returning id, status, report is not null as has_report`;
  await audit('strategy.registered', 'owner', { agent: a.id, version: row!.id, path: info.path, sha256: info.sha256, kind: 'perp', generic: info.generic, symbols });
  if (!row!.has_report && row!.status !== 'approved') void perpBacktest(row!.id, info, symbols, a.interval as PerpInterval, d);
  return { id: row!.id, sha256: info.sha256, kind: 'perp', symbols, status: row!.has_report ? row!.status : 'backtesting' };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/lab-verdicts.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// The laboratory's out-of-sample results as DATA. Nothing in this file states a result: every figure, every stop reason and
// every statement is read at run time from the files the quant lab committed under
//   research/results/<run>/summary.json      one row per strategy version (splits, gross-to-net, stops, deflated Sharpe, trials)
//   research/results/<run>/manifest.json     SHA-256 of every file of the run (used to say whether the files are the committed ones)
//   research/results/<run>/<name>-<version>.json   the version-3 report (data window, splits, journal hashes)
//   research/results/<run>/<study>.json      the model studies (their own `statement`)
// A missing or unreadable file gives `available: false` — never a default figure, never a sentence written here.
//
// What IS decided here, from those data and from the checkout, and labelled as such in the answer:
//   scope          where the strategy file lives: research/strategies → an agent can run it (unless it holds spot legs, which a
//                  perp agent refuses: backtest only); research/strategies_xvenue → research only (two venues: no agent path)
//   liveCapable    scope = agent AND every backtested instrument is in the signer's pinned table (model.ts LIVE_PINNED)
//   significant    deflated Sharpe >= DEFLATED_SHARPE_THRESHOLD (the laboratory's own rule: docs/TRADING-BACKTESTING.md)
// The lab's summary carries NO verdict sentence (its prose verdicts are in docs/v11/work/quant-lab.md, a document): the client
// composes its sentence from these fields.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LIVE_PINNED } from '../agent-runtime/model.ts';
import { RESEARCH_DIR } from './lab.ts';

/** the run whose results are shown (a directory of research/results); SPW_LAB_RESULTS_RUN selects another one */
export const LAB_RUN = (): string => { const v = process.env.SPW_LAB_RESULTS_RUN ?? ''; return /^[A-Za-z0-9._-]{1,60}$/.test(v) && !v.includes('..') ? v : '2026-11-15-v11'; };
/** below this probability "no skill" is not rejected (Bailey & López de Prado; the laboratory's acceptance rule) */
export const DEFLATED_SHARPE_THRESHOLD = 0.95;
export const SPLITS = ['train', 'validation', 'test'] as const;
export type Split = (typeof SPLITS)[number];

export interface LabGrossToNet { pricePnl: number | null; funding: number | null; fees: number | null; liquidationPenalties: number | null; slippage: number | null; latency: number | null; netPnl: number | null }
export interface LabSplit { netReturn: number | null; netSharpe: number | null; grossSharpe: number | null; maxDrawdown: number | null; trades: number | null;
  /** non-null: the engine's own loss limit (or a liquidation) ended this split; the equity is flat afterwards */
  stop: { code: string; reason: string; ts: string | null } | null; grossToNet: LabGrossToNet | null }
export interface LabStrategyVerdict {
  available: true; kind: 'strategy'; backtest: true; name: string; version: string; strategy: string; sha256: string | null; symbols: string[];
  /** where the strategy file is in this checkout (null: not installed here) and whether its hash is the backtested one */
  where: 'strategies' | 'strategies_xvenue' | null; installedHashMatches: boolean | null;
  scope: 'agent' | 'backtest_only' | 'research_only'; liveCapable: boolean;
  deflatedSharpe: number | null; deflatedSharpeThreshold: number; significant: boolean | null; trialsTested: number | null; ownTrials: number | null; testSharpeCi: [number, number] | null;
  splits: Record<Split, LabSplit | null>; stoppedSplits: Split[];
  checks: Record<string, string> | null;
  /** from the strategy's own report: the data window and the dates of each split */
  window: { start: string | null; end: string | null; interval: string | null; bars: number | null } | null; splitDates: Record<string, [string, string]> | null;
  dataSha256: string | null; codeSha256: string | null; engineParityApplied: boolean | null;
  results: { dir: string; file: string | null; fileSha256: string | null; matchesManifest: boolean | null };
}
export interface LabStudyVerdict {
  available: true; kind: 'study'; backtest: false; name: string;
  /** the study's own statement, verbatim from its result file (null: the file has none) */
  statement: string | null; assumptions: string[]; fillsAreModelled: boolean | null;
  results: { dir: string; file: string; fileSha256: string; matchesManifest: boolean | null };
}
export interface LabUnavailable { available: false; kind: 'strategy' | 'study' | 'policy'; name: string; reason: string }
export type LabVerdict = LabStrategyVerdict | LabStudyVerdict | LabUnavailable;
export interface LabRun {
  available: boolean; reason: string | null; run: string; dir: string;
  summary: { file: string; sha256: string; matchesManifest: boolean | null } | null;
  trials: number | null; codeSha256: string | null; dataManifest: string | null;
  strategies: LabStrategyVerdict[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null);
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
function readJson(file: string): { json: unknown; sha256: string } | null {
  try { const buf = readFileSync(file); return { json: JSON.parse(buf.toString('utf8')), sha256: sha(buf) }; } catch { return null; }
}

function splitOf(row: Record<string, any>, s: Split): LabSplit | null {
  const x = obj(row[s]); if (!x) return null;
  const g = obj(x.gross_to_net), st = obj(x.stop);
  return { netReturn: num(x.return_net), netSharpe: num(x.sharpe_net), grossSharpe: num(x.sharpe_gross), maxDrawdown: num(x.max_drawdown), trades: num(x.trades),
    stop: st && typeof st.code === 'string' ? { code: st.code, reason: str(st.reason) ?? st.code, ts: str(st.ts) } : null,
    grossToNet: g ? { pricePnl: num(g.price_pnl), funding: num(g.funding), fees: num(g.trading_fees), liquidationPenalties: num(g.liquidation_penalties), slippage: num(g.slippage), latency: num(g.latency), netPnl: num(g.net_pnl) } : null };
}

function strategyVerdict(row: Record<string, any>, research: string, run: string, manifest: Record<string, any> | null): LabStrategyVerdict | null {
  const id = str(row.strategy); if (!id || !/^[a-z0-9_]{1,40}\/[a-z0-9_]{1,12}$/.test(id)) return null;
  const [name, version] = id.split('/') as [string, string], symbols: string[] = Array.isArray(row.symbols) ? row.symbols.filter((s: unknown) => typeof s === 'string') : [];
  const where = (['strategies', 'strategies_xvenue'] as const).find((d) => existsSync(path.join(research, d, name, version, 'strategy.py'))) ?? null;
  let installedHashMatches: boolean | null = null;
  if (where && typeof row.sha256 === 'string') { try { installedHashMatches = sha(readFileSync(path.join(research, where, name, version, 'strategy.py'))) === row.sha256; } catch { /* unreadable: unknown */ } }
  // an agent runs perpetuals of ONE venue: a spot leg or a second venue takes the strategy out of the agent path
  const otherLegs = symbols.some((s) => s.endsWith('.SPOT') || s.includes('@'));
  const scope: LabStrategyVerdict['scope'] = where === 'strategies' && !otherLegs ? 'agent' : where === 'strategies' ? 'backtest_only' : 'research_only';
  const splits = Object.fromEntries(SPLITS.map((s) => [s, splitOf(row, s)])) as Record<Split, LabSplit | null>;
  const deflated = num(row.deflated_sharpe), ci = Array.isArray(row.test_sharpe_ci) && row.test_sharpe_ci.length === 2 && row.test_sharpe_ci.every((v: unknown) => num(v) !== null) ? [row.test_sharpe_ci[0], row.test_sharpe_ci[1]] as [number, number] : null;
  const file = `${name}-${version}.json`, rep = readJson(path.join(research, 'results', run, file)), r = obj(rep?.json), cfg = obj(r?.config), journal = obj(r?.journal);
  const want = str(obj(manifest?.reports)?.[file]);
  return { available: true, kind: 'strategy', backtest: true, name, version, strategy: id, sha256: str(row.sha256), symbols, where, installedHashMatches, scope,
    liveCapable: scope === 'agent' && symbols.length > 0 && symbols.every((s) => (LIVE_PINNED as readonly string[]).includes(s)),
    deflatedSharpe: deflated, deflatedSharpeThreshold: DEFLATED_SHARPE_THRESHOLD, significant: deflated === null ? null : deflated >= DEFLATED_SHARPE_THRESHOLD,
    trialsTested: num(row.trials_tested), ownTrials: num(row.own_trials), testSharpeCi: ci, splits, stoppedSplits: SPLITS.filter((s) => splits[s]?.stop),
    checks: obj(row.checks) ? Object.fromEntries(Object.entries(obj(row.checks)!).filter(([, v]) => typeof v === 'string')) as Record<string, string> : null,
    window: r ? { start: str(cfg?.start), end: str(cfg?.end), interval: str(cfg?.interval), bars: num(cfg?.bars) } : null,
    splitDates: obj(r?.splits) ? Object.fromEntries(Object.entries(obj(r!.splits)!).filter(([, v]) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string'))) as Record<string, [string, string]> : null,
    dataSha256: str(obj(journal?.data)?.sha256), codeSha256: str(obj(journal?.code)?.code_sha256), engineParityApplied: r ? obj(r.engine_parity)?.applied === true : null,
    results: { dir: `research/results/${run}`, file: rep ? file : null, fileSha256: rep?.sha256 ?? null, matchesManifest: rep && want ? rep.sha256 === want : null } };
}

let cache: { key: string; value: LabRun } | null = null;
/** The run's summary, read from the research directory (cached until summary.json changes). */
export function labRun(research: string = RESEARCH_DIR, run: string = LAB_RUN()): LabRun {
  const dir = `research/results/${run}`, file = path.join(research, 'results', run, 'summary.json');
  const none = (reason: string): LabRun => ({ available: false, reason, run, dir, summary: null, trials: null, codeSha256: null, dataManifest: null, strategies: [] });
  let key: string;
  try { const st = statSync(file); key = `${file}:${st.mtimeMs}:${st.size}`; } catch { return none('the laboratory\'s results file is not in this installation'); }
  if (cache?.key === key) return cache.value;
  const s = readJson(file), j = obj(s?.json);
  if (!s || !j || !Array.isArray(j.rows)) return none('the laboratory\'s results file could not be read');
  const manifest = obj(readJson(path.join(research, 'results', run, 'manifest.json'))?.json), want = str(obj(manifest?.reports)?.['summary.json']);
  const strategies = j.rows.map((row: unknown) => (obj(row) ? strategyVerdict(obj(row)!, research, run, manifest) : null)).filter((x: LabStrategyVerdict | null): x is LabStrategyVerdict => x !== null);
  const value: LabRun = { available: true, reason: null, run, dir, summary: { file: 'summary.json', sha256: s.sha256, matchesManifest: want ? s.sha256 === want : null },
    trials: num(j.n_trials), codeSha256: str(manifest?.code_sha256), dataManifest: str(manifest?.data_manifest), strategies };
  cache = { key, value };
  return value;
}

/** A model study or a policy of the laboratory: its own statement, verbatim, when its result file exists. */
export function labStudy(name: string, kind: 'study' | 'policy', research: string = RESEARCH_DIR, run: string = LAB_RUN()): LabStudyVerdict | LabUnavailable {
  if (!/^[a-z0-9_]{1,40}$/.test(name)) return { available: false, kind, name, reason: 'not a laboratory name' };
  const file = `${name}.json`, s = readJson(path.join(research, 'results', run, file)), j = obj(s?.json);
  if (!s || !j) return { available: false, kind, name, reason: kind === 'policy' ? 'a policy of the laboratory: it has no result file' : 'this study has no result file in this installation' };
  const want = str(obj(obj(readJson(path.join(research, 'results', run, 'manifest.json'))?.json)?.reports)?.[file]);
  return { available: true, kind: 'study', backtest: false, name, statement: str(j.statement), assumptions: Array.isArray(j.assumptions) ? j.assumptions.filter((a: unknown) => typeof a === 'string').slice(0, 12) : [],
    fillsAreModelled: typeof j.fills_are_modelled === 'boolean' ? j.fills_are_modelled : null, results: { dir: `research/results/${run}`, file, fileSha256: s.sha256, matchesManifest: want ? s.sha256 === want : null } };
}

/** Every result of the run for a strategy NAME (`name` = every version, `name/version` = that one), in the summary's order. */
export function labVerdictsFor(names: readonly string[], studies: readonly { name: string; kind: 'study' | 'policy' }[] = [], research: string = RESEARCH_DIR, run: string = LAB_RUN()): LabVerdict[] {
  const r = labRun(research, run), out: LabVerdict[] = [], seen = new Set<string>();
  for (const wanted of names) {
    const base = wanted.split('/')[0]!;
    if (!r.available) { if (!seen.has(base)) { seen.add(base); out.push({ available: false, kind: 'strategy', name: base, reason: r.reason ?? 'unavailable' }); } continue; }
    const hits = r.strategies.filter((s) => (wanted.includes('/') ? s.strategy === wanted : s.name === wanted) && !seen.has(s.strategy));
    for (const h of hits) { seen.add(h.strategy); out.push(h); }
    if (!hits.length && !r.strategies.some((s) => s.name === base) && !seen.has(base)) { seen.add(base); out.push({ available: false, kind: 'strategy', name: base, reason: `not part of the run ${r.run}` }); }
  }
  for (const s of studies) out.push(labStudy(s.name, s.kind, research, run));
  return out;
}

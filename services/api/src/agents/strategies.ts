// Strategy library and backtests. The API never writes strategy code: it lists what the research zone put under
// research/strategies, pins a version by the SHA-256 of its strategy.py, and runs the laboratory's backtest on stored candles.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { z } from 'zod';
import { JOB_STRATEGY_RE, listingSources, MAX_AGENT_SYMBOLS } from '@spw/core';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { dropScratch, labExec, RESEARCH_DIR, scratchDir } from './lab.ts';
import { inLibraryManifest } from '../agent-runtime/model.ts';
import { agentSymbols, type AgentRow } from './routes.ts';

const ROOT = path.join(RESEARCH_DIR, 'strategies');
export interface StrategyInfo { path: string; sha256: string;
  /** universe-generic: META['universe'] == ['*'], the symbols are the agent's (between minSymbols and maxSymbols of them) */
  generic: boolean; minSymbols: number; maxSymbols: number;
  meta: { name: string; version: string; universe: string[]; interval: string; lookback: number; params: Record<string, unknown>; min_symbols?: number; max_symbols?: number } }

/** Run a laboratory command (v8: always inside the OS sandbox of lab.ts — no network, NO database URL, read-only laboratory,
 *  one scratch directory). `strategyDir` is the only strategy directory the process can read. Never throws: when the sandbox
 *  is unavailable the answer is `code: null` with the reason, exactly like a process that could not start. */
export function py(args: string[], o: { timeoutMs: number; strategyDir?: string; readable?: string[]; scratch?: string } = { timeoutMs: 60_000 }): Promise<{ code: number | null; out: string; err: string }> {
  return labExec(args, o).then((r) => ({ code: r.killed ? null : r.code, out: r.out, err: r.killed ? `${r.err}\nkilled: ${r.killed}` : r.err }),
    (e: Error) => ({ code: null, out: '', err: `could not start: ${e.message}` }));
}

const Rel = z.string().regex(/^[a-z0-9_]{1,40}\/[a-z0-9_]{1,12}$/);
const Info = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), meta: z.object({ name: z.string(), version: z.string(), universe: z.array(z.string()).min(1), interval: z.string(), lookback: z.number().int().positive(), params: z.record(z.string(), z.unknown()),
  min_symbols: z.number().int().min(1).max(MAX_AGENT_SYMBOLS).optional(), max_symbols: z.number().int().min(1).max(MAX_AGENT_SYMBOLS).optional() }) });
/** Generic = exactly ['*'] (decided here from META, not from what the laboratory says about it). */
export const isGeneric = (universe: string[]): boolean => universe.length === 1 && universe[0] === '*';
const cache = new Map<string, StrategyInfo>();
export async function describe(rel: string): Promise<StrategyInfo> {
  Rel.parse(rel);
  const dir = path.join(ROOT, rel);
  if (!existsSync(path.join(dir, 'strategy.py'))) throw new UserError('not_found', 'strategy version not found', 404);
  const r = await py(['spq.describe', '--strategy', dir], { timeoutMs: 60_000, strategyDir: dir });
  if (r.code !== 0) throw new UserError('bad_strategy', `the laboratory refused this strategy: ${r.err.trim().split('\n').pop()?.slice(0, 160) ?? ''}`, 422);
  const p = Info.parse(JSON.parse(r.out));
  const generic = isGeneric(p.meta.universe);
  if (!generic && p.meta.universe.includes('*')) throw new UserError('bad_strategy', 'a universe is a list of symbols or exactly ["*"]', 422);
  const info: StrategyInfo = { path: `strategies/${rel}`, ...p, generic, minSymbols: generic ? p.meta.min_symbols ?? 1 : p.meta.universe.length, maxSymbols: generic ? p.meta.max_symbols ?? MAX_AGENT_SYMBOLS : p.meta.universe.length };
  cache.set(`${rel}:${p.sha256}`, info);
  return info;
}
export async function library(): Promise<(StrategyInfo & { readme: string })[]> {
  if (!existsSync(ROOT)) return [];
  const rels: [string, string][] = [];
  for (const name of readdirSync(ROOT).sort()) { if (!/^[a-z0-9_]{1,40}$/.test(name)) continue;
    if (JOB_STRATEGY_RE.test(name)) continue; // v7: a research job's strategy is listed by the research routes, with its server report
    if (!inLibraryManifest(name)) continue;   // V11 (D10): the production library is an explicit manifest — a fixture or a scratch directory is never listed
    for (const ver of readdirSync(path.join(ROOT, name)).sort()) if (/^[a-z0-9_]{1,12}$/.test(ver)) rels.push([name, ver]); }
  // LISTING ONLY (the page waited ~20 s: one laboratory process per version, one after the other). A version already described
  // under the same code hash is served from memory, the others are described in parallel. Registration still calls describe().
  const found = await Promise.all(rels.map(async ([name, ver]) => {
    try { let hit: StrategyInfo | undefined;
      try { hit = cache.get(`${name}/${ver}:${createHash('sha256').update(readFileSync(path.join(ROOT, name, ver, 'strategy.py'))).digest('hex')}`); } catch { /* unreadable: describe() decides */ }
      const i = hit ?? await describe(`${name}/${ver}`); let readme = '';
      for (const f of [path.join(ROOT, name, ver, 'README.md'), path.join(ROOT, name, '1', 'README.md')]) { try { readme = readFileSync(f, 'utf8').slice(0, 1500); if (readme.length > 200) break; } catch { /* none */ } }
      return [{ ...i, readme }]; } catch { return []; /* not loadable: not offered */ }
  }));
  return found.flat();
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Can this library version be attached to an agent trading these symbols at this interval? Pure. A fixed universe must
 *  equal the agent's symbols; a generic one fits any agent whose number of symbols is within its bounds. */
export function fitsAgent(info: Pick<StrategyInfo, 'generic' | 'minSymbols' | 'maxSymbols' | 'meta'>, symbols: string[], interval: string): { ok: true } | { ok: false; code: string; message: string } {
  if (info.meta.interval !== interval) return { ok: false, code: 'interval_mismatch', message: `this strategy decides every ${info.meta.interval}; the agent is set to ${interval}` };
  if (info.generic) {
    if (symbols.length < info.minSymbols || symbols.length > info.maxSymbols) return { ok: false, code: 'universe_size', message: `this strategy needs between ${info.minSymbols} and ${info.maxSymbols} symbols; the agent trades ${symbols.length} (${symbols.join(', ')})` };
    return { ok: true };
  }
  if (!sameSet(info.meta.universe, symbols)) return { ok: false, code: 'universe_mismatch', message: `this strategy trades ${info.meta.universe.join(', ')}; the agent's assets are ${symbols.join(', ')}` };
  return { ok: true };
}
/** The laboratory backtests on ONE candle source (it never mixes them): the first, in the consolidation order, that lists every symbol. */
export function backtestSource(symbols: string[]): string | null {
  return (['coinbase', 'bitstamp', 'kraken'] as const).find((src) => symbols.every((x) => listingSources(x).includes(src))) ?? null;
}

const BAR: Record<string, string> = { '1h': '1 hour', '4h': '4 hours', '1d': '1 day' };
/** v8: the candles of a backtest as FILES prepared by the API (the laboratory process has no database URL and no network):
 *  `<root>/<source>/<SYMBOL>_<interval>.csv`, every closed bar of ONE source, oldest first — the rows the laboratory's own
 *  PostgreSQL loader used to read (`spq.data.pg.read_pg`), in the layout its file loader reads. Numbers are written in their
 *  shortest round-trip form and pandas parses them back to the exact float64 (measured; lab-identity.test.ts): same values. */
export async function exportCandles(root: string, source: string, symbols: string[], interval: string, db: typeof sql = sql): Promise<void> {
  const step = BAR[interval];
  if (!step) throw new Error(`unsupported interval ${interval}`);
  for (const sym of symbols) {
    const rows = await db<{ t: string; o: number; h: number; l: number; c: number; v: number }[]>`select extract(epoch from ts)::bigint::text as t, open as o, high as h, low as l, close as c, volume as v
      from candles where source = ${source} and symbol = ${sym} and interval = ${interval} and ts + ${step}::interval <= now() order by ts`;
    if (!rows.length) throw new Error(`no ${interval} candles of ${sym} from ${source} in the market store`);
    const f = path.join(root, source, `${sym}_${interval}.csv`); mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, `ts,open,high,low,close,volume\n${rows.map((r) => `${r.t},${r.o},${r.h},${r.l},${r.c},${r.v}`).join('\n')}\n`);
  }
}

/** Where the candles of a backtest are read from: RESEARCH_DATABASE_URL when it is set (the read-only role of the research
 *  zone — before v8 this URL was handed to the laboratory process itself), else the API's own connection. Read-only session. */
export async function withCandleDb<T>(fn: (db: typeof sql) => Promise<T>): Promise<T> {
  const url = process.env.RESEARCH_DATABASE_URL;
  if (!url) return fn(sql);
  const db = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {}, connection: { default_transaction_read_only: true } });
  try { return await fn(db as unknown as typeof sql); } finally { await db.end({ timeout: 5 }).catch(() => {}); }
}

/** The cross-run trial ledger (research/results/ledger.jsonl) is written by the API, never by the sandboxed process: the
 *  process works on a copy in its scratch directory; the lines it APPENDED are then added to the real file. A copy whose
 *  beginning no longer matches (rewritten history) is not merged. */
export const LEDGER = (): string => path.join(RESEARCH_DIR, 'results', 'ledger.jsonl');
export function stageLedger(scratch: string): { copy: string; merge(): boolean } {
  const real = LEDGER(), copy = path.join(scratch, 'ledger.jsonl'), before = existsSync(real) ? readFileSync(real, 'utf8') : '';
  if (before) writeFileSync(copy, before); // (no file at all when there is no ledger yet, as before)
  return { copy, merge: () => { let after = ''; try { after = readFileSync(copy, 'utf8'); } catch { return false; }
    if (!after.startsWith(before)) return false;
    const added = after.slice(before.length);
    if (added) { mkdirSync(path.dirname(real), { recursive: true }); appendFileSync(real, added); }
    return true; } };
}

const running = new Set<string>();
/** Backtest a registered version on the stored candles and attach the report. Never throws; the outcome is stored on the row. */
export async function backtest(versionId: string, info: StrategyInfo, symbols: string[]): Promise<void> {
  if (running.has(versionId)) return; running.add(versionId);
  const tmp = scratchDir(), out = path.join(tmp, 'report.json'), data = path.join(tmp, 'data');
  try {
    await sql`update strategy_versions set status = 'backtesting', notes = '' where id = ${versionId} and status in ('draft', 'backtesting')`;
    const source = backtestSource(symbols);
    if (!source || !symbols.every((x) => /^[A-Z0-9]{2,10}$/.test(x))) { await sql`update strategy_versions set status = 'draft', notes = ${`backtest failed: no single exchange lists every symbol (${symbols.join(', ')}); the laboratory does not mix candle sources`} where id = ${versionId} and status = 'backtesting'`; return; }
    // v8: the candles are handed over as files by THIS process; the laboratory process is offline and has no database URL
    await withCandleDb((db) => exportCandles(data, source, symbols, info.meta.interval, db));
    const ledger = stageLedger(tmp), dir = path.join(RESEARCH_DIR, info.path);
    // the agent's symbols are always passed: a generic strategy has no list of its own, a fixed one equals them (checked at registration)
    const r = await py(['spq.backtest', '--strategy', dir, '--sha256', info.sha256, '--symbols', symbols.join(','), '--data-dir', data, '--source', source, '--out', out, '--ledger', ledger.copy,
      // V11: the live spot engine's default caps and loss-limit stop are applied to the backtest (research/src/spq/params/engine-parity.json); the report stays version 1 and its checks.notes state them
      '--engine-parity'],
      { timeoutMs: 20 * 60_000, strategyDir: dir, scratch: tmp });
    if (r.code !== 0 || !existsSync(out)) { await sql`update strategy_versions set status = 'draft', notes = ${`backtest failed: ${r.err.trim().split('\n').pop()?.slice(0, 300) ?? 'no report'}`} where id = ${versionId} and status = 'backtesting'`; return; }
    ledger.merge();
    const report = JSON.parse(readFileSync(out, 'utf8')) as { strategy_sha256?: string; config?: { symbols?: string[] } };
    if (report.strategy_sha256 !== info.sha256) { await sql`update strategy_versions set status = 'draft', notes = 'backtest report is for another code hash' where id = ${versionId}`; return; }
    // the report must be about the agent's own symbols (it records them in config.symbols)
    if (!Array.isArray(report.config?.symbols) || !sameSet(report.config.symbols, symbols)) { await sql`update strategy_versions set status = 'draft', notes = 'backtest report is for other symbols than the agent\'s' where id = ${versionId}`; return; }
    await sql`update strategy_versions set status = 'draft', report = ${sql.json(report as never)}, notes = '' where id = ${versionId} and status = 'backtesting'`;
    await audit('strategy.backtested', 'engine', { version: versionId, sha256: info.sha256 });
  } catch (e) { await sql`update strategy_versions set status = 'draft', notes = ${`backtest failed: ${(e as Error).message.slice(0, 200)}`} where id = ${versionId} and status = 'backtesting'`.catch(() => {}); }
  finally { running.delete(versionId); dropScratch(tmp); }
}

/** Pin a library version (or a research job's `rj_*`) to an agent and start its backtest. Used by the owner's route and by the
 *  trading API (`POST /strategies`): registration writes no code and approves nothing. */
export async function registerStrategy(agentId: string, rel: string, actor: string): Promise<{ id: string; sha256: string; status: string; [k: string]: unknown }> {
  Rel.parse(rel);
  const [a] = await sql<AgentRow[]>`select * from agents where id = ${agentId}`;
  if (!a) throw new UserError('not_found', 'agent not found', 404);
  if (a.kind && a.kind !== 'spot' && a.kind !== 'perp') throw new UserError('wrong_kind', 'this agent runs a built-in rule of the stream engine: it takes no laboratory strategy', 409);
  // v7: a research job's strategy (rj_*) is attached with the server report of its job — never re-described or re-backtested without the job's trial count
  if (JOB_STRATEGY_RE.test(rel.split('/')[0]!)) return (await import('../research/evaluate.ts')).attachJobStrategy(a, rel) as never;
  // v6: a perp agent takes only contract-2 strategies (described with --contract 2, backtested by spq.perp_backtest)
  if (a.kind === 'perp') { const p = await import('./perp-routes.ts'); return p.registerPerp(a as never, rel); }
  const info = await describe(rel);
  const symbols = agentSymbols(a), fit = fitsAgent(info, symbols, a.interval);
  if (!fit.ok) throw new UserError(fit.code, fit.message, 422);
  const [row] = await sql<{ id: string; status: string; has_report: boolean }[]>`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta)
    values (${randomUUID()}, ${a.id}, ${info.meta.name}, ${info.meta.version}, ${info.sha256}, ${info.path}, ${sql.json({ ...info.meta, generic: info.generic, symbols } as never)})
    on conflict (agent_id, code_sha256) do update set path = excluded.path returning id, status, report is not null as has_report`;
  await audit('strategy.registered', actor, { agent: a.id, version: row!.id, path: info.path, sha256: info.sha256, generic: info.generic, symbols });
  if (!row!.has_report && row!.status !== 'approved') void backtest(row!.id, info, symbols);
  return { id: row!.id, sha256: info.sha256, generic: info.generic, symbols, status: row!.has_report ? row!.status : 'backtesting' };
}

export function strategyRoutes(app: FastifyInstance): void {
  // v6: `?kind=perp` lists the contract-2 library (perp agents); without it the spot library, which can never contain a perp strategy
  app.get('/api/v1/strategies', async (req) => {
    const q = z.object({ kind: z.enum(['spot', 'perp']).default('spot') }).parse(req.query);
    if (q.kind === 'perp') return { kind: 'perp', strategies: await (await import('./perp-routes.ts')).perpLibrary() };
    return { strategies: await library() };
  });

  // pin a library version to an agent and backtest it; approval stays a separate owner action and needs the report
  app.post('/api/v1/agents/:id/strategies', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const b = z.strictObject({ path: Rel }).parse(req.body);
    return registerStrategy(id, b.path, 'owner');
  });
}

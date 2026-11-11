// Strategy library and backtests. The API never writes strategy code: it lists what the research zone put under
// research/strategies, pins a version by the SHA-256 of its strategy.py, and runs the laboratory's backtest on stored candles.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { RESEARCH_DIR } from './live.ts';
import type { AgentRow } from './routes.ts';

const UV = process.env.SPW_UV_BIN ?? 'uv';
const ROOT = path.join(RESEARCH_DIR, 'strategies');
export interface StrategyInfo { path: string; sha256: string; meta: { name: string; version: string; universe: string[]; interval: string; lookback: number; params: Record<string, unknown> } }

/** Run a laboratory command with a minimal environment (no wallet secret; the database URL only when asked). */
export function py(args: string[], o: { timeoutMs: number; env?: Record<string, string> } = { timeoutMs: 60_000 }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const home = process.env.HOME ?? '/tmp';
    const ch = spawn(UV, ['run', '--frozen', '--no-sync', 'python', '-m', ...args], { cwd: RESEARCH_DIR, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home, UV_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', ...o.env } });
    let out = '', err = '';
    const timer = setTimeout(() => ch.kill('SIGKILL'), o.timeoutMs);
    ch.stdout.on('data', (c: Buffer) => { if (out.length < 2_000_000) out += c; });
    ch.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-4000); });
    ch.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: `could not start: ${e.message}` }); });
    ch.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const Rel = z.string().regex(/^[a-z0-9_]{1,40}\/[a-z0-9_]{1,12}$/);
const Info = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), meta: z.object({ name: z.string(), version: z.string(), universe: z.array(z.string()).min(1), interval: z.string(), lookback: z.number().int().positive(), params: z.record(z.string(), z.unknown()) }) });
const cache = new Map<string, StrategyInfo>();
export async function describe(rel: string): Promise<StrategyInfo> {
  Rel.parse(rel);
  const dir = path.join(ROOT, rel);
  if (!existsSync(path.join(dir, 'strategy.py'))) throw new UserError('not_found', 'strategy version not found', 404);
  const r = await py(['spq.describe', '--strategy', dir]);
  if (r.code !== 0) throw new UserError('bad_strategy', `the laboratory refused this strategy: ${r.err.trim().split('\n').pop()?.slice(0, 160) ?? ''}`, 422);
  const p = Info.parse(JSON.parse(r.out));
  const info = { path: `strategies/${rel}`, ...p };
  cache.set(`${rel}:${p.sha256}`, info);
  return info;
}
export async function library(): Promise<(StrategyInfo & { readme: string })[]> {
  const out: (StrategyInfo & { readme: string })[] = [];
  if (!existsSync(ROOT)) return out;
  for (const name of readdirSync(ROOT).sort()) { if (!/^[a-z0-9_]{1,40}$/.test(name)) continue;
    for (const ver of readdirSync(path.join(ROOT, name)).sort()) { if (!/^[a-z0-9_]{1,12}$/.test(ver)) continue;
      try { const i = await describe(`${name}/${ver}`); let readme = '';
        for (const f of [path.join(ROOT, name, ver, 'README.md'), path.join(ROOT, name, '1', 'README.md')]) { try { readme = readFileSync(f, 'utf8').slice(0, 1500); if (readme.length > 200) break; } catch { /* none */ } }
        out.push({ ...i, readme }); } catch { /* not loadable: not offered */ } } }
  return out;
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const running = new Set<string>();
/** Backtest a registered version on the stored candles and attach the report. Never throws; the outcome is stored on the row. */
export async function backtest(versionId: string, info: StrategyInfo): Promise<void> {
  if (running.has(versionId)) return; running.add(versionId);
  const tmp = mkdtempSync(path.join(tmpdir(), 'spw-bt-')), out = path.join(tmp, 'report.json');
  try {
    await sql`update strategy_versions set status = 'backtesting', notes = '' where id = ${versionId} and status in ('draft', 'backtesting')`;
    const r = await py(['spq.backtest', '--strategy', path.join(RESEARCH_DIR, info.path), '--sha256', info.sha256, '--out', out, '--ledger', path.join(RESEARCH_DIR, 'results', 'ledger.jsonl')],
      { timeoutMs: 20 * 60_000, env: { DATABASE_URL: process.env.RESEARCH_DATABASE_URL ?? config.databaseUrl, SPQ_CANDLE_SOURCE: 'coinbase' } }); // the loader opens a read-only session
    if (r.code !== 0 || !existsSync(out)) { await sql`update strategy_versions set status = 'draft', notes = ${`backtest failed: ${r.err.trim().split('\n').pop()?.slice(0, 300) ?? 'no report'}`} where id = ${versionId} and status = 'backtesting'`; return; }
    const report = JSON.parse(readFileSync(out, 'utf8')) as { strategy_sha256?: string };
    if (report.strategy_sha256 !== info.sha256) { await sql`update strategy_versions set status = 'draft', notes = 'backtest report is for another code hash' where id = ${versionId}`; return; }
    await sql`update strategy_versions set status = 'draft', report = ${sql.json(report as never)}, notes = '' where id = ${versionId} and status = 'backtesting'`;
    await audit('strategy.backtested', 'engine', { version: versionId, sha256: info.sha256 });
  } catch (e) { await sql`update strategy_versions set status = 'draft', notes = ${`backtest failed: ${(e as Error).message.slice(0, 200)}`} where id = ${versionId} and status = 'backtesting'`.catch(() => {}); }
  finally { running.delete(versionId); rmSync(tmp, { recursive: true, force: true }); }
}

export function strategyRoutes(app: FastifyInstance): void {
  app.get('/api/v1/strategies', async () => ({ strategies: await library() }));

  // pin a library version to an agent and backtest it; approval stays a separate owner action and needs the report
  app.post('/api/v1/agents/:id/strategies', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const b = z.strictObject({ path: Rel }).parse(req.body);
    const [a] = await sql<AgentRow[]>`select * from agents where id = ${id}`;
    if (!a) throw new UserError('not_found', 'agent not found', 404);
    const info = await describe(b.path);
    if (!sameSet(info.meta.universe, a.universe.filter((s) => s !== 'USDC'))) throw new UserError('universe_mismatch', `this strategy trades ${info.meta.universe.join(', ')}; the agent's assets are ${a.universe.join(', ')}`, 422);
    if (info.meta.interval !== a.interval) throw new UserError('interval_mismatch', `this strategy decides every ${info.meta.interval}; the agent is set to ${a.interval}`, 422);
    const [row] = await sql<{ id: string; status: string; has_report: boolean }[]>`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta)
      values (${randomUUID()}, ${a.id}, ${info.meta.name}, ${info.meta.version}, ${info.sha256}, ${info.path}, ${sql.json(info.meta as never)})
      on conflict (agent_id, code_sha256) do update set path = excluded.path returning id, status, report is not null as has_report`;
    await audit('strategy.registered', 'owner', { agent: a.id, version: row!.id, path: info.path, sha256: info.sha256 });
    if (!row!.has_report && row!.status !== 'approved') void backtest(row!.id, info);
    return { id: row!.id, sha256: info.sha256, status: row!.has_report ? row!.status : 'backtesting' };
  });
}

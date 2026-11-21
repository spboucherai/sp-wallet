/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/lib/research-harness.mts
 * Module           : scripts
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

// A complete research stack in one process, for scripts/sim-research-job.mts and tests/e2e/research-server.mts:
// the REAL wallet API on a scratch PostgreSQL database (seeded with synthetic candles), a stub signer that only answers
// GET /status, and the REAL research runner polling that API over HTTP with its own shared secret. The coding agent is
// either the deterministic fake (test/fixtures/fake-agent.mjs) or the real Claude Code CLI talking to a scripted mock model.
// No real key, no real model call, no network beyond loopback.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerConfig } from '../../services/research-runner/src/config.ts';
import { startMockModel, type MockBlock, type MockModel } from './mock-model-api.mts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LAB = path.join(ROOT, 'research');

/** the scripted "model" of --claude-mock: a short, honest research session played through the real CLI's Bash tool */
export const MOCK_SESSION: MockBlock[][] = [
  [{ type: 'text', text: 'Reading the job and its data.' }, { type: 'tool_use', name: 'Bash', input: { command: 'python -m spq.job info' } }],
  [{ type: 'text', text: 'Hypothesis first: hourly returns are positively autocorrelated over a few days. Writing the candidate before any backtest.' },
    { type: 'tool_use', name: 'Bash', input: { command: `mkdir -p candidates/a && python - <<'PY'
import json, os
job = json.load(open(os.environ["SPQ_JOB_FILE"]))
src = '''"""Trend rule written by the research agent: hold an asset while its fast mean is above its slow mean."""

META = {
    "name": %r,
    "version": %r,
    "universe": %s,
    "interval": %r,
    "lookback": 300,
    "params": {"fast": 24, "slow": 96},
}


def target_weights(data, params):
    fast, slow = int(params["fast"]), int(params["slow"])
    n = len(data)
    out = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < slow:
            out[symbol] = 0.0
            continue
        out[symbol] = 1.0 / n if close[-fast:].mean() > close[-slow:].mean() else 0.0
    return out
''' % (job["name"], job["version"], json.dumps(job["symbols"]), job["interval"])
open("candidates/a/strategy.py", "w").write(src)
PY
python -m spq.describe --strategy candidates/a && python -m spq.job trial --strategy candidates/a` } }],
  [{ type: 'text', text: 'One alternative, to see whether the result depends on the fast window.' }, { type: 'tool_use', name: 'Bash', input: { command: `python -m spq.job trial --strategy candidates/a --params '{"fast": 12}'` } }],
  [{ type: 'text', text: 'Keeping the parameters written before the trials. The single look at the inner test split now.' },
    { type: 'tool_use', name: 'Bash', input: { command: 'cp candidates/a/strategy.py submission/strategy.py && python -m spq.job evaluate --strategy submission --out report.json --claims submission/claims.json' } }],
  [{ type: 'tool_use', name: 'Bash', input: { command: `cat > submission/README.md <<'MD'
# Trend rule (fast mean above slow mean)

**Hypothesis.** Hourly returns of the two assets are positively autocorrelated at the horizon of a few days.

**Mechanism.** Hold an asset, at equal weight, while its 24-hour mean is above its 96-hour mean; otherwise cash.

**What would refute it.** A test-split Sharpe ratio whose bootstrap interval contains zero, or a result below buy and hold after costs. Both are reported by the server on data this job never had.

Parameters (24 / 96) were written before any trial. Nothing here says the rule is profitable.
MD
cat > submission/NOTES.md <<'MD'
# Research notes

1. \`spq.job info\`: data and splits.
2. Trial 1: fast 24 / slow 96 (the hypothesis as written). Trial 2: fast 12 (sensitivity only).
3. Kept 24 / 96; one look at the inner test split with \`spq.job evaluate\`.
MD
ls -l submission` } }],
  [{ type: 'text', text: 'Hypothesis: short-horizon trend persistence. Measured: train, validation and inner-test metrics are in claims.json as the laboratory computed them. Refuted or not: for the server to say, on the held-out period.' }],
];

export interface Stack {
  origin: string; port: number; sql: any; app: any; token: string; cfg: RunnerConfig; mock: MockModel | null;
  api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }>;
  addAgent(name: string, universe: string[]): Promise<string>;
  /** change what the fake agent does for the next jobs */
  setFakeMode(mode: string, extra?: unknown): void;
  stop(): Promise<void>;
}

export async function startResearchStack(o: { port: number; db: string; agent: 'fake' | 'claude-mock'; fakeMode?: string; webDir?: string; bars?: number; runner?: boolean;
  /** harness-only routes, registered before the server listens */ routes?: (app: any, c: { setFakeMode(mode: string, extra?: unknown): void }) => void }): Promise<Stack> {
  if (!/^[a-z0-9_]+$/.test(o.db)) throw new Error('bad database name');
  if (!existsSync(path.join(LAB, '.venv/bin/python'))) throw new Error('the laboratory environment is missing: cd research && uv sync --frozen');
  const origin = `http://localhost:${o.port}`, secret = randomBytes(32).toString('hex');
  const signer = createServer((req, res) => { if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keyId: 'sim-key', addresses: {}, halted: false, enrollmentOpen: false, credentials: [], policy: { version: 3, perTx: {}, daily: {}, maxFee: {} }, spentToday: {}, journalHead: null, journalLength: 0 })); return; } res.writeHead(404).end('{}'); });
  await new Promise<void>((r) => signer.listen(0, '127.0.0.1', r));
  try { execSync(`createdb ${o.db}`, { stdio: 'ignore' }); } catch { /* exists: its schema is dropped below */ }
  const data = mkdtempSync(path.join(tmpdir(), 'spw-research-sim-'));
  Object.assign(process.env, { SPW_ORIGIN: origin, SPW_RP_ID: 'localhost', PORT: String(o.port), HOST: '127.0.0.1', DATABASE_URL: `postgres:///${o.db}`, SPW_SIGNER_SECRET: 'e'.repeat(48), SPW_SIGNER_URL: `http://127.0.0.1:${(signer.address() as { port: number }).port}`,
    SPW_BROADCAST: 'off', SPW_WORKERS: 'off', SPW_DATA_DIR: data, SPW_RESEARCH_RUNNER_SECRET: secret, SPW_RESEARCH_LAB_COMMIT: '', SPW_COMMIT: 'sim', ...(o.webDir ? { SPW_WEB_DIR: o.webDir } : {}) });
  const db = await import('../../services/api/src/db.ts'), sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;');
  await db.migrate();
  // synthetic candles: closed hourly bars of BTC and ETH from one source (a seeded random walk; not market data)
  const H = 3_600_000, bars = o.bars ?? 1200, end = Math.floor(Date.now() / H) * H - 2 * H, rows: Record<string, unknown>[] = [];
  for (const [sym, seed, p0] of [['BTC', 11, 60_000], ['ETH', 23, 3000]] as const) {
    let s = seed, close = p0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
    for (let i = 0; i < bars; i++) { const open = close; close = open * Math.exp(0.0001 + 0.01 * (rnd() + rnd() + rnd() - 1.5));
      rows.push({ source: 'coinbase', symbol: sym, interval: '1h', ts: new Date(end - (bars - 1 - i) * H), open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 + rnd() }); }
  }
  for (let i = 0; i < rows.length; i += 500) await sql`insert into candles ${sql(rows.slice(i, i + 500))}`;
  const app = await (await import('../../services/api/src/server.ts')).buildServer({ swapProviders: [] });
  const token = randomBytes(24).toString('hex');
  await sql`insert into sessions (id_hash, expires_at, ua, ip) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '4 hours', 'sim', '127.0.0.1')`;
  const fake: { cfg: RunnerConfig | null } = { cfg: null };
  const setFakeMode = (mode: string, extra: unknown = {}): void => { const c = fake.cfg; if (c && c.agent.kind === 'command') { c.agent.argv[2] = mode; c.agent.argv[3] = JSON.stringify(extra); } };
  o.routes?.(app, { setFakeMode });
  await app.listen({ port: o.port, host: '127.0.0.1' });

  // ---- the runner: its own directories, its own secret, the API's URL — and nothing else of the wallet
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-runner-sim-'))), fakeDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-fake-agent-')));
  copyFileSync(path.join(ROOT, 'services/research-runner/test/fixtures/fake-agent.mjs'), path.join(fakeDir, 'fake-agent.mjs'));
  const mock = o.agent === 'claude-mock' ? await startMockModel(MOCK_SESSION) : null;
  const cfg: RunnerConfig = { apiUrl: `http://127.0.0.1:${o.port}`, secret, runnerId: 'sim-runner', jobsRoot: path.join(home, 'jobs'), stateRoot: path.join(home, 'state'), labDir: LAB, labPin: 'worktree', python: path.join(LAB, '.venv/bin/python'),
    readable: [fakeDir], agent: o.agent === 'claude-mock' ? { kind: 'claude', bin: process.env.SPW_RUNNER_CLAUDE_BIN ?? '/opt/homebrew/bin/claude', model: null, argv: [] } : { kind: 'command', bin: '', model: null, argv: [process.execPath, path.join(fakeDir, 'fake-agent.mjs'), o.fakeMode ?? 'ok', '{}'] },
    sandbox: process.platform === 'darwin' ? 'required' : 'off', model: { upstream: mock?.url ?? 'http://127.0.0.1:9', credential: null }, pollMs: 400, tickMs: 250, logFlushMs: 700, keepJobs: false };
  fake.cfg = cfg;
  const { httpApi } = await import('../../services/research-runner/src/api-client.ts'), { startRunner } = await import('../../services/research-runner/src/runner.ts');
  const stopRunner = o.runner === false ? () => {} : startRunner(cfg, httpApi(cfg));
  let vault = 0;
  return {
    origin, port: o.port, sql, app, token, cfg, mock,
    api: async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${o.port}/api/v1${p}`, { method, headers: { cookie: `spw=${token}`, ...(method === 'GET' ? {} : { origin, 'x-spw-csrf': '1', 'content-type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
      return { status: r.status, json: await r.json().catch(() => null) }; },
    addAgent: async (name, universe) => { const id = randomUUID();
      await sql`insert into agents (id, name, mission, state, interval, universe, risk, vault_index, vault_address, capital_usdc, cash) values (${id}, ${name}, 'Suivi de tendance BTC/ETH, simulation papier d’abord.', 'CREATED', '1h', ${sql.json(universe)},
        ${sql.json({ maxExposurePct: 50, maxLossPct: 5, maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 50 })}, ${++vault}, ${`0x${id.replace(/-/g, '').padEnd(40, '0').slice(0, 40)}`}, '1000000000', 'USDC')`; return id; },
    setFakeMode,
    stop: async () => { stopRunner(); mock?.close(); await app.close(); signer.close(); const rows = await sql`select strategy_name from research_jobs`; const { rmSync } = await import('node:fs');
      for (const r of rows) rmSync(path.join(LAB, 'strategies', r.strategy_name), { recursive: true, force: true }); await sql.end(); },
  };
}

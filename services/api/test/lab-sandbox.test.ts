/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/lab-sandbox.test.ts
 * Module           : services
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

// V8 hardening — every process of the API that runs strategy code is confined by the OS, proven through the REAL entry points:
//   spot signal   agents/live.ts        runSignal
//   perp signal   agents/perp-signal.ts runPerpSignal
//   spot backtest agents/strategies.ts  describe + backtest          (candles: files exported by the API, no database URL)
//   perp backtest agents/perp-strategies.ts describePerp + perpBacktest
//   research      research/evaluate.ts  the submission pipeline, through the runner routes
// A hostile strategy.py (lab-hostile.ts) attempts every forbidden access at import and inside target_weights; the laboratory
// copy used here has its purity lint DISABLED, so the only thing between the strategy and the machine is the sandbox.
// Stand-ins: two local TCP listeners play the wallet API and the signer relay, a Unix socket plays a local service, a file
// outside plays a secret / an .env file, a process started with a canary in its environment plays the API process itself.
// The same strategy, run once WITHOUT the sandbox (development switch) against the local stand-ins only, shows that the
// probes do detect a leak when there is one. Skipped where sandbox-exec or the laboratory's virtualenv do not exist.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labSandboxProfile } from '@spw/core';
import { addAgent, ownerCookie, world, type World } from './alerts-helpers.ts';
import { bars, CONTROL_MASK, controlsOk, decodeError, decodeWeights, fixtureLab, hostileStrategy, leaks, REAL_PYTHON, sha256, type Targets } from './lab-hostile.ts';
import { REPO_ROOT } from './test-db.ts';

const READY = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') && existsSync(REAL_PYTHON);
const ENV_CANARY = 'CANARY-ENV-2c9e41b7a6f0', SECRET = 'runner-secret-'.padEnd(48, 'y'), ORIGIN = 'https://wallet.test';
let w: World, sql: any, app: any, cookie = '';
let lab: typeof import('../src/agents/lab.ts'), live: typeof import('../src/agents/live.ts'), perpSignal: typeof import('../src/agents/perp-signal.ts');
let strategies: typeof import('../src/agents/strategies.ts'), perpStrategies: typeof import('../src/agents/perp-strategies.ts');
let fx: ReturnType<typeof fixtureLab>, targets: Targets, envHolder: ChildProcess | undefined, servers: Server[] = [], scratchRoot = '';
const connections = { api: 0, signer: 0, unix: 0 };
const spotBars = { BTC: bars(120, 11, 60_000), ETH: bars(120, 23, 3000) };
const perpSeries = (seed: number, p0: number) => { const b = bars(120, seed, p0); return { bars: b, funding: b.map((x) => ({ ts: x.ts, rate: 0.00001, premium: null })) }; };
const add = (rel: string, o: Partial<Parameters<typeof hostileStrategy>[0]> = {}) => fx.addStrategy(rel, hostileStrategy({ name: rel.split('/')[0]!, version: rel.split('/')[1]!, kind: 'spot', universe: ['BTC', 'ETH'], behaviour: 'weights', targets, ...o }));
const noLeak = (m: { importMask: number; callMask: number }, where: string): void => {
  expect(controlsOk(m.importMask), `${where}: the controls must work at import (mask ${m.importMask.toString(16)})`).toBe(true);
  expect(controlsOk(m.callMask), `${where}: the controls must work inside target_weights (mask ${m.callMask.toString(16)})`).toBe(true);
  expect(leaks(m.importMask), `${where}: at import`).toEqual([]);
  expect(leaks(m.callMask), `${where}: inside target_weights`).toEqual([]);
};

beforeAll(async () => {
  if (!READY) return;
  scratchRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-lab-canary-'))); // (before TMPDIR moves: a Unix socket path must stay short)
  // a private temporary root for this file: the scratch directories of ITS calls are then the only spw-lab-* entries in it
  // (other test files run laboratory processes at the same time in the shared one)
  process.env.TMPDIR = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-lab-tmproot-')));
  // the fixture laboratory must be chosen before any module of the API is imported (RESEARCH_DIR is read at load)
  fx = fixtureLab({ lint: 'off' });
  Object.assign(process.env, { SPW_RESEARCH_DIR: fx.dir, SPW_RESEARCH_PYTHON: fx.python, SPW_RESEARCH_RUNNER_SECRET: SECRET, SPW_RESEARCH_LAB_COMMIT: '' });
  delete process.env.SPW_LAB_SANDBOX;
  const canary = path.join(scratchRoot, 'secret.txt'), envFile = path.join(scratchRoot, '.env');
  writeFileSync(canary, 'CANARY-SECRET-0123456789'); writeFileSync(envFile, 'SPW_SIGNER_SECRET=canary-not-a-real-secret\n');
  const listen = (key: keyof typeof connections, where: number | string) => new Promise<Server>((resolve) => { const s = createServer((c) => { connections[key] += 1; c.destroy(); });
    if (typeof where === 'string') s.listen(where, () => resolve(s)); else s.listen(where, '127.0.0.1', () => resolve(s)); });
  const api = await listen('api', 0), signer = await listen('signer', 0), unixSocket = path.join(scratchRoot, 'svc.sock'), unix = await listen('unix', unixSocket);
  servers = [api, signer, unix];
  envHolder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { env: { PATH: process.env.PATH ?? '', SPW_SIGNER_SECRET_CANARY: ENV_CANARY }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const other = fx.addStrategy('zz_other/1', readFileSync(path.join(REPO_ROOT, 'research/strategies/ma_trend/3/strategy.py'), 'utf8'));
  targets = { home: homedir(), repo: REPO_ROOT, canary, envFile, outside: path.join(scratchRoot, 'written-by-the-strategy.txt'), labSrc: path.join(fx.dir, 'src'), otherStrategy: other.dir,
    apiPort: (api.address() as { port: number }).port, signerPort: (signer.address() as { port: number }).port, unixSocket, envPid: envHolder.pid!, envCanary: ENV_CANARY, safeOnly: false };

  w = await world('lab_sandbox'); sql = w.sql;
  const H = 3_600_000, rows: Record<string, unknown>[] = [];
  for (const [sym, seed, p0] of [['BTC', 11, 60_000], ['ETH', 23, 3000]] as const) for (const b of bars(1000, seed, p0)) rows.push({ source: 'coinbase', symbol: sym, interval: '1h', ts: new Date(b.ts - H), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  for (let i = 0; i < rows.length; i += 500) await sql`insert into candles ${sql(rows.slice(i, i + 500))}`;
  lab = await import('../src/agents/lab.ts'); live = await import('../src/agents/live.ts'); perpSignal = await import('../src/agents/perp-signal.ts');
  strategies = await import('../src/agents/strategies.ts'); perpStrategies = await import('../src/agents/perp-strategies.ts');
  app = await (await import('../src/server.ts')).buildServer();
  cookie = await ownerCookie(sql);
}, 120_000);
afterAll(async () => { for (const s of servers) s.close(); envHolder?.kill('SIGKILL'); await app?.close(); await sql?.end(); });

describe.skipIf(!READY)('strategy sandbox — the health check', () => {
  it('reports sandbox-exec, confined; the profile is deny-default with no network rule, no fork, exec of the interpreter only', async () => {
    const st = await lab.labStatus(true);
    expect(st, JSON.stringify(st)).toMatchObject({ mode: 'sandbox-exec', ok: true, reason: null });
    const p = labSandboxProfile({ scratch: '/private/tmp/x', readable: ['/opt/lab/src'], exec: ['/opt/py/bin/python3.12'] });
    expect(p).toMatch(/^\(version 1\)\n\(deny default\)\n\(allow process-exec\* \(literal "\/opt\/py\/bin\/python3\.12"\)\)\n/);
    expect(p).not.toMatch(/network|process-fork|mach-lookup|\(allow default\)|homebrew|\/usr\/bin|"\/bin"|\/private\/etc\/ssl/);
    expect(p).toContain('(deny sysctl-read (sysctl-name-prefix "kern.proc"))');
    expect(p).toContain('(deny process-info*)');
    expect(p.match(/file-write\*/g)).toHaveLength(2);                    // /dev/null and the scratch directory
    expect(() => labSandboxProfile({ scratch: '/tmp/a"b', readable: [], exec: ['/x'] })).toThrow(/not a plain absolute path/);
    expect(() => labSandboxProfile({ scratch: '/tmp/x', readable: [], exec: [] })).toThrow(/interpreter/);
  });
});

describe.skipIf(!READY)('strategy sandbox — a hostile strategy through each real entry point', () => {
  it('spot signal (runSignal): nothing leaks at import nor inside target_weights; the controls work', async () => {
    const s = add('zz_hostile/1');
    const weights = await live.runSignal({ path: s.path, sha256: s.sha256 }, spotBars, '1h');
    noLeak(decodeWeights(weights, ['BTC', 'ETH']), 'spot signal');
  });

  it('perp signal (runPerpSignal): the same', async () => {
    const s = add('zz_hostile_perp/1', { kind: 'perp' });
    const sig = await perpSignal.runPerpSignal({ path: s.path, sha256: s.sha256 }, { BTC: perpSeries(5, 60_000), ETH: perpSeries(9, 3000) } as never, '1h');
    noLeak(decodeWeights(sig.weights, ['BTC', 'ETH']), 'perp signal');
  });

  it('spot backtest (describe + backtest): the candles arrive as files, the process has no database URL, nothing leaks', async () => {
    const s = add('zz_hostile/2', { behaviour: 'raise' });
    const info = await strategies.describe('zz_hostile/2');               // import-time probes ran here too (sandboxed describe)
    expect(info.sha256).toBe(s.sha256);
    const agentId = await addAgent(sql, { name: 'Hostile spot', state: 'CREATED', universe: ['BTC', 'ETH'] }), vid = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta) values (${vid}, ${agentId}, 'zz_hostile', '2', ${s.sha256}, ${s.path}, '{}')`;
    await strategies.backtest(vid, info, ['BTC', 'ETH']);
    const [row] = await sql`select status, notes, report from strategy_versions where id = ${vid}`;
    expect(row.report).toBeNull();
    const m = decodeError(row.notes);
    expect(m, row.notes).not.toBeNull();
    noLeak(m!, 'spot backtest');
  }, 120_000);

  it('perp backtest (describePerp + perpBacktest): the same, on the bundle prepared by the API', async () => {
    const s = add('zz_hostile_perp/2', { kind: 'perp', behaviour: 'raise' });
    const info = await perpStrategies.describePerp('zz_hostile_perp/2');
    const H = 3_600_000, series = (seed: number, p0: number) => { const b = bars(600, seed, p0);
      return { candles: b.map((x) => [x.ts - H, x.open.toFixed(4), x.high.toFixed(4), x.low.toFixed(4), x.close.toFixed(4), x.volume.toFixed(3)] as [number, string, string, string, string, string]), funding: b.map((x) => [x.ts - H, '0.00001250', null] as [number, string, string | null]) }; };
    const data: Record<string, ReturnType<typeof series>> = { BTC: series(5, 60_000), ETH: series(9, 3000) };
    const agentId = await addAgent(sql, { name: 'Hostile perp', state: 'CREATED', universe: ['BTC', 'ETH'] }), vid = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta) values (${vid}, ${agentId}, 'zz_hostile_perp', '2', ${s.sha256}, ${s.path}, '{}')`;
    await perpStrategies.perpBacktest(vid, info, ['BTC', 'ETH'], '1h', { data: { instrument: async (id: string) => ({ venue: 'hyperliquid', symbol: id.split(':')[1]!, maxLeverage: '40', lotSize: '0.0001' }) },
      store: { now: () => Date.now(), backfill: async () => {}, exact: async (inst: { symbol: string }) => data[inst.symbol]! } } as never);
    const [row] = await sql`select notes, report from strategy_versions where id = ${vid}`;
    expect(row.report).toBeNull();
    const m = decodeError(row.notes);
    expect(m, row.notes).not.toBeNull();
    noLeak(m!, 'perp backtest');
  }, 120_000);

  it('research evaluation (the runner routes → evaluateSubmission): a submitted hostile strategy is described and backtested confined', async () => {
    const owner = async (method: string, url: string, body?: unknown) => { const headers: Record<string, string> = { cookie };
      if (method !== 'GET') Object.assign(headers, { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' });
      const r = await app.inject({ method, url: `/api/v1${url}`, headers, payload: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.statusCode, json: r.json() }; };
    const runner = async (url: string, body: unknown, token?: string) => { const r = await app.inject({ method: 'POST', url: `/api/v1/research/runner${url}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, ...(token ? { 'x-spw-job-token': token } : {}) }, payload: JSON.stringify(body) });
      return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() }; };
    const waitFor = async (id: string, done: (j: any) => boolean): Promise<any> => { for (let i = 0; i < 900; i++) { const [r] = await sql`select state, reason, dataset, server from research_jobs where id = ${id}`; if (done(r)) return r; await new Promise((res) => setTimeout(res, 200)); } throw new Error('the job did not finish'); };
    const c = await owner('POST', '/research/jobs', { mission: 'Développe une stratégie statistique BTC/ETH et teste-la sur données historiques', universe: ['BTC', 'ETH'] });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    await waitFor(c.json.id, (j) => j.dataset?.ready === true);
    // (the data set is marked ready a moment before the job is queued for the runner: ask until it is handed out)
    let job: any = null;
    for (let i = 0; i < 100 && !job; i++) { job = (await runner('/claim', { runnerId: 'hostile' })).json?.job ?? null; if (!job) await new Promise((res) => setTimeout(res, 100)); }
    expect(job.id).toBe(c.json.id);
    const source = hostileStrategy({ name: job.strategyName, version: job.strategyVersion, kind: 'spot', universe: ['BTC', 'ETH'], behaviour: 'raise', targets });
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const result = { outcome: 'submission', usage: { wallMs: 1000, trials: 0, diskMb: 0, modelTokens: 0, modelRequests: 0, modelUsd: null, ledgerTampered: false, sandbox: 'sandbox-exec', agent: 'hostile-test', labCommit: null, exitCode: 0, signal: null },
      archive: { v: 1, files: [{ path: 'strategy.py', b64: b64(source) }, { path: 'README.md', b64: b64('# hostile\n\n**Hypothesis.** none.\n') }], ledger: '' } };
    const post = await runner(`/jobs/${job.id}/result`, result, job.token);
    expect([200, 202], JSON.stringify(post.json)).toContain(post.status);
    const done = await waitFor(c.json.id, (j) => ['submitted', 'failed'].includes(j.state));
    expect(done.state).toBe('failed');                                    // it raises instead of returning weights: there is no report
    expect(done.server.sandbox).toBe('sandbox-exec');
    const m = decodeError(String(done.server.reason));
    expect(m, JSON.stringify(done.server)).not.toBeNull();
    noLeak(m!, 'research evaluation');
  }, 180_000);

  it('seen from outside: no connection reached the listeners, nothing was written outside, in the laboratory or next to the strategy', () => {
    expect(connections).toEqual({ api: 0, signer: 0, unix: 0 });
    expect(readdirSync(scratchRoot).sort()).toEqual(['.env', 'secret.txt', 'svc.sock']);
    expect(existsSync(path.join(fx.dir, 'src/spq/zz_written_by_strategy.py'))).toBe(false);
    for (const d of ['zz_hostile/1', 'zz_hostile/2', 'zz_hostile_perp/1', 'zz_hostile_perp/2']) expect(readdirSync(path.join(fx.dir, 'strategies', d)), d).toEqual(['strategy.py']);
  });

  it('the scratch directory of a call is removed afterwards; a second call starts from an empty one', async () => {
    const mine = (): string[] => readdirSync(realpathSync(tmpdir())).filter((n) => /^spw-lab-[A-Za-z0-9]{6}$/.test(n));
    // the evaluation of the previous test drops its scratch directory just after the job reaches its final state: wait for it
    for (let i = 0; i < 100 && mine().length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(mine()).toEqual([]);
    const s = add('zz_hostile/3');
    for (let i = 0; i < 2; i++) noLeak(decodeWeights(await live.runSignal({ path: s.path, sha256: s.sha256 }, spotBars, '1h'), ['BTC', 'ETH']), `call ${i}`);
    expect(mine()).toEqual([]);
  });
});

describe.skipIf(!READY)('strategy sandbox — limits of one call', () => {
  const direct = (rel: string, o: Partial<Parameters<typeof lab.labExec>[1]> = {}) => { const dir = path.join(fx.dir, 'strategies', rel);
    const input = JSON.stringify({ candles: Object.fromEntries(Object.entries(spotBars).map(([s, b]) => [s, b.map((x) => [Math.floor(x.ts / 1000), x.open, x.high, x.low, x.close, x.volume])])), interval: '1h' });
    return lab.labExec(['spq.signal', '--strategy', dir, '--sha256', sha256(readFileSync(path.join(dir, 'strategy.py'))), '--input', '-'], { timeoutMs: 20_000, stdin: input, strategyDir: dir, ...o }); };
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('wall clock: a strategy that never returns is killed at the timeout, and its process is gone', async () => {
    add('zz_sleep/1', { behaviour: 'sleep' });
    const t0 = Date.now(), r = await direct('zz_sleep/1', { timeoutMs: 2500 });
    expect(r.killed).toBe('timeout'); expect(Date.now() - t0).toBeLessThan(8000);
  }, 30_000);

  it('CPU: the rlimit set by the wrapper is inherited through sandbox-exec and kills a busy loop (SIGXCPU) before the wall clock would', async () => {
    add('zz_burn/1', { behaviour: 'burn' });
    // timeoutMs 15 s → the wrapper sets max(60, 4 × 15) = 60 CPU-seconds; measured directly with a tiny limit instead:
    const { spawnSync } = await import('node:child_process');
    const t0 = Date.now(), r = spawnSync('/bin/sh', ['-c', 'ulimit -t 2 || exit 70; exec "$@"', 'x', REAL_PYTHON, '-c', 'while True: pass'], { encoding: 'utf8' });
    expect(r.signal).toBe('SIGXCPU'); expect(Date.now() - t0).toBeGreaterThan(1500); expect(Date.now() - t0).toBeLessThan(6000);
    const r2 = await direct('zz_burn/1', { timeoutMs: 3000 });           // and through the real runner the wall clock stops it
    expect(r2.killed).toBe('timeout');
  }, 30_000);

  it('memory: macOS refuses RLIMIT_AS / RLIMIT_DATA / RLIMIT_RSS (measured here) — the watchdog kills a process above its resident-memory ceiling', async () => {
    const { spawnSync } = await import('node:child_process');
    for (const flag of ['-v', '-d', '-m']) { const r = spawnSync('/bin/sh', ['-c', `ulimit ${flag} 1048576`], { encoding: 'utf8' }); expect(r.status, `ulimit ${flag}`).not.toBe(0); expect(r.stderr).toMatch(/cannot modify limit|Invalid argument/); }
    add('zz_memory/1', { behaviour: 'memory' });
    const r = await direct('zz_memory/1', { timeoutMs: 20_000, maxRssMb: 400 });
    expect(r.killed).toBe('memory'); expect(r.ms).toBeLessThan(15_000);
  }, 40_000);

  it('output: a strategy that floods stdout is cut (the signal runner kills it and holds)', async () => {
    const s = add('zz_flood/1', { behaviour: 'flood' });
    await expect(live.runSignal({ path: s.path, sha256: s.sha256 }, spotBars, '1h')).rejects.toThrow(/signal output too large|unreadable signal|signal exit/);
  }, 30_000);

  it('no daemon: fork is refused by the kernel, so nothing can outlive a call (the setsid escape of a forking job does not exist here)', async () => {
    const before = new Set(readdirSync(scratchRoot));
    const s = add('zz_hostile/4');
    const m = decodeWeights(await live.runSignal({ path: s.path, sha256: s.sha256 }, spotBars, '1h'), ['BTC', 'ETH']);
    expect(leaks(m.callMask).filter((x) => /fork|spawn|daemon/.test(x))).toEqual([]);
    await new Promise((r) => setTimeout(r, 500));
    expect(new Set(readdirSync(scratchRoot))).toEqual(before);            // the would-be daemon's marker file never appeared
    expect(alive(envHolder!.pid!)).toBe(true);
  });
});

describe.skipIf(!READY)('strategy sandbox — fail closed', () => {
  it('the probes are real: the same strategy WITHOUT the sandbox (explicit development switch, local stand-ins only) leaks everything it tries', async () => {
    const s = add('zz_unconfined/1', { targets: { ...targets, safeOnly: true, outside: path.join(scratchRoot, 'unconfined-write.txt') } });
    process.env.SPW_LAB_SANDBOX = 'off';
    try {
      expect(await lab.labStatus()).toMatchObject({ mode: 'off', ok: false });
      const m = decodeWeights(await live.runSignal({ path: s.path, sha256: s.sha256 }, spotBars, '1h'), ['BTC', 'ETH']);
      expect(controlsOk(m.callMask)).toBe(true);
      const leaked = leaks(m.callMask);
      for (const must of ['read a canary secret outside', 'read a .env-like secret file outside', 'write outside the scratch directory', 'TCP to the API port (loopback)', 'TCP to the signer relay port (loopback)',
        'Unix socket (PostgreSQL / a local service)', 'fork', 'posix_spawn /bin/sh', 'read another process\'s environment (sysctl kern.procargs2)', 'list processes', 'signal another process',
        'read another strategy\'s directory', 'listen on a socket', 'setsid + fork (daemon)']) expect(leaked, must).toContain(must);
      expect(connections.api).toBeGreaterThan(0); expect(connections.signer).toBeGreaterThan(0);
      expect(existsSync(path.join(scratchRoot, 'unconfined-write.txt'))).toBe(true);
    } finally { delete process.env.SPW_LAB_SANDBOX; connections.api = 0; connections.signer = 0; connections.unix = 0; }
    expect(await lab.labStatus()).toMatchObject({ mode: 'sandbox-exec', ok: true });
  }, 60_000);

  it('an interpreter that cannot be shown to be confined is not used: no signal (the engine holds), no describe, no backtest — and the alert is raised', async () => {
    // a stand-in "interpreter" that does not behave like one: the self-test cannot see it refused anything
    const fake = path.join(scratchRoot, 'bin'); mkdirSync(fake, { recursive: true });
    const { symlinkSync } = await import('node:fs'); symlinkSync('/bin/echo', path.join(fake, 'python'));
    const s = add('zz_hostile/5'), real = process.env.SPW_RESEARCH_PYTHON;
    process.env.SPW_RESEARCH_PYTHON = path.join(fake, 'python'); lab.resetLabStatus();
    try {
      const st = await lab.labStatus(true);
      expect(st.mode).toBe('unavailable'); expect(st.ok).toBe(false); expect(st.reason).toMatch(/could not be applied|does not confine/);
      await expect(live.runSignal({ path: s.path, sha256: s.sha256 }, spotBars, '1h')).rejects.toThrow(/signal runner could not start: the strategy sandbox is not available/);
      await expect(perpSignal.runPerpSignal({ path: s.path, sha256: s.sha256 }, { BTC: perpSeries(5, 60_000), ETH: perpSeries(9, 3000) } as never, '1h')).rejects.toThrow(/strategy sandbox is not available/);
      await expect(strategies.describe('zz_hostile/5')).rejects.toMatchObject({ code: 'bad_strategy' });
      const r = await strategies.py(['spq.describe', '--strategy', s.dir], { timeoutMs: 10_000, strategyDir: s.dir });
      expect(r).toMatchObject({ code: null, out: '' }); expect(r.err).toMatch(/strategy sandbox is not available/);
      expect((await lab.labStatus()).refused).toBeGreaterThanOrEqual(3);
      // the alerts layer: said once (on the second poll in a row), then "back" once
      const d = w.dispatcher({ lab: () => lab.labStatus() });
      await d.conditions(); w.clock.advance(31_000); await d.conditions(); w.clock.advance(31_000); await d.conditions();
      const down = await w.alerts(`kind = 'system.lab_sandbox_unavailable'`);
      expect(down).toHaveLength(1); expect(down[0].severity).toBe('critical');
      // the monitoring endpoint says the same
      (await import('../src/monitor/routes.ts')).clearMonitorCache();
      const h = (await app.inject({ method: 'GET', url: '/api/v1/monitor/health', headers: { cookie } })).json();
      expect(h.lab).toMatchObject({ mode: 'unavailable', ok: false });
      process.env.SPW_RESEARCH_PYTHON = real; lab.resetLabStatus();
      expect(await lab.labStatus(true)).toMatchObject({ mode: 'sandbox-exec', ok: true });
      w.clock.advance(31_000); await d.conditions();
      expect(await w.alerts(`kind = 'system.lab_sandbox_back'`)).toHaveLength(1);
    } finally { process.env.SPW_RESEARCH_PYTHON = real; lab.resetLabStatus(); }
  }, 60_000);

  it('a missing interpreter (no virtualenv) is unavailable too, with the reason', async () => {
    const real = process.env.SPW_RESEARCH_PYTHON;
    process.env.SPW_RESEARCH_PYTHON = path.join(scratchRoot, 'nowhere/python'); lab.resetLabStatus();
    try { const st = await lab.labStatus(true); expect(st.mode).toBe('unavailable'); expect(st.reason).toMatch(/interpreter is missing/); }
    finally { process.env.SPW_RESEARCH_PYTHON = real; lab.resetLabStatus(); }
  });

  it('the development switch is said by the alerts layer every day it is set', async () => {
    const d = w.dispatcher({ lab: async () => ({ ...(await lab.labStatus()), mode: 'off' as const, ok: false }) });
    await d.conditions(); await d.conditions();
    expect(await w.alerts(`kind = 'system.lab_sandbox_off'`)).toHaveLength(1);
  });
});

// v10 integration: `main` grew (GMX, Solana CCTP, Cardano, Polkadot, the plan executor) after the sandbox branch was cut. This
// runs everywhere (no sandbox needed): a new file that starts a process, or that runs laboratory code without `labExec`, fails here.
describe('one runner: nothing in the API or the research runner starts laboratory code by itself', () => {
  const walk = (dir: string, out: string[] = []): string[] => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|mts)$/.test(e.name)) out.push(p); } return out; };
  const code = (f: string) => readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');   // line comments only: route strings contain /* and */
  const rel = (f: string) => path.relative(REPO_ROOT, f);
  it('API: child_process is imported by the runner only (and by the read-only `git rev-parse` of the research routes)', () => {
    const files = walk(path.join(REPO_ROOT, 'services/api/src'));
    expect(files.length).toBeGreaterThan(80);
    const starters = files.filter((f) => /node:child_process|['"]child_process['"]|\bBun\.spawn|\bDeno\.run|new Worker\(/.test(code(f))).map(rel).sort();
    expect(starters).toEqual(['services/api/src/agents/lab.ts', 'services/api/src/research/routes.ts']);
    const routes = code(path.join(REPO_ROOT, 'services/api/src/research/routes.ts'));
    expect(routes.match(/execFileSync\(/g)).toHaveLength(1); expect(routes).toMatch(/execFileSync\('git', \['-C', RESEARCH_DIR, 'rev-parse', 'HEAD'\]/);   // no interpreter, no shell
    for (const f of files) { const c = code(f); expect(c, rel(f)).not.toMatch(/['"`]uv['"`]|uv run|\.venv\/bin\/python(?!['"`]\))|python3?['"`],/); }
    // every laboratory module is started through labExec (directly, or through the two thin wrappers that only add a result shape)
    const callers = files.filter((f) => /['"`]spq\.[a-z_.]+['"`]/.test(code(f))).map(rel).sort();
    expect(callers).toEqual(['services/api/src/agents/live.ts', 'services/api/src/agents/perp-signal.ts', 'services/api/src/agents/perp-strategies.ts', 'services/api/src/agents/strategies.ts',
      'services/api/src/research/dataset.ts', 'services/api/src/research/evaluate.ts']);
    for (const f of callers) expect(code(path.join(REPO_ROOT, f)), f).toMatch(/\blabExec\(|\blabRun\(|\bpy\(/);   // py = the wrapper of strategies.ts (checked below)
    expect(code(path.join(REPO_ROOT, 'services/api/src/research/lab.ts'))).toMatch(/return labExec\(args, o\)/);
    expect(code(path.join(REPO_ROOT, 'services/api/src/agents/strategies.ts'))).toMatch(/return labExec\(args, o\)/);
  });
  it('research runner: processes are started in job.ts only, and the two that run Python or the agent go through the job profile', () => {
    const files = walk(path.join(REPO_ROOT, 'services/research-runner/src'));
    expect(files.filter((f) => /node:child_process/.test(code(f))).map(rel)).toEqual(['services/research-runner/src/job.ts']);
    const job = code(path.join(REPO_ROOT, 'services/research-runner/src/job.ts'));
    expect(job.match(/\bspawn\(/g)).toHaveLength(3);                                                       // `sh` (git/tar helpers), the data import, the agent
    expect(job).toMatch(/const argv = confine\(confined \? prep : null, \[cfg\.python, '-m', 'spq\.data\.hl_import'/);
    expect(job).toMatch(/const argv = confine\(confined \? p\.profile : null, agentArgv\(cfg, job, rp\)\)/);
    expect(job.match(/sandboxProfile\(/g)!.length).toBeGreaterThanOrEqual(2);                             // both use the fixed profile of @spw/core (no kern.procargs2)
  });
});

void CONTROL_MASK;

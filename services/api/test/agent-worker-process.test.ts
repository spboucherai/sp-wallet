// V11.2 — the agent workers as their OWN PROCESS (`dist/agents.mjs`, SPW_WORKERS=agents) next to an API process that runs
// everything else (`dist/api.mjs`, SPW_WORKERS=api), on a per-run database. Real processes, real PostgreSQL, no mock of the
// runtime: what is observed is what the two bundles do.
//
//   1. the API migrates and says its agent workers are "not in this process"; the worker starts on the migrated database;
//   2. with TWO workers alive, each agent's tick is run by exactly ONE of them (a claimed job, a lease) — never twice;
//   3. a worker is KILLED (SIGKILL) in the middle of a tick: the tick job stays `running` under its name and its lease stays
//      held — nobody else ticks that agent; once the lock horizon and the lease have expired, the second worker reaps the job
//      and ticks the agent again.
//
// "In the middle of a tick" is made deterministic without touching the code under test: the tick of a spot agent starts by
// reading the market data (`candles`); this test holds an exclusive lock on that table, so the tick blocks at its first read
// while its job is `running` and its lease is held. The two horizons the recovery waits for in production (180 s job lock,
// 30 s lease) are moved into the past by hand after the kill — the code that reaps and re-ticks is the worker's own.
// The agents are spot paper agents whose strategy version names no laboratory strategy: their tick holds (no usable data, or no
// valid signal) and places nothing. The API process runs with its other workers, as `SPW_WORKERS=api` says: its market worker
// may read public candles, as on a developer's stack — the test's assertions do not depend on whether it could.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, useTestDatabase } from './test-db.ts';

let sql: any;
const procs: ChildProcess[] = [], logs = new Map<number, string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${[...logs.entries()].map(([pid, l]) => `--- ${pid}\n${l.slice(-1500)}`).join('\n')}`); await sleep(100); }
};
const freePort = (): Promise<number> => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
let env: Record<string, string> = {};
function start(bundle: 'api' | 'agents', extra: Record<string, string>): ChildProcess {
  const p = spawn(process.execPath, [join(REPO_ROOT, 'dist', `${bundle}.mjs`)], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs.set(p.pid!, '');
  for (const s of [p.stdout!, p.stderr!]) s.on('data', (d) => logs.set(p.pid!, (logs.get(p.pid!) ?? '') + String(d)));
  procs.push(p);
  return p;
}
const AGENTS = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  // the bundles under test are the ones `node scripts/build.mjs` produces (rebuilt here: a stale bundle would test old code)
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/build.mjs')], { cwd: REPO_ROOT, stdio: 'ignore' });
  expect(existsSync(join(REPO_ROOT, 'dist/agents.mjs')) && existsSync(join(REPO_ROOT, 'dist/api.mjs'))).toBe(true);
  const db = await useTestDatabase('agent_worker_proc'), dir = mkdtempSync(join(tmpdir(), 'spw-worker-proc-'));
  env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: db.url, SPW_ORIGIN: 'http://localhost', SPW_RP_ID: 'localhost', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_SIGNER_URL: 'http://127.0.0.1:9',
    SPW_BROADCAST: 'off', SPW_DATA_DIR: join(dir, 'data'), SPW_RESEARCH_DIR: join(dir, 'no-lab'), PORT: String(await freePort()), HOST: '127.0.0.1' };
  sql = (await import('../src/db.ts')).sql;
}, 180_000);
afterAll(async () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } await sql?.end(); });

describe('sp-wallet-agents: a separate worker process', () => {
  let w1: ChildProcess, w2: ChildProcess;
  const jobOf = async (agent: string) => (await sql`select id, state, attempts, locked_by, last_error from agent_jobs where agent_id = ${agent} and kind = 'tick' order by created_at desc limit 1`)[0];
  const named = (p: ChildProcess) => `%:${p.pid}:%`;

  it('the worker refuses to start without SPW_WORKERS=agents, and on a database the API has not migrated', async () => {
    const wrong = start('agents', { SPW_WORKERS: 'on' });
    expect(await new Promise((r) => wrong.on('exit', r))).toBe(2);
    const early = start('agents', { SPW_WORKERS: 'agents' });
    expect(await new Promise((r) => early.on('exit', r))).toBe(3);
    expect(logs.get(early.pid!)).toMatch(/start the API on this version once/);
  }, 60_000);

  it('API (SPW_WORKERS=api) migrates and runs no agent worker; the worker process ticks the agents; with two workers every tick is run by exactly one', async () => {
    const api = start('api', { SPW_WORKERS: 'api' });
    await until('the API to listen', async () => /sp-wallet api listening/.test(logs.get(api.pid!) ?? ''), 90_000);
    expect(logs.get(api.pid!)).toMatch(/workers=api agent-workers=not in this process/);
    // three spot paper agents with an approved (never run) strategy version and no market data: a tick holds and places nothing
    for (const [i, id] of AGENTS.entries()) {
      const sv = randomUUID();
      await sql`insert into agents (id, kind, name, universe, risk, vault_index, vault_address, state, mode, engine, family) values (${id}, 'spot', ${`proc-${i}`}, ${sql.json(['ETH'])}, ${sql.json({ maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12, slippageBps: 50, maxLossPct: 5, maxExposurePct: 50 })}, ${9500 + i}, '0x0', 'PAPER_TRADING', 'PAPER', 'bar', 'custom')`;
      await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${id}, 'none', '1', ${'ab'.repeat(32)}, 'strategies/none/1', ${sql.json({})}, 'approved', ${sql.json({})})`;
      await sql`update agents set strategy_version_id = ${sv} where id = ${id}`;
    }
    // ---- two workers at once: every tick is run by exactly one
    w1 = start('agents', { SPW_WORKERS: 'agents', SPW_AGENT_BAR_MS: '300', SPW_AGENT_JOBS_MS: '300' });
    const first = start('agents', { SPW_WORKERS: 'agents', SPW_AGENT_BAR_MS: '300', SPW_AGENT_JOBS_MS: '300' });
    await until('both workers to start', async () => [w1, first].every((p) => /agents worker .* started/.test(logs.get(p.pid!) ?? '')));
    await until('every agent to have been ticked several times', async () => (await sql`select agent_id from agent_jobs where kind = 'tick' and state = 'done' group by agent_id having count(*) >= 4`).length === 3);
    // a tick is ONE job, claimed once: no job was attempted twice, no agent ever has two tick jobs alive, and each job was run by one named worker
    expect((await sql`select count(*)::int as n from agent_jobs where kind = 'tick' and attempts <> 1 and state = 'done'`)[0].n).toBe(0);
    expect((await sql`select agent_id from agent_jobs where kind = 'tick' and state in ('queued', 'running') group by agent_id having count(*) > 1`).length).toBe(0);
    const results = await sql`select result from agent_jobs where kind = 'tick' and state = 'done'`;
    const odd = results.filter((r: any) => !(typeof r.result === 'string' ? /^hold: |^waiting for the next bar$|leased by another worker/.test(r.result) : r.result?.skipped === 'leased by another worker'));
    expect(odd, JSON.stringify(odd.slice(0, 3))).toEqual([]);
    first.kill('SIGTERM');
    expect(await new Promise((r) => first.on('exit', r))).toBe(0);                 // a clean stop

    // ---- a worker killed in the middle of a tick
    const held = await sql.reserve();
    await held`begin`; await held`lock table candles in access exclusive mode`;
    let blocked: string[] = [];
    try {
      // worker 1's ticks are now in the middle: jobs running under its name, leases held by it
      blocked = (await until('worker 1 to be in the middle of its ticks', async () => { const r = await sql`select j.agent_id from agent_jobs j join agent_leases l on l.agent_id = j.agent_id where j.kind = 'tick' and j.state = 'running' and j.locked_by like ${named(w1)} and l.owner like ${named(w1)} and l.expires_at > now()`; return r.length === 3 ? r : null; })).map((r: any) => r.agent_id);
      w2 = start('agents', { SPW_WORKERS: 'agents', SPW_AGENT_BAR_MS: '300', SPW_AGENT_JOBS_MS: '300' });
      await until('worker 2 to start', async () => /agents worker .* started/.test(logs.get(w2.pid!) ?? ''));
      await sleep(2500);
      // worker 2 is alive and takes NOTHING of what worker 1 holds: same jobs, first attempt, same owner of the leases
      for (const id of blocked) {
        const j = await jobOf(id);
        expect(j).toMatchObject({ state: 'running', attempts: 1 }); expect(j.locked_by).toContain(`:${w1.pid}:`);
        expect((await sql`select owner from agent_leases where agent_id = ${id}`)[0].owner).toContain(`:${w1.pid}:`);
      }
      w1.kill('SIGKILL');                                                          // KILLED in the middle of the ticks
      await new Promise((r) => w1.on('exit', r));
    } finally { await held`rollback`; held.release(); }
    // the jobs are still `running` under the dead worker's name, its leases still held: nobody ticks these agents yet
    await sleep(1500);
    for (const id of blocked) expect(await jobOf(id)).toMatchObject({ state: 'running', attempts: 1 });
    // production waits 180 s (job lock) and 30 s (lease) here; the two horizons are moved into the past by hand
    await sql`update agent_jobs set locked_until = now() - interval '1 second' where kind = 'tick' and state = 'running'`;
    await sql`update agent_leases set expires_at = now() - interval '1 second'`;
    // RECOVERY by worker 2: each job is reaped (queued again, with the reason), claimed and run to its end
    for (const id of blocked) {
      const reaped = await until(`worker 2 to re-run the interrupted tick of ${id}`, async () => (await sql`select attempts, state, result from agent_jobs where agent_id = ${id} and kind = 'tick' and attempts = 2 and state = 'done'`)[0], 60_000);
      expect(String(reaped.result)).toMatch(/^hold: |^waiting for the next bar$/);
    }
    // …and it goes on ticking them
    const n = (await sql`select count(*)::int as n from agent_jobs where kind = 'tick' and state = 'done'`)[0].n;
    await until('worker 2 to go on ticking', async () => (await sql`select count(*)::int as n from agent_jobs where kind = 'tick' and state = 'done'`)[0].n >= n + 3);
    const foreign = (await sql`select owner from agent_leases where expires_at > now()`).filter((l: any) => !l.owner.includes(`:${w2.pid}:`));
    expect(foreign, JSON.stringify(foreign)).toEqual([]);
    w2.kill('SIGTERM');
    expect(await new Promise((r) => w2.on('exit', r))).toBe(0);
  }, 240_000);
});

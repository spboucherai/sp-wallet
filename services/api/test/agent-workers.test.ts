// V11 persistent agent workers, against PostgreSQL (own database):
//   leases      two workers, one ticks; takeover after expiry; the fencing token; a stale holder cannot renew or release
//   job queue   dedupe, claim (skip locked), retries with backoff, dead-letter, reaping a dead worker's jobs
//   scheduler   two runtimes on one database tick each agent ONCE; a failing and a slow agent delay nobody; persistent backoff;
//               a tick that overruns its deadline keeps its lease
//   gateway     the seam adapter: validation, mode, mandate presence, kill switch, idempotency, and the UNKNOWN path — an order
//               whose outcome is not known is reconciled and NEVER sent again; a new attempt only after "proven not sent"
//   kill switch engage is one-way from the port; release is the owner's module
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalOrderInput } from '@spw/trading';
import { useTestDatabase } from './test-db.ts';

let sql: any;
let leases: typeof import('../src/agent-runtime/leases.ts'), queue: typeof import('../src/agent-runtime/queue.ts'), sched: typeof import('../src/agent-runtime/scheduler.ts'), gw: typeof import('../src/agent-runtime/gateway.ts'),
  ks: typeof import('../src/agent-runtime/kill-switch.ts');

beforeAll(async () => {
  await useTestDatabase('agent_workers');
  const db = await import('../src/db.ts'); sql = db.sql;
  await db.migrate();
  leases = await import('../src/agent-runtime/leases.ts'); queue = await import('../src/agent-runtime/queue.ts'); sched = await import('../src/agent-runtime/scheduler.ts'); gw = await import('../src/agent-runtime/gateway.ts');
  ks = await import('../src/agent-runtime/kill-switch.ts');
});
afterAll(async () => { await sql?.end(); });
beforeEach(async () => { await sql`delete from agent_jobs`; await sql`delete from agent_leases`; });

let vi = -1000;
async function agent(o: { kind?: string; state?: string; mode?: string; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await sql`insert into agents (id, kind, name, network, universe, interval, risk, vault_index, vault_address, capital_usdc, state, mode)
    values (${id}, ${o.kind ?? 'perp'}, ${o.name ?? 'w'}, 'hyperliquid', ${sql.json(['BTC'])}, '1h', ${sql.json({})}, ${vi--}, '', '1000000000', ${o.state ?? 'PAPER_TRADING'}, ${o.mode ?? 'PAPER'})`;
  return id;
}
const T = Date.parse('2026-11-15T12:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('leases — one worker per agent', () => {
  it('two workers ask for the same agent: exactly one gets it; the other gets it only after release or expiry', async () => {
    const a = await agent();
    const [x, y] = await Promise.all([leases.acquireLease(a, 'worker-A', { now: T, ttlMs: 60_000 }), leases.acquireLease(a, 'worker-B', { now: T, ttlMs: 60_000 })]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const held = (x ?? y)!, other = held.owner === 'worker-A' ? 'worker-B' : 'worker-A';
    expect(await leases.acquireLease(a, other, { now: T + 59_000, ttlMs: 60_000 })).toBeNull();     // still held
    expect((await leases.acquireLease(a, held.owner, { now: T + 1000, ttlMs: 60_000 }))!.token).toBe(held.token + 1);   // re-entrant for its owner
    const took = await leases.acquireLease(a, other, { now: T + 62_000, ttlMs: 60_000 });           // the owner stopped renewing: expired
    expect(took).toMatchObject({ owner: other, token: held.token + 2 });
  });
  it('fencing: a holder that slept past its expiry cannot renew or release the lease another worker took', async () => {
    const a = await agent();
    const old = (await leases.acquireLease(a, 'worker-A', { now: T, ttlMs: 10_000 }))!;
    const cur = (await leases.acquireLease(a, 'worker-B', { now: T + 11_000, ttlMs: 10_000 }))!;
    expect(await leases.renewLease(old, { now: T + 12_000 })).toBe(false);
    expect(await leases.stillHeld(old, T + 12_000)).toBe(false);
    await leases.releaseLease(old, T + 12_000);                                                     // does nothing: not its token
    expect(await leases.stillHeld(cur, T + 12_000)).toBe(true);
    expect(await leases.renewLease(cur, { now: T + 15_000, ttlMs: 10_000 })).toBe(true);
    expect(await leases.stillHeld(cur, T + 24_000)).toBe(true);
    await leases.releaseLease(cur, T + 16_000);
    expect(await leases.acquireLease(a, 'worker-C', { now: T + 16_001 })).not.toBeNull();
  });
  it('withLease runs the work under the lease, renews it while it runs, and gives it back — also when the work throws', async () => {
    const a = await agent();
    const inside = await leases.withLease(a, 'worker-A', async (l) => { const blocked = await leases.acquireLease(a, 'worker-B'); return { blocked: blocked === null, token: l.token }; });
    expect(inside).toEqual({ held: true, value: { blocked: true, token: 1 } });
    await expect(leases.withLease(a, 'worker-A', async () => { throw new Error('tick failed'); })).rejects.toThrow('tick failed');
    expect(await leases.acquireLease(a, 'worker-B')).not.toBeNull();                                // released after the failure
    expect(await leases.withLease(a, 'worker-A', async () => 1)).toEqual({ held: false });           // B holds it now
    expect((await leases.listLeases()).find((l) => l.agentId === a)).toMatchObject({ owner: 'worker-B', active: true });
  });
});

describe('job queue — durable tasks with retries and a dead-letter state', () => {
  it('one pending job per dedupe key; a finished one frees the key', async () => {
    const a = await agent();
    const j1 = await queue.enqueue('tick', { agentId: a, dedupeKey: `tick:${a}`, runAt: T }), j2 = await queue.enqueue('tick', { agentId: a, dedupeKey: `tick:${a}`, runAt: T });
    expect([j1.created, j2.created, j2.id]).toEqual([true, false, j1.id]);
    const [c] = await queue.claim('w1', { now: T });
    expect((await queue.enqueue('tick', { agentId: a, dedupeKey: `tick:${a}`, runAt: T })).created).toBe(false);    // running: still one
    expect(await queue.complete(c!, 'w1', 'ok', T)).toBe(true);
    expect((await queue.enqueue('tick', { agentId: a, dedupeKey: `tick:${a}`, runAt: T })).created).toBe(true);
  });
  it('two workers claiming at once never take the same job', async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await queue.enqueue('backtest', { payload: { i }, runAt: T })).id);
    const [x, y] = await Promise.all([queue.claim('w1', { now: T, limit: 12 }), queue.claim('w2', { now: T, limit: 12 })]);
    const got = [...x, ...y].map((j) => j.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(12);
    expect((await sql`select count(*)::int as n from agent_jobs where state = 'running'`)[0].n).toBe(12);
  });
  it('a failed job is retried after its backoff — 2, 5, 10, 15 minutes for a tick — then dead-lettered at the attempt limit', async () => {
    const a = await agent();
    const { id } = await queue.enqueue('tick', { agentId: a, runAt: T });
    let t = T; const seen: [number, string][] = [];
    for (let n = 1; n <= 5; n++) {
      const [j] = await queue.claim('w1', { now: t });
      expect(j, `attempt ${n} is due at ${new Date(t).toISOString()}`).toBeDefined();
      expect(j!.attempts).toBe(n);
      const st = await queue.fail(j!, 'w1', `boom ${n}`, t);
      seen.push([n, st]);
      if (st === 'queued') {
        const [r] = await sql`select run_at, last_error from agent_jobs where id = ${id}`;
        expect(r.run_at.getTime() - t).toBe(queue.backoffMs('tick', n)); expect(r.last_error).toBe(`boom ${n}`);
        expect(await queue.claim('w1', { now: r.run_at.getTime() - 1 })).toEqual([]);              // not before its time
        t = r.run_at.getTime();
      }
    }
    expect(seen).toEqual([[1, 'queued'], [2, 'queued'], [3, 'queued'], [4, 'queued'], [5, 'dead']]);
    const [dead] = await sql`select state, attempts, last_error, finished_at from agent_jobs where id = ${id}`;
    expect([dead.state, dead.attempts, dead.last_error]).toEqual(['dead', 5, 'boom 5']); expect(dead.finished_at).not.toBeNull();
    expect(await queue.claim('w1', { now: t + 10 * 86_400_000 })).toEqual([]);                      // a dead letter is never run again
    expect(queue.jobView((await queue.getJob(id))!)).toMatchObject({ status: 'dead', attempts: 5, error: 'boom 5' });
  });
  it('a worker that dies with a job: the job is reaped when its lock expires — back to the queue, or dead at the limit; another worker\'s answer for it is ignored', async () => {
    const a = await agent();
    const { id } = await queue.enqueue('tick', { agentId: a, runAt: T, maxAttempts: 2 });
    const [j] = await queue.claim('dead-worker', { now: T });
    expect((await queue.reap(T + queue.LOCK_MS.tick - 1)).requeued).toEqual([]);                    // lock still valid
    const r1 = await queue.reap(T + queue.LOCK_MS.tick + 1);
    expect(r1.requeued.map((x: any) => x.id)).toEqual([id]);
    expect(await queue.complete(j!, 'dead-worker', 'late', T + queue.LOCK_MS.tick + 2)).toBe(false); // the dead worker wakes up: its claim is gone
    const [again] = await queue.claim('w2', { now: T + queue.LOCK_MS.tick + 3 });
    expect([again!.id, again!.attempts]).toEqual([id, 2]);
    const r2 = await queue.reap(T + 10 * queue.LOCK_MS.tick);
    expect(r2.dead.map((x: any) => x.id)).toEqual([id]);
    expect((await queue.queueStats()).running).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------ scheduler

function handlers(agents: string[], tick: (id: string) => Promise<string>) {
  const calls: string[] = [];
  const h: any = { spotAgents: async () => [], perpAgents: async () => agents.map((id) => ({ id, kind: 'perp', engine: 'bar', state: 'PAPER_TRADING', mode: 'PAPER', name: id })),
    tickSpot: async () => 'idle', tickPerp: async (id: string) => { calls.push(id); return tick(id); } };
  return { h, calls };
}

describe('scheduler — isolation and the two-process case', () => {
  it('two runtimes on the same database: every agent is ticked exactly once per pass', async () => {
    const ids = [await agent(), await agent(), await agent(), await agent(), await agent(), await agent()];
    const ticked: string[] = [];
    const tick = async (id: string) => { ticked.push(id); await sleep(20); return 'waiting for the next bar'; };
    const a = sched.createAgentRuntime(handlers(ids, tick).h, { workerId: 'proc-A', concurrency: 3 }), b = sched.createAgentRuntime(handlers(ids, tick).h, { workerId: 'proc-B', concurrency: 3 });
    const [ra, rb] = await Promise.all([a.tickPass('perp'), b.tickPass('perp')]);
    expect(ticked.sort()).toEqual([...ids].sort());                             // six ticks for six agents, not twelve
    for (const id of ids) expect([ra[id], rb[id]].filter((x) => x === 'waiting for the next bar').length, id).toBe(1);
    expect((await sql`select count(*)::int as n from agent_jobs where kind = 'tick' and state = 'done'`)[0].n).toBe(6);
  });
  it('a failing agent and a slow agent delay nobody: the others finish, the failure is isolated and backs off in the DATABASE', async () => {
    const [ok1, bad, slow, ok2] = [await agent({ name: 'ok1' }), await agent({ name: 'bad' }), await agent({ name: 'slow' }), await agent({ name: 'ok2' })];
    const done: string[] = [];
    const { h, calls } = handlers([ok1, bad, slow, ok2], async (id) => { if (id === bad) throw new Error('strategy exploded'); if (id === slow) await sleep(400); done.push(id); return '1 order(s)'; });
    const rt = sched.createAgentRuntime(h, { workerId: 'proc-A', concurrency: 4 });
    const t0 = Date.now(), out = await rt.tickPass('perp');
    expect(out[ok1]).toBe('1 order(s)'); expect(out[ok2]).toBe('1 order(s)'); expect(out[slow]).toBe('1 order(s)'); expect(out[bad]).toBe('error: strategy exploded');
    expect(done.indexOf(ok1)).toBeLessThan(done.indexOf(slow)); expect(done.indexOf(ok2)).toBeLessThan(done.indexOf(slow));   // the quick ones did not wait for the slow one
    expect(Date.now() - t0).toBeLessThan(2000);
    // the failed agent's job waits for its retry time: the next pass does NOT run it (the backoff survives a restart: it is a row)
    const [job] = await sql`select state, attempts, run_at, last_error from agent_jobs where agent_id = ${bad}`;
    expect([job.state, job.attempts, job.last_error]).toEqual(['queued', 1, 'strategy exploded']); expect(job.run_at.getTime()).toBeGreaterThan(Date.now() + 100_000);
    const restarted = sched.createAgentRuntime(h, { workerId: 'proc-A-restarted', concurrency: 4 });
    const out2 = await restarted.tickPass('perp');
    expect(out2[bad]).toBe('backing off after an error');
    expect(calls.filter((c) => c === bad)).toHaveLength(1);
    expect(calls.filter((c) => c === ok1)).toHaveLength(2);
  });
  it('after the last retry the job is dead-lettered and the agent\'s journal says so; a fresh job follows on the next pass', async () => {
    const bad = await agent({ name: 'always-bad' });
    let t = T;
    const { h } = handlers([bad], async () => { throw new Error('cannot read the venue'); });
    const rt = sched.createAgentRuntime(h, { workerId: 'proc-A', now: () => t });
    for (let n = 1; n <= 5; n++) { expect((await rt.tickPass('perp'))[bad]).toBe('error: cannot read the venue'); t += 16 * 60_000; }
    expect((await sql`select state, attempts from agent_jobs where agent_id = ${bad}`)[0]).toEqual({ state: 'dead', attempts: 5 });
    const j = await sql`select kind, severity, code, title, mode from research_log where agent_id = ${bad} and code = 'job_dead_letter'`;
    expect(j).toHaveLength(1); expect(j[0]).toMatchObject({ kind: 'error', severity: 'error', mode: 'PAPER' }); expect(j[0].title).toMatch(/dead-lettered after 5 attempt/);
    await rt.tickPass('perp');
    expect((await sql`select state from agent_jobs where agent_id = ${bad} order by created_at`).map((r: any) => r.state)).toEqual(['dead', 'queued']);
  });
  it('a tick that overruns its deadline: the JOB fails, but the agent\'s lease is kept until the tick really ends — nobody else may tick it meanwhile', async () => {
    const hang = await agent({ name: 'hang' });
    let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
    const { h, calls } = handlers([hang], async () => { await gate; return 'late'; });
    const rt = sched.createAgentRuntime(h, { workerId: 'proc-A', tickTimeoutMs: 60 });
    expect((await rt.tickPass('perp'))[hang]).toBe('error: timed out after 60 ms');
    expect(await leases.acquireLease(hang, 'proc-B')).toBeNull();               // still leased by the overrunning tick
    expect((await sql`select code from research_log where agent_id = ${hang} and code = 'tick_timeout'`)).toHaveLength(1);
    release(); await Promise.all([...rt.overrun]); await sleep(20);
    expect(await leases.acquireLease(hang, 'proc-B')).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
  it('an agent leased by another worker is skipped without an error', async () => {
    const a = await agent();
    await leases.acquireLease(a, 'someone-else');
    const { h, calls } = handlers([a], async () => 'x');
    expect((await sched.createAgentRuntime(h, { workerId: 'proc-A' }).tickPass('perp'))[a]).toBe('leased by another worker');
    expect(calls).toEqual([]);
  });
  it('the jobs pass runs backtests and wind-downs with their handlers; a kind without a handler fails loudly', async () => {
    const a = await agent();
    const seen: string[] = [];
    const h: any = { ...handlers([], async () => '').h, backtest: async (j: any) => { seen.push(`backtest:${j.payload.versionId}`); return { label: 'backtest' }; } };
    const rt = sched.createAgentRuntime(h, { workerId: 'proc-A' });
    const b = await queue.enqueue('backtest', { agentId: a, payload: { versionId: 'v1' } }), w = await queue.enqueue('wind_down', { agentId: a });
    await rt.jobsPass();
    expect(seen).toEqual(['backtest:v1']);
    expect(queue.jobView((await queue.getJob(b.id))!)).toMatchObject({ status: 'done', result: { label: 'backtest' } });
    expect((await queue.getJob(w.id))!.last_error).toBe('no handler for wind_down');
  });
  it('retention: the jobs pass removes FINISHED jobs older than 14 days (once an hour per worker) — never a queued or a running one, never a recent one', async () => {
    const a = await agent(), ids: Record<string, string> = {};
    for (const [name, state, days] of [['old-done', 'done', 15], ['old-dead', 'dead', 40], ['old-cancelled', 'cancelled', 15], ['recent-done', 'done', 13], ['old-queued', 'queued', 30], ['old-running', 'running', 30]] as const) {
      const j = await queue.enqueue('wind_down', { agentId: a, payload: { name } }); ids[name] = j.id;
      await sql`update agent_jobs set state = ${state}, finished_at = ${state === 'queued' || state === 'running' ? null : sql`now() - ${`${days} days`}::interval`}, created_at = now() - ${`${days} days`}::interval,
        run_at = now() + interval '1 hour', locked_until = now() + interval '1 hour' where id = ${j.id}`;
    }
    const rt = sched.createAgentRuntime(handlers([], async () => '').h, { workerId: 'proc-prune' });
    await rt.jobsPass();
    const left = (await sql<{ id: string }[]>`select id from agent_jobs where id in ${sql(Object.values(ids))}`).map((r: { id: string }) => r.id);
    expect(Object.entries(ids).filter(([, id]) => left.includes(id)).map(([n]) => n).sort()).toEqual(['old-queued', 'old-running', 'recent-done']);
    // within the hour the same worker does not prune again: a job that becomes old now stays until the next hour
    await sql`update agent_jobs set finished_at = now() - interval '20 days' where id = ${ids['recent-done']!}`;
    await rt.jobsPass();
    expect(await queue.getJob(ids['recent-done']!)).not.toBeNull();
    expect(await queue.pruneJobs()).toBe(1);
    await sql`delete from agent_jobs where id in ${sql(Object.values(ids))}`;
  });
});

// ------------------------------------------------------------------------------------------------------------------ gateway

function order(agentId: string, o: Partial<CanonicalOrderInput> = {}): CanonicalOrderInput {
  const now = Date.now();
  return { v: 1, venue: 'hyperliquid', network: 'mainnet', instrument: 'hyperliquid:BTC', marketKind: 'perp', side: 'buy', type: 'market', size: '0.01', notional: null, limitPrice: null, triggerPrice: null, reduceOnly: false, tif: 'ioc', maxSlippageBps: 30,
    maxFeeUsd: '1', leverage: '2', marginMode: 'cross', clientOrderId: `test-${randomUUID()}`, mode: 'paper', principal: { kind: 'agent', id: agentId }, mandateId: agentId, createdAt: now, expiresAt: now + 60_000, ...o };
}
function seam(script: { execute?: any; lookup?: any; conclusive?: number | null } = {}) {
  const calls = { execute: 0, lookup: 0 };
  const filled = { status: 'accepted', venueOrderId: 'v-1', filledSize: '0.01', avgFillPrice: '100000', fills: [{ id: 'f1', size: '0.01', price: '100000', feeUsd: '0.45' }], final: true };
  const s: any = { calls, filled,
    execute: async (o: any, ctx: any) => { calls.execute += 1; const r = typeof script.execute === 'function' ? await script.execute(o, ctx, calls.execute) : script.execute ?? filled; if (r instanceof Error) throw r; return r; },
    lookup: async (o: any) => { calls.lookup += 1; const r = typeof script.lookup === 'function' ? await script.lookup(o, calls.lookup) : script.lookup ?? null; if (r instanceof Error) throw r; return r; },
    absenceConclusiveAt: (_o: any, at: number) => (script.conclusive === undefined ? at : script.conclusive) };
  return s;
}
const row = async (id: string) => (await sql`select * from agents where id = ${id}`)[0];
const P = (id: string) => ({ kind: 'agent' as const, id });

describe('order gateway — the adapter over the engine seams', () => {
  it('a paper order: CREATED → VALIDATED → APPROVED (simulated account) → SUBMITTING → FILLED, with its fills, journal lines and context', async () => {
    const a = await agent(), s = seam();
    const g = gw.seamGatewayFactory({ agent: await row(a), seam: s, authorityId: a });
    const o = order(a), rec = await g.submit(P(a), o, { idempotencyKey: o.clientOrderId, resolved: { worstPrice: '100100' }, context: { signalId: '7', configVersion: 3, strategySha256: 'ab'.repeat(32) } });
    expect([rec.state, rec.reason, rec.filledSize, rec.avgFillPrice, rec.venueOrderId, rec.mode, rec.idempotent, rec.attempt]).toEqual(['FILLED', 'VENUE_FILLED', '0.01', '100000', 'v-1', 'paper', false, 1]);
    expect(rec.history.map((h) => `${h.from}>${h.to}`)).toEqual(['CREATED>VALIDATED', 'VALIDATED>APPROVED', 'APPROVED>SUBMITTING', 'SUBMITTING>FILLED']);
    expect(rec.fills).toEqual([{ id: 'f1', size: '0.01', price: '100000', feeUsd: '0.45', ts: expect.any(Number) }]);
    expect([rec.signalId, rec.configVersion, rec.strategySha256]).toEqual(['7', 3, 'ab'.repeat(32)]);
    expect((await sql`select kind, mode, code from research_log where agent_id = ${a} order by id`).map((r: any) => [r.kind, r.mode, r.code])).toEqual([['order', 'PAPER', 'FILLED'], ['fill', 'PAPER', 'FILL']]);
    expect(await g.get(P(a), rec.id)).toMatchObject({ id: rec.id, state: 'FILLED' });
    expect((await g.list(P(a), { mode: 'paper' })).map((x) => x.id)).toEqual([rec.id]); expect(await g.list(P(a), { mode: 'live' })).toEqual([]);
  });

  it('same idempotency key: the stored record is the answer and NOTHING is executed again — whatever the body says', async () => {
    const a = await agent(), s = seam();
    const g = gw.seamGatewayFactory({ agent: await row(a), seam: s, authorityId: a }), o = order(a);
    await g.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    const again = await g.submit(P(a), { ...o, size: '5' }, { idempotencyKey: o.clientOrderId });
    expect([again.state, again.idempotent, again.size, s.calls.execute]).toEqual(['FILLED', true, '0.01', 1]);
    // two workers submitting the same key at the same instant: one row, one execution
    const o2 = order(a), s2 = seam();
    const g2 = gw.seamGatewayFactory({ agent: await row(a), seam: s2, authorityId: a });
    const [r1, r2] = await Promise.all([g2.submit(P(a), o2, { idempotencyKey: o2.clientOrderId }), g2.submit(P(a), o2, { idempotencyKey: o2.clientOrderId })]);
    expect(s2.calls.execute).toBe(1); expect([r1.id, r2.id]).toEqual([o2.clientOrderId, o2.clientOrderId]);
  });

  it('an order another worker is executing RIGHT NOW is left alone: no lookup, no settlement, no second execution — until the grace has passed', async () => {
    const a = await agent();
    let t = Date.now(), finish: (r: any) => void = () => {};
    const hanging = seam({ execute: () => new Promise((res) => { finish = res; }), lookup: null });   // the first worker's call to the venue is still in the air
    const g1 = gw.seamGatewayFactory({ agent: await row(a), seam: hanging, authorityId: a, now: () => t }), o = order(a);
    const first = g1.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    await sleep(30);
    // a second worker comes with the same key while the first is mid-flight: "no trace" on the execution side must NOT become "never placed"
    const other = seam({ lookup: null });
    const g2 = gw.seamGatewayFactory({ agent: await row(a), seam: other, authorityId: a, now: () => t });
    const seen = await g2.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    expect([seen.state, seen.idempotent, other.calls.execute, other.calls.lookup]).toEqual(['SUBMITTING', true, 0, 0]);
    expect((await g2.reconcile!()).map((r) => r.state)).toEqual(['SUBMITTING']); expect(other.calls.lookup).toBe(0);
    // the first worker's call returns: its record is settled by IT
    finish(hanging.filled);
    expect((await first).state).toBe('FILLED');
    expect((await g2.submit(P(a), o, { idempotencyKey: o.clientOrderId })).state).toBe('FILLED');
    expect(hanging.calls.execute).toBe(1);
    // a SUBMITTING record whose worker died (nothing changed for longer than the grace) IS asked about
    const o2 = order(a), dead = seam({ execute: () => new Promise(() => {}), lookup: null });
    void gw.seamGatewayFactory({ agent: await row(a), seam: dead, authorityId: a, now: () => t }).submit(P(a), o2, { idempotencyKey: o2.clientOrderId });
    await sleep(30);
    t += gw.IN_FLIGHT_GRACE_MS + 1;
    const late = seam({ lookup: { status: 'pending', code: 'submitted', reason: 'the venue has it, unconfirmed', venueOrderId: 'v-77' } });
    const settled = await gw.seamGatewayFactory({ agent: await row(a), seam: late, authorityId: a, now: () => t }).submit(P(a), o2, { idempotencyKey: o2.clientOrderId });
    expect([settled.state, settled.venueOrderId, late.calls.lookup, late.calls.execute]).toEqual(['SUBMITTED', 'v-77', 1, 0]);
  });

  it('refused before anything leaves: research mode, another mode than the agent\'s, no mandate in force, another mandate, an instrument that is not the agent\'s', async () => {
    const paper = await agent(), research = await agent({ state: 'CREATED', mode: 'RESEARCH' }), live = await agent({ state: 'LIVE', mode: 'LIVE' });
    const s = seam(), mandate = randomUUID();
    const sub = async (id: string, authorityId: string | null, o: Partial<CanonicalOrderInput>) => { const ord = order(id, o); return gw.seamGatewayFactory({ agent: await row(id), seam: s, authorityId }).submit(P(id), ord, { idempotencyKey: ord.clientOrderId }); };
    const cases: [string, Promise<any>, string, RegExp][] = [
      ['research agent', sub(research, research, {}), 'READ_ONLY_MODE', /research mode places no order/],
      ['live order on a paper agent', sub(paper, paper, { mode: 'live' }), 'READ_ONLY_MODE', /the order says live and the agent is in paper/],
      ['live, no mandate in force', sub(live, null, { mode: 'live', mandateId: mandate }), 'MANDATE_DENIED', /no owner-approved mandate is in force/],
      ['live, another mandate than the one in force', sub(live, mandate, { mode: 'live', mandateId: randomUUID() }), 'MANDATE_DENIED', /another mandate/],
      ['paper, not the simulated account', sub(paper, paper, { mandateId: randomUUID() }), 'MANDATE_DENIED', /simulated account/],
      ['foreign instrument', sub(paper, paper, { instrument: 'hyperliquid:DOGE' }), 'INSTRUMENT_NOT_ALLOWED', /not one of this agent's instruments/],
    ];
    for (const [name, p, reason, detail] of cases) { const r = await p; expect([r.state, r.reason], name).toEqual(['REJECTED', reason]); expect(r.detail, name).toMatch(detail); }
    expect(s.calls.execute).toBe(0);
    expect((await sql`select severity, kind from research_log where agent_id = ${live}`).every((r: any) => r.severity === 'warning' && r.kind === 'risk')).toBe(true);
    // a live order that names the mandate in force passes to the seam
    const ok = await sub(live, mandate, { mode: 'live', mandateId: mandate });
    expect([ok.state, ok.mode, ok.history[1]!.reason]).toEqual(['FILLED', 'live', 'APPROVED_BY_MANDATE']);
    // the order must be the submitting agent's own
    const o = order(paper);
    await expect(gw.seamGatewayFactory({ agent: await row(paper), seam: s, authorityId: paper }).submit(P(research), o, { idempotencyKey: o.clientOrderId })).rejects.toThrow(/bound to another agent/);
    await expect(gw.seamGatewayFactory({ agent: await row(paper), seam: s, authorityId: paper }).submit(P(paper), order(research), { idempotencyKey: o.clientOrderId })).rejects.toThrow(/another principal/);
    await expect(gw.seamGatewayFactory({ agent: await row(paper), seam: s, authorityId: paper }).submit(P(paper), { ...order(paper), mandateId: null } as never, { idempotencyKey: o.clientOrderId })).rejects.toThrow();   // the canonical schema: an agent acts under an authority
  });

  it('kill switch: an order that adds risk is refused; a reduce-only order and a spot sale pass', async () => {
    const a = await agent(), s = seam(), engaged = { engaged: async () => ({ engaged: true, reason: 'daily loss' }) };
    const g = gw.seamGatewayFactory({ agent: await row(a), seam: s, authorityId: a, killSwitch: engaged });
    const open = order(a), close = order(a, { side: 'sell', reduceOnly: true });
    const r1 = await g.submit(P(a), open, { idempotencyKey: open.clientOrderId });
    expect([r1.state, r1.reason]).toEqual(['REJECTED', 'KILL_SWITCH_ACTIVE']); expect(r1.detail).toMatch(/daily loss/);
    expect((await g.submit(P(a), close, { idempotencyKey: close.clientOrderId })).state).toBe('FILLED');
    expect(s.calls.execute).toBe(1);
    expect([gw.reducesRisk({ reduceOnly: false, marketKind: 'spot', side: 'sell' }), gw.reducesRisk({ reduceOnly: false, marketKind: 'spot', side: 'buy' }), gw.reducesRisk({ reduceOnly: false, marketKind: 'perp', side: 'sell' })]).toEqual([true, false, false]);
  });

  it('refusals of the execution side: risk engine, mandate, signer, venue — each recorded with who said no', async () => {
    const a = await agent();
    const by = async (res: any) => { const o = order(a); return gw.seamGatewayFactory({ agent: await row(a), seam: seam({ execute: res }), authorityId: a }).submit(P(a), o, { idempotencyKey: o.clientOrderId }); };
    expect([(await by({ status: 'rejected', by: 'risk', code: 'max_position', reason: 'too large' })).reason, (await by({ status: 'rejected', by: 'mandate', code: 'mandate_none', reason: 'no mandate' })).reason,
      (await by({ status: 'rejected', by: 'signer', code: 'signer_refused', reason: 'price' })).reason, (await by({ status: 'rejected', by: 'venue', code: 'venue_rejected', reason: 'no liquidity' })).reason])
      .toEqual(['RISK_DENIED', 'MANDATE_DENIED', 'SIGNER_REFUSED', 'VENUE_REJECTED']);
    const partial = await by({ status: 'accepted', venueOrderId: 'v-2', filledSize: '0.004', avgFillPrice: '100000', fills: [], final: true, note: 'unfilled remainder cancelled', venueStatus: 'cancelled' });
    expect([partial.state, partial.reason, partial.filledSize, partial.venueStatus]).toEqual(['CANCELLED', 'REMAINDER_CANCELLED', '0.004', 'cancelled']);
    const resting = await by({ status: 'accepted', venueOrderId: 'v-3', filledSize: '0', avgFillPrice: null, fills: [], final: false });
    expect([resting.state, resting.reason]).toEqual(['SUBMITTED', 'VENUE_RESTING']);
  });

  it('UNKNOWN OUTCOME — the executor throws after the order may have left: recorded UNKNOWN, journaled as an error, and NEVER sent again under that key', async () => {
    const a = await agent();
    let found: any = new Error('venue unreachable');
    const s = seam({ execute: new Error('socket hang up'), lookup: () => found, conclusive: null });
    const g = gw.seamGatewayFactory({ agent: await row(a), seam: s, authorityId: a }), o = order(a);
    const r1 = await g.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    expect([r1.state, r1.reason, r1.detail]).toEqual(['UNKNOWN', 'SUBMIT_NETWORK_ERROR', 'socket hang up']);
    expect((await sql`select severity, code, title from research_log where agent_id = ${a}`)[0]).toMatchObject({ severity: 'error', code: 'ORDER_OUTCOME_UNKNOWN', title: 'Order outcome unknown: it will be reconciled, not sent again' });
    // the engine comes back with the same key (next pass, or after a restart: a NEW gateway object). The execution side cannot be asked: still unknown, still not sent.
    const g2 = gw.seamGatewayFactory({ agent: await row(a), seam: s, authorityId: a });
    const r2 = await g2.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    expect([r2.state, r2.idempotent, s.calls.execute, s.calls.lookup]).toEqual(['UNKNOWN', true, 1, 1]);
    // it answers "no trace" but absence cannot be proven on this venue: still unknown, still not sent
    found = null;
    const r3 = await g2.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    expect([r3.state, r3.reason, s.calls.execute]).toEqual(['UNKNOWN', 'ABSENT_UNVERIFIABLE', 1]);
    // the venue finally shows it: filled. The record follows; nothing was ever resent.
    found = s.filled;
    const r4 = (await g2.reconcile!())[0]!;
    expect([r4.state, r4.filledSize, s.calls.execute]).toEqual(['FILLED', '0.01', 1]);
    expect((await g2.submit(P(a), o, { idempotencyKey: o.clientOrderId })).state).toBe('FILLED');
    expect(s.calls.execute).toBe(1);
    expect(r4.history.map((h) => h.to)).toEqual(['VALIDATED', 'APPROVED', 'SUBMITTING', 'UNKNOWN', 'UNKNOWN', 'FILLED']);
  });

  it('a new attempt under the same key is allowed ONLY when the previous one provably never left (NOT_SENT / NEVER_PLACED) — with the same venue client id', async () => {
    const a = await agent();
    // 1 — the executor says "not sent now" (a cool-down): FAILED/NOT_SENT, then the retry runs
    const s1 = seam({ execute: (_o: any, _c: any, n: number) => (n === 1 ? { status: 'not_sent', code: 'live_cooldown', reason: 'the signer still counts the last order' } : undefined) });
    s1.execute = ((orig) => async (o: any, c: any) => (await orig(o, c)) ?? s1.filled)(s1.execute);
    const g1 = gw.seamGatewayFactory({ agent: await row(a), seam: s1, authorityId: a }), o1 = order(a);
    const first = await g1.submit(P(a), o1, { idempotencyKey: o1.clientOrderId });
    expect([first.state, first.reason, first.detail, first.attempt]).toEqual(['FAILED', 'NOT_SENT', 'live_cooldown: the signer still counts the last order', 1]);
    const second = await g1.submit(P(a), o1, { idempotencyKey: o1.clientOrderId });
    expect([second.state, second.attempt, second.id, second.clientOrderId, s1.calls.execute]).toEqual(['FILLED', 2, `${o1.clientOrderId}~2`, o1.clientOrderId, 2]);
    // 2 — unknown, then the execution side has no trace of it and absence IS conclusive there: FAILED/NEVER_PLACED, then the retry runs
    let n = 0;
    const s2 = seam({ execute: () => (++n === 1 ? new Error('timeout') : s2.filled), lookup: null });
    const g2 = gw.seamGatewayFactory({ agent: await row(a), seam: s2, authorityId: a }), o2 = order(a);
    expect((await g2.submit(P(a), o2, { idempotencyKey: o2.clientOrderId })).state).toBe('UNKNOWN');
    const retried = await g2.submit(P(a), o2, { idempotencyKey: o2.clientOrderId });
    expect([retried.state, retried.attempt, s2.calls.execute]).toEqual(['FILLED', 2, 2]);
    expect((await sql`select attempt, state, reason from agent_order_intents where idempotency_key = ${o2.clientOrderId} order by attempt`).map((r: any) => [r.attempt, r.state, r.reason])).toEqual([[1, 'FAILED', 'NEVER_PLACED'], [2, 'FILLED', 'VENUE_FILLED']]);
    // 3 — a REJECTED or CANCELLED order is final: never a second attempt
    const s3 = seam({ execute: { status: 'rejected', by: 'venue', code: 'venue_rejected', reason: 'no liquidity' } });
    const g3 = gw.seamGatewayFactory({ agent: await row(a), seam: s3, authorityId: a }), o3 = order(a);
    await g3.submit(P(a), o3, { idempotencyKey: o3.clientOrderId });
    expect([(await g3.submit(P(a), o3, { idempotencyKey: o3.clientOrderId })).state, s3.calls.execute]).toEqual(['REJECTED', 1]);
  });

  it('a resting order: reconcile follows it to its fill; cancel asks the execution side; an idle pass adds no history', async () => {
    const a = await agent();
    let state: any = { status: 'accepted', venueOrderId: 'v-9', filledSize: '0', avgFillPrice: null, fills: [], final: false };
    const s = seam({ execute: () => state, lookup: () => state });
    s.cancel = async () => ({ status: 'accepted', venueOrderId: 'v-9', filledSize: '0', avgFillPrice: null, fills: [], final: true });
    const g = gw.seamGatewayFactory({ agent: await row(a), seam: s, authorityId: a }), o = order(a, { type: 'limit', limitPrice: '99000', tif: 'alo' });
    const r = await g.submit(P(a), o, { idempotencyKey: o.clientOrderId });
    expect(r.state).toBe('SUBMITTED');
    const n = (await g.reconcile!())[0]!.history.length;
    expect((await g.reconcile!())[0]!.history.length).toBe(n);                  // nothing new: no event
    expect((await g.list(P(a), { open: true })).map((x) => x.id)).toEqual([r.id]);
    const c = await g.cancel(P(a), r.id);
    expect([c.state, c.reason]).toEqual(['CANCELLED', 'CANCELLED_BY_REQUEST']);
    expect(await g.list(P(a), { open: true })).toEqual([]);
    await expect(g.cancel(P(a), 'nope')).rejects.toThrow(/not found/);
  });
});

describe('kill switch port — bound to the risk engine (the ONE switch)', () => {
  it('engage goes to the risk service in the agent\'s name, once; the port has nothing else; unbound it refuses loudly; the state the agents read is the risk engine\'s record', async () => {
    const bind = await import('../src/agents/execution-bind.ts'), ord = await import('../src/orders/index.ts');
    await sql`delete from settings where key in ('risk.switches', 'agents.kill_switch')`;
    // unbound: the read still answers the one switch, engage does not pretend
    bind.bindExecution(null);
    expect(await ks.killSwitchRead.engaged()).toEqual({ engaged: false, reason: null, readOnly: false });
    await expect(ks.killSwitch().engage('x')).rejects.toThrow(/not bound to the risk service/);
    const ex = ord.createExecution({ verifyOwner: async () => { throw new Error('no passkey in this test'); }, signerStatus: async () => ({ halted: false }) });
    bind.bindExecution(ex);
    const port = ks.killSwitch();
    expect(Object.keys(port)).toEqual(['engage']);                              // no release on the port
    expect(await port.engage('LIVE agents lost 12 % today', { kind: 'agent', id: 'risk-1' })).toMatchObject({ engaged: true, already: false });
    expect((await ex.risk.switches()).killSwitch).toMatchObject({ on: true, reason: 'LIVE agents lost 12 % today', by: { kind: 'agent', id: 'risk-1' } });
    expect(await ks.killSwitchState()).toMatchObject({ engaged: true, reason: 'LIVE agents lost 12 % today', by: 'agent:risk-1', readOnly: false, release: { route: '/risk', passkey: true } });
    expect(await ks.killSwitchRead.engaged()).toEqual({ engaged: true, reason: 'LIVE agents lost 12 % today', readOnly: false });
    expect(await port.engage('again', { kind: 'agent', id: 'risk-2' })).toMatchObject({ engaged: true, already: true });
    expect((await ex.risk.switches()).killSwitch.by).toEqual({ kind: 'agent', id: 'risk-1' });
    expect((await sql`select type, actor from audit_events where type like '%kill_switch%' order by seq`).map((r: any) => [r.type, r.actor])).toEqual([['risk.kill_switch', 'agent:risk-1']]);
    // nothing in the agents' modules releases: the module exports no such thing, and the risk engine's release wants the passkey
    expect(Object.keys(ks).filter((k) => /release/i.test(k))).toEqual([]);
    expect(Object.keys(bind).filter((k) => /release/i.test(k))).toEqual([]);
    await expect(ex.risk.release('kill_switch', undefined)).rejects.toBeTruthy();
    expect((await ex.risk.switches()).killSwitch.on).toBe(true);
    await sql`delete from settings where key = 'risk.switches'`;
    bind.bindExecution(null);
  });
});

describe('STOP ALL AGENTS — the port the execution layer consumes (agents/control.ts)', () => {
  it('every trading agent is stopped through the runtime\'s own stop — spot included; the risk-management agent keeps watching; the bound execution layer answers with this port', async () => {
    const ctl = await import('../src/agents/control.ts'), bind = await import('../src/agents/execution-bind.ts'), ord = await import('../src/orders/index.ts'), { randomUUID: uuid } = await import('node:crypto');
    await sql`update agents set state = 'STOPPED' where state in ('PAPER_TRADING', 'LIVE', 'PAUSED', 'RUNNING', 'STOPPING')`;   // what earlier tests of this file left running
    const spot = uuid(), stream = uuid(), sup = uuid(), idle = uuid();
    await sql`insert into agents (id, kind, name, universe, risk, vault_index, vault_address, state, mode, engine, family) values
      (${spot}, 'spot', 'spot paper', ${sql.json(['ETH'])}, ${sql.json({})}, 9701, '0x0', 'PAPER_TRADING', 'PAPER', 'bar', 'custom'),
      (${stream}, 'stream', 'mm paper', ${sql.json(['BTC'])}, ${sql.json({})}, 9702, '0x0', 'PAPER_TRADING', 'PAPER', 'stream', 'market_making'),
      (${sup}, 'supervisor', 'risk', ${sql.json([])}, ${sql.json({})}, 9703, '0x0', 'RUNNING', 'PAPER', 'supervisor', 'risk_manager'),
      (${idle}, 'spot', 'never started', ${sql.json(['ETH'])}, ${sql.json({})}, 9704, '0x0', 'CREATED', 'RESEARCH', 'bar', 'custom')`;
    const ex = ord.createExecution({ signerStatus: async () => ({ halted: false }) });
    bind.bindExecution(ex);
    expect(Object.keys(ctl.agentControlPort())).toEqual(['stopAll']);
    const r = await ex.agents.stopAll('drill');
    expect([...r.stopped].sort()).toEqual([spot, stream].sort()); expect(r.notStopped).toBeUndefined();
    expect(Object.fromEntries((await sql`select id, state from agents where id in ${sql([spot, stream, sup, idle])}`).map((a: any) => [a.id, a.state]))).toEqual({ [spot]: 'STOPPED', [stream]: 'STOPPED', [sup]: 'RUNNING', [idle]: 'CREATED' });
    expect((await sql`select actor, data->>'reason' as reason from audit_events where type = 'agent.stop' order by seq desc limit 1`)[0]).toMatchObject({ actor: 'owner', reason: 'STOP ALL AGENTS: drill' });
    expect((await ex.agents.stopAll('again')).stopped).toEqual([]);
    bind.bindExecution(null);
  });
});

// Per-agent leases (audit D7): two API processes — or the API and a separate `sp-wallet-agents` worker — can never tick the
// same agent at the same time. A lease is a ROW, not a session lock: it survives a pooled connection being handed to another
// query, it is visible (who holds which agent, since when), and a holder that dies simply stops renewing it.
//
//   acquire   insert, or take over a row whose `expires_at` has passed; one statement, so two racers cannot both win
//   renew     heartbeat while the tick runs (only the holder with the current token can)
//   release   at the end of the tick; a crashed holder's lease expires by itself after `ttlMs`
//   token     a fencing token, incremented at every acquisition: a holder that was paused past its expiry and wakes up cannot
//             renew or release the lease another worker took meanwhile, and `stillHeld` tells it to stop before it writes
//
// Time is the DATABASE's clock by default (`now()`), so two machines with different clocks agree; tests pass their own.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sql } from '../db.ts';

export const LEASE_TTL_MS = 180_000;
/** a worker identity: host, process and a random part (a restarted process is a new owner) */
export const newWorkerId = (role = 'api'): string => `${role}@${hostname().slice(0, 40)}:${process.pid}:${randomUUID().slice(0, 8)}`;
export interface Lease { agentId: string; owner: string; token: number; expiresAt: number }
const at = (now: number | undefined) => (now === undefined ? null : new Date(now));

/** Take the lease of one agent, or null when another live worker holds it. Re-entrant for the same owner (it refreshes). */
export async function acquireLease(agentId: string, owner: string, o: { ttlMs?: number; now?: number } = {}): Promise<Lease | null> {
  const ttl = `${o.ttlMs ?? LEASE_TTL_MS} milliseconds`, t = at(o.now);
  const rows = await sql<{ token: string; expires_at: Date }[]>`
    insert into agent_leases (agent_id, owner, token, acquired_at, heartbeat_at, expires_at)
    values (${agentId}, ${owner}, 1, coalesce(${t}, now()), coalesce(${t}, now()), coalesce(${t}, now()) + ${ttl}::interval)
    on conflict (agent_id) do update set owner = excluded.owner, token = agent_leases.token + 1, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
      where agent_leases.expires_at <= coalesce(${t}, now()) or agent_leases.owner = excluded.owner
    returning token, expires_at`;
  const r = rows[0];
  return r ? { agentId, owner, token: Number(r.token), expiresAt: r.expires_at.getTime() } : null;
}

/** Heartbeat. False when the lease is no longer this holder's (expired and taken over): the holder must stop. */
export async function renewLease(l: Lease, o: { ttlMs?: number; now?: number } = {}): Promise<boolean> {
  const ttl = `${o.ttlMs ?? LEASE_TTL_MS} milliseconds`, t = at(o.now);
  const rows = await sql<{ expires_at: Date }[]>`update agent_leases set heartbeat_at = coalesce(${t}, now()), expires_at = coalesce(${t}, now()) + ${ttl}::interval
    where agent_id = ${l.agentId} and owner = ${l.owner} and token = ${l.token} returning expires_at`;
  if (!rows[0]) return false;
  l.expiresAt = rows[0].expires_at.getTime();
  return true;
}

export async function stillHeld(l: Lease, now?: number): Promise<boolean> {
  const t = at(now);
  return (await sql`select 1 from agent_leases where agent_id = ${l.agentId} and owner = ${l.owner} and token = ${l.token} and expires_at > coalesce(${t}, now())`).length > 0;
}

/** Give the lease back (only the current holder's token does anything). The row stays, expired, so the token keeps increasing. */
export async function releaseLease(l: Lease, now?: number): Promise<void> {
  const t = at(now);
  await sql`update agent_leases set expires_at = coalesce(${t}, now()) where agent_id = ${l.agentId} and owner = ${l.owner} and token = ${l.token}`;
}

/** Run `fn` under the agent's lease, renewing it while it runs. Returns `{ held: false }` when another worker has the agent. */
export async function withLease<T>(agentId: string, owner: string, fn: (l: Lease) => Promise<T>, o: { ttlMs?: number; now?: () => number; renewEveryMs?: number } = {}): Promise<{ held: true; value: T } | { held: false }> {
  const now = o.now, ttlMs = o.ttlMs ?? LEASE_TTL_MS;
  const l = await acquireLease(agentId, owner, { ttlMs, ...(now ? { now: now() } : {}) });
  if (!l) return { held: false };
  const timer = setInterval(() => { void renewLease(l, { ttlMs, ...(now ? { now: now() } : {}) }).catch(() => false); }, o.renewEveryMs ?? Math.max(1000, Math.floor(ttlMs / 3)));
  timer.unref();
  try { return { held: true, value: await fn(l) }; }
  finally { clearInterval(timer); await releaseLease(l, now ? now() : undefined).catch(() => {}); }
}

export async function listLeases(): Promise<{ agentId: string; owner: string; token: number; heartbeatAt: number; expiresAt: number; active: boolean }[]> {
  const rows = await sql<{ agent_id: string; owner: string; token: string; heartbeat_at: Date; expires_at: Date; active: boolean }[]>`select agent_id, owner, token, heartbeat_at, expires_at, expires_at > now() as active from agent_leases order by heartbeat_at desc`;
  return rows.map((r) => ({ agentId: r.agent_id, owner: r.owner, token: Number(r.token), heartbeatAt: r.heartbeat_at.getTime(), expiresAt: r.expires_at.getTime(), active: r.active }));
}

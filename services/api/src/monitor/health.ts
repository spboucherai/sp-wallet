// Health of everything the wallet depends on, read PASSIVELY: this module never calls a venue, a swap provider or Circle. It reads
// what the workers already recorded (RPC health cache, market quality table, quotes log, equity snapshots, bridge rows, worker
// heartbeats) plus the signer status the API already polls. Shared by the dashboard and by the "source down" alerts.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NETWORKS, verifyAuditChain, type AuditRecord, type NetworkDef } from '@spw/core';
import type { Health } from '../chains/index.ts';
import { sql } from '../db.ts';
import type { SignerStatus } from '../signer-client.ts';
import type { LoopStat } from '../worker.ts';

export interface Connector {
  id: string; group: 'signer' | 'rpc' | 'market' | 'venue' | 'swap' | 'bridge' | 'database';
  name: string;
  /** null = not measured (nothing in use that would tell) — never shown as healthy */
  ok: boolean | null;
  lastSuccessAt: number | null; detail: string;
}
export interface HealthDeps {
  now(): number;
  /** null when the signer does not answer */
  signerStatus(): Promise<SignerStatus | null>;
  rpcHealth(): Health[];
  loops(): LoopStat[];
}

const lastOk = new Map<string, number>();
const seen = (id: string, ok: boolean | null, at: number | null): number | null => { if (ok && at) lastOk.set(id, Math.max(at, lastOk.get(id) ?? 0)); return lastOk.get(id) ?? null; };
const NETS = Object.values(NETWORKS) as NetworkDef[];

export async function collectConnectors(d: HealthDeps): Promise<{ connectors: Connector[]; signer: SignerStatus | null }> {
  const now = d.now(), out: Connector[] = [];
  const signer = await d.signerStatus().catch(() => null);
  out.push({ id: 'signer', group: 'signer', name: 'Signer', ok: signer !== null, lastSuccessAt: seen('signer', signer !== null, now), detail: signer ? (signer.halted ? 'halted' : 'answering') : 'no answer' });
  const db = await sql`select 1`.then(() => true, () => false);
  out.push({ id: 'database', group: 'database', name: 'PostgreSQL', ok: db, lastSuccessAt: seen('database', db, now), detail: db ? 'answering' : 'no answer' });

  const rpc = new Map(d.rpcHealth().map((h) => [h.network, h]));
  for (const n of NETS) {
    const h = rpc.get(n.id), id = `rpc:${n.id}`;
    if (!h) { out.push({ id, group: 'rpc', name: n.name, ok: null, lastSuccessAt: lastOk.get(id) ?? null, detail: 'not checked yet' }); continue; }
    const at = Date.parse(h.checkedAt), up = h.endpoints.filter((e) => e.ok).length;
    // "down" means unreadable: one slow public endpoint out of several is said, but is not an outage
    out.push({ id, group: 'rpc', name: n.name, ok: h.readable, lastSuccessAt: seen(id, h.readable, at), detail: `${up}/${h.endpoints.length} endpoints${h.readable && !h.ok ? ', degraded' : ''}${h.identityVerified ? '' : ', identity not verified'}` });
  }

  // market data: one row per source, from the newest BTC bar it delivered (index scan on one symbol)
  const src = await sql<{ source: string; last: Date }[]>`select source, max(ts) as last from candles where symbol = 'BTC' group by source`.catch(() => []);
  const [mq] = await sql<{ n: number; fresh: number; checked: Date | null }[]>`select count(*)::int as n, (count(*) filter (where fresh))::int as fresh, max(checked_at) as checked from market_quality`.catch(() => []);
  for (const s of src) {
    const id = `market:${s.source}`, age = now - s.last.getTime(), ok = age < 3 * 3_600_000;   // hourly bars: two missed closes
    out.push({ id, group: 'market', name: `Market data · ${s.source}`, ok, lastSuccessAt: seen(id, true, s.last.getTime()), detail: 'newest BTC bar' });
  }
  if (mq && mq.n > 0) {
    const checkedAt = mq.checked?.getTime() ?? 0, running = now - checkedAt < 10 * 60_000;
    out.push({ id: 'market:quality', group: 'market', name: 'Market data · quality', ok: running && mq.fresh * 2 >= mq.n, lastSuccessAt: seen('market:quality', running, checkedAt), detail: `${mq.fresh}/${mq.n} series fresh` });
  }

  // derivatives venues: a venue account being reconciled (or a paper account with exposure) gets an equity snapshot every minute
  const venues = await sql<{ venue: string; network: string; kind: string; active: number; last: Date | null }[]>`
    select a.venue, a.network, 'venue' as kind, (count(*) filter (where a.mode <> 'READ_ONLY'))::int as active, max(e.ts) as last
      from deriv_accounts a left join lateral (select max(ts) as ts from deriv_equity where account_id = a.id) e on true group by a.venue, a.network
    union all
    select a.venue, a.network, 'paper' as kind, (count(*) filter (where jsonb_array_length(a.state->'positions') > 0))::int as active, max(e.ts) as last
      from deriv_paper_accounts a left join lateral (select max(ts) as ts from deriv_equity where account_id = a.id) e on true group by a.venue, a.network`.catch(() => []);
  for (const v of venues) {
    const id = `venue:${v.venue}:${v.network}:${v.kind}`, at = v.last?.getTime() ?? null;
    const ok = v.active > 0 ? at !== null && now - at < 5 * 60_000 : null;
    out.push({ id, group: 'venue', name: `${v.venue} ${v.network}${v.kind === 'paper' ? ' (paper feed)' : ''}`, ok, lastSuccessAt: seen(id, at !== null, at) ?? at,
      detail: v.active > 0 ? 'last equity snapshot' : 'no active account: not measured' });
  }

  // swap providers: the quotes the owner (or an agent) actually asked for
  const quotes = await sql<{ provider: string; last_ok: Date | null; last: Date; ok: boolean }[]>`
    select provider, max(at) filter (where ok) as last_ok, max(at) as last, (array_agg(ok order by at desc))[1] as ok from swap_quotes where at > now() - interval '7 days' group by provider order by provider`.catch(() => []);
  for (const s of quotes) out.push({ id: `swap:${s.provider}`, group: 'swap', name: `Swap · ${s.provider}`, ok: now - s.last.getTime() < 6 * 3_600_000 ? s.ok : null,
    lastSuccessAt: s.last_ok?.getTime() ?? null, detail: now - s.last.getTime() < 6 * 3_600_000 ? 'last quote asked' : 'no recent quote: not measured' });

  // Circle attestation API: only a bridge in flight tells
  const [br] = await sql<{ last: Date | null; waiting: number; overdue: number }[]>`
    select max(updated_at) filter (where bridge->>'message' is not null) as last,
      (count(*) filter (where bridge->>'phase' = 'attesting' and state not in ('failed','rejected','expired')))::int as waiting,
      (count(*) filter (where bridge->>'phase' = 'attesting' and state not in ('failed','rejected','expired') and updated_at < now() - interval '45 minutes'))::int as overdue
    from proposals where kind = 'bridge'`.catch(() => []);
  out.push({ id: 'bridge:circle', group: 'bridge', name: 'Circle attestation (CCTP)', ok: br && br.waiting > 0 ? br.overdue === 0 : null, lastSuccessAt: br?.last?.getTime() ?? null,
    detail: br && br.waiting > 0 ? `${br.waiting} transfer(s) awaiting attestation` : 'no transfer in flight: not measured' });
  return { connectors: out, signer };
}

/** Where scripts/backup.sh writes (SPW_BACKUP_DIR, default ~/backups/sp-wallet). null when the API cannot see such a directory. */
export function lastBackup(dir = process.env.SPW_BACKUP_DIR || join(homedir(), 'backups', 'sp-wallet')): { dir: string; lastAt: number | null; files: number } | null {
  try {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => /^sp-wallet-.*\.sql\.gz$/.test(f));
    let lastAt: number | null = null;
    for (const f of files) { const m = statSync(join(dir, f)).mtimeMs; if (lastAt === null || m > lastAt) lastAt = m; }
    return { dir, lastAt, files: files.length };
  } catch { return null; }
}

export async function diskFree(path = process.env.SPW_DISK_PATH || homedir()): Promise<{ path: string; freePct: number; freeGb: number; totalGb: number } | null> {
  try {
    const s = await statfs(path), total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
    if (!(total > 0)) return null;
    return { path, freePct: Math.round((free / total) * 1000) / 10, freeGb: Math.round(free / 1e8) / 10, totalGb: Math.round(total / 1e8) / 10 };
  } catch { return null; }
}

let auditCache: { at: number; total: number; intact: boolean; brokenAt: number | null } | null = null;
/** Full verification of the hash chain, at most once every `maxAgeMs` (it reads the whole table). */
export async function auditChainStatus(now: number, maxAgeMs = 10 * 60_000): Promise<{ checkedAt: number; total: number; intact: boolean; brokenAt: number | null }> {
  if (!auditCache || now - auditCache.at >= maxAgeMs) {
    const all = await sql<AuditRecord[]>`select seq::int as seq, ts, type, actor, data, prev, hash from audit_events order by seq asc`;
    const brokenAt = verifyAuditChain(all);
    auditCache = { at: now, total: all.length, intact: brokenAt === null, brokenAt };
  }
  return { checkedAt: auditCache.at, total: auditCache.total, intact: auditCache.intact, brokenAt: auditCache.brokenAt };
}
export const resetHealthCaches = (): void => { auditCache = null; lastOk.clear(); };

declare const __SPW_COMMIT__: string | undefined;
const STARTED_AT = Date.now();
/** versions and identifiers only — never a secret */
export function versions(signer: SignerStatus | null): { apiCommit: string | null; apiVersion: string; node: string; startedAt: number; signerKeyId: string | null; signerPolicyVersion: number | null } {
  const commit = (typeof __SPW_COMMIT__ === 'string' && __SPW_COMMIT__) || process.env.SPW_COMMIT || null;
  return { apiCommit: commit, apiVersion: '1.0.0', node: process.version, startedAt: STARTED_AT, signerKeyId: signer?.keyId ?? null, signerPolicyVersion: (signer?.policy as { version?: number } | undefined)?.version ?? null };
}

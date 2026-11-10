import postgres from 'postgres';
import { appendAudit, verifyAuditChain, type AuditRecord } from '@spw/core';
import { config } from './config.ts';

export const sql = postgres(config.databaseUrl, { max: 8, idle_timeout: 30, onnotice: () => {} });

const SCHEMA = `
create table if not exists credentials (
  id text primary key, public_key text not null, counter bigint not null default 0, transports jsonb not null default '[]',
  label text not null default '', device_type text not null default '', backed_up boolean not null default false,
  created_at timestamptz not null default now(), last_used_at timestamptz);
create table if not exists pending_credentials (
  id text primary key, public_key text not null, counter bigint not null, transports jsonb not null, label text not null,
  device_type text not null, backed_up boolean not null, expires_at timestamptz not null);
create table if not exists sessions (
  id_hash text primary key, created_at timestamptz not null default now(), last_seen timestamptz not null default now(),
  expires_at timestamptz not null, ua text not null default '', ip text not null default '', revoked boolean not null default false);
create table if not exists challenges (
  id uuid primary key, kind text not null, challenge text not null, expires_at timestamptz not null);
create table if not exists proposals (
  id uuid primary key, idempotency_key text unique not null, state text not null, version int not null default 0,
  network text not null, asset text not null, symbol text not null, decimals int not null, amount numeric(78,0) not null check (amount > 0),
  from_addr text not null, to_addr text not null, note text not null default '',
  fee_estimate numeric(78,0), max_fee numeric(78,0), warnings jsonb not null default '[]',
  intent jsonb, intent_hash text, raw text, txid text, block_ref text, confirmations int not null default 0, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz, broadcast_at timestamptz, last_broadcast_at timestamptz, finalized_at timestamptz);
create unique index if not exists proposals_txid on proposals (network, txid) where txid is not null;
create table if not exists deposits (
  network text not null, txid text not null, idx int not null, asset text not null, amount numeric(78,0) not null,
  from_addr text not null default '', block bigint not null, block_time timestamptz, seen_at timestamptz not null default now(),
  primary key (network, txid, idx, asset));
create table if not exists scan_cursor (network text primary key, cursor bigint not null, finalized bigint not null default 0);
create table if not exists address_book (
  id uuid primary key, network text not null, address text not null, label text not null, created_at timestamptz not null default now(),
  unique (network, address));
create table if not exists settings (key text primary key, value jsonb not null);
create table if not exists audit_events (
  seq bigint primary key, ts text not null, type text not null, actor text not null, data jsonb not null, prev text not null, hash text not null);
create or replace function spw_audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
drop trigger if exists audit_no_update on audit_events;
create trigger audit_no_update before update or delete or truncate on audit_events for each statement execute function spw_audit_immutable();
`;

export async function migrate(): Promise<void> { await sql.unsafe(SCHEMA); }

let auditLock: Promise<unknown> = Promise.resolve();
/** Append to the tamper-evident hash chain. Never pass secrets or assertion payloads here. */
export function audit(type: string, actor: string, data: Record<string, unknown> = {}): Promise<void> {
  const run = async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7707001)`;
      const [last] = await tx<AuditRecord[]>`select seq::int as seq, ts, type, actor, data, prev, hash from audit_events order by seq desc limit 1`;
      const rec = appendAudit(last ?? null, type, actor, data);
      await tx`insert into audit_events (seq, ts, type, actor, data, prev, hash) values (${rec.seq}, ${rec.ts}, ${rec.type}, ${rec.actor}, ${tx.json(rec.data as never)}, ${rec.prev}, ${rec.hash})`;
    });
  };
  const p = auditLock.then(run, run);
  auditLock = p.catch(() => {});
  return p;
}

export async function auditList(limit: number): Promise<{ events: AuditRecord[]; intact: boolean; brokenAt: number | null; total: number }> {
  const all = await sql<AuditRecord[]>`select seq::int as seq, ts, type, actor, data, prev, hash from audit_events order by seq asc`;
  const brokenAt = verifyAuditChain(all);
  return { events: all.slice(-limit).reverse(), intact: brokenAt === null, brokenAt, total: all.length };
}

export async function getSetting<T>(key: string, dflt: T): Promise<T> {
  const [r] = await sql<{ value: T }[]>`select value from settings where key = ${key}`;
  return r ? r.value : dflt;
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (key, value) values (${key}, ${sql.json(value as never)}) on conflict (key) do update set value = excluded.value`;
}

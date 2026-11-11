// Shared fixtures of the alerts and monitoring tests: an own database, a scripted clock and dependencies, row builders.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlertDispatcher, DispatcherDeps } from '../src/alerts/dispatcher.ts';
import type { SignerStatus } from '../src/signer-client.ts';
import { useDatabase } from './derivatives-helpers.ts';

export interface World {
  sql: any; db: typeof import('../src/db.ts'); store: typeof import('../src/alerts/store.ts'); mod: typeof import('../src/alerts/dispatcher.ts');
  clock: { t: number; advance(ms: number): number };
  /** scripted environment read by the condition rules */
  env: { signer: SignerStatus | null; rpc: any[]; loops: any[]; backup: { dir: string; lastAt: number | null; files: number } | null; disk: { path: string; freePct: number; freeGb: number; totalGb: number } | null;
    fetch: typeof fetch; fault: DispatcherDeps['fault'] };
  dispatcher(o?: Partial<DispatcherDeps>): AlertDispatcher;
  alerts(where?: string): Promise<any[]>;
}

export const SIGNER_OK = { keyId: 'key-1', addresses: {}, halted: false, enrollmentOpen: false, credentials: [], policy: { version: 3, perTx: {}, daily: {} }, spentToday: {}, journalHead: null, journalLength: 0 } as unknown as SignerStatus;

export async function world(dbName: string): Promise<World> {
  await useDatabase(dbName);
  process.env.SPW_DATA_DIR = mkdtempSync(join(tmpdir(), 'spw-alerts-'));
  const db = await import('../src/db.ts');
  await db.sql.unsafe('drop schema public cascade; create schema public;');
  await db.migrate();
  const store = await import('../src/alerts/store.ts'), mod = await import('../src/alerts/dispatcher.ts');
  await store.migrateAlerts(true);
  const clock = { t: Date.now(), advance(ms: number) { this.t += ms; return this.t; } };
  const env: World['env'] = { signer: SIGNER_OK, rpc: [], loops: [], backup: null, disk: null, fetch: (async () => new Response(null, { status: 201 })) as typeof fetch, fault: undefined };
  const dispatcher = (o: Partial<DispatcherDeps> = {}) => new mod.AlertDispatcher({
    now: () => clock.t, fetch: ((...a: Parameters<typeof fetch>) => env.fetch(...a)) as typeof fetch, origin: 'https://wallet.test', settleMs: -1e12 /* the scripted clock is behind the audit rows' real timestamps */, allowHttpWebhook: true,
    signerStatus: async () => env.signer, rpcHealth: () => env.rpc, loops: () => env.loops, backup: () => env.backup, disk: async () => env.disk, fault: (s, src) => env.fault?.(s, src), ...o });
  const alerts = (where = 'true') => db.sql.unsafe(`select * from alerts where ${where} order by id`) as Promise<any[]>;
  return { sql: db.sql, db, store, mod, clock, env, dispatcher, alerts };
}

export async function addAgent(sql: any, o: { name?: string; state?: string; interval?: string; lastBar?: Date | null; mandate?: unknown; mandateId?: string | null; capital?: string; cash?: string; universe?: string[] } = {}): Promise<string> {
  const id = randomUUID();
  const [n] = await sql`select coalesce(max(vault_index), 0) + 1 as n from agents`;
  await sql`insert into agents (id, name, state, interval, universe, risk, vault_index, vault_address, last_bar, mandate, mandate_id, capital_usdc, cash)
    values (${id}, ${o.name ?? 'Momentum'}, ${o.state ?? 'PAPER_TRADING'}, ${o.interval ?? '1h'}, ${sql.json(o.universe ?? ['BTC', 'ETH'])}, ${sql.json({})}, ${n.n}, ${'0x' + id.replace(/-/g, '').padEnd(40, '0').slice(0, 40)},
      ${o.lastBar ?? null}, ${o.mandate ? sql.json(o.mandate) : null}, ${o.mandateId ?? null}, ${o.capital ?? '1000000000'}, ${o.cash ?? 'USDC'})`;
  return id;
}
export async function addProposal(sql: any, o: { kind?: string; state?: string; network?: string; symbol?: string; decimals?: number; amount?: string; createdAt?: Date; swap?: unknown; bridge?: unknown; error?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await sql`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, kind, swap, bridge, error, created_at)
    values (${id}, ${id}, ${o.state ?? 'finalized'}, ${o.network ?? 'base'}, 'native', ${o.symbol ?? 'USDC'}, ${o.decimals ?? 6}, ${o.amount ?? '25000000'}, '0xfrom', '0xto', ${o.kind ?? 'transfer'},
      ${o.swap ? sql.json(o.swap) : null}, ${o.bridge ? sql.json(o.bridge) : null}, ${o.error ?? null}, ${o.createdAt ?? new Date()})`;
  return id;
}
export async function addPaperAccount(sql: any, o: { label?: string; positions?: unknown[]; collateral?: string } = {}): Promise<string> {
  const id = randomUUID();
  await sql`insert into deriv_paper_accounts (id, venue, network, label, initial_collateral, state, policy) values (${id}, 'hyperliquid', 'mainnet', ${o.label ?? 'Paper HL'}, 10000,
    ${sql.json({ positions: o.positions ?? [], collateral: o.collateral ?? '10000' })}, ${sql.json({ halt: null })})`;
  return id;
}
export async function addVenueAccount(sql: any, o: { label?: string; network?: string; mode?: string; meta?: unknown } = {}): Promise<string> {
  const id = randomUUID();
  await sql`insert into deriv_accounts (id, venue, network, account, agent_address, label, mode, policy, meta) values (${id}, 'hyperliquid', ${o.network ?? 'mainnet'}, ${'0x' + id.replace(/-/g, '').slice(0, 40).padEnd(40, '0')}, '0xagent',
    ${o.label ?? 'HL main'}, ${o.mode ?? 'MANUAL_LIVE'}, ${sql.json({})}, ${sql.json(o.meta ?? {})})`;
  return id;
}
export const riskEvent = (sql: any, account: string, kind: string, code: string | null, message: string, ts = new Date(), dedupe: string | null = null) =>
  sql`insert into deriv_risk_events (account_id, ts, kind, code, message, data, dedupe) values (${account}, ${ts}, ${kind}, ${code}, ${message}, '{}', ${dedupe}) returning id`;
/** a session row and the cookie that carries it: the alerts endpoints are tested as the signed-in owner without the passkey ceremony */
export async function ownerCookie(sql: any, ua = 'Mozilla/5.0 (iPhone) Safari/605'): Promise<string> {
  const { createHash, randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at, ua, ip) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour', ${ua}, '203.0.113.7')`;
  return `__Host-spw=${token}`;
}

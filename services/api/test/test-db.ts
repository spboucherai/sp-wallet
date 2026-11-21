/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/test-db.ts
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

// V8 hardening (test isolation) — ONE helper for every test file that needs PostgreSQL.
//
// Before: each file used a fixed database name (spw_test, spw_market_test, spw_v6_alerts_api_test…). Two checkouts running
// the suite at the same time (several worktrees, several engineers, CI next to a developer) shared those databases and
// corrupted each other: random failures in market-store, api, agent-networks and the alerts tests.
//
// Now: a database name is unique per CHECKOUT and per RUN and per test file:
//
//     spw_t_<start, seconds, base 36>_<4 hex of sha256(repository path)><4 random hex>_<label>
//
// The run id is created once by vitest's global setup (services/api/test/global-db.ts), which also drops every database of the
// run when it ends — whatever happened in the test files (a crash, a timeout, a forgotten teardown). A test file run without
// that global setup makes its own run id; `scripts/clean-test-dbs.sh` removes what such runs (or a killed vitest) leave
// behind: the start time in the name tells how old a database is.
//
// Cost: `create database` is ~40 ms on a local PostgreSQL 17; a suite of ~20 database files pays under two seconds.
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export const TEST_DB_PREFIX = 'spw_t_';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** `<start seconds, base 36>_<checkout hash><random>`: sortable by age, distinct between checkouts and between runs */
export const newRunId = (): string => `${Math.floor(Date.now() / 1000).toString(36)}_${createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 4)}${randomBytes(2).toString('hex')}`;
let ownRun: string | null = null;
export const runId = (): string => process.env.SPW_TEST_RUN || (ownRun ??= newRunId());
const ADMIN_URL = (): string => process.env.SPW_TEST_ADMIN_URL ?? 'postgres:///postgres';

export function testDbName(label: string): string {
  if (!/^[a-z0-9_]{1,30}$/.test(label)) throw new Error(`test database label must be [a-z0-9_]{1,30}: ${label}`);
  return `${TEST_DB_PREFIX}${runId()}_${label}`;
}

export interface TestDb { name: string; url: string; drop(): Promise<void> }
/** Create an empty database for this test file and return its URL. Call BEFORE importing anything from src/ (the API reads
 *  DATABASE_URL when its modules load). `drop()` is optional — the global teardown drops it too — but frees it earlier. */
export async function createTestDb(label: string): Promise<TestDb> {
  const name = testDbName(label), admin = postgres(ADMIN_URL(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally { await admin.end(); }
  return { name, url: `postgres:///${name}`, drop: () => dropTestDbs((n) => n === name).then(() => {}) };
}

/** Drop the test databases whose name is accepted by `match` (connections are terminated). Returns the names dropped. */
export async function dropTestDbs(match: (name: string) => boolean): Promise<string[]> {
  const admin = postgres(ADMIN_URL(), { max: 1, onnotice: () => {} }), dropped: string[] = [];
  try {
    const rows = await admin<{ datname: string }[]>`select datname from pg_database where datname like ${TEST_DB_PREFIX.replace(/_/g, '\\_') + '%'}`;
    for (const { datname } of rows) {
      if (!/^spw_t_[a-z0-9_]+$/.test(datname) || !match(datname)) continue;
      try { await admin.unsafe(`drop database if exists ${datname} with (force)`); dropped.push(datname); } catch { /* still being created or already gone */ }
    }
  } finally { await admin.end(); }
  return dropped;
}

/** The environment every API test sets before importing src/: an own database and inert defaults (no broadcast, no workers,
 *  a signer URL that answers nothing). `extra` overrides. Returns the database. */
export async function useTestDatabase(label: string, extra: Record<string, string> = {}): Promise<TestDb> {
  const db = await createTestDb(label);
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: db.url, SPW_SIGNER_SECRET: 'k'.repeat(48),
    SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off', ...extra });
  return db;
}

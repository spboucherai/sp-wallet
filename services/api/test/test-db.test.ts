/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/test-db.test.ts
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

// V8 hardening (C): the shared test-database helper. Names are unique per checkout and per run; a database is created empty
// and dropped again; nothing but spw_t_* databases can ever be dropped by it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createTestDb, dropTestDbs, newRunId, REPO_ROOT, runId, TEST_DB_PREFIX, testDbName } from './test-db.ts';

describe('test databases', () => {
  it('a name carries the run id (start time, checkout hash, random) and the label; two runs never share one', () => {
    expect(process.env.SPW_TEST_RUN, 'vitest global setup sets the run id').toMatch(/^[0-9a-z]+_[0-9a-f]{8}$/);
    expect(runId()).toBe(process.env.SPW_TEST_RUN);
    expect(testDbName('api')).toBe(`${TEST_DB_PREFIX}${process.env.SPW_TEST_RUN}_api`);
    const a = newRunId(), b = newRunId();
    expect(a).not.toBe(b);
    expect(a.split('_')[1]!.slice(0, 4)).toBe(b.split('_')[1]!.slice(0, 4));   // same checkout: same path hash
    expect(testDbName('x'.repeat(30)).length).toBeLessThanOrEqual(63);          // PostgreSQL's identifier limit
    for (const bad of ['', 'UPPER', 'a-b', 'a b', 'x'.repeat(31), 'a;drop']) expect(() => testDbName(bad), bad).toThrow(/label/);
  });

  it('creates an empty database, drops it, and never matches a database outside the prefix', async () => {
    const db = await createTestDb('helper_selftest'), sql = postgres(db.url, { max: 1, onnotice: () => {} });
    expect((await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)[0]!.n).toBe(0);
    await sql`create table t (x int)`; await sql.end();
    const again = await createTestDb('helper_selftest'), sql2 = postgres(again.url, { max: 1, onnotice: () => {} });   // same label: recreated empty
    expect((await sql2`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)[0]!.n).toBe(0);
    await sql2.end();
    await db.drop();
    const admin = postgres('postgres:///postgres', { max: 1, onnotice: () => {} });
    expect(await admin`select 1 from pg_database where datname = ${db.name}`).toHaveLength(0);
    await admin.end();
    const seen: string[] = [];
    await dropTestDbs((n) => { seen.push(n); return false; });
    for (const n of seen) expect(n.startsWith(TEST_DB_PREFIX)).toBe(true);
  }, 180_000);

  // v10 integration: the convention is CHECKED, so a test file merged from another branch cannot bring a fixed name back
  // (bridge-sol.test.ts and derivatives-gmx.test.ts arrived from `main` with spw_test_cctp_sol / spw_deriv_gmx_test).
  it('no test file of the vitest suite names a database itself: every one comes from this helper', () => {
    const files: string[] = [];
    const walk = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'fixtures') continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|mts)$/.test(e.name)) files.push(p); } };
    for (const group of ['packages', 'services', 'apps']) for (const pkg of readdirSync(path.join(REPO_ROOT, group), { withFileTypes: true })) {
      const dir = path.join(REPO_ROOT, group, pkg.name, 'test'); try { walk(dir); } catch { /* a package without tests */ }
    }
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(REPO_ROOT, f); if (rel === 'services/api/test/test-db.ts' || rel === 'services/api/test/test-db.test.ts') continue;
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');   // comments may still tell the history
      // a literal database name in a URL (not the placeholder of files that never query, not a name interpolated from the helper), a database created or dropped by hand, an admin connection, a legacy name
      for (const m of code.matchAll(/postgres(?:ql)?:\/\/\/?([A-Za-z0-9_$\{\}.:@-]*)/g)) if (/^[A-Za-z0-9_]+$/.test(m[1]!) && m[1] !== 'unused') offenders.push(`${rel}: ${m[0]}`);
      if (/create database|drop database|\bcreatedb\b|\bdropdb\b/i.test(code)) offenders.push(`${rel}: creates or drops a database itself`);
      for (const m of code.matchAll(/['"`](spw_[a-z0-9_]*test[a-z0-9_]*)['"`]/g)) offenders.push(`${rel}: fixed name ${m[1]}`);
      for (const m of code.matchAll(/\b(?:useDatabase|useTestDatabase|createTestDb|testDbName|alertsWorld)\(\s*['"`]([^'"`]*)['"`]/g)) if (/^spw_|_test$/.test(m[1]!)) offenders.push(`${rel}: label ${m[1]} looks like a fixed database name`);
    }
    expect(offenders).toEqual([]);
  });
});

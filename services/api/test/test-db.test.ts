// V8 hardening (C): the shared test-database helper. Names are unique per checkout and per run; a database is created empty
// and dropped again; nothing but spw_t_* databases can ever be dropped by it.
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createTestDb, dropTestDbs, newRunId, runId, TEST_DB_PREFIX, testDbName } from './test-db.ts';

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
});

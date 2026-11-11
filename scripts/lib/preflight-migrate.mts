// scripts/preflight.sh --db: run the release's migrate() twice on the scratch database named by DATABASE_URL (a copy of the
// production SCHEMA, no rows) and say what changed. Refuses any database that is not a preflight scratch database.
const url = process.env.DATABASE_URL ?? '';
if (!/^postgres:\/\/\/spw_preflight_\d+_\d+$/.test(url)) { console.error('preflight-migrate only runs on a spw_preflight_* scratch database'); process.exit(2); }
const { migrate, sql } = await import('../../services/api/src/db.ts');
const shape = async (): Promise<{ tables: number; columns: number; indexes: number }> => {
  const [t] = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
  const [c] = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.columns where table_schema = 'public'`;
  const [i] = await sql<{ n: number }[]>`select count(*)::int as n from pg_indexes where schemaname = 'public'`;
  return { tables: t!.n, columns: c!.n, indexes: i!.n };
};
try {
  const before = await shape();
  await migrate(); const first = await shape();
  await migrate(); const second = await shape();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error(`the second migrate() changed the schema again (${JSON.stringify(first)} → ${JSON.stringify(second)}): not idempotent`);
  console.log(`${first.tables - before.tables} new table(s), ${first.columns - before.columns} new column(s), ${first.indexes - before.indexes} new index(es); the second run changed nothing`);
  await sql.end(); process.exit(0);
} catch (e) { console.error((e as Error).message); await sql.end().catch(() => {}); process.exit(1); }

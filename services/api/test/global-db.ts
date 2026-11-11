// vitest global setup (see vitest.config.ts): one run id for the whole run — every test file derives its database name from
// it (test-db.ts) — and, when the run ends, every database of THIS run is dropped. Nothing is created here:
// a run that touches no database costs nothing, and a machine without PostgreSQL still runs the other tests.
import { dropTestDbs, newRunId, TEST_DB_PREFIX } from './test-db.ts';

export default function setup(): () => Promise<void> {
  const run = newRunId();
  process.env.SPW_TEST_RUN = run;
  return async () => {
    try { await dropTestDbs((name) => name.startsWith(`${TEST_DB_PREFIX}${run}_`)); } catch { /* no PostgreSQL on this machine: nothing was created either */ }
  };
}

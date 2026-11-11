import { defineConfig } from 'vitest/config';
// globalSetup: one run id for the whole run; every database test file derives a unique database name from it and all of
// them are dropped when the run ends (services/api/test/test-db.ts) — checkouts running the suite at the same time share nothing.
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'], testTimeout: 30000,
  // hooks create a database each (`create database` is serialized by PostgreSQL): with several suites running at the same time
  // on one machine a set-up can wait far longer than vitest's default 10 s
  hookTimeout: 180_000, globalSetup: ['services/api/test/global-db.ts'] } });

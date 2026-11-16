// Environment of the DATABASE-LESS agent tests: src/config.ts needs these names to exist when a module that imports the database
// client is loaded (no connection is opened until a query runs, and these tests run none). Imported FIRST by such a test file.
Object.assign(process.env, { SPW_ORIGIN: process.env.SPW_ORIGIN ?? 'https://wallet.test', SPW_RP_ID: process.env.SPW_RP_ID ?? 'wallet.test', DATABASE_URL: process.env.DATABASE_URL ?? 'postgres:///spw_no_database_in_unit_tests',
  SPW_SIGNER_SECRET: process.env.SPW_SIGNER_SECRET ?? 'k'.repeat(48), SPW_SIGNER_URL: process.env.SPW_SIGNER_URL ?? 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
export {};

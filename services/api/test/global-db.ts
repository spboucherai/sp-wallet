/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/global-db.ts
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

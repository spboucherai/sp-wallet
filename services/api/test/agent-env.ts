/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/agent-env.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Environment of the DATABASE-LESS agent tests: src/config.ts needs these names to exist when a module that imports the database
// client is loaded (no connection is opened until a query runs, and these tests run none). Imported FIRST by such a test file.
Object.assign(process.env, { SPW_ORIGIN: process.env.SPW_ORIGIN ?? 'https://wallet.test', SPW_RP_ID: process.env.SPW_RP_ID ?? 'wallet.test', DATABASE_URL: process.env.DATABASE_URL ?? 'postgres:///unused',
  SPW_SIGNER_SECRET: process.env.SPW_SIGNER_SECRET ?? 'k'.repeat(48), SPW_SIGNER_URL: process.env.SPW_SIGNER_URL ?? 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
export {};

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/wallet-api/index.ts
 * Module           : wallet-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — the routes the wallet contract added (analytics, universal search). The contract itself is spec.ts; the routes it
// describes live where they always did (server.ts, transfers.ts, prefs.ts, events.ts, alerts/, dashboard/).
import type { FastifyInstance } from 'fastify';
import type { Currency } from '../portfolio.ts';
import { analyticsRoutes } from './analytics.ts';
import { buildWalletOpenApi } from './openapi.ts';
import { searchRoutes } from './search.ts';

export function walletApiRoutes(app: FastifyInstance, deps: { currency: () => Promise<Currency> }): void {
  // the contract itself, as built into this server (the bytes of docs/openapi/wallet-v1.json): owner session, like every route
  let doc: ReturnType<typeof buildWalletOpenApi> | null = null;
  app.get('/api/v1/openapi.json', async () => (doc ??= buildWalletOpenApi()));
  analyticsRoutes(app, deps);
  searchRoutes(app);
}
export { contactLabeler, csvCell, NO_CONTROL } from './labels.ts';
export { controlIssue, validationFields } from './validation.ts';

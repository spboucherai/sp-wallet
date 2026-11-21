/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/dashboard/index.ts
 * Module           : dashboard
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
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

// V11 interface — /api/v1/dashboard: small READ-ONLY aggregates for the Dashboard and Activity screens. Nothing here holds
// business logic: every figure is read from an existing service (portfolio, risk service, unified orders, agents, monitor,
// audit chain) and each source fails on its own — a source that cannot be read is answered as
// `{ ok: false, error: { code, message } }` and the others are still answered.
// Owner session only: the prefix is outside /api/v1/trading, so the gate of server.ts refuses an API key (`key_path_forbidden`).
import type { FastifyInstance } from 'fastify';
import type { Execution } from '../orders/index.ts';
import { registerDashboardActivity } from './activity.ts';
import { registerDashboardStatus } from './status.ts';
import { registerDashboardSummary } from './summary.ts';

export interface DashboardOpts { execution: Execution }
export const DASHBOARD_PREFIX = '/api/v1/dashboard';
export function dashboardRoutes(app: FastifyInstance, opts: DashboardOpts): void {
  registerDashboardStatus(app, opts);
  registerDashboardSummary(app, opts);
  registerDashboardActivity(app, opts);
}

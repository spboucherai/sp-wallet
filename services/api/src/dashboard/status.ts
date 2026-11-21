/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/dashboard/status.ts
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

// GET /api/v1/dashboard/status — what the shell shows on EVERY screen (the risk indicator of the header): the two global
// switches of the risk engine and whether the owner's live limits are complete. Two settings reads of the risk service;
// no venue is read, no exposure is computed (that is /api/v1/risk/state, asked by the Risk screen only).
// Each of the two sources fails on its own, like the other /dashboard routes.
import type { FastifyInstance } from 'fastify';
import { UserError } from '../config.ts';
import type { DashboardOpts } from './index.ts';
import { section } from './summary.ts';

export function registerDashboardStatus(app: FastifyInstance, { execution }: DashboardOpts): void {
  app.get('/api/v1/dashboard/status', async (req) => {
    if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route is for the owner\'s session', 403);
    const { risk } = execution;
    const [switches, limits] = await Promise.all([
      section(async () => { const s = await risk.switches(); return { killSwitch: { on: s.killSwitch.on, at: s.killSwitch.at }, readOnly: { on: s.readOnly.on, at: s.readOnly.at } }; }),
      section(async () => { const l = await risk.limits('live'); return { missing: l.missing.length, ownerOrdersRefused: l.ownerOrdersRefused ?? false, automationOrdersRefused: l.automationOrdersRefused ?? false }; }),
    ]);
    return { ts: Date.now(), switches, liveLimits: limits };
  });
}

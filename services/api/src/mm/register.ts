/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/register.ts
 * Module           : mm
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

// One call from server.ts: the owner's market-making routes on the execution layer of this server instance.
import type { FastifyInstance } from 'fastify';
import { agentRuntime } from '../agents/runtime-bindings.ts';
import type { Execution } from '../orders/index.ts';
import { standaloneMm } from './bind.ts';
import { mmRoutes } from './routes.ts';
import type { MmRuntime } from './runtime.ts';

export function registerMm(app: FastifyInstance, ex: Execution): void {
  let own: MmRuntime | null = null;
  app.addHook('onClose', async () => { own?.close(); });
  mmRoutes(app, { execution: ex, now: () => ex.risk.now(), local: () => agentRuntime()?.stream?.mm ?? null, emergency: () => (own ??= standaloneMm(ex)) });
}

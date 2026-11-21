/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/index.ts
 * Module           : trading-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-17
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

// SP Trading API (V11) — the one entry point used by server.ts.
//
//   tradingApi(app, deps)     decorates the request with `principal`, installs the single scope guard (preHandler), the usage
//                             log (onResponse) and the webhook event sources, then registers /api/v1/trading/* and /api/v1/developer/*
//   apiKeyGate, OWNER         the onRequest branch of server.ts
//
// Integrators (execution wave): replace a `notWired` handler in routes.ts; read `req.principal` (principal.ts); keep the
// handler inside `withIdempotency` (idempotency.ts); `requireMandate` already ran; emit `order.updated` / `agent.updated`
// with `emitWebhook` (webhooks.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { sql } from '../db.ts';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import type { LiveService } from '../derivatives/exec.ts';
import type { GmxService } from '../derivatives/gmx-exec.ts';
import { live } from '../derivatives/live.ts';
import { developerRoutes } from './developer-routes.ts';
import { recordUsage, scopeGuard } from './principal.ts';
import { createReads, type ReadDeps } from './read.ts';
import { tradingRoutes } from './routes.ts';
import { setMandateVerifier } from './keys.ts';
import { emitWebhook, startWebhookWorker } from './webhooks.ts';

export { apiKeyGate, OWNER, actorOf, scopeGuard, type Principal, type ApiKeyPrincipal, type OwnerPrincipal } from './principal.ts';
export { withIdempotency, replayHeaders } from './idempotency.ts';
export { requireMandate } from './routes.ts';
export { emitWebhook } from './webhooks.ts';
export { TRADING_PREFIX, DEVELOPER_PREFIX, SCOPES, EXECUTION_SCOPES, OPERATIONS, type Scope } from './spec.ts';

import { createNftReads, type NftReadDeps } from './nft-read.ts';

export interface TradingApiDeps {
  derivatives?: Derivatives; live?: LiveService; gmx?: Pick<GmxService, 'status'>;
  prices: ReadDeps['prices']; library?: ReadDeps['library'];
  /** the order service, the risk service and the mandates of this server (orders/index.ts) */
  execution: import('../orders/index.ts').Execution;
}

/** owner actions that already exist and are event sources: seen at the HTTP layer (like the alerts hook), without a call inside their code */
const AGENT_ROUTES = new Set(['/api/v1/agents/:id/mode', '/api/v1/agents/:id/mandate/approve', '/api/v1/agents/:id/revoke',
  '/api/v1/agents/:id/perp/live/approve', '/api/v1/agents/:id/perp/live/pause', '/api/v1/agents/:id/perp/live/resume', '/api/v1/agents/:id/perp/live/stop']);
async function eventSources(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.method !== 'POST' || reply.statusCode !== 200) return;
  const route = req.routeOptions.url;
  if (route === '/api/v1/security/emergency-halt') { await emitWebhook('risk.kill_switch', { source: 'signer', halted: true }); return; }
  if (route && AGENT_ROUTES.has(route)) {
    const id = (req.params as { id?: string }).id;
    const [a] = id ? await sql`select id, kind, state, mode from agents where id = ${id}`.catch(() => []) : [];
    if (a) await emitWebhook('agent.updated', { agentId: a.id, kind: a.kind ?? 'spot', state: a.state, mode: a.mode });
  }
}

export async function tradingApi(app: FastifyInstance, o: TradingApiDeps): Promise<void> {
  app.decorateRequest('principal', null);
  app.decorateRequest('spwKeyAttempt', null);
  app.decorateRequest('spwRequestId', null);
  app.addHook('preHandler', scopeGuard);
  app.addHook('onResponse', recordUsage);
  app.addHook('onResponse', eventSources);
  const d = (): Derivatives => o.derivatives ?? derivatives();
  const reads = createReads({
    derivatives: d, live: () => o.live ?? live(),
    gmx: () => o.gmx ?? { status: async (locale) => (await import('../derivatives/gmx-live.ts')).gmx().status(locale) },
    orders: () => o.execution.orders, prices: o.prices, ...(o.library ? { library: o.library } : {}),
  });
  // the NFT module registers after this one: its services are read when a request comes (null = NFT_ENABLED=off)
  const nfts = createNftReads({ nft: () => (app as unknown as { nftMarket?: ReturnType<NftReadDeps['nft']> }).nftMarket ?? null });
  tradingRoutes(app, reads, o.execution, nfts);
  developerRoutes(app, { derivatives: d });
  setMandateVerifier((keyId, mandateId) => o.execution.mandates.verifyKeyBinding(keyId, mandateId));
  if (config.workers) { const stop = startWebhookWorker(); app.addHook('onClose', async () => { stop(); }); }
}

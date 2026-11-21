/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/collateral-routes.ts
 * Module           : derivatives
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

// Routes of the collateral path — all under /api/v1/derivatives/live/accounts/:id/collateral/…  (the read-only
// GET …/collateral of live-routes.ts is unchanged). Authentication and CSRF are the global hook of server.ts. Nothing here
// holds a key or judges a passkey: assertions go to the isolated signer untouched. Shapes: docs/v4/API-LIVE-NOTES.md.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AmountBodySchema, collateral, CollateralAssertionSchema, type CollateralService } from './collateral.ts';
import { venueFailure } from './data.ts';

const P = '/api/v1/derivatives/live/accounts/:id/collateral';

export function collateralRoutes(app: FastifyInstance, given?: CollateralService): void {
  const svc = async (): Promise<CollateralService> => given ?? collateral();
  const id = (req: FastifyRequest): string => z.uuid().parse((req.params as { id: string }).id);
  const op = (req: FastifyRequest): string => z.uuid().parse((req.params as { opId: string }).opId);
  const run = <T>(fn: (s: CollateralService, req: FastifyRequest, reply: FastifyReply) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply): Promise<T> => { try { return await fn(await svc(), req, reply); } catch (e) { throw venueFailure(e); } };

  // venue balance, route facts (bridge, minimum, time), wallet side (USDC and gas on the deposit network, USDC elsewhere, limits), operations
  app.get(`${P}/status`, run(async (s, req) => s.status(id(req))));
  app.get(`${P}/operations/:opId`, run(async (s, req) => s.operation(id(req), op(req))));
  // deposit: prepare (guards, liveness, intent with the venueDeposit section, WebAuthn request over the intent hash) → approve (assertion)
  app.post(`${P}/deposit/prepare`, run(async (s, req) => s.prepareDeposit(id(req), AmountBodySchema.parse(req.body))));
  app.post(`${P}/deposit/:opId/approve`, run(async (s, req) => s.approveDeposit(id(req), op(req), CollateralAssertionSchema.parse(req.body).assertion)));
  // withdrawal: prepare (canonical withdrawal, WebAuthn request over its hash) → approve (assertion) → the venue
  app.post(`${P}/withdraw/prepare`, run(async (s, req) => s.prepareWithdraw(id(req), AmountBodySchema.parse(req.body))));
  app.post(`${P}/withdraw/:opId/approve`, run(async (s, req) => s.approveWithdraw(id(req), op(req), CollateralAssertionSchema.parse(req.body).assertion)));
  // before the passkey only
  app.post(`${P}/operations/:opId/cancel`, run(async (s, req) => s.cancel(id(req), op(req))));
}

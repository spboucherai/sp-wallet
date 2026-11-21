/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/private-markets/routes.ts
 * Module           : private-markets
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

// Routes of the Private Markets module (owner session; the global hook of server.ts authenticates). Read-only: three GETs.
// The same answers are served to API keys under /api/v1/trading/private-markets… (scope `markets:read`, trading-api/spec.ts).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import { privateMarketsFor, type PositionInput } from './service.ts';

const P = '/api/v1/private-markets';
const Size = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/).refine((x) => /[1-9]/.test(x), 'must be positive');
/** `delisted=true` lists ONLY delisted markets; `size`/`side` = the hypothetical position of the exposure figure */
export const PrivateMarketsQuery = z.object({ delisted: z.enum(['true', 'false']).optional(), size: Size.optional(), side: z.enum(['long', 'short']).optional() });
export const PrivateMarketDetailQuery = PrivateMarketsQuery.omit({ delisted: true }).extend({ interval: z.enum(['1h', '1d']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
export const PrivateMarketId = z.string().min(3).max(120).regex(/^[a-z]+:[A-Za-z0-9:._-]+$/);
export const CompanySlug = z.string().regex(/^[a-z0-9-]{1,40}$/);
export function positionOf(q: { size?: string | undefined; side?: 'long' | 'short' | undefined }): PositionInput | undefined {
  if (q.size === undefined && q.side === undefined) return undefined;
  const size = q.size ?? '1';
  if (!/[1-9]/.test(size)) throw new z.ZodError([{ code: 'custom', message: 'size must be positive', path: ['size'], input: size }]);
  return { side: q.side ?? 'long', size };
}

export function privateMarketsRoutes(app: FastifyInstance, d: Derivatives = derivatives()): void {
  const pm = privateMarketsFor(d);
  app.get(P, async (req) => { const q = PrivateMarketsQuery.parse(req.query), position = positionOf(q); return pm.list({ delisted: q.delisted === 'true', ...(position ? { position } : {}) }); });
  app.get(`${P}/companies/:slug`, async (req) => {
    const slug = CompanySlug.parse((req.params as { slug: string }).slug), position = positionOf(PrivateMarketDetailQuery.parse(req.query));
    return pm.company(slug, position ? { position } : {});
  });
  app.get(`${P}/:id`, async (req) => {
    const id = PrivateMarketId.parse((req.params as { id: string }).id), q = PrivateMarketDetailQuery.parse(req.query), position = positionOf(q);
    return pm.detail(id, { ...(position ? { position } : {}), ...(q.interval ? { interval: q.interval } : {}), ...(q.limit ? { limit: q.limit } : {}) });
  });
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/markets-hub/routes.ts
 * Module           : markets-hub
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

// Routes of the markets hub (V11): the universal explorer and the venue comparator. READ-ONLY public market data.
// Authentication is the global hook of server.ts (owner session); the trading API exposes the comparator to scoped keys under
// /api/v1/trading/markets/compare with the same query schema (`CompareQuerySchema`).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INSTRUMENT_CATEGORIES } from '@spw/derivatives';
import type { MarketsHub } from './hub.ts';
import { CompareQuerySchema, HUB_SORTS, toCompareQuery, UnderlyingSchema } from './schema.ts';
import type { CompareService } from './compare.ts';

export const HUB_PREFIX = '/api/v1/markets-hub';
const ListQuery = z.object({
  kind: z.enum(['spot', 'perp']).optional(), venue: z.string().max(40).optional(), category: z.enum(INSTRUMENT_CATEGORIES).optional(), q: z.string().max(40).optional(),
  tradable: z.enum(['yes', 'no']).optional(), sort: z.enum(HUB_SORTS).default('volume'), dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export function marketsHubRoutes(app: FastifyInstance, hub: MarketsHub, compare: CompareService): void {
  app.get(HUB_PREFIX, async (req) => hub.list(ListQuery.parse(req.query)));
  app.get(`${HUB_PREFIX}/underlyings`, async () => hub.underlyings());
  app.get(`${HUB_PREFIX}/underlyings/:symbol`, async (req) => hub.underlying(UnderlyingSchema.parse((req.params as { symbol: string }).symbol)));
  app.get(`${HUB_PREFIX}/compare`, async (req) => compare.compare(toCompareQuery(CompareQuerySchema.parse(req.query))));
}

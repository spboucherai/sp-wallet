/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/markets-hub/index.ts
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

// Markets hub (V11) — the universal Markets explorer and the venue Comparator. READ-ONLY public market data.
//
//   marketsHub(app, { derivatives })   registers GET /api/v1/markets-hub, /underlyings, /underlyings/:symbol, /compare
//   hubFor(derivatives)                the hub and the comparator over a derivatives instance (one pair per instance:
//                                      the owner routes and the trading API share the caches)
//   createListing                      the unified market listing also served by GET /api/v1/trading/markets
import type { FastifyInstance } from 'fastify';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import { CompareService } from './compare.ts';
import { MarketsHub, type SpotPort } from './hub.ts';
import { marketsHubRoutes } from './routes.ts';

export interface HubServices { hub: MarketsHub; compare: CompareService }
const shared = new WeakMap<Derivatives, HubServices>();
/** one hub per derivatives instance (the process-wide one in production; a fixture-backed one in tests) */
export function hubFor(d: Derivatives = derivatives(), o: { spot?: SpotPort } = {}): HubServices {
  let s = shared.get(d);
  if (!s) { const hub = new MarketsHub({ derivatives: () => d, ...(o.spot ? { spot: o.spot } : {}) }); s = { hub, compare: new CompareService(hub) }; shared.set(d, s); }
  return s;
}
export function marketsHub(app: FastifyInstance, o: { derivatives?: Derivatives | undefined; spot?: SpotPort } = {}): void {
  const s = hubFor(o.derivatives ?? derivatives(), o.spot ? { spot: o.spot } : {});
  marketsHubRoutes(app, s.hub, s.compare);
}

export { MarketsHub, HUB_BUDGET_MS, HUB_CADENCE_MS, HUB_TTL_MS, perpTradability, sortRows, type HubRow, type HubSnapshot, type SpotPort, type TradableReason } from './hub.ts';
export { CompareService, COMPARE_TEXTS, DEPTH_BPS, type CompareAnswer, type CompareQuery, type CompareRow } from './compare.ts';
export { HUB_PREFIX } from './routes.ts';
export { CompareQuerySchema, toCompareQuery } from './schema.ts';
export { createListing, OPEN_ACCESS, type Access, type MarketRow } from './listing.ts';

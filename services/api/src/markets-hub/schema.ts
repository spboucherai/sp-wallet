/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/markets-hub/schema.ts
 * Module           : markets-hub
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

// Query schemas of the markets hub. PURE (zod only: no configuration, no database): the trading API's contract (spec.ts) and the
// OpenAPI generator import this file without starting anything.
import { z } from 'zod';

export const HUB_SORTS = ['volume', 'openInterest', 'funding', 'change', 'symbol'] as const;
export type HubSort = (typeof HUB_SORTS)[number];
const Dec = (max: number, what: string) => z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/, `${what}: a decimal number`).refine((x) => Number(x) > 0 && Number(x) <= max, `${what}: above 0, at most ${max}`);
export const UnderlyingSchema = z.string().regex(/^[A-Za-z0-9]{1,15}$/, 'underlying: a ticker');
export const CompareQuerySchema = z.object({
  underlying: UnderlyingSchema.default('BTC').describe('common underlying, e.g. BTC (see GET /markets-hub/underlyings)'),
  side: z.enum(['long', 'short']).default('long').describe('direction of the position compared'),
  notional: Dec(1_000_000_000, 'notional').default('1000').describe('position notional in USD (not the collateral)'),
  leverage: Dec(200, 'leverage').default('1').describe('leverage of the position: collateral = notional / leverage'),
  horizonHours: z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,4})?$/, 'horizonHours: a decimal number').refine((x) => Number(x) <= 8760, 'horizonHours: at most 8760').default('24').describe('expected holding period; funding is the current rate held constant over it'),
  liquidity: z.enum(['taker', 'maker']).default('taker').describe('how the entry and the exit are executed, for the fee'),
  minNetEdgeBps: z.string().regex(/^(0|[1-9]\d{0,4})(\.\d{1,4})?$/).default('0').describe('a discrepancy estimate above this is flagged'),
});
export type CompareQueryInput = z.infer<typeof CompareQuerySchema>;
export const toCompareQuery = (q: CompareQueryInput) => ({ underlying: q.underlying, side: q.side, notionalUsd: q.notional, leverage: q.leverage, horizonHours: q.horizonHours, liquidity: q.liquidity, minNetEdgeBps: q.minNetEdgeBps });

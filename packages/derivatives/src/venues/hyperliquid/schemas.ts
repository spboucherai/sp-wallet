/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/hyperliquid/schemas.ts
 * Module           : venues
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// zod schemas of the Hyperliquid answers that the adapter reads. Loose objects: unknown fields are tolerated, a missing or
// mistyped field is `bad_answer`. Every numeric string is checked and canonicalised as a decimal string — never parsed to a number.
// Shapes: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint (+ /perpetuals) and
// .../websocket/subscriptions, confirmed against live answers (fixtures in test/fixtures/hyperliquid/).
import { z } from 'zod';
import { D } from '../../decimal.ts';

/** a venue decimal ("73699.0", "-63.0", "0.0000117479") → canonical DecStr ("73699", "-63", "0.0000117479") */
export const hlDec = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/).max(60).transform((s) => D.str(D.from(s)));
const ms = z.number().int().nonnegative();
const coin = z.string().min(1).max(40);
export const hlAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
const cloid = z.string().regex(/^0x[0-9a-fA-F]{32}$/).transform((s) => s.toLowerCase());
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const side = z.enum(['B', 'A']); // B = bid = buy, A = ask = sell (notation page)

// --- meta / metaAndAssetCtxs -------------------------------------------------------------------------------------------------
export const hlUniverseEntry = z.looseObject({
  name: coin, szDecimals: z.number().int().min(0).max(6), maxLeverage: z.number().int().min(1).max(1000),
  onlyIsolated: z.boolean().optional(), isDelisted: z.boolean().optional(), marginMode: z.string().max(40).optional(),
});
export const hlMeta = z.looseObject({ universe: z.array(hlUniverseEntry).min(1).max(5000), collateralToken: z.number().int().nonnegative().optional() });
export type HlMeta = z.infer<typeof hlMeta>;

export const hlAssetCtx = z.looseObject({
  funding: hlDec, openInterest: hlDec, prevDayPx: hlDec, dayNtlVlm: hlDec, premium: hlDec.nullable(), oraclePx: hlDec, markPx: hlDec,
  midPx: hlDec.nullable(), dayBaseVlm: hlDec.optional(),
});
export type HlAssetCtx = z.infer<typeof hlAssetCtx>;
export const hlMetaAndAssetCtxs = z.tuple([hlMeta, z.array(hlAssetCtx)]);

// --- l2Book / recentTrades / candleSnapshot / fundingHistory -------------------------------------------------------------------
const level = z.looseObject({ px: hlDec, sz: hlDec, n: z.number().int().nonnegative() });
export const hlL2Book = z.looseObject({ coin, time: ms, levels: z.tuple([z.array(level).max(500), z.array(level).max(500)]) });
export const hlTrade = z.looseObject({ coin, side, px: hlDec, sz: hlDec, time: ms, hash, tid: z.number().int().nonnegative() });
export const hlTrades = z.array(hlTrade).max(5000);
export const hlCandle = z.looseObject({ t: ms, T: ms, s: coin, i: z.string(), o: hlDec, c: hlDec, h: hlDec, l: hlDec, v: hlDec, n: z.number().int().nonnegative() });
export const hlCandles = z.array(hlCandle).max(5000);
export const hlFundingHistory = z.array(z.looseObject({ coin, fundingRate: hlDec, premium: hlDec.nullable(), time: ms })).max(5000);

// --- clearinghouseState --------------------------------------------------------------------------------------------------------
const marginSummary = z.looseObject({ accountValue: hlDec, totalNtlPos: hlDec, totalRawUsd: hlDec, totalMarginUsed: hlDec });
export const hlPosition = z.looseObject({
  coin, szi: hlDec, entryPx: hlDec.nullable(), positionValue: hlDec, unrealizedPnl: hlDec, liquidationPx: hlDec.nullable(), marginUsed: hlDec,
  leverage: z.looseObject({ type: z.enum(['cross', 'isolated']), value: z.number().int().min(1).max(1000) }),
  cumFunding: z.looseObject({ allTime: hlDec, sinceOpen: hlDec, sinceChange: hlDec }),
});
export const hlClearinghouseState = z.looseObject({
  marginSummary, crossMarginSummary: marginSummary, crossMaintenanceMarginUsed: hlDec, withdrawable: hlDec,
  assetPositions: z.array(z.looseObject({ type: z.string(), position: hlPosition })).max(5000), time: ms,
});

// --- orders ------------------------------------------------------------------------------------------------------------------
export const hlFrontendOrder = z.looseObject({
  coin, side, limitPx: hlDec, sz: hlDec, oid: z.number().int().nonnegative(), timestamp: ms, origSz: hlDec,
  isTrigger: z.boolean(), triggerPx: hlDec, triggerCondition: z.string().optional(), reduceOnly: z.boolean(),
  orderType: z.string().max(40), tif: z.string().max(40).nullable(), cloid: cloid.nullable().optional(), isPositionTpsl: z.boolean().optional(),
});
export type HlFrontendOrder = z.infer<typeof hlFrontendOrder>;
export const hlFrontendOpenOrders = z.array(hlFrontendOrder).max(10_000);
export const hlHistoricalOrders = z.array(z.looseObject({ order: hlFrontendOrder, status: z.string().max(60), statusTimestamp: ms })).max(10_000);
/** orderUpdates (websocket): the basic order has no trigger / tif information */
export const hlWsOrder = z.looseObject({
  order: z.looseObject({ coin, side, limitPx: hlDec, sz: hlDec, oid: z.number().int().nonnegative(), timestamp: ms, origSz: hlDec, cloid: cloid.nullable().optional() }),
  status: z.string().max(60), statusTimestamp: ms,
});
export const hlWsOrders = z.array(hlWsOrder).max(10_000);

// --- fills / funding ---------------------------------------------------------------------------------------------------------
export const hlFill = z.looseObject({
  coin, px: hlDec, sz: hlDec, side, time: ms, closedPnl: hlDec, hash, oid: z.number().int().nonnegative(), fee: hlDec,
  tid: z.number().int().nonnegative(), feeToken: z.string().max(40), cloid: cloid.nullable().optional(),
  liquidation: z.looseObject({}).nullable().optional(), dir: z.string().optional(), crossed: z.boolean().optional(),
});
export type HlFill = z.infer<typeof hlFill>;
export const hlFills = z.array(hlFill).max(10_000);
export const hlFundingDelta = z.looseObject({ type: z.literal('funding'), coin, usdc: hlDec, szi: hlDec, fundingRate: hlDec });
export const hlUserFunding = z.array(z.looseObject({ time: ms, hash, delta: hlFundingDelta })).max(10_000);

// --- exchange answers --------------------------------------------------------------------------------------------------------
const orderStatus = z.union([
  z.looseObject({ resting: z.looseObject({ oid: z.number().int().nonnegative(), cloid: cloid.optional() }) }),
  z.looseObject({ filled: z.looseObject({ oid: z.number().int().nonnegative(), totalSz: hlDec, avgPx: hlDec, cloid: cloid.optional() }) }),
  z.looseObject({ error: z.string() }),
  z.string(), // "success" (cancel), "waitingForFill", "waitingForTrigger" (seen in the SDK for trigger / tpsl orders)
]);
export const hlExchangeAnswer = z.union([
  z.looseObject({ status: z.literal('err'), response: z.string() }),
  z.looseObject({
    status: z.literal('ok'),
    response: z.looseObject({ type: z.string(), data: z.looseObject({ statuses: z.array(orderStatus).max(1000) }).optional() }),
  }),
]);
export type HlExchangeAnswer = z.infer<typeof hlExchangeAnswer>;

// --- websocket ---------------------------------------------------------------------------------------------------------------
export const hlWsEnvelope = z.looseObject({ channel: z.string().min(1).max(60), data: z.unknown().optional() });
export const hlWsActiveAssetCtx = z.looseObject({ coin, ctx: hlAssetCtx });
export const hlWsAllMids = z.looseObject({ mids: z.record(z.string(), hlDec) });
// v11 quote engine: best bid / offer of one coin (either side may be null on an empty side) — frames recorded live 2026-11-15
export const hlWsBbo = z.looseObject({ coin, time: ms, bbo: z.tuple([level.nullable(), level.nullable()]) });
export const hlWsUserFills = z.looseObject({ isSnapshot: z.boolean().optional(), user: hlAddressSchema, fills: hlFills });
export const hlWsUserEvent = z.looseObject({
  fills: hlFills.optional(),
  funding: z.looseObject({ time: ms, coin, usdc: hlDec, szi: hlDec, fundingRate: hlDec }).optional(),
  liquidation: z.looseObject({}).optional(),
  nonUserCancel: z.array(z.looseObject({ coin, oid: z.number().int().nonnegative() })).optional(),
});

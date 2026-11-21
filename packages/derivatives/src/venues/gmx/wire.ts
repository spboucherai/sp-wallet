/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/gmx/wire.ts
 * Module           : venues
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// GMX v2 wire formats (zod) and exact unit conversions.
// Sources: GMX API OpenAPI spec https://arbitrum.gmxapi.io/swagger.json, Oracle API https://docs.gmx.io/docs/api/rest-api/oracle-prices/
// Shapes checked against the live endpoints on 2026-11-10 (fixtures in packages/derivatives/test/fixtures/gmx/).
//
// Units (all integers in decimal strings, converted with bigint only):
//   USD value                      × 10^30                         sizeInUsd, collateralUsd, open interest, liquidity, pnl, fees in USD
//   GMX API price                  × 10^30 per WHOLE token         /markets/tickers, /prices/tickers, positions (mark, entry, liquidation)
//   contract price                 × 10^(30 − tokenDecimals)       Oracle API /prices/tickers, order trigger/acceptable price, trade execution price
//   token amount                   × 10^tokenDecimals              sizeInTokens, collateralAmount, fee amounts
//   factor / rate                  × 10^30                         funding, borrowing, impact and fee factors
//   leverage, percentage           basis points (10 000 = 1×)      leverage, leverageTiers[].maxLeverage, pnlPercentage
import { z } from 'zod';
import { fixed, JsonNumber } from '../http.ts';

export const USD_DECIMALS = 30;
export const MAX_UINT256 = (1n << 256n) - 1n;
const intStr = z.string().regex(/^-?\d+$/);
const uintStr = z.string().regex(/^\d+$/);
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const jsonNumber = z.instanceof(JsonNumber);

export const market = z.object({
  symbol: z.string().min(1), marketTokenAddress: address, indexTokenAddress: address, longTokenAddress: address, shortTokenAddress: address,
  isListed: z.boolean(), isSpotOnly: z.boolean(),
  leverageTiers: z.array(z.object({ maxLeverage: uintStr, minCollateralFactor: uintStr, maxPositionSize: uintStr.optional() })).min(1),
  minPositionSizeUsd: uintStr, minCollateralUsd: uintStr,
});
export type Market = z.infer<typeof market>;
export const markets = z.array(market);

const capacity = z.object({ availableLiquidity: intStr, baseAvailableLiquidity: intStr, jitAvailableLiquidity: intStr, limitingFactor: z.string(), jitDataStatus: z.string(), marketDataStatus: z.string() });
export const marketTicker = z.object({
  symbol: z.string().min(1), marketTokenAddress: address, minPrice: uintStr, maxPrice: uintStr, markPrice: uintStr,
  priceChangePercent24hBps: intStr, longInterestInTokens: uintStr, shortInterestInTokens: uintStr, longInterestUsd: uintStr, shortInterestUsd: uintStr,
  availableLiquidityLong: intStr, availableLiquidityShort: intStr,   // negative when a side is over its reserve (seen live)
  fundingRateLong: intStr, fundingRateShort: intStr, borrowingRateLong: intStr, borrowingRateShort: intStr, netRateLong: intStr, netRateShort: intStr,
  capacityLong: capacity, capacityShort: capacity,
});
export type MarketTicker = z.infer<typeof marketTicker>;
export const marketTickers = z.array(marketTicker);

export const marketConfig = z.object({
  name: z.string(), marketTokenAddress: address, isDisabled: z.boolean(),
  maxOpenInterestLong: uintStr, maxOpenInterestShort: uintStr,
  minCollateralFactor: uintStr, minCollateralFactorForLiquidation: uintStr, minCollateralFactorForOpenInterestLong: uintStr, minCollateralFactorForOpenInterestShort: uintStr,
  positionFeeFactorForBalanceWasImproved: uintStr, positionFeeFactorForBalanceWasNotImproved: uintStr,
  positionImpactFactorPositive: uintStr, positionImpactFactorNegative: uintStr,
  positionImpactExponentFactorPositive: uintStr, positionImpactExponentFactorNegative: uintStr,
  maxPositionImpactFactorPositive: uintStr, maxPositionImpactFactorNegative: uintStr, maxPositionImpactFactorForLiquidations: uintStr,
  /** when true the contracts measure the long/short imbalance (price impact, fee tier) on open interest IN TOKENS × price, not on the USD cost basis */
  useOpenInterestInTokensForBalance: z.boolean().optional(),
  /** non-zero: the index token has a virtual inventory shared by every market on it (a negative price impact is the worse of the market's own and the virtual one) */
  virtualIndexTokenId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
export type MarketConfig = z.infer<typeof marketConfig>;
export const marketConfigs = z.array(marketConfig);
/** GET /markets/values — only what the price-impact formula needs. Signed: negative = traders are net LONG across the index's markets (contract convention). */
export const marketValues = z.array(z.object({ marketTokenAddress: address, virtualInventoryForPositionsInTokens: intStr, virtualInventoryForPositions: intStr }));

export const tokenInfo = z.object({ symbol: z.string().min(1), address, decimals: z.number().int().min(0).max(30), isSynthetic: z.boolean().optional(), isNative: z.boolean().optional() });
export const tokensInfo = z.array(tokenInfo);

/** /pairs is a listing feed with plain JSON numbers: parsed with `parseJsonExact`, so numbers arrive as their source text */
export const pairs = z.array(z.object({ ticker_id: z.string(), pool_id: z.string(), product_type: z.string(), target_volume: jsonNumber }));

export const ohlcv = z.array(z.object({ timestamp: z.number().int().positive(), open: z.string(), high: z.string(), low: z.string(), close: z.string() }));
/** Oracle API candles: `[timestamp s, open, high, low, close]` with JSON numbers (parsed exact) */
export const oracleCandles = z.object({ period: z.string(), candles: z.array(z.tuple([jsonNumber, jsonNumber, jsonNumber, jsonNumber, jsonNumber])) });
export const oracleTickers = z.array(z.object({ tokenAddress: address, tokenSymbol: z.string().min(1), minPrice: uintStr, maxPrice: uintStr, updatedAt: z.number(), timestamp: z.number().optional() }));
export const oracleTokens = z.object({ tokens: z.array(z.object({ symbol: z.string().min(1), address, decimals: z.number().int().min(0).max(30), synthetic: z.boolean().optional() })) });

export const rates = z.array(z.object({ marketAddress: address, ratesSnapshots: z.array(z.object({
  timestamp: z.number().int().positive(), fundingRateLong: intStr, fundingRateShort: intStr, borrowingRateLong: intStr, borrowingRateShort: intStr, netRateLong: intStr, netRateShort: intStr,
})) }));

export const position = z.object({
  key: z.string().min(1), contractKey: bytes32, account: address, marketAddress: address, collateralTokenAddress: address, isLong: z.boolean(),
  sizeInUsd: uintStr, sizeInTokens: uintStr, collateralAmount: uintStr, increasedAtTime: uintStr, decreasedAtTime: uintStr,
  markPrice: uintStr, entryPrice: uintStr.optional(), liquidationPrice: uintStr.optional(), leverage: uintStr.optional(), leverageWithPnl: uintStr.optional(), leverageWithoutPnl: uintStr.optional(),
  collateralUsd: uintStr, remainingCollateralUsd: intStr, remainingCollateralAmount: intStr, hasLowCollateral: z.boolean(),
  pnl: intStr, pnlAfterFees: intStr, pnlAfterAllFees: intStr, netValue: intStr, netValueAfterAllFees: intStr, positionValueInUsd: intStr,
  pendingBorrowingFeesUsd: intStr, pendingFundingFeesUsd: intStr, pendingClaimableFundingFeesUsd: intStr, fundingFeeAmount: intStr,
  claimableLongTokenAmount: intStr, claimableShortTokenAmount: intStr,
  positionFeeAmount: intStr, traderDiscountAmount: intStr, uiFeeAmount: intStr, closingFeeUsd: intStr, uiFeeUsd: intStr,
  pendingImpactAmount: intStr, pendingImpactUsd: intStr, closePriceImpactDeltaUsd: intStr, priceImpactDiffUsd: intStr, netPriceImapctDeltaUsd: intStr,
});
export type WirePosition = z.infer<typeof position>;
export const positions = z.array(position);

export const order = z.object({
  key: bytes32, account: address, receiver: address, cancellationReceiver: address, callbackContract: address, uiFeeReceiver: address,
  marketAddress: address, initialCollateralTokenAddress: address, swapPath: z.array(address), orderType: z.number().int().min(0).max(9), decreasePositionSwapType: z.number().int(),
  sizeDeltaUsd: uintStr, initialCollateralDeltaAmount: uintStr, triggerPrice: uintStr, acceptablePrice: uintStr, executionFee: uintStr, callbackGasLimit: uintStr,
  minOutputAmount: uintStr, updatedAtTime: uintStr, validFromTime: uintStr, isLong: z.boolean(), shouldUnwrapNativeToken: z.boolean(), isFrozen: z.boolean(), autoCancel: z.boolean(),
});
export type WireOrder = z.infer<typeof order>;
export const orders = z.array(order);

export const tradeAction = z.object({
  id: z.string().min(1), eventName: z.string().min(1), account: address, marketAddress: address.optional(), orderType: z.number().int().min(0).max(9), orderKey: bytes32,
  timestamp: z.number().int().positive(), transactionHash: z.string(), swapPath: z.array(address), initialCollateralTokenAddress: address, initialCollateralDeltaAmount: uintStr,
  isLong: z.boolean().optional(), sizeDeltaUsd: uintStr.optional(), sizeDeltaInTokens: uintStr.optional(), triggerPrice: uintStr.optional(), acceptablePrice: uintStr.optional(),
  executionPrice: uintStr.optional(), indexTokenPriceMin: uintStr.optional(), indexTokenPriceMax: uintStr.optional(),
  positionFeeAmount: intStr.optional(), borrowingFeeAmount: intStr.optional(), fundingFeeAmount: intStr.optional(), liquidationFeeAmount: intStr.optional(), traderDiscountAmount: intStr.optional(),
  priceImpactUsd: intStr.optional(), totalImpactUsd: intStr.optional(), proportionalPendingImpactUsd: intStr.optional(), priceImpactDiffUsd: intStr.optional(),
  swapImpactUsd: intStr.optional(), swapFeeUsd: intStr.optional(), basePnlUsd: intStr.optional(), pnlUsd: intStr.optional(), reason: z.string().optional(),
});
export type TradeAction = z.infer<typeof tradeAction>;
export const tradesList = z.object({ trades: z.array(tradeAction), hasMore: z.boolean(), nextCursor: z.string().nullable() });

export const graphqlTrades = z.object({ data: z.object({ tradeActions: z.array(z.object({
  id: z.string().min(1), orderType: z.number().int(), isLong: z.boolean(), sizeDeltaInTokens: uintStr, executionPrice: uintStr, timestamp: z.number().int().positive(),
})) }) });

/** GMX order types (contracts/order/Order.sol, enum order) */
export const ORDER_TYPE = ['MarketSwap', 'LimitSwap', 'MarketIncrease', 'LimitIncrease', 'MarketDecrease', 'LimitDecrease', 'StopLossDecrease', 'Liquidation', 'StopIncrease', 'Deposit'] as const;
export const isIncrease = (t: number): boolean => t === 2 || t === 3 || t === 8;
export const isDecrease = (t: number): boolean => t === 4 || t === 5 || t === 6 || t === 7;

// ---- exact conversions ----
export const usd = (raw: string | bigint): string => fixed(BigInt(raw), USD_DECIMALS);
/** GMX API price (30 decimals per whole token) → USD per token */
export const apiPrice = usd;
/** contract price (× 10^(30 − tokenDecimals)) → USD per whole token */
export function contractPrice(raw: string | bigint, tokenDecimals: number): string {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > USD_DECIMALS) throw new Error('token decimals out of range');
  return fixed(BigInt(raw), USD_DECIMALS - tokenDecimals);
}
/** USD per whole token → contract price; throws if the price has more precision than the contract can hold */
export function toContractPrice(price: string, tokenDecimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!m) throw new Error(`not a price: ${price.slice(0, 40)}`);
  const d = USD_DECIMALS - tokenDecimals, frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > d) throw new Error(`${price} has more than ${d} decimals`);
  return BigInt(m[1]! + frac.padEnd(d, '0'));
}
export const tokenAmount = (raw: string | bigint, decimals: number): string => fixed(BigInt(raw), decimals);
/** 30-decimal factor or rate → decimal fraction */
export const factor = usd;
/** basis points → multiple (384930 → "38.493") */
export const bps = (raw: string | bigint): string => fixed(BigInt(raw), 4);
/** per-second 30-decimal rate → per-hour fraction (exact: × 3600) */
export const perSecondToHourly = (raw: string | bigint): string => fixed(BigInt(raw) * 3600n, USD_DECIMALS);
/** smallest price step the contracts can represent for a token, in USD per whole token */
export const priceStep = (tokenDecimals: number): string => fixed(1n, USD_DECIMALS - tokenDecimals);

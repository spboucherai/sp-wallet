/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/dydx/wire.ts
 * Module           : venues
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// dYdX v4 indexer wire formats (zod) and the exact unit conversions of the protocol (quantums, subticks).
// Shapes checked against the live indexer on 2026-11-10 (fixtures in packages/derivatives/test/fixtures/dydx/).
// Reference: https://docs.dydx.xyz/indexer-client/http and https://docs.dydx.xyz/indexer-client/websockets
import { z } from 'zod';
import { canonDec, fixed, toRaw } from '../http.ts';

/** decimal string as the indexer prints it (never an exponent) */
export const dec = z.string().regex(/^-?\d+(\.\d+)?$/);
const uintStr = z.string().regex(/^\d+$/);
const iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'ISO date');
export const canon = canonDec;
const cdec = dec.transform(canon);

export const MARKET_STATUS = ['ACTIVE', 'PAUSED', 'CANCEL_ONLY', 'POST_ONLY', 'INITIALIZING', 'FINAL_SETTLEMENT'] as const;
export const perpetualMarket = z.object({
  clobPairId: uintStr, ticker: z.string().min(1), status: z.enum(MARKET_STATUS),
  oraclePrice: cdec, priceChange24H: cdec, volume24H: cdec, trades24H: z.number().int().nonnegative(),
  nextFundingRate: cdec, initialMarginFraction: cdec, maintenanceMarginFraction: cdec, openInterest: cdec,
  atomicResolution: z.number().int(), quantumConversionExponent: z.number().int(),
  tickSize: cdec, stepSize: cdec, stepBaseQuantums: z.number().int().positive(), subticksPerTick: z.number().int().positive(),
  marketType: z.enum(['CROSS', 'ISOLATED']),
  openInterestLowerCap: cdec.optional(), openInterestUpperCap: cdec.optional(), baseOpenInterest: cdec.optional(), defaultFundingRate1H: cdec.optional(),
});
export type PerpetualMarket = z.infer<typeof perpetualMarket>;
export const perpetualMarkets = z.object({ markets: z.record(z.string(), perpetualMarket) });

const level = z.object({ price: cdec, size: cdec });
export const orderbook = z.object({ bids: z.array(level), asks: z.array(level) });

export const trade = z.object({ id: z.string().min(1), side: z.enum(['BUY', 'SELL']), size: cdec, price: cdec, type: z.string(), createdAt: iso, createdAtHeight: uintStr });
export const trades = z.object({ trades: z.array(trade) });

export const candle = z.object({ startedAt: iso, ticker: z.string(), resolution: z.string(), low: cdec, high: cdec, open: cdec, close: cdec, baseTokenVolume: cdec, usdVolume: cdec, trades: z.number().int() });
export const candles = z.object({ candles: z.array(candle) });

export const historicalFunding = z.object({ historicalFunding: z.array(z.object({ ticker: z.string(), rate: cdec, price: cdec, effectiveAt: iso, effectiveAtHeight: uintStr })) });

export const perpetualPosition = z.object({
  market: z.string().min(1), status: z.enum(['OPEN', 'CLOSED', 'LIQUIDATED']), side: z.enum(['LONG', 'SHORT']),
  size: cdec, maxSize: cdec, entryPrice: cdec, exitPrice: cdec.nullable().optional(), realizedPnl: cdec, unrealizedPnl: cdec,
  createdAt: iso, closedAt: iso.nullable().optional(), sumOpen: cdec, sumClose: cdec, netFunding: cdec, subaccountNumber: z.number().int().nonnegative(),
});
export type PerpetualPosition = z.infer<typeof perpetualPosition>;
export const assetPosition = z.object({ size: cdec, symbol: z.string().min(1), side: z.enum(['LONG', 'SHORT']), assetId: z.string(), subaccountNumber: z.number().int().nonnegative() });
export const subaccount = z.object({
  address: z.string(), subaccountNumber: z.number().int().nonnegative(), equity: cdec, freeCollateral: cdec,
  openPerpetualPositions: z.record(z.string(), perpetualPosition), assetPositions: z.record(z.string(), assetPosition),
  marginEnabled: z.boolean(), updatedAtHeight: uintStr.optional(), latestProcessedBlockHeight: uintStr.optional(),
});
export type Subaccount = z.infer<typeof subaccount>;
export const subaccountAnswer = z.object({ subaccount });
export const addressAnswer = z.object({ subaccounts: z.array(subaccount) });
export const positionsAnswer = z.object({ positions: z.array(perpetualPosition) });

export const ORDER_STATUS = ['OPEN', 'FILLED', 'CANCELED', 'BEST_EFFORT_CANCELED', 'UNTRIGGERED', 'BEST_EFFORT_OPENED', 'PENDING'] as const;
/** REST and websocket snapshot shape. Websocket *updates* carry `totalOptimisticFilled` instead of `totalFilled` and may omit fields. */
export const order = z.object({
  id: z.string().min(1), clientId: uintStr, clobPairId: uintStr, side: z.enum(['BUY', 'SELL']), size: cdec,
  totalFilled: cdec.optional(), totalOptimisticFilled: cdec.optional(), price: cdec, type: z.string().min(1), status: z.string().min(1),
  timeInForce: z.string().min(1), reduceOnly: z.boolean(), postOnly: z.boolean(), orderFlags: uintStr,
  goodTilBlock: uintStr.nullable().optional(), goodTilBlockTime: iso.nullable().optional(), createdAtHeight: uintStr.nullable().optional(),
  triggerPrice: cdec.nullable().optional(), updatedAt: iso.nullable().optional(), updatedAtHeight: uintStr.nullable().optional(),
  ticker: z.string().min(1), subaccountNumber: z.number().int().nonnegative().optional(), removalReason: z.string().optional(), clientMetadata: z.string().nullable().optional(),
});
export type WireOrder = z.infer<typeof order>;
export const orders = z.array(order);

export const fill = z.object({
  id: z.string().min(1), side: z.enum(['BUY', 'SELL']), liquidity: z.enum(['MAKER', 'TAKER']), type: z.string().min(1), market: z.string().min(1),
  marketType: z.string(), price: cdec, size: cdec, fee: cdec, createdAt: iso, createdAtHeight: uintStr, orderId: z.string().nullable().optional(),
  subaccountNumber: z.number().int().nonnegative().optional(),
});
export type WireFill = z.infer<typeof fill>;
export const fills = z.object({ fills: z.array(fill) });

export const fundingPayments = z.object({ fundingPayments: z.array(z.object({
  createdAt: iso, createdAtHeight: uintStr, ticker: z.string().min(1), oraclePrice: cdec, size: cdec, side: z.enum(['LONG', 'SHORT']), rate: cdec, payment: cdec,
})) });

export const errorAnswer = z.object({ errors: z.array(z.object({ msg: z.string(), code: z.string().optional() })).min(1) });

// ---- exact unit conversions (https://docs.dydx.xyz/concepts/trading/quantums ; v4-client-js src/clients/helpers/chain-helpers.ts) ----
/** USDC, the quote asset, has 6 decimals on chain: one quote quantum = 10^-6 USDC. */
export const QUOTE_ATOMIC_RESOLUTION = -6;
export interface MarketUnits { atomicResolution: number; quantumConversionExponent: number; stepBaseQuantums: number; subticksPerTick: number }

/** int × 10^e as an exact decimal string */
const scale10 = (int: bigint, e: number): string => (e >= 0 ? (int * 10n ** BigInt(e)).toString() : fixed(int, -e));
/** value × 10^-e as an exact bigint; throws if it is not a whole number */
const unscale10 = (value: string, e: number): bigint => {
  if (e < 0) return toRaw(value, -e);
  const raw = toRaw(value, 0), d = 10n ** BigInt(e);
  if (raw % d !== 0n) throw new Error(`${value} is not a multiple of 10^${e}`);
  return raw / d;
};
/** exponent such that price = subticks × 10^priceExponent */
export const priceExponent = (u: MarketUnits): number => u.quantumConversionExponent + QUOTE_ATOMIC_RESOLUTION - u.atomicResolution;

/** base quantums → size in base units (1 quantum = 10^atomicResolution base units) */
export const quantumsToSize = (quantums: bigint, u: MarketUnits): string => scale10(quantums, u.atomicResolution);
/** size in base units → base quantums; throws unless it is an exact multiple of the step (`stepBaseQuantums`) */
export function sizeToQuantums(size: string, u: MarketUnits): bigint {
  const q = unscale10(size, u.atomicResolution);
  if (q % BigInt(u.stepBaseQuantums) !== 0n) throw new Error(`size ${size} is not a multiple of the step`);
  return q;
}
/** subticks → price in USD per base unit */
export const subticksToPrice = (subticks: bigint, u: MarketUnits): string => scale10(subticks, priceExponent(u));
/** price → subticks; throws unless it is an exact multiple of the tick (`subticksPerTick`) */
export function priceToSubticks(price: string, u: MarketUnits): bigint {
  const s = unscale10(price, priceExponent(u));
  if (s % BigInt(u.subticksPerTick) !== 0n) throw new Error(`price ${price} is not a multiple of the tick`);
  return s;
}
/** tick and step derived from the protocol parameters (must equal the indexer's `tickSize` / `stepSize`) */
export const tickSizeOf = (u: MarketUnits): string => subticksToPrice(BigInt(u.subticksPerTick), u);
export const stepSizeOf = (u: MarketUnits): string => quantumsToSize(BigInt(u.stepBaseQuantums), u);
/** quote quantums → USDC */
export const quoteQuantumsToUsdc = (q: bigint): string => fixed(q, -QUOTE_ATOMIC_RESOLUTION);

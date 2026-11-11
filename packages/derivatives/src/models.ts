// Normalized models (docs/v4/DERIVATIVES-ARCHITECTURE.md, "Core contract"). MINIMAL version written with the Hyperliquid adapter;
// the foundation module replaces this file at merge. Same names, same shapes.
import { z } from 'zod';
import type { DecStr } from './decimal.ts';

export const decStr = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
const ts = z.number().int().nonnegative();
const marginMode = z.enum(['cross', 'isolated']);
const orderSide = z.enum(['buy', 'sell']);

export const venueIdSchema = z.enum(['hyperliquid', 'dydx', 'gmx']);
export type VenueId = z.infer<typeof venueIdSchema>;
export const sideSchema = z.enum(['long', 'short']);
export type Side = z.infer<typeof sideSchema>; // position side; order side is 'buy' | 'sell'

export const instrumentSchema = z.object({
  venue: venueIdSchema, symbol: z.string().min(1), id: z.string().min(1), base: z.string().min(1), quote: z.string().min(1),
  kind: z.literal('perpetual'), collateral: z.string().min(1), settlement: z.string(),
  tickSize: decStr, lotSize: decStr, minOrderSize: decStr.nullable(), minNotional: decStr.nullable(),
  maxLeverage: decStr, marginModes: z.array(marginMode), fundingIntervalSec: z.number().int().positive(), markPriceMethod: z.string(),
  status: z.enum(['active', 'reduce_only', 'halted']),
});
export type Instrument = z.infer<typeof instrumentSchema>;

export const tickerSchema = z.object({
  instrument: z.string(), mark: decStr, index: decStr.nullable(), mid: decStr.nullable(), funding: decStr.nullable(),
  openInterest: decStr.nullable(), volume24h: decStr.nullable(), change24h: decStr.nullable(), ts,
});
export type Ticker = z.infer<typeof tickerSchema>;

const level = z.tuple([decStr, decStr]);
export const bookSchema = z.object({ instrument: z.string(), bids: z.array(level), asks: z.array(level), ts });
export type Book = z.infer<typeof bookSchema>;

export const publicTradeSchema = z.object({ instrument: z.string(), price: decStr, size: decStr, side: orderSide, ts, id: z.string() });
export type PublicTrade = z.infer<typeof publicTradeSchema>;

export const candleSchema = z.object({ ts, open: decStr, high: decStr, low: decStr, close: decStr, volume: decStr });
export type Candle = z.infer<typeof candleSchema>;

export const accountStateSchema = z.object({
  venue: venueIdSchema, account: z.string(), equity: decStr, collateral: decStr, freeCollateral: decStr, marginUsed: decStr,
  maintenanceMargin: decStr.nullable(), withdrawable: decStr.nullable(), ts, source: z.enum(['venue', 'paper']),
});
export type AccountState = z.infer<typeof accountStateSchema>;

export const positionSchema = z.object({
  instrument: z.string(), side: sideSchema, size: decStr, entryPrice: decStr, markPrice: decStr, liquidationPrice: decStr.nullable(),
  leverage: decStr, marginMode, margin: decStr, unrealizedPnl: decStr, realizedPnl: decStr.nullable(), fundingPaid: decStr.nullable(),
  source: z.enum(['venue', 'paper']),
});
export type Position = z.infer<typeof positionSchema>;

export const orderRequestSchema = z.object({
  instrument: z.string(), side: orderSide,
  type: z.enum(['limit', 'market', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit']),
  size: decStr, price: decStr.nullable(), triggerPrice: decStr.nullable(), reduceOnly: z.boolean(), tif: z.enum(['gtc', 'ioc', 'alo']),
  clientId: z.string(),
});
export type OrderRequest = z.infer<typeof orderRequestSchema>;

export const orderSchema = orderRequestSchema.extend({
  venueOrderId: z.string().nullable(),
  status: z.enum(['pending', 'open', 'filled', 'partially_filled', 'cancelled', 'rejected', 'triggered']),
  filled: decStr, avgFillPrice: decStr.nullable(), createdAt: ts, updatedAt: ts, rejectReason: z.string().nullable(),
});
export type Order = z.infer<typeof orderSchema>;

export const fillSchema = z.object({
  instrument: z.string(), orderId: z.string().nullable(), clientId: z.string().nullable(), side: orderSide, price: decStr, size: decStr,
  fee: decStr, feeAsset: z.string(), closedPnl: decStr.nullable(), ts, id: z.string(), liquidation: z.boolean(),
});
export type Fill = z.infer<typeof fillSchema>;

export const fundingPaymentSchema = z.object({ instrument: z.string(), amount: decStr, rate: decStr, size: decStr, ts });
export type FundingPayment = z.infer<typeof fundingPaymentSchema>;

export type { DecStr };

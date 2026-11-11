// MINIMAL normalized models following docs/v4/DERIVATIVES-ARCHITECTURE.md to the letter (zod schemas + inferred types).
// The foundation delivery owns this file: its version replaces this one at merge.
import { z } from 'zod';

export const decStr = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
export const venueId = z.enum(['hyperliquid', 'dydx', 'gmx']);
export type VenueId = z.infer<typeof venueId>;
export const side = z.enum(['long', 'short']);
export type Side = z.infer<typeof side>;
const marginMode = z.enum(['cross', 'isolated']);
const source = z.enum(['venue', 'paper']);

export const instrument = z.object({
  venue: venueId, symbol: z.string().min(1), id: z.string().min(1), base: z.string().min(1), quote: z.string().min(1),
  kind: z.literal('perpetual'), collateral: z.string().min(1), settlement: z.string().min(1),
  tickSize: decStr, lotSize: decStr, minOrderSize: decStr.nullable(), minNotional: decStr.nullable(),
  maxLeverage: decStr, marginModes: z.array(marginMode), fundingIntervalSec: z.number().int().positive(), markPriceMethod: z.string().min(1),
  status: z.enum(['active', 'reduce_only', 'halted']),
});
export type Instrument = z.infer<typeof instrument>;

export const ticker = z.object({
  instrument: z.string(), mark: decStr, index: decStr.nullable(), mid: decStr.nullable(), funding: decStr.nullable(),
  openInterest: decStr.nullable(), volume24h: decStr.nullable(), change24h: decStr.nullable(), ts: z.number(),
});
export type Ticker = z.infer<typeof ticker>;

const level = z.tuple([decStr, decStr]);
export const book = z.object({ instrument: z.string(), bids: z.array(level), asks: z.array(level), ts: z.number() });
export type Book = z.infer<typeof book>;

export const publicTrade = z.object({ instrument: z.string(), price: decStr, size: decStr, side: z.enum(['buy', 'sell']), ts: z.number(), id: z.string() });
export type PublicTrade = z.infer<typeof publicTrade>;

export const candle = z.object({ ts: z.number(), open: decStr, high: decStr, low: decStr, close: decStr, volume: decStr });
export type Candle = z.infer<typeof candle>;

export const accountState = z.object({
  venue: venueId, account: z.string(), equity: decStr, collateral: decStr, freeCollateral: decStr, marginUsed: decStr,
  maintenanceMargin: decStr.nullable(), withdrawable: decStr.nullable(), ts: z.number(), source,
});
export type AccountState = z.infer<typeof accountState>;

export const position = z.object({
  instrument: z.string(), side, size: decStr, entryPrice: decStr, markPrice: decStr, liquidationPrice: decStr.nullable(),
  leverage: decStr, marginMode, margin: decStr, unrealizedPnl: decStr, realizedPnl: decStr.nullable(), fundingPaid: decStr.nullable(), source,
});
export type Position = z.infer<typeof position>;

export const orderRequest = z.object({
  instrument: z.string(), side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit']),
  size: decStr, price: decStr.nullable(), triggerPrice: decStr.nullable(), reduceOnly: z.boolean(), tif: z.enum(['gtc', 'ioc', 'alo']),
  clientId: z.string(),
});
export type OrderRequest = z.infer<typeof orderRequest>;

export const order = orderRequest.extend({
  venueOrderId: z.string().nullable(),
  status: z.enum(['pending', 'open', 'filled', 'partially_filled', 'cancelled', 'rejected', 'triggered']),
  filled: decStr, avgFillPrice: decStr.nullable(), createdAt: z.number(), updatedAt: z.number(), rejectReason: z.string().nullable(),
});
export type Order = z.infer<typeof order>;

export const fill = z.object({
  instrument: z.string(), orderId: z.string().nullable(), clientId: z.string().nullable(), side: z.enum(['buy', 'sell']), price: decStr, size: decStr,
  fee: decStr, feeAsset: z.string(), closedPnl: decStr.nullable(), ts: z.number(), id: z.string(), liquidation: z.boolean(),
});
export type Fill = z.infer<typeof fill>;

export const fundingPayment = z.object({ instrument: z.string(), amount: decStr, rate: decStr, size: decStr, ts: z.number() });
export type FundingPayment = z.infer<typeof fundingPayment>;

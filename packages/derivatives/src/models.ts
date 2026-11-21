/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/models.ts
 * Module           : derivatives
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

/**
 * Normalised models of the derivatives module (contract: docs/v4/DERIVATIVES-ARCHITECTURE.md, "models.ts").
 * Every model is a zod schema (`XSchema`) exported with its inferred type (`X`). Unknown fields are tolerated (stripped);
 * missing or mistyped fields fail validation. All prices, sizes and amounts are canonical decimal strings.
 */
import { z } from 'zod';
import { DEC_RE, MAX_DIGITS } from './decimal.ts';

/** canonical decimal string: /^-?(0|[1-9]\d*)(\.\d+)?$/, no exponent, at most MAX_DIGITS digits */
export const DecStrSchema = z.string().max(MAX_DIGITS + 2).regex(DEC_RE, 'not a canonical decimal string')
  .refine((x) => x.replace(/[-.]/g, '').length <= MAX_DIGITS, `more than ${MAX_DIGITS} digits`);
const Ts = z.number().int().nonnegative();          // milliseconds since the Unix epoch

export const VENUE_IDS = ['hyperliquid', 'dydx', 'gmx', 'edgex'] as const;   // v11: edgex (market data only)
export const VenueIdSchema = z.enum(VENUE_IDS);
export type VenueId = z.infer<typeof VenueIdSchema>;

/** position side; an order side is 'buy' | 'sell' */
export const SideSchema = z.enum(['long', 'short']);
export type Side = z.infer<typeof SideSchema>;
export const OrderSideSchema = z.enum(['buy', 'sell']);
export type OrderSide = z.infer<typeof OrderSideSchema>;
export const MarginModeSchema = z.enum(['cross', 'isolated']);
export type MarginMode = z.infer<typeof MarginModeSchema>;
export const SourceSchema = z.enum(['venue', 'paper']);
/** v11: what the underlying of an instrument is, when the venue's own metadata says it (optional; absent = not stated) */
export const INSTRUMENT_CATEGORIES = ['crypto', 'equity', 'pre_ipo', 'commodity', 'fx'] as const;
export const InstrumentCategorySchema = z.enum(INSTRUMENT_CATEGORIES);
export type InstrumentCategory = z.infer<typeof InstrumentCategorySchema>;

export const InstrumentSchema = z.object({
  venue: VenueIdSchema,
  symbol: z.string().min(1),                        // venue's own symbol, e.g. 'BTC' on Hyperliquid, 'BTC-USD' on dYdX
  id: z.string().min(1),                            // `${venue}:${symbol}`
  base: z.string().min(1),
  quote: z.string().min(1),
  kind: z.literal('perpetual'),
  collateral: z.string().min(1),
  settlement: z.string(),                           // how PnL settles, free text from the venue's docs
  tickSize: DecStrSchema,
  lotSize: DecStrSchema,
  minOrderSize: DecStrSchema.nullable(),
  minNotional: DecStrSchema.nullable(),
  maxLeverage: DecStrSchema,
  marginModes: z.array(MarginModeSchema),
  fundingIntervalSec: z.number().int().positive(),
  markPriceMethod: z.string(),
  status: z.enum(['active', 'reduce_only', 'halted']),
  category: InstrumentCategorySchema.optional(),     // v11, optional: set only where the venue's metadata states it
}).refine((i) => i.id === `${i.venue}:${i.symbol}`, { message: 'id must be `${venue}:${symbol}`', path: ['id'] });
export type Instrument = z.infer<typeof InstrumentSchema>;

export const TickerSchema = z.object({
  instrument: z.string().min(1),
  mark: DecStrSchema,
  index: DecStrSchema.nullable(),
  mid: DecStrSchema.nullable(),
  funding: DecStrSchema.nullable(),                 // per funding interval
  openInterest: DecStrSchema.nullable(),
  volume24h: DecStrSchema.nullable(),
  change24h: DecStrSchema.nullable(),
  ts: Ts,
  // v11, optional: published by some venues only (edgeX)
  last: DecStrSchema.optional(),                    // last traded price
  volumeBase24h: DecStrSchema.optional(),           // 24 h volume in base units (`volume24h` is in the quote currency)
  nextFundingTs: Ts.optional(),                     // next funding settlement
});
export type Ticker = z.infer<typeof TickerSchema>;

export const BookLevelSchema = z.tuple([DecStrSchema, DecStrSchema]);     // [price, size]
export const BookSchema = z.object({
  instrument: z.string().min(1),
  bids: z.array(BookLevelSchema),                   // best (highest) first
  asks: z.array(BookLevelSchema),                   // best (lowest) first
  ts: Ts,
});
export type Book = z.infer<typeof BookSchema>;

export const PublicTradeSchema = z.object({
  instrument: z.string().min(1), price: DecStrSchema, size: DecStrSchema, side: OrderSideSchema, ts: Ts, id: z.string(),
});
export type PublicTrade = z.infer<typeof PublicTradeSchema>;

export const CandleSchema = z.object({
  ts: Ts, open: DecStrSchema, high: DecStrSchema, low: DecStrSchema, close: DecStrSchema, volume: DecStrSchema,
});
export type Candle = z.infer<typeof CandleSchema>;

export const AccountStateSchema = z.object({
  venue: VenueIdSchema,
  account: z.string().min(1),
  equity: DecStrSchema,
  collateral: DecStrSchema,
  freeCollateral: DecStrSchema,
  marginUsed: DecStrSchema,
  maintenanceMargin: DecStrSchema.nullable(),
  withdrawable: DecStrSchema.nullable(),
  ts: Ts,
  source: SourceSchema,
});
export type AccountState = z.infer<typeof AccountStateSchema>;

export const PositionSchema = z.object({
  instrument: z.string().min(1),
  side: SideSchema,
  size: DecStrSchema,                               // positive; the direction is `side`
  entryPrice: DecStrSchema,
  markPrice: DecStrSchema,
  liquidationPrice: DecStrSchema.nullable(),
  leverage: DecStrSchema,
  marginMode: MarginModeSchema,
  margin: DecStrSchema,
  unrealizedPnl: DecStrSchema,
  realizedPnl: DecStrSchema.nullable(),
  fundingPaid: DecStrSchema.nullable(),
  source: SourceSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const ORDER_TYPES = ['limit', 'market', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit'] as const;
export const OrderTypeSchema = z.enum(ORDER_TYPES);
export type OrderType = z.infer<typeof OrderTypeSchema>;
export const TifSchema = z.enum(['gtc', 'ioc', 'alo']);        // alo = post only
export type Tif = z.infer<typeof TifSchema>;

export const OrderRequestSchema = z.object({
  instrument: z.string().min(1),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  size: DecStrSchema,
  price: DecStrSchema.nullable(),                   // limit price; for market orders the worst acceptable price (slippage bound), required
  triggerPrice: DecStrSchema.nullable(),
  reduceOnly: z.boolean(),
  tif: TifSchema,
  clientId: z.string().min(1),                      // idempotency key, unique per account
});
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

export const ORDER_STATUSES = ['pending', 'open', 'filled', 'partially_filled', 'cancelled', 'rejected', 'triggered'] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = OrderRequestSchema.extend({
  venueOrderId: z.string().nullable(),
  status: OrderStatusSchema,
  filled: DecStrSchema,
  avgFillPrice: DecStrSchema.nullable(),
  createdAt: Ts,
  updatedAt: Ts,
  rejectReason: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const FillSchema = z.object({
  instrument: z.string().min(1),
  orderId: z.string().nullable(),
  clientId: z.string().nullable(),
  side: OrderSideSchema,
  price: DecStrSchema,
  size: DecStrSchema,
  fee: DecStrSchema,
  feeAsset: z.string(),
  closedPnl: DecStrSchema.nullable(),
  ts: Ts,
  id: z.string().min(1),
  liquidation: z.boolean(),
});
export type Fill = z.infer<typeof FillSchema>;

export const FundingPaymentSchema = z.object({
  instrument: z.string().min(1), amount: DecStrSchema, rate: DecStrSchema, size: DecStrSchema, ts: Ts,
});
export type FundingPayment = z.infer<typeof FundingPaymentSchema>;

export const VENUE_ERROR_CODES = ['rate_limited', 'unavailable', 'bad_answer', 'rejected', 'unsupported', 'stale'] as const;
export type VenueErrorCode = (typeof VENUE_ERROR_CODES)[number];

/** thrown by venue adapters */
export class VenueError extends Error {
  readonly code: VenueErrorCode;
  readonly venue: VenueId | null;
  readonly detail: unknown;
  constructor(code: VenueErrorCode, message: string, o: { venue?: VenueId | null; detail?: unknown; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'VenueError';
    this.code = code;
    this.venue = o.venue ?? null;
    this.detail = o.detail;
  }
}

/**
 * v11: a part of a venue that the wallet does not offer, with a stable machine-readable reason (e.g.
 * `edgex_account_restricted_jurisdiction`). A VenueError (`unsupported` by default), so existing handlers keep working.
 */
export class VenueUnavailable extends VenueError {
  readonly reason: string;
  constructor(reason: string, o: { venue?: VenueId | null; code?: VenueErrorCode; message?: string; detail?: unknown } = {}) {
    super(o.code ?? 'unsupported', o.message ?? reason, { venue: o.venue ?? null, detail: o.detail });
    this.name = 'VenueUnavailable';
    this.reason = reason;
  }
}

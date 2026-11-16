/**
 * The canonical order intent of the V11 trading layer: ONE structured representation of "what is asked", whatever produced it
 * (the command engine, an agent, an API key, a screen) and whatever venue will execute it.
 *
 * Serialization follows packages/core/src/intent.ts exactly: a domain tag, a zero byte, then (name, value) pairs in an order
 * fixed by this code, each prefixed by its lengths (u16 name, u32 value). Never JSON key order. The helper is the exported
 * `canonicalEncode` of @spw/derivatives/live, which is that same encoding (test/canonical.test.ts decodes a core intent and an
 * order with one decoder). The hash is SHA-256 of those bytes.
 *
 * `canonicalOrderJson` is a second, human-readable form (fixed key order, canonical decimals, explicit nulls). It is derived from
 * the same normalized object; the HASH is always the one of the bytes, never of the JSON.
 *
 * Pure: no clock, no network, no randomness.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { D, MarginModeSchema, OrderSideSchema, TifSchema, type DecStr, type OrderRequest } from '@spw/derivatives';
import { canonicalEncode, hex } from '@spw/derivatives/live';
import { canon, NonNegDecSchema, PosDecSchema, TsMsSchema } from '../dec.ts';

export const ORDER_DOMAIN = 'SPW-ORDER-INTENT-v1';
export const ORDER_BODY_DOMAIN = 'SPW-ORDER-BODY-v1';
export const MARKET_KINDS = ['spot', 'perp'] as const;
export const MarketKindSchema = z.enum(MARKET_KINDS);
export type MarketKind = z.infer<typeof MarketKindSchema>;
export const CANONICAL_ORDER_TYPES = ['market', 'limit', 'stop', 'take_profit'] as const;
export const CanonicalOrderTypeSchema = z.enum(CANONICAL_ORDER_TYPES);
export type CanonicalOrderType = z.infer<typeof CanonicalOrderTypeSchema>;
export const TRADING_MODES = ['research', 'paper', 'live'] as const;
export const TradingModeSchema = z.enum(TRADING_MODES);
export type TradingMode = z.infer<typeof TradingModeSchema>;
export const PRINCIPAL_KINDS = ['owner', 'agent', 'api_key'] as const;
export const PrincipalSchema = z.strictObject({ kind: z.enum(PRINCIPAL_KINDS), id: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/) });
export type Principal = z.infer<typeof PrincipalSchema>;
/** an order lives at most this long between its creation and its expiry (a resting order's life on the venue is `tif`, not this) */
export const ORDER_MAX_TTL_MS = 24 * 3600 * 1000;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const CanonicalOrderSchema = z.strictObject({
  v: z.literal(1),
  /** venue id: a derivatives venue ('hyperliquid', 'gmx', …) or a spot venue ('kyberswap', 'jupiter', …) */
  venue: Id,
  /** network of the venue account: 'mainnet' | 'testnet' for an exchange, a registry network id ('arbitrum', 'base', …) for an on-chain venue */
  network: Id,
  /** instrument id, `${venue}:${symbol}` */
  instrument: z.string().min(3).max(120),
  marketKind: MarketKindSchema,
  side: OrderSideSchema,
  type: CanonicalOrderTypeSchema,
  /** exactly one of the two: a quantity of the base asset, or a notional in the quote currency */
  size: PosDecSchema.nullable(),
  notional: PosDecSchema.nullable(),
  /** limit price: required for `limit`, optional for `stop` / `take_profit` (present = stop-limit), null for `market` */
  limitPrice: PosDecSchema.nullable(),
  /** trigger price: required for `stop` and `take_profit`, null otherwise */
  triggerPrice: PosDecSchema.nullable(),
  reduceOnly: z.boolean(),
  tif: TifSchema,
  /** worst execution accepted against the reference price at submission, in basis points (integer) */
  maxSlippageBps: z.number().int().min(0).max(10_000),
  /** highest total fee accepted for this order, USD */
  maxFeeUsd: NonNegDecSchema,
  /** leverage setting the order assumes (perp); null = the venue account's current setting, or spot */
  leverage: PosDecSchema.nullable(),
  marginMode: MarginModeSchema.nullable(),
  clientOrderId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  mode: TradingModeSchema,
  principal: PrincipalSchema,
  /** the trading mandate the order is placed under; null = the owner acting directly */
  mandateId: z.uuid().nullable(),
  /** unix milliseconds */
  createdAt: TsMsSchema, expiresAt: TsMsSchema,
}).superRefine((o, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if ((o.size === null) === (o.notional === null)) bad('size', 'give exactly one of size and notional');
  if (!o.instrument.startsWith(`${o.venue}:`) || o.instrument.length === o.venue.length + 1) bad('instrument', 'instrument id must be `${venue}:${symbol}`');
  if (o.type === 'limit' && o.limitPrice === null) bad('limitPrice', 'a limit order needs a limit price');
  if (o.type === 'market' && o.limitPrice !== null) bad('limitPrice', 'a market order takes no limit price: its bound is maxSlippageBps');
  const trigger = o.type === 'stop' || o.type === 'take_profit';
  if (trigger && o.triggerPrice === null) bad('triggerPrice', `${o.type} needs a trigger price`);
  if (!trigger && o.triggerPrice !== null) bad('triggerPrice', `${o.type} takes no trigger price`);
  if (o.marketKind === 'spot') {
    if (o.leverage !== null) bad('leverage', 'a spot order has no leverage');
    if (o.marginMode !== null) bad('marginMode', 'a spot order has no margin mode');
    if (o.reduceOnly) bad('reduceOnly', 'reduce-only is a property of a derivative order');
  }
  if (o.principal.kind === 'owner' ? o.mandateId !== null : o.mandateId === null) bad('mandateId', 'an agent or an API key acts under a mandate; the owner does not');
  if (o.expiresAt <= o.createdAt) bad('expiresAt', 'the order must expire after it is created');
  else if (o.expiresAt - o.createdAt > ORDER_MAX_TTL_MS) bad('expiresAt', `an order is valid at most ${ORDER_MAX_TTL_MS} ms`);
});
export type CanonicalOrder = z.infer<typeof CanonicalOrderSchema>;
export type CanonicalOrderInput = z.input<typeof CanonicalOrderSchema>;

const dOrEmpty = (x: DecStr | null): string => (x === null ? '' : canon(x));

/** validates and normalizes: every decimal in canonical form, nothing else changed. Throws a ZodError on an invalid order. */
export function canonicalOrder(input: CanonicalOrderInput): CanonicalOrder {
  const o = CanonicalOrderSchema.parse(input);
  const c = (x: DecStr | null): DecStr | null => (x === null ? null : canon(x));
  return { ...o, size: c(o.size), notional: c(o.notional), limitPrice: c(o.limitPrice), triggerPrice: c(o.triggerPrice), maxFeeUsd: canon(o.maxFeeUsd), leverage: c(o.leverage), principal: { kind: o.principal.kind, id: o.principal.id } };
}

/** the economic content of the order: what two requests with one idempotency key must have in common */
function bodyFields(o: CanonicalOrder): [string, string][] {
  return [
    ['v', '1'], ['venue', o.venue], ['network', o.network], ['instrument', o.instrument], ['marketKind', o.marketKind], ['side', o.side], ['type', o.type],
    ['size', dOrEmpty(o.size)], ['notional', dOrEmpty(o.notional)], ['limitPrice', dOrEmpty(o.limitPrice)], ['triggerPrice', dOrEmpty(o.triggerPrice)],
    ['reduceOnly', o.reduceOnly ? '1' : '0'], ['tif', o.tif], ['maxSlippageBps', String(o.maxSlippageBps)], ['maxFeeUsd', canon(o.maxFeeUsd)],
    ['leverage', dOrEmpty(o.leverage)], ['marginMode', o.marginMode ?? ''],
    ['mode', o.mode], ['principal.kind', o.principal.kind], ['principal.id', o.principal.id], ['mandateId', o.mandateId ?? ''],
  ];
}
/** (name, value) pairs in the fixed order of the encoding */
export function canonicalOrderFields(order: CanonicalOrderInput): [string, string][] {
  const o = canonicalOrder(order);
  return [...bodyFields(o), ['clientOrderId', o.clientOrderId], ['createdAt', String(o.createdAt)], ['expiresAt', String(o.expiresAt)]];
}
export const canonicalOrderBytes = (order: CanonicalOrderInput): Uint8Array => canonicalEncode(ORDER_DOMAIN, canonicalOrderFields(order));
export const canonicalOrderHash = (order: CanonicalOrderInput): Uint8Array => sha256(canonicalOrderBytes(order));
export const canonicalOrderHashHex = (order: CanonicalOrderInput): string => hex(canonicalOrderHash(order));

/** fields left out of the BODY hash: they change between two honest retries of one request */
export const ORDER_BODY_EXCLUDED = ['clientOrderId', 'createdAt', 'expiresAt'] as const;
/**
 * Hash of the order's economic content (everything except ORDER_BODY_EXCLUDED), hex. This is what the idempotency rule compares:
 * a retry carries the same key and the same body, even though the server stamps a later `createdAt`.
 */
export const orderBodyHashHex = (order: CanonicalOrderInput): string => hex(sha256(canonicalEncode(ORDER_BODY_DOMAIN, bodyFields(canonicalOrder(order)))));

/** canonical JSON: keys in the order of the schema, canonical decimals, explicit nulls, no whitespace */
export function canonicalOrderJson(order: CanonicalOrderInput): string {
  const o = canonicalOrder(order);
  return JSON.stringify({
    v: o.v, venue: o.venue, network: o.network, instrument: o.instrument, marketKind: o.marketKind, side: o.side, type: o.type, size: o.size, notional: o.notional,
    limitPrice: o.limitPrice, triggerPrice: o.triggerPrice, reduceOnly: o.reduceOnly, tif: o.tif, maxSlippageBps: o.maxSlippageBps, maxFeeUsd: o.maxFeeUsd,
    leverage: o.leverage, marginMode: o.marginMode, clientOrderId: o.clientOrderId, mode: o.mode, principal: { kind: o.principal.kind, id: o.principal.id },
    mandateId: o.mandateId, createdAt: o.createdAt, expiresAt: o.expiresAt,
  });
}
export const parseCanonicalOrderJson = (json: string): CanonicalOrder => canonicalOrder(JSON.parse(json) as CanonicalOrderInput);

/** the highest price the order names (limit and trigger), or null when it names none (a plain market order) */
export function highestNamedPrice(o: Pick<CanonicalOrder, 'limitPrice' | 'triggerPrice'>): DecStr | null {
  if (o.limitPrice === null) return o.triggerPrice;
  if (o.triggerPrice === null) return o.limitPrice;
  return D.str(D.max(D.from(o.limitPrice), D.from(o.triggerPrice)));
}

/**
 * The existing venue-level request (packages/derivatives `OrderRequest`) for a canonical PERP order, once the caller has
 * resolved what the canonical order leaves open: the size in base units (when the order gave a notional) and the worst
 * acceptable price of an order without a limit price (the mark moved by maxSlippageBps, rounded to the tick by the caller).
 */
export function toOrderRequest(order: CanonicalOrder, resolved: { size: DecStr; worstPrice: DecStr | null }): OrderRequest {
  if (order.marketKind !== 'perp') throw new RangeError('only a perp order maps to a derivatives OrderRequest');
  const price = order.limitPrice ?? resolved.worstPrice;
  if (price === null) throw new RangeError('an order without a limit price needs its worst acceptable price');
  const type: OrderRequest['type'] = order.type === 'market' ? 'market' : order.type === 'limit' ? 'limit'
    : order.type === 'stop' ? (order.limitPrice === null ? 'stop_market' : 'stop_limit') : (order.limitPrice === null ? 'take_profit_market' : 'take_profit_limit');
  return { instrument: order.instrument, side: order.side, type, size: canon(resolved.size), price: canon(price), triggerPrice: order.triggerPrice, reduceOnly: order.reduceOnly, tif: order.tif, clientId: order.clientOrderId };
}

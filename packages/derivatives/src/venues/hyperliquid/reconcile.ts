// What a quoting engine needs to RECONCILE with Hyperliquid, beyond the open-order and fill parsers of schemas.ts / mappers.ts:
//   - the per-order statuses of a batch answer (one entry per order or cancel, in order — or ONE error for the whole payload),
//   - the status of one order by client id (`orderStatus`),
//   - the address-based rate limit (`userRateLimit`).
// Shapes: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/{exchange-endpoint,info-endpoint,error-responses}
// read 2026-11-15; `userRateLimit` and `orderStatus` → `unknownOid` confirmed against the public info endpoint the same day
// (fixtures in test/fixtures/hyperliquid/mm-info-shapes.json). Pure: no network.
import { z } from 'zod';
import { hlOrderStatus } from './mappers.ts';
import { hlDec, hlExchangeAnswer, hlFrontendOrder } from './schemas.ts';

export type HlBatchEntry =
  | { outcome: 'resting'; oid: string }
  | { outcome: 'filled'; oid: string; totalSz: string; avgPx: string }
  | { outcome: 'success' }                       // a cancel that was taken
  | { outcome: 'waiting' }                       // waitingForFill / waitingForTrigger
  | { outcome: 'error'; error: string; /** the venue refused it for a reason that is final for this order */ kind: HlOrderErrorKind };
export type HlOrderErrorKind = 'post_only_would_cross' | 'min_notional' | 'tick' | 'margin' | 'reduce_only' | 'missing_order' | 'rate_limited' | 'open_interest' | 'other';
export type HlBatchAnswer =
  /** one entry per order / cancel of the request, in the same order */
  | { kind: 'per_order'; entries: HlBatchEntry[] }
  /** the venue refused the WHOLE payload with one message (pre-validation, signature, rate limit, expired action …): nothing was placed */
  | { kind: 'rejected'; error: string; errorKind: HlOrderErrorKind | 'expired' | 'signature' }
  /** an answer that cannot be read: the outcome is UNKNOWN — reconcile, never resend */
  | { kind: 'unknown' };

/** error strings of the "Error responses" page → a class a quoting engine reacts to */
export function hlOrderErrorKind(error: string): HlOrderErrorKind {
  if (/Post only order would have immediately matched/i.test(error)) return 'post_only_would_cross';
  if (/minimum value of \$10/i.test(error)) return 'min_notional';
  if (/divisible by tick size|invalid (price|size)/i.test(error)) return 'tick';
  if (/Insufficient margin/i.test(error)) return 'margin';
  if (/Reduce only order would increase position/i.test(error)) return 'reduce_only';
  if (/never placed, already canceled, or filled/i.test(error)) return 'missing_order';
  if (/Too many cumulative requests|rate limit/i.test(error)) return 'rate_limited';
  if (/open interest/i.test(error)) return 'open_interest';
  return 'other';
}

/** `expected`: number of orders or cancels that were sent; an answer with another number of statuses is not trusted */
export function hlBatchAnswer(raw: unknown, expected: number): HlBatchAnswer {
  const p = hlExchangeAnswer.safeParse(raw);
  if (!p.success) return { kind: 'unknown' };
  if (p.data.status === 'err') {
    const e = p.data.response.slice(0, 300);
    return { kind: 'rejected', error: e, errorKind: /expired/i.test(e) ? 'expired' : /does not exist|signature|Must deposit/i.test(e) ? 'signature' : hlOrderErrorKind(e) };
  }
  const statuses = p.data.response.data?.statuses;
  if (!statuses) return { kind: 'unknown' };
  // pre-validation: "only one error is returned for the entire payload"
  if (expected > 1 && statuses.length === 1 && typeof statuses[0] === 'object' && statuses[0] !== null && 'error' in statuses[0] && typeof statuses[0].error === 'string') {
    const e = statuses[0].error.slice(0, 300);
    return { kind: 'rejected', error: e, errorKind: hlOrderErrorKind(e) };
  }
  if (statuses.length !== expected) return { kind: 'unknown' };
  const entries = statuses.map((s): HlBatchEntry => {
    if (typeof s === 'string') return s === 'success' ? { outcome: 'success' } : { outcome: 'waiting' };
    const x = s as { error?: unknown; resting?: { oid: number }; filled?: { oid: number; totalSz: string; avgPx: string } };
    if (typeof x.error === 'string') return { outcome: 'error', error: x.error.slice(0, 300), kind: hlOrderErrorKind(x.error) };
    if (x.resting) return { outcome: 'resting', oid: String(x.resting.oid) };
    if (x.filled) return { outcome: 'filled', oid: String(x.filled.oid), totalSz: x.filled.totalSz, avgPx: x.filled.avgPx };
    return { outcome: 'waiting' };
  });
  return { kind: 'per_order', entries };
}

// --- orderStatus (by oid or by cloid) ------------------------------------------------------------------------------------------
const orderStatusAnswer = z.union([
  z.looseObject({ status: z.literal('unknownOid') }),
  z.looseObject({ status: z.literal('order'), order: z.looseObject({ order: hlFrontendOrder, status: z.string().max(60), statusTimestamp: z.number().int().nonnegative() }) }),
]);
export type HlOrderLookup =
  | { found: false }
  | { found: true; oid: string; cloid: string | null; coin: string; side: 'buy' | 'sell'; price: string; /** remaining */ size: string; origSize: string; reduceOnly: boolean;
      state: 'open' | 'filled' | 'cancelled' | 'rejected' | 'triggered'; venueStatus: string; statusTimestamp: number };
/** request body: { type: "orderStatus", user, oid: <number | cloid hex> } — weight 2 */
export function hlOrderLookup(raw: unknown): HlOrderLookup {
  const p = orderStatusAnswer.parse(raw);
  if (p.status === 'unknownOid') return { found: false };
  const o = p.order.order, s = hlOrderStatus(p.order.status).status;
  return { found: true, oid: String(o.oid), cloid: o.cloid ?? null, coin: o.coin, side: o.side === 'B' ? 'buy' : 'sell', price: o.limitPx, size: o.sz, origSize: o.origSz, reduceOnly: o.reduceOnly,
    state: s === 'partially_filled' ? 'open' : (s as 'open' | 'filled' | 'cancelled' | 'rejected' | 'triggered'), venueStatus: p.order.status, statusTimestamp: p.order.statusTimestamp };
}

// --- userRateLimit ---------------------------------------------------------------------------------------------------------------
const userRateLimit = z.looseObject({ cumVlm: hlDec, nRequestsUsed: z.number().int().nonnegative(), nRequestsCap: z.number().int().nonnegative(), nRequestsSurplus: z.number().int().nonnegative().optional() });
export interface HlAddressRateLimit { cumVolume: string; used: number; cap: number; /** requests left before the venue throttles the address to one every 10 s */ remaining: number }
/** request body: { type: "userRateLimit", user } — weight 20. "1 request per 1 USDC traded cumulatively … initial buffer of 10000 requests" */
export function hlAddressRateLimit(raw: unknown): HlAddressRateLimit {
  const p = userRateLimit.parse(raw);
  return { cumVolume: p.cumVlm, used: p.nRequestsUsed, cap: p.nRequestsCap, remaining: Math.max(0, p.nRequestsCap - p.nRequestsUsed) + (p.nRequestsSurplus ?? 0) };
}
/** address-based requests consumed: "a batched request with n orders (or cancels) is treated … as n requests for address-based rate limiting" */
export const hlAddressRequests = (batchLength: number): number => Math.max(1, batchLength);

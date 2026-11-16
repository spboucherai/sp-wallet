// Rounding of QUOTES onto Hyperliquid's price and size grid — one direction only, by construction:
//   a bid is rounded DOWN, an ask is rounded UP (away from the other side: rounding can never make a quote cross or tighten),
//   a size is rounded DOWN to the lot (never more than was decided).
// The order builder (trading.ts) still refuses anything off the grid; these helpers are what a quoting engine calls BEFORE it.
// Rules: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size (read 2026-11-15) — see format.ts.
import { D, type DecStr } from '../../decimal.ts';
import { HL_MIN_NOTIONAL, hlFormatPrice, hlFormatSize, hlQuantizePrice, hlStep } from './format.ts';

const POS = /^(0|[1-9]\d*)(\.\d+)?$/;

/** a bid price on the grid, at or BELOW `price`; null when nothing positive is left */
export function hlRoundBid(price: DecStr, szDecimals: number): DecStr | null {
  if (!POS.test(price) || D.isZero(D.from(price))) return null;
  const q = hlQuantizePrice(D.str(D.from(price)), szDecimals, 'down'), r = hlFormatPrice(q, szDecimals);
  return r.ok ? r.wire : null;
}
/** an ask price on the grid, at or ABOVE `price` */
export function hlRoundAsk(price: DecStr, szDecimals: number): DecStr | null {
  if (!POS.test(price) || D.isZero(D.from(price))) return null;
  let q = hlQuantizePrice(D.str(D.from(price)), szDecimals, 'up');
  // rounding up can land on a power of ten where the grid gets coarser: the result is a multiple of both steps, but check and
  // re-round once so that a caller never receives an off-grid price
  if (!hlFormatPrice(q, szDecimals).ok) q = hlQuantizePrice(q, szDecimals, 'up');
  const r = hlFormatPrice(q, szDecimals);
  return r.ok ? r.wire : null;
}
/** a size on the lot grid, at or BELOW `size`; null when it rounds to zero */
export function hlRoundSize(size: DecStr, szDecimals: number): DecStr | null {
  if (!POS.test(size)) return null;
  const q = D.quantize(D.from(size), D.from(hlStep(szDecimals)), 'down');
  if (D.isZero(q)) return null;
  const r = hlFormatSize(D.str(q), szDecimals);
  return r.ok ? r.wire : null;
}
/** "Order must have minimum value of $10." */
export const hlMeetsMinNotional = (price: DecStr, size: DecStr): boolean => D.gte(D.mul(D.from(price), D.from(size)), D.from(HL_MIN_NOTIONAL));

export interface HlRoundedQuote { side: 'buy' | 'sell'; price: DecStr; size: DecStr }
/**
 * A quote ready for the builder, or null with the reason. The price moves only away from the other side, the size only down;
 * a quote that falls under the venue's minimum value after rounding is dropped, never enlarged.
 */
export function hlRoundQuote(side: 'buy' | 'sell', price: DecStr, size: DecStr, szDecimals: number): { ok: true; quote: HlRoundedQuote } | { ok: false; reason: 'price' | 'size' | 'min_notional' } {
  const p = side === 'buy' ? hlRoundBid(price, szDecimals) : hlRoundAsk(price, szDecimals);
  if (p === null) return { ok: false, reason: 'price' };
  const s = hlRoundSize(size, szDecimals);
  if (s === null) return { ok: false, reason: 'size' };
  if (!hlMeetsMinNotional(p, s)) return { ok: false, reason: 'min_notional' };
  return { ok: true, quote: { side, price: p, size: s } };
}

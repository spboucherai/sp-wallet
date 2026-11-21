/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/hyperliquid/format.ts
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

// Hyperliquid price and size rules — https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
//   "Prices can have up to 5 significant figures, but no more than MAX_DECIMALS - szDecimals decimal places where MAX_DECIMALS
//    is 6 for perps and 8 for spot. Integer prices are always allowed, regardless of the number of significant figures."
//   "Sizes are rounded to the szDecimals of that asset."   "if implementing signing, trailing zeroes should be removed."
// Everything is done on decimal strings / bigint; a request that is off-tick is REFUSED, never rounded.
import { D, type DecStr } from '../../decimal.ts';

export const HL_PERP_MAX_DECIMALS = 6;
export const HL_MAX_SIG_FIGS = 5;
/** documented order minimum: "Order must have minimum value of $10." (error responses page) */
export const HL_MIN_NOTIONAL = '10';

const CANON = /^(0|[1-9]\d*)(\.\d+)?$/;

export type FormatResult = { ok: true; wire: string } | { ok: false; reason: string };

/** canonical decimal → the venue's wire form: no trailing zeros, no trailing dot ("100.50" → "100.5", "100.0" → "100") */
export function hlWire(x: DecStr): string {
  if (!CANON.test(x)) throw new Error('not a canonical non-negative decimal');
  return D.str(D.from(x));
}

const decimalsOf = (wire: string): number => { const i = wire.indexOf('.'); return i < 0 ? 0 : wire.length - i - 1; };
/** significant figures of a wire decimal: digits from the first non-zero one, trailing zeros of an integer included */
export function hlSigFigs(wire: string): number {
  const digits = wire.replace('.', '').replace(/^0+/, '');
  return digits.length;
}

export function hlPriceDecimals(szDecimals: number): number {
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > HL_PERP_MAX_DECIMALS) throw new Error('szDecimals out of range');
  return HL_PERP_MAX_DECIMALS - szDecimals;
}

/** Validates a perp price against the documented rules; returns the wire string or the reason it is refused. */
export function hlFormatPrice(price: DecStr, szDecimals: number): FormatResult {
  if (typeof price !== 'string' || !CANON.test(price)) return { ok: false, reason: 'price is not a canonical positive decimal' };
  const wire = hlWire(price);
  if (wire === '0') return { ok: false, reason: 'price must be positive' };
  const maxDecimals = hlPriceDecimals(szDecimals), decimals = decimalsOf(wire);
  if (decimals > maxDecimals) return { ok: false, reason: `price ${wire} has ${decimals} decimals; at most ${maxDecimals} (6 − szDecimals ${szDecimals})` };
  if (decimals > 0 && hlSigFigs(wire) > HL_MAX_SIG_FIGS) return { ok: false, reason: `price ${wire} has ${hlSigFigs(wire)} significant figures; at most ${HL_MAX_SIG_FIGS} unless it is an integer` };
  return { ok: true, wire };
}

/** Validates a size against the asset's lot (10^-szDecimals); returns the wire string or the reason it is refused. */
export function hlFormatSize(size: DecStr, szDecimals: number): FormatResult {
  if (typeof size !== 'string' || !CANON.test(size)) return { ok: false, reason: 'size is not a canonical positive decimal' };
  hlPriceDecimals(szDecimals); // range check
  const wire = hlWire(size);
  if (wire === '0') return { ok: false, reason: 'size must be positive' };
  const decimals = decimalsOf(wire);
  if (decimals > szDecimals) return { ok: false, reason: `size ${wire} has ${decimals} decimals; the lot allows ${szDecimals}` };
  return { ok: true, wire };
}

/** 10^-n as a canonical decimal string */
export function hlStep(n: number): DecStr {
  if (!Number.isInteger(n) || n < 0 || n > 18) throw new Error('step exponent out of range');
  return n === 0 ? '1' : `0.${'0'.repeat(n - 1)}1`;
}

/**
 * The price increment that applies AT a given price. Hyperliquid has no fixed tick: the grid is "5 significant figures, at most
 * 6 − szDecimals decimals, integers always allowed", so the step depends on the magnitude of the price.
 */
export function hlTickAt(price: DecStr, szDecimals: number): DecStr {
  if (!CANON.test(price) || hlWire(price) === '0') throw new Error('price must be a positive canonical decimal');
  const wire = hlWire(price), maxDecimals = hlPriceDecimals(szDecimals);
  const [int = '0', frac = ''] = wire.split('.');
  // position of the most significant digit: exponent e such that 10^e <= price < 10^(e+1)
  const e = int !== '0' ? int.length - 1 : -(frac.length - frac.replace(/^0+/, '').length + 1);
  const bySigFigs = HL_MAX_SIG_FIGS - 1 - e; // decimals allowed by the 5-significant-figure rule
  const decimals = Math.max(0, Math.min(maxDecimals, bySigFigs)); // integers are always allowed → never coarser than 1
  return hlStep(decimals);
}

/** Rounds a price onto the venue's grid in an explicit direction (used to derive bounds, never to "fix" a request). */
export function hlQuantizePrice(price: DecStr, szDecimals: number, mode: 'down' | 'up'): DecStr {
  const step = D.from(hlTickAt(price, szDecimals));
  const q = D.str(D.quantize(D.from(price), step, mode));
  // rounding up can cross a power of ten, where the step gets coarser; the result is still on the grid (it is a multiple of both)
  return q;
}

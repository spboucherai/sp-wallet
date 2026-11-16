/**
 * Decimal helpers shared by the trading package. Everything is built on the exact decimal type of @spw/derivatives (`D`):
 * no `number` ever carries a price, a size or an amount of money.
 */
import { z } from 'zod';
import { D, DecStrSchema, type Dec, type DecStr } from '@spw/derivatives';

export const NonNegDecSchema = DecStrSchema.refine((x) => !x.startsWith('-'), 'must not be negative');
export const PosDecSchema = NonNegDecSchema.refine((x) => /[1-9]/.test(x), 'must be positive');
/** milliseconds since the Unix epoch */
export const TsMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** seconds since the Unix epoch */
export const TsSecSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const BPS = D.from(10000n);
/** decimals kept by the divisions of this package (same as margin.ts) */
export const SCALE = 18;
export const USD_SCALE = 6;
export const BPS_SCALE = 4;

/** canonical form of a decimal string: no trailing zeros, '-0' never appears */
export const canon = (x: DecStr): DecStr => D.str(D.from(x));
export const dec = (x: DecStr): Dec => D.from(x);
export const usd = (x: Dec): DecStr => D.str(D.div(x, D.one, USD_SCALE, 'half_even'));
export const bpsStr = (x: Dec): DecStr => D.str(D.div(x, D.one, BPS_SCALE, 'half_even'));

/** a / b in basis points, half-even at BPS_SCALE decimals; b must be positive */
export function ratioBps(a: Dec, b: Dec): Dec {
  return D.div(D.mul(a, BPS), b, BPS_SCALE, 'half_even');
}
/** a / b > bps / 10000, by cross-multiplication (b > 0): no rounded division takes part in a decision */
export function exceedsBps(a: Dec, b: Dec, bps: Dec): boolean {
  return D.gt(D.mul(a, BPS), D.mul(bps, b));
}
export const sum = (xs: readonly Dec[]): Dec => xs.reduce((acc, x) => D.add(acc, x), D.zero);
export const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

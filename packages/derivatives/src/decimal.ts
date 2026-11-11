/**
 * Exact decimal arithmetic for the derivatives module (contract: docs/v4/DERIVATIVES-ARCHITECTURE.md, "decimal.ts").
 *
 * A `Dec` is a bigint mantissa `m` and a non-negative integer scale `s`: value = m / 10^s. Addition, subtraction, multiplication
 * and comparison are exact. Division never rounds silently: the caller gives the number of decimals and the rounding mode.
 * No `number` takes part in any computation here; `toNumber` exists for display only.
 *
 * Rounding modes (same meaning in `div` and `quantize`):
 *   'down'      towards zero (truncate)
 *   'up'        away from zero
 *   'half_even' to nearest, ties to the even last digit (banker's rounding)
 */
export type DecStr = string;
export interface Dec { readonly m: bigint; readonly s: number }
export type RoundingMode = 'down' | 'up' | 'half_even';

/** canonical decimal string: optional minus, no leading zeros, optional fraction, no exponent, no '+' */
export const DEC_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** maximum number of digits (integer + fraction) accepted when parsing a string */
export const MAX_DIGITS = 60;
/** maximum scale accepted by `div` */
export const MAX_SCALE = 60;

const POW10: bigint[] = [1n];
function pow10(n: number): bigint {
  for (let i = POW10.length; i <= n; i++) POW10.push(POW10[i - 1]! * 10n);
  return POW10[n]!;
}

const ZERO: Dec = Object.freeze({ m: 0n, s: 0 });
const ONE: Dec = Object.freeze({ m: 1n, s: 0 });

/** normalised constructor: strips trailing zeros of the fraction; zero is always {0n, 0} */
function mk(m: bigint, s: number): Dec {
  if (m === 0n) return ZERO;
  while (s > 0 && m % 10n === 0n) { m /= 10n; s -= 1; }
  return Object.freeze({ m, s });
}

function check(x: Dec): Dec {
  if (typeof x !== 'object' || x === null || typeof x.m !== 'bigint' || !Number.isInteger(x.s) || x.s < 0) throw new TypeError('invalid Dec');
  return x;
}

function parse(x: string): Dec {
  if (x.length > MAX_DIGITS + 2 || !DEC_RE.test(x)) throw new RangeError(`invalid decimal string: ${JSON.stringify(x.length > 80 ? `${x.slice(0, 80)}…` : x)}`);
  const neg = x.startsWith('-');
  const body = neg ? x.slice(1) : x;
  const dot = body.indexOf('.');
  const int = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? '' : body.slice(dot + 1);
  if (int.length + frac.length > MAX_DIGITS) throw new RangeError(`decimal string has more than ${MAX_DIGITS} digits`);
  const m = BigInt(int + frac);
  return mk(neg ? -m : m, frac.length);
}

function from(x: DecStr | bigint | Dec): Dec {
  if (typeof x === 'string') return parse(x);
  if (typeof x === 'bigint') return mk(x, 0);
  if (typeof x === 'object' && x !== null) { check(x); return mk(x.m, x.s); }
  throw new TypeError(`cannot build a Dec from a ${typeof x}; use a decimal string or a bigint`);
}

function str(x: Dec): DecStr {
  const n = mk(check(x).m, x.s);
  const neg = n.m < 0n;
  let digits = (neg ? -n.m : n.m).toString();
  if (n.s > 0) {
    if (digits.length <= n.s) digits = '0'.repeat(n.s - digits.length + 1) + digits;
    digits = `${digits.slice(0, digits.length - n.s)}.${digits.slice(digits.length - n.s)}`;
  }
  return neg ? `-${digits}` : digits;
}

/** both mantissas at the common (larger) scale */
function align(a: Dec, b: Dec): [bigint, bigint, number] {
  check(a); check(b);
  if (a.s === b.s) return [a.m, b.m, a.s];
  return a.s > b.s ? [a.m, b.m * pow10(a.s - b.s), a.s] : [a.m * pow10(b.s - a.s), b.m, b.s];
}

function add(a: Dec, b: Dec): Dec { const [x, y, s] = align(a, b); return mk(x + y, s); }
function sub(a: Dec, b: Dec): Dec { const [x, y, s] = align(a, b); return mk(x - y, s); }
function mul(a: Dec, b: Dec): Dec { check(a); check(b); return mk(a.m * b.m, a.s + b.s); }
function cmp(a: Dec, b: Dec): -1 | 0 | 1 { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; }
function neg(a: Dec): Dec { return mk(-check(a).m, a.s); }
function abs(a: Dec): Dec { return mk(check(a).m < 0n ? -a.m : a.m, a.s); }
function isZero(a: Dec): boolean { return check(a).m === 0n; }

/** integer quotient num/den rounded with `mode`; den must not be zero */
function roundedQuotient(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den < 0n) { num = -num; den = -den; }
  let q = num / den;                 // truncates towards zero
  const r = num % den;               // same sign as num
  if (r === 0n) return q;
  const away = num < 0n ? -1n : 1n;
  if (mode === 'up') q += away;
  else if (mode === 'half_even') {
    const twice = (r < 0n ? -r : r) * 2n;
    if (twice > den || (twice === den && q % 2n !== 0n)) q += away;
  }
  return q;
}

function div(a: Dec, b: Dec, scale: number, mode: RoundingMode): Dec {
  check(a); check(b);
  if (b.m === 0n) throw new RangeError('division by zero');
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) throw new RangeError(`division scale must be an integer in 0..${MAX_SCALE}`);
  if (mode !== 'down' && mode !== 'up' && mode !== 'half_even') throw new RangeError(`unknown rounding mode: ${String(mode)}`);
  // a/b · 10^scale = a.m · 10^(b.s + scale) / (b.m · 10^a.s)
  return mk(roundedQuotient(a.m * pow10(b.s + scale), b.m * pow10(a.s), mode), scale);
}

function quantize(a: Dec, step: Dec, mode: 'down' | 'up'): Dec {
  const [x, st, s] = align(a, step);
  if (st <= 0n) throw new RangeError('quantize step must be positive');
  if (mode !== 'down' && mode !== 'up') throw new RangeError(`unknown quantize mode: ${String(mode)}`);
  return mk(roundedQuotient(x, st, mode) * st, s);
}

function toNumber(a: Dec): number { return Number(str(a)); }

export const D = {
  from, str, add, sub, mul, div, cmp, neg, abs, isZero, quantize,
  /** display only: never feed the result back into a calculation */
  toNumber,
  // additions to the contract (pure conveniences built on the members above)
  zero: ZERO,
  one: ONE,
  eq(a: Dec, b: Dec): boolean { return cmp(a, b) === 0; },
  lt(a: Dec, b: Dec): boolean { return cmp(a, b) < 0; },
  lte(a: Dec, b: Dec): boolean { return cmp(a, b) <= 0; },
  gt(a: Dec, b: Dec): boolean { return cmp(a, b) > 0; },
  gte(a: Dec, b: Dec): boolean { return cmp(a, b) >= 0; },
  min(a: Dec, b: Dec): Dec { return cmp(a, b) <= 0 ? a : b; },
  max(a: Dec, b: Dec): Dec { return cmp(a, b) >= 0 ? a : b; },
  sign(a: Dec): -1 | 0 | 1 { return check(a).m < 0n ? -1 : a.m > 0n ? 1 : 0; },
  isNeg(a: Dec): boolean { return check(a).m < 0n; },
  isPos(a: Dec): boolean { return check(a).m > 0n; },
  /** true when `a` is an exact multiple of the positive `step` */
  isMultiple(a: Dec, step: Dec): boolean {
    const [x, st] = align(a, step);
    if (st <= 0n) throw new RangeError('step must be positive');
    return x % st === 0n;
  },
  /** true when the value is a canonical decimal string within the digit limit (never throws) */
  isValid(x: unknown): x is DecStr {
    return typeof x === 'string' && x.length <= MAX_DIGITS + 2 && DEC_RE.test(x) && x.replace(/[-.]/g, '').length <= MAX_DIGITS;
  },
};

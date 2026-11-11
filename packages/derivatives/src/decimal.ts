// MINIMAL exact-decimal implementation following docs/v4/DERIVATIVES-ARCHITECTURE.md to the letter.
// The foundation delivery owns this file: its version replaces this one at merge. The venue adapters only rely on the
// contract below (`DecStr`, `Dec`, `D.*`), never on implementation details.
export type DecStr = string;                       // canonical decimal: /^-?(0|[1-9]\d*)(\.\d+)?$/ , no exponent
export interface Dec { readonly m: bigint; readonly s: number }   // value = m / 10^s

const RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.m * pow10(s - a.s), b.m * pow10(s - b.s), s];
};
/** integer division of n by d (d > 0) with an explicit rounding mode */
function divRound(n: bigint, d: bigint, mode: 'down' | 'up' | 'half_even'): bigint {
  const neg = n < 0n, an = neg ? -n : n;
  let q = an / d;
  const r = an % d;
  if (r !== 0n) {
    if (mode === 'up') q += 1n;
    else if (mode === 'half_even') { const twice = r * 2n; if (twice > d || (twice === d && (q & 1n) === 1n)) q += 1n; }
  }
  return neg ? -q : q;
}

function from(x: DecStr | bigint | Dec): Dec {
  if (typeof x === 'bigint') return { m: x, s: 0 };
  if (typeof x === 'object') return x;
  if (typeof x !== 'string' || !RE.test(x)) throw new Error(`not a canonical decimal: ${String(x).slice(0, 40)}`);
  const neg = x.startsWith('-'), body = neg ? x.slice(1) : x;
  const [int, frac = ''] = body.split('.') as [string, string?];
  const m = BigInt(int + frac);
  return { m: neg ? -m : m, s: frac.length };
}
function str(x: Dec): DecStr {
  const neg = x.m < 0n, digits = (neg ? -x.m : x.m).toString().padStart(x.s + 1, '0');
  const int = digits.slice(0, digits.length - x.s), frac = x.s ? digits.slice(digits.length - x.s).replace(/0+$/, '') : '';
  const out = frac ? `${int}.${frac}` : int;
  return neg && x.m !== 0n ? `-${out}` : out;
}

export const D = {
  from, str,
  add(a: Dec, b: Dec): Dec { const [x, y, s] = align(a, b); return { m: x + y, s }; },
  sub(a: Dec, b: Dec): Dec { const [x, y, s] = align(a, b); return { m: x - y, s }; },
  mul(a: Dec, b: Dec): Dec { return { m: a.m * b.m, s: a.s + b.s }; },
  /** division rounds to `scale` decimals with the given mode; never silently */
  div(a: Dec, b: Dec, scale: number, mode: 'down' | 'up' | 'half_even'): Dec {
    if (b.m === 0n) throw new Error('division by zero');
    if (!Number.isInteger(scale) || scale < 0) throw new Error('scale must be a non-negative integer');
    // a/b = (a.m * 10^(b.s + scale)) / (b.m * 10^a.s), as an integer with `scale` decimals
    let n = a.m * pow10(b.s + scale), d = b.m * pow10(a.s);
    if (d < 0n) { n = -n; d = -d; }
    return { m: divRound(n, d, mode), s: scale };
  },
  cmp(a: Dec, b: Dec): -1 | 0 | 1 { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; },
  neg(a: Dec): Dec { return { m: -a.m, s: a.s }; },
  abs(a: Dec): Dec { return { m: a.m < 0n ? -a.m : a.m, s: a.s }; },
  isZero(a: Dec): boolean { return a.m === 0n; },
  /** quantize to a tick/lot (a positive Dec), rounding down or up */
  quantize(a: Dec, step: Dec, mode: 'down' | 'up'): Dec {
    if (step.m <= 0n) throw new Error('step must be positive');
    const [x, y, s] = align(a, step);
    const neg = x < 0n, ax = neg ? -x : x;
    let q = ax / y;
    // "down" is towards zero, "up" away from zero
    if (ax % y !== 0n && mode === 'up') q += 1n;
    return { m: (neg ? -q : q) * y, s };
  },
  toNumber(a: Dec): number { return Number(str(a)); },   // display only
};

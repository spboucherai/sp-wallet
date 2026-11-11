// Exact decimals (docs/v4/DERIVATIVES-ARCHITECTURE.md, "Core contract"). MINIMAL version written with the Hyperliquid adapter so
// that it compiles and tests alone; the foundation module replaces this file at merge. Same names, same shapes.
export type DecStr = string; // canonical decimal: /^-?(0|[1-9]\d*)(\.\d+)?$/ , no exponent
export interface Dec { readonly m: bigint; readonly s: number } // value = m / 10^s

const CANON = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const p10 = (n: number): bigint => 10n ** BigInt(n);
const mk = (m: bigint, s: number): Dec => ({ m, s });
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.m * p10(s - a.s), b.m * p10(s - b.s), s];
};
/** integer division of n by d (d > 0) with an explicit rounding mode */
function idiv(n: bigint, d: bigint, mode: 'down' | 'up' | 'half_even'): bigint {
  const neg = n < 0n, an = neg ? -n : n;
  let q = an / d;
  const r = an % d;
  if (r !== 0n) {
    if (mode === 'up') q += 1n; // away from zero
    else if (mode === 'half_even') { const twice = r * 2n; if (twice > d || (twice === d && q % 2n === 1n)) q += 1n; }
  }
  return neg ? -q : q;
}

export const D = {
  from(x: DecStr | bigint | Dec): Dec {
    if (typeof x === 'bigint') return mk(x, 0);
    if (typeof x === 'object') return x;
    if (typeof x !== 'string' || !CANON.test(x)) throw new Error(`not a canonical decimal: ${String(x).slice(0, 40)}`);
    const neg = x.startsWith('-'), body = neg ? x.slice(1) : x, dot = body.indexOf('.');
    const int = dot < 0 ? body : body.slice(0, dot), frac = dot < 0 ? '' : body.slice(dot + 1);
    const m = BigInt(int + frac);
    return mk(neg ? -m : m, frac.length);
  },
  /** canonical string, trailing zeros removed ("-0" never appears) */
  str(x: Dec): DecStr {
    let m = x.m, s = x.s;
    while (s > 0 && m % 10n === 0n) { m /= 10n; s -= 1; }
    const neg = m < 0n, digits = (neg ? -m : m).toString().padStart(s + 1, '0');
    const out = s === 0 ? digits : `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`;
    return neg ? `-${out}` : out;
  },
  add(a: Dec, b: Dec): Dec { const [x, y, s] = align(a, b); return mk(x + y, s); },
  sub(a: Dec, b: Dec): Dec { const [x, y, s] = align(a, b); return mk(x - y, s); },
  mul(a: Dec, b: Dec): Dec { return mk(a.m * b.m, a.s + b.s); },
  /** division rounds to `scale` decimals with the given mode; never silently */
  div(a: Dec, b: Dec, scale: number, mode: 'down' | 'up' | 'half_even'): Dec {
    if (b.m === 0n) throw new Error('division by zero');
    if (!Number.isInteger(scale) || scale < 0) throw new Error('scale must be a non-negative integer');
    // a.m/10^a.s / (b.m/10^b.s) * 10^scale = a.m * 10^(b.s + scale) / (b.m * 10^a.s)
    let n = a.m * p10(b.s + scale), d = b.m * p10(a.s);
    if (d < 0n) { n = -n; d = -d; }
    return mk(idiv(n, d, mode), scale);
  },
  cmp(a: Dec, b: Dec): -1 | 0 | 1 { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; },
  neg(a: Dec): Dec { return mk(-a.m, a.s); },
  abs(a: Dec): Dec { return mk(a.m < 0n ? -a.m : a.m, a.s); },
  isZero(a: Dec): boolean { return a.m === 0n; },
  /** quantize to a tick/lot (a positive Dec), rounding down or up */
  quantize(a: Dec, step: Dec, mode: 'down' | 'up'): Dec {
    if (step.m <= 0n) throw new Error('step must be positive');
    const [x, y, s] = align(a, step);
    // floor / ceil in the mathematical sense (not toward/away from zero)
    let q = x / y;
    const r = x % y;
    if (r !== 0n) { if (mode === 'down' && x < 0n) q -= 1n; if (mode === 'up' && x > 0n) q += 1n; }
    return mk(q * y, s);
  },
  toNumber(a: Dec): number { return Number(D.str(a)); }, // display only
};

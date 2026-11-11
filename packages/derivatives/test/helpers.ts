import { D, type Dec, type DecStr } from '../src/index.ts';

/** mulberry32: a small deterministic PRNG for property tests (tests only; never used in the package itself) */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(r: () => number, lo: number, hi: number): number { return lo + Math.floor(r() * (hi - lo + 1)); }

function digits(r: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randInt(r, 0, 9));
  return s;
}

/** canonical decimal string with up to `intDigits` integer digits and up to `fracDigits` decimals */
export function randDecStr(r: () => number, o: { intDigits?: number; fracDigits?: number; signed?: boolean; positive?: boolean } = {}): DecStr {
  const int = digits(r, randInt(r, 1, o.intDigits ?? 9)).replace(/^0+(?=\d)/, '');
  const fn = randInt(r, 0, o.fracDigits ?? 9);
  let s = fn === 0 ? int : `${int}.${digits(r, fn)}`;
  if (o.positive && D.isZero(D.from(s))) s = '1';
  if (o.signed && r() < 0.5) s = `-${s}`;
  return s;
}

export function randDec(r: () => number, o: Parameters<typeof randDecStr>[1] = {}): Dec { return D.from(randDecStr(r, o)); }

export const d = (x: DecStr | bigint): Dec => D.from(x);
export const s = (x: Dec): DecStr => D.str(x);

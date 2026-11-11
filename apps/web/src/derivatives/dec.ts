/**
 * Exact decimals for the Futures terminal. The arithmetic is the repository's own `D` (bigint mantissa + scale): the file has no
 * import of its own, so it bundles for the browser as is. Everything shown as an amount to act on (size, price, margin, fee)
 * goes through it; JS numbers are used for charts and for compact read-only figures (24 h volume, open interest) only.
 */
import { D, type Dec, type DecStr } from '../../../../packages/derivatives/src/decimal.ts';

export { D };
export type { Dec, DecStr };

const NBSP = ' ';
const MINUS = '−';
const TEN_K = D.from(10000n);
const HUNDRED = D.from(100n);

/** a Dec from an API value, or null when the value is absent or not a canonical decimal */
export function dec(x: unknown): Dec | null {
  if (typeof x === 'number' && Number.isFinite(x)) x = numToDecStr(x);
  return D.isValid(x) ? D.from(x) : null;
}
/** tolerant conversion for fields a backend may send as JSON numbers (bps, fees): no exponent, at most 12 decimals */
export function numToDecStr(n: number): DecStr {
  const s = n.toFixed(12).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}
/** number of decimals of a tick / lot ('0.001' → 3, '1' → 0) */
export function dpOf(step: DecStr | null | undefined): number {
  const d = dec(step);
  return d ? d.s : 2;
}
/** rounds to `dp` decimals (half even) and pads with zeros: always exactly `dp` decimals */
export function toFixed(x: Dec, dp: number): string {
  const r = D.div(x, D.one, dp, 'half_even');
  const s = D.str(D.abs(r));
  const [i = '0', f = ''] = s.split('.');
  const body = dp > 0 ? `${i}.${f.padEnd(dp, '0')}` : i;
  return D.isNeg(r) ? `-${body}` : body;
}

export interface FmtOpts { dp?: number; locale?: string; sign?: boolean; trim?: boolean }
/**
 * Localised decimal: thousands grouped (non-breaking space in French, comma in English), decimal comma in French, a real minus
 * sign, optional explicit '+'. `dp` fixes the decimals; `trim` removes trailing zeros.
 */
export function fmt(x: DecStr | Dec | null | undefined, o: FmtOpts = {}): string {
  const d = typeof x === 'string' ? dec(x) : x ?? null;
  if (!d) return '—';
  const fr = o.locale !== 'en';
  let s = toFixed(d, o.dp ?? Math.min(d.s, 8));
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [i = '0', f = ''] = s.split('.');
  if (o.trim) f = f.replace(/0+$/, '');
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, fr ? NBSP : ',');
  const body = f ? `${i}${fr ? ',' : '.'}${f}` : i;
  const zero = !/[1-9]/.test(body);
  return `${neg && !zero ? MINUS : o.sign && !zero ? '+' : ''}${body}`;
}
/** a fraction as a percentage: 0.0123 → « 1,23 % » */
export function pct(fraction: DecStr | Dec | null | undefined, dp: number, locale: string, sign = false): string {
  const d = typeof fraction === 'string' ? dec(fraction) : fraction ?? null;
  if (!d) return '—';
  return `${fmt(D.mul(d, HUNDRED), { dp, locale, sign })}${NBSP}%`;
}
/** USD amount with two decimals, e.g. « 1 234,50 $ » / "$1,234.50" */
export function usd(x: DecStr | Dec | null | undefined, locale: string, sign = false): string {
  const d = typeof x === 'string' ? dec(x) : x ?? null;
  if (!d) return '—';
  const body = fmt(D.abs(d), { dp: 2, locale });
  const sg = D.isNeg(d) && /[1-9]/.test(body) ? MINUS : sign && /[1-9]/.test(body) ? '+' : '';
  return locale === 'en' ? `${sg}$${body}` : `${sg}${body}${NBSP}$`;
}
/** compact read-only USD figure (volume, open interest): numbers are fine here, nothing is acted on */
export function compactUsd(x: DecStr | Dec | null | undefined, locale: string): string {
  const d = typeof x === 'string' ? dec(x) : x ?? null;
  if (!d) return '—';
  const n = D.toNumber(d);
  const s = new Intl.NumberFormat(locale === 'en' ? 'en-CA' : 'fr-CA', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  return locale === 'en' ? `$${s}` : `${s}${NBSP}$`;
}
/** |a − b| / b in basis points, 2 decimals; null when b is not positive */
export function bpsBetween(a: Dec, b: Dec): Dec | null {
  if (!D.isPos(b)) return null;
  return D.div(D.mul(D.abs(D.sub(a, b)), TEN_K), b, 2, 'half_even');
}
/** funding rate per hour from a rate per `intervalSec` */
export function fundingPerHour(rate: DecStr | null, intervalSec: number): Dec | null {
  const r = dec(rate);
  if (!r || !(intervalSec > 0)) return null;
  return D.div(D.mul(r, D.from(3600n)), D.from(BigInt(Math.round(intervalSec))), 12, 'half_even');
}
/** user input → canonical decimal string: accepts « 1 234,5 », "1,234.5", "0.01"; null when it is not a non-negative decimal */
export function parseInput(raw: string): DecStr | null {
  let s = raw.trim().replace(/[\s  ']/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;
  if (s.startsWith('.')) s = `0${s}`;
  if (s.endsWith('.')) s = s.slice(0, -1);
  s = s.replace(/^0+(?=\d)/, '');
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return D.isValid(s) ? s : null;
}
/** base size bought by `usdAmount` at `price`, rounded DOWN to the lot */
export function usdToSize(usdAmount: Dec, price: Dec, lot: Dec): Dec {
  if (!D.isPos(price)) return D.zero;
  return D.quantize(D.div(usdAmount, price, 18, 'down'), lot, 'down');
}
/**
 * Worst acceptable price of a market-like order: `ref` moved by `slippageBps` against the taker, kept on the tick and INSIDE the
 * bound (a buy rounds down, a sell rounds up), never below one tick.
 */
export function worstPrice(ref: Dec, side: 'buy' | 'sell', slippageBps: number, tick: Dec): Dec {
  const k = D.from(BigInt(Math.round(slippageBps)));
  const moved = side === 'buy' ? D.div(D.mul(ref, D.add(TEN_K, k)), TEN_K, 18, 'down') : D.div(D.mul(ref, D.sub(TEN_K, k)), TEN_K, 18, 'up');
  const q = D.quantize(moved, tick, side === 'buy' ? 'down' : 'up');
  return D.isPos(q) ? q : tick;
}
/** a price put on the tick (nearest below) */
export const onTick = (p: Dec, tick: Dec): Dec => D.quantize(p, tick, 'down');
/** decimals to SHOW for a price: at most the tick's, and about six significant digits (GMX ticks have 22 decimals) */
export function priceDp(tick: DecStr | null | undefined, ref: DecStr | null | undefined): number {
  const r = dec(ref), max = dpOf(tick);
  if (!r) return Math.min(max, 2);
  const int = D.str(D.abs(D.div(r, D.one, 0, 'down'))).replace(/^0$/, '').length;
  return Math.max(0, Math.min(max, 6 - int));
}
/** smallest price step actually present between adjacent levels (never below the tick): the book's natural grouping */
export function naturalStep(levels: readonly (readonly [DecStr, DecStr])[][], tick: DecStr): DecStr {
  const tk = dec(tick);
  let best: Dec | null = null;
  for (const side of levels) for (let i = 1; i < Math.min(side.length, 12); i++) {
    const a = dec(side[i - 1]![0]), b = dec(side[i]![0]); if (!a || !b) continue;
    const d = D.abs(D.sub(a, b));
    if (D.isPos(d) && (!best || D.lt(d, best))) best = d;
  }
  if (!best) return tk && D.isPos(tk) ? D.str(tk) : '1';
  return D.str(tk && D.isPos(tk) && D.lt(best, tk) ? tk : best);
}

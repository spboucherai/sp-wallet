/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/money.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

/**
 * NEXT — fiat figures as TEXT. The server computes every total with integer arithmetic and sends decimal strings
 * (`summary.total`, `byAsset[].value`, history points): they are written in the owner's language digit for digit
 * (amount.ts `formatAmount`), never through a float. The one product the client still makes — a row's amount × its price —
 * is exact decimal arithmetic on BigInt, truncated (never rounded up). `Number()` is used for chart geometry only.
 * No React, no DOM: tested in test/next-money.test.ts.
 */
import { formatAmount, type AmountLocale } from './amount';

const loc = (locale: string): string => (locale === 'fr' ? 'fr-CA' : 'en-CA');
const lang = (locale: string): AmountLocale => (locale === 'fr' ? 'fr' : 'en');
/** a canonical decimal string (`-?digits[.digits]`)? */
export const isDecimal = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

// where the currency sign goes around the number, as Intl writes it for this language (« 1,00 $ US », "US$1.00"): asked once
const frames = new Map<string, [string, string]>();
function frame(cur: string, locale: string): [string, string] {
  const k = `${cur}|${locale}`; let f = frames.get(k);
  if (!f) {
    try {
      const parts = new Intl.NumberFormat(loc(locale), { style: 'currency', currency: cur }).formatToParts(0);
      const first = parts.findIndex((p) => p.type === 'integer'), last = parts.map((p) => p.type).lastIndexOf('fraction');
      f = [parts.slice(0, first).map((p) => p.value).join(''), parts.slice((last < 0 ? first : last) + 1).map((p) => p.value).join('')];
    } catch { f = ['', ` ${cur}`]; }
    frames.set(k, f);
  }
  return f;
}
export interface FiatOpts { /** decimals shown (default 2) */ dp?: number; /** write a leading + on a positive value */ sign?: boolean }
/**
 * A decimal string as money in the owner's language: « 1 234,56 $ » / "$1,234.56". Truncated to `dp` decimals when it has more
 * (a server total has exactly two). A value that is not a decimal string is returned as « — ».
 */
export function fiatText(value: string | null | undefined, cur: string, locale: string, o: FiatOpts = {}): string {
  if (!isDecimal(value)) return '—';
  const dp = o.dp ?? 2, neg = value.startsWith('-'), abs = neg ? value.slice(1) : value;
  const body = formatAmount(abs, lang(locale), { maxDecimals: dp, minDecimals: dp, trim: false }), [pre, post] = frame(cur, locale);
  const zero = !/[1-9]/.test(body);
  return `${neg && !zero ? '−' : o.sign && !zero ? '+' : ''}${pre}${body}${post}`;
}
/** a JS number the API sends for a price (never an amount), as a plain decimal string — exponent notation expanded, no rounding */
export function decimalOf(n: number | string): string | null {
  const s = typeof n === 'number' ? (Number.isFinite(n) ? String(n) : '') : n.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const exp = Number(m[4] ?? 0); if (!Number.isInteger(exp) || Math.abs(exp) > 60) return null;
  let int = m[2]!, frac = m[3] ?? '';
  if (exp > 0) { const take = frac.slice(0, exp).padEnd(exp, '0'); int += take; frac = frac.slice(exp); }
  else if (exp < 0) { const pad = int.padStart(-exp + 1, '0'); frac = pad.slice(pad.length + exp) + frac; int = pad.slice(0, pad.length + exp); }
  int = int.replace(/^0+(?=\d)/, ''); frac = frac.replace(/0+$/, '');
  return `${m[1]}${int}${frac ? `.${frac}` : ''}`;
}
const split = (d: string): { neg: boolean; digits: bigint; scale: number } => { const neg = d.startsWith('-'), [i = '0', f = ''] = (neg ? d.slice(1) : d).split('.'); return { neg, digits: BigInt(i + f), scale: f.length }; };
/** a × b, exact, written with `dp` decimals, truncated toward zero. null when either is not a decimal. */
export function mulDecimal(a: string | null | undefined, b: number | string | null | undefined, dp = 2): string | null {
  const y = b === null || b === undefined ? null : decimalOf(b);
  if (!isDecimal(a) || y === null) return null;
  const p = split(a), q = split(y), neg = p.neg !== q.neg, scale = p.scale + q.scale, prod = p.digits * q.digits;
  const cut = scale > dp ? prod / 10n ** BigInt(scale - dp) : prod * 10n ** BigInt(dp - scale);
  const t = cut.toString().padStart(dp + 1, '0'), out = dp ? `${t.slice(0, -dp)}.${t.slice(-dp)}` : t;
  return `${neg && cut !== 0n ? '-' : ''}${out}`;
}
/** a + b for two decimal strings (exact) */
export function addDecimal(a: string, b: string): string {
  const p = split(a), q = split(b), scale = Math.max(p.scale, q.scale);
  const v = (p.neg ? -1n : 1n) * p.digits * 10n ** BigInt(scale - p.scale) + (q.neg ? -1n : 1n) * q.digits * 10n ** BigInt(scale - q.scale);
  const neg = v < 0n, t = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${scale ? `${t.slice(0, -scale)}.${t.slice(-scale)}` : t}`;
}
/** −1, 0 or 1: the sign of a decimal string (0 for anything else) */
export const signOf = (v: string | null | undefined): -1 | 0 | 1 => (!isDecimal(v) || !/[1-9]/.test(v) ? 0 : v.startsWith('-') ? -1 : 1);
/** compares two non-negative decimal strings by value (for sorting rows by fiat value without a float) */
export function cmpDecimal(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const p = split(a), q = split(b), s = Math.max(p.scale, q.scale);
  const x = (p.neg ? -1n : 1n) * p.digits * 10n ** BigInt(s - p.scale), y = (q.neg ? -1n : 1n) * q.digits * 10n ** BigInt(s - q.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** a share or a change as a percentage in the owner's language (a ratio is not money: a number is fine) — « 12,5 % » */
export const pctText = (n: number, locale: string, max = 2, min = 0, sign = false): string => {
  const body = new Intl.NumberFormat(loc(locale), { maximumFractionDigits: max, minimumFractionDigits: Math.min(min, max) }).format(Math.abs(n));
  const zero = !/[1-9]/.test(body);
  return `${n < 0 && !zero ? '−' : sign && !zero ? '+' : ''}${body}${locale === 'fr' ? ' %' : '%'}`;
};

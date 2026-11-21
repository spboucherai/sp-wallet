/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/amount.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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
 * Amounts typed and shown by the owner — ONE rule for the whole web app (v8 hardening, item D1). Strings only: no float, no
 * Number(), amounts keep their 18 decimals. Nothing here changes what the API receives: a canonical decimal string
 * (`digits[.digits]`, point as the decimal separator, no grouping, no sign, no exponent).
 *
 * DISPLAY — `formatAmount(canonical, locale)`
 *   French : decimal comma, thousands grouped with a no-break space (U+00A0)   « 1 234,5 »
 *   English: decimal point, thousands grouped with a comma                      "1,234.5"
 *   Truncated (never rounded up) to `maxDecimals`; trailing zeros dropped unless `trim: false`.
 *
 * INPUT — `parseAmountInput(text, locale)` → `{ ok: true, value }` or `{ ok: false, error }`. Both the comma and the point are
 * accepted in both languages. The rule, in order:
 *   1. Allowed characters: digits, ',', '.', and the "soft" grouping marks — a space (U+0020, U+00A0, U+202F, U+2009) or an
 *      apostrophe (' or ’). Anything else (a sign, an exponent, a letter) is `invalid`.
 *   2. A soft grouping mark is only ever a thousands separator: it must sit in the integer part and cut it into groups of
 *      exactly three digits after a first group of one to three (« 1 000 000 »). Otherwise `invalid`.
 *   3. Comma AND point both present: the one that comes LAST is the decimal separator and must occur once; the other is a
 *      thousands separator and must cut proper groups of three ("1,234.5" and « 1.234,5 » → 1234.5). Otherwise `invalid`.
 *   4. Only one of them, several times: thousands separators, proper groups of three required ("1,000,000" → 1000000).
 *   5. Only one of them, once:
 *        a. it is the decimal separator of the screen's language (',' in French, '.' in English) → decimal.
 *           « 1,000 » in French and "1.000" in English are ONE (with three decimals), as everywhere else on that screen.
 *        b. it is the OTHER mark, and the text has the exact shape of a thousands group — one to three digits not starting
 *           with 0, the mark, exactly three digits ("1,000" in English, « 1.000 » in French, "12,345", "999.999") → refused
 *           as `ambiguous`: it could be one thousand or one. The wallet never guesses; the owner retypes it
 *           (« 1000 », « 1,0 », « 1 000 »).
 *        c. it is the other mark and the shape cannot be a thousands group ("1,5", "0,001", "1,0001", "1234.567", ".5",
 *           or soft grouping is already used: « 1 000.50 ») → decimal.
 *   6. The value: grouping removed, a missing integer part becomes 0 (".5" → "0.5"), a trailing separator is dropped
 *      ("5." → "5"), redundant leading zeros are dropped ("007" → "7"). Fractional digits are kept exactly as typed
 *      (« 1 000,50 » → "1000.50"), so an amount that was already sent as typed is sent unchanged.
 *   7. `maxDecimals` (the asset's decimals): more significant decimals than that is `too_many_decimals` — never truncated
 *      silently; trailing zeros beyond it are dropped.
 *
 * An input field shows what the owner typed (`sanitizeAmountText` only removes characters that can never be part of an
 * amount). A value the app itself puts in a field (Max, a suggestion) goes through `amountInputText`, which writes it with
 * the screen's decimal separator and no grouping, so that rule 5a reads it back exactly.
 */
export type AmountLocale = 'fr' | 'en';
export type AmountError = 'empty' | 'invalid' | 'ambiguous' | 'too_many_decimals';
export type ParsedAmount = { ok: true; value: string } | { ok: false; error: AmountError };

const NBSP = ' ';
const SPACES = '    ';
const APOS = "'’";
const ALLOWED = new RegExp(`^[0-9.,${SPACES}${APOS}]+$`);
const NOT_ALLOWED = new RegExp(`[^0-9.,${SPACES}${APOS}]`, 'g');
const SOFT = new RegExp(`[${SPACES}${APOS}]`);
const count = (s: string, ch: string): number => s.split(ch).length - 1;
const fail = (error: AmountError): ParsedAmount => ({ ok: false, error });

/** digits of an integer part written with thousands separators, or null when the groups are not 1–3 digits then threes */
function ungroup(int: string, hard: ',' | '.' | null): string | null {
  const soft = SOFT.test(int), hasHard = hard !== null && int.includes(hard);
  if (!soft && !hasHard) return /^\d*$/.test(int) ? int : null;
  if (soft && hasHard) return null;                                         // « 1 000,000.5 »: two grouping styles at once
  let groups: string[];
  if (hasHard) groups = int.split(hard!);
  else {
    const marks = int.replace(/\d/g, '');
    const kind = (c: string) => (APOS.includes(c) ? 'a' : 's');             // every kind of space is the same separator
    if (new Set([...marks].map(kind)).size > 1) return null;
    groups = int.split(SOFT);
  }
  if (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
  return groups.join('');
}

export function parseAmountInput(text: string, locale: AmountLocale, opts: { maxDecimals?: number } = {}): ParsedAmount {
  const s = text.trim();
  if (s === '') return fail('empty');
  if (!ALLOWED.test(s) || !/\d/.test(s)) return fail('invalid');
  const commas = count(s, ','), dots = count(s, '.');
  let decSep: ',' | '.' | null = null, hard: ',' | '.' | null = null;
  if (commas > 0 && dots > 0) {                                             // rule 3
    decSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'; hard = decSep === ',' ? '.' : ',';
    if (count(s, decSep) !== 1) return fail('invalid');
  } else if (commas + dots > 1) hard = commas ? ',' : '.';                   // rule 4
  else if (commas + dots === 1) {                                           // rule 5
    const c = commas ? ',' : '.', [a = '', b = ''] = s.split(c);
    if (c !== (locale === 'fr' ? ',' : '.') && !SOFT.test(s) && /^[1-9]\d{0,2}$/.test(a) && /^\d{3}$/.test(b)) return fail('ambiguous');
    decSep = c;
  }
  const cut = decSep === null ? -1 : s.indexOf(decSep);
  const intRaw = cut < 0 ? s : s.slice(0, cut), frac = cut < 0 ? '' : s.slice(cut + 1);
  if (!/^\d*$/.test(frac)) return fail('invalid');
  const digits = ungroup(intRaw, hard);
  if (digits === null || (digits === '' && frac === '')) return fail('invalid');
  const int = (digits === '' ? '0' : digits).replace(/^0+(?=\d)/, '');
  let f = frac;
  if (opts.maxDecimals !== undefined && f.length > opts.maxDecimals) {
    if (f.replace(/0+$/, '').length > opts.maxDecimals) return fail('too_many_decimals');
    f = f.slice(0, opts.maxDecimals);
  }
  return { ok: true, value: f ? `${int}.${f}` : int };
}

/** the canonical string of a typed amount, or null (empty, invalid or ambiguous) */
export const amountOf = (text: string, locale: AmountLocale, opts: { maxDecimals?: number } = {}): string | null => {
  const r = parseAmountInput(text, locale, opts);
  return r.ok ? r.value : null;
};
/** why a typed amount is refused, or null when it is empty (nothing to say yet) or valid */
export const amountProblem = (text: string, locale: AmountLocale, opts: { maxDecimals?: number } = {}): Exclude<AmountError, 'empty'> | null => {
  const r = parseAmountInput(text, locale, opts);
  return r.ok || r.error === 'empty' ? null : r.error;
};

export interface FormatAmountOpts { /** decimals kept at most — truncated, never rounded up (default: all) */ maxDecimals?: number; /** decimals shown at least */ minDecimals?: number; /** drop trailing zeros (default true) */ trim?: boolean; /** group thousands (default true) */ group?: boolean }
/**
 * A canonical decimal string in the owner's language. A value that is not a canonical decimal ('?', '—', '') is returned as
 * it is, so the helper can wrap any server "display" field.
 */
export function formatAmount(canonical: string, locale: AmountLocale, o: FormatAmountOpts = {}): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(canonical);
  if (!m) return canonical;
  const fr = locale === 'fr';
  let f = m[3] ?? '';
  if (o.maxDecimals !== undefined) f = f.slice(0, o.maxDecimals > 0 ? o.maxDecimals : 0);
  if (o.trim !== false) f = f.replace(/0+$/, '');
  if (o.minDecimals !== undefined) f = f.padEnd(o.minDecimals, '0');
  const int = o.group === false ? m[2]! : m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, fr ? NBSP : ',');
  const body = f ? `${int}${fr ? ',' : '.'}${f}` : int;
  return `${m[1] && /[1-9]/.test(body) ? '−' : ''}${body}`;
}
/** a canonical value as the text of an input field: the screen's decimal separator, no grouping, every digit kept */
export const amountInputText = (canonical: string, locale: AmountLocale): string => (/^\d+(\.\d*)?$/.test(canonical) && locale === 'fr' ? canonical.replace('.', ',') : canonical);
/** what an amount field keeps of what is typed or pasted: digits, comma, point, grouping spaces and apostrophes */
export const sanitizeAmountText = (text: string): string => text.replace(NOT_ALLOWED, '');

// ---- the language of the screen, for the few pure helpers that have no access to the React context (`trimAmt` in ui.tsx,
// `parseInput` in derivatives/dec.ts). `App` sets it on every render, before any screen draws. Default 'en' = the canonical
// form these helpers produced before, so a test or a script that never sets it sees no change.
let current: AmountLocale = 'en';
export const setAmountLocale = (l: string): void => { current = l === 'fr' ? 'fr' : 'en'; };
export const amountLocale = (): AmountLocale => current;

// v8 hardening (D1): what an amount field says when the typed text cannot be read by the wallet's rule (amount.ts).
// Nothing is said for an empty field, and nothing is ever guessed: the action button stays disabled until the text is clear.
import { useContext } from 'react';
import { amountProblem } from './amount';
import { I18n, useT, type Key } from './i18n';

const KEY: Record<'invalid' | 'ambiguous' | 'too_many_decimals', Key> = { invalid: 'hdAmtInvalid', ambiguous: 'hdAmtAmbiguous', too_many_decimals: 'hdAmtDecimals' };

/** the sentence under an amount field, or nothing */
export function AmountProblem({ text, maxDecimals, ambiguousOnly }: { text: string; maxDecimals?: number; /** the field already has its own « invalid » sentence */ ambiguousOnly?: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const p = amountProblem(text, locale, maxDecimals === undefined ? {} : { maxDecimals });
  if (!p || (ambiguousOnly && p !== 'ambiguous')) return null;
  return <span role="alert" data-testid="amount-problem" data-problem={p} className="mt-1.5 block text-[12.5px] leading-snug text-danger">{t(KEY[p], { text: text.trim(), n: maxDecimals ?? 0 })}</span>;
}

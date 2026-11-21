/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/amountUi.tsx
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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
  return <span role="alert" data-testid="amount-problem" data-problem={p} className="mt-1.5 block text-[0.78125rem] leading-snug text-danger">{t(KEY[p], { text: text.trim(), n: maxDecimals ?? 0 })}</span>;
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/private-markets/references.ts
 * Module           : private-markets
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Private Markets — last known PRIVATE valuations (reference data, not market data).
//
// Copied from Appendix B of docs/v11/research/private-markets.md (read 2026-11-15). Each figure keeps its kind, date, source
// URL and confidence: a primary round, a tender, a press estimate and an IPO price range are different things and are never
// merged. NO fully diluted share count is recorded: the dossier found none that is publishable (Anthropic: Entropy's estimate
// of 17 498 334 025 could not be matched to the S-1/A, CNBC's figure implies about 18.0 B; OpenAI and Polymarket: none
// public; Oura: not extracted). Per-share contracts therefore get no implied valuation.
import type { PrivateValuation } from '@spw/trading';

export type ReferenceKind = 'primary_round' | 'tender' | 'secondary_estimate' | 'ipo_range' | 'press_estimate';
export interface ReferenceValuation {
  company: string;                 // slug of COMPANIES (contracts.ts)
  /** USD; null when the source gives a price range rather than a valuation */
  valueUsd: string | null;
  kind: ReferenceKind; detail: string;
  /** ISO day, or `YYYY-MM` when the source gives the month only */
  date: string;
  sourceUrl: string; confidence: 'high' | 'medium' | 'low';
  /** post-money stated by the source (a primary round whose basis is not stated is compared as a press report) */
  postMoney: boolean;
}

export const REFERENCES_REVIEWED_AT = '2026-11-15';
export const REFERENCE_VALUATIONS: readonly ReferenceValuation[] = [
  { company: 'anthropic', valueUsd: '965000000000', kind: 'primary_round', detail: 'Series H, $65B raised, post-money', date: '2026-05-28', sourceUrl: 'https://www.anthropic.com/news/series-h', confidence: 'high', postMoney: true },
  { company: 'anthropic', valueUsd: null, kind: 'ipo_range', detail: 'IPO price range (not final, not a valuation): $70.00–$78.00 per share; 825,000,000 Class A shares offered; Nasdaq ANT; S-1/A Amendment No. 2',
    date: '2026-11-10', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2130357/000162828026072484/anthropicpbc-sx1ax2.htm', confidence: 'high', postMoney: false },
  { company: 'anthropic', valueUsd: '1405000000000', kind: 'press_estimate', detail: 'CNBC: "up to $1.405 trillion on a fully diluted basis" at the top of the IPO range (a press computation, not a company statement)',
    date: '2026-11-10', sourceUrl: 'https://www.cnbc.com/2026/11/10/anthropic-sets-price-range-of-70-to-78-in-upcoming-ipo.html', confidence: 'medium', postMoney: false },
  { company: 'openai', valueUsd: '852000000000', kind: 'primary_round', detail: '$122B committed capital, post-money', date: '2026-03-31', sourceUrl: 'https://openai.com/index/accelerating-the-next-phase-ai', confidence: 'high', postMoney: true },
  { company: 'openai', valueUsd: '852000000000', kind: 'tender', detail: 'about $7B employee buyback funded by the company, valuation unchanged (sourced to unnamed people)', date: '2026-08-11',
    sourceUrl: 'https://www.techtimes.com/articles/323952/20260811/openai-completes-7b-employee-buyback-holds-852b-value-investor-cash-not-earnings.htm', confidence: 'medium', postMoney: false },
  { company: 'openai', valueUsd: '1250000000000', kind: 'primary_round', detail: '$11B first close of a round of up to $20B; reported by unnamed sources; the company declined to comment; pre- or post-money not stated', date: '2026-11-06',
    sourceUrl: 'https://www.bloomberg.com/news/articles/2026-11-06/openai-completes-11-billion-portion-of-funding-at-1-25-trillion-value', confidence: 'medium', postMoney: false },
  { company: 'oura', valueUsd: '11000000000', kind: 'primary_round', detail: '$900M Series E (secondary write-up; the original release was not fetched)', date: '2025-10', sourceUrl: 'https://allium.so/blog/oura-ipo-valuation-from-11b-to-a-postponed-deal', confidence: 'medium', postMoney: false },
  { company: 'oura', valueUsd: '15620000000', kind: 'ipo_range', detail: 'fully diluted at the $40–$44 IPO range, 50M shares (Reuters via Quartz); the offering was postponed on 2026-09-29', date: '2026-09-21',
    sourceUrl: 'https://qz.com/oura-smart-ring-ipo-nasdaq-valuation-092126', confidence: 'medium', postMoney: false },
  { company: 'polymarket', valueUsd: '21000000000', kind: 'primary_round', detail: '$1B round led by 1789 Capital, post-money, reported by people familiar with the matter', date: '2026-08-31',
    sourceUrl: 'https://www.bloomberg.com/news/articles/2026-08-31/polymarket-funding-round-led-by-1789-values-firm-at-21-billion', confidence: 'medium', postMoney: true },
];

export const referencesOf = (company: string): ReferenceValuation[] => REFERENCE_VALUATIONS.filter((r) => r.company === company);
const day = (d: string): string => (d.length === 7 ? `${d}-01` : d);

/**
 * The "last known private valuation" of a company: the most recent figure that is a transaction in the company's own
 * shares (a primary round or a tender) and states a valuation. IPO ranges and press estimates are shown next to it, never
 * used as the reference of a premium.
 */
export function lastPrivateValuation(company: string): ReferenceValuation | null {
  const c = referencesOf(company).filter((r) => r.valueUsd !== null && (r.kind === 'primary_round' || r.kind === 'tender'));
  return c.sort((a, b) => (day(a.date) < day(b.date) ? 1 : day(a.date) > day(b.date) ? -1 : 0))[0] ?? null;
}

/** the reference as the valuation engine of @spw/trading takes it (a month-only date is passed as its first day) */
export function toTradingReference(r: ReferenceValuation): PrivateValuation {
  if (r.valueUsd === null) throw new Error('a reference without a valuation cannot be compared');
  return { value: r.valueUsd, date: day(r.date), source: r.sourceUrl,
    kind: r.kind === 'tender' ? 'tender_offer' : r.kind === 'secondary_estimate' ? 'secondary_market' : r.kind === 'primary_round' ? (r.postMoney ? 'priced_round_post_money' : 'press_report') : r.kind === 'press_estimate' ? 'press_report' : 'other' };
}

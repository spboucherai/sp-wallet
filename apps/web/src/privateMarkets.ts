/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/privateMarkets.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-16
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

// V11 Private Markets — the model of the screen (screens/PrivateMarkets.tsx): the shapes the API answers
// (services/api/src/private-markets/service.ts) and the pure helpers that turn them into what is shown. No React here: the
// helpers are tested on their own (test/private-markets.test.ts).
import { formatAmount, type AmountLocale } from './amount';
import type { Key } from './i18n';

export type UnitKind = 'usd_per_share' | 'valuation_usd_billions' | 'unknown';
export type ReviewStateCode = 'reviewed' | 'under_review' | 'not_reviewed';
export interface Datum { value: string | null; source: string; ts: number | null; stale: boolean }
export interface PmPosition { side: 'long' | 'short'; size: string }
export interface PmCaveat { code: string; text: string; data?: Record<string, unknown> }
export interface PmReference { company?: string; valueUsd?: string | null; value?: string; kind: string; detail: string; date: string; sourceUrl: string; confidence: 'high' | 'medium' | 'low' }
export interface PmValuation {
  syntheticPrice: Datum & { unit: UnitKind; unitLabel: string; priceKind: 'mark' | 'frozen mark' };
  contractMarketValue: { value: string | null; formula: string | null; reason: string | null; source: string | null; ts: number | null };
  notionalExposure: { value: string | null; formula: string | null; reason: string | null; position: PmPosition; hypothetical: true; ts: number | null };
  impliedValuation: { value: string | null; formula: string | null; formulaId: string | null; formulaSource: { url: string; quote: string; readAt: string } | null; asOf: number | null; label: string | null; reason: string | null; reasonCode: string | null };
  lastPrivateValuation: (PmReference & { value: string }) | null; lastPrivateValuationReason: string | null;
  premiumDiscount: { premiumBps: string | null; reason: string | null; caveat: string | null };
  caveats: PmCaveat[];
}
export interface PmMarket {
  id: string; venue: string; platform: string; operator: string | null; symbol: string; company: { slug: string; name: string } | null;
  status: 'live' | 'delisted' | 'halted' | 'reduce_only';
  review: { state: ReviewStateCode; reasons: string[]; reviewedAt: string | null; validUntil: string | null; fingerprintChecked: boolean };
  contract: { nature: string; unit: { kind: UnitKind; label: string }; quoteCurrency: string; collateral: string | null; underlying: string | null; contractSize: string; multiplier: { value: string; source: string } | null;
    settlement: string; ipoConversion: string; oracle: string; liquidation: string; maxLeverage: string | null; margin: string | null; lotSize: string | null; szDecimals: number | null; fundingIntervalSec: number | null;
    assetId: number | null; dex: string | null; oiCapUsd: string | null; fundingMultiplier: string | null; onChainDescription: string | null; unconfirmedConvention: { text: string; url: string } | null; sources: string[] };
  market: { price: Datum; oracle: Datum; mid: Datum; funding: Datum & { intervalSec: number | null }; openInterest: Datum; openInterestUsd: Datum; volume24h: Datum; volumeBase24h: Datum; frozen: boolean };
  valuation: PmValuation; tradable: false; notTradable: { code: string; reasons: string[] }; error: string | null;
}
export interface PmDivergence { unit: UnitKind; unitLabel: string; contracts: { id: string; price: string; ts: number | null }[]; spreadBps: string; note: string }
export interface PmCompany { slug: string; name: string; note: string | null; contracts: string[]; lastPrivateValuation: PmValuation['lastPrivateValuation']; divergence: PmDivergence[] }
export interface PmVenue { venue: string; name: string; status: 'ok' | 'stale' | 'error'; error: string | null; ts: number | null; instruments: number }
export interface PmList {
  markets: PmMarket[]; companies: PmCompany[]; excluded: { id: string; company: string; reason: string; liveCategory: string | null }[]; venues: PmVenue[];
  venuesWithoutAdapter: { venue: string; note: string }[]; notice: { tradable: false; code: string; text: string }; filter: { delisted: boolean }; position: PmPosition; ts: number;
}
export interface PmBook { bids?: [string, string][]; asks?: [string, string][]; ts?: number; stale?: boolean; source?: string; error?: string }
export interface PmCandles { interval?: string; candles?: { ts: number; close: string }[]; ts?: number; stale?: boolean; source?: string; error?: string }
export interface PmDetail {
  market: PmMarket; book: PmBook; candles: PmCandles; references: PmReference[]; company: PmCompany | null;
  sameCompany: { id: string; platform: string; price: Datum; unit: { kind: UnitKind; label: string }; review: ReviewStateCode }[]; notice: PmList['notice']; position: PmPosition; ts: number;
}

/** route ↔ path: `/private-markets`, `/private-markets/<venue:symbol>`, `?v=delisted` */
export const pmPath = (id?: string, delisted?: boolean): string => `/private-markets${id ? `/${encodeURIComponent(id)}` : ''}${delisted ? '?v=delisted' : ''}`;
/** API paths (relative to /api/v1) */
export const pmListQuery = (delisted: boolean): string => `/private-markets${delisted ? '?delisted=true' : ''}`;
export const SIZE_RE = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
/** a typed size → the canonical string the API accepts, or null (the request is not sent) */
export function sizeParam(text: string): string | null {
  const s = text.trim().replace(',', '.');
  return SIZE_RE.test(s) && /[1-9]/.test(s) ? s : null;
}
export const pmDetailQuery = (id: string, p: PmPosition): string => `/private-markets/${encodeURIComponent(id)}?size=${encodeURIComponent(p.size)}&side=${p.side}`;

/** the badge next to a price: what the price is a price OF. A contract whose definition is not confirmed never shows a unit. */
export function unitBadge(m: Pick<PmMarket, 'review' | 'contract'>): { key: Key; tone: 'info' | 'mute' | 'warn' } {
  if (m.review.state === 'not_reviewed') return { key: 'pmUnitNotReviewed', tone: 'warn' };
  if (m.review.state === 'under_review') return { key: 'pmUnitUnderReview', tone: 'warn' };
  return m.contract.unit.kind === 'usd_per_share' ? { key: 'pmUnitShare', tone: 'info' } : m.contract.unit.kind === 'valuation_usd_billions' ? { key: 'pmUnitValuation', tone: 'info' } : { key: 'pmUnitUnknown', tone: 'mute' };
}
const NO_VALUATION: Record<string, Key> = { not_reviewed: 'pmWhy_not_reviewed', under_review: 'pmWhy_under_review', per_share_no_share_count: 'pmWhy_per_share', unit_not_published: 'pmWhy_unit_not_published',
  delisted_frozen: 'pmWhy_delisted', no_price: 'pmWhy_no_price', no_formula: 'pmWhy_no_formula' };
/** why no valuation is derived, in the screen's language (the server's detailed sentence, in English, is shown under it) */
export const noValuationKey = (code: string | null): Key => NO_VALUATION[code ?? ''] ?? 'pmWhy_no_formula';
const REF_KIND: Record<string, Key> = { primary_round: 'pmKind_primary_round', tender: 'pmKind_tender', secondary_estimate: 'pmKind_secondary', ipo_range: 'pmKind_ipo_range', press_estimate: 'pmKind_press' };
export const referenceKindKey = (kind: string): Key => REF_KIND[kind] ?? 'pmKind_other';
const CAVEAT: Record<string, Key> = { synthetic: 'pmCav_synthetic', arithmetic: 'pmCav_arithmetic', thin_market: 'pmCav_thin', cross_venue: 'pmCav_cross', unit_mismatch: 'pmCav_units', frozen: 'pmCav_frozen',
  unconfirmed_convention: 'pmCav_convention', company_note: 'pmCav_company', reference_kind: 'pmCav_reference', stale: 'pmCav_stale' };
/** v11 interface: why a contract cannot be traded from this wallet, by the server's code (`notTradable.code`) */
const NOT_TRADABLE: Record<string, Key> = { builder_dex_read_only: 'v11LoPmNT_builder_dex_read_only', venue_restricted: 'v11LoPmNT_venue_restricted' };
export const notTradableKey = (code: string | null | undefined): Key => NOT_TRADABLE[code ?? ''] ?? 'v11LoPmNT_other';
export const caveatKey = (code: string): Key => CAVEAT[code] ?? 'pmCav_other';
/** caveats that change how a figure must be read come first; the two standing ones last */
export function orderCaveats(list: PmCaveat[]): PmCaveat[] {
  const rank = (c: string) => ['frozen', 'stale', 'thin_market', 'cross_venue', 'unit_mismatch', 'unconfirmed_convention', 'company_note', 'reference_kind'].indexOf(c);
  return [...list].sort((a, b) => (rank(a.code) < 0 ? 99 : rank(a.code)) - (rank(b.code) < 0 ? 99 : rank(b.code)));
}

const nf = (locale: string, max: number, min = 0) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: max, minimumFractionDigits: min });
/** a USD figure, compact: billions from 1e9 (« 1 776,6 G$ » / "$1,776.6B"), millions, thousands — the exact figure is given next to it where it matters */
export function compactUsd(value: string | null, locale: string): string {
  if (value === null) return '—';
  const n = Number(value), a = Math.abs(n), fr = locale === 'fr', sign = n < 0 ? '−' : '';
  if (!Number.isFinite(n)) return '—';
  const [div, f, e] = a >= 1e9 ? [1e9, 'G$', 'B'] : a >= 1e6 ? [1e6, 'M$', 'M'] : a >= 1e4 ? [1e3, 'k$', 'k'] : [1, '$', ''];
  const body = nf(locale, div === 1 ? 2 : a / div >= 100 ? 1 : 2).format(a / div);
  return fr ? `${sign}${body} ${f}` : `${sign}$${body}${e}`;
}
/** a contract price in its own unit: at most `max` decimals (truncated, never rounded up), grouped for the language */
export const priceText = (value: string | null, locale: AmountLocale, max = 4): string => (value === null ? '—' : formatAmount(value, locale, { maxDecimals: max }));
/** basis points → a signed percentage: "8410.3627" → « +84,10 % » */
export function premiumText(bps: string | null, locale: string): string {
  if (bps === null) return '—';
  const pct = Number(bps) / 100;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${nf(locale, 2, 2).format(Math.abs(pct))}${locale === 'fr' ? ' %' : '%'}`;
}
/** funding per interval → a percentage with its interval: « 0,00016 % / 1 h » */
export function fundingText(f: Datum & { intervalSec: number | null }, locale: string): string {
  if (f.value === null) return '—';
  const pct = nf(locale, 5).format(Number(f.value) * 100), h = f.intervalSec ? f.intervalSec / 3600 : null;
  return `${Number(f.value) > 0 ? '+' : ''}${pct}${locale === 'fr' ? ' %' : '%'}${h ? ` / ${h} h` : ''}`;
}
/** age of a datum: « il y a 12 s », "3 min ago"; null when the datum has no time */
export function ageText(ts: number | null, now: number, locale: string): string | null {
  if (ts === null) return null;
  const s = Math.max(0, Math.round((now - ts) / 1000)), fr = locale === 'fr';
  const v = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} ${fr ? 'j' : 'd'}`;
  return fr ? `il y a ${v}` : `${v} ago`;
}
/** freshness of a row: frozen (delisted) > error > stale > fresh — a word and a tone, never a colour alone */
export function freshness(m: Pick<PmMarket, 'market' | 'error'>): { key: Key; tone: 'ok' | 'warn' | 'danger' | 'mute' } {
  if (m.market.frozen) return { key: 'pmFrozen', tone: 'mute' };
  if (m.market.price.value === null) return { key: 'pmNoData', tone: 'danger' };
  return m.market.price.stale ? { key: 'pmStale', tone: 'warn' } : { key: 'pmFresh', tone: 'ok' };
}
/** the companies of the list, each with its contracts (never merged); contracts whose company is not identified come last, under `null` */
export function groupByCompany(list: Pick<PmList, 'markets' | 'companies'>): { company: PmCompany | null; markets: PmMarket[] }[] {
  const out: { company: PmCompany | null; markets: PmMarket[] }[] = list.companies.map((c) => ({ company: c, markets: list.markets.filter((m) => m.company?.slug === c.slug) }));
  const rest = list.markets.filter((m) => !m.company);
  if (rest.length) out.push({ company: null, markets: rest });
  return out.filter((g) => g.markets.length > 0);
}
/** the five quantities of the valuation panel, in their fixed order — each one a separate line with its own value or its own reason */
export type QuantityId = 'price' | 'contract' | 'exposure' | 'implied' | 'private';
export interface Quantity { id: QuantityId; n: 1 | 2 | 3 | 4 | 5; label: Key; has: boolean; reason: string | null }
export function quantities(v: PmValuation): Quantity[] {
  return [
    { id: 'price', n: 1, label: 'pmQ1', has: v.syntheticPrice.value !== null, reason: null },
    { id: 'contract', n: 2, label: 'pmQ2', has: v.contractMarketValue.value !== null, reason: v.contractMarketValue.reason },
    { id: 'exposure', n: 3, label: 'pmQ3', has: v.notionalExposure.value !== null, reason: v.notionalExposure.reason },
    { id: 'implied', n: 4, label: 'pmQ4', has: v.impliedValuation.value !== null, reason: v.impliedValuation.reason },
    { id: 'private', n: 5, label: 'pmQ5', has: v.lastPrivateValuation !== null, reason: v.lastPrivateValuationReason },
  ];
}
export const hostOf = (url: string): string => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

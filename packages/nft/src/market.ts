/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/nft/src/market.ts
 * Module           : nft
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// SP Wallet — NFT market data model, version 1 (delivery 3: READ only; docs/nft/NFT-BRIEF.md §6, §8, §9; NFT-ARCHITECTURE.md §8).
//
// Rules this file encodes:
//  - a market value is never chain truth: it carries the stamp of the source that reported it (category `market`), or — for a
//    sale SP Wallet decoded itself from a transaction — the stamp `computed` with the name of the decoder;
//  - the five price notions are five different fields and are never substituted for one another: asking price (a live listing),
//    best offer, last sale (reported by a source), collection floor (a statistic of a collection — never the value of an item),
//    realised sale (a payment linked to a transfer in ONE transaction);
//  - an amount is an exact integer of base units (decimal STRING) of a currency identified by network + exact mint / contract
//    + decimals. A source that gives only a float is converted through its decimal TEXT (`decimalToUnits`), never through a
//    binary float product, and the price says so (`precision: 'source_decimal'`);
//  - nothing here merges sources: two sources that disagree are two rows (see `contradictions`).
// Pure: no I/O, no clock.
import type { DataSourceStamp, Known, NftCurrency } from './model.ts';

export const NFT_MARKET_MODEL_VERSION = 1;

/** `exact`: the source gave base units. `source_decimal`: the source gave a decimal number, converted digit by digit to base units. */
export type MoneyPrecision = 'exact' | 'source_decimal';
export interface MarketMoney { amount: string; currency: NftCurrency; precision: MoneyPrecision }

/** One fee line a source reports for an order or a collection — market information, not something a transaction of this wallet pays. */
export interface MarketFee { kind: 'marketplace' | 'creator_royalty' | 'other'; /** basis points when the source gives a rate */ bps: number | null; amount: MarketMoney | null; recipient: string | null; /** the source says the fee is enforced / required */ required: boolean | null }

export interface MarketListing {
  /** the source's own identifier of the order (order hash, PDA…); never used as a key across sources */
  orderId: string | null;
  /** total asked for `quantity` units */
  price: MarketMoney;
  quantity: string;
  seller: string | null;
  /** where the order lives, as the source names it (a marketplace or protocol name) */
  venue: string | null;
  protocol: { name: string; address: string | null } | null;
  createdAt: string | null; expiresAt: string | null;
  fees: MarketFee[] | null;
}
export interface MarketOffer {
  orderId: string | null; price: MarketMoney; quantity: string; bidder: string | null; venue: string | null;
  /** `item`: an offer on this item; `collection` / `trait`: an offer any matching item could accept */
  scope: 'item' | 'collection' | 'trait';
  createdAt: string | null; expiresAt: string | null; fees: MarketFee[] | null;
}
export interface MarketSale { price: MarketMoney; quantity: string; at: string | null; tx: string | null; buyer: string | null; seller: string | null; venue: string | null }

export type MarketSourceState = 'ok' | 'needs_key' | 'off' | 'not_covered' | 'error';
/** What one market source says about itself for one request. `stale`: the value was served from the cache after a failure. */
export interface MarketSourceStatus {
  provider: string; name: string; state: MarketSourceState;
  /** stable code when not ok: `provider_rate_limited`, `budget_exhausted`, `provider_unavailable`, `provider_bad_answer`, `not_found`, `chain_not_covered`, `standard_not_covered`, `not_enabled`, `no_api_key` */
  code: string | null;
  /** NAME of the variable that would turn the source on — never a value */
  unlockedBy: string | null;
  stale: boolean;
  stamp: DataSourceStamp | null;
  /** attribution the source's terms ask for */
  attribution: { text: string; url: string } | null;
}

/** How a source qualifies a collection. Only `verified` with the source NAMED may be shown as a badge; it is that source's statement. */
export interface MarketVerification { state: 'verified' | 'not_verified' | 'unknown'; /** the source's own word (e.g. `verified`, `approved`, `not_requested`) */ providerValue: string | null; by: string }

export interface ItemMarket {
  status: MarketSourceStatus;
  /** the item's page on the marketplace (opened outside SP Wallet) */
  url: string | null;
  listed: Known<boolean>;
  ask: Known<MarketListing>;
  bestOffer: Known<MarketOffer>;
  lastSale: Known<MarketSale>;
  /** the marketplace's collection identifier (slug / symbol) and name — the SOURCE's, never copied into the on-chain collection */
  collection: { slug: string; name: string | null } | null;
  collectionFloor: Known<MarketMoney>;
  verification: MarketVerification | null;
  /** flags the source reports about the item itself */
  flags: { suspicious: Known<boolean>; disabled: Known<boolean>; nsfw: Known<boolean> };
  /** only with the provider's named method; `outOf` = the number of items the rank was computed over */
  rarity: Known<{ rank: string; outOf: string | null; method: string; calculatedAt: string | null }>;
}
export interface TraitCount { value: string; count: string }
export interface CollectionTraits { /** the stated number of items the counts were computed over */ total: string; categories: { type: string; values: TraitCount[] }[] }
export interface CollectionMarket {
  status: MarketSourceStatus;
  slug: string | null; name: string | null; description: string | null; url: string | null;
  /** remote URLs as the source gives them; the API registers them with the media proxy and answers opaque ids */
  imageUrl: string | null; bannerUrl: string | null;
  verification: MarketVerification | null;
  floor: Known<MarketMoney>;
  /** one row per interval the source reports (`all`, `1d`, `7d`, `30d`); a volume in a currency, never summed across currencies */
  volumes: { interval: string; volume: MarketMoney | null; /** the figure as the source words it when its unit is named by a SYMBOL only (no network, no contract): shown as reported, never converted or summed */ reported: { value: string; symbol: string } | null; sales: string | null }[];
  listedCount: Known<string>; owners: Known<string>; totalSupply: Known<string>;
  fees: MarketFee[] | null;
  /** trait counts ONLY with a stated item total (brief §6) */
  traits: Known<CollectionTraits>;
  /** what each figure means according to the source, when it says (floor definition, volume unit…) */
  definitions: Record<string, string>;
}
export type MarketEventType = 'sale' | 'list' | 'delist' | 'offer' | 'cancel-offer' | 'accept-offer' | 'transfer' | 'mint' | 'unknown';
export interface MarketEvent {
  type: MarketEventType;
  /** the source's own event name, kept beside the normalised type */
  providerType: string;
  at: string | null; tx: string | null; index: string | null;
  from: string | null; to: string | null; quantity: string;
  price: MarketMoney | null; venue: string | null; orderId: string | null;
  /** wash / self trade as the SOURCE reports it — passed through, never filtered */
  flags: { washTrade: Known<boolean> };
  fees: MarketFee[] | null;
}
export interface Page<T> { items: T[]; cursor: string | null }

// ── currencies ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const SOL_NATIVE: NftCurrency = { network: 'solana', asset: 'native', symbol: 'SOL', decimals: 9 };
/** Same exact currency: network AND asset identifier (EVM contracts compared case-insensitively; a symbol proves nothing). */
export const sameCurrency = (a: NftCurrency, b: NftCurrency): boolean => a.network === b.network && (a.asset === b.asset || (/^0x[0-9a-fA-F]{40}$/.test(a.asset) && a.asset.toLowerCase() === b.asset.toLowerCase())) && a.decimals === b.decimals;
export const currencyId = (c: NftCurrency): string => `${c.network}:${/^0x/.test(c.asset) ? c.asset.toLowerCase() : c.asset}`;

const UNITS = /^(0|[1-9][0-9]{0,77})$/;
export const isUnits = (s: unknown): s is string => typeof s === 'string' && UNITS.test(s);
/**
 * A decimal number given as TEXT or as a JSON number → base units, exactly. A JS number is turned into its shortest decimal
 * text first (what the source's JSON contained for every value a double round-trips); exponents are expanded by hand; more
 * fractional digits than `decimals` is refused (null) rather than rounded; negative, NaN, infinite → null.
 */
export function decimalToUnits(v: unknown, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  let s: string;
  if (typeof v === 'number') { if (!Number.isFinite(v) || v < 0) return null; s = String(v); } else if (typeof v === 'string') s = v.trim(); else return null;
  const m = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(s);
  if (!m) return null;
  let int = m[1]!, frac = m[2] ?? '';
  const e = m[3] ? Number(m[3]) : 0;
  if (e > 0) { const take = frac.slice(0, e).padEnd(e, '0'); int += take; frac = frac.slice(e); }
  else if (e < 0) { const k = -e, padded = int.padStart(k + 1, '0'); frac = padded.slice(padded.length - k) + frac; int = padded.slice(0, padded.length - k); }
  frac = frac.replace(/0+$/, '');
  if (frac.length > decimals) return null;
  const out = (int + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  return UNITS.test(out) ? out : null;
}
/** base units → decimal text, exactly (no float) */
export function unitsToDecimal(amount: string, decimals: number): string {
  if (!UNITS.test(amount)) throw new Error('bad amount');
  const s = amount.padStart(decimals + 1, '0'), i = s.slice(0, s.length - decimals), f = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return f ? `${i}.${f}` : i;
}
export const money = (amount: string, currency: NftCurrency, precision: MoneyPrecision = 'exact'): MarketMoney => { if (!UNITS.test(amount)) throw new Error('bad amount'); return { amount, currency, precision }; };

// ── contradictions between sources ──────────────────────────────────────────────────────────────────────────────────────
export interface Contradiction { field: 'listed' | 'ask' | 'collection_floor' | 'verification'; providers: string[]; note: string }
/**
 * Sources are never merged or averaged. This only NAMES where two `ok` sources say different things about the same notion, so the
 * screen can say « les sources divergent » instead of choosing one. Prices are compared only when they are in the same exact currency.
 */
export function contradictions(items: ItemMarket[]): Contradiction[] {
  const ok = items.filter((i) => i.status.state === 'ok'), out: Contradiction[] = [];
  for (let a = 0; a < ok.length; a++) for (let b = a + 1; b < ok.length; b++) {
    const x = ok[a]!, y = ok[b]!, who = [x.status.provider, y.status.provider];
    if (x.listed.state === 'known' && y.listed.state === 'known' && x.listed.value !== y.listed.value) out.push({ field: 'listed', providers: who, note: 'one source reports a live listing, the other none (a marketplace only sees its own orders, or one of them lags)' });
    if (x.ask.state === 'known' && y.ask.state === 'known' && sameCurrency(x.ask.value.price.currency, y.ask.value.price.currency) && x.ask.value.price.amount !== y.ask.value.price.amount) out.push({ field: 'ask', providers: who, note: 'different asking prices: two listings on two markets, or one stale' });
    if (x.collectionFloor.state === 'known' && y.collectionFloor.state === 'known' && sameCurrency(x.collectionFloor.value.currency, y.collectionFloor.value.currency) && x.collectionFloor.value.amount !== y.collectionFloor.value.amount) out.push({ field: 'collection_floor', providers: who, note: 'each marketplace computes its floor from its own listings' });
    if (x.verification && y.verification && x.verification.state !== 'unknown' && y.verification.state !== 'unknown' && x.verification.state !== y.verification.state) out.push({ field: 'verification', providers: who, note: 'a verification badge is a statement of the marketplace that gives it' });
  }
  return out;
}

/** « 3,2 % de 8 421 items indexés »: the frequency of one trait value, with its denominator — or null when the collection's counts do not contain it. Exact to a hundredth of a percent, rounded half up on integers. */
export function traitFrequency(traits: CollectionTraits, type: string, value: string): { count: string; total: string; percent: string } | null {
  const cat = traits.categories.find((c) => c.type === type), v = cat?.values.find((x) => x.value === value);
  if (!v || !UNITS.test(v.count) || !UNITS.test(traits.total) || traits.total === '0') return null;
  const c = BigInt(v.count), t = BigInt(traits.total);
  if (c > t) return null; // a count above the stated total is not a frequency: the source's figures do not fit together
  const bp = (c * 1_000_000n / t + 50n) / 100n; // hundredths of a percent
  return { count: v.count, total: traits.total, percent: `${bp / 100n}.${(bp % 100n).toString().padStart(2, '0')}` };
}

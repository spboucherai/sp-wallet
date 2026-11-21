/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/market/opensea.ts
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

// OpenSea API v2 — market READ adapter (docs/nft/NFT-SOURCES.md §10.1). Exists only when OPENSEA_API_KEY is set; without the key
// the provider is ABSENT and reported `needs_key` (it is never called).
//
// Coded against the provider's own OpenAPI document (https://api.opensea.io/api/v2/openapi.json, OpenAPI 3.1.0 "OpenSea API"
// 2.0.0, read 2026-11-17) — field names and nesting below are that document's. NO KEY WAS AVAILABLE: of the endpoints used here,
// three answered without a key that day for an Ethereum item (Get NFT, Get collection, collection stats — recorded live in
// services/api/test/fixtures/nft/market-opensea-live.json); best listing, best offer, events and traits answered 401 and are
// tested on fixtures built from the documented schemas (market-opensea-doc.json, labelled as such). The adapter as a whole is
// therefore DOCUMENTATION-DERIVED, not verified live.
//
// What is sent upstream: chain + contract + token id (EVM) or the mint (Solana), and the marketplace's collection slug. Never
// the wallet's address. The key travels in the `x-api-key` header only — never in a URL — and is in no error, log or answer.
//
// Not established from the documentation (kept visible, never papered over):
//  - how a Solana asset is addressed in Get NFT: one documented example shows a Metaplex Core NFT whose `contract` and
//    `identifier` are both the asset address, so `/chain/solana/contract/<mint>/nfts/<mint>` is used — an inference;
//  - the payment currency of a SOLANA order is named by symbol only (`price.current.currency`): such a price is answered
//    `unknown (currency_symbol_only)` rather than attached to a mint this server would have to guess;
//  - cancellations are not in the REST events (Stream API only): `delist` / `cancel-offer` are never produced here;
//  - no wash-trade flag exists in this API: `washTrade` is `unknown`, never `false`.
import { NONE, NftProviderError, decimalToUnits, isUnits, known, money, unknown, type CollectionTraits, type Known, type MarketEvent, type MarketFee, type MarketListing, type MarketMoney, type MarketOffer, type MarketSale, type MarketVerification, type NftCurrency, type Page } from '@spw/nft';
import { NETWORKS, type NetworkDef } from '@spw/core';
import { providerGet, type Budget } from './budget.ts';
import type { CollectionMarketData, CollectionMarketRef, EventQuery, HttpFn, ItemMarketData, MarketRef, NftMarketProvider } from './types.ts';

export const OPENSEA_API = 'https://api.opensea.io/api/v2';
/** registry network → OpenSea `chain` (ChainIdentifier of the OpenAPI document; BNB Smart Chain is not in it) */
export const OPENSEA_CHAINS: Record<string, string> = { ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', optimism: 'optimism', avalanche: 'avalanche', hyperevm: 'hyperevm', solana: 'solana' };
const ZERO = '0x0000000000000000000000000000000000000000';
const SLUG = /^[a-z0-9][a-z0-9_-]{0,119}$/;
type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null); // an empty string is "not given"
const int = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && isUnits(v) ? v : null);
const iso = (sec: unknown): string | null => (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 && sec < 4_102_444_800 ? new Date(sec * 1000).toISOString() : null);
const httpsUrl = (v: unknown): string | null => { const s = str(v, 2000); if (!s) return null; try { const u = new URL(s); return u.protocol === 'https:' && !u.username ? u.href : null; } catch { return null; } };

export function openSeaMarket(deps: { http: HttpFn; now: () => Date; apiKey: string; budget: Budget }): NftMarketProvider {
  const net = (chain: string): NetworkDef | null => (NETWORKS as Record<string, NetworkDef | undefined>)[chain] ?? null;
  const get = (path: string, notFound: number[] = [404, 400], maxBytes?: number) => providerGet({ provider: 'opensea', budget: deps.budget, http: deps.http, url: `${OPENSEA_API}${path}`, headers: { 'x-api-key': deps.apiKey }, notFound, maxBytes });
  /** An exact currency from a token ADDRESS the source gives. EVM zero address = the network's native coin, checked against the registry's decimals. */
  function currencyOf(chain: string, token: unknown, symbol: unknown, decimals: unknown): NftCurrency | null {
    const n = net(chain), t = str(token, 80), d = typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null, sym = str(symbol, 20);
    if (!n || !t || d === null || !sym) return null;
    if (n.family === 'evm') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
      if (t.toLowerCase() === ZERO) return d === n.native.decimals ? { network: chain, asset: 'native', symbol: n.native.symbol, decimals: d } : null;
      return { network: chain, asset: t.toLowerCase(), symbol: sym, decimals: d };
    }
    if (n.family === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) ? { network: chain, asset: t, symbol: sym, decimals: d } : null;
    return null;
  }
  const priceOf = (chain: string, token: unknown, p: unknown): MarketMoney | null => { const o = obj(p), c = o ? currencyOf(chain, token, o.currency, o.decimals) : null, v = o ? str(o.value, 80) : null; return c && v && isUnits(v) ? money(v, c) : null; };
  /** the collection's own pricing currencies (symbol → address + decimals), as the SAME source states them: the only way a price named by symbol (a Solana order) is tied to an exact mint */
  type Pricing = { symbol: string; token: string; decimals: number }[];
  const pricingOf = (chain: string, c: J | null): Pricing => { const pc = obj(c?.pricing_currencies); return [obj(pc?.listing_currency), obj(pc?.offer_currency)].flatMap((x) => (x && x.chain === OPENSEA_CHAINS[chain] && str(x.symbol, 20) && str(x.address, 80) && typeof x.decimals === 'number' ? [{ symbol: x.symbol as string, token: x.address as string, decimals: x.decimals }] : [])); };
  const tokenBySymbol = (pricing: Pricing, p: unknown): string | null => { const o = obj(p), m = o ? pricing.find((x) => x.symbol === o.currency && x.decimals === o.decimals) : undefined; return m ? m.token : null; };
  const collCache = new Map<string, { at: number; c: J }>();
  async function collectionRaw(slug: string): Promise<J> {
    const hit = collCache.get(slug), now = deps.now().getTime();
    if (hit && now - hit.at < 10 * 60_000) return hit.c;
    const c = obj(await get(`/collections/${slug}`));
    if (!c || c.collection !== slug) throw new NftProviderError('provider_bad_answer', 'opensea', 'another_collection_answered');
    collCache.set(slug, { at: now, c }); if (collCache.size > 500) collCache.delete(collCache.keys().next().value!);
    return c;
  }
  /** the ONE payment token of a Seaport order side (itemType 0 native / 1 ERC-20); null when the items name several, or none */
  function paymentToken(items: unknown): string | null {
    if (!Array.isArray(items)) return null;
    const pay = items.map(obj).filter((i): i is J => !!i && (i.itemType === 0 || i.itemType === 1));
    const tokens = new Set(pay.map((i) => String(i.token).toLowerCase()));
    return pay.length > 0 && tokens.size === 1 ? [...tokens][0]! : null;
  }
  /** consideration items that do not go to the offerer: what the order pays to others (marketplace, creator) — amounts exact, roles not named by the source */
  function orderFees(chain: string, params: J | null, cur: NftCurrency | null): MarketFee[] | null {
    if (!params || !cur || !Array.isArray(params.consideration)) return null;
    const offerer = String(params.offerer ?? '').toLowerCase(), out: MarketFee[] = [];
    for (const it of params.consideration.map(obj)) { if (!it || (it.itemType !== 0 && it.itemType !== 1)) continue; const r = str(it.recipient, 80), amt = str(it.startAmount, 80);
      if (r && r.toLowerCase() !== offerer && amt && isUnits(amt)) out.push({ kind: 'other', bps: null, amount: money(amt, cur), recipient: r, required: null }); }
    return out;
  }
  function listingOf(chain: string, raw: unknown, pricing: Pricing): MarketListing | null {
    const o = obj(raw); if (!o) return null;
    const params = obj(obj(o.protocol_data)?.parameters), svm = obj(o.svm_order);
    const token = params ? paymentToken(params.consideration) : tokenBySymbol(pricing, obj(o.price)?.current), price = token ? priceOf(chain, token, obj(o.price)?.current) : null;
    if (!price) return null;
    return { orderId: str(o.order_hash, 80) ?? str(svm?.id, 200), price, quantity: int(o.remaining_quantity) ?? '1', seller: str(params?.offerer, 80) ?? str(svm?.maker, 80), venue: 'OpenSea', protocol: { name: str(o.protocol, 40) ?? (params ? 'seaport' : 'unknown'), address: str(o.protocol_address, 80) }, // `protocol` is the source's word for a Solana order (`tensor`, `os_tensor`, …)
      createdAt: iso(o.order_created_at), expiresAt: iso(Number(params?.endTime)), fees: orderFees(chain, params, price.currency) };
  }
  function offerOf(chain: string, raw: unknown, pricing: Pricing): MarketOffer | null {
    const o = obj(raw); if (!o) return null;
    const params = obj(obj(o.protocol_data)?.parameters), svm = obj(o.svm_order), crit = obj(o.criteria);
    const token = params ? paymentToken(params.offer) : tokenBySymbol(pricing, o.price), price = token ? priceOf(chain, token, o.price) : null;
    if (!price) return null;
    const scope: MarketOffer['scope'] = crit && Array.isArray(crit.traits) && crit.traits.length ? 'trait' : crit && obj(crit.collection) && !o.asset ? 'collection' : 'item';
    return { orderId: str(o.order_hash, 80) ?? str(svm?.id, 200), price, quantity: int(o.remaining_quantity) ?? '1', bidder: str(params?.offerer, 80) ?? str(svm?.maker, 80), venue: 'OpenSea', scope, createdAt: iso(o.order_created_at), expiresAt: iso(Number(params?.endTime)), fees: null };
  }
  const SYMBOL_ONLY = 'currency_symbol_only';
  const path = (r: MarketRef): string => { const c = OPENSEA_CHAINS[r.chain]!; return r.family === 'sol' ? `/chain/${c}/contract/${r.mint}/nfts/${r.mint}` : `/chain/${c}/contract/${r.contract!.toLowerCase()}/nfts/${r.tokenId}`; };
  const idOf = (r: MarketRef): string => (r.family === 'sol' ? r.mint! : r.tokenId!);
  const verification = (v: unknown): MarketVerification => { const s = str(v, 40); return { state: s === 'verified' ? 'verified' : s === null ? 'unknown' : 'not_verified', providerValue: s, by: 'OpenSea' }; };
  const soft = async <T>(f: () => Promise<T>, onNotFound: T, onError: (code: string) => T): Promise<T> => { try { return await f(); } catch (e) { if (e instanceof NftProviderError && e.code === 'not_found') return onNotFound; return onError(e instanceof NftProviderError ? e.code : 'provider_bad_answer'); } };
  function eventOf(chain: string, raw: unknown): MarketEvent | null {
    const e = obj(raw); if (!e) return null;
    const t = str(e.event_type, 40) ?? '', ot = str(e.order_type, 40), pay = obj(e.payment);
    const cur = pay ? currencyOf(chain, pay.token_address, pay.symbol, pay.decimals) : null, q = pay ? str(pay.quantity, 80) : null;
    const price = cur && q && isUnits(q) ? money(q, cur) : null;
    const type: MarketEvent['type'] = t === 'sale' ? 'sale' : t === 'transfer' ? 'transfer' : t === 'mint' ? 'mint' : t === 'order' || t === 'listing' || t === 'offer' || ot ? (ot === 'listing' || t === 'listing' ? 'list' : ot === 'item_offer' || ot === 'collection_offer' || ot === 'trait_offer' || t === 'offer' ? 'offer' : 'unknown') : 'unknown';
    return { type, providerType: ot ? `${t}:${ot}` : t, at: iso(e.event_timestamp), tx: str(e.transaction, 120), index: null,
      from: str(type === 'sale' ? e.seller : type === 'list' || type === 'offer' ? e.maker : e.from_address, 80), to: str(type === 'sale' ? e.buyer : type === 'list' || type === 'offer' ? e.taker : e.to_address, 80),
      quantity: int(e.quantity) ?? '1', price: type === 'transfer' || type === 'mint' ? null : price, venue: 'OpenSea', orderId: str(e.order_hash, 80), flags: { washTrade: unknown('the source has no wash-trade flag') }, fees: null };
  }

  return {
    id: 'opensea', name: 'OpenSea',
    describe: () => ({ chains: Object.keys(OPENSEA_CHAINS), sends: 'contract_and_token_id', attribution: { text: 'Market data: OpenSea', url: 'https://opensea.io' },
      terms: { url: 'https://opensea.io/developer-terms', readAt: '2026-11-17', note: 'Developer Terms of Use, last updated 2023-04-26: attribution and a link back required; no redistribution of API Data to third parties; no commercial use without written permission' },
      limits: { perMinute: 30, perDay: 5000 }, verification: 'live' }),
    notCovered: (r) => (!OPENSEA_CHAINS[r.chain] ? 'chain_not_covered' : r.family === 'sol' ? (r.mint && r.standard !== 'metaplex-bubblegum' ? null : 'standard_not_covered') : r.family === 'evm' && r.contract && r.tokenId ? null : 'standard_not_covered'),

    async item(r): Promise<ItemMarketData> {
      const chain = OPENSEA_CHAINS[r.chain]!, nft = obj(obj(await get(path(r)))?.nft);
      if (!nft) throw new NftProviderError('provider_bad_answer', 'opensea', 'no_nft');
      // the answer must be about the asset that was asked: another identifier is a bad answer, never shown
      const same = r.family === 'sol' ? nft.identifier === r.mint : String(nft.contract).toLowerCase() === r.contract!.toLowerCase() && String(nft.identifier) === r.tokenId;
      if (!same) throw new NftProviderError('provider_bad_answer', 'opensea', 'another_asset_answered');
      const slug = str(nft.collection, 120), okSlug = slug && SLUG.test(slug) ? slug : null, id = idOf(r);
      const bool = (v: unknown): Known<boolean> => (typeof v === 'boolean' ? known(v) : unknown());
      const rar = obj(nft.rarity), rank = rar ? int(rar.rank) : null, method = rar ? str(rar.strategy_id, 40) : null;
      const out: ItemMarketData = { url: httpsUrl(nft.opensea_url), listed: unknown(), ask: unknown(), bestOffer: unknown(), lastSale: unknown(), collection: okSlug ? { slug: okSlug, name: null } : null, collectionFloor: unknown(), verification: null,
        flags: { suspicious: bool(nft.is_suspicious), disabled: bool(nft.is_disabled), nsfw: bool(nft.is_nsfw) },
        // a rank only with the provider's NAMED method; the number of items it was computed over comes from the collection (see `collection`)
        rarity: rank && method ? known({ rank, outOf: null, method: `${method}${str(rar!.strategy_version, 20) ? ` ${rar!.strategy_version as string}` : ''}`, calculatedAt: null }) : rar === null ? NONE : unknown('the source gave no rank') };
      if (!okSlug) { out.listed = unknown('the marketplace names no collection for this item'); return out; }
      const coll = await soft<J | null>(() => collectionRaw(okSlug), null, () => null), pricing = pricingOf(r.chain, coll);
      if (coll) { out.collection = { slug: okSlug, name: str(coll.name, 200) }; out.verification = verification(coll.safelist_status);
        const rr = obj(coll.rarity); if (out.rarity.state === 'known' && rr) out.rarity = known({ ...out.rarity.value, outOf: int(rr.max_rank) ?? int(rr.total_supply), calculatedAt: str(rr.calculated_at, 40) }); }
      // each of the following is its own request and fails alone: one missing figure never hides the others
      const best = await soft(async () => ({ raw: await get(`/listings/collection/${okSlug}/nfts/${id}/best`) }), { raw: null as unknown }, (code) => ({ raw: undefined as unknown, code }));
      if ('code' in best) { out.listed = unknown(best.code as string); out.ask = unknown(best.code as string); }
      else if (best.raw === null || !obj(best.raw) || Object.keys(best.raw as object).length === 0) { out.listed = known(false); out.ask = NONE; }
      else { out.listed = known(true); const l = listingOf(r.chain, best.raw, pricing); out.ask = l ? known(l) : unknown(obj(best.raw)?.svm_order ? SYMBOL_ONLY : 'listing_not_understood'); }
      const off = await soft(async () => ({ raw: await get(`/offers/collection/${okSlug}/nfts/${id}/best`) }), { raw: null as unknown }, (code) => ({ raw: undefined as unknown, code }));
      if ('code' in off) out.bestOffer = unknown(off.code as string);
      else if (off.raw === null || !obj(off.raw) || Object.keys(off.raw as object).length === 0) out.bestOffer = NONE;
      else { const o = offerOf(r.chain, off.raw, pricing); out.bestOffer = o ? known(o) : unknown(obj(off.raw)?.svm_order ? SYMBOL_ONLY : 'offer_not_understood'); }
      out.lastSale = await soft<Known<MarketSale>>(async () => {
        const evs = obj(await get(`${path(r).replace('/chain/', '/events/chain/')}?event_type=sale&limit=1`))?.asset_events, e = Array.isArray(evs) ? eventOf(r.chain, evs[0]) : null;
        if (!Array.isArray(evs)) return unknown('provider_bad_answer');
        if (!evs.length) return NONE;
        return e && e.type === 'sale' && e.price ? known({ price: e.price, quantity: e.quantity, at: e.at, tx: e.tx, buyer: e.to, seller: e.from, venue: 'OpenSea' }) : unknown('sale_without_identified_currency');
      }, NONE, (code) => unknown(code));
      return out;
    },

    async listings(r, cursor): Promise<Page<MarketListing>> {
      // the API has no "every listing of one item" endpoint: the best listing is the only item-level one (OpenAPI document)
      if (cursor) return { items: [], cursor: null };
      const nft = obj(obj(await get(path(r)))?.nft), slug = str(nft?.collection, 120);
      if (!slug || !SLUG.test(slug)) return { items: [], cursor: null };
      const raw = await soft(() => get(`/listings/collection/${slug}/nfts/${idOf(r)}/best`), null, (code) => { throw new NftProviderError(code as never, 'opensea'); });
      const l = raw ? listingOf(r.chain, raw, pricingOf(r.chain, await soft<J | null>(() => collectionRaw(slug), null, () => null))) : null;
      return { items: l ? [l] : [], cursor: null };
    },
    async offers(r, cursor): Promise<Page<MarketOffer>> {
      const nft = obj(obj(await get(path(r)))?.nft), slug = str(nft?.collection, 120);
      if (!slug || !SLUG.test(slug)) return { items: [], cursor: null };
      const q = new URLSearchParams({ limit: '50', ...(cursor ? { next: cursor } : {}) });
      const j = obj(await get(`/offers/collection/${slug}/nfts/${idOf(r)}?${q}`));
      if (!j || !Array.isArray(j.offers)) throw new NftProviderError('provider_bad_answer', 'opensea', 'no_offers_list');
      const pricing = pricingOf(r.chain, await soft<J | null>(() => collectionRaw(slug), null, () => null));
      return { items: j.offers.map((o) => offerOf(r.chain, o, pricing)).filter((o): o is MarketOffer => !!o), cursor: str(j.next, 400) };
    },
    async events(r, q: EventQuery): Promise<Page<MarketEvent>> {
      const p = new URLSearchParams({ limit: String(Math.min(q.limit, 50)) });
      if (q.cursor) p.set('next', q.cursor);
      if (q.after) p.set('after', String(Math.floor(Date.parse(q.after) / 1000)));
      if (q.before) p.set('before', String(Math.floor(Date.parse(q.before) / 1000)));
      // the filter values of the OpenAPI document; cancellations are not served by this endpoint
      const want = new Set((q.types ?? ['sale', 'list', 'offer', 'transfer', 'mint']).flatMap((t) => (t === 'sale' ? ['sale'] : t === 'list' ? ['listing'] : t === 'offer' ? ['offer'] : t === 'transfer' ? ['transfer'] : t === 'mint' ? ['mint'] : [])));
      if (want.size === 0) return { items: [], cursor: null };
      for (const t of want) p.append('event_type', t);
      const j = obj(await get(`${path(r).replace('/chain/', '/events/chain/')}?${p}`));
      if (!j || !Array.isArray(j.asset_events)) throw new NftProviderError('provider_bad_answer', 'opensea', 'no_events_list');
      return { items: j.asset_events.map((e) => eventOf(r.chain, e)).filter((e): e is MarketEvent => !!e), cursor: str(j.next, 400) };
    },

    async collection(ref: CollectionMarketRef): Promise<CollectionMarketData> {
      if (!SLUG.test(ref.slug)) throw new NftProviderError('bad_identifier', 'opensea');
      const c = await collectionRaw(ref.slug);
      const lc = obj(obj(c.pricing_currencies)?.listing_currency), listCur = lc && OPENSEA_CHAINS[ref.chain] === lc.chain ? currencyOf(ref.chain, lc.address, lc.symbol, lc.decimals) : null;
      const total = int(c.total_supply);
      const fees: MarketFee[] | null = Array.isArray(c.fees) ? c.fees.map(obj).filter((f): f is J => !!f).map((f) => { const bps = decimalToUnits(f.fee, 2); // `fee` is a percentage (2.5 = 2.5 %): two decimals → basis points
        return { kind: 'other' as const, bps: bps !== null && Number(bps) <= 10_000 ? Number(bps) : null, amount: null, recipient: str(f.recipient, 80), required: typeof f.required === 'boolean' ? f.required : null }; }) : null;
      const out: CollectionMarketData = { slug: ref.slug, name: str(c.name, 200), description: str(c.description, 4000), url: httpsUrl(c.opensea_url), imageUrl: httpsUrl(c.image_url), bannerUrl: httpsUrl(c.banner_image_url), verification: verification(c.safelist_status),
        floor: unknown(), volumes: [], listedCount: unknown('not reported by this source'), owners: unknown(), totalSupply: total ? known(total) : unknown(), fees, traits: unknown(),
        definitions: { floor: 'OpenSea: price of the cheapest current listing of the collection on OpenSea, in the collection\'s listing currency', volume: 'OpenSea: traded volume in whole units of the named currency, reported as a decimal number', verification: 'OpenSea `safelist_status`; only the value `verified` is shown as verified by OpenSea', fees: 'OpenSea collection fees, each a percentage with its recipient and whether it is required; the source does not name which is the marketplace fee and which the creator fee' } };
      // statistics: decimals in whole currency units named by SYMBOL. They are attached to an exact currency only when the symbol is
      // the collection's own listing currency, whose address and decimals the same source gives; otherwise they stay unknown.
      const stats = await soft(async () => obj(await get(`/collections/${ref.slug}/stats`)), null, () => null), tot = obj(stats?.total);
      const moneyOf = (v: unknown, sym: unknown): MarketMoney | null => { if (!listCur || str(sym, 20) !== (lc!.symbol as string)) return null; const u = decimalToUnits(v, listCur.decimals) ?? (typeof v === 'number' ? decimalToUnits(v.toFixed(Math.min(listCur.decimals, 12)), listCur.decimals) : null); return u ? money(u, listCur, 'source_decimal') : null; };
      if (tot) {
        const f = moneyOf(tot.floor_price, tot.floor_price_symbol);
        out.floor = tot.floor_price === 0 ? NONE : f ? known(f) : unknown(listCur ? 'floor_not_in_listing_currency' : SYMBOL_ONLY);
        out.owners = int(tot.num_owners) ? known(int(tot.num_owners)!) : unknown();
        const rep = (v: unknown, sym: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && str(sym, 20) ? { value: v.toFixed(6).replace(/\.?0+$/, ''), symbol: sym as string } : null);
        out.volumes = [{ interval: 'all', volume: moneyOf(tot.volume, tot.volume_symbol), reported: rep(tot.volume, tot.volume_symbol), sales: int(tot.sales) }, ...(Array.isArray(stats!.intervals) ? stats!.intervals.map(obj).filter((i): i is J => !!i && !!str(i.interval, 20)).map((i) => ({ interval: ({ one_day: '1d', seven_day: '7d', thirty_day: '30d' } as Record<string, string>)[i.interval as string] ?? (i.interval as string), volume: moneyOf(i.volume, i.volume_symbol), reported: rep(i.volume, i.volume_symbol), sales: int(i.sales) })) : [])];
      } else out.floor = unknown('stats_unavailable');
      // trait counts: per-value counts from /traits; the denominator is the collection's `total_supply` of the SAME source. Without both: not computed.
      const tr = await soft(async () => obj(await get(`/traits/${ref.slug}`, [404, 400], 8_000_000)), null, () => null), counts = obj(tr?.counts), cats = obj(tr?.categories); // observed: 2.3 MB for a 344 673-item collection
      if (counts && cats && total) {
        const categories: CollectionTraits['categories'] = [];
        for (const [type, kind] of Object.entries(cats).slice(0, 300)) { if (kind !== 'string') continue; const vs = obj(counts[type]); if (!vs) continue;
          categories.push({ type: type.slice(0, 200), values: Object.entries(vs).slice(0, 2000).flatMap(([value, n]) => (int(n) ? [{ value: value.slice(0, 300), count: int(n)! }] : [])) }); }
        out.traits = known({ total, categories });
      } else out.traits = unknown(!total ? 'no_stated_item_total' : 'trait_counts_unavailable');
      return out;
    },
  };
}

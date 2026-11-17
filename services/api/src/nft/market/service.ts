// Market READ service (delivery 3): asks every market provider that covers an asset, each in isolation, and answers ONE ROW PER
// SOURCE. It never merges, averages or picks: two sources that disagree are two rows and a named contradiction. A provider that
// fails leaves the others, the item page and the ownership untouched; a provider that is absent (no key, turned off) is
// reported with the name of the variable that would turn it on — and is never called.
//
// Freshness: every answer is cached per provider + data type + reference (never per URL) with a TTL of its own; when a provider
// fails, the last answer is served marked `stale` with the failure's code, for at most a day; past that it is "unavailable".
//
// Fiat: a market amount stays in its own currency. `rates` gives, for each currency this wallet has a price for, the rate with
// ITS source and date (the wallet's existing price sources) — category "computed by SP Wallet", secondary by construction.
import { NETWORKS, type NetworkDef } from '@spw/core';
import { NftProviderError, contradictions, currencyId, type CollectionMarket, type Contradiction, type DataSourceStamp, type ItemMarket, type MarketEvent, type MarketListing, type MarketMoney, type MarketOffer, type MarketSourceStatus, type NftAsset, type NftCurrency, type Page } from '@spw/nft';
import * as store from '../store.ts';
import type { Budget, BudgetCounter } from './budget.ts';
import { refOf, type AbsentProvider, type CollectionMarketData, type EventQuery, type ItemMarketData, type MarketDataKind, type NftMarketProvider } from './types.ts';

export const MARKET_TTL_MS: Record<MarketDataKind, number> = { item: 2 * 60_000, listings: 2 * 60_000, offers: 2 * 60_000, events: 5 * 60_000, collection: 10 * 60_000 };
export const MARKET_STALE_MAX_MS = 24 * 3600_000;
export interface PriceRow { usd: number; cad?: number; priceAt?: string | null; source?: string; stale?: boolean }
export interface Rate { currency: NftCurrency; symbol: string; usd: string | null; cad: string | null; source: string; priceAt: string | null; stale: boolean; /** set when the rate may not be answered to this caller (a licence of the price source) */ withheld: string | null }
export interface MarketDeps { providers: NftMarketProvider[]; absent: AbsentProvider[]; budgets: Map<string, Budget>; now: () => Date; prices?: () => Promise<Record<string, PriceRow> | null>;
  /** registers a remote image with the media proxy and answers its opaque id (the browser never loads a marketplace's URL) */ registerMedia?: (url: string) => Promise<string | null>;
  cache?: { get: typeof store.getMarketCache; put: typeof store.putMarketCache } }
export interface ProviderStatus { id: string; name: string; state: 'on' | 'needs_key' | 'off'; unlockedBy: string | null; unlocks: string; chains: string[]; sends: string; attribution: { text: string; url: string } | null; terms: { url: string; readAt: string; note: string } | null; verification: 'live' | 'documentation' | null;
  budget: BudgetCounter | null; ttlSeconds: Record<string, number> }
type Cached<T> = { data: T; fetchedAt: Date; stale: boolean; code: string | null };

/** a price number of the wallet's feed as an exact decimal string (never an exponent) */
const priceText = (n: number | undefined): string | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e15 ? n.toFixed(8).replace(/\.?0+$/, '') : null);
/** the wallet's price SYMBOL of an exact currency: only the native coin or a token of the registry, matched by its identifier — never by the symbol a marketplace wrote */
export function registrySymbol(c: NftCurrency): string | null {
  const n = (NETWORKS as Record<string, NetworkDef | undefined>)[c.network];
  if (!n) return null;
  if (c.asset === 'native') return c.decimals === n.native.decimals ? n.native.symbol : null;
  // wrapped SOL is SOL for a price (the marketplaces quote SOL as the wrapped mint)
  if (n.family === 'sol' && c.asset === 'So11111111111111111111111111111111111111112' && c.decimals === 9) return n.native.symbol;
  const t = n.tokens.find((x) => (n.family === 'evm' ? x.id.toLowerCase() === c.asset.toLowerCase() : x.id === c.asset));
  return t && t.decimals === c.decimals ? t.symbol : null;
}
/** base units × rate → fiat with 2 decimals, exact on the decimal strings (rounded down) */
export function fiatValue(amount: string, decimals: number, rate: string): string | null {
  const m = /^([0-9]+)(?:\.([0-9]{1,12}))?$/.exec(rate);
  if (!m || !/^[0-9]{1,78}$/.test(amount)) return null;
  const scale = (m[2] ?? '').length, r = BigInt(m[1]! + (m[2] ?? '')), cents = BigInt(amount) * r * 100n / 10n ** BigInt(decimals + scale), s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function createMarketService(deps: MarketDeps) {
  const cache = deps.cache ?? { get: store.getMarketCache, put: store.putMarketCache };
  const stampOf = (p: NftMarketProvider, c: Cached<unknown>): DataSourceStamp => ({ category: 'market', source: p.id, detail: p.name, fetchedAt: c.fetchedAt.toISOString(), confidence: 'market_reported', freshness: c.stale ? 'stale' : 'fresh', covers: ['market'] });
  const errCode = (e: unknown): string => (e instanceof NftProviderError ? e.code : 'provider_bad_answer');
  /** the cached answer when it is fresh; else ask; when asking fails, the last answer marked stale (≤ a day old); else throw */
  async function cached<T>(p: NftMarketProvider, kind: MarketDataKind, ref: string, f: () => Promise<T>, force = false): Promise<Cached<T>> {
    const now = deps.now(), hit = await cache.get(p.id, kind, ref).catch(() => null);
    if (hit && !force && now.getTime() - hit.fetched_at.getTime() < MARKET_TTL_MS[kind]) return { data: hit.data as T, fetchedAt: hit.fetched_at, stale: false, code: null };
    try { const data = await f(); await cache.put(p.id, kind, ref, data, now).catch(() => {}); return { data, fetchedAt: now, stale: false, code: null }; }
    catch (e) {
      if (hit && now.getTime() - hit.fetched_at.getTime() < MARKET_STALE_MAX_MS && !(e instanceof NftProviderError && e.code === 'not_found')) return { data: hit.data as T, fetchedAt: hit.fetched_at, stale: true, code: errCode(e) };
      throw e;
    }
  }
  const status = (p: NftMarketProvider, state: MarketSourceStatus['state'], code: string | null, c: Cached<unknown> | null): MarketSourceStatus =>
    ({ provider: p.id, name: p.name, state, code: code ?? c?.code ?? null, unlockedBy: null, stale: c?.stale ?? false, stamp: c ? stampOf(p, c) : null, attribution: p.describe().attribution });
  const absentStatus = (a: AbsentProvider): MarketSourceStatus => ({ provider: a.id, name: a.name, state: a.state, code: a.code, unlockedBy: a.unlockedBy, stale: false, stamp: null, attribution: null });
  const blankItem = (): ItemMarketData => ({ url: null, listed: { state: 'unknown' }, ask: { state: 'unknown' }, bestOffer: { state: 'unknown' }, lastSale: { state: 'unknown' }, collection: null, collectionFloor: { state: 'unknown' }, verification: null,
    flags: { suspicious: { state: 'unknown' }, disabled: { state: 'unknown' }, nsfw: { state: 'unknown' } }, rarity: { state: 'unknown' } });

  async function rates(moneys: (MarketMoney | null | undefined)[], o: { thirdParty?: boolean } = {}): Promise<Record<string, Rate>> {
    const out: Record<string, Rate> = {}, px = deps.prices ? await deps.prices().catch(() => null) : null;
    if (!px) return out;
    for (const m of moneys) {
      if (!m) continue;
      const id = currencyId(m.currency), sym = registrySymbol(m.currency), row = sym ? px[sym] : undefined;
      if (out[id] || !sym || !row) continue;
      const source = row.source ?? 'coingecko';
      // docs/V11-MARKET-DATA-SOURCES.md §2.6-9: the second price source is licensed for internal use — its prices are not answered to an API key
      const withheld = o.thirdParty && source === 'apibricks' ? 'price_source_licence_internal_use_only' : null;
      out[id] = { currency: m.currency, symbol: sym, usd: withheld ? null : priceText(row.usd), cad: withheld ? null : priceText(row.cad), source, priceAt: row.priceAt ?? null, stale: row.stale ?? false, withheld };
    }
    return out;
  }
  const moneysOfItem = (i: ItemMarket): (MarketMoney | null)[] => [i.ask.state === 'known' ? i.ask.value.price : null, i.bestOffer.state === 'known' ? i.bestOffer.value.price : null, i.lastSale.state === 'known' ? i.lastSale.value.price : null, i.collectionFloor.state === 'known' ? i.collectionFloor.value : null];

  return {
    /** every provider slot of this version: on / needs key / off, what each would unlock, and its budget counters */
    providers(): ProviderStatus[] {
      const ttl = Object.fromEntries(Object.entries(MARKET_TTL_MS).map(([k, v]) => [k, v / 1000]));
      return [...deps.providers.map((p): ProviderStatus => { const d = p.describe(); return { id: p.id, name: p.name, state: 'on', unlockedBy: null, unlocks: '', chains: d.chains, sends: d.sends, attribution: d.attribution, terms: d.terms, verification: d.verification, budget: deps.budgets.get(p.id)?.counter() ?? null, ttlSeconds: ttl }; }),
        ...deps.absent.map((a): ProviderStatus => ({ id: a.id, name: a.name, state: a.state, unlockedBy: a.unlockedBy, unlocks: a.unlocks, chains: a.chains, sends: 'nothing_until_enabled', attribution: null, terms: null, verification: null, budget: null, ttlSeconds: ttl }))];
    },
    /** does any provider (present or absent) concern this chain? — for the per-chain capability */
    readsChain: (chain: string): boolean => deps.providers.some((p) => p.describe().chains.includes(chain)),

    /** The market snapshot of one asset: one row per source, the contradictions between them, the rates of the currencies quoted. */
    async item(a: NftAsset, o: { force?: boolean; thirdParty?: boolean } = {}): Promise<{ key: string; sources: ItemMarket[]; contradictions: Contradiction[]; rates: Record<string, Rate>; asOf: string }> {
      const ref = refOf(a);
      const sources = await Promise.all(deps.providers.map(async (p): Promise<ItemMarket> => {
        const why = p.notCovered(ref);
        if (why) return { ...blankItem(), status: status(p, 'not_covered', why, null) };
        try {
          const c = await cached(p, 'item', a.key, () => p.item(ref), o.force);
          if (c.data.collection && a.collection) await store.putMarketSlug(a.collection.key, p.id, c.data.collection.slug, deps.now()).catch(() => {});
          return { ...c.data, status: status(p, 'ok', null, c) };
        } catch (e) {
          // "the marketplace does not know this item" is an answer, not an outage
          if (e instanceof NftProviderError && e.code === 'not_found') return { ...blankItem(), status: status(p, 'not_covered', 'not_found', null) };
          return { ...blankItem(), status: status(p, 'error', errCode(e), null) };
        }
      }));
      const all = [...sources, ...deps.absent.filter((x) => x.chains.includes(a.chainId)).map((x): ItemMarket => ({ ...blankItem(), status: absentStatus(x) }))];
      return { key: a.key, sources: all, contradictions: contradictions(sources), rates: await rates(sources.flatMap(moneysOfItem), o), asOf: deps.now().toISOString() };
    },

    async orders(a: NftAsset, kind: 'listings' | 'offers', provider: string | null, cursor: string | null, o: { thirdParty?: boolean } = {}): Promise<{ key: string; kind: string; sources: { status: MarketSourceStatus; items: (MarketListing | MarketOffer)[]; cursor: string | null }[]; rates: Record<string, Rate>; asOf: string }> {
      const ref = refOf(a);
      const sources = await Promise.all(deps.providers.filter((p) => !provider || p.id === provider).map(async (p) => {
        const why = p.notCovered(ref) ?? (p[kind] ? null : 'not_served_by_this_source');
        if (why) return { status: status(p, 'not_covered', why, null), items: [], cursor: null };
        try { const c = await cached<Page<MarketListing | MarketOffer>>(p, kind, `${a.key}|${cursor ?? ''}`, () => p[kind]!(ref, cursor) as Promise<Page<MarketListing | MarketOffer>>); return { status: status(p, 'ok', null, c), items: c.data.items, cursor: c.data.cursor }; }
        catch (e) { return { status: status(p, e instanceof NftProviderError && e.code === 'not_found' ? 'not_covered' : 'error', errCode(e), null), items: [], cursor: null }; }
      }));
      return { key: a.key, kind, sources: [...sources, ...(provider ? [] : deps.absent.filter((x) => x.chains.includes(a.chainId)).map((x) => ({ status: absentStatus(x), items: [], cursor: null })))], rates: await rates(sources.flatMap((s) => s.items.map((i) => i.price)), o), asOf: deps.now().toISOString() };
    },

    /** Market events of one asset, one page PER SOURCE (a cursor belongs to its source). They are market statements: listed apart from the chain's transfers. */
    async events(a: NftAsset, q: EventQuery & { provider: string | null }, o: { thirdParty?: boolean } = {}): Promise<{ key: string; sources: { status: MarketSourceStatus; events: MarketEvent[]; cursor: string | null }[]; rates: Record<string, Rate>; asOf: string }> {
      const ref = refOf(a), sig = `${a.key}|${q.cursor ?? ''}|${(q.types ?? []).join(',')}|${q.after ?? ''}|${q.before ?? ''}|${q.limit}`;
      const sources = await Promise.all(deps.providers.filter((p) => !q.provider || p.id === q.provider).map(async (p) => {
        const why = p.notCovered(ref) ?? (p.events ? null : 'not_served_by_this_source');
        if (why) return { status: status(p, 'not_covered', why, null), events: [], cursor: null };
        try { const c = await cached(p, 'events', sig, () => p.events!(ref, q)); return { status: status(p, 'ok', null, c), events: c.data.items, cursor: c.data.cursor }; }
        catch (e) { return { status: status(p, e instanceof NftProviderError && e.code === 'not_found' ? 'not_covered' : 'error', errCode(e), null), events: [], cursor: null }; }
      }));
      return { key: a.key, sources: [...sources, ...(q.provider ? [] : deps.absent.filter((x) => x.chains.includes(a.chainId)).map((x) => ({ status: absentStatus(x), events: [], cursor: null })))], rates: await rates(sources.flatMap((s) => s.events.map((e) => e.price)), o), asOf: deps.now().toISOString() };
    },

    /** What each source says about a collection. The marketplace's identifier of the collection is the one it gave for one of its items. */
    async collection(collectionKey: string, chain: string, o: { thirdParty?: boolean } = {}): Promise<{ key: string; sources: (CollectionMarket & { imageId: string | null; bannerId: string | null })[]; rates: Record<string, Rate>; asOf: string }> {
      const slugs = await store.marketSlugs(collectionKey).catch(() => ({} as Record<string, string>));
      const blank = (): CollectionMarketData => ({ slug: null, name: null, description: null, url: null, imageUrl: null, bannerUrl: null, verification: null, floor: { state: 'unknown' }, volumes: [], listedCount: { state: 'unknown' }, owners: { state: 'unknown' }, totalSupply: { state: 'unknown' }, fees: null, traits: { state: 'unknown' }, definitions: {} });
      const sources = await Promise.all(deps.providers.map(async (p) => {
        const d = p.describe();
        if (!d.chains.includes(chain) || !p.collection) return { ...blank(), status: status(p, 'not_covered', d.chains.includes(chain) ? 'not_served_by_this_source' : 'chain_not_covered', null), imageId: null, bannerId: null };
        const slug = slugs[p.id];
        if (!slug) return { ...blank(), status: status(p, 'not_covered', 'collection_not_identified', null), imageId: null, bannerId: null };
        try {
          const c = await cached(p, 'collection', `${chain}|${slug}`, () => p.collection!({ chain, slug }));
          const reg = async (u: string | null) => (u && deps.registerMedia ? deps.registerMedia(u).catch(() => null) : null);
          // the remote URLs stay on the server: the answer carries opaque ids of the media proxy
          return { ...c.data, imageUrl: null, bannerUrl: null, status: status(p, 'ok', null, c), imageId: await reg(c.data.imageUrl), bannerId: await reg(c.data.bannerUrl) };
        } catch (e) { return { ...blank(), slug, status: status(p, e instanceof NftProviderError && e.code === 'not_found' ? 'not_covered' : 'error', errCode(e), null), imageId: null, bannerId: null }; }
      }));
      const all = [...sources, ...deps.absent.filter((x) => x.chains.includes(chain)).map((x) => ({ ...blank(), status: absentStatus(x), imageId: null, bannerId: null }))];
      return { key: collectionKey, sources: all, rates: await rates(sources.flatMap((s) => [s.floor.state === 'known' ? s.floor.value : null, ...s.volumes.map((v) => v.volume)]), o), asOf: deps.now().toISOString() };
    },
    rates,
  };
}
export type MarketService = ReturnType<typeof createMarketService>;

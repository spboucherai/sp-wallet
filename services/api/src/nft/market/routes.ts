// NFT market routes — /api/v1/nfts/market/* and /api/v1/nfts/valuation (delivery 3). READ ONLY, owner session only (the global
// hook of server.ts; these paths are not under /api/v1/trading/). There is NO route here that prepares, signs or submits an
// order, an approval or a cancellation: market writes do not exist in this version. Every market action is answered as
// unavailable with its reason (`marketActions`), next to links that open the marketplace's own page — outside SP Wallet.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NftProviderError, parseNftKey, sameCurrency, traitFrequency, type CollectionTraits, type MarketMoney } from '@spw/nft';
import { UserError } from '../../config.ts';
import { audit, getSetting, setSetting } from '../../db.ts';
import { externalMarketLinks } from '../market.ts';
import type { NftService } from '../service.ts';
import * as store from '../store.ts';
import { fiatValue, type MarketService } from './service.ts';

const Key = z.string().min(5).max(260).refine((k) => { try { parseNftKey(k); return true; } catch { return false; } });
const Provider = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional();
const Cursor = z.string().max(600).optional();
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
export const EVENT_TYPES = ['sale', 'list', 'delist', 'offer', 'cancel-offer', 'accept-offer', 'transfer', 'mint', 'unknown'] as const;
export const FLOOR_ESTIMATE_SETTING = 'nftFloorEstimate';

/** The market actions of the brief (§4 Phase C) and why none can be done here. The reason is the same for all: nothing decodes, verifies or simulates an order of any marketplace in this version. */
export const MARKET_ACTIONS = ['buy', 'sell', 'create_listing', 'cancel_listing', 'make_offer', 'cancel_offer', 'accept_offer'] as const;
export const marketActions = () => MARKET_ACTIONS.map((id) => ({ id, available: false as const, reason: 'market_writes_not_built' as const }));
/** What is true about acting on a marketplace's own site with this wallet (shown with every external link). */
export const EXTERNAL_NOTICE = { outsideWallet: true, walletConnect: false, keyExport: false, code: 'external_site_needs_a_wallet_connection_this_wallet_does_not_offer' } as const;

export function marketRoutes(app: FastifyInstance, nft: NftService, market: MarketService): void {
  const P = '/api/v1/nfts';
  const assetOf = async (key: string) => { const a = await nft.get(key, { verify: false }); if (!a) throw new UserError('nft_not_found', 'this NFT is not in the inventory; use the lookup to open it', 404); return a; };

  app.get(`${P}/market/providers`, async () => ({ providers: market.providers(), actions: marketActions(), notice: EXTERNAL_NOTICE }));

  app.get(`${P}/market`, limit(40), async (req) => {
    const q = z.object({ key: Key, refresh: z.enum(['1']).optional() }).parse(req.query), a = await assetOf(q.key);
    const r = await market.item(a, { force: q.refresh === '1' });
    return { ...r, actions: marketActions(), external: { links: externalMarketLinks(a), notice: EXTERNAL_NOTICE },
      // an item has no value this wallet can establish: a floor is a statistic of a collection, not a price of this item
      value: { state: 'unavailable' as const, reason: 'no_valuation_from_floor_or_single_quote' } };
  });
  for (const kind of ['listings', 'offers'] as const) app.get(`${P}/market/${kind}`, limit(40), async (req) => {
    const q = z.object({ key: Key, provider: Provider, cursor: Cursor }).parse(req.query);
    return { ...(await market.orders(await assetOf(q.key), kind, q.provider ?? null, q.cursor ?? null)), actions: marketActions() };
  });
  app.get(`${P}/market/activity`, limit(40), async (req) => {
    const q = z.object({ key: Key, provider: Provider, cursor: Cursor, type: z.string().max(120).optional(), after: z.iso.datetime().optional(), before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const types = q.type ? z.array(z.enum(EVENT_TYPES)).min(1).max(EVENT_TYPES.length).parse(q.type.split(',')) : null;
    // a cursor is a position in ONE source's list: it is only accepted together with that source
    if (q.cursor && !q.provider) throw new UserError('bad_request', 'a cursor belongs to one source: name it with `provider`', 400);
    return market.events(await assetOf(q.key), { cursor: q.cursor ?? null, types, after: q.after ?? null, before: q.before ?? null, limit: q.limit, provider: q.provider ?? null });
  });
  /** a collection's trait document can be megabytes (2.3 MB observed): the page gets the most frequent values, and says it was cut */
  const cut = (t: CollectionTraits): CollectionTraits & { truncated: boolean } => { const cats = t.categories.slice(0, 40).map((c) => ({ type: c.type, values: [...c.values].sort((a, b) => Number(BigInt(b.count) - BigInt(a.count))).slice(0, 12) }));
    return { total: t.total, categories: cats, truncated: t.categories.length > 40 || t.categories.some((c) => c.values.length > 12) }; };
  app.get(`${P}/market/collection`, limit(40), async (req) => {
    const q = z.object({ key: Key }).parse(req.query), k = parseNftKey(q.key), r = await market.collection(q.key, k.chainId);
    return { ...r, sources: r.sources.map((s) => (s.traits.state === 'known' ? { ...s, traits: { state: 'known' as const, value: cut(s.traits.value) } } : s)) };
  });
  // Trait frequency of ONE item (brief §6): only from a source that gives collection-level counts WITH a stated item total; the
  // denominator, the source and its date are part of the answer. Otherwise: not computed, and why. Never from a partial sample.
  app.get(`${P}/market/traits`, limit(40), async (req) => {
    const q = z.object({ key: Key }).parse(req.query), a = await assetOf(q.key);
    if (!a.collection) return { key: a.key, computed: false as const, reason: 'no_collection', sources: [] };
    const c = await market.collection(a.collection.key, a.chainId);
    const sources = c.sources.filter((s) => s.status.state === 'ok').map((s) => (s.traits.state !== 'known'
      ? { provider: s.status.provider, name: s.status.name, computed: false as const, reason: 'reason' in s.traits && s.traits.reason ? s.traits.reason : 'trait_counts_unavailable', rows: [] }
      : { provider: s.status.provider, name: s.status.name, computed: true as const, reason: null, total: s.traits.value.total, fetchedAt: s.status.stamp!.fetchedAt, stale: s.status.stale, method: 'count of items with the value ÷ item total, both stated by the source',
          rows: a.metadata.attributes.filter((x) => x.traitType !== null && !x.malformed).map((x) => ({ traitType: x.traitType!, value: x.valueText, frequency: traitFrequency((s.traits as { value: CollectionTraits }).value, x.traitType!, x.valueText) })) }));
    const any = sources.some((s) => s.computed);
    // the collection's sources that could NOT be asked say why (no key, off, the marketplace has not identified the collection)
    return { key: a.key, computed: any, reason: any ? null : sources[0]?.reason ?? c.sources[0]?.status.code ?? 'no_market_source', sources, mutableMetadata: a.metadata.mutable.state === 'known' ? a.metadata.mutable.value : null };
  });

  // ── the opt-in "indicative floor-based estimate" (brief §8). DEFAULT OFF. It is never added to the wallet's total, and it is
  // not a valuation: per collection, the number of items held × the lowest floor a source reports, with that source and its age.
  app.get(`${P}/valuation`, limit(20), async () => {
    const enabled = await getSetting<boolean>(FLOOR_ESTIMATE_SETTING, false);
    const base = { enabled, state: 'unavailable' as const, reason: 'no_reliable_valuation', excludedFromWalletTotal: true as const };
    if (!enabled) return { ...base, estimate: null };
    const held = await store.heldByCollection(), rows = [];
    const moneys: MarketMoney[] = [];
    for (const c of held.slice(0, 40)) {
      const m = await market.collection(c.collection_key, c.chain).catch((e: unknown) => { if (e instanceof NftProviderError) return null; throw e; });
      const floors = (m?.sources ?? []).filter((s) => s.status.state === 'ok' && s.floor.state === 'known').map((s) => ({ provider: s.status.provider, name: s.status.name, floor: (s.floor as { value: MarketMoney }).value, fetchedAt: s.status.stamp!.fetchedAt, stale: s.status.stale }));
      // several sources: the LOWEST floor in a given currency is used, and every source's figure is listed beside it
      const used = floors.length ? floors.reduce((a, b) => (sameCurrency(a.floor.currency, b.floor.currency) && BigInt(b.floor.amount) < BigInt(a.floor.amount) ? b : a)) : null;
      if (used) moneys.push(used.floor);
      rows.push({ collectionKey: c.collection_key, chain: c.chain, name: c.name, items: c.n, floors, used: used ? { provider: used.provider, floor: used.floor, fetchedAt: used.fetchedAt, stale: used.stale, indicative: { amount: (BigInt(used.floor.amount) * BigInt(c.n)).toString(10), currency: used.floor.currency, precision: used.floor.precision } } : null,
        reason: used ? null : !m ? 'market_unavailable' : m.sources.some((s) => s.status.state === 'ok') ? 'no_floor_reported' : m.sources.find((s) => s.status.state !== 'ok')?.status.code ?? 'no_market_source' });
    }
    const rates = await market.rates(moneys);
    let usd = 0n, counted = 0;
    for (const r of rows) { const u = r.used, rate = u ? rates[`${u.floor.currency.network}:${/^0x/.test(u.floor.currency.asset) ? u.floor.currency.asset.toLowerCase() : u.floor.currency.asset}`] : undefined, v = u && rate?.usd ? fiatValue(u.indicative.amount, u.floor.currency.decimals, rate.usd) : null;
      if (v) { usd += BigInt(v.replace('.', '')); counted += 1; } }
    const cents = usd.toString().padStart(3, '0');
    return { ...base, estimate: { label: 'indicative_floor_based_estimate', method: 'items held × lowest collection floor reported by a market source; a floor is the cheapest asking price of ANY item of the collection, not the value of the items held', collections: rows, rates,
      indicativeUsd: counted ? `${cents.slice(0, -2)}.${cents.slice(-2)}` : null, collectionsCounted: counted, collectionsWithoutFloor: rows.length - counted, itemsWithoutCollection: 'not_counted', asOf: new Date().toISOString() } };
  });
  app.post(`${P}/valuation`, limit(10), async (req) => {
    const b = z.strictObject({ enabled: z.boolean() }).parse(req.body);
    await setSetting(FLOOR_ESTIMATE_SETTING, b.enabled);
    await audit('nft.floor_estimate', 'owner', { enabled: b.enabled });
    return { enabled: b.enabled };
  });
}

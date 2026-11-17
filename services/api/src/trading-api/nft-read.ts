// NFT READ operations of the trading API (delivery 3). Five GETs, nothing else: no transfer, no approval, no market write is
// reachable with a key — NFT transfers stay owner-only (passkey), and market writes do not exist in this version.
//
//   wallet:read    listNfts, getNft, getNftActivity     the OWNER's inventory (what the chain confirmed), one item, its on-chain events
//   markets:read   getNftMarket, getNftMarketEvents     market data of ANY item named by its chain identifiers
//
// A `markets:read` answer says nothing about the wallet: not whether it holds the item, not its addresses. A key restricted to
// networks reads only those. Fiat rates follow the rule of the price sources: a rate whose source is licensed for internal use
// (docs/V11-MARKET-DATA-SOURCES.md §2.6-9) is WITHHELD from an API key — `usd: null`, `withheld: <reason>` — and answered to
// the owner session.
import { NETWORKS, type NetworkDef } from '@spw/core';
import { NftProviderError, parseNftKey } from '@spw/nft';
import { UserError } from '../config.ts';
import { marketActions } from '../nft/market/routes.ts';
import type { MarketService } from '../nft/market/service.ts';
import type { NftService } from '../nft/service.ts';
import type { Principal } from './principal.ts';

export interface NftReadDeps { nft: () => { nft: NftService; market: MarketService } | null }
const STATUS: Partial<Record<string, number>> = { not_found: 404, bad_identifier: 400, unsupported_chain: 422, unsupported_standard: 422, provider_rate_limited: 429, budget_exhausted: 429, provider_not_configured: 503, provider_unavailable: 503, provider_bad_answer: 502, provider_disagreement: 502, provider_method_unsupported: 503 };
/** a provider failure as the API's own error: a stable code, the source — never a URL, a key or a body */
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { if (e instanceof NftProviderError) throw Object.assign(new UserError(`nft_${e.code}`, `NFT source ${e.source}: ${e.code}`, STATUS[e.code] ?? 502), { data: { code: e.code } }); throw e; } };

export function createNftReads(deps: NftReadDeps) {
  const svc = () => { const s = deps.nft(); if (!s) throw new UserError('nft_disabled', 'the NFT module is disabled on this server', 503); return s; };
  const nets = (p: Principal): string[] | null => (p.kind === 'api_key' && p.restrictions.networks.length ? p.restrictions.networks : null);
  const allowed = (p: Principal, chain: string): void => { const n = nets(p); if (n && !n.includes(chain)) throw new UserError('restricted', `this key is not allowed on network ${chain}`, 403); };
  const chainOf = (key: string): string => { try { return parseNftKey(key).chainId; } catch { throw new UserError('bad_request', 'not an NFT key (family:chain:asset-id)', 400); } };
  const offset = (cursor: string | undefined): number => { if (cursor === undefined) return 0; if (!/^[0-9]{1,6}$/.test(cursor)) throw new UserError('invalid_cursor', 'this cursor is not one a previous page of this list returned', 400); return Number(cursor); };
  type Item = NonNullable<Awaited<ReturnType<NftService['get']>>>;
  const summary = (a: Item) => ({ key: a.key, network: a.chainId, family: a.family, standard: a.standard, assetId: a.assetId, contractAddress: a.contractAddress, tokenId: a.tokenId, mintAddress: a.mintAddress, quantity: a.quantity,
    name: a.metadata.name, onchainName: a.metadata.onchainName, collection: a.collection ? { key: a.collection.key, id: a.collection.id, name: a.collection.name, verifiedOnChain: a.collection.verifiedOnChain } : null,
    state: a.ownership.state, inWallet: a.ownership.heldByWallet, origin: a.origin, transferable: a.capabilities.transferable, transferBlockedBy: a.capabilities.transferBlockedBy, spam: a.indexerFlags?.spam ? { by: a.indexerFlags.by } : null,
    ownershipSource: { category: a.ownership.source.category, source: a.ownership.source.source, confidence: a.ownership.source.confidence, fetchedAt: a.ownership.source.fetchedAt, stale: a.ownership.source.freshness === 'stale' }, firstSeen: a.firstSeen, verifiedAt: a.verifiedAt, goneAt: a.goneAt });
  /** the owner's item, never a looked-up one: `wallet:read` reads the inventory, not the lookups */
  async function own(p: Principal, key: string): Promise<Item> {
    allowed(p, chainOf(key));
    const a = await svc().nft.get(key, { verify: false });
    if (!a || a.origin === 'lookup') throw new UserError('unknown_nft', 'this NFT is not in the wallet\'s inventory', 404);
    return a;
  }

  return {
    async listNfts(p: Principal, q: { network?: string; collection?: string; status?: 'in_wallet' | 'left' | 'tracked'; q?: string; sort: 'recent' | 'name'; spam: 'hide' | 'show' | 'only'; limit: number; cursor?: string }) {
      if (q.network !== undefined) { if (!(NETWORKS as Record<string, NetworkDef | undefined>)[q.network]) throw new UserError('unknown_network', `unknown network '${q.network.slice(0, 24)}'`, 404); allowed(p, q.network); }
      const off = offset(q.cursor), n = nets(p), s = svc().nft;
      // a key restricted to networks: one query per allowed network would break the paging — the restriction is applied in SQL through `chains`
      const r = await s.list({ chain: q.network, chains: q.network ? undefined : n ?? undefined, collection: q.collection, status: q.status ?? 'in_wallet', q: q.q || undefined, sort: q.sort, limit: q.limit, offset: off, spam: q.spam });
      return { items: r.items.map(summary), total: r.total, hiddenSpam: r.hiddenSpam, nextCursor: off + r.items.length < r.total ? String(off + r.items.length) : null,
        valuation: { state: 'unavailable' as const, reason: 'no_reliable_valuation', note: 'an NFT has no value this wallet can establish: it is not counted as zero and not valued at a collection floor; it is not part of GET /portfolio' }, asOf: new Date().toISOString() };
    },
    async getNft(p: Principal, key: string) {
      const a = await own(p, key);
      return { nft: { ...summary(a), supply: a.supply, updateAuthority: a.updateAuthority, tokenProgram: a.tokenProgram, royaltyBps: a.royaltyBps, extensions: a.extensions, explorerUrl: a.explorerUrl,
        ownership: { state: a.ownership.state, owner: a.ownership.owner, tokenAccount: a.ownership.tokenAccount, frozen: a.ownership.frozen, delegate: a.ownership.delegate, tokenRecordState: a.ownership.tokenRecordState, heldByWallet: a.ownership.heldByWallet },
        // what the CREATOR declared (never chain truth): text only, with its own status and source
        metadata: { status: a.metadata.status, errorCode: a.metadata.errorCode, sourceUri: a.metadata.sourceUri, name: a.metadata.name, description: a.metadata.description, externalUrl: a.metadata.externalUrl, mutable: a.metadata.mutable, contentHash: a.metadata.contentHash,
          attributes: a.metadata.attributes.map((x) => ({ traitType: x.traitType, value: x.valueText, displayType: x.displayType, malformed: x.malformed })) },
        sources: a.sources.map((s) => ({ category: s.category, source: s.source, confidence: s.confidence, fetchedAt: s.fetchedAt, stale: s.freshness === 'stale' })), marketSources: a.marketSources },
        marketActions: marketActions() };
    },
    async getNftActivity(p: Principal, q: { key: string; limit: number; cursor?: string; type?: string }) {
      await own(p, q.key);
      const r = await wrap(() => svc().nft.activity(q.key, { cursor: q.cursor ?? null, limit: q.limit, type: q.type }));
      return { key: q.key, events: r.events.map((e) => ({ id: e.id, type: e.type, tx: e.tx, index: e.index, at: e.at, block: e.blockRef.slot ?? e.blockRef.number ?? null, from: e.from, to: e.to, quantity: e.quantity, finality: e.finality,
        // a price exists on an on-chain event ONLY when SP Wallet linked a payment of the same transaction (a decoded marketplace event): `interpretedBy` says so
        price: e.price, interpretedBy: e.interpretation.by, note: e.interpretation.note, marketProgram: e.marketProgram ?? null, source: { category: e.source.category, source: e.source.source } })),
        nextCursor: r.cursor, completeness: r.completeness, note: r.note, error: r.error };
    },
    /** market data of ANY item, named by its chain identifiers. The item is read on-chain first (it must exist); nothing about the wallet is answered. */
    async lookedUp(p: Principal, q: { network: string; address: string; tokenId?: string }) {
      if (!(NETWORKS as Record<string, NetworkDef | undefined>)[q.network]) throw new UserError('unknown_network', `unknown network '${q.network.slice(0, 24)}'`, 404);
      allowed(p, q.network);
      return wrap(() => svc().nft.lookup(q.network, q.address, q.tokenId || undefined));
    },
    async getNftMarket(p: Principal, q: { network: string; address: string; tokenId?: string }) {
      const a = await this.lookedUp(p, q), r = await svc().market.item(a, { thirdParty: p.kind === 'api_key' });
      return { key: r.key, network: a.chainId, standard: a.standard, sources: r.sources, contradictions: r.contradictions, rates: r.rates, value: { state: 'unavailable' as const, reason: 'no_valuation_from_floor_or_single_quote' }, marketActions: marketActions(), asOf: r.asOf };
    },
    async getNftMarketEvents(p: Principal, q: { network: string; address: string; tokenId?: string; provider?: string; type?: string; after?: string; before?: string; cursor?: string; limit: number }) {
      if (q.cursor && !q.provider) throw new UserError('bad_request', 'a cursor belongs to one source: name it with `provider`', 400);
      const a = await this.lookedUp(p, q), types = q.type ? q.type.split(',') : null;
      const r = await svc().market.events(a, { cursor: q.cursor ?? null, types, after: q.after ?? null, before: q.before ?? null, limit: q.limit, provider: q.provider ?? null }, { thirdParty: p.kind === 'api_key' });
      return { key: r.key, sources: r.sources.map((s) => ({ status: s.status, events: s.events, nextCursor: s.cursor })), rates: r.rates, asOf: r.asOf };
    },
  };
}
export type NftReads = ReturnType<typeof createNftReads>;

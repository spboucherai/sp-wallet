/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/service.ts
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

// NFT service: composes the providers (chain truth, indexed discovery), the resolver (creator metadata and media), the optional
// market source and the store. It is the only place where the five data categories meet, and it keeps them apart: each part of
// an asset carries its own stamp, and a failure of one source leaves the others as they were.
//
// The wallet's addresses come from the SIGNER (through `deps.addresses`), never from a request: no route accepts an owner address.
import { NETWORKS, type NetworkDef } from '@spw/core';
import { capabilitiesOf, NftProviderError, nftKey, parseNftKey, type NftAsset, type NftEvent } from '@spw/nft';
import type { NftConfig } from './config.ts';
import { externalMarketLinks, type MarketSource } from './market.ts';
import type { CollectionInfo, InventorySection, NftDataProvider } from './provider.ts';
import type { Resolver } from './resolver.ts';
import * as store from './store.ts';
import type { EvmHintSource } from './evm-hints.ts';
import { UNLOCK_DISCOVERY } from './evm.ts';
import type { MarketService } from './market/service.ts';

export const TTL_SYNC_MS = 5 * 60_000, TTL_OWNERSHIP_MS = 60_000, TTL_MARKET_MS = 5 * 60_000, TTL_ONCHAIN_STALE_MS = 15 * 60_000, REFRESH_COOLDOWN_MS = 60_000, METADATA_PER_SYNC = 60;
const NETS = () => Object.values(NETWORKS) as NetworkDef[];
const SECTION_STANDARDS: Record<string, string[]> = { token: ['metaplex-token-metadata', 'metaplex-pnft', 'spl-token-2022', 'spl-token'], core: ['metaplex-core'], compressed: ['metaplex-bubblegum'], indexer: ['erc721', 'erc1155', 'evm-nonstandard'] };

export interface NftDeps { cfg: NftConfig; providers: NftDataProvider[]; resolver: Resolver; market: MarketSource | null; addresses: () => Promise<Record<string, string>>; now: () => Date;
  /** delivery 3: the market READ layer (one row per source) and the keyed EVM discovery sources — both optional */ marketService?: MarketService; evmHints?: EvmHintSource[] }
/** standards a transfer is built for (delivery 2), per family — the per-asset verdict and the signer's policy decide the rest */
export const TRANSFER_STANDARDS: Record<string, string[]> = { evm: ['erc721', 'erc1155'], sol: ['spl-token-2022', 'metaplex-token-metadata', 'metaplex-pnft', 'metaplex-core'] };
export type ChainSupport = 'supported' | 'partial' | 'blocked_by_provider' | 'unsupported';
export interface ChainCapability { network: string; name: string; family: string; inventory: ChainSupport; /** why, as a code the interface translates */ reason: string; unlockedBy: string | null; standards: string[]; lookup: boolean; manualAdd: boolean; receive: boolean; /** delivery 2: 'supported' = a transfer can be prepared for the standards of `transferStandards` (the asset's own state and the signer's policy still decide) */ transfer: 'supported' | 'not_supported'; transferStandards: string[]; /** why not, as a code */ transferReason: string | null; marketRead: boolean; marketWrite: false;
  sections: { section: string; status: string; code: string | null; unlockedBy: string | null; source: string | null; count: number; truncated: boolean; syncedAt: string }[] }

export function createNftService(deps: NftDeps) {
  const { cfg } = deps;
  const providerOf = (chain: string): NftDataProvider | null => deps.providers.find((p) => p.chains().includes(chain)) ?? null;
  const need = (chain: string): NftDataProvider => { const p = providerOf(chain); if (!p) throw new NftProviderError('unsupported_chain', 'spw', chain); return p; };
  const running = new Map<string, Promise<void>>(), lastSync = new Map<string, number>(), lastRefresh = new Map<string, number>();

  /** freshness is decided when the asset is read, not when it was stored */
  function present(row: store.AssetRow): NftAsset & { firstSeen: string; lastSeen: string; verifiedAt: string | null; goneAt: string | null; externalMarkets: { name: string; url: string }[]; marketSources: { provider: string; name: string; state: 'on' | 'needs_key' | 'off'; unlockedBy: string | null }[] } {
    const now = deps.now().getTime(), a = row.asset;
    const age = (s: { fetchedAt: string }) => now - new Date(s.fetchedAt).getTime();
    const fresh = <T extends { category: string; fetchedAt: string; freshness: string }>(s: T): T => ({ ...s, freshness: s.category === 'onchain' || s.category === 'indexed' ? (age(s) > TTL_ONCHAIN_STALE_MS ? 'stale' : 'fresh') : s.category === 'market' ? (age(s) > TTL_MARKET_MS * 3 ? 'stale' : 'fresh') : s.freshness });
    // capabilities are derived from the stored FACTS each time the asset is read (a row stored by delivery 1 says "not built")
    // delivery 3: which market sources concern this asset and in what state — static (no request is made to say it)
    const marketSources = deps.marketService ? deps.marketService.providers().filter((m) => m.chains.includes(a.chainId)).map((m) => ({ provider: m.id, name: m.name, state: m.state === 'on' ? 'on' as const : m.state, unlockedBy: m.unlockedBy })) : [];
    return { ...a, marketSources, capabilities: capabilitiesOf(a), sources: a.sources.map(fresh), ownership: { ...a.ownership, source: fresh(a.ownership.source) }, market: a.market ? { ...a.market, source: fresh(a.market.source) } : null,
      firstSeen: row.first_seen.toISOString(), lastSeen: row.last_seen.toISOString(), verifiedAt: row.verified_at?.toISOString() ?? null, goneAt: row.gone_at?.toISOString() ?? null, externalMarkets: externalMarketLinks(a) };
  }
  /** keep the creator metadata already resolved for the same URI (it has its own TTL); resolve it otherwise */
  async function withMetadata(a: NftAsset, prev: store.AssetRow | null, o: { force?: boolean; budget?: { left: number } } = {}): Promise<NftAsset> {
    if (!o.force && prev && prev.asset.metadata.sourceUri === a.metadata.sourceUri && prev.asset.metadata.status !== 'not_loaded' && prev.asset.metadata.source && deps.now().getTime() - new Date(prev.asset.metadata.source.fetchedAt).getTime() < 24 * 3600_000) {
      a.metadata = { ...prev.asset.metadata, onchainName: a.metadata.onchainName, onchainSymbol: a.metadata.onchainSymbol, mutable: a.metadata.mutable, sourceUri: a.metadata.sourceUri };
      a.media = prev.asset.media; a.sources = [...a.sources, prev.asset.metadata.source];
      return deps.resolver.refreshMediaStates(a);
    }
    if (o.budget) { if (o.budget.left <= 0) return a; o.budget.left--; }
    return deps.resolver.resolveMetadata(a, { force: o.force });
  }
  async function withMarket(a: NftAsset, prev: store.AssetRow | null, force = false): Promise<NftAsset> {
    if (!deps.market || !deps.market.supports(a)) { a.market = null; return a; }
    const old = prev?.asset.market ?? null;
    if (!force && old && deps.now().getTime() - new Date(old.source.fetchedAt).getTime() < TTL_MARKET_MS) { a.market = old; return a; }
    try { a.market = await deps.market.snapshot(a); a.sources = [...a.sources.filter((s) => s.category !== 'market'), a.market.source]; }
    catch { a.market = old ? { ...old, source: { ...old.source, freshness: 'stale' } } : null; } // the market source failing never fails the item
    return a;
  }

  async function syncChain(chain: string): Promise<void> {
    const p = providerOf(chain), addr = (await deps.addresses())[chain];
    if (!p || !addr) return;
    const now = deps.now(), manual = (await store.manualKeys(chain)).map((k) => parseNftKey(k).assetId);
    let inv: { assets: NftAsset[]; sections: InventorySection[] };
    try { inv = await p.inventory(chain, addr, { manual, max: cfg.inventoryMax }); }
    catch (e) { await store.saveSections(chain, [{ section: 'inventory', status: 'error', code: e instanceof NftProviderError ? e.code : 'provider_unavailable', unlockedBy: null, source: p.id, count: 0, truncated: false }], now); return; }
    const budget = { left: METADATA_PER_SYNC };
    for (const a of inv.assets) {
      const prev = await store.getAsset(a.key);
      await withMetadata(a, prev, { budget }).catch(() => a);
      if (prev?.asset.market) a.market = prev.asset.market;
      await store.upsertAsset(a, now);
    }
    for (const s of inv.sections) if (s.status === 'ok' && !s.truncated && SECTION_STANDARDS[s.section])
      await store.markGone(chain, SECTION_STANDARDS[s.section]!, inv.assets.filter((a) => a.ownership.heldByWallet).map((a) => a.key), now);
    await store.saveSections(chain, inv.sections, now);
    lastSync.set(chain, now.getTime());
  }
  function startSync(chain: string): Promise<void> {
    let job = running.get(chain);
    if (!job) { job = syncChain(chain).catch(() => {}).finally(() => running.delete(chain)); running.set(chain, job); }
    return job;
  }
  const syncable = async (): Promise<string[]> => { const addrs = await deps.addresses(); return deps.providers.flatMap((p) => p.chains()).filter((c) => addrs[c]); };

  return {
    present,
    /** The real matrix: every network of the registry, what can be read for it and why not. */
    async capabilities(): Promise<{ chains: ChainCapability[]; providers: { id: string; on: boolean; unlockedBy: string | null; sends: string }[]; budget: { source: string; requests: number; bytes: string }[]; limits: Record<string, number> }> {
      const rows = await store.syncRows(), addrs = await deps.addresses().catch(() => ({} as Record<string, string>));
      const chains = NETS().map((n): ChainCapability => {
        const p = providerOf(n.id), sections = rows.filter((r) => r.chain === n.id).map((r) => ({ section: r.section, status: r.status, code: r.code, unlockedBy: r.unlocked_by, source: r.source, count: r.count, truncated: r.truncated, syncedAt: r.synced_at.toISOString() }));
        const ts = p ? TRANSFER_STANDARDS[n.family] ?? [] : [];
        const base = { network: n.id, name: n.name, family: n.family, transfer: ts.length ? 'supported' as const : 'not_supported' as const, transferStandards: ts, transferReason: ts.length ? null : n.id === 'bitcoin' ? 'ordinals_transfer_not_supported' : 'no_adapter',
          marketWrite: false as const, sections, receive: !!addrs[n.id] && (!!p || n.id === 'bitcoin') };
        if (n.family === 'sol' && p) { const blocked = sections.filter((s) => s.status === 'blocked_by_provider');
          return { ...base, inventory: blocked.length ? 'partial' : 'supported', reason: blocked.length ? `sections_blocked:${blocked.map((s) => s.section).join(',')}` : 'onchain_and_das', unlockedBy: blocked[0]?.unlockedBy ?? null,
            standards: ['metaplex-token-metadata', 'metaplex-pnft', 'spl-token-2022', 'metaplex-core', 'metaplex-bubblegum'], lookup: true, manualAdd: true, marketRead: !!deps.market || !!deps.marketService?.readsChain(n.id) }; }
        if (n.family === 'evm' && p) { const idx = !!cfg.evmIndexers[n.id] || (deps.evmHints ?? []).some((h) => h.notCovered(n.id) === null);
          // a source is configured for the network, but its last answer may be a refusal for THIS network (a key whose plan does not enable it): that is blocked, with its reason
          const refused = sections.find((s) => s.section === 'indexer' && s.status === 'blocked_by_provider');
          return { ...base, inventory: idx && !refused ? 'supported' : 'blocked_by_provider', reason: refused ? (refused.code ?? 'blocked').split(':')[0]! : idx ? 'indexer_hint_verified_onchain' : 'no_keyless_discovery', unlockedBy: refused ? refused.unlockedBy : idx ? null : UNLOCK_DISCOVERY, standards: ['erc721', 'erc1155'], lookup: true, manualAdd: true, marketRead: !!deps.marketService?.readsChain(n.id) }; }
        if (n.id === 'bitcoin') return { ...base, inventory: 'blocked_by_provider', reason: 'ordinals_need_ord_indexer', unlockedBy: null, standards: ['ordinals-inscription'], lookup: false, manualAdd: false, marketRead: false };
        return { ...base, inventory: 'unsupported', reason: 'no_adapter', unlockedBy: null, standards: [], lookup: false, manualAdd: false, marketRead: false, receive: false };
      });
      return { chains, budget: await store.budgetToday(deps.now()),
        providers: [
          { id: 'solana-rpc', on: true, unlockedBy: null, sends: 'wallet_address_to_rpc' },
          { id: 'solana-das', on: cfg.solanaDasUrl !== 'off', unlockedBy: cfg.solanaDasUrl === 'off' ? 'NFT_SOLANA_DAS' : null, sends: cfg.solanaDasUrl && cfg.solanaDasUrl !== 'off' ? 'wallet_address_to_das_host' : 'wallet_address_to_rpc' },
          { id: 'evm-rpc', on: true, unlockedBy: null, sends: 'wallet_address_to_rpc' },
          { id: 'evm-indexer', on: Object.keys(cfg.evmIndexers).length > 0, unlockedBy: Object.keys(cfg.evmIndexers).length ? null : 'NFT_EVM_INDEXER_URLS', sends: 'wallet_address_to_indexer_host' },
          // delivery 3: the keyed EVM discovery provider (hints only) and the market READ sources, as the market service reports them
          { id: 'evm-provider', on: (deps.evmHints ?? []).length > 0, unlockedBy: (deps.evmHints ?? []).length ? null : !cfg.evmProvider ? 'NFT_EVM_PROVIDER' : cfg.evmProvider === 'opensea' ? 'OPENSEA_API_KEY' : 'ALCHEMY_API_KEY', sends: (deps.evmHints ?? []).length ? `wallet_address_to_${deps.evmHints![0]!.id}` : 'nothing_until_enabled' },
          ...(deps.marketService ? deps.marketService.providers().map((m) => ({ id: m.id, on: m.state === 'on', unlockedBy: m.unlockedBy, sends: m.sends })) : [{ id: 'magiceden', on: !!deps.market, unlockedBy: deps.market ? null : 'NFT_MARKET_MAGICEDEN', sends: 'mint_only' }]),
          { id: 'ordinals', on: false, unlockedBy: null, sends: 'not_built' },
        ],
        limits: { inventoryMax: cfg.inventoryMax, mediaMaxBytes: cfg.mediaMaxBytes, dailyRequests: cfg.dailyRequests, dailyBytes: cfg.dailyBytes } };
    },

    /** Start (or join) a synchronisation of every chain that has a provider and an address; `wait` awaits it. */
    async sync(o: { chain?: string; wait?: boolean; onlyStale?: boolean } = {}): Promise<{ running: string[] }> {
      const chains = (await syncable()).filter((c) => !o.chain || c === o.chain), now = deps.now().getTime();
      const jobs = chains.filter((c) => !o.onlyStale || now - (lastSync.get(c) ?? 0) > TTL_SYNC_MS).map(startSync);
      if (o.wait) await Promise.all(jobs);
      return { running: [...running.keys()] };
    },
    syncState: () => ({ running: [...running.keys()], lastSyncedAt: Object.fromEntries([...lastSync].map(([c, t]) => [c, new Date(t).toISOString()])) }),

    async list(f: store.ListFilter) { const r = await store.listAssets(f); return { total: r.total, items: r.rows.map(present), hiddenSpam: f.spam === 'show' || f.spam === 'only' ? 0 : await store.spamCount() }; },

    /** One asset of the inventory (or one already looked up). Ownership is re-read on-chain when it is older than a minute. */
    async get(key: string, o: { verify?: boolean } = {}): Promise<ReturnType<typeof present> | null> {
      let row = await store.getAsset(key);
      if (!row) return null;
      const now = deps.now();
      if ((o.verify ?? true) && (!row.verified_at || now.getTime() - row.verified_at.getTime() > TTL_OWNERSHIP_MS)) {
        const k = parseNftKey(key), p = providerOf(k.chainId);
        if (p) {
          try {
            const wallet = (await deps.addresses())[k.chainId] ?? null, [c, t] = k.family === 'evm' ? k.assetId.split('/') : [k.assetId, undefined];
            const a = await p.lookup(k.chainId, { address: c!, tokenId: t }, wallet);
            a.origin = row.origin as NftAsset['origin'];
            await withMetadata(a, row); await withMarket(a, row);
            await store.upsertAsset(a, now);
            row = (await store.getAsset(key))!;
          } catch { /* the stored asset is answered, its stamps turning stale with time */ }
        }
      }
      row.asset = await deps.resolver.refreshMediaStates(row.asset);
      return present(row);
    },

    /** Explicit lookup of ANY asset by its chain identifier (the owner typed it). Stored as `lookup`: never part of the inventory. */
    async lookup(chain: string, address: string, tokenId?: string): Promise<ReturnType<typeof present>> {
      const p = need(chain), wallet = (await deps.addresses())[chain] ?? null, now = deps.now();
      const a = await p.lookup(chain, { address, tokenId }, wallet), prev = await store.getAsset(a.key);
      if (prev && prev.origin !== 'lookup') a.origin = prev.origin as NftAsset['origin'];
      await withMetadata(a, prev); await withMarket(a, prev);
      await store.upsertAsset(a, now);
      return present((await store.getAsset(a.key))!);
    },

    async refreshMetadata(key: string): Promise<ReturnType<typeof present>> {
      const row = await store.getAsset(key);
      if (!row) throw new NftProviderError('not_found', 'spw');
      const now = deps.now(), last = Math.max(lastRefresh.get(key) ?? 0, row.metadata_refreshed_at?.getTime() ?? 0);
      if (now.getTime() - last < REFRESH_COOLDOWN_MS) throw new NftProviderError('provider_rate_limited', 'spw', 'refresh_cooldown');
      lastRefresh.set(key, now.getTime());
      if (lastRefresh.size > 5000) lastRefresh.clear();
      // a refresh re-reads what the CREATOR declares (and the market snapshot); ownership and identity stay what the chain says
      const a = row.asset;
      await withMetadata(a, row, { force: true }); await withMarket(a, row, true);
      await store.saveAssetJson(a, { metadataRefreshed: now });
      return present((await store.getAsset(key))!);
    },

    async manualAdd(chain: string, address: string, tokenId?: string): Promise<ReturnType<typeof present>> {
      const p = need(chain), wallet = (await deps.addresses())[chain] ?? null, now = deps.now();
      const a = await p.lookup(chain, { address, tokenId }, wallet), prev = await store.getAsset(a.key); // verified on-chain before it is tracked
      if (!prev || prev.origin !== 'discovered') a.origin = 'manual'; else a.origin = 'discovered';
      await withMetadata(a, prev); await withMarket(a, prev);
      await store.addManual(a.key, chain); await store.upsertAsset(a, now);
      return present((await store.getAsset(a.key))!);
    },
    manualRemove: (key: string) => store.removeManual(key),

    /** Delivery 2: an NFT seen arriving (a finalized Transfer log to the wallet). It enters the inventory only if the chain confirms the wallet holds it NOW. */
    async adopt(chain: string, address: string, tokenId?: string): Promise<ReturnType<typeof present> | null> {
      const p = need(chain), wallet = (await deps.addresses())[chain] ?? null, now = deps.now();
      const a = await p.lookup(chain, { address, tokenId }, wallet);
      if (!a.ownership.heldByWallet || a.ownership.source.confidence !== 'chain_verified') return null;
      const prev = await store.getAsset(a.key);
      a.origin = prev && prev.origin === 'manual' ? 'manual' : 'discovered';
      await withMetadata(a, prev); await withMarket(a, prev);
      await store.upsertAsset(a, now);
      return present((await store.getAsset(a.key))!);
    },

    /** Events of one asset: what is stored, completed from the chain on the first request and when `more` is asked. */
    async activity(key: string, o: { cursor?: string | null; limit: number; type?: string; more?: boolean }): Promise<{ events: NftEvent[]; cursor: string | null; completeness: string; note: string | null; scannedAt: string | null; canLoadOlder: boolean; error: string | null }> {
      const row = await store.getAsset(key);
      if (!row) throw new NftProviderError('not_found', 'spw');
      const p = providerOf(row.chain), now = deps.now();
      let scan = await store.getScan(key), error: string | null = null;
      const due = !scan || (o.more && !scan.complete) || (!o.cursor && !o.more && now.getTime() - scan.scanned_at.getTime() > TTL_SYNC_MS);
      if (p && due) {
        try {
          const page = await p.events(row.asset, o.more && scan ? scan.cursor : null);
          await store.upsertEvents(page.events);
          const cursor = o.more || !scan ? page.cursor : scan.cursor ?? page.cursor;
          await store.putScan(key, { cursor, complete: cursor === null, completeness: page.completeness, note: page.note }, now);
          scan = await store.getScan(key);
        } catch (e) { error = e instanceof NftProviderError ? e.code : 'provider_unavailable'; }
      }
      let before: { block: string; id: string } | null = null;
      if (o.cursor) { const k = o.cursor.indexOf('|'); if (k > 0 && /^[0-9]{1,20}$/.test(o.cursor.slice(0, k))) before = { block: o.cursor.slice(0, k), id: o.cursor.slice(k + 1) }; }
      // delivery 2: a transfer SENT by this wallet is recorded from its own proposal (direction and finality known); the same
      // transaction read back from the contract's logs is the same event, not a second one
      const own = new Set((await store.listEvents(key, { limit: 200 })).filter((e) => e.index === 'spw-transfer').map((e) => e.tx));
      const events = (await store.listEvents(key, { limit: o.limit + 1 + own.size, before, type: o.type })).filter((e) => e.index === 'spw-transfer' || !own.has(e.tx)).slice(0, o.limit + 1);
      const page = events.slice(0, o.limit), last = page[page.length - 1];
      return { events: page, cursor: events.length > o.limit && last ? `${last.blockRef.slot ?? last.blockRef.number ?? '0'}|${last.id}` : null, completeness: scan?.completeness ?? (p ? 'unavailable' : 'unavailable'), note: scan?.note ?? null,
        scannedAt: scan?.scanned_at.toISOString() ?? null, canLoadOlder: !!scan && !scan.complete && !!scan.cursor, error };
    },

    async collection(key: string): Promise<{ info: CollectionInfo | null; error: string | null; metadata: { name: string | null; description: string | null; imageId: string | null; status: string } | null; held: number; fetchedAt: string | null }> {
      const k = parseNftKey(key), p = need(k.chainId), now = deps.now();
      let cached = await store.getCollection(key), error: string | null = null;
      if (!cached || now.getTime() - cached.fetched_at.getTime() > 6 * 3600_000) {
        try {
          const info = await p.collection(k.chainId, k.assetId);
          // the collection's own metadata document, through the same resolver as an item's
          let metadata: { name: string | null; description: string | null; imageId: string | null; status: string } | null = null;
          if (info.uri) { const probe = { key: `${key}#collection`, standard: info.standard, tokenId: null, metadata: { sourceUri: info.uri, status: 'not_loaded' }, sources: [], media: [], collection: null } as unknown as NftAsset;
            const r = await deps.resolver.resolveMetadata(probe); metadata = { name: r.metadata.name, description: r.metadata.description, imageId: r.media.find((m) => m.role === 'image')?.id ?? null, status: r.metadata.status }; }
          await store.putCollection(key, k.chainId, { info, metadata }, now); cached = await store.getCollection(key);
        } catch (e) { error = e instanceof NftProviderError ? e.code : 'provider_unavailable'; }
      }
      const data = cached?.data as { info: CollectionInfo; metadata: { name: string | null; description: string | null; imageId: string | null; status: string } | null } | undefined;
      const held = (await store.listAssets({ collection: key, status: 'in_wallet', sort: 'recent', limit: 1, offset: 0 })).total;
      return { info: data?.info ?? null, metadata: data?.metadata ?? null, error, held, fetchedAt: cached?.fetched_at.toISOString() ?? null };
    },
    collections: () => store.collectionCounts(),

    /** Where an NFT can be received: the wallet's address on each chain an adapter reads, with the warnings that apply. */
    async receive(): Promise<{ network: string; name: string; family: string; address: string; standards: string[]; warnings: string[]; detection: ChainSupport }[]> {
      const addrs = await deps.addresses(), caps = (await this.capabilities()).chains;
      return caps.filter((c) => addrs[c.network] && (c.lookup || c.network === 'bitcoin')).map((c) => ({ network: c.network, name: c.name, family: c.family, address: addrs[c.network]!, standards: c.standards, detection: c.inventory,
        // delivery 2: Bitcoin — inscriptions are never TRANSFERRED by this wallet; ordinary sends keep away from locked / flagged outputs (nft/utxo.ts).
        // EVM without an indexer — arrivals are detected on contracts the wallet already knows, after finality; a new collection is added by hand once
        warnings: c.network === 'bitcoin' ? [cfg.ordinalsApiUrl ? 'ordinals_ord_source' : 'ordinals_heuristic_only', 'ordinals_no_transfer', 'arrival_after_confirmation'] : c.family === 'evm' ? ['evm_same_address_check_network', ...(c.inventory === 'blocked_by_provider' ? ['evm_arrival_known_contracts_only'] : []), 'arrival_after_confirmation'] : ['sol_compressed_needs_indexer', 'arrival_after_confirmation'] }));
    },

    async prune(): Promise<Awaited<ReturnType<typeof store.pruneNft>> & { evicted: number }> {
      const r = await store.pruneNft(deps.now()), over = await store.mediaOverCap(cfg.cacheMaxBytes);
      deps.resolver.removeFiles([...r.media, ...over]);
      return { ...r, evicted: over.length };
    },
    key: nftKey,
  };
}
export type NftService = ReturnType<typeof createNftService>;

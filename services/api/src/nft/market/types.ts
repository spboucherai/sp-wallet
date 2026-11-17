// `NftMarketProvider` — one isolated adapter per market data source (brief §4 Phase C, §6 category 4). It sits BESIDE
// `NftDataProvider` (provider.ts) and never replaces it: a market provider says what a marketplace REPORTS (listings, offers,
// sales, collection statistics, the marketplace's own badge); it never says who holds an asset, and nothing it answers is
// promoted to chain truth. READ ONLY: this interface has no method that builds, signs or submits an order — market writes do
// not exist in this version (docs/nft/NFT-MARKET-WRITES.md is the decision document for the first one).
//
// Every adapter is server-side, receives its HTTP transport (tests replay recorded or documented answers), names what it sends
// upstream (`sends`), and throws `NftProviderError` with a stable code — never a URL, a key or a response body.
import type { CollectionMarket, ItemMarket, MarketEvent, MarketListing, MarketOffer, NftCurrency, Page } from '@spw/nft';

export type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;

/** What a market provider is asked about: on-chain identifiers only. No wallet address is ever part of it. */
export interface MarketRef {
  key: string; family: string; chain: string; standard: string;
  /** EVM */ contract: string | null; tokenId: string | null;
  /** Solana */ mint: string | null;
}
/** The provider's own collection identifier (slug / symbol): learnt from its answer about an item, never guessed from a name. */
export interface CollectionMarketRef { chain: string; slug: string }
export type MarketDataKind = 'item' | 'listings' | 'offers' | 'events' | 'collection';
export interface EventQuery { cursor: string | null; types: string[] | null; after: string | null; before: string | null; limit: number }

export type ItemMarketData = Omit<ItemMarket, 'status'>;
export type CollectionMarketData = Omit<CollectionMarket, 'status'>;

export interface NftMarketProvider {
  id: string; name: string;
  /** static facts, shown in the provider status (Settings → developer status) */
  describe(): {
    chains: string[];
    /** what leaves this server when the provider is asked */
    sends: 'mint_only' | 'contract_and_token_id' | 'nothing';
    attribution: { text: string; url: string } | null;
    /** where the terms were read, and when */
    terms: { url: string; readAt: string; note: string } | null;
    /** requests this server allows itself per minute / per day towards the provider */
    limits: { perMinute: number; perDay: number };
    /** `live`: the adapter was run against the real API; `documentation`: coded against the documented shapes only */
    verification: 'live' | 'documentation';
  };
  /** null when the provider covers the asset; otherwise the stable reason (`chain_not_covered`, `standard_not_covered`) */
  notCovered(ref: MarketRef): string | null;
  item(ref: MarketRef): Promise<ItemMarketData>;
  listings?(ref: MarketRef, cursor: string | null): Promise<Page<MarketListing>>;
  offers?(ref: MarketRef, cursor: string | null): Promise<Page<MarketOffer>>;
  events?(ref: MarketRef, q: EventQuery): Promise<Page<MarketEvent>>;
  collection?(ref: CollectionMarketRef): Promise<CollectionMarketData>;
}

/** A provider slot that exists in this version but is not instantiated (no key, or turned off). It is REPORTED, never called. */
export interface AbsentProvider { id: string; name: string; state: 'needs_key' | 'off'; code: 'no_api_key' | 'not_enabled'; unlockedBy: string; unlocks: string; chains: string[] }

export const refOf = (a: { key: string; family: string; chainId: string; standard: string; contractAddress: string | null; tokenId: string | null; mintAddress: string | null; assetId: string }): MarketRef =>
  ({ key: a.key, family: a.family, chain: a.chainId, standard: a.standard, contract: a.contractAddress, tokenId: a.tokenId, mint: a.family === 'sol' ? a.mintAddress ?? a.assetId : null });

export type { NftCurrency };

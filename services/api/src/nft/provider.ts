// `NftDataProvider` — one isolated adapter per chain family (brief §6). A provider answers three questions about ITS chains and
// nothing else: what does this address hold, what is this asset, what happened to it. It returns canonical `NftAsset`s whose
// on-chain part is filled and whose creator metadata is only POINTED at (`metadata.sourceUri`, status `not_loaded`): fetching
// creator-controlled URLs is the resolver's job (resolver.ts), market data is the market source's (market.ts). A provider never
// reads the database and never sees the session.
import { NFT_MODEL_VERSION, capabilitiesOf, known, unknown, UNSUPPORTED, type DataSourceStamp, type Known, type NftAsset, type NftEvent, type NftMetadataRecord, type NftOwnershipRecord, type NftStandard, type NftCollectionRef } from '@spw/nft';

export type SectionStatus = 'ok' | 'blocked_by_provider' | 'error' | 'not_configured';
/** One independent source of an inventory (e.g. Solana: token accounts / Core assets / compressed). A failed section never empties the others. */
export interface InventorySection { section: string; status: SectionStatus; /** stable code when not ok */ code: string | null; /** name of the variable that would unlock it */ unlockedBy: string | null; source: string | null; count: number; truncated: boolean }
export interface InventoryResult { assets: NftAsset[]; sections: InventorySection[] }
export interface EventPage { events: NftEvent[]; cursor: string | null; completeness: 'full' | 'partial' | 'recent_window' | 'unavailable'; note: string | null }
export interface CollectionInfo { key: string; id: string; chain: string; standard: NftStandard | 'unknown'; onchainName: string | null; uri: string | null; size: Known<string>; updateAuthority: Known<string>; features: string[]; source: DataSourceStamp }

export interface NftDataProvider {
  id: string; family: string;
  chains(): string[];
  /** everything `owner` holds on `chain`, section by section */
  inventory(chain: string, owner: string, o: { manual: string[]; max: number }): Promise<InventoryResult>;
  /** one asset by its chain identifier; `wallet` is the wallet's own address on that chain (to say whether it holds it) */
  lookup(chain: string, ref: { address: string; tokenId?: string }, wallet: string | null): Promise<NftAsset>;
  events(asset: NftAsset, cursor: string | null): Promise<EventPage>;
  collection(chain: string, id: string): Promise<CollectionInfo>;
}

export type RpcFn = (url: string, method: string, params: unknown) => Promise<unknown>;
export const rpcCodeOf = (e: unknown): number | undefined => (e as { rpcCode?: number }).rpcCode;

export const emptyMetadata = (sourceUri: string | null, o: Partial<NftMetadataRecord> = {}): NftMetadataRecord => ({
  status: sourceUri ? 'not_loaded' : 'no_uri', errorCode: null, sourceUri, resolvedUri: null, onchainName: null, onchainSymbol: null, name: null, description: null, externalUrl: null, attributes: [], raw: null, contentHash: null,
  mutable: unknown(), traitStatistics: { computed: false, reason: 'no_collection_index' }, source: null, ...o });

/** Assemble an asset from the on-chain facts a provider established; capabilities are derived, never passed in. */
export function buildAsset(a: {
  family: string; chainId: string; assetId: string; key: string; standard: NftStandard; ownerAddress: string | null; tokenId?: string | null; contractAddress?: string | null; mintAddress?: string | null;
  quantity: string; supply?: Known<string>; collection?: NftCollectionRef | null; updateAuthority?: Known<string>; creators?: NftAsset['creators']; tokenProgram?: string | null; royaltyBps?: Known<number>; ruleSet?: Known<string>; extensions?: string[];
  metadata: NftMetadataRecord; ownership: NftOwnershipRecord; sources: DataSourceStamp[]; fetchedAt: string; blockRef?: NftAsset['blockRef']; origin: NftAsset['origin']; explorerUrl: string | null;
}): NftAsset {
  const base = { standard: a.standard, ownership: a.ownership, ruleSet: a.ruleSet ?? UNSUPPORTED, extensions: a.extensions ?? [], quantity: a.quantity, metadata: a.metadata };
  return { modelVersion: NFT_MODEL_VERSION, key: a.key, family: a.family, chainId: a.chainId, ownerAddress: a.ownerAddress, assetId: a.assetId, standard: a.standard, tokenId: a.tokenId ?? null, contractAddress: a.contractAddress ?? null, mintAddress: a.mintAddress ?? null,
    quantity: a.quantity, supply: a.supply ?? unknown(), collection: a.collection ?? null, updateAuthority: a.updateAuthority ?? UNSUPPORTED, creators: a.creators ?? UNSUPPORTED, tokenProgram: a.tokenProgram ?? null, royaltyBps: a.royaltyBps ?? unknown(),
    ruleSet: base.ruleSet, extensions: base.extensions, metadata: a.metadata, media: [], ownership: a.ownership, market: null, capabilities: capabilitiesOf(base), sources: a.sources, fetchedAt: a.fetchedAt, blockRef: a.blockRef ?? null, origin: a.origin, explorerUrl: a.explorerUrl };
}
export { known, unknown };

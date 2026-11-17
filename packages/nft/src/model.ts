// SP Wallet — NFT canonical data model, version 1 (docs/nft/NFT-BRIEF.md §5, docs/nft/NFT-ARCHITECTURE.md).
//
// Rules this file encodes:
//  - an asset is identified by `key` = `family:chainId:assetId`, computed here and nowhere else; never by a name, an image or a symbol;
//  - every integer that comes from a chain (token id, quantity, slot, block number, price) is a decimal STRING — never a JS number;
//  - "we do not know" (`unknown`), "this does not exist on this standard" (`unsupported`), "the chain says there is none" (`none`)
//    and a value are four different states (`Known<T>`); zero is a value;
//  - every external value carries a `DataSourceStamp` saying which of the FIVE categories it belongs to and where it came from;
//  - what the creator declared (metadata) is kept raw beside the normalised fields.
// Pure: no I/O, no clock. Shared by the API (adapters, store, routes) and by the tests.

export const NFT_MODEL_VERSION = 1;

/** The five data categories of the brief (§6). They are never merged: a value has exactly one. */
export type DataCategory = 'onchain' | 'creator_metadata' | 'indexed' | 'market' | 'computed';
/** How much the value can be relied on: read from the chain by this server / asserted by a third party / declared by the creator. */
export type Confidence = 'chain_verified' | 'chain_single_source' | 'indexer_reported' | 'creator_declared' | 'market_reported' | 'computed';
export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface BlockRef { number?: string; hash?: string; slot?: string; commitment?: string }
export interface DataSourceStamp {
  category: DataCategory;
  /** stable identifier of the source: `solana-rpc`, `solana-das`, `evm-rpc`, `metadata-uri`, `magiceden`, `ord`, `spw` */
  source: string;
  /** what the source is, for a reader: host of the endpoint(s) asked — never a URL with a key in it */
  detail: string;
  /** ISO time this server obtained the value */
  fetchedAt: string;
  blockRef?: BlockRef;
  confidence: Confidence;
  freshness: Freshness;
  /** the part of the asset this stamp covers */
  covers: ('ownership' | 'identity' | 'state' | 'collection' | 'metadata' | 'media' | 'events' | 'market' | 'traits')[];
}

/** A value whose absence has a meaning. `unknown`: could not be established. `unsupported`: the standard has no such notion. `none`: established as absent. */
export type Known<T> = { state: 'known'; value: T } | { state: 'none' } | { state: 'unknown'; reason?: string } | { state: 'unsupported' };
export const known = <T>(value: T): Known<T> => ({ state: 'known', value });
export const NONE = { state: 'none' } as const;
export const UNSUPPORTED = { state: 'unsupported' } as const;
export const unknown = (reason?: string): Known<never> => (reason ? { state: 'unknown', reason } : { state: 'unknown' });
export const valueOf = <T>(k: Known<T> | undefined): T | null => (k && k.state === 'known' ? k.value : null);

export type NftStandard =
  | 'metaplex-token-metadata'   // SPL Token mint + Metaplex Token Metadata (NonFungible / NonFungibleEdition)
  | 'metaplex-pnft'             // programmable NFT: transfers only through the Token Metadata program, token account frozen
  | 'metaplex-core'             // Metaplex Core asset (single account)
  | 'metaplex-bubblegum'        // compressed NFT (a leaf of a merkle tree; exists for this server only through an indexer)
  | 'spl-token-2022'            // Token-2022 mint with supply 1 / 0 decimals (with or without Token Metadata / metadata extension)
  | 'spl-token'                 // SPL mint with supply 1 / 0 decimals and NO Metaplex metadata account
  | 'erc721' | 'erc1155'
  | 'evm-nonstandard'           // answers some NFT calls but does not declare / satisfy ERC-721 or ERC-1155
  | 'ordinals-inscription'
  | 'unknown';

export interface NftCollectionRef {
  /** `family:chainId:collectionId` — collectionId is the collection mint / Core collection address / EVM contract */
  key: string;
  id: string;
  /** Solana: the `verified` flag of the on-chain collection field (set by the collection's authority). EVM: unsupported (a contract is its own collection). */
  verifiedOnChain: Known<boolean>;
  /** name as declared by the collection's own metadata, when loaded; never copied from an item */
  name: string | null;
  source: DataSourceStamp;
}

export interface NftAttribute {
  /** exactly what the metadata contained for this entry */
  raw: unknown;
  traitType: string | null;
  /** value kept as given: string, number (as its decimal string in `valueText`), boolean, or null */
  value: string | number | boolean | null;
  valueText: string;
  displayType: string | null;
  maxValue: string | null;
  /** true when the entry was not an object with a value (kept and shown, flagged) */
  malformed: boolean;
}
export interface TraitStatistics { computed: false; reason: 'no_collection_index' | 'collection_unverified' | 'compressed' | 'mutable_metadata' | 'not_built' }

export type MetadataStatus = 'ok' | 'missing' | 'no_uri' | 'blocked' | 'unreachable' | 'malformed' | 'too_large' | 'not_loaded';
export interface NftMetadataRecord {
  status: MetadataStatus;
  /** code of the refusal / failure when status is not ok (resolver codes: scheme_not_allowed, private_address, …) */
  errorCode: string | null;
  /** the URI exactly as the chain / contract gives it */
  sourceUri: string | null;
  /** what was actually requested (gateway applied, `{id}` substituted) */
  resolvedUri: string | null;
  /** on-chain fields (Solana metadata account / Core asset): they are chain data, not creator JSON */
  onchainName: string | null;
  onchainSymbol: string | null;
  /** normalised from the JSON document — creator-declared */
  name: string | null;
  description: string | null;
  externalUrl: string | null;
  attributes: NftAttribute[];
  /** the JSON document as fetched (bounded in size and depth); null when not loaded */
  raw: unknown;
  /** sha-256 of the bytes fetched, hex */
  contentHash: string | null;
  mutable: Known<boolean>;
  traitStatistics: TraitStatistics;
  source: DataSourceStamp | null;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'html' | 'model' | 'unknown';
export type MediaStatus = 'available' | 'not_fetched' | 'blocked' | 'unreachable' | 'unsupported_type' | 'too_large';
export interface NftMediaRecord {
  role: 'image' | 'animation' | 'file';
  /** opaque id of the media proxy (`/api/v1/nfts/media/<id>`); the browser never receives a third-party URL to load */
  id: string;
  sourceUri: string;
  resolvedUri: string | null;
  declaredMime: string | null;
  /** sniffed from the bytes once fetched */
  mime: string | null;
  kind: MediaKind;
  status: MediaStatus;
  errorCode: string | null;
  bytes: string | null;
}

export type OwnershipState = 'in_wallet' | 'not_in_wallet' | 'escrow_or_delegated' | 'burned' | 'unknown';
export interface NftOwnershipRecord {
  state: OwnershipState;
  /** the address the chain names as holder (Solana: token-account owner / Core owner; EVM: ownerOf) */
  owner: Known<string>;
  /** Solana SPL: the token account that holds the unit */
  tokenAccount: Known<string>;
  frozen: Known<boolean>;
  delegate: Known<string>;
  /** pNFT token record state */
  tokenRecordState: Known<'unlocked' | 'locked' | 'listed'>;
  /** true when `owner` is one of the wallet's own addresses on this chain */
  heldByWallet: boolean;
  source: DataSourceStamp;
}

/**
 * Why an asset cannot be sent. Since delivery 2 every code is a FACT about the asset (or about what this wallet can build): an
 * asset with no reason is transferable. The four codes of the last line belong to delivery 1 (stored rows, older clients) and
 * are no longer produced.
 */
export type TransferBlockReason =
  | 'not_in_wallet' | 'burned' | 'frozen' | 'pnft_locked' | 'pnft_listed' | 'delegated' | 'soulbound' | 'escrow' | 'unsupported_standard' | 'ownership_unknown'
  | 'token2022_extension_unsupported'   // a Token-2022 extension this wallet does not account for (transfer hook, permanent delegate, transfer fee, …)
  | 'compressed_transfer_not_supported' // compressed NFT: the merkle proof is not verified against the on-chain tree by this wallet
  | 'ordinals_transfer_not_supported'   // Bitcoin inscription: no ord-aware transfer in this wallet
  | 'source_not_associated_account'     // Solana: the unit sits in a token account that is not the wallet's associated token account
  | 'ownership_single_source'           // the endpoints did not agree on (or only one answered about) the ownership: nothing is prepared
  | 'network_disabled_by_policy'        // the signer's policy does not enable this standard on this network
  | 'transfer_not_built' | 'pnft_rule_set' | 'compressed_requires_indexer' | 'ordinals_requires_ord_aware_send';
/** Something the owner must read before sending; never a block. */
export type TransferWarning = 'pnft_rule_set' | 'core_collection_permanent_delegate' | 'core_permanent_delegate' | 'mutable_metadata' | 'contract_recipient' | 'creates_token_account' | 'semi_fungible';
export interface NftCapabilities {
  viewable: boolean;
  /** true when nothing in `transferBlockedBy` applies (delivery 2). The signer's policy and the re-verification at preparation time still decide. */
  transferable: boolean;
  /** every reason that applies, the most specific first; empty when the asset can be sent */
  transferBlockedBy: TransferBlockReason[];
  /** facts the review must show (delivery 2) */
  transferWarnings: TransferWarning[];
  /** market WRITE actions: never in delivery 1 */
  marketActions: false;
  marketBlockedBy: 'market_not_integrated';
}

export interface NftMarketSnapshot {
  source: DataSourceStamp;
  /** where the owner can see the item on the marketplace itself (opened outside SP Wallet) */
  url: string | null;
  listed: Known<boolean>;
  /** the address the MARKETPLACE names as seller — with an escrow marketplace this is not the on-chain holder (see `ownership.owner`) */
  seller: Known<string>;
  /** the marketplace's own collection identifier (a slug), when it gives one */
  marketCollection: string | null;
  /** asking price in base units of `currency` */
  listingPrice: Known<{ amount: string; currency: NftCurrency }>;
  bestOffer: Known<{ amount: string; currency: NftCurrency }>;
  lastSale: Known<{ amount: string; currency: NftCurrency; at: string }>;
  collectionFloor: Known<{ amount: string; currency: NftCurrency }>;
}
export interface NftCurrency { network: string; /** 'native' or the exact mint / contract */ asset: string; symbol: string; decimals: number }

export type NftEventType = 'mint' | 'transfer-in' | 'transfer-out' | 'transfer' | 'sale' | 'list' | 'delist' | 'offer' | 'cancel-offer' | 'accept-offer' | 'burn' | 'escrow' | 'unknown';
export interface NftEvent {
  /** stable: `<assetKey>|<tx>|<index>` */
  id: string;
  assetKey: string;
  type: NftEventType;
  /** `type` is what this server decoded from the raw trace; `interpretation` says so and names the decoder */
  interpretation: { by: string; note: string | null };
  tx: string;
  /** EVM log index / Solana instruction index (outer.inner), as a string */
  index: string;
  blockRef: BlockRef;
  /** ISO, UTC; null when the chain source gives no time */
  at: string | null;
  from: string | null;
  to: string | null;
  quantity: string;
  /** only with a payment linked by a market source; a transfer never carries one */
  price: { amount: string; currency: NftCurrency } | null;
  finality: 'finalized' | 'confirmed' | 'pending' | 'reorged';
  source: DataSourceStamp;
}

export interface NftAsset {
  modelVersion: typeof NFT_MODEL_VERSION;
  key: string;
  family: string;
  chainId: string;
  /** the wallet address the inventory was read for; null for an asset opened by explicit lookup */
  ownerAddress: string | null;
  assetId: string;
  standard: NftStandard;
  tokenId: string | null;
  contractAddress: string | null;
  mintAddress: string | null;
  /** units held by `ownerAddress` (or by the on-chain owner for a lookup); '0' is a value */
  quantity: string;
  /** total units that exist, when the chain says it */
  supply: Known<string>;
  collection: NftCollectionRef | null;
  /** Solana */
  updateAuthority: Known<string>;
  creators: Known<{ address: string; verified: boolean; share: number }[]>;
  tokenProgram: string | null;
  royaltyBps: Known<number>;
  ruleSet: Known<string>;
  /** Token-2022 extensions present on the mint, by name */
  extensions: string[];
  metadata: NftMetadataRecord;
  media: NftMediaRecord[];
  ownership: NftOwnershipRecord;
  market: NftMarketSnapshot | null;
  capabilities: NftCapabilities;
  sources: DataSourceStamp[];
  fetchedAt: string;
  blockRef: BlockRef | null;
  /** how the asset entered the inventory */
  origin: 'discovered' | 'manual' | 'lookup';
  explorerUrl: string | null;
}

// ── keys ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SEG = /^[a-z0-9-]{1,24}$/;
/** EVM asset id: `<contract lower-case>/<token id decimal>`. */
export function evmAssetId(contract: string, tokenId: string | bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error('bad contract address');
  const id = typeof tokenId === 'bigint' ? tokenId : parseTokenId(tokenId);
  return `${contract.toLowerCase()}/${id.toString(10)}`;
}
/** A token id given as decimal or 0x-hex, as an exact bigint in uint256 range. */
export function parseTokenId(s: string): bigint {
  if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(s)) throw new Error('bad token id');
  const v = BigInt(s);
  if (v < 0n || v >= 1n << 256n) throw new Error('token id out of range');
  return v;
}
/** `family:chainId:assetId` — deterministic; the asset id keeps the chain's own form (base58 is case-sensitive, EVM is lower-cased). */
export function nftKey(family: string, chainId: string, assetId: string): string {
  if (!SEG.test(family) || !SEG.test(chainId)) throw new Error('bad family or chain');
  if (!assetId || assetId.length > 200 || /[\s:?#%]/.test(assetId)) throw new Error('bad asset id');
  return `${family}:${chainId}:${assetId}`;
}
export function parseNftKey(key: string): { family: string; chainId: string; assetId: string } {
  const a = key.indexOf(':'), b = key.indexOf(':', a + 1);
  if (a < 1 || b < 0) throw new Error('bad nft key');
  const family = key.slice(0, a), chainId = key.slice(a + 1, b), assetId = key.slice(b + 1);
  if (nftKey(family, chainId, assetId) !== key) throw new Error('bad nft key');
  return { family, chainId, assetId };
}

// ── capabilities ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Token-2022 mint / account extensions a plain TransferChecked fully accounts for. Any other one blocks the transfer. */
export const TOKEN2022_TRANSFER_SAFE_EXTENSIONS = ['metadataPointer', 'tokenMetadata', 'groupPointer', 'groupMemberPointer', 'tokenGroup', 'tokenGroupMember', 'mintCloseAuthority', 'immutableOwner'] as const;
/** The extension names of a Token-2022 asset (the provider also lists editions and authorities in `extensions`, with a colon or as `freezeAuthority`). */
export const token2022Extensions = (extensions: string[]): string[] => extensions.filter((e) => !e.includes(':') && e !== 'freezeAuthority');

/** The reasons an asset cannot be sent, from facts only, the most specific first. Empty = a transfer can be prepared. */
export function transferBlockReasons(a: Pick<NftAsset, 'standard' | 'ownership' | 'ruleSet' | 'extensions' | 'quantity'>): TransferBlockReason[] {
  const r: TransferBlockReason[] = [], o = a.ownership;
  if (o.state === 'burned') r.push('burned');
  else if (o.state === 'unknown') r.push('ownership_unknown');
  else if (!o.heldByWallet) r.push(o.state === 'escrow_or_delegated' ? 'escrow' : 'not_in_wallet');
  if (a.standard === 'metaplex-pnft') {
    // a pNFT's token account is always frozen at the SPL level: its real state is the token record
    const s = valueOf(o.tokenRecordState);
    if (s === 'locked') r.push('pnft_locked'); else if (s === 'listed') r.push('pnft_listed');
    else if (o.heldByWallet && o.tokenRecordState.state !== 'known') r.push('ownership_unknown');
  } else if (valueOf(o.frozen) === true) r.push('frozen');
  else if (o.heldByWallet && o.frozen.state === 'unknown') r.push('ownership_unknown'); // a frozen state that could not be read is not "not frozen"
  // EVM: an approval never prevents the owner's own transfer (ERC-721 clears it on transfer), and approvals are not read: it is no block there
  const evm = a.standard === 'erc721' || a.standard === 'erc1155';
  if (o.delegate.state === 'known') r.push('delegated');
  else if (!evm && o.heldByWallet && o.delegate.state === 'unknown') r.push('ownership_unknown');
  if (a.standard === 'spl-token-2022') {
    const ext = token2022Extensions(a.extensions);
    if (ext.includes('nonTransferable')) r.push('soulbound');
    if (ext.some((e) => e !== 'nonTransferable' && !(TOKEN2022_TRANSFER_SAFE_EXTENSIONS as readonly string[]).includes(e))) r.push('token2022_extension_unsupported');
  } else if (a.extensions.includes('nonTransferable')) r.push('soulbound');
  if (a.standard === 'metaplex-bubblegum') r.push('compressed_transfer_not_supported');
  if (a.standard === 'ordinals-inscription') r.push('ordinals_transfer_not_supported');
  if (a.standard === 'unknown' || a.standard === 'evm-nonstandard' || a.standard === 'spl-token') r.push('unsupported_standard');
  return [...new Set(r)];
}
/** What the review must say about an asset that can be sent. */
export function transferWarnings(a: Pick<NftAsset, 'standard' | 'ruleSet' | 'extensions' | 'quantity'> & { metadata?: Pick<NftMetadataRecord, 'mutable'> }): TransferWarning[] {
  const w: TransferWarning[] = [];
  if (a.standard === 'metaplex-pnft' && a.ruleSet.state === 'known') w.push('pnft_rule_set');
  if (a.standard === 'metaplex-core') {
    if (a.extensions.some((e) => /^core-collection:Permanent(Transfer|Burn|Freeze)Delegate/.test(e))) w.push('core_collection_permanent_delegate');
    if (a.extensions.some((e) => /^core:Permanent(Transfer|Burn|Freeze)Delegate/.test(e))) w.push('core_permanent_delegate');
  }
  if (a.standard === 'erc1155') w.push('semi_fungible');
  if (a.metadata && valueOf(a.metadata.mutable) === true) w.push('mutable_metadata');
  return w;
}
export const capabilitiesOf = (a: Pick<NftAsset, 'standard' | 'ownership' | 'ruleSet' | 'extensions' | 'quantity'> & { metadata?: Pick<NftMetadataRecord, 'mutable'> }): NftCapabilities => {
  const blocked = transferBlockReasons(a);
  return { viewable: true, transferable: blocked.length === 0, transferBlockedBy: blocked, transferWarnings: transferWarnings(a), marketActions: false, marketBlockedBy: 'market_not_integrated' };
};

/** Provider failure with a stable code; `detail` never contains a URL query, a key or a response body. */
export class NftProviderError extends Error {
  constructor(public code: NftErrorCode, public source: string, detail = '') { super(`${source}: ${code}${detail ? ` (${detail})` : ''}`); }
}
export type NftErrorCode = 'provider_unavailable' | 'provider_rate_limited' | 'provider_bad_answer' | 'provider_not_configured' | 'provider_method_unsupported'
  | 'provider_disagreement' | 'not_found' | 'unsupported_chain' | 'unsupported_standard' | 'bad_identifier' | 'budget_exhausted';

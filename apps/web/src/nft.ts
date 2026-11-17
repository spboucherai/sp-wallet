// NFT (delivery 1, read-only) — what the screens share: the shapes the API answers (services/api/src/nft, model v1 of
// packages/nft/src/model.ts), the queries, and the pure helpers that turn a state into words. Nothing here invents a value:
// a `Known<T>` that is not `known` is shown as what it is (none / unknown / not applicable), never as a default.
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { Key } from './i18n';

export type Known<T> = { state: 'known'; value: T } | { state: 'none' } | { state: 'unknown'; reason?: string } | { state: 'unsupported' };
export interface Stamp { category: 'onchain' | 'creator_metadata' | 'indexed' | 'market' | 'computed'; source: string; detail: string; fetchedAt: string; blockRef?: { slot?: string; number?: string; commitment?: string }; confidence: string; freshness: 'fresh' | 'stale' | 'unknown'; covers: string[] }
export interface NftMedia { role: 'image' | 'animation' | 'file'; id: string; sourceUri: string; resolvedUri: string | null; declaredMime: string | null; mime: string | null; kind: 'image' | 'video' | 'audio' | 'html' | 'model' | 'unknown'; status: string; errorCode: string | null; bytes: string | null }
export interface NftAttr { raw: unknown; traitType: string | null; value: string | number | boolean | null; valueText: string; displayType: string | null; maxValue: string | null; malformed: boolean }
export interface NftCurrency { network: string; asset: string; symbol: string; decimals: number }
export interface NftItem {
  key: string; family: string; chainId: string; assetId: string; standard: string; tokenId: string | null; contractAddress: string | null; mintAddress: string | null; quantity: string; supply: Known<string>; ownerAddress: string | null;
  collection: { key: string; id: string; name: string | null; verifiedOnChain: Known<boolean>; source: Stamp } | null; updateAuthority: Known<string>; creators: Known<{ address: string; verified: boolean; share: number }[]>; tokenProgram: string | null; royaltyBps: Known<number>; ruleSet: Known<string>; extensions: string[];
  metadata: { status: string; errorCode: string | null; sourceUri: string | null; resolvedUri: string | null; onchainName: string | null; onchainSymbol: string | null; name: string | null; description: string | null; externalUrl: string | null; attributes: NftAttr[]; contentHash: string | null; mutable: Known<boolean>; traitStatistics: { computed: false; reason: string }; source: Stamp | null };
  media: NftMedia[];
  ownership: { state: string; owner: Known<string>; tokenAccount: Known<string>; frozen: Known<boolean>; delegate: Known<string>; tokenRecordState: Known<string>; heldByWallet: boolean; source: Stamp };
  market: { source: Stamp; url: string | null; listed: Known<boolean>; seller: Known<string>; marketCollection: string | null; listingPrice: Known<{ amount: string; currency: NftCurrency }>; bestOffer: Known<{ amount: string; currency: NftCurrency }>; lastSale: Known<{ amount: string; currency: NftCurrency; at: string }>; collectionFloor: Known<{ amount: string; currency: NftCurrency }> } | null;
  capabilities: { viewable: boolean; transferable: boolean; transferBlockedBy: string[]; transferWarnings?: string[]; marketActions: false; marketBlockedBy: string };
  /** delivery 2: the per-asset verdict (facts of the asset + the signer's NFT policy) */
  transfer?: { transferable: boolean; blockedBy: string[]; warnings: string[]; standard: string; route: string | null };
  /** delivery 3 */ marketSources?: { provider: string; name: string; state: 'on' | 'needs_key' | 'off'; unlockedBy: string | null }[]; indexerFlags?: { spam: boolean; by: string; classifications: string[] } | null;
  sources: Stamp[]; fetchedAt: string; origin: 'discovered' | 'manual' | 'lookup'; explorerUrl: string | null; firstSeen: string; lastSeen: string; verifiedAt: string | null; goneAt: string | null; externalMarkets: { name: string; url: string }[];
}
export interface NftSummary { key: string; chain: string; family: string; standard: string; assetId: string; tokenId: string | null; name: string | null; onchainName: string | null; collection: { key: string; name: string | null; verifiedOnChain: Known<boolean> } | null; quantity: string; state: string; inWallet: boolean; origin: string;
  metadataStatus: string; image: { id: string; kind: string; status: string } | null; transferable?: boolean; transferBlockedBy: string | null; firstSeen: string; verifiedAt: string | null; goneAt: string | null; stale: boolean; /** delivery 3: an indexer's spam signal, named */ spam?: { by: string } | null }
export interface NftList { items: NftSummary[]; total: number; hiddenSpam?: number; cursor: number | null; sync: { running: string[]; lastSyncedAt: Record<string, string> }; valuation: { state: 'unavailable'; reason: string }; asOf: string }
export interface NftChainCap { network: string; name: string; family: string; inventory: 'supported' | 'partial' | 'blocked_by_provider' | 'unsupported'; reason: string; unlockedBy: string | null; standards: string[]; lookup: boolean; manualAdd: boolean; receive: boolean; transfer: 'supported' | 'not_supported'; transferStandards?: string[]; transferReason?: string | null; marketRead: boolean; marketWrite: false;
  sections: { section: string; status: string; code: string | null; unlockedBy: string | null; source: string | null; count: number; truncated: boolean; syncedAt: string }[] }
export interface NftCaps { chains: NftChainCap[]; providers: { id: string; on: boolean; unlockedBy: string | null; sends: string }[] }
export interface NftEventT { id: string; type: string; interpretation: { by: string; note: string | null }; tx: string; index: string; blockRef: { slot?: string; number?: string }; at: string | null; from: string | null; to: string | null; quantity: string; price: { amount: string; currency: NftCurrency } | null; finality: string; source: Stamp; /** delivery 3 */ marketProgram?: { id: string; name: string; source: string }; market?: { provider: string; venue: string | null; orderId: string | null } }
export interface NftActivity { events: NftEventT[]; cursor: string | null; completeness: string; note: string | null; scannedAt: string | null; canLoadOlder: boolean; error: string | null }
export interface NftReceiveRow { network: string; name: string; family: string; address: string; standards: string[]; warnings: string[]; detection: string }

// delivery 2 — transfers and the Bitcoin lock list (services/api/src/nft/transfer.ts, transfer-routes.ts)
export interface NftReview { key: string; network: string; networkName: string; standard: string; method: string; asset: string; tokenId: string | null; quantity: string; program: string; from: string; to: string; toKind: 'account' | 'contract' | 'new_account';
  fee: { estimate: string; max: string; symbol: string; decimals: number; rent: string | null }; warnings: string[]; simulation: { ok: true; detail: string; used: string | null; changes: { what: string; before: string; after: string; code?: string; params?: Record<string, string>; beforeCode?: string; afterCode?: string }[] };
  verified: { standard: string; ownership: string; endpoints: number; at: string }; accounts: { role: string; address: string; derived: string }[]; creatorMetadata: { name: string | null; collectionName: string | null; imageId: string | null } }
export interface NftTransferView { id: string; state: string; network: string; networkName: string; txid: string | null; explorer: string | null; confirmations: number; error: string | null; errorCode: string | null; errorParams: Record<string, string | number> | null; intentHash: string | null; nft: NftReview | null }
export interface UtxoRow { txid: string; vout: number; outpoint: string; value: number; signerLock: { reason: string; at: number } | null; ord: { inscriptions: string[]; runes: string[] } | null; excludedBy: string[]; reviewed: boolean; spendable: boolean }
export interface UtxoLocksView { network: string; address: string; mode: 'ord' | 'heuristic' | 'locks_only' | 'ord_unavailable'; ordConfigured: boolean; ordHost: string | null; ordError: string | null; signerSupportsLocks: boolean; utxos: UtxoRow[]; staleLocks: { outpoint: string; reason: string; at: number }[]; symbol: string; decimals: number }

export const mediaUrl = (id: string, run = false): string => `/api/v1/nfts/media/${id}${run ? '?run=1' : ''}`;
export const useNftCaps = () => useQuery({ queryKey: ['nft', 'caps'], queryFn: () => get<NftCaps>('/nfts/capabilities'), staleTime: 30_000 });
export const useNftItem = (key: string) => useQuery({ queryKey: ['nft', 'item', key], queryFn: () => get<NftItem>(`/nfts/item?key=${encodeURIComponent(key)}`), staleTime: 20_000, retry: false, enabled: !!key });

/** A display name NEVER comes from a guess: the creator's metadata name, else the on-chain name, else nothing (the screen then shows the identifier). */
export const displayName = (a: { name?: string | null; onchainName?: string | null; metadata?: { name: string | null; onchainName: string | null } }): string | null => a.metadata?.name ?? a.metadata?.onchainName ?? a.name ?? a.onchainName ?? null;
export const shortId = (s: string): string => (s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s);
/** base units → decimal string, exactly (BigInt; no float) */
export function unitsToText(amount: string, decimals: number): string {
  if (!/^[0-9]+$/.test(amount)) return amount;
  const s = amount.padStart(decimals + 1, '0'), i = s.slice(0, s.length - decimals), f = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return f ? `${i}.${f}` : i;
}
/** Only http(s) links are offered, with their host shown; anything else (javascript:, data:, …) is not a link. */
export function safeLink(raw: string | null | undefined): { href: string; host: string } | null {
  if (!raw) return null;
  try { const u = new URL(raw); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? { href: u.href, host: u.hostname } : null; } catch { return null; }
}
export const STANDARD_KEY: Record<string, Key> = { 'metaplex-token-metadata': 'nfStd_tm', 'metaplex-pnft': 'nfStd_pnft', 'metaplex-core': 'nfStd_core', 'metaplex-bubblegum': 'nfStd_cnft', 'spl-token-2022': 'nfStd_t22', 'spl-token': 'nfStd_spl', erc721: 'nfStd_721', erc1155: 'nfStd_1155', 'evm-nonstandard': 'nfStd_nonstd', 'ordinals-inscription': 'nfStd_ord', unknown: 'nfStd_unknown' };
export const provenanceKey = (s: Stamp): Key => (s.category === 'onchain' ? 'nfProvOnchain' : s.category === 'creator_metadata' ? 'nfProvCreator' : s.category === 'indexed' ? 'nfProvIndexed' : s.category === 'market' ? 'nfProvMarket' : 'nfProvComputed');
export const SOURCE_NAME: Record<string, string> = { 'solana-rpc': 'RPC Solana', 'solana-das': 'DAS', 'evm-rpc': 'RPC EVM', 'evm-indexer': 'Blockscout', 'metadata-uri': 'URI', magiceden: 'Magic Eden', opensea: 'OpenSea', alchemy: 'Alchemy', spw: 'SP Wallet' };

// ── delivery 3 — market READ data (services/api/src/nft/market). One row PER SOURCE; nothing is merged or averaged here either ──
export interface Money { amount: string; currency: NftCurrency; precision: 'exact' | 'source_decimal' }
export interface SourceStatus { provider: string; name: string; state: 'ok' | 'needs_key' | 'off' | 'not_covered' | 'error'; code: string | null; unlockedBy: string | null; stale: boolean; stamp: Stamp | null; attribution: { text: string; url: string } | null }
export interface MarketFee { kind: string; bps: number | null; amount: Money | null; recipient: string | null; required: boolean | null }
export interface MarketListing { orderId: string | null; price: Money; quantity: string; seller: string | null; venue: string | null; protocol: { name: string; address: string | null } | null; createdAt: string | null; expiresAt: string | null; fees: MarketFee[] | null }
export interface MarketOffer { orderId: string | null; price: Money; quantity: string; bidder: string | null; venue: string | null; scope: 'item' | 'collection' | 'trait'; createdAt: string | null; expiresAt: string | null }
export interface MarketSale { price: Money; quantity: string; at: string | null; tx: string | null; buyer: string | null; seller: string | null; venue: string | null }
export interface ItemMarketRow { status: SourceStatus; url: string | null; listed: Known<boolean>; ask: Known<MarketListing>; bestOffer: Known<MarketOffer>; lastSale: Known<MarketSale>; collection: { slug: string; name: string | null } | null; collectionFloor: Known<Money>;
  verification: { state: 'verified' | 'not_verified' | 'unknown'; providerValue: string | null; by: string } | null; flags: { suspicious: Known<boolean>; disabled: Known<boolean>; nsfw: Known<boolean> }; rarity: Known<{ rank: string; outOf: string | null; method: string; calculatedAt: string | null }> }
export interface Rate { symbol: string; usd: string | null; cad: string | null; source: string; priceAt: string | null; stale: boolean; withheld: string | null }
export interface MarketAction { id: string; available: false; reason: string }
export interface ExternalNotice { outsideWallet: true; walletConnect: boolean; keyExport: boolean; code: string }
export interface NftMarketAnswer { key: string; sources: ItemMarketRow[]; contradictions: { field: string; providers: string[]; note: string }[]; rates: Record<string, Rate>; asOf: string; actions: MarketAction[]; external: { links: { name: string; url: string }[]; notice: ExternalNotice }; value: { state: 'unavailable'; reason: string } }
export interface MarketOrders { sources: { status: SourceStatus; items: (MarketListing | MarketOffer)[]; cursor: string | null }[]; rates: Record<string, Rate>; actions: MarketAction[] }
export interface MarketEventRow { type: string; providerType: string; at: string | null; tx: string | null; from: string | null; to: string | null; quantity: string; price: Money | null; venue: string | null; flags: { washTrade: Known<boolean> } }
export interface MarketEvents { sources: { status: SourceStatus; events: MarketEventRow[]; cursor: string | null }[]; rates: Record<string, Rate> }
export interface CollectionMarketRow { status: SourceStatus; slug: string | null; name: string | null; description: string | null; url: string | null; imageId: string | null; bannerId: string | null; verification: ItemMarketRow['verification']; floor: Known<Money>;
  volumes: { interval: string; volume: Money | null; reported: { value: string; symbol: string } | null; sales: string | null }[]; listedCount: Known<string>; owners: Known<string>; totalSupply: Known<string>; fees: MarketFee[] | null;
  traits: Known<{ total: string; categories: { type: string; values: { value: string; count: string }[] }[]; truncated?: boolean }>; definitions: Record<string, string> }
export interface CollectionMarketAnswer { sources: CollectionMarketRow[]; rates: Record<string, Rate> }
export interface TraitAnswer { computed: boolean; reason: string | null; mutableMetadata: boolean | null; sources: { provider: string; name: string; computed: boolean; reason: string | null; total?: string; fetchedAt?: string; stale?: boolean; rows: { traitType: string; value: string; frequency: { count: string; total: string; percent: string } | null }[] }[] }
export interface MarketProviderRow { id: string; name: string; state: 'on' | 'needs_key' | 'off'; unlockedBy: string | null; unlocks: string; chains: string[]; sends: string; attribution: { text: string; url: string } | null; terms: { url: string; readAt: string; note: string } | null; verification: 'live' | 'documentation' | null;
  budget: { minute: { used: number; limit: number }; day: { used: number; limit: number }; refused: number; upstreamLimited: number } | null }
export interface FloorEstimate { enabled: boolean; state: 'unavailable'; excludedFromWalletTotal: true; estimate: null | { label: string; indicativeUsd: string | null; collectionsCounted: number; collectionsWithoutFloor: number; rates: Record<string, Rate>;
  collections: { collectionKey: string; chain: string; name: string | null; items: number; reason: string | null; used: { provider: string; floor: Money; fetchedAt: string; stale: boolean; indicative: Money } | null; floors: { provider: string; name: string; floor: Money; fetchedAt: string; stale: boolean }[] }[] } }

export const currencyKey = (c: NftCurrency): string => `${c.network}:${/^0x/.test(c.asset) ? c.asset.toLowerCase() : c.asset}`;
export const moneyText = (m: Money): string => `${unitsToText(m.amount, m.currency.decimals)} ${m.currency.symbol}`;
/** base units × a decimal rate → an amount with 2 decimals, exactly (BigInt, rounded down); null when the rate is not a plain decimal */
export function fiatText(amount: string, decimals: number, rate: string | null | undefined): string | null {
  const m = rate ? /^([0-9]+)(?:\.([0-9]{1,12}))?$/.exec(rate) : null;
  if (!m || !/^[0-9]{1,78}$/.test(amount)) return null;
  const scale = (m[2] ?? '').length, cents = BigInt(amount) * BigInt(m[1]! + (m[2] ?? '')) * 100n / 10n ** BigInt(decimals + scale), s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${s.slice(-2)}`;
}
/** What a collection is, said by whom: a marketplace's badge NAMED, else "known contract" (the chain knows the collection account / contract), else "not verified". Never promoted further. */
export function verificationOf(rows: { status: SourceStatus; verification: ItemMarketRow['verification'] }[], onchain: boolean): { kind: 'verified_by'; by: string[] } | { kind: 'known_contract' } | { kind: 'not_verified' } {
  const by = rows.filter((r) => r.status.state === 'ok' && r.verification?.state === 'verified').map((r) => r.verification!.by);
  return by.length ? { kind: 'verified_by', by } : onchain ? { kind: 'known_contract' } : { kind: 'not_verified' };
}

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
  capabilities: { viewable: boolean; transferable: false; transferBlockedBy: string[]; marketActions: false; marketBlockedBy: string };
  sources: Stamp[]; fetchedAt: string; origin: 'discovered' | 'manual' | 'lookup'; explorerUrl: string | null; firstSeen: string; lastSeen: string; verifiedAt: string | null; goneAt: string | null; externalMarkets: { name: string; url: string }[];
}
export interface NftSummary { key: string; chain: string; family: string; standard: string; assetId: string; tokenId: string | null; name: string | null; onchainName: string | null; collection: { key: string; name: string | null; verifiedOnChain: Known<boolean> } | null; quantity: string; state: string; inWallet: boolean; origin: string;
  metadataStatus: string; image: { id: string; kind: string; status: string } | null; transferBlockedBy: string; firstSeen: string; verifiedAt: string | null; goneAt: string | null; stale: boolean }
export interface NftList { items: NftSummary[]; total: number; cursor: number | null; sync: { running: string[]; lastSyncedAt: Record<string, string> }; valuation: { state: 'unavailable'; reason: string }; asOf: string }
export interface NftChainCap { network: string; name: string; family: string; inventory: 'supported' | 'partial' | 'blocked_by_provider' | 'unsupported'; reason: string; unlockedBy: string | null; standards: string[]; lookup: boolean; manualAdd: boolean; receive: boolean; transfer: 'not_built'; marketRead: boolean; marketWrite: false;
  sections: { section: string; status: string; code: string | null; unlockedBy: string | null; source: string | null; count: number; truncated: boolean; syncedAt: string }[] }
export interface NftCaps { chains: NftChainCap[]; providers: { id: string; on: boolean; unlockedBy: string | null; sends: string }[] }
export interface NftEventT { id: string; type: string; interpretation: { by: string; note: string | null }; tx: string; index: string; blockRef: { slot?: string; number?: string }; at: string | null; from: string | null; to: string | null; quantity: string; price: { amount: string; currency: NftCurrency } | null; finality: string; source: Stamp }
export interface NftActivity { events: NftEventT[]; cursor: string | null; completeness: string; note: string | null; scannedAt: string | null; canLoadOlder: boolean; error: string | null }
export interface NftReceiveRow { network: string; name: string; family: string; address: string; standards: string[]; warnings: string[]; detection: string }

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
export const SOURCE_NAME: Record<string, string> = { 'solana-rpc': 'RPC Solana', 'solana-das': 'DAS', 'evm-rpc': 'RPC EVM', 'evm-indexer': 'Blockscout', 'metadata-uri': 'URI', magiceden: 'Magic Eden', spw: 'SP Wallet' };

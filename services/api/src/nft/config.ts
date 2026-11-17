// NFT configuration (delivery 1, read-only). Everything is optional: with no variable set the feature works in its degraded
// mode (docs/nft/NFT-SOURCES.md). Values are read from an environment object; what is reported outward is variable NAMES and
// hosts only — never a URL that may carry a key, never a key.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORKS, type NetworkDef } from '@spw/core';
import { DEFAULT_GATEWAYS, parseGatewayList, type Gateways } from '@spw/nft';
import type { Capability } from '../capabilities.ts';

type Env = Record<string, string | undefined>;
const int = (v: string | undefined, d: number, min: number, max: number): number => { const n = Number(v); return v && Number.isInteger(n) && n >= min && n <= max ? n : d; };
const httpsBase = (name: string, v: string | undefined): string | null => {
  if (!v) return null;
  let u: URL; try { u = new URL(v); } catch { throw new Error(`${name}: invalid URL`); }
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`${name}: only https (or a loopback address) is accepted`);
  return v.replace(/\/+$/, '');
};

export interface NftConfig {
  enabled: boolean;
  /** DAS-capable Solana endpoint. null = probe the wallet's own Solana RPC endpoints; 'off' = never use DAS */
  solanaDasUrl: string | null | 'off';
  /** network id → base URL of a Blockscout-compatible instance (`/api/v2/addresses/<a>/nft`); empty = EVM discovery blocked */
  evmIndexers: Record<string, string>;
  marketMagicEden: boolean;
  gateways: Gateways;
  cacheDir: string;
  mediaMaxBytes: number; cacheMaxBytes: number;
  dailyRequests: number; dailyBytes: number;
  inventoryMax: number;
  /** delivery 2: base URL of a self-hosted `ord` server (inscription-aware coin selection for Bitcoin); null = heuristic only */
  ordinalsApiUrl: string | null;
}
export function nftConfig(env: Env = process.env): NftConfig {
  let evmIndexers: Record<string, string> = {};
  if (env.NFT_EVM_INDEXER_URLS) {
    let m: Record<string, unknown>;
    try { m = JSON.parse(env.NFT_EVM_INDEXER_URLS) as Record<string, unknown>; } catch { throw new Error('NFT_EVM_INDEXER_URLS: not valid JSON (expected {"<network>": "https://…"})'); }
    for (const [id, u] of Object.entries(m)) {
      const n = (NETWORKS as Record<string, NetworkDef | undefined>)[id];
      if (!n || n.family !== 'evm') throw new Error(`NFT_EVM_INDEXER_URLS: ${id} is not an EVM network of the registry`);
      evmIndexers[id] = httpsBase('NFT_EVM_INDEXER_URLS', String(u))!;
    }
  }
  return {
    enabled: env.NFT_ENABLED !== 'off',
    solanaDasUrl: env.NFT_SOLANA_DAS === 'off' ? 'off' : httpsBase('NFT_SOLANA_DAS_URL', env.NFT_SOLANA_DAS_URL),
    evmIndexers,
    marketMagicEden: env.NFT_MARKET_MAGICEDEN === 'on',
    gateways: { ipfs: parseGatewayList(env.NFT_IPFS_GATEWAYS, DEFAULT_GATEWAYS.ipfs), arweave: parseGatewayList(env.NFT_ARWEAVE_GATEWAYS, DEFAULT_GATEWAYS.arweave) },
    cacheDir: env.NFT_CACHE_DIR || join(env.SPW_DATA_DIR || tmpdir(), 'spw-nft-media'),
    mediaMaxBytes: int(env.NFT_MEDIA_MAX_BYTES, 25 * 1024 * 1024, 64 * 1024, 200 * 1024 * 1024),
    cacheMaxBytes: int(env.NFT_CACHE_MAX_BYTES, 1024 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024 * 1024),
    dailyRequests: int(env.NFT_FETCH_DAILY_REQUESTS, 5000, 1, 1_000_000), dailyBytes: int(env.NFT_FETCH_DAILY_BYTES, 2 * 1024 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    inventoryMax: int(env.NFT_INVENTORY_MAX, 500, 1, 5000),
    ordinalsApiUrl: httpsBase('NFT_ORDINALS_API_URL', env.NFT_ORDINALS_API_URL),
  };
}
export const hostOnly = (u: string): string => { try { return new URL(u).host; } catch { return 'invalid'; } };

/** Rows added to the server's capability list (capabilities.ts): which optional NFT sources are configured — names only. */
export function nftCapabilities(env: Env = process.env): Capability[] {
  let c: NftConfig;
  try { c = nftConfig(env); } catch (e) { return [{ id: 'nft', on: false, missing: [(e as Error).message.split(':')[0]!], why: `NFT configuration is invalid (${(e as Error).message.split(':')[0]}): the NFT routes answer nft_misconfigured` }]; }
  const evm = Object.keys(c.evmIndexers);
  return [
    { id: 'nft_inventory', on: c.enabled, missing: c.enabled ? [] : ['NFT_ENABLED'], why: c.enabled ? 'read-only NFT inventory: Solana (Token Metadata, pNFT, Token-2022, Core) from the wallet\'s RPC endpoints; EVM by manual addition verified on-chain' : 'NFT_ENABLED=off: the NFT routes answer nft_disabled' },
    { id: 'nft_solana_das', on: c.solanaDasUrl !== 'off', missing: c.solanaDasUrl === 'off' ? ['NFT_SOLANA_DAS'] : [],
      why: c.solanaDasUrl === 'off' ? 'NFT_SOLANA_DAS=off: no DAS indexer is asked — compressed NFTs are not listed' : c.solanaDasUrl ? 'compressed NFTs and indexed discovery come from the DAS endpoint of NFT_SOLANA_DAS_URL' : 'NFT_SOLANA_DAS_URL is not set: the wallet\'s own Solana RPC endpoints are probed for DAS methods at each sync (compressed NFTs are listed only while one of them answers)' },
    { id: 'nft_evm_discovery', on: evm.length > 0, missing: evm.length ? [] : ['NFT_EVM_INDEXER_URLS'],
      why: evm.length ? `EVM NFT discovery through a Blockscout-compatible indexer on: ${evm.join(', ')} (each item is re-verified on-chain); the wallet's EVM address is sent to those hosts` : 'NFT_EVM_INDEXER_URLS is not set: EVM NFTs are not discovered automatically (public RPC endpoints refuse wallet-wide log queries); an NFT is added by contract + token id and verified on-chain' },
    // delivery 2: NFT transfers (EVM ERC-721 / ERC-1155, Solana Token-2022 / Token Metadata / pNFT / Core) — always built; what is signed is bounded by the signer's NFT policy
    { id: 'nft_transfer', on: c.enabled, missing: c.enabled ? [] : ['NFT_ENABLED'], why: c.enabled ? 'NFT transfers: ERC-721 and ERC-1155 safeTransferFrom on the EVM networks; Token-2022, Token Metadata (programmable NFTs included) and Core on Solana — each one built by the signer from a passkey-approved intent, inside the signer\'s NFT policy. Compressed NFTs and Bitcoin inscriptions are not transferable' : 'NFT_ENABLED=off' },
    // delivery 2: inscription SAFETY of ordinary BTC sends (no inscription is listed or transferred). With an ord server its report decides; without one a heuristic flags small outputs
    { id: 'nft_ordinals', on: !!c.ordinalsApiUrl, missing: c.ordinalsApiUrl ? [] : ['NFT_ORDINALS_API_URL'], why: c.ordinalsApiUrl ? 'ordinary BTC sends never select an output the ord server of NFT_ORDINALS_API_URL reports as carrying an inscription or a rune (or does not know); with that server unreachable Bitcoin sends are refused. Inscriptions are not listed and not transferable' : 'NFT_ORDINALS_API_URL is not set: Bitcoin outputs of at most 10 000 sat, or created by a transaction with an inscription envelope, are kept out of ordinary sends by a HEURISTIC (not a detection) until the owner reviews or locks them; outputs locked with the passkey are refused by the signer. Inscriptions are not listed and not transferable' },
    { id: 'nft_market_read', on: c.marketMagicEden, missing: c.marketMagicEden ? [] : ['NFT_MARKET_MAGICEDEN'], why: c.marketMagicEden ? 'Solana listing state and collection floor are read from Magic Eden\'s public API (the mint is sent to Magic Eden, never the wallet address)' : 'NFT_MARKET_MAGICEDEN is not "on": no market data is requested; item pages link to the marketplace instead' },
  ];
}

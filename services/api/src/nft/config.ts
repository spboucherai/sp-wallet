/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/config.ts
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
  /** delivery 3 — market READ sources and the keyed EVM discovery provider. Keys are secrets: they are read here and nowhere else, and never reported */
  openSeaApiKey: string | null;
  /** OpenSea market read: on when the key is set, unless NFT_MARKET_OPENSEA=off */
  marketOpenSea: boolean;
  /** NFT_EVM_PROVIDER: which keyed indexer names the NFTs of the wallet's EVM address (hints, re-verified on-chain). It receives that address: never on by default */
  evmProvider: 'alchemy' | 'opensea' | null;
  alchemyApiKey: string | null;
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
  const key = (name: string, v: string | undefined): string | null => { if (!v) return null; if (!/^[A-Za-z0-9_-]{8,160}$/.test(v)) throw new Error(`${name}: unexpected format`); return v; };
  const evmProvider = env.NFT_EVM_PROVIDER ? env.NFT_EVM_PROVIDER.toLowerCase() : null;
  if (evmProvider !== null && evmProvider !== 'alchemy' && evmProvider !== 'opensea') throw new Error('NFT_EVM_PROVIDER: expected alchemy or opensea');
  const openSeaApiKey = key('OPENSEA_API_KEY', env.OPENSEA_API_KEY);
  return {
    openSeaApiKey, marketOpenSea: !!openSeaApiKey && env.NFT_MARKET_OPENSEA !== 'off', evmProvider,
    alchemyApiKey: key('ALCHEMY_API_KEY', env.ALCHEMY_API_KEY) ?? key('NFT_EVM_PROVIDER_API_KEY', env.NFT_EVM_PROVIDER_API_KEY),
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
  const provKey = c.evmProvider === 'alchemy' ? c.alchemyApiKey : c.evmProvider === 'opensea' ? c.openSeaApiKey : null, provVar = c.evmProvider === 'opensea' ? 'OPENSEA_API_KEY' : 'ALCHEMY_API_KEY';
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
    // delivery 3: keyed EVM discovery (hints only — every item is re-read on-chain). The provider receives the wallet's EVM address
    { id: 'nft_evm_provider', on: !!c.evmProvider && !!provKey, missing: !c.evmProvider ? ['NFT_EVM_PROVIDER'] : provKey ? [] : [provVar],
      why: !c.evmProvider ? 'NFT_EVM_PROVIDER is not set (alchemy | opensea): no keyed indexer is asked which NFTs the wallet\'s EVM address holds' : !provKey ? `NFT_EVM_PROVIDER=${c.evmProvider} needs ${provVar}: the provider is absent` : `EVM NFT discovery hints come from ${c.evmProvider} (the wallet's EVM address is sent to it); every item is re-verified on-chain; a network the key does not cover is reported blocked by provider` },
    // delivery 3: market READ sources. No market WRITE exists in this version (docs/nft/NFT-MARKET-WRITES.md)
    { id: 'nft_market_opensea', on: c.marketOpenSea, missing: c.marketOpenSea ? [] : [c.openSeaApiKey ? 'NFT_MARKET_OPENSEA' : 'OPENSEA_API_KEY'],
      why: c.marketOpenSea ? 'OpenSea API v2 market read (listing, best offer, last sale, events, collection statistics, the marketplace\'s badge) on Solana and 7 EVM networks; the contract + token id (or mint) of an opened item is sent to OpenSea, never the wallet address' : c.openSeaApiKey ? 'NFT_MARKET_OPENSEA=off: the OpenSea market source is turned off' : 'OPENSEA_API_KEY is not set: the OpenSea market source is absent (needsKey)' },
    { id: 'nft_market_read', on: c.marketMagicEden, missing: c.marketMagicEden ? [] : ['NFT_MARKET_MAGICEDEN'], why: c.marketMagicEden ? 'Solana market data (listing, offers, activity, collection floor) is read from Magic Eden\'s public API (the mint is sent to Magic Eden, never the wallet address)' : 'NFT_MARKET_MAGICEDEN is not "on": Magic Eden is not asked (its API terms page could not be read from the official site by this server: read it before turning the source on)' },
    { id: 'nft_market_write', on: false, missing: [], why: 'market writes (buy, sell, list, offer, accept, cancel) are not built: no order format is decoded, verified by the signer and simulated in this version; the screens link to the marketplaces\' own pages, outside SP Wallet' },
  ];
}

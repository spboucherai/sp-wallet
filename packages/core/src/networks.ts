// Network + asset registry. Every identifier here is pinned and cross-checked.
// USDC addresses: Circle official page https://developers.circle.com/stablecoins/usdc-contract-addresses
// (read 2026-11-10). Token addresses live in tokens.ts with their sources; all are re-verified on-chain at API start
// (symbol/decimals/chainId/genesis) and a token whose on-chain metadata differs is disabled.
/** 'evm', 'btc' (all Bitcoin-style UTXO chains) and 'sol' are built in; any other value names a plugin in families.ts */
export type Family = string;
export type NetworkId = string;

export interface AssetDef {
  /** 'native' or the token contract / mint address */
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Solana only: which token program owns the mint (classic SPL Token unless stated) */
  program?: 'token' | 'token2022';
}

export interface NetworkDef {
  id: NetworkId;
  family: Family;
  name: string;
  /** EVM: decimal chain id. BTC: genesis block hash. SOL: genesis hash. Stellar: network passphrase. */
  chainRef: string;
  native: AssetDef;
  tokens: AssetDef[];
  rpc: string[];
  explorerTx: string;
  explorerAddr: string;
  /** BIP-44 coin type used for key derivation (plugin and UTXO families) */
  coinType?: number;
  /** Bitcoin-style chains: address encoding and script kind */
  utxo?: { bech32?: string; pubKeyHash: number; scriptHash: number; kind: 'wpkh' | 'pkh'; dust: number };
  /** destination memo / tag support: free text or an unsigned 32-bit number */
  memo?: 'text' | 'uint32';
  /** minimum the account must hold to exist on-chain (shown on the receive screen), in whole units of the native coin */
  activation?: string;
  /** confirmations displayed as "enough" for small amounts (finality is checked per chain) */
  minConf: number;
}

import { TOKENS } from './tokens.ts';

/** Allowlisted tokens of one network, from the verified table in tokens.ts. */
const tokensOf = (network: string): AssetDef[] => TOKENS.flatMap((t) => {
  const d = t.deployments[network];
  return d ? [{ id: d.address, symbol: t.symbol, name: t.name, decimals: d.decimals ?? t.decimals, ...(d.program ? { program: d.program } : {}) }] : [];
});
const eth: AssetDef = { id: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 };

const DEFS = {
  ethereum: {
    id: 'ethereum', family: 'evm', name: 'Ethereum', chainRef: '1', native: eth,
    tokens: [],
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    explorerTx: 'https://etherscan.io/tx/', explorerAddr: 'https://etherscan.io/address/', minConf: 12,
  },
  base: {
    id: 'base', family: 'evm', name: 'Base', chainRef: '8453', native: eth,
    tokens: [],
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorerTx: 'https://basescan.org/tx/', explorerAddr: 'https://basescan.org/address/', minConf: 12,
  },
  arbitrum: {
    id: 'arbitrum', family: 'evm', name: 'Arbitrum One', chainRef: '42161', native: eth,
    tokens: [],
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorerTx: 'https://arbiscan.io/tx/', explorerAddr: 'https://arbiscan.io/address/', minConf: 12,
  },
  polygon: {
    id: 'polygon', family: 'evm', name: 'Polygon PoS', chainRef: '137',
    native: { id: 'native', symbol: 'POL', name: 'POL', decimals: 18 },
    tokens: [],
    rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    explorerTx: 'https://polygonscan.com/tx/', explorerAddr: 'https://polygonscan.com/address/', minConf: 64,
  },
  optimism: {
    id: 'optimism', family: 'evm', name: 'Optimism', chainRef: '10', native: eth, tokens: [],
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorerTx: 'https://optimistic.etherscan.io/tx/', explorerAddr: 'https://optimistic.etherscan.io/address/', minConf: 12,
  },
  bsc: {
    id: 'bsc', family: 'evm', name: 'BNB Smart Chain', chainRef: '56',
    native: { id: 'native', symbol: 'BNB', name: 'BNB', decimals: 18 }, tokens: [],
    rpc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorerTx: 'https://bscscan.com/tx/', explorerAddr: 'https://bscscan.com/address/', minConf: 15,
  },
  avalanche: {
    id: 'avalanche', family: 'evm', name: 'Avalanche C-Chain', chainRef: '43114',
    native: { id: 'native', symbol: 'AVAX', name: 'Avalanche', decimals: 18 }, tokens: [],
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    explorerTx: 'https://snowtrace.io/tx/', explorerAddr: 'https://snowtrace.io/address/', minConf: 2,
  },
  hyperevm: {
    id: 'hyperevm', family: 'evm', name: 'HyperEVM', chainRef: '999',
    native: { id: 'native', symbol: 'HYPE', name: 'Hyperliquid', decimals: 18 }, tokens: [],
    rpc: ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid.drpc.org'],
    explorerTx: 'https://hyperevmscan.io/tx/', explorerAddr: 'https://hyperevmscan.io/address/', minConf: 2,
  },
  bitcoin: {
    id: 'bitcoin', family: 'btc', name: 'Bitcoin',
    chainRef: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    native: { id: 'native', symbol: 'BTC', name: 'Bitcoin', decimals: 8 }, tokens: [], coinType: 0,
    utxo: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, kind: 'wpkh', dust: 546 },
    rpc: ['https://mempool.space/api', 'https://blockstream.info/api'],
    explorerTx: 'https://mempool.space/tx/', explorerAddr: 'https://mempool.space/address/', minConf: 6,
  },
  litecoin: {
    id: 'litecoin', family: 'btc', name: 'Litecoin',
    chainRef: '12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2',
    native: { id: 'native', symbol: 'LTC', name: 'Litecoin', decimals: 8 }, tokens: [], coinType: 2,
    utxo: { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, kind: 'wpkh', dust: 5460 },
    rpc: ['https://litecoinspace.org/api', 'blockbook:https://litecoin.atomicwallet.io/api/v2'],
    explorerTx: 'https://litecoinspace.org/tx/', explorerAddr: 'https://litecoinspace.org/address/', minConf: 6,
  },
  solana: {
    id: 'solana', family: 'sol', name: 'Solana',
    chainRef: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    native: { id: 'native', symbol: 'SOL', name: 'Solana', decimals: 9 },
    tokens: [],
    rpc: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    explorerTx: 'https://solscan.io/tx/', explorerAddr: 'https://solscan.io/account/', minConf: 1,
  },
  // Identity = the network passphrase (its SHA-256 is the network id mixed into every signature). Sources: SDF Horizon and
  // LOBSTR's public Horizon (independent operator), both keyless; verified live 2026-11-10.
  stellar: {
    id: 'stellar', family: 'stellar', name: 'Stellar',
    chainRef: 'Public Global Stellar Network ; September 2015',
    native: { id: 'native', symbol: 'XLM', name: 'Stellar Lumens', decimals: 7 }, tokens: [], coinType: 148,
    memo: 'text', activation: '1',
    rpc: ['https://horizon.stellar.org', 'https://horizon.stellar.lobstr.co'],
    explorerTx: 'https://stellar.expert/explorer/public/tx/', explorerAddr: 'https://stellar.expert/explorer/public/account/', minConf: 1,
  },
} satisfies Record<string, NetworkDef>;

/** Known ids are typed; any other string may be absent. */
export const NETWORKS = DEFS as { [K in keyof typeof DEFS]: NetworkDef } & Record<string, NetworkDef>;


for (const n of Object.values(NETWORKS) as NetworkDef[]) n.tokens = tokensOf(n.id);

export const NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];

export function getNetwork(id: string): NetworkDef {
  const n = (NETWORKS as Record<string, NetworkDef | undefined>)[id];
  if (!n) throw new Error(`unknown network: ${id}`);
  return n;
}

/** Resolve an asset strictly by identifier (never by symbol/name). */
export function getAsset(network: string, assetId: string): AssetDef {
  const n = getNetwork(network);
  if (assetId === 'native') return n.native;
  const t = n.tokens.find((x) => (n.family === 'evm' ? x.id.toLowerCase() === assetId.toLowerCase() : x.id === assetId));
  if (!t) throw new Error(`asset not allowlisted on ${network}: ${assetId}`);
  return t;
}

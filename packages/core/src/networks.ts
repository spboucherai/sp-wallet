// Network + asset registry. Every identifier here is pinned and cross-checked.
// USDC addresses: Circle official page https://developers.circle.com/stablecoins/usdc-contract-addresses
// (read 2026-11-10) and re-verified on-chain at API start (symbol/decimals/chainId/genesis).
export type Family = 'evm' | 'btc' | 'sol';
export type NetworkId = 'ethereum' | 'base' | 'arbitrum' | 'polygon' | 'bitcoin' | 'solana';

export interface AssetDef {
  /** 'native' or the token contract / mint address */
  id: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface NetworkDef {
  id: NetworkId;
  family: Family;
  name: string;
  /** EVM: decimal chain id. BTC: genesis block hash. SOL: genesis hash. */
  chainRef: string;
  native: AssetDef;
  tokens: AssetDef[];
  rpc: string[];
  explorerTx: string;
  explorerAddr: string;
  /** confirmations displayed as "enough" for small amounts (finality is checked per chain) */
  minConf: number;
}

const usdc = (id: string): AssetDef => ({ id, symbol: 'USDC', name: 'USD Coin', decimals: 6 });
const eth: AssetDef = { id: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 };

export const NETWORKS: Record<NetworkId, NetworkDef> = {
  ethereum: {
    id: 'ethereum', family: 'evm', name: 'Ethereum', chainRef: '1', native: eth,
    tokens: [usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')],
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    explorerTx: 'https://etherscan.io/tx/', explorerAddr: 'https://etherscan.io/address/', minConf: 12,
  },
  base: {
    id: 'base', family: 'evm', name: 'Base', chainRef: '8453', native: eth,
    tokens: [usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')],
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorerTx: 'https://basescan.org/tx/', explorerAddr: 'https://basescan.org/address/', minConf: 12,
  },
  arbitrum: {
    id: 'arbitrum', family: 'evm', name: 'Arbitrum One', chainRef: '42161', native: eth,
    tokens: [usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')],
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorerTx: 'https://arbiscan.io/tx/', explorerAddr: 'https://arbiscan.io/address/', minConf: 12,
  },
  polygon: {
    id: 'polygon', family: 'evm', name: 'Polygon PoS', chainRef: '137',
    native: { id: 'native', symbol: 'POL', name: 'POL', decimals: 18 },
    tokens: [usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')],
    rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    explorerTx: 'https://polygonscan.com/tx/', explorerAddr: 'https://polygonscan.com/address/', minConf: 64,
  },
  bitcoin: {
    id: 'bitcoin', family: 'btc', name: 'Bitcoin',
    chainRef: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    native: { id: 'native', symbol: 'BTC', name: 'Bitcoin', decimals: 8 }, tokens: [],
    rpc: ['https://mempool.space/api', 'https://blockstream.info/api'],
    explorerTx: 'https://mempool.space/tx/', explorerAddr: 'https://mempool.space/address/', minConf: 6,
  },
  solana: {
    id: 'solana', family: 'sol', name: 'Solana',
    chainRef: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    native: { id: 'native', symbol: 'SOL', name: 'Solana', decimals: 9 },
    tokens: [usdc('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')],
    rpc: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    explorerTx: 'https://solscan.io/tx/', explorerAddr: 'https://solscan.io/account/', minConf: 1,
  },
};

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

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
  /**
   * EVM: decimal chain id. BTC-style: genesis block hash. SOL: genesis hash. Stellar: network passphrase. XRPL: hash of ledger 32570. TRON: genesis block id. Aptos: chain id.
   * EVM: decimal chain id. BTC-style: genesis block hash. SOL: genesis hash. Stellar: network passphrase. XRPL: hash of ledger 32570. TRON: genesis block id.
   * Cosmos SDK: the chain id (it is part of every signed document, so a signature is valid on that chain only).
   * EVM: decimal chain id. BTC-style: genesis block hash. SOL: genesis hash. Stellar: network passphrase. XRPL: hash of ledger 32570. TRON: genesis block id. Sui: genesis checkpoint digest.
   * EVM: decimal chain id. BTC-style: genesis block hash. SOL: genesis hash. Stellar: network passphrase. XRPL: hash of ledger 32570. TRON: genesis block id. NEAR: genesis block hash.
   * EVM: decimal chain id. BTC-style: genesis block hash. SOL: genesis hash. Stellar: network passphrase. XRPL: hash of ledger 32570. TRON: genesis block id. TON: masterchain zero-state root hash.
   * Bitcoin Cash shares its genesis block with Bitcoin, Bitcoin SV and eCash, so its reference is the hash of block 661648,
   * the first block after the last of those splits (November 2020; a Bitcoin Cash Node checkpoint), which exists on no other chain.
   */
  chainRef: string;
  native: AssetDef;
  tokens: AssetDef[];
  rpc: string[];
  explorerTx: string;
  explorerAddr: string;
  /** BIP-44 coin type used for key derivation (plugin and UTXO families) */
  coinType?: number;
  /** Bitcoin-style chains: address encoding and script kind */
  utxo?: {
    bech32?: string; pubKeyHash: number; scriptHash: number; kind: 'wpkh' | 'pkh'; dust: number;
    /** CashAddr prefix (Bitcoin Cash) */
    cashaddr?: string;
    /** bounds for the fee rate in base units per byte, for chains whose node estimate is not a market rate */
    feeRate?: { min: number; max: number };
    /** height of the block whose hash is `chainRef` (default 0 = genesis) */
    refHeight?: number;
  };
  /** Cosmos SDK chains: bech32 account prefix and the denom of the native coin (used for the transfer and the fee) */
  cosmos?: { bech32: string; denom: string };
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
  // Dust: Dogecoin Core's soft dust limit, 0.01 DOGE (doc/fee-recommendation.md, read 2026-11-10; an output below it costs an
  // extra 0.01 DOGE of fee, below 0.001 DOGE it is rejected). Fee: 0.01 DOGE/kB recommended = 1000 koinu per byte.
  dogecoin: {
    id: 'dogecoin', family: 'btc', name: 'Dogecoin',
    chainRef: '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691',
    native: { id: 'native', symbol: 'DOGE', name: 'Dogecoin', decimals: 8 }, tokens: [], coinType: 3,
    utxo: { pubKeyHash: 0x1e, scriptHash: 0x16, kind: 'pkh', dust: 1_000_000, feeRate: { min: 1000, max: 10_000 } },
    rpc: ['blockbook:https://blockbook.doge.zelcore.io/api/v2', 'bitcore:https://api.bitcore.io/api/DOGE/mainnet'],
    explorerTx: 'https://blockbook.doge.zelcore.io/tx/', explorerAddr: 'https://blockbook.doge.zelcore.io/address/', minConf: 20,
  },
  bitcoincash: {
    id: 'bitcoincash', family: 'bch', name: 'Bitcoin Cash',
    chainRef: '0000000000000000029e471c41818d24b8b74c911071c4ef0b4a0509f9b5a8ce',
    native: { id: 'native', symbol: 'BCH', name: 'Bitcoin Cash', decimals: 8 }, tokens: [], coinType: 145,
    utxo: { cashaddr: 'bitcoincash', pubKeyHash: 0x00, scriptHash: 0x05, kind: 'pkh', dust: 546, feeRate: { min: 1.1, max: 20 }, refHeight: 661648 },
    rpc: ['blockbook:https://blockbook.bch.zelcore.io/api/v2', 'bitcore:https://api.bitcore.io/api/BCH/mainnet'],
    explorerTx: 'https://blockbook.bch.zelcore.io/tx/', explorerAddr: 'https://blockbook.bch.zelcore.io/address/', minConf: 6,
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
  xrpl: {
    // chainRef: hash of ledger 32570, the earliest ledger of the main network that still exists (ledgers 1–32569 were lost);
    // every full-history server returns it, and no other network (testnet, devnet, sidechains) has it.
    id: 'xrpl', family: 'xrpl', name: 'XRP Ledger',
    chainRef: '4109C6F2045FC7EFF4CDE8F9905D19C28820D86304080FF886B299F0206E42B5',
    native: { id: 'native', symbol: 'XRP', name: 'XRP', decimals: 6 }, tokens: [], coinType: 144,
    memo: 'uint32', activation: '1', // base reserve 1 XRP (server_state reserve_base = 1000000 drops, read 2026-11-10)
    // two independent operators and two implementations: XRPL Labs / XRPL Commons cluster (rippled) and Ripple (Clio), both on port 443
    rpc: ['https://xrplcluster.com', 'https://s1.ripple.com'],
    explorerTx: 'https://livenet.xrpl.org/transactions/', explorerAddr: 'https://livenet.xrpl.org/accounts/', minConf: 1,
  },
  tron: {
    // chainRef = genesis block id. No `activation`: nothing stays locked on TRON (the sender pays 1 TRX to create the recipient).
    // rpc[0] (TronGrid) also serves the /v1 history index used to discover deposits; both are java-tron HTTP APIs.
    id: 'tron', family: 'tron', name: 'TRON',
    chainRef: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
    native: { id: 'native', symbol: 'TRX', name: 'TRON', decimals: 6 }, tokens: [], coinType: 195,
    rpc: ['https://api.trongrid.io', 'https://tron-rpc.publicnode.com'],
    explorerTx: 'https://tronscan.org/#/transaction/', explorerAddr: 'https://tronscan.org/#/address/', minConf: 19,
  },
  aptos: {
    // chainRef = the chain id (1 = mainnet), which is part of every signed transaction. Public full nodes prune history, so the
    // genesis transaction cannot be read; the adapter verifies the chain id from the node and from the on-chain 0x1::chain_id
    // resource, a pinned ledger checkpoint, and that both sources report the same hash for the same recent block.
    // Sources: Aptos Labs (keyless tier) and PublicNode (independent operator); verified live 2026-11-10.
    // rpc[0] also serves the keyless indexer (/v1/graphql) used only to discover deposits, each then verified on a full node.
    // No `activation`: an Aptos account needs no minimum balance (the sender pays the storage fee of a new recipient).
    id: 'aptos', family: 'aptos', name: 'Aptos', chainRef: '1',
    native: { id: 'native', symbol: 'APT', name: 'Aptos', decimals: 8 }, tokens: [], coinType: 637,
    rpc: ['https://api.mainnet.aptoslabs.com/v1', 'https://aptos-rest.publicnode.com/v1'],
    explorerTx: 'https://explorer.aptoslabs.com/txn/', explorerAddr: 'https://explorer.aptoslabs.com/account/', minConf: 1,
  },
  cosmos: {
    // chainRef = chain id, signed into every transaction (SignDoc.chain_id). Public REST nodes prune early history, so no
    // early block hash can be pinned: identity = chain id reported by both sources + both agreeing on a recent block hash.
    // No `activation`: an account is created by its first incoming transfer and nothing stays locked.
    // Sources: Allnodes PublicNode and Polkachu, independent operators, keyless LCD/REST; verified live 2026-11-10.
    id: 'cosmos', family: 'cosmos', name: 'Cosmos Hub', chainRef: 'cosmoshub-4',
    native: { id: 'native', symbol: 'ATOM', name: 'Cosmos', decimals: 6 }, tokens: [], coinType: 118,
    cosmos: { bech32: 'cosmos', denom: 'uatom' }, memo: 'text',
    rpc: ['https://cosmos-rest.publicnode.com', 'https://cosmos-api.polkachu.com'],
    explorerTx: 'https://www.mintscan.io/cosmos/tx/', explorerAddr: 'https://www.mintscan.io/cosmos/address/', minConf: 1,
  },
  // chainRef = digest of the genesis checkpoint (base58); its first four bytes are the "chain identifier" 35834a8a. Every node
  // reports it as GetServiceInfo.chain_id. Sources: Mysten Labs full node and Triton One (rpcpool), independent operators, both
  // keyless, both speaking gRPC over HTTP/2 (sui.rpc.v2) — public Sui full nodes no longer serve JSON-RPC; verified live 2026-11-10.
  // No `activation`: a Sui address needs no minimum balance to exist.
  sui: {
    id: 'sui', family: 'sui', name: 'Sui',
    chainRef: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
    native: { id: 'native', symbol: 'SUI', name: 'Sui', decimals: 9 }, tokens: [], coinType: 784,
    rpc: ['https://fullnode.mainnet.sui.io', 'https://mainnet.sui.rpcpool.com'],
    explorerTx: 'https://suiscan.xyz/mainnet/tx/', explorerAddr: 'https://suiscan.xyz/mainnet/account/', minConf: 1,
  },
  near: {
    // chainRef = genesis block hash of mainnet (status.genesis_hash; the chain id string is "mainnet"). A NEAR transaction carries
    // no chain id: it is bound to the chain by the recent block hash it names, which the API reads from both sources.
    // The wallet's account is the implicit account of its key (64 hex characters); it exists on-chain once it has received NEAR.
    // No `activation`: an account this small needs no minimum balance (zero-balance accounts, NEP-448).
    // Sources: FastNEAR and dRPC (independent operators, different nodes; both keyless; verified live 2026-11-10).
    id: 'near', family: 'near', name: 'NEAR Protocol',
    chainRef: 'EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H',
    native: { id: 'native', symbol: 'NEAR', name: 'NEAR', decimals: 24 }, tokens: [], coinType: 397,
    rpc: ['https://free.rpc.fastnear.com', 'https://near.drpc.org'],
    explorerTx: 'https://nearblocks.io/txns/', explorerAddr: 'https://nearblocks.io/address/', minConf: 3,
  },
  ton: {
    // chainRef = root hash of the masterchain zero state (hex), the block every main-network node starts from; testnet has another.
    // Sources: TON Center (liteserver-backed HTTP API of the TON Foundation) and TonAPI (Tonkeeper's indexer), both keyless and
    // rate-limited (about one request per second); verified live 2026-11-10. No `activation`: an address can hold any amount
    // before its wallet contract is deployed (the first outgoing transfer deploys it).
    id: 'ton', family: 'ton', name: 'TON',
    chainRef: '17a3a92992aabea785a7a090985a265cd31f323d849da51239737e321fb05569',
    native: { id: 'native', symbol: 'TON', name: 'Toncoin', decimals: 9 }, tokens: [], coinType: 607,
    memo: 'text',
    rpc: ['https://toncenter.com/api/v2', 'https://tonapi.io/v2'],
    explorerTx: 'https://tonviewer.com/transaction/', explorerAddr: 'https://tonviewer.com/', minConf: 1,
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

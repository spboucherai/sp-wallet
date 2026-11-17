// The wallet's price identities: one CoinGecko coin id per wallet symbol (moved out of server.ts unchanged when a second price
// source was added, so that the mapping of that source can be generated and tested against the same list).
export const COINGECKO: Record<string, string> = {
  ETH: 'ethereum', BTC: 'bitcoin', SOL: 'solana', POL: 'polygon-ecosystem-token', BNB: 'binancecoin', AVAX: 'avalanche-2', HYPE: 'hyperliquid',
  LTC: 'litecoin', DOGE: 'dogecoin', BCH: 'bitcoin-cash', TRX: 'tron', XRP: 'ripple', XLM: 'stellar',
  APT: 'aptos',
  ATOM: 'cosmos',
  SUI: 'sui',
  NEAR: 'near',
  TON: 'the-open-network',
  USDC: 'usd-coin', USDT: 'tether', PYUSD: 'paypal-usd', DAI: 'dai', USDS: 'usds', USDe: 'ethena-usde', FDUSD: 'first-digital-usd', EURC: 'euro-coin', RLUSD: 'ripple-usd', USDG: 'global-dollar',
  LINK: 'chainlink', UNI: 'uniswap', AAVE: 'aave', LDO: 'lido-dao', WBTC: 'wrapped-bitcoin', WETH: 'weth', PAXG: 'pax-gold', ONDO: 'ondo-finance', RENDER: 'render-token',
  JUP: 'jupiter-exchange-solana', RAY: 'raydium', BONK: 'bonk', PEPE: 'pepe', SHIB: 'shiba-inu',
  // registry v5. A symbol has one price: a bridged or exchange-pegged representation registered under the asset's own ticker
  // (Binance-Peg ETH / XRP / DOGE…, bridged DAI / WBTC / WETH) is valued at the asset's price; representations with their own
  // ticker use their own CoinGecko entry where one exists. A symbol missing here is shown without a fiat value, never with a guess.
  USDT0: 'usdt0', 'USDC.e': 'usd-coin', GHO: 'gho', crvUSD: 'crvusd', frxUSD: 'frax-usd', USDD: 'usdd',
  cbBTC: 'coinbase-wrapped-btc', tBTC: 'tbtc', BTCB: 'binance-bitcoin', 'BTC.b': 'bitcoin-avalanche-bridged-btc-b',
  'WETH.e': 'avalanche-bridged-weth-avalanche', 'LINK.e': 'chainlink', wstETH: 'wrapped-steth', rETH: 'rocket-pool-eth', cbETH: 'coinbase-wrapped-staked-eth', weETH: 'wrapped-eeth',
  ARB: 'arbitrum', OP: 'optimism', WPOL: 'wmatic', WAVAX: 'wrapped-avax', WBNB: 'wbnb', WHYPE: 'wrapped-hype', MNT: 'mantle',
  cbXRP: 'coinbase-wrapped-xrp', cbDOGE: 'coinbase-wrapped-doge', cbLTC: 'coinbase-wrapped-ltc', cbADA: 'coinbase-wrapped-ada', ADA: 'cardano', DOT: 'polkadot',
  MKR: 'maker', SKY: 'sky', CRV: 'curve-dao-token', COMP: 'compound-governance-token', SNX: 'havven', PENDLE: 'pendle', ENA: 'ethena', GMX: 'gmx',
  AERO: 'aerodrome-finance', VELO: 'velodrome-finance', CAKE: 'pancakeswap-token', JOE: 'joe', MORPHO: 'morpho', EIGEN: 'eigenlayer',
  BRETT: 'based-brett', TOSHI: 'toshi', DEGEN: 'degen-base', JTO: 'jito-governance-token', PYTH: 'pyth-network', HNT: 'helium', ORCA: 'orca',
  mSOL: 'msol', jitoSOL: 'jito-staked-sol', bSOL: 'blazestake-staked-sol',
};

# V5 — agents on any registry asset, on any execution-enabled EVM network

Extends `docs/v3/ARCHITECTURE.md`. The trust zones do not change: research proposes, the engine executes, the signer has
the last word. No signer check was weakened and no limit was raised.

## What an agent can trade
Nothing is listed by hand. At run time, for a network `N` of `KYBER_ENABLED` (Base, Ethereum, Arbitrum One, Polygon PoS,
Optimism, BNB Smart Chain, Avalanche C-Chain, HyperEVM):

1. **Registry asset → market symbol** (`packages/core/src/market-symbols.ts`, pure):
   - a cash leg (`USDC`, `USDT`) is never a tradable symbol;
   - an asset whose ticker is in the reviewed table `ASSET_TRACKS` is the symbol it tracks: `WETH → ETH`;
     `WBTC, cbBTC, tBTC, BTCB → BTC`; `cbXRP → XRP`; `cbDOGE`, `cbADA`, `cbLTC`; `WBNB`, `WAVAX`, `WPOL`, `WHYPE`;
     `EURC → EUR`. The table is keyed by ticker and tolerates tickers the registry does not hold yet;
   - any other asset is its own symbol (`LINK → LINK`), the native coin included (`ETH`, `POL`, `BNB`, `AVAX`, `HYPE`).
   Liquid-staking and yield-bearing tokens (wstETH, cbETH, rETH, sUSDe…) are deliberately absent from the table: their
   price drifts from the underlying by design, they are not the same economic asset.
2. **Market data**: the symbol must have a USD pair on at least two of Coinbase Exchange, Bitstamp and Kraken. The pair
   names are in the static table `packages/core/src/market-listings.ts`, generated from the exchanges' public product
   endpoints by `node scripts/gen-market-listings.mts` and reviewed in the diff (297 tickers on 2026-11-10). Nothing is
   discovered at run time. A ticker is not an identity: if two exchanges used one ticker for different assets, the
   quality gate (sources within 50 bps) and the signer (Coinbase and Kraken within 1 %) would both refuse.
3. **One representation per symbol per network**, recorded with the agent at creation (`agents.assets`), shown by name
   and issuer. Default, in this order: the native coin; else the token that is the symbol itself; else the wrapper with
   the lowest reviewed rank (`WBTC` 1, `cbBTC` 2, `tBTC` 3, `BTCB` 4). Two candidates at the winning level (two registry
   tokens with one ticker) give no default: the owner must choose. A choice that does not track the symbol is refused.
4. **Cash leg**: USDC by default; USDT by the owner's explicit choice (the only possibility where USDC is not in the
   registry). No other stablecoin can be a cash leg.
5. Up to **12 symbols** per agent. A mandate holds at most 12 assets *including the cash leg* (a signer limit, unchanged):
   an agent with 12 symbols can be paper traded but cannot go live; 11 symbols can.

`GET /api/v1/agents/networks` returns all of this per network (symbols, sources, representations with issuer, data
availability from the quality records, cash legs, gas reserve, fee warning).

### Issuer risk — and what the signer does about it
A wrapped or pegged asset depends on its issuer (custodian, bridge, redemption) and can lose its peg. The signer values
every asset at the exchange price of the **underlying** (`priceSymbolOf`: cbBTC is priced as BTC, WETH as ETH, EURC as
EUR), from its own two sources. After a depeg the swap's guaranteed output is no longer worth `1 − maxSlippageBps` of
the input at those prices, so the signer **refuses the order — fail closed, in both directions**: the agent stops buying
the wrapper and cannot dump it below the underlying's value either. The owner then revokes and withdraws the asset to
the main wallet (a vault can only ever pay the owner's own address). This is stated in the creation form, on the agent
page and in the mandate approval panel.

### Paper only
The signer prices a symbol only when **both Coinbase and Kraken** list it. Symbols with market data from Bitstamp and
Kraken only (today: `EUR` via EURC, `PYUSD`, `RLUSD`, `USDG`) can be paper traded; `POST /agents/:id/mandate/prepare`
refuses with `no_signer_price`, and if a mandate existed anyway the signer would refuse every order on them.

## Symbols derived from today's registry (2026-11-10)
| Symbol | Listed on | Signer price | Registry representations per network |
|---|---|---|---|
| AAVE | Coinbase, Bitstamp, Kraken | yes | base, ethereum, arbitrum, polygon, optimism: AAVE |
| AVAX | Coinbase, Bitstamp, Kraken | yes | avalanche: AVAX (native) |
| BNB | Coinbase, Bitstamp, Kraken | yes | bsc: BNB (native) — no cash leg in the registry on BNB Smart Chain yet: no agent there |
| BTC | Coinbase, Bitstamp, Kraken | yes | ethereum: WBTC; avalanche: WBTC |
| ETH | Coinbase, Bitstamp, Kraken | yes | base, arbitrum, optimism: ETH (native); ethereum: ETH (native, default) or WETH |
| EUR | Bitstamp, Kraken | paper only | base, ethereum, avalanche: EURC |
| HYPE | Coinbase, Bitstamp, Kraken | yes | hyperevm: HYPE (native) |
| LDO, ONDO, PAXG, PEPE, SHIB | Coinbase, Bitstamp, Kraken | yes | ethereum |
| LINK | Coinbase, Bitstamp, Kraken | yes | base, ethereum, arbitrum, optimism: LINK |
| POL | Coinbase, Bitstamp, Kraken | yes | polygon: POL (native) |
| PYUSD | Bitstamp, Kraken | paper only | ethereum, arbitrum, polygon |
| RLUSD | Bitstamp, Kraken | paper only | ethereum |
| UNI | Coinbase, Bitstamp, Kraken | yes | ethereum, arbitrum, optimism: UNI |
| USDG | Bitstamp, Kraken | paper only | ethereum, arbitrum |
| USDS | Coinbase, Kraken | yes | base, ethereum: USDS |

Cash legs: USDC on base, ethereum, arbitrum, polygon, optimism, avalanche, hyperevm; USDT on ethereum, avalanche.
In the registry but without market data (not on two exchanges): DAI, USDe, FDUSD, WBTC and WETH *as tickers* (they are
traded as `BTC` and `ETH`). The table grows by itself when the registry does (unit tests inject extra assets).

## Market data for more symbols (`services/api/src/market/symbols.ts`)
The set is: the symbols of every agent that is not stopped (first, never dropped), the base ten of V3, then every symbol
tradable on an execution-enabled network. `SPW_MARKET_MAX_SYMBOLS` (default 40) bounds it; `SPW_MARKET_SYMBOLS`
replaces the base and registry-derived part with an explicit list; 5-minute bars stay on the base ten
(`SPW_MARKET_5M_SYMBOLS`). The worker recomputes the set at every pass and serves every interval of the agents' symbols
before anything else, in the update and in the backfill (about 60 requests per source for two years of 1h bars and a
dozen for the daily history, per new symbol; the per-pass budget of 80 requests per source is unchanged). Kraken calls
stay 3 s apart: N symbols take 3·N seconds of Kraken time at the top of the hour. The quality gate is unchanged.

## Signer
- `MANDATE_NETWORKS` = every network of `KYBER_ENABLED`; one network per mandate, one mandate per vault. Unchanged
  checks, each already keyed by the order's own network: network equals the mandate's, chain id of that network (the
  signed transaction carries it), pinned router and calldata verification (with the reduced router of HyperEVM:
  `swapGeneric` and the partial-fill flag refused there), fee ceiling `policy.maxFee[network]`.
- New refusal at approval: no mandate on a network for which the signer's policy sets no fee ceiling.
- `exchangePrices` reads the pair names from the listings table instead of deriving them from the ticker; still both
  Coinbase and Kraken, agreeing within 1 %, fresh, fail closed. USDC: peg checked on Kraken (as before); USDT: on both.
- Vault derivation is unchanged (`m/44'/60'/<index>'/0/0`, the same address on every EVM network). The API allocates
  indices from one global sequence under an advisory lock and the column is `unique`: an agent on Arbitrum and one on
  Base never share a vault.

## Engine
- `agentAssets` resolves the cash leg and the recorded representation per symbol on the agent's network; holdings,
  paper book, prices and weights are keyed by **market symbol**.
- **Gas reserve** (`services/api/src/agents/gas.ts`), in the native coin of the agent's network, from recent gas prices
  (highest base fee of the last 20 blocks + median tip): one order = 450 000 gas at that price, never counted above the
  signer policy's fee ceiling for the network; reserve = 8 orders, and at least 2 orders at the ceiling. The reserve is
  never tradable, and `mandate/prepare` and `mandate/approve` refuse (`insufficient_gas`) until the vault holds it.
  On Ethereum mainnet one order costs dollars: the networks endpoint flags it and agent creation returns a `fees`
  warning when one order's fee exceeds 1 % of the agent's largest order. Small agents there are eaten by fees.
- Paper fills use `kyberQuote` on the agent's network; the live path (`placeLive`, `advanceOrder`) is unchanged.
- Long-only spot. Shorting belongs to the future derivatives mandates.

## Universe-generic strategies (`research/`)
`META["universe"] = ["*"]` means "any set of symbols, chosen by the agent". The signal runner takes the symbols from the
candles' keys, the backtest from `--symbols`: 1 to 12 distinct tickers, within the optional `META["min_symbols"]` /
`META["max_symbols"]`; weights are validated against that list. The code hash still pins the behaviour; the agent's
mandate pins the assets. Fixed-universe strategies are unchanged (same file hashes, pinned by a test).
Library: `ts_momentum/3`, `ma_trend/3`, `donchian_breakout/3`, `vol_target_trend/3`, `mean_reversion/3`,
`xs_momentum/3` (`min_symbols: 3`) — the rules and parameters of version 1, not re-tuned.
`POST /agents/:id/strategies` accepts a generic version for any agent whose number of symbols is within its bounds and
passes the agent's symbols to the backtest (`--symbols`); a fixed-universe version still needs exactly the agent's
symbols. The report records the symbols (`config.symbols`) and is refused if they are not the agent's.
`GET /strategies` reports `generic`, `minSymbols`, `maxSymbols`.
The laboratory backtests on one candle source and never mixes them: the API picks the first of Coinbase, Bitstamp,
Kraken that lists every symbol of the agent. When only Kraken does, the history is its 720 most recent bars.

## Proof
`NETWORK=<id> UNIVERSE=<comma list> npx tsx scripts/fork-agent.mts` (anvil fork, fresh random keys, nothing broadcast
to a real network). Defaults: Base, `ETH,LINK,AAVE`.

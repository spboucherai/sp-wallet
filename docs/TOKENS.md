# Token registry

`packages/core/src/tokens.ts` is generated. Nothing is added to it by hand: a token that is not in it cannot be held, sent or
swapped, and a wrong address is how funds get lost.

Registry v5 (2026-11-10): 84 symbols, 228 deployments on 10 networks (before: 24 symbols, 64 deployments).

| Network | before | after | | Network | before | after |
|---|---|---|---|---|---|---|
| Ethereum | 20 | 43 | | BNB Smart Chain | 2 | 27 |
| Base | 6 | 35 | | Avalanche | 4 | 16 |
| Arbitrum | 8 | 32 | | HyperEVM | 1 | 6 |
| Polygon | 3 | 18 | | Solana | 14 | 26 |
| Optimism | 5 | 23 | | TRON | 1 | 2 |

## The rule

A deployment (symbol, network, address) is kept only when all three hold. Anything else is dropped and written to
`research/dropped.txt` with the reason.

1. **First source — the issuer.** The issuer's own document states the address; for a bridged or exchange-pegged
   representation, the document of whoever issues that representation (the network's official token list or bridge data,
   Binance for Binance-Peg tokens). `packages/core/scripts/check-sources.mts` fetches the URL recorded in
   `research/candidates.json` and looks for the address in it (a token list must list it under the right chain id).
   Result: `research/evidence.json`. A page that cannot be read without a browser gives no evidence; six wave-1 deployments
   (FDUSD ×4, SHIB, BONK) carry a hand-written `manual` entry because they were read by hand before this script existed.
2. **Second, independent source.** CoinGecko lists the same address for the coin id named by the candidate
   (`research/cg.json`, refreshed by `packages/core/scripts/fetch-cg.mts`), that coin has the expected symbol, and its decimals
   agree with the chain. The coin id is explicit per candidate (and per deployment when CoinGecko tracks a representation
   as its own coin) — never looked up by ticker.
   **Extension**, used only where CoinGecko lists no address: on OP-Stack networks, the canonical bridge's own mapping read
   on-chain — the L2 token names its L1 token and the Standard Bridge (`0x4200…0010`), and that L1 token is the asset's
   Ethereum deployment, itself accepted by the full rule. Accepted this way: **UNI on Base** (and nothing else).
3. **The chain.** On both RPC endpoints of the network: code exists, `symbol()` is the expected one, `decimals()` agree,
   `totalSupply() > 0`. Solana: an initialized SPL mint owned by a token program, supply > 0, no transfer fee, no transfer hook.

`packages/core/scripts/gen-tokens.mts` applies 2 and 3, requires 1, and writes `tokens.ts`, `research/accepted.json` (every
deployment with its two sources) and `research/dropped.txt`. The API re-checks symbol and decimals on-chain at every start and
disables a token that differs. `scripts/smoke-tokens.mts [--kyber]` re-checks the whole registry on both endpoints and asks
KyberSwap for routes; result in `research/token-verification.json`.

```bash
node packages/core/scripts/fetch-cg.mts          # second source (slow: public API, one request every 7 s)
node packages/core/scripts/check-sources.mts     # first source
node packages/core/scripts/gen-tokens.mts        # rule + on-chain, writes tokens.ts
npx tsx scripts/smoke-tokens.mts --kyber         # proof on the live networks, read-only
```

## Symbols and representations

One symbol is one contract per network. Different issuers never share a symbol on one network, and BTC / ETH representations
keep their own symbols: WBTC (BitGo), cbBTC (Coinbase), tBTC (Threshold), BTCB (Binance), BTC.b (Avalanche Bridge, now run by
Lombard) are five different assets.

- A deployment that is another representation than the token's main one carries its own `name`
  ("Binance-Peg USD Coin", "Dai (Polygon PoS Bridge)", "Bridged USDT (Base Standard Bridge)"). On BNB Chain, USDC and USDT are
  Binance-Peg tokens with 18 decimals, issued by Binance, not by Circle or Tether; ETH, XRP, DOGE, ADA, SOL, LTC, DOT, AVAX,
  LINK, UNI, AAVE and DAI there are Binance-Peg tokens too.
- Where the contract's own `symbol()` is not the ticker, the registry stores it (`onchainSymbol`) and the API requires exactly
  that value:
  - `USDT0` — on-chain `USD₮0` (Arbitrum, Optimism, HyperEVM), `USDT0` (Polygon). Not Tether's USDT: an omnichain token backed
    by USDT locked on Ethereum. On Arbitrum and Polygon it is the contract that used to be "USDT" there.
  - `USDC.e` — bridged USDC, not issued by Circle. On-chain symbol `USDC` on Polygon, Arbitrum and Optimism (so it must not
    take the `USDC` ticker, which is Circle's native token there), `USDC.e` on Avalanche. Kept because it is the canonical
    bridge's token, redeemable through it, and still liquid (Polygon especially). Many exchanges refuse it as a USDC deposit.
  - `WETH.e`, `LINK.e`, `BTC.b` (Avalanche) — registered under their true symbols.
  - `USDT` on Avalanche returns `USDt`; `CAKE` returns `Cake`.
- Dropped rather than forced: `cbETH` on Polygon (the contract is `fxcbETH`, another bridge's token), `USDbC` on Base.

## Sources per class

| Class | First source |
|---|---|
| Circle, Tether, Paxos, Ripple, Ethena, Sky, Frax, Curve, Aave (GHO), USDD, USDT0 | issuer documentation or the issuer's published address data (Sky chainlog, Curve `deployments.json`, Aave address book) |
| Coinbase wrapped assets (cbBTC, cbETH, cbXRP, cbDOGE, cbLTC, cbADA) | coinbase.com/cbbtc and /cbeth |
| WBTC, tBTC, BTC.b | wbtc.network, Threshold docs, Lombard docs |
| Binance-Peg tokens, BTCB | Binance's public network/coin list (`/bapi/capital/v1/public/capital/getNetworkCoinAll`): the contract Binance itself uses for each coin on BSC |
| Bridged tokens on Optimism / Base, Arbitrum, Polygon, Avalanche | the network's token list or bridge data: `static.optimism.io`, `tokenlist.arbitrum.io`, `0xPolygon/polygon-token-list` + `static.polygon.technology`, `ava-labs/avalanche-bridge-resources` |
| Wrapped native coins (WETH, WPOL, WAVAX, WBNB, WHYPE) | the network's own docs or code |
| Liquid staking (wstETH, rETH, weETH, mSOL, jitoSOL, bSOL) | Lido, Rocket Pool, ether.fi, Marinade, Jito, SolBlaze docs |
| Governance / DeFi tokens | the project's docs or its official GitHub repository |
| Memecoins (BRETT, TOSHI, DEGEN) | the project's own site (BRETT: the address is in the site's script bundle, whose file name changes at each redeploy) |

The exact URL of every deployment is in `research/candidates.json` and `research/accepted.json`.

## Non-standard behaviour

A swap's minimum-output check and exact-amount approval assume a plain ERC-20: the amount sent is the amount received, and a
balance only changes through a transfer. `flags` in `tokens.ts` carries the notes.

- **Excluded**: stETH (rebasing — use wstETH), FLOKI (tax on transfers). The generator refuses Solana mints with a transfer
  fee or a transfer hook. No EVM test detects a fee-on-transfer token automatically: this relies on reading the issuer's
  documentation for each candidate.
- **Kept, noted**: stablecoins and custodial wrappers whose issuer can freeze an address or pause transfers (USDC, USDT, PYUSD,
  USDG, EURC, FDUSD, RLUSD, PAXG, cbBTC and the other Coinbase wrapped assets, USDT0). USDT on Ethereum has a transfer-fee
  switch, read as 0 on 2026-11-10. PAXG can charge a transfer fee; its current value was not read on-chain.
- Bridge representations are worth what their bridge is worth.

## Dropped candidates

248 deployments were tried, 228 accepted, 20 dropped (`research/dropped.txt`):

- no first source (the issuer document does not state the address, or could not be read): EURC on Optimism (not on Circle's
  list), PEPE on Arbitrum / BNB Chain / Avalanche, COMP on BNB Chain / Avalanche, SNX on Polygon / Avalanche, EIGEN on Base,
  WIF (dogwifcoin.org refuses automated reading), W on four networks, UBTC / UETH / USOL on HyperEVM (docs.hyperunit.xyz
  refuses automated reading) — HyperEVM therefore has no BTC representation yet;
- no second source: PAXG on Base and Solana (CoinGecko lists none);
- on-chain symbol differs: cbETH on Polygon.

Left out before generation, with the reason in the same file: stETH, FLOKI, legacy FRAX, USDbC, USDC on TRON, Chainlink's
ERC-677 LINK on Polygon and BNB Chain, the wave-1 UNI address, bridged SHIB, the old Avalanche `.e` tokens, Wormhole WETH/WBTC
on Solana.

## Swap routes

KyberSwap route survey of 2026-11-10 (native → token → native, about 10 USD): 199 of the 200 EVM tokens have a route in both
directions. No route: **weETH on HyperEVM** (it can be held and sent, not swapped there). Solana and TRON tokens are not
covered by this survey.

## Limits and prices

Every symbol has a signer limit of about 50 USD per transfer and twice that per day (`CAPS` in `packages/core/src/policy.ts`,
prices of 2026-11-10 in the comments). Existing limits were not changed; the default policy is version 3 — see
`docs/runbooks/operations.md` for what to do on the signer after deploying. Prices come from the symbol → CoinGecko id map in
`services/api/src/server.ts`; a symbol without an id is shown with its balance and no fiat value.

## Native coins added after registry v5

Cardano (ADA) and Polkadot (DOT, on Polkadot Asset Hub) are native-coin networks added with policy version 4
(`docs/chains/cardano.md`, `docs/chains/polkadot.md`). They carry **no tokens**: Cardano native assets and Asset Hub assets
are neither shown nor spendable, and on Cardano an output that carries native assets is never spent. Their limits reuse the
`ADA` and `DOT` entries that registry v5 already had for the Binance-pegged tokens of the same tickers (285 ADA, 60 DOT per
transfer — 50.85 USD and 51.70 USD at 0.17841 and 0.86172 USD, DefiLlama, 2026-11-11), unchanged.

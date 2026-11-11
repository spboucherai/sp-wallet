# BTC and ETH perpetuals on Hyperliquid, dYdX v4 and GMX v2 — contract differences

Checked on **2026-11-10** (2026-11-11 UTC) against each venue's official documentation and live public API. This note is what the
future router relies on to apply principle 6 of `docs/v4/DERIVATIVES-ARCHITECTURE.md`: *two perpetuals on the same asset are compared
field by field; the router never assumes equivalence*. Details and quotations: `dydx.md`, `gmx.md` (this folder) and the Hyperliquid
adapter's own dossier. Values marked *(live)* were read from the venue on the check date and will drift.

Sources — Hyperliquid (HL): https://hyperliquid.gitbook.io/hyperliquid-docs (`/trading/contract-specifications`, `/trading/funding`,
`/trading/robust-price-indices`, `/hypercore/oracle`, `/trading/margin-tiers`, `/trading/margining`, `/trading/liquidations`,
`/trading/auto-deleveraging`, `/trading/fees`, `/for-developers/api/tick-and-lot-size`), `POST https://api.hyperliquid.xyz/info`
`{"type":"metaAndAssetCtxs"}`. dYdX: https://docs.dydx.xyz (`/concepts/trading/{orders,funding,margin,liquidations,oracle,rewards,quantums}`),
indexer `https://indexer.dydx.trade/v4`, chain parameters. GMX: https://docs.gmx.io (`/docs/trading/{overview,order-types,fees,liquidations}`,
`/docs/api/…`), `https://arbitrum.gmxapi.io/v1`, contracts `gmx-synthetics`.

## The table

| | **Hyperliquid** `BTC`, `ETH` | **dYdX v4** `BTC-USD`, `ETH-USD` | **GMX v2 (Arbitrum)** `BTC/USD [BTC-USDC]`, `ETH/USD [WETH-USDC]` |
|---|---|---|---|
| **Market structure** | on-chain central limit order book (HyperCore) | on-chain order book; short-term orders live in validator memory, stateful orders on chain | **no order book**: oracle-priced trades against a GM liquidity pool; one instrument **per pool** (4 BTC/USD pools, 4 ETH/USD pools) |
| **Execution** | immediate match | immediate match (block time ≈ 1 s) | **two transactions**: request, then keeper execution at a later signed oracle price; the order can be cancelled or frozen instead |
| **Collateral** | USDC | USDC (Noble USDC over IBC) | the pool's long or short token: WBTC.b or USDC (BTC), WETH or USDC (ETH); other tokens through a swap path |
| **Margin** | cross (default) or isolated, per asset | cross inside a subaccount; isolated through child subaccounts ≥ 128; BTC and ETH are cross markets | **isolated per position only**; no account-level margin |
| **Quote and settlement** | linear, **USDT-denominated oracle, USDC collateral, no conversion**: "these contracts are technically quanto contracts where USDT pnl is denominated in USDC" | linear, USD oracle, PnL and funding in USDC | linear, PnL computed in USD (30 decimals) and **paid in the pool token of the side** (long token for longs, short token for shorts) |
| **Price used for margin and liquidation** | **mark price** = median of (a) oracle + 150 s EMA of (HL mid − oracle), (b) median of HL best bid / best ask / last trade, (c) weighted median of Binance, OKX, Bybit, Gate, MEXC perp mids (3, 2, 2, 1, 1); updated ≈ every 3 s | **oracle price only** (no mark): validators' vote-extension aggregate of 8 spot exchanges (minimum 3), per block | **signed oracle min/max** (Chainlink Data Streams): longs open at max and close at min; displayed mark = (min + max) / 2 |
| **Oracle / index** | stake-weighted median of validators' weighted medians of Binance, OKX, Bybit, Kraken, Kucoin, Gate, MEXC spot (HL spot excluded for BTC); every 3 s | same as above (it *is* the margin price) | same as above |
| **Funding interval** | **1 h** | **1 h** | **continuous (per second)**; quoted per hour |
| **Funding formula** | 8 h rate = average premium + clamp(interest − premium, ±0.05 %), interest 0.01 % / 8 h; paid 1/8 each hour; premium sampled every 5 s; **cap 0.5 % per hour** | premium = (max(0, impact bid − index) − max(0, index − impact ask)) / index, median per minute, 60 samples averaged; rate = premium / 8 + interest (0 % on cross markets); **cap 600 % × (IMF − MMF) per 8 h = 0.6 % per hour** for BTC/ETH (derived) | **adaptive**: driven by the long/short open-interest imbalance; the rate ramps up while the imbalance is above a threshold and decays below it, between per-market min and max factors; the larger side pays — but with inertia: *(live)* BTC longs were paying while being the smaller side |
| **Funding notional and payer** | size × **oracle** price × rate; peer to peer | size × oracle price × rate; peer to peer | size in USD × seconds × factor; paid by one side to the other through the pool; settled into collateral at each position change, positive funding must be **claimed** |
| **Funding observed** *(live, per hour)* | BTC 0.0000117, ETH 0.0000125 (longs pay) | BTC 0.0000140 (next), 0.0000271 (last applied); ETH 0.0000035 | BTC longs pay 0.0000157, ETH longs pay 0.0000105 |
| **Other carrying cost** | none | none | **borrowing fee**, paid by the larger open-interest side only *(live: BTC shorts 0.0000059 per hour)* |
| **Tick** | prices: ≤ 5 significant figures and ≤ (6 − szDecimals) decimals → BTC **$1**, ETH **$0.1** at current prices (the tick moves with the price level) | BTC **$1**, ETH **$0.1** (fixed: `subticksPerTick`) | **none**: contract price precision 10^-(30 − token decimals) → BTC 1e-22, ETH 1e-12; the price is the oracle's, not the trader's |
| **Lot** | 10^-szDecimals → BTC **0.00001**, ETH **0.0001** | BTC **0.0001**, ETH **0.001** | size is in **USD** (30 decimals); token precision 1e-8 (BTC), 1e-18 (ETH) |
| **Minimum order** | **$10** notional | one lot: 0.0001 BTC (≈ $7.4), 0.001 ETH (≈ $2.1) | **$1** position, $1 collateral |
| **Max leverage** *(live)* | BTC **40×** (20× above $150 M), ETH **25×** (15× above $100 M); the user sets an integer leverage | **50×** both (IMF 2 %, MMF 1.2 %); no leverage setting — it results from collateral | contract bound **200×** (min collateral factor 0.5 %), lower in practice and falling with open interest; ≈ 100× in the interface (not verified) |
| **Maintenance margin** | half of the initial margin at max leverage: BTC 1.25 %, ETH 2 % (tiered) | 1.2 % of notional at the oracle price | max($1, size × 0.5 %) remaining collateral after PnL, fees and capped negative impact |
| **Trading fee (base tier)** | taker **0.045 %**, maker **0.015 %** (14-day volume tiers down to 0.024 % / 0; HYPE staking discounts) | taker **0.05 %**, maker **0.01 %** (30-day tiers down to 0.025 % / −0.011 %; DYDX staking discounts) | position fee **0.04 %** if the trade improves the long/short balance, **0.06 %** otherwise; no maker/taker |
| **Other execution costs** | spread and depth of the book | spread and depth of the book *(live: BTC bid/ask 29 $ apart, ≈ 4 bps)* | **price impact** (BTC/ETH: applied at close, capped +0.4 % / −0.5 %, excess claimable later) + **execution fee** in ETH (excess refunded) + swap fee if collateral is swapped |
| **Gas** | none for orders | none for orders; other transactions pay in USDC or DYDX | Arbitrum gas for the request transaction (or relay fee in Express mode) |
| **Liquidation** | equity < maintenance → market orders on the book; below 2/3 of maintenance → backstop by the liquidator vault (HLP), **maintenance margin not returned**; positions > $100 k liquidated 20 % at a time; **no liquidation fee** otherwise; uses the mark price | oracle-valued equity < maintenance → protocol order matched on the book at a "fillable price"; **penalty up to 1.5 %** to the insurance fund; ≤ 10 % of a position per block | keeper liquidates the **position** when remaining collateral < max($1, 0.5 % of size); liquidation fee 0.20 % (standard pools) to 0.45 %; remaining collateral returned |
| **When the liquidation engine is short** | auto-deleveraging of the opposite side, ranked by profit and leverage | insurance fund, then deleveraging against random offsetting positions | ADL of profitable positions when pool PnL exceeds its cap |
| **Trading-only key** | API ("agent") wallet: can trade, cannot withdraw | permissioned key (authenticator) restricted to place/cancel on chosen subaccount and markets; cannot withdraw or transfer | subaccount (One-Click Trading): orders only, receiver forced to the main account; bounded by action count, expiry and the Router token allowance |
| **Eligibility in the terms** | — (see the Hyperliquid dossier) | **excludes the United States, Canada and the United Kingdom**; the indexer geoblocks account endpoints | excludes U.S. persons and sanctioned territories; Canada not named in the passages read |
| **Liquidity** *(live)* | BTC OI ≈ 40 230 BTC, 24 h volume ≈ $3.5 bn; ETH OI ≈ 760 900 ETH, ≈ $1.4 bn | BTC OI ≈ 222 BTC, ≈ $5.1 M; ETH OI ≈ 4 494 ETH, ≈ $44 M | BTC pool: OI ≈ 269 BTC long + short, ≈ $31 M, capacity ≈ $89 M long / $84 M short; ETH pool: ≈ $12 M volume |

## What the router must therefore never do

1. **Net a long on one venue against a short on another as "flat".** The three contracts reference different prices: a HL mark that
   blends its own book with CEX perps and a USDT-denominated oracle; a dYdX USD spot-index oracle; a GMX Chainlink min/max pair. HL
   BTC is exposed to USDT/USD: a USDT depeg moves HL's price and PnL against the two USD-indexed venues with no conversion.
2. **Compare funding numbers without their unit, sign and payer.** HL and dYdX publish an hourly rate paid on oracle notional, HL's
   formula being an 8 h rate split in eight. GMX accrues per second, publishes the same rate per hour, per second or per year
   depending on the endpoint, with opposite sign conventions between its two APIs (`gmx.md`, Part A), and adds a borrowing fee that
   only one side pays. The adapters normalise `Ticker.funding` to "fraction of notional that longs pay per `fundingIntervalSec`"
   (3600 on all three) — the normalisation removes the unit problem, not the economic differences.
3. **Treat sizes as interchangeable.** HL and dYdX orders are in base units with different lots (0.00001 vs 0.0001 BTC); GMX orders
   are in USD and the position's token size results from the execution price. A size valid on one venue is not valid on another
   (`D.quantize` to each venue's lot, never a shared rounding).
4. **Compare a book price with an oracle price.** On HL and dYdX the cost of a size is read from the book (and dYdX's book is thin:
   ≈ 0.14 BTC at the best level on the check date). On GMX the cost is position fee + price impact + execution fee + borrowing,
   computed from pool state — `liquidity()` gives the inputs; the estimate must be labelled an estimate.
5. **Assume an accepted order is a fill.** HL and dYdX match immediately but dYdX short-term orders are only "best effort" in the
   indexer until confirmed; a GMX order is a request that a keeper executes, cancels or freezes later, at a price not known when
   the request is signed (bounded by `acceptablePrice`).
6. **Carry a leverage figure across venues.** HL: an explicit per-asset setting (max 40× / 25×, tiered by size). dYdX: no setting,
   50× bound from a 2 % initial margin on the whole subaccount. GMX: per position, bound that shrinks as open interest grows.
   Liquidation follows three different prices (mark, oracle, oracle min/max) and three different penalties (lost maintenance
   margin in a backstop, up to 1.5 %, 0.20–0.45 % fee).
7. **Assume the same collateral risk.** USDC on HyperCore, Noble USDC on dYdX Chain (IBC), and on GMX possibly WBTC.b or WETH as
   collateral — in which case the collateral itself moves with the market and the liquidation price is not the one of a
   USDC-margined position.
8. **Offer a venue the owner may not use.** Eligibility differs by venue and is a precondition of routing, not a tie-breaker.

## Not verified

- GMX: interface leverage limit (≈ 100×), the liquidation-fee bucket of `BTC/USD [BTC-USDC]`, unit and sign of rate fields
  (inferred from a three-way live comparison). dYdX: funding cap (derived from formula and live parameters, never observed).
- Hyperliquid: dates and reasons of the changes from the commonly cited 4 %/h funding cap (docs now say 0.5 %/h) and from 50× to
  40× BTC leverage; open-interest caps; portfolio-margin modes. Fees, margining and tick pages were read through a summarising
  fetch (numbers confirmed against the API where the API carries them).
- All *(live)* figures are single snapshots taken within the same half hour, not averages.

# GMX v2 (GMX Synthetics) — venue dossier

Checked against the official documentation, the OpenAPI specification, the contract sources and the live public endpoints on
**2026-11-10** (2026-11-11 UTC). Adapter: `packages/derivatives/src/venues/gmx/` — **read side only**
(`capabilities.orders = false`). Nothing was signed or sent: only public `GET` requests and one public GraphQL query.

**What makes this venue different (the router must not assume otherwise)**

- **There is no order book.** A trader opens against a liquidity pool at the signed oracle price, adjusted by price impact. `book()`
  throws `VenueError('unsupported')`; `liquidity()` exposes what the venue really has.
- **Execution is two-step**: a request transaction, then a keeper transaction at a later oracle price. An order can be cancelled
  or frozen instead of filled. A market order is `pending` until its keeper runs.
- **One index, several instruments.** `BTC/USD` is listed against four pools on Arbitrum (`[BTC-USDC]`, `[BTC-BTC]`, `[TBTC-TBTC]`,
  `[USDG-USDG]`), each with its own collateral tokens, liquidity, funding and borrowing rates. Each is a distinct `Instrument`.
- **Margin is isolated per position**; there is no venue account. Orders are sized in **USD**, positions in index tokens.
- **Costs that an order-book venue does not have**: borrowing fee, price impact (capped, partly settled at close), execution fee
  in the native token, in addition to position fee and funding.

Part A describes the read adapter as delivered. Part B is the trading model dossier (no trading code is wired).

---

# Part A — Read side (delivered)

## Surfaces used (pinned in `adapter.ts`, no SDK)

| Surface | Arbitrum | Avalanche | Used for |
|---|---|---|---|
| GMX API (OpenAPI spec `https://arbitrum.gmxapi.io/swagger.json`) | `https://arbitrum.gmxapi.io/v1` (peer `…gmxapi.ai/v1`) | `https://avalanche.gmxapi.io/v1` | markets, tickers, config, tokens, pairs, OHLCV, rates, positions, orders, trades |
| Oracle API | `https://arbitrum-api.gmxinfra.io` (+ 2 documented fallbacks) | `https://avalanche-api.gmxinfra.io` | raw oracle min/max prices in contract precision (`oraclePrices()`) |
| Subsquid GraphQL | `https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql` | `…-avalanche:prod/…` | public trade feed (`trades()`) |

Sources: https://docs.gmx.io/docs/api/overview/ , https://docs.gmx.io/docs/api/gmx-api/gmx-io-gmx-public-api/ ,
https://docs.gmx.io/docs/api/rest-api/oracle-prices/ , https://docs.gmx.io/docs/api/rest-api/fallback-urls/ , https://docs.gmx.io/docs/api/graphql/ .
The docs describe the GMX API as "under active development" ("Expanding") and the Oracle API as "Stable". No rate limit figure is
published; HTTP 429 → `rate_limited`, 5xx → `unavailable`. The peer host and the Oracle fallbacks are pinned but **not** used
automatically (no failover logic in this delivery). MegaETH (third live chain) is not wired.

**Dependency decision.** `@gmx-io/sdk` was not added. The documented HTTP surfaces cover every read; the SDK would bring its own
viem/GraphQL stack and would have to be kept out of the isolated signer bundle anyway. The cost is that the adapter trusts the
operator's indexers instead of reading `Reader`/`DataStore` by `eth_call` — see "not verified".

## `VenueAdapter` method → request → mapping

| Method | Request | Notes |
|---|---|---|
| `instruments()` | `GET /markets` + `GET /tokens/info` (cached 60 s) | swap-only markets excluded; 124 perpetual markets on Arbitrum, 15 on Avalanche on the check date |
| `tickers()` | `GET /markets/tickers` + `GET /pairs` | mark = index = `markPrice`; `mid` null; `funding` = −`fundingRateLong` (per hour, **positive = longs pay**); `openInterest` = long + short index tokens; `volume24h` = `/pairs.target_volume`; `change24h` = `priceChangePercent24hBps / 10 000`. If `/pairs` fails, `volume24h` is null and the rest stands |
| `book()` | — | `VenueError('unsupported')` |
| `liquidity(symbol?)` (extra) | `GET /markets/tickers` + `GET /markets/config` | per side: open interest USD, max open interest, available liquidity (pool view) and **capacity** (JIT-aware figure the docs recommend "for sizing", with its limiting factor), funding / borrowing / net rates per hour **in the venue's sign (positive = the side receives)**, price-impact factors, exponents and caps, position fee factors, minimum collateral factors, oracle min/max |
| `oraclePrices()` (extra) | Oracle `GET /prices/tickers` + `GET /tokens` | min/max per token converted from contract precision |
| `trades(symbol, limit)` | GraphQL `tradeActions(eventName_eq: "OrderExecuted", marketAddress_eq, orderType_in: [2..8])` | executed position orders, newest first; zero-size rows (collateral-only changes) dropped |
| `candles(symbol, interval, …)` | `GET /prices/ohlcv?symbol=<index symbol>&timeframe=&limit=&since=` | prices are strings; **no volume is published → `volume: "0"`** |
| `fundingHistory(symbol, {start,end})` | `GET /rates?period=&address=<market>` | hourly snapshots, per-second factor × 3600, same sign convention as `Ticker.funding`; `period` chosen from `start` (`1d … total`) |
| `account(address)` | `GET /positions?address=` | no account-level margin on GMX: `equity` = Σ `netValue`, `collateral` = `marginUsed` = Σ `collateralUsd`, `freeCollateral` = `0`; wallet balances are not venue state |
| `positions(address)` | `GET /positions?address=` | fee and price-impact fields kept under `position.gmx` |
| `openOrders(address)` | `GET /orders?address=` + `GET /positions?address=` | swap orders left out |
| `orderHistory(address)` | `GET /trades?address=&limit=` | life cycles rebuilt per `orderKey` |
| `fills(address)` | `GET /trades?address=&limit=` | `OrderExecuted` position actions |
| `funding(address)` | — | `VenueError('unsupported')`: funding is settled into collateral at each position change (`fill.gmx.fundingFeeAmount`), pending amounts are on `position.gmx` |

No websocket is documented for these surfaces (the OpenAPI text mentions a `prices` channel without describing it): `stream` is
absent and `capabilities.stream = false`. No testnet API host is documented: `capabilities.testnet = false`.

**Instrument fields**

| Field | Source |
|---|---|
| `symbol` | the GMX API symbol, e.g. `BTC/USD [BTC-USDC]` (note: the Oracle API names the same market `BTC/USD [WBTC.b-USDC]`) |
| `collateral` | `"<long token> or <short token>"` (one token for single-token pools); other tokens can be swapped in through `swapPath` |
| `tickSize` | price precision of the contracts: `10^-(30 − index token decimals)` → BTC `1e-22`, ETH `1e-12`. There is no tick in the trading sense |
| `lotSize` | index token precision (`10^-decimals`); orders are sized in USD with 30 decimals. `minOrderSize` null, `minNotional` = `minPositionSizeUsd` ($1) |
| `maxLeverage` | `leverageTiers[0].maxLeverage / 10 000` as published by the API: **200×** for BTC/ETH on Arbitrum, **100×** on Avalanche. This is the contract bound `1 / minCollateralFactor`; the effective maximum is lower (fees, price impact) and falls as open interest grows (`minCollateralFactorForOpenInterest`). The interface offers less. Treat it as an upper bound, not a usable setting |
| `marginModes` | `['isolated']` |
| `fundingIntervalSec` | 3600 — funding accrues **per second**; the venue quotes it per hour and that is the normalisation used |
| `markPriceMethod` / `settlement` | signed Chainlink Data Streams min/max price at execution, displayed mark = mid; PnL in USD, paid in the pool token of the side |
| `status` | `isListed` → `active`, otherwise `halted` |

**Orders**: `MarketIncrease`/`MarketDecrease` → `market`; `LimitIncrease` → `limit`; `LimitDecrease` → `take_profit_market`;
`StopLossDecrease` → `stop_market`; `StopIncrease` → `stop_market`; `Liquidation` → `market`. Side: increase long / decrease short
= `buy`. `reduceOnly` = decrease. **`Order.size` is in USD** (`sizeDeltaUsd`), flagged by `order.gmx.sizeUnit = 'usd'`. A decrease
order with `sizeDeltaUsd = 2^256 − 1` closes the whole position: `gmx.closesWholePosition = true` and `size` is the current USD size
of the matching position (or `0` if none is found — no guess). `price` = `acceptablePrice` (null when 0 or max uint), `triggerPrice`
in contract precision. GMX has no client order id: `clientId` = `venueOrderId` = the order key. A market order still listed is
`pending` (waiting for its keeper); limit and trigger orders are `open`; a frozen order keeps `gmx.isFrozen`.

**Fills**: `price` = `executionPrice`, `size` = `sizeDeltaInTokens`, `fee` = `positionFeeAmount` in the position's collateral token
(`feeAsset`), `closedPnl` = `pnlUsd` on decreases, `liquidation` = order type 7. Kept under `fill.gmx`: borrowing, funding and
liquidation fee amounts, trader discount, `priceImpactUsd`, `totalImpactUsd`, `proportionalPendingImpactUsd`,
`priceImpactDiffUsd`, swap impact and fee, base PnL, index price min/max, transaction hash.

## Exact arithmetic (`wire.ts`)

| Quantity | Wire format | Conversion |
|---|---|---|
| USD value, factor, rate | integer × 10^30 | `usd()` / `factor()` |
| GMX API price | integer × 10^30 per **whole** token | `apiPrice()` |
| Contract price (Oracle API, order trigger/acceptable price, trade execution price) | integer × 10^(30 − token decimals) | `contractPrice(raw, decimals)`, `toContractPrice()` (throws on excess precision) |
| Token amount | integer × 10^decimals | `tokenAmount()` |
| Leverage, percentages | basis points | `bps()` |
| Per-second rate → hourly | × 3600 | `perSecondToHourly()` |

All bigint. The two price formats describe the same value (BTC: `73634340805077142500000000000000000` in the GMX API,
`736743447840545300000000000` in the Oracle API — 10^8 apart); mixing them up is an error of 8 to 18 orders of magnitude, hence
the explicit function names and a test tying the two together. Two endpoints print JSON **numbers** (`/pairs` volumes, Oracle
`/prices/candles`): they are parsed with `parseJsonExact`, which keeps each number as its source text (`JSON.parse` reviver
source access), so not even those pass through a double.

**Rate conventions observed live (not stated in the docs)** — same market, same minute:

| Endpoint | BTC/USD value | Unit and sign |
|---|---|---|
| GMX API `/markets/tickers.fundingRateLong` | `-16130132113907903727592800` | per **hour** × 10^30; **negative = the side pays** |
| GMX API `/rates…fundingRateLong` | order of `-3.5e21` | per **second** × 10^30; same sign |
| Oracle API `/markets/info.fundingRateLong` | `141509679284136523966227072000` | per **year** × 10^30; **positive = the side pays** (opposite sign) |

`−1.613e-5 × 8760 = −0.1413`: the three agree once unit and sign are aligned. The adapter uses the GMX API values only and
normalises `Ticker.funding` / `fundingHistory` to "what longs pay per hour"; `liquidity()` keeps the venue's sign and says so.

## Read side — verified / not verified

**Verified live (2026-11-11 03:13 UTC, `npx tsx scripts/smoke-gmx.mts [arbitrum|avalanche]`)**
- Arbitrum: 124 perpetual markets, 4 BTC/USD pools and 4 ETH/USD pools. Avalanche: 15 markets. All steps pass on both chains.
- `BTC/USD [BTC-USDC]`: oracle mid 73 732.75; longs pay 0.0000157 per hour (≈ 13.8 % a year) although long open interest is the
  smaller side ($9.66 M long vs $10.84 M short) — adaptive funding has inertia; borrowing: shorts 0.00000586 per hour, longs 0;
  capacity $89.3 M long / $84.2 M short (limited by reserve); position fee 0.04 % / 0.06 %; impact cap +0.4 % / −0.5 %;
  24 h volume $31.4 M; open interest 269.46 BTC (long + short).
- `ETH/USD [WETH-USDC]`: oracle mid 2 063.55; longs pay 0.0000105 per hour; OI $5.42 M long / $10.08 M short; 24 h volume $11.8 M.
- Oracle API price ÷ GMX API mark = 0.999991 (BTC), 0.999965 (ETH): the two formats convert to the same value.
- A live answer contradicted the first schema: `availableLiquidityLong` can be **negative** (a side over its reserve). Fixed.
- Account read of a public address from the trade feed: 2 positions (entry, mark, liquidation price, leverage, closing fee,
  pending impact, pending borrowing/funding), fills with fees and impact.
- Fixtures (`packages/derivatives/test/fixtures/gmx/`): 18 answers; 26 tests.

**Not verified**
- **On-chain cross-check.** Positions, orders and market parameters come from the operator's API, not from `Reader` / `DataStore`
  by `eth_call`. For reconciliation of real orders ("venue state is the truth"), the execution engine should read
  `Reader.getAccountPositions` / `getAccountOrders` on chain (addresses in Part B §4). Not implemented.
- Unit and sign of the rate fields: inferred from the three-way comparison above, not documented.
- `leverageTiers[].maxLeverage` scaling (basis points) — inferred from `minCollateralFactor` 0.005 ↔ `2000000`.
- Liquidation fills (type 7), frozen orders, increase orders with a swap path (fee token resolution through the path), TWAP
  parts: code paths exist, no live sample in the fixtures.
- `/trades` pagination (`cursor`) is not followed: `fills` and `orderHistory` see the most recent 1000 actions at most.
- GLV / GM liquidity-provider data, GMX Account (multichain) balances, MegaETH: out of scope.

---

# Part B — Trading model (documentation only, no code wired)

Note on Part B's own "Not verified" list: the endpoint shapes it marks as "not fetched live" (`/prices/candles`, `/positions`,
`/orders`, GraphQL) and the scaling of the rate fields were fetched and exercised by the adapter — Part A above is the reference
for those.

Checked against the official documentation, the contract sources and the live public read APIs on **2026-11-10**.
Documentation only: no transaction, order, signature or relay request was sent; only public `GET` endpoints were read
(`/markets`, `/markets/info`, `/prices/tickers`, `/tokens`, `/ping`, `swagger.json`). Nothing below was executed on-chain and
no DataStore value was read by RPC — every on-chain parameter quoted comes from the GMX API snapshot or from the docs and is
labelled as such.

Reference revision of the contracts: branch **`updates` @ `bf30ebb4cff17b7f92f8c738f145e75b871a1576`** (2026-07-24). This is
the branch the docs link to and the commit the docs' address tables are pinned to. `main` (default branch, last push
2026-10-26) **differs**: it has no `createTwapOrder`, no keeper cancellation of market orders, no `uiFeeFactor` snapshot, and
keeps the `simulateExecuteLatest*` functions on `ExchangeRouter`. `SubaccountRouter.sol`, `SubaccountUtils.sol`,
`IBaseOrderUtils.sol`, `IRelayUtils.sol`, `GasUtils.sol`, `BaseRouter.sol` are byte-identical on both branches. Which exact
commit each deployed address was built from was **not** verified on an explorer.

## Sources

- Trading overview (modes, GMX Account, One-Click): https://docs.gmx.io/docs/trading/overview/
- Positions and order types (pricing, TWAP, auto-cancel, execution guarantees): https://docs.gmx.io/docs/trading/order-types/
- Fees (position, swap, price impact, funding, borrow, network fee): https://docs.gmx.io/docs/trading/fees/
- Liquidations and ADL: https://docs.gmx.io/docs/trading/liquidations/
- Contract addresses: https://docs.gmx.io/docs/api/contracts/addresses/
- ExchangeRouter reference: https://docs.gmx.io/docs/api/contracts/exchange-router/
- Architecture (two-phase execution, keepers, frozen orders): https://docs.gmx.io/docs/api/contracts/architecture/
- Advanced entry points (SubaccountRouter, relay routers, multichain): https://docs.gmx.io/docs/api/contracts/advanced-entrypoints/
- Delegated trading integration: https://docs.gmx.io/docs/api/contracts/delegated-trading/
- Contract-side fees and DataStore keys: https://docs.gmx.io/docs/api/contracts/fees/
- Known issues: https://docs.gmx.io/docs/api/contracts/known-issues/
- API overview / integration guide: https://docs.gmx.io/docs/api/overview/ · https://docs.gmx.io/docs/api/integration-guide/
- Oracle API: https://docs.gmx.io/docs/api/rest-api/oracle-prices/ · https://docs.gmx.io/docs/api/rest-api/markets/ ·
  https://docs.gmx.io/docs/api/rest-api/fallback-urls/ · https://docs.gmx.io/docs/api/rest-api/liquidity/
- GMX API (OpenAPI): https://docs.gmx.io/docs/api/gmx-api/gmx-io-gmx-public-api/ · spec https://arbitrum.gmxapi.io/swagger.json
- GraphQL (Subsquid): https://docs.gmx.io/docs/api/graphql/
- SDK: https://docs.gmx.io/docs/sdk/v2/ · https://docs.gmx.io/docs/sdk/v1/exports/configs/express/
- Referrals: https://docs.gmx.io/docs/referrals/
- Contracts spec (README): https://github.com/gmx-io/gmx-synthetics/blob/updates/README.md
- Contract sources (all under https://github.com/gmx-io/gmx-synthetics/blob/updates/contracts/): `router/ExchangeRouter.sol`,
  `router/BaseRouter.sol`, `router/SubaccountRouter.sol`, `subaccount/SubaccountUtils.sol`, `router/relay/BaseGelatoRelayRouter.sol`,
  `router/relay/SubaccountGelatoRelayRouter.sol`, `router/relay/SubaccountRouterUtils.sol`, `router/relay/RelayUtils.sol`,
  `router/relay/IRelayUtils.sol`, `order/IBaseOrderUtils.sol`, `order/Order.sol`, `order/OrderUtils.sol`, `order/BaseOrderUtils.sol`,
  `order/IncreaseOrderUtils.sol`, `order/DecreaseOrderUtils.sol`, `order/ExecuteOrderUtils.sol`, `exchange/OrderHandler.sol`,
  `exchange/BaseHandler.sol`, `gas/GasUtils.sol`, `position/PositionUtils.sol`, `position/Position.sol`, `market/MarketUtils.sol`,
  `data/Keys.sol`
- SDK address table: https://github.com/gmx-io/gmx-interface/blob/release/sdk/src/configs/contracts.ts (default branch is
  `release`, `@gmx-io/sdk` 2.7.0; mainnet entries identical on `master`)
- SDK express constants: https://github.com/gmx-io/gmx-interface/blob/release/sdk/src/configs/express.ts
- SDK oracle hosts: https://github.com/gmx-io/gmx-interface/blob/release/sdk/src/configs/oracleKeeper.ts
- Terms and Conditions (source of the page, "Last modified: August 20th, 2026"):
  https://github.com/gmx-io/gmx-interface/blob/release/landing/src/pages/TermsAndConditions/TermsAndConditions.tsx

## 0. Venue in one table

| | |
|---|---|
| Type | Oracle-priced perpetuals against isolated liquidity pools (GM markets). "GMX uses oracle-based pricing rather than an orderbook model." No order book, no matching, no maker/taker. |
| Live chains | Arbitrum One (42161), Avalanche C-Chain (43114), MegaETH (4326). "GMX V2 is active on the following networks. Arbitrum One, Avalanche C-Chain, MegaETH". Botanix (3637): "Legacy. GMX no longer supports Botanix". GMX on Solana is a separate program (only a pair feed is documented). |
| GMX Account (multichain) | Live. Source chains Ethereum, Base, BNB (and Arbitrum itself); "Arbitrum is the only supported settlement chain"; bridged with Stargate + LayerZero. Not available on Avalanche or MegaETH. |
| Custody | Non-custodial contracts. Collateral sits in the position (market token contract), pending-order funds in `OrderVault`. |
| Settlement | On-chain, two transactions per action (request, then keeper execution). PnL is linear and USD-based; profitable longs are paid in the market's long token, profitable shorts in the short token. |
| Margin | Isolated per position. No cross margin, no account-level margin. |
| Trading modes | Classic (wallet transaction per action), Express (EIP-712 message relayed by "GMX Relay"), Express + One-Click (messages signed by a subaccount key). "trading fees are the same on all modes". |

## 1. Two-step execution model

"To avoid front-running issues, most actions require two steps to execute: User sends transaction with request details … Keepers
listen for the transactions, include the prices for the request then send a transaction to execute the request" (README).

| Step | Who | What |
|---|---|---|
| 1. Request | account (or relay router on its behalf) | `createOrder` stores the order in `DataStore` and moves collateral + execution fee into `OrderVault`. "No oracle prices are needed at this stage." Emits `OrderCreated`, returns `bytes32 key`. |
| 2. Execution | order keeper (`onlyOrderKeeper`) | `OrderHandler.executeOrder(key, oracleParams)` bundles signed prices, runs `doExecuteOrder` inside a `try/catch`. |

**Oracle prices.** "GMX receives price data from Chainlink Data Streams as a spread with two values derived from the bid and ask
in each data stream report" — `minPrice` (bid) and `maxPrice` (ask). Providers deployed: `ChainlinkDataStreamProvider` ("primary
source for most tokens"), `ChainlinkPriceFeedProvider` ("fallback and reference"), `EdgeDataStreamProvider`, `StaticOracleProvider`.
Reference check: `MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR` against Chainlink feeds where a provider requests it.

**Which price timestamps a keeper may use** (`IncreaseOrderUtils.processOrder`, `DecreaseOrderUtils.validateOracleTimestamp`):

| Order type | Lower bound on `minOracleTimestamp` | Upper bound on `maxOracleTimestamp` |
|---|---|---|
| MarketIncrease, MarketDecrease | `order.updatedAtTime` | `order.updatedAtTime + REQUEST_EXPIRATION_TIME` (else `OracleTimestampsAreLargerThanRequestExpirationTime`) |
| LimitIncrease, StopIncrease | `max(order.updatedAtTime, order.validFromTime)` | none |
| LimitDecrease, StopLossDecrease | `max(order.updatedAtTime, position.increasedAtTime)` and `order.validFromTime` | none |
| Liquidation | `max(position.increasedAtTime, position.decreasedAtTime)` | none |

Prices are therefore always **after** the request (timestamp-based; block-number ranges appear only as fields of the signed-price
payload, see §8). `REQUEST_EXPIRATION_TIME` is documented as "300 seconds on these chains" (Arbitrum, Avalanche, MegaETH).

**Execution fee.**
- Paid in the wrapped native token (WETH on Arbitrum, WAVAX on Avalanche) sent to `OrderVault` in the same transaction. If the
  collateral token is itself WNT the fee is carved out of the transferred amount (`OrderUtils.createOrder`).
- Minimum checked at creation: "`tx.gasprice * GasUtils.adjustGasLimitForEstimate(dataStore, estimatedGasLimit, oraclePriceCount)`",
  with `estimatedGasLimit = GasUtils.estimateExecuteOrderGasLimit` = per-type base gas limit + gas per swap × swap count +
  `callbackGasLimit`. Below the minimum the creation reverts with `InsufficientExecutionFee`.
- Whatever WNT actually arrived becomes the order's fee (`params.numbers.executionFee = wntAmount`).
- At execution the keeper is paid `adjustGasUsage(gasUsed, oraclePriceCount) * tx.gasprice`
  (= `EXECUTION_GAS_FEE_BASE_AMOUNT_V2_1` + `EXECUTION_GAS_FEE_PER_ORACLE_PRICE` × prices + gasUsed × `EXECUTION_GAS_FEE_MULTIPLIER_FACTOR`),
  capped at the order's fee; "only the gas actually consumed is paid to the keeper — the remainder is refunded".
- **Refund receiver, as coded:** on execution `order.receiver()`; on cancellation `order.cancellationReceiver()` or, if zero,
  `order.receiver()`; on freeze `order.receiver()`; offered first to the `callbackContract` via `refundExecutionFee` when one is set.
  The docs say "refunded to the request's `account` address" — identical only when `receiver == account` (always the case for
  subaccount orders, and what this wallet must set).
- Arbitrum: since 2026-09-23 the interface adds "a priority fee allowance of 0.03 gwei multiplied by the estimated execution gas
  limit" to Classic requests because "the contracts reject a request whose execution fee is below the estimated execution gas
  limit multiplied by the transaction's gas price".
- Liquidation and ADL orders carry no fee: "gas costs for liquidations / adl is subsidised by the treasury" (code comment).

**Callbacks.** `callbackContract` + `callbackGasLimit` per order (validated against `MAX_CALLBACK_GAS_LIMIT`); hooks
`afterOrderExecution`, `afterOrderCancellation`, `afterOrderFrozen`, `refundExecutionFee`. "Execution will still continue even if
a callback reverts." `ExchangeRouter.setSavedCallbackContract(market, callbackContract)` registers a callback for liquidations and
ADL. A wallet EOA needs none: pass `address(0)` and `callbackGasLimit = 0`.

**When the keeper cannot execute** (`OrderHandler._handleOrderError`):

| Cause | Outcome |
|---|---|
| Keeper-side: oracle error, disabled feature, insufficient gas for callback/cancellation | whole execution transaction reverts; the order stays pending |
| Trigger not reached (`InvalidOrderPrices`), `OrderValidFromTimeNotReached`, order already frozen, non-market order with `EmptyPosition` | revert; order stays |
| **Market order**, any user-side failure (acceptable price, min output, liquidity, leverage…) | **cancelled**: collateral in `OrderVault` returned to `cancellationReceiver` (or `account` if zero); fee remainder refunded |
| Any order with `InvalidPositionMarket`, `InvalidCollateralTokenForMarket`, `InvalidPositionSizeValues` | cancelled |
| **Limit / stop / TP-SL order**, other user-side failure | **frozen** (`isFrozen = true`, `executionFee` set to 0 after paying the keeper). "freeze unfulfillable orders to prevent the order system from being gamed". Only `FROZEN_ORDER_KEEPER` can retry; `updateOrder` unfreezes (and must top up the fee); the owner can cancel. `LimitSwap` always needs a frozen-order keeper. |

**Cancellation by the user.** `ExchangeRouter.cancelOrder(key)` (only `order.account`). Market orders must be at least
`REQUEST_EXPIRATION_TIME` old, else `RequestNotYetCancellable`; "Limit, Stop Market, and TP/SL orders aren't subject to this
delay". Keepers also cancel stale market orders: "about six minutes or more after the request was created or last updated … This
timing is keeper behavior, not a protocol guarantee", with reason `USER_INITIATED_CANCEL` — so "Your integration can therefore
receive a cancellation it didn't trigger".

**Auto-cancel.** `autoCancel` applies to `LimitDecrease` and `StopLossDecrease` only; when a decrease brings the position size
to zero, `clearAutoCancelOrders` cancels the listed orders. Limits "enforced on-chain": 11 per position on Arbitrum, 6 on
Avalanche ("read live from the on-chain data store and may change"). `LimitIncrease` (including conditional margin deposits) and
`StopIncrease` are never auto-cancelled and stay armed against any later position with the same key.

## 2. Orders

### 2.1 Order types (`Order.OrderType`, in enum order)

| # | Type | Trigger (index oracle price) | Created by user |
|---|---|---|---|
| 0 | `MarketSwap` | — ("cancelled if the minOutputAmount cannot be fulfilled") | yes |
| 1 | `LimitSwap` | when `minOutputAmount` can be filled | yes |
| 2 | `MarketIncrease` | — | yes |
| 3 | `LimitIncrease` | long: `maxPrice <= triggerPrice`; short: `minPrice >= triggerPrice` | yes |
| 4 | `MarketDecrease` | — | yes |
| 5 | `LimitDecrease` (take-profit) | long: `minPrice >= trigger`; short: `maxPrice <= trigger` | yes |
| 6 | `StopLossDecrease` | long: `minPrice <= trigger`; short: `maxPrice >= trigger` | yes |
| 7 | `Liquidation` | — | no ("Not user-callable"; `OrderTypeCannotBeCreated`) |
| 8 | `StopIncrease` ("Stop Market") | long: `maxPrice >= trigger`; short: `minPrice <= trigger` | yes |

ADL is not an order type but `SecondaryOrderType.Adl` on a keeper-made decrease. **TWAP exists today** and is not an order type:
`ExchangeRouter.createTwapOrder(params, twapCount, interval)` "creates the full set atomically"; "each part is a standard limit
order with a time-gated activation" (`validFromTime = start + i × interval`); `twapCount >= 2`, `interval > 0`; UI allows 2–30
parts. Market types are invalid for TWAP (non-zero `validFromTime` reverts with `UnexpectedValidFromTime`).

`DecreasePositionSwapType`: `NoSwap`, `SwapPnlTokenToCollateralToken`, `SwapCollateralTokenToPnlToken`.

### 2.2 `CreateOrderParams` — exact field list (`contracts/order/IBaseOrderUtils.sol`)

```solidity
struct CreateOrderParams {
    CreateOrderParamsAddresses addresses;
    CreateOrderParamsNumbers numbers;
    Order.OrderType orderType;
    Order.DecreasePositionSwapType decreasePositionSwapType;
    bool isLong;
    bool shouldUnwrapNativeToken;
    bool autoCancel;
    bytes32 referralCode;
    bytes32[] dataList;
}
struct CreateOrderParamsAddresses {
    address receiver; address cancellationReceiver; address callbackContract; address uiFeeReceiver;
    address market; address initialCollateralToken; address[] swapPath;
}
struct CreateOrderParamsNumbers {
    uint256 sizeDeltaUsd; uint256 initialCollateralDeltaAmount; uint256 triggerPrice; uint256 acceptablePrice;
    uint256 executionFee; uint256 callbackGasLimit; uint256 minOutputAmount; uint256 validFromTime;
}
```

| Field | Meaning and unit |
|---|---|
| `receiver` | receives every output (must not be zero). "for funding fees and claimable collateral, the funds are still credited to the owner of the position indicated by order.account" |
| `cancellationReceiver` | receives collateral and fee refund on cancellation; zero ⇒ `account`. May not be `OrderVault`. |
| `callbackContract`, `callbackGasLimit` | see §1 |
| `uiFeeReceiver` | address whose `uiFeeFactor` is charged on top (§7); zero ⇒ no UI fee |
| `market` | market token address for position orders; **must be zero for swap orders** (`UnexpectedMarket`) |
| `initialCollateralToken` | increase/swap: token sent in; decrease: the position's collateral token |
| `swapPath` | market addresses; increase: pay token → collateral token; decrease: output → receive token |
| `sizeDeltaUsd` | USD, 30 decimals |
| `initialCollateralDeltaAmount` | token base units. **Increase/swap: ignored, replaced by what `OrderVault.recordTransferIn` measured.** Decrease: collateral to withdraw. |
| `triggerPrice`, `acceptablePrice` | contract price format: `usdPrice × 10^(30 − indexTokenDecimals)` |
| `executionFee` | wei of native token; replaced by the WNT amount received if larger |
| `minOutputAmount` | swap: output token units; increase: collateral token units after `swapPath`; **decrease: a USD value (30 dec.)** because two tokens can come out |
| `validFromTime` | unix seconds; must be 0 for market orders |
| `autoCancel` | only meaningful for `LimitDecrease` / `StopLossDecrease` |
| `referralCode` | set on the account at creation; "If the trader already has a referral code set, this parameter has no effect" |
| `dataList` | free `bytes32[]`, length capped by `MAX_DATA_LENGTH`; pass `[]` |

Stored `Order.Props` additionally holds `account`, `updatedAtTime`, `srcChainId`, `uiFeeFactor` (snapshot, `updates` branch only),
`isFrozen`. A zero-size `LimitIncrease` is a "conditional margin deposit".

### 2.3 Prices, units, slippage

| Quantity | Unit |
|---|---|
| USD values (`sizeDeltaUsd`, fees, OI…) | integer × 10^30 (`FLOAT_PRECISION`) |
| Oracle / contract price of a token | "the price of one unit of the token using a value with 30 decimals of precision" ⇒ `usd × 10^(30 − tokenDecimals)`. ETH (18 dec.): 12 decimals; BTC (8): 22; USDC (6): 24. `tokenAmount × price = USD×10^30`. |
| Factors (fee, collateral, funding…) | fraction × 10^30 |
| Tick size / lot size | **none**. Any price representable at the above precision; size is a USD amount. |

- Execution price base: long open `maxPrice`, long close `minPrice`, short open `minPrice`, short close `maxPrice`.
- `acceptablePrice`: increase long executes only if `executionPrice <= acceptablePrice` (short: `>=`); decrease long `>=`
  (short `<=`). Failure ⇒ `OrderNotFulfillableAtAcceptablePrice` ⇒ market order cancelled, limit order frozen.
- UI: "The default allowed slippage is 1%", max 5%; applies to market orders. For `StopIncrease` the UI sets the acceptable price
  "to the maximum possible value for longs and the minimum for shorts" — i.e. no protection.
- "Slippage protects only against oracle price movement … Price impact is a separate adjustment based on pool imbalance".

### 2.4 Price impact

- Formula: `(initial USD difference)^exponent × factor − (next USD difference)^exponent × factor`; for positions the difference
  is long OI vs short OI; separate positive and negative factors; crossing the balance point splits the calculation.
- Position impact adjusts the entry/exit price, it is not deducted from collateral (README).
- **Applied on close only**: "opening a position incurs no price impact at entry … it is only applied (charged or credited) when
  you close or decrease a position — hence the name 'net price impact'". The amount stored at open is `pendingImpactAmount`.
- Caps: positive "40 bps (0.4%) for most markets"; negative per market, 50 bps for BTC, ETH, SOL, BNB, BCH, PEPE, XAUT, up to
  1000 bps on thin markets.
- Excess over the negative cap: "the excess becomes claimable as a rebate after a five-day delay" — claimed with
  `ExchangeRouter.claimCollateral(markets, tokens, timeKeys, receiver)`; "rebates are reviewed before being granted".
- Virtual inventory "tracks the imbalance of tokens across similar markets, e.g. ETH/USDC, ETH/USDT".
- Single-token BTC/USD [WBTC.e-WBTC.e] and ETH/USD [WETH-WETH] pools: "position impact factors set to zero" (docs). The live
  API returned 1e-15 / 2e-15 for them on 2026-11-10 — negligible, not literally zero.

## 3. Collateral, margin, leverage

| | |
|---|---|
| Market | `(indexToken, longToken, shortToken)`; "Traders can use either the long or short token as collateral for the market." Any other pay token is swapped through `swapPath` first. |
| Synthetic market | index token differs from the long token (e.g. SOL/USD backed by ETH); ADL "is most likely to occur in synthetic markets" |
| Single-token market | long token = short token (`isSameCollaterals`), e.g. `[WETH-WETH]`, `[USDG-USDG]`; no swaps through it |
| USDG pools (Arbitrum) | "use USDG as collateral, and you can pay with USDC instead"; four older pools closed to new size on 2026-11-02 (NEAR, XRP, ZEC, HYPE) |
| Position key | `keccak256(abi.encode(account, market, collateralToken, isLong))` (`Position.getPositionKey`) — one position per tuple, isolated |
| GM / GLV | liquidity side only, out of scope |

**Leverage.**
- `minCollateralFactor` = "the minimum allowed ratio of (position collateral) / (position size)" ⇒ theoretical max leverage
  `1 / minCollateralFactor`.
- OI scaling (`PositionUtils.willPositionCollateralBeSufficient`): the factor used is
  `max(minCollateralFactor, openInterest_after × MIN_COLLATERAL_FACTOR_FOR_OPEN_INTEREST_MULTIPLIER)`. "The max allowed leverage
  of a pool decreases as the total open interest of the pool increases."
- Liquidation uses the separate `minCollateralFactorForLiquidation`.
- The interface opens at less than the contract bound: it "uses the lower of the fee-aware opening limit and a limit that keeps
  the required collateral at least twice the liquidation threshold, then rounds down to a 5x increment".
- Exceeding max leverage on a decrease does not block the close, "but the collateral within the position would not be reduced".

**Minimums** (GMX API `GET /v1/markets`, Arbitrum, 2026-11-10): `minPositionSizeUsd = 1e30` ($1), `minCollateralUsd = 1e30` ($1).
On-chain keys `MIN_POSITION_SIZE_USD`, `MIN_COLLATERAL_USD`. "The effective liquidation threshold is whichever value is greater:
the market's percentage of position size or this absolute floor."

## 4. Contracts called

**Classic flow (one transaction from the account):**

```
ERC20(collateral).approve(Router, amount)                 // once; "Router: approve token spending using this contract"
ExchangeRouter.multicall{value: executionFee}([
  sendWnt(OrderVault, executionFee),                      // wraps msg.value and sends WNT
  sendTokens(collateralToken, OrderVault, amount),        // Router.pluginTransfer from msg.sender; skip for decrease orders
  createOrder(params)                                     // or createTwapOrder(params, twapCount, interval)
])
```

"The token transfer and the `ExchangeRouter.createOrder` call must occur in a single transaction. If they are separated, other
users may withdraw the transferred tokens before your order is created." Native ETH collateral: send it as extra `value` through
`sendWnt` (the fee is subtracted from the WNT received). Other entry points: `updateOrder(key, sizeDeltaUsd, acceptablePrice,
triggerPrice, minOutputAmount, validFromTime, autoCancel)`, `cancelOrder(key)`, `claimFundingFees`, `claimCollateral`,
`claimAffiliateRewards`, `setSavedCallbackContract`, `setUiFeeFactor`, `claimUiFees`, `makeExternalCalls`. Dry-run:
`SimulationRouter.simulateExecuteLatestOrder` (reverts with `EndOfOracleSimulation` on success).

**Addresses** — from https://docs.gmx.io/docs/api/contracts/addresses/ and, where present, identical in
`sdk/src/configs/contracts.ts` (branch `release`). "Contract addresses change when logic contracts are upgraded … `DataStore`
and `RoleStore` addresses are permanent". **Re-read before every release; never hard-code without a freshness check.**

| Contract (SDK name) | Arbitrum 42161 | Avalanche 43114 | MegaETH 4326 |
|---|---|---|---|
| DataStore | `0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8` | `0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6` | `0xE43C7B694f6b652a9F4A0f275C008d18758Dce35` |
| Reader (`SyntheticsReader`) | `0xfA26cBb46e2614609406de08CA1Dc7f70a684184` | `0xa34320a507493C71Fe35E982e496F7C5d1a7fa02` | `0x51fe0b7919e1208a717E9B16a097C1C3D70eFbf6` |
| ExchangeRouter | `0x7dE39FF2e232A2203196788d37e234cF8F1b83f1` | `0xc002Db96E682FFF6675966F959677285a0C45Efa` | `0xF68560cA917717639be497BF6283aC08C9Bf0264` |
| Router (`SyntheticsRouter`) — approval target | `0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6` | `0x820F5FfC5b525cD4d88Cd91aCf2c28F16530Cc68` | `0x1eAfB14236C489C28845EC04F78DECA5Fb9879Aa` |
| OrderVault | `0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5` | `0xD3D60D22d415aD43b7e64b510D86A30f19B1B12C` | `0xD5AE04762E2afb1506695b3F36286EBE7B0E6772` |
| OrderHandler (docs only) | `0xa5D2d45228ee2E3A18AB122B2cE84997d008f4Eb` | `0xC993eF170859DAE0241a3c12B8186e456Fa1c1B0` | `0x2fFbC877Bd50c7A1c27887F012dba6469a7092F2` |
| SubaccountRouter (legacy) | `0x9c05880A2AaD7530c69e18e342eDC9E06cc757db` | `0xAda708aFf0f1D784D28cd8Ff4d6D977fF9599e5D` | `0x03B59961bF30b973fBd793A6C8ad57dA38D4D0a6` |
| GelatoRelayRouter | `0x5503b99308dB6923758F9A22d118207D633c4e87` | `0x51fe0b7919e1208a717E9B16a097C1C3D70eFbf6` | `0xbAAA3a693191e2e3E0973DE641C879D1aDD84e04` |
| SubaccountGelatoRelayRouter | `0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f` | `0xa62BD1cFE2066c5bF4180b4125BBb5116eEA26c9` | `0x603B3D3aB077CA433b888c05fa59c777d5b6dCAD` |
| MultichainOrderRouter | `0xABFC734f7CFc9352AED7a97b1F6a236eae831e8A` | `0x204CC947Fddd11c90e302db2A5ac3865021D1618` | `0x00205f26BCc52537D12fA9b0eFA5Fcc58F03ab76` |
| MultichainSubaccountRouter | `0xAb3EDf0f3eed6804BAe1bD9bF90109ccadFD262e` | `0x4A2826cAee8FF70d9392B171eaF398E0a2B55047` | `0xDB8906520812840b9835E3B84dE62C826249e20B` |
| MultichainVault | `0xCeaadFAf6A8C489B250e407987877c5fDfcDBE6E` | `0x6D5F3c723002847B009D07Fe8e17d6958F153E4e` | `0xd6922E889cE4CF14e59427F20e7d857ff81A5A9D` |
| ReferralStorage (SDK only) | `0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d` | `0x827ed045002ecdabeb6e2b0d1604cf5fc3d322f8` | `0xAd917849372eaEF498E982F90bA6459a43ecbd31` |
| EventEmitter | `0xC8ee91A54287DB53897056e12D9819156D3822Fb` | `0xDb17B211c34240B014ab6d61d4A31FA0C0e20c26` | `0xAf2E131d483cedE068e21a9228aD91E623a989C2` |
| SimulationRouter | `0xaD3051cB1aE3a86b335f12A9a41BD4d995a137ea` | `0xaB409fCaCc14Dd4234f6f86a2547f04ACC90a55e` | `0x321EB66dD95ad33715ee615AAb8dAC6394E7b3F9` |
| Oracle (docs only) | `0x26C02F221e8dB5A821e12347C7eA8a6b6E10842f` | `0x29220fA3b24279279C211701DE4a7b035122B911` | `0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f` |
| Multicall3 | `0xe79118d6D92a4b23369ba356C90b9A7ABf1CB961` | `0x50474CAe810B316c294111807F94F9f48527e7F8` | `0xF516BC01c50eebdBad4d7E506c8f690ae8EAFc52` |
| Wrapped native (SDK `NATIVE_TOKEN`) | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7` | `0x4200000000000000000000000000000000000006` |

Note the address reuse across chains (e.g. `0x51fe0b79…` is GelatoRelayRouter on Avalanche and Reader on MegaETH): **always key
an address by chain id.** Full lists: `docs/<network>-deployments.md` in gmx-synthetics at the pinned commit.

## 5. Subaccounts ("One-Click Trading")

**Exists today.** Two surfaces share the same `DataStore` state (`Keys.subaccountListKey(account)`, action count, expiry,
integration id — none keyed by router):

| Surface | Status |
|---|---|
| `SubaccountRouter` (subaccount is `msg.sender`, pays its own gas, optional auto top-up) | "a legacy contract that is still deployed but no longer used for order operations. The current GMX interface only calls it for wallet-based subaccount removal outside the express flow." Whether `subaccountFeatureDisabledKey(SubaccountRouter)` is set on-chain was not read. |
| `SubaccountGelatoRelayRouter` (subaccount signs EIP-712, a relay submits) | "the primary delegated order path used by the current GMX interface" |
| `MultichainSubaccountRouter` | same model for GMX Account balances |

**Owner-side management** (`SubaccountRouter`, `msg.sender` = main account; it is a `PayableMulticall`):
`addSubaccount(address)`, `removeSubaccount(address)`, `setSubaccountExpiresAt(subaccount, actionType, expiresAt)`,
`setMaxAllowedSubaccountActionCount(subaccount, actionType, maxAllowedCount)`, `setSubaccountAutoTopUpAmount(subaccount, amount)`,
`setIntegrationId(subaccount, integrationId)`. `actionType` = `Keys.SUBACCOUNT_ORDER_ACTION` =
`keccak256(abi.encode("SUBACCOUNT_ORDER_ACTION"))`.

**Enforcement on every subaccount action** (`SubaccountUtils.handleSubaccountAction`): subaccount must be in the account's list
(`SubaccountNotAuthorized`); the counter is incremented by the number of actions (a batch counts create + update + cancel; each
TWAP part counts one) and must stay `<= maxAllowedCount` (`MaxSubaccountActionCountExceeded`); `block.timestamp <= expiresAt`
(`SubaccountApprovalExpired`). The counter is cumulative and never reset: to grant N more actions set
`maxAllowedCount = currentCount + N`. Both limits default to 0, i.e. a freshly added subaccount can do nothing until both are set.

**Restriction on created orders — the whole of it** (`SubaccountUtils.validateCreateOrderParams`):

```solidity
if (params.addresses.receiver != account) {
    revert Errors.InvalidReceiverForSubaccountOrder(params.addresses.receiver, account);
}
if (params.addresses.cancellationReceiver != address(0) && params.addresses.cancellationReceiver != account) {
    revert Errors.InvalidCancellationReceiverForSubaccountOrder(params.addresses.cancellationReceiver, account);
}
```

Additional relay-side guards (`BaseGelatoRelayRouter`): external calls are forbidden — "malicious subaccount could steal main
account funds through external calls" (`NonEmptyExternalCallsForSubaccountOrder`); relay-fee swaps are capped by
`MAX_RELAY_FEE_SWAP_USD` (production "100 USD") and `MAX_RELAY_FEE_SWAP_USD_FOR_SUBACCOUNT`; with a callback contract the
execution fee is capped by `MAX_EXECUTION_FEE_MULTIPLIER_FACTOR` because "a malicious subaccount could provide a large
executionFee and receive most of it as a refund sent to a callbackContract".

| A subaccount **can** | A subaccount **cannot** |
|---|---|
| create **any** user order type for the account: swaps (`MarketSwap`, `LimitSwap`), increases, decreases, TWAP — in any market, any size, any leverage the contracts allow, any `acceptablePrice` / `minOutputAmount` | set `receiver` or `cancellationReceiver` to anything but the main account ("Funds from decreasing positions, closing positions, or swaps can only be sent back to your wallet") |
| "update, and cancel any order for an account" — including orders the owner created | make external calls / external swaps |
| "spend wnt and collateral from the account" — any token for which the account has given `Router` an allowance, up to allowance and balance | transfer tokens out, bridge out of a GMX Account, deposit/withdraw GM or GLV, shift |
| choose `uiFeeReceiver`, `callbackContract`, `referralCode`, `swapPath`, the relay `feeToken` / `feeAmount` | claim funding fees, claimable collateral, affiliate rewards ("Deposits, withdrawals, shifts, claims — Not delegated") |
| withdraw collateral from a position (a decrease order carrying a collateral delta) — it lands in the main account's wallet | add or remove subaccounts, change its own limits |

**DECISIVE QUESTION — can a key be limited to trading without withdrawal rights? Yes, at contract level.** A GMX subaccount is
exactly that: every output and every refund is forced to the main account, and it has no transfer, claim or bridge entry point.
It is the functional equivalent of a Hyperliquid agent wallet, with two extra on-chain limits (action count, expiry) and one
weaker point (the token allowance to `Router` is shared).

**Residual risk — what a stolen trading key can still cost, within its action budget and expiry:**
1. Position/swap fees (4–7 bps of size per action) and execution + relay fees on up to `maxAllowedCount` actions.
2. Adverse trades: maximum-leverage positions with a permissive `acceptablePrice`, `MarketSwap` with `minOutputAmount = 0`,
   closing or flipping the owner's positions, cancelling protective stop-losses, liquidation of whatever it opened.
3. Engineered losses against the attacker's own account: paying capped negative price impact (up to 50 bps on BTC/ETH, more on
   thin markets) that the attacker's opposite position collects, swaps through thin pools.
4. UI-fee skim: `uiFeeReceiver` = attacker, up to `MAX_UI_FEE_FACTOR` of size per order (value not read).
5. Capped execution-fee refund to an attacker `callbackContract`; a referral code of the attacker if the account has none
   (affiliate reward only — the trader side gets a discount).
6. Exposure is bounded by **balance × allowance to `Router`**, not by the position the owner had in mind: every approved token
   is spendable. `receiver = account` means the money never leaves the owner's addresses except as losses and fees.

## 6. Express (gasless) and GMX Account

**Relay.** "Express Trading and Express + One-Click Trading submit through GMX Relay, GMX's self-hosted relay. GMX no longer uses
Gelato Relay. The contracts keep their deployed `Gelato` names". "any submitter that isn't Gelato's forwarder takes the
sponsored-call path, where the contract computes the relay fee and pays it in WNT to `RELAY_FEE_ADDRESS`."

**What is signed (EIP-712).**

| | |
|---|---|
| Domain | `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with `name = "GmxBaseGelatoRelayRouter"`, `version = "1"`, `chainId` = source chain, `verifyingContract` = the relay router called |
| Create | `CreateOrder(address account,CreateOrderAddresses addresses,CreateOrderNumbers numbers,uint256 orderType,uint256 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList,bytes32 relayParams,bytes32 subaccountApproval)` |
| Sub-types | `CreateOrderAddresses(address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath)` · `CreateOrderNumbers(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime)` |
| Others | `UpdateOrder(address account,UpdateOrderParams params,bytes32 relayParams,bytes32 subaccountApproval)` · `CancelOrder(address account,bytes32 key,bytes32 relayParams,bytes32 subaccountApproval)` · `Batch(address account,CreateOrderParams[] createOrderParamsList,UpdateOrderParams[] updateOrderParamsList,bytes32[] cancelOrderKeys,bytes32 relayParams,bytes32 subaccountApproval)` · `CreateTwapOrder(address account,CreateOrderParams params,uint256 twapCount,uint256 interval,bytes32 relayParams,bytes32 subaccountApproval)` · `RemoveSubaccount(address subaccount,bytes32 relayParams)` |
| `relayParams` | `keccak256(abi.encode(oracleParams, externalCalls, tokenPermits, fee, userNonce, deadline, desChainId))` |
| Ledger fallback | `Minified(bytes32 digest)` — "for some cases, e.g. ledger, signing does not work because the payload is too large" |
| Signer | main account on `GelatoRelayRouter`; **subaccount** on `SubaccountGelatoRelayRouter` (`account` field = main account). EOA ECDSA, ERC-1271 and EIP-6492 are accepted (docs). |

`RelayParams`: `oracleParams` (only for a fee swap through GMX pools), `externalCalls`, `tokenPermits` (EIP-2612, spender must be
`Router`), `fee {feeToken, feeAmount, feeSwapPath}`, `userNonce` ("interface generates a random nonce"), `deadline`, `signature`,
`desChainId` (must equal `block.chainid`).

**Replay protection.** No sequential nonce for orders: the digest is stored (`digests[digest] = true`, `InvalidUserDigest` on
reuse) and `deadline` bounds validity (`DeadlinePassed`). "Once a transaction is signed and sent to a relay, it cannot be
canceled. The user must wait for the expiresAt to pass." SDK default order deadline: 1 hour.

**`SubaccountApproval`** (signed by the **main** account, attached to a subaccount call; empty signature ⇒ use on-chain state):

```solidity
struct SubaccountApproval {
    address subaccount; bool shouldAdd; uint256 expiresAt; uint256 maxAllowedCount; bytes32 actionType;
    uint256 nonce; // for replay attack protection
    uint256 desChainId; uint256 deadline; bytes32 integrationId; bytes signature;
}
```

Type string: `SubaccountApproval(address subaccount,bool shouldAdd,uint256 expiresAt,uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,uint256 deadline,bytes32 integrationId)`.
Checks: `subaccount != 0`, `desChainId == block.chainid`, `block.timestamp <= deadline`, `nonce ==
subaccountApprovalNonces[account]` on that router (then incremented). Effect: sets max count if `> 0`, sets expiry if `> 0`,
adds the subaccount if `shouldAdd`. Defaults: UI "a session lasts 30 days or 400 actions"; SDK constants
`DEFAULT_SUBACCOUNT_EXPIRY_DURATION` 7 days, `DEFAULT_SUBACCOUNT_MAX_ALLOWED_COUNT` 90. The UI derives its browser key from the
signed message "Generate a GMX 1CT (One-Click Trading) session. Only sign this message on a trusted website." — irrelevant here:
the subaccount is just an address, any derived key works ("independently generated subaccount signers" are supported through
`subaccountAddress` and `subaccountApproval`).

**Fees in express mode.** "Relay fees are paid from the main account, not the relayer." The router pulls `fee.feeAmount` of
`fee.feeToken` from the account through `Router` (WNT directly, or another token swapped to WNT via `feeSwapPath`), forwards
`executionFee` to `OrderVault`, pays the relay fee, and "residual fee is sent back to the account". Sponsored-call relay fee =
`(GELATO_RELAY_FEE_BASE_AMOUNT + calldata gas + gas used) × tx.gasprice` (+ L1 fee on Arbitrum) `× GELATO_RELAY_FEE_MULTIPLIER_FACTOR`.
Gas payment tokens: "USDC, USDT, or WETH on Arbitrum; USDC, USDT, or WAVAX on Avalanche; USDM or WETH on MegaETH" (SDK list adds
USDG on Arbitrum). The interface adds a 10 % execution-fee buffer in express mode (`EXPRESS_EXTRA_EXECUTION_FEE_BUFFER_BPS = 1000`).

**HTTP path.** GMX API `POST /orders/txns/prepare` (returns `payloadType: "typed-data" | "transaction"`, `requestId`, `expiresAt`,
`estimates`) → sign → `POST /orders/txns/submit` (`requestId`, `signature`, `eip712Data`, `from`) → `POST /orders/txns/status`.
Subaccounts: `POST /subaccounts/approval/prepare` (returns `domain`, `types`, `primaryType`, `message`, `nonce`,
`relayRouterAddress`), `POST /subaccounts/status` (`active`, `maxAllowedCount`, `currentActionsCount`, `remainingActions`,
`expiresAt`, `approvalNonce`, `multichainApprovalNonce`, `integrationId`). "The peers don't share order-transaction records. Keep
an express order's prepare, submit, and status calls on the peer that served prepare".

**GMX Account (multichain).** "Your GMX Account balance lives on Arbitrum"; deposits bridge through Stargate, messages through
LayerZero; "Bridging … is limited by Stargate liquidity caps". Orders go through `MultichainOrderRouter` /
`MultichainSubaccountRouter`, which "take both `account` and `srcChainId`"; token permits are not allowed
(`TokenPermitsNotAllowedForMultichain`); funds move with `MultichainTransferRouter` (`bridgeIn`, `bridgeOut`, `transferOut`).
"GMX Account flows require Express Trading." "These are two ways to provide funds for positions, not two separate position
accounts." Not needed for a wallet that already holds funds on Arbitrum.

## 7. Fees, funding, liquidation

| Fee | Rule | Source |
|---|---|---|
| Open / close | "0.04% or 0.06% of the position size. It applies when opening, closing, increasing, or partially decreasing"; 0.04 % if the trade reduces the long/short OI gap, 0.06 % if it widens it. TradFi markets differ. | trading/fees |
| Swap (standard pool) | 0.05 % balance-improving / 0.07 % otherwise, on input amount; stable pools 0–0.02 %; single-token pool: no swap fee in its own token | trading/fees |
| Price impact | §2.4; on close only, capped | trading/fees |
| Borrow | only "the side with the larger open interest pays"; accrues per second, settled on position change; `borrowingFeeUsd = positionSizeUsd × (cumulativeBorrowingFactor − positionBorrowingFactor)`. Kink model: `base × usage`, plus `(aboveOptimal − base) × (usage − optimal) / (1 − optimal)` above optimal. "Optimal utilization: 75%; Base factor: 45–55% per year … Rate at 100% utilization: 100–130% per year"; many markets linear without kink. 63 % to the pool, 37 % to the protocol. | trading/fees |
| Funding | below | trading/fees, README |
| Network (execution) fee | §1; refunded excess | trading/fees |
| Relay fee | express only, §6 | contracts/fees |
| UI fee | `uiFeeFactor` of the `uiFeeReceiver`, ≤ `MAX_UI_FEE_FACTOR`, % of size change; snapshotted at creation | contracts/fees |
| Referral | trader discount 5 % or 10 % of open/close fees (tiers); automatic 5 % at $50M and 10 % at $250M lifetime volume on Arbitrum; not on borrow or funding | referrals |
| Liquidation | "0.20% of position size" standard, 0.30 % single-token and synthetic, 0.45 % high-volatility; "not factored into the protocol's liquidatability check" | trading/liquidations |

**Funding (adaptive).** Continuous, no funding interval: "Funding fees accrue continuously using per-second arithmetic …
Settlement is event-driven, not scheduled."
- State: signed `savedFundingFactorPerSecond` per market; "A positive value means longs pay shorts".
- `longShortImbalance = [abs(longOI − shortOI) / totalOI] ^ fundingExponentFactor`.
- Above `thresholdForStableFunding`: rate rises by `longShortImbalance × fundingIncreaseFactorPerSecond` per second (floor
  `minFundingIncreaseRatePerSecond`); between thresholds: constant; below `thresholdForDecreaseFunding`: falls by
  `fundingDecreaseFactorPerSecond` per second; skew reversal: starts moving the other way immediately.
- Bounds per market and paying side: `minFundingFactorPerSecond`, `maxFundingFactorPerSecond`. On Arbitrum a keeper resets the
  ceiling from external venues (Hyperliquid, Coinbase, Binance, OKX, Bybit, Trade.xyz): floor 15 % APR, cap 300 % APR.
- Paying side: `fundingUsd = sizeOfPayingSide × durationInSeconds × fundingFactorPerSecond`; receiving side scaled by
  `payingOI / receivingOI`. Per position: `sizeInUsd × (latestFundingAmountPerSize − position.fundingFeeAmountPerSize)`.
- Positive funding is **not** auto-credited: "Positive funding fees need to be manually claimed using the
  ExchangeRouter.claimFundingFees function" (max 20 entries per UI claim).
- APR = per-second factor × 31,536,000.

**Mark / oracle.** Index price = signed oracle `minPrice` / `maxPrice`. "The mark price is the midpoint of the oracle spread:
`(minPrice + maxPrice) / 2`", used for display, "Funding rate calculations" and price impact; "It is not used for order
triggering or execution." There is no order-book mark, no premium index.

**Liquidation** (`PositionUtils.isPositionLiquidatable`):
`remainingCollateralUsd = collateralAmount × collateralPrice.min + positionPnlUsd + min(0, priceImpactUsd capped by
MAX_POSITION_IMPACT_FACTOR_FOR_LIQUIDATIONS) − (position fee + borrow + funding + UI fee, in collateral)`. Liquidatable when
`remainingCollateralUsd < MIN_COLLATERAL_USD`, or `<= 0`, or `< sizeInUsd × minCollateralFactorForLiquidation`. PnL uses
`minPrice` for longs and `maxPrice` for shorts. Threshold "ranges from 0.25% to 1% of position size". Executed by keepers
(order type `Liquidation`); "any remaining collateral after deducting losses and fees is returned to your wallet". Before
liquidating, keepers try the position's `StopLossDecrease` then `LimitIncrease` orders — "best-effort execution, not a
guarantee". The liquidation price drifts with borrow and funding accrual.

**ADL.** Triggered "when the ratio of pending PnL to pool value exceeds the market's configured `MAX_PNL_FACTOR_FOR_ADL`
threshold"; "profitable positions may be partially or fully closed". Trader PnL is also capped by `MAX_PNL_FACTOR_FOR_TRADERS`.

## 8. Read endpoints

### 8.1 Oracle API (stable, read-only) — `https://{arbitrum|avalanche}-api.gmxinfra.io`

Fallbacks: `https://arbitrum-api-fallback.gmxinfra.io`, `https://arbitrum-api-fallback.gmxinfra2.io` (same pattern for
Avalanche). MegaETH host appears only in the SDK config (`https://megaeth-api.gmxinfra.io`), not on the docs pages.

| Path | Returns | Units / notes |
|---|---|---|
| `/ping` | documented `{"ok":true}`; **live answer on 2026-11-10 was `{"message":"ok"}`** | 500 `{"errors":["db is unavailable"]}` — test the HTTP status, not the body |
| `/prices/tickers` | array of `{tokenAddress, tokenSymbol, minPrice, maxPrice, updatedAt, …}` | prices are contract-format strings: USD = `price / 10^(30 − tokenDecimals)`. **Live shape on 2026-11-10** had `updatedAt` in ms and `timestamp` in s and no `medianPrice` / `oracleDecimals`, unlike the documented sample. Cache 0.3 s. |
| `/signed_prices/latest` | `{signedPrices:[{tokenSymbol, tokenAddress, minPrice, maxPrice, medianPrice, oracleDecimals, signer, signature, signatureWithoutBlockHash, tokenOracleType, salt, minBlockNumber, minBlockTimestamp, minBlockHash, maxBlockNumber, maxBlockTimestamp, maxBlockHash, createdAt}]}` | documented shape; cache 1 s; not fetched live |
| `/prices/candles?tokenSymbol=&period=&limit=` | `{period, candles:[[timestamp, open, high, low, close], …]}` | `period` ∈ 1m, 5m, 15m, 1h, 4h, 1d; newest first; timestamp unix s; prices plain USD floats; `limit` 1–10000 (default 1000). High = highest `maxPrice`, low = lowest `minPrice`, close = mid. |
| `/tokens` | `{tokens:[{symbol, address, decimals, synthetic?}]}` | |
| `/markets` | `{markets:[{name, marketToken, indexToken, longToken, shortToken, isListed, listingDate}]}` | cache 10 s |
| `/markets/info` | adds `openInterestLong/Short`, `availableLiquidityLong/Short` (USD ×1e30), `poolAmountLong/Short` (token units), `fundingRateLong/Short`, `borrowingRateLong/Short`, `netRateLong/Short` | cache 10 s; "near-live snapshot, not … same-block state". Rate scaling is not documented: the live BTC value equals the per-second factor × 31,536,000 × 1e30 (annualised), sign negative = receives — inferred, verify before use. |
| `/markets/state`, `/markets/tickers`, `/rates`, `/apy`, `/performance/annualized`, `/glvs/`, `/glvs/info` | status, filtered tickers, hourly funding snapshots, liquidity-side data | `/rates` "is not realtime data" |

### 8.2 GMX API ("Expanding") — `https://{arbitrum|avalanche|megaeth}.gmxapi.io/v1` and `.ai/v1` (equal peers)

Spec: `https://arbitrum.gmxapi.io/swagger.json` (`@gmx-io/gmx-public-api` 1.0.0, 57 operations). Read paths useful to an adapter:

| Path | Notes |
|---|---|
| `GET /markets` | catalog + `leverageTiers[{maxLeverage, minCollateralFactor}]`, `minPositionSizeUsd`, `minCollateralUsd` (USD ×1e30). `maxLeverage` "2000000" for BTC/ETH = 200× if scaled by 1e4 (scaling inferred). Cache 60 s. |
| `GET /markets/info`, `/markets/config`, `/markets/values` | full per-market config and state: `minCollateralFactor`, `minCollateralFactorForLiquidation`, `minCollateralFactorForOpenInterestLong/Short`, `positionFeeFactorForBalanceWasImproved/NotImproved`, `maxPositionImpactFactorPositive/Negative`, `fundingFactorPerSecond`, `longsPayShorts`, `borrowingFactorPerSecondForLongs/Shorts`, OI, pool amounts… all factors ×1e30 |
| `GET /markets/tickers?addresses=&symbols=` | `minPrice`, `maxPrice`, `markPrice` (USD ×1e30 — **not** contract format), 24 h stats, OI, hourly-looking rates, `capacityLong/Short` |
| `GET /prices/tickers`, `GET /prices/ohlcv?symbol=&timeframe=&limit=&since=` | "Prices are USD with 30 decimals"; `originTs` ms |
| `GET /positions?address=&includeRelatedOrders=`, `GET /positions/{key}` | `key`, `contractKey`, `account`, `marketAddress`, `collateralTokenAddress`, `isLong`, `sizeInUsd`, `sizeInTokens`, `collateralAmount`, `entryPrice`, `markPrice`, `liquidationPrice`, `leverage`, `pnl`, `pnlAfterFees`, `netValue`, `pendingBorrowingFeesUsd`, `pendingFundingFeesUsd`, `pendingClaimableFundingFeesUsd`, `closingFeeUsd`, `pendingImpactAmount`, `positionValueInUsd`, `increasedAtTime`, `decreasedAtTime`, `relatedOrders`. Decimal strings; 1 s cache; one block for the whole list. |
| `GET /orders?address=`, `GET /orders/{key}` | the stored order fields of §2.2 plus `isFrozen`, `updatedAtTime`, `srcChainId`, `uiFeeFactor`, `requestId`; `orderType` and `decreasePositionSwapType` as enum numbers |
| `GET /trades?address=&symbol=&marketAddress=&since=&until=&actions=&limit=&cursor=`, `POST /trades/search` | trade history |
| `GET /rates?period=&averageBy=&address=` | funding/borrow history |
| `GET /allowances?address=&spender=`, `GET /balances/wallet?address=`, `GET /tokens`, `GET /tokens/info` | wallet-side reads |
| `GET /pairs` | listing feed: USD as plain numbers, `funding_rate` "is the paying side's rate in percent per hour, positive when longs pay, with `funding_interval_minutes` set to `60`" (a display convention — accrual is per second) |
| write-side (not used by a read adapter) | `POST /orders/txns/{prepare,submit,status}`, `/orders/txns/{edit,cancel,collateral}/prepare`, `/subaccounts/approval/prepare`, `/subaccounts/status`, `/relay/{submit,status}` (`.io` only), `/gmx-account/…` |

### 8.3 GraphQL (Subsquid)

`https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql` (also `-avalanche`, `-megaeth`). Entities used for history:
`tradeActions` (`eventName`, `orderType`, `orderKey`, `account`, `sizeDeltaUsd`, `collateralDeltaAmount`, `pnlUsd`,
`fundingFeeReceivedUsd`, `timestamp`, `transactionHash`, `positionLifecycleId`), `Order`, `PositionLifecycle` (id = position
key), `PositionFeesEntity`. USD fields ×1e30. Schema changes are logged on the docs page (latest 2026-10-23).

### 8.4 Limits and terms

- **Rate limits: no figure is published.** The spec declares `429 Too Many Requests` on `/orders/txns/prepare`, `/relay/submit`,
  `/relay/status`; the guide says "If you receive a timeout, network error, `429`, or `5xx`, retry with backoff and fail over";
  "These docs do not publish a public SLA."
- **Geo / eligibility** (Terms, "Last modified: August 20th, 2026"), representations required to use gmx.io and app.gmx.io:
  "1.1.3. You are not a U.S. Person"; "1.1.4. You are not a resident, national, or agent of any country to which the United
  States, the United Kingdom, or the European Union embargoes goods or imposes similar sanctions (collectively, 'Restricted
  Territories')"; "1.1.7. You do not, and will not, use VPN software or any other privacy or anonymization tools or techniques
  … to circumvent … any restrictions that apply". The Terms also state "no U.S. Person may enter into Perpetual Contracts".
  No country other than the U.S. and sanctioned territories is named in the passages read (Canada is not mentioned by name);
  clause 1.1.8 additionally requires that access not violate any law applicable to the user. The Terms govern the Site and
  Interface; the contracts are permissionless.

## 9. BTC/USD and ETH/USD on Arbitrum

Market list and tokens: Oracle API `/markets` + `/tokens`; parameters: GMX API `GET /v1/markets/info` and `/v1/markets`; all
read 2026-11-10. Values are a snapshot of on-chain configuration and change without notice.

| | BTC/USD [WBTC.b-USDC] | ETH/USD [WETH-USDC] |
|---|---|---|
| Market token | `0x47c031236e19d024b42f8AE6780E44A573170703` | `0x70d95587d40A2caf56bd97485aB3Eec10Bee6336` |
| Index token | BTC `0x47904963fc8b2340414262125aF798B9655E58Cd` (8 dec., flagged synthetic in `/tokens`) | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` (18 dec.) |
| Long collateral | WBTC.b `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` (8 dec.) | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| Short collateral | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (6 dec.) | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `minCollateralFactor` / for liquidation | 0.5 % / 0.5 % | 0.5 % / 0.5 % |
| Max leverage, contract bound | 200× (`1 / 0.005`; API `maxLeverage` "2000000") | 200× |
| OI multiplier | 6e-11 per USD of side OI ⇒ binds only above ≈ $83.3M of OI (0.005 / 6e-11); at the $138.6M cap ≈ 120× | same multiplier; cap $86.8M ⇒ ≈ 192× at the cap |
| Max leverage, interface | lower than the bound by the documented rule ("at least twice the liquidation threshold … rounds down to a 5x increment") ⇒ 100× by arithmetic; the figure itself is not quoted in the docs | same |
| Position fee | 0.04 % balance-improving / 0.06 % otherwise | same |
| Swap fee through the pool | 0.05 % / 0.07 % | same |
| Price impact caps | +0.40 % / −0.50 % | same |
| Max OI per side | $138,581,000 | $86,758,000 |
| Min position / min collateral | $1 / $1 | $1 / $1 |
| Price format | `usd × 10^22` | `usd × 10^12` |
| Snapshot funding | longs pay, 4.479e-9 /s ≈ 14.1 % APR (floor 1 %, ceiling 20.2 % APR) | longs pay, 3.194e-9 /s ≈ 10.1 % APR (ceiling 15.9 % APR) |
| Snapshot borrow | shorts 1.628e-9 /s ≈ 5.1 % APR, longs 0 | shorts 2.266e-9 /s ≈ 7.1 % APR, longs 0 |
| Liquidation fee | 0.20 % or 0.30 % of size per the docs' market-type table — the per-market `LIQUIDATION_FEE_FACTOR` was not read | idem |

Other BTC/ETH markets listed the same day (same 0.5 % factors and 0.04/0.06 % fees): BTC/USD [WBTC.b-WBTC.b]
`0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77`, BTC/USD [tBTC-tBTC] `0xd62068697bCc92AF253225676D618B0C9f17C663`, BTC/USD
[USDG-USDG] `0xe57B97F2f83F39E74Ec83f3e039FD370884784fF`, ETH/USD [WETH-WETH] `0x450bb6774Dd8a756274E0ab4107953259d2ac541`,
ETH/USD [wstETH-USDe] `0x0Cf1fb4d1FF67A3D8Ca92c9d6643F8F9be8e03E5`, ETH/USD [USDG-USDG]
`0x6f095F58e9Eb2c583A1828202712c03962491d7e` (USDG `0x004B506865409877C9fA29bfb1ebA929984B9bbC`, 6 dec.).

## Verified / Not verified

**Verified (source read on 2026-11-10)**
- Two-step model, try/catch outcomes, freeze vs cancel, oracle timestamp bounds, cancellation delay — contract source (`updates`) + docs.
- `CreateOrderParams` field list, `OrderType` and `DecreasePositionSwapType` enums — `IBaseOrderUtils.sol`, `Order.sol` (identical on `main` and `updates` except `uiFeeFactor` in the stored order).
- TWAP = `createTwapOrder` producing time-gated limit orders — docs + `updates` source.
- Subaccount restrictions (`validateCreateOrderParams`, action count, expiry, no external calls, fee-swap cap) — source; summary table of can/cannot — source + docs + README ("Subaccounts can create, update, and cancel any order for an account", "Subaccounts can spend wnt and collateral from the account").
- EIP-712 domain and type strings, `SubaccountApproval` struct, digest replay protection — `RelayUtils.sol`, `SubaccountUtils.sol`, `BaseGelatoRelayRouter.sol`, `SubaccountRouterUtils.sol`.
- Addresses — docs table; cross-checked equal with `contracts.ts` (`release`) for every name present in both.
- Live chains, GMX Account scope, GMX Relay replacing Gelato — docs.
- Fees, adaptive funding, borrow models, liquidation rule, liquidation fee table, ADL — docs + `PositionUtils.sol`.
- Endpoint list and response field names — docs + swagger; `/markets`, `/markets/info`, `/prices/tickers`, `/tokens`, `/ping`, `/v1/markets`, `/v1/markets/info`, `/v1/markets/tickers` fetched live.
- BTC/ETH market addresses and parameters — live API snapshot.
- Terms clauses — page source in the interface repository.

**Not verified**
- That each deployed address runs the `updates@bf30ebb` code (no explorer check); `main` is a different code line.
- On-chain values not exposed by the API: `REQUEST_EXPIRATION_TIME` (docs say 300 s), `MAX_UI_FEE_FACTOR`, `MAX_CALLBACK_GAS_LIMIT`, `MAX_RELAY_FEE_SWAP_USD_FOR_SUBACCOUNT`, `MAX_EXECUTION_FEE_MULTIPLIER_FACTOR`, `GELATO_RELAY_FEE_*`, execution gas-limit keys, per-market `LIQUIDATION_FEE_FACTOR`, `MAX_AUTO_CANCEL_ORDERS`, borrow-model keys for BTC/ETH.
- Whether order actions through the legacy `SubaccountRouter` are still enabled (`subaccountFeatureDisabledKey`), and whether the same flag is clear for `SubaccountGelatoRelayRouter`.
- Whether GMX Relay / the GMX API accepts orders signed by an arbitrary externally generated subaccount from a non-interface client without further gating, and whether self-submitting a `SubaccountGelatoRelayRouter` call from one's own EOA is practical (the code has no caller restriction; the relay fee is still charged to the account).
- Scaling of `fundingRate*` / `borrowingRate*` in Oracle `/markets/info` and of `maxLeverage` in `/v1/markets` (inferred from one data point each).
- `/signed_prices/latest`, `/prices/candles`, `/positions`, `/orders`, GraphQL: shapes taken from docs/spec, not fetched live. The live `/prices/tickers` shape already differs from the documented sample.
- Numeric rate limits (none published). The public URL route of the Terms page, and any geo-blocking performed by the interface itself.
- The 100× interface leverage for BTC/ETH (derived from the documented rule, not quoted).
- The exact relay fee charged per order in USD and typical execution fee in wei (never estimated here).
- Liquidation-fee bucket of BTC/USD [WBTC.b-USDC] (its index token is flagged synthetic by `/tokens`, but the pool is BTC-backed).

## Proposal: authorising trading with a key that cannot withdraw

GMX offers the restriction; the proposal below uses only contract features read in source.

**Keys.** Main EVM key `M` (existing wallet account on Arbitrum) holds the collateral and never signs an order. Trading key `T`
= a dedicated derivation branch of the same seed on the isolated signer, used for GMX only, one per chain. `T` holds no funds
and needs no ETH in the relay path.

**What the owner signs once with `M`** (on-chain, Classic transactions, each shown in full on the signer):
1. `ERC20.approve(Router, cap)` for the single collateral token to be traded (USDC), with a **finite** `cap` equal to the
   trading budget — never the interface's unlimited approval or its unlimited non-expiring permits. This allowance is the hard
   ceiling on what `T` can ever move, because every subaccount pull goes through `Router.pluginTransfer`.
2. A finite WETH allowance to `Router` (execution + relay fees are pulled in WNT), or accept a fee-token swap from USDC, which
   the contracts cap for subaccounts.
3. `SubaccountRouter.multicall([addSubaccount(T), setMaxAllowedSubaccountActionCount(T, SUBACCOUNT_ORDER_ACTION, current + N),
   setSubaccountExpiresAt(T, SUBACCOUNT_ORDER_ACTION, now + D)])` with small `N` and short `D` (e.g. tens of actions, days).
   Alternative with no gas: sign one `SubaccountApproval` typed message (`shouldAdd = true`, `expiresAt`, `maxAllowedCount`,
   `nonce`, `desChainId = 42161`, `deadline`, `integrationId = 0`) under the `GmxBaseGelatoRelayRouter` domain with
   `verifyingContract = SubaccountGelatoRelayRouter`; it is consumed with `T`'s first order.
4. Optional but recommended: set `M`'s own referral code first so that `T` cannot plant one.

**What `T` signs per trade.** A `CreateOrder` / `UpdateOrder` / `CancelOrder` / `Batch` typed message for
`SubaccountGelatoRelayRouter` (`account = M`, `receiver = M`, `cancellationReceiver = 0 or M`, `callbackContract = 0`,
`uiFeeReceiver = 0`, `externalCalls` empty, short `deadline`, fresh random `userNonce`). The signer must refuse anything else:
it should decode the typed data itself and enforce receiver, market allow-list (BTC/USD, ETH/USD), maximum `sizeDeltaUsd`, a
bounded `acceptablePrice` relative to its own oracle read, `minOutputAmount > 0` on swaps, and a per-day action budget below
the on-chain one. These signer-side rules are what turn "cannot withdraw" into "cannot lose more than X".

**Revocation.** `SubaccountRouter.removeSubaccount(T)` from `M` (the interface itself uses this), effective in the same block;
or zero the action count / expiry; then `approve(Router, 0)` on each token and cancel `T`'s pending orders with
`ExchangeRouter.cancelOrder`. Already-signed but unsent messages die with the subaccount (validation happens at submission) and
at their `deadline`; a message already in the relay "cannot be canceled". Expiry and the action cap revoke by themselves.

**What `T` can still do that costs money** (§5): burn fees on up to `N` actions, open/close/flip positions at poor prices up to
the `Router` allowance, cancel the owner's stop-losses, route a UI fee or a callback refund to a third party, and take
liquidation risk — never send funds to an address other than `M`. Keep idle funds outside the allowance and keep `N`, `D` and
the allowance small; re-authorise deliberately.

**Open points before building** (all in "Not verified"): confirm on-chain that the subaccount feature flag is clear for the
router used; confirm the submission path (GMX API `/orders/txns/*` with `subaccountAddress` + `subaccountApproval`, or
self-submission); read `MAX_UI_FEE_FACTOR` and the subaccount fee-swap cap; pin the deployed bytecode to a source commit.

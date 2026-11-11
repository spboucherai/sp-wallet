# dYdX v4 (dYdX Chain) — venue dossier

Checked against the official documentation, the official source repositories, the live mainnet/testnet indexers and the live chain
state on **2026-11-10** (2026-11-11 UTC). Adapter: `packages/derivatives/src/venues/dydx/` — **read side only**
(`capabilities.orders = false`). Nothing was signed or sent on any network: every call was a public `GET` or a websocket subscription.

**Two things the owner must read first**

1. **Jurisdiction.** The dYdX software terms state that perpetuals trading "IS NOT AVAILABLE TO … ANY JURISDICTION … INCLUDING WITHOUT
   LIMITATION THE UNITED STATES OF AMERICA, CANADA AND THE UNITED KINGDOM" and prohibit VPN circumvention
   (https://dydx.exchange/v4-terms, quoted in full in the trading model below). This is a go / no-go decision that precedes anything technical.
2. **The block is enforced on the data path too.** From the location where this was built, the mainnet indexer answered every
   *account* endpoint (`/addresses/…`, `/orders`, `/fills`, `/perpetualPositions`, `/fundingPayments`, `/assetPositions`) with
   **HTTP 403** `{"errors":[{"code":"GEOBLOCKED", …}]}`. Public market data (markets, book, trades, candles, funding) is served
   normally. The adapter reports the refusal as `VenueError('rejected')` with the venue's reason and **does not work around it**
   (no proxy, no alternative node as a substitute). Account shapes were therefore verified on **testnet**, which is not blocked.
   Two facts are recorded here without being used: the same account state is public chain data readable from any validator REST
   node, and the mainnet *websocket* accepted a `v4_subaccounts` subscription from the same location. Whether to read mainnet
   accounts through either path is part of the same owner decision, not an engineering choice.

Part A describes the read adapter as delivered. Part B is the trading model dossier (no trading code is wired).

---

# Part A — Read side (delivered)

## Endpoints used (pinned in `adapter.ts`)

| | Mainnet | Testnet |
|---|---|---|
| Indexer REST | `https://indexer.dydx.trade/v4` | `https://indexer.v4testnet.dydx.exchange/v4` |
| Indexer websocket | `wss://indexer.dydx.trade/v4/ws` | `wss://indexer.v4testnet.dydx.exchange/v4/ws` |
| Chain id (not used by the read side) | `dydx-mainnet-1` | `dydx-testnet-4` |

Sources: https://docs.dydx.xyz/interaction/endpoints , https://docs.dydx.xyz/indexer-client/http , https://docs.dydx.xyz/indexer-client/websockets .
The indexer is a read replica of the chain run by the operator: it can lag (`height()` reports the last processed block) and its
"best effort" order states are not final. Documented limit: 100 requests per 10 s per IP (HTTP 429 → `rate_limited`).

## `VenueAdapter` method → request → mapping

| Method | Request | Notes |
|---|---|---|
| `instruments()` | `GET /perpetualMarkets` | 296 markets on the check date: 57 `ACTIVE`, 239 `FINAL_SETTLEMENT`; 116 cross, 180 isolated |
| `tickers()` | `GET /perpetualMarkets` | mark = index = `oraclePrice`; `funding` = `nextFundingRate` (estimate of the next **hourly** rate); `openInterest` (base units, one side); `volume24h` = `volume24H` (USD); `change24h` = `priceChange24H ÷ (oraclePrice − priceChange24H)` at 8 decimals, half-even; `mid` null |
| `book(symbol, depth)` | `GET /orderbooks/perpetualMarket/{ticker}` | real book, 100 levels per side served; re-sorted best first; default depth 50 |
| `trades(symbol, limit)` | `GET /trades/perpetualMarket/{ticker}?limit=` | newest first |
| `candles(symbol, interval, …)` | `GET /candles/perpetualMarkets/{ticker}?resolution=&limit=&fromISO=&toISO=` | `1m…1d` → `1MIN, 5MINS, 15MINS, 1HOUR, 4HOURS, 1DAY`; volume = `baseTokenVolume`; returned oldest first |
| `fundingHistory(symbol, {start, end})` | `GET /historicalFunding/{ticker}?effectiveBeforeOrAt=&limit=1000`, paged backwards (≤ 25 pages) | the hourly rate actually applied; `premium` null (not published) |
| `account(a)` | `GET /addresses/{address}/subaccountNumber/{n}` | `equity`, `freeCollateral` as reported; `collateral` = USDC asset position; `marginUsed` = equity − free (exact); `maintenanceMargin`, `withdrawable` null |
| `positions(a)` | same + `GET /perpetualMarkets` | see "derived fields" |
| `openOrders(a)` | `GET /orders?address=&subaccountNumber=&status=OPEN,UNTRIGGERED,BEST_EFFORT_OPENED` | |
| `orderHistory(a)` | `GET /orders?…&returnLatestOrders=true&limit=` | |
| `fills(a)` | `GET /fills?address=&subaccountNumber=&limit=` | `fee` in USDC (negative = maker rebate); `liquidation` = fill type `LIQUIDATED` or `DELEVERAGED` |
| `funding(a)` | `GET /fundingPayments?address=&subaccountNumber=&limit=1000` | venue sign kept: positive `amount` = received |
| `subaccounts(address)` (extra) | `GET /addresses/{address}` | every subaccount number that exists |
| `height()` (extra) | `GET /height` | indexer lag |
| `stream(sub)` | websocket | see below |

**Account identifier**: `dydx1…` or `dydx1…/<subaccountNumber>` (default 0, range 0–128 000). Subaccounts ≥ 128 are the
front-end's isolated-margin children of subaccount `n mod 128`; they are read one at a time (`marginMode: 'isolated'`).

**Instrument fields**

| Field | Source |
|---|---|
| `tickSize`, `lotSize` | indexer `tickSize` / `stepSize`, **cross-checked** against the protocol parameters: `tick = subticksPerTick × 10^(quantumConversionExponent − 6 − atomicResolution)`, `step = stepBaseQuantums × 10^atomicResolution`. A mismatch is `bad_answer`. The check holds for all 296 markets (test). |
| `minOrderSize` | = step (the protocol minimum is `stepBaseQuantums`); `minNotional` null (none on this venue) |
| `maxLeverage` | `1 / initialMarginFraction` (4 decimals, rounded down). Base fraction: it rises with open interest between `openInterestLowerCap` and `openInterestUpperCap` where those are set (0 for BTC/ETH on the check date) |
| `marginModes` | `CROSS` market → `['cross','isolated']`; `ISOLATED` market → `['isolated']` |
| `fundingIntervalSec` | 3600 |
| `markPriceMethod` | no separate mark price: the oracle price values positions, margin, liquidation and triggers |
| `collateral` / `settlement` | USDC (Noble USDC over IBC); linear, PnL and funding settle in USDC in the subaccount |
| `status` | `ACTIVE` → `active`; every other state (`PAUSED`, `CANCEL_ONLY`, `POST_ONLY`, `INITIALIZING`, `FINAL_SETTLEMENT`) → `halted` |

**Derived fields (computed from venue figures with exact decimals, not reported by the venue)**: `Position.leverage` = notional at the
oracle price ÷ subaccount equity (4 decimals, half-even; `0` with `dydx.leverageDefined = false` when equity ≤ 0); `Position.margin` =
notional × base initial margin fraction; `Position.fundingPaid` = −`netFunding`. `Position.liquidationPrice` is **null**: the indexer
does not publish one and any figure would be an estimate (margin engine's job, labelled as such).

**Orders**: `LIMIT, MARKET, STOP_LIMIT, STOP_MARKET, TAKE_PROFIT (→ take_profit_limit), TAKE_PROFIT_MARKET` map to the contract; any
other type (`TWAP`, `TRAILING_STOP`, …) raises `VenueError('unsupported')` rather than being mislabelled. Status: `OPEN` → `open` or
`partially_filled`; `UNTRIGGERED` → `open`; `FILLED`; `CANCELED` → `cancelled`; `BEST_EFFORT_OPENED`, `BEST_EFFORT_CANCELED`,
`PENDING` → **`pending`** (the indexer's unconfirmed view of a short-term order is never reported as final). `postOnly` → `alo`,
`GTT` → `gtc`, `IOC`/`FOK` → `ioc`. `createdAt` is `0`: the indexer gives the creation block height only. The venue's raw status,
type, time-in-force, order flags (0 short-term, 32 conditional, 64 long-term), good-til-block(-time) and removal reason are kept
under `order.dydx`. `clientId` is the venue's `clientId` (uint32, as a string).

## Exact arithmetic

No venue figure passes through a JS `number`. The indexer prints decimals as strings; they are validated by regex (an exponent or a
JSON number is `bad_answer`) and canonicalised textually. Quantum/subtick conversions (`wire.ts`: `sizeToQuantums`,
`quantumsToSize`, `priceToSubticks`, `subticksToPrice`, `quoteQuantumsToUsdc`) are bigint-only and **refuse** a size or price that is
not on the lot or tick instead of rounding. Formulas, with USDC quote resolution −6
(https://docs.dydx.xyz/concepts/trading/quantums ; `v4-client-js/src/clients/helpers/chain-helpers.ts`):

```
size (base)      = quantums × 10^atomicResolution
price (USD/base) = subticks × 10^(quantumConversionExponent − 6 − atomicResolution)
BTC-USD: atomicResolution −10, quantumConversionExponent −9, stepBaseQuantums 1 000 000, subticksPerTick 100 000
         → 0.0001 BTC = 1 000 000 quantums; 73 650 USD = 7 365 000 000 subticks
```

## Stream (`stream.ts`)

One websocket for all subscriptions (`batched: true`): `book` → `v4_orderbook`, `trades` → `v4_trades`, `ticker` → `v4_markets`
(filtered to the symbol), `account` → `v4_subaccounts` (`address/number`). Injectable `WebSocket` constructor for tests.

- **Gaps.** Each server frame has a per-connection `message_id`. The live recording shows ids **out of order** around
  subscriptions (`0, 4, 1, 3, 5, …`: a slow snapshot arrives after later ids), so order is not enforced. An id still missing 5 s
  after a later one arrived is a gap → `onStatus('stale')` → reconnect and resubscribe (fresh snapshots).
- **Duplicates.** A frame whose id was already seen is dropped; trades are also de-duplicated by trade id across reconnects, so a
  resubscription snapshot only emits trades not delivered before.
- **Silence.** The client pings every 15 s; no frame at all for 40 s → `stale` → reconnect. Reconnect backoff 0.5 s doubling to 30 s.
- **Malformed frame** → treated as a gap (`stale`, reconnect), never ignored. Deltas received before a channel's snapshot are not applied.
- **Book events** carry the top 50 levels of the locally maintained book and a `crossed` flag: the indexer book can be crossed for a
  moment because short-term orders are matched in validator memory (the official docs describe an uncrossing procedure using the
  per-level offsets; it is not implemented — the flag is exposed instead).
- **Account events are triggers, not state.** The snapshot carries the subaccount and its complete open orders. Updates carry
  *partial* order objects whose fields vary with the cause (three different shapes in an 11-frame recording), so only identity,
  venue status, filled amount and removal reason are normalised (`orderUpdates`), plus `hasFills` / `hasPositionChange`. The
  consumer re-reads the account over REST — venue state is the truth.

## Read side — verified / not verified

**Verified live (2026-11-11 03:12 UTC, `npx tsx scripts/smoke-dydx.mts`)**
- 296 perpetuals, 57 active. BTC-USD: tick 1, lot 0.0001, max leverage 50×, cross/isolated. ETH-USD: tick 0.1, lot 0.001, 50×.
- BTC-USD oracle 73 785.83558, hourly funding 0.00001396875, OI 221.6904 BTC, 24 h volume $5 070 959; ETH-USD oracle 2 064.621919,
  OI 4 493.958 ETH, 24 h volume $44 263 641. Book: bid 73 742 / ask 73 771 (spread 29 — a thin book).
- Indexer 1 s behind the local clock. Websocket: clean snapshot on book, trades and ticker, 935 book updates in 8 s, status `connected` only.
- Mainnet account endpoint: refused, `GEOBLOCKED` (expected). Testnet account read (equity, free collateral, 3 positions, fills,
  1000 funding payments) parsed.
- Fixtures (`packages/derivatives/test/fixtures/dydx/`): 17 HTTP answers and 2 websocket recordings; 39 tests.

**Not verified**
- Mainnet account shapes (blocked); assumed identical to testnet, which runs the same indexer code.
- Order types other than those present in the fixtures (`LIMIT`, `STOP_LIMIT`), `LIQUIDATED` / `DELEVERAGED` fills, isolated child
  subaccounts (≥ 128), websocket fill and position update shapes (flags only), parent-subaccount endpoints (not used).
- Behaviour during an indexer outage or a chain halt; the 100 req / 10 s limit was not provoked.
- Pagination of `fills` / `orders` beyond the first page (1000 rows) is not implemented.

---

# Part B — Trading model (documentation only, no code wired)

Checked against the official documentation, the official source repositories and the live mainnet state on **2026-11-10**
(chain time 2026-11-11 02:47 UTC, height 113 332 615). Documentation only: nothing below has been executed — no transaction was
built, signed or broadcast; every network call was a public read (`GET`). Mainnet ran `dydxprotocold` **9.8.2** at the time of the check.

Legend: **[doc]** official documentation, **[src]** official source code, **[live]** value read from mainnet state on the check date.
Where the documentation and the chain disagree, the chain value is given and the discrepancy is listed in "Verified / Not verified".

## Sources
- Documentation (current site): https://docs.dydx.xyz — full text export https://docs.dydx.xyz/llms-full.txt
- Protocol: https://github.com/dydxprotocol/v4-chain — read at `main` `7b8822a` (2026-10-29); two files re-checked at tag
  `protocol/v9.8.2` (stated where it matters)
- Clients: https://github.com/dydxprotocol/v4-clients — read at `main` `f93b89d` (2026-10-29)
- Front-end: https://github.com/dydxprotocol/v4-web (`src/constants/wallets.ts`, `public/configs/v1/env.json`)
- Terms: https://dydx.exchange/v4-terms ("DYDX SOFTWARE TERMS OF USE", "Last updated March 12, 2026")
- Live state: public REST node `https://dydx-rest.publicnode.com` and indexer `https://indexer.dydx.trade/v4`
  (both listed in https://docs.dydx.xyz/interaction/endpoints)

## 1. Account model

| | |
|---|---|
| Key | Cosmos secp256k1; the authenticator path only accepts secp256k1 ("Signature verification only accepts secp256k1 signatures") — [src] `protocol/x/accountplus/authenticator/signature_authenticator.go` |
| Address | bech32, prefix `dydx` — [src] `v4-client-js/src/lib/constants.ts` (`BECH32_PREFIX = 'dydx'`) |
| HD path | `m/44'/118'/0'/0/0` (coin type 118, "Default is The Cosmos Hub path") — [src] https://github.com/dydxprotocol/v4-clients/blob/main/v4-client-js/src/lib/onboarding.ts |
| Chain id | mainnet `dydx-mainnet-1`, testnet `dydx-testnet-4`; native denom `adydx` / `adv4tnt` — [doc] https://docs.dydx.xyz/nodes/network-constants |
| Main account | Holds gas and collateral tokens; "Main accounts cannot trade" — [doc] https://docs.dydx.xyz/concepts/trading/accounts |
| Subaccounts | Identified by `(main account address, integer)`; valid numbers `0 … 128 000` (`MaxSubaccountIdNumber = 128_000`); created automatically on first deposit; "Subaccounts do not require gas (no gas is used for trading)" — [doc] same page, [src] `protocol/x/subaccounts/types/subaccount.go` |

**How the official front-end derives the dYdX key from an EVM wallet.** The EVM wallet signs one EIP-712 message; the signature is
turned into entropy, the entropy into a BIP-39 mnemonic, the mnemonic into the Cosmos key.

```
typed data   primaryType: 'dYdX'
             domain:  { name: "dYdX Chain" }                      (signTypedDataDomainName)
             types:   { dYdX: [{ name: 'action', type: 'string' }] }
             message: { action: "dYdX Chain Onboarding" }          (signTypedDataAction)
derivation   sig (65 bytes) → drop v → keccak256(r ‖ s) = 32-byte entropy
             → entropyToMnemonic (24 words) → seed → m/44'/118'/0'/0/0
```

- Typed data: [src] https://github.com/dydxprotocol/v4-web/blob/main/src/constants/wallets.ts (`getSignTypedData`); the two strings:
  https://github.com/dydxprotocol/v4-web/blob/main/public/configs/v1/env.json (identical for mainnet and `dydx-testnet-4`).
  A Turnkey (social login) variant adds a `salt` string field (`getSignTypedDataForTurnkey`).
- Derivation: [src] `v4-client-js/src/lib/onboarding.ts`, `deriveHDKeyFromEthereumSignature` — "Hash the 'r' and 's' values down to 32
  bytes (256 bits) using Keccak-256".
- Consequence: a front-end account is only as recoverable as the EVM wallet's signature is deterministic, and its secret is a
  *second* mnemonic outside the wallet's own seed. Nothing in the protocol requires this scheme: the chain sees an ordinary
  secp256k1 account. A wallet that already holds a BIP-39 seed can derive a native key at `m/44'/118'/0'/0/n` and never produce
  the EIP-712 signature. The cost is that the address differs from the one the front-end would derive for the same EVM key, so
  the two are not interchangeable.

**Cross vs isolated.** `market_type` is `PERPETUAL_MARKET_TYPE_CROSS` or `PERPETUAL_MARKET_TYPE_ISOLATED`. Isolated markets have
"segregated pools of collateral and their own insurance fund"; a subaccount holding an isolated position cannot open a position in
any other market until it is closed (error code `2005`). — [doc] https://docs.dydx.xyz/concepts/trading/isolated-markets

**Parent / child subaccounts** are a front-end convention, "not enforced at a protocol level":

| | |
|---|---|
| Parent | `0 … 127`, several cross-margined positions |
| Child | `128 … 128 000`, at most one position each; `parent_subaccount_number = child_subaccount_number % 128` |
| Front-end | "currently only parent subaccount 0 is exposed"; isolated positions live in `128, 256, …` |

Source: [doc] https://docs.dydx.xyz/concepts/trading/isolated-positions. Moving margin into a child subaccount is a
`MsgCreateTransfer` (subaccount → subaccount), which matters for section 4.

## 2. Collateral: getting USDC in and out

Collateral is Noble USDC, on dYdX the IBC denom `ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5`.

| | |
|---|---|
| IBC channel | dYdX `channel-0` ↔ Noble `channel-33`, port `transfer`, `STATE_OPEN`; denom trace `transfer/channel-0` / `uusdc` — [live] `/ibc/core/channel/v1/channels/channel-0/ports/transfer`, `/ibc/apps/transfer/v1/denom_traces/8E27…45B5` |
| CCTP path | EVM USDC → (CCTP) → `noble-1` `uusdc` → (IBC) → `dydx-mainnet-1`; the docs show exactly this two-hop route — [doc] https://docs.dydx.xyz/interaction/deposits-withdrawals/skipgo |
| Final hop | `MsgDepositToSubaccount` moves USDC from the main account into a subaccount; `MsgWithdrawFromSubaccount` does the reverse. "Withdrawing from dYdX Chain requires first moving funds from your trading subaccount to your main account before bridging" — [doc] https://docs.dydx.xyz/interaction/deposits-withdrawals/withdrawal, [src] `proto/dydxprotocol/sending/transfer.proto` |

On-ramps the front-end uses (https://docs.dydx.xyz/interaction/deposits-withdrawals/overview):

| Method | Time | Min / max | Fee |
|---|---|---|---|
| Skip Go Fast ("Instant Deposit") | 10–30 s | Ethereum min 50, L2s (Arbitrum, Base, Optimism, Polygon) min 10, max 100 000 USD | "10 bps on the transfer size + source chain fee" (Ethereum ≈ $2.5, L2 $0.01–$0.10) |
| Skip Go (regular, CCTP/Axelar) | 2–30 min | ≈ $0.05 to ≈ $1 000 000 | deposits ≈ $0.02, withdrawals ≈ $0.1–$7, plus source gas |
| Coinbase via Noble | 1–3 min | — | Coinbase fee + IBC $0.1–$0.2 |
| Direct IBC | 15–30 s | — | ≈ $0.1–$0.5 |

- "for deposits > $20, skip go fast is the default option". The Foundation's Free Deposit Program "ends on 31 October 2026. After that
  date, Skip Go Fast deposits pay the standard fees" — so on the check date the 10 bps applies.
- The front-end keeps USDC back for gas: "First time 1.25 USDC will be kept in wallet for gas fees".

**Withdrawal limits** — [doc] https://docs.dydx.xyz/concepts/trading/limits/withdrawal-limits, confirmed [live]
`/dydxprotocol/v4/ratelimit/list_limit_params`:
- Rate limit on Noble USDC: `max(1% of TVL, $1mm)` per hour and `max(10% of TVL, $10mm)` per day (live: `baseline_tvl_ppm` 10 000 / 3 600 s
  and 100 000 / 86 400 s, minimums 1e12 and 1e13 quantums).
- Gating: "All subaccount transfers and withdrawals will be gated for 50 blocks if a negative collateralized subaccount is seen in
  state", and likewise "if a 5+ minute chain outage occurs" ([src] `protocol/x/subaccounts/types/update.go`).

**Gas.** "both USDC and cosmos native dYdX can be used to pay for gas fees. This USDC must be in the main wallet and not another
subaccount" ([doc] https://docs.dydx.xyz/concepts/onboarding-faqs). Validator minimum: `0.025` USDC (ibc denom) or `12500000000`
native per gas unit ([doc] https://docs.dydx.xyz/nodes/running-node/required-node-configs); client defaults `0.025 uusdc` and
`25000000000 adydx` ([src] `v4-client-js/src/clients/modules/post.ts`). **Order messages are free**: any transaction carrying a CLOB
message gets a `FreeInfiniteGasMeter` and skips fee deduction ([src] `protocol/app/ante/gas.go`, `protocol/app/ante.go`
`clobAnteHandle`). Gas is therefore only needed for deposits, withdrawals, transfers and authenticator management.

## 3. Orders

### Short-term vs stateful — [doc] https://docs.dydx.xyz/concepts/trading/orders

| | Short-term | Stateful (long-term, conditional, TWAP) |
|---|---|---|
| `order_flags` | `0` | conditional `32`, long-term `64`, TWAP `128` (`256` = TWAP suborder, internal only) |
| Lives | validator memory, "not stored on-chain unless filled"; lost on network restart | committed to state |
| Expiry | `good_til_block` ≤ height + `ShortBlockWindow` = **40 blocks** ("about 30 seconds") | `good_til_block_time` (unix s) ≤ block time + 95 days |
| Tx shape | "exactly one Cosmos msg" | may batch stateful order messages, plus at most one `MsgCreateTransfer` |
| Replay protection | order kept in state until its GTB | "Cosmos SDK sequence numbers" |
| Matching | in `CheckTx`, on receipt | block N+1 after inclusion in block N |
| Cancel | "handled best-effort … only gossiped" | on-chain `MsgCancelOrder` |

`ShortBlockWindow = 40` is in [src] `protocol/x/clob/types/constants.go` (same at tag `protocol/v9.8.2`), with `MaxMsgBatchCancelBatchSize = 100`
and `StatefulOrderTimeWindow = 95 days`. Not 20 — see discrepancies.

### Identity and replacement
- `OrderId = (subaccount_id, client_id, order_flags, clob_pair_id)`; `client_id` is `fixed32` — [src] `proto/dydxprotocol/clob/order.proto`.
- Short-term replacement: "send a placement with the same order ID **and a larger GTB value**". The docs recommend replacing over
  cancel-then-place, and tight GTBs ("e.g. the current chain height + 3") because "expiry due to GTB is the only guaranteed way for
  an order to become unfillable" — [doc] https://docs.dydx.xyz/concepts/trading/limit-orderbook.
- Stateful replacement is not supported: the keeper carries `TODO(DEC-1238): Support stateful order replacements` and rejects with
  `ErrStatefulOrderAlreadyExists` (3005) — [src] `protocol/x/clob/keeper/orders.go`, `types/errors.go`.

### Fields and restrictions — [src] `proto/dydxprotocol/clob/order.proto`, `protocol/x/clob/types/message_place_order.go`

| | |
|---|---|
| Time in force | `UNSPECIFIED` (0, match then rest), `IOC` (1), `POST_ONLY` (2), `FILL_OR_KILL` (3) **deprecated and rejected**: "Fill-or-kill has been deprecated" |
| Long-term | cannot be IOC (`ErrLongTermOrdersCannotRequireImmediateExecution`) |
| Reduce-only | only with immediate execution: "reduce only orders must be short term IOC orders" (error 9003 "Reduce-only is currently disabled for non-IOC orders") |
| Conditional | `CONDITION_TYPE_STOP_LOSS` (1), `CONDITION_TYPE_TAKE_PROFIT` (2), trigger in `conditional_order_trigger_subticks`; triggered by the **oracle price** |
| TWAP | `duration` 300–86 400 s, `interval` 30–3 600 s and a factor of the duration, `price_tolerance` < 1 000 000 ppm; "release in v9.0" |
| Builder code | optional `builder_code_parameters { builder_address, fee_ppm }`, `fee_ppm` in `(0, 10 000]` (`MaxBuilderCodeFeePpm`) — see section 4 |

### Quantums and subticks
[doc] https://docs.dydx.xyz/concepts/trading/quantums; formulas from [src] `v4-client-js/src/clients/helpers/chain-helpers.ts`:

```
quantums = size  × 10^(−atomicResolution)                              rounded to stepBaseQuantums, min stepBaseQuantums
subticks = price × 10^(atomicResolution − quantumConversionExponent + 6) rounded to subticksPerTick,  min subticksPerTick
step size = stepBaseQuantums × 10^atomicResolution
tick size = subticksPerTick × 10^(quantumConversionExponent − 6 − atomicResolution)
```

(`6` is the USDC atomic resolution, `−6`.) "stepBaseQuantums functions as minimum order size".

### Messages

| Type URL | Signer | Use |
|---|---|---|
| `/dydxprotocol.clob.MsgPlaceOrder` | subaccount owner | place / replace |
| `/dydxprotocol.clob.MsgCancelOrder` | subaccount owner | cancel one order |
| `/dydxprotocol.clob.MsgBatchCancel` | subaccount owner | short-term only, up to 100 cancels, "not atomic" |
| `/dydxprotocol.clob.MsgUpdateLeverage` | subaccount owner | per-market leverage setting |
| `/dydxprotocol.sending.MsgCreateTransfer` | sender subaccount owner | subaccount → **any** subaccount (recipient owner is free) |
| `/dydxprotocol.sending.MsgDepositToSubaccount` | wallet | main account → subaccount |
| `/dydxprotocol.sending.MsgWithdrawFromSubaccount` | subaccount owner | subaccount → **any** wallet address |
| `/dydxprotocol.accountplus.MsgAddAuthenticator` / `MsgRemoveAuthenticator` | account | section 4 |

Sources: [src] `proto/dydxprotocol/clob/tx.proto`, `proto/dydxprotocol/sending/{tx,transfer}.proto`, `v4-client-js/src/clients/constants.ts`.

### Transaction and signing
- Protobuf `TxRaw`, `SIGN_MODE_DIRECT` (the client calls `signDirect`; the authenticator verifies `SignModeTxData.Direct`) — [src]
  `v4-client-js/src/clients/modules/signer.ts`, `signature_authenticator.go`.
- Sign doc: body bytes, auth-info bytes, chain id, account number. Memo ≤ 256 characters ([live] `/cosmos/auth/v1beta1/params`).
- Sequence: short-term order transactions do not increment the sequence — the ante handler only increments when
  `!isShortTerm && !isTimestampNonce` ([src] `protocol/app/ante.go`); the client comment reads "For short term orders, the sequence
  doesn't matter". Stateful orders use it, hence the docs' warning to send them "to the same validator".
- Timestamp nonces: a sequence value ≥ 2^40 is read as a millisecond timestamp, accepted within ±30 s of block time, last 20 kept per
  account ([src] `protocol/x/accountplus/keeper/timestampnonce.go`). This removes sequence ordering for stateful orders.
- Broadcast: to a validator / full-node RPC or gRPC endpoint, or the Order Entry Gateway Service (`oegs.dydx.trade:443`). Client
  default is `BroadcastTxSync` for short-term and `BroadcastTxCommit` for long-term and conditional orders ([src] `post.ts`
  `defaultBroadcastMode`). Public node limits: Polkachu 300 req/min, KingNodes 350 req/min — [doc] https://docs.dydx.xyz/interaction/endpoints.

### Limits — [live] on the check date

| Limit | Value | Source |
|---|---|---|
| Stateful order placements | 50 per 100 blocks, per account | `/dydxprotocol/clob/block_rate` |
| Short-term places + cancels | 4 000 per 5 blocks, per account | same |
| Open stateful orders by net collateral | < $20: 0 · ≥ $20: 10 · ≥ $100: 20 · ≥ $1 000: 40 · ≥ $10 000: 100 · ≥ $50 000: 200 | `/dydxprotocol/clob/equity_tier` |
| Open short-term orders by net collateral | < $20: 0 · ≥ $20: 10 · ≥ $100: 20 · ≥ $1 000: 50 · ≥ $10 000: 200 · ≥ $100 000: 1 000 | same |
| Indexer REST | "100 requests / 10 sec" per IP | [doc] https://docs.dydx.xyz/concepts/trading/limits/rate-limits |
| Indexer WS, per connection | accounts 256, parent accounts 256, candles / markets / orderbook / trades 32 each | same |

"rate limits are applied per account. That is, subaccounts under the same account share the same rate limit."

## 4. Permissioned keys (x/accountplus authenticators)

**They exist on mainnet.** [live] `/dydxprotocol/accountplus/params` → `{"is_smart_account_active": true}`. The module was switched on
by the v8.0 upgrade (`accountplusKeeper.SetActiveState(sdkCtx, true)`, [src] `protocol/app/upgrades/v8.0/upgrade.go`), mainnet block
35 602 000, proposal 200 ([doc] https://docs.dydx.xyz/nodes/resources). The code is derived from Osmosis `x/smart-account`.

| Authenticator | Effect | Config |
|---|---|---|
| `SignatureVerification` | "Enables authentication via a specific key" | 33-byte compressed secp256k1 public key |
| `MessageFilter` | "Restricts authentication to certain message types" | type URLs, comma separated |
| `SubaccountFilter` | "Restricts authentication to certain subaccount constraints" | subaccount numbers, comma separated |
| `ClobPairIdFilter` | "Restricts transactions to specific CLOB pair IDs" | CLOB pair ids, comma separated |
| `AllOf` / `AnyOf` | all / any sub-authenticator must pass; at least 2 children | JSON array of `{type, config}` |

Sources: [doc] https://docs.dydx.xyz/concepts/trading/authenticators, [src] `protocol/x/accountplus/authenticator/*.go`.

- **Add**: `MsgAddAuthenticator { sender, authenticator_type, data }`, `data` ≤ 1 024 bytes. The chain refuses a tree in which some path
  lacks a signature check: "unsafe: authenticator tree does not require signature verification all possible paths". The id is a
  global counter; read it back with `/dydxprotocol.accountplus.Query/GetAuthenticators`.
- **Remove**: `MsgRemoveAuthenticator { sender, id }` — "Authenticators can be removed if they are needed anymore, or if the **trader**
  goes rogue."
- **Select**: the transaction carries a non-critical extension option `/dydxprotocol.accountplus.TxExtension` with
  `selected_authenticators`, one id per message ("Mismatch between the number of selected authenticators and messages" otherwise).
  Its presence routes the transaction to the authenticator flow instead of classic signature verification.
- **Who signs what**: the message still names the owner (`subaccount_id.owner`); the transaction is signed by the trading key, whose
  public key sits in `signer_infos`; the signer data is built from the **owner's** account (account number, sequence) ([src]
  `protocol/x/accountplus/lib/authentication_request.go` `getSignerData`, `v4-client-js` `SubaccountInfo.forPermissionedWallet`).
- **Fee payer** is forced to be the owner ("fee payer must be the first signer"), so the trading key needs no balance; CLOB messages
  are free anyway.
- **Kill switch**: governance can disable the whole flow (`MsgSetActiveState`, "Primarily used for circuit breaking"). The owner key
  keeps working through classic verification.

### Decisive question: trading without withdrawal rights — **yes**

The documentation lists, under "Available Features ✅":

> "Limit withdrawals/transfers entirely" · "Multiple trading keys under same account" · "Trading key separation from withdrawal keys"
> · "Whitelist specific trading pairs" · "Control trading permissions per subaccount"

and its guide builds exactly such a key: "you can create a custom authenticator which allows only the **trader** to place orders"
(https://docs.dydx.xyz/interaction/permissioned-keys). The source confirms the mechanism is a whitelist, not a blacklist:

- `MessageFilter` rejects any type URL outside its list ("message types do not match").
- `SubaccountFilter` and `ClobPairIdFilter` are **fail-closed**: "it only authorizes CLOB messages (MsgPlaceOrder, MsgCancelOrder,
  MsgBatchCancel) … Any other message type is rejected. This prevents a delegated key scoped via AllOf([..., ClobPairIdFilter(...)])
  from being used to authorize unrelated messages." (same text at tag `protocol/v9.8.2`.)

So a key behind `AllOf[SignatureVerification, MessageFilter(place, cancel, batch cancel), SubaccountFilter, ClobPairIdFilter]` cannot
send `MsgWithdrawFromSubaccount`, `MsgCreateTransfer`, `MsgSend`, an IBC transfer, `MsgAddAuthenticator` or `MsgRemoveAuthenticator`.

The official front-end ("More → API Trading Keys") registers this tree ([src]
https://github.com/dydxprotocol/v4-clients/blob/main/v4-client-js/src/lib/trading-key-utils.ts, `getAuthorizeNewTradingKeyArguments`,
"allows place order, cancel order, batch cancel on subaccount 0 only"):

```
AllOf[ SignatureVerification(pubkey),
       AnyOf[ MessageFilter(MsgPlaceOrder), MessageFilter(MsgCancelOrder), MessageFilter(MsgBatchCancel) ],
       SubaccountFilter("0") ]
```

### Documented limits and residual risk

"Current Limitations ❌": "Cannot set maximum position sizes", "No order size restrictions", "No custom leverage limits".

| Risk of a trading-only key | Basis |
|---|---|
| Loses the subaccount's collateral through bad trades, up to 50× on BTC/ETH, plus the 1.5% liquidation penalty | no size or leverage limit |
| Transfers value to a counterparty by trading against an attacker's own orders at bad prices, worst on thin markets | the client source says so itself: "we limit to cross markets to make it slightly harder to drain user funds on low liquidity markets with trading keys" |
| **Pays an arbitrary address up to 1% of each fill** by attaching `builder_code_parameters` to its orders | `fee_ppm` up to `MaxBuilderCodeFeePpm = 10_000`, address free; no authenticator filters order fields. Not mentioned in the permissioned-keys docs |
| Places conditional and TWAP orders that keep executing after the key is revoked, until the owner cancels them | flags are not filterable; stateful orders live up to 95 days |
| Consumes the owner's sequence and the per-account rate limits with stateful orders | sequence and limits are per account |
| Cannot post margin to an isolated child subaccount, nor change leverage | needs `MsgCreateTransfer` / `MsgUpdateLeverage`, both rejected by the filters |

The first three are bounded only by the collateral in the subaccounts the key may touch. That is the lever the owner controls.

## 5. Economics and risk engine

### Fees — [live] `/dydxprotocol/v4/feetiers/perpetual_fee_params`, identical to [doc] https://docs.dydx.xyz/concepts/trading/rewards

| Tier | 30-day volume | Taker (bps) | Maker (bps) |
|---|---|---|---|
| 1 | < $1M | 5.0 | 1.0 |
| 2 | ≥ $1M | 4.5 | 1.0 |
| 3 | ≥ $5M | 4.0 | 0.5 |
| 4 | ≥ $25M | 3.5 | 0 |
| 5 | ≥ $50M | 3.0 | 0 |
| 6 | ≥ $100M | 2.5 | −0.7 |
| 7 | ≥ $200M | 2.5 | −1.1 |

- "Fees are uniform across all markets"; volume is counted "across sub accounts and markets".
- Staking discount on net positive fees, tier 1: 3 000 DYDX → 25%, 20 000 DYDX → 50% ([live] `/dydxprotocol/v4/feetiers/staking_tiers`).
- "traders now earn 50% trading rebates directly after each trade as trading rewards via C factor have been set to 0".
- Fee holidays: the chain has per-market discount periods. **None is in force**: the BTC-USD holiday (`charge_ppm: 0`) ran
  2026-05-01 → 2026-06-30; nothing is set for ETH-USD ([live] `/dydxprotocol/v4/feetiers/market_fee_discount_params`).

### Funding — [doc] https://docs.dydx.xyz/concepts/trading/funding
- Paid every hour, "at the start of the hour".
- `Premium = (Max(0, Impact Bid − Index) − Max(0, Index − Impact Ask)) / Index`.
- Sampling: each proposer submits a `FundingPremiumVote` per block; the median per 1-minute `funding-sample` epoch is a sample; the
  hourly rate is the average of the 60 samples.
- `Funding Rate = (Premium Component / 8) + Interest Rate Component`; interest is 0% on cross markets, 0.125 bps per hour on isolated.
- Cap: "The 8-hour rate cap is calculated by `600% * (Initial Margin - Maintenance Margin)`"; live `funding_rate_clamp_factor_ppm`
  6 000 000, `premium_vote_clamp_factor_ppm` 60 000 000, `min_num_votes_per_sample` 15 ([live] `/dydxprotocol/perpetuals/params`).
- Impact notional for the Large-Cap tier: 10 000 USDC ([live] liquidity tier 0), not the `500 / IMF` of the docs.

### Margin — [doc] https://docs.dydx.xyz/concepts/trading/margin
- `Initial Margin Requirement = abs(S × P × I)`, `Maintenance = abs(S × P × M)`, `P` = oracle price.
- `Total Account Value = Q + Σ(S_i × P_i)`; `Free collateral = Total Account Value − Total Initial Margin Requirement`.
- Open-interest scaling: `effective_IMF = Min(base_IMF + Max(IMF_increase, 0), 100%)` between the tier's lower and upper open-notional
  caps. Both caps are 0 for the Large-Cap tier, so BTC and ETH are not scaled.

### Liquidation — [doc] https://docs.dydx.xyz/concepts/trading/liquidations, https://docs.dydx.xyz/concepts/trading/contract-loss-mechanism
- Trigger: "Oracle Price is used to estimate the value of an account's positions. If the account's value falls below the account's
  maintenance margin requirement, the account is liquidatable."
- Mechanism: a protocol-generated order matched against the book at a "Fillable Price"; position closed partly or fully.
- Penalty: "Maximum Liquidation Penalty of 1.5%", paid to the insurance fund (live `max_liquidation_fee_ppm` 15 000).
- Live config: at most 10% of a position per block with a $1 000 minimum, `spread_to_maintenance_margin_ratio_ppm` 1 500 000,
  `bankruptcy_adjustment_ppm` 1 000 000 ([live] `/dydxprotocol/clob/liquidations_config`).
- Insurance fund "covers insufficient collateral by adjusting liquidation order prices"; isolated markets have their own.
- Deleveraging: "If an account's value turns negative, deleveraging occurs immediately against randomly chosen offsetting positions".

### Oracle / mark price — [doc] https://docs.dydx.xyz/concepts/trading/oracle
There is no separate mark price. The oracle price is used for "Ensuring that each account is well-collateralized after each trade",
"Determining when an account should be liquidated" and triggering conditional orders. Validators run a sidecar pulling exchange prices
and submit them "through vote extensions"; the proposer aggregates. BTC-USD and ETH-USD: 8 sources (Binance, Bybit, Coinbase, Huobi,
Kraken, Kucoin, Mexc, Okx), `min_exchanges` 3, `min_price_change_ppm` 500 ([live] `/dydxprotocol/prices/params/market/{0,1}`).

### Jurisdictions — https://dydx.exchange/v4-terms, "Last updated March 12, 2026"

> "WAS NOT DEVELOPED FOR, MAY NOT BE USED BY, AND IS NOT AVAILABLE TO (1), WITH RESPECT TO DYDX PERPETUALS TRADING SOFTWARE, ALL
> PERSONS OR ENTITIES WHO RESIDE IN, ARE CITIZENS OF, ARE LOCATED IN, ARE INCORPORATED IN, OR HAVE A REGISTERED OFFICE OR PRINCIPAL
> PLACE OF BUSINESS IN ANY JURISDICTION WHERE THE DYDX PERPETUALS TRADING SOFTWARE IS INELIGIBLE FOR USE INCLUDING WITHOUT LIMITATION
> THE UNITED STATES OF AMERICA, CANADA AND THE UNITED KINGDOM"

- Restricted Territory: "Iran, Cuba, North Korea, the regions of Crimea, Donetsk or Luhansk", plus any comprehensively sanctioned
  country, and sanctioned persons (OFAC list).
- "USE OF ANY TECHNOLOGY OR MECHANISM, SUCH AS A VIRTUAL PRIVATE NETWORK ("VPN") TO CIRCUMVENT THE RESTRICTIONS SET FORTH HEREIN IS
  PROHIBITED."
- Each use confirms the user "WILL NOT COORDINATE, CONDUCT OR CONTROL … USE OF DYDX PERPETUALS TRADING SOFTWARE FROM WITHIN THE UNITED
  STATES OF AMERICA, CANADA".
- The integration guide repeats it and expects clients to geo-block, using the indexer's `/v4/geo` and
  `/v4/compliance/screen/<address>` ([doc] https://docs.dydx.xyz/interaction/integration/integration-compliance). The indexer has
  `RESTRICTED_COUNTRIES` and `INDEXER_LEVEL_GEOBLOCKING_ENABLED` (default `true`) settings ([src]
  `indexer/packages/compliance/src/config.ts`).

**The United States, Canada and the United Kingdom are named. This is a go / no-go item for the owner, independent of anything technical.**

### Testnet — [doc] https://docs.dydx.xyz/interaction/endpoints, [src] `v4-client-js/src/clients/constants.ts`

| | |
|---|---|
| Chain id | `dydx-testnet-4` |
| Indexer | `https://indexer.v4testnet.dydx.exchange`, `wss://indexer.v4testnet.dydx.exchange/v4/ws` |
| RPC | `https://test-dydx-rpc.kingnodes.com`, `https://dydx-testnet-rpc.polkachu.com`, OEGS `https://oegs-testnet.dydx.exchange:443` |
| REST | `https://test-dydx-rest.kingnodes.com`, `https://dydx-testnet-api.polkachu.com` |
| Faucet | `https://faucet.v4testnet.dydx.exchange` — `POST /faucet/tokens` (`address`, `subaccountNumber`, `amount`) and `/faucet/native-token` |
| Software | v9.8.0 since block 88 375 358 |

## 6. BTC-USD and ETH-USD

Read from [live] `https://indexer.dydx.trade/v4/perpetualMarkets?ticker=…` and cross-checked against the chain
(`/dydxprotocol/clob/clob_pair/{0,1}`, `/dydxprotocol/perpetuals/perpetual/{0,1}`, `/dydxprotocol/perpetuals/liquidity_tiers`).

| | BTC-USD | ETH-USD | Where it comes from |
|---|---|---|---|
| CLOB pair / perpetual id | 0 | 1 | chain |
| Market type, tier | CROSS, Large-Cap (0) | CROSS, Large-Cap (0) | perpetual params |
| `atomicResolution` | −10 | −9 | perpetual params |
| `quantumConversionExponent` | −9 | −9 | clob pair |
| `stepBaseQuantums` | 1 000 000 | 1 000 000 | clob pair |
| `subticksPerTick` | 100 000 | 100 000 | clob pair |
| **Tick size** | **$1** | **$0.1** | indexer `tickSize`; equals the section 3 formula |
| **Step size = minimum order** | **0.0001 BTC** (≈ $7.4) | **0.001 ETH** (≈ $2.1) | indexer `stepSize`; USD at oracle 73 683.85 / 2 060.66 |
| Initial margin fraction | 0.02 | 0.02 | tier `initial_margin_ppm` 20 000 |
| Maintenance margin fraction | 0.012 | 0.012 | tier `maintenance_fraction_ppm` 600 000 (60% of IMF) |
| **Max leverage (1 / IMF)** | **50×** | **50×** | derived |
| OI-scaled IMF | none (caps 0 / 0) | none (caps 0 / 0) | tier caps |
| **Funding cap** | **4.8% per 8 h, i.e. 0.6% per hour** | same | derived: 600% × (0.02 − 0.012), then ÷ 8 |
| Last hourly funding | 0.0027125% | — | indexer `/historicalFunding/BTC-USD` |

The funding cap row is a derivation from the documented formula and the live parameters; it was not observed.

## Verified / Not verified

**Verified on 2026-11-10**
- Mainnet software 9.8.2; accountplus active; fee tiers; equity tiers; block rate limits; liquidation config; withdrawal rate limits;
  IBC channel pair; BTC/ETH parameters; expired fee holidays — all read from mainnet state.
- Authenticator behaviour (whitelist filters, fail-closed, add/remove, extension, fee payer) — read in source at `main` `7b8822a`;
  `subaccount_filter.go` and `clob/types/constants.go` re-read at tag `protocol/v9.8.2`. The other files were not re-read at the tag.
- EIP-712 onboarding message and key derivation — read in `v4-web` and `v4-client-js` at `main`.

**Documentation that disagrees with the chain** (chain value used above)

| Topic | Documentation | Chain / source |
|---|---|---|
| Large-Cap margin | funding page table: 5% / 3%, BTC cap example 12% | 2% / 1.2% → 4.8% |
| Block rate limit | example: 2 per block and 20 per 100 blocks | 50 per 100 blocks |
| Short block window | `v4-client-js` constant `SHORT_BLOCK_WINDOW = 20` | 40 |
| Impact notional | `500 USDC / IMF` | 10 000 USDC for Large-Cap |
| UI trading key scope | "default permissions to trade on all cross-margin pairs" | client code: subaccount 0 only, no CLOB pair filter |

**Not verified**
- No authenticator was created, even on testnet: the proposal below is untested. In particular a comma-separated `MessageFilter` list is
  supported by the chain code but the official client never uses it.
- The terms of the hosted front-end `dydx.trade/terms` (the page is a script-rendered app and returned no text). Only the software
  terms at dydx.exchange were read.
- CCTP fees and attestation times from Circle's side; Skip Go limits beyond what the dYdX docs state.
- Which countries the indexer blocks (`RESTRICTED_COUNTRIES` is deployment configuration); `/v4/geo` was deliberately not called. Observed while building the read adapter (Part A): from Canada, the mainnet indexer answers account endpoints with HTTP 403 `GEOBLOCKED`; market data is served.
- Whether the short-term equity tier is enforced in practice (the keeper reads it; no test).
- That resting stateful orders survive `MsgRemoveAuthenticator`: inferred from orders being stored in state independently of the
  authenticator, not found stated in the docs or tested.
- `timeout_height` conventions for order transactions; any per-IP limit on the public OEGS endpoint.
- Insurance fund balance, deleveraging frequency, dYdX help-centre articles (not consulted).
- A maximum number of authenticators per account: none found in the source, not proven absent.

## Proposal: authorising trading with a key that cannot withdraw

The venue supports the wallet's principle natively. Proposal for the isolated signer:

**Keys, both from the existing seed**

| Role | Path | Holds | Signs |
|---|---|---|---|
| Owner (main) key | `m/44'/118'/0'/0/0` | the `dydx1…` account, gas, all subaccounts | deposits, withdrawals, transfers, `MsgAddAuthenticator`, `MsgRemoveAuthenticator` — rare, each confirmed by the owner |
| Trading key | `m/44'/118'/1'/0/0` (any other index) | nothing; never funded | only `MsgPlaceOrder`, `MsgCancelOrder`, `MsgBatchCancel`, with the authenticator id in the tx extension |

No EIP-712 onboarding signature is produced, so the account is native to the seed and unrelated to any front-end account.

**What the owner signs once** — one `MsgAddAuthenticator` from the owner key (ordinary gas-paying transaction):

```
authenticator_type: "AllOf"
data: JSON [
  { type: "SignatureVerification", config: base64(trading public key, 33 bytes) },
  { type: "MessageFilter",   config: base64("/dydxprotocol.clob.MsgPlaceOrder,/dydxprotocol.clob.MsgCancelOrder,/dydxprotocol.clob.MsgBatchCancel") },
  { type: "SubaccountFilter", config: base64("1") },
  { type: "ClobPairIdFilter", config: base64("0,1") }
]
```

Then read the assigned id from `GetAuthenticators` and store it beside the trading key. If the comma-separated `MessageFilter` fails
on testnet, use the official shape instead: `AnyOf` of three single-message filters.

**Bounding the residual risk**
1. **Dedicated subaccount** (number 1 above, not 0). The owner deposits only the risk budget into it. Every residual risk in section 4
   — bad trades, wash trades, builder fees — is capped at that subaccount's collateral, because cross-margin stops at the subaccount.
2. **`ClobPairIdFilter("0,1")`**: BTC-USD and ETH-USD only, which removes the thin-market drain the client source warns about.
3. **Signer-side policy**, since the chain cannot do it: refuse any order carrying `builder_code_parameters` or `order_router_address`;
   cap order size and notional; allow only flags `0` and `64` unless conditional orders are wanted; refuse `good_til_block_time`
   beyond a short horizon.
4. **Prefer short-term orders**, or timestamp nonces for stateful ones, so the trading key never races the owner's sequence.
5. Isolated-margin markets are out of reach for this key by construction; that is acceptable for BTC and ETH, both cross.

**Revoking**: one `MsgRemoveAuthenticator { sender, id }` from the owner key. Then cancel resting stateful orders from the owner key —
conditional, long-term and TWAP orders already on chain survive the removal — and withdraw the subaccount if the key is suspected.

**Before any of this**: the terms name the United States, Canada and the United Kingdom as ineligible for perpetuals trading. That
question comes first.

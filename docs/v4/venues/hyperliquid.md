# Hyperliquid — venue dossier

Checked against the official documentation, the official Python SDK and the live public API on **2026-11-10 / 11** (UTC 2026-11-11).
Adapter: `packages/derivatives/src/venues/hyperliquid/` (entry point `@spw/derivatives/hyperliquid`). Scope: **perpetuals of the first perp
dex** (the validator-operated USDC dex). Out of scope: spot, builder-deployed dexes (HIP-3), outcome markets (HIP-4), TWAP, order
modification, sub-accounts, vaults, deposits and withdrawals (how the owner funds the account, and what a later delivery needs: section 14).

**Nothing was sent to the mainnet exchange endpoint.** Mainnet was used read-only (`POST /info`, websocket subscriptions). The testnet
exchange endpoint received 12 requests signed by a key generated in memory by `scripts/hl-testnet.mts` and discarded (section 9),
and 10 more (two runs of five) from `scripts/hl-live-testnet.mts`, signed by the isolated signer on a throwaway in-memory seed (section 13).

## 1. Sources

| | |
|---|---|
| Documentation root | https://hyperliquid.gitbook.io/hyperliquid-docs/ (markdown: append `.md`; index `llms.txt`) |
| Info endpoint | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint and `/info-endpoint/perpetuals` |
| Exchange endpoint | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint |
| Websocket | `/for-developers/api/websocket`, `/websocket/subscriptions`, `/websocket/timeouts-and-heartbeats` |
| Signing | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing |
| Nonces and API wallets | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets |
| Tick and lot size | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size |
| Error responses | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses |
| Rate limits | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits |
| Asset ids, notation | `/for-developers/api/asset-ids`, `/for-developers/api/notation` |
| Bridge / USDC | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2 (now titled "USDC") |
| Trading rules | `/trading/contract-specifications`, `/trading/funding`, `/trading/robust-price-indices`, `/trading/margining`, `/trading/order-types`, `/trading/take-profit-and-stop-loss-orders-tp-sl`, `/trading/fees`, `/trading/sub-accounts` |
| Testnet faucet | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet |
| Python SDK | https://github.com/hyperliquid-dex/hyperliquid-python-sdk — master `2fdb18f` (2026-06-04); PyPI 0.24.0, whose `utils/signing.py` is identical to master |

Hosts: mainnet `https://api.hyperliquid.xyz`, `wss://api.hyperliquid.xyz/ws`; testnet `https://api.hyperliquid-testnet.xyz`,
`wss://api.hyperliquid-testnet.xyz/ws`. Both sit behind CloudFront/nginx. No API key exists: reads are public, writes are signed.

## 2. Endpoints used

All reads are `POST /info` with a JSON body `{ "type": … }`. Fixtures of every one, mainnet and testnet, are in
`packages/derivatives/test/fixtures/hyperliquid/` (recorder: `record.mts` in the same folder).

| Adapter method | Request | Weight | What is read |
|---|---|---|---|
| `instruments()` | `meta` | 20 | `universe[i]`: `name`, `szDecimals`, `maxLeverage`, `onlyIsolated`, `marginMode`, `isDelisted`. **The asset id used in actions is the index `i`** and differs between mainnet and testnet (BTC = 0 on mainnet, 3 on testnet) |
| `tickers()` | `metaAndAssetCtxs` | 20 | per asset: `markPx`, `oraclePx` (→ `index`), `midPx` (null when the book is empty), `funding` (hourly rate), `openInterest` (base units), `dayNtlVlm` (→ `volume24h`, USD notional), `prevDayPx` (→ `change24h = (mark − prevDayPx) / prevDayPx`, 6 decimals) |
| `book(symbol, depth)` | `l2Book {coin}` | 2 | `levels[0]` bids, `levels[1]` asks (`px`, `sz`, `n`), 20 levels a side, `time` |
| `trades(symbol)` | `recentTrades {coin}` | 20 + 1 per 20 items | `px`, `sz`, `side` (B = buy aggressor), `time`, `tid`. Id = `time-tid` ("For a globally unique trade id, use (block_time, coin, tid)") |
| `candles()` | `candleSnapshot {req: {coin, interval, startTime, endTime}}` | 20 + 1 per 60 items | `t`, `o`, `h`, `l`, `c`, `v` (base volume). "Only the most recent 5000 candles are available" |
| `fundingHistory()` | `fundingHistory {coin, startTime, endTime?}` | 20 + 1 per 20 items | `fundingRate`, `premium`, `time` (one row per hour) |
| `account()`, `positions()` | `clearinghouseState {user}` | 2 | `marginSummary.accountValue` (equity), `.totalMarginUsed`, `withdrawable`, `crossMaintenanceMarginUsed`; positions: `szi` (signed), `entryPx`, `liquidationPx`, `leverage {type, value}`, `marginUsed`, `unrealizedPnl`, `cumFunding.sinceOpen` |
| `positions()` (mark) | `metaAndAssetCtxs` | 20 | the account state has no mark price; the venue's own `markPx` is read rather than derived |
| `openOrders()` | `frontendOpenOrders {user}` | 20 | `orderType` ("Limit", "Stop Market", "Stop Limit", "Take Profit Market", "Take Profit Limit", "Market"), `tif`, `isTrigger`, `triggerPx`, `reduceOnly`, `cloid`, `sz` (remaining), `origSz` |
| `orderHistory()` | `historicalOrders {user}` | 20 + 1 per 20 items | same order object + `status`, `statusTimestamp`; "at most 2000 most recent historical orders"; one row per status change, reduced to the latest per order |
| `fills()` | `userFills {user}` / `userFillsByTime {user, startTime}` | 20 + 1 per 20 items | `px`, `sz`, `side`, `fee`, `feeToken`, `closedPnl`, `oid`, `cloid`, `tid`, `hash`, `liquidation?`. "at most 2000 most recent fills"; by time: "at most 2000 fills per response and only the 10000 most recent fills are available" |
| `funding()` | `userFunding {user, startTime}` | 20 + 1 per 20 items | `delta.usdc` (signed), `delta.fundingRate`, `delta.szi`, `time` |
| `hl-testnet.mts` only | `userRole {user}` | 60 | `{"role": "agent", "data": {"user": …}}` once an API wallet is approved |

Writes are `POST /exchange` with `{ action, nonce, signature: {r, s, v}, vaultAddress, expiresAfter }` (the body of the SDK's
`_post_action`). Weight `1 + floor(batch_length / 40)`. Actions built by the adapter: `order`, `cancel`, `cancelByCloid`,
`updateLeverage` (L1 actions) and `approveAgent` (user-signed).

Websocket: `{"method": "subscribe", "subscription": {…}}` with `l2Book {coin}`, `trades {coin}`, `activeAssetCtx {coin}`, `allMids`,
`userFills {user}`, `orderUpdates {user}`, `userEvents {user}` (channel name `user`). Heartbeat `{"method": "ping"}` → `{"channel": "pong"}`.

Error answers seen live (fixtures `*-error-*.json`): unknown coin → **HTTP 500, body `null`**; unknown `type` or malformed address →
**HTTP 422, `Failed to deserialize the JSON body into the target type`**; rate limit → **HTTP 429, body `null`**, no `Retry-After`.
The adapter refuses unknown symbols and malformed addresses itself, before sending.

## 3. Rules and where they come from

| Rule | Source | In the adapter |
|---|---|---|
| "Prices can have up to 5 significant figures, but no more than `MAX_DECIMALS - szDecimals` decimal places where `MAX_DECIMALS` is 6 for perps … Integer prices are always allowed" | tick-and-lot-size | `hlFormatPrice` refuses anything else (never rounds). No fixed tick exists: `Instrument.tickSize = 10^-(6 − szDecimals)` is the **finest** step; the step at a price is `hlTickAt(price, szDecimals)` |
| "Sizes are rounded to the `szDecimals` of that asset" | tick-and-lot-size | `lotSize = 10^-szDecimals`; `hlFormatSize` refuses more decimals |
| "if implementing signing, trailing zeroes should be removed" | tick-and-lot-size, signing | wire form through `hlWire` ("100.50" → "100.5"); `describe` refuses a wire value with trailing zeros |
| "Order must have minimum value of $10." | error-responses | `Instrument.minNotional = "10"`, `minOrderSize = null`. Enforced by the venue and the risk engine, not by the builder |
| "Many of the requests take asset as an input. For perpetuals this is the index in the `universe` field returned by the `meta` response" | exchange-endpoint, asset-ids | asset table (`HlAsset`) per network; `describe` names instruments through it |
| Order wire `{a, b, p, s, r, t: {limit: {tif}} \| {trigger: {isMarket, triggerPx, tpsl}}, c}`, `grouping: "na"` | exchange-endpoint; SDK `order_request_to_order_wire`, `order_type_to_wire` | field order as the SDK (msgpack hashes the order of keys) |
| "ALO … will be canceled instead of immediately matching. IOC … will have the unfilled part canceled instead of resting. GTC … no special behavior" | exchange-endpoint | `tif` `alo` / `ioc` / `gtc` → `Alo` / `Ioc` / `Gtc` |
| Market orders: the API has no market order; the SDK sends an IOC limit at mid ± slippage (`market_open`, `_slippage_price`) | SDK `exchange.py` | `type: 'market'` → IOC limit at the request's `price` (the worst acceptable price, mandatory); `tif` must be `ioc` |
| "Stop Market / Stop Limit / Take Market / Take Limit"; "TP/SL market orders have a slippage tolerance of 10%"; "By setting the limit price on TP/SL orders, users can control the slippage tolerance"; the mark price triggers them | trading/order-types, trading/take-profit-and-stop-loss-orders-tp-sl | `stop_*` → `tpsl: "sl"`, `take_profit_*` → `"tp"`; `*_market` → `isMarket: true`. `price` (wire `p`) and `triggerPrice` are both required; `tif` must be `gtc` (the wire has no tif for triggers) |
| "Client Order ID (cloid) is an optional 128 bit hex string" | exchange-endpoint | `hlCloid(clientId)` = first 16 bytes of `keccak256("spw/hyperliquid/cloid/v1:" ‖ clientId)`; a value that already is a cloid passes unchanged |
| "`f` must be skipped if false, i.e. actions hashed with `f: false` will be rejected" (cancel fast flag) | exchange-endpoint | never set; `describe` refuses a cancel that carries it |
| `updateLeverage {asset, isCross, leverage}` — "integer representing new leverage, subject to leverage constraints on that coin" | exchange-endpoint | integer 1 … `maxLeverage`; cross refused on isolated-only assets |
| `marginMode`: "`strictIsolated` means margin cannot be removed, `noCross` means only isolated margin allowed"; `onlyIsolated` "deprecated. Means either" | info-endpoint/perpetuals | either → `marginModes: ['isolated']` |
| "The funding rate on Hyperliquid is paid every hour"; payment = `position_size * oracle_price * funding_rate`; cap 0.5 %/hour | trading/funding | `fundingIntervalSec = 3600`; `Ticker.funding` is the hourly rate |
| Mark price = median of three inputs (oracle + 150 s EMA of mid − oracle; median of bid, ask, last; weighted median of five CEX perp mids), "used for margining, liquidations, triggering TP/SL, and computing unrealized pnl", updated about every 3 s | trading/robust-price-indices | `Instrument.markPriceMethod` |
| "USDC margining, USDT denominated linear contracts … technically quanto contracts where USDT pnl is denominated in USDC" (PURR and HYPE are USDC-denominated) | trading/contract-specifications | `collateral: 'USDC'`, `quote: 'USD'`, `settlement` text |
| Initial margin `position_size * mark_price / leverage`; "The maintenance margin is currently set to half of the initial margin at max leverage"; cross and isolated liquidation use the same logic | trading/margining, contract-specifications | not computed here (margin engine); the venue's `liquidationPx` is passed through |
| Order statuses `open, filled, canceled, triggered, rejected, marginCanceled, vaultWithdrawalCanceled, openInterestCapCanceled, selfTradeCanceled, reduceOnlyCanceled, siblingFilledCanceled, delistedCanceled, liquidatedCanceled` | info-endpoint, "Query order status" | `*Canceled` → `cancelled` with the venue's word in `rejectReason`; an unknown status is `bad_answer` |
| Batched errors: "Some errors are a deterministic function of the payload itself, and these are instead returned earlier as part of pre-validation. In this case only one error is returned for the entire payload" | error-responses | `submit` handles both `{"status":"err","response": "…"}` and per-order `{"error": "…"}` → `VenueError('rejected')` |
| Fees (tier 0, perps): taker 0.045 %, maker 0.015 %; 14-day volume tiers; sub-accounts share the master's tier | trading/fees | not modelled; real fees come from `fills()` |

## 4. Rate limits

Documented (rate-limits-and-user-limits), per IP: "REST requests share an aggregated weight limit of 1200 per minute"; exchange requests
`1 + floor(batch_length / 40)`; info weight 2 for `l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus`,
60 for `userRole`, 20 for the others, plus one per 20 items returned for `recentTrades, historicalOrders, userFills, userFillsByTime,
fundingHistory, userFunding, …` and one per 60 items for `candleSnapshot`. Websocket: 10 connections, 30 new connections per minute, 1000
subscriptions, 10 distinct users across user subscriptions, 2000 messages sent per minute.

Per address (actions only): "1 request per 1 USDC traded cumulatively since address inception … initial buffer of 10000 requests. When
rate limited, an address is allowed one request every 10 seconds"; cancels have a higher limit (`min(limit + 100000, limit * 2)`); "a
batched request with `n` orders … is treated as one request for IP based rate limiting, but as `n` requests for address-based rate
limiting"; 1000 open orders by default; stale `expiresAfter` cancellations cost 5×.

In the adapter: `HlWeightBudget`, a sliding one-minute window of 1200 shared by all requests of an adapter instance. A request that
would pass the limit is refused locally with `VenueError('rate_limited', { retryAfterMs })` and is **not sent**; per-item surcharges are
charged after the answer; an HTTP 429 fills the window. The stream sends one ping per 15 s and reconnects with a backoff of 1 s … 30 s.

**Measured on testnet, 2026-11-11** (weight-20 `meta` requests, one IP): 75 sequential requests in 20 s (weight 1500) were all accepted;
a second run about 20 s later accepted 105 more in 7.6 s (weight 2100) before the first **HTTP 429 (body `null`)**; a weight-2 request
was refused right after; requests were accepted again 25 s later. So the server tolerated roughly 3600 weight inside a minute before
refusing — enforcement is looser than, or windowed differently from, the documented 1200 per minute. The documented figure is treated
as the contract. Not measured on mainnet (no reason to load it), and the address-based limits were not measured (they need a trading
account). A normal smoke run uses 126 weight per network.

## 5. API wallets ("agents") — what the trading key can and cannot do

What the documentation says, quoted:

- "These are also known as `agent wallets` in the docs. A master account can approve API wallets to sign on behalf of the master
  account or any of the sub-accounts." "Note that API wallets are only used to sign. To query the account data associated with a master
  or sub-account, you must pass in the actual address of that account. A common pitfall is to use the agent wallet which leads to an
  empty result." (nonces-and-api-wallets)
- `approveAgent`: "An account can have 1 unnamed approved wallet and up to 3 named ones. And additional 2 named agents are allowed per
  subaccount. A custom expiration can be set by appending `valid_until {timestamp}` after the name. The expiration can be at most 180
  days in the future" (exchange-endpoint, "Approve an API wallet"). It is a user-signed action: only the account key can make it.
- Pruning: an agent is deregistered when a new unnamed agent is approved (for the unnamed one), when an agent of the same name is
  approved, when it expires, or when "the account that registered the agent no longer has funds". "it is **strongly** suggested to
  not reuse their addresses. Once an agent is deregistered, its used nonce state may be pruned … previously signed actions can be
  replayed once the nonce set is pruned."
- Withdrawals: "The withdrawal flow requires a user wallet signature on Hyperliquid only" (bridge page, `withdraw3`). `usdSend`
  ("Core USDC transfer"), `spotSend`, `sendAsset`, `usdClassTransfer`, `withdraw3` are all **user-signed** actions: EIP-712 over the
  action itself, signed by the account key. `ApproveBuilderFee` "must be signed by the user's main wallet, not an agent/API wallet".

**Can an agent withdraw or transfer?** The documentation has **no sentence** that says "an API wallet cannot withdraw". What it
establishes is structural: every action that moves funds to another address (`withdraw3`, `usdSend`, `spotSend`, `sendAsset`) uses the
user-signed scheme, which is verified against the account's own address, so an agent's signature cannot authorize it. But the
documentation also lists actions that **an agent can sign and that move the account's own funds around**:

- "Agent Send Asset … Similar to send asset, but can be signed by an agent. **Destination must match the source address.**" —
  transfers between the account's own perp dexes, spot balance and sub-accounts (`agentSendAsset`).
- "Deposit into staking (agent) … can be signed by an agent" (`cDeposit2`).
- agent variants of the abstraction settings (`agentEnableDexAbstraction`, `agentSetAbstraction`).
- and every L1 action in general (the scheme the SDK uses for `vaultTransfer`, `subAccountTransfer`, `updateIsolatedMargin`, `twapOrder`,
  `scheduleCancel` …). Whether the venue accepts each of those from an agent is **not stated and not verified**.

Consequence for the wallet (binding principle 3 says the trading key "can place and cancel orders but cannot withdraw"): withdrawal to
a third party is indeed out of the agent's reach, but **an agent key is not limited to orders by the venue**. The limitation is ours:
`describe()` recognises only `order`, `cancel`, `cancelByCloid`, `updateLeverage` and (for the account key) `approveAgent`; everything
else — including a correctly hashed `agentSendAsset`, `vaultTransfer` or `cDeposit2` — is `other`, which the signer refuses. A stolen
agent key could still trade the account badly (that is what the risk policy and the mandate bound) and could move collateral between
the account's own balances.

Revocation: approve another agent under the same name (or another unnamed one). The documentation describes no dedicated revoke action.

## 6. Signing and nonces

Two schemes ("Not realizing that there are two signing schemes", signing page), both implemented in `signing.ts` (pure):

1. **L1 actions** — `keccak256( msgpack(action) ‖ nonce (u64 BE) ‖ 0x00 | 0x01 ‖ vault address (20 bytes) [‖ 0x00 ‖ expiresAfter (u64 BE)] )`
   is the `connectionId` of a "phantom agent" `{ source, connectionId }` signed with EIP-712: domain `{ name: "Exchange", version: "1",
   chainId: 1337, verifyingContract: 0x0 }`, type `Agent(string source, bytes32 connectionId)`, `source = "a"` on mainnet, `"b"` on
   testnet. `expiresAfter` exists in the current SDK (`action_hash(action, vault_address, nonce, expires_after)`) and is supported as an
   option (`expiresAfterMs`).
2. **User-signed actions** — EIP-712 over the action's fields: domain `{ name: "HyperliquidSignTransaction", version: "1", chainId:
   int(signatureChainId), verifyingContract: 0x0 }`, primary type `HyperliquidTransaction:ApproveAgent | UsdClassTransfer | Withdraw | …`,
   with `hyperliquidChain: "Mainnet" | "Testnet"` inside the message. `signatureChainId` defaults to `0x66eee`, the value the SDK uses
   ("can be any chain").

MessagePack: written in `msgpack.ts` (about 60 lines: nil, booleans, integers, strings, arrays, string-keyed maps in insertion order)
rather than adding `@msgpack/msgpack` — no msgpack library existed in the repository, the subset is tiny, it keeps the signing path free
of a new dependency, and it refuses floats, `undefined` and integer-like keys, which must never appear in a signed action.

`usdClassTransfer` and `withdraw3` exist only as typed-data builders with explicit names (`buildUsdClassTransferTypedDataOnly`,
`buildWithdraw3TypedDataOnly`). They are wired to nothing; `describe` answers `other` for them and `submit` refuses them.

**Nonces** (nonces-and-api-wallets): "the 100 highest nonces are stored per address. Every new transaction must have nonce larger than
the smallest nonce in this set and also never have been used before. Nonces are tracked per signer, which is the user address if signed
with private key of the address, or the agent address if signed with an API wallet." "Nonces must be within `(T - 2 days, T + 1 day)`,
where `T` is the unix millisecond timestamp on the block of the transaction." Recommended: "fetch and increment an atomic counter … can
be fast-forwarded to current unix milliseconds". In the adapter: `createHlNonceSource()` (max(now, last + 1), one per signer key);
`submit` refuses a nonce outside the window before sending; for `approveAgent` (and the other user-signed actions) the nonce in the
action must equal the request nonce. One API wallet per trading process; never reuse an agent address after it was deregistered.

## 7. `describe()` — the signer's independent reading

`describe(sign)` takes the `SignRequest` (`kind: 'hl_l1' | 'hl_user'`; payload: the action, nonce, vault address, expiry and the typed
data to sign) and:

1. recomputes the hash from the action **as given** and checks that the typed data to sign is exactly the phantom agent of that
   action, nonce, vault and expiry on this network (so what is shown is what is signed);
2. validates the action against a **strict** schema (any extra field — `builder`, the cancel `f` flag, an unknown key — is a refusal),
   in the canonical field order, with wire-form decimals that satisfy the price and size rules of the named asset;
3. returns `order` (with normalized `OrderRequest`s), `cancel`, `leverage`, `approve_agent` (agent address, name, expiry), or `other`
   for a consistent hash of anything else. It throws `VenueError('rejected')` for anything malformed or inconsistent.

It needs the venue's asset table to turn an asset index into an instrument. **That table is a trust input**: a signer fed a false
table would be told "BTC" for another asset's index. The signer must pin or fetch `meta` itself, per network.

## 8. Deposits, withdrawals, sub-accounts, vaults (facts, not implemented)

> Deposits and withdrawals are built since v6 (2026-11-11): **section 15** is current (facts re-read, evidence, route, code).
> Sub-accounts and vaults remain unused.

- **Deposit**: "CCTP is the preferred method for minting USDC natively on the Hyperliquid L1" (Circle:
  https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore). The **legacy Arbitrum bridge** ("deprecated";
  contract `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` on Arbitrum, source `hyperliquid-dex/contracts/Bridge2.sol`; testnet
  `0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89`): "The user sends native USDC to the bridge, and it is credited to the account that sent
  it in less than 1 minute. **The minimum deposit amount is 5 USDC. If you send an amount less than this, it will not be credited and
  be lost forever.**" Native USDC on Arbitrum is `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`. Trading itself is gas-free.
- **Withdrawal**: `withdraw3`, user-signed. "There is a $1 fee for withdrawing at the time of this writing and withdrawals take
  approximately 5 minutes to finalize" (exchange-endpoint); "handled entirely by validators, and the funds arrive in the user wallet in
  3-4 minutes" (bridge page). `nonce` must equal the action's `time`.
- **Spot ⇄ perp**: `usdClassTransfer` (user-signed), `toPerp: true | false`. Accounts under the newer "unified account" /
  "portfolio margin" abstractions keep collateral differently; the adapter reads `clearinghouseState` only (see "Not verified").
- **Sub-accounts**: "Up to 10 sub-accounts can be created after reaching $100,000 in volume" (up to 80 with more volume); they "do not
  have private keys": the master (or its agent) signs and sets `vaultAddress` to the sub-account, which is part of the hash. "The number
  of API wallets available starts at 3 for all master accounts and increases by 2 per sub-account." Nonces are per signer, so one agent
  per sub-account is recommended. Not used: `vaultAddress` is always `null` and `capabilities.subaccounts = false`.
- **Vaults**: same mechanism (`vaultAddress`); a leader must keep at least 5 % of the vault. Not used.

## 9. Testnet proof (2026-11-11)

Faucet: "To use the testnet faucet, you need to have deposited on mainnet with the same address. Users who have deposited on mainnet
may then receive 1,000 mock USDC for testnet use" (onboarding/testnet-faucet). A throwaway key therefore cannot be funded; this was
**not worked around**, and mainnet was not touched. What was proven without funds — `npx tsx scripts/hl-testnet.mts proof --record`,
recorded in `test/fixtures/hyperliquid/testnet-exchange-proof.json` and replayed by `test/hyperliquid/testnet-proof.test.ts`:

| Sent to `https://api.hyperliquid-testnet.xyz/exchange` (throwaway signer `0xe902…4838`) | Answer (HTTP 200) |
|---|---|
| `approveAgent` (user-signed) | `{"status":"err","response":"Must deposit before performing actions. User: 0xe9024c83d938a8f2e475500e1708eb3c33e54838"}` |
| `order` post-only limit buy; `order` stop-market reduce-only; `cancel`; `cancelByCloid`; `updateLeverage`; `order` with `expiresAfter` | each: `{"status":"err","response":"User or API Wallet 0xe9024c83d938a8f2e475500e1708eb3c33e54838 does not exist."}` |
| wrong: signature made for nonce + 1 | `… User or API Wallet 0x4cdf2dfb19e548ec12aab2ce2a2a5ef0f37142a5 does not exist.` |
| wrong: phantom agent of mainnet (`source: "a"`) | `… User or API Wallet 0x02de353fd67ed63e5dbcb4d5a18a877efe73d3bb does not exist.` |
| wrong: size changed after signing | `… User or API Wallet 0xf571ec3ecae392871290ad8f6598d3f8f1af86b0 does not exist.` |
| wrong: `r = s = 0` | `{"status":"err","response":"Unable to recover signer."}` |

These are the two documented outcomes of the signing page ("`L1 error: User or API Wallet 0x0123... does not exist.`", "`Must deposit
before performing actions. User: 0x123...`"). The venue recovers the signer from the signature over **its** hash of the payload: in the
7 correct cases it named our address, so its hash equals ours for each action type; in the wrong cases it named another address —
exactly the one our own code recovers from that signature over the submitted payload (asserted in the test) — or could not recover one.
A funded account would have gone past this check to the business rules (margin, minimum value …): that part is **not proven**.

### Funding a testnet account, to run the full script

1. Choose the EVM address to use on testnet. The faucet requires that **the same address has deposited on mainnet** (any deposit; the
   legacy bridge minimum is 5 USDC, and a later withdrawal costs 1 USDC). Use a dedicated low-value address, not the main wallet key.
   Alternative without any mainnet deposit: have someone who already holds testnet mock USDC send some to the address (`usdSend` on
   testnet) — an address that was never credited does not exist for the venue.
2. Connect that address at https://app.hyperliquid-testnet.xyz and claim the faucet (https://app.hyperliquid-testnet.xyz/drip): 1,000
   mock USDC. Make sure the USDC is in the **perps** balance (transfer from spot if the interface credited spot).
3. Run `npx tsx scripts/hl-testnet.mts full --account 0x<that address>`. The script creates an API wallet key **in memory**, prints
   its address and waits (10 minutes) for you to authorize it as an API wallet of the account, signing with the account's own
   wallet. The web interface has an API page for this (expected at https://app.hyperliquid-testnet.xyz/API: name `spw-test`, paste
   the address, authorize) — **that page and its labels are not described in the documentation and were not checked here**; what is
   documented is the `approveAgent` action it sends. The account key is never given to the script; the script polls `userRole`
   until the venue reports the address as an agent of the account.
4. The script then checks, against the venue's own state after each step: leverage 3× cross → resting post-only buy (listed open with
   our price, size, tif, cloid) → cancel by cloid (history says cancelled) → market buy of about 12 USDC (fills, none above the worst
   price; position long, 3× cross) → reduce-only stop market (listed as trigger order) → cancel by order id → reduce-only market close
   (no position) → an order below the 10 USDC minimum (rejected) → reconciliation of fees, closed PnL and equity, and the same fills
   seen once on the websocket. It needs about 30 mock USDC. Remove the `spw-test` API wallet afterwards if you wish.

## 10. Stream behaviour

- One connection per adapter. Ping every 15 s (the server closes a connection it has sent nothing to for 60 s). No message for 25 s →
  `stale`; 10 s more → the socket is dropped and re-opened (`reconnecting`), with exponential backoff 1 s … 30 s and jitter; the backoff
  starts again only after a connection that lasted 10 s.
- After a reconnect every subscription is sent again, the status goes back to `connected` and **each consumer receives
  `{ type: 'gap', reason: 'reconnected' }`**: take a REST snapshot again. Fills (`hash-tid`) and public trades (`time-tid`) are
  de-duplicated across messages, channels (`userFills` and `userEvents` both carry fills), snapshots and reconnects; a fill that
  happened during the gap comes back in the `isSnapshot: true` message and is emitted once.
- Observed live: **subscribing to an unknown coin makes the server drop the connection** (close 1006, no message) — the adapter checks
  the symbol against `meta` before subscribing. A duplicate subscription or non-JSON input is answered on the `error` channel
  (`Already subscribed: …`, `Error parsing JSON into valid websocket request: …`). Over 6–9 s windows on BTC: 2–3 `l2Book`
  snapshots, 6–10 `activeAssetCtx` messages (the documentation says the book is "pushed on each block that is at least 0.5 since
  last push"; fewer were seen).
- `orderUpdates` and `userEvents` messages do not name their user: one account per connection.

## 11. Deviations from the contract (`DERIVATIVES-ARCHITECTURE.md`)

- `VenueAdapter.trading` is only present when the adapter is created with an asset table (`assets`); otherwise use
  `await adapter.loadTrading()` — building and describing actions needs the venue's asset indices, which `Instrument` does not carry.
- `describe` cannot give back `clientId` (the wire has only its hash) nor tell a market order from an IOC limit: it returns the cloid
  as `clientId` and `type: 'limit', tif: 'ioc'`. `trading.normalizeRequest(req, instrument)` gives the expected form to compare with.
- `submit` **throws** `VenueError('rejected')` for a refusal (whole request or any per-order error) instead of returning
  `accepted: false`; a timeout or unreadable answer is `unavailable` / `bad_answer` (outcome unknown → reconcile).
- `submit` refuses the mainnet exchange endpoint unless `allowMainnetExchange: true` is passed.
- Extra, not in the contract: `buildUpdateLeverage`, `buildApproveAgent`, `normalizeRequest`, stream subscription `{ type: 'mids' }`,
  stream events `gap` and `invalid`.
- `AccountState.collateral` = account value − unrealized PnL and `freeCollateral` = account value − margin used are derived (exactly)
  from venue fields; `maintenanceMargin` covers cross positions only. `Order.clientId` is the cloid, or `''` when the order has none.
  `Position.realizedPnl` is `null` (not given). `Order.avgFillPrice` is `null` (not in the order object; see fills).
- Symbols are the venue's coin names (`BTC`, `kPEPE` …); instrument id `hyperliquid:<coin>`.

## 12. Verified / Not verified

**Verified**

- Signing: the 11 signing tests of the SDK's `tests/signing_test.py` reproduced — 20 signatures and 1 action hash (orders, cloid, trigger
  order, vault address, mainnet and testnet, `usdSend`, `withdraw3`, sub-account and schedule-cancel actions). 46 further vectors
  produced by running the official SDK 0.24.0 (34 L1: `cancel`, `cancelByCloid`, `updateLeverage`, `expiresAfter`, vault + expiry, alo /
  ioc / reduce-only / cloid orders, the four trigger shapes, `noop`; 12 user-signed: `approveAgent` named / unnamed / with expiry,
  `usdClassTransfer`, `withdraw3`), all reproduced. No vector failed. The SDK's two remaining tests are not signature vectors
  (`float_to_int_for_hashing`: there are no floats here; multi-sig payload mapping: not used).
- Testnet: the venue recovered our signer for `approveAgent`, `order` (limit, trigger, with `expiresAfter`), `cancel`, `cancelByCloid`,
  `updateLeverage`; wrong signatures were refused differently (section 9).
- Every read endpoint of section 2 on mainnet and testnet, live, with fixtures; error answers 500 / 422 / 429.
- Live values, mainnet, 2026-11-11 03:15 UTC (`scripts/smoke-hyperliquid.mts`): 235 instruments (179 active, 56 delisted, 9
  isolated-only); BTC mark 73817, oracle 73837.3, mid 73813.5, funding 0.0000125/h, OI 40452.84 BTC, 24 h volume 3.55 G USD, best bid
  73813 / ask 73814 (0.14 bps); ETH mark 2065.7, oracle 2066.65, bid 2065.6 / ask 2065.7. Testnet: 213 instruments, BTC mark 75337 (2 %
  above the oracle: testnet books are thin). Request latency 150–340 ms; first websocket book 460 ms after connecting.
- Book prices on both networks satisfy the documented price rules as implemented (checked live on BTC and ETH).
- Websocket: `l2Book`, `trades`, `activeAssetCtx`, `allMids`, `userFills` snapshot, `pong`, `error`, `subscriptionResponse` recorded
  live; behaviour on unknown coin, duplicate subscription and junk input observed.

**Not verified**

- Any accepted order: resting, fill, position, cancel, leverage change, agent approval on a funded account. The per-order answers
  (`resting`, `filled`, `error`, `"success"`, `"waitingForTrigger"`) are parsed from the documentation's examples, not from live answers.
- `orderUpdates` and `userEvents` live messages (none occurred while recording): parsed from the documented types only.
- Whether a non-reduce-only trigger order is accepted (the error page lists "non-reduce-only TP/SL orders" among pre-validation
  failures; the SDK's own vector signs one). The builder allows it; the venue decides.
- How the venue treats the limit price `p` of a `isMarket: true` trigger order (documentation: "TP/SL market orders have a slippage
  tolerance of 10%"). The adapter sends the request's `price`; it may be ignored.
- The sign of `cumFunding` (→ `Position.fundingPaid`) and whether a fill's `fee` includes `builderFee`: passed through unchanged.
- Liquidation fills (`liquidation` field) on a real fill; `"Market"` / `FrontendMarket` / `LiquidationMarket` open orders.
- Accounts using the "unified account" or "portfolio margin" abstraction, sub-accounts, vaults, HIP-3 dexes: not read correctly by
  design (first perp dex, `clearinghouseState` only).
- Which L1 actions the venue accepts from an agent beyond orders, cancels and leverage (section 5); agent expiry and pruning in practice.
- Address-based rate limits; IP limits on mainnet; the 30-connections-per-minute websocket limit.
- The agent-name character set: the adapter accepts `[A-Za-z0-9_-]{1,16}` (+ optional ` valid_until <ms>`), which is our own
  restriction; the documentation gives none.
- Deposits and withdrawals (nothing implemented, nothing sent).

## 13. Controlled live trading (2026-11-11) — keys, authorization, signer checks

Code: signer `services/isolated-signer/src/venue.ts`; shared canonical objects and the pinned asset table
`packages/derivatives/src/live/`; execution engine `services/api/src/derivatives/exec.ts`; routes `docs/v4/API-LIVE-NOTES.md`.
It ships disabled: a venue account is `READ_ONLY` until the owner approves an authorization with his passkey.

**Two keys.**

| Key | Path | Signs | Never signs |
|---|---|---|---|
| Wallet key (the account) | `m/44'/60'/0'/0/0` | on this venue, exactly one message: `approveAgent` naming the signer's own trading key, once per authorization, inside `POST /venue/authorize`, after the passkey approved the canonical authorization | orders, cancels, transfers, `usdSend`, `spotSend`, `usdClassTransfer`, an `approveAgent` for any other address, a `withdraw3` to any address but the wallet's own. **Since v6 it signs a second message**: `withdraw3` to the wallet's own address, inside `POST /venue/withdraw`, after a passkey approval of the canonical withdrawal (section 15) |
| Trading key (API wallet) | `m/44'/60'/9000'/0/0` mainnet, `…/0/1` testnet (vault index 9000 is now refused, so no agent vault can share the path) | `order` (one per signature), `cancel`, `cancelByCloid`, `updateLeverage` — only under a stored, unrevoked, unexpired authorization | everything `describe()` calls `other` (`agentSendAsset`, `vaultTransfer`, `subAccountTransfer`, `updateIsolatedMargin`, `cDeposit2`, `scheduleCancel`, `twapOrder`, builder fees…), anything with a `vaultAddress`, anything without `expiresAfter` |

The API wallet is registered under a name with `valid_until <authorization expiry in ms>`, so the venue itself drops it when the
authorization ends (≤ 90 days; the venue allows 180).

**The trading key is deterministic, and the documentation advises against reusing an agent address** ("once an agent is
deregistered, its used nonce state may be pruned … previously signed actions can be replayed"). The design keeps one key per
network (binding), and removes what a replay could do: the signer refuses any L1 action without `expiresAfter`, and requires
it at most 120 s after the nonce (the engine uses 90 s). A signed order therefore dies on the venue within two minutes,
whatever happens to the venue's nonce set later. `expiresAfter` is part of the action hash; the testnet named our trading key
for actions carrying it (below), so the hash is right.

**What the signer checks on `POST /venue/sign`** (from its own stored copy of the authorization, never from the request):
authorization known / not revoked / not expired / `MANUAL_LIVE`; venue and network of the request equal the authorization's;
its own `describe()` on the payload with the pinned asset table → `order`, `cancel` or `leverage` (an `approve_agent` or
`other` is refused); no vault address; `expiresAfter` present and ≤ nonce + 120 s, not passed; nonce within (now − 120 s,
now + 60 s], never used, and — the venue's own rule — above the lowest of the 100 highest nonces signed with this key.
For an order: exactly one order in the action; the canonical order sent for approval equals the payload field by field
(instrument, side, type, size, price, trigger price, reduce-only, time in force, client id, nonce, expiry); instrument
allowed; notional (size × the highest of limit and trigger price, exact decimals) ≤ `maxOrderNotional`; orders signed today
< `maxOrdersPerDay`; client id never signed before; every price of the order within `maxPriceDeviationBps` of the signer's
**own** mid (Coinbase + Kraken, both must answer and agree within 1 % — `prices.ts`; no price, no signature); passkey
assertion whose challenge is the SHA-256 of the canonical order; emergency halt off. For a leverage change: canonical form
equal to the payload, instrument allowed, leverage ≤ `maxLeverage`, passkey, halt off. For a cancel: instrument allowed —
no passkey, and it is signed even under the emergency halt (withdrawing an order is always possible while the authorization
lives). Counters, the client id and the nonce are written to disk before the signature is returned.

**What the signer cannot check.** It has no view of positions. So (a) a reduce-only order needs the passkey like any other
and is bounded by `maxOrderNotional` like any other; (b) `maxPositionNotional` and `maxGrossExposure` are committed to by
the passkey but enforced by the API's risk engine against the venue's real state — a compromised API could ignore them, and
is then still bounded by: passkey per order, notional per order, orders per day, the price band, the expiry.

**Price band and its limits.** The signer's mid is a USD spot price; the venue quotes a USDT-margined perpetual. The band
must cover that basis (a few basis points on mainnet). On testnet the mark wanders (74 562 against a signer mid of 73 639 on
2026-11-11, 1.25 %), so a testnet authorization needs a wide band (the script uses 1000 bps). The band applies to the
trigger price too: a stop further from the market than the band cannot be signed. Only symbols `prices.ts` can price
(`[A-Z]{2,6}`, quoted on both exchanges) can trade — which is one reason the pinned table holds BTC, ETH and SOL only.

**Pinned asset table** (`packages/derivatives/src/live/hl-assets.ts`): mainnet BTC 0, ETH 1, SOL 5; testnet BTC 3, ETH 4,
SOL 0; read from `meta` on 2026-11-11. The signer names instruments through this table only. Trade-off: a table handed over
by the API could say "index 7 is BTC"; a pinned one cannot be falsified but goes stale if the venue renumbers. The API
compares the live `meta` with the table before every proposal and approval and refuses to trade on any difference
(`503 asset_table_mismatch`, nothing signed); the fix is a reviewed change of the table and a redeploy of both bundles. A
lower venue maximum leverage is not treated as a difference (the venue refuses what exceeds it).

**Info requests added for reconciliation** — shapes read live on testnet, 2026-11-11:

| Request | Answer |
|---|---|
| `orderStatus {user, oid}` (`oid`: number, or the cloid as hex) | unknown: `{"status":"unknownOid"}`; known: `{"status":"order","order":{"order":{coin, side, limitPx, sz, oid, timestamp, triggerCondition, isTrigger, triggerPx, children, isPositionTpsl, reduceOnly, orderType, origSz, tif, cloid},"status":"filled","statusTimestamp":…}}` — the same order object as `historicalOrders`; found by oid and by cloid alike |
| `userRole {user}` | `{"role":"user"}` for an account, `{"role":"missing"}` for an address the venue has never seen (our throwaway wallet and trading key), `{"role":"agent","data":{"user":"0x20a0…d92e"}}` for an API wallet of an existing account — all three seen live |
| `activeAssetData {user, coin}` | `{user, coin, leverage: {type, value}, maxTradeSzs, availableToTrade, markPx}` — answered for any address (default 20× cross on BTC) |
| `extraAgents {user}` (not used) | `[{name, address, validUntil}]` |

In recorded order histories a cancelled order keeps its remaining size in `sz` (e.g. `sz 0.00226`, `origSz 0.00288`,
`canceled`), a filled one has `sz 0.0`: the engine takes the filled size as the larger of `origSz − sz` and the sum of the
fills carrying the client order id, and the average price from the fills.

**Testnet proof of the two keys** — `npx tsx scripts/hl-live-testnet.mts --record`, 2026-11-11 04:32 UTC, recorded in
`test/fixtures/hyperliquid/testnet-live-proof.json` and replayed by `test/hyperliquid/live-proof.test.ts`. Throwaway seed in
memory; real signer class behind its HMAC channel, real API routes, real exchange prices; 5 requests to the testnet exchange
endpoint per run (two runs were made), none to mainnet (the script refuses the mainnet host before sending).

| Sent to `https://api.hyperliquid-testnet.xyz/exchange` | Answer (HTTP 200) |
|---|---|
| `approveAgent` signed by the wallet key `0xe062…400f`, naming the trading key `0x78d1…f5c8` (through the API's authorization route, then once more directly) | `{"status":"err","response":"Must deposit before performing actions. User: 0xe06252f11d8beac14b7f8a026dd02febdba1400f"}` |
| `order` (post-only buy 0.0002 BTC @ 73070, `expiresAfter = nonce + 90 s`) signed by the trading key after a passkey approval | `{"status":"err","response":"User or API Wallet 0x78d1c6e0bee0f04b2ca06d5e03f14f20f15cf5c8 does not exist."}` |
| `cancelByCloid` signed by the trading key, no passkey | same answer, naming `0x78d1…f5c8` |
| `updateLeverage` 3× cross signed by the trading key after a passkey approval | same answer, naming `0x78d1…f5c8` |

The venue recovered the wallet key from the approval and the trading key from the three L1 actions: its hashes equal ours,
and the wallet key is nowhere in the trading path. On the API side the refusal of the approval left the account `READ_ONLY`
and revoked the signer authorization. Not proven (needs a funded account): everything after the venue accepts the approval.

**Not verified (live trading)**

- Any accepted action on a funded account: our own approval being listed by `userRole`, an order resting, filling, being
  cancelled, a leverage change, the per-order answers of a real `order` request. The funded path of the script is written
  and has never run.
- What `orderStatus` reports for an IOC order that fills partly (`filled` with a remaining `sz`, or `canceled`): the engine
  handles both; the tests' fake venue answers `canceled`.
- The venue's wording when an action arrives after its `expiresAfter`, or with a reused nonce (the tests' fake does not model them).
- That `orderStatus` finds an order by cloid immediately after it is accepted, and how long after it is closed.
- How quickly `userFills` shows a fill after the order status changes (the engine waits up to a minute for the fills to add
  up before it stops watching a finished order, and needs two consecutive passes to declare a divergence).
- Whether the venue lets the same API-wallet address be approved again after a revocation and a new authorization (same
  name, same address) — expected from "an agent of the same name is replaced", not tried.
- The address-based rate limit (1 request per USDC traded, 10 000 initial) on a new account under real use; the engine's own
  load is about 110–150 weight per order (proposal + approval) and 45–65 per reconciliation pass (every 10 s), against the
  documented 1200 per minute per IP — room for about six orders a minute, which is the default `maxOrdersPerMinute`.

## 14. Funding the venue account (collateral) — facts and what is not built

> Superseded by **section 15** (v6, 2026-11-11): deposit and withdrawal are built. This section is kept as the record of
> what was known and required before; its "not built" statements no longer hold.

The venue account is the wallet's own EVM address. `GET /api/v1/derivatives/live/accounts/:id/collateral` shows, read from
the venue (`clearinghouseState`): equity, collateral (account value without unrealized PnL), free collateral, margin used
and `withdrawable`. **This delivery builds and sends no deposit and no withdrawal.**

How the owner funds the account (sources: section 8 and the venue's "USDC" / bridge page):

- **What:** native USDC on **Arbitrum One** (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`), sent **by the account address
  itself** to the venue's bridge contract `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` (source `hyperliquid-dex/contracts/Bridge2.sol`).
  "The user sends native USDC to the bridge, and it is credited to the account that sent it in less than 1 minute."
- **Minimum:** "The minimum deposit amount is 5 USDC. If you send an amount less than this, it will not be credited and be
  lost forever." The documentation describes native USDC only: anything else sent there must be assumed lost.
- **Fees:** no deposit fee is documented; the transfer costs Arbitrum gas, paid in ETH on Arbitrum by the sending address.
  A withdrawal costs 1 USDC ("at the time of this writing") and takes about 5 minutes.
- **Status of that route:** the venue's page now calls the Arbitrum bridge the legacy route and names Circle CCTP as "the
  preferred method for minting USDC natively on the Hyperliquid L1". Whether the legacy bridge still credits deposits was
  **not tested** (nothing was sent). Before sending anything: read the venue's page again and check the bridge address
  there, then send the minimum first.
- **Testnet:** bridge `0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89`; mock USDC comes from the faucet, which requires a mainnet
  deposit by the same address (section 9), or from another testnet account by `usdSend`.

Mechanically, a deposit is an ordinary USDC transfer on Arbitrum from the wallet's address; the wallet's existing transfer
flow could make it today (passkey, the signer's per-transfer and daily USDC caps apply, the signer allowlist is empty by
default). It is deliberately **not** offered as a venue action here: nothing in the wallet checks the bridge address or the
5 USDC minimum, and a mistake is unrecoverable.

What a later delivery needs, precisely:

1. **Deposit as a first-class intent.** The bridge address pinned in the signer bundle per network (not received from the
   API), listed in the signer policy `allowlist` as `arbitrum:0x2df1…3df7`; a signer-side rule for that destination: asset
   = native USDC only, amount ≥ 5 USDC, source = the wallet address; the UI states the destination by name. Then
   reconciliation of the credit from the venue (`userNonFundingLedgerUpdates`, not read today) before showing it as collateral.
2. **Withdrawal.** The user-signed `withdraw3` action (`{type, hyperliquidChain, signatureChainId, destination, amount, time}`,
   EIP-712 primary type `HyperliquidTransaction:Withdraw`, request nonce = `time`), signed by the **wallet key** — the
   trading key cannot authorize it. The typed-data builder exists and is wired to nothing
   (`buildWithdraw3TypedDataOnly`). Needed: a signer endpoint of its own with a passkey assertion over a canonical
   withdrawal (amount, destination, time, network); **destination fixed to the wallet's own address** by the signer (as
   vault returns are), not chosen by the API; an amount cap in the signer policy; `describe()` extended to return
   `withdraw` for that exact shape, accepted only on that endpoint; reconciliation of the 1 USDC fee and of the arrival on
   Arbitrum (about 5 minutes).
3. **Spot ⇄ perp** (`usdClassTransfer`, user-signed, builder present and unwired) only if the account uses separate spot and
   perp balances; accounts under the "unified account" abstraction are not read correctly today (section 12).

## 15. Collateral: deposit and withdraw, built (v6, 2026-11-11)

Sections 8 and 14 described deposits and withdrawals as facts "not implemented". They are now built; where this section and
those differ, this one is current. Every fact below was read again from its primary source on **2026-11-11** (UTC).

Code: shared rules and the pinned table `packages/derivatives/src/live/collateral.ts`; signer
`services/isolated-signer/src/venue-collateral.ts`; API `services/api/src/derivatives/collateral.ts` + `collateral-routes.ts`;
screens `apps/web/src/derivatives/LiveCollateral.tsx`; routes `docs/v4/API-LIVE-NOTES.md` ("Collateral").

### 15.1 Sources (read 2026-11-11)

| What | Where | What it says |
|---|---|---|
| Venue, "USDC" page | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2 (canonical name of the page: `…/api/usdc`) | "CCTP is the preferred method for minting USDC natively on the Hyperliquid L1." · heading "Legacy Bridge": "The legacy bridge is deprecated." · "The user sends native USDC to the bridge, and it is credited to the account that sent it in less than 1 minute." · "The minimum deposit amount is 5 USDC." "If you send an amount less than this, it will not be credited and be lost forever." · withdrawal: "requires a user wallet signature on Hyperliquid only, and no Arbitrum transaction", "handled entirely by validators", "the funds arrive in the user wallet in 3-4 minutes" · bridge `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` (Arbitrum), testnet `0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89` · `batchedDepositWithPermit` deposits on behalf of another user. No fee is stated on that page. |
| Venue, exchange endpoint | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint | `withdraw3`: `{ type, hyperliquidChain: "Mainnet" \| "Testnet", signatureChainId, amount, time, destination }`, "time: current timestamp in milliseconds as a Number, should match nonce"; "There is a $1 fee for withdrawing at the time of this writing and withdrawals take approximately 5 minutes to finalize." · "User-signed actions … do not support the `expiresAfter` field." · `usdClassTransfer`: "transfer USDC from the user's spot wallet to perp wallet and vice versa". |
| Venue, onboarding | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-start-trading | "You can send USDC on Arbitrum/Ethereum/Base/Polygon to the deposit address shown" (the web interface's own deposit addresses), "You can also transfer USDC from other chains via CCTP."; "The gas is only for depositing." No minimum and no withdrawal fee amount on that page. |
| Venue, account modes | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes | "Unified account" (single balance per asset), "Portfolio margin", "Manual / Standard" ("separate perp and spot balances"); "For API users, unified account and portfolio margin show all balances and holds in the spot clearinghouse state." The default mode of a new account is not stated there. |
| Venue, HyperCore ⇄ HyperEVM | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers | generic tokens: ERC-20 transfer to the token's system address (`0x20…<index>`), "credited to the Core based on the emitted `Transfer` event"; HYPE to `0x2222…2222`; "There are currently no checks that the system address has sufficient supply". USDC is not described there (Circle's `CoreDepositWallet` handles it). |
| Circle, Arbitrum → HyperCore | https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore | `CctpExtension.batchDepositForBurnWithAuth` with an EIP-3009 `ReceiveWithAuthorization` signature; destination domain 19; `mintRecipient` and `destinationCaller` = `CctpForwarder` on HyperEVM ("If either value is wrong, the funds become permanently stuck"); hook data `"cctp-forward"` + version + length + HyperCore recipient + destination dex (0 = perps, `0xffffffff` = spot); forwarding fee 0.20 USDC ("a 10 USDC transfer yields 9.80 USDC on HyperCore"). |
| Circle, addresses | https://developers.circle.com/cctp/references/hypercore-contract-addresses | mainnet: `CctpExtension` (Arbitrum) `0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE`, `CctpExtensionV2` `0x3289e443a95B28Bcedacc4B33C689b0C9b84ffAB`, `CctpForwarder` (HyperEVM) `0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757`, `CoreDepositWallet` (HyperEVM) `0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24`. Not pinned, not used by the wallet. |
| Circle, concept | https://developers.circle.com/cctp/concepts/cctp-on-hypercore | "There is no minimum deposit amount."; "a one-time 1 USDC activation fee, managed entirely by the Hyperliquid protocol" on the first outbound action; "HyperCore balances reflect protocol-level credits, not Circle-issued USDC."; forwarding "has a dynamic destination chain gas fee". |
| Bridge source | https://github.com/hyperliquid-dex/contracts/blob/master/Bridge2.sol and the verified source of `0x2df1…3df7` on https://arbiscan.io (Etherscan API `getsourcecode`, chain 42161) | contract `Bridge2`, solc 0.8.9, optimizer on (1 000 000 runs), not a proxy. The `contract Bridge2 { … }` body of the verified file equals the repository's, comments and whitespace aside (17 119 characters each; SHA-256 of the normalised body `aacd2e02…77c1`). Deployed 2023-11-30 (block 155 689 071, tx `0xd2bfb554…e2da`) by `0x1d4c01e1…1fbc`. |

Secondary sources (third-party guides, found by a web search, not authoritative) say the 1 USDC fee "is deducted from the
withdrawal amount" and that the amount must exceed the fee. The venue's own pages do not say which.

### 15.2 The bridge contract and the trust it adds

Read from the verified source and from the chain (both registry RPC endpoints agree; `scripts/check-hl-bridge.mts`):

- **A deposit is a plain ERC-20 transfer** of native USDC (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`) to the contract. There
  is no deposit function to call for one's own funds; the contract's `Deposit` event is declared and **never emitted** (the
  header comment's "DepositEvent" is stale); the validators watch USDC `Transfer`s into the address. `batchedDepositWithPermit`
  exists for deposits on behalf of another user (not used). Because a deposit does not execute bridge code, **a paused bridge
  still receives transfers** — which is why the API reads `paused()` itself and refuses to deposit while it is true.
- **Not upgradeable, no owner.** No proxy (EIP-1967 implementation slot empty), no `delegatecall`, no `selfdestruct`, no
  `onlyOwner` in the contract body. Runtime bytecode pinned: 19 394 bytes, SHA-256
  `37ff6a58c3c80d99fd85ba0898ba3a5ae8d55b82c4a4d758dd258af3b05fc3c7`.
- **Withdrawals**: `batchedRequestWithdrawals` (anyone may submit; needs signatures of more than 2/3 of the validator power,
  hot keys) records a pending withdrawal; after the dispute period — `disputePeriodSeconds` = **200 s**, counted in time and
  in blocks — a **finalizer** calls `batchedFinalizeWithdrawals`, which pays `usd` to `destination`. That is the "3–4 minutes".
- **Who can stop or change it**: any `lockerThreshold` (= **2**) lockers can pause it (`voteEmergencyLock`); unpausing
  (`emergencyUnlock`), replacing the validator set, invalidating pending withdrawals (`invalidateWithdrawals`), changing the
  dispute period, the block duration and the locker threshold need a quorum (> 2/3 of power) of the validators' **cold** keys;
  adding lockers/finalizers needs the hot quorum, removing them the cold one.
- State on 2026-11-11: `nValidators` = **4**, `totalValidatorPower` = 4, `epoch` = 7, not paused, no locker voting to lock,
  119.05 M USDC held.

Trust added by depositing: (1) the USDC leaves the wallet and is held by this contract, releasable by 3 of 4 validator hot
keys after a 200 s dispute window that 2 lockers can use to freeze it; (2) the credit on the venue is an off-chain act of the
same validators — nothing on Arbitrum forces it; (3) the venue calls this route **deprecated**: it works today (15.3) and may
be switched off, which the wallet cannot learn from the chain. Mitigations built: the bytecode and `paused()` are checked on
two RPC sources before every deposit, and the API refuses to prepare a deposit unless the venue's ledger shows that it
credited the most recent deposits made through the bridge (15.5).

### 15.3 Is the legacy bridge still crediting? Evidence of 2026-11-11

`node scripts/check-hl-bridge.mts --samples 8` (read-only: JSON-RPC reads on Arbitrum, `POST /info` on the venue; full output
recorded in `docs/v4/venues/hyperliquid-bridge-evidence-2026-11-11.json`). Window: Arbitrum blocks 523 181 723 – 523 201 683
(about 83 minutes before 06:14 UTC): **74** USDC transfers into the bridge, **84** out of it. Each sampled log was read on
`arb1.arbitrum.io` and confirmed by its receipt on a second endpoint (`arbitrum.drpc.org`; the registry's second endpoint,
publicnode, refuses receipts and logs older than a few minutes without a token — it did confirm bytecode and state).

| Arbitrum transfer into the bridge (UTC) | From | USDC | Venue ledger of the SAME address (`userNonFundingLedgerUpdates`) |
|---|---|---|---|
| 04:39:04 `0xcfd025fb…` | `0x008407e2…39e4` | 2064.077644 | `deposit` 2064.077644, 6 s later |
| 04:53:12 `0x401821c5…` | `0xcc1c32da…f9bb` | 128.314783 | `deposit` 128.314783, 7 s later |
| 05:13:35 `0x3a12cc4b…` | `0xe0e03770…a3b0` | 10.704146 | `deposit` 10.704146, 11 s later |
| 05:21:17 `0xf283f1c7…` | `0x9560ae0c…d37d` | 84.79 | `deposit` 84.79, 7 s later |
| 05:45:39 `0x5fd00699…` | `0x032521c5…cf05` | 97 | `deposit` 97.0, 9 s later |
| 05:50:39 `0x54f9369c…` | `0xf18db14a…8117` | 5002.501251 | `deposit` 5002.501251, 8 s later |
| 06:03:11 `0xb8cad3c9…` | `0x735ec2a0…8ad2` | 100.785593 | `deposit` 100.785593, 8 s later |
| 06:09:19 `0xd7115c2d…` | `0xd61f4cc6…fe5e` | 1000.045991 | `deposit` 1000.045991, 7 s later |

8 of 8 credited, to the sending address, in 6–11 s. Two earlier runs the same morning (05:44 and 05:48 UTC) gave 6/6 and
8/8, among them a deposit of exactly **5 USDC** (`0xfefa07f0…`, credited 7 s later) and of **6 USDC** (`0x81fe3e9f…`, 8 s).
The ledger entry's `hash` **is the Arbitrum transaction hash** (seen on the 6 USDC deposit: entry hash `0x81fe3e9f8b63fe94…`),
which is what the wallet uses to recognise its own deposit. No deposit below 5 USDC occurred in the windows read, so "below
the minimum is lost" rests on the venue's page alone.

Withdrawals in the same window, matched on the destination's own account (half of the payouts go to an address that is not
the account that asked — an exchange, another wallet — and cannot be matched this way):

| Payout on Arbitrum (UTC) | To | USDC received | Venue ledger |
|---|---|---|---|
| 05:09:00 | `0xc5ae0ec3…8b11` | 23.751098 | `withdraw` usdc 23.751098, fee 1.0, nonce 1794373505553000 → asked 234 s earlier |
| 05:16:28 | `0x62a22e13…556c` | 5.496896 | `withdraw` usdc 5.496896, fee 1.0, asked 235 s earlier |
| 05:43:53 | `0x6ff07e78…5c5c` | 489 | `withdraw` usdc 489.0, fee 1.0, asked 234 s earlier |
| 05:58:29 | `0x887f8444…4ba5` | 4.7 | `withdraw` usdc 4.7, fee 1.0, asked 241 s earlier |

Read from these: the ledger's `usdc` is the amount **received**; `fee` is `"1.0"`; `nonce` is the request's `time` in
microseconds (`time × 1000`); the entry is dated a few seconds after the payout; request → payout ≈ 232–241 s.

Shapes read live (mainnet `POST /info`):
`userNonFundingLedgerUpdates {user, startTime[, endTime]}` → `[{ time, hash, delta: { type: "deposit", usdc } | { type: "withdraw", usdc, nonce, fee } | … }]`;
`userAbstraction {user}` → `"default" | "unifiedAccount" | …`; `spotClearinghouseState {user}` → `{ balances: [{ coin, token, total, hold, entryNtl }] }`.

### 15.4 Who is credited, and where the money lands

- **The sender is credited** (venue page; every sampled deposit: 22 lookups over three runs, about 20 distinct deposits). The wallet's EVM address is the venue account, so a
  transfer from the wallet funds the owner's account. The signer refuses a deposit whose `from` is not its own address, and the
  screen refuses to ask for the passkey if the prepared sender is not the venue account.
- **Perp margin, in the default mode.** `0xeeab2d67…f55f` (`userAbstraction` = `"default"`) deposited 6 + 6 USDC at 05:32 and
  05:33 UTC; at 05:47 its `clearinghouseState` showed `accountValue` 11.995209, `withdrawable` 10.961603 and an open BTC
  position, its `spotClearinghouseState` no balance. An address that never chose a mode answers `"default"` (seen on an
  address the venue only knows from transfers). So for the owner's fresh account **no `usdClassTransfer` is needed** before
  trading perpetuals — it is **not built**, and the signer cannot sign it.
- Accounts that switched to "unified account" in the venue's interface (`0x5d7bd23d…6cef`, `0x05db0be6…2680`) show the same
  deposits in the **spot** state and zeros in `clearinghouseState`. The collateral screens read `userAbstraction` and, when it
  is not `default`, the spot USDC as well (`venueBalance.total`). The trading engine still reads `clearinghouseState` only
  (section 12): an account switched to unified mode from the venue's interface is not traded correctly from the wallet.
- **Deposit before authorizing.** The venue refuses every action of an account that never deposited ("Must deposit before
  performing actions", sections 9 and 13) — including the `approveAgent` of the authorization. The deposit therefore needs no
  authorization and comes first.

### 15.5 The route offered, and why

**One route: native USDC on Arbitrum One → the Bridge2 contract (the venue's "legacy bridge").**

| | Arbitrum Bridge2 (offered) | Circle CCTP: Arbitrum → HyperCore (`CctpExtension`) | Wallet's CCTP to HyperEVM, then `CoreDepositWallet` |
|---|---|---|---|
| Proven to credit today | yes — every sampled real deposit (about 20), 6–11 s | not observed by us | not observed by us |
| What the main key signs | one USDC `transfer` (an existing, tested shape) | an EIP-3009 `ReceiveWithAuthorization` typed message **and** a contract call — a new kind of signature | burn, mint, approval, deposit: four transactions on two chains |
| New contracts to pin and review | 1 (immutable, 2023) | `CctpExtension`, `CctpForwarder`, `CoreDepositWallet`, the forwarding service | `CoreDepositWallet` + HYPE for gas on HyperEVM |
| Fee to the venue / Circle | 0 | 0.20 USDC forwarding (2 % of 10 USDC) | 0, plus gas on both chains |
| Other costs | — | "1 USDC activation fee" on the account's first outbound action (Circle) | same |
| Failure mode | below 5 USDC: lost (refused by the app at < 6) | wrong `mintRecipient` / `destinationCaller` / hook data: "permanently stuck" | wrong function or recipient: unknown |
| Status | "deprecated" by the venue, working | "preferred" by the venue | — |

For an owner holding tens of dollars under a 50 USDC per transfer limit, the bridge is the route with the fewest moving
parts and the only one whose result was observed. Its one real weakness — the venue may retire it — is handled by refusing
to prepare a deposit unless the route is seen to credit right now (below). CCTP to HyperCore is the route to build when the
venue announces an end date for the bridge; the wallet's existing CCTP (section "cross-network transfer") already brings
USDC **to Arbitrum** from Ethereum, Base, Optimism, Polygon, Avalanche and HyperEVM, and the deposit screen links to it,
pre-filled, when the wallet holds USDC elsewhere. Nothing is bridged silently.

Numbers the wallet enforces: venue minimum **5 USDC**; wallet floor **6 USDC** (API and signer both refuse less); deposits are
ordinary USDC sends for the signer's policy — **50 USDC per transfer, 100 per day** on `arbitrum:USDC` by default, shared
with other USDC sends on Arbitrum, fee ceiling 0.0003 ETH; a non-empty signer allowlist must contain
`arbitrum:0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` (it is empty by default). Cost of a deposit: Arbitrum gas only (45 059
gas on the fork). Withdrawal: venue fee **1 USDC**, no gas for the owner, about **4 minutes**.

### 15.6 What was built

**Deposit** — an intent the signer recognises: an ordinary wallet intent (`packages/core/src/intent.ts`) with a section
`venueDeposit: { venue: "hyperliquid", venueNetwork: "mainnet", route: "arbitrum-bridge2", bridge, minAmount }`, part of the
canonical bytes the passkey signs. `Signer.sign` calls `venueDepositVerdict` for every intent:

- with the section: venue network → pinned chain (Arbitrum One, 42161); asset = the pinned token, which must also be the
  registry's native USDC there; `to` = the section's bridge = the pinned bridge; `from` = the signer's own address; amount ≥
  6 USDC and `minAmount` = that floor; no swap, bridge or memo. Then the unchanged policy (per transfer, per day, fee ceiling,
  approval window, allowlist, halt), the passkey over the intent hash, the replay cache; the signer builds the transaction.
- without the section: **any transfer to a venue bridge address (mainnet or testnet, on any network) is refused** — the
  minimum cannot be bypassed with a plain send, and the generic transfer screen can no longer lose money there.

The API (`prepareDeposit`): account = the wallet's address; mainnet setting; halt; no other deposit in flight and no
unconfirmed transfer on Arbitrum; **guards** on both RPC endpoints (bytecode hash = pin, `usdcToken()` = pin, `paused()` false,
no code on the wallet address); **liveness** (the 3 most recent transfers ≥ 5 USDC into the bridge, older than a minute, in
the last 10 minutes or else the last hour: at least one must be in the venue's ledger, else `503 route_not_proven`); balance
(with the list of networks that hold USDC when Arbitrum does not); gas estimate and simulation by the wallet's EVM adapter; the
same `checkVenueDepositIntent` + `buildEvmTx` + `checkPolicy` as the signer; then the proposal and the WebAuthn request. At
approval the guards run again. After the broadcast the wallet's own worker tracks the transaction; the collateral worker reads
the venue's ledger every 10 s and marks the deposit `credited` only on a `deposit` entry whose hash is our transaction.

**Withdrawal** — canonical object `VenueWithdrawal` (`SPW-VENUE-WITHDRAW-v1`), passkey over its SHA-256, `POST /venue/withdraw`
on the signer: key id; account = destination = the signer's **own derived address** (anything else: `wrong_destination`);
amount > fee, fee = 1; `time` within (now − 300 s, now + 60 s] and above every `time` already signed for that network;
approval window ≤ 300 s; ≤ 10 signatures a day; no halt; never the same id twice. The action is built by the signer
(`buildVenueWithdraw` → the SDK's `withdraw3` typed data: domain `HyperliquidSignTransaction`, chain id `0x66eee`, primary
type `HyperliquidTransaction:Withdraw`, `hyperliquidChain` from the network, `nonce` = `time`) and read back field by field
before the main key signs. The API checks the answer (same hash, same action, signature recovers to the account), stores it,
and posts `{ action, nonce, signature, vaultAddress: null, expiresAfter: null }`; mainnet only with the server setting.
`ok` → `submitted`; `err` → `rejected` with the venue's words; no readable answer → `unknown`: the identical bytes are sent
again (the venue takes a nonce once) at most 3 times, 20 s apart, and the outcome is decided by the venue's ledger or the
wallet's chain scan, never assumed; after 30 minutes without a trace it ends `rejected`. `completed` needs the USDC seen by
the wallet's own deposit scan (a transfer from the bridge of the ledger's `usdc`, or of amount − fee / amount before the ledger
entry exists).

No amount cap was added to withdrawals: the only possible destination is the wallet itself.

**Testnet.** No deposit route: the testnet bridge is on Arbitrum Sepolia, which is not one of the wallet's networks, and testnet
collateral is mock USDC from the venue's faucet (section 9). Withdrawals are signed for `Testnet` and sent to the testnet
endpoint; the payout chain is not followed, so a testnet withdrawal is `completed` when the venue's ledger shows it.

### 15.7 Proofs (no real funds, nothing sent to mainnet)

- `npx tsx scripts/fork-hl-deposit.mts` — anvil fork of Arbitrum One at block 523 201 495, fresh random key funded on the
  fork: bytecode = pin, not paused; refusals (4 USDC, 5.999999 USDC, another destination, ETH, a plain send of 2 USDC to the
  bridge, no passkey); then the 10 USDC deposit signed by the real signer class and mined on the fork: receipt status 1,
  45 059 gas, one `Transfer(wallet → 0x2Df1…dF7, 10 USDC)`, **0 events from the bridge itself**, wallet −10, bridge +10, replay
  refused. The Hyperliquid side cannot be forked: nothing here says the venue would credit it — 15.3 does, from other
  people's real deposits.
- `npx tsx scripts/hl-withdraw-testnet.mts --send --record` — real signer class, throwaway seed in memory: refusals (another
  destination, amount = fee, no passkey, passkey over another amount); a Testnet and a Mainnet `withdraw3` whose signatures
  recover to the wallet address from the typed data (the Mainnet one is sent nowhere); the Testnet one posted to
  `https://api.hyperliquid-testnet.xyz/exchange` → HTTP 200
  `{"status":"err","response":"Must deposit before performing actions. User: 0xca8cc61fb8284f0728f6ed196ceb941c3f969f98"}` —
  the venue recovered our address from the signature, so its hash of the action equals ours (fixture
  `test/fixtures/hyperliquid/testnet-withdraw-proof.json`, replayed by `test/hyperliquid/withdraw-proof.test.ts`).
- `npx tsx scripts/smoke-hl-collateral.mts` — the API's own guards and liveness check against the real endpoints, read-only:
  bytecode pinned on both RPC endpoints, not paused; "3 of the 3 most recent deposits into the bridge are in the venue's ledger".
- `withdraw3` typed data against the official SDK: `tests/signing_test.py::test_sign_withdraw_from_bridge_action` and the two
  cross-vectors of `sdk-vectors.json`, through `buildVenueWithdraw` (`services/isolated-signer/test/venue-collateral.test.ts`).

### 15.8 Not verified

- **Our own deposit.** Nothing was sent to the bridge. That the venue credits a deposit made by THIS wallet is inferred from
  about 20 deposits by other addresses the same morning. First real use: start with the minimum the app allows (6 USDC).
- **Deposits below 5 USDC are lost**: the venue's statement only; none was observed.
- **Any accepted withdrawal.** The venue answered our `withdraw3` only with "Must deposit before performing actions". Not
  seen from our side: an `ok` answer and its exact shape, the ledger entry appearing for our own account, when it appears (at
  request or at payout — the four samples are dated just after the payout), the arrival being matched by the wallet's scan.
- **Whether the 1 USDC fee is taken out of the amount or on top of it.** The screens say "you will receive amount − 1" (the
  ledger shows `usdc` received + `fee`; third-party guides say "deducted from the amount"). The reconciliation accepts both
  and records what really arrived.
- **A minimum withdrawal amount** on the venue (the wallet requires amount > 1 USDC), and the venue's words for a withdrawal
  it refuses on a funded account (insufficient balance, open positions, duplicate nonce). The tests' fake invents them.
- **`nonce` in the ledger = `time × 1000`**: seen on four third-party withdrawals; the wallet accepts `time` and `time × 1000`.
- **Unified-account / portfolio-margin accounts**: where a bridge deposit lands for them and what `withdraw3` draws from were
  not tested; the owner's account is expected to be in the default mode (it has never used the venue's interface).
- **The `default` mode of a brand-new account that deposits through the bridge**: inferred from one depositor in that mode
  and from never-configured addresses answering `"default"`; not from a new account of ours.
- **The CCTP → HyperCore route**: documentation only; no contract of it was read, pinned or called.
- **A paused bridge** and what the venue does with deposits made while it is paused; **retirement of the bridge** (how the
  venue would announce it; whether late deposits would be credited or returned).
- **The wallet's deposit scan as arrival detector in production**: it reads `Transfer` logs to the wallet address with a
  bounded catch-up (20 000 blocks ≈ 83 minutes on Arbitrum): after a longer outage of the API a payout could be missed by the
  scan, the withdrawal would stay `submitted`/overdue while the money is in the wallet (the balance shows it; the ledger
  entry completes nothing on mainnet without the arrival).
- **The screens against the real backend.** The sheets were driven in a browser (phone and desktop) against the in-browser
  mock only (`tests/e2e/futures-collateral.spec.ts`, 6 tests: minimum refused, review, "waiting for the venue", credited,
  overdue checklist, wrong passkey, USDC on another network, withdrawal to arrival; screenshots `docs/v4/screens/collateral-*.png`).
  In that mock time stands in for the chain and the venue (`apps/web/src/derivatives/mockCollateral.ts`). The same screens
  against the real API, signer and venue were not driven: no funded account exists.
- **The venue's own interface** named in the overdue checklist ("Portfolio → Deposits and Withdrawals" on
  app.hyperliquid.xyz): written from memory of that interface, not checked.
- **publicnode as second RPC for history**: it refused `eth_getLogs` / receipts older than a few minutes without a token on
  2026-11-11. The API's liveness check uses `rpcAny` (first endpoint that answers); the guards use both endpoints (current
  state only), which worked.

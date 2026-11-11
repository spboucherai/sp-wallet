# Hyperliquid — venue dossier

Checked against the official documentation, the official Python SDK and the live public API on **2026-11-10 / 11** (UTC 2026-11-11).
Adapter: `packages/derivatives/src/venues/hyperliquid/` (entry point `@spw/derivatives/hyperliquid`). Scope: **perpetuals of the first perp
dex** (the validator-operated USDC dex). Out of scope: spot, builder-deployed dexes (HIP-3), outcome markets (HIP-4), TWAP, order
modification, sub-accounts, vaults, deposits and withdrawals.

**Nothing was sent to the mainnet exchange endpoint.** Mainnet was used read-only (`POST /info`, websocket subscriptions). The testnet
exchange endpoint received 12 requests signed by a key generated in memory by `scripts/hl-testnet.mts` and discarded (section 9).

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

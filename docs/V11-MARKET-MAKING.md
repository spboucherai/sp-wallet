# V11 — market making on Hyperliquid: design of the core

Status: **integrated, locked off by default** (2026-11-16, branch `v11-mm-live`). Sections 1–11 are the design of the core
as the foundations wrote it; **section 12 is the system as built** and **section 13 the runbook**. Where they differ, 12 and 13
are right (the differences are listed at the top of 12). Nothing here was ever sent to a venue; no key other than test vectors
and a throwaway random key was used; no funded account, mainnet or testnet, was touched. Every proof runs on a venue double
with the real signer code, on recorded public data, and on paper. Work notes: `docs/v11/work/mm-core.md` (foundations),
`docs/v11/work/mm-live.md` (integration).

Code: canonical mandate `packages/derivatives/src/live/quoting.ts`; venue primitives
`packages/derivatives/src/venues/hyperliquid/{trading,quoting-round,reconcile}.ts`; signer
`services/isolated-signer/src/venue-quoting.ts` (+ `venue-read.ts`, `store.ts`); quoting core `packages/trading/src/mm/`
(entry point `@spw/trading/mm`); compilation and the quoting section `packages/trading/src/mandate/quoting-mandate.ts`; engine
and ports `services/api/src/mm/{engine,ports,live-adapter}.ts`; integration `services/api/src/mm/{runtime,sessions,
user-stream,budget,market-data,paper-venue,quoting-mandate,lifecycle,routes,bind,register}.ts`. Tests:
`services/isolated-signer/test/venue-quoting.test.ts`, `packages/derivatives/test/hyperliquid/mm-primitives.test.ts`,
`packages/trading/test/{mm,quoting-mandate}.test.ts`, `services/api/test/{mm-engine,mm-live,mm-units,agent-stream}.test.ts`
(venue double: `services/api/test/mm-sim-venue.ts`).

## 1. What changes, in one paragraph

Today the only passkey-less trading authority is the derivative mandate `SPW-VENUE-MANDATE-v1`: one order per signature,
≤ 60 exposure-adding orders an hour, any order type. It cannot express two-sided resting quotes. This work adds a **second,
separate** standing authority, `SPW-VENUE-QUOTING-MANDATE-v1`, approved with the passkey through the same ceremony, under
which the signer signs only: batches of **post-only (`Alo`) limit quotes**, batches of **reduce-only** limit orders,
**cancels**, and the venue's **dead man's switch** (`scheduleCancel`). The v1 mandate is untouched (same bytes, same
behaviour, pinned by a regression test); the two exclude each other on a venue account.

## 2. Hyperliquid facts relied upon

Read on **2026-11-15** from the official documentation (prefix `D` = `https://hyperliquid.gitbook.io/hyperliquid-docs`).
Quotes are verbatim. "Not stated" means the documentation does not say, and the design does not rely on it.

| Topic | What the documentation says | Page |
|---|---|---|
| `Alo` | "ALO (add liquidity only, i.e. "post only") will be canceled instead of immediately matching." Per-order error "Post only order would have immediately matched, bbo was {bbo}."; status `badAloPxRejected` | `D/for-developers/api/exchange-endpoint`, `…/error-responses`, `…/info-endpoint` |
| `Ioc`, `Gtc` | "IOC (immediate or cancel) will have the unfilled part canceled instead of resting." "GTC (good til canceled) orders have no special behavior." | `…/exchange-endpoint` |
| batch `order` | `{type:"order", orders:[{a,b,p,s,r,t,c?}], grouping, builder?}`; statuses vector `resting` / `filled` / `error`, one per order; some errors are returned once for the whole payload (pre-validation). Maximum batch length: **not stated** | `…/exchange-endpoint`, `…/error-responses` |
| cancels | `cancel` `{a,o}`, `cancelByCloid` `{asset,cloid}`; optional fast flag `f` ("must be skipped if false"); error "Order was never placed, already canceled, or filled." | `…/exchange-endpoint` |
| `scheduleCancel` | "Schedule a cancel-all operation at a future time. Not including time will remove the scheduled cancel operation. The time must be at least 5 seconds after the current time. Once the time comes, all open orders will be canceled and a trigger count will be incremented. The max number of triggers per day is 10. This trigger count is reset at 00:00 UTC." Whether a new time replaces the previous one: **not stated** (assumed; see §6) | `…/exchange-endpoint` |
| `expiresAfter` | "a timestamp in milliseconds after which the action will be rejected … actions consume 5x the usual address-based rate limit when canceled due to a stale `expiresAfter` field." It is a deadline for the ACTION, not a lifetime of the order; Hyperliquid has no good-til-time order | `…/exchange-endpoint` |
| `modify` / `batchModify` | a cancel plus a new order; "When `always_place = false` the new order must be a non-trigger order, and must have TIF = ALO or a non-executable order with TIF = GTC." Atomicity and queue priority: **not stated** | `…/exchange-endpoint` |
| cloid | "an optional 128 bit hex string". Uniqueness enforced by the venue: **not stated** | `…/exchange-endpoint` |
| nonces | "the 100 highest nonces are stored per address. Every new transaction must have nonce larger than the smallest nonce in this set and also never have been used before." "Nonces must be within (T - 2 days, T + 1 day)". "batch … every 0.1 seconds … batch IOC and GTC orders separately from ALO orders because ALO order-only batches are prioritized by the validators." | `…/nonces-and-api-wallets` |
| API wallet powers | "API wallets are only used to sign." Withdrawals and Core USDC transfers are user-signed actions (main key). Whether an agent can withdraw: **not stated explicitly**; the wallet's signer never signs anything but the actions of §4 with the trading key anyway | `…/nonces-and-api-wallets`, `…/exchange-endpoint` |
| IP rate limit | "REST requests share an aggregated weight limit of 1200 per minute." Exchange actions: "weight of `1 + floor(batch_length / 40)`". Info weight 2: `l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus`; `userRole` 60; "All other documented `info` requests have weight 20." | `…/rate-limits-and-user-limits` |
| address rate limit | "1 request per 1 USDC traded cumulatively since address inception … initial buffer of 10000 requests. When rate limited, an address is allowed one request every 10 seconds. Cancels have cumulative limit `min(limit + 100000, limit * 2)` … A batched request with `n` orders (or cancels) is treated as one request for IP based rate limiting, but as `n` requests for address-based rate limiting." | same |
| open orders | "default open order limit of 1000 plus one additional order for every 5M USDC of volume, capped at a total of 5000" | same |
| buying requests | `reserveRequestWeight`: "reserving additional actions for 0.0005 USDC per request" | `…/exchange-endpoint` |
| minimum order | error `MinTradeNtl`: "Order must have minimum value of $10." | `…/error-responses` |
| tick / lot | "Prices can have up to 5 significant figures, but no more than `MAX_DECIMALS - szDecimals` decimal places where `MAX_DECIMALS` is 6 for perps … Integer prices are always allowed" ; "Sizes are rounded to the `szDecimals` of that asset." | `…/tick-and-lot-size` |
| self-trade | "Trades between the same address cancel the resting order instead of causing a fill." | `D/trading/self-trade-prevention` |
| fees (perps, tier 0) | taker 0.045 %, **maker 0.015 %**; maker 0 % only above 500 M USD of 14-day volume; rebates −0.001 % / −0.002 % / −0.003 % above 0.5 % / 1.5 % / 3 % of the venue's 14-day maker volume. "Maker rebates are paid out continuously on each trade". | `D/trading/fees` |
| ordering | "cancels and ALO orders sent at time `t` will almost always execute before IOC and GTC orders sent at time `t`"; within the last 400 ms of a level, ALO orders are re-sorted by priority fee | `…/optimizing-latency`, `…/priority-fees` |
| info shapes | `userRateLimit` → `{cumVlm, nRequestsUsed, nRequestsCap, nRequestsSurplus}` (confirmed live on the zero address: cap = 10000 + ⌊cumVlm⌋); `orderStatus` by oid **or cloid**; `userFills` rows carry `oid`, no `cloid` | `…/info-endpoint` |

## 3. Threat model for autonomous quoting

The boundary is the one of ADR 0001: the API process holds an HMAC secret and nothing else; the signer holds the trading
key and decides from the payload and its own state and reads.

| # | Threat | What bounds it | Where |
|---|---|---|---|
| T1 | **Compromised API process** (holds the HMAC secret) | it can obtain only the four action kinds of §4. A quote is never signed at or through the signer's own mid: a bid ≤ mid × (1 − minHalfSpread), an ask ≥ mid × (1 + minHalfSpread). Inventory, resting counts and resting notional are bounded from the signer's own read. Reductions are priced inside `maxReduceDeviationBps` of the signer's mid. What it CAN do: quote where it knows it will be picked off, then reduce at the edge of the band — a loss per round trip of at most about (staleness of the signer's mid + reduce band) × inventory, repeated inside the rate and turnover limits until the account value reaches `floorEquity`, where openings stop | signer |
| T2 | **Buggy strategy** (wrong prices, wrong sizes, a loop) | same signer bounds (the "deliberately buggy policy" test); before that the planner's own invariants (never a crossing pair, never above the budget, never above the inventory limits) and the API risk port | signer, then API |
| T3 | **Stale or wrong market data in the API** | the signer prices from Coinbase + Kraken itself; a quote computed from a wrong book fails the band. In the API: data-age and venue-status breakers pull the quotes | signer + API |
| T4 | **Venue outage with resting orders** | nothing can be cancelled while the venue is down; the dead man's switch is venue-side state and fires at its deadline if the venue is processing blocks at all. The engine reconciles before quoting again | venue + API |
| T5 | **API crash with resting orders** | the heartbeat stops; the venue cancels every open order at the switch's deadline (≤ `deadManSeconds`, itself ≤ 120 s). On restart: cancel-all → reconcile → arm → quote | venue (armed by the signer rule) |
| T6 | **Signer crash or unreachable** | no new signature: no quote, no heartbeat → the switch fires. Cancels cannot be signed either during that time; that is why the switch must already be armed before the first quote | venue |
| T7 | **Runaway order loop** | token bucket persisted in the signer (burst + per-minute refill), orders per hour and per day, daily turnover — all compiled-bounded; a restart of the signer does not refill them. In the API: planner budget from `userRateLimit` | signer + API |
| T8 | **Inventory blow-up on a trend** | signer: worst-case inventory per instrument and gross (position + every resting and pending quote on that side + the batch); API: soft limit stops the side, hard limit unwinds reduce-only | signer + API |
| T9 | **Adverse selection** | not preventable. Measured (1 s / 10 s / 60 s markouts per fill), and a breaker pulls the quotes on a fill burst or on markouts below a threshold | API only |
| T10 | Replay / smuggling | strict action schemas (any extra field — `builder`, `f`, priority grouping, vault — is a refusal), canonical key order, nonce single-use, action expiry ≤ 30 s for quotes, client ids single-use while live | signer |

## 4. The quoting mandate (`SPW-VENUE-QUOTING-MANDATE-v1`)

It extends a `MANUAL_LIVE` venue authorization exactly like the directional mandate: same venue, network, account and
trading key; narrower than the authorization on every shared limit; it dies with it. Canonical bytes = the same
length-prefixed (name, value) encoding with its own domain tag; the passkey's challenge is the SHA-256 of those bytes.

```ts
VenueQuotingMandate { v: 1, mandateId, authorizationId, keyId, venue: "hyperliquid", network, account, agentAddress,
  strategySha256, agentId,                                   // audit only
  instruments: [{ instrument,                                // ⊂ authorization ⊂ pinned BTC / ETH / SOL
      maxLeverage,                                           // venue leverage SETTING above which no quote is signed
      maxQuoteNotional,                                      // one quote: size × max(price, signer mid)
      maxRestingPerSide,                                     // resting + pending + batch, per side
      maxRestingNotionalPerSide,                             // same set, in USD
      maxInventoryNotional }],                               // worst case: |position| + every same-side quote
  maxRestingTotal,                                           // all instruments, both sides
  maxGrossExposure,                                          // Σ instruments of the worst case
  minHalfSpreadBps, maxDistanceBps,                          // quote band around the signer's own mid
  maxReduceDeviationBps,                                     // price band of a reduce-only order
  floorEquity,
  rate: { burstActions, actionsPerMinute, ordersPerHour, ordersPerDay, dailyTurnover },
  deadManSeconds,                                            // the switch must be armed and at most this far away
  createdAt, expiresAt, ackSha256 }
```

### Compiled bounds (the owner cannot approve beyond them)

| Constant | Value | Bounds |
|---|---|---|
| `maxDays` | 7 | `expiresAt − createdAt`. A week: quoting is the highest-frequency passkey-less authority of the wallet; a weekly passkey approval keeps the owner in the loop and bounds a forgotten mandate. The directional mandate keeps 30 days |
| `maxInstruments` | 3 | and each must be in the pinned table (BTC, ETH, SOL) |
| `maxLeverage` | 10 | per instrument, and ≤ the authorization's and the pinned venue maximum |
| `maxQuoteNotional` | 2 000 USD | per quote |
| `maxRestingPerSide` | 5 | per instrument and side |
| `maxRestingTotal` | 20 | whole mandate |
| `maxRestingNotionalPerSide` | 10 000 USD | |
| `maxInventoryNotional` | 20 000 USD | and ≤ the authorization's `maxPositionNotional` |
| `maxGrossExposure` | 50 000 USD | and ≤ the authorization's |
| `minHalfSpreadBps` floor | 1 bps | the owner may choose more, never less: no quote is ever signed closer than 1 bps to the signer's mid |
| `maxDistanceBps` ceiling | 500 bps | and > `minHalfSpreadBps`, ≤ the authorization's price band |
| `maxReduceDeviationBps` | 10 … 300 bps | ≤ the authorization's price band |
| `burstActions` | ≤ 20 | token-bucket capacity (one token per signed opening batch) |
| `actionsPerMinute` | ≤ 60 | bucket refill |
| `ordersPerHour` | ≤ 3 600 | quotes signed, rolling UTC hour key |
| `ordersPerDay` | ≤ 20 000 | quotes signed per UTC day |
| `dailyTurnover` | ≤ 2 000 000 USD | Σ notional of quotes signed per UTC day |
| `maxBatch` | 20 | orders per action |
| `deadManSeconds` | 10 … 120 | |
| `QUOTING_ACTION_MAX_TTL_MS` | 30 000 | `expiresAfter − nonce` of a quote batch or a `scheduleCancel` |
| `DMS_MIN_AHEAD_MS` | 6 000 | a `scheduleCancel` time must be ≥ now + 6 s (venue minimum 5 s) |
| `DMS_COVER_MARGIN_MS` | 2 000 | a quote batch is signed only if the armed deadline ≥ its `expiresAfter` + 2 s |
| `DMS_MAX_LAPSES_PER_DAY` | 8 | venue maximum 10 triggers per UTC day |
| wind-down | 24 h | as the directional mandate (`VENUE_MANDATE_WIND_DOWN_S`) |

The USD ceilings are deliberately far above the wallet's stated scope (tens of USD): they are a backstop against an
unbounded approval, not a recommendation. The values the owner chooses are the real limits.

### What the signer signs under it, and when

Everything is read by the signer from the payload (`describe`, pinned asset table) and from its own reads.

| Action | Signed when |
|---|---|
| `cancel` / `cancelByCloid` (≤ 40) | authorization alive, mandate not `ended`, instruments in the authorization. Also under the halt, during the wind-down, when the venue or the prices cannot be read. Never counted |
| reduce-only batch (`Ioc`, `Gtc` or `Alo` limit, every order reduce-only, one instrument, ≤ 20) | same + instrument in the mandate, every price within `maxReduceDeviationBps` of the signer's mid, notional ≤ `maxQuoteNotional` each, client id not live. No venue read, no counter |
| `scheduleCancel` with a time | authorization alive, mandate not `ended`; now + 6 s ≤ time ≤ now + `deadManSeconds`. Also under halt / wind-down (it can only cancel). The deadline is stored before the signature leaves |
| `scheduleCancel` without a time (disarm) | only when the signer's own read shows **no open order** on the account and its ledger holds no quote that can still land. Openings are refused until re-armed |
| quote batch (every order `Alo`, limit, not reduce-only, with a client id; one instrument; ≤ 20) | mandate `active`; halt off; **switch armed** (below); bucket, hour, day and turnover counters; signer's own mid available (two sources agreeing, fresh — `prices.ts`, fail closed); every bid in [mid × (1 − maxDistance), mid × (1 − minHalfSpread)], every ask in [mid × (1 + minHalfSpread), mid × (1 + maxDistance)]; each notional ≤ `maxQuoteNotional`; **the signer's own venue read** fresh (≤ 30 s) and consistent; account value ≥ `floorEquity`; leverage setting ≤ `maxLeverage`; after the batch: resting per side, resting notional per side, resting total, worst-case inventory, worst-case gross (also ≤ the authorization's) — all within limits |
| anything else | refused: trigger orders, `Gtc`/`Ioc` openings, `updateLeverage`, `modify`, `batchModify`, TWAP, transfers, withdrawals, agent approvals, vault / sub-account actions, builder fields, priority grouping, a batch mixing quotes and reductions or two instruments |

**The worst case.** Per instrument, with the signer's mid `P`, the position `q` read from the venue, and the set `R` =
every non-reduce-only order the venue lists (whoever placed it) ∪ every order this signer signed for the account that can
still land (ledger) ∪ the batch:

    long  = max(q, 0) × P + Σ_{buys in R}  size × max(price, P)
    short = max(−q, 0) × P + Σ_{sells in R} size × max(price, P)
    worst = max(long, short) ≤ maxInventoryNotional          Σ_instruments worst ≤ maxGrossExposure

This is the directional mandate's `worstCaseExposure` unchanged. Whatever subset of `R` fills, the position stays inside.
Counts and notional per side are taken over the same set `R`.

**The ledger.** A signed quote is in `R` through the ledger until one of three things: (1) the venue **lists** it — same
client id, coin, side and price, not reduce-only, taken after the signature — after which it is counted through the venue's
list; (2) the venue, asked about that very client id (`orderStatus`), reports a **final** status of that same order
(filled, cancelled, rejected, cancelled by the switch), dated before the account state the signer just read — so that a
fill is already inside the position it counts; (3) its `expiresAfter` + 10 s has passed (the venue then refuses the
action). The same signed action cannot land twice (nonce), so an entry that left never comes back. "Unknown to the venue",
"open", an unreadable answer: still counted. A client id that is in the ledger, or that an open order on the venue
carries, is refused — for reductions too — so no second order can pass for a pending quote. Rule (2) was added after the
simulator showed that without it honest requoting is throttled: a quote that landed and was cancelled between two reads of
the signer stayed counted for 20 s, and the third requote of a side was refused (`resting_count`).

**`modify` / `batchModify`: not supported; requote = cancel, then new.** A modify is a cancel plus a placement whose cancel
part may fail (`always_place`), so the signer would have to count the new order as a pure addition anyway: no gain on any
bound. What it would save is one address-rate-limit request per requote; what it costs is a second way to place an order,
keyed on an order id the signer cannot verify. Not worth it in a first version.

**Exclusivity.** One mandate per venue authorization, of either kind: approving a quoting mandate is refused while a
directional mandate is `active` on the authorization and vice versa (the one behaviour change in `venueMandateApprove`).
Manual orders (passkey each) stay possible; they enter the same ledger and are counted.

**The authorization's `maxOrdersPerDay` (≤ 500) does not count quotes.** It was written for manual and directional orders;
a quoting session exceeds it in minutes. Quotes are bounded by the mandate's own, separately approved, rate limits.

**Compilation from a trading mandate** (`compileToQuotingMandate`, `packages/trading/src/mandate/quoting-mandate.ts`). A
trading mandate (`SPW-TRADING-MANDATE-v1`) allows at most 500 orders a day and has no field for a distance from the mid, a
number of resting quotes or a dead man's switch. Those are `QuotingTerms`, chosen next to the mandate; the compilation
reports, for every field of the trading mandate and every term, who enforces it. The mandate's own `frequency` is reported
**API only** — it is not carried by the signer shape, and saying otherwise would be false. Table for the reference mandate
of `packages/trading/src/docs.ts` (generated by `renderQuotingEnforcementTable`):

<!-- GENERATED:quoting-enforced-by -->
| Field | Quoting mandate `SPW-VENUE-QUOTING-MANDATE-v1` |
|---|---|
| `v` | **n/a**. version of the trading mandate; the signer shape has its own |
| `mandateId` | **signer** — `mandateId`. the quoting mandate carries the same id |
| `principal` | **signer (partly)** — `agentId`. recorded by the signer for the audit trail; the signer cannot verify who calls it — the API binds the principal to the mandate |
| `accounts` | **signer** — `account, agentAddress, authorizationId`. the signer signs for this one venue account only, and no directional mandate can be active on it at the same time; the mandate's 1 other account(s) are outside this shape |
| `venues` | **signer** — `venue`. the shape is for hyperliquid only; kyberswap are outside this shape |
| `networks` | **signer** — `network`. the venue network of the authorization |
| `instruments` | **signer** — `instruments[].instrument`. the signer refuses any other instrument, and only the pinned ones (BTC, ETH, SOL) can be approved |
| `marketKinds` | **signer**. structural: this shape signs perpetual orders only |
| `orderTypes` | **signer**. narrower than the mandate, structurally: the signer signs post-only (Alo) limit quotes, reduce-only limit orders, cancels and the dead man's switch — never a market, stop or take-profit order, whatever the mandate lists |
| `maxCapitalUsd` | **signer (partly)** — `maxGrossExposure`. enforced as worst-case gross exposure ≤ capital × leverage; the capital itself (collateral on the venue) is not capped by the signer |
| `maxOrderNotionalUsd` | **signer** — `instruments[].maxQuoteNotional, maxRestingNotionalPerSide`. size × max(price, the signer's mid) of each quote and of each reduce-only order; quote size × quotes per side bounds what rests on a side |
| `maxPositionNotionalUsd` | **signer** — `instruments[].maxInventoryNotional`. worst case per instrument — the position plus EVERY resting and pending quote of one side — from the signer's own read of the venue account and its own prices |
| `maxLeverage` | **signer** — `instruments[].maxLeverage`. the signer refuses a quote while the venue's leverage setting is higher; a quoting mandate never changes the leverage (the owner sets it, with the passkey) |
| `maxDailyLossUsd` | **API only**. the signer has no daily-loss limit; it only knows the floor. The engine's drawdown breaker is API-side |
| `floorEquityUsd` | **signer** — `floorEquity`. below the floor the signer signs reduce-only orders, cancels and the dead man's switch only (the venue's own account value) |
| `createdAt` | **signer** — `createdAt`. must be current at approval |
| `notBefore` | **signer** — `createdAt`. the mandate starts at its creation |
| `notAfter` | **signer** — `expiresAt`. at most 7 days; after it the signer signs only cancels, reduce-only orders and the dead man's switch for 24 h, then nothing |
| `frequency` | **API only**. NOT carried by this shape: a trading mandate allows at most 500 orders a day, which cannot express a quoting rate. Quotes are metered by the signer from the quoting terms (batches per minute, quotes per hour and per day, daily turnover); the mandate's own frequency is applied by the API to the orders that are not quotes |
| `maxSlippageBps` | **signer (partly)** — `maxReduceDeviationBps`. the price band of a reduce-only order around the signer's own mid; a quote has its own band (terms); realised slippage is checked by the API |
| `maxFeeUsd` | **API only**. the signer does not see venue fees |
| `stopConditions` | **API only**. declarative conditions and every circuit breaker of the engine are API-only; the signer stops on the floor, the expiry, a revocation, its own halt and a missing dead man's switch |
| `mode` | **signer** — `network`. a live mandate; the venue network (mainnet / testnet) is the authorization's |
| `strategySha256` | **signer (partly)** — `strategySha256`. recorded by the signer for the audit trail; the signer cannot verify what code runs |
| `label` | **API only**. a display name; not part of the signer shape |
| terms: `levelsPerSide` | **signer** — `instruments[].maxRestingPerSide, maxRestingTotal`. orders that rest or can still land, per side and in total, counted from the signer's own read of the venue plus what it signed |
| terms: `minHalfSpreadBps` | **signer** — `minHalfSpreadBps`. a bid is below, an ask above the signer's own mid (two exchanges, fail closed) by at least this: no quote is ever signed at or through it |
| terms: `maxDistanceBps` | **signer** — `maxDistanceBps`. no quote further than this from the signer's own mid |
| terms: `burstActions` | **signer** — `rate.burstActions`. capacity of the token bucket of quote batches, kept in the signer's state file (a restart refills nothing) |
| terms: `actionsPerMinute` | **signer** — `rate.actionsPerMinute`. refill of that bucket |
| terms: `quotesPerHour` | **signer** — `rate.ordersPerHour`. quotes signed per UTC hour (orders, not batches); cancels and reduce-only orders are never metered |
| terms: `quotesPerDay` | **signer** — `rate.ordersPerDay`. quotes signed per UTC day |
| terms: `dailyTurnoverUsd` | **signer** — `rate.dailyTurnover`. summed notional of the quotes signed per UTC day — signed, not filled: a quote that is requoted counts each time |
| terms: `deadManSeconds` | **signer (partly)** — `deadManSeconds`. the signer signs a quote only after it signed a scheduleCancel that fires after the quote can no longer be accepted, at most this far ahead; it cannot verify that the venue received it |
<!-- /GENERATED:quoting-enforced-by -->

`describe()` names a `scheduleCancel` only when asked to (`describeScheduleCancel`, used by the quoting path alone): every
other caller keeps reading it as `other`, exactly as before, and the manual and directional paths refuse it with the same
code and message as before (pinned by a test).

## 5. Signer vs API

| Control | Signer | API (engine) |
|---|---|---|
| action kinds, instruments, `Alo`-only openings | yes | planner only emits them |
| quote band vs an independent mid | yes (Coinbase + Kraken) | policy prices from the venue's book |
| size per quote, resting counts, resting notional | yes | planner |
| worst-case inventory, gross | yes (own venue read) | soft / hard limits on the reconciled position |
| floor equity, leverage setting | yes | risk port |
| rates, turnover | yes (persisted bucket and counters) | budget from `userRateLimit`, IP weight |
| dead man's switch armed before a quote | yes (it signed one; see residual risk) | heartbeat, start-up and shutdown sequence |
| expiry, revocation, halt, wind-down | yes | kill switch, mandate usage |
| strategy identity (`strategySha256`, `agentId`) | recorded only | checked |
| circuit breakers, hysteresis, markouts, PnL limits, session hours | **no** | yes |
| venue rate limits actually respected | **no** | yes |
| that a signed action was SENT (the switch, a cancel) | **no** | yes |

## 6. Dead man's switch

**Mechanism: the venue's `scheduleCancel`.** The engine sends `scheduleCancel(time = now + deadManSeconds − 2 s)` (two
seconds inside the mandate's maximum: its clock and the signer's are not the same clock) and re-sends it (heartbeat) every
`deadManSeconds / 3`. While the engine and the signer live, the deadline keeps moving; when either dies, the venue cancels
every open order of the account at the last deadline. When a heartbeat fails the engine counts only on the OLD deadline, and
pulls its quotes once that deadline is closer than one action's validity + 3 s. Shutdown asks the signer to remove the
switch and asks again for up to 30 s (the signer waits until the last quotes it signed can no longer land).

**Signer rule.** The signer stores the deadline `T` of the last `scheduleCancel` it signed for the account. A quote batch
with venue expiry `E` is signed only if `T ≥ E + 2 s` (the switch fires after the last instant the batch can be accepted,
so an accepted quote is always covered) — which implies `T > now`. `T ≤ now + deadManSeconds ≤ now + 120 s` by
construction. A disarm is signed only with nothing resting and nothing pending.

**Trigger budget.** The venue allows 10 triggers per UTC day. The signer counts a *lapse* each time it observes that a
deadline it signed has passed without being replaced or disarmed, and refuses openings after 8 lapses in a UTC day
(`dms_exhausted`). A clean shutdown (cancel-all, reconcile to zero, disarm) costs no trigger.

**Cost.** Each heartbeat is one request against the address-based limit. With `deadManSeconds = 60` and a heartbeat every
20 s: 4 320 requests a day; at 30 s / 10 s: 8 640. See §7.

**Residual risk — stated plainly.**
1. The signer knows it *signed* a `scheduleCancel`, not that the venue *took* it; no info request exposes the scheduled
   time. An engine that obtains the signature and does not send it leaves quotes uncovered. The rule binds the honest
   engine that crashes (the realistic failure), not a malicious API — which gains nothing from it beyond T1.
2. Up to `deadManSeconds` of stale quotes after a crash, at the last prices; the loss is bounded by the resting notional
   per side and the move in that time.
3. If the venue itself halts, the switch does not fire until it resumes.
4. "A new time replaces the previous one" is not stated in the documentation. If the earliest scheduled time won instead,
   the switch would fire early (a nuisance and a trigger, not a risk). To be verified on testnet before go-live.
5. Clock skew between signer and venue is covered only by the 2 s and 6 s margins.

## 7. Rate-limit budget

Two budgets, both the venue's; the signer's bucket is a third, independent, upper bound.

**IP weight (1 200 / min, shared by the API and the signer — one public IP).**

| Source | Weight | At the default cadence |
|---|---|---|
| quote batch (≤ 20 orders) | 1 | ≤ 12 / min |
| cancel batch | 1 | ≤ 12 / min |
| heartbeat | 1 | 3 / min |
| signer read per quote batch: `frontendOpenOrders` 20 + `clearinghouseState` 2 (+ `activeAssetData` 20 when flat) | 22 – 42 | 12 batches → 264 – 504 / min |
| engine reconcile: `frontendOpenOrders` 20 + `clearinghouseState` 2 | 22 | every 10 s → 132 / min |
| `userRateLimit` | 20 | 1 / min |

About 450 – 700 of 1 200 at one requote cycle per 5 s on one instrument — on paper. **Measured on the simulated session**
(§10; 35 minutes, one instrument, one quote per side, ticks every second, reconcile every 5 s) and converted with the
documented weights:

| Who | Requests in 35 min | Weight / min (estimate) |
|---|---|---|
| signer: 286 quote batches → 1 495 info requests (`frontendOpenOrders`, `clearinghouseState`, `activeAssetData` when flat, `orderStatus` per pending quote) | 1 495 | ≈ 380 |
| engine reconcile: 434 × (`frontendOpenOrders` 20 + `clearinghouseState` 2 + `userFillsByTime` 20) + `userRateLimit` | ≈ 1 370 | ≈ 555 |
| exchange: 286 quote batches + ≈ 280 cancel batches + 212 heartbeats | ≈ 780 | ≈ 22 |
| **total** | | **≈ 955 of 1 200** |

That is too close to the limit for a first live session, and the simulator does **not** model the IP limit (the engine is
given a constant "weight left"). Before go-live the engine's reconcile must move to the venue's WebSocket streams
(`orderUpdates`, `userFills`, which cost no REST weight) with the REST read kept as a slow audit, and the signer's
leverage read may be cached for a minute. Listed in `docs/v11/work/mm-core.md`. The signer's read dominates what cannot be
moved; this is why the compiled `actionsPerMinute` is 60 and the engine asks far less. Market data comes over WebSocket.

**Address-based requests.** 10 000 at inception + 1 per USDC traded; a batch of `n` counts `n`; cancels have their own,
larger allowance. A two-sided requote every 5 s is 2 orders → 34 560 order requests a day, plus the heartbeats: the
initial buffer lasts a few hours unless fills replenish it. With 20 USD quotes each fill buys 20 requests. The planner
therefore takes a budget (`nRequestsCap − nRequestsUsed − reserve`, read from `userRateLimit`) and degrades **before** the
venue throttles: wider hysteresis, fewer levels, then one side, then cancels and heartbeats only. When rate limited the
venue allows "one request every 10 seconds": the reserve always keeps the heartbeat and one cancel-all affordable.
`reserveRequestWeight` (0.0005 USDC per request) exists and is **not** built: it spends funds, and the trading key signs
no such action.

## 8. Failure modes

| Failure | Resting orders | Inventory |
|---|---|---|
| market data stale / stream not `connected` | breaker: cancel all at once; no quote until fresh data and a reconcile | kept; reduce-only unwind only if the configured policy says so and the price is fresh |
| volatility spike, spread blow-out, thin or crossed book | cancel all; cool-down | per policy (`hold` or `flatten`) |
| fill burst / markouts below threshold | cancel all; cool-down | per policy |
| consecutive rejects | cancel all; the session stops (`halted`) | kept |
| PnL drawdown (session / day) | cancel all; session stops | flatten reduce-only if configured |
| soft inventory limit | the increasing side is not quoted | reduced by the other side's fills |
| hard inventory limit | cancel all | reduce-only IOC unwind to the soft limit |
| unknown outcome of a batch (timeout, unreadable answer) | **no resend**; that side is blocked until a reconcile reads the venue (open orders + `orderStatus` by cloid) | venue is the truth |
| API crash | venue cancels at the deadline (≤ `deadManSeconds`) | kept, unmanaged until restart; restart = cancel-all → reconcile → arm → quote |
| signer down | no signature: quotes cannot be replaced **or cancelled**; heartbeat stops → the switch fires at the venue (simulated: `mm-engine.test.ts`, "signer down"); the signer counts the lapse when it is back | kept; nothing can reduce it until the signer is back (manual close needs it too) |
| signer refuses a batch | nothing placed; counted as a reject; `signer_*` code journaled | — |
| venue disconnect / outage | cancels cannot reach it; the switch fires when the venue processes blocks | at the market's mercy |
| kill switch | cancel all immediately; openings refused | reductions allowed |
| mandate expiry / revocation | signer refuses openings (`wind_down`); engine cancels all | reduce-only for 24 h, then manual |
| emergency halt of the signer | as revocation, until an operator lifts it | reduce-only allowed |
| address rate limit exhausted | degrade, then cancel all with the reserve | kept |
| 8 switch lapses in a UTC day | signer refuses openings until 00:00 UTC | reduce-only allowed |
| mainnet locks off (`SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_MM_MAINNET`) | openings refused in the adapter with the precise code; cancels and reductions pass | reducible |

## 9. What is NOT protected

- Loss from adverse selection and from holding inventory through a move: bounded by the inventory limits and the floor,
  not prevented.
- A compromised API inside the mandate (T1): it can lose money for the owner at the edge of the bands until the floor.
  It cannot move funds, change leverage, or trade another instrument.
- The signer's mid is spot (Coinbase + Kraken, cached ≤ 15 s), the venue trades a perpetual: with a basis of `b` bps the
  band is off-centre by `b`; one side of the book becomes unquotable inside `minHalfSpread` of the spot mid. This costs
  fills and skews them; it is the price of never signing through an independent mid.
- That a signed `scheduleCancel` or cancel was sent (§6).
- Unbounded cancels and reduce-only signatures: stopping is never metered, so a compromised API can burn the address rate
  limit and grow the signer journal with them (as with the directional mandate).
- The venue: its info endpoint is trusted for positions, open orders and account value; its matching, its clock and its
  dead man's switch are trusted to work as documented.
- Exposure opened outside the wallet that is neither a position nor an open order (a TWAP started in the venue's
  interface).
- Queue position, latency, priority fees paid by competitors (their `Alo` orders can jump ahead for 400 ms).
- Nothing was verified on a funded account.

## 10. Economics, honestly

- **The lab's own study is negative.** `research/studies/market_making_as` (run 2026-11-15, 68 minutes of 5 s books,
  fills modelled, not observed): Avellaneda–Stoikov PnL negative on BTC, ETH and SOL on Hyperliquid under both fill rules
  (BTC −9.5 USD on 30 000 USD traded, about −3.2 bps), with one-minute markouts between −1 and −2.7 bps — adverse
  selection — and a maker fee of 1.5 bps on top. Far too short to conclude; it is still the only evidence, and it does not
  support an expectation of profit.
- **Fees at the owner's tier.** Tier 0: maker **+1.5 bps paid**, not received. A rebate needs more than 0.5 % of the
  venue's 14-day maker volume; 0 % maker needs more than 500 M USD of 14-day volume. At the wallet's scale every fill costs
  1.5 bps, so a round trip must capture more than 3 bps of spread net of adverse selection. BTC's quoted spread on
  Hyperliquid is typically well under 1 bp: quoting at the touch cannot pay at tier 0; only wider quotes filled by larger
  moves can, and those are the adversely selected ones.
- **Rate limits are a cost.** 1 request per USDC traded: a 20 USD quote that is requoted 20 times before it fills has
  consumed its own allowance.
- **The simulator in this branch** replays 36 minutes of the public BTC feed (top of book and trades, recorded read-only
  on 2026-11-16 03:06 – 03:42 UTC) with a **modelled** queue: a quote waits behind the size displayed at its price, a trade
  through it fills it. With the study's own policy (gamma 0.1, tau 12 × 5 s, kappa 0.69), 20 USD quotes, one per side,
  and the tier-0 maker fee: 286 quote batches, 495 quotes, 486 cancels, **36 fills** (19 buys, 17 sells), 683 USD traded,
  **PnL −0.125 USD = −1.83 bps of the volume** — spread capture +0.086, inventory −0.108, fees −0.102 — and mean markouts
  of **−0.47 bps at 1 s, −0.92 bps at 10 s, −0.33 bps at 60 s**: adversely selected at every horizon. The signer refused
  nothing, the switch never fired, 708 address-rate-limit requests were used. It is one evening, one instrument, one fill
  model: it says the same thing as the study and proves nothing more. A variant with a 3 bps floor, run once while building and not kept
  as a test, had 12 fills and a PnL of +0.04 USD: twelve fills are noise, in either direction.

Expectation to hold: a small, negative-carry activity whose value is learning and infrastructure, unless measured
otherwise on real fills.

## 11. Go-live checklist (owner)

1. Read §9 and §10; accept in writing that the only study is negative and that tier-0 maker fees are paid.
2. Jurisdiction: the Hyperliquid acknowledgement of `docs/v4/venues/jurisdiction.md` is shown again and its hash is part
   of the mandate.
3. Integration merged and reviewed (`docs/v11/work/mm-core.md`): signer behaviour changes reviewed by a human.
4. Testnet, funded with test funds only, before any mainnet: verify on the venue (a) `scheduleCancel` replacement and
   firing, the trigger count, (b) an `Alo` rejection, (c) `expiresAfter` rejection, (d) the lag of `frontendOpenOrders`
   after an accepted order, (e) duplicate cloid behaviour, (f) `userRateLimit` movement per batch.
5. Leverage of each instrument set (manual, passkey) at or below the mandate's `maxLeverage` — the mandate cannot change it.
6. Choose: capital on the venue, instruments, quote size (≥ 10 USD), inventory limits, floor, `deadManSeconds`, session
   hours, rates. Start with one instrument, one level, the minimum size.
7. Approve the quoting mandate (passkey), ≤ 7 days. Revoke any directional mandate first.
8. Four settings on: `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_MM_MAINNET`, `SPW_TRADING_API_EXECUTION` (corrected 2026-11-17: this line said three; §12 (b) is the code).
9. Watch the first session live: markouts, PnL attribution, rate-limit budget, signer refusals. Know the stop:
   kill switch (pull quotes), revoke (no passkey), emergency halt.
10. Stop if the realised markouts confirm the study.

## 12. As built (integration, 2026-11-16)

**Differences from sections 1–11.** (a) §7's REST reconcile is replaced by the venue's user streams (below); its figure of
≈ 955 weight a minute is superseded by the measurement below. (b) §8's last row: there are FOUR settings on mainnet, and a
testnet one. (c) The simulated venue of the foundations is a test double, not a paper model: paper has ONE fill model, the
runtime's. (d) §11 items 3, 6, 7, 8 are implemented as the in-app checklist of §13.

**One engine, two modes.** A market-making agent in PAPER or LIVE is passed by the stream engine, under its lease, to
`MmRuntime.tick()` → `MmEngine.tick()`. PAPER: the engine over `PaperVenue` — real books, a simulated account, no signer.
LIVE: the engine over the live adapter — the signer's quoting path only (never a per-order passkey, never the manual or the
directional path), on Hyperliquid, for the agent's ONE pinned instrument. RESEARCH computes and stores the rule's quotes and
places nothing (the stream engine, as before).

**One quoting rule.** `spread_inventory` is `mmQuotes` (`agent-runtime/families.ts`): research and the recorded-data replay
call it directly, paper and live call it through `spreadInventoryPolicy`, its `QuotePolicy` form. Avellaneda–Stoikov is the
second selectable policy (`policy: 'avellaneda_stoikov'` in the agent's configuration, with `asGamma`, `asTauIntervals`,
`asKappa`, `maxHalfSpreadBps`). In LIVE the rule is wrapped by `withinBand`: a quote is never asked closer than the mandate's
`minHalfSpreadBps` + 0.5 bps to the venue's mid, nor further than `maxDistanceBps` − 0.5 bps (the signer measures the band
from its own, spot, mid).

**One paper fill model: the runtime's `mmFills`** — a quote fills only when a later book trades strictly THROUGH it, at our
price, for at most the displayed size that crossed, never on the book it was priced from; the remainder is withdrawn; maker
fee on every fill. Kept, rather than the queue model of the foundations' simulated venue, because the runtime sees the top
of the book only (the rows it records and replays in a backtest use the same function) and a queue needs the public trades,
which the runtime does not consume. It under-counts fills in quiet markets and ignores queue position: paper figures are
labelled SIMULATED everywhere. Paper prices are now on the venue's grid (Hyperliquid: 5 significant figures).

**Ports.**

| Port | Bound to |
|---|---|
| `OrderPort` (live) | `createLiveMmAdapter` → `signer.venueQuotingSign` (`POST /venue/quoting/sign`) → the process's Hyperliquid HTTP client; wrapped by `streamReconciled` |
| `OrderPort` (paper) | `PaperVenue` |
| `MarketDataPort` | `marketDataPort(BookSource)` — freshness guards: a stream that is not connected serves no book; a book received more than the agent's `maxDataAgeMs` ago is stale; the older of the venue's and the receipt time is the book's time; the user stream's status is folded in. `BookSource` today = the stream engine's market state (mainnet) or the testnet client's `l2Book` stream. **The coming quote hub replaces the SOURCE (`BookSource`: `read(instrument)` → status, top of book, venue time, receipt time), not the port** |
| reconcile | `user-stream.ts`: `orderUpdates` and `userFills` over WebSocket (documented shapes `WsOrder[]`, `WsUserFills`; the recorded public `userFills` snapshot of mainnet is replayed through the real stream client in `mm-units.test.ts`). REST only at start-up, after a gap (at once, then at most every 10 s while the stream is down), on a 60 s audit, `clearinghouseState` (weight 2) when a fill was seen or every 15 s, and `orderStatus` for a client id the stream never mentioned. A difference found by the audit is counted, journaled (`stream_divergence`) and REST wins |
| `RiskPort` | the unified risk service (`evaluateOrder`, preview) on the worst case of each side of a plan, reused for 30 s per (side, size, inventory lot); the ONE kill switch read at every cycle → quotes pulled at once; reductions pass |
| `MandatePort` | the signer's own status of the mandate (phase, bucket, quotes left, the switch's deadline and lapses), narrowed by the API's record (a mandate revoked here is in its wind-down) |
| `JournalPort` | the agent journal (never a line per quote), `mm_fills`, the unwinds as unified orders, audit events for the alerts |

**Rate budget — measured.** `mm-units.test.ts`, "A SIMULATED HOUR": the 36-minute recorded tape played twice (60 minutes),
the engine at one cycle a second, the real signer code, every request the venue double saw weighted as the venue documents,
plus the live engine's own paced reconcile of the account (once a minute). One instrument, one quote per side, 20 USD quotes:

| Per minute | Mean | Notes |
|---|---|---|
| signer's own reads (per quote batch: `frontendOpenOrders` 20 + `clearinghouseState` 2, + `activeAssetData` 20 when flat, + `orderStatus` 2 per pending quote) | 352 | cannot be moved; dominates |
| API REST (60 s audit 42, position reads ≈ 19, `userRateLimit` 10, the live engine's paced reconcile 44) | 111 | was ≈ 555 with the 5 s REST reconcile |
| exchange (quote batches, cancels, heartbeats) | 22 | |
| **total** | **485 of 1 200** | **peak minute 878** — held under the engine's own ceiling of 900 (`ipReserve` 300: quoting thins before cancels and heartbeats are at risk) |

492 quote batches, 833 quotes, 800 cancels, 59 fills, 360 heartbeats, no switch trigger, no signer refusal; 1 193 address
requests used of a cap of 11 112 (10 000 + volume). The budget's own estimate of the peak (890) matches the truth (878).

**Accounting.** Quotes are not rows of `orders`. `mm_sessions`: one row per session (counters, attribution, markout summary,
refusals by code, the rate budget, breaker events, and the engine's last status — the quotes resting NOW with their age and
distance from the mid). `mm_fills`: one row per fill, with markouts at 1 s / 10 s / 60 s computed afterwards from `mm_tape`
(one mid a second while a session runs, kept two days). Every reduce-only unwind is ONE unified order of the agent
(`engine: 'none'`, written through the order state machine). Performance is per mode, never added: the attribution of the
mode's sessions (spread capture, inventory, fees, funding — exact) and the agents' performance module on the mode's equity.
A session counts only its own fills. Fills of a session are attributed to the agent in the position-provenance ledger.

**Circuit breakers and operations.** The core's eleven breakers and the kill switch run in both modes with the section's
policy per code (`pull` / `flatten` / `halt`; the two drawdowns and the consecutive rejects always stop the session). Each
trip is journaled, stored in the session, and written as an audit event the alerts module turns into `agent.mm_breaker` /
`agent.mm_halted`; the other alert kinds are `agent.mm_dead_man_switch`, `agent.mm_signer_refusals`, `agent.mm_rate_budget`, `agent.mm_session_ended`.
The owner's **pull quotes now** and **flatten** (reduce-only) work under every lock, during a halt and during the
wind-down; when no worker runs the session they are executed by the API process itself under the agent's lease. The session
ends outside its hours, at its maximum duration (the agent is then paused), `stopBeforeExpiryS` before the mandate's expiry
(the agent is stopped and the mandate revoked), or when the mandate is no longer usable.

**Locks (all default off; only the exact value `on` opens).**

| Network | Settings consulted, in this order | Code of the first one that is off |
|---|---|---|
| mainnet | `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_MM_MAINNET`, `SPW_TRADING_API_EXECUTION` | `mainnet_disabled`, `mandate_mainnet_disabled`, `mm_mainnet_disabled`, `execution_disabled` |
| testnet | `SPW_DERIV_MM_TESTNET`, `SPW_TRADING_API_EXECUTION` | `mm_testnet_disabled`, `execution_disabled` |

`SPW_TRADING_API_EXECUTION` already gated every agent's new live risk in the order service; a market-making agent's quotes are
new live risk, so the same switch gates them here: one rule (`mmOpeningLock`). The network is the venue account's, never a
setting. With any lock off: the start is refused with the code; a running session's quotes are pulled and held (the code is
shown), and come back when the lock opens; cancels, reductions and the dead man's switch pass.

## 13. Runbook

**Go-live checklist (in the app, in order; each step shows its evidence; the server refuses a live start with
`golive_incomplete` and the missing steps).**

1. A PAPER session of at least 30 minutes on the chosen instrument (`SPW_MM_MIN_PAPER_MINUTES`).
2. The lab study and the simulation, shown as they are — modelled PnL NEGATIVE in both — and the owner's explicit
   acknowledgement (the hash of the text he ticked is recorded).
3. The Hyperliquid jurisdiction acknowledgement of `docs/v4/venues/jurisdiction.md` (its hash is also inside the mandate).
4. TESTNET, run by the owner with test funds (`SPW_DERIV_MM_TESTNET=on`, a testnet venue account, a testnet quoting mandate):
   observe (a) that a new `scheduleCancel` replaces the previous one, that it fires, and the trigger count; (b) an `Alo`
   rejection; (c) an `expiresAfter` rejection; (d) the lag of the open-orders list after an accepted order; (e) what a
   duplicate client order id does; (f) how `userRateLimit` moves per batch. A testnet session, or his written attestation,
   completes the step. **Nobody but the owner runs this step.**
5. The quoting mandate: capital, floor, instrument, quote size, inventory limits, the band, the rates, `deadManSeconds`,
   session hours and duration, breaker policies — each field with its compiled maximum — then the approval sheet (the
   enforced-by table verbatim, the hashes) and the passkey, twice. Leverage of the instrument set beforehand (passkey) at or
   below the mandate's. Any directional mandate on the account revoked first.
6. The settings of the network on (table above), in every process that runs agent workers.

**Start.** The owner starts the agent LIVE (a key may only resume what he started under the same mandate). The worker that
holds the agent's lease opens the session: cancel-all → reconcile → arm the dead man's switch → quote.

**Stop.** Stop the agent: the mandate is revoked at the signer first, the session cancels everything, unwinds if the mandate
says `flattenOnStop`, removes the switch; the agent is `STOPPING` until then. Pause: the session ends the same way, the
mandate stays. Positions are not closed by a stop unless `flattenOnStop`: use Flatten first if that is wanted.

**Incidents.**

| What you see | What it means | What to do |
|---|---|---|
| a breaker (`agent.mm_breaker`): quotes pulled, phase `pulled` | data stale / stream down / book crossed, thin or wide / volatility / fill burst / adverse markouts / kill switch | nothing: quoting resumes 15 s after the condition clears. Persisting: stop the agent |
| `agent.mm_halted` (drawdown, consecutive rejects) | the session stopped quoting and waits | look at the refusals and the PnL; Resume, Flatten, or Stop |
| `agent.mm_signer_refusals` | the signer refuses batches (the code says why: band, inventory, floor, leverage setting, rates, switch) | `quote_too_tight` / `quote_crosses_mid`: the perp trades away from spot (basis) — widen the rule or stop; `leverage_setting`: lower the venue's leverage (passkey); `floor_equity`: the account is at its floor |
| `agent.mm_dead_man_switch` | a deadline the signer signed lapsed: the venue cancelled everything (a crash, the signer or the venue unreachable) | find the cause before restarting; at 8 lapses in a UTC day no quote is signed until 00:00 UTC |
| `agent.mm_rate_budget` | IP weight or address requests under pressure: quoting thinned or pulled | let it recover; lower the requote rate (wider tolerance, larger minimum spread) |
| session `stale` (no heartbeat for 20 s) | the worker died | the venue cancels at the switch's deadline; the next worker restarts cleanly. Pull / Flatten work meanwhile (the API executes them itself) |
| the signer is down | nothing can be signed, not even a cancel | the switch cancels what rests; positions stay until the signer is back |
| anything you do not understand | — | Pull quotes now; then the kill switch; then revoke the mandate (no passkey) |

**Rollback rule.** **Revoke every quoting mandate before rolling the signer back** to a build without quoting
(`docs/runbooks/deploy.md`). Rolling the API back: stop every market-making agent first.

**After a session.** Read the markouts and the attribution of the LIVE mode. Stop if they confirm the study.


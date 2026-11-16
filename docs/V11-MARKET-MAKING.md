# V11 — market making on Hyperliquid: design of the core

Status: **foundations, not wired**. This document describes libraries, a signer extension and an engine module that exist
on branch `v11-mm-core` and are proven on a fake venue with the real signer code and on recorded public data. Nothing here
was ever sent to a venue; no key other than test vectors and a throwaway random key was used; no funded account, mainnet or
testnet, was touched. The integration into the agents runtime, the order table and the web is a later step
(`docs/v11/work/mm-core.md`).

Code: canonical mandate `packages/derivatives/src/live/quoting.ts`; venue primitives
`packages/derivatives/src/venues/hyperliquid/{trading,quoting-round,reconcile}.ts`; signer
`services/isolated-signer/src/venue-quoting.ts`; quoting core `packages/trading/src/mm/`; compilation
`packages/trading/src/mandate/quoting-mandate.ts`; engine `services/api/src/mm/`.

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

**The ledger.** A signed quote is in `R` through the ledger until the venue lists it, or until its `expiresAfter` + 10 s
(after which the venue refuses the action). An entry is dropped as *landed* only when the venue lists an order with the same
client id, coin, side and price, not reduce-only, taken after the signature; the same signed action cannot land twice
(nonce). A client id that is in the ledger, or that an open order on the venue carries, is refused — for reductions too —
so no second order can impersonate a pending quote.

**`modify` / `batchModify`: not supported; requote = cancel, then new.** A modify is a cancel plus a placement whose cancel
part may fail (`always_place`), so the signer would have to count the new order as a pure addition anyway: no gain on any
bound. What it would save is one address-rate-limit request per requote; what it costs is a second way to place an order,
keyed on an order id the signer cannot verify. Not worth it in a first version.

**Exclusivity.** One mandate per venue authorization, of either kind: approving a quoting mandate is refused while a
directional mandate is `active` on the authorization and vice versa (the one behaviour change in `venueMandateApprove`).
Manual orders (passkey each) stay possible; they enter the same ledger and are counted.

**The authorization's `maxOrdersPerDay` (≤ 500) does not count quotes.** It was written for manual and directional orders;
a quoting session exceeds it in minutes. Quotes are bounded by the mandate's own, separately approved, rate limits.

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

**Mechanism: the venue's `scheduleCancel`.** The engine sends `scheduleCancel(time = now + deadManSeconds)` and re-sends
it (heartbeat) every `deadManSeconds / 3`. While the engine and the signer live, the deadline keeps moving; when either
dies, the venue cancels every open order of the account at the last deadline.

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

About 450 – 700 of 1 200 at one requote cycle per 5 s on one instrument. The signer's read dominates; this is why the
compiled `actionsPerMinute` is 60 and the engine default is 12. Market data comes over WebSocket and costs none of it.

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
| signer down | no signature: quotes cannot be replaced **or cancelled**; heartbeat stops → the switch fires | kept; nothing can reduce it until the signer is back (manual close needs it too) |
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
- **The simulator in this branch** uses recorded public books and trades with a modelled queue; its PnL is a property of
  the model. Its numbers are reported in `docs/v11/work/mm-core.md` as what they are.

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
8. Three settings on: `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_MM_MAINNET`.
9. Watch the first session live: markouts, PnL attribution, rate-limit budget, signer refusals. Know the stop:
   kill switch (pull quotes), revoke (no passkey), emergency halt.
10. Stop if the realised markouts confirm the study.

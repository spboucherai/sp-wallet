# V11 risk model

Module `packages/trading/src/risk/engine.ts` of `@spw/trading`. An independent, deterministic risk engine:

```ts
evaluate(request, context, limits) → { decision: 'allow' | 'deny', checks: [{ id, ok, observed, limit, detail, exempt }], reducing, derived }
```

Pure: no clock (the caller's `context.now`), no network, no state. The same inputs always give the same
answer. It lists every check, not only the first that fails. `evaluateRisk` is the same function under a
name that does not collide with the risk engine of `packages/derivatives`.

Status: the engine is called by the API service for every order of every principal since Phase F
(`services/api/src/risk/`). It is not called by the isolated signer, which keeps its own, older checks. The
section "Enforcement points" states exactly which check is enforced where.

## Principles

1. **Every limit is explicit.** A limit that is not configured denies anything that can increase risk. It is
   never read as "unlimited". The same holds for a context value the engine needs and cannot read (no fresh
   price, no book, unknown leverage, unknown connection status).
2. **`reducing` is decided by the engine, from the positions in the context.** A caller flag is not trusted.
3. **A strictly reducing order keeps the way out open.** It is exempt from every exposure, leverage, loss,
   rate, allow-list and kill-switch check.
4. **Fail closed.** A request, context or limit set the engine cannot read is a denial (`input_valid`).
   Arbitrary input never yields `allow` (property-tested).

## Inputs

- `request`: `{ kind: 'order', order: CanonicalOrder }` or `{ kind: 'cancel', venue, clientOrderId }`.
- `context` (`TradingRiskContextSchema`), supplied entirely by the caller:
  - `now`, `killSwitch`, `readOnly`;
  - `instrument` (the derivatives `Instrument` shape, venue open to any venue, kind `perpetual` or `spot`)
    and `asset`, the instrument's asset under the caller's symbol normalization;
  - `positions` on all venues, each with its venue, account and normalized asset (the derivatives
    `Position`). Spot holdings the limits should see are supplied as long positions;
  - `accounts`: equity, collateral, free collateral and margin used per venue;
  - `marks`: reference prices of the order's instrument, one per source, each with its timestamp;
  - `book` of the instrument, or null;
  - `pnl`: realised and unrealised, today and since inception;
  - `equity`: current total and peak;
  - `signer`: reachable, halted; `connections`: per venue;
  - `usage`: orders in the last minute, hour and day, and today's notional — not counting this order;
  - optional `leverageSetting` and `maintenanceMarginFraction`.
- `limits` (`RiskLimitsSchema`, strict): every member is optional on purpose. An absent member is a missing
  limit, and a missing limit denies.

## Valuation

Formulas are imported from `packages/derivatives`, not copied: `grossExposure`, `netExposure`,
`exposureByAsset`, `effectiveLeverage`, `liquidationPriceCross`, `liquidationPriceAtLeverage`, `signedSize`
(`margin.ts`) and `walkBook` (`router.ts`). The monolithic `checkOrder` of `risk.ts` is not wrapped: it
answers for one venue account and stops at the first refusal. Its conventions are kept:

- positions are valued at their mark;
- the order is valued at the highest of the fresh reference prices, its limit price and its trigger price;
- resting orders are not counted in exposure;
- comparisons are made by cross-multiplication, never on a rounded division;
- a notional is turned into a size at the lowest fresh price, rounded up (the largest size it can buy).

A reference price is fresh when its age is within the maximum age configured for its source. A source with
no maximum age is unusable.

## Checks

<!-- GENERATED:risk-checks -->
| Check | Limit | Inputs | Rule | Applied to a strictly reducing order |
|---|---|---|---|---|
| `input_valid` | — | request, context, limits | the three inputs parse; the order's instrument is the context's; at most one position per venue and instrument; a spot sell does not exceed the holding supplied | yes |
| `read_only` | `context.readOnly` | readOnly | read-only mode denies every order, reducing or not; only a cancel passes | yes |
| `kill_switch` | `context.killSwitch` | killSwitch | the kill switch denies every order that is not strictly reducing | no (exempt) |
| `reduce_only_valid` | — | order, positions | an order flagged reduce-only must be opposite to an existing position and no larger than it (it can neither increase nor flip) | yes |
| `venue_allowed` | `allowedVenues` | order.venue | the venue is in the allow-list | no (exempt) |
| `instrument_allowed` | `allowedInstruments` | order.instrument | the instrument is in the allow-list | no (exempt) |
| `instrument_status` | — | instrument.status | the instrument is active on the venue (a halted or reduce-only instrument takes no new risk) | no (exempt) |
| `signer_status` | — | signer.reachable, signer.halted, order.mode | live orders: the signer is reachable and not halted | no (exempt) |
| `venue_connection` | — | connections[venue], order.mode | live orders: the venue connection is up | no (exempt) |
| `price_freshness` | `maxPriceAgeMs, minPriceSources` | marks[].ts, now | at least minPriceSources sources of the instrument are no older (and no further in the future) than their maximum age | only without a limit price |
| `price_consistency` | `maxSourceDeviationBps` | fresh marks | (highest − lowest) / lowest over the fresh sources is within the limit; inconsistent data denies | only without a limit price |
| `order_notional` | `maxOrderNotional` | order, reference price | notional of the order (its own notional, or size × the highest of reference, limit and trigger price) | no (exempt) |
| `daily_notional` | `maxDailyNotional` | usage.notionalToday, order notional | today's accepted notional plus this order | no (exempt) |
| `order_rate_minute` | `maxOrdersPerMinute` | usage.ordersLastMinute | orders already accepted in the last minute are below the limit | no (exempt) |
| `order_rate_hour` | `maxOrdersPerHour` | usage.ordersLastHour | orders already accepted in the last hour are below the limit | no (exempt) |
| `order_rate_day` | `maxOrdersPerDay` | usage.ordersToday | orders already accepted today are below the limit | no (exempt) |
| `position_size` | `maxPositionNotional` | positions, order, reference price | resulting position on the instrument, at the reference price | no (exempt) |
| `order_leverage` | `maxOrderLeverage` | order.leverage | leverageSetting | position.leverage, instrument.maxLeverage | perp: the leverage setting the order runs under is known, within the limit and within the venue's maximum | no (exempt) |
| `account_leverage` | `maxAccountLeverage` | positions after the order, equity.current | gross exposure after the order / total equity (margin.effectiveLeverage); equity ≤ 0 denies | no (exempt) |
| `gross_exposure` | `maxGrossExposure` | positions after the order | Σ |size| · mark over all venues (margin.grossExposure) | no (exempt) |
| `net_exposure` | `maxNetExposure` | positions after the order | |Σ long − Σ short| over all venues (margin.netExposure) | no (exempt) |
| `asset_exposure` | `maxAssetExposure` | positions after the order, by normalized asset | |net| exposure of the order's asset over all venues (margin.exposureByAsset) | no (exempt) |
| `venue_exposure` | `maxVenueExposure` | positions after the order on the order's venue | gross exposure on the order's venue | no (exempt) |
| `collateral_concentration` | `maxVenueCollateralShareBps` | accounts[venue].equity, equity.current | share of the total equity held on the order's venue | no (exempt) |
| `daily_loss` | `maxDailyLoss` | pnl.realizedToday + pnl.unrealizedToday | today's loss has not reached the limit | no (exempt) |
| `total_loss` | `maxTotalLoss` | pnl.realizedInception + pnl.unrealizedInception | the loss since inception has not reached the limit | no (exempt) |
| `drawdown` | `maxDrawdownBps` | equity.peak, equity.current | (peak − current) / peak has not reached the limit | no (exempt) |
| `liquidation_distance` | `minLiquidationDistanceBps` | resulting position, leverage, venue account equity, maintenance fraction | perp: estimated liquidation price after the order (margin.liquidationPriceCross / liquidationPriceAtLeverage) is at least the limit away from the reference price | no (exempt) |
| `slippage` | `maxSlippageBps (and the order's own maxSlippageBps when lower)` | book, order size | average price of walking the book (router.walkBook) vs the mid; a book that cannot fill a market order denies | no (exempt) |
| `min_liquidity` | `minLiquidity` | book, order size | depth on the taking side within withinBps of the mid ≥ multiple × order size | no (exempt) |
<!-- /GENERATED:risk-checks -->

Notes:

- `asset_exposure` is the absolute net exposure to the order's asset over all venues: a long on one venue
  and a short on another offset each other. Gross exposure, in total and per venue, is bounded separately.
- `collateral_concentration` is a state check: when too large a share of the equity already sits on the
  order's venue, no new risk is taken there. An order does not move collateral.
- `liquidation_distance` is an estimate. Cross margin uses the single-position approximation of `margin.ts`
  with the venue account's equity, and needs exactly one account on the venue. Isolated margin uses the
  estimate at the order's leverage. The maintenance fraction defaults to `1 / (2 × max leverage)`.
- `slippage` and `min_liquidity` are not estimated for `stop` and `take_profit` orders, which execute at a
  future trigger. For a limit order only the part that would execute now is measured.
- Loss and drawdown limits deny once reached, not once exceeded. The other limits are inclusive.
- Signer and venue-connection checks apply to live orders only.
- Spot: leverage and liquidation do not apply. A spot sell must be covered by a holding supplied as a long
  position; a sell larger than it is refused.

## The reducing-order rule

An order is **strictly reducing** when all of these hold:

1. it is a perp order;
2. it carries `reduceOnly`, so the venue itself refuses to increase or flip;
3. a position exists on the same venue and instrument, on the opposite side;
4. its size is at most that position. For an order given as a notional, the size is derived cautiously
   (lowest fresh price, rounded up); with no fresh price it cannot be shown to reduce.

The flag alone is not enough (the engine checks the position), and the position alone is not enough
(several opposite orders without the flag could together flip it). A `reduceOnly` order that fails 3 or 4
is denied by `reduce_only_valid`. A cancel is always reducing.

A strictly reducing order is subject to exactly these checks:

| Check | Why it still applies |
|---|---|
| `input_valid` | a malformed request is never executed |
| `read_only` | read-only mode allows cancels only |
| `reduce_only_valid` | this is the proof that it reduces |
| `price_freshness`, `price_consistency` | **only when the order has no limit price.** A market or trigger-market close has no price bound of its own: its worst acceptable price is derived from the reference price, so a stale or inconsistent reference could make the close execute at a harmful price. A reduce-only order with a limit price carries its own bound and is exempt |

Everything else is exempt, and the result shows it (`exempt: true`): allow-lists, instrument status, signer
and venue status, notional, rates, position size, leverage, exposures, collateral concentration, losses,
drawdown, liquidation distance, slippage, liquidity, and the kill switch. With stale prices the way out is a
reduce-only limit order.

## Kill switch and read-only

| Input | Cancel | Strictly reducing order | Any other order |
|---|---|---|---|
| neither | allowed | allowed (subject to the table above) | every check applies |
| `killSwitch` | allowed | allowed | denied (`kill_switch`) |
| `readOnly` | allowed | denied (`read_only`) | denied (`read_only`) |

- `killSwitch` blocks all new risk globally, on every venue and in every mode, and never blocks a reduction.
- `readOnly` blocks everything except a cancel.
- A cancel passes with no limit configured, with the signer down, in any mode: it can only lower what may
  still execute.

Decided at integration: under `readOnly` only cancels pass; under the kill switch reductions pass. This is
what the engine implemented.

## What the engine does not do

- It does not count resting orders in exposure (the convention of `risk.ts`). The signer's derivative
  mandate does (`worstCaseExposure`).
- It does not check tick, lot or minimum size: that stays with the venue-level `checkOrder` of
  `packages/derivatives`.
- It does not classify a spot sell as reducing: asked about a spot sell under the kill switch, the engine
  denies. The owner's spot orders are not judged by this engine (exec2): the order service applies the two
  switches itself, on the two legs of the swap — a buy is new risk, a sale of a non-cash asset into a cash leg
  passes under the kill switch, read-only mode refuses both (`orders/spot-orders.ts`). The owner's limit set is
  not evaluated for a spot order.
- It does not verify the marks of positions on other instruments; they are taken as the venue reported them.
- It holds no state: usage counters, PnL, peak equity and statuses are the caller's.

## Integration in the API service (Phase F)

Code: `services/api/src/risk/{service,limits,passkey}.ts`, `services/api/src/derivatives/gate.ts`. Operator
view: `TRADING-RISK-ENGINE.md`.

### Who calls `evaluate`

- The order service, for every order it places and for every preview.
- The three venue engines, through a gate (`PreTradeGate`) set on the instances the server uses: the paper
  engine (`paper.ts` `risk`), the Hyperliquid engine (`exec.ts` `check`, used by previews, manual proposals
  and mandate orders) and the GMX engine (`gmx-exec.ts` `prepareOrder`). An order placed through a route that
  existed before, or by a perp agent, therefore passes the same engine. The gate runs after the venue engine's
  own checks and before anything is stored for approval or handed to the signer. An order the order service
  has just evaluated is not evaluated twice — under one condition: the gate reuses a stored decision only when
  it was made, within 60 s, for the **very same engine request**. The key (`risk_decisions.fingerprint`,
  `risk/service.ts` `fingerprint`) covers the mode, venue, network, account, instrument, side, order type, size,
  price (the limit price, or the worst acceptable price of a market order), trigger price, reduce-only flag,
  time in force and the leverage setting the order runs under; the notional is size × price, both in the key.
  The same client order id with any other order is evaluated on its own, as is a preview's id (a preview has no
  fingerprint) — test "the engines' gate reuses the decision … only for the very same engine request"
  (`execution-exec2-paper.test.ts`: nine variants, each evaluated again; under a limit the altered order
  breaks, it is denied).
- At approval time the Hyperliquid and GMX engines ask again whether new risk is blocked, so that a proposal
  made before the kill switch cannot be approved after it.
- The API asks before requesting a spot agent's signature (`signerGuards.beforeMandateSign` in
  `signer-client.ts`): with the kill switch or read-only mode on, `/mandate/sign` is not called.

A denial is final for the path that asked. No caller can override it.

### Context

The context is assembled by the API from what it reads itself. Nothing a caller says enters it.

- **Books.** A context is built for one book: `paper`, `live-mainnet` (Hyperliquid mainnet accounts and GMX)
  or `live-testnet`. A live context never contains a paper position, balance or PnL figure, and the reverse.
- **Accounts and positions.** Paper: the stored accounts. Live: the venue is read for every authorized venue
  account; GMX positions are read from the chain through the GMX service when the wallet has ever used GMX. A
  part that cannot be read is listed, and the service adds the check `context_complete`: new risk is denied on
  an incomplete book. A strictly reducing order is exempt.
- **One account per venue.** The engine reads one account per venue and instrument. With several accounts on
  a venue, the order's own account is presented under the venue's name and each sibling under
  `<venue>@<account id prefix>`. Gross, net and per-asset exposure and the account leverage count every
  account. The per-venue exposure and the collateral-share limits then apply to the order's own account.
- **Prices.** The venue's mark and, when the venue publishes one, its index (an oracle price, not the book),
  each with the venue's timestamp; plus the wallet's spot price list (CoinGecko) under the source `coingecko`,
  with the time that source gives. Live needs two fresh sources by default.
- **Book.** The venue's order book. A venue without one (GMX, a liquidity pool) cannot answer `slippage` and
  `min_liquidity`: the service marks both "not applicable" with the reason, in the stored check list. The
  order's acceptable price bounds its execution there, checked by the GMX engine and the signer.
- **PnL.** Stored fills (closed PnL minus fees) and funding of the book's accounts, today and in total; for
  the mainnet book also the realised PnL of executed GMX orders. Unrealised PnL is the sum over the open
  positions; the same figure is used for "today" (no intraday baseline is stored).
- **Equity and peak.** The sum of the readable accounts' equity; the peak is stored per book and raised when
  the equity exceeds it.
- **Usage.** Counted on the `orders` table for the book: orders that are not reduce-only and not `REJECTED`
  or `FAILED`, in the last minute, hour and day, and today's notional.
- **Signer and connection.** `signer.status()` (reachable, halted); the venue counts as connected when its
  ticker was read for this evaluation.

Every evaluation is stored in `risk_decisions`: decision, `reducing`, the failing check ids, the full check
list, the derived values, the limit set used and a summary of the context. Previews are stored with
`preview = true` and are never reused as the decision of an order.

### Venue reads are shared between evaluations (rate budget)

One live order used to read every authorized venue account of the book twice (before the order exists, then
on the stored order), plus once per preview. The reads of a **live** book — each venue account's state and
positions, GMX, the signer's status, the venue's leverage setting of the instrument — are now kept for
`CONTEXT_TTL_MS` (2 s; `SPW_RISK_CONTEXT_TTL_MS`, 0 = off) and shared by the preview, the two evaluations of a
creation and the next order (`risk/service.ts` `bookView`). A shared copy is dropped at once when:

- any engine order row changes — a new order, a fill, a cancel (the sequence of the projection queue moves; it
  is read from the database at each evaluation, one local query instead of one request per venue account);
- an order of the unified table is filled, partly filled or cancelled (`invalidate`, from the transition hook);
- the engine clock moves by more than the TTL;
- the read had an error (an incomplete book is never kept).

What stays stale for at most the TTL: a position changed at the venue outside this wallet (a liquidation, an
order from the venue's own interface), marks and unrealised PnL, a leverage setting changed in another tab. The
engines read their own account again before they act, and the signer reads the venue itself for a mandate
order. Paper books are read from the database and are never cached. The supervisor and the Risk screen's
exposure read the venues directly. Test: `execution-exec2-live.test.ts` "a preview and a creation share one
read of the venue account" counts the venue's `/info` requests with the sharing on and off.

### Whose position an order may reduce (provenance)

A venue keeps one net position per account and instrument. The order service keeps a ledger of lots per
principal (`orders/provenance.ts`), derived from the stored fills and the unified orders they belong to, and
bounds what an API key or an agent may reduce to its own lot, minus what it already asked to reduce and that
still rests. It applies to `positions/{id}/close|reduce` (a key closes ITS part), to every reduce-only order
(stop-loss and take-profit included) and to an order that is not flagged reduce-only but points against a
position that is partly somebody else's. Refusal: 403 `position_not_attributable`, before an order exists, and
in the preview (stage `provenance`). The owner is not bound. A fill of no known order (the venue's interface, a
liquidation) is the owner's; when the venue holds less than the ledger explains, the shortfall is taken from the
keys and agents first. This is API-side bookkeeping: the signer does not know it.

### Limits and defaults (`limits.ts`)

Stored per mode in `settings` (`risk.limits.live`, `risk.limits.paper`). The engine is given the defaults of
the mode overridden by what the owner stored.

- **Live.** The defaults cover data quality, order rates and execution quality: price age 10 s (15 min for
  the spot price list), book age 10 s, two fresh sources, 200 bps between sources, 100 bps slippage, depth of
  twice the order within 100 bps, liquidation distance 1 000 bps, 6 / 60 / 200 orders per minute / hour / day.
  **Every limit on capital is absent** — allow-lists, order and daily notional, position, order and account
  leverage, gross, net, per-asset and per-venue exposure, collateral share, daily and total loss, drawdown.
  An absent limit denies. A live order of an API key or an agent that is not strictly reducing is refused until
  the owner has stored them himself.
- **Live, the owner's own orders: the one-time seed.** Before V11 the owner's limits lived on each venue
  account (`deriv_accounts.policy`) and in the venue authorization the passkey approved. When a V11 server
  first becomes ready it derives ONCE (`risk.limits.live.seed`, `limits.ts` `seedFromV10`, audit event
  `risk.limits_seeded`) the part of the live limit set those limits already express, and the owner's own
  orders are judged on the stored limits **over that seed** (`limitsFor`). Rules: a value is the minimum over
  the authorized venue accounts (with one account: exactly its policy) — never looser than what exists; an
  allow-list is the union of what the accounts allow; nothing is invented.

  | Seeded from | Live limit |
  |---|---|
  | the venues of the authorized accounts | `allowedVenues` |
  | `policy.allowedInstruments` | `allowedInstruments` |
  | `policy.maxOrderNotional` | `maxOrderNotional` |
  | `policy.maxPositionNotional` | `maxPositionNotional.default` |
  | `policy.maxGrossExposure` | `maxGrossExposure` |
  | `policy.maxLeverage` (gross exposure / equity) | `maxAccountLeverage` |
  | venue authorization `policy.maxLeverage` (the leverage setting) | `maxOrderLeverage` |
  | `policy.maxDailyLoss`, `policy.maxTotalLoss` | `maxDailyLoss`, `maxTotalLoss` |
  | `policy.maxOrdersPerMinute`, `maxOrdersPerDay`, `minLiquidationDistanceBps` — only when stricter than the live default | the same |

  **Not seeded, because nothing before V11 says them:** `maxDailyNotional`, `maxNetExposure`,
  `maxAssetExposure`, `maxVenueExposure`, `maxVenueCollateralShareBps`, `maxDrawdownBps`. They stay absent, the
  engine denies, and `GET /risk/limits/live` lists them in `missing` (the Risk screen shows the banner "ordres
  réels refusés tant que ces limites ne sont pas définies" with exactly that list). GMX limits are not seeded
  either: GMX is added to the allow-lists by the owner. An API key or an agent never sees the seed
  (`missingForAutomation` lists what the owner has not stored himself). A field the owner stores replaces its
  seeded value for everybody; storing it is a loosening for keys and agents, so it needs the passkey.
- **Paper.** The same engine with a complete, finite default set. Allow-lists the owner did not set mean
  "every venue and instrument".

Tightening is free. A change that loosens anything is refused with `passkey_required`; it goes through
`prepare` and `approve`, where the passkey signs the hash of the whole new limit set
(`SPW-RISK-LIMITS-INTENT-v1`). This is the Phase B mechanism (`verifyOwnerAssertion`): a check against a
stolen session, verified by the API. It is not the signer's judgement.

### Kill switch and read-only mode

Stored in `settings` (`risk.switches`). Both are global: every principal, every venue, every mode.

| | Engage | Release |
|---|---|---|
| Kill switch | the owner's session; an API key with `positions:manage` (`POST /trading/risk/kill-switch`, or the command `KILL`); the supervisor, on a declared automatic stop | the owner's passkey only (`SPW-RISK-SWITCH-INTENT-v1`, bound to the instant the switch was engaged) |
| Read-only | the owner's session | the owner's passkey only |

- Kill switch: no order that is not strictly reducing. Cancels pass. Strictly reducing orders pass. It does
  not cancel resting orders and does not close positions. The owner's transfers, swaps and withdrawals are not
  orders of this layer and are not concerned.
- Read-only: only cancels pass.
- Engaging emits the webhook `risk.kill_switch` (`source: "risk_engine"`), an audit event `risk.kill_switch`
  and the alert `risk.kill_switch_on`.
- Automatic stops (`risk.auto`, default: total loss and drawdown on, daily loss off): when the live mainnet
  book reaches the owner's `maxTotalLoss` or `maxDrawdownBps`, the supervisor engages the kill switch.
  Switching one off needs the passkey. An unreadable book does not trip it.

The kill switch is separate from the signer's emergency halt. The halt stops signing, on the signer; it is
lifted on the signer machine. The kill switch stops new risk, in the API; it is released with the passkey.
A compromised API ignores the kill switch.

## Enforcement points (API / signer)

### Quoting sessions (market making, V11)

A quote is not an order row, and it does not go through the order service. Its enforcement points are:

| Control | API (quoting engine, `services/api/src/mm`) | API (unified risk engine) | Signer (`S/venue-quoting.ts`) |
|---|---|---|---|
| Kill switch, read-only mode | read at EVERY engine cycle (an unreadable switch is a pulled one): quotes are cancelled at once, none is placed; reductions pass | the same switch, inside `evaluateOrder` | none (its own emergency halt refuses quotes, not exits) |
| Pre-trade evaluation of a plan | `RiskPort.evaluate` before every quote batch; a refusal counts towards the consecutive-rejects breaker | `evaluateOrder` (a preview decision, recorded) on the WORST CASE of each side — the side's whole size at its most aggressive price, for the agent's principal. Its venue reads cost IP weight: a decision is reused for the same side, size and inventory (in quote lots) for 30 s; a fill, a size change or a new side is a new evaluation | none |
| Action kinds, instrument, post-only | the planner only emits them | n/a | yes: four action kinds, `Alo` limit openings, one instrument of the mandate |
| Quote band around the mid | the rule prices from the venue's book; `withinBand` keeps every live quote inside [min + 0.5 bps, max − 0.5 bps] | slippage / deviation checks of the worst-case order | yes, from the signer's OWN mid (two exchanges): never at or through it |
| Size, resting count and notional | planner (`maxRestingPerSide`), the section's quote size | order notional | yes |
| Inventory | soft limit (the increasing side is not quoted), hard limit (pull, reduce-only unwind to the soft limit) | position / gross / net / asset / venue exposure of the worst case | yes: worst case from its own venue read (position + everything resting or still sendable on a side) |
| Floor equity, leverage setting | — | account leverage, liquidation distance | yes |
| Rates | the budget (IP weight incl. an estimate of the signer's reads, address requests), thinning before the venue throttles | orders per minute / hour / day of the book do NOT count quotes | yes: persisted token bucket, quotes per hour and per day, daily turnover |
| Daily and session loss | the drawdown breakers (`maxSessionLossUsd` of the section; `maxDailyLossUsd` of the mandate over the UTC day's sessions) | daily / total loss, drawdown of the book | none (it knows the floor only) |
| Dead man's switch | armed before the first quote, renewed every `deadManSeconds / 3`, quotes pulled when it cannot be renewed | none | a quote is signed only after a `scheduleCancel` that outlives the batch; fewer than 8 lapses a day |
| Circuit breakers, session hours and duration, stop before expiry | yes — API only | none | none |
| Server locks | `mmOpeningLock` at the start and at every quote | `execution_disabled` for orders | none (a lock is the API's) |
| Reduce-only unwinds | one unified order each (`orders`, principal = the agent, `engine: 'none'`) | reductions always pass | band of its own mid, size per order; never counted |

Position provenance: a fill of a quoting session is attributed to the agent by the session's client-id prefix
(`orders/provenance.ts` `lotsOf`), since its quotes are not rows of `orders`. Fills of one timestamp are replayed in a
deterministic order — the fill's time, then the sequence in which the wallet stored it (`deriv_fills.seq`), then the fill id
(`fillOrder`): the case where an owner's close and a key's open carried the same millisecond no longer depends on the order
the rows come back in.

"Signer" means: the isolated signer refuses to sign, whatever the API asks. "API" means: only the API
service refuses; a compromised API process could skip it.

The signer column was checked against the signer's source, line by line, on 2026-11-15 (V11 exec2). Each cell names the file
and line that refuses. `S` = `services/isolated-signer/src`, `L` = `packages/derivatives/src/live`. "none" means that no line of
the signer looks at this: the control is API-only. The test `services/api/test/enforcement-pin.test.ts` asks the real signer
class directly, with no API check in front of it, and pins the mandate rows.

| Control | Engine check | API (unified risk engine) | API (venue engine, unchanged) | Signer (file:line) |
|---|---|---|---|---|
| Order notional | `order_notional` | every order | `risk.ts` per account | Hyperliquid manual order: `S/venue.ts:193` (authorization's `maxOrderNotional`, reduce-only orders included). Hyperliquid mandate: `S/venue-mandate.ts:212` (reduce-only included). GMX increase: `L/gmx.ts:505` (`maxOrderSizeUsd`). A GMX decrease has no size bound at the signer |
| Daily notional | `daily_notional` | every order | none | Hyperliquid mandate only: `S/venue-mandate.ts:229-230` (daily turnover of the orders that can add exposure). Manual orders and GMX: none |
| Position per instrument | `position_size` | every order (positions; resting orders not counted) | `risk.ts` per account | Hyperliquid mandate only: `S/venue-mandate.ts:238-239` (worst case from the signer's own venue read, resting and recently signed orders counted — `ownExposure`, lines 105-144). Manual orders: none (`L/canonical.ts:51-53` says so). GMX: none |
| Gross exposure | `gross_exposure` | every order, all venues of the book | `risk.ts`, one account | Hyperliquid mandate only: `S/venue-mandate.ts:240`, for that one venue account. Manual orders and GMX: none |
| Net exposure | `net_exposure` | every order | none | none |
| Exposure per asset, across venues | `asset_exposure` | every order | none | none |
| Exposure per venue | `venue_exposure` | every order (the order's own account when a venue has several) | none | none |
| Collateral concentration | `collateral_concentration` | every order | none | none |
| Order leverage | `order_leverage` | every order | `exec.ts`, paper policy | Hyperliquid manual: a leverage CHANGE above the authorization is refused (`S/venue.ts:219`); an order is not checked against the leverage setting. Hyperliquid mandate: an order that can add exposure is refused while the venue's setting is above the mandate's (`S/venue-mandate.ts:237`), and a leverage change above it is refused (`:254`). GMX increase: size ÷ collateral at the signer's own prices (`L/gmx.ts:509`) |
| Account leverage | `account_leverage` | every order | `risk.ts` | none |
| Daily and total loss | `daily_loss`, `total_loss` | every order | per account (Hyperliquid, GMX, paper) | Hyperliquid mandate only: `floorEquity` against the venue's own account value (`S/venue-mandate.ts:232`) — a floor on the total, not a daily limit. Manual orders, GMX, spot vaults: none |
| Drawdown from peak | `drawdown` | every order | none | none |
| Liquidation distance | `liquidation_distance` | every order | pre-trade, per account | none |
| Slippage | `slippage` | every order on a venue with a book | worst price, deviation from the mark | a price band around the signer's own mid on every price of a Hyperliquid order (`S/venue.ts:202`, `S/venue-mandate.ts:219`, rule `L/canonical.ts:226-237`) — **except** a reduce-only trigger order, whose trigger may rest between ⅓ and 3× the mid. GMX: the acceptable price against the signer's price (`L/gmx.ts:501-503`). Realised slippage against a book: none |
| Minimum liquidity | `min_liquidity` | every order on a venue with a book | none | none |
| Price freshness and consistency | `price_freshness`, `price_consistency` | every order: venue mark, venue index, spot price list | data age, mark against index | its own prices (`S/prices.ts`): Coinbase and Kraken must both answer and agree within 1 % (`:77-79`); the Coinbase quote is dated and at most 180 s old (`:28`); Kraken's ticker carries no time — Kraken must report `online` in an answer dated within 180 s (`:51-57`); a price is reused for 15 s (`:73`). USDC is checked on Kraken alone (`:61`) |
| Order rate | `order_rate_*` | per book: minute, hour, day | per account: minute, day | Hyperliquid manual: orders per UTC day, **every** order, reduce-only included (`S/venue.ts:194`). Hyperliquid mandate: per day (`S/venue-mandate.ts:226`, and the authorization's count `:227`) and per rolling hour (`:228`), orders that can add exposure only. GMX: increases per day (`S/venue-gmx.ts:101`, the policy's `maxOrdersPerDay`), decreases and cancellations 100 a day. Per minute: none |
| Allow-lists | `venue_allowed`, `instrument_allowed` | every order | per account policy | Hyperliquid manual: the authorization's instruments (`S/venue.ts:162`, `:190`). Mandate: the mandate's instruments for orders and leverage (`S/venue-mandate.ts:209-210`, `:251-252`), the authorization's for cancels (`:187`). GMX: the policy's markets (`L/gmx.ts:497`). Venue: structural (one authorization per venue and network, `S/venue.ts:145`) |
| Instrument status | `instrument_status` | every order | `risk.ts` | none (the signer knows a pinned asset table, not the venue's status) |
| Signer and venue status | `signer_status`, `venue_connection` | live orders | implicit (the call fails) | — (a mandate order that can add exposure is refused when the signer's own venue read fails or is stale: `S/venue-mandate.ts:107-109`) |
| Reduce-only validity | `reduce_only_valid` | every reduce-only order | `risk.ts` 5b; the venue enforces the flag | the signer reads the flag from the payload it signs (`S/venue.ts:178`, `S/venue-mandate.ts:222`) and relies on the venue to enforce it; it does not check that a position exists |
| Kill switch | `kill_switch` | global, every principal and venue; also asked at approval | per-account `halt` | none. The signer's own `halted` flag is another control: under it reduce-only orders and cancels are still signed (`S/venue.ts:178`, `S/venue-mandate.ts:225`), GMX decreases and cancellations too (`S/signer.ts:464`) |
| Read-only | `read_only` | global | per-account mode | none |
| Trading mandate of a key or an agent | — | `checkOrder`, every field; the row is verified against the owner's passkey approval at every use | — | the fields marked `signer` or `signer (partly)` in `TRADING-MANDATES.md`, for Hyperliquid |
| Position provenance (whose position a key may reduce) | — | order service (`orders/provenance.ts`) | — | none: the signer bounds a reduce-only order by instrument, notional and price only |
| Key limits and restrictions | — | order service: notional per order and per day; venues, instruments, networks | — | none |

Cells corrected by this verification (the earlier table was written from descriptions, not from the source):

- **Order notional**: a GMX decrease is not size-bounded by the signer (only an increase is).
- **Order leverage**: in manual mode the signer checks a leverage *change*, never the setting an order runs under.
- **Slippage**: "on every Hyperliquid order" was too strong — a reduce-only trigger order has the wider rule of V11 B-07.
- **Price freshness**: "two sources, both fresh" was wrong for Kraken (no per-quote time; an `online` status dated within
  180 s) and for USDC (one source).
- **Order rate**: the manual daily count includes reduce-only orders; GMX has its own daily counts; both were missing.
- **Allow-lists**: a cancel under a mandate is bounded by the authorization's instruments, not the mandate's; GMX markets were
  missing.
- **Reduce-only validity**: the signer does not validate the flag against a position.
- **Signer and venue status**: the mandate path fails closed on the signer's own venue read.

What the unified engine adds is API-side. On the signer nothing changed in this phase:

- a manual Hyperliquid order: passkey, instrument, notional per order, daily count, price band;
- an order under a derivative mandate: every limit of the mandate, from the signer's own read of the venue
  account and its own prices;
- GMX: one passkey per order, the venue policy, pinned contracts.

Consequences, stated plainly:

- The cross-venue limits (per asset, net, venue concentration, drawdown), the kill switch, read-only mode and
  the owner's limit set are enforced by the API only.
- For live trading by an API key or an agent, what holds if the API is compromised is the derivative mandate
  in the signer, and nothing else.
- For the owner's manual orders, what holds is the passkey per order and the authorization.

Not done by the service:

- Position provenance and the passkey binding of a trading mandate's full hash are API-side: a compromised API
  ignores both.
- Resting orders are not counted in exposure (the convention of the engine).
- The marks of positions on other instruments are taken as the venue reported them.
- A second account on a venue is judged per account for the per-venue limits.
- Unrealised PnL has no intraday baseline.

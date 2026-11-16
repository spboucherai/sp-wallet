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
- It does not classify a spot sell as reducing. Under the kill switch a spot sell through the trading layer
  is denied.
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
  has just evaluated is not evaluated twice (the decision is found by its client order id).
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

### Limits and defaults (`limits.ts`)

Stored per mode in `settings` (`risk.limits.live`, `risk.limits.paper`). The engine is given the defaults of
the mode overridden by what the owner stored.

- **Live.** The defaults cover data quality, order rates and execution quality: price age 10 s (15 min for
  the spot price list), book age 10 s, two fresh sources, 200 bps between sources, 100 bps slippage, depth of
  twice the order within 100 bps, liquidation distance 1 000 bps, 6 / 60 / 200 orders per minute / hour / day.
  **Every limit on capital is absent** — allow-lists, order and daily notional, position, order and account
  leverage, gross, net, per-asset and per-venue exposure, collateral share, daily and total loss, drawdown.
  An absent limit denies. A live order that is not strictly reducing is refused until the owner has set them.
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

"Signer" means: the isolated signer refuses to sign, whatever the API asks. "API" means: only the API
service refuses; a compromised API process could skip it.

| Control | Engine check | API (unified risk engine) | API (venue engine, unchanged) | Signer |
|---|---|---|---|---|
| Order notional | `order_notional` | every order | `risk.ts` per account | Hyperliquid manual order (authorization), Hyperliquid mandate, GMX increase |
| Daily notional | `daily_notional` | every order | none | Hyperliquid mandate only (daily turnover) |
| Position per instrument | `position_size` | every order (positions; resting orders not counted) | `risk.ts` per account | Hyperliquid mandate only (worst case, resting orders counted) |
| Gross exposure | `gross_exposure` | every order, all venues of the book | `risk.ts`, one account | Hyperliquid mandate only |
| Net exposure | `net_exposure` | every order | none | none |
| Exposure per asset, across venues | `asset_exposure` | every order | none | none |
| Exposure per venue | `venue_exposure` | every order (the order's own account when a venue has several) | none | none |
| Collateral concentration | `collateral_concentration` | every order | none | none |
| Order leverage | `order_leverage` | every order | `exec.ts`, paper policy | Hyperliquid leverage setting ≤ authorization; mandate refuses to add exposure above its leverage; GMX per increase |
| Account leverage | `account_leverage` | every order | `risk.ts` | none |
| Daily and total loss | `daily_loss`, `total_loss` | every order | per account (Hyperliquid, GMX, paper) | Hyperliquid mandate only: `floorEquity` on the venue's account value |
| Drawdown from peak | `drawdown` | every order | none | none |
| Liquidation distance | `liquidation_distance` | every order | pre-trade, per account | none |
| Slippage | `slippage` | every order on a venue with a book | worst price, deviation from the mark | price band around the signer's own mid on every Hyperliquid order; GMX acceptable price |
| Minimum liquidity | `min_liquidity` | every order on a venue with a book | none | none |
| Price freshness and consistency | `price_freshness`, `price_consistency` | every order: venue mark, venue index, spot price list | data age, mark against index | its own prices: two sources, both fresh |
| Order rate | `order_rate_*` | per book: minute, hour, day | per account: minute, day | per day (authorization and mandate); per hour (mandate) |
| Allow-lists | `venue_allowed`, `instrument_allowed` | every order | per account policy | per authorization and per mandate |
| Instrument status | `instrument_status` | every order | `risk.ts` | none |
| Signer and venue status | `signer_status`, `venue_connection` | live orders | implicit (the call fails) | — |
| Reduce-only validity | `reduce_only_valid` | every reduce-only order | `risk.ts` 5b; the venue enforces the flag | the reduce-only flag is read from the payload it signs |
| Kill switch | `kill_switch` | global, every principal and venue; also asked at approval | per-account `halt` | none: the signer's `halted` flag is another control (it stops signing; reduce-only exits and cancels are still signed) |
| Read-only | `read_only` | global | per-account mode | none (absence of an authorization) |
| Trading mandate of a key or an agent | — | `checkOrder`, every field | — | the fields marked `signer` or `signer (partly)` in `TRADING-MANDATES.md`, for Hyperliquid |
| Key limits and restrictions | — | order service: notional per order and per day; venues, instruments, networks | — | none |

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

- Resting orders are not counted in exposure (the convention of the engine).
- The marks of positions on other instruments are taken as the venue reported them.
- A second account on a venue is judged per account for the per-venue limits.
- Unrealised PnL has no intraday baseline.

# V11 risk model

Module `packages/trading/src/risk/engine.ts` of `@spw/trading`. An independent, deterministic risk engine:

```ts
evaluate(request, context, limits) → { decision: 'allow' | 'deny', checks: [{ id, ok, observed, limit, detail, exempt }], reducing, derived }
```

Pure: no clock (the caller's `context.now`), no network, no state. The same inputs always give the same
answer. It lists every check, not only the first that fails. `evaluateRisk` is the same function under a
name that does not collide with the risk engine of `packages/derivatives`.

Status: the engine exists and is tested. It is not called by the API or the signer yet; see
"Enforcement points" below.

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

Open point: the brief says both that a reducing order passes the read-only check and that read-only blocks
everything except a cancel. The engine implements the second reading. Changing it is one line
(`RISK_CHECKS` entry `read_only` and the check in `run`).

## What the engine does not do

- It does not count resting orders in exposure (the convention of `risk.ts`). The signer's derivative
  mandate does (`worstCaseExposure`).
- It does not check tick, lot or minimum size: that stays with the venue-level `checkOrder` of
  `packages/derivatives`.
- It does not classify a spot sell as reducing. Under the kill switch a spot sell through the trading layer
  is denied.
- It does not verify the marks of positions on other instruments; they are taken as the venue reported them.
- It holds no state: usage counters, PnL, peak equity and statuses are the caller's.

## Enforcement points (API / signer)

**To be completed at integration.** The engine is pure code and is enforced nowhere yet. The table states
what exists today (from `docs/v11/audit-parts/derivatives-exec-signer.md` section 5.1) and what is planned.

| Control | Engine check | API today | Signer today | After integration |
|---|---|---|---|---|
| Order notional | `order_notional` | `risk.ts`, `exec.ts` | HL manual, HL mandate, GMX increase | _to be completed_ |
| Position per instrument | `position_size` | `risk.ts` (positions only) | HL mandate only | _to be completed_ |
| Gross / net exposure | `gross_exposure`, `net_exposure` | `risk.ts` (gross, one account) | HL mandate only (gross) | _to be completed_ |
| Exposure per asset, across venues | `asset_exposure` | none | none | _to be completed_ |
| Exposure per venue | `venue_exposure` | per venue account only | none | _to be completed_ |
| Collateral concentration | `collateral_concentration` | none | none | _to be completed_ |
| Leverage | `order_leverage`, `account_leverage` | `risk.ts`, `exec.ts` | HL setting, GMX per increase | _to be completed_ |
| Daily and total loss | `daily_loss`, `total_loss` | HL only; GMX disabled | HL mandate floor only | _to be completed_ |
| Drawdown from peak | `drawdown` | none | none | _to be completed_ |
| Liquidation distance | `liquidation_distance` | pre-trade, HL and GMX | none | _to be completed_ |
| Slippage | `slippage` | worst price, deviation vs mark | price band vs own mid | _to be completed_ |
| Price freshness and consistency | `price_freshness`, `price_consistency` | data age, mark vs index | own prices, two sources | _to be completed_ |
| Order rate | `order_rate_*` | per minute, per day | per day; per hour (mandate) | _to be completed_ |
| Daily notional | `daily_notional` | none | daily turnover (HL mandate) | _to be completed_ |
| Minimum liquidity | `min_liquidity` | none | none | _to be completed_ |
| Allow-lists | `venue_allowed`, `instrument_allowed` | per account | per authorization / mandate | _to be completed_ |
| Kill switch | `kill_switch` | per HL account `halt` | global `halted`, which also blocks manual reductions | _to be completed_ |
| Read-only | `read_only` | per HL account mode | absence of an authorization | _to be completed_ |

Questions to settle at integration:

- which process calls `evaluate`, and whether a denial is final for every path (manual, mandate, API key);
- who computes the context — in particular the cross-venue position list, the symbol normalization and the
  peak equity — and how stale each part may be;
- where the limits are stored, who may change them, and whether a change needs a passkey;
- how the global kill switch relates to the signer's `halted` flag, which today also blocks reductions;
- which of these checks the signer can re-derive itself, and which remain API-only.

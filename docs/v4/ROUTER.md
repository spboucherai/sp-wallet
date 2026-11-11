# Universal derivatives router — simulation (delivery 5)

Written 2026-11-11. The router answers one question: *for this perpetual order, what would execution look like on each venue the
wallet serves?* It executes nothing. There is no route, function or button here that places, signs or sends an order; the only
action in the UI opens the **paper** order panel of Hyperliquid with the form pre-filled.

| Part | Location |
|---|---|
| Model (pure, exact decimals, no network) | `packages/derivatives/src/router.ts` |
| Service: snapshots, chain costs, risk view | `services/api/src/derivatives/route.ts`, `chain-costs.ts` |
| Routes | `POST /api/v1/derivatives/route`, `GET /api/v1/derivatives/route/assets` (`routes.ts`) |
| UI | `apps/web/src/derivatives/Router.tsx`, `routerApi.ts`; view `/futures?v=router` |
| Tests | `packages/derivatives/test/router.test.ts`, `services/api/test/derivatives-router.test.ts`, `tests/e2e/futures-router.spec.ts` |
| Live validation (read-only) | `scripts/sim-deriv-router.mts`; output of 2026-11-11 in `docs/v4/router-sim-2026-11-11.txt` |

## 1. Inputs

**Intent** (`OrderIntentSchema`, strict): `base`, `side` (`long` | `short`: side of the exposure), exactly one of `sizeBase` /
`notionalUsd`, `leverage`, `type` (`market` | `limit`) with `price` on a limit order only, `reduceOnly`, `horizonHours`
(0 – 8760, default 24). All amounts are decimal strings. The intent cannot name a venue.

**Snapshot per instrument** (`VenueSnapshot`): instrument, ticker, order book *or* GMX liquidity, the last 24 h range of the
hourly funding rate, chain costs (Arbitrum gas price, ETH price, GMX minimum execution fee), the account asked about (if any),
the venue restriction, and what this wallet can do there (`paper` on Hyperliquid, `none` on GMX and dYdX). GMX lists one
instrument per pool: each pool is its own candidate.

The router refuses stale data: ticker older than 15 s, book older than 15 s, GMX liquidity older than 30 s → blocker
`stale_data`, no fill, no cost, no total. The service additionally refuses a book whose own venue timestamp is older than 15 s
(`data_unavailable`) and lists a venue it could not read in `errors`.

## 2. Sources of every number

| Tag | Meaning |
|---|---|
| `venue` | read from the venue in the snapshot (book levels, oracle range, rates, fee factors, impact factors and caps, open interest, capacity) |
| `constant` | a documented fact pinned in `ROUTER_FACTS` with its page, checked 2026-11-10 (Hyperliquid / dYdX base fee tier, maintenance rule, deposit facts), or a measured gas-unit sample |
| `estimate` | computed here. **Every cost is an estimate**: a simulated fill is not a fill |

Each cost component carries its `inputs` (name, value, source), a `basis` sentence, an `uncertaintyUsd` with its reason, and when
it is paid (`at_fill`, `over_horizon`, `at_close`, `before_trading`).

## 3. Eligibility

Reasons have a kind: `blocker` (not ranked), `setup` (ranked, but not executable from this wallet now), `note`.

Blockers: `venue_restricted` (dYdX: terms exclude Canada — estimated from public data, shown, never ranked), `instrument_halted`,
`instrument_reduce_only`, `stale_data`, `no_depth_data`, `data_unavailable`, `size_rounds_to_zero`, `below_min_size`,
`below_min_notional`, `price_not_on_tick`, `leverage_above_venue_max`, `leverage_not_integer` (Hyperliquid), `book_snapshot_ends`,
`empty_book`, `above_capacity` and `above_open_interest_cap` (GMX), `bad_oracle`.
Setup: `no_collateral_account`, `insufficient_collateral_there`, `wallet_cannot_trade_here` (GMX: read only in this wallet).

GMX leverage bound: `1 / max(minCollateralFactor, (side OI + size) × minCollateralFactorForOpenInterest)`
(`PositionUtils.willPositionCollateralBeSufficient`, dossier `venues/gmx.md` §3).

## 4. Fill simulation

**Order book (Hyperliquid, dYdX)** — `walkBook`. Size: `sizeBase`, or `notionalUsd ÷ book mid`, quantised **down** to the venue's
own lot. The opposite side is walked level by level: filled size, average price, worst price, slippage against the book mid in
bps, levels and share of the snapshot consumed. If the snapshot (20 levels on Hyperliquid) ends before the size, the remainder is
reported as `unfilledBase` with `book_snapshot_ends` — never extrapolated — and the instrument is not ranked. A limit order fills
what is marketable; the rest is `restingBase`, valued at the limit price with the maker fee and flagged as not a fill.

**GMX** — no book. Longs open at the oracle max, shorts at the min (`liquidity().oracleMin/Max`; on 2026-11-11 the published
range of BTC and ETH had min = max, other indices about 1 bp). Price impact, in USD, positive = in favour of the trader:

```
impact(d) = d^exponent × factor                      d = |long OI − short OI| in USD, 0 if d < 1
same side :  ± | impact(d0) − impact(d1) |           + with the positive factor if d1 < d0, − with the negative one otherwise
crossover :  impact+(d0) − impact−(d1)               positive factor on the initial gap, negative on the next
positive factor = min(positive, negative)
virtual inventory: if the result is negative and the index has one, recompute on (long = −v, short = 0) or (long = 0, short = v),
                   both shifted by the size for a decrease, and keep the WORSE of the two
caps: +maxPositionImpactFactorPositive × size, −maxPositionImpactFactorNegative × size
```

Sources: `PositionPricingUtils.getPriceImpactUsd`, `_getPriceImpactUsd`, `getNextOpenInterestForVirtualInventory`,
`PricingUtils.applyImpactFactor` (https://github.com/gmx-io/gmx-synthetics/tree/updates/contracts/pricing),
https://docs.gmx.io/docs/trading/fees/ . Two facts were established against the venue's figures, not from the docs:

1. every market sets `useOpenInterestInTokensForBalance`: the imbalance is **open interest in tokens × price**, not the USD cost
   basis (the cost basis gives three times the venue's figure on the recorded LTC position);
2. a decrease moves **the position's tokens × current price**, not its `sizeInUsd`.

The non-integer power is computed on 50-digit fixed point and rounded to 30 decimals (`powDec`).
The impact is not in the entry price: it is recorded at the open and settled at the close, netted with the close impact, within
the caps. The router counts it in the all-in cost with an uncertainty of ±100 % of itself, and shows the netted round trip.

## 5. Costs

| Component | Hyperliquid / dYdX | GMX |
|---|---|---|
| `spread_slippage` | size × (average price − book mid) | size × (oracle max or min − oracle mid) |
| `trading_fee` | taker rate × filled notional (+ maker × resting); base tier, `constant` | size × position fee factor: the lower one if the trade reduces the imbalance (`venue`) |
| `price_impact` | — | formula above, capped |
| `execution_fee` | — | minimum the contracts require: `gasPrice × (ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1 + ESTIMATED_GAS_FEE_PER_ORACLE_PRICE × 3 + INCREASE_ORDER_GAS_LIMIT × ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR)` read from the DataStore by `eth_call` (`GasUtils.adjustGasLimitForEstimate`), × ETH price of the snapshot |
| `network_gas` | — | 1 000 000 gas (measured) × gas price × ETH price |
| `funding` | size × oracle price × current hourly rate × hours; paid by longs when positive | size × current hourly rate of the side × hours (venue sign: positive = receives) |
| `borrow` | — | size × current hourly borrowing rate of the side × hours |
| `collateral_transfer` | 0 when the account asked about holds enough free collateral; otherwise gas of one USDC transfer on Arbitrum (62 000 gas, measured) + deposit facts (minimum 5 USDC, no fee documented, 1 USDC to withdraw later) | **unknown** (no venue account; depends on where the funds are) |

Funding and borrowing are today's rate held constant: **the rates change** (hourly on the books, every second on GMX, where the
order itself moves the imbalance that drives them). An unknown component is `usd: null`, is not in the total, and is named in
`allIn.unknown`; the total is then a lower bound.

**All-in** = sum of the known components (entry + carry over the horizon), in USD and in bps of the order's notional, with
`uncertaintyUsd` = sum of the components' half-widths. **Exit** (information, not in the all-in): closing the same size at once
on the same snapshot; `roundTripUsd` = all-in + exit.

Uncertainty half-widths — conventions, not measurements: slippage = half spread × size; price impact ±100 %; execution fee ±50 %;
gas ±50 %; funding = half the last-24 h range of the hourly rate × notional × hours (±100 % without history); borrowing ±100 %
(or the other side's rate when this side pays none); fees 0.

## 6. Margin

Initial margin = notional ÷ leverage (`margin.ts`). Maintenance: Hyperliquid `1 / (2 × max leverage)` (documented rule, tiers
ignored); GMX `minCollateralFactorForLiquidation` of the market (`venue`); dYdX unknown outside BTC/ETH → no estimate.
Liquidation price: `liquidationPriceIsolated`, labelled estimate, position funded with exactly its initial margin (GMX: minus
the opening fee, closing fee counted); distance in bps of the entry price.

## 7. Terms, differences, ranking

`terms`: 18 fields per instrument (structure, execution, collateral, settlement, quote, mark price, funding interval and rule,
other carry, max leverage, margin modes, tick, lot, size unit, minimum order, maintenance, liquidation, fees).
`differences`: the fields whose values differ, `interchangeable: false` (a literal), and a statement that no two of the contracts
are the same — including two pools of one venue.

`ranking`: eligible instruments by all-in cost, lowest first; equal figures share a rank (`tiedWith`); `nearTieWith` = the gap is
within the sum of the two uncertainties; `roundTripRank` and `orderChangesWithExit` say when the immediate close reorders them.
`selected` is always `null`. UI wording: « le moins coûteux d'après ces estimations » / "lowest cost according to these
estimates", never "best".

## 8. Risk view

Per candidate: `risk.venue` (the venue's own limits = the blockers) and, for each account in `accountIds` on that venue,
`risk.accounts[]` = what the account's risk policy says, through the service's own `preview` (`checkOrder`; paper accounts, and
venue accounts through the live service's `preview`) — `accepted`, or the refusal `code` and reason. Nothing is stored or placed.
A venue account's collateral is read from the venue (`watch`); a testnet account is not asked (the router prices mainnet).

## 9. Validation against reality (2026-11-11, read-only)

`npx tsx scripts/sim-deriv-router.mts` — public reads only. Full output: `router-sim-2026-11-11.txt`.

- **Hyperliquid fill vs an independent computation** (own request for the raw `l2Book`, integer arithmetic, no shared code):
  14 cases (BTC, ETH at 1 000 / 25 000 / 500 000 USD, DOGE at 25 000, both sides) — filled size, levels and worst price
  identical; average price within 7e-10 relative (float rounding of the independent side).
- **GMX impact vs the venue's `closePriceImpactDeltaUsd` of 30 real open positions** (BTC, ETH, SOL, LTC, TAO, GOLD, HYPE, ZEC,
  CC, GMX, SPX6900 markets): three runs, largest relative difference 0.013 %, 0.059 % and 1.29 % (in the last run two small
  BTC positions differed by 1.28 %; the other 28 by ≤ 0.02 % — positions and market state are two requests, the open interest
  moved in between); 3 positions per run are decided by the virtual inventory (ETH, SOL shorts), where the market's own
  imbalance alone is 31 % off. A recorded consistent set (`test/fixtures/gmx-router/`) replays four of them in the tests.
- **Gas**: 10 Classic GMX requests used 833 133 – 1 740 858 gas (median ≈ 940 000); 30 relayed (Express) ones 1.0 – 3.9 M.
  Plain USDC transfers 40 343 – 62 870. ETH sent with Classic requests: 0.000134 – 0.000231 (median), against the contracts'
  minimum 0.0000824 at 0.02 gwei: the interface sends 1.6 – 2.8 times the minimum, and the excess is refunded.

Observed that day (BTC long, 3×, 24 h): the pool `BTC/USD [BTC-USDC]` ranks first on all-in cost at every size (4.7 – 6.7 bps
against 7.6 – 7.9 bps on Hyperliquid) only because a long reduces its imbalance and earns a **positive impact credit**; with an
immediate close the credit is taken back and Hyperliquid is lower (13.0 – 13.5 bps against 13.6 – 17.9). On ETH and DOGE
Hyperliquid is lowest on both figures. dYdX's book costs 12 bps of slippage at 500 000 USD on BTC against 0.07 on Hyperliquid.

## 10. Known gaps and what is not verified

- The GMX formula is verified for **decreases** only: the venue publishes no figure for an order that is not placed
  (`POST /orders/txns/prepare` is on the order path and is not called). The opening leg is the same function, unverified.
- GMX impact pool balance (can cut a positive impact), UI fee, referral discount, relay fee (Express), swap of the collateral:
  not modelled. The execution fee is the contracts' minimum, not what a keeper really keeps (not measured).
- GMX funding and borrowing after the order (the order changes the imbalance and the utilisation): not modelled.
- Hyperliquid: base fee tier only (the account's real tier is not read), margin tiers by size, open-interest caps, and depth
  beyond the 20 levels of `l2Book` are not modelled; large sizes on small markets end as `book_snapshot_ends`.
- Hyperliquid deposit: the legacy Arbitrum bridge facts of the dossier; nothing was sent, CCTP route not priced.
- dYdX: maintenance margin unknown outside the dossier's BTC/ETH figure; shown for information only.
- Liquidation estimates ignore funding accrual, cross margin, tiers, and (GMX) price impact and the liquidation fee.
- Uncertainty half-widths are conventions. "Near tie" is only as good as they are.
- Reduce-only intents are priced without knowing the position (no check that it exists).
- The service was run against live venues only through the script's own snapshot builder; `RouteService` itself is tested on
  fixtures, never against the live APIs, and `chain-costs.ts` has no fixture test of its own (it ran live in the script).
- Engine texts (`basis`, `uncertainty`, reasons' details, contract terms) are English; the UI localises labels and reason codes.

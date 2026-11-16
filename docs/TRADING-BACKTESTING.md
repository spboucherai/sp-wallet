# Trading backtesting — the lab's engine, cost models, splits, bias controls, metrics, reproducibility

State: V11 (2026-11-15), branch `v11-quant-lab`. Code: `research/src/spq` (Python package `spq`), tests `research/tests`.
This document describes the **research zone**: it reads public market data, simulates, writes reports. Nothing in it
places an order, holds a key, talks to the signer or changes a mandate. A report states what was measured, on which
data, with which costs; it never says a strategy is profitable.

Earlier documents stay valid for what they describe: `research/README.md` (spot lab, strategy contract),
`docs/v4/quant-perps.md` (perp account model, margin, liquidation, funding alignment — unchanged), `docs/v8/SANDBOX.md`
(how the API runs lab processes). This document is the reference for everything V11 added: **execution realism, engine
parity, multi-venue data, data-bias analysis, the version-3 report and its reproducibility**.

---

## 1. The engine in one page

```
close of bar t      the strategy sees bars <= t (at most `lookback`), funding settled at or before ts[t] included,
                    and returns target weights (signed fractions of account equity; contract 2)
                    -> [engine parity] the weights are scaled by the owner's default caps (one factor <= 1)
open of bar t+1     funding settled in (ts[t], ts[t+1]] is paid on the position held; gap liquidation check
                    orders = target - current, per instrument; reducing orders first
                    -> [engine parity] minimum trade (2 % of equity), venue minimum x 1.05, lot truncation
                    -> margin check PER VENUE ACCOUNT (orders that do not fit are cut or refused)
                    -> each fill pays: taker (or maker) fee of ITS venue, size-dependent slippage, the latency bound
inside bar t+1      liquidation on the adverse extremes, per venue account (docs/v4/quant-perps.md)
close of bar t+1    mark to market
                    -> [engine parity] loss limits (3 % of the capital in a UTC day, 10 % in total) or a liquidation:
                       flatten at the next open, then NO FURTHER DECISION (the agent is stopped)
```

Money is exact (`decimal.Decimal`, a context that raises on rounding); the identity

```
final equity = initial + realised PnL + funding - fees - slippage - latency + unrealised PnL + debt written off
```

is checked on every run from the running balance and, independently, from the trade and funding logs
(`checks.ledger`). Files: `perp_engine.py` (account, fills, liquidation), `execution.py` (latency, slippage, parity
rules), `data/venues.py` (fee table, symbol map), `engine.py` (spot engine; parity only).

Everything bracketed, and everything in sections 2 and 3, is **off unless the config carries an `ExecutionModel`
and a parity object**: without them the engines are the pre-V11 ones, bit for bit (the 335 pre-V11 tests pass
unchanged, and the committed version-1 / version-2 reports still validate).

---

## 2. Cost models, with their sources

### 2.1 Latency (`ExecutionModel.latency_model = "adverse_bound"`, default `latency_s = 60`)

A decision exists at the bar's close. The live perp engine passes once every 60 s
(`services/api/src/agents/perp-live.ts:85`), so the order reaches the venue up to one minute later — inside the next
bar. Hourly bars do not say where the price was one minute after the open. The model is a **bound**, not an
estimate:

```
f          = min(1, sqrt(delay / bar length))                    sqrt(60 / 3600) = 0.129 at 1h
buy  price = open + f x (high - open)                            of the fill bar
sell price = open - f x (open - low)
delay      = latency_s + k x order_spacing_s                     k = number of exposure-adding orders already sent
                                                                 for this decision (LIVE: one per pass, 45 s cool-down,
                                                                 services/api/src/agents/perp-exec-live.ts:36)
```

The position is booked at the open and the difference is charged as its own cost line, `latency`, so it is visible
gross -> net. It is always against the order: for an order uncorrelated with the next minute the true expected cost
is about zero, for a strategy that buys what is rising it is positive. Read it as "what the result becomes if the
minute after the close always goes against us by the square-root-of-time share of that bar's range". A delay longer
than the bar is capped at the bar's extreme and counted (`orders_delayed_beyond_one_bar`). The pre-V11 model is
`latency_model = "next_open", latency_s = 0`; every report shows it side by side on the validation split
(`robustness.execution_sensitivity`), with a 300 s variant.

**The spot engine has no latency model** (all orders of a bar fill at its open). Stated in section 9.

### 2.2 Slippage (`slippage_model = "sqrt_impact"`)

```
cost_bps = half_spread_bps + Y x sigma_bar x sqrt(Q / V_bar) x 1e4          capped at max_impact_bps (100)
```

`Q` = order notional (USD); `sigma_bar` = standard deviation of the last 24 bar returns; `V_bar` = mean USD volume
per bar over the same 24 bars — both ending at the bar **before** the fill (tested: changing later bars does not
change them). `Y = 1`. This is the square-root law of market impact (Almgren, Thum, Hauptmann & Li, "Direct
estimation of equity market impact", 2005; Tóth et al., "Anomalous price impact and the critical nature of
liquidity in financial markets", Phys. Rev. X 2011: impact ≈ Y σ sqrt(Q/V) with Y of order one). "Calibrated from bar
volume" means exactly that: the bar's own volume is the liquidity proxy. **Nothing is fitted to fills: the lab has
none.** A symbol without volume data (GMX oracle candles) pays the cap.

**Order-book-based slippage.** When recorded book snapshots are supplied, the cost of an order is read on the
measured depth curve instead (`spq.data.books.depth_profile`: for 100, 1 000, 10 000, 100 000 and 1 000 000 USD, the
median and the 90th percentile over the snapshots of the cost of walking the book, worse of buy and sell;
log-linear interpolation; the 90th percentile is used; never below the half spread; beyond the visible depth the
formula takes over). The recording used by the V11 run is summarised in the committed file
`research/src/spq/params/book_calibration.json` (recorder: `spq data record-books`, section 5.3), so a run is reproducible
without the raw snapshots. It is ONE short recording: see section 9.

Half spread per symbol = max(venue default, measured 90th percentile). Venue defaults (`data/venues.py`):
Hyperliquid 0.5 bps, edgeX 0.5, dYdX 1.5, GMX 3, spot swap 10.

### 2.3 Fees — maker and taker per venue (`research/src/spq/data/venues.py`, base tier, no rebate)

| Venue | Taker | Maker | Minimum order | Source | Checked |
|---|---:|---:|---:|---|---|
| Hyperliquid | 4.5 bps | 1.5 bps | 10 USD | hyperliquid.gitbook.io/hyperliquid-docs/trading/fees (tier 0, perps); `docs/v4/venues/contract-differences.md` | 2026-11-10 |
| edgeX | 4.5 bps | 4.0 bps | 10 USD (lab floor) | live `getMetaData` (`defaultTakerFeeRate 0.00045`, `defaultMakerFeeRate 0.0004`) and `/api/v2/public/vip/config/list` level 0; `docs/v11/research/edgex-api.md` | 2026-11-15 |
| dYdX (v4 chain) | 5.0 bps | 1.0 bps | 1 USD | docs.dydx.exchange, trading fees, tier 1 (documentation, not an endpoint) | 2026-11-15 |
| GMX v2 | 6.0 bps | 6.0 bps | 2 USD | docs.gmx.io trading v2: 0.04 % / 0.06 % position fee; the worse one is used | 2026-11-15 |
| spot leg | 10 bps | 10 bps | 2 USD | lab assumption for an on-chain swap; floor `MIN_TRADE_USD` (`services/api/src/agents/engine.ts:31`) | 2026-11-15 |

`PerpConfig.liquidity` chooses taker (default: the agent path only sends IOC orders) or maker (a what-if). The row
used is printed in every report (`execution_model.fees.fee_table`, with source and date).

### 2.4 Funding per venue, at the venue's real interval

| Venue | Interval | How the lab has it |
|---|---|---|
| Hyperliquid | 1 h | `fundingHistory` (hourly rate, settlement instants a few ms after the hour) |
| edgeX | **4 h** | `getFundingRatePage?filterSettlementFundingRate=true` (verified: settlements 14 400 000 ms apart, `fundingRateIntervalMin 240`) |
| dYdX | 1 h | indexer `/v4/historicalFunding/<ticker>` (`effectiveAt` one hour apart) |
| GMX v2 | continuous | **approximation, not modelled as a series**: borrow fee + funding fee accrue per second from pool utilisation and open-interest imbalance; no public REST endpoint serves their history. The lab has GMX candles (oracle prices) and refuses to backtest a GMX perpetual (`load_multivenue` raises) rather than invent a funding series. |

A settlement belongs to the bar that opens at its time; the `funding` column of bar i is the sum of the rates
settled in (ts[i-1], ts[i]]. With a 4 h venue on 1 h bars three bars out of four carry `0.0` (nothing was due) and
`NaN` still means "a settlement was due and the data do not have it" (`attach_funding(..., interval_s)`). The engine
charges `-signed size x reference price x rate` on the position held coming into the bar, in the account of that
venue. `checks.funding_alignment` rebuilds every column from the raw settlements with the venue's interval.

### 2.5 Liquidation

Perpetuals: the exact intrabar model of `docs/v4/quant-perps.md`, unchanged, applied **per venue account**. Spot
legs: not applicable (unlevered, never liquidated). When a liquidated account's loss exceeds its collateral the
excess is written off (`bad_debt_written_off`): it cannot be taken from another venue.

### 2.6 Accounts and capital

`accounts = "per_venue"` (default): each venue (and the spot leg) is its own account with its own collateral
(`capital_split`, default equal shares of the initial cash). Weights stay fractions of TOTAL equity. There is **no
transfer** between accounts: a delta-neutral pair whose legs sit on two venues gains on one and loses on the other,
and the losing account can be cut by the margin check or liquidated while the pair is flat overall. This is the
"capital on both venues" constraint; margin utilisation and funding per account are in `venue_accounts`.

---

## 3. Engine parity — the backtest sizes like the live engine

One file, `research/src/spq/params/engine-parity.json`, states the live engines' values with `path:line` provenance;
`spq.execution.load_parity()` reads it; `tests/test_v11_engine.py::test_parity_file_is_the_engine…` re-reads every
named line of the TypeScript source and fails when a value moved. Values at commit `ad52bec`:

| Perp engine rule | Default | Source |
|---|---:|---|
| account leverage / order leverage setting | 2 | `services/api/src/agents/perp-engine.ts:29` |
| gross exposure ≤ x × capital × (1 − 2 % − slippage bound) | 1.5 | `perp-engine.ts:31`, `:72` |
| one position ≤ x × capital × (same headroom) | 1 | `perp-engine.ts:33` |
| gross ≤ leverage × equity × 0.9 | 0.9 | `perp-engine.ts:70` |
| slippage bound of an IOC order | 30 bps | `perp-engine.ts:38` |
| minimum trade (share of equity; a full exit always trades) | 2 % | `perp-engine.ts:40` |
| venue minimum notional × factor | 1.05 | `perp-engine.ts:74` |
| daily / total loss: flatten, then stop | 3 % / 10 % of the capital | `perp-engine.ts:35`, `:36` |
| engine pass | 60 s | `perp-live.ts:85` |
| LIVE cool-down between exposure-adding orders (→ one per pass) | 45 s | `perp-exec-live.ts:36` |
| orders per minute / per day (account policy) | 40 / 400 | `perp-engine.ts:93` |

| Spot (vault) engine rule | Default | Source |
|---|---:|---|
| exposure cap (weights scaled together) | 50 % | `services/api/src/agents/routes.ts:35` |
| per-order cap / per-day cap | 25 USD / 100 USD | `routes.ts:38`, `:39` |
| orders per day | 12 | `routes.ts:40` |
| minimum trade | max(2 USD, 2 % of equity) | `engine.ts:31` |
| LIVE: orders per pass | 1 (sells first, largest) | `engine.ts:122` |
| loss limit: sell to cash under the same caps, then stop | 5 % | `routes.ts:37` |

What the backtest does with them:

- **Perp** (`PerpConfig.parity`): `scalePerpWeights` is ported (`PerpParity.scale`, one factor for all weights,
  never up); the leverage setting of orders is the owner's, not `META["max_leverage"]`; the order plan follows
  `planPerpOrders` (one floor = max(minimum trade, venue minimum × 1.05) for every order but a full close; a flip
  whose opening half is under the floor sends the close only); lot truncation as before; one exposure-adding order
  per pass through the latency model; loss limits and a liquidation stop the run. `config.rebalance_threshold` is
  replaced by the engine's minimum trade. Benchmarks are not agents: they keep the execution costs and none of the
  caps.
- **Spot** (`BacktestConfig.parity`, CLI `python -m spq.backtest --engine-parity`): exposure cap, per-order and
  per-day USD caps, orders per day, minimum trade, one order per engine pass (at most bar / 60 s orders per bar),
  loss-limit liquidation under the same caps, then stop.

The report prints the rules (`engine_parity.parameters`, each with its `path:line`) and what they did
(`engine_parity.observed.<split>`: decisions scaled down, smallest factor, orders below the minimum trade, the
stop). **These are the defaults.** An owner who sets other limits gets another agent than the one described.

Not in parity (stated, section 9): the engine watches loss limits every minute at live marks, the backtest at bar
closes; the live executor's `floor_guard`; partial IOC fills; `decision_every` (a backtest option the engines do not
have — V11 runs never use it).

---

## 4. Splits, walk-forward, look-ahead, selection bias

Unchanged discipline (`research.py`, `robustness.py`), extended to every V11 strategy type:

- **Chronological 60 / 20 / 20** train / validation / test. Selection code (`trial`, `run`, sensitivity,
  walk-forward) only ever receives data truncated before the test split; the test split is reachable once per
  strategy name through `final_test()`, with the parameters of `META`; afterwards the experiment is sealed.
  Multi-venue frames (several accounts, funding at several intervals, spot legs) go through the same `PerpExperiment`.
- **Walk-forward**: 4 rolling folds inside train + validation (`robustness.walk_forward`), reported, never selecting
  the parameters used on the test split.
- **Look-ahead check, mandatory**: `checks.lookahead` (truncation test: decisions and equity up to a cut must not
  change when later bars are removed) is in every report and `tests/test_v11_strategies.py` runs it for every V11
  strategy under the V11 execution model. Slippage inputs and the latency bound are covered: the first uses bars
  before the fill only, the second the fill bar only.
- **Selection bias**: every configuration run on train + validation is a recorded trial; **a version-3 report
  cannot be built without a ledger** (`build_report_v3` raises). The run's ledger is committed as
  `<run>/trials.jsonl`; the deflated Sharpe ratio (Bailey & López de Prado 2014) of every report is recomputed with
  ALL the trials of the run (choosing among strategies is a selection). Below 0.95 "no skill" is not rejected.
- The cost-sensitivity runs (`execution_sensitivity`) are on the **validation** split, never on the test split.

---

## 5. Multi-venue data layer

### 5.1 Loaders (`data/multivenue.py`; read-only public endpoints, each called live on 2026-11-15)

| Venue | Candles | Funding |
|---|---|---|
| Hyperliquid | `POST /info {candleSnapshot}` (last 5 000 bars per interval) | `POST /info {fundingHistory}` |
| edgeX | `GET /api/v2/public/quote/getKline` (`klineType=HOUR_1`, `priceType=LAST_PRICE`, ≤ 1 000 rows, `offsetData` paging, newest first) | `GET /api/v2/public/funding/getFundingRatePage?filterSettlementFundingRate=true` |
| dYdX | `GET indexer.dydx.trade/v4/candles/perpetualMarkets/<ticker>?resolution=1HOUR&toISO=` | `GET /v4/historicalFunding/<ticker>?effectiveBeforeOrAt=` |
| GMX v2 | `GET arbitrum-api.gmxinfra.io/prices/candles?tokenSymbol=&period=1h` (oracle prices, no volume) | none (section 2.4) |
| Coinbase (spot legs) | `spq.data.fetch` | — |

Files: `<data>/<venue>/<SYM>_<interval>.parquet`, `<data>/<venue>/funding/<SYM>.parquet`, and
`<data>/<venue>/captures.json` (per file: capture time, endpoint, rows, first / last, content hash). `research/data`
is git-ignored: **raw data are never committed**; the manifest is (`research/data-manifests/2026-11-15-v11.json`:
hashes of the values, ranges, row counts, capture time).

```bash
cd research
uv run python -m spq data pull --venues hyperliquid,edgex,dydx,gmx,coinbase --symbols BTC,ETH,SOL --days 180 --out data
uv run python -m spq data quality --root data --out results/2026-11-15-v11/data-quality
uv run python -m spq data manifest --root data --start 2026-05-19T00:00:00Z --end 2026-11-15T00:00:00Z \
    --out data-manifests/2026-11-15-v11.json
```

### 5.2 Instruments and the common clock

Lab symbols: `BTC` = the perpetual on the primary venue (Hyperliquid, the only venue the live engine trades);
`BTC@EDGEX`, `BTC@DYDX` = the same underlying elsewhere; `BTC.SPOT` = a spot leg. The reviewed map
(`data/venues.py` `SYMBOL_MAP`) covers BTC, ETH, SOL — the live-pinned set — with ids read from each venue's own
metadata (edgeX `30000001/2/3` = `BTCUSDC/ETHUSDC/SOLUSDC`; the loader refuses an id whose live contract name
differs). An id that is not in the map is never guessed.

`load_multivenue` aligns on bar-open time: the union grid, a boolean mask per symbol (True = bar present), and the
frames restricted to the bars present for **every** symbol. Nothing is filled. Quote currencies (USD, USDC, a
USDT-heavy index) are **not converted**.

### 5.3 Order-book snapshots

`spq data record-books --venues hyperliquid,edgex,dydx --symbols BTC,ETH,SOL --cadence 5 --minutes 60` — one HTTP
request per (venue, symbol) per round (Hyperliquid `l2Book`, edgeX `getDepth?level=15`, dYdX
`/v4/orderbooks/perpetualMarket/<ticker>`), top 20 levels, one JSON line per snapshot with its own capture time; a
failed request is recorded as a failure, never filled. A snapshot is the visible book at one instant: no trade, no
queue, nothing between two snapshots.

---

## 6. Data-bias analysis (section `data_bias` of every version-3 report)

| Bias | What the report states |
|---|---|
| Survivorship | `universe_fixed_ex_post: true` — the universe is chosen on the run date among instruments listed and liquid today; results are conditional on having picked survivors |
| Listing-date truncation | requested start, common start, first bar of each symbol, which symbols set the start |
| Missing bars | per symbol: expected / missing bars, ratio, longest gap |
| Stale prices | per symbol: bars whose close did not move with zero volume (or flat bars on a source without volume), ratio |
| Exchange outage gaps | per symbol: holes of at least 3 bars, with their dates |
| Common clock | union bars, common bars, the share dropped because one symbol lacked a bar |

The data-quality report of the store (`spq data quality`) adds the funding series (settlements, missing, off grid,
mean rate) and the cross-venue close differences.

---

## 7. Metrics — definitions

All per split, each split backtested from cash. Annualisation: bars per year of a 24/7 market (8 760 at 1h),
risk-free rate 0.

| Metric | Definition |
|---|---|
| `total_return` | final equity / first equity − 1 (net) |
| `volatility` | standard deviation of bar returns × sqrt(bars per year) |
| `sharpe`, `sortino` | mean / standard deviation (downside deviation) of bar returns, annualised; `null` when undefined |
| `max_drawdown` | largest peak-to-trough fall of closing equity (positive fraction); `worst_intrabar_drawdown` with every long at the low and every short at the high |
| `win_rate`, `profit_factor` | on closing fills (realised PnL of the closed part minus that fill's fee and slippage) plus the unrealised PnL of open positions |
| `turnover` | traded notional / mean equity; `turnover_annual` scaled to a year |
| `exposure` | mean gross notional / equity; also long, short, net, time in market, margin utilisation |
| `fees_paid`, `slippage_paid`, `funding_pnl` | USD |
| **`gross_to_net`** (v3) | `price_pnl` (realised + unrealised at fill reference prices) → `funding` → `trading_fees` → `liquidation_penalties` → `slippage` → `latency` → `net_pnl`, with the exact identity `net = price + funding − fees − penalties − slippage − latency + bad debt written off`; `return_gross`, `return_after_funding`, `return_net`; `sharpe_gross` (costs and funding added back to the equity curve; sizes are the net run's) and `sharpe_net`; cost drag in bps of mean equity |

---

## 8. The version-3 report and reproducibility

Schema: `research/schema/backtest-report-v3.schema.json`. **Additive**: every version-2 key keeps its meaning;
versions 1 and 2 (schemas, writers, readers, committed reports) are untouched. New keys: `execution_model`,
`engine_parity`, `venue_accounts`, `data_bias`, `journal`, `metrics.<split>.gross_to_net`,
`robustness.execution_sensitivity`; symbols may carry a venue (`BTC@EDGEX`).

**Journal** (`journal`): strategy name / version / SHA-256; code version (`spq` version and `code_sha256`, the hash
of every `src/spq/**/*.py`, of the parameter files and of the v3 schema); data snapshot hash (of the frames the run
used, after alignment) with the manifest it came from; parameters; seed; resample count; split fractions.

**No wall clock.** `generated_at` is the capture time of the data snapshot. Same strategy file, same lab source,
same data, same seed, same starting ledger → **the same bytes** (`tests/test_v11_report.py::
test_running_twice_gives_byte_identical_reports`). A run directory holds `manifest.json` with the SHA-256 of every
file it wrote:

```bash
uv run python -m spq v11 run    --data-dir data --manifest data-manifests/2026-11-15-v11.json --out results/2026-11-15-v11
uv run python -m spq v11 verify --data-dir data --manifest data-manifests/2026-11-15-v11.json --out results/2026-11-15-v11
```

`verify` re-runs everything into a temporary directory and compares the hashes (exit 1 on any difference). It needs
the data store (not in git): re-pulling later gives the same closed bars only as far as the venues keep serving
them — Hyperliquid serves its last 5 000 hourly candles, so the 2026-05-19 start of this snapshot will fall out of
reach around 2026-12-13.

---

## 9. What is NOT modelled

- **No order-level simulation.** Bars + one fill per order. No order book through time, no partial IOC fill, no
  queue, no maker fill model in the backtester (the maker fee is a what-if). Market making is a separate MODEL STUDY
  on recorded snapshots (`research/studies/market_making_as`), with fills modelled, not observed.
- **Latency is a bound**, not a measured distribution; the spot engine has none.
- **Slippage** is a formula (or one short book recording), not fills. Impact is not persistent (no decay, no
  cross-impact); the half spread is constant in time.
- **Venues other than Hyperliquid use the underlying's Hyperliquid leverage and maintenance fraction** (edgeX
  allows more leverage and a lower maintenance margin: the lab is conservative there) and a flat maintenance margin
  everywhere (no tiers), whole-account liquidation, no ADL — as in V4.
- **No transfer between venues**, no bridge or withdrawal cost or delay, no rebalancing of collateral.
- **GMX** is not backtested as a perpetual (no funding / borrow history); its price impact and pool-based fees are
  not modelled.
- **Quote currencies are not converted** (USD, USDC, USDT-heavy indices); a level difference between venues is
  partly that.
- **Mark and oracle prices**: candles are trade prices; funding is charged on the perpetual's own price and
  liquidation uses trade highs and lows (V4 limits, unchanged).
- **Spot legs** are Coinbase candles with an assumed 10 + 10 bps; on-chain execution (gas, pool depth, MEV) is not
  modelled.
- **Engine parity is at bar resolution**: loss limits are checked at closes; the live engine checks every minute.
- **History is short**: 180 days, one regime sequence; a test split of five weeks. Deflated Sharpe ratios assume
  independent trials.
- **Survivorship**: the universe is fixed ex post (section 6).

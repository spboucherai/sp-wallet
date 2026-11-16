# spq — research and backtesting laboratory (SP Wallet V3)

Python lab of the **research zone** of `docs/v3/ARCHITECTURE.md`: it reads market data, runs long-only spot
strategies, and writes reports. It proposes; it never executes. Nothing here places an order, holds a key, talks to
the signer or changes a mandate.

```
research/
  pyproject.toml, uv.lock      Python 3.12, pinned dependencies (uv)
  src/spq/
    data/        load_candles (PostgreSQL `candles` table or Parquet/CSV), quality checks, fetch (Coinbase, Kraken)
    strategy.py  strategy contract: loader, SHA-256 identity, META validation, purity guard, weight validation
    engine.py    event-driven backtester (decision on closed bar, fill at next open, fee + slippage) + benchmarks
    metrics.py   per-split metrics            dsr.py  probabilistic / deflated Sharpe ratio
    research.py  chronological splits, Experiment (test split enforcement, trial ledger), grids
    robustness.py  sensitivity, walk-forward, block bootstrap, Monte Carlo, stress windows, look-ahead check
    report.py    JSON report + schema validation
    backtest.py  CLI: one strategy -> report      signal.py  CLI used by the engine      pipeline.py  whole library
  schema/        backtest-report.schema.json, signal-input.schema.json, signal-output.schema.json
  strategies/<name>/<version>/strategy.py + README.md (hypothesis)
  results/2026-11-10/   reports of the library on real data (see "Results" below)
  tests/         uv run pytest
```

## Quick start

```bash
cd research
uv sync
uv run pytest                                   # 406 tests: 404 pass, 2 live-network tests need SPQ_NETWORK_TESTS=1

# public, keyless data into ./data (ignored by git)
uv run python -m spq.data.fetch --symbols ETH,BTC,LINK,SOL --interval 1h --start 2024-11-10 --end 2026-11-10 --out data
uv run python -m spq.data.fetch --symbols ETH,BTC,LINK,SOL --interval 1h --start 2026-10-01 --source kraken --out data

# one strategy -> one report
uv run python -m spq.backtest --strategy strategies/ma_trend/1 --symbols ETH,LINK --interval 1h \
    --start 2024-11-10 --end 2026-11-10 --fee-bps 10 --slippage-bps 10 --data-dir data --out report.json

# every strategy of the library, with a shared trial count
uv run python -m spq.pipeline --symbols ETH,BTC,LINK,SOL --interval 1h --start 2024-11-10 --end 2026-11-10 \
    --data-dir data --out results/2026-11-10 --min-order 5 --rebalance-threshold 0.05 --decision-every garch_regime=24
```

## Data

`spq.data.load_candles(symbol, interval, start, end, ...)` returns `(DataFrame, Quality)`; `load_universe` does it
for several symbols and keeps their common timestamps.

- **PostgreSQL (production path)**: `database_url=` or `DATABASE_URL`. Reads the engine's table
  `candles(source, symbol, interval, ts, open, high, low, close, volume)`, primary key
  `(source, symbol, interval, ts)`, `ts` = bar-open time UTC, exactly as in the architecture document. The session is
  opened read-only. `source=` (or `SPQ_CANDLE_SOURCE`) chooses the source; if the table holds several sources for a
  series and none is chosen, the loader refuses instead of mixing them. Written against the documented schema and
  tested against a throw-away PostgreSQL 17 instance; the ingester did not exist yet, so it has not been run
  against the real table.
- **Files (tests, offline)**: `root=` or `SPQ_DATA_DIR`, layout `<root>/<source>/<SYMBOL>_<interval>.parquet|csv`
  with a `ts` column.
- **Downloader** `python -m spq.data.fetch`: Coinbase Exchange (`/products/{SYM}-USD/candles`, full history, 300
  bars per request) and Kraken (`/0/public/OHLC`, **last 720 bars only**: a cross-check of recent bars, not a
  history). Both endpoints were queried live on 2026-11-10.

Every loader returns **closed bars only** (a bar is closed when `ts + interval <= now`), UTC, oldest first.
Duplicated timestamps raise (`on_duplicate="drop_identical"` merges exact copies; conflicting copies always raise).
Gaps are counted and listed in `Quality` (`on_gap="raise"` to refuse them) and are **never filled**; the backtester
simply moves to the next existing bar. `Quality.ok()` is the hard yes/no (no OHLC violation, no off-grid timestamp,
at most 0.5 % missing bars, no gap longer than 24 bars).

## Writing a strategy

A strategy version is a directory `strategies/<name>/<version>/` with `strategy.py` (and a `README.md` stating the
hypothesis and what would refute it). Its identity is the SHA-256 of `strategy.py`.

```python
META = {"name": "eth_trend", "version": "1", "universe": ["ETH", "LINK"], "interval": "1h", "lookback": 720,
        "params": {"fast": 24, "slow": 168}}

def target_weights(data, params):
    """data[symbol]: OHLCV DataFrame indexed by UTC bar-open time, closed bars only, oldest first, at most
    `lookback` rows. Return {symbol: weight}, each in [0, 1], sum <= 1; the rest stays in USDC."""
    out = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        up = len(close) >= params["slow"] and close[-params["fast"]:].mean() > close[-params["slow"]:].mean()
        out[symbol] = 1.0 / len(data) if up else 0.0
    return out
```

Rules enforced by `spq.strategy`:

- `META` has exactly the six keys above; `lookback` is the number of closed bars the function needs (the engine
  passes exactly that many and makes no decision before they exist). Choose it larger than the longest window so
  that the sensitivity grid (which doubles each numeric parameter) still has enough history.
- Weights: a dict, finite numbers in [0, 1], known symbols only, sum ≤ 1 (tolerance 1e-9). Missing symbols mean 0.
  Anything else stops the backtest and makes the signal runner exit non-zero.
- **Pure function.** No memory between calls: if a rule needs a state ("in position since the breakout"), rebuild
  it from the window (see `donchian_breakout`). Parameters live in `META["params"]`: they are part of the hashed
  file, so approving a hash approves the parameters. To try other parameters for real, write a new version.
- **v8 — what the purity guard is.** A lint for honest mistakes and research hygiene, NOT a security boundary. The
  security boundary is the OS sandbox of every process that loads a strategy (`docs/v8/SANDBOX.md`; its tests run with
  this lint disabled). The static check (`spq.purity`) was a short deny-list and was trivially evaded — 17 of the 19
  patterns of `tests/evasions.py` passed it, nine of them shown to execute (`from typing import sys`,
  `pd.io.common.os`, `np.ctypeslib`, `(x for x in ()).gi_frame.f_builtins`, `locals()["__builtins__"]`, a `match` class
  pattern reading `__globals__`, `pd.eval`, …). It is now an allow-list policy: listed modules used through a reviewed
  API, a module object never used as a value, no dunder or `_private` access anywhere, no `class` / decorator / global
  state, no string evaluation (`.format`, `.eval`, `.query`, string annotations), `numpy.random` refused statically
  (exit 4 at load instead of 5 at run time). The 26 library strategies pass unchanged (same files, same hashes).
- Purity is enforced as far as an in-process check can:
  1. *static* (AST): imports limited to `math`, `numpy`, `pandas`, `scipy`, `statsmodels`, `arch`, `sklearn` and a
     few stdlib helpers; `open`, `eval`, `exec`, `__import__`, `getattr`, `.now()`, `.today()`, `read_csv`, `load`,
     `global`… are refused;
  2. *runtime guard* around each call: sockets, DNS, `open`/`io.open`/`os.open`, subprocess, `time.time` & co,
     `os.urandom` and the global numpy random functions raise `PurityError`;
  3. inputs are copy-on-write views: writing into them cannot reach the engine's data.

  **Limits.** This is a guard against mistakes, not a security sandbox. C-level entry points cannot be patched
  (`datetime.now()`, `pandas.Timestamp.now()` are only caught by the static check), module-level code runs before
  the guard, and determined code can reach the originals through introspection, `ctypes` or a C extension. The guard
  patches module attributes process-wide, so it is not thread-safe. The real protection is the architecture: the
  research zone has no keys, the engine must run `spq.signal` in an OS-level sandbox (no network, read-only
  filesystem) with a timeout, and the signer enforces the mandate whatever a strategy returns.

## Backtesting

```
close of bar t      strategy sees bars <= t (at most `lookback`) -> target weights
open of bar t+1     engine trades towards the targets at open[t+1]: buys pay open*(1+slippage) + fee,
                    sells receive open*(1-slippage) - fee (both in bps of traded notional); sells first
close of bar t+1    portfolio marked to market
```

The strategy is given `df.iloc[t+1-lookback : t+1]` and nothing else: the bar it is filled on is not in its inputs.
Tests (`tests/test_lookahead.py`) check that inputs end at the decision bar, that a rule which would be a money
machine with one leaked bar earns nothing, that shifted data give shifted results, that changing future bars does
not change the past, and that the truncation check used in every report detects a deliberately leaky engine.

Options: `--min-order` (USD; smaller orders are skipped), `--rebalance-threshold` (a symbol whose weight is within
this distance of its target is left alone; default 0.05 in the CLI — with 0 the portfolio is rebalanced at every
bar; a full exit is never blocked), `--decision-every N` (ask the strategy every N bars, anchored on UTC), `--split`
(default 0.6,0.2,0.2), `--grid` (explicit sensitivity grid), `--ledger` (persistent trial count).

Research hygiene is in the API, not in a convention:

- `Experiment` hands selection code (`trial`, `run`, `parameter_sensitivity`, `walk_forward`) data truncated before
  the test split; asking for the test split raises `TestSplitError`.
- `Experiment.final_test()` is the only way to the test split. It can be evaluated once per strategy name; after
  that, any further trial for that strategy and any second evaluation with other parameters raise.
- `spq.backtest` always evaluates the test split with `META["params"]`. The grid is reported as a robustness
  analysis and never selects anything.
- Every configuration run on train + validation is a **trial**; every look at a test split is counted. With
  `--ledger file.jsonl` both survive across runs (nothing stops you from deleting the file: the ledger makes
  repeated looks visible, it cannot make them impossible).

## Reading a report

`schema/backtest-report.schema.json` is the reference (the report is validated before it is written).

| Key | Meaning |
|---|---|
| `strategy_sha256`, `config` | what was run: hash, symbols, interval, data range, costs, execution options, parameters |
| `splits` | `[first bar, last bar]` of train / validation / test (chronological, bar-open times) |
| `metrics.<split>` | each split backtested from cash. `sharpe`, `sortino`, `volatility` annualised with the bar interval (8 760 bars/year at 1h, 24/7), risk-free 0. `max_drawdown` is a positive fraction. `turnover` = traded notional / average equity over the split. `trades` = fills. `win_rate` / `profit_factor` on closed lots (each sell against average cost, open positions marked at the end). `fees_paid`, `slippage_paid` in USD. `exposure` = average invested fraction. `returns` = per-bar distribution. Undefined ratios are `null`. |
| `benchmarks` | same metrics on the **test** split: `buy_and_hold` (equal weights bought once), `equal_weight` (rebalanced with the same threshold), `buy_and_hold_<SYM>` |
| `robustness.parameter_sensitivity` | train and validation Sharpe/return of each configuration of the grid (default: every numeric parameter halved and doubled, one at a time). A result that only exists for one cell is fragile. |
| `robustness.walk_forward` | 4 rolling folds inside train + validation: best configuration in-sample, then run out-of-sample |
| `robustness.bootstrap_sharpe_ci` | 95 % stationary-block-bootstrap interval of the test Sharpe ratio. If it contains 0, the sign of the Sharpe ratio is not established. |
| `robustness.monte_carlo` | spread of total return / drawdown when bars are resampled, and of P&L when closed lots are resampled (dependence on a few trades) |
| `robustness.stress_windows` | strategy vs benchmark during the benchmark's three largest drawdowns of the test split |
| `robustness.trials_tested`, `deflated_sharpe` | number of configurations tried and the Deflated Sharpe Ratio (Bailey & López de Prado 2014): probability that the true Sharpe ratio is positive given that many trials, the variance of their validation Sharpe ratios, and the skewness, kurtosis and length of the test returns. Below 0.95, "no skill" is not rejected. Inputs are in `deflated_sharpe_detail`. |
| `robustness.test_evaluations` | how many times this strategy name looked at a test split (ledger) |
| `checks.lookahead` | truncation test on the last 1 500 test bars |
| `checks.data_quality` | `pass` only if every series passes `Quality.ok()`; `notes` lists gaps and cross-source deviation |
| `equity_curve` | test split, `[bar-open time, equity at that bar's close]` |

A report never says a strategy is profitable. It says what was measured, on which data, with which costs.

## Signal runner (engine side)

```
uv run python -m spq.signal --strategy <dir> --sha256 <hash> --input <file.json | ->
```

Prints one line `{"strategy_sha256", "as_of", "weights": {symbol: number}}` and exits 0, or prints nothing on
stdout, one line on stderr, and exits non-zero: 2 bad input, 3 hash mismatch (no strategy code is executed), 4
strategy cannot be loaded, 5 the strategy raised or broke purity, 6 invalid weights, 1 anything else.

The architecture document does not define the input; this is what the runner expects
(`schema/signal-input.schema.json`), **to be agreed with the engine**:

```json
{"candles": {"ETH": [["2026-11-10T11:00:00Z", open, high, low, close, volume], ...], "LINK": [...]},
 "as_of": "2026-11-10T11:00:00Z", "interval": "1h"}
```

Exactly the symbols of `META["universe"]`, closed bars, oldest first, strictly increasing, identical timestamps
across symbols, at least `lookback` bars (the last `lookback` are used). `as_of` and `interval` are optional
cross-checks. `as_of` in the output is the bar-open time of the last bar used. The runner has no clock: it cannot
know whether the last bar is really closed — the engine must guarantee it. Parameters cannot be passed in the
input. Missing bars inside the lookback window are refused beyond 2 % of the window or a gap of more than 6 bars
(`--max-missing-fraction`, `--max-gap-bars`).

## Strategy library

All on ETH, BTC, LINK, SOL at 1h, parameters fixed before any backtest. Each directory has a README with the
hypothesis and what would refute it.

| Strategy | Idea |
|---|---|
| `ts_momentum/1` | hold an asset while its 30-day return is positive |
| `ma_trend/1` | hold while the 3-day mean is above the 20-day mean |
| `mean_reversion/1` | scale in as the price falls below its 48-hour mean (z-score), out at the mean |
| `donchian_breakout/1` | in on a 20-day high, out on a 10-day low |
| `vol_target_trend/1` | `ma_trend`, position scaled by 40 % / realised volatility (never above 1/N) |
| `xs_momentum/1` | hold the 2 assets with the best 30-day return (always invested) |
| `pairs_rotation/1` | ETH/BTC and SOL/LINK: rotate into the cheap leg when the spread looks stationary (always invested; not market-neutral) |
| `garch_regime/1` | daily trend, switched off when the GARCH(1,1) one-day forecast is above 1.25 × its median (one decision per day) |

## Results on real data (2026-11-10)

Coinbase 1h candles, 2024-11-10 → 2026-11-09 (17 510 common closed bars; 10 bars missing per symbol, longest gap
5, not filled). Train 2024-11-10 → 2026-01-21, validation → 2026-06-17, **test 2026-06-17 → 2026-11-09** (3 502
bars, about 4.8 months). Fee 10 bps + slippage 10 bps, initial cash 1 000 USD, minimum order 5 USD, rebalance
threshold 0.05. Full reports, trial ledger and table: `results/2026-11-10/`.

| Strategy | Test return | Sharpe (95 % CI) | Max DD | Trades | Costs (USD) | Exposure | Train / validation Sharpe | Deflated Sharpe (46 trials) |
|---|---:|---|---:|---:|---:|---:|---|---:|
| ts_momentum/1 | +24.3 % | 1.65 [-1.55, 4.71] | -15.7 % | 144 | 72.69 | 0.67 | -0.38 / -2.85 | 0.154 |
| garch_regime/1 | +20.4 % | 1.69 [-1.87, 4.80] | -13.2 % | 78 | 45.35 | 0.51 | -0.04 / -0.94 | 0.157 |
| ma_trend/1 | +18.8 % | 1.42 [-1.77, 4.43] | -10.6 % | 42 | 21.44 | 0.55 | -0.65 / -0.68 | 0.122 |
| donchian_breakout/1 | +17.0 % | 1.53 [-1.73, 4.53] | -13.8 % | 25 | 13.17 | 0.41 | +0.17 / -0.66 | 0.136 |
| vol_target_trend/1 | +16.8 % | 1.63 [-1.90, 4.85] | -8.1 % | 59 | 20.29 | 0.43 | -0.53 / -0.57 | 0.149 |
| pairs_rotation/1 | +13.8 % | 0.91 [-1.97, 3.94] | -26.6 % | 110 | 61.21 | 1.00 | -0.30 / -1.93 | 0.069 |
| xs_momentum/1 | +2.1 % | 0.36 [-2.62, 3.25] | -28.7 % | 191 | 196.56 | 1.00 | -0.55 / -3.14 | 0.034 |
| mean_reversion/1 | -18.3 % | -2.21 [-4.27, -0.05] | -20.8 % | 2 150 | 333.87 | 0.26 | -2.41 / -4.49 | 0.000 |
| **buy and hold** (equal weights) | **+19.2 %** | 1.15 [-1.77, 4.19] | -25.5 % | 4 | 2.00 | 1.00 | | |

What these numbers say, and do not say:

- **No strategy shows a credible edge over buy-and-hold after costs.** On the test split two strategies end above
  buy-and-hold in return (ts_momentum +24.3 %, garch_regime +20.4 % vs +19.2 %) and the five trend-type strategies
  have a higher Sharpe ratio and a smaller drawdown, with 41–67 % average exposure. But every bootstrap interval
  contains zero and largely overlaps the benchmark's, the deflated Sharpe ratios are between 0.00 and 0.16 (0.95
  would be needed), and the test split is 4.8 months of one rising market.
- **The same strategies lost money before the test split.** All eight have a negative Sharpe ratio on the
  validation split and seven of eight on the train split. The test split is the only period where they look fine;
  that is what one favourable regime looks like, not evidence of skill.
- `mean_reversion/1` loses in every split; its costs alone (334 USD on 1 000 USD in 4.8 months) rule it out at
  20 bps per trade. `xs_momentum/1` and `pairs_rotation/1` are always invested and do worse than holding.
- The rebalanced equal-weight benchmark equals buy-and-hold on the test split: no weight drifted by 5 points, so
  it never rebalanced.

## Known limits

- **Spot, long-only, no leverage, no shorting.** Market-neutral ideas (pairs) can only be expressed as tilts and
  keep the full market risk.
- **Bar data only.** One fill per decision at the next bar's open plus a fixed slippage. No order book, no spread,
  no depth, no partial fill, no latency, no intrabar path; nothing below the bar interval can be evaluated.
- **Costs are assumptions.** 10 bps + 10 bps is a guess, constant in time and independent of order size. No price
  impact, no minimum fee.
- **Exchange prices are not on-chain execution.** The candles are Coinbase prices. The wallet will trade through
  on-chain routers: pool fees, gas (fixed per swap, so heavy for small orders — a 5 USD rebalance can cost more in
  gas than its fee), price impact against pool depth, MEV, and DEX prices that differ from Coinbase. Idle cash is
  USDC, assumed worth exactly 1 USD and earning nothing. Paper trading with live V2 quotes is the step that
  measures this; a backtest cannot.
- **Short history, one venue.** Two years, four correlated assets, one source (Kraken only cross-checks the last
  ~700 bars: median close difference 1–3 bps, maximum 51 bps). The test split is under five months. Survivorship:
  the universe was chosen today among assets that still exist.
- **Gaps** are not filled; a decision taken before a gap is filled at the first bar after it.
- **Statistics.** Sharpe ratios on hourly returns are annualised with √8760, which assumes uncorrelated returns.
  The deflated Sharpe ratio assumes independent trials (a parameter grid is not), uses the validation Sharpe
  ratios of the trials for their variance and the test split for the tested Sharpe ratio. Train and validation
  metrics start from cash without earlier history, so their first `lookback` bars are idle.
- **Purity guard** is not a sandbox (see above). `decision_every` is a backtest option, not part of `META`: a
  strategy backtested at one decision per day must be called by the engine at the same cadence.
- **Not implemented**: machine-learning models (`scikit-learn` is pinned for them but unused), regime-switching
  models (Markov switching, HMM), microstructure / order-book / funding / on-chain signals, portfolio optimisation
  (risk parity, mean-variance), stop-loss or trailing-stop execution logic, intrabar fills, parameter optimisers
  beyond a grid, combinatorial purged cross-validation and the probability of backtest overfitting.

## Perpetual futures (V4)

Everything above is the spot laboratory and is unchanged. This section is the extension to perpetual futures — long and
short, leverage, funding, margin, liquidation. The model, its formulas with their sources, every simplification and the
reading guide of a version-2 report are in **`docs/v4/quant-perps.md`**; this is the short version.

```
src/spq/
  data/hyperliquid.py   candles + funding history from Hyperliquid's public info endpoint (read-only), funding store,
                        alignment check
  margin.py             margin arithmetic in decimal.Decimal: a port of packages/derivatives/src/margin.ts
  perp_engine.py        cross-margin USDC account: fills, funding, initial-margin check, intrabar liquidation, exact ledger
  perp_metrics.py       v1 metrics + funding PnL, leverage, liquidations, worst intrabar drawdown, ...
  perp_research.py      PerpExperiment (same split / sealing / trial ledger), benchmarks, funding stress windows
  perp_report.py        report, schema version 2          perp_backtest.py, perp_pipeline.py   CLIs
schema/   backtest-report-v2.schema.json, signal-input-v2.schema.json, signal-output-v2.schema.json
strategies/<name>_perp/1/      results/2026-11-10-perps/
```

```bash
# public, keyless data: Hyperliquid perpetual candles + funding, and Coinbase spot for the benchmark / spot legs
uv run python -m spq.data.hyperliquid --symbols BTC,ETH,SOL,HYPE --interval 1h --out data --depth
uv run python -m spq.data.fetch --symbols BTC,ETH,SOL,HYPE --interval 1h --start 2026-04-10 --out data

uv run python -m spq.perp_backtest --strategy strategies/ts_momentum_perp/1 --data-dir data --out report.json
uv run python -m spq.perp_pipeline --strategies strategies --data-dir data --out results/2026-11-10-perps \
    --rebalance-threshold 0.05 --decision-every har_rv_perp=24
```

**Data.** `candleSnapshot`, `fundingHistory`, `meta` and nothing else. The venue serves **only its most recent 5 000
candles per interval** (1h: about 208 days) and the full hourly funding history (BTC, ETH, SOL: since 2023-05-12). Closed
bars, UTC, gaps counted and never filled. A funding settlement belongs to the bar that opens at its hour. Candles are trade
prices: the API has no historical mark or oracle price.

**Strategy contract v2.** `META["kind"] = "perp"` plus `max_leverage` (bound of one weight) and `max_gross_exposure`
(bound of the sum of absolute weights). `target_weights` returns signed fractions of account equity (negative = short);
`data[symbol]` also carries `funding` and `premium` (and `mark`, `index` when available), all truncated at the decision bar.
A symbol `X.SPOT` is a spot leg (long only, paid in full). A META without `kind` is the spot contract, exactly as before.
`spq.describe` and `spq.signal` refuse a perp strategy unless the caller passes `--contract 2`, so a caller that only knows
the spot contract can neither list nor run one; with it, `spq.signal` requires the funding history, refuses any value dated
after the decision bar and prints `{"schema_version": 2, "kind": "perp", ..., "weights": {"BTC": -0.5, ...}}`.

**Backtester.** Funding at each hourly settlement on the position held, fill at the next open (taker 4.5 bps + 2 bps
slippage by default), initial margin `notional / leverage` checked at order time (orders that do not fit are cut pro rata or
refused), maintenance margin `1 / (2 × venue max leverage)`, liquidation inside the bar when the low (long) or high (short)
crosses the level where equity equals the maintenance margin — closed at that level plus a 100 bps penalty, flagged in the
trade log —, wipe-out at zero equity. The account ledger is exact decimal arithmetic: `final equity = initial + Σ realised
PnL + Σ funding − Σ fees − Σ slippage (+ unrealised PnL)` to the last digit, checked on every run (`checks.ledger`).

**Strategies** (`strategies/<name>_perp/1/`, each with hypothesis, mechanism and what would refute it; parameters written
before any backtest):

| Strategy | Idea |
|---|---|
| `ts_momentum_perp/1` | long an asset whose 7-day return is positive, short otherwise |
| `ma_trend_perp/1` | long/short on two moving averages, size inversely proportional to realised volatility |
| `zscore_reversion_perp/1` | fade a 2-sigma deviation from the 48-hour mean, exit at the mean, stop at 4 sigma |
| `pairs_coint_perp/1` | BTC–ETH spread, market-neutral, hedge ratio on a rolling window ending at the decision bar |
| `funding_carry_perp/1` | short a perpetual whose funding is persistently high, sized by a funding z-score — **directional** |
| `funding_carry_neutral_perp/1` | the same signal hedged: spot long + perpetual short |
| `vol_breakout_perp/1` | follow a 24-hour move larger than twice its usual size for 48 hours |
| `har_rv_perp/1` | trend position sized by a HAR-RV volatility forecast, flat when the forecast is far above normal |

**Not implemented, on purpose: microstructure strategies.** Order-book-imbalance and other order-book signals cannot be
backtested here: they need historical book (or tick) data, the public endpoint only serves the current book and none was
recorded. A candle backtest of such a strategy would be a fake; it belongs to the paper engine once books have been
recorded.

### Results on real data (2026-11-10, perps)

Hyperliquid 1h candles and funding, BTC, ETH, SOL, HYPE, 2026-04-16 → 2026-11-11 (4 995 common closed bars after the
5 bars missing in the Coinbase spot series are removed). Train → 2026-08-19, validation → 2026-09-30, **test 2026-09-30 →
2026-11-11** (999 bars, 41.6 days). Taker 4.5 bps + slippage 2 bps, 1 000 USDC, minimum order 10 USD, rebalance threshold
0.05. Full tables and reports: `results/2026-11-10-perps/`.

| Strategy | Test return | Sharpe (95 % CI) | Max DD | Fees + slippage / funding (USD) | Gross lev. mean | Liquidations | Train / validation return | Deflated Sharpe (94 trials) |
|---|---:|---|---:|---:|---:|---:|---|---:|
| zscore_reversion_perp/1 | +6.0 % | 2.08 [−1.77, 5.82] | −5.9 % | 29.63 / −0.05 | 0.37 | 0 | −11.9 % / +2.3 % | 0.059 |
| funding_carry_perp/1 | +1.2 % | 1.89 [−2.52, 5.58] | −1.2 % | 0.32 / +0.79 | 0.03 | 0 | +4.3 % / −4.4 % | 0.053 |
| ts_momentum_perp/1 | +1.1 % | 0.45 [−5.81, 5.75] | −12.6 % | 40.82 / +3.45 | 0.97 | 0 | +23.6 % / +1.0 % | 0.018 |
| funding_carry_neutral_perp/1 | −0.0 % | −0.56 [−3.25, 2.17] | −0.0 % | 0.58 / +0.36 | 0.03 | 0 | +0.0 % / −0.2 % | 0.007 |
| pairs_coint_perp/1 | −1.7 % | −2.93 [−7.04, 2.02] | −2.1 % | 6.57 / −0.06 | 0.24 | 0 | −4.5 % / +0.8 % | 0.000 |
| vol_breakout_perp/1 | −2.3 % | −1.07 [−6.08, 3.40] | −5.6 % | 7.09 / +1.24 | 0.31 | 0 | +13.8 % / +8.7 % | 0.004 |
| ma_trend_perp/1 | −6.4 % | −1.02 [−7.06, 4.08] | −17.0 % | 24.92 / +2.41 | 1.28 | 0 | +4.0 % / −5.9 % | 0.005 |
| har_rv_perp/1 | −9.9 % | −1.61 [−7.03, 3.11] | −20.9 % | 17.92 / +1.77 | 1.30 | 0 | −10.1 % / −13.7 % | 0.003 |
| **perp long 1× incl. funding** | **−22.1 %** | −4.47 [−8.92, 0.17] | −25.4 % | 0.65 / −9.05 | 1.00 | 0 | +10.4 % / +26.1 % | |
| **buy and hold spot** | **−21.4 %** | −4.33 [−8.84, 0.42] | −24.7 % | 2.00 / — | | | +12.2 % / +27.4 % | |

**No strategy shows an edge that survives the statistics.** Every bootstrap interval contains zero and the deflated Sharpe
ratios are at most 0.06 (0.95 needed). The test split is 42 days of a market that fell 21–22 %: all eight strategies ended
above the two long benchmarks there, which is what being net short or mostly flat does in a falling market; on the
validation split, when the market rose 26–27 %, all eight were far below them. No strategy is above `perp_long_1x` on all
three splits, and the sign of most results flips from one split to the next. No liquidation occurred (gross leverage never
above 2.13×). Details and the limits of the run: `results/2026-11-10-perps/summary.md`.

### Known limits (perps)

- **About 208 days of hourly history** on the venue's own candles, four correlated assets, one venue; the test split is six
  weeks.
- **Funding is charged on the perpetual's price, not on the oracle price**, and liquidation uses trade highs and lows, not
  the mark price: neither historical series is served. Flat maintenance margin (no tiers), whole-account liquidation with a
  fixed penalty (no partial liquidation, no backstop, no ADL), a pessimistic worst case when several positions are open.
- **Fills** as in the spot engine: next open, constant slippage, no book, no impact, every fill a taker.
- **Spot legs** come from another venue's candles and share one cash pool with the perpetual account, with no transfer
  delay or cost; the USD / USDT basis is unhedged.
- **The look-ahead check compares decisions at two cut points**: a leak that happens not to change those decisions is not
  detected by it (the unit tests use rules that always react).
- The version-2 shapes (`--contract 2`, report, signal) have no consumer yet on the TypeScript side: they are proposals.

## Research jobs (V7)

An AI coding agent can develop a strategy in this laboratory as a sandboxed *research job*
(`docs/v7/RESEARCH-RUNTIME.md`). Additions, all additive:

- `spq.job` — the job's commands: `info`, `trial` (one configuration on train + validation, counted),
  `evaluate` (the standard report + the claims file; THE look at the inner test split, sealed across processes by the
  job ledger: another `strategy.py` hash afterwards exits 7), `split` (server side: where the test split starts).
- `SPQ_JOB_LEDGER` — when set, every `Experiment` appends its trials and test evaluations there, whatever `ledger=`
  the caller passed.
- `--job-ledger` (`spq.backtest`, `spq.perp_backtest`) — the trials a job consumed are added to the trial count of the
  deflated Sharpe ratio; the variance of the trial Sharpe ratios can only grow (`spq.dsr.deflate_for_job`).
- `spq.lint` — the static purity check of a `strategy.py` without importing it.
- Directories `strategies/rj_<job>/` are strategies installed by the wallet API from research jobs (git-ignored, not
  part of the library and its tests).

## V11 — execution realism, engine parity, multi-venue data, new strategy families

Reference: **`docs/TRADING-BACKTESTING.md`** (engine, cost models with sources, splits, bias controls, metric
definitions, reproducibility, what is not modelled). Work note with the results: `docs/v11/work/quant-lab.md`.
Everything is additive: without an `ExecutionModel` / parity object in the config the engines, the version-1 and
version-2 reports and the 335 earlier tests are unchanged.

```
src/spq/
  execution.py        ExecutionModel (latency bound, square-root / order-book slippage, venue fees, one account per
                      venue), PerpParity / SpotParity read from src/spq/params/engine-parity.json
  data/venues.py      fee table with source and date, funding interval per venue, reviewed symbol map
  data/multivenue.py  loaders (Hyperliquid, edgeX, dYdX, GMX, Coinbase), common clock with masks, quality, manifest
  data/books.py       order-book snapshot recorder and depth profiles
  report_v3.py        version-3 report (schema/backtest-report-v3.schema.json): gross -> net, execution model,
                      engine parity, data bias, journal; byte-for-byte reproducible
  v11_pipeline.py     the V11 run and its `verify`          studies.py   market making, cross-exchange, forecasts
  vol_forecast.py     HAR-RV / GARCH evaluation (QLIKE, MSE)  risk_supervisor.py   pure policy that only PROPOSES
  __main__.py         `python -m spq data|v11|study ...` (script `spq`)
src/spq/params/       engine-parity.json (the live engines' rules, with path:line), book_calibration.json —
                      inside the package, so that the sandboxed lab processes of the API can read them
strategies/           momentum_xs_perp/{1,2}, mean_reversion_bands_perp/{1,2}, statarb_basket_perp/1, basis_cash_carry/1
strategies_xvenue/    funding_arb_cross_venue/1 — needs two venues: NOT in the library the API lists
studies/              market_making_as, cross_exchange_spread, vol_forecast, risk_supervisor (READMEs)
data-manifests/       hashes, ranges and row counts of the data a run used (the raw data stay in ./data, git-ignored)
results/2026-11-15-v11/   reports, trials.jsonl, summary, manifest.json (SHA-256 of every file), studies, data quality
```

```bash
uv run python -m spq data pull --venues hyperliquid,edgex,dydx,gmx,coinbase --symbols BTC,ETH,SOL --days 180 --out data
uv run python -m spq data record-books --venues hyperliquid,edgex,dydx --symbols BTC,ETH,SOL --cadence 5 --minutes 60
uv run python -m spq data manifest --root data --start 2026-05-19T00:00:00Z --end 2026-11-15T00:00:00Z \
    --out data-manifests/2026-11-15-v11.json
uv run python -m spq v11 run    --data-dir data --manifest data-manifests/2026-11-15-v11.json --out results/2026-11-15-v11
uv run python -m spq v11 verify --data-dir data --manifest data-manifests/2026-11-15-v11.json --out results/2026-11-15-v11
uv run python -m spq.backtest --strategy strategies/ma_trend/3 --symbols BTC,ETH --engine-parity ...   # spot, engine caps
```

**Symbols.** `BTC` = the perpetual on Hyperliquid (the only venue the live engine trades), `BTC@EDGEX` = the same
underlying on another venue, `BTC.SPOT` = a spot leg. A perp universe may be generic (`["*"]`, with
`min_symbols` / `max_symbols`); `spq.signal --contract 2` then takes its symbols from the input.

**Live-capable versions.** `momentum_xs_perp/2` and `mean_reversion_bands_perp/2` trade exactly BTC, ETH, SOL — the
instruments pinned for live perps — so they can be attached to an agent that can go live (audit defect D1).
Generic universes, spot legs and cross-venue legs need the TypeScript follow-ups listed in the work note.

**Results (2026-11-15-v11).** `results/2026-11-15-v11/summary.md`. **No V11 strategy shows an edge out of sample**
after the V11 costs and the engine's default limits; several are stopped by the engine's own loss limits. Each
strategy README states its result and a one-line verdict.

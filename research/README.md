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
uv run pytest                                   # 136 tests (+1 live-network test: SPQ_NETWORK_TESTS=1)

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

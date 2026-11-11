# Perpetual-futures strategies on BTC, ETH, SOL, HYPE at 1h (hyperliquid)

Data 2026-04-16T20:00:00+00:00 to 2026-11-11T03:00:00+00:00 (4995 common closed bars). Train 2026-04-16 to 2026-08-19, validation 2026-08-19 to 2026-09-30, **test 2026-09-30 to 2026-11-11**.
Costs: taker fee 4.5 bps + slippage 2.0 bps on traded notional (fills pay the taker fee); spot legs and the spot benchmark 10.0 + 10.0 bps; liquidation penalty 100.0 bps of the liquidated notional; initial collateral 1000.0 USDC; minimum order 10.0 USD; rebalance threshold 0.05.
Parameters are the ones written in each META before any backtest; nothing was selected on the test split.

## Test split

| Strategy | Return | Sharpe | Sharpe 95 % CI | Max DD | Worst intrabar DD | Trades | Fees + slippage (USD) | Funding PnL (USD) | Gross lev. mean / max | Net lev. mean | Time in market | Avg holding (h) | Liquidations | Trials | Deflated Sharpe |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| funding_carry_neutral_perp/1 | -0.0 % | -0.56 | [-3.25, 2.17] | -0.0 % | -0.4 % | 6 | 0.58 | +0.36 | 0.03 / 0.23 | 0.00 | 0.13 | 133 | 0 | 94 | 0.007 |
| funding_carry_perp/1 | +1.2 % | 1.89 | [-2.52, 5.58] | -1.2 % | -1.3 % | 6 | 0.32 | +0.79 | 0.03 / 0.26 | -0.03 | 0.13 | 133 | 0 | 94 | 0.053 |
| har_rv_perp/1 | -9.9 % | -1.61 | [-7.03, 3.11] | -20.9 % | -21.0 % | 63 | 17.92 | +1.77 | 1.30 / 1.68 | -0.48 | 0.99 | 90 | 0 | 94 | 0.003 |
| ma_trend_perp/1 | -6.4 % | -1.02 | [-7.06, 4.08] | -17.0 % | -17.5 % | 85 | 24.92 | +2.41 | 1.28 / 1.55 | -0.44 | 1.00 | 67 | 0 | 94 | 0.005 |
| pairs_coint_perp/1 | -1.7 % | -2.93 | [-7.04, 2.02] | -2.1 % | -3.1 % | 22 | 6.57 | -0.06 | 0.24 / 1.05 | -0.01 | 0.24 | 47 | 0 | 94 | 0.000 |
| ts_momentum_perp/1 | +1.1 % | 0.45 | [-5.81, 5.75] | -12.6 % | -13.1 % | 138 | 40.82 | +3.45 | 0.97 / 1.06 | -0.56 | 1.00 | 30 | 0 | 94 | 0.018 |
| vol_breakout_perp/1 | -2.3 % | -1.07 | [-6.08, 3.40] | -5.6 % | -6.3 % | 42 | 7.09 | +1.24 | 0.31 / 1.02 | -0.23 | 0.57 | 54 | 0 | 94 | 0.004 |
| zscore_reversion_perp/1 | +6.0 % | 2.08 | [-1.77, 5.82] | -5.9 % | -6.7 % | 177 | 29.63 | -0.05 | 0.37 / 1.02 | 0.08 | 0.65 | 16 | 0 | 94 | 0.059 |
| benchmark: perp long 1x incl. funding | -22.1 % | -4.47 | [-8.92, 0.17] | -25.4 % | -25.6 % | 4 | 0.65 | -9.05 | 1.00 / 1.01 | 1.00 | 1.00 | 998 | 0 |  |  |
| benchmark: buy and hold spot | -21.4 % | -4.33 | [-8.84, 0.42] | -24.7 % | n/a | 4 | 2.00 | n/a | n/a / n/a | n/a | n/a | n/a | n/a |  |  |

## Train, validation and test side by side (each split backtested from cash)

| Strategy | Train return | Train Sharpe | Train liq. | Validation return | Validation Sharpe | Validation liq. | Test return | Test Sharpe | Test liq. |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| funding_carry_neutral_perp/1 | +0.0 % | 0.25 | 0 | -0.2 % | -3.89 | 0 | -0.0 % | -0.56 | 0 |
| funding_carry_perp/1 | +4.3 % | 1.77 | 0 | -4.4 % | -2.61 | 0 | +1.2 % | 1.89 | 0 |
| har_rv_perp/1 | -10.1 % | -0.82 | 0 | -13.7 % | -2.72 | 0 | -9.9 % | -1.61 | 0 |
| ma_trend_perp/1 | +4.0 % | 0.48 | 0 | -5.9 % | -0.85 | 0 | -6.4 % | -1.02 | 0 |
| pairs_coint_perp/1 | -4.5 % | -2.98 | 0 | +0.8 % | 3.02 | 0 | -1.7 % | -2.93 | 0 |
| ts_momentum_perp/1 | +23.6 % | 1.77 | 0 | +1.0 % | 0.41 | 0 | +1.1 % | 0.45 | 0 |
| vol_breakout_perp/1 | +13.8 % | 1.47 | 0 | +8.7 % | 2.61 | 0 | -2.3 % | -1.07 | 0 |
| zscore_reversion_perp/1 | -11.9 % | -1.13 | 0 | +2.3 % | 0.92 | 0 | +6.0 % | 2.08 | 0 |
| benchmark: perp long 1x incl. funding | +10.4 % | 0.80 | n/a | +26.1 % | 4.29 | n/a | -22.1 % | -4.47 | 0 |
| benchmark: buy and hold spot | +12.2 % | 0.90 | n/a | +27.4 % | 4.51 | n/a | -21.4 % | -4.33 | n/a |

Return and drawdowns in percent; Sharpe annualised (8 760 bars per year at 1h, risk-free 0); the interval is a 95 % stationary-block-bootstrap interval of the test Sharpe ratio. Max DD uses bar closes; worst intrabar DD values every long at the bar's low and every short at its high against the previous closing peak. Funding PnL < 0 means the strategy paid funding on balance. Leverage = notional / equity at bar closes. Trials = distinct (strategy, parameters) configurations run on train + validation across the whole run; the deflated Sharpe ratio (Bailey & López de Prado 2014) is the probability that the true Sharpe ratio is positive given that many trials. Below 0.95, 'no skill' is not rejected.

## History served by the venue (measured)

| Perpetual | 1h candles from | 4h candles from | 1d candles from | Funding from |
|---|---|---|---|---|
| BTC | 2026-04-16 (208 d) | 2024-07-30 (833 d) | 2020-08-19 (2275 d) | 2023-05-12 (1279 d) |
| ETH | 2026-04-16 (208 d) | 2024-07-30 (833 d) | 2020-08-19 (2275 d) | 2023-05-12 (1279 d) |
| SOL | 2026-04-16 (208 d) | 2024-07-30 (833 d) | 2020-09-14 (2249 d) | 2023-05-12 (1279 d) |
| HYPE | 2026-04-16 (208 d) | 2024-12-05 (706 d) | 2024-12-05 (706 d) | 2024-12-05 (706 d) |

## What these numbers say, and do not say

(Written by hand for this run, after the tables above were generated by `python -m spq.perp_pipeline`; re-running the
pipeline regenerates the tables only.)

**No strategy shows an edge that survives the statistics. None is distinguishable from zero, and none is ahead of the
benchmarks on all three splits.**

- **Every bootstrap interval of the test Sharpe ratio contains zero** (the narrowest lower bound is −1.77), and the
  deflated Sharpe ratios, counting the 94 configurations tried in this run, are between 0.000 and 0.059. 0.95 would be
  needed to reject "no skill".
- **The test split is 41.6 days of one falling market**: the four perpetuals held long at 1× lost 22.1 % (of which
  9.05 USDC per 1 000, 0.9 %, was funding paid), the same assets held on spot lost 21.4 %. On that split all eight
  strategies ended above both benchmarks (from −9.9 % to +6.0 %). That is what being net short or mostly flat does in a
  falling market; it is not evidence of skill. The benchmark's own interval ([−8.92, 0.17] for the perpetual,
  [−8.84, 0.42] for spot) overlaps every strategy's interval.
- **On the validation split, when the market rose 26–27 %, every strategy was far below the benchmarks** (−13.7 % to
  +8.7 %). On the train split (benchmarks +10.4 % / +12.2 %) only `ts_momentum_perp` (+23.6 %) and `vol_breakout_perp`
  (+13.8 %) were above. No strategy is above `perp_long_1x` on train, validation and test.
- **Signs flip between splits.** `zscore_reversion_perp`, the best on the test split (+6.0 %, Sharpe 2.08,
  interval [−1.77, 5.82]), lost 11.9 % on the train split. `vol_breakout_perp` gained on train and validation
  (+13.8 %, +8.7 %) and lost 2.3 % on the test split. `ts_momentum_perp` made +23.6 % on train and about +1 % on each of
  the two later splits. `pairs_coint_perp` lost on train and test and gained on validation with 5 trades. The walk-forward
  folds inside train + validation show the same instability (out-of-sample Sharpe ratios of each strategy range from
  about −5 to +6).
- **Costs are a large share of what moves.** On the test split, fees + slippage were 40.82 USDC per 1 000 for
  `ts_momentum_perp` (138 fills), 29.63 for `zscore_reversion_perp` (177 fills), 24.92 for `ma_trend_perp`: 2.5–4 % of
  equity in six weeks, at 6.5 bps per fill. On the train split `ts_momentum_perp` paid 118 USDC of costs for a 236 USDC
  gain, `zscore_reversion_perp` 77 USDC for a 119 USDC loss.
- **Funding carry barely traded.** Funding averaged 6–11 % a year on the test split and 3–10 % on the train split —
  mostly at or below the venue's floor rate (10.95 % a year) because of negative hours — so the 15 % threshold was
  rarely met: the carry strategies held a position on 7 % of the train bars, 23 % of the validation bars and 13 % of
  the test bars. `funding_carry_perp` (unhedged short) collected 0.79 USDC of funding on the test split and
  made +1.2 % because prices fell while it was short; on the validation split the same rule collected 1.48 USDC and lost
  4.4 % because prices rose. That is the directional risk its README announces. The hedged version
  (`funding_carry_neutral_perp`) collected 0.36 USDC and paid 0.58 USDC of costs: −0.0 % on test, −0.2 % on validation,
  +0.0 % on train. At these funding levels the hedged carry does not pay for its four fills.
- **`har_rv_perp` and `ma_trend_perp` lost on the test split (−9.9 %, −6.4 %) and on validation (−13.7 %, −5.9 %)**
  with the largest drawdowns of the library (−20.9 %, −17.0 % on test; −30.6 %, −35.3 % on train). The HAR sizing did
  not give a steadier result than the trailing-volatility sizing.
- **Liquidations: none, on any split, for any strategy.** Gross leverage stayed between 0.01× and 1.3× on average and
  never above 2.13× (`har_rv_perp` on validation, against its 2× setting: prices moved after the fill; its margin
  utilisation peaked at 1.07, meaning no exposure could have been added, still far from the maintenance level). The
  liquidation code path was therefore not exercised by these runs (it is by the tests). On the test split
  `worst_intrabar_drawdown` exceeds the close-to-close drawdown by 0.1 to 1 point.
- **Checks**: `lookahead`, `data_quality`, `ledger` and `funding_alignment` pass in the eight reports. Hyperliquid candles
  and funding have no missing bar or settlement over the period; Coinbase spot candles miss 5 bars (one gap of 5), which
  removes 5 of the 5 000 bars from every run (4 995 common bars).

### Limits of this run

- **History.** The venue serves only its most recent 5 000 hourly candles (about 208 days): 125 days of train, 42 of
  validation, 42 of test, four correlated assets, one venue, one market cycle fragment. Funding history goes back to 2023
  but cannot be backtested at 1h without the candles. Strategies with a 1 100–1 200-bar lookback (`funding_carry_*`,
  `har_rv_perp`) are idle for the first 46–50 days of the train split.
- **The pairs strategy's test split was looked at twice.** While the pipeline was being built, `pairs_coint_perp/1` was
  run once end to end as a smoke test, with the same parameters, data and costs; it printed the same test figures
  (−1.7 %, Sharpe −2.93). Nothing was changed afterwards — parameters of the eight strategies are those written before any
  backtest — but that look is not in this run's ledger (`test_evaluations` says 1).
- **Costs and penalties are assumptions** (taker 4.5 bps is the venue's base tier; slippage 2 bps and the 100 bps
  liquidation penalty are not measured). Fills are at the next hourly open with no book, no impact, no latency.
- **Model simplifications** (funding on the perpetual's price instead of the oracle, trade highs/lows instead of the mark
  price, flat maintenance margin, whole-account liquidation, spot legs from another venue with free transfers): see
  `docs/v4/quant-perps.md`, section 4.
- **Statistics.** Hourly Sharpe ratios annualised with √8760 assume uncorrelated returns; the deflated Sharpe ratio assumes
  independent trials and uses the validation Sharpe ratios of the trials for their variance. A parameter grid is not a set
  of independent trials.
- Survivorship: the four perpetuals were chosen on 2026-11-10 among the most traded ones.

Reports: `<strategy>-1.json` (schema `schema/backtest-report-v2.schema.json`), `summary.json`, `trials.jsonl`
(94 trials + 8 test evaluations), `history_depth.json`.

Reproduce:

```bash
cd research
uv run python -m spq.data.hyperliquid --symbols BTC,ETH,SOL,HYPE --interval 1h --out data --depth
uv run python -m spq.data.fetch --symbols BTC,ETH,SOL,HYPE --interval 1h --start 2026-04-10 --out data
uv run python -m spq.perp_pipeline --strategies strategies --data-dir data --out results/2026-11-10-perps \
    --rebalance-threshold 0.05 --decision-every har_rv_perp=24 --depth results/2026-11-10-perps/history_depth.json
```

(The venue's 5 000-candle window slides: a later download covers a later period and gives other numbers.)

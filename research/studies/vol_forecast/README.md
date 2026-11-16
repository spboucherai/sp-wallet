# vol_forecast — HAR-RV and GARCH forecast evaluation: a research TOOL

Not a trading strategy: it produces and scores volatility forecasts that other strategies can use for sizing
(`spq.vol_forecast.har_forecast`; `har_rv_perp/1` carries its own copy inside its hashed file, as a strategy must).
Code: `spq.vol_forecast`, `spq.studies.vol_forecast_study`; result: `research/results/2026-11-15-v11/vol_forecast.json`.

**Hypothesis.** Volatility is persistent at several horizons (day, week, month): a model that uses them (HAR-RV,
Corsi 2009) or a GARCH(1,1) forecasts tomorrow's variance better than "tomorrow = today".

**Signal.** Target: next UTC day's realised variance `RV = sum of squared hourly log returns`. Forecasts, each made
at the end of day t from days <= t (expanding window, first forecast after 60 days):
`random_walk` (RV[t]); `ewma` (lambda 0.94); `har`: `RV[t+1] = b0 + b1 RV[t] + b2 mean(RV[t-6..t]) + b3
mean(RV[t-29..t])`, OLS, floored at half of the smallest RV seen; `garch`: GARCH(1,1), zero mean, on daily
close-to-close returns. Losses (Patton 2011): `MSE = mean((RV - h)^2)`, `QLIKE = mean(RV/h - ln(RV/h) - 1)`.

**Parameters.** Week 7 days, month 30 days (24/7 market), minimum training 60 days, lambda 0.94. Nothing tuned.

**Costs assumed.** None: a forecast is not a trade.

**Result (run 2026-11-15-v11).** Hyperliquid hourly closes, 180 days -> 120
forecast days, split chronologically 60 / 20 / 20. Cells: QLIKE / MSE (lower is better).

| Asset | Split | Days | Random walk | EWMA | HAR-RV | GARCH(1,1) | Best QLIKE |
|---|---|---:|---|---|---|---|---|
| BTC | train | 72 | 1.217 / 3.16e-07 | 0.628 / 2.11e-07 | 0.634 / 2.32e-07 | 0.530 / 2.44e-07 | garch |
| BTC | validation | 24 | 0.715 / 9.19e-08 | 0.327 / 4.68e-08 | 0.334 / 5.32e-08 | 0.300 / 4.10e-08 | garch |
| BTC | test | 24 | 1.132 / 2.25e-07 | 0.494 / 1.77e-07 | 0.433 / 1.62e-07 | 0.445 / 1.70e-07 | har |
| BTC | all | 120 | 1.100 / 2.53e-07 | 0.541 / 1.71e-07 | 0.534 / 1.82e-07 | 0.467 / 1.89e-07 | garch |
| ETH | train | 72 | 1.436 / 1.96e-06 | 0.703 / 1.09e-06 | 0.924 / 1.26e-06 | 0.652 / 1.10e-06 | garch |
| ETH | validation | 24 | 0.673 / 4.40e-07 | 0.374 / 2.27e-07 | 0.369 / 2.33e-07 | 0.392 / 2.50e-07 | har |
| ETH | test | 24 | 1.851 / 9.84e-07 | 0.550 / 6.55e-07 | 0.535 / 6.45e-07 | 0.515 / 6.48e-07 | garch |
| ETH | all | 120 | 1.367 / 1.46e-06 | 0.606 / 8.33e-07 | 0.735 / 9.33e-07 | 0.572 / 8.40e-07 | garch |
| SOL | train | 72 | 0.600 / 8.12e-07 | 0.417 / 6.36e-07 | 0.372 / 6.17e-07 | 0.425 / 6.02e-07 | har |
| SOL | validation | 24 | 0.563 / 7.95e-07 | 0.320 / 4.07e-07 | 0.337 / 4.66e-07 | 0.277 / 3.58e-07 | garch |
| SOL | test | 24 | 0.837 / 8.58e-07 | 0.370 / 6.49e-07 | 0.371 / 6.13e-07 | 0.392 / 6.74e-07 | ewma |
| SOL | all | 120 | 0.640 / 8.18e-07 | 0.388 / 5.93e-07 | 0.365 / 5.86e-07 | 0.389 / 5.68e-07 | har |

**Verdict.** Useful as a sizing input, not as a signal: HAR-RV, GARCH(1,1) and EWMA all beat the random walk by a
wide margin on QLIKE in every split and for every asset, and none of the three is consistently the best — with a
few dozen forecast days per split the ranking between them is noise. Nothing here says a forecast earns money
(`har_rv_perp/1`, which sizes a trend with it, lost in the V4 run).

**Failure modes.** 180 days: the monthly term of HAR is estimated on about five non-overlapping months. Realised
variance from hourly returns is itself noisy (24 squares a day). GARCH on daily closes forecasts close-to-close
variance, scored here against intraday RV. A linear HAR can forecast a negative variance (floored). Jumps (a
liquidation cascade) dominate MSE; QLIKE is the more robust of the two.

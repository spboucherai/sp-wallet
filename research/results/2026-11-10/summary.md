# Library strategies on ETH, BTC, LINK, SOL at 1h (coinbase)

Data 2024-11-10T00:00:00+00:00 to 2026-11-09T23:00:00+00:00 (17510 common closed bars). Train 2024-11-10 to 2026-01-21, validation 2026-01-21 to 2026-06-17, **test 2026-06-17 to 2026-11-09**.
Costs: fee 10.0 bps + slippage 10.0 bps on traded notional; initial cash 1000.0 USD; minimum order 5.0 USD; rebalance threshold 0.05.
Parameters are the defaults written in each META before any backtest; nothing was selected on the test split.

Test split:

| Strategy | Return | CAGR | Vol | Sharpe | Sharpe 95 % CI | Sortino | Max DD | Calmar | Turnover | Trades | Win rate | Profit factor | Fees + slippage (USD) | Exposure | Trials | Deflated Sharpe |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| donchian_breakout/1 | +17.0 % | +48.2 % | +28.4 % | 1.53 | [-1.73, 4.53] | 2.25 | -13.8 % | 3.48 | 5.9 | 25 | 0.54 | 2.93 | 13.17 | 0.41 | 46 | 0.136 |
| garch_regime/1 | +20.4 % | +59.3 % | +30.3 % | 1.69 | [-1.87, 4.80] | 2.56 | -13.2 % | 4.49 | 19.6 | 78 | 0.38 | 1.71 | 45.35 | 0.51 | 46 | 0.157 |
| ma_trend/1 | +18.8 % | +54.0 % | +34.6 % | 1.42 | [-1.77, 4.43] | 2.08 | -10.6 % | 5.10 | 9.7 | 42 | 0.43 | 2.50 | 21.44 | 0.55 | 46 | 0.122 |
| mean_reversion/1 | -18.3 % | -39.7 % | +21.9 % | -2.21 | [-4.27, -0.05] | -3.07 | -20.8 % | -1.91 | 178.3 | 2150 | 0.42 | 0.53 | 333.87 | 0.26 | 46 | 0.000 |
| pairs_rotation/1 | +13.8 % | +38.2 % | +48.2 % | 0.91 | [-1.97, 3.94] | 1.28 | -26.6 % | 1.44 | 26.1 | 110 | 0.37 | 1.74 | 61.21 | 1.00 | 46 | 0.069 |
| ts_momentum/1 | +24.3 % | +72.5 % | +37.2 % | 1.65 | [-1.55, 4.71] | 2.43 | -15.7 % | 4.62 | 31.4 | 144 | 0.29 | 2.84 | 72.69 | 0.67 | 46 | 0.154 |
| vol_target_trend/1 | +16.8 % | +47.3 % | +25.8 % | 1.63 | [-1.90, 4.85] | 2.44 | -8.1 % | 5.86 | 9.3 | 59 | 0.60 | 2.66 | 20.29 | 0.43 | 46 | 0.149 |
| xs_momentum/1 | +2.1 % | +5.4 % | +52.8 % | 0.36 | [-2.62, 3.25] | 0.52 | -28.7 % | 0.19 | 90.3 | 191 | 0.30 | 1.03 | 196.56 | 1.00 | 46 | 0.034 |
| benchmark: buy_and_hold | +19.2 % | +55.1 % | +48.5 % | 1.15 | [-1.77, 4.19] | 1.62 | -25.5 % | 2.16 | 0.8 | 4 | 1.00 | n/a | 2.00 | 1.00 |  |  |
| benchmark: equal_weight | +19.2 % | +55.1 % | +48.5 % | 1.15 | n/a | 1.62 | -25.5 % | 2.16 | 0.8 | 4 | 1.00 | n/a | 2.00 | 1.00 |  |  |

Return, CAGR, Vol and Max DD in percent; Sharpe and Sortino annualised (8 760 bars per year, risk-free 0); turnover = traded notional / average equity over the split; win rate and profit factor on closed lots.
Trials = distinct (strategy, parameters) configurations run on train + validation across the whole library; the deflated Sharpe ratio (Bailey & López de Prado 2014) is the probability that the true Sharpe ratio is positive given that many trials. Below 0.95, 'no skill' is not rejected.

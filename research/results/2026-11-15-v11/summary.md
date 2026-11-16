# V11 strategies on real multi-venue data (version-3 reports)

Data 2026-05-19T00:00 to 2026-11-14T23:00 UTC, 1h bars; train 2026-05-19 to 2026-09-03, validation 2026-09-04 to 2026-10-09, **test 2026-10-10 to 2026-11-14** (dates of the first report; each report states its own).
Execution: latency 60 s (adverse_bound), slippage sqrt_impact (Y = 1), taker fees per venue, one account per venue, ENGINE PARITY ON (default limits of the live perp engine). 1 000 USDC.
Trials of the whole run: 31. Parameters are the ones in each META, written before any backtest.

## Out of sample (test split), net of every cost

| Strategy | Symbols | Net return | Net Sharpe | 95 % CI | Gross Sharpe | Max DD | Fills | Deflated Sharpe | Stopped by the engine | Checks |
|---|---|---:|---:|---|---:|---:|---:|---:|---|---|
| momentum_xs_perp/1 | 10 | -3.09 % | -2.27 | [-7.91, 3.40] | -0.70 | -6.90 % | 262 | 0.018 | no | all pass |
| momentum_xs_perp/2 | 3 | -0.20 % | -0.16 | [-5.61, 5.39] | 1.15 | -3.66 % | 92 | 0.074 | no | all pass |
| mean_reversion_bands_perp/1 | 10 | -2.31 % | -1.72 | [-5.86, 4.01] | -1.18 | -3.81 % | 64 | 0.027 | daily_loss | all pass |
| mean_reversion_bands_perp/2 | 3 | +0.56 % | 0.35 | [-4.09, 4.88] | 2.21 | -6.56 % | 116 | 0.099 | no | all pass |
| statarb_basket_perp/1 | 6 | -10.17 % | -11.07 | [-18.48, -4.91] | 0.73 | -10.25 % | 851 | 0.000 | total_loss | all pass |
| basis_cash_carry/1 | 6 | -0.10 % | -4.20 | [-6.75, 0.70] | -0.03 | -0.10 % | 4 | 0.000 | no | all pass |
| funding_arb_cross_venue/1 | 6 | -0.21 % | -3.97 | [-7.63, -0.45] | -0.36 | -0.25 % | 18 | 0.003 | no | all pass |

## Train, validation, test (each split backtested from cash; net)

| Strategy | Train return | Train Sharpe | Train stop | Validation return | Validation Sharpe | Validation stop | Test return | Test Sharpe | Test stop |
|---|---:|---:|---|---:|---:|---|---:|---:|---|
| momentum_xs_perp/1 | -1.33 % | -0.38 | daily_loss | -5.30 % | -5.14 | daily_loss | -3.09 % | -2.27 | no |
| momentum_xs_perp/2 | +1.32 % | 0.46 | no | -4.81 % | -4.31 | no | -0.20 % | -0.16 | no |
| mean_reversion_bands_perp/1 | -3.57 % | -3.39 | daily_loss | -1.33 % | -0.72 | daily_loss | -2.31 % | -1.72 | daily_loss |
| mean_reversion_bands_perp/2 | -3.82 % | -3.14 | daily_loss | -0.41 % | -0.13 | daily_loss | +0.56 % | 0.35 | no |
| statarb_basket_perp/1 | -10.17 % | -7.18 | total_loss | -10.33 % | -10.51 | total_loss | -10.17 % | -11.07 | total_loss |
| basis_cash_carry/1 | -0.05 % | -0.67 | no | -0.16 % | -3.27 | no | -0.10 % | -4.20 | no |
| funding_arb_cross_venue/1 | +0.02 % | 0.07 | no | -0.51 % | -2.68 | no | -0.21 % | -3.97 | no |

## Gross to net on the test split (USD on 1 000 USDC)

| Strategy | Price PnL | Funding | Fees | Slippage | Latency | Net PnL |
|---|---:|---:|---:|---:|---:|---:|
| momentum_xs_perp/1 | -10.07 | -0.55 | -7.05 | -1.48 | -11.72 | -30.87 |
| momentum_xs_perp/2 | +10.66 | -2.55 | -4.43 | -0.66 | -5.01 | -1.98 |
| mean_reversion_bands_perp/1 | -16.11 | +0.01 | -2.86 | -0.59 | -3.51 | -23.06 |
| mean_reversion_bands_perp/2 | +54.89 | -0.09 | -17.91 | -2.98 | -28.33 | +5.57 |
| statarb_basket_perp/1 | +6.15 | -0.38 | -37.63 | -8.94 | -60.85 | -101.65 |
| basis_cash_carry/1 | -0.00 | +0.02 | -0.44 | -0.33 | -0.21 | -0.96 |
| funding_arb_cross_venue/1 | -0.17 | +0.12 | -0.95 | -0.28 | -0.85 | -2.14 |

Net Sharpe: annualised with 8 760 bars per year, risk-free 0, on equity after fees, slippage, latency and funding. Gross Sharpe: the same run with fees, slippage, latency and funding added back (sizes are the net run's). The interval is a 95 % stationary-block-bootstrap interval of the net test Sharpe ratio. Deflated Sharpe (Bailey & Lopez de Prado 2014): probability that the true Sharpe ratio is positive given every trial of the run; below 0.95 'no skill' is not rejected. 'Stopped by the engine': the default loss limits (3 % in a UTC day, 10 % in total) or a liquidation ended the run — the equity is flat afterwards.

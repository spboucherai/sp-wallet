# Data-quality report (1h bars)

| Series | Bars | First bar | Last bar | Missing | Longest gap | Outage gaps | Stale bars | Zero volume | OK |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| hyperliquid/BTC | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | 0.00 % | yes |
| hyperliquid/ETH | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | 0.00 % | yes |
| hyperliquid/SOL | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | 0.00 % | yes |
| edgex/BTC | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 1 (0.02 %) | 0.02 % | yes |
| edgex/ETH | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 1 (0.02 %) | 0.02 % | yes |
| edgex/SOL | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 2 (0.05 %) | 0.05 % | yes |
| dydx/BTC | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 1 (0.02 %) | 0.02 % | yes |
| dydx/ETH | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 1 (0.02 %) | 0.02 % | yes |
| dydx/SOL | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 10 (0.23 %) | 0.23 % | yes |
| gmx/BTC | 4295 | 2026-05-20T01:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | n/a (no volume served) | yes |
| gmx/ETH | 4295 | 2026-05-20T01:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | n/a (no volume served) | yes |
| gmx/SOL | 4295 | 2026-05-20T01:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | n/a (no volume served) | yes |
| coinbase/BTC | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | 0.00 % | yes |
| coinbase/ETH | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | 0.00 % | yes |
| coinbase/SOL | 4320 | 2026-05-19T00:00 | 2026-11-14T23:00 | 0 (0.000 %) | 0 | 0 | 0 (0.00 %) | 0.00 % | yes |

| Funding series | Settlements | Interval | Missing | Longest gap | Off grid | Mean rate / h | Annualised | OK |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| hyperliquid/BTC | 4320 | 1 h | 0 | 0 | 0 | 9.159e-06 | 8.02 % | yes |
| hyperliquid/ETH | 4320 | 1 h | 0 | 0 | 0 | 8.785e-06 | 7.70 % | yes |
| hyperliquid/SOL | 4320 | 1 h | 0 | 0 | 0 | 5.801e-06 | 5.08 % | yes |
| edgex/BTC | 1080 | 4 h | 0 | 0 | 0 | 6.405e-06 | 5.61 % | yes |
| edgex/ETH | 1080 | 4 h | 0 | 0 | 0 | 9.335e-06 | 8.18 % | yes |
| edgex/SOL | 1080 | 4 h | 0 | 0 | 0 | 1.047e-05 | 9.17 % | yes |
| dydx/BTC | 4320 | 1 h | 0 | 0 | 0 | 7.250e-07 | 0.64 % | yes |
| dydx/ETH | 4320 | 1 h | 0 | 0 | 0 | -5.753e-07 | -0.50 % | yes |
| dydx/SOL | 4320 | 1 h | 0 | 0 | 0 | -4.893e-06 | -4.29 % | yes |

| Close vs Hyperliquid (same bar-open time) | Common bars | Mean (bps) | Median abs (bps) | p99 abs (bps) | Max abs (bps) |
|---|---:|---:|---:|---:|---:|
| BTC: edgex vs hyperliquid | 4320 | -7.95 | 8.39 | 16.40 | 34.71 |
| BTC: dydx vs hyperliquid | 4320 | -3.89 | 5.13 | 19.07 | 187.53 |
| BTC: gmx vs hyperliquid | 4295 | -5.55 | 6.01 | 15.73 | 20.01 |
| BTC: coinbase vs hyperliquid | 4320 | -5.79 | 6.17 | 16.98 | 28.03 |
| ETH: edgex vs hyperliquid | 4320 | -8.47 | 8.96 | 16.31 | 25.09 |
| ETH: dydx vs hyperliquid | 4320 | -4.52 | 6.43 | 27.60 | 111.55 |
| ETH: gmx vs hyperliquid | 4295 | -5.65 | 6.11 | 14.26 | 22.71 |
| ETH: coinbase vs hyperliquid | 4320 | -5.79 | 6.25 | 14.94 | 20.58 |
| SOL: edgex vs hyperliquid | 4320 | -8.30 | 8.60 | 18.77 | 27.65 |
| SOL: dydx vs hyperliquid | 4320 | -5.43 | 8.53 | 48.28 | 128.80 |
| SOL: gmx vs hyperliquid | 4295 | -4.94 | 5.50 | 15.93 | 26.62 |
| SOL: coinbase vs hyperliquid | 4320 | -4.87 | 5.46 | 15.98 | 25.21 |

Missing bars are never filled. Stale = close unchanged with zero volume (or a flat bar on a source without volume). Closes are compared at the same bar-open time: the last trade inside the bar is not simultaneous across venues, quote currencies differ (USD, USDC, USDT-heavy index) and GMX candles are oracle prices, so a difference here is not an executable spread.

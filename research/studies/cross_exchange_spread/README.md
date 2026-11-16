# cross_exchange_spread — price discrepancies of one underlying between venues: an ANALYSIS SIGNAL

Not a trading strategy. Its output is an **estimated net edge** in basis points under the assumptions below —
never a profit. Code: `spq.studies.cross_exchange_study`; result: `research/results/2026-11-15-v11/cross_exchange_spread.json`.

**Hypothesis.** The same underlying trades at different prices on two venues; when the difference deviates from
its usual level by more than the cost of a round trip on both venues, buying the cheap venue and selling the rich
one until the deviation closes has a positive expected value.

**Signal.** `spread = close_B / close_A - 1` (bps) on common bars. `level` = rolling median of the spread over the
previous 168 bars (past bars only): the PERMANENT part — quote currency (USD, USDC, USDT-heavy index), index
composition — which does not converge and is not capturable. `deviation = spread - level`.
`estimated net edge = |deviation| - round-trip cost`.

**Parameters.** Level window 168 bars; latency allowance 1 bp per fill. Nothing was tuned.

**Costs assumed.** Round trip = 2 fills per venue: taker fees `2 x (taker_A + taker_B)`, half spreads
`2 x (half_A + half_B)` (venue table defaults), latency allowance `4 x 1 bp`. Funding differential over the holding
time is reported separately and NOT netted (its sign depends on the direction held).

**Assumptions (explicit).**
- capital is ALREADY on both venues (no transfer during the trade; a transfer between venues takes minutes to hours and costs gas and bridge fees that are not modelled)
- the trade is a convergence trade: buy the cheap venue, sell the rich one, close both when the deviation is gone; the PERMANENT part of the price difference (rolling median: quote currency, index composition) is not capturable and is removed
- costs: taker fee on 2 fills per venue, half spread on each fill (venue table defaults), and 1 bps per fill of latency allowance; funding differential over the holding time is reported separately and is NOT netted (its sign depends on the direction held)
- bar closes are the LAST TRADE of each venue inside the same hour, not simultaneous prices: a deviation between two closes is partly asynchrony and is NOT executable; GMX candles are oracle prices, not quotes. The book section uses near-simultaneous recorded quotes (bid on one venue, ask on the other) and is the only executable-price evidence here — on one short recording

**Result (run 2026-11-15-v11) — hourly closes, 180 days.**

| Pair | Common bars | Level (bps, median) | |deviation| median (bps) | |deviation| p95 (bps) | Half-life (bars) | Round-trip cost (bps) | Bars with estimated net edge > 0 | Largest estimated net edge (bps) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| BTC: edgex vs hyperliquid | 4320 | -8.39 | 1.87 | 5.97 | 4.2 | 24.0 | 0.02 % | 14.9 |
| BTC: dydx vs hyperliquid | 4320 | -4.18 | 3.09 | 10.74 | 0.4 | 27.0 | 0.24 % | 157.5 |
| BTC: dydx vs edgex | 4320 | +4.23 | 2.71 | 9.76 | 0.3 | 27.0 | 0.34 % | 155.6 |
| BTC: gmx vs hyperliquid | 4295 | -5.94 | 2.15 | 6.73 | 4.7 | 32.0 | 0.00 % | -12.7 |
| ETH: edgex vs hyperliquid | 4320 | -8.96 | 2.02 | 6.38 | 3.1 | 24.0 | 0.02 % | 3.2 |
| ETH: dydx vs hyperliquid | 4320 | -4.77 | 4.85 | 16.73 | 0.5 | 27.0 | 0.77 % | 81.2 |
| ETH: dydx vs edgex | 4320 | +3.75 | 4.32 | 16.30 | 0.4 | 27.0 | 0.75 % | 76.7 |
| ETH: gmx vs hyperliquid | 4295 | -6.08 | 2.15 | 7.08 | 3.7 | 32.0 | 0.00 % | -14.0 |
| SOL: edgex vs hyperliquid | 4320 | -8.58 | 2.16 | 7.31 | 1.3 | 24.0 | 0.10 % | 8.1 |
| SOL: dydx vs hyperliquid | 4320 | -5.57 | 6.50 | 29.11 | 0.3 | 27.0 | 6.00 % | 99.1 |
| SOL: dydx vs edgex | 4320 | +2.72 | 6.42 | 28.94 | 0.3 | 27.0 | 6.17 % | 97.0 |
| SOL: gmx vs hyperliquid | 4295 | -5.39 | 2.07 | 7.46 | 2.6 | 32.0 | 0.00 % | -0.5 |

**Result — recorded order books (near-simultaneous quotes, one short recording).** Entry edge = bid on the rich
venue / ask on the cheap venue − 1, minus the median mid difference and one taker fee per venue.

| Pair | Paired snapshots | Mid level (bps) | Entry edge median (bps) | p95 | max | Share > 0 | Share > exit cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC: edgex vs hyperliquid | 699 | -4.25 | -8.24 | -5.94 | -2.92 | 0.00 % | 0.00 % |
| BTC: dydx vs hyperliquid | 577 | +2.08 | -10.04 | -7.70 | -3.71 | 0.00 % | 0.00 % |
| BTC: dydx vs edgex | 661 | +6.20 | -10.27 | -8.19 | -5.78 | 0.00 % | 0.00 % |
| ETH: edgex vs hyperliquid | 684 | -3.52 | -8.33 | -5.36 | -2.87 | 0.00 % | 0.00 % |
| ETH: dydx vs hyperliquid | 530 | -4.43 | -10.07 | -3.97 | 1.51 | 0.38 % | 0.00 % |
| ETH: dydx vs edgex | 657 | -1.22 | -10.00 | -4.14 | 1.49 | 0.30 % | 0.00 % |
| SOL: edgex vs hyperliquid | 673 | -4.66 | -10.60 | -7.52 | 0.77 | 0.15 % | 0.00 % |
| SOL: dydx vs hyperliquid | 492 | -1.32 | -10.82 | -8.11 | -4.40 | 0.00 % | 0.00 % |
| SOL: dydx vs edgex | 641 | +3.50 | -14.33 | -10.21 | -6.00 | 0.00 % | 0.00 % |

**Verdict.** No capturable discrepancy between Hyperliquid, edgeX, dYdX and GMX on BTC, ETH, SOL. The price
difference is mostly a permanent level (Hyperliquid about 8 bps above edgeX, 4 to 6 above dYdX and GMX); the
deviations around it are a few basis points against a round trip of 24 to 32 bps. The pairs with dYdX show a
non-zero share of bars above cost on hourly closes — dYdX's hourly close is the last trade of a thin market
(a few dozen trades an hour), minutes away from the other venue's: asynchrony, not an edge; on executable quotes
recorded within two seconds of each other the entry edge after taker fees is negative in essentially every
snapshot and **never** covers the exit.

**Failure modes of the analysis itself.** Bar closes are not simultaneous prices; a rolling median level lags a
real re-pricing (a de-peg shows up as "deviation"); GMX candles are oracle prices, not quotes; the book recording
is one evening; transfer, bridge and withdrawal constraints are assumed away (capital pre-positioned), which
flatters the estimate. Nothing here can be executed by the wallet (one venue; edgeX excluded for Canada).

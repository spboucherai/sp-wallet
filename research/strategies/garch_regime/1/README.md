# garch_regime / 1

**Hypothesis.** Volatility clusters and is forecastable; the days that follow a high conditional-volatility
forecast carry more downside than upside for a long-only holder. Staying out of the market when a GARCH(1,1)
model announces a turbulent day, and following the daily trend otherwise, should cut drawdowns more than returns.

**Rule.** Hourly bars are reduced to the last close of each complete UTC day (180 days of lookback). For each
symbol: (1) trend: last daily close above the mean of the last 30 daily closes; (2) regime: fit a zero-mean
GARCH(1,1) (`arch`) on the daily log-returns of the window and compare the one-day-ahead volatility forecast with
the median fitted volatility of the window; the regime is calm if `forecast <= 1.25 x median`. Weight `1/N` when
both hold, otherwise USDC. If the optimiser does not converge the symbol is not held.

**Cadence.** The output only changes when a UTC day completes, and a fit costs tens of milliseconds, so the
backtests of this strategy use `--decision-every 24` (one decision per day, at 00:00 UTC). The live engine should
call it at the same cadence.

**What would refute it.** GARCH forecasts react AFTER a large move (the shock enters the variance with a lag of one
day), so the filter may step aside after the fall and miss the rebound. About 180 daily observations is a short
sample for a GARCH fit: the parameters are noisy and the threshold `1.25` is arbitrary.

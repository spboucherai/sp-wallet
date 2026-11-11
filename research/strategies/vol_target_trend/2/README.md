# vol_target_trend / 2

Same rule and parameters as version 1, on the universe tradable by SP Wallet agents on Base: ETH, LINK, AAVE.
Parameters were not re-tuned for this universe. The text below is version 1's.


**Hypothesis.** Volatility is persistent and high volatility is not rewarded with proportionally higher returns, so
sizing a trend position inversely to recent realised volatility gives a smoother ride (smaller drawdowns for a
similar return) than a fixed-size trend position.

**Rule.** Same trend signal as `ma_trend/1` (72-bar mean above 480-bar mean). When it is on, the weight is
`(1/N) * min(1, target_vol / realised_vol)`, with `realised_vol` the annualised standard deviation of the last 168
hourly log-returns and `target_vol` = 40 % per year. There is no leverage: the weight is capped at `1/N`, so the
strategy can only reduce risk, never add to it.

**What would refute it.** If volatility spikes mostly AFTER the losses, scaling down comes too late and only
removes exposure to the rebound. The weight moves a little every hour; without a rebalance threshold this
generates many small trades and costs.

# ma_trend_perp / 1

**Hypothesis.** Trends persist for days, and volatility is persistent but not rewarded in proportion: a
long/short trend position whose size is inversely proportional to recent realised volatility keeps a roughly
constant risk and loses less in violent reversals than a fixed-size one.

**Mechanism.** Side: long when the 24-hour mean of the close is above its 120-hour mean, short when below. Size per
asset: `min(max_weight, (target_vol / N) / realised_vol)` of equity, with `realised_vol` the annualised standard
deviation of the last 168 hourly log-returns, `target_vol` = 60 % per year shared between N = 4 assets, and
`max_weight` = 0.5 (so the gross exposure is at most 2× and usually close to 1×). The weight moves a little every
hour; the rebalance threshold of the backtest decides how much of that is traded.

**What would refute it.** No improvement over `ts_momentum_perp/1` in drawdown per unit of return, or a Sharpe ratio
whose interval contains zero. If volatility rises mostly AFTER the loss, the position is cut too late and only the
rebound is missed. Two means that cross often in a range pay fee and slippage on twice the position at each
crossing. Funding is paid on the long side in rising markets, when this strategy is long.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.

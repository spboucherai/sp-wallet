# vol_target_trend / 3

Universe-generic version: `META["universe"] = ["*"]`. The symbols are not written in the strategy; they are the ones the
agent trades (1 to 12 market symbols), passed by the engine with the candles and by `--symbols` to the backtest.
Same rule and same parameters as version 1: nothing was re-tuned, for any universe. Each symbol is judged on its own trend and its own realised volatility; `N` is the number of symbols the agent chose.

**What a generic universe changes.** The code hash still pins the behaviour, and the agent's mandate pins the assets.
But the evidence does not travel: a backtest report is attached to ONE agent and records the symbols it was run on
(`config.symbols`); a result on one universe says nothing about another, and every universe tried is one more trial.
Symbols with a short history shorten the common backtest period for all of them.

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

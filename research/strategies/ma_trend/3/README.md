# ma_trend / 3

Universe-generic version: `META["universe"] = ["*"]`. The symbols are not written in the strategy; they are the ones the
agent trades (1 to 12 market symbols), passed by the engine with the candles and by `--symbols` to the backtest.
Same rule and same parameters as version 1: nothing was re-tuned, for any universe. Each symbol is judged on its own averages; `N` is the number of symbols the agent chose, so one symbol can take the whole allocation when `N = 1`.

**What a generic universe changes.** The code hash still pins the behaviour, and the agent's mandate pins the assets.
But the evidence does not travel: a backtest report is attached to ONE agent and records the symbols it was run on
(`config.symbols`); a result on one universe says nothing about another, and every universe tried is one more trial.
Symbols with a short history shorten the common backtest period for all of them.

**Hypothesis.** Trends persist: when the average price of the last 3 days is above the average of the last 20 days,
the asset is in an up-trend that is more likely to continue than to stop, and being out of the market otherwise
avoids the large drawdowns of a long-only holder.

**Rule.** For each symbol: weight `1/N` if `mean(close[-72:]) > mean(close[-480:])`, otherwise 0 (USDC).

**What would refute it.** Whipsaws: in a range-bound market the two averages cross often and every crossing costs
fee + slippage on the whole position. The rule is always late (it enters after the rise began and leaves after
the fall began); if trends are short relative to the 20-day window it loses to buy-and-hold.

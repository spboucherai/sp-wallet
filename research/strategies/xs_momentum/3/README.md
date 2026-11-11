# xs_momentum / 3

Universe-generic version: `META["universe"] = ["*"]`. The symbols are not written in the strategy; they are the ones the
agent trades (1 to 12 market symbols, at least 3 here), passed by the engine with the candles and by `--symbols` to the backtest.
Same rule and same parameters as version 1: nothing was re-tuned, for any universe. A ranking needs something to rank: with fewer than 3 symbols the function returns cash, `META["min_symbols"] = 3` makes the signal runner refuse the input, and the API refuses to register this version for such an agent. `top_k = 2` is carried over from version 1: with 3 symbols the strategy holds the best two.

**What a generic universe changes.** The code hash still pins the behaviour, and the agent's mandate pins the assets.
But the evidence does not travel: a backtest report is attached to ONE agent and records the symbols it was run on
(`config.symbols`); a result on one universe says nothing about another, and every universe tried is one more trial.
Symbols with a short history shorten the common backtest period for all of them.

**Hypothesis.** Relative strength persists: among the assets of the universe, those with the best return over the
last 30 days keep outperforming the others over the following days (cross-sectional momentum, Jegadeesh & Titman
1993, here on a handful of crypto assets).

**Rule.** Rank the symbols by `close[t] / close[t - 720] - 1` and hold the best `top_k` = 2 with equal weights.
The strategy is ALWAYS fully invested: it selects among assets, it does not time the market, so it carries the
full market risk of a long-only crypto holder. Its fair comparison is the equal-weight benchmark.

**What would refute it.** With four highly correlated assets the cross-section is tiny: rank changes are mostly
noise, each change costs fee + slippage on half the portfolio, and the result can be dominated by one asset.

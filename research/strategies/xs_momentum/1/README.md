# xs_momentum / 1

**Hypothesis.** Relative strength persists: among the assets of the universe, those with the best return over the
last 30 days keep outperforming the others over the following days (cross-sectional momentum, Jegadeesh & Titman
1993, here on a handful of crypto assets).

**Rule.** Rank the symbols by `close[t] / close[t - 720] - 1` and hold the best `top_k` = 2 with equal weights.
The strategy is ALWAYS fully invested: it selects among assets, it does not time the market, so it carries the
full market risk of a long-only crypto holder. Its fair comparison is the equal-weight benchmark.

**What would refute it.** With four highly correlated assets the cross-section is tiny: rank changes are mostly
noise, each change costs fee + slippage on half the portfolio, and the result can be dominated by one asset.

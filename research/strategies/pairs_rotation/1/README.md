# pairs_rotation / 1

**Hypothesis.** Some pairs of crypto assets share a common stochastic trend (they are cointegrated over windows of
a few weeks): the residual of a regression of one log-price on the other is stationary, so when it is far from zero
the "cheap" leg should outperform the "expensive" one as the spread closes.

**Rule.** Pairs: ETH/BTC and SOL/LINK, half of the portfolio each. On the last 720 bars, regress `log A` on `log B`
(OLS with intercept), take the z-score of the last residual and the Dickey-Fuller t-statistic of the residuals
(no lags). If the t-statistic is below -3.34 (Engle-Granger 5 % critical value for two series) and `z < -1`, the
pair's budget goes entirely to A; if `z > 1`, entirely to B; otherwise it is split equally between the two legs.

**This is not a market-neutral pairs trade.** A wallet that cannot short cannot isolate the spread: the strategy is
always fully invested and carries the whole market risk. All it can do is tilt between two assets it would hold
anyway; its fair comparison is the equal-weight benchmark, and the most it can add is the spread convergence.

**What would refute it.** The cointegration test is repeated every hour on a rolling window (a multiple-testing
problem in itself) and rolling-window cointegration between crypto assets is unstable: a "cheap" leg can simply be
the one that is losing for a durable reason. Each rotation costs fee + slippage on half the portfolio, twice.

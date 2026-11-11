# pairs_coint_perp / 1

**Hypothesis.** BTC and ETH share a common stochastic trend: `log ETH − β · log BTC` is stationary over a couple of
weeks, so a stretched spread comes back. Holding the spread (one leg long, the other short) removes most of the
market direction; what is left is the bet on the spread. The spot version (`pairs_rotation/1`) could only tilt
between two long positions and kept the full market risk.

**Mechanism.** At each bar, ordinary least squares of `log ETH` on `log BTC` over the **336 bars ending at that
bar** gives the hedge ratio β, the z-score of the last residual and the Dickey–Fuller t-statistic of the residuals.
Enter when the residuals look stationary (t < −3.04, the 10 % Engle–Granger critical value for two series) and
`|z| > 2`: short the spread if `z > 0` (short ETH, long BTC), long it if `z < 0`. Exit when `z` is back inside ±0.5.
**Stop** when `|z| > 4` or β turns non-positive, and stay out until `z` is back inside ±0.5. Notional weights:
ETH `± gross / (1 + β)`, BTC `∓ gross · β / (1 + β)` — β-weighted, so the position is neutral to a common move of
the two logs (and close to dollar-neutral when β ≈ 1). The rule is replayed over the last 96 bars, each with its
own window, because the function keeps no memory.

**What would refute it.** The stationarity test failing most of the time (then the strategy barely trades and
says nothing), or losses on the trades it does take: a spread that looked stationary in-sample and then drifts is
the standard failure of pairs trading, and the stop turns it into a realised loss. Both legs pay fee and slippage
(four fills per round trip) and each leg pays or receives its own funding: the funding differential between ETH
and BTC is a carry the z-score knows nothing about. β is estimated on 336 points with strongly autocorrelated
residuals; the t-statistic is only an indication.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.

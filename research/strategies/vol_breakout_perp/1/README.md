# vol_breakout_perp / 1

**Hypothesis.** A move that is large relative to the volatility that preceded it is information being absorbed, not
noise: after a 24-hour move of more than two "normal" 24-hour standard deviations, the price continues in the same
direction for the next two days more often than it reverses.

**Mechanism.** At bar t, `move = log(close[t] / close[t − 24])` and `sigma` = standard deviation of the 168 hourly
log-returns that end where the move starts, times √24. A breakout is `|move| > 2 · sigma`. The position is the
side of the most recent breakout among the last 48 bars (long after an upward breakout, short after a downward
one), `gross / N` = 25 % of equity per asset, and flat when no breakout occurred in the last 48 bars. A new
breakout in the opposite direction flips the position. The volatility window deliberately excludes the move
itself, otherwise a large move would raise its own threshold.

**What would refute it.** A test Sharpe ratio indistinguishable from zero, or from `ts_momentum_perp/1` (then the
volatility filter adds nothing to plain momentum). The opposite hypothesis is `zscore_reversion_perp/1`: both
cannot be right at the same horizon, and if neither is distinguishable from zero the honest conclusion is that
large hourly-scale moves carry no usable information after costs. Entering after the move means buying high and
selling low when the move was a liquidation cascade that reverts.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.

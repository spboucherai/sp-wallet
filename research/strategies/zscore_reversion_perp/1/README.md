# zscore_reversion_perp / 1

**Hypothesis.** At the horizon of hours, part of a large move is liquidity pressure that reverts: after a close
more than two standard deviations away from its 48-hour mean, the price tends to come back towards that mean.
With a perpetual the fade works on both sides (short a spike, long a dip).

**Mechanism.** `z` = (close − mean of the last 48 closes) / their standard deviation. Flat → short when `z > 2`,
long when `z < −2`; back to flat when `z` returns inside ±0.5; **stop**: if `|z|` exceeds 4 the position is closed
and no new one is opened until `z` is back inside ±0.5 (a move that keeps going is a trend, not a deviation).
Position `gross / N` = 25 % of equity per asset. The function keeps no memory: it replays the rule over its
300-bar window, so the state is a function of the window (a position opened more than 252 bars ago is forgotten).

**What would refute it.** Losses concentrated in trends: the rule is short what rises and long what falls, so a
trending month produces a string of stops. The spot version (`mean_reversion/1`) lost in every split at 20 bps per
round trip; if this one does not clear 13 bps (two fills at 4.5 bps fee + 2 bps slippage), the hypothesis is
refuted at this horizon and cost. A stop on a z-score is not a price stop: `z` can stay below 4 while the price
keeps drifting, because the standard deviation grows with the move.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.

# mean_reversion / 1

**Hypothesis.** Over a couple of days, a sharp move away from the recent average price is partly a liquidity shock
that reverts: an asset trading well below its 48-hour mean tends to bounce back towards it (the lower Bollinger
band as a buy zone).

**Rule.** `z = (close - mean48) / std48`. Weight per symbol = `(1/N) * clip(-z / z_full, 0, 1)`: nothing at or above
the mean, scaling in linearly below it, fully in at `z <= -2`. There is no memory: the position shrinks as the
price returns to its mean. Long-only, so it never sells the upper band short.

**What would refute it.** It buys falling prices: in a sustained down-trend it is repeatedly long while the price
keeps falling ("catching a falling knife"). It trades often, so costs weigh heavily; with 20 bps per side the
average bounce must be several times larger than that to leave anything.

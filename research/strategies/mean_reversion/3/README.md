# mean_reversion / 3

Universe-generic version: `META["universe"] = ["*"]`. The symbols are not written in the strategy; they are the ones the
agent trades (1 to 12 market symbols), passed by the engine with the candles and by `--symbols` to the backtest.
Same rule and same parameters as version 1: nothing was re-tuned, for any universe. Each symbol is judged against its own recent average; `N` is the number of symbols the agent chose.

**What a generic universe changes.** The code hash still pins the behaviour, and the agent's mandate pins the assets.
But the evidence does not travel: a backtest report is attached to ONE agent and records the symbols it was run on
(`config.symbols`); a result on one universe says nothing about another, and every universe tried is one more trial.
Symbols with a short history shorten the common backtest period for all of them.

**Hypothesis.** Over a couple of days, a sharp move away from the recent average price is partly a liquidity shock
that reverts: an asset trading well below its 48-hour mean tends to bounce back towards it (the lower Bollinger
band as a buy zone).

**Rule.** `z = (close - mean48) / std48`. Weight per symbol = `(1/N) * clip(-z / z_full, 0, 1)`: nothing at or above
the mean, scaling in linearly below it, fully in at `z <= -2`. There is no memory: the position shrinks as the
price returns to its mean. Long-only, so it never sells the upper band short.

**What would refute it.** It buys falling prices: in a sustained down-trend it is repeatedly long while the price
keeps falling ("catching a falling knife"). It trades often, so costs weigh heavily; with 20 bps per side the
average bounce must be several times larger than that to leave anything.

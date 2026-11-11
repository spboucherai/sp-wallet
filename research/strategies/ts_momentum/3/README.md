# ts_momentum / 3

Universe-generic version: `META["universe"] = ["*"]`. The symbols are not written in the strategy; they are the ones the
agent trades (1 to 12 market symbols), passed by the engine with the candles and by `--symbols` to the backtest.
Same rule and same parameters as version 1: nothing was re-tuned, for any universe. Each symbol is judged on its own past return; `N` is the number of symbols the agent chose, so one symbol can take the whole allocation when `N = 1`.

**What a generic universe changes.** The code hash still pins the behaviour, and the agent's mandate pins the assets.
But the evidence does not travel: a backtest report is attached to ONE agent and records the symbols it was run on
(`config.symbols`); a result on one universe says nothing about another, and every universe tried is one more trial.
Symbols with a short history shorten the common backtest period for all of them.

**Hypothesis.** Returns of liquid crypto assets are positively autocorrelated at the horizon of a few weeks: an asset
that went up over the last 30 days is more likely to keep going up than to reverse (time-series momentum, Moskowitz,
Ooi & Pedersen 2012).

**Rule.** For each symbol: weight `1/N` if `close[t] > close[t - window]` (window = 720 hourly bars = 30 days),
otherwise 0. The unused part stays in USDC.

**What would refute it.** No improvement over buy-and-hold in drawdown or Sharpe ratio after costs, out of sample.
The signal flips when the price crosses its level of 30 days ago, which can cause repeated in-and-out trades in a
flat market; each flip costs fee + slippage on the whole position.

# donchian_breakout / 3

Universe-generic version: `META["universe"] = ["*"]`. The symbols are not written in the strategy; they are the ones the
agent trades (1 to 12 market symbols), passed by the engine with the candles and by `--symbols` to the backtest.
Same rule and same parameters as version 1: nothing was re-tuned, for any universe. Each symbol is judged on its own channel; `N` is the number of symbols the agent chose, so one symbol can take the whole allocation when `N = 1`.

**What a generic universe changes.** The code hash still pins the behaviour, and the agent's mandate pins the assets.
But the evidence does not travel: a backtest report is attached to ONE agent and records the symbols it was run on
(`config.symbols`); a result on one universe says nothing about another, and every universe tried is one more trial.
Symbols with a short history shorten the common backtest period for all of them.

**Hypothesis.** A close above the highest high of the last 20 days marks the start of a volatility expansion in
the direction of the break, and such moves tend to run (the classic channel breakout of trend followers).

**Rule.** Upper channel = highest high of the previous 480 bars, lower channel = lowest low of the previous 240
bars (both exclude the current bar). A symbol is held (`1/N`) if, inside the lookback window, its most recent
channel event is a close above the upper channel rather than a close below the lower one; otherwise USDC.
The position state is rebuilt from the window at every call (the function keeps no memory), so the lookback
(2 200 bars) must be several times the channel length; with no event in the window the symbol is not held.

**What would refute it.** False breakouts: the price closes above the channel and falls back, and the exit only
comes at the 10-day low, far below the entry. Few trades, so the estimate of any edge is noisy.

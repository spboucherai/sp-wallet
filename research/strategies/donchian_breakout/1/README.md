# donchian_breakout / 1

**Hypothesis.** A close above the highest high of the last 20 days marks the start of a volatility expansion in
the direction of the break, and such moves tend to run (the classic channel breakout of trend followers).

**Rule.** Upper channel = highest high of the previous 480 bars, lower channel = lowest low of the previous 240
bars (both exclude the current bar). A symbol is held (`1/N`) if, inside the lookback window, its most recent
channel event is a close above the upper channel rather than a close below the lower one; otherwise USDC.
The position state is rebuilt from the window at every call (the function keeps no memory), so the lookback
(2 200 bars) must be several times the channel length; with no event in the window the symbol is not held.

**What would refute it.** False breakouts: the price closes above the channel and falls back, and the exit only
comes at the 10-day low, far below the entry. Few trades, so the estimate of any edge is noisy.

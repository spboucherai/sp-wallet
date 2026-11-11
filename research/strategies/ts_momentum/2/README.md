# ts_momentum / 2

Same rule and parameters as version 1, on the universe tradable by SP Wallet agents on Base: ETH, LINK, AAVE.
Parameters were not re-tuned for this universe. The text below is version 1's.


**Hypothesis.** Returns of liquid crypto assets are positively autocorrelated at the horizon of a few weeks: an asset
that went up over the last 30 days is more likely to keep going up than to reverse (time-series momentum, Moskowitz,
Ooi & Pedersen 2012).

**Rule.** For each symbol: weight `1/N` if `close[t] > close[t - window]` (window = 720 hourly bars = 30 days),
otherwise 0. The unused part stays in USDC.

**What would refute it.** No improvement over buy-and-hold in drawdown or Sharpe ratio after costs, out of sample.
The signal flips when the price crosses its level of 30 days ago, which can cause repeated in-and-out trades in a
flat market; each flip costs fee + slippage on the whole position.

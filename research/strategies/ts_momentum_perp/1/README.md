# ts_momentum_perp / 1

**Hypothesis.** Returns of crypto assets are positively autocorrelated at the horizon of a week: an asset that rose
over the last seven days tends to keep rising over the next hours, and one that fell tends to keep falling. A
perpetual lets the second half of that claim be traded (the spot version, `ts_momentum/1`, can only step aside).

**Mechanism.** For each perpetual, the sign of the 168-hour return decides the side: long if positive, short if
negative. Each position is `gross / N` of equity (N = 4, gross = 1: 25 % of equity per asset, total gross
exposure 1×, net exposure between −1× and +1×). No leverage is needed; `max_leverage` 2 only leaves room for the
sensitivity grid. Funding is a cost of being on the crowded side: in a rising market longs pay shorts, so a trend
follower that is long pays funding exactly when its signal is on.

**What would refute it.** A test-split Sharpe ratio whose bootstrap interval contains zero, or a result below
`perp_long_1x` (the same assets simply held long with funding): the short side then added nothing. Whipsaws in a
range (the sign flips often, each flip pays fee and slippage on twice the position) and funding paid on the long
side can each erase a small edge. A result that exists only at `window = 168` and not at 84 or 336 is a fitted
number, not a regularity.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.

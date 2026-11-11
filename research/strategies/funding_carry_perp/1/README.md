# funding_carry_perp / 1

**Hypothesis.** Funding is persistent: when longs have been paying a high rate for three days, they keep paying
for a while, and a short position collects it. High funding also marks crowded longs, whose unwinding would push
the price down — in favour of the short.

**Mechanism.** For each perpetual: mean of the last 72 hourly funding rates. The signal is on when that mean is at
least 15 % per year (Hyperliquid's floor, 0.01 % per 8 h, is 10.95 % per year: "large" means above the floor),
at least 75 % of those 72 settlements were positive, and the 72-hour mean is above its own average over the last
504 hours. Size: short `(gross / N) · min(1, z / 2)` of equity, `z` being the standard score of the current 72-hour
mean among the 72-hour means of the last 504 hours. Only settlements at or before the decision bar are used.

**This is a directional short, not a carry trade.** There is no hedge: the position gains the funding and loses
(or gains) the whole price move. Funding of 30 % per year is 0.08 % per day; a 3 % daily rise costs 36 days of
it. High funding occurs in rising markets, so the strategy is short precisely when the market has been going up.
The hedged version is `funding_carry_neutral_perp/1`.

**What would refute it.** A funding PnL that is positive while the total return is negative: the carry was real
and the price move took it back, which is the expected failure. Also: the signal almost never on (funding pinned
at the floor rate most of the time), or funding mean-reverting faster than 72 hours so that the position is opened
when the premium is already gone.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.

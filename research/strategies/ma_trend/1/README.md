# ma_trend / 1

**Hypothesis.** Trends persist: when the average price of the last 3 days is above the average of the last 20 days,
the asset is in an up-trend that is more likely to continue than to stop, and being out of the market otherwise
avoids the large drawdowns of a long-only holder.

**Rule.** For each symbol: weight `1/N` if `mean(close[-72:]) > mean(close[-480:])`, otherwise 0 (USDC).

**What would refute it.** Whipsaws: in a range-bound market the two averages cross often and every crossing costs
fee + slippage on the whole position. The rule is always late (it enters after the rise began and leaves after
the fall began); if trends are short relative to the 20-day window it loses to buy-and-hold.

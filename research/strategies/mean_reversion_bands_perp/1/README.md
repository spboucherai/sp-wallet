# mean_reversion_bands_perp / 1 — z-score bands with a regime filter, generic universe

**Hypothesis.** A close two standard deviations away from its 48-hour mean reverts when the market is ranging, and
does not when it is trending. `zscore_reversion_perp/1` fades every deviation and loses its gains in trends; a
filter that only allows entries in a range should keep the reversion and drop the trend losses.

**Signal.** Per asset: `z = (close - mean of the last `window` closes) / their standard deviation`. Regime: Kaufman's
efficiency ratio over `regime_bars`, `ER = |close[t] - close[t - regime_bars]| / sum of |bar moves|` (1 = a straight
line, 0 = a range); the market is "ranging" while `ER < max_efficiency`. Rule, replayed over the last `state_bars`
bars (the function keeps no memory): flat -> short when `z > entry_z`, long when `z < -entry_z`, **only while
ranging**; back to flat when `z` returns inside `+-exit_z`; stop when `|z| > stop_z`, and no new entry until `z` is
back inside `+-exit_z`. Position `gross / N` per asset.

**Parameters.** `window` 48, `entry_z` 2.0, `exit_z` 0.5, `stop_z` 4.0, `regime_bars` 168, `max_efficiency` 0.2,
`state_bars` 240, `gross` 1.0. Universe `["*"]`, 1 to 12 perpetuals (the run used BTC, ETH, SOL, LINK, AAVE, HYPE,
XRP, DOGE, AVAX, BNB). Version 2 is the same code on exactly BTC, ETH, SOL.

**Costs assumed.** Taker fee, half spread + impact, the latency bound — which is the heavy one here: the strategy
buys after a fall and sells after a rise, exactly when the next bar's adverse excursion is large —, funding, the
engine's minimum trade and caps. A round trip is two fills per asset.

**Failure modes.** The efficiency ratio is a lagging description of the last week, not a forecast: a range ends
with the very breakout the strategy fades. A z-score stop is not a price stop (the standard deviation grows with the
move). Ten assets that fall together are ten long entries at once: the book is then a leveraged long of the market,
and the engine's daily loss limit ends the run. A position opened more than `state_bars` ago is forgotten.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/mean_reversion_bands_perp-1.json`).** Real data, BTC, ETH, SOL, LINK, AAVE, HYPE, XRP, DOGE, AVAX, BNB, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | -3.57 % | -3.39 | -2.84 | -4.17 % | 40 | -29.71 | +0.22 | -1.81 | -0.39 | -3.97 | -35.67 | daily_loss |
| validation | -1.33 % | -0.72 | +0.69 | -4.82 % | 172 | +10.09 | +0.33 | -7.81 | -1.56 | -14.30 | -13.25 | daily_loss |
| test | -2.31 % | -1.72 | -1.18 | -3.81 % | 64 | -16.11 | +0.01 | -2.86 | -0.59 | -3.51 | -23.06 | daily_loss |

Test Sharpe 95 % bootstrap interval [-5.86, 4.01]; deflated Sharpe ratio 0.027 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** no edge: stopped by the engine's daily loss limit in all three splits (ten correlated entries at once). Not a candidate for an agent.

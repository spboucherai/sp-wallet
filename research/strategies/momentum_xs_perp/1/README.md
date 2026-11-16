# momentum_xs_perp / 1 — cross-sectional momentum, generic universe

**Hypothesis.** Among liquid perpetuals, the assets that outperformed the others over the last two weeks keep
outperforming them over the next days (relative strength), whatever the market does. A long/short book of winners
against losers earns that spread without the market's direction.

**Signal.** For each asset: `score = (log close[t - skip] - log close[t - skip - momentum_bars]) / (sigma x
sqrt(momentum_bars))`, the past return in units of its own volatility (`sigma` = standard deviation of the last
`vol_bars` bar returns; the last `skip_bars` are left out, the short-term reversal). Scores are centred across the
universe (`score - mean`): above the mean = long, below = short. Legs are inverse-volatility weighted
(`centred / annualised sigma`), normalised to a sum of absolute weights of 1, then the whole book is scaled to
`target_vol` (book volatility estimated with the assets taken as uncorrelated) and never above `gross`. The signal is
recomputed only on bars whose close is a multiple of `rebalance_bars` since the epoch: between two anchors the
weights do not change, so the book is rebalanced once a day and not every hour.

**Parameters.** `momentum_bars` 336 (14 days), `skip_bars` 24, `vol_bars` 168, `target_vol` 0.30 a year,
`rebalance_bars` 24, `gross` 1.0. `max_leverage` 1, `max_gross_exposure` 1. Universe `["*"]`: 3 to 12 perpetuals
chosen by the caller (the run used BTC, ETH, SOL, LINK, AAVE, HYPE, XRP, DOGE, AVAX, BNB). Version 2 is the same code
on exactly BTC, ETH, SOL (the instruments pinned for live trading).

**Costs assumed.** Taker fee of the venue (Hyperliquid 4.5 bps), half spread + square-root impact (or the recorded
depth curve), the latency bound (60 s after the close, one more minute per further exposure-adding order), hourly
funding on both legs, the engine's minimum trade (2 % of equity) and caps. A daily rebalance of a 10-asset book is
about 2 x gross of turnover per week.

**Failure modes.** A momentum crash: after a sharp market reversal the past losers rebound hardest and the book
loses on both legs. With 3 to 10 highly correlated assets the cross-section is thin: the "spread" is mostly noise
and one asset (HYPE, DOGE) can dominate it. Inverse-volatility legs are not beta-neutral: the book carries residual
market exposure. Funding is paid on the long leg of crowded winners. The engine's daily loss limit (3 %) stops the
agent on one bad day.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/momentum_xs_perp-1.json`).** Real data, BTC, ETH, SOL, LINK, AAVE, HYPE, XRP, DOGE, AVAX, BNB, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | -1.33 % | -0.38 | +0.53 | -6.73 % | 416 | +14.69 | -1.37 | -9.87 | -2.11 | -14.66 | -13.31 | daily_loss |
| validation | -5.30 % | -5.14 | -3.87 | -5.76 % | 147 | -39.62 | +0.45 | -4.69 | -0.97 | -8.17 | -53.01 | daily_loss |
| test | -3.09 % | -2.27 | -0.70 | -6.90 % | 262 | -10.07 | -0.55 | -7.05 | -1.48 | -11.72 | -30.87 | no |

Test Sharpe 95 % bootstrap interval [-7.91, 3.40]; deflated Sharpe ratio 0.018 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** no edge out of sample: negative before costs on the test split, the engine's daily loss limit stopped it in train and in validation. Not a candidate for an agent.

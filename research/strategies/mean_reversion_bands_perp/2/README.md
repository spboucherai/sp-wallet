# mean_reversion_bands_perp / 2 — z-score bands with a regime filter on the live-pinned set

The code of version 1, byte for byte below `META`; only the universe changes: **exactly BTC, ETH, SOL**, the
instruments pinned for live trading, so that this version can be attached to an agent that can go live (audit
defect D1).

**Hypothesis.** As version 1.

**Signal.** As version 1; `gross / 3` per asset.

**Parameters.** As version 1 (`window` 48, `entry_z` 2.0, `exit_z` 0.5, `stop_z` 4.0, `regime_bars` 168,
`max_efficiency` 0.2, `state_bars` 240, `gross` 1.0).

**Costs assumed.** As version 1.

**Failure modes.** As version 1.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/mean_reversion_bands_perp-2.json`).** Real data, BTC, ETH, SOL, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | -3.82 % | -3.14 | -2.88 | -4.11 % | 13 | -34.87 | +0.40 | -1.81 | -0.30 | -1.59 | -38.18 | daily_loss |
| validation | -0.41 % | -0.13 | +1.36 | -6.62 % | 65 | +23.05 | +0.26 | -9.90 | -1.63 | -15.90 | -4.11 | daily_loss |
| test | +0.56 % | +0.35 | +2.21 | -6.56 % | 116 | +54.89 | -0.09 | -17.91 | -2.98 | -28.33 | +5.57 | no |

Test Sharpe 95 % bootstrap interval [-4.09, 4.88]; deflated Sharpe ratio 0.099 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** live-capable but no edge after costs: the test split's gross profit is eaten by fees and the latency bound, train and validation were stopped by the daily loss limit, and the deflated Sharpe ratio is far from 0.95.

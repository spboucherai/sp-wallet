# momentum_xs_perp / 2 — cross-sectional momentum on the live-pinned set

The code of version 1, byte for byte below `META`; only the universe changes: **exactly BTC, ETH, SOL**, the three
instruments of the pinned Hyperliquid asset table (`packages/derivatives/src/live/hl-assets.ts`). A perp agent's
instruments must equal `META["universe"]` exactly, so this version can be attached to an agent that can go live
(audit defect D1: six of the eight V4 perp strategies need HYPE and cannot).

**Hypothesis.** As version 1, on three assets: the strongest of BTC, ETH, SOL over two weeks stays the strongest.

**Signal.** As version 1. With three assets the book is long the strongest, short the weakest, and the middle one
takes what is left of the centring.

**Parameters.** As version 1 (`momentum_bars` 336, `skip_bars` 24, `vol_bars` 168, `target_vol` 0.30,
`rebalance_bars` 24, `gross` 1.0).

**Costs assumed.** As version 1.

**Failure modes.** As version 1, and worse on one point: three assets whose pairwise correlation is above 0.8 give
a cross-section of three numbers. The result is a bet on ETH/BTC and SOL/BTC relative moves, nothing more general.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/momentum_xs_perp-2.json`).** Real data, BTC, ETH, SOL, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | +1.32 % | +0.46 | +1.19 | -6.92 % | 195 | +36.93 | -0.90 | -10.30 | -1.59 | -10.97 | +13.15 | no |
| validation | -4.81 % | -4.31 | -3.12 | -6.54 % | 102 | -34.62 | +1.46 | -7.03 | -1.12 | -6.82 | -48.13 | no |
| test | -0.20 % | -0.16 | +1.15 | -3.66 % | 92 | +10.66 | -2.55 | -4.43 | -0.66 | -5.01 | -1.98 | no |

Test Sharpe 95 % bootstrap interval [-5.61, 5.39]; deflated Sharpe ratio 0.074 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** live-capable (universe = the pinned set) but no edge: positive before costs on the test split, zero after them, negative in validation; the interval of the Sharpe ratio is centred on zero.

# funding_arb_cross_venue / 1 — long the perpetual where funding is lower, short where it is higher

**Why this directory.** `research/strategies/` is the library the wallet API lists and runs. This strategy needs
the same underlying on TWO venues (`BTC` on Hyperliquid, `BTC@EDGEX` on edgeX); the live engine has one venue, and
edgeX trading is not available to the wallet at all (its terms exclude Canada: `docs/v11/work/edgex.md`). It is a
research strategy on public data, kept out of the API's library until a multi-venue engine exists
(`docs/v11/work/quant-lab.md`, TypeScript follow-ups).

**Hypothesis.** The funding rate of the same underlying differs across venues for days at a time (different
traders, different funding formulas and intervals). Long on the venue where longs pay less, short on the venue where
longs pay more: the price exposure cancels, the funding difference is collected.

**Signal.** Per underlying, funding per bar as the data carry it (Hyperliquid settles every hour; edgeX every 4
hours, so three bars out of four are zero and the fourth carries the 4-hour rate). `diff = (mean funding on
edgeX - mean funding on Hyperliquid) over the last `window` bars, annualised`: what the pair long-Hyperliquid /
short-edgeX collects per unit of leg notional. `cost_apr = round_trip_cost_bps / 1e4 x 365 / holding_days`.
Enter long-Hyperliquid / short-edgeX when `diff - cost_apr >= enter_net_apr`, the reverse when
`-diff - cost_apr >= enter_net_apr`; in both cases only if the leg to be SOLD is not unusually cheap against the leg
to be bought (`price spread - its mean over the window >= -max_adverse_spread_bps`). Leave when the collected
difference falls under `exit_apr` (a change of sign included). State replayed over the last `state_bars` bars.
Weights `+-gross / (2N)` per leg: delta-neutral per underlying.

**Parameters.** `window` 168, `enter_net_apr` 0.04, `exit_apr` 0.01, `round_trip_cost_bps` 40 (four taker fills at
about 10 bps each: fee 4.5, spread, latency), `holding_days` 30, `max_adverse_spread_bps` 10, `state_bars` 336,
`gross` 0.9. Universe BTC, ETH, SOL on Hyperliquid and on edgeX.

**Costs assumed.** Taker fee on both venues (4.5 bps each, base tier), half spread from the recorded books (SOL on
edgeX: 2.8 bps, one tick), impact, the latency bound on four fills per round trip, funding at each venue's own
interval. **Capital on both venues**: each account holds half of the equity, with its own margin check and its own
liquidation; nothing is transferred. Margin usage per venue and funding per venue are in the report
(`venue_accounts`).

**Failure modes.** The funding difference is small against costs (a 4 % a year difference is 0.33 % a month, the
round trip is 0.40 %). Basis risk: the two legs are two different order books; the price spread between them moves
by several basis points and its level is not zero (Hyperliquid trades about 8 bps above edgeX on this window).
One-sided margin: a rally drains the short venue's account while the gain sits on the other venue — a liquidation
on one leg leaves a naked position on the other. Funding formulas change. And it cannot be traded by the wallet.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/funding_arb_cross_venue-1.json`).** Real data, BTC, BTC@EDGEX, ETH, ETH@EDGEX, SOL, SOL@EDGEX, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | +0.02 % | +0.07 | +0.80 | -0.47 % | 30 | +2.44 | +1.32 | -1.51 | -0.36 | -1.69 | +0.20 | no |
| validation | -0.51 % | -2.68 | -1.32 | -1.11 % | 24 | -2.44 | +0.61 | -1.24 | -0.30 | -1.72 | -5.09 | no |
| test | -0.21 % | -3.97 | -0.36 | -0.25 % | 18 | -0.17 | +0.12 | -0.95 | -0.28 | -0.85 | -2.14 | no |

Test Sharpe 95 % bootstrap interval [-7.63, -0.45]; deflated Sharpe ratio 0.003 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** no edge: the funding differences between Hyperliquid and edgeX on BTC, ETH, SOL were too small and too short-lived to pay four taker fills; negative out of sample. Research only (not tradable by the wallet).

# basis_cash_carry / 1 — cash-and-carry: spot long, perpetual short

**Hypothesis.** When longs persistently pay funding, holding the asset on the spot market and shorting the same
notional of its perpetual collects that funding with no exposure to the price. It is worth doing only when the
funding expected over the holding time exceeds the round trip of BOTH legs, spot swap included.

**Signal.** Per asset, on the last `window` bars: `carry = mean funding rate per bar x bars per year` (annualised
funding paid by longs). `cost_apr = round_trip_cost_bps / 1e4 x 365 / holding_days` (the round trip amortised over
the planned holding time). Enter when `carry - cost_apr >= enter_net_apr` and the perpetual is not unusually cheap
against spot (`basis - mean basis over the window >= -max_adverse_basis_bps`, basis = perp close / spot close - 1:
a perpetual sold cheap is bought back dearer when the basis closes). Leave when `carry < exit_apr` (the entry
costs are sunk by then). State replayed over the last `state_bars` bars. Weights: `+gross / (2N)` of the spot leg,
`-gross / (2N)` of the perpetual. **The reverse (spot short, perpetual long, when funding is negative) is not
offered: the wallet has no borrow.**

**Parameters.** `window` 168, `enter_net_apr` 0.05, `exit_apr` 0.02, `round_trip_cost_bps` 60 (spot in and out at
10 + 10 bps, perpetual in and out at about 10 bps), `holding_days` 30, `max_adverse_basis_bps` 15, `state_bars`
336, `gross` 0.9. Universe BTC, ETH, SOL and their `.SPOT` legs.

**Costs assumed.** Spot leg: 10 bps fee + 10 bps half spread per swap (the lab's assumption for an on-chain swap;
gas is NOT modelled and is heavy on small orders). Perpetual: taker 4.5 bps + spread/impact + latency bound.
Capital: the spot account and the perpetual account each hold half of the equity and cannot lend to each other —
a rise of the asset drains the short's margin while the spot gain sits in the other account (no transfer is
modelled; in reality it has to be moved, at a cost).

**Failure modes.** Funding mean-reverts faster than 30 days: the entry threshold is paid for a carry that is gone
in a week. Spot candles are Coinbase (USD) and the perpetual is Hyperliquid (USDC collateral, USDT-heavy index): the
"basis" contains a quote-currency spread that is not hedged. A sharp rally liquidates the short leg while the spot
leg cannot be used as margin. On-chain execution of the spot leg differs from Coinbase prices. A position opened
more than `state_bars` ago is re-evaluated as a new entry.

**Not executable by an agent today**: a perp agent holds perpetuals only (`perp-strategies.ts` refuses spot legs),
and no mandate spans a vault and a venue account. Backtest only.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/basis_cash_carry-1.json`).** Real data, BTC, ETH, SOL, BTC.SPOT, ETH.SPOT, SOL.SPOT, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | -0.05 % | -0.67 | +0.49 | -0.14 % | 4 | +0.23 | +0.71 | -0.43 | -0.33 | -0.67 | -0.50 | no |
| validation | -0.16 % | -3.27 | -0.53 | -0.21 % | 10 | -0.13 | +1.00 | -1.07 | -0.81 | -0.58 | -1.59 | no |
| test | -0.10 % | -4.20 | -0.03 | -0.10 % | 4 | -0.00 | +0.02 | -0.44 | -0.33 | -0.21 | -0.96 | no |

Test Sharpe 95 % bootstrap interval [-6.75, 0.70]; deflated Sharpe ratio 0.000 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** no edge on this window: funding (5 to 8 % a year on average) almost never cleared the entry threshold, and the few entries cost more than the funding they collected. Backtest only.

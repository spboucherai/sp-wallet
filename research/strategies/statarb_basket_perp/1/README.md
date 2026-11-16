# statarb_basket_perp / 1 — PCA residual mean reversion over a basket

**Hypothesis.** The returns of liquid perpetuals are driven by a few common factors (the market, an "alt" factor).
What is left of an asset's return once those factors are removed — its residual — is a mean-reverting process:
when the cumulative residual is far from its equilibrium the asset is temporarily rich or cheap against the basket
and comes back (Avellaneda & Lee, 2010). This generalises the hard-coded BTC/ETH pair of `pairs_coint_perp/1`.

**Signal.** On the last `window` bar returns of the basket, **ending at the decision bar** (rolling re-estimation
at every decision; no parameter ever uses a later bar — `tests/test_v11_strategies.py` checks it):
1. standardise the returns, take the `n_factors` first principal components of their correlation matrix;
   eigenportfolio `j` holds `v_ij / sigma_i` of asset `i`; factor returns `F_j = sum_i (v_ij / sigma_i) r_i`;
2. regress each asset on the factor returns: `r_i = a_i + sum_j beta_ij F_j + e_i`; cumulative residual
   `X_i(t) = sum of e_i`;
3. fit `X_i(t+1) = a + b X_i(t) + noise`; keep the asset only if `0 < b < 1` and its half-life
   `-ln 2 / ln b` is at most `max_half_life` bars; `s_i(t) = (X_i(t) - a/(1-b)) / sqrt(var(noise) / (1 - b^2))`;
4. band rule replayed along the s-score path of the CURRENT fit over the last `state_bars` bars: short the residual
   when `s > entry_s`, long when `s < -entry_s`, flat again inside `+-exit_s`, stop beyond `stop_s`;
5. hedge: the raw positions are projected on the space orthogonal to the factor loadings
   (`w = raw - B (B'B)^-1 B' raw`), so the book has no exposure to the estimated factors; then scaled to
   `gross x min(1, 2 x active / N)`.

**Parameters.** `window` 336, `n_factors` 2, `entry_s` 1.5, `exit_s` 0.5, `stop_s` 4.0, `max_half_life` 72,
`state_bars` 96, `gross` 1.0. Universe BTC, ETH, SOL, LINK, AAVE, HYPE on Hyperliquid.

**Costs assumed.** Taker fee 4.5 bps, half spread + impact (wider on LINK, AAVE: about 1.2 to 1.4 bps of half
spread measured), the latency bound on every fill, funding on six legs, the engine's minimum trade and caps. One
entry moves up to six legs (the trade and its hedge): turnover is the strategy's first cost.

**Failure modes.** Two factors on six assets leave four degrees of freedom: the "residual" is largely estimation
noise, and re-estimating every hour makes the hedge weights jitter — each jitter above 2 % of equity is a paid
rebalance. A residual that stops reverting (a re-rating: HYPE) is a trend against the position; the stop is on the
s-score, not on the loss. The factor structure of the estimation window does not have to hold in the next hours.
At hourly bars with taker orders a reversion of a few tens of basis points does not cover six legs of costs.

Parameters were written before any backtest on these data and are not tuned on the test split.

**Result (run 2026-11-15-v11, `research/results/2026-11-15-v11/statarb_basket_perp-1.json`).** Real data, BTC, ETH, SOL, LINK, AAVE, HYPE, 1h bars 2026-05-19 to 2026-11-14; train to 2026-09-03, validation to 2026-10-09, **test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s, size-dependent slippage, taker fees per venue, one account per venue, the live engine's default limits (engine parity).

| Split | Net return | Net Sharpe | Gross Sharpe | Max DD | Fills | Price PnL | Funding | Fees | Slippage | Latency | Net PnL (USD) | Stopped by the engine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| train | -10.17 % | -7.18 | -2.94 | -10.17 % | 384 | -42.48 | +0.29 | -17.99 | -4.35 | -37.19 | -101.71 | total_loss |
| validation | -10.33 % | -10.51 | +0.27 | -10.33 % | 870 | +2.05 | +0.29 | -34.36 | -8.04 | -63.22 | -103.28 | total_loss |
| test | -10.17 % | -11.07 | +0.73 | -10.25 % | 851 | +6.15 | -0.38 | -37.63 | -8.94 | -60.85 | -101.65 | total_loss |

Test Sharpe 95 % bootstrap interval [-18.48, -4.91]; deflated Sharpe ratio 0.000 over the 31 trials of the run (0.95 would be needed). Checks: look-ahead pass, ledger pass, funding alignment pass, data quality pass.

**Verdict.** refuted at this horizon and cost: the gross result is about zero and the turnover (hundreds of fills per split) turns it into the engine's 10 % total-loss stop in train, validation and test. Not a candidate for an agent.

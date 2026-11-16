# market_making_as — Avellaneda–Stoikov quoting with inventory skew: a MODEL STUDY

Not a strategy of the `target_weights` contract and **not executable by the wallet**: the agent path has no resting
orders (it sends IOC orders only), no sub-bar loop and no order-book history. Code: `spq.studies` (`as_quotes`,
`fit_kappa`, `simulate_mm`, `market_making_study`); recorder: `python -m spq data record-books`; result:
`research/results/2026-11-15-v11/market_making_as.json`; tests: `tests/test_v11_tools.py`.

**Hypothesis.** A market maker who quotes around a reservation price shifted AGAINST its inventory (Avellaneda &
Stoikov, "High-frequency trading in a limit order book", 2008) earns the spread with less inventory risk than one
who quotes symmetrically around the mid.

**Signal.** In basis points from the mid, inventory `q` in lots:

```
reservation price   r = mid - q x gamma x sigma^2 x tau
half spread         d = gamma x sigma^2 x tau / 2 + ln(1 + gamma / kappa) / gamma
quotes              bid = r - d, ask = r + d, post-only (never inside the book: clamped to the best bid / ask)
```

`sigma` = standard deviation of mid changes per snapshot interval (EWMA 0.97 of PAST squared changes, in bps),
`tau` = horizon in intervals, `kappa` = decay of the fill intensity with the distance from the mid.

**Parameters.** `gamma` 0.1 per lot and `tau` 12 intervals (one minute at the 5 s cadence), fixed before looking at
any result; lot 1 000 USD, at most 5 lots of inventory. `kappa` is FITTED on the first half of each recording
(log-linear fit of the modelled fill frequency against the distance) and the policy is replayed on the second half.
One configuration: no trial ledger (nothing was selected).

**Costs assumed.** Maker fee of the venue's base tier, no rebate (Hyperliquid 1.5 bps, edgeX 4.0 bps). No latency,
no cancel / replace cost, no queue: see below.

**What is observed and what is modelled.** Observed: the visible book (top 20 levels) of BTC, ETH, SOL on
Hyperliquid and edgeX every ~5 s. **Not observed: trades, queue position, anything between two snapshots.** A fill
is a rule on two consecutive snapshots: `cross` (pessimistic) fills a bid only if the NEXT snapshot's best ask is at
or below it; `touch` (optimistic) fills it if the next snapshot's best bid is at or below it, as if the quote were
first in the queue. The truth is somewhere between; both are reported.

**Result (run 2026-11-15-v11).** Second half of each recording; PnL in USD on 1 000 USD lots, after maker fees.

| Book | Fill rule | Recording (min) | kappa | AS fills | AS PnL | AS mean abs. inventory (lots) | AS markout 12 intervals (bps) | Symmetric baseline fills / PnL / inventory | Maker fee (bps) |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| hyperliquid/BTC | cross | 68 | 0.69 | 30 | -9.49 | 0.07 | -1.04 | 15 / 2.39 / 0.74 | 1.5 |
| hyperliquid/BTC | touch | 68 | 0.70 | 34 | -9.82 | 0.07 | -1.08 | 17 / 2.76 / 1.25 | 1.5 |
| hyperliquid/ETH | cross | 68 | 0.55 | 10 | -2.07 | 0.02 | -2.72 | 5 / 5.45 / 0.47 | 1.5 |
| hyperliquid/ETH | touch | 68 | 0.47 | 12 | -2.18 | 0.02 | -2.07 | 6 / 6.84 / 0.84 | 1.5 |
| hyperliquid/SOL | cross | 68 | 0.51 | 12 | -4.62 | 0.03 | -2.40 | 8 / 1.55 / 1.70 | 1.5 |
| hyperliquid/SOL | touch | 68 | 0.45 | 12 | -4.49 | 0.03 | -2.29 | 8 / 1.73 / 1.70 | 1.5 |
| edgex/BTC | cross | 68 | 0.66 | 30 | -18.57 | 0.09 | -1.32 | 18 / -3.62 / 1.03 | 4.0 |
| edgex/BTC | touch | 68 | 0.66 | 30 | -18.46 | 0.09 | -1.71 | 18 / -3.62 / 1.03 | 4.0 |
| edgex/ETH | cross | 68 | 0.49 | 12 | -7.67 | 0.03 | -0.83 | 7 / -0.68 / 1.24 | 4.0 |
| edgex/ETH | touch | 68 | 0.46 | 12 | -7.62 | 0.03 | -0.44 | 7 / -0.61 / 1.24 | 4.0 |
| edgex/SOL | cross | 68 | 0.58 | 6 | -5.40 | 0.03 | -5.00 | 3 / -4.83 / 1.08 | 4.0 |
| edgex/SOL | touch | 68 | 0.27 | 26 | -9.51 | 0.05 | 1.08 | 15 / -4.92 / 2.02 | 4.0 |

Markout = mid 12 snapshots (about one minute) after a fill against the fill price, signed so that negative is
adverse selection.

**Verdict.** No conclusion about profitability can be drawn and none is claimed. What this one recording shows:
the skew does what the model says for inventory — a mean absolute inventory of 0.02 to 0.09 lot against 0.5 to 2 lots
for the symmetric baseline — and **it pays for it**: about twice as many modelled fills, each adversely selected
(markout between −0.4 and −5 bps one minute later in all cases but one) and each paying the maker fee, so the Avellaneda–Stoikov PnL is
negative in every book under both fill rules and WORSE than the symmetric baseline's. The baseline's small positive
PnL on Hyperliquid is that of a few lots held through one hour, not evidence of anything. 68
minutes of one evening, half of it used to fit `kappa`, is **far too short for any conclusion**: one volatility
regime, a few dozen modelled fills per book.

**Failure modes.** Everything a snapshot study cannot see: queue position (a real quote at the best price fills
only after the orders ahead of it), trades inside the spread, latency of cancel / replace, toxic flow that takes
the quote right before a move (the negative markout is its footprint). `kappa` fitted on half an hour is noise. On
edgeX the maker fee (4.0 bps) is larger than the half spread of BTC (0.07 bps): quoting at the touch cannot pay.

**What it would take to go further.** Recorded trades (WebSocket `trades` channels) to observe fills, a recording
of days not minutes, a queue model validated on them, and — before any execution — resting orders in the agent
path and a mandate that allows them (`docs/TRADING-AGENTS-AUDIT.md` section 2.3).

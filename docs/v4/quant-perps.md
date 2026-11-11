# spq for perpetual futures — model, formulas, simplifications, and how to read a version-2 report

Written 2026-11-10 with the code (`research/`, package `spq`). It extends the spot laboratory of
`docs/v3/ARCHITECTURE.md` to perpetual futures as required by `docs/v4/DERIVATIVES-ARCHITECTURE.md` (module
*sp-quant-engine*: "extended for perps: funding, leverage, liquidation in the backtester"). The lab still only reads
market data, runs strategies and writes reports: nothing here places an order, holds a key or talks to a venue account.

Venue facts quoted below come from `docs/v4/venues/hyperliquid.md` and `docs/v4/venues/contract-differences.md` (checked
2026-11-10 against https://hyperliquid.gitbook.io/hyperliquid-docs: `/trading/funding`, `/trading/margining`,
`/trading/liquidations`, `/trading/fees`, `/trading/robust-price-indices`, `/trading/contract-specifications`) and from the
public endpoint itself. The margin arithmetic is a port of `packages/derivatives/src/margin.ts`.

## 1. What was added, and what was not touched

| | Files |
|---|---|
| Data | `spq/data/hyperliquid.py` (downloader, funding store, alignment check) |
| Margin arithmetic | `spq/margin.py` (port of `margin.ts`, `decimal.Decimal`) |
| Backtester | `spq/perp_engine.py` |
| Metrics, research, report, CLIs | `spq/perp_metrics.py`, `perp_research.py`, `perp_report.py`, `perp_backtest.py`, `perp_pipeline.py` |
| Schemas | `schema/backtest-report-v2.schema.json`, `signal-input-v2.schema.json`, `signal-output-v2.schema.json` |
| Strategies | `strategies/<name>_perp/1/` (eight) |
| Results | `results/2026-11-10-perps/` |

The spot contract, the spot backtester, the version-1 report and its schema are unchanged: the eight (twelve with their
second versions) existing strategy files have the same SHA-256, and the version-1 tests pass as they were. The edits made to
existing modules are listed in section 10.

## 2. Data

`python -m spq.data.hyperliquid --symbols BTC,ETH,SOL,HYPE --interval 1h --out data [--depth]`

Three request types of `POST https://api.hyperliquid.xyz/info`, all public and read-only: `candleSnapshot`, `fundingHistory`,
`meta`. The module refuses to send any other type. A weight budget (default 600 per minute; the venue documents 1200 per IP)
spaces the requests, and HTTP 429 / 5xx are retried with a growing pause.

**How far back the venue serves each series (measured 2026-11-11 04:11–04:17 UTC, `results/2026-11-10-perps/history_depth.json`):**

| Series | BTC | ETH | SOL | HYPE |
|---|---|---|---|---|
| 1h candles | 2026-04-16 (208 days, 5000 bars) | same | same | same |
| 4h candles | 2024-07-30 (833 days, 5000 bars) | same | same | 2024-12-05 (706 days: the listing) |
| 1d candles | 2020-08-19 | 2020-08-19 | 2020-09-14 | 2024-12-05 |
| Funding (hourly settlements) | 2023-05-12 | 2023-05-12 | 2023-05-12 | 2024-12-05 |

`candleSnapshot` only keeps **the most recent 5000 candles of an interval**: one answer returns them all (plus the bar in
progress) and an earlier `startTime` returns nothing older. An hourly backtest on this venue's own candles is therefore
limited to about 208 days, whatever the funding history. `fundingHistory` returns 500 rows per answer, oldest first, back to
the listing. The daily candles of BTC and ETH start in 2020, before the venue existed (not explained by the documentation;
not used here).

Conventions (same as the spot loaders): closed bars only, UTC, bar-open timestamps, oldest first; duplicates raise; gaps are
counted in `Quality` / `FundingQuality` and never filled. Candles are **trade prices of the perpetual** — the API serves
neither historical mark prices nor historical oracle prices, so no `mark` or `index` column is produced from it.

**Funding alignment.** A settlement instant is a few tens of milliseconds after the hour (largest offset measured: 139 ms);
it is attached to its hour (an instant further than 60 s from an hour is counted off-grid and dropped). The `funding` column
of bar *i* is the sum of the rates settled in `(ts[i-1], ts[i]]` — at 1h, the single rate settled at the bar's **open**
`ts[i]`; `premium` is the venue's premium of that settlement. A missing settlement is `NaN`.

Files: `<out>/hyperliquid/<SYM>_<interval>.parquet`, `<out>/hyperliquid/funding/<SYM>.parquet` (`ts`, `time_ms`, `rate`,
`premium`), `<out>/hyperliquid/meta.json` (`max_leverage`, `size_decimals` per symbol). Spot candles for the benchmark and for
spot legs come from the existing `spq.data.fetch` (Coinbase). **PostgreSQL**: the engine's schema has no funding table, so
none is assumed; `spq.data.hyperliquid.FUNDING_LOADER` (or `load_funding(loader=...)`) accepts any callable returning
`time_ms, rate, premium`, which is where a table can be plugged in when one exists.

## 3. Strategy contract, version 2

```python
META = {"name": "ts_momentum_perp", "version": "1", "kind": "perp",
        "universe": ["BTC", "ETH", "SOL", "HYPE"], "interval": "1h", "lookback": 400,
        "max_leverage": 2.0, "max_gross_exposure": 2.0, "params": {"window": 168, "gross": 1.0}}

def target_weights(data, params):
    """data[symbol]: DataFrame of closed bars up to the decision bar (at most `lookback` rows): open, high, low,
    close, volume, and for a perpetual funding, premium (and mark, index when the data have them).
    Return {symbol: weight}: signed fraction of account equity, negative = short."""
```

- `META["kind"]` absent or `"spot"`: the version-1 contract, exactly as before (six keys, weights in [0, 1], sum ≤ 1).
- `"kind": "perp"` adds two mandatory keys. `max_leverage` bounds each weight: a perpetual's weight is in
  `[-max_leverage, +max_leverage]`. `max_gross_exposure` bounds the sum of absolute weights. Both are part of the hashed file.
  A weight beyond a bound is an error (`WeightsError`, signal exit code 6), never scaled down silently.
- A universe symbol ending in `.SPOT` is a **spot leg** of the perpetual of the same name (`BTC.SPOT`): weight in [0, 1],
  bought with the account's USDC, no funding, never liquidated, not counted as margin. It exists for cash-and-carry.
- Identity (SHA-256 of `strategy.py`), static purity check and runtime purity guard are the same code as for spot.
- **Look-ahead.** The strategy receives `df.iloc[i+1-lookback : i+1]` of every frame: every column — funding, premium,
  mark, index — ends at the decision bar *i*. The newest funding value it can see is the rate settled at `ts[i]`, the bar's
  open. The settlement at `ts[i] + 1h` (the instant of the decision) is withheld, and is charged by the engine to the
  position held *before* the fill; the first settlement a new position pays is the one after. This is deliberately
  conservative: the venue publishes a rate at the instant it settles, so a live engine could know it a few milliseconds
  before trading. `tests/test_perp_lookahead.py` checks that the inputs end at the decision bar, that a rule fed one leaked
  row fails the truncation check, that a rule able to read the settlement it will be charged collects almost every payment
  (the leak would be visible) while the honest rule on independent funding collects nothing, and that changing future
  funding, mark or index values does not change past decisions.

`python -m spq.describe --strategy <dir>` and `python -m spq.signal ...` **refuse a perp strategy unless `--contract 2` is
passed** (describe: exit 4; signal: exit 2). A caller written for the spot contract — today's API lists every directory of
`research/strategies` through `spq.describe` — therefore sees a perp strategy as "not loadable: not offered" and can never
receive signed, leveraged weights it would read as spot weights. With `--contract 2`, `describe` adds `"contract"` and
`"kind"`, and `signal` takes `funding` (mandatory, per perpetual), optional `mark` / `index`, and prints
`{"schema_version": 2, "kind": "perp", "strategy_sha256", "as_of", "weights", "max_leverage", "max_gross_exposure"}`.
Any settlement, mark or index value dated after the last bar's open time is refused. Spot outputs are byte-for-byte what
they were. The weights are targets, not orders: sizing, margin, liquidation distance and every limit stay with the engine,
the risk policy engine (`packages/derivatives/src/risk.ts`) and the signer.

## 4. The model

One cross-margin account in USDC. Bar *i* opens at `ts[i]`; the decision bar is *i − 1*.

```
open of bar i    1. funding    every settlement dated in (ts[i-1], ts[i]] is paid on the position held coming in
                 2. gap check  margin equity < maintenance margin at open[i]  ->  liquidated at the open
                 3. fill       the weights decided on the close of bar i-1 are traded at open[i]
inside bar i     4. liquidation on the bar's adverse extremes (low for longs, high for shorts)
close of bar i   5. mark to market -> equity[i];  equity <= 0 -> wiped out
                 6. decision   the strategy sees bars <= i and returns weights for the open of bar i+1
```

### Formulas

| Quantity | Formula | Source | In the model |
|---|---|---|---|
| Target size | `weight × equity at open[i] / open[i]`, truncated to the lot `10^-szDecimals` | lot: `meta.szDecimals` | equity = collateral + unrealised PnL at the open |
| Fill | at `open[i]`; slippage cost `= notional × slippage`; fee `= size × open × (1 ± slippage) × fee rate` | fees: taker 0.045 %, maker 0.015 % at the base tier (`/trading/fees`) | default taker 4.5 bps + 2 bps slippage; `--liquidity maker` is an optimistic what-if |
| Unrealised PnL | long `size × (mark − entry)`, short `size × (entry − mark)` | `margin.ts` `unrealizedPnl` | exact |
| Average entry | `(old size × old entry + size × price) / (old size + size)`, half-even at 18 decimals | `margin.ts` `applyOrderToPosition` | same; the entry is the open (slippage is a separate ledger line) |
| Funding payment | `− signed size × price × rate`: a positive rate is paid by longs, received by shorts | "position_size × oracle_price × funding_rate", paid every hour (`/trading/funding`) | price = `index` column if the data have one, else **the perpetual's open at the settlement hour** (see simplifications) |
| Initial margin | `notional / leverage`, rounded up at 18 decimals | "position_size × mark_price / leverage" (`/trading/margining`); `margin.ts` `initialMargin` | leverage = `min(META max_leverage, venue max leverage of the symbol)`; spot leg: paid in full |
| Maintenance margin | `notional × mmf`, `mmf = 1 / (2 × venue max leverage)` | "half of the initial margin at max leverage" (`/trading/margining`) | BTC 1.25 % (40×), ETH 2 % (25×), SOL 2.5 % (20×), HYPE 5 % (10×), from `meta` |
| Liquidation price, one position | long `(entry × size − C) / (size × (1 − mmf))` rounded up; short `(entry × size + C) / (size × (1 + mmf))` rounded down; `C` = collateral (minus the cost of spot legs) | `margin.ts` `liquidationPriceCross` | used as is when the account holds one perpetual |
| Liquidation, several positions | prices move from the opens towards the adverse extremes by the same fraction `u`; liquidation at the `u` where margin equity = maintenance margin (both linear in `u`) | — (model) | equals the single-position formula when there is one position |

**Order rule at the fill (stated rule).** Parts of orders that reduce a position always execute. The parts that add exposure
need `free collateral = margin equity − initial margin of what remains open − costs of the reducing parts`; a perpetual needs
`notional / leverage + fee + slippage`, a spot leg `notional + fee + slippage`. If the total does not fit, **every adding part
is cut by the same factor** (`orders_cut`); a cut order smaller than the minimum order is refused (`orders_refused`). A full
exit is never blocked by the rebalance threshold or the minimum order. (The TypeScript paper engine rejects an order that does
not fit instead of cutting it and does not credit released margin: a different, stricter rule for a different purpose.)

**Liquidation (stated rule).** After the fill, with every long at the bar's low and every short at its high *taken together*,
if margin equity ≤ maintenance margin the whole account is liquidated: every perpetual position is closed at the level
defined above (never better than the open), pays the taker fee plus a **penalty of 100 bps of the liquidated notional**
(`--liquidation-penalty-bps`), and the fills are flagged `liquidation` in the trade log and listed in `liquidations` of the
report. The run continues with what is left. If equity is ≤ 0 at a close the run is **wiped out**: positions are closed, the
unpaid loss is written to `bad_debt_written_off`, equity is 0 for every remaining bar and nothing trades.

### The ledger

All money is `decimal.Decimal` in a context that raises on any inexact result (`spq.margin.EXACT`); sizes are truncated to
the lot, the average entry is the only rounded money quantity. Prices and rates enter through their shortest decimal
representation. On every run:

```
final equity = initial + Σ realised PnL + Σ funding − Σ fees − Σ slippage + unrealised PnL + debt written off
```

holds to the last digit, checked twice — from the running balance and from the trade and funding logs alone
(`ledger.reconciles`, report check `ledger`). Fees include liquidation penalties (also reported apart).
`tests/test_perp_engine.py` checks the identity on hand-computed examples and on random runs with liquidations and
wipe-outs; `tests/test_margin.py` reproduces the numbers of `packages/derivatives/test/margin.test.ts`, and the engine tests
reproduce those of `paper.test.ts` (liquidation estimate 93.672514619883040936, closed PnL −63, collateral 26.47, funding
−0.11 / +0.044 / +0.1).

### Simplifications (every one of them)

1. **Funding reference price.** Hyperliquid pays on the oracle price; historical oracle prices are not served. The model
   uses the perpetual's open at the settlement hour. The error is of the order of the premium (median |premium| on the test
   data: a few basis points, in `funding.<split>.<SYM>.median_abs_premium`), i.e. a few 1e-4 of a payment.
2. **Mark price.** The venue margins and liquidates on its mark price (a median of the oracle, its own book and CEX perp
   mids). The model uses the candle's trade prices: close for valuation, high/low for liquidation. Trade wicks are larger
   than mark-price moves, so the model liquidates in cases where the venue would not (pessimistic).
3. **Worst case inside a bar.** The lows of the longs and the highs of the shorts are assumed simultaneous, and the path from
   the open to them is a straight line. With one position this is exact for "was the level touched"; with several it
   overstates the stress.
4. **No margin tiers.** One flat maintenance fraction per symbol (the first tier). Hyperliquid lowers the maximum leverage
   above a size (BTC 20× above $150 M); irrelevant at research sizes, wrong for large ones.
5. **No partial liquidation, no backstop, no ADL.** The venue first sends the position to the book (the trader keeps what is
   left after a good fill, and positions above $100 k are liquidated 20 % at a time), then, below 2/3 of the maintenance
   margin, the liquidator vault takes the position and the maintenance margin is not returned. The model closes everything
   at the level with a fixed penalty: between the two outcomes for BTC and ETH (their whole maintenance margin is 125 and
   200 bps), optimistic compared with a backstop on HYPE (500 bps).
6. **Fills.** One fill per decision at the next open, a constant slippage, no order book, no partial fill, no latency, no
   price impact, no funding-time or liquidity effects. Every fill pays the taker fee.
7. **Orders are cut, not rejected** (rule above), and released margin is credited before the adding parts.
8. **Funding timing.** The settlement of the decision instant is withheld from the strategy (section 3). Bars longer than
   one hour charge the hour's settlements at the next bar's open price.
9. **Cross margin only**, one leverage setting per symbol for the whole run, USDC worth exactly 1 USD and earning nothing,
   no deposits or withdrawals.
10. **Spot legs** are filled on another venue's candles with spot costs, from the same USDC pool, with no transfer delay or
    cost between venues; they are excluded from margin equity (conservative) and included in total equity. USD (Coinbase)
    and USDT-indexed (Hyperliquid) prices are compared without conversion: the basis is in the data, unhedged.
11. **Quanto detail.** Hyperliquid's BTC/ETH contracts are USDT-denominated with USDC collateral and no conversion; the
    model treats the price as USDC.
12. **Gaps** are not filled: a decision taken before a gap is filled at the first bar after it; funding of missing bars is
    not charged (and counted in `funding_missing`).

## 5. Metrics and benchmarks

Every version-1 metric keeps its definition (`spq/metrics.py`). Added (`spq/perp_metrics.py`): `realised_pnl`,
`funding_pnl` (negative = paid), `liquidation_penalties` (part of `fees_paid`), `long_exposure`, `short_exposure`,
`gross_leverage_mean/max`, `net_leverage_mean/max/min`, `time_in_market`, `avg_holding_bars/hours`, `liquidations`,
`wiped_out`, `margin_utilisation_mean/max`, `worst_intrabar_drawdown`, `orders_cut`, `orders_refused`,
`funding_payments`, `funding_missing`. `exposure` (v1 key) is the mean gross exposure / equity.

`worst_intrabar_drawdown` = max over bars of `1 − (equity with every long at the bar's low and every short at its high) /
(highest closing equity before that bar)`. It is ≥ `max_drawdown`, which only sees closes.

Benchmarks, on each split:
- `buy_and_hold`: the same assets bought once on the **spot** market and held (Coinbase candles, the spot engine, 10 + 10 bps);
- `perp_long_1x`: the perpetuals bought once at 1×, equal weights, held — price PnL **and funding**, perp costs;
- `perp_long_1x_<SYM>` for each perpetual.

## 6. Research hygiene (unchanged rules, same code)

`PerpExperiment` is `spq.research.Experiment` with the perp backtester: chronological train / validation / test, selection
code only sees train + validation (funding included, since it is a column), the test split is evaluated once through
`final_test()` with `META["params"]` and seals the strategy, every configuration is a trial in the ledger. Parameter
sensitivity (each numeric parameter halved and doubled), walk-forward (4 folds), stationary block bootstrap of the Sharpe
ratio, Monte Carlo on bars and on closing fills, and the Deflated Sharpe Ratio computed with **all** the trials of the run
are the version-1 routines. Stress windows: the strategy during the three largest drawdowns of `perp_long_1x`
(`stress_windows`) and during the week-long windows of the test split with the highest and the lowest average funding
(`funding_stress_windows`: return, drawdown and funding PnL of the strategy, return of the benchmark).

## 7. Reading a version-2 report

`schema/backtest-report-v2.schema.json`; `schema_version` = 2, `kind` = "perp". Everything listed in the README for
version 1 is still there with the same meaning. What is new:

| Key | Meaning |
|---|---|
| `config.taker_fee_bps`, `maker_fee_bps`, `liquidity`, `fee_bps` | fees of the run; `fee_bps` is the one the fills paid |
| `config.leverage`, `max_leverage`, `max_gross_exposure` | account leverage used for the initial margin; the two caps of META |
| `config.venue_max_leverage`, `maintenance_fraction`, `size_decimals`, `liquidation_penalty_bps` | venue parameters per symbol and the penalty assumption |
| `config.funding_reference_price` | which price the funding notional used |
| `metrics.<split>` | v1 keys + the perp metrics of section 5 |
| `benchmarks.buy_and_hold`, `benchmarks.perp_long_1x` | spot held / perpetual held at 1× with funding, on the test split; `robustness.benchmarks_by_split` gives return, Sharpe and drawdown on train and validation |
| `robustness.bootstrap.perp_long_1x_sharpe_ci` | bootstrap interval of the perp benchmark (next to `buy_and_hold_sharpe_ci`) |
| `robustness.funding_stress_windows` | strategy vs `perp_long_1x` in the extreme funding weeks of the test split |
| `ledger.<split>` | the exact ledger as decimal strings: `initial`, `realised_pnl`, `funding`, `fees`, `liquidation_penalties`, `slippage`, `unrealised_pnl`, `bad_debt_written_off`, `final_equity`, `reconciles` |
| `liquidations.<split>` | each account liquidation: time, reason (gap at the open / intrabar), positions closed with their prices, equity before and after |
| `funding.<split>.<SYM>` | funding seen on that split: mean rate per bar and annualised, min, max, share of positive settlements, median \|premium\| |
| `checks.ledger` | `pass` when the identity of section 4 holds exactly for every run of the report (strategy on the three splits, perp benchmarks) |
| `checks.funding_alignment` | `pass` when the `funding` column of every perpetual equals the settlement series re-attached by time (so no bar carries a later settlement) and every settlement instant is on the hour grid |
| `checks.lookahead` | the version-1 truncation test, run with the perp backtester: it now also covers funding / premium / mark / index |
| `checks.data_quality` | candles **and** funding series pass their quality tests |

How to read it: (1) `checks` first — a report with a failed check is not evidence of anything; (2) `metrics.train`,
`validation`, `test` side by side: a result that exists only on the test split is one favourable period; (3) the test
Sharpe ratio with its interval, against the two benchmarks and their intervals; (4) `deflated_sharpe` (below 0.95, "no skill"
is not rejected); (5) `liquidations`, `wiped_out`, `worst_intrabar_drawdown` and `margin_utilisation_max`: how close the
account came to the edge; (6) `funding_pnl` against `fees_paid + slippage_paid`: what the strategy paid to exist.
A report never says a strategy is profitable.

## 8. Strategy library

`ts_momentum_perp`, `ma_trend_perp` (volatility-targeted), `zscore_reversion_perp` (with a stop), `pairs_coint_perp`
(BTC–ETH, hedge ratio on a rolling window ending at the decision bar), `funding_carry_perp` (directional short, sized by a
funding z-score), `funding_carry_neutral_perp` (spot long + perp short), `vol_breakout_perp`, `har_rv_perp` (HAR-RV forecast
for sizing and regime). Each directory has a README: hypothesis, mechanism, what would refute it. Parameters were written
before any backtest on the venue's data.

**Not implemented, on purpose: microstructure / order-book-imbalance strategies.** They need historical order-book (or at
least trade-by-trade) data; the public endpoint serves only the current book, and nothing was recorded. A backtest on
candles would be a fake. They can be evaluated once the market-data service of `services/api/src/derivatives/data.ts` has
recorded books for long enough, in the paper engine rather than in this bar backtester.

## 9. Results

`research/results/2026-11-10-perps/summary.md` (tables and what they say), one JSON report per strategy, `summary.json`,
`trials.jsonl`, `history_depth.json`.

## 10. Changes to the existing lab, and why

| File | Change | Why |
|---|---|---|
| `spq/strategy.py` | `validate_meta` accepts `kind` and, for `kind: perp`, `max_leverage` and `max_gross_exposure`; new `validate_perp_weights`, `Strategy.kind`, `Strategy.validate`, `is_spot_leg` | contract v2. A META without `kind` goes through the same checks as before (the perp keys are refused on it) |
| `spq/engine.py` | `run_backtest` refuses a `kind: perp` strategy | a perp strategy returns negative or > 1 weights; the spot engine must fail loudly, not on a weight error mid-run |
| `spq/research.py` | `Experiment` calls `self._runner` (default `run_backtest`) instead of `run_backtest` | lets `PerpExperiment` reuse the split / sealing / trial-ledger code unchanged |
| `spq/signal.py`, `spq/describe.py` | `--contract` (default 1); perp branch; spot branch untouched | section 3 |
| `spq/backtest.py`, `spq/pipeline.py` | refuse / skip `kind: perp` strategies | the spot CLIs must not try to run the new directories |
| `tests/conftest.py` | `LIBRARY` no longer includes directories named `*_perp` (new `PERP_LIBRARY`) | the version-1 library tests enumerate `strategies/*/*` and assert the exact set of spot strategies; the perp strategies live in the same tree, as specified. No test file was modified |

## 11. Not verified

- Agreement with the venue's own margin and liquidation engine on real positions: no account was used. The model agrees with
  the TypeScript margin engine on its examples, which is itself an estimate (`source: 'estimate'`).
- The funding reference price (oracle) and the mark price: neither series is available historically; the size of the
  resulting error was not measured, only bounded by the premium.
- That funding rows are final (no later correction by the venue), and the cause of pre-listing daily candles.
- Slippage (2 bps) and the liquidation penalty (100 bps): assumptions, not measurements. Order-book depth was not used.
- The cross-margin worst-case path with several positions (simplification 3) against tick data.
- The `--liquidity maker` mode, 4h or daily bars, an `index` / `mark` column from a real source, and the PostgreSQL funding
  hook: covered by unit tests on synthetic inputs only, never run on real data.
- The TypeScript side: no consumer of `--contract 2`, of the version-2 report or of the version-2 signal exists yet; the
  shapes are proposals to be agreed with the API and the agent runtime.

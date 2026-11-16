# V11 — quantitative research lab (Phase H): work note

Branch `v11-quant-lab` (from the local branch `v11` at `ad52bec`). Scope: `research/**` and new documents only; no
file under `services/`, `packages/` or `apps/` was changed. Read-only public market data; no order, no key, no
production node. Reference document: `docs/TRADING-BACKTESTING.md`. Lab tests: **406 collected: 404 passed, 2 skipped (live-network tests, SPQ_NETWORK_TESTS=1)** (335 before this work).

Summary of the outcome, stated first because it is the point of an honest lab: **no V11 strategy shows an edge out
of sample** once the V11 costs and the live engine's default limits are applied; 4 of the seven runs are
stopped by the engine's own loss limits in at least one split. The two versions that can go live today (universe = the
pinned BTC, ETH, SOL) are not exceptions.

---

## 1. Backtester realism

| Item | Initial state (audit, `docs/TRADING-AGENTS-AUDIT.md` section 3) | Change | Tests |
|---|---|---|---|
| (a) latency | none: fill at the next bar's open | `ExecutionModel.latency_s` (default **60 s**, the engine's pass): buy at `open + f (high - open)`, sell at `open - f (open - low)`, `f = min(1, sqrt(delay / bar))`; one more pass per further exposure-adding order; booked as the cost line `latency`. A bound, always against the order. `next_open` keeps the old model | `test_v11_engine.py` latency |
| (b) slippage | constant bps | `half spread + Y sigma sqrt(Q / V)` from bar volume (bars before the fill only), or the recorded depth curve where book snapshots exist (`book_calibration.json`) | square-root, depth profile |
| (c) fees | one taker / maker constant (Hyperliquid) | fee table per venue with source and date (`data/venues.py`): Hyperliquid 4.5 / 1.5, edgeX 4.5 / 4.0, dYdX 5.0 / 1.0, GMX 6.0 (approximation), spot 10 | fees per venue, table |
| (d) funding | hourly, Hyperliquid | per venue at its real interval: Hyperliquid 1 h, edgeX 4 h, dYdX 1 h; GMX stated as an approximation and NOT backtested as a perpetual (no history endpoint) | interval-aware attach / alignment |
| (e) liquidation | perps exact; spot n/a | kept; now per venue account, with a per-venue write-off | per-venue liquidation |
| (f) engine parity | none (defect D6) | ONE file `research/src/spq/params/engine-parity.json` (24 values, each with `path:line`), applied by both engines: perp — `scalePerpWeights`, owner's leverage setting, minimum trade, venue minimum x 1.05, one exposure-adding order per pass, daily / total loss and liquidation stop; spot — exposure cap 50 %, 25 USD per order, 100 USD per day, 12 orders per day, one order per pass, 5 % loss limit | provenance (re-reads the TypeScript lines), scale, sizing, stops, spot |
| (g) metrics | present, not itemised | `metrics.<split>.gross_to_net`: price PnL -> funding -> fees -> slippage -> latency -> net (exact identity), gross / net Sharpe, cost drag | `test_v11_report.py` |
| (h) splits, walk-forward, look-ahead, selection | present for the V4 strategies | same `PerpExperiment` for multi-venue / spot-leg / generic universes; look-ahead check run for every V11 strategy under the V11 execution model; a v3 report cannot be built without a ledger; the run's deflated Sharpe uses all its trials; cost sensitivity on the VALIDATION split only | strategies, ledger |
| (i) data bias | a note in the README | `data_bias` in every report: survivorship (universe fixed ex post), listing-date truncation, missing-bar ratio, stale-price ratio, outage gaps, common-clock drop | `test_v11_data.py` |
| (j) journal, reproducibility | hash of the strategy only; `generated_at` = wall clock | `journal`: strategy hash, code hash (`code_sha256` of the lab's source + parameter files + schema), data snapshot hash, parameters, seed; no wall clock in a v3 report | byte-identical twice (API, CLI and pipeline: 3) |

Schema: `research/schema/backtest-report-v3.schema.json` (additive over version 2). The version-1 and version-2
schemas, writers and committed reports are untouched and still validate (`test_committed_v1_and_v2_reports…`).

Limitations: section 9 of `docs/TRADING-BACKTESTING.md`. The three that matter most: the latency model is a bound,
not a measured distribution (it is the largest cost line of the five momentum / mean-reversion / stat-arb runs below
— see the gross-to-net table — and `robustness.execution_sensitivity` shows each validation result under the pre-V11 model next to it); the
spot engine got engine parity but no latency / impact model; loss limits are checked at bar closes, the live engine
checks every minute.

---

## 2. Multi-venue data layer

- Initial state: one venue (Hyperliquid candles + funding), Coinbase / Kraken spot.
- Change: `data/venues.py`, `data/multivenue.py`, `data/books.py`, `python -m spq data pull | quality | manifest |
  record-books`. Loaders for Hyperliquid, edgeX, dYdX (candles + funding) and GMX (oracle candles; no funding
  history exists on a public endpoint — stated, not invented). Reviewed symbol map for BTC, ETH, SOL. Common clock
  with per-symbol masks; nothing is filled; quote currencies are not converted.
- Every endpoint was called live on 2026-11-15/16 before being written down; edgeX uses exactly the endpoints of
  `docs/v11/research/edgex-api.md` (sections 1.4 to 1.6).
- **Data pulled (real)**: 1 h candles **2026-05-19 to 2026-11-15** (180 days, 4 320 bars) for
  BTC, ETH, SOL on Hyperliquid, edgeX, dYdX and Coinbase, with funding on Hyperliquid (hourly), edgeX (4 h, 1 080
  settlements each) and dYdX (hourly); GMX candles from 2026-05-20 (4 295 bars, what the endpoint served); and
  LINK, AAVE, HYPE, XRP, DOGE, AVAX, BNB on Hyperliquid. Captured 2026-11-16T00:38:24+00:00. No missing bar on any
  series; stale bars 0 to 0.23 % (dYdX SOL). Report: `research/results/2026-11-15-v11/data-quality.md`.
- **Not committed**: the raw files (`research/data`, git-ignored). **Committed**: the manifest
  `research/data-manifests/2026-11-15-v11.json` (38 files with content hash, range, rows, endpoint,
  capture time; snapshot hash `25eb8fa4b9e22c3f…`; 16 order-book recordings with their file hashes).
- **Order books recorded**: 2026-11-16T00:32:07 to 2026-11-16T01:39:44 UTC at a 5 s cadence, top 20 levels — BTC, ETH, SOL on
  Hyperliquid, edgeX and dYdX for 67 minutes (756 snapshots each), seven more Hyperliquid perpetuals for 45 minutes
  (540 each); no failed request. Measured
  median half spreads (bps): Hyperliquid BTC 0.08, ETH 0.28, SOL 0.07; edgeX BTC 0.07,
  ETH 0.17, SOL 2.79; dYdX BTC 1.38, ETH 1.94, SOL 2.78.
  Summary committed as `research/src/spq/params/book_calibration.json`.
- Tests: `tests/test_v11_data.py` (15) on RECORDED responses (`tests/fixtures/v11`, real, trimmed): pagination,
  4 h settlements, contract-name check, capture file, content hash, masks, outage, stale bars, recorder failures.
- Limitations: 180 days (Hyperliquid serves its last 5 000 hourly candles: this snapshot's start falls out of reach
  around 2026-12-13); one recording of the books, one evening; the dYdX fee tier is from documentation, not from an
  endpoint; edgeX public data are readable from Canada but trading there is excluded by its terms.

---

## 3. Strategy families

Common setup: real data above; train 2026-05-19 to 2026-09-03, validation to 2026-10-09,
**test 2026-10-10 to 2026-11-14**; 1 000 USDC; latency bound 60 s; size-dependent slippage (recorded
depth where available); taker fees per venue; one account per venue; engine parity ON. Parameters written in each
`META` before any backtest; the explicit sensitivity grids only add recorded trials; **31 trials** in
`research/results/2026-11-15-v11/trials.jsonl`; the test split was evaluated with the `META` parameters only. Every
report passes its four checks (look-ahead, ledger, funding alignment, data quality).

Disclosure on looks at the test split: the committed ledger starts empty and records ONE test evaluation per
strategy, but during development the whole pipeline was executed three times on these data (a first complete run
when the code was finished, the committed run after the order-book recording ended and the calibration file was
rebuilt, and `verify`), and `momentum_xs_perp/2` once more while the report builder was being written. No strategy
file and no parameter was changed between those runs — the strategy hashes of the first run are the committed
ones — and the figures moved only in the second decimal (the slippage calibration). The results did not need
protecting from selection: nothing was selected.

| Strategy | Universe | Train: net return / Sharpe / stop | Validation: net return / Sharpe / stop | Test: net return / net Sharpe / gross Sharpe / max DD / stop | Test Sharpe 95 % CI | Deflated Sharpe | Verdict |
|---|---|---|---|---|---|---:|---|
| `momentum_xs_perp/1` | BTC, ETH, SOL, LINK, AAVE, HYPE, XRP, DOGE, AVAX, BNB | -1.33 % / -0.38 / daily_loss | -5.30 % / -5.14 / daily_loss | -3.09 % / -2.27 / -0.70 / -6.90 % / no | [-7.91, 3.40] | 0.018 | no edge; stopped by the engine's daily loss limit in train and validation |
| `momentum_xs_perp/2` | BTC, ETH, SOL | +1.32 % / 0.46 / no | -4.81 % / -4.31 / no | -0.20 % / -0.16 / 1.15 / -3.66 % / no | [-5.61, 5.39] | 0.074 | live-capable; no edge (zero after costs out of sample, negative in validation) |
| `mean_reversion_bands_perp/1` | BTC, ETH, SOL, LINK, AAVE, HYPE, XRP, DOGE, AVAX, BNB | -3.57 % / -3.39 / daily_loss | -1.33 % / -0.72 / daily_loss | -2.31 % / -1.72 / -1.18 / -3.81 % / daily_loss | [-5.86, 4.01] | 0.027 | no edge; stopped by the daily loss limit in every split |
| `mean_reversion_bands_perp/2` | BTC, ETH, SOL | -3.82 % / -3.14 / daily_loss | -0.41 % / -0.13 / daily_loss | +0.56 % / 0.35 / 2.21 / -6.56 % / no | [-4.09, 4.88] | 0.099 | live-capable; gross profit out of sample eaten by costs; stopped by the daily loss limit in train and validation; not significant |
| `statarb_basket_perp/1` | BTC, ETH, SOL, LINK, AAVE, HYPE | -10.17 % / -7.18 / total_loss | -10.33 % / -10.51 / total_loss | -10.17 % / -11.07 / 0.73 / -10.25 % / total_loss | [-18.48, -4.91] | 0.000 | refuted at this cost: turnover leads to the 10 % total-loss stop in every split |
| `basis_cash_carry/1` | BTC, ETH, SOL, BTC.SPOT, ETH.SPOT, SOL.SPOT | -0.05 % / -0.67 / no | -0.16 % / -3.27 / no | -0.10 % / -4.20 / -0.03 / -0.10 % / no | [-6.75, 0.70] | 0.000 | no edge on this window: funding rarely cleared the entry threshold; backtest only |
| `funding_arb_cross_venue/1` | BTC, BTC@EDGEX, ETH, ETH@EDGEX, SOL, SOL@EDGEX | +0.02 % / 0.07 / no | -0.51 % / -2.68 / no | -0.21 % / -3.97 / -0.36 / -0.25 % / no | [-7.63, -0.45] | 0.003 | no edge: funding differences too small for four taker fills; research only |

Deflated Sharpe: probability that the true Sharpe ratio is positive given the 31 trials of the run;
0.95 would be needed. Gross Sharpe: costs and funding added back to the same run.

Gross to net on the test split (USD on 1 000 USDC):

| Strategy | Price PnL | Funding | Fees | Slippage | Latency | Net PnL | Fills |
|---|---:|---:|---:|---:|---:|---:|---:|
| `momentum_xs_perp/1` | -10.07 | -0.55 | -7.05 | -1.48 | -11.72 | -30.87 | 262 |
| `momentum_xs_perp/2` | +10.66 | -2.55 | -4.43 | -0.66 | -5.01 | -1.98 | 92 |
| `mean_reversion_bands_perp/1` | -16.11 | +0.01 | -2.86 | -0.59 | -3.51 | -23.06 | 64 |
| `mean_reversion_bands_perp/2` | +54.89 | -0.09 | -17.91 | -2.98 | -28.33 | +5.57 | 116 |
| `statarb_basket_perp/1` | +6.15 | -0.38 | -37.63 | -8.94 | -60.85 | -101.65 | 851 |
| `basis_cash_carry/1` | -0.00 | +0.02 | -0.44 | -0.33 | -0.21 | -0.96 | 4 |
| `funding_arb_cross_venue/1` | -0.17 | +0.12 | -0.95 | -0.28 | -0.85 | -2.14 | 18 |

Where each strategy lives and what it is:

| Family | Where | Kind | Executable by an agent today? |
|---|---|---|---|
| `statarb_basket_perp/1` — PCA residual mean reversion, rolling re-estimation on the window ending at the decision bar, factor-neutral | `research/strategies/` | contract-2 strategy | paper yes (6 instruments); live no (LINK, AAVE, HYPE are not pinned) |
| `funding_arb_cross_venue/1` — long the low-funding venue, short the high one | `research/strategies_xvenue/` | contract-2 strategy on `BTC` + `BTC@EDGEX` | no: one venue in the engine; edgeX excluded |
| `basis_cash_carry/1` — spot long + perp short; the reverse is not offered (no borrow) | `research/strategies/` | contract-2 with `.SPOT` legs | no: perp agents refuse spot legs |
| `market_making_as` — Avellaneda–Stoikov, inventory skew | `research/studies/` + `spq.studies` | MODEL STUDY on recorded books | no: no resting orders in the agent path |
| `momentum_xs_perp/1` (generic), `/2` (BTC, ETH, SOL) | `research/strategies/` | contract-2 | `/2`: yes, paper and live-capable (defect D1); `/1`: needs the generic-universe follow-up |
| `mean_reversion_bands_perp/1` (generic), `/2` (BTC, ETH, SOL) | `research/strategies/` | contract-2 | same |
| `cross_exchange_spread` — estimated net edge between venues | `research/studies/` + `spq.studies` | analysis signal | no |
| `vol_forecast` — HAR-RV / GARCH, QLIKE and MSE | `spq.vol_forecast` + study | research tool | n/a |
| `risk_supervisor` — proposes reductions | `spq.risk_supervisor` | pure policy | n/a (proposes only) |

Studies (JSON in `research/results/2026-11-15-v11/`, READMEs in `research/studies/`): market making — the skew
holds far less inventory than a symmetric quote and pays for it (twice the modelled fills, each adversely selected
and charged the maker fee: its modelled PnL is negative in every book and worse than the baseline's), and 67
minutes of snapshots are far too short for any conclusion; cross-exchange — the difference between venues is a permanent level, deviations
are a few bps against a 24 to 32 bps round trip, and on near-simultaneous recorded quotes the entry edge never
covers the exit; volatility — HAR-RV, GARCH and EWMA beat the random walk on QLIKE everywhere, with no stable
ranking between them.

Tests: `tests/test_v11_strategies.py` (22: contract, purity lint, purity, degenerate inputs, grid inside the caps,
look-ahead under the V11 model, neutrality, parameters from the window only, signal runner incl. a generic perp
universe), `tests/test_v11_tools.py` (9), `tests/test_v11_report.py` (9).

Limitations: one 180-day window and a five-week test split; the generic versions were run on ten liquid survivors
chosen today; `strategies_xvenue` and the `.SPOT` strategy are research-only; the market-making study has no
observed fill; the strategies were not tuned at all — a different parameter set might look better in sample, and
finding it on these data would be exactly the selection the ledger exists to expose.

---

## 4. Clean-up: `rj_*` fixture strategies

- State found: `research/strategies/rj_*` is **git-ignored** (root `.gitignore`: "strategies installed by research
  jobs on the API node") and **not tracked**: the worktree has none. The five directories the audit saw are files of
  the main checkout's working directory, written there by the API when a research job is accepted — in that
  checkout by the fake-agent runs of `services/api/test/research.test.ts`, which deletes the ones it installs
  (line 80) and leaves the others behind when a run is interrupted.
- They are not referenced by any test under `research/` (`tests/conftest.py` skips `rj_`), and the TypeScript
  listers skip them (`perp-strategies.ts:55`, `lab-identity.test.ts:44`).
- Change: none — there is nothing in git to move, and this worktree may not touch the main checkout. To clean the
  main checkout: `rm -r research/strategies/rj_*` there (they are restorable from the database on a deployed node).
  The ledger pollution (defect D10) is `research/results/ledger.jsonl`, also git-ignored and written by the API.

---

## 5. TypeScript-side changes needed (not done here: `services/**`, `packages/**`, `apps/**` are out of scope)

The lab side is ready and tested for each of them.

1. **Accept and produce version-3 perp reports.**
   - `services/api/src/agents/perp-strategies.ts:117-118` — add `'--report-version', '3'` to the `spq.perp_backtest`
     arguments (`--ledger` is already passed; the lab then applies the V11 execution model and engine parity and
     prints `report_sha256`). Optional: `'--as-of', new Date(d.store.now()).toISOString()` (default: the close of the
     last bar).
   - `perp-strategies.ts:75` (`perpReportProblem`) and `:123` — replace `r.schema_version !== 2` by "not 2 and not
     3" (the `checks` keys `lookahead`, `ledger`, `funding_alignment` are unchanged in v3). Recommended for v3: also
     require `engine_parity.applied === true`.
   - `services/api/src/agents/perp-routes.ts:87-95` (`perpReportSummary`) — surface the new sections: add
     `'gross_to_net'` to `SPLIT_KEYS`, and return `executionModel: report.execution_model`, `engineParity:
     report.engine_parity` (incl. `observed.<split>.stop`), `dataBias: report.data_bias`, `journal: report.journal`;
     the perp agent page (`apps/web/src/screens/PerpAgent.tsx`) should show "stopped by the engine's loss limit" next
     to a split's figures — otherwise a flat equity curve reads as "no risk".
   - No sandbox change is needed: the parameter files are inside `research/src/spq/params/`, which the lab profile
     already makes readable (`services/api/src/agents/lab.ts:88`), and the v3 schema is in `research/schema/`.
2. **Spot backtests with engine parity.** `services/api/src/agents/strategies.ts:136` — add `'--engine-parity'` to the
   `spq.backtest` arguments (the report stays version 1; `checks.notes` states the caps applied). Better: pass the
   agent's OWN risk settings instead of the defaults — that needs a small lab option (`--parity-json`), not written.
3. **Generic perp universes** (`momentum_xs_perp/1`, `mean_reversion_bands_perp/1`). `perp-strategies.ts:65-70`
   (`fitsPerpAgent`) — when `info.meta.universe` is `['*']`, accept any instrument set within
   `min_symbols`/`max_symbols` (as `strategies.ts:69-77` does for spot); `--symbols` is already passed to the
   backtest and `spq.signal --contract 2` now takes a generic universe's symbols from the input.
4. **Library tests.** `services/api/test/lab-identity.test.ts` enumerates `research/strategies/`: it now finds five
   more 1 h perp strategies without spot legs (`momentum_xs_perp/1,2`, `mean_reversion_bands_perp/1,2`,
   `statarb_basket_perp/1`; `basis_cash_carry/1` is skipped there as a spot-leg strategy). Their universes are
   within the test's `SYMS` table and they answer `spq.signal --contract 2` on lookback + 5 bars, so the test should
   pass unchanged — **not run here** (it needs PostgreSQL and the workspace's node_modules). The cross-venue
   strategy was kept out of `research/strategies/` precisely because that test would feed it single-venue bars.
5. **Live-pinned assets.** Nothing to change: `/2` versions use exactly `HL_PINNED_ASSETS` (BTC, ETH, SOL). To make
   `statarb_basket_perp/1` live-capable, LINK, AAVE and HYPE would have to be pinned
   (`packages/derivatives/src/live/hl-assets.ts`) — not requested, not recommended on these results.
6. **Not available without new engine work** (audit sections 2.3 and 5.4): a second venue in the agent path and a
   mandate spanning two accounts (`funding_arb_cross_venue`, `cross_exchange_spread`); spot legs in a perp agent and
   a mandate spanning a vault and a venue account (`basis_cash_carry`); resting / post-only orders
   (`market_making_as`); a consumer for `spq.risk_supervisor.propose` (a route that feeds it the agents' positions
   and equity, and a place to show its proposals — it must stay a proposal).
7. **Parity file maintenance.** `research/tests/test_v11_engine.py::test_parity_file_is_the_engine…` fails when a
   default moves in `perp-engine.ts`, `perp-live.ts`, `perp-exec-live.ts`, `routes.ts`, `engine.ts` or `live.ts`
   (it matches `path:line`): the fix is to update `engine-parity.json`, not the test.

---

## 6. What could not be done

- The TypeScript test suites were not run (out of scope and they need PostgreSQL); item 5.4 is therefore a reasoned
  expectation, not a result.
- GMX funding / borrow history: no public REST endpoint; GMX is candles only and is not backtested as a perpetual.
- Trades were not recorded (edgeX has no public REST trade endpoint; WebSocket recording was out of scope): the
  market-making fills are modelled.
- More than one order-book recording, and more history than the venues serve (Hyperliquid: 208 days of 1 h bars).
- A latency model for the spot engine, a per-agent (non-default) parity option, tiered maintenance margins and the
  real leverage / maintenance of edgeX and dYdX.
- `rj_*` directories: not in git; nothing to move from this worktree.

---

## 7. Reproduce

```bash
cd research && uv sync --frozen
uv run pytest                                             # 406 collected: 404 passed, 2 skipped (live-network tests, SPQ_NETWORK_TESTS=1)
uv run python -m spq v11 verify --data-dir data --manifest data-manifests/2026-11-15-v11.json \
    --out results/2026-11-15-v11                          # needs ./data (not in git): re-runs and compares hashes
```

`results/2026-11-15-v11/manifest.json` holds the SHA-256 of the seven reports, `trials.jsonl`, `summary.json` and
`summary.md`. `verify` was run after the last code change: 10 of 10 files identical.

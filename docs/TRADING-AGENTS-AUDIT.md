# SP Wallet V10 — trading agents, strategies, backtesting, market data, research runtime: audit

Audit date: 2026-11-15. Checkout: `projets/sp-wallet`, branch `v11` (= production commit `a118e3e`). Read-only audit: no
source file was changed, no test or build was run, no order or transaction was sent, no production node was touched.
Everything below was read in the code; where a statement comes from a document and not from code, it says so.
Paths are relative to the repository root. `file:line` points at the line that carries the fact.

Scope: `services/api/src/{agents,market,research}`, `services/research-runner`, `research/` (Python lab `spq`),
`packages/core/src/{mandate,research-job,research-sandbox}.ts`, the mandate parts of `services/isolated-signer`,
`services/api/src/main.ts`, the agent screens of `apps/web`.

---

## 0. Executive summary

- There are **two agent engines**, both real and both started by the API process: a **spot vault engine**
  (`agents/engine.ts` + `agents/live.ts`) and a **perp engine** (`agents/perp-engine.ts` + `perp-live.ts` +
  `perp-live-cycle.ts`). Both are deterministic "target-weights on closed bars" rebalancers, one pass per minute,
  independent of any browser tab (`services/api/src/main.ts:26-39`).
- An "agent" is **one row of `agents` + one approved `strategy.py`**. There is no agent type per strategy family, no
  per-agent process, no order types other than a routed spot swap (spot) and an IOC "market" order with a worst price
  (perp). Limit/post-only/maker orders, quoting, multi-venue execution do not exist in the agent path.
- Data are real (public REST of Coinbase / Bitstamp / Kraken for spot; Hyperliquid public endpoints for perps). No fixture
  feeds a production path.
- Live execution exists for both kinds behind signer-enforced mandates: spot through KyberSwap on EVM networks
  (`SPW_BROADCAST`), perps on Hyperliquid (`SPW_DERIV_LIVE_MAINNET` + `SPW_DERIV_MANDATE_MAINNET`, both default off).
  Per the project's own documents nothing was ever run on a funded account (`docs/v7/PERP-AGENT-LIVE.md:95-105`,
  `docs/v6/DERIVATIVE-MANDATE.md:184-196`).
- The lab (`spq`) is a careful bar-level backtester (splits, sealed test split, trial ledger, deflated Sharpe, exact
  perp ledger with funding and liquidation). It has **no latency model, no order book, no maker fills, no multi-venue
  data**. Its own results say no library strategy shows an edge (`research/README.md:234-247`, `:367-373`).
- Of the nine target families, the library covers momentum, mean reversion, pairs (one fixed BTC/ETH pair),
  directional funding carry and a volatility forecast used for sizing. **Market making, cross-exchange, basis trading
  as an executable strategy, funding *arbitrage* (delta-neutral, executable) and a risk-management agent are missing.**
- Most decision-relevant defects: only BTC/ETH/SOL are pinned for live perps while six of eight perp strategies require
  HYPE (they can never go live); a spot mandate is not revoked on the signer when the engine stops an agent; spot
  strategies can be approved with a failed look-ahead check; paper and live rows share tables, and the perp signal log
  has no mode column. See section 8.

---

## 1. Inventory of agent types and engines

| | Spot vault agent — PAPER | Spot vault agent — LIVE | Perp agent — PAPER | Perp agent — LIVE | Research job |
|---|---|---|---|---|---|
| Code | `agents/engine.ts:90-150` (`tickAgent`), `agents/live.ts:136-159` | same + `live.ts:67-118` (`placeLive`, `advanceOrder`) | `agents/perp-engine.ts:305-441` (`tickPerpAgent`), `perp-live.ts:70-87`, `perp-exec.ts` | `perp-live-cycle.ts:311-341` (`tickLivePerpAgent`), `perp-exec-live.ts` | `research/routes.ts`, `research/evaluate.ts`, `services/research-runner/src/*` |
| Really functional? | Yes (code path complete, tests `services/api/test/agent-engine.test.ts`) | Code complete; no evidence in the repository of a funded run | Yes (`test/perp-agent.test.ts`) | Code complete; exercised only against a scripted fake and an unfunded testnet account (`docs/v7/PERP-AGENT-LIVE.md:95-105`) | API side complete; runner deployment is a draft (`services/research-runner/deploy/research-runner.manifest.draft.json`, `docs/v7/RESEARCH-RUNTIME.md:164`) |
| Data source | Real: `candles` table fed by Coinbase/Bitstamp/Kraken REST (`market/sources.ts:73-119`) | same | Real: Hyperliquid candles + hourly funding stored in `perp_candles` / `perp_funding` (`perp-data.ts:175-250`), live ticker/book | same bars (mainnet data) for the signal; book and mark of the account's own network for sizing (`perp-live-cycle.ts:279-286`) | Frozen copy of the same tables, test split withheld (`docs/v7/RESEARCH-RUNTIME.md:118-121`) |
| Produces signals? | Yes: `spq.signal` in an OS-sandboxed Python process per closed bar (`live.ts:27-51`) | same | Yes: `spq.signal --contract 2` (`perp-signal.ts:23-44`) | same | No (produces a `strategy.py` + notes) |
| Can backtest? | Yes, at registration: `strategies.ts:125-148` → `spq.backtest` | — | Yes: `perp-strategies.ts:88-128` → `spq.perp_backtest` | — | Yes: the agent backtests on dev data; the server re-runs on the full set (`evaluate.ts:152-167`) |
| Prepares orders? | Yes: `planOrder` (`engine.ts:52-81`), one swap per call | Yes: `prepareKyberSwap` (`live.ts:72`) | Yes: `planPerpOrders` (`perp-engine.ts:221-244`) | same plan | No |
| Execution engine | Paper book: fill = live KyberSwap quote for the exact size, nothing signed (`engine.ts:129-138`) | KyberSwap router on the vault's EVM network; delegated signature from the isolated signer (`live.ts:76`), broadcast by the API (`live.ts:102`). Lock: `SPW_BROADCAST` (`config.ts:13`, `live.ts:90`); needs an approved mandate | Derivatives paper service against the live Hyperliquid book (`perp-exec.ts:30-41`) | Hyperliquid via `derivatives/mandate.ts` `placeMandateOrder`; signer signs under a derivative mandate. Locks: testnet always; mainnet needs `SPW_DERIV_LIVE_MAINNET=on` **and** `SPW_DERIV_MANDATE_MAINNET=on` (`docs/v6/DERIVATIVE-MANDATE.md:145-146`, `derivatives/exec.ts:60-62`) | None (cannot reach the signer or the API's owner routes) |
| Persistent state | `agents` (state, mode, `last_bar`, `risk`), `agent_paper`, `agent_orders` (mode='PAPER'), `agent_equity` (mode='PAPER'), `research_log`, `strategy_versions` (`db.ts:52-75`) | `agents.mandate`/`mandate_id`, `agent_orders` (mode='LIVE', raw tx, txid), `agent_equity` (mode='LIVE'), `agent_withdrawals`; signer state file holds the mandate and daily usage | `agents.perp` (JSON book), `perp_agent_signals`, `agent_equity`, `deriv_paper_accounts`, `deriv_orders`/`deriv_fills`/`deriv_funding`/`deriv_risk_events`/`deriv_equity` (`db.ts:93-118`, `:160-171`) | `agents.live_account_id`, `agents.perp.live`, `deriv_accounts`, `deriv_mandates`, `deriv_orders` (origin='mandate'), `perp_agent_signals`, `agent_equity` (mode='LIVE') | `research_jobs`, `research_job_log` (`research/store.ts:11-21`), `strategy_versions`, files under `<SPW_DATA_DIR>/research-jobs/<id>/` and `research/strategies/rj_*` |
| Runs without a browser? | Yes: `startAgentEngine` timer, 60 s (`live.ts:156-159`), inside the API process, only when `SPW_WORKERS=on` (`main.ts:26`, `config.ts:14`) | same loop; open orders advanced one step per pass (`live.ts:141`) | Yes: `startPerpAgentEngine`, 60 s (`perp-live.ts:85-87`) | same loop (`perp-live.ts:72-76`) | Yes: the runner is its own process polling `claim` (`services/research-runner/src/runner.ts:55`) |
| Restart recovery | `agents.last_bar` (one decision per bar); paper orders are not idempotent (random UUID, `engine.ts:135`) | Order rows exist before signing (`live.ts:73`); `advanceOrder` resumes from `prepared/signed/broadcast` (`live.ts:84-118`); in-memory backoff map is lost (`live.ts:134`) | Decision row written before any order (`perp-engine.ts:360-371`); deterministic client ids (`:283`) make orders idempotent | same + unconfirmed orders looked up on the venue by client id (`docs/v7/PERP-AGENT-LIVE.md:59`) | `reapLost` fails jobs whose runner is silent for 5 min (`research/routes.ts:60-61`); `rj_*` strategies restored from the DB at start-up (`:67`) |
| Risk mechanisms | Data gate `assertFresh` (`engine.ts:103`, `market/series.ts:49-54`); weight validation (`engine.ts:37-49`); exposure cap, per-order / per-day USD, orders per day, min trade (`engine.ts:60-69`); loss limit → liquidate to cash and stop (`engine.ts:113-115`, `:147`) | all of PAPER + signer: mandate (assets, per-order and per-day input, orders/day, expiry, vault-to-vault only) and price guard (`packages/core/src/mandate.ts:74-108`, `isolated-signer/src/signer.ts:144-185`); signer halt (`engine.ts:94`); gas reserve (`routes.ts:111-118`); pre-broadcast simulation (`live.ts:99-101`) | Gate (`perp-data.ts:83-128`, `:278-288`); META bounds (`perp-engine.ts:152-168`); owner caps scale weights down only (`:175-193`); derivatives risk engine policy (`:85-95`); daily/total loss → flatten + stop (`:257-263`, `:336-344`); simulated liquidation stops the agent (`:322`) | all of PAPER + signer-enforced derivative mandate (section 5), floor guard at 25 % of the loss budget (`perp-exec-live.ts:38`, `:195`), 45 s cool-down between exposure-adding orders (`:36`), exit conditions (`perp-live-cycle.ts:291-306`), wind-down with reduce-only closes (`:343-372`) | OS sandbox, budgets enforced outside the agent, holdout never sent, server recomputation (`docs/v7/RESEARCH-RUNTIME.md:28-45`) |

Notes
- One loop per kind for **all** agents, sequential (`live.ts:139`, `perp-live.ts:73`); a slow agent delays the others
  (a signal process may take up to 60 s: `live.ts:23`, `perp-signal.ts:10`). The loop never overlaps itself
  (`loop-stats.ts:24-28`) and has no cross-process lock: two API processes with `SPW_WORKERS=on` would both trade.
- First pass is one period after start (`loop-stats.ts:29`: `setInterval` only, no immediate tick).
- Heartbeats of both loops feed the monitoring screen and the `system.worker_failing` alert (`loop-stats.ts:5-12`).

---

## 2. Strategy inventory

### 2.1 What a strategy is, how it runs in production

- A strategy version is `research/strategies/<name>/<version>/strategy.py` with a `META` dict and one pure function
  `target_weights(data, params) -> {symbol: weight}`; identity = SHA-256 of the file (`docs/v3/ARCHITECTURE.md:36-53`).
- **Contract 1 (spot)**: weights in [0, 1], sum ≤ 1, long only. **Contract 2 (perp, `META["kind"]="perp"`)**: signed
  weights, each within ±`max_leverage`, Σ|w| ≤ `max_gross_exposure` (`research/src/spq/signal.py` module docstring).
- Invocation: one fresh Python interpreter per call, `python -m spq.signal …`, under `sandbox-exec` with a deny-default
  profile (no network, no fork, read-only lab + that one strategy directory, scratch dir, CPU/file rlimits, RSS watchdog,
  60 s timeout) — `agents/lab.ts:157-181`, `:102-118`. Fail closed: no sandbox → no signal → the engine holds
  (`lab.ts:168`). Escape hatch `SPW_LAB_SANDBOX=off` (`lab.ts:50`, `:161-166`).
- Process model: no long-lived strategy process, no state between calls. A strategy that needs state must replay it
  from the lookback window (as `pairs_coint_perp` does, lines 46-58 of its `strategy.py`).
- Versioning: directory name + file hash; `strategy_versions` has `unique (agent_id, code_sha256)` (`db.ts:61-64`);
  statuses `draft → backtesting → draft(with report) → approved → retired` (`strategies.ts:129-144`,
  `routes.ts:217-218`). Approval is per agent. A live agent runs only the hash pinned in its mandate
  (`engine.ts:100`, `perp-live-cycle.ts:297-298`).
- Parameters come only from `META` (part of the hashed file); the engine cannot override them.
- Determinism: every library strategy is a pure numpy/pandas function of its inputs; `garch_regime` fits a GARCH(1,1)
  with `arch` (numerical optimiser — deterministic for identical inputs and library versions, not verified here across
  machines). The purity guard is a lint, not a boundary (`research/README.md:99`).
- There is **no TypeScript strategy**: `agents/strategies.ts` and `agents/perp-strategies.ts` are the *library /
  registration / backtest-launch* modules (list, describe, pin, backtest), not strategy logic.

### 2.2 Library (files under `research/strategies/`)

| Strategy (versions) | Kind | Universe | Interval / lookback | What it computes | Target family |
|---|---|---|---|---|---|
| `ma_trend` 1, 2, 3 | spot | v1 ETH,BTC,LINK,SOL; v2 ETH,LINK,AAVE; v3 `["*"]` | 1h / 1000 | hold while fast mean (72) > slow mean (480) | momentum (trend) |
| `ts_momentum` 1, 2, 3 | spot | same pattern | 1h / 1500 | hold while own 720-bar return > 0 | momentum |
| `xs_momentum` 1, 3 | spot | v1 fixed; v3 `["*"]`, min 3 symbols | 1h / 1500 | hold the top-2 by past return | momentum (cross-sectional) |
| `donchian_breakout` 1, 2, 3 | spot | same pattern | 1h / 2200 | enter on a 480-bar high, exit on a 240-bar low | momentum (breakout) |
| `vol_target_trend` 1, 2, 3 | spot | same pattern | 1h / 1000 | trend position scaled by realised volatility (target 0.4) | momentum + simple vol scaling |
| `garch_regime` 1 | spot | ETH,BTC,LINK,SOL | 1h / 4320 | daily trend, switched off when a GARCH(1,1) forecast is high | volatility forecasting (as a filter) |
| `mean_reversion` 1, 3 | spot | v1 fixed; v3 `["*"]` | 1h / 200 | buy in proportion to the negative z-score (48 bars) | mean reversion (long only) |
| `pairs_rotation` 1 | spot | ETH,BTC,LINK,SOL | 1h / 1500 | inside fixed pairs (ETH/BTC, SOL/LINK) rotate to the cheap leg when a Dickey-Fuller t passes | pairs, long-only tilt (not an arbitrage) |
| `ts_momentum_perp` 1 | perp | BTC,ETH,SOL,HYPE | 1h / 400 | long/short by the sign of the past return | momentum |
| `ma_trend_perp` 1 | perp | BTC,ETH,SOL,HYPE | 1h / 400 | long/short MA trend with vol targeting | momentum |
| `vol_breakout_perp` 1 | perp | BTC,ETH,SOL,HYPE | 1h / 500 | follow a move large against preceding volatility, fixed holding time | momentum (breakout) |
| `zscore_reversion_perp` 1 | perp | BTC,ETH,SOL,HYPE | 1h / 300 | fade large z-score deviations, with a stop | mean reversion |
| `pairs_coint_perp` 1 | perp | BTC,ETH | 1h / 800 | rolling OLS hedge ratio + DF test on the log spread; long/short the spread between entry/exit/stop z | statistical arbitrage / pairs |
| `funding_carry_perp` 1 | perp | BTC,ETH,SOL,HYPE | 1h / 1100 | short a perp whose funding is persistently positive and high (z of 72-bar mean) — **directional** | funding (carry, not arbitrage) |
| `funding_carry_neutral_perp` 1 | perp + spot legs | BTC,ETH,SOL,HYPE + `X.SPOT` | 1h / 1100 | short perp + long spot of the same asset while funding is high | funding arbitrage / basis (cash-and-carry) — **backtest only** |
| `har_rv_perp` 1 | perp | BTC,ETH,SOL,HYPE | 1h / 1200 | HAR-RV forecast of tomorrow's volatility used to size a trend position | volatility forecasting (as sizing) |
| `rj_0eb9b833115a`, `rj_3df0ffdc907b`, `rj_9382c683fb74`, `rj_a366526bbde7`, `rj_f459616e1640` | spot | BTC,ETH | 1h / 300 | research-job outputs; each docstring reads "Fake research agent: hold an asset while its fast mean is above its slow mean" | artefacts of the fake agent fixture (`services/research-runner/test/fixtures/fake-agent.mjs`), not research |

Constraints that decide what can actually be attached to an agent:
- Spot: a fixed universe must equal the agent's symbols exactly; a `["*"]` version fits any agent within its symbol bounds
  (`strategies.ts:69-77`). The backtest needs one exchange that lists every symbol (`strategies.ts:79-81`, `:131`).
- Perp: **no generic universe**; the agent's instruments must equal `META["universe"]` exactly, and a strategy with
  `.SPOT` legs is refused (`perp-strategies.ts:65-70`). So `funding_carry_neutral_perp` can never be attached to an agent,
  and an agent running any of the six BTC/ETH/SOL/HYPE strategies must trade exactly those four.
- Perp LIVE additionally needs every instrument in the pinned asset table, which holds BTC, ETH, SOL only
  (`packages/derivatives/src/live/hl-assets.ts:19-30`, check at `perp-live-cycle.ts:188`, `:196`). See defect D1.

### 2.3 Mapping to the target families

| Target family | Present? | Where / what is missing |
|---|---|---|
| Statistical arbitrage / pairs | Partial | `pairs_coint_perp/1` (one hard-coded BTC/ETH pair, hourly bars, taker IOC legs sent one after the other — no atomic or simultaneous leg execution, `perp-engine.ts:396-406`). `pairs_rotation/1` is a long-only tilt. No pair selection, no basket/PCA, no multi-pair universe. |
| Funding arbitrage | **Missing as an executable agent** | `funding_carry_perp` is a directional short. The delta-neutral version exists only in the backtester (spot legs unsupported by perp agents: `perp-strategies.ts:66`). No cross-venue funding comparison (one venue: `PERP_VENUE = 'hyperliquid'`, `perp-engine.ts:68`). |
| Market making | **Missing** | No quoting logic, no limit/post-only orders in the agent path (orders are `type: 'market', tif: 'ioc'`, `perp-engine.ts:287`), no order-book history, no inventory model, no sub-bar loop (cadence 60 s on 1h/4h bars). The backtester has a "maker fee what-if" flag only (`perp_engine.py:71`). |
| Momentum | Present | spot ×5 families, perp ×3. |
| Mean reversion | Present | `mean_reversion` (spot), `zscore_reversion_perp`. |
| Cross-exchange | **Missing** | Agents trade one venue. Read adapters for dYdX and GMX exist (`packages/derivatives/src/models.ts:14`, `services/api/src/derivatives/venues.ts:168-169`) and a derivatives router exists (`packages/derivatives/src/router.ts`), but no agent, strategy contract, data store or executor uses a second venue. `perp_candles`/`perp_funding` have a `venue` column (`db.ts:160-166`) that only ever holds `hyperliquid`. |
| Risk management (as an agent) | **Missing** | Risk exists as per-agent rules inside each engine and in the signer (section 1). There is no portfolio-level agent: no aggregate exposure across agents, no correlation/VaR, no agent that can pause or de-risk the others. |
| Basis trading | **Missing as an executable agent** | Only the backtest-only cash-and-carry above; spot candles come from Coinbase (USD) against Hyperliquid (USDT-indexed) with the basis unhedged (`docs/v4/quant-perps.md` simplification 10). No dated futures. |
| Volatility forecasting | Partial | `garch_regime` (filter) and `har_rv_perp` (sizing) use a forecast inside a trend rule. No standalone forecast output, no forecast evaluation (QLIKE/MSE), no options. |

---

## 3. Backtest engine (`research/src/spq`)

| Item | Spot (`engine.py`, report schema v1) | Perp (`perp_engine.py`, report schema v2) |
|---|---|---|
| Data | OHLCV bars of ONE source, never mixed (`strategies.ts:79-81`); via API: CSV exported from `candles` (`strategies.ts:88-98`) | Hyperliquid candles + hourly funding exported from the store (`perp-strategies.ts:96-114`), optional Coinbase spot for the benchmark; the venue serves only its last 5000 candles per interval (`perp-data.ts:26`) → ~208 days at 1h |
| Fill model | next bar's open (`engine.py:159-198`) | next bar's open (`perp_engine.py:319-385`) |
| Fees | `fee_bps` 10 on notional (`engine.py:35`) | taker 4.5 bps, maker 1.5 bps what-if (`perp_engine.py:61-71`); spot legs 10 bps |
| Slippage | constant 10 bps (`engine.py:36`) | constant 2 bps (`perp_engine.py:72`) |
| Funding | n/a | charged on the position held into the bar, hourly settlements, reference = index if present else the perp open (`perp_engine.py:396-413`); missing settlements counted, charged as zero |
| Latency | **none** | **none** (`docs/v4/quant-perps.md` simplification 6) |
| Liquidations | n/a (long only, no leverage) | gap check at the open + intrabar worst case (longs at low, shorts at high), whole-account liquidation with taker fee + 100 bps penalty, wipe-out handling (`perp_engine.py:415-470`); flat maintenance fraction, no tiers, no partial liquidation, no ADL |
| Margin | n/a | initial margin = notional / leverage; orders cut pro rata when collateral is short (`perp_engine.py:344-381`) |
| Exact accounting | floats | `Decimal` ledger that must reconcile to the last digit (`perp_engine.py:512-520`) |
| Out-of-sample | chronological 60/20/20 train/validation/test (`research.py:54-67`); selection code only ever receives train+validation (`research.py:96`, `:104-106`); the test split can be evaluated once per strategy, then the experiment is sealed (`research.py:108-113`) | same (`perp_research.py` reuses `Experiment`) |
| Walk-forward | rolling folds inside the development range (`robustness.py:57-99`) | same |
| Look-ahead protection | strategy sees `df.iloc[i+1-lookback : i+1]` only (`engine.py:205-208`), copy-on-write slices (`engine.py:27-29`), truncation test at two cut points (`robustness.py:224-256`), signal runner refuses anything dated after the last bar | same + funding of the decision instant withheld (`perp_engine.py:6-9`, `:24-25`); report checks `lookahead`, `ledger`, `funding_alignment` |
| Multiple-testing control | persistent trial ledger, deflated Sharpe (Bailey–López de Prado) over all trials (`pipeline.py:165-176`, `dsr.py`), stationary bootstrap CI of the Sharpe (`robustness.py:118-139`), Monte Carlo, stress windows | same |
| Benchmarks | buy-and-hold, equal weight (`engine.py:233-253`) | perp long 1× incl. funding (`perp_engine.py:547-563`), spot buy-and-hold |

Metrics computed (`metrics.py:96-130`, `perp_metrics.py:86-152`):

| Target metric | Spot | Perp |
|---|---|---|
| Sharpe | yes (`metrics.py:114`) | yes |
| Sortino | yes (`:115`) | yes |
| Max drawdown | yes (`:116`), on closes | yes + worst intrabar drawdown (`perp_metrics.py:75-83`) |
| Win rate | yes, on closed lots (`:122`) | yes, on closing fills (`perp_metrics.py:46-53`) |
| Profit factor | yes (`:123`) | yes |
| Turnover | yes + annualised (`:118-119`) | yes |
| Exposure | mean invested fraction (`:126`) | gross / long / short / net leverage, time in market, margin utilisation |
| Net performance | total return, CAGR, final equity after fees and slippage (`:111-112`, `:128`); fees and slippage paid in USD | same + realised PnL, funding PnL, liquidation penalties |
| Others | volatility, Calmar, return distribution | avg holding time, liquidations, orders cut/refused, funding missing |

Schema versions: spot report `schema_version: 1` (`report.py:23`, `research/schema/backtest-report.schema.json:18-20`);
perp report `schema_version: 2`, `kind: "perp"` (`perp_report.py:31`, `research/schema/backtest-report-v2.schema.json:23-25`);
signal input/output v1 and v2 schemas in `research/schema/`.

Missing versus the target list
- **Latency**: no decision-to-fill delay other than "next bar open"; no latency sensitivity.
- **Realistic slippage**: constant bps, independent of size, time, volatility; no spread, depth or impact
  (`research/README.md:258-259`).
- **Order book / maker fills / queue**: none — a market-making or cross-exchange strategy cannot be evaluated.
- **Sub-hour data**: lab intervals are 1h/4h/1d for jobs (`packages/core/src/research-job.ts:42`); 5m candles exist for
  10 base symbols only and no agent uses them (`market/symbols.ts:10`).
- **Multi-venue**: one candle source per run; the perp/spot basis is unhedged and unconverted.
- **On-chain execution costs for spot**: gas, pool fees and DEX price differences are not modelled
  (`research/README.md:260-265`); the spot backtest is on Coinbase prices while execution is KyberSwap.
- **Engine/backtest parity** (verified in code): the backtest fills the full target at one open; the spot engine scales
  total weight to `maxExposurePct` (default 50 %, `routes.ts:35`, `engine.ts:60`), caps each order at `maxOrderUsd`
  (default 25) and each day at `maxDailyUsd` (default 100) (`routes.ts:38-39`, `engine.ts:69`), and in LIVE places one
  order per pass (`engine.ts:122`). The perp engine scales weights by the owner's caps (`perp-engine.ts:175-193`). None of
  this is in the backtest, so a report does not describe what the engine will do with default limits.
- **`decision_every`** is a backtest-only option (`research/README.md:273-274`); the published results used
  `garch_regime=24` / `har_rv_perp=24` (`pipeline.py:5`, `perp_pipeline.py:4`), while the API-launched backtests pass no
  such flag (`strategies.ts:136`, `perp-strategies.ts:117-118`) and the engines decide on every bar.
- **Not implemented** per the lab's own list: ML models, regime-switching models, microstructure/order-book/on-chain
  signals, portfolio optimisation, stop-loss execution logic, intrabar fills, optimisers beyond a grid, CPCV / PBO
  (`research/README.md:275-279`).
- Results directory: `research/results/2026-11-10/` (spot) and `2026-11-10-perps/` hold real-data reports;
  `research/results/ledger.jsonl` (the cross-run ledger the API appends to, `strategies.ts:112`) contains 41 lines, all
  for a strategy named `zz_forktest` — test artefacts, not library trials.

---

## 4. Market data

### 4.1 Spot (module `services/api/src/market`)

- Sources: public keyless REST of Coinbase, Bitstamp, Kraken (`sources.ts:73-119`); pairs from a static reviewed table
  (`sources.ts:70`). Kraken serves only its last 720 bars (`sources.ts:106`).
- Symbols: base set of 10 (`types.ts:7`) + registry-derived symbols + every symbol of a non-stopped spot agent first;
  cap `SPW_MARKET_MAX_SYMBOLS` default **40**, agents' symbols never dropped (`symbols.ts:26-35`, `:38-42`).
- Intervals: 1h (730 days), 1d (all), 5m (30 days, base set only) (`pipeline.ts:24-28`, `types.ts:10`).
- Storage: `candles(source, symbol, interval, ts, o,h,l,c,v)` double precision, PK `(source,symbol,interval,ts)`
  (`db.ts:77-81`); `market_quality` cached verdict per (symbol, interval) (`db.ts:82-85`). Idempotent upserts
  (`store.ts:7-18`).
- Worker: one loop every 60 s — incremental update, quality recompute, bounded backfill (80 requests per source, 30 s)
  (`worker.ts:11-27`); a rate-limited source is skipped for the pass and penalised 30 s (`pipeline.ts:68`).
- Validation: finite, on grid, closed (10 s settle), positive prices, OHLC consistency, duplicates rejected entirely
  (`validate.ts:8-33`, `types.ts:26-27`).
- Consolidation: whole bar of the highest-priority source that has it (coinbase > bitstamp > kraken), never blended,
  never interpolated (`quality.ts:13-17`).
- Freshness/quality gate `assertFresh` (fail closed, computed from stored bars, not from the cached row): latest bar at
  most 1 bar behind; 200-bar window without a hole; last 3 bars present on ≥ 2 sources and confirmed within 50 bps
  (`quality.ts:50`, `series.ts:41-54`). Called before every spot decision (`engine.ts:103`).
- Gaps: counted and reported, never filled; a gap inside the 200-bar window blocks decisions (`quality.ts:98`). The spot
  signal input keeps only timestamps common to all symbols (`live.ts:32-33`) and the runner refuses series with real gaps.
  Coinbase omits intervals without a trade (`sources.ts:5`), so a thin symbol can hold an agent indefinitely.
- **WebSocket: none** for spot data. REST polling once a minute.

### 4.2 Perps (`agents/perp-data.ts`, `derivatives/data.ts`)

- Source: Hyperliquid public info endpoints through the read-only adapter; weight budget 500/min of the venue's 1200
  (`perp-data.ts:155`, `:159-169`).
- Storage: `perp_candles` and `perp_funding` in exact numerics (`db.ts:160-166`). Intervals 1h and 4h (`perp-data.ts:21`).
  Sync only fetches the missing tail (`perp-data.ts:188-215`); a closed bar the venue later revises is replaced and the
  pass holds (`:214`).
- Gate (fail closed): lookback complete, no gap, sane OHLC, funding settlement present for the decision bar, ≤ 0.5 %
  settlements missing and never two in a row, nothing dated after the bar, ticker ≤ 15 s old, mark within 100 bps of the
  venue index (or 300 bps of spot data), last close within 1000 bps of the mark (`perp-data.ts:32-43`, `:83-128`).
- Symbols: any active cross-margin Hyperliquid perp with an upper-case ticker, ≤ 8 per agent
  (`perp-routes.ts:24-30`, `:59-66`). No global cap other than the weight budget.
- **WebSocket: yes, for Hyperliquid only**, in the derivatives data service: one shared connection, 15 s heartbeat,
  reconnect with exponential backoff 1–30 s and jitter, re-subscribe, explicit `gap` event and de-duplication
  (`packages/derivatives/src/venues/hyperliquid/stream.ts:2-9`, `:31-38`, `:92-128`; hubs in
  `services/api/src/derivatives/data.ts:268-344`). The agent engines do not subscribe themselves; they call
  `data.ticker` / `data.book` with a maximum age (`perp-live.ts:53`, `perp-data.ts:284`).
- No historical order-book, trade-tick, open-interest or multi-venue funding store.

---

## 5. Mandates as they exist

### 5.1 Spot vault mandate (`SPW-MANDATE-v1`, `packages/core/src/mandate.ts:14-36`)

Fields: `mandateId`, `keyId`, `vaultIndex` (≥ 1), `vault` address, `network` (one), `provider` (`kyberswap` only), `assets`
(2–12 registry ids), `maxOrder` and `maxDaily` per asset in base units, `maxOrdersPerDay` (≤ 500), `maxSlippageBps`
(10–500), `createdAt`, `expiresAt` (≤ 90 days), `strategySha256`, `label`.

- Built by the API from the agent's risk settings at current prices (`agents/routes.ts:84-97`).
- Approval: `POST /agents/:id/mandate/prepare` returns a WebAuthn request whose challenge **is** the mandate hash
  (`routes.ts:236-240`); `POST …/mandate/approve` forwards the assertion; only the signer judges it and stores the limits
  (`routes.ts:250`, `isolated-signer/src/signer.ts:115-134`).
- Enforcement in the signer on every order, no passkey (`signer.ts:144-185`, `mandate.ts:74-108`): not halted/revoked/
  expired; vault key only; network; swap through the mandated provider; **source and recipient = the vault itself**;
  both assets in the mandate; order validity ≤ 300 s; per-order and per-day input caps; orders per day; fee ceiling of
  the signer's policy; calldata rebuilt and verified (`buildEvmSwapTxs`); the signer's own price check (guaranteed output
  worth ≥ 1 − maxSlippageBps of the input at Coinbase+Kraken prices); replay protection; usage counted before the
  signature is released.
- Funds leave a vault only towards the owner's address (`signer.ts:187-209`). Revocation needs no passkey and is final
  (`signer.ts:137-141`).

### 5.2 Derivative mandate (`SPW-VENUE-MANDATE-v1`, `packages/derivatives/src/live/mandate.ts`, `docs/v6/DERIVATIVE-MANDATE.md:14-35`)

Fields: `mandateId`, `authorizationId` (the MANUAL_LIVE venue authorization it extends), `keyId`, `venue` (hyperliquid),
`network`, `account`, `agentAddress`, `strategySha256` and `agentId` (audit only), `instruments[]` (1–8, each with
`maxLeverage`, `maxPositionNotional`), `maxOrderNotional`, `maxGrossExposure`, `maxOrdersPerDay` (≤ 500),
`maxOrdersPerHour` (≤ 60), `maxDailyTurnover`, `floorEquity`, `maxPriceDeviationBps`, `createdAt`, `expiresAt` (≤ 30
days and ≤ the authorization's), `ackSha256`.

- Derived by the server from the agent's risk settings and the venue's account value, clamped to the authorization
  (`perp-live-cycle.ts:116-146`): nothing is chosen freely by the caller.
- Approval: `…/perp/live/prepare` → review sheet + WebAuthn; `…/perp/live/approve` with `acknowledged: true` → the
  signer verifies the passkey (`perp-live-cycle.ts:233-275`).
- Signer enforcement (`isolated-signer/src/venue-mandate.ts:150-275`, table at `docs/v6/DERIVATIVE-MANDATE.md:43-48`):
  instrument, order notional, price band against the signer's own prices, client id never signed twice, one order per
  action, venue expiry ≤ 120 s, orders per day and per hour, daily turnover, the signer's **own read of the venue
  account** (fresh, consistent), account value ≥ floor, leverage setting ≤ mandate, worst-case position and gross
  exposure. Cancels and reduce-only orders stay possible under a halt, below the floor and during a 24 h wind-down.

### 5.3 What an agent can and cannot do

- Can: propose swaps inside one vault between mandated assets (spot); place IOC orders, cancels and leverage changes on
  the mandated instruments (perp). Inside the mandate it can still trade badly (`docs/v3/ARCHITECTURE.md:32-34`).
- Cannot: sign with the owner's key; move funds anywhere but back to the owner; exceed a limit; trade another asset,
  network, router or venue account.
- **Can an agent alter its mandate? No.** The strategy process is sandboxed without network. The engine has no code path
  that writes a mandate to the signer except the two approve routes, which need a passkey assertion over the hash the
  signer recomputes. The API can only *prepare* a mandate (`routes.ts:237`) or *revoke* one. Spot risk settings cannot be
  edited after creation (no route); perp risk settings can be edited by the owner session without a passkey only while
  the agent is not on a venue account (`perp-routes.ts:189-199`, refusal at `:192`). A compromised API can therefore
  not widen a mandate, but see D2 (several mandates active on one vault).

### 5.4 Gaps versus the target "Trading Mandate"

| Target field | Spot mandate | Derivative mandate | Gap |
|---|---|---|---|
| Allowed wallets | one vault (`vaultIndex`, `vault`) | one venue account (`account`, `agentAddress`) | no multi-wallet mandate; no single object spanning a vault **and** a venue account (needed for basis / funding arbitrage / cross-exchange) |
| Venues | `provider: 'kyberswap'`, one EVM network | `venue: 'hyperliquid'`, one network | one venue per mandate, enum of one value each; no dYdX/GMX/CEX |
| Instruments | `assets` (2–12) | `instruments` (1–8) | present |
| Max capital | **absent** (bounded only by what the owner sends to the vault; `agents.capital_usdc` is an engine reference) | implicit: `maxGrossExposure`, and the account's balance | no explicit signed "max capital" field |
| Max order size | `maxOrder` per asset (base units, fixed at approval prices) | `maxOrderNotional` | present; spot caps drift in USD terms as prices move |
| Max leverage | n/a | per instrument | present for perps |
| Max loss | **absent in the signer** (engine-side `maxLossPct` only, `engine.ts:113`) | `floorEquity` (signer-enforced on the venue's number) + engine daily/total limits | spot has no signer-enforced loss limit; no daily-loss field in either mandate |
| Validity window | `createdAt`/`expiresAt` ≤ 90 d | ≤ 30 d | present; no "not before", no trading-hours window |
| Allowed order types | implicit (a routed swap) | implicit (one order per action; the engine only sends IOC) | no explicit field; limit / post-only / trigger / TWAP are not expressible as permissions |
| Frequency limits | `maxOrdersPerDay` | per day, per hour, daily turnover | spot has no per-hour or per-minute limit |
| Stop conditions | expiry, revocation, signer halt | expiry, revocation, halt, floor, venue unreadable, 24 h wind-down | no declarative stop conditions in the mandate (drawdown from peak, consecutive losses, data-quality failure, max open time); exit conditions live in engine code (`perp-live-cycle.ts:291-306`) |
| Mode (research/paper/live) | not a field | `network` testnet/mainnet | no mode field |

There is no unified `TradingMandate` type; the two schemas, hashes, signer endpoints and DB locations
(`agents.mandate` JSON vs `deriv_mandates` table) are separate.

---

## 6. Modes: Research / Paper / Live

What exists
- `agents.state` ∈ CREATED, RESEARCHING, BACKTESTING, AWAITING_APPROVAL, PAPER_TRADING, LIVE, PAUSED, STOPPING, STOPPED,
  FAILED and `agents.mode` ∈ RESEARCH (column default, `db.ts:53`), PAPER, LIVE. The pair is not a clean state machine:
  the spot route writes `mode` only when going to PAPER or LIVE (`routes.ts:202`, `:251`), the states RESEARCHING and
  BACKTESTING are never set by any code read here, and "RESEARCH" as a requested mode simply sets `state = 'RESEARCH'`
  (`routes.ts:197-202`), a value outside the documented list.
- Research is a separate subsystem (jobs, runner, sandbox) with its own states (`packages/core/src/research-job.ts:9-20`);
  it is not a mode of an agent.
- Paper and Live use the **same engine functions** with a different executor (spot: `mode` argument, `engine.ts:93`;
  perp: `PerpExecutor` interface, `perp-engine.ts:117-123`). This is a good reuse point.

Where simulated and real are mixed (verified)
- `agent_orders` holds PAPER and LIVE rows, distinguished by a `mode` column (`db.ts:65-69`); the agent page lists them in
  one list with a tag per row (`apps/web/src/screens/Agents.tsx:314`).
- `agent_equity` holds both with `mode` in the primary key (`db.ts:71-72`); the API returns the last 500 points of
  **both modes together** (`routes.ts:182`, `perp-routes.ts:116`); the spot page filters client-side by the current
  state (`Agents.tsx:193`), so a stopped ex-live agent shows its paper curve.
- `perp_agent_signals` has **no mode column** (`db.ts:168-171`): decisions taken in simulation and on the venue account
  sit in one log, and the 60 rows returned by `perpDetail` (`perp-routes.ts:115`) are not separable.
- `research_log` (holds, stops, risk messages) is shared by both modes without a mode field (`db.ts:74-75`).
- A perp agent keeps ONE paper account for its whole life; after a live period it resumes the same simulated account
  (`perp-routes.ts:149`), so the paper equity curve has a silent hole.
- Not mixed: the spot page shows the paper book in a separate, clearly marked card and hides it in LIVE
  (`apps/web/src/screens/AgentPaper.tsx:20`, `agents/paper-view.ts:1-4`); the perp page shows either the venue panel or
  the paper account, never both (`apps/web/src/screens/PerpAgent.tsx:166-167`); live perp equity, positions and fills
  are read from the venue (`perp-routes.ts:123-125`).
- No view or table adds a simulated amount to a real balance. No aggregated "performance" view exists at all (no
  per-agent PnL table, no cross-agent summary), so there is nothing that separates or merges track records by mode.

---

## 7. HTTP routes (agents, strategies, research, market)

Auth: every `/api/` route except seven auth/health paths needs the owner session; every non-GET needs
`Origin = config.origin` and `x-spw-csrf: 1` (`services/api/src/server.ts:38`, `:104-121`). The runner routes are the
exception: bearer secret only.

| Method | Path | Auth | What it does | Called by the web app? |
|---|---|---|---|---|
| GET | `/api/v1/agents/networks` (`agents/routes.ts:122`) | owner | networks, cash legs, symbols, data quality, gas reserve | yes (`Agents.tsx:48`, `:177`) |
| GET | `/api/v1/agents` (`:139`) | owner | list (spot and perp views) | yes |
| POST | `/api/v1/agents` (`:141`) | owner | create a spot agent (vault index + address from the signer) or, with `kind:'perp'`, a perp agent with its paper account | yes (`Agents.tsx:66`, `PerpAgent.tsx:49`) |
| GET | `/api/v1/agents/:id` (`:174`) | owner | detail: vault, mandate status, paper book, versions, 60 orders, 500 equity points, 40 log lines (perp: `perpDetail`) | yes |
| POST | `/api/v1/agents/:id/mode` (`:195`) | owner | PAPER / PAUSED / STOPPED / RESEARCH | yes |
| POST | `/api/v1/agents/:id/strategies` (`agents/strategies.ts:159`) | owner | pin a library version (or a job's `rj_*`) and start its backtest | yes |
| POST | `/api/v1/agents/:id/strategies/:sid/approve` (`routes.ts:208`) | owner | approve a version (needs a report) | yes |
| POST | `/api/v1/agents/:id/mandate/prepare` (`:226`) | owner | build the spot mandate + WebAuthn request | yes |
| POST | `/api/v1/agents/:id/mandate/approve` (`:245`) | owner + passkey (judged by the signer) | store the mandate in the signer, state LIVE | yes |
| POST | `/api/v1/agents/:id/revoke` (`:256`) | owner | revoke the spot mandate, state STOPPED | yes |
| GET | `/api/v1/agents/:id/elsewhere` (`:265`) | owner | what the vault address holds on other EVM networks | yes (`AgentFund.tsx:267`) |
| POST | `/api/v1/agents/:id/withdraw` (`:282`) | owner | tracked withdrawal vault → owner | yes (`withdrawTrack.tsx:40`) |
| GET | `/api/v1/agents/:id/withdrawals` (`:287`) | owner | list withdrawals | **no** |
| GET | `/api/v1/agents/:id/withdrawals/:wid` (`:291`) | owner | one withdrawal | yes (`withdrawTrack.tsx:33`) |
| GET | `/api/v1/strategies[?kind=perp]` (`strategies.ts:152`) | owner | spot or perp library | yes |
| GET | `/api/v1/agents/perp/venues` (`perp-routes.ts:177`) | owner | venue, instruments, defaults, live availability | yes |
| POST | `/api/v1/agents/:id/perp/risk` (`:189`) | owner | replace perp limits (+ lift halt) | **no** (only in the mock, `apps/web/src/derivatives/mockPerpLive.ts:269`) |
| POST | `/api/v1/agents/:id/perp/flatten` (`:202`) | owner | close all paper positions | yes |
| GET | `/api/v1/agents/:id/perp/live` (`:214`) | owner | live readiness checklist + proposed mandate | yes |
| POST | `/api/v1/agents/:id/perp/live/prepare` (`:218`) | owner | review sheet + WebAuthn request | yes |
| POST | `/api/v1/agents/:id/perp/live/approve` (`:219`) | owner + passkey | approve the derivative mandate, go LIVE | yes |
| POST | `/api/v1/agents/:id/perp/live/pause` · `resume` · `stop` (`:220-226`) | owner | pause / resume / revoke + wind down | yes (`PerpAgentLive.tsx:303`, `:423`) |
| GET | `/api/v1/market-data/status` (`market/routes.ts:16`) | owner | symbols, coverage, quality records | **no** |
| GET | `/api/v1/market-data/candles` (`:33`) | owner | consolidated candles | **no** |
| GET | `/api/v1/market/:symbol` (`server.ts:196`) | owner | CoinGecko price chart for the wallet's asset page (not the agents' data) | yes (`Asset.tsx:21`) |
| GET | `/api/v1/research/status` (`research/routes.ts:73`) | owner | runner configured / last contact | yes |
| POST | `/api/v1/research/jobs` (`:78`) | owner | create a job, freeze its data set | yes |
| GET | `/api/v1/research/jobs` (`:103`), `/jobs/:id` (`:112`) | owner | list / detail (claims next to server measurements) | yes |
| POST | `/api/v1/research/jobs/:id/cancel` (`:127`) | owner | cancel | yes |
| GET | `/api/v1/research/jobs/:id/log` (`:141`), `/log/stream` (`:148`, SSE) | owner | job log | yes (`Research.tsx:94`, `:97`) |
| POST | `/api/v1/research/runner/claim` (`:184`) | runner secret | claim the oldest queued job with ready data | runner only |
| POST | `/api/v1/research/runner/jobs/:id/log` (`:199`), `/result` (`:209`) | runner secret + job token | append log lines / push the submission | runner only |

- Frontend calls without a backend route: none found in the agent, strategy, research and market calls.
- Routes that do not exist and that the upgrade needs: no route to list an agent's signal history beyond the 60 rows
  embedded in the detail, no order-history or fills pagination, no performance endpoint, no journal endpoint, no
  per-agent start/stop of a worker, no route that places or prepares an order (by design: `perp-routes.ts:210-211`),
  no spot risk edit, no backtest-on-demand route (a backtest only runs as a side effect of registration), no
  API-key / machine authentication (owner cookie session only) — a programmable trading API has no auth primitive to
  build on other than the runner-secret pattern (`research/routes.ts:34-42`).

---

## 8. Defects, risks and unverified claims (severity-ranked; each verified in code unless marked)

**High**

- **D1 — Six of the eight library perp strategies can never go LIVE.** The pinned live asset table holds BTC, ETH and SOL
  only (`packages/derivatives/src/live/hl-assets.ts:19-30`); readiness refuses any agent with an unpinned instrument
  (`perp-live-cycle.ts:188`, `:196`); a perp strategy must match the agent's instruments exactly
  (`perp-strategies.ts:68`); `ts_momentum_perp`, `ma_trend_perp`, `vol_breakout_perp`, `zscore_reversion_perp`,
  `funding_carry_perp`, `har_rv_perp` all declare `["BTC","ETH","SOL","HYPE"]`. Only `pairs_coint_perp` (BTC, ETH) is
  live-capable. A seventh, `funding_carry_neutral_perp`, cannot even be attached (`perp-strategies.ts:66`).
- **D2 — A spot mandate stays active on the signer after the engine stops the agent, and several mandates can be active
  on one vault.** The engine's `stop()` (loss limit, hash mismatch) and the expiry branch only update the `agents` row
  (`engine.ts:152-156`, `live.ts:142-144`); only `POST …/revoke` calls the signer (`routes.ts:258`). `POST …/mode` with
  PAUSED or STOPPED on a LIVE agent also leaves the mandate active (`routes.ts:195-205`), and PAPER is then allowed
  because the state is no longer LIVE (`routes.ts:200`). `mandate/prepare` is allowed whenever the state is not LIVE
  (`routes.ts:229`) and the signer's `approveMandate` does not check for another unrevoked mandate on the same vault
  (`isolated-signer/src/signer.ts:115-134`; the derivative mandate does check this, `docs/v6/DERIVATIVE-MANDATE.md:34`).
  Consequence: after a loss-limit stop the signer would still sign orders for that vault for up to 90 days if asked by
  the API, and daily caps add up across mandates. The API does not ask (the engine only ticks PAPER_TRADING/LIVE), so
  this needs a compromised or buggy API to matter — which is exactly the case the signer exists for.
- **D3 — Spot has no signer-enforced loss limit.** `maxLossPct` is checked by the engine only, once a minute, on candle
  closes (`engine.ts:111-115`); the mandate has no equity floor (`packages/core/src/mandate.ts:14-36`). Documented as a
  limit (`docs/v3/ARCHITECTURE.md:32-34`), still a gap against the target mandate.

**Medium**

- **D4 — A spot strategy can be approved with a failed look-ahead or data-quality check.** Approval of a spot version
  only requires that a report exists (`routes.ts:213`); the perp path requires `lookahead`, `ledger` and
  `funding_alignment` to be `pass` (`perp-strategies.ts:78`, `perp-routes.ts:155-159`).
- **D5 — Paper and live decisions share `perp_agent_signals` with no mode column** (`db.ts:168-171`), and
  `agent_orders` / `agent_equity` / `research_log` mix modes in one table (section 6). Any performance computation built
  on these tables must filter by mode, and for perp signals it cannot.
- **D6 — Backtest and engines do not apply the same rules** (section 3, "Engine/backtest parity"): exposure cap 50 % by
  default, per-order and per-day USD caps, one live order per minute, `decision_every` — the report shown at approval is
  not a simulation of the agent with its limits. Spot paper additionally ignores gas (fills are the KyberSwap quote,
  `engine.ts:131-137`) and values equity at candle closes while filling at DEX quotes.
- **D7 — One sequential loop for all agents of a kind, in the API process, with no cross-process lock**
  (`live.ts:139`, `perp-live.ts:73`, `loop-stats.ts:24-30`). Each signal can take up to 60 s; N agents share one
  60 s pass. Two API instances with workers on would double paper orders for spot (`engine.ts:135` uses a random id) —
  perp orders are protected by deterministic client ids. Backoff maps are in memory (`live.ts:134`,
  `perp-live.ts:68`).
- **D8 — Spot agents keep no signal history.** Weights returned by the strategy are not stored anywhere
  (`engine.ts:118`); only orders, equity points and "hold" log lines are. Perp agents do store them
  (`perp-engine.ts:367-369`).
- **D9 — The spot LIVE agent cannot be paused and resumed.** PAUSED on a live agent is a one-way exit that needs a new
  mandate to come back (`routes.ts:195-205`, `:229`); the web page offers pause only in paper (`Agents.tsx:326`).
- **D10 — The cross-run trial ledger is polluted or empty of real work**: `research/results/ledger.jsonl` contains only
  `zz_forktest` records (41 lines), and five `rj_*` directories from the fake-agent fixture sit in
  `research/strategies/`. The deflated Sharpe of API-launched backtests counts those lines as trials
  (`strategies.ts:134-139`).

**Low**

- **D11 — State vocabulary drift**: `mode: 'RESEARCH'` sets `state = 'RESEARCH'` (`routes.ts:201`), a state not in the
  documented list; RESEARCHING/BACKTESTING are referenced (`routes.ts:219`) but never written.
- **D12 — Stale statements**: `main.ts:38` says perp agents are "paper only"; `perp-exec.ts:5` says the live executor is
  "not in this delivery"; `research/README.md:387` says contract 2 "has no consumer yet on the TypeScript side". All
  three are contradicted by `perp-live-cycle.ts` / `perp-signal.ts`.
- **D13 — Spot mandate caps are fixed in base units at approval-time prices** (`routes.ts:90-93`): the USD value of
  `maxOrder`/`maxDaily` drifts with the market for up to 90 days.
- **D14 — Routes with no UI**: `perp/risk`, `agents/:id/withdrawals`, `market-data/status`, `market-data/candles`
  (section 7). The perp limits can therefore not be changed from the app.
- **D15 — Thin symbols**: Coinbase omits empty intervals, the gate treats them as gaps (`quality.ts:98`), so an agent on
  a thin symbol holds without a remedy other than waiting 200 bars.

**Unverified claims (stated by the documents, not reproducible from the code alone)**

- U1 — Any live fill on a funded account, spot or perp; leverage read/set, partial IOC fills, the 45 s cool-down against
  the real signer ledger, several instruments at once (`docs/v7/PERP-AGENT-LIVE.md:95-105`,
  `docs/v6/DERIVATIVE-MANDATE.md:184-196`). Mainnet: "nothing was ever sent to it".
- U2 — That the research runner runs in production: its manifest is a draft and the only job outputs in the checkout come
  from the fake agent (D10). The real Claude Code path is described as exercised by a script with a mock model
  (`docs/v7/RESEARCH-RUNTIME.md:177`).
- U3 — The sandbox denials (tested on macOS 27.0 per the document; `sandbox-exec` is deprecated by Apple,
  `docs/v7/RESEARCH-RUNTIME.md:98`). Not re-run here (tests were not to be run).
- U4 — Which agents exist and in which state on the production database; whether `SPW_WORKERS`, `SPW_BROADCAST`,
  `SPW_DERIV_*` are set there. Production was not inspected.
- U5 — The published backtest tables (`research/README.md:224-234`, `:354-365`) were not recomputed. They are the lab's
  own evidence that **no library strategy has a demonstrated edge** (deflated Sharpe ≤ 0.16 spot, ≤ 0.06 perp; test
  splits of 4.8 months and 42 days).
- U6 — Engine and reconciliation worker running concurrently for hours, and venue rate limits under real use
  (`docs/v7/PERP-AGENT-LIVE.md:104`).

---

## 9. What must be built

### 9.1 Persistent agent workers independent of the web UI

Already true: agents run without a browser. What is missing is isolation, cadence and records.
- A worker per agent (or a scheduler with per-agent concurrency and deadlines) instead of one sequential pass —
  extend `engineLoop` (`loop-stats.ts:24`) and the two pass functions (`enginePass` `live.ts:136`, `perpEnginePass`
  `perp-live.ts:70`); add a DB lease (advisory lock per agent) so that only one process ticks an agent.
- Sub-bar cadence for families that need it (market making, cross-exchange, funding arbitrage): the engines are
  "one decision per closed 1h/4h bar" by construction (`engine.ts:106`, `perp-engine.ts:358-375`). A second engine
  type driven by the existing Hyperliquid stream (`derivatives/data.ts:268`) is needed; do not bend the bar engine.
- **Journal**: reuse `research_log` (`db.ts:74`) — add `mode`, a severity and a structured `code`; it is already written
  by both engines (`engine.ts:34`, `perp-engine.ts:267`) and tailed by the alert dispatcher.
- **Signal history**: generalise `perp_agent_signals` (`db.ts:168`) into one `agent_signals` table for both kinds —
  add `mode`, `kind`, input-data fingerprint; write it from `tickAgent` at `engine.ts:118` as `tickPerpAgent` does at
  `perp-engine.ts:367`.
- **Order history**: spot `agent_orders` (`db.ts:65`), perp `deriv_orders` / `deriv_fills` (`db.ts:97-108`) with
  `origin` and `agent` columns. Add a read model (view or route) with pagination per agent and per mode rather than a
  third table.
- **Performance**: `agent_equity` (`db.ts:71`) is the only series; add realised/unrealised PnL, fees, funding and
  drawdown per agent **per mode**, computed with the lab's definitions (`metrics.py:96`, `perp_metrics.py:86`) so that
  live, paper and backtest figures are comparable. Never aggregate across modes.
- Routes: signals, orders, fills, journal, performance per agent and mode; spot risk edit; backtest on demand;
  UI for `perp/risk` (D14).

### 9.2 The seven agents

| Agent | Reuse | Must be built |
|---|---|---|
| Momentum | `ts_momentum*`, `ma_trend*`, `donchian_breakout`, `vol_breakout_perp`; both engines as they are | generic-universe perp versions (`["*"]` support in `fitsPerpAgent`, `perp-strategies.ts:65`); fix D1 (pin more instruments or drop HYPE); backtest/engine parity (D6) |
| Mean reversion | `mean_reversion`, `zscore_reversion_perp` | same as above; cost-aware thresholds (the spot version loses to costs alone, `research/README.md:247`) |
| Statistical arbitrage | `pairs_coint_perp` (`_spread`, state replay) | pair/basket selection on dev data, multi-pair universe, paired-leg execution in `tickPerpAgent` (`perp-engine.ts:396-406` sends legs sequentially with a 45 s live cool-down between exposure-adding orders, `perp-exec-live.ts:36`) — leg risk must be handled |
| Funding arbitrage | `funding_carry_neutral_perp` logic, `perp_funding` store, `carry_strength` | an executor that holds a spot leg and a perp leg (today refused: `perp-strategies.ts:66`); a mandate spanning a vault and a venue account (section 5.4); funding data of a second venue for cross-venue funding |
| Market making | Hyperliquid stream (`stream.ts`), `PerpExecutor` interface shape, derivative mandate counters | everything else: quote engine, limit / post-only orders and cancel/replace through `placeMandateOrder`/`cancelMandateOrder` (`docs/v6/DERIVATIVE-MANDATE.md:150-153`), inventory and skew limits, order-book recorder and a fill simulator for backtests, mandate frequency limits sized for quoting (today ≤ 60 exposure-adding orders/hour, `VENUE_MANDATE_BOUNDS`) |
| Cross-exchange | read adapters and facts for dYdX/GMX (`services/api/src/derivatives/venues.ts:165-169`), `router.ts`, `venue` column of `perp_candles`/`perp_funding` | multi-venue data store and gate, a strategy contract with venue-qualified symbols, a second live executor and mandate type, transfer/collateral latency model |
| Risk management | per-agent rules already in `planOrder`, `scalePerpWeights`, `lossBreach`, `exitCondition`, `flattenPerp`; signer halt; `deriv_risk_events`; alert dispatcher | a portfolio-level supervisor: aggregate exposure and loss across agents and modes, kill switch that pauses agents and revokes mandates (calls `pauseLive`/`beginExit`, and for spot the missing revoke-on-stop of D2), declarative stop conditions stored in the mandate |

Also needed for all seven: a volatility-forecast and a basis signal as *shared inputs* rather than standalone agents
(the brief lists them as families; the library has them only inside trend rules).

### 9.3 Three modes

- Make `mode` an explicit, validated enum `RESEARCH | PAPER | LIVE` and `state` a real state machine (as
  `RESEARCH_TRANSITIONS` does for jobs, `packages/core/src/research-job.ts:14-21`); remove the drift of D11.
- Carry `mode` on every record: signals, journal, orders, equity, performance (D5). Give LIVE and PAPER separate equity
  and performance series; start a new paper account (or mark a segment) when an agent returns from LIVE.
- Keep the executor seam as the only difference between PAPER and LIVE: spot `EngineDeps.holdings/quote/placeLive`
  (`engine.ts:11-28`), perp `PerpExecutor` (`perp-engine.ts:117-123`). RESEARCH = the lab on frozen data, with the same
  sizing rules as the engine (close D6 by moving `planOrder` / `scalePerpWeights` semantics into the backtest
  configuration, or by replaying the TypeScript planner over backtest decisions).

### 9.4 Reuse points — extend, do not duplicate

- Engines: `tickAgent` (`agents/engine.ts:90`), `planOrder` (`:52`), `checkWeights` (`:37`); `tickPerpAgent`
  (`agents/perp-engine.ts:305`), `checkPerpWeights` (`:152`), `scalePerpWeights` (`:175`), `planPerpOrders` (`:221`),
  `lossBreach` (`:257`), `flattenPerp` (`:293`), `orderClientId` (`:283`).
- Executors: `PaperPerpExecutor` (`agents/perp-exec.ts:16`), `LivePerpExecutor` (`agents/perp-exec-live.ts:60`),
  `placeLive` / `advanceOrder` (`agents/live.ts:67`, `:84`); `placeMandateOrder`, `cancelMandateOrder`,
  `setMandateLeverage`, `mandateAccountState` (`services/api/src/derivatives/mandate.ts`).
- Life cycle: `deriveMandate` (`perp-live-cycle.ts:116`), `liveReadiness` (`:165`), `prepareLive`/`approveLive`
  (`:237`, `:254`), `exitCondition` (`:291`), `beginExit` (`:343`), `windDownStep` (`:372`), `pauseLive`/`resumeLive`
  (`:421`, `:429`).
- Data: `assertFresh` / `getSeries` (`market/series.ts:49`, `:24`), `PerpDataStore.gate/sync/backfill`
  (`perp-data.ts:278`, `:175`, `:291`), `DerivData.subscribe` (`derivatives/data.ts:268`), the Hyperliquid stream.
- Lab bridge: `labExec` (`agents/lab.ts:157`), `runSignal` (`live.ts:27`), `runPerpSignal` (`perp-signal.ts:23`),
  `describe`/`backtest` (`strategies.ts:35`, `:125`), `describePerp`/`perpBacktest` (`perp-strategies.ts:38`, `:88`),
  `stageLedger` (`strategies.ts:113`).
- Lab: `run_backtest` (`engine.py:92`), `run_perp_backtest` (`perp_engine.py:167`), `Experiment`/`Splits`
  (`research.py:84`, `:45`), `compute_metrics`, `compute_perp_metrics`, `lookahead_check` (`robustness.py:224`),
  report builders and the two JSON schemas.
- Mandates: `MandateSchema` / `checkMandateOrder` / `checkOrderPrice` (`packages/core/src/mandate.ts:14`, `:74`, `:99`),
  the venue mandate schema and bounds (`packages/derivatives/src/live/mandate.ts:20-65`), signer `approveMandate` /
  `signDelegated` (`isolated-signer/src/signer.ts:115`, `:144`) and `venueMandateSign`
  (`isolated-signer/src/venue-mandate.ts:150`). A unified Trading Mandate should wrap these two, not replace them.
- Tables: `agents`, `strategy_versions`, `agent_orders`, `agent_equity`, `agent_paper`, `research_log`,
  `perp_agent_signals`, `perp_candles`, `perp_funding`, `candles`, `market_quality`, `deriv_orders`, `deriv_fills`,
  `deriv_funding`, `deriv_risk_events`, `deriv_mandates`, `research_jobs`, `research_job_log`.
- Machine authentication for a programmable API: the only non-cookie precedent is the runner gate
  (`research/routes.ts:34-42`, constant-time secret comparison, POST only, path-scoped in `server.ts:115`).

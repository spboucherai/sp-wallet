# SP Wallet V11.1 — trading agent engine

Branch `v11-agents`. This document describes the agent runtime as it is in the code: what an agent is, the three modes,
the workers, the order path, the stream engine, the seven built-in agents, what can go live and why the rest cannot, and
how to deploy the workers. It extends — it does not replace — the two engines audited in
`docs/TRADING-AGENTS-AUDIT.md` (the "V11 status" table at the end of that file says what became of each defect).

Nothing described here was run against a funded account or a real venue order. Live paths are exercised against the
existing fake venue / real signer-process harnesses only.

Code map

| Area | Files |
|---|---|
| Model, templates, manifest | `services/api/src/agent-runtime/model.ts` |
| Journal, signals | `agent-runtime/journal.ts` (tables `research_log`, `agent_signals`) |
| Performance (pure) | `agent-runtime/performance.ts` |
| Read model, configuration versions | `agent-runtime/store.ts` |
| Leases, job queue, scheduler | `agent-runtime/leases.ts`, `queue.ts`, `scheduler.ts` |
| Order gateway | `agent-runtime/gateway.ts`; seams `agents/perp-gateway.ts`, `agents/spot-seam.ts` |
| Kill switch | `agent-runtime/kill-switch.ts` (port), `kill-switch-admin.ts` (owner release) |
| Stream engine and its rules | `agent-runtime/stream-engine.ts`, `families.ts` |
| Risk supervisor | `agent-runtime/risk-supervisor.ts` |
| Life cycle | `agents/lifecycle.ts` |
| Templates, creation | `agents/templates.ts` |
| Mandate-writing module | `agents/mandate-write.ts` |
| Composition root | `agents/runtime-bindings.ts`; entry points `main.ts`, `agent-worker-main.ts` |
| Routes | owner: `agents/runtime-routes.ts`; trading API: `agents/trading-handlers.ts` + `trading-api/spec.ts` |
| Web | `apps/web/src/screens/agentPanel.tsx`, `Agents.tsx` |

---

## 1. Agent model

Every agent is one row of `agents` plus what hangs from it.

| Property | Where |
|---|---|
| unique id | `agents.id` |
| family | `agents.family`: `momentum`, `mean_reversion`, `stat_arb`, `funding_arb`, `market_making`, `cross_exchange`, `risk_manager`, `custom` (agents that existed before V11 get theirs from their strategy's name; `custom` otherwise) |
| engine | `agents.engine`: `bar` (the two existing engines), `stream`, `supervisor` |
| strategy, hash-pinned | bar: `strategy_versions.code_sha256` (SHA-256 of `strategy.py`); stream / supervisor: a TypeScript rule pinned by name and version (`RULES`, `ruleHash`) |
| configuration, versioned | `agent_config_versions (agent_id, version, config, config_sha256, actor, reason)`; `agents.config_version` is the running one. A change (creation, strategy approval, limits, rule configuration) creates a version; the running version is written on every signal, order and journal line |
| persistent state | bar: `agents.last_bar`, `agents.perp`, the paper book / paper account / venue account; stream and supervisor: `agents.runtime` |
| activity journal | `research_log` (+ `mode`, `severity`, `code`, `config_version`, `ref`) |
| signal history | `agent_signals` |
| order history | `agent_order_intents` (the gateway's ledger, unified states) + the orders that predate it (`agent_orders`, `deriv_orders`), read together per mode |
| computed performance | `agent-runtime/performance.ts`, never stored |
| risk limits | `agents.risk` |
| authorization policy | a REFERENCE to the mandate in force at the signer (`mandateRef`): spot `agents.mandate_id`, perp `agents.perp.live.mandateId`. The mandate itself lives at the signer |
| state | `active` \| `paused` \| `stopped` — a projection (`lifecycleOf`) of the historical `agents.state` values, which are unchanged: PAPER_TRADING, LIVE, STOPPING, RUNNING → active; PAUSED → paused; everything else → stopped |

Migration: one additive block in `db.ts`. No column is dropped or retyped. `perp_agent_signals` is copied into
`agent_signals` and kept (no longer written). Tested on a database in the pre-V11 shape (the SCHEMA of the production
commit `a118e3e`) holding "Test" (spot, Base, paper then live) and "Eth test" (paper): `agent-migration.test.ts`.

Rollback note: a pre-V11 binary started on a migrated database works (the columns it does not know have defaults, the old
signal table is still there) but writes perp signals to the OLD table; the next forward migration copies them. Perp
orders are protected by their deterministic client ids in both directions.

## 2. Three modes

| Mode | What it is | Orders |
|---|---|---|
| `research` | analysis and backtests. A stream agent in research computes and STORES its decisions | never: the order gateway refuses any order of an agent in research (`READ_ONLY_MODE`) |
| `paper` | explicit simulation: the perp paper account against the live book (fees, funding, liquidation), the spot paper book at live KyberSwap quotes, the stream agents' simulated book (maker/taker fees, funding at real intervals) | simulated, through the gateway |
| `live` | a real venue or on-chain account | only under an active mandate the owner approved with the passkey |

Structural separation

- Every table that paper and live share carries the mode: `agent_orders.mode`, `agent_equity.mode` (already there),
  `research_log.mode` and `agent_signals.mode` (new, backfilled from the audit chain by `spw_agent_mode_at`),
  `agent_order_intents.mode`. Perp orders, fills and funding are separated by ACCOUNT: the paper account or the venue
  account, never both in one query (`perpAccount(a, mode)`).
- A database trigger gives a journal line written without a mode the agent's current one: no line is mode-less.
- Every read function of `store.ts` takes ONE mode. The owner routes and the trading API take `mode` (default: the
  agent's current mode) and say it in the answer. There is no "all modes" value (400).
- `agent-runtime-unit.test.ts` reads the SQL of the read-model files and fails on any `select … from` one of the shared
  tables without a mode filter; `agent-migration.test.ts` and `agent-trading-api.test.ts` assert the answers.
- Backtests are reports (`strategy_versions.report`, `agents.runtime.backtest`), always labelled `backtest`, and are
  never part of a performance answer.

The same strategy interface (`target_weights` for bar agents, the rule functions for stream agents) and the same order
interface (`AgentOrderGateway`) serve the three modes; the executor behind the gateway decides.

## 3. Signals, journal, performance

**Signals** — `agent_signals`, one row per agent, MODE and bar (or decision instant for the stream engine): mode,
configuration version, strategy hash, SHA-256 digest of the inputs, output, status, and the decision: `acted`, or
`skipped` with a reason code (`at_target`, `no_valid_signal`, `data_not_fresh`, `data_gap`, `risk_limit`, `kill_switch`,
`orders_refused`, `orders_deferred`, `no_quote`, `inventory_limit`, `edge_below_threshold`, `research_mode`, …). The
row is written BEFORE anything is done with the signal; a restart reads it back instead of asking the strategy again
(spot agents now do this too — audit D8).

**Journal** — `research_log` with a kind (`decision`, `order`, `fill`, `error`, `risk`, `mandate`, `state`, `proposal`,
`hold`, `stop`, …), a severity, a structured code, the configuration version and a reference (signal, order, job). The
order gateway journals every order, fill, refusal and unknown outcome; the life cycle journals every state change; the
scheduler journals time-outs and dead letters. The alert dispatcher tails this table as before.

**Performance** — `computePerformance` (pure): equity curve, returns, volatility, Sharpe, Sortino, maximum drawdown, win
rate, profit factor, turnover, fees, funding, slippage, net PnL, with the laboratory's definitions (risk-free rate 0,
`ddof = 1`, annualisation from the median spacing of the equity points). Hand-computed cases in
`agent-runtime-unit.test.ts`.

- A figure that cannot be computed is `null` WITH its reason, never a zero.
- Warnings: fewer than 30 equity points (`small_sample`), fewer than 20 closed trades (`few_trades`), uneven spacing
  (`irregular_sampling`).
- Known gaps, stated in the answer: spot network fees are not in the figures; perp fills carry no reference price
  (slippage is `null`); the stream agents' simulated book keeps positions at average cost (no per-trade win rate).

## 4. Persistent workers

Agents never depended on a browser. V11 adds isolation, a cross-process guarantee and durable tasks.

**Leases** (`agent_leases`): one row per agent with owner, heartbeat, expiry and a fencing token. Acquisition is one SQL
statement (insert, or take over an expired row), so two racers cannot both win. The holder renews while its tick runs; a
holder that died stops renewing and the lease expires (default 180 s; stream agents 30 s, renewed every pass). A holder
that slept past its expiry cannot renew or release the lease another worker took. Time is the database's clock.
Chosen over session advisory locks because the API uses a connection pool (a session lock belongs to a connection, not
to a task) and because a row is visible (`GET /api/v1/agents/runtime/status`).

**Job queue** (`agent_jobs`): kinds `tick`, `backtest`, `wind_down` (also `supervise`, `stream` reserved). A partial
unique index makes "one pending job per dedupe key" a database constraint. Claiming uses `for update skip locked`. A
failed job returns to the queue with a backoff (tick: 2, 5, 10, 15 min; it is a ROW, so it survives a restart — the old
in-memory backoff map did not); at the attempt limit it is dead-lettered (`state = 'dead'`): journaled on the agent
(`job_dead_letter`, severity error → alert) and counted by the status route. A job whose worker died is reaped when its
lock expires.

**Scheduler** (`createAgentRuntime`): every pass enqueues one `tick` per runnable agent, then runs the due jobs
concurrently (default 4), each under its agent's lease and with a deadline (150 s). A slow or failing agent delays
nobody (audit D7). A tick that overruns its deadline fails its JOB but KEEPS its lease until it really ends — nobody
else may tick that agent meanwhile.

**Heartbeats**: `agent-engine`, `perp-agent-engine` (the names the monitor and the `system.worker_failing` alert already
know), `agent-stream-engine`, `agent-supervisor`, `agent-jobs`. They appear on the existing monitoring screen.

**Restart recovery, by phase**

| Phase interrupted | What happens after the restart | Test |
|---|---|---|
| signal computed, order not sent | the stored signal row is read back; the strategy is not asked again; the order is placed once | `agent-migration.test.ts` (spot), `perp-agent.test.ts` (perp) |
| order handed to the executor, outcome unknown | the gateway's record is UNKNOWN; the same idempotency key is never sent again; the execution side is asked (`lookup`); the record follows what it says | `agent-workers.test.ts`, `perp-agent.test.ts` |
| order sent and filled, bar not marked complete | same client ids → the ledger answers the first records; nothing is sent | `perp-agent.test.ts`, `agent-migration.test.ts` |
| worker dies holding a lease / a job | the lease expires; the job is reaped and retried or dead-lettered | `agent-workers.test.ts` |
| stream agent restarted | open ledger orders are settled against the simulated book as it is; quotes are recomputed | `agent-stream.test.ts` (pause / resume) |

### Where the workers run — two options, default unchanged

| `SPW_WORKERS` | API process (`dist/api.mjs`) | Agent process (`dist/agents.mjs`) |
|---|---|---|
| `on` (default) | HTTP + every worker, agent runtime included | not used |
| `api` | HTTP + every worker EXCEPT the agent runtime | — |
| `agents` | (do not use for the API) | the agent runtime only, no HTTP |
| `off` | HTTP only | — |

Trade-off

- In-process (default): one process to deploy and watch; a strategy signal (a sandboxed Python process, up to 60 s) and
  the HTTP server share an event loop but not a CPU; a crash of the API takes the agents down with it (PM2 restarts both).
- Separate `sp-wallet-agents` process: an API restart (a deployment, a crash) no longer interrupts a tick or a
  wind-down; the agents' memory and CPU are accounted apart; the stream engine's WebSocket connections are not shared
  with the terminal's (a second connection per venue). Cost: one more PM2 process, the same environment and data
  directory, and the schema must have been migrated by the API first.
- Running `on` and `agents` together is safe (leases and claimed jobs) and pointless.

Deployment steps for the separate process (NOT done; production is untouched)

1. Build: `node scripts/build.mjs` (produces `dist/agents.mjs` next to `dist/api.mjs`).
2. Deploy the API as usual and start it once on this version (it migrates the schema).
3. In the mld manifest of sp-wallet, set `SPW_WORKERS=api` on the API process and add a PM2 process `sp-wallet-agents`:
   `node dist/agents.mjs` with the SAME environment as the API (database URL, signer URL and secret, `SPW_DATA_DIR`,
   `SPW_RESEARCH_*`, the `SPW_DERIV_*` and `SPW_BROADCAST` settings) plus `SPW_WORKERS=agents`. Same node as the API
   (it needs the laboratory directory and the signer on the LAN).
4. Check `GET /api/v1/agents/runtime/status`: `workers.inProcess` is false on the API; the leases show an owner
   `agents@<host>:<pid>:…`; the loop heartbeats of the agent process are NOT in the API's monitor (they live in the
   other process) — watch its PM2 log and the leases' `heartbeatAt`.
5. Rollback: stop `sp-wallet-agents`, set `SPW_WORKERS=on` on the API, restart it.

## 5. Order path

```
engine (bar / stream)  ──▶  AgentOrderGateway.submit(principal, canonicalOrder, { idempotencyKey })
                               1 canonical order valid (@spw/trading)        4 kill switch: only what reduces risk
                               2 record written (agent_order_intents)        5 LIVE: names the mandate in force for THIS agent
                               3 mode: research never; order mode = agent    6 the agent's own limits (RiskGate)
                            ──▶ seam (this branch) ─ perp: PaperPerpExecutor → derivatives risk engine → paper engine
                                                   │       LivePerpExecutor  → account policy → signer's derivative mandate → venue
                                                   └ spot: paper book at a live quote · placeLive → signer's spot mandate → chain
```

- The gateway is the ONLY way an engine places an order (`agent-runtime-unit.test.ts` reads the engines' code).
- The record exists before the seam is called, in the unified states of `@spw/trading` (`transition`).
- An exception from the seam = outcome not known → `UNKNOWN`, journaled as an error. `submit` with the same key then
  answers the stored record after asking the seam (`lookup`); it sends again only when the previous attempt is `FAILED`
  with `NOT_SENT` or `NEVER_PLACED` (proven: nothing left), reusing the same venue client id.
- A record in SUBMITTING that changed less than 60 s ago belongs to the worker executing it: no other worker asks about it
  or settles it (`IN_FLIGHT_GRACE_MS`) — "no trace yet" must never be read as "never placed".
- An agent cannot create, widen or approve its mandate: the only functions that ask the signer to store a mandate are in
  `agents/mandate-write.ts`, imported by the two owner route files and by nothing else — not the engines, not the
  runtime, not the life cycle, not the trading-API handlers (import-graph test).

**Binding** (`agents/runtime-bindings.ts`, called by `main.ts` and `agent-worker-main.ts`):

```ts
bindAgentRuntime({ market, emit, gateway?: OrderGatewayFactory, killSwitch?: KillSwitchPort })
//   gateway     default seamGatewayFactory  → the execution workstream passes the unified order service's factory
//   killSwitch  default localKillSwitch(…)  → the execution workstream passes its risk service's port
```

Limits of the adapter on this branch

- The risk engines are the seams' own (the derivatives risk engine for paper, the account policy and the signer for
  live); `@spw/trading` `evaluate` is not called by the adapter. The gateway adds the kill switch, the mode rule, the
  mandate-presence rule and an instrument gate.
- A canonical order of an agent must carry a `mandateId`. In PAPER it carries the id of the simulated account (the paper
  account, or the agent id): it is not a mandate and signs nothing. In LIVE it must equal the mandate in force.
- `maxFeeUsd` is informative on this adapter.

## 6. Kill switch

`KillSwitchPort { engage(reason) }` — nothing else. The local implementation records the switch (settings
`agents.kill_switch`; from that write on the gateway refuses whatever adds risk) and then halts every venue account an
agent trades on with the existing API-side account halt (which stops new orders, never a reduce-only one). The signer's
emergency halt is not touched. Releasing is an owner route (`POST /api/v1/agents/kill-switch/release`, session; never an
API key, never an agent); the account halts it set keep their own passkey flow.

## 7. Stream engine

For the families that decide between bars. It does not change the bar engines.

- **Data**: `DerivData.subscribe` — Hyperliquid and edgeX over WebSocket (heartbeat, reconnect with backoff, gap
  events), dYdX and GMX by polling the cached REST reads. Instruments are resolved per venue by base asset
  (`hyperliquid:BTC`, `dydx:BTC-USD`, `edgex:BTCUSD`).
- **Freshness**: no decision on a book older than the agent's `maxDataAgeMs` (default 5 s), judged on both the venue's
  timestamp and the time of receipt. A stream that is not `connected` is a gap: resting simulated quotes are cancelled,
  nothing is decided until a fresh snapshot arrives after the reconnect. Both are counted and journaled once per
  transition.
- **Recording**: `market_snapshots` — top of book, mark, index, funding rate and its interval, one row per instrument
  and cadence slot (10 s), pruned after 7 days; `market_snapshot_gaps` — stream gaps and the stretches without a
  usable book. `replayRecorded` runs the same rules and fill model over those rows: the backtest of a stream agent.
- **Modes**: research (decision stored, nothing placed) and paper. There is no live mode.

Rules (`families.ts`, pure, tested with hand-computed cases)

| Family | Rule | What it computes |
|---|---|---|
| market making | `spread_inventory` | half-spread = max(minimum, k × recent volatility); both quotes skewed against the inventory; no quote on the side that would pass the inventory limit; never a crossing quote; requote hysteresis |
| cross-exchange | `net_spread` | `@spw/trading` `crossVenueDiscrepancy` in both directions: the gap net of four legs of fees, exit slippage on both books and funding over the horizon; opens above the threshold, closes when the gap has converged |
| funding arbitrage | `funding_differential` | each venue's rate per HOUR from its published rate and REAL interval; carry over the horizon net of four taker fees; short where longs pay most |

Paper fill model of market making (conservative; every figure depends on it): a quote can be filled only by a book
observed after it rested (`minRestMs`); only when the market trades strictly THROUGH it (a touch is not a fill); at the
quote's price, never better; for at most the size that rested at the crossing best price; the venue's maker fee on
every fill. Between two books nothing is assumed. No queue position, no latency model, no adverse-selection model
inside a snapshot interval.

## 8. The seven agents

| Template | Family | Engine | Strategy binding | research | paper | live |
|---|---|---|---|---|---|---|
| Statistical Arbitrage | `stat_arb` | bar (perp) | lab, by name: `statarb_basket_perp`, then `pairs_coint_perp` | yes | yes | yes, when every instrument is pinned (BTC, ETH, SOL) — `pairs_coint_perp` is |
| Momentum | `momentum` | bar (perp) | `momentum_xs_perp`, then `ts_momentum_perp`, `ma_trend_perp`, `vol_breakout_perp` | yes | yes | only on a BTC/ETH/SOL variant (today's versions include HYPE → paper) |
| Mean Reversion | `mean_reversion` | bar (perp) | `mean_reversion_bands_perp`, then `zscore_reversion_perp` | yes | yes | same condition |
| Funding Arbitrage | `funding_arb` | stream | rule `funding_differential` (lab backtest strategies `funding_arb_cross_venue`, `basis_cash_carry`: optional) | yes | yes | **no** |
| Market Making | `market_making` | stream | rule `spread_inventory` (`market_making_as`: optional) | yes | yes | **no** |
| Cross-Exchange | `cross_exchange` | stream | rule `net_spread` (`cross_exchange_spread`: optional) | yes | yes | **no** |
| Risk Management | `risk_manager` | supervisor | rule `portfolio_supervisor` (`risk_supervisor`: optional) | proposes only | may pause paper agents | may pause paper and live agents and engage the kill switch (owner only) |

Binding by name: a bar template lists strategy NAMES; `templatesView` looks them up in the strategy library
(`research/strategies/<name or name_variant>/`). When none is installed the template answers
`strategyInstalled: false` and creating from it is refused (`strategy_not_installed`) — nothing is substituted. The
names the quant-lab workstream is adding come first; they take effect the day their directories exist.

The strategy library itself is now an explicit manifest (`LIBRARY_MANIFEST`, audit D10): a directory that is not listed
(a fixture, a scratch copy) is never offered. `SPW_LAB_EXTRA_STRATEGIES` adds names for a deployment or a test.

### What can go live, and why not the rest

- The signer signs autonomously on ONE venue: Hyperliquid, under a derivative mandate, for the pinned instruments BTC,
  ETH, SOL. GMX needs the passkey for every order. dYdX and edgeX are read-only.
- Cross-exchange and funding arbitrage need two venues: there is no second leg to execute. The product says
  « mode réel indisponible : une seule plateforme autorise l'exécution sous mandat ». Nothing is faked.
- Market making needs resting limit orders and cancel/replace at a rate the mandate does not cover (60 orders per
  hour), and no live quoting engine is delivered.
- Momentum, mean reversion and statistical arbitrage on Hyperliquid go live through the existing perp live cycle, under
  a mandate, when the strategy's exact universe is within the pinned set (audit D1). The refusal is explicit BEFORE any
  approval: per installed strategy in the templates (`liveCapable`, `liveReason`), on the agent (`live.capable`), in
  the mandate draft.

### Risk Management agent

Reads, per mode: equity against the peak (drawdown), the loss of the day, gross exposure, the smallest distance to a
liquidation price, funding paid over 24 h. Findings are per mode; paper exposure never counts against a live limit.

| Finding | Proposal | Action when allowed |
|---|---|---|
| agent drawdown ≥ limit | pause | pause the agent |
| portfolio daily loss ≥ limit | pause every active agent of that mode | pause |
| LIVE daily loss ≥ kill level | kill switch | `KillSwitchPort.engage` |
| unreadable live account | pause | pause |
| liquidation distance, funding bleed, gross exposure | **reduce** | none: a reduction is a proposal — the supervisor places no order |

Proposals go to the supervisor's journal, to the agent's journal (→ alert) and to the webhook `risk.proposal`. It acts
only when its `act` setting is on AND its mode allows it (research: never; paper: paper agents; live: both — starting
it in live is owner-only). Pausing a live perp agent keeps its mandate (existing `pauseLive`); pausing a live spot agent
revokes its mandate at the signer. It never starts, resumes, orders, releases a halt or lifts the switch: its ports have
no such function. It does not use `beginExit` (stopping an agent stays the owner's or the agent's own loss limit's).

## 9. Life cycle and the trading API

`agents/lifecycle.ts` — one place for the owner's routes, the trading API and the supervisor.

| Action | Rule |
|---|---|
| start research / paper | signs nothing. Paper needs a strategy version whose backtest report passes its integrity checks; the approval is recorded with who gave it (`strategy_versions.approved_by`) |
| start live | perp: only when its derivative mandate is in force (resume from pause); spot: only when it is LIVE already. Otherwise 409 `mandate_required`. Stream families: 409 `live_unavailable` with the reason. Supervisor: owner only |
| pause | perp live: positions and mandate kept; spot live: mandate revoked at the signer, `runtime.pausedFrom = 'LIVE'` (audit D9) — resuming is a new owner approval, because the signer has no sound way to suspend a spot mandate |
| stop | always allowed. Perp live: mandate revoked, reduce-only wind-down; spot live: mandate revoked; stream: quotes withdrawn |

A LIVE mandate can pin only a version the OWNER approved: a version started on paper through an API key answers
`owner_approval_required` at mandate preparation.

Trading API (`/api/v1/trading`, scopes in brackets; `docs/TRADING-API-OPENAPI.md` is generated)

| Route | |
|---|---|
| `GET /strategies` [strategies:read] | library + pinned versions (unchanged) |
| `POST /strategies` [strategies:manage] | register a library version on an agent; queues its backtest |
| `POST /strategies/{id}/backtest` | asynchronous job → `{ job }` |
| `POST /strategies/{id}/start` · `/stop` | start / stop the agent the version is pinned to |
| `GET /agents`, `GET /agents/templates`, `GET /agents/{id}` [agents:read] | list, templates, one agent |
| `GET /agents/{id}/signals` · `journal` · `orders` · `performance` [agents:read] | ONE mode per answer |
| `GET /jobs/{id}` [agents:read] | job status and result |
| `POST /agents` [agents:manage] | from a template, or a perp agent; a spot agent is the owner's (403 `owner_required`) |
| `POST /agents/{id}/start` · `pause` · `stop` · `backtest` [agents:manage] | |

`strategies:manage` and `agents:manage` are no longer "execution scopes" inert without a key-bound mandate: research,
paper, pause and stop sign nothing. Going live is bounded by the AGENT's own mandate, checked in the handler. No route
under `/api/v1/trading` approves a mandate, and a key is refused on every other path as before.

Owner routes (session): `/api/v1/agents/templates`, `/from-template`, `/:id/overview`, `/:id/signals|journal|orders|
performance|timeline?mode=`, `/:id/start|pause|resume|stop`, `/:id/backtest`, `/jobs/:jobId`, `/:id/config`,
`/:id/config-versions`, `/:id/mandate-draft`, `/runtime/status`, `/kill-switch/engage|release`.

## 10. Web — Agents panel

`agentPanel.tsx`: creation from a template (family → strategy → markets → capital → limits), backtest job and its
report (titled and tagged BACKTEST), performance in two tabs (paper, live), each fetching only its mode, the per-mode
timeline (the shared `Timeline`), the mandate request sheet (draft fields, link to `/risk?mandate=agent:<id>`, and a
button to the existing passkey flow until that surface is merged), pause / resume / stop / revoke, the simulated book of
a stream agent, the supervisor's limits and the kill switch. The withdrawals history and the perp limits editor are
wired (audit D14). Not exercised in a browser on this branch; `/risk` is not a route yet.

## 11. Known limits

- The laboratory strategies of the quant-lab workstream are not merged: until they are, momentum and mean reversion
  bind to versions that include HYPE (paper only), and the stream families have no laboratory backtest (their backtest
  is the replay of recorded snapshots, which starts empty).
- The recorded-data backtest sees top of book only and needs days of recording before it says anything.
- The adapter's risk checks are the existing engines' (section 5).
- The kill switch is API-side; a compromised API can ignore it. The signer's mandates and halt are unchanged.
- Performance: spot gas, perp slippage and stream win rate are not computed (section 3).
- `agent-worker-main.ts` has no automated test; the two-process case is tested at the scheduler level (two runtimes on
  one database).
- Nothing here was run on a funded account.

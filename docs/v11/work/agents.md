# V11.1 — trading agents runtime: work notes

Branch `v11-agents`, from the local branch `v11` (`3d055a1`). Date: 2026-11-15. Sources: `docs/TRADING-AGENTS-AUDIT.md`
(the audit of what is extended; §8 defects D1–D15, §9 what to build) and `docs/v11/work/stab-signer.md` (Phase B).
Architecture: `docs/TRADING-AGENT-ENGINE.md`.

Nothing here touched a production node, a funded account, a real order or a real transaction. No network call was made
by the tests: venues replay recorded answers and recorded WebSocket frames, the signer is a local process on a temporary
directory, the laboratory is the local virtualenv.

## Verification observed

See the end of this file ("Verification, as run"): the commands, their exit codes and the totals, written after the
last code change.

## Files of other workstreams that were touched, and why

| File | Change |
|---|---|
| `services/api/src/db.ts` | one contiguous block `>>> v11 trading agents runtime` (additive) |
| `services/api/src/server.ts` | import + `runtimeRoutes(app)` (two lines) |
| `services/api/src/main.ts` | the two `start*AgentEngine` calls replaced by `bindAgentRuntime(…)` + `agents.start()` (the DI binding point) |
| `services/api/src/config.ts` | `SPW_WORKERS` gains `api` and `agents`; `config.agentWorkers` |
| `scripts/build.mjs` | fourth bundle `dist/agents.mjs` |
| `services/api/package.json`, `pnpm-lock.yaml` | `@spw/trading` as a dependency of the API (canonical order, order state machine, `crossVenueDiscrepancy`) |
| `services/api/src/trading-api/spec.ts` | the seven strategy/agent writes flipped to implemented; new per-agent reads, `pauseAgent`, `backtestAgent`, `getJob`, `listAgentTemplates`; `AgentMode`; webhook event `risk.proposal`; **`EXECUTION_SCOPES` no longer contains `strategies:manage` and `agents:manage`** (see item 8) |
| `services/api/src/trading-api/routes.ts` | import + `...agentTradingHandlers()` replacing `listAgents` and the seven `notWired` |
| `docs/openapi/trading-v1.json`, `docs/TRADING-API-OPENAPI.md` | regenerated (`node scripts/gen-openapi.mts`) |
| `services/api/test/trading-api.test.ts` | three expectations: the list of unimplemented operations (5), `implemented: 30`, the inert scopes of a key without a mandate |
| `services/api/test/perp-agent.test.ts`, `perp-agent-live.test.ts` | table name `agent_signals`; `prepareLive` / `approveLive` imported from `mandate-write.ts`; ONE behavioural expectation (item 5) |
| `apps/web/src/developer.ts`, `apps/web/test/developer.test.ts`, one key `dvGroup_manage` in `i18n.ts` | the developer screen shows the management scopes apart from the execution scopes; operation counts |
| `apps/web/src/i18n.ts` | one contiguous block `ag2*` (183 keys, FR and EN) |

`research/**` was not edited.

---

## 1. Agent model

**Initial state.** An agent = one `agents` row + an approved `strategy.py`. No family, no configuration history, states
and modes as drifting strings.

**Change.** `agents.family | template | engine | config_version | runtime`; `agent_config_versions`; the projection
`active | paused | stopped` (`lifecycleOf`) and `research | paper | live` (`modeOf`); `agentSummary` (model, strategy
pinned by hash, limits, mandate reference, live capability). Every creation, strategy approval, limits change and rule
configuration change creates a configuration version (`bumpConfig`); signals, orders and journal lines carry the
running version. Spot and perp agents keep their tables and routes.

**Tests.** `agent-migration.test.ts`: "the fixture is really the old shape…", "migrates (twice: idempotent) without
touching what the agents were", "every agent gets a family…, the bar engine, and configuration version 1 — once", "the
summary: active | paused | stopped…". `agent-runtime-unit.test.ts`: "agent model" (6 tests).
`agent-trading-api.test.ts`: configuration versions through the routes.

**Result.** Pass. **Limitation.** The family of a pre-V11 agent is inferred from its strategy's name (`custom` when it
has none). A spot agent's limits still cannot be edited after creation (no route existed; none was added).

## 2. Three modes, structurally separated (D5)

**Initial state.** `agent_orders` and `agent_equity` had a mode column; `research_log` and `perp_agent_signals` did
not; the detail routes returned both modes in one list and one curve.

**Change.** `research_log.mode` (+ `severity`, `code`, `config_version`, `ref`) with a trigger that fills a missing
mode from the agent; `agent_signals` with the mode in its key; `agent_order_intents.mode`. Backfill: the SQL function
`spw_agent_mode_at(agent, time)` reads the audit chain (`mandate.approved` with an agent, `agent.perp_live`,
`agent.mode` → PAPER_TRADING) — the last start event before the record decides. Read functions of `store.ts` take one
mode; perp orders, fills and funding are read from the ACCOUNT of that mode. The existing detail routes of spot and perp
agents now return the records of the current mode only.

**Tests.** `agent-migration.test.ts`: "D5 — the journal gets its mode from the agent's history…", "D5 —
perp_agent_signals is generalised…", "a journal line written without a mode…", "journal, orders and signals answer ONE
mode…", "performance is computed per mode…: paper +4 %, live −6 %, and no figure adds the two".
`agent-runtime-unit.test.ts`: "every read of a table shared by paper and live names the mode" (scans the SQL of ten
files), "the performance path reads ONE mode…". `agent-trading-api.test.ts`: per-mode answers of signals / orders /
journal / performance, `mode=all` → 400.

**Result.** Pass. **Limitation.** The backfill of a journal line written after an agent left LIVE keeps LIVE (the last
trading mode), by rule. The SQL test reads source text: a query built outside a `sql` template would escape it (there
is none in those files). The trading API's older `GET /orders` / `GET /positions` (trading-api workstream) were not
changed.

## 3. Signals, journal, performance (D8)

**Initial state.** Perp signals only; no structured journal; no performance figure anywhere.

**Change.** `agent-runtime/journal.ts` (`journal`, `recordSignal`, `decideSignal`, `inputsDigest`), the spot engine
stores its signal before any order and reads it back, the perp engine writes `agent_signals` with the decision and the
digest; `agent-runtime/performance.ts` (pure) and `store.performanceInput` / `agentPerformance`; `agentTimeline`.

**Tests.** `agent-runtime-unit.test.ts`: "performance — one module, hand-computed cases" (4 tests: returns, volatility
10.80741, Sharpe 27.01851, Sortino 54.03703, drawdown, win rate 2/3, profit factor 2.6, turnover, fees, funding,
slippage, null-with-reason, warnings, spot average cost). `agent-migration.test.ts`: "a new bar: the signal is STORED
(D8)…", "a strategy that answers nothing valid is a recorded HOLD…".

**Result.** Pass. **Limitation.** Spot network fees, perp slippage and the stream book's per-trade results are not
computed (the answer says so). The timeline shows gateway orders through their journal lines, older orders as rows.

## 4. Persistent workers (D7)

**Initial state.** One sequential loop per engine in the API process, an in-memory backoff map, no cross-process lock.

**Change.** `leases.ts`, `queue.ts`, `scheduler.ts`; `tickSpotAgentOnce` extracted from `enginePass` (which is kept,
sequential, for scripts and existing tests); `agents/runtime-bindings.ts`; `agent-worker-main.ts`; `SPW_WORKERS`.

**Tests.** `agent-workers.test.ts`: leases (3), job queue (4: dedupe, concurrent claim, retries 2/5/10/15 min then
dead-letter, reaping), scheduler (6: two runtimes on one database tick each agent once; a failing and a slow agent
delay nobody and the backoff is a row; dead-letter journaled; an overrunning tick keeps its lease; leased elsewhere;
jobs pass). Restart recovery: section 4 of the architecture document lists the test per phase.

**Result.** Pass. **Limitation.** `agent-worker-main.ts` was started by hand only (below); the two-process case is
tested with two runtimes in one test process. A tick cannot be interrupted: past its deadline it runs on, holding its
lease. The stream engine's loop runs every second even with no stream agent (one small query).

## 5. Order path

**Initial state.** The perp engine called `PerpExecutor.place`; the spot engine inserted paper fills itself and called
`placeLive`.

**Change.** `AgentOrderGateway` and `SeamOrderGateway` (`agent-runtime/gateway.ts`), `GatewayPerpExecutor` /
`perpSeam` (`agents/perp-gateway.ts`), `spotSeam` (`agents/spot-seam.ts`), the ledger `agent_order_intents`. Mandate
writing moved to `agents/mandate-write.ts`.

**One existing expectation changed** (`perp-agent.test.ts`, "restart in the middle of a bar"): an executor that throws
no longer ends the pass with an exception; the gateway records the order UNKNOWN, the bar stays open
(`'1 order(s), 1 waiting for the next pass'`), and the next pass asks the execution side before anything is sent. The
rest of that test (no second signal, no order placed twice, same client ids) is unchanged and passes.

**Tests.** `agent-workers.test.ts` "order gateway" (9 tests, incl. "UNKNOWN OUTCOME — … NEVER sent again under that
key", "a new attempt … ONLY when the previous one provably never left"), "kill switch port".
`agent-runtime-unit.test.ts` "module boundaries" (5 tests). The existing `perp-agent.test.ts` (paper, real paper
service) and `perp-agent-live.test.ts` (fake venue, real signer logic) run through the gateway and pass.

**Result.** Pass. **Limitation.** The adapter does not call `@spw/trading` `evaluate`; in paper the canonical order's
`mandateId` is the simulated account's id. Both are for the execution workstream's service to settle at the merge.

## 6. Stream engine

**Initial state.** None; the Hyperliquid stream fed the terminal only.

**Change.** `agent-runtime/stream-engine.ts`, `families.ts`, tables `market_snapshots`, `market_snapshot_gaps`.

**Tests.** `agent-stream.test.ts` (16 tests) on frames RECORDED from Hyperliquid mainnet, replayed through the real
stream client: gap before connection, quotes on the first recorded book, a maker fill when the second recorded book
(5.5 s later) trades through the bid, freshness (20 s without a frame), socket drop → pause → reconnect → resume,
recording and missing-data accounting, per-mode performance, replay, pause/stop, research mode, kill switch,
cross-exchange open/close, funding differential, a venue without the market, template validation.
`agent-runtime-unit.test.ts`: the rules and the fill model (15 tests).

**Result.** Pass. **Limitation.** The second venue of the cross-exchange and funding tests is scripted (the recorded
Hyperliquid book shifted by a stated amount): no recorded edgeX or dYdX book of the same instant exists in the
fixtures. dYdX and GMX polling goes through the existing data service and was not exercised with a stream agent here.
The fill model is conservative but ignores queue position and intra-interval adverse selection.

## 7. The seven agents

**Initial state.** No template; five target families missing as agents.

**Change.** `TEMPLATES` (model.ts), `agents/templates.ts`, `agent-runtime/risk-supervisor.ts`, `LIBRARY_MANIFEST`.

**Tests.** `agent-runtime-unit.test.ts`: "the seven templates…", "D10: the library manifest…", "risk supervisor"
(10 tests: findings per mode, research never acts, paper acts on paper only, live pauses and engages the kill switch,
once per condition, a failed action is reported failed, the ports have nothing else). `agent-trading-api.test.ts`:
templates with no laboratory strategy installed → `strategy_not_installed`; the supervisor end to end.

**Result.** Pass. **Limitation.** With today's library, momentum and mean reversion bind to strategies that include
HYPE: paper only. Creating a bar agent from a template with the real laboratory was not exercised by an automated test
on this branch (it calls the same `createPerpAgent` and `registerStrategy` the existing tests cover). The supervisor's
"reduce" is a proposal; it does not use `beginExit`.

## 8. Trading API

**Initial state.** Seven writes answering 501; `agents:manage` and `strategies:manage` inert without a key-bound mandate.

**Change.** `agents/trading-handlers.ts`, `agents/lifecycle.ts`, spec and OpenAPI. The two scopes became management
scopes: a key without a mandate can create (perp / stream / supervisor), backtest, run research and paper, pause and
stop; LIVE is refused unless the AGENT's own owner-approved mandate is in force.

**Tests.** `agent-trading-api.test.ts` (12 tests, real server, real key): templates, create, backtest job, start
paper, signals from recorded data, mode-scoped reads, LIVE refused (`live_unavailable`, `mandate_required` for perp and
spot), D9, a key's paper approval is not an owner approval, what a key can never do, scopes and venue restrictions,
idempotent replay, the supervisor, the kill switch, the owner's panel routes.

**Result.** Pass. **Limitation.** A backtest of a BAR agent through the job queue (the laboratory process) is covered
by the existing registration tests, not by a new end-to-end test.

## 9. Web

**Change.** `apps/web/src/screens/agentPanel.tsx`, `Agents.tsx`, i18n block `ag2*`.

**Tests.** `apps/web/test/agents-v11.test.ts` (15 tests).

**Result.** Pass; first chunk unchanged in size (see below). **Limitation.** Not exercised in a browser. `/risk` is not
a route yet: the mandate link falls through to the app's default until the execution workstream ships that surface.
Journal and signals are shown through the per-mode timeline, not as separate lists.

## 10. Audit defects

See the "V11 status" table at the end of `docs/TRADING-AGENTS-AUDIT.md`. In this branch: D1 (explicit refusal,
binding by name), D5, D7, D8, D9, D10 (listing), D11, D12 (two comments), D14 (the two agent routes).

---

## Not done or partial

| Item | State | Reason |
|---|---|---|
| Laboratory strategy names of the quant-lab workstream | bound by name, not present | not merged; `research/` is not this workstream's |
| `@spw/trading` `evaluate` in the order path | not called | the unified risk service is the execution workstream's; the binding point exists |
| Live mode for market making, cross-exchange, funding arbitrage | not built | one venue signs under a mandate; stated in the product |
| Paired-leg live execution for statistical arbitrage | not built | the perp live cycle sends legs one after the other, as audited |
| Signer-enforced suspend of a spot mandate | not built | would weaken or complicate the signer; pause revokes, resume is a new approval |
| Passkey for releasing the agents' kill switch | owner session only | API-side switch; the account halts it sets keep their passkey flow |
| Recorded second-venue data for the stream tests | scripted | no fixture of the same instant |
| Browser run of the panel | not done | no browser automation on this branch |
| Deployment of `sp-wallet-agents` | documented, not done | production is not to be touched |

---

## Verification, as run (after the last code change)

| Check | Result observed |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` (whole suite, laboratory virtualenv present) | exit 0 — **150 files, 3 669 tests, all passed**, 60 s |
| the same suite without the laboratory virtualenv | an EARLIER run of this branch (not repeated after the last change): 2 files and 59 tests skipped — the laboratory tests are gated on `research/.venv` existing in the checkout, not on `SPW_RESEARCH_PYTHON` |
| new tests of this branch | `agent-runtime-unit` 47, `agent-migration` 13, `agent-workers` 23, `agent-stream` 16, `agent-trading-api` 12 (API: 111), `apps/web/test/agents-v11` 15 — 126 |
| the agent suites alone, three times in a row | 124 passed each time (new suites + `perp-agent`, `perp-agent-live`, `agent-networks`) |
| `node scripts/build.mjs` | exit 0 — `dist/api.mjs`, `dist/signer.mjs`, `dist/research-runner.mjs`, `dist/agents.mjs` |
| `(cd apps/web && node_modules/.bin/vite build)` | first chunk `index-*.js` **258.86 kB** (no regression); `Agents-*.js` 142.21 kB |
| `node scripts/gen-openapi.mts` | committed files are what the code generates (also asserted by `trading-api-unit.test.ts`) |
| by hand, temporary database | `SPW_WORKERS=on node dist/agents.mjs` → exit 2 with the message; `SPW_WORKERS=agents` on an unmigrated database → exit 3 with the message; `SPW_WORKERS=off node dist/api.mjs` migrates and logs `workers=off agent-workers=not in this process`; then `SPW_WORKERS=agents node dist/agents.mjs` logs `sp-wallet agents worker agents@<host>:<pid>:… started` and the sandbox self-test line, and exits 0 on SIGTERM |

The laboratory virtualenv of the main checkout was linked into the worktree for the full runs and removed before the
commit (the link is not ignored by git: it must never be staged).

Two failures seen in earlier full runs of this branch, both in the new tests, both real, both fixed:

1. `agent-workers` "the jobs pass runs backtests…" — a job enqueued with the database's microsecond clock was not due for a
   JavaScript millisecond read taken in the same instant. The scheduler now uses the database's clock for the queue
   unless a clock is injected.
2. `agent-workers` "same idempotency key…" under load — a second worker arriving with the same key while the first was
   still executing asked the execution side, read "no trace yet" and could have settled the in-flight order as never
   placed. A record in SUBMITTING that changed less than 60 s ago is now left alone by everybody but the worker executing
   it (`IN_FLIGHT_GRACE_MS`; test "an order another worker is executing RIGHT NOW is left alone…").

The known flaky test of the suite (`api.test.ts › swap: quotes are for the wallet's own addresses`) passed in every run
here.

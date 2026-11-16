# V11.2 — agents bound to the execution layer: work notes

Branch `v11-agents-bind`, from the local branch `v11` (`dbd62f2`), with `v11` merged again at `a105202` (the "execution
gaps" work, `docs/v11/work/exec2.md` and its notes for this workstream, `exec2-notes-agents.md`). Date: 2026-11-15/16.
Read with `docs/TRADING-AGENT-ENGINE.md` (sections 5, 6 and 4), `docs/TRADING-MANDATES.md` (section "Agents") and
`docs/TRADING-AGENTS-AUDIT.md` ("V11 status").

Nothing here touched a production node, a funded account, a real order or a real transaction. Unit and API tests make no
network call (fixture venues, a scripted Hyperliquid, the real signer class on a temporary directory, the laboratory of
the checkout). Two runs read PUBLIC market data and nothing else: the worker-process test starts a real API process
with `SPW_WORKERS=api`, whose market worker may read public candles; the browser run on `scripts/dev-stack.sh` reads
Hyperliquid's public data for the backtest, the signal and the paper fills.

## Files of other workstreams that were touched, and why

| File | Change |
|---|---|
| `services/api/src/db.ts` | inside the block `v11 trading agents runtime`, additive: `agent_order_intents.order_id`, three columns made nullable, the constraint `agent_order_intents_one_truth`, an index; the migration of the old agents-side kill-switch flag into `risk.switches` |
| `services/api/src/signer-client.ts` | `signerGuards.beforeMandateSign` and `signer.mandateSign` take an optional `{ reducesRisk }` (requested by `exec2-notes-agents.md` §2) |
| `services/api/src/orders/index.ts` | ONE line: the spot guard lets a sale into the agent's cash leg through under the kill switch (read-only mode still blocks it) |
| `services/api/src/agent-runtime/model.ts` (owned) / `services/api/test/lab-sandbox…` | a comment reworded: the sandbox test reads any quoted `spq.*` as a laboratory call |
| `services/api/test/perp-agent.test.ts`, `perp-agent-live.test.ts`, `agent-workers.test.ts`, `agent-migration.test.ts`, `agent-stream.test.ts`, `agent-runtime-unit.test.ts`, `agent-trading-api.test.ts`, `lab-identity.test.ts` | bound to an execution layer; expectations that changed are listed per item below |
| `tests/e2e/agents-bind.spec.ts` | new browser test |
| `docs/TRADING-MANDATES.md`, `docs/TRADING-AGENT-ENGINE.md`, `docs/TRADING-AGENTS-AUDIT.md` | sections on agents |

Not edited: `orders/service.ts`, `orders/store.ts`, `risk/**`, `mandates/**`, `trading-api/**`, `packages/**`,
`research/**`, `apps/web/src/screens/Risk.tsx`, `apps/web/src/risk/**`.

---

## 1. One order path

**Initial state.** Every agent order went through `SeamOrderGateway`: its own ledger `agent_order_intents` held the
state; the perp seam called `PaperPerpExecutor.place` / `LivePerpExecutor.place` (→ `placeMandateOrder`). The unified
risk engine was reached only through the engine hooks (as principal *owner* in paper), the trading mandates not at all,
and in paper the "mandate" of the canonical order was the id of the simulated account.

**Change.**

- `agents/unified-gateway.ts` — `UnifiedOrderGateway implements AgentOrderGateway` over
  `execution.orders.submitCanonical({ principal: { kind: 'agent', id }, mandateId }, order, idempotencyKey, { origin: 'agent', accountId })`.
  It keeps no state: it answers what `orders` says.
- `agents/execution-bind.ts` — `bindExecution(execution)`: the gateway factory (`unifiedGatewayFactory`), the kill
  switch (item 2), the `AgentControlPort`. `bindAgentRuntime` now REQUIRES `execution`; `main.ts` passes
  `app.execution`; `agent-worker-main.ts` builds its own (`createExecution` + `installGates` + the `order.updated`
  emitter); a server instance binds itself when it becomes ready (`runtime-routes.ts`, hook `onReady`). Unbound,
  `orderGateway()` throws `gateway_unbound`: there is no silent second path.
- Which family goes where:

| Family | Path | Why |
|---|---|---|
| perp agents (bar engine), PAPER and LIVE | `UnifiedOrderGateway` → unified `orders`, risk engine `evaluate`, trading mandate, `order.updated` | — |
| spot agents | `SeamOrderGateway` (ledger rows) → `agent_orders` → **projected into `orders` by the execution layer** (`orders/spot.ts`, `engine = 'spot'`) | the order service refuses spot for an agent principal (`spot_execution_requires_agent_vault`); the projection and the `agent_orders` gate trigger are the execution workstream's |
| stream agents (market making, cross-exchange, funding arbitrage), PAPER | `SeamOrderGateway` (ledger rows), **not unified orders** | see "Not done" |

- The semantics the engines rely on:

| Semantics | Where it lives now |
|---|---|
| same key → the stored record, never a second order | the unified order of (agent, key) is looked up first and answered (`getByIdempotency`); `submitCanonical` is never called for a key that has an order (so a changed body cannot even produce `idempotency_conflict`) |
| an exception while handing over → UNKNOWN, reconciled, never sent again | the order service stores the order before its engine is called, the engine stores its row before anything is signed; after an exception the stored order is the answer (`SUBMITTING` / `UNKNOWN`), the order service's reconciler settles it, the gateway only re-reads it (and asks the venue account about it through the executor's `lookup` / `observe`) |
| a new attempt only when nothing left, with the same venue client id | what the live executor defers BEFORE an order exists (cool-down, an unconfirmed earlier order, floor guard, leverage not set — `LivePerpExecutor.prepare`, the former steps 1 to 5 of `place`) and what the order service refuses before it creates anything leave NO order: the same key, hence the same client id, is submitted again later. **A unified order that ended FAILED is final for its key**: the instrument is held until the next bar (before: a `NEVER_PLACED` seam record could be attempted again within the bar) |
| research → `READ_ONLY_MODE`; LIVE names the mandate in force | checked in the gateway before anything else (answer `source: 'none'`, journaled, nothing stored) |

- `agent_order_intents` — **context table, state read from `orders`** (the option chosen). A row with `order_id` set is
  the agent's context of a unified order (signal id, configuration version, strategy hash) and holds no state: the
  constraint `agent_order_intents_one_truth` refuses a row that both points to a unified order and has a `state`,
  `record`, `reason`, a history or fills. `listAgentOrders` reads unified orders FROM `orders` (filtered by principal),
  left-joined to the context; rows without `order_id` are the seam ledger of the two families above.
- PAPER mandate: `agents/paper-mandate.ts` `ensurePaperMandate` — a `SPW-TRADING-MANDATE-v1`, `mode: 'paper'`, no
  passkey, created when paper starts (`perpMode('PAPER')`) by the owner, or by a key holding `agents:manage` inside the
  key's own restrictions and per-order limit; superseded when the agent's limits, instruments, capital or strategy
  version change. Its id is kept in `agents.runtime.paperMandate`; the canonical order names it.
- Live: the executor's own conditions run before the order exists (`prepare`), the order goes through
  `submitCanonical` (which calls `placeMandateOrder` with the trading mandate's strategy hash), the executor is then told
  the outcome (`observe`: unconfirmed orders, refusals that end the mandate). A live order is sent without a `leverage`
  field (the venue's setting, which `prepare` has just brought to the agent's policy, is what executes).
- Provenance (`orders/provenance.ts`, exec2): an agent reduces only what its own fills opened. A closing order larger
  than its lot is refused whole by the order service; the gateway then closes the agent's part (`position_not_attributable`
  → the order is cut to `provenance.reducible`, journaled) and the engine reports the rest as still open.

**Expectations that changed in existing tests** (each is a consequence of the unified path, none was relaxed):

| Test | Before | Now |
|---|---|---|
| `perp-agent.test.ts` "perp engine step (fake executor)" | default gateway | the seam gateway is passed explicitly over the fake executor (an engine-step unit test) |
| `perp-agent-live.test.ts` "partial fill…" | a thin book partly filled the IOC order | the risk engine refuses it before the signer (`slippage: the supplied book fills only 0.003 of 0.00714`), REJECTED unified order |
| same, "orders per hour" | fifth order refused by the signer (`signer_orders_hour`) | refused by the trading mandate first (`mandate_denied`) |
| same, daily turnover | `signer_turnover` at 6 000 | removed: the signer bound is compiled as order limit × orders per day (see item 3) |
| same, leverage | 2× on the venue | 1× (item 3) |
| same, "divergence" | the agent flattened the whole account | it closes its own lot; the foreign part stays open and is reported |
| same, "paper agent in the same pass" | reached its fake executor | refused before any executor: no paper mandate |

**Tests.** `agent-bind.test.ts` (8, real laboratory, recorded data — transcript below); `perp-agent.test.ts` API tests
(paper through the order service); `perp-agent-live.test.ts` (20, fake venue, real signer logic, all through
`submitCanonical`), in particular "a live order is a unified order under the agent's TRADING mandate…";
`agent-runtime-unit.test.ts` module boundaries.

**Result.** Pass. **Limitations.** See "Not done". `SPW_TRADING_API_EXECUTION` now also gates a live agent's new risk
(the order service applies it to every caller): default off means a live perp agent only reduces — stated in the
deployment notes. A paper mandate lasts 90 days (the schema's maximum): a paper agent that runs longer is started
again. A key's DAILY notional limit is not expressible in a mandate and does not bound its agents' paper orders.

## 2. One kill switch

**Initial state.** `settings['agents.kill_switch']`, engaged by the supervisor or the owner, released by
`POST /api/v1/agents/kill-switch/release` with the owner's session and no passkey; and, apart from it, the risk engine's
switch.

**Change.** `agent-runtime/kill-switch.ts` holds no state: `KillSwitchPort.engage(reason, by)` →
`risk.engageKillSwitch({ kind: 'agent' | 'owner', id }, reason)`; `KillSwitchRead` → `risk.switches()` (unbound: the same
record, read-only). `kill-switch-admin.ts` and the release route are deleted; `…/agents/kill-switch/engage` stays as a
thin alias of `POST /api/v1/risk/kill-switch`. The panel shows the state and links to Risk for the release. A stored
agents-side flag that was engaged is carried into `risk.switches` by the migration (actor
`system:migration:agents.kill_switch`), then the key is deleted. The halting of venue accounts that the old switch did
is gone: the gate of the risk engine stops new risk on every engine path, and lifting an account halt needed a passkey
anyway.

Follow-ups asked by `exec2-notes-agents.md`: the `agent_orders` gate trigger's refusal is a risk refusal for the spot
seam (`kill_switch_active` / `read_only_mode`, journaled once under the order's key — not an unknown outcome); a live
spot sale into the cash leg is signed under the kill switch (`reducesRisk`).

**Tests.** `agent-workers.test.ts` "kill switch port — bound to the risk engine"; `agent-runtime-unit.test.ts` "NOTHING
in the agent code can release the kill switch, and it holds no switch state of its own" (no release call, no write of
the record, the only `engageKillSwitch` callers); `agent-trading-api.test.ts` "ONE kill switch…" (alias, `/risk/state`,
a paper market maker refused, release route 404); `agent-bind.test.ts` "ONE KILL SWITCH" (the supervisor's engage in its
own name; perp paper: REJECTED `KILL_SWITCH_ACTIVE` as a unified order, reduce-only FILLED; spot seam: buy refused,
sale passes; release only with the passkey on the risk route); `perp-agent-live.test.ts` "kill switch engaged…" (LIVE:
refused before the signer, the reduce-only exit is signed).

**Result.** Pass. **Limitation.** The migration of an engaged flag is covered by reading the SQL, not by a test with a
pre-migration database.

## 3. Mandates for agents

**Initial state.** `prepareLive` built a derivative mandate from `deriveMandate` and had it approved directly on the
live module: no trading mandate, no usage counters, no stop conditions, not in the Risk screen.

**Change.** `agents/mandate-write.ts`: `createLiveMandate` (a trading mandate from the same `deriveMandate` proposal,
state `created`) → `prepareLive` (= create + `mandates.prepareApproval`) → `approveLive` (`mandates.approve`, then
`activateLive`). The signer receives the derivative mandate COMPILED by the mandate service
(`compileToVenueMandate`): same shape, same hash rule, same ceremony. `perp.live.unified = true`,
`perp.live.mandateId` = the trading mandate's id = the signer mandate's id. Revocation (`beginExit`, the wind-down)
goes to the signer first, then through `mandates.revoke`. `pauseLive` is unchanged (the mandate stays). A revocation or
a stop condition from the Risk screen revokes the signer's copy; the agent sees `mandate_revoked` on its next pass and
winds down.

Two approval ways, same mandate: the agent page (`perp/live/prepare` → `approve`), or the Risk screen — the mandate
sheet of the panel creates the mandate from the draft (`POST /agents/:id/perp/live/mandate`) and opens
`/risk?mandate=<id>`; after the approval there, "start live" on the agent records it (`lifecycle.startAgent` →
`activateLive`, owner only; nothing is written to a mandate).

Consequences of the mandate service's rules, all visible on the approval sheet:

- **two passkey prompts** for a live mandate (the signer's, then the API's binding over the full mandate hash);
- **leverage**: a trading mandate states capital and leverage and the signer's gross bound is compiled as capital ×
  leverage, with the floor below the capital. So that the signer never accepts more gross exposure than the agent's
  limits say, the mandate takes the largest whole leverage for which gross ÷ leverage stays above the floor: with the
  default limits (gross 1.5 ×, floor 0.9 ×) that is **1×** (before: 2×);
- **daily turnover** at the signer = order limit × orders per day (before: max(order, gross × N));
- stop conditions: the agent's total-loss limit (`loss_gte`) and 25 consecutive refusals.

A LIVE agent whose derivative mandate predates this branch (`unified` absent) keeps its way out: reduce-only orders go
through the seam it was approved on; nothing that adds risk does.

**Tests.** `perp-agent-live.test.ts`: every test goes through the trading mandate; "a live order is a unified order…"
(same id at the signer, enforcement table, usage counted, revocation recorded with its reason), "the Risk-screen
way…" (created → not startable → approved through the mandate service → `startAgent('live')` by the owner only →
revoked from the service → the agent winds down with `mandate_revoked`).

**Result.** Pass. **Limitations.** The `/risk?mandate=…` link opens the Risk screen, where the mandate is listed with
its Approve button; the screen does not read the parameter (see "For the execution-gaps workstream"). Spot vault agents
keep the signer's spot mandate flow (`docs/TRADING-MANDATES.md`, section "Agents").

## 4. Laboratory follow-ups

**Change.** (delegated part, reviewed) `perp-strategies.ts`: `--report-version 3`, schema 2 or 3 accepted, v3 requires
`engine_parity.applied === true`; `perp-routes.ts` `perpReportSummary`: `gross_to_net` per split, `executionModel`,
`engineParity`, `dataBias`, `journal`; `strategies.ts`: `--engine-parity`; `fitsPerpAgent`: generic universes within
`min_symbols` / `max_symbols` (capped at 8); `model.ts` `TEMPLATES` bound by name (`momentum_xs_perp/2` then `/1`,
`mean_reversion_bands_perp/2` then `/1`, `statarb_basket_perp`, backtest-only `funding_arb_cross_venue` and
`basis_cash_carry`, studies `market_making_as`, `cross_exchange_spread`, `vol_forecast`, policy `risk_supervisor`);
`agents/lab-verdicts.ts` reads `research/results/2026-11-15-v11/summary.json`, the manifest and the reports;
`labReport.tsx` shows them on the template cards and the v3 sections on the agent pages, labelled BACKTEST.

`summary.json` contains no verdict sentence: the UI composes its sentence from the file's figures (deflated Sharpe,
net return, stops per split) through an i18n template — data, not prose.

**Risk supervisor policy — kept in TypeScript.** `spq.risk_supervisor.propose(positions, equity_curve, limits)` is a
pure function but (a) the laboratory has no process entry point for it (the sandboxed runner starts `spq.*` modules
with a command line; adding one is `research/`), and (b) its contract is position-level reductions on one account,
whereas the agent judges per-agent snapshots per mode and its only two actions are pausing an agent and engaging the
kill switch. Its proposals would stay proposals in both cases.

**Tests.** `lab-verdicts.test.ts` (11), `lab-identity.test.ts` (the five new 1 h perp strategies compared,
`basis_cash_carry/1` skipped, no cross-venue strategy listed), `agent-runtime-unit.test.ts`, `apps/web/test/agents-v11.test.ts`
(21), and the end-to-end run below.

### Transcript: template → backtest → paper, real laboratory, recorded data

`SPW_BIND_TRANSCRIPT=<file> pnpm vitest run services/api/test/agent-bind.test.ts` — a real server, the sandboxed
laboratory of the checkout, the last 2 400 hourly bars of BTC, ETH, SOL the quant lab pulled from Hyperliquid on
2026-11-15 (`services/api/test/fixtures/agents/hl-1h-btc-eth-sol.json.gz`), the test clock five and a half minutes after
a bar close. Output as written by the run:

```
GET /api/v1/agents/templates → momentum: installed momentum_xs_perp/2, momentum_xs_perp/1, ts_momentum_perp/1, ma_trend_perp/1, vol_breakout_perp/1
  lab verdict momentum_xs_perp/2 (read from research/results/2026-11-15-v11): deflated Sharpe 0.07410457997966707, significant=false, live-capable=true
POST /api/v1/agents/from-template {"template":"momentum","name":"Momentum bind","strategyPath":"momentum_xs_perp/2","capitalUsdc":"10000"}
  → 200 agent 641d82c2… family=momentum mode=research strategy=momentum_xs_perp/2 sha256=75cd4dfae65f… version backtesting
POST /api/v1/agents/641d82c2…/backtest → 200 job c3f48b8a… status=queued label=backtest
  job done; strategy version draft; REPORT (label: backtest) schema_version=3 engine_parity.applied=true checks={"lookahead":"pass","ledger":"pass","funding_alignment":"pass","data_quality":"pass"}
  test split (BACKTEST, not a performance): net return -0.008818507328575809, sharpe -1.4263964342746271, max drawdown 0.03672970640172013; gross→net {"funding":-1.443014594868063,"latency":3.944317953766701,"net_pnl":-8.818507328575834,"slippage":0.5164663864936,"price_pnl":0.3938200000000016,"return_net":-0.008818507328575833,"sharpe_net":-1.4263964342746271,"return_gross":0.0003938200000000016,"sharpe_gross":0.12055219869333797,"trading_fees":3.3085283934474545,"bad_debt_written_off":0,"return_after_funding":-0.0010491945948680615,"liquidation_penalties":0,"costs_over_gross_profit":19.728080680787475,"cost_drag_bps_of_mean_equity":78.08495386591034}
  engine parity observed: {"test":null,"train":null,"validation":null}; execution model keys: fees, funding, latency, accounts, slippage, liquidation
  journal: {"strategy":{"name":"momentum_xs_perp","sha256":"75cd4dfae65f6d55667bfaf3fe2eee2b5c98c18edbe8b43dcd8480d88262e272","version":"2"},"code":{"numpy":"2.5.4","pandas":"3.1.1","python":"3.12.13","code_sha256":"6ea1cf4df5ceb8b33c0a763ca1c8724c76de60b861714597b73295ec89507356","spq_version":"0.1.0"},"data":{"bars":2397,"range":["2026-08-07T00:00:00+00:00","2026-11-14T20:00:00+00:00"],"sha256":"c5d0d92cee3c2252441f8166ba14db
POST /api/v1/agents/641d82c2…/start {"mode":"paper"} → 200 mode=paper state=active
  paper trading mandate 4cf57926… (SPW-TRADING-MANDATE-v1, mode paper, no passkey): hyperliquid:BTC, hyperliquid:ETH, hyperliquid:SOL; order ≤ 10000 USD, position ≤ 10000 USD, leverage ≤ 2, expires 2027-02-12
tick at 2026-11-14T21:05:30.000Z → 3 order(s)
GET /api/v1/agents/641d82c2…/signals?mode=paper → 1 signal(s); latest: bar 2026-11-14T20:00:00.000Z decision=acted strategy output={"BTC":0.08808610711977198,"ETH":0.3268688166418926,"SOL":-0.3813757661818545} targets={"BTC":"0.0136","ETH":"1.8341","SOL":"-54.1"}
  orders: ag-641d82c2-794f-4a95-854f-60c4bcf9ab95-75cd4dfa-1794686400-BTC-o buy 0.0136 hyperliquid:BTC mode=paper origin=agent principal=agent:641d82c2… mandate=4cf57926… state=FILLED filled=0.0136 avg=64728
  orders: ag-641d82c2-794f-4a95-854f-60c4bcf9ab95-75cd4dfa-1794686400-ETH-o buy 1.8341 hyperliquid:ETH mode=paper origin=agent principal=agent:641d82c2… mandate=4cf57926… state=FILLED filled=1.8341 avg=1782.2
  orders: ag-641d82c2-794f-4a95-854f-60c4bcf9ab95-75cd4dfa-1794686400-SOL-o sell 54.1 hyperliquid:SOL mode=paper origin=agent principal=agent:641d82c2… mandate=4cf57926… state=FILLED filled=54.1 avg=70.489
  risk engine: allow (31 checks) for ag-641d82c2-794f-4a95-854f-60c4bcf9ab95-75cd4dfa-1794686400-BTC-o; mandate usage: 3 accepted, notional 7963.43275 USD
GET /api/v1/agents/641d82c2…/performance?mode=paper → {"mode":"paper","label":"PAPER — simulated orders and fills; no money moved","points":1,"totalReturn":{"value":null,"reason":"fewer than two equity points"},"turnover":{"value":0.7965542892291854,"reason":null},"warnings":["small_sample"]}
GET /api/v1/agents/641d82c2…/performance?mode=live → {"mode":"live","points":0,"totalReturn":{"value":null,"reason":"fewer than two equity points"}}
one truth: 3 context row(s) in agent_order_intents (state NULL, signal 1, config v3); "update agent_order_intents set state = 'FILLED'" → refused by constraint agent_order_intents_one_truth
same key again (another body): order ag-641d82c2-794f-4a95-854f-60c4bcf9ab95-75cd4dfa-1794686400-SOL-o answered from the table, idempotent=true, paper engine calls unchanged (3); research-mode order → REJECTED READ_ONLY_MODE; another mandate → REJECTED MANDATE_DENIED; no order created
kill switch engaged by the risk-management agent (agent:2cb44e55…) → /api/v1/risk/state killSwitch.on=true; perp paper order adding risk → unified order REJECTED KILL_SWITCH_ACTIVE; reduce-only → FILLED; spot buy → REJECTED KILL_SWITCH_ACTIVE, spot sale → FILLED; POST /api/v1/agents/kill-switch/release → 404; released with the passkey on /api/v1/risk/kill-switch/release → 200
POST …/pause → paused (no order on the next bar); POST …/stop → stopped
```

## 5. Workers

**Change.** `services/api/test/agent-worker-process.test.ts` — real processes from `dist/` on a per-run database: the
worker refuses to start with the wrong `SPW_WORKERS` (exit 2) and on an unmigrated database (exit 3); the API
(`SPW_WORKERS=api`) says `agent-workers=not in this process`; two workers tick three agents — every tick job is
attempted once, no agent has two tick jobs alive; then a worker is killed (SIGKILL) in the middle of its ticks (made
deterministic by an exclusive lock on `candles`, the tick's first read): while it is blocked a second worker takes
nothing of it; after the kill the jobs are still `running` under the dead worker's name; once the job lock and the lease
have expired (moved into the past by hand: production waits 180 s and 30 s) the second worker reaps and re-runs them
(attempt 2) and goes on ticking. `agent-worker-main.ts`: its own execution layer (item 1) and three optional cadence
settings (`SPW_AGENT_BAR_MS`, `SPW_AGENT_JOBS_MS`, `SPW_AGENT_SUPERVISOR_MS`).

**Result.** Pass (three runs alone after its last change, and inside the full suite). Two earlier runs failed on an assertion of the test itself (the API process had fetched public candles, so a tick answered "waiting for the next bar" where the test expected only "hold: …"); the assertion now accepts both. **Limitation.** The two horizons are shortened by
SQL, not waited for. The deployment (PM2 / mld) is documented in `docs/TRADING-AGENT-ENGINE.md`, not done.

## 6. Web

**Change.** Kill switch card (one switch, release in Risk); mandate sheet (create from the draft, pending / approved
state, link to Risk); two passkey prompts in `PerpAgentLive.tsx`; lab verdicts and v3 sections (item 4).
`tests/e2e/agents-bind.spec.ts` on `scripts/dev-stack.sh`.

**Result.** Pass, in a real browser (Chromium, Pixel 7 profile, French): `1 passed (4.1m)` on a fresh
`scripts/dev-stack.sh` (port 8792, database `spw_dev_agents`). Observed: the Momentum template card with the
laboratory's deflated Sharpe (0,07) → the agent created on `momentum_xs_perp/2` → the backtest through the job queue on
Hyperliquid's public history (about three minutes) → the report with its BACKTEST tag and the v3 sections (gross to
net, engine parity) → paper started, the agent's paper mandate active in `/api/v1/mandates` → within the engine's next
passes a FILLED order, answered with `source: 'orders'` and present in `GET /api/v1/trading/orders?mode=paper` with the
agent principal and its mandate → the timeline with signal, order and fill, the paper performance block → "request
live": the mandate sheet, its link `/risk?mandate=…`, the Risk screen listing the agent's mandate → pause → stop. No page
error. Screenshots: `test-results/shots/agents-bind-01…07.png` (not committed).

What broke on the way and was fixed: the spec's own selectors (twice); the agent's order list answered `gateway` as the
source of unified orders and would have listed a projected spot swap twice (`agent-runtime/store.ts` `agentOrders` now
answers each order from one place); the panel offered a "release" button on a route that no longer exists (now a link to
Risk); `PerpAgentLive.tsx` sent one assertion where a live mandate needs two.

**Limitation.** Journal and signals are still shown through the per-mode timeline (the audit asked for mode separation,
which is done; it did not ask for two lists — the API has both routes).

## 7. Audit items D6, D13, D15

See the status table of `docs/TRADING-AGENTS-AUDIT.md`: D6 fixed for perp (v3 with engine parity required), partly for
spot (default limits, no latency model); D13 and D15 justified, not fixed.

---

## For the execution-gaps workstream

1. **`/risk?mandate=<id>`** — `Risk.tsx` does not read the parameter. Wanted: on load, read `mandate` from
   `location.search`; when it is a mandate id, scroll to `rk-mandate-<id>` and, if its state is `created` or
   `pending_signer`, open its approval sheet; when it is `agent:<agent id>`, offer "create from the agent's draft"
   (`GET /api/v1/agents/<id>/mandate-draft` gives `create: { path, body }`). `pathOf` in `App.tsx` drops the query for
   the risk tab.
2. **`SPW_TRADING_API_EXECUTION` and agents** — `OrderService.place` applies it to every caller: a live agent's new
   risk needs it `on`. If the lock is meant for the trading API only, scope it by `origin` (an agent's orders are
   already behind `SPW_DERIV_MANDATE_MAINNET`).
3. **Gross exposure in a trading mandate** — compiled as capital × leverage with the floor below the capital: an agent
   with gross 1.5 × and a floor at 0.9 × can only be expressed at 1× leverage. A field for the gross bound (or a
   capital that may sit below the floor) would give the agents their leverage back without loosening the signer.
4. **Daily turnover** — compiled as order limit × orders per day: looser than the agents' former max(order, gross × N).
5. **Stream agents** — to become unified orders they need what only the order service can decide: an engine for a
   simulated book (`engine: 'sim'`), a rule for paper simulation on a venue that is market data only for the wallet
   (dYdX, edgeX are refused "for everybody, in any mode"), and a mandate that can name something else than a wallet
   account.
6. **`order.updated` in the worker process** — `agent-worker-main.ts` repeats the listener of `registerExecution`; an
   exported helper would keep the two payloads from drifting.
7. **`agent_orders.reason_code`** (their request §3): not added here — `agents/live.ts` lines are pinned by the
   laboratory's parity file and the column is theirs to read; the wording of `reason` was not changed.
8. `STOP ALL AGENTS`: `execution.agents` is replaced at bind time by `agents/control.ts` (every trading agent through
   `stopAgent`); `orders/agent-control.ts`'s default (`SPOT_NOT_STOPPED…`) is no longer what a bound process answers.

## Not done, and why

| Item | State | Reason |
|---|---|---|
| Stream agents' paper orders as unified orders | not done | they trade a simulated book of their own, on venues the order service refuses in any mode, with no wallet account a mandate could name (point 5 above). They read the one kill switch; their ledger rows are their record |
| Spot agents through `submitCanonical` | not done, by the execution layer's rule | their swaps are unified orders by projection (`orders/spot.ts`); the seam ledger still records the gateway-level state of a spot order next to `agent_orders` |
| `risk_supervisor.propose` as the agent's policy | kept in TypeScript | item 4 |
| D13, D15 | justified | item 7 |
| Renewal of a paper mandate after 90 days without a restart | not done | an agent must not create its own mandate; the owner (or the key) starts paper again |
| Deployment of `sp-wallet-agents` | documented | production is not to be touched |

## Verification, as run

| Check | Result observed |
|---|---|
| `pnpm typecheck` | exit 0 (after the last code change) |
| `pnpm test` (whole suite, once, laboratory virtualenv present, while the browser stack was running) | **173 files, 4 017 tests: 4 012 passed, 5 failed** — `packages/trading-sdk/test/generated.test.ts` (2) and `integration.test.ts` (file) belong to the contract-resync workstream; `api.test.ts › swap: quotes are for the wallet's own addresses` is the known flaky one (17 / 17 alone afterwards); the two others were mine and are fixed (below) |
| the two failures of that run that were mine | `agent-runtime-unit › every read of a table shared by paper and live names the mode` (a new query on `agent_orders` had no mode filter: added) and `agent-workers › STOP ALL AGENTS` (the test deleted agents other tests still referenced: it now isolates its own). Re-run after the fix: `agent-runtime-unit`, `agent-workers`, `agent-migration`, `execution-spot` — 92 passed |
| new and changed suites, alone | `agent-bind` 8, `agent-worker-process` 2 (three runs alone, and in the full suite), `perp-agent-live` 20, `perp-agent` 29, `agent-workers` 24, `agent-runtime-unit` 47, `agent-trading-api` 12, `agent-stream` 16, `agent-migration` 13, `lab-verdicts` 11, `lab-identity`, `execution-*` and `enforcement-pin` (all pass), `apps/web/test` 280 |
| `node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)` | exit 0 — first chunk `index-*.js` **260.61 kB** (80.03 kB gzip), `Agents-*.js` 157.21 kB. The first chunk carries the `ag2*` strings added here (lab verdicts, v3 sections, mandate sheet) on top of the merged Risk strings; no new import in the shell |
| `tests/e2e/agents-bind.spec.ts` on `scripts/dev-stack.sh` | 1 passed (4.1 m) |
| `research/tests/test_v11_engine.py -k parity` | **fails, and already fails on `v11`**: `engine-parity.json` pins `perp-engine.ts:29` for `default(2)`, which the agents V11.1 merge moved to line 32 before this branch. This branch added no line above the pinned ones. The fix is the laboratory's (`engine-parity.json`, which changes the lab's code hash and therefore the committed results' journal) — not done here |

Not verified: a live agent on a real venue (never, by instruction); the migration of an engaged agents-side kill-switch
flag on a real pre-V11.2 database; the PM2 / mld deployment.

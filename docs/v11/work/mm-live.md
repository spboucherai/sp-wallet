# V11 — live market making on Hyperliquid: integration work notes

Branch `v11-mm-live`, from the local branch `v11` (`8b489d7`, "Merge v11-mm-core"). Date: 2026-11-16. Design and as-built:
`docs/V11-MARKET-MAKING.md` (§12 as built, §13 runbook). Foundations: `docs/v11/work/mm-core.md`.

**No order was sent anywhere. No real key, no funded account, no exchange call on mainnet or testnet.** Every proof runs on
the venue double of the test suite (`services/api/test/mm-sim-venue.ts`, a recorded public tape) with the REAL isolated-signer
code in process, and on paper. The only network activity of this work was read-only: one fetch of the venue's public
documentation page on WebSocket subscriptions (shapes of `orderUpdates` and `userFills`). The testnet step of the go-live
checklist is implemented and unit-tested (network selection, its lock) and was NOT run: it is the owner's.

Every live setting is off by default. With the defaults, a market-making agent runs in research and on paper only.

## Verification observed

See "Verification, as run" at the end of this file: commands, exit codes and totals, written after the last code change.

## Files of other workstreams that were touched, and why

| File | Change |
|---|---|
| `services/api/src/db.ts` | one contiguous block `>>> v11 live market making`: `trading_mandates.quoting`, `mm_sessions`, `mm_fills`, `mm_tape`, `deriv_fills.seq` (additive) |
| `services/api/src/mandates/service.ts` | quoting mandates in the SAME service and lifecycle: `quoting` in the creation schema, `quotingSectionHash` in the approval intent, integrity of the section, exclusivity codes, approval / revocation at the signer's quoting endpoints, `recoverQuoting`, `quotingFor`, the supervisor's equity read of a quoting mandate once a minute |
| `services/api/src/orders/index.ts` | `Execution.quotingSigner` and `Execution.live`; `ExecutionOpts.quotingSigner` / `mmLocks` (tests); the route `POST /api/v1/mandates/recover-quoting`; two lock ids in `/risk/state` |
| `services/api/src/orders/provenance.ts` | `fillOrder` (time, stored sequence, fill id) and the attribution of a quoting session's fills to its agent |
| `services/api/src/derivatives/exec.ts` | `LiveService.setStepPacing` (the background reconcile of an account is paced while a session runs on it); nothing else |
| `services/api/src/signer-client.ts` | `venueQuotingApprove`, `venueQuotingSign`, `venueQuotingRevoke`, `venueQuotingMandates` in the status type |
| `services/api/src/agent-runtime/{model,families,stream-engine,scheduler,store}.ts` | family `market_making` gains `live`; `liveVerdict(…, venues)`; `spreadInventoryPolicy` / `quotePolicyOf`; the stream engine passes PAPER and LIVE market-making agents to `MmRuntime` and no longer has a paper branch of its own for them; the stream pass also ticks `LIVE` / `STOPPING` agents and agents with an open session; a lost lease forgets the session; the template's configuration gains `policy`, `asGamma`, `asTauIntervals`, `asKappa`, `maxHalfSpreadBps` |
| `services/api/src/agents/{lifecycle,templates,runtime-bindings,runtime-routes,mandate-write}.ts` | live start / stop of a market-making agent; the `policy` key; the live ports bound from the execution layer; the mandate draft of a market-making agent; one narrowing in `mandate-write.ts` (the approval sheet is now a union) |
| `services/api/src/capabilities.ts`, `services/api/src/server.ts` | `deriv_mm_mainnet`, `deriv_mm_testnet`; `registerMm(app, execution)` |
| `packages/core/src/alert-catalog.ts`, `services/api/src/alerts/rules.ts` | six alert kinds `agent.mm_*` and their rules (one contiguous block each) |
| `packages/trading/src/mandate/quoting-mandate.ts`, `packages/trading/src/mm/breakers.ts` | the quoting section (`SPW-QUOTING-SECTION-v1`), its bounds, hash, validation and enforcement rows; `BREAKER_CODES` as a constant |
| `services/api/src/mm/{engine,ports,live-adapter}.ts` (foundations) | engine: `pull` / `flatten` / `hold` / `funding`, a start-up that does not wait for an arming it cannot get during a wind-down, status fields, fill details in the journal, the session's own fills only; adapter: the testnet lock and the agents' execution switch (`mmOpeningLock`), network selection |
| `services/api/src/mm/sim-venue.ts` → `services/api/test/mm-sim-venue.ts` | MOVED to the tests (it is a venue double, not a paper model) and extended: user-stream events, a weighted request log |
| tests of other workstreams, each an expected consequence | `agent-stream.test.ts` (the paper market-making block rewritten for the session engine; the kill-switch case), `agent-trading-api.test.ts` (seven expectations: modes, live capability, the mandate draft, quotes are not orders, `mandate_required`, the kill switch, the overview), `agent-runtime-unit.test.ts` (two: the family table, `liveVerdict`), `hardening-e.test.ts` (the capability line), `mm-engine.test.ts` (two: the lock tests name the new settings), `mm-harness.ts` (import path) |
| `apps/web/**`, `tests/e2e/mm.spec.ts` | see item 6 |

Not touched: `services/isolated-signer/**` (no signer source change in this branch), `packages/trading-sdk`, `sdk/python`,
`services/api/src/quotes/**`, `apps/web/src/quotes.ts`, the screens Markets / Futures / Compare / PrivateMarkets / Asset /
Home, `research/**`, `services/api/src/agents/{engine,perp-engine}.ts` (the lab's line references are unchanged), the
OpenAPI document (no schema of the trading API changed: the agents routes answer the same shapes; `AgentMode` already had
`live`).

---

## 1. Signer client and mandate lifecycle

**Initial state.** The signer had three quoting routes nothing called. A trading mandate compiled to a derivative mandate
only; quote rates were a loose `QuotingTerms` argument outside any stored, hashed record.

**Change.** `signer-client.ts` (three methods + status type). The quoting section `SPW-QUOTING-SECTION-v1`: a SIBLING record of
the trading mandate (`terms` — signer-enforced, compiled one to one; `engine` — API-only), with canonical bytes, a hash,
compiled bounds and a validation that refuses instead of clamping. Chosen over a new field of `SPW-TRADING-MANDATE-v1`
because that would move the mandate's pinned canonical bytes, mirrored by two SDKs. The API's passkey-bound approval intent
names the trading mandate hash, the section hash and the signer mandate hash. `MandateService`: create (agent of family
`market_making`, live, one Hyperliquid account, one pinned instrument, the section consistent with the agent's
configuration) → `prepareApproval` (the enforced-by table verbatim, the hashes, the acknowledgement, two WebAuthn requests) →
`approve` (the full-hash approval is verified and stored BEFORE the signer is asked) → active → `revoke` at the signer first.
A lost approval answer keeps the row `pending_signer` (`quoting_approval_unknown`) and `recoverQuoting` adopts or revokes.
Exclusivity with a directional mandate, both ways, with `quoting_excludes_directional` / `directional_excludes_quoting`.

**Tests.** `mm-live.test.ts` "the quoting mandate — one lifecycle with the trading mandates" (6): `mandate_required` for the
owner and a key; 25 out-of-bounds or inconsistent values each refused with its code and nothing stored; the sheet (table
rows verbatim, the four hashes, the intent's three hashes, the signer mandate's values), one prompt is not enough, an
assertion over another hash is `bad_approval`; the lost answer → `pending_signer` → adopted; a section altered after the
approval → `mandate_integrity`; exclusivity both ways and the signer's own `signer_conflict`. `packages/trading/test/
quoting-mandate.test.ts` (foundations, 3) unchanged and green.

**Observed.** Pass. **Limitation.** The API-side approval is verified by the API against its own credentials table: it
protects the record against alteration, not against a compromised API (as for every mandate). One instrument per quoting
mandate in the API, although the signer shape allows three: the engine handles one instrument per session.

## 2. Runtime

**Initial state.** `market_making`: research and paper, paper through the order gateway with its own loop in the stream
engine; an engine (`MmEngine`) with injected ports and a simulated venue, wired to nothing.

**Change.** `MmRuntime` (`services/api/src/mm/runtime.ts`): ONE engine for paper and live, ticked by the stream engine under
the agent's lease. ONE rule: `spread_inventory` = `mmQuotes`, behind `QuotePolicy` (`spreadInventoryPolicy`); Avellaneda–Stoikov
selectable (`policy`). ONE paper fill model: the runtime's `mmFills`, in `PaperVenue` — kept because the runtime sees the top
of the book only, the same rows its backtest replays; the foundations' simulated venue (queue + trade-through) became the
tests' venue double. Ports: live `OrderPort` = the adapter over the signer's quoting path; `MarketDataPort` over a small
`BookSource` (the coming quote hub replaces the source); reconcile from `orderUpdates` / `userFills`
(`user-stream.ts`) with REST at start-up, after a gap, on a 60 s audit; the budget (`budget.ts`); `RiskPort` on the unified
risk service and the ONE kill switch; `MandatePort` on the signer's status; `JournalPort` on the agent journal. In LIVE the
rule is wrapped by `withinBand` (found by the first end-to-end run: with an inventory the rule's skew brought one quote
closer than the mandate's minimum and the signer refused it — `quote_too_tight`).

**Tests.** `mm-live.test.ts` "a live session through the runtime" (12, real signer code, venue double, PostgreSQL, the agents
runtime with two workers): start (one worker has the session; first signature = `scheduleCancel`; quotes on their side of the
mid; no manual or directional signature; no order row; a risk decision recorded) · fills on both sides (rows, mid at the
fill, attribution identity, maker fee paid, provenance → the agent) · hard-limit unwind (reduce-only, unified orders through
the state machine, taker fills, back to the soft limit) · kill switch (pulled at once, nothing placed, journal + audit) ·
a lock closed mid-session, then the owner's flatten under the closed lock AND the kill switch, resume, pull · unknown
outcome of a quote batch (reconciled by client id, never sent twice) · user-stream gap (pulled; REST at a bounded rate;
resync; a silently dropped fill found by the audit) · signer down (the venue's switch fires; lapse counted and audited) ·
restart with resting orders (adopt → cancel → arm → quote) · the worker dies (nothing sent; the lease holds others off; the
venue cancels at the deadline; the next worker restarts) · flatten with no worker (never quotes) · wind-down at expiry
(session ends, agent stopped, mandate revoked at the signer, per-mode performance, no fill under two sessions).
`mm-engine.test.ts` (foundations, 39): the engine on the adapter, incl. the four deliberately out-of-mandate policies
stopped by the signer. `agent-stream.test.ts`: paper on recorded mainnet frames through the same engine (9 tests of the
block). `mm-units.test.ts` (14): see items 4 and 5 and the budget below.

**Observed.** Pass (three consecutive runs of `mm-live.test.ts`). **Limitations.** "The worker dies" is simulated by a worker
that stops being called — no process was killed with SIGKILL; `agent-worker-process.test.ts` (another workstream) covers the
separate process and its leases. One instrument per session. The engine's volatility estimate and the rule's window of mids
restart empty with a session. The risk decision of a plan is reused for 30 s per (side, size, inventory lot). The paper
venue withdraws the remainder of a partially filled quote (no queue is modelled).

### The simulated hour's rate-limit budget (measured)

`mm-units.test.ts` "A SIMULATED HOUR": the recorded 36-minute BTC tape played twice (60 minutes; the seam is a price jump of
the recording's two ends), one engine cycle a second, the real signer code and its real venue reader, the stream reconcile,
the budget, plus the live engine's paced reconcile of the account once a minute. Every request the venue double saw is
weighted as the venue documents (info 2 or 20; exchange 1 + ⌊batch / 40⌋):

| | per minute, mean | of the venue's 1 200 |
|---|---|---|
| signer's own reads | 352 | 29 % |
| API REST (audit 42, position reads ≈ 19, `userRateLimit` 10, paced live-engine reconcile 44) | 111 | 9 % |
| exchange | 22 | 2 % |
| **total** | **485** | **40 %** — foundations, REST reconcile every 5 s: ≈ 955 (80 %) |
| **peak minute** | **878** | 73 % — under the engine's ceiling of 900 (`ipReserve` 300) |

492 quote batches, 833 quotes, 800 cancels, 59 fills, 360 heartbeats; address requests 1 193 used of a cap of 11 112; no
switch trigger; no signer refusal; `frontendOpenOrders` read 60 times by the API in the hour (the audits), against 720 with a
5 s REST reconcile. The budget's own estimate of the peak: 890. **What the measure does not contain**: latency; the venue's
real accounting; any other process on the same IP; the risk engine's venue reads (in the live test they go to the other
fake) — in production they are in the same HTTP window the budget reads (`HlHttp.budget.used`).

## 3. Locks

**Initial state.** `SPW_DERIV_MM_MAINNET` in the adapter, on top of the two mainnet locks. `SPW_TRADING_API_EXECUTION` gated
agents' new live risk in the order service only (which quotes do not go through).

**Change.** ONE rule, `mmOpeningLock(network, locks)`: mainnet → `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`,
`SPW_DERIV_MM_MAINNET`, then `SPW_TRADING_API_EXECUTION`; testnet → `SPW_DERIV_MM_TESTNET`, then
`SPW_TRADING_API_EXECUTION`. All default off; only `on` opens. Applied to the mandate (network locks), to the start, and to
every quote; a running session holds its quotes and shows the code; exits pass. `mmNetworkSelection`: the network is the
venue account's — hosts, pinned table and consulted settings follow. Capabilities `deriv_mm_mainnet` / `deriv_mm_testnet`
(summary line, Monitor, `/risk/state`).

**Tests.** `mm-live.test.ts` "each lock off…" (every setting, the default, the exact-value rule, testnet not consulting the
mainnet locks, hosts per network, an unknown network refused, `startAgent` codes); "the owner's PULL and FLATTEN…" (a lock
closed mid-session); `mm-engine.test.ts` (the adapter under each lock); `hardening-e.test.ts` (capability line).

**Observed.** Pass. **Limitation.** The testnet path was not run against the testnet.

## 4. Unified orders and accounting

**Change.** The foundations' recommendation, kept: quotes are not rows. `mm_sessions` (one per session; its `status` is the
engine's live state: quotes resting now, age, distance from the mid), `mm_fills` (one per fill; markouts at 1 / 10 / 60 s
from `mm_tape`), one unified order per reduce-only unwind (`engine: 'none'`, through the order state machine). Signals: the
first batch of a session, then at most one a minute, and each change of the reason quotes are pulled. Per-mode performance:
`mmPerformance` (attribution summed over the mode's sessions + `computePerformance` of the agents on the mode's equity).
Provenance: `fillOrder` and the attribution of a session's fills to its agent.

**Tests.** `mm-units.test.ts`: `markoutFromTape` hand-checked (−2 / −5 / +30 bps, signs mirrored for a sell, a gap = null,
half-even, equal to the engine's in-memory markouts); attribution hand-checked (0.08 + 0.20 − 0.06 = 0.22 = mark-to-market;
with funding −0.01 → 0.21); the tie-break (`fillOrder` total; the reported case — the owner's close and a key's opening sell
in one millisecond — gives the key its short in every row order, and the wrong order gives it nothing). `mm-live.test.ts`:
rows, identity, provenance on the stored fills, unified unwind orders and their events, per-mode figures.

**Observed.** Pass. **Limitations.** The tie-break uses the order in which the WALLET stored the fills, which for fills read
from a venue is the order of the venue's answer, not a venue sequence number. Markouts need the tape of a running session:
a fill whose 60 s horizon falls after the session ended has null markouts beyond the tape. LIVE equity points are
capital + the sessions' attributed PnL (not the venue account's value, which may hold the owner's other positions). Paper
funding uses the last published rate at each interval boundary; none without a ticker.

## 5. Circuit breakers and operations

**Change.** Every breaker of the core runs in both modes with the section's policy; each trip is journaled, kept in the
session and audited (`mm.breaker`) for the alerts (`agent.mm_breaker`, `agent.mm_halted`); also `agent.mm_dead_man_switch`
(a lapse the signer counted), `agent.mm_signer_refusals`, `agent.mm_rate_budget`, `agent.mm_session_ended`. Owner's pull /
flatten / resume: to the engine when it runs in this process, through the session row otherwise, and executed by the API
itself under the agent's lease when no worker runs the session. Session hours, maximum duration (the agent is paused), stop
`stopBeforeExpiryS` before expiry (the agent is stopped, the mandate revoked). The switch's state in the session status:
armed until, lapses today, the venue's 10, the signer's 8.

**Tests.** `mm-live.test.ts` (kill switch + audit, pull / flatten / resume, signer down + lapse audit, flatten with no
worker, expiry); `mm-engine.test.ts` (each of the eleven breakers); `mm-units.test.ts` (session hours);
`packages/core/test/alert-catalog.test.ts` (every catalogued kind is produced, FR and EN).

**Observed.** Pass. **Limitations.** The maximum duration and the hours are judged by the worker's clock. Alert delivery
(push, webhook) of the new kinds was not exercised end to end (the dispatcher's own tests cover the mechanism).

## 6. Web

**Change.** `apps/web/src/mm.ts` (API shapes, pure helpers), `apps/web/src/screens/mmPanel.tsx` (lazy chunk: the session
view per mode, the go-live checklist, the quoting mandate form with each field's compiled maximum, the approval sheet with
the enforced-by table verbatim and the four hashes, the two passkey prompts, start / stop, pull / flatten / resume, the Risk
block), `agentPanel.tsx` (+11 / −2: mounts the section for the family), `Risk.tsx` (+9 / −1: the quoting-mandate block, and
the directional "Review" button skips quoting mandates), `Monitor.tsx` (one line: labels of `deriv_mm_*`), `i18n.ts` (ONE
contiguous block, 228 keys prefixed `mm`, FR and EN, after `ag2`). `Agents.tsx` and `scripts/dev-stack.sh` unchanged.

**Tests.** `apps/web/test/mm.test.ts` (36): checklist order and gating, the evidence shown with its negative figures and the
exact statement required, every form field with its bound and no client-side clamping, refusal codes verbatim, the approval
sheet, PAPER labelled SIMULATED, the switch line "N of the venue's 10; the signer stops at 8", pull / flatten enabled under a
lock and a halt, the i18n block. `tests/e2e/mm.spec.ts` (Playwright, on `scripts/dev-stack.sh` started with
`SPW_MM_MIN_PAPER_MINUTES=1`): the PAPER flow end to end (agent from the template, paper session reaching `quoting` with two
quotes on the stack's public book, pull, stop, past session) and the LIVE flow with every lock off up to where the server
refuses.

**Observed.** 36 / 36; the spec passed once (1.4 min), run by the web workstream of this branch and not repeated after the
last API commit. In the spec, with all locks off: the locks step shows `mainnet_disabled` and `mm_testnet_disabled`; a live
start answers `409 mandate_required`; no approval sheet and no passkey prompt is reachable (the virtual passkey's counter
did not move). First chunk 260.61 kB before and after; `mmPanel` 54.31 kB, lazy.

**Limitations.** (1) On a stack without a venue account, `POST /mandates` answers `404 unknown_account` before any lock code
(the account is resolved first): the spec stubs the accounts list with a non-existent id and asserts that real refusal; the
lock codes are shown from `GET /mm/bounds`. (2) The real approval path (prepare → two prompts → approve), recover, revoke and
a LIVE session view were never driven in a browser: they need a venue account and open locks; rendered-component tests
only. (3) No screen edits the agent's quoting configuration (`policy`, the Avellaneda–Stoikov parameters): the route exists,
the panel creates agents with the template's defaults. (4) A PAPER session shows its SIMULATED dead man's switch as armed
(the paper venue emulates it, so that paper runs the same sequence). (5) Monitor shows the two `deriv_mm_*` lines as off in
the failing colour, unlike the other mainnet locks (a one-line follow-up for the UI pass). (6) `?mandate=<id>` on the Risk
screen is not a route yet.

## 7. Trading API and SDKs

No new operation. `startAgent` live of a market-making agent answers `409 mandate_required`, `409 golive_incomplete`,
`403 mm_mainnet_disabled` / `mm_testnet_disabled` / `execution_disabled` / `mainnet_disabled` /
`mandate_mainnet_disabled`, `409 quoting_config_changed`, `403 mandate_integrity`, `409 live_unavailable` (venue or
instrument). `getAgent` → `mandateDraft.kind: 'quoting'`. `packages/trading-sdk` and `sdk/python` not edited; the OpenAPI
document not regenerated (no schema changed; `trading-api-unit.test.ts`, which asserts the committed document is what the
code generates, passes). Tests: `agent-trading-api.test.ts`, `mm-live.test.ts`.

## 8. Documents

ADR 0001 (seven paths; row 7 written from the foundations' proposal after re-reading `venue-quoting.ts`: the 30 s validity
applies to quote batches and `scheduleCancel`, not to cancels and reductions — corrected), the threat model (rows 23–25, row
19), `TRADING-MANDATES.md` ("Quoting mandates"), `V11-RISK-MODEL.md` ("Quoting sessions"), `V11-SECURITY-REVIEW.md` ("Live
market making"), `V11-MARKET-MAKING.md` (status, §12, §13), `runbooks/deploy.md`, `TRADING-AGENT-ENGINE.md`.

---

## What a human must review

1. **The signer**: the nine behaviour changes of `docs/v11/work/mm-core.md` §2 (unchanged by this branch, now reachable),
   and ADR 0001 row 7 against `venue-quoting.ts`.
2. **The API behaviour changes** listed in `docs/V11-SECURITY-REVIEW.md`, "Live market making" (eleven).
3. `withinBand`, `MmRuntime.emergency`, the 30 s reuse of a risk decision, the budget's estimate of the signer's requests.
4. `mandates/service.ts`: that a quoting mandate cannot reach the signer without the stored, verified full-hash approval;
   `recoverQuoting` (adoption only with the same hash AND a stored approval that verifies; everything else is revoked).
5. The paper change: quotes are no longer gateway orders; prices are on the venue's grid.
6. The tests of other workstreams that were rewritten (table above).
7. Whether the signer should cache its leverage read (it would lower the dominant line of the budget; not done: it is a
   signer behaviour change).

## Not done, and why

| Item | Why |
|---|---|
| Any run on testnet or mainnet | forbidden by the brief; it is the owner's step |
| A real SIGKILL of a worker process in the market-making test | simulated by a worker that stops being called; the process-level lease test exists elsewhere |
| Several instruments in one session / one mandate | the engine handles one; the signer shape allows three |
| `modify` / `batchModify`, priority fees, `reserveRequestWeight` | as the foundations decided |
| A signer-side cache of the leverage read | a signer behaviour change; listed for decision |
| Recorded `orderUpdates` frames | need an account that trades; the documented shape is used |
| OpenAPI / SDK changes | none needed; a resync follows |

## Owner decisions still required before any live session

1. Capital on the venue account, and the floor; the instrument (BTC to start); quote size (≥ 10 USD), levels (one),
   soft / hard inventory, the band, the rates, `deadManSeconds` (30 s keeps the venue's cancel inside a worker's lease),
   session hours and maximum duration, the session loss limit, the policy per breaker, `flattenOnStop`.
2. The written acceptance that the evidence is negative (lab study and simulation), at a maker fee of 1.5 bps paid — the
   checklist records it.
3. The jurisdiction acknowledgement for Hyperliquid (recorded again in the mandate's hash).
4. Running the testnet step himself, and what he observed (the six verifications).
5. Which settings are on, in which process: `SPW_DERIV_MM_TESTNET`, then `SPW_DERIV_MM_MAINNET` with the three others.
6. After review: whether the signer's leverage read may be cached, and whether 30 minutes of paper is the right minimum.

## Verification, as run (after the last code change)

| Check | Result observed |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` (whole suite, laboratory virtualenv present) | **182 files, 4 342 tests, all passed**, 96 s (baseline `v11`: 179 files / 4 272). The run before the web files landed: 181 files, 8 failures, all caused by this branch and fixed (2 in `alert-catalog.test.ts`: the new kinds were outside the catalogued namespaces and used a dash the renderer reserves; 6 in `agent-trading-api.test.ts`: expectations of the old paper path) |
| new or rewritten tests of this branch | `mm-live.test.ts` 20 · `mm-units.test.ts` 14 · `apps/web/test/mm.test.ts` 36 · `agent-stream.test.ts` (10 of 16 rewritten) · changed expectations in `agent-trading-api`, `agent-runtime-unit`, `hardening-e`, `mm-engine` |
| `mm-live.test.ts` alone, three times in a row | 20 passed each time |
| `node scripts/build.mjs` | exit 0 |
| `(cd apps/web && node_modules/.bin/vite build)` | first chunk `index-*.js` **260.61 kB** (unchanged); `Agents-*.js` 157.86 kB; `mmPanel-*.js` 54.31 kB (lazy) |
| `cd research && .venv/bin/python -m pytest tests -q` | exit 0, no failure (`engine-parity.json` untouched: `agents/engine.ts` and `perp-engine.ts` were not edited) |
| Playwright `tests/e2e/mm.spec.ts` | 1 passed, once (see item 6) |
| by hand | nothing: no process of this branch was started against a venue |

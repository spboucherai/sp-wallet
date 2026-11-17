# SP Wallet V11 — architecture as built

State described: sections 1–8 were written on 2026-11-15 for branch `v11` at `fa48015` (114 commits after `a118e3e`, the
V10 commit in production) from the work notes in `docs/v11/work/`, the module documents and the code. Sections 9 and 10
were written on 2026-11-17 for branch `v11-final` (from `v11` at `9561d78`), once the two workstreams that were open —
the market-making integration (`v11-mm-live`) and the final interface pass (`v11-ui`) — had been merged; the passages
of sections 1–8 that those merges changed are corrected in place and dated. **V11 is not deployed.** Nothing in this
document was observed on a production node.

Companion documents: `V11-REMAINING-LIMITATIONS.md` (what is not done), `V11-DEPLOYMENT.md` (the plan),
`V11-TEST-RESULTS.md` and `TRADING-TEST-RESULTS.md` (the evidence), `TRADING-PRODUCTION-READINESS.md` (what can be enabled,
and in which order).

---

## 1. Components

```
 browser (PWA, passkey)                      API clients (SDK TypeScript / Python, curl)
   │  HTTPS + session cookie                    │  HTTPS + Bearer spw_live_<id>_<secret>
   │  WSS  /api/v1/stream                       │  WSS  /api/v1/trading/stream (key or ticket)
   ▼                                            ▼
 ┌───────────────────────────────────────── API process (dist/api.mjs, Fastify) ───────────────────────────────────────┐
 │ onRequest: session │ apiKeyGate → principal → scopeGuard (default deny outside /api/v1/trading)                      │
 │                                                                                                                      │
 │  wallet routes (V10)        trading API gateway          key management /developer (owner session + passkey)         │
 │  transfers, swaps,          /api/v1/trading/*            webhooks (signed, retried)                                  │
 │  bridges, plans             41 operations, OpenAPI 3.1                                                               │
 │                                                                                                                      │
 │  market data ─ DerivData (per-venue budget, last-good) ─ markets hub (explorer, comparator) ─ private markets        │
 │  quote hub (in-process; one upstream feed per venue|kind|symbol) ─ websocket server (conflation, backpressure)       │
 │                                                                                                                      │
 │  order service ── risk service ── mandate service         (services/api/src/{orders,risk,mandates})                  │
 │     │  one `orders` table, transition() only                 limits, kill switch, read-only, decisions               │
 │     │  projection of the engines' rows (DB triggers)         trading mandates, usage, stop conditions                │
 │     ▼                                                                                                                │
 │  venue engines (V10, kept): Hyperliquid live (exec.ts) · GMX v2 (gmx-exec.ts) · paper · swap proposal flow           │
 │                                                                                                                      │
 │  agents runtime: leases, job queue, scheduler · bar engines (spot, perp) · stream engine · risk supervisor           │
 │  strategy lab bridge (sandboxed Python, research/) · research jobs                                                   │
 │  market-making runtime (services/api/src/mm) — ONE engine for paper and live, ticked by the stream engine (§9)       │
 └──────────────┬───────────────────────────────────────────────────────────────────────────────┬────────────────────────┘
                │ HMAC over every request, one shared secret                                    │ public endpoints
                ▼                                                                               ▼
   signer relay (root LaunchDaemon on the API node, 127.0.0.1:8652 → signer:8651)        venues and chains
                ▼                                                                         Hyperliquid, GMX v2 (Arbitrum),
   isolated signer (dist/signer.mjs, own node) — keystore, state.json, journal*.jsonl,    dYdX, edgeX (data only),
   policy.json, control.sock; own outbound reads: Coinbase + Kraken prices,               Coinbase ticker, CoinGecko,
   Hyperliquid /info, THORNode                                                            RPC endpoints, swap providers
```

Optional second process `dist/agents.mjs` (`SPW_WORKERS=agents`): the agents runtime alone, no HTTP, with its own
execution layer bound to the same database (`docs/TRADING-AGENT-ENGINE.md` §4). Default is in-process (`SPW_WORKERS=on`).

Research runner (`dist/research-runner.mjs`, own node): unchanged in role; authenticates with
`SPW_RESEARCH_RUNNER_SECRET`.

---

## 2. The security architecture that was preserved

V10's chain is unchanged: **passkey → canonical intent → signer**. The API drafts, the passkey signs the SHA-256 of a
canonical object, the signer verifies the assertion against the passkey it pinned, re-checks its own policy and rebuilds
or decodes what it signs (`README.md`, `docs/adr/0001-custody.md`).

What the ADR now states plainly (rewritten in V11 Phase B, `docs/v11/work/stab-signer.md` §11): the signer cannot tell the
owner from an agent or a key — one HMAC secret authenticates the whole API — so the custody statement is the list of
what the signer signs **without** a per-operation passkey, and what bounds each.

### 2.1 Signer paths without a per-operation passkey

| # | Signer route | Standing authority | Since |
|---|---|---|---|
| 1 | `POST /mandate/sign` — swap inside an agent vault | spot mandate (passkey) | V10 |
| 2 | `POST /mandate/return` — vault → owner's own address | mandate record | V10 |
| 3 | `POST /vault/return` — same, no mandate / other EVM network | none | V10 |
| 4 | `POST /venue/sign` — a **cancel** on Hyperliquid | venue authorization (passkey) | V10 |
| 5 | `POST /venue/mandate/sign` — order, cancel, leverage change for an automated strategy | derivative mandate (passkey) | V10 |
| 6 | `POST /bridge/mint` — first `receiveMessage` of an approved bridge | the approved burn | V10 |
| 7 | `POST /venue/quoting/sign` — batch of post-only quotes, reduce-only batch, cancel batch, `scheduleCancel` | quoting mandate `SPW-VENUE-QUOTING-MANDATE-v1` (passkey) | **V11**, merged with `v11-mm-core`; *(2026-11-17)* called by the API's live market-making adapter since `v11-mm-live`, behind four locks and the mandate (§9) |

*(Corrected 2026-11-17.)* `docs/adr/0001-custody.md` now says "exactly seven paths" and carries row 7 (edited by
`v11-mm-live`, after re-reading `venue-quoting.ts`: the 30 s validity applies to quote batches and `scheduleCancel`, not
to cancels and reductions). The threat model has rows 23–25 for the quoting shape.

### 2.2 Where V11 added paths, exactly

| Addition | Where enforced | Signer changed? | Source |
|---|---|---|---|
| API keys (`spw_live_…`), scopes, default-deny guard | API | no | `docs/TRADING-API-SECURITY.md`, `work/trading-api.md` |
| Execution by a key under a **trading mandate** (`SPW-TRADING-MANDATE-v1`), compiled to the existing derivative mandate | signer for the compiled subset; API for the rest | no (`work/exec.md`, `work/exec2.md`: "No file of `services/isolated-signer` was changed") | `docs/TRADING-MANDATES.md` |
| Second passkey assertion over the full trading-mandate hash (`SPW-TRADING-MANDATE-APPROVAL-v1`) | API (`verifyStoredAssertion`), re-verified at every load | no | `work/exec2.md` §2 |
| Unified risk engine, kill switch, read-only mode | API; release with a passkey verified by the API | no | `docs/V11-RISK-MODEL.md` |
| Passkey to loosen API-side limits or lift an API-side halt (`SPW-RISK-INTENT-v1`, `SPW-GMX-RISK-INTENT-v1`, `SPW-RISK-LIMITS-INTENT-v1`) | API | no | `work/stab-signer.md` §8, §9 |
| Under halt: reduce-only Hyperliquid order, GMX decrease, GMX cancellation are signed (with passkey) | signer | **yes** | `work/stab-signer.md` §1 |
| Reduce-only trigger orders may rest outside the price band (protective side only) | signer + API pre-check | **yes** | `work/stab-signer.md` §7 |
| `POST /venue/authorization` returns a stored `approveAgent` signature again | signer | **yes** | `work/stab-signer.md` §5 |
| One active spot mandate per vault; revocation called on every stop | signer (refusal) + API (caller) | **yes** (stricter) | `work/stab-signer.md` §3 |
| Kraken must report `online` for any priced signature | signer | **yes** (stricter) | `work/stab-signer.md` §10 |
| State lock, control socket, journal file | signer | **yes** (on-disk format) | `work/stab-signer.md` §6 |
| Quoting mandate: approve / sign / revoke; `orderStatus` outbound read | signer | **yes** | `work/mm-core.md` §2 |

What still holds if the API process is compromised is only what the signer enforces: the passkey per manual order, the
derivative mandate, the spot mandate, the GMX policy, `policy.json` (`docs/V11-SECURITY-REVIEW.md`, "A compromised API
process"). The kill switch, the risk limits, the API-only fields of a trading mandate, position provenance and every lock
are enforced by the process that would be compromised.

---

## 3. Principals

| Principal | Authenticates with | Can | Bounded by |
|---|---|---|---|
| **Owner** | passkey session cookie | everything; manual orders each need a passkey at the signer | signer policy; own risk limits (live: seeded once from V10, six limits to set); kill switch (engaging is free, releasing needs the passkey) |
| **API key** | `Authorization: Bearer`, HMAC-SHA-256 under a pepper outside the database | read by scope; paper orders; live orders only with a bound, approved trading mandate and `SPW_TRADING_API_EXECUTION=on`; engage the kill switch (`positions:manage`); create and run agents in research / paper (`agents:manage`, `strategies:manage`) | closed scope list (12); restrictions (venues, instruments, networks, source addresses); per-key rate limit and notional limits (`orders/service.ts` `keyLimits`); expiry ≤ 365 days; the mandate; position provenance (closes only its own lot); never reaches a route outside `/api/v1/trading`; never spot, never GMX, never a mandate or a limit |
| **Agent** | none (internal principal `agent:<id>`) | orders through `orders.submitCanonical` (perp), the seam gateway (spot, stream) | paper: a paper trading mandate created at paper start; live: a trading mandate approved by the owner (two passkey prompts) compiled to the signer's derivative mandate; provenance; the one kill switch; cannot release it (`agent-runtime-unit.test.ts`) |

One principal per live venue account: a second mandate holder is refused with 409 `account_has_active_mandate`
(`work/exec2.md` §3).

---

## 4. Order life cycle

One table (`orders`), one writer (`orders/store.ts`), one function that may change a state (`transition()` of
`@spw/trading`); `order_events` is the append-only history (`docs/V11-EXECUTION-ENGINE.md` §2, §8).

```
 request (HTTP order, command, agent signal, or a row written by an engine through a pre-V11 route)
   │
   ├─ boundary: principal from authentication; mandate id from the key row; instrument resolved; notional → size
   ├─ refusals before anything exists: lock (execution_disabled), key limits, mandate check, provenance      → 4xx, no order
   ▼
 CREATED → VALIDATED ──(risk.evaluate: allow)──► APPROVED            owner live order: AWAITING_APPROVAL (passkey) → APPROVED
              └──────(deny)──► REJECTED (stored, with its decision)
 APPROVED → SUBMITTING   the engine stores its own row first, then asks the signer, then the venue
 SUBMITTING → SUBMITTED → PARTIALLY_FILLED → FILLED
            → CANCELLED (by request, by expiry) · REJECTED (venue) · FAILED (never placed, internal)
            → UNKNOWN   ambiguous submission: never sent again under that key; the reconciler looks the order up by client id;
                        FAILED/NEVER_PLACED only once the signed request can no longer be accepted
```

- **Idempotency**: (principal, `Idempotency-Key`) and (principal, `clientOrderId`) answer the stored order; another body
  is `idempotency_conflict`; a replay sends nothing to the signer or the venue.
- **Projection**: triggers on `deriv_orders`, `deriv_gmx_ops`, `proposals` (swaps) and `agent_orders` queue every change
  in `order_projection_queue`; `projection.ts` turns engine rows into events. Orders placed through the Futures screen or
  the Swap screen are therefore unified orders too.
- **Reconciler and supervisor** (the `orders` loop, API process only): settles UNKNOWN orders, applies mandate stop
  conditions, places attached SL/TP after the parent fills, runs the automatic kill.
- **Exits are never blocked** by a lock, the kill switch or the signer halt: cancels and strictly reducing orders pass
  (read-only mode lets only cancels pass).
- Every transition emits the webhook `order.updated`.

---

## 5. Modes

| Mode | What executes | Data |
|---|---|---|
| research | nothing; an order attempt is `REJECTED / READ_ONLY_MODE`; signals and journal are recorded | real market data |
| paper | the paper engine against the venue's public book; stream agents against their simulated book; no signer, no funds | real market data |
| live | the venue engines through the signer | real market data, real venue account |

Structural separation (`work/agents.md` §2): every table shared by paper and live carries the mode (`agent_signals` in
its key, `research_log.mode`, `agent_order_intents.mode`, `agent_orders.mode`); every read function takes one mode; the
trading API refuses `mode=all`; paper and live risk contexts are separate books (`paper`, `live-mainnet`,
`live-testnet`).

---

## 6. Data model added since `a118e3e`

`git diff a118e3e v11 -- services/api/src/db.ts` removes no line: every change is `create … if not exists`,
`add column if not exists`, `create or replace function`, `drop trigger if exists` + `create trigger`, or a guarded
data fix.

| Module | Tables (new) | Columns added to existing tables | Functions / triggers |
|---|---|---|---|
| Stabilisation | — | `proposals.error_code`, `error_params`, `request_hash`, `quote_ref` | data fix: rows in `broadcast` with the text `broadcast disabled…` become `not_broadcast` |
| Trading API | `api_keys`, `api_key_usage`, `api_key_intents`, `api_idempotency`, `api_webhooks`, `api_webhook_deliveries` | — | — |
| Execution | `orders`, `order_events`, `order_projection_queue`, `risk_decisions`, `trading_mandates`, `trading_mandate_usage`, `order_attachments` | `trading_mandates.approval` | `spw_append_only` (`order_events_append_only`); queue triggers `deriv_orders_projection`, `deriv_gmx_ops_projection`, `proposals_swap_projection`, `agent_orders_projection`; **`agent_orders_gate`** (BEFORE INSERT: refuses a spot agent's buy under the kill switch, everything in read-only mode) |
| Agents runtime | `agent_config_versions`, `agent_signals`, `agent_order_intents`, `agent_leases`, `agent_jobs`, `market_snapshots`, `market_snapshot_gaps` | `agents.family`, `template`, `engine`, `config_version`, `runtime`; `strategy_versions.approved_by`; `research_log.mode`, `severity`, `code`, `config_version`, `ref`; `agent_orders.config_version`, `signal_id`, `strategy_sha256`, `client_order_id` | `spw_agent_mode_at` (backfill of modes from the audit chain); `research_log_defaults` trigger; constraint `agent_order_intents_one_truth`; backfills (`agents.family`, config version 1, `agent_signals` from `perp_agent_signals`); migration of `settings['agents.kill_switch']` into `risk.switches`, then deletion of the key |

State kept in `settings` (no schema): `risk.switches`, `risk.limits.live`, `risk.limits.paper`, `risk.limits.live.seed`,
`deriv.gmx.risk`, `deriv.live.submitted.<account>`, `signerAddresses`.

State outside the database: `trading-api-secrets.json` (API-key pepper and webhook signing secrets, mode 0600, in
`SPW_DATA_DIR` or `~/.config/sp-wallet`); on the signer, `journal.jsonl` and its closed segments, `state.json.lock`,
`control.sock`, and the optional fields `venueQuotingMandates` and `VenuePendingOrder.q` inside `state.json`.

---

## 7. What runs where

| Process | Bundle | Today in production (V10, `a118e3e`) | After a V11 deployment (planned, not done) |
|---|---|---|---|
| API + web | `dist/api.mjs`, `dist/web/` | API node, PM2 `sp-wallet`, port 8650, database `sp_wallet` | same node and process; additionally serves the websocket, the trading API, the Risk / Developer / Markets / Private Markets / Agents screens |
| Agents worker (optional) | `dist/agents.mjs` | does not exist | not started by default; optional PM2 process `sp-wallet-agents` on the API node |
| Isolated signer | `dist/signer.mjs` (copied as one file) | signer node, PM2 `sp-wallet-signer`, port 8651, LAN, API node IP only | same; new bundle (+1.6 % with the quoting code), new files in the data directory |
| Signer relay | `scripts/signer-relay.mjs` | root LaunchDaemon on the API node, `127.0.0.1:8652` → signer | unchanged |
| Research runner | `dist/research-runner.mjs` | research node | unchanged unless `services/research-runner` or `research/` changed (the lab changed: `research/` has the V11 engine and strategies) |

Node names: the API is on M2M32c and the signer on m6ma (`docs/V2-IMPLEMENTATION-STATUS.md`; the relay target
`m6ma.local:8651` is in `docs/runbooks/operations.md`). The research runner's node (M5M36) is given by the deployment
brief of this delivery; no document of the repository names it. Authoritative placement: `mld status`.

---

## 8. Module map

| Module | Code | Read |
|---|---|---|
| Custody and signer | `services/isolated-signer`, `packages/core` | `docs/adr/0001-custody.md`, `docs/threat-model/threat-model.md`, `work/stab-signer.md` |
| Swaps, bridges, plans | `packages/swap`, `services/api/src/{swap*,bridge*,xswap*,plan*}` | `work/stab-swaps.md`, `docs/v11/audit-parts/web-api-swaps.md` |
| Venues (read side), edgeX | `packages/derivatives/src/venues` | `docs/V11-EXCHANGE-INTEGRATIONS.md`, `work/edgex.md`, `docs/v4/venues/jurisdiction.md` |
| Markets hub and comparator | `services/api/src/markets-hub`, `packages/trading/src/compare` | `docs/V11-EXCHANGE-INTEGRATIONS.md` (Comparator), `work/markets-compare.md` |
| Private markets | `services/api/src/private-markets`, `…/hyperliquid/builder.ts` | `docs/V11-SYNTHETIC-MARKETS.md`, `work/private-markets.md`, `docs/v11/research/private-markets.md` |
| Quote engine | `services/api/src/quotes`, `apps/web/src/quotes*.ts(x)` | `docs/V11-QUOTE-ENGINE.md`, `work/quotes.md` |
| Deterministic trading core | `packages/trading` (`@spw/trading`) | `docs/V11-EXECUTION-ENGINE.md` §1–7, `docs/V11-RISK-MODEL.md`, `docs/TRADING-MANDATES.md` |
| Order, risk, mandate services | `services/api/src/{orders,risk,mandates}` | `docs/V11-EXECUTION-ENGINE.md` §8, `docs/TRADING-RISK-ENGINE.md`, `work/exec.md`, `work/exec2.md` |
| Trading API | `services/api/src/trading-api` | `docs/TRADING-API-ARCHITECTURE.md`, `docs/TRADING-API-SECURITY.md`, `docs/TRADING-API-OPENAPI.md`, `work/trading-api.md`, `work/contract-resync.md` |
| SDKs | `packages/trading-sdk`, `sdk/python` | `docs/sdk/typescript.md`, `docs/sdk/python.md`, `work/sdks.md`, `work/contract-resync.md` |
| Agents runtime | `services/api/src/{agent-runtime,agents}` | `docs/TRADING-AGENT-ENGINE.md`, `docs/TRADING-AGENTS-AUDIT.md` §10, `work/agents.md`, `work/agents-bind.md`, `work/exec2-notes-agents.md` |
| Strategy lab | `research/` | `docs/TRADING-BACKTESTING.md`, `work/quant-lab.md` |
| Market making | `packages/trading/src/mm`, `services/api/src/mm`, `services/isolated-signer/src/venue-quoting.ts`, `packages/derivatives/src/live/quoting.ts` | `docs/V11-MARKET-MAKING.md`, `work/mm-core.md` |
| Security review | — | `docs/V11-SECURITY-REVIEW.md` |
| Audit of V10 | — | `docs/V11-AUDIT.md`, `docs/v11/audit-parts/*.md` |

*(2026-11-17.)* Three documents contained passages that later merges had made stale — `docs/TRADING-AGENT-ENGINE.md`
§11, `docs/TRADING-API-SECURITY.md` §5, `docs/V11-QUOTE-ENGINE.md` §13 last bullet — and so did the D1 row of
`docs/TRADING-AGENTS-AUDIT.md` and one row of `docs/security/acceptance.md`. Each was corrected in place with its date
during the final validation; `docs/v11/work/quotes.md` got a dated note instead (a work note is history). Where an older
work note still disagrees with a later one, `V11-REMAINING-LIMITATIONS.md` §14 says which is current.

---

## 9. Market making — as integrated (`v11-mm-live`, 2026-11-16)

Design and runbook: `docs/V11-MARKET-MAKING.md` §12–§13. Work note: `docs/v11/work/mm-live.md`. **No quote was ever sent to
a venue, mainnet or testnet; the testnet step is implemented and was never run.** Every proof is on the test suite's venue
double with the real signer code in process, on a recorded public tape, and on paper.

```
 Agents panel (mmPanel, lazy chunk) ── /api/v1/mm/* (owner) ── go-live checklist, session view, pull / flatten / resume
        │                                         │
        │                                         ▼
        │                 MandateService (the SAME service as every trading mandate)
        │                   quoting section SPW-QUOTING-SECTION-v1 — a sibling record of the trading mandate:
        │                   terms (signer-enforced, compiled one to one) + engine (API-only); own canonical bytes and hash;
        │                   approval intent = trading-mandate hash + section hash + signer-mandate hash, two passkey prompts
        ▼                                         │ approve / revoke / recover
 agents runtime ── stream engine (lease per agent) ──▶ MmRuntime.tick() ──▶ MmEngine (ONE engine, two modes)
                                                          │                    │
                                 PAPER: PaperVenue (real books, simulated      │ LIVE: live adapter ── signer-client
                                 account, the runtime's own fill model)        │   venueQuotingSign ──▶ signer POST /venue/quoting/sign
                                                                                │   (path 7) ──▶ Hyperliquid, one pinned instrument
   ports: MarketDataPort over a BookSource (the stream engine's market state on mainnet, the testnet client's l2Book)
          reconcile by the venue's user streams (orderUpdates, userFills); REST at start, after a gap, every 60 s
          RiskPort = the unified risk service and the ONE kill switch (read at every cycle → quotes pulled)
          MandatePort = the signer's own status of the mandate · JournalPort = the agent journal, mm_fills, audit events
```

| Piece | Where | What it is |
|---|---|---|
| Signer client | `services/api/src/signer-client.ts` | `venueQuotingApprove`, `venueQuotingSign`, `venueQuotingRevoke`; `venueQuotingMandates` in the status type. **No signer source file was changed by the integration** |
| Mandate | `services/api/src/mandates/service.ts`, `packages/trading/src/mandate/quoting-mandate.ts`, column `trading_mandates.quoting` | creation (one Hyperliquid account, one pinned instrument, the section consistent with the agent's configuration), `prepareApproval`, `approve` (the full-hash approval verified and stored BEFORE the signer is asked), `revoke` at the signer first, `recoverQuoting` (route `POST /api/v1/mandates/recover-quoting`); exclusivity with a directional mandate both ways |
| Runtime | `services/api/src/mm/{runtime,engine,ports,live-adapter,paper-venue,market-data,user-stream,budget,sessions,lifecycle,bind,register,routes}.ts`; `agent-runtime/{model,families,stream-engine,scheduler,store}.ts` | family `market_making` gains the `live` mode; the stream engine hands PAPER and LIVE agents to `MmRuntime` under the agent's lease; one quoting rule (`spread_inventory` = `mmQuotes` behind `QuotePolicy`, Avellaneda–Stoikov selectable), wrapped by `withinBand` in live |
| Market data | `mm/market-data.ts` | `MarketDataPort` over a small `BookSource`. **The quote hub of §7 is NOT its source yet**: the engine reads the stream engine's own market state (the note calls the hub "the coming" source) |
| Risk | `mm/bind.ts`, the unified risk service | each plan is evaluated as a preview on the worst case of each side, reused for 30 s; the kill switch pulls quotes at once; reductions pass |
| Accounting | tables `mm_sessions`, `mm_fills`, `mm_tape`; column `deriv_fills.seq`; `orders/provenance.ts` | **quotes are not rows of `orders`**; one session row with the engine's live status; one row per fill with 1 s / 10 s / 60 s markouts from the tape; each reduce-only unwind is one unified order (`engine: 'none'`); a session's fills are attributed to its agent |
| Locks | `mm/live-adapter.ts` `mmOpeningLock`; `capabilities.ts` | mainnet: `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_MM_MAINNET`, `SPW_TRADING_API_EXECUTION`; testnet: `SPW_DERIV_MM_TESTNET`, `SPW_TRADING_API_EXECUTION`. All off by default; applied to the mandate, to the start and to every quote; exits pass. Capability ids `deriv_mm_mainnet`, `deriv_mm_testnet` in the start-up line |
| Operations | `mm/routes.ts`, six alert kinds `agent.mm_*` | the eleven circuit breakers in both modes; the owner's pull / flatten / resume, executed by the API under the agent's lease when no worker runs the session; session hours, maximum duration, stop before the mandate's expiry |
| Runbook | `docs/runbooks/deploy.md` "Market making (V11)", "Signer state added by V11 market making, and the rollback rule" | the same lock values in every process that runs agent workers; restart with a session running; the rollback rule (demonstrated on 2026-11-17, `V11-DEPLOYMENT.md` §9.3) |

Measured in the suite (a simulated hour on the recorded tape, the real signer code): 485 of the venue's 1 200 weight units
a minute on average, 878 in the peak minute — of which 352 are the signer's own reads. It contains no latency, no real
venue accounting and no other process on the same address.

What is not there: several instruments per session; `modify` / `batchModify`; a recorded `orderUpdates` frame (the
documented shape is used); a screen that edits the quoting configuration; the approval, recovery, revocation and live
session view driven in a browser (they need a venue account and open locks). The evidence for the strategy itself is
negative (`V11-REMAINING-LIMITATIONS.md` §0).

## 10. Interface — final pass (`v11-ui`, 2026-11-15/16)

Design note: `docs/v11/UI-ARCHITECTURE.md`. Work note: `docs/v11/work/ui.md`. The V10 design system is kept (the
components of `ui.tsx`, no new library, no new colour token).

| Area | What changed | Server side |
|---|---|---|
| Shell | five areas on the tab bar and in the sidebar — Home · Markets · Trade · Agents · Activity; sub-views under the header (Markets = Explorer · Compare · Private markets; Trade = Spot · Futures); a header menu for Receive, Send, Risk, Alerts, Settings, Security, Developer / API, System status, Research, Lock; **a risk indicator on every screen** (kill switch, read-only, live limits not set, ok, unknown); new paths `/trade`, `/dashboard`, `/compare`, `/spot`, `/perps`, `/api`, `/system`, `/risk?mandate=<id>` — every previous path still opens its screen | `GET /api/v1/dashboard/status` |
| Dashboard (under the wallet on Home) | accounts, positions, P&L, risk, agents, system, price freshness: one block per book (paper, live, live testnet), no figure spans two modes; each section fails alone | `GET /api/v1/dashboard/summary` (`services/api/src/dashboard/summary.ts`): composes the risk service, the agents table, the monitor |
| Trade | the picker is fed by the markets hub and says why a market cannot be traded live; the confirmation and approval sheets show the answer of `POST /trading/orders/preview` for that exact order; a unified blotter (two lists, Réel and Simulation, never added; the twelve states in words); a command line on `POST /trading/commands` (dry run first) | existing routes |
| Activity | one timeline from five sources (wallet activity and plans, unified orders, risk denials, the audit chain), server-side filters, cursor pagination, a CSV with a `mode` column | `GET /api/v1/dashboard/activity`, `/activity.csv` (`dashboard/activity.ts`) |
| Audit leftovers | server sentences translated by code or by known wording, otherwise shown as a marked quotation; the mandate deep link on Risk; GMX rows labelled as GMX; development mocks for the V11 reads | — |

Exercised in a browser (Chromium; phone 390 × 844 and desktop 1280 × 900, French and English, light — the Dashboard also in
dark): the six `v11-*` specs, 52 tests, on one real local stack (real API, real signer, virtual passkey, paper only), and
the existing specs adapted to the navigation. The runs of the final validation, spec by spec, are in
`V11-TEST-RESULTS.md` §6. **Not exercised in any browser:** the live paths of Trade (no venue account on a local stack);
Safari and iOS, for anything.

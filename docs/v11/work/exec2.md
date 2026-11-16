# V11 exec2 — closing the gaps left by Phase F (execution, risk, mandates)

Branch `v11-exec2`, from `v11` (`8618bdf`). Backlog: the "Not done or partial" and "Needs human security review"
lists of `docs/v11/work/exec.md`. Scope: `services/api/src/{orders,risk,mandates}/`,
`services/api/src/trading-api/commands.ts` and the order handlers of `routes.ts`, the Risk screen, the documents.
`packages/trading` was touched for the enforcement notes of the mandate compiler and for the paper vocabulary.
**No file of `services/isolated-signer` was changed.** Nothing was sent to a real venue and no real key was
used: fixture venues, the scripted Hyperliquid and the scripted Arbitrum chain of the test suites, the paper
engine, the real signer class in process with the public BIP-39 test mnemonic. The Playwright run used the
local dev stack (paper only; the paper engine reads the venue's public market data).

Read in full before any change, this time: `exec.md`, `V11-AUDIT.md`, `adr/0001-custody.md`,
`threat-model.md`, `v6/DERIVATIVE-MANDATE.md`, `v4/venues/jurisdiction.md`, `stab-signer.md`, and the signer
sources `venue.ts`, `venue-mandate.ts`, `venue-gmx.ts`, `venue-collateral.ts`, `signer.ts`, `server.ts`,
`store.ts`, `prices.ts`, with `live/canonical.ts`, `live/mandate.ts`, `core/policy.ts`, `core/mandate.ts`,
`core/intent.ts`; then `orders/`, `risk/`, `mandates/`, `trading-api/{commands,routes,principal}.ts`, `gate.ts`,
`swap.ts`, `swap-exec.ts`, `exec-status.ts`. **Not read in full:** `derivatives/exec.ts` (1 522 lines),
`gmx-exec.ts`, `paper.ts`, `collateral.ts`, `live-routes.ts`, `transfers.ts` — their gate hooks, method lists
and the passages each change touches were read; the GMX work (item 6) was done by a sub-agent that read
`gmx-exec.ts`.

Documents: `V11-RISK-MODEL.md` (enforcement points verified, the seed, shared reads, provenance),
`TRADING-MANDATES.md` (what the passkey signs, where the signer enforces each row, one principal per account),
`TRADING-RISK-ENGINE.md` (operator view), `V11-EXECUTION-ENGINE.md` (section 8), `V11-SECURITY-REVIEW.md`
(each review item closed, changed or restated), `docs/v11/work/exec2-notes-agents.md` (for the agents
workstream).

## Verification observed (final tree)

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `enforcement-pin.test.ts` | 7 pass |
| `execution-exec2-paper.test.ts` / `execution-exec2-live.test.ts` | 11 / 11 pass |
| `execution-spot.test.ts` / `execution-attached.test.ts` / `execution-gmx.test.ts` | 8 / 4 / 6 pass |
| full `pnpm test` (164 files) | 3 798 pass, 59 skipped, 3 fail: the two tests of `packages/trading-sdk/test/generated.test.ts` and the suite `integration.test.ts` (contract-resync workstream), and `api.test.ts › swap: quotes are for the wallet's own addresses…` (the known flaky one; `api.test.ts` alone: 17 pass). The run before the last documents were written had only the SDK failures (3 799 pass) |
| `node scripts/gen-openapi.mts --check` | up to date |
| `node scripts/build.mjs && vite build` | exit 0; first chunk `index-*.js` 260.61 kB (80.04 kB gzip); `Risk` chunk 39.37 kB, lazy. With the previous `Risk.tsx` the same tree gives 260.57 kB: +0.04 kB from this branch |
| Playwright `tests/e2e/risk.spec.ts` on `scripts/dev-stack.sh` | 1 passed (12.7 s), on the final build |

How the work was done: items 5 and 7, item 6 and item 10 were each written by a sub-agent of this session in
the same worktree; their tests were run again here on the final tree. Their code was reviewed where it touches
the risk service, the provenance ledger and the database triggers, not line by line elsewhere.

## 1. The enforcement tables, verified against the signer's source

**Initial state.** The "Enforcement points" table of `V11-RISK-MODEL.md` and the enforced-by table of
`TRADING-MANDATES.md` were written from descriptions of the signer, not from its source (the previous work
note says so).

**Change.** Every row was checked against the source and now names the file and line that refuses, or says
"none". Wrong cells corrected — see the list at the end of this note. The mandate table is generated from the
compiler (`packages/trading/src/mandate/trading-mandate.ts`): its notes were corrected there and the block
regenerated; a second, hand-written table gives the file:line of each row.

**Tests.** `services/api/test/enforcement-pin.test.ts` (7 tests): a trading mandate compiled by the real
compiler and approved at the real signer class; then the signer is asked directly, with no API check in front
of it. Refused by the signer alone: another instrument, order notional (reduce-only included), price band,
another network, an unknown mandate id, position, gross exposure, leverage setting and leverage change, the
floor, orders per hour and per day, expiry and wind-down, a revocation, a stale `createdAt`. Signed although the
trading mandate forbids it (API-only): an order type outside `orderTypes`, a third order in a minute, an account
down 400 USD in the day with a daily-loss limit of 10 and both stop conditions met, any fee, any caller; a
cancel on an instrument outside the mandate; a reduce-only trigger 14 % from the market. The last test ties the
cases to the compiler's table: every `signer` / `signer (partly)` field has a refusal case, every `API only`
field a "signed anyway" case.

**Result.** Pass. **Limitation.** The pin covers the derivative shape. The spot shape (`SPW-MANDATE-v1`) is
verified by reading only (its own suite, `mandate.test.ts` of the signer, was not extended: that directory was
not to be touched). The manual-mode and GMX rows of the risk table are cited from the source and rely on the
signer's existing suites.

## 2. The passkey commits to the full trading mandate hash

**Initial state.** The ceremony signed the hash of the compiled derivative mandate only. The API-only fields
were bound by an immutable row and an audit event.

**Change.** `mandates/service.ts`, `risk/passkey.ts` (`verifyStoredAssertion`), column
`trading_mandates.approval`. A live approval takes a second assertion over the intent
`SPW-TRADING-MANDATE-APPROVAL-v1` (mandate id, full hash, principal, mode, signer shape and hash), verified by
the API, single use, stored before the signer is asked. `integrity(row)` runs at every load for enforcement
(`forPrincipal`), at a key binding and in the supervisor: hash of the stored object, columns against the hashed
object, intent against the row, and the stored assertion verified again against an enrolled passkey. The sheet
(`approve/prepare`) returns the full hash and `binding { intent, hash, options }`; the mandate view returns
`approval` (never the assertion) and `integrity`.

**Tests.** `execution-exec2-live.test.ts`: "the sheet shows it; without the second assertion, or with one over
anything else, nothing is approved and nothing reaches the signer"; "an approved mandate whose row is altered —
an API-only field, the hash with it, the approval, the passkey — is unusable; restored, it works; the supervisor
revokes a tampered one at the signer" (seven alterations, each: 403 `mandate_integrity`, the preview says the
same, no request reaches the signer). `execution-exec2-paper.test.ts`: "a paper mandate whose stored row was
altered is unusable".

**Result.** Pass. **Limitation.** Verified by the API against its own passkey table: not a defence against a
compromised API, nor against someone who can also rewrite `credentials`. Two prompts instead of one. A mandate
approved with a passkey later removed becomes unusable. The signer-side proposal (`tradingMandateSha256`) is
written in `V11-SECURITY-REVIEW.md` and not implemented.

## 3. One principal per venue account; position provenance

**Initial state.** A key could close a position the owner had opened by hand on the mandated account and
instrument; a second principal on an account was refused late, by the engine, with `bad_state`.

**Change.** `orders/provenance.ts` (new): a ledger of lots per principal from `deriv_fills` and the unified
orders, `replay` and `attributable` pure. `OrderService.provenanceRefusal` bounds every reduce-only order of a
non-owner, and every order of theirs that points against a position partly held by somebody else, to the
principal's own lot minus what it already asked to reduce; `reducePosition` sizes a key's close from its lot.
403 `position_not_attributable`, before an order exists, and in the preview (stage `provenance`).
`MandateService.accountHolder`: a live mandate on an account that already carries an approved or pending
trading mandate, or a perp agent's active derivative mandate, is refused at creation and at approval with 409
`account_has_active_mandate` and the holder.

**Tests.** `execution-exec2-paper.test.ts`: "the ledger (pure) …"; "a key cannot close, reduce or sell into what
the owner opened by hand, nor what another key opened; it closes ITS part; the owner closes anything"; "a
position the key opened and the OWNER then closed by hand is gone for the key too …".
`execution-exec2-live.test.ts`: "one principal per live venue account: a perp agent's derivative mandate holds
the account too; a revoked holder frees it at once". `execution-live.test.ts` and `execution-paper.test.ts`
updated (a second principal is now 409 at creation; a key's oversized reduce-only order is now 403).

**Result.** Pass. **Limitation.** API-side bookkeeping. A fill of no known order is the owner's; a shortfall is
taken from keys first; a fill not yet stored makes a key wait. Perp agents (which call the Hyperliquid engine
directly) are not bound by it. On paper several principals may share an account.

## 4. Preview and creation; the gate's reuse; the command guard

**Initial state.** No test compared a preview with a creation. The gate reused a decision on account,
instrument, side, size and reduce-only. `runCommand` checked the resolved scope in its handler.

**Change.** The reuse key is the whole engine request (`risk/service.ts` `fingerprint`: + network, type, price,
trigger price, time in force, leverage setting); a decision without an engine request has no fingerprint; an
order the gate evaluates again does not count itself in the usage. `trading-api/commands.ts`: `commandOperation`
(exhaustive), `CommandGrant.authorize` (the one check), `EXECUTORS` (exhaustive, each executor takes a grant).

**Tests.** `execution-exec2-paper.test.ts`: "whatever a preview refuses, the creation refuses with one of the
same codes; the creation runs every check the preview listed (and may run more)" (seven scenarios over the key,
mandate, provenance and risk stages); "the engines' gate reuses the decision of the order service only for the
very same engine request …" (nine variants + a preview's id + an old decision); "every command kind against
every scope …" (12 lines × 2 × 12 scopes = 288 cases, plus every-scope-but-the-right-one, plus the mandate rule).

**Result.** Pass. **Limitation.** `private` is enforced by the type checker, not at run time. A creation can stop
earlier than its preview (a preview lists every refusal; a creation stops at the first).

## 8. Missing tests

| Listed in `exec.md` | Test |
|---|---|
| deny on `instrument_status` | `execution-exec2-paper.test.ts` "instrument_status: an instrument the venue has halted takes no new risk; a strictly reducing order is exempt" (through `RiskService.evaluateOrder` with the instrument as the venue would report it: the fixture venue has no halted instrument) |
| deny on `signer_status` | `execution-exec2-live.test.ts` "signer_status: a halted signer, then an unreachable one, deny a live order — through the HTTP API; a cancel still passes" |
| deny on `venue_connection` | `execution-exec2-live.test.ts` "venue_connection: when the venue's market cannot be read …" |
| deny on `drawdown` | `execution-exec2-paper.test.ts` "drawdown: after a real loss the equity is below its peak …" (a real paper loss, through HTTP) |
| automatic kill | `execution-exec2-live.test.ts` "the automatic kill (superviseAuto) …" (total loss, drawdown, unreadable book, stops switched off) |
| `loss_gte`, `drawdown_gte` | `execution-exec2-paper.test.ts`, one test each |
| `signer_unreachable_gte`, retry of a revocation | `execution-exec2-live.test.ts` "signer_unreachable_gte: … the revocation the signer could not take is asked again until it has it" |
| restart in `PARTIALLY_FILLED` | `execution-exec2-live.test.ts` "restart while an order is PARTIALLY_FILLED …" (the scripted venue fills a quarter, a new `createExecution` finds it; then the rest) |
| paper vocabulary in `packages/trading` | `mapPaperOrder` and `PAPER_ORDER_STATUSES` moved to `packages/trading/src/orders/vocabulary.ts` (sixth table of the generated block); `packages/trading/test/vocabulary.test.ts` "paper order statuses …" |

**Result.** Pass. **Limitation.** The total-loss case of the automatic kill inserts a losing fill row rather than
trading a loss on the scripted venue.

## 9. Default live limits at deployment

**Initial state.** Every new live order, the owner's manual ones included, was denied until the owner had
stored the whole limit set.

**Change.** `risk/limits.ts` `seedFromV10`, `risk/service.ts` `seedLiveLimits` (once, at the server's first
`ready`, setting `risk.limits.live.seed`, audit `risk.limits_seeded`) and `limitsFor` (the owner's own orders
are judged on the stored limits over the seed; a key or an agent on the stored limits only).
`GET /risk/limits/live` returns `seed`, `effectiveOwner`, `missing`, `missingForAutomation`,
`ownerOrdersRefused`, `automationOrdersRefused`. Seeded: allow-lists, order and position notional, gross
exposure, account leverage, the leverage setting, daily and total loss (and three limits that have a default,
when the account policy is stricter). Not seeded: daily notional, net exposure, exposure per asset and per
venue, collateral share, drawdown; GMX.

**Tests.** `execution-exec2-live.test.ts` "seedFromV10 (pure): the minimum over the accounts, the union of the
allow-lists, nothing invented" and "a wallet that comes from V10: the owner's own order is judged on what he had
approved; the six limits with no equivalent still deny, by name; a key sees none of it; the seed is written
once" (an authorized venue account exists before the V11 server first starts).

**Result.** Pass. **Limitation.** With several venue accounts the seed is the minimum: tighter than each account
alone. The owner still has six limits to set before his real orders pass. A policy loosened by a session before
V11 Phase B is carried over as approved.

## 11. Rate budget

**Initial state.** One live order read every authorized venue account of the book twice, and a preview once
more (twice, in fact: the engine's own preview gate evaluates too).

**Change.** `RiskService.bookView`: the reads of a live book, the signer's status and the leverage setting are
shared for 2 s (`SPW_RISK_CONTEXT_TTL_MS`), dropped at once on any engine row change (the sequence of the
projection queue), on a fill or a cancel of a unified order, on a clock jump, and never kept when incomplete.

**Tests.** `execution-exec2-live.test.ts` "rate budget: a preview and a creation share ONE read of the venue
account; with the sharing off each evaluation reads it; a fill drops the shared copy at once" (counts the
scripted venue's `clearinghouseState` requests and the service's own counters).

**Result.** Pass: one book read for a preview and a creation with the sharing on, at least three with it off.
**Limitation.** A change made at the venue outside the wallet is seen up to 2 s late by the service's own
evaluation.

## 5. Spot orders through the trading API; spot agents' swaps in the unified table

**Initial state.** 422 `spot_via_swap_screen` for the owner. `agent_orders` were merged into `GET /orders` from a
second source. The kill switch stopped a live spot agent at the signer client only, and no paper spot agent.

**Change.** `orders/spot.ts`, `orders/spot-orders.ts`: an owner spot order is a unified order and then a
proposal of the existing swap flow, reached in process (`app.inject` on `POST /api/v1/swap/proposals` with the
owner's own session); approval and withdrawal are the existing routes. Triggers on `proposals` (swap) and
`agent_orders` feed the projection; `GET /orders` has one source. A BEFORE INSERT trigger on `agent_orders`
applies the kill switch (a buy) and read-only mode (everything) to paper and live spot agents. Details and the
refusal table: `V11-EXECUTION-ENGINE.md` 8.8.

**Tests.** `execution-spot.test.ts` (8): keys refused; SELL through `POST /orders` (approval path, replay,
cancel); BUY and SELL as commands with the projected states and steps; the kill switch and read-only mode; the
default port (the server's own swap route, its refusal, no session → nothing asked); adoption of a Swap-screen
proposal; a spot agent's paper and live swaps as unified orders and the trigger; STOP ALL AGENTS.

**Result.** Pass. **Limitation.** No successful proposal went through the real in-process port (the happy path
uses a port that writes the row the route writes). The owner's unified limits are not evaluated for a spot
order. A REST BUY by base size is not expressible. A live spot agent still cannot sell into cash under the kill
switch (the signer-client guard, not this workstream's file). The agent mapping reads English reason texts.

## 6. Live GMX orders through the trading API

**Initial state.** 422 `venue_not_wired`; no test of the GMX gate path.

**Change.** GMX branch of `OrderService` (owner only; keys and agents 403 `gmx_requires_owner_passkey`): market
increase and decrease mapped to the existing engine, linked by the operation id, `AWAITING_APPROVAL` with the
existing approve route; cancel and close return their own approval descriptor. `risk/service.ts`: the GMX
account of the risk book is the wallet's USDC on Arbitrum plus position margin and PnL, read when the order is
on GMX (a read made only for that is never recorded as the book's peak equity). `gmx-exec.ts` was not edited.
Field mapping: `V11-EXECUTION-ENGINE.md` 8.6.1.

**Tests.** `execution-gmx.test.ts` (6): inexpressible requests refused alike in preview and creation; the owner
order to `FILLED` with a replay; `SPW_DERIV_GMX_LIVE` off; the engine's `prepareOrder` gate (risk denial, kill
switch) and the approve-time kill-switch check; a decrease and a cancellation under the kill switch and with
the lock off; keys and agents refused.

**Result.** Pass (scripted chain; no fork run). **Limitation.** Before this change a first GMX increase could not
pass the unified engine at all (zero equity): the new equity definition is for review. One GMX operation can
await approval at a time. The position id of `GET /positions` is longer than the server's path-parameter limit.
The key refusal is tested at service level, not over HTTP. The command path on GMX is wired and not tested.

## 7. Attached SL/TP; STOP ALL AGENTS

**Initial state.** Attached orders were returned, not placed. `STOP ALL AGENTS` answered 501.

**Change.** `orders/attached.ts` and table `order_attachments`: placed after the parent fills, reduce-only,
sized to the fill, through the same service; one-cancels-the-other by the supervisor; nothing when the parent
is refused. `orders/agent-control.ts`: perp agents stopped through `perpMode`; spot agents reported
`notStopped` (a live one has its mandate revoked at the signer).

**Tests.** `execution-attached.test.ts` (4): fill → both placed, replay, stop-loss executes → take-profit
cancelled; refused entry; resting entry, cancelled or filled later by a new process; a fill in two parts.
`execution-spot.test.ts` "STOP ALL AGENTS …".

**Result.** Pass, on paper. **Limitation.** Not tested on the live Hyperliquid path. Protective orders are
cancelled rather than re-sized when the position shrinks. Spot agents cannot be stopped: the agents runtime
exports no function for it (`exec2-notes-agents.md`).

## 10. Risk screen

**Initial state.** Limits and a new mandate were edited as JSON; never opened in a browser.

**Change.** `apps/web/src/screens/Risk.tsx`, `apps/web/src/risk/{limits,mandate}.tsx`, `rk*` texts FR/EN: the
banner with the exact missing limits (owner, and keys/agents); a limits form (tighten = save, loosen = passkey)
showing seeded values and their source; mandate creation (principal, mode, account, pinned instruments,
capital, notionals, leverage, losses, validity, order types, frequency, slippage, fee, stop conditions); the
approval sheet with the enforced-by table, the full mandate hash and the two passkey prompts; exposure per
asset and venue, leverage, collateral, liquidation distances, alerts, last decisions.

**Tests.** `tests/e2e/risk.spec.ts` on `scripts/dev-stack.sh` (virtual authenticator): the banner and no
textarea; a paper limit tightened through the form; kill switch engaged → a paper order that adds risk is
refused in the terminal with `kill_switch` shown → "Fermer 100 %" still closes → release without a passkey is
403, the UI release sends the assertion and the switch goes off.

**Result.** 1 passed (run on the final tree; see "Verification observed"). **Limitation.** The mandate form and
the live two-prompt approval were type-checked and built, not exercised in a browser. An agent's strategy hash
is typed by hand. Missing limits and a failed mandate integrity are shown as current conditions, not stored
alerts. Unused `rk` keys of the JSON editors are still in the text block.

## Enforcement cells corrected

`V11-RISK-MODEL.md`, signer column: order notional (a GMX decrease is not size-bounded); order leverage (manual
mode checks a leverage change, not the setting an order runs under); slippage (the reduce-only trigger
exception); price freshness (Kraken has no per-quote time; USDC is one source); order rate (the manual daily
count includes reduce-only orders; GMX counts added); allow-lists (a mandate cancel is bounded by the
authorization's instruments; GMX markets added); reduce-only validity (the flag is not checked against a
position); signer and venue status (the mandate path fails closed on the signer's own venue read).

`TRADING-MANDATES.md`, compiler notes: `notBefore` signer → signer (partly), both shapes; `mode` signer → n/a,
both shapes; spot `label` signer → signer (partly); notes of `instruments`, `frequency` and `maxSlippageBps`
(derivative) completed.

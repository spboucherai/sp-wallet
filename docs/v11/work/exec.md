# V11 Phase F — execution: unified orders, risk engine, trading mandates, write side of the trading API

Branch `v11-exec`, from `v11`. Scope: `services/api/src/{orders,risk,mandates}/` (new), the order handlers of
`services/api/src/trading-api/`, three hooks in the venue engines, a compact Risk screen. **No file of
`services/isolated-signer` was changed.** Nothing was sent to a real venue, and no real key was used: every
test runs against fixture-backed venues, the scripted Hyperliquid of the test suite, the paper engine and the
real signer class in process with a public test mnemonic.

Documents: `docs/V11-EXECUTION-ENGINE.md` (section 8), `docs/V11-RISK-MODEL.md` (integration, enforcement
points), `docs/TRADING-MANDATES.md` (in the API service), `docs/TRADING-RISK-ENGINE.md` (operator view),
`docs/V11-SECURITY-REVIEW.md` (execution through the trading API).

## Verification observed

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `services/api/test/execution-unit.test.ts` | 9 tests pass |
| `services/api/test/execution-paper.test.ts` | 17 tests pass |
| `services/api/test/execution-live.test.ts` | 12 tests pass |
| full `pnpm test` (147 files) | 3 521 pass, 59 skipped, 1 fails: `api.test.ts › swap: quotes are for the wallet's own addresses…` (the known flaky one; `api.test.ts` run alone: 17 pass) |
| `node scripts/gen-openapi.mts --check` | up to date |
| `node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)` | exit 0; first chunk `index-*.js` 259.15 kB (79.66 kB gzip); `Risk` chunk 15.42 kB |

## 1. One order table driven by `transition()`

**Initial state.** Four state vocabularies, one per engine table. `packages/trading` had the state machine,
used by nothing.

**Change.** Tables `orders`, `order_events` (append-only by trigger), `order_projection_queue`.
`orders/store.ts` is the only writer of an order and only applies `transition()`. `orders/service.ts` places,
cancels and reduces through the existing engines.

**Tests.** `execution-paper.test.ts` "the store: an illegal transition is refused and changes nothing; the
history is append-only"; the event sequences asserted in the end-to-end tests.

**Result.** Pass. **Limitation.** The spot agents' swaps (`agent_orders`) are not unified orders.

## 2. Projection of the engines

**Initial state.** Orders of the Futures screen, of perp agents and of GMX existed only in their engine
tables.

**Change.** Triggers on `deriv_orders` and `deriv_gmx_ops` queue every change. `projection.ts` turns an engine
row into events (`advance`). Rows placed through routes that existed before are adopted.

**Tests.** `execution-unit.test.ts`: each of the 11 Hyperliquid states and the causes hidden in
`reject_reason`, the 12 GMX states, the 7 paper statuses; from every unified state towards every engine
state; "never placed" inside and after the grace. `execution-paper.test.ts` "an order placed through the
route that existed before … is in the unified table too" (no engine row without its unified order, empty
queue, no `projection_error`). `execution-live.test.ts` "an order through the route that existed before is a
unified order too".

**Result.** Pass. **Limitation.** A GMX failure after an unknown outcome is recorded `REJECTED /
VENUE_REJECTED`, because no local event may close an order past `SUBMITTING`. The paper mapping lives in the
API service, not in `packages/trading`.

## 3. Ambiguous submissions and the reconciler

**Initial state.** The Hyperliquid engine already kept `unknown` and looked the order up by its client order
id. Nothing above it did.

**Change.** An engine `unknown` is `UNKNOWN` (`submit_ambiguous`). `OrderService.reconcile` runs the engine's
lookup for the account and projects again; `FAILED / NEVER_PLACED` only through `reconciled_absent` with
`VENUE_RECONCILE` and the expiry of the signed request. Client order ids are `clientOrderIdFor(venue,
principal, key)`: for Hyperliquid the unified id is the venue's cloid.

**Tests.** `execution-live.test.ts` "an ambiguous submission is UNKNOWN — never FAILED, never sent again; the
reconciler finds it at the venue"; "…or does not find it: the order stays UNKNOWN inside the grace, and is
FAILED (NEVER_PLACED) only once the signed request can no longer be accepted; a new process does it from the
database alone" (one exchange request in total).

**Result.** Pass. **Limitation.** GMX has no client order id at the venue; its unknown operations are settled
by the GMX engine's own refresh, and absence is never conclusive by this rule.

## 4. Restart

**Change.** The reconciler keeps nothing in memory. Orders of the service left before their engine stored
anything are `FAILED / INTERNAL_ERROR` after 30 s (the engines store a row before they ask the signer).

**Tests.** `execution-paper.test.ts` "restart: an order of the service that never reached its engine is closed
after the grace …; one whose engine row exists is completed from it" (`CREATED`, `VALIDATED`, `APPROVED`,
`SUBMITTING` without and with an engine row). `execution-live.test.ts` "restart: while an order waits for the
passkey, and while one rests at the venue: a new process settles both" (`AWAITING_APPROVAL`, `SUBMITTED`), and
the `UNKNOWN` case of item 3.

**Result.** Pass. **Limitation.** `PARTIALLY_FILLED` at restart is covered by the projection tests, not by a
restart test with the scripted venue (it has no helper that fills a resting order in part).

## 5. Idempotency

**Tests.** `execution-paper.test.ts`, end-to-end test: the same `Idempotency-Key`, and the same
`clientOrderId` with another HTTP key, return the same order; `engineCalls.paper` and the number of engine rows
do not move; another body is `idempotency_conflict`. `execution-live.test.ts` "a replay sends nothing" (signer
requests and exchange requests counted).

**Result.** Pass.

## 6. Risk engine

**Initial state.** `evaluate()` existed and was called by nothing. Each engine had its own per-account checks.

**Change.** `risk/service.ts` assembles the context per book, stores every evaluation, holds the limits and
the two switches. The engines call it through a gate. `limits.ts`: live capital limits absent by default.

**Tests.** `execution-paper.test.ts` "every check is wired" (22 limit cases, each denying with its check; two
sources that disagree; the denied order is a `REJECTED` row with its decision; the same limit binds the owner
through the trading API and through the old route); "limits: tightening is free, loosening needs the
passkey"; "kill switch: blocks opening for the owner, a key and an agent, on every path; a cancel and a
reduce-only close still pass; release needs the passkey"; "read-only mode: only a cancel passes"; "a stale
price denies a market order but lets a reduce-only limit order through". `execution-live.test.ts` "live limits
the owner never set deny new risk"; "paper and live never share a context"; the kill switch stopping a
proposal at its approval. `execution-unit.test.ts` `loosenedLimits`.

**Result.** Pass. **Limitations.** Not exercised by a deny test: `instrument_status`, `signer_status`,
`venue_connection` (they pass in the live tests; `signer_status` was seen denying while the test harness was
being built), `drawdown` (it needs a loss first). The automatic kill (`superviseAuto`) has no test. Resting
orders are not counted in exposure. A second account on a venue is judged per account for the per-venue
limits. The engine is API-side.

## 7. Trading mandates

**Initial state.** The schema, `checkOrder` and the compilers existed. `api_keys.mandate_id` was stored
unchecked.

**Change.** `mandates/service.ts`; `exec.ts` gained `mandateBinding` and `prepareCompiledMandate` (the same
approval flow for a mandate compiled from a trading mandate; `prepareMandate` was split, its behaviour is
unchanged). Key binding is verified.

**Tests.** `execution-paper.test.ts`: lifecycle of a paper mandate; "an order outside the mandate is refused,
field by field" (instrument, notional, leverage, order type, slippage, fee, venue, network, account, mode,
principal); "capital, frequency and loss limits"; "a key cannot create, read, approve, alter or revoke a
mandate, change a limit or release a switch" (23 routes: 403 with a valid key, 401 without credentials);
revocation and the stop condition; refused venues; expiry. `execution-live.test.ts`: "creation compiles for
the signer; the approval sheet carries the enforcement table; one passkey ceremony at the signer"; revocation
reaching the signer; the mainnet locks.

**Result.** Pass. **Limitations.** Live mandates: Hyperliquid, one venue account. Live spot mandates are
refused here (`spot_mandate_via_agent_vault`). The API-only fields are not covered by the passkey. The stop
conditions `loss_gte`, `drawdown_gte` and `signer_unreachable_gte` are implemented and not tested; the retry of
a revocation the signer has not taken is implemented and not tested.

## 8. Write side of the trading API

**Initial state.** Twelve operations answered 501.

**Change.** `previewOrder`, `placeOrder`, `cancelOrder`, `closePosition`, `reducePosition` wired; new
`runCommand` (`POST /commands`) and `engageKillSwitch` (`POST /risk/kill-switch`); `GET /orders…` served from
the unified table; `GET/PUT /api/v1/developer/command-defaults`; `SPW_TRADING_API_EXECUTION`; `order.updated`
on every transition; OpenAPI regenerated.

**Tests.** The end-to-end paper test; `execution-live.test.ts` "SPW_TRADING_API_EXECUTION is off by default",
"the key places an order … the signer signs under the mandate", "each lock that is off refuses the key's order
with its own code (visible in the preview); with all of them on the signed request reaches the venue";
commands; webhooks. `trading-api.test.ts` updated: bound keys use real mandates, the 501 surface is the seven
strategy and agent operations.

**Result.** Pass. **Not done.** Spot orders for the owner through the swap proposal flow (422
`spot_via_swap_screen`). Live GMX orders through this API (422 `venue_not_wired`). The seven strategy and
agent operations (agents runtime). `STOP ALL AGENTS` (501). Stop-loss and take-profit orders attached to a
command are returned, not placed.

## 9. Web

**Change.** `apps/web/src/screens/Risk.tsx` (lazy; Settings → Risk, and a link from Monitoring; `rk*` keys in
French and English): the two switches, exposure per book, limits with the passkey step, server locks, mandates
with usage, the enforcement table, revoke, the approval sheet, the last decisions.

**Tests.** Typecheck and the web unit tests. **Not exercised in a browser.** **Limitation.** The limits and a
new mandate are edited as JSON; there is no form.

## 10. Behaviour that changes at deployment

- **Live orders need the owner's risk limits.** Manual live orders (Futures screen, Hyperliquid and GMX) and
  perp agents that are live open no new risk until the live limits are set in the Risk screen. Cancels and
  reductions are not affected. Paper is not affected.
- `GET /api/v1/trading/orders`: `status` is the unified state (`FILLED`, `SUBMITTED`, …). The engine's own
  word is `engineStatus`. Ids of orders placed through the older routes are unchanged (`deriv:…`, `gmx:…`).
- A key can no longer be bound to a mandate id that does not exist.
- `POST /orders/preview` no longer requires an `Idempotency-Key`.

## Transcript: paper, end to end, through the HTTP API

Produced by `SPW_EXEC_TRANSCRIPT=<file> pnpm vitest run services/api/test/execution-paper.test.ts -t "preview → place"`:
a real server instance, a key created and bound with a passkey, the paper engine on a scripted BTC book
(50 000 ± 5). Request bodies are verbatim; answers are summarised by the test.

```
# key spk_<id> — every scope; bound to an approved PAPER trading mandate (BTC, market + limit, 2 000 USD per order)
POST /api/v1/trading/orders/preview {"mode":"paper","instrument":"hyperliquid:BTC","side":"buy","type":"market","size":"0.02","accountId":"addcc132-be25-4ff5-bc38-de0f5f15fe84"}
  → 200 see below
    wouldExecute=true approval=mandate risk=allow (31 checks, all ok) mandate=allow hash=e7f57ab96789fb33… estimate: fee 0.450045, avg 50005, slippage 1 bps, liquidation null
POST /api/v1/trading/orders {"mode":"paper","instrument":"hyperliquid:BTC","side":"buy","type":"market","size":"0.02","accountId":"addcc132-be25-4ff5-bc38-de0f5f15fe84"}
  → 200 see below
    order 0xa423b5d399… status=FILLED filled=0.02 avg=50005 reason=VENUE_FILLED
POST /api/v1/trading/orders {"mode":"paper","instrument":"hyperliquid:BTC","side":"buy","type":"market","size":"0.02","accountId":"addcc132-be25-4ff5-bc38-de0f5f15fe84"}
  → 200 replay: same order, Idempotent-Replay: true
GET /api/v1/trading/positions?mode=paper
  → 200 see below
    position long 0.02 hyperliquid:BTC entry 50005
POST /api/v1/trading/positions/paper%3Ahyperliquid%3Aaddcc132-be25-4ff5-bc38-de0f5f15fe84%3Ahyperliquid%3ABTC/reduce {"fraction":"0.5"}
  → 200 see below
    order 0x9e015d91c6… reduce-only sell status=FILLED filled=0.01
POST /api/v1/trading/positions/paper%3Ahyperliquid%3Aaddcc132-be25-4ff5-bc38-de0f5f15fe84%3Ahyperliquid%3ABTC/close {}
  → 200 see below
    order 0x84a3b04474… reduce-only sell status=FILLED filled=0.01
POST /api/v1/trading/orders {"mode":"paper","instrument":"hyperliquid:BTC","side":"buy","type":"limit","size":"0.01","accountId":"addcc132-be25-4ff5-bc38-de0f5f15fe84","price":"49000"}
  → 200 see below
    order 0x11ebb43d07… limit buy 0.01 @ 49000 status=SUBMITTED
DELETE /api/v1/trading/orders/0x11ebb43d07e3f3ad4b6870f2a5a2e9d2
  → 200 see below
    order 0x11ebb43d07… status=CANCELLED reason=CANCELLED_BY_REQUEST
GET /api/v1/trading/orders/0xa423b5d399fbae8255ad46a4a71600c6
  → 200 see below
    history: CREATED→VALIDATED (validated), VALIDATED→APPROVED (approved), APPROVED→SUBMITTING (submit_started), SUBMITTING→FILLED (reconciled_found); fills: 1
GET /api/v1/trading/orders?mode=paper
  → 200 see below
    4 orders: buy market FILLED | sell market FILLED | sell market FILLED | buy limit CANCELLED
```

## Notes on the verification

- The first chunk is 259.15 kB. The last figure recorded before this branch is 258.41 kB
  (`stab-swaps.md`); the chunk was not rebuilt on the base commit here, so the exact difference is not
  measured. What this branch adds to it is the route of the Risk screen (a lazy import, the path, the render
  line): about 0.3 kB. The screen itself and its texts are in their own chunks.
- The full suite was run three times during the work; the same single test failed each time and passes when
  its file is run alone.
- The web screen was type-checked and built. It was not opened in a browser.
- No test talks to a real venue, and none uses a real key.

# V11 work log — the SP Trading API contract and its two SDKs, resynchronised

> **Two parts.** Part 1 (below) is the resynchronisation against `v11` at `8618bdf`. Part 2, at the end, is the second one:
> `v11` at `a105202` (agents runtime, exec2) merged into this branch, 41 operations. Where the two differ, Part 2 is the
> current state — in particular the numbers (32 operations, the seven 501 writes) and the agent swap projection of item 7.

Branch `v11-contract`, from local `v11` (`8618bdf`). Date: 2026-11-15. Author: an agent working in an isolated worktree.
Nothing was pushed or published; production was not touched; no real order was sent. The local stacks used a throwaway
signer keystore, an own per-run database, broadcast off, `SPW_TRADING_API_EXECUTION` unset (live execution closed):
every order of this work is a **paper** order, filled by the wallet's paper engine against the venue's public book.

Starting point: `pnpm typecheck` passed; the suite failed in `packages/trading-sdk/test/generated.test.ts` (2 tests) and
`packages/trading-sdk/test/integration.test.ts`. Why the integration test could not run: the shared stack
(`packages/trading-sdk/scripts/test-stack.mts`) created its `trader` key with `mandateId: randomUUID()`, and the server
now verifies a key's mandate binding (`mandates.verifyKeyBinding`): `POST /developer/keys/prepare` answered
`422 mandate_not_found`, the stack exited, and the test file failed while loading.

## Verification summary

| Check | Result (observed) |
|---|---|
| `pnpm typecheck` | exit 0 (9 projects) |
| `node scripts/gen-openapi.mts --check` and `tsx scripts/gen-openapi.mts --check` | both files up to date |
| `node packages/trading-sdk/scripts/gen-types.mts --check`, `gen_models.py --check`, `gen_sync.py --check` | up to date |
| `vitest run services/api/test/trading-contract.test.ts` | **18 passed** (new) |
| `vitest run packages/trading-sdk` | 4 files, **136 passed**: 113 unit + 23 integration (was 86 passed, 2 failed, the integration file not loading) |
| `uv run pytest` (`sdk/python`, Python 3.13) | **365 passed**: 324 unit + 41 integration |
| `uv run --python 3.10 --isolated pytest -m "not integration"` | all 324 unit tests pass on Python 3.10 |
| `uv run ruff check` | `All checks passed!` |
| Full `pnpm test` | 159 files, 3 869 tests. **Run 4: 3 810 passed, 59 skipped, 0 failed.** Three earlier runs each had one failure — see below |

The full suite was run four times, and the first three each failed one test:

1. `apps/web/test/developer.test.ts` — **caused by this work**: the test expected `size` among the required members of
   the order body; the body now requires exactly one of `size` and `notional`. Assertion updated (commit `0afbfdd` "Developer
   screen test"); a file outside the owned set.
2. `services/api/test/trading-api.test.ts › the usage log holds route patterns and statuses` — the usage row is inserted
   in an `onResponse` hook, after the answer is sent, and the test reads the log immediately: under the load of the
   whole suite the second row was not there yet. That code path is not touched by this work. Rerun alone three times:
   29 passed each time. Not one of the two tests named as known flaky; reported as a third.
3. `services/api/test/api.test.ts › swap: quotes are for the wallet's own addresses` — the known flaky test. Rerun
   alone: 17 passed.

## The base moved while this work was done — read this before merging

`v11-contract` was branched from local `v11` at `8618bdf`, as instructed. Local `v11` is now at `a105202`, ten commits
later (`Merge v11-agents`, `Merge v11-exec2`). Those commits change the same contract:

- the seven strategy and agent writes are **implemented** there (with success schemas), and about ten operations are new
  (`listAgentTemplates`, `getAgent`, `listAgentSignals`, `listAgentJournal`, `listAgentOrders`, `getAgentPerformance`,
  `getJob`, `pauseAgent`, `backtestAgent`); `strategies:manage` and `agents:manage` are no longer execution scopes;
  a webhook event `risk.proposal` exists; `commands.ts` and `routes.ts` changed (owner spot orders, attached SL/TP).
- `git merge-tree v11-contract v11` reports three conflicting files: `services/api/src/trading-api/spec.ts`,
  `services/api/src/trading-api/routes.ts`, and the generated `docs/openapi/trading-v1.json` (regenerate it).

Nothing of that is in this branch: **everything in this note is true of the contract at `8618bdf`**. After the merge:
the new operations need their `errors` in `spec.ts` (the document's responses are rendered from them, and the unit test
requires the list for every operation), both SDKs need methods for them (their tests fail on an operation without a
case — by design), `NOT_WIRED` in the two integration tests becomes empty or shrinks, and the numbers above (32
operations, 25 success schemas) change. That follow-up was not started: it is a second resynchronisation, not a merge
conflict.

## Per item

Server tests are in `services/api/test/trading-contract.test.ts` (new): real server, real signer process, real API keys
and paper mandates created through the owner routes, fixture-backed venues, own database. **Every answer of that file,
success or error, is validated against the OpenAPI document the server generates** — a validator of the JSON Schema
subset, with `$ref`, written in the test: closed objects refuse an undeclared member, an enum refuses another value,
and an error answer must be a `(status, code)` of the operation's `x-spw-errors`. The file ends by asserting that at
least 40 distinct (operation, status, code) error answers went through that check.

### 1. Closed objects with undeclared members

- **Initial**: `GET /portfolio` sent `totals.note`, `GET /balances` sent `halted`; the document declared both objects
  closed without them. The error body was declared closed too, although it carries `data` and `candidates`.
- **Change** (`spec.ts`): `totals.note` declared; `halted` declared on balances and made nullable on both (`boolean |
  null`: the signer may not say). `Error` is now an open object with `candidates` and a typed `data` (`order`, `reasons`,
  `failed`, `checks`, `decisionId`, `questions`, `code`, `token`).
- **Tests**: "GET /balances and GET /portfolio send nothing the document does not declare"; the validator's own test
  proves it refuses an undeclared member, a missing `halted`, and accepts `null`. The Python integration test validates
  every real answer with `jsonschema` (closed objects are now a hard failure, no longer a reported "gap").
- **Observed**: pass. **Limitation**: `halted: null` is declared and validated, not provoked (the signer of the tests
  always answers).

### 2. Money as JSON numbers in `GET /portfolio`

- **Initial**: `wallet.valueUsd`, `wallet.balances[].valueUsd`, `totals.walletUsd` were JSON numbers (binary floats:
  `Number(display) * usd`).
- **Change** (`read.ts`, trading-API read layer only — the owner web routes are untouched): the feed's price becomes a
  decimal string once (`priceString`, never an exponent), each value is `balance × price` in exact decimal arithmetic
  kept to a millionth of a dollar, rounded down (`usdValue`), and the total is the exact sum. The document declares the
  three as decimal strings.
- **Tests**: "…are decimal STRINGS, exact products and an exact sum" (1.5 ETH × 3000.1 = `"4500.15"`; the sum checked in
  integer micro-dollars; `usdValue('0.1','0.2') === '0.02'`; `priceString(1e-7) === '0.0000001'`), and through HTTP.
- **Observed**: pass. **Limitation**: the suite has no price feed over HTTP, so the HTTP assertion sees `null` values;
  the priced case calls the read layer with an injected feed.

### 3. 422 and the error codes of each operation

- **Initial**: no operation of the document listed a 422; the Markdown carried one hand-written table for the whole API.
- **Change**: every operation declares its error answers. `spec.ts` holds the codes by reading the handlers (the gate of
  `principal.ts`, `read.ts`, `orders/service.ts`, the mandate and risk services, the venue engines, `commands.ts`,
  `idempotency.ts`); `errorsOf(op)` adds what the table itself implies (scope, input validation, the mandate gate,
  replay protection, 501). `openapi.ts` renders the responses **from that list and nothing else**, and each operation
  carries `x-spw-errors: [{status, code}]`. Write operations whose order reaches a venue engine carry
  `x-spw-errors-open: true` (an engine can add a code of its own rules; the status still gives the class). The document
  also carries `x-spw-order-states`, `x-spw-mandate-deny-reasons`, `x-spw-risk-checks`. The Markdown reference now has
  one error table per operation, generated.
- **Tests**: a unit test asserts, for the 32 operations, that the responses are exactly 200 + the statuses of
  `x-spw-errors`, sorted and unique, and that the closed lists equal the packages' own (`ORDER_STATES`,
  `MANDATE_DENY_CODES`, `RISK_CHECK_IDS`, `RISK_CODES`, `UNRESOLVABLE_CODES` — `spec.ts` cannot import `@spw/trading`
  under plain `node`, so it holds copies and the test compares them). Observed against the real server and checked
  against the declaration, among others: `no_orderbook`, `venue_not_wired`, `spot_via_swap_screen`,
  `spot_execution_requires_agent_vault`, `no_position`, `close_in_app`, `below_min_size`, `price_deviation`,
  `order_rate_minute`, `mandate_required`, `mandate_denied`, `not_your_order`, `kill_switch_active`,
  `idempotency`, `stale_request`, `idempotency_conflict`, `ambiguous_command`, `parse_error`, `invalid_cursor`,
  `execution_not_wired`. Both SDK integration tests assert the same property for every error they receive
  (`OPERATION_ERRORS`).
- **Observed**: pass. **Limitation**: the lists were built by reading; a code is *proved* only where a test provokes
  it. `execution_disabled` is provoked by the SDK integration tests (and by `execution-live.test.ts`), not by the
  contract test, which has no venue account.

### 4. 404 codes

- **Initial**: the table named `unknown_market`, `unknown_order`, `not_found`; `listMarkets` declared no 404.
- **Change**: declared per operation: `unknown_venue`, `unknown_instrument`, `unknown_market` (it does exist: a spot
  symbol without data, or a bare symbol nothing answers to — the earlier SDK note was wrong on that point),
  `unknown_order`, `unknown_network`, `unknown_account`, `unknown_position`, `unknown_underlying`, `unknown_company`,
  `unknown_private_market`, `not_a_private_market`. `listMarkets` declares 404 `unknown_venue`.
- **Tests / observed**: each of the first six and `unknown_underlying`, `unknown_position`, `unknown_account` is
  provoked and checked; pass.

### 5. An unknown route under `/api/v1/trading/`

- **Initial**: without a web directory, Fastify's own body (`{statusCode, error: "Not Found"}`).
- **Change** (`routes.ts`): a catch-all route under the prefix (GET, POST, PUT, PATCH, DELETE) answers
  `404 {error: "not_found", message}`; authentication still comes first (401). Registered by the trading API itself, so
  it does not depend on the server's not-found handler. Documented (`x-spw-not-found`, description).
- **Tests**: unknown path, deeper path, a known path with another method, for a key and for the owner; 401 without
  credentials; `trading-api.test.ts` "default deny" now expects the catch-all among the routes a key can reach.
- **Observed**: pass. **Limitation**: not run with `SPW_WEB_DIR` set (the route is registered before, and independently
  of, that handler).

### 6. Success schemas for the write operations

- **Initial**: loose placeholders (`{order: {id, mode, venue, status}}`, `{kind}`, `{killSwitch: {on}}`).
- **Change**: `Order` is one named component (`#/components/schemas/Order`), with `CanonicalOrder` and `RiskCheck`;
  `previewOrder`, `placeOrder`, `closePosition`, `reducePosition`, `cancelOrder`, `runCommand`, `engageKillSwitch` have
  full schemas (`resolved`, `refusals`, `risk.checks`, `mandate`, `engine`, `account`; `idempotent`, `approval`;
  `sent`, `changed`; `kind`, `executed`, `control`, `canonical`…; the two switches).
- **Tests**: the end-to-end test validates the real answer of each; commands in their three kinds.
- **Observed**: pass. **Limitation**: `CommandResult.order` is a free-form object — the server answers the *canonical*
  order for a dry run and the *unified* order when executed, under the same member (see "Remaining mismatches").

### 7. Order `status`

- **Initial**: an open string; agent swaps carried their own words and `final: null`.
- **Change**: `status` is the closed enum of twelve states, `engineStatus` an open string (nullable), `final` a boolean.
  Agent swap rows (`agent:`) are projected **in the read layer** (`agentSwapStatus`, no agents file touched):
  `prepared → VALIDATED`, `signed → APPROVED`, `broadcast → SUBMITTED`, `filled → FILLED`, `failed → FAILED` (or
  `REJECTED` when the reason is the signer's refusal: nothing was signed), `skipped → CANCELLED`; a word the table does
  not know is `UNKNOWN` — not final, not a failure. `engineStatus` keeps the agent's word; `final` follows the state.
- **Tests**: eight agent rows inserted, listed and read one by one; `open=true/false` on them; every row of the whole
  list has a state of the enum and `final === isTerminal(status)`.
- **Observed**: pass. **Limitation**: the mapping of the agent words is this layer's reading of `agents/live.ts`; the
  agents workstream may prefer to own it.

### 8. Key ↔ mandate binding

- **Initial**: `verifyKeyBinding` was already called at `prepareCreate`, `prepareUpdate` and `updateKey`. Not at
  `createKey` (the approval step), and **not at rotation**: the new key inherited `mandate_id` although a mandate names
  one principal — the old key id.
- **Change** (`keys.ts`): `createKey` verifies again when the intent is applied; `rotateKey` verifies the binding for
  the **new** id and does not carry a mandate that does not name it: the new key is unbound (its execution scopes are
  inert) and the answer says so (`mandate: {carried: false, mandateId, code}`), as does the audit event.
- **Tests**: unknown mandate → `422 mandate_not_found`; another key's → `mandate_principal_mismatch`; never approved →
  `mandate_not_active`; approved then revoked between prepare and apply → refused at apply, the key stays unbound and
  reaches `403 mandate_required` with no order row; rotation → `mandateId: null`, `carried: false`, the new secret gets
  `mandate_required`, the old key 401; a final query proves no live key row points at a mandate that is not its own,
  approved and active.
- **Observed**: pass. **Limitation**: a rotated trading key needs a new mandate approved for its new id; whether a
  mandate should instead follow a rotation is a product decision for the owner of mandates.

### 9. The instrument, and `notional`

- **Initial**: `instrument` was a free-form object; the SDKs sized a notional themselves.
- **Change**: `instrument` is declared (`lotSize`, `tickSize`, `minOrderSize`, `minNotional`, `maxLeverage`,
  `marginModes`, `status`, `category`…), as is `ticker`. The order request takes exactly one of `size` and `notional`.
  **Where the sizing is done**: the canonical order has size-or-notional and `orders/service.ts` can resolve a notional,
  but its `OrderInput` requires `size`. To stay out of `orders/**`, the conversion is done at the trading-API boundary
  (`read.ts` `sizeForNotional`, `shaping.ts` `sizeFromNotional`): notional ÷ the order's own price (limit, else
  trigger), else the venue's mark read now, rounded down to the lot — the same rule as `OrderService.resolved`. A stale
  mark answers `503 stale_data`; less than one lot `422 below_min_size`. The canonical order therefore carries `size`.
- **Tests**: preview and place with a notional (size checked against the lot), a limit order sized at its own price,
  both / neither → 400, under one lot → 422, an unreadable market → 503, a limit without price → `invalid_order`.
- **Observed**: pass (real run: `notional: '200'` → `size 0.00307` at 65 120).
- **SDKs**: `notional` (and `notional_usdc` / `notionalUsdc`, the same field) is sent as it is; `sizeFromNotional` /
  `size_from_notional` and the market read are removed.

### 10. `StartRequest.agentId` on `POST /agents/{id}/start`

Reported only (agents workstream): `startAgent` and `startStrategy` share `StartBody = {mode, agentId?}`, so a second
agent id can be sent next to the one in the path of `/agents/{id}/start`. The Python SDK still does not expose it on
`start_agent`. Nothing was changed.

### 11. Cursor pagination

- **Initial**: `limit` only; `GET /orders` merged two sources after separate `limit`ed queries.
- **Change** (`read.ts`): one total order per list — (time desc, source, id desc) — and keyset pagination on it:
  `cursor` in, `nextCursor` out (opaque base64url of `[microseconds, source tag, id]`). Each source is queried
  "strictly after the cursor" with the id compared under the `"C"` collation; **every filter, the key's restrictions
  included, is applied in SQL**, so a page is full unless the list ends. `GET /orders` reads the unified table itself
  (through the order service's `drain` and `view`) and the agent swaps; `GET /activity` reads proposals, deposits and
  fills. A malformed cursor, or the other list's, answers `400 invalid_cursor`.
- **Tests**: pages of 3 over the whole list equal the unpaged list, once each, for five filters, with many rows on the
  same timestamp (the fixture clock is fixed); a row created after page one is not inserted into page two; a key
  restricted to one venue gets full pages; activity paged by 2; cursor helpers.
- **Observed**: pass. **Limitation**: `open=false` on `/orders` used to return rows whose `final` was `null` (agent
  swaps); it now returns final rows only.

### 12. What a preview tells about the account

- **Initial**: `account.equity` and `freeCollateral`, and the account figures inside the checks, to any key with
  `orders:prepare`.
- **Change** (`shaping.ts`, applied in `routes.ts`; nothing in `orders/`): a key that holds neither `wallet:read` nor
  `positions:read` gets `account.withheld: true` and no `equity` / `freeCollateral`; `risk.derived.positionBefore/After`
  are omitted; for the account-level risk checks `observed` is null and `detail` says "withheld"; the sentences of a
  risk or engine refusal about the account are withheld (the codes stay); the estimate loses `freeCollateralAfter` and
  `liquidationPrice`. The verdict (`wouldExecute`, each refusal's code, each check's `ok`) is unchanged.
- **Tests**: two keys, the same order: same verdict, figures only for the one with `positions:read`; a unit test of
  `shapePreview`.
- **Observed**: pass. **Limitation**: only the preview is shaped. A refusal of `POST /orders` still carries the failed
  checks with their figures in `data.checks`, to a key that holds `orders:execute`.

### Found on the way: a preview by a key without a mandate

`POST /orders/preview` with a key bound to no mandate answered `400 invalid_order` ("mandateId: an agent or an API key
acts under a mandate") — a validation message about a member the caller never sent, from `canonicalOrder`. The
trading-API boundary now answers `403 mandate_required` first (a key previews the order it could place), and the
document says so. Test: contract test; both SDK integration tests.

## SDKs

Both: models / types regenerated from the document; drift tests kept and extended.

- **Generators**: TypeScript `gen-types.mts` understands `const` and `$ref` (named types `Order`, `CanonicalOrder`,
  `RiskCheck`, `ApiErrorBody`) and emits `ORDER_STATES`, `FINAL_ORDER_STATES`, `MANDATE_DENY_REASONS`, `RISK_CHECK_IDS`,
  `OPERATION_ERRORS`. Python `gen_models.py` the same (`Literal` for `const`, component models, an operation's body or
  answer generated under its own name even when two operations share a shape). The Python walk of the document against
  the models follows `$ref` and `const`, with new mutations (a thirteenth state, another component, a `const`).
- **New methods**: `runCommand` / `run_command` (with `dryRun` / `dry_run`), `engageKillSwitch` / `engage_kill_switch`,
  `compareMarkets` / `compare_markets`, `listPrivateMarkets`, `getPrivateMarket`, `getPrivateMarketCompany` (snake_case
  in Python), `iterateOrders` / `iter_orders`, `iterateActivity` / `iter_activity`.
- **Typed write results**: `OrderPreview`, `PlacedOrder`, `CancelledOrder`, `CommandResult`, `KillSwitchResult`. The seven
  operations that answer 501 keep the untyped `WriteResult`.
- **`wait_for_order`**: the closed enum decides — FILLED, CANCELLED, REJECTED, FAILED. UNKNOWN keeps waiting and is not
  a failure. The old rule "a status outside the twelve is judged by `final`" is gone (Python refuses such an answer:
  `invalid_response`).
- **Errors**: `ExecutionDisabled`, `MandateDenied` (`reasons`), `RiskDenied` (`failed`, `checks`, `killSwitch`),
  `AmbiguousCommand` (`questions`); `error.order` on every error (the REJECTED / FAILED order of a refusal, else null).
- **`previewOrder` and `engageKillSwitch`** carry no `Idempotency-Key` (the contract declares none): retried like a read,
  never `OutcomeUnknown`. A preview sends the caller's key when one is given.
- **Python**: a write answered 2xx whose body does not match the contract raises `ServerError(invalid_response)` whose
  message says that the operation ran, with the idempotency key.
- **Shared stack** (`test-stack.mts`): one paper account (order rate raised to 60 a minute), a paper mandate created,
  approved and bound through the owner routes for the keys `trader`, `trader2` and `prepare`; one `deriv_accounts` row
  naming a random address with no authorization at the signer, so that a live order reaches the execution lock; a local
  control endpoint for the two owner actions a key cannot do (release the kill switch with the passkey, set the command
  defaults).

## Real run output — the paper write path

Lines printed by the integration tests (one per call) against the real local server, and by the examples they run;
long lines are cut with `…`. Prices are the venue's public book at the time of the run.

### TypeScript — `SPW_SDK_TRANSCRIPT=1 node_modules/.bin/vitest run packages/trading-sdk --disable-console-intercept`

```
[sdk-ts] getMarket('hyperliquid:BTC') → mark=65056.4 instrument: lotSize=0.00001 tickSize=0.1 minOrderSize=null minNotional=10 maxLeverage=40 status=active
[sdk-ts] previewOrder({mode:'paper',instrument,side:'buy',type:'market',notional:'200'}) → HTTP 200 request=e0ab8e07… ratelimit=598/600 reset=60s wouldExecute=true size=0.00307 (sized by the server) approval=mandate mandate=allow risk=allow (31 checks) equity=10000
[sdk-ts] createOrder(…, {idempotencyKey:'54a3962d-446…'}) → HTTP 200 request=502b5d0a… ratelimit=596/600 reset=60s order=0x9054b04316… status=FILLED final=true engineStatus=filled size=0.00307 filled=0.00307 avg=65040
[sdk-ts] waitForOrder('0x9054b04316…') → status=FILLED final=true engineStatus=filled size=0.00307 filled=0.00307 avg=65040 fills=1 history=4 transitions
[sdk-ts] createOrder(same order, same key) → HTTP 200 request=ce21e183… ratelimit=594/600 reset=60s same order=true Idempotent-Replay=true
[sdk-ts] createOrder(ANOTHER order, same key) → IdempotencyConflict HTTP 409 idempotency_conflict
[sdk-ts] createOrder(clientOrderId) twice → same order=true idempotent=true; another body → IdempotencyConflict
[sdk-ts] getPositions({mode:'paper'}) → long 0.00537 @ 65040 id=paper:hyperliquid:<account>:hyperliquid:BTC
[sdk-ts] reducePosition(id, {fraction:'0.5'}) → HTTP 200 request=3cdfa538… ratelimit=587/600 reset=60s status=FILLED final=true engineStatus=filled size=0.00268 filled=0.00268 avg=65039 reduceOnly=true; position now 0.00269
[sdk-ts] closePosition(id) → HTTP 200 request=1543a146… ratelimit=585/600 reset=60s status=FILLED final=true engineStatus=filled size=0.00269 filled=0.00269 avg=65039; positions on hyperliquid:BTC: 0
[sdk-ts] createOrder({type:'limit',price:'64404',notional:'200'}) → HTTP 200 request=630dd7f0… ratelimit=581/600 reset=60s order=0x581199a226… status=SUBMITTED final=false engineStatus=open size=0.0031 filled=0 avg=null
[sdk-ts] cancelOrder('0x581199a226…') → HTTP 200 request=3cab340c… ratelimit=575/600 reset=60s status=CANCELLED changed=true; again → changed=false
[sdk-ts] listOrders({limit:2}) → 2 orders, nextCursor=WyIxNzk0Nzk4NjE4…; iterateOrders({limit:2}) → 5 orders in 3 pages = listOrders({limit:500}); iterateActivity({limit:2}) → 4 fills
[sdk-ts] createOrder({mode:'live',…}) with SPW_TRADING_API_EXECUTION off → ExecutionDisabled HTTP 403 execution_disabled; order created: false
[sdk-ts] createOrder({notional:'800'}) under a mandate of 500 USD an order → MandateDenied HTTP 403 reasons=["ORDER_NOTIONAL_EXCEEDED"] error.order.status=REJECTED
[sdk-ts] engageKillSwitch('sdk-ts integration test') → HTTP 200 request=cbed88b2… ratelimit=598/600 reset=60s killSwitch.on=true by=api_key
[sdk-ts] createOrder(new risk) → RiskDenied HTTP 423 kill_switch_active failed=["kill_switch"] error.order.status=REJECTED
[sdk-ts] with the kill switch on: cancelOrder → CANCELLED; closePosition → FILLED (reduce-only)
[sdk-ts] owner released the kill switch (passkey) → createOrder → FILLED
[sdk-ts] runCommand('LONG BTC-PERP 100', {dryRun:true}) without owner defaults → AmbiguousCommand HTTP 409 questions=["venue","network","leverage","marginMode","maxFeeBps","maxSlippageBps","orderTtlMs"]
[sdk-ts] runCommand('LONG BTC-PERP 100', {dryRun:true}) → HTTP 200 request=7ee8342a… ratelimit=536/600 reset=56s kind=order executed=false order={"instrument":"hyperliquid:BTC","side":"buy","notional":"100","size":null}; orders created: 0
[sdk-ts] runCommand('SHOW POSITIONS') → kind=query query=positions; runCommand('KILL', {dryRun:true}) → kind=control executed=false; runCommand('FROBNICATE…') → ValidationError parse_error
[sdk-ts] previewOrder with a key holding orders:prepare + markets:read only → account={"id":"<account>","venue":"hyperliquid","network":"mainnet","withheld":true} refusals=[]
[sdk-ts] GET /api/v1/trading/nope (not an operation) → HTTP 404 not_found
[sdk-ts] previewOrder (key without a mandate) → MandateRequired HTTP 403 mandate_required
[example preview-order.ts] preview: would execute=true; rate limit 598/600
[example preview-order.ts] order: buy 0.00153 hyperliquid:BTC (market), hash d38097e46bf1bcb7…
[example preview-order.ts] approval: mandate; risk engine: allow (31 checks, 0 failed)
[example preview-order.ts] account figures: withheld (this key cannot read the account)
[example preview-order.ts] done
[example paper-order.ts] preview: would execute=true, size=0.00153 BTC for a notional of 100, refusals=[]
[example paper-order.ts] placed: order 0x64301658437c… status=FILLED final=true
[example paper-order.ts] replay: same order=true, answered from the idempotency store=true
[example paper-order.ts] final: status=FILLED filled=0.00153 avg=65032 fills=1
[example paper-order.ts] position: long 0.00153 BTC, entry 65032
[example paper-order.ts] closed: status=FILLED reduceOnly=true
[example paper-order.ts] done
```

### Python (synchronous client; the asynchronous one prints the same calls with the same results) — `SPW_SDK_TRANSCRIPT=1 uv run pytest -s`

```
[sdk-py] [sync] preview_order(mode='paper', instrument, side='buy', order_type='market', notional='200') → HTTP 200 request=c8c84726… ratelimit=597/600 reset=60s would_execute=True size=0.00307 (sized by the server) approval=mandate mandate=allow risk=allow (31 checks) equity=10000
[sdk-py] [sync] create_order(…, idempotency_key='037a8300-b6a…') → HTTP 200 request=a05f9aa4… ratelimit=595/600 reset=60s order=0x714001ca44… status=FILLED final=True engine_status=filled size=0.00307 filled=0.00307 avg=65091
[sdk-py] [sync] wait_for_order('0x714001ca44…') → status=FILLED final=True engine_status=filled size=0.00307 filled=0.00307 avg=65091 fills=1 history=4 transitions
[sdk-py] [sync] create_order(same order, same key) → HTTP 200 request=aec1cb87… ratelimit=593/600 reset=60s same order=True Idempotent-Replay=True
[sdk-py] [sync] create_order(ANOTHER order, same key) → IdempotencyConflict HTTP 409 idempotency_conflict
[sdk-py] [sync] create_order(client_order_id) twice → same order=True idempotent=True; another body → IdempotencyConflict
[sdk-py] [sync] get_positions(mode='paper') → long 0.00537 @ 65091 id=paper:hyperliquid:<account>:hyperliquid:BTC
[sdk-py] [sync] reduce_position(id, fraction=Decimal('0.5')) → HTTP 200 request=40a27d80… ratelimit=586/600 reset=60s status=FILLED final=True engine_status=filled size=0.00268 filled=0.00268 avg=65090 reduce_only=True; position now 0.00269
[sdk-py] [sync] close_position(id) → HTTP 200 request=33e9b226… ratelimit=584/600 reset=60s status=FILLED final=True engine_status=filled size=0.00269 filled=0.00269 avg=65090; positions on hyperliquid:BTC: 0
[sdk-py] [sync] create_order(order_type='limit', price='64453', notional='200') → HTTP 200 request=5386e36c… ratelimit=580/600 reset=60s order=0x9deb86ffe3… status=SUBMITTED final=False engine_status=open size=0.0031 filled=0 avg=None
[sdk-py] [sync] cancel_order('0x9deb86ffe3…') → HTTP 200 request=5cce015e… ratelimit=574/600 reset=60s status=CANCELLED changed=True; again → changed=False
[sdk-py] [sync] list_orders(limit=2) → 2 orders, next_cursor=WyIxNzk0Nzk5MjYw…; iter_orders(limit=2) → 5 orders in 3 pages = list_orders(limit=500); iter_activity(limit=2) → 4 fills
[sdk-py] [sync] create_order(mode='live', …) with SPW_TRADING_API_EXECUTION off → ExecutionDisabled HTTP 403 execution_disabled; order created: False
[sdk-py] [sync] create_order(notional='800') under a mandate of 500 USD an order → MandateDenied HTTP 403 reasons=['ORDER_NOTIONAL_EXCEEDED'] error.order.status=REJECTED
[sdk-py] [sync] engage_kill_switch('sdk-py sync integration test') → HTTP 200 request=86f99d04… ratelimit=546/600 reset=53s kill_switch.on=True by=api_key
[sdk-py] [sync] create_order(new risk) → RiskDenied HTTP 423 kill_switch_active failed=['kill_switch'] error.order.status=REJECTED
[sdk-py] [sync] with the kill switch on: cancel_order → CANCELLED; close_position → FILLED (reduce-only)
[sdk-py] [sync] owner released the kill switch (passkey) → create_order → FILLED
[sdk-py] [sync] run_command('LONG BTC-PERP 100', dry_run=True) without owner defaults → AmbiguousCommand HTTP 409 questions=['venue', 'network', 'leverage', 'marginMode', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs']
[sdk-py] [sync] run_command('LONG BTC-PERP 100', dry_run=True) → HTTP 200 request=16b1b86c… ratelimit=533/600 reset=52s kind=order executed=False order={instrument: hyperliquid:BTC, side: buy, notional: 100}; orders created: 0
[sdk-py] [sync] run_command('SHOW POSITIONS') → kind=query query=positions; run_command('KILL', dry_run=True) → kind=control executed=False; run_command('FROBNICATE…') → ValidationError parse_error
[sdk-py] [sync] preview_order with a key holding orders:prepare + markets:read only → account={venue: hyperliquid, withheld: True} would_execute=True
[sdk-py] [sync] GET /api/v1/trading/nope (not an operation) → HTTP 404 not_found
[sdk-py] [sync] preview_order (key without a mandate) → MandateRequired HTTP 403 mandate_required
[example preview_order.py] preview: would execute=True; rate limit 597/600
[example preview_order.py] order: buy 0.00153 hyperliquid:BTC (market), hash 4e9d127c68a64cfc…
[example preview_order.py] approval: mandate; risk engine: allow (31 checks, 0 failed)
[example preview_order.py] account figures: withheld (this key cannot read the account)
[example preview_order.py] done
[example preview_order.py] this key is not bound to an owner-approved trading mandate: there is no order it could place, so nothing to preview
[example preview_order.py] done
[example paper_order.py] preview: would execute=True, size=0.00153 BTC for a notional of 100, refusals=[]
[example paper_order.py] placed: order 0x62d57dd91ba6… status=FILLED final=True
[example paper_order.py] replay: same order=True, answered from the idempotency store=True
[example paper_order.py] final: status=FILLED filled=0.00153 avg=65098 fills=1
[example paper_order.py] position: long 0.00153 BTC, entry 65098
[example paper_order.py] closed: status=FILLED reduce_only=True
[example paper_order.py] done
```

## Files touched outside the owned set

- `services/api/src/trading-api/routes.ts` — the list and get handlers of orders, the notional, the preview shaping, the
  `mandate_required` of a preview, the catch-all 404. The eight strategy / agent handlers were not touched.
- `services/api/src/trading-api/index.ts` — one line: the order service is passed to the read layer.
- `services/api/src/trading-api/keys.ts` — item 8.
- `services/api/src/trading-api/shaping.ts` — new.
- `services/api/test/trading-contract.test.ts` — new.
- `services/api/test/trading-api.test.ts` — three assertions: the catch-all among the routes a key reaches, the route
  parser's handling of the wildcard, and `mandate_required` for a preview by an unbound key (was `no_account`).
- `apps/web/test/developer.test.ts` — one assertion: the order body requires neither `size` nor `notional` alone.
- `services/api/test/trading-api-unit.test.ts` — one assertion: an implemented operation documents a 501 only where one
  of its paths is really not connected (`runCommand`: STOP ALL AGENTS).

Nothing under `services/api/src/agents/**`, `orders/**`, `risk/**`, `mandates/**`, `derivatives/**` or `apps/web` was
changed. **An incident, corrected**: a scratch script of this work was first written to `/tmp/spw_p6.py`; a file of that
name already existed (another session's, dated 20:26) and it ran in this worktree, patching
`services/api/src/agents/perp-routes.ts` and `agents/routes.ts`. Both files were restored at once
(`git checkout --`), nothing of it was committed, the other session's file was not modified, and the scratch files of
this work then went to a private directory. One earlier scratch file of this work, `/tmp/spw_p5.py`, may have
overwritten a file of the same name of that session.

## Remaining mismatches

1. **`OrderInput` has no `notional`** (`orders/service.ts`): the trading API converts at its boundary, so the canonical
   order (and its hash) carries `size`, never `notional`. If the order service accepted a notional, the boundary code
   could go and the mandate and the risk engine would see the notional itself.
2. **`CommandResult.order` has two shapes** (canonical order for a dry run, unified order when executed). Declared as a
   free-form object; both SDKs expose it untyped. A separate member for the placed order would let it be typed.
3. **`POST /orders` refusals carry account figures** in `data.checks` (item 12 covers the preview only).
4. **A preview needs a mandate on the key** although `orders:prepare` is not an execution scope: the order service
   cannot build the canonical order of a mandate-less principal. Now answered `403 mandate_required` and documented.
5. **Rotation unbinds a trading key** (item 8): the mandate names the old key id.
6. **`StartRequest.agentId`** (item 10).
7. **`halted: null`** and **`execution_disabled` in the contract test** are declared, not provoked there.
8. **Agent swap states** are mapped in the trading-API read layer; the agents runtime does not use the unified order
   table for them.
9. `scripts/demo-trading-api.mts` and `docs/TRADING-API-ARCHITECTURE.md` still describe the write side as 501 in places;
   they are outside this work's files and were not changed.
10. The documents' code snippets are not executed as such; the examples are (three in TypeScript, four in Python).

---

# Part 2 — second resynchronisation: `v11` at `a105202` merged (agents runtime, exec2)

Same branch, same rules (nothing pushed, no real order, paper only, the live case stops at a lock). Scratch files were
kept in a private directory only.

## Verification summary (Part 2)

| Check | Result (observed) |
|---|---|
| `pnpm typecheck` | exit 0 |
| `gen-openapi.mts --check` (node and tsx), `gen-types.mts --check`, `gen_models.py --check`, `gen_sync.py --check` | up to date |
| `vitest run services/api/test/trading-contract.test.ts` | **21 passed** |
| `vitest run packages/trading-sdk` | 4 files, **147 passed**: 125 unit + 22 integration |
| `uv run pytest` (`sdk/python`, Python 3.13) | **391 passed**: 350 unit + 41 integration; the 350 unit tests also pass on Python 3.10 |
| `uv run ruff check` | `All checks passed!` |
| Full `pnpm test` | 171 files, 4 066 tests. First run after the merge work: **7 failed** — all caused by this work, in `execution-spot.test.ts` (6, one root cause and its cascade) and `execution-gmx.test.ts` (1); see below. After the fixes: **4 007 passed, 59 skipped, 0 failed** (one run) |

The seven failures of the first full run, and what they were:

- `execution-spot.test.ts`: my boundary answered `403 mandate_required` to a preview by a key without a mandate **before**
  the order service could answer its own, more precise refusal of a spot order to any key
  (`spot_execution_requires_agent_vault`). Fixed: the boundary leaves a spot instrument to the order service. The five
  other failures of that file were the rest of the same test sequence running on the state the first one left.
- `execution-gmx.test.ts`: the test documented the known limit "the listed GMX position id cannot be used in the path
  (414)" and asserted the 414. The id listed by `GET /positions` is now the short form, which the path takes: the
  assertion became `expect(pos.id).toBe('live:gmx:<account>:<instrument>')`.

## 1. The merge

`git merge v11` conflicted in `spec.ts`, `routes.ts` and the generated `docs/openapi/trading-v1.json`.

- `spec.ts`: kept this branch's shapes, error table and `errorsOf`; took the agents workstream's schemas, bodies and
  operations (16 of them now implemented); dropped `v11`'s closed `ErrorSchema`.
- `routes.ts`: kept `...agentTradingHandlers()`, exec2's `callerOf(p, req)` (the owner's session handed to the swap flow)
  and its spot instrument rule; kept this branch's read-layer order list, notional, preview shaping, `mandate_required`
  for a preview, and the catch-all 404.
- The document and the Markdown reference were **regenerated**, not merged: 41 operations, all implemented.
- `GET /orders`: exec2 made the unified table the ONE source (the owner's swaps and the spot agents' swaps are projected
  into it by `orders/spot.ts`). The read layer's own projection of agent swaps (Part 1, item 7) was therefore removed;
  the keyset pagination now reads one table, with the order service's visibility rule in SQL (a spot order by venue and
  network, any other by venue and instrument).

## 2. What exec2 asked of this workstream

- **GMX position ids** — `GET /positions` named a GMX position `live:gmx:<address>:<66-character key>`: 118 characters,
  above the router's 100-character limit for a path parameter, so `POST /positions/{id}/close` could not be reached with
  it. `read.ts` now gives the instrument form (`live:gmx:<address>:<instrument id>`) when the wallet holds one position
  on that market — the form the order service already accepts. A long and a short on the same market keep their keys
  (the service would answer `409 ambiguous_position` to the instrument form): those two cannot be closed through the
  path. Tests: contract test (one position → the short id reaches the handler; the key form → 404; two positions → keys),
  and exec2's own GMX test, which now closes the position with the id as listed.
- **`notional` for a spot BUY** — a swap is exact-input, and the order service's input carries a base size only
  (`spot_buy_needs_quote_amount`). At the boundary, `POST /orders` and `POST /orders/preview` with
  `{ instrument: 'spot:…', side: 'buy', type: 'market', notional }` are resolved the way the command grammar resolves
  `BUY <base> <amount> [<quote>]` (same defaults, same canonical order, same swap flow) and answered in the shapes of the
  order operations. Tests: in exec2's spot harness — preview (`notional: '40'`, `size: null`, owner passkey), place
  (`AWAITING_APPROVAL`, `notionalUsd: '40'`), cancel; in the contract test — a BUY by base size is still
  `spot_buy_needs_quote_amount`, a key is refused 403.
- **Review item 9, refusals** — `shapeRefusal` (`shaping.ts`): the `data.checks` of a refusal of `POST /orders`, of a
  close, a reduce or an order command lose `observed` and `detail` for the account-level checks, and the sentence is
  withheld, for a key that holds neither `wallet:read` nor `positions:read`; code, status, failed ids, limits and the
  order stay. Applied inside the idempotency wrapper, so the stored answer is the shaped one. Test: a unit test of the
  function. **Limitation**: no integration test provokes an account-level risk refusal through HTTP for such a key (the
  suite's refusals are the mandate and the kill switch, whose figures are not the account's).
- `position_not_attributable`, `account_has_active_mandate`, `mandate_integrity`, `gmx_requires_owner_passkey`, the spot
  codes and `ambiguous_order` / `ambiguous_position` are declared in `x-spw-errors`.

## 3. The strategy and agent operations

- **Errors** declared for the sixteen operations by reading `agents/trading-handlers.ts`, `lifecycle.ts`,
  `templates.ts`, `strategies.ts` and `agent-runtime/store.ts` (none edited): `restricted`, `not_found`,
  `owner_required`, `bad_state`, `mandate_required` (409), `live_unavailable`, `no_strategy`, `no_report`,
  `bad_report`, `other_version`, `wrong_kind`, `strategy_not_installed`, `exists`, `universe_mismatch`, `bad_strategy`.
  `strategies:manage` and `agents:manage` are no longer execution scopes, so `errorsOf` no longer adds the key-level
  `mandate_required` to them.
- **Response schemas** are the agents workstream's (`R.agent`, `agentResult`, `job`, `signals`, `journal`,
  `agentOrders`, `performance`, `templates`, `strategyResult`); the contract test validates the real answers against them.
- **Contract test**: templates → create from the stream template `market-making` → get → start paper → signals,
  journal, orders (each with `mode=paper`, with `mode=live`, and `mode=all` → 400) → performance → pause → backtest job
  → `GET /jobs/{id}` → stop; `start live` → 409; an unknown id on ten operations → 404 `not_found`; a spot agent by a
  key → `owner_required`; a key restricted to another venue → `restricted`.
- **SDKs** (both): `listAgentTemplates`, `getAgent`, `listAgentSignals`, `listAgentJournal`, `listAgentOrders`,
  `getAgentPerformance`, `getJob`, `waitForJob`, `pauseAgent`, `backtestAgent`, and typed results for the seven writes
  that used to answer 501. The per-agent reads take `mode` as a **required** argument (the API would fall back on the
  agent's current mode; the SDKs do not let a caller rely on that): a missing or unknown mode is refused before any
  request. Python sends an agent's `risk` limits as JSON numbers when they are whole, as decimal strings otherwise —
  never a float.
- **Obsolete 501 tests**: the "every strategy / agent write answers 501" integration tests are gone; the mocked test
  "a 501 is an error on every write method" stays (a server can still answer 501: an owner's spot order without the swap
  flow), now over 14 methods. `scripts/demo-trading-api.mts` and `docs/TRADING-API-ARCHITECTURE.md` no longer say 501.

## 4. The two SDK-facing mismatches

- **`CommandResult.order`** — the answer of `POST /commands` is declared as a union of four shapes, told apart by `kind`
  and, for an order, by `executed`: `query`; `control`; an order **dry run** (`executed: false`, `order` is the
  CANONICAL order, `hash`, `attached`, `preview` for spot); an order **executed** (`executed: true`, `order` is the
  unified order, `canonical`, `idempotent`, `approval`). TypeScript: a discriminated union (`if (r.kind === 'order' &&
  r.executed) r.order.status`). Python: four models (`CommandQuery`, `CommandControl`, `CommandDryRun`,
  `CommandExecuted`); the generator and the document walk handle an answer that is an `anyOf` of objects. `Switch` became
  a named component.
- **Rotation** — behaviour kept (the mandate names the old key id; the new key is unbound). The answer now also carries
  `mandate.rebind`: the four owner calls that give the new key a mandate. The contract test follows them (a mandate for
  the new id, approved, bound with the passkey) and the rotated key trades again. Both SDK documents have a section
  "Key rotation and the trading mandate" with what stops working, what keeps working, and the owner's steps.

## 5. Found on the way

- **A named notional order was not replay-stable.** With `notional`, the size is derived at the boundary from the price
  read at that moment. The same order sent again under its `clientOrderId` but another `Idempotency-Key` header reached
  the order service with a size computed at another price and was refused `409 idempotency_conflict` — observed in the
  Python integration run (the synchronous run had passed by luck of the tape). Fix (`idempotency.ts` `withOrderKey`,
  `routes.ts`): an order that has both `notional` and `clientOrderId` is protected a second time under the key
  `order:<clientOrderId>`: same body → the first answer, before any price is read; another body → 409. Test: the
  contract test moves the mark between the two sends. **Limitation**: the stored answer is pruned with the idempotency
  table; after that, a replay is sized again. The real fix is `OrderInput.notional` in the order service (mismatch 1).
- **Position provenance has no order for fills on one timestamp.** `orders/provenance.ts` replays fills oldest first;
  with the frozen clock of the fixtures, an owner's close and a key's open on the same instant were replayed in either
  order, and the key was then told nothing of the position was its own. Not changed (not this workstream's file); the
  contract test now advances its clock by a second before each write. Reported to the execution workstream: a
  tie-break (fill id, or the order's sequence) would make the ledger deterministic.

## Real run output — agents on paper, and the named notional order

### TypeScript

```
[sdk-ts] createOrder(clientOrderId) twice → same order=true Idempotent-Replay=true; another body → IdempotencyConflict
[sdk-ts] runCommand('LONG BTC-PERP 100', {dryRun:true}) → HTTP 200 request=9b233655… ratelimit=535/600 reset=57s kind=order executed=false order={"instrument":"hyperliquid:BTC","side":"buy","notional":"100","size":null} (the canonical order); orders created: 0
[sdk-ts] runCommand('SHOW POSITIONS') → kind=query query=positions; runCommand('KILL', {dryRun:true}) → kind=control executed=false; runCommand('FROBNICATE…') → ValidationError parse_error
[sdk-ts] listAgentTemplates() → HTTP 200 request=fcc81cd5… ratelimit=599/600 reset=60s stat-arb(bar: research/paper/live), funding-arb(stream: research/paper), market-making(stream: research/paper), momentum(bar: research/paper/live), mean-reversion(bar: research/paper/live), cross-exchange(stream:…
[sdk-ts] createAgent({template:'market-making',venues:['hyperliquid'],universe:['BTC']}) → HTTP 200 request=1583f14a… ratelimit=598/600 reset=60s agent=0fc663c6-fab… state=stopped mode=research
[sdk-ts] startAgent(id, {mode:'paper'}) → HTTP 200 request=eefcadfc… ratelimit=597/600 reset=60s state=active mode=paper
[sdk-ts] listAgentSignals/Journal/Orders(id, {mode:'paper'}), getAgentPerformance(id, {mode:'paper'}) → signals=0 journal=1 ("Paper trading started by key:spk_289e00a91ba2") orders=0 performance: "PAPER — simulated orders and fills; no money moved" points=0
[sdk-ts] pauseAgent(id) → state=paused; backtestAgent(id, {hours:1}) → job=628fe9d5-946… status=queued; getJob → queued; waitForJob(20 s) → done
[sdk-ts] stopAgent(id) → HTTP 200 request=dabda483… ratelimit=581/600 reset=59s state=stopped
[sdk-ts] startAgent(id, {mode:'live'}) without an owner-approved mandate → Conflict HTTP 409 live_unavailable; getAgent(unknown) → NotFound not_found
```

### Python (synchronous client)

```
[sdk-py] [sync] create_order(client_order_id) twice → same order=True Idempotent-Replay=True; another body → IdempotencyConflict
[sdk-py] [sync] run_command('LONG BTC-PERP 100', dry_run=True) → HTTP 200 request=7326b5de… ratelimit=532/600 reset=54s kind=order executed=False order={instrument: hyperliquid:BTC, side: buy, notional: 100} (the canonical order); orders created: 0
[sdk-py] [sync] run_command('SHOW POSITIONS') → kind=query query=positions; run_command('KILL', dry_run=True) → kind=control executed=False; run_command('FROBNICATE…') → ValidationError parse_error
[sdk-py] [sync] list_agent_templates() → HTTP 200 request=9818127d… ratelimit=599/600 reset=60s ['stat-arb(bar: research/paper/live)', 'funding-arb(stream: research/paper)', 'market-making(stream: research/paper)', 'momentum(bar: research/paper/live)', 'mean-reversion(bar: research/paper/live)', 'c…
[sdk-py] [sync] create_agent(template='market-making', venues=['hyperliquid'], universe=['BTC']) → HTTP 200 request=9b015512… ratelimit=598/600 reset=60s agent=f9d3f8a3-cdd… state=stopped mode=research
[sdk-py] [sync] start_agent(id, mode='paper') → HTTP 200 request=5d646fbf… ratelimit=597/600 reset=60s state=active mode=paper
[sdk-py] [sync] list_agent_signals/journal/orders(id, mode='paper'), get_agent_performance(id, mode='paper') → signals=0 journal=1 ('Paper trading started by key:spk_7dea8e72d54e') orders=0 performance: 'PAPER — simulated orders and fills; no money moved' points=0
[sdk-py] [sync] pause_agent(id) → state=paused; backtest_agent(id, hours=1) → job=cb6a12a4-8e7… status=queued; get_job → queued; wait_for_job(20 s) → done
[sdk-py] [sync] stop_agent(id) → HTTP 200 request=31fe4993… ratelimit=576/600 reset=56s state=stopped
[sdk-py] [sync] start_agent(id, mode='live') without an owner-approved mandate → Conflict HTTP 409 live_unavailable; get_agent(unknown) → NotFound not_found
```

## Files touched outside the owned set (Part 2)

- `services/api/src/trading-api/routes.ts`, `idempotency.ts`, `keys.ts`, `shaping.ts` — as described above.
- `services/api/test/trading-contract.test.ts`, `trading-api-unit.test.ts` (one assertion: which operations document a 501).
- `services/api/test/execution-gmx.test.ts` — one assertion (the listed GMX position id), replacing the asserted 414.
- `services/api/test/execution-spot.test.ts` — eleven lines added to one test: a spot BUY by `notional` through
  `POST /orders/preview` and `POST /orders`, then its cancel.
- `scripts/demo-trading-api.mts`, `docs/TRADING-API-ARCHITECTURE.md` — the stale 501 passages, as asked.

Nothing under `agents/**`, `agent-runtime/**`, `orders/**`, `risk/**`, `mandates/**`, `derivatives/**` or `apps/web/src`.

## Remaining mismatches (current list — it replaces the list of Part 1)

1. **`OrderInput` has no `notional`** (`orders/service.ts`). The boundary converts for perpetuals and goes through the
   command path for a spot BUY; the canonical order of a perpetual carries `size`, and a replay of a named notional
   order relies on a stored answer. With `notional` in the order service all three would go.
2. **A long and a short GMX position on one market** cannot be closed through the path (their ids are the 66-character
   keys). A short per-position id from the GMX service, or `maxParamLength` on the server, would fix it; `server.ts`
   is not this workstream's file.
3. **`listAgentSignals` and `listAgentJournal` declare `open`** (they share the page query of the orders); the handlers
   ignore it. The SDKs do not expose it on those two.
4. **The per-agent reads make `mode` optional** in the contract (default: the agent's current mode). The SDKs require it.
5. **`createAgent.mode` accepts `live` in the schema** while its description says "never live".
6. **`agent.updated` and the agent answers are loose** (`looseObject`): the SDK types name the documented members only.
7. **Refusal shaping** is unit-tested, not provoked through HTTP with an account-level risk refusal.
8. **A preview needs a mandate on the key** although `orders:prepare` is not an execution scope (reported, as asked).
9. **`StartRequest.agentId`** on `POST /agents/{id}/start` (reported, as asked; agents workstream).
10. **Rotation unbinds a trading key** — kept on purpose; documented and tested, with the way back.
11. **Position provenance on equal timestamps** (section 5) — the execution workstream's.
12. `halted: null` is declared, not provoked. The documents' code snippets are not executed as such; the examples are.

---

# Part 3 — the last resync (branch `v11-contract2`, from `v11` @ `035b966`)

`v11` now holds the quote engine (with the streaming clients of both SDKs) and the agents bound to the execution layer
(`v11-agents-bind`). Nothing under `agents/**`, `agent-runtime/**`, `orders/**`, `risk/**`, `mandates/**`,
`derivatives/**`, `quotes/**` or `apps/web` was edited.

## 1. Streaming clients

**Initial state.** `packages/trading-sdk/src/stream.ts` and `sdk/python/src/sp_wallet/stream.py` existed and were not
exported by their packages; their integration tests ran on a stack of their own (`stream-stack.mts`).

**Change.**
- TypeScript: `src/index.ts` exports `SPWalletStream`, `StreamError`, `OrderBook`, `bookChecksum`, `channelKey`, the
  protocol constants and the message types. `StreamError` declared its fields as constructor parameter properties, which
  Node's type stripping refuses: once exported from the index, **every example run with `node` failed to load**
  (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). The class now has plain fields (same public shape).
- Python: `sp_wallet/__init__.py` exports `SPWalletStream`, `OrderBook`, `StreamError`, `book_checksum`, `channel_key`
  and the module `stream` through a module-level `__getattr__`: nothing of the stream is loaded by `import sp_wallet`,
  and `websockets` (the extra `stream`) is imported only when a stream connects.
- Both stream integration tests run on the shared `scripts/test-stack.mts`, which gained two keys: `venues`
  (`markets:read`, restricted to Hyperliquid) and `agentsOnly` (no `markets:read`). `stream-stack.mts` and
  `test/stream-stack.ts` are deleted (`docs/v11/work/quotes.md` still names them: that note is the quote workstream's
  record and was left as written).
- Examples `packages/trading-sdk/examples/stream-quotes.ts` and `sdk/python/examples/stream_quotes.py`: a quote
  subscription with reconnection reporting, bounded (N quotes or 20 s).
- Documents: a "Streaming" section in `docs/sdk/typescript.md` and `docs/sdk/python.md` (channels, reconnection, order
  books, the ticket flow for browsers with the backend route and the browser side), and a "Streaming" section in the
  generated reference plus a paragraph in the OpenAPI `info.description`: the websocket is outside the document, and **a
  stream connection writes no row in the key's usage log** (the ticket request, an ordinary call, does — `recordUsage`
  is an `onResponse` hook of every route).

**Tests.** `stream.integration.test.ts` "examples/stream-quotes.ts runs against the real stream, stops by itself and
prints no secret" (and the same example with a key without `markets:read`: it prints the refusal and ends);
`test_stream_integration.py::test_the_example_stream_quotes_runs_against_the_real_stream_and_prints_no_secret`;
`test_stream_lazy_import.py` (a subprocess where `import websockets` fails: the package imports, the names resolve, a
client is built, the stream module is loaded only on first use).

**Result.** TypeScript stream tests 14 passed; Python stream tests 6 passed, the lazy-import test 1. The quotes in both example tests came
from Hyperliquid's public feed, on this machine, during the run. **Limitation.** The example test is skipped — not
failed — when no quote arrives within 20 s. The ticket flow of the documents is two snippets, not an executed example
(the ticket path itself is covered by the stream tests with `auth: 'ticket'`).

## 2. Agents bound to the execution layer

**Initial state.** The contract's notes and error lists described the agents before `v11-agents-bind`.

**What changed in the server, as read in the code.** (a) No file of `trading-api/` was changed by that branch, and the
kill switch of the trading API was already the risk engine's (`POST /risk/kill-switch`): the removed agents-side release
route and the `engage` alias are owner routes outside `/api/v1/trading/`. (b) A paper start of a PERP agent now creates
its paper trading mandate (`agents/paper-mandate.ts`), with the caller as actor: a key needs `agents:manage` (so
`startStrategy`, whose scope is `strategies:manage`, answers 403 `insufficient_scope` for a key that lacks it), and a
key restricted away from Hyperliquid or from one of the agent's instruments answers 403 `restricted`. (c) A halted paper
account answers 409 `halted` (`perp-routes.ts perpMode`). (d) A live start of a perp agent needs a trading mandate that
only the owner activates: a key always gets 409 `mandate_required`.

**Change.** `A.start` declares 409 `halted`; `START_NOTE` says (b), (c), (d). `restricted`, `insufficient_scope`,
`mandate_required`, `owner_required` were already declared on the start operations (asserted now). SDK mapping is
unchanged and stated: every 409 of the agent operations is a `Conflict` whose `code` says which — an agent's
`mandate_required` is not the key's 403 `MandateRequired`, an agent's `halted` is not the order's 423 `RiskDenied`
(four rows added to each SDK's status/code table test).

**Limitation.** `halted` and the paper-mandate `restricted` are declared from the code, **not provoked** by a test of
this workstream: they need a perp agent with a backtested strategy version (the laboratory), which the contract test
does not run. `agent-bind.test.ts` (agents workstream) covers the paper mandate itself. `mode_unavailable` exists in
`lifecycle.ts` and cannot be reached (every family runs in research and paper; live answers `live_unavailable`): not
declared.

## 3. The three mismatches

| Mismatch | Now |
|---|---|
| `open` declared on `listAgentSignals` / `listAgentJournal` | removed: `AgentPage` has `mode`, `limit`, `before`; `AgentOrdersPage` adds `open`. The exception in `sdk/python/tests/test_models_drift.py` is gone |
| `mode` optional in the contract, required in the SDKs | the contract says what the server does — optional, default the mode the agent is in now (for a stopped agent, the one it last ran in), and the answer names it. The SDKs keep it required; both SDK documents say so and why |
| `createAgent.mode` accepted `live` | the schema is `research` \| `paper`; `live` answers 400 `bad_request` (before: accepted and ignored — the agent was created in research). The description says what `paper` does per engine: stream and supervisor agents start at once, a bar agent is created and not started |

**Tests.** `trading-contract.test.ts`, agents test: `createAgent` with `mode: 'live'` → 400 and no agent created; with
`mode: 'paper'` → active on paper; the four per-agent reads without `mode` answer `mode: 'paper'`; the query parameter
names of the three lists; the 409 / 403 codes of the start operations.

**Observed on the way.** A stopped agent keeps the mode it last ran in: my first assertion expected `research` and was
wrong; the description was written from what the server answered.

## 4. Tests under full-suite load

- `trading-api.test.ts › the usage log holds route patterns…`: the row is written by `onResponse`, after the answer has
  left. The test now waits for each row with a bounded poll on the table (5 ms steps, 30 s bound, fails with the count it
  saw) before the next call — which also fixes the order of the two rows. Every assertion is unchanged.
- `trading-contract.test.ts` and `packages/trading-sdk/test/integration.test.ts`: an explicit `vi.setConfig({ testTimeout:
  240_000 })` at the top of each file (the suite default is 30 s), the nine explicit per-test timeouts of the
  integration file raised to 300 s, `waitForOrder` / `wait_for_order` bounds raised from 30 s to 90 s (polls that return
  as soon as the order is final). No sleep was added and no assertion depends on a duration.

**Limitation.** A timeout bound is not a cause removed: under load these files are slow because they drive a whole stack
through hundreds of calls. They were not made faster.

## 5. Refusal shaping over HTTP

`trading-contract.test.ts` "9 (HTTP)": the owner's paper risk limits are set in `settings` (`risk.limits.paper`:
`maxGrossExposure` 100, `maxOrderNotional` 100); two keys with a mandate place the same order — one with
`positions:read`, one without `wallet:read` / `positions:read`. Both get 422 `risk_denied` with the same failed checks
and the same `ok` per check; the first reads `observed` and the sentence of `gross_exposure`, the second gets
`observed: null` and the withheld sentence on every account-level check, keeps the order's own check
(`order_notional`) whole, and its `data.order` is `REJECTED`. The replay of its `Idempotency-Key` is the same shaped
answer, and its rows in `api_idempotency` do not hold the sentence. The limits are put back in a `finally`, and the same
order is then accepted.

## The three full runs (`pnpm test`, laboratory interpreter exported)

The worktree has no `research/.venv`: the laboratory files gated on its presence in the checkout are skipped in every run
(3 files, 67 tests), as in Parts 1 and 2.

**First series** — at commit `9d838d8` (everything of sections 1–5 except the last test commit):

| Run | Files | Tests | Failures |
|---|---|---|---|
| 1 | 182 passed, 3 skipped | 4 283 passed, 67 skipped | none (exit 0, 67 s) |
| 2 | 180 passed, 2 failed, 3 skipped | 4 281 passed, 2 failed | `api.test.ts › swap: quotes are for the wallet's own addresses…` (`swap_quotes` held 0 rows, ≥ 4 expected); `trading-api.test.ts › API keys › expiry and revocation close the key at once…` (the usage log of the key held 0 rows, 4 expected) |
| 3 | 181 passed, 1 failed, 3 skipped | 4 282 passed, 1 failed | `api.test.ts › swap: quotes…` (same) |

Neither `trading-contract.test.ts` nor the SDK integration files timed out or failed in any run. Both failures are the
race of section 4 in two more places: a log row written after the answer (`recordUsage` in `onResponse`; `swap.ts`
inserts its quote rows without awaiting them) and read at once by the test. Commit `23c0a23`: `trading-api.test.ts`
has one helper `usageOf(keyId, n)` (bounded poll) used by the three tests that read a key's usage rows — two of them
asserted the insertion order of rows written by concurrent hooks, they now assert the number and the statuses;
`api.test.ts` waits for the quote rows the same way (the swap workstream's test: five lines, same assertion).

**Second series** — at that commit:

| Run | Files | Tests | Failures |
|---|---|---|---|
| 1 | 182 passed, 3 skipped | 4 283 passed, 67 skipped | none (exit 0, 79 s) |
| 2 | 182 passed, 3 skipped | 4 283 passed, 67 skipped | none (exit 0, 71 s) |
| 3 | 181 passed, 1 failed, 3 skipped | 4 282 passed, 1 failed | `agent-worker-process.test.ts › … the worker process ticks the agents; with two workers every tick is run by exactly one` — "timed out waiting for worker 1 to be in the middle of its ticks" |

The failure of the last run is a wait on a child process in the agents workstream's test (three node processes started
by the test while every core runs the suite). It was not seen in the five other runs, it is not this workstream's file,
and it was **not fixed here**. The two log races did not come back in the second series; three runs do not prove they
cannot.

## Files touched outside the owned set (Part 3)

- `packages/trading-sdk/src/stream.ts` — the error class's fields (quote workstream's file; see section 1).
- `packages/trading-sdk/test/stream.integration.test.ts`, `sdk/python/tests/test_stream_integration.py` — moved to the
  shared stack, one example test each; `stream-stack.mts`, `test/stream-stack.ts` deleted.
- `services/api/test/trading-api.test.ts` — the usage-log test only.

## Remaining mismatches (current list — it replaces the list of Part 2)

1. **`OrderInput` has no `notional`** (`orders/service.ts`) — unchanged.
2. **A long and a short GMX position on one market** cannot be closed through the path — unchanged.
3. **The agent answers and `agent.updated` are loose** (`looseObject`) — unchanged.
4. **`halted` and `restricted` on a perp agent's paper start are declared, not provoked** (section 2).
5. **A preview needs a mandate on the key** although `orders:prepare` is not an execution scope — unchanged.
6. **`StartRequest.agentId`** on `POST /agents/{id}/start` — unchanged (agents workstream).
7. **Rotation unbinds a trading key** — kept on purpose; documented and tested.
8. **Position provenance on equal timestamps** — unchanged (execution workstream).
9. **The stream has no machine-readable contract**: its protocol is `docs/V11-QUOTE-ENGINE.md`; the SDK message types
   are written by hand in `stream.ts` / `stream.py`, and no test compares them with the server's.
10. `halted: null` on the balances is declared, not provoked. The documents' code snippets are not executed as such; the
    examples are.

Closed since Part 2: `open` on signals and journal; `mode` optional vs required (documented both ways);
`createAgent.mode`; refusal shaping over HTTP.


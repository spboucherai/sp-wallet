# V11 work log — the SP Trading API contract and its two SDKs, resynchronised

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

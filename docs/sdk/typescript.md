# SP Trading API — TypeScript SDK (`@sp-wallet/trading-sdk`)

Official client of the SP Trading API (`/api/v1/trading`, contract: [`docs/openapi/trading-v1.json`](../openapi/trading-v1.json),
reference: [`docs/TRADING-API-OPENAPI.md`](../TRADING-API-OPENAPI.md)). Source: `packages/trading-sdk/`.

- Zero runtime dependency: global `fetch` and WebCrypto. Node ≥ 20 and browsers. ESM + type declarations.
- Every answer is typed; the types are **generated** from the OpenAPI document (`scripts/gen-types.mts`), and a test fails
  when the committed types are not what the document gives.
- Money, prices and sizes are decimal **strings** end to end. The SDK never converts them to a `number`.
- The API key is never logged, never part of an error, never shown by `console.log(client)`.

> **Execution requires an owner-approved mandate.** Placing or cancelling an order, closing or reducing a position,
> and managing strategies and agents need — besides the scope — an API key **bound to a trading mandate approved by the
> wallet's owner**. Without one the API refuses the call (`403 mandate_required` → `MandateRequired`). A scope alone never
> lets a key execute.
>
> **State of the API in this version.** Reads, order previews, orders (place, cancel), positions (close, reduce), the
> command endpoint and the kill switch are implemented and answer typed results. **Paper** orders are simulated by the
> wallet's paper engine against the venue's real order book. **Live** orders additionally need
> `SPW_TRADING_API_EXECUTION=on` on the server (default off → `403 execution_disabled` → `ExecutionDisabled`) and the
> wallet's mainnet locks. The seven strategy and agent writes are declared, validated and replay-checked, then answer
> `501 execution_not_wired` (`ExecutionNotWired`): they return an untyped `WriteResult` because no success schema exists.

## Install (from the repository)

The package is not published to npm. Build it, then install it from its path:

```bash
node packages/trading-sdk/scripts/build.mts          # → packages/trading-sdk/dist (index.js + *.d.ts)
npm install /path/to/sp-wallet/packages/trading-sdk   # in your project
```

Inside this monorepo, import the sources directly: `import { SPWallet } from '@sp-wallet/trading-sdk/src'`
(or a relative path, as the examples do).

## Quick start

```ts
import { SPWallet } from '@sp-wallet/trading-sdk';

const client = new SPWallet({ apiKey: process.env.SP_WALLET_API_KEY });   // or just `new SPWallet()`

const balances = await client.getBalances();
const positions = await client.getPositions();
const preview = await client.previewOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notionalUsdc: 100 });
if (preview.wouldExecute) {
  const placed = await client.createOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notionalUsdc: 100 });   // mode: 'paper' by default
  const { order } = await client.waitForOrder(placed.order.id);            // FILLED, CANCELLED, REJECTED or FAILED
}
```

| Option | Default | |
|---|---|---|
| `apiKey` | env `SP_WALLET_API_KEY` | `spw_live_…`, created by the owner in the Developer screen |
| `baseUrl` | env `SP_WALLET_BASE_URL`, else `https://wallet.spboucher.ai` | `http://` is accepted for `localhost` only (or with `allowInsecureHttp`) |
| `timeoutMs` | `30000` | per attempt |
| `maxRetries` | `2` | retries after the first attempt |
| `userAgent` | — | appended to `sp-wallet-typescript/<version>` |
| `sendTimestamp` | `false` | send `X-SPW-Timestamp` with mutating calls (the server refuses a call more than 300 s from its clock) |
| `maxRetryDelayMs` | `30000` | longest wait accepted before a retry; a 429 asking for more is thrown at once |
| `fetch` | `globalThis.fetch` | |

Each method takes a last argument `{ timeoutMs, maxRetries, signal }` (and `idempotencyKey` for the mutating ones).

## Methods

| Method | Operation | Scope |
|---|---|---|
| `listMarkets({ venue, kind, q, limit })` | `GET /markets` | `markets:read` |
| `compareMarkets({ underlying, side, notional, leverage, horizonHours, liquidity, minNetEdgeBps })` | `GET /markets/compare` | `markets:read` |
| `getMarket(symbol)` | `GET /markets/{symbol}` | `markets:read` |
| `getOrderbook(symbol, { depth })` | `GET /markets/{symbol}/orderbook` | `markets:read` |
| `getCandles(symbol, { interval, limit })` | `GET /markets/{symbol}/candles` | `markets:read` |
| `listPrivateMarkets({ delisted, size, side })` | `GET /private-markets` | `markets:read` |
| `getPrivateMarket(id, { size, side, interval, limit })` | `GET /private-markets/{id}` | `markets:read` |
| `getPrivateMarketCompany(slug, { … })` | `GET /private-markets/companies/{slug}` | `markets:read` |
| `getPortfolio()` | `GET /portfolio` | `wallet:read` |
| `getBalances({ network })` | `GET /balances` | `wallet:read` |
| `getActivity({ limit, cursor })`, `iterateActivity({ limit }, { maxItems })` | `GET /activity` | `wallet:read` |
| `getPositions({ mode, venue })` | `GET /positions` | `positions:read` |
| `getRisk()` | `GET /risk` | `positions:read` |
| `engageKillSwitch(reason)` | `POST /risk/kill-switch` | `positions:manage` (no mandate) |
| `listOrders({ mode, venue, open, limit, cursor })`, `iterateOrders({ … }, { maxItems })` | `GET /orders` | `orders:read` |
| `getOrder(id)` | `GET /orders/{id}` | `orders:read` |
| `waitForOrder(id, { waitTimeoutMs, pollIntervalMs, until })` | polls `GET /orders/{id}` | `orders:read` |
| `previewOrder(order)` → `OrderPreview` | `POST /orders/preview` | `orders:prepare` (a key needs a mandate bound to it) |
| `createOrder(order)` → `PlacedOrder` | `POST /orders` | `orders:execute` + mandate |
| `cancelOrder(id)` → `CancelledOrder` | `DELETE /orders/{id}` | `orders:cancel` (its own orders; no mandate) |
| `closePosition(id, { slippageBps })` → `PlacedOrder` | `POST /positions/{id}/close` | `positions:manage` + mandate |
| `reducePosition(id, { fraction, slippageBps })` → `PlacedOrder` | `POST /positions/{id}/reduce` | `positions:manage` + mandate |
| `runCommand(text, { mode, accountId, dryRun })` → `CommandResult` | `POST /commands` | the scope of what the command resolves to |
| `listStrategies({ kind })` | `GET /strategies` | `strategies:read` |
| `createStrategy`, `backtestStrategy(id)`, `startStrategy(id)`, `stopStrategy(id)` | `POST /strategies…` (501) | `strategies:manage` + mandate |
| `listAgents()` | `GET /agents` | `agents:read` |
| `createAgent`, `startAgent(id)`, `stopAgent(id)` | `POST /agents…` (501) | `agents:manage` + mandate |
| `openapi()` | `GET /openapi.json` | any valid key |

`responseMeta(result)` gives the facts of the HTTP exchange behind any result: `status`, `requestId`, `idempotencyKey`,
`idempotentReplay`, `rateLimit { limit, remaining, resetSeconds }`, `attempts`.

The private markets are display only: none of these contracts is tradable (`tradable: false` on every row).

### Pagination

`GET /orders` and `GET /activity` are paginated by cursor: a page carries `nextCursor`, which is the `cursor` of the
next (older) page; `null` at the end. The order is stable (time, then id): no row is repeated or skipped across pages.
The iterators follow the cursor for you; `limit` is the page size.

```ts
for await (const order of client.iterateOrders({ open: true, limit: 100 })) console.log(order.id, order.status);
for await (const item of client.iterateActivity({}, { maxItems: 500 })) console.log(item.kind, item.at);

const page = await client.listOrders({ limit: 50 });                       // one page by hand
const next = page.nextCursor ? await client.listOrders({ limit: 50, cursor: page.nextCursor }) : null;
```

`listMarkets` is not paginated: it answers `total` and `truncated` so a list cut by `limit` is visible.

### Orders

```ts
const order = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', price: '60000', size: '0.01' } as const;
const preview = await client.previewOrder(order);        // nothing is created; preview.refusals says what would refuse it
const placed = await client.createOrder(order);          // placed.order.status: 'SUBMITTED' while it rests
await client.cancelOrder(placed.order.id);               // → { order: { status: 'CANCELLED', … }, changed: true }
```

- `instrument` is `venue:symbol` as returned by `listMarkets`; `exchange` + `symbol` is the same thing in two parts.
- `mode` (`'paper'` | `'live'`) is required by the API; the SDK sends `'paper'` when you give none.
- Size the order with exactly one of `size` (base units) and `notional` (quote currency). Both are decimal strings; a
  JavaScript float is refused before any request (`ConfigurationError`).
- **`notional` is sized by the server**: it divides by the order's own price (limit, else trigger), else by the mark
  price it reads at that moment, and rounds **down** to the lot size. A stale mark is refused (`503 stale_data`); less
  than one lot is `422 below_min_size`. The answer carries the size that was used (`preview.resolved.size`,
  `placed.order.size`). `notionalUsdc` is the same field under the name of the quick start: the SDK sends it as
  `notional` and computes nothing.
- `getMarket(instrument).instrument` gives what an order must respect: `lotSize`, `tickSize`, `minOrderSize`,
  `minNotional`, `maxLeverage`.
- A preview says "no" in its answer, not with an exception: `wouldExecute` is false and `refusals` lists each refusal
  with its `stage` (`key`, `lock`, `mandate`, `risk`, `engine`) and `code`. `preview.account.equity` and
  `freeCollateral` are answered only to a key that also holds `wallet:read` or `positions:read`
  (`preview.account.withheld` is true otherwise). A key previews the order it could place: without a mandate bound to
  it, `previewOrder` throws `MandateRequired`.
- `previewOrder` and `engageKillSwitch` take no `Idempotency-Key` (the contract declares none): they are safe to repeat
  and are retried like a read.

A position is closed or reduced by its `id` from `getPositions()`; both are strictly reduce-only market orders:

```ts
const position = (await client.getPositions({ mode: 'paper' })).positions[0];
if (position) {
  await client.reducePosition(position.id, { fraction: '0.5' });
  await client.closePosition(position.id);
}
```

### Commands and the kill switch

```ts
import { AmbiguousCommand } from '@sp-wallet/trading-sdk';

try {
  const dry = await client.runCommand('LONG BTC-PERP 500 x2', { dryRun: true });   // kind: 'order', executed: false
  const pos = await client.runCommand('SHOW POSITIONS');                             // kind: 'query', data: the read answer
} catch (e) {
  if (e instanceof AmbiguousCommand) console.log(e.questions.map((q) => `${q.field}: ${q.options.join(' | ')}`));   // nothing was executed
  else throw e;
}

await client.engageKillSwitch('manual stop');   // blocks every NEW risk; cancels and exits still pass; only the owner releases it
```

The grammar is deterministic (no model). What a command leaves open (venue, leverage, …) comes from the owner's stored
defaults and from nothing else; when they do not settle it, the API answers `409 ambiguous_command` with the questions.

### Order states and `waitForOrder`

`order.status` is one of the twelve `ORDER_STATES` — a closed enum in the contract: `CREATED, VALIDATED,
AWAITING_APPROVAL, APPROVED, SUBMITTING, SUBMITTED, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, FAILED, UNKNOWN`.
Final states (`FINAL_ORDER_STATES`): `FILLED, CANCELLED, REJECTED, FAILED`; `order.final` is true exactly for those.
**`UNKNOWN` is not final and is not a failure**: the venue's answer is not known yet; keep reading the order.
`order.engineStatus` is the executing engine's own word for the same moment (`open`, `filled`, a swap state…): it is
informative — decide on `status`.

```ts
const { order, fills } = await client.waitForOrder(id, { waitTimeoutMs: 60_000, pollIntervalMs: 1_000 });
```

`waitForOrder` returns when the status is final (or when `until(order)` is true) and throws `WaitTimeout` when the time
elapses first — that is not an order failure either; `error.last` is the last answer.

## Errors

Every error extends `SPWalletError` and carries `code` (the API's `error` member), `message`, `status`, `requestId`
(`X-Request-Id`: the owner finds the call in the usage log with it) and, for mutating calls, `idempotencyKey`.

| Class | When |
|---|---|
| `ValidationError` | 400 `bad_request`, `invalid_order`, `invalid_cursor`, `parse_error`, `idempotency`, `stale_request`; 422 `no_orderbook`, `venue_rejected`, `below_min_size`, `no_position`, a refusal of the venue engine's own rules |
| `AuthenticationError` | 401 `unauthenticated` — missing, malformed, unknown, expired or revoked key (one answer for all) |
| `PermissionDenied` | 403 — `restricted`, `ip_not_allowed`, `key_limit_exceeded`, `not_your_order`… |
| ↳ `ScopeDenied` | 403 `insufficient_scope` — the key does not hold the operation's scope |
| ↳ `MandateRequired` | 403 `mandate_required` — no trading mandate is bound to the key |
| ↳ `MandateDenied` | 403 `mandate_denied` — the order is outside the mandate; `error.reasons` (`MANDATE_DENY_REASONS`: `ORDER_NOTIONAL_EXCEEDED`, `INSTRUMENT_NOT_ALLOWED`…) |
| ↳ `ExecutionDisabled` | 403 `execution_disabled` — live execution through the API is closed on this server; nothing was created |
| `RiskDenied` | 422 `risk_denied`, 423 `kill_switch_active` / `read_only_mode` — `error.failed` (ids of `RISK_CHECK_IDS`), `error.checks`, `error.killSwitch` |
| `NotFound` | 404 `unknown_order`, `unknown_instrument`, `unknown_venue`, `unknown_market`, `unknown_position`, `not_found` (a path that is not an operation)… |
| `Conflict` | 409 |
| ↳ `IdempotencyConflict` | 409 `idempotency_conflict` — the key was used with a different request |
| ↳ `AmbiguousSymbol` | 409 `ambiguous_symbol` — `error.candidates` lists the `venue:symbol` ids |
| ↳ `AmbiguousCommand` | 409 `ambiguous_command` — `error.questions`; nothing was executed |
| `RateLimited` | 429 `rate_limited`, `auth_throttled` — `error.retryAfterSeconds` |
| `NotImplementedError` ↳ `ExecutionNotWired` | 501 `execution_not_wired` — nothing was done |
| `ServerError` ↳ `ServiceUnavailable` | 5xx; 503 `signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`… |
| `NetworkError` ↳ `TimeoutError` | no answer (reads, previews) |
| `OutcomeUnknown` | a mutating call without a trustworthy answer — **not a failure**, see below |
| `WaitTimeout`, `WebhookVerificationError`, `ConfigurationError` | SDK-side |

**`error.order`**: when the server created the order before it refused it (a mandate or risk refusal, a refusal of the
venue engine), the error carries that order — state `REJECTED` or `FAILED` — so you know its id. It is `null` when the
call was refused before any order existed (nothing was created). The codes each operation can answer are in the
contract (`x-spw-errors`) and in the SDK as `OPERATION_ERRORS[operationId]`.

```ts
import { ExecutionDisabled, MandateDenied, MandateRequired, OutcomeUnknown, RateLimited, RiskDenied, ScopeDenied } from '@sp-wallet/trading-sdk';

try {
  await client.createOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notional: '100', mode: 'paper' });
} catch (e) {
  if (e instanceof OutcomeUnknown) { /* see "OutcomeUnknown" */ }
  else if (e instanceof MandateRequired) { /* the owner must bind an approved mandate to this key */ }
  else if (e instanceof MandateDenied) console.log(e.reasons, e.order?.id, e.order?.status);       // ['ORDER_NOTIONAL_EXCEEDED'] … 'REJECTED'
  else if (e instanceof RiskDenied) console.log(e.killSwitch ? 'kill switch' : e.failed, e.checks.map((c) => `${c.id}: ${c.observed} / ${c.limit}`));
  else if (e instanceof ExecutionDisabled) { /* live orders are closed on this server; paper is not affected */ }
  else if (e instanceof ScopeDenied) { /* the key lacks orders:execute */ }
  else if (e instanceof RateLimited) { /* wait e.retryAfterSeconds */ }
  else throw e;
}
```

## Retries and idempotency

- **Reads (`GET`)** are retried on a network error, a timeout, `429` (after `Retry-After`, else `RateLimit-Reset`) and
  `502 / 503 / 504`, with exponential backoff (0.5 s × 2ⁿ, capped at 8 s) and jitter (50–100 % of the step).
- **Mutating calls (`POST`, `DELETE`)** are retried **only because they carry an `Idempotency-Key`**. The SDK creates one
  UUIDv4 per logical call when you give none, serializes the body **once** in canonical form (sorted keys — the same
  rule as the server's request hash), and sends the **same key and the same bytes** on every retry. The server then
  runs the operation at most once: the same key with the same request returns the first answer
  (`responseMeta(r).idempotentReplay`), with a different request `409 idempotency_conflict`.
- The key is exposed three ways so that you can resume after a crash: pass your own (`{ idempotencyKey }`, generate it
  with `newIdempotencyKey()` and **persist it before sending**), read it from `responseMeta(result).idempotencyKey`, or
  from `error.idempotencyKey`.
- `previewOrder` and `engageKillSwitch` are `POST`s without an `Idempotency-Key` in the contract (repeating them changes
  nothing): they are retried like a read and fail with the ordinary errors, never `OutcomeUnknown`.
- Not retried: 400, 401, 403, 404, 409 (except `idempotency_in_progress`), 422, 423, 500, 501.

### `OutcomeUnknown`

A mutating call that ends without a trustworthy answer — timeout, connection lost, `500/502/504`, a `503` that does not
come from the API, the first request with this key still running, or an answer decided before the server looked at the
key (401, 403, 429) after an attempt without an answer — throws `OutcomeUnknown`. **It is not a failure**: the operation
may or may not have been executed.

```ts
try {
  await client.createOrder(order, { idempotencyKey });
} catch (e) {
  if (!(e instanceof OutcomeUnknown)) throw e;
  // 1. re-send the SAME call with the SAME key: the server returns the stored answer if it ran, or runs it once
  const result = await client.createOrder(order, { idempotencyKey: e.idempotencyKey! });
  // 2. or read the object: client.getOrder(id) / client.listOrders({ open: true })
  // Never re-send with a NEW key: that could execute the operation twice.
}
```

## Webhooks

The wallet signs every delivery: `X-SPW-Timestamp: <unix seconds>` and
`X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Verify over the **raw** body, before parsing:

```ts
import { constructWebhookEvent } from '@sp-wallet/trading-sdk';

const event = await constructWebhookEvent({
  secret: process.env.SP_WALLET_WEBHOOK_SECRET!,
  timestamp: req.headers['x-spw-timestamp'], signature: req.headers['x-spw-signature'],
  body: rawBody,                       // string or Uint8Array, exactly as received
});                                    // throws WebhookVerificationError; tolerance 300 s; constant-time comparison
```

`verifyWebhook(…)` returns a boolean instead. Delivery is at-least-once: deduplicate on `event.id`. Events:
`key.revoked`, `risk.kill_switch`, `agent.updated`, `order.updated` (one event per transition of an order).
A complete receiver: `packages/trading-sdk/examples/webhook-receiver.ts`.

## Examples

```bash
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/read-only.ts       # read-only tour
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/preview-order.ts   # a preview with every outcome handled
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/paper-order.ts     # PAPER: preview → place → wait → position → close
```

The three are executed against the real API by the integration test.

## Development

```bash
node packages/trading-sdk/scripts/gen-types.mts [--check]     # src/generated/openapi.ts from the OpenAPI document
node_modules/.bin/vitest run packages/trading-sdk             # unit tests + integration test
SPW_SDK_INTEGRATION=off node_modules/.bin/vitest run packages/trading-sdk   # unit tests only
```

The integration test starts the real API and the real signer on an own database (`scripts/test-stack.mts`), creates
keys, a paper account and paper mandates through the owner flow, calls every method and runs the whole **paper** write
path (preview → order → fill → reduce → close → resting order → cancel, replay and conflict, the refusals, the kill
switch, commands). No live order is sent: the live case stops at `execution_disabled`. It is **skipped** (reported as
skipped) when PostgreSQL is not reachable; a test whose venue cannot be read is skipped with that reason.

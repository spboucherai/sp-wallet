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
> **State of the API in this version.** Read operations are implemented. The 12 write operations are declared, validated
> and replay-checked by the server, then answer `501 execution_not_wired`. The SDK surfaces that as `ExecutionNotWired`
> (a `NotImplementedError`); it never reports a success that did not happen. The OpenAPI document declares no success
> schema for the write operations yet, so they return an untyped `WriteResult` (`Record<string, unknown>`).

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
| `getMarket(symbol)` | `GET /markets/{symbol}` | `markets:read` |
| `getOrderbook(symbol, { depth })` | `GET /markets/{symbol}/orderbook` | `markets:read` |
| `getCandles(symbol, { interval, limit })` | `GET /markets/{symbol}/candles` | `markets:read` |
| `getPortfolio()` | `GET /portfolio` | `wallet:read` |
| `getBalances({ network })` | `GET /balances` | `wallet:read` |
| `getActivity({ limit })` | `GET /activity` | `wallet:read` |
| `getPositions({ mode, venue })` | `GET /positions` | `positions:read` |
| `getRisk()` | `GET /risk` | `positions:read` |
| `listOrders({ mode, venue, open, limit })` | `GET /orders` | `orders:read` |
| `getOrder(id)` | `GET /orders/{id}` | `orders:read` |
| `waitForOrder(id, { waitTimeoutMs, pollIntervalMs, until })` | polls `GET /orders/{id}` | `orders:read` |
| `previewOrder(order)` | `POST /orders/preview` | `orders:prepare` |
| `createOrder(order)` | `POST /orders` | `orders:execute` + mandate |
| `cancelOrder(id)` | `DELETE /orders/{id}` | `orders:cancel` + mandate |
| `closePosition(id, { slippageBps })` | `POST /positions/{id}/close` | `positions:manage` + mandate |
| `reducePosition(id, { fraction, slippageBps })` | `POST /positions/{id}/reduce` | `positions:manage` + mandate |
| `listStrategies({ kind })` | `GET /strategies` | `strategies:read` |
| `createStrategy`, `backtestStrategy(id)`, `startStrategy(id)`, `stopStrategy(id)` | `POST /strategies…` | `strategies:manage` + mandate |
| `listAgents()` | `GET /agents` | `agents:read` |
| `createAgent`, `startAgent(id)`, `stopAgent(id)` | `POST /agents…` | `agents:manage` + mandate |
| `openapi()` | `GET /openapi.json` | any valid key |

`responseMeta(result)` gives the facts of the HTTP exchange behind any result: `status`, `requestId`, `idempotencyKey`,
`idempotentReplay`, `rateLimit { limit, remaining, resetSeconds }`, `attempts`.

**Pagination.** The API does not paginate in this version: lists take a `limit`, and `listMarkets` answers `total` and
`truncated` so a cut list is visible. There is therefore no pagination helper.

### Orders

```ts
await client.previewOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.01', price: '60000', mode: 'paper' });
```

- `instrument` is `venue:symbol` as returned by `listMarkets`; `exchange` + `symbol` is the same thing in two parts.
- `mode` (`'paper'` | `'live'`) is required by the API; the SDK sends `'paper'` when you give none.
- `size` is in base units, a decimal string. A JavaScript number is refused before any request (`ConfigurationError`).
- `notionalUsdc` is a **client-side convenience, not a field of the API**: the SDK reads `GET /markets/{instrument}`
  (scope `markets:read`), and sends `size = floor(notional / mark price, lot size)` computed with exact integer
  arithmetic (`sizeFromNotional`). It refuses to size from a stale or missing mark price.

### Order states and `waitForOrder`

`ORDER_STATES`: `CREATED, VALIDATED, AWAITING_APPROVAL, APPROVED, SUBMITTING, SUBMITTED, PARTIALLY_FILLED, FILLED,
CANCELLED, REJECTED, FAILED, UNKNOWN`. Final states (`TERMINAL_ORDER_STATES`): `FILLED, CANCELLED, REJECTED, FAILED`.
**`UNKNOWN` is not final and is not a failure**: the venue's answer is not known yet; keep reading the order.

```ts
const { order } = await client.waitForOrder(id, { waitTimeoutMs: 60_000, pollIntervalMs: 1_000 });
```

`waitForOrder` throws `WaitTimeout` when the time elapses first — that is not an order failure either; `error.last` is
the last answer. The read side currently reports the statuses of the older tables for existing orders (`open`,
`pending`, `filled`, swap states…): a status that is not one of the twelve states is judged by the server's own `final`
flag.

## Errors

Every error extends `SPWalletError` and carries `code` (the API's `error` member), `message`, `status`, `requestId`
(`X-Request-Id`: the owner finds the call in the usage log with it) and, for mutating calls, `idempotencyKey`.

| Class | When |
|---|---|
| `ValidationError` | 400 `bad_request`, `idempotency`, `stale_request`; 422 `no_orderbook`, `venue_rejected` |
| `AuthenticationError` | 401 `unauthenticated` — missing, malformed, unknown, expired or revoked key (one answer for all) |
| `PermissionDenied` | 403 — `restricted`, `ip_not_allowed`, `key_path_forbidden`… |
| ↳ `ScopeDenied` | 403 `insufficient_scope` — the key does not hold the operation's scope |
| ↳ `MandateRequired` | 403 `mandate_required` — no trading mandate is bound to the key |
| `NotFound` | 404 `unknown_order`, `unknown_instrument`, `unknown_venue`… |
| `Conflict` | 409 |
| ↳ `IdempotencyConflict` | 409 `idempotency_conflict` — the key was used with a different request |
| ↳ `AmbiguousSymbol` | 409 `ambiguous_symbol` — `error.candidates` lists the `venue:symbol` ids |
| `RateLimited` | 429 `rate_limited`, `auth_throttled` — `error.retryAfterSeconds` |
| `NotImplementedError` ↳ `ExecutionNotWired` | 501 `execution_not_wired` — nothing was done |
| `ServerError` ↳ `ServiceUnavailable` | 5xx; 503 `signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`… |
| `NetworkError` ↳ `TimeoutError` | no answer (reads) |
| `OutcomeUnknown` | a mutating call without a trustworthy answer — **not a failure**, see below |
| `WaitTimeout`, `WebhookVerificationError`, `ConfigurationError` | SDK-side |

```ts
import { AmbiguousSymbol, ExecutionNotWired, MandateRequired, OutcomeUnknown, RateLimited, ScopeDenied } from '@sp-wallet/trading-sdk';

try {
  await client.createOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01', mode: 'live' });
} catch (e) {
  if (e instanceof OutcomeUnknown) { /* see "OutcomeUnknown" */ }
  else if (e instanceof MandateRequired) { /* the owner must bind an approved mandate to this key */ }
  else if (e instanceof ExecutionNotWired) { /* this server does not execute yet; nothing was done */ }
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
- Not retried: 400, 401, 403, 404, 409 (except `idempotency_in_progress`), 500, 501.

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
`key.revoked`, `risk.kill_switch`, `agent.updated` (emitted), `order.updated` (defined, not emitted yet).
A complete receiver: `packages/trading-sdk/examples/webhook-receiver.ts`.

## Examples

```bash
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/read-only.ts       # read-only tour
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/preview-order.ts   # a preview with every outcome handled
```

## Development

```bash
node packages/trading-sdk/scripts/gen-types.mts [--check]     # src/generated/openapi.ts from the OpenAPI document
node_modules/.bin/vitest run packages/trading-sdk             # unit tests + integration test
SPW_SDK_INTEGRATION=off node_modules/.bin/vitest run packages/trading-sdk   # unit tests only
```

The integration test starts the real API and the real signer on an own database (`scripts/test-stack.mts`), creates
keys through the owner flow and calls every method. It is **skipped** (reported as skipped) when PostgreSQL is not
reachable.

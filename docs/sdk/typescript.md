# SP Trading API — TypeScript SDK (`@sp-wallet/trading-sdk`)

Official client of the SP Trading API (`/api/v1/trading`, contract: [`docs/openapi/trading-v1.json`](../openapi/trading-v1.json),
reference: [`docs/TRADING-API-OPENAPI.md`](../TRADING-API-OPENAPI.md)). Source: `packages/trading-sdk/`.

- Zero runtime dependency: global `fetch` and WebCrypto. Node ≥ 20 and browsers. ESM + type declarations.
- Every answer is typed; the types are **generated** from the OpenAPI document (`scripts/gen-types.mts`), and a test fails
  when the committed types are not what the document gives.
- Money, prices and sizes are decimal **strings** end to end. The SDK never converts them to a `number`.
- The API key is never logged, never part of an error, never shown by `console.log(client)`.

> **Execution requires an owner-approved mandate.** Placing an order and closing or reducing a position need — besides
> the scope — an API key **bound to a trading mandate approved by the wallet's owner**. Without one the API refuses the
> call (`403 mandate_required` → `MandateRequired`); an order outside the mandate is `MandateDenied`. A scope alone never
> lets a key execute. Managing agents and strategies needs **no** mandate on the key (research and paper sign nothing):
> an agent goes live only under its *own* mandate, approved by the owner.
>
> **State of the API in this version.** All 46 operations of the contract are implemented and answer typed results.
> **Paper** orders are simulated by the wallet's paper engine against the venue's real order book. **Live** orders
> additionally need `SPW_TRADING_API_EXECUTION=on` on the server (default off → `403 execution_disabled` →
> `ExecutionDisabled`) and the wallet's mainnet locks. Spot orders and live GMX orders are the owner's (passkey): a key is
> refused them.

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
| `listNfts({ network, collection, status, q, sort, spam, limit, cursor })`, `iterateNfts({ … }, { maxItems })` | `GET /nfts` | `wallet:read` |
| `getNft(key)` | `GET /nfts/item` | `wallet:read` |
| `getNftActivity({ key, limit, cursor, type })` | `GET /nfts/activity` | `wallet:read` |
| `getNftMarket({ network, address, tokenId })` | `GET /nfts/market` | `markets:read` |
| `getNftMarketEvents({ network, address, tokenId, provider, type, after, before, cursor, limit })` | `GET /nfts/market/events` | `markets:read` |
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
| `createStrategy({ kind, path, agentId })` → strategy · `backtestStrategy(id)` → job · `startStrategy(id, { mode })`, `stopStrategy(id)` → agent | `POST /strategies…` | `strategies:manage` |
| `listAgents()` | `GET /agents` | `agents:read` |
| `listAgentTemplates()`, `getAgent(id)` | `GET /agents/templates`, `/agents/{id}` | `agents:read` |
| `listAgentSignals(id, { mode, limit, before })`, `listAgentJournal(id, { mode, … })`, `listAgentOrders(id, { mode, open, … })`, `getAgentPerformance(id, { mode })` | `GET /agents/{id}/signals`, `journal`, `orders`, `performance` — **one mode per call** | `agents:read` |
| `getJob(id)`, `waitForJob(id, { waitTimeoutMs, pollIntervalMs })` | `GET /jobs/{id}` | `agents:read` |
| `createAgent({ template, name, … })`, `startAgent(id, { mode })`, `pauseAgent(id)`, `stopAgent(id)` → agent · `backtestAgent(id, { hours })` → job | `POST /agents…` | `agents:manage` |
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
  const r = await client.runCommand('LONG BTC-PERP 500 x2', { dryRun: true });
  // the answer is a discriminated union: narrow on `kind`, and for an order on `executed`
  if (r.kind === 'order' && !r.executed) console.log(r.order.instrument, r.order.notional, r.hash);   // dry run: the CANONICAL order
  if (r.kind === 'order' && r.executed) console.log(r.order.id, r.order.status, r.canonical.instrument); // executed: the placed order
  if (r.kind === 'query') console.log(r.query, r.data);                                                 // SHOW …
  if (r.kind === 'control') console.log(r.control.type, r.executed);                                    // CANCEL, KILL, STOP ALL AGENTS
} catch (e) {
  if (e instanceof AmbiguousCommand) console.log(e.questions.map((q) => `${q.field}: ${q.options.join(' | ')}`));   // nothing was executed
  else throw e;
}

await client.engageKillSwitch('manual stop');   // blocks every NEW risk; cancels and exits still pass; only the owner releases it
```

The grammar is deterministic (no model). What a command leaves open (venue, leverage, …) comes from the owner's stored
defaults and from nothing else; when they do not settle it, the API answers `409 ambiguous_command` with the questions.

### Agents

```ts
const { templates } = await client.listAgentTemplates();                       // family, engine, the modes each can run in
const { agent } = await client.createAgent({ template: 'market-making', name: 'MM BTC', venues: ['hyperliquid'], universe: ['BTC'] });
await client.startAgent(agent.id, { mode: 'paper' });                          // research and paper sign nothing

// every per-agent read is ONE mode per call: `mode` is required, and an answer never mixes two (`all` is refused)
const signals = await client.listAgentSignals(agent.id, { mode: 'paper', limit: 50 });
const journal = await client.listAgentJournal(agent.id, { mode: 'paper' });
const orders = await client.listAgentOrders(agent.id, { mode: 'paper', open: true });
const performance = await client.getAgentPerformance(agent.id, { mode: 'paper' });   // computed from paper records only; never a backtest

const { job } = await client.backtestAgent(agent.id, { hours: 24 });           // asynchronous
const done = await client.waitForJob(job.id, { waitTimeoutMs: 120_000 });      // done | failed | cancelled; WaitTimeout is not a failure
await client.pauseAgent(agent.id); await client.stopAgent(agent.id);           // stop is always allowed
```

- **`mode` on the reads.** On the wire `mode` is optional: the server answers the mode the agent is in now (for a stopped
  agent, the one it last ran in) and says which in `mode`. The SDK makes it a **required** argument, so that code never reads
  paper figures believing they are live ones; `open` exists on `listAgentOrders` only.
- **`createAgent({ mode })`** is `'research'` (default: created, not running) or `'paper'`: an agent from a stream or
  supervisor template starts on paper at once; a bar agent (or `kind: 'perp'`) is created and not started — register and
  backtest a strategy version, then `startAgent`. `'live'` is refused (`400 bad_request`).
- **Paper.** Starting a perp agent on paper creates its *paper trading mandate* (nothing is signed): its orders go through
  the same order service, risk engine and kill switch as every other order. The key needs `agents:manage`, and a key
  restricted to other venues or instruments gets `403 restricted`; a halted paper account answers `409 halted`.
- **Live.** `startAgent(id, { mode: 'live' })` succeeds only when a mandate the **owner** approved for that agent with the
  passkey is in force — for a perp agent a trading mandate, which only the owner activates. Otherwise `409 mandate_required`.
  A key can never approve one. Families that cannot go live answer `409 live_unavailable`.
- **Errors.** Every 409 of the agent operations is a `Conflict`; read `e.code` (`mandate_required`, `halted`, `bad_state`,
  `live_unavailable`, `no_strategy`, `no_report`, `bad_report`). `MandateRequired` (403) is about the *key's* mandate on the
  order operations, not about an agent's.
- **One kill switch.** There is no agents-side switch: `engageKillSwitch(reason)` engages the risk engine's, which stops every agent's
  new risk too. Releasing it is the owner's act, in the app. A spot agent is created in the owner's app (`403 owner_required`).

### Spot orders (owner session only)

A key is refused spot execution (`403`). For the owner, a spot order is a swap proposal approved with the passkey:
a SELL names `size` (the quantity sold), a BUY names `notional` — the amount of the quote asset to spend, because a swap
is exact-input: `{ instrument: 'spot:ETH-USDC', side: 'buy', type: 'market', notional: '100', mode: 'live' }`.

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
| `NotImplementedError` ↳ `ExecutionNotWired` | 501 `execution_not_wired` — an operation this server has not connected (an owner's spot order without the swap flow); nothing was done |
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

## Key rotation and the trading mandate

A trading mandate names **one principal — the key id it was approved for** — and a rotation gives the key a new id. The
rotation therefore does **not** carry the mandate: the new key keeps the scopes, limits, restrictions and expiry, and is
**unbound**. Until the owner approves a mandate for the new id and binds it, `createOrder`, `closePosition` and
`reducePosition` throw `MandateRequired` (and `previewOrder` too); reads, cancels of its own orders, the kill switch and
agent management keep working. The answer of the rotation says so:
`{ key: { mandateId: null, inertScopes: […] }, secret, revoked, mandate: { carried: false, mandateId: '<old mandate>', code: 'mandate_principal_mismatch', note } }`.

```ts
try { await client.createOrder(order); }
catch (e) {
  if (e instanceof MandateRequired) { /* after a rotation: ask the owner for a mandate for THIS key id, then retry — nothing was created */ }
  else throw e;
}
```

The owner's side of it (owner session and passkey — nothing a key can do):

```bash
# 1. a mandate for the NEW key id: created, then approved (a live mandate is approved with the passkey at the signer)
POST /api/v1/mandates                         { "principal": { "kind": "api_key", "id": "<new key id>" }, "mode": "paper", "accountIds": ["…"], … }
POST /api/v1/mandates/<mandate id>/approve    { }                      # live: /approve/prepare first, then the passkey assertion
# 2. bind it to the key (binding gives the key authority: passkey)
POST /api/v1/developer/keys/<new key id>/update/prepare   { "changes": { "mandateId": "<mandate id>" } }
POST /api/v1/developer/keys/<new key id>/update           { "intentId": "…", "assertion": { … } }
```

In the app: Developer → the key → *Trading mandate* → *New mandate*.

## Streaming

Live market data over one websocket: quotes, order books, trades, candles and venue statuses. Read-only (scope
`markets:read`), same key, same restrictions (a channel of a venue or instrument outside the key's restrictions is refused,
per subscription). `SPWalletStream` is exported by the package next to `SPWallet`; it needs a global `WebSocket` (Node >= 22,
browsers) or the `WebSocket` option (the `ws` package).

```ts
import { SPWalletStream, OrderBook, StreamError } from '@sp-wallet/trading-sdk';

const stream = new SPWalletStream({ baseUrl: 'https://wallet.example' });      // the key: SP_WALLET_API_KEY, in the Authorization header
stream.on('close', (c) => console.log(`closed (${c.code}); ${c.willReconnect ? 'reconnecting' : 'stopped'}`));
stream.on('error', (e) => console.log(`stream error: ${e.code}`));

await stream.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'status', id: 'hyperliquid' }]);
for await (const m of stream) {                                                // or stream.on('quote', …)
  if (m.type === 'quote') console.log(m.id, m.bid, m.ask, m.mark, m.stale);    // decimal strings; `stale` is the server's verdict
}
```

- **Channels**: `quote`, `book` (`depth`), `trades`, `candles` (`interval`), `status` (`id: '<venue>'` or `'*'`). Ids are
  `<venue>:<instrument>` (`hyperliquid:BTC`, `dydx:BTC-USD`, `spot:BTC`).
- **Reconnection** is on by default (`reconnect: false` to turn it off): exponential backoff with jitter between
  `backoffMinMs` (500) and `backoffMaxMs` (30 000); after a reconnection the client subscribes again to everything and the
  server sends fresh snapshots — a handler never has to do it. `close` events carry `willReconnect`. A refusal that a retry
  cannot fix (no `markets:read`, revoked key, unknown instrument) is a `StreamError` with the server's `code`, and is not retried.
- **Order books**: feed every `book` message to an `OrderBook`; `apply()` returns `false` on a sequence hole or a checksum
  mismatch — call `stream.resync(channel)` and the server restarts the book from a snapshot.
- **Slow consumers**: quotes are conflated and a `dropped` message says what was skipped; the iterator's own buffer is
  bounded by `bufferSize`.
- A stream connection writes **no row in the key's usage log** (the ticket request does).

### Browsers: the ticket flow

A browser cannot set a header on a websocket, and the key must never reach it. Your backend asks for a single-use ticket
(30 s) with the key; the browser connects with the ticket only:

```ts
// backend (holds the key) — a route of YOUR server, behind YOUR authentication
app.post('/stream-ticket', async () => {
  const r = await fetch(`${WALLET}/api/v1/trading/stream/ticket`, { method: 'POST', headers: { authorization: `Bearer ${process.env.SP_WALLET_API_KEY}`, 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`ticket refused: ${r.status}`);
  return { ticket: (await r.json()).ticket };          // { ticket, expiresAt, ttlMs, url, protocol }
});

// browser — no key anywhere; a new ticket is asked at every (re)connection
const stream = new SPWalletStream({
  baseUrl: 'https://wallet.example',
  ticket: async () => (await (await fetch('/stream-ticket', { method: 'POST' })).json()).ticket,
});
await stream.subscribe({ type: 'quote', id: 'hyperliquid:BTC' });
```

The ticket carries the key's scope and restrictions, works once, and is refused when mixed with another credential. In Node,
`auth: 'ticket'` makes the client ask for the ticket itself with its key (useful behind a proxy that strips headers on upgrade).

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
`key.revoked`, `risk.kill_switch`, `agent.updated`, `order.updated` (one event per transition of an order),
`risk.proposal`. A complete receiver: `packages/trading-sdk/examples/webhook-receiver.ts`.

## Examples

```bash
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/read-only.ts       # read-only tour
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/preview-order.ts   # a preview with every outcome handled
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/paper-order.ts     # PAPER: preview → place → wait → position → close
SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/stream-quotes.ts   # live quotes over the websocket, with reconnection
```

The four are executed against the real API by the integration tests.

## Development

```bash
node packages/trading-sdk/scripts/gen-types.mts [--check]     # src/generated/openapi.ts from the OpenAPI document
node_modules/.bin/vitest run packages/trading-sdk             # unit tests + integration test
SPW_SDK_INTEGRATION=off node_modules/.bin/vitest run packages/trading-sdk   # unit tests only
```

The integration test starts the real API and the real signer on an own database (`scripts/test-stack.mts`), creates
keys, a paper account and paper mandates through the owner flow, calls every method and runs the whole **paper** write
path (preview → order → fill → reduce → close → resting order → cancel, replay and conflict, the refusals, the kill
switch, commands) and an agent on paper (create from a template → start → signals, journal, orders, performance → pause → backtest job → stop). No live order is sent: the live case stops at `execution_disabled`. It is **skipped** (reported as
skipped) when PostgreSQL is not reachable; a test whose venue cannot be read is skipped with that reason.

## NFT reads

Five read operations; **no NFT write exists in the API** (transfers are the owner's, with the passkey; no marketplace action is built). `listNfts` / `getNft` / `getNftActivity` read the wallet's own inventory. `getNftMarket` and `getNftMarketEvents` read market data of ANY item named by its chain identifiers and answer **one row per source** — a source without its key answers `status.state: 'needs_key'` with `status.unlockedBy`; nothing is filled in. Amounts are exact base-unit strings in a currency identified by network + mint / contract (`price.amount`, `price.currency`); a `tokenId` is a string (it can be as large as 2^256 − 1). NFTs carry no value: `valuation.state` / `value.state` is `'unavailable'`. A fiat `rates` entry can be `withheld` for a key (licence of the price source).

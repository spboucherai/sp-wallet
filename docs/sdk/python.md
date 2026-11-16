# SP Trading API — Python SDK (`sp-wallet-python`, import `sp_wallet`)

Official client of the SP Trading API (`/api/v1/trading`, contract: [`docs/openapi/trading-v1.json`](../openapi/trading-v1.json),
reference: [`docs/TRADING-API-OPENAPI.md`](../TRADING-API-OPENAPI.md)). Source: `sdk/python/`.

- Python ≥ 3.10. `httpx` (a synchronous client `SPWallet` and an asynchronous client `AsyncSPWallet`) and `pydantic` v2.
  `py.typed` is shipped.
- Every answer is a typed pydantic model, **generated** from the OpenAPI document (`scripts/gen_models.py`). A test fails
  when the committed models are not what the document gives, and a second test walks every schema of the document
  against the model classes.
- Money, prices and sizes are decimal **strings** end to end (`str`), exactly as the API sends them; `to_decimal()` and
  `decimal_str()` convert from and to `decimal.Decimal`. **A `float` is never produced and never accepted**: the few
  members the API sends as JSON numbers are parsed as `Decimal`.
- The API key is never logged, never part of an error or a traceback, never in `repr(client)`.

> **Execution requires an owner-approved mandate.** Placing or cancelling an order, closing or reducing a position,
> and managing strategies and agents need — besides the scope — an API key **bound to a trading mandate approved by the
> wallet's owner**. Without one the API refuses the call (`403 mandate_required` → `MandateRequired`). A scope alone never
> lets a key execute.
>
> **State of the API in this version.** Read operations are implemented. The 12 write operations are declared, validated
> and replay-checked by the server, then answer `501 execution_not_wired`. The SDK raises `ExecutionNotWired` (a
> `sp_wallet.NotImplementedError`); it never reports a success that did not happen. The OpenAPI document declares no
> success schema for the write operations yet, so they return a `WriteResult` whose members are untyped.

## Install (from the repository)

The package is not published to PyPI. Install it from its path:

```bash
pip install /path/to/sp-wallet/sdk/python          # or: uv add /path/to/sp-wallet/sdk/python
```

## Quick start

```python
from sp_wallet import SPWallet

client = SPWallet(api_key="spw_live_…")          # or SPWallet() with the environment variable SP_WALLET_API_KEY

client.get_balances()
client.get_positions()
client.preview_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)
```

Asynchronous — the same methods, awaited:

```python
from sp_wallet import AsyncSPWallet

async with AsyncSPWallet() as client:
    balances = await client.get_balances()
```

| Argument | Default | |
|---|---|---|
| `api_key` | env `SP_WALLET_API_KEY` | `spw_live_…`, created by the owner in the Developer screen |
| `base_url` | env `SP_WALLET_BASE_URL`, else `https://wallet.spboucher.ai` | `http://` is accepted for `localhost` only (or with `allow_insecure_http=True`) |
| `timeout` | `30.0` | seconds, per attempt |
| `max_retries` | `2` | retries after the first attempt |
| `user_agent` | — | appended to `sp-wallet-python/<version>` |
| `send_timestamp` | `False` | send `X-SPW-Timestamp` with mutating calls (the server refuses a call more than 300 s from its clock) |
| `max_retry_delay` | `30.0` | longest wait accepted before a retry; a 429 asking for more is raised at once |
| `http_client` | — | your own `httpx.Client` / `httpx.AsyncClient` (proxy, TLS); not closed by the SDK |

`client.with_options(timeout=…, max_retries=…)` returns the same client with other settings for one call, e.g.
`client.with_options(max_retries=0).create_order(…)`. Use the client as a context manager, or call `close()` /
`await aclose()`.

## Methods

| Method | Returns | Operation | Scope |
|---|---|---|---|
| `list_markets(venue=, kind=, q=, limit=)` | `MarketList` | `GET /markets` | `markets:read` |
| `get_market(symbol)` | `MarketDetail` | `GET /markets/{symbol}` | `markets:read` |
| `get_orderbook(symbol, depth=)` | `Orderbook` | `GET /markets/{symbol}/orderbook` | `markets:read` |
| `get_candles(symbol, interval=, limit=)` | `Candles` | `GET /markets/{symbol}/candles` | `markets:read` |
| `get_portfolio()` | `Portfolio` | `GET /portfolio` | `wallet:read` |
| `get_balances(network=)` | `Balances` | `GET /balances` | `wallet:read` |
| `get_activity(limit=)` | `Activity` | `GET /activity` | `wallet:read` |
| `get_positions(mode=, venue=)` | `Positions` | `GET /positions` | `positions:read` |
| `get_risk()` | `Risk` | `GET /risk` | `positions:read` |
| `list_orders(mode=, venue=, open=, limit=)` | `Orders` | `GET /orders` | `orders:read` |
| `get_order(order_id)` | `OrderDetail` | `GET /orders/{id}` | `orders:read` |
| `wait_for_order(order_id, timeout=, poll_interval=, until=)` | `OrderDetail` | polls `GET /orders/{id}` | `orders:read` |
| `preview_order(…)` | `WriteResult` | `POST /orders/preview` | `orders:prepare` |
| `create_order(…)` | `WriteResult` | `POST /orders` | `orders:execute` + mandate |
| `cancel_order(order_id)` | `WriteResult` | `DELETE /orders/{id}` | `orders:cancel` + mandate |
| `close_position(position_id, slippage_bps=)` | `WriteResult` | `POST /positions/{id}/close` | `positions:manage` + mandate |
| `reduce_position(position_id, fraction=, slippage_bps=)` | `WriteResult` | `POST /positions/{id}/reduce` | `positions:manage` + mandate |
| `list_strategies(kind=)` | `Strategies` | `GET /strategies` | `strategies:read` |
| `create_strategy(kind=, path=, agent_id=)`, `backtest_strategy(id, symbols=, interval=)`, `start_strategy(id, mode=, agent_id=)`, `stop_strategy(id, reason=)` | `WriteResult` | `POST /strategies…` | `strategies:manage` + mandate |
| `list_agents()` | `Agents` | `GET /agents` | `agents:read` |
| `create_agent(kind=, name=, universe=, mission=, interval=, mode=)`, `start_agent(id, mode=)`, `stop_agent(id, reason=)` | `WriteResult` | `POST /agents…` | `agents:manage` + mandate |
| `openapi()` | `OpenApiDocument` | `GET /openapi.json` | any valid key |

Every mutating method also takes `idempotency_key=`.

Models (`sp_wallet.models`) use snake_case attributes for the API's camelCase members (`portfolio.totals.wallet_usd`,
`position.entry_price`); `result.to_dict()` gives the answer with the API's own names. Members the contract does not
name are kept (`model_extra`, also reachable as attributes). `result.meta` gives the facts of the HTTP exchange:
`status`, `request_id`, `idempotency_key`, `idempotent_replay`, `rate_limit` (`limit`, `remaining`, `reset_seconds`),
`attempts`. An answer that does not match the contract raises `ServerError` (`code == "invalid_response"`) instead of
returning a half-typed object.

**Pagination.** The API does not paginate in this version: lists take a `limit`, and `list_markets` answers `total` and
`truncated` so a cut list is visible. There is therefore no pagination helper.

### Decimals

```python
from decimal import Decimal
from sp_wallet import to_decimal, decimal_str, size_from_notional

book = client.get_orderbook("hyperliquid:BTC", depth=1)
bid, ask = to_decimal(book.bids[0][0]), to_decimal(book.asks[0][0])     # str → Decimal, exact
client.preview_order(instrument="hyperliquid:BTC", side="buy", order_type="limit",
                     size=Decimal("0.01"), price=(bid + ask) / 2)        # Decimal, int or str — never float
size_from_notional("100", "64907", "0.00001")                            # "0.00154", rounded down
```

Passing a `float` anywhere an amount is expected raises `ConfigurationError` before any request.

### Orders

- `instrument` is `venue:symbol` as returned by `list_markets`; `exchange=` + `symbol=` is the same thing in two parts.
- `order_type` is the API's `type`: `limit`, `market`, `stop_market`, `stop_limit`, `take_profit_market`,
  `take_profit_limit`.
- `mode` (`"paper"` | `"live"`) is required by the API; the SDK sends `"paper"` when you give none.
- `size` is in base units. `notional_usdc` is a **client-side convenience, not a field of the API**: the SDK reads
  `GET /markets/{instrument}` (scope `markets:read`) and sends `size = floor(notional / mark price, lot size)` in exact
  decimal arithmetic. It refuses to size from a stale or missing mark price.
- Request bodies are validated locally with the constraints of the contract (enums, patterns, bounds): a wrong argument
  raises `ConfigurationError` and nothing is sent.

### Order states and `wait_for_order`

`ORDER_STATES`: `CREATED, VALIDATED, AWAITING_APPROVAL, APPROVED, SUBMITTING, SUBMITTED, PARTIALLY_FILLED, FILLED,
CANCELLED, REJECTED, FAILED, UNKNOWN`. Final states (`TERMINAL_ORDER_STATES`): `FILLED, CANCELLED, REJECTED, FAILED`.
**`UNKNOWN` is not final and is not a failure**: the venue's answer is not known yet; keep reading the order.

```python
detail = client.wait_for_order(order_id, timeout=60, poll_interval=1)
```

`wait_for_order` raises `WaitTimeout` when the time elapses first — that is not an order failure either; `error.last`
is the last answer. The read side currently reports the statuses of the older tables for existing orders (`open`,
`pending`, `filled`, swap states…): a status that is not one of the twelve states is judged by the server's own `final`
flag.

## Errors

Every error extends `SPWalletError` and carries `code` (the API's `error` member), `message`, `status`, `request_id`
(`X-Request-Id`: the owner finds the call in the usage log with it) and, for mutating calls, `idempotency_key`.

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
| `RateLimited` | 429 `rate_limited`, `auth_throttled` — `error.retry_after` (seconds) |
| `sp_wallet.NotImplementedError` ↳ `ExecutionNotWired` | 501 `execution_not_wired` — nothing was done |
| `ServerError` ↳ `ServiceUnavailable` | 5xx; 503 `signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`… |
| `NetworkError` ↳ `sp_wallet.TimeoutError` | no answer (reads) |
| `OutcomeUnknown` | a mutating call without a trustworthy answer — **not a failure**, see below |
| `WaitTimeout`, `WebhookVerificationError`, `ConfigurationError` | SDK-side |

`sp_wallet.NotImplementedError` and `sp_wallet.TimeoutError` are this package's classes, not the builtins of the same
name: write `except sp_wallet.NotImplementedError` (or `except ExecutionNotWired`).

```python
from sp_wallet import ExecutionNotWired, MandateRequired, OutcomeUnknown, RateLimited, ScopeDenied

try:
    client.create_order(instrument="hyperliquid:BTC", side="buy", order_type="market", size="0.01", mode="live")
except OutcomeUnknown as e:
    ...                       # see "OutcomeUnknown"
except MandateRequired:
    ...                       # the owner must bind an approved mandate to this key
except ExecutionNotWired:
    ...                       # this server does not execute yet; nothing was done
except ScopeDenied:
    ...                       # the key lacks orders:execute
except RateLimited as e:
    ...                       # wait e.retry_after seconds
```

## Retries and idempotency

- **Reads (`GET`)** are retried on a network error, a timeout, `429` (after `Retry-After`, else `RateLimit-Reset`) and
  `502 / 503 / 504`, with exponential backoff (0.5 s × 2ⁿ, capped at 8 s) and jitter (50–100 % of the step).
- **Mutating calls (`POST`, `DELETE`)** are retried **only because they carry an `Idempotency-Key`**. The SDK creates one
  UUIDv4 per logical call when you give none, serializes the body **once** in canonical form (sorted keys — byte for
  byte the server's canonical form), and sends the **same key and the same bytes** on every retry. The server then runs
  the operation at most once: the same key with the same request returns the first answer
  (`result.meta.idempotent_replay`), with a different request `409 idempotency_conflict`.
- The key is exposed three ways so that you can resume after a crash: pass your own (`idempotency_key=`, generate it
  with `new_idempotency_key()` and **persist it before sending**), read it from `result.meta.idempotency_key`, or from
  `error.idempotency_key`.
- Not retried: 400, 401, 403, 404, 409 (except `idempotency_in_progress`), 500, 501.

### `OutcomeUnknown`

A mutating call that ends without a trustworthy answer — timeout, connection lost, `500/502/504`, a `503` that does not
come from the API, the first request with this key still running, or an answer decided before the server looked at the
key (401, 403, 429) after an attempt without an answer — raises `OutcomeUnknown`. **It is not a failure**: the operation
may or may not have been executed.

```python
key = new_idempotency_key()           # persist it
try:
    client.create_order(**order, idempotency_key=key)
except OutcomeUnknown as e:
    # 1. re-send the SAME call with the SAME key: the server returns the stored answer if it ran, or runs it once
    result = client.create_order(**order, idempotency_key=e.idempotency_key)
    # 2. or read the object: client.get_order(order_id) / client.list_orders(open=True)
    # Never re-send with a NEW key: that could execute the operation twice.
```

## Webhooks

The wallet signs every delivery: `X-SPW-Timestamp: <unix seconds>` and
`X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Verify over the **raw** body, before parsing:

```python
from sp_wallet import construct_webhook_event, WebhookVerificationError

event = construct_webhook_event(
    secret=os.environ["SP_WALLET_WEBHOOK_SECRET"],
    timestamp=request.headers.get("x-spw-timestamp"), signature=request.headers.get("x-spw-signature"),
    body=raw_body,                    # bytes or str, exactly as received
)                                     # raises WebhookVerificationError; tolerance 300 s; hmac.compare_digest
```

`verify_webhook(…)` returns a boolean instead. Delivery is at-least-once: deduplicate on `event["id"]`. Events:
`key.revoked`, `risk.kill_switch`, `agent.updated` (emitted), `order.updated` (defined, not emitted yet).
A complete receiver: `sdk/python/examples/webhook_receiver.py`.

## Examples

```bash
cd sdk/python && uv sync
SP_WALLET_API_KEY=spw_live_… uv run python examples/read_only.py       # read-only tour
SP_WALLET_API_KEY=spw_live_… uv run python examples/async_read.py      # the asynchronous client
SP_WALLET_API_KEY=spw_live_… uv run python examples/preview_order.py   # a preview with every outcome handled
```

## Development

```bash
cd sdk/python
uv sync
uv run python scripts/gen_models.py [--check]    # src/sp_wallet/models.py from the OpenAPI document
uv run python scripts/gen_sync.py [--check]      # src/sp_wallet/_client.py (sync) from _async_client.py
uv run ruff check
uv run pytest                                    # unit tests + integration test
SPW_SDK_INTEGRATION=off uv run pytest            # unit tests only
```

The synchronous client is generated from the asynchronous one: one implementation, the same behaviour by construction.
The integration test starts the real API and the real signer on an own database
(`packages/trading-sdk/scripts/test-stack.mts`; it needs the repository's `node_modules` and PostgreSQL), creates keys
through the owner flow and calls every method with both clients. It is **skipped** (reported as skipped) when
PostgreSQL is not reachable.

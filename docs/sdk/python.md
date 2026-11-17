# SP Trading API — Python SDK (`sp-wallet-python`, import `sp_wallet`)

Official client of the SP Trading API (`/api/v1/trading`, contract: [`docs/openapi/trading-v1.json`](../openapi/trading-v1.json),
reference: [`docs/TRADING-API-OPENAPI.md`](../TRADING-API-OPENAPI.md)). Source: `sdk/python/`.

- Python ≥ 3.10. `httpx` (a synchronous client `SPWallet` and an asynchronous client `AsyncSPWallet`) and `pydantic` v2.
  `py.typed` is shipped.
- Every answer is a typed pydantic model, **generated** from the OpenAPI document (`scripts/gen_models.py`). A test fails
  when the committed models are not what the document gives, and a second test walks every schema of the document
  against the model classes.
- Money, prices and sizes are decimal **strings** end to end (`str`), exactly as the API sends them; `to_decimal()` and
  `decimal_str()` convert from and to `decimal.Decimal`. **A `float` is never produced and never accepted**: a JSON number
  that is not money (an age in milliseconds, a count) is parsed as `int` or `Decimal`.
- The API key is never logged, never part of an error or a traceback, never in `repr(client)`.

> **Execution requires an owner-approved mandate.** Placing an order and closing or reducing a position need — besides
> the scope — an API key **bound to a trading mandate approved by the wallet's owner**. Without one the API refuses the
> call (`403 mandate_required` → `MandateRequired`); an order outside the mandate is `MandateDenied`. A scope alone never
> lets a key execute. Managing agents and strategies needs **no** mandate on the key (research and paper sign nothing):
> an agent goes live only under its *own* mandate, approved by the owner.
>
> **State of the API in this version.** All 46 operations of the contract are implemented and answer typed models.
> **Paper** orders are simulated by the wallet's paper engine against the venue's real order book. **Live** orders
> additionally need `SPW_TRADING_API_EXECUTION=on` on the server (default off → `403 execution_disabled` →
> `ExecutionDisabled`) and the wallet's mainnet locks. Spot orders and live GMX orders are the owner's (passkey): a key is
> refused them.

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
preview = client.preview_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)
if preview.would_execute:
    placed = client.create_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)  # mode="paper" by default
    done = client.wait_for_order(placed.order.id)        # FILLED, CANCELLED, REJECTED or FAILED
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

The same methods on `SPWallet` and, awaited, on `AsyncSPWallet`.

| Method | Operation | Scope |
|---|---|---|
| `list_markets(venue=, kind=, q=, limit=)` | `GET /markets` | `markets:read` |
| `compare_markets(underlying=, side=, notional=, leverage=, horizon_hours=, liquidity=, min_net_edge_bps=)` | `GET /markets/compare` | `markets:read` |
| `get_market(symbol)` | `GET /markets/{symbol}` | `markets:read` |
| `get_orderbook(symbol, depth=)` | `GET /markets/{symbol}/orderbook` | `markets:read` |
| `get_candles(symbol, interval=, limit=)` | `GET /markets/{symbol}/candles` | `markets:read` |
| `list_private_markets(delisted=, size=, side=)` | `GET /private-markets` | `markets:read` |
| `get_private_market(market_id, size=, side=, interval=, limit=)` | `GET /private-markets/{id}` | `markets:read` |
| `get_private_market_company(slug, …)` | `GET /private-markets/companies/{slug}` | `markets:read` |
| `get_portfolio()` | `GET /portfolio` | `wallet:read` |
| `get_balances(network=)` | `GET /balances` | `wallet:read` |
| `get_activity(limit=, cursor=)`, `iter_activity(limit=, max_items=)` | `GET /activity` | `wallet:read` |
| `list_nfts(network=, collection=, status=, q=, sort=, spam=, limit=, cursor=)` | `GET /nfts` | `wallet:read` |
| `get_nft(key)` | `GET /nfts/item` | `wallet:read` |
| `get_nft_activity(key, limit=, cursor=, type=)` | `GET /nfts/activity` | `wallet:read` |
| `get_nft_market(network=, address=, token_id=)` | `GET /nfts/market` | `markets:read` |
| `get_nft_market_events(network=, address=, token_id=, provider=, type=, after=, before=, cursor=, limit=)` | `GET /nfts/market/events` | `markets:read` |
| `get_positions(mode=, venue=)` | `GET /positions` | `positions:read` |
| `get_risk()` | `GET /risk` | `positions:read` |
| `engage_kill_switch(reason)` | `POST /risk/kill-switch` | `positions:manage` (no mandate) |
| `list_orders(mode=, venue=, open=, limit=, cursor=)`, `iter_orders(…, max_items=)` | `GET /orders` | `orders:read` |
| `get_order(order_id)` | `GET /orders/{id}` | `orders:read` |
| `wait_for_order(order_id, timeout=, poll_interval=, until=)` | polls `GET /orders/{id}` | `orders:read` |
| `preview_order(…)` → `models.OrderPreview` | `POST /orders/preview` | `orders:prepare` (a key needs a mandate bound to it) |
| `create_order(…)` → `models.PlacedOrder` | `POST /orders` | `orders:execute` + mandate |
| `cancel_order(order_id)` → `models.CancelledOrder` | `DELETE /orders/{id}` | `orders:cancel` (its own orders; no mandate) |
| `close_position(position_id, slippage_bps=)` → `models.PlacedOrder` | `POST /positions/{id}/close` | `positions:manage` + mandate |
| `reduce_position(position_id, fraction=, slippage_bps=)` → `models.PlacedOrder` | `POST /positions/{id}/reduce` | `positions:manage` + mandate |
| `run_command(text, mode=, account_id=, dry_run=)` → `models.CommandResult` | `POST /commands` | the scope of what the command resolves to |
| `list_strategies(kind=)` | `GET /strategies` | `strategies:read` |
| `create_strategy(kind=, path=, agent_id=)` → `StrategyResult` · `backtest_strategy(id)` → `JobResult` · `start_strategy(id, mode=)`, `stop_strategy(id)` → `AgentResult` | `POST /strategies…` | `strategies:manage` |
| `list_agents()` | `GET /agents` | `agents:read` |
| `list_agent_templates()`, `get_agent(agent_id)` | `GET /agents/templates`, `/agents/{id}` | `agents:read` |
| `list_agent_signals(agent_id, mode=, limit=, before=)`, `list_agent_journal(…)`, `list_agent_orders(…, open=)`, `get_agent_performance(agent_id, mode=)` | `GET /agents/{id}/signals`, `journal`, `orders`, `performance` — **one mode per call** | `agents:read` |
| `get_job(job_id)`, `wait_for_job(job_id, timeout=, poll_interval=)` | `GET /jobs/{id}` | `agents:read` |
| `create_agent(name=, template=, …)`, `start_agent(id, mode=)`, `pause_agent(id)`, `stop_agent(id)` → `AgentResult` · `backtest_agent(id, hours=)` → `JobResult` | `POST /agents…` | `agents:manage` |
| `openapi()` | `GET /openapi.json` | any valid key |

Results are pydantic models with snake_case attributes (`portfolio.totals.paper_equity`, `placed.order.avg_fill_price`,
`position.entry_price`); `result.to_dict()` gives the answer with the API's own names. Members the contract does not
name are kept (`model_extra`, also reachable as attributes). `result.meta` gives the facts of the HTTP exchange:
`status`, `request_id`, `idempotency_key`, `idempotent_replay`, `rate_limit` (`limit`, `remaining`, `reset_seconds`),
`attempts`. An answer that does not match the contract — a status outside the twelve states, a number where a decimal
string is declared — raises `ServerError` (`code == "invalid_response"`) instead of returning a half-typed object; on a
write the message says that the operation ran.

The private markets are display only: none of these contracts is tradable (`tradable` is False on every row).

### Pagination

`GET /orders` and `GET /activity` are paginated by cursor: a page carries `next_cursor`, which is the `cursor` of the
next (older) page; `None` at the end. The order is stable (time, then id): no row is repeated or skipped across pages.
The iterators follow the cursor for you; `limit` is the page size.

```python
for order in client.iter_orders(open=True, limit=100):
    print(order.id, order.status)
for item in client.iter_activity(max_items=500):
    print(item.kind, item.at)

async for order in async_client.iter_orders(open=True):      # AsyncSPWallet: an asynchronous iterator
    ...

page = client.list_orders(limit=50)                            # one page by hand
older = client.list_orders(limit=50, cursor=page.next_cursor) if page.next_cursor else None
```

`list_markets` is not paginated: it answers `total` and `truncated` so a list cut by `limit` is visible.

### Decimals

```python
from decimal import Decimal
from sp_wallet import to_decimal, decimal_str

book = client.get_orderbook("hyperliquid:BTC", depth=1)
bid, ask = to_decimal(book.bids[0][0]), to_decimal(book.asks[0][0])     # str → Decimal, exact
client.preview_order(instrument="hyperliquid:BTC", side="buy", order_type="limit",
                     size=Decimal("0.01"), price=int((bid + ask) / 2))   # Decimal, int or str — never float
decimal_str(Decimal("1E-7"))                                             # "0.0000001": what goes on the wire
```

Passing a `float` anywhere an amount is expected raises `ConfigurationError` before any request.

### Orders

```python
order = dict(mode="paper", instrument="hyperliquid:BTC", side="buy", order_type="limit", price="60000", size="0.01")
preview = client.preview_order(**order)        # nothing is created; preview.refusals says what would refuse it
placed = client.create_order(**order)          # placed.order.status: "SUBMITTED" while it rests
client.cancel_order(placed.order.id)           # → order.status "CANCELLED", changed True
```

- `instrument` is `venue:symbol` as returned by `list_markets`; `exchange` + `symbol` is the same thing in two parts.
- The API's `type` is the argument `order_type`. `mode` defaults to `"paper"`.
- Size the order with exactly one of `size` (base units) and `notional` (quote currency).
- **`notional` is sized by the server**: it divides by the order's own price (limit, else trigger), else by the mark
  price it reads at that moment, and rounds **down** to the lot size. A stale mark is refused (`503 stale_data`); less
  than one lot is `422 below_min_size`. The answer carries the size that was used (`preview.resolved.size`,
  `placed.order.size`). `notional_usdc` is the same field under the name of the quick start: the SDK sends it as
  `notional` and computes nothing.
- `client.get_market(instrument).instrument` gives what an order must respect: `lot_size`, `tick_size`,
  `min_order_size`, `min_notional`, `max_leverage`.
- A preview says "no" in its answer, not with an exception: `would_execute` is False and `refusals` lists each refusal
  with its `stage` (`key`, `lock`, `mandate`, `risk`, `engine`) and `code`. `preview.account.equity` and
  `free_collateral` are answered only to a key that also holds `wallet:read` or `positions:read`
  (`preview.account.withheld` is True otherwise). A key previews the order it could place: without a mandate bound to
  it, `preview_order` raises `MandateRequired`.
- `preview_order` and `engage_kill_switch` take no `Idempotency-Key` (the contract declares none): they are safe to
  repeat and are retried like a read.

A position is closed or reduced by its `id` from `get_positions()`; both are strictly reduce-only market orders:

```python
positions = client.get_positions(mode="paper").positions
if positions:
    client.reduce_position(positions[0].id, fraction=Decimal("0.5"))
    client.close_position(positions[0].id)
```

### Commands and the kill switch

```python
from sp_wallet import AmbiguousCommand, models

try:
    r = client.run_command("LONG BTC-PERP 500 x2", dry_run=True)
    # the answer is one of four models: narrow with isinstance
    if isinstance(r, models.CommandDryRun):        # a dry run: `order` is the CANONICAL order; nothing was created
        print(r.order.instrument, r.order.notional, r.hash)
    elif isinstance(r, models.CommandExecuted):    # executed: `order` is the placed order, `canonical` its canonical form
        print(r.order.id, r.order.status, r.canonical.instrument)
    elif isinstance(r, models.CommandQuery):       # SHOW …
        print(r.query, r.data)
    elif isinstance(r, models.CommandControl):     # CANCEL, KILL, STOP ALL AGENTS
        print(r.control.type, r.executed)
except AmbiguousCommand as e:
    print([f"{q['field']}: {' | '.join(q['options'])}" for q in e.questions])   # nothing was executed

client.engage_kill_switch("manual stop")   # blocks every NEW risk; cancels and exits still pass; only the owner releases it
```

The grammar is deterministic (no model). What a command leaves open (venue, leverage, …) comes from the owner's stored
defaults and from nothing else; when they do not settle it, the API answers `409 ambiguous_command` with the questions.

### Agents

```python
templates = client.list_agent_templates().templates                      # family, engine, the modes each can run in
agent = client.create_agent(template="market-making", name="MM BTC", venues=["hyperliquid"], universe=["BTC"]).agent
client.start_agent(agent.id, mode="paper")                               # research and paper sign nothing

# every per-agent read is ONE mode per call: `mode` is required, and an answer never mixes two ("all" is refused)
signals = client.list_agent_signals(agent.id, mode="paper", limit=50)
journal = client.list_agent_journal(agent.id, mode="paper")
orders = client.list_agent_orders(agent.id, mode="paper", open=True)
performance = client.get_agent_performance(agent.id, mode="paper")       # computed from paper records only; never a backtest

job = client.backtest_agent(agent.id, hours=24).job                      # asynchronous
done = client.wait_for_job(job.id, timeout=120)                          # done | failed | cancelled; WaitTimeout is not a failure
client.pause_agent(agent.id)
client.stop_agent(agent.id)                                              # stop is always allowed
```

- **`mode` on the reads.** On the wire `mode` is optional: the server answers the mode the agent is in now (for a stopped
  agent, the one it last ran in) and says which in `mode`. The SDK makes it a **required** keyword, so that code never reads
  paper figures believing they are live ones; `open` exists on `list_agent_orders` only.
- **`create_agent(mode=)`** is `"research"` (default: created, not running) or `"paper"`: an agent from a stream or
  supervisor template starts on paper at once; a bar agent (or `kind="perp"`) is created and not started — register and
  backtest a strategy version, then `start_agent`. `"live"` is refused (`400 bad_request`).
- **Paper.** Starting a perp agent on paper creates its *paper trading mandate* (nothing is signed): its orders go through
  the same order service, risk engine and kill switch as every other order. The key needs `agents:manage`, and a key
  restricted to other venues or instruments gets `403 restricted`; a halted paper account answers `409 halted`.
- **Live.** `start_agent(agent_id, mode="live")` succeeds only when a mandate the **owner** approved for that agent with the
  passkey is in force — for a perp agent a trading mandate, which only the owner activates. Otherwise `409 mandate_required`.
  A key can never approve one. Families that cannot go live answer `409 live_unavailable`.
- **Errors.** Every 409 of the agent operations is a `Conflict`; read `e.code` (`mandate_required`, `halted`, `bad_state`,
  `live_unavailable`, `no_strategy`, `no_report`, `bad_report`). `MandateRequired` (403) is about the *key's* mandate on the
  order operations, not about an agent's.
- **One kill switch.** There is no agents-side switch: `engage_kill_switch(reason)` engages the risk engine's, which stops every
  agent's new risk too. Releasing it is the owner's act, in the app. A spot agent is created in the owner's app
  (`403 owner_required`). An agent's `risk` limits are ints, bools, `Decimal`s or decimal strings — never a float.

### Spot orders (owner session only)

A key is refused spot execution (`403`). For the owner, a spot order is a swap proposal approved with the passkey:
a SELL names `size` (the quantity sold), a BUY names `notional` — the amount of the quote asset to spend, because a swap
is exact-input (`instrument="spot:ETH-USDC", side="buy", order_type="market", notional="100", mode="live"`).

### Order states and `wait_for_order`

`order.status` is one of the twelve `ORDER_STATES` — a closed enum in the contract and a `Literal` in the model:
`CREATED, VALIDATED, AWAITING_APPROVAL, APPROVED, SUBMITTING, SUBMITTED, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED,
FAILED, UNKNOWN`. Final states (`TERMINAL_ORDER_STATES`): `FILLED, CANCELLED, REJECTED, FAILED`; `order.final` is True
exactly for those. **`UNKNOWN` is not final and is not a failure**: the venue's answer is not known yet; keep reading
the order. `order.engine_status` is the executing engine's own word for the same moment (`open`, `filled`, a swap
state…): it is informative — decide on `status`.

```python
done = client.wait_for_order(order_id, timeout=60, poll_interval=1)
print(done.order.status, done.order.filled, len(done.fills))
```

`wait_for_order` returns when the status is final (or when `until(order)` is true) and raises `WaitTimeout` when the
time elapses first — that is not an order failure either; `error.last` is the last answer.

## Errors

Every error extends `SPWalletError` and carries `code` (the API's `error` member), `message`, `status`, `request_id`
(`X-Request-Id`: the owner finds the call in the usage log with it), `body`, `data` (the refusal's machine-readable
detail) and, for mutating calls, `idempotency_key`.

| Class | When |
|---|---|
| `ValidationError` | 400 `bad_request`, `invalid_order`, `invalid_cursor`, `parse_error`, `idempotency`, `stale_request`; 422 `no_orderbook`, `venue_rejected`, `below_min_size`, `no_position`, a refusal of the venue engine's own rules |
| `AuthenticationError` | 401 `unauthenticated` — missing, malformed, unknown, expired or revoked key (one answer for all) |
| `PermissionDenied` | 403 — `restricted`, `ip_not_allowed`, `key_limit_exceeded`, `not_your_order`… |
| ↳ `ScopeDenied` | 403 `insufficient_scope` — the key does not hold the operation's scope |
| ↳ `MandateRequired` | 403 `mandate_required` — no trading mandate is bound to the key |
| ↳ `MandateDenied` | 403 `mandate_denied` — the order is outside the mandate; `error.reasons` (`MANDATE_DENY_REASONS`: `ORDER_NOTIONAL_EXCEEDED`, `INSTRUMENT_NOT_ALLOWED`…) |
| ↳ `ExecutionDisabled` | 403 `execution_disabled` — live execution through the API is closed on this server; nothing was created |
| `RiskDenied` | 422 `risk_denied`, 423 `kill_switch_active` / `read_only_mode` — `error.failed` (ids of `RISK_CHECK_IDS`), `error.checks`, `error.kill_switch` |
| `NotFound` | 404 `unknown_order`, `unknown_instrument`, `unknown_venue`, `unknown_market`, `unknown_position`, `not_found` (a path that is not an operation)… |
| `Conflict` | 409 |
| ↳ `IdempotencyConflict` | 409 `idempotency_conflict` — the key was used with a different request |
| ↳ `AmbiguousSymbol` | 409 `ambiguous_symbol` — `error.candidates` lists the `venue:symbol` ids |
| ↳ `AmbiguousCommand` | 409 `ambiguous_command` — `error.questions`; nothing was executed |
| `RateLimited` | 429 `rate_limited`, `auth_throttled` — `error.retry_after` (seconds) |
| `sp_wallet.NotImplementedError` ↳ `ExecutionNotWired` | 501 `execution_not_wired` — an operation this server has not connected (an owner's spot order without the swap flow); nothing was done |
| `ServerError` ↳ `ServiceUnavailable` | 5xx; 503 `signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`…; `invalid_response` |
| `NetworkError` ↳ `sp_wallet.TimeoutError` | no answer (reads, previews) |
| `OutcomeUnknown` | a mutating call without a trustworthy answer — **not a failure**, see below |
| `WaitTimeout`, `WebhookVerificationError`, `ConfigurationError` | SDK-side |

**`error.order`**: when the server created the order before it refused it (a mandate or risk refusal, a refusal of the
venue engine), the error carries that order as a `models.Order` — state `REJECTED` or `FAILED` — so you know its id. It
is `None` when the call was refused before any order existed (nothing was created). The codes each operation can answer
are in the contract (`x-spw-errors`) and in the SDK as `OPERATION_ERRORS[operation_id]`.

```python
from sp_wallet import ExecutionDisabled, MandateDenied, MandateRequired, OutcomeUnknown, RateLimited, RiskDenied, ScopeDenied

try:
    client.create_order(instrument="hyperliquid:BTC", side="buy", order_type="market", notional="100", mode="paper")
except OutcomeUnknown:
    ...                                    # see "OutcomeUnknown"
except MandateRequired:
    ...                                    # the owner must bind an approved mandate to this key
except MandateDenied as e:
    print(e.reasons, e.order.id if e.order else None)          # ['ORDER_NOTIONAL_EXCEEDED'] …
except RiskDenied as e:
    print("kill switch" if e.kill_switch else e.failed, [(c.id, c.observed, c.limit) for c in e.checks])
except ExecutionDisabled:
    ...                                    # live orders are closed on this server; paper is not affected
except ScopeDenied:
    ...                                    # the key lacks orders:execute
except RateLimited as e:
    ...                                    # wait e.retry_after seconds
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
- `preview_order` and `engage_kill_switch` are `POST`s without an `Idempotency-Key` in the contract (repeating them
  changes nothing): they are retried like a read and fail with the ordinary errors, never `OutcomeUnknown`.
- Not retried: 400, 401, 403, 404, 409 (except `idempotency_in_progress`), 422, 423, 500, 501.

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

## Key rotation and the trading mandate

A trading mandate names **one principal — the key id it was approved for** — and a rotation gives the key a new id. The
rotation therefore does **not** carry the mandate: the new key keeps the scopes, limits, restrictions and expiry, and is
**unbound**. Until the owner approves a mandate for the new id and binds it, `create_order`, `close_position` and
`reduce_position` raise `MandateRequired` (and `preview_order` too); reads, cancels of its own orders, the kill switch and
agent management keep working. The answer of the rotation says so:
`{"key": {"mandateId": null, "inertScopes": […]}, "secret": …, "revoked": …, "mandate": {"carried": false, "mandateId": "<old mandate>", "code": "mandate_principal_mismatch", "note": …}}`.

```python
try:
    client.create_order(**order)
except MandateRequired:
    ...   # after a rotation: ask the owner for a mandate for THIS key id, then retry — nothing was created
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
per subscription). The client is asynchronous and needs the optional dependency `websockets`:

```bash
pip install "sp-wallet-python[stream]"      # in the repository: uv sync --extra stream
```

`SPWalletStream`, `OrderBook`, `StreamError`, `book_checksum` and `channel_key` are exported by `sp_wallet` and loaded on
first use: `import sp_wallet` works on a base install, and `websockets` is imported only when a stream connects.

```python
import asyncio
from sp_wallet import SPWalletStream
from sp_wallet.stream import Quote

async def main() -> None:
    async with SPWalletStream(base_url="https://wallet.example") as stream:     # the key: SP_WALLET_API_KEY, in the Authorization header
        stream.on("close", lambda c: print("closed;", "reconnecting" if c["will_reconnect"] else "stopped"))
        stream.on("error", lambda e: print("stream error:", e.code))
        await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "status", "id": "hyperliquid"}])
        async for m in stream:                                                  # or stream.on("quote", …)
            if isinstance(m, Quote):
                print(m.id, m.bid, m.ask, m.mark, m.stale)                      # decimal strings; `stale` is the server's verdict

asyncio.run(main())
```

- **Channels**: `quote`, `book` (`depth`), `trades`, `candles` (`interval`), `status` (`id`: a venue or `"*"`). Ids are
  `<venue>:<instrument>` (`hyperliquid:BTC`, `dydx:BTC-USD`, `spot:BTC`). Messages are models: `Quote`, `Book`, `Trades`,
  `Candle`, `VenueStatus` (snake_case attributes: `recv_ts`, `venue_ts`, `bid_size`).
- **Reconnection** is on by default (`reconnect=False` to turn it off): exponential backoff with jitter between `backoff_min`
  and `backoff_max`; after a reconnection the client subscribes again to everything and the server sends fresh snapshots.
  `close` events carry `will_reconnect`. A refusal that a retry cannot fix (no `markets:read`, revoked key, unknown
  instrument) is a `StreamError` with the server's `code`, and is not retried.
- **Order books**: feed every `Book` to an `OrderBook`; `apply()` returns `False` on a sequence hole or a checksum mismatch —
  `await stream.resync(channel)` and the server restarts the book from a snapshot.
- **Slow consumers**: quotes are conflated and a `dropped` event says what was skipped; the iterator's buffer is bounded by
  `buffer_size`.
- A stream connection writes **no row in the key's usage log** (the ticket request does).

### Browsers and proxies: the ticket flow

A browser cannot set a header on a websocket, and the key must never reach it. A backend asks for a single-use ticket (30 s)
with the key — `POST /api/v1/trading/stream/ticket`, answer `{ ticket, expiresAt, ttlMs, url, protocol }` — and hands only
the ticket to the page, which connects to `/api/v1/trading/stream?ticket=…` (in the TypeScript SDK:
`new SPWalletStream({ baseUrl, ticket: () => … })`, see `docs/sdk/typescript.md`). A Python backend:

```python
import httpx, os

def stream_ticket() -> str:                    # behind YOUR authentication; a new ticket for every (re)connection
    r = httpx.post(f"{WALLET}/api/v1/trading/stream/ticket", headers={"authorization": f"Bearer {os.environ['SP_WALLET_API_KEY']}"}, json={})
    r.raise_for_status()
    return r.json()["ticket"]
```

The ticket carries the key's scope and restrictions, works once, and is refused when mixed with another credential. The
Python client can connect that way too: `SPWalletStream(auth="ticket")` asks for the ticket itself with its key (useful
behind a proxy that strips headers on upgrade), and `SPWalletStream(ticket=my_async_function)` uses yours.

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
`key.revoked`, `risk.kill_switch`, `agent.updated`, `order.updated` (one event per transition of an order),
`risk.proposal`.
A complete receiver: `sdk/python/examples/webhook_receiver.py`.

## Examples

```bash
cd sdk/python && uv sync
SP_WALLET_API_KEY=spw_live_… uv run python examples/read_only.py       # read-only tour
SP_WALLET_API_KEY=spw_live_… uv run python examples/async_read.py      # the asynchronous client
SP_WALLET_API_KEY=spw_live_… uv run python examples/preview_order.py   # a preview with every outcome handled
SP_WALLET_API_KEY=spw_live_… uv run python examples/paper_order.py     # PAPER: preview → place → wait → position → close
SP_WALLET_API_KEY=spw_live_… uv run --extra stream python examples/stream_quotes.py   # live quotes over the websocket, with reconnection
```

The five are executed against the real API by the integration tests.

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
(`packages/trading-sdk/scripts/test-stack.mts`; it needs the repository's `node_modules` and PostgreSQL), creates
keys, a paper account and paper mandates through the owner flow, calls every method with both clients and runs the
whole **paper** write path (preview → order → fill → reduce → close → resting order → cancel, replay and conflict, the
refusals, the kill switch, commands) and an agent on paper (create from a template → start → signals, journal, orders,
performance → pause → backtest job → stop); every answer is validated against the OpenAPI document, closed objects included.
No live order is sent: the live case stops at `execution_disabled`. It is **skipped** (reported as skipped) when
PostgreSQL is not reachable; a test whose venue cannot be read is skipped with that reason.

## NFT reads

Five read operations; **no NFT write exists in the API** (transfers are the owner's, with the passkey; no marketplace action is built). `list_nfts` / `get_nft` / `get_nft_activity` read the wallet's own inventory. `get_nft_market` and `get_nft_market_events` read market data of ANY item named by its chain identifiers and answer **one row per source** — a source without its key answers `status.state == "needs_key"` with `status.unlocked_by`; nothing is filled in. Amounts are exact base-unit strings in a currency identified by network + mint / contract; a `token_id` is a string (it can be as large as 2**256 − 1). NFTs carry no value: `valuation.state` / `value.state` is `"unavailable"`. A fiat `rates` entry can be `withheld` for a key (licence of the price source). There is no `iter_nfts` helper yet: page with `cursor=next_cursor`.

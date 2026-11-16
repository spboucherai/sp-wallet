# sp-wallet-python

Official Python client of the SP Wallet Trading API. Python ≥ 3.10, `httpx` + `pydantic` v2, synchronous and
asynchronous. Full documentation: [`docs/sdk/python.md`](../../docs/sdk/python.md).

```bash
pip install /path/to/sp-wallet/sdk/python      # not published to PyPI
```

```python
from sp_wallet import SPWallet

client = SPWallet(api_key="spw_live_…")        # or the environment variable SP_WALLET_API_KEY

client.get_balances()
client.get_positions()
order = dict(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)   # paper by default
preview = client.preview_order(**order)
if preview.would_execute:
    placed = client.create_order(**order)
    client.wait_for_order(placed.order.id)          # FILLED, CANCELLED, REJECTED or FAILED — UNKNOWN keeps waiting
```

- Typed models generated from `docs/openapi/trading-v1.json`; amounts stay decimal strings (`to_decimal`, never `float`).
- Typed results for every implemented operation, the write side included (`models.OrderPreview`, `PlacedOrder`,
  `CancelledOrder`, `CommandResult`); an order's `status` is the contract's closed enum of twelve states.
- A `notional` is sized by the **server** (the SDK sends it and computes nothing); `iter_orders` / `iter_activity`
  follow the cursor pagination.
- Typed errors (`AuthenticationError`, `ScopeDenied`, `MandateRequired`, `MandateDenied` with the reasons, `RiskDenied`
  with the failed checks, `ExecutionDisabled`, `AmbiguousCommand` with the questions, `RateLimited`, …) with `code`,
  `status`, `request_id`, and `error.order` when the refusal is about an order the server created.
- Safe retries: reads on network errors / 429 / 502–504; mutating calls only because they carry an `Idempotency-Key`
  (same key, same bytes on every retry). A mutating call without a trustworthy answer raises `OutcomeUnknown` — not a
  failure — with the key to resume with.
- `wait_for_order`, webhook signature verification, the API key never in a log, a repr or an error.

**Execution requires an owner-approved mandate bound to the key**; the API refuses it otherwise (`MandateRequired`),
and an order outside the mandate is `MandateDenied`. Paper orders are simulated by the wallet. Live orders also need
`SPW_TRADING_API_EXECUTION=on` on the server (`ExecutionDisabled` otherwise). All 41 operations of the contract are implemented, the strategy and agent operations included (agents are read ONE
mode per call). Managing agents needs no mandate on the key; an agent goes live only under its own owner-approved mandate.
Rotating a key unbinds its mandate (the mandate names the old key id): see "Key rotation" in the documentation.

```
src/sp_wallet/   _async_client.py (source) → _client.py (generated), _base.py (retry decisions), models.py (generated),
                 errors.py, webhooks.py, _util.py (canonical JSON, decimals, order states), py.typed
scripts/         gen_models.py (models from the OpenAPI document), gen_sync.py (sync client from the async one)
examples/        read_only.py, async_read.py, preview_order.py, paper_order.py, stream_quotes.py (executed by the integration tests), webhook_receiver.py
tests/           unit tests (mocked transport, both clients) + test_integration.py (the real API, both clients)
```

```bash
uv sync && uv run ruff check && uv run pytest
```

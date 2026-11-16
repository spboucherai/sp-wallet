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
client.preview_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)
```

- Typed models generated from `docs/openapi/trading-v1.json`; amounts stay decimal strings (`to_decimal`, never `float`).
- Typed errors (`AuthenticationError`, `ScopeDenied`, `MandateRequired`, `RateLimited`, `ExecutionNotWired`, …) with
  `code`, `status`, `request_id`.
- Safe retries: reads on network errors / 429 / 502–504; mutating calls only because they carry an `Idempotency-Key`
  (same key, same bytes on every retry). A mutating call without a trustworthy answer raises `OutcomeUnknown` — not a
  failure — with the key to resume with.
- `wait_for_order`, webhook signature verification, the API key never in a log, a repr or an error.

**Execution requires an owner-approved mandate bound to the key**; the API refuses it otherwise (`MandateRequired`).
In this version of the API the write operations answer `501 execution_not_wired`: the SDK raises `ExecutionNotWired`
and never reports a success that did not happen.

```
src/sp_wallet/   _async_client.py (source) → _client.py (generated), _base.py (retry decisions), models.py (generated),
                 errors.py, webhooks.py, _util.py (canonical JSON, decimals, order states), py.typed
scripts/         gen_models.py (models from the OpenAPI document), gen_sync.py (sync client from the async one)
examples/        read_only.py, async_read.py, preview_order.py, webhook_receiver.py
tests/           unit tests (mocked transport, both clients) + test_integration.py (the real API, both clients)
```

```bash
uv sync && uv run ruff check && uv run pytest
```

"""Preview an order, with every outcome handled. Needs a key with `orders:prepare` (and `markets:read` for notional_usdc).

    SP_WALLET_API_KEY=spw_live_… uv run python examples/preview_order.py

A preview places nothing. Placing (`create_order`) additionally needs `orders:execute` AND a key bound to a trading
mandate approved by the wallet's owner — otherwise the API answers 403 `mandate_required`.
"""

from __future__ import annotations

from sp_wallet import ExecutionNotWired, MandateRequired, OutcomeUnknown, RateLimited, ScopeDenied, SPWallet, ValidationError, new_idempotency_key


def main() -> None:
    client = SPWallet()
    # One key per LOGICAL call. Persist it before sending if your process can crash: the same key resumes the same call.
    key = new_idempotency_key()
    print(f"idempotency key of this call: {key}")
    try:
        preview = client.preview_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100, idempotency_key=key)
        print("preview:", preview.to_dict(), preview.meta)
    except OutcomeUnknown as e:
        # NOT a failure: no trustworthy answer was received. Re-send the same call with the same key, or read the object.
        print(f"outcome unknown — resume with idempotency_key={e.idempotency_key}")
    except ExecutionNotWired as e:
        print(f"the server does not execute this operation yet (501 {e.code}): nothing was done")
    except MandateRequired:
        print("this key is not bound to an owner-approved trading mandate: execution is refused")
    except ScopeDenied as e:
        print(f"the key lacks a scope: {e}")
    except RateLimited as e:
        print(f"rate limited; retry in {e.retry_after} s")
    except ValidationError as e:
        print(f"refused request ({e.code}): {e}")
    finally:
        client.close()


if __name__ == "__main__":
    main()

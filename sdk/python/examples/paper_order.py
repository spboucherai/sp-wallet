"""A PAPER order from preview to close. Nothing is signed and nothing reaches a venue: the wallet's paper engine fills the
order against the venue's real public order book.

    SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] [SP_WALLET_ACCOUNT_ID=<paper account>] uv run python examples/paper_order.py

The key needs orders:prepare, orders:execute, orders:read, positions:read, positions:manage AND a paper trading mandate
approved by the wallet's owner and bound to the key (Developer screen). Without the mandate: MandateRequired.
"""

from __future__ import annotations

import os
from typing import Any

from sp_wallet import ExecutionDisabled, MandateDenied, MandateRequired, OutcomeUnknown, RiskDenied, SPWallet, ValidationError, WaitTimeout, new_idempotency_key


def main() -> None:
    account_id = os.environ.get("SP_WALLET_ACCOUNT_ID") or None  # needed only when the wallet has several paper accounts on the venue
    order: dict[str, Any] = {"mode": "paper", "exchange": "hyperliquid", "symbol": "BTC", "side": "buy", "order_type": "market", "notional": "100"}
    order["account_id"] = account_id
    with SPWallet() as client:
        try:
            # 1 — what would happen, without creating anything
            preview = client.preview_order(**order)
            size = preview.resolved.size if preview.resolved else "n/a"
            refusals = [f"{r.stage}:{r.code}" for r in preview.refusals]
            print(f"preview: would execute={preview.would_execute}, size={size} BTC for a notional of 100, refusals={refusals}")
            if not preview.would_execute:
                raise SystemExit("the preview says the order would be refused: nothing was placed")

            # 2 — place it. One Idempotency-Key per LOGICAL order: persist it before sending if your process can crash.
            key = new_idempotency_key()
            placed = client.create_order(**order, idempotency_key=key)
            print(f"placed: order {placed.order.id[:14]}… status={placed.order.status} final={placed.order.final}")
            # the same call again is the SAME order: nothing is sent twice
            again = client.create_order(**order, idempotency_key=key)
            print(f"replay: same order={again.order.id == placed.order.id}, answered from the idempotency store={again.meta.idempotent_replay}")

            # 3 — wait until it is final. UNKNOWN is not final and not a failure: the wait goes on.
            done = client.wait_for_order(placed.order.id, timeout=30)
            print(f"final: status={done.order.status} filled={done.order.filled} avg={done.order.avg_fill_price} fills={len(done.fills)}")

            # 4 — the position, then out of it (a close is strictly reduce-only)
            position = next((p for p in client.get_positions(mode="paper").positions if p.instrument == "hyperliquid:BTC"), None)
            if position is None:
                raise SystemExit("no paper position on hyperliquid:BTC after the fill")
            print(f"position: {position.side} {position.size} BTC, entry {position.entry_price}")
            closed = client.close_position(position.id)
            print(f"closed: status={closed.order.status} reduce_only={closed.order.reduce_only}")
            print("done")
        except OutcomeUnknown as e:
            print(f"outcome unknown — NOT a failure: send the same call again with idempotency_key={e.idempotency_key}, or read the order")
        except WaitTimeout:
            print("the order is not final yet — it has not failed: keep reading it")
        except MandateRequired:
            print("this key is not bound to an owner-approved trading mandate: nothing can execute")
        except MandateDenied as e:
            print(f"outside the mandate: {', '.join(e.reasons)} (order {e.order.id if e.order else 'not created'} is {e.order.status if e.order else 'n/a'})")
        except RiskDenied as e:
            print(f"refused by the risk engine{' (kill switch)' if e.kill_switch else ''}: {', '.join(e.failed)}")
        except ExecutionDisabled:
            print("live execution through the API is closed on this server; paper is not affected")
        except ValidationError as e:
            print(f"refused ({e.code}): {e}")


if __name__ == "__main__":
    main()

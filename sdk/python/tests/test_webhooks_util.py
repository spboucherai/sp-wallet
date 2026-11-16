"""Webhook verification and canonical JSON against vectors produced by the SERVER's code, decimals, order states.

tests/fixtures/server-vectors.json is written by packages/trading-sdk/scripts/gen-fixtures.mts with
services/api/src/alerts/webhook.ts and services/api/src/trading-api/key-model.ts; a vitest test of the TypeScript SDK
recomputes every vector with that code, so the file cannot go stale. The integration test verifies a signature made by
the running server code as well.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from conftest import ROOT
from sp_wallet import (
    IDEMPOTENCY_KEY_RE,
    ORDER_STATES,
    TERMINAL_ORDER_STATES,
    WEBHOOK_TOLERANCE_SECONDS,
    ConfigurationError,
    WebhookVerificationError,
    canonical_json,
    construct_webhook_event,
    decimal_str,
    is_terminal_order,
    new_idempotency_key,
    order_state,
    size_from_notional,
    to_decimal,
    verify_webhook,
    webhook_signature,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "server-vectors.json").read_text())


def _has_float(v: Any) -> bool:
    return isinstance(v, float) or (isinstance(v, dict) and any(_has_float(x) for x in v.values())) or (isinstance(v, list) and any(_has_float(x) for x in v))


# ---------------------------------------------------------------------------------------------------------------- webhooks
@pytest.mark.parametrize("v", VECTORS["webhooks"], ids=[f"vector{i}" for i in range(len(VECTORS["webhooks"]))])
def test_signature_is_the_servers(v: dict[str, Any]) -> None:
    assert webhook_signature(v["secret"], v["timestamp"], v["body"]) == v["signature"]
    assert webhook_signature(v["secret"], v["timestamp"], v["body"].encode()) == v["signature"]
    now = v["timestamp"] + 10
    assert verify_webhook(secret=v["secret"], timestamp=str(v["timestamp"]), signature=v["signature"], body=v["body"], now=now)
    assert verify_webhook(secret=v["secret"], timestamp=v["timestamp"], signature=v["signature"], body=v["body"].encode(), now=now)


def test_verification_refuses_what_the_server_would_refuse() -> None:
    v = VECTORS["webhooks"][0]
    s, t, sig, body = v["secret"], v["timestamp"], v["signature"], v["body"]

    def check(**kw: Any) -> bool:
        return verify_webhook(**{"secret": s, "timestamp": str(t), "signature": sig, "body": body, "now": t, **kw})

    assert check()
    assert check(now=t + 300)
    assert check(now=t - 300)
    assert not check(now=t + 301)
    assert not check(now=t - 301)
    assert check(now=t + 400, tolerance_seconds=600)
    assert not check(secret="other secret")
    assert not check(timestamp=str(t + 1))
    assert not check(body=body + " ")
    assert not check(signature=sig.replace("v1=", "v2="))
    assert not check(signature=sig[:-1])
    assert not check(signature=sig.upper())
    assert not check(signature="")
    assert not check(signature=None)
    assert not check(timestamp="abc")
    assert not check(timestamp=f"{t}.5")
    assert not check(timestamp=None)
    assert not check(timestamp="")
    assert not check(timestamp=True)
    assert not check(secret="")
    assert not check(signature="v1=é")  # non-ASCII input does not raise
    assert WEBHOOK_TOLERANCE_SECONDS == 300
    assert f"toleranceSec = {WEBHOOK_TOLERANCE_SECONDS})" in (ROOT / "services/api/src/alerts/webhook.ts").read_text()


def test_construct_event() -> None:
    v = VECTORS["webhooks"][0]
    e = construct_webhook_event(secret=v["secret"], timestamp=str(v["timestamp"]), signature=v["signature"], body=v["body"].encode(), now=v["timestamp"])
    assert (e["app"], e["event"], e["data"]["keyId"]) == ("sp-wallet", "key.revoked", "spk_0123456789ab")
    with pytest.raises(WebhookVerificationError):
        construct_webhook_event(secret=v["secret"], timestamp=str(v["timestamp"]), signature="v1=00", body=v["body"], now=v["timestamp"])
    empty = VECTORS["webhooks"][2]  # authentic, but the body is not JSON
    with pytest.raises(WebhookVerificationError, match="not JSON"):
        construct_webhook_event(secret=empty["secret"], timestamp=empty["timestamp"], signature=empty["signature"], body=empty["body"], now=empty["timestamp"])


def test_the_comparison_is_constant_time() -> None:
    src = (ROOT / "sdk/python/src/sp_wallet/webhooks.py").read_text()
    assert "hmac.compare_digest(" in src
    assert "== signature" not in src


# ---------------------------------------------------------------------------------------------------------------- canonical JSON
def test_canonical_json_is_byte_for_byte_the_servers() -> None:
    used = 0
    for v in VECTORS["canonical"]:
        if _has_float(v["value"]):
            with pytest.raises(ConfigurationError):  # this SDK never serializes a float (a request body has none)
                canonical_json(v["value"])
            continue
        used += 1
        assert canonical_json(v["value"]) == v["json"], v["value"]
    assert used >= 8


def test_canonical_json_rules() -> None:
    assert canonical_json({"b": 1, "a": [True, None, "x"]}) == '{"a":[true,null,"x"],"b":1}'
    assert canonical_json({"é": "漢", "a": " "}) == '{"a":" ","é":"漢"}'  # not escaped, like JSON.stringify
    for bad in ({"x": 0.1}, {"x": float("nan")}, {"x": Decimal("1")}, {1: "x"}, {"x": object()}, {"x": b"bytes"}):
        with pytest.raises(ConfigurationError):
            canonical_json(bad)


def test_idempotency_keys() -> None:
    keys = {new_idempotency_key() for _ in range(200)}
    assert len(keys) == 200
    assert all(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", k) and IDEMPOTENCY_KEY_RE.match(k) for k in keys)
    # the server's rule, read from its source
    assert f"export const IDEMPOTENCY_RE = /{IDEMPOTENCY_KEY_RE.pattern}/;" in (ROOT / "services/api/src/trading-api/idempotency.ts").read_text()


# ---------------------------------------------------------------------------------------------------------------- decimals
def test_decimal_helpers_never_accept_a_float() -> None:
    assert to_decimal("64907.10") == Decimal("64907.10")
    assert str(to_decimal("0.1") + to_decimal("0.2")) == "0.3"
    assert to_decimal(None) is None
    assert to_decimal(5) == Decimal(5)
    assert to_decimal(Decimal("1.5")) == Decimal("1.5")
    for bad in (0.1, True, "abc", "NaN", "Infinity", ""):
        with pytest.raises(ConfigurationError):
            to_decimal(bad)  # type: ignore[arg-type]
    assert decimal_str("0.01") == "0.01"
    assert decimal_str(Decimal("1E-7")) == "0.0000001"
    assert decimal_str(Decimal("1.50")) == "1.50"
    assert decimal_str(100) == "100"
    for bad in (0.01, True, "1e-2", "-1", Decimal("-1"), Decimal("NaN"), "1,5", " 1", None, [1]):
        with pytest.raises(ConfigurationError):
            decimal_str(bad)  # type: ignore[arg-type]


def test_size_from_notional_is_exact_and_rounds_down() -> None:
    assert size_from_notional("100", "64907", "0.00001") == "0.00154"
    assert size_from_notional(100, "0.1", "0.001") == "1000"
    assert size_from_notional("0.3", "0.1", "0.1") == "3"  # 0.1 + 0.2 territory: no float involved
    assert size_from_notional("1000000000000000000000.5", "3", "0.01") == "333333333333333333333.5"
    assert size_from_notional(Decimal("99.99"), Decimal("100"), Decimal("0.01")) == "0.99"
    assert size_from_notional("5", "3") == "1.666666"
    assert size_from_notional("0", "3") == "0"
    assert size_from_notional("10", "3", "1") == "3"
    # same vectors as the TypeScript SDK (packages/trading-sdk/test/client.test.ts)
    with pytest.raises(ConfigurationError):
        size_from_notional("100", "0")
    with pytest.raises(ConfigurationError):
        size_from_notional(0.1, "1")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------------------------------------------- order states
def test_order_states() -> None:
    assert ORDER_STATES == ("CREATED", "VALIDATED", "AWAITING_APPROVAL", "APPROVED", "SUBMITTING", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "FAILED", "UNKNOWN")
    assert frozenset({"FILLED", "CANCELLED", "REJECTED", "FAILED"}) == TERMINAL_ORDER_STATES
    assert "UNKNOWN" not in TERMINAL_ORDER_STATES
    assert order_state("filled") == "FILLED"
    assert order_state("canceled") == "CANCELLED"
    assert order_state("open") is None
    assert order_state(None) is None
    for s in ORDER_STATES:
        assert is_terminal_order({"status": s, "final": True}) == (s in TERMINAL_ORDER_STATES)
        assert is_terminal_order({"status": s.lower()}) == (s in TERMINAL_ORDER_STATES)
    assert not is_terminal_order({"status": "UNKNOWN", "final": True})  # UNKNOWN is never final
    assert is_terminal_order({"status": "expired", "final": True})  # older tables: the server's flag decides
    assert not is_terminal_order({"status": "open", "final": False})
    assert not is_terminal_order({"status": "open"})

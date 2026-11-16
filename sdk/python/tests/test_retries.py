"""Error mapping, retries and idempotency with a mocked transport (both clients)."""

from __future__ import annotations

import re
from typing import Any

import httpx
import pytest

import sp_wallet
from conftest import NET, TIMEOUT, fail, ok
from sp_wallet import (
    AmbiguousCommand,
    AmbiguousSymbol,
    APIError,
    AuthenticationError,
    ConfigurationError,
    Conflict,
    ExecutionDisabled,
    ExecutionNotWired,
    IdempotencyConflict,
    MandateDenied,
    MandateRequired,
    NetworkError,
    NotFound,
    OutcomeUnknown,
    PermissionDenied,
    RateLimited,
    RiskDenied,
    ScopeDenied,
    ServerError,
    ServiceUnavailable,
    SPWalletError,
    ValidationError,
    error_from_response,
    models,
)
from test_client import ORDER_ROW, SAMPLES

ORDER: dict[str, Any] = {"instrument": "hyperliquid:BTC", "side": "buy", "order_type": "market", "size": "0.01"}
AGENTS = ok({"agents": []})
UUID4 = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"

TABLE: list[tuple[int, str, type, type | None]] = [
    (400, "bad_request", ValidationError, None), (400, "idempotency", ValidationError, None), (400, "stale_request", ValidationError, None),
    (422, "no_orderbook", ValidationError, None), (401, "unauthenticated", AuthenticationError, None),
    (403, "insufficient_scope", ScopeDenied, PermissionDenied), (403, "scope_denied", ScopeDenied, PermissionDenied),
    (403, "mandate_required", MandateRequired, PermissionDenied), (403, "restricted", PermissionDenied, None), (403, "ip_not_allowed", PermissionDenied, None),
    (403, "key_path_forbidden", PermissionDenied, None), (404, "unknown_order", NotFound, None), (404, "unknown_instrument", NotFound, None),
    (403, "execution_disabled", ExecutionDisabled, PermissionDenied), (403, "mandate_denied", MandateDenied, PermissionDenied), (403, "mandate_not_approved", MandateDenied, PermissionDenied),
    (403, "key_limit_exceeded", PermissionDenied, None), (422, "risk_denied", RiskDenied, None), (423, "kill_switch_active", RiskDenied, None), (423, "read_only_mode", RiskDenied, None),
    (423, "halted", RiskDenied, None), (422, "venue_rejected", ValidationError, None), (422, "below_min_size", ValidationError, None),
    (409, "ambiguous_command", AmbiguousCommand, Conflict), (404, "not_found", NotFound, None), (400, "invalid_cursor", ValidationError, None),
    (409, "idempotency_conflict", IdempotencyConflict, Conflict), (409, "ambiguous_symbol", AmbiguousSymbol, Conflict), (409, "something_else", Conflict, None),
    (429, "rate_limited", RateLimited, None), (429, "auth_throttled", RateLimited, None),
    (501, "execution_not_wired", ExecutionNotWired, sp_wallet.NotImplementedError), (501, "other", sp_wallet.NotImplementedError, None),
    (503, "signer_unreachable", ServiceUnavailable, ServerError), (500, "internal", ServerError, None), (418, "teapot", APIError, None),
]  # fmt: skip


# ---------------------------------------------------------------------------------------------------------------- error mapping
@pytest.mark.parametrize(("status", "code", "cls", "parent"), TABLE, ids=[f"{s}-{c}" for s, c, _, _ in TABLE])
def test_status_and_code_map_to_a_typed_error(mock: Any, status: int, code: str, cls: type, parent: type | None) -> None:
    extra = {"candidates": ["hyperliquid:BTC", "spot:BTC"]} if code == "ambiguous_symbol" else {}
    e = mock([fail(status, code, "the sentence of the server", **extra)], max_retries=0).error("get_market", "BTC")
    assert type(e) is cls
    assert isinstance(e, APIError)
    assert isinstance(e, SPWalletError)
    if parent:
        assert isinstance(e, parent)
    assert (e.code, e.status, e.request_id) == (code, status, "req-1")
    assert "the sentence of the server" in str(e)
    assert "req-1" in str(e)
    if isinstance(e, AmbiguousSymbol):
        assert e.candidates == ["hyperliquid:BTC", "spot:BTC"]


def test_the_sdk_errors_are_not_the_builtins() -> None:
    import builtins

    assert sp_wallet.NotImplementedError is not builtins.NotImplementedError
    assert not issubclass(sp_wallet.NotImplementedError, builtins.NotImplementedError)
    assert sp_wallet.TimeoutError is not builtins.TimeoutError
    assert issubclass(sp_wallet.TimeoutError, NetworkError)
    assert issubclass(ExecutionNotWired, sp_wallet.NotImplementedError)


def test_answers_that_are_not_the_apis_own(mock: Any) -> None:
    e = mock([{"status": 404, "json": {"message": "Route GET:/x not found", "error": "Not Found", "statusCode": 404}}]).error("get_risk")
    assert type(e) is NotFound
    assert e.code == "http_404"
    e = mock([{"status": 500, "text": "<html>oops</html>"}]).error("get_risk")
    assert type(e) is ServerError
    assert e.code == "http_500"
    assert type(error_from_response(403, {"error": "mandate_required", "message": "m"})) is MandateRequired
    e = mock([{"status": 200, "text": "not json"}]).error("get_risk")
    assert type(e) is ServerError
    assert e.code == "invalid_response"


def test_429_carries_retry_after_else_ratelimit_reset(mock: Any) -> None:
    e = mock([fail(429, "rate_limited", headers={"retry-after": "17", "ratelimit-reset": "40"})], max_retries=0).error("list_agents")
    assert e.retry_after == 17
    e = mock([fail(429, "rate_limited", headers={"ratelimit-reset": "40"})], max_retries=0).error("list_agents")
    assert e.retry_after == 40


# ---------------------------------------------------------------------------------------------------------------- reads
def test_reads_are_retried_on_network_errors_429_502_503_504_with_backoff(mock: Any) -> None:
    h = mock([NET, fail(503, "venue_unavailable"), {"status": 502, "text": "bad gateway"}, {"status": 504, "text": ""}, AGENTS], max_retries=4)
    r = h.call("list_agents")
    assert r.agents == []
    assert len(h.calls) == 5
    assert h.sleeps == [0.375, 0.75, 1.5, 3.0]  # random() = 0.5 → 75 % of 0.5 × 2^n
    assert (r.meta.attempts, r.meta.status, r.meta.request_id, r.meta.idempotency_key) == (5, 200, "req-5", None)
    assert all("idempotency-key" not in c.headers for c in h.calls)


@pytest.mark.parametrize(("rnd", "want"), [(0.0, [0.25, 0.5, 1, 2, 4, 4]), (0.999999, [0.5, 1, 2, 4, 8, 8])])
def test_jitter_stays_in_the_upper_half_of_the_step_and_the_step_is_capped(mock: Any, rnd: float, want: list[float]) -> None:
    h = mock([NET, NET, NET, NET, NET, NET, AGENTS], max_retries=6, _random=lambda: rnd)
    h.call("list_agents")
    assert [round(s, 3) for s in h.sleeps] == want


def test_429_waits_what_the_server_asks_and_a_longer_wait_is_raised_at_once(mock: Any) -> None:
    h = mock([fail(429, "rate_limited", headers={"retry-after": "2"}), fail(429, "rate_limited", headers={"ratelimit-reset": "7"}), AGENTS])
    h.call("list_agents")
    assert h.sleeps == [2, 7]
    long = mock([fail(429, "rate_limited", headers={"retry-after": "120"}), AGENTS])
    e = long.error("list_agents")
    assert type(e) is RateLimited
    assert e.retry_after == 120
    assert len(long.calls) == 1
    assert long.sleeps == []


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 500, 501])
def test_reads_are_not_retried_on_definite_answers(mock: Any, status: int) -> None:
    h = mock([fail(status, "x"), ok()])
    h.error("get_risk")
    assert len(h.calls) == 1


def test_reads_give_up_after_max_retries(mock: Any) -> None:
    h = mock([NET], max_retries=2)
    e = h.error("get_risk")
    assert type(e) is NetworkError
    assert (e.code, e.status) == ("network_error", None)
    assert len(h.calls) == 3
    h = mock([TIMEOUT], max_retries=1)
    e = h.error("get_risk")
    assert type(e) is sp_wallet.TimeoutError
    assert isinstance(e, NetworkError)
    assert e.code == "timeout"
    assert len(h.calls) == 2
    h = mock([fail(503, "markets_unavailable")], max_retries=1)
    assert type(h.error("list_markets")) is ServiceUnavailable
    assert len(h.calls) == 2


def test_a_refusal_about_an_order_carries_the_order_the_reasons_the_failed_checks_and_the_questions() -> None:
    order = {**ORDER_ROW, "id": "o-1", "status": "REJECTED", "engineStatus": None, "final": True, "rejectCode": "mandate_denied"}
    md = error_from_response(403, {"error": "mandate_denied", "message": "outside the mandate", "data": {"reasons": ["ORDER_NOTIONAL_EXCEEDED", "LEVERAGE_EXCEEDED"], "order": order}})
    assert type(md) is MandateDenied
    assert md.reasons == ["ORDER_NOTIONAL_EXCEEDED", "LEVERAGE_EXCEEDED"]
    assert type(md.order) is models.Order
    assert (md.order.id, md.order.status, md.order.final, md.order.reject_code) == ("o-1", "REJECTED", True, "mandate_denied")
    checks = [{"id": "kill_switch", "ok": False, "observed": "on", "limit": "off", "detail": "the kill switch is on", "exempt": False}]
    rd = error_from_response(423, {"error": "kill_switch_active", "message": "no new risk", "data": {"failed": ["kill_switch"], "checks": checks, "decisionId": 7, "order": order}})
    assert type(rd) is RiskDenied
    assert rd.kill_switch is True
    assert rd.failed == ["kill_switch"]
    assert [(c.id, c.ok, c.observed, c.limit) for c in rd.checks] == [("kill_switch", False, "on", "off")]
    assert rd.order is not None and rd.order.id == "o-1"
    r2 = error_from_response(422, {"error": "risk_denied", "message": "order_notional: above", "data": {"failed": ["order_notional"], "checks": [], "order": order}})
    assert (r2.kill_switch, r2.failed) == (False, ["order_notional"])
    q = [{"field": "venue", "options": ["hyperliquid", "gmx"], "message": "which venue?"}]
    ac = error_from_response(409, {"error": "ambiguous_command", "message": "answer the questions", "data": {"questions": q}})
    assert type(ac) is AmbiguousCommand
    assert ac.questions == q
    assert ac.order is None
    # an engine refusal after the order existed: a ValidationError that still carries the order
    ve = error_from_response(422, {"error": "price_deviation", "message": "too far from the mark", "data": {"order": order}})
    assert type(ve) is ValidationError
    assert ve.order is not None and ve.order.status == "REJECTED"
    # malformed or absent detail never raises: empty lists, no order
    for body in ({"error": "mandate_denied", "message": "m"}, {"error": "mandate_denied", "message": "m", "data": {"reasons": "x", "order": "y"}}, {"error": "mandate_denied", "message": "m", "data": None},
                 {"error": "mandate_denied", "message": "m", "data": {"order": {"id": "o", "status": "open"}}}):  # fmt: skip
        e = error_from_response(403, body)
        assert (e.reasons, e.order) == ([], None)
    assert [c.id for c in error_from_response(422, {"error": "risk_denied", "message": "m", "data": {"checks": [1, None, {"id": "x", "ok": False, "observed": None, "limit": None, "detail": "d", "exempt": False}]}}).checks] == ["x"]
    assert error_from_response(403, {"error": "execution_disabled", "message": "m"}).order is None


@pytest.mark.parametrize("method", ["preview_order", "engage_kill_switch"])
def test_preview_and_kill_switch_are_safe_to_repeat_retried_like_a_read_never_outcome_unknown(mock: Any, method: str) -> None:
    sample = SAMPLES["previewOrder" if method == "preview_order" else "engageKillSwitch"]
    kwargs = ORDER if method == "preview_order" else {}
    h = mock([NET, fail(503, "venue_unavailable"), {"status": 502, "text": ""}, ok(sample)], max_retries=3)
    out = h.call(method, **kwargs)
    assert out.meta.attempts == 4 and out.meta.idempotency_key is None
    assert len({c.body for c in h.calls}) == 1
    assert all("idempotency-key" not in c.headers for c in h.calls)
    n = mock([NET], max_retries=1)
    e = n.error(method, **kwargs)
    assert type(e) is NetworkError and len(n.calls) == 2
    assert type(mock([TIMEOUT], max_retries=0).error(method, **kwargs)) is sp_wallet.TimeoutError
    s = mock([{"status": 500, "text": "oops"}], max_retries=2)
    assert type(s.error(method, **kwargs)) is ServerError and len(s.calls) == 1


def test_a_write_answered_200_with_an_answer_outside_the_contract_says_the_operation_ran(mock: Any) -> None:
    h = mock([ok({"order": {**ORDER_ROW, "status": "open"}, "idempotent": False, "approval": None})])
    e = h.error("create_order", **ORDER)
    assert type(e) is ServerError and e.code == "invalid_response"
    assert "the operation ran" in str(e)
    assert e.idempotency_key == h.calls[0].headers["idempotency-key"]


# ---------------------------------------------------------------------------------------------------------------- writes
def test_one_key_per_logical_call_and_the_same_key_and_bytes_on_every_retry(mock: Any) -> None:
    h = mock([NET, fail(503, "venue_unavailable"), {"status": 502, "text": ""}, fail(409, "idempotency_in_progress"), ok(SAMPLES["placeOrder"], **{"idempotent-replay": "true"})], max_retries=4)
    r = h.call("create_order", **ORDER, client_order_id="client-0001", reduce_only=False)
    assert len(h.calls) == 5
    keys = {c.headers["idempotency-key"] for c in h.calls}
    bodies = {c.body for c in h.calls}
    assert len(keys) == 1
    assert len(bodies) == 1
    key = next(iter(keys))
    assert re.fullmatch(UUID4, key)
    assert (r.meta.idempotency_key, r.meta.idempotent_replay, r.meta.attempts) == (key, True, 5)
    again = h.call("create_order", **ORDER)  # a second logical call gets another key
    assert again.meta.idempotency_key != key


def test_the_body_is_canonical_and_a_caller_key_is_sent_as_is(mock: Any) -> None:
    h = mock([ok(SAMPLES["placeOrder"])])
    h.call("create_order", order_type="limit", size="1", side="sell", price="2", instrument="hyperliquid:ETH", mode="live", idempotency_key="resume-key-0001")
    h.call("create_order", mode="live", instrument="hyperliquid:ETH", side="sell", order_type="limit", price="2", size="1", idempotency_key="resume-key-0001")
    assert h.calls[0].body == b'{"instrument":"hyperliquid:ETH","mode":"live","price":"2","side":"sell","size":"1","type":"limit"}'
    assert h.calls[1].body == h.calls[0].body
    assert [c.headers["idempotency-key"] for c in h.calls] == ["resume-key-0001"] * 2
    assert "x-spw-timestamp" not in h.calls[0].headers
    import time

    t = mock([ok(SAMPLES["cancelOrder"])], send_timestamp=True)
    t.call("cancel_order", "o1")
    assert abs(int(t.calls[0].headers["x-spw-timestamp"]) - time.time()) < 5


def test_a_timeout_on_a_write_is_outcome_unknown_and_carries_the_key_to_resume_with(mock: Any) -> None:
    h = mock([TIMEOUT], max_retries=1)
    e = h.error("create_order", **ORDER)
    assert type(e) is OutcomeUnknown
    assert not isinstance(e, (APIError, NetworkError))
    assert e.code == "outcome_unknown"
    assert len(h.calls) == 2
    assert e.idempotency_key == h.calls[0].headers["idempotency-key"] == h.calls[1].headers["idempotency-key"]
    assert e.idempotency_key in str(e)
    assert "may or may not have been executed" in str(e)
    assert "do not retry with a new key" in str(e)
    assert (e.method, e.path) == ("POST", "/api/v1/trading/orders")
    # resuming: the same call with the key of the error
    r = mock([ok(SAMPLES["placeOrder"], **{"idempotent-replay": "true"})])
    out = r.call("create_order", **ORDER, idempotency_key=e.idempotency_key)
    assert r.calls[0].headers["idempotency-key"] == e.idempotency_key
    assert out.meta.idempotent_replay is True
    assert (out.order.id, out.order.status) == ("o", "FILLED")


UNKNOWN_SCRIPTS: dict[str, list[Any]] = {
    "connection lost": [NET], "read error": [httpx.ReadError("reset")], "gateway 502": [{"status": 502, "text": "bad gateway"}], "gateway 504": [{"status": 504, "text": ""}],
    "bare 500": [fail(500, "internal")], "503 that is not the API's": [{"status": 503, "text": "<html>maintenance</html>"}],
    "still in progress": [fail(409, "idempotency_in_progress")], "2xx without JSON": [{"status": 200, "text": ""}],
    # an attempt without an answer, then an answer decided BEFORE the server looks at the key: it says nothing about the first attempt
    "timeout then 429": [TIMEOUT, fail(429, "rate_limited", headers={"retry-after": "600"})], "timeout then 401": [NET, fail(401, "unauthenticated")],
    "timeout then 403": [NET, fail(403, "ip_not_allowed")], "timeout then API 503": [NET, fail(503, "signer_unreachable")],
}  # fmt: skip


@pytest.mark.parametrize("name", sorted(UNKNOWN_SCRIPTS))
def test_outcome_unknown_for_every_way_a_write_can_end_without_a_trustworthy_answer(mock: Any, name: str) -> None:
    h = mock(UNKNOWN_SCRIPTS[name], max_retries=1)
    e = h.error("close_position", "p1")
    assert type(e) is OutcomeUnknown, name
    assert e.idempotency_key == h.calls[0].headers["idempotency-key"]
    assert len({(c.headers["idempotency-key"], c.body) for c in h.calls}) == 1


DEFINITE: list[tuple[list[Any], type]] = [
    ([NET, fail(501, "execution_not_wired")], ExecutionNotWired), ([NET, fail(400, "bad_request")], ValidationError), ([NET, fail(404, "unknown_order")], NotFound),
    ([NET, fail(409, "idempotency_conflict")], IdempotencyConflict), ([fail(503, "signer_unreachable")], ServiceUnavailable), ([fail(403, "mandate_required")], MandateRequired),
    ([fail(429, "rate_limited", headers={"retry-after": "600"})], RateLimited), ([fail(401, "unauthenticated")], AuthenticationError),
]  # fmt: skip


@pytest.mark.parametrize(("steps", "cls"), DEFINITE, ids=[c.__name__ + str(len(s)) for s, c in DEFINITE])
def test_a_definite_answer_stays_a_typed_error(mock: Any, steps: list[Any], cls: type) -> None:
    h = mock(steps, max_retries=1)
    e = h.error("cancel_order", "o1")
    assert type(e) is cls
    assert e.idempotency_key == h.calls[0].headers["idempotency-key"]


WRITES: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = [
    ("run_command", ("STOP ALL AGENTS",), {}), ("create_order", (), ORDER), ("cancel_order", ("o",), {}), ("close_position", ("p",), {}), ("reduce_position", ("p",), {"fraction": "0.5"}),
    ("create_strategy", (), {"kind": "spot", "path": "x"}), ("backtest_strategy", ("s",), {}), ("start_strategy", ("s",), {"mode": "paper"}), ("stop_strategy", ("s",), {}),
    ("create_agent", (), {"kind": "spot", "name": "ab", "universe": ["BTC"]}), ("start_agent", ("a",), {"mode": "paper"}), ("stop_agent", ("a",), {}),
]  # fmt: skip


def test_there_are_twelve_write_methods() -> None:
    assert len(WRITES) == 12 == sum(1 for o in sp_wallet.OPERATIONS.values() if o[4])


@pytest.mark.parametrize(("name", "args", "kwargs"), WRITES, ids=[w[0] for w in WRITES])
def test_501_execution_not_wired_is_an_error_on_every_write_method_never_a_success(mock: Any, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
    h = mock([fail(501, "execution_not_wired", "declared but not connected to execution yet; nothing was done")])
    e = h.error(name, *args, **kwargs)
    assert type(e) is ExecutionNotWired
    assert isinstance(e, sp_wallet.NotImplementedError)
    assert e.status == 501
    assert e.idempotency_key == h.calls[0].headers["idempotency-key"]
    assert len(h.calls) == 1  # 501 is not retried


def test_with_options_changes_one_call_and_shares_the_connections(mock: Any) -> None:
    h = mock([NET], max_retries=5)
    once = h.client.with_options(max_retries=0, timeout=3)
    assert (once.max_retries, once.timeout, h.client.max_retries, h.client.timeout) == (0, 3.0, 5, 30.0)
    assert once._http is h.client._http
    assert once._owns_http is False
    h.client = once
    assert type(h.error("get_risk")) is NetworkError
    assert len(h.calls) == 1
    for bad in ({"timeout": 0}, {"max_retries": -1}):
        with pytest.raises(ConfigurationError):
            once.with_options(**bad)
    assert isinstance(mock([ok()]).error("cancel_order", "o1", idempotency_key="short"), ConfigurationError)

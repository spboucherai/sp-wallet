"""Unit tests of the client surface with a mocked transport (both clients): every method sends exactly the documented
request, the constructor refuses unsafe configurations, order sizing and wait_for_order."""

from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any

import pytest

import sp_wallet
from conftest import KEY, OPENAPI, ROOT, P, ok
from sp_wallet import OPERATIONS, AsyncSPWallet, ConfigurationError, SPWallet, WaitTimeout, WriteResult, models

ORDER = {"mode": "paper", "instrument": "hyperliquid:BTC", "side": "buy", "type": "market", "size": "0.01"}
ORDER_KW: dict[str, Any] = {"instrument": "hyperliquid:BTC", "side": "buy", "order_type": "market", "size": "0.01"}
MARKET = {"id": "hyperliquid:BTC", "venue": "hyperliquid", "kind": "perpetual", "symbol": "BTC", "base": "BTC", "quote": "USD", "status": "active", "mark": "64907", "ts": 1, "stale": False}

#: operationId -> (method name, args, kwargs, path, query, body)
CASES: dict[str, tuple[str, tuple[Any, ...], dict[str, Any], str, dict[str, str], Any]] = {
    "getOpenApi": ("openapi", (), {}, "/openapi.json", {}, None),
    "listMarkets": ("list_markets", (), {"venue": "hyperliquid", "kind": "perpetual", "q": "btc", "limit": 5}, "/markets", {"venue": "hyperliquid", "kind": "perpetual", "q": "btc", "limit": "5"}, None),
    "getMarket": ("get_market", ("gmx:BTC/USD [BTC-USDC]",), {}, "/markets/gmx%3ABTC%2FUSD%20%5BBTC-USDC%5D", {}, None),
    "getOrderbook": ("get_orderbook", ("hyperliquid:BTC",), {"depth": 5}, "/markets/hyperliquid%3ABTC/orderbook", {"depth": "5"}, None),
    "getCandles": ("get_candles", ("hyperliquid:BTC",), {"interval": "1h", "limit": 10}, "/markets/hyperliquid%3ABTC/candles", {"interval": "1h", "limit": "10"}, None),
    "getPortfolio": ("get_portfolio", (), {}, "/portfolio", {}, None),
    "getBalances": ("get_balances", (), {"network": "ethereum"}, "/balances", {"network": "ethereum"}, None),
    "getActivity": ("get_activity", (), {"limit": 20}, "/activity", {"limit": "20"}, None),
    "listPositions": ("get_positions", (), {"mode": "paper", "venue": "hyperliquid"}, "/positions", {"mode": "paper", "venue": "hyperliquid"}, None),
    "listOrders": ("list_orders", (), {"mode": "live", "open": True, "limit": 7}, "/orders", {"mode": "live", "open": "true", "limit": "7"}, None),
    "getOrder": ("get_order", ("deriv:acc:cid",), {}, "/orders/deriv%3Aacc%3Acid", {}, None),
    "listStrategies": ("list_strategies", (), {"kind": "perp"}, "/strategies", {"kind": "perp"}, None),
    "listAgents": ("list_agents", (), {}, "/agents", {}, None),
    "getRisk": ("get_risk", (), {}, "/risk", {}, None),
    "previewOrder": ("preview_order", (), ORDER_KW, "/orders/preview", {}, ORDER),
    "placeOrder": (
        "create_order", (),
        {**ORDER_KW, "order_type": "limit", "price": Decimal("60000"), "tif": "alo", "reduce_only": False, "slippage_bps": 10, "client_order_id": "my-order-0001"},
        "/orders", {}, {**ORDER, "type": "limit", "price": "60000", "tif": "alo", "reduceOnly": False, "slippageBps": 10, "clientOrderId": "my-order-0001"},
    ),
    "cancelOrder": ("cancel_order", ("deriv:acc:cid",), {}, "/orders/deriv%3Aacc%3Acid", {}, None),
    "closePosition": ("close_position", ("pos-1",), {"slippage_bps": 25}, "/positions/pos-1/close", {}, {"slippageBps": 25}),
    "reducePosition": ("reduce_position", ("pos-1",), {"fraction": Decimal("0.5")}, "/positions/pos-1/reduce", {}, {"fraction": "0.5"}),
    "createStrategy": ("create_strategy", (), {"kind": "perp", "path": "momentum/v1"}, "/strategies", {}, {"kind": "perp", "path": "momentum/v1"}),
    "backtestStrategy": ("backtest_strategy", ("s1",), {"symbols": ["BTC"], "interval": "1h"}, "/strategies/s1/backtest", {}, {"symbols": ["BTC"], "interval": "1h"}),
    "startStrategy": ("start_strategy", ("s1",), {"mode": "paper"}, "/strategies/s1/start", {}, {"mode": "paper"}),
    "stopStrategy": ("stop_strategy", ("s1",), {"reason": "done"}, "/strategies/s1/stop", {}, {"reason": "done"}),
    "createAgent": ("create_agent", (), {"kind": "perp", "name": "alpha", "universe": ["BTC", "ETH"]}, "/agents", {}, {"kind": "perp", "name": "alpha", "universe": ["BTC", "ETH"]}),
    "startAgent": ("start_agent", ("a1",), {"mode": "paper"}, "/agents/a1/start", {}, {"mode": "paper"}),
    "stopAgent": ("stop_agent", ("a1",), {}, "/agents/a1/stop", {}, {}),
}  # fmt: skip

#: a minimal valid answer per read operation (the typed model must accept it)
SAMPLES: dict[str, Any] = {
    "getOpenApi": {"openapi": "3.1.0", "paths": {}},
    "listMarkets": {"markets": [MARKET], "total": 1, "truncated": False, "errors": [], "ts": 1},
    "getMarket": {"market": MARKET, "instrument": {"lotSize": "0.00001"}, "ticker": None, "quality": None, "ts": 1, "source": "venue"},
    "getOrderbook": {"id": "hyperliquid:BTC", "bids": [["64901", "1.5"]], "asks": [["64902", "2"]], "ts": 1, "stale": False, "source": "venue"},
    "getCandles": {"id": "x", "interval": "1h", "candles": [{"ts": 1, "open": "1", "high": "2", "low": "0.5", "close": "1.5", "volume": "10"}], "ts": 1, "stale": False, "source": "venue"},
    "getPortfolio": {
        "asOf": "2026-11-16T00:00:00Z",
        "wallet": {"valueUsd": 12.5, "priced": 1, "unpriced": 0, "pricesAsOf": None, "balances": [{"network": "ethereum", "symbol": "ETH", "display": "0.1", "valueUsd": 12.5}]},
        "accounts": [{"mode": "paper", "venue": "hyperliquid", "accountId": "a", "equity": "1000.5", "error": None}],
        "totals": {"walletUsd": 12.5, "liveVenueEquity": None, "paperEquity": "1000.5"}, "halted": False, "errors": [],
    },
    "getBalances": {"asOf": "x", "balances": [{"network": "ethereum", "asset": "native", "symbol": "ETH", "decimals": 18, "amount": "1", "display": "0.000000000000000001", "error": None}], "errors": []},
    "getActivity": {"items": [{"kind": "fill", "at": "2026-11-16T00:00:00Z", "mode": "paper"}]},
    "listPositions": {"positions": [{"id": "p", "mode": "paper", "venue": "hyperliquid", "accountId": "a", "instrument": "hyperliquid:BTC", "side": "long", "size": "0.5", "entryPrice": "60000", "markPrice": None, "unrealizedPnl": None, "source": "paper"}], "errors": [], "ts": 1},
    "listOrders": {"orders": [{"id": "o", "mode": "paper", "venue": "hyperliquid", "accountId": None, "instrument": None, "side": None, "type": "market", "status": "filled", "final": True, "createdAt": 1, "updatedAt": 2}], "ts": 1},
    "getOrder": {"order": {"id": "o", "mode": "paper", "venue": "hyperliquid", "status": "filled", "final": True}, "fills": [{"price": "1"}]},
    "listStrategies": {"library": [{"kind": "perp", "path": "p", "sha256": "s"}], "versions": [], "errors": []},
    "listAgents": {"agents": [{"id": "a", "kind": "perp", "name": "n", "state": "CREATED", "mode": "PAPER", "tradingMode": None, "venue": "hyperliquid", "universe": ["BTC"], "interval": "1h"}]},
    "getRisk": {"killSwitch": {"signerReachable": True, "signerHalted": False, "note": "n"}, "signerPolicy": None, "capabilityLocks": [{"id": "x", "on": True, "why": "y"}], "accounts": [], "errors": [], "ts": 1},
}  # fmt: skip


def test_every_operation_of_the_document_has_a_case() -> None:
    """A new operation in the OpenAPI document fails this test until the SDK covers it."""
    ids = sorted(o["operationId"] for item in OPENAPI["paths"].values() for o in item.values())
    assert sorted(CASES) == ids == sorted(OPERATIONS)
    assert sorted(SAMPLES) == sorted(models.RESPONSE_MODELS)
    for name in {c[0] for c in CASES.values()} | {"wait_for_order"}:
        assert callable(getattr(SPWallet, name)), name
        assert callable(getattr(AsyncSPWallet, name)), name


@pytest.mark.parametrize("op_id", sorted(CASES))
def test_operation_sends_the_documented_request(mock: Any, op_id: str) -> None:
    name, args, kwargs, path, query, body = CASES[op_id]
    method, template, _scope, _implemented, idempotent, _mandate = OPERATIONS[op_id]
    h = mock([ok(SAMPLES.get(op_id, {"fine": True}), **{"ratelimit-limit": "120", "ratelimit-remaining": "119", "ratelimit-reset": "60"})])
    out = h.call(name, *args, **kwargs)
    assert len(h.calls) == 1
    c = h.calls[0]
    assert c.method == method
    assert c.raw_path == P + path
    assert re.fullmatch(re.sub(r"\\\{[a-z]+\\\}", "[^/]+", re.escape(template)), c.raw_path)
    assert c.query == query
    assert c.headers["authorization"] == f"Bearer {KEY}"
    assert c.headers["user-agent"] == f"sp-wallet-python/{sp_wallet.__version__}"
    assert "cookie" not in c.headers
    if idempotent:
        assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", c.headers["idempotency-key"])
        assert isinstance(out, WriteResult)
        assert out.meta.idempotency_key == c.headers["idempotency-key"]
        assert out.to_dict() == {"fine": True}
        assert out.fine is True
    else:
        assert "idempotency-key" not in c.headers
        assert type(out) is models.RESPONSE_MODELS[op_id]
        assert set(out.to_dict()) == set(SAMPLES[op_id])  # the API's own member names, nothing lost
    if body is None:
        assert c.body is None
        assert "content-type" not in c.headers
    else:
        assert json.loads(c.body) == body
        assert c.headers["content-type"] == "application/json"
    assert out.meta.status == 200
    assert out.meta.request_id == "req-1"
    assert (out.meta.rate_limit.limit, out.meta.rate_limit.remaining, out.meta.rate_limit.reset_seconds) == (120, 119, 60.0)
    assert out.meta.attempts == 1


def test_typed_models_keep_money_as_decimal_strings_and_never_build_a_float(mock: Any) -> None:
    h = mock([ok(SAMPLES["getOrderbook"]), {"status": 200, "text": json.dumps(SAMPLES["getPortfolio"])}, ok(SAMPLES["getMarket"])])
    book = h.call("get_orderbook", "hyperliquid:BTC")
    assert book.bids == [("64901", "1.5")]
    assert isinstance(book.bids[0][0], str)
    assert sp_wallet.to_decimal(book.bids[0][0]) == Decimal("64901")
    p = h.call("get_portfolio")
    # the API sends these as JSON numbers: they are parsed as Decimal, not as binary floats
    assert p.wallet.value_usd == Decimal("12.5")
    assert isinstance(p.wallet.value_usd, Decimal)
    assert isinstance(p.wallet.balances[0].value_usd, Decimal)
    assert p.totals.paper_equity == "1000.5"
    assert p.accounts[0].account_id == "a"
    assert p.as_of == "2026-11-16T00:00:00Z"
    m = h.call("get_market", "hyperliquid:BTC")
    assert m.market.mark == "64907"
    assert m.instrument == {"lotSize": "0.00001"}

    def no_float(v: Any) -> None:
        assert not isinstance(v, float), v
        for x in v.values() if isinstance(v, dict) else v if isinstance(v, (list, tuple)) else ():
            no_float(x)

    for r in (book, p, m):
        no_float(r.model_dump())


def test_an_answer_that_breaks_the_contract_is_a_server_error_not_a_silent_object(mock: Any) -> None:
    h = mock([ok({"markets": "nope", "total": 1})])
    e = h.error("list_markets")
    assert isinstance(e, sp_wallet.ServerError)
    assert e.code == "invalid_response"
    assert "does not match the contract" in str(e)
    assert e.request_id == "req-1"


def test_construction_env_and_refusals(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SP_WALLET_API_KEY", raising=False)
    monkeypatch.delenv("SP_WALLET_BASE_URL", raising=False)
    for cls in (SPWallet, AsyncSPWallet):
        with pytest.raises(ConfigurationError):
            cls()
        monkeypatch.setenv("SP_WALLET_API_KEY", KEY)
        assert cls().base_url == "https://wallet.spboucher.ai"
        monkeypatch.setenv("SP_WALLET_BASE_URL", "http://localhost:8650/")
        assert cls().base_url == "http://localhost:8650"
        assert cls(base_url="https://other.example").base_url == "https://other.example"
        monkeypatch.delenv("SP_WALLET_API_KEY")
        monkeypatch.delenv("SP_WALLET_BASE_URL")
        with pytest.raises(ConfigurationError, match="https"):
            cls(KEY, base_url="http://wallet.example")
        assert cls(KEY, base_url="http://wallet.example", allow_insecure_http=True).base_url == "http://wallet.example"
        for bad in ({"base_url": "https://u:p@wallet.example"}, {"base_url": "ftp://wallet.example"}, {"max_retries": -1}, {"timeout": 0}):
            with pytest.raises(ConfigurationError):
                cls(KEY, **bad)
        with pytest.raises(ConfigurationError):
            cls(KEY + "\n")
        assert cls(KEY, user_agent="my-bot/2").user_agent == f"sp-wallet-python/{sp_wallet.__version__} my-bot/2"


def test_version_and_pins() -> None:
    text = (ROOT / "sdk/python/pyproject.toml").read_text()  # (tomllib is 3.11+; the SDK supports 3.10)
    assert f'version = "{sp_wallet.__version__}"' in text
    assert 'name = "sp-wallet-python"' in text
    deps = re.findall(r'^    "([^" :]+)",$', text, flags=re.M)
    assert {d.split("==")[0] for d in deps} >= {"httpx", "pydantic", "pytest", "ruff"}
    for dep in deps:
        assert re.fullmatch(r"[a-z0-9-]+==[0-9][0-9a-z.]*", dep), f"{dep} is not an exact pin"
    assert (ROOT / "sdk/python/src/sp_wallet/py.typed").exists()
    assert (ROOT / "sdk/python/uv.lock").exists()


def test_context_managers_close_only_their_own_http_client() -> None:
    import asyncio

    import httpx

    with SPWallet(KEY) as c:
        assert not c._http.is_closed
    assert c._http.is_closed
    mine = httpx.Client()
    with SPWallet(KEY, http_client=mine):
        pass
    assert not mine.is_closed
    mine.close()

    async def run() -> bool:
        async with AsyncSPWallet(KEY) as a:
            pass
        return a._http.is_closed

    assert asyncio.run(run())


# ---------------------------------------------------------------------------------------------------------------- orders
def test_order_arguments(mock: Any) -> None:
    h = mock([ok()])
    h.call("preview_order", exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", size="0.01")
    assert json.loads(h.calls[0].body) == ORDER
    bad: list[dict[str, Any]] = [
        {**ORDER_KW, "size": 0.01}, {**ORDER_KW, "size": "1e-2"}, {**ORDER_KW, "size": "-1"}, {**ORDER_KW, "size": Decimal("-1")}, {**ORDER_KW, "price": "60,000"},
        {**ORDER_KW, "size": None}, {**ORDER_KW, "notional_usdc": 100}, {**ORDER_KW, "exchange": "hyperliquid"}, {"side": "buy", "order_type": "market", "size": "1"},
        {**ORDER_KW, "size": None, "notional_usdc": 99.5}, {**ORDER_KW, "side": "hold"}, {**ORDER_KW, "order_type": "iceberg"}, {**ORDER_KW, "mode": "real"},
        {**ORDER_KW, "client_order_id": "short"}, {**ORDER_KW, "slippage_bps": 501}, {**ORDER_KW, "tif": "fok"}, {**ORDER_KW, "account_id": "not-a-uuid"},
    ]  # fmt: skip
    for kw in bad:
        assert isinstance(h.error("create_order", **kw), ConfigurationError), kw
    assert len(h.calls) == 1  # refused locally: nothing was sent
    # Decimal and int are accepted and sent as plain decimal strings
    h.call("create_order", instrument="hyperliquid:BTC", side="sell", order_type="limit", size=Decimal("1.50"), price=60000, mode="live")
    assert json.loads(h.calls[1].body) == {"mode": "live", "instrument": "hyperliquid:BTC", "side": "sell", "type": "limit", "size": "1.50", "price": "60000"}
    h.call("create_order", instrument="x:y", side="sell", order_type="market", size=Decimal("1E-7"))
    assert json.loads(h.calls[2].body)["size"] == "0.0000001"


def test_notional_usdc_reads_the_market_and_rounds_the_size_down(mock: Any) -> None:
    market = {**SAMPLES["getMarket"]}
    h = mock([ok(market), ok({"previewed": True})])
    h.call("preview_order", exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)
    assert [(c.method, c.raw_path) for c in h.calls] == [("GET", f"{P}/markets/hyperliquid%3ABTC"), ("POST", f"{P}/orders/preview")]
    assert json.loads(h.calls[1].body) == {**ORDER, "size": "0.00154"}
    for mk in (
        {**market, "market": {**MARKET, "stale": True}},
        {**market, "market": {**MARKET, "mark": None}},
        {**market, "instrument": {"lotSize": "1"}},
    ):
        x = mock([ok(mk)])
        assert isinstance(x.error("create_order", instrument="hyperliquid:BTC", side="buy", order_type="market", notional_usdc="100"), ConfigurationError)
        assert len(x.calls) == 1


def test_other_write_arguments_are_validated_locally_with_the_contract(mock: Any) -> None:
    h = mock([ok()])
    for name, args, kw in (
        ("reduce_position", ("p",), {"fraction": "1.5"}), ("reduce_position", ("p",), {"fraction": 0.5}), ("close_position", ("p",), {"slippage_bps": 0}),
        ("create_agent", (), {"kind": "perp", "name": "x", "universe": ["BTC"]}), ("create_agent", (), {"kind": "perp", "name": "ok", "universe": []}),
        ("backtest_strategy", ("s",), {"symbols": ["btc"]}), ("start_strategy", ("s",), {"mode": "real"}), ("start_strategy", ("s",), {"mode": "paper", "agent_id": "x"}),
        ("stop_agent", ("a",), {"reason": "x" * 201}), ("cancel_order", ("",), {}), ("get_order", ("",), {}), ("cancel_order", ("o",), {"idempotency_key": "short"}),
        ("cancel_order", ("o",), {"idempotency_key": "bad key with spaces"}),
    ):  # fmt: skip
        assert isinstance(h.error(name, *args, **kw), ConfigurationError), (name, kw)
    assert h.calls == []


# ---------------------------------------------------------------------------------------------------------------- wait_for_order
def _order(status: str, final: bool | None = None) -> dict[str, Any]:
    return ok({"order": {"id": "o1", "mode": "paper", "venue": "hyperliquid", "status": status, "final": final}, "fills": []})


def test_wait_for_order_polls_until_final_and_unknown_is_not_final(mock: Any) -> None:
    h = mock([_order("SUBMITTED"), _order("UNKNOWN"), _order("PARTIALLY_FILLED"), _order("FILLED")])
    r = h.call("wait_for_order", "o1", poll_interval=0.01)
    assert r.order.status == "FILLED"
    assert len(h.calls) == 4
    assert h.sleeps == [0.01, 0.01, 0.01]
    for s in ("CANCELLED", "canceled", "REJECTED", "FAILED", "filled"):
        assert mock([_order(s)]).call("wait_for_order", "o1").order.status == s


def test_wait_for_order_legacy_statuses_use_the_final_flag_and_timeout_is_not_a_failure(mock: Any) -> None:
    h = mock([_order("open", False), _order("triggered", False), _order("expired", True)])
    assert h.call("wait_for_order", "o1", poll_interval=0.001).order.status == "expired"
    # a status that IS one of the twelve states is judged by the state: UNKNOWN + final=True still waits
    e = mock([_order("UNKNOWN", True)]).error("wait_for_order", "o1", timeout=0)
    assert isinstance(e, WaitTimeout)
    e = mock([_order("SUBMITTED")]).error("wait_for_order", "o1", timeout=0)
    assert isinstance(e, WaitTimeout)
    assert "not failed" in str(e)
    assert e.last.order.status == "SUBMITTED"
    custom = mock([_order("AWAITING_APPROVAL")]).call("wait_for_order", "o1", until=lambda o: o.status == "AWAITING_APPROVAL")
    assert custom.order.status == "AWAITING_APPROVAL"

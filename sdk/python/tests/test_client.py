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
from sp_wallet import OPERATIONS, AsyncSPWallet, ConfigurationError, ServerError, SPWallet, WaitTimeout, WriteResult, models

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
    "compareMarkets": ("compare_markets", (), {"underlying": "BTC", "side": "long", "notional": Decimal("1000"), "horizon_hours": 24}, "/markets/compare", {"underlying": "BTC", "side": "long", "notional": "1000", "horizonHours": "24"}, None),
    "listPrivateMarkets": ("list_private_markets", (), {"delisted": True, "size": "2", "side": "long"}, "/private-markets", {"delisted": "true", "size": "2", "side": "long"}, None),
    "getPrivateMarket": ("get_private_market", ("hyperliquid:io:ANTH",), {"interval": "1d", "limit": 30}, "/private-markets/hyperliquid%3Aio%3AANTH", {"interval": "1d", "limit": "30"}, None),
    "getPrivateMarketCompany": ("get_private_market_company", ("anthropic",), {"side": "short"}, "/private-markets/companies/anthropic", {"side": "short"}, None),
    "getPortfolio": ("get_portfolio", (), {}, "/portfolio", {}, None),
    "getBalances": ("get_balances", (), {"network": "ethereum"}, "/balances", {"network": "ethereum"}, None),
    "getActivity": ("get_activity", (), {"limit": 20, "cursor": "abc_-"}, "/activity", {"limit": "20", "cursor": "abc_-"}, None),
    "listPositions": ("get_positions", (), {"mode": "paper", "venue": "hyperliquid"}, "/positions", {"mode": "paper", "venue": "hyperliquid"}, None),
    "listOrders": ("list_orders", (), {"mode": "live", "open": True, "limit": 7, "cursor": "abc_-"}, "/orders", {"mode": "live", "open": "true", "limit": "7", "cursor": "abc_-"}, None),
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
    "runCommand": ("run_command", ("LONG BTC-PERP 500 x2",), {"dry_run": True}, "/commands", {}, {"text": "LONG BTC-PERP 500 x2", "mode": "paper", "dryRun": True}),
    "engageKillSwitch": ("engage_kill_switch", ("drill",), {}, "/risk/kill-switch", {}, {"reason": "drill"}),
    "createStrategy": ("create_strategy", (), {"kind": "perp", "path": "momentum/v1"}, "/strategies", {}, {"kind": "perp", "path": "momentum/v1"}),
    "backtestStrategy": ("backtest_strategy", ("s1",), {"symbols": ["BTC"], "interval": "1h"}, "/strategies/s1/backtest", {}, {"symbols": ["BTC"], "interval": "1h"}),
    "startStrategy": ("start_strategy", ("s1",), {"mode": "paper"}, "/strategies/s1/start", {}, {"mode": "paper"}),
    "stopStrategy": ("stop_strategy", ("s1",), {"reason": "done"}, "/strategies/s1/stop", {}, {"reason": "done"}),
    "createAgent": ("create_agent", (), {"kind": "perp", "name": "alpha", "universe": ["BTC", "ETH"]}, "/agents", {}, {"kind": "perp", "name": "alpha", "universe": ["BTC", "ETH"]}),
    "startAgent": ("start_agent", ("a1",), {"mode": "paper"}, "/agents/a1/start", {}, {"mode": "paper"}),
    "stopAgent": ("stop_agent", ("a1",), {}, "/agents/a1/stop", {}, {}),
}  # fmt: skip

ORDER_ROW = {
    "id": "o", "mode": "paper", "venue": "hyperliquid", "network": "mainnet", "accountId": None, "instrument": None, "side": None, "type": "market",
    "status": "FILLED", "engineStatus": "filled", "final": True, "createdAt": 1, "updatedAt": 2,
}  # fmt: skip
INSTRUMENT = {
    "id": "hyperliquid:BTC", "venue": "hyperliquid", "symbol": "BTC", "base": "BTC", "quote": "USD", "kind": "perpetual", "collateral": "USDC", "settlement": "USDC",
    "tickSize": "0.1", "lotSize": "0.00001", "minOrderSize": None, "minNotional": "10", "maxLeverage": "40", "marginModes": ["cross", "isolated"],
    "fundingIntervalSec": 3600, "markPriceMethod": "oracle", "status": "active",
}  # fmt: skip
CANONICAL = {
    "v": 1, "venue": "hyperliquid", "network": "mainnet", "instrument": "hyperliquid:BTC", "marketKind": "perp", "side": "buy", "type": "market", "size": "0.01",
    "notional": None, "limitPrice": None, "triggerPrice": None, "reduceOnly": False, "tif": "ioc", "maxSlippageBps": 50, "maxFeeUsd": "1", "leverage": None,
    "clientOrderId": "c", "mode": "paper", "principal": {"kind": "api_key", "id": "spk_0123456789ab"}, "mandateId": None, "createdAt": 1, "expiresAt": 2,
}  # fmt: skip
SWITCH = {"on": True, "at": 1, "by": {"kind": "api_key", "id": "spk_0123456789ab"}, "reason": "drill"}
SWITCH_OFF = {"on": False, "at": None, "by": None, "reason": None}
_DATUM = {"value": None, "source": "venue", "ts": None, "stale": False}
PM_ROW = {
    "id": "hyperliquid:io:ANTH", "venue": "hyperliquid", "platform": "io", "symbol": "ANTH", "company": {"slug": "anthropic", "name": "Anthropic"}, "status": "live",
    "review": {"state": "reviewed", "reasons": []},
    "contract": {"nature": "synthetic", "unit": {"kind": "unknown", "label": "?"}, "quoteCurrency": "USD", "settlement": "cash", "oracle": "venue", "liquidation": "venue"},
    "market": {"price": {**_DATUM, "value": "250.5"}, "funding": {**_DATUM, "intervalSec": 3600}, "openInterest": _DATUM, "volume24h": _DATUM},
    "valuation": {
        "syntheticPrice": {"value": "250.5"}, "contractMarketValue": {"value": None, "reason": "r"}, "notionalExposure": {"value": "250.5", "hypothetical": True},
        "impliedValuation": {"value": None, "formula": None, "reason": "r", "reasonCode": "c"}, "lastPrivateValuation": None, "premiumDiscount": {"premiumBps": None}, "caveats": [],
    },
    "tradable": False, "notTradable": {"code": "display_only", "reasons": []}, "error": None,
}  # fmt: skip

#: a minimal valid answer per operation that has a success schema (the typed model must accept it)
SAMPLES: dict[str, Any] = {
    "getOpenApi": {"openapi": "3.1.0", "paths": {}},
    "listMarkets": {"markets": [MARKET], "total": 1, "truncated": False, "errors": [], "ts": 1},
    "compareMarkets": {"underlying": "BTC", "category": None, "request": {}, "rows": [], "discrepancies": [], "texts": {"disclaimer": "estimates"}, "warnings": [], "errors": [], "ts": 1, "source": "venue"},
    "getMarket": {"market": MARKET, "instrument": INSTRUMENT, "ticker": None, "quality": None, "ts": 1, "source": "venue"},
    "getOrderbook": {"id": "hyperliquid:BTC", "bids": [["64901", "1.5"]], "asks": [["64902", "2"]], "ts": 1, "stale": False, "source": "venue"},
    "getCandles": {"id": "x", "interval": "1h", "candles": [{"ts": 1, "open": "1", "high": "2", "low": "0.5", "close": "1.5", "volume": "10"}], "ts": 1, "stale": False, "source": "venue"},
    "listPrivateMarkets": {"markets": [PM_ROW], "companies": [{"slug": "anthropic", "name": "Anthropic", "contracts": ["hyperliquid:io:ANTH"]}], "excluded": [], "venues": [{"venue": "hyperliquid", "status": "ok", "error": None}], "notice": {"tradable": False, "code": "display_only", "text": "t"}, "ts": 1},
    "getPrivateMarketCompany": {"company": {"slug": "anthropic", "name": "Anthropic"}, "contracts": [PM_ROW], "delisted": [], "references": [], "merged": None, "ts": 1},
    "getPrivateMarket": {"market": PM_ROW, "book": {}, "candles": {}, "references": [], "ts": 1},
    "getPortfolio": {
        "asOf": "2026-11-16T00:00:00Z",
        "wallet": {"valueUsd": "12.5", "priced": 1, "unpriced": 0, "pricesAsOf": None, "balances": [{"network": "ethereum", "symbol": "ETH", "display": "0.1", "valueUsd": "12.5"}]},
        "accounts": [{"mode": "paper", "venue": "hyperliquid", "accountId": "a", "equity": "1000.5", "error": None}],
        "totals": {"walletUsd": "12.5", "liveVenueEquity": None, "paperEquity": "1000.5", "note": "three separate figures"}, "halted": None, "errors": [],
    },
    "getBalances": {"asOf": "x", "balances": [{"network": "ethereum", "asset": "native", "symbol": "ETH", "decimals": 18, "amount": "1", "display": "0.000000000000000001", "error": None}], "errors": [], "halted": False},
    "getActivity": {"items": [{"kind": "fill", "at": "2026-11-16T00:00:00Z", "mode": "paper"}], "nextCursor": None},
    "listPositions": {"positions": [{"id": "p", "mode": "paper", "venue": "hyperliquid", "accountId": "a", "instrument": "hyperliquid:BTC", "side": "long", "size": "0.5", "entryPrice": "60000", "markPrice": None, "unrealizedPnl": None, "source": "paper"}], "errors": [], "ts": 1},
    "listOrders": {"orders": [ORDER_ROW], "nextCursor": "abc", "ts": 1},
    "getOrder": {"order": ORDER_ROW, "fills": [{"id": "f", "instrument": "hyperliquid:BTC", "side": "buy", "price": "1", "size": "1", "fee": "0", "feeAsset": "USDC", "closedPnl": None, "liquidation": False, "ts": 1}]},
    "listStrategies": {"library": [{"kind": "perp", "path": "p", "sha256": "s"}], "versions": [], "errors": []},
    "listAgents": {"agents": [{"id": "a", "kind": "perp", "name": "n", "state": "CREATED", "mode": "PAPER", "tradingMode": None, "venue": "hyperliquid", "universe": ["BTC"], "interval": "1h"}]},
    "getRisk": {"killSwitch": {"signerReachable": True, "signerHalted": False, "note": "n"}, "signerPolicy": None, "capabilityLocks": [{"id": "x", "on": True, "why": "y"}], "accounts": [], "errors": [], "ts": 1,
                "engine": {"killSwitch": SWITCH_OFF, "readOnly": SWITCH_OFF, "note": "n"}},
    "previewOrder": {
        "order": CANONICAL, "hash": "ab" * 32, "resolved": {"size": "0.01", "worstPrice": "65000", "notionalUsd": "650"}, "wouldExecute": True, "refusals": [],
        "approval": {"required": False, "by": "mandate"}, "risk": {"decision": "allow", "reducing": False, "checks": [], "derived": {"size": "0.01", "notional": None, "referencePrice": "65000"}},
        "mandate": None, "engine": {"name": "paper", "risk": None, "estimate": None}, "account": {"id": "a", "venue": "hyperliquid", "network": "mainnet", "withheld": True}, "ts": 1,
    },
    "placeOrder": {"order": ORDER_ROW, "idempotent": False, "approval": None},
    "closePosition": {"order": ORDER_ROW, "idempotent": False, "approval": None},
    "reducePosition": {"order": ORDER_ROW, "idempotent": False, "approval": None},
    "cancelOrder": {"order": {**ORDER_ROW, "status": "CANCELLED", "engineStatus": "cancelled"}, "sent": False, "changed": True},
    "runCommand": {"kind": "order", "command": "perp_open", "mode": "paper", "dryRun": True, "executed": False, "order": CANONICAL, "hash": "ab" * 32, "attached": []},
    "engageKillSwitch": {"killSwitch": SWITCH, "readOnly": SWITCH_OFF},
}  # fmt: skip


def test_every_operation_of_the_document_has_a_case() -> None:
    """A new operation in the OpenAPI document fails this test until the SDK covers it."""
    ids = sorted(o["operationId"] for item in OPENAPI["paths"].values() for o in item.values())
    assert sorted(CASES) == ids == sorted(OPERATIONS)
    assert sorted(SAMPLES) == sorted(models.RESPONSE_MODELS) == sorted(k for k, o in OPERATIONS.items() if o[3])
    for name in {c[0] for c in CASES.values()} | {"wait_for_order", "iter_orders", "iter_activity"}:
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
        assert out.meta.idempotency_key == c.headers["idempotency-key"]
    else:
        assert "idempotency-key" not in c.headers  # a read, or a POST the contract declares without a key (preview, kill switch)
        assert out.meta.idempotency_key is None
    if op_id in models.RESPONSE_MODELS:
        assert _implemented
        assert type(out) is models.RESPONSE_MODELS[op_id]
        assert set(SAMPLES[op_id]) <= set(out.to_dict())  # the API's own member names, nothing lost
    else:
        # not implemented by the server (501): no success schema exists, so no typed result either
        assert not _implemented
        assert isinstance(out, WriteResult)
        assert out.to_dict() == {"fine": True}
        assert out.fine is True
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
    h = mock([ok(SAMPLES["getOrderbook"]), {"status": 200, "text": json.dumps(SAMPLES["getPortfolio"])}, ok(SAMPLES["getMarket"]), ok(SAMPLES["placeOrder"])])
    book = h.call("get_orderbook", "hyperliquid:BTC")
    assert book.bids == [("64901", "1.5")]
    assert isinstance(book.bids[0][0], str)
    assert sp_wallet.to_decimal(book.bids[0][0]) == Decimal("64901")
    p = h.call("get_portfolio")
    # USD values are decimal STRINGS on the wire, like every amount of the API
    assert p.wallet.value_usd == "12.5"
    assert p.wallet.balances[0].value_usd == "12.5"
    assert p.totals.wallet_usd == "12.5"
    assert sp_wallet.to_decimal(p.totals.wallet_usd) == Decimal("12.5")
    assert p.totals.paper_equity == "1000.5"
    assert p.totals.note == "three separate figures"
    assert p.halted is None
    assert p.accounts[0].account_id == "a"
    assert p.as_of == "2026-11-16T00:00:00Z"
    m = h.call("get_market", "hyperliquid:BTC")
    assert m.market.mark == "64907"
    assert (m.instrument.lot_size, m.instrument.tick_size, m.instrument.min_order_size, m.instrument.min_notional, m.instrument.max_leverage) == ("0.00001", "0.1", None, "10", "40")
    placed = h.call("create_order", **ORDER_KW)
    assert type(placed) is models.PlacedOrder
    assert type(placed.order) is models.Order
    assert (placed.order.status, placed.order.final, placed.order.engine_status, placed.idempotent, placed.approval) == ("FILLED", True, "filled", False, None)

    def no_float(v: Any) -> None:
        assert not isinstance(v, float), v
        for x in v.values() if isinstance(v, dict) else v if isinstance(v, (list, tuple)) else ():
            no_float(x)

    for r in (book, p, m, placed):
        no_float(r.model_dump())
    # a JSON number where the contract says "decimal string" is refused: the answer does not match the contract
    bad = {**SAMPLES["getPortfolio"], "totals": {**SAMPLES["getPortfolio"]["totals"], "walletUsd": 12.5}}
    e = mock([{"status": 200, "text": json.dumps(bad)}]).error("get_portfolio")
    assert isinstance(e, ServerError)
    assert e.code == "invalid_response"
    # an order status outside the closed enum is refused too
    e = mock([ok({**SAMPLES["placeOrder"], "order": {**ORDER_ROW, "status": "open"}})]).error("create_order", **ORDER_KW)
    assert isinstance(e, ServerError)
    assert e.code == "invalid_response"


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
    h = mock([ok(SAMPLES["placeOrder"])])
    h.call("create_order", exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", size="0.01")
    assert json.loads(h.calls[0].body) == ORDER
    bad: list[dict[str, Any]] = [
        {**ORDER_KW, "size": 0.01}, {**ORDER_KW, "size": "1e-2"}, {**ORDER_KW, "size": "-1"}, {**ORDER_KW, "size": Decimal("-1")}, {**ORDER_KW, "price": "60,000"},
        {**ORDER_KW, "size": None}, {**ORDER_KW, "notional_usdc": 100}, {**ORDER_KW, "notional": "100"}, {**ORDER_KW, "size": None, "notional": "1", "notional_usdc": 1},
        {**ORDER_KW, "exchange": "hyperliquid"}, {"side": "buy", "order_type": "market", "size": "1"},
        {**ORDER_KW, "size": None, "notional_usdc": 99.5}, {**ORDER_KW, "size": None, "notional": 99.5}, {**ORDER_KW, "side": "hold"}, {**ORDER_KW, "order_type": "iceberg"}, {**ORDER_KW, "mode": "real"},
        {**ORDER_KW, "client_order_id": "short"}, {**ORDER_KW, "slippage_bps": 501}, {**ORDER_KW, "tif": "fok"}, {**ORDER_KW, "account_id": "not-a-uuid"}, {**ORDER_KW, "leverage": "2x"},
    ]  # fmt: skip
    for kw in bad:
        assert isinstance(h.error("create_order", **kw), ConfigurationError), kw
    assert len(h.calls) == 1  # refused locally: nothing was sent
    # Decimal and int are accepted and sent as plain decimal strings
    h.call("create_order", instrument="hyperliquid:BTC", side="sell", order_type="limit", size=Decimal("1.50"), price=60000, mode="live")
    assert json.loads(h.calls[1].body) == {"mode": "live", "instrument": "hyperliquid:BTC", "side": "sell", "type": "limit", "size": "1.50", "price": "60000"}
    h.call("create_order", instrument="x:y", side="sell", order_type="market", size=Decimal("1E-7"))
    assert json.loads(h.calls[2].body)["size"] == "0.0000001"


def test_a_notional_is_sent_as_it_is_the_server_sizes_the_order(mock: Any) -> None:
    """No market read, no arithmetic: `notional` (or its quick-start name `notional_usdc`) travels to the server."""
    h = mock([ok(SAMPLES["previewOrder"]), ok(SAMPLES["placeOrder"])])
    h.call("preview_order", exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional=Decimal("100.50"))
    h.call("create_order", instrument="hyperliquid:BTC", side="buy", order_type="market", notional_usdc=100)
    h.call("create_order", instrument="hyperliquid:BTC", side="buy", order_type="limit", price="60000", notional="250", leverage=2, max_fee_usd=Decimal("1.5"))
    assert [(c.method, c.raw_path) for c in h.calls] == [("POST", f"{P}/orders/preview"), ("POST", f"{P}/orders"), ("POST", f"{P}/orders")]
    base = {"mode": "paper", "instrument": "hyperliquid:BTC", "side": "buy"}
    assert [json.loads(c.body) for c in h.calls] == [
        {**base, "type": "market", "notional": "100.50"},
        {**base, "type": "market", "notional": "100"},
        {**base, "type": "limit", "price": "60000", "notional": "250", "leverage": "2", "maxFeeUsd": "1.5"},
    ]
    assert not hasattr(sp_wallet, "size_from_notional")


def test_preview_and_kill_switch_carry_no_idempotency_key_unless_the_caller_gives_one(mock: Any) -> None:
    h = mock([ok(SAMPLES["previewOrder"]), ok(SAMPLES["engageKillSwitch"]), ok(SAMPLES["previewOrder"])], send_timestamp=True)
    h.call("preview_order", **ORDER_KW)
    ks = h.call("engage_kill_switch")
    pv = h.call("preview_order", **ORDER_KW, idempotency_key="order-key-0001")
    assert [c.headers.get("idempotency-key") for c in h.calls] == [None, None, "order-key-0001"]
    assert all("x-spw-timestamp" not in c.headers for c in h.calls)
    assert json.loads(h.calls[1].body) == {"reason": ""}
    assert ks.kill_switch.on is True and ks.kill_switch.by.kind == "api_key" and ks.read_only.on is False
    assert pv.meta.idempotency_key == "order-key-0001" and pv.account.withheld is True and pv.account.equity is None


def test_run_command(mock: Any) -> None:
    h = mock([ok(SAMPLES["runCommand"])])
    r = h.call("run_command", "SHOW POSITIONS", mode="live", account_id="00000000-0000-4000-8000-000000000000", idempotency_key="cmd-key-0001")
    assert json.loads(h.calls[0].body) == {"text": "SHOW POSITIONS", "mode": "live", "accountId": "00000000-0000-4000-8000-000000000000", "dryRun": False}
    assert h.calls[0].headers["idempotency-key"] == "cmd-key-0001"
    assert (r.kind, r.dry_run, r.executed, r.order["instrument"]) == ("order", True, False, "hyperliquid:BTC")
    for bad in ("", "   ", "x" * 301):
        assert isinstance(h.error("run_command", bad), ConfigurationError)
    assert len(h.calls) == 1


# ---------------------------------------------------------------------------------------------------------------- pagination
def _page(ids: list[str], next_cursor: str | None) -> dict[str, Any]:
    return ok({"orders": [{**ORDER_ROW, "id": i} for i in ids], "items": [{"kind": "fill", "at": "t", "mode": "paper", "id": i} for i in ids], "nextCursor": next_cursor, "ts": 1})


def test_iter_orders_follows_next_cursor_with_the_same_filters(mock: Any) -> None:
    h = mock([_page(["a", "b"], "c1"), _page(["c", "d"], "c2"), _page(["e"], None)])
    got = h.collect("iter_orders", open=True, mode="paper", limit=2)
    assert [o.id for o in got] == ["a", "b", "c", "d", "e"]
    assert all(type(o) is models.Order for o in got)
    base = {"open": "true", "mode": "paper", "limit": "2"}
    assert [c.query for c in h.calls] == [base, {**base, "cursor": "c1"}, {**base, "cursor": "c2"}]


def test_max_items_stops_early_and_iter_activity_pages_the_same_way(mock: Any) -> None:
    h = mock([_page(["a", "b"], "c1"), _page(["c", "d"], "c2"), _page(["e"], None)])
    assert [o.id for o in h.collect("iter_orders", max_items=3)] == ["a", "b", "c"]
    assert len(h.calls) == 2  # the third page was never asked for
    a = mock([_page(["x"], "n"), _page(["y"], None)])
    assert [i.id for i in a.collect("iter_activity", limit=1)] == ["x", "y"]
    assert [c.raw_path for c in a.calls] == [f"{P}/activity", f"{P}/activity"]
    none = mock([_page([], None)])
    assert none.collect("iter_orders", max_items=0) == []
    assert none.calls == []
    for bad in (-1, 1.5, True):
        with pytest.raises(ConfigurationError):
            none.collect("iter_orders", max_items=bad)


def test_a_server_that_returns_the_cursor_it_was_given_is_an_error_not_an_endless_loop(mock: Any) -> None:
    h = mock([_page(["a"], "same"), _page(["b"], "same")])
    with pytest.raises(ServerError):
        h.collect("iter_orders")
    assert len(h.calls) == 2


def test_other_write_arguments_are_validated_locally_with_the_contract(mock: Any) -> None:
    h = mock([ok()])
    for name, args, kw in (
        ("engage_kill_switch", ("x" * 201,), {}), ("compare_markets", (), {"notional": 0.5}), ("list_private_markets", (), {"size": 1.5}), ("get_private_market", ("",), {}),
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
    return ok({"order": {**ORDER_ROW, "id": "o1", "status": status, "engineStatus": None, "final": status in sp_wallet.TERMINAL_ORDER_STATES if final is None else final}, "fills": []})


def test_wait_for_order_polls_until_final_and_unknown_is_not_final(mock: Any) -> None:
    h = mock([_order("SUBMITTED"), _order("UNKNOWN"), _order("PARTIALLY_FILLED"), _order("FILLED")])
    r = h.call("wait_for_order", "o1", poll_interval=0.01)
    assert r.order.status == "FILLED"
    assert len(h.calls) == 4
    assert h.sleeps == [0.01, 0.01, 0.01]
    for s in ("FILLED", "CANCELLED", "REJECTED", "FAILED"):
        assert mock([_order(s)]).call("wait_for_order", "o1").order.status == s


def test_wait_for_order_the_closed_enum_decides_and_a_timeout_is_not_a_failure(mock: Any) -> None:
    # exactly four of the twelve states are final, whatever the `final` flag of the answer says
    assert [s for s in sp_wallet.ORDER_STATES if sp_wallet.is_terminal_order({"status": s})] == ["FILLED", "CANCELLED", "REJECTED", "FAILED"]
    assert len(sp_wallet.ORDER_STATES) == 12
    for s in ("UNKNOWN", "SUBMITTED", "AWAITING_APPROVAL"):
        assert isinstance(mock([_order(s, True)]).error("wait_for_order", "o1", timeout=0), WaitTimeout), s
    e = mock([_order("SUBMITTED")]).error("wait_for_order", "o1", timeout=0)
    assert isinstance(e, WaitTimeout)
    assert "not failed" in str(e)
    assert e.last.order.status == "SUBMITTED"
    custom = mock([_order("AWAITING_APPROVAL")]).call("wait_for_order", "o1", until=lambda o: o.status == "AWAITING_APPROVAL")
    assert custom.order.status == "AWAITING_APPROVAL"
    # a word that is not one of the twelve never reaches the caller as an order: the answer does not match the contract
    assert isinstance(mock([_order("expired", True)]).error("wait_for_order", "o1"), ServerError)

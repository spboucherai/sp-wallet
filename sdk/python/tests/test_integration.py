"""INTEGRATION: both clients against the REAL API and the REAL signer — no mocked transport.

The stack is the one of the TypeScript SDK's integration test (packages/trading-sdk/scripts/test-stack.mts): the bundles
of scripts/build.mjs, an own per-run PostgreSQL database, the owner set up with a software passkey, API keys created
through the owner routes (prepare → passkey assertion → create), one of them revoked.

SKIPPED — reported as skipped, not as passed — when PostgreSQL is not reachable, when the repository's node_modules are
not installed, or with SPW_SDK_INTEGRATION=off. Market data comes from the venues' public endpoints: a test whose venue
cannot be reached (503) is skipped with that reason.
SPW_SDK_TRANSCRIPT=1 (with `pytest -s`) prints one line per call: the transcript pasted in docs/v11/work/sdks.md.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import jsonschema
import pytest

import sp_wallet
from conftest import OPENAPI, ROOT
from sp_wallet import (
    OPERATIONS,
    AmbiguousSymbol,
    AsyncSPWallet,
    AuthenticationError,
    ExecutionNotWired,
    MandateRequired,
    NotFound,
    RateLimited,
    ScopeDenied,
    ServiceUnavailable,
    SPWallet,
    ValidationError,
    construct_webhook_event,
    verify_webhook,
)

pytestmark = pytest.mark.integration
UUID = "00000000-0000-4000-8000-000000000000"
DEC = re.compile(r"^\d+(\.\d+)?$")
REQ = re.compile(r"^[0-9a-f-]{36}$")
ORDER: dict[str, Any] = {"instrument": "hyperliquid:BTC", "side": "buy", "order_type": "market", "size": "0.01"}
WRITES: dict[str, tuple[str, tuple[Any, ...], dict[str, Any]]] = {
    "previewOrder": ("preview_order", (), ORDER),
    "placeOrder": ("create_order", (), {**ORDER, "order_type": "limit", "price": "50000", "tif": "gtc", "client_order_id": "sdk-it-0001"}),
    "cancelOrder": ("cancel_order", (f"deriv:{UUID}:sdk-it-0001",), {}),
    "closePosition": ("close_position", ("pos-1",), {"slippage_bps": 50}),
    "reducePosition": ("reduce_position", ("pos-1",), {"fraction": Decimal("0.5")}),
    "createStrategy": ("create_strategy", (), {"kind": "perp", "path": "momentum/v1"}),
    "backtestStrategy": ("backtest_strategy", (UUID,), {"symbols": ["BTC"], "interval": "1h"}),
    "startStrategy": ("start_strategy", (UUID,), {"mode": "paper"}),
    "stopStrategy": ("stop_strategy", (UUID,), {"reason": "sdk test"}),
    "createAgent": ("create_agent", (), {"kind": "perp", "name": "sdk agent", "universe": ["BTC", "ETH"], "interval": "1h", "mode": "paper"}),
    "startAgent": ("start_agent", (UUID,), {"mode": "paper"}),
    "stopAgent": ("stop_agent", (UUID,), {}),
}


def say(line: str) -> None:
    if os.environ.get("SPW_SDK_TRANSCRIPT"):
        print(f"[sdk-py] {line}")


def meta(r: Any) -> str:
    m = r.meta
    return f"HTTP {m.status} request={(m.request_id or '')[:8]}… ratelimit={m.rate_limit.remaining}/{m.rate_limit.limit} reset={m.rate_limit.reset_seconds:g}s"


@pytest.fixture(scope="session")
def stack() -> Iterator[dict[str, Any]]:
    if os.environ.get("SPW_SDK_INTEGRATION") == "off":
        pytest.skip("SPW_SDK_INTEGRATION=off")
    tsx = ROOT / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        pytest.skip("the repository's node_modules are not installed (pnpm install): the real API cannot be started")
    proc = subprocess.Popen([str(tsx), str(ROOT / "packages/trading-sdk/scripts/test-stack.mts"), "py"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: lines.put(proc.stdout.readline() if proc.stdout else ""), daemon=True).start()
    try:
        first = lines.get(timeout=120)
    except queue.Empty:
        proc.kill()
        pytest.fail("the SDK test stack did not start within 120 s")
    try:
        msg = json.loads(first) if first.strip() else {"ok": False, "skip": False, "reason": f"the stack exited with code {proc.poll()} before it was ready"}
        if not msg["ok"]:
            if msg.get("skip"):
                pytest.skip(msg["reason"])
            pytest.fail(f"the SDK test stack failed: {msg['reason']}")
        yield msg
    finally:
        if proc.stdin:
            proc.stdin.close()  # the stack stops, drops its database and removes its directory
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


class Runner:
    """The same test body against SPWallet or AsyncSPWallet."""

    def __init__(self, kind: str, stack: dict[str, Any]) -> None:
        self.kind, self.stack = kind, stack
        # one event loop for the whole test: an AsyncSPWallet keeps its connections on the loop that opened them
        self.loop = asyncio.new_event_loop() if kind == "async" else None
        self.clients: list[Any] = []

    def close(self) -> None:
        for c in self.clients:
            if self.loop:
                self.loop.run_until_complete(c.aclose())
            else:
                c.close()
        if self.loop:
            self.loop.close()

    def client(self, key: str, **opts: Any) -> Any:
        cls = SPWallet if self.kind == "sync" else AsyncSPWallet
        c = cls(self.stack["keys"][key]["secret"], base_url=self.stack["baseUrl"], **{"max_retries": 0, **opts})
        self.clients.append(c)
        return c

    def call(self, client: Any, name: str, /, *args: Any, **kwargs: Any) -> Any:
        out = getattr(client, name)(*args, **kwargs)
        return out if self.loop is None else self.loop.run_until_complete(out)

    def error(self, client: Any, name: str, /, *args: Any, **kwargs: Any) -> Any:
        try:
            self.call(client, name, *args, **kwargs)
        except Exception as e:
            return e
        raise AssertionError(f"{name} did not raise")

    def venue(self, client: Any, name: str, /, *args: Any, **kwargs: Any) -> Any:
        """A read that depends on a venue's public endpoint: unreachable venue = skipped test."""
        try:
            return self.call(client, name, *args, **kwargs)
        except ServiceUnavailable as e:
            say(f"venue unreachable ({e.code}): test skipped")
            pytest.skip(f"venue unreachable: {e.code}")


@pytest.fixture(params=["sync", "async"])
def run(request: pytest.FixtureRequest, stack: dict[str, Any]) -> Iterator[Runner]:
    r = Runner(str(request.param), stack)
    yield r
    r.close()


#: answers of the real server that the OpenAPI document does not describe (reported in docs/v11/work/sdks.md)
CONTRACT_GAPS: set[str] = set()


def conforms(op_id: str, result: Any) -> None:
    """The REAL answer, as received, against the response schema of the document. A missing required member or a wrong type
    fails the test; a member the document does not declare in a closed object is recorded as a contract gap."""
    method, path = OPERATIONS[op_id][0], OPERATIONS[op_id][1]
    schema = OPENAPI["paths"][path][method.lower()]["responses"]["200"]["content"]["application/json"]["schema"]
    raw = json.loads(json.dumps(result.to_dict(), default=float))  # Decimal → JSON number, tuples → arrays
    hard = []
    for err in jsonschema.Draft202012Validator(schema).iter_errors(raw):
        where = ".".join(re.sub(r"^\d+$", "[]", str(p)) for p in err.absolute_path)
        if err.validator == "additionalProperties":
            for name in re.findall(r"'([^']+)'", err.message.split(" were unexpected")[0].split(" was unexpected")[0]):
                CONTRACT_GAPS.add(f"{op_id}: `{where + '.' if where else ''}{name}` is sent but the document declares a closed object without it")
        else:
            hard.append(f"{where}: {err.message[:200]}")
    assert not hard, f"{op_id}: the real answer violates the document: {hard}"


# ================================================================================================================ reads
def test_openapi_served_is_the_committed_contract(run: Runner) -> None:
    d = run.call(run.client("reader"), "openapi")
    assert d.to_dict() == OPENAPI
    say(f"[{run.kind}] openapi() → {meta(d)} openapi={d.openapi} paths={len(d.to_dict()['paths'])}")


def test_markets_orderbook_candles(run: Runner) -> None:
    c = run.client("reader")
    r = run.venue(c, "list_markets", venue="hyperliquid", q="BTC", limit=3)
    conforms("listMarkets", r)
    assert 0 < len(r.markets) <= 3
    btc = next(m for m in r.markets if m.id == "hyperliquid:BTC")
    assert (btc.venue, btc.kind, btc.symbol) == ("hyperliquid", "perpetual", "BTC")
    assert isinstance(btc.mark, str)
    assert DEC.match(btc.mark)  # a decimal STRING
    assert btc.mark == str(sp_wallet.to_decimal(btc.mark))
    say(f"[{run.kind}] list_markets(venue='hyperliquid', q='BTC', limit=3) → {meta(r)} total={r.total} truncated={r.truncated} first={btc.id} mark={btc.mark!r} stale={btc.stale}")
    every = run.venue(c, "list_markets", limit=2)
    assert every.truncated is True
    assert every.total > 2
    say(f"[{run.kind}] list_markets(limit=2) → total={every.total} truncated={every.truncated} errors={[e.source for e in every.errors]}")

    m = run.venue(c, "get_market", "hyperliquid:BTC")
    conforms("getMarket", m)
    assert (m.market.id, m.source) == ("hyperliquid:BTC", "venue")
    say(f"[{run.kind}] get_market('hyperliquid:BTC') → {meta(m)} mark={m.market.mark!r} lotSize={(m.instrument or {}).get('lotSize')!r}")
    b = run.venue(c, "get_orderbook", "hyperliquid:BTC", depth=2)
    conforms("getOrderbook", b)
    assert len(b.bids) <= 2
    for price, size in [*b.bids, *b.asks]:
        assert DEC.match(price)
        assert DEC.match(size)
    say(f"[{run.kind}] get_orderbook('hyperliquid:BTC', depth=2) → {meta(b)} bids={b.bids} asks={b.asks}")
    k = run.venue(c, "get_candles", "hyperliquid:BTC", interval="1h", limit=2)
    conforms("getCandles", k)
    assert k.interval == "1h"
    assert len(k.candles) <= 2
    for x in k.candles:
        assert all(DEC.match(v) for v in (x.open, x.high, x.low, x.close, x.volume))
    say(f"[{run.kind}] get_candles('hyperliquid:BTC', interval='1h', limit=2) → {meta(k)} last={k.candles[-1].to_dict() if k.candles else None}")


def test_ambiguous_symbol_not_found_and_validation(run: Runner) -> None:
    c = run.client("reader")
    try:
        e = run.error(c, "get_market", "BTC")
    except AssertionError:
        pytest.fail("get_market('BTC') should be ambiguous")
    if isinstance(e, ServiceUnavailable):
        pytest.skip(f"venue unreachable: {e.code}")
    assert type(e) is AmbiguousSymbol
    assert "hyperliquid:BTC" in e.candidates
    assert (e.status, e.code) == (409, "ambiguous_symbol")
    assert REQ.match(e.request_id)
    say(f"[{run.kind}] get_market('BTC') → AmbiguousSymbol HTTP 409 candidates={e.candidates[:4]}…")
    # an id with ':' '/' ' ' '[' ']' goes through the real router as ONE path segment, and a venue without a book answers 422
    gmx = next((x for x in e.candidates if x.startswith("gmx:")), None)
    if gmx:
        g = run.call(c, "get_market", gmx)
        assert g.market.id == gmx
        nb = run.error(c, "get_orderbook", gmx)
        assert type(nb) is ValidationError
        assert (nb.status, nb.code) == (422, "no_orderbook")
        say(f"[{run.kind}] get_market({gmx!r}) → {meta(g)} id={g.market.id}; get_orderbook({gmx!r}) → {type(nb).__name__} HTTP {nb.status} {nb.code}")
    spot = run.error(c, "get_orderbook", "spot:BTC")
    assert type(spot) is ValidationError
    assert (spot.status, spot.code) == (422, "no_orderbook")
    nf = run.error(c, "get_market", "nowhere:XYZ")
    assert type(nf) is NotFound
    say(f"[{run.kind}] get_market('nowhere:XYZ') → {type(nf).__name__} {nf.status} {nf.code}")
    nv = run.error(c, "list_markets", venue="nowhere")
    assert type(nv) is NotFound
    assert nv.code == "unknown_venue"
    say(f"[{run.kind}] list_markets(venue='nowhere') → {type(nv).__name__} {nv.status} {nv.code}")
    no = run.error(c, "get_order", f"deriv:{UUID}:nope")
    assert type(no) is NotFound
    assert no.code == "unknown_order"
    say(f"[{run.kind}] get_order('deriv:…:nope') → {type(no).__name__} {no.status} {no.code}")
    assert type(run.error(c, "wait_for_order", "not-an-order-id", timeout=0.01)) is NotFound
    bad = run.error(c, "list_markets", limit=0)
    assert type(bad) is ValidationError
    assert bad.code == "bad_request"
    say(f"[{run.kind}] list_markets(limit=0) → {type(bad).__name__} {bad.status} {bad.code}")


def test_portfolio_balances_positions_orders_activity_risk_strategies_agents(run: Runner) -> None:
    c = run.client("reader", timeout=60)
    p = run.call(c, "get_portfolio")
    conforms("getPortfolio", p)
    assert p.halted is False
    assert isinstance(p.wallet.balances, list)
    for v in (p.wallet.value_usd, p.totals.wallet_usd):
        assert v is None or isinstance(v, Decimal)  # JSON numbers are Decimal, never float
    say(f"[{run.kind}] get_portfolio() → {meta(p)} wallet_usd={p.totals.wallet_usd} live_venue_equity={p.totals.live_venue_equity} paper_equity={p.totals.paper_equity} "
        f"balances={len(p.wallet.balances)} accounts={len(p.accounts)} halted={p.halted}")  # fmt: skip
    b = run.call(c, "get_balances", network="ethereum")
    conforms("getBalances", b)
    assert b.balances
    for x in b.balances:
        assert x.network == "ethereum"
        assert x.amount is None or x.amount.isdigit()
    say(f"[{run.kind}] get_balances(network='ethereum') → {meta(b)} {len(b.balances)} assets, first: symbol={b.balances[0].symbol} amount={b.balances[0].amount!r} display={b.balances[0].display!r}")
    pos = run.call(c, "get_positions", mode="paper")
    conforms("listPositions", pos)
    assert pos.positions == []
    say(f"[{run.kind}] get_positions(mode='paper') → {meta(pos)} positions={len(pos.positions)} errors={len(pos.errors)}")
    o = run.call(c, "list_orders", open=True, limit=5)
    conforms("listOrders", o)
    assert o.orders == []
    say(f"[{run.kind}] list_orders(open=True, limit=5) → {meta(o)} orders={len(o.orders)}")
    a = run.call(c, "get_activity", limit=5)
    conforms("getActivity", a)
    assert a.items == []
    say(f"[{run.kind}] get_activity(limit=5) → {meta(a)} items={len(a.items)}")
    r = run.call(c, "get_risk")
    conforms("getRisk", r)
    assert (r.kill_switch.signer_reachable, r.kill_switch.signer_halted) == (True, False)
    assert r.capability_locks
    say(f"[{run.kind}] get_risk() → {meta(r)} signer_reachable={r.kill_switch.signer_reachable} signer_halted={r.kill_switch.signer_halted} capability_locks={len(r.capability_locks)}")
    s = run.call(c, "list_strategies", kind="perp")
    conforms("listStrategies", s)
    assert s.versions == []
    say(f"[{run.kind}] list_strategies(kind='perp') → {meta(s)} library={len(s.library)} versions={len(s.versions)}")
    g = run.call(c, "list_agents")
    conforms("listAgents", g)
    assert g.agents == []
    say(f"[{run.kind}] list_agents() → {meta(g)} agents={len(g.agents)}")


def test_every_read_operation_of_the_document_is_exercised_above() -> None:
    reads = sorted(k for k, v in OPERATIONS.items() if v[0] == "GET")
    assert reads == ["getActivity", "getBalances", "getCandles", "getMarket", "getOpenApi", "getOrder", "getOrderbook", "getPortfolio", "getRisk",
                     "listAgents", "listMarkets", "listOrders", "listPositions", "listStrategies"]  # fmt: skip


def test_rate_limit_headers_and_request_ids(run: Runner) -> None:
    c = run.client("reader")
    a, b = run.call(c, "list_agents").meta, run.call(c, "list_agents").meta
    assert a.rate_limit.limit == 600
    assert b.rate_limit.remaining == a.rate_limit.remaining - 1
    assert 0 < a.rate_limit.reset_seconds <= 60
    assert REQ.match(a.request_id)
    assert a.request_id != b.request_id


# ================================================================================================================ writes and refusals
def test_the_write_cases_cover_the_twelve_write_operations() -> None:
    assert sorted(WRITES) == sorted(k for k, v in OPERATIONS.items() if v[4])
    assert len(WRITES) == 12


def test_key_bound_to_a_mandate_every_write_is_501_never_a_success(run: Runner) -> None:
    c = run.client("trader", send_timestamp=True)
    for op_id, (name, args, kwargs) in WRITES.items():
        e = run.error(c, name, *args, **kwargs)
        assert type(e) is ExecutionNotWired, op_id
        assert isinstance(e, sp_wallet.NotImplementedError)
        assert (e.status, e.code) == (501, "execution_not_wired")
        assert REQ.match(e.idempotency_key)
        assert REQ.match(e.request_id)
        say(f"[{run.kind}] {name} (key bound to a mandate) → {type(e).__name__} HTTP {e.status} {e.code} idempotency_key={e.idempotency_key[:8]}…")


def test_a_501_is_not_stored_the_same_key_can_be_sent_again(run: Runner) -> None:
    c = run.client("trader")
    key = f"sdk-it-resume-{run.kind}-0001"
    for _ in range(2):
        e = run.error(c, "preview_order", **ORDER, idempotency_key=key)
        assert (e.status, e.idempotency_key) == (501, key)


def test_key_without_a_mandate_execution_is_refused(run: Runner) -> None:
    c = run.client("unbound")
    for op_id, (name, args, kwargs) in WRITES.items():
        e = run.error(c, name, *args, **kwargs)
        if OPERATIONS[op_id][5]:
            assert type(e) is MandateRequired, op_id
            assert (e.status, e.code) == (403, "mandate_required")
        else:
            assert op_id == "previewOrder"
            assert type(e) is ExecutionNotWired
        say(f"[{run.kind}] {name} (key without a mandate) → {type(e).__name__} HTTP {e.status} {e.code}")


def test_scope_refusal(run: Runner) -> None:
    c = run.client("narrow")
    for name, kw in (("get_portfolio", {}), ("get_balances", {}), ("get_positions", {}), ("list_orders", {}), ("list_agents", {}), ("get_risk", {}), ("preview_order", ORDER)):
        e = run.error(c, name, **kw)
        assert type(e) is ScopeDenied, name
        assert (e.status, e.code) == (403, "insufficient_scope")
    say(f"[{run.kind}] get_portfolio() with a markets:read key → ScopeDenied HTTP 403 insufficient_scope: {run.error(c, 'get_portfolio')}")
    assert run.call(c, "openapi").openapi == "3.1.0"  # any valid key


def test_revoked_and_unknown_keys(run: Runner, stack: dict[str, Any]) -> None:
    r = run.error(run.client("revoked"), "list_agents")
    assert type(r) is AuthenticationError
    assert (r.status, r.code) == (401, "unauthenticated")
    say(f"[{run.kind}] list_agents() with a REVOKED key → {type(r).__name__} HTTP {r.status} {r.code}")
    stack["keys"]["unknown"] = {"id": "spk_000000000000", "secret": "spw_live_spk_000000000000_" + "A" * 43}
    u = run.error(run.client("unknown"), "list_agents")
    assert type(u) is AuthenticationError
    assert str(u).replace(u.request_id, "") == str(r).replace(r.request_id, "")  # one answer for both
    for e in (r, u):
        assert "spw_live_" not in f"{e} {e!r} {e.body!r}"


def test_rate_limit(run: Runner, stack: dict[str, Any]) -> None:
    c = run.client("limited")
    seen: list[Any] = []
    e: Any = None
    for _ in range(8):  # 3 calls a minute; the other client kind may already have used the window
        try:
            m = run.call(c, "list_agents").meta
            assert m.rate_limit.limit == 3
            seen.append(m.rate_limit.remaining)
        except RateLimited as x:
            e = x
            break
    assert e is not None, "the 3/min key was never limited"
    assert seen == [2, 1, 0][3 - len(seen) :]
    assert (e.status, e.code) == (429, "rate_limited")
    assert 0 < e.retry_after <= 60
    say(f"[{run.kind}] list_agents() with a 3/min key → remaining {seen} then {type(e).__name__} HTTP {e.status} {e.code} retry_after={e.retry_after:g}")
    # with retries on, the SDK waits exactly what the server asks before trying again (the sleep is recorded, not slept)
    sleeps: list[float] = []

    async def a_sleep(s: float) -> None:
        sleeps.append(s)

    again = run.error(run.client("limited", max_retries=1, max_retry_delay=120, _sleep=sleeps.append if run.kind == "sync" else a_sleep), "list_agents")
    assert type(again) is RateLimited
    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= 60


# ================================================================================================================ webhook, logs, examples
def test_a_signature_produced_by_the_server_code_verifies(stack: dict[str, Any]) -> None:
    w = stack["webhook"]
    args = {"secret": w["secret"], "timestamp": str(w["timestamp"]), "signature": w["signature"]}
    now = w["timestamp"] + 1
    assert verify_webhook(**args, body=w["body"], now=now)
    assert verify_webhook(**args, body=w["body"].encode(), now=now)
    assert not verify_webhook(**args, body=w["body"].replace("key.revoked", "key.created"), now=now)
    assert not verify_webhook(**args, body=w["body"], now=now + 301)
    assert construct_webhook_event(**args, body=w["body"], now=now)["event"] == "key.revoked"
    say(f"verify_webhook(server signature {w['signature'][:14]}…) → True; tampered body → False; 301 s late → False")


def test_no_key_in_the_logs_of_real_calls_at_debug(run: Runner, stack: dict[str, Any], caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)  # httpx and httpcore log every request at this level
    c = run.client("reader")
    run.call(c, "list_agents")
    run.error(c, "get_order", "nope")
    run.error(run.client("trader"), "cancel_order", "o1")
    assert any(r.name.startswith(("httpx", "httpcore")) for r in caplog.records), "the transport logged nothing: the test would prove nothing"
    secrets = [k["secret"] for k in stack["keys"].values()]
    for record in caplog.records:
        text = f"{record.getMessage()} {record.args!r}"
        assert "spw_live_" not in text, text
        assert not any(s in text or s[-20:] in text for s in secrets), text


def _example(name: str, stack: dict[str, Any]) -> str:
    env = {"PATH": os.environ.get("PATH", ""), "SP_WALLET_API_KEY": stack["keys"]["reader"]["secret"], "SP_WALLET_BASE_URL": stack["baseUrl"]}
    out = subprocess.run([sys.executable, str(ROOT / "sdk/python/examples" / name)], env=env, capture_output=True, text=True, timeout=120, check=False)
    assert out.returncode == 0, out.stderr
    if os.environ.get("SPW_SDK_TRANSCRIPT"):
        print("\n".join(f"[example {name}] {line}" for line in out.stdout.splitlines() if line))
    assert "spw_live_" not in out.stdout + out.stderr
    return out.stdout


def test_example_read_only_runs_against_the_real_api(stack: dict[str, Any]) -> None:
    out = _example("read_only.py", stack)
    assert "api_key=<redacted>" in out
    assert "portfolio: wallet" in out
    assert "risk: signer reachable=True, halted=False" in out
    assert out.rstrip().endswith("done")
    if "markets: ServiceUnavailable" in out:
        pytest.skip("venue unreachable")
    assert re.search(r"orderbook: best bid \d", out)


def test_example_async_read_runs_against_the_real_api(stack: dict[str, Any]) -> None:
    out = _example("async_read.py", stack)
    assert "agents: 0; orders: 0; signer halted: False" in out


def test_example_preview_order_is_refused_with_501_and_says_so(stack: dict[str, Any]) -> None:
    out = _example("preview_order.py", stack)
    if "does not execute this operation yet (501 execution_not_wired)" not in out:
        pytest.skip("venue unreachable: the market could not be read to size the order")
    assert "preview:" not in out  # nothing is faked


def test_contract_gaps_are_reported(stack: dict[str, Any]) -> None:
    """Not a failure of the SDK: members the real server sends in an object the document declares closed. Listed for the API owner."""
    for gap in sorted(CONTRACT_GAPS):
        say(f"CONTRACT GAP {gap}")

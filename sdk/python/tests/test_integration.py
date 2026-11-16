"""INTEGRATION: both clients against the REAL API and the REAL signer — no mocked transport.

The stack is the one of the TypeScript SDK's integration test (packages/trading-sdk/scripts/test-stack.mts): the bundles
of scripts/build.mjs, an own per-run PostgreSQL database, the owner set up with a software passkey, API keys created
through the owner routes (prepare → passkey assertion → create), one of them revoked; a paper account, and paper trading
mandates approved and bound to the two trader keys (the synchronous run uses `trader`, the asynchronous one `trader2`).
Paper orders are filled by the wallet's paper engine against the venue's real public book: nothing is signed or sent.

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
import urllib.error
import urllib.request
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import jsonschema
import pytest

import sp_wallet
from conftest import OPENAPI, ROOT
from sp_wallet import (
    OPERATION_ERRORS,
    OPERATIONS,
    ORDER_STATES,
    TERMINAL_ORDER_STATES,
    AmbiguousCommand,
    AmbiguousSymbol,
    AsyncSPWallet,
    AuthenticationError,
    ConfigurationError,
    Conflict,
    ExecutionDisabled,
    IdempotencyConflict,
    MandateDenied,
    MandateRequired,
    NotFound,
    RateLimited,
    RiskDenied,
    ScopeDenied,
    ServiceUnavailable,
    SPWallet,
    ValidationError,
    WaitTimeout,
    construct_webhook_event,
    error_from_response,
    models,
    new_idempotency_key,
    verify_webhook,
)

pytestmark = pytest.mark.integration
UUID = "00000000-0000-4000-8000-000000000000"
DEC = re.compile(r"^\d+(\.\d+)?$")
REQ = re.compile(r"^[0-9a-f-]{36}$")
ORDER: dict[str, Any] = {"instrument": "hyperliquid:BTC", "side": "buy", "order_type": "market", "size": "0.001"}
def declared(op_id: str, e: Any) -> Any:
    """Every error this file receives from the server is one the document declares for the operation (`x-spw-errors`)."""
    assert (e.status, e.code) in OPERATION_ERRORS[op_id], f"{op_id} answered {e.status} {e.code}: not in x-spw-errors ({e})"
    return e


def owner_action(stack: dict[str, Any], method: str, path: str, body: Any = None) -> None:
    """An owner action through the stack's control endpoint (a key can never do these)."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(stack["control"] + path, data=data, method=method, headers={"content-type": "application/json"})  # noqa: S310 — http://127.0.0.1 of this test
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310
        assert r.status == 200


def short(order_id: str) -> str:
    return f"{order_id[:12]}…"


def line(o: Any) -> str:
    return f"status={o.status} final={o.final} engine_status={o.engine_status} size={o.size} filled={o.filled} avg={o.avg_fill_price}"


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

    def collect(self, client: Any, name: str, /, **kwargs: Any) -> list[Any]:
        """Every item of a paginating iterator, for either client."""
        it = getattr(client, name)(**kwargs)
        if self.loop is None:
            return list(it)

        async def drain() -> list[Any]:
            return [x async for x in it]

        return self.loop.run_until_complete(drain())

    @property
    def trader(self) -> str:
        """The key of this run: the two runs do not share an idempotency namespace, nor each other's orders."""
        return "trader" if self.kind == "sync" else "trader2"

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


def conforms(op_id: str, result: Any) -> None:
    """The REAL answer, as received (only the members the server sent), against the response schema of the document —
    components included. A missing required member, a wrong type, a value outside an enum, or a member the document
    does not declare in a closed object fails the test: the document describes what the server really does."""
    method, path = OPERATIONS[op_id][0], OPERATIONS[op_id][1]
    schema = OPENAPI["paths"][path][method.lower()]["responses"]["200"]["content"]["application/json"]["schema"]
    # a JSON number the SDK holds as Decimal goes back to a JSON number; tuples → arrays
    raw = json.loads(json.dumps(result.model_dump(by_alias=True, exclude_unset=True), default=float))
    # `$ref: #/components/schemas/…` resolves against the root of the schema resource: the components travel with it
    problems = [
        f"{'.'.join(str(p) for p in err.absolute_path)}: {err.message[:200]}"
        for err in jsonschema.Draft202012Validator({"allOf": [schema], "components": OPENAPI["components"]}).iter_errors(raw)
    ]
    assert not problems, f"{op_id}: the real answer is not what the document says: {problems}"


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
    i = m.instrument
    assert all(DEC.match(v) for v in (i.lot_size, i.tick_size, i.max_leverage))
    say(f"[{run.kind}] get_market('hyperliquid:BTC') → {meta(m)} mark={m.market.mark!r} lot_size={i.lot_size!r} tick_size={i.tick_size!r} min_notional={i.min_notional!r} max_leverage={i.max_leverage!r}")
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
    for op_id, e2 in (("getOrderbook", spot), ("getMarket", nf), ("listMarkets", nv), ("getOrder", no)):
        declared(op_id, e2)
    # a path that is not an operation: the API's own error model, with a stable code (the SDK has no method for it: raw request)
    for method, path in (("GET", "/nope"), ("PUT", "/orders"), ("POST", "/markets/x/y/z")):
        req = urllib.request.Request(f"{run.stack['baseUrl']}/api/v1/trading{path}", method=method, headers={"authorization": f"Bearer {run.stack['keys']['reader']['secret']}"})  # noqa: S310
        with pytest.raises(urllib.error.HTTPError) as http:
            urllib.request.urlopen(req, timeout=30)  # noqa: S310
        body = json.loads(http.value.read())
        assert (http.value.code, body["error"], isinstance(body["message"], str)) == (404, "not_found", True)
        assert type(error_from_response(http.value.code, body)) is NotFound
    say(f"[{run.kind}] GET /api/v1/trading/nope (not an operation) → HTTP 404 not_found")
    bad = run.error(c, "list_markets", limit=0)
    assert type(bad) is ValidationError
    assert bad.code == "bad_request"
    say(f"[{run.kind}] list_markets(limit=0) → {type(bad).__name__} {bad.status} {bad.code}")


def test_portfolio_balances_positions_orders_activity_risk_strategies_agents(run: Runner) -> None:
    c = run.client("reader", timeout=60)
    p = run.call(c, "get_portfolio")
    conforms("getPortfolio", p)
    assert p.halted is False
    assert isinstance(p.totals.note, str)
    # money is a decimal STRING (or None when the price feed gives nothing): never a JSON number
    for v in (p.wallet.value_usd, p.totals.wallet_usd, p.totals.live_venue_equity, p.totals.paper_equity, *(b.value_usd for b in p.wallet.balances)):
        assert v is None or (isinstance(v, str) and DEC.match(v)), v
    assert DEC.match(p.totals.paper_equity)
    assert any(a.mode == "paper" and a.account_id == run.stack["paper"]["accountId"] for a in p.accounts)
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
    assert o.next_cursor is None
    say(f"[{run.kind}] list_orders(open=True, limit=5) → {meta(o)} orders={len(o.orders)} next_cursor={o.next_cursor}")
    a = run.call(c, "get_activity", limit=5)
    conforms("getActivity", a)
    assert a.items == []
    assert a.next_cursor is None
    say(f"[{run.kind}] get_activity(limit=5) → {meta(a)} items={len(a.items)} next_cursor={a.next_cursor}")
    r = run.call(c, "get_risk")
    conforms("getRisk", r)
    assert (r.kill_switch.signer_reachable, r.kill_switch.signer_halted) == (True, False)
    assert r.capability_locks
    assert (r.engine.kill_switch.on, r.engine.read_only.on) == (False, False)
    say(f"[{run.kind}] get_risk() → {meta(r)} signer_reachable={r.kill_switch.signer_reachable} signer_halted={r.kill_switch.signer_halted} capability_locks={len(r.capability_locks)}")
    s = run.call(c, "list_strategies", kind="perp")
    conforms("listStrategies", s)
    assert s.versions == []
    say(f"[{run.kind}] list_strategies(kind='perp') → {meta(s)} library={len(s.library)} versions={len(s.versions)}")
    g = run.call(c, "list_agents")
    conforms("listAgents", g)
    assert g.agents == []
    say(f"[{run.kind}] list_agents() → {meta(g)} agents={len(g.agents)}")


def test_compare_markets_and_private_markets(run: Runner) -> None:
    c = run.client("reader", timeout=60)
    cmp = run.venue(c, "compare_markets", underlying="BTC", side="long", notional="1000")
    conforms("compareMarkets", cmp)
    assert cmp.underlying == "BTC"
    assert any(r.venue == "hyperliquid" for r in cmp.rows)
    say(f"[{run.kind}] compare_markets(underlying='BTC', side='long', notional='1000') → {meta(cmp)} rows={[r.venue + ('' if r.tradable else '(not tradable)') for r in cmp.rows]} discrepancies={len(cmp.discrepancies)}")
    declared("compareMarkets", run.error(c, "compare_markets", underlying="ZZZZZ", side="long", notional="1000"))
    pm = run.venue(c, "list_private_markets")
    conforms("listPrivateMarkets", pm)
    assert pm.notice.tradable is False
    assert all(x.tradable is False for x in pm.markets)
    say(f"[{run.kind}] list_private_markets() → {meta(pm)} markets={len(pm.markets)} companies={len(pm.companies)} venues={[v.venue + ':' + v.status for v in pm.venues]} notice={pm.notice.code}")
    first = next((x for x in pm.markets if x.error is None), None)
    if first is not None:
        one = run.venue(c, "get_private_market", first.id, interval="1d", limit=5)
        conforms("getPrivateMarket", one)
        assert (one.market.id, one.market.tradable) == (first.id, False)
        say(f"[{run.kind}] get_private_market({first.id!r}) → {meta(one)} status={one.market.status} review={one.market.review.state} price={one.market.market.price.value!r}")
    if pm.companies:
        co = run.venue(c, "get_private_market_company", pm.companies[0].slug)
        conforms("getPrivateMarketCompany", co)
        assert co.company.slug == pm.companies[0].slug
        assert co.merged is None
        say(f"[{run.kind}] get_private_market_company({pm.companies[0].slug!r}) → {meta(co)} contracts={len(co.contracts)} merged={co.merged}")
    unknown = declared("getPrivateMarketCompany", run.error(c, "get_private_market_company", "no-such-company"))
    assert (type(unknown), unknown.code) == (NotFound, "unknown_company")


def test_every_read_operation_of_the_document_is_exercised_in_this_file() -> None:
    reads = sorted(k for k, v in OPERATIONS.items() if v[0] == "GET")
    assert reads == ["compareMarkets", "getActivity", "getAgent", "getAgentPerformance", "getBalances", "getCandles", "getJob", "getMarket", "getOpenApi", "getOrder", "getOrderbook",
                     "getPortfolio", "getPrivateMarket", "getPrivateMarketCompany", "getRisk", "listAgentJournal", "listAgentOrders", "listAgentSignals", "listAgentTemplates", "listAgents",
                     "listMarkets", "listOrders", "listPositions", "listPrivateMarkets", "listStrategies"]  # fmt: skip


def test_rate_limit_headers_and_request_ids(run: Runner) -> None:
    c = run.client("reader")
    a, b = run.call(c, "list_agents").meta, run.call(c, "list_agents").meta
    assert a.rate_limit.limit == 600
    assert b.rate_limit.remaining == a.rate_limit.remaining - 1
    assert 0 < a.rate_limit.reset_seconds <= 60
    assert REQ.match(a.request_id)
    assert a.request_id != b.request_id


# ================================================================================================================ the PAPER write path
def resting_price(run: Runner, c: Any, instrument: str) -> str:
    """A limit price ~1 % under the mark: inside the paper engine's price band, under the best ask — it rests. An integer:
    on every tick, and within Hyperliquid's five significant figures."""
    return str(int(Decimal(run.call(c, "get_market", instrument).market.mark) * Decimal("0.99")))


def flatten(run: Runner, c: Any) -> None:
    for p in run.call(c, "get_positions", mode="paper").positions:
        run.call(c, "close_position", p.id)


def test_paper_preview_create_wait_positions_reduce_close_resting_cancel_replay_conflict_pagination(run: Runner) -> None:
    c = run.client(run.trader, timeout=60)
    key_id, mandate_id = run.stack["keys"][run.trader]["id"], run.stack["keys"][run.trader]["mandateId"]
    inst, acct = run.stack["paper"]["instrument"], run.stack["paper"]["accountId"]
    order: dict[str, Any] = {"mode": "paper", "account_id": acct, "instrument": inst, "side": "buy", "order_type": "market", "notional": "200"}
    market = run.venue(c, "get_market", inst)
    before = {o.id for o in run.call(c, "list_orders", limit=500).orders}

    # --- preview: nothing is created; the SERVER turned the notional into a size
    pv = run.venue(c, "preview_order", **order)
    conforms("previewOrder", pv)
    assert (pv.would_execute, pv.refusals, pv.approval.required, pv.approval.by) == (True, [], False, "mandate")
    assert (pv.mandate.id, pv.mandate.decision, pv.risk.decision, pv.engine.name) == (mandate_id, "allow", "allow", "paper")
    assert (pv.account.id, pv.account.withheld) == (acct, False)
    assert DEC.match(pv.account.equity)
    assert (pv.order.instrument, pv.order.side, pv.order.type, pv.order.mode, pv.order.notional) == (inst, "buy", "market", "paper", None)
    assert (pv.order.principal.kind, pv.order.principal.id) == ("api_key", key_id)
    assert pv.resolved.size == pv.order.size
    assert 190 < Decimal(pv.order.size) * Decimal(market.market.mark) < 210
    assert re.fullmatch(r"[0-9a-f]{64}", pv.hash)
    assert pv.meta.idempotency_key is None
    assert {o.id for o in run.call(c, "list_orders", limit=500).orders} == before
    say(f"[{run.kind}] preview_order(mode='paper', instrument, side='buy', order_type='market', notional='200') → {meta(pv)} would_execute={pv.would_execute} size={pv.order.size} "
        f"(sized by the server) approval={pv.approval.by} mandate={pv.mandate.decision} risk={pv.risk.decision} ({len(pv.risk.checks)} checks) equity={pv.account.equity}")  # fmt: skip

    # --- create, with one Idempotency-Key for the logical order
    key = new_idempotency_key()
    placed = run.call(c, "create_order", **order, idempotency_key=key)
    conforms("placeOrder", placed)
    oid = placed.order.id
    assert type(placed) is models.PlacedOrder
    assert (placed.idempotent, placed.approval) == (False, None)
    assert (placed.order.mode, placed.order.venue, placed.order.instrument, placed.order.side, placed.order.account_id, placed.order.mandate_id) == ("paper", "hyperliquid", inst, "buy", acct, mandate_id)
    assert placed.order.status in ORDER_STATES
    assert (placed.meta.status, placed.meta.idempotency_key, placed.meta.idempotent_replay) == (200, key, False)
    say(f"[{run.kind}] create_order(…, idempotency_key='{short(key)}') → {meta(placed)} order={short(oid)} {line(placed.order)}")
    done = run.call(c, "wait_for_order", oid, timeout=90, poll_interval=0.25)
    conforms("getOrder", done)
    assert (done.order.id, done.order.status, done.order.final, done.order.engine_status) == (oid, "FILLED", True, "filled")
    assert done.order.filled == done.order.size
    assert DEC.match(done.order.avg_fill_price)
    assert done.fills
    assert all(DEC.match(f.price) and DEC.match(f.size) for f in done.fills)
    say(f"[{run.kind}] wait_for_order('{short(oid)}') → {line(done.order)} fills={len(done.fills)} history={len(done.history or [])} transitions")

    # --- the same key and the same order: the SAME order, nothing sent again; the same key and another order: a conflict
    replay = run.call(c, "create_order", **order, idempotency_key=key)
    assert replay.order.id == oid
    assert replay.meta.idempotent_replay is True
    assert len({o.id for o in run.call(c, "list_orders", limit=500).orders} - before) == 1
    say(f"[{run.kind}] create_order(same order, same key) → {meta(replay)} same order={replay.order.id == oid} Idempotent-Replay={replay.meta.idempotent_replay}")
    conflict = declared("placeOrder", run.error(c, "create_order", **{**order, "notional": "210"}, idempotency_key=key))
    assert type(conflict) is IdempotencyConflict
    assert (conflict.status, conflict.code, conflict.idempotency_key) == (409, "idempotency_conflict", key)
    say(f"[{run.kind}] create_order(ANOTHER order, same key) → {type(conflict).__name__} HTTP {conflict.status} {conflict.code}")
    cid = f"sdk-py-{run.kind}-{new_idempotency_key()[:8]}"
    first = run.call(c, "create_order", **{**order, "notional": "150"}, client_order_id=cid)
    same = run.call(c, "create_order", **{**order, "notional": "150"}, client_order_id=cid)
    assert same.order.id == first.order.id
    assert same.meta.idempotent_replay is True  # the stored answer of that clientOrderId: no price is read again
    assert type(declared("placeOrder", run.error(c, "create_order", **{**order, "notional": "160"}, client_order_id=cid))) is IdempotencyConflict
    say(f"[{run.kind}] create_order(client_order_id) twice → same order={same.order.id == first.order.id} Idempotent-Replay={same.meta.idempotent_replay}; another body → IdempotencyConflict")

    # --- the position, reduced by half, then closed
    positions = run.call(c, "get_positions", mode="paper")
    conforms("listPositions", positions)
    pos = next(p for p in positions.positions if p.instrument == inst)
    assert (pos.mode, pos.venue, pos.account_id, pos.side) == ("paper", "hyperliquid", acct, "long")
    assert DEC.match(pos.size)
    assert DEC.match(pos.entry_price)
    say(f"[{run.kind}] get_positions(mode='paper') → {pos.side} {pos.size} @ {pos.entry_price} id={pos.id.replace(acct, '<account>')}")
    reduced = run.call(c, "reduce_position", pos.id, fraction=Decimal("0.5"))
    conforms("reducePosition", reduced)
    assert (reduced.order.status, reduced.order.final, reduced.order.reduce_only, reduced.order.side) == ("FILLED", True, True, "sell")
    after = next(p for p in run.call(c, "get_positions", mode="paper").positions if p.instrument == inst)
    assert Decimal(after.size) < Decimal(pos.size)
    say(f"[{run.kind}] reduce_position(id, fraction=Decimal('0.5')) → {meta(reduced)} {line(reduced.order)} reduce_only={reduced.order.reduce_only}; position now {after.size}")
    closed = run.call(c, "close_position", pos.id)
    conforms("closePosition", closed)
    assert (closed.order.status, closed.order.final, closed.order.reduce_only, closed.order.side) == ("FILLED", True, True, "sell")
    assert [p for p in run.call(c, "get_positions", mode="paper").positions if p.instrument == inst] == []
    say(f"[{run.kind}] close_position(id) → {meta(closed)} {line(closed.order)}; positions on {inst}: 0")
    none = declared("closePosition", run.error(c, "close_position", pos.id))
    assert (type(none), none.code) == (ValidationError, "no_position")

    # --- a resting limit order, then its cancel
    price = resting_price(run, c, inst)
    resting = run.call(c, "create_order", mode="paper", account_id=acct, instrument=inst, side="buy", order_type="limit", price=price, notional="200", tif="gtc")
    conforms("placeOrder", resting)
    assert (resting.order.status, resting.order.final, resting.order.engine_status, resting.order.price) == ("SUBMITTED", False, "open", price)
    say(f"[{run.kind}] create_order(order_type='limit', price='{price}', notional='200') → {meta(resting)} order={short(resting.order.id)} {line(resting.order)}")
    waiting = run.error(c, "wait_for_order", resting.order.id, timeout=0.3, poll_interval=0.1)
    assert type(waiting) is WaitTimeout
    assert "not failed" in str(waiting)
    assert [o.id for o in run.call(c, "list_orders", open=True).orders] == [resting.order.id]
    cancelled = run.call(c, "cancel_order", resting.order.id)
    conforms("cancelOrder", cancelled)
    assert (cancelled.changed, cancelled.order.id, cancelled.order.status, cancelled.order.final) == (True, resting.order.id, "CANCELLED", True)
    assert run.call(c, "wait_for_order", resting.order.id).order.status == "CANCELLED"
    again = run.call(c, "cancel_order", resting.order.id)
    assert (again.changed, again.sent) == (False, False)
    say(f"[{run.kind}] cancel_order('{short(resting.order.id)}') → {meta(cancelled)} status={cancelled.order.status} changed={cancelled.changed}; again → changed={again.changed}")

    # --- pagination: the iterators give the unpaged list, once each
    everything = run.call(c, "list_orders", limit=500)
    conforms("listOrders", everything)
    assert everything.next_cursor is None
    assert len(everything.orders) >= 5
    for o in everything.orders:
        assert o.status in ORDER_STATES
        assert o.final == (o.status in TERMINAL_ORDER_STATES)
    paged = [o.id for o in run.collect(c, "iter_orders", limit=2)]
    assert paged == [o.id for o in everything.orders]
    assert len(set(paged)) == len(paged)
    page = run.call(c, "list_orders", limit=2)
    assert len(page.orders) == 2
    assert re.fullmatch(r"[A-Za-z0-9_-]+", page.next_cursor)
    assert [o.id for o in run.collect(c, "iter_orders", limit=2, max_items=3)] == paged[:3]
    acts = run.call(c, "get_activity", limit=500)
    conforms("getActivity", acts)
    items = [a.id for a in run.collect(c, "iter_activity", limit=2)]
    assert items == [a.id for a in acts.items]
    assert len(items) >= 4
    assert all(a.kind == "fill" and a.mode == "paper" for a in acts.items)
    assert declared("listOrders", run.error(c, "list_orders", cursor="AAAA")).code == "invalid_cursor"
    say(f"[{run.kind}] list_orders(limit=2) → {len(page.orders)} orders, next_cursor={page.next_cursor[:16]}…; iter_orders(limit=2) → {len(paged)} orders in {-(-len(paged) // 2)} pages "
        f"= list_orders(limit=500); iter_activity(limit=2) → {len(items)} fills")  # fmt: skip


def test_refusals_execution_disabled_and_mandate_denied(run: Runner) -> None:
    c = run.client(run.trader, timeout=60)
    inst, acct = run.stack["paper"]["instrument"], run.stack["paper"]["accountId"]
    live: dict[str, Any] = {"mode": "live", "account_id": run.stack["live"]["accountId"], "instrument": inst, "side": "buy", "order_type": "market", "size": "0.001"}
    n = len(run.call(c, "list_orders", limit=500).orders)
    e = run.error(c, "create_order", **live)
    if isinstance(e, ServiceUnavailable):
        pytest.skip(f"venue unreachable: {e.code}")
    declared("placeOrder", e)
    assert type(e) is ExecutionDisabled
    assert (e.status, e.code, e.order) == (403, "execution_disabled", None)
    assert len(run.call(c, "list_orders", limit=500).orders) == n  # nothing was created
    say(f"[{run.kind}] create_order(mode='live', …) with SPW_TRADING_API_EXECUTION off → {type(e).__name__} HTTP {e.status} {e.code}; order created: {e.order is not None}")
    lp = run.call(c, "preview_order", **live)
    assert lp.would_execute is False
    assert next(r for r in lp.refusals if r.code == "execution_disabled").stage == "lock"

    denied = declared("placeOrder", run.error(c, "create_order", mode="paper", account_id=acct, instrument=inst, side="buy", order_type="market", notional="800"))
    assert type(denied) is MandateDenied
    assert (denied.status, denied.code) == (403, "mandate_denied")
    assert "ORDER_NOTIONAL_EXCEEDED" in denied.reasons
    assert all(r in models.MANDATE_DENY_REASONS for r in denied.reasons)
    assert type(denied.order) is models.Order
    assert (denied.order.status, denied.order.final, denied.order.reject_code) == ("REJECTED", True, "mandate_denied")
    assert run.call(c, "get_order", denied.order.id).order.status == "REJECTED"
    say(f"[{run.kind}] create_order(notional='800') under a mandate of {run.stack['paper']['maxOrderNotionalUsd']} USD an order → {type(denied).__name__} HTTP {denied.status} "
        f"reasons={denied.reasons} error.order.status={denied.order.status}")  # fmt: skip
    eth = declared("placeOrder", run.error(c, "create_order", mode="paper", account_id=acct, instrument="hyperliquid:ETH", side="buy", order_type="market", notional="100"))
    assert type(eth) is MandateDenied
    assert "INSTRUMENT_NOT_ALLOWED" in eth.reasons
    # another key's order is not this key's to cancel
    mine = run.call(c, "create_order", mode="paper", account_id=acct, instrument=inst, side="buy", order_type="limit", price=resting_price(run, c, inst), notional="100")
    other = run.client("trader2" if run.trader == "trader" else "trader")
    theirs = declared("cancelOrder", run.error(other, "cancel_order", mine.order.id))
    assert (theirs.status, theirs.code) == (403, "not_your_order")
    assert run.call(c, "cancel_order", mine.order.id).order.status == "CANCELLED"


def test_kill_switch_blocks_new_risk_not_cancels_nor_exits(run: Runner) -> None:
    c = run.client(run.trader, timeout=60)
    inst, acct = run.stack["paper"]["instrument"], run.stack["paper"]["accountId"]
    base: dict[str, Any] = {"mode": "paper", "account_id": acct, "instrument": inst, "side": "buy"}
    entry = run.venue(c, "create_order", **base, order_type="market", notional="150")
    assert entry.order.status == "FILLED"
    resting = run.call(c, "create_order", **base, order_type="limit", price=resting_price(run, c, inst), notional="100")
    assert resting.order.status == "SUBMITTED"
    reason = f"sdk-py {run.kind} integration test"
    try:
        ks = run.call(c, "engage_kill_switch", reason)
        conforms("engageKillSwitch", ks)
        assert (ks.kill_switch.on, ks.kill_switch.reason, ks.kill_switch.by.kind, ks.kill_switch.by.id) == (True, reason, "api_key", run.stack["keys"][run.trader]["id"])
        risk = run.call(c, "get_risk")
        conforms("getRisk", risk)
        assert risk.engine.kill_switch.on is True
        say(f"[{run.kind}] engage_kill_switch({reason!r}) → {meta(ks)} kill_switch.on={ks.kill_switch.on} by={ks.kill_switch.by.kind}")
        blocked = declared("placeOrder", run.error(c, "create_order", **base, order_type="market", notional="100"))
        assert type(blocked) is RiskDenied
        assert (blocked.status, blocked.code, blocked.kill_switch) == (423, "kill_switch_active", True)
        assert "kill_switch" in blocked.failed
        assert next(x for x in blocked.checks if x.id == "kill_switch").ok is False
        assert (blocked.order.status, blocked.order.final) == ("REJECTED", True)
        say(f"[{run.kind}] create_order(new risk) → {type(blocked).__name__} HTTP {blocked.status} {blocked.code} failed={blocked.failed} error.order.status={blocked.order.status}")
        pv = run.call(c, "preview_order", **base, order_type="market", notional="100")
        assert pv.would_execute is False
        assert any(r.code == "kill_switch_active" for r in pv.refusals)
        # what only removes risk still passes
        cancelled = run.call(c, "cancel_order", resting.order.id)
        assert cancelled.order.status == "CANCELLED"
        pos = next(p for p in run.call(c, "get_positions", mode="paper").positions if p.instrument == inst)
        closed = run.call(c, "close_position", pos.id)
        assert (closed.order.status, closed.order.reduce_only) == ("FILLED", True)
        say(f"[{run.kind}] with the kill switch on: cancel_order → {cancelled.order.status}; close_position → {closed.order.status} (reduce-only)")
    finally:
        owner_action(run.stack, "POST", "/kill-switch/release")
    assert run.call(c, "get_risk").engine.kill_switch.on is False
    again = run.call(c, "create_order", **base, order_type="market", notional="100")
    assert again.order.status == "FILLED"
    flatten(run, c)
    say(f"[{run.kind}] owner released the kill switch (passkey) → create_order → {again.order.status}")


def test_commands_ambiguous_dry_run_query(run: Runner) -> None:
    c = run.client(run.trader, timeout=60)
    acct, inst = run.stack["paper"]["accountId"], run.stack["paper"]["instrument"]
    owner_action(run.stack, "PUT", "/command-defaults", {"defaults": {}})
    amb = run.error(c, "run_command", "LONG BTC-PERP 100", account_id=acct, dry_run=True)
    if isinstance(amb, ServiceUnavailable):
        pytest.skip(f"venue unreachable: {amb.code}")
    declared("runCommand", amb)
    assert type(amb) is AmbiguousCommand
    assert (amb.status, amb.code) == (409, "ambiguous_command")
    assert amb.questions
    assert all(isinstance(q["field"], str) and isinstance(q["options"], list) and q["message"] for q in amb.questions)
    say(f"[{run.kind}] run_command('LONG BTC-PERP 100', dry_run=True) without owner defaults → {type(amb).__name__} HTTP {amb.status} questions={[q['field'] for q in amb.questions]}")
    defaults = {"perpVenue": "hyperliquid", "perpNetworkByVenue": {"hyperliquid": "mainnet"}, "perpLeverage": "2", "perpMarginMode": "cross", "maxFeeBps": 10, "maxSlippageBps": 50, "orderTtlMs": 60000}
    owner_action(run.stack, "PUT", "/command-defaults", {"defaults": defaults})
    n = len(run.call(c, "list_orders", limit=500).orders)
    dry = run.call(c, "run_command", "LONG BTC-PERP 100", account_id=acct, dry_run=True)
    conforms("runCommand", dry)
    assert type(dry) is models.CommandDryRun  # a dry run carries the CANONICAL order
    assert (dry.kind, dry.command, dry.mode, dry.dry_run, dry.executed) == ("order", "perp_open", "paper", True, False)
    assert (dry.order.instrument, dry.order.side) == (inst, "buy")
    assert re.fullmatch(r"[0-9a-f]{64}", dry.hash)
    assert len(run.call(c, "list_orders", limit=500).orders) == n
    say(f"[{run.kind}] run_command('LONG BTC-PERP 100', dry_run=True) → {meta(dry)} kind={dry.kind} executed={dry.executed} "
        f"order={{instrument: {dry.order.instrument}, side: {dry.order.side}, notional: {dry.order.notional}}} (the canonical order); orders created: 0")  # fmt: skip
    show = run.call(c, "run_command", "SHOW POSITIONS", account_id=acct)
    conforms("runCommand", show)
    assert type(show) is models.CommandQuery
    assert (show.kind, show.query) == ("query", "positions")
    assert isinstance(show.data["positions"], list)
    kill = run.call(c, "run_command", "KILL", dry_run=True)
    assert type(kill) is models.CommandControl
    assert (kill.kind, kill.control.type, kill.executed) == ("control", "kill_switch_on", False)
    assert run.call(c, "get_risk").engine.kill_switch.on is False
    bad = declared("runCommand", run.error(c, "run_command", "FROBNICATE THE MARKET"))
    assert (type(bad), bad.code) == (ValidationError, "parse_error")
    say(f"[{run.kind}] run_command('SHOW POSITIONS') → kind={show.kind} query={show.query}; run_command('KILL', dry_run=True) → kind={kill.kind} executed={kill.executed}; "
        f"run_command('FROBNICATE…') → {type(bad).__name__} {bad.code}")  # fmt: skip


def test_a_preview_withholds_the_account_from_a_key_that_may_not_read_it(run: Runner) -> None:
    acct, inst = run.stack["paper"]["accountId"], run.stack["paper"]["instrument"]
    p = run.venue(run.client("prepare"), "preview_order", mode="paper", account_id=acct, instrument=inst, side="buy", order_type="market", notional="100")
    conforms("previewOrder", p)
    assert (p.account.id, p.account.withheld, p.account.equity, p.account.free_collateral) == (acct, True, None, None)
    assert "equity" not in p.account.model_fields_set and "free_collateral" not in p.account.model_fields_set  # omitted, not null
    assert p.risk.derived.position_before is None
    assert p.would_execute is True
    assert any(x.detail.startswith("withheld") for x in p.risk.checks)
    say(f"[{run.kind}] preview_order with a key holding orders:prepare + markets:read only → account={{venue: {p.account.venue}, withheld: {p.account.withheld}}} would_execute={p.would_execute}")


# ================================================================================================================ agents on paper
def test_agents_on_paper_create_start_read_one_mode_pause_backtest_stop(run: Runner) -> None:
    c = run.client("unbound", timeout=60)  # every scope and NO trading mandate: managing agents needs none (research and paper sign nothing)
    t = run.call(c, "list_agent_templates")
    conforms("listAgentTemplates", t)
    mm = next(x for x in t.templates if x.id == "market-making")
    assert mm.engine == "stream" and "paper" in mm.modes
    say(f"[{run.kind}] list_agent_templates() → {meta(t)} {[f'{x.id}({x.engine}: {chr(47).join(x.modes)})' for x in t.templates]}")
    created = run.venue(c, "create_agent", template="market-making", name=f"SDK MM {run.kind} {new_idempotency_key()[:6]}", venues=["hyperliquid"], universe=["BTC"], capital_usdc=1000)
    conforms("createAgent", created)
    agent_id = created.agent.id
    assert (created.agent.state, created.agent.mode) == ("stopped", "research")
    say(f"[{run.kind}] create_agent(template='market-making', venues=['hyperliquid'], universe=['BTC']) → {meta(created)} agent={short(agent_id)} state={created.agent.state} mode={created.agent.mode}")
    started = run.call(c, "start_agent", agent_id, mode="paper")
    conforms("startAgent", started)
    assert (started.agent.id, started.agent.state, started.agent.mode) == (agent_id, "active", "paper")
    say(f"[{run.kind}] start_agent(id, mode='paper') → {meta(started)} state={started.agent.state} mode={started.agent.mode}")
    one = run.call(c, "get_agent", agent_id)
    conforms("getAgent", one)
    assert (one.agent.id, one.agent.family, one.agent.state, one.agent.mode) == (agent_id, mm.family, "active", "paper")
    listed = run.call(c, "list_agents")
    conforms("listAgents", listed)
    mine = next(a for a in listed.agents if a.id == agent_id)
    assert (mine.kind, mine.lifecycle, mine.trading_mode) == ("stream", "active", "paper")
    signals = run.call(c, "list_agent_signals", agent_id, mode="paper", limit=20)
    journal = run.call(c, "list_agent_journal", agent_id, mode="paper")
    orders = run.call(c, "list_agent_orders", agent_id, mode="paper", open=False)
    perf = run.call(c, "get_agent_performance", agent_id, mode="paper")
    for op_id, r in (("listAgentSignals", signals), ("listAgentJournal", journal), ("listAgentOrders", orders), ("getAgentPerformance", perf)):
        conforms(op_id, r)
        assert r.mode == "paper"
    assert journal.entries and all(e.mode == "paper" for e in journal.entries)
    assert run.call(c, "list_agent_journal", agent_id, mode="live").entries == []  # another mode is another answer: nothing of paper in it
    say(f"[{run.kind}] list_agent_signals/journal/orders(id, mode='paper'), get_agent_performance(id, mode='paper') → signals={len(signals.signals)} journal={len(journal.entries)} "
        f"({journal.entries[0].title!r}) orders={len(orders.orders)} performance: {perf.label!r} points={perf.points}")  # fmt: skip
    # one mode per call: required by the SDK, and `all` is a 400 of the API
    assert isinstance(run.error(c, "list_agent_signals", agent_id, mode="all"), ConfigurationError)
    req = urllib.request.Request(f"{run.stack['baseUrl']}/api/v1/trading/agents/{agent_id}/signals?mode=all", headers={"authorization": f"Bearer {run.stack['keys']['unbound']['secret']}"})  # noqa: S310
    with pytest.raises(urllib.error.HTTPError) as http:
        urllib.request.urlopen(req, timeout=30)  # noqa: S310
    assert (http.value.code, json.loads(http.value.read())["error"]) == (400, "bad_request")
    paused = run.call(c, "pause_agent", agent_id, reason="sdk test")
    conforms("pauseAgent", paused)
    assert paused.agent.state == "paused"
    bt = run.call(c, "backtest_agent", agent_id, hours=1)
    conforms("backtestAgent", bt)
    assert (bt.job.kind, bt.label) == ("backtest", "backtest")
    job = run.call(c, "get_job", bt.job.id)
    conforms("getJob", job)
    assert job.job.id == bt.job.id and job.job.status in ("queued", "running", "done", "failed", "cancelled")
    try:
        waited = run.call(c, "wait_for_job", bt.job.id, timeout=20, poll_interval=0.5).job.status
    except WaitTimeout as w:
        waited = f"WaitTimeout (not a failure: the job is still {w.last.job.status})"
    say(f"[{run.kind}] pause_agent(id) → state={paused.agent.state}; backtest_agent(id, hours=1) → job={short(bt.job.id)} status={bt.job.status}; get_job → {job.job.status}; wait_for_job(20 s) → {waited}")
    stopped = run.call(c, "stop_agent", agent_id, reason="sdk test")
    conforms("stopAgent", stopped)
    assert stopped.agent.state == "stopped"
    say(f"[{run.kind}] stop_agent(id) → {meta(stopped)} state={stopped.agent.state}")
    # the refusals: live without an owner-approved mandate for the agent; an unknown agent; a spot agent (the owner's app)
    live = declared("startAgent", run.error(c, "start_agent", agent_id, mode="live"))
    assert isinstance(live, Conflict) and live.code in ("mandate_required", "live_unavailable")
    ghost = declared("getAgent", run.error(c, "get_agent", UUID))
    assert (type(ghost), ghost.code) == (NotFound, "not_found")
    assert type(declared("getJob", run.error(c, "get_job", UUID))) is NotFound
    assert declared("createAgent", run.error(c, "create_agent", kind="spot", name="spot via key", universe=["BTC"])).code == "owner_required"
    for name, kw in (("backtest_strategy", {}), ("start_strategy", {"mode": "paper"}), ("stop_strategy", {})):
        assert type(run.error(c, name, UUID, **kw)) is NotFound, name
    assert type(declared("createStrategy", run.error(c, "create_strategy", kind="perp", path="momentum/v1", agent_id=UUID))) is NotFound
    say(f"[{run.kind}] start_agent(id, mode='live') without an owner-approved mandate → {type(live).__name__} HTTP {live.status} {live.code}; get_agent(unknown) → {type(ghost).__name__} {ghost.code}")


# ================================================================================================================ the write surface and the refusals
def test_this_file_calls_every_write_operation_of_the_document() -> None:
    writes = sorted(k for k, v in OPERATIONS.items() if v[0] != "GET")
    assert writes == sorted(["backtestAgent", "backtestStrategy", "cancelOrder", "closePosition", "createAgent", "createStrategy", "engageKillSwitch", "pauseAgent", "placeOrder", "previewOrder",
                             "reducePosition", "runCommand", "startAgent", "startStrategy", "stopAgent", "stopStrategy"])  # fmt: skip
    assert sorted(k for k, v in OPERATIONS.items() if v[0] != "GET" and not v[4]) == ["engageKillSwitch", "previewOrder"]  # no Idempotency-Key
    assert all(v[3] for v in OPERATIONS.values())  # every operation is implemented: nothing answers 501 by declaration


def test_key_without_a_mandate_execution_is_refused_a_preview_included(run: Runner) -> None:
    c = run.client("unbound")
    gated = {"placeOrder": ("create_order", (), ORDER), "closePosition": ("close_position", ("pos-1",), {}), "reducePosition": ("reduce_position", ("pos-1",), {"fraction": "0.5"})}
    assert sorted(gated) == sorted(k for k, v in OPERATIONS.items() if v[5])  # what needs a mandate on the KEY
    for op_id, (name, args, kwargs) in gated.items():
        e = declared(op_id, run.error(c, name, *args, **kwargs))
        assert type(e) is MandateRequired, op_id
        assert (e.status, e.code) == (403, "mandate_required")
        say(f"[{run.kind}] {name} (key without a mandate) → {type(e).__name__} HTTP {e.status} {e.code}")
    assert type(declared("runCommand", run.error(c, "run_command", "LONG BTC-PERP 100", account_id=run.stack["paper"]["accountId"]))) is MandateRequired
    nf = declared("cancelOrder", run.error(c, "cancel_order", "no-such-order-0001"))  # a cancel needs no mandate
    assert (type(nf), nf.code) == (NotFound, "unknown_order")
    pv = declared("previewOrder", run.error(c, "preview_order", **ORDER, account_id=run.stack["paper"]["accountId"]))
    assert type(pv) is MandateRequired  # the scope needs no mandate; the previewed order does
    assert OPERATIONS["previewOrder"][5] is False
    say(f"[{run.kind}] preview_order (key without a mandate) → {type(pv).__name__} HTTP {pv.status} {pv.code}")


def test_scope_refusal(run: Runner) -> None:
    c = run.client("narrow")
    for name, kw in (("get_portfolio", {}), ("get_balances", {}), ("get_positions", {}), ("list_orders", {}), ("list_agents", {}), ("get_risk", {}), ("preview_order", ORDER), ("engage_kill_switch", {}), ("create_order", ORDER)):  # fmt: skip
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
    run.error(run.client("trader"), "cancel_order", "no-such-order-0001")
    run.error(run.client("unbound"), "create_order", **ORDER)
    assert any(r.name.startswith(("httpx", "httpcore")) for r in caplog.records), "the transport logged nothing: the test would prove nothing"
    secrets = [k["secret"] for k in stack["keys"].values()]
    for record in caplog.records:
        text = f"{record.getMessage()} {record.args!r}"
        assert "spw_live_" not in text, text
        assert not any(s in text or s[-20:] in text for s in secrets), text


def _example(name: str, stack: dict[str, Any], key: str = "reader") -> str:
    env = {"PATH": os.environ.get("PATH", ""), "SP_WALLET_API_KEY": stack["keys"][key]["secret"], "SP_WALLET_BASE_URL": stack["baseUrl"]}
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
    assert re.search(r"agents: \d+; orders: \d+; signer halted: False", out)
    assert out.rstrip().endswith("done")


def test_example_preview_order_is_a_real_preview(stack: dict[str, Any]) -> None:
    out = _example("preview_order.py", stack, "prepare")  # may preview, may not read the account
    assert out.rstrip().endswith("done")
    if "cannot be read now" in out:
        pytest.skip("venue unreachable")
    assert "preview: would execute=True" in out
    assert re.search(r"order: buy 0\.\d+ hyperliquid:BTC \(market\)", out)
    assert "approval: mandate; risk engine: allow" in out
    assert "account figures: withheld" in out
    # the same example with a key that has no mandate says what is missing
    assert "not bound to an owner-approved trading mandate" in _example("preview_order.py", stack)


def test_example_paper_order_runs_the_whole_paper_path(stack: dict[str, Any]) -> None:
    out = _example("paper_order.py", stack, "trader")
    if re.search(r"venue_unavailable|venue_timeout|venue_rate_limited", out):
        pytest.skip("venue unreachable")
    assert "preview: would execute=True" in out
    assert re.search(r"placed: order .* status=FILLED final=True", out)
    assert "replay: same order=True, answered from the idempotency store=True" in out
    assert "final: status=FILLED" in out
    assert "position: long " in out
    assert "closed: status=FILLED reduce_only=True" in out
    assert out.rstrip().endswith("done")

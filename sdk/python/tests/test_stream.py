# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/tests/test_stream.py
# Module           : sdk
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
# Last Modified    : 2026-11-15
#
# =============================================================================
# AUTHOR & PROFESSIONAL AFFILIATION
# =============================================================================
#
# Author           : Simon-Pierre Boucher
# Position         : Professor of Finance
# Institution      : Université du Québec en Outaouais (UQO)
# Department       : Département des sciences administratives
# Organization     : SP Boucher
#
# Website          : https://spboucher.ai
# Git              : https://git.spboucher.ai
#
# =============================================================================
# OFFICIAL CONTACT DIRECTORY
# =============================================================================
#
# General          : info@spboucher.ai
# Professional     : contact@spboucher.ai
# Direct           : simon@spboucher.ai
# Research         : research@spboucher.ai
# Development      : dev@spboucher.ai
# Support          : support@spboucher.ai
# Security/Admin   : admin@spboucher.ai
# Notifications    : notifications@spboucher.ai
#
# Preferred Contact: support@spboucher.ai
#
# =============================================================================
# COPYRIGHT & INTELLECTUAL PROPERTY
# =============================================================================
#
# Copyright (c) 2026
# Simon-Pierre Boucher
#
# All rights reserved where applicable.
#
# This file is governed by the applicable project license,
# copyright notices, institutional agreements and relevant law.
#
# Unless expressly authorized by the applicable license or
# rights holder, copying, redistribution, sublicensing,
# publication and commercial exploitation are not permitted.
#
# Existing third-party rights and notices remain unaffected.
#
# =============================================================================
# CONFIDENTIALITY & SECURITY
# =============================================================================
#
# Classification   : Public
# Distribution     : Public repository; use is governed by the project license
# Security Contact : admin@spboucher.ai
#
# Access to this source does not independently grant permission
# to redistribute or disclose confidential materials.
#
# Do not embed credentials, private keys, access tokens,
# certificates or confidential personal information.
#
# =============================================================================
# LICENSE & MAINTENANCE
# =============================================================================
#
# License          : None specified (no license file in this repository)
# Maintainer       : Simon-Pierre Boucher
# Technical Contact: dev@spboucher.ai
#
# =============================================================================
# END OF SP BOUCHER SOURCE HEADER
# =============================================================================

"""SPWalletStream against a LOCAL FAKE SERVER (a real websocket server of the `websockets` package on 127.0.0.1): the
handshake by header or by ticket (never the key in the URL), subscribe / acknowledge / refuse, typed messages, callbacks and
`async for`, reconnection with resubscription, the heartbeat watchdog, credentials that must not be retried — and that the
client's book checksum and merge are the server's (tests/fixtures/stream-vectors.json, generated from the server's code).
"""

from __future__ import annotations

import asyncio
import json
import zlib
from collections.abc import Awaitable, Callable
from decimal import Decimal
from http import HTTPStatus
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from sp_wallet.stream import Book, OrderBook, Quote, SPWalletStream, StreamError, VenueStatus, book_checksum, channel_key

KEY = "spw_live_spk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"
VECTORS = json.loads((Path(__file__).parent / "fixtures" / "stream-vectors.json").read_text())


def hello(heartbeat_ms: int = 15_000) -> dict[str, Any]:
    limits = {"maxSubscriptions": 300, "maxFrameBytes": 16384, "maxMessagesPerSec": 20, "idleTimeoutMs": 120_000}
    return {"v": 1, "type": "hello", "connId": "c1", "heartbeatMs": heartbeat_ms, "serverTs": 0, "limits": limits}


def quote(id_: str, mark: str, seq: int) -> dict[str, Any]:
    return {"v": 1, "type": "quote", "id": id_, "bid": "64999", "bidSize": "1", "ask": "65001", "askSize": "2", "mid": "65000", "mark": mark, "index": None, "last": None,
            "funding": "0.0000125", "openInterest": None, "change24h": None, "volume24h": None, "venueTs": 1, "recvTs": 2, "seq": seq, "source": "hyperliquid-ws", "stale": False}


class FakeServer:
    """One scripted quote-engine endpoint. `script(conn, n)` drives the n-th connection (default: acknowledge everything)."""

    def __init__(self, *, refuse: tuple[int, dict[str, str]] | None = None, heartbeat_ms: int = 15_000) -> None:
        self.requests: list[Request] = []
        self.received: list[list[dict[str, Any]]] = []
        self.conns: list[ServerConnection] = []
        self.refuse, self.heartbeat_ms = refuse, heartbeat_ms
        self.snapshots: dict[str, Any] = {}
        self.unknown: set[str] = set()
        self.silent = False
        self.port = 0
        self._server: Any = None

    async def __aenter__(self) -> FakeServer:
        self._server = await serve(self._handle, "127.0.0.1", 0, process_request=self._gate)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        self._server.close()
        await self._server.wait_closed()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _gate(self, conn: ServerConnection, request: Request) -> Response | None:
        self.requests.append(request)
        if self.refuse:
            status, body = self.refuse
            return Response(status, HTTPStatus(status).phrase, Headers({"content-type": "application/json"}), json.dumps(body).encode())
        return None

    async def _handle(self, conn: ServerConnection) -> None:
        self.conns.append(conn)
        got: list[dict[str, Any]] = []
        self.received.append(got)
        await conn.send(json.dumps(hello(self.heartbeat_ms)))
        async for raw in conn:
            frame = json.loads(raw)
            got.append(frame)
            if frame.get("op") == "subscribe" and not self.silent:
                for c in frame["channels"]:
                    key = channel_key(c)
                    if c["id"] in self.unknown:
                        await conn.send(json.dumps({"v": 1, "type": "error", "code": "unknown_instrument", "message": f"unknown instrument '{c['id']}'", "channel": c}))
                    else:
                        snap = self.snapshots.get(key)
                        ack = {"v": 1, "type": "subscribed", "channel": c, "key": key, "staleAfterMs": 15000, "source": "hyperliquid-ws", "snapshot": snap, "snapshotAgeMs": 12 if snap else None}
                        await conn.send(json.dumps(ack))

    async def push(self, frame: dict[str, Any], conn: int = -1) -> None:
        await self.conns[conn].send(json.dumps(frame))


def run(test: Callable[[], Awaitable[None]]) -> None:
    asyncio.run(asyncio.wait_for(test(), 30))


async def until(cond: Callable[[], bool], what: str, seconds: float = 5.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"timeout: {what}")


def test_header_handshake_subscribe_callbacks_and_iteration() -> None:
    async def body() -> None:
        async with FakeServer() as srv:
            srv.snapshots["quote|hyperliquid:BTC|"] = quote("hyperliquid:BTC", "65000", 4)
            srv.unknown.add("hyperliquid:NOPE")
            seen: list[str] = []
            async with SPWalletStream(KEY, base_url=srv.base) as stream:
                stream.on("quote", lambda q: seen.append(f"{q.id}@{q.mark}"))
                await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "book", "id": "hyperliquid:BTC", "depth": 10}])
                # the key is in the Authorization header of the handshake, never in the URL
                req = srv.requests[0]
                assert req.path == "/api/v1/trading/stream" and "spw_live" not in req.path
                assert req.headers["Authorization"] == f"Bearer {KEY}" and req.headers["User-Agent"].startswith("sp-wallet-python/")
                assert stream.state == "open" and stream.hello and stream.hello["connId"] == "c1"
                assert srv.received[0] == [{"v": 1, "op": "subscribe", "channels": [{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "book", "id": "hyperliquid:BTC", "depth": 10}]}]
                with pytest.raises(StreamError) as refused:
                    await stream.subscribe({"type": "quote", "id": "hyperliquid:NOPE"})
                assert refused.value.code == "unknown_instrument" and refused.value.channel == {"type": "quote", "id": "hyperliquid:NOPE"}
                assert [channel_key(c) for c in stream.subscriptions()] == ["quote|hyperliquid:BTC|", "book|hyperliquid:BTC|10"]  # a refused channel is not kept
                await srv.push(quote("hyperliquid:BTC", "65010", 5))
                await srv.push({"v": 1, "type": "heartbeat", "ts": 1, "subscriptions": 2})
                await srv.push({"v": 1, "type": "dropped", "channel": "trades", "id": "hyperliquid:BTC", "count": 3, "total": 3})
                await srv.push({"v": 1, "type": "status", "venue": "hyperliquid", "status": "reconnecting", "since": 1, "ageMs": 900, "transport": "stream", "source": "hyperliquid-ws", "detail": None, "ts": 2})
                got = []
                async for m in stream:
                    got.append(m)
                    if len(got) == 3:
                        break
                assert isinstance(got[0], Quote) and isinstance(got[2], VenueStatus)
                assert [getattr(m, "mark", m.type) for m in got] == ["65000", "65010", "status"]  # the snapshot first, then live, in order
                q = got[1]
                assert (q.bid, q.bid_size, q.ask_size, q.venue_ts, q.recv_ts, q.stale) == ("64999", "1", "2", 1, 2, False) and Decimal(q.mid) == Decimal("65000")
                assert got[2].age_ms == 900 and got[2].status == "reconnecting"
                assert seen == ["hyperliquid:BTC@65000", "hyperliquid:BTC@65010"] and stream.stats["trades_dropped_by_server"] == 3
                await stream.unsubscribe({"type": "quote", "id": "hyperliquid:BTC"})
                await until(lambda: srv.received[0][-1].get("op") == "unsubscribe", "the unsubscribe frame")
            assert stream.state == "closed" and "spw_live" not in repr(stream)
            with pytest.raises(StreamError):
                await stream.connect()

    run(body)


def test_ticket_instead_of_the_header() -> None:
    async def body() -> None:
        async with FakeServer() as srv:
            n = 0

            async def ticket() -> str:
                nonlocal n
                n += 1
                return f"spw_tkt_{n}"

            async with SPWalletStream(base_url=srv.base, ticket=ticket, backoff_min=0.01) as stream:
                await stream.subscribe({"type": "status", "id": "*"})
                assert srv.requests[0].path == "/api/v1/trading/stream?ticket=spw_tkt_1" and "Authorization" not in srv.requests[0].headers
                await srv.conns[0].close(1001, "server shutting down")
                await until(lambda: len(srv.requests) == 2 and stream.state == "open", "the reconnection")
                assert srv.requests[1].path == "/api/v1/trading/stream?ticket=spw_tkt_2"  # a ticket is used once: a new one per connection

    run(body)


def test_reconnects_resubscribes_and_watches_the_heartbeat() -> None:
    async def body() -> None:
        async with FakeServer(heartbeat_ms=80) as srv:
            closes: list[dict[str, Any]] = []
            async with SPWalletStream(KEY, base_url=srv.base, backoff_min=0.01, backoff_max=0.05) as stream:
                stream.on("close", closes.append)
                await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "trades", "id": "hyperliquid:BTC"}])
                await srv.conns[0].close(1001, "server shutting down")
                await until(lambda: len(srv.received) == 2 and len(srv.received[1]) == 1, "the resubscription")
                assert closes[0] == {"code": 1001, "reason": "server shutting down", "will_reconnect": True}
                assert srv.received[1] == [{"v": 1, "op": "subscribe", "channels": [{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "trades", "id": "hyperliquid:BTC"}]}]
                assert stream.stats["connects"] == 2 and stream.stats["resubscribed"] == 2
                # the server goes silent: 2.5 heartbeat periods (200 ms) later the client re-opens the connection by itself
                await until(lambda: len(srv.received) >= 3, "the watchdog reconnection", 3.0)
                assert any(c["reason"] == "no frame from the server (heartbeat watchdog)" for c in closes)
                # a revoked key or an ended session (4001) is final
                errors: list[StreamError] = []
                stream.on("error", errors.append)
                await until(lambda: stream.state == "open", "open again")
                await srv.conns[-1].close(4001, "the API key is no longer active")
                await until(lambda: stream.state == "closed", "the final close")
                assert errors[-1].code == "unauthorized" and errors[-1].message == "the API key is no longer active"
                n = len(srv.requests)
                await asyncio.sleep(0.2)
                assert len(srv.requests) == n  # no further attempt
                with pytest.raises(StreamError) as end:
                    async for _ in stream:
                        pass
                assert end.value.code == "unauthorized"

    run(body)


@pytest.mark.parametrize(("status", "code"), [(401, "unauthenticated"), (403, "insufficient_scope"), (403, "origin_refused")])
def test_a_refused_handshake_is_not_retried(status: int, code: str) -> None:
    async def body() -> None:
        async with FakeServer(refuse=(status, {"error": code, "message": "refused"})) as srv:
            stream = SPWalletStream(KEY, base_url=srv.base, backoff_min=0.01)
            with pytest.raises(StreamError) as e:
                await stream.subscribe({"type": "quote", "id": "hyperliquid:BTC"})
            assert (e.value.code, e.value.status) == (code, status) and stream.state == "closed"
            await asyncio.sleep(0.1)
            assert len(srv.requests) == 1

    run(body)


def test_configuration() -> None:
    with pytest.raises(StreamError):
        SPWalletStream(None, base_url="https://wallet.test")
    with pytest.raises(StreamError):
        SPWalletStream(KEY, base_url="wallet.test")
    assert "spw_live" not in repr(SPWalletStream(KEY, base_url="https://wallet.test"))


def test_slow_iteration_is_bounded() -> None:
    async def body() -> None:
        async with FakeServer() as srv, SPWalletStream(KEY, base_url=srv.base, buffer_size=100) as stream:
            await stream.subscribe({"type": "quote", "id": "hyperliquid:BTC"})
            for k in range(1, 251):
                await srv.push(quote("hyperliquid:BTC", str(k), k))
            await until(lambda: stream.stats["frames"] >= 252, "every frame")
            assert stream.stats["iterator_dropped"] == 150
            async for m in stream:
                assert m.mark == "151"  # type: ignore[union-attr]
                break

    run(body)


def test_book_vectors_of_the_server() -> None:
    """The checksum, the channel keys and the delta merge are the server's: tests/fixtures/stream-vectors.json is generated from its code."""
    assert zlib.crc32(b"") == VECTORS["crc32"][""] and zlib.crc32(b"123456789") == VECTORS["crc32"]["123456789"]
    for k in VECTORS["keys"]:
        assert channel_key(k["channel"]) == k["key"]
    book = OrderBook()
    for raw in VECTORS["messages"]:
        m = Book.model_validate(raw)
        assert book.apply(m), f"message {m.seq}"
        assert book_checksum(book.bids, book.asks) == m.checksum
    assert [list(x) for x in book.bids] == VECTORS["final"]["bids"] and [list(x) for x in book.asks] == VECTORS["final"]["asks"]
    assert Decimal(book.bids[0][0]) < Decimal(book.asks[0][0])
    # a hole in the sequence is refused, and the book says it is no longer ready; a snapshot restores it
    last = Book.model_validate(VECTORS["messages"][-1])
    assert not book.apply(last.model_copy(update={"seq": last.seq + 5, "prev_seq": last.seq + 4}))
    assert not book.ready
    snap = Book.model_validate({**VECTORS["messages"][0], "bids": VECTORS["final"]["bids"], "asks": VECTORS["final"]["asks"], "checksum": last.checksum, "seq": 99})
    assert book.apply(snap) and book.ready and book.seq == 99
    assert not OrderBook().apply(snap.model_copy(update={"checksum": 1}))  # a snapshot whose checksum does not match is not trusted

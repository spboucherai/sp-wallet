# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/tests/test_stream_integration.py
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

"""INTEGRATION: SPWalletStream against the stream of the REAL local API — the stack shared by every SDK integration test
(packages/trading-sdk/scripts/test-stack.mts): the real API and signer on an own per-run database, the real venue adapters,
the real websocket server, keys created through the owner routes.

SKIPPED — reported as skipped — when PostgreSQL is not reachable, when the repository's node_modules are not installed, or
with SPW_SDK_INTEGRATION=off. Live quotes come from the venues' public feeds: the test that needs them is skipped when no
venue answers within its delay. SPW_SDK_TRANSCRIPT=1 (with `pytest -s`) prints one line per step.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest

from conftest import ROOT
from sp_wallet.stream import Book, OrderBook, Quote, SPWalletStream, StreamError

pytestmark = pytest.mark.integration


def say(line: str) -> None:
    if os.environ.get("SPW_SDK_TRANSCRIPT"):
        print(f"[sdk-py-stream] {line}")


@pytest.fixture(scope="module")
def stack() -> Iterator[dict[str, Any]]:
    if os.environ.get("SPW_SDK_INTEGRATION") == "off":
        pytest.skip("SPW_SDK_INTEGRATION=off")
    tsx = ROOT / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        pytest.skip("the repository's node_modules are not installed (pnpm install): the real API cannot be started")
    proc = subprocess.Popen([str(tsx), str(ROOT / "packages/trading-sdk/scripts/test-stack.mts"), "pystream"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: lines.put(proc.stdout.readline() if proc.stdout else ""), daemon=True).start()
    try:
        first = lines.get(timeout=120)
    except queue.Empty:
        proc.kill()
        pytest.fail("the stream test stack did not start within 120 s")
    try:
        msg = json.loads(first) if first.strip() else {"ok": False, "skip": False, "reason": f"the stack exited with code {proc.poll()} before it was ready"}
        if not msg["ok"]:
            if msg.get("skip"):
                pytest.skip(msg["reason"])
            pytest.fail(f"the stream test stack failed: {msg['reason']}")
        yield msg
    finally:
        if proc.stdin:
            proc.stdin.close()  # the stack stops, drops its database and removes its directory
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


def run(coro: Any, seconds: float = 60) -> Any:
    return asyncio.run(asyncio.wait_for(coro, seconds))


def test_a_key_with_markets_read_gets_the_stream_and_the_venue_statuses(stack: dict[str, Any]) -> None:
    async def body() -> None:
        async with SPWalletStream(stack["keys"]["narrow"]["secret"], base_url=stack["baseUrl"]) as stream:
            statuses: list[Any] = []
            stream.on("status", statuses.append)
            await stream.subscribe({"type": "status", "id": "*"})
            assert stream.state == "open" and stream.hello and stream.hello["v"] == 1 and stream.hello["heartbeatMs"] == 15000
            assert sorted(s.venue for s in statuses) == ["dydx", "edgex", "gmx", "hyperliquid", "spot"]
            say(f"narrow key connected: conn {stream.hello['connId']}; venues {' '.join(f'{s.venue}={s.status}' for s in statuses)}")
            with pytest.raises(StreamError) as e:
                await stream.subscribe({"type": "quote", "id": "hyperliquid:NOPE_NOT_A_MARKET"})
            assert e.value.code == "unknown_instrument"
            with pytest.raises(StreamError) as e:
                await stream.subscribe({"type": "book", "id": "spot:BTC"})
            assert e.value.code == "unsupported_channel"

    run(body())


def test_a_key_without_the_scope_and_a_revoked_key_are_refused_with_their_code(stack: dict[str, Any]) -> None:
    async def refused(key: str, **opts: Any) -> StreamError:
        stream = SPWalletStream(stack["keys"][key]["secret"], base_url=stack["baseUrl"], **opts)
        with pytest.raises(StreamError) as e:
            await stream.connect()
        assert stream.state == "closed" and stream.stats["frames"] == 0
        return e.value

    async def body() -> None:
        for key, code, status in (("agentsOnly", "insufficient_scope", 403), ("revoked", "unauthenticated", 401)):
            e = await refused(key)
            assert (e.code, e.status) == (code, status)  # refused before the upgrade: the HTTP answer of the handshake says why
            say(f"{key} key: refused before the upgrade — HTTP {e.status} {e.code}")
            assert (await refused(key, auth="ticket")).code == code  # the ticket endpoint refuses it the same way

    run(body())


def test_a_key_restricted_to_one_venue_is_refused_on_the_others(stack: dict[str, Any]) -> None:
    async def body() -> None:
        async with SPWalletStream(stack["keys"]["venues"]["secret"], base_url=stack["baseUrl"]) as stream:
            await stream.subscribe({"type": "status", "id": "*"})
            for market in ("dydx:BTC-USD", "spot:BTC"):
                with pytest.raises(StreamError) as e:
                    await stream.subscribe({"type": "quote", "id": market})
                assert e.value.code == "restricted"
            assert stream.state == "open" and stream.subscriptions() == [{"type": "status", "id": "*"}]

    run(body())


def test_a_ticket_opens_the_stream_without_any_header(stack: dict[str, Any]) -> None:
    async def body() -> None:
        async with SPWalletStream(stack["keys"]["reader"]["secret"], base_url=stack["baseUrl"], auth="ticket") as stream:
            await stream.subscribe({"type": "status", "id": "hyperliquid"})
            assert stream.state == "open"
            say(f"ticket connection: conn {stream.hello['connId'] if stream.hello else '?'}")

    run(body())


def test_live_quotes_and_an_order_book_kept_from_the_stream(stack: dict[str, Any]) -> None:
    async def body() -> None:
        async with SPWalletStream(stack["keys"]["reader"]["secret"], base_url=stack["baseUrl"]) as stream:
            book, channel = OrderBook(), {"type": "book", "id": "hyperliquid:BTC", "depth": 10}
            try:
                await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "quote", "id": "spot:BTC"}, channel, {"type": "trades", "id": "hyperliquid:BTC"}])
            except StreamError as e:
                if e.code == "upstream_unavailable":
                    pytest.skip(f"venue unreachable: {e.message}")
                raise
            quote: Quote | None = None
            books: list[Book] = []
            holes, seen, t0 = 0, 0, time.monotonic()
            async for m in stream:
                seen += 1
                if isinstance(m, Quote) and m.id == "hyperliquid:BTC" and m.mark is not None:
                    quote = m
                elif isinstance(m, Book):
                    books.append(m)
                    if not book.apply(m):
                        holes += 1
                        await stream.resync(channel)
                if (quote and books) or time.monotonic() - t0 > 25:
                    break
            if quote is None:
                pytest.skip("no Hyperliquid quote within 25 s: venue unreachable from here")
            assert quote.source == "hyperliquid-ws" and quote.seq > 0 and isinstance(quote.recv_ts, int)
            assert Decimal(quote.mark) > 0 and all(isinstance(x, str) for x in (quote.mark, quote.funding or "0"))  # decimal strings, never floats
            assert books and books[0].kind == "snapshot" and books[0].depth == 10 and books[0].prev_seq is None
            assert book.ready and holes == 0 and Decimal(book.bids[0][0]) < Decimal(book.asks[0][0])
            say(f"hyperliquid:BTC mark {quote.mark} bid {quote.bid} ask {quote.ask} (seq {quote.seq}); book {len(books)} message(s), best {book.bids[0][0]} / {book.asks[0][0]}; "
                f"{seen} messages in {time.monotonic() - t0:.1f} s; frames {stream.stats['frames']}")

    run(body(), 90)


def test_the_example_stream_quotes_runs_against_the_real_stream_and_prints_no_secret(stack: dict[str, Any]) -> None:
    secret = stack["keys"]["narrow"]["secret"]
    env = {"PATH": os.environ.get("PATH", ""), "SP_WALLET_API_KEY": secret, "SP_WALLET_BASE_URL": stack["baseUrl"], "SP_WALLET_STREAM_QUOTES": "2"}
    out = subprocess.run([sys.executable, str(ROOT / "sdk/python/examples/stream_quotes.py")], env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    lines = out.stdout.splitlines()
    assert lines[0].startswith("connected: connection ") and lines[-1] == "done" and "refused" not in out.stdout
    assert secret not in out.stdout and secret not in out.stderr
    if "no more quotes within 20 s" in out.stdout:
        pytest.skip("the example ran, connected and stopped by itself; no Hyperliquid quote within 20 s (venue unreachable from here)")
    assert sum(1 for x in lines if x.startswith("quote hyperliquid:BTC: bid ")) == 2
    say("examples/stream_quotes.py: " + " | ".join(lines))
    # a key without markets:read: the example says so and still ends cleanly
    env["SP_WALLET_API_KEY"] = stack["keys"]["agentsOnly"]["secret"]
    refused = subprocess.run([sys.executable, str(ROOT / "sdk/python/examples/stream_quotes.py")], env=env, capture_output=True, text=True, timeout=60)
    assert refused.returncode == 0 and "refused: " in refused.stdout and "quote hyperliquid" not in refused.stdout, refused.stdout + refused.stderr

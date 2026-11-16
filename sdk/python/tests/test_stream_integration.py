"""INTEGRATION: SPWalletStream against the stream of the REAL local API — packages/trading-sdk/scripts/stream-stack.mts:
the server on an own per-run database, the real venue adapters, the real websocket server, keys written with the server's own hash.

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
    proc = subprocess.Popen([str(tsx), str(ROOT / "packages/trading-sdk/scripts/stream-stack.mts"), "py"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
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
        for key, code, status in (("limited", "insufficient_scope", 403), ("revoked", "unauthenticated", 401)):
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

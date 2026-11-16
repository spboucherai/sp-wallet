"""SPWalletStream — live public market data of the SP Wallet quote engine over a websocket (protocol version 1), on asyncio.

    from sp_wallet.stream import SPWalletStream

    async with SPWalletStream(api_key="spw_live_…", base_url="https://wallet.example") as stream:
        await stream.subscribe([{"type": "quote", "id": "hyperliquid:BTC"}, {"type": "book", "id": "hyperliquid:BTC", "depth": 10}])
        async for message in stream:            # Quote | Book | Trades | Candle | VenueStatus, in order
            if message.type == "quote":
                print(message.id, message.bid, message.ask, message.stale)

READ-ONLY: quotes, order books, trades, candles and venue statuses. Nothing here places, signs or cancels anything.
Every price, size and rate is a decimal STRING (`Decimal(message.bid)` to compute with it — never `float`).

The key needs the scope `markets:read`. It is sent in the `Authorization` header of the handshake and NEVER in the URL.
`ticket=` (an async function returning a single-use ticket of `POST /api/v1/trading/stream/ticket`) replaces the header
for a process that must not hold the key. The client reconnects by itself (exponential backoff with jitter), subscribes
again, and re-opens a connection on which the server went silent for 2.5 heartbeat periods. After a reconnection the
server sends fresh snapshots; `OrderBook` keeps a local book and refuses a delta that does not follow its predecessor.

Needs the optional dependency `websockets` (`pip install "sp-wallet-python[stream]"`). Reference: docs/V11-QUOTE-ENGINE.md.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import random
import zlib
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from decimal import Decimal
from typing import Any, Literal

import httpx
import pydantic

from ._base import DEFAULT_BASE_URL
from ._version import USER_AGENT
from .errors import SPWalletError

PROTOCOL_VERSION = 1
STREAM_PATH = "/api/v1/trading/stream"
TICKET_PATH = "/api/v1/trading/stream/ticket"
_FATAL_CODES = frozenset(
    {"configuration", "unauthenticated", "insufficient_scope", "ip_not_allowed", "mixed_credentials", "key_path_forbidden", "unauthorized"}
)
_REFUSED_FOR_GOOD = frozenset({"unknown_instrument", "unsupported_channel", "restricted"})
Channel = Mapping[str, Any]


class StreamError(SPWalletError):
    """A refusal or a failure of the stream. `code` is the server's code (`unknown_instrument`, `restricted`, `unauthorized`…)
    or `disconnected` / `closed` / `configuration`; `channel` is the channel it is about, when there is one."""

    def __init__(self, code: str, message: str, *, channel: Channel | None = None, status: int | None = None) -> None:
        super().__init__(message, code=code, status=status)
        self.channel = dict(channel) if channel else None


class _Message(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="allow", frozen=True)
    v: int = PROTOCOL_VERSION


class Quote(_Message):
    """`venue_ts`: the venue's own timestamp (ms) or None; `recv_ts`: when the server received it; `stale`: the server's verdict."""

    type: Literal["quote"] = "quote"
    id: str
    bid: str | None = None
    bid_size: str | None = pydantic.Field(None, alias="bidSize")
    ask: str | None = None
    ask_size: str | None = pydantic.Field(None, alias="askSize")
    mid: str | None = None
    mark: str | None = None
    index: str | None = None
    last: str | None = None
    funding: str | None = None
    open_interest: str | None = pydantic.Field(None, alias="openInterest")
    change_24h: str | None = pydantic.Field(None, alias="change24h")
    volume_24h: str | None = pydantic.Field(None, alias="volume24h")
    venue_ts: int | None = pydantic.Field(None, alias="venueTs")
    recv_ts: int = pydantic.Field(alias="recvTs")
    seq: int
    source: str
    stale: bool


class Book(_Message):
    """`kind` snapshot: replace the book; delta: changed prices only (size "0" removes it), applies only when `prev_seq` is the last `seq`."""

    type: Literal["book"] = "book"
    id: str
    depth: int
    kind: Literal["snapshot", "delta"]
    bids: list[tuple[str, str]]
    asks: list[tuple[str, str]]
    seq: int
    prev_seq: int | None = pydantic.Field(None, alias="prevSeq")
    checksum: int
    venue_ts: int | None = pydantic.Field(None, alias="venueTs")
    recv_ts: int = pydantic.Field(alias="recvTs")
    source: str
    stale: bool


class Trade(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="allow", frozen=True)
    id: str
    price: str
    size: str
    side: Literal["buy", "sell"]
    ts: int


class Trades(_Message):
    """`snapshot` True: the venue's recent history sent on subscription, not live prints."""

    type: Literal["trade"] = "trade"
    id: str
    trades: list[Trade]
    seq: int
    recv_ts: int = pydantic.Field(alias="recvTs")
    source: str
    snapshot: bool = False


class Candle(_Message):
    type: Literal["candle"] = "candle"
    id: str
    interval: str
    ts: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    seq: int
    recv_ts: int = pydantic.Field(alias="recvTs")
    source: str


class VenueStatus(_Message):
    type: Literal["status"] = "status"
    venue: str
    status: Literal["connected", "reconnecting", "stale", "down", "idle"]
    since: int
    age_ms: int | None = pydantic.Field(None, alias="ageMs")
    transport: Literal["stream", "poll"]
    source: str
    detail: str | None = None
    ts: int


DataMessage = Quote | Book | Trades | Candle | VenueStatus
_MODELS: dict[str, type[_Message]] = {"quote": Quote, "book": Book, "trade": Trades, "candle": Candle, "status": VenueStatus}


def channel_key(c: Channel) -> str:
    """`type|id|param` — the identity of a subscription on both sides of the socket."""
    t = c["type"]
    param = c.get("depth", 20) if t == "book" else c.get("interval", "1m") if t == "candle" else ""
    return f"{t}|{c['id']}|{param}"


def book_checksum(bids: Sequence[Sequence[str]], asks: Sequence[Sequence[str]]) -> int:
    """CRC-32 of `p:s|p:s…;p:s|…` over the best 10 levels of each side (bids first) — the `checksum` of a book message."""
    side = lambda levels: "|".join(f"{p}:{s}" for p, s in list(levels)[:10])  # noqa: E731
    return zlib.crc32(f"{side(bids)};{side(asks)}".encode("ascii")) & 0xFFFFFFFF


class OrderBook:
    """A local order book kept from the stream. `apply(message)` returns False when the message cannot be applied (a hole in
    the sequence, or a checksum that does not match): call `stream.resync(channel)` and do not read the book until a
    snapshot made `ready` True again. Prices stay decimal strings; they are compared as `Decimal`, never as floats."""

    def __init__(self) -> None:
        self.bids: list[tuple[str, str]] = []
        self.asks: list[tuple[str, str]] = []
        self.seq: int | None = None
        self.ready = False

    def apply(self, m: Book) -> bool:
        if m.kind == "snapshot":
            self.bids, self.asks = list(m.bids), list(m.asks)
        else:
            if not self.ready or m.prev_seq != self.seq:
                self.ready = False
                return False
            self.bids = self._merge(self.bids, m.bids, True, m.depth)
            self.asks = self._merge(self.asks, m.asks, False, m.depth)
        self.seq = m.seq
        self.ready = book_checksum(self.bids, self.asks) == m.checksum
        return self.ready

    @staticmethod
    def _merge(levels: list[tuple[str, str]], changes: list[tuple[str, str]], desc: bool, depth: int) -> list[tuple[str, str]]:
        book = dict(levels)
        for price, size in changes:
            if size == "0":
                book.pop(price, None)
            else:
                book[price] = size
        return sorted(book.items(), key=lambda x: Decimal(x[0]), reverse=desc)[:depth]


Handler = Callable[[Any], None]
TicketProvider = Callable[[], Awaitable[str]]


class SPWalletStream:
    """One websocket to the quote engine. See the module docstring."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        ticket: TicketProvider | None = None,
        auth: Literal["header", "ticket"] | None = None,
        reconnect: bool = True,
        backoff_min: float = 0.5,
        backoff_max: float = 30.0,
        buffer_size: int = 10_000,
        open_timeout: float = 10.0,
        _random: Callable[[], float] = random.random,
    ) -> None:
        key = api_key or os.environ.get("SP_WALLET_API_KEY")
        if not base_url.startswith(("http://", "https://")):
            raise StreamError("configuration", "base_url must be an http(s) URL")
        if not key and ticket is None:
            raise StreamError("configuration", "an API key (api_key or SP_WALLET_API_KEY) or a ticket function is required")
        self.__key = key
        self._base = base_url.rstrip("/")
        self._ticket = ticket
        self._auth = auth or ("ticket" if ticket is not None else "header")
        self._reconnect, self._backoff_min, self._backoff_max, self._open_timeout, self._random = reconnect, backoff_min, backoff_max, open_timeout, _random
        self.state: Literal["idle", "connecting", "open", "reconnecting", "closed"] = "idle"
        self.hello: dict[str, Any] | None = None
        self.stats = {"connects": 0, "frames": 0, "iterator_dropped": 0, "trades_dropped_by_server": 0, "resubscribed": 0}
        self._subs: dict[str, dict[str, Any]] = {}
        self._handlers: dict[str, list[Handler]] = {}
        self._pending: dict[str, list[asyncio.Future[None]]] = {}
        self._ws: Any = None
        self._task: asyncio.Task[None] | None = None
        self._opened: asyncio.Future[None] | None = None
        self._buffer: deque[DataMessage] = deque()
        self._buffer_size = buffer_size
        self._wake = asyncio.Event()
        self._error: StreamError | None = None

    def __repr__(self) -> str:  # the key never appears
        return f"SPWalletStream(base_url={self._base!r}, state={self.state!r}, subscriptions={len(self._subs)})"

    # ------------------------------------------------------------------------------------------------ events
    def on(self, event: str, handler: Handler) -> Callable[[], None]:
        """`quote`, `book`, `trade`, `candle`, `status`: the typed message. `dropped`, `open`, `close`, `subscribed`, `message`: the
        frame as a dict. `error`: a StreamError. Returns the function that removes the handler."""
        self._handlers.setdefault(event, []).append(handler)
        return lambda: self._handlers.get(event, []).remove(handler) if handler in self._handlers.get(event, []) else None

    def _emit(self, event: str, payload: Any) -> None:
        for h in list(self._handlers.get(event, [])):
            with contextlib.suppress(Exception):  # a handler must not break the stream
                h(payload)

    # ------------------------------------------------------------------------------------------------ connection
    async def connect(self) -> None:
        """Opens the connection (idempotent); returns once the server said hello. Raises StreamError when it is refused."""
        if self.state == "closed":
            raise self._error or StreamError("closed", "the stream was closed")
        if self._task is None:
            self._opened = asyncio.get_running_loop().create_future()
            self.state = "connecting"
            self._task = asyncio.create_task(self._run())
        if self.state != "open" and self._opened is not None:
            await asyncio.shield(self._opened)

    async def _target(self) -> tuple[str, dict[str, str]]:
        ws_base = "ws" + self._base[4:]
        if self._auth == "header":
            return f"{ws_base}{STREAM_PATH}", {"Authorization": f"Bearer {self.__key}", "User-Agent": USER_AGENT}
        if self._ticket is not None:
            ticket = await self._ticket()
        else:
            async with httpx.AsyncClient(timeout=self._open_timeout) as http:
                r = await http.post(f"{self._base}{TICKET_PATH}", headers={"Authorization": f"Bearer {self.__key}", "User-Agent": USER_AGENT}, json={})
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.status_code != 200 or "ticket" not in body:
                message = body.get("message", f"the stream ticket was refused (HTTP {r.status_code})")
                raise StreamError(body.get("error", "ticket_refused"), message, status=r.status_code)
            ticket = body["ticket"]
        return f"{ws_base}{STREAM_PATH}?ticket={ticket}", {"User-Agent": USER_AGENT}

    async def _run(self) -> None:
        try:
            from websockets.asyncio.client import connect
            from websockets.exceptions import ConnectionClosed, InvalidStatus
        except ImportError:  # pragma: no cover - depends on the installation
            self._fail(StreamError("configuration", 'the stream needs the `websockets` package: pip install "sp-wallet-python[stream]"'))
            return
        attempt = 0
        while self.state != "closed":
            greeted, code, reason = False, 1006, ""
            try:
                url, headers = await self._target()
                async with connect(url, additional_headers=headers, open_timeout=self._open_timeout, max_size=4 * 1024 * 1024, ping_interval=None) as ws:
                    self._ws = ws
                    self.stats["connects"] += 1
                    timeout: float | None = self._open_timeout
                    while True:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout)
                        except asyncio.TimeoutError:  # the heartbeat watchdog: the server went silent
                            reason = "no frame from the server (heartbeat watchdog)"
                            break
                        frame = json.loads(raw)
                        self.stats["frames"] += 1
                        if frame.get("type") == "hello":
                            greeted, attempt = True, 0
                            timeout = frame["heartbeatMs"] / 1000 * 2.5
                            await self._on_hello(frame)
                        else:
                            self._on_frame(frame)
            except InvalidStatus as e:  # refused before the upgrade: the HTTP answer says why
                status = e.response.status_code
                try:
                    body = json.loads(e.response.body or b"{}")
                except ValueError:
                    body = {}
                err = StreamError(body.get("error", "refused"), body.get("message", f"the stream was refused (HTTP {status})"), status=status)
                if status in (401, 403):
                    self._fail(err)
                    return
                reason = err.message
            except ConnectionClosed as e:
                code, reason = (e.rcvd.code, e.rcvd.reason) if e.rcvd else (1006, "")
            except StreamError as e:
                if e.code in _FATAL_CODES or (e.status in (401, 403)):
                    self._fail(e)
                    return
                reason = e.message
            except (OSError, asyncio.TimeoutError, httpx.HTTPError) as e:
                reason = type(e).__name__
            finally:
                self._ws = None
            if self.state == "closed":
                return
            self.hello = None
            err = StreamError("unauthorized" if code == 4001 else "disconnected", reason or f"the connection was closed ({code})")
            again = self._reconnect and code != 4001 and not (not greeted and self.stats["frames"] == 0 and attempt >= 2)
            self._emit("close", {"code": code, "reason": reason, "will_reconnect": again})
            self._reject_pending(err)
            if not again:
                self._fail(err)
                return
            self.state = "reconnecting"
            delay = min(self._backoff_max, self._backoff_min * 2 ** min(attempt, 16)) * (0.5 + 0.5 * self._random())
            attempt += 1
            await asyncio.sleep(delay)

    def _fail(self, err: StreamError) -> None:
        self.state, self._error = "closed", err
        if self._opened is not None and not self._opened.done():
            self._opened.set_exception(err)
            self._opened.exception()  # marked as retrieved: an un-awaited connect() must not warn
        self._reject_pending(err)
        self._emit("error", err)
        self._wake.set()

    def _reject_pending(self, err: StreamError) -> None:
        for futures in self._pending.values():
            for f in futures:
                if not f.done():
                    f.set_exception(err)
                    f.exception()
        self._pending.clear()

    async def _on_hello(self, frame: dict[str, Any]) -> None:
        self.hello, self.state = frame, "open"
        channels = list(self._subs.values())
        if channels:
            if self.stats["connects"] > 1:
                self.stats["resubscribed"] += len(channels)
            for i in range(0, len(channels), 100):
                await self._send({"v": PROTOCOL_VERSION, "op": "subscribe", "channels": channels[i : i + 100]})
        if self._opened is not None and not self._opened.done():
            self._opened.set_result(None)
        self._emit("open", frame)

    def _on_frame(self, frame: dict[str, Any]) -> None:
        self._emit("message", frame)
        kind = frame.get("type")
        if kind == "subscribed":
            for f in self._pending.pop(frame["key"], []):
                if not f.done():
                    f.set_result(None)
            self._emit("subscribed", frame)
            snap = frame.get("snapshot")
            for s in snap if isinstance(snap, list) else [snap] if snap else []:
                self._data(s)
        elif kind == "error":
            channel = frame.get("channel")
            err = StreamError(frame.get("code", "error"), frame.get("message", "error"), channel=channel)
            if channel:
                key = channel_key(channel)
                for f in self._pending.pop(key, []):
                    if not f.done():
                        f.set_exception(err)
                        f.exception()
                if err.code in _REFUSED_FOR_GOOD:
                    self._subs.pop(key, None)
            self._emit("error", err)
        elif kind == "dropped":
            self.stats["trades_dropped_by_server"] += int(frame.get("count", 0))
            self._emit("dropped", frame)
        elif kind in _MODELS:
            self._data(frame)

    def _data(self, frame: dict[str, Any]) -> None:
        model = _MODELS.get(frame.get("type", ""))
        if model is None:
            return
        try:
            m = model.model_validate(frame)
        except pydantic.ValidationError:
            return  # a frame this version does not understand is not a price
        self._emit(m.type, m)
        self._buffer.append(m)  # type: ignore[arg-type]
        if len(self._buffer) > self._buffer_size:
            self._buffer.popleft()
            self.stats["iterator_dropped"] += 1
        self._wake.set()

    async def _send(self, message: dict[str, Any]) -> None:
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):  # the reader notices the closed connection and reconnects
                await ws.send(json.dumps(message, separators=(",", ":")))

    # ------------------------------------------------------------------------------------------------ subscriptions
    async def subscribe(self, channels: Channel | Sequence[Channel]) -> None:
        """Subscribes, and stays subscribed across reconnections. Returns when the server acknowledged every channel; raises
        the StreamError of the first refusal (`unknown_instrument`, `unsupported_channel`, `restricted`, `too_many_subscriptions`…)."""
        items = [dict(channels)] if isinstance(channels, Mapping) else [dict(c) for c in channels]
        loop = asyncio.get_running_loop()
        waits: list[asyncio.Future[None]] = []
        for c in items:
            key = channel_key(c)
            self._subs[key] = c
            f: asyncio.Future[None] = loop.create_future()
            self._pending.setdefault(key, []).append(f)
            waits.append(f)
        was_open = self.state == "open"
        await self.connect()
        if was_open:  # a connection that just opened already sent every subscription after its hello
            for i in range(0, len(items), 100):
                await self._send({"v": PROTOCOL_VERSION, "op": "subscribe", "channels": items[i : i + 100]})
        await asyncio.gather(*waits)

    async def unsubscribe(self, channels: Channel | Sequence[Channel]) -> None:
        items = [dict(channels)] if isinstance(channels, Mapping) else [dict(c) for c in channels]
        for c in items:
            self._subs.pop(channel_key(c), None)
        if self.state == "open":
            await self._send({"v": PROTOCOL_VERSION, "op": "unsubscribe", "channels": items})

    async def resync(self, channel: Channel) -> None:
        """Asks for the snapshot of a channel again (a book whose sequence broke)."""
        if self.state == "open":
            await self._send({"v": PROTOCOL_VERSION, "op": "subscribe", "channels": [dict(channel)]})

    def subscriptions(self) -> list[dict[str, Any]]:
        return list(self._subs.values())

    # ------------------------------------------------------------------------------------------------ iteration, closing
    def __aiter__(self) -> AsyncIterator[DataMessage]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[DataMessage]:
        """Every data message, in order, until `close()`. Bounded: when the consumer is slower than the feed the oldest
        messages leave (`stats["iterator_dropped"]`)."""
        while True:
            while self._buffer:
                yield self._buffer.popleft()
            if self.state == "closed":
                if self._error is not None and self._error.code != "closed":
                    raise self._error
                return
            self._wake.clear()
            await self._wake.wait()

    async def close(self) -> None:
        """Closes for good: no reconnection; `async for` loops end."""
        if self.state == "closed":
            return
        self.state = "closed"
        self._error = StreamError("closed", "the stream was closed")
        ws, task = self._ws, self._task
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close(1000, "client closed")
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if self._opened is not None and not self._opened.done():
            self._opened.set_exception(self._error)
            self._opened.exception()
        self._reject_pending(self._error)
        self._wake.set()

    async def __aenter__(self) -> SPWalletStream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

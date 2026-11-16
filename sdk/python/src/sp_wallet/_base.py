"""Everything the sync and the async client share: configuration, request preparation, and the retry decisions.

No I/O here. The clients send a prepared `Call`, then ask `transport_failed` / `answered` what to do: return a value,
wait and retry, or raise.

Retries (docs/sdk/python.md):
  GET            retried on a network error, a timeout, 429 (after Retry-After / RateLimit-Reset) and 502/503/504.
  POST / DELETE  carry an Idempotency-Key — generated ONCE per logical call when the caller gives none — and the body is
                 serialized ONCE: every retry sends the same key and the same bytes, so the server runs the operation at
                 most once. They are retried for that reason only. When no trustworthy answer was obtained the call
                 raises OutcomeUnknown (with the key): it is not a failure.
"""

from __future__ import annotations

import copy
import json
import os
import random
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from email.utils import parsedate_to_datetime
from typing import Any, TypeVar
from urllib.parse import quote, urlsplit

import httpx
import pydantic

from ._models_base import ApiModel, RateLimit, ResponseMeta
from ._util import IDEMPOTENCY_KEY_RE, canonical_json, decimal_str, new_idempotency_key, size_from_notional
from ._version import USER_AGENT
from .errors import (
    ConfigurationError,
    NetworkError,
    OutcomeUnknown,
    ServerError,
    TimeoutError,
    error_from_response,
    redact_deep,
    redact_secrets,
)

DEFAULT_BASE_URL = "https://wallet.spboucher.ai"
PREFIX = "/api/v1/trading"
RETRY_STATUS = frozenset({429, 502, 503, 504})
M = TypeVar("M", bound=ApiModel)
Self = TypeVar("Self", bound="BaseClient")


class _Secret:
    """Holds the API key so that it never appears in a repr, a str, `vars()` or a pickle."""

    __slots__ = ("__value",)

    def __init__(self, value: str) -> None:
        self.__value = value

    def reveal(self) -> str:
        return self.__value

    def __repr__(self) -> str:
        return "<redacted>"

    __str__ = __repr__

    def __reduce__(self) -> Any:
        raise TypeError("the API key is not serializable")


@dataclass
class Call:
    """One LOGICAL call: what is sent is fixed here, once, for every attempt."""

    method: str
    path: str  # full path, for messages
    url: str
    params: list[tuple[str, str]]
    content: bytes | None  # canonical JSON, serialized once
    idempotency_key: str | None
    timeout: float
    max_retries: int
    #: a mutating attempt ended without a definite answer: from then on only an answer computed under the key is trusted
    ambiguous: bool = field(default=False)

    @property
    def mutating(self) -> bool:
        return self.method != "GET"


@dataclass(frozen=True)
class Retry:
    delay: float


def _num(v: str | None) -> float | None:
    if v is None or not v.strip():
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _retry_after(headers: Mapping[str, str]) -> float | None:
    ra = headers.get("retry-after")
    if ra is not None:
        n = _num(ra)
        if n is not None:
            return max(0.0, n)
        try:
            return max(0.0, parsedate_to_datetime(ra).timestamp() - time.time())
        except (TypeError, ValueError):
            pass
    return _num(headers.get("ratelimit-reset"))


def seg(value: str, what: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"{what} is required")
    return quote(value, safe="")


class BaseClient:
    """Configuration and decisions shared by `SPWallet` and `AsyncSPWallet`."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        user_agent: str | None = None,
        allow_insecure_http: bool = False,
        send_timestamp: bool = False,
        max_retry_delay: float = 30.0,
        _random: Any = None,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("SP_WALLET_API_KEY")
        if not key or not isinstance(key, str):
            raise ConfigurationError("no API key: pass api_key=… or set SP_WALLET_API_KEY")
        if any(c.isspace() for c in key):
            raise ConfigurationError("the API key contains whitespace")
        self._key = _Secret(key)
        base = (base_url or os.environ.get("SP_WALLET_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        u = urlsplit(base)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ConfigurationError("base_url is not an http(s) URL")
        local = u.hostname in ("localhost", "127.0.0.1", "::1")
        if u.scheme != "https" and not (local or allow_insecure_http):
            raise ConfigurationError("base_url must be https:// (http:// is accepted for localhost only): the API key would travel in clear")
        if u.username or u.password:
            raise ConfigurationError("base_url must not carry credentials")
        if not (isinstance(timeout, (int, float)) and timeout > 0) or not (isinstance(max_retries, int) and max_retries >= 0):
            raise ConfigurationError("timeout must be positive and max_retries a non-negative integer")
        self.base_url = base
        self.timeout = float(timeout)
        self.max_retries = max_retries
        self.user_agent = f"{USER_AGENT} {user_agent}" if user_agent else USER_AGENT
        self._send_timestamp = send_timestamp
        self._max_retry_delay = float(max_retry_delay)
        self._random = _random or random.random
        self._owns_http = True

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self.base_url!r}, api_key=<redacted>)"

    def with_options(self: Self, *, timeout: float | None = None, max_retries: int | None = None) -> Self:
        """The same client with another timeout and/or number of retries, e.g. `client.with_options(max_retries=0).create_order(…)`.
        It shares the HTTP connections of the original (closing the copy does not close them)."""
        c = copy.copy(self)
        if timeout is not None:
            if not (isinstance(timeout, (int, float)) and timeout > 0):
                raise ConfigurationError("timeout must be positive")
            c.timeout = float(timeout)
        if max_retries is not None:
            if not (isinstance(max_retries, int) and max_retries >= 0):
                raise ConfigurationError("max_retries must be a non-negative integer")
            c.max_retries = max_retries
        c._owns_http = False
        return c

    # ------------------------------------------------------------------------------------------------------- preparation
    def _prepare(self, method: str, path: str, query: Mapping[str, Any] | None, body: Any, idempotency_key: str | None) -> Call:
        key: str | None = None
        if method != "GET":
            key = idempotency_key if idempotency_key is not None else new_idempotency_key()
            if not isinstance(key, str) or not IDEMPOTENCY_KEY_RE.match(key):
                raise ConfigurationError("idempotency_key must be 8 to 100 characters: letters, digits, . _ : -")
        params: list[tuple[str, str]] = []
        for k, v in (query or {}).items():
            if v is None:
                continue
            params.append((k, ("true" if v else "false") if isinstance(v, bool) else str(v)))
        content = None if body is None else canonical_json(body).encode("utf-8")  # serialized once: the same bytes on every attempt
        full = PREFIX + path
        return Call(method, full, self.base_url + full, params, content, key, self.timeout, self.max_retries)

    def _headers(self, call: Call) -> dict[str, str]:
        h = {"authorization": f"Bearer {self._key.reveal()}", "accept": "application/json", "user-agent": self.user_agent}
        if call.content is not None:
            h["content-type"] = "application/json"
        if call.idempotency_key is not None:
            h["idempotency-key"] = call.idempotency_key
            if self._send_timestamp:
                h["x-spw-timestamp"] = str(int(time.time()))
        return h

    def _safe(self, text: str) -> str:
        return redact_secrets(text, self._key.reveal())

    def _backoff(self, attempt: int) -> float:
        step = min(8.0, 0.5 * 2**attempt)
        return min(self._max_retry_delay, step / 2 + self._random() * (step / 2))

    def _unknown(self, call: Call, reason: str, status: int | None = None, request_id: str | None = None) -> OutcomeUnknown:
        assert call.idempotency_key is not None
        return OutcomeUnknown(idempotency_key=call.idempotency_key, method=call.method, path=call.path, reason=reason, status=status, request_id=request_id)

    # ------------------------------------------------------------------------------------------------------- decisions
    def _transport_failed(self, call: Call, attempt: int, exc: Exception) -> Retry:
        """No answer was received. Returns the wait before the next attempt, or raises."""
        timed_out = isinstance(exc, httpx.TimeoutException)
        why = f"no answer within {call.timeout:g} s" if timed_out else f"network error: {self._safe(type(exc).__name__ + ': ' + str(exc))}"
        if call.mutating:
            call.ambiguous = True
        if attempt < call.max_retries:
            return Retry(self._backoff(attempt))
        if call.mutating:
            raise self._unknown(call, why) from None
        cls = TimeoutError if timed_out else NetworkError
        raise cls(f"{call.method} {call.path}: {why}", code="timeout" if timed_out else "network_error") from None

    def _answered(self, call: Call, attempt: int, status: int, headers: Mapping[str, str], text: str) -> Retry | tuple[Any, ResponseMeta]:
        """An answer was received. Returns (decoded JSON object, meta), or the wait before a retry, or raises."""
        request_id = headers.get("x-request-id")
        parsed = True
        data: Any = None
        try:
            # a JSON number never becomes a binary float
            data = json.loads(text, parse_float=Decimal) if text else None
        except ValueError:
            parsed = False
        if 200 <= status < 300:
            if not parsed or not isinstance(data, dict):
                if call.mutating:
                    raise self._unknown(call, f"HTTP {status} with a body that is not a JSON object", status, request_id)
                what = f"{call.method} {call.path}: HTTP {status} with a body that is not a JSON object"
                raise ServerError(what, code="invalid_response", status=status, request_id=request_id)
            limit, remaining = _num(headers.get("ratelimit-limit")), _num(headers.get("ratelimit-remaining"))
            meta = ResponseMeta(
                status=status,
                request_id=request_id,
                idempotency_key=call.idempotency_key,
                idempotent_replay=headers.get("idempotent-replay") == "true",
                rate_limit=RateLimit(
                    None if limit is None else int(limit), None if remaining is None else int(remaining), _num(headers.get("ratelimit-reset"))
                ),
                attempts=attempt + 1,
            )
            return data, meta

        code = data["error"] if parsed and isinstance(data, dict) and isinstance(data.get("error"), str) else ""
        structured = bool(code) and not isinstance(data.get("statusCode"), int)  # an answer of the API itself, not of a proxy
        after = _retry_after(headers) if status in (429, 503) else None
        in_progress = call.mutating and status == 409 and code == "idempotency_in_progress"
        # the first request with this key is still running, or the answer does not come from the API: nothing definite is known
        if call.mutating and (in_progress or (status >= 500 and not (structured and status in (501, 503)))):
            call.ambiguous = True
        if (status in RETRY_STATUS or in_progress) and attempt < call.max_retries:
            wait = after if after is not None else self._backoff(attempt)
            if wait <= self._max_retry_delay:
                return Retry(wait)
        body = redact_deep(data, self._key.reveal()) if parsed else self._safe(text[:500])
        err = error_from_response(status, body, request_id=request_id, idempotency_key=call.idempotency_key, retry_after=after)
        # 401, 403 and 429 are decided before the server looks at the Idempotency-Key, and a 5xx says nothing either: after an
        # ambiguous attempt they do not tell whether that attempt was executed
        if call.mutating and call.ambiguous and (in_progress or status in (401, 403, 429) or (status >= 500 and status != 501)):
            reason = (
                "the first request with this key is still being processed"
                if in_progress
                else f"HTTP {status}{' ' + code if code else ''} after an attempt without an answer"
            )
            raise self._unknown(call, reason, status, request_id) from err
        raise err

    def _parse(self, model: type[M], data: Any, meta: ResponseMeta, call: Call) -> M:
        try:
            out = model.model_validate(data)
        except pydantic.ValidationError as e:
            problems = "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors(include_input=False)[:5])
            raise ServerError(
                f"{call.method} {call.path}: the answer does not match the contract ({problems})",
                code="invalid_response", status=meta.status, request_id=meta.request_id,
            ) from None  # fmt: skip
        out._meta = meta
        return out

    # ------------------------------------------------------------------------------------------------------- order bodies
    @staticmethod
    def _order_fields(
        *, instrument: str | None, exchange: str | None, symbol: str | None, size: Any, notional_usdc: Any, price: Any, trigger_price: Any
    ) -> tuple[str, str | None, str | None, str | None, str | None]:
        """→ (instrument, size, notional, price, trigger_price), all validated; exactly one of size / notional is set."""
        if instrument is not None and (exchange is not None or symbol is not None):
            raise ConfigurationError("give `instrument` or `exchange` + `symbol`, not both")
        inst = instrument or (f"{exchange}:{symbol}" if exchange and symbol else symbol)
        if not inst:
            raise ConfigurationError('an order needs `instrument` ("venue:symbol") or `exchange` + `symbol`')
        if (size is None) == (notional_usdc is None):
            raise ConfigurationError("an order needs exactly one of `size` (base units) and `notional_usdc`")
        return (
            inst,
            None if size is None else decimal_str(size, "size"),
            None if notional_usdc is None else decimal_str(notional_usdc, "notional_usdc"),
            None if price is None else decimal_str(price, "price"),
            None if trigger_price is None else decimal_str(trigger_price, "trigger_price"),
        )

    @staticmethod
    def _size_from_market(instrument: str, notional: str, price: str | None, market: Any) -> str:
        m = market.market
        lot = (market.instrument or {}).get("lotSize") if isinstance(market.instrument, dict) else None
        if m.stale or not m.mark:
            raise ConfigurationError(f"cannot size {instrument} from a notional: the market has no fresh mark price (stale: {m.stale}); pass `size`")
        size = size_from_notional(notional, price or m.mark, lot if isinstance(lot, str) and lot else "0.000001")
        if not any(c in "123456789" for c in size):
            raise ConfigurationError(f"a notional of {notional} is below one lot of {instrument}")
        return size

    @staticmethod
    def _body(model: type[pydantic.BaseModel], **fields: Any) -> dict[str, Any]:
        """Validates a request body locally with the constraints of the contract (pattern, enum, bounds)."""
        try:
            return model(**fields).to_body()  # type: ignore[attr-defined, no-any-return]
        except pydantic.ValidationError as e:
            problems = "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors(include_input=False)[:5])
            raise ConfigurationError(f"invalid {model.__name__}: {problems}") from None

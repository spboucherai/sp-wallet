"""Typed errors of the SDK.

Every error answer of the API is `{"error": "<code>", "message": "<sentence>"}`; the class is chosen from the HTTP status
and, where a code is more precise, from the code. No error ever carries the API key: messages come from the server body
or from this module, and `redact_secrets` is applied to everything that reaches a message or a stored body.
"""

from __future__ import annotations

import builtins
import re
from typing import Any

_KEY_RE = re.compile(r"spw_live_[A-Za-z0-9_-]+(<redacted>)?")
_BEARER_RE = re.compile(r"Bearer\s+(?!spw_live_<redacted>)[A-Za-z0-9._~+/=-]+", re.IGNORECASE)


def redact_secrets(text: str, api_key: str | None = None) -> str:
    """Removes anything that looks like an API key (`spw_live_…`) or a bearer header from a text."""
    if api_key:
        text = text.replace(api_key, "spw_live_<redacted>")
    return _BEARER_RE.sub("Bearer <redacted>", _KEY_RE.sub("spw_live_<redacted>", text))


def redact_deep(value: Any, api_key: str | None = None) -> Any:
    if isinstance(value, str):
        return redact_secrets(value, api_key)
    if isinstance(value, list):
        return [redact_deep(v, api_key) for v in value]
    if isinstance(value, dict):
        return {k: redact_deep(v, api_key) for k, v in value.items()}
    return value


class SPWalletError(Exception):
    """Base class of everything this SDK raises.

    code             stable machine code: the API's `error` member, or an SDK code (`network_error`, `timeout`, …)
    status           HTTP status, or None when no answer was received
    request_id       `X-Request-Id` of the answer (the wallet's owner finds the call in the usage log with it)
    idempotency_key  the `Idempotency-Key` sent with a mutating call
    body             decoded JSON body of the error answer
    """

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int | None = None,
        request_id: str | None = None,
        idempotency_key: str | None = None,
        body: Any = None,
    ) -> None:
        self.message = redact_secrets(message)
        super().__init__(self.message)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.idempotency_key = idempotency_key
        self.body = body

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status={self.status!r}, request_id={self.request_id!r}, message={self.message!r})"


class ConfigurationError(SPWalletError):
    """The client was built or called wrongly (no key, an http:// base URL, a float where a decimal is required…)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="configuration")


class APIError(SPWalletError):
    """The API answered with an error status."""


class ValidationError(APIError):
    """400 (`bad_request`, `idempotency`, `stale_request`) and 422 (`no_orderbook`, `venue_rejected`)."""


class AuthenticationError(APIError):
    """401 `unauthenticated`: missing, malformed, unknown, expired or revoked key."""


class PermissionDenied(APIError):
    """403."""


class ScopeDenied(PermissionDenied):
    """403 `insufficient_scope` (also `scope_denied`, `scope_undeclared`): the key does not hold the operation's scope."""


class MandateRequired(PermissionDenied):
    """403 `mandate_required`: execution needs a key bound to an owner-approved trading mandate; this key has none."""


class NotFound(APIError):
    """404."""


class Conflict(APIError):
    """409."""


class IdempotencyConflict(Conflict):
    """409 `idempotency_conflict`: this Idempotency-Key was already used with a different request."""


class AmbiguousSymbol(Conflict):
    """409 `ambiguous_symbol`: a bare symbol exists on several venues; `candidates` lists the `venue:symbol` ids."""

    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message, **kw)
        c = self.body.get("candidates") if isinstance(self.body, dict) else None
        self.candidates: list[str] = [x for x in c if isinstance(x, str)] if isinstance(c, list) else []


class RateLimited(APIError):
    """429 `rate_limited` / `auth_throttled`; `retry_after` (seconds) from `Retry-After`, else `RateLimit-Reset`."""

    def __init__(self, message: str, *, retry_after: float | None = None, **kw: Any) -> None:
        super().__init__(message, **kw)
        self.retry_after = retry_after


class NotImplementedError(APIError):
    """501: the operation is declared by the API but not connected. Nothing was done. Never a success."""


class ExecutionNotWired(NotImplementedError):
    """501 `execution_not_wired`."""


class ServerError(APIError):
    """5xx, or an answer that is not what the contract says."""


class ServiceUnavailable(ServerError):
    """503 with an API code (`signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`, …)."""


class NetworkError(SPWalletError):
    """No answer: DNS, connection, TLS, reset."""


class TimeoutError(NetworkError):
    """No answer within the timeout."""


class OutcomeUnknown(SPWalletError):
    """A MUTATING call ended without a trustworthy answer (timeout, connection lost, gateway error, or the first request
    with this key is still running). The operation may or may not have been executed. This is NOT a failure:

    * re-send the SAME call with `idempotency_key=error.idempotency_key` (the server returns the stored answer if it
      ran, or runs it once), or
    * read the object (`get_order`, `list_orders`, `get_positions`) to learn what happened.

    Never re-send with a NEW key: that could execute the operation twice.
    """

    def __init__(self, *, idempotency_key: str, method: str, path: str, reason: str, status: int | None = None, request_id: str | None = None) -> None:
        super().__init__(
            f"outcome unknown for {method} {path} ({reason}): the operation may or may not have been executed. Re-send the same call "
            f'with idempotency_key="{idempotency_key}" or read the object; do not retry with a new key.',
            code="outcome_unknown",
            status=status,
            request_id=request_id,
            idempotency_key=idempotency_key,
        )
        self.method = method
        self.path = path


class WaitTimeout(SPWalletError):
    """`wait_for_order` reached its timeout before the order was final. The order has NOT failed: `last` is its last known state."""

    def __init__(self, message: str, last: Any) -> None:
        super().__init__(message, code="wait_timeout")
        self.last = last


class WebhookVerificationError(SPWalletError):
    """A webhook did not verify (bad signature, timestamp outside the tolerance, malformed header)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="webhook_verification")


_SCOPE_CODES = {"insufficient_scope", "scope_denied", "scope_undeclared"}


def error_from_response(
    status: int,
    body: Any,
    *,
    request_id: str | None = None,
    idempotency_key: str | None = None,
    retry_after: float | None = None,
) -> APIError:
    """HTTP status + `error` code → the typed error."""
    b = body if isinstance(body, dict) else {}
    # Fastify's own answers (unknown route, malformed JSON) are {statusCode, error: "Not Found", message}: no stable code there
    fastify = isinstance(b.get("statusCode"), int)
    code = b["error"] if isinstance(b.get("error"), str) and not fastify else f"http_{status}"
    message = b["message"] if isinstance(b.get("message"), str) and b["message"] else f"HTTP {status}"
    text = f"{message} [{code}, HTTP {status}{f', request {request_id}' if request_id else ''}]"
    kw: dict[str, Any] = {"code": code, "status": status, "request_id": request_id, "idempotency_key": idempotency_key, "body": body}
    cls: type[APIError]
    if status in (400, 422):
        cls = ValidationError
    elif status == 401:
        cls = AuthenticationError
    elif status == 403:
        cls = MandateRequired if code == "mandate_required" else ScopeDenied if code in _SCOPE_CODES else PermissionDenied
    elif status == 404:
        cls = NotFound
    elif status == 409:
        cls = IdempotencyConflict if code == "idempotency_conflict" else AmbiguousSymbol if code == "ambiguous_symbol" else Conflict
    elif status == 429:
        return RateLimited(text, retry_after=retry_after, **kw)
    elif status == 501:
        cls = ExecutionNotWired if code == "execution_not_wired" else NotImplementedError
    elif status == 503:
        cls = ServiceUnavailable
    elif status >= 500:
        cls = ServerError
    else:
        cls = APIError
    return cls(text, **kw)


__all__ = [
    "APIError", "AmbiguousSymbol", "AuthenticationError", "ConfigurationError", "Conflict", "ExecutionNotWired", "IdempotencyConflict",
    "MandateRequired", "NetworkError", "NotFound", "NotImplementedError", "OutcomeUnknown", "PermissionDenied", "RateLimited",
    "SPWalletError", "ScopeDenied", "ServerError", "ServiceUnavailable", "TimeoutError", "ValidationError", "WaitTimeout",
    "WebhookVerificationError", "error_from_response", "redact_deep", "redact_secrets",
]  # fmt: skip

# the builtins of the same names stay reachable for this module's own code
_BuiltinTimeoutError = builtins.TimeoutError

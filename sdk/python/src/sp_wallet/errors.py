# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/src/sp_wallet/errors.py
# Description      : Typed errors of the SDK.
# Module           : sp_wallet
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

"""Typed errors of the SDK.

Every error answer of the API is `{"error": "<code>", "message": "<sentence>"}`; the class is chosen from the HTTP status
and, where a code is more precise, from the code. No error ever carries the API key: messages come from the server body
or from this module, and `redact_secrets` is applied to everything that reaches a message or a stored body.
"""

from __future__ import annotations

import builtins
import re
from typing import Any

import pydantic

from .models import Order, RiskCheck

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
    order            the order a refusal is about, when the server created one before it refused (`data.order`: state
                     REJECTED or FAILED); None when the call was refused before any order existed — nothing was created
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
        self.order: Order | None = _order_of(body)

    @property
    def data(self) -> dict[str, Any]:
        """`data` of the error body — the machine-readable detail of a refusal — as a dict (empty when absent)."""
        d = self.body.get("data") if isinstance(self.body, dict) else None
        return d if isinstance(d, dict) else {}

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status={self.status!r}, request_id={self.request_id!r}, message={self.message!r})"


def _order_of(body: Any) -> Order | None:
    d = body.get("data") if isinstance(body, dict) else None
    o = d.get("order") if isinstance(d, dict) else None
    if not isinstance(o, dict):
        return None
    try:
        return Order.model_validate(o)
    except pydantic.ValidationError:
        return None  # an order this SDK cannot read is not invented: the raw answer stays in `body`


def _strings(v: Any) -> list[str]:
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


class ConfigurationError(SPWalletError):
    """The client was built or called wrongly (no key, an http:// base URL, a float where a decimal is required…)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="configuration")


class APIError(SPWalletError):
    """The API answered with an error status."""


class ValidationError(APIError):
    """400 (`bad_request`, `invalid_order`, `idempotency`, `stale_request`, …) and 422 (`no_orderbook`, `venue_rejected`,
    `below_min_size`, a refusal of the venue engine's own rules, …). When the order existed, it is in `order`."""


class AuthenticationError(APIError):
    """401 `unauthenticated`: missing, malformed, unknown, expired or revoked key."""


class PermissionDenied(APIError):
    """403."""


class ScopeDenied(PermissionDenied):
    """403 `insufficient_scope` (also `scope_denied`, `scope_undeclared`): the key does not hold the operation's scope."""


class MandateRequired(PermissionDenied):
    """403 `mandate_required`: execution needs a key bound to an owner-approved trading mandate; this key has none."""


class ExecutionDisabled(PermissionDenied):
    """403 `execution_disabled`: live execution through the trading API is closed on this server
    (`SPW_TRADING_API_EXECUTION` is not `on`). Nothing was created. Paper orders, cancels and strictly reducing orders
    are not affected."""


class MandateDenied(PermissionDenied):
    """403 `mandate_denied` (the order is outside the trading mandate bound to the key) or `mandate_not_approved`.
    `reasons` are the mandate's own codes (`models.MANDATE_DENY_REASONS`: `ORDER_NOTIONAL_EXCEEDED`,
    `INSTRUMENT_NOT_ALLOWED`, …); `order` is the REJECTED order."""

    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message, **kw)
        self.reasons: list[str] = _strings(self.data.get("reasons"))


class RiskDenied(APIError):
    """422 `risk_denied`, 423 `kill_switch_active` / `read_only_mode`: the independent risk engine refused the order.
    `failed` are the ids of the failed checks (`models.RISK_CHECK_IDS`), `checks` the failed checks with what was
    observed and their limit, `order` the REJECTED order. With the kill switch on, cancels and strictly reducing orders
    still pass."""

    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message, **kw)
        self.failed: list[str] = _strings(self.data.get("failed"))
        self.checks: list[RiskCheck] = []
        for c in self.data.get("checks") if isinstance(self.data.get("checks"), list) else []:
            try:
                self.checks.append(RiskCheck.model_validate(c))
            except pydantic.ValidationError:
                continue

    @property
    def kill_switch(self) -> bool:
        """True when the refusal is the global kill switch (423 `kill_switch_active`)."""
        return self.code == "kill_switch_active"


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


class AmbiguousCommand(Conflict):
    """409 `ambiguous_command`: the command and the owner's stored defaults do not settle everything. Nothing was
    executed. `questions` says what is open: each is `{"field", "options", "message"}`."""

    def __init__(self, message: str, **kw: Any) -> None:
        super().__init__(message, **kw)
        q = self.data.get("questions")
        self.questions: list[dict[str, Any]] = [
            {"field": x["field"], "options": _strings(x.get("options")), "message": x["message"] if isinstance(x.get("message"), str) else ""}
            for x in (q if isinstance(q, list) else [])
            if isinstance(x, dict) and isinstance(x.get("field"), str)
        ]


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
_RISK_CODES = {"risk_denied", "kill_switch_active", "read_only_mode"}
_MANDATE_DENIED_CODES = {"mandate_denied", "mandate_not_approved"}


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
    if status == 423 or (status == 422 and code in _RISK_CODES):
        cls = RiskDenied
    elif status in (400, 422):
        cls = ValidationError
    elif status == 401:
        cls = AuthenticationError
    elif status == 403:
        cls = (
            MandateRequired if code == "mandate_required"
            else MandateDenied if code in _MANDATE_DENIED_CODES
            else ExecutionDisabled if code == "execution_disabled"
            else ScopeDenied if code in _SCOPE_CODES
            else PermissionDenied
        )  # fmt: skip
    elif status == 404:
        cls = NotFound
    elif status == 409:
        cls = (
            IdempotencyConflict if code == "idempotency_conflict"
            else AmbiguousSymbol if code == "ambiguous_symbol"
            else AmbiguousCommand if code == "ambiguous_command"
            else Conflict
        )  # fmt: skip
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
    "APIError", "AmbiguousCommand", "AmbiguousSymbol", "AuthenticationError", "ConfigurationError", "Conflict", "ExecutionDisabled",
    "ExecutionNotWired", "IdempotencyConflict", "MandateDenied", "MandateRequired", "NetworkError", "NotFound", "NotImplementedError",
    "OutcomeUnknown", "PermissionDenied", "RateLimited", "RiskDenied", "SPWalletError", "ScopeDenied", "ServerError", "ServiceUnavailable",
    "TimeoutError", "ValidationError", "WaitTimeout",
    "WebhookVerificationError", "error_from_response", "redact_deep", "redact_secrets",
]  # fmt: skip

# the builtins of the same names stay reachable for this module's own code
_BuiltinTimeoutError = builtins.TimeoutError

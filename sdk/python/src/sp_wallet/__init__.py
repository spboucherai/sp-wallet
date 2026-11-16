"""sp_wallet — official Python client of the SP Wallet Trading API.

    from sp_wallet import SPWallet

    client = SPWallet(api_key="spw_live_…")        # or the environment variable SP_WALLET_API_KEY
    client.get_balances()
    client.get_positions()
    client.preview_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)
    client.create_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)   # paper by default

`AsyncSPWallet` is the same client on asyncio. Documentation: docs/sdk/python.md.
"""

from . import models
from ._async_client import AsyncSPWallet
from ._base import DEFAULT_BASE_URL
from ._client import SPWallet
from ._models_base import ApiModel, RateLimit, RequestModel, ResponseMeta, WriteResult
from ._util import (
    DECIMAL_RE,
    IDEMPOTENCY_KEY_RE,
    ORDER_STATES,
    TERMINAL_ORDER_STATES,
    canonical_json,
    decimal_str,
    is_terminal_order,
    new_idempotency_key,
    order_state,
    to_decimal,
)
from ._version import USER_AGENT, __version__
from .errors import (
    AmbiguousCommand,
    AmbiguousSymbol,
    APIError,
    AuthenticationError,
    ConfigurationError,
    Conflict,
    ExecutionDisabled,
    ExecutionNotWired,
    IdempotencyConflict,
    MandateDenied,
    MandateRequired,
    NetworkError,
    NotFound,
    NotImplementedError,
    OutcomeUnknown,
    PermissionDenied,
    RateLimited,
    RiskDenied,
    ScopeDenied,
    ServerError,
    ServiceUnavailable,
    SPWalletError,
    TimeoutError,
    ValidationError,
    WaitTimeout,
    WebhookVerificationError,
    error_from_response,
    redact_secrets,
)
from .models import API_VERSION, EXECUTION_SCOPES, MANDATE_DENY_REASONS, OPERATION_ERRORS, OPERATIONS, RISK_CHECK_IDS, SCOPES, WEBHOOK_EVENTS
from .webhooks import WEBHOOK_TOLERANCE_SECONDS, construct_webhook_event, verify_webhook, webhook_signature

#: the streaming client (sp_wallet.stream) is loaded on first use: `import sp_wallet` stays light, and works on a base install —
#: the optional dependency `websockets` (pip install "sp-wallet-python[stream]") is needed only to CONNECT a stream
_STREAM_NAMES = ("SPWalletStream", "OrderBook", "StreamError", "book_checksum", "channel_key")


def __getattr__(name: str) -> object:
    if name == "stream" or name in _STREAM_NAMES:
        import importlib

        module = importlib.import_module(".stream", __name__)
        return module if name == "stream" else getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted([*globals(), "stream", *_STREAM_NAMES])


__all__ = [
    "API_VERSION",
    "DECIMAL_RE",
    "DEFAULT_BASE_URL",
    "EXECUTION_SCOPES",
    "IDEMPOTENCY_KEY_RE",
    "MANDATE_DENY_REASONS",
    "OPERATIONS",
    "OPERATION_ERRORS",
    "ORDER_STATES",
    "RISK_CHECK_IDS",
    "SCOPES",
    "TERMINAL_ORDER_STATES",
    "USER_AGENT",
    "WEBHOOK_EVENTS",
    "WEBHOOK_TOLERANCE_SECONDS",
    "APIError",
    "AmbiguousCommand",
    "AmbiguousSymbol",
    "ApiModel",
    "AsyncSPWallet",
    "AuthenticationError",
    "ConfigurationError",
    "Conflict",
    "ExecutionDisabled",
    "ExecutionNotWired",
    "IdempotencyConflict",
    "MandateDenied",
    "MandateRequired",
    "NetworkError",
    "NotFound",
    "NotImplementedError",
    "OrderBook",
    "OutcomeUnknown",
    "PermissionDenied",
    "RateLimit",
    "RateLimited",
    "RequestModel",
    "ResponseMeta",
    "RiskDenied",
    "SPWallet",
    "SPWalletError",
    "SPWalletStream",
    "ScopeDenied",
    "ServerError",
    "ServiceUnavailable",
    "StreamError",
    "TimeoutError",
    "ValidationError",
    "WaitTimeout",
    "WebhookVerificationError",
    "WriteResult",
    "__version__",
    "book_checksum",
    "canonical_json",
    "channel_key",
    "construct_webhook_event",
    "decimal_str",
    "error_from_response",
    "is_terminal_order",
    "models",
    "new_idempotency_key",
    "order_state",
    "redact_secrets",
    "stream",
    "to_decimal",
    "verify_webhook",
    "webhook_signature",
]  # fmt: skip

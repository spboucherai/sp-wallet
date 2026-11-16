"""sp_wallet — official Python client of the SP Wallet Trading API.

    from sp_wallet import SPWallet

    client = SPWallet(api_key="spw_live_…")        # or the environment variable SP_WALLET_API_KEY
    client.get_balances()
    client.get_positions()
    client.preview_order(exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional_usdc=100)

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
    size_from_notional,
    to_decimal,
)
from ._version import USER_AGENT, __version__
from .errors import (
    AmbiguousSymbol,
    APIError,
    AuthenticationError,
    ConfigurationError,
    Conflict,
    ExecutionNotWired,
    IdempotencyConflict,
    MandateRequired,
    NetworkError,
    NotFound,
    NotImplementedError,
    OutcomeUnknown,
    PermissionDenied,
    RateLimited,
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
from .models import API_VERSION, EXECUTION_SCOPES, OPERATIONS, SCOPES, WEBHOOK_EVENTS
from .webhooks import WEBHOOK_TOLERANCE_SECONDS, construct_webhook_event, verify_webhook, webhook_signature

__all__ = [
    "API_VERSION", "DECIMAL_RE", "DEFAULT_BASE_URL", "EXECUTION_SCOPES", "IDEMPOTENCY_KEY_RE", "OPERATIONS", "ORDER_STATES", "SCOPES",
    "TERMINAL_ORDER_STATES", "USER_AGENT", "WEBHOOK_EVENTS", "WEBHOOK_TOLERANCE_SECONDS",
    "APIError", "AmbiguousSymbol", "ApiModel", "AsyncSPWallet", "AuthenticationError", "ConfigurationError", "Conflict",
    "ExecutionNotWired", "IdempotencyConflict", "MandateRequired", "NetworkError", "NotFound", "NotImplementedError", "OutcomeUnknown",
    "PermissionDenied", "RateLimit", "RateLimited", "RequestModel", "ResponseMeta", "SPWallet", "SPWalletError", "ScopeDenied",
    "ServerError", "ServiceUnavailable", "TimeoutError", "ValidationError", "WaitTimeout", "WebhookVerificationError", "WriteResult",
    "__version__", "canonical_json", "construct_webhook_event", "decimal_str", "error_from_response", "is_terminal_order", "models",
    "new_idempotency_key", "order_state", "redact_secrets", "size_from_notional", "to_decimal", "verify_webhook", "webhook_signature",
]  # fmt: skip

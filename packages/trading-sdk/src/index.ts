// @sp-wallet/trading-sdk — official TypeScript client of the SP Wallet Trading API.
export { SPWallet, DEFAULT_BASE_URL, responseMeta, type SPWalletOptions, type RequestOptions, type WriteOptions, type WaitOptions, type PageOptions, type CommandOptions, type OrderInput, type WriteResult, type ResponseMeta, type RateLimitInfo,
  type OrderPreview, type PlacedOrder, type CancelledOrder, type CommandResult, type KillSwitchResult, type ActivityItem } from './client.ts';
export { SPWalletError, ConfigurationError, APIError, ValidationError, AuthenticationError, PermissionDenied, ScopeDenied, MandateRequired, MandateDenied, ExecutionDisabled, RiskDenied, NotFound, Conflict, IdempotencyConflict, AmbiguousSymbol, AmbiguousCommand,
  RateLimited, NotImplementedError, ExecutionNotWired, ServerError, ServiceUnavailable, NetworkError, TimeoutError, OutcomeUnknown, WaitTimeout, WebhookVerificationError, errorFromResponse, redactSecrets,
  type ErrorDetails, type CommandQuestion } from './errors.ts';
export { canonicalJson, newIdempotencyKey, IDEMPOTENCY_KEY_RE, DECIMAL_RE, isDecimalString, decimalString, TERMINAL_ORDER_STATES, orderState, isTerminalOrder } from './util.ts';
export { verifyWebhook, constructWebhookEvent, webhookSignature, timingSafeEqual, WEBHOOK_TOLERANCE_SECONDS, type WebhookInput, type WebhookEvent } from './webhooks.ts';
export { SDK_VERSION, USER_AGENT } from './version.ts';
export { API_VERSION, SCOPES, EXECUTION_SCOPES, WEBHOOK_EVENTS, OPERATIONS, OPERATION_ERRORS, ORDER_STATES, FINAL_ORDER_STATES, MANDATE_DENY_REASONS, RISK_CHECK_IDS, type Scope, type WebhookEventName, type OperationId, type ApiErrorBody,
  type OrderState, type Order, type CanonicalOrder, type RiskCheck } from './generated/openapi.ts';
export type * from './generated/openapi.ts';

// @sp-wallet/trading-sdk — official TypeScript client of the SP Wallet Trading API.
export { SPWallet, DEFAULT_BASE_URL, responseMeta, type SPWalletOptions, type RequestOptions, type WriteOptions, type WaitOptions, type OrderInput, type WriteResult, type ResponseMeta, type RateLimitInfo } from './client.ts';
export { SPWalletError, ConfigurationError, APIError, ValidationError, AuthenticationError, PermissionDenied, ScopeDenied, MandateRequired, NotFound, Conflict, IdempotencyConflict, AmbiguousSymbol,
  RateLimited, NotImplementedError, ExecutionNotWired, ServerError, ServiceUnavailable, NetworkError, TimeoutError, OutcomeUnknown, WaitTimeout, WebhookVerificationError, errorFromResponse, redactSecrets,
  type ErrorDetails } from './errors.ts';
export { canonicalJson, newIdempotencyKey, IDEMPOTENCY_KEY_RE, DECIMAL_RE, isDecimalString, decimalString, sizeFromNotional, ORDER_STATES, TERMINAL_ORDER_STATES, orderState, isTerminalOrder, type OrderState } from './util.ts';
export { verifyWebhook, constructWebhookEvent, webhookSignature, timingSafeEqual, WEBHOOK_TOLERANCE_SECONDS, type WebhookInput, type WebhookEvent } from './webhooks.ts';
export { SDK_VERSION, USER_AGENT } from './version.ts';
export { API_VERSION, SCOPES, EXECUTION_SCOPES, WEBHOOK_EVENTS, OPERATIONS, type Scope, type WebhookEventName, type OperationId, type ApiErrorBody } from './generated/openapi.ts';
export type * from './generated/openapi.ts';

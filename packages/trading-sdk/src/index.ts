/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/src/index.ts
 * Module           : trading-sdk
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// @sp-wallet/trading-sdk — official TypeScript client of the SP Wallet Trading API.
export { SPWallet, DEFAULT_BASE_URL, responseMeta, type SPWalletOptions, type RequestOptions, type WriteOptions, type WaitOptions, type PageOptions, type CommandOptions, type AgentMode, type AgentPageQuery, type OrderInput, type WriteResult, type ResponseMeta, type RateLimitInfo,
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
// live market data over a websocket (the quote engine): quotes, order books, trades, candles, venue statuses — read-only
export { SPWalletStream, StreamError, OrderBook, bookChecksum, channelKey, STREAM_PROTOCOL_VERSION, STREAM_PATH, STREAM_TICKET_PATH, type StreamOptions, type StreamState, type StreamChannel, type StreamChannelType,
  type StreamDataMessage, type StreamServerMessage, type QuoteMessage, type BookMessage, type TradeMessage, type CandleMessage, type StatusMessage, type DroppedMessage, type StreamErrorMessage, type SubscribedMessage,
  type HelloMessage, type BookLevel, type WebSocketLike, type WebSocketCtor } from './stream.ts';

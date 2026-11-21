/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/src/errors.ts
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

// Typed errors of the SDK. Every error answer of the API is `{ "error": "<code>", "message": "<sentence>" }`; the class is
// chosen from the HTTP status and, where a code is more precise, from the code. No error ever carries the API key: messages
// come from the server body or from this file, and `redactSecrets` is applied to everything that reaches a message.

/** removes anything that looks like an API key (`spw_live_…`) or a bearer header from a text */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('spw_live_<redacted>');
  return out.replace(/spw_live_[A-Za-z0-9_-]+(<redacted>)?/g, 'spw_live_<redacted>').replace(/Bearer\s+(?!spw_live_<redacted>)[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
}

import type { Order, RiskCheck } from './generated/openapi.ts';

/** one question of an ambiguous command: what the command and the owner's defaults leave open */
export interface CommandQuestion { field: string; options: string[]; message: string }
export interface ErrorDetails {
  /** stable machine code: the API's `error` member, or an SDK code (`network_error`, `timeout`, `outcome_unknown`, …) */
  code: string;
  /** HTTP status, or null when no answer was received */
  status: number | null;
  /** `X-Request-Id` of the answer (give it to the wallet's owner to find the call in the usage log) */
  requestId?: string | null;
  /** the `Idempotency-Key` sent with a mutating call */
  idempotencyKey?: string | null;
  /** decoded JSON body of the error answer */
  body?: unknown;
  cause?: unknown;
}

/** base class of everything this SDK throws */
export class SPWalletError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
  /** The order a refusal is about, when the server created one before it refused (`data.order`: state REJECTED or FAILED).
   *  null when the call was refused before any order existed — nothing was created. */
  readonly order: Order | null;
  constructor(message: string, d: ErrorDetails) {
    super(redactSecrets(message), d.cause === undefined ? undefined : { cause: d.cause });
    this.name = new.target.name;
    this.code = d.code; this.status = d.status; this.requestId = d.requestId ?? null; this.idempotencyKey = d.idempotencyKey ?? null; this.body = d.body;
    const o = dataOf(d.body).order;
    this.order = o !== null && typeof o === 'object' && typeof (o as { id?: unknown }).id === 'string' ? (o as Order) : null;
  }
}
/** `data` of an error body, as an object (empty when absent) */
const dataOf = (body: unknown): Record<string, unknown> => { const d = (body as { data?: unknown } | null | undefined)?.data; return d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : {}; };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** the client was built or called wrongly (no key, an http:// base URL, a float where a decimal string is required) */
export class ConfigurationError extends SPWalletError { constructor(message: string) { super(message, { code: 'configuration', status: null }); } }

/** the API answered with an error status */
export class APIError extends SPWalletError {}
/** 400 (`bad_request`, `invalid_order`, `idempotency`, `stale_request`, …) and 422 (`no_orderbook`, `venue_rejected`,
 *  `below_min_size`, a refusal of the venue engine's own rules, …). When the order existed, it is in `order`. */
export class ValidationError extends APIError {}
/** 401 `unauthenticated`: missing, malformed, unknown, expired or revoked key */
export class AuthenticationError extends APIError {}
/** 403 */
export class PermissionDenied extends APIError {}
/** 403 `insufficient_scope` (also `scope_denied`, `scope_undeclared`): the key does not hold the scope of the operation */
export class ScopeDenied extends PermissionDenied {}
/** 403 `mandate_required`: execution needs a key bound to an owner-approved trading mandate; this key has none */
export class MandateRequired extends PermissionDenied {}
/** 403 `execution_disabled`: live execution through the trading API is closed on this server (`SPW_TRADING_API_EXECUTION` is not
 *  `on`). Nothing was created. Paper orders, cancels and strictly reducing orders are not affected. */
export class ExecutionDisabled extends PermissionDenied {}
/** 403 `mandate_denied` (the order is outside the trading mandate bound to the key) or `mandate_not_approved`. `reasons`
 *  are the mandate's own codes (`MANDATE_DENY_REASONS`: `ORDER_NOTIONAL_EXCEEDED`, `INSTRUMENT_NOT_ALLOWED`, …); `order` is
 *  the REJECTED order. */
export class MandateDenied extends PermissionDenied {
  readonly reasons: string[];
  constructor(message: string, d: ErrorDetails) { super(message, d); this.reasons = strings(dataOf(d.body).reasons); }
}
/** 422 `risk_denied`, 423 `kill_switch_active` / `read_only_mode`: the independent risk engine refused the order.
 *  `failed` are the ids of the failed checks (`RISK_CHECK_IDS`), `checks` the failed checks with what was observed and
 *  their limit, `order` the REJECTED order. With the kill switch on, cancels and strictly reducing orders still pass. */
export class RiskDenied extends APIError {
  readonly failed: string[];
  readonly checks: RiskCheck[];
  constructor(message: string, d: ErrorDetails) {
    super(message, d);
    const data = dataOf(d.body);
    this.failed = strings(data.failed);
    this.checks = Array.isArray(data.checks) ? data.checks.filter((c): c is RiskCheck => c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') : [];
  }
  /** true when the refusal is the global kill switch (423 `kill_switch_active`) */
  get killSwitch(): boolean { return this.code === 'kill_switch_active'; }
}
/** 404 */
export class NotFound extends APIError {}
/** 409 */
export class Conflict extends APIError {}
/** 409 `idempotency_conflict`: this Idempotency-Key was already used with a different request */
export class IdempotencyConflict extends Conflict {}
/** 409 `ambiguous_symbol`: a bare symbol exists on several venues; `candidates` lists the `venue:symbol` ids */
export class AmbiguousSymbol extends Conflict {
  readonly candidates: string[];
  constructor(message: string, d: ErrorDetails) {
    super(message, d);
    const c = (d.body as { candidates?: unknown } | null | undefined)?.candidates;
    this.candidates = Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [];
  }
}
/** 409 `ambiguous_command`: the command and the owner's stored defaults do not settle everything. Nothing was executed.
 *  `questions` says what is open (venue, leverage, …) and the candidates. */
export class AmbiguousCommand extends Conflict {
  readonly questions: CommandQuestion[];
  constructor(message: string, d: ErrorDetails) {
    super(message, d);
    const q = dataOf(d.body).questions;
    this.questions = Array.isArray(q) ? q.filter((x): x is CommandQuestion => x !== null && typeof x === 'object' && typeof (x as { field?: unknown }).field === 'string')
      .map((x) => ({ field: x.field, options: strings(x.options), message: typeof x.message === 'string' ? x.message : '' })) : [];
  }
}
/** 429 `rate_limited` / `auth_throttled`; `retryAfterSeconds` from `Retry-After`, else `RateLimit-Reset` */
export class RateLimited extends APIError {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, d: ErrorDetails & { retryAfterSeconds?: number | null }) { super(message, d); this.retryAfterSeconds = d.retryAfterSeconds ?? null; }
}
/** 501: the operation is declared by the API but not connected. Nothing was done. Never a success. */
export class NotImplementedError extends APIError {}
/** 501 `execution_not_wired` */
export class ExecutionNotWired extends NotImplementedError {}
/** 5xx */
export class ServerError extends APIError {}
/** 503 with an API code (`signer_unreachable`, `venue_unavailable`, `markets_unavailable`, `stale_data`, …) */
export class ServiceUnavailable extends ServerError {}

/** no answer: DNS, connection, TLS, reset */
export class NetworkError extends SPWalletError {}
/** no answer within the timeout */
export class TimeoutError extends NetworkError {}

/**
 * A MUTATING call ended without a trustworthy answer (timeout, connection lost, gateway error, or the first request with
 * this key is still running). The operation may or may not have been executed. This is NOT a failure:
 *  - re-send the SAME call with `idempotencyKey` (the server returns the stored answer if it ran, or runs it once), or
 *  - read the object (`getOrder`, `listOrders`, `getPositions`) to learn what happened.
 * Never re-send with a NEW key: that could execute the operation twice.
 */
export class OutcomeUnknown extends SPWalletError {
  readonly method: string;
  readonly path: string;
  constructor(d: { idempotencyKey: string; method: string; path: string; status?: number | null; requestId?: string | null; cause?: unknown; reason: string }) {
    super(`outcome unknown for ${d.method} ${d.path} (${d.reason}): the operation may or may not have been executed. Re-send the same call with idempotencyKey ` +
      `"${d.idempotencyKey}" or read the object; do not retry with a new key.`, { code: 'outcome_unknown', status: d.status ?? null, requestId: d.requestId, idempotencyKey: d.idempotencyKey, cause: d.cause });
    this.method = d.method; this.path = d.path;
  }
}
/** `waitForOrder` reached its timeout before the order was final. The order is not failed: `last` is its last known state. */
export class WaitTimeout extends SPWalletError {
  readonly last: unknown;
  constructor(message: string, last: unknown) { super(message, { code: 'wait_timeout', status: null }); this.last = last; }
}
/** a webhook did not verify (bad signature, timestamp outside the tolerance, malformed header) */
export class WebhookVerificationError extends SPWalletError { constructor(message: string) { super(message, { code: 'webhook_verification', status: null }); } }

const SCOPE_CODES = new Set(['insufficient_scope', 'scope_denied', 'scope_undeclared']);
const RISK_CODES = new Set(['risk_denied', 'kill_switch_active', 'read_only_mode']);
/** HTTP status + `error` code → the typed error (exported for tests and for callers that proxy the API) */
export function errorFromResponse(status: number, body: unknown, o: { requestId?: string | null; idempotencyKey?: string | null; retryAfterSeconds?: number | null } = {}): APIError {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown; statusCode?: unknown };
  // Fastify's own answers (unknown route, malformed JSON) are { statusCode, error: "Not Found", message }: no stable code there
  const fastify = typeof b.statusCode === 'number';
  const code = typeof b.error === 'string' && !fastify ? b.error : `http_${status}`;
  const message = typeof b.message === 'string' && b.message ? b.message : `HTTP ${status}`;
  const d: ErrorDetails = { code, status, requestId: o.requestId, idempotencyKey: o.idempotencyKey, body };
  const text = `${message} [${code}, HTTP ${status}${o.requestId ? `, request ${o.requestId}` : ''}]`;
  if (RISK_CODES.has(code) && (status === 422 || status === 423)) return new RiskDenied(text, d);
  if (status === 400 || status === 422) return new ValidationError(text, d);
  if (status === 401) return new AuthenticationError(text, d);
  if (status === 403) return code === 'mandate_required' ? new MandateRequired(text, d) : code === 'mandate_denied' || code === 'mandate_not_approved' ? new MandateDenied(text, d)
    : code === 'execution_disabled' ? new ExecutionDisabled(text, d) : SCOPE_CODES.has(code) ? new ScopeDenied(text, d) : new PermissionDenied(text, d);
  if (status === 404) return new NotFound(text, d);
  if (status === 409) return code === 'idempotency_conflict' ? new IdempotencyConflict(text, d) : code === 'ambiguous_symbol' ? new AmbiguousSymbol(text, d) : code === 'ambiguous_command' ? new AmbiguousCommand(text, d) : new Conflict(text, d);
  if (status === 423) return new RiskDenied(text, d);
  if (status === 429) return new RateLimited(text, { ...d, retryAfterSeconds: o.retryAfterSeconds });
  if (status === 501) return code === 'execution_not_wired' ? new ExecutionNotWired(text, d) : new NotImplementedError(text, d);
  if (status === 503) return new ServiceUnavailable(text, d);
  if (status >= 500) return new ServerError(text, d);
  return new APIError(text, d);
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/src/util.ts
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

// Pure helpers: canonical JSON, idempotency keys, decimal strings, order states. No I/O, no dependency.
// (An order sized by a notional is sized by the SERVER since API 1.0.0 of V11: there is no sizing arithmetic here any more.)
import { ConfigurationError } from './errors.ts';
import { FINAL_ORDER_STATES, ORDER_STATES, type OrderState } from './generated/openapi.ts';

// ---------------------------------------------------------------------------------------------------------------- canonical JSON
/** Deterministic JSON: object keys sorted, `undefined` members dropped, no whitespace — the same rule as the server's
 *  `canonicalJson` (services/api/src/trading-api/key-model.ts), so the bytes of a call are the same on every retry and
 *  the server's request hash is the same too. Non-finite numbers are refused (JSON cannot carry them). */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new ConfigurationError('a request body cannot contain NaN or Infinity');
  if (typeof v === 'bigint') throw new ConfigurationError('a request body cannot contain a bigint: pass a decimal string');
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------------------------------------------- idempotency keys
/** what the server accepts in `Idempotency-Key` */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;
/** a fresh UUIDv4 — one per LOGICAL call; store it before sending if the process may crash, and pass it again to resume */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------------------------- decimals
/** Money, prices and sizes are decimal STRINGS on the wire and in this SDK: never a binary float. */
export const DECIMAL_RE = /^\d+(\.\d+)?$/;
export const isDecimalString = (v: unknown): v is string => typeof v === 'string' && DECIMAL_RE.test(v);
/** a decimal string, or an integer given as a safe integer number (100 → "100"); anything else (0.1, 1e21, NaN, "1,5") throws */
export function decimalString(v: string | number, what: string): string {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new ConfigurationError(`${what}: pass a decimal string (e.g. "0.01"), not a float`);
    return String(v);
  }
  if (!isDecimalString(v)) throw new ConfigurationError(`${what}: expected a non-negative decimal string such as "0.01"`);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------- order states
/** final states. UNKNOWN is NOT final and is NOT a failure: the venue's answer is not known yet — keep reading the order. */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = FINAL_ORDER_STATES;
/** `status` as an OrderState, or null when it is not one of the twelve (an answer of a server newer than this SDK) */
export function orderState(status: unknown): OrderState | null {
  return typeof status === 'string' && (ORDER_STATES as readonly string[]).includes(status) ? (status as OrderState) : null;
}
/** True when the order is final: its `status` is FILLED, CANCELLED, REJECTED or FAILED — the closed enum of the contract
 *  decides, nothing else. `UNKNOWN` is never final, and a status this SDK does not know is not final either. */
export function isTerminalOrder(order: { status?: unknown }): boolean {
  const s = orderState(order.status);
  return s !== null && TERMINAL_ORDER_STATES.includes(s);
}

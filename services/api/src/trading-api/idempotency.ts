/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/idempotency.ts
 * Module           : trading-api
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

// Replay protection of mutating calls — reusable middleware (the execution endpoints of the next wave wrap their handler in it).
//
//   Idempotency-Key: <8-100 chars>     required. Scoped to the principal (a key's namespace is its own).
//   X-SPW-Timestamp: <unix seconds>    optional; when present it must be within ±300 s of the server clock (400 `stale_request`).
//
// First call: the handler runs; its answer (status + JSON body, success or a 4xx refusal) is stored with the SHA-256 of the
// request (method, path, canonical body). Same key + same request: the stored answer is returned, the handler does NOT run
// again (`Idempotent-Replay: true`). Same key + a different request: 409 `idempotency_conflict`. Same key while the first call
// is still running: 409 `idempotency_in_progress`. An answer ≥ 500 (including 501 `execution_not_wired`) is not stored: nothing
// happened, the same key may be used again.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { canonicalJson, sha256Hex } from './key-model.ts';
import { requirePrincipal, type Principal } from './principal.ts';

export const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,100}$/;
export const TIMESTAMP_TOLERANCE_SEC = 300;
const principalId = (p: Principal): string => (p.kind === 'api_key' ? `key:${p.id}` : 'owner');

/** the header checks alone (also used to refuse a bad request before any work) */
export function replayHeaders(req: FastifyRequest, now = Date.now()): { key: string } {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || !IDEMPOTENCY_RE.test(k)) throw new UserError('idempotency', 'an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required', 400);
  const ts = req.headers['x-spw-timestamp'];
  if (ts !== undefined) {
    const t = typeof ts === 'string' && /^\d{9,11}$/.test(ts) ? Number(ts) : NaN;
    if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > TIMESTAMP_TOLERANCE_SEC) throw new UserError('stale_request', `X-SPW-Timestamp must be Unix seconds within ${TIMESTAMP_TOLERANCE_SEC} s of the server clock`, 400);
  }
  return { key: k };
}
export const requestHash = (req: FastifyRequest): string => sha256Hex(`${req.method}\n${req.url.split('?')[0]}\n${canonicalJson(req.body ?? null)}`);

/** Run `fn` at most once per (principal, Idempotency-Key). `fn` returns the JSON body of a 200, or throws a UserError. */
export async function withIdempotency<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<T | unknown> {
  const { key } = replayHeaders(req);
  return storedAnswer(principalId(requirePrincipal(req)), key, requestHash(req), reply, fn);
}
/**
 * The same protection under a key the BODY carries: an order's `clientOrderId`. Needed where the handler derives part of the
 * order from the market before the order service sees it (a `notional` becomes a size at the price read now): without it, the
 * same order sent again under another Idempotency-Key header would be sized at another price and look like a different order.
 * Same clientOrderId + same body → the first answer; another body → 409 `idempotency_conflict`.
 */
export function withOrderKey<T>(req: FastifyRequest, reply: FastifyReply, clientOrderId: string, fn: () => Promise<T>): Promise<T | unknown> {
  return storedAnswer(principalId(requirePrincipal(req)), `order:${clientOrderId}`, requestHash(req), reply, fn);
}
async function storedAnswer<T>(who: string, key: string, hash: string, reply: FastifyReply, fn: () => Promise<T>): Promise<T | unknown> {
  const [mine] = await sql`insert into api_idempotency (principal, key, request_hash) values (${who}, ${key}, ${hash}) on conflict (principal, key) do nothing returning key`;
  if (!mine) {
    const [seen] = await sql<{ request_hash: string; state: string; status: number | null; response: unknown }[]>`select request_hash, state, status, response from api_idempotency where principal = ${who} and key = ${key}`;
    // the first call failed with a server error between our insert and this read: its row is gone, the caller retries
    if (!seen) throw new UserError('idempotency_in_progress', 'the first request with this Idempotency-Key just ended without an answer; retry', 409);
    if (seen.request_hash !== hash) throw new UserError('idempotency_conflict', 'this Idempotency-Key was used with a different request', 409);
    if (seen.state !== 'done') throw new UserError('idempotency_in_progress', 'the first request with this Idempotency-Key is still being processed', 409);
    reply.header('idempotent-replay', 'true').status(seen.status ?? 200);
    return seen.response;
  }
  const done = (status: number, response: unknown) => sql`update api_idempotency set state = 'done', status = ${status}, response = ${sql.json(response as never)} where principal = ${who} and key = ${key}`;
  const forget = () => sql`delete from api_idempotency where principal = ${who} and key = ${key}`.catch(() => {});
  try {
    const out = await fn();
    await done(200, out ?? null);
    return out;
  } catch (e) {
    // `data` (the order a refusal is about, the questions of an ambiguous command) is part of the answer a replay gives back
    if (e instanceof UserError && e.status < 500) await done(e.status, { error: e.code, message: e.message, ...((e as { data?: unknown }).data !== undefined ? { data: (e as { data?: unknown }).data } : {}) }).catch(() => {});
    else await forget();
    throw e;
  }
}

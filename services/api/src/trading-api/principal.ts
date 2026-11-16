// Who is calling — and what that caller may reach.
//
//   req.principal = { kind: 'owner' }                                   the owner's passkey session (cookie + CSRF + Origin)
//                 | { kind: 'api_key', id, name, scopes, limits, restrictions, mandateId, rateLimitPerMin }
//                 | null                                                 a public route, or the research runner
//
// Three functions, used by server.ts and index.ts and nothing else:
//   apiKeyGate(req, reply, path)   onRequest branch. A request that presents `Authorization: Bearer spw_live_…` is a KEY request:
//                                  it is refused outside /api/v1/trading/ (before the key is even looked up), refused together
//                                  with a session cookie, and otherwise verified, rate-limited and given its principal.
//   scopeGuard(req)                the single preHandler. Default deny: a key principal passes only on a trading route that
//                                  declares a scope it holds; a trading route without a declared scope is closed to everybody.
//   recordUsage(req, reply)        onResponse: one row per call made with a key.
//
// Why a key request skips the CSRF/Origin check: that check exists because a browser attaches the session cookie by itself
// (an ambient credential), so a hostile page could make the owner's browser act. A bearer token is never attached by a
// browser on its own; a request that carries it was built on purpose by whoever holds the secret. The skip is tied to the
// absence of the cookie: key + cookie is refused, so the cookie can never ride on the CSRF-exempt path.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { COOKIE } from '../auth.ts';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { ipAllowed, TOKEN_PREFIX } from './key-model.ts';
import { touchKey, verifyToken } from './keys.ts';
import { ANY_SCOPE, TRADING_PREFIX, type Limits, type Restrictions, type RouteScope, type Scope } from './spec.ts';

export interface OwnerPrincipal { kind: 'owner' }
export interface ApiKeyPrincipal { kind: 'api_key'; id: string; name: string; scopes: Scope[]; limits: Limits; restrictions: Restrictions; mandateId: string | null; rateLimitPerMin: number }
export type Principal = OwnerPrincipal | ApiKeyPrincipal;
export const OWNER: OwnerPrincipal = Object.freeze({ kind: 'owner' });
/** the actor written to the audit chain */
export const actorOf = (p: Principal | null): string => (p?.kind === 'api_key' ? `key:${p.id}` : p ? 'owner' : 'unknown');

declare module 'fastify' {
  interface FastifyRequest { principal: Principal | null; spwKeyAttempt: string | null; spwRequestId: string | null }
  interface FastifyContextConfig { /** required on every trading route (default deny) */ scope?: RouteScope }
}

// ---------------------------------------------------------------------------------------------------------------- limiters
/** fixed one-minute windows, in memory, per process (like the IP limiter of server.ts) */
export class WindowLimiter {
  private readonly slots = new Map<string, { n: number; resetAt: number }>();
  constructor(readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  private slot(key: string): { n: number; resetAt: number } {
    const t = this.now();
    let s = this.slots.get(key);
    if (!s || t >= s.resetAt) {
      if (this.slots.size > 20_000) for (const [k, v] of this.slots) if (t >= v.resetAt) this.slots.delete(k);
      s = { n: 0, resetAt: t + this.windowMs }; this.slots.set(key, s);
    }
    return s;
  }
  /** count one event; `allowed` is false once more than `max` were counted in the window */
  take(key: string, max: number): { allowed: boolean; limit: number; remaining: number; resetSec: number } {
    const s = this.slot(key);
    s.n += 1;
    return { allowed: s.n <= max, limit: max, remaining: Math.max(0, max - s.n), resetSec: Math.max(1, Math.ceil((s.resetAt - this.now()) / 1000)) };
  }
  count(key: string): number { return this.slot(key).n; }
  reset(): void { this.slots.clear(); }
}
export const AUTH_FAILURES_PER_MIN = 10;
export const keyLimiter = new WindowLimiter();
export const authFailures = new WindowLimiter();
const deniedAudit = new WindowLimiter();

// ---------------------------------------------------------------------------------------------------------------- gate
const unauth = (): UserError => new UserError('unauthenticated', 'authentication required', 401);
export const isTradingPath = (path: string): boolean => path.startsWith(`${TRADING_PREFIX}/`);

/** onRequest. Returns false when the request is not a key request (the caller goes on with the session check). */
export async function apiKeyGate(req: FastifyRequest, reply: FastifyReply, path: string): Promise<boolean> {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith(`Bearer ${TOKEN_PREFIX}`)) return false;
  // a key opens the trading API and nothing else — said before the key is looked up, so this answer tells nothing about the key
  if (!isTradingPath(path)) throw new UserError('key_path_forbidden', `an API key is accepted under ${TRADING_PREFIX}/ only`, 403);
  if (req.cookies[COOKIE]) throw new UserError('mixed_credentials', 'send an API key or the session cookie, never both', 403);
  if (authFailures.count(req.ip) >= AUTH_FAILURES_PER_MIN) { reply.header('retry-after', '60'); throw new UserError('auth_throttled', 'too many failed authentications from this address', 429); }
  req.spwRequestId = randomUUID();
  reply.header('x-request-id', req.spwRequestId);
  const v = await verifyToken(h.slice(7));
  if (!v.ok) {
    authFailures.take(req.ip, AUTH_FAILURES_PER_MIN);
    if (v.reason === 'revoked' || v.reason === 'expired') req.spwKeyAttempt = v.keyId; // the secret was right: the refused call shows in the key's history
    throw unauth(); // one answer for malformed, unknown, wrong, revoked and expired
  }
  const k = v.key;
  req.spwKeyAttempt = k.id;
  if (!ipAllowed(req.ip, k.restrictions.ipAllow)) throw new UserError('ip_not_allowed', 'this key is not allowed from this address', 403);
  const r = keyLimiter.take(k.id, k.rate_limit_per_min);
  reply.header('ratelimit-limit', String(r.limit)).header('ratelimit-remaining', String(r.remaining)).header('ratelimit-reset', String(r.resetSec));
  if (!r.allowed) { reply.header('retry-after', String(r.resetSec)); throw new UserError('rate_limited', 'too many requests for this key', 429); }
  req.principal = { kind: 'api_key', id: k.id, name: k.name, scopes: k.scopes, limits: k.limits, restrictions: k.restrictions, mandateId: k.mandate_id, rateLimitPerMin: k.rate_limit_per_min };
  touchKey(k.id, req.ip);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- guard
/** preHandler, registered once for the whole server. */
export async function scopeGuard(req: FastifyRequest): Promise<void> {
  const p = req.principal, path = req.url.split('?')[0]!, route = req.routeOptions.url, scope = req.routeOptions.config.scope;
  const inTrading = isTradingPath(path);
  if (p?.kind === 'api_key') {
    // defense in depth: the gate already refused every other path
    if (!inTrading || (route !== undefined && !isTradingPath(route))) throw new UserError('key_path_forbidden', `an API key is accepted under ${TRADING_PREFIX}/ only`, 403);
    if (req.is404 || route === undefined) return; // the not-found handler answers 404
    if (!scope) throw new UserError('scope_undeclared', 'this route declares no scope: closed to API keys', 403);
    if (scope !== ANY_SCOPE && !p.scopes.includes(scope)) {
      if (deniedAudit.take(`${p.id}|${scope}|${route}`, 1).allowed) await audit('apikey.denied', actorOf(p), { key: p.id, scope, method: req.method, route }).catch(() => {});
      throw new UserError('insufficient_scope', `this key lacks the scope ${scope}`, 403);
    }
    return;
  }
  if (inTrading && route !== undefined && !req.is404) {
    if (!p) throw unauth();
    if (!scope) throw new UserError('scope_undeclared', 'this route declares no scope: closed', 403);
  }
}
/** the route's scope again, for handlers that take a decision on it */
export const requirePrincipal = (req: FastifyRequest): Principal => { if (!req.principal) throw unauth(); return req.principal; };

// ---------------------------------------------------------------------------------------------------------------- usage log
const retentionDays = (): number => { const n = Number(process.env.SPW_API_USAGE_RETENTION_DAYS ?? 90); return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 3650) : 90; };
let prunedAt = 0;
/** retention: usage rows older than SPW_API_USAGE_RETENTION_DAYS (default 90), idempotency records older than a day, intents that expired */
export async function pruneTradingApi(now = Date.now()): Promise<{ usage: number; idempotency: number }> {
  prunedAt = now;
  const u = await sql`delete from api_key_usage where ts < ${new Date(now - retentionDays() * 86_400_000)}`;
  const i = await sql`delete from api_idempotency where created_at < ${new Date(now - 86_400_000)}`;
  await sql`delete from api_key_intents where expires_at < ${new Date(now)}`;
  return { usage: u.count, idempotency: i.count };
}
/** onResponse: key id, method, route PATTERN, status, latency, request id — never a body, a query string or a header */
export async function recordUsage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = req.principal?.kind === 'api_key' ? req.principal.id : req.spwKeyAttempt;
  if (!id) return;
  try {
    await sql`insert into api_key_usage (key_id, method, route, status, latency_ms, request_id, ip) values (${id}, ${req.method}, ${req.is404 ? '(no route)' : req.routeOptions.url ?? '(no route)'}, ${reply.statusCode}, ${Math.round(reply.elapsedTime)}, ${req.spwRequestId ?? ''}, ${req.ip})`;
    if (Date.now() - prunedAt > 3_600_000) await pruneTradingApi();
  } catch (e) { req.log.warn({ msg: 'api key usage not recorded', err: (e as Error).message }); }
}

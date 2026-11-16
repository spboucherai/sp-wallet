// /api/v1/developer — the owner's side of the trading API: keys, usage, service status, webhooks.
//
// OWNER SESSION ONLY. These paths are outside /api/v1/trading/, so an API key is refused on them twice (the gate of
// principal.ts, then scopeGuard), and each handler checks the principal a third time. There is no scope that opens them.
//
//   GET    /keys                         list (never a secret, never a hash)
//   POST   /keys/prepare                 canonical creation intent + WebAuthn request          POST /keys               { intentId, assertion } → the secret, ONCE
//   POST   /keys/:id/revoke              session only: it removes authority
//   POST   /keys/:id/rotate/prepare      intent                                                POST /keys/:id/rotate    { intentId, assertion } → new id + secret, old key revoked
//   POST   /keys/:id/update/prepare      intent for a change that widens the key               POST /keys/:id/update    { changes } (narrowing, session only) | { intentId, assertion }
//   GET    /usage                        call log + per-key counters                           GET  /status             service statuses
//   GET    /webhooks                     endpoints, events, recent deliveries                  POST /webhooks           create (secret shown once)
//   POST   /webhooks/:id                 enable / disable / events / label (Idempotency-Key required)                    POST /webhooks/:id/secret   new signing secret       DELETE /webhooks/:id
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { capabilities } from '../capabilities.ts';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import type { Derivatives } from '../derivatives/index.ts';
import { listQuality } from '../market/store.ts';
import { signer } from '../signer-client.ts';
import { withIdempotency } from './idempotency.ts';
import { KEY_ID_RE } from './key-model.ts';
import { createKey, keyView, listKeys, narrowKey, prepareCreate, prepareRotate, prepareUpdate, revokeKey, rotateKey, updateKey } from './keys.ts';
import { AUTH_FAILURES_PER_MIN } from './principal.ts';
import { API_VERSION, DEVELOPER_PREFIX, EXECUTION_SCOPES, KEY_BOUNDS, KeyChangesSchema, KeyCreateSchema, OPERATIONS, SCOPES, TRADING_PREFIX, WEBHOOK_EVENTS, WEBHOOK_EVENT_NAMES } from './spec.ts';
import { createWebhook, deleteWebhook, emitWebhook, listDeliveries, listWebhooks, rotateWebhookSecret, updateWebhook, webhookStats, WEBHOOK_BACKOFF_MS, WEBHOOK_MAX_ATTEMPTS } from './webhooks.ts';

const Approval = z.strictObject({ intentId: z.uuid(), assertion: z.record(z.string(), z.unknown()) });
const WebhookCreate = z.strictObject({ url: z.string().url().max(500), events: z.array(z.enum(WEBHOOK_EVENT_NAMES)).min(1).max(WEBHOOK_EVENT_NAMES.length), label: z.string().trim().max(60).default('') });
const WebhookPatch = z.strictObject({ enabled: z.boolean().optional(), events: z.array(z.enum(WEBHOOK_EVENT_NAMES)).min(1).max(WEBHOOK_EVENT_NAMES.length).optional(), label: z.string().trim().max(60).optional() });

export function developerRoutes(app: FastifyInstance, deps: { derivatives: () => Derivatives }): void {
  const P = DEVELOPER_PREFIX, strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  /** third line of defense: only the owner session, whatever let the request come this far */
  const owner = (req: FastifyRequest): void => { if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route needs the owner session', 403); };
  const keyId = (req: FastifyRequest): string => z.string().regex(KEY_ID_RE).parse((req.params as { id: string }).id);
  const hookId = (req: FastifyRequest): string => z.string().regex(/^wh_[0-9a-f]{12}$/).parse((req.params as { id: string }).id);

  // ------------------------------------------------------------------------------------------------------------ command defaults (V11)
  // what POST /trading/commands may assume when a command does not say it: the owner's choice, never a key's. Absent = asked.
  app.get(`${P}/command-defaults`, async (req) => { owner(req); const m = await import('./commands.ts'); return { defaults: await m.commandDefaults() }; });
  app.put(`${P}/command-defaults`, async (req) => { owner(req); const m = await import('./commands.ts'); return { defaults: await m.setCommandDefaults((req.body as { defaults?: unknown } | undefined)?.defaults) }; });

  // ------------------------------------------------------------------------------------------------------------ keys
  app.get(`${P}/keys`, async (req) => {
    owner(req);
    return { keys: (await listKeys()).map(keyView), scopes: SCOPES.map((s) => ({ scope: s, execution: (EXECUTION_SCOPES as readonly string[]).includes(s) })), bounds: KEY_BOUNDS,
      execution: { wired: true, liveEnabled: process.env.SPW_TRADING_API_EXECUTION === 'on', code: null, note: 'orders, cancels and position reductions are wired (paper always; live needs SPW_TRADING_API_EXECUTION=on and the mainnet locks). An execution scope acts only with an approved, active trading mandate bound to the key — except a cancel of the key\'s own order and the kill switch, which only remove risk. The strategy and agent operations still answer 501.' } };
  });
  app.post(`${P}/keys/prepare`, strict, async (req) => { owner(req); return prepareCreate(KeyCreateSchema.parse(req.body)); });
  app.post(`${P}/keys`, strict, async (req) => { owner(req); const b = Approval.parse(req.body); return createKey(b.intentId, b.assertion, req.ip); });
  app.post(`${P}/keys/:id/revoke`, async (req) => {
    owner(req);
    const b = z.strictObject({ reason: z.string().trim().max(200).default('') }).parse(req.body ?? {});
    const r = await revokeKey(keyId(req), b.reason, req.ip);
    if (r.changed) await emitWebhook('key.revoked', { keyId: r.key.id, name: r.key.name, reason: r.key.revokedReason });
    return { key: r.key };
  });
  app.post(`${P}/keys/:id/rotate/prepare`, strict, async (req) => { owner(req); return prepareRotate(keyId(req)); });
  app.post(`${P}/keys/:id/rotate`, strict, async (req) => {
    owner(req);
    const b = Approval.parse(req.body), r = await rotateKey(keyId(req), b.intentId, b.assertion, req.ip);
    await emitWebhook('key.revoked', { keyId: r.revoked, name: r.key.name, reason: `rotated to ${r.key.id}` });
    return r;
  });
  app.post(`${P}/keys/:id/update/prepare`, strict, async (req) => { owner(req); return prepareUpdate(keyId(req), z.strictObject({ changes: KeyChangesSchema }).parse(req.body).changes); });
  app.post(`${P}/keys/:id/update`, strict, async (req) => {
    owner(req);
    const b = z.union([z.strictObject({ changes: KeyChangesSchema }), Approval]).parse(req.body);
    return 'changes' in b ? narrowKey(keyId(req), b.changes, req.ip) : updateKey(keyId(req), b.intentId, b.assertion, req.ip);
  });

  // ------------------------------------------------------------------------------------------------------------ usage
  app.get(`${P}/usage`, async (req) => {
    owner(req);
    const q = z.object({ key: z.string().regex(KEY_ID_RE).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = await sql`select id, key_id, ts, method, route, status, latency_ms, request_id from api_key_usage ${q.key ? sql`where key_id = ${q.key}` : sql``} order by id desc limit ${q.limit}`;
    const perKey = await sql`select key_id, (count(*) filter (where ts > now() - interval '24 hours'))::int as calls_24h, (count(*) filter (where ts > now() - interval '24 hours' and status >= 400))::int as errors_24h,
      (count(*) filter (where ts > now() - interval '24 hours' and status = 429))::int as limited_24h, (count(*) filter (where ts > now() - interval '1 minute'))::int as calls_1m, count(*)::int as calls, max(ts) as last_at,
      (percentile_cont(0.95) within group (order by latency_ms))::int as p95_ms from api_key_usage group by key_id`;
    return {
      items: rows.map((r) => ({ id: Number(r.id), keyId: r.key_id as string, ts: (r.ts as Date).getTime(), method: r.method as string, route: r.route as string, status: r.status as number, latencyMs: r.latency_ms as number, requestId: r.request_id as string })),
      perKey: perKey.map((r) => ({ keyId: r.key_id as string, calls24h: r.calls_24h as number, errors24h: r.errors_24h as number, rateLimited24h: r.limited_24h as number, callsLastMinute: r.calls_1m as number, calls: r.calls as number,
        lastAt: (r.last_at as Date | null)?.getTime() ?? null, p95Ms: r.p95_ms as number | null })),
      retentionDays: Number(process.env.SPW_API_USAGE_RETENTION_DAYS ?? 90) || 90,
    };
  });

  // ------------------------------------------------------------------------------------------------------------ status
  app.get(`${P}/status`, async (req) => {
    owner(req);
    const d = deps.derivatives();
    const [db, st, quality, keys, hooks] = await Promise.all([
      sql`select 1`.then(() => true, () => false),
      signer.status().then((x) => ({ reachable: true, halted: x.halted as boolean | null }), () => ({ reachable: false, halted: null as boolean | null })),
      listQuality().catch(() => null), listKeys().catch(() => null), webhookStats().catch(() => null),
    ]);
    const q1h = quality?.filter((x) => x.interval === '1h') ?? [];
    return {
      api: { version: API_VERSION, prefix: TRADING_PREFIX, operations: OPERATIONS.length, implemented: OPERATIONS.filter((o) => o.implemented).length, notImplemented: OPERATIONS.filter((o) => !o.implemented).map((o) => `${o.method} ${o.path}`) },
      services: [
        { id: 'database', ok: db, detail: db ? 'reachable' : 'unreachable' },
        { id: 'signer', ok: st.reachable && st.halted === false, detail: !st.reachable ? 'unreachable: balances and the portfolio answer 503' : st.halted ? 'halted (emergency stop)' : 'reachable' },
        ...d.registry.list().map((v) => { const h = d.registry.health(v.id); return { id: `venue:${v.id}`, ok: h.status === 'ok', detail: h.lastOkAt === null && h.status === 'ok' ? 'not read yet' : h.status === 'ok' ? 'ok' : `${h.status}: ${h.lastError ?? ''}`.slice(0, 200), lastOkAt: h.lastOkAt }; }),
        { id: 'market-data', ok: quality !== null && q1h.length > 0 && q1h.every((x) => x.fresh), detail: quality === null ? 'unreadable' : `${q1h.filter((x) => x.fresh).length}/${q1h.length} symbols fresh (1h)` },
        { id: 'execution', ok: true, detail: `orders are wired (unified order table, risk engine, trading mandates); live execution through the API is ${process.env.SPW_TRADING_API_EXECUTION === 'on' ? 'ENABLED (SPW_TRADING_API_EXECUTION=on)' : 'disabled (SPW_TRADING_API_EXECUTION is not "on"): paper works, new live risk answers execution_disabled'}; strategy and agent operations answer 501` },
        { id: 'webhooks', ok: hooks !== null && (hooks.endpoints === 0 || hooks.worker), detail: hooks === null ? 'unreadable' : `${hooks.endpoints} endpoint(s), ${hooks.pending} pending, ${hooks.failed24h} failed in 24 h${hooks.worker ? '' : ', retry worker not running'}` },
      ],
      keys: keys ? { total: keys.length, active: keys.filter((k) => keyView(k).status === 'active').length } : null,
      rateLimits: { defaultPerMin: KEY_BOUNDS.defaultRatePerMin, maxPerMin: KEY_BOUNDS.maxRatePerMin, failedAuthPerMinPerAddress: AUTH_FAILURES_PER_MIN, headers: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'] },
      capabilities: capabilities().map((c) => ({ id: c.id, on: c.on, why: c.why })),
      ts: Date.now(),
    };
  });

  // ------------------------------------------------------------------------------------------------------------ webhooks
  app.get(`${P}/webhooks`, async (req) => {
    owner(req);
    return { webhooks: await listWebhooks(), events: WEBHOOK_EVENTS, deliveries: await listDeliveries({ limit: 50 }), retry: { attempts: WEBHOOK_MAX_ATTEMPTS, backoffSec: WEBHOOK_BACKOFF_MS.map((x) => x / 1000) },
      signature: 'X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<X-SPW-Timestamp>.<raw body>")>' };
  });
  app.get(`${P}/webhooks/deliveries`, async (req) => {
    owner(req);
    const q = z.object({ webhook: z.string().regex(/^wh_[0-9a-f]{12}$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return { deliveries: await listDeliveries({ ...(q.webhook ? { webhookId: q.webhook } : {}), limit: q.limit }) };
  });
  // the answer of a creation carries the signing secret: it must never be stored, so this route does NOT use the idempotency store
  app.post(`${P}/webhooks`, strict, async (req) => { owner(req); return createWebhook(WebhookCreate.parse(req.body), req.ip); });
  app.post(`${P}/webhooks/:id`, async (req, reply) => { owner(req); const id = hookId(req), b = WebhookPatch.parse(req.body); return withIdempotency(req, reply, () => updateWebhook(id, b)); });
  app.post(`${P}/webhooks/:id/secret`, strict, async (req) => { owner(req); return rotateWebhookSecret(hookId(req), req.ip); });
  app.delete(`${P}/webhooks/:id`, async (req) => { owner(req); return deleteWebhook(hookId(req), req.ip); });
}

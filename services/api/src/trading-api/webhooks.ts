// Webhooks of the trading API: owner-managed HTTPS endpoints that receive the events of spec.ts (WEBHOOK_EVENTS).
// Transport and signature are those of the alert webhook (alerts/webhook.ts — `postSigned`, `webhookSignature`,
// `verifyWebhook`): nothing is duplicated, a receiver verifies both kinds with the same code.
//
//   POST <url>     X-SPW-Timestamp: <unix seconds>     X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
//                  X-SPW-Event: <event>                X-SPW-Delivery: <delivery id>
//   body           { "app": "sp-wallet", "id": "<event uuid>", "event": "key.revoked", "ts": "<ISO>", "data": { … } }
//
// Delivery: an event creates one row per subscribed endpoint (`pending`). A row is claimed — attempt counted and next attempt
// scheduled — BEFORE the network call, so a crash in the middle never produces a tight loop. A failure is retried after
// 30 s, 2 min, 10 min, 1 h, 6 h; after six attempts the delivery is `failed`. At-least-once: a receiver deduplicates on `id`.
// Payloads carry identifiers and states only: no secret, no key material, no amount.
import { randomBytes, randomUUID } from 'node:crypto';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { postSigned, webhookUrlOk } from '../alerts/webhook.ts';
import { dropWebhookSecret, newWebhookSecret, webhookSecretOf } from './secrets.ts';
import { WEBHOOK_EVENTS, type WebhookEvent } from './spec.ts';

export const WEBHOOK_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length + 1;
export const MAX_WEBHOOKS = 10;
const DELIVERY_RETENTION_MS = 30 * 86_400_000;

export interface WebhookDeps { fetch?: typeof fetch; /** tests: a local http receiver */ allowHttp?: boolean; now?: () => number }
let deps: WebhookDeps = {};
export const configureWebhooks = (d: WebhookDeps): void => { deps = d; };
const now = (): number => (deps.now ?? Date.now)();

interface HookRow { id: string; url: string; events: WebhookEvent[]; enabled: boolean; label: string; created_at: Date; last_ok_at: Date | null; last_error: string | null; failures: number }
interface DeliveryRow { id: string; webhook_id: string; event_id: string; event: string; payload: unknown; state: string; attempts: number; next_attempt_at: Date; last_status: number | null; last_error: string | null; created_at: Date; delivered_at: Date | null }
const hookView = (h: HookRow) => ({ id: h.id, url: h.url, events: h.events, enabled: h.enabled, label: h.label, createdAt: h.created_at.getTime(), lastOkAt: h.last_ok_at?.getTime() ?? null, lastError: h.last_error, failures: h.failures,
  hasSecret: webhookSecretOf(h.id) !== null });
const deliveryView = (d: DeliveryRow) => ({ id: Number(d.id), webhookId: d.webhook_id, eventId: d.event_id, event: d.event, state: d.state, attempts: d.attempts, nextAttemptAt: d.state === 'pending' ? d.next_attempt_at.getTime() : null,
  lastStatus: d.last_status, lastError: d.last_error, createdAt: d.created_at.getTime(), deliveredAt: d.delivered_at?.getTime() ?? null });

export const listWebhooks = async () => (await sql<HookRow[]>`select * from api_webhooks order by created_at`).map(hookView);
export async function createWebhook(b: { url: string; events: WebhookEvent[]; label: string }, ip: string) {
  if (!deps.allowHttp && !webhookUrlOk(b.url)) throw new UserError('bad_webhook_url', 'the webhook URL must be https, without credentials', 400);
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from api_webhooks`;
  if ((n?.n ?? 0) >= MAX_WEBHOOKS) throw new UserError('too_many_webhooks', `at most ${MAX_WEBHOOKS} webhook endpoints`, 409);
  const id = `wh_${randomBytes(6).toString('hex')}`;
  const [row] = await sql<HookRow[]>`insert into api_webhooks (id, url, events, label) values (${id}, ${b.url}, ${[...new Set(b.events)].sort()}, ${b.label}) returning *`;
  const secret = newWebhookSecret(id);
  await audit('webhook.created', 'owner', { webhook: id, host: new URL(b.url).host, events: row!.events, ip });
  return { webhook: hookView(row!), secret };
}
async function hook(id: string): Promise<HookRow> {
  const [h] = await sql<HookRow[]>`select * from api_webhooks where id = ${id}`;
  if (!h) throw new UserError('unknown_webhook', 'unknown webhook endpoint', 404);
  return h;
}
export async function updateWebhook(id: string, b: { enabled?: boolean; events?: WebhookEvent[]; label?: string }) {
  const h = await hook(id);
  const [row] = await sql<HookRow[]>`update api_webhooks set enabled = ${b.enabled ?? h.enabled}, events = ${b.events ? [...new Set(b.events)].sort() : h.events}, label = ${b.label ?? h.label},
    failures = ${b.enabled === true ? 0 : h.failures} where id = ${id} returning *`;
  return { webhook: hookView(row!) };
}
export async function rotateWebhookSecret(id: string, ip: string) {
  const h = await hook(id), secret = newWebhookSecret(id);
  await audit('webhook.secret_rotated', 'owner', { webhook: id, ip });
  return { webhook: hookView(h), secret };
}
export async function deleteWebhook(id: string, ip: string) {
  const h = await hook(id);
  await sql`delete from api_webhooks where id = ${id}`;
  dropWebhookSecret(id);
  await audit('webhook.deleted', 'owner', { webhook: id, host: new URL(h.url).host, ip });
  return { ok: true };
}
export const listDeliveries = async (o: { webhookId?: string; limit: number }) =>
  (await sql<DeliveryRow[]>`select * from api_webhook_deliveries ${o.webhookId ? sql`where webhook_id = ${o.webhookId}` : sql``} order by id desc limit ${o.limit}`).map(deliveryView);

/** Queue `event` for every enabled endpoint subscribed to it and start delivering. Never throws: an event source must not fail because of a webhook. */
export async function emitWebhook(event: WebhookEvent, data: Record<string, unknown>): Promise<{ queued: number; eventId: string }> {
  const eventId = randomUUID();
  try {
    if (!WEBHOOK_EVENTS.some((e) => e.event === event)) return { queued: 0, eventId };
    const hooks = await sql<{ id: string }[]>`select id from api_webhooks where enabled and ${event} = any(events)`;
    const payload = { app: 'sp-wallet', id: eventId, event, ts: new Date(now()).toISOString(), data };
    for (const h of hooks) await sql`insert into api_webhook_deliveries (webhook_id, event_id, event, payload, next_attempt_at) values (${h.id}, ${eventId}, ${event}, ${sql.json(payload as never)}, ${new Date(now())})`;
    if (hooks.length) void deliverDue().catch(() => {});
    return { queued: hooks.length, eventId };
  } catch { return { queued: 0, eventId }; }
}

let running: Promise<{ sent: number; failed: number }> | null = null, prunedAt = 0;
/** one pass over the deliveries that are due (serialized: a second caller waits for the pass in progress) */
export function deliverDue(): Promise<{ sent: number; failed: number }> {
  return (running ??= pass().finally(() => { running = null; }));
}
async function pass(): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  const t = now();
  // claim: the attempt is counted and the next one scheduled before any network call
  const due = await sql<DeliveryRow[]>`select * from api_webhook_deliveries where state = 'pending' and next_attempt_at <= ${new Date(t)} order by id limit 50`;
  for (const d of due) {
    const attempt = d.attempts + 1, last = attempt >= WEBHOOK_MAX_ATTEMPTS;
    const [claimed] = await sql`update api_webhook_deliveries set attempts = ${attempt}, next_attempt_at = ${new Date(t + (WEBHOOK_BACKOFF_MS[attempt - 1] ?? 0))} where id = ${d.id} and state = 'pending' and attempts = ${d.attempts} returning id`;
    if (!claimed) continue;
    const [h] = await sql<HookRow[]>`select * from api_webhooks where id = ${d.webhook_id}`;
    const secret = h ? webhookSecretOf(h.id) : null;
    const r = !h || !h.enabled ? { ok: false, status: 0, error: 'endpoint disabled' } : !secret ? { ok: false, status: 0, error: 'no signing secret for this endpoint (rotate it)' }
      : await postSigned(h.url, secret, JSON.stringify(d.payload), { now: t, fetch: deps.fetch, allowHttp: deps.allowHttp, userAgent: 'sp-wallet-trading-api/1', headers: { 'x-spw-event': d.event, 'x-spw-delivery': String(d.id) } });
    if (r.ok) {
      sent += 1;
      await sql`update api_webhook_deliveries set state = 'delivered', delivered_at = ${new Date(now())}, last_status = ${r.status}, last_error = null where id = ${d.id}`;
      await sql`update api_webhooks set last_ok_at = ${new Date(now())}, last_error = null, failures = 0 where id = ${d.webhook_id}`;
    } else {
      failed += 1;
      const stop = last || !h || !h.enabled;
      await sql`update api_webhook_deliveries set state = ${stop ? 'failed' : 'pending'}, last_status = ${r.status}, last_error = ${(r.error ?? 'failed').slice(0, 200)} where id = ${d.id}`;
      if (h) await sql`update api_webhooks set last_error = ${(r.error ?? 'failed').slice(0, 200)}, failures = failures + 1 where id = ${h.id}`;
    }
  }
  if (t - prunedAt > 3_600_000) { prunedAt = t; await sql`delete from api_webhook_deliveries where state <> 'pending' and created_at < ${new Date(t - DELIVERY_RETENTION_MS)}`; }
  return { sent, failed };
}

let timer: ReturnType<typeof setInterval> | null = null;
/** retries: a pass every 15 s (the first attempt of an event does not wait for it) */
export function startWebhookWorker(): () => void {
  if (!timer) { timer = setInterval(() => { void deliverDue().catch(() => {}); }, 15_000); timer.unref(); }
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}
export async function webhookStats(): Promise<{ endpoints: number; pending: number; failed24h: number; delivered24h: number; worker: boolean }> {
  const [r] = await sql<{ endpoints: number; pending: number; failed: number; delivered: number }[]>`select (select count(*)::int from api_webhooks) as endpoints,
    (count(*) filter (where state = 'pending'))::int as pending, (count(*) filter (where state = 'failed' and created_at > now() - interval '24 hours'))::int as failed,
    (count(*) filter (where state = 'delivered' and created_at > now() - interval '24 hours'))::int as delivered from api_webhook_deliveries`;
  return { endpoints: r?.endpoints ?? 0, pending: r?.pending ?? 0, failed24h: r?.failed ?? 0, delivered24h: r?.delivered ?? 0, worker: timer !== null };
}

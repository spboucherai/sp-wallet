// Alerts API: the in-app list, the live stream (SSE), the owner's switches, push subscriptions per device and the optional webhook.
// Every route is under /api/ and therefore behind the owner session and the CSRF check of server.ts — nothing here is public.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALERT_DEFS, alertDef, type AlertGroup } from '@spw/core';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { alerts, type AlertDispatcher } from './dispatcher.ts';
import { rotateWebhookSecret, vapidKeys, webhookSecret } from './secrets.ts';
import { AlertSettingsSchema, alertSettings, migrateAlerts, saveAlertSettings, type AlertRow, type AlertSettings } from './store.ts';
import { sendWebhook, webhookBody, webhookUrlOk } from './webhook.ts';
import { endpointAllowed } from './webpush.ts';

const MAX_STREAMS = 8, MAX_SUBSCRIPTIONS = 12, STREAM_MAX_MS = 10 * 60_000;
/** error codes of other routes that are alerts in themselves and are recorded nowhere else */
const SIGNAL = new Set(['router_changed', 'contract_changed', 'asset_table_mismatch']);

const view = (a: AlertRow) => ({ id: Number(a.id), ts: a.ts.getTime(), kind: a.kind, severity: a.severity, group: (alertDef(a.kind)?.group ?? 'system') as AlertGroup,
  params: { ...a.params, count: a.params.count ?? a.count }, subject: a.subject, count: a.count, readAt: a.read_at?.getTime() ?? null, delivery: a.delivery, channels: a.channels });
const unread = async () => {
  const [r] = await sql<{ unread: number; critical: number; last: string | null }[]>`select (count(*) filter (where read_at is null))::int as unread,
    (count(*) filter (where read_at is null and severity = 'critical'))::int as critical, max(id) as last from alerts`;
  return { unread: r?.unread ?? 0, critical: r?.critical ?? 0, lastId: Number(r?.last ?? 0) };
};
const subView = (s: { id: string; endpoint: string; label: string; locale: string; ua: string; created_at: Date; last_ok_at: Date | null; last_error: string | null; failures: number }) =>
  ({ id: s.id, label: s.label, locale: s.locale, service: new URL(s.endpoint).hostname, endpointTail: s.endpoint.slice(-12), ua: s.ua, createdAt: s.created_at.getTime(), lastOkAt: s.last_ok_at?.getTime() ?? null, lastError: s.last_error, failures: s.failures });

const SettingsPatch = z.strictObject({
  rules: z.record(z.string(), z.boolean()).optional(), quiet: AlertSettingsSchema.shape.quiet.partial().optional(), showDetails: z.boolean().optional(), capPerHour: AlertSettingsSchema.shape.capPerHour.optional(),
  thresholds: AlertSettingsSchema.shape.thresholds.partial().optional(), webhook: AlertSettingsSchema.shape.webhook.partial().optional(),
});
const Subscription = z.strictObject({
  endpoint: z.string().url().max(1000), keys: z.strictObject({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}=*$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,30}=*$/) }),
  label: z.string().trim().max(40).default(''), locale: z.enum(['fr', 'en']).default('fr'),
});

export async function alertRoutes(app: FastifyInstance, o: { dispatcher?: AlertDispatcher } = {}): Promise<void> {
  await migrateAlerts();
  const d = o.dispatcher ?? await alerts();
  const P = '/api/v1/alerts', strict = { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } };

  // one hook, at the HTTP layer: a refusal such as "the router bytecode changed" is thrown by the money code and stored nowhere;
  // seeing it leave as an error answer is enough to alert, without adding a call inside that code
  app.addHook('onError', async (_req, _reply, err) => {
    if (!(err instanceof UserError)) return;
    if (SIGNAL.has(err.code) || (err.code.startsWith('signer_') && err.code !== 'signer_unreachable')) void d.signal(err.code, err.message).catch(() => {});
  });

  app.get(P, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional(), severity: z.enum(['info', 'warning', 'critical']).optional(),
      group: z.enum(['transfers', 'agents', 'derivatives', 'security', 'system']).optional(), unread: z.enum(['1']).optional() }).parse(req.query);
    const kinds = q.group ? ALERT_DEFS.filter((x) => x.group === q.group).map((x) => x.kind) : null;
    const rows = await sql<AlertRow[]>`select * from alerts where true ${q.before ? sql`and id < ${q.before}` : sql``} ${q.severity ? sql`and severity = ${q.severity}` : sql``}
      ${kinds ? sql`and kind = any(${kinds})` : sql``} ${q.unread ? sql`and read_at is null` : sql``} order by id desc limit ${q.limit}`;
    return { items: rows.map(view), ...(await unread()) };
  });
  app.get(`${P}/unread`, unread);
  app.post(`${P}/read`, async (req) => {
    const b = z.union([z.strictObject({ all: z.literal(true) }), z.strictObject({ ids: z.array(z.number().int().positive()).min(1).max(500) })]).parse(req.body);
    if ('all' in b) await sql`update alerts set read_at = now() where read_at is null`;
    else await sql`update alerts set read_at = now() where read_at is null and id = any(${b.ids})`;
    d.changed();
    return unread();
  });

  // Server-Sent Events: `unread` now, then at every change. The stream ends by itself after ten minutes; the browser reconnects
  // through the session check, so a stream never outlives the session by more than that.
  let streams = 0;
  app.get(`${P}/stream`, async (req, reply) => {
    if (streams >= MAX_STREAMS) throw new UserError('too_many_streams', `at most ${MAX_STREAMS} alert streams at once`, 429);
    const first = await unread();
    streams += 1;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (chunk: string): void => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(chunk); };
    write(`retry: 5000\nevent: unread\ndata: ${JSON.stringify(first)}\n\n`);
    let busy = false, again = false;
    const push = (): void => {
      if (busy) { again = true; return; }
      busy = true;
      void unread().then((u) => write(`event: unread\ndata: ${JSON.stringify(u)}\n\n`), () => {}).finally(() => { busy = false; if (again) { again = false; push(); } });
    };
    const off = d.subscribe(push);
    const beat = setInterval(() => write(': keep-alive\n\n'), 15_000), stop = setTimeout(() => end(), STREAM_MAX_MS);
    beat.unref(); stop.unref();
    let done = false;
    const end = (): void => { if (done) return; done = true; streams -= 1; clearInterval(beat); clearTimeout(stop); off(); if (!reply.raw.writableEnded) reply.raw.end(); };
    req.raw.on('close', end); reply.raw.on('close', end); reply.raw.on('error', end);
  });

  // ---- owner settings
  const settingsView = async (s: AlertSettings) => ({
    settings: s,
    kinds: ALERT_DEFS.map((x) => ({ kind: x.kind, group: x.group, severity: x.severity, default: x.on, fixed: !!x.fixed })),
    webhook: { secretSet: webhookSecret() !== null },
    /** exactly what a webhook call contains with the present "details" setting (shown in the UI before it is enabled) */
    webhookSample: JSON.parse(webhookBody({ id: '1', ts: new Date(0), kind: 'transfer.confirmed', severity: 'info', count: 1, params: { network: 'Base', symbol: 'USDC', amount: '25' } }, s.webhook.details)) as unknown,
  });
  app.get(`${P}/settings`, async () => settingsView(await alertSettings(true)));
  app.put(`${P}/settings`, async (req) => {
    const b = SettingsPatch.parse(req.body), cur = await alertSettings(true);
    for (const k of Object.keys(b.rules ?? {})) { const def = alertDef(k); if (!def || def.fixed) throw new UserError('bad_request', `unknown alert kind ${k.slice(0, 60)}`); }
    const next: AlertSettings = { rules: { ...cur.rules, ...b.rules }, quiet: { ...cur.quiet, ...b.quiet }, showDetails: b.showDetails ?? cur.showDetails, capPerHour: b.capPerHour ?? cur.capPerHour,
      thresholds: { ...cur.thresholds, ...b.thresholds }, webhook: { ...cur.webhook, ...b.webhook } };
    if (next.webhook.enabled) {
      if (!webhookUrlOk(next.webhook.url)) throw new UserError('bad_request', 'the webhook URL must be an https URL');
      if (webhookSecret() === null) throw new UserError('bad_request', 'generate the webhook secret first');
    } else if (next.webhook.url && !webhookUrlOk(next.webhook.url)) throw new UserError('bad_request', 'the webhook URL must be an https URL');
    const saved = await saveAlertSettings(next);
    const off = Object.entries(saved.rules).filter(([k, v]) => !v && cur.rules[k] !== v).map(([k]) => k), on = Object.entries(saved.rules).filter(([k, v]) => v && cur.rules[k] !== v).map(([k]) => k);
    // a record of who silenced what: URL host only, never the secret
    await audit('alerts.settings', 'owner', { off, on, quiet: saved.quiet.enabled, showDetails: saved.showDetails, webhook: saved.webhook.enabled ? { host: new URL(saved.webhook.url).host, details: saved.webhook.details } : null });
    return settingsView(saved);
  });
  app.post(`${P}/webhook/secret`, strict, async () => {
    const secret = rotateWebhookSecret();
    await audit('alerts.webhook_secret', 'owner', {});
    return { secret };                                               // shown once; only its presence is reported afterwards
  });
  app.post(`${P}/webhook/test`, strict, async () => {
    const s = await alertSettings(true), secret = webhookSecret();
    if (!s.webhook.url || !secret) throw new UserError('bad_request', 'set the URL and generate the secret first');
    const r = await sendWebhook(s.webhook.url, secret, { id: '0', ts: new Date(d.deps.now()), kind: 'system.test', severity: 'info', params: {}, count: 1 }, s.webhook.details, { fetch: d.deps.fetch, allowHttp: d.deps.allowHttpWebhook });
    return { ok: r.ok, status: r.status, error: r.error ?? null };
  });

  // ---- Web Push: one subscription per device
  const PP = '/api/v1/push';
  const subs = () => sql<Parameters<typeof subView>[0][]>`select * from push_subscriptions order by created_at`;
  app.get(`${PP}/key`, async () => ({ publicKey: vapidKeys().publicKey }));
  app.get(`${PP}/subscriptions`, async () => (await subs()).map(subView));
  app.post(`${PP}/subscriptions`, async (req) => {
    const b = Subscription.parse(req.body);
    if (!endpointAllowed(b.endpoint)) throw new UserError('bad_request', 'this push endpoint is not one of the browsers’ push services');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from push_subscriptions where endpoint <> ${b.endpoint}`;
    if ((n?.n ?? 0) >= MAX_SUBSCRIPTIONS) throw new UserError('too_many_subscriptions', `at most ${MAX_SUBSCRIPTIONS} devices`, 422);
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
    const [row] = await sql<Parameters<typeof subView>[0][]>`insert into push_subscriptions (id, endpoint, p256dh, auth, label, locale, ua) values (${randomUUID()}, ${b.endpoint}, ${b.keys.p256dh}, ${b.keys.auth}, ${b.label}, ${b.locale}, ${ua})
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, locale = excluded.locale, ua = excluded.ua,
        label = case when excluded.label <> '' then excluded.label else push_subscriptions.label end, failures = 0, last_error = null returning *`;
    await audit('alerts.push_subscribed', 'owner', { device: row!.id, label: row!.label, service: new URL(b.endpoint).hostname });
    return subView(row!);
  });
  app.patch(`${PP}/subscriptions/:id`, async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id), b = z.strictObject({ label: z.string().trim().max(40).optional(), locale: z.enum(['fr', 'en']).optional() }).parse(req.body);
    const [row] = await sql<Parameters<typeof subView>[0][]>`update push_subscriptions set label = coalesce(${b.label ?? null}, label), locale = coalesce(${b.locale ?? null}, locale) where id = ${id} returning *`;
    if (!row) throw new UserError('not_found', 'unknown device', 404);
    return subView(row);
  });
  app.delete(`${PP}/subscriptions/:id`, async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const gone = await sql`delete from push_subscriptions where id = ${id} returning id`;
    if (gone.length) await audit('alerts.push_unsubscribed', 'owner', { device: id });
    return { ok: true };
  });
  /** a test notification to one device (or all): the real path — encryption, VAPID, the push service — with a harmless payload */
  app.post(`${PP}/test`, strict, async (req) => {
    const b = z.strictObject({ id: z.uuid().optional() }).parse(req.body ?? {});
    const list = (await sql<{ id: string; endpoint: string; p256dh: string; auth: string; locale: string }[]>`select id, endpoint, p256dh, auth, locale from push_subscriptions`).filter((s) => !b.id || s.id === b.id);
    if (!list.length) throw new UserError('not_found', 'no subscribed device', 404);
    const a = { id: '0', kind: 'system.test', severity: 'info' as const, params: {}, subject: null, count: 1, ts: new Date(d.deps.now()) };
    const res = await Promise.all(list.map(async (s) => { const r = await d.pushOne(s, a, false); return { id: s.id, ok: r.ok, status: r.status, removed: !r.ok && r.gone, error: r.ok ? null : r.error }; }));
    return { results: res };
  });
}

// Optional outgoing webhook (off by default): one HTTPS POST per alert to a URL the owner configured, signed with a shared secret.
//   X-SPW-Timestamp: <unix seconds>      X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
// The receiver recomputes the HMAC over the raw body and refuses a timestamp older than a few minutes (replay).
// What is sent is exactly `webhookBody()`: without "details" there is no amount, price, address or reason text.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { renderAlert, safeParams, type AlertParams, type AlertSeverity } from '@spw/core';

export interface WebhookAlert { id: string; ts: Date; kind: string; severity: AlertSeverity; params: AlertParams; count: number }

export function webhookBody(a: WebhookAlert, details: boolean): string {
  const text = renderAlert(a.kind, { ...a.params, count: a.params.count ?? a.count }, 'en', details);
  return JSON.stringify({ app: 'sp-wallet', id: Number(a.id), ts: a.ts.toISOString(), kind: a.kind, severity: a.severity, title: text.title, body: text.body,
    params: details ? a.params : safeParams(a.params) });
}
export const webhookSignature = (secret: string, timestamp: number, body: string): string => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
/** what a receiver does (used by tests and documented in docs/v6/ALERTS.md) */
export function verifyWebhook(secret: string, timestamp: string, signature: string, body: string, now = Date.now(), toleranceSec = 300): boolean {
  const t = Number(timestamp);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = Buffer.from(webhookSignature(secret, t, body)), got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
export function webhookUrlOk(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
export async function sendWebhook(url: string, secret: string, a: WebhookAlert, details: boolean, o: { now?: number; fetch?: typeof fetch; allowHttp?: boolean } = {}): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!o.allowHttp && !webhookUrlOk(url)) return { ok: false, status: 0, error: 'the webhook URL must be https' };
  const body = webhookBody(a, details), ts = Math.floor((o.now ?? Date.now()) / 1000);
  try {
    const r = await (o.fetch ?? fetch)(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), body,
      headers: { 'content-type': 'application/json', 'user-agent': 'sp-wallet-alerts/1', 'x-spw-timestamp': String(ts), 'x-spw-signature': webhookSignature(secret, ts, body) } });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `receiver answered ${r.status}` };
  } catch (e) { return { ok: false, status: 0, error: (e as Error).message.slice(0, 160) }; }
}

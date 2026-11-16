// Verification of the webhooks sent by SP Wallet (services/api/src/alerts/webhook.ts — `webhookSignature`, `verifyWebhook`):
//
//   X-SPW-Timestamp: <unix seconds>      X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
//
// Verify over the RAW body (the exact bytes received), before any JSON parsing. WebCrypto only: works in Node >= 20,
// browsers, workers. Delivery is at-least-once: deduplicate on the event `id`.
import { WebhookVerificationError } from './errors.ts';
import type { WebhookEventName } from './generated/openapi.ts';

export const WEBHOOK_TOLERANCE_SECONDS = 300;
export interface WebhookInput {
  /** the endpoint's signing secret (shown once when the webhook is created) */
  secret: string;
  /** header `X-SPW-Timestamp` */
  timestamp: string | number | null | undefined;
  /** header `X-SPW-Signature` */
  signature: string | null | undefined;
  /** the raw request body, exactly as received */
  body: string | Uint8Array;
  /** accepted clock difference, seconds (default 300) */
  toleranceSeconds?: number;
  /** current time in milliseconds (default Date.now()) — for tests */
  now?: number;
}
export interface WebhookEvent<D = Record<string, unknown>> { app: 'sp-wallet'; id: string; event: WebhookEventName | (string & {}); ts: string; data: D }

const enc = new TextEncoder();
const bytesOf = (b: string | Uint8Array): Uint8Array => (typeof b === 'string' ? enc.encode(b) : b);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/** constant-time comparison of two strings (length leak only, like the server's `timingSafeEqual` guard) */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
/** `v1=<hex>` for a timestamp and a raw body — what the server sends */
export async function webhookSignature(secret: string, timestamp: number, body: string | Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = enc.encode(`${timestamp}.`), raw = bytesOf(body), msg = new Uint8Array(prefix.length + raw.length);
  msg.set(prefix); msg.set(raw, prefix.length);
  return `v1=${hex(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, msg as BufferSource)))}`;
}
/** true when the signature is the server's for this body and the timestamp is within the tolerance */
export async function verifyWebhook(i: WebhookInput): Promise<boolean> {
  if (typeof i.signature !== 'string' || i.timestamp === null || i.timestamp === undefined || i.timestamp === '' || !i.secret) return false;
  const t = Number(i.timestamp);
  if (!Number.isInteger(t) || Math.abs((i.now ?? Date.now()) / 1000 - t) > (i.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return false;
  return timingSafeEqual(await webhookSignature(i.secret, t, i.body), i.signature);
}
/** verifies, then parses the event; throws WebhookVerificationError when the webhook is not authentic or not fresh */
export async function constructWebhookEvent<D = Record<string, unknown>>(i: WebhookInput): Promise<WebhookEvent<D>> {
  if (!(await verifyWebhook(i))) throw new WebhookVerificationError('webhook refused: bad signature or timestamp outside the tolerance');
  try { return JSON.parse(typeof i.body === 'string' ? i.body : new TextDecoder().decode(i.body)) as WebhookEvent<D>; }
  catch { throw new WebhookVerificationError('webhook body is not JSON'); }
}

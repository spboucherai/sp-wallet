// Web Push with Node's crypto only — no dependency.
//   RFC 8291  message encryption for Web Push (ECDH P-256 + auth secret → IKM)
//   RFC 8188  encrypted content-encoding `aes128gcm` (one record)
//   RFC 8292  VAPID (ES256 JWT, `Authorization: vapid t=…, k=…`)
//   RFC 8030  the push request itself (TTL, Urgency, 201 on success, 404/410 = subscription gone)
// The payload is encrypted for the browser's keys: the push service (Apple, Google, Mozilla) relays ciphertext it cannot read.
import { createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign as ecSign } from 'node:crypto';

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');
const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key).update(data).digest();
/** HKDF (RFC 5869) with SHA-256, one output block (every length used here is ≤ 32) */
const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Buffer => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

export interface PushKeys { /** the browser's P-256 public key, uncompressed, base64url */ p256dh: string; /** 16-byte authentication secret, base64url */ auth: string }
export interface VapidKeys { publicKey: string; privateKey: string }
/** RFC 8188 record size sent in the header; the single record is smaller */
const RS = 4096;
/** push services accept at most 4096 bytes of body; the header takes 86 and the tag and delimiter 17 */
export const MAX_PLAINTEXT = 3900;

function keysFor(ua: PushKeys, as: { privateKey: Buffer; publicKey: Buffer }, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  const uaPublic = unb64u(ua.p256dh), auth = unb64u(ua.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh is not an uncompressed P-256 point');
  if (auth.length !== 16) throw new Error('auth secret is not 16 bytes');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(as.privateKey);
  const secret = ecdh.computeSecret(uaPublic);
  // RFC 8291 §3.4
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, as.publicKey]), 32);
  // RFC 8188 §2.2, §2.3
  return { cek: hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce: hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12) };
}

/** Encrypt one push message. `ephemeral` and `salt` are random in production; tests pass the values of the RFC 8291 example. */
export function encryptPush(plaintext: Uint8Array, ua: PushKeys, o: { ephemeralPrivateKey?: Buffer; salt?: Buffer } = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large');
  const ecdh = createECDH('prime256v1');
  if (o.ephemeralPrivateKey) ecdh.setPrivateKey(o.ephemeralPrivateKey); else ecdh.generateKeys();
  const as = { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() }, salt = o.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('salt is not 16 bytes');
  const { cek, nonce } = keysFor(ua, as, salt);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  // one record: the data, then the delimiter 0x02 of a last record, no padding
  const body = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(RS);
  return Buffer.concat([salt, rs, Buffer.from([as.publicKey.length]), as.publicKey, body]);
}

/** The browser's side (tests and the fake push endpoint): decrypt a message with the subscription's private key. */
export function decryptPush(message: Uint8Array, ua: { privateKey: string; auth: string }): Buffer {
  const m = Buffer.from(message), salt = m.subarray(0, 16), idlen = m[20]!, asPublic = m.subarray(21, 21 + idlen), data = m.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(ua.privateKey));
  const uaPublic = ecdh.getPublicKey(), secret = ecdh.computeSecret(asPublic);
  const ikm = hkdf(unb64u(ua.auth), secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const dcp = createDecipheriv('aes-128-gcm', cek, nonce);
  dcp.setAuthTag(data.subarray(data.length - 16));
  const padded = Buffer.concat([dcp.update(data.subarray(0, data.length - 16)), dcp.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (end < 0 || padded[end] !== 2) throw new Error('bad padding delimiter');
  return padded.subarray(0, end);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
/** a fresh subscription key pair, as a browser would create (tests and the fake push endpoint) */
export function generateSubscriptionKeys(): PushKeys & { privateKey: string } {
  const k = generateVapidKeys();
  return { p256dh: k.publicKey, privateKey: k.privateKey, auth: b64u(randomBytes(16)) };
}

/** RFC 8292: a short-lived ES256 token bound to the push service's origin */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string, now = Date.now()): string {
  const pub = unb64u(vapid.publicKey);
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = ecSign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Hosts a subscription endpoint may point to: the browsers' push services, nothing else (an endpoint is a URL the server will POST to). */
const PUSH_HOSTS = ['.push.apple.com', 'fcm.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com', 'updates.push.services.mozilla.com'];
export function endpointAllowed(endpoint: string, extraHosts: string[] = (process.env.SPW_PUSH_ALLOW_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (extraHosts.includes(u.host) || extraHosts.includes(u.hostname)) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return PUSH_HOSTS.some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
}

export type PushOutcome = { ok: true; status: number } | { ok: false; status: number; gone: boolean; error: string };
/** One push request. Never throws: the outcome says whether the subscription is gone (404/410) and must be removed. */
export async function sendPush(sub: { endpoint: string } & PushKeys, payload: Uint8Array, vapid: VapidKeys, o: { subject: string; ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string; fetch?: typeof fetch }): Promise<PushOutcome> {
  try {
    const body = encryptPush(payload, sub);
    const r = await (o.fetch ?? fetch)(sub.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body: new Uint8Array(body),
      headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(o.ttl ?? 3600), urgency: o.urgency ?? 'normal',
        ...(o.topic ? { topic: o.topic } : {}), authorization: vapidAuthorization(sub.endpoint, vapid, o.subject) },
    });
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    return { ok: false, status: r.status, gone: r.status === 404 || r.status === 410, error: `push service answered ${r.status}` };
  } catch (e) { return { ok: false, status: 0, gone: false, error: (e as Error).message.slice(0, 160) }; }
}

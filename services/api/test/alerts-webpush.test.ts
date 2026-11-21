/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/alerts-webpush.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Web Push crypto against the worked example of RFC 8291 (section 5 and appendix A), VAPID (RFC 8292), endpoint allow-list.
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptPush, encryptPush, endpointAllowed, generateSubscriptionKeys, generateVapidKeys, MAX_PLAINTEXT, sendPush, vapidAuthorization } from '../src/alerts/webpush.ts';

// RFC 8291, appendix A
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('web push encryption (RFC 8291 / RFC 8188)', () => {
  it('produces the exact message of the RFC 8291 example', () => {
    const out = encryptPush(Buffer.from(V.plaintext), { p256dh: V.uaPublic, auth: V.auth }, { ephemeralPrivateKey: Buffer.from(V.asPrivate, 'base64url'), salt: Buffer.from(V.salt, 'base64url') });
    expect(out.toString('base64url')).toBe(V.message);
  });
  it('the user agent of the example decrypts the message', () => {
    expect(decryptPush(Buffer.from(V.message, 'base64url'), { privateKey: V.uaPrivate, auth: V.auth }).toString()).toBe(V.plaintext);
  });
  it('round-trips with random keys; a wrong auth secret or a tampered byte fails', () => {
    const k = generateSubscriptionKeys(), text = JSON.stringify({ v: 1, kind: 'system.test', é: 'accentué' });
    const a = encryptPush(Buffer.from(text), k), b = encryptPush(Buffer.from(text), k);
    expect(a.equals(b)).toBe(false);                                 // fresh salt and ephemeral key every time
    expect(decryptPush(a, k).toString()).toBe(text);
    expect(() => decryptPush(a, { privateKey: k.privateKey, auth: generateSubscriptionKeys().auth })).toThrow();
    const t = Buffer.from(a); t[t.length - 1] = t[t.length - 1]! ^ 1;
    expect(() => decryptPush(t, k)).toThrow();
  });
  it('refuses malformed keys and oversized payloads', () => {
    const k = generateSubscriptionKeys();
    expect(() => encryptPush(Buffer.from('x'), { p256dh: 'AAAA', auth: k.auth })).toThrow(/P-256/);
    expect(() => encryptPush(Buffer.from('x'), { p256dh: k.p256dh, auth: 'AAAA' })).toThrow(/16 bytes/);
    expect(() => encryptPush(Buffer.alloc(MAX_PLAINTEXT + 1), k)).toThrow(/too large/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 token for the push service origin that verifies with the public key', () => {
    const vapid = generateVapidKeys(), now = Date.parse('2026-11-11T12:00:00Z');
    const h = vapidAuthorization('https://web.push.apple.com/QGx-abc', vapid, 'mailto:owner@wallet.test', now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h)!;
    expect(m).not.toBeNull();
    expect(m[4]).toBe(vapid.publicKey);
    expect(JSON.parse(Buffer.from(m[1]!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:owner@wallet.test' });
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true);
    expect(Buffer.from(m[3]!, 'base64url').length).toBe(64);
  });
});

describe('subscription endpoints', () => {
  it('only the browsers’ push services are accepted', () => {
    for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-by3p.notify.windows.com/w/?token=x'])
      expect(endpointAllowed(ok, [])).toBe(true);
    for (const no of ['http://web.push.apple.com/abc', 'https://evil.example/push', 'https://127.0.0.1/x', 'https://push.apple.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url', 'file:///etc/passwd'])
      expect(endpointAllowed(no, [])).toBe(false);
    expect(endpointAllowed('http://127.0.0.1:9999/push/1', ['127.0.0.1:9999'])).toBe(true);   // tests: a local fake push service
  });
  it('sendPush never throws and reports a gone subscription', async () => {
    const k = generateSubscriptionKeys(), vapid = generateVapidKeys(), seen: { headers: Headers; body: Buffer }[] = [];
    const fake = (status: number) => (async (_u: unknown, init: RequestInit) => { seen.push({ headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array) }); return new Response(null, { status }); }) as typeof fetch;
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...k };
    expect(await sendPush(sub, Buffer.from('hello'), vapid, { subject: 'mailto:a@b.c', urgency: 'high', fetch: fake(201) })).toEqual({ ok: true, status: 201 });
    expect(seen[0]!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(seen[0]!.headers.get('ttl')).toBe('3600');
    expect(seen[0]!.headers.get('urgency')).toBe('high');
    expect(seen[0]!.headers.get('authorization')).toMatch(/^vapid t=/);
    expect(decryptPush(seen[0]!.body, k).toString()).toBe('hello');
    expect(await sendPush(sub, Buffer.from('x'), vapid, { subject: 's', fetch: fake(410) })).toMatchObject({ ok: false, gone: true, status: 410 });
    expect(await sendPush(sub, Buffer.from('x'), vapid, { subject: 's', fetch: fake(404) })).toMatchObject({ ok: false, gone: true });
    expect(await sendPush(sub, Buffer.from('x'), vapid, { subject: 's', fetch: fake(500) })).toMatchObject({ ok: false, gone: false });
    expect(await sendPush(sub, Buffer.from('x'), vapid, { subject: 's', fetch: (async () => { throw new Error('network down'); }) as typeof fetch })).toMatchObject({ ok: false, gone: false, error: 'network down' });
  });
});

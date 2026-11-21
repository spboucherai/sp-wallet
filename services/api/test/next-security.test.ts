/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/next-security.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — credential and session life cycle on the API, against a REAL signer instance on 127.0.0.1 (as api.test.ts does):
// passkeys are added and revoked with SPW-CRED-v2 requests the signer verifies; the signer's list is the source of truth
// (overview, mismatch, P3 lost answer, P4 API-side checks); sessions have a public id, can be revoked one by one, and their
// idle timer distinguishes interaction from polling; the last sign-ins are read from the audit chain. No network, no chain.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialHash, CredentialRequestSchema, toHex, type CredentialRequest } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { enrollChallenge, Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { createTestDb } from './test-db.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48);
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const owner = new TestPasskey(RP, ORIGIN), phone = new TestPasskey(RP, ORIGIN);
let signerSrv: Server, store: Store, signer: Signer, app: any, sql: any, auth: typeof import('../src/auth.ts'), cookie = '';

async function api(method: string, path: string, body?: unknown, opts: { cookie?: string | null; ua?: string; interaction?: boolean } = {}) {
  const headers: Record<string, string> = { 'user-agent': opts.ua ?? MAC };
  const c = opts.cookie === undefined ? cookie : opts.cookie;
  if (c) headers.cookie = c;
  if (opts.interaction) headers['x-spw-interaction'] = '1';
  if (method !== 'GET') Object.assign(headers, { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' });
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const challengeOf = (options: { challenge: string }) => Buffer.from(options.challenge, 'base64url');
async function login(pk: TestPasskey, ua = MAC) {
  const o = (await api('POST', '/api/v1/auth/login/options', {}, { cookie: null })).json;
  const r = await api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: pk.assert(challengeOf(o.options)) }, { cookie: null, ua });
  return { status: r.status, cookie: r.setCookie ? String(r.setCookie).split(';')[0]! : '' };
}
/** the three add-device calls exactly as the shipped web client makes them: it signs the returned options as they are */
async function addDevice(pk: TestPasskey, approver: TestPasskey, label: string) {
  const o = (await api('POST', '/api/v1/security/devices/options', {})).json;
  const v = (await api('POST', '/api/v1/security/devices/verify', { challengeId: o.challengeId, response: pk.register(o.options.challenge), label })).json;
  const c = await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId, assertion: approver.assert(challengeOf(v.options)) });
  return { verify: v, confirm: c };
}
async function revokeDevice(credentialId: string, approver: TestPasskey) {
  const o = await api('POST', '/api/v1/security/devices/revoke/options', { credentialId });
  if (o.status !== 200) return { options: o, confirm: null };
  return { options: o, confirm: await api('POST', '/api/v1/security/devices/revoke/confirm', { challengeId: o.json.challengeId, assertion: approver.assert(challengeOf(o.json.options)) }) };
}
const overview = async (o: Parameters<typeof api>[3] = {}) => (await api('GET', '/api/v1/security/overview', undefined, o)).json;
const auditTypes = async () => (await sql`select type from audit_events order by seq`).map((r: { type: string }) => r.type) as string[];
const signerIds = () => signer.status().credentials.map((c) => c.id);
/** the divergence was first seen long enough ago: the next look writes it to the audit chain */
const settle = () => sql`update settings set value = jsonb_set(value, '{since}', '0') where key = 'credentialMismatch'`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-next-api-'));
  store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('the-setup-token').digest('hex');
  signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
  signerSrv = createSignerServer(signer, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: (await createTestDb('next_security')).url, SPW_SIGNER_SECRET: SECRET,
    SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../src/db.ts');
  sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;');
  await db.migrate();
  await db.migrate();                                                                                    // additive and repeatable
  await db.setSetting('prices', false);
  auth = await import('../src/auth.ts');
  app = await (await import('../src/server.ts')).buildServer();
});
afterAll(async () => { await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('the first passkey and the overview', () => {
  it('the first enrolment is unchanged (setup token, legacy signer route); the overview now says what the SIGNER lists', async () => {
    const o = (await api('POST', '/api/v1/auth/setup/options', {}, { cookie: null })).json;
    const ok = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'the-setup-token', label: 'Mac' }, { cookie: null });
    expect(ok.status).toBe(200);
    cookie = String(ok.setCookie).split(';')[0]!;
    expect(store.journalRecords().map((r) => r.type)).toEqual(['credential.enrolled']);
    const ov = await overview();
    // every field the shipped clients decode is still there, same names and types
    expect(Object.keys(ov)).toEqual(expect.arrayContaining(['signer', 'devices', 'sessions', 'origin', 'broadcast']));
    expect(ov.signer).toMatchObject({ reachable: true, keyId: keys.keyId, halted: false, journalLength: 1, recoveryExportedAt: null, recoveryVerifiedAt: null, credentialCooldownSec: 0 });
    expect(ov.devices).toEqual([expect.objectContaining({ id: owner.id.slice(0, 12), label: 'Mac', enrolledOnSigner: true, credentialId: owner.id, revocable: false, inCooldown: false })]); // the last passkey
    expect(ov.signerCredentials).toEqual([{ id: owner.id, createdAt: expect.any(String), lastUsedAt: null, inCooldown: false, cooldownUntil: null, known: true, label: 'Mac', revocable: false }]);
    expect(ov.mismatch).toEqual([]);
    expect(ov.sessions).toHaveLength(1);
    expect(ov.sessions[0]).toMatchObject({ ua: MAC, current: true, device: 'Safari · Mac', credential: owner.id.slice(0, 12) });
    expect(Object.keys(ov.sessions[0])).toEqual(expect.arrayContaining(['created_at', 'last_seen', 'ua', 'ip']));
    expect(ov.sessions[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ov.currentSessionId).toBe(ov.sessions[0].id);
    // the public id says nothing about the token: it is not derived from it
    const token = cookie.split('=')[1]!, [row] = await sql`select id_hash, sid from sessions`;
    expect(row.id_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row.id_hash.includes(row.sid.replace(/-/g, '')) || token.includes(row.sid)).toBe(false);
    expect(JSON.stringify(ov)).not.toContain(row.id_hash);
    expect(JSON.stringify(ov)).not.toContain(owner.publicKey);
  });
});

describe('adding a passkey (SPW-CRED-v2, verified by the signer)', () => {
  it('the routes of the shipped web client work unchanged: the API builds the request, an enrolled passkey signs its hash, the signer pins the new passkey', async () => {
    const before = Math.floor(Date.now() / 1000);
    const o = (await api('POST', '/api/v1/security/devices/options', {})).json;
    const v = (await api('POST', '/api/v1/security/devices/verify', { challengeId: o.challengeId, response: phone.register(o.options.challenge), label: 'iPhone' })).json;
    expect(Object.keys(v).sort()).toEqual(['options', 'pendingId', 'request']);                          // `request` is the only addition
    expect(v.pendingId).toBe(phone.id);
    const request = CredentialRequestSchema.parse(v.request);
    expect(request).toMatchObject({ v: 2, action: 'add', keyId: keys.keyId, credentialId: phone.id, publicKey: phone.publicKey });
    expect(request.createdAt).toBeGreaterThanOrEqual(before);
    expect(request.expiresAt - request.createdAt).toBe(300);
    expect(v.options.challenge).toBe(Buffer.from(credentialHash(request)).toString('base64url'));         // a client can recompute what it is about to sign
    expect(v.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([owner.id]);
    expect(v.options.userVerification).toBe('required');
    // what the signer accepted before NEXT — the owner's assertion over SPW-ENROLL-v1 — adds nothing
    const legacy = await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId, assertion: owner.assert(enrollChallenge(phone.id, phone.publicKey)) });
    expect(legacy).toMatchObject({ status: 422, json: { error: 'signer_bad_approval' } });
    // the new passkey cannot approve itself; a session alone approves nothing
    expect(await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId, assertion: phone.assert(challengeOf(v.options)) })).toMatchObject({ status: 422, json: { error: 'signer_self_approval' } });
    expect((await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId })).status).toBe(400);
    expect(signerIds()).toEqual([owner.id]);
    const ok = await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId, assertion: owner.assert(challengeOf(v.options)) });
    expect(ok).toEqual({ status: 200, json: { ok: true }, setCookie: undefined });
    expect(signerIds()).toEqual([owner.id, phone.id]);
    expect(store.journalRecords().pop()).toMatchObject({ type: 'credential.added', data: { requestId: request.requestId, id: phone.id, by: owner.id, hash: toHex(credentialHash(request)) } });
    expect((await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId, assertion: owner.assert(challengeOf(v.options)) })).status).toBe(400); // the pending row is gone
    const ov = await overview();
    expect(ov.devices.map((d: any) => [d.label, d.enrolledOnSigner, d.revocable])).toEqual([['Mac', true, true], ['iPhone', true, true]]);
    expect(ov.signerCredentials.map((c: any) => [c.id, c.known, c.label, c.revocable])).toEqual([[owner.id, true, 'Mac', true], [phone.id, true, 'iPhone', true]]);
    expect(ov.signerCredentials[0].lastUsedAt).not.toBeNull();                                           // the owner's passkey just approved on the signer
    expect(ov.mismatch).toEqual([]);
    expect((await auditTypes()).filter((t) => !t.startsWith('risk.'))).toEqual(['owner.setup', 'device.added']);
    // every client following the event stream hears about it (db.ts mirrors `device.*`, `session.*` and `login.ok` audit records)
    expect((await sql`select type from wallet_events where type like 'device.%'`).map((r: any) => r.type)).toEqual(['device.added']);
  });

  it('P3 — a lost answer: the signer applied the request, the API did not record it; asking again completes the API\'s part and adds nothing twice', async () => {
    const tablet = new TestPasskey(RP, ORIGIN);
    const o = (await api('POST', '/api/v1/security/devices/options', {})).json;
    const v = (await api('POST', '/api/v1/security/devices/verify', { challengeId: o.challengeId, response: tablet.register(o.options.challenge), label: 'iPad' })).json;
    // the signer receives and applies the request; its answer never reaches the API
    await signer.credentialApply(v.request, owner.assert(challengeOf(v.options)), { counter: 0, transports: ['internal'] });
    expect((await overview()).mismatch).toEqual([{ id: tablet.id, side: 'signer' }]);                    // shown at once on the Security screen…
    expect(await auditTypes()).not.toContain('credentials.mismatch');                                    // …but not alerted on the first look: an addition may be in progress
    const again = await api('POST', '/api/v1/security/devices/confirm', { pendingId: v.pendingId, assertion: owner.assert(challengeOf(v.options)) });
    expect(again).toMatchObject({ status: 200, json: { ok: true } });
    const ov = await overview();
    expect(ov.mismatch).toEqual([]);
    expect(ov.devices.map((d: any) => d.label)).toEqual(['Mac', 'iPhone', 'iPad']);
    expect(signerIds()).toEqual([owner.id, phone.id, tablet.id]);
    expect(store.journalRecords().filter((r) => r.type === 'credential.added')).toHaveLength(2);
    // a refusal that is NOT "already applied" completes nothing: another pending passkey, a bad approval
    const other = new TestPasskey(RP, ORIGIN);
    const o2 = (await api('POST', '/api/v1/security/devices/options', {})).json;
    const v2 = (await api('POST', '/api/v1/security/devices/verify', { challengeId: o2.challengeId, response: other.register(o2.options.challenge), label: 'x' })).json;
    expect((await api('POST', '/api/v1/security/devices/confirm', { pendingId: v2.pendingId, assertion: owner.assert(challengeOf(v.options)) })).json.error).toBe('signer_bad_approval');
    expect((await sql`select count(*)::int as n from credentials`)[0].n).toBe(3);
    // revoke the tablet again: the following tests work with two passkeys
    expect((await revokeDevice(tablet.id, owner)).confirm).toMatchObject({ status: 200, json: { ok: true, signer: true } });
  });
});

describe('sessions: public id, current flag, revoke one, interaction and idle timer, last sign-ins', () => {
  let phoneCookie = '', phoneAgain = '', second = '';
  it('a sign-in is recorded with the passkey, a coarse device label and whether that device was ever seen', async () => {
    second = (await login(owner, MAC)).cookie;                                                           // the browser of the setup: known
    const first = await login(phone, IPHONE);                                                            // never seen
    phoneCookie = first.cookie;
    expect(first.status).toBe(200);
    phoneAgain = (await login(phone, IPHONE)).cookie;                                                    // seen now
    const l = (await api('GET', '/api/v1/security/logins?limit=2')).json.logins;
    expect(l).toHaveLength(2);
    const all = (await api('GET', '/api/v1/security/logins')).json.logins;                               // newest first
    expect(all.map((x: any) => [x.label, x.device, x.newDevice])).toEqual([['iPhone', 'Safari · iPhone', false], ['iPhone', 'Safari · iPhone', true], ['Mac', 'Safari · Mac', false]]);
    expect(all[0]).toMatchObject({ credential: phone.id.slice(0, 12), ip: '127.0.0.1', session: expect.stringMatching(/^[0-9a-f-]{36}$/), at: expect.any(String), seq: expect.any(Number) });
    expect(JSON.stringify(all)).not.toContain('Mozilla');                                                // a summary, never the raw user agent
    // a record written before NEXT (no label, no device) is still listed; what it does not carry is null, the label comes from the table
    await (await import('../src/db.ts')).audit('login.ok', 'owner', { credential: owner.id.slice(0, 12), ip: '203.0.113.9' });
    expect((await api('GET', '/api/v1/security/logins?limit=1')).json.logins[0]).toMatchObject({ label: 'Mac', ip: '203.0.113.9', device: null, newDevice: null, session: null });
    expect((await api('GET', '/api/v1/security/logins?limit=0')).status).toBe(400);
    expect((await api('GET', '/api/v1/security/logins', undefined, { cookie: null })).status).toBe(401);
  });

  it('the overview marks the current session; one session is revoked by its id and its cookie stops working at once', async () => {
    const mine = await overview(), theirs = await overview({ cookie: phoneCookie });
    expect(mine.sessions).toHaveLength(4);
    expect(mine.sessions.filter((s: any) => s.current).map((s: any) => s.id)).toEqual([mine.currentSessionId]);
    expect(theirs.currentSessionId).not.toBe(mine.currentSessionId);
    expect(theirs.sessions.find((s: any) => s.current)).toMatchObject({ device: 'Safari · iPhone', credential: phone.id.slice(0, 12) });
    expect(new Set(mine.sessions.map((s: any) => s.id)).size).toBe(4);
    const target = theirs.currentSessionId as string;
    expect(await api('POST', `/api/v1/security/sessions/${target}/revoke`, {})).toMatchObject({ status: 200, json: { ok: true, current: false }, setCookie: undefined });
    expect((await api('GET', '/api/v1/security/overview', undefined, { cookie: phoneCookie })).status).toBe(401); // the revoked session's cookie is dead
    expect((await api('GET', '/api/v1/accounts')).status).toBe(200);                                     // this one is not
    expect((await overview()).sessions.map((s: any) => s.id)).not.toContain(target);
    expect((await api('POST', `/api/v1/security/sessions/${target}/revoke`, {})).status).toBe(404);      // already revoked
    expect((await api('POST', '/api/v1/security/sessions/7b2c1f0e-8f5f-4b1e-9c56-000000000000/revoke', {})).status).toBe(404);
    expect((await api('POST', '/api/v1/security/sessions/not-an-id/revoke', {})).status).toBe(400);
    expect((await api('POST', `/api/v1/security/sessions/${mine.currentSessionId}/revoke`, {}, { cookie: null })).status).toBe(401);
    // revoking the session one is in: told so, cookie cleared
    const own = await api('POST', `/api/v1/security/sessions/${(await overview({ cookie: second })).currentSessionId}/revoke`, {}, { cookie: second });
    expect(own).toMatchObject({ status: 200, json: { current: true } });
    expect(String(own.setCookie)).toMatch(/__Host-spw=;/);
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: second })).status).toBe(401);
    expect((await auditTypes()).filter((t) => t === 'session.revoked')).toHaveLength(2);
    expect((await sql`select data from audit_events where type = 'session.revoked' order by seq`).map((r: any) => r.data.current)).toEqual([false, true]);
  });

  it('idle timer: a client that never marks its interactions is kept alive by any request (as before); one that does is kept alive by its interactions only', async () => {
    const age = async (c: string) => Number((await sql`select extract(epoch from now() - last_seen) as s from sessions where id_hash = ${createHash('sha256').update(c.split('=')[1]!).digest('hex')}`)[0].s);
    const backdate = (c: string, min: number) => sql`update sessions set last_seen = now() - ${min + ' minutes'}::interval where id_hash = ${createHash('sha256').update(c.split('=')[1]!).digest('hex')}`;
    // shipped client (no header, ever): polling refreshes the timer — unchanged behaviour
    await backdate(cookie, 20);
    expect((await api('GET', '/api/v1/accounts')).status).toBe(200);
    expect(await age(cookie)).toBeLessThan(5);
    // updated client: it sent the header once (a real interaction)…
    const fresh = (await login(owner, MAC)).cookie;
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: fresh, interaction: true })).status).toBe(200);
    await backdate(fresh, 20);
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: fresh })).status).toBe(200);        // …background polling still authenticates…
    expect(await age(fresh)).toBeGreaterThan(19 * 60);                                                   // …but no longer counts as activity
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: fresh, interaction: true })).status).toBe(200);
    expect(await age(fresh)).toBeLessThan(5);                                                            // an interaction does
    await backdate(fresh, 31);
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: fresh, interaction: true })).status).toBe(401); // idle for more than 30 minutes: over, header or not
  });

  it('revoking a passkey: approved by ANOTHER passkey, verified by the signer; its row and its sessions go; it opens no session any more', async () => {
    const phoneSession = phoneAgain;                                                                     // the passkey's one session still open
    // the passkey itself cannot approve its own revocation (refused by the API before the signer is asked, and the challenge is spent)
    const o = (await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: phone.id })).json;
    const request = CredentialRequestSchema.parse(o.request) as CredentialRequest;
    expect(request).toMatchObject({ v: 2, action: 'revoke', keyId: keys.keyId, credentialId: phone.id });
    expect(request.publicKey).toBeUndefined();
    expect(o.options.challenge).toBe(Buffer.from(credentialHash(request)).toString('base64url'));
    expect(o.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([owner.id]);             // never the passkey being revoked
    expect(await api('POST', '/api/v1/security/devices/revoke/confirm', { challengeId: o.challengeId, assertion: phone.assert(challengeOf(o.options)) })).toMatchObject({ status: 400, json: { error: 'self_approval' } });
    expect((await api('POST', '/api/v1/security/devices/revoke/confirm', { challengeId: o.challengeId, assertion: owner.assert(challengeOf(o.options)) })).status).toBe(401); // single-use challenge
    // an approval of something else revokes nothing
    const o2 = (await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: phone.id })).json;
    expect((await api('POST', '/api/v1/security/devices/revoke/confirm', { challengeId: o2.challengeId, assertion: owner.assert(challengeOf(o.options)) })).json.error).toBe('signer_bad_approval');
    expect(signerIds()).toEqual([owner.id, phone.id]);
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: phoneSession })).status).toBe(200);
    const r = await revokeDevice(phone.id, owner);
    expect(r.confirm).toMatchObject({ status: 200, json: { ok: true, signer: true, sessionsRevoked: 1 } });
    expect(signerIds()).toEqual([owner.id]);
    expect(store.journalRecords().pop()).toMatchObject({ type: 'credential.revoked', data: { id: phone.id, by: owner.id } });
    expect((await api('GET', '/api/v1/accounts', undefined, { cookie: phoneSession })).status).toBe(401); // its sessions are over
    expect((await login(phone, IPHONE)).status).toBe(401);                                               // and it opens no new one
    const ov = await overview();
    expect(ov.devices.map((d: any) => [d.label, d.revocable])).toEqual([['Mac', false]]);
    expect(ov.mismatch).toEqual([]);
    // the last passkey: refused by the API, and by the signer if the API were bypassed
    expect(await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: owner.id })).toMatchObject({ status: 409, json: { error: 'last_credential' } });
    expect(await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: 'A'.repeat(27) })).toMatchObject({ status: 404 });
    expect((await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: owner.id }, { cookie: null })).status).toBe(401);
    expect((await auditTypes()).filter((t) => t === 'device.revoked')).toHaveLength(2);
    expect((await sql`select data from audit_events where type = 'device.revoked' order by seq desc limit 1`)[0].data).toMatchObject({ credential: phone.id.slice(0, 12), label: 'iPhone', signer: true, sessions: 1 });
  });
});

describe('the signer\'s list is the source of truth (P1, P3, P4)', () => {
  const rogue = new TestPasskey(RP, ORIGIN), stale = new TestPasskey(RP, ORIGIN);
  it('a passkey pinned on the signer only is SHOWN, alerted once the divergence lasts, and can be revoked from the app', async () => {
    // pinned on the signer without the API's table knowing (what the old Security screen never showed)
    const now = Math.floor(Date.now() / 1000), add: CredentialRequest = { v: 2, action: 'add', requestId: crypto.randomUUID(), keyId: keys.keyId, credentialId: rogue.id, publicKey: rogue.publicKey, createdAt: now, expiresAt: now + 300 };
    await signer.credentialApply(add, owner.assert(credentialHash(add)));
    let ov = await overview();
    expect(ov.mismatch).toEqual([{ id: rogue.id, side: 'signer' }]);
    expect(ov.signerCredentials.map((c: any) => [c.id, c.known, c.label, c.revocable])).toEqual([[owner.id, true, 'Mac', true], [rogue.id, false, null, true]]);
    expect(ov.devices).toHaveLength(1);
    expect(await auditTypes()).not.toContain('credentials.mismatch');
    await settle();
    ov = await overview(); await overview();
    const events = await sql`select data from audit_events where type = 'credentials.mismatch'`;
    expect(events).toHaveLength(1);                                                                      // once, however often the screen is polled
    expect(events[0].data).toEqual({ count: 1, signerOnly: [rogue.id.slice(0, 12)], apiOnly: [] });
    // the rule turns that event into the critical alert
    const { deriveAlerts } = await import('../src/alerts/rules.ts');
    expect(await deriveAlerts({ source: 'audit', id: 7, ts: new Date(), type: 'credentials.mismatch', data: events[0].data }, { q: sql, settings: {} as never } as never))
      .toEqual([{ kind: 'security.credential_mismatch', params: { count: 1 }, subject: { type: 'none' }, dedupe: 'cred_mismatch:7' }]);
    // it is revoked like any other, by a passkey the signer lists
    expect((await revokeDevice(rogue.id, owner)).confirm).toMatchObject({ status: 200, json: { ok: true, signer: true, sessionsRevoked: 0 } });
    expect(signerIds()).toEqual([owner.id]);
    expect((await overview()).mismatch).toEqual([]);
    expect((await auditTypes()).slice(-2)).toEqual(['device.revoked', 'credentials.reconciled']);
  });

  it('P4 — a row the signer does not list approves nothing on the API, opens no session, and can be removed', async () => {
    await sql`insert into credentials (id, public_key, counter, transports, label) values (${stale.id}, ${stale.publicKey}, 0, '[]', 'Old laptop')`;
    const challenge = new Uint8Array(32).fill(7);
    await expect(auth.verifyOwnerAssertion(stale.assert(challenge), challenge)).rejects.toThrow(/not enrolled on the signer/);
    await expect(auth.verifyOwnerAssertion(owner.assert(challenge), challenge)).resolves.toBeUndefined();
    await expect(auth.verifyOwnerAssertion(owner.assert(challenge), new Uint8Array(32).fill(8))).rejects.toThrow();
    expect((await login(stale)).status).toBe(401);
    expect((await sql`select data from audit_events where type = 'login.failed' order by seq desc limit 1`)[0].data.why).toBe('not enrolled on the signer');
    const ov = await overview();
    expect(ov.mismatch).toEqual([{ id: stale.id, side: 'api' }]);
    expect(ov.devices.map((d: any) => [d.label, d.enrolledOnSigner, d.revocable])).toEqual([['Mac', true, false], ['Old laptop', false, true]]);
    // it is never offered as an approver, and cannot approve its own removal
    const o = (await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: stale.id })).json;
    expect(o.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([owner.id]);
    expect((await api('POST', '/api/v1/security/devices/revoke/confirm', { challengeId: o.challengeId, assertion: stale.assert(challengeOf(o.options)) })).json.error).toBe('self_approval');
    const journal = store.journalRecords().length;
    expect((await revokeDevice(stale.id, owner)).confirm).toMatchObject({ status: 200, json: { ok: true, signer: false } });
    expect(store.journalRecords()).toHaveLength(journal);                                                // the signer had nothing to revoke and was not asked to
    expect((await overview()).mismatch).toEqual([]);
    expect((await sql`select count(*)::int as n from credentials`)[0].n).toBe(1);
  });

  it('cool-down set on the signer: the new passkey is shown as such, is not offered as an approver and approves nothing on the API either', async () => {
    store.policy = { ...store.policy, newCredentialCooldownSec: 3600 };
    const laptop = new TestPasskey(RP, ORIGIN), added = await addDevice(laptop, owner, 'Laptop');
    expect(added.confirm.status).toBe(200);
    const ov = await overview();
    expect(ov.signer.credentialCooldownSec).toBe(3600);
    expect(ov.devices.map((d: any) => [d.label, d.inCooldown])).toEqual([['Mac', false], ['Laptop', true]]);
    expect(ov.signerCredentials[1]).toMatchObject({ id: laptop.id, inCooldown: true, cooldownUntil: expect.any(Number) });
    const challenge = new Uint8Array(32).fill(9);
    await expect(auth.verifyOwnerAssertion(laptop.assert(challenge), challenge)).rejects.toThrow(/added recently/);
    expect((await login(laptop)).status).toBe(200);                                                      // it can still sign in
    // it cannot evict the passkey that was there before it: nobody is left to approve that
    expect(await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: owner.id })).toMatchObject({ status: 409, json: { error: 'no_approver' } });
    store.policy = { ...store.policy, newCredentialCooldownSec: 0 };
    expect((await overview()).devices.map((d: any) => d.inCooldown)).toEqual([false, false]);
  });

  it('under the emergency halt no passkey is added; one can still be revoked', async () => {
    expect((await api('POST', '/api/v1/security/emergency-halt', {})).status).toBe(200);
    const extra = new TestPasskey(RP, ORIGIN);
    expect((await addDevice(extra, owner, 'Extra')).confirm).toMatchObject({ status: 422, json: { error: 'signer_policy' } });
    const laptopId = (await overview()).devices[1].credentialId as string;
    expect((await revokeDevice(laptopId, owner)).confirm).toMatchObject({ status: 200, json: { ok: true, signer: true } });
    expect(signerIds()).toEqual([owner.id]);
  });

  it('signer unreachable: the overview says so and offers no revocation; API-side approvals fail closed; signing in to VIEW still works', async () => {
    await new Promise((r) => signerSrv.close(r));
    const ov = await overview();
    expect(ov).toMatchObject({ signer: { reachable: false }, signerCredentials: null, mismatch: null });
    expect(ov.devices.map((d: any) => [d.enrolledOnSigner, d.revocable])).toEqual([[false, false]]);
    const challenge = new Uint8Array(32).fill(3);
    await expect(auth.verifyOwnerAssertion(owner.assert(challenge), challenge)).rejects.toThrow(/does not answer/);
    expect((await api('POST', '/api/v1/security/devices/revoke/options', { credentialId: owner.id })).status).toBe(503);
    expect((await login(owner)).status).toBe(200);
  });
});

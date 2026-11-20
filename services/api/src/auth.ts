import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { CRED_MAX_TTL_SEC, credentialHash, CredentialRequestSchema, type CredentialRequest } from '@spw/core';
import { describeUa } from './alerts/rules.ts';
import { config, secureCookies, UserError } from './config.ts';
import { audit, getSetting, setSetting, sql, walletEvent } from './db.ts';
import { signer, type SignerStatus } from './signer-client.ts';

export const COOKIE = secureCookies ? '__Host-spw' : 'spw';
const IDLE_MIN = 30, ABSOLUTE_H = 12;
const h = (s: string) => createHash('sha256').update(s).digest('hex');

interface Cred { id: string; public_key: string; counter: string; transports: string[]; label: string; created_at: Date; last_used_at: Date | null; device_type: string; backed_up: boolean }
export const listCreds = () => sql<Cred[]>`select * from credentials order by created_at`;

async function putChallenge(kind: string, challenge: string): Promise<string> {
  const id = randomUUID();
  await sql`delete from challenges where expires_at < now()`;
  await sql`insert into challenges (id, kind, challenge, expires_at) values (${id}, ${kind}, ${challenge}, now() + interval '3 minutes')`;
  return id;
}
async function takeChallenge(id: string, kind: string): Promise<string> {
  const [r] = await sql<{ challenge: string }[]>`delete from challenges where id = ${id} and kind = ${kind} and expires_at > now() returning challenge`;
  if (!r) throw new UserError('challenge_expired', 'challenge expired, try again', 401);
  return r.challenge;
}

/**
 * NEXT: a session has a PUBLIC id (`sid`, random, stored next to the token's hash and unrelated to it) — what the Security
 * screen lists and what `POST /security/sessions/:id/revoke` names — and remembers the passkey that opened it.
 */
async function startSession(req: FastifyRequest, reply: FastifyReply, credentialId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url'), sid = randomUUID();
  await sql`insert into sessions (id_hash, sid, credential_id, expires_at, ua, ip) values (${h(token)}, ${sid}, ${credentialId}, now() + ${ABSOLUTE_H + ' hours'}::interval, ${String(req.headers['user-agent'] ?? '').slice(0, 200)}, ${req.ip})`;
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/', maxAge: ABSOLUTE_H * 3600 });
  return sid;
}

/** The signer's status for a decision that must not hang on it: null when it does not answer within `ms`. */
const signerNow = (ms = 4000): Promise<SignerStatus | null> => Promise.race([signer.status(true).catch(() => null),
  new Promise<null>((r) => { setTimeout(() => r(null), ms).unref(); })]);

/**
 * V11: a WebAuthn assertion of an enrolled passkey over `challenge`, with user verification. Used where an API-side decision must
 * not rest on the session cookie alone (loosening a risk limit, lifting a halt). Throws when it does not verify. This is the
 * API's own check against a stolen session; it is NOT the signer's judgement and nothing is signed on its strength.
 *
 * NEXT (audit P4): the passkey must ALSO be on the signer's list, and out of its cool-down — the signer's set is the source of
 * truth, this table is a copy. A passkey revoked on the signer whose row survived here approves nothing. Fails closed when the
 * signer does not answer.
 */
export async function verifyOwnerAssertion(assertion: unknown, challenge: Uint8Array): Promise<void> {
  const response = assertion as AuthenticationResponseJSON;
  const [cred] = await sql<Cred[]>`select * from credentials where id = ${String(response?.id ?? '')}`;
  if (!cred) throw new Error('unknown credential');
  const st = await signerNow();
  if (!st) throw new Error('the signer does not answer: the passkey cannot be checked against its list');
  const pinned = st.credentials.find((c) => c.id === cred.id);
  if (!pinned) throw new Error('this passkey is not enrolled on the signer');
  if (pinned.inCooldown) throw new Error('this passkey was added recently: it cannot approve anything yet');
  const v = await verifyAuthenticationResponse({ response, expectedChallenge: Buffer.from(challenge).toString('base64url'), expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true,
    credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')), counter: Number(cred.counter), transports: cred.transports as never } });
  if (!v.verified || !v.authenticationInfo.userVerified) throw new Error('approval not verified');
  await sql`update credentials set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${cred.id}`;
}

/**
 * NEXT — what keeps a session alive. The idle timer (30 min) is `last_seen`. A client that marks its requests made on a real
 * interaction of the user with the header `X-SPW-Interaction: 1` is from then on kept alive by THOSE requests only: its
 * background polling no longer refreshes the timer. A session that never sent the header (every client shipped before NEXT)
 * keeps the previous behaviour — any authenticated request refreshes it — so no shipped client is logged out by this change.
 */
const INTERACTION_HEADER = 'x-spw-interaction';
export async function isAuthed(req: FastifyRequest): Promise<boolean> {
  const token = req.cookies[COOKIE];
  if (!token || token.length > 100) return false;
  const active = req.headers[INTERACTION_HEADER] === '1';
  const [s] = await sql`update sessions set last_seen = case when ${active} or not interactive then now() else last_seen end, interactive = interactive or ${active}
    where id_hash = ${h(token)} and not revoked and expires_at > now() and last_seen > now() - ${IDLE_MIN + ' minutes'}::interval returning id_hash`;
  return !!s;
}
/** the public id of the session this request carries (null: none, or no longer valid). Read-only. */
export async function currentSessionId(req: FastifyRequest): Promise<string | null> {
  const token = req.cookies[COOKIE];
  if (!token || token.length > 100) return null;
  const [s] = await sql<{ sid: string }[]>`select sid from sessions where id_hash = ${h(token)} and not revoked and expires_at > now()`;
  return s?.sid ?? null;
}

/** v11 quote engine: is this session token still valid? READ-ONLY — it does not refresh `last_seen`: an open websocket re-checks
 *  its session with it and must not keep an idle session alive by itself. */
export async function sessionAlive(token: string | undefined): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const [s] = await sql`select 1 as ok from sessions where id_hash = ${h(token)} and not revoked and expires_at > now() and last_seen > now() - ${IDLE_MIN + ' minutes'}::interval`;
  return !!s;
}

/**
 * NEXT (audit P1, P3) — the signer's passkeys against this table. `mismatch`: every credential id known to one side only
 * (`signer`: pinned on the signer, no row here — it can approve and is shown nowhere else; `api`: a row here the signer does
 * not list — it approves nothing). A divergence that is still there on a second look at least MISMATCH_SETTLE_MS later is
 * written ONCE to the audit chain (`credentials.mismatch` → alert `security.credential_mismatch`, alerts/rules.ts), and once
 * more when it is gone. The delay keeps the instant between the signer's answer and this table's own write, during an
 * addition or a revocation in progress, from raising an alert. Null when the signer did not answer: nothing can be said.
 */
export const MISMATCH_SETTLE_MS = 30_000;
export interface CredentialMismatch { id: string; side: 'signer' | 'api' }
export async function credentialSets(st: Pick<SignerStatus, 'credentials'> | null, now = Date.now()): Promise<{ creds: Cred[]; mismatch: CredentialMismatch[] | null }> {
  const creds = await listCreds();
  if (!st || !Array.isArray(st.credentials)) return { creds, mismatch: null };
  const mismatch: CredentialMismatch[] = [
    ...st.credentials.filter((c) => !creds.some((x) => x.id === c.id)).map((c) => ({ id: c.id, side: 'signer' as const })),
    ...creds.filter((c) => !st.credentials.some((x) => x.id === c.id)).map((c) => ({ id: c.id, side: 'api' as const }))];
  const sig = mismatch.map((m) => `${m.side}:${m.id}`).sort().join(',');
  const prev = await getSetting<{ sig: string; since: number; said: boolean }>('credentialMismatch', { sig: '', since: 0, said: true });
  if (sig !== prev.sig) {
    await setSetting('credentialMismatch', { sig, since: now, said: sig === '' });
    if (sig === '' && prev.said) await audit('credentials.reconciled', 'api', {});
  } else if (!prev.said && now - prev.since >= MISMATCH_SETTLE_MS) {
    await setSetting('credentialMismatch', { ...prev, said: true });
    await audit('credentials.mismatch', 'api', { count: mismatch.length, signerOnly: mismatch.filter((m) => m.side === 'signer').map((m) => m.id.slice(0, 12)), apiOnly: mismatch.filter((m) => m.side === 'api').map((m) => m.id.slice(0, 12)) });
  }
  return { creds, mismatch };
}

const RegBody = z.object({ challengeId: z.uuid(), response: z.any(), setupToken: z.string().min(8).max(100).optional(), label: z.string().max(40).optional() });
const AuthBody = z.object({ challengeId: z.uuid(), response: z.any() });
const regOptions = async (exclude: Cred[]) => generateRegistrationOptions({
  rpName: 'SP Wallet', rpID: config.rpId, userName: 'owner', userDisplayName: 'SP Wallet', userID: new TextEncoder().encode('sp-wallet-owner'),
  attestationType: 'none', excludeCredentials: exclude.map((c) => ({ id: c.id, transports: c.transports as never })),
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
});
async function verifyReg(body: z.infer<typeof RegBody>, kind: string) {
  const expectedChallenge = await takeChallenge(body.challengeId, kind);
  const v = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge, expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true })
    .catch((e: Error) => { throw new UserError('registration_failed', e.message, 401); });
  if (!v.verified) throw new UserError('registration_failed', 'passkey registration not verified', 401);
  const c = v.registrationInfo.credential;
  return { id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: (c.transports ?? []) as string[],
    deviceType: v.registrationInfo.credentialDeviceType, backedUp: v.registrationInfo.credentialBackedUp };
}

export function authRoutes(app: FastifyInstance): void {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/v1/auth/state', async (req) => {
    const n = (await listCreds()).length;
    return { setupRequired: n === 0, authenticated: await isAuthed(req) };
  });

  // --- one-time owner setup: closed forever once a passkey exists -------------------------------------------
  app.post('/api/v1/auth/setup/options', strict, async () => {
    if ((await listCreds()).length > 0) throw new UserError('setup_closed', 'setup already completed', 403);
    const options = await regOptions([]);
    return { challengeId: await putChallenge('setup', options.challenge), options };
  });
  app.post('/api/v1/auth/setup/verify', strict, async (req, reply) => {
    const body = RegBody.parse(req.body);
    if ((await listCreds()).length > 0) throw new UserError('setup_closed', 'setup already completed', 403);
    if (!body.setupToken) throw new UserError('setup_token', 'setup token required', 403);
    const c = await verifyReg(body, 'setup');
    // the signer validates the one-time token and pins this passkey as the only approver
    await signer.enroll({ credential: { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports }, setupToken: body.setupToken });
    await sql`insert into credentials (id, public_key, counter, transports, label, device_type, backed_up) values (${c.id}, ${c.publicKey}, ${c.counter}, ${sql.json(c.transports)}, ${body.label ?? 'Passkey 1'}, ${c.deviceType}, ${c.backedUp})`;
    await audit('owner.setup', 'owner', { credential: c.id.slice(0, 12) });
    await startSession(req, reply, c.id);
    return { ok: true };
  });

  // --- login -------------------------------------------------------------------------------------------------
  app.post('/api/v1/auth/login/options', strict, async () => {
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', allowCredentials: [] });
    return { challengeId: await putChallenge('login', options.challenge), options };
  });
  app.post('/api/v1/auth/login/verify', strict, async (req, reply) => {
    const body = AuthBody.parse(req.body);
    const response = body.response as AuthenticationResponseJSON;
    const expectedChallenge = await takeChallenge(body.challengeId, 'login');
    const [cred] = await sql<Cred[]>`select * from credentials where id = ${String(response?.id ?? '')}`;
    const fail = async (why: string) => { await audit('login.failed', 'unknown', { why, ip: req.ip }); throw new UserError('login_failed', 'authentication failed', 401); };
    if (!cred) return fail('unknown credential');
    const v = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true,
      credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')), counter: Number(cred.counter), transports: cred.transports as never } }).catch(() => null);
    if (!v?.verified) return fail('bad assertion');
    // NEXT (P4): a passkey the signer no longer lists — revoked there while its row survived here — opens no session. When the
    // signer does not answer, or holds no passkey at all (operator reset), this table alone decides, as before NEXT: the wallet
    // can then still be VIEWED, and nothing can be approved anyway.
    const st = await signerNow();
    if (st && st.credentials.length > 0 && !st.credentials.some((c) => c.id === cred.id)) return fail('not enrolled on the signer');
    await sql`update credentials set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${cred.id}`;
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
    const [seen] = await sql`select 1 as x from sessions where ua = ${ua} limit 1`;                      // before this login's own session exists
    const sid = await startSession(req, reply, cred.id);
    // NEXT: who, from where, with what — a coarse device label (browser · system), never the raw user agent; `newDevice` = no session was ever opened with this user agent
    await audit('login.ok', 'owner', { credential: cred.id.slice(0, 12), ip: req.ip, label: cred.label, device: describeUa(ua), newDevice: !seen, session: sid });
    return { ok: true };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await sql`update sessions set revoked = true where id_hash = ${h(t)}`;
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}

/** the passkeys that may approve a credential request about `target`: on this table AND on the signer's list, out of cool-down, and not the target itself */
const approvers = (creds: Cred[], st: SignerStatus, target: string) =>
  creds.filter((c) => c.id !== target && st.credentials.some((x) => x.id === c.id && !x.inCooldown)).map((c) => ({ id: c.id, transports: c.transports as never }));
const credRequest = (st: SignerStatus, action: 'add' | 'revoke', credentialId: string, publicKey?: string): CredentialRequest => {
  const now = Math.floor(Date.now() / 1000);
  return { v: 2, action, requestId: randomUUID(), keyId: st.keyId, credentialId, ...(publicKey !== undefined ? { publicKey } : {}), createdAt: now, expiresAt: now + CRED_MAX_TTL_SEC };
};

/**
 * Authenticated: add a passkey, revoke a passkey, revoke a session.
 *
 * NEXT (audit P1) — a passkey is added or revoked with a canonical, expiring, single-use request (`SPW-CRED-v2`,
 * packages/core/src/credential.ts) that THIS server builds and that ANOTHER enrolled passkey approves; the signer verifies
 * the approval itself (`POST /credential`) and its list is the source of truth. The three add routes keep their paths, bodies
 * and answers (plus `request` in the answer of `verify`): a client that signs the returned `options` as they are — the web
 * app — works unchanged. A client that recomputes the challenge with the old `SPW-ENROLL-v1` formula (the native apps 1.0)
 * finds it different and stops before any passkey prompt: it must be updated to add a passkey (docs/runbooks/deploy.md, "Signer changes of NEXT").
 */
export function deviceRoutes(app: FastifyInstance): void {
  app.post('/api/v1/security/devices/options', async () => {
    const options = await regOptions(await listCreds());
    return { challengeId: await putChallenge('add-device', options.challenge), options };
  });
  app.post('/api/v1/security/devices/verify', async (req) => {
    const body = RegBody.parse(req.body);
    const c = await verifyReg(body, 'add-device');
    const st = await signer.status(true);
    const request = credRequest(st, 'add', c.id, c.publicKey);
    await sql`delete from pending_credentials where expires_at < now()`;
    // the row and its request always describe the same key: a second registration under the same id replaces both
    await sql`insert into pending_credentials (id, public_key, counter, transports, label, device_type, backed_up, request, expires_at)
      values (${c.id}, ${c.publicKey}, ${c.counter}, ${sql.json(c.transports)}, ${body.label ?? 'Passkey'}, ${c.deviceType}, ${c.backedUp}, ${sql.json(request)}, now() + ${CRED_MAX_TTL_SEC + ' seconds'}::interval)
      on conflict (id) do update set public_key = excluded.public_key, counter = excluded.counter, transports = excluded.transports, label = excluded.label,
        device_type = excluded.device_type, backed_up = excluded.backed_up, request = excluded.request, expires_at = excluded.expires_at`;
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(credentialHash(request)), allowCredentials: approvers(await listCreds(), st, c.id) });
    return { pendingId: c.id, options, request };
  });
  app.post('/api/v1/security/devices/confirm', async (req) => {
    const body = z.object({ pendingId: z.string().max(1024), assertion: z.any() }).parse(req.body);
    const [p] = await sql`select * from pending_credentials where id = ${body.pendingId} and expires_at > now()`;
    const request = CredentialRequestSchema.safeParse(p?.request);
    if (!p || !request.success || request.data.action !== 'add' || request.data.credentialId !== p.id) throw new UserError('expired', 'pending passkey expired', 400);
    try { await signer.credential({ request: request.data, assertion: body.assertion, credential: { counter: Number(p.counter), transports: p.transports } }); }
    catch (e) {
      // NEXT (audit P3) — a lost answer. The signer says THIS request (its id was generated here, for this row) was already
      // applied, and lists the passkey: the addition succeeded and only this table's row is missing. Anything else is a refusal.
      if ((e as UserError).code !== 'signer_replay' || !(await signer.status(true)).credentials.some((c) => c.id === p.id)) throw e;
    }
    await sql`insert into credentials (id, public_key, counter, transports, label, device_type, backed_up) values (${p.id}, ${request.data.publicKey!}, ${p.counter}, ${sql.json(p.transports)}, ${p.label}, ${p.device_type}, ${p.backed_up})
      on conflict (id) do nothing`;
    await sql`delete from pending_credentials where id = ${p.id}`;
    await audit('device.added', 'owner', { credential: String(p.id).slice(0, 12), label: p.label });
    await walletEvent('credential.added', String(p.id).slice(0, 12), { label: p.label });
    return { ok: true };
  });

  // NEXT — revoke ONE passkey. The approval comes from ANOTHER enrolled passkey and is verified by the signer; then this
  // table's row goes, and the sessions that passkey opened. A row the signer does not list (it approves nothing) is removed
  // on the API's own verification of the same request, by a passkey the signer does list (`verifyOwnerAssertion`).
  app.post('/api/v1/security/devices/revoke/options', async (req) => {
    const body = z.strictObject({ credentialId: z.string().min(16).max(1024) }).parse(req.body);
    const st = await signer.status(true), creds = await listCreds();
    const onSigner = st.credentials.some((c) => c.id === body.credentialId);
    if (!onSigner && !creds.some((c) => c.id === body.credentialId)) throw new UserError('not_found', 'no such passkey', 404);
    if (onSigner && st.credentials.length <= 1) throw new UserError('last_credential', 'the last passkey cannot be revoked', 409);
    const allow = approvers(creds, st, body.credentialId);
    if (allow.length === 0) throw new UserError('no_approver', 'no other passkey can approve this revocation', 409);
    const request = credRequest(st, 'revoke', body.credentialId);
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(credentialHash(request)), allowCredentials: allow });
    return { challengeId: await putChallenge('revoke-device', JSON.stringify(request)), request, options };
  });
  app.post('/api/v1/security/devices/revoke/confirm', async (req) => {
    const body = z.object({ challengeId: z.uuid(), assertion: z.any() }).parse(req.body);
    const request = CredentialRequestSchema.parse(JSON.parse(await takeChallenge(body.challengeId, 'revoke-device')));
    const id = request.credentialId;
    if (String((body.assertion as { id?: unknown } | null)?.id ?? '') === id) throw new UserError('self_approval', 'a passkey cannot approve its own revocation', 400);
    const onSigner = (await signer.status(true)).credentials.some((c) => c.id === id);
    if (onSigner) await signer.credential({ request, assertion: body.assertion });
    else await verifyOwnerAssertion(body.assertion, credentialHash(request)).catch((e: Error) => { throw new UserError('bad_approval', e.message, 422); });
    const [gone] = await sql<{ label: string }[]>`delete from credentials where id = ${id} returning label`;
    await sql`delete from pending_credentials where id = ${id}`;
    const ended = await sql`update sessions set revoked = true where credential_id = ${id} and not revoked returning sid`;
    await audit('device.revoked', 'owner', { credential: id.slice(0, 12), label: gone?.label ?? '', signer: onSigner, sessions: ended.length, ip: req.ip });
    await walletEvent('credential.revoked', id.slice(0, 12), { label: gone?.label ?? '', sessions: ended.length });
    return { ok: true, signer: onSigner, sessionsRevoked: ended.length };
  });

  app.post('/api/v1/security/sessions/revoke-all', async (req, reply) => {
    await sql`update sessions set revoked = true where not revoked`;
    reply.clearCookie(COOKIE, { path: '/' });
    await audit('sessions.revoked', 'owner', { ip: req.ip });
    return { ok: true };
  });
  // NEXT — revoke ONE session by its public id (the `id` of `sessions[]` in GET /security/overview)
  app.post('/api/v1/security/sessions/:id/revoke', async (req, reply) => {
    const sid = z.uuid().parse((req.params as { id: string }).id);
    const current = (await currentSessionId(req)) === sid;
    const [s] = await sql`update sessions set revoked = true where sid = ${sid} and not revoked and expires_at > now() returning sid`;
    if (!s) throw new UserError('not_found', 'no such active session', 404);
    if (current) reply.clearCookie(COOKIE, { path: '/' });
    await audit('session.revoked', 'owner', { session: sid, current, ip: req.ip });
    await walletEvent('session.revoked', sid, { current });
    return { ok: true, current };
  });
}

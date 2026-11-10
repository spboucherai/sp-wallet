import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { config, secureCookies, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { signer } from './signer-client.ts';

export const COOKIE = secureCookies ? '__Host-spw' : 'spw';
const IDLE_MIN = 30, ABSOLUTE_H = 12;
const h = (s: string) => createHash('sha256').update(s).digest('hex');
const enrollChallenge = (id: string, pk: string) => createHash('sha256').update(`SPW-ENROLL-v1\n${id}\n${pk}`).digest();

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

async function startSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at, ua, ip) values (${h(token)}, now() + ${ABSOLUTE_H + ' hours'}::interval, ${String(req.headers['user-agent'] ?? '').slice(0, 200)}, ${req.ip})`;
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/', maxAge: ABSOLUTE_H * 3600 });
}

export async function isAuthed(req: FastifyRequest): Promise<boolean> {
  const token = req.cookies[COOKIE];
  if (!token || token.length > 100) return false;
  const [s] = await sql`update sessions set last_seen = now() where id_hash = ${h(token)} and not revoked and expires_at > now()
    and last_seen > now() - ${IDLE_MIN + ' minutes'}::interval returning id_hash`;
  return !!s;
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
    await startSession(req, reply);
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
    await sql`update credentials set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${cred.id}`;
    await audit('login.ok', 'owner', { credential: cred.id.slice(0, 12), ip: req.ip });
    await startSession(req, reply);
    return { ok: true };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await sql`update sessions set revoked = true where id_hash = ${h(t)}`;
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}

/** Authenticated: add a second passkey. The signer only accepts it with an assertion from an existing passkey. */
export function deviceRoutes(app: FastifyInstance): void {
  app.post('/api/v1/security/devices/options', async () => {
    const options = await regOptions(await listCreds());
    return { challengeId: await putChallenge('add-device', options.challenge), options };
  });
  app.post('/api/v1/security/devices/verify', async (req) => {
    const body = RegBody.parse(req.body);
    const c = await verifyReg(body, 'add-device');
    await sql`delete from pending_credentials where expires_at < now()`;
    await sql`insert into pending_credentials (id, public_key, counter, transports, label, device_type, backed_up, expires_at)
      values (${c.id}, ${c.publicKey}, ${c.counter}, ${sql.json(c.transports)}, ${body.label ?? 'Passkey'}, ${c.deviceType}, ${c.backedUp}, now() + interval '5 minutes')
      on conflict (id) do update set expires_at = excluded.expires_at`;
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(enrollChallenge(c.id, c.publicKey)),
      allowCredentials: creds.map((x) => ({ id: x.id, transports: x.transports as never })) });
    return { pendingId: c.id, options };
  });
  app.post('/api/v1/security/devices/confirm', async (req) => {
    const body = z.object({ pendingId: z.string().max(1024), assertion: z.any() }).parse(req.body);
    const [p] = await sql`select * from pending_credentials where id = ${body.pendingId} and expires_at > now()`;
    if (!p) throw new UserError('expired', 'pending passkey expired', 400);
    await signer.enroll({ credential: { id: p.id, publicKey: p.public_key, counter: Number(p.counter), transports: p.transports }, assertion: body.assertion });
    await sql`insert into credentials (id, public_key, counter, transports, label, device_type, backed_up) values (${p.id}, ${p.public_key}, ${p.counter}, ${sql.json(p.transports)}, ${p.label}, ${p.device_type}, ${p.backed_up})`;
    await sql`delete from pending_credentials where id = ${p.id}`;
    await audit('device.added', 'owner', { credential: String(p.id).slice(0, 12), label: p.label });
    return { ok: true };
  });
  app.post('/api/v1/security/sessions/revoke-all', async (req, reply) => {
    await sql`update sessions set revoked = true where not revoked`;
    reply.clearCookie(COOKIE, { path: '/' });
    await audit('sessions.revoked', 'owner', { ip: req.ip });
    return { ok: true };
  });
}

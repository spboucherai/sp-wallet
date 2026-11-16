// API keys — storage, verification, and the passkey-approved intents of key management.
//
// Owner approval. Creating a key, rotating it, or giving it more authority is approved by a WebAuthn assertion whose challenge
// is SHA-256("SPW-APIKEY-INTENT-v1\n" ‖ canonical intent). The intent is built and stored by the server (prepare), the browser
// only signs it: what the passkey signed is exactly what is applied, once, within 3 minutes. The assertion is verified HERE,
// with the API's own copy of the enrolled passkeys (the mechanism of auth.ts) — not by the isolated signer: the signer's
// approvals are bound to its own intent kinds (transfers, mandates, venue authorizations) and an API key is not a signer
// object. Consequence, stated in docs/TRADING-API-SECURITY.md: this approval protects against a stolen session, not against a
// compromised API process — which is why a key's execution authority must come from a signer-enforced mandate.
import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { config, UserError } from '../config.ts';
import { listCreds } from '../auth.ts';
import { audit, sql } from '../db.ts';
import { applyChanges, canonicalJson, formatToken, hashSecret, inertScopes, intentChallenge, KEY_ID_RE, newKeyId, newKeySecret, parseToken, sameHash, type KeyFacts } from './key-model.ts';
import { apiKeyPepper } from './secrets.ts';
import { KEY_BOUNDS, LimitsSchema, RestrictionsSchema, type KeyChanges, type KeyCreate, type Limits, type Restrictions, type Scope } from './spec.ts';

export interface KeyRow {
  id: string; name: string; secret_hash: string; scopes: Scope[]; limits: Limits; restrictions: Restrictions; rate_limit_per_min: number; mandate_id: string | null;
  rotated_from: string | null; created_at: Date; expires_at: Date; revoked_at: Date | null; revoked_reason: string | null; last_used_at: Date | null; last_used_ip: string | null;
}
const INTENT_TTL_MS = 3 * 60_000;
const DAY = 86_400_000;
export type KeyStatus = 'active' | 'expired' | 'revoked';
export const keyStatus = (k: Pick<KeyRow, 'revoked_at' | 'expires_at'>, now = Date.now()): KeyStatus => (k.revoked_at ? 'revoked' : k.expires_at.getTime() <= now ? 'expired' : 'active');
const norm = (k: KeyRow): KeyRow => ({ ...k, limits: LimitsSchema.parse(k.limits), restrictions: RestrictionsSchema.parse(k.restrictions) });
/** what the owner sees: never the hash */
export const keyView = (k: KeyRow) => ({
  id: k.id, name: k.name, status: keyStatus(k), scopes: k.scopes, limits: k.limits, restrictions: k.restrictions, rateLimitPerMin: k.rate_limit_per_min, mandateId: k.mandate_id,
  /** execution scopes that cannot act: no trading mandate is bound to the key */
  inertScopes: inertScopes(k.scopes, k.mandate_id),
  rotatedFrom: k.rotated_from, createdAt: k.created_at.getTime(), expiresAt: k.expires_at.getTime(), revokedAt: k.revoked_at?.getTime() ?? null, revokedReason: k.revoked_reason,
  lastUsedAt: k.last_used_at?.getTime() ?? null, lastUsedIp: k.last_used_ip,
});
const facts = (k: KeyRow): KeyFacts => ({ name: k.name, scopes: k.scopes, expiresAt: k.expires_at, limits: k.limits, restrictions: k.restrictions, rateLimitPerMin: k.rate_limit_per_min, mandateId: k.mandate_id });

export const listKeys = async (): Promise<KeyRow[]> => (await sql<KeyRow[]>`select * from api_keys order by created_at desc`).map(norm);
export async function getKey(id: string): Promise<KeyRow> {
  const [k] = KEY_ID_RE.test(id) ? await sql<KeyRow[]>`select * from api_keys where id = ${id}` : [];
  if (!k) throw new UserError('unknown_key', 'unknown API key', 404);
  return norm(k);
}

// ---------------------------------------------------------------------------------------------------------------- verification
export type Verified = { ok: true; key: KeyRow } | { ok: false; keyId: string | null; reason: 'malformed' | 'unknown' | 'bad_secret' | 'revoked' | 'expired' };
const DUMMY_HASH = '0'.repeat(64);
/** One primary-key read and one HMAC per request. The comparison is constant-time, and an unknown id costs the same HMAC. */
export async function verifyToken(token: string, now = Date.now()): Promise<Verified> {
  const t = parseToken(token);
  if (!t) return { ok: false, keyId: null, reason: 'malformed' };
  const [row] = await sql<KeyRow[]>`select * from api_keys where id = ${t.id}`;
  const good = sameHash(hashSecret(apiKeyPepper(), t.id, t.secret), row?.secret_hash ?? DUMMY_HASH);
  if (!row) return { ok: false, keyId: null, reason: 'unknown' };
  if (!good) return { ok: false, keyId: row.id, reason: 'bad_secret' };
  if (row.revoked_at) return { ok: false, keyId: row.id, reason: 'revoked' };
  if (row.expires_at.getTime() <= now) return { ok: false, keyId: row.id, reason: 'expired' };
  return { ok: true, key: norm(row) };
}
const touched = new Map<string, number>();
/** `last_used_at` is refreshed at most once a minute per key: reads stay one query */
export function touchKey(id: string, ip: string, now = Date.now()): void {
  if (now - (touched.get(id) ?? 0) < 60_000) return;
  touched.set(id, now);
  void sql`update api_keys set last_used_at = now(), last_used_ip = ${ip} where id = ${id}`.catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------- intents
export type IntentAction = 'create' | 'rotate' | 'update';
interface IntentBase { v: 1; action: IntentAction; intentId: string; origin: string; preparedAt: string }
export interface CreateIntent extends IntentBase { action: 'create'; key: { id: string; name: string; scopes: Scope[]; expiresAt: string; limits: Limits; restrictions: Restrictions; rateLimitPerMin: number; mandateId: string | null } }
export interface RotateIntent extends IntentBase { action: 'rotate'; keyId: string; newKeyId: string }
export interface UpdateIntent extends IntentBase { action: 'update'; keyId: string; changes: KeyChanges; widening: string[] }
type Intent = CreateIntent | RotateIntent | UpdateIntent;

async function storeIntent<T extends Intent>(intent: T) {
  const canonical = canonicalJson(intent), challenge = intentChallenge(canonical), creds = await listCreds();
  if (creds.length === 0) throw new UserError('no_passkey', 'no passkey is enrolled', 409);
  await sql`delete from api_key_intents where expires_at < now()`;
  await sql`insert into api_key_intents (id, action, canonical, hash, expires_at) values (${intent.intentId}, ${intent.action}, ${canonical}, ${challenge.toString('hex')}, ${new Date(Date.now() + INTENT_TTL_MS)})`;
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(challenge), allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
  return { intentId: intent.intentId, intent, sha256: challenge.toString('hex'), expiresAt: Date.now() + INTENT_TTL_MS, options };
}
const base = (action: IntentAction): IntentBase => ({ v: 1, action, intentId: randomUUID(), origin: config.origin, preparedAt: new Date().toISOString() });
const uniq = <T extends string>(a: readonly T[]): T[] => [...new Set(a)].sort();
const cleanRestrictions = (r: Restrictions): Restrictions => ({ networks: uniq(r.networks), venues: uniq(r.venues), instruments: uniq(r.instruments), ipAllow: uniq(r.ipAllow) });

export async function prepareCreate(b: KeyCreate) {
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from api_keys where revoked_at is null and expires_at > now()`;
  if ((n?.n ?? 0) >= KEY_BOUNDS.maxKeys) throw new UserError('too_many_keys', `at most ${KEY_BOUNDS.maxKeys} active API keys`, 409);
  const b0 = base('create');
  return storeIntent<CreateIntent>({ ...b0, action: 'create', key: { id: newKeyId(), name: b.name, scopes: uniq(b.scopes), expiresAt: new Date(Date.parse(b0.preparedAt) + b.expiresInDays * DAY).toISOString(),
    limits: b.limits, restrictions: cleanRestrictions(b.restrictions), rateLimitPerMin: b.rateLimitPerMin, mandateId: b.mandateId } });
}
export async function prepareRotate(id: string) {
  const k = await getKey(id);
  if (keyStatus(k) !== 'active') throw new UserError('key_not_active', 'only an active key can be rotated', 409);
  return storeIntent<RotateIntent>({ ...base('rotate'), action: 'rotate', keyId: k.id, newKeyId: newKeyId() });
}
function checkedChanges(k: KeyRow, c: KeyChanges): { next: KeyFacts; widening: string[]; changes: KeyChanges } {
  if (keyStatus(k) === 'revoked') throw new UserError('key_revoked', 'a revoked key cannot be changed', 409);
  const changes: KeyChanges = { ...c, ...(c.scopes ? { scopes: uniq(c.scopes) } : {}), ...(c.restrictions ? { restrictions: cleanRestrictions(c.restrictions) } : {}) };
  const r = applyChanges(facts(k), changes);
  if (r.next.expiresAt.getTime() > k.created_at.getTime() + KEY_BOUNDS.maxDays * DAY) throw new UserError('expiry_too_far', `a key expires at most ${KEY_BOUNDS.maxDays} days after its creation`, 400);
  if (r.next.expiresAt.getTime() <= Date.now()) throw new UserError('expiry_past', 'the expiry must be in the future (revoke the key instead)', 400);
  return { ...r, changes };
}
export async function prepareUpdate(id: string, c: KeyChanges) {
  const k = await getKey(id), r = checkedChanges(k, c);
  return storeIntent<UpdateIntent>({ ...base('update'), action: 'update', keyId: k.id, changes: r.changes, widening: r.widening });
}

/** Single use: the intent row is deleted before the assertion is judged. Returns the intent the passkey signed. */
async function approveIntent<T extends Intent>(intentId: string, action: IntentAction, assertion: unknown, ip: string): Promise<T> {
  const [row] = await sql<{ canonical: string }[]>`delete from api_key_intents where id = ${intentId} and action = ${action} and expires_at > now() returning canonical`;
  if (!row) throw new UserError('intent_expired', 'this approval request expired or was already used; start again', 409);
  const response = assertion as AuthenticationResponseJSON;
  const [cred] = (await listCreds()).filter((c) => c.id === String(response?.id ?? ''));
  const fail = async (why: string): Promise<never> => { await audit('apikey.approval_failed', 'unknown', { action, why, ip }); throw new UserError('approval_failed', 'the passkey approval was not verified', 401); };
  if (!cred) return fail('unknown credential');
  const v = await verifyAuthenticationResponse({ response, expectedChallenge: intentChallenge(row.canonical).toString('base64url'), expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true,
    credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')), counter: Number(cred.counter), transports: cred.transports as never } }).catch(() => null);
  if (!v?.verified) return fail('bad assertion');
  await sql`update credentials set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${cred.id}`;
  return JSON.parse(row.canonical) as T;
}

// ---------------------------------------------------------------------------------------------------------------- commands
async function insertKey(k: CreateIntent['key'], rotatedFrom: string | null): Promise<{ row: KeyRow; token: string }> {
  const secret = newKeySecret();
  const [row] = await sql<KeyRow[]>`insert into api_keys (id, name, secret_hash, scopes, limits, restrictions, rate_limit_per_min, mandate_id, rotated_from, expires_at)
    values (${k.id}, ${k.name}, ${hashSecret(apiKeyPepper(), k.id, secret)}, ${k.scopes}, ${sql.json(k.limits as never)}, ${sql.json(k.restrictions as never)}, ${k.rateLimitPerMin}, ${k.mandateId}, ${rotatedFrom}, ${new Date(k.expiresAt)})
    returning *`;
  return { row: norm(row!), token: formatToken(k.id, secret) };
}
const auditFacts = (k: KeyRow) => ({ key: k.id, name: k.name, scopes: k.scopes, expiresAt: k.expires_at.toISOString(), limits: k.limits, restrictions: k.restrictions, rateLimitPerMin: k.rate_limit_per_min, mandateId: k.mandate_id });

/** the secret is in the answer of this call and nowhere else, ever */
export async function createKey(intentId: string, assertion: unknown, ip: string) {
  const i = await approveIntent<CreateIntent>(intentId, 'create', assertion, ip);
  if (Date.parse(i.key.expiresAt) <= Date.now()) throw new UserError('intent_expired', 'this approval request expired; start again', 409);
  const { row, token } = await insertKey(i.key, null);
  await audit('apikey.created', 'owner', { ...auditFacts(row), ip });
  return { key: keyView(row), secret: token };
}
export async function rotateKey(id: string, intentId: string, assertion: unknown, ip: string) {
  const i = await approveIntent<RotateIntent>(intentId, 'rotate', assertion, ip);
  if (i.keyId !== id) throw new UserError('intent_mismatch', 'this approval was prepared for another key', 409);
  const old = await getKey(id);
  if (keyStatus(old) !== 'active') throw new UserError('key_not_active', 'only an active key can be rotated', 409);
  // same authority, same expiry, a new id and a new secret; the old key stops working in the same statement sequence
  const { row, token } = await insertKey({ id: i.newKeyId, name: old.name, scopes: old.scopes, expiresAt: old.expires_at.toISOString(), limits: old.limits, restrictions: old.restrictions, rateLimitPerMin: old.rate_limit_per_min, mandateId: old.mandate_id }, old.id);
  await sql`update api_keys set revoked_at = now(), revoked_reason = ${`rotated to ${row.id}`} where id = ${old.id} and revoked_at is null`;
  await audit('apikey.rotated', 'owner', { from: old.id, to: row.id, name: old.name, ip });
  return { key: keyView(row), secret: token, revoked: old.id };
}
async function saveFacts(id: string, f: KeyFacts): Promise<KeyRow> {
  const [row] = await sql<KeyRow[]>`update api_keys set name = ${f.name}, scopes = ${f.scopes}, limits = ${sql.json(f.limits as never)}, restrictions = ${sql.json(f.restrictions as never)},
    rate_limit_per_min = ${f.rateLimitPerMin}, mandate_id = ${f.mandateId}, expires_at = ${f.expiresAt} where id = ${id} and revoked_at is null returning *`;
  if (!row) throw new UserError('key_revoked', 'a revoked key cannot be changed', 409);
  return norm(row);
}
/** session only: accepted when no change gives the key more authority; otherwise 403 `passkey_required` (prepare an update intent) */
export async function narrowKey(id: string, c: KeyChanges, ip: string) {
  const k = await getKey(id), r = checkedChanges(k, c);
  if (r.widening.length) throw new UserError('passkey_required', `this change widens the key (${r.widening.join(', ')}): it needs a passkey approval`, 403);
  const row = await saveFacts(id, r.next);
  await audit('apikey.updated', 'owner', { ...auditFacts(row), widening: [], ip });
  return { key: keyView(row) };
}
export async function updateKey(id: string, intentId: string, assertion: unknown, ip: string) {
  const i = await approveIntent<UpdateIntent>(intentId, 'update', assertion, ip);
  if (i.keyId !== id) throw new UserError('intent_mismatch', 'this approval was prepared for another key', 409);
  const k = await getKey(id), r = checkedChanges(k, i.changes); // recomputed against the key as it is NOW
  const row = await saveFacts(id, r.next);
  await audit('apikey.updated', 'owner', { ...auditFacts(row), widening: r.widening, ip });
  return { key: keyView(row) };
}
/** Revocation only removes authority: the session is enough. Idempotent. */
export async function revokeKey(id: string, reason: string, ip: string): Promise<{ key: ReturnType<typeof keyView>; changed: boolean }> {
  const k = await getKey(id);
  const [row] = await sql<KeyRow[]>`update api_keys set revoked_at = now(), revoked_reason = ${reason.slice(0, 200) || null} where id = ${id} and revoked_at is null returning *`;
  if (row) await audit('apikey.revoked', 'owner', { key: id, name: k.name, reason: row.revoked_reason, ip });
  return { key: keyView(row ? norm(row) : k), changed: !!row };
}

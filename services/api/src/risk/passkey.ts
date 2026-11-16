// A change that needs the owner's passkey (V11 Phase B mechanism, exec.ts `prepareRisk` / `takeRisk`, reused as it is): ONE
// canonical intent is stored, the WebAuthn challenge is its hash, the assertion is verified by the API against its credentials
// table (auth.ts `verifyOwnerAssertion`), and the intent is taken exactly once. This is a check against a stolen session; it is
// not the signer's judgement and nothing is signed on its strength.
import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { toB64u } from '@spw/core';
import { hex } from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { audit, getSetting, sql } from '../db.ts';
import { canonicalIntentHash } from '../derivatives/exec.ts';

export const INTENT_TTL_MS = 300_000;
export interface PasskeyDeps { now: () => number; rpId: string; credentials: () => Promise<{ id: string; transports: unknown }[]>; verifyOwner?: (assertion: unknown, challenge: Uint8Array) => Promise<void> }
export type Stamped<T> = T & { nonce: string; createdAt: number; expiresAt: number };
export interface Stash<T> { intent: Stamped<T>; hash: string }
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function webauthnOptions(d: PasskeyDeps, hash: Uint8Array) {
  const creds = await d.credentials();
  const options = await generateAuthenticationOptions({ rpID: d.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 120_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
  if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
  return options;
}

/** step 1: store the canonical intent under `key` (one per key: a new one replaces it) and return the WebAuthn request over its hash */
export async function prepareIntent<T extends Record<string, unknown>>(d: PasskeyDeps, domain: string, key: string, body: T) {
  if (!d.verifyOwner) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval: the change is refused', 503);
  const now = d.now(), intent: Stamped<T> = { ...body, nonce: randomUUID(), createdAt: now, expiresAt: now + INTENT_TTL_MS };
  const hash = canonicalIntentHash(domain, intent), stash: Stash<T> = { intent, hash: hex(hash) };
  await sql`insert into settings (key, value) values (${key}, ${sql.json(stash as never)}) on conflict (key) do update set value = excluded.value`;
  return { intent, hash: stash.hash, options: await webauthnOptions(d, hash), expiresAt: intent.expiresAt };
}

/** step 2: the stored intent, verified against the assertion and removed — only the caller that removes it applies it */
export async function takeIntent<T extends Record<string, unknown>>(d: PasskeyDeps, domain: string, key: string, assertion: unknown, auditType: string): Promise<Stamped<T>> {
  const verify = d.verifyOwner;
  if (!verify) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval: the change is refused', 503);
  if (assertion === undefined || assertion === null) throw new UserError('passkey_required', 'this change needs the owner\'s passkey: prepare it first, then approve', 403);
  const stash = await getSetting<Stash<T> | null>(key, null);
  if (!stash) throw new UserError('bad_state', 'prepare this change first', 409);
  if (hex(canonicalIntentHash(domain, stash.intent)) !== stash.hash) throw new UserError('bad_state', 'the prepared change is not intact', 409);
  if (d.now() >= stash.intent.expiresAt) { await sql`delete from settings where key = ${key}`; throw new UserError('proposal_expired', 'the approval window of this change has expired: prepare it again', 410); }
  try { await verify(assertion, Buffer.from(stash.hash, 'hex')); }
  catch (e) {
    await audit(auditType, 'owner', { hash: stash.hash, reason: msg(e) }).catch(() => {});
    throw new UserError('bad_approval', `the passkey approval of this change did not verify (${msg(e)}); nothing changed`, 403);
  }
  const taken = await sql`delete from settings where key = ${key} and value->>'hash' = ${stash.hash} returning key`;
  if (!taken.length) throw new UserError('bad_state', 'this change was already applied or replaced', 409);
  return stash.intent;
}

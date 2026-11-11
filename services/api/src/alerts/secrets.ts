// Secrets of the alerts layer: the VAPID key pair (generated at first start) and the webhook's shared secret.
// The API keeps its other secrets in its environment, written at deploy; these two are created at run time, so they live in a
// file owned by the API user — directory 0700, file 0600, the same permissions the signer uses for its own material. They are
// never stored in the database (which is backed up every night), never logged, never returned by an endpoint (the VAPID public
// key is public by design; the webhook secret is shown once, when it is generated).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateVapidKeys, type VapidKeys } from './webpush.ts';

interface Secrets { vapid: VapidKeys; webhookSecret: string | null; createdAt: string }
export const alertsDataDir = (): string => process.env.SPW_DATA_DIR || join(homedir(), '.config', 'sp-wallet');
export const secretsPath = (): string => join(alertsDataDir(), 'alerts-secrets.json');

let cached: { path: string; v: Secrets } | null = null;
function write(path: string, v: Secrets): void {
  mkdirSync(alertsDataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  cached = { path, v };
}
function load(): Secrets {
  const path = secretsPath();
  if (cached && cached.path === path) return cached.v;
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) { chmodSync(path, 0o600); console.warn('[alerts] the secrets file was readable by other users; its permissions were reset to 0600'); }
    const v = JSON.parse(readFileSync(path, 'utf8')) as Secrets;
    if (typeof v?.vapid?.publicKey !== 'string' || typeof v?.vapid?.privateKey !== 'string') throw new Error('alerts secrets file is malformed; move it aside to generate a new VAPID key (devices must subscribe again)');
    cached = { path, v: { vapid: v.vapid, webhookSecret: v.webhookSecret ?? null, createdAt: v.createdAt } };
    return cached.v;
  }
  const v: Secrets = { vapid: generateVapidKeys(), webhookSecret: null, createdAt: new Date().toISOString() };
  write(path, v);
  console.log(`[alerts] VAPID key pair generated (${path}, mode 0600)`);
  return v;
}

export const vapidKeys = (): VapidKeys => load().vapid;
export const webhookSecret = (): string | null => load().webhookSecret;
/** a new random secret, returned once to the owner */
export function rotateWebhookSecret(): string {
  const s = load(), secret = randomBytes(32).toString('base64url');
  write(secretsPath(), { ...s, webhookSecret: secret });
  return secret;
}
/** contact given to the push services (RFC 8292 `sub`): the wallet's own origin unless SPW_VAPID_SUBJECT is set — no personal address by default */
export const vapidSubject = (origin: string): string => process.env.SPW_VAPID_SUBJECT || origin;

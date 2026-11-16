// Secrets of the trading API that must NOT be in the database: the pepper of the API-key hashes and the signing secret of
// each webhook endpoint. Same place and same permissions as the alerts secrets (directory 0700, file 0600, owned by the API
// user; SPW_DATA_DIR or ~/.config/sp-wallet). Created on first use, never logged, never returned by an endpoint (a webhook
// secret is shown once, when it is generated). The nightly database backup does not contain this file: a stolen dump holds
// key hashes that cannot be verified, let alone forged, without it.
//
// SPW_API_KEY_PEPPER (≥ 32 characters), when set, replaces the pepper of the file (deployments that inject secrets by environment).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { alertsDataDir } from '../alerts/secrets.ts';

interface Secrets { pepper: string; webhooks: Record<string, string>; createdAt: string }
export const tradingSecretsPath = (): string => join(alertsDataDir(), 'trading-api-secrets.json');

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
  const path = tradingSecretsPath();
  if (cached && cached.path === path) return cached.v;
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) { chmodSync(path, 0o600); console.warn('[trading-api] the secrets file was readable by other users; its permissions were reset to 0600'); }
    const v = JSON.parse(readFileSync(path, 'utf8')) as Secrets;
    if (typeof v?.pepper !== 'string' || v.pepper.length < 32) throw new Error('trading-api secrets file is malformed (pepper); restore it from the secrets backup — a new pepper invalidates every API key');
    cached = { path, v: { pepper: v.pepper, webhooks: v.webhooks ?? {}, createdAt: v.createdAt } };
    return cached.v;
  }
  const v: Secrets = { pepper: randomBytes(32).toString('base64url'), webhooks: {}, createdAt: new Date().toISOString() };
  write(path, v);
  console.log(`[trading-api] API-key pepper generated (${path}, mode 0600)`);
  return v;
}

/** the server-side pepper of the API-key hashes */
export function apiKeyPepper(): string {
  const env = process.env.SPW_API_KEY_PEPPER;
  return env && env.length >= 32 ? env : load().pepper;
}
export const webhookSecretOf = (id: string): string | null => load().webhooks[id] ?? null;
/** a new random signing secret for one endpoint, returned once to the owner */
export function newWebhookSecret(id: string): string {
  const s = load(), secret = `whsec_${randomBytes(32).toString('base64url')}`;
  write(tradingSecretsPath(), { ...s, webhooks: { ...s.webhooks, [id]: secret } });
  return secret;
}
export function dropWebhookSecret(id: string): void {
  const s = load();
  if (!(id in s.webhooks)) return;
  const { [id]: _gone, ...rest } = s.webhooks;
  write(tradingSecretsPath(), { ...s, webhooks: rest });
}

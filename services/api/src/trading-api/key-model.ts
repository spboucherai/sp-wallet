/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/key-model.ts
 * Module           : trading-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// API keys — the pure part: token format, hash, canonical intents, "does this change widen the key", source-address match.
// No database and no configuration here (unit-tested alone; keys.ts adds storage).
//
// Token:  spw_live_<key id>_<secret>     key id = spk_<12 hex> (public, shown in lists and logs)     secret = 32 random bytes, base64url
// Stored: HMAC-SHA-256(pepper, "spw-api-key-v1\n<key id>\n<secret>") — see docs/TRADING-API-SECURITY.md for why not scrypt.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { isExecutionScope, type KeyChanges, type Limits, type Restrictions, type Scope } from './spec.ts';

export const TOKEN_PREFIX = 'spw_live_';
const TOKEN_RE = /^spw_live_(spk_[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
export const KEY_ID_RE = /^spk_[0-9a-f]{12}$/;

export const newKeyId = (): string => `spk_${randomBytes(6).toString('hex')}`;
export const newKeySecret = (): string => randomBytes(32).toString('base64url');
export const formatToken = (id: string, secret: string): string => `${TOKEN_PREFIX}${id}_${secret}`;
/** null unless the string is exactly a token; the id is public, the secret is not */
export function parseToken(token: string): { id: string; secret: string } | null {
  if (token.length > 120) return null;
  const m = TOKEN_RE.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}
export const hashSecret = (pepper: string, id: string, secret: string): string => createHmac('sha256', pepper).update(`spw-api-key-v1\n${id}\n${secret}`).digest('hex');
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** JSON with object keys sorted at every depth: one byte string per value, whatever the order the client built it in */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
/** the WebAuthn challenge of a key-management intent: SHA-256 over a domain tag and the canonical intent */
export const intentChallenge = (canonical: string): Buffer => createHash('sha256').update(`SPW-APIKEY-INTENT-v1\n${canonical}`).digest();

export interface KeyFacts { name: string; scopes: Scope[]; expiresAt: Date; limits: Limits; restrictions: Restrictions; rateLimitPerMin: number; mandateId: string | null }
const sorted = <T extends string>(a: readonly T[]): T[] => [...new Set(a)].sort();
/** an empty list = unrestricted: narrowing means going from "all" to a list, or to a subset of the list */
const listWidens = (before: readonly string[], after: readonly string[]): boolean => {
  if (before.length === 0) return false;
  if (after.length === 0) return true;
  const b = new Set(before);
  return after.some((x) => !b.has(x));
};
/** null = no limit of this kind */
const limitWidens = (before: number | null, after: number | null): boolean => before !== null && (after === null || after > before);

/** Apply `changes` and say which of them give the key MORE authority (those need the owner's passkey; the rest only the session). */
export function applyChanges(k: KeyFacts, c: KeyChanges): { next: KeyFacts; widening: string[] } {
  const next: KeyFacts = {
    name: c.name ?? k.name, scopes: c.scopes ? sorted(c.scopes) : k.scopes, expiresAt: c.expiresAt ? new Date(c.expiresAt) : k.expiresAt,
    limits: c.limits ?? k.limits, restrictions: c.restrictions ?? k.restrictions, rateLimitPerMin: c.rateLimitPerMin ?? k.rateLimitPerMin,
    mandateId: c.mandateId === undefined ? k.mandateId : c.mandateId,
  };
  const widening: string[] = [];
  const had = new Set<string>(k.scopes);
  if (next.scopes.some((s) => !had.has(s))) widening.push('scopes');
  if (next.expiresAt.getTime() > k.expiresAt.getTime()) widening.push('expiresAt');
  if (limitWidens(k.limits.maxOrderNotionalUsd, next.limits.maxOrderNotionalUsd) || limitWidens(k.limits.maxDailyNotionalUsd, next.limits.maxDailyNotionalUsd)) widening.push('limits');
  for (const axis of ['networks', 'venues', 'instruments', 'ipAllow'] as const) if (listWidens(k.restrictions[axis], next.restrictions[axis])) widening.push(`restrictions.${axis}`);
  if (next.rateLimitPerMin > k.rateLimitPerMin) widening.push('rateLimitPerMin');
  // binding (or re-binding) a mandate is what can make execution scopes live: always a widening. Unbinding only removes authority.
  if (next.mandateId !== null && next.mandateId !== k.mandateId) widening.push('mandateId');
  return { next, widening };
}

/** which scopes of the key can act at all: execution scopes are inert while no mandate is bound */
export const inertScopes = (scopes: readonly string[], mandateId: string | null): string[] => (mandateId ? [] : scopes.filter(isExecutionScope));

/** `ip` matches one of the addresses or CIDR blocks; an empty list allows every address. Malformed entries never match. */
export function ipAllowed(ip: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return true;
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip, fam = isIP(addr);
  if (fam === 0) return false;
  const list = new BlockList();
  for (const e of allow) {
    const [net, bits] = e.split('/'), f = isIP(net!);
    if (f === 0) continue;
    try { if (bits === undefined) list.addAddress(net!, f === 4 ? 'ipv4' : 'ipv6'); else list.addSubnet(net!, Number(bits), f === 4 ? 'ipv4' : 'ipv6'); } catch { /* bad prefix length: ignored */ }
  }
  return list.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

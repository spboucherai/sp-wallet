/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/audit.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

import { sha256 } from '@noble/hashes/sha2.js';

export interface AuditRecord { seq: number; ts: string; type: string; actor: string; data: Record<string, unknown>; prev: string; hash: string }

const enc = new TextEncoder();
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

export const GENESIS = '0'.repeat(64);

export function auditHash(r: Omit<AuditRecord, 'hash'>): string {
  const body = ['SPW-AUDIT-v1', r.seq, r.ts, r.type, r.actor, stable(r.data), r.prev].join('\n');
  return Buffer.from(sha256(enc.encode(body))).toString('hex');
}

export function appendAudit(prev: AuditRecord | null, type: string, actor: string, data: Record<string, unknown>, ts = new Date().toISOString()): AuditRecord {
  const base = { seq: (prev?.seq ?? 0) + 1, ts, type, actor, data, prev: prev?.hash ?? GENESIS };
  return { ...base, hash: auditHash(base) };
}

/** Returns the first broken sequence number, or null when the chain is intact. */
export function verifyAuditChain(records: AuditRecord[]): number | null {
  let prev = GENESIS, seq = 0;
  for (const r of records) {
    seq += 1;
    const { hash, ...rest } = r;
    if (r.seq !== seq || r.prev !== prev || auditHash(rest) !== hash) return r.seq;
    prev = hash;
  }
  return null;
}

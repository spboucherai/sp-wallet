import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendAudit, DEFAULT_POLICY, PolicySchema, type AuditRecord, type Policy } from '@spw/core';

export interface StoredCredential { id: string; publicKey: string; counter: number; transports?: string[]; addedAt: string }
export interface SignerState {
  v: 1;
  halted: boolean;
  setupTokenHash: string | null;
  credentials: StoredCredential[];
  /** proposalId -> expiresAt (unix s); single-use replay cache */
  used: Record<string, number>;
  /** "<YYYY-MM-DD>|<network>:<symbol>" -> base units signed that UTC day */
  spent: Record<string, string>;
  journal: AuditRecord[];
}

const EMPTY: SignerState = { v: 1, halted: false, setupTokenHash: null, credentials: [], used: {}, spent: {}, journal: [] };

export class Store {
  state: SignerState;
  policy: Policy;
  constructor(private statePath: string, private policyPath: string) {
    this.state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as SignerState) : structuredClone(EMPTY);
    if (existsSync(policyPath)) this.policy = PolicySchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
    else { this.policy = DEFAULT_POLICY; this.atomicWrite(policyPath, JSON.stringify(DEFAULT_POLICY, null, 2)); }
  }
  private atomicWrite(path: string, data: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  }
  /** Durably persist before any signature is released. */
  save(): void { this.atomicWrite(this.statePath, JSON.stringify(this.state)); }
  log(type: string, data: Record<string, unknown>): void {
    const j = this.state.journal;
    j.push(appendAudit(j[j.length - 1] ?? null, type, 'signer', data));
  }
  prune(nowSec: number): void {
    for (const [k, exp] of Object.entries(this.state.used)) if (exp + 86400 < nowSec) delete this.state.used[k];
    const keep = new Date((nowSec - 3 * 86400) * 1000).toISOString().slice(0, 10);
    for (const k of Object.keys(this.state.spent)) if (k.slice(0, 10) < keep) delete this.state.spent[k];
  }
}

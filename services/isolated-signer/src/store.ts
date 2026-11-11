import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendAudit, DEFAULT_POLICY, PolicySchema, type AuditRecord, type CctpBridge, type Mandate, type Policy } from '@spw/core';

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
  /** agent mandates approved by the owner; usage is counted per UTC day */
  mandates?: Record<string, StoredMandate>;
  /** bridges approved by the owner (proposalId -> record): each authorises the one matching mint on the destination, with no expiry */
  bridges?: Record<string, StoredBridge>;
  /** live derivatives: venue authorizations approved by the owner (authorizationId -> record). Never deleted: a revoked one stays revoked. */
  venues?: Record<string, StoredVenueAuthorization>;
  /** venue withdrawals signed by the main key after a passkey approval (withdrawalId -> record), kept 30 days (venue-collateral.ts) */
  venueWithdrawals?: Record<string, import('./venue-collateral.ts').StoredVenueWithdrawal>;
  /** derivative mandates approved by the owner (mandateId -> record), each extending one venue authorization. Never deleted. */
  venueMandates?: Record<string, StoredVenueMandate>;
  /** v8: GMX venue policies approved by the owner (authorizationId -> record). Never deleted: a revoked one stays revoked. */
  gmx?: Record<string, import('./venue-gmx.ts').StoredGmxAuthorization>;
}
/** an order signed with a trading key that can still add exposure on the venue: kept until its venue expiry + a grace (venue-mandate.ts) */
export interface VenuePendingOrder { clientId: string; instrument: string; side: 'buy' | 'sell'; size: string; price: string; /** unix ms */ until: number; /** unix ms */ signedAt?: number }
/**
 * `usage`: per UTC day — orders that can add exposure, reduce-only orders, cancels, leverage changes, and the summed notional of
 * the first. `hour`: unix seconds of the exposure-adding orders signed in the last hour.
 */
export interface StoredVenueMandate { mandate: import('@spw/derivatives/live').VenueMandate; hash: string; approvedAt: string; revoked: boolean; revokedAt?: string;
  usage: Record<string, { orders: number; reduceOnly: number; cancels: number; leverage: number; turnover: string }>; hour: number[] }
/**
 * `approve`: the one approveAgent signature the main key made for this authorization (kept so that a lost answer gets the same
 * bytes again, never a second signature). `nonces`: the highest venue nonces signed with the trading key (ascending, at most 100 — the venue's own rule). `clientIds`: client
 * order id -> unix day number it was signed (replay; kept three days). `usage`: orders signed per UTC day.
 */
export interface StoredVenueAuthorization { authorization: import('@spw/derivatives/live').VenueAuthorization; hash: string; approvedAt: string; revoked: boolean; revokedAt?: string;
  approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number }; nonces: number[]; clientIds: Record<string, number>; usage: Record<string, { orders: number; cancels: number; leverage: number }>;
  /** exposure ledger shared by manual and mandate orders of this trading key (read only by mandates) */ pending?: VenuePendingOrder[] }
/**
 * `mint` is set when a receiveMessage transaction has been signed for this bridge. `raw` is kept so that an identical
 * request (lost answer, restart) gets the same bytes back instead of a second signature.
 */
export interface StoredBridge { bridge: CctpBridge; approvedAt: number; burnTxid: string;
  mint?: { messageHash: string; txid: string; raw: string; params: string; signedAt: number; signatures: number };
  /** v8, a burn on Solana: the one-time event account the signer generated for it (public key only; the secret is never stored) */
  sol?: { eventAccount: string };
  /** v8: the last reclaim_event_account signature for that account (each one needs the owner's passkey) */
  reclaim?: { txid: string; signedAt: number; signatures: number } }
export interface StoredMandate { mandate: Mandate; approvedAt: string; revoked: boolean; revokedAt?: string; usage: Record<string, { sold: Record<string, string>; orders: number }> }

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
    for (const m of Object.values(this.state.mandates ?? {})) for (const d of Object.keys(m.usage)) if (d < keep) delete m.usage[d];
    // a bridge whose mint was signed is kept 90 more days (retries); one that was never minted is kept for ever
    // v8: a Solana burn whose event-account deposit was never reclaimed is kept (the record is the only authority for the reclaim)
    for (const [k, b] of Object.entries(this.state.bridges ?? {})) if (b.mint && b.mint.signedAt + 90 * 86400 < nowSec && !(b.sol && !b.reclaim)) delete this.state.bridges![k];
    // venue authorizations: daily counters and client order ids older than three days go (an order approval is valid two minutes,
    // and the venue nonce only moves forward, so an old client id cannot come back without a new passkey approval)
    for (const v of Object.values(this.state.venues ?? {})) {
      for (const d of Object.keys(v.usage)) if (d < keep) delete v.usage[d];
      for (const [c, d] of Object.entries(v.clientIds)) if (d < Math.floor(nowSec / 86400) - 3) delete v.clientIds[c];
      if (v.pending) v.pending = v.pending.filter((p) => p.until > nowSec * 1000);
    }
    for (const m of Object.values(this.state.venueMandates ?? {})) {
      for (const d of Object.keys(m.usage)) if (d < keep) delete m.usage[d];
      m.hour = m.hour.filter((t) => t > nowSec - 3600);
    }
  }
}

/**
 * Idempotency of orders.
 *
 *  - `deriveClientOrderId(principal, key)`: a deterministic 256-bit identifier of (who asks, idempotency key). Two principals
 *    using the same key never collide; one principal repeating a key always gets the same id.
 *  - `formatClientOrderId(venue, id)`: the same identifier in the form the venue takes. Hyperliquid's cloid is 128-bit hex
 *    (`0x` + 32 hex characters), which `hlCloid` of the Hyperliquid adapter passes through unchanged. A venue without a
 *    formatter is an error: an id is never invented for a venue whose format is not known.
 *  - `dedupe(existing, incoming)`: same key + same canonical body → the same order; same key + different body → a conflict.
 *
 * Pure: no clock, no randomness.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalEncode, hex } from '@spw/derivatives/live';
import { orderBodyHashHex, PrincipalSchema, type CanonicalOrderInput, type Principal } from './canonical.ts';

export const CLIENT_ORDER_ID_DOMAIN = 'SPW-CLIENT-ORDER-ID-v1';
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{8,100}$/;       // printable ASCII, 8–100 characters (the HTTP Idempotency-Key header)

export class IdempotencyError extends Error {
  readonly code: 'bad_key' | 'unknown_venue';
  constructor(code: 'bad_key' | 'unknown_venue', message: string) { super(message); this.name = 'IdempotencyError'; this.code = code; }
}

/** 64 hex characters: SHA-256 over the domain-separated (principal kind, principal id, key) */
export function deriveClientOrderId(principal: Principal, idempotencyKey: string): string {
  const p = PrincipalSchema.parse(principal);
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw new IdempotencyError('bad_key', 'an idempotency key is 8 to 100 printable ASCII characters');
  return hex(sha256(canonicalEncode(CLIENT_ORDER_ID_DOMAIN, [['principal.kind', p.kind], ['principal.id', p.id], ['key', idempotencyKey]])));
}

export interface ClientOrderIdFormat { format(id64: string): string; bits: number; note: string }
/** per venue: how the 256-bit identifier is carried. Fewer bits = a (documented) chance of collision. */
export const CLIENT_ORDER_ID_FORMATS: Readonly<Record<string, ClientOrderIdFormat>> = {
  hyperliquid: { bits: 128, format: (id) => `0x${id.slice(0, 32)}`, note: 'cloid: 128-bit hex, 0x + 32 lower-case hex characters' },
  /** GMX has no client id on-chain: the id is kept on this side only (unique idempotency key of the operation) */
  gmx: { bits: 256, format: (id) => id, note: 'no venue-side client id; the full identifier is stored with the operation' },
  /** dYdX v4 client ids are uint32: collisions are possible and must be handled by the adapter (not connected for trading) */
  dydx: { bits: 32, format: (id) => String(Number.parseInt(id.slice(0, 8), 16)), note: 'uint32 clientId: first 32 bits, decimal' },
  /** spot swaps are wallet proposals: the identifier is stored with the proposal */
  kyberswap: { bits: 256, format: (id) => id, note: 'no venue-side client id; stored with the wallet proposal' },
  jupiter: { bits: 256, format: (id) => id, note: 'no venue-side client id; stored with the wallet proposal' },
  /** paper accounts take the full identifier */
  paper: { bits: 256, format: (id) => id, note: 'full identifier' },
};

export function formatClientOrderId(venue: string, id64: string, formats: Readonly<Record<string, ClientOrderIdFormat>> = CLIENT_ORDER_ID_FORMATS): string {
  if (!/^[0-9a-f]{64}$/.test(id64)) throw new IdempotencyError('bad_key', 'a client order id is 64 lower-case hex characters before formatting');
  const f = Object.hasOwn(formats, venue) ? formats[venue] : undefined;
  if (!f) throw new IdempotencyError('unknown_venue', `no client order id format is defined for the venue ${venue}`);
  return f.format(id64);
}
/** the client order id of (principal, key) as the venue takes it */
export function clientOrderIdFor(venue: string, principal: Principal, idempotencyKey: string, formats?: Readonly<Record<string, ClientOrderIdFormat>>): string {
  return formatClientOrderId(venue, deriveClientOrderId(principal, idempotencyKey), formats);
}

/** what the store keeps per (principal, idempotency key) */
export interface IdempotencyRecord { clientOrderId: string; bodyHash: string }
export type DedupeResult =
  | { kind: 'new' }
  | { kind: 'same'; clientOrderId: string }
  | { kind: 'conflict'; clientOrderId: string; existingBodyHash: string; incomingBodyHash: string };

/**
 * `existing` is the record stored under the incoming request's (principal, key), or null. The body compared is the order's
 * economic content (orderBodyHashHex): a retry stamped with a later `createdAt` is the same order; a request that reuses a key
 * for anything else is a conflict and must be refused (REJECTED / IDEMPOTENCY_CONFLICT), never executed and never merged.
 */
export function dedupe(existing: IdempotencyRecord | null, incoming: { bodyHash: string }): DedupeResult {
  if (existing === null) return { kind: 'new' };
  if (existing.bodyHash === incoming.bodyHash) return { kind: 'same', clientOrderId: existing.clientOrderId };
  return { kind: 'conflict', clientOrderId: existing.clientOrderId, existingBodyHash: existing.bodyHash, incomingBodyHash: incoming.bodyHash };
}
export const dedupeOrder = (existing: IdempotencyRecord | null, order: CanonicalOrderInput): DedupeResult => dedupe(existing, { bodyHash: orderBodyHashHex(order) });

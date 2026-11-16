// What every route that PREPARES a proposal (transfer, swap, CCTP transfer, THORChain swap) shares since v11:
//
//  1. Idempotency (audit B4/B5). The same `Idempotency-Key` with the same body answers the proposal that already exists —
//     with its passkey challenge again while it can still be approved — instead of `409 conflict`. The same key with another
//     body is a client bug and answers `409 idempotency_mismatch`. A lost HTTP answer, or a process that stopped between
//     "proposal created" and "plan saved", is therefore recoverable by repeating the request.
//
//  2. The quote the owner was looking at (audit B6). The client may send the reference of the route it displayed (id,
//     provider, fingerprint, amounts). The server prepares its own firm route as before, then REFUSES — `409 quote_moved`,
//     with the fresh figures in the answer — when the firm expected output is below the minimum the owner was shown. It also
//     refuses a reference that is not for this pair / amount / tolerance, or whose provider is not the one that executes.
//     Nothing here is trusted for safety: the signer still verifies every value-moving field. The reference only protects
//     the owner from a silent change between what he saw and what he is asked to approve.
import { createHash } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { formatUnits, toB64u } from '@spw/core';
import { listCreds } from './auth.ts';
import { config, UserError } from './config.ts';
import { sql } from './db.ts';
import { view, type ProposalRow } from './transfers.ts';

// ── idempotency ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Idem { key: string; kind: ProposalRow['kind']; hash: string }

const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]).filter(([, x]) => x !== undefined)) : v);
/** Fingerprint of a parsed request body (defaults applied, keys sorted): what "the same request" means. */
export const requestHash = (kind: string, body: unknown): string => createHash('sha256').update(`${kind}\n${JSON.stringify(canonical(body))}`).digest('hex');

export function idemOf(headers: Record<string, unknown>, kind: ProposalRow['kind'], body: unknown): Idem {
  const key = String(headers['idempotency-key'] ?? '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) throw new UserError('idempotency', 'Idempotency-Key header required');
  return { key, kind, hash: requestHash(kind, body) };
}

/** The proposal already created under this key, or null. Throws 409 when the key was used for another request. */
export async function existingFor(i: Idem): Promise<ProposalRow | null> {
  const [p] = await sql<(ProposalRow & { request_hash: string | null })[]>`select * from proposals where idempotency_key = ${i.key}`;
  if (!p) return null;
  // rows written before v11 carry no fingerprint: the kind is the only thing that can be compared
  if ((p.kind ?? 'transfer') !== i.kind || (p.request_hash && p.request_hash !== i.hash))
    throw new UserError('idempotency_mismatch', 'this Idempotency-Key was already used for a different request; use a new key', 409);
  return p;
}

/** The passkey challenge of a prepared proposal: always the fingerprint of its stored intent, so issuing it again changes nothing. */
export async function challengeFor(p: ProposalRow): Promise<unknown | null> {
  if (p.state !== 'pending_approval' || !p.intent_hash || !p.expires_at) return null;
  const left = p.expires_at.getTime() - Date.now();
  if (left <= 0) return null;
  const hash = new Uint8Array(Buffer.from(p.intent_hash.replace(/^0x/, ''), 'hex'));
  const creds = await listCreds();
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: hash, timeout: Math.max(1000, left), allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
  if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
  return options;
}

/** The answer of a repeated preparation: the same proposal, `replayed: true`, and its challenge while it can still be approved. */
export async function replayAnswer(p: ProposalRow): Promise<{ proposal: ReturnType<typeof view>; options: unknown | null; replayed: true }> {
  return { proposal: view(p), options: await challengeFor(p), replayed: true };
}
/** Before the expensive preparation: answer the existing proposal when this key already produced one. */
export async function replayOf(i: Idem): Promise<Awaited<ReturnType<typeof replayAnswer>> | null> {
  const p = await existingFor(i);
  return p ? replayAnswer(p) : null;
}
/** After `insert … on conflict do nothing`: a concurrent request with the same key won the race — answer ITS proposal. */
export async function lostRace(i: Idem): Promise<Awaited<ReturnType<typeof replayAnswer>>> {
  const p = await existingFor(i);
  if (!p) throw new UserError('conflict', 'the request could not be recorded; try again', 409);
  return replayAnswer(p);
}

// ── the quote the owner saw ──────────────────────────────────────────────────────────────────────────────────────────────
const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
export const QuoteRef = z.strictObject({
  /** route id of the quote response */ id: z.string().min(1).max(300),
  provider: z.string().min(1).max(40),
  fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
  /** base units of the destination asset, as displayed */ amountOut: U, minAmountOut: U,
  quotedAt: z.number().int().positive(),
});
export type QuoteRef = z.infer<typeof QuoteRef>;

export interface QuoteFacts { provider: string; fromKey: string; toKey: string; amountIn: string; slippageBps: number; amountOut: string; minAmountOut: string }
/** Stable fingerprint of what a route promises: who, which pair, how much in, which tolerance, how much out. */
export const quoteFingerprint = (q: QuoteFacts): string =>
  createHash('sha256').update([q.provider, q.fromKey, q.toKey, q.amountIn, q.slippageBps, q.amountOut, q.minAmountOut].join('|')).digest('hex').slice(0, 32);

/** What is stored on the proposal (and shown on the review sheet): the quoted figures next to the firm ones. */
export interface QuoteRecord { id: string; provider: string; fingerprint: string; quotedOut: string; quotedMinOut: string; quotedAt: number; firmOut: string; firmMinOut: string; deviationBps: number }

export interface FirmFacts {
  /** the provider that executes this preparation */ executor: string;
  fromKey: string; toKey: string; amountIn: bigint; slippageBps: number;
  /** firm expected output and firm guaranteed minimum, base units of the destination asset */
  firmOut: bigint; firmMinOut: bigint; toDecimals: number; toSymbol: string;
}
export class QuoteMoved extends UserError {
  constructor(message: string, public data: Record<string, unknown>) { super('quote_moved', message, 409); }
}
/**
 * Compare the firm preparation with the quote the owner saw. Returns the record to store, or null when no reference was
 * sent (API clients, plan legs — a plan re-quotes each leg itself and has its own floor).
 */
export function checkQuoteRef(ref: QuoteRef | undefined, f: FirmFacts): QuoteRecord | null {
  if (!ref) return null;
  if (ref.provider !== f.executor) throw new UserError('quote_not_executable', `the quote shown comes from ${ref.provider}, which this wallet does not execute on this pair; it executes through ${f.executor}`, 422);
  const fp = quoteFingerprint({ provider: ref.provider, fromKey: f.fromKey, toKey: f.toKey, amountIn: f.amountIn.toString(), slippageBps: f.slippageBps, amountOut: ref.amountOut, minAmountOut: ref.minAmountOut });
  if (fp !== ref.fingerprint) throw new UserError('quote_mismatch', 'the quote shown is not for this pair, amount and tolerance; ask for a new quote', 400);
  const quotedOut = BigInt(ref.amountOut), quotedMin = BigInt(ref.minAmountOut);
  if (quotedOut <= 0n || quotedMin > quotedOut) throw new UserError('quote_mismatch', 'the quote shown is inconsistent; ask for a new quote', 400);
  // signed deviation of the firm expected output against the quoted one, in basis points (negative = worse than shown)
  // (a loss is rounded AWAY from zero: 50.0000003 bps worse than shown is reported as −51, never as "within 50")
  const num = (f.firmOut - quotedOut) * 10_000n, deviationBps = Number(num >= 0n ? num / quotedOut : -((-num + quotedOut - 1n) / quotedOut));
  if (f.firmOut < quotedMin) {
    const d = (v: bigint) => formatUnits(v, f.toDecimals);
    throw new QuoteMoved(`the price moved since the quote was shown: ${d(f.firmOut)} ${f.toSymbol} expected now, below the minimum of ${d(quotedMin)} ${f.toSymbol} that was displayed. Nothing was prepared`, {
      quoted: { id: ref.id, provider: ref.provider, amountOut: ref.amountOut, amountOutDisplay: d(quotedOut), minAmountOut: ref.minAmountOut, minAmountOutDisplay: d(quotedMin), quotedAt: ref.quotedAt },
      fresh: { provider: f.executor, amountOut: f.firmOut.toString(), amountOutDisplay: d(f.firmOut), minAmountOut: f.firmMinOut.toString(), minAmountOutDisplay: d(f.firmMinOut), symbol: f.toSymbol, quotedAt: Date.now(),
        fingerprint: quoteFingerprint({ provider: f.executor, fromKey: f.fromKey, toKey: f.toKey, amountIn: f.amountIn.toString(), slippageBps: f.slippageBps, amountOut: f.firmOut.toString(), minAmountOut: f.firmMinOut.toString() }) },
      deviationBps, slippageBps: f.slippageBps });
  }
  return { id: ref.id, provider: ref.provider, fingerprint: ref.fingerprint, quotedOut: ref.amountOut, quotedMinOut: ref.minAmountOut, quotedAt: ref.quotedAt, firmOut: f.firmOut.toString(), firmMinOut: f.firmMinOut.toString(), deviationBps };
}

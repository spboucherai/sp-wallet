// Derivative MANDATE (MANDATE_LIVE): the canonical object the owner approves ONCE with a passkey, after which an approved
// automated strategy may place orders without a passkey per order — inside limits that the isolated signer stores and enforces.
//
// A mandate EXTENDS a venue authorization (canonical.ts): same venue, network, account and trading key. It can only be narrower
// than the authorization on every limit, and it dies with it. Pure: no network, no clock, no key.
//
// What is new compared with the authorization: position and gross-exposure limits that the SIGNER enforces (worstCaseExposure
// below, fed by the signer's own read of the venue account and its own prices), an hourly order rate, a daily turnover, a
// floor on the account value, and the identity of the strategy (code hash + agent id, for the audit trail).
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { D, type Dec, type DecStr } from '../decimal.ts';
import { DecStrSchema } from '../models.ts';
import { canonicalEncode, VENUE_POLICY_BOUNDS, type VenueAuthorization } from './canonical.ts';

export const VENUE_MANDATE_MAX_DAYS = 30;
/** after a mandate is revoked or expires, cancels and reduce-only orders are still signed this long (never new exposure) */
export const VENUE_MANDATE_WIND_DOWN_S = 86_400;
/** hard ceilings of a mandate, on top of the authorization's own limits */
export const VENUE_MANDATE_BOUNDS = { maxDays: VENUE_MANDATE_MAX_DAYS, maxOrdersPerHour: 60, maxLeverageChangesPerDay: 20, maxInstruments: 8 /* an agent's mandate stays narrow; the owner's own authorization may allow the whole dex */ } as const;
/** a signed order stays in the signer's exposure ledger until its venue expiry plus this (the venue's info endpoint may lag) */
export const VENUE_PENDING_GRACE_MS = 10_000;
/** the venue's own timestamp on the account state the signer read may differ from the signer's clock by at most this */
export const VENUE_READ_MAX_AGE_MS = 30_000;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PosDec = DecStrSchema.refine((x) => !x.startsWith('-') && /[1-9]/.test(x), 'must be positive');
const canon = (x: DecStr): DecStr => D.str(D.from(x));

export const VenueMandateInstrumentSchema = z.strictObject({
  instrument: z.string().regex(/^hyperliquid:[A-Za-z0-9]{1,15}$/),
  /** highest leverage SETTING of this instrument under which the signer signs an order that can add exposure, and the highest it sets */
  maxLeverage: z.number().int().min(1).max(VENUE_POLICY_BOUNDS.maxLeverage),
  /** worst-case position on this instrument, in the venue's collateral, at the signer's own price — enforced by the signer */
  maxPositionNotional: PosDec,
});
export const VenueMandateSchema = z.strictObject({
  v: z.literal(1),
  mandateId: z.uuid(),
  /** the venue authorization this mandate extends; revoking either stops the mandate */
  authorizationId: z.uuid(),
  keyId: z.string().min(8).max(80),
  venue: z.literal('hyperliquid'),
  network: z.enum(['mainnet', 'testnet']),
  account: z.string().regex(ADDRESS),
  agentAddress: z.string().regex(ADDRESS),
  /** audit: which strategy code and which agent the owner approved (the signer cannot verify what code runs; it records it) */
  strategySha256: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  instruments: z.array(VenueMandateInstrumentSchema).min(1).max(VENUE_MANDATE_BOUNDS.maxInstruments),
  /** size × highest named price of ONE order (reduce-only orders included) */
  maxOrderNotional: PosDec,
  /** worst-case sum over all instruments of the account — enforced by the signer */
  maxGrossExposure: PosDec,
  /** orders that can add exposure, per UTC day and per rolling hour (reduce-only orders and cancels are never counted) */
  maxOrdersPerDay: z.number().int().min(1).max(VENUE_POLICY_BOUNDS.maxOrdersPerDay),
  maxOrdersPerHour: z.number().int().min(1).max(VENUE_MANDATE_BOUNDS.maxOrdersPerHour),
  /** sum of the notionals of the orders that can add exposure, per UTC day */
  maxDailyTurnover: PosDec,
  /** loss limit: when the venue reports an account value below this, the signer signs only reduce-only orders and cancels */
  floorEquity: PosDec,
  maxPriceDeviationBps: z.number().int().min(VENUE_POLICY_BOUNDS.minPriceBandBps).max(VENUE_POLICY_BOUNDS.maxPriceBandBps),
  /** unix seconds */
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  /** SHA-256 of the jurisdiction acknowledgement text shown again when the mandate was approved */
  ackSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VenueMandate = z.infer<typeof VenueMandateSchema>;
export type VenueMandateInstrument = z.infer<typeof VenueMandateInstrumentSchema>;

export function venueMandateBytes(m: VenueMandate): Uint8Array {
  const x = VenueMandateSchema.parse(m), inst = [...x.instruments].sort((a, b) => (a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0));
  return canonicalEncode('SPW-VENUE-MANDATE-v1', [
    ['v', '1'], ['mandateId', x.mandateId], ['authorizationId', x.authorizationId], ['keyId', x.keyId], ['venue', x.venue], ['network', x.network], ['account', x.account],
    ['agentAddress', x.agentAddress], ['strategySha256', x.strategySha256], ['agentId', x.agentId],
    ['instruments', inst.map((i) => `${i.instrument}|${i.maxLeverage}|${canon(i.maxPositionNotional)}`).join(',')],
    ['maxOrderNotional', canon(x.maxOrderNotional)], ['maxGrossExposure', canon(x.maxGrossExposure)], ['maxOrdersPerDay', String(x.maxOrdersPerDay)], ['maxOrdersPerHour', String(x.maxOrdersPerHour)],
    ['maxDailyTurnover', canon(x.maxDailyTurnover)], ['floorEquity', canon(x.floorEquity)], ['maxPriceDeviationBps', String(x.maxPriceDeviationBps)],
    ['createdAt', String(x.createdAt)], ['expiresAt', String(x.expiresAt)], ['ackSha256', x.ackSha256],
  ]);
}
export const venueMandateHash = (m: VenueMandate): Uint8Array => sha256(venueMandateBytes(m));

/**
 * Validity of a mandate against the authorization it extends, at approval time. Throws with the first reason. The signer
 * additionally checks that the authorization is its own stored one (unrevoked), the pinned asset table and the acknowledgement hash.
 */
export function validateVenueMandate(m: VenueMandate, a: VenueAuthorization, nowSec: number): void {
  if (a.mode !== 'MANUAL_LIVE') throw new Error('a mandate extends a MANUAL_LIVE authorization');
  if (m.authorizationId !== a.authorizationId || m.keyId !== a.keyId || m.venue !== a.venue || m.network !== a.network || m.account !== a.account || m.agentAddress !== a.agentAddress)
    throw new Error('the mandate does not name the venue, network, account and trading key of its authorization');
  if (nowSec >= a.expiresAt) throw new Error('the authorization has expired');
  const p = a.policy, gt = (x: DecStr, y: DecStr) => D.gt(D.from(x), D.from(y));
  if (new Set(m.instruments.map((i) => i.instrument)).size !== m.instruments.length) throw new Error('duplicate instrument');
  for (const i of m.instruments) {
    if (!p.allowedInstruments.includes(i.instrument)) throw new Error(`${i.instrument} is not allowed by the authorization`);
    if (i.maxLeverage > p.maxLeverage) throw new Error(`${i.instrument}: leverage ${i.maxLeverage} is above the authorization's ${p.maxLeverage}`);
    if (gt(i.maxPositionNotional, p.maxPositionNotional)) throw new Error(`${i.instrument}: position limit above the authorization's ${canon(p.maxPositionNotional)}`);
    if (gt(i.maxPositionNotional, m.maxGrossExposure)) throw new Error(`${i.instrument}: position limit above the mandate's gross exposure limit`);
  }
  if (gt(m.maxOrderNotional, p.maxOrderNotional)) throw new Error(`order limit above the authorization's ${canon(p.maxOrderNotional)}`);
  if (!m.instruments.some((i) => !gt(m.maxOrderNotional, i.maxPositionNotional))) throw new Error('order limit above every position limit');
  if (gt(m.maxGrossExposure, p.maxGrossExposure)) throw new Error(`gross exposure limit above the authorization's ${canon(p.maxGrossExposure)}`);
  if (m.maxOrdersPerDay > p.maxOrdersPerDay) throw new Error(`orders per day above the authorization's ${p.maxOrdersPerDay}`);
  if (m.maxOrdersPerHour > m.maxOrdersPerDay) throw new Error('orders per hour above orders per day');
  if (m.maxPriceDeviationBps > p.maxPriceDeviationBps) throw new Error(`price band wider than the authorization's ${p.maxPriceDeviationBps} bps`);
  if (gt(m.maxOrderNotional, m.maxDailyTurnover)) throw new Error('order limit above the daily turnover limit');
  if (m.expiresAt <= nowSec) throw new Error('mandate already expired');
  if (m.createdAt > nowSec + 120 || m.createdAt < nowSec - 600) throw new Error('mandate creation time is not current');
  if (m.expiresAt - m.createdAt > VENUE_MANDATE_MAX_DAYS * 86400) throw new Error(`a mandate lasts at most ${VENUE_MANDATE_MAX_DAYS} days`);
  if (m.expiresAt > a.expiresAt) throw new Error('the mandate would outlive its authorization');
}

export type VenueMandatePhase = 'active' | 'wind_down' | 'ended';
/**
 * `active`: everything the mandate allows. `wind_down` (from the revocation or the expiry, for VENUE_MANDATE_WIND_DOWN_S):
 * cancels and reduce-only orders only. `ended`: nothing. The authorization's own revocation or expiry ends everything at once
 * and is checked separately.
 */
export function venueMandatePhase(m: Pick<VenueMandate, 'expiresAt'>, revokedAtSec: number | null, nowSec: number): { phase: VenueMandatePhase; endedAt: number | null; windDownUntil: number | null } {
  const end = revokedAtSec === null ? m.expiresAt : Math.min(revokedAtSec, m.expiresAt);
  if (nowSec < end) return { phase: 'active', endedAt: null, windDownUntil: null };
  const until = end + VENUE_MANDATE_WIND_DOWN_S;
  return { phase: nowSec < until ? 'wind_down' : 'ended', endedAt: end, windDownUntil: until };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Worst-case exposure — the bound the signer enforces before it signs an order that can add exposure.
//
// Inputs: the account's positions (signed sizes, from the signer's own read of the venue), a price per instrument (the signer's
// own), and every order that could still add exposure: the non-reduce-only orders resting on the venue, the orders the signer
// signed whose venue expiry (+ grace) has not passed, and the candidate. Reduce-only orders are left out: the venue never lets
// one increase a position or open the opposite one.
//
// Per instrument: if every buy fills and no sell does, the position is at most  max(size, 0) + Σ buys; the other way round,
// max(−size, 0) + Σ sells. Whatever subset fills, |position| ≤ the larger of the two. Each order is valued at the higher of
// its own price and the instrument's price (a sell can fill above its limit), the position at the instrument's price.
// The bound over-counts on purpose (an order just filled is counted as position AND as pending until it leaves the ledger).

export interface ExposurePosition { instrument: string; /** signed size: positive long, negative short */ size: DecStr }
export interface ExposureOrder { instrument: string; side: 'buy' | 'sell'; size: DecStr; /** highest price the order names */ price: DecStr; reduceOnly: boolean }
export interface WorstCaseExposure { perInstrument: Record<string, DecStr>; gross: DecStr }

export function worstCaseExposure(positions: readonly ExposurePosition[], orders: readonly ExposureOrder[], prices: Readonly<Record<string, DecStr>>): WorstCaseExposure {
  const long = new Map<string, Dec>(), short = new Map<string, Dec>();
  const add = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, D.add(m.get(k) ?? D.zero, v));
  const priceOf = (inst: string): Dec | null => { const p = Object.hasOwn(prices, inst) ? D.from(prices[inst]!) : null; if (p !== null && !D.isPos(p)) throw new Error(`bad price for ${inst}`); return p; };
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p.instrument)) throw new Error(`two positions on ${p.instrument}`);
    seen.add(p.instrument);
    const s = D.from(p.size);
    if (D.isZero(s)) continue;
    const px = priceOf(p.instrument);
    if (px === null) throw new Error(`no price for the position on ${p.instrument}`);
    add(D.isPos(s) ? long : short, p.instrument, D.mul(D.abs(s), px));
  }
  for (const o of orders) {
    if (o.reduceOnly) continue;
    const size = D.from(o.size), own = D.from(o.price);
    if (D.isNeg(size) || !D.isPos(own)) throw new Error(`bad order on ${o.instrument}`);
    const px = priceOf(o.instrument);
    add(o.side === 'buy' ? long : short, o.instrument, D.mul(size, px === null ? own : D.max(own, px)));
  }
  const perInstrument: Record<string, DecStr> = {};
  let gross = D.zero;
  for (const k of new Set([...long.keys(), ...short.keys()])) {
    const w = D.max(long.get(k) ?? D.zero, short.get(k) ?? D.zero);
    perInstrument[k] = D.str(w); gross = D.add(gross, w);
  }
  return { perInstrument, gross: D.str(gross) };
}

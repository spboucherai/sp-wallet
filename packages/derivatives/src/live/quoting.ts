/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/live/quoting.ts
 * Module           : live
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

// QUOTING mandate (`SPW-VENUE-QUOTING-MANDATE-v1`): the canonical object the owner approves ONCE with a passkey, after which
// an approved market-making engine may keep two-sided POST-ONLY quotes resting on a Hyperliquid account without a passkey per
// action — inside limits that the isolated signer stores and enforces. Design: docs/V11-MARKET-MAKING.md.
//
// It is a SEPARATE shape from the directional mandate (mandate.ts, `SPW-VENUE-MANDATE-v1`), which is not changed. Like it, a
// quoting mandate EXTENDS a venue authorization (canonical.ts) and dies with it. Pure: no network, no clock, no key.
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { D, type Dec, type DecStr } from '../decimal.ts';
import { DecStrSchema } from '../models.ts';
import { canonicalEncode, type VenueAuthorization } from './canonical.ts';
import { VENUE_MANDATE_WIND_DOWN_S, worstCaseExposure, type ExposureOrder, type ExposurePosition } from './mandate.ts';

export const QUOTING_MANDATE_DOMAIN = 'SPW-VENUE-QUOTING-MANDATE-v1';
/** hard ceilings of a quoting mandate: the owner chooses below them (table in docs/V11-MARKET-MAKING.md §4) */
export const QUOTING_MANDATE_BOUNDS = {
  maxDays: 7, maxInstruments: 3, maxLeverage: 10,
  maxQuoteNotional: '2000', maxRestingPerSide: 5, maxRestingTotal: 20, maxRestingNotionalPerSide: '10000', maxInventoryNotional: '20000', maxGrossExposure: '50000',
  minHalfSpreadBpsFloor: 1, maxDistanceBpsCeiling: 500, minReduceDeviationBps: 10, maxReduceDeviationBps: 300,
  maxBurstActions: 20, maxActionsPerMinute: 60, maxOrdersPerHour: 3600, maxOrdersPerDay: 20_000, maxDailyTurnover: '2000000',
  maxBatch: 20, minDeadManSeconds: 10, maxDeadManSeconds: 120,
} as const;
/** a quote batch or a scheduleCancel is valid at most this long (nonce → venue expiry) */
export const QUOTING_ACTION_MAX_TTL_MS = 30_000;
/** a scheduleCancel time must be at least this far ahead of the signer's clock (the venue's own minimum is 5 s) */
export const DMS_MIN_AHEAD_MS = 6_000;
/** a quote batch is signed only if the armed deadline is at least this much after the batch's own venue expiry */
export const DMS_COVER_MARGIN_MS = 2_000;
/** the venue fires the switch at most 10 times per UTC day; the signer stops opening after this many presumed triggers */
export const DMS_MAX_LAPSES_PER_DAY = 8;
export const QUOTING_WIND_DOWN_S = VENUE_MANDATE_WIND_DOWN_S;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PosDec = DecStrSchema.refine((x) => !x.startsWith('-') && /[1-9]/.test(x), 'must be positive');
const canon = (x: DecStr): DecStr => D.str(D.from(x));
const B = QUOTING_MANDATE_BOUNDS;
const capped = (max: DecStr) => PosDec.refine((x) => D.lte(D.from(x), D.from(max)), `at most ${max}`);

export const QuotingInstrumentSchema = z.strictObject({
  instrument: z.string().regex(/^hyperliquid:[A-Za-z0-9]{1,15}$/),
  /** highest leverage SETTING of the instrument on the venue under which a quote is signed (the mandate never changes it) */
  maxLeverage: z.number().int().min(1).max(B.maxLeverage),
  /** one quote: size × max(its price, the signer's mid) */
  maxQuoteNotional: capped(B.maxQuoteNotional),
  /** non-reduce-only orders on one side: resting on the venue + signed and still able to land + the batch */
  maxRestingPerSide: z.number().int().min(1).max(B.maxRestingPerSide),
  /** the same set, valued */
  maxRestingNotionalPerSide: capped(B.maxRestingNotionalPerSide),
  /** worst case of the position: |position| + every same-side order of that set, at the signer's mid */
  maxInventoryNotional: capped(B.maxInventoryNotional),
});
export const QuotingRateSchema = z.strictObject({
  /** token bucket of quote batches: capacity and refill per minute */
  burstActions: z.number().int().min(1).max(B.maxBurstActions),
  actionsPerMinute: z.number().int().min(1).max(B.maxActionsPerMinute),
  /** quotes (orders, not batches) per UTC hour and per UTC day */
  ordersPerHour: z.number().int().min(1).max(B.maxOrdersPerHour),
  ordersPerDay: z.number().int().min(1).max(B.maxOrdersPerDay),
  /** Σ notional of the quotes signed per UTC day */
  dailyTurnover: capped(B.maxDailyTurnover),
});
export const VenueQuotingMandateSchema = z.strictObject({
  v: z.literal(1),
  mandateId: z.uuid(),
  authorizationId: z.uuid(),
  keyId: z.string().min(8).max(80),
  venue: z.literal('hyperliquid'),
  network: z.enum(['mainnet', 'testnet']),
  account: z.string().regex(ADDRESS),
  agentAddress: z.string().regex(ADDRESS),
  /** audit: recorded by the signer, not verifiable by it */
  strategySha256: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  instruments: z.array(QuotingInstrumentSchema).min(1).max(B.maxInstruments),
  maxRestingTotal: z.number().int().min(1).max(B.maxRestingTotal),
  maxGrossExposure: capped(B.maxGrossExposure),
  /** a bid is at most mid × (1 − this), an ask at least mid × (1 + this): never at or through the signer's own mid */
  minHalfSpreadBps: z.number().int().min(B.minHalfSpreadBpsFloor).max(B.maxDistanceBpsCeiling - 1),
  /** a bid is at least mid × (1 − this), an ask at most mid × (1 + this) */
  maxDistanceBps: z.number().int().min(B.minHalfSpreadBpsFloor + 1).max(B.maxDistanceBpsCeiling),
  /** every price of a reduce-only order is within this of the signer's mid */
  maxReduceDeviationBps: z.number().int().min(B.minReduceDeviationBps).max(B.maxReduceDeviationBps),
  floorEquity: PosDec,
  rate: QuotingRateSchema,
  /** the venue's dead man's switch must be armed, and never further away than this */
  deadManSeconds: z.number().int().min(B.minDeadManSeconds).max(B.maxDeadManSeconds),
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  ackSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VenueQuotingMandate = z.infer<typeof VenueQuotingMandateSchema>;
export type QuotingInstrument = z.infer<typeof QuotingInstrumentSchema>;

export function venueQuotingMandateBytes(m: VenueQuotingMandate): Uint8Array {
  const x = VenueQuotingMandateSchema.parse(m), inst = [...x.instruments].sort((a, b) => (a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0)), r = x.rate;
  return canonicalEncode(QUOTING_MANDATE_DOMAIN, [
    ['v', '1'], ['mandateId', x.mandateId], ['authorizationId', x.authorizationId], ['keyId', x.keyId], ['venue', x.venue], ['network', x.network], ['account', x.account],
    ['agentAddress', x.agentAddress], ['strategySha256', x.strategySha256], ['agentId', x.agentId],
    ['instruments', inst.map((i) => [i.instrument, i.maxLeverage, canon(i.maxQuoteNotional), i.maxRestingPerSide, canon(i.maxRestingNotionalPerSide), canon(i.maxInventoryNotional)].join('|')).join(',')],
    ['maxRestingTotal', String(x.maxRestingTotal)], ['maxGrossExposure', canon(x.maxGrossExposure)],
    ['minHalfSpreadBps', String(x.minHalfSpreadBps)], ['maxDistanceBps', String(x.maxDistanceBps)], ['maxReduceDeviationBps', String(x.maxReduceDeviationBps)], ['floorEquity', canon(x.floorEquity)],
    ['rate.burstActions', String(r.burstActions)], ['rate.actionsPerMinute', String(r.actionsPerMinute)], ['rate.ordersPerHour', String(r.ordersPerHour)], ['rate.ordersPerDay', String(r.ordersPerDay)],
    ['rate.dailyTurnover', canon(r.dailyTurnover)], ['deadManSeconds', String(x.deadManSeconds)],
    ['createdAt', String(x.createdAt)], ['expiresAt', String(x.expiresAt)], ['ackSha256', x.ackSha256],
  ]);
}
export const venueQuotingMandateHash = (m: VenueQuotingMandate): Uint8Array => sha256(venueQuotingMandateBytes(m));

/**
 * Validity of a quoting mandate against the authorization it extends, at approval time. Throws with the first reason. The
 * signer additionally checks its own stored authorization, the pinned asset table, the acknowledgement hash and exclusivity.
 */
export function validateVenueQuotingMandate(m: VenueQuotingMandate, a: VenueAuthorization, nowSec: number): void {
  if (a.mode !== 'MANUAL_LIVE') throw new Error('a quoting mandate extends a MANUAL_LIVE authorization');
  if (m.authorizationId !== a.authorizationId || m.keyId !== a.keyId || m.venue !== a.venue || m.network !== a.network || m.account !== a.account || m.agentAddress !== a.agentAddress)
    throw new Error('the mandate does not name the venue, network, account and trading key of its authorization');
  if (nowSec >= a.expiresAt) throw new Error('the authorization has expired');
  const p = a.policy, gt = (x: DecStr, y: DecStr) => D.gt(D.from(x), D.from(y));
  if (new Set(m.instruments.map((i) => i.instrument)).size !== m.instruments.length) throw new Error('duplicate instrument');
  for (const i of m.instruments) {
    if (!p.allowedInstruments.includes(i.instrument)) throw new Error(`${i.instrument} is not allowed by the authorization`);
    if (i.maxLeverage > p.maxLeverage) throw new Error(`${i.instrument}: leverage ${i.maxLeverage} is above the authorization's ${p.maxLeverage}`);
    if (gt(i.maxQuoteNotional, p.maxOrderNotional)) throw new Error(`${i.instrument}: quote limit above the authorization's order limit ${canon(p.maxOrderNotional)}`);
    if (gt(i.maxInventoryNotional, p.maxPositionNotional)) throw new Error(`${i.instrument}: inventory limit above the authorization's position limit ${canon(p.maxPositionNotional)}`);
    if (gt(i.maxQuoteNotional, i.maxRestingNotionalPerSide)) throw new Error(`${i.instrument}: quote limit above the resting notional limit`);
    if (gt(i.maxQuoteNotional, i.maxInventoryNotional)) throw new Error(`${i.instrument}: quote limit above the inventory limit`);
    if (gt(i.maxInventoryNotional, m.maxGrossExposure)) throw new Error(`${i.instrument}: inventory limit above the mandate's gross exposure limit`);
    if (gt(i.maxQuoteNotional, m.rate.dailyTurnover)) throw new Error(`${i.instrument}: quote limit above the daily turnover limit`);
  }
  if (gt(m.maxGrossExposure, p.maxGrossExposure)) throw new Error(`gross exposure limit above the authorization's ${canon(p.maxGrossExposure)}`);
  if (m.minHalfSpreadBps >= m.maxDistanceBps) throw new Error('the minimum distance from the mid must be below the maximum distance');
  if (m.maxDistanceBps > p.maxPriceDeviationBps) throw new Error(`quote band wider than the authorization's ${p.maxPriceDeviationBps} bps`);
  if (m.maxReduceDeviationBps > p.maxPriceDeviationBps) throw new Error(`reduce band wider than the authorization's ${p.maxPriceDeviationBps} bps`);
  if (m.rate.ordersPerHour > m.rate.ordersPerDay) throw new Error('orders per hour above orders per day');
  if (m.expiresAt <= nowSec) throw new Error('mandate already expired');
  if (m.createdAt > nowSec + 120 || m.createdAt < nowSec - 600) throw new Error('mandate creation time is not current');
  if (m.expiresAt - m.createdAt > B.maxDays * 86400) throw new Error(`a quoting mandate lasts at most ${B.maxDays} days`);
  if (m.expiresAt > a.expiresAt) throw new Error('the mandate would outlive its authorization');
}

// ---------------------------------------------------------------------------------------------------------------------------
// Price rules against the signer's own mid — exact (cross-multiplied), no division

export interface QuoteBandError { code: 'crosses_mid' | 'too_tight' | 'too_far'; reason: string }
/**
 * A quote never sits at or through the mid, never closer than `minHalfSpreadBps`, never further than `maxDistanceBps`:
 *   bid: mid × (1 − max) ≤ price ≤ mid × (1 − min)        ask: mid × (1 + min) ≤ price ≤ mid × (1 + max)
 */
export function quoteBandError(side: 'buy' | 'sell', price: DecStr, mid: DecStr, minHalfSpreadBps: number, maxDistanceBps: number): QuoteBandError | null {
  const p = D.from(price), m = D.from(mid), k = D.from(10000n);
  if (!D.isPos(p) || !D.isPos(m)) return { code: 'too_far', reason: 'no positive price' };
  const lhs = D.mul(p, k), at = (bps: number) => D.mul(m, D.from(BigInt(side === 'buy' ? 10000 - bps : 10000 + bps)));
  if (side === 'buy') {
    if (D.gte(p, m)) return { code: 'crosses_mid', reason: `bid ${canon(price)} is at or above` };
    if (D.gt(lhs, at(minHalfSpreadBps))) return { code: 'too_tight', reason: `bid ${canon(price)} is closer than ${minHalfSpreadBps} bps to` };
    if (D.lt(lhs, at(maxDistanceBps))) return { code: 'too_far', reason: `bid ${canon(price)} is more than ${maxDistanceBps} bps below` };
  } else {
    if (D.lte(p, m)) return { code: 'crosses_mid', reason: `ask ${canon(price)} is at or below` };
    if (D.lt(lhs, at(minHalfSpreadBps))) return { code: 'too_tight', reason: `ask ${canon(price)} is closer than ${minHalfSpreadBps} bps to` };
    if (D.gt(lhs, at(maxDistanceBps))) return { code: 'too_far', reason: `ask ${canon(price)} is more than ${maxDistanceBps} bps above` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The order-set bound: counts, notional and worst-case inventory AFTER a batch

export interface QuotingSetStats {
  /** per side of the batch's instrument, after the batch */
  count: { buy: number; sell: number }; notional: { buy: DecStr; sell: DecStr };
  /** every instrument of the mandate, both sides */
  total: number;
  worstInventory: DecStr; worstGross: DecStr;
}
export type QuotingSetCode = 'quote_notional' | 'resting_count' | 'resting_total' | 'resting_notional' | 'inventory_exceeded' | 'gross_exceeded' | 'venue_inconsistent';
export type QuotingSetResult = { ok: true; stats: QuotingSetStats } | { ok: false; code: QuotingSetCode; message: string };
/**
 * Would the order set stay inside the mandate if `batch` (quotes on `instrument`) were added?
 * `positions`: the account's positions (signed sizes). `resting`: every non-reduce-only order that rests or can still land —
 * whoever placed it, every instrument. `prices`: the signer's own price per instrument (all of those with a position).
 * An order is valued at the higher of its own price and the instrument's price; the position at the instrument's price.
 */
export function quotingSetCheck(m: Pick<VenueQuotingMandate, 'instruments' | 'maxRestingTotal' | 'maxGrossExposure'>, instrument: string, positions: readonly ExposurePosition[], resting: readonly ExposureOrder[],
  batch: readonly { side: 'buy' | 'sell'; size: DecStr; price: DecStr }[], prices: Readonly<Record<string, DecStr>>, extraGrossCap: DecStr | null = null): QuotingSetResult {
  const mi = m.instruments.find((i) => i.instrument === instrument);
  if (!mi) return { ok: false, code: 'venue_inconsistent', message: `${instrument} is not an instrument of the mandate` };
  const mid = Object.hasOwn(prices, instrument) ? D.from(prices[instrument]!) : null;
  if (mid === null || !D.isPos(mid)) return { ok: false, code: 'venue_inconsistent', message: `no price for ${instrument}` };
  const value = (o: { size: DecStr; price: DecStr }): Dec => D.mul(D.from(o.size), D.max(D.from(o.price), mid));
  for (const o of batch) {
    const n = value(o);
    if (D.gt(n, D.from(mi.maxQuoteNotional))) return { ok: false, code: 'quote_notional', message: `a quote of ${D.str(n)} is above the mandate's ${canon(mi.maxQuoteNotional)} per quote` };
  }
  const added: ExposureOrder[] = batch.map((o) => ({ instrument, side: o.side, size: o.size, price: o.price, reduceOnly: false }));
  const all = [...resting.filter((o) => !o.reduceOnly), ...added], names = new Set(m.instruments.map((i) => i.instrument));
  const count = { buy: 0, sell: 0 }, notional = { buy: D.zero, sell: D.zero };
  let total = 0;
  for (const o of all) {
    if (names.has(o.instrument)) total += 1;
    if (o.instrument !== instrument) continue;
    count[o.side] += 1; notional[o.side] = D.add(notional[o.side], value(o));
  }
  for (const side of ['buy', 'sell'] as const) {
    if (!batch.some((o) => o.side === side)) continue;               // a side the batch does not touch is not this batch's doing
    if (count[side] > mi.maxRestingPerSide) return { ok: false, code: 'resting_count', message: `${count[side]} ${side} orders would rest on ${instrument}, above the mandate's ${mi.maxRestingPerSide} per side` };
    if (D.gt(notional[side], D.from(mi.maxRestingNotionalPerSide))) return { ok: false, code: 'resting_notional', message: `${D.str(notional[side])} would rest on the ${side} side of ${instrument}, above the mandate's ${canon(mi.maxRestingNotionalPerSide)}` };
  }
  if (batch.length && total > m.maxRestingTotal) return { ok: false, code: 'resting_total', message: `${total} orders would rest in total, above the mandate's ${m.maxRestingTotal}` };
  let w: ReturnType<typeof worstCaseExposure>;
  try { w = worstCaseExposure(positions, all, prices); } catch (e) { return { ok: false, code: 'venue_inconsistent', message: (e as Error).message }; }
  const worst = w.perInstrument[instrument] ?? '0';
  if (D.gt(D.from(worst), D.from(mi.maxInventoryNotional))) return { ok: false, code: 'inventory_exceeded', message: `worst-case ${instrument} inventory ${worst} (position + every resting and pending quote of one side + this batch, at the signer's price) is above the mandate's ${canon(mi.maxInventoryNotional)}` };
  const cap = extraGrossCap === null ? D.from(m.maxGrossExposure) : D.min(D.from(m.maxGrossExposure), D.from(extraGrossCap));
  if (D.gt(D.from(w.gross), cap)) return { ok: false, code: 'gross_exceeded', message: `worst-case gross exposure ${w.gross} is above ${D.str(cap)}` };
  return { ok: true, stats: { count, notional: { buy: D.str(notional.buy), sell: D.str(notional.sell) }, total, worstInventory: worst, worstGross: w.gross } };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Token bucket in integers: one token = 60 000 units, so that the refill (elapsed ms × tokens per minute) is exact

export interface QuotingBucket { /** units; 60 000 = one action */ units: number; /** unix ms the units were last brought up to date */ at: number }
export const BUCKET_UNITS_PER_TOKEN = 60_000;
export const bucketFull = (burstActions: number, nowMs: number): QuotingBucket => ({ units: burstActions * BUCKET_UNITS_PER_TOKEN, at: nowMs });
/** the bucket at `nowMs`: refilled for the time elapsed, never above its capacity; a clock that went backwards refills nothing */
export function bucketAt(b: QuotingBucket, nowMs: number, burstActions: number, actionsPerMinute: number): QuotingBucket {
  const cap = burstActions * BUCKET_UNITS_PER_TOKEN, elapsed = Math.max(0, nowMs - b.at);
  return { units: Math.min(cap, Math.max(0, b.units) + Math.min(cap, elapsed * actionsPerMinute)), at: Math.max(b.at, nowMs) };
}
/** takes one token; null when the bucket is empty */
export function bucketTake(b: QuotingBucket, nowMs: number, burstActions: number, actionsPerMinute: number): QuotingBucket | null {
  const x = bucketAt(b, nowMs, burstActions, actionsPerMinute);
  return x.units < BUCKET_UNITS_PER_TOKEN ? null : { units: x.units - BUCKET_UNITS_PER_TOKEN, at: x.at };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/live/canonical.ts
 * Module           : live
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-17
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

// Canonical objects of controlled live trading and their hashes. The owner's passkey signs the SHA-256 of these bytes, and the
// isolated signer recomputes the same bytes from the same fields: what the screen shows is what the passkey commits to.
//
//  - VenueAuthorization: the owner turns live trading on for ONE venue account. It names the trading ("agent") key, the limits the
//    signer will enforce, the expiry, and the hash of the jurisdiction acknowledgement that was displayed.
//  - VenueOrder / VenueLeverage: one order or one leverage change, exactly as the venue will receive it.
//
// Serialization: a domain tag, then (name, value) pairs in an order fixed by this code, each length-prefixed. Never JSON key order.
// Pure: no network, no clock, no key.
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { D, type DecStr } from '../decimal.ts';
import { DecStrSchema, OrderSideSchema, TifSchema } from '../models.ts';

export const VENUE_AUTH_MAX_DAYS = 90;
/** an order or leverage approval is valid at most this long (nonce → expiry) */
export const VENUE_ACTION_MAX_TTL_MS = 120_000;
/** hard ceilings of the signer-side venue policy (the owner chooses below them) */
export const VENUE_POLICY_BOUNDS = { maxLeverage: 20, maxOrdersPerDay: 500, minPriceBandBps: 10, maxPriceBandBps: 2000, maxInstruments: 256 } as const;   // 2026-11-17: an authorization may allow the venue's whole dex (was 8)

const enc = new TextEncoder();
const ADDRESS = /^0x[0-9a-f]{40}$/;
const PosDec = DecStrSchema.refine((x) => !x.startsWith('-') && /[1-9]/.test(x), 'must be positive');
const canon = (x: DecStr): DecStr => D.str(D.from(x));

function encode(domain: string, fields: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [enc.encode(domain), new Uint8Array([0])];
  for (const [k, v] of fields) {
    const kb = enc.encode(k), vb = enc.encode(v), head = new Uint8Array(6);
    new DataView(head.buffer).setUint16(0, kb.length);
    new DataView(head.buffer).setUint32(2, vb.length);
    parts.push(head, kb, vb);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------------------------------------------------------
// Signer-side venue policy: the limits the signer itself enforces (or, for the two it cannot see, that the API must respect)

export const VenuePolicySchema = z.strictObject({
  /** instrument ids (`hyperliquid:BTC`); each must be in the signer's pinned asset table */
  allowedInstruments: z.array(z.string().regex(/^hyperliquid:[A-Za-z0-9]{1,15}$/)).min(1).max(VENUE_POLICY_BOUNDS.maxInstruments),
  /** highest leverage SETTING the signer will sign for an instrument (integer, as the venue takes it) */
  maxLeverage: z.number().int().min(1).max(VENUE_POLICY_BOUNDS.maxLeverage),
  /** size × limit/worst price of one order, in the venue's collateral (USDC) — enforced by the signer on every order */
  maxOrderNotional: PosDec,
  /** resulting position per instrument and resulting gross exposure. The signer has NO view of positions: it only refuses an
   *  order whose own notional exceeds them; the rest is enforced by the API's risk engine against the venue's real state. */
  maxPositionNotional: PosDec,
  maxGrossExposure: PosDec,
  /** orders signed per UTC day (cancels are not counted: stopping is always possible) */
  maxOrdersPerDay: z.number().int().min(1).max(VENUE_POLICY_BOUNDS.maxOrdersPerDay),
  /** every price of an order (limit/worst price and trigger price) must be within this band of the signer's OWN mid for the asset */
  maxPriceDeviationBps: z.number().int().min(VENUE_POLICY_BOUNDS.minPriceBandBps).max(VENUE_POLICY_BOUNDS.maxPriceBandBps),
});
export type VenuePolicy = z.infer<typeof VenuePolicySchema>;

export const VenueAuthorizationSchema = z.strictObject({
  v: z.literal(1),
  authorizationId: z.uuid(),
  /** the owner key (signer key id) this authorization belongs to */
  keyId: z.string().min(8).max(80),
  venue: z.literal('hyperliquid'),
  network: z.enum(['mainnet', 'testnet']),
  /** the venue account = the owner's own EVM address (lower case) */
  account: z.string().regex(ADDRESS),
  /** the dedicated trading key (Hyperliquid API wallet) derived by the signer for this venue and network (lower case) */
  agentAddress: z.string().regex(ADDRESS),
  /** name under which the venue registers the API wallet; approving the same name again replaces it */
  agentName: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
  /** MANDATE_LIVE is part of the schema so that it can be refused by name; only MANUAL_LIVE is accepted */
  mode: z.enum(['MANUAL_LIVE', 'MANDATE_LIVE']),
  policy: VenuePolicySchema,
  /** unix seconds */
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  /** nonce (unix ms) of the venue's approveAgent action that this authorization lets the main key sign — exactly one */
  approveNonce: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** SHA-256 of the jurisdiction acknowledgement text that was shown to the owner */
  ackSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VenueAuthorization = z.infer<typeof VenueAuthorizationSchema>;

export function venueAuthorizationBytes(a: VenueAuthorization): Uint8Array {
  const x = VenueAuthorizationSchema.parse(a), p = x.policy;
  return encode('SPW-VENUE-AUTH-v1', [
    ['v', '1'], ['authorizationId', x.authorizationId], ['keyId', x.keyId], ['venue', x.venue], ['network', x.network], ['account', x.account],
    ['agentAddress', x.agentAddress], ['agentName', x.agentName], ['mode', x.mode],
    ['policy.allowedInstruments', [...p.allowedInstruments].sort().join(',')], ['policy.maxLeverage', String(p.maxLeverage)],
    ['policy.maxOrderNotional', canon(p.maxOrderNotional)], ['policy.maxPositionNotional', canon(p.maxPositionNotional)], ['policy.maxGrossExposure', canon(p.maxGrossExposure)],
    ['policy.maxOrdersPerDay', String(p.maxOrdersPerDay)], ['policy.maxPriceDeviationBps', String(p.maxPriceDeviationBps)],
    ['createdAt', String(x.createdAt)], ['expiresAt', String(x.expiresAt)], ['approveNonce', String(x.approveNonce)], ['ackSha256', x.ackSha256],
  ]);
}
export const venueAuthorizationHash = (a: VenueAuthorization): Uint8Array => sha256(venueAuthorizationBytes(a));

/** the agent name as the venue receives it: the venue itself drops the API wallet at the authorization's expiry */
export const venueAgentWireName = (a: Pick<VenueAuthorization, 'agentName' | 'expiresAt'>): string => `${a.agentName} valid_until ${a.expiresAt * 1000}`;

/** Structural validity at approval time. The signer additionally checks the key id, both addresses, the pinned asset table and the acknowledgement hash. */
export function validateVenueAuthorization(a: VenueAuthorization, nowSec: number): void {
  if (a.mode !== 'MANUAL_LIVE') throw new Error('a venue authorization is always MANUAL_LIVE: trading without a passkey per order (MANDATE_LIVE) is not granted by an authorization but by a derivative mandate that extends one, approved separately with the passkey');
  if (a.account === a.agentAddress) throw new Error('the trading key must differ from the account key');
  if (new Set(a.policy.allowedInstruments).size !== a.policy.allowedInstruments.length) throw new Error('duplicate instrument');
  const order = D.from(a.policy.maxOrderNotional), position = D.from(a.policy.maxPositionNotional), gross = D.from(a.policy.maxGrossExposure);
  if (D.gt(order, position)) throw new Error('order limit above the position limit');
  if (D.gt(position, gross)) throw new Error('position limit above the gross exposure limit');
  if (a.expiresAt <= nowSec) throw new Error('authorization already expired');
  if (a.createdAt > nowSec + 120 || a.createdAt < nowSec - 600) throw new Error('authorization creation time is not current');
  if (a.expiresAt - a.createdAt > VENUE_AUTH_MAX_DAYS * 86400) throw new Error(`an authorization lasts at most ${VENUE_AUTH_MAX_DAYS} days`);
  if (Math.abs(a.approveNonce - a.createdAt * 1000) > 600_000) throw new Error('approval nonce is not current');
  if (String(a.expiresAt * 1000).length !== 13) throw new Error('expiry cannot be expressed to the venue');
}

// ---------------------------------------------------------------------------------------------------------------------------
// One order — the fields the approval screen shows, in the venue's own normal form (what `describe` reads back from the payload)

export const VENUE_ORDER_TYPES = ['limit', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit'] as const;
const head = {
  v: z.literal(1),
  authorizationId: z.uuid(),
  venue: z.literal('hyperliquid'),
  network: z.enum(['mainnet', 'testnet']),
  account: z.string().regex(ADDRESS),
  /** venue nonce (unix ms) and the time after which the venue itself refuses the signed action (unix ms) */
  nonce: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const VenueOrderSchema = z.strictObject({
  ...head,
  kind: z.literal('order'),
  instrument: z.string().regex(/^hyperliquid:[A-Za-z0-9]{1,15}$/),
  side: OrderSideSchema,
  /** a market order is an immediate-or-cancel LIMIT at its worst acceptable price: it appears here as `limit` + `ioc` */
  type: z.enum(VENUE_ORDER_TYPES),
  size: PosDec,
  /** limit price, or worst acceptable price */
  price: PosDec,
  triggerPrice: PosDec.nullable(),
  reduceOnly: z.boolean(),
  tif: TifSchema,
  /** the venue's client order id (128-bit hex), derived from the Idempotency-Key */
  clientId: z.string().regex(/^0x[0-9a-f]{32}$/),
});
export type VenueOrder = z.infer<typeof VenueOrderSchema>;

export function venueOrderBytes(o: VenueOrder): Uint8Array {
  const x = VenueOrderSchema.parse(o);
  return encode('SPW-VENUE-ORDER-v1', [
    ['v', '1'], ['authorizationId', x.authorizationId], ['venue', x.venue], ['network', x.network], ['account', x.account], ['kind', x.kind],
    ['instrument', x.instrument], ['side', x.side], ['type', x.type], ['size', canon(x.size)], ['price', canon(x.price)],
    ['triggerPrice', x.triggerPrice === null ? '' : canon(x.triggerPrice)], ['reduceOnly', x.reduceOnly ? '1' : '0'], ['tif', x.tif], ['clientId', x.clientId],
    ['nonce', String(x.nonce)], ['expiresAt', String(x.expiresAt)],
  ]);
}
export const venueOrderHash = (o: VenueOrder): Uint8Array => sha256(venueOrderBytes(o));

export const VenueLeverageSchema = z.strictObject({
  ...head,
  kind: z.literal('leverage'),
  instrument: z.string().regex(/^hyperliquid:[A-Za-z0-9]{1,15}$/),
  leverage: z.number().int().min(1).max(1000),
  marginMode: z.enum(['cross', 'isolated']),
});
export type VenueLeverage = z.infer<typeof VenueLeverageSchema>;

export function venueLeverageBytes(l: VenueLeverage): Uint8Array {
  const x = VenueLeverageSchema.parse(l);
  return encode('SPW-VENUE-LEVERAGE-v1', [
    ['v', '1'], ['authorizationId', x.authorizationId], ['venue', x.venue], ['network', x.network], ['account', x.account], ['kind', x.kind],
    ['instrument', x.instrument], ['leverage', String(x.leverage)], ['marginMode', x.marginMode], ['nonce', String(x.nonce)], ['expiresAt', String(x.expiresAt)],
  ]);
}
export const venueLeverageHash = (l: VenueLeverage): Uint8Array => sha256(venueLeverageBytes(l));

/** validity window shared by orders and leverage changes: the venue expiry is after the nonce and at most two minutes later */
export function venueWindowError(x: { nonce: number; expiresAt: number }, nowMs: number): string | null {
  if (x.expiresAt <= x.nonce) return 'expiry is not after the nonce';
  if (x.expiresAt - x.nonce > VENUE_ACTION_MAX_TTL_MS) return `validity window longer than ${VENUE_ACTION_MAX_TTL_MS / 1000} s`;
  if (x.expiresAt <= nowMs) return 'approval window expired';
  if (x.nonce > nowMs + 60_000) return 'nonce is dated in the future';
  if (x.nonce < nowMs - VENUE_ACTION_MAX_TTL_MS) return 'nonce is stale';
  return null;
}

/** notional the signer bounds: size × the highest price the order names (limit/worst price, or trigger price when higher) */
export function venueOrderNotional(o: Pick<VenueOrder, 'size' | 'price' | 'triggerPrice'>): DecStr {
  const price = o.triggerPrice === null ? D.from(o.price) : D.max(D.from(o.price), D.from(o.triggerPrice));
  return D.str(D.mul(D.from(o.size), price));
}

/** |price − mid| / mid ≤ bps / 10000, exactly (cross-multiplied) */
export function withinBand(price: DecStr, mid: DecStr, bps: number): boolean {
  const p = D.from(price), m = D.from(mid);
  if (!D.isPos(p) || !D.isPos(m)) return false;
  return D.lte(D.mul(D.abs(D.sub(p, m)), D.from(10000n)), D.mul(D.from(BigInt(bps)), m));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Price rule of one order against a reference mid — ONE function for the signer (its own Coinbase + Kraken mid) and for the
// API's pre-check (the venue's mark), so that what the signer will refuse is refused before the passkey prompt (V11, B-07).

/** a resting protective trigger may sit this far from the mid: mid ÷ 3 ≤ trigger ≤ mid × 3 (a typo of one order of magnitude is refused) */
export const VENUE_TRIGGER_SANITY_RATIO = 3;
const isStopType = (t: VenueOrder['type']): boolean => t === 'stop_market' || t === 'stop_limit';
/**
 * Does the trigger rest (true) or fire at once (false) at this mid? A stop fires when the market moves AGAINST the closing side
 * (sell stop: at or below its trigger; buy stop: at or above), a take-profit when it moves in its favour.
 */
export function venueTriggerRests(o: Pick<VenueOrder, 'side' | 'type' | 'triggerPrice'>, mid: DecStr): boolean {
  if (o.triggerPrice === null || o.type === 'limit') return false;
  const t = D.from(o.triggerPrice), m = D.from(mid), below = D.lt(t, m), above = D.gt(t, m);
  return isStopType(o.type) ? (o.side === 'sell' ? below : above) : (o.side === 'sell' ? above : below);
}
/**
 * Why the prices of an order are not acceptable against `mid`; null when they are.
 *  - Every order: limit/worst price and trigger price within `bandBps` of the mid (the rule of every version before V11).
 *  - In addition, and ONLY for a reduce-only trigger order (a stop-loss or a take-profit that can only shrink a position): the
 *    trigger may rest anywhere on its protective side inside the sanity band, and its limit/worst price is then compared with
 *    the TRIGGER (where it will execute), not with today's mid. A trigger that would fire at once gets no such latitude.
 * `reason` ends where the caller names its reference ("… the signer's own BTC price 70000").
 */
export function venueOrderPriceError(o: Pick<VenueOrder, 'side' | 'type' | 'price' | 'triggerPrice' | 'reduceOnly'>, mid: DecStr, bandBps: number): { what: 'price' | 'trigger price'; reason: string } | null {
  const far = (what: 'price' | 'trigger price', px: DecStr) => ({ what, reason: `${what} ${canon(px)} is more than ${bandBps} bps away from` });
  const priceOk = withinBand(o.price, mid, bandBps), triggerOk = o.triggerPrice === null || withinBand(o.triggerPrice, mid, bandBps);
  if (priceOk && triggerOk) return null;
  if (o.triggerPrice === null || o.type === 'limit' || !o.reduceOnly) return !priceOk ? far('price', o.price) : far('trigger price', o.triggerPrice!);
  // a reduce-only trigger order outside the plain band
  if (!venueTriggerRests(o, mid)) return !triggerOk ? { what: 'trigger price', reason: `trigger price ${canon(o.triggerPrice)} would fire at once and is more than ${bandBps} bps away from` } : far('price', o.price);
  const t = D.from(o.triggerPrice), m = D.from(mid), k = D.from(BigInt(VENUE_TRIGGER_SANITY_RATIO));
  if (!D.isPos(t) || !D.isPos(m) || D.gt(t, D.mul(m, k)) || D.lt(D.mul(t, k), m)) return { what: 'trigger price', reason: `trigger price ${canon(o.triggerPrice)} is outside the sanity band (÷${VENUE_TRIGGER_SANITY_RATIO} to ×${VENUE_TRIGGER_SANITY_RATIO}) around` };
  if (!withinBand(o.price, o.triggerPrice, bandBps)) return { what: 'price', reason: `price ${canon(o.price)} is more than ${bandBps} bps away from its own trigger price ${canon(o.triggerPrice)}, which rests against` };
  return null;
}

/** the serialization above, for the other canonical objects of live trading (mandate.ts) */
export const canonicalEncode = encode;

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/mandate/trading-mandate.ts
 * Module           : mandate
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

/**
 * Trading mandate `SPW-TRADING-MANDATE-v1`: the single object that says what an agent or an API key may do, on which accounts,
 * venues and instruments, inside which limits, until when. The owner approves its canonical hash once.
 *
 * A trading mandate is the API-side contract. It is NOT by itself enforced by the isolated signer: the signer enforces the two
 * shapes it already stores — the spot vault mandate `SPW-MANDATE-v1` (packages/core/src/mandate.ts) and the derivative mandate
 * `SPW-VENUE-MANDATE-v1` (packages/derivatives/src/live/mandate.ts). `compileToSpotMandate` and `compileToVenueMandate` derive
 * those shapes from a trading mandate and report, field by field, what the signer then enforces and what stays enforced by the
 * API only. Nothing is dropped in silence: a mandate that cannot be expressed for a venue fails with a typed error.
 *
 * Immutable: there is no update. Any change is a new mandate with a new id and a new hash; the old one is revoked
 * (`TradingMandateRevocation`).
 *
 * Units: times of the MANDATE are unix seconds (as in the two signer shapes); times of ORDERS are unix milliseconds.
 * Pure: no clock, no network, no randomness.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { MandateSchema, MAX_MANDATE_DAYS, type Mandate } from '@spw/core';
import { D, type DecStr } from '@spw/derivatives';
import { canonicalEncode, hex, VENUE_MANDATE_BOUNDS, VENUE_MANDATE_MAX_DAYS, VENUE_MANDATE_WIND_DOWN_S, VENUE_POLICY_BOUNDS, VenueMandateSchema, type VenueAuthorization, type VenueMandate } from '@spw/derivatives/live';
import { canon, cmpStr, NonNegDecSchema, PosDecSchema, TsSecSchema } from '../dec.ts';
import { CANONICAL_ORDER_TYPES, CanonicalOrderTypeSchema, highestNamedPrice, MarketKindSchema, type CanonicalOrder } from '../orders/canonical.ts';

export const TRADING_MANDATE_DOMAIN = 'SPW-TRADING-MANDATE-v1';
/** longest validity of a trading mandate. A signer shape may be shorter (derivative mandates: 30 days): compilation then fails. */
export const TRADING_MANDATE_MAX_DAYS = MAX_MANDATE_DAYS;
export const TRADING_MANDATE_BOUNDS = { maxInstruments: 24, maxAccounts: 8, maxStopConditions: 10, maxOrdersPerDay: 500, maxSlippageBps: 2000 } as const;
/** after a mandate ends (expiry or revocation) strictly reducing orders are still allowed this long — the signer's own wind-down */
export const TRADING_MANDATE_WIND_DOWN_S = VENUE_MANDATE_WIND_DOWN_S;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const MandateAccountSchema = z.discriminatedUnion('kind', [
  /** an agent vault of the wallet (HD account index ≥ 1; index 0 is the owner's own wallet and can never be mandated) */
  z.strictObject({ kind: z.literal('vault'), vaultIndex: z.number().int().min(1).max(100_000), address: z.string().min(20).max(110), network: Id }),
  /** an account on a venue */
  z.strictObject({ kind: z.literal('venue_account'), venue: Id, network: Id, account: z.string().min(1).max(110) }),
]);
export type MandateAccount = z.infer<typeof MandateAccountSchema>;

export const StopConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('loss_gte'), usd: PosDecSchema }),
  z.strictObject({ kind: z.literal('drawdown_gte'), bps: z.number().int().min(1).max(10_000) }),
  z.strictObject({ kind: z.literal('consecutive_rejects_gte'), count: z.number().int().min(1).max(1000) }),
  z.strictObject({ kind: z.literal('data_stale_gte'), ms: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('signer_unreachable_gte'), ms: z.number().int().min(1) }),
]);
export type StopCondition = z.infer<typeof StopConditionSchema>;

export const TradingMandateSchema = z.strictObject({
  v: z.literal(1),
  mandateId: z.uuid(),
  principal: z.strictObject({ kind: z.enum(['agent', 'api_key']), id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/) }),
  /** wallets / accounts the principal may trade from */
  accounts: z.array(MandateAccountSchema).min(1).max(TRADING_MANDATE_BOUNDS.maxAccounts),
  venues: z.array(Id).min(1).max(8),
  networks: z.array(Id).min(1).max(8),
  /** instrument ids `${venue}:${symbol}`. A live mandate lists every instrument; `${venue}:*` is accepted in a paper mandate only */
  instruments: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}:(\*|[A-Za-z0-9._/-]{1,60})$/)).min(1).max(TRADING_MANDATE_BOUNDS.maxInstruments),
  marketKinds: z.array(MarketKindSchema).min(1).max(2),
  orderTypes: z.array(CanonicalOrderTypeSchema).min(1).max(CANONICAL_ORDER_TYPES.length),
  /** capital committed to the mandate, USD: the collateral / inventory the principal may put at risk */
  maxCapitalUsd: PosDecSchema,
  maxOrderNotionalUsd: PosDecSchema,
  /** the same limit for each instrument */
  maxPositionNotionalUsd: PosDecSchema,
  maxLeverage: PosDecSchema,
  /** positive amount: no new risk once today's loss reaches it */
  maxDailyLossUsd: PosDecSchema,
  /** max total loss, as a floor: no new risk while the equity of the mandated accounts is below it. floor = capital − max total loss */
  floorEquityUsd: NonNegDecSchema,
  /** unix seconds */
  createdAt: TsSecSchema, notBefore: TsSecSchema, notAfter: TsSecSchema,
  frequency: z.strictObject({ perMinute: z.number().int().min(1).max(600), perHour: z.number().int().min(1).max(10_000), perDay: z.number().int().min(1).max(TRADING_MANDATE_BOUNDS.maxOrdersPerDay) }),
  maxSlippageBps: z.number().int().min(1).max(TRADING_MANDATE_BOUNDS.maxSlippageBps),
  /** highest fee of ONE order, USD */
  maxFeeUsd: NonNegDecSchema,
  /** declarative: when one is met, the mandate takes no new risk (strictly reducing orders stay possible) */
  stopConditions: z.array(StopConditionSchema).max(TRADING_MANDATE_BOUNDS.maxStopConditions),
  mode: z.enum(['paper', 'live']),
  /** SHA-256 of the strategy code, for agents; null when there is none (an API key) */
  strategySha256: Sha.nullable(),
  label: z.string().min(1).max(60),
});
export type TradingMandate = z.infer<typeof TradingMandateSchema>;
export const TRADING_MANDATE_FIELDS = Object.keys(TradingMandateSchema.shape) as (keyof TradingMandate)[];

// ------------------------------------------------------------------------------------------------------------------ canonical form

const accountKey = (a: MandateAccount): string => (a.kind === 'vault' ? `vault|${a.network}|${a.vaultIndex}|${a.address}` : `venue_account|${a.venue}|${a.network}|${a.account}`);
const stopKey = (s: StopCondition): string => (s.kind === 'loss_gte' ? `${s.kind}|${canon(s.usd)}` : s.kind === 'drawdown_gte' ? `${s.kind}|${s.bps}` : s.kind === 'consecutive_rejects_gte' ? `${s.kind}|${s.count}` : `${s.kind}|${s.ms}`);
const sorted = (xs: readonly string[]): string[] => [...xs].sort(cmpStr);

/** deterministic, length-prefixed, domain-separated serialization; every list in sorted order */
export function tradingMandateBytes(m: TradingMandate): Uint8Array {
  const x = TradingMandateSchema.parse(m);
  return canonicalEncode(TRADING_MANDATE_DOMAIN, [
    ['v', '1'], ['mandateId', x.mandateId], ['principal.kind', x.principal.kind], ['principal.id', x.principal.id],
    ['accounts', sorted(x.accounts.map(accountKey)).join(',')], ['venues', sorted(x.venues).join(',')], ['networks', sorted(x.networks).join(',')],
    ['instruments', sorted(x.instruments).join(',')], ['marketKinds', sorted(x.marketKinds).join(',')], ['orderTypes', sorted(x.orderTypes).join(',')],
    ['maxCapitalUsd', canon(x.maxCapitalUsd)], ['maxOrderNotionalUsd', canon(x.maxOrderNotionalUsd)], ['maxPositionNotionalUsd', canon(x.maxPositionNotionalUsd)], ['maxLeverage', canon(x.maxLeverage)],
    ['maxDailyLossUsd', canon(x.maxDailyLossUsd)], ['floorEquityUsd', canon(x.floorEquityUsd)],
    ['createdAt', String(x.createdAt)], ['notBefore', String(x.notBefore)], ['notAfter', String(x.notAfter)],
    ['frequency.perMinute', String(x.frequency.perMinute)], ['frequency.perHour', String(x.frequency.perHour)], ['frequency.perDay', String(x.frequency.perDay)],
    ['maxSlippageBps', String(x.maxSlippageBps)], ['maxFeeUsd', canon(x.maxFeeUsd)], ['stopConditions', sorted(x.stopConditions.map(stopKey)).join(',')],
    ['mode', x.mode], ['strategySha256', x.strategySha256 ?? ''], ['label', x.label],
  ]);
}
export const tradingMandateHash = (m: TradingMandate): Uint8Array => sha256(tradingMandateBytes(m));
export const tradingMandateHashHex = (m: TradingMandate): string => hex(tradingMandateHash(m));

// ------------------------------------------------------------------------------------------------------------------ errors

export const TRADING_MANDATE_ERROR_CODES = [
  'invalid_mandate', 'paper_mandate_has_no_signer_form', 'no_signer_mandate_for_venue', 'venue_not_in_mandate', 'market_kind_not_expressible', 'account_not_in_mandate', 'ambiguous_account',
  'binding_mismatch', 'instrument_not_expressible', 'value_not_expressible', 'duration_not_expressible', 'strategy_hash_required', 'principal_not_expressible', 'missing_price', 'exceeds_authorization',
] as const;
export type TradingMandateErrorCode = (typeof TRADING_MANDATE_ERROR_CODES)[number];
export class TradingMandateError extends Error {
  readonly code: TradingMandateErrorCode; readonly field: keyof TradingMandate | null;
  constructor(code: TradingMandateErrorCode, message: string, field: keyof TradingMandate | null = null) { super(message); this.name = 'TradingMandateError'; this.code = code; this.field = field; }
}
function fail(code: TradingMandateErrorCode, message: string, field: keyof TradingMandate | null = null): never { throw new TradingMandateError(code, message, field); }

// ------------------------------------------------------------------------------------------------------------------ validity

const venueOf = (instrument: string): string => instrument.slice(0, instrument.indexOf(':'));
const gt = (a: DecStr, b: DecStr): boolean => D.gt(D.from(a), D.from(b));

/** structural validity at approval time; throws TradingMandateError('invalid_mandate') with the first reason */
export function validateTradingMandate(m: TradingMandate, nowSec: number): void {
  const p = TradingMandateSchema.safeParse(m);
  if (!p.success) fail('invalid_mandate', `${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim());
  const bad = (message: string, field: keyof TradingMandate) => fail('invalid_mandate', message, field);
  const dup = (xs: readonly string[]) => new Set(xs).size !== xs.length;
  if (dup(m.venues)) bad('duplicate venue', 'venues');
  if (dup(m.networks)) bad('duplicate network', 'networks');
  if (dup(m.instruments)) bad('duplicate instrument', 'instruments');
  if (dup(m.marketKinds)) bad('duplicate market kind', 'marketKinds');
  if (dup(m.orderTypes)) bad('duplicate order type', 'orderTypes');
  if (dup(m.accounts.map(accountKey))) bad('duplicate account', 'accounts');
  if (dup(m.stopConditions.map((s) => s.kind))) bad('one stop condition per kind', 'stopConditions');
  for (const i of m.instruments) {
    if (!m.venues.includes(venueOf(i))) bad(`${i} is on a venue outside the mandate`, 'instruments');
    if (i.endsWith(':*') && m.mode === 'live') bad('a live mandate lists every instrument: no wildcard', 'instruments');
  }
  for (const v of m.venues) if (!m.instruments.some((i) => venueOf(i) === v)) bad(`no instrument on ${v}`, 'venues');
  for (const a of m.accounts) {
    if (!m.networks.includes(a.network)) bad(`account on ${a.network}, a network outside the mandate`, 'accounts');
    if (a.kind === 'venue_account' && !m.venues.includes(a.venue)) bad(`account on ${a.venue}, a venue outside the mandate`, 'accounts');
  }
  if (gt(m.maxOrderNotionalUsd, m.maxPositionNotionalUsd)) bad('order limit above the position limit', 'maxOrderNotionalUsd');
  // a position can never be worth more than the capital at the highest leverage
  if (gt(m.maxPositionNotionalUsd, D.str(D.mul(D.from(m.maxCapitalUsd), D.from(m.maxLeverage))))) bad('position limit above capital × leverage', 'maxPositionNotionalUsd');
  if (D.lt(D.from(m.maxLeverage), D.one)) bad('leverage below 1', 'maxLeverage');
  if (!m.marketKinds.includes('perp') && !D.eq(D.from(m.maxLeverage), D.one)) bad('a spot-only mandate has leverage 1', 'maxLeverage');
  if (!D.lt(D.from(m.floorEquityUsd), D.from(m.maxCapitalUsd))) bad('the floor must be below the capital', 'floorEquityUsd');
  if (gt(m.maxDailyLossUsd, m.maxCapitalUsd)) bad('daily loss limit above the capital', 'maxDailyLossUsd');
  if (m.frequency.perMinute > m.frequency.perHour || m.frequency.perHour > m.frequency.perDay) bad('frequency limits must grow with the window: perMinute ≤ perHour ≤ perDay', 'frequency');
  if (m.notBefore < m.createdAt) bad('notBefore is before the creation time', 'notBefore');
  if (m.notAfter <= m.notBefore) bad('the validity window is empty', 'notAfter');
  if (m.notAfter <= nowSec) bad('mandate already expired', 'notAfter');
  if (m.createdAt > nowSec + 120 || m.createdAt < nowSec - 600) bad('mandate creation time is not current', 'createdAt');
  if (m.notAfter - m.createdAt > TRADING_MANDATE_MAX_DAYS * 86400) bad(`a mandate lasts at most ${TRADING_MANDATE_MAX_DAYS} days`, 'notAfter');
  if (m.principal.kind === 'agent' && m.strategySha256 === null) bad('an agent mandate names the strategy it was approved for', 'strategySha256');
}

// ------------------------------------------------------------------------------------------------------------------ revocation

export const REVOCATION_REASONS = ['owner_request', 'superseded', 'stop_condition', 'key_compromise', 'authorization_ended', 'kill_switch'] as const;
export const TradingMandateRevocationSchema = z.strictObject({
  v: z.literal(1),
  mandateId: z.uuid(),
  /** hash of the mandate being revoked: a revocation names exactly one immutable object */
  mandateHash: Sha,
  /** unix seconds */
  revokedAt: TsSecSchema,
  revokedBy: z.strictObject({ kind: z.enum(['owner', 'system']), id: z.string().min(1).max(80) }),
  reason: z.enum(REVOCATION_REASONS),
  /** the mandate that replaces it, when reason = superseded */
  supersededBy: z.uuid().nullable(),
  detail: z.string().max(300).nullable(),
});
export type TradingMandateRevocation = z.infer<typeof TradingMandateRevocationSchema>;
/** builds the revocation record of a mandate; revoking needs no approval and is final */
export function revokeTradingMandate(m: TradingMandate, r: Omit<TradingMandateRevocation, 'v' | 'mandateId' | 'mandateHash'>): TradingMandateRevocation {
  if ((r.reason === 'superseded') !== (r.supersededBy !== null)) throw new TradingMandateError('invalid_mandate', 'supersededBy is given exactly when the reason is superseded');
  return TradingMandateRevocationSchema.parse({ v: 1, mandateId: m.mandateId, mandateHash: tradingMandateHashHex(m), ...r });
}

export type TradingMandatePhase = 'pending' | 'active' | 'wind_down' | 'ended';
/** `pending` before notBefore; `wind_down` for TRADING_MANDATE_WIND_DOWN_S after the end (reducing orders only); then `ended` */
export function tradingMandatePhase(m: Pick<TradingMandate, 'notBefore' | 'notAfter'>, revokedAtSec: number | null, nowSec: number): TradingMandatePhase {
  const end = revokedAtSec === null ? m.notAfter : Math.min(revokedAtSec, m.notAfter);
  if (nowSec >= end) return nowSec < end + TRADING_MANDATE_WIND_DOWN_S ? 'wind_down' : 'ended';
  return nowSec < m.notBefore ? 'pending' : 'active';
}

// ------------------------------------------------------------------------------------------------------------------ checkOrder

export const MANDATE_DENY_CODES = [
  'INVALID_INPUT', 'MANDATE_NOT_YET_VALID', 'MANDATE_ENDED', 'MANDATE_REVOKED', 'WIND_DOWN_REDUCING_ONLY', 'PRINCIPAL_MISMATCH', 'MANDATE_ID_MISMATCH', 'MODE_MISMATCH',
  'ACCOUNT_NOT_ALLOWED', 'VENUE_NOT_ALLOWED', 'NETWORK_NOT_ALLOWED', 'INSTRUMENT_NOT_ALLOWED', 'MARKET_KIND_NOT_ALLOWED', 'ORDER_TYPE_NOT_ALLOWED',
  'NOTIONAL_UNKNOWN', 'ORDER_NOTIONAL_EXCEEDED', 'POSITION_NOTIONAL_EXCEEDED', 'CAPITAL_EXCEEDED', 'LEVERAGE_EXCEEDED', 'LEVERAGE_UNKNOWN', 'DAILY_LOSS_REACHED', 'BELOW_FLOOR_EQUITY',
  'RATE_PER_MINUTE', 'RATE_PER_HOUR', 'RATE_PER_DAY', 'SLIPPAGE_ABOVE_MANDATE', 'FEE_ABOVE_MANDATE', 'ORDER_OUTLIVES_MANDATE',
  'STOP_LOSS_GTE', 'STOP_DRAWDOWN_GTE', 'STOP_CONSECUTIVE_REJECTS_GTE', 'STOP_DATA_STALE_GTE', 'STOP_SIGNER_UNREACHABLE_GTE',
] as const;
export type MandateDenyCode = (typeof MANDATE_DENY_CODES)[number];

/** counters and measurements supplied by the caller; the mandate holds no state */
export interface TradingMandateUsage {
  /** unix seconds at which the mandate was revoked, or null */
  revokedAt: number | null;
  /** the account the order would be sent from */
  account: MandateAccount;
  /** from the risk engine (`RiskEvaluation.reducing`): the order strictly reduces an existing position */
  reducing: boolean;
  /** reference price of the instrument in USD, to value an order given as a size; null when unknown */
  referencePrice: DecStr | null;
  /** notional of the position on the order's instrument AFTER the order, USD (from the risk engine) */
  positionNotionalAfterUsd: DecStr;
  /** capital in use under the mandate AFTER the order, USD: margin of the open positions, or the value of the spot inventory */
  capitalInUseAfterUsd: DecStr;
  /** equity of the mandated accounts, USD */
  equityUsd: DecStr;
  /** loss realised today under the mandate, USD, positive = loss */
  realizedLossTodayUsd: DecStr;
  /** total loss since the mandate started (realised + unrealised), USD, positive = loss */
  totalLossUsd: DecStr;
  /** drawdown from the peak equity under the mandate, basis points */
  drawdownBps: number;
  /** orders already accepted under the mandate, not counting this one */
  ordersLastMinute: number; ordersLastHour: number; ordersToday: number;
  consecutiveRejects: number;
  /** age of the oldest market data the principal relies on, ms */
  dataStaleMs: number;
  /** for how long the signer has been unreachable, ms (0 = reachable) */
  signerUnreachableMs: number;
  /** leverage the order would run under, when the order does not carry one (the venue's current setting) */
  leverageSetting?: DecStr | null;
}
export interface MandateDecision { decision: 'allow' | 'deny'; reasons: MandateDenyCode[]; orderNotionalUsd: DecStr | null }

const instrumentAllowed = (m: TradingMandate, instrument: string): boolean => m.instruments.includes(instrument) || (m.mode === 'paper' && m.instruments.includes(`${venueOf(instrument)}:*`));
const sameAccount = (a: MandateAccount, b: MandateAccount): boolean => accountKey(a).toLowerCase() === accountKey(b).toLowerCase();

/**
 * Does the order fit the mandate? Collects EVERY reason. `nowMs` is the caller's clock in unix milliseconds (orders are in ms).
 *
 * A strictly reducing order (`usage.reducing`, decided by the risk engine) is exempt from the limits that would stop an exit:
 * capital, position, daily loss, floor, frequency, stop conditions, the validity window's start and the wind-down. It is still
 * bound to the mandate's principal, account, venue, network, instrument, mode, and to its end (`ended`).
 */
export function checkOrder(mandate: TradingMandate, order: CanonicalOrder, usage: TradingMandateUsage, nowMs: number): MandateDecision {
  const reasons: MandateDenyCode[] = [];
  const deny = (c: MandateDenyCode) => { if (!reasons.includes(c)) reasons.push(c); };
  let notional: DecStr | null = null;
  try {
    const m = TradingMandateSchema.parse(mandate);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('now');
    const nowSec = Math.floor(nowMs / 1000), red = usage.reducing === true;
    const phase = tradingMandatePhase(m, usage.revokedAt, nowSec);
    if (phase === 'ended') deny(usage.revokedAt !== null && usage.revokedAt <= m.notAfter ? 'MANDATE_REVOKED' : 'MANDATE_ENDED');
    if (phase === 'wind_down' && !red) { deny(usage.revokedAt !== null && usage.revokedAt <= m.notAfter ? 'MANDATE_REVOKED' : 'MANDATE_ENDED'); deny('WIND_DOWN_REDUCING_ONLY'); }
    if (phase === 'pending' && !red) deny('MANDATE_NOT_YET_VALID');
    if (order.principal.kind !== m.principal.kind || order.principal.id !== m.principal.id) deny('PRINCIPAL_MISMATCH');
    if (order.mandateId !== m.mandateId) deny('MANDATE_ID_MISMATCH');
    if (order.mode !== m.mode) deny('MODE_MISMATCH');
    if (!m.accounts.some((a) => sameAccount(a, usage.account)) || usage.account.network !== order.network || (usage.account.kind === 'venue_account' && usage.account.venue !== order.venue)) deny('ACCOUNT_NOT_ALLOWED');
    if (!m.venues.includes(order.venue)) deny('VENUE_NOT_ALLOWED');
    if (!m.networks.includes(order.network)) deny('NETWORK_NOT_ALLOWED');
    if (!instrumentAllowed(m, order.instrument)) deny('INSTRUMENT_NOT_ALLOWED');
    if (!m.marketKinds.includes(order.marketKind)) deny('MARKET_KIND_NOT_ALLOWED');
    if (!red && !m.orderTypes.includes(order.type)) deny('ORDER_TYPE_NOT_ALLOWED');
    // an order must not be able to execute after the mandate's end
    if (!red && order.expiresAt > m.notAfter * 1000) deny('ORDER_OUTLIVES_MANDATE');

    // notional: the order's own, or size × the highest of the reference price and the prices the order names
    if (order.notional !== null) notional = canon(order.notional);
    else {
      const named = highestNamedPrice(order), ref = usage.referencePrice;
      const px = ref !== null && named !== null ? D.max(D.from(ref), D.from(named)) : ref !== null ? D.from(ref) : order.type === 'limit' && named !== null ? D.from(named) : null;
      notional = px === null ? null : D.str(D.mul(D.from(order.size!), px));
    }
    if (notional === null) deny('NOTIONAL_UNKNOWN');
    else if (gt(notional, m.maxOrderNotionalUsd)) deny('ORDER_NOTIONAL_EXCEEDED');
    if (order.maxSlippageBps > m.maxSlippageBps) deny('SLIPPAGE_ABOVE_MANDATE');
    if (gt(order.maxFeeUsd, m.maxFeeUsd)) deny('FEE_ABOVE_MANDATE');

    if (!red) {
      if (order.marketKind === 'perp') {
        const lev = order.leverage ?? usage.leverageSetting ?? null;
        if (lev === null) deny('LEVERAGE_UNKNOWN'); else if (gt(lev, m.maxLeverage)) deny('LEVERAGE_EXCEEDED');
      }
      if (gt(usage.positionNotionalAfterUsd, m.maxPositionNotionalUsd)) deny('POSITION_NOTIONAL_EXCEEDED');
      if (gt(usage.capitalInUseAfterUsd, m.maxCapitalUsd)) deny('CAPITAL_EXCEEDED');
      if (D.gte(D.from(usage.realizedLossTodayUsd), D.from(m.maxDailyLossUsd))) deny('DAILY_LOSS_REACHED');
      if (D.lt(D.from(usage.equityUsd), D.from(m.floorEquityUsd))) deny('BELOW_FLOOR_EQUITY');
      const counts = [usage.ordersLastMinute, usage.ordersLastHour, usage.ordersToday, usage.consecutiveRejects, usage.dataStaleMs, usage.signerUnreachableMs, usage.drawdownBps];
      if (counts.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new RangeError('usage counters');
      if (usage.ordersLastMinute >= m.frequency.perMinute) deny('RATE_PER_MINUTE');
      if (usage.ordersLastHour >= m.frequency.perHour) deny('RATE_PER_HOUR');
      if (usage.ordersToday >= m.frequency.perDay) deny('RATE_PER_DAY');
      for (const s of m.stopConditions) {
        if (s.kind === 'loss_gte' && D.gte(D.from(usage.totalLossUsd), D.from(s.usd))) deny('STOP_LOSS_GTE');
        if (s.kind === 'drawdown_gte' && usage.drawdownBps >= s.bps) deny('STOP_DRAWDOWN_GTE');
        if (s.kind === 'consecutive_rejects_gte' && usage.consecutiveRejects >= s.count) deny('STOP_CONSECUTIVE_REJECTS_GTE');
        if (s.kind === 'data_stale_gte' && usage.dataStaleMs >= s.ms) deny('STOP_DATA_STALE_GTE');
        if (s.kind === 'signer_unreachable_gte' && usage.signerUnreachableMs >= s.ms) deny('STOP_SIGNER_UNREACHABLE_GTE');
      }
    }
  } catch {
    // fail closed: an input that cannot be read is a refusal
    deny('INVALID_INPUT');
  }
  return { decision: reasons.length ? 'deny' : 'allow', reasons, orderNotionalUsd: notional };
}

// ------------------------------------------------------------------------------------------------------------------ compilation

export type Enforcement = 'signer' | 'signer_partial' | 'api_only' | 'not_applicable';
export interface FieldEnforcement {
  field: keyof TradingMandate;
  /** `signer`: the isolated signer enforces it as approved. `signer_partial`: the signer enforces a related bound, the rest is the API's.
   *  `api_only`: only the API enforces it — a compromised API could ignore it. `not_applicable`: the field has no meaning for this shape. */
  enforcedBy: Enforcement;
  /** the field(s) of the signer shape that carry it */
  signerField: string | null;
  note: string;
}
export interface CompiledMandate<T> { shape: 'SPW-MANDATE-v1' | 'SPW-VENUE-MANDATE-v1'; mandate: T; enforcement: FieldEnforcement[]; /** the signer shape's values that were derived, not copied */ derived: { field: string; value: string; from: string }[] }

/** venues that have a signer-side mandate, and which shape. Everything else has none: compilation fails. */
export const SIGNER_MANDATE_SHAPES: Readonly<Record<string, 'SPW-MANDATE-v1' | 'SPW-VENUE-MANDATE-v1'>> = { hyperliquid: 'SPW-VENUE-MANDATE-v1', kyberswap: 'SPW-MANDATE-v1' };

function enforcementTable(rows: Partial<Record<keyof TradingMandate, [Enforcement, string | null, string]>>): FieldEnforcement[] {
  return TRADING_MANDATE_FIELDS.map((field) => {
    const r = rows[field];
    if (!r) throw new Error(`enforcement of ${field} is not stated`);         // a field can never be left out of the report
    return { field, enforcedBy: r[0], signerField: r[1], note: r[2] };
  });
}

function common(m: TradingMandate, venue: string, kind: 'spot' | 'perp'): void {
  const p = TradingMandateSchema.safeParse(m);
  if (!p.success) fail('invalid_mandate', `${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim());
  if (m.mode !== 'live') fail('paper_mandate_has_no_signer_form', 'a paper mandate is never sent to the signer: nothing is signed in paper mode', 'mode');
  if (!Object.hasOwn(SIGNER_MANDATE_SHAPES, venue)) fail('no_signer_mandate_for_venue', `the signer has no mandate for the venue ${venue}: orders there need an approval per order`, 'venues');
  if (!m.venues.includes(venue)) fail('venue_not_in_mandate', `${venue} is not a venue of the mandate`, 'venues');
  if (!m.marketKinds.includes(kind)) fail('market_kind_not_expressible', `the signer mandate of ${venue} covers ${kind} only, which the mandate does not allow`, 'marketKinds');
}
const intIn = (value: number, min: number, max: number, field: keyof TradingMandate, what: string): number => {
  if (!Number.isInteger(value) || value < min || value > max) fail('value_not_expressible', `${what} = ${value} is outside what the signer accepts (${min}…${max})`, field);
  return value;
};

/**
 * Trading mandate → derivative mandate `SPW-VENUE-MANDATE-v1` (Hyperliquid). The binding is what only the venue authorization
 * knows: its id, key, account and trading key, and the acknowledgement that was displayed. The result must still pass
 * `validateVenueMandate(result.mandate, authorization, now)` in the signer.
 */
export function compileToVenueMandate(m: TradingMandate, binding: { authorization: VenueAuthorization; ackSha256: string }): CompiledMandate<VenueMandate> {
  const venue = 'hyperliquid', a = binding.authorization;
  common(m, venue, 'perp');
  if (a.venue !== venue) fail('binding_mismatch', 'the authorization is for another venue', 'venues');
  const accounts = m.accounts.filter((x) => x.kind === 'venue_account' && x.venue === venue);
  if (accounts.length === 0) fail('account_not_in_mandate', `the mandate names no account on ${venue}`, 'accounts');
  if (accounts.length > 1) fail('ambiguous_account', `a derivative mandate covers one account; the mandate names ${accounts.length} on ${venue}`, 'accounts');
  const account = accounts[0]!;
  if (account.kind !== 'venue_account' || account.account.toLowerCase() !== a.account || account.network !== a.network) fail('binding_mismatch', 'the mandate\'s account is not the authorization\'s account and network', 'accounts');
  const instruments = m.instruments.filter((i) => venueOf(i) === venue);
  if (instruments.length === 0) fail('instrument_not_expressible', `the mandate lists no instrument on ${venue}`, 'instruments');
  if (instruments.length > VENUE_MANDATE_BOUNDS.maxInstruments) fail('instrument_not_expressible', `a derivative mandate lists at most ${VENUE_MANDATE_BOUNDS.maxInstruments} instruments`, 'instruments');
  for (const i of instruments) {
    if (!/^hyperliquid:[A-Za-z0-9]{1,15}$/.test(i)) fail('instrument_not_expressible', `${i} is not an instrument id the signer accepts`, 'instruments');
    if (!a.policy.allowedInstruments.includes(i)) fail('exceeds_authorization', `${i} is not allowed by the venue authorization`, 'instruments');
  }
  const lev = D.from(m.maxLeverage);
  if (!D.isMultiple(lev, D.one)) fail('value_not_expressible', `the venue takes integer leverage; ${m.maxLeverage} cannot be expressed`, 'maxLeverage');
  const maxLeverage = intIn(Number(D.str(lev)), 1, Math.min(VENUE_POLICY_BOUNDS.maxLeverage, a.policy.maxLeverage), 'maxLeverage', 'leverage');
  if (m.strategySha256 === null) fail('strategy_hash_required', 'the derivative mandate records the strategy the owner approved; this mandate names none', 'strategySha256');
  if (m.notAfter - m.createdAt > VENUE_MANDATE_MAX_DAYS * 86400) fail('duration_not_expressible', `a derivative mandate lasts at most ${VENUE_MANDATE_MAX_DAYS} days`, 'notAfter');
  if (m.notAfter > a.expiresAt) fail('exceeds_authorization', 'the mandate would outlive the venue authorization', 'notAfter');
  if (!D.isPos(D.from(m.floorEquityUsd))) fail('value_not_expressible', 'the signer needs a positive floor on the account value', 'floorEquityUsd');
  // capital × leverage bounds every exposure the capital can carry; the signer enforces the worst case against it
  const gross = D.mul(D.from(m.maxCapitalUsd), lev);
  const turnover = D.mul(D.from(m.maxOrderNotionalUsd), D.from(BigInt(m.frequency.perDay)));
  const cmp: [DecStr, DecStr, keyof TradingMandate, string][] = [[m.maxOrderNotionalUsd, a.policy.maxOrderNotional, 'maxOrderNotionalUsd', 'order limit'], [m.maxPositionNotionalUsd, a.policy.maxPositionNotional, 'maxPositionNotionalUsd', 'position limit'],
    [D.str(gross), a.policy.maxGrossExposure, 'maxCapitalUsd', 'capital × leverage (gross exposure)']];
  for (const [mine, theirs, field, what] of cmp) if (gt(mine, theirs)) fail('exceeds_authorization', `${what} ${canon(mine)} is above the venue authorization's ${canon(theirs)}`, field);
  if (m.frequency.perDay > a.policy.maxOrdersPerDay) fail('exceeds_authorization', `orders per day above the venue authorization's ${a.policy.maxOrdersPerDay}`, 'frequency');
  if (m.maxSlippageBps > a.policy.maxPriceDeviationBps) fail('exceeds_authorization', `price band wider than the venue authorization's ${a.policy.maxPriceDeviationBps} bps`, 'maxSlippageBps');

  const mandate = VenueMandateSchema.safeParse({
    v: 1, mandateId: m.mandateId, authorizationId: a.authorizationId, keyId: a.keyId, venue, network: a.network, account: a.account, agentAddress: a.agentAddress,
    strategySha256: m.strategySha256, agentId: m.principal.id,
    instruments: instruments.map((instrument) => ({ instrument, maxLeverage, maxPositionNotional: canon(m.maxPositionNotionalUsd) })),
    maxOrderNotional: canon(m.maxOrderNotionalUsd), maxGrossExposure: D.str(gross),
    maxOrdersPerDay: intIn(m.frequency.perDay, 1, VENUE_POLICY_BOUNDS.maxOrdersPerDay, 'frequency', 'orders per day'),
    maxOrdersPerHour: intIn(m.frequency.perHour, 1, VENUE_MANDATE_BOUNDS.maxOrdersPerHour, 'frequency', 'orders per hour'),
    maxDailyTurnover: D.str(turnover), floorEquity: canon(m.floorEquityUsd),
    maxPriceDeviationBps: intIn(m.maxSlippageBps, VENUE_POLICY_BOUNDS.minPriceBandBps, VENUE_POLICY_BOUNDS.maxPriceBandBps, 'maxSlippageBps', 'price band (bps)'),
    createdAt: m.createdAt, expiresAt: m.notAfter, ackSha256: binding.ackSha256,
  } satisfies VenueMandate);
  if (!mandate.success) return fail('value_not_expressible', `the derivative mandate is not valid: ${mandate.error.issues[0]?.path.join('.') ?? ''} ${mandate.error.issues[0]?.message ?? ''}`.trim());
  const others = m.venues.filter((v) => v !== venue), otherAccounts = m.accounts.length - 1;
  return {
    shape: 'SPW-VENUE-MANDATE-v1', mandate: mandate.data,
    derived: [
      { field: 'maxGrossExposure', value: D.str(gross), from: 'maxCapitalUsd × maxLeverage' },
      { field: 'maxDailyTurnover', value: D.str(turnover), from: 'maxOrderNotionalUsd × frequency.perDay' },
      { field: 'instruments[].maxLeverage', value: String(maxLeverage), from: 'maxLeverage (the same for every instrument)' },
      { field: 'maxPriceDeviationBps', value: String(m.maxSlippageBps), from: 'maxSlippageBps' },
    ],
    enforcement: enforcementTable({
      v: ['not_applicable', null, 'version of the trading mandate; the signer shape has its own'],
      mandateId: ['signer', 'mandateId', 'the derivative mandate carries the same id: one id for the pair'],
      principal: ['signer_partial', 'agentId', 'recorded by the signer for the audit trail; the signer cannot verify who calls it — the API binds the principal to the mandate'],
      accounts: ['signer', 'account, agentAddress, authorizationId', `the signer signs for this one venue account only${otherAccounts > 0 ? `; the mandate's ${otherAccounts} other account(s) are outside this shape` : ''}`],
      venues: ['signer', 'venue', `the shape is for hyperliquid only${others.length ? `; ${others.join(', ')} need their own signer mandate or stay API-enforced` : ''}`],
      networks: ['signer', 'network', 'the venue network of the authorization'],
      instruments: ['signer', 'instruments[].instrument', 'the signer refuses an order or a leverage change on any other instrument; a cancel is bounded by the instruments of the venue authorization, which may be wider'],
      marketKinds: ['signer', null, 'structural: this shape signs perpetual orders only'],
      orderTypes: ['api_only', null, 'the signer signs any order type the venue adapter can build; the allowed types are checked by the API'],
      maxCapitalUsd: ['signer_partial', 'maxGrossExposure', 'enforced as worst-case gross exposure ≤ capital × leverage; the capital itself (collateral on the venue) is not capped by the signer'],
      maxOrderNotionalUsd: ['signer', 'maxOrderNotional', 'size × highest named price of one order, reduce-only orders included'],
      maxPositionNotionalUsd: ['signer', 'instruments[].maxPositionNotional', 'worst case per instrument, from the signer\'s own read of the venue account and its own prices'],
      maxLeverage: ['signer', 'instruments[].maxLeverage', 'the signer refuses an order that can add exposure while the venue\'s leverage setting is higher, and never sets a higher one'],
      maxDailyLossUsd: ['api_only', null, 'the signer has no daily-loss limit; it only knows the floor'],
      floorEquityUsd: ['signer', 'floorEquity', 'below the floor the signer signs reduce-only orders and cancels only (the venue\'s own account value)'],
      createdAt: ['signer', 'createdAt', 'must be current at approval'],
      notBefore: [m.notBefore > m.createdAt ? 'api_only' : 'signer_partial', m.notBefore > m.createdAt ? null : 'createdAt', m.notBefore > m.createdAt ? 'the signer shape has no start time: it would sign from the approval on; the start is enforced by the API'
        : 'the signer has no start time: it signs from the approval on, and accepts an approval only while createdAt is within 10 minutes before and 2 minutes after its own clock; the start itself is checked by the API'],
      notAfter: ['signer', 'expiresAt', 'after it the signer signs only cancels and reduce-only orders for 24 h, then nothing'],
      frequency: ['signer_partial', 'maxOrdersPerDay, maxOrdersPerHour', 'per day and per hour are enforced by the signer (orders that can add exposure; the venue authorization\'s own daily count applies as well); per minute is enforced by the API only'],
      maxSlippageBps: ['signer_partial', 'maxPriceDeviationBps', 'the signer enforces a price band around its own mid on every price of an order — except a reduce-only trigger order, whose trigger may rest between one third and three times the mid, its worst price then being held within the band of the trigger; realised slippage is checked by the API'],
      maxFeeUsd: ['api_only', null, 'the signer does not see venue fees'],
      stopConditions: ['api_only', null, 'declarative conditions are evaluated by the API; the signer only stops on the floor, the expiry, a revocation and its own halt'],
      mode: ['not_applicable', null, 'the signer has no notion of paper or live: a mandate reaches it only when it is live (a paper mandate is never compiled); the venue network is the row `networks`'],
      strategySha256: ['signer_partial', 'strategySha256', 'recorded by the signer for the audit trail; the signer cannot verify what code runs'],
      label: ['api_only', null, 'a display name; not part of the signer shape'],
    }),
  };
}

/** what a spot compilation needs from the registry and the market, supplied by the caller */
export interface SpotMandateBinding {
  /** the owner key the vault belongs to */
  keyId: string;
  provider: 'kyberswap';
  /** every asset of the vault the mandate lets the agent hold: registry id, decimals and the USD price used to turn USD limits into base units */
  assets: readonly { id: string; decimals: number; priceUsd: DecStr; sellable: boolean }[];
  /** for each spot instrument of the mandate on this venue: the registry ids of its base and quote assets */
  instrumentAssets: Readonly<Record<string, readonly [base: string, quote: string]>>;
}

/**
 * Trading mandate → spot vault mandate `SPW-MANDATE-v1`. USD limits become base-unit limits at the prices of the binding
 * (rounded DOWN): they drift in USD terms as prices move, which the report states.
 */
export function compileToSpotMandate(m: TradingMandate, binding: SpotMandateBinding): CompiledMandate<Mandate> {
  const venue = binding.provider;
  common(m, venue, 'spot');
  const vaults = m.accounts.filter((x) => x.kind === 'vault');
  if (vaults.length === 0) fail('account_not_in_mandate', 'the mandate names no vault', 'accounts');
  if (vaults.length > 1) fail('ambiguous_account', `a spot mandate covers one vault; the mandate names ${vaults.length}`, 'accounts');
  const vault = vaults[0]!;
  if (vault.kind !== 'vault') return fail('account_not_in_mandate', 'the mandate names no vault', 'accounts');
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault.address)) fail('value_not_expressible', 'a spot mandate is for an EVM vault address', 'accounts');
  const instruments = m.instruments.filter((i) => venueOf(i) === venue);
  if (instruments.length === 0) fail('instrument_not_expressible', `the mandate lists no instrument on ${venue}`, 'instruments');
  const ids = new Set<string>();
  for (const i of instruments) {
    const pair = Object.hasOwn(binding.instrumentAssets, i) ? binding.instrumentAssets[i] : undefined;
    if (!pair) fail('instrument_not_expressible', `the assets of ${i} are not known: the instrument cannot be turned into vault assets`, 'instruments');
    else { ids.add(pair[0]); ids.add(pair[1]); }
  }
  const assets = [...ids].sort(cmpStr);
  const byId = new Map(binding.assets.map((x) => [x.id, x]));
  const maxOrder: Record<string, string> = {}, maxDaily: Record<string, string> = {};
  for (const id of assets) {
    const d = byId.get(id);
    if (!d) return fail('missing_price', `no decimals and price were supplied for the asset ${id}`, 'instruments');
    if (!d.sellable) continue;
    const price = D.from(d.priceUsd);
    if (!D.isPos(price) || !Number.isInteger(d.decimals) || d.decimals < 0 || d.decimals > 36) return fail('missing_price', `bad price or decimals for the asset ${id}`, 'instruments');
    const scale = D.from(10n ** BigInt(d.decimals));
    const perOrder = D.div(D.mul(D.from(m.maxOrderNotionalUsd), scale), price, 0, 'down');
    if (!D.isPos(perOrder)) return fail('value_not_expressible', `the order limit is below one base unit of ${id}`, 'maxOrderNotionalUsd');
    maxOrder[id] = D.str(perOrder); maxDaily[id] = D.str(D.mul(perOrder, D.from(BigInt(m.frequency.perDay))));
  }
  if (m.strategySha256 === null) fail('strategy_hash_required', 'the spot mandate records the strategy the owner approved; this mandate names none', 'strategySha256');
  if (!D.eq(D.from(m.maxLeverage), D.one) && !m.marketKinds.includes('perp')) fail('value_not_expressible', 'a spot mandate has no leverage', 'maxLeverage');
  const mandate = MandateSchema.safeParse({
    v: 1, mandateId: m.mandateId, keyId: binding.keyId, vaultIndex: vault.vaultIndex, vault: vault.address, network: vault.network, provider: binding.provider, assets, maxOrder, maxDaily,
    maxOrdersPerDay: intIn(m.frequency.perDay, 1, 500, 'frequency', 'orders per day'), maxSlippageBps: intIn(m.maxSlippageBps, 10, 500, 'maxSlippageBps', 'slippage (bps)'),
    createdAt: m.createdAt, expiresAt: m.notAfter, strategySha256: m.strategySha256, label: m.label,
  } satisfies Mandate);
  if (!mandate.success) return fail('value_not_expressible', `the spot mandate is not valid: ${mandate.error.issues[0]?.path.join('.') ?? ''} ${mandate.error.issues[0]?.message ?? ''}`.trim());
  const others = m.venues.filter((v) => v !== venue), otherAccounts = m.accounts.length - 1;
  return {
    shape: 'SPW-MANDATE-v1', mandate: mandate.data,
    derived: [
      ...Object.keys(maxOrder).map((id) => ({ field: `maxOrder.${id}`, value: maxOrder[id]!, from: `maxOrderNotionalUsd ÷ ${byId.get(id)!.priceUsd} USD, in base units, rounded down` })),
      ...Object.keys(maxDaily).map((id) => ({ field: `maxDaily.${id}`, value: maxDaily[id]!, from: 'maxOrder × frequency.perDay' })),
      { field: 'assets', value: assets.join(','), from: 'base and quote assets of the mandate\'s instruments on this venue' },
    ],
    enforcement: enforcementTable({
      v: ['not_applicable', null, 'version of the trading mandate; the signer shape has its own'],
      mandateId: ['signer', 'mandateId', 'the spot mandate carries the same id'],
      principal: ['api_only', null, 'the spot mandate does not name the principal: the signer only knows the vault key; the API binds the principal to the mandate'],
      accounts: ['signer', 'vaultIndex, vault, network', `orders spend from and deliver to this vault only${otherAccounts > 0 ? `; the mandate's ${otherAccounts} other account(s) are outside this shape` : ''}`],
      venues: ['signer', 'provider', `swaps through ${venue} only${others.length ? `; ${others.join(', ')} need their own signer mandate or stay API-enforced` : ''}`],
      networks: ['signer', 'network', 'one network per spot mandate: the vault\'s'],
      instruments: ['signer_partial', 'assets, maxOrder', 'the signer enforces the SET of assets (both legs of every swap) and which can be sold; it does not know instruments, so any pair between mandated assets passes'],
      marketKinds: ['signer', null, 'structural: this shape signs spot swaps only'],
      orderTypes: ['signer_partial', null, 'structural: the signer signs an immediate swap with a minimum output — a market order with a slippage bound; resting or trigger orders do not exist here and are handled (or refused) by the API'],
      maxCapitalUsd: ['api_only', null, 'the vault is bounded only by what the owner sends to it; the capital limit is checked by the API'],
      maxOrderNotionalUsd: ['signer_partial', 'maxOrder', 'enforced per sold asset in base units fixed at approval prices: the USD value drifts with the market'],
      maxPositionNotionalUsd: ['api_only', null, 'the signer has no position limit for a vault'],
      maxLeverage: ['not_applicable', null, 'spot swaps carry no leverage'],
      maxDailyLossUsd: ['api_only', null, 'the signer has no loss limit for a vault'],
      floorEquityUsd: ['api_only', null, 'the signer has no loss limit for a vault'],
      createdAt: ['signer', 'createdAt', 'must be current at approval'],
      notBefore: [m.notBefore > m.createdAt ? 'api_only' : 'signer_partial', m.notBefore > m.createdAt ? null : 'createdAt', m.notBefore > m.createdAt ? 'the signer shape has no start time; the start is enforced by the API'
        : 'the signer has no start time: it signs from the approval on, and accepts an approval only while createdAt is within 10 minutes before and 2 minutes after its own clock; the start itself is checked by the API'],
      notAfter: ['signer', 'expiresAt', 'the signer refuses any order after it'],
      frequency: ['signer_partial', 'maxOrdersPerDay, maxDaily', 'orders per day and a daily volume per sold asset are enforced by the signer; per hour and per minute by the API only'],
      maxSlippageBps: ['signer', 'maxSlippageBps', 'the guaranteed output must be worth at least (1 − this) of the input at the signer\'s own prices'],
      maxFeeUsd: ['api_only', null, 'the signer applies the fee ceiling of its own policy, not the mandate\'s'],
      stopConditions: ['api_only', null, 'declarative conditions are evaluated by the API; the signer only stops on the expiry, a revocation and its own halt'],
      mode: ['not_applicable', null, 'the signer has no notion of paper or live: a mandate reaches it only when it is live (a paper mandate is never compiled)'],
      strategySha256: ['signer_partial', 'strategySha256', 'recorded by the signer for the audit trail; the signer cannot verify what code runs'],
      label: ['signer_partial', 'label', 'part of the hash the passkey approved and recorded by the signer; a name has nothing to enforce'],
    }),
  };
}

export interface CompiledTradingMandate { spot: CompiledMandate<Mandate>[]; venue: CompiledMandate<VenueMandate>[] }
/**
 * Compiles a LIVE trading mandate for every venue it names. Fails (typed) if any venue has no signer-side mandate — for example
 * GMX — or if a binding is missing: a live mandate is never accepted with a venue the signer does not bound.
 */
export function compileTradingMandate(m: TradingMandate, bindings: { hyperliquid?: { authorization: VenueAuthorization; ackSha256: string }; kyberswap?: SpotMandateBinding }): CompiledTradingMandate {
  const out: CompiledTradingMandate = { spot: [], venue: [] };
  for (const v of [...m.venues].sort(cmpStr)) {
    const shape = Object.hasOwn(SIGNER_MANDATE_SHAPES, v) ? SIGNER_MANDATE_SHAPES[v] : undefined;
    if (shape === undefined) fail('no_signer_mandate_for_venue', `the signer has no mandate for the venue ${v}: orders there need an approval per order`, 'venues');
    if (v === 'hyperliquid') { if (!bindings.hyperliquid) fail('binding_mismatch', 'the venue authorization of hyperliquid is needed to compile the mandate', 'venues'); else out.venue.push(compileToVenueMandate(m, bindings.hyperliquid)); }
    if (v === 'kyberswap') { if (!bindings.kyberswap) fail('binding_mismatch', 'the vault binding of kyberswap is needed to compile the mandate', 'venues'); else out.spot.push(compileToSpotMandate(m, bindings.kyberswap)); }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ subset

export interface SubsetResult { ok: boolean; violations: { field: keyof TradingMandate; message: string }[] }

/**
 * Is the trading mandate inside the derivative mandate the signer holds? True when, on every limit the signer enforces, the
 * trading mandate allows no more than the signer does — so that an order the API accepts under the trading mandate is never
 * outside what the owner approved in the signer.
 */
export function isSubsetOfVenueMandate(m: TradingMandate, s: VenueMandate): SubsetResult {
  const v: SubsetResult['violations'] = [], add = (field: keyof TradingMandate, message: string) => v.push({ field, message });
  if (m.mode !== 'live') add('mode', 'a paper mandate has no signer form');
  const mine = m.instruments.filter((i) => venueOf(i) === s.venue), theirs = new Map(s.instruments.map((i) => [i.instrument, i]));
  if (!m.accounts.some((a) => a.kind === 'venue_account' && a.venue === s.venue && a.network === s.network && a.account.toLowerCase() === s.account)) add('accounts', 'the signer mandate\'s account is not an account of the trading mandate');
  for (const i of mine) {
    const t = theirs.get(i);
    if (!t) { add('instruments', `${i} is not in the signer mandate`); continue; }
    if (D.gt(D.from(m.maxLeverage), D.from(BigInt(t.maxLeverage)))) add('maxLeverage', `${i}: leverage ${m.maxLeverage} above the signer's ${t.maxLeverage}`);
    if (gt(m.maxPositionNotionalUsd, t.maxPositionNotional)) add('maxPositionNotionalUsd', `${i}: position limit above the signer's ${t.maxPositionNotional}`);
  }
  if (gt(m.maxOrderNotionalUsd, s.maxOrderNotional)) add('maxOrderNotionalUsd', `order limit above the signer's ${s.maxOrderNotional}`);
  if (gt(D.str(D.mul(D.from(m.maxCapitalUsd), D.from(m.maxLeverage))), s.maxGrossExposure)) add('maxCapitalUsd', `capital × leverage above the signer's gross exposure limit ${s.maxGrossExposure}`);
  if (m.frequency.perDay > s.maxOrdersPerDay) add('frequency', `orders per day above the signer's ${s.maxOrdersPerDay}`);
  if (m.frequency.perHour > s.maxOrdersPerHour) add('frequency', `orders per hour above the signer's ${s.maxOrdersPerHour}`);
  if (D.lt(D.from(m.floorEquityUsd), D.from(s.floorEquity))) add('floorEquityUsd', `floor below the signer's ${s.floorEquity}`);
  if (m.maxSlippageBps > s.maxPriceDeviationBps) add('maxSlippageBps', `price band wider than the signer's ${s.maxPriceDeviationBps} bps`);
  if (m.notAfter > s.expiresAt) add('notAfter', 'the trading mandate outlives the signer mandate');
  if (m.strategySha256 !== s.strategySha256) add('strategySha256', 'another strategy than the one recorded by the signer');
  return { ok: v.length === 0, violations: v };
}

/** same question for the spot vault mandate; `binding` gives the assets of the instruments and the prices to compare USD limits with base units */
export function isSubsetOfSpotMandate(m: TradingMandate, s: Mandate, binding: Pick<SpotMandateBinding, 'assets' | 'instrumentAssets'>): SubsetResult {
  const v: SubsetResult['violations'] = [], add = (field: keyof TradingMandate, message: string) => v.push({ field, message });
  if (m.mode !== 'live') add('mode', 'a paper mandate has no signer form');
  if (!m.accounts.some((a) => a.kind === 'vault' && a.vaultIndex === s.vaultIndex && a.network === s.network && a.address.toLowerCase() === s.vault.toLowerCase())) add('accounts', 'the signer mandate\'s vault is not an account of the trading mandate');
  const byId = new Map(binding.assets.map((x) => [x.id, x]));
  for (const i of m.instruments.filter((x) => venueOf(x) === s.provider)) {
    const pair = Object.hasOwn(binding.instrumentAssets, i) ? binding.instrumentAssets[i] : undefined;
    if (!pair) { add('instruments', `the assets of ${i} are not known`); continue; }
    for (const id of pair) if (!s.assets.includes(id)) add('instruments', `${i}: the asset ${id} is not in the signer mandate`);
  }
  for (const id of Object.keys(s.maxOrder)) {
    const d = byId.get(id);
    if (!d || !D.isPos(D.from(d.priceUsd))) { add('maxOrderNotionalUsd', `no price for ${id}: the order limit cannot be compared`); continue; }
    // the trading mandate's USD limit, in base units at this price, must not exceed the signer's per-order cap
    const mine = D.div(D.mul(D.from(m.maxOrderNotionalUsd), D.from(10n ** BigInt(d.decimals))), D.from(d.priceUsd), 0, 'down');
    if (D.gt(mine, D.from(s.maxOrder[id]!))) add('maxOrderNotionalUsd', `${id}: order limit above the signer's ${s.maxOrder[id]} base units at ${d.priceUsd} USD`);
  }
  if (m.frequency.perDay > s.maxOrdersPerDay) add('frequency', `orders per day above the signer's ${s.maxOrdersPerDay}`);
  if (m.maxSlippageBps > s.maxSlippageBps) add('maxSlippageBps', `slippage above the signer's ${s.maxSlippageBps} bps`);
  if (m.notAfter > s.expiresAt) add('notAfter', 'the trading mandate outlives the signer mandate');
  if (m.strategySha256 !== s.strategySha256) add('strategySha256', 'another strategy than the one recorded by the signer');
  return { ok: v.length === 0, violations: v };
}
/** dispatches on the signer shape */
export function isSubsetOf(m: TradingMandate, signerMandate: VenueMandate | Mandate, binding?: Pick<SpotMandateBinding, 'assets' | 'instrumentAssets'>): SubsetResult {
  if ('venue' in signerMandate) return isSubsetOfVenueMandate(m, signerMandate);
  if (!binding) return { ok: false, violations: [{ field: 'instruments', message: 'the asset binding is needed to compare with a spot mandate' }] };
  return isSubsetOfSpotMandate(m, signerMandate, binding);
}

// ------------------------------------------------------------------------------------------------------------------ rendering

/** the enforced-by table as Markdown, from the two compilers run on a reference mandate (embedded in docs/TRADING-MANDATES.md) */
export function renderEnforcementTable(venue: FieldEnforcement[], spot: FieldEnforcement[]): string {
  const label: Record<Enforcement, string> = { signer: 'signer', signer_partial: 'signer (partly)', api_only: 'API only', not_applicable: 'n/a' };
  const lines = ['| Trading mandate field | Derivative mandate `SPW-VENUE-MANDATE-v1` (Hyperliquid) | Spot mandate `SPW-MANDATE-v1` (KyberSwap vault) |', '|---|---|---|'];
  for (const f of TRADING_MANDATE_FIELDS) {
    const a = venue.find((x) => x.field === f)!, b = spot.find((x) => x.field === f)!;
    const cell = (x: FieldEnforcement) => `**${label[x.enforcedBy]}**${x.signerField ? ` — \`${x.signerField}\`` : ''}. ${x.note}`;
    lines.push(`| \`${f}\` | ${cell(a)} | ${cell(b)} |`);
  }
  return lines.join('\n');
}

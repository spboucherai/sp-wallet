/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/risk/limits.ts
 * Module           : risk
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

// Owner-set limits of the unified risk engine (V11) — the pure part: defaults per mode, the effective limit set, and "does this
// change allow more". No database here.
//
// LIVE: the defaults cover data quality, order rates and execution quality only. Every limit on CAPITAL (allow-lists, notional,
// position, leverage, exposure, concentration, losses, drawdown) is absent until the owner sets it — and the engine denies new
// risk on an absent limit. A live order that is not strictly reducing is therefore refused until the owner has chosen his limits.
// PAPER: the same engine with a complete, finite default set, so that a paper account works out of the box.
import { D } from '@spw/derivatives';
import { RiskLimitsSchema, type RiskLimits } from '@spw/trading';

export type RiskMode = 'paper' | 'live';

export const LIVE_DEFAULT_LIMITS: RiskLimits = {
  maxPriceAgeMs: { per: { coingecko: 900_000 }, default: 10_000 }, maxBookAgeMs: 10_000, minPriceSources: 2, maxSourceDeviationBps: '200',
  maxSlippageBps: '100', minLiquidity: { withinBps: '100', multiple: '2' }, minLiquidationDistanceBps: '1000',
  maxOrdersPerMinute: 6, maxOrdersPerHour: 60, maxOrdersPerDay: 200,
};
export const PAPER_DEFAULT_LIMITS: RiskLimits = {
  maxPriceAgeMs: { per: { coingecko: 900_000 }, default: 15_000 }, maxBookAgeMs: 15_000, minPriceSources: 1, maxSourceDeviationBps: '1000',
  maxSlippageBps: '500', minLiquidity: { withinBps: '500', multiple: '1' }, minLiquidationDistanceBps: '200',
  maxOrdersPerMinute: 60, maxOrdersPerHour: 1000, maxOrdersPerDay: 5000,
  maxOrderNotional: '10000000', maxDailyNotional: '100000000', maxPositionNotional: { per: {}, default: '20000000' }, maxOrderLeverage: '50', maxAccountLeverage: '50',
  maxGrossExposure: '100000000', maxNetExposure: '100000000', maxAssetExposure: { per: {}, default: '50000000' }, maxVenueExposure: { per: {}, default: '100000000' },
  maxVenueCollateralShareBps: '10000', maxDailyLoss: '1000000000', maxTotalLoss: '1000000000', maxDrawdownBps: '10000',
};
export const defaultLimits = (mode: RiskMode): RiskLimits => (mode === 'paper' ? PAPER_DEFAULT_LIMITS : LIVE_DEFAULT_LIMITS);

/**
 * What the engine is given: the defaults of the mode, overridden field by field by what the owner stored. In paper mode an
 * allow-list the owner did not set means "every venue / every instrument" (stated here, as the order's own venue and instrument);
 * in live mode it stays absent, which denies.
 */
export function effectiveLimits(mode: RiskMode, stored: RiskLimits, order: { venue: string; instrument: string } | null): RiskLimits {
  const out: RiskLimits = { ...defaultLimits(mode), ...stored };
  if (mode === 'paper' && order) {
    if (out.allowedVenues === undefined) out.allowedVenues = [order.venue];
    if (out.allowedInstruments === undefined) out.allowedInstruments = [order.instrument];
  }
  return RiskLimitsSchema.parse(out);
}

/** the limits on CAPITAL that have no default in live mode: each must come from the owner (or, for his own orders, from the seed below) */
export const LIVE_REQUIRED = ['allowedVenues', 'allowedInstruments', 'maxOrderNotional', 'maxDailyNotional', 'maxPositionNotional', 'maxOrderLeverage', 'maxAccountLeverage', 'maxGrossExposure', 'maxNetExposure',
  'maxAssetExposure', 'maxVenueExposure', 'maxVenueCollateralShareBps', 'maxDailyLoss', 'maxTotalLoss', 'maxDrawdownBps'] as const;

// ---------------------------------------------------------------------------------------------------------------- the V10 seed
// Before V11 the owner's limits lived on each venue account (`deriv_accounts.policy`, and the venue authorization the passkey
// approved). The unified engine denies new risk on an absent limit, so at the first start of V11 every manual live order would
// be refused until the owner filled the Risk screen. `seedFromV10` derives, ONCE, the part of the live limit set that those
// existing limits already express. Rules:
//  - only the OWNER's own orders see the seed (risk/service.ts `limitsFor`): an API key or an agent stays denied until the owner
//    stores a limit himself;
//  - never looser than what exists: a value is the MINIMUM over the authorized venue accounts (with one account, exactly its
//    policy); an allow-list is the union of what the accounts allow (each account's own list still binds its orders);
//  - never an invented value: a limit with no V10 equivalent — daily notional, net exposure, exposure per asset, exposure per
//    venue, collateral share, drawdown — is NOT seeded. It stays absent, the engine denies, and the Risk screen names it.
export interface V10Account { id: string; venue: string; network: string; policy: Record<string, unknown> | null; authorizationPolicy: { maxLeverage?: unknown } | null }
export interface LimitSeed { v: 1; limits: RiskLimits; /** `field` ← where it came from */ sources: { field: string; from: string; accounts: string[] }[]; /** required limits the seed could not supply */ notSeeded: string[] }
const decOf = (x: unknown): ReturnType<typeof D.from> | null => { try { return typeof x === 'string' && D.isValid(x) ? D.from(x) : typeof x === 'number' && Number.isFinite(x) ? D.from(String(x)) : null; } catch { return null; } };
export function seedFromV10(accounts: readonly V10Account[]): LimitSeed {
  const limits: RiskLimits = {}, sources: LimitSeed['sources'] = [], ids = accounts.map((a) => a.id);
  const minOf = (key: string, positive: boolean): string | null => {
    let m: ReturnType<typeof D.from> | null = null;
    for (const a of accounts) { const v = decOf(a.policy?.[key]); if (v === null || D.isNeg(v) || (positive && !D.isPos(v))) return null; m = m === null ? v : D.min(m, v); }   // one account without the value: nothing is seeded for it
    return m === null ? null : D.str(m);
  };
  const put = (field: string, from: string): void => { sources.push({ field, from, accounts: ids }); };
  if (accounts.length) {
    limits.allowedVenues = [...new Set(accounts.map((a) => a.venue))].sort(); put('allowedVenues', 'the venues of the authorized venue accounts');
    const inst = new Set<string>();
    for (const a of accounts) for (const i of Array.isArray(a.policy?.allowedInstruments) ? a.policy.allowedInstruments as unknown[] : []) if (typeof i === 'string' && i.length > 0) inst.add(i);
    if (inst.size) { limits.allowedInstruments = [...inst].sort(); put('allowedInstruments', 'policy.allowedInstruments (union)'); }
    const order = minOf('maxOrderNotional', false), position = minOf('maxPositionNotional', false), gross = minOf('maxGrossExposure', false), lev = minOf('maxLeverage', true), daily = minOf('maxDailyLoss', false), total = minOf('maxTotalLoss', false);
    if (order !== null) { limits.maxOrderNotional = order; put('maxOrderNotional', 'policy.maxOrderNotional (minimum)'); }
    if (position !== null) { limits.maxPositionNotional = { per: {}, default: position }; put('maxPositionNotional', 'policy.maxPositionNotional (minimum)'); }
    if (gross !== null) { limits.maxGrossExposure = gross; put('maxGrossExposure', 'policy.maxGrossExposure (minimum)'); }
    if (lev !== null) { limits.maxAccountLeverage = lev; put('maxAccountLeverage', 'policy.maxLeverage — gross exposure / equity (minimum)'); }
    if (daily !== null) { limits.maxDailyLoss = daily; put('maxDailyLoss', 'policy.maxDailyLoss (minimum)'); }
    if (total !== null) { limits.maxTotalLoss = total; put('maxTotalLoss', 'policy.maxTotalLoss (minimum)'); }
    // the leverage SETTING of an order: what the passkey approved in the venue authorization
    let setting: number | null = null;
    for (const a of accounts) { const v = a.authorizationPolicy?.maxLeverage; if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) { setting = null; break; } setting = setting === null ? v : Math.min(setting, v); }
    if (setting !== null) { limits.maxOrderLeverage = String(setting); put('maxOrderLeverage', 'venue authorization policy.maxLeverage (minimum)'); }
    // limits that HAVE a live default: taken only when the account policy is tighter than the default
    const perMin = minOf('maxOrdersPerMinute', false), perDay = minOf('maxOrdersPerDay', false), liq = (() => { let m: ReturnType<typeof D.from> | null = null; for (const a of accounts) { const v = decOf(a.policy?.minLiquidationDistanceBps); if (v === null) return null; m = m === null ? v : D.max(m, v); } return m; })();
    if (perMin !== null && D.lt(D.from(perMin), D.from(String(LIVE_DEFAULT_LIMITS.maxOrdersPerMinute!)))) { limits.maxOrdersPerMinute = Number(perMin); put('maxOrdersPerMinute', 'policy.maxOrdersPerMinute (tighter than the default)'); }
    if (perDay !== null && D.lt(D.from(perDay), D.from(String(LIVE_DEFAULT_LIMITS.maxOrdersPerDay!)))) { limits.maxOrdersPerDay = Number(perDay); put('maxOrdersPerDay', 'policy.maxOrdersPerDay (tighter than the default)'); }
    if (liq !== null && D.gt(liq, D.from(LIVE_DEFAULT_LIMITS.minLiquidationDistanceBps!))) { limits.minLiquidationDistanceBps = D.str(liq); put('minLiquidationDistanceBps', 'policy.minLiquidationDistanceBps (stricter than the default)'); }
  }
  const parsed = RiskLimitsSchema.parse(limits);
  return { v: 1, limits: parsed, sources, notSeeded: LIVE_REQUIRED.filter((k) => parsed[k] === undefined) };
}

type Keyed = { per: Record<string, string | number>; default?: string | number | undefined } | undefined;
const num = (x: string | number | undefined): ReturnType<typeof D.from> | null => (x === undefined ? null : D.from(String(x)));
/** `up`: a larger value allows more (a missing one allows nothing). `down`: a smaller value allows more (a missing one allows nothing). */
function looser(cur: string | number | undefined, next: string | number | undefined, dir: 'up' | 'down'): boolean {
  const a = num(cur), b = num(next);
  if (b === null) return false;                 // removing a limit makes it missing: the engine then denies
  if (a === null) return true;                  // from "denied" to a value
  return dir === 'up' ? D.gt(b, a) : D.lt(b, a);
}
function keyedLooser(cur: Keyed, next: Keyed, dir: 'up' | 'down'): boolean {
  if (next === undefined) return false;
  const keys = new Set([...Object.keys(cur?.per ?? {}), ...Object.keys(next.per)]);
  const at = (k: Keyed, key: string) => (k === undefined ? undefined : Object.hasOwn(k.per, key) ? k.per[key] : k.default);
  for (const k of keys) if (looser(at(cur, k), at(next, k), dir)) return true;
  return looser(cur?.default, next.default, dir);
}
const UP = ['maxOrderLeverage', 'maxAccountLeverage', 'maxDailyLoss', 'maxTotalLoss', 'maxDrawdownBps', 'maxGrossExposure', 'maxNetExposure', 'maxVenueCollateralShareBps', 'maxSlippageBps', 'maxBookAgeMs',
  'maxSourceDeviationBps', 'maxOrdersPerMinute', 'maxOrdersPerHour', 'maxOrdersPerDay', 'maxOrderNotional', 'maxDailyNotional'] as const;
const DOWN = ['minLiquidationDistanceBps', 'minPriceSources'] as const;
const KEYED_UP = ['maxPositionNotional', 'maxAssetExposure', 'maxVenueExposure', 'maxPriceAgeMs'] as const;
const LISTS = ['allowedVenues', 'allowedInstruments'] as const;
const stable = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v ?? null) : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`);

/**
 * Which fields of `next` allow more than `cur` (both are the STORED sets; they are compared as the engine will see them, that
 * is, over the defaults of the mode). A field this function does not know and that changed counts as loosened (fail closed).
 */
export function loosenedLimits(mode: RiskMode, cur: RiskLimits, next: RiskLimits): string[] {
  const a: RiskLimits = { ...defaultLimits(mode), ...cur }, b: RiskLimits = { ...defaultLimits(mode), ...next }, out: string[] = [];
  for (const k of LISTS) {
    const x = a[k], y = b[k];
    // paper: an absent list is "everything"; live: an absent list is "nothing"
    if (y === undefined) { if (mode === 'paper' && x !== undefined) out.push(k); continue; }
    if (x === undefined) { if (mode === 'live' && y.length > 0) out.push(k); continue; }
    if (y.some((v) => !x.includes(v))) out.push(k);
  }
  for (const k of UP) if (looser(a[k], b[k], 'up')) out.push(k);
  for (const k of DOWN) if (looser(a[k], b[k], 'down')) out.push(k);
  for (const k of KEYED_UP) if (keyedLooser(a[k] as Keyed, b[k] as Keyed, 'up')) out.push(k);
  const la = a.minLiquidity, lb = b.minLiquidity;
  if (lb !== undefined && (la === undefined || D.gt(D.from(lb.withinBps), D.from(la.withinBps)) || D.lt(D.from(lb.multiple), D.from(la.multiple)))) out.push('minLiquidity');
  const known = new Set<string>([...LISTS, ...UP, ...DOWN, ...KEYED_UP, 'minLiquidity']);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!known.has(k) && stable((a as Record<string, unknown>)[k]) !== stable((b as Record<string, unknown>)[k])) out.push(k);
  return out;
}

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

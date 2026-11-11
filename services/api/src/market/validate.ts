// Validation and normalisation of raw bars, and gap counting. Pure functions: no clock, no network, no database.
import { INTERVAL_MS, isClosed, type Candle, type Interval } from './types.ts';

export type RejectReason = 'not_finite' | 'non_positive_price' | 'negative_volume' | 'high_below_low' | 'open_out_of_range' | 'close_out_of_range'
  | 'off_grid' | 'duplicate' | 'future' | 'not_closed';
export interface Rejected { ts: number; reason: RejectReason }

function reasonFor(c: Candle, interval: Interval, now: number): RejectReason | null {
  const iv = INTERVAL_MS[interval];
  if (![c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) return 'not_finite';
  if (!Number.isInteger(c.ts) || c.ts % iv !== 0) return 'off_grid';
  if (c.ts > now) return 'future';
  if (!isClosed(c.ts, interval, now)) return 'not_closed';
  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return 'non_positive_price';
  if (c.volume < 0) return 'negative_volume';
  if (c.high < c.low) return 'high_below_low';
  if (c.open < c.low || c.open > c.high) return 'open_out_of_range';
  if (c.close < c.low || c.close > c.high) return 'close_out_of_range';
  return null;
}

/** Keeps the possible bars. A timestamp that appears more than once is rejected entirely (every copy): there is no way
 *  to know which copy is right. */
export function validateBars(raw: Candle[], interval: Interval, now: number): { bars: Candle[]; rejected: Rejected[] } {
  const rejected: Rejected[] = [], seen = new Map<number, number>();
  for (const c of raw) seen.set(c.ts, (seen.get(c.ts) ?? 0) + 1);
  const bars: Candle[] = [];
  for (const c of raw) {
    const reason = reasonFor(c, interval, now) ?? ((seen.get(c.ts) ?? 0) > 1 ? 'duplicate' : null);
    if (reason) rejected.push({ ts: c.ts, reason });
    else bars.push(c);
  }
  return { bars, rejected };
}

/** Canonical form stored and served: oldest first, exactly the six fields, bar-open time in UTC milliseconds. */
export const normalise = (bars: Candle[]): Candle[] => bars.map((c) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })).sort((x, y) => x.ts - y.ts);

export interface GapRange { from: number; to: number; missing: number }
/** Missing grid slots between consecutive timestamps (sorted, oldest first). `from`/`to` are the first and last missing bar-open times. */
export function findGaps(ts: number[], interval: Interval): { gaps: number; ranges: GapRange[] } {
  const iv = INTERVAL_MS[interval], ranges: GapRange[] = [];
  let gaps = 0;
  for (let i = 1; i < ts.length; i++) {
    const missing = Math.round((ts[i]! - ts[i - 1]!) / iv) - 1;
    if (missing > 0) { gaps += missing; ranges.push({ from: ts[i - 1]! + iv, to: ts[i]! - iv, missing }); }
  }
  return { gaps, ranges };
}

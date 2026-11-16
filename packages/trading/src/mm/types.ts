// Market-making core — shared types. Pure and deterministic: no I/O, no clock (time is an argument), no randomness.
// Prices, sizes and money are decimal strings (`DecStr`) and are computed exactly; the two places where a `number` appears
// are statistical estimates that feed a decision but are never a price or a size themselves: a volatility (vol.ts) and the
// transcendental part of the Avellaneda–Stoikov half spread (policy.ts). Both are converted to a fixed number of decimals
// before they touch a price. Design: docs/V11-MARKET-MAKING.md.
import type { DecStr } from '@spw/derivatives';

export type Side = 'buy' | 'sell';
/** a quote the policy wants on the book; `level` 0 is the closest to the mid */
export interface DesiredQuote { side: Side; price: DecStr; size: DecStr; level: number }
/** rounding onto the venue's grid — injected, so that this package knows no venue. It must round a bid DOWN, an ask UP and a size DOWN, and refuse what falls under the venue's minimum */
export type QuoteRounder = (side: Side, price: DecStr, size: DecStr) => { ok: true; price: DecStr; size: DecStr } | { ok: false; reason: string };

/** top of the book and what the engine knows about its freshness */
export interface BookTop { bid: DecStr; bidSize: DecStr; ask: DecStr; askSize: DecStr; /** venue time of the snapshot (unix ms) */ ts: number }

export interface PolicyInput {
  nowMs: number;
  book: BookTop;
  /** signed position in base units: positive long */
  inventory: DecStr;
  /** volatility of the mid per policy interval, in basis points (vol.ts); null until enough observations exist */
  volBps: number | null;
}
export interface PolicyOutput { quotes: DesiredQuote[]; /** why, in numbers — journaled with the decision */ diagnostics: Record<string, string | number | null>; notes: string[] }
/**
 * A quoting rule. ONE interface for paper and live: the paper rule of the agents runtime (`spread_inventory`,
 * services/api/src/agent-runtime/families.ts `mmQuotes`) is to implement this interface at the integration step — it is not
 * copied here, so that there is one rule and not two (docs/v11/work/mm-core.md).
 */
export interface QuotePolicy { readonly id: string; readonly version: string; quotes(input: PolicyInput): PolicyOutput }

/** an order of ours as the engine currently believes it to be */
export interface RestingOrder {
  clientId: string; side: Side; price: DecStr; /** remaining size */ size: DecStr;
  /** `resting`: the venue confirmed it. `pending`: sent or being sent, not confirmed. `cancelling`: a cancel was sent, not confirmed. `unknown`: the outcome of its batch is not known */
  state: 'resting' | 'pending' | 'cancelling' | 'unknown';
  placedAt: number;
}

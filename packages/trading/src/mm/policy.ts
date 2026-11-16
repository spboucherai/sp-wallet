// Quoting policies. One implementation here — Avellaneda–Stoikov with inventory skew — with the parameters and the formulas of
// the lab's model study (research/studies/market_making_as, `spq.studies.as_quotes`):
//
//   in basis points from the mid, inventory q in LOTS, sigma = volatility of the mid per interval (bps), tau = horizon in intervals
//     reservation price   r = mid − q · gamma · sigma² · tau
//     half spread         d = gamma · sigma² · tau / 2 + ln(1 + gamma / kappa) / gamma
//     quotes              bid = r − d, ask = r + d, post-only: never inside the book (a bid at most the best bid, an ask at least the best ask)
//
// On top of the study, two things a live quote needs: a FLOOR on the distance from the mid (the signer refuses anything closer
// than the mandate's minimum to ITS mid, which is not the venue's — the floor leaves room for that difference), and a ceiling.
// The lab's result with these parameters is NEGATIVE modelled PnL on 68 minutes of books (docs/V11-MARKET-MAKING.md §10).
//
// Numbers and decimals. Two quantities are floating-point by nature: the volatility estimate and the logarithm. They are
// computed once (`risk`, `base` below), rounded to 6 decimals of a basis point, and from there on everything — the skew by the
// inventory, the clamps, the prices, the sizes — is exact decimal arithmetic.
import { D, type Dec, type DecStr } from '@spw/derivatives';
import type { DesiredQuote, PolicyInput, PolicyOutput, QuotePolicy } from './types.ts';

const BPS = D.from(10000n);
/** a finite number → an exact decimal with `decimals` decimals (half away from zero): where an estimate enters the decimal world */
export function numToDec(x: number, decimals = 6): Dec {
  if (!Number.isFinite(x) || !Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new RangeError('not a finite number');
  const scaled = Math.round(Math.abs(x) * 10 ** decimals);
  if (!Number.isSafeInteger(scaled)) throw new RangeError('number too large');
  const v = D.div(D.from(BigInt(scaled)), D.from(10n ** BigInt(decimals)), decimals, 'down');
  return x < 0 ? D.neg(v) : v;
}
/** mid × (1 + bps / 10000), exact */
export const shiftBps = (mid: DecStr, bps: DecStr): DecStr => D.str(D.div(D.mul(D.from(mid), D.add(BPS, D.from(bps))), BPS, 12, 'half_even'));
export const midOf = (b: { bid: DecStr; ask: DecStr }): DecStr => D.str(D.div(D.add(D.from(b.bid), D.from(b.ask)), D.from(2n), 12, 'half_even'));

export interface AvellanedaStoikovConfig {
  /** risk aversion per lot — the study's 0.1 */
  gamma: number;
  /** horizon in volatility intervals — the study's 12 (one minute at a 5 s cadence) */
  tauIntervals: number;
  /** decay of the fill intensity with the distance from the mid (per bps) — FITTED on recorded data, never guessed */
  kappa: number;
  /** quote size and inventory unit, in USD of notional — the study's 1 000; a live session uses the venue minimum and up */
  lotUsd: DecStr;
  /** at most this many lots of inventory on either side — the study's 5 */
  maxLots: number;
  /** never quote closer than this to the venue's mid, in bps (≥ the mandate's minHalfSpreadBps + the basis margin) */
  minHalfSpreadBps: DecStr;
  /** never quote further than this (≤ the mandate's maxDistanceBps − the basis margin) */
  maxHalfSpreadBps: DecStr;
  /** volatility used until the estimator has enough observations (bps per interval); null = do not quote until it has */
  fallbackVolBps: number | null;
}
export const AS_STUDY_DEFAULTS: Pick<AvellanedaStoikovConfig, 'gamma' | 'tauIntervals' | 'maxLots'> = { gamma: 0.1, tauIntervals: 12, maxLots: 5 };

export function avellanedaStoikov(cfg: AvellanedaStoikovConfig): QuotePolicy {
  for (const [k, v] of Object.entries({ gamma: cfg.gamma, tauIntervals: cfg.tauIntervals, kappa: cfg.kappa, maxLots: cfg.maxLots }))
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new RangeError(`${k} must be a positive number`);
  const lo = D.from(cfg.minHalfSpreadBps), hi = D.from(cfg.maxHalfSpreadBps);
  if (!D.isPos(lo) || !D.lt(lo, hi)) throw new RangeError('minHalfSpreadBps must be positive and below maxHalfSpreadBps');
  if (!D.isPos(D.from(cfg.lotUsd))) throw new RangeError('lotUsd must be positive');
  const clamp = (x: Dec): Dec => D.min(hi, D.max(lo, x)), maxLots = numToDec(cfg.maxLots);
  return {
    id: 'avellaneda_stoikov', version: '1',
    quotes(input: PolicyInput): PolicyOutput {
      const b = input.book, notes: string[] = [], mid = midOf(b), m = D.from(mid);
      const none = (why: string): PolicyOutput => ({ quotes: [], diagnostics: { mid }, notes: [why] });
      if (!D.isPos(D.from(b.bid)) || !D.gt(D.from(b.ask), D.from(b.bid))) return none('no two-sided, uncrossed book');
      const sigma = input.volBps ?? cfg.fallbackVolBps;
      if (sigma === null) return none('volatility not established yet');
      // the two floating-point quantities, each rounded once to 6 decimals of a basis point
      const risk = numToDec(cfg.gamma * sigma * sigma * cfg.tauIntervals);                    // gamma · sigma² · tau
      const raw = D.add(D.div(risk, D.from(2n), 6, 'half_even'), numToDec(Math.log(1 + cfg.gamma / cfg.kappa) / cfg.gamma));
      // from here on: exact
      const lot = D.div(D.from(cfg.lotUsd), m, 12, 'down');                                   // base units of one lot at the mid
      const q = D.div(D.from(input.inventory), lot, 6, 'half_even');                          // inventory in lots
      const skew = D.neg(D.mul(q, risk));                                                     // reservation price, in bps from the mid
      const half = clamp(raw);
      // distance of each quote from the MID: always inside [min, max], whatever the skew
      const bidBps = clamp(D.sub(half, skew)), askBps = clamp(D.add(half, skew));
      let bid = shiftBps(mid, D.str(D.neg(bidBps))), ask = shiftBps(mid, D.str(askBps));
      // post-only, never inside the book
      if (D.gt(D.from(bid), D.from(b.bid))) { bid = b.bid; notes.push('bid moved back to the best bid'); }
      if (D.lt(D.from(ask), D.from(b.ask))) { ask = b.ask; notes.push('ask moved back to the best ask'); }
      const size = D.str(lot), quotes: DesiredQuote[] = [];
      if (D.lt(q, maxLots)) quotes.push({ side: 'buy', price: bid, size, level: 0 }); else notes.push('inventory at its long limit: no bid');
      if (D.gt(q, D.neg(maxLots))) quotes.push({ side: 'sell', price: ask, size, level: 0 }); else notes.push('inventory at its short limit: no ask');
      return { quotes, notes, diagnostics: { mid, sigmaBps: D.str(numToDec(sigma, 4)), inventoryLots: D.str(q), reservationBps: D.str(skew), halfSpreadBps: D.str(half), rawHalfSpreadBps: D.str(raw), bidBps: D.str(bidBps), askBps: D.str(askBps) } };
    },
  };
}

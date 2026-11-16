// Deterministic decision rules of the stream-driven families, and the paper book they trade on. PURE: no database, no network,
// no clock other than the `now` it is given — the stream engine (live data) and the recorded-data replay (backtest) call the
// very same functions.
//
//   market making     `mmQuotes`       spread = max(minimum, k × recent volatility), skewed against the inventory; no quote on the
//                                      side that would take the inventory past its limit; never a quote that crosses the book
//                     `mmFills`        the paper fill model — conservative, on real books (below)
//   cross-exchange    `crossDecision`  @spw/trading `crossVenueDiscrepancy`: the gap between two venues net of the fees of four
//                                      legs, the exit slippage on both books and the funding over the horizon
//   funding arbitrage `fundingDecision` the two venues' funding rates per HOUR with each venue's real interval (Hyperliquid 1 h,
//                                      dYdX 1 h, GMX continuous as published, edgeX 4 h — whatever the instrument says), net of fees
//
// PAPER FILL MODEL of market making (documented because every figure it produces depends on it):
//   1. a quote placed at time t can be filled only by a book observed AFTER t + `minRestMs` (no fill on the book it was priced from);
//   2. a bid is filled only when the market TRADES THROUGH it: a later best ask strictly BELOW the bid price (a touch is not a
//      fill — at the touch our order is behind the queue, and we model no queue position); mirrored for an ask;
//   3. the fill price is OUR quote price (no price improvement), the size is at most the size resting at the opposite best
//      price that crossed (never more than what the book showed);
//   4. the maker fee of the venue's reviewed fee table is charged on every fill;
//   5. between two recorded books nothing is assumed: a move that crossed our price and came back between two snapshots is missed.
//   This under-counts fills in quiet markets and still ignores adverse selection inside a snapshot interval; it is a
//   simulation, labelled as such everywhere.
import { D, type Book, type DecStr, type Instrument, type Ticker } from '@spw/derivatives';
import { crossVenueDiscrepancy, type DiscrepancyResult, type FeeSchedule, type VenueCostInput } from '@spw/trading';

export interface MarketView {
  id: string; venue: string; symbol: string; instrument: Instrument;
  bid: number; bidSize: number; ask: number; askSize: number;
  mark: number | null; index: number | null; funding: DecStr | null; fundingIntervalSec: number;
  /** unix ms of the BOOK and of the TICKER as the source produced them */
  bookTs: number; tickerTs: number | null;
  book: Book | null; ticker: Ticker | null; fees: FeeSchedule | null;
}
export interface PaperPosition { size: number; avgPrice: number }
export interface Quote { id: string; side: 'buy' | 'sell'; price: number; size: number; ts: number; instrument: string }
export interface PaperBook {
  capital: number; realizedPnl: number; fees: number; funding: number; turnover: number;
  positions: Record<string, PaperPosition>;
  quotes: Quote[];
  /** the two-venue position of the cross-exchange / funding families */
  pair: { longInstrument: string; shortInstrument: string; sizeBase: number; openedAt: number; entryGapBps: number | null; tag: string } | null;
  /** last funding settlement applied, per instrument (unix ms) */
  fundedAt: Record<string, number>;
  mids: number[];
  seq: number;
}
export const newPaperBook = (capital: number): PaperBook => ({ capital, realizedPnl: 0, fees: 0, funding: 0, turnover: 0, positions: {}, quotes: [], pair: null, fundedAt: {}, mids: [], seq: 0 });
export const mid = (v: Pick<MarketView, 'bid' | 'ask'>): number => (v.bid + v.ask) / 2;

/** equity of the paper book at the given marks: capital + realised − fees + funding + unrealised */
export function paperEquity(b: PaperBook, marks: Record<string, number>): number {
  let u = 0;
  for (const [inst, p] of Object.entries(b.positions)) { const m = marks[inst]; if (m !== undefined && p.size !== 0) u += p.size * (m - p.avgPrice); }
  return b.capital + b.realizedPnl - b.fees + b.funding + u;
}
export const grossUsd = (b: PaperBook, marks: Record<string, number>): number => Object.entries(b.positions).reduce((s, [inst, p]) => s + Math.abs(p.size) * (marks[inst] ?? p.avgPrice), 0);

/** Apply one execution to the paper book (average-cost accounting). Returns the PnL it realised. */
export function applyFill(b: PaperBook, instrument: string, side: 'buy' | 'sell', size: number, price: number, feeRate: number): { realized: number; fee: number } {
  const p = b.positions[instrument] ?? { size: 0, avgPrice: 0 }, signed = side === 'buy' ? size : -size, fee = size * price * feeRate;
  let realized = 0;
  if (p.size === 0 || Math.sign(p.size) === Math.sign(signed)) { p.avgPrice = (Math.abs(p.size) * p.avgPrice + size * price) / (Math.abs(p.size) + size); p.size += signed; }
  else {
    const closing = Math.min(Math.abs(p.size), size);
    realized = closing * (price - p.avgPrice) * Math.sign(p.size);
    p.size += signed;
    if (Math.abs(p.size) < 1e-12) { p.size = 0; p.avgPrice = 0; } else if (Math.sign(p.size) === Math.sign(signed)) p.avgPrice = price;   // flipped: the remainder opens at this price
  }
  b.positions[instrument] = p; b.realizedPnl += realized; b.fees += fee; b.turnover += size * price;
  return { realized, fee };
}

/** Funding settlements of the paper positions: at each interval boundary of the instrument since the last one applied, the
 *  position pays `size × mark × rate` (longs pay a positive rate). Uses the venue's published rate and REAL interval. */
export function accrueFunding(b: PaperBook, views: MarketView[], now: number): { instrument: string; amount: number; at: number }[] {
  const out: { instrument: string; amount: number; at: number }[] = [];
  for (const v of views) {
    const p = b.positions[v.id], step = v.fundingIntervalSec * 1000;
    const boundary = Math.floor(now / step) * step, last = b.fundedAt[v.id];
    if (last === undefined) { b.fundedAt[v.id] = boundary; continue; }
    if (boundary <= last) continue;
    b.fundedAt[v.id] = boundary;                                              // ONE settlement per pass: a rate is never applied to intervals it was not published for
    if (!p || p.size === 0 || v.funding === null || v.mark === null) continue;
    const amount = -p.size * v.mark * Number(v.funding);
    b.funding += amount; out.push({ instrument: v.id, amount, at: boundary });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ market making

export interface MmConfig { quoteSizeUsd: number; minHalfSpreadBps: number; volMultiplier: number; skewBps: number; maxInventoryUsd: number; volWindow: number; requoteBps?: number; minRestMs?: number }
export interface MmQuotes { bid: { price: number; size: number } | null; ask: { price: number; size: number } | null; mid: number; volBps: number; halfSpreadBps: number; skewBps: number; inventoryUsd: number; notes: string[] }
/** standard deviation of the log returns of the recent mids, in basis points per observation */
export function volBps(mids: number[]): number {
  if (mids.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < mids.length; i++) if (mids[i - 1]! > 0 && mids[i]! > 0) r.push(Math.log(mids[i]! / mids[i - 1]!));
  if (r.length < 2) return 0;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * 1e4;
}
const toTick = (price: number, tick: number, dir: 'down' | 'up'): number => { const n = price / tick; return Number(((dir === 'down' ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9)) * tick).toPrecision(12)); };
const toLot = (size: number, lot: number): number => Number((Math.floor(size / lot + 1e-9) * lot).toPrecision(12));

export function mmQuotes(cfg: MmConfig, v: Pick<MarketView, 'bid' | 'ask' | 'instrument'>, mids: number[], inventoryBase: number): MmQuotes {
  const m = mid(v), vol = volBps(mids.slice(-cfg.volWindow)), notes: string[] = [];
  const half = Math.max(cfg.minHalfSpreadBps, cfg.volMultiplier * vol);
  const invUsd = inventoryBase * m, q = cfg.maxInventoryUsd > 0 ? Math.max(-1, Math.min(1, invUsd / cfg.maxInventoryUsd)) : 0;
  const skew = -q * cfg.skewBps;                                               // long inventory → both quotes lower (sell sooner, buy later)
  const r = m * (1 + skew / 1e4), tick = Number(v.instrument.tickSize), lot = Number(v.instrument.lotSize);
  let bidPx = toTick(r * (1 - half / 1e4), tick, 'down'), askPx = toTick(r * (1 + half / 1e4), tick, 'up');
  // post-only: a quote never crosses the book it was priced from
  if (bidPx >= v.ask) { bidPx = toTick(v.bid, tick, 'down'); notes.push('bid moved back to the best bid (it would have crossed)'); }
  if (askPx <= v.bid) { askPx = toTick(v.ask, tick, 'up'); notes.push('ask moved back to the best ask (it would have crossed)'); }
  const size = toLot(cfg.quoteSizeUsd / m, lot), min = v.instrument.minNotional === null ? 0 : Number(v.instrument.minNotional);
  const ok = size > 0 && size * m >= min;
  if (!ok) notes.push('quote size below the venue\'s minimum');
  const bid = ok && q < 1 ? { price: bidPx, size } : null, ask = ok && q > -1 ? { price: askPx, size } : null;
  if (ok && q >= 1) notes.push('inventory at its long limit: no bid'); if (ok && q <= -1) notes.push('inventory at its short limit: no ask');
  return { bid, ask, mid: m, volBps: vol, halfSpreadBps: half, skewBps: skew, inventoryUsd: invUsd, notes };
}

/** Which resting quotes the book `v` (observed at `v.bookTs`) fills, by the paper fill model above. Pure: it changes nothing. */
export function mmFills(quotes: Quote[], v: Pick<MarketView, 'id' | 'bid' | 'bidSize' | 'ask' | 'askSize' | 'bookTs'>, minRestMs: number): { quote: Quote; size: number; price: number }[] {
  const out: { quote: Quote; size: number; price: number }[] = [];
  for (const q of quotes) {
    if (q.instrument !== v.id || v.bookTs < q.ts + minRestMs) continue;
    if (q.side === 'buy' && v.ask < q.price) { const size = Math.min(q.size, v.askSize); if (size > 0) out.push({ quote: q, size, price: q.price }); }
    if (q.side === 'sell' && v.bid > q.price) { const size = Math.min(q.size, v.bidSize); if (size > 0) out.push({ quote: q, size, price: q.price }); }
  }
  return out;
}
/** does a resting quote need to be replaced by the new target? (hysteresis: a requote is an order) */
export const needsRequote = (cur: Quote | undefined, target: { price: number; size: number } | null, requoteBps: number): boolean =>
  !cur ? target !== null : target === null || Math.abs(cur.price / target.price - 1) * 1e4 > requoteBps || Math.abs(cur.size - target.size) > 1e-12;

// ------------------------------------------------------------------------------------------------------------------ cross-exchange

export interface CrossConfig { notionalUsd: DecStr; horizonHours: DecStr; minNetEdgeBps: DecStr; exitGapBps: DecStr; maxDataAgeMs: number }
export const costInput = (v: MarketView): VenueCostInput => ({ instrument: v.instrument, book: v.book, ticker: v.ticker, fees: v.fees, funding: null, maintenanceMarginFraction: null });
export interface CrossDecision { action: 'open' | 'close' | 'hold'; best: DiscrepancyResult; other: DiscrepancyResult; reasonCode: 'acted' | 'edge_below_threshold' | 'data_not_fresh'; reason: string;
  legs: { instrument: string; side: 'buy' | 'sell'; size: number; price: number; reduceOnly: boolean }[] }
const px = (v: MarketView, side: 'buy' | 'sell'): number => (side === 'buy' ? v.ask : v.bid);

export function crossDecision(a: MarketView, b: MarketView, cfg: CrossConfig, pair: PaperBook['pair'], now: number): CrossDecision {
  const req = { notionalUsd: cfg.notionalUsd, leverage: '1', horizonHours: cfg.horizonHours, depthBps: '50', liquidity: 'taker' as const, now, maxAgeMs: cfg.maxDataAgeMs };
  const ab = crossVenueDiscrepancy(costInput(a), costInput(b), req, cfg.minNetEdgeBps), ba = crossVenueDiscrepancy(costInput(b), costInput(a), req, cfg.minNetEdgeBps);
  const val = (r: DiscrepancyResult): number => (r.netEdgeEstimateBps === null ? -Infinity : Number(r.netEdgeEstimateBps));
  const [best, other] = val(ab) >= val(ba) ? [ab, ba] : [ba, ab];
  const view = (inst: string): MarketView => (a.id === inst ? a : b);
  if (pair) {
    // held: long on pair.longInstrument, short on pair.shortInstrument. Close when the gap that paid for the entry is gone.
    const held = pair.longInstrument === a.id ? ab : ba;
    if (held.grossGapBps === null) return { action: 'hold', best, other, reasonCode: 'data_not_fresh', reason: `position kept: ${held.reason ?? 'the gap cannot be computed now'}`, legs: [] };
    // the closing trade is the opposite one: sell where we are long, buy where we are short — its gap is −(buy there, sell here)
    const closeGap = Number(held.grossGapBps);
    if (closeGap <= Number(cfg.exitGapBps)) {
      const L = view(pair.longInstrument), S = view(pair.shortInstrument);
      return { action: 'close', best, other, reasonCode: 'acted', reason: `the gap is ${held.grossGapBps} bps, at or below the exit level ${cfg.exitGapBps} bps: closing both legs`,
        legs: [{ instrument: L.id, side: 'sell', size: pair.sizeBase, price: px(L, 'sell'), reduceOnly: true }, { instrument: S.id, side: 'buy', size: pair.sizeBase, price: px(S, 'buy'), reduceOnly: true }] };
    }
    return { action: 'hold', best, other, reasonCode: 'edge_below_threshold', reason: `position kept: the gap is still ${held.grossGapBps} bps (exit at ${cfg.exitGapBps})`, legs: [] };
  }
  if (!best.flagged || best.netEdgeEstimateBps === null) {
    return { action: 'hold', best, other, reasonCode: best.netEdgeEstimateBps === null ? 'data_not_fresh' : 'edge_below_threshold',
      reason: best.netEdgeEstimateBps === null ? (best.reason ?? 'the estimate cannot be computed') : `net edge ${best.netEdgeEstimateBps} bps (gross ${best.grossGapBps}) is not above ${cfg.minNetEdgeBps} bps`, legs: [] };
  }
  const L = view(best.longInstrument), S = view(best.shortInstrument);
  // the hedged size: the notional at the long venue's price, on both venues' lots
  const lot = Math.max(Number(L.instrument.lotSize), Number(S.instrument.lotSize));
  const size = toLot(Number(cfg.notionalUsd) / L.ask, lot);
  if (!(size > 0)) return { action: 'hold', best, other, reasonCode: 'edge_below_threshold', reason: 'the hedged size is zero at these lots', legs: [] };
  return { action: 'open', best, other, reasonCode: 'acted', reason: `net edge ${best.netEdgeEstimateBps} bps after costs (gross ${best.grossGapBps}): buy ${L.venue}, sell ${S.venue}`,
    legs: [{ instrument: L.id, side: 'buy', size, price: px(L, 'buy'), reduceOnly: false }, { instrument: S.id, side: 'sell', size, price: px(S, 'sell'), reduceOnly: false }] };
}

// ------------------------------------------------------------------------------------------------------------------ funding arbitrage

export interface FundingConfig { notionalUsd: DecStr; horizonHours: DecStr; minNetCarryBps: DecStr; exitNetCarryBps: DecStr }
export interface FundingLeg { id: string; venue: string; rate: DecStr | null; intervalSec: number; hourlyBps: number | null; takerRate: number | null }
export interface FundingDecision { action: 'open' | 'close' | 'hold'; reasonCode: 'acted' | 'edge_below_threshold' | 'data_not_fresh'; reason: string;
  a: FundingLeg; b: FundingLeg; shortVenue: string | null; longVenue: string | null;
  /** (rate received on the short − rate paid on the long) per hour, bps of notional; the horizon's gross carry; the four legs' fees; the net */
  diffBpsPerHour: number | null; grossCarryBps: number | null; feesBps: number | null; netCarryBps: number | null;
  legs: CrossDecision['legs'] }
/** a venue's funding rate per HOUR, in basis points: rate per interval ÷ the interval's length in hours */
export const hourlyBps = (rate: DecStr | null, intervalSec: number): number | null => (rate === null || !(intervalSec > 0) ? null : D.toNumber(D.div(D.mul(D.from(rate), D.from(36_000_000n)), D.from(BigInt(intervalSec)), 12, 'half_even')));

export function fundingDecision(a: MarketView, b: MarketView, cfg: FundingConfig, pair: PaperBook['pair']): FundingDecision {
  const leg = (v: MarketView): FundingLeg => ({ id: v.id, venue: v.venue, rate: v.funding, intervalSec: v.fundingIntervalSec, hourlyBps: hourlyBps(v.funding, v.fundingIntervalSec), takerRate: v.fees ? Number(v.fees.takerRate) : null });
  const A = leg(a), B = leg(b), horizon = Number(cfg.horizonHours);
  const base = { a: A, b: B, shortVenue: null, longVenue: null, diffBpsPerHour: null, grossCarryBps: null, feesBps: null, netCarryBps: null, legs: [] as CrossDecision['legs'] };
  if (A.hourlyBps === null || B.hourlyBps === null) return { ...base, action: 'hold', reasonCode: 'data_not_fresh', reason: `no funding rate published for ${A.hourlyBps === null ? a.id : b.id}` };
  if (A.takerRate === null || B.takerRate === null) return { ...base, action: 'hold', reasonCode: 'data_not_fresh', reason: `no reviewed fee schedule for ${A.takerRate === null ? a.venue : b.venue}: the cost of the four legs cannot be computed` };
  // longs PAY a positive rate: be short where it is highest (receive it), long where it is lowest
  const [S, L] = A.hourlyBps >= B.hourlyBps ? [a, b] : [b, a], sLeg = S === a ? A : B, lLeg = L === a ? A : B;
  const diff = sLeg.hourlyBps! - lLeg.hourlyBps!, gross = diff * horizon, fees = 2 * (A.takerRate + B.takerRate) * 1e4, net = gross - fees;
  const figures = { shortVenue: S.venue, longVenue: L.venue, diffBpsPerHour: diff, grossCarryBps: gross, feesBps: fees, netCarryBps: net };
  if (pair) {
    // the carry of the position that is HELD (it may have changed sign since the entry)
    const heldShort = pair.shortInstrument === a.id ? A : B, heldLong = pair.longInstrument === a.id ? A : B, heldGross = (heldShort.hourlyBps! - heldLong.hourlyBps!) * horizon;
    if (heldGross < Number(cfg.exitNetCarryBps)) {
      const Lv = pair.longInstrument === a.id ? a : b, Sv = pair.shortInstrument === a.id ? a : b;
      return { ...base, ...figures, action: 'close', reasonCode: 'acted', reason: `the carry of the held position is ${heldGross.toFixed(2)} bps over ${horizon} h, below the exit level ${cfg.exitNetCarryBps}: closing both legs`,
        legs: [{ instrument: Lv.id, side: 'sell', size: pair.sizeBase, price: px(Lv, 'sell'), reduceOnly: true }, { instrument: Sv.id, side: 'buy', size: pair.sizeBase, price: px(Sv, 'buy'), reduceOnly: true }] };
    }
    return { ...base, ...figures, action: 'hold', reasonCode: 'edge_below_threshold', reason: `position kept: carry ${heldGross.toFixed(2)} bps over ${horizon} h` };
  }
  if (net < Number(cfg.minNetCarryBps)) return { ...base, ...figures, action: 'hold', reasonCode: 'edge_below_threshold', reason: `net carry ${net.toFixed(2)} bps over ${horizon} h (gross ${gross.toFixed(2)}, fees ${fees.toFixed(2)}) is below ${cfg.minNetCarryBps} bps` };
  const lot = Math.max(Number(L.instrument.lotSize), Number(S.instrument.lotSize)), size = toLot(Number(cfg.notionalUsd) / L.ask, lot);
  if (!(size > 0)) return { ...base, ...figures, action: 'hold', reasonCode: 'edge_below_threshold', reason: 'the hedged size is zero at these lots' };
  return { ...base, ...figures, action: 'open', reasonCode: 'acted', reason: `net carry ${net.toFixed(2)} bps over ${horizon} h: short ${S.venue} (${sLeg.hourlyBps!.toFixed(4)} bps/h), long ${L.venue} (${lLeg.hourlyBps!.toFixed(4)} bps/h)`,
    legs: [{ instrument: L.id, side: 'buy', size, price: px(L, 'buy'), reduceOnly: false }, { instrument: S.id, side: 'sell', size, price: px(S, 'sell'), reduceOnly: false }] };
}

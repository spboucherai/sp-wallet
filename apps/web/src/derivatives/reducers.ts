/**
 * Pure reducers of the terminal's market state: order book (accept / clean / group), trades (merge), candles (aggregate / tick).
 * Book and trade values stay decimal strings (sums through `D`); candle maths for the chart uses numbers.
 */
import { D, dec, type Dec } from './dec';
import type { Book, Candle, PublicTrade } from './types';

type Level = [string, string];

/** keeps positive, well-formed levels, sorted best first, duplicates of a price summed */
function cleanSide(levels: readonly Level[] | undefined, desc: boolean): Level[] {
  const byPrice = new Map<string, { p: Dec; s: Dec }>();
  for (const l of levels ?? []) {
    const p = dec(l?.[0]), s = dec(l?.[1]);
    if (!p || !s || !D.isPos(p) || !D.isPos(s)) continue;
    const k = D.str(p), cur = byPrice.get(k);
    byPrice.set(k, { p, s: cur ? D.add(cur.s, s) : s });
  }
  return [...byPrice.values()].sort((a, b) => (desc ? D.cmp(b.p, a.p) : D.cmp(a.p, b.p))).map((x) => [D.str(x.p), D.str(x.s)]);
}

/**
 * Next book state from a stream / poll snapshot. The stream sends whole books: an update for another instrument or older than
 * the one on screen is ignored (out-of-order delivery after a reconnection); a crossed book loses the levels that cross.
 */
export function mergeBook(prev: Book | null, next: Book | null | undefined, instrument: string): Book | null {
  if (!next || next.instrument !== instrument || !Number.isFinite(next.ts)) return prev;
  if (prev && prev.instrument === instrument && next.ts < prev.ts) return prev;
  let bids = cleanSide(next.bids, true), asks = cleanSide(next.asks, false);
  while (bids.length && asks.length && D.cmp(D.from(bids[0]![0]), D.from(asks[0]![0])) >= 0) {
    // crossed: drop the smaller of the two touching levels (the stale one in practice)
    if (D.cmp(D.from(bids[0]![1]), D.from(asks[0]![1])) <= 0) bids = bids.slice(1); else asks = asks.slice(1);
  }
  return { instrument, bids, asks, ts: next.ts };
}

export interface BookRow { price: string; size: string; total: string; /** cumulative size / largest cumulative size on screen, 0–1, for the depth bar */ depth: number }
export interface BookView { bids: BookRow[]; asks: BookRow[]; spread: string | null; spreadBps: string | null; mid: string | null }

/**
 * Levels grouped by `step` (a multiple of the tick: bids round down, asks round up, so a group never looks better than its
 * levels), `rows` per side, with cumulative totals. The spread is always the raw best ask − best bid.
 */
export function groupBook(book: Book | null, step: string, rows: number): BookView {
  const empty: BookView = { bids: [], asks: [], spread: null, spreadBps: null, mid: null };
  const st = dec(step);
  if (!book || !st || !D.isPos(st)) return empty;
  const side = (levels: Level[], mode: 'down' | 'up'): { price: string; size: Dec; total: Dec }[] => {
    const out: { price: string; size: Dec; total: Dec }[] = [];
    let total = D.zero;
    for (const [p, s] of levels) {
      const price = D.str(D.quantize(D.from(p), st, mode)), size = D.from(s);
      total = D.add(total, size);
      const last = out[out.length - 1];
      if (last && last.price === price) { last.size = D.add(last.size, size); last.total = total; }
      else if (out.length === rows) break;
      else out.push({ price, size, total });
    }
    return out;
  };
  const b = side(book.bids, 'down'), a = side(book.asks, 'up');
  const max = Math.max(b.length ? D.toNumber(b[b.length - 1]!.total) : 0, a.length ? D.toNumber(a[a.length - 1]!.total) : 0) || 1;
  const row = (x: { price: string; size: Dec; total: Dec }): BookRow => ({ price: x.price, size: D.str(x.size), total: D.str(x.total), depth: Math.min(1, D.toNumber(x.total) / max) });
  const bb = book.bids[0] ? D.from(book.bids[0][0]) : null, ba = book.asks[0] ? D.from(book.asks[0][0]) : null;
  let spread: string | null = null, spreadBps: string | null = null, mid: string | null = null;
  if (bb && ba) {
    const sp = D.sub(ba, bb), m = D.div(D.add(ba, bb), D.from(2n), 12, 'half_even');
    spread = D.str(sp); mid = D.str(m);
    if (D.isPos(m)) spreadBps = D.str(D.div(D.mul(sp, D.from(10000n)), m, 2, 'half_even'));
  }
  return { bids: b.map(row), asks: a.map(row), spread, spreadBps, mid };
}

/** newest first, one row per id, at most `cap` */
export function mergeTrades(prev: readonly PublicTrade[], incoming: readonly PublicTrade[], cap = 60): PublicTrade[] {
  if (!incoming.length) return prev as PublicTrade[];
  const seen = new Set<string>(), out: PublicTrade[] = [];
  for (const t of [...incoming, ...prev]) {
    if (!t || typeof t.id !== 'string' || seen.has(t.id) || !Number.isFinite(t.ts)) continue;
    seen.add(t.id); out.push(t);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.length > cap ? out.slice(0, cap) : out;
}

/** chart candle: numbers, display only */
export interface Bar { ts: number; o: number; h: number; l: number; c: number; v: number }
export const toBars = (cs: readonly Candle[]): Bar[] => cs.map((c) => ({ ts: c.ts, o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), v: Number(c.volume) }))
  .filter((b) => [b.ts, b.o, b.h, b.l, b.c].every(Number.isFinite)).sort((a, b) => a.ts - b.ts);

/** candles of a finer interval merged into buckets of `intervalMs` aligned on the epoch (oldest first) */
export function aggregateBars(bars: readonly Bar[], intervalMs: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const ts = Math.floor(b.ts / intervalMs) * intervalMs, last = out[out.length - 1];
    if (last && last.ts === ts) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

/**
 * A live price (and optionally a traded size) applied to the series: updates the current candle, or opens the next one at the
 * previous close. A tick older than the last candle is ignored. Returns the same array when nothing changes.
 */
export function applyTick(bars: Bar[], intervalMs: number, price: number, ts: number, size = 0, cap = 600): Bar[] {
  if (!Number.isFinite(price) || !Number.isFinite(ts) || price <= 0) return bars;
  const bucket = Math.floor(ts / intervalMs) * intervalMs, last = bars[bars.length - 1];
  if (!last) return [{ ts: bucket, o: price, h: price, l: price, c: price, v: size }];
  if (bucket < last.ts) return bars;
  if (bucket === last.ts) {
    if (last.c === price && size === 0) return bars;
    return [...bars.slice(0, -1), { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, v: last.v + size }];
  }
  const next = [...bars, { ts: bucket, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price, v: size }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** simple moving average of the closes; null until `n` candles are available */
export function sma(bars: readonly Bar[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.c;
    if (i >= n) sum -= bars[i - n]!.c;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

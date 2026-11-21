/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-data.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Market data for perp agents (V6): the VENUE's own closed bars and hourly funding settlements, stored in PostgreSQL, and the
// gate that decides whether a signal may be computed on them right now.
//
// - Source: the derivatives data service's venue registry (public read endpoints only — the read-only view has no trading
//   object). Nothing here signs, calls the signer or reaches a trading endpoint.
// - Storage: `perp_candles` / `perp_funding` (exact numerics). A series is fetched once (the lookback) and then extended by
//   the bars that closed since: an hourly signal costs one small candle request and one funding request per instrument and
//   hour, and nothing at all between two closes.
// - Rate budget: every request is accounted with the venue's documented weights against OUR share of the venue's limit
//   (`weightPerMinute`, default 500 of Hyperliquid's 1200 per minute; the rest is for the terminal and the paper worker). When
//   the share is spent the store refuses BEFORE sending (the engine holds, a backtest waits).
// - Gate (`gate`): fail closed. Latest closed bar present; no gap in the lookback; sane OHLC; a funding settlement for the
//   hours of the window (stated tolerance) and the one of the decision bar's open; nothing dated after the decision bar; a
//   closed bar the venue later serves with other values holds that pass; live mark within a band of the venue's spot index
//   (its oracle), or of the spot market data when the venue publishes no index; last close within a band of the live mark.
import { D, hlInfoExtraWeight, hlInfoWeight, VenueError, type DecStr, type Instrument, type Ticker, type VenueId } from '@spw/derivatives';
import { sql } from '../db.ts';
import type { DerivData } from '../derivatives/data.ts';
import type { ReadAdapter } from '../derivatives/venues.ts';

export const PERP_INTERVALS = ['1h', '4h'] as const;
export type PerpInterval = (typeof PERP_INTERVALS)[number];
export const PERP_STEP_MS: Record<PerpInterval, number> = { '1h': 3_600_000, '4h': 14_400_000 };
const HOUR = 3_600_000;
/** the venue keeps only its most recent 5000 candles of an interval */
export const VENUE_MAX_BARS = 5000;
const FUNDING_PAGE = 500;
/** a settlement instant further than this from the hour cannot be attributed to a settlement (the lab's rule) */
const FUNDING_TOLERANCE_MS = 60_000;

/** bands and tolerances of the gate — every one of them is a refusal to trade, never an adjustment */
export const GATE = {
  /** live mark vs the venue's spot index (oracle), basis points */
  markIndexBps: 100,
  /** live mark vs the last hourly close of the spot market data — used only when the venue publishes no index */
  markSpotBps: 300,
  /** last closed bar's close vs the live mark: the stored series is the live market's */
  lastCloseBps: 1000,
  /** the ticker must have been read at most this long ago */
  tickerMaxAgeMs: 15_000,
  /** funding settlements missing in the lookback: at most max(1, 0.5 % of its hours), never two hours in a row, never the decision bar's */
  fundingMissingFraction: 0.005, fundingMaxRun: 1,
} as const;

export interface PerpBar { ts: number; open: number; high: number; low: number; close: number; volume: number }
export interface FundingRow { ts: number; rate: number; premium: number | null }
export interface PerpSeries { bars: PerpBar[]; funding: FundingRow[]; /** exact close of the last bar */ lastClose: DecStr | null }

export class PerpDataError extends Error {
  readonly code: string; readonly retryAfterMs: number | null;
  constructor(code: string, message: string, retryAfterMs: number | null = null) { super(message); this.name = 'PerpDataError'; this.code = code; this.retryAfterMs = retryAfterMs; }
}

/** sliding one-minute window of request weight spent by this store */
export class WeightBudget {
  readonly limit: number;
  private readonly now: () => number;
  private spent: { at: number; w: number }[] = [];
  constructor(limit: number, now: () => number) { this.limit = limit; this.now = now; }
  used(): number { const cut = this.now() - 60_000; this.spent = this.spent.filter((s) => s.at > cut); return this.spent.reduce((n, s) => n + s.w, 0); }
  /** ms until `w` fits (0 = now) */
  waitMs(w: number): number {
    let used = this.used();
    if (used + w <= this.limit) return 0;
    for (const s of this.spent) { used -= s.w; if (used + w <= this.limit) return Math.max(1, s.at + 60_000 - this.now()); }
    return 60_000;
  }
  take(w: number, what: string): void {
    const wait = this.waitMs(w);
    if (wait > 0) throw new PerpDataError('rate_budget', `perp data budget spent (${this.used()}/${this.limit} weight per minute) before ${what}`, wait);
    this.spent.push({ at: this.now(), w });
  }
  charge(w: number): void { if (w > 0) this.spent.push({ at: this.now(), w }); }
}

const bps = (a: DecStr, ref: DecStr): number => {
  const r = D.from(ref);
  if (!D.isPos(r)) return Infinity;
  return D.toNumber(D.div(D.mul(D.abs(D.sub(D.from(a), r)), D.from(10000n)), r, 4, 'up')); // a comparison figure, not an amount
};

/** The checks of the gate that need no network. Throws PerpDataError; returns the decision bar (open time of the last closed bar). */
export function checkSeries(symbol: string, s: PerpSeries, o: { interval: PerpInterval; lookback: number; now: number }): number {
  const step = PERP_STEP_MS[o.interval], expected = Math.floor(o.now / step) * step - step;
  const bars = s.bars.slice(-o.lookback);
  if (bars.length < o.lookback) throw new PerpDataError('history', `${symbol}: ${bars.length} closed bars stored, the strategy needs ${o.lookback}`);
  const last = bars[bars.length - 1]!;
  if (last.ts > expected) throw new PerpDataError('unclosed', `${symbol}: a bar that is not closed yet is in the series`);
  if (last.ts < expected) throw new PerpDataError('stale', `${symbol}: the latest closed bar (${new Date(expected).toISOString()}) is missing; last stored ${new Date(last.ts).toISOString()}`);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i > 0 && b.ts - bars[i - 1]!.ts !== step) throw new PerpDataError('gap', `${symbol}: gap in the lookback after ${new Date(bars[i - 1]!.ts).toISOString()}`);
    if (![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) || !(b.low > 0) || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.volume < 0) {
      throw new PerpDataError('bad_bar', `${symbol}: impossible OHLCV values at ${new Date(b.ts).toISOString()}`);
    }
  }
  // funding: one settlement per hour of the window (first bar's open … decision bar's open), aligned on the hour
  const first = bars[0]!.ts, have = new Set<number>();
  for (const f of s.funding) {
    if (f.ts > last.ts) throw new PerpDataError('future_funding', `${symbol}: a funding settlement dated after the decision bar is in the input`);
    if (f.ts % HOUR !== 0 || !Number.isFinite(f.rate)) throw new PerpDataError('bad_funding', `${symbol}: funding row off the hour grid or not finite`);
    have.add(f.ts);
  }
  if (!have.has(last.ts)) throw new PerpDataError('funding_stale', `${symbol}: the funding settlement of ${new Date(last.ts).toISOString()} is not published yet`);
  let missing = 0, run = 0, longest = 0;
  for (let t = first; t <= last.ts; t += HOUR) { if (have.has(t)) run = 0; else { missing += 1; run += 1; longest = Math.max(longest, run); } }
  const hours = (last.ts - first) / HOUR + 1, allowed = Math.max(1, Math.floor(hours * GATE.fundingMissingFraction));
  if (missing > allowed || longest > GATE.fundingMaxRun) throw new PerpDataError('funding_gap', `${symbol}: ${missing} funding settlements missing in the lookback (longest run ${longest}; allowed ${allowed}, run ${GATE.fundingMaxRun})`);
  return last.ts;
}

/** The live cross-check of the gate. `spot` is the last close of the spot market data, when the caller has one. Throws PerpDataError. */
export function checkMark(symbol: string, ticker: Ticker, lastClose: DecStr | null, spot: DecStr | null, now: number): void {
  if (!Number.isFinite(ticker.ts) || Math.abs(now - ticker.ts) > GATE.tickerMaxAgeMs) throw new PerpDataError('stale_ticker', `${symbol}: the venue ticker is ${Math.round((now - ticker.ts) / 1000)} s old`);
  if (!D.isValid(ticker.mark) || !D.isPos(D.from(ticker.mark))) throw new PerpDataError('bad_mark', `${symbol}: mark price is not positive`);
  if (ticker.index !== null) {
    const d = bps(ticker.mark, ticker.index);
    if (!(d <= GATE.markIndexBps)) throw new PerpDataError('mark_index', `${symbol}: mark ${ticker.mark} is ${d.toFixed(1)} bps away from the venue's spot index ${ticker.index} (band ${GATE.markIndexBps} bps)`);
  } else {
    if (spot === null) throw new PerpDataError('no_reference', `${symbol}: the venue publishes no index and no spot market data is available to cross-check the mark`);
    const d = bps(ticker.mark, spot);
    if (!(d <= GATE.markSpotBps)) throw new PerpDataError('mark_spot', `${symbol}: mark ${ticker.mark} is ${d.toFixed(1)} bps away from the spot market ${spot} (band ${GATE.markSpotBps} bps)`);
  }
  if (lastClose !== null) {
    const d = bps(lastClose, ticker.mark);
    if (!(d <= GATE.lastCloseBps)) throw new PerpDataError('last_close', `${symbol}: the last closed bar (${lastClose}) is ${d.toFixed(0)} bps away from the live mark ${ticker.mark} (band ${GATE.lastCloseBps} bps)`);
  }
}

export interface PerpDataOptions {
  now?: () => number;
  /** our share of the venue's weight limit per minute */
  weightPerMinute?: number;
  /** last close of the spot market data for a base symbol (fallback reference when the venue publishes no index); null = none */
  spot?: (symbol: string) => Promise<DecStr | null>;
}

const same = (a: string, b: string): boolean => D.eq(D.from(a), D.from(b));
const key = (inst: Instrument, what: string): string => `${inst.id}:${what}`;

export class PerpDataStore {
  readonly data: DerivData;
  readonly now: () => number;
  readonly budget: WeightBudget;
  private readonly spot: NonNullable<PerpDataOptions['spot']>;
  /** a series whose window could not be completed is not asked again before this time (a venue gap, a settlement not published yet) */
  private readonly retryAt = new Map<string, number>();
  private metaChargedAt = 0;
  private readonly locks = new Map<string, Promise<void>>();
  /** requests sent to the venue since start (tests, diagnostics) */
  readonly stats = { candles: 0, funding: 0 };

  constructor(data: DerivData, o: PerpDataOptions = {}) {
    this.data = data; this.now = o.now ?? data.now;
    this.budget = new WeightBudget(o.weightPerMinute ?? Number(process.env.SPW_PERP_DATA_WEIGHT ?? 500), this.now);
    this.spot = o.spot ?? (async () => null);
  }

  private async call<T>(venue: VenueId, type: 'candleSnapshot' | 'fundingHistory', expectedItems: number, fn: (a: ReadAdapter) => Promise<T>): Promise<T> {
    // the adapter checks the symbol against the venue's asset table, which it re-reads at most once a minute (weight 20)
    const meta = this.now() - this.metaChargedAt >= 60_000 ? hlInfoWeight('meta') : 0;
    this.budget.take(hlInfoWeight(type) + hlInfoExtraWeight(type, expectedItems) + meta, `${type}`);
    if (meta) this.metaChargedAt = this.now();
    try { return await this.data.registry.call(venue, fn); }
    catch (e) {
      if (e instanceof VenueError && e.code === 'rate_limited') throw new PerpDataError('rate_budget', `venue rate limit: ${e.message.slice(0, 120)}`, 15_000);
      throw new PerpDataError('venue', `${venue}: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  /**
   * Bring the stored series of one instrument up to the last closed bar, for a window of `bars` bars. Sends nothing when the
   * window is already complete. Throws PerpDataError (`rate_budget` carries `retryAfterMs`; progress made is kept).
   */
  async sync(inst: Instrument, interval: PerpInterval, bars: number): Promise<void> {
    // one sync of a series at a time (an engine pass and a backtest may want the same instrument): the second waits, then finds it done
    const k = key(inst, interval), prev = this.locks.get(k) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const step = PERP_STEP_MS[interval], now = this.now(), last = Math.floor(now / step) * step - step;
      const n = Math.min(Math.max(1, bars), VENUE_MAX_BARS - 1), from = last - (n - 1) * step;
      await this.syncCandles(inst, interval, from, last, n);
      await this.syncFunding(inst, from, last);
    });
    this.locks.set(k, run);
    try { await run; } finally { if (this.locks.get(k) === run) this.locks.delete(k); }
  }

  private async syncCandles(inst: Instrument, interval: PerpInterval, from: number, last: number, n: number): Promise<void> {
    const step = PERP_STEP_MS[interval], now = this.now(), k = key(inst, `c:${interval}`);
    const [c] = await sql<{ n: number; hi: Date | null }[]>`select count(*)::int as n, max(ts) as hi from perp_candles where venue = ${inst.venue} and symbol = ${inst.symbol} and interval = ${interval} and ts >= ${new Date(from)} and ts <= ${new Date(last)}`;
    if (c!.n === n) return;                                                    // complete: nothing is asked
    if ((this.retryAt.get(k) ?? 0) > now) return;                             // asked a moment ago and still incomplete: the gate will say why
    // contiguous from the start of the window → only the tail is missing (one bar of overlap re-checks what is stored)
    const hi = c!.hi?.getTime() ?? null, contiguous = hi !== null && c!.n === (hi - from) / step + 1;
    const start = contiguous ? hi - step : from, want = Math.round((now - start) / step) + 1;
    const got = await this.call<{ ts: number; open: DecStr; high: DecStr; low: DecStr; close: DecStr; volume: DecStr }[]>(inst.venue, 'candleSnapshot', want,
      (a) => a.candles(inst.symbol, interval, { start, end: now, limit: Math.min(VENUE_MAX_BARS, want + 1) }));
    this.stats.candles += 1;
    const closed = got.filter((b) => b.ts % step === 0 && b.ts + step <= now && b.ts >= start);   // the bar in progress is never stored
    let revised = 0;
    if (closed.length) {
      const old = await sql<{ ts: Date; open: string; high: string; low: string; close: string; volume: string }[]>`select ts, open::text, high::text, low::text, close::text, volume::text from perp_candles
        where venue = ${inst.venue} and symbol = ${inst.symbol} and interval = ${interval} and ts >= ${new Date(closed[0]!.ts)} and ts <= ${new Date(closed[closed.length - 1]!.ts)}`;
      const byTs = new Map(old.map((r) => [r.ts.getTime(), r]));
      for (const b of closed) { const o = byTs.get(b.ts); if (o && !(same(o.open, b.open) && same(o.high, b.high) && same(o.low, b.low) && same(o.close, b.close) && same(o.volume, b.volume))) revised += 1; }
      for (let i = 0; i < closed.length; i += 1000) {
        const rows = closed.slice(i, i + 1000).map((b) => ({ venue: inst.venue, symbol: inst.symbol, interval, ts: new Date(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
        await sql`insert into perp_candles ${sql(rows)} on conflict (venue, symbol, interval, ts) do update set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`;
      }
    }
    const [after] = await sql<{ n: number }[]>`select count(*)::int as n from perp_candles where venue = ${inst.venue} and symbol = ${inst.symbol} and interval = ${interval} and ts >= ${new Date(from)} and ts <= ${new Date(last)}`;
    if (after!.n !== n) this.retryAt.set(k, now + (contiguous ? 30_000 : 10 * 60_000)); else this.retryAt.delete(k);
    // the venue's value is kept, but this pass must not trade on a series that just changed under it
    if (revised) throw new PerpDataError('revised', `${inst.symbol}: the venue now serves ${revised} closed ${interval} bar(s) with other values than the stored ones; stored values replaced, holding this pass`);
  }

  private async syncFunding(inst: Instrument, from: number, last: number): Promise<void> {
    const now = this.now(), k = key(inst, 'f'), hours = (last - from) / HOUR + 1;
    const stored = async (): Promise<{ n: number; hi: number | null; contiguous: boolean }> => {
      const [c] = await sql<{ n: number; hi: Date | null }[]>`select count(*)::int as n, max(ts) as hi from perp_funding where venue = ${inst.venue} and symbol = ${inst.symbol} and ts >= ${new Date(from)} and ts <= ${new Date(last)}`;
      const hi = c!.hi?.getTime() ?? null;
      return { n: c!.n, hi, contiguous: hi !== null && c!.n === (hi - from) / HOUR + 1 };
    };
    const before = await stored();
    if (before.n === hours) { this.retryAt.delete(k); return; }                // complete: nothing is asked
    if ((this.retryAt.get(k) ?? 0) > now) return;
    // contiguous from the start of the window → only the tail is asked; otherwise the whole window, page after page (500 rows each)
    let cursor = before.contiguous ? before.hi! + FUNDING_TOLERANCE_MS + 1 : from - FUNDING_TOLERANCE_MS;
    for (let page = 0; page < 40; page++) {
      const expect = Math.min(FUNDING_PAGE, Math.ceil((now - cursor) / HOUR) + 1);
      const start = cursor;
      const got = await this.call<{ ts: number; rate: DecStr; premium: DecStr | null }[]>(inst.venue, 'fundingHistory', expect, (a) => a.fundingHistory(inst.symbol, { start }));
      this.stats.funding += 1;
      const rows = new Map<number, { venue: string; symbol: string; ts: Date; time_ms: number; rate: string; premium: string | null }>();
      for (const f of got) {
        const hour = Math.round(f.ts / HOUR) * HOUR;
        if (Math.abs(f.ts - hour) > FUNDING_TOLERANCE_MS || hour > now) continue;        // off the hour grid: attributed to no settlement
        rows.set(hour, { venue: inst.venue, symbol: inst.symbol, ts: new Date(hour), time_ms: f.ts, rate: f.rate, premium: f.premium });
      }
      if (rows.size) await sql`insert into perp_funding ${sql([...rows.values()])} on conflict (venue, symbol, ts) do update set time_ms = excluded.time_ms, rate = excluded.rate, premium = excluded.premium`;
      const newest = got.length ? Math.max(...got.map((f) => f.ts)) : 0;
      if (got.length < FUNDING_PAGE || newest >= last || newest < cursor) break;
      cursor = newest + 1;                                                      // a full page that ends before the window does
    }
    const after = await stored();
    if (after.n === hours) { this.retryAt.delete(k); return; }
    // still incomplete: only the tail is missing (a settlement not published yet: asked again soon), or the venue never
    // recorded some settlement (kept as a gap — the gate counts it — and not re-read before ten minutes)
    this.retryAt.set(k, now + (after.contiguous ? 30_000 : 10 * 60_000));
  }

  /** stored closed bars (oldest first, at most `limit`) and the settlements of their hours — nothing after the last bar's open */
  async series(inst: Instrument, interval: PerpInterval, limit: number): Promise<PerpSeries> {
    const rows = await sql<{ ts: Date; open: string; high: string; low: string; close: string; volume: string }[]>`select ts, open::text, high::text, low::text, close::text, volume::text from perp_candles
      where venue = ${inst.venue} and symbol = ${inst.symbol} and interval = ${interval} order by ts desc limit ${limit}`;
    rows.reverse();
    const bars = rows.map((r) => ({ ts: r.ts.getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
    if (!bars.length) return { bars, funding: [], lastClose: null };
    const f = await sql<{ ts: Date; rate: string; premium: string | null }[]>`select ts, rate::text, premium::text from perp_funding where venue = ${inst.venue} and symbol = ${inst.symbol}
      and ts >= ${new Date(bars[0]!.ts)} and ts <= ${new Date(bars[bars.length - 1]!.ts)} order by ts`;
    return { bars, funding: f.map((r) => ({ ts: r.ts.getTime(), rate: Number(r.rate), premium: r.premium === null ? null : Number(r.premium) })), lastClose: D.str(D.from(rows[rows.length - 1]!.close)) };
  }

  /** exact stored rows, for the laboratory's backtest files */
  async exact(inst: Instrument, interval: PerpInterval, limit: number): Promise<{ candles: [number, string, string, string, string, string][]; funding: [number, string, string | null][] }> {
    const c = await sql<{ ts: Date; open: string; high: string; low: string; close: string; volume: string }[]>`select ts, open::text, high::text, low::text, close::text, volume::text from perp_candles
      where venue = ${inst.venue} and symbol = ${inst.symbol} and interval = ${interval} order by ts desc limit ${limit}`;
    c.reverse();
    if (!c.length) return { candles: [], funding: [] };
    const f = await sql<{ time_ms: string; rate: string; premium: string | null }[]>`select time_ms::text, rate::text, premium::text from perp_funding where venue = ${inst.venue} and symbol = ${inst.symbol} and ts >= ${c[0]!.ts} order by ts`;
    return { candles: c.map((r) => [r.ts.getTime(), r.open, r.high, r.low, r.close, r.volume]), funding: f.map((r) => [Number(r.time_ms), r.rate, r.premium]) };
  }

  /**
   * The gate of one instrument: sync, then every check. Returns the series the signal may use, or throws PerpDataError — the
   * engine then holds. `lookback` is the strategy's own (META['lookback']).
   */
  async gate(inst: Instrument, interval: PerpInterval, lookback: number): Promise<{ bar: number; series: PerpSeries; ticker: Ticker }> {
    if (inst.status !== 'active') throw new PerpDataError('instrument', `${inst.id} is ${inst.status} on the venue`);
    await this.sync(inst, interval, lookback);
    const series = await this.series(inst, interval, lookback), now = this.now();
    const bar = checkSeries(inst.symbol, series, { interval, lookback, now });
    let ticker: Ticker;
    try { ticker = await this.data.ticker(inst, { within: 5_000 }); } catch (e) { throw new PerpDataError('venue', `${inst.symbol}: no live ticker (${(e as Error).message.slice(0, 120)})`); }
    const spot = ticker.index === null ? await this.spot(inst.base).catch(() => null) : null;
    checkMark(inst.symbol, ticker, series.lastClose, spot, now);
    return { bar, series, ticker };
  }

  /** fill the store for a backtest (as much history as the venue serves), waiting for the budget instead of failing */
  async backfill(insts: Instrument[], interval: PerpInterval, bars: number, o: { deadlineMs: number; sleep?: (ms: number) => Promise<void> }): Promise<void> {
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = Date.now() + o.deadlineMs;
    for (const inst of insts) {
      for (;;) {
        try { await this.sync(inst, interval, bars); break; }
        catch (e) {
          if (e instanceof PerpDataError && e.code === 'revised') continue;     // stored values were replaced: read again
          if (!(e instanceof PerpDataError) || e.code !== 'rate_budget' || Date.now() > until) throw e;
          await sleep(Math.min(Math.max(1_000, e.retryAfterMs ?? 5_000), 20_000));
        }
      }
    }
  }
}

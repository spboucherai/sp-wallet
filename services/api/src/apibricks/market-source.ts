// API Bricks (CoinAPI) — an ADDITIONAL confirming source of the market module: OHLCV of one exchange the wallet does not read.
//
//   GET /v1/ohlcv/{symbol_id}/history?period_id=1DAY|1HRS|5MIN&time_start=&time_end=&limit=100
//   → [{ time_period_start, time_period_end, time_open, time_close, price_open, price_high, price_low, price_close,
//        volume_traded, trades_count }, …]   oldest first; a period without a trade is omitted (like Coinbase); the bar in
//        progress is included unmarked — it is dropped here like everywhere (closed bars only).
//   Cost: one credit per 100 bars returned (measured: a 24-bar page and a 5-bar page both cost 1) — one page = 100 bars = 1 credit.
//
// It is a MarketSource like Coinbase, Bitstamp and Kraken: the pipeline validates, normalises, stores and judges its bars with
// the same code. What is specific:
//   • INDEPENDENCE (venues.ts): only the exchange-specific symbols of MARKET_PAIRS — Gemini or Bitfinex — are ever asked
//     for, and `isIndependent` is checked again here on every symbol id;
//   • METERED: every page is paid from the daily budget (consumer `market`, with its own smaller ceiling); when the budget is
//     spent the source reports `ready() === false` and the pass skips it — visible in /stream/stats and on the monitor;
//   • BOUNDED: the intervals and symbols it serves are configuration (default: daily bars of the base set), and only the
//     last `historyBars` bars are ever fetched — a full history through a metered API is a deliberate, separate decision.
// Ranked LAST in the consolidation: an exchange read directly is always preferred; this source confirms, or fills a slot
// nobody else has. It cannot make a series pass alone (the gate needs two sources).
import { INTERVAL_MS, SourceError, isClosed, type Candle, type Interval, type MarketSource } from '../market/types.ts';
import { ApiBricksError, parseApiTime, type ApiBricksClient } from './client.ts';
import { MARKET_PAIRS } from './asset-map.ts';
import { isIndependent } from './venues.ts';

export const PERIOD_ID: Record<Interval, string> = { '5m': '5MIN', '1h': '1HRS', '1d': '1DAY' };
export const APIBRICKS_PAGE_BARS = 100;
export interface ApiBricksMarketOptions {
  client: ApiBricksClient; symbols: readonly string[]; intervals: readonly Interval[]; historyBars?: number;
  /** tests: another table than the generated one (every id is still checked against the independence rule) */ pairs?: Record<string, string>;
  spacingMs?: number; now?: () => number;
}

interface Row { time_period_start?: unknown; price_open?: unknown; price_high?: unknown; price_low?: unknown; price_close?: unknown; volume_traded?: unknown }
const isoSeconds = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

/** the provider's OHLCV rows → raw bars (not yet validated); throws `schema` when the answer is not a list of bars */
export function parseOhlcv(body: unknown): Candle[] {
  if (!Array.isArray(body)) throw new SourceError('apibricks', 'schema', 'unexpected answer (a list of bars expected)');
  return (body as Row[]).map((r, k) => {
    const ts = parseApiTime(r?.time_period_start), n = [r?.price_open, r?.price_high, r?.price_low, r?.price_close, r?.volume_traded];
    if (!Number.isFinite(ts) || !n.every((x) => typeof x === 'number')) throw new SourceError('apibricks', 'schema', `unexpected answer (bar ${k})`);
    return { ts, open: n[0] as number, high: n[1] as number, low: n[2] as number, close: n[3] as number, volume: n[4] as number };
  });
}

export function apiBricksMarketSource(o: ApiBricksMarketOptions): MarketSource {
  const table = o.pairs ?? MARKET_PAIRS, now = o.now ?? Date.now, spacing = o.spacingMs ?? 500;
  // the independence rule is enforced on the table itself: a pair of one of the wallet's own exchanges never gets in
  const pairs = Object.fromEntries(o.symbols.flatMap((s) => (Object.hasOwn(table, s) && isIndependent(table[s]!) ? [[s, table[s]!]] : [])));
  let next = 0;
  const wait = async (): Promise<void> => { const t = now(), at = Math.max(t, next); next = at + spacing; if (at > t) await new Promise((r) => setTimeout(r, at - t)); };
  return {
    id: 'apibricks', maxBars: APIBRICKS_PAGE_BARS, historyBars: o.historyBars ?? 300, pairs, intervals: o.intervals,
    penalize(ms) { next = Math.max(next, now() + ms); },
    ready: () => o.client.budget.has('market'),
    async candles(symbol, interval, range, at) {
      const id = pairs[symbol], iv = INTERVAL_MS[interval];
      if (!id || !isIndependent(id)) throw new SourceError('apibricks', 'unsupported', `${symbol}/USD has no independent series`);
      if (!o.intervals.includes(interval)) throw new SourceError('apibricks', 'unsupported', `${interval} is not served`);
      if (range.start % iv || range.end % iv || range.end < range.start || (range.end - range.start) / iv + 1 > APIBRICKS_PAGE_BARS)
        throw new SourceError('apibricks', 'unsupported', `bad range (at most ${APIBRICKS_PAGE_BARS} bars, on the ${interval} grid)`);
      await wait();
      let body: unknown;
      try {
        body = await o.client.get(`/v1/ohlcv/${id}/history?period_id=${PERIOD_ID[interval]}&time_start=${isoSeconds(range.start)}&time_end=${isoSeconds(range.end + iv)}&limit=${APIBRICKS_PAGE_BARS}`, { consumer: 'market', expectCredits: 1 });
      } catch (e) {
        if (e instanceof ApiBricksError) throw new SourceError('apibricks', e.kind === 'quota' || e.kind === 'rate_limited' ? 'rate_limited' : e.kind === 'schema' ? 'schema' : e.kind === 'not_found' ? 'unsupported' : 'http', e.message.replace(/^apibricks: /, ''));
        throw e;
      }
      return parseOhlcv(body).filter((c) => c.ts >= range.start && c.ts <= range.end && isClosed(c.ts, interval, at)).sort((a, b) => a.ts - b.ts);
    },
  };
}

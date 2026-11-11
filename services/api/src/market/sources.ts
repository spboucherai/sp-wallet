// Exchange adapters: public, keyless REST candles for spot pairs against USD. Facts below were checked live on 2026-11-10
// from a residential connection in Canada and against the official documentation of each exchange.
//
//  coinbase  GET api.exchange.coinbase.com/products/{pair}/candles?granularity=&start=&end=   rows [time s, low, high, open, close, volume]
//            newest first, at most 300 per call, start/end inclusive, full history pageable; intervals without a trade are OMITTED;
//            the still-open bar is included unmarked; Cloudflare caches an identical URL for 300 s; 10 req/s per IP (bursts 15), 429.
//  bitstamp  GET www.bitstamp.net/api/v2/ohlc/{pair}/?step=&limit=&end=   {data:{ohlc:[{timestamp,open,high,low,close,volume}]}} (strings),
//            oldest first, at most 1000 per call, `end` inclusive (when both start and end are given, start is ignored), full history;
//            intervals without a trade are present with volume 0; the open bar is included unless exclude_current_candle=true;
//            400 req/s and 10 000 per 10 minutes.
//  kraken    GET api.kraken.com/0/public/OHLC?pair=&interval=&since=   rows [time s, open, high, low, close, vwap, volume, count] (strings),
//            oldest first, ONLY the 720 most recent bars whatever `since` says; the last row is always the uncommitted bar and
//            `result.last` is the open time of the last committed one; errors come back as HTTP 200 {"error":[...]};
//            an unpaced loop was refused ("EGeneral:Too many requests") after 10 calls in 1.3 s, and at one call every 1.5 s the
//            connection stalled after about 20 calls: calls are spaced 3 s apart.
import { z } from 'zod';
import { http } from '../chains/rpc.ts';
import { INTERVAL_MS, SourceError, isClosed, type Candle, type HttpJson, type Interval, type MarketSource, type MarketSymbol, type SourceId } from './types.ts';

export const httpJson: HttpJson = async (url) => {
  const r = await http(url, { headers: { accept: 'application/json', 'user-agent': 'sp-wallet-market/1' } });
  let body: unknown = null;
  try { body = await r.json(); } catch { /* not JSON: the adapter reports the status */ }
  return { status: r.status, body };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Serialises the calls to one exchange and keeps them `ms` apart. */
function pacer(ms: number) {
  let next = 0;
  return {
    async wait(): Promise<void> { const now = Date.now(), at = Math.max(now, next); next = at + ms; if (at > now) await sleep(at - now); },
    penalize(p: number): void { next = Math.max(next, Date.now() + p); },
  };
}

export interface SourceOpts { get?: HttpJson; /** minimum delay between two calls; tests pass 0 */ spacingMs?: number }
interface Def {
  id: SourceId; maxBars: number; historyBars: number | null; spacingMs: number; pairs: Partial<Record<MarketSymbol, string>>;
  url(pair: string, interval: Interval, range: { start: number; end: number }, now: number): string;
  /** raw bars of the answer, in any order, the open bar possibly included */
  parse(status: number, body: unknown): Candle[];
}

function make(def: Def, opts: SourceOpts): MarketSource {
  const get = opts.get ?? httpJson, pace = pacer(opts.spacingMs ?? def.spacingMs);
  return {
    id: def.id, maxBars: def.maxBars, historyBars: def.historyBars, pairs: def.pairs, penalize: pace.penalize,
    async candles(symbol, interval, range, now) {
      const pair = def.pairs[symbol], iv = INTERVAL_MS[interval];
      if (!pair) throw new SourceError(def.id, 'unsupported', `${symbol}/USD is not listed`);
      if (range.start % iv || range.end % iv || range.end < range.start || (range.end - range.start) / iv + 1 > def.maxBars)
        throw new SourceError(def.id, 'unsupported', `bad range (at most ${def.maxBars} bars, on the ${interval} grid)`);
      await pace.wait();
      const { status, body } = await get(def.url(pair, interval, range, now));
      const rows = def.parse(status, body);
      return rows.filter((c) => c.ts >= range.start && c.ts <= range.end && isClosed(c.ts, interval, now)).sort((a, b) => a.ts - b.ts);
    },
  };
}

const schema = <T>(id: SourceId, s: z.ZodType<T>, body: unknown): T => {
  const r = s.safeParse(body);
  if (!r.success) throw new SourceError(id, 'schema', `unexpected answer (${r.error.issues[0]?.path.join('.') ?? ''}: ${r.error.issues[0]?.message ?? 'invalid'})`);
  return r.data;
};
const msgOf = (body: unknown) => JSON.stringify(body ?? null).slice(0, 160);
const all = (pair: (s: MarketSymbol) => string, syms: readonly MarketSymbol[]) => Object.fromEntries(syms.map((s) => [s, pair(s)])) as Partial<Record<MarketSymbol, string>>;
const LISTED: readonly MarketSymbol[] = ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE', 'AVAX', 'BNB', 'DOGE', 'LTC', 'XRP'];

const CoinbaseRows = z.array(z.tuple([z.number().int(), z.number(), z.number(), z.number(), z.number(), z.number()]));
export const coinbaseSource = (opts: SourceOpts = {}): MarketSource => make({
  // 298 bars per call rather than the 300 allowed: a window ending "now" spans up to two more intervals (measured: a span
  // of 300.04 intervals is accepted, 301.04 is refused with HTTP 400)
  id: 'coinbase', maxBars: 298, historyBars: null, spacingMs: 250, pairs: all((s) => `${s}-USD`, LISTED),
  url(pair, interval, { start, end }, now) {
    // A window that reaches the latest closed bar ends at the current second instead of the grid: the URL is then unique,
    // which keeps Cloudflare's 300 s cache from serving a copy taken before that bar was final (or before it existed).
    const to = end + 2 * INTERVAL_MS[interval] > now ? Math.floor(now / 1000) * 1000 : end;
    return `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${INTERVAL_MS[interval] / 1000}&start=${new Date(start).toISOString()}&end=${new Date(to).toISOString()}`;
  },
  parse(status, body) {
    if (status === 429) throw new SourceError('coinbase', 'rate_limited', 'too many requests');
    if (status !== 200) throw new SourceError('coinbase', 'http', `http ${status} ${msgOf(body)}`);
    return schema('coinbase', CoinbaseRows, body).map(([t, low, high, open, close, volume]) => ({ ts: t * 1000, open, high, low, close, volume }));
  },
}, opts);

const num = z.string().regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/).transform(Number);
const BitstampBody = z.object({ data: z.object({ ohlc: z.array(z.object({ timestamp: z.string().regex(/^\d+$/).transform(Number), open: num, high: num, low: num, close: num, volume: num })) }) });
export const bitstampSource = (opts: SourceOpts = {}): MarketSource => make({
  id: 'bitstamp', maxBars: 1000, historyBars: null, spacingMs: 250, pairs: all((s) => `${s.toLowerCase()}usd`, LISTED),
  url: (pair, interval, { start, end }) => `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${INTERVAL_MS[interval] / 1000}&limit=${(end - start) / INTERVAL_MS[interval] + 1}&end=${end / 1000}`,
  parse(status, body) {
    const code = String((body as { code?: unknown } | null)?.code ?? '');
    if (status === 429 || code === '400.002' || code === '400.067' || code === '400.068') throw new SourceError('bitstamp', 'rate_limited', 'too many requests');
    if (status !== 200) throw new SourceError('bitstamp', 'http', `http ${status} ${msgOf(body)}`);
    return schema('bitstamp', BitstampBody, body).data.ohlc.map((c) => ({ ts: c.timestamp * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  },
}, opts);

const KrakenBody = z.object({ error: z.array(z.string()), result: z.record(z.string(), z.unknown()).optional() });
const KrakenRows = z.array(z.tuple([z.number().int(), num, num, num, num, num, num, z.number()]));
const KRAKEN_PAIR: Partial<Record<MarketSymbol, string>> = { BTC: 'XBTUSD', DOGE: 'XDGUSD' };
export const krakenSource = (opts: SourceOpts = {}): MarketSource => make({
  id: 'kraken', maxBars: 720, historyBars: 720, spacingMs: 3000, pairs: all((s) => KRAKEN_PAIR[s] ?? `${s}USD`, LISTED),
  url: (pair, interval, { start }) => `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${INTERVAL_MS[interval] / 60_000}&since=${start / 1000 - 1}`,
  parse(status, body) {
    if (status === 429) throw new SourceError('kraken', 'rate_limited', 'too many requests');
    if (status !== 200) throw new SourceError('kraken', 'http', `http ${status} ${msgOf(body)}`);
    const b = schema('kraken', KrakenBody, body);
    if (b.error.length) throw new SourceError('kraken', /too many requests|rate limit|throttled/i.test(b.error.join(' ')) ? 'rate_limited' : 'http', b.error.join('; ').slice(0, 160));
    const keys = Object.keys(b.result ?? {}).filter((k) => k !== 'last');
    const last = schema('kraken', z.number().int(), b.result?.last);
    if (keys.length !== 1) throw new SourceError('kraken', 'schema', 'unexpected answer (one pair expected)');
    // `last` is the newest COMMITTED bar: anything after it is the bar still being built, whatever the local clock says
    return schema('kraken', KrakenRows, b.result![keys[0]!]).filter((r) => r[0] <= last).map(([t, open, high, low, close, , volume]) => ({ ts: t * 1000, open, high, low, close, volume }));
  },
}, opts);

/** Consolidation priority: the first source that has a bar provides it (see series.ts). */
export const defaultSources = (opts: SourceOpts = {}): MarketSource[] => [coinbaseSource(opts), bitstampSource(opts), krakenSource(opts)];

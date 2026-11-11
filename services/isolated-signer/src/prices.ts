// The signer's own view of market prices, used for delegated (agent) orders and for live venue orders (venue.ts). It asks two independent public
// exchanges itself, so a compromised API or engine cannot make it accept an order that sells an asset far below
// its market value. Any doubt — one source down, stale, or the two disagreeing — means no signature.
//
// Which pair to ask for comes from the reviewed static table of USD listings (packages/core/src/market-listings.ts):
// a symbol is priced only when BOTH Coinbase and Kraken list it. A symbol on one of them only, or absent, has no price
// here and every order involving it is refused. The caller passes MARKET symbols: a wrapped asset is priced as what it
// tracks (signer.ts, priceSymbolOf), so a wrapper that loses its peg fails the mandate's value check.
import { MARKET_LISTINGS } from '@spw/core';

export interface PriceView { /** USD price per whole unit of each symbol; throws when a trustworthy price cannot be established */ get(symbols: string[]): Promise<Record<string, number>> }
export type JsonGet = (url: string) => Promise<unknown>;

const TIMEOUT_MS = 6000, CACHE_MS = 15_000, MAX_SPREAD = 0.01, MAX_AGE_MS = 180_000;
const json: JsonGet = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'price-check' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > 20_000) throw new Error('response too large');
  return JSON.parse(t);
};
const pos = (v: unknown): number => { const n = typeof v === 'string' && /^\d{1,12}(\.\d{1,12})?$/.test(v) ? Number(v) : NaN; if (!(n > 0) || !Number.isFinite(n)) throw new Error('bad price'); return n; };

/** Coinbase Exchange: mid of best bid/ask, with the exchange's own timestamp checked for freshness. */
async function coinbase(get: JsonGet, pair: string, now: number): Promise<number> {
  const j = await get(`https://api.exchange.coinbase.com/products/${pair}/ticker`) as { ask?: unknown; bid?: unknown; time?: unknown };
  const ask = pos(j.ask), bid = pos(j.bid), at = Date.parse(String(j.time));
  if (!(at > 0) || Math.abs(now - at) > MAX_AGE_MS) throw new Error('stale quote');
  if (ask < bid || (ask - bid) / bid > 0.02) throw new Error('abnormal spread');
  return (ask + bid) / 2;
}
/** Kraken: mid of best bid/ask (the pair key in the answer varies, so one pair per request and a single result is required). */
async function kraken(get: JsonGet, pair: string): Promise<number> {
  const j = await get(`https://api.kraken.com/0/public/Ticker?pair=${pair}`) as { error?: unknown[]; result?: Record<string, { a?: unknown[]; b?: unknown[] }> };
  if (!Array.isArray(j.error) || j.error.length || !j.result) throw new Error('exchange error');
  const rows = Object.values(j.result);
  if (rows.length !== 1) throw new Error('unexpected answer');
  const ask = pos(rows[0]!.a?.[0]), bid = pos(rows[0]!.b?.[0]);
  if (ask < bid || (ask - bid) / bid > 0.02) throw new Error('abnormal spread');
  return (ask + bid) / 2;
}

/** Cash legs: the price is taken as one US dollar, after checking on the exchange(s) that the peg currently holds.
 *  USDC is checked on Kraken (Coinbase has no USDC/USD book); USDT on both, which must also agree. */
const DOLLAR: Record<string, readonly ('coinbase' | 'kraken')[]> = { USDC: ['kraken'], USDT: ['coinbase', 'kraken'] };
const PAIR = /^[A-Z0-9]{2,12}(-USD)?$/;
/** Symbols this view can price (both exchanges list them), for display and tests. */
export const pricedSymbols = (): string[] => Object.keys(MARKET_LISTINGS).filter((s) => Object.hasOwn(DOLLAR, s) || (MARKET_LISTINGS[s]!.coinbase && MARKET_LISTINGS[s]!.kraken));

export function exchangePrices(now: () => number = Date.now, get: JsonGet = json): PriceView {
  const cache = new Map<string, { at: number; p: number }>();
  const one = async (sym: string): Promise<number> => {
    const l = Object.hasOwn(MARKET_LISTINGS, sym) ? MARKET_LISTINGS[sym]! : null;
    if (!l) throw new Error(`no price source for ${sym}`);
    const c = cache.get(sym);
    if (c && now() - c.at < CACHE_MS) return c.p;
    const need = Object.hasOwn(DOLLAR, sym) ? DOLLAR[sym]! : (['coinbase', 'kraken'] as const);
    for (const s of need) if (!l[s] || !PAIR.test(l[s])) throw new Error(`no price source for ${sym}: it is not listed on ${s}`);
    const quotes = await Promise.all(need.map((s) => (s === 'coinbase' ? coinbase(get, l.coinbase!, now()) : kraken(get, l.kraken!)))); // every source must answer
    const lo = Math.min(...quotes), hi = Math.max(...quotes);
    if ((hi - lo) / lo > MAX_SPREAD) throw new Error(`price sources disagree on ${sym} (${quotes.join(' vs ')})`);
    let p = quotes.reduce((a, b) => a + b, 0) / quotes.length;
    if (Object.hasOwn(DOLLAR, sym)) { if (quotes.some((q) => Math.abs(q - 1) > 0.01)) throw new Error(`${sym} is off its peg (${quotes.join(', ')})`); p = 1; }
    cache.set(sym, { at: now(), p });
    return p;
  };
  return { async get(symbols) { const out: Record<string, number> = {}; for (const s of new Set(symbols)) out[s] = await one(s); return out; } };
}
/** For tests and for the owner-only CLI paths that never price anything. */
export const noPrices: PriceView = { get: async () => { throw new Error('no price view configured'); } };

// The signer's own view of market prices, used for delegated (agent) orders and for live venue orders (venue.ts). It asks two independent public
// exchanges itself, so a compromised API or engine cannot make it accept an order that sells an asset far below
// its market value. Any doubt — one source down, stale, or the two disagreeing — means no signature.
export interface PriceView { /** USD price per whole unit of each symbol; throws when a trustworthy price cannot be established */ get(symbols: string[]): Promise<Record<string, number>> }

const TIMEOUT_MS = 6000, CACHE_MS = 15_000, MAX_SPREAD = 0.01, MAX_AGE_MS = 180_000;
async function json(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'price-check' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > 20_000) throw new Error('response too large');
  return JSON.parse(t);
}
const pos = (v: unknown): number => { const n = typeof v === 'string' && /^\d{1,12}(\.\d{1,12})?$/.test(v) ? Number(v) : NaN; if (!(n > 0) || !Number.isFinite(n)) throw new Error('bad price'); return n; };

/** Coinbase Exchange: mid of best bid/ask, with the exchange's own timestamp checked for freshness. */
async function coinbase(sym: string, now: number): Promise<number> {
  const j = await json(`https://api.exchange.coinbase.com/products/${sym}-USD/ticker`) as { ask?: unknown; bid?: unknown; time?: unknown };
  const ask = pos(j.ask), bid = pos(j.bid), at = Date.parse(String(j.time));
  if (!(at > 0) || Math.abs(now - at) > MAX_AGE_MS) throw new Error('stale quote');
  if (ask < bid || (ask - bid) / bid > 0.02) throw new Error('abnormal spread');
  return (ask + bid) / 2;
}
/** Kraken: mid of best bid/ask (the pair key in the answer varies, so one pair per request and a single result is required). */
async function kraken(sym: string): Promise<number> {
  const j = await json(`https://api.kraken.com/0/public/Ticker?pair=${sym}USD`) as { error?: unknown[]; result?: Record<string, { a?: unknown[]; b?: unknown[] }> };
  if (!Array.isArray(j.error) || j.error.length || !j.result) throw new Error('exchange error');
  const rows = Object.values(j.result);
  if (rows.length !== 1) throw new Error('unexpected answer');
  const ask = pos(rows[0]!.a?.[0]), bid = pos(rows[0]!.b?.[0]);
  if (ask < bid || (ask - bid) / bid > 0.02) throw new Error('abnormal spread');
  return (ask + bid) / 2;
}

/** Symbols whose price is taken as one US dollar, after checking on an exchange that the peg currently holds. */
const DOLLAR = new Set(['USDC']);
const SUPPORTED = /^[A-Z]{2,6}$/;

export function exchangePrices(now: () => number = Date.now): PriceView {
  const cache = new Map<string, { at: number; p: number }>();
  const one = async (sym: string): Promise<number> => {
    if (!SUPPORTED.test(sym)) throw new Error(`no price source for ${sym}`);
    const c = cache.get(sym);
    if (c && now() - c.at < CACHE_MS) return c.p;
    let p: number;
    if (DOLLAR.has(sym)) { p = await kraken(sym); if (Math.abs(p - 1) > 0.01) throw new Error(`${sym} is off its peg (${p})`); p = 1; }
    else {
      const [a, b] = await Promise.all([coinbase(sym, now()), kraken(sym)]); // both must answer
      if (Math.abs(a - b) / Math.min(a, b) > MAX_SPREAD) throw new Error(`price sources disagree on ${sym} (${a} vs ${b})`);
      p = (a + b) / 2;
    }
    cache.set(sym, { at: now(), p });
    return p;
  };
  return { async get(symbols) { const out: Record<string, number> = {}; for (const s of new Set(symbols)) out[s] = await one(s); return out; } };
}
/** For tests and for the owner-only CLI paths that never price anything. */
export const noPrices: PriceView = { get: async () => { throw new Error('no price view configured'); } };

/**
 * In-browser stand-in for the derivatives API — DEVELOPMENT BUILDS ONLY (`main.tsx` imports this file behind
 * `import.meta.env.DEV`, so a production build neither contains it nor can enable it). Turned on by `?mock=1`.
 *
 * It answers exactly the routes of the "API contract (wave 2)" table, with the shapes `api.ts` expects, by patching `fetch` and
 * `EventSource` for `/api/v1/…` — the real client code runs unchanged. Market data starts from the recorded venue fixtures
 * (`packages/derivatives/test/fixtures/`: Hyperliquid universe / book / trades / candles, dYdX markets / book / trades / candles,
 * GMX tickers / markets / config / candles) and then moves with a small random walk so that the stream is alive. Paper accounts
 * are the repository's real `PaperAccount` engine and real `checkOrder` risk engine, so refusals carry the real risk codes.
 *
 * Test hooks: `window.__spwMock` — `setRate(perSecond)`, `stale()`, `reconnect()`, `resume()`, `perf()`.
 * Nothing here talks to a venue; nothing here is evidence that the real backend behaves the same way.
 */
import dydxBookRaw from '../../../../packages/derivatives/test/fixtures/dydx/orderbook-BTC-USD.json?raw';
import dydxCandlesRaw from '../../../../packages/derivatives/test/fixtures/dydx/candles-BTC-USD-1HOUR.json?raw';
import dydxMarketsRaw from '../../../../packages/derivatives/test/fixtures/dydx/perpetualMarkets.json?raw';
import gmxCandlesRaw from '../../../../packages/derivatives/test/fixtures/gmx/v1-ohlcv-BTC-1h.json?raw';
import gmxConfigRaw from '../../../../packages/derivatives/test/fixtures/gmx/v1-markets-config.json?raw';
import gmxMarketsRaw from '../../../../packages/derivatives/test/fixtures/gmx/v1-markets.json?raw';
import gmxTickersRaw from '../../../../packages/derivatives/test/fixtures/gmx/v1-markets-tickers.json?raw';
import hlBookRaw from '../../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-l2Book-BTC.json?raw';
import hlCandlesRaw from '../../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-candleSnapshot-BTC-1h.json?raw';
import hlStateRaw from '../../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-clearinghouseState.json?raw';
import hlCtxRaw from '../../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-metaAndAssetCtxs.json?raw';
import hlTradesRaw from '../../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-recentTrades-BTC.json?raw';
import { D, type Dec } from '../../../../packages/derivatives/src/decimal.ts';
import { applyOrderToPosition, freeCollateralAfterOrder, liquidationPriceAtLeverage } from '../../../../packages/derivatives/src/margin.ts';
import { PaperAccount } from '../../../../packages/derivatives/src/paper.ts';
import { checkOrder } from '../../../../packages/derivatives/src/risk.ts';
import { aggregateBars, type Bar } from './reducers';
import type { Book, Candle, CompareRow, Instrument, Interval, Liquidity, Order, OrderRequest, Position, PublicTrade, RiskEvent, RiskPolicy, Ticker, VenueId, VenueInfo } from './types';
import { INTERVAL_MS } from './types';

// ---------------------------------------------------------------- helpers
const E30 = D.from(10n ** 30n);
const f30 = (raw: string, scale = 12): string => D.str(D.div(D.from(BigInt(raw)), E30, scale, 'half_even'));
const pow10neg = (n: number): string => (n <= 0 ? '1' : `0.${'0'.repeat(n - 1)}1`);
const n2s = (n: number, dp: number): string => { const s = Math.max(0, n).toFixed(Math.min(dp, 12)); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s; };
const intDigits = (px: string): number => { const i = px.split('.')[0]!.replace(/^0+/, ''); return i.length; };
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h |= 0; h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
const body = (raw: string) => { const j = JSON.parse(raw); return 'text' in j ? JSON.parse(j.text) : j.body; };

// ---------------------------------------------------------------- fixtures → instruments and starting tickers
const HL_SETTLEMENT = 'Linear perpetual margined and settled in USDC; the oracle is USDT-denominated for most assets (quanto: USDT PnL paid in USDC, no conversion); funding every hour, peer to peer';
const DYDX_SETTLEMENT = 'USDC-margined linear perpetual on dYdX Chain: PnL and funding settle in USDC (Noble USDC over IBC) in the subaccount; no expiry, no delivery';
const GMX_SETTLEMENT = 'isolated position against a GM liquidity pool; PnL is computed in USD and paid in the pool token of the side (long token for longs, short token for shorts) on top of the returned collateral; settlement happens on chain when a keeper executes the order';
const GMX_DECIMALS: Record<string, number> = { BTC: 8, ETH: 18, SOL: 9, LINK: 18, DOGE: 8, LTC: 8 };

interface Seed { inst: Instrument; ticker: Omit<Ticker, 'ts'>; prev: number; bookStep: string; liquidity?: Liquidity }
function seeds(): Seed[] {
  const out: Seed[] = [];
  // Hyperliquid: the 24 most traded listed assets of the recorded universe
  const [meta, ctxs] = body(hlCtxRaw) as [{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean }[] }, any[]];
  meta.universe.map((u, i) => ({ u, c: ctxs[i] })).filter((x) => !x.u.isDelisted && x.c?.markPx && x.c?.midPx && Number(x.c.dayNtlVlm) > 0)
    .sort((a, b) => Number(b.c.dayNtlVlm) - Number(a.c.dayNtlVlm)).slice(0, 24).forEach(({ u, c }) => {
      const id = `hyperliquid:${u.name}`, priceDp = Math.max(0, 6 - u.szDecimals);
      const prev = Number(c.prevDayPx), mark = Number(c.markPx);
      out.push({
        inst: { venue: 'hyperliquid', symbol: u.name, id, base: u.name, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: HL_SETTLEMENT,
          tickSize: pow10neg(priceDp), lotSize: pow10neg(u.szDecimals), minOrderSize: null, minNotional: '10', maxLeverage: String(u.maxLeverage),
          marginModes: u.onlyIsolated ? ['isolated'] : ['cross', 'isolated'], fundingIntervalSec: 3600,
          markPriceMethod: 'Median of (1) oracle + 150 s EMA of (Hyperliquid mid − oracle), (2) median of best bid, best ask, last trade, (3) weighted median of CEX perp mids; updated about every 3 s', status: 'active' },
        ticker: { instrument: id, mark: c.markPx, index: c.oraclePx, mid: c.midPx, funding: c.funding, openInterest: c.openInterest, volume24h: c.dayNtlVlm, change24h: prev > 0 ? n2s0((mark - prev) / prev) : null },
        prev, bookStep: pow10neg(Math.min(priceDp, Math.max(0, 5 - intDigits(c.markPx)))),
      });
    });
  // dYdX v4: market data only
  const dm = (body(dydxMarketsRaw) as { markets: Record<string, any> }).markets;
  Object.values(dm).filter((m) => m.status === 'ACTIVE' && Number(m.volume24H) > 0 && Number(m.oraclePrice) > 0).sort((a, b) => Number(b.volume24H) - Number(a.volume24H)).slice(0, 10).forEach((m) => {
    const id = `dydx:${m.ticker}`, px = Number(m.oraclePrice), prev = px - Number(m.priceChange24H);
    out.push({
      inst: { venue: 'dydx', symbol: m.ticker, id, base: String(m.ticker).split('-')[0]!, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: DYDX_SETTLEMENT,
        tickSize: m.tickSize, lotSize: m.stepSize, minOrderSize: m.stepSize, minNotional: null, maxLeverage: D.str(D.div(D.one, D.from(m.initialMarginFraction), 4, 'down')),
        marginModes: ['cross'], fundingIntervalSec: 3600, markPriceMethod: 'no separate mark price: the protocol oracle price (validator-aggregated index of exchange prices, updated per block) values positions, margin and liquidations', status: 'active' },
      ticker: { instrument: id, mark: m.oraclePrice, index: m.oraclePrice, mid: null, funding: m.nextFundingRate, openInterest: m.openInterest, volume24h: m.volume24H, change24h: prev > 0 ? n2s0((px - prev) / prev) : null },
      prev, bookStep: m.tickSize,
    });
  });
  // GMX v2 (Arbitrum): one instrument per pool, no order book
  const gm = new Map((body(gmxMarketsRaw) as any[]).map((m) => [m.marketTokenAddress, m]));
  const gc = new Map((body(gmxConfigRaw) as any[]).map((m) => [m.marketTokenAddress, m]));
  for (const t of body(gmxTickersRaw) as any[]) {
    const m = gm.get(t.marketTokenAddress), g = gc.get(t.marketTokenAddress);
    const mm = /^([A-Z]+)\/USD \[([A-Z.]+)-([A-Z.]+)\]$/.exec(t.symbol);
    if (!m || m.isSpotOnly || !mm || !g) continue;
    const base = mm[1]!, dec = GMX_DECIMALS[base] ?? 18, id = `gmx:${t.symbol}`, mark = f30(t.markPrice, 4);
    const oiTokens = D.div(D.from(BigInt(t.longInterestInTokens) + BigInt(t.shortInterestInTokens)), D.from(10n ** BigInt(dec)), 8, 'down');
    const fac = (x: unknown) => (typeof x === 'string' && /^-?\d+$/.test(x) ? f30(x, 14) : undefined);
    out.push({
      inst: { venue: 'gmx', symbol: t.symbol, id, base, quote: 'USD', kind: 'perpetual', collateral: mm[2] === mm[3] ? mm[2]! : `${mm[2]} or ${mm[3]}`, settlement: GMX_SETTLEMENT,
        tickSize: pow10neg(30 - dec), lotSize: pow10neg(dec), minOrderSize: null, minNotional: f30(m.minPositionSizeUsd, 2), maxLeverage: D.str(D.div(D.from(BigInt(m.leverageTiers[0].maxLeverage)), D.from(10000n), 2, 'down')),
        marginModes: ['isolated'], fundingIntervalSec: 3600, markPriceMethod: 'signed oracle min/max (Chainlink Data Streams): longs open at max and close at min; displayed mark = (min + max) / 2', status: m.isListed ? 'active' : 'halted' },
      ticker: { instrument: id, mark, index: mark, mid: null, funding: f30(String(-BigInt(t.fundingRateLong)), 14), openInterest: D.str(oiTokens), volume24h: null, change24h: n2s0(Number(t.priceChangePercent24hBps) / 10000) },
      prev: Number(mark) / (1 + Number(t.priceChangePercent24hBps) / 10000), bookStep: '0.01',
      liquidity: { openInterestLongUsd: f30(t.longInterestUsd, 2), openInterestShortUsd: f30(t.shortInterestUsd, 2), maxOpenInterestLongUsd: f30(g.maxOpenInterestLong, 2), maxOpenInterestShortUsd: f30(g.maxOpenInterestShort, 2),
        availableLiquidityLongUsd: f30(t.availableLiquidityLong, 2), availableLiquidityShortUsd: f30(t.availableLiquidityShort, 2), capacityLongUsd: f30(t.capacityLong.availableLiquidity, 2), capacityShortUsd: f30(t.capacityShort.availableLiquidity, 2),
        fundingRateLongPerHour: f30(t.fundingRateLong, 14), fundingRateShortPerHour: f30(t.fundingRateShort, 14), borrowingRateLongPerHour: f30(t.borrowingRateLong, 14), borrowingRateShortPerHour: f30(t.borrowingRateShort, 14),
        netRateLongPerHour: f30(t.netRateLong, 14), netRateShortPerHour: f30(t.netRateShort, 14),
        priceImpact: { factorPositive: fac(g.positionImpactFactorPositive), factorNegative: fac(g.positionImpactFactorNegative), exponentPositive: fac(g.positionImpactExponentFactorPositive), exponentNegative: fac(g.positionImpactExponentFactorNegative),
          maxFactorPositive: fac(g.maxPositionImpactFactorPositive), maxFactorNegative: fac(g.maxPositionImpactFactorNegative) },
        positionFeeFactor: { balanceImproved: fac(g.positionFeeFactorForBalanceWasImproved), balanceNotImproved: fac(g.positionFeeFactorForBalanceWasNotImproved) },
        oracleMin: f30(t.minPrice, 4), oracleMax: f30(t.maxPrice, 4) },
    });
  }
  return out;
}
function n2s0(n: number): string { const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; }

// ---------------------------------------------------------------- live simulation of one instrument
interface Profile { gap: number; usd: number }
function profiles(): Record<'hyperliquid' | 'dydx', { bids: Profile[]; asks: Profile[]; spread: number; tradeUsd: number[] }> {
  const hl = body(hlBookRaw) as { levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] };
  const dy = body(dydxBookRaw) as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
  const side = (ls: { p: number; s: number }[]): Profile[] => ls.slice(0, 20).map((l) => ({ gap: Math.round(Math.abs(l.p - ls[0]!.p)), usd: l.p * l.s }));
  const hb = hl.levels[0].map((l) => ({ p: Number(l.px), s: Number(l.sz) })), ha = hl.levels[1].map((l) => ({ p: Number(l.px), s: Number(l.sz) }));
  const db = dy.bids.map((l) => ({ p: Number(l.price), s: Number(l.size) })), da = dy.asks.map((l) => ({ p: Number(l.price), s: Number(l.size) }));
  const tr = (body(hlTradesRaw) as { px: string; sz: string }[]).map((t) => Number(t.px) * Number(t.sz));
  return { hyperliquid: { bids: side(hb), asks: side(ha), spread: Math.max(1, Math.round(ha[0]!.p - hb[0]!.p)), tradeUsd: tr },
    dydx: { bids: side(db), asks: side(da), spread: Math.max(1, Math.round(da[0]!.p - db[0]!.p)), tradeUsd: tr.map((x) => x / 20) } };
}

class Sim {
  readonly inst: Instrument;
  readonly seed: Seed;
  readonly step: Dec;
  readonly lot: Dec;
  readonly r: () => number;
  k: number;                 // best bid, in book steps
  drift = 0;
  ticker: Ticker;
  book: Book | null = null;
  trades: PublicTrade[] = [];
  fresh: PublicTrade[] = [];
  seq = 0;
  lastStep = 0;
  frozen = false;
  constructor(seed: Seed) {
    this.seed = seed; this.inst = seed.inst; this.step = D.from(seed.bookStep); this.lot = D.from(seed.inst.lotSize);
    this.r = rng(seed.inst.id);
    this.k = Math.max(2, Math.round(Number(seed.ticker.mid ?? seed.ticker.mark) / Number(seed.bookStep)));
    this.ticker = { ...seed.ticker, ts: Date.now() };
    this.advance(true);
    for (let i = 0; i < 24; i++) this.trade(Date.now() - (24 - i) * 1400);
    this.fresh = [];
  }
  price(k: number): string { return D.str(D.mul(this.step, D.from(BigInt(Math.max(1, k))))); }
  size(usd: number, px: number): string { const s = D.quantize(D.from(n2s(usd / px, 10)), this.lot, 'down'); return D.str(D.isPos(s) ? s : this.lot); }
  trade(ts: number): void {
    if (this.inst.venue === 'gmx') return;
    const p = PROFILES[this.inst.venue], buy = this.r() < 0.5, k = buy ? this.k + p.spread : this.k, px = Number(this.price(k));
    const usd = p.tradeUsd[Math.floor(this.r() * p.tradeUsd.length)] ?? 500;
    const t: PublicTrade = { instrument: this.inst.id, price: this.price(k), size: this.size(Math.max(12, usd * (px / 73700 > 0.2 ? 1 : 0.2)), px), side: buy ? 'buy' : 'sell', ts, id: `m-${this.inst.symbol}-${++this.seq}` };
    this.trades = [t, ...this.trades].slice(0, 60); this.fresh.push(t);
  }
  /** one step of the random walk: new mark, new book, sometimes a trade */
  advance(force = false): void {
    const now = Date.now();
    if (this.frozen && !force) return;
    if (!force) {
      this.drift = this.drift * 0.92 + (this.r() - 0.5) * 0.9;
      const move = Math.round(this.drift + (this.r() - 0.5) * 2.2);
      this.k = Math.max(2, this.k + move);
      if (this.r() < 0.45) this.trade(now);
    }
    this.lastStep = now;
    const stepN = Number(this.seed.bookStep);
    if (this.inst.venue === 'gmx') {
      const mark = this.price(this.k);
      this.ticker = { ...this.ticker, mark, index: mark, change24h: n2s0((Number(mark) - this.seed.prev) / this.seed.prev), ts: now };
      return;
    }
    const p = PROFILES[this.inst.venue];
    const bids: [string, string][] = [], asks: [string, string][] = [];
    for (const l of p.bids) { const k = this.k - l.gap; if (k < 1) break; const px = k * stepN; bids.push([this.price(k), this.size(l.usd * (0.55 + this.r() * 0.9) * this.scaleUsd(), px)]); }
    for (const l of p.asks) { const k = this.k + p.spread + l.gap, px = k * stepN; asks.push([this.price(k), this.size(l.usd * (0.55 + this.r() * 0.9) * this.scaleUsd(), px)]); }
    this.book = { instrument: this.inst.id, bids, asks, ts: Math.max(now, (this.book?.ts ?? 0) + 1) };
    const mid = D.div(D.add(D.from(bids[0]![0]), D.from(asks[0]![0])), D.from(2n), 12, 'half_even'), midN = D.toNumber(mid);
    const ratio = this.seed.ticker.index && Number(this.seed.ticker.mark) > 0 ? Number(this.seed.ticker.index) / Number(this.seed.ticker.mark) : 1;
    const tick = D.from(this.inst.tickSize);
    this.ticker = { ...this.ticker, mark: D.str(D.quantize(mid, tick, 'down')), mid: D.str(mid), index: D.str(D.quantize(D.from(n2s(midN * ratio, 10)), tick, 'down')),
      change24h: this.seed.prev > 0 ? n2s0((midN - this.seed.prev) / this.seed.prev) : null, ts: now };
  }
  /** smaller markets get a thinner book: scale the recorded BTC depth by relative 24 h volume (bounded) */
  scaleUsd(): number { const v = Number(this.seed.ticker.volume24h ?? 0), ref = this.inst.venue === 'dydx' ? 5_000_000 : 3_500_000_000; return Math.max(0.02, Math.min(1, v / ref)); }
}

let PROFILES: ReturnType<typeof profiles>;
const SIMS = new Map<string, Sim>();
let SEEDS: Seed[] = [];
const sim = (id: string): Sim | null => { let s = SIMS.get(id); if (!s) { const sd = SEEDS.find((x) => x.inst.id === id); if (!sd) return null; s = new Sim(sd); SIMS.set(id, s); } return s; };
const fresh = (s: Sim): Sim => { if (!s.frozen && Date.now() - s.lastStep > 400) s.advance(); return s; };

// ---------------------------------------------------------------- candles
const HOURLY = new Map<string, Bar[]>();
function pattern(venue: VenueId): Bar[] {
  if (venue === 'hyperliquid') return (body(hlCandlesRaw) as any[]).map((c) => ({ ts: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
  if (venue === 'dydx') return ((body(dydxCandlesRaw) as { candles: any[] }).candles).map((c) => ({ ts: Date.parse(c.startedAt), o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.baseTokenVolume })).sort((a, b) => a.ts - b.ts);
  return (body(gmxCandlesRaw) as any[]).map((c) => ({ ts: c.timestamp, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: 0 })).sort((a, b) => a.ts - b.ts);
}
/** hourly history: the recorded day at the end, a seeded walk with the same volatility before it; prices scaled to the instrument */
function hourly(s: Sim, hours: number): Bar[] {
  const H = 3_600_000, end = Math.floor(Date.now() / H) * H, key = `${s.inst.id}:${end}:${hours}`;
  const hit = HOURLY.get(key); if (hit) return hit;
  const pat = pattern(s.inst.venue), r = rng(`${s.inst.id}:h`), k = Number(s.ticker.mark) / pat[pat.length - 1]!.c;
  const rets = pat.map((b) => Math.log(b.c / b.o)), sd = Math.sqrt(rets.reduce((a, x) => a + x * x, 0) / rets.length) || 0.003;
  const volScale = s.inst.venue === 'gmx' ? 0 : (73700 / Number(s.ticker.mark)) * s.scaleUsd();
  const bars: Bar[] = pat.map((b) => ({ ts: 0, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k, v: b.v * volScale }));
  while (bars.length < hours) {
    const next = bars[0]!, c = next.o, o = c / Math.exp(gauss(r) * sd), w = Math.abs(gauss(r)) * sd * 0.6, w2 = Math.abs(gauss(r)) * sd * 0.6;
    bars.unshift({ ts: 0, o, c, h: Math.max(o, c) * (1 + w), l: Math.min(o, c) * (1 - w2), v: (pat[Math.floor(r() * pat.length)]!.v || 0) * volScale * (0.6 + r() * 0.8) });
  }
  bars.forEach((b, i) => { b.ts = end - (bars.length - 1 - i) * H; });
  HOURLY.set(key, bars);
  return bars;
}
function candles(s: Sim, interval: Interval, limit: number): Candle[] {
  const ms = INTERVAL_MS[interval], H = 3_600_000, dp = Math.min(8, D.from(s.inst.tickSize).s);
  let bars: Bar[];
  if (ms >= H) bars = aggregateBars(hourly(s, Math.ceil((limit * ms) / H) + 24), ms);
  else {
    const n = H / ms, hs = hourly(s, Math.ceil(limit / n) + 2), r = rng(`${s.inst.id}:${interval}`);
    bars = [];
    for (const hb of hs) {
      // a bridge from the open to the close that stays inside [low, high] and touches both
      const pts: number[] = [hb.o];
      for (let i = 1; i < n; i++) { const t = i / n, base = hb.o + (hb.c - hb.o) * t; pts.push(Math.min(hb.h, Math.max(hb.l, base + gauss(r) * (hb.h - hb.l) * 0.28 * Math.sqrt(t * (1 - t)) * 2))); }
      pts.push(hb.c);
      const iH = Math.floor(r() * n), iL = (iH + 1 + Math.floor(r() * (n - 1))) % n;
      const w = Array.from({ length: n }, () => 0.4 + r()), wSum = w.reduce((a, x) => a + x, 0);
      for (let i = 0; i < n; i++) {
        const o = pts[i]!, c = pts[i + 1]!, span = (hb.h - hb.l) / n;
        bars.push({ ts: hb.ts + i * ms, o, c, h: i === iH ? hb.h : Math.min(hb.h, Math.max(o, c) + r() * span * 0.5), l: i === iL ? hb.l : Math.max(hb.l, Math.min(o, c) - r() * span * 0.5), v: (hb.v * w[i]!) / wSum });
      }
    }
    bars = bars.filter((b) => b.ts <= Date.now());
  }
  bars = bars.slice(-limit).map((b) => ({ ...b }));
  const last = bars[bars.length - 1], mark = Number(s.ticker.mark);
  if (last) { last.c = mark; last.h = Math.max(last.h, mark); last.l = Math.min(last.l, mark); }
  return bars.map((b) => ({ ts: b.ts, open: n2s(b.o, dp), high: n2s(Math.max(b.h, b.o, b.c), dp), low: n2s(Math.min(b.l, b.o, b.c), dp), close: n2s(b.c, dp), volume: n2s(b.v, 4) }));
}

// ---------------------------------------------------------------- venues, comparison
const VENUES: VenueInfo[] = [
  { id: 'hyperliquid', name: 'Hyperliquid', network: 'mainnet', status: 'ok', lastOkAt: Date.now(), restriction: null,
    capabilities: { marketData: true, account: true, orders: true, orderTypes: ['limit', 'market', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit'], tif: ['gtc', 'ioc', 'alo'], modify: true, leverage: true, marginModes: ['cross', 'isolated'], subaccounts: true, testnet: true, stream: true, notes: [] } },
  { id: 'gmx', name: 'GMX v2', network: 'arbitrum', status: 'ok', lastOkAt: Date.now(), restriction: null,
    capabilities: { marketData: true, account: true, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, marginModes: ['isolated'], subaccounts: false, testnet: false, stream: false,
      notes: ['NO ORDER BOOK: traders open against a liquidity pool at the signed oracle price, adjusted by price impact.'] } },
  { id: 'dydx', name: 'dYdX v4', network: 'mainnet', status: 'ok', lastOkAt: Date.now(),
    restriction: 'Market data only: the dYdX terms exclude Canada and the indexer geoblocks account reads from this network. No account, no paper account.',
    capabilities: { marketData: true, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, marginModes: ['cross'], subaccounts: true, testnet: true, stream: true, notes: [] } },
];
function compare(base: string): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const sd of SEEDS.filter((x) => x.inst.base === base.toUpperCase())) {
    const s = fresh(sim(sd.inst.id)!), b = s.book;
    let spreadBps: string | null = null, depth: string | null = null;
    if (b && b.bids[0] && b.asks[0]) {
      const bb = D.from(b.bids[0][0]), ba = D.from(b.asks[0][0]), mid = D.div(D.add(bb, ba), D.from(2n), 12, 'half_even');
      spreadBps = D.str(D.div(D.mul(D.sub(ba, bb), D.from(10000n)), mid, 2, 'half_even'));
      const lo = D.mul(mid, D.from('0.99')), hi = D.mul(mid, D.from('1.01'));
      let sum = D.zero;
      for (const [p, q] of b.bids) if (D.gte(D.from(p), lo)) sum = D.add(sum, D.mul(D.from(p), D.from(q)));
      for (const [p, q] of b.asks) if (D.lte(D.from(p), hi)) sum = D.add(sum, D.mul(D.from(p), D.from(q)));
      depth = D.str(D.div(sum, D.one, 2, 'down'));
    }
    const v = s.inst.venue;
    rows.push({ venue: v, instrument: s.inst.id, mark: s.ticker.mark, index: s.ticker.index, funding: s.ticker.funding, fundingIntervalSec: s.inst.fundingIntervalSec, spreadBps, depthUsd1pct: depth,
      takerFeeBps: v === 'hyperliquid' ? '4.5' : v === 'dydx' ? '5' : '6', maxLeverage: s.inst.maxLeverage, collateral: s.inst.collateral, settlement: s.inst.settlement,
      notes: v === 'hyperliquid' ? ['Mark = median of oracle-anchored EMA, own book and CEX perp mids', 'Oracle is USDT-denominated: exposed to USDT/USD']
        : v === 'dydx' ? ['Oracle price only (no mark)', 'Market data only: terms exclude Canada']
        : ['No order book: oracle price ± price impact, executed later by a keeper', 'Position fee 0.04 % if the trade improves the long/short balance, 0.06 % otherwise (shown: 0.06 %)', 'Borrowing fee on the larger side'] });
  }
  return rows;
}

// ---------------------------------------------------------------- paper accounts (real engines)
interface Acct { id: string; venue: VenueId; label: string; policy: RiskPolicy; paper: PaperAccount; initial: string; riskEvents: RiskEvent[]; equityHistory: { ts: number; equity: string }[]; lastHour: number }
const ACCTS = new Map<string, Acct>();
const OPEN = ['pending', 'triggered', 'open', 'partially_filled'];
const basePolicy = (venue: VenueId): RiskPolicy => ({ mode: 'PAPER', allowedInstruments: SEEDS.filter((s) => s.inst.venue === venue).map((s) => s.inst.id), halt: null, maxDataAgeMs: 15000, maxDeviationBps: '500', maxMarkIndexBps: '200',
  maxLeverage: '5', maxOrderNotional: '25000', maxGrossExposure: '50000', maxPositionNotional: '25000', minFreeCollateral: '0', minLiquidationDistanceBps: '500', maxDailyLoss: '500', maxTotalLoss: '2000', maxOrdersPerMinute: 20, maxOrdersPerDay: 500 });
function createAcct(venue: VenueId, label: string, collateral: string, policy?: Partial<RiskPolicy>): Acct {
  const id = crypto.randomUUID();
  const a: Acct = { id, venue, label, policy: { ...basePolicy(venue), ...(policy ?? {}), mode: 'PAPER' }, paper: PaperAccount.create({ venue, account: `paper-${id.slice(0, 8)}`, collateral }), initial: collateral, riskEvents: [], equityHistory: [], lastHour: Math.floor(Date.now() / 3_600_000) };
  a.equityHistory.push({ ts: Date.now(), equity: collateral });
  ACCTS.set(id, a);
  return a;
}
const openOrders = (a: Acct): Order[] => a.paper.state.orders.filter((o) => OPEN.includes(o.status));
const view = (a: Acct) => ({ id: a.id, venue: a.venue, network: 'mainnet', kind: 'paper' as const, mode: 'PAPER' as const, label: a.label, policy: a.policy, state: a.paper.accountState(Date.now()), positions: a.paper.positions(), openOrders: openOrders(a) });
const detail = (a: Acct) => ({ ...view(a), orders: [...a.paper.state.orders].reverse().slice(0, 100), fills: [...a.paper.state.fills].reverse().slice(0, 100), funding: [...a.paper.state.funding].reverse().slice(0, 100),
  riskEvents: [...a.riskEvents].reverse().slice(0, 100), equityHistory: a.equityHistory });
function usage(a: Acct) {
  const now = Date.now(), st = a.paper.state, day = now - 86_400_000;
  const total = D.add(D.sub(D.from(st.realizedPnl), D.from(st.feesPaid)), D.from(st.fundingNet));
  return { realizedToday: D.str(total), realizedTotal: D.str(total), ordersLastMinute: st.orders.filter((o) => o.createdAt > now - 60_000).length, ordersToday: st.orders.filter((o) => o.createdAt > day).length, clientIds: st.orders.map((o) => o.clientId) };
}
function ctxOf(a: Acct, s: Sim, leverage?: string) {
  return { instrument: s.inst, account: a.paper.accountState(Date.now()), positions: a.paper.positions(), openOrders: openOrders(a), book: s.book!, ticker: s.ticker, now: Date.now(), usage: usage(a),
    leverage: leverage ?? a.paper.state.config.leverageByInstrument[s.inst.id] ?? a.paper.state.config.leverage };
}
function worker(): void {
  const now = Date.now();
  for (const a of ACCTS.values()) {
    const ids = new Set([...a.paper.state.positions.map((p) => p.instrument), ...openOrders(a).map((o) => o.instrument)]);
    for (const id of ids) {
      const s = sim(id); if (!s || !s.book || s.frozen) continue;
      fresh(s);
      const r1 = a.paper.onTicker(s.ticker, now), r2 = a.paper.onBook(s.book, now);
      if (r1.liquidated || r2.liquidated) a.riskEvents.push({ ts: now, kind: 'liquidation', instrument: id, detail: 'equity fell below the maintenance margin: every order cancelled, every position closed at the mark (simulated)' });
      const hour = Math.floor(now / 3_600_000);
      if (hour !== a.lastHour && s.ticker.funding) a.paper.applyFunding(s.ticker.funding, hour * 3_600_000, id);
    }
    a.lastHour = Math.floor(now / 3_600_000);
    const last = a.equityHistory[a.equityHistory.length - 1];
    if (!last || now - last.ts >= 5000) { a.equityHistory.push({ ts: now, equity: a.paper.accountState(now).equity }); if (a.equityHistory.length > 720) a.equityHistory.shift(); }
    const lost = D.sub(D.from(a.initial), D.from(a.paper.accountState(now).equity));
    if (a.policy.halt === null && D.gte(lost, D.from(a.policy.maxTotalLoss)) && D.isPos(D.from(a.policy.maxTotalLoss))) {
      a.policy = { ...a.policy, halt: 'total loss limit reached' };
      a.riskEvents.push({ ts: now, kind: 'loss_limit', instrument: null, detail: `equity is ${D.str(lost)} below the starting collateral: trading halted (limit ${a.policy.maxTotalLoss})` });
    }
  }
}
function preview(a: Acct, b: any) {
  const s = sim(String(b.instrument));
  if (!s || !s.book) return { status: 404, json: { error: 'unknown_instrument', message: 'no order book for this instrument' } };
  fresh(s);
  const req: OrderRequest = { instrument: b.instrument, side: b.side, type: b.type, size: b.size, price: b.price ?? null, triggerPrice: b.triggerPrice ?? null, reduceOnly: !!b.reduceOnly, tif: b.tif ?? 'gtc', clientId: `preview-${crypto.randomUUID()}` };
  const lev = typeof b.leverage === 'string' && D.isValid(b.leverage) ? b.leverage : undefined;
  const risk = checkOrder(a.policy, req, ctxOf(a, s, lev));
  let estimate = null;
  try {
    const size = D.from(req.size), bound = req.price ? D.from(req.price) : null, marketLike = req.type === 'market' || req.type === 'stop_market' || req.type === 'take_profit_market';
    const mid = D.from(s.ticker.mid ?? s.ticker.mark);
    let avg: Dec | null = bound;
    if (req.type === 'market') {
      let left = size, cost = D.zero;
      for (const [p, q] of req.side === 'buy' ? s.book.asks : s.book.bids) {
        const px = D.from(p); if (bound && (req.side === 'buy' ? D.gt(px, bound) : D.lt(px, bound))) break;
        const take = D.min(left, D.from(q)); cost = D.add(cost, D.mul(take, px)); left = D.sub(left, take);
        if (D.isZero(left)) break;
      }
      const done = D.sub(size, left);
      avg = D.isPos(done) ? D.div(cost, done, 8, 'half_even') : null;
    } else if (marketLike && req.triggerPrice) avg = D.from(req.triggerPrice);
    const px = avg ?? mid, notional = D.mul(size, px), cfg = a.paper.state.config;
    const leverage = D.from(lev ?? cfg.leverageByInstrument[s.inst.id] ?? cfg.leverage);
    const feeRate = D.from(req.type === 'limit' && req.tif === 'alo' ? cfg.makerFeeRate : cfg.takerFeeRate);
    const pos = a.paper.positions().find((p) => p.instrument === s.inst.id) ?? null;
    const lite = pos ? { side: pos.side, size: D.from(pos.size), entryPrice: D.from(pos.entryPrice) } : null;
    const after = applyOrderToPosition(lite, { side: req.side, size, price: px }).position;
    const liq = after ? liquidationPriceAtLeverage({ side: after.side, entryPrice: after.entryPrice, leverage, maintenanceFraction: D.from(cfg.maintenanceMarginFraction) }) : null;
    const st = a.paper.accountState(Date.now());
    const free = freeCollateralAfterOrder({ equity: D.from(st.equity), marginUsed: D.from(st.marginUsed), side: req.side, size, price: px, leverage, position: lite, feeRate });
    const added = after && lite && after.side === lite.side ? D.max(D.zero, D.sub(after.size, lite.size)) : after ? after.size : D.zero;
    estimate = { notional: D.str(D.div(notional, D.one, 2, 'half_even')), initialMargin: D.str(D.div(D.mul(added, px), leverage, 2, 'up')), fee: D.str(D.div(D.mul(notional, feeRate), D.one, 4, 'up')),
      avgFillPrice: avg ? D.str(avg) : null, slippageBps: avg && req.type === 'market' ? D.str(D.div(D.mul(D.abs(D.sub(avg, mid)), D.from(10000n)), mid, 2, 'half_even')) : null,
      liquidationPrice: liq ? { value: liq.value ? D.str(D.div(liq.value, D.one, 4, 'half_even')) : null, source: 'estimate', method: liq.method } : null,
      freeCollateralAfter: D.str(D.div(free.value, D.one, 2, 'down')) };
  } catch { estimate = null; }
  return { status: 200, json: { risk, estimate }, req, lev, s };
}
function place(a: Acct, b: any, key: string | null) {
  const p = preview(a, b);
  if (p.status !== 200 || !p.req || !p.s) return p;
  const req: OrderRequest = { ...p.req, clientId: key ?? crypto.randomUUID() };
  const s = p.s, existing = a.paper.state.orders.find((o) => o.clientId === req.clientId);
  if (existing) return { status: 200, json: { order: existing, fills: a.paper.state.fills.filter((f) => f.clientId === req.clientId) } };   // idempotent replay
  const risk = checkOrder(a.policy, req, ctxOf(a, s, p.lev));
  if (!risk.ok) {
    a.riskEvents.push({ ts: Date.now(), kind: 'order_refused', instrument: s.inst.id, detail: `${risk.code}: ${risk.reason}` });
    return { status: 422, json: { error: risk.code, message: risk.reason, risk } };
  }
  if (p.lev) a.paper.state.config.leverageByInstrument[s.inst.id] = p.lev;
  const res = a.paper.submit(req, s.book!, s.ticker, Date.now());
  return { status: 200, json: { order: res.order, fills: res.fills } };
}

// ---------------------------------------------------------------- HTTP and stream
let RATE = 4;
const STREAMS = new Set<MockStream>();
class MockStream extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readonly url: string; readonly withCredentials = false;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private s: Sim | null;
  paused = false;
  constructor(url: string) {
    super();
    this.url = url;
    this.s = sim(new URL(url, location.origin).searchParams.get('instrument') ?? '');
    STREAMS.add(this);
    setTimeout(() => this.up(), 120);
  }
  send(type: string, data: unknown): void { if (this.readyState !== 2) this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
  up(): void {
    if (this.readyState === 2) return;
    this.readyState = 1; this.paused = false;
    this.dispatchEvent(new Event('open'));
    this.send('status', { status: 'connected', ts: Date.now() });
    this.loop();
  }
  loop = (): void => {
    if (this.readyState !== 1 || this.paused) return;
    const s = this.s;
    if (s && !s.frozen) {
      s.advance();
      this.send('ticker', s.ticker);
      if (s.book) this.send('book', s.book);
      if (s.fresh.length) { this.send('trades', s.fresh); s.fresh = []; }
    }
    this.timer = setTimeout(this.loop, 1000 / RATE);
  };
  stale(): void { this.paused = true; if (this.timer) clearTimeout(this.timer); this.send('status', { status: 'stale', ts: Date.now() }); }
  drop(): void { this.paused = true; if (this.timer) clearTimeout(this.timer); this.readyState = 0; this.dispatchEvent(new Event('error')); }
  close(): void { this.readyState = 2; if (this.timer) clearTimeout(this.timer); STREAMS.delete(this); }
}

const json = (status: number, j: unknown): Response => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
async function route(method: string, path: string, q: URLSearchParams, b: any, headers: Headers): Promise<Response> {
  const venue = (q.get('venue') || undefined) as VenueId | undefined;
  if (path === '/auth/state') return json(200, { setupRequired: false, authenticated: true });
  if (path === '/auth/logout') return json(200, {});
  if (path === '/settings') return json(200, { locale: 'fr', currency: 'CAD', hideBalances: false, prices: true });
  if (!path.startsWith('/derivatives')) return json(503, { error: 'mock', message: 'mock mode: only the Futures terminal is simulated' });
  const p = path.slice('/derivatives'.length);
  if (p === '/venues') return json(200, { venues: VENUES.map((v) => ({ ...v, lastOkAt: Date.now() })) });
  if (p === '/instruments') return json(200, { instruments: SEEDS.filter((s) => !venue || s.inst.venue === venue).map((s) => s.inst) });
  if (p === '/tickers') return json(200, { tickers: SEEDS.filter((s) => !venue || s.inst.venue === venue).map((s) => { const live = SIMS.get(s.inst.id); return live ? fresh(live).ticker : { ...s.ticker, ts: Date.now() }; }), ts: Date.now() });
  if (p === '/market') { const s = sim(q.get('instrument') ?? ''); if (!s) return json(404, { error: 'unknown_instrument', message: 'unknown instrument' }); fresh(s);
    return json(200, { instrument: s.inst, ticker: s.ticker, book: s.book, liquidity: s.seed.liquidity ? { ...s.seed.liquidity, ts: Date.now() } : null, trades: s.trades }); }
  if (p === '/candles') { const s = sim(q.get('instrument') ?? ''); if (!s) return json(404, { error: 'unknown_instrument', message: 'unknown instrument' });
    return json(200, { candles: candles(fresh(s), (q.get('interval') ?? '1h') as Interval, Math.min(500, Number(q.get('limit')) || 300)) }); }
  if (p === '/funding') { const s = sim(q.get('instrument') ?? ''); if (!s) return json(404, { error: 'unknown_instrument', message: 'unknown instrument' });
    const hours = Math.min(168, Number(q.get('hours')) || 24), r = rng(`${s.inst.id}:f`), base = Number(s.ticker.funding ?? 0), H = 3_600_000, end = Math.floor(Date.now() / H) * H;
    return json(200, { history: Array.from({ length: hours }, (_, i) => ({ ts: end - (hours - 1 - i) * H, rate: n2sSigned(base * (0.6 + r() * 0.8)) })), intervalSec: s.inst.fundingIntervalSec }); }
  if (p === '/compare') return json(200, { rows: compare(q.get('base') ?? 'BTC') });
  if (p === '/watch') {
    const acct = q.get('account') ?? '';
    if (venue === 'dydx') return json(403, { error: 'venue_restricted', message: VENUES[2]!.restriction });
    if (!/^0x[0-9a-fA-F]{40}$/.test(acct)) return json(400, { error: 'bad_address', message: 'not an EVM address' });
    return json(200, watch(acct, venue ?? 'hyperliquid'));
  }
  if (p === '/accounts' && method === 'GET') return json(200, { accounts: [...ACCTS.values()].map(view) });
  if (p === '/accounts' && method === 'POST') {
    const v = VENUES.find((x) => x.id === b?.venue);
    if (!v || !v.capabilities.orders || v.restriction) return json(422, { error: 'venue_not_available', message: v?.restriction ?? 'paper trading is not available on this venue in this wave' });
    if (!D.isValid(b.collateral) || !D.isPos(D.from(b.collateral))) return json(400, { error: 'bad_request', message: 'collateral must be a positive decimal' });
    return json(200, view(createAcct(v.id, String(b.label || 'Paper').slice(0, 40), b.collateral, b.policy)));
  }
  const m = /^\/accounts\/([^/]+)(\/.*)?$/.exec(p);
  const a = m ? ACCTS.get(decodeURIComponent(m[1]!)) : undefined;
  if (!m || !a) return json(404, { error: 'not_found', message: 'unknown account' });
  const rest = m[2] ?? '';
  if (rest === '' && method === 'GET') return json(200, detail(a));
  if (rest === '/policy') { a.policy = { ...basePolicy(a.venue), ...b, mode: 'PAPER' }; return json(200, view(a)); }
  if (rest === '/orders/preview') { const r = preview(a, b); return json(r.status, r.json); }
  if (rest === '/orders') { const r = place(a, b, headers.get('idempotency-key')); return json(r.status, r.json); }
  const c = /^\/orders\/([^/]+)\/cancel$/.exec(rest);
  if (c) { const r = a.paper.cancel(decodeURIComponent(c[1]!), Date.now()); return r.order ? json(200, { order: r.order }) : json(404, { error: 'not_found', message: 'unknown order' }); }
  if (rest === '/close') {
    const s = sim(String(b.instrument)), pos = a.paper.positions().find((x) => x.instrument === b.instrument);
    if (!s || !pos) return json(404, { error: 'no_position', message: 'no position on this instrument' });
    fresh(s);
    const lot = D.from(s.inst.lotSize), fr = D.from(String(b.fraction));
    const size = D.gte(fr, D.one) ? D.from(pos.size) : D.quantize(D.mul(D.from(pos.size), fr), lot, 'down');
    if (!D.isPos(size)) return json(422, { error: 'below_min_size', message: 'the fraction is smaller than one lot' });
    const side = pos.side === 'long' ? 'sell' as const : 'buy' as const, mark = D.from(s.ticker.mark), tick = D.from(s.inst.tickSize);
    const price = D.quantize(D.mul(mark, D.from(side === 'buy' ? '1.01' : '0.99')), tick, side === 'buy' ? 'down' : 'up');
    const r = place(a, { instrument: b.instrument, side, type: 'market', size: D.str(size), price: D.str(price), triggerPrice: null, reduceOnly: true, tif: 'ioc' }, headers.get('idempotency-key'));
    return json(r.status, r.json);
  }
  if (rest === '/reset') { a.paper = PaperAccount.create({ venue: a.venue, account: a.paper.state.account, collateral: a.initial }); a.riskEvents = []; a.equityHistory = [{ ts: Date.now(), equity: a.initial }]; a.policy = { ...a.policy, halt: null }; return json(200, view(a)); }
  return json(404, { error: 'not_found', message: 'unknown route' });
}
function n2sSigned(n: number): string { const s = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; }
/** a recorded Hyperliquid account (clearinghouseState fixture), mapped to the normalised models */
function watch(account: string, venue: VenueId) {
  const now = Date.now();
  if (venue !== 'hyperliquid') return { state: { venue, account, equity: '0', collateral: '0', freeCollateral: '0', marginUsed: '0', maintenanceMargin: null, withdrawable: '0', ts: now, source: 'venue' }, positions: [], openOrders: [] };
  const st = body(hlStateRaw) as any;
  const positions: Position[] = (st.assetPositions as any[]).map(({ position: p }) => {
    const szi = D.from(String(p.szi)), size = D.abs(szi), mark = D.isPos(size) ? D.div(D.from(p.positionValue), size, 6, 'half_even') : D.from(p.entryPx);
    return { instrument: `hyperliquid:${p.coin}`, side: D.isNeg(szi) ? 'short' : 'long', size: D.str(size), entryPrice: D.str(D.from(p.entryPx)), markPrice: D.str(mark), liquidationPrice: p.liquidationPx ? D.str(D.div(D.from(p.liquidationPx), D.one, 4, 'half_even')) : null,
      leverage: String(p.leverage.value), marginMode: p.leverage.type === 'isolated' ? 'isolated' : 'cross', margin: p.marginUsed, unrealizedPnl: p.unrealizedPnl, realizedPnl: null, fundingPaid: p.cumFunding?.sinceOpen ?? null, source: 'venue' };
  });
  const eq = D.from(st.marginSummary.accountValue), used = D.from(st.marginSummary.totalMarginUsed);
  return { state: { venue, account, equity: D.str(eq), collateral: st.marginSummary.totalRawUsd, freeCollateral: D.str(D.sub(eq, used)), marginUsed: D.str(used), maintenanceMargin: st.crossMaintenanceMarginUsed ?? null, withdrawable: st.withdrawable ?? null, ts: now, source: 'venue' }, positions, openOrders: [] };
}

declare global { interface Window { __spwMock?: { setRate: (n: number) => void; stale: () => void; reconnect: () => void; resume: () => void; accounts: () => number } } }

export function installMock(): void {
  PROFILES = profiles();
  SEEDS = seeds();
  const q = new URLSearchParams(location.search);
  if (Number(q.get('rate')) > 0) RATE = Math.min(60, Number(q.get('rate')));
  if (sessionStorage.getItem('spw-mock') !== 'empty') createAcct('hyperliquid', 'Simulation Hyperliquid', '10000');
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) return realFetch(input, init);
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    let b: any = {};
    try { b = init?.body ? JSON.parse(String(init.body)) : {}; } catch { b = {}; }
    try { return await route((init?.method ?? 'GET').toUpperCase(), url.pathname.slice('/api/v1'.length), url.searchParams, b, new Headers(init?.headers)); }
    catch (e) { console.error('[mock]', e); return json(500, { error: 'mock_error', message: e instanceof Error ? e.message : String(e) }); }
  };
  const RealES = window.EventSource;
  window.EventSource = new Proxy(RealES, { construct(target, args: [string, EventSourceInit?]) {
    return String(args[0]).includes('/api/v1/derivatives/stream') ? (new MockStream(String(args[0])) as unknown as EventSource) : new target(...args);
  } });
  setInterval(worker, 1000);
  const freeze = (v: boolean) => { for (const s of SIMS.values()) s.frozen = v; };
  window.__spwMock = {
    setRate: (n) => { RATE = Math.max(1, Math.min(60, n)); },
    stale: () => { freeze(true); for (const s of STREAMS) s.stale(); },
    reconnect: () => { freeze(true); for (const s of STREAMS) s.drop(); setTimeout(() => { freeze(false); for (const s of STREAMS) s.up(); }, 2500); },
    resume: () => { freeze(false); for (const s of STREAMS) s.up(); },
    accounts: () => ACCTS.size,
  };
  console.info('[SP Wallet] mock mode: derivatives API simulated in the browser from recorded fixtures — no backend, no venue.');
}

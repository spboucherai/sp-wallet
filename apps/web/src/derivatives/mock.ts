/**
 * In-browser stand-in for the derivatives API — DEVELOPMENT BUILDS ONLY (`main.tsx` imports this file behind
 * `import.meta.env.DEV`, so a production build neither contains it nor can enable it). Turned on by `?mock=1`.
 *
 * It answers the routes of the "API contract (wave 2)" table with the shapes of the real backend (docs/v4/API-WAVE2-NOTES.md,
 * services/api/src/derivatives: same defaults, same refusal order, same error codes), by patching `fetch` and
 * `EventSource` for `/api/v1/…` — the real client code runs unchanged. Market data starts from the recorded venue fixtures
 * (`packages/derivatives/test/fixtures/`: Hyperliquid universe / book / trades / candles, dYdX markets / book / trades / candles,
 * GMX tickers / markets / config / candles) and then moves with a small random walk so that the stream is alive. Paper accounts
 * are the repository's real `PaperAccount` engine and real `checkOrder` risk engine, so refusals carry the real risk codes.
 *
 * The routes of controlled LIVE trading (`/derivatives/live/*`) are simulated by `mockLive.ts`: venue accounts, authorization
 * with a simulated passkey, proposals, approvals, venue refusals, `unknown` → reconciled, halt, divergence.
 *
 * Test hooks: `window.__spwMock` — `setRate(perSecond)`, `stale()`, `reconnect()`, `resume()`, `perf()`, and `live.*` (mockLive.ts).
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
import { freeCollateralAfterOrder, initialMargin } from '../../../../packages/derivatives/src/margin.ts';
import { PaperAccount } from '../../../../packages/derivatives/src/paper.ts';
import { checkOrder } from '../../../../packages/derivatives/src/risk.ts';
import { stepAt, worstPrice as worstPriceOf } from './dec';
import { createLiveMock, type LiveHooks } from './mockLive';
import { createRouterMock } from './mockRouter';   // router (simulation): POST /derivatives/route, GET /derivatives/route/assets
import { aggregateBars, type Bar } from './reducers';
import type { Book, Candle, CompareRow, Instrument, Interval, Liquidity, OrderRequest, Position, PublicTrade, RiskPolicy, Ticker, VenueId, VenueInfo } from './types';
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

// ---------------------------------------------------------------- venues, comparison (shapes of services/api/src/derivatives)
const DYDX_RESTRICTION = 'dYdX is served for market data only: its terms of use exclude Canada (and the United States and the United Kingdom) and its indexer geoblocks account reads from the owner\'s network. No account view and no paper account are offered on this venue, so that it cannot be mistaken for a venue the owner may trade on.';
const VENUES: VenueInfo[] = [
  { id: 'hyperliquid', name: 'Hyperliquid', network: 'mainnet', status: 'ok', lastOkAt: Date.now(), lastError: null, restriction: null, paper: true, orderBook: true,
    capabilities: { marketData: true, account: true, orders: true, orderTypes: ['limit', 'market', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit'], tif: ['gtc', 'ioc', 'alo'], modify: true, leverage: true, marginModes: ['cross', 'isolated'], subaccounts: true, testnet: true, stream: true, notes: [] } },
  { id: 'gmx', name: 'GMX v2 (Arbitrum)', network: 'mainnet', status: 'ok', lastOkAt: Date.now(), lastError: null, restriction: null, paper: false, orderBook: false,
    capabilities: { marketData: true, account: true, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, marginModes: ['isolated'], subaccounts: false, testnet: false, stream: false,
      notes: ['NO ORDER BOOK: book() throws "unsupported". Use liquidity(symbol): available liquidity and open interest per side, price-impact parameters, funding and borrowing rates.'] } },
  { id: 'dydx', name: 'dYdX v4', network: 'mainnet', status: 'ok', lastOkAt: Date.now(), lastError: null, restriction: DYDX_RESTRICTION, paper: false, orderBook: true,
    capabilities: { marketData: true, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false, marginModes: ['cross'], subaccounts: true, testnet: true, stream: true, notes: [DYDX_RESTRICTION] } },
];
function compare(base: string) {
  const rows: (CompareRow & { ts: number; source: 'venue' })[] = [];
  for (const sd of SEEDS.filter((x) => x.inst.base === base.toUpperCase())) {
    const s = fresh(sim(sd.inst.id)!), b = s.book;
    let spreadBps: string | null = null, bid: string | null = null, ask: string | null = null;
    if (b && b.bids[0] && b.asks[0]) {
      const bb = D.from(b.bids[0][0]), ba = D.from(b.asks[0][0]), mid = D.div(D.add(bb, ba), D.from(2n), 12, 'half_even');
      spreadBps = D.str(D.div(D.mul(D.sub(ba, bb), D.from(10000n)), mid, 2, 'half_even'));
      const lo = D.mul(mid, D.from('0.99')), hi = D.mul(mid, D.from('1.01'));
      let sb = D.zero, sa = D.zero;
      for (const [p, q] of b.bids) if (D.gte(D.from(p), lo)) sb = D.add(sb, D.mul(D.from(p), D.from(q)));
      for (const [p, q] of b.asks) if (D.lte(D.from(p), hi)) sa = D.add(sa, D.mul(D.from(p), D.from(q)));
      bid = D.str(D.div(sb, D.one, 2, 'down')); ask = D.str(D.div(sa, D.one, 2, 'down'));
    }
    const v = s.inst.venue;
    rows.push({ venue: v, instrument: s.inst.id, mark: s.ticker.mark, index: s.ticker.index, funding: s.ticker.funding, fundingVenue: { rate: s.ticker.funding, intervalSec: s.inst.fundingIntervalSec },
      spreadBps, depthUsd1pct: bid !== null && ask !== null ? D.str(D.add(D.from(bid), D.from(ask))) : null, depthBidUsd1pct: bid, depthAskUsd1pct: ask,
      takerFeeBps: v === 'hyperliquid' ? '4.5' : v === 'dydx' ? '5' : null, maxLeverage: s.inst.maxLeverage, collateral: s.inst.collateral, settlement: s.inst.settlement,
      restriction: VENUES.find((x) => x.id === v)?.restriction ?? null,
      notes: v === 'hyperliquid' ? ['depth is a lower bound: the book is read 20 levels deep per side', 'mark = median of oracle-anchored EMA, own book and CEX perp mids; the oracle is USDT-denominated']
        : v === 'dydx' ? ['oracle price only (no separate mark)', 'market data only on this venue']
        : ['no order book: oracle price ± price impact, executed later by a keeper', 'position fee 0.04 % if the trade improves the long/short balance, 0.06 % otherwise; plus price impact and an execution fee', 'borrowing fee on the larger side'],
      ts: s.ticker.ts, source: 'venue' });
  }
  return { base: base.toUpperCase(), rows, errors: [], ts: Date.now() };
}

// ---------------------------------------------------------------- paper accounts (the repository's real engines, the backend's rules)
interface Ev { id: number; ts: number; kind: string; code: string | null; message: string; data: Record<string, unknown> }
interface Acct { id: string; venue: VenueId; label: string; policy: RiskPolicy; paper: PaperAccount; initial: string; events: Ev[]; equity: { ts: number; equity: string; collateral: string; marginUsed: string; unrealizedPnl: string; source: 'paper' }[]; cursor: number; createdAt: number; updatedAt: number }
const ACCTS = new Map<string, Acct>();
let EVSEQ = 0;
const MAINTENANCE = '0.02';
/** services/api/src/derivatives/paper.ts `defaultPolicy` */
function defaultPolicy(venue: VenueId, collateral: string): RiskPolicy {
  const c = D.from(collateral), times = (k: string) => D.str(D.mul(c, D.from(k)));
  return { mode: 'PAPER', allowedInstruments: [`${venue}:BTC`, `${venue}:ETH`], halt: null, maxDataAgeMs: 10_000, maxDeviationBps: '200', maxMarkIndexBps: '100', maxLeverage: '3',
    maxOrderNotional: times('1'), maxGrossExposure: times('3'), maxPositionNotional: times('2'), minFreeCollateral: times('0.1'), minLiquidationDistanceBps: '1000',
    maxDailyLoss: times('0.05'), maxTotalLoss: times('0.2'), maxOrdersPerMinute: 10, maxOrdersPerDay: 200 };
}
const event = (a: Acct, kind: string, code: string | null, message: string, data: Record<string, unknown> = {}) => { a.events.push({ id: ++EVSEQ, ts: Date.now(), kind, code, message, data }); };
function snapshot(a: Acct, force = false): void {
  const now = Date.now(), minute = Math.floor(now / 60_000) * 60_000, st = a.paper.accountState(now), last = a.equity[a.equity.length - 1];
  const row = { ts: minute, equity: st.equity, collateral: st.collateral, marginUsed: st.marginUsed, unrealizedPnl: D.str(D.sub(D.from(st.equity), D.from(st.collateral))), source: 'paper' as const };
  if (last && last.ts === minute) { if (force || last.equity !== row.equity) a.equity[a.equity.length - 1] = row; } else a.equity.push(row);
  if (a.equity.length > 1500) a.equity.shift();
}
function createAcct(venue: VenueId, label: string, collateral: string, policy?: Partial<RiskPolicy>): Acct {
  const id = crypto.randomUUID(), now = Date.now(), c = D.str(D.from(collateral));
  const pol: RiskPolicy = { ...defaultPolicy(venue, c), ...(policy ?? {}) };
  const a: Acct = { id, venue, label, policy: pol, initial: c, events: [], equity: [], cursor: Math.floor(now / 3_600_000), createdAt: now, updatedAt: now,
    paper: PaperAccount.create({ venue, account: `paper:${id}`, collateral: c, config: { takerFeeRate: '0.00045', makerFeeRate: '0.00015', liquidationFeeRate: '0', feeAsset: 'USDC', leverage: pol.maxLeverage, leverageByInstrument: {}, maintenanceMarginFraction: MAINTENANCE } }) };
  ACCTS.set(id, a); snapshot(a, true);
  return a;
}
function view(a: Acct) {
  const s = a.paper.state;
  return { id: a.id, venue: a.venue, network: 'mainnet', kind: 'paper' as const, mode: a.policy.mode, label: a.label, policy: a.policy, state: a.paper.accountState(a.updatedAt), positions: a.paper.positions(), openOrders: a.paper.openOrders(),
    initialCollateral: a.initial, settings: { leverage: s.config.leverage, leverageByInstrument: s.config.leverageByInstrument, takerFeeRate: s.config.takerFeeRate, makerFeeRate: s.config.makerFeeRate, maintenanceMarginFraction: s.config.maintenanceMarginFraction,
      liquidationPrice: 'estimate (cross, single-position approximation)' },
    totals: { realizedPnl: s.realizedPnl, feesPaid: s.feesPaid, fundingNet: s.fundingNet, liquidations: s.liquidations }, createdAt: a.createdAt, updatedAt: a.updatedAt };
}
const detail = (a: Acct) => ({ ...view(a), orders: [...a.paper.state.orders].reverse().slice(0, 100), fills: [...a.paper.state.fills].reverse().slice(0, 100), funding: [...a.paper.state.funding].reverse().slice(0, 100),
  riskEvents: [...a.events].reverse().slice(0, 100), equity: a.equity });
function usage(a: Acct) {
  const now = Date.now(), st = a.paper.state, day = Math.floor(now / 86_400_000) * 86_400_000;
  const total = D.add(D.sub(D.from(st.realizedPnl), D.from(st.feesPaid)), D.from(st.fundingNet));
  return { realizedToday: D.str(total), realizedTotal: D.str(total), ordersLastMinute: st.orders.filter((o) => o.createdAt > now - 60_000).length, ordersToday: st.orders.filter((o) => o.createdAt >= day).length, clientIds: st.orders.map((o) => o.clientId) };
}
function worker(): void {
  const now = Date.now();
  for (const a of ACCTS.values()) {
    const ids = new Set([...a.paper.state.positions.map((p) => p.instrument), ...a.paper.openOrders().map((o) => o.instrument)]);
    let touched = false;
    for (const id of ids) {
      const s = sim(id); if (!s || !s.book || s.frozen) continue;
      fresh(s); touched = true;
      const r1 = a.paper.onTicker(s.ticker, now), r2 = a.paper.onBook(s.book, now);
      if (r1.liquidated || r2.liquidated) event(a, 'liquidation', null, 'equity fell below the maintenance margin: every order cancelled, every position closed at the mark (simulated liquidation)', { instrument: id });
      const hour = Math.floor(now / 3_600_000);
      if (hour !== a.cursor && s.ticker.funding) a.paper.applyFunding(s.ticker.funding, hour * 3_600_000, id);
    }
    a.cursor = Math.floor(now / 3_600_000);
    if (touched) { a.updatedAt = now; snapshot(a); }
    const lost = D.sub(D.from(a.initial), D.from(a.paper.accountState(now).equity));
    if (a.policy.halt === null && D.isPos(D.from(a.policy.maxTotalLoss)) && D.gte(lost, D.from(a.policy.maxTotalLoss))) {
      a.policy = { ...a.policy, halt: 'total loss limit reached' };
      event(a, 'loss_limit', 'total_loss_exceeded', `equity is ${D.str(lost)} below the starting collateral (limit ${a.policy.maxTotalLoss}): trading halted`);
    }
  }
}
const HL_SIG = (venue: string, tick: Dec, p: string): string | null => {
  const d = D.from(p);
  return D.isMultiple(d, stepAt(venue, tick, d)) ? null : `${p} is not on the venue's price grid (at most 5 significant figures)`;
};
type Outcome = { status: number; json: any };
/** the order as the engines take it + the first refusal, exactly in the backend's order: leverage, price grid, risk engine */
function prepare(a: Acct, b: any, clientId: string): Outcome | { a: Acct; s: Sim; req: OrderRequest; lev: string; risk: ReturnType<typeof checkOrder> } {
  const s = sim(String(b.instrument));
  if (!s) return { status: 404, json: { error: 'unknown_instrument', message: `unknown instrument ${b.instrument}` } };
  if (s.inst.venue !== a.venue || !s.book) return { status: 422, json: { error: 'instrument_mismatch', message: `${b.instrument} is not an instrument of the account's venue` } };
  if (s.frozen || Date.now() - s.ticker.ts > 15_000) return { status: 503, json: { error: 'stale_data', message: 'market data is too old' } };
  fresh(s);
  if ('clientId' in b || !D.isValid(b.size) || !D.isPos(D.from(b.size))) return { status: 400, json: { error: 'bad_request', message: 'invalid order body' } };
  const tick = D.from(s.inst.tickSize), cfg = a.paper.state.config, max = D.from(s.inst.maxLeverage);
  let price: string | null = b.price ?? null;
  if (price === null && b.type === 'market' && typeof b.slippageBps === 'number') {
    const best = b.side === 'buy' ? s.book.asks[0] : s.book.bids[0];
    if (!best) return { status: 503, json: { error: 'no_liquidity', message: 'the book has no level on that side' } };
    price = D.str(worstPriceOf(D.from(best[0]), b.side, b.slippageBps, tick, s.inst.venue));
  }
  const req: OrderRequest = { instrument: s.inst.id, side: b.side, type: b.type, size: D.str(D.from(b.size)), price: price === null ? null : D.str(D.from(price)), triggerPrice: b.triggerPrice ? D.str(D.from(b.triggerPrice)) : null,
    reduceOnly: b.reduceOnly ?? false, tif: b.tif ?? 'gtc', clientId };
  let lev = cfg.leverageByInstrument[s.inst.id] ?? D.str(D.min(D.from(cfg.leverage), max));
  const no = (code: string, reason: string) => ({ a, s, req, lev, risk: { ok: false as const, code: code as never, reason } });
  if (typeof b.leverage === 'string') {
    if (!D.isValid(b.leverage) || !D.isPos(D.from(b.leverage))) return { status: 400, json: { error: 'bad_request', message: 'invalid leverage' } };
    lev = D.str(D.from(b.leverage));
    if (D.gt(D.from(lev), max)) return no('leverage_exceeded', `leverage ${lev} is above the venue maximum ${s.inst.maxLeverage} for ${s.inst.id}`);
    if (D.gt(D.from(lev), D.from(a.policy.maxLeverage))) return no('leverage_exceeded', `leverage ${lev} is above the policy maximum ${a.policy.maxLeverage}`);
    if (!D.isMultiple(D.from(lev), D.one)) return no('leverage_exceeded', 'leverage on Hyperliquid is an integer of at least 1');
  }
  for (const [name, p] of [['price', req.price], ['trigger price', req.triggerPrice]] as const) { const why = p === null ? null : HL_SIG(s.inst.venue, tick, p); if (why) return no('price_not_on_tick', `${name}: ${why}`); }
  const risk = checkOrder(a.policy, req, { instrument: s.inst, account: a.paper.accountState(Date.now()), positions: a.paper.positions(), openOrders: a.paper.openOrders(), book: s.book, ticker: s.ticker, now: Date.now(), usage: usage(a), leverage: lev, maintenanceMarginFraction: cfg.maintenanceMarginFraction });
  return { a, s, req, lev, risk };
}
/** same simulation as an order, on a copy (services/api/src/derivatives/paper.ts `estimate`) */
function estimate(a: Acct, s: Sim, req: OrderRequest, lev: string) {
  const now = Date.now(), simAcct = PaperAccount.restore(a.paper.serialize());
  simAcct.state.config.leverageByInstrument[s.inst.id] = lev;
  const before = simAcct.signedPosition(s.inst.id), cfg = simAcct.state.config, levD = D.from(lev), size = D.from(req.size), limit = req.price === null ? null : D.from(req.price);
  const base = { leverage: lev, price: req.price, source: 'estimate' as const };
  if (limit === null) return { ...base, notional: D.str(D.mul(size, D.from(s.ticker.mark))), initialMargin: D.str(initialMargin(D.mul(size, D.from(s.ticker.mark)), levD)), fee: '0', avgFillPrice: null, slippageBps: null, liquidationPrice: null,
    freeCollateralAfter: simAcct.accountState(now).freeCollateral, filledSize: '0', restingSize: '0', status: 'rejected', rejectReason: 'a price is required (limit price, or worst acceptable price of a market order)' };
  const res = simAcct.submit(req, s.book!, s.ticker, now), order = res.order!;
  const mine = res.fills.filter((f) => f.clientId === req.clientId);
  const filled = mine.reduce((x, f) => D.add(x, D.from(f.size)), D.zero), cost = mine.reduce((x, f) => D.add(x, D.mul(D.from(f.size), D.from(f.price))), D.zero);
  let fee = mine.reduce((x, f) => D.add(x, D.from(f.fee)), D.zero);
  const open = ['pending', 'triggered', 'open', 'partially_filled'].includes(order.status), resting = open ? D.sub(size, filled) : D.zero, rejected = order.status === 'rejected';
  const avg = D.isPos(filled) ? D.div(cost, filled, 18, 'half_even') : null, maker = D.max(D.zero, D.from(cfg.makerFeeRate));
  fee = D.add(fee, D.mul(D.mul(resting, limit), maker));
  const notional = rejected ? D.mul(size, limit) : D.add(cost, D.mul(resting, limit)), total = rejected ? size : D.add(filled, resting);
  const after = req.side === 'buy' ? D.add(before, total) : D.sub(before, total), added = D.max(D.zero, D.sub(D.abs(after), D.abs(before)));
  const perUnit = D.isPos(total) ? D.div(notional, total, 18, 'up') : limit, ref = D.from(s.ticker.mid ?? s.ticker.mark);
  const slip = avg === null ? null : D.div(D.mul(req.side === 'buy' ? D.sub(avg, ref) : D.sub(ref, avg), D.from(10000n)), ref, 4, 'half_even');
  const pos = simAcct.positions().find((p) => p.instrument === s.inst.id);
  let free = D.from(simAcct.accountState(now).freeCollateral);
  if (D.isPos(resting)) {
    const cur = simAcct.state.positions.find((p) => p.instrument === s.inst.id);
    free = freeCollateralAfterOrder({ equity: simAcct.equity(), marginUsed: simAcct.marginUsed(), side: req.side, size: resting, price: limit, leverage: levD, position: cur ? { side: cur.side, size: D.from(cur.size), entryPrice: D.from(cur.entryPrice) } : null, feeRate: maker }).value;
  }
  return { ...base, notional: D.str(notional), initialMargin: D.str(initialMargin(D.mul(added, perUnit), levD)), fee: D.str(fee), avgFillPrice: avg === null ? null : D.str(avg), slippageBps: slip === null ? null : D.str(slip),
    liquidationPrice: pos ? { value: pos.liquidationPrice, source: 'estimate' as const, method: `cross, single-position approximation at a flat maintenance fraction of ${cfg.maintenanceMarginFraction}; position after the immediate fills${D.isPos(resting) ? ' (the resting part is not included)' : ''}; no funding, no fees` } : null,
    freeCollateralAfter: D.str(free), filledSize: D.str(filled), restingSize: D.str(resting), status: order.status, rejectReason: order.rejectReason };
}
function preview(a: Acct, b: any): Outcome {
  const p = prepare(a, b, `preview-${crypto.randomUUID()}`);
  if ('status' in p) return p;
  return { status: 200, json: { risk: p.risk, estimate: estimate(a, p.s, p.req, p.lev), request: p.req, ts: Date.now() } };
}
function place(a: Acct, b: any, key: string | null): Outcome {
  if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) return { status: 400, json: { error: 'idempotency', message: 'an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required' } };
  const existing = a.paper.state.orders.find((o) => o.clientId === key);
  if (existing) return { status: 200, json: { order: existing, fills: a.paper.state.fills.filter((f) => f.clientId === key), idempotent: true } };
  const p = prepare(a, b, key);
  if ('status' in p) return p;
  if (!p.risk.ok) { event(a, 'order_refused', p.risk.code, p.risk.reason, { request: p.req }); return { status: 422, json: { error: p.risk.code, message: p.risk.reason } }; }
  a.paper.state.config.leverageByInstrument[p.s.inst.id] = p.lev;
  const res = a.paper.submit(p.req, p.s.book!, p.s.ticker, Date.now());
  a.updatedAt = Date.now(); snapshot(a);
  return { status: 200, json: { order: res.order, fills: res.fills, idempotent: false } };   // a paper-engine rejection is a 200 with order.status 'rejected'
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
    this.send('status', { status: 'reconnecting', ts: Date.now() });        // the backend's first event, before its upstream subscription is up
    setTimeout(() => { if (this.readyState !== 1 || this.paused) return; this.send('status', { status: 'connected', ts: Date.now() }); this.loop(); }, 150);
  }
  loop = (): void => {
    if (this.readyState !== 1 || this.paused) return;
    const s = this.s;
    if (s && !s.frozen) {
      s.advance();
      this.send('ticker', { ...s.ticker, source: 'venue' });
      if (s.book) this.send('book', { ...s.book, source: 'venue' });
      if (s.fresh.length) { this.send('trades', { instrument: s.inst.id, trades: s.fresh, source: 'venue' }); s.fresh = []; }
    }
    this.timer = setTimeout(this.loop, s?.inst.venue === 'gmx' ? 3000 : 1000 / RATE);   // GMX is polled every 3 s by the backend
  };
  stale(): void { this.paused = true; if (this.timer) clearTimeout(this.timer); this.send('status', { status: 'stale', ts: Date.now() }); }
  drop(): void { this.paused = true; if (this.timer) clearTimeout(this.timer); this.readyState = 0; this.dispatchEvent(new Event('error')); }
  close(): void { this.readyState = 2; if (this.timer) clearTimeout(this.timer); STREAMS.delete(this); }
}

/** controlled live trading (mockLive.ts) on top of the same simulated markets */
const LIVE = createLiveMock({ sim: (id) => sim(id), fresh: (s) => fresh(s as Sim), priceProblem: (venue, tick, p) => HL_SIG(venue, D.from(tick), p),
  worstPrice: (ref, side, bps, tick, venue) => D.str(worstPriceOf(D.from(ref), side, bps, D.from(tick), venue)) });
/** the stream of one venue account: `status` and `account` first, then every event of the account */
class LiveMockStream extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readonly url: string; readonly withCredentials = false;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
  private off: (() => void) | null = null;
  constructor(url: string) {
    super();
    this.url = url;
    setTimeout(() => { if (this.readyState === 2) return; this.readyState = 1; this.dispatchEvent(new Event('open'));
      this.off = LIVE.subscribe(url, (event, data) => { if (this.readyState === 1) this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) })); }); }, 80);
  }
  close(): void { this.readyState = 2; this.off?.(); }
}

// --- router (simulation) ---
const ROUTER = createRouterMock({
  instruments: () => SEEDS.map((s) => s.inst),
  markets: (base) => SEEDS.filter((s) => s.inst.base.toUpperCase() === base).map((sd) => { const s = fresh(sim(sd.inst.id)!); return { inst: s.inst, ticker: s.ticker, book: s.book }; }),
  restriction: (venue) => VENUES.find((v) => v.id === venue)?.restriction ?? null,
  gmxDecimals: (base) => GMX_DECIMALS[base] ?? 18,
  account: (id) => { const a = ACCTS.get(id); if (!a) return null; const v = view(a); return { id: a.id, venue: a.venue, label: a.label, mode: a.policy.mode, equity: v.state.equity, freeCollateral: v.state.freeCollateral, preview: (body) => preview(a, body) }; },
});
// --- /router ---
const json = (status: number, j: unknown): Response => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
const out = (o: Outcome) => json(o.status, o.json);
async function route(method: string, path: string, q: URLSearchParams, b: any, headers: Headers): Promise<Response> {
  const venue = (q.get('venue') || undefined) as VenueId | undefined, now = Date.now();
  if (path === '/auth/state') return json(200, { setupRequired: false, authenticated: true });
  if (path === '/auth/logout') return json(200, {});
  if (path === '/settings') return json(200, { locale: 'fr', currency: 'CAD', hideBalances: false, prices: true });
  if (!path.startsWith('/derivatives')) return json(503, { error: 'mock', message: 'mock mode: only the Futures terminal is simulated' });
  if (path.startsWith('/derivatives/live/')) return out(LIVE.route(method, path, b, headers));
  const p = path.slice('/derivatives'.length);
  const unknown = () => json(404, { error: 'unknown_instrument', message: 'unknown instrument' });
  if (venue && !VENUES.some((v) => v.id === venue)) return json(404, { error: 'unknown_venue', message: `unknown venue ${venue}` });
  if (p === '/venues') return json(200, { venues: VENUES.map((v) => ({ ...v, lastOkAt: now })), bounds: {}, ts: now });
  if (p === '/instruments') return json(200, { instruments: SEEDS.filter((s) => !venue || s.inst.venue === venue).map((s) => s.inst), ts: now, errors: [] });
  if (p === '/tickers') return json(200, { tickers: SEEDS.filter((s) => !venue || s.inst.venue === venue).map((s) => { const live = SIMS.get(s.inst.id); return live ? fresh(live).ticker : { ...s.ticker, ts: now }; }), ts: now, source: 'venue', errors: [] });
  if (p === '/market') { const s = sim(q.get('instrument') ?? ''); if (!s) return unknown(); fresh(s);
    return json(200, { instrument: s.inst, ticker: { ...s.ticker, source: 'venue' }, book: s.book ? { ...s.book, source: 'venue' } : null, liquidity: s.seed.liquidity ? { ...s.seed.liquidity, instrument: s.inst.id, symbol: s.inst.symbol, ts: now, source: 'venue' } : null,
      trades: s.trades.slice(0, 50), errors: {}, ts: now, source: 'venue' }); }
  if (p === '/candles') { const s = sim(q.get('instrument') ?? ''); if (!s) return unknown(); const interval = (q.get('interval') ?? '1h') as Interval;
    return json(200, { instrument: s.inst.id, interval, candles: candles(fresh(s), interval, Math.min(1000, Number(q.get('limit')) || 300)), ts: now, source: 'venue' }); }
  if (p === '/funding') { const s = sim(q.get('instrument') ?? ''); if (!s) return unknown();
    const hours = Math.min(480, Number(q.get('hours')) || 24), r = rng(`${s.inst.id}:f`), base = Number(s.ticker.funding ?? 0), H = 3_600_000, end = Math.floor(now / H) * H;
    return json(200, { instrument: s.inst.id, history: Array.from({ length: hours }, (_, i) => ({ ts: end - (hours - 1 - i) * H, rate: n2sSigned(base * (0.6 + r() * 0.8)) })), intervalSec: s.inst.fundingIntervalSec, ts: now, source: 'venue' }); }
  if (p === '/compare') return json(200, compare(q.get('base') ?? 'BTC'));
  // --- router (simulation): the real router on the mock's markets (mockRouter.ts) ---
  if (p === '/route/assets' && method === 'GET') return out(ROUTER.assets());
  if (p === '/route' && method === 'POST') return out(ROUTER.route(b));
  // --- /router ---
  if (p === '/watch') {
    const acct = q.get('account') ?? '';
    if (venue === 'dydx') return json(403, { error: 'venue_restricted', message: DYDX_RESTRICTION });
    if (!/^0x[0-9a-fA-F]{40}$/.test(acct)) return json(400, { error: 'bad_account', message: 'an account is a 20-byte hex address' });
    return json(200, watch(acct, venue ?? 'hyperliquid'));
  }
  if (p === '/accounts' && method === 'GET') return json(200, { accounts: [...ACCTS.values()].map(view), ts: now });
  if (p === '/accounts' && method === 'POST') {
    const v = VENUES.find((x) => x.id === b?.venue);
    if (!v) return json(404, { error: 'unknown_venue', message: 'unknown venue' });
    if (v.restriction) return json(403, { error: 'venue_restricted', message: v.restriction });
    if (!v.paper) return json(422, { error: 'paper_unsupported', message: `${v.name} has no order book: the paper engine fills against a live book, so no paper account is offered on this venue` });
    if (typeof b.label !== 'string' || !b.label.trim() || !D.isValid(b.collateral) || D.lt(D.from(b.collateral), D.from(10n)) || D.gt(D.from(b.collateral), D.from(1_000_000_000n))) return json(400, { error: 'bad_request', message: 'collateral must be between 10 and 1000000000' });
    if (ACCTS.size >= 20) return json(422, { error: 'too_many_accounts', message: 'at most 20 paper accounts' });
    return json(200, detail(createAcct(v.id, b.label.trim().slice(0, 60), b.collateral, b.policy)));
  }
  const m = /^\/accounts\/([^/]+)(\/.*)?$/.exec(p);
  const a = m ? ACCTS.get(decodeURIComponent(m[1]!)) : undefined;
  if (!m || !a) return json(404, { error: 'unknown_account', message: 'unknown derivatives account' });
  const rest = m[2] ?? '', key = headers.get('idempotency-key');
  if (rest === '' && method === 'GET') return json(200, detail(a));
  if (rest === '/policy') {
    if (b.mode !== 'PAPER' && b.mode !== 'READ_ONLY') return json(422, { error: 'live_not_available', message: 'a paper account can only be PAPER or READ_ONLY: live trading does not exist in this delivery' });
    a.policy = b as RiskPolicy; a.updatedAt = now; return json(200, detail(a));
  }
  if (rest === '/orders/preview') return out(preview(a, b));
  if (rest === '/orders') return out(place(a, b, key));
  const c = /^\/orders\/([^/]+)\/cancel$/.exec(rest);
  if (c) { const r = a.paper.cancel(decodeURIComponent(c[1]!), now); a.updatedAt = now; return r.order ? json(200, { order: r.order }) : json(404, { error: 'unknown_order', message: 'unknown order' }); }
  if (rest === '/close') {
    const s = sim(String(b.instrument)), pos = a.paper.positions().find((x) => x.instrument === b.instrument);
    if (!s || !pos || !s.book) return json(422, { error: 'no_position', message: `no position on ${b.instrument}` });
    fresh(s);
    const lot = D.from(s.inst.lotSize), fr = D.from(String(b.fraction)), bps = typeof b.slippageBps === 'number' ? b.slippageBps : 50;
    const size = D.gte(fr, D.one) ? D.from(pos.size) : D.quantize(D.mul(D.from(pos.size), fr), lot, 'down');
    if (!D.isPos(size)) return json(422, { error: 'below_min_size', message: 'the fraction is smaller than one lot' });
    const side = pos.side === 'long' ? 'sell' as const : 'buy' as const, best = side === 'buy' ? s.book.asks[0] : s.book.bids[0];
    if (!best) return json(503, { error: 'no_liquidity', message: 'the book has no level on that side' });
    const worst = D.str(worstPriceOf(D.from(best[0]), side, bps, D.from(s.inst.tickSize), s.inst.venue));
    const r = place(a, { instrument: b.instrument, side, type: 'market', size: D.str(size), price: worst, triggerPrice: null, reduceOnly: true, tif: 'ioc' }, key ?? crypto.randomUUID());
    return json(r.status, r.status === 200 ? { ...r.json, worstPrice: worst, slippageBoundBps: bps } : r.json);
  }
  if (rest === '/reset') {
    const hadHalt = a.policy.halt;
    a.paper = PaperAccount.create({ venue: a.venue, account: a.paper.state.account, collateral: a.initial, config: { ...a.paper.state.config, leverageByInstrument: {} } });
    a.equity = []; a.policy = { ...a.policy, halt: null }; a.updatedAt = now;
    event(a, 'reset', null, `paper account reset: positions, orders and history wiped, collateral restored to ${a.initial}${hadHalt ? '; halt released' : ''}`, { haltReleased: hadHalt });
    snapshot(a, true);
    return json(200, detail(a));
  }
  return json(404, { error: 'not_found', message: 'unknown route' });
}
function n2sSigned(n: number): string { const s = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; }
/** a recorded Hyperliquid account (clearinghouseState fixture), mapped to the normalised models */
function watch(account: string, venue: VenueId) {
  const now = Date.now();
  if (venue !== 'hyperliquid') return { venue, account, state: { venue, account, equity: '0', collateral: '0', freeCollateral: '0', marginUsed: '0', maintenanceMargin: null, withdrawable: '0', ts: now, source: 'venue' }, positions: [], openOrders: [], ts: now, source: 'venue' };
  const st = body(hlStateRaw) as any;
  const positions: Position[] = (st.assetPositions as any[]).map(({ position: p }) => {
    const szi = D.from(String(p.szi)), size = D.abs(szi), mark = D.isPos(size) ? D.div(D.from(p.positionValue), size, 6, 'half_even') : D.from(p.entryPx);
    return { instrument: `hyperliquid:${p.coin}`, side: D.isNeg(szi) ? 'short' : 'long', size: D.str(size), entryPrice: D.str(D.from(p.entryPx)), markPrice: D.str(mark), liquidationPrice: p.liquidationPx ? D.str(D.div(D.from(p.liquidationPx), D.one, 4, 'half_even')) : null,
      leverage: String(p.leverage.value), marginMode: p.leverage.type === 'isolated' ? 'isolated' : 'cross', margin: p.marginUsed, unrealizedPnl: p.unrealizedPnl, realizedPnl: null, fundingPaid: p.cumFunding?.sinceOpen ?? null, source: 'venue' };
  });
  const eq = D.from(st.marginSummary.accountValue), used = D.from(st.marginSummary.totalMarginUsed);
  return { venue, account, state: { venue, account, equity: D.str(eq), collateral: st.marginSummary.totalRawUsd, freeCollateral: D.str(D.sub(eq, used)), marginUsed: D.str(used), maintenanceMargin: st.crossMaintenanceMarginUsed ?? null, withdrawable: st.withdrawable ?? null, ts: now, source: 'venue' },
    positions, openOrders: [], ts: now, source: 'venue' };
}

declare global { interface Window { __spwMock?: { setRate: (n: number) => void; stale: () => void; reconnect: () => void; resume: () => void; accounts: () => number; live: LiveHooks } } }

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
    const url = String(args[0]);
    if (LIVE.isStream(url)) return new LiveMockStream(url) as unknown as EventSource;
    return url.includes('/api/v1/derivatives/stream') ? (new MockStream(url) as unknown as EventSource) : new target(...args);
  } });
  setInterval(worker, 1000);
  setInterval(LIVE.step, 1000);
  LIVE.installPasskey();
  if (q.get('mainnet') === '1') LIVE.hooks.mainnet(true);   // `&mainnet=1`: the simulated server setting SPW_DERIV_LIVE_MAINNET starts on
  const freeze = (v: boolean) => { for (const s of SIMS.values()) s.frozen = v; };
  window.__spwMock = {
    setRate: (n) => { RATE = Math.max(1, Math.min(60, n)); },
    stale: () => { freeze(true); for (const s of STREAMS) s.stale(); },
    reconnect: () => { freeze(true); for (const s of STREAMS) s.drop(); setTimeout(() => { freeze(false); for (const s of STREAMS) s.up(); }, 2500); },
    resume: () => { freeze(false); for (const s of STREAMS) s.up(); },
    accounts: () => ACCTS.size,
    live: LIVE.hooks,
  };
  console.info('[SP Wallet] mock mode: derivatives API simulated in the browser from recorded fixtures — no backend, no venue.');
}

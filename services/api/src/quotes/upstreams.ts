// Quote hub — where the data comes from, venue by venue (docs/V11-QUOTE-ENGINE.md §2). PUBLIC market data only.
//
//   hyperliquid  websocket wss://api.hyperliquid.xyz/ws — activeAssetCtx (mark, oracle, funding, open interest), bbo, l2Book,
//                trades, candle; the main dex and the builder-deployed dexes (`dex:COIN`) alike. One connection owned by the hub.
//   edgex        websocket of the venue through the adapter (ticker.{id}, depth.{id}.15, trades.{id}); candles: REST polling.
//   dydx         indexer websocket wss://indexer.dydx.trade/v4/ws through the adapter (v4_markets, v4_orderbook, v4_trades); candles: REST polling.
//   gmx          NO public stream exists: REST polling of the oracle tickers through the derivatives data service (per-venue budget, last-good cache).
//   spot         Coinbase Exchange websocket wss://ws-feed.exchange.coinbase.com (channel `ticker`, public, no key) for the symbols
//                Coinbase lists against USD; any other wallet symbol: polling of the wallet's existing price module (CoinGecko), with its own date.
//
// Heartbeats, reconnection with backoff + jitter, resubscription and gap events are those of each client: createHlStream,
// EdgeXStream and DydxStream (packages/derivatives) and createReconnectingWs (ws-client.ts) for Coinbase.
import { MARKET_LISTINGS } from '@spw/core';
import { D, createHlStream, type Book, type DecStr, type HlStream, type HlStreamEvent, type Instrument, type PublicTrade, type Ticker, type VenueId } from '@spw/derivatives';
import type { DerivData } from '../derivatives/data.ts';
import type { FeedInfo, FeedSpec, Interval, QuotePatch, TradeRow, UpStatus, Upstream, UpstreamSink } from './hub.ts';
import { createReconnectingWs, type ReconnectingWs, type WsCtor } from './ws-client.ts';
import type { Level } from './shared.ts';

/** a quote older than this is stale, per source — from how often each source really sends (measured, docs/v11/work/quotes.md) */
export const QUOTE_CADENCE_MS = { 'hyperliquid-ws': 15_000, 'edgex-ws': 15_000, 'dydx-ws': 60_000, 'gmx-rest': 20_000, 'coinbase-ws': 30_000, 'coingecko-rest': 15 * 60_000 } as const;
export const POLL_MS = { gmxTickers: 3_000, candles: 10_000, gecko: 60_000 } as const;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const tradeRows = (t: PublicTrade[]): TradeRow[] => t.map((x) => ({ id: x.id, price: x.price, size: x.size, side: x.side, ts: x.ts }));
const tickerPatch = (t: Ticker): QuotePatch => ({ mark: t.mark, index: t.index, mid: t.mid, funding: t.funding, openInterest: t.openInterest, change24h: t.change24h, volume24h: t.volume24h,
  ...(t.last !== undefined ? { last: t.last } : {}), venueTs: null });   // Ticker.ts is the time of receipt on every venue: none of them stamps its ticker
const bookLevels = (b: Book): { bids: Level[]; asks: Level[] } => ({ bids: b.bids, asks: b.asks });
/** canonical decimal string of a venue's number-as-text ("65053.4500" → "65053.45"); throws on anything else */
const dec = (x: unknown): DecStr => { if (typeof x !== 'string' || !/^-?\d+(\.\d+)?$/.test(x)) throw new Error('not a decimal'); return D.str(D.from(x)); };

/** candles of a venue that streams none: the bar in progress is re-read over REST (cached reads of the data service) */
function pollCandles(data: DerivData, id: string, interval: Interval, sink: UpstreamSink, everyMs: number): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      const inst = await data.instrument(id), c = await data.candles(inst, interval, 2);
      if (stopped) return;
      for (const k of c.value) sink.candle(k);
    } catch (e) { if (!stopped) sink.error(`candles: ${msg(e)}`); }
  };
  const h = setInterval(() => { void tick(); }, everyMs);
  h.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(h); };
}

// ---------------------------------------------------------------------------------------------------------------- Hyperliquid
export interface HyperliquidUpstreamOptions {
  data: DerivData;
  /** the hub's own connection; tests pass a stream built on a scripted WebSocket */ stream?: HlStream;
  /** builder-dex coins (`xyz:ANT`) that exist and are not delisted; absent = builder coins are refused */
  builderCoins?: () => Promise<Map<string, { isDelisted: boolean }>>;
  now?: () => number;
}
export function hyperliquidUpstream(o: HyperliquidUpstreamOptions): Upstream {
  const stream = o.stream ?? createHlStream({ network: 'mainnet', ...(o.now ? { now: o.now } : {}) });
  const info: FeedInfo = { source: 'hyperliquid-ws', transport: 'stream', staleAfterMs: QUOTE_CADENCE_MS['hyperliquid-ws'] };
  let builder: { at: number; coins: Map<string, { isDelisted: boolean }> } | null = null;
  return {
    venue: 'hyperliquid',
    feedsFor: (type, symbol, interval) => (type === 'quote' ? [{ kind: 'ticker', symbol }, { kind: 'bbo', symbol }] : type === 'book' ? [{ kind: 'book', symbol }] : type === 'trades' ? [{ kind: 'trades', symbol }] : [{ kind: 'candle', symbol, interval }]),
    info: () => info,
    async known(symbol) {
      if (symbol.includes(':')) {
        if (!o.builderCoins) return false;
        if (!builder || Date.now() - builder.at > 300_000) builder = { at: Date.now(), coins: await o.builderCoins() };
        const c = builder.coins.get(symbol);
        return !!c && !c.isDelisted;
      }
      return (await o.data.instruments('hyperliquid')).value.some((i) => i.symbol === symbol);
    },
    open(feed, sink, onStatus) {
      const on = (raw: unknown): void => {
        const ev = raw as HlStreamEvent;
        switch (ev.type) {
          case 'ticker': sink.quote(tickerPatch(ev.ticker)); return;
          case 'bbo': sink.quote({ bid: ev.bid?.[0] ?? null, bidSize: ev.bid?.[1] ?? null, ask: ev.ask?.[0] ?? null, askSize: ev.ask?.[1] ?? null, venueTs: ev.ts }); return;
          case 'book': sink.book({ ...bookLevels(ev.book), venueTs: ev.book.ts }); return;
          case 'trades': sink.trades(tradeRows(ev.trades)); return;
          case 'candle': sink.candle(ev.candle); return;
          case 'gap': sink.gap(ev.reason); return;
          case 'invalid': sink.error(`${ev.channel}: ${ev.reason}`); return;
          default: return;
        }
      };
      const sub = feed.kind === 'candle' ? { type: 'candle' as const, symbol: feed.symbol, interval: feed.interval ?? '1m' } : { type: feed.kind, symbol: feed.symbol };
      return stream.subscribe(sub, on, onStatus);
    },
    stats: () => stream.stats(),
    close: () => stream.close(),
  };
}

// ---------------------------------------------------------------------------------------------------------------- edgeX, dYdX, GMX
export interface VenueUpstreamOptions { venue: VenueId; data: DerivData; pollMs?: number; candlePollMs?: number }
/**
 * A venue read through its adapter of the derivatives registry: its websocket when the adapter has one (edgeX, dYdX — the
 * adapter owns ONE connection, shared with the rest of the service), REST polling of the cached tickers otherwise (GMX).
 */
export function venueUpstream(o: VenueUpstreamOptions): Upstream {
  const { venue, data } = o, entry = data.registry.get(venue), adapter = entry.adapter;
  const streaming = !!adapter.stream && adapter.capabilities.stream, hasBook = entry.facts.hasOrderBook;
  const ws: FeedInfo = { source: `${venue}-ws`, transport: 'stream', staleAfterMs: QUOTE_CADENCE_MS[`${venue}-ws` as keyof typeof QUOTE_CADENCE_MS] ?? 30_000 };
  const rest: FeedInfo = { source: `${venue}-rest`, transport: 'poll', staleAfterMs: QUOTE_CADENCE_MS[`${venue}-rest` as keyof typeof QUOTE_CADENCE_MS] ?? 30_000 };
  const pollMs = o.pollMs ?? POLL_MS.gmxTickers, candleMs = o.candlePollMs ?? POLL_MS.candles;

  // polled tickers: ONE loop per venue while a ticker feed is open; one cached read gives every market of the venue
  const polled = new Map<string, { sink: UpstreamSink; onStatus: (s: UpStatus, d?: string) => void; last: string }>();
  let timer: ReturnType<typeof setInterval> | null = null, failures = 0;
  const poll = async (): Promise<void> => {
    try {
      const all = await data.tickers(venue);
      failures = 0;
      for (const [symbol, p] of polled) {
        p.onStatus(all.stale ? 'stale' : 'connected', all.stale ? 'served from the last good read' : undefined);
        const t = all.value.find((x) => x.instrument === `${venue}:${symbol}`);
        if (!t || all.stale) continue;                    // no data → no message
        const sig = `${t.mark}|${t.index}|${t.funding}|${t.openInterest}|${t.ts}`;
        if (sig === p.last) continue;
        p.last = sig; p.sink.quote(tickerPatch(t));
      }
    } catch (e) { failures += 1; for (const p of polled.values()) { p.sink.error(`tickers: ${msg(e)}`); p.onStatus(failures >= 3 ? 'down' : 'stale', msg(e)); } }
  };

  return {
    venue,
    feedsFor(type, symbol, interval) {
      if (type === 'quote') return [{ kind: 'ticker', symbol }];
      if (type === 'candle') return [{ kind: 'candle', symbol, interval }];
      if (!streaming) return [];                           // GMX: no book, no public trade feed
      if (type === 'book') return hasBook ? [{ kind: 'book', symbol }] : [];
      return [{ kind: 'trades', symbol }];
    },
    info: (feed) => (feed.kind === 'candle' || !streaming ? rest : ws),
    known: async (symbol) => (await data.instruments(venue)).value.some((i: Instrument) => i.symbol === symbol),
    open(feed, sink, onStatus) {
      if (feed.kind === 'candle') return pollCandles(data, `${venue}:${feed.symbol}`, feed.interval ?? '1m', sink, candleMs);
      if (!streaming) {
        polled.set(feed.symbol, { sink, onStatus, last: '' });
        if (!timer) { timer = setInterval(() => { void poll(); }, pollMs); timer.unref?.(); }
        void poll();
        return () => { polled.delete(feed.symbol); if (polled.size === 0 && timer) { clearInterval(timer); timer = null; } };
      }
      const on = (raw: unknown): void => {
        const ev = raw as { type?: string; ticker?: Ticker; book?: Book; trades?: PublicTrade[]; snapshot?: boolean; crossed?: boolean; reason?: unknown; message?: unknown };
        if (ev.type === 'ticker' && ev.ticker) sink.quote(tickerPatch(ev.ticker));
        else if (ev.type === 'book' && ev.book) {
          // dYdX's indexer can publish a crossed book for a moment: it is not a book anybody can read a price from — skipped, never repaired
          if (ev.crossed) { sink.error('crossed book skipped'); return; }
          sink.book({ ...bookLevels(ev.book), venueTs: null, ...(ev.snapshot ? { resync: true } : {}) });   // these books are stamped at receipt
        } else if (ev.type === 'trades' && ev.trades?.length) sink.trades(tradeRows(ev.trades));
        else if (ev.type === 'gap') sink.gap(String(ev.reason ?? 'gap'));
        else if (ev.type === 'invalid' || ev.type === 'error') sink.error(String(ev.reason ?? ev.message ?? 'stream error'));
      };
      return adapter.stream!({ type: feed.kind as 'ticker' | 'book' | 'trades', symbol: feed.symbol }, on, onStatus);
    },
    stats: () => ({ transport: streaming ? 'stream' : 'poll', polled: polled.size, pollFailures: failures }),
    close: () => { if (timer) { clearInterval(timer); timer = null; } polled.clear(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------- spot
export type SpotPrices = () => Promise<Record<string, { usd: number; priceAt?: string | null; stale?: boolean; change24h?: number | null }> | null>;
export interface SpotUpstreamOptions {
  /** the wallet's existing price module (server.ts `markets()`, CoinGecko): used for the symbols Coinbase does not list */ prices?: SpotPrices;
  WebSocket?: WsCtor; url?: string; now?: () => number; random?: () => number; backoffMinMs?: number; backoffMaxMs?: number; staleAfterMs?: number; staleGraceMs?: number;
  /** symbol → Coinbase product id; default: the generated listing table of @spw/core */ pairs?: (symbol: string) => string | undefined;
  geckoPollMs?: number;
}
export const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
/**
 * Spot prices in USD. Coinbase Exchange `ticker` channel (https://docs.cdp.coinbase.com/exchange/websocket-feed/channels —
 * public, no authentication; a `heartbeat` channel proves the feed is alive when a product does not trade) for the symbols it
 * lists; the wallet's own price module, polled, for the rest. The source is named on every quote.
 */
export function spotUpstream(o: SpotUpstreamOptions = {}): Upstream {
  const now = o.now ?? Date.now;
  const pairOf = o.pairs ?? ((s: string): string | undefined => (Object.hasOwn(MARKET_LISTINGS, s) ? MARKET_LISTINGS[s]!.coinbase : undefined));
  const cb: FeedInfo = { source: 'coinbase-ws', transport: 'stream', staleAfterMs: QUOTE_CADENCE_MS['coinbase-ws'] };
  const gk: FeedInfo = { source: 'coingecko-rest', transport: 'poll', staleAfterMs: QUOTE_CADENCE_MS['coingecko-rest'] };
  const live = new Map<string, { symbol: string; sink: UpstreamSink; onStatus: (s: UpStatus, d?: string) => void }>();   // by product id
  const polled = new Map<string, { sink: UpstreamSink; onStatus: (s: UpStatus, d?: string) => void; last: string }>();
  let ws: ReconnectingWs | null = null, timer: ReturnType<typeof setInterval> | null = null, wsStatus: UpStatus = 'reconnecting';
  const st = { tickers: 0, heartbeats: 0, invalid: 0, errors: 0 };

  const socket = (): ReconnectingWs => (ws ??= createReconnectingWs({
    url: o.url ?? COINBASE_WS, WebSocket: o.WebSocket, now: o.now, random: o.random,
    ...(o.backoffMinMs !== undefined ? { backoffMinMs: o.backoffMinMs } : {}), ...(o.backoffMaxMs !== undefined ? { backoffMaxMs: o.backoffMaxMs } : {}),
    ...(o.staleAfterMs !== undefined ? { staleAfterMs: o.staleAfterMs } : {}), ...(o.staleGraceMs !== undefined ? { staleGraceMs: o.staleGraceMs } : {}),
    onOpen: (again) => {
      if (live.size) ws!.send({ type: 'subscribe', product_ids: [...live.keys()], channels: ['ticker', 'heartbeat'] });
      if (again) for (const l of live.values()) l.sink.gap('reconnected');
    },
    onStatus: (s) => { wsStatus = s; for (const l of live.values()) l.onStatus(s); },
    onMessage: (text) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(text) as Record<string, unknown>; } catch { st.invalid += 1; return; }
      if (m.type === 'heartbeat') { st.heartbeats += 1; return; }
      if (m.type === 'error') { st.errors += 1; for (const l of live.values()) l.sink.error(`coinbase: ${String(m.message ?? 'error')} ${String(m.reason ?? '')}`.trim()); return; }
      if (m.type !== 'ticker' || typeof m.product_id !== 'string') return;
      const l = live.get(m.product_id);
      if (!l) return;
      try {
        const last = dec(m.price), open = typeof m.open_24h === 'string' ? D.from(dec(m.open_24h)) : null, t = typeof m.time === 'string' ? Date.parse(m.time) : NaN;
        st.tickers += 1;
        l.sink.quote({ bid: dec(m.best_bid), bidSize: dec(m.best_bid_size), ask: dec(m.best_ask), askSize: dec(m.best_ask_size), last,
          change24h: open && !D.isZero(open) ? D.str(D.div(D.sub(D.from(last), open), open, 6, 'half_even')) : null, venueTs: Number.isFinite(t) ? t : null });
      } catch { st.invalid += 1; l.sink.error('coinbase: a ticker failed validation and was dropped'); }
    },
  }));

  const pollGecko = async (): Promise<void> => {
    if (!o.prices) return;
    try {
      const px = await o.prices();
      // the venue status of `spot` is the websocket's while it carries a symbol; the polled symbols carry their own `stale` date
      const report = live.size === 0;
      for (const [symbol, p] of polled) {
        const m = px?.[symbol];
        if (!m || !Number.isFinite(m.usd) || !(m.usd > 0)) { if (report) p.onStatus('stale', 'no price from the price module'); continue; }   // no data → no message
        if (report) p.onStatus(m.stale ? 'stale' : 'connected', m.stale ? 'the price module serves an old price' : undefined);
        const at = m.priceAt ? Date.parse(m.priceAt) : NaN, sig = `${m.usd}|${m.priceAt}`;
        if (sig === p.last) continue;
        p.last = sig;
        // a float of the price module as a decimal string (market data, never an amount of custody)
        p.sink.quote({ last: D.str(D.from(m.usd.toFixed(m.usd < 1 ? 10 : 6))), change24h: typeof m.change24h === 'number' && Number.isFinite(m.change24h) ? D.str(D.from((m.change24h / 100).toFixed(6))) : null, venueTs: Number.isFinite(at) ? at : null });
      }
    } catch (e) { for (const p of polled.values()) { p.sink.error(`prices: ${msg(e)}`); p.onStatus('stale', msg(e)); } }
  };

  return {
    venue: 'spot',
    feedsFor: (type, symbol) => (type === 'quote' ? [{ kind: 'ticker', symbol }] : []),
    info: (feed: FeedSpec) => (pairOf(feed.symbol) ? cb : gk),
    async known(symbol) {
      if (pairOf(symbol)) return true;
      if (!o.prices) return false;
      const px = await o.prices();
      return !!px && Object.hasOwn(px, symbol);
    },
    open(feed, sink, onStatus) {
      const pair = pairOf(feed.symbol);
      if (pair) {
        live.set(pair, { symbol: feed.symbol, sink, onStatus });
        const s = socket();
        s.start();
        if (s.open) { s.send({ type: 'subscribe', product_ids: [pair], channels: ['ticker', 'heartbeat'] }); onStatus(wsStatus); }
        return () => {
          live.delete(pair);
          s.send({ type: 'unsubscribe', product_ids: [pair], channels: ['ticker', 'heartbeat'] });
          if (live.size === 0) { s.stop(); wsStatus = 'reconnecting'; }
        };
      }
      polled.set(feed.symbol, { sink, onStatus, last: '' });
      if (!timer) { timer = setInterval(() => { void pollGecko(); }, o.geckoPollMs ?? POLL_MS.gecko); timer.unref?.(); }
      void pollGecko();
      return () => { polled.delete(feed.symbol); if (polled.size === 0 && timer) { clearInterval(timer); timer = null; } };
    },
    stats: () => ({ coinbase: { ...(ws ? ws.stats() : { status: 'idle' }), products: live.size, ...st }, polled: polled.size, at: now() }),
    close: () => { ws?.stop(); if (timer) { clearInterval(timer); timer = null; } live.clear(); polled.clear(); },
  };
}

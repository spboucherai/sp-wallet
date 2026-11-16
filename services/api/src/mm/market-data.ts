// `MarketDataPort` of the market-making engine over a small SOURCE interface, with freshness guards.
//
// `BookSource` is everything the engine's market data needs from the rest of the service: the last top of book of an instrument
// as the venue's stream delivered it, when it was received, and the status of that stream. Today the source is the venue's own
// WebSocket through the Hyperliquid adapter (`hlBookSource`: the `l2Book` subscription of the stream client, per network) or
// the stream engine's market state (`StreamEngine.bookSource`). THE COMING QUOTE HUB REPLACES THE SOURCE, NOT THE PORT: it only
// has to implement `BookSource` (docs/V11-MARKET-MAKING.md, "Market data").
//
// Guards, all fail-closed (a status other than `connected` trips the engine's `venue_disconnected` breaker, which pulls quotes):
//   - a stream that is not `connected` is reported as it is, and its last book is NOT served;
//   - a book received more than `maxAgeMs` ago is `stale` (a connection that stalls keeps its last book for ever);
//   - the book's timestamp given to the engine is the OLDER of the venue's own and the time of receipt, so that the engine's
//     `data_stale` breaker sees the worse of the two ages;
//   - a one-sided or crossed top is passed as it is: the engine's `book_crossed` breaker judges it;
//   - the status of the USER stream of the session (orders and fills) is folded in: a session that cannot see its own orders
//     does not quote.
import type { Book } from '@spw/derivatives';
import type { BookTop } from '@spw/trading/mm';
import type { MarketDataPort, MarketSnapshot, VenueStatus } from './ports.ts';

export interface BookRead { status: VenueStatus; /** best bid / ask with sizes; null before the first book */ top: { bid: string; bidSize: string; ask: string; askSize: string } | null; /** the venue's own timestamp of that book, and when this process received it (unix ms) */ venueTs: number; receivedAt: number;
  /** funding of the instrument when the source has a ticker: rate per interval, the mark, and when it was received */ funding?: { rate: string; mark: string; receivedAt: number } | null }
export interface BookSource { read(instrument: string): BookRead | null; /** stop listening to an instrument nobody quotes any more */ release?(instrument: string): void }

const worst = (a: VenueStatus, b: VenueStatus): VenueStatus => { const rank: Record<VenueStatus, number> = { connected: 0, stale: 1, reconnecting: 2, idle: 3 }; return rank[a] >= rank[b] ? a : b; };
export function marketDataPort(source: BookSource, o: { now: () => number; maxAgeMs: number; userStatus?: () => VenueStatus | null }): MarketDataPort {
  return {
    snapshot(instrument): MarketSnapshot {
      const r = source.read(instrument), user = o.userStatus?.() ?? null;
      if (!r) return { status: 'idle', book: null };
      let status = r.status;
      const now = o.now();
      if (status === 'connected' && r.top && now - r.receivedAt > o.maxAgeMs) status = 'stale';
      if (user !== null) status = worst(status, user);
      if (!r.top || r.status !== 'connected') return { status, book: null };
      const book: BookTop = { bid: r.top.bid, bidSize: r.top.bidSize, ask: r.top.ask, askSize: r.top.askSize, ts: Math.min(r.venueTs || r.receivedAt, r.receivedAt) };
      return { status, book };
    },
  };
}

/** A `BookSource` over any subscription that delivers books and a status: the Hyperliquid stream client (`adapter.stream`), per network. */
export function subscribingBookSource(subscribe: (symbol: string, onBook: (b: Book) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void) => () => void, now: () => number): BookSource & { close(): void } {
  const markets = new Map<string, { read: BookRead; stop: () => void }>();
  const symbolOf = (instrument: string): string => instrument.slice(instrument.indexOf(':') + 1);
  return {
    read(instrument) {
      let m = markets.get(instrument);
      if (!m) {
        const read: BookRead = { status: 'idle', top: null, venueTs: 0, receivedAt: 0 };
        const stop = subscribe(symbolOf(instrument), (b) => { const bid = b.bids[0], ask = b.asks[0]; read.top = bid && ask ? { bid: bid[0], bidSize: bid[1], ask: ask[0], askSize: ask[1] } : null; read.venueTs = b.ts; read.receivedAt = now(); },
          (s) => { if (s !== 'connected' && read.status === 'connected') read.top = null; read.status = s; });   // whatever was held may be wrong after a gap: wait for the next book
        m = { read, stop }; markets.set(instrument, m);
      }
      return m.read;
    },
    release(instrument) { const m = markets.get(instrument); if (m) { m.stop(); markets.delete(instrument); } },
    close() { for (const m of markets.values()) m.stop(); markets.clear(); },
  };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/market-data.ts
 * Module           : mm
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-17
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

// `MarketDataPort` of the market-making engine over a small SOURCE interface, with freshness guards.
//
// `BookSource` is everything the engine's market data needs from the rest of the service: the last top of book of an instrument
// as the venue's stream delivered it, when it was received, and the status of that stream. The source is the venue's own
// WebSocket through the Hyperliquid adapter: its BEST BID / OFFER channel (`bboBookSource`, per network). THE COMING QUOTE HUB
// REPLACES THE SOURCE, NOT THE PORT: it only has to implement `BookSource` (docs/V11-MARKET-MAKING.md, "Market data").
//
// V11 final validation — why `bbo` and not the order book. Until then the source on mainnet was the stream engine's market state,
// fed by the venue's `l2Book` channel, and on testnet the same channel of the testnet client. Measured on 2026-11-17 on BTC: that
// channel delivers a book every 12.3 s (median; 9 in 90 s). With the default freshness bound of 5 s and the breakers' 15 s
// cool-down, a session on real data was `pulled` for good a few seconds after its start: in a 30-minute paper soak it placed ONE
// quote batch. (The tests replay recorded books and stamp one every second; nothing had watched a session on the real feed for
// more than a minute.) The `bbo` channel speaks about ten times a second and is what a quoting engine needs: the top of the book.
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

/** the adapter's `stream` function, as much of it as a book source needs */
export type VenueStreamFn = (sub: { type: 'bbo'; symbol: string }, on: (ev: unknown) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void) => () => void;
/**
 * The top of the book from the venue's best-bid / offer channel. A one-sided top is passed as `null` (the port then serves no
 * book and the engine's `data_stale` breaker pulls): a quote is never priced from half a book. `ts` is the venue's own time.
 */
export function bboBookSource(stream: VenueStreamFn, now: () => number): BookSource & { close(): void } {
  return subscribingBookSource((symbol, onBook, onStatus) => stream({ type: 'bbo', symbol }, (ev) => {
    const e = ev as { type?: string; symbol?: string; bid?: [string, string] | null; ask?: [string, string] | null; ts?: number };
    if (e.type !== 'bbo' || e.symbol !== symbol) return;
    onBook({ instrument: `hyperliquid:${symbol}`, bids: e.bid ? [e.bid] : [], asks: e.ask ? [e.ask] : [], ts: e.ts ?? now() } as Book);
  }, onStatus), now);
}
/** `top` (and its times, and the status) from one source, `funding` from another that has a ticker — the stream engine's market state */
export function withFundingFrom(top: BookSource, funding: BookSource): BookSource {
  return { read: (instrument) => { const r = top.read(instrument); return r ? { ...r, funding: r.funding ?? funding.read(instrument)?.funding ?? null } : null; },
    ...(top.release ? { release: (instrument: string) => top.release!(instrument) } : {}) };
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

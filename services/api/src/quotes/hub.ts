// Quote hub — ONE in-process fan-out of live public market data (docs/V11-QUOTE-ENGINE.md).
//
// READ-ONLY. The hub subscribes to public market-data feeds and hands normalised messages to its listeners. It holds no
// account, no key and no signer; nothing in this directory can place, sign or cancel anything.
//
//   listener ──subscribe(channel)──▶ Chan (type|id|param) ──needs──▶ Feed (venue|kind|symbol) ──open──▶ Upstream (one per venue)
//
// - Reference counting on both levels: a feed is opened by the first channel that needs it and closed with the last one;
//   a channel without listener is kept for `idleGraceMs` (a page change must not cost a venue subscription), then released.
// - Reconnection, heartbeats and resubscription belong to each upstream (upstreams.ts, ws-client.ts and the venue stream
//   clients of @spw/derivatives). The hub turns their statuses into ONE status per venue and escalates a venue that does not
//   come back to `down`.
// - Isolation: every upstream call and every listener call is wrapped; a venue that throws, hangs or floods costs the others nothing.
// - Never a fabricated price: a quote is the newest fields the source sent, merged; a field the source does not publish is
//   null; nothing is interpolated or carried over from another venue. No data → no message, and a status.
// - Bounded memory: `maxChannels`, 50 trades and one book per channel, one quote per channel.
import { D, type DecStr } from '@spw/derivatives';
import type { BookMsg, CandleMsg, Channel, DataMessage, QuoteErrorCode, QuoteMsg, StatusMsg, TradeMsg } from './protocol.ts';
import { bookChecksum, channelKey, diffLevels, QUOTE_PROTOCOL_VERSION as V, type Level } from './shared.ts';

export type Interval = NonNullable<Channel['interval']>;
export type UpStatus = 'connected' | 'reconnecting' | 'stale' | 'down';
export type FeedKind = 'ticker' | 'bbo' | 'book' | 'trades' | 'candle';
export interface FeedSpec { kind: FeedKind; symbol: string; interval?: Interval }
export interface FeedInfo { /** e.g. `hyperliquid-ws` */ source: string; transport: 'stream' | 'poll'; /** a value older than this is stale */ staleAfterMs: number }
/** the fields of a quote a source may send; `undefined` = not in this update (the previous value stands), `null` = the source says there is none */
export interface QuotePatch {
  bid?: DecStr | null; bidSize?: DecStr | null; ask?: DecStr | null; askSize?: DecStr | null; mid?: DecStr | null; mark?: DecStr | null; index?: DecStr | null; last?: DecStr | null;
  funding?: DecStr | null; openInterest?: DecStr | null; change24h?: DecStr | null; volume24h?: DecStr | null;
  /** the venue's own time of this update; null when it gives none */ venueTs: number | null;
}
export interface TradeRow { id: string; price: DecStr; size: DecStr; side: 'buy' | 'sell'; ts: number }
export interface CandleRow { ts: number; open: DecStr; high: DecStr; low: DecStr; close: DecStr; volume: DecStr }
export interface UpstreamSink {
  quote(p: QuotePatch): void;
  /** the WHOLE book, best first; `resync` = the source restarted from a snapshot (the next message to clients is a snapshot) */
  book(b: { bids: Level[]; asks: Level[]; venueTs: number | null; resync?: boolean }): void;
  trades(t: TradeRow[]): void;
  candle(c: CandleRow): void;
  /** something may have been missed: books restart from a snapshot */
  gap(reason: string): void;
  error(message: string): void;
}
/** one venue's public market data. Implementations: upstreams.ts. */
export interface Upstream {
  readonly venue: string;
  /** the feeds a channel of this type needs; an empty list = the venue does not offer it */
  feedsFor(type: 'quote' | 'book' | 'trades' | 'candle', symbol: string, interval: Interval): FeedSpec[];
  info(feed: FeedSpec): FeedInfo;
  /** does the venue list this symbol now? Throws when it cannot tell. */
  known(symbol: string): Promise<boolean>;
  /** opens one feed; returns its closer. Must not block; failures go to `sink.error` and `onStatus`. */
  open(feed: FeedSpec, sink: UpstreamSink, onStatus: (s: UpStatus, detail?: string) => void): () => void;
  stats?(): Record<string, unknown>;
  close?(): void;
}

export class QuoteError extends Error { constructor(readonly code: QuoteErrorCode, message: string) { super(message); } }

/**
 * what a listener receives: the message, and its JSON text built once for every connection it goes to.
 * `lagTs`: the venue's own timestamp of the update that TRIGGERED this message, when it carried one — what the lag metric is
 * measured from (a quote re-sent because its unstamped ticker moved still shows the stamp of its last best bid / offer in
 * `venueTs`: that is the age of that part, not a delay of the engine).
 */
export interface Frame { readonly key: string; readonly msg: DataMessage; readonly text: string; readonly lagTs: number | null }
export type Listener = (f: Frame) => void;
export interface Subscription {
  key: string; unsubscribe(): void;
  /** the last known value as a message to send at once (a book as a fresh snapshot); null when nothing was received yet */
  snapshot(): DataMessage | DataMessage[] | null;
  /** age of that value */ snapshotAgeMs(): number | null;
  info: FeedInfo | null;
}

const frame = (key: string, msg: DataMessage, lagTs: number | null = null): Frame => { let text: string | null = null; return { key, msg, lagTs, get text() { return (text ??= JSON.stringify(msg)); } }; };
const half = (a: DecStr, b: DecStr): DecStr => D.str(D.div(D.add(D.from(a), D.from(b)), D.from(2n), 18, 'half_even'));

interface Feed { key: string; spec: FeedSpec; info: FeedInfo; up: Upstream; chans: Set<Chan>; close: () => void }
interface QuoteState { bid: DecStr | null; bidSize: DecStr | null; ask: DecStr | null; askSize: DecStr | null; mid: DecStr | null; venueMid: DecStr | null; mark: DecStr | null; index: DecStr | null; last: DecStr | null;
  funding: DecStr | null; openInterest: DecStr | null; change24h: DecStr | null; volume24h: DecStr | null; venueTs: number | null; recvTs: number }
interface Chan {
  key: string; type: 'quote' | 'book' | 'trades' | 'candle'; id: string; venue: string; symbol: string; depth: number; interval: Interval; up: Upstream; info: FeedInfo;
  listeners: Set<Listener>; feeds: Feed[]; seq: number; idle: ReturnType<typeof setTimeout> | null; lastAt: number;
  quote: QuoteState | null; qTimer: ReturnType<typeof setTimeout> | null; qLastEmit: number; qSent: boolean; qLagTs: number | null;
  bids: Level[]; asks: Level[]; hasBook: boolean; needSnapshot: boolean; bookVenueTs: number | null; bookSeq: number | null;
  trades: TradeRow[]; tradesPrimed: boolean; candle: CandleMsg | null;
}
interface VenueState { venue: string; status: UpStatus | 'idle'; since: number; lastMessageAt: number | null; detail: string | null; transport: 'stream' | 'poll'; source: string; feeds: number;
  messages: number; reconnects: number; gaps: number; errors: number; lastError: string | null; troubledSince: number | null }

export interface HubOptions {
  upstreams: Upstream[]; now?: () => number;
  /** a channel without listener is kept this long before its upstream feeds are released. Default 10 s. */ idleGraceMs?: number;
  /** a quote channel emits at most one message per this interval (the newest state; nothing is lost, updates are conflated). Default 100 ms. */ quoteMinIntervalMs?: number;
  /** a venue that stays reconnecting or stale this long is reported `down`. Default 30 s. */ downAfterMs?: number;
  /** channels held at once, all listeners together. Default 3000. */ maxChannels?: number;
  /** upstream feeds held at once per venue (Hyperliquid allows 1000 subscriptions per address). Default 800. */ maxFeedsPerVenue?: number;
  log?: (ev: Record<string, unknown>) => void;
}
export const TRADES_KEPT = 50;

export class QuoteHub {
  private readonly ups = new Map<string, Upstream>();
  private readonly chans = new Map<string, Chan>();
  private readonly feeds = new Map<string, Feed>();
  private readonly venues = new Map<string, VenueState>();
  private readonly statusListeners = new Map<Listener, string>();
  private readonly o: Required<Omit<HubOptions, 'upstreams' | 'log'>>;
  private readonly log: (ev: Record<string, unknown>) => void;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  readonly counters = { quote: 0, book: 0, bookSnapshots: 0, trade: 0, candle: 0, status: 0, upstreamMessages: 0, gaps: 0, feedsOpened: 0, feedsClosed: 0, listenerErrors: 0 };

  constructor(o: HubOptions) {
    this.o = { now: o.now ?? Date.now, idleGraceMs: o.idleGraceMs ?? 10_000, quoteMinIntervalMs: o.quoteMinIntervalMs ?? 100, downAfterMs: o.downAfterMs ?? 30_000, maxChannels: o.maxChannels ?? 3000, maxFeedsPerVenue: o.maxFeedsPerVenue ?? 800 };
    this.log = o.log ?? (() => {});
    for (const u of o.upstreams) {
      this.ups.set(u.venue, u);
      this.venues.set(u.venue, { venue: u.venue, status: 'idle', since: this.o.now(), lastMessageAt: null, detail: null, transport: 'stream', source: u.venue, feeds: 0, messages: 0, reconnects: 0, gaps: 0, errors: 0, lastError: null, troubledSince: null });
    }
  }

  venueIds(): string[] { return [...this.ups.keys()]; }

  // ------------------------------------------------------------------------------------------------ validation
  private parse(ch: Channel): { venue: string; symbol: string; up: Upstream } {
    const k = ch.id.indexOf(':');
    if (k < 1 || k === ch.id.length - 1) throw new QuoteError('unknown_instrument', `'${ch.id.slice(0, 80)}' is not a market id (venue:symbol)`);
    const venue = ch.id.slice(0, k), symbol = ch.id.slice(k + 1), up = this.ups.get(venue);
    if (!up) throw new QuoteError('unknown_instrument', `unknown venue '${venue.slice(0, 40)}'`);
    return { venue, symbol, up };
  }
  /** refuses a channel the hub cannot serve, BEFORE anything is opened upstream (Hyperliquid drops the whole connection on an unknown coin) */
  async validate(ch: Channel): Promise<void> {
    if (ch.type === 'status') { if (ch.id !== '*' && !this.ups.has(ch.id)) throw new QuoteError('unknown_instrument', `unknown venue '${ch.id.slice(0, 40)}'`); return; }
    const { symbol, up, venue } = this.parse(ch);
    if (up.feedsFor(ch.type, symbol, ch.interval ?? '1m').length === 0) throw new QuoteError('unsupported_channel', `${venue} has no ${ch.type} channel`);
    let known: boolean;
    try { known = await up.known(symbol); } catch (e) { throw new QuoteError('upstream_unavailable', `${venue} cannot be asked about '${symbol.slice(0, 60)}' now (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`); }
    if (!known) throw new QuoteError('unknown_instrument', `unknown instrument '${ch.id.slice(0, 80)}'`);
  }

  // ------------------------------------------------------------------------------------------------ subscribe
  /**
   * Live messages of one channel for one listener. `validate(ch)` must have passed. This is also the API another module of
   * this process (the agents' stream engine) can adopt instead of opening its own venue streams.
   */
  subscribe(ch: Channel, listener: Listener): Subscription {
    if (this.closed) throw new QuoteError('upstream_unavailable', 'the quote hub is closed');
    const key = channelKey(ch);
    if (ch.type === 'status') {
      this.statusListeners.set(listener, ch.id);
      this.startTicker();
      return { key, info: null, unsubscribe: () => { this.statusListeners.delete(listener); }, snapshotAgeMs: () => 0,
        snapshot: () => [...this.venues.values()].filter((v) => ch.id === '*' || v.venue === ch.id).map((v) => this.statusMsg(v)) };
    }
    let c = this.chans.get(key);
    if (!c) c = this.openChan(key, ch);
    if (c.idle) { clearTimeout(c.idle); c.idle = null; }
    c.listeners.add(listener);
    const chan = c;
    let done = false;
    return {
      key, info: chan.info,
      unsubscribe: () => {
        if (done) return;
        done = true; chan.listeners.delete(listener);
        if (chan.listeners.size === 0 && !chan.idle && this.chans.get(key) === chan) {
          chan.idle = setTimeout(() => { chan.idle = null; if (chan.listeners.size === 0) this.closeChan(chan); }, this.o.idleGraceMs);
          chan.idle.unref?.();
        }
      },
      snapshot: () => this.snapshotOf(chan),
      snapshotAgeMs: () => (chan.lastAt ? Math.max(0, this.o.now() - chan.lastAt) : null),
    };
  }

  /** the current value of a channel as a message (a book as a snapshot at the channel's current `seq`); null when it has none */
  snapshotByKey(key: string): DataMessage | null { const c = this.chans.get(key); const s = c ? this.snapshotOf(c) : null; return Array.isArray(s) ? null : s; }

  private snapshotOf(c: Chan): DataMessage | null {
    if (c.type === 'quote') return c.quote ? this.quoteMsg(c, c.quote) : null;
    if (c.type === 'book') return c.hasBook && c.bookSeq !== null ? this.bookMsg(c, 'snapshot', c.bids, c.asks, c.bookSeq, null) : null;
    if (c.type === 'trades') return c.trades.length ? { v: V, type: 'trade', id: c.id, trades: [...c.trades].reverse(), seq: c.seq, recvTs: c.lastAt, source: c.info.source, snapshot: true } satisfies TradeMsg : null;
    return c.candle;
  }

  private openChan(key: string, ch: Channel): Chan {
    if (this.chans.size >= this.o.maxChannels) throw new QuoteError('upstream_unavailable', `the hub already serves ${this.o.maxChannels} channels`);
    const { venue, symbol, up } = this.parse(ch), type = ch.type as Chan['type'], interval = ch.interval ?? '1m';
    const specs = up.feedsFor(type, symbol, interval);
    if (specs.length === 0) throw new QuoteError('unsupported_channel', `${venue} has no ${type} channel`);
    const c: Chan = { key, type, id: ch.id, venue, symbol, depth: ch.depth ?? 20, interval, up, info: up.info(specs[0]!), listeners: new Set(), feeds: [], seq: 0, idle: null, lastAt: 0,
      quote: null, qTimer: null, qLastEmit: 0, qSent: false, qLagTs: null, bids: [], asks: [], hasBook: false, needSnapshot: true, bookVenueTs: null, bookSeq: null, trades: [], tradesPrimed: false, candle: null };
    this.chans.set(key, c);
    try { for (const spec of specs) c.feeds.push(this.acquireFeed(up, spec, c)); }
    catch (e) { this.closeChan(c); throw e instanceof QuoteError ? e : new QuoteError('upstream_unavailable', e instanceof Error ? e.message.slice(0, 200) : 'upstream error'); }
    // a quote channel also takes the best bid / ask of a book that is already open for the same market (see `onBook`)
    this.startTicker();
    return c;
  }

  private closeChan(c: Chan): void {
    if (this.chans.get(c.key) === c) this.chans.delete(c.key);
    if (c.idle) { clearTimeout(c.idle); c.idle = null; }
    if (c.qTimer) { clearTimeout(c.qTimer); c.qTimer = null; }
    for (const f of c.feeds) this.releaseFeed(f, c);
    c.feeds = []; c.listeners.clear();
  }

  private acquireFeed(up: Upstream, spec: FeedSpec, c: Chan): Feed {
    const key = `${up.venue}|${spec.kind}|${spec.symbol}|${spec.kind === 'candle' ? spec.interval : ''}`;
    let f = this.feeds.get(key);
    if (f) { f.chans.add(c); return f; }
    const vs = this.venues.get(up.venue)!;
    if (vs.feeds >= this.o.maxFeedsPerVenue) throw new QuoteError('upstream_unavailable', `${up.venue}: ${this.o.maxFeedsPerVenue} upstream subscriptions are already open`);
    const info = up.info(spec);
    const feed: Feed = { key, spec, info, up, chans: new Set([c]), close: () => {} };
    this.feeds.set(key, feed);
    vs.feeds += 1; vs.transport = info.transport; vs.source = info.source;
    if (vs.status === 'idle') this.setVenue(vs, 'reconnecting', null);
    this.counters.feedsOpened += 1;
    const alive = (): boolean => this.feeds.get(key) === feed;
    const seen = (): void => { vs.lastMessageAt = this.o.now(); vs.messages += 1; this.counters.upstreamMessages += 1; };
    const guard = (fn: () => void): void => { if (!alive()) return; try { fn(); } catch (e) { vs.errors += 1; vs.lastError = e instanceof Error ? e.message.slice(0, 200) : 'error'; } };
    const sink: UpstreamSink = {
      quote: (p) => guard(() => { seen(); for (const ch of feed.chans) if (ch.type === 'quote') this.onQuote(ch, p); }),
      book: (b) => guard(() => { seen(); this.onBook(feed, b); }),
      trades: (t) => guard(() => { seen(); for (const ch of feed.chans) if (ch.type === 'trades') this.onTrades(ch, t); }),
      candle: (k) => guard(() => { seen(); for (const ch of feed.chans) if (ch.type === 'candle') this.onCandle(ch, k); }),
      gap: (reason) => guard(() => { vs.gaps += 1; this.counters.gaps += 1; for (const ch of feed.chans) ch.needSnapshot = true; this.log({ msg: 'quotes.gap', venue: up.venue, feed: key, reason }); }),
      error: (message) => guard(() => { vs.errors += 1; vs.lastError = message.slice(0, 200); }),
    };
    try { feed.close = up.open(spec, sink, (s, detail) => { if (alive()) this.setVenue(vs, s, detail ?? null); }); }
    catch (e) { this.feeds.delete(key); vs.feeds -= 1; this.counters.feedsClosed += 1; if (vs.feeds === 0) this.setVenue(vs, 'idle', null); throw e; }
    return feed;
  }

  private releaseFeed(f: Feed, c: Chan): void {
    f.chans.delete(c);
    if (f.chans.size > 0 || this.feeds.get(f.key) !== f) return;
    this.feeds.delete(f.key);
    const vs = this.venues.get(f.up.venue)!;
    vs.feeds -= 1; this.counters.feedsClosed += 1;
    try { f.close(); } catch { /* already closed */ }
    if (f.spec.kind === 'book') {
      // the quote of the same market was taking its two sides from this book: they are no longer maintained — say so, never keep them
      const q = this.chans.get(`quote|${f.up.venue}:${f.spec.symbol}|`);
      if (q && q.quote && !q.feeds.some((x) => x.spec.kind === 'bbo') && (q.quote.bid !== null || q.quote.ask !== null)) this.onQuote(q, { bid: null, bidSize: null, ask: null, askSize: null, venueTs: null });
    }
    if (vs.feeds === 0) this.setVenue(vs, 'idle', null);
  }

  // ------------------------------------------------------------------------------------------------ data in → messages out
  private emit(c: Chan, msg: DataMessage, lagTs: number | null = null): void {
    c.lastAt = this.o.now();
    if (c.listeners.size === 0) return;
    const f = frame(c.key, msg, lagTs);
    for (const l of [...c.listeners]) { try { l(f); } catch { this.counters.listenerErrors += 1; } }
  }
  private staleNow(c: Chan, recvTs: number): boolean {
    const vs = this.venues.get(c.venue)!;
    return vs.status !== 'connected' || this.o.now() - recvTs > c.info.staleAfterMs;
  }

  private quoteMsg(c: Chan, q: QuoteState): QuoteMsg {
    return { v: V, type: 'quote', id: c.id, bid: q.bid, bidSize: q.bidSize, ask: q.ask, askSize: q.askSize, mid: q.mid, mark: q.mark, index: q.index, last: q.last, funding: q.funding, openInterest: q.openInterest,
      change24h: q.change24h, volume24h: q.volume24h, venueTs: q.venueTs, recvTs: q.recvTs, seq: c.seq, source: c.info.source, stale: this.staleNow(c, q.recvTs) };
  }
  private onQuote(c: Chan, p: QuotePatch): void {
    const now = this.o.now();
    const q: QuoteState = c.quote ?? { bid: null, bidSize: null, ask: null, askSize: null, mid: null, venueMid: null, mark: null, index: null, last: null, funding: null, openInterest: null, change24h: null, volume24h: null, venueTs: null, recvTs: now };
    for (const k of ['bid', 'bidSize', 'ask', 'askSize', 'mark', 'index', 'last', 'funding', 'openInterest', 'change24h', 'volume24h'] as const) if (p[k] !== undefined) q[k] = p[k];
    if (p.mid !== undefined) q.venueMid = p.mid;
    // the mid of the two sides when the source gives both; else the venue's own figure; never a mix of two venues
    q.mid = q.bid !== null && q.ask !== null ? half(q.bid, q.ask) : q.venueMid;
    if (p.venueTs !== null && (q.venueTs === null || p.venueTs > q.venueTs)) q.venueTs = p.venueTs;
    q.recvTs = now; c.quote = q; c.qLagTs = p.venueTs;
    const wait = this.o.quoteMinIntervalMs - (now - c.qLastEmit);
    if (wait <= 0 || !c.qSent) { this.flushQuote(c); return; }
    if (!c.qTimer) { c.qTimer = setTimeout(() => { c.qTimer = null; if (this.chans.get(c.key) === c) this.flushQuote(c); }, wait); c.qTimer.unref?.(); }
  }
  private flushQuote(c: Chan): void {
    if (!c.quote) return;
    c.seq += 1; c.qLastEmit = this.o.now(); c.qSent = true; this.counters.quote += 1;
    const lagTs = c.qLagTs; c.qLagTs = null;
    this.emit(c, this.quoteMsg(c, c.quote), lagTs);
  }

  private bookMsg(c: Chan, kind: 'snapshot' | 'delta', bids: readonly Level[], asks: readonly Level[], seq: number, prevSeq: number | null): BookMsg {
    return { v: V, type: 'book', id: c.id, depth: c.depth, kind, bids: bids as [string, string][], asks: asks as [string, string][], seq, prevSeq, checksum: bookChecksum(c.bids, c.asks),
      venueTs: c.bookVenueTs, recvTs: c.lastAt || this.o.now(), source: c.info.source, stale: this.venues.get(c.venue)!.status !== 'connected' };
  }
  private onBook(feed: Feed, b: { bids: Level[]; asks: Level[]; venueTs: number | null; resync?: boolean }): void {
    for (const c of feed.chans) {
      if (c.type !== 'book') continue;
      const bids = b.bids.slice(0, c.depth), asks = b.asks.slice(0, c.depth);
      const snapshot = c.needSnapshot || b.resync === true || !c.hasBook;
      const db = snapshot ? bids : diffLevels(c.bids, bids), da = snapshot ? asks : diffLevels(c.asks, asks);
      c.bookVenueTs = b.venueTs;
      if (!snapshot && db.length === 0 && da.length === 0) { c.lastAt = this.o.now(); continue; }   // nothing changed at this depth: no message
      const prev = snapshot ? null : c.bookSeq;
      c.bids = bids; c.asks = asks; c.hasBook = true; c.needSnapshot = false;
      c.seq += 1; c.bookSeq = c.seq; c.lastAt = this.o.now();
      this.counters.book += 1; if (snapshot) this.counters.bookSnapshots += 1;
      this.emit(c, this.bookMsg(c, snapshot ? 'snapshot' : 'delta', db, da, c.seq, prev), b.venueTs);
    }
    // a venue without a best-bid/offer feed: the quote of the same market takes its two sides from the book while one is open
    const q = this.chans.get(`quote|${feed.up.venue}:${feed.spec.symbol}|`);
    if (q && !q.feeds.some((f) => f.spec.kind === 'bbo')) {
      const bb = b.bids[0], ba = b.asks[0];
      this.onQuote(q, { bid: bb?.[0] ?? null, bidSize: bb?.[1] ?? null, ask: ba?.[0] ?? null, askSize: ba?.[1] ?? null, venueTs: b.venueTs });
    }
  }

  private onTrades(c: Chan, t: TradeRow[]): void {
    const seen = new Set(c.trades.map((x) => x.id));
    const fresh = t.filter((x) => !seen.has(x.id)).sort((a, b) => a.ts - b.ts);
    if (fresh.length === 0) return;
    c.trades = [...[...fresh].reverse(), ...c.trades].slice(0, TRADES_KEPT);   // newest first
    c.seq += 1; this.counters.trade += 1;
    // the first batch after a subscription (or after a gap) is the venue's recent history, not live prints: it is flagged
    const history = !c.tradesPrimed || c.needSnapshot;
    c.tradesPrimed = true; c.needSnapshot = false;
    this.emit(c, { v: V, type: 'trade', id: c.id, trades: fresh, seq: c.seq, recvTs: this.o.now(), source: c.info.source, ...(history ? { snapshot: true } : {}) }, history ? null : fresh[fresh.length - 1]!.ts);
  }

  private onCandle(c: Chan, k: CandleRow): void {
    const p = c.candle;
    if (p && (k.ts < p.ts || (k.ts === p.ts && k.open === p.open && k.high === p.high && k.low === p.low && k.close === p.close && k.volume === p.volume))) return;
    c.seq += 1; this.counters.candle += 1;
    c.candle = { v: V, type: 'candle', id: c.id, interval: c.interval, ts: k.ts, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume, seq: c.seq, recvTs: this.o.now(), source: c.info.source };
    this.emit(c, c.candle);
  }

  // ------------------------------------------------------------------------------------------------ venue status
  private statusMsg(v: VenueState): StatusMsg {
    const now = this.o.now();
    return { v: V, type: 'status', venue: v.venue, status: v.status, since: v.since, ageMs: v.lastMessageAt === null ? null : Math.max(0, now - v.lastMessageAt), transport: v.transport, source: v.source, detail: v.detail, ts: now };
  }
  private setVenue(v: VenueState, s: UpStatus | 'idle', detail: string | null): void {
    const now = this.o.now();
    if (s === 'reconnecting' || s === 'stale') {
      v.troubledSince ??= now;
      // a venue that was already declared down stays down until it is connected again
      if (v.status === 'down') s = 'down';
    } else v.troubledSince = null;
    if (v.status === s) { v.detail = detail ?? v.detail; return; }
    const was = v.status;
    if (s === 'reconnecting' && was === 'connected') v.reconnects += 1;
    v.status = s; v.since = now; v.detail = detail;
    // back from an interruption: whatever the clients hold may have a hole — books restart from a snapshot
    if (s === 'connected' && (was === 'reconnecting' || was === 'stale' || was === 'down')) for (const c of this.chans.values()) if (c.venue === v.venue) c.needSnapshot = true;
    this.log({ msg: 'quotes.venue', venue: v.venue, status: s, was, detail });
    this.emitStatus(v);
  }
  private emitStatus(v: VenueState): void {
    if (this.statusListeners.size === 0) return;
    this.counters.status += 1;
    const f = frame(`status|${v.venue}|`, this.statusMsg(v));
    for (const [l, id] of [...this.statusListeners]) if (id === '*' || id === v.venue) { try { l(f); } catch { this.counters.listenerErrors += 1; } }
  }
  /** once a second: escalate a venue that does not come back, and refresh the ages of the troubled ones for the status listeners */
  private startTicker(): void {
    if (this.ticker || this.closed) return;
    let n = 0;
    this.ticker = setInterval(() => {
      n += 1;
      const now = this.o.now();
      for (const v of this.venues.values()) {
        if (v.troubledSince !== null && v.status !== 'down' && now - v.troubledSince >= this.o.downAfterMs) {
          const was = v.status; v.status = 'down'; v.since = now;
          this.log({ msg: 'quotes.venue', venue: v.venue, status: 'down', was, detail: v.detail });
          this.emitStatus(v);
        } else if (v.status !== 'idle' && (n % 15 === 0 || (n % 5 === 0 && v.status !== 'connected'))) this.emitStatus(v);   // ages of the troubled venues every 5 s, of the others every 15 s
      }
      if (this.chans.size === 0 && this.statusListeners.size === 0 && this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    }, 1000);
    this.ticker.unref?.();
  }
  statuses(): StatusMsg[] { return [...this.venues.values()].map((v) => this.statusMsg(v)); }

  // ------------------------------------------------------------------------------------------------ diagnostics
  listeners(key: string): number { return this.chans.get(key)?.listeners.size ?? 0; }
  stats() {
    const now = this.o.now(), byType: Record<string, number> = { quote: 0, book: 0, trades: 0, candle: 0 };
    let listeners = this.statusListeners.size;
    for (const c of this.chans.values()) { byType[c.type] = (byType[c.type] ?? 0) + 1; listeners += c.listeners.size; }
    return {
      channels: this.chans.size, channelsByType: byType, feeds: this.feeds.size, listeners, counters: { ...this.counters },
      venues: [...this.venues.values()].map((v) => ({ venue: v.venue, status: v.status, since: v.since, ageMs: v.lastMessageAt === null ? null : Math.max(0, now - v.lastMessageAt), transport: v.transport, source: v.source,
        feeds: v.feeds, messages: v.messages, reconnects: v.reconnects, gaps: v.gaps, errors: v.errors, lastError: v.lastError, upstream: (() => { try { return this.ups.get(v.venue)!.stats?.() ?? null; } catch { return null; } })() })),
    };
  }

  /** releases every channel and closes every upstream (shutdown, tests) */
  close(): void {
    this.closed = true;
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    for (const c of [...this.chans.values()]) this.closeChan(c);
    this.statusListeners.clear();
    for (const u of this.ups.values()) { try { u.close?.(); } catch { /* already closed */ } }
  }
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/edgex/stream.ts
 * Module           : venues
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// edgeX PUBLIC websocket (wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws) — frames as recorded live on 2026-11-15
// (docs/v11/research/edgex-api.md §1.8; test/fixtures/edgex/ws-public.json). Nothing private: no account, no header, no key.
//
//   <<  {"type":"connected","sid":"…"}
//   >>  {"type":"subscribe","channel":"ticker.30000192"}        also depth.{id}.15|200, trades.{id}, ticker.all.1s
//   <<  {"type":"subscribed","channel":"…"}  then  {"type":"quote-event","channel":"…","content":{"dataType":"Snapshot"|"changed","data":[…]}}
//   <<  {"type":"ping","time":"…"} every 10 s    >>  {"type":"pong","time":<the same>}
//   <<  {"type":"error","request":"<the frame sent>","content":{"code":"GATEWAY_INVALID_CHANNEL","msg":"…"}}
//
// Reliability model
// - One connection, many channels, reference-counted. It reconnects by itself (exponential backoff with jitter), subscribes
//   again, and tells every consumer that a GAP may exist: status 'reconnecting' → 'connected' plus `{ type: 'gap' }`.
// - The server pings every 10 s: no frame at all for `staleAfterMs` → 'stale'; still nothing after `staleGraceMs` → reconnect.
// - Depth is a snapshot followed by increments (`size "0"` deletes a price). Each increment's `startVersion` must equal the
//   previous `endVersion`: anything else, or a crossed book, is a gap on that channel → `{ type: 'gap' }` and the channel is
//   subscribed again (fresh snapshot). A local book is never patched across a hole.
// - Trades are de-duplicated by `ticketId` across increments, snapshots and reconnects.
// - A frame that fails validation is dropped and reported (`{ type: 'invalid' }`); it never produces a NaN or a partial object.
import { z } from 'zod';
import type { DecStr } from '../../decimal.ts';
import type { Book, PublicTrade, Ticker } from '../../models.ts';
import type { StreamStatus } from '../../venue.ts';
import { venueError } from '../http.ts';
import { EDGEX, bookFrom, tickerOf, tradeOf } from './map.ts';
import * as W from './wire.ts';

export interface EdgeXWebSocketLike {
  send(data: string): void; close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export type EdgeXWebSocketCtor = new (url: string) => EdgeXWebSocketLike;

export type EdgeXStreamEvent =
  | { type: 'ticker'; symbol: string; snapshot: boolean; ticker: Ticker }
  /** `ticker.all.1s`: every contract, about once per second */
  | { type: 'tickers'; snapshot: boolean; tickers: Ticker[] }
  | { type: 'book'; symbol: string; snapshot: boolean; book: Book }
  | { type: 'trades'; symbol: string; snapshot: boolean; trades: PublicTrade[] }
  /** something may have been missed (reconnection, or a hole in the depth versions): take a fresh snapshot before trusting local state */
  | { type: 'gap'; reason: 'reconnected' | 'book_sequence' }
  /** a frame that failed validation was dropped */
  | { type: 'invalid'; channel: string; reason: string }
  /** the venue refused a subscription */
  | { type: 'error'; message: string };

export interface EdgeXStreamOptions {
  url: string; WebSocket?: EdgeXWebSocketCtor | null; now?: () => number;
  /** levels per side in emitted books. Default 20. */
  depth?: number;
  /** no frame at all for this long → 'stale' (the server pings every 10 s). Default 25 s. */
  staleAfterMs?: number;
  /** still nothing this long after 'stale' → the connection is dropped and re-opened. Default 10 s. */
  staleGraceMs?: number;
  /** reconnect backoff bounds (connection limits are unpublished: stay slow). Default 1 s … 30 s. */
  backoffMinMs?: number; backoffMaxMs?: number; random?: () => number;
  /** trade ids remembered per channel. Default 2000. */
  dedupeSize?: number;
}

type Handler = { on: (ev: EdgeXStreamEvent) => void; onStatus: (s: StreamStatus) => void; status: StreamStatus | null };
interface Channel {
  name: string; kind: 'ticker' | 'tickers' | 'book' | 'trades'; handlers: Set<Handler>; live: boolean;
  symbol: string | null; bids: Map<DecStr, DecStr>; asks: Map<DecStr, DecStr>; endVersion: string | null;
  ticker: Ticker | null; tickers: Ticker[]; trades: PublicTrade[]; seen: Set<string>; resyncs: number[];
}

export const EDGEX_CHANNEL_RE = /^(ticker\.(\d{1,20}|all\.1s)|depth\.\d{1,20}\.(15|200)|trades\.\d{1,20})$/;
/** a connection must have lasted this long before the reconnect backoff starts again from its minimum */
const STABLE_MS = 10_000;
/** recent trades kept per channel for late joiners and for the adapter's `trades()` */
const TRADES_KEPT = 100;
const kindOf = (name: string): Channel['kind'] => (name === 'ticker.all.1s' ? 'tickers' : name.startsWith('ticker.') ? 'ticker' : name.startsWith('depth.') ? 'book' : 'trades');
const issues = (e: z.ZodError): string => e.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ').slice(0, 160);

export class EdgeXStream {
  private readonly o: Required<Omit<EdgeXStreamOptions, 'WebSocket'>>;
  private readonly WS: EdgeXWebSocketCtor | null;
  private readonly channels = new Map<string, Channel>();
  private ws: EdgeXWebSocketLike | null = null;
  private ready = false;                 // the server said `connected`
  private everConnected = false;
  private attempt = 0;
  private openedAt = 0;
  private lastFrameAt = 0;
  private state: StreamStatus | 'idle' = 'idle';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly st = { connects: 0, frames: 0, invalid: 0, duplicates: 0, pongs: 0, resyncs: 0 };

  constructor(o: EdgeXStreamOptions) {
    this.WS = o.WebSocket === null ? null : (o.WebSocket ?? (globalThis as { WebSocket?: EdgeXWebSocketCtor }).WebSocket ?? null);
    this.o = { url: o.url, now: o.now ?? Date.now, depth: o.depth ?? 20, staleAfterMs: o.staleAfterMs ?? 25_000, staleGraceMs: o.staleGraceMs ?? 10_000,
      backoffMinMs: o.backoffMinMs ?? 1_000, backoffMaxMs: o.backoffMaxMs ?? 30_000, random: o.random ?? Math.random, dedupeSize: o.dedupeSize ?? 2_000 };
  }

  /** false when no WebSocket implementation is available (or it was disabled with `WebSocket: null`) */
  get available(): boolean { return this.WS !== null; }
  stats() { return { ...this.st, channels: this.channels.size, status: this.state }; }
  /** trades currently held for a channel that is live (newest first); null when the channel is not live */
  recentTrades(channel: string): PublicTrade[] | null { const c = this.channels.get(channel); return c && c.live ? [...c.trades] : null; }

  /** Subscribe to one channel; returns the unsubscribe function. */
  subscribe(channel: string, on: (ev: EdgeXStreamEvent) => void, onStatus: (s: StreamStatus) => void): () => void {
    if (!EDGEX_CHANNEL_RE.test(channel)) throw venueError(EDGEX, 'unsupported', `unknown channel '${channel.slice(0, 60)}'`);
    if (!this.WS) throw venueError(EDGEX, 'unsupported', 'no WebSocket implementation available');
    const h: Handler = { on, onStatus, status: null };
    let c = this.channels.get(channel);
    if (!c) {
      c = { name: channel, kind: kindOf(channel), handlers: new Set(), live: false, symbol: null, bids: new Map(), asks: new Map(), endVersion: null, ticker: null, tickers: [], trades: [], seen: new Set(), resyncs: [] };
      this.channels.set(channel, c);
      if (this.ready) this.send({ type: 'subscribe', channel });
    } else if (c.live) {
      const ch = c;                       // late joiner on a live channel: the current state, as a snapshot
      queueMicrotask(() => { if (ch.handlers.has(h)) this.replay(ch, h); });
    }
    c.handlers.add(h);
    if (this.state !== 'idle') { h.status = this.state; onStatus(this.state); }
    if (!this.ws && !this.retryTimer) this.connect();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = this.channels.get(channel);
      if (!cur || !cur.handlers.delete(h)) return;
      if (cur.handlers.size === 0) { this.channels.delete(channel); if (this.ready) this.send({ type: 'unsubscribe', channel }); }
      if (this.channels.size === 0) this.shutdown();
    };
  }

  close(): void { this.channels.clear(); this.shutdown(); }

  // ------------------------------------------------------------------ connection

  private send(m: unknown): void { if (this.ws) { try { this.ws.send(JSON.stringify(m)); } catch { /* the close handler reconnects */ } } }
  private setStatus(s: StreamStatus): void {
    this.state = s;
    for (const c of this.channels.values()) for (const h of c.handlers) if (h.status !== s) { h.status = s; try { h.onStatus(s); } catch { /* a consumer must not break the stream */ } }
  }
  private emit(c: Channel, ev: EdgeXStreamEvent, only?: Handler): void { for (const h of only ? [only] : [...c.handlers]) { try { h.on(ev); } catch { /* idem */ } } }
  private emitAll(ev: EdgeXStreamEvent): void { for (const c of this.channels.values()) this.emit(c, ev); }

  private connect(): void {
    this.retryTimer = null;
    if (this.ws || this.channels.size === 0 || !this.WS) return;
    let sock: EdgeXWebSocketLike;
    try { sock = new this.WS(this.o.url); } catch { this.reconnect(); return; }
    this.ws = sock; this.ready = false; this.st.connects += 1; this.lastFrameAt = this.openedAt = this.o.now();
    sock.onopen = () => { /* the server announces readiness with a `connected` frame */ };
    sock.onmessage = (ev) => { if (this.ws === sock) this.onFrame(ev.data); };
    sock.onclose = () => { if (this.ws === sock) this.reconnect(); };
    sock.onerror = () => { if (this.ws === sock) this.reconnect(); };
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => {
        if (!this.ws) return;
        const quiet = this.o.now() - this.lastFrameAt;
        if (quiet > this.o.staleAfterMs + this.o.staleGraceMs) this.reconnect();
        else if (quiet > this.o.staleAfterMs && this.state === 'connected') this.setStatus('stale');
      }, Math.max(250, Math.min(1_000, Math.floor(this.o.staleGraceMs / 4))));
      (this.watchTimer as { unref?: () => void }).unref?.();
    }
  }
  private drop(): void {
    const old = this.ws;
    this.ws = null; this.ready = false;
    for (const c of this.channels.values()) { c.live = false; c.endVersion = null; }
    if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* already closed */ } }
  }
  private reconnect(): void {
    // the backoff starts again only after a connection that lasted: a server that accepts and drops at once must not be hammered
    if (this.ready && this.o.now() - this.openedAt >= STABLE_MS) this.attempt = 0;
    this.drop();
    if (this.channels.size === 0) { this.shutdown(); return; }
    this.setStatus('reconnecting');
    if (this.retryTimer) return;
    const delay = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** Math.min(this.attempt, 16)) * (0.5 + 0.5 * this.o.random());
    this.attempt += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }
  private shutdown(): void {
    this.drop();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    this.state = 'idle'; this.everConnected = false; this.attempt = 0;
  }

  // ------------------------------------------------------------------ frames

  private invalid(c: Channel | null, channel: string, reason: string): void {
    this.st.invalid += 1;
    const ev: EdgeXStreamEvent = { type: 'invalid', channel, reason: reason.slice(0, 160) };
    if (c) this.emit(c, ev); else this.emitAll(ev);
  }

  private onFrame(raw: unknown): void {
    this.lastFrameAt = this.o.now(); this.st.frames += 1;
    if (this.state === 'stale') this.setStatus('connected');      // same connection: ordered and lossless, no gap
    let frame: z.infer<typeof W.wsFrame>;
    try {
      const p = W.wsFrame.safeParse(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
      if (!p.success) { this.invalid(null, '?', `frame: ${issues(p.error)}`); return; }
      frame = p.data;
    } catch { this.invalid(null, '?', 'frame is not JSON'); return; }
    switch (frame.type) {
      case 'connected': {
        this.ready = true;
        for (const c of this.channels.values()) this.send({ type: 'subscribe', channel: c.name });
        const again = this.everConnected;
        this.everConnected = true;
        this.setStatus('connected');
        if (again) this.emitAll({ type: 'gap', reason: 'reconnected' });
        return;
      }
      case 'ping': if (typeof frame.time === 'string') { this.send({ type: 'pong', time: frame.time }); this.st.pongs += 1; } return;
      case 'pong': case 'subscribed': case 'unsubscribed': return;
      case 'error': {
        const message = `${frame.content?.code ?? 'error'}: ${frame.content?.msg ?? ''}`.slice(0, 200);
        let target: Channel | undefined;
        try { const req = z.object({ channel: z.string() }).safeParse(JSON.parse(frame.request ?? 'null')); if (req.success) target = this.channels.get(req.data.channel); } catch { /* no channel named */ }
        if (target) this.emit(target, { type: 'error', message }); else this.emitAll({ type: 'error', message });
        return;
      }
      case 'quote-event': {
        const c = frame.channel ? this.channels.get(frame.channel) : undefined;
        if (!c) return;                                           // late data for a channel we left
        const snapshot = (frame.content?.dataType ?? '').toLowerCase() === 'snapshot';   // "Snapshot", then lowercase "changed"
        try { this.data(c, snapshot, frame.content?.data); }
        catch (e) { this.invalid(c, c.name, e instanceof Error ? e.message : 'handler error'); if (c.kind === 'book') this.resync(c); }
        return;
      }
      default: return;                                            // a frame type we do not know: ignored
    }
  }

  /** a depth channel whose local book can no longer be trusted: tell the consumers, subscribe again for a fresh snapshot */
  private resync(c: Channel): void {
    const now = this.o.now();
    c.resyncs = c.resyncs.filter((t) => now - t < 30_000); c.resyncs.push(now);
    c.live = false; c.endVersion = null; c.bids.clear(); c.asks.clear(); this.st.resyncs += 1;
    this.emit(c, { type: 'gap', reason: 'book_sequence' });
    if (c.resyncs.length > 5) { this.reconnect(); return; }       // it keeps happening: start over with a new connection
    this.send({ type: 'unsubscribe', channel: c.name }); this.send({ type: 'subscribe', channel: c.name });
  }

  private data(c: Channel, snapshot: boolean, data: unknown): void {
    const now = this.o.now();
    switch (c.kind) {
      case 'tickers': {
        // one bad element must not hide the other contracts: each is validated alone
        const rows = z.array(z.unknown()).safeParse(data);
        if (!rows.success) { this.invalid(c, c.name, 'data is not a list'); return; }
        const out: Ticker[] = [];
        let badCount = 0;
        for (const r of rows.data) { const p = W.ticker.safeParse(r); if (p.success) out.push(tickerOf(p.data, now)); else badCount += 1; }
        if (badCount) this.invalid(c, c.name, `${badCount} ticker(s) failed validation`);
        if (!out.length) return;
        c.live = true; c.tickers = out;
        this.emit(c, { type: 'tickers', snapshot, tickers: out });
        return;
      }
      case 'ticker': {
        const p = W.tickers.safeParse(data);
        if (!p.success) { this.invalid(c, c.name, issues(p.error)); return; }
        const t = p.data[0];
        if (!t || `ticker.${t.contractId}` !== c.name) return;
        c.live = true; c.symbol = t.contractName; c.ticker = tickerOf(t, now);
        this.emit(c, { type: 'ticker', symbol: t.contractName, snapshot, ticker: c.ticker });
        return;
      }
      case 'trades': {
        const p = z.array(W.trade).safeParse(data);
        if (!p.success) { this.invalid(c, c.name, issues(p.error)); return; }
        if (p.data.some((t) => `trades.${t.contractId}` !== c.name)) { this.invalid(c, c.name, 'trades of another contract'); return; }
        const fresh: PublicTrade[] = [];
        for (const t of p.data) { if (c.seen.has(t.ticketId)) { this.st.duplicates += 1; continue; } c.seen.add(t.ticketId); fresh.push(tradeOf(t)); }
        if (c.seen.size > this.o.dedupeSize * 2) { const keep = [...c.seen].slice(-this.o.dedupeSize); c.seen.clear(); for (const k of keep) c.seen.add(k); }
        if (p.data[0]) c.symbol = p.data[0].contractName;
        c.trades = [...fresh, ...c.trades].sort((a, b) => b.ts - a.ts).slice(0, TRADES_KEPT);
        const first = !c.live;
        c.live = true;
        if (fresh.length || (snapshot && first)) this.emit(c, { type: 'trades', symbol: c.symbol ?? '', snapshot, trades: fresh.sort((a, b) => a.ts - b.ts) });
        return;
      }
      case 'book': {
        const d = W.depths.parse(data)[0];
        if (!d) return;
        if (!c.name.startsWith(`depth.${d.contractId}.`)) throw new Error('depth of another contract');
        const isSnapshot = snapshot || d.depthType.toUpperCase() === 'SNAPSHOT';
        if (isSnapshot) { c.bids.clear(); c.asks.clear(); }
        else if (!c.live) return;                                 // an increment before the snapshot cannot be applied
        else if (d.startVersion !== c.endVersion) { this.resync(c); return; }
        for (const [side, levels] of [[c.bids, d.bids], [c.asks, d.asks]] as const) for (const l of levels) { if (/^0(\.0+)?$/.test(l.size)) side.delete(l.price); else side.set(l.price, l.size); }
        c.endVersion = d.endVersion; c.symbol = d.contractName; c.live = true;
        this.emit(c, { type: 'book', symbol: d.contractName, snapshot: isSnapshot, book: bookFrom(d.contractName, c.bids, c.asks, this.o.depth, now) });   // throws when crossed → resync
        return;
      }
    }
  }

  private replay(c: Channel, h: Handler): void {
    try {
      if (c.kind === 'book' && c.symbol) this.emit(c, { type: 'book', symbol: c.symbol, snapshot: true, book: bookFrom(c.symbol, c.bids, c.asks, this.o.depth, this.o.now()) }, h);
      else if (c.kind === 'ticker' && c.ticker && c.symbol) this.emit(c, { type: 'ticker', symbol: c.symbol, snapshot: true, ticker: c.ticker }, h);
      else if (c.kind === 'tickers' && c.tickers.length) this.emit(c, { type: 'tickers', snapshot: true, tickers: c.tickers }, h);
      else if (c.kind === 'trades') this.emit(c, { type: 'trades', symbol: c.symbol ?? '', snapshot: true, trades: [...c.trades].sort((a, b) => a.ts - b.ts) }, h);
    } catch { /* a crossed local book is reported by the next frame */ }
  }
}

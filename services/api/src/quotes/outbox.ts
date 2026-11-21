/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/quotes/outbox.ts
 * Module           : quotes
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

// Backpressure of ONE client connection (docs/V11-QUOTE-ENGINE.md §6).
//
// A frame goes straight to the socket while the socket keeps up (`bufferedAmount` under the low-water mark and nothing queued).
// Otherwise the client is slow and the queue takes over, bounded by construction — at most one entry per subscription:
//   quote, candle, status   CONFLATED: only the newest per channel is kept (the older one is replaced, counted);
//   book                    one queued delta is kept as it is; a second one for the same channel turns the entry into a
//                           SNAPSHOT of the channel's current book, built when it is finally sent — a client never
//                           receives a delta whose predecessor it did not get;
//   trade                   DROPPED and counted; the count is sent as a `dropped` frame as soon as the client drains.
// A client that stays over the high-water mark for `overMs` (or reaches four times that mark) cannot keep up: `onOverflow`
// closes it (code 4003). Control frames (hello, subscribed, error, pong, heartbeat) are small and always written.
import type { Frame } from './hub.ts';
import type { DataMessage } from './protocol.ts';
import { QUOTE_PROTOCOL_VERSION as V } from './shared.ts';

export interface OutSocket { send(data: string): void; readonly bufferedAmount: number }
export interface OutboxOptions {
  lowWaterBytes?: number; highWaterBytes?: number; overMs?: number; flushMs?: number; now?: () => number;
  /** the current value of a channel as a message (QuoteHub.snapshotByKey) — used to turn conflated book deltas into a snapshot */
  snapshot: (key: string) => DataMessage | null;
  onOverflow: () => void;
  /** called for every frame written to the socket (metrics); `lagTs`: the venue timestamp of the update that triggered a data frame sent WITHOUT waiting in the queue */
  onSent?: (bytes: number, lagTs: number | null) => void;
}
export interface OutboxStats { sent: number; bytes: number; queuedNow: number; queuedMax: number; conflated: number; bookResyncs: number; tradesDropped: number; overflowed: boolean }

interface Entry { text: string; msg: DataMessage; resync: boolean }

export class Outbox {
  private readonly q = new Map<string, Entry>();
  private readonly dropped = new Map<string, number>();
  /** trades dropped per market since the connection opened */
  private readonly droppedTotal = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private overSince: number | null = null;
  private closed = false;
  private readonly low: number; private readonly high: number; private readonly overMs: number; private readonly flushMs: number; private readonly now: () => number;
  readonly stats: OutboxStats = { sent: 0, bytes: 0, queuedNow: 0, queuedMax: 0, conflated: 0, bookResyncs: 0, tradesDropped: 0, overflowed: false };

  constructor(private readonly sock: OutSocket, private readonly o: OutboxOptions) {
    this.low = o.lowWaterBytes ?? 256 * 1024; this.high = o.highWaterBytes ?? 4 * 1024 * 1024; this.overMs = o.overMs ?? 10_000; this.flushMs = o.flushMs ?? 25; this.now = o.now ?? Date.now;
  }

  private write(text: string, lagTs: number | null = null): void {
    try { this.sock.send(text); } catch { return; }
    this.stats.sent += 1; this.stats.bytes += text.length;
    this.o.onSent?.(text.length, lagTs);
  }
  /** hello, subscribed, error, pong, heartbeat: written at once */
  control(msg: unknown): void { if (!this.closed) this.write(JSON.stringify(msg)); }

  private congested(): boolean { return this.q.size > 0 || this.dropped.size > 0 || this.sock.bufferedAmount > this.low; }
  /** true when the client is over the high-water mark for too long (the caller closes it) */
  private checkOverflow(): boolean {
    const b = this.sock.bufferedAmount, t = this.now();
    if (b <= this.high) { this.overSince = null; return false; }
    this.overSince ??= t;
    if (b > 4 * this.high || t - this.overSince >= this.overMs) { this.stats.overflowed = true; this.close(); this.o.onOverflow(); return true; }
    return false;
  }

  /** a data frame of the hub for this client */
  data(f: Frame): void {
    if (this.closed || this.checkOverflow()) return;
    if (!this.congested()) { this.write(f.text, f.lagTs); return; }
    const m = f.msg;
    if (m.type === 'trade') {
      const n = m.trades.length;
      this.dropped.set(m.id, (this.dropped.get(m.id) ?? 0) + n); this.droppedTotal.set(m.id, (this.droppedTotal.get(m.id) ?? 0) + n);
      this.stats.tradesDropped += n;
    } else {
      const prev = this.q.get(f.key);
      if (prev) {
        this.stats.conflated += 1;
        // keep the place in the queue (fairness between channels), replace the content
        prev.text = f.text; prev.msg = m;
        if (m.type === 'book') prev.resync = true;
      } else this.q.set(f.key, { text: f.text, msg: m, resync: false });
      this.stats.queuedNow = this.q.size;
      if (this.q.size > this.stats.queuedMax) this.stats.queuedMax = this.q.size;
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  /** writes what the socket can take now; called by the timer while something is queued */
  flush(): void {
    if (this.closed || this.checkOverflow()) return;
    while ((this.q.size > 0 || this.dropped.size > 0) && this.sock.bufferedAmount <= this.low) {
      const d = this.dropped.entries().next().value;
      if (d) {
        this.dropped.delete(d[0]);
        this.write(JSON.stringify({ v: V, type: 'dropped', channel: 'trades', id: d[0], count: d[1], total: this.droppedTotal.get(d[0]) ?? d[1] }));
        continue;
      }
      const [key, e] = this.q.entries().next().value!;
      this.q.delete(key);
      if (e.resync) {
        const snap = this.o.snapshot(key);
        this.stats.bookResyncs += 1;
        if (snap) this.write(JSON.stringify(snap));   // the channel was closed meanwhile: nothing to send
      } else this.write(e.text);
    }
    this.stats.queuedNow = this.q.size;
    if (this.q.size > 0 || this.dropped.size > 0) this.arm();
  }

  /** forget what is queued for a channel the client left */
  forget(key: string): void { this.q.delete(key); this.stats.queuedNow = this.q.size; }
  close(): void { this.closed = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.q.clear(); this.dropped.clear(); this.stats.queuedNow = 0; }
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/walletEvents.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

/**
 * NEXT — live synchronisation: the wallet's event stream (services/api/src/events.ts) instead of re-reading every screen on a timer.
 *
 *   GET /api/v1/events/stream   Server-Sent Events, resumed with `Last-Event-ID` (and `?after=`) from the last id PROCESSED
 *   GET /api/v1/events?after=   the same rows, as the fallback when the stream cannot be used
 *
 * Events are facts that say « look »: each one names what changed (`type`, `ref`) and the client re-reads it through the normal
 * read routes (`invalidationsFor` → TanStack Query invalidations). So a duplicate or a late event is harmless, and nothing
 * here ever writes a state or an amount on screen.
 *
 *  - position: the id of the last event processed, kept in memory and in sessionStorage (a reload resumes; a new tab starts now);
 *  - an id already processed is ignored (the server delivers at least once);
 *  - `reset` (the position is older than what the server keeps, or ahead of it): forget it, re-read everything, continue from the id it carries;
 *  - the stream ends by itself (10 min) or breaks: reconnection with back-off, resumed from the position — what happened in between arrives first;
 *  - a server without the stream (404), or too many streams (429): polling `GET /events?after=`; the stream is tried again later;
 *  - a hidden tab holds no connection; when it is shown again the feed resumes and catches up;
 *  - never `X-SPW-Interaction`: the stream and its polling are background reads (api.ts), they do not keep a session alive.
 *
 * `EventFeed` has no DOM and no fetch of its own (its transport is injected): tested with a scripted stream in
 * test/next-events.test.ts. `startWalletEvents` wires it to the browser.
 */
import type { QueryClient } from '@tanstack/react-query';
import { ApiError, get, inBackground } from './api';
import { emitWalletEvent, setFeedMode, type FeedMode, type WalletEvent } from './feed-state';

export { feedMode, onFeedMode, onWalletEvent, type FeedMode, type WalletEvent } from './feed-state';

export interface EventsPage { reset: boolean; events: WalletEvent[]; latest: number; more?: boolean }

// ------------------------------------------------------------------------------------------------------------------ SSE parsing
export interface SseMessage { id: string | null; event: string; data: string }
/** Incremental parser of a `text/event-stream` body: feed it chunks, it returns the messages completed so far (comments and `retry:` are dropped). */
export function sseParser(): (chunk: string) => SseMessage[] {
  let buf = '';
  return (chunk) => {
    buf += chunk.replace(/\r\n?/g, '\n');
    const out: SseMessage[] = [];
    for (let cut = buf.indexOf('\n\n'); cut >= 0; cut = buf.indexOf('\n\n')) {
      const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
      let id: string | null = null, event = 'message'; const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const c = line.indexOf(':'), k = c < 0 ? line : line.slice(0, c), v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (k === 'id') id = v; else if (k === 'event') event = v; else if (k === 'data') data.push(v);
      }
      if (data.length > 0 || id !== null || event !== 'message') out.push({ id, event, data: data.join('\n') });
    }
    return out;
  };
}

// ------------------------------------------------------------------------------------------------------------------ the feed
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];
export const FEED_POLL_MS = 15_000, STREAM_RETRY_MS = 120_000, AFTER_END_MS = 1000;
export interface StreamHandle { status: number; /** decoded text chunks of the body; ends when the server closes, throws when the connection breaks */ chunks: AsyncIterable<string> | null }
export interface FeedDeps {
  /** open the stream from `after` (null: from now). Rejects when the connection cannot be made. */
  openStream: (after: number | null, signal: AbortSignal) => Promise<StreamHandle>;
  /** `GET /events?after=&limit=` */
  poll: (after: number, limit?: number) => Promise<EventsPage>;
  onEvent: (e: WalletEvent) => void;
  /** the position could not be resumed: everything must be read again */
  onReset: () => void;
  store?: { get: () => number | null; set: (n: number) => void };
  visible?: () => boolean;
  setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void;
  /** called on every change of mode (tests, a status dot) */
  onMode?: (m: FeedMode) => void;
}

export class EventFeed {
  position: number | null; mode: FeedMode = 'idle';
  private failures = 0; private timer: unknown = null; private abort: AbortController | null = null; private run = 0; private streamOffUntil = 0; private stopped = true;
  constructor(private readonly d: FeedDeps, private readonly now: () => number = Date.now) { this.position = d.store?.get() ?? null; }
  private setMode(m: FeedMode): void { if (this.mode !== m) { this.mode = m; this.d.onMode?.(m); } }
  private later(f: () => void, ms: number): void { this.cancelTimer(); this.timer = (this.d.setTimer ?? setTimeout)(f, ms); }
  private cancelTimer(): void { if (this.timer !== null) { (this.d.clearTimer ?? (clearTimeout as (h: unknown) => void))(this.timer); this.timer = null; } }
  private move(to: number): void { this.position = to; this.d.store?.set(to); }

  start(): void { this.stopped = false; this.resume(); }
  stop(): void { this.stopped = true; this.halt(); this.setMode('idle'); }
  /** the tab was hidden: no connection, no timer */
  pause(): void { if (this.stopped) return; this.halt(); this.setMode('paused'); }
  /** the tab is shown again (or the feed starts): connect, and catch up from the position */
  resume(): void { if (this.stopped || this.mode === 'off') return; if (this.d.visible && !this.d.visible()) { this.pause(); return; } this.halt(); this.failures = 0; void this.connect(); }
  private halt(): void { this.run += 1; this.cancelTimer(); this.abort?.abort(); this.abort = null; }

  /** one event of the stream or of a poll; false when it was already processed */
  private take(e: WalletEvent): boolean {
    if (!Number.isFinite(e.id) || (this.position !== null && e.id <= this.position)) return false;
    this.move(e.id); this.d.onEvent(e); return true;
  }
  private reset(latest: number): void { this.move(latest); this.d.onReset(); }

  private async connect(): Promise<void> {
    if (this.now() < this.streamOffUntil) { void this.pollOnce(); return; }
    const run = this.run, ctl = new AbortController(); this.abort = ctl;
    let opened = false;
    try {
      const h = await this.d.openStream(this.position, ctl.signal);
      if (run !== this.run) return;
      if (h.status === 401 || h.status === 403) { this.setMode('off'); return; }                       // no session: the shell handles it
      if (h.status === 404 || h.status === 405 || h.status === 501) { this.streamOffUntil = Number.POSITIVE_INFINITY; void this.pollOnce(); return; }   // a server without the stream: poll
      if (h.status === 429) { this.streamOffUntil = this.now() + STREAM_RETRY_MS; void this.pollOnce(); return; }                                    // too many streams open: poll, try again later
      if (h.status !== 200 || !h.chunks) throw new Error(`stream ${h.status}`);
      opened = true; this.setMode('stream');
      const parse = sseParser();
      for await (const chunk of h.chunks) {
        if (run !== this.run) return;
        for (const m of parse(chunk)) {
          if (m.event === 'hello') { this.failures = 0; if (this.position === null) { try { const from = Number((JSON.parse(m.data) as { from?: unknown }).from); if (Number.isFinite(from)) this.move(from); } catch { /* a position will come with the first event */ } } continue; }
          if (m.event === 'reset') { this.failures = 0; let latest = Number(m.id); try { const l = Number((JSON.parse(m.data) as { latest?: unknown }).latest); if (Number.isFinite(l)) latest = l; } catch { /* the id carries it */ } if (Number.isFinite(latest)) this.reset(latest); continue; }
          if (m.id === null) continue;
          try { const e = JSON.parse(m.data) as WalletEvent; this.take({ ...e, id: Number(m.id), type: e.type ?? m.event }); this.failures = 0; } catch { /* an unreadable event: the next read of the screen has the truth anyway */ }
        }
      }
      if (run !== this.run) return;
      // the server closed the stream (it does so every ten minutes): reconnect, resumed from the position
      this.later(() => void this.connect(), AFTER_END_MS);
    } catch {
      if (run !== this.run) return;
      const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!; this.failures += 1;
      if (!opened && this.failures >= 3) { this.streamOffUntil = this.now() + STREAM_RETRY_MS; void this.pollOnce(); return; }   // the stream does not connect: poll meanwhile
      this.later(() => void this.connect(), wait);
    }
  }

  private async pollOnce(): Promise<void> {
    const run = this.run; this.setMode('polling');
    try {
      for (;;) {
        // no position yet: start from now (the newest id), without replaying the past
        const page = this.position === null ? await this.d.poll(0, 1) : await this.d.poll(this.position);
        if (run !== this.run) return;
        if (this.position === null) { this.move(page.latest); break; }
        if (page.reset) { this.reset(page.latest); break; }
        for (const e of page.events) this.take(e);
        if (!page.more) break;
      }
      this.failures = 0;
    } catch (e) {
      if (run !== this.run) return;
      if (e instanceof ApiError && e.kind === 'http' && (e.status === 404 || e.status === 401)) { this.setMode('off'); return; }   // a server without events at all: the screens' own slow polling remains
      this.failures += 1;
    }
    const wait = this.failures > 0 ? Math.max(FEED_POLL_MS, BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!) : FEED_POLL_MS;
    this.later(() => { if (this.now() >= this.streamOffUntil) void this.connect(); else void this.pollOnce(); }, wait);
  }
}

// ------------------------------------------------------------------------------------------------------------------ what an event invalidates
export type QueryKeyPrefix = readonly (string | number)[];
const ALL: QueryKeyPrefix[] = [['portfolio'], ['activity'], ['security'], ['logins'], ['contacts'], ['book'], ['settings'], ['prefs'], ['analytics'], ['proposal'], ['risk', 'status'], ['dashboard']];
/** the queries an event makes stale (prefixes of TanStack query keys). An unknown type invalidates nothing. */
export function invalidationsFor(e: Pick<WalletEvent, 'type' | 'ref'>): QueryKeyPrefix[] {
  const t = e.type;
  if (t === 'reset') return ALL;
  if (t === 'transfer.state') return [...(e.ref ? [['proposal', e.ref] as QueryKeyPrefix] : [['proposal'] as QueryKeyPrefix]), ['portfolio'], ['activity'], ['analytics']];
  if (t.startsWith('transfer.')) return [...(e.ref ? [['proposal', e.ref] as QueryKeyPrefix] : []), ['activity']];
  if (t.startsWith('deposit.')) return [['portfolio'], ['activity'], ['analytics']];
  if (t === 'security.contact_address_changed') return [['contacts'], ['book'], ['security']];
  if (t.startsWith('addressbook.')) return [['contacts'], ['book']];
  if (t === 'settings.asset_pref') return [['prefs']];
  if (t.startsWith('settings.')) return [['settings'], ['prefs'], ['portfolio']];
  if (t.startsWith('halt.')) return [['security'], ['portfolio'], ['risk', 'status'], ['dashboard']];
  if (t.startsWith('device.') || t.startsWith('credentials.') || t.startsWith('session.') || t.startsWith('sessions.') || t === 'login.ok' || t === 'owner.setup' || t.startsWith('security.')) return [['security'], ['logins']];
  return [];
}
const startsWith = (key: readonly unknown[], prefix: QueryKeyPrefix): boolean => prefix.every((p, k) => key[k] === p);
/** `['activity','timeline',…]` is an infinite list: an invalidation would re-read every page it holds — the Activity screen re-reads its head itself (onWalletEvent) */
const skipped = (key: readonly unknown[]): boolean => key[0] === 'activity' && key[1] === 'timeline';

// ------------------------------------------------------------------------------------------------------------------ browser wiring
/** deliver an event to the app as the feed does (the feed, and tests) */
export function dispatchWalletEvent(qc: QueryClient, e: WalletEvent): void {
  for (const prefix of invalidationsFor(e)) void qc.invalidateQueries({ predicate: (q) => startsWith(q.queryKey, prefix) && !skipped(q.queryKey) });
  emitWalletEvent(e);
}
const POS_KEY = 'spw-events-pos';
async function* bodyChunks(r: Response): AsyncIterable<string> {
  const reader = r.body!.getReader(), dec = new TextDecoder();
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield dec.decode(value, { stream: true }); } }
  finally { try { reader.releaseLock(); } catch { /* already released */ } }
}
/** Start the feed for the open session; returns the function that stops it (lock, logout, session end). */
export function startWalletEvents(qc: QueryClient): () => void {
  const store = {
    get: (): number | null => { try { const v = sessionStorage.getItem(POS_KEY); const n = v === null ? NaN : Number(v); return Number.isFinite(n) && n >= 0 ? n : null; } catch { return null; } },
    set: (n: number): void => { try { sessionStorage.setItem(POS_KEY, String(n)); } catch { /* memory only */ } },
  };
  const feed = new EventFeed({
    store, visible: () => document.visibilityState === 'visible',
    openStream: async (after, signal) => {
      const r = await fetch(`/api/v1/events/stream${after === null ? '' : `?after=${after}`}`, { credentials: 'same-origin', signal, cache: 'no-store',
        headers: { accept: 'text/event-stream', ...(after === null ? {} : { 'last-event-id': String(after) }) } });
      if (r.status !== 200 || !r.body) { void r.body?.cancel().catch(() => {}); return { status: r.status, chunks: null }; }
      return { status: 200, chunks: bodyChunks(r) };
    },
    poll: (after, limit) => inBackground(() => get<EventsPage>(`/events?after=${after}${limit ? `&limit=${limit}` : ''}`, { interaction: false })),
    onEvent: (e) => dispatchWalletEvent(qc, e),
    onReset: () => dispatchWalletEvent(qc, { id: 0, at: new Date().toISOString(), type: 'reset', ref: null, data: {} }),
    onMode: setFeedMode,
  });
  const vis = () => { if (document.visibilityState === 'visible') feed.resume(); else feed.pause(); };
  document.addEventListener('visibilitychange', vis);
  feed.start();
  return () => { document.removeEventListener('visibilitychange', vis); feed.stop(); setFeedMode('idle'); try { sessionStorage.removeItem(POS_KEY); } catch { /* nothing kept */ } };
}

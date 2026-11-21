/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/next-events.test.ts
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

// NEXT web — the wallet event feed with a scripted stream: resume, catch-up after a gap, reset, duplicate ids, back-off,
// fallback to polling, pause while hidden; and what each event type invalidates.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { BACKOFF_MS, EventFeed, FEED_POLL_MS, invalidationsFor, sseParser, type EventsPage, type FeedDeps, type FeedMode, type StreamHandle, type WalletEvent } from '../src/walletEvents.ts';

const ev = (id: number, type = 'transfer.state', ref: string | null = 'p1'): WalletEvent => ({ id, at: '2026-11-19T12:00:00.000Z', type, ref, data: {} });
const frame = (e: WalletEvent) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const hello = (from: number) => `retry: 3000\n\nevent: hello\ndata: {"from":${from}}\n\n`;

/** a stream the test writes to and closes by hand */
function manual(): { handle: StreamHandle; push: (s: string) => void; end: () => void; fail: () => void } {
  const q: (string | null | Error)[] = []; let wake: (() => void) | null = null;
  const put = (x: string | null | Error) => { q.push(x); wake?.(); wake = null; };
  async function* chunks(): AsyncIterable<string> { for (;;) { while (q.length === 0) await new Promise<void>((r) => { wake = r; }); const x = q.shift()!; if (x === null) return; if (x instanceof Error) throw x; yield x; } }
  return { handle: { status: 200, chunks: chunks() }, push: (s) => put(s), end: () => put(null), fail: () => put(new Error('connection lost')) };
}
/** a harness: timers are collected (run by hand), the transport is a script of opened streams */
function harness(o: { position?: number | null; visible?: () => boolean } = {}) {
  const seen: WalletEvent[] = [], opened: (number | null)[] = [], polled: number[] = [], modes: FeedMode[] = []; let resets = 0, stored = o.position ?? null;
  const timers: { f: () => void; ms: number }[] = [];
  const script: ((after: number | null) => Promise<StreamHandle>)[] = []; const polls: ((after: number) => Promise<EventsPage>)[] = [];
  const deps: FeedDeps = {
    openStream: (after) => { opened.push(after); const next = script.shift(); return next ? next(after) : Promise.reject(new Error('no more streams scripted')); },
    poll: (after) => { polled.push(after); const next = polls.shift(); return next ? next(after) : Promise.resolve({ reset: false, events: [], latest: after }); },
    onEvent: (e) => seen.push(e), onReset: () => { resets += 1; },
    store: { get: () => stored, set: (n) => { stored = n; } }, visible: o.visible,
    setTimer: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clearTimer: (h) => { const k = timers.indexOf(h as never); if (k >= 0) timers.splice(k, 1); },
    onMode: (m) => modes.push(m),
  };
  let now = 1_000_000;
  const feed = new EventFeed(deps, () => now);
  const tick = async () => { for (let k = 0; k < 20; k++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
  const fire = async () => { const t = timers.shift(); if (!t) throw new Error('no timer pending'); now += t.ms; t.f(); await tick(); return t.ms; };
  return { feed, seen, opened, polled, modes, timers, script, polls, tick, fire, resets: () => resets, stored: () => stored, advance: (ms: number) => { now += ms; } };
}

describe('sseParser', () => {
  it('reads id / event / data across chunk boundaries, ignores comments and retry, joins multi-line data', () => {
    const p = sseParser();
    expect(p('retry: 3000\n\n: keep-alive\n\nid: 7\nevent: transfer.st')).toEqual([]);
    expect(p('ate\ndata: {"a":1}\n\nid: 8\r\nevent: x\r\ndata: l1\r\ndata: l2\r\n\r\n')).toEqual([{ id: '7', event: 'transfer.state', data: '{"a":1}' }, { id: '8', event: 'x', data: 'l1\nl2' }]);
    expect(p('event: hello\ndata: {"from":3}\n\n')).toEqual([{ id: null, event: 'hello', data: '{"from":3}' }]);
  });
});

describe('EventFeed — stream', () => {
  it('a new tab starts from NOW (the position of `hello`), then processes events in order and remembers the last id', async () => {
    const h = harness(), s = manual(); h.script.push(async () => s.handle);
    h.feed.start(); await h.tick();
    expect(h.opened).toEqual([null]);
    s.push(hello(40)); await h.tick(); expect(h.feed.position).toBe(40); expect(h.feed.mode).toBe('stream');
    s.push(frame(ev(41)) + frame(ev(42, 'deposit.seen', 'd1'))); await h.tick();
    expect(h.seen.map((e) => e.id)).toEqual([41, 42]); expect(h.feed.position).toBe(42); expect(h.stored()).toBe(42);
    h.feed.stop();
  });
  it('duplicate ids are processed once (at-least-once delivery), ids at or under the position are ignored', async () => {
    const h = harness({ position: 10 }), s = manual(); h.script.push(async () => s.handle);
    h.feed.start(); await h.tick(); expect(h.opened).toEqual([10]);
    s.push(hello(10) + frame(ev(9)) + frame(ev(10)) + frame(ev(11)) + frame(ev(11)) + frame(ev(12)) + frame(ev(11))); await h.tick();
    expect(h.seen.map((e) => e.id)).toEqual([11, 12]); expect(h.feed.position).toBe(12);
    h.feed.stop();
  });
  it('RESUME after the server closes the stream: the next connection asks from the last id processed, and the gap arrives first', async () => {
    const h = harness({ position: 5 }), a = manual(), b = manual();
    h.script.push(async () => a.handle, async () => b.handle);
    h.feed.start(); await h.tick();
    a.push(hello(5) + frame(ev(6))); await h.tick(); a.end(); await h.tick();
    expect(h.timers).toHaveLength(1);                         // reconnection scheduled, not immediate
    await h.fire(); expect(h.opened).toEqual([5, 6]);         // Last-Event-ID = 6
    b.push(hello(6) + frame(ev(7)) + frame(ev(8)) + frame(ev(9))); await h.tick();   // what happened while disconnected
    expect(h.seen.map((e) => e.id)).toEqual([6, 7, 8, 9]);
    h.feed.stop();
  });
  it('a broken connection reconnects with a growing back-off; a connection that works again resets it', async () => {
    const h = harness({ position: 1 }), ok = manual();
    h.script.push(async () => { throw new Error('refused'); }, async () => { throw new Error('refused'); }, async () => ok.handle, async () => { throw new Error('refused'); });
    h.feed.start(); await h.tick();
    expect(await h.fire()).toBe(BACKOFF_MS[0]); expect(await h.fire()).toBe(BACKOFF_MS[1]);
    ok.push(hello(1) + frame(ev(2))); await h.tick(); expect(h.seen.map((e) => e.id)).toEqual([2]);
    ok.fail(); await h.tick();
    expect(h.timers[0]!.ms).toBe(BACKOFF_MS[0]);              // back to the first delay after a stream that delivered
    h.feed.stop();
  });
  it('RESET: the position is forgotten, everything is re-read once, and the feed continues from the id the reset carries', async () => {
    const h = harness({ position: 3 }), s = manual(); h.script.push(async () => s.handle);
    h.feed.start(); await h.tick();
    s.push(`retry: 3000\n\nid: 900\nevent: reset\ndata: {"latest":900}\n\n`); await h.tick();
    expect(h.resets()).toBe(1); expect(h.feed.position).toBe(900); expect(h.seen).toEqual([]);
    s.push(frame(ev(899)) + frame(ev(901))); await h.tick();
    expect(h.seen.map((e) => e.id)).toEqual([901]);
    h.feed.stop();
  });
  it('a hidden tab holds no connection; shown again, it resumes from its position', async () => {
    let visible = true; const h = harness({ position: 20, visible: () => visible }), a = manual(), b = manual();
    h.script.push(async () => a.handle, async () => b.handle);
    h.feed.start(); await h.tick(); a.push(hello(20) + frame(ev(21))); await h.tick();
    visible = false; h.feed.pause(); expect(h.feed.mode).toBe('paused'); expect(h.timers).toHaveLength(0);
    a.push(frame(ev(22))); await h.tick(); expect(h.seen.map((e) => e.id)).toEqual([21]);   // nothing is processed while paused
    visible = true; h.feed.resume(); await h.tick();
    expect(h.opened).toEqual([20, 21]);
    b.push(hello(21) + frame(ev(22)) + frame(ev(23))); await h.tick(); expect(h.seen.map((e) => e.id)).toEqual([21, 22, 23]);
    h.feed.stop();
  });
  it('a feed started while the tab is hidden waits', async () => {
    const h = harness({ visible: () => false }); h.feed.start(); await h.tick();
    expect(h.opened).toEqual([]); expect(h.feed.mode).toBe('paused');
  });
});

describe('EventFeed — polling fallback', () => {
  it('a server without the stream (404): polling GET /events?after=, starting from now, then page after page', async () => {
    const h = harness();
    h.script.push(async () => ({ status: 404, chunks: null }));
    h.polls.push(async () => ({ reset: false, events: [ev(77)], latest: 77 }),                                   // position unknown: only `latest` is taken
      async () => ({ reset: false, events: [ev(78), ev(79)], latest: 81, more: true }), async () => ({ reset: false, events: [ev(79), ev(80), ev(81)], latest: 81 }));
    h.feed.start(); await h.tick();
    expect(h.feed.mode).toBe('polling'); expect(h.polled).toEqual([0]); expect(h.feed.position).toBe(77); expect(h.seen).toEqual([]);
    expect(await h.fire()).toBe(FEED_POLL_MS);
    expect(h.polled).toEqual([0, 77, 79]); expect(h.seen.map((e) => e.id)).toEqual([78, 79, 80, 81]);   // `more` is read at once; the duplicate 79 is ignored
    expect(h.opened).toEqual([null]);                                                                    // the stream is not tried again on a server that has none
    h.feed.stop();
  });
  it('polling handles reset, and a server with no event route at all turns the feed off', async () => {
    const h = harness({ position: 5 });
    h.script.push(async () => ({ status: 404, chunks: null }));
    h.polls.push(async () => ({ reset: true, events: [], latest: 300 }), async () => { throw new ApiError(404, 'not_found', 'not found', 'http'); });
    h.feed.start(); await h.tick();
    expect(h.resets()).toBe(1); expect(h.feed.position).toBe(300);
    await h.fire(); expect(h.feed.mode).toBe('off'); expect(h.timers).toHaveLength(0);
  });
  it('too many streams (429): polling meanwhile, and the stream is tried again later', async () => {
    const h = harness({ position: 1 }), s = manual();
    h.script.push(async () => ({ status: 429, chunks: null }), async () => s.handle);
    h.feed.start(); await h.tick(); expect(h.feed.mode).toBe('polling');
    for (let k = 0; k < 12 && h.opened.length < 2; k++) await h.fire();
    expect(h.opened.length).toBe(2); s.push(hello(1)); await h.tick(); expect(h.feed.mode).toBe('stream');
    h.feed.stop();
  });
  it('a stream that never connects falls back to polling after three attempts', async () => {
    const h = harness({ position: 1 });
    for (let k = 0; k < 3; k++) h.script.push(async () => { throw new Error('refused'); });
    h.feed.start(); await h.tick(); await h.fire(); await h.fire();
    expect(h.feed.mode).toBe('polling'); expect(h.polled).toEqual([1]);
    h.feed.stop();
  });
});

describe('what an event invalidates', () => {
  const keys = (type: string, ref: string | null = null) => invalidationsFor({ type, ref }).map((k) => k.join('/'));
  it('transfer.state → that proposal, the portfolio and the activity', () => { expect(keys('transfer.state', 'abc')).toEqual(expect.arrayContaining(['proposal/abc', 'portfolio', 'activity'])); expect(keys('transfer.confirmations', 'abc')).toEqual(['proposal/abc', 'activity']); });
  it('deposit.* → portfolio and activity', () => { expect(keys('deposit.received')).toEqual(expect.arrayContaining(['portfolio', 'activity'])); expect(keys('deposit.received')).not.toContain('security'); });
  it('device / session / credentials → the security overview', () => { for (const t of ['device.added', 'device.revoked', 'session.revoked', 'sessions.revoked', 'credentials.mismatch', 'login.ok']) expect(keys(t), t).toContain('security'); });
  it('address book → contacts; a changed contact address is also a security event', () => { expect(keys('addressbook.saved')).toEqual(['contacts', 'book']); expect(keys('security.contact_address_changed')).toEqual(['contacts', 'book', 'security']); });
  it('settings → settings and preferences; halt → security and the banners', () => { expect(keys('settings.asset_pref')).toEqual(['prefs']); expect(keys('settings.changed')).toEqual(expect.arrayContaining(['settings', 'prefs'])); expect(keys('halt.on')).toEqual(expect.arrayContaining(['security', 'portfolio'])); });
  it('reset → everything; an unknown type → nothing', () => { expect(keys('reset').length).toBeGreaterThan(8); expect(keys('something.new')).toEqual([]); });
});

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/quotes/engine.ts
 * Module           : quotes
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

// Quote engine — the websocket server (docs/V11-QUOTE-ENGINE.md §3–§6). READ-ONLY public market data.
//
//   GET  /api/v1/stream                  browser: owner session cookie + STRICT Origin (the CSRF defence of a websocket)
//   GET  /api/v1/trading/stream          API clients: `Authorization: Bearer spw_live_…` (scope markets:read), or `?ticket=`
//   POST /api/v1/trading/stream/ticket   a single-use ticket, valid 30 s, for clients that cannot set a header (browsers)
//   GET  /api/v1/stream/stats            owner: connections, subscriptions, rates, conflation, drops, upstream state, lag
//
// Authentication happens BEFORE the upgrade, in the hooks every request of the service goes through (server.ts onRequest:
// session cookie or API key; trading-api scopeGuard: the route's scope). A refused request is answered in plain HTTP
// (401 / 403 / 429) and the socket is never upgraded. An API key is never read from the query string.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { COOKIE, sessionAlive } from '../auth.ts';
import { config, UserError } from '../config.ts';
import { getKey, keyStatus } from '../trading-api/keys.ts';
import { OWNER, type Principal } from '../trading-api/principal.ts';
import { QuoteError, QuoteHub, type Frame, type Subscription } from './hub.ts';
import { Outbox } from './outbox.ts';
import { ClientMessageSchema, type Channel, type QuoteErrorCode } from './protocol.ts';
import { channelKey, CLOSE, HEARTBEAT_MS, QUOTE_PROTOCOL_VERSION as V } from './shared.ts';

export const STREAM_PATH = '/api/v1/stream', TRADING_STREAM_PATH = '/api/v1/trading/stream', TICKET_PATH = '/api/v1/trading/stream/ticket', STATS_PATH = '/api/v1/stream/stats';

export interface StreamLimits {
  /** connections of the owner (every tab is one) */ maxConnectionsOwner: number; /** connections per API key */ maxConnectionsPerKey: number; maxConnectionsTotal: number;
  maxSubscriptions: number; /** bytes of one client frame */ maxFrameBytes: number; /** client frames per second (burst: twice that) */ maxMessagesPerSec: number;
  /** nothing subscribed and nothing received for this long → closed */ idleTimeoutMs: number; heartbeatMs: number;
  /** how often an open socket re-checks its session or key */ recheckMs: number; ticketTtlMs: number;
  lowWaterBytes: number; highWaterBytes: number; /** over the high-water mark this long → closed */ overMs: number;
}
const envInt = (k: string, d: number): number => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
export const defaultLimits = (): StreamLimits => ({
  maxConnectionsOwner: envInt('SPW_STREAM_MAX_CONN_OWNER', 12), maxConnectionsPerKey: envInt('SPW_STREAM_MAX_CONN_KEY', 4), maxConnectionsTotal: envInt('SPW_STREAM_MAX_CONN', 200),
  maxSubscriptions: envInt('SPW_STREAM_MAX_SUBS', 300), maxFrameBytes: 16 * 1024, maxMessagesPerSec: 20, idleTimeoutMs: 120_000, heartbeatMs: HEARTBEAT_MS, recheckMs: 30_000, ticketTtlMs: 30_000,
  lowWaterBytes: 256 * 1024, highWaterBytes: 4 * 1024 * 1024, overMs: 10_000,
});

export interface QuoteEngineOptions {
  hub: QuoteHub; limits?: Partial<StreamLimits>; now?: () => number;
  /** V11: the metered market-data providers behind the hub (budget counter, state) — shown as `metered` in the statistics */ metered?: (() => Record<string, unknown>) | undefined;
  /** tests: replace the credential re-checks */ sessionAlive?: (token: string | undefined) => Promise<boolean>; keyActive?: (id: string) => Promise<boolean>;
}
interface Ticket { principal: Principal; sessionToken: string | null; expiresAt: number }
interface Auth { principal: Principal; /** owner: the session cookie this socket lives on */ sessionToken: string | null; via: 'cookie' | 'key' | 'ticket' }

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const who = (p: Principal): string => (p.kind === 'api_key' ? `key:${p.id}` : 'owner');
const allowed = (p: Principal, ch: Channel): boolean => {
  if (p.kind !== 'api_key' || ch.type === 'status') return true;
  const r = p.restrictions, venue = ch.id.slice(0, Math.max(0, ch.id.indexOf(':')));
  return (r.venues.length === 0 || r.venues.includes(venue)) && (r.instruments.length === 0 || r.instruments.includes(ch.id));
};

class Conn {
  readonly id = randomUUID().slice(0, 13);
  readonly subs = new Map<string, Subscription>();
  readonly out: Outbox;
  readonly openedAt: number;
  lastClientAt: number; alive = true; closed = false; tokens: number; tokensAt: number; violations = 0; received = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly engine: QuoteEngine, readonly ws: WebSocket, readonly auth: Auth, readonly ip: string) {
    const l = engine.limits;
    this.openedAt = this.lastClientAt = this.tokensAt = engine.now(); this.tokens = l.maxMessagesPerSec * 2;
    this.out = new Outbox(ws, { lowWaterBytes: l.lowWaterBytes, highWaterBytes: l.highWaterBytes, overMs: l.overMs, now: engine.now, snapshot: (key) => engine.hub.snapshotByKey(key),
      onOverflow: () => this.close(CLOSE.slowConsumer, 'slow consumer: over the high-water mark'), onSent: (bytes, lagTs) => engine.sent(bytes, lagTs) });
    ws.on('message', (data, isBinary) => this.onFrame(data as Buffer, isBinary));
    ws.on('pong', () => { this.alive = true; });
    ws.on('close', () => this.dispose());
    this.out.control({ v: V, type: 'hello', connId: this.id, heartbeatMs: l.heartbeatMs, serverTs: engine.now(),
      limits: { maxSubscriptions: l.maxSubscriptions, maxFrameBytes: l.maxFrameBytes, maxMessagesPerSec: l.maxMessagesPerSec, idleTimeoutMs: l.idleTimeoutMs } });
  }

  private error(code: QuoteErrorCode, message: string, extra: Record<string, unknown> = {}): void { this.out.control({ v: V, type: 'error', code, message, ...extra }); }

  private onFrame(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    const l = this.engine.limits, now = this.engine.now();
    this.lastClientAt = now; this.received += 1;
    // token bucket: `maxMessagesPerSec` a second, burst twice that
    this.tokens = Math.min(l.maxMessagesPerSec * 2, this.tokens + ((now - this.tokensAt) / 1000) * l.maxMessagesPerSec); this.tokensAt = now;
    if (this.tokens < 1) {
      this.violations += 1; this.engine.counters.rateLimited += 1;
      if (this.violations >= 20) { this.close(CLOSE.rateLimited, 'too many frames'); return; }
      this.error('rate_limited', `at most ${l.maxMessagesPerSec} frames per second`);
      return;
    }
    this.tokens -= 1;
    const bad = (code: QuoteErrorCode, message: string): void => {
      this.violations += 1; this.engine.counters.badFrames += 1;
      if (this.violations >= 20) { this.close(CLOSE.protocol, 'too many invalid frames'); return; }
      this.error(code, message);
    };
    if (isBinary) { bad('bad_frame', 'binary frames are not part of the protocol: send JSON text'); return; }
    let raw: unknown;
    try { raw = JSON.parse(data.toString('utf8')); } catch { bad('bad_frame', 'the frame is not JSON'); return; }
    if (raw !== null && typeof raw === 'object' && 'v' in raw && (raw as { v: unknown }).v !== V) { bad('unsupported_version', `protocol version ${V} only`); return; }
    const p = ClientMessageSchema.safeParse(raw);
    if (!p.success) { bad('bad_message', `invalid message: ${p.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ').slice(0, 200)}`); return; }
    const m = p.data;
    this.violations = 0;                                           // the limits above count CONSECUTIVE refusals
    if (m.op === 'ping') { this.out.control({ v: V, type: 'pong', t: m.t ?? null, ts: now }); return; }
    // one request at a time per connection: answers come in the order of the requests
    this.chain = this.chain.then(() => (m.op === 'subscribe' ? this.subscribe(m.channels, m.reqId) : this.unsubscribe(m.channels, m.reqId))).catch((e) => { this.error('internal', 'internal error'); this.engine.log('warn', { msg: 'quotes.conn.error', conn: this.id, err: (e as Error)?.message }); });
  }

  private async subscribe(channels: Channel[], reqId: string | number | undefined): Promise<void> {
    const hub = this.engine.hub, l = this.engine.limits;
    for (const ch of channels) {
      if (this.closed) return;
      const key = channelKey(ch), echo = { channel: ch, ...(reqId !== undefined ? { reqId } : {}) };
      let sub = this.subs.get(key);
      if (!sub) {
        if (this.subs.size >= l.maxSubscriptions) { this.error('too_many_subscriptions', `at most ${l.maxSubscriptions} subscriptions per connection`, echo); continue; }
        if (!allowed(this.auth.principal, ch)) { this.engine.counters.restricted += 1; this.error('restricted', `this key is not allowed on ${ch.id.slice(0, 80)}`, echo); continue; }
        try {
          await hub.validate(ch);
          if (this.closed) return;
          sub = hub.subscribe(ch, (f: Frame) => this.out.data(f));
        } catch (e) {
          if (e instanceof QuoteError) this.error(e.code, e.message, echo);
          else { this.error('internal', 'internal error', echo); this.engine.log('warn', { msg: 'quotes.subscribe.error', conn: this.id, err: (e as Error)?.message }); }
          continue;
        }
        this.subs.set(key, sub);
        this.engine.counters.subscribes += 1;
      } else this.out.forget(key);   // subscribing again = "send me the snapshot again" (a client that found a hole in its book)
      // the snapshot is read in the same turn as the subscription: nothing can be emitted between the two
      this.out.control({ v: V, type: 'subscribed', channel: ch, key, ...(reqId !== undefined ? { reqId } : {}), staleAfterMs: sub.info?.staleAfterMs ?? null, source: sub.info?.source ?? null, snapshot: sub.snapshot(), snapshotAgeMs: sub.snapshotAgeMs() });
    }
  }
  private async unsubscribe(channels: Channel[], reqId: string | number | undefined): Promise<void> {
    for (const ch of channels) {
      const key = channelKey(ch), sub = this.subs.get(key);
      if (sub) { sub.unsubscribe(); this.subs.delete(key); this.out.forget(key); }
      this.out.control({ v: V, type: 'unsubscribed', channel: ch, key, ...(reqId !== undefined ? { reqId } : {}) });
    }
  }

  /** every heartbeat period: liveness (protocol ping/pong), the application heartbeat, the idle rule */
  beat(now: number): void {
    if (this.closed) return;
    if (!this.alive) { this.engine.counters.deadPeers += 1; this.engine.log('warn', { msg: 'quotes.conn.dead', conn: this.id, who: who(this.auth.principal) }); this.terminate(); return; }
    this.alive = false;
    try { this.ws.ping(); } catch { /* the close handler disposes */ }
    if (this.subs.size === 0 && now - this.lastClientAt >= this.engine.limits.idleTimeoutMs) { this.close(CLOSE.idle, 'idle'); return; }
    this.out.control({ v: V, type: 'heartbeat', ts: now, subscriptions: this.subs.size });
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    if (code !== CLOSE.goingAway && code !== 1000) this.engine.log('warn', { msg: 'quotes.conn.closed', conn: this.id, who: who(this.auth.principal), code, reason });
    if (code === CLOSE.slowConsumer) this.engine.counters.slowConsumers += 1;
    try { this.ws.close(code, reason.slice(0, 120)); } catch { /* already closing */ }
    // a peer that does not answer the close handshake is cut after 5 s
    const t = setTimeout(() => this.terminate(), 5000); t.unref?.();
    this.dispose();
  }
  terminate(): void { try { this.ws.terminate(); } catch { /* gone */ } this.dispose(); }
  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.subs.values()) { try { s.unsubscribe(); } catch { /* idem */ } }
    this.subs.clear(); this.out.close();
    this.engine.forget(this);
  }
}

export class QuoteEngine {
  readonly hub: QuoteHub; readonly limits: StreamLimits; readonly now: () => number;
  readonly conns = new Set<Conn>();
  private readonly perWho = new Map<string, number>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly ticketOf = new WeakMap<object, Ticket>();
  private timer: ReturnType<typeof setInterval> | null = null; private secTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecheck = 0; private rechecking = false; private closing = false;
  private readonly lag = new Float64Array(4096); private lagN = 0;
  private readonly perSec = new Array<number>(10).fill(0); private secIdx = 0; private sentThisSec = 0;
  readonly counters = { connections: 0, refused: 0, subscribes: 0, messagesSent: 0, bytesSent: 0, conflated: 0, tradesDropped: 0, bookResyncs: 0, slowConsumers: 0, deadPeers: 0, badFrames: 0, rateLimited: 0, restricted: 0, unauthorizedClosed: 0, ticketsIssued: 0, ticketsUsed: 0, ticketsRefused: 0 };
  private app: FastifyInstance | null = null;
  private readonly metered: (() => Record<string, unknown>) | null;
  private readonly alive: (token: string | undefined) => Promise<boolean>; private readonly keyActive: (id: string) => Promise<boolean>;

  constructor(o: QuoteEngineOptions) {
    this.hub = o.hub; this.limits = { ...defaultLimits(), ...o.limits }; this.now = o.now ?? Date.now;
    this.alive = o.sessionAlive ?? sessionAlive; this.metered = o.metered ?? null;
    this.keyActive = o.keyActive ?? (async (id) => keyStatus(await getKey(id)) === 'active');
  }

  log(level: 'info' | 'warn', ev: Record<string, unknown>): void { try { this.app?.log[level](ev); } catch { /* logging must not break the stream */ } }

  // ------------------------------------------------------------------------------------------------ metrics
  sent(bytes: number, lagTs: number | null): void {
    this.counters.messagesSent += 1; this.counters.bytesSent += bytes; this.sentThisSec += 1;
    if (lagTs === null) return;
    const lag = Date.now() - lagTs;                                // real clocks on both ends: the venue's stamp and this machine's
    if (lag >= -1000 && lag < 600_000) { this.lag[this.lagN % this.lag.length] = Math.max(0, lag); this.lagN += 1; }
  }
  private lagStats(): { samples: number; p50: number | null; p95: number | null } {
    const n = Math.min(this.lagN, this.lag.length);
    if (n === 0) return { samples: 0, p50: null, p95: null };
    const a = Array.from(this.lag.subarray(0, n)).sort((x, y) => x - y);
    return { samples: this.lagN, p50: a[Math.floor((n - 1) * 0.5)]!, p95: a[Math.floor((n - 1) * 0.95)]! };
  }
  stats() {
    let subs = 0, queued = 0; const by: Record<string, number> = {};
    let conflated = this.counters.conflated, dropped = this.counters.tradesDropped, resyncs = this.counters.bookResyncs;
    for (const c of this.conns) { subs += c.subs.size; queued += c.out.stats.queuedNow; by[c.auth.principal.kind] = (by[c.auth.principal.kind] ?? 0) + 1; conflated += c.out.stats.conflated; dropped += c.out.stats.tradesDropped; resyncs += c.out.stats.bookResyncs; }
    const rate = this.perSec.reduce((s, x) => s + x, 0) / this.perSec.length;
    const hub = this.hub.stats();
    return {
      ts: this.now(), protocol: V,
      connections: { open: this.conns.size, byPrincipal: by, total: this.counters.connections, refused: this.counters.refused },
      subscriptions: subs, messagesPerSec: Math.round(rate * 10) / 10, messagesSent: this.counters.messagesSent, bytesSent: this.counters.bytesSent,
      backpressure: { queuedNow: queued, conflated, tradesDropped: dropped, bookResyncs: resyncs, slowConsumersClosed: this.counters.slowConsumers },
      clients: { deadPeers: this.counters.deadPeers, badFrames: this.counters.badFrames, rateLimited: this.counters.rateLimited, restricted: this.counters.restricted, unauthorizedClosed: this.counters.unauthorizedClosed },
      tickets: { issued: this.counters.ticketsIssued, used: this.counters.ticketsUsed, refused: this.counters.ticketsRefused, pending: this.tickets.size },
      upstreamReconnects: hub.venues.reduce((s, v) => s + v.reconnects, 0),
      /** the venue's own timestamp of an update → that update written to a client socket, over the last 4096 venue-stamped updates sent without queueing (ms) */ lagMs: this.lagStats(),
      limits: this.limits, hub,
      /** keyed, metered sources: daily credit budget used / remaining; `down` with the reason `quota` when it is spent (null: none configured in this build of the engine) */
      metered: (() => { try { return this.metered?.() ?? null; } catch { return null; } })(),
    };
  }
  /** compact summary for the monitor screen's health answer */
  summary() {
    const s = this.stats();
    return { connections: s.connections.open, subscriptions: s.subscriptions, messagesPerSec: s.messagesPerSec, conflated: s.backpressure.conflated, tradesDropped: s.backpressure.tradesDropped, upstreamReconnects: s.upstreamReconnects, metered: s.metered,
      lagMs: s.lagMs, venues: s.hub.venues.map((v) => ({ venue: v.venue, status: v.status, ageMs: v.ageMs, transport: v.transport, feeds: v.feeds, reconnects: v.reconnects, gaps: v.gaps })) };
  }

  // ------------------------------------------------------------------------------------------------ connections
  forget(c: Conn): void {
    if (!this.conns.delete(c)) return;
    const k = who(c.auth.principal), n = (this.perWho.get(k) ?? 1) - 1;
    if (n <= 0) this.perWho.delete(k); else this.perWho.set(k, n);
    // the counters of a closed connection stay in the totals
    this.counters.conflated += c.out.stats.conflated; this.counters.tradesDropped += c.out.stats.tradesDropped; this.counters.bookResyncs += c.out.stats.bookResyncs;
    this.log('info', { msg: 'quotes.conn.close', conn: c.id, who: k, sent: c.out.stats.sent, conflated: c.out.stats.conflated, tradesDropped: c.out.stats.tradesDropped, ms: this.now() - c.openedAt });
    if (this.conns.size === 0) this.stopTimers();
  }
  private stopTimers(): void { if (this.timer) clearInterval(this.timer); if (this.secTimer) clearInterval(this.secTimer); this.timer = this.secTimer = null; }
  private startTimers(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = this.now();
      for (const c of [...this.conns]) c.beat(now);
      if (now - this.lastRecheck >= this.limits.recheckMs) void this.recheck();
    }, this.limits.heartbeatMs);
    this.timer.unref?.();
    this.secTimer = setInterval(() => { this.perSec[this.secIdx] = this.sentThisSec; this.secIdx = (this.secIdx + 1) % this.perSec.length; this.sentThisSec = 0; }, 1000);
    this.secTimer.unref?.();
  }
  private limitFor(p: Principal): number { return p.kind === 'api_key' ? this.limits.maxConnectionsPerKey : this.limits.maxConnectionsOwner; }

  /** session ended or key revoked / expired → the socket is closed (4001). Runs every `recheckMs` and right after a logout or a key change. */
  async recheck(): Promise<void> {
    if (this.rechecking) return;
    this.rechecking = true; this.lastRecheck = this.now();
    try {
      const verdict = new Map<string, boolean>();
      for (const c of [...this.conns]) {
        const p = c.auth.principal, k = p.kind === 'api_key' ? `key:${p.id}` : `session:${c.auth.sessionToken ?? ''}`;
        if (!verdict.has(k)) verdict.set(k, await (p.kind === 'api_key' ? this.keyActive(p.id) : this.alive(c.auth.sessionToken ?? undefined)).catch(() => true));   // a database hiccup closes nobody
        if (verdict.get(k) === false) { this.counters.unauthorizedClosed += 1; c.close(CLOSE.unauthorized, p.kind === 'api_key' ? 'the API key is no longer active' : 'the session ended'); }
      }
    } finally { this.rechecking = false; }
  }

  /** closes every client with 1001 so that it reconnects elsewhere / later, then releases the upstreams */
  shutdown(): void {
    if (this.closing) return;
    this.closing = true;
    for (const c of [...this.conns]) c.close(CLOSE.goingAway, 'server shutting down');
    this.stopTimers(); this.tickets.clear();
    this.hub.close();
  }

  // ------------------------------------------------------------------------------------------------ tickets
  issueTicket(principal: Principal, sessionToken: string | null): { ticket: string; expiresAt: number } {
    const now = this.now();
    for (const [k, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(k);
    if (this.tickets.size >= 2000) throw new UserError('too_many_tickets', 'too many stream tickets are pending', 429);
    const ticket = `spw_tkt_${randomBytes(24).toString('base64url')}`, expiresAt = now + this.limits.ticketTtlMs;
    this.tickets.set(sha(ticket), { principal, sessionToken, expiresAt });
    this.counters.ticketsIssued += 1;
    return { ticket, expiresAt };
  }
  /**
   * server.ts onRequest, before the API-key and session checks: a `?ticket=` on the trading stream IS the credential of that
   * one upgrade request. Single use (removed when presented, valid or expired), never combined with a cookie or a bearer key.
   * Returns false when the request carries no ticket.
   */
  ticketGate(req: FastifyRequest, path: string): boolean {
    if (path !== TRADING_STREAM_PATH) return false;
    const t = (req.query as { ticket?: unknown } | undefined)?.ticket;
    if (t === undefined) return false;
    const refuse = (): never => { this.counters.ticketsRefused += 1; throw new UserError('unauthenticated', 'authentication required', 401); };
    if (typeof t !== 'string' || t.length > 80 || !t.startsWith('spw_tkt_')) return refuse();
    const key = sha(t), rec = this.tickets.get(key);
    this.tickets.delete(key);                                      // single use, whatever happens next
    if (req.headers.authorization !== undefined || req.cookies[COOKIE]) throw new UserError('mixed_credentials', 'send a ticket, an API key or the session cookie — never two of them', 403);
    if (!rec || rec.expiresAt <= this.now()) return refuse();
    this.counters.ticketsUsed += 1;
    req.principal = rec.principal;
    this.ticketOf.set(req.raw, rec);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ routes
  /**
   * EARLY in buildServer (before the routes): the websocket plugin — it wraps every route registered after it, so that an
   * upgrade request to a route that is not a websocket is closed — and the hook that re-checks credentials after a logout or a
   * key change. Fastify binds hooks to the routes registered AFTER them: this one must precede the auth and developer routes.
   */
  async install(app: FastifyInstance): Promise<void> {
    this.app = app;
    const engine = this;
    await app.register(websocket, {
      options: { maxPayload: this.limits.maxFrameBytes, perMessageDeflate: false },
      // graceful shutdown: every client is told (1001 + reason) before the listener goes away
      preClose(done) { engine.shutdown(); this.websocketServer.close(() => done()); },
      errorHandler(err, socket) { engine.log('warn', { msg: 'quotes.socket.error', err: (err as Error)?.message }); try { socket.terminate(); } catch { /* gone */ } },
    });

    // a logout, a revoked device or a revoked / rotated / changed key must close its sockets now, not at the next periodic check
    app.addHook('onResponse', async (req, reply) => {
      if (this.conns.size === 0 || req.method === 'GET' || reply.statusCode >= 400) return;
      const route = req.routeOptions.url ?? '';
      if (route.startsWith('/api/v1/auth/') || route.startsWith('/api/v1/developer/keys') || route.startsWith('/api/v1/security/')) void this.recheck();
    });
  }

  /** LATE in buildServer (after the trading API installed `principal` and the scope guard): the four routes */
  routes(app: FastifyInstance): void {
    /** before the upgrade: who is it, is the Origin ours (cookie only), is there room */
    const gate = async (req: FastifyRequest): Promise<void> => {
      const p = req.principal;
      if (!p) throw new UserError('unauthenticated', 'authentication required', 401);
      const ticket = this.ticketOf.get(req.raw);
      if (p.kind === 'owner' && !ticket) {
        // A websocket handshake is a GET that carries the session cookie from ANY page: CORS does not apply to it and the
        // SameSite attribute is the only other barrier. The Origin header (set by the browser, not by the page) must be ours.
        if (req.headers.origin !== config.origin) { this.counters.refused += 1; throw new UserError('origin_refused', 'cross-origin websocket refused', 403); }
      }
      if (this.closing) throw new UserError('shutting_down', 'the server is shutting down', 503);
      if (this.conns.size >= this.limits.maxConnectionsTotal || (this.perWho.get(who(p)) ?? 0) >= this.limitFor(p)) { this.counters.refused += 1; throw new UserError('too_many_connections', 'too many stream connections for this principal', 429); }
    };
    const accept = (socket: WebSocket, req: FastifyRequest): void => {
      const p = req.principal ?? OWNER, ticket = this.ticketOf.get(req.raw);
      // the limit again, atomically with the registration (two handshakes may have passed the gate together)
      if ((this.perWho.get(who(p)) ?? 0) >= this.limitFor(p) || this.conns.size >= this.limits.maxConnectionsTotal) { this.counters.refused += 1; socket.close(1013, 'too many stream connections'); return; }
      const auth: Auth = ticket ? { principal: p, sessionToken: ticket.sessionToken, via: 'ticket' } : p.kind === 'owner' ? { principal: p, sessionToken: req.cookies[COOKIE] ?? null, via: 'cookie' } : { principal: p, sessionToken: null, via: 'key' };
      const c = new Conn(this, socket, auth, req.ip);
      this.conns.add(c); this.perWho.set(who(p), (this.perWho.get(who(p)) ?? 0) + 1); this.counters.connections += 1;
      this.startTimers();
      this.log('info', { msg: 'quotes.conn.open', conn: c.id, who: who(p), via: auth.via, ip: req.ip });
    };

    app.get(STREAM_PATH, { websocket: true, preValidation: async (req) => { if (req.principal?.kind !== 'owner') throw new UserError('unauthenticated', 'authentication required', 401); await gate(req); } }, accept);
    app.get(TRADING_STREAM_PATH, { websocket: true, config: { scope: 'markets:read' }, preValidation: gate }, accept);
    app.post(TICKET_PATH, { config: { scope: 'markets:read' } }, async (req) => {
      const p = req.principal;
      if (!p) throw new UserError('unauthenticated', 'authentication required', 401);
      const t = this.issueTicket(p, p.kind === 'owner' ? req.cookies[COOKIE] ?? null : null);
      return { ticket: t.ticket, expiresAt: t.expiresAt, ttlMs: this.limits.ticketTtlMs, url: `${TRADING_STREAM_PATH}?ticket=${t.ticket}`, protocol: V };
    });
    app.get(STATS_PATH, async () => this.stats());
  }
}

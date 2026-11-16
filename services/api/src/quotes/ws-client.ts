// A reconnecting websocket CLIENT for public market-data feeds (used by the spot upstream; the perpetual venues have their own
// stream clients in @spw/derivatives, written to each venue's protocol).
//
// - opened by `start()`, closed by `stop()`; while started it reconnects by itself: exponential backoff with jitter, reset only
//   after a connection that lasted (a server that accepts and drops at once is not hammered);
// - `onOpen(again)` is called on every (re)connection: the owner sends its subscriptions again there;
// - liveness: no frame at all for `staleAfterMs` → 'stale'; still nothing after `staleGraceMs` → the socket is dropped and re-opened.
//   `ping` (optional) is sent every `pingIntervalMs` for feeds that need a client heartbeat.
import { backoffMs } from './shared.ts';

export interface WsLike {
  send(data: string): void; close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;
export type WsStatus = 'connected' | 'reconnecting' | 'stale';

export interface ReconnectingWsOptions {
  url: string; WebSocket?: WsCtor | undefined; now?: (() => number) | undefined; random?: (() => number) | undefined;
  backoffMinMs?: number; backoffMaxMs?: number; staleAfterMs?: number; staleGraceMs?: number;
  pingIntervalMs?: number; ping?: () => string;
  onOpen(again: boolean): void; onMessage(text: string): void; onStatus(s: WsStatus): void;
}
const STABLE_MS = 10_000;

export function createReconnectingWs(o: ReconnectingWsOptions) {
  const now = o.now ?? Date.now, random = o.random ?? Math.random;
  const backoffMin = o.backoffMinMs ?? 1000, backoffMax = o.backoffMaxMs ?? 30_000, staleAfter = o.staleAfterMs ?? 20_000, staleGrace = o.staleGraceMs ?? 10_000;
  let ws: WsLike | null = null, open = false, started = false, everConnected = false, attempt = 0, lastMessageAt = 0, openedAt = 0;
  let status: WsStatus | 'idle' = 'idle';
  let retry: ReturnType<typeof setTimeout> | null = null, watch: ReturnType<typeof setInterval> | null = null, pinger: ReturnType<typeof setInterval> | null = null;
  const st = { connects: 0, messages: 0, reconnects: 0 };

  const set = (s: WsStatus): void => { if (status !== s) { status = s; try { o.onStatus(s); } catch { /* the owner must not break the client */ } } };
  const drop = (): void => {
    if (watch) clearInterval(watch); if (pinger) clearInterval(pinger);
    watch = pinger = null;
    if (ws) { const old = ws; ws = null; open = false; old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* already closed */ } }
  };
  const schedule = (): void => {
    if (open && now() - openedAt >= STABLE_MS) attempt = 0;
    drop();
    if (!started) { status = 'idle'; return; }
    set('reconnecting');
    if (retry) return;
    const delay = backoffMs(attempt, backoffMin, backoffMax, random);
    attempt += 1; st.reconnects += 1;
    retry = setTimeout(() => { retry = null; connect(); }, delay);
    retry.unref?.();
  };
  function connect(): void {
    if (ws || !started) return;
    const Ctor = o.WebSocket ?? (globalThis as { WebSocket?: WsCtor }).WebSocket;
    if (!Ctor) { set('reconnecting'); return; }
    let sock: WsLike;
    try { sock = new Ctor(o.url); } catch { schedule(); return; }
    ws = sock; st.connects += 1;
    sock.onopen = () => {
      if (ws !== sock) return;
      open = true; lastMessageAt = openedAt = now();
      const again = everConnected; everConnected = true;
      set('connected');
      try { o.onOpen(again); } catch { /* idem */ }
      if (o.ping && o.pingIntervalMs) { pinger = setInterval(() => { if (ws === sock && open) { try { sock.send(o.ping!()); } catch { /* the close handler reconnects */ } } }, o.pingIntervalMs); pinger.unref?.(); }
      watch = setInterval(() => {
        const quiet = now() - lastMessageAt;
        if (quiet > staleAfter + staleGrace) schedule();
        else if (quiet > staleAfter && status === 'connected') set('stale');
      }, Math.max(250, Math.min(1000, Math.floor(staleGrace / 4))));
      watch.unref?.();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastMessageAt = now(); st.messages += 1;
      if (status === 'stale') set('connected');
      try { o.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { /* a bad frame must not break the connection */ }
    };
    sock.onclose = () => { if (ws === sock) schedule(); };
    sock.onerror = () => { if (ws === sock) schedule(); };
  }

  return {
    start(): void { if (started) return; started = true; if (!ws && !retry) connect(); },
    stop(): void { started = false; if (retry) { clearTimeout(retry); retry = null; } drop(); status = 'idle'; everConnected = false; attempt = 0; },
    /** false when the socket is not open (the owner sends again in `onOpen`) */
    send(msg: unknown): boolean { if (!ws || !open) return false; try { ws.send(JSON.stringify(msg)); return true; } catch { return false; } },
    get open(): boolean { return open; },
    stats: () => ({ ...st, status }),
  };
}
export type ReconnectingWs = ReturnType<typeof createReconnectingWs>;

// Reconciliation of a quoting session from the venue's USER STREAMS instead of REST polling.
//
// The foundations reconciled every 5 s with three REST reads (`frontendOpenOrders` 20 + `clearinghouseState` 2 +
// `userFillsByTime` 20) and measured about 955 of the venue's 1 200 IP weight per minute for one instrument
// (docs/V11-MARKET-MAKING.md §7). This wraps the engine's `OrderPort`: the engine's reads — open orders, fills, the status of one
// order — are answered from the state the venue's `orderUpdates` and `userFills` WebSocket subscriptions keep up to date
// (official documentation: /for-developers/api/websocket/subscriptions — `orderUpdates` → `WsOrder[]` `{ order: WsBasicOrder,
// status, statusTimestamp }`, `userFills` → `{ isSnapshot?, user, fills }`; both parsed by the stream client of
// packages/derivatives and checked on recorded public frames in test/mm-user-stream.test.ts). WebSocket traffic costs no IP weight.
//
// REST is still read — the venue's REST state stays the reference the stream is audited against:
//   start-up        before the first answer, and after every (re)connection of the stream (`orderUpdates` has no snapshot);
//   a gap           the client reports `gap` / a status other than `connected`: nothing the stream said is trusted until a REST
//                   read; while the stream is down REST is read at most every `restMinIntervalMs`, and the last REST state is
//                   served in between (the session's quotes are pulled meanwhile: `status()` is part of the market status);
//   safety cadence  a full REST audit every `auditEveryMs` (default 60 s): open orders, fills since the cursor, account. A
//                   difference with the stream state is counted, reported (`onDivergence`) and REST wins.
//   the position    `clearinghouseState` (weight 2) when a fill was seen or the last read is older than `accountMaxAgeMs`: the
//                   position is never derived from the stream (the stream's fills carry no account state).
//   one order       `orderStatus` (weight 2) only for a client id the stream never mentioned.
//
// What the wrapper adds to the stream state itself, from the answers of the actions it relays: an order the venue answered
// `resting` is listed at once (the stream's own update may arrive later); a cancel the venue confirmed removes it. A final
// state is never left (a late `open` update of an order already cancelled does not bring it back).
import type { Fill, HlOrderUpdate } from '@spw/derivatives';
import type { AccountRead, BatchOutcome, CancelOutcome, OrderLookup, OrderPort, QuoteOrder, VenueFill, VenueOpenOrder, VenueStatus } from './ports.ts';

/** the account feed of the venue's stream client (`HlStream.subscribe({ type: 'account', account })`), or a replay of it */
export type UserFeedEvent =
  | { type: 'fills'; fills: Fill[]; snapshot: boolean }
  | { type: 'orders'; orders: HlOrderUpdate[] }
  | { type: 'cancelled_by_venue'; orders: { instrument: string; venueOrderId: string }[] }
  | { type: 'funding'; payment: { instrument: string; amount: string; ts: number } }
  | { type: 'gap'; reason: string }
  | { type: string };
export interface UserFeed { subscribe(account: string, on: (ev: UserFeedEvent) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void): () => void }
export interface UserStreamOptions {
  account: string; feed: UserFeed; now: () => number;
  auditEveryMs?: number; restMinIntervalMs?: number; accountMaxAgeMs?: number;
  onDivergence?: (d: { instrument: string; onlyStream: string[]; onlyRest: string[] }) => void;
}
interface Entry { instrument: string; clientId: string | null; venueOrderId: string; side: 'buy' | 'sell'; price: string; remaining: string; state: 'open' | 'filled' | 'cancelled' | 'rejected'; reduceOnly: boolean; createdAt: number; updatedAt: number }
export interface UserStreamStats { status: VenueStatus; synced: boolean; rest: { openOrders: number; fills: number; account: number; lookup: number }; streamOrders: number; streamFills: number; audits: number; divergences: number; gaps: number; lastAuditAt: number | null; lastRestAt: number | null }
export type StreamReconciledPort = OrderPort & { status(): VenueStatus; stats(): UserStreamStats; close(): void; /** funding settlements of an instrument the stream delivered since the last call (the venue's signed USDC amount: negative = paid) */ takeFunding(instrument: string): { amount: string; ts: number }[]; /** the venue cancelled orders by itself (liquidation, the dead man's switch): they are gone */ };

const FINAL = new Set(['filled', 'cancelled', 'rejected']);

export function streamReconciled(inner: OrderPort, o: UserStreamOptions): StreamReconciledPort {
  const auditEvery = o.auditEveryMs ?? 60_000, restMin = o.restMinIntervalMs ?? 10_000, accountMaxAge = o.accountMaxAgeMs ?? 15_000;
  const byOid = new Map<string, Entry>(), byClient = new Map<string, Entry>();
  const fills = new Map<string, VenueFill>(), reduceIds = new Set<string>();
  let fundings: { instrument: string; amount: string; ts: number }[] = [];
  let status: VenueStatus = 'idle', synced = false, lastAuditAt = -Infinity, lastRestAt = -Infinity, buffering: UserFeedEvent[] | null = null;
  let everSynced = false;
  let account: AccountRead | null = null, accountAt = -Infinity, accountDirty = true, fillsCursor = 0;
  const st = { rest: { openOrders: 0, fills: 0, account: 0, lookup: 0 }, streamOrders: 0, streamFills: 0, audits: 0, divergences: 0, gaps: 0 };

  const put = (e: Entry): void => {
    const cur = byOid.get(e.venueOrderId) ?? (e.clientId ? byClient.get(e.clientId) : undefined);
    if (cur && FINAL.has(cur.state) && !FINAL.has(e.state)) return;                               // a final state is never left
    if (cur && cur.updatedAt > e.updatedAt && FINAL.has(cur.state) === FINAL.has(e.state)) return; // an older message of the same kind
    const next = { ...e, reduceOnly: e.reduceOnly || (cur?.reduceOnly ?? false) || (e.clientId !== null && reduceIds.has(e.clientId)) };
    byOid.set(e.venueOrderId, next); if (e.clientId) byClient.set(e.clientId, next);
    if (byOid.size > 4000) for (const [k, v] of byOid) { if (FINAL.has(v.state)) { byOid.delete(k); if (v.clientId) byClient.delete(v.clientId); } if (byOid.size <= 3000) break; }
  };
  const addFill = (f: VenueFill): void => { if (!fills.has(f.id)) { fills.set(f.id, f); accountDirty = true; if (fills.size > 5000) fills.delete(fills.keys().next().value!); } };
  const apply = (ev: UserFeedEvent): void => {
    if (ev.type === 'orders') for (const u of (ev as Extract<UserFeedEvent, { type: 'orders' }>).orders) {
      st.streamOrders += 1;
      const state: Entry['state'] = u.status === 'open' || u.status === 'partially_filled' || u.status === 'triggered' || u.status === 'pending' ? 'open' : u.status === 'filled' ? 'filled' : u.status === 'rejected' ? 'rejected' : 'cancelled';
      put({ instrument: u.instrument, clientId: u.clientId, venueOrderId: u.venueOrderId, side: u.side, price: u.price, remaining: u.remaining, state, reduceOnly: false, createdAt: u.createdAt, updatedAt: u.updatedAt });
      if (state !== 'open') accountDirty = true;
    } else if (ev.type === 'fills') for (const f of (ev as Extract<UserFeedEvent, { type: 'fills' }>).fills) {
      st.streamFills += 1;
      const clientId = f.clientId ?? byOid.get(f.orderId ?? '')?.clientId ?? null;
      // a quote is post-only: it can only be a maker fill; a reduce-only unwind is an IOC: a taker fill
      addFill({ id: f.id, clientId, venueOrderId: String(f.orderId ?? ''), side: f.side, price: f.price, size: f.size, fee: f.fee, ts: f.ts, maker: !(clientId !== null && reduceIds.has(clientId)) });
    } else if (ev.type === 'cancelled_by_venue') for (const c of (ev as Extract<UserFeedEvent, { type: 'cancelled_by_venue' }>).orders) {
      const cur = byOid.get(c.venueOrderId);
      if (cur) put({ ...cur, state: 'cancelled', updatedAt: o.now() });
    } else if (ev.type === 'funding') { const p = (ev as Extract<UserFeedEvent, { type: 'funding' }>).payment; fundings.push({ instrument: p.instrument, amount: p.amount, ts: p.ts }); if (fundings.length > 200) fundings.shift(); }
    else if (ev.type === 'gap') { st.gaps += 1; synced = false; }
  };
  const off = o.feed.subscribe(o.account, (ev) => { if (buffering) buffering.push(ev); else apply(ev); }, (s) => { if (s !== 'connected' && status === 'connected') { st.gaps += 1; synced = false; lastRestAt = -Infinity; /* nothing the stream said is trusted any more: the next read is a REST read, at once */ } if (s === 'connected' && status !== 'connected') synced = false; status = s; });

  /** the full REST read: the reference. What the stream said while it was in flight is applied on top. */
  const rest = async (instrument: string): Promise<void> => {
    buffering = [];
    try {
      const open = await inner.openOrders(instrument); st.rest.openOrders += 1;
      const got = await inner.fills(instrument, fillsCursor); st.rest.fills += 1;
      account = await inner.account(instrument); st.rest.account += 1; accountAt = o.now(); accountDirty = false;
      if (synced) {
        // an audit: what the stream believed against what the venue lists
        const mine = [...byOid.values()].filter((e) => e.instrument === instrument && e.state === 'open').map((e) => e.venueOrderId), theirs = open.map((x) => x.venueOrderId);
        const onlyStream = mine.filter((x) => !theirs.includes(x)), onlyRest = theirs.filter((x) => !mine.includes(x));
        st.audits += 1;
        // what changed while the read was in flight is not a difference: only what the buffered events do not explain
        const explained = new Set(buffering.flatMap((ev) => (ev.type === 'orders' ? (ev as Extract<UserFeedEvent, { type: 'orders' }>).orders.map((u) => u.venueOrderId) : [])));
        const a = onlyStream.filter((x) => !explained.has(x)), b = onlyRest.filter((x) => !explained.has(x));
        if (a.length || b.length) { st.divergences += 1; o.onDivergence?.({ instrument, onlyStream: a, onlyRest: b }); }
      }
      const listed = new Set(open.map((x) => x.venueOrderId));
      // open for the stream, not listed by the venue: gone (filled or cancelled) — the fills and `lookup` say which
      for (const e of [...byOid.values()]) if (e.instrument === instrument && e.state === 'open' && !listed.has(e.venueOrderId)) { byOid.delete(e.venueOrderId); if (e.clientId) byClient.delete(e.clientId); }
      for (const x of open) {
        const e: Entry = { instrument, clientId: x.clientId, venueOrderId: x.venueOrderId, side: x.side, price: x.price, remaining: x.size, state: 'open', reduceOnly: x.reduceOnly, createdAt: x.timestamp, updatedAt: x.timestamp };
        byOid.set(e.venueOrderId, e); if (e.clientId) byClient.set(e.clientId, e);
      }
      // a fill the venue reports and the stream never delivered (while it claimed to be connected): a missed event — counted, reported, REST wins
      const missed = everSynced && status === 'connected' ? got.filter((f) => !fills.has(f.id)).map((f) => `fill:${f.id}`) : [];
      if (missed.length) { st.divergences += 1; o.onDivergence?.({ instrument, onlyStream: [], onlyRest: missed }); }
      for (const f of got) { addFill(f); fillsCursor = Math.max(fillsCursor, f.ts); }
      accountDirty = false;
      const late = buffering; buffering = null;
      for (const ev of late) apply(ev);
      synced = status === 'connected'; everSynced = everSynced || synced; lastRestAt = o.now(); if (synced || status !== 'connected') lastAuditAt = o.now();
    } finally { if (buffering) { const late = buffering; buffering = null; for (const ev of late) apply(ev); } }
  };
  const ensure = async (instrument: string): Promise<void> => {
    const now = o.now();
    if (status === 'connected') { if (!synced || now - lastAuditAt >= auditEvery) await rest(instrument); return; }
    // the stream is down (or was never up): REST is the only source, read at a bounded rate
    if (now - lastRestAt >= restMin) await rest(instrument);
  };

  return {
    actionTtlMs: inner.actionTtlMs,
    status: () => status,
    stats: () => ({ status, synced, rest: { ...st.rest }, streamOrders: st.streamOrders, streamFills: st.streamFills, audits: st.audits, divergences: st.divergences, gaps: st.gaps, lastAuditAt: Number.isFinite(lastAuditAt) ? lastAuditAt : null, lastRestAt: Number.isFinite(lastRestAt) ? lastRestAt : null }),
    close: () => off(),
    takeFunding(instrument) { const mine = fundings.filter((f) => f.instrument === instrument); fundings = fundings.filter((f) => f.instrument !== instrument); return mine.map((f) => ({ amount: f.amount, ts: f.ts })); },
    async submitQuotes(instrument, quotes): Promise<BatchOutcome> {
      const r = await inner.submitQuotes(instrument, quotes);
      if (r.kind === 'done') for (const x of r.results) {
        const q = quotes.find((y) => y.clientId === x.clientId) as QuoteOrder | undefined;
        if (!q || x.outcome === 'rejected') continue;
        put({ instrument, clientId: x.clientId, venueOrderId: x.venueOrderId, side: q.side, price: q.price, remaining: x.outcome === 'filled' ? '0' : q.size, state: x.outcome === 'filled' ? 'filled' : 'open', reduceOnly: false, createdAt: o.now(), updatedAt: o.now() });
        if (x.outcome === 'filled') accountDirty = true;
      }
      return r;
    },
    async submitReduces(instrument, orders): Promise<BatchOutcome> {
      for (const q of orders) reduceIds.add(q.clientId);
      accountDirty = true;
      return inner.submitReduces(instrument, orders);
    },
    async cancel(instrument, clientIds): Promise<CancelOutcome> {
      const r = await inner.cancel(instrument, clientIds);
      if (r.kind === 'done') for (const x of r.results) {
        const cur = byClient.get(x.clientId);
        if (cur && x.outcome === 'cancelled') put({ ...cur, state: 'cancelled', updatedAt: o.now() });
        // it left before the cancel and the stream had not said so: something was missed — the next read is a full REST read
        if (x.outcome === 'gone') { accountDirty = true; if (cur && cur.state === 'open') { byOid.delete(cur.venueOrderId); byClient.delete(x.clientId); synced = false; } }
      }
      return r;
    },
    scheduleCancel: (t) => inner.scheduleCancel(t),
    async openOrders(instrument): Promise<VenueOpenOrder[]> {
      await ensure(instrument);
      return [...byOid.values()].filter((e) => e.instrument === instrument && e.state === 'open').map((e) => ({ clientId: e.clientId, venueOrderId: e.venueOrderId, side: e.side, price: e.price, size: e.remaining, reduceOnly: e.reduceOnly, timestamp: e.createdAt }));
    },
    async account(instrument): Promise<AccountRead> {
      const now = o.now();
      if (account === null || accountDirty || now - accountAt >= accountMaxAge) { account = await inner.account(instrument); st.rest.account += 1; accountAt = now; accountDirty = false; }
      return account;
    },
    async fills(_instrument, sinceMs): Promise<VenueFill[]> { return [...fills.values()].filter((f) => f.ts >= sinceMs).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)); },
    async lookup(instrument, clientId): Promise<OrderLookup> {
      const e = byClient.get(clientId);
      if (e) return e.state;
      st.rest.lookup += 1;
      return inner.lookup(instrument, clientId);
    },
    addressRequestsRemaining: () => inner.addressRequestsRemaining(),
  };
}

// What a quoting session leaves in the database — and what it does NOT.
//
// QUOTES ARE NOT ROWS OF `orders`. One instrument at one level per side places and cancels about 500 quotes in 35 minutes: as
// rows they would drown every other order and every screen. The accounting of a session is:
//   mm_sessions   ONE row per session: counters (quotes placed, cancelled, refusals by code), the PnL attribution, the markout
//                 summary, the engine's last status (the quotes resting NOW, their age and distance from the mid — live engine
//                 state, refreshed every second or two), the rate budget, the breaker events
//   mm_fills      ONE row per FILL (price, size, fee, maker, the mid at the fill), with markouts at 1 s / 10 s / 60 s computed
//                 AFTERWARDS from the tape (mm_tape: one mid per second while a session runs) — `markoutFromTape`
//   orders        ONE unified order per REDUCE-ONLY UNWIND (a directional order: hard-limit unwind, flatten), written through
//                 the order state machine of @spw/trading, principal = the agent
//   research_log  the agent journal: start, stop, breakers, halts, refusals, fills — never one line per quote
// Every quote stays in the signer's journal (by client id) and in the venue's own history.
import { randomUUID } from 'node:crypto';
import { D, type DecStr } from '@spw/derivatives';
import type { OrderEvent } from '@spw/trading';
import { MARKOUT_HORIZONS_MS, type MarkoutSummary, type PnlReport } from '@spw/trading/mm';
import { sql } from '../db.ts';
import { computePerformance, type Performance } from '../agent-runtime/performance.ts';
import { applyEvent, getOrder, insertOrder, mutate } from '../orders/store.ts';
import type { EngineStatus } from './engine.ts';
import type { OrderResult, QuoteOrder } from './ports.ts';

export type MmMode = 'PAPER' | 'LIVE';
export interface SessionRow { id: string; agent_id: string; mode: MmMode; instrument: string; network: string; account_id: string | null; mandate_id: string | null; session_hex: string; policy: string; config_version: number; worker: string | null;
  state: 'running' | 'stopped' | 'abandoned'; started_at: Date; ended_at: Date | null; end_reason: string | null; heartbeat_at: Date; counters: Record<string, number>; pnl: Partial<PnlReport>; markouts: MarkoutSummary[]; status: Record<string, unknown>;
  refusals: Record<string, number>; budget: Record<string, unknown>; breakers: { ts: number; code: string; action: string }[]; command: SessionCommand | null; command_ack: { id: string; at: number; result: string } | null }
export interface SessionCommand { id: string; command: 'pull' | 'flatten' | 'resume'; by: string; at: number }

export const newSessionHex = (): string => randomUUID().replace(/-/g, '').slice(0, 16);
export async function openSession(o: { agentId: string; mode: MmMode; instrument: string; network: string; accountId: string | null; mandateId: string | null; policy: string; configVersion: number; worker: string; now: number }): Promise<SessionRow> {
  // a session left `running` by a worker that died is closed as abandoned: its successor starts with the engine's start-up sequence
  await sql`update mm_sessions set state = 'abandoned', ended_at = ${new Date(o.now)}, end_reason = coalesce(end_reason, 'the worker that ran this session stopped; a new session took over') where agent_id = ${o.agentId} and state = 'running'`;
  const [r] = await sql<SessionRow[]>`insert into mm_sessions (id, agent_id, mode, instrument, network, account_id, mandate_id, session_hex, policy, config_version, worker, started_at, heartbeat_at)
    values (${randomUUID()}, ${o.agentId}, ${o.mode}, ${o.instrument}, ${o.network}, ${o.accountId}, ${o.mandateId}, ${newSessionHex()}, ${o.policy}, ${o.configVersion}, ${o.worker}, ${new Date(o.now)}, ${new Date(o.now)}) returning *`;
  return r!;
}
/** the live state of the session, as the engine holds it now: what the owner's screen reads (a session runs in ONE worker; the API may be another process) */
export async function saveSession(id: string, now: number, s: { status: EngineStatus; view: Record<string, unknown>; refusals: Record<string, number>; budget: Record<string, unknown>; breakers: SessionRow['breakers'] }): Promise<SessionCommand | null> {
  const [r] = await sql<{ command: SessionCommand | null }[]>`update mm_sessions set heartbeat_at = ${new Date(now)}, counters = ${sql.json(s.status.counters as never)}, pnl = ${sql.json(s.status.pnl as never)}, markouts = ${sql.json(s.status.markouts as never)},
    status = ${sql.json(s.view as never)}, refusals = ${sql.json(s.refusals as never)}, budget = ${sql.json(s.budget as never)}, breakers = ${sql.json(s.breakers.slice(-200) as never)} where id = ${id} returning command`;
  return r?.command ?? null;
}
export async function closeSession(id: string, now: number, reason: string, state: 'stopped' | 'abandoned' = 'stopped'): Promise<void> {
  await sql`update mm_sessions set state = ${state}, ended_at = ${new Date(now)}, end_reason = ${reason.slice(0, 300)}, command = null where id = ${id} and state = 'running'`;
}
export async function ackCommand(id: string, c: SessionCommand, now: number, result: string): Promise<void> {
  await sql`update mm_sessions set command = null, command_ack = ${sql.json({ id: c.id, at: now, result } as never)} where id = ${id} and command->>'id' = ${c.id}`;
}
/** the owner's instruction for the worker that runs the session; null when no session is running */
export async function postCommand(agentId: string, command: SessionCommand['command'], by: string, now: number): Promise<{ sessionId: string; command: SessionCommand } | null> {
  const c: SessionCommand = { id: randomUUID(), command, by, at: now };
  const [r] = await sql<{ id: string }[]>`update mm_sessions set command = ${sql.json(c as never)} where id = (select id from mm_sessions where agent_id = ${agentId} and state = 'running' order by started_at desc limit 1) returning id`;
  return r ? { sessionId: r.id, command: c } : null;
}
export const runningSession = async (agentId: string): Promise<SessionRow | null> => (await sql<SessionRow[]>`select * from mm_sessions where agent_id = ${agentId} and state = 'running' order by started_at desc limit 1`)[0] ?? null;
export const listSessions = async (agentId: string, mode: MmMode, limit = 20): Promise<SessionRow[]> => sql<SessionRow[]>`select * from mm_sessions where agent_id = ${agentId} and mode = ${mode} order by started_at desc limit ${Math.min(Math.max(limit, 1), 100)}`;

// ------------------------------------------------------------------------------------------------------------------ fills, tape, markouts

export interface FillInput { sessionId: string; agentId: string; mode: MmMode; instrument: string; accountId: string | null; fillId: string; clientId: string | null; venueOrderId: string | null; side: 'buy' | 'sell'; price: DecStr; size: DecStr; fee: DecStr; maker: boolean; reduce: boolean; mid: DecStr | null; ts: number }
export async function recordFill(f: FillInput): Promise<boolean> {
  const ins = await sql`insert into mm_fills (session_id, agent_id, mode, instrument, account_id, fill_id, client_id, venue_order_id, side, price, size, fee, maker, reduce, mid, ts)
    values (${f.sessionId}, ${f.agentId}, ${f.mode}, ${f.instrument}, ${f.accountId}, ${f.fillId}, ${f.clientId}, ${f.venueOrderId}, ${f.side}, ${f.price}, ${f.size}, ${f.fee}, ${f.maker}, ${f.reduce}, ${f.mid}, ${new Date(f.ts)})
    on conflict (session_id, fill_id) do nothing returning id`;
  return ins.length > 0;
}
export async function recordTape(instrument: string, network: string, ts: number, mid: DecStr): Promise<void> {
  await sql`insert into mm_tape (instrument, network, ts, mid) values (${instrument}, ${network}, ${new Date(Math.floor(ts / 1000) * 1000)}, ${mid}) on conflict do nothing`;
}
export async function pruneTape(now: number, keepMs = 2 * 86_400_000): Promise<void> { await sql`delete from mm_tape where ts < ${new Date(now - keepMs)}`; }

/** how late after a horizon a mid may still stand for "the mid at the horizon" (the tape has one point a second; a gap longer than this is no measure) */
export const MARKOUT_TOLERANCE_MS = 5_000;
/**
 * Markouts of ONE fill from a tape of mids (oldest first). The definition of the core (packages/trading/src/mm/metrics.ts):
 * for each horizon the FIRST mid observed at or after `fill.ts + horizon`, against the fill price, in basis points, signed so
 * that NEGATIVE is adverse selection —   buy: (mid − px) / px    sell: (px − mid) / px    × 10 000, 4 decimals, half-even.
 * null when the tape has no mid within `MARKOUT_TOLERANCE_MS` after the horizon.
 */
export function markoutFromTape(fill: { ts: number; side: 'buy' | 'sell'; price: DecStr }, tape: readonly { ts: number; mid: DecStr }[]): (DecStr | null)[] {
  const px = D.from(fill.price);
  return MARKOUT_HORIZONS_MS.map((h) => {
    const at = fill.ts + h, p = tape.find((x) => x.ts >= at);
    if (!p || p.ts > at + MARKOUT_TOLERANCE_MS || !D.isPos(px)) return null;
    const m = D.from(p.mid);
    return D.str(D.div(D.mul(fill.side === 'buy' ? D.sub(m, px) : D.sub(px, m), D.from(10000n)), px, 4, 'half_even'));
  });
}
/** fills old enough for their 60 s horizon get their markouts from the tape, once */
export async function settleMarkouts(now: number, limit = 200): Promise<number> {
  const rows = await sql<{ id: string; instrument: string; network: string; side: 'buy' | 'sell'; price: string; ts: Date }[]>`select f.id, f.instrument, s.network, f.side, f.price::text as price, f.ts from mm_fills f join mm_sessions s on s.id = f.session_id
    where not f.markouts_done and f.ts < ${new Date(now - 60_000 - MARKOUT_TOLERANCE_MS)} order by f.ts limit ${limit}`;
  for (const f of rows) {
    const t = f.ts.getTime();
    const tape = (await sql<{ ts: Date; mid: string }[]>`select ts, mid::text as mid from mm_tape where instrument = ${f.instrument} and network = ${f.network} and ts >= ${new Date(t)} and ts <= ${new Date(t + 60_000 + MARKOUT_TOLERANCE_MS + 1000)} order by ts`).map((x) => ({ ts: x.ts.getTime(), mid: x.mid }));
    const [a, b, c] = markoutFromTape({ ts: t, side: f.side, price: f.price }, tape);
    await sql`update mm_fills set markout_1s = ${a ?? null}, markout_10s = ${b ?? null}, markout_60s = ${c ?? null}, markouts_done = true where id = ${f.id}`;
  }
  return rows.length;
}
export async function listFills(agentId: string, mode: MmMode, q: { limit?: number; sessionId?: string } = {}) {
  const rows = await sql`select id, session_id, fill_id, client_id, side, price::text as price, size::text as size, fee::text as fee, maker, reduce, mid::text as mid, ts, markout_1s::text as m1, markout_10s::text as m10, markout_60s::text as m60, markouts_done
    from mm_fills where agent_id = ${agentId} and mode = ${mode} and (${q.sessionId ?? null}::uuid is null or session_id = ${q.sessionId ?? null}::uuid) order by ts desc, id desc limit ${Math.min(Math.max(q.limit ?? 100, 1), 500)}`;
  return rows.map((r) => ({ id: String(r.id), sessionId: r.session_id as string, fillId: r.fill_id as string, clientId: r.client_id as string | null, side: r.side as 'buy' | 'sell', price: r.price as string, size: r.size as string, fee: r.fee as string, maker: r.maker as boolean, reduce: r.reduce as boolean,
    mid: r.mid as string | null, ts: (r.ts as Date).getTime(), markoutsBps: { '1s': r.m1 as string | null, '10s': r.m10 as string | null, '60s': r.m60 as string | null }, markoutsDone: r.markouts_done as boolean }));
}

// ------------------------------------------------------------------------------------------------------------------ performance, per mode

const sum = (xs: (string | undefined | null)[]): DecStr => D.str(xs.reduce((a, x) => D.add(a, D.from(x ?? '0')), D.zero));
export interface MmPerformance { mode: 'paper' | 'live'; label: string; sessions: number; fills: number; volumeUsd: DecStr; attribution: { totalUsd: DecStr; spreadCaptureUsd: DecStr; inventoryPnlUsd: DecStr; feesUsd: DecStr; fundingUsd: DecStr; bpsOfVolume: DecStr | null };
  markouts: { horizon: '1s' | '10s' | '60s'; fills: number; meanBps: string | null }[]; performance: Omit<Performance, 'returns'>; note: string }
/**
 * The figures of ONE mode, never the two added: the attribution of the sessions of that mode (spread capture, inventory, fees,
 * funding — the engine's exact identity, summed over sessions), the markouts of its fills from the tape, and the agents'
 * performance module on the equity points of that mode (the same `computePerformance` as every other agent).
 */
export async function mmPerformance(agentId: string, mode: MmMode): Promise<MmPerformance> {
  const sessions = await sql<Pick<SessionRow, 'pnl'>[]>`select pnl from mm_sessions where agent_id = ${agentId} and mode = ${mode}`;
  const total = sum(sessions.map((s) => s.pnl.totalUsd)), volume = sum(sessions.map((s) => s.pnl.volumeUsd));
  const [m] = await sql<{ n1: number; a1: string | null; n10: number; a10: string | null; n60: number; a60: string | null; fills: number }[]>`select count(markout_1s)::int as n1, round(avg(markout_1s), 4)::text as a1, count(markout_10s)::int as n10, round(avg(markout_10s), 4)::text as a10,
    count(markout_60s)::int as n60, round(avg(markout_60s), 4)::text as a60, count(*)::int as fills from mm_fills where agent_id = ${agentId} and mode = ${mode} and maker`;
  const equity = (await sql<{ ts: Date; equity_usd: number }[]>`select ts, equity_usd from agent_equity where agent_id = ${agentId} and mode = ${mode} order by ts`).map((e) => ({ ts: e.ts.getTime(), equity: Number(e.equity_usd) }));
  const trades = (await sql<{ ts: Date; n: number; fee: number }[]>`select ts, (price * size)::float as n, fee::float as fee from mm_fills where agent_id = ${agentId} and mode = ${mode} order by ts`).map((t) => ({ ts: t.ts.getTime(), notionalUsd: t.n, feeUsd: t.fee, slippageUsd: null, closedPnlUsd: null }));
  const { returns: _r, ...perf } = computePerformance({ equity, trades, funding: [], notes: { slippage: 'a maker fill has no slippage; adverse selection is measured by the markouts', funding: 'inside the attribution (fundingUsd)', trades: 'a quoting session has fills, not round-trip trades: win rate and profit factor are not computed' } }); void _r;
  return { mode: mode === 'PAPER' ? 'paper' : 'live', label: mode === 'PAPER' ? 'PAPER — SIMULATED fills on real books (a fill only when the market trades through the quote); no money moved' : 'LIVE — real fills on the venue', sessions: sessions.length, fills: m?.fills ?? 0, volumeUsd: volume,
    attribution: { totalUsd: total, spreadCaptureUsd: sum(sessions.map((s) => s.pnl.spreadCaptureUsd)), inventoryPnlUsd: sum(sessions.map((s) => s.pnl.inventoryPnlUsd)), feesUsd: sum(sessions.map((s) => s.pnl.feesUsd)), fundingUsd: sum(sessions.map((s) => s.pnl.fundingUsd)),
      bpsOfVolume: D.isPos(D.from(volume)) ? D.str(D.div(D.mul(D.from(total), D.from(10000n)), D.from(volume), 4, 'half_even')) : null },
    markouts: [{ horizon: '1s', fills: m?.n1 ?? 0, meanBps: m?.a1 ?? null }, { horizon: '10s', fills: m?.n10 ?? 0, meanBps: m?.a10 ?? null }, { horizon: '60s', fills: m?.n60 ?? 0, meanBps: m?.a60 ?? null }],
    performance: { ...perf, equityCurve: perf.equityCurve.slice(-1000) }, note: 'attribution: total = spread capture + inventory PnL + fees + funding (exact). Markouts: mid at the horizon against the fill price, negative = adverse selection.' };
}
/** PnL of the UTC day of `now` in ONE mode, without the running session (whose own total the engine adds) */
export async function dayPnlBefore(agentId: string, mode: MmMode, now: number, exceptSession: string): Promise<DecStr> {
  const day = new Date(Math.floor(now / 86_400_000) * 86_400_000);
  const rows = await sql<Pick<SessionRow, 'pnl'>[]>`select pnl from mm_sessions where agent_id = ${agentId} and mode = ${mode} and started_at >= ${day} and id <> ${exceptSession}`;
  return sum(rows.map((s) => s.pnl.totalUsd));
}

// ------------------------------------------------------------------------------------------------------------------ unwinds as unified orders

const UNWIND = 'mm-unwind';
export const unwindOrderId = (clientId: string): string => `${UNWIND}:${clientId}`;
/**
 * A reduce-only unwind as ONE unified order, written when its outcome is known (or known to be unknown) — never left half-way:
 * validated → approved by the mandate → submitted → filled / rejected / UNKNOWN. An UNKNOWN one is settled by `settleUnwind`
 * when the engine's reconcile has read the venue. `engine: 'none'`: the order service's projector and reconciler leave it alone.
 */
export async function recordUnwind(o: { agentId: string; mode: MmMode; network: string; instrument: string; accountId: string | null; mandateId: string | null; sessionId: string; why: string; order: QuoteOrder; now: number;
  outcome: { kind: 'done'; result: OrderResult | null } | { kind: 'refused'; stage: string; code: string; message: string } | { kind: 'unknown'; message: string } }): Promise<void> {
  const id = unwindOrderId(o.order.clientId), mode = o.mode === 'PAPER' ? 'paper' as const : 'live' as const;
  const notional = D.str(D.mul(D.from(o.order.price), D.from(o.order.size)));
  await insertOrder({ id, principal: { kind: 'agent', id: o.agentId }, idempotencyKey: id, bodyHash: null, mode, venue: 'hyperliquid', network: o.network, instrument: o.instrument, marketKind: 'perp', side: o.order.side, type: 'limit', reduceOnly: true,
    accountId: o.accountId, mandateId: o.mandateId, canonical: null, orderHash: null, size: o.order.size, engine: 'none', engineRef: null, notionalUsd: notional, origin: 'agent',
    detail: { source: 'market_making', why: o.why, sessionId: o.sessionId, clientOrderId: o.order.clientId, limitPrice: o.order.price, tif: 'ioc', simulated: mode === 'paper' }, createdAt: o.now });
  const events: OrderEvent[] = [{ type: 'validated', detail: `reduce-only unwind of a quoting session (${o.why})` }, { type: 'approved', by: 'mandate', detail: mode === 'paper' ? 'paper: nothing is signed' : 'inside the quoting mandate (the signer bounds a reduce-only order by instrument, price band and size)' }, { type: 'submit_started' }];
  const out = o.outcome;
  if (out.kind === 'refused') events.splice(2, 1, out.stage === 'venue' ? { type: 'submit_started' } : { type: 'local_rejected', reason: out.stage === 'signer' ? 'SIGNER_REFUSED' : 'RISK_DENIED', detail: `${out.code}: ${out.message}`.slice(0, 480) });
  if (out.kind === 'refused' && out.stage === 'venue') events.push({ type: 'venue_rejected', reason: `${out.code}: ${out.message}`.slice(0, 480) });
  if (out.kind === 'unknown') events.push({ type: 'submit_ambiguous', reason: 'SUBMIT_UNREADABLE_ANSWER', detail: out.message.slice(0, 480) });
  if (out.kind === 'done') {
    const r = out.result;
    if (!r) events.push({ type: 'submit_ambiguous', reason: 'SUBMIT_UNREADABLE_ANSWER', detail: 'the venue\'s answer did not cover this order' });
    else if (r.outcome === 'rejected') events.push({ type: 'venue_rejected', reason: `${r.code}: ${r.reason}`.slice(0, 480) });
    else if (r.outcome === 'filled') {
      events.push({ type: 'venue_accepted', venueOrderId: r.venueOrderId }, { type: 'fill', size: r.size, price: r.price, fillId: `${o.order.clientId}:1` });
      if (D.lt(D.from(r.size), D.from(o.order.size))) events.push({ type: 'cancelled', reason: 'CANCELLED_AT_VENUE', detail: 'immediate-or-cancel: the remainder did not rest' });
    } else events.push({ type: 'venue_accepted', venueOrderId: r.venueOrderId });
  }
  await mutate(id, o.now, (row) => (row.state === 'CREATED' ? { events } : null));
}
/** the venue's word on an unwind whose outcome was unknown (the engine's reconcile by client id) */
export async function settleUnwind(clientId: string, venue: 'filled' | 'cancelled' | 'rejected' | 'never_placed', now: number, fill?: { size: DecStr; price: DecStr }): Promise<void> {
  const id = unwindOrderId(clientId), row = await getOrder(id);
  if (!row || row.state !== 'UNKNOWN') return;
  const ev: OrderEvent = venue === 'never_placed' ? { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: now, detail: 'the venue does not know this client id and the signed action can no longer be accepted' }
    : { type: 'reconciled_found', status: venue === 'filled' ? 'filled' : venue === 'rejected' ? 'rejected' : 'cancelled', filledSize: venue === 'filled' ? fill?.size ?? row.record.size ?? '0' : '0', ...(fill ? { avgFillPrice: fill.price } : {}), detail: 'settled by the session\'s reconcile (order status by client id)' };
  await applyEvent(id, ev, now).catch(() => {});
}

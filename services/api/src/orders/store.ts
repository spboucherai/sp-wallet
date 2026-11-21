/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/orders/store.ts
 * Module           : orders
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

// The unified order table (V11). The ONLY writer of `orders.record` / `orders.state` is `applyEvent`, and the only thing it does
// to a record is `transition()` of @spw/trading: an event the table does not allow throws IllegalTransitionError and nothing is
// written. Every applied event appends one row to `order_events` (append-only: a database trigger refuses updates and deletes).
import type { TransactionSql } from 'postgres';
import { newOrder, OrderEventSchema, OrderRecordSchema, transition, type CanonicalOrder, type OrderEvent, type OrderHistoryEntry, type OrderRecord, type OrderState } from '@spw/trading';
import type { DecStr } from '@spw/derivatives';
import { sql } from '../db.ts';

export type Engine = 'paper' | 'hyperliquid' | 'gmx' | 'spot' | 'none';
export type Origin = 'trading_api' | 'command' | 'agent' | 'legacy';
export interface OrderRow {
  id: string; principal_kind: 'owner' | 'agent' | 'api_key'; principal_id: string; idempotency_key: string | null; body_hash: string | null;
  mode: 'paper' | 'live' | 'research'; venue: string; network: string; instrument: string; market_kind: 'perp' | 'spot'; side: 'buy' | 'sell'; type: string; reduce_only: boolean;
  account_id: string | null; mandate_id: string | null; canonical: CanonicalOrder | null; order_hash: string | null; record: OrderRecord; state: OrderState; reason: string; version: number;
  reject_code: string | null; engine: Engine; engine_ref: string | null; engine_sig: string | null; request_expires_at: Date | null; notional_usd: string | null; origin: Origin;
  projection_error: string | null; next_reconcile_at: Date | null; detail: Record<string, unknown>; created_at: Date; updated_at: Date;
}
export interface NewOrder {
  id: string; principal: { kind: OrderRow['principal_kind']; id: string }; idempotencyKey: string | null; bodyHash: string | null; mode: OrderRow['mode']; venue: string; network: string; instrument: string;
  marketKind: OrderRow['market_kind']; side: OrderRow['side']; type: string; reduceOnly: boolean; accountId: string | null; mandateId: string | null; canonical: CanonicalOrder | null; orderHash: string | null;
  size: DecStr | null; engine: Engine; engineRef: string | null; notionalUsd: DecStr | null; origin: Origin; detail: Record<string, unknown>; createdAt: number;
}
export interface Patch { engineRef?: string | null; engineSig?: string | null; rejectCode?: string | null; requestExpiresAt?: number | null; projectionError?: string | null; nextReconcileAt?: number | null; detail?: Record<string, unknown> }
export interface Applied { row: OrderRow; entries: OrderHistoryEntry[] }
export type TransitionListener = (row: OrderRow, entry: OrderHistoryEntry) => void | Promise<void>;

type Tx = TransactionSql;
const listeners = new Set<TransitionListener>();
/** called after the transaction that recorded the transition has committed, once per history entry */
export function onTransition(fn: TransitionListener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
async function notify(a: Applied): Promise<void> {
  for (const e of a.entries) for (const l of [...listeners]) { try { await l(a.row, e); } catch (err) { console.error(`[orders] transition listener failed: ${(err as Error).message}`); } }
}

/** null when (principal, idempotency key) or the id already has an order: the caller reads the existing one */
export async function insertOrder(o: NewOrder): Promise<OrderRow | null> {
  const record = newOrder({ id: o.id, size: o.size }, o.createdAt), at = new Date(o.createdAt);
  const [row] = await sql<OrderRow[]>`insert into orders (id, principal_kind, principal_id, idempotency_key, body_hash, mode, venue, network, instrument, market_kind, side, type, reduce_only, account_id, mandate_id,
      canonical, order_hash, record, state, reason, version, engine, engine_ref, notional_usd, origin, detail, created_at, updated_at)
    values (${o.id}, ${o.principal.kind}, ${o.principal.id}, ${o.idempotencyKey}, ${o.bodyHash}, ${o.mode}, ${o.venue}, ${o.network}, ${o.instrument}, ${o.marketKind}, ${o.side}, ${o.type}, ${o.reduceOnly}, ${o.accountId},
      ${o.mandateId}, ${o.canonical ? sql.json(o.canonical as never) : null}, ${o.orderHash}, ${sql.json(record as never)}, ${record.state}, ${record.reason}, ${record.version}, ${o.engine}, ${o.engineRef},
      ${o.notionalUsd}, ${o.origin}, ${sql.json(o.detail as never)}, ${at}, ${at})
    on conflict do nothing returning *`;
  return row ?? null;
}

export async function getOrder(id: string): Promise<OrderRow | null> { const [r] = await sql<OrderRow[]>`select * from orders where id = ${id}`; return r ?? null; }
export async function getByEngineRef(engine: Engine, ref: string): Promise<OrderRow | null> { const [r] = await sql<OrderRow[]>`select * from orders where engine = ${engine} and engine_ref = ${ref}`; return r ?? null; }
export async function getByIdempotency(p: { kind: string; id: string }, key: string): Promise<OrderRow | null> {
  const [r] = await sql<OrderRow[]>`select * from orders where principal_kind = ${p.kind} and principal_id = ${p.id} and idempotency_key = ${key}`;
  return r ?? null;
}
export async function history(id: string): Promise<{ seq: number; from: string; to: string; event: string; reason: string; detail: string | null; at: number }[]> {
  return (await sql`select seq, from_state, to_state, event, reason, detail, at from order_events where order_id = ${id} order by seq`).map((e) => ({ seq: e.seq as number, from: e.from_state as string, to: e.to_state as string,
    event: e.event as string, reason: e.reason as string, detail: e.detail as string | null, at: (e.at as Date).getTime() }));
}

async function write(tx: Tx, row: OrderRow, next: OrderRecord, steps: { event: OrderEvent; entry: OrderHistoryEntry }[], patch: Patch, now: number): Promise<OrderRow> {
  for (const s of steps) {
    await tx`insert into order_events (order_id, seq, from_state, to_state, event, body, reason, detail, at) values (${row.id}, ${s.entry.seq}, ${s.entry.from}, ${s.entry.to}, ${s.entry.event}, ${tx.json(s.event as never)},
      ${s.entry.reason}, ${s.entry.detail}, ${new Date(s.entry.at)})`;
  }
  const d = (x: number | null | undefined, cur: Date | null): Date | null => (x === undefined ? cur : x === null ? null : new Date(x));
  const [out] = await tx<OrderRow[]>`update orders set record = ${tx.json(next as never)}, state = ${next.state}, reason = ${next.reason}, version = ${next.version},
      engine_ref = ${patch.engineRef === undefined ? row.engine_ref : patch.engineRef}, engine_sig = ${patch.engineSig === undefined ? row.engine_sig : patch.engineSig},
      reject_code = ${patch.rejectCode === undefined ? row.reject_code : patch.rejectCode}, request_expires_at = ${d(patch.requestExpiresAt, row.request_expires_at)},
      projection_error = ${patch.projectionError === undefined ? row.projection_error : patch.projectionError}, next_reconcile_at = ${d(patch.nextReconcileAt, row.next_reconcile_at)},
      detail = ${tx.json({ ...row.detail, ...(patch.detail ?? {}) } as never)}, updated_at = ${new Date(Math.max(now, row.updated_at.getTime()))}
    where id = ${row.id} and version = ${row.version} returning *`;
  if (!out) throw new Error(`order ${row.id} changed concurrently`);   // cannot happen under the row lock; never continue on a stale record
  return out;
}

/**
 * Applies `decide(row)`'s events to the order, under a row lock, through `transition()`. `decide` may return no event (only the
 * patch is written). An IllegalTransitionError leaves the order untouched and is thrown to the caller.
 */
export async function mutate(id: string, now: number, decide: (row: OrderRow) => { events: OrderEvent[]; patch?: Patch } | null): Promise<Applied | null> {
  const out = await sql.begin(async (tx) => {
    const [row] = await tx<OrderRow[]>`select * from orders where id = ${id} for update`;
    if (!row) return null;
    const d = decide(row);
    if (d === null) return { row, entries: [] } as Applied;
    let rec = OrderRecordSchema.parse(row.record);
    const steps: { event: OrderEvent; entry: OrderHistoryEntry }[] = [];
    for (const ev of d.events) { const e = OrderEventSchema.parse(ev), r = transition(rec, e, now); rec = r.order; steps.push({ event: e, entry: r.entry }); }
    return { row: await write(tx, row, rec, steps, d.patch ?? {}, now), entries: steps.map((s) => s.entry) } as Applied;
  }) as Applied | null;
  if (out) await notify(out);
  return out;
}
export const applyEvent = (id: string, event: OrderEvent, now: number, patch?: Patch): Promise<Applied | null> => mutate(id, now, () => ({ events: [event], ...(patch ? { patch } : {}) }));
export const patchOrder = (id: string, now: number, patch: Patch): Promise<Applied | null> => mutate(id, now, () => ({ events: [], patch }));

/** steps already computed by `advance()` on the locked row (the projector): written as they are, after being re-applied to the locked record */
export async function mutateWith(id: string, now: number, compute: (row: OrderRow, record: OrderRecord) => { steps: { event: OrderEvent; entry: OrderHistoryEntry }[]; order: OrderRecord; patch: Patch } | null): Promise<Applied | null> {
  const out = await sql.begin(async (tx) => {
    const [row] = await tx<OrderRow[]>`select * from orders where id = ${id} for update`;
    if (!row) return null;
    const c = compute(row, OrderRecordSchema.parse(row.record));
    if (c === null) return { row, entries: [] } as Applied;
    return { row: await write(tx, row, c.order, c.steps, c.patch, now), entries: c.steps.map((s) => s.entry) } as Applied;
  }) as Applied | null;
  if (out) await notify(out);
  return out;
}

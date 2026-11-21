/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/orders/attached.ts
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

// Stop-loss and take-profit ATTACHED to an order by a command (`LONG BTC-PERP 500 x2 SL 60000 TP 80000`) — V11 exec2.
//
// The command grammar resolves the entry and, next to it, the protective orders as templates (reduce-only trigger orders with
// no size yet). Nothing protective may exist before there is something to protect, so:
//
//   - the templates are STORED with the parent order (`order_attachments`, one row per parent and role) and nothing is placed;
//   - once the parent has FILLED — in whole or in part — each template is placed as a reduce-only trigger order sized to what
//     filled. A parent that fills further gets an ADDITIONAL child for the new quantity (never a cancel-and-replace: there is no
//     moment without protection, and no order of the first fill is touched);
//   - the children are ordinary orders of the order service: the same mandate check, risk engine, provenance bound and venue
//     engine as any order (an owner's LIVE child therefore waits AWAITING_APPROVAL for its own passkey; a key's child is signed
//     under its mandate);
//   - one cancels the other, as far as the venue allows: Hyperliquid — and the paper engine — have no native OCO between two
//     separately placed trigger orders, so the supervisor (the `orders` loop, every 5 s) cancels the sibling when one of the two
//     has executed, and cancels both when the position they protect is gone. Between the execution and that pass the sibling
//     still rests; being reduce-only, the venue never lets it open a position;
//   - a parent that is rejected, failed, or cancelled without a fill closes its attachments with the reason: nothing is placed.
//
// Everything is in the database: a new process continues from `order_attachments` and the unified orders alone.
import { D, type Dec, type DecStr } from '@spw/derivatives';
import { clientOrderIdFor, isTerminal, type CanonicalOrder } from '@spw/trading';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { provenance } from './provenance.ts';
import type { Caller, OrderService } from './service.ts';
import { getOrder, type OrderRow } from './store.ts';

export type AttachedRole = 'stop_loss' | 'take_profit';
export interface AttachedTemplate { role: AttachedRole; order: CanonicalOrder; hash: string }
interface Row { id: string; parent_id: string; role: AttachedRole; template: CanonicalOrder; caller: Pick<Caller, 'principal' | 'mandateId' | 'limits' | 'restrictions'>; account_id: string | null; idem: string; state: 'pending' | 'active' | 'closed';
  placed: string; children: string[]; attempts: number; reason: string | null; created_at: Date; updated_at: Date }
export const ATTACH_MAX_ATTEMPTS = 5;
const TAG: Record<AttachedRole, string> = { stop_loss: 'sl', take_profit: 'tp' };
const other = (r: AttachedRole): AttachedRole => (r === 'stop_loss' ? 'take_profit' : 'stop_loss');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const OPEN = (o: OrderRow | null): boolean => o !== null && !isTerminal(o.state);

export class Attachments {
  constructor(private readonly svc: OrderService) {}

  /** stores the templates with their parent. Idempotent. `closed`: the parent was refused — the attachments are recorded closed, with that reason. */
  async attach(parentId: string, c: Caller, accountId: string | null, idemKey: string, templates: readonly AttachedTemplate[], closed: string | null = null): Promise<void> {
    const caller = { principal: c.principal, mandateId: c.mandateId, ...(c.limits ? { limits: c.limits } : {}), ...(c.restrictions ? { restrictions: c.restrictions } : {}) };
    for (const t of templates) {
      await sql`insert into order_attachments (id, parent_id, role, template, caller, account_id, idem, state, reason) values (${`${parentId}:${t.role}`}, ${parentId}, ${t.role}, ${sql.json(t.order as never)}, ${sql.json(caller as never)}, ${accountId}, ${idemKey},
        ${closed === null ? 'pending' : 'closed'}, ${closed}) on conflict (id) do nothing`;
    }
  }

  async view(parentId: string) {
    const rows = await sql<Row[]>`select * from order_attachments where parent_id = ${parentId} order by role`;
    return Promise.all(rows.map(async (a) => {
      const kids = await Promise.all(a.children.map((id) => getOrder(id)));
      return { role: a.role, state: a.state, placed: kids.length > 0, placedSize: D.str(D.from(a.placed)), triggerPrice: a.template.triggerPrice, reason: a.reason,
        orders: kids.filter((k): k is OrderRow => k !== null).map((k) => ({ id: k.id, status: k.state, size: k.record.size, filled: k.record.filledSize, reasonCode: k.reason })),
        note: a.state === 'closed' ? (a.reason ?? 'closed') : kids.length === 0 ? 'placed once the entry has filled, sized to what filled'
          : 'reduce-only trigger order(s) sized to what filled; the sibling is cancelled by the supervisor when one executes (the venue has no native one-cancels-the-other for these orders)' };
    }));
  }

  private async close(a: Row, reason: string): Promise<void> { await sql`update order_attachments set state = 'closed', reason = ${reason.slice(0, 300)}, updated_at = now() where id = ${a.id} and state <> 'closed'`; }
  private caller(a: Row): Caller { return { principal: a.caller.principal, mandateId: a.caller.mandateId, ...(a.caller.limits ? { limits: a.caller.limits } : {}), ...(a.caller.restrictions ? { restrictions: a.caller.restrictions } : {}) }; }
  private async cancelOpen(a: Row, kids: (OrderRow | null)[]): Promise<number> {
    let n = 0;
    for (const k of kids) if (OPEN(k)) { try { await this.svc.cancel(this.caller(a), k!.id); n += 1; } catch (e) { console.error(`[orders] attached ${a.id}: cancel of ${k!.id}: ${msg(e)}`); } }
    return n;
  }
  /**
   * How much is left of what the attachments protect, on the parent's side of the account and instrument: for the owner the
   * position itself; for a key or an agent ITS part of the position (orders/provenance.ts) — its protective orders must never
   * outlive its own lot and reduce somebody else's. null = it could not be read (nothing is cancelled on a doubt).
   */
  private async protectedSize(parent: OrderRow): Promise<DecStr | null> {
    if (!parent.account_id) return null;
    try {
      const positions = parent.mode === 'paper' ? (await this.svc.deps.derivatives().paper.list()).find((x) => x.id === parent.account_id)?.positions ?? []
        : parent.engine === 'hyperliquid' ? (await this.svc.deps.live().mandateAccountState(parent.account_id)).positions : null;
      if (positions === null) return null;
      const p = positions.find((x) => x.instrument === parent.instrument);
      if (!p || !D.isPos(D.from(p.size)) || (p.side === 'long') !== (parent.side === 'buy')) return '0';
      if (parent.principal_kind === 'owner') return D.str(D.from(p.size));
      return (await provenance({ kind: parent.principal_kind, id: parent.principal_id }, parent.account_id, parent.instrument, p.side === 'long' ? p.size : D.str(D.neg(D.from(p.size))), null, '*')).own;
    } catch { return null; }
  }

  private async placeChild(a: Row, parent: OrderRow, delta: DecStr): Promise<boolean> {
    const tpl = a.template, now = this.svc.now(), idem = `${a.idem}:${TAG[a.role]}:${a.children.length}:${a.attempts}`.slice(-100), group = `${a.parent_id}:${a.role}`;
    try {
      const order = { ...tpl, size: delta, notional: null, clientOrderId: clientOrderIdFor(tpl.venue, tpl.principal, idem), createdAt: now, expiresAt: now + Math.max(60_000, tpl.expiresAt - tpl.createdAt) };
      const out = await this.svc.submitCanonical(this.caller(a), order, idem, { origin: 'command', ...(a.account_id ? { accountId: a.account_id } : {}), oco: { group, sibling: `${a.parent_id}:${other(a.role)}` } });
      const id = (out.order as { orderId: string }).orderId;
      await sql`update order_attachments set state = 'active', placed = placed + ${delta}, children = children || ${sql.json([id] as never)}, attempts = 0, reason = null, updated_at = now() where id = ${a.id}`;
      return true;
    } catch (e) {
      if (!(e instanceof UserError)) console.error(`[orders] attached ${a.id}: ${msg(e)}`);
      const why = `${e instanceof UserError ? e.code : 'internal'}: ${msg(e)}`, last = a.attempts + 1 >= ATTACH_MAX_ATTEMPTS;
      await sql`update order_attachments set attempts = attempts + 1, reason = ${(last ? `not placed after ${ATTACH_MAX_ATTEMPTS} attempts — ${why}` : why).slice(0, 300)}, state = ${last ? 'closed' : a.state}, updated_at = now() where id = ${a.id}`;
      void parent;
      return false;
    }
  }

  /** one pass over the attachments that are not closed (of one parent, or all). Restart-safe: the database is its only memory. */
  async supervise(parentId?: string): Promise<{ placed: number; cancelled: number; closed: number }> {
    const out = { placed: 0, cancelled: 0, closed: 0 };
    const rows = await sql<Row[]>`select * from order_attachments where state <> 'closed' ${parentId ? sql`and parent_id = ${parentId}` : sql``} order by parent_id, role limit 400`;
    const groups = new Map<string, Row[]>();
    for (const a of rows) groups.set(a.parent_id, [...(groups.get(a.parent_id) ?? []), a]);
    for (const [pid, group] of groups) {
      const parent = await getOrder(pid);
      if (!parent) { for (const a of group) { await this.close(a, 'the parent order no longer exists'); out.closed += 1; } continue; }
      const filled = D.from(parent.record.filledSize), done = isTerminal(parent.state);
      const kids = new Map<string, (OrderRow | null)[]>();
      for (const a of group) kids.set(a.id, await Promise.all(a.children.map((id) => getOrder(id))));
      // one cancels the other: a child that executed (even in part) ends its sibling's orders
      const hit = group.find((a) => kids.get(a.id)!.some((k) => k !== null && D.isPos(D.from(k.record.filledSize))));
      if (hit) {
        for (const a of group) {
          if (a.id !== hit.id) { out.cancelled += await this.cancelOpen(a, kids.get(a.id)!); await this.close(a, `one cancels the other: the ${hit.role === 'stop_loss' ? 'stop-loss' : 'take-profit'} executed`); out.closed += 1; }
          else if (!kids.get(a.id)!.some(OPEN)) { await this.close(a, 'executed'); out.closed += 1; }
        }
        continue;
      }
      if (done && D.isZero(filled)) { for (const a of group) { await this.close(a, `the entry order is ${parent.state} (${parent.reason}) and nothing of it filled: nothing was placed`); out.closed += 1; } continue; }
      // what filled and is not protected yet
      for (const a of group) {
        const delta = D.sub(filled, D.from(a.placed));
        if (D.isPos(delta) && await this.placeChild(a, parent, D.str(delta))) out.placed += 1;
      }
      const fresh = await sql<Row[]>`select * from order_attachments where parent_id = ${pid} and state <> 'closed'`;
      const live: { a: Row; kids: (OrderRow | null)[] }[] = [];
      for (const a of fresh) live.push({ a, kids: await Promise.all(a.children.map((id) => getOrder(id))) });
      const anyOpen = live.some((x) => x.kids.some(OPEN));
      if (!anyOpen) {
        // every child ended without executing (never approved, cancelled, refused), and the entry will not fill further
        if (done) for (const x of live) if (x.a.children.length > 0 && D.gte(D.from(x.a.placed), filled)) { await this.close(x.a, 'its orders ended without executing (not approved in time, cancelled, or refused)'); out.closed += 1; }
        continue;
      }
      // what these orders protect is gone or smaller than they are (closed or reduced by hand, by another order, liquidated):
      // they are cancelled rather than left to reduce something they were not placed for
      const left = await this.protectedSize(parent);
      if (left === null) continue;
      const open = (ks: (OrderRow | null)[]): Dec => ks.filter(OPEN).reduce((s, k) => D.add(s, D.max(D.sub(D.from(k!.record.size ?? '0'), D.from(k!.record.filledSize)), D.zero)), D.zero);
      const need = live.reduce((m, x) => D.max(m, open(x.kids)), D.zero);
      if (D.lt(D.from(left), need)) {
        const why = D.isZero(D.from(left)) ? 'the position it protected is closed' : `the position it protected was reduced to ${left}: its orders, sized for more, were cancelled (attach new ones to what remains)`;
        for (const x of live) { out.cancelled += await this.cancelOpen(x.a, x.kids); await this.close(x.a, why); out.closed += 1; }
      }
    }
    return out;
  }
}

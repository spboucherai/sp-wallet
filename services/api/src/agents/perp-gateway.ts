/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-gateway.ts
 * Module           : agents
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

// The perp engines' way INTO the order gateway (agent-runtime/gateway.ts), and the existing perp seam seen from it.
//
//   `GatewayPerpExecutor` is what the perp engine places its orders with. It turns the engine's request into a canonical order,
//   submits it to the `AgentOrderGateway`, and turns the answered record back into the engine's `PlaceResult`. Account reads
//   (state, positions, unconfirmed) go straight to the underlying executor: they are not orders.
//   `perpSeam` is the seam adapter's execution side: the SAME underlying executor (`PaperPerpExecutor` or `LivePerpExecutor`),
//   so the risk engine, the mandate and the signer are exactly those of before.
//
// With the unified order service bound in main.ts instead of the seam adapter, `GatewayPerpExecutor` is unchanged: it only knows
// `AgentOrderGateway`. (No import of routes.ts here: perp-engine.ts imports this file.)
import { D, type Dec, type DecStr, type Order, type OrderRequest, type Position } from '@spw/derivatives';
import { toOrderRequest, type CanonicalOrder, type CanonicalOrderInput } from '@spw/trading';
import { sql } from '../db.ts';
import { orderGateway, type AgentOrderGateway, type AgentOrderRecord, type KillSwitchRead, type OrderSeam, type SeamContext, type SeamResult } from '../agent-runtime/gateway.ts';
import { killSwitchRead } from '../agent-runtime/kill-switch.ts';
import type { ExecAccount, PerpAgentRow, PerpExecutor, PlaceResult } from './perp-engine.ts';

export const ORDER_TTL_MS = 120_000;
export const feeCap = (notional: Dec): DecStr => D.str(D.quantize(D.mul(notional, D.from('0.002')), D.from('0.01'), 'up'));

// ------------------------------------------------------------------------------------------------------------------ perp

/** codes with which the signer, the mandate or the venue authorization said no (the others are the risk engine's) */
const MANDATE_CODES = /^(mandate_|authorization_|signer_|instrument_not_allowed|order_notional_exceeded|floor_|leverage_not_set|withdrawn|not_signed)/;
function fromPlace(r: PlaceResult, clientId: string): SeamResult {
  if (r.status === 'refused') return { status: 'rejected', by: r.code === 'venue_rejected' || r.code === 'never_placed' ? 'venue' : MANDATE_CODES.test(r.code) ? 'mandate' : 'risk', code: r.code, reason: r.reason };
  if (r.status === 'deferred') {
    // "this very order is at the venue, unconfirmed" is pending; "something else must finish first" proves that nothing was sent
    return r.reason.startsWith(`order ${clientId} is `) ? { status: 'pending', code: r.code, reason: r.reason } : { status: 'not_sent', code: r.code, reason: r.reason };
  }
  const o = r.order, id = o.venueOrderId ?? `sim:${clientId}`;
  if (o.status === 'rejected') return { status: 'rejected', by: 'venue', code: 'venue_rejected', reason: o.rejectReason ?? 'rejected' };
  const final = o.status === 'filled' || o.status === 'partially_filled' || o.status === 'cancelled';
  const fills = r.fills.map((f) => ({ id: f.id, size: f.size, price: f.price, feeUsd: f.fee, ts: f.ts }));
  return { status: 'accepted', venueOrderId: id, filledSize: o.filled, avgFillPrice: o.avgFillPrice, fills, final, note: o.rejectReason, venueStatus: o.status };
}

export interface PerpSeamOptions { accountId: string; mode: 'paper' | 'live';
  /** what the execution side knows about a client id, without sending anything (after an unknown outcome) */
  lookup?: (clientId: string) => Promise<SeamResult | null> }
export function perpSeam(inner: PerpExecutor, o: PerpSeamOptions): OrderSeam {
  const paperLookup = async (clientId: string): Promise<SeamResult | null> => {
    const [r] = await sql<{ status: string; filled: string; avg_fill_price: string | null; venue_order_id: string | null; reject_reason: string | null }[]>`select status, filled::text as filled, avg_fill_price::text as avg_fill_price, venue_order_id, reject_reason
      from deriv_orders where account_id = ${o.accountId} and client_id = ${clientId}`;
    if (!r) return null;
    if (r.status === 'rejected') return { status: 'rejected', by: 'venue', code: 'venue_rejected', reason: r.reject_reason ?? 'rejected' };
    return { status: 'accepted', venueOrderId: r.venue_order_id ?? `sim:${clientId}`, filledSize: r.filled, avgFillPrice: r.avg_fill_price, fills: [], final: ['filled', 'partially_filled', 'cancelled'].includes(r.status), note: r.reject_reason };
  };
  return {
    async execute(order: CanonicalOrder, ctx: SeamContext): Promise<SeamResult> {
      const req = toOrderRequest(order, { size: order.size!, worstPrice: ctx.worstPrice });
      return fromPlace(await inner.place(req, order.leverage ?? '1'), order.clientOrderId);
    },
    async lookup(order) {
      if (o.lookup) return o.lookup(order.clientOrderId);
      return paperLookup(order.clientOrderId);
    },
    // UNIFIED path: the live executor's own conditions before an order exists (cool-down, unconfirmed earlier order, floor guard,
    // the venue's leverage setting, the mandate's per-order bound). The paper executor has none.
    ...(inner.prepare ? { async prepare(order: CanonicalOrder, ctx: SeamContext) {
      const p = await inner.prepare!(toOrderRequest(order, { size: order.size!, worstPrice: ctx.worstPrice }), order.leverage ?? '1');
      return p.proceed ? p : { proceed: false as const, result: fromPlace(p.result, order.clientOrderId) as Exclude<SeamResult, { status: 'accepted' }> };
    } } : {}),
    ...(inner.observe ? { async observe(order: CanonicalOrder, outcome: { state: string; rejectCode: string | null; detail: string | null }) {
      await inner.observe!(toOrderRequest(order, { size: order.size!, worstPrice: order.limitPrice ?? '0' }), outcome);
    } } : {}),
    // paper: one local transaction — no row means no order. live: the order row is written before the signer is asked — no row means nothing was signed
    absenceConclusiveAt: (_order, submittedAt) => submittedAt,
  };
}

function toPlace(rec: AgentOrderRecord, req: OrderRequest): PlaceResult {
  const order = (status: Order['status'], note: string | null = rec.detail): Order => ({ ...req, venueOrderId: rec.venueOrderId, status, filled: rec.filledSize, avgFillPrice: rec.avgFillPrice, createdAt: rec.createdAt, updatedAt: rec.updatedAt, rejectReason: note });
  const [code, ...rest] = (rec.detail ?? '').split(': '), reason = rest.join(': ') || rec.detail || rec.reason;
  // the order that was sent is smaller than the one the engine asked for: cut to the mandate's bound by the live executor, or to the agent's own lot (provenance)
  const cut = rec.size !== null && D.lt(D.from(rec.size), D.from(req.size));
  switch (rec.state) {
    case 'FILLED': return { status: 'placed', order: cut ? order('partially_filled', `cut to what this agent may send (the mandate's notional per order, or the part of the position its own fills opened): ${rec.size} of ${req.size} sent and filled; the rest follows from the real position`) : order('filled'), fills: [], idempotent: rec.idempotent };
    case 'CANCELLED': {
      if (!rec.venueOrderId) return { status: 'refused', code: 'withdrawn', reason: rec.detail ?? 'withdrawn' };
      // an IOC order that ended with a remainder: the venue's own word for it when the gateway kept it (cancelled / partially_filled)
      const native = rec.venueStatus === 'cancelled' || rec.venueStatus === 'partially_filled' ? rec.venueStatus : null;
      return { status: 'placed', order: order(native ?? (D.isPos(D.from(rec.filledSize)) ? 'partially_filled' : 'cancelled')), fills: [], idempotent: rec.idempotent };
    }
    case 'PARTIALLY_FILLED': case 'SUBMITTED': return { status: 'placed', order: order(rec.state === 'SUBMITTED' ? 'open' : 'partially_filled'), fills: [], idempotent: rec.idempotent };
    case 'REJECTED': return { status: 'refused', code: /^[a-z_]{3,40}$/.test(code ?? '') ? code! : rec.reason.toLowerCase(), reason };
    // a unified order that ended FAILED is final for its key (nothing was sent, and nothing will be under this key): the instrument
    // is held until the next bar. A deferral that left no order (`source: 'none'`) and the seam ledger's NOT_SENT may be attempted again.
    case 'FAILED': return rec.source === 'orders' ? { status: 'refused', code: /^[a-z_]{3,40}$/.test(code ?? '') ? code! : rec.reason.toLowerCase(), reason }
      : { status: 'deferred', code: /^[a-z_]{3,40}$/.test(code ?? '') ? code! : 'not_sent', reason };
    default: return { status: 'deferred', code: 'live_unknown_pending', reason: `order ${rec.clientOrderId} is ${rec.state}: ${rec.detail ?? 'its outcome is not known yet'}; nothing more is sent on ${req.instrument} until it is reconciled` };
  }
}

export interface GatewayPerpOptions { mode: 'paper' | 'live'; network: string; authorityId: string | null; legacyAuthorityId?: string | null; slippageBps: number; now: () => number; configVersion: number; strategySha256?: string | null; signalId?: string | null; bar?: number | null;
  gateway?: AgentOrderGateway; killSwitch?: KillSwitchRead; lookup?: PerpSeamOptions['lookup']; accountId: string }
/** The executor the perp engine uses: reads from the underlying account, orders through the gateway. */
export class GatewayPerpExecutor implements PerpExecutor {
  readonly gateway: AgentOrderGateway;
  /** set by the engine once the bar's signal row exists */
  signalId: string | null; strategySha256: string | null; bar: number | null;
  private readonly inner: PerpExecutor; private readonly a: PerpAgentRow; private readonly o: GatewayPerpOptions;
  constructor(a: PerpAgentRow, inner: PerpExecutor, o: GatewayPerpOptions) {
    this.a = a; this.inner = inner; this.o = o; this.signalId = o.signalId ?? null; this.strategySha256 = o.strategySha256 ?? null; this.bar = o.bar ?? null;
    this.gateway = o.gateway ?? orderGateway({ agent: a, authorityId: o.authorityId, accountId: o.accountId, legacyAuthorityId: o.legacyAuthorityId ?? null, seam: perpSeam(inner, { accountId: o.accountId, mode: o.mode, ...(o.lookup ? { lookup: o.lookup } : {}) }), killSwitch: o.killSwitch ?? killSwitchRead, now: o.now });
  }
  account(sinceEventId?: number): Promise<ExecAccount> { return this.inner.account(sinceEventId); }
  positions(): Promise<Position[]> { return this.inner.positions(); }
  unconfirmed(): string[] { return this.inner.unconfirmed?.() ?? []; }

  async place(req: OrderRequest, leverage: DecStr): Promise<PlaceResult> {
    if (req.price === null) return { status: 'refused', code: 'bad_request', reason: 'an agent order names its worst acceptable price' };
    const now = this.o.now(), notional = D.mul(D.from(req.size), D.from(req.price));
    const order: CanonicalOrderInput = { v: 1, venue: 'hyperliquid', network: this.o.network, instrument: req.instrument, marketKind: 'perp', side: req.side, type: 'market', size: req.size, notional: null, limitPrice: null, triggerPrice: null,
      reduceOnly: req.reduceOnly, tif: 'ioc', maxSlippageBps: this.o.slippageBps, maxFeeUsd: feeCap(notional), leverage: D.str(D.max(D.one, D.from(leverage))), marginMode: 'cross', clientOrderId: req.clientId, mode: this.o.mode,
      principal: { kind: 'agent', id: this.a.id }, mandateId: this.o.authorityId ?? this.o.legacyAuthorityId ?? this.a.id, createdAt: now, expiresAt: now + ORDER_TTL_MS };
    const rec = await this.gateway.submit({ kind: 'agent', id: this.a.id }, order, { idempotencyKey: req.clientId, resolved: { worstPrice: req.price },
      context: { signalId: this.signalId, configVersion: this.o.configVersion, strategySha256: this.strategySha256, bar: this.bar } });
    return toPlace(rec, req);
  }
}


/** what a stored venue order (derivatives/mandate.ts `mandateOrder`) means for the gateway — nothing is sent to read it */
export function liveOrderResult(o: { state: string; final: boolean; source?: string; filled: DecStr; avgFillPrice: DecStr | null; venueOrderId: string | null; reason: string | null; clientId: string }): SeamResult {
  const accepted = (note: string | null): SeamResult => ({ status: 'accepted', venueOrderId: o.venueOrderId ?? `hl:${o.clientId}`, filledSize: o.filled, avgFillPrice: o.avgFillPrice, fills: [], final: true, note });
  if (o.state === 'filled') return accepted(null);
  if (o.state === 'partially_filled' && (o.final || o.source === 'venue')) return accepted(o.reason ?? 'remainder not filled');
  if (o.state === 'cancelled') return o.venueOrderId ? accepted(o.reason ?? 'not filled') : { status: 'rejected', by: 'mandate', code: 'withdrawn', reason: o.reason ?? 'withdrawn before it was signed' };
  if (o.state === 'rejected') {
    const why = o.reason ?? 'rejected';
    if (/^(never placed|not sent|not signed)/.test(why)) return { status: 'not_sent', code: /^never placed/.test(why) ? 'never_placed' : 'not_sent', reason: why };
    if (/^refused by the venue/.test(why)) return { status: 'rejected', by: 'venue', code: 'venue_rejected', reason: why };
    const code = /^([a-z_]{3,40}): /.exec(why)?.[1] ?? 'rejected';
    return { status: 'rejected', by: MANDATE_CODES.test(code) ? 'mandate' : 'risk', code, reason: why };
  }
  return { status: 'pending', code: o.state, reason: o.reason ?? 'the venue has not confirmed it yet', venueOrderId: o.venueOrderId };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-exec.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// The PAPER implementation of `PerpExecutor` (perp-engine.ts): the agent's own derivatives paper account, through the existing
// paper service — risk engine first (`checkOrder` with the policy derived from the owner's limits), then the paper engine
// against the live book. Nothing here signs, calls the signer or reaches a venue's trading endpoint.
//
// The live executor (perp-exec-live.ts, V7) implements the same three methods over a venue account whose orders are signed under
// a signer-enforced derivative mandate. V11: the engine reaches either of them through the order gateway (perp-gateway.ts).
import type { DecStr, OrderRequest, Position } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { OrderBodySchema, type PaperService } from '../derivatives/paper.ts';
import type { ExecAccount, PerpExecutor, PlaceResult } from './perp-engine.ts';

/** risk events of the account the engine reacts to */
const WATCHED = new Set(['liquidation', 'margin_warning']);

export class PaperPerpExecutor implements PerpExecutor {
  readonly kind = 'paper' as const;
  private readonly paper: PaperService;
  private readonly accountId: string;
  constructor(paper: PaperService, accountId: string) { this.paper = paper; this.accountId = accountId; }

  async account(sinceEventId = 0): Promise<ExecAccount> {
    const g = await this.paper.get(this.accountId);
    const rows = await sql<{ id: string; ts: Date; kind: string; code: string | null; message: string }[]>`select id, ts, kind, code, message from deriv_risk_events where account_id = ${this.accountId} and id > ${sinceEventId} order by id`;
    return { state: g.state, policy: g.policy, events: rows.filter((e) => WATCHED.has(e.kind)).map((e) => ({ id: Number(e.id), ts: e.ts.getTime(), kind: e.kind, code: e.code, message: e.message })) };
  }

  async positions(): Promise<Position[]> { return (await this.paper.get(this.accountId)).positions; }

  async place(order: OrderRequest, leverage: DecStr): Promise<PlaceResult> {
    const body = OrderBodySchema.parse({ instrument: order.instrument, side: order.side, type: order.type, size: order.size, price: order.price, triggerPrice: order.triggerPrice, reduceOnly: order.reduceOnly, tif: order.tif, leverage });
    try {
      const r = await this.paper.order(this.accountId, body, order.clientId);
      await sql`update deriv_orders set origin = 'agent' where account_id = ${this.accountId} and client_id = ${order.clientId}`;
      return { status: 'placed', order: r.order, fills: r.fills, idempotent: r.idempotent };
    } catch (e) {
      // 422 = the risk engine (or the service's own order rules) said no: a refusal, recorded by the service as a risk event
      if (e instanceof UserError && e.status === 422) return { status: 'refused', code: e.code, reason: e.message };
      throw e;
    }
  }
}

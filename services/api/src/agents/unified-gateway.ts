// `AgentOrderGateway` over the UNIFIED order service (V11 execution: orders/service.ts). This is the order path of every agent
// whose orders the order service executes — the perp agents, paper and live.
//
//   submit → orders.submitCanonical(caller { principal: agent, mandateId }, order, idempotencyKey, { origin: 'agent', accountId })
//
// so every such order is a row of `orders` (driven by `transition()`), is judged by the server-side risk engine (`evaluate`: the
// kill switch, read-only mode and the owner's limits included), is checked against the agent's TRADING MANDATE (paper or live),
// and emits `order.updated`. The gateway keeps NO state of its own: `agent_order_intents` receives one CONTEXT row per unified
// order (signal, configuration version, strategy hash) and every state it answers is read from `orders`.
//
// Semantics the engines rely on, and where each one lives now:
//   same key → the stored record, never a second order     the unified order of (agent, key) is looked up FIRST and answered;
//                                                          `submitCanonical` is never called twice for a key that has an order
//   an exception while handing over → UNKNOWN, reconciled   the order service stores the order before its engine is called and the
//   and never sent again                                    engine stores its row before anything is signed: after an exception
//                                                          the stored order is the answer (SUBMITTING / UNKNOWN), the reconciler
//                                                          of the order service settles it, and this gateway only ever re-reads it
//   a new attempt only when nothing left                    what the agent's executor defers BEFORE an order exists (cool-down,
//                                                          an unconfirmed earlier order, no quote: `seam.prepare`) and what the
//                                                          order service refuses before it creates anything leave NO order: the
//                                                          same key — hence the same venue client id — is submitted again later.
//                                                          A unified order that ended FAILED is final for its key.
//   research → READ_ONLY_MODE; LIVE names the mandate       checked here before anything else, as before
//
// What this file cannot do: create, approve or widen a mandate (it imports nothing that can), release a switch, or sign.
import { D, type DecStr } from '@spw/derivatives';
import { canonicalOrder, isTerminal, type CanonicalOrder, type CanonicalOrderInput, type OrderHistoryEntry, type OrderState, type ReasonCode } from '@spw/trading';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { agentRiskGate, GatewayError, listAgentOrders, newEphemeral, SeamOrderGateway, unifiedAgentOrder, unifiedView, type AgentFill, type AgentOrderGateway, type AgentOrderRecord, type AgentPrincipal, type ListFilter, type SeamBinding, type SeamContext, type SubmitOptions } from '../agent-runtime/gateway.ts';
import { journal } from '../agent-runtime/journal.ts';
import { dbMode, type Mode } from '../agent-runtime/model.ts';
import type { Execution } from '../orders/index.ts';
import { getByIdempotency, getOrder, history } from '../orders/store.ts';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 400);
/** refusal codes of the order service that are raised BEFORE an order exists → the reason code the engines read */
const PRE_REASON: Record<string, ReasonCode> = { mandate_required: 'MANDATE_DENIED', mandate_not_approved: 'MANDATE_DENIED', execution_disabled: 'RISK_DENIED', key_limit_exceeded: 'RISK_DENIED', not_reducing: 'INVALID_ORDER',
  position_not_attributable: 'RISK_DENIED', venue_restricted: 'VENUE_NOT_ALLOWED', unknown_venue: 'VENUE_NOT_ALLOWED', restricted: 'VENUE_NOT_ALLOWED', unknown_instrument: 'INSTRUMENT_NOT_ALLOWED' };

export class UnifiedOrderGateway implements AgentOrderGateway {
  private readonly b: SeamBinding;
  private readonly ex: Execution;
  private readonly now: () => number;
  constructor(b: SeamBinding, ex: Execution) { this.b = b; this.ex = ex; this.now = b.now ?? Date.now; }

  private own(p: AgentPrincipal): void { if (p.kind !== 'agent' || p.id !== this.b.agent.id) throw new GatewayError('wrong_principal', 'this gateway is bound to another agent'); }
  private get principal(): { kind: 'agent'; id: string } { return { kind: 'agent', id: this.b.agent.id }; }

  /** the stored order, after the order service has projected whatever its engine did to it; nothing is sent */
  private async refresh(id: string): Promise<AgentOrderRecord | null> {
    let row = await getOrder(id);
    if (!row || row.principal_kind !== 'agent' || row.principal_id !== this.b.agent.id) return null;
    if (!isTerminal(row.state)) {
      await this.ex.orders.drain().catch(() => 0);
      if (row.engine_ref && row.engine !== 'gmx') await this.ex.orders.projectRef('deriv', row.engine_ref).catch(() => null);
      row = (await getOrder(id)) ?? row;
    }
    return this.read(id, true);
  }
  private async read(id: string, idempotent: boolean, full = false): Promise<AgentOrderRecord | null> {
    const r = await unifiedAgentOrder(this.b.agent.id, id);
    if (!r) return null;
    if (!full) return unifiedView(r, idempotent);
    const got = await this.ex.orders.get({ principal: this.principal, mandateId: r.canonical?.mandateId ?? null }, id).catch(() => null);
    const fills: AgentFill[] = ((got?.fills ?? []) as { id: string; size: string; price: string; fee: string | null; ts: number }[]).map((f) => ({ id: String(f.id), size: D.str(D.from(String(f.size))), price: D.str(D.from(String(f.price))), feeUsd: f.fee === null ? null : D.str(D.from(String(f.fee))), ts: f.ts }));
    const hist: OrderHistoryEntry[] = (await history(id)).map((h) => ({ orderId: id, seq: h.seq, from: h.from as OrderState, to: h.to as OrderState, event: h.event as OrderHistoryEntry['event'], reason: h.reason as ReasonCode, detail: h.detail, at: h.at }));
    return unifiedView((await unifiedAgentOrder(this.b.agent.id, id)) ?? r, idempotent, { fills, history: hist });
  }
  /** the agent's context of a unified order: written once, never a state (constraint agent_order_intents_one_truth) */
  private async context(order: CanonicalOrder, key: string, ctx: SeamContext): Promise<void> {
    await sql`insert into agent_order_intents (id, order_id, client_order_id, attempt, agent_id, mode, idempotency_key, body_hash, venue, instrument, side, reduce_only, order_json, signal_id, config_version, strategy_sha256)
      select o.id, o.id, ${order.clientOrderId}, 1, ${this.b.agent.id}, ${dbMode(order.mode as Mode)}, ${key}, coalesce(o.body_hash, ''), o.venue, o.instrument, o.side, o.reduce_only, coalesce(o.canonical, ${sql.json(order as never)}::jsonb), ${ctx.signalId}, ${ctx.configVersion}, ${ctx.strategySha256}
      from orders o where o.id = ${order.clientOrderId} and o.principal_kind = 'agent' and o.principal_id = ${this.b.agent.id} on conflict do nothing`;
  }

  async submit(p: AgentPrincipal, input: CanonicalOrderInput, o: SubmitOptions): Promise<AgentOrderRecord> {
    this.own(p);
    const a = this.b.agent;
    let order = canonicalOrder(input);
    if (order.principal.kind !== 'agent' || order.principal.id !== a.id) throw new GatewayError('wrong_principal', 'the order names another principal than the agent that submits it');
    if (!/^[\x21-\x7e]{8,128}$/.test(o.idempotencyKey)) throw new GatewayError('idempotency', 'an idempotency key of 8 to 128 printable characters is required');
    const ctx: SeamContext = { idempotencyKey: o.idempotencyKey, worstPrice: o.resolved?.worstPrice ?? null, signalId: o.context?.signalId ?? null, configVersion: o.context?.configVersion ?? a.config_version ?? null,
      strategySha256: o.context?.strategySha256 ?? null, bar: o.context?.bar ?? null, reason: o.context?.reason ?? null };
    const mode = dbMode(order.mode as Mode), ref = { order: order.clientOrderId, signal: ctx.signalId }, what = `${order.side} ${order.size ?? `${order.notional} (notional)`} ${order.instrument}${order.reduceOnly ? ' reduce-only' : ''}`;

    // 1 — this key already has an order: the stored order is the answer. Nothing is submitted, whatever is asked now.
    const prior = (await getByIdempotency(this.principal, o.idempotencyKey)) ?? (await getOrder(order.clientOrderId));
    if (prior) {
      if (prior.principal_kind !== 'agent' || prior.principal_id !== a.id) throw new GatewayError('wrong_principal', 'this client order id belongs to another principal');
      // an order whose outcome is open: the execution side is ASKED (a read of the account's own record of it), never sent again
      if (!isTerminal(prior.state)) await this.b.seam.lookup(order).catch(() => null);
      await this.context(order, o.idempotencyKey, ctx);
      const rec = (await this.refresh(prior.id))!;
      await this.b.seam.observe?.(order, { state: rec.state, rejectCode: rec.rejectCode ?? null, detail: rec.detail }).catch(() => {});
      return rec;
    }
    // an order of this key recorded by the seam ledger before the agents were bound to the order service: that record stands
    const [legacy] = await sql<{ id: string }[]>`select id from agent_order_intents where agent_id = ${a.id} and idempotency_key = ${o.idempotencyKey} and order_id is null limit 1`;
    if (legacy) return (await new SeamOrderGateway(this.b).get(p, legacy.id))!;

    const none = async (state: 'REJECTED' | 'FAILED', reason: ReasonCode, code: string, detail: string, kind: 'risk' | 'hold' = state === 'REJECTED' ? 'risk' : 'hold'): Promise<AgentOrderRecord> => {
      await journal(a.id, { mode, kind, code: kind === 'hold' ? code : reason, severity: kind === 'risk' ? 'warning' : 'info', title: kind === 'risk' ? `Refused before it left: ${reason}` : 'Order not sent now', body: `${what} — ${detail}`, ref, configVersion: ctx.configVersion });
      return newEphemeral(a.id, order, state, reason, `${code}: ${detail}`.slice(0, 500), this.now(), ctx);
    };

    // 2 — what the agent side itself refuses: mode, the mandate named, the agent's own instruments
    const agentMode = a.mode === 'LIVE' ? 'live' : a.mode === 'PAPER' ? 'paper' : 'research';
    if (order.mode === 'research' || agentMode === 'research') return none('REJECTED', 'READ_ONLY_MODE', 'read_only_mode', 'an agent in research mode places no order');
    if (order.mode !== agentMode) return none('REJECTED', 'READ_ONLY_MODE', 'read_only_mode', `the order says ${order.mode} and the agent is in ${agentMode}`);
    if (!this.b.authorityId || order.mandateId !== this.b.authorityId) {
      // a LIVE agent whose derivative mandate predates the trading mandates keeps its way OUT: a reduce-only order goes through the
      // seam it was approved on (the signer still enforces that mandate); nothing that adds risk does
      if (order.mode === 'live' && order.reduceOnly && this.b.legacyAuthorityId && order.mandateId === this.b.legacyAuthorityId) return new SeamOrderGateway({ ...this.b, authorityId: this.b.legacyAuthorityId }).submit(p, input, o);
      return none('REJECTED', 'MANDATE_DENIED', 'mandate_required', order.mode === 'live' ? (this.b.authorityId ? 'the order names another mandate than the one in force for this agent' : 'no owner-approved trading mandate is in force for this agent')
        : (this.b.authorityId ? 'the order names another mandate than this agent\'s paper mandate' : 'this agent has no paper trading mandate matching its configuration: start paper again (the mandate is created then)'));
    }
    if (!this.b.accountId) return none('REJECTED', 'INVALID_ORDER', 'no_account', 'the agent has no account for this mode');
    const gate = await (this.b.risk ?? agentRiskGate).check(a, order);
    if (!gate.ok) return none('REJECTED', gate.code, gate.code.toLowerCase(), gate.reason);

    // 3 — the agent executor's own conditions BEFORE an order exists (nothing is sent; a deferral leaves no order)
    if (this.b.seam.prepare) {
      const pr = await this.b.seam.prepare(order, ctx);
      if (!pr.proceed) {
        const r = pr.result;
        if (r.status === 'rejected') return none('REJECTED', r.by === 'mandate' ? 'MANDATE_DENIED' : r.by === 'signer' ? 'SIGNER_REFUSED' : r.by === 'mode' ? 'READ_ONLY_MODE' : 'RISK_DENIED', r.code, r.reason);
        return none('FAILED', 'NOT_SENT', r.code, r.reason);
      }
      if (pr.size && order.size !== null && !D.eq(D.from(pr.size), D.from(order.size))) order = canonicalOrder({ ...order, size: pr.size });
    }
    // a live order runs under the venue's own leverage setting (the executor has just brought it to the agent's policy)
    if (order.mode === 'live' && order.leverage !== null) order = canonicalOrder({ ...order, leverage: null });

    // 4 — the unified order service: risk engine, trading mandate, the engine's own path
    let rec: AgentOrderRecord | null = null, thrown: UserError | null = null;
    for (let attempt = 0; ; attempt++) try {
      await this.ex.orders.submitCanonical({ principal: this.principal, mandateId: order.mandateId }, order, o.idempotencyKey, { origin: 'agent', accountId: this.b.accountId });
      break;
    } catch (e) {
      const stored = await getOrder(order.clientOrderId);
      if (!stored) {
        // PROVENANCE (orders/provenance.ts): an agent reduces only what its OWN fills opened. A closing order larger than its lot
        // (the owner traded by hand on the account, or the venue shows a position the wallet did not create) is refused whole,
        // before any order exists: the agent then closes ITS part — the rest is the owner's, and the engine reports it still open.
        const own = e instanceof UserError && e.code === 'position_not_attributable' ? (e as UserError & { data?: { provenance?: { reducible?: DecStr } } }).data?.provenance?.reducible : undefined;
        if (attempt === 0 && own && order.reduceOnly && order.size !== null && D.isPos(D.from(own)) && D.lt(D.from(own), D.from(order.size))) {
          await journal(a.id, { mode, kind: 'risk', code: 'position_not_attributable', severity: 'warning', title: 'Closing only what this agent opened', body: `${what} — ${(e as Error).message.slice(0, 300)} The order is cut to ${own}.`, ref, configVersion: ctx.configVersion });
          order = canonicalOrder({ ...order, size: own });
          continue;
        }
        // nothing was created, so nothing was signed or sent: a refusal is a refusal, anything else can be attempted again under the same key
        if (e instanceof UserError && e.status < 500) return none('REJECTED', PRE_REASON[e.code] ?? 'INVALID_ORDER', e.code, e.message);
        return none('FAILED', 'NOT_SENT', e instanceof UserError ? e.code : 'not_created', `no order was created: ${msg(e)}`);
      }
      // the order exists: the code its engine (or the signer behind it) refused it with is kept — the engines read it
      if (e instanceof UserError) thrown = e;
      if (!isTerminal(stored.state)) await journal(a.id, { mode, kind: 'error', code: 'ORDER_OUTCOME_UNKNOWN', severity: 'error', title: 'Order outcome unknown: it will be reconciled, not sent again', body: `${what} (${stored.id}, ${stored.state}): ${msg(e)}`, ref, configVersion: ctx.configVersion });
      break;
    }
    await this.context(order, o.idempotencyKey, ctx);
    // the paper engine marks who placed the order on its own row, as the paper executor always did
    if (order.mode === 'paper') await sql`update deriv_orders set origin = 'agent' where account_id::text = ${this.b.accountId} and client_id = ${order.clientOrderId} and origin <> 'agent'`.catch(() => {});
    const withCode = (r: AgentOrderRecord): AgentOrderRecord => (thrown && !r.rejectCode && (r.state === 'REJECTED' || r.state === 'FAILED') ? { ...r, rejectCode: thrown.code, detail: `${thrown.code}: ${r.detail ?? thrown.message}`.slice(0, 500) } : r);
    rec = await this.read(order.clientOrderId, false);
    if (!rec) throw new GatewayError('concurrent_update', 'the order could not be read back');
    rec = withCode(rec);
    // the executor follows (LIVE: it asks the venue account about the order, which is how a signed order becomes a confirmed one)…
    await this.b.seam.observe?.(order, { state: rec.state, rejectCode: rec.rejectCode ?? null, detail: rec.detail }).catch(() => {});
    // …and the unified order is read again once the order service has projected what its engine now says
    if (!isTerminal(rec.state)) await this.refresh(order.clientOrderId);
    rec = withCode({ ...(await this.read(order.clientOrderId, false, true))!, idempotent: false });
    await this.note(rec, mode, what, ctx);
    return rec;
  }

  private async note(rec: AgentOrderRecord, mode: 'PAPER' | 'LIVE' | 'RESEARCH', what: string, ctx: SeamContext): Promise<void> {
    const base = { mode, ref: { order: rec.id, signal: ctx.signalId }, configVersion: ctx.configVersion }, sim = mode === 'LIVE' ? '' : ' — SIMULATED fill';
    if (rec.state === 'REJECTED') {
      const by = rec.reason === 'MANDATE_DENIED' ? 'trading mandate' : rec.reason === 'KILL_SWITCH_ACTIVE' ? 'kill switch' : rec.reason === 'READ_ONLY_MODE' ? 'read-only mode' : rec.reason === 'VENUE_REJECTED' ? 'venue' : rec.reason === 'SIGNER_REFUSED' ? 'signer' : 'risk engine';
      await journal(rec.agentId, { ...base, kind: 'risk', code: rec.rejectCode ?? rec.reason, severity: 'warning', title: `Refused by the ${by}`, body: `${what} — ${rec.detail ?? rec.reason}` });
    } else if (rec.state === 'FAILED') {
      await journal(rec.agentId, { ...base, kind: 'hold', code: rec.rejectCode ?? rec.reason, title: 'Order failed: nothing was sent', body: `${what} — ${rec.detail ?? rec.reason}` });
    } else if (rec.state === 'UNKNOWN' || rec.state === 'SUBMITTING' || rec.state === 'CREATED' || rec.state === 'VALIDATED' || rec.state === 'APPROVED') {
      await journal(rec.agentId, { ...base, kind: 'order', code: 'PENDING', title: 'Order handed over, not confirmed yet', body: `${what} — ${rec.detail ?? rec.state}` });
    } else {
      await journal(rec.agentId, { ...base, kind: 'order', code: rec.state, title: `Order ${rec.state.toLowerCase().replace('_', ' ')}`, body: `${what} — unified order ${rec.id}${rec.venueOrderId ? `, ${mode === 'LIVE' ? 'venue' : 'simulated'} order ${rec.venueOrderId}` : ''}` });
      if (D.isPos(D.from(rec.filledSize))) await journal(rec.agentId, { ...base, kind: 'fill', code: 'FILL', title: `Filled ${rec.filledSize} at ${rec.avgFillPrice ?? '?'}`, body: `${what}${sim}`, data: { fills: rec.fills } });
    }
  }

  /** every order of this agent whose outcome is open is asked about (a read) and re-read from the unified table */
  async reconcile(): Promise<AgentOrderRecord[]> {
    const rows = await sql<{ id: string; canonical: CanonicalOrder | null }[]>`select id, canonical from orders where principal_kind = 'agent' and principal_id = ${this.b.agent.id} and state in ('SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN') order by created_at`;
    const out: AgentOrderRecord[] = [];
    for (const r of rows) {
      const before = await unifiedAgentOrder(this.b.agent.id, r.id);
      if (r.canonical) await this.b.seam.lookup(r.canonical).catch(() => null);
      const rec = await this.refresh(r.id);
      if (!rec) continue;
      if (before && rec.state !== before.state) await journal(rec.agentId, { mode: rec.mode === 'live' ? 'LIVE' : 'PAPER', kind: 'order', code: rec.state, title: `Order reconciled: ${before.state} → ${rec.state}`, body: `${rec.side} ${rec.instrument} (${rec.id}) — ${rec.reason}${rec.detail ? `: ${rec.detail}` : ''}`, ref: { order: rec.id } });
      out.push(rec);
    }
    // orders of the seam ledger that were open when the agent was bound to the order service
    return [...out, ...(await new SeamOrderGateway(this.b).reconcile())];
  }

  async cancel(p: AgentPrincipal, orderId: string): Promise<AgentOrderRecord> {
    this.own(p);
    const row = await unifiedAgentOrder(this.b.agent.id, orderId);
    if (!row) return new SeamOrderGateway(this.b).cancel(p, orderId);
    if (!isTerminal(row.state)) await this.ex.orders.cancel({ principal: this.principal, mandateId: row.canonical?.mandateId ?? null }, orderId);
    return (await this.read(orderId, isTerminal(row.state), true))!;
  }
  async get(p: AgentPrincipal, orderId: string): Promise<AgentOrderRecord | null> {
    this.own(p);
    return (await this.read(orderId, true, true)) ?? new SeamOrderGateway(this.b).get(p, orderId);
  }
  list(p: AgentPrincipal, filter: ListFilter = {}): Promise<AgentOrderRecord[]> { this.own(p); return listAgentOrders(this.b.agent.id, filter); }
}

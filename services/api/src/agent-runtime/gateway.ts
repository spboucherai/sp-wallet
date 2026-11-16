// The ONE way an agent places an order: `AgentOrderGateway`.
//
//   interface AgentOrderGateway   submit / cancel / get / list for an agent principal; answers order records in the unified
//                                 states of @spw/trading (CREATED … FILLED | CANCELLED | REJECTED | FAILED | UNKNOWN).
//   class SeamOrderGateway        the implementation of THIS branch: an adapter over the existing engine seams (the perp
//                                 `PerpExecutor` of a paper or a venue account, the spot paper book and the vault's live swap),
//                                 with its own ledger (`agent_order_intents`) written BEFORE the seam is called.
//   setOrderGatewayFactory()      dependency injection. main.ts binds `seamGatewayFactory`; the execution workstream's unified
//                                 order service binds its own factory there, and nothing else in the agent code changes.
//
// Before the seam is called, in this order: the canonical order is validated; the agent's mode allows orders (research never
// does); the kill switch is consulted (only an order that reduces risk passes); a LIVE order must name the mandate that is in
// force for this agent; the `RiskGate` checks the agent's own limits. The seams then apply what they always applied: the
// derivatives risk engine and the paper engine, or the account policy and the signer's mandate, or the signer's spot mandate.
// The gateway holds no key, and no function here can create, widen or approve a mandate.
//
// Unknown outcomes: a seam that throws after the order may have left turns the record UNKNOWN. The same idempotency key is
// then NEVER sent again: `submit` answers the stored record after asking the seam what became of it (`lookup`). A new attempt
// under the same key is allowed only when the previous one is FAILED with a reason that proves nothing left (NOT_SENT,
// NEVER_PLACED) — e.g. the live executor's cool-down — and it reuses the same venue client id.
import { D, type DecStr } from '@spw/derivatives';
import { CanonicalOrderSchema, canonicalOrder, newOrder, orderBodyHashHex, transition, isTerminal, type CanonicalOrder, type CanonicalOrderInput, type OrderEvent, type OrderHistoryEntry, type OrderRecord, type OrderState, type ReasonCode } from '@spw/trading';
import { sql } from '../db.ts';
import { journal } from './journal.ts';
import { apiMode, dbMode, type DbMode, type Mode } from './model.ts';

// ------------------------------------------------------------------------------------------------------------------ the interface

export interface AgentPrincipal { kind: 'agent'; id: string }
export interface AgentFill { id: string; size: DecStr; price: DecStr; feeUsd: DecStr | null; ts: number }
export interface AgentOrderRecord {
  /** the gateway's id of this attempt (= the client order id for a first attempt) */
  id: string; clientOrderId: string; attempt: number; agentId: string; mode: 'paper' | 'live'; venue: string; instrument: string; side: 'buy' | 'sell'; reduceOnly: boolean;
  state: OrderState; reason: ReasonCode; detail: string | null; size: DecStr | null; filledSize: DecStr; avgFillPrice: DecStr | null; venueOrderId: string | null;
  fills: AgentFill[]; order: CanonicalOrder; history: OrderHistoryEntry[]; createdAt: number; updatedAt: number;
  /** true when this answer is a stored record: nothing was sent by this call */
  idempotent: boolean;
  signalId: string | null; configVersion: number | null; strategySha256: string | null;
  /** the venue's own word for the order's status, when the implementation knows it (informative; `state` is the truth) */
  venueStatus?: string | null;
}
export interface SubmitOptions {
  /** required; one order per (agent, key). The engines use their deterministic client id */
  idempotencyKey: string;
  /** what a canonical order leaves open and the caller resolved: the worst acceptable price of a market order */
  resolved?: { worstPrice?: DecStr | null };
  /** what produced the order (written on the record and on the journal) */
  context?: { signalId?: string | null; configVersion?: number | null; strategySha256?: string | null; bar?: number | null; reason?: string | null };
}
export interface ListFilter { mode?: Mode; open?: boolean; limit?: number; before?: number }
export interface AgentOrderGateway {
  submit(principal: AgentPrincipal, order: CanonicalOrderInput, o: SubmitOptions): Promise<AgentOrderRecord>;
  cancel(principal: AgentPrincipal, orderId: string): Promise<AgentOrderRecord>;
  get(principal: AgentPrincipal, orderId: string): Promise<AgentOrderRecord | null>;
  list(principal: AgentPrincipal, filter?: ListFilter): Promise<AgentOrderRecord[]>;
  /** optional: ask the execution side about every order of this agent whose outcome is open (the unified order service reconciles by itself) */
  reconcile?(): Promise<AgentOrderRecord[]>;
}

// ------------------------------------------------------------------------------------------------------------------ the seam side

export interface SeamFill { id?: string; size: DecStr; price: DecStr; feeUsd?: DecStr | null; ts?: number }
export type SeamResult =
  /** the venue (or the simulated account) took the order. `final`: nothing more will happen to it (an IOC order, a filled order) */
  | { status: 'accepted'; venueOrderId: string; filledSize: DecStr; avgFillPrice: DecStr | null; fills: SeamFill[]; final: boolean; note?: string | null; /** the execution side's own word for the order's status */ venueStatus?: string | null }
  /** refused: by the risk engine, the mandate, the signer or the venue. Nothing rests anywhere. */
  | { status: 'rejected'; by: 'risk' | 'mandate' | 'signer' | 'venue' | 'mode'; code: string; reason: string }
  /** proven: nothing left this process (a cool-down, an earlier order still pending, no quote). May be attempted again. */
  | { status: 'not_sent'; code: string; reason: string }
  /** handed over (signed, sent) and not confirmed yet */
  | { status: 'pending'; code: string; reason: string; venueOrderId?: string | null };
export interface SeamContext { idempotencyKey: string; worstPrice: DecStr | null; signalId: string | null; configVersion: number | null; strategySha256: string | null; bar: number | null; reason: string | null }
/** What the adapter needs from an existing engine path. One object per agent tick (it wraps that tick's executor). */
export interface OrderSeam {
  execute(order: CanonicalOrder, ctx: SeamContext): Promise<SeamResult>;
  /** what became of an order that was handed over (by its client id); null = this seam has no trace of it */
  lookup(order: CanonicalOrder): Promise<SeamResult | null>;
  /** unix ms after which "no trace" proves that the order never reached the venue; null = it can never be proven */
  absenceConclusiveAt(order: CanonicalOrder, submittedAt: number): number | null;
  cancel?(order: CanonicalOrder): Promise<SeamResult | null>;
}
export interface GatewayAgent { id: string; state: string; mode: string; kind?: string | undefined; universe: string[]; config_version?: number | undefined }
export interface RiskGate { check(agent: GatewayAgent, order: CanonicalOrder): Promise<{ ok: true } | { ok: false; code: 'RISK_DENIED' | 'INSTRUMENT_NOT_ALLOWED' | 'VENUE_NOT_ALLOWED'; reason: string }> }
export interface KillSwitchRead { engaged(): Promise<{ engaged: boolean; reason: string | null }> }
export interface SeamBinding {
  agent: GatewayAgent; seam: OrderSeam;
  /** the authority a LIVE order must name: the mandate in force for this agent (null = none: every live order is refused);
   *  in PAPER the id of the simulated account, which is not a mandate and signs nothing */
  authorityId: string | null;
  risk?: RiskGate; killSwitch?: KillSwitchRead; now?: () => number;
}
export type OrderGatewayFactory = (binding: SeamBinding) => AgentOrderGateway;

export class GatewayError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const PROVEN_NOT_SENT: readonly string[] = ['NOT_SENT', 'NEVER_PLACED'];
const AT_VENUE: readonly OrderState[] = ['SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN'];
const OPEN_STATES: string[] = [...AT_VENUE, 'CREATED', 'VALIDATED', 'APPROVED'];
/** an order that can only reduce risk: a reduce-only derivative order, or a spot sale back to the cash leg */
export const reducesRisk = (o: Pick<CanonicalOrder, 'reduceOnly' | 'marketKind' | 'side'>): boolean => o.reduceOnly || (o.marketKind === 'spot' && o.side === 'sell');

interface IntentRow { id: string; client_order_id: string; attempt: number; agent_id: string; mode: DbMode; idempotency_key: string; body_hash: string; venue: string; instrument: string; side: 'buy' | 'sell'; reduce_only: boolean;
  order_json: CanonicalOrder; record: OrderRecord; state: OrderState; reason: ReasonCode; history: OrderHistoryEntry[]; fills: AgentFill[]; signal_id: string | null; config_version: number | null; strategy_sha256: string | null; venue_status: string | null; created_at: Date; updated_at: Date }
const view = (r: IntentRow, idempotent: boolean): AgentOrderRecord => ({ id: r.id, clientOrderId: r.client_order_id, attempt: r.attempt, agentId: r.agent_id, mode: apiMode(r.mode) as 'paper' | 'live', venue: r.venue, instrument: r.instrument, side: r.side,
  reduceOnly: r.reduce_only, state: r.record.state, reason: r.record.reason, detail: r.record.detail, size: r.record.size, filledSize: r.record.filledSize, avgFillPrice: r.record.avgFillPrice, venueOrderId: r.record.venueOrderId,
  fills: r.fills, order: r.order_json, history: r.history, createdAt: r.record.createdAt, updatedAt: r.record.updatedAt, idempotent, signalId: r.signal_id === null ? null : String(r.signal_id), configVersion: r.config_version, strategySha256: r.strategy_sha256, venueStatus: r.venue_status });

/** Read side shared by every implementation on this branch: the ledger, always filtered by agent and (when given) by mode. */
export async function listAgentOrders(agentId: string, f: ListFilter = {}): Promise<AgentOrderRecord[]> {
  const mode = f.mode ? dbMode(f.mode) : null, before = f.before ? new Date(f.before) : null;
  const rows = await sql<IntentRow[]>`select * from agent_order_intents where agent_id = ${agentId} and (${mode}::text is null or mode = ${mode}) and (${before}::timestamptz is null or created_at < ${before})
    and (${f.open ?? false} = false or state in ${sql(OPEN_STATES)}) order by created_at desc, id desc limit ${Math.min(f.limit ?? 100, 500)}`;
  return rows.map((r) => view(r, true));
}

export class SeamOrderGateway implements AgentOrderGateway {
  private readonly b: SeamBinding;
  private readonly now: () => number;
  constructor(b: SeamBinding) { this.b = b; this.now = b.now ?? Date.now; }

  private own(p: AgentPrincipal): void { if (p.kind !== 'agent' || p.id !== this.b.agent.id) throw new GatewayError('wrong_principal', 'this gateway is bound to another agent'); }
  private async latest(key: string): Promise<IntentRow | null> {
    return (await sql<IntentRow[]>`select * from agent_order_intents where agent_id = ${this.b.agent.id} and idempotency_key = ${key} order by attempt desc limit 1`)[0] ?? null;
  }
  /** apply events to a stored record and persist (optimistic on the record's version) */
  private async apply(row: IntentRow, events: OrderEvent[], fills: AgentFill[] = [], venueStatus: string | null = null): Promise<IntentRow> {
    let rec = row.record; const hist = [...row.history];
    for (const e of events) { const t = transition(rec, e, this.now()); rec = t.order; hist.push(t.entry); }
    const all = [...row.fills, ...fills.filter((f) => !row.fills.some((x) => x.id === f.id))];
    const [r] = await sql<IntentRow[]>`update agent_order_intents set record = ${sql.json(rec as never)}, state = ${rec.state}, reason = ${rec.reason}, history = ${sql.json(hist as never)}, fills = ${sql.json(all as never)}, venue_status = coalesce(${venueStatus}, venue_status), updated_at = now()
      where id = ${row.id} and (record->>'version')::int = ${row.record.version} returning *`;
    if (!r) throw new GatewayError('concurrent_update', `order ${row.id} was changed by another worker`);
    return r;
  }

  /** events for what a seam says about an order that is in SUBMITTING / SUBMITTED / UNKNOWN */
  private async settle(row: IntentRow, res: SeamResult | null, submittedAt: number): Promise<IntentRow> {
    const o = row.order_json, st = row.record.state;
    if (res === null) {
      // no trace: conclusive only when the seam can prove absence, and only after its grace
      const at = this.b.seam.absenceConclusiveAt(o, submittedAt);
      const next = await this.apply(row, [{ type: 'reconciled_absent', supportsClientIdLookup: at !== null, conclusiveAt: at, detail: 'no trace of the order on the execution side' }]);
      return next;
    }
    if (res.status === 'accepted') {
      const filled = D.from(res.filledSize), some = D.isPos(filled);
      const fills: AgentFill[] = res.fills.map((f, i) => ({ id: f.id ?? `${row.id}:${i}`, size: f.size, price: f.price, feeUsd: f.feeUsd ?? null, ts: f.ts ?? this.now() }));
      // an order given as a notional has no size of its own: once it is final, what was filled is the whole of it
      const full = row.record.size !== null ? D.gte(filled, D.from(row.record.size)) : res.final && some;
      const status = full ? 'filled' as const : res.final ? 'cancelled' as const : 'resting' as const;
      // still resting with nothing new: no event (a reconciliation pass must not grow the history of an idle order)
      if (status === 'resting' && (st === 'SUBMITTED' || st === 'PARTIALLY_FILLED') && D.eq(filled, D.from(row.record.filledSize))) return row;
      const ev: OrderEvent[] = [{ type: 'reconciled_found', status, filledSize: res.filledSize, avgFillPrice: some ? res.avgFillPrice : null, venueOrderId: res.venueOrderId, ...(res.note ? { detail: res.note.slice(0, 500) } : {}) }];
      return this.apply(row, ev, fills, res.venueStatus ?? null);
    }
    if (res.status === 'rejected') {
      if (st === 'SUBMITTING' && res.by !== 'venue') return this.apply(row, [{ type: 'local_rejected', reason: res.by === 'mandate' ? 'MANDATE_DENIED' : res.by === 'signer' ? 'SIGNER_REFUSED' : res.by === 'mode' ? 'READ_ONLY_MODE' : 'RISK_DENIED', detail: `${res.code}: ${res.reason}`.slice(0, 500) }]);
      return this.apply(row, [{ type: 'venue_rejected', reason: `${res.code}: ${res.reason}`.slice(0, 500), detail: `${res.code}: ${res.reason}`.slice(0, 500) }]);
    }
    if (res.status === 'not_sent') {
      if (st === 'SUBMITTING') return this.apply(row, [{ type: 'local_failed', reason: 'NOT_SENT', detail: `${res.code}: ${res.reason}`.slice(0, 500) }]);
      // the execution side itself says that the order it was handed never went out (its own record of it is "failed, nothing sent")
      if (st === 'UNKNOWN') return this.apply(row, [{ type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: this.now(), detail: `${res.code}: ${res.reason}`.slice(0, 500) }]);
      if (st === 'SUBMITTED' || st === 'PARTIALLY_FILLED') return this.apply(row, [{ type: 'expired', source: 'venue', detail: `${res.code}: ${res.reason}`.slice(0, 500) }]);
      return row;
    }
    // pending: handed over, not confirmed
    if (st === 'SUBMITTING' && res.venueOrderId) return this.apply(row, [{ type: 'venue_accepted', venueOrderId: res.venueOrderId, detail: res.reason.slice(0, 500) }]);
    return row;
  }

  async submit(p: AgentPrincipal, input: CanonicalOrderInput, o: SubmitOptions): Promise<AgentOrderRecord> {
    this.own(p);
    const a = this.b.agent, order = canonicalOrder(input);
    if (order.principal.kind !== 'agent' || order.principal.id !== a.id) throw new GatewayError('wrong_principal', 'the order names another principal than the agent that submits it');
    if (!/^[\x21-\x7e]{8,128}$/.test(o.idempotencyKey)) throw new GatewayError('idempotency', 'an idempotency key of 8 to 128 printable characters is required');
    const ctx: SeamContext = { idempotencyKey: o.idempotencyKey, worstPrice: o.resolved?.worstPrice ?? null, signalId: o.context?.signalId ?? null, configVersion: o.context?.configVersion ?? a.config_version ?? null,
      strategySha256: o.context?.strategySha256 ?? null, bar: o.context?.bar ?? null, reason: o.context?.reason ?? null };

    // 1 — this key already has an order: its record is the answer. Never a second order, unless the last attempt provably never left.
    let prior = await this.latest(o.idempotencyKey);
    if (prior && AT_VENUE.includes(prior.record.state)) prior = await this.reconcileRow(prior);
    let attempt = 1;
    if (prior) {
      const retry = prior.record.state === 'FAILED' && PROVEN_NOT_SENT.includes(prior.record.reason);
      if (!retry) return view(prior, true);
      attempt = prior.attempt + 1;
    }

    // 2 — the record exists before anything else happens
    const id = attempt === 1 ? order.clientOrderId : `${order.clientOrderId}~${attempt}`, now = this.now();
    const rec = newOrder({ id, size: order.size }, now), mode = dbMode(order.mode as Mode);
    const inserted = await sql<IntentRow[]>`insert into agent_order_intents (id, client_order_id, attempt, agent_id, mode, idempotency_key, body_hash, venue, instrument, side, reduce_only, order_json, record, state, reason, signal_id, config_version, strategy_sha256)
      values (${id}, ${order.clientOrderId}, ${attempt}, ${a.id}, ${mode}, ${o.idempotencyKey}, ${orderBodyHashHex(order)}, ${order.venue}, ${order.instrument}, ${order.side}, ${order.reduceOnly}, ${sql.json(order as never)}, ${sql.json(rec as never)},
        ${rec.state}, ${rec.reason}, ${ctx.signalId}, ${ctx.configVersion}, ${ctx.strategySha256}) on conflict do nothing returning *`;
    let row = inserted[0];
    if (!row) { const again = await this.latest(o.idempotencyKey); if (again) return view(again, true); throw new GatewayError('concurrent_update', 'the order could not be recorded'); }   // another worker recorded it first

    const reject = async (reason: 'INVALID_ORDER' | 'RISK_DENIED' | 'MANDATE_DENIED' | 'KILL_SWITCH_ACTIVE' | 'READ_ONLY_MODE' | 'INSTRUMENT_NOT_ALLOWED' | 'VENUE_NOT_ALLOWED', detail: string): Promise<AgentOrderRecord> => {
      row = await this.apply(row!, [{ type: 'local_rejected', reason, detail: detail.slice(0, 500) }]);
      await journal(a.id, { mode, kind: 'risk', code: reason, severity: 'warning', title: `Refused before it left: ${reason}`, body: `${order.side} ${order.instrument} — ${detail}`, ref: { order: id, signal: ctx.signalId }, configVersion: ctx.configVersion });
      return view(row, false);
    };

    // 3 — mode: research never places an order; the order's mode is the agent's mode
    const agentMode = a.mode === 'LIVE' ? 'live' : a.mode === 'PAPER' ? 'paper' : 'research';
    if (order.mode === 'research' || agentMode === 'research') return reject('READ_ONLY_MODE', 'an agent in research mode places no order');
    if (order.mode !== agentMode) return reject('READ_ONLY_MODE', `the order says ${order.mode} and the agent is in ${agentMode}`);
    // 4 — kill switch: only what reduces risk
    const ks = await this.b.killSwitch?.engaged();
    if (ks?.engaged && !reducesRisk(order)) return reject('KILL_SWITCH_ACTIVE', `the kill switch is engaged (${ks.reason ?? 'no reason recorded'}): only orders that reduce risk are placed`);
    // 5 — authority: a live order names the mandate in force for this agent — and the agent cannot make one
    if (!this.b.authorityId || order.mandateId !== this.b.authorityId) {
      return reject('MANDATE_DENIED', order.mode === 'live' ? (this.b.authorityId ? 'the order names another mandate than the one in force for this agent' : 'no owner-approved mandate is in force for this agent') : 'the order does not name the simulated account of this agent');
    }
    // 6 — the agent's own limits
    const risk = await (this.b.risk ?? agentRiskGate).check(a, order);
    if (!risk.ok) return reject(risk.code, risk.reason);

    row = await this.apply(row, [{ type: 'validated' }, { type: 'approved', by: 'mandate', detail: order.mode === 'live' ? `mandate ${order.mandateId}` : 'simulated account: nothing is signed' }, { type: 'submit_started' }]);

    // 7 — the existing engine path. An exception here means the outcome is NOT KNOWN.
    let res: SeamResult;
    try { res = await this.b.seam.execute(order, ctx); }
    catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      row = await this.apply(row, [{ type: 'submit_ambiguous', reason: 'SUBMIT_NETWORK_ERROR', detail: msg }]);
      await journal(a.id, { mode, kind: 'error', code: 'ORDER_OUTCOME_UNKNOWN', severity: 'error', title: 'Order outcome unknown: it will be reconciled, not sent again', body: `${order.side} ${order.instrument} (${id}): ${msg}`, ref: { order: id, signal: ctx.signalId }, configVersion: ctx.configVersion });
      return view(row, false);
    }
    row = await this.settle(row, res, now);
    await this.note(row, res, ctx);
    return view(row, false);
  }

  private async note(row: IntentRow, res: SeamResult, ctx: Pick<SeamContext, 'signalId' | 'configVersion'>): Promise<void> {
    const o = row.order_json, ref = { order: row.id, signal: ctx.signalId }, base = { mode: row.mode, ref, configVersion: ctx.configVersion };
    const what = `${o.side} ${o.size ?? `${o.notional} (notional)`} ${o.instrument}${o.reduceOnly ? ' reduce-only' : ''}`;
    if (res.status === 'accepted') {
      await journal(row.agent_id, { ...base, kind: 'order', code: row.record.state, title: `Order ${row.record.state.toLowerCase().replace('_', ' ')}`, body: `${what} — ${row.mode === 'LIVE' ? 'venue' : 'simulated'} order ${res.venueOrderId}${res.note ? ` — ${res.note}` : ''}` });
      if (D.isPos(D.from(res.filledSize))) await journal(row.agent_id, { ...base, kind: 'fill', code: 'FILL', title: `Filled ${res.filledSize} at ${res.avgFillPrice ?? '?'}`, body: `${what}${row.mode === 'LIVE' ? '' : ' — SIMULATED fill'}`, data: { fills: row.fills } });
    } else if (res.status === 'rejected') {
      await journal(row.agent_id, { ...base, kind: 'risk', code: res.code, severity: 'warning', title: `Refused by the ${res.by === 'venue' ? 'venue' : res.by === 'signer' ? 'signer' : res.by === 'mandate' ? 'mandate' : 'risk engine'}`, body: `${what} — ${res.reason}` });
    } else if (res.status === 'not_sent') {
      await journal(row.agent_id, { ...base, kind: 'hold', code: res.code, title: 'Order not sent now', body: `${what} — ${res.reason}` });
    } else {
      await journal(row.agent_id, { ...base, kind: 'order', code: 'PENDING', title: 'Order handed over, not confirmed yet', body: `${what} — ${res.reason}` });
    }
  }

  private async reconcileRow(row: IntentRow): Promise<IntentRow> {
    let res: SeamResult | null;
    try { res = await this.b.seam.lookup(row.order_json); } catch { return row; }       // cannot be asked now: unchanged, asked again on the next pass
    const before = row.record.state;
    const next = await this.settle(row, res, row.record.createdAt);
    // an execution found by the reconciliation is a fill like any other: its own journal line
    if (D.gt(D.from(next.record.filledSize), D.from(row.record.filledSize))) await journal(row.agent_id, { mode: row.mode, kind: 'fill', code: 'FILL', title: `Filled ${next.record.filledSize} at ${next.record.avgFillPrice ?? '?'}`,
      body: `${row.order_json.side} ${row.order_json.instrument} (${row.id})${row.mode === 'LIVE' ? '' : ' — SIMULATED fill'}`, data: { fills: next.fills }, ref: { order: row.id, signal: row.signal_id }, configVersion: row.config_version });
    if (next.record.state !== before) await journal(row.agent_id, { mode: row.mode, kind: 'order', code: next.record.state, title: `Order reconciled: ${before} → ${next.record.state}`, body: `${row.order_json.side} ${row.order_json.instrument} (${row.id}) — ${next.record.reason}${next.record.detail ? `: ${next.record.detail}` : ''}`, ref: { order: row.id } });
    return next;
  }

  /** Ask the execution side about every order of this agent whose outcome is open. Called at the start of a tick. */
  async reconcile(): Promise<AgentOrderRecord[]> {
    const rows = await sql<IntentRow[]>`select * from agent_order_intents where agent_id = ${this.b.agent.id} and state in ${sql(AT_VENUE as string[])} order by created_at`;
    const out: AgentOrderRecord[] = [];
    for (const r of rows) out.push(view(await this.reconcileRow(r), true));
    return out;
  }

  async cancel(p: AgentPrincipal, orderId: string): Promise<AgentOrderRecord> {
    this.own(p);
    const [row] = await sql<IntentRow[]>`select * from agent_order_intents where id = ${orderId} and agent_id = ${this.b.agent.id}`;
    if (!row) throw new GatewayError('not_found', 'order not found');
    if (isTerminal(row.record.state)) return view(row, true);
    let next = await this.apply(row, [{ type: 'cancel_requested', detail: 'cancel requested by the agent' }]);
    if (!isTerminal(next.record.state) && this.b.seam.cancel) { const res = await this.b.seam.cancel(next.order_json).catch(() => null); if (res) next = await this.settle(next, res, next.record.createdAt); }
    return view(next, false);
  }
  async get(p: AgentPrincipal, orderId: string): Promise<AgentOrderRecord | null> {
    this.own(p);
    const [row] = await sql<IntentRow[]>`select * from agent_order_intents where id = ${orderId} and agent_id = ${this.b.agent.id}`;
    return row ? view(row, true) : null;
  }
  list(p: AgentPrincipal, filter: ListFilter = {}): Promise<AgentOrderRecord[]> { this.own(p); return listAgentOrders(this.b.agent.id, filter); }
}

/** The agent-level gate applied by this adapter before the seams' own risk engines: the instrument must be one of the agent's. */
export const agentRiskGate: RiskGate = {
  async check(a, order) {
    const symbol = order.instrument.slice(order.instrument.indexOf(':') + 1);
    if (!a.universe.includes(symbol)) return { ok: false, code: 'INSTRUMENT_NOT_ALLOWED', reason: `${order.instrument} is not one of this agent's instruments (${a.universe.join(', ')})` };
    return { ok: true };
  },
};

export const seamGatewayFactory: OrderGatewayFactory = (b) => new SeamOrderGateway(b);
let factory: OrderGatewayFactory = seamGatewayFactory;
/** THE integration point: main.ts (and agent-worker-main.ts) bind the factory; the unified order service replaces this binding. */
export function setOrderGatewayFactory(f: OrderGatewayFactory | null): void { factory = f ?? seamGatewayFactory; }
export const orderGateway = (b: SeamBinding): AgentOrderGateway => factory(b);
export { CanonicalOrderSchema };

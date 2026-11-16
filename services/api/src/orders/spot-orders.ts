// The spot side of the order service (V11 exec2). An OWNER's spot order is a swap proposal of the existing flow (orders/spot.ts
// `SpotPort`), kept as a unified order with truthful states:
//
//   CREATED → VALIDATED → AWAITING_APPROVAL  (the proposal waits for the owner's passkey in the app; cancellable here)
//           → APPROVED → SUBMITTING → SUBMITTED → FILLED | REJECTED | FAILED   (projected from the proposal row, never asserted here)
//
// What is refused before anything exists: an API key or an agent (403 `spot_execution_requires_agent_vault` — their spot
// execution is an agent vault under a spot mandate), paper mode (no paper spot engine for the owner), a BUY given as a base
// quantity (a swap is exact-input), and whatever the owner's defaults do not settle (409, with the question).
//
// Risk. A spot order is bounded by the signer's own policy (per-transfer and daily amounts, fee ceiling) and by the passkey; the
// unified risk engine has no spot context here, so only its two switches apply, BEFORE the proposal is created:
//   read-only mode  refuses every spot order;
//   kill switch     refuses a spot order unless it SELLS an asset the wallet holds INTO a cash leg (a USD stable of the registry's
//                   cash list): an exact-input sale from the wallet's own balance cannot open or add exposure — there is no
//                   short in a swap — so it is the spot equivalent of a strictly reducing order. A buy, and a sale into
//                   anything that is not a cash leg, is new risk and is refused.
// This is narrower than "the engine does not classify a spot sell as reducing" (V11-RISK-MODEL.md): the pure engine still does
// not; the classification is made here, on the two legs of the swap, where it can be shown.
import { ZodError } from 'zod';
import { CASH_SYMBOLS } from '@spw/core';
import { D, type DecStr } from '@spw/derivatives';
import { canonicalOrder, canonicalOrderHashHex, clientOrderIdFor, dedupe, isTerminal, orderBodyHashHex, type CanonicalOrder } from '@spw/trading';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { advance } from './projection.ts';
import type { Caller, OrderInput, OrderService } from './service.ts';
import { assetBySymbol, loadSpotSource, proposalKeyOf, SPOT_APPROVE_PATH, spotInstrument, spotNetworks, spotProvider, type SpotProposal } from './spot.ts';
import { applyEvent, getByEngineRef, getByIdempotency, getOrder, insertOrder, mutateWith, patchOrder, type Origin, type OrderRow } from './store.ts';

export interface SpotDefaults { spotNetwork?: string | undefined; spotQuote?: string | undefined; maxSlippageBps?: number | undefined }
export interface SpotSpec { provider: 'kyberswap' | 'jupiter'; network: string; base: string; quote: string; side: 'buy' | 'sell'; /** decimal amount of what is GIVEN: the quote for a buy, the base for a sell */ amount: DecStr; slippageBps: number; canonical: CanonicalOrder }
const SPOT_VENUES = ['spot', 'kyberswap', 'jupiter'];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const refusal = (code: string, message: string, status: number, data: Record<string, unknown>): UserError => Object.assign(new UserError(code, message, status), { data });
const ORDER_TTL_MS = 120_000;

export class SpotOrders {
  constructor(private readonly svc: OrderService) {}
  static is(instrument: string): boolean { const k = instrument.indexOf(':'); return k > 0 && SPOT_VENUES.includes(instrument.slice(0, k)); }

  /** who may place a spot order here, and in which mode */
  private admit(c: Caller, mode: string): void {
    if (c.principal.kind !== 'owner') throw new UserError('spot_execution_requires_agent_vault', 'spot execution for an API key or an agent exists only through an agent vault under a spot mandate (Agents); it is not offered on this endpoint', 403);
    if (mode !== 'live') throw new UserError('spot_paper_not_available', 'there is no paper spot engine for the owner: a spot order of the owner is a real swap, prepared and approved with the passkey (mode "live"). Paper spot trading exists for agents only.', 422);
  }

  /** POST /orders with a spot instrument (`spot:ETH` or `spot:ETH-USDC`): only an exact-input SELL is expressible */
  async specOfInput(c: Caller, i: OrderInput, idemKey: string, now: number): Promise<SpotSpec> {
    this.admit(c, i.mode);
    const sym = i.instrument.slice(i.instrument.indexOf(':') + 1), dash = sym.indexOf('-'), base = (dash > 0 ? sym.slice(0, dash) : sym).toUpperCase(), named = dash > 0 ? sym.slice(dash + 1).toUpperCase() : undefined;
    if (i.type !== 'market') throw new UserError('spot_market_only', 'a spot order here is an immediate swap with a minimum output (a market order bounded by slippageBps): resting and trigger orders do not exist for spot', 422);
    if (i.reduceOnly) throw new UserError('invalid_order', 'reduceOnly has no meaning for a spot order', 400);
    if (i.side === 'buy') throw new UserError('spot_buy_needs_quote_amount', `a swap is exact-input: a spot BUY is expressed as the amount of the quote asset to spend, which this endpoint's order body cannot carry (it has a base size only). Send it as a command: POST /commands { "text": "BUY ${base} <amount> <quote>" }.`, 422);
    const d = await this.defaults(), questions: { field: string; options: string[]; message: string }[] = [];
    const network = d.spotNetwork, quote = named ?? d.spotQuote?.toUpperCase();
    if (network === undefined) questions.push({ field: 'network', options: spotNetworks().filter((n) => assetBySymbol(n, base) !== null), message: `on which network? The owner's defaults (spotNetwork) do not say` });
    if (quote === undefined) questions.push({ field: 'quote', options: [...CASH_SYMBOLS], message: `sell ${base} for which asset? Neither the instrument (spot:${base}-<quote>) nor the owner's defaults (spotQuote) say` });
    if (questions.length || network === undefined || quote === undefined) throw refusal('ambiguous_order', 'the order and the owner\'s defaults do not settle everything: nothing was created', 409, { questions });
    return this.spec(c, { network, base, quote, side: 'sell', amount: i.size, slippageBps: i.slippageBps ?? d.maxSlippageBps ?? 50, maxFeeUsd: i.maxFeeUsd ?? '0', idemKey, now });
  }
  /** a canonical spot order resolved by the command grammar (instrument `${provider}:${BASE}-${QUOTE}`) */
  specOfCanonical(c: Caller, order: CanonicalOrder): SpotSpec {
    this.admit(c, order.mode);
    if (order.marketKind !== 'spot' || order.type !== 'market') throw new UserError('spot_market_only', 'a spot order here is an immediate swap with a minimum output', 422);
    const sym = order.instrument.slice(order.instrument.indexOf(':') + 1), dash = sym.indexOf('-');
    if (dash < 1) throw new UserError('invalid_order', 'a spot instrument is named <base>-<quote>', 400);
    const provider = spotProvider(order.network);
    if (!provider) throw new UserError('swap_not_enabled', `the wallet does not execute swaps on ${order.network}`, 422);
    const amount = order.side === 'buy' ? order.notional : order.size;
    if (amount === null) throw new UserError('invalid_order', order.side === 'buy' ? 'a spot buy names the amount of the quote asset to spend' : 'a spot sell names the quantity to sell', 400);
    return { provider, network: order.network, base: sym.slice(0, dash).toUpperCase(), quote: sym.slice(dash + 1).toUpperCase(), side: order.side, amount, slippageBps: order.maxSlippageBps, canonical: order };
  }
  private spec(c: Caller, o: { network: string; base: string; quote: string; side: 'buy' | 'sell'; amount: string; slippageBps: number; maxFeeUsd: string; idemKey: string; now: number }): SpotSpec {
    const provider = spotProvider(o.network);
    if (!provider) throw new UserError('swap_not_enabled', `the wallet does not execute swaps on ${o.network}`, 422);
    let canonical: CanonicalOrder;
    try {
      canonical = canonicalOrder({ v: 1, venue: provider, network: o.network, instrument: `${provider}:${o.base}-${o.quote}`, marketKind: 'spot', side: o.side, type: 'market', size: o.side === 'sell' ? o.amount : null, notional: o.side === 'buy' ? o.amount : null,
        limitPrice: null, triggerPrice: null, reduceOnly: false, tif: 'ioc', maxSlippageBps: o.slippageBps, maxFeeUsd: o.maxFeeUsd, leverage: null, marginMode: null, clientOrderId: clientOrderIdFor(provider, c.principal, o.idemKey), mode: 'live',
        principal: c.principal, mandateId: null, createdAt: o.now, expiresAt: o.now + ORDER_TTL_MS });
    } catch (e) { throw new UserError('invalid_order', e instanceof ZodError ? `${e.issues[0]?.path.join('.') ?? ''} ${e.issues[0]?.message ?? ''}`.trim() : msg(e), 400); }
    return { provider, network: o.network, base: o.base, quote: o.quote, side: o.side, amount: canonical.side === 'buy' ? canonical.notional! : canonical.size!, slippageBps: o.slippageBps, canonical };
  }
  private async defaults(): Promise<SpotDefaults> { return (await this.svc.deps.spotDefaults?.()) ?? {}; }

  /** the two legs as registry assets; 422 when a symbol is not ONE asset of the network */
  private legs(s: SpotSpec): { from: { id: string; symbol: string; decimals: number }; to: { id: string; symbol: string; decimals: number } } {
    const b = assetBySymbol(s.network, s.base), q = assetBySymbol(s.network, s.quote);
    if (!b) throw new UserError('unsupported_asset', `${s.base} is not exactly one asset of the wallet registry on ${s.network}`, 422);
    if (!q) throw new UserError('unsupported_asset', `${s.quote} is not exactly one asset of the wallet registry on ${s.network}`, 422);
    return s.side === 'buy' ? { from: q, to: b } : { from: b, to: q };
  }
  /** does this spot order take new risk? Only a sale INTO a cash leg does not (header). */
  static addsRisk(s: Pick<SpotSpec, 'side' | 'base' | 'quote'>): boolean { return !(s.side === 'sell' && CASH_SYMBOLS.includes(s.quote) && !CASH_SYMBOLS.includes(s.base)); }
  /** read-only mode and the kill switch, as they apply to this spot order; null = it may go on */
  private async blocked(s: SpotSpec): Promise<{ code: 'kill_switch_active' | 'read_only_mode'; reason: string } | null> {
    const b = await this.svc.deps.risk.newRiskBlock();
    if (!b) return null;
    if (b.code === 'read_only_mode') return b;
    return SpotOrders.addsRisk(s) ? { code: b.code, reason: `${b.reason}. A spot order passes under the kill switch only when it sells an asset into a cash leg (${CASH_SYMBOLS.join(', ')}); this one ${s.side === 'buy' ? `buys ${s.base}` : `sells ${s.base} for ${s.quote}`}.` } : null;
  }

  private view(r: OrderRow) { return this.svc.view(r); }
  private async answer(r: OrderRow, idempotent: boolean, p: SpotProposal | null) {
    const d = r.detail as { proposalId?: string };
    let approval: Record<string, unknown> | null = null;
    if (r.state === 'AWAITING_APPROVAL' && d.proposalId) {
      const [row] = await sql<{ intent_hash: string | null; expires_at: Date | null }[]>`select intent_hash, expires_at from proposals where id = ${d.proposalId}`;
      approval = { by: 'owner_passkey', engine: 'spot', proposalId: d.proposalId, hash: row?.intent_hash ?? p?.intentHash ?? null, expiresAt: row?.expires_at?.getTime() ?? p?.expiresAt ?? null,
        /** the WebAuthn request of the swap flow itself (present in the answer that created the proposal; ask the proposal again in the app otherwise) */ options: p?.options ?? null,
        approve: { method: 'POST', path: SPOT_APPROVE_PATH(d.proposalId), body: '{ assertion }', note: 'owner session only: the passkey assertion is over the intent hash of the swap; the isolated signer verifies it and decodes the swap itself' } };
    }
    return { order: this.view(r), idempotent, approval };
  }

  /** every refusal a spot order would meet before its proposal, on the state as it is now. Nothing is created; no route is quoted. */
  async preview(c: Caller, s: SpotSpec) {
    const refusals: { stage: 'risk' | 'engine'; code: string; message: string }[] = [];
    try { this.legs(s); } catch (e) { if (!(e instanceof UserError)) throw e; refusals.push({ stage: 'engine', code: e.code, message: e.message }); }
    const b = await this.blocked(s);
    if (b) refusals.push({ stage: 'risk', code: b.code, message: b.reason });
    return { order: s.canonical, hash: canonicalOrderHashHex(s.canonical), resolved: null, wouldExecute: refusals.length === 0, refusals,
      approval: { required: true, by: 'owner_passkey' as const, note: 'the order becomes a swap proposal (firm route, policy check) and waits AWAITING_APPROVAL until the owner approves it with the passkey in the app' },
      risk: { decision: b ? 'deny' as const : 'allow' as const, reducing: !SpotOrders.addsRisk(s), checks: [], derived: null, decisionId: null,
        note: 'a spot order is bounded by the signer\'s policy and the passkey; of the unified risk engine only the kill switch and read-only mode apply to it' },
      mandate: null, engine: { name: 'spot' as const, provider: s.provider, risk: null, estimate: null, note: 'the firm route and its minimum output are established when the proposal is prepared, by the existing swap flow' },
      account: { id: null, venue: 'spot', network: s.network, equity: null, freeCollateral: null }, ts: this.svc.now() };
  }

  /** places the order: a unified order, then the proposal of the existing swap flow. Idempotent on (principal, idemKey). */
  async submit(c: Caller, s: SpotSpec, idemKey: string, origin: Origin = 'trading_api') {
    const order = s.canonical, id = order.clientOrderId, bodyHash = orderBodyHashHex(order), now = this.svc.now();
    const existing = (await getByIdempotency(c.principal, idemKey)) ?? (await getOrder(id));
    if (existing) {
      if (existing.principal_kind !== c.principal.kind || existing.principal_id !== c.principal.id) throw new UserError('idempotency_conflict', 'this client order id belongs to another principal', 409);
      if (dedupe(existing.body_hash ? { clientOrderId: existing.id, bodyHash: existing.body_hash } : null, { bodyHash }).kind === 'conflict') throw new UserError('idempotency_conflict', 'this Idempotency-Key was used with a different order', 409);
      const d = existing.detail as { proposalId?: string };
      if (d.proposalId) await this.project('swap', d.proposalId);
      return this.answer((await getOrder(existing.id))!, true, null);
    }
    const legs = this.legs(s);                                       // refused before an order exists
    if (!c.session?.cookie) throw new UserError('owner_session_required', 'a spot order is prepared in the owner\'s own session', 403);
    if (!this.svc.deps.spot) throw new UserError('execution_not_wired', 'this server has no connection to the swap flow', 501);
    const proposalKey = proposalKeyOf(id);
    const row = await insertOrder({ id, principal: c.principal, idempotencyKey: idemKey, bodyHash, mode: 'live', venue: 'spot', network: s.network, instrument: spotInstrument(s.base, s.quote), marketKind: 'spot', side: s.side, type: 'market', reduceOnly: false,
      accountId: null, mandateId: null, canonical: order, orderHash: canonicalOrderHashHex(order), size: s.side === 'sell' ? s.amount : null, engine: 'spot', engineRef: null, notionalUsd: s.side === 'buy' && CASH_SYMBOLS.includes(s.quote) ? s.amount : null, origin,
      detail: { clientId: id, proposalKey, provider: s.provider, fromSymbol: legs.from.symbol, toSymbol: legs.to.symbol, amountIn: s.amount, slippageBps: s.slippageBps, tif: 'ioc', price: null, triggerPrice: null }, createdAt: order.createdAt });
    if (!row) { const again = (await getByIdempotency(c.principal, idemKey)) ?? (await getOrder(id)); if (again) return this.answer(again, true, null); throw new UserError('idempotency_conflict', 'this client order id is in use', 409); }
    // the switches, on the stored order: a refusal is a state of it
    const b = await this.blocked(s);
    if (b) {
      const r = (await applyEvent(id, { type: 'local_rejected', reason: b.code === 'kill_switch_active' ? 'KILL_SWITCH_ACTIVE' : 'READ_ONLY_MODE', detail: b.reason.slice(0, 500) }, this.svc.now(), { rejectCode: b.code }))!.row;
      throw refusal(b.code, b.reason, 423, { order: this.view(r) });
    }
    await applyEvent(id, { type: 'validated' }, this.svc.now());
    let p: SpotProposal;
    try { p = await this.svc.deps.spot.propose(c.session, { network: s.network, fromAsset: legs.from.id, toAsset: legs.to.id, amount: s.amount, slippageBps: s.slippageBps }, proposalKey); }
    catch (e) {
      // the swap flow created nothing (it answers an error before it stores a proposal, or the proposal is found by its key at the next projection)
      const [made] = await sql<{ id: string }[]>`select id from proposals where idempotency_key = ${proposalKey}`;
      if (made) { await this.project('swap', made.id); const cur = (await getOrder(id))!; return this.answer(cur, false, null); }
      const ue = e instanceof UserError ? e : new UserError('internal', 'the swap flow could not be reached; nothing was prepared', 500);
      const r = ue.status < 500
        ? (await applyEvent(id, { type: 'local_rejected', reason: ue.code === 'halted' ? 'SIGNER_REFUSED' : ue.code === 'policy' ? 'RISK_DENIED' : 'INVALID_ORDER', detail: `${ue.code}: ${ue.message}`.slice(0, 500) }, this.svc.now(), { rejectCode: ue.code }))!.row
        : (await applyEvent(id, { type: 'local_failed', reason: 'INTERNAL_ERROR', detail: `the swap flow prepared nothing (${ue.code}: ${ue.message}); nothing was signed or sent`.slice(0, 500) }, this.svc.now(), { rejectCode: ue.code }))!.row;
      throw refusal(ue.code, ue.message, ue.status, { order: this.view(r) });
    }
    await this.project('swap', p.id);
    void now;
    return this.answer((await getOrder(id))!, false, p);
  }

  /** withdraws a spot order that still waits for the passkey: the existing reject route of the proposal. Later, a swap cannot be recalled. */
  async cancel(c: Caller, r: OrderRow) {
    if (isTerminal(r.state)) return { order: this.view(r), sent: false, changed: false };
    const d = r.detail as { proposalId?: string };
    if (r.principal_kind !== 'owner') throw new UserError('cancel_in_app', 'a spot agent\'s swap is not cancelled order by order: pause or stop the agent', 422);
    if (!d.proposalId) { const a = await applyEvent(r.id, { type: 'cancel_requested', reason: 'CANCELLED_BY_REQUEST' }, this.svc.now()); return { order: this.view(a!.row), sent: false, changed: true }; }
    if (r.state !== 'AWAITING_APPROVAL') throw new UserError('bad_state', `the swap is ${r.state}: once approved with the passkey it is signed and relayed, and cannot be withdrawn`, 409);
    if (c.principal.kind !== 'owner' || !c.session?.cookie || !this.svc.deps.spot) throw new UserError('owner_session_required', 'a swap proposal is withdrawn in the owner\'s own session', 403);
    await this.svc.deps.spot.withdraw(c.session, d.proposalId);
    await this.project('swap', d.proposalId);
    return { order: this.view((await getOrder(r.id))!), sent: false, changed: true };
  }

  /** one swap proposal or one agent order → the events of its unified order. Idempotent (same signature: nothing). */
  async project(kind: 'swap' | 'agent_swap', ref: string): Promise<OrderRow | null> {
    const src = await loadSpotSource(kind, ref);
    if (!src) return null;
    let row = await getByEngineRef('spot', src.engineRef);
    if (!row && src.proposalKey) {
      // an order of this service whose proposal was just created: linked by the idempotency key the service derived for it
      const [mine] = await sql<OrderRow[]>`select * from orders where engine = 'spot' and engine_ref is null and detail->>'proposalKey' = ${src.proposalKey} limit 1`;
      if (mine) row = (await patchOrder(mine.id, this.svc.now(), { engineRef: src.engineRef, detail: { proposalId: ref } }))?.row ?? null;
    }
    if (!row) { await insertOrder(src.adopt); row = await getByEngineRef('spot', src.engineRef); }
    if (!row) return null;
    if (row.engine_sig === src.snapshot.sig && row.projection_error === null) return row;
    const now = this.svc.now();
    const out = await mutateWith(row.id, now, (_locked, record) => {
      const a = advance(record, src.snapshot, now);
      return { steps: a.steps, order: a.order, patch: { engineSig: src.snapshot.sig, projectionError: a.error, detail: { engineState: src.engineState, engineReason: src.engineReason, ...(src.execution ? { execution: src.execution } : {}) } } };
    });
    if (out?.row.projection_error) console.error(`[orders] projection of spot ${src.engineRef}: ${out.row.projection_error}`);
    return out?.row ?? row;
  }
}

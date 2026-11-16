// The LIVE implementation of `PerpExecutor` (perp-engine.ts): a venue account (Hyperliquid, testnet or mainnet) whose orders
// the isolated signer signs under a derivative mandate the owner approved with ONE passkey (docs/v6/DERIVATIVE-MANDATE.md).
// It reaches live trading only through the narrow server-side interface of derivatives/mandate.ts: it holds no key, cannot
// widen anything, and every order is checked by the API's risk engine against the venue's real state and then by the signer
// against the mandate (positions and exposure included, from the signer's OWN read of the venue).
//
// What this executor guarantees to the engine:
//  - VENUE TRUTH. `account()` and `positions()` are the venue's own account state and positions (`source: 'venue'`). There is
//    no local model of the account: an unreadable venue throws (the engine retries the pass), it is never shown as empty.
//  - CONFIRMED RESULTS. `placed` is returned only when the venue's own records confirm the order (filled, partly filled with
//    the remainder cancelled, or cancelled). An order the venue has not confirmed (`unknown`, signed but not acknowledged…)
//    is `deferred`, and NOTHING more is sent on that instrument until the venue resolves it.
//  - IDEMPOTENCE. The engine's client id is the idempotency key of the live module: the same key never places a second order —
//    after a crash between signing and reconciliation the stored order is looked up on the venue by its client order id.
//  - NO HAMMERING. After any order reached the signer, an order that can add exposure waits for the next pass (the signer
//    counts a signed order as exposure until its venue expiry + grace, ≈ 40 s): at most one exposure-adding order per pass and
//    account. A signer or risk refusal is returned as `refused` — the engine holds that instrument until the next bar, and the
//    refused order is stored under its key, so it cannot be retried in a loop.
//  - LEVERAGE. Before an order that can add exposure, the venue's leverage setting of the instrument is read and, when it
//    differs from the agent's policy (never above the mandate's), set through `setMandateLeverage` — once, not per order.
//  - FLOOR. No exposure is added once the account value is within a margin of the mandate's `floorEquity` (well before the
//    signer would refuse); reduce-only orders always pass.
//  - PER-ORDER BOUND. The mandate bounds EVERY order by its notional, closes included: a larger order is cut to the bound and
//    reported as partly done — the engine continues from the real position.
//  - THE MANDATE IS OVER. A refusal that means so (revoked, expired, wind-down, authorization gone, server lock, halt) is
//    recorded in `exit`: perp-live-cycle.ts then takes the agent out of LIVE.
import { D, type DecStr, type Order, type OrderRequest, type Position } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import type { LiveService } from '../derivatives/exec.ts';
import { mandateAccountState, mandateOrder, placeMandateOrder, setMandateLeverage, type MandateAccountState, type MandateLiveOrder } from '../derivatives/mandate.ts';
import { perpPolicy, type ExecAccount, type PerpExecutor, type PerpRisk, type PlaceResult } from './perp-engine.ts';

/** after an order reached the signer, an order that can add exposure waits this long: the signer's ledger keeps a signed order
 *  until its venue expiry (30 s for mandate orders) + 10 s of grace; 5 s more for clocks */
export const LIVE_COOLDOWN_MS = 45_000;
/** share of the loss budget (reference capital − floor) kept as a margin above the mandate's floor: below it no exposure is added */
export const FLOOR_GUARD_FRACTION = '0.25';
/** an order is cut to this share of the mandate's per-order notional (its price can move between here and the signer) */
const ORDER_CAP_HEADROOM = '0.99';

/** refusals that mean "this mandate will not sign new exposure again": the agent leaves LIVE */
export const LIVE_EXIT_CODES: ReadonlySet<string> = new Set([
  'signer_revoked', 'signer_expired', 'signer_wind_down', 'signer_no_authorization', 'signer_not_found', 'signer_halted',
  'mandate_mainnet_disabled', 'mainnet_disabled', 'mandate_none', 'mandate_wind_down', 'mandate_mismatch', 'mandate_unavailable',
  'mode_read_only', 'authorization_expired', 'halted',
]);
/** states of a live order that the venue's own records confirm */
const CONFIRMED = new Set(['filled', 'partially_filled', 'cancelled']);

export interface LiveExecOptions {
  accountId: string; agentId: string; strategySha256: string; symbols: string[]; risk: PerpRisk;
  /** reference capital (the venue's account value at go-live): the floor guard is measured against it */
  capital: DecStr;
}
export interface LiveHold { instrument: string; code: string; reason: string; kind: 'refused' | 'deferred' }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class LivePerpExecutor implements PerpExecutor {
  readonly kind = 'live' as const;
  private readonly svc: LiveService;
  private readonly o: LiveExecOptions;
  private snap: MandateAccountState | null = null;
  private dirty = true;
  /** instrument → client id of an order of this agent that the venue has not confirmed yet */
  private readonly pending = new Map<string, string>();
  private reconciled = false;
  /** a refusal that means the mandate is over (first one wins) */
  exit: { code: string; reason: string } | null = null;
  /** what was refused or deferred during this pass */
  readonly holds: LiveHold[] = [];
  /** requests of this pass that reached the mandate helpers (tests, diagnostics) */
  readonly stats = { orders: 0, leverage: 0 };

  constructor(svc: LiveService, o: LiveExecOptions) { this.svc = svc; this.o = o; }
  /** the venue account this executor trades (V11: the order gateway looks an order up on it) */
  get accountId(): string { return this.o.accountId; }

  /** the venue's own state, read now; an unreadable venue is an error, never an empty account */
  private async read(): Promise<MandateAccountState> {
    const s = await mandateAccountState(this.o.accountId, this.svc);
    if (s.error !== null || s.state === null) throw new UserError('venue_unavailable', `the venue account could not be read: ${s.error ?? 'no state'}`, 503);
    this.snap = s; this.dirty = false;
    return s;
  }
  private async state(): Promise<MandateAccountState> { return this.dirty || !this.snap ? this.read() : this.snap; }

  /** every order of this agent that is not final is looked up on the venue (the only way out of `unknown`) */
  private async reconcilePending(): Promise<void> {
    const rows = await sql<{ client_id: string; instrument: string }[]>`select client_id, instrument from deriv_orders
      where account_id = ${this.o.accountId} and origin = 'mandate' and agent->>'agentId' = ${this.o.agentId} and state is not null and not final order by created_at`;
    this.pending.clear();
    for (const r of rows) {
      const o = await mandateOrder(this.o.accountId, r.client_id, this.svc);
      if (o && !o.final && !CONFIRMED.has(o.state)) this.pending.set(r.instrument, r.client_id);
    }
    this.reconciled = true;
    if (rows.length) this.dirty = true;
  }

  async account(_sinceEventId = 0): Promise<ExecAccount> {
    if (!this.reconciled) await this.reconcilePending();
    const s = await this.read();
    // The circuit breakers of a venue account (owner halt, divergence) and its liquidations are handled by the live life cycle
    // BEFORE the engine runs (perp-live-cycle.ts): the engine sees the venue's state and the agent's own limits.
    return { state: s.state!, policy: { ...perpPolicy(this.o.symbols, this.o.capital, this.o.risk, null), mode: 'MANDATE_LIVE' as never }, events: [] };
  }

  async positions(): Promise<Position[]> { return (await this.state()).positions; }

  /** instruments on which an order of this agent is still unconfirmed by the venue */
  unconfirmed(): string[] { return [...this.pending.keys()]; }

  private refuse(instrument: string, code: string, reason: string): PlaceResult {
    if (LIVE_EXIT_CODES.has(code)) this.exit ??= { code, reason };
    this.holds.push({ instrument, code, reason, kind: 'refused' });
    return { status: 'refused', code, reason };
  }
  private defer(instrument: string, code: string, reason: string): PlaceResult {
    this.holds.push({ instrument, code, reason, kind: 'deferred' });
    return { status: 'deferred', code, reason };
  }
  /** a thrown refusal: 5xx = "could not be attempted now" (thrown on: the engine retries the pass); anything else is a refusal */
  private refused(instrument: string, e: unknown): PlaceResult {
    if (!(e instanceof UserError)) throw e;
    if (e.status >= 500 && !LIVE_EXIT_CODES.has(e.code)) throw e;
    return this.refuse(instrument, e.code, e.message);
  }

  /** the engine's answer for a stored live order, from the VENUE's view of it */
  private result(req: OrderRequest, wanted: DecStr, o: MandateLiveOrder, idempotent: boolean): PlaceResult {
    const order = (status: Order['status'], rejectReason: string | null): Order => ({ ...req, size: wanted, price: o.price, venueOrderId: o.venueOrderId, status, filled: o.filled, avgFillPrice: o.avgFillPrice,
      createdAt: o.createdAt, updatedAt: o.updatedAt, rejectReason });
    const cut = D.lt(D.from(o.size), D.from(wanted));
    if (o.state === 'filled') {
      return { status: 'placed', idempotent, fills: [], order: cut ? order('partially_filled', `cut to the mandate's notional per order: ${o.size} of ${wanted} sent and filled; the rest follows from the real position`) : order('filled', null) };
    }
    if (o.state === 'partially_filled' && (o.final || o.source === 'venue')) return { status: 'placed', idempotent, fills: [], order: order('partially_filled', o.reason ?? 'remainder not filled') };
    if (o.state === 'cancelled' && o.venueOrderId) return { status: 'placed', idempotent, fills: [], order: order('cancelled', o.reason ?? 'not filled') };
    if (o.state === 'cancelled') return this.refuse(req.instrument, 'withdrawn', o.reason ?? 'withdrawn before it was signed');
    if (o.state === 'rejected') {
      const why = o.reason ?? 'rejected';
      const code = /^never placed/.test(why) ? 'never_placed' : /^(refused by the venue|not sent)/.test(why) ? 'venue_rejected' : /^not signed/.test(why) ? 'not_signed' : (/^([a-z_]{3,40}): /.exec(why)?.[1] ?? 'rejected');
      // a stored refusal answered again is not a new fact: it holds the instrument until the next bar, it does not end the mandate
      this.holds.push({ instrument: req.instrument, code, reason: why, kind: 'refused' });
      return { status: 'refused', code, reason: why };
    }
    // signed / submitted / unknown / open: the venue has not confirmed anything yet
    this.pending.set(req.instrument, o.clientId);
    return this.defer(req.instrument, 'live_unknown_pending', `order ${o.clientId} is ${o.state}: ${o.reason ?? 'the venue has not confirmed it yet'}; nothing more is sent on ${req.instrument} until the venue resolves it`);
  }

  /** the venue's leverage setting of the instrument, brought to the agent's policy (≤ the mandate's) when it differs */
  private async ensureLeverage(s: MandateAccountState, instrument: string, leverage: DecStr): Promise<PlaceResult | null> {
    const symbol = instrument.slice(instrument.indexOf(':') + 1), mi = s.mandate!.limits.instruments.find((i) => i.instrument === instrument);
    if (!mi) return this.refuse(instrument, 'instrument_not_allowed', `${instrument} is not in the mandate`);
    const want = Math.max(1, Math.min(Number(leverage), mi.maxLeverage));
    const cur = await this.svc.deps.venues.get(s.network).leverageOf(s.account, symbol);
    // the signer never changes the margin mode of an open position: keep the position's own mode
    const mode = s.positions.find((p) => p.instrument === instrument)?.marginMode ?? 'cross';
    if (cur.leverage === String(want) && cur.marginMode === mode) return null;
    this.stats.leverage += 1;
    const r = await setMandateLeverage(this.o.accountId, { instrument, leverage: want, marginMode: mode }, { strategySha256: this.o.strategySha256, agentId: this.o.agentId }, this.svc);
    if (r.venue.confirmed) return null;
    return this.refuse(instrument, 'leverage_not_set', `the venue did not confirm ${want}x ${mode} on ${symbol} (it reports ${r.venue.leverage ? `${r.venue.leverage.leverage}x ${r.venue.leverage.marginMode}` : 'nothing'}; ${r.action.error ?? r.action.state}): no order that can add exposure is sent on it`);
  }

  /**
   * V11.2 — everything this executor decides BEFORE an order exists (steps 1 to 5 below). Nothing is signed or sent here.
   * `place` (the seam path) and the unified order gateway (`perpSeam.prepare`) both pass through it: the order then goes to the
   * signer through `placeMandateOrder`, called here or by the unified order service.
   */
  async prepare(req: OrderRequest, leverage: DecStr): Promise<{ proceed: true; size: DecStr } | { proceed: false; result: PlaceResult }> {
    const instrument = req.instrument, stop = (result: PlaceResult) => ({ proceed: false as const, result });
    if (req.price === null) return stop(this.refuse(instrument, 'bad_request', 'a live order names its worst acceptable price'));
    if (!this.reconciled) await this.reconcilePending();
    // 1 — an earlier order on this instrument that the venue has not confirmed: nothing more on it until it resolves
    const waiting = this.pending.get(instrument);
    if (waiting) return stop(this.defer(instrument, 'live_unknown_pending', `order ${waiting} on ${instrument} is still being checked on the venue; nothing more is sent on this instrument until it resolves`));
    let s: MandateAccountState;
    try { s = await this.state(); } catch (e) { return stop(this.refused(instrument, e)); }
    const m = s.mandate;
    // V11 (B-02): a server lock (`blocked`) stops what can add exposure; the agent's way out — a reduce-only order — still goes
    // when the account says it can reduce (authorization alive, mandate active or winding down)
    if (s.blocked && !(req.reduceOnly && s.canReduce)) return stop(this.refuse(instrument, s.blocked.code, s.blocked.message));
    if (!m || m.phase === 'ended') return stop(this.refuse(instrument, 'mandate_none', 'no derivative mandate is in force on this venue account'));
    let size = req.size;
    try {
      if (!req.reduceOnly) {
        if (m.phase !== 'active') return stop(this.refuse(instrument, 'mandate_wind_down', 'the mandate is being wound down: only reduce-only orders are placed'));
        if (s.halted) return stop(this.refuse(instrument, 'halted', `trading is halted on the venue account: ${s.halted}`));
        // 2 — the signer still counts the last signed order: wait for the next pass before adding exposure
        const since = new Date(this.svc.now() - LIVE_COOLDOWN_MS);
        const [recent] = await sql<{ client_id: string }[]>`select client_id from deriv_orders where account_id = ${this.o.accountId} and origin = 'mandate' and signature is not null
          and created_at > ${since} and (not reduce_only or instrument = ${instrument}) order by created_at desc limit 1`;
        if (recent) return stop(this.defer(instrument, 'live_cooldown', `order ${recent.client_id} reached the signer less than ${LIVE_COOLDOWN_MS / 1000} s ago, and the signer counts a signed order as exposure until it has expired: an order that can add exposure waits for the next pass`));
        // 3 — the mandate's floor on the account value: stop adding exposure well before the signer refuses
        const floor = D.from(m.limits.floorEquity), budget = D.max(D.zero, D.sub(D.from(this.o.capital), floor)), guard = D.add(floor, D.mul(budget, D.from(FLOOR_GUARD_FRACTION)));
        if (D.lt(D.from(s.state!.equity), guard)) {
          return stop(this.refuse(instrument, 'floor_guard', `account value ${s.state!.equity} is within ${Number(FLOOR_GUARD_FRACTION) * 100} % of the loss budget above the mandate's floor ${m.limits.floorEquity} (guard ${D.str(D.quantize(guard, D.from('0.01'), 'up'))}): no exposure is added; reduce-only orders still pass`));
        }
        // 4 — the venue's leverage setting, once
        const lev = await this.ensureLeverage(s, instrument, leverage);
        if (lev) return stop(lev);
      }
      // 5 — the mandate bounds every order by its notional, closes included: cut, never refuse a close for its size
      const cap = D.mul(D.from(m.limits.maxOrderNotional), D.from(ORDER_CAP_HEADROOM)), price = D.from(req.price);
      if (D.gt(D.mul(D.from(size), price), cap)) {
        const inst = await this.svc.deps.venues.get(s.network).instrument(instrument);
        const fit = D.quantize(D.div(cap, price, 18, 'down'), D.from(inst.lotSize), 'down');
        if (!D.isPos(fit)) return stop(this.refuse(instrument, 'order_notional_exceeded', `the mandate's notional per order (${m.limits.maxOrderNotional}) is below one lot of ${instrument}`));
        size = D.str(fit);
      }
      return { proceed: true, size };
    } catch (e) {
      this.dirty = true;
      if (!(e instanceof UserError)) throw new Error(`live order ${req.clientId} could not be attempted: ${msg(e)}`);
      return stop(this.refused(instrument, e));
    }
  }

  /** V11.2 — the unified order service handed the order to the venue engine (or refused it): this executor's view of the
   *  account follows — what is unconfirmed, what was refused, and whether the refusal means the mandate is over. */
  async observe(req: Pick<OrderRequest, 'instrument' | 'clientId' | 'size' | 'side' | 'type' | 'price' | 'triggerPrice' | 'reduceOnly' | 'tif'>, outcome: { state: string; rejectCode: string | null; detail: string | null }): Promise<void> {
    this.dirty = true; this.stats.orders += 1;
    const o = await mandateOrder(this.o.accountId, req.clientId, this.svc).catch(() => null);
    if (o) { this.result(req as OrderRequest, req.size, o, true); if (outcome.rejectCode && LIVE_EXIT_CODES.has(outcome.rejectCode)) this.exit ??= { code: outcome.rejectCode, reason: outcome.detail ?? outcome.rejectCode }; return; }
    if ((outcome.state === 'REJECTED' || outcome.state === 'FAILED') && outcome.rejectCode) this.refuse(req.instrument, outcome.rejectCode, outcome.detail ?? outcome.rejectCode);
  }

  async place(req: OrderRequest, leverage: DecStr): Promise<PlaceResult> {
    const ctx = { strategySha256: this.o.strategySha256, agentId: this.o.agentId, clientId: req.clientId }, instrument = req.instrument;
    if (req.price === null) return this.refuse(instrument, 'bad_request', 'a live order names its worst acceptable price');
    if (!this.reconciled) await this.reconcilePending();
    // 0 — this key already has an order: its state on the venue is the answer, whatever is asked now (never a second order)
    const prior = await mandateOrder(this.o.accountId, req.clientId, this.svc);
    if (prior) { this.dirty = true; return this.result(req, req.size, prior, true); }
    const p = await this.prepare(req, leverage);
    if (!p.proceed) return p.result;
    try {
      this.stats.orders += 1; this.dirty = true;
      const r = await placeMandateOrder(this.o.accountId, { ...req, size: p.size }, ctx, this.svc);
      return this.result(req, req.size, r.order, r.idempotent);
    } catch (e) {
      this.dirty = true;
      if (!(e instanceof UserError)) throw new Error(`live order ${req.clientId} could not be attempted: ${msg(e)}`);
      return this.refused(instrument, e);
    }
  }
}

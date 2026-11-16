// Market-making engine: one instrument, one venue account, one quoting session. NOT registered in main.ts and bound to nothing:
// every dependency is a port (ports.ts). No timer inside — `tick()` is called by whoever owns the cadence (the stream runtime at
// the integration step, the simulator in tests), so a run is deterministic.
//
// A cycle (`tick`):  data → kill switch / mandate → reconcile (when due or needed) → dead man's switch heartbeat → breakers →
//                    policy → planner (inside the rate budget) → cancels → reductions → risk → quotes.
//
// Rules the engine never breaks (tests: services/api/test/mm-engine.test.ts):
//   - the venue is the truth: open orders, position and fills come from it; local state is a belief corrected at each reconcile;
//   - an action whose outcome is UNKNOWN is never resent: its orders keep their slot, their side takes no new quote, and a
//     reconcile by client id settles each one before anything else happens on that side;
//   - no quote without an armed dead man's switch that outlives the batch; the heartbeat renews it; when it cannot be renewed
//     the quotes are pulled while the old deadline still protects them;
//   - start-up: cancel-all → reconcile → arm → quote. A restart assumes orders may rest. Shutdown: cancel-all → reconcile →
//     disarm (only when nothing rests);
//   - kill switch, a mandate that is not `active`, a tripped breaker: quotes are pulled at once; reductions stay possible.
import { D, type DecStr } from '@spw/derivatives';
import {
  breakersInit, cycleBudget, markoutAddFill, markoutInit, markoutOnMid, markouts10s, markoutSummary, midOf, planQuotes, pnlInit, pnlOnFill, pnlOnMid, pnlReport, stepBreakers, volBps, volInit, volUpdate,
  type BreakerCode, type BreakerConfig, type BreakerState, type MarkoutState, type MarkoutSummary, type PlanMode, type PlannerConfig, type PnlReport, type PnlState, type QuotePolicy, type QuoteRounder, type RateConfig, type RestingOrder,
  type Side, type VolConfig, type VolState,
} from '@spw/trading/mm';
import type { BatchOutcome, ClockPort, JournalPort, MandatePort, MandateView, MarketDataPort, OrderPort, QuoteOrder, RiskPort } from './ports.ts';

export interface MmEngineConfig {
  instrument: string;
  /** 16 hex characters, unique per session: the first half of every client order id (the second half is a counter) */
  sessionId: string;
  planner: PlannerConfig; breakers: BreakerConfig; rate: RateConfig; vol: VolConfig;
  /** a slow volatility baseline for the spike breaker: the same estimator with this decay */
  baselineLambda: number;
  /** reconcile at least this often, and at once after anything of unknown outcome */
  reconcileEveryMs: number;
  /** re-read the venue's address rate limit this often */
  rateEveryMs: number;
  /** IP weight left in the current minute — the integration binds it to the adapter's own budget */
  ipWeightRemaining: () => number;
  /** what a breaker in `flatten` mode and the shutdown do with the inventory */
  flattenOnStop: boolean;
  round: QuoteRounder; roundReduce: QuoteRounder;
}
export type EnginePhase = 'idle' | 'starting' | 'quoting' | 'pulled' | 'halted' | 'stopping' | 'stopped';
interface Tracked extends RestingOrder { venueOrderId: string | null; /** when its batch was sent (unix ms) */ sentAt: number; reduce: boolean }
export interface EngineStatus {
  phase: EnginePhase; reason: string | null; position: DecStr; orders: { clientId: string; side: Side; price: DecStr; size: DecStr; state: RestingOrder['state'] }[]; blockedSides: Side[];
  switchDeadline: number | null; activeBreakers: BreakerCode[]; halted: BreakerCode | null; consecutiveRejects: number;
  counters: Record<string, number>; pnl: PnlReport; markouts: MarkoutSummary[];
}

const hex16 = (n: number) => n.toString(16).padStart(16, '0');
/** the scheduled cancel is asked this much inside the mandate's `deadManSeconds` (clock difference between the engine and the signer) */
export const SWITCH_SKEW_MS = 2000;

export class MmEngine {
  private phase: EnginePhase = 'idle';
  private reason: string | null = null;
  private orders = new Map<string, Tracked>();
  private position: DecStr = '0';
  private blocked = new Set<Side>();
  private needReconcile = true;
  private lastReconcileAt = -Infinity;
  private lastFillsAt = 0;
  private switchDeadline: number | null = null;
  private lastHeartbeatAt = -Infinity;
  private vol: VolState = volInit();
  private baseline: VolState = volInit();
  private breakers: BreakerState = breakersInit();
  private active: BreakerCode[] = [];
  private markout: MarkoutState = markoutInit();
  private pnl: PnlState = pnlInit();
  private fillTimes: number[] = [];
  /** the mids this session saw, newest last (five minutes): a fill learnt at a reconcile is attributed at the mid of ITS time */
  private mids: [number, DecStr][] = [];
  private seenFills = new Set<string>();
  private consecutiveRejects = 0;
  private seq = 0;
  private addressRemaining: number | null = null;
  private lastRateAt = -Infinity;
  private lastModeNote = '';
  private counters: Record<string, number> = { ticks: 0, quoteBatches: 0, quotesPlaced: 0, cancels: 0, reduces: 0, fills: 0, heartbeats: 0, reconciles: 0, unknownOutcomes: 0, signerRefusals: 0, riskRefusals: 0, venueRejects: 0, aloRejects: 0, lockRefusals: 0 };
  private busy = false;
  private stopAskedAt: number | null = null;

  constructor(private cfg: MmEngineConfig, private policy: QuotePolicy, private p: { market: MarketDataPort; orders: OrderPort; risk: RiskPort; mandate: MandatePort; clock: ClockPort; journal: JournalPort }) {
    if (!/^[0-9a-f]{16}$/.test(cfg.sessionId)) throw new Error('sessionId must be 16 hex characters');
  }

  private log(type: string, data: Record<string, unknown> = {}): void { this.p.journal.record({ ts: this.p.clock.now(), type, instrument: this.cfg.instrument, ...data }); }
  private nextId(): string { this.seq += 1; return `0x${this.cfg.sessionId}${hex16(this.seq)}`; }
  private count(k: string, n = 1): void { this.counters[k] = (this.counters[k] ?? 0) + n; }

  status(): EngineStatus {
    return { phase: this.phase, reason: this.reason, position: this.position, orders: [...this.orders.values()].filter((o) => !o.reduce).map((o) => ({ clientId: o.clientId, side: o.side, price: o.price, size: o.size, state: o.state })),
      blockedSides: [...this.blocked], switchDeadline: this.switchDeadline, activeBreakers: [...this.active], halted: this.breakers.halted, consecutiveRejects: this.consecutiveRejects, counters: { ...this.counters },
      pnl: pnlReport(this.pnl), markouts: markoutSummary(this.markout) };
  }

  /** begin a session. Nothing is quoted before the start-up sequence of `tick` has cancelled what may rest, reconciled and armed the switch. */
  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'stopped') return;
    this.phase = 'starting'; this.reason = null; this.needReconcile = true;
    this.log('mm.start', { policy: this.policy.id, policyVersion: this.policy.version, sessionId: this.cfg.sessionId });
  }
  /** end the session: pull everything; the following ticks finish the sequence (reconcile to nothing resting, then disarm) */
  stop(why = 'stop requested'): void {
    if (this.phase === 'idle' || this.phase === 'stopped' || this.phase === 'stopping') return;
    this.phase = 'stopping'; this.reason = why; this.needReconcile = true;
    this.log('mm.stopping', { why });
  }
  /** an operator's decision after a halt (drawdown, rejects): the session may quote again */
  resume(): void { if (this.phase !== 'halted') return; this.breakers = breakersInit(); this.consecutiveRejects = 0; this.phase = 'pulled'; this.reason = null; this.log('mm.resumed'); }

  // -----------------------------------------------------------------------------------------------------------------------------
  /** one cycle. Calls overlap never: a tick that arrives while one runs is dropped. */
  async tick(): Promise<void> {
    if (this.busy || this.phase === 'idle' || this.phase === 'stopped') return;
    this.busy = true;
    try { await this.cycle(); } catch (e) { this.needReconcile = true; this.log('mm.cycle_error', { message: String((e as Error).message).slice(0, 200) }); } finally { this.busy = false; }
  }

  private async cycle(): Promise<void> {
    const now = this.p.clock.now(), snap = this.p.market.snapshot(this.cfg.instrument), book = snap.book;
    this.count('ticks');
    const usable = book !== null && D.isPos(D.from(book.bid)) && D.gt(D.from(book.ask), D.from(book.bid));
    if (usable && snap.status === 'connected') {
      const mid = midOf(book), m = Number(mid);
      this.vol = volUpdate(this.vol, m, now, this.cfg.vol);
      this.baseline = volUpdate(this.baseline, m, now, { ...this.cfg.vol, lambda: this.cfg.baselineLambda });
      this.markout = markoutOnMid(this.markout, now, mid);
      this.pnl = pnlOnMid(this.pnl, mid);
      this.mids.push([book.ts, mid]); while (this.mids.length && this.mids[0]![0] < now - 300_000) this.mids.shift();
    }

    // ---- who may quote: the kill switch and the mandate ----
    let kill = true, mandate: MandateView | null = null;
    try { kill = await this.p.risk.killSwitch(); } catch { kill = true; }                         // an unreadable kill switch is a pulled one
    try { mandate = await this.p.mandate.current(); } catch { mandate = null; }

    // ---- reconcile: the venue is the truth ----
    if (this.needReconcile || now - this.lastReconcileAt >= this.cfg.reconcileEveryMs) await this.reconcile(now, book ? midOf(book) : null);

    // ---- start-up sequence: cancel-all → reconcile → arm → quote ----
    if (this.phase === 'starting') {
      if (this.needReconcile) return;                                                             // the venue could not be read: nothing is assumed
      const resting = [...this.orders.values()];
      if (resting.length) { await this.cancelIds(resting.filter((o) => o.state !== 'cancelling').map((o) => o.clientId), 'start-up'); this.needReconcile = true; return; }
      if (!mandate || mandate.phase !== 'active') { this.note(`start-up waits: ${mandate ? `the mandate is in ${mandate.phase}` : 'no quoting mandate'}`); return; }
      if (now - this.lastHeartbeatAt < 5000) return;                                             // a refused or lost arming is retried, not hammered
      if (!(await this.heartbeat(now, mandate, true))) return;
      this.phase = 'quoting'; this.log('mm.quoting');
    }

    // ---- shutdown sequence: cancel-all → reconcile → (flatten) → disarm ----
    if (this.phase === 'stopping') {
      if (this.needReconcile) return;
      const live = [...this.orders.values()].filter((o) => !o.reduce);
      if (live.length) { await this.cancelIds(live.filter((o) => o.state === 'resting').map((o) => o.clientId), 'shutdown'); this.needReconcile = true; return; }
      if (this.cfg.flattenOnStop && !D.isZero(D.from(this.position)) && usable) { await this.plan(now, book!, 'flatten', mandate); if (!D.isZero(D.from(this.position))) { this.needReconcile = true; return; } }
      if (this.orders.size === 0) {
        // removing the switch: the signer agrees only once nothing rests and nothing it signed can still land — a quote signed
        // seconds ago may make it wait. It is asked again for a while; if it never agrees the switch fires by itself on nothing.
        if (this.stopAskedAt === null) this.stopAskedAt = now;
        const r = await this.p.orders.scheduleCancel(null);
        if (r.kind === 'done') this.switchDeadline = null;
        else if (now - this.stopAskedAt < 30_000 && (this.switchDeadline === null || now < this.switchDeadline)) return;
        this.log('mm.stopped', { disarmed: r.kind === 'done', note: r.kind === 'done' ? null : `${r.kind}: the switch will fire by itself with nothing resting` });
        this.phase = 'stopped'; this.stopAskedAt = null;
      }
      return;
    }

    // ---- dead man's switch heartbeat: while anything of ours can rest ----
    const wantsQuotes = this.phase === 'quoting' || this.phase === 'pulled';
    let switchOk = this.switchDeadline !== null && this.switchDeadline - now > this.p.orders.actionTtlMs + 3000;
    if (mandate && (wantsQuotes || this.orders.size > 0) && now - this.lastHeartbeatAt >= (mandate.deadManSeconds * 1000) / 3) switchOk = (await this.heartbeat(now, mandate, false)) || switchOk;

    // ---- breakers ----
    const v = stepBreakers(this.breakers, { nowMs: now, venueStatus: snap.status, bookTs: book?.ts ?? null, bid: book?.bid ?? null, bidSize: book?.bidSize ?? null, ask: book?.ask ?? null, askSize: book?.askSize ?? null,
      volBps: volBps(this.vol, this.cfg.vol), baselineVolBps: volBps(this.baseline, { ...this.cfg.vol, lambda: this.cfg.baselineLambda }), fillTimes: this.fillTimes, markouts10s: markouts10s(this.markout),
      consecutiveRejects: this.consecutiveRejects, sessionPnlUsd: pnlReport(this.pnl).totalUsd, dayPnlUsd: pnlReport(this.pnl).totalUsd, killSwitch: kill }, this.cfg.breakers);
    for (const c of v.tripped) if (!this.active.includes(c)) this.log('mm.breaker', { code: c, action: v.flatten ? 'flatten' : v.halted === c ? 'halt' : 'pull' });
    this.breakers = v.state; this.active = v.active;
    if (v.halted && this.phase !== 'halted') { this.phase = 'halted'; this.reason = v.halted; this.log('mm.halted', { code: v.halted }); }

    // ---- mode of this cycle ----
    let mode: PlanMode = 'quote', why = '';
    if (!mandate) { mode = 'pull'; why = 'no quoting mandate'; }
    else if (mandate.phase !== 'active') { mode = 'pull'; why = `mandate ${mandate.phase}: wind-down`; }
    else if (v.pull) { mode = v.flatten ? 'flatten' : 'pull'; why = `breaker ${v.active.join(', ')}`; }
    else if (!switchOk) { mode = 'pull'; why = 'the dead man\'s switch could not be renewed'; }
    else if (this.phase === 'halted') { mode = 'pull'; why = `halted: ${this.reason}`; }
    if (this.phase !== 'halted') this.phase = mode === 'quote' ? 'quoting' : 'pulled';
    this.note(mode === 'quote' ? '' : why);
    if (!usable) { if (this.orders.size) await this.cancelIds([...this.orders.values()].filter((o) => o.state === 'resting').map((o) => o.clientId), 'no usable book'); return; }
    await this.plan(now, book!, mode, mandate);
  }
  /** journal a change of the reason quotes are pulled, once per change */
  private note(why: string): void { if (why !== this.lastModeNote) { this.lastModeNote = why; this.reason = why || null; this.log(why ? 'mm.pulled' : 'mm.quoting_again', why ? { why } : {}); } }

  // -----------------------------------------------------------------------------------------------------------------------------
  private async heartbeat(now: number, mandate: MandateView, required: boolean): Promise<boolean> {
    // a little inside the mandate's maximum: the signer's clock and this one are not the same clock
    const deadline = now + mandate.deadManSeconds * 1000 - SWITCH_SKEW_MS;
    const r = await this.p.orders.scheduleCancel(deadline);
    this.lastHeartbeatAt = now; this.count('heartbeats');
    if (r.kind === 'done') { this.switchDeadline = deadline; return true; }
    this.log('mm.switch_failed', { kind: r.kind, ...(r.kind === 'refused' ? { stage: r.stage, code: r.code } : {}), required });
    // unknown: the venue may or may not have taken the new deadline; the OLD one is the only one counted on
    return false;
  }

  /** open orders, position and fills from the venue; every order of unknown state is settled by its client id */
  private async reconcile(now: number, mid: DecStr | null): Promise<void> {
    const inst = this.cfg.instrument;
    try {
      const [open, account, fills] = [await this.p.orders.openOrders(inst), await this.p.orders.account(inst), await this.p.orders.fills(inst, this.lastFillsAt)];
      this.count('reconciles');
      const listed = new Map(open.filter((o) => o.clientId !== null).map((o) => [o.clientId!, o]));
      for (const o of [...this.orders.values()]) {
        const v = listed.get(o.clientId);
        if (v) { if (o.state !== 'cancelling') o.state = 'resting'; o.size = v.size; o.venueOrderId = v.venueOrderId; continue; }
        if (o.state === 'resting' || o.state === 'cancelling') { this.orders.delete(o.clientId); continue; }   // it was there and is gone: filled or cancelled — the fills and the position say which
        // pending / unknown and not listed: ask the venue about this very order
        const s = await this.p.orders.lookup(inst, o.clientId);
        if (s === 'open') { o.state = 'resting'; continue; }                                       // listed a moment later
        if (s === 'filled' || s === 'cancelled' || s === 'rejected') { this.orders.delete(o.clientId); this.log('mm.reconciled_order', { clientId: o.clientId, was: o.state, venue: s }); continue; }
        // the venue does not know it: final only once the signed action can no longer be accepted
        if (now > o.sentAt + this.p.orders.actionTtlMs + 5000) { this.orders.delete(o.clientId); this.log('mm.reconciled_order', { clientId: o.clientId, was: o.state, venue: 'never_placed' }); }
      }
      // orders on the venue that this session does not know (left by a crash, or foreign): adopted, so that the planner cancels them
      for (const v of open) if (v.clientId !== null && !this.orders.has(v.clientId) && !v.reduceOnly) {
        this.orders.set(v.clientId, { clientId: v.clientId, side: v.side, price: v.price, size: v.size, state: 'resting', placedAt: v.timestamp, venueOrderId: v.venueOrderId, sentAt: v.timestamp, reduce: false });
        this.log('mm.adopted_order', { clientId: v.clientId, side: v.side, price: v.price, size: v.size });
      }
      const anonymous = open.filter((o) => o.clientId === null && !o.reduceOnly).length;
      if (anonymous) this.log('mm.foreign_orders', { count: anonymous, note: 'orders without a client id rest on the account: not managed by this session' });
      for (const f of fills) {
        if (this.seenFills.has(f.id)) continue;
        this.seenFills.add(f.id); this.lastFillsAt = Math.max(this.lastFillsAt, f.ts); this.count('fills'); this.fillTimes = [...this.fillTimes.filter((t) => t > now - 600_000), f.ts];
        // the last mid seen at or before the fill (the cadence of the ticks bounds the error); none → the current one
        let at = mid ?? f.price; for (let k = this.mids.length - 1; k >= 0; k--) if (this.mids[k]![0] <= f.ts) { at = this.mids[k]![1]; break; }
        this.pnl = pnlOnFill(this.pnl, { side: f.side, price: f.price, size: f.size, fee: f.fee, mid: at });
        if (f.maker) this.markout = markoutAddFill(this.markout, { id: f.id, ts: f.ts, side: f.side, price: f.price, size: f.size });
        this.log('mm.fill', { id: f.id, clientId: f.clientId, side: f.side, price: f.price, size: f.size, fee: f.fee, maker: f.maker });
      }
      if (this.position !== account.position) this.log('mm.position', { from: this.position, to: account.position });
      this.position = account.position;
      // a side is unblocked only when nothing of unknown state is left on it
      for (const s of [...this.blocked]) if (![...this.orders.values()].some((o) => o.side === s && (o.state === 'unknown' || o.state === 'pending'))) { this.blocked.delete(s); this.log('mm.side_unblocked', { side: s }); }
      this.needReconcile = [...this.orders.values()].some((o) => o.state === 'unknown' || o.state === 'pending' || o.state === 'cancelling');
      this.lastReconcileAt = now;
    } catch (e) {
      this.needReconcile = true;
      this.log('mm.reconcile_failed', { message: String((e as Error).message).slice(0, 160) });
    }
  }

  private async cancelIds(ids: string[], why: string): Promise<boolean> {
    if (!ids.length) return true;
    for (const id of ids) { const o = this.orders.get(id); if (o) o.state = 'cancelling'; }
    const r = await this.p.orders.cancel(this.cfg.instrument, ids);
    this.count('cancels', ids.length);
    if (r.kind === 'done') {
      for (const x of r.results) this.orders.delete(x.clientId);
      if (r.results.some((x) => x.outcome === 'gone')) this.needReconcile = true;                  // gone before the cancel: it may have filled
      return true;
    }
    this.needReconcile = true;
    if (r.kind === 'refused') { for (const id of ids) { const o = this.orders.get(id); if (o) o.state = 'resting'; } }   // certain: nothing was cancelled
    this.log('mm.cancel_failed', { why, kind: r.kind, ...(r.kind === 'refused' ? { stage: r.stage, code: r.code } : {}), count: ids.length });
    return false;
  }

  private async plan(now: number, book: NonNullable<ReturnType<MarketDataPort['snapshot']>['book']>, mode: PlanMode, mandate: MandateView | null): Promise<void> {
    const inst = this.cfg.instrument;
    // rate budget: the venue's address limit (re-read at a slow cadence), the IP weight, the signer's own counters
    if (now - this.lastRateAt >= this.cfg.rateEveryMs) { this.lastRateAt = now; try { this.addressRemaining = await this.p.orders.addressRequestsRemaining(); } catch { this.addressRemaining = null; } }
    const budget = cycleBudget({ addressRemaining: this.addressRemaining, ipWeightRemaining: this.cfg.ipWeightRemaining(), signerActions: mandate?.bucketActions ?? 0, signerOrdersHour: mandate?.quotesLeftHour ?? 0, signerOrdersDay: mandate?.quotesLeftDay ?? 0 }, this.cfg.rate);
    let desired = mode === 'quote' ? this.policy.quotes({ nowMs: now, book, inventory: this.position, volBps: volBps(this.vol, this.cfg.vol) }).quotes : [];
    if (budget.maxLevels !== null) desired = desired.filter((q) => q.level < budget.maxLevels!);
    const plan = planQuotes(this.cfg.planner, { book, position: this.position, desired, resting: [...this.orders.values()].filter((o) => !o.reduce), budget, mode, blockedSides: [...this.blocked], toleranceMultiplier: budget.toleranceMultiplier,
      round: this.cfg.round, roundReduce: this.cfg.roundReduce });
    if (plan.degraded || (budget.reason && mode === 'quote')) this.log('mm.degraded', { reason: budget.reason, notes: plan.notes.slice(0, 4) });

    // 1. cancels first
    const cancelled = await this.cancelIds(plan.cancel, mode === 'quote' ? 'requote' : 'pull');

    // 2. reductions (allowed in every mode: they only reduce)
    if (plan.reduce.length && [...this.orders.values()].some((o) => o.reduce)) this.log('mm.reduce_waits', { why: 'a reduction of unknown outcome is being reconciled' });
    else if (plan.reduce.length) {
      const orders: QuoteOrder[] = plan.reduce.map((r) => ({ clientId: this.nextId(), side: r.side, price: r.price, size: r.size }));
      const risk = await this.riskOf('reduce', orders);
      if (risk) {
        for (const o of orders) this.orders.set(o.clientId, { ...o, state: 'pending', placedAt: now, venueOrderId: null, sentAt: now, reduce: true });
        this.log('mm.reduce', { orders });
        const r = await this.p.orders.submitReduces(inst, orders);
        this.count('reduces', orders.length);
        this.settle(r, orders, true);
        this.needReconcile = true;                                                                // a reduction changes the position: read it back
      }
    }

    // 3. quotes: only in quote mode, only when every cancel of the plan was confirmed, only if the pre-trade risk check allows
    if (mode !== 'quote' || !plan.place.length) return;
    if (!cancelled) { this.log('mm.place_skipped', { why: 'a cancel of this cycle was not confirmed' }); return; }
    const quotes: QuoteOrder[] = plan.place.map((q) => ({ clientId: this.nextId(), side: q.side, price: q.price, size: q.size }));
    if (!(await this.riskOf('quotes', quotes))) return;
    // the intent is recorded and the orders tracked BEFORE anything is sent: a crash from here on finds them by client id
    for (const o of quotes) this.orders.set(o.clientId, { ...o, state: 'pending', placedAt: now, venueOrderId: null, sentAt: now, reduce: false });
    this.log('mm.quote', { quotes });
    const r = await this.p.orders.submitQuotes(inst, quotes);
    this.count('quoteBatches');
    this.settle(r, quotes, false);
  }

  private async riskOf(kind: 'quotes' | 'reduce', orders: QuoteOrder[]): Promise<boolean> {
    let d: Awaited<ReturnType<RiskPort['evaluate']>>;
    try { d = await this.p.risk.evaluate({ instrument: this.cfg.instrument, kind, orders, position: this.position }); } catch (e) { d = { allow: false, code: 'risk_unavailable', message: String((e as Error).message).slice(0, 120) }; }
    if (d.allow) return true;
    this.count('riskRefusals'); this.log('mm.risk_refused', { kind, code: d.code, message: d.message });
    if (kind === 'quotes') this.consecutiveRejects += 1;
    return false;
  }

  /** what a batch did, order by order — or that nothing exists — or that it is not known */
  private settle(r: BatchOutcome, sent: QuoteOrder[], reduce: boolean): void {
    if (r.kind === 'done') {
      let ok = 0;
      for (const x of r.results) {
        const o = this.orders.get(x.clientId);
        if (!o) continue;
        if (x.outcome === 'resting') { o.state = 'resting'; o.venueOrderId = x.venueOrderId; ok += 1; }
        else if (x.outcome === 'filled') { this.orders.delete(x.clientId); this.needReconcile = true; ok += 1; }
        else {
          this.orders.delete(x.clientId);
          if (x.code === 'post_only_would_cross') this.count('aloRejects'); else { this.count('venueRejects'); if (!reduce) this.consecutiveRejects += 1; }
          this.log('mm.order_rejected', { clientId: x.clientId, code: x.code, reason: x.reason.slice(0, 160) });
        }
      }
      for (const o of sent) if (!r.results.some((x) => x.clientId === o.clientId)) { const t = this.orders.get(o.clientId); if (t) { t.state = 'unknown'; this.blocked.add(t.side); this.needReconcile = true; } }   // an answer that does not cover an order says nothing about it
      if (!reduce) { this.count('quotesPlaced', ok); if (ok) this.consecutiveRejects = 0; }
      if (reduce) for (const o of sent) this.orders.delete(o.clientId);                             // an IOC never rests
      return;
    }
    if (r.kind === 'refused') {
      for (const o of sent) this.orders.delete(o.clientId);                                        // certain: nothing of it exists
      this.count(r.stage === 'signer' ? 'signerRefusals' : r.stage === 'lock' ? 'lockRefusals' : 'venueRejects');
      if (!reduce) this.consecutiveRejects += 1;
      this.log('mm.batch_refused', { stage: r.stage, code: r.code, message: r.message.slice(0, 200), reduce });
      return;
    }
    // unknown: never a blind resend
    this.count('unknownOutcomes'); this.needReconcile = true;
    for (const o of sent) { const t = this.orders.get(o.clientId); if (t) { t.state = 'unknown'; if (!reduce) this.blocked.add(t.side); } }
    this.log('mm.outcome_unknown', { message: r.message.slice(0, 160), clientIds: sent.map((o) => o.clientId), reduce });
  }
}

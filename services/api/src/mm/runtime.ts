// The market-making runtime: quoting sessions of the agents of family `market_making`, PAPER and LIVE, driven by the agents
// runtime. The stream engine calls `tick(agent)` once per pass (every second) for each market-making agent whose LEASE this
// worker holds — so exactly one worker quotes an agent — and `MmEngine.tick()` does the rest (services/api/src/mm/engine.ts).
//
//   paper   the engine over `PaperVenue` (real books, the runtime's conservative fill model), no signer, no mandate
//   live    the engine over the live adapter (the signer's QUOTING path only — never a per-order passkey, never the manual or
//           the directional path), reconciled from the venue's user streams, inside the IP-weight and address budgets,
//           under a quoting mandate the owner approved; Hyperliquid, pinned instruments
//
// A session lives in THIS process's memory; what the owner sees is what it writes: mm_sessions (status, counters, attribution),
// mm_fills, the unwinds as unified orders, the agent journal, audit events for the alerts. A worker that dies leaves, on live,
// the venue's dead man's switch to cancel what rests; the worker that takes the lease next builds a NEW session, whose engine
// starts with cancel-all → reconcile → arm → quote (it assumes orders may rest).
//
// What ends a session: the agent is paused or stopped; the schedule (outside the hours; the maximum duration — the agent is then
// paused); the mandate is no longer usable or is `stopBeforeExpiryS` from its expiry (the agent is stopped); on paper, the
// agent's loss limit. A halt (drawdown, consecutive rejects) does NOT end a live session: quotes are pulled and it waits for
// the owner (resume, flatten or stop).
import { D, hlRoundAsk, hlRoundBid, hlRoundQuote, hlRoundSize, type DecStr, type HlNetwork, type Instrument } from '@spw/derivatives';
import type { CanonicalOrderInput, FeeSchedule, QuotingSection } from '@spw/trading';
import { DEFAULT_BREAKER_ACTION, VOL_STUDY_DEFAULTS, type BreakerConfig, type QuotePolicy, type QuoteRounder } from '@spw/trading/mm';
import { audit, sql } from '../db.ts';
import { quotePolicyOf } from '../agent-runtime/families.ts';
import { inputsDigest, journal, REASON_CODES } from '../agent-runtime/journal.ts';
import { configHash, ruleHash } from '../agent-runtime/model.ts';
import { MmBudget } from './budget.ts';
import { MmEngine, type EngineStatus, type MmEngineConfig } from './engine.ts';
import { createLiveMmAdapter, mmOpeningLock, type HlVenuePort, type MmLocks, type QuotingSignerPort } from './live-adapter.ts';
import { marketDataPort, type BookSource } from './market-data.ts';
import { newPaperState, PaperVenue, type PaperVenueState } from './paper-venue.ts';
import type { JournalEvent, MandateView, OrderPort, OrderResult, QuoteOrder, RiskDecision, VenueStatus } from './ports.ts';
import { ackCommand, closeSession, dayPnlBefore, openSession, pruneTape, recordFill, recordTape, recordUnwind, saveSession, settleMarkouts, settleUnwind, type MmMode, type SessionCommand, type SessionRow } from './sessions.ts';
import { streamReconciled, type StreamReconciledPort, type UserFeed } from './user-stream.ts';

export interface MmAgentRow { id: string; name: string; state: string; mode: string; universe: string[]; risk: { maxPositionUsd: number; maxGrossUsd: number; maxDailyLossPct: number; maxTotalLossPct: number; maxDataAgeMs: number }; capital_usdc: string; config_version: number;
  runtime: { venues: string[]; rule: string; config: Record<string, unknown>; mm?: { paper?: PaperVenueState; live?: { mandateId: string; activatedAt: number } } } }
/** the signer's own record of a quoting mandate, as `GET /status` gives it */
export interface SignerQuotingView { mandate: { mandateId: string; expiresAt: number; deadManSeconds: number; rate: { ordersPerHour: number; ordersPerDay: number } }; phase: 'active' | 'wind_down' | 'ended'; today: { quotes: number; lapses: number }; quotesThisHour: number; bucketActions: number; deadMan: { armed: boolean; deadline: number | null } }
/** the quoting mandate of an agent as the mandate service holds it */
export interface QuotingMandateInfo { mandateId: string; accountId: string; account: string; network: HlNetwork; section: QuotingSection; usable: boolean; why: string | null; phase: string; expiresAtMs: number; maxDailyLossUsd: DecStr; maxPositionNotionalUsd: DecStr }
export interface MmLiveDeps {
  signer: QuotingSignerPort & { status(fresh?: boolean): Promise<{ halted: boolean; venueQuotingMandates?: SignerQuotingView[] }> };
  /** the venue's REST endpoints of a network (the process's Hyperliquid HTTP client), and the weight that client spent in the last minute */
  venue(network: HlNetwork): HlVenuePort & { processUsed?: () => number };
  userFeed(network: HlNetwork): UserFeed;
  mandate(agentId: string): Promise<QuotingMandateInfo | null>;
  /** stop: the mandate is revoked at the signer first */
  revoke(mandateId: string, detail: string): Promise<void>;
  /** the unified risk service, for ONE worst-case order of a plan */
  evaluate(order: CanonicalOrderInput, accountId: string): Promise<RiskDecision>;
  /** the live engine's own background reconcile of that venue account is paced while a session runs (it costs IP weight) */
  setStepPacing?(accountId: string, everyMs: number | null): void;
}
export interface MmRuntimeDeps {
  now: () => number; worker: string; locks: () => MmLocks;
  /** top of book of an instrument on a network (see market-data.ts: the quote hub will replace the source) */
  books(network: HlNetwork): BookSource;
  resolve(venue: string, base: string): Promise<Instrument | null>;
  fees(venue: string): FeeSchedule | null;
  /** true = the kill switch or the read-only mode is engaged */
  killSwitch(): Promise<boolean>;
  live?: MmLiveDeps;
  /** how often the session row is refreshed, the tape written and the slow jobs run (tests shorten them) */
  saveEveryMs?: number; slowEveryMs?: number; reconcileEveryMs?: number; auditEveryMs?: number;
}
interface Session {
  row: SessionRow; mode: MmMode; agentId: string; instrument: string; inst: Instrument; network: HlNetwork; engine: MmEngine; cfg: MmEngineConfig; policy: QuotePolicy; port: OrderPort; paper: PaperVenue | null; stream: StreamReconciledPort | null;
  budget: MmBudget; mandate: QuotingMandateInfo | null; queue: JournalEvent[]; refusals: Record<string, number>; breakers: SessionRow['breakers']; unwinds: Map<string, { order: QuoteOrder; why: string }>;
  startedAt: number; lastSaveAt: number; lastSlowAt: number; lastTapeAt: number; lastMandateAt: number; lastNote: Record<string, number>; dayBefore: DecStr; priorTotal: DecStr; capital: number; ending: string | null; endState: 'STOPPED' | 'PAUSED' | null;
  lapses: number; fundedAt: number | null; view: MandateView | null; lockCode: string | null; cleanup: boolean; paperSeq: number; riskCache: Map<string, { at: number; d: RiskDecision }>;
}

const dec = (n: number, dp = 10): string => { const t = n.toFixed(dp); return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t; };
const decimalsOf = (step: string): number => (step.includes('.') ? step.split('.')[1]!.replace(/0+$/, '').length : 0);
/** onto the venue's grid: a bid down, an ask up, a size down; Hyperliquid by its own rule (5 significant figures), another venue by its tick and lot */
export function roundersFor(inst: Instrument): { round: QuoteRounder; roundReduce: QuoteRounder } {
  if (inst.venue === 'hyperliquid') {
    const sz = decimalsOf(inst.lotSize);
    return { round: (side, price, size) => { const r = hlRoundQuote(side, price, size, sz); return r.ok ? { ok: true, price: r.quote.price, size: r.quote.size } : { ok: false, reason: r.reason }; },
      roundReduce: (side, price, size) => { const p = side === 'sell' ? hlRoundBid(price, sz) : hlRoundAsk(price, sz), s = hlRoundSize(size, sz); return p && s ? { ok: true, price: p, size: s } : { ok: false, reason: 'rounds to nothing' }; } };
  }
  const tick = D.from(inst.tickSize), lot = D.from(inst.lotSize), min = D.from(inst.minNotional ?? '0');
  const grid = (x: DecStr, step: typeof tick, dir: 'down' | 'up'): DecStr => (D.isPos(step) ? D.str(D.mul(D.div(D.from(x), step, 0, dir), step)) : x);
  const mk = (towards: boolean): QuoteRounder => (side, price, size) => {
    const p = grid(price, tick, (side === 'buy') !== towards ? 'down' : 'up'), s = grid(size, lot, 'down');
    if (!D.isPos(D.from(p)) || !D.isPos(D.from(s))) return { ok: false, reason: 'rounds to nothing' };
    if (!towards && D.lt(D.mul(D.from(p), D.from(s)), min)) return { ok: false, reason: 'min_notional' };
    return { ok: true, price: p, size: s };
  };
  return { round: mk(false), roundReduce: mk(true) };
}
/** how far inside the mandate's quote band the engine keeps its own quotes (bps): the signer measures the band from ITS mid (spot, two exchanges), the engine prices from the venue's book */
export const BAND_MARGIN_BPS = '0.5';
/**
 * A LIVE policy never asks for a quote the signer would refuse for its distance from the mid: whatever the rule computes (a skew
 * can bring one side closer than the rule's own minimum), a bid is at most mid × (1 − floor) and at least mid × (1 − ceiling),
 * an ask the mirror — floor = the mandate's `minHalfSpreadBps` + the margin, ceiling = its `maxDistanceBps` − the margin. It can
 * only move a quote AWAY from the mid or back inside the band; the signer still judges every quote against its own mid.
 */
export function withinBand(policy: QuotePolicy, minHalfSpreadBps: number, maxDistanceBps: number): QuotePolicy {
  const B = D.from(10000n), floor = D.add(D.from(String(minHalfSpreadBps)), D.from(BAND_MARGIN_BPS)), ceil = D.sub(D.from(String(maxDistanceBps)), D.from(BAND_MARGIN_BPS));
  return { id: policy.id, version: policy.version, quotes(input) {
    const out = policy.quotes(input), mid = D.div(D.add(D.from(input.book.bid), D.from(input.book.ask)), D.from(2n), 12, 'half_even'), notes = [...out.notes];
    const at = (bps: typeof floor, sign: 1 | -1): string => D.str(D.div(D.mul(mid, sign === 1 ? D.add(B, bps) : D.sub(B, bps)), B, 12, sign === 1 ? 'up' : 'down'));
    const quotes = out.quotes.map((q) => {
      const p = D.from(q.price), near = D.from(at(floor, q.side === 'buy' ? -1 : 1)), far = D.from(at(ceil, q.side === 'buy' ? -1 : 1));
      if (q.side === 'buy' ? D.gt(p, near) : D.lt(p, near)) { notes.push(`${q.side} moved to the mandate's minimum distance from the mid`); return { ...q, price: D.str(near) }; }
      if (q.side === 'buy' ? D.lt(p, far) : D.gt(p, far)) { notes.push(`${q.side} moved back inside the mandate's maximum distance`); return { ...q, price: D.str(far) }; }
      return q;
    });
    return { ...out, quotes, notes };
  } };
}
/** is `now` inside the session's hours? [start, end) in minutes of the UTC day; start > end wraps midnight; null = any time */
export function inSessionHours(hours: QuotingSection['engine']['hours'], now: number): boolean {
  if (!hours) return true;
  const m = Math.floor((now % 86_400_000) / 60_000), { startUtcMinute: a, endUtcMinute: b } = hours;
  return a < b ? m >= a && m < b : m >= a || m < b;
}
export const PAPER_BREAKERS: BreakerConfig = { maxDataAgeMs: 5000, maxSpreadBps: '50', minTopDepthUsd: '0', volSpikeMultiple: 8, maxVolBps: 60, fillBurstCount: 8, fillBurstWindowMs: 10_000, minMarkoutBps: '-15', markoutSample: 12, consecutiveRejects: 8,
  maxSessionLossUsd: '-1000000', maxDayLossUsd: '-1000000', coolDownMs: 15_000, action: {} };
/** journal events that are counted, not written (one per quote would drown the journal) */
const SILENT = new Set(['mm.quote', 'mm.place_skipped', 'mm.position', 'mm.side_unblocked', 'mm.reduce_waits']);
const TITLES: Record<string, [kind: 'state' | 'risk' | 'fill' | 'error' | 'order' | 'hold' | 'stop', severity: 'info' | 'warning' | 'error', title: string]> = {
  'mm.start': ['state', 'info', 'Quoting session started'], 'mm.quoting': ['state', 'info', 'Dead man\'s switch armed: quoting'], 'mm.started_without_quoting': ['state', 'warning', 'Session started to pull and reduce only'],
  'mm.pulled': ['hold', 'warning', 'Quotes pulled'], 'mm.quoting_again': ['state', 'info', 'Quoting again'], 'mm.stopping': ['stop', 'info', 'Session stopping: quotes cancelled'], 'mm.stopped': ['stop', 'info', 'Session stopped'],
  'mm.breaker': ['risk', 'warning', 'Circuit breaker tripped'], 'mm.halted': ['risk', 'error', 'Session halted: waiting for the owner'], 'mm.resumed': ['state', 'info', 'Session resumed'], 'mm.manual': ['state', 'warning', 'Owner instruction'],
  'mm.hold': ['hold', 'warning', 'Quoting on hold'], 'mm.hold_cleared': ['state', 'info', 'Hold cleared'], 'mm.flat': ['state', 'info', 'Inventory flat'],
  'mm.fill': ['fill', 'info', 'Fill'], 'mm.funding': ['fill', 'info', 'Funding settlement'], 'mm.reduce': ['order', 'warning', 'Reduce-only unwind'], 'mm.batch_refused': ['risk', 'warning', 'Batch refused'], 'mm.risk_refused': ['risk', 'warning', 'Refused by the risk engine'],
  'mm.switch_failed': ['error', 'warning', 'Dead man\'s switch not renewed'], 'mm.outcome_unknown': ['error', 'warning', 'Outcome of a batch unknown: reconciling, nothing is resent'], 'mm.reconcile_failed': ['error', 'warning', 'Reconcile failed'],
  'mm.reconciled_order': ['order', 'info', 'Order settled by reconcile'], 'mm.cancel_failed': ['error', 'warning', 'Cancel not confirmed'], 'mm.adopted_order': ['order', 'warning', 'Resting order adopted (left by a previous session)'],
  'mm.foreign_orders': ['risk', 'warning', 'Foreign orders rest on the account'], 'mm.cycle_error': ['error', 'error', 'Engine cycle error'], 'mm.degraded': ['risk', 'warning', 'Rate budget: quoting reduced'], 'mm.order_rejected': ['risk', 'info', 'Order rejected by the venue'],
  'mm.stream_divergence': ['error', 'warning', 'User stream differed from the venue\'s REST state: REST wins'],
};

export class MmRuntime {
  private readonly sessions = new Map<string, Session>();
  constructor(readonly deps: MmRuntimeDeps) {}

  has(agentId: string): boolean { return this.sessions.has(agentId); }
  status(agentId: string): EngineStatus | null { return this.sessions.get(agentId)?.engine.status() ?? null; }
  budgetOf(agentId: string): ReturnType<MmBudget['report']> | null { return this.sessions.get(agentId)?.budget.report() ?? null; }
  /** the lease of this agent went to another worker: forget the session WITHOUT acting (the other worker starts with cancel-all → reconcile) */
  forget(agentId: string): void { const s = this.sessions.get(agentId); if (!s) return; s.stream?.close(); if (s.mandate) this.deps.live?.setStepPacing?.(s.mandate.accountId, null); this.sessions.delete(agentId); }
  /** process shutdown: nothing is sent — on live the dead man's switch covers what rests, and the next worker reconciles */
  close(): void { for (const id of [...this.sessions.keys()]) this.forget(id); }

  // -----------------------------------------------------------------------------------------------------------------------------
  /** One pass for one market-making agent whose lease this worker holds. */
  async tick(a: MmAgentRow): Promise<string> {
    const now = this.deps.now(), mode: MmMode = a.mode === 'LIVE' ? 'LIVE' : 'PAPER';
    const active = mode === 'LIVE' ? a.state === 'LIVE' : a.state === 'PAPER_TRADING';
    this.agents.set(a.id, a);
    let s = this.sessions.get(a.id) ?? null;
    if (s && s.mode !== mode && !s.ending) this.end(s, 'the agent changed mode', null);
    if (!s) {
      if (!active) return this.orphan(a, mode, now);
      const made = await this.open(a, mode, now, false);
      if (typeof made === 'string') return made;
      s = made;
    }
    if (!active && !s.ending) this.end(s, a.state === 'PAUSED' ? 'the agent was paused' : a.state === 'STOPPING' || a.state === 'STOPPED' ? 'the agent was stopped' : `the agent is ${a.state}`, null);
    if (!s.ending) await this.supervise(a, s, now);

    if (s.paper) s.paper.step();
    this.settleFunding(s, now);
    this.limits(s);
    await s.engine.tick();
    await this.flush(a, s);
    const st = s.engine.status();
    if (s.ending && st.phase === 'stopped') return this.finish(a, s, now);
    await this.persist(a, s, st, now);
    // paper: a halt on the loss limits ends the simulation, as before (quotes cancelled, the position closed at the book)
    if (s.mode === 'PAPER' && st.halted && (st.halted === 'drawdown_session' || st.halted === 'drawdown_day') && !s.ending) this.end(s, `loss limit reached (${st.halted}): simulated quotes cancelled and the position closed at the book`, 'STOPPED', true);
    return `${st.phase}${st.reason ? `: ${st.reason.slice(0, 100)}` : ''} — ${st.orders.length} quote(s), position ${st.position}`;
  }

  /** an agent that is not active and has no session here: a session row left `running` by a dead worker is cleaned up */
  private async orphan(a: MmAgentRow, mode: MmMode, now: number): Promise<string> {
    const [left] = await sql<{ id: string; mode: MmMode }[]>`select id, mode from mm_sessions where agent_id = ${a.id} and state = 'running' order by started_at desc limit 1`;
    if (left && left.mode === 'LIVE' && this.deps.live) {
      // a live session died with the agent no longer active: the venue may still hold its quotes — one clean-up session cancels them and disarms
      const made = await this.open(a, 'LIVE', now, true);
      if (typeof made !== 'string') { this.end(made, 'clean-up after the worker that ran the session stopped', null); return 'cleaning up a session left by a stopped worker'; }
    }
    if (left) await closeSession(left.id, now, 'the worker that ran this session stopped', 'abandoned');
    if (a.state === 'STOPPING') await sql`update agents set state = 'STOPPED', updated_at = now() where id = ${a.id} and state = 'STOPPING'`;
    void mode;
    return 'idle';
  }

  private end(s: Session, why: string, endState: Session['endState'], flatten?: boolean): void {
    if (s.ending) return;
    s.ending = why; s.endState = endState;
    s.engine.stop(why, flatten === undefined ? {} : { flatten });
  }

  // -----------------------------------------------------------------------------------------------------------------------------
  private async open(a: MmAgentRow, mode: MmMode, now: number, cleanup: boolean): Promise<Session | string> {
    const rt = a.runtime, venue = rt.venues[0]!, base = a.universe[0]!, live = this.deps.live;
    const hold = async (code: string, reason: string): Promise<string> => { await this.holdNote(a, mode, code, reason, now); return `hold: ${reason.slice(0, 120)}`; };
    let mandate: QuotingMandateInfo | null = null, network: HlNetwork = 'mainnet';
    if (mode === 'LIVE') {
      if (!live) return hold('live_unavailable', 'this process has no live market-making binding');
      mandate = await live.mandate(a.id);
      if (!mandate) return hold('mandate_required', 'no quoting mandate approved for this agent');
      if (!cleanup) {
        if (!mandate.usable) return hold('mandate_unusable', mandate.why ?? `the quoting mandate is ${mandate.phase}`);
        if (mandate.section.engine.configSha256 !== configHash(rt.config)) return hold('config_changed', 'the agent\'s configuration is not the one its quoting mandate was approved for');
        if (!inSessionHours(mandate.section.engine.hours, now)) return hold('outside_hours', 'outside the session hours of the mandate');
        const lock = mmOpeningLock(mandate.network, this.deps.locks());
        if (lock) return hold(lock.code, lock.message);
      }
      network = mandate.network;
    }
    const inst = await this.deps.resolve(venue, base);
    if (!inst) return hold('no_market', `${venue} does not list a perpetual on ${base}`);
    if (!cleanup) {
      // no session before the market data is there: a stream that is not connected is a GAP, a book that is missing or old is not data
      const first = marketDataPort(this.deps.books(network), { now: this.deps.now, maxAgeMs: a.risk.maxDataAgeMs }).snapshot(inst.id);
      if (first.status !== 'connected') return hold(first.status === 'stale' ? 'data_not_fresh' : 'data_gap', `${inst.id}: the stream is ${first.status}`);
      if (!first.book) return hold('data_not_fresh', `${inst.id}: no two-sided book yet`);
    }
    const capital = Number(a.capital_usdc) / 1e6, fees = this.deps.fees(venue), cfg0 = rt.config as { requoteBps?: unknown; minRestMs?: unknown; quoteSizeUsd?: unknown; maxInventoryUsd?: unknown; policy?: string };
    const rule = quotePolicyOf(rt.config, inst, a.risk.maxPositionUsd), policy = mandate ? withinBand(rule, mandate.section.terms.minHalfSpreadBps, mandate.section.terms.maxDistanceBps) : rule;
    const row = await openSession({ agentId: a.id, mode, instrument: inst.id, network, accountId: mandate?.accountId ?? null, mandateId: mandate?.mandateId ?? null, policy: policy.id, configVersion: a.config_version, worker: this.deps.worker, now });
    const queue: JournalEvent[] = [], books = this.deps.books(network);
    let port: OrderPort, paper: PaperVenue | null = null, stream: StreamReconciledPort | null = null, budget: MmBudget;
    const sref: { s: Session | null } = { s: null };
    if (mode === 'PAPER') {
      budget = new MmBudget({ now: this.deps.now });
      paper = new PaperVenue({ instrument: inst.id, now: this.deps.now, book: () => market.snapshot(inst.id).book, makerRate: fees?.makerRate ?? '0.0005', takerRate: fees?.takerRate ?? '0.0005', capitalUsd: dec(capital, 6),
        minRestMs: Number(cfg0.minRestMs ?? 1000), minNotionalUsd: inst.minNotional ?? '0', ...(rt.mm?.paper ? { state: rt.mm.paper } : {}) });
      port = paper;
    } else {
      const v = live!.venue(network), m = mandate!;
      budget = new MmBudget({ now: this.deps.now, ...(v.processUsed ? { processUsed: v.processUsed } : {}) });
      const metered: HlVenuePort = {
        info: (body) => { budget.info(String((body as { type?: unknown }).type)); return v.info(body); },
        exchange: (body, n) => { const t = String((body as { action?: { type?: unknown } }).action?.type); budget.exchange(t, n); budget.addressSpent(t === 'order' ? 'orders' : t === 'scheduleCancel' ? 'heartbeat' : 'cancels', t === 'scheduleCancel' ? 1 : n); return v.exchange(body, n); },
      };
      const adapter = createLiveMmAdapter({ network, account: m.account, mandateId: m.mandateId, venue: metered, locks: this.deps.locks(), now: this.deps.now,
        signer: { venueQuotingSign: async (p) => { const r = await live!.signer.venueQuotingSign(p); if (r.kind === 'quotes') { const st = sref.s?.engine.status(); budget.signerQuoteBatch({ flat: !st || D.isZero(D.from(st.position)), pendingQuotes: st?.orders.filter((o) => o.state !== 'resting').length ?? 0 }); } return r; } } });
      // the venue's own figure of the address limit feeds the budget each time the engine reads it
      const counted: OrderPort = { ...adapter, actionTtlMs: adapter.actionTtlMs, addressRequestsRemaining: async () => { const n = await adapter.addressRequestsRemaining(); budget.addressObserved(n); return n; } };
      stream = streamReconciled(counted, { account: m.account, feed: live!.userFeed(network), now: this.deps.now, ...(this.deps.auditEveryMs ? { auditEveryMs: this.deps.auditEveryMs } : {}),
        onDivergence: (d) => queue.push({ ts: this.deps.now(), type: 'mm.stream_divergence', ...d }) });
      port = stream;
      live!.setStepPacing?.(m.accountId, 60_000);
    }
    const market = marketDataPort(books, { now: this.deps.now, maxAgeMs: a.risk.maxDataAgeMs, ...(stream ? { userStatus: (): VenueStatus | null => { const u = stream!.status(); return u === 'idle' ? null : u; } } : {}) });
    const sec = mandate?.section.engine ?? null, { round, roundReduce } = roundersFor(inst);
    const sessionLoss = sec ? D.str(D.neg(D.from(sec.maxSessionLossUsd))) : dec(-capital * a.risk.maxTotalLossPct / 100, 6), dayLoss = mandate ? D.str(D.neg(D.from(mandate.maxDailyLossUsd))) : dec(-capital * a.risk.maxDailyLossPct / 100, 6);
    const [prior] = await sql<{ t: string }[]>`select coalesce(sum((pnl->>'totalUsd')::numeric), 0)::text as t from mm_sessions where agent_id = ${a.id} and mode = ${mode} and id <> ${row.id}`;
    const dayBefore = await dayPnlBefore(a.id, mode, now, row.id);
    const cfg: MmEngineConfig = {
      instrument: inst.id, sessionId: row.session_hex,
      planner: { requoteToleranceBps: String(cfg0.requoteBps ?? 2), sizeToleranceBps: '5000', maxRestingPerSide: mandate?.section.terms.levelsPerSide ?? 1, softInventory: '0', hardInventory: '0', reduceSlippageBps: '5', maxReduceSize: '0' },
      breakers: { ...PAPER_BREAKERS, maxDataAgeMs: a.risk.maxDataAgeMs, maxSessionLossUsd: sessionLoss, maxDayLossUsd: dayLoss, action: sec ? { ...sec.breakers } : { drawdown_session: 'flatten', drawdown_day: 'flatten' } },
      rate: { addressReserve: 500, addressComfort: 2000, ipReserve: 300, ipWeightPerQuoteBatch: 44, maxBatch: Math.min(20, (mandate?.section.terms.levelsPerSide ?? 1) * 2) }, vol: VOL_STUDY_DEFAULTS, baselineLambda: 0.995,
      reconcileEveryMs: this.deps.reconcileEveryMs ?? (mode === 'PAPER' ? 1000 : 2000), rateEveryMs: 120_000, ipWeightRemaining: () => budget.remaining(), flattenOnStop: sec?.flattenOnStop ?? false, round, roundReduce,
      dayPnlUsd: (t) => D.str(D.add(D.from(dayBefore), D.from(t))),
    };
    const s: Session = { row, mode, agentId: a.id, instrument: inst.id, inst, network, engine: null as never, cfg, policy, port, paper, stream, budget, mandate, queue, refusals: {}, breakers: [], unwinds: new Map(), startedAt: now, lastSaveAt: -Infinity, lastSlowAt: -Infinity, lastTapeAt: -Infinity,
      lastMandateAt: now, lastNote: {}, dayBefore, priorTotal: prior?.t ?? '0', capital, ending: null, endState: null, lapses: -1, fundedAt: null, view: null, lockCode: null, cleanup, paperSeq: paper?.state.seq ?? 0, riskCache: new Map() };
    s.engine = new MmEngine(cfg, policy, { market, orders: port, clock: { now: this.deps.now }, journal: { record: (e) => { queue.push(e); } },
      risk: { killSwitch: () => this.deps.killSwitch(), evaluate: (i) => this.evaluate(a, s, i) },
      mandate: { current: () => this.mandateView(s) } });
    sref.s = s;
    this.sessions.set(a.id, s);
    s.engine.start();
    return s;
  }

  /**
   * Funding of the position, into the attribution. LIVE: the settlements the venue's user stream delivered (its own signed
   * amount). PAPER: at each boundary of the instrument's funding interval, −position × mark × the venue's published rate
   * (longs pay a positive rate), with the rate and the mark the source last received — ONE settlement per boundary, never a
   * rate applied to intervals it was not published for; nothing when the source has no ticker.
   */
  private settleFunding(s: Session, now: number): void {
    if (s.stream) { for (const f of s.stream.takeFunding(s.instrument)) s.engine.funding(f.amount); return; }
    if (!s.paper) return;
    const step = (s.inst.fundingIntervalSec || 3600) * 1000, boundary = Math.floor(now / step) * step;
    if (s.fundedAt === null) { s.fundedAt = boundary; return; }
    if (boundary <= s.fundedAt) return;
    s.fundedAt = boundary;
    const f = this.deps.books(s.network).read(s.instrument)?.funding, pos = D.from(s.paper.state.position);
    if (!f || D.isZero(pos) || now - f.receivedAt > 2 * step) return;
    const usd = D.str(D.div(D.neg(D.mul(D.mul(pos, D.from(f.mark)), D.from(f.rate))), D.one, 8, 'half_even'));
    s.paper.funding(usd); s.engine.funding(usd);
  }
  /** soft and hard inventory limits in base units, from their USD values at the current mid (they follow the price) */
  private limits(s: Session): void {
    const mid = s.engine.status().lastMid ?? null;
    const snapMid = mid ?? (() => { const r = this.deps.books(s.network).read(s.instrument); return r?.top ? D.str(D.div(D.add(D.from(r.top.bid), D.from(r.top.ask)), D.from(2n), 12, 'half_even')) : null; })();
    if (!snapMid || !D.isPos(D.from(snapMid))) return;
    const a = this.agents.get(s.agentId); if (!a) return;
    const c = a.runtime.config as { quoteSizeUsd?: unknown; maxInventoryUsd?: unknown }, sec = s.mandate?.section.engine;
    const softUsd = sec ? sec.softInventoryUsd : String(Math.min(Number(c.maxInventoryUsd), a.risk.maxPositionUsd)), hardUsd = sec ? sec.hardInventoryUsd : String(Math.min(Number(c.maxInventoryUsd) * 1.5, Math.max(a.risk.maxPositionUsd, Number(c.maxInventoryUsd))));
    const base = (usd: string): DecStr => D.str(D.div(D.from(usd), D.from(snapMid), 8, 'down'));
    s.cfg.planner.softInventory = base(softUsd); s.cfg.planner.hardInventory = base(hardUsd); s.cfg.planner.maxReduceSize = base(String(sec ? sec.quoteSizeUsd : c.quoteSizeUsd));
  }
  private readonly agents = new Map<string, MmAgentRow>();

  /** what may end or hold the session before the engine runs: the mandate, the locks, the schedule */
  private async supervise(a: MmAgentRow, s: Session, now: number): Promise<void> {
    if (s.mode !== 'LIVE' || !s.mandate) return;
    const sec = s.mandate.section.engine;
    if (now - s.lastMandateAt >= 15_000) {
      s.lastMandateAt = now;
      const m = await this.deps.live!.mandate(a.id).catch(() => null);
      if (m && m.mandateId === s.mandate.mandateId) s.mandate = m;
      if (!m || m.mandateId !== s.mandate.mandateId || !m.usable) return this.end(s, `the quoting mandate is no longer usable (${m?.why ?? m?.phase ?? 'not found'})`, 'STOPPED');
      if (m.section.engine.configSha256 !== configHash(a.runtime.config)) return this.end(s, 'the agent\'s configuration is not the one its quoting mandate was approved for', 'STOPPED');
    }
    if (now >= s.mandate.expiresAtMs - sec.stopBeforeExpiryS * 1000) return this.end(s, `the quoting mandate expires within ${sec.stopBeforeExpiryS} s: the session winds down`, 'STOPPED');
    if (now - s.startedAt >= sec.maxSessionMinutes * 60_000) return this.end(s, `maximum session duration reached (${sec.maxSessionMinutes} min): resume the agent for a new session`, 'PAUSED');
    if (!inSessionHours(sec.hours, now)) return this.end(s, 'end of the session hours of the mandate', null);
    const lock = mmOpeningLock(s.network, this.deps.locks());
    s.lockCode = lock?.code ?? null;
    s.engine.hold(lock ? `${lock.code}: ${lock.message}` : null);
  }

  private async mandateView(s: Session): Promise<MandateView | null> {
    if (s.mode === 'PAPER') {
      const v: MandateView = { mandateId: 'paper', phase: 'active', expiresAt: Number.MAX_SAFE_INTEGER, deadManSeconds: 60, bucketActions: 20, quotesLeftHour: 1_000_000, quotesLeftDay: 1_000_000,
        switch: { armed: (s.paper!.state.switchDeadline ?? 0) > this.deps.now(), deadline: s.paper!.state.switchDeadline, lapsesToday: s.paper!.triggersToday() } };
      s.view = v; return v;
    }
    const st = await this.deps.live!.signer.status();
    const q = st.venueQuotingMandates?.find((x) => x.mandate.mandateId === s.mandate!.mandateId);
    if (!q) { s.view = null; return null; }
    // the API's own record can only narrow what the signer says: a mandate revoked here is in its wind-down whatever the signer still holds
    const phase = q.phase === 'active' && !s.mandate!.usable ? 'wind_down' : q.phase;
    const v: MandateView = { mandateId: q.mandate.mandateId, phase, expiresAt: q.mandate.expiresAt, deadManSeconds: q.mandate.deadManSeconds, bucketActions: q.bucketActions, quotesLeftHour: q.mandate.rate.ordersPerHour - q.quotesThisHour, quotesLeftDay: q.mandate.rate.ordersPerDay - q.today.quotes,
      switch: { armed: q.deadMan.armed, deadline: q.deadMan.deadline, lapsesToday: q.today.lapses ?? 0 } };
    s.view = v; return v;
  }

  /**
   * Pre-trade check of a plan. Reductions pass (the kill switch never blocks an exit). Quotes: LIVE — the unified risk service
   * judges the WORST CASE of each side (the whole size of that side at its most aggressive price) for the agent's principal;
   * its venue reads cost IP weight, so a decision is reused for the same side, size and inventory (in quote lots) for 30 s — a
   * fill, a size change or a new side is a new evaluation. PAPER — the agent's own exposure limit on the simulated book.
   */
  private async evaluate(a: MmAgentRow, s: Session, i: { instrument: string; kind: 'quotes' | 'reduce'; orders: readonly QuoteOrder[]; position: DecStr }): Promise<RiskDecision> {
    if (i.kind === 'reduce') return { allow: true, code: null, message: null };
    const now = this.deps.now();
    for (const side of ['buy', 'sell'] as const) {
      const mine = i.orders.filter((o) => o.side === side);
      if (!mine.length) continue;
      const size = mine.reduce((n, o) => D.add(n, D.from(o.size)), D.zero), price = mine.map((o) => D.from(o.price)).reduce(side === 'buy' ? D.max : D.min), notional = D.mul(size, price);
      if (s.mode === 'PAPER') {
        const after = D.mul(D.abs(side === 'buy' ? D.add(D.from(i.position), size) : D.sub(D.from(i.position), size)), price);
        if (D.gt(after, D.from(String(Math.max(a.risk.maxGrossUsd, a.risk.maxPositionUsd * 2))))) return { allow: false, code: 'risk_limit', message: `the ${side} quotes would allow ${D.str(after)} USD of exposure, above the agent's limit` };
        continue;
      }
      const lots = D.isPos(mine[0] ? D.from(mine[0].size) : D.zero) ? D.str(D.div(D.from(i.position), D.from(mine[0]!.size), 0, 'down')) : '0', key = `${side}|${D.str(size)}|${lots}`, hit = s.riskCache.get(key);
      if (hit && now - hit.at < 30_000 && hit.d.allow) continue;
      const m = s.mandate!;
      const d = await this.deps.live!.evaluate({ v: 1, venue: 'hyperliquid', network: s.network, instrument: i.instrument, marketKind: 'perp', side, type: 'limit', size: D.str(size), notional: null, limitPrice: D.str(price), triggerPrice: null, reduceOnly: false, tif: 'alo',
        maxSlippageBps: 1, maxFeeUsd: D.str(D.div(D.mul(notional, D.from('0.001')), D.one, 6, 'up')), leverage: null, marginMode: null, clientOrderId: `mm-risk-${s.row.session_hex}-${side}-${now}`, mode: 'live', principal: { kind: 'agent', id: a.id }, mandateId: m.mandateId,
        createdAt: now, expiresAt: now + 30_000 }, m.accountId);
      s.riskCache.set(key, { at: now, d });
      if (s.riskCache.size > 50) s.riskCache.delete(s.riskCache.keys().next().value!);
      if (!d.allow) return d;
    }
    return { allow: true, code: null, message: null };
  }

  // -----------------------------------------------------------------------------------------------------------------------------
  private async holdNote(a: MmAgentRow, mode: MmMode, code: string, reason: string, now: number): Promise<void> {
    const k = `${a.id}:${code}`, last = this.holds.get(k) ?? -Infinity;
    if (now - last < 300_000) return;
    this.holds.set(k, now);
    await journal(a.id, { mode, kind: 'hold', code, severity: 'warning', title: 'No quoting session', body: reason, configVersion: a.config_version });
    await this.signal(a, mode, now, 'skipped', code, reason, null);
  }
  private readonly holds = new Map<string, number>();

  /** the engine's journal → the agent journal, the fills table, the unified orders of the unwinds, the audit events the alerts read */
  private async flush(a: MmAgentRow, s: Session): Promise<void> {
    const events = s.queue.splice(0, s.queue.length), mode = s.mode;
    for (const e of events) {
      const d = e as JournalEvent & Record<string, any>;
      if (e.type === 'mm.fill') {
        await recordFill({ sessionId: s.row.id, agentId: a.id, mode, instrument: s.instrument, accountId: s.mandate?.accountId ?? null, fillId: String(d.id), clientId: d.clientId ?? null, venueOrderId: d.venueOrderId ?? null, side: d.side, price: d.price, size: d.size, fee: d.fee, maker: d.maker === true,
          reduce: d.reduce === true || d.maker !== true, mid: d.mid ?? null, ts: Number(d.fillTs ?? e.ts) });
        if (d.clientId && s.unwinds.has(d.clientId)) { await settleUnwind(d.clientId, 'filled', e.ts, { size: d.size, price: d.price }); }
      } else if (e.type === 'mm.quote' && this.due(s, 'signal', e.ts, 60_000)) {
        const qs = d.quotes as QuoteOrder[], side = (x: 'buy' | 'sell') => { const q = qs.find((y) => y.side === x); return q ? { price: Number(q.price), size: Number(q.size) } : null; }, mid = s.engine.status().lastMid;
        await this.signal(a, mode, e.ts, 'acted', 'acted', `quotes ${side('buy')?.price ?? '—'} / ${side('sell')?.price ?? '—'} (${s.policy.id})`, { bid: side('buy'), ask: side('sell'), mid: mid === null ? null : Number(mid), policy: s.policy.id, session: s.row.id });
      } else if (e.type === 'mm.pulled') {
        const why = String(d.why ?? '');
        await this.signal(a, mode, e.ts, 'skipped', /kill_switch/.test(why) ? 'kill_switch' : /venue_disconnected|data_stale/.test(why) ? 'data_gap' : /mandate|lock|disabled/.test(why) ? 'orders_refused' : 'risk_limit', `quotes pulled: ${why}`, null);
      } else if (e.type === 'mm.reduce') { for (const o of d.orders as QuoteOrder[]) s.unwinds.set(o.clientId, { order: o, why: String(d.why ?? 'hard_limit') }); }
      else if (e.type === 'mm.reduce_result') {
        for (const id of d.clientIds as string[]) {
          const u = s.unwinds.get(id); if (!u) continue;
          const outcome = d.outcome === 'done' ? { kind: 'done' as const, result: ((d.results as OrderResult[]) ?? []).find((r) => r.clientId === id) ?? null } : d.outcome === 'refused' ? { kind: 'refused' as const, stage: String(d.stage), code: String(d.code), message: String(d.message ?? '') } : { kind: 'unknown' as const, message: String(d.message ?? '') };
          await recordUnwind({ agentId: a.id, mode, network: s.network, instrument: s.instrument, accountId: s.mandate?.accountId ?? null, mandateId: s.mandate?.mandateId ?? null, sessionId: s.row.id, why: u.why, order: u.order, now: e.ts, outcome }).catch((err: Error) => console.error(`[mm] unwind order ${id}: ${err.message}`));
        }
      } else if (e.type === 'mm.reconciled_order' && s.unwinds.has(String(d.clientId))) await settleUnwind(String(d.clientId), d.venue, e.ts);
      else if (e.type === 'mm.breaker') { s.breakers.push({ ts: e.ts, code: String(d.code), action: String(d.action) }); await audit('mm.breaker', `agent:${a.id}`, { agent: a.id, session: s.row.id, mode: mode.toLowerCase(), code: d.code, action: d.action, halted: d.action === 'halt' }).catch(() => {}); }
      else if (e.type === 'mm.halted') await audit('mm.breaker', `agent:${a.id}`, { agent: a.id, session: s.row.id, mode: mode.toLowerCase(), code: d.code, action: 'halt', halted: true }).catch(() => {});
      else if (e.type === 'mm.batch_refused' || e.type === 'mm.risk_refused' || e.type === 'mm.order_rejected') {
        const code = e.type === 'mm.risk_refused' ? `risk_${String(d.code)}` : String(d.code);
        s.refusals[code] = (s.refusals[code] ?? 0) + 1;
        if (d.stage === 'signer' && (s.refusals[code] === 1 || s.refusals[code]! % 20 === 0)) await audit('mm.signer_refusals', `agent:${a.id}`, { agent: a.id, session: s.row.id, code, count: s.refusals[code] }).catch(() => {});
      } else if (e.type === 'mm.degraded' && this.due(s, 'rate', e.ts, 900_000)) await audit('mm.rate_budget', `agent:${a.id}`, { agent: a.id, session: s.row.id, reason: d.reason ?? 'rate budget under pressure' }).catch(() => {});
      if (SILENT.has(e.type)) continue;
      const t = TITLES[e.type];
      if (!t) continue;
      // the same event with the same code is written at most once a minute (a refusal repeated at every cycle is one line and a counter)
      const sig = `${e.type}:${String(d.code ?? d.why ?? d.kind ?? '')}`;
      if (e.type !== 'mm.fill' && e.type !== 'mm.reduce' && e.type !== 'mm.breaker' && e.type !== 'mm.manual' && !this.due(s, sig, e.ts, 60_000)) continue;
      const { ts: _ts, type: _type, instrument: _i, ...data } = d; void _ts; void _type; void _i;
      const body = e.type === 'mm.fill' ? `${d.maker ? 'maker' : 'taker'} ${d.side} ${d.size} @ ${d.price} (fee ${d.fee})${mode === 'PAPER' ? ' — SIMULATED' : ''}` : String(d.why ?? d.message ?? d.code ?? d.note ?? '').slice(0, 400);
      await journal(a.id, { mode, kind: t[0], code: e.type.slice(3) + (d.code ? `:${String(d.code)}` : ''), severity: t[1], title: `${t[2]}${d.code ? `: ${String(d.code)}` : ''}`, body, data, configVersion: a.config_version, ref: { session: s.row.id } });
    }
  }
  /**
   * The signal history of the agent (agent_signals), as for every stream agent — WITHOUT a row per quote: the quotes of a
   * session's first batch, then the latest ones at most once a minute (`acted`), and each change of the reason quotes are
   * pulled (`skipped`, with a reason code). The trading API's `signals` read answers from it, per mode.
   */
  private async signal(a: MmAgentRow, mode: MmMode, now: number, decision: 'acted' | 'skipped', code: string, reason: string, output: Record<string, unknown> | null): Promise<void> {
    const rc = (REASON_CODES as readonly string[]).includes(code) ? code : decision === 'acted' ? 'acted' : 'risk_limit';
    await sql`insert into agent_signals (agent_id, bar, mode, kind, config_version, strategy_sha256, inputs_digest, status, reason, decision, reason_code, weights)
      values (${a.id}, ${new Date(now)}, ${mode}, 'stream', ${a.config_version}, ${ruleHash(a.runtime.rule)}, ${output ? inputsDigest(output) : null}, ${decision === 'acted' ? 'done' : 'hold'}, ${reason.slice(0, 300)}, ${decision}, ${rc}, ${output ? sql.json(output as never) : null})
      on conflict (agent_id, mode, bar) do update set status = excluded.status, reason = excluded.reason, decision = excluded.decision, reason_code = excluded.reason_code, weights = excluded.weights, updated_at = now()`.catch(() => {});
  }
  private due(s: Session, key: string, now: number, every: number): boolean { const last = s.lastNote[key] ?? -Infinity; if (now - last < every) return false; s.lastNote[key] = now; return true; }

  /** the session row (what the owner's screen reads), the tape, the equity point, the markouts; the owner's instruction, if one waits */
  private async persist(a: MmAgentRow, s: Session, st: EngineStatus, now: number): Promise<void> {
    const mid = st.lastMid;
    if (mid && now - s.lastTapeAt >= 1000 && s.engine.status().lastBookTs !== null) { s.lastTapeAt = now; await recordTape(s.instrument, s.network, now, mid).catch(() => {}); }
    if (s.paper && (s.paper.state.seq !== s.paperSeq || now - s.lastSaveAt >= 5000)) {
      s.paperSeq = s.paper.state.seq;
      // the simulated account survives a restart; `book.positions` keeps the shape the risk-management agent reads
      await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ mm: { ...(a.runtime.mm ?? {}), paper: s.paper.state }, book: { positions: { [s.instrument]: { size: Number(s.paper.state.position), avgPrice: Number(mid ?? 0) } }, quotes: [] }, lastDecisionAt: now } as never)}, last_bar = ${new Date(now)}, updated_at = now() where id = ${a.id}`;
    }
    if (now - s.lastSaveAt >= (this.deps.saveEveryMs ?? 2000)) {
      s.lastSaveAt = now;
      const m = mid ? D.from(mid) : null, lapses = s.view?.switch?.lapsesToday ?? 0;
      const view = { phase: st.phase, reason: st.reason, ending: s.ending, position: st.position, positionUsd: m ? D.str(D.div(D.mul(D.from(st.position), m), D.one, 4, 'half_even')) : null, mid, bookTs: st.lastBookTs,
        quotes: st.orders.map((o) => ({ clientId: o.clientId, side: o.side, price: o.price, size: o.size, state: o.state, ageMs: Math.max(0, now - o.placedAt), distanceBps: m && D.isPos(m) ? D.str(D.div(D.mul(D.abs(D.sub(D.from(o.price), m)), D.from(10000n)), m, 2, 'half_even')) : null })),
        blockedSides: st.blockedSides, activeBreakers: st.activeBreakers, halted: st.halted, manual: st.manual, consecutiveRejects: st.consecutiveRejects, lock: s.lockCode,
        switch: { deadline: st.switchDeadline, armed: st.switchDeadline !== null && st.switchDeadline > now, signer: s.view?.switch ?? null, lapsesToday: lapses, venueTriggersPerDay: 10, signerStopsAt: 8 },
        mandate: s.mandate ? { id: s.mandate.mandateId, phase: s.view?.phase ?? null, expiresAt: s.mandate.expiresAtMs, quotesLeftHour: s.view?.quotesLeftHour ?? null, quotesLeftDay: s.view?.quotesLeftDay ?? null, bucketActions: s.view?.bucketActions ?? null } : null,
        schedule: s.mandate ? { hours: s.mandate.section.engine.hours, endsAt: s.startedAt + s.mandate.section.engine.maxSessionMinutes * 60_000 } : null,
        stream: s.stream?.stats() ?? null, simulated: s.mode === 'PAPER', worker: this.deps.worker, ts: now };
      const cmd = await saveSession(s.row.id, now, { status: st, view, refusals: s.refusals, budget: s.budget.report() as never, breakers: s.breakers }).catch(() => null);
      if (cmd) await this.command(a, s, cmd, now);
      if (lapses > s.lapses && s.lapses >= 0 && s.mode === 'LIVE') await audit('mm.switch_lapse', `agent:${a.id}`, { agent: a.id, session: s.row.id, lapses, day: new Date(now).toISOString().slice(0, 10) }).catch(() => {});
      s.lapses = lapses;
    }
    if (now - s.lastSlowAt >= (this.deps.slowEveryMs ?? 60_000)) {
      s.lastSlowAt = now;
      const equity = s.capital + Number(s.priorTotal) + Number(st.pnl.totalUsd);
      await sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${a.id}, ${new Date(Math.floor(now / 60_000) * 60_000)}, ${s.mode}, ${equity}, ${sql.json({ [s.instrument]: Number(st.position) } as never)})
        on conflict (agent_id, ts, mode) do update set equity_usd = excluded.equity_usd, positions = excluded.positions`.catch(() => {});
      await settleMarkouts(now).catch(() => {});
      if (Math.floor(now / 3_600_000) !== Math.floor((now - 60_000) / 3_600_000)) await pruneTape(now).catch(() => {});
    }
  }
  private async command(a: MmAgentRow, s: Session, c: SessionCommand, now: number): Promise<void> {
    if (c.command === 'pull') s.engine.pull(`pull asked by ${c.by}`); else if (c.command === 'flatten') s.engine.flatten(`flatten asked by ${c.by}`); else s.engine.resume();
    await ackCommand(s.row.id, c, now, 'taken by the session');
    await journal(a.id, { mode: s.mode, kind: 'state', code: `owner_${c.command}`, severity: 'warning', title: `Owner instruction: ${c.command}`, body: `by ${c.by}`, ref: { session: s.row.id } });
  }
  /** the owner's instruction given directly to a session of THIS process (the routes use it when they run in the worker's process) */
  instruct(agentId: string, command: SessionCommand['command'], by: string): boolean {
    const s = this.sessions.get(agentId); if (!s) return false;
    if (command === 'pull') s.engine.pull(`pull asked by ${by}`); else if (command === 'flatten') s.engine.flatten(`flatten asked by ${by}`); else s.engine.resume();
    return true;
  }

  private async finish(a: MmAgentRow, s: Session, now: number): Promise<string> {
    const st = s.engine.status(), why = s.ending ?? 'stopped';
    await saveSession(s.row.id, now, { status: st, view: { phase: 'stopped', reason: why, position: st.position, quotes: [], ts: now, simulated: s.mode === 'PAPER' }, refusals: s.refusals, budget: s.budget.report() as never, breakers: s.breakers }).catch(() => {});
    await closeSession(s.row.id, now, why, s.cleanup ? 'abandoned' : 'stopped');
    if (s.paper) await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ mm: { ...(a.runtime.mm ?? {}), paper: s.paper.state } } as never)}, updated_at = now() where id = ${a.id}`;
    await settleMarkouts(now).catch(() => {});
    if (!s.cleanup) await audit('mm.session_ended', `agent:${a.id}`, { agent: a.id, session: s.row.id, mode: s.mode.toLowerCase(), reason: why, pnl: st.pnl.totalUsd, fills: st.pnl.fills }).catch(() => {});
    this.forget(a.id);
    // the agent's own state follows: a stop that was waiting for the session, or an end the session decided
    if (a.state === 'STOPPING') await sql`update agents set state = 'STOPPED', updated_at = now() where id = ${a.id} and state = 'STOPPING'`;
    else if (s.endState === 'STOPPED') {
      await sql`update agents set state = 'STOPPED', stop_reason = ${why.slice(0, 300)}, updated_at = now() where id = ${a.id} and state in ('LIVE', 'PAPER_TRADING')`;
      await journal(a.id, { mode: s.mode, kind: 'stop', code: 'session_end', severity: 'warning', title: 'Agent stopped', body: why, configVersion: a.config_version });
      if (s.mode === 'LIVE' && s.mandate) await this.deps.live!.revoke(s.mandate.mandateId, `MM_SESSION_END: ${why}`.slice(0, 280)).catch((e: Error) => console.error(`[mm] revoke after the session of ${a.id}: ${e.message}`));
    } else if (s.endState === 'PAUSED') {
      await sql`update agents set state = 'PAUSED', runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ pausedFrom: s.mode } as never)}, updated_at = now() where id = ${a.id} and state in ('LIVE', 'PAPER_TRADING')`;
      await journal(a.id, { mode: s.mode, kind: 'state', code: 'paused', severity: 'warning', title: 'Paused by the session schedule', body: why, configVersion: a.config_version });
    }
    return `session ended: ${why.slice(0, 120)}`;
  }

  /**
   * The owner's "pull quotes now" / "flatten" when NO worker runs a session for the agent (it died, or the agent is stopped):
   * a short session of this process, under the agent's lease taken by the caller — start-up (cancel-all → reconcile), the
   * instruction, then shutdown. It never quotes: the instruction is set before the first cycle. Reductions and cancels are
   * signed under every lock, during a halt and during the wind-down.
   */
  async emergency(a: MmAgentRow, command: 'pull' | 'flatten', by: string, o: { maxMs?: number; stepMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ done: boolean; position: DecStr; resting: number; phase: string }> {
    const now = this.deps.now(), sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const made = await this.open({ ...a, mode: 'LIVE' }, 'LIVE', now, true);
    if (typeof made === 'string') throw new Error(made);
    const s = made, end = now + (o.maxMs ?? 30_000);
    this.agents.set(a.id, a);
    if (command === 'flatten') s.engine.flatten(`flatten asked by ${by}`); else s.engine.pull(`pull asked by ${by}`);
    const settled = (st: EngineStatus): boolean => st.phase !== 'starting' && st.orders.length === 0 && (command === 'pull' || (D.isZero(D.from(st.position)) && st.manual !== 'flatten'));
    while (this.deps.now() < end && !settled(s.engine.status())) { this.limits(s); await s.engine.tick(); await this.flush(a, s); await sleep(o.stepMs ?? 500); }
    const reached = settled(s.engine.status());
    this.end(s, `${command} asked by ${by} with no running session`, null, false);
    while (this.deps.now() < end + 30_000 && s.engine.status().phase !== 'stopped') { await s.engine.tick(); await this.flush(a, s); await sleep(o.stepMs ?? 500); }
    const st = s.engine.status();
    await closeSession(s.row.id, this.deps.now(), s.ending ?? command, 'stopped');
    this.forget(a.id);
    return { done: reached, position: st.position, resting: st.orders.length, phase: st.phase };
  }
}
export const mmRuleHash = (): string => ruleHash('spread_inventory');

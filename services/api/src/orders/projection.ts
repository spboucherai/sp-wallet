// Projection of the venue engines' rows onto the unified order (V11). PURE: no database, no clock except `now`.
//
// The engines (exec.ts — Hyperliquid, gmx-exec.ts — GMX, paper.ts — paper) stay the executors and keep their own rows and
// vocabularies. A unified order is never written from an engine state directly: `advance(record, snapshot, now)` computes the
// EVENTS of the state machine of @spw/trading that lead from the record as it is to the state the engine row maps to
// (packages/trading/src/orders/vocabulary.ts), and applies each of them with `transition()`. A step the table does not allow is
// not forced: the record stays where it is and the difference is reported (`error`), so a drift is visible instead of hidden.
//
// Consequences that matter:
//  - nothing becomes PARTIALLY_FILLED / FILLED except through `reconciled_found`, built from what the engine read at the venue
//    (the paper engine is the venue of a paper order);
//  - an engine "never placed" becomes FAILED only through `reconciled_absent` with the venue's policy (VENUE_RECONCILE) and the
//    expiry of the signed request: inside the grace window the unified order stays UNKNOWN;
//  - a terminal unified order is never changed.
import { D, RISK_CODES, type DecStr } from '@spw/derivatives';
import {
  absenceConclusiveAt, IllegalTransitionError, isTerminal, mapGmxOp, mapHyperliquidOrder, transition, VENUE_RECONCILE,
  type GmxOpState, type HlOrderState, type OrderEvent, type OrderHistoryEntry, type OrderRecord, type OrderState, type ReasonCode, type UnifiedState,
} from '@spw/trading';

export interface EngineSnapshot {
  target: UnifiedState;
  /** cumulative filled size the engine read at the venue, and its average price */
  filled: DecStr; avg: DecStr | null; venueOrderId: string | null;
  /** how an order is approved when the engine row is past the approval: the owner's passkey, or a mandate */
  approval: 'owner' | 'mandate';
  /** venue whose reconcile policy applies (VENUE_RECONCILE) and the expiry of the signed request, unix ms */
  venue: string; requestExpiresAt: number | null;
  /** the engine's free text for people */
  detail: string | null;
  /** a compact signature of the engine row: the projector skips a row whose signature it already projected */
  sig: string;
}

const u = (state: OrderState, reason: ReasonCode, note: string | null = null): UnifiedState => ({ state, reason, note });
const canon = (x: string | null | undefined): DecStr => (x === null || x === undefined || x === '' ? '0' : D.str(D.from(String(x))));
const canonN = (x: string | null | undefined): DecStr | null => (x === null || x === undefined || x === '' ? null : D.str(D.from(String(x))));
const posOrNull = (x: DecStr | null): DecStr | null => (x !== null && D.isPos(D.from(x)) ? x : null);

// ------------------------------------------------------------------------------------------------------------------ paper
export const PAPER_ORDER_STATUSES = ['pending', 'open', 'filled', 'partially_filled', 'cancelled', 'rejected', 'triggered'] as const;
export type PaperOrderStatus = (typeof PAPER_ORDER_STATUSES)[number];
/**
 * The paper engine's order status (`Order.status` of @spw/derivatives, stored in `deriv_orders.status` with `state` null).
 * The paper engine is the venue of a paper order: it has no approval step and no signer, so the first state seen is at the venue.
 */
export function mapPaperOrder(status: PaperOrderStatus, row: { filled?: string | null; rejectReason?: string | null } = {}): UnifiedState {
  const some = D.isPos(D.from(canon(row.filled)));
  switch (status) {
    case 'pending': return u('SUBMITTED', 'VENUE_ACCEPTED', 'a trigger order the paper engine accepted and holds until its trigger');
    case 'triggered': return u('SUBMITTED', 'VENUE_RESTING', 'triggered; waits for the next book');
    case 'open': return u('SUBMITTED', 'VENUE_RESTING');
    case 'partially_filled': return u('PARTIALLY_FILLED', 'VENUE_FILL');
    case 'filled': return u('FILLED', 'VENUE_FILLED');
    case 'cancelled': return some ? u('CANCELLED', 'REMAINDER_CANCELLED') : u('CANCELLED', 'CANCELLED_AT_VENUE', 'cancelled in the paper engine (by request, by a loss-limit halt, or an IOC remainder)');
    case 'rejected': return u('REJECTED', 'VENUE_REJECTED', 'refused by the paper engine\'s own rules');
  }
}

// ------------------------------------------------------------------------------------------------------------------ snapshots
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a database row
const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/** refusals of the unified risk gate, written by the engines as `<code>: <reason>` (derivatives/gate.ts) */
const GATE_TEXTS: readonly { test: RegExp; to: UnifiedState }[] = [
  { test: /^kill_switch_active: /, to: u('REJECTED', 'KILL_SWITCH_ACTIVE') },
  { test: /^read_only_mode: /, to: u('REJECTED', 'READ_ONLY_MODE') },
  { test: /^risk_denied: /, to: u('REJECTED', 'RISK_DENIED') },
];

/** a `deriv_orders` row of a PAPER account (`state` is null) */
export function paperSnapshot(r: Row): EngineSnapshot {
  const text = (r.reject_reason as string | null) ?? null;
  const gate = r.status === 'rejected' && text !== null ? GATE_TEXTS.find((g) => g.test.test(text))?.to : undefined;
  return { target: gate ?? mapPaperOrder(r.status as PaperOrderStatus, { filled: r.filled, rejectReason: text }), filled: canon(r.filled), avg: posOrNull(canonN(r.avg_fill_price)),
    venueOrderId: (r.venue_order_id as string | null) ?? null, approval: r.origin === 'mandate' ? 'mandate' : 'owner', venue: 'paper', requestExpiresAt: null, detail: text,
    sig: `p|${r.status}|${canon(r.filled)}|${canonN(r.avg_fill_price) ?? ''}|${text ?? ''}` };
}

/** a `deriv_orders` row of a LIVE Hyperliquid account (`state` is set) */
export function hyperliquidSnapshot(r: Row): EngineSnapshot {
  const text = (r.reject_reason as string | null) ?? null, final = r.final === true, filled = canon(r.filled), size = canon(r.size);
  const gate = r.state === 'rejected' && text !== null ? GATE_TEXTS.find((g) => g.test.test(text))?.to : undefined;
  let target = gate ?? mapHyperliquidOrder(r.state as HlOrderState, { final, rejectReason: text });
  // a row the engine still watches (`final` false) is not final here either: `filled` whole stays FILLED (it cannot change),
  // anything else is what rests at the venue until the engine says it is settled
  if (!final && (target.state === 'CANCELLED' || target.state === 'FILLED') && ['filled', 'cancelled', 'partially_filled'].includes(r.state)) {
    const some = D.isPos(D.from(filled)), whole = D.gte(D.from(filled), D.from(size));
    target = whole ? u('FILLED', 'VENUE_FILLED') : some ? u('PARTIALLY_FILLED', 'VENUE_FILL', 'the engine has not settled this order yet') : u('SUBMITTED', 'VENUE_RESTING', 'the engine has not settled this order yet');
  }
  return { target, filled, avg: posOrNull(canonN(r.avg_fill_price)), venueOrderId: (r.venue_order_id as string | null) ?? null, approval: r.origin === 'mandate' ? 'mandate' : 'owner', venue: 'hyperliquid',
    requestExpiresAt: ms(r.expires_at as Date | null), detail: text, sig: `h|${r.state}|${final ? 1 : 0}|${filled}|${canonN(r.avg_fill_price) ?? ''}|${r.venue_order_id ?? ''}|${text ?? ''}` };
}

/** the text gmx-exec.ts stores with a `failed` operation → the closed reason code (a text that is not recognised stays INTERNAL_ERROR, with the text as detail) */
export function gmxFailure(error: string | null): UnifiedState {
  const t = error ?? '';
  if (/hash mismatch/i.test(t)) return u('FAILED', 'SIGNER_HASH_MISMATCH');
  if (/replaced/i.test(t)) return u('FAILED', 'TX_REPLACED');
  if (/revert/i.test(t)) return u('FAILED', 'TX_REVERTED');
  if (/OrderCreated|no order/i.test(t)) return u('FAILED', 'NO_ORDER_EVENT');
  if (/signer|not signed|refused|passkey|approval/i.test(t)) return u('REJECTED', 'SIGNER_REFUSED_OR_UNREACHABLE');
  return u('FAILED', 'INTERNAL_ERROR', 'the text of the GMX operation names no cause this mapping knows');
}
/** a `deriv_gmx_ops` row of kind increase or decrease (a `cancel` operation acts on another order and is not an order) */
export function gmxSnapshot(r: Row): EngineSnapshot {
  const state = r.state as GmxOpState, text = (r.error as string | null) ?? null;
  const target = state === 'failed' ? gmxFailure(text) : mapGmxOp(state, r.kind === 'decrease' ? 'decrease' : 'increase');
  return { target, filled: '0', avg: null, venueOrderId: (r.order_key as string | null) ?? null, approval: 'owner', venue: 'gmx', requestExpiresAt: ms(r.expires_at as Date | null), detail: text,
    sig: `g|${state}|${r.final ? 1 : 0}|${r.order_key ?? ''}|${text ?? ''}` };
}

// ------------------------------------------------------------------------------------------------------------------ advance
const RANK: Record<OrderState, number> = { CREATED: 0, VALIDATED: 1, AWAITING_APPROVAL: 2, APPROVED: 3, SUBMITTING: 4, SUBMITTED: 5, UNKNOWN: 5, PARTIALLY_FILLED: 6, FILLED: 9, CANCELLED: 9, REJECTED: 9, FAILED: 9 };
const PRE: readonly OrderState[] = ['CREATED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED'];
const LOCAL_CANCEL = ['WITHDRAWN_BEFORE_APPROVAL', 'HALTED_BEFORE_APPROVAL', 'AUTHORIZATION_REVOKED', 'MANDATE_REVOKED', 'DATA_INCONSISTENT_BEFORE_APPROVAL', 'CANCELLED_BY_REQUEST'] as const;
const LOCAL_REJECT = ['INVALID_ORDER', 'RISK_DENIED', 'MANDATE_DENIED', 'KILL_SWITCH_ACTIVE', 'READ_ONLY_MODE', 'INSTRUMENT_NOT_ALLOWED', 'VENUE_NOT_ALLOWED', 'IDEMPOTENCY_CONFLICT', 'BUILD_ERROR', 'SIGNER_REFUSED', 'SIGNER_REFUSED_OR_UNREACHABLE'] as const;
const LOCAL_FAIL = ['SIGNER_UNREACHABLE', 'SIGNER_INTERRUPTED', 'SIGNER_HASH_MISMATCH', 'NOT_SENT', 'TX_REVERTED', 'TX_REPLACED', 'NO_ORDER_EVENT', 'INTERNAL_ERROR'] as const;
const AMBIGUOUS = ['SUBMIT_TIMEOUT', 'SUBMIT_NETWORK_ERROR', 'SUBMIT_UNREADABLE_ANSWER', 'INTERRUPTED_AFTER_SIGNING', 'RECEIPT_OVERDUE'] as const;
const has = <T extends string>(xs: readonly T[], x: string): x is T => (xs as readonly string[]).includes(x);
const cut = (s: string | null): string | undefined => (s === null || s === '' ? undefined : s.slice(0, 500));

/** one step up the approval ladder, towards `want` (VALIDATED … SUBMITTING); null when the record is already there or past it */
function climb(o: OrderRecord, want: OrderState, s: EngineSnapshot): OrderEvent | null {
  if (RANK[o.state] >= RANK[want]) return null;
  switch (o.state) {
    case 'CREATED': return { type: 'validated' };
    case 'VALIDATED': return s.approval === 'mandate' && want !== 'AWAITING_APPROVAL' ? { type: 'approved', by: 'mandate' } : { type: 'approval_requested' };
    case 'AWAITING_APPROVAL': return { type: 'approved', by: 'owner' };
    case 'APPROVED': return { type: 'submit_started' };
    default: return null;
  }
}
const maxDec = (a: DecStr, b: DecStr): DecStr => (D.gte(D.from(a), D.from(b)) ? a : b);
const found = (o: OrderRecord, s: EngineSnapshot, status: 'resting' | 'frozen' | 'filled' | 'cancelled'): OrderEvent => {
  const d = cut(s.detail);
  return { type: 'reconciled_found', status, filledSize: maxDec(s.filled, o.filledSize), ...(s.avg !== null ? { avgFillPrice: s.avg } : {}), ...(s.venueOrderId ? { venueOrderId: s.venueOrderId.slice(0, 200) } : {}), ...(d !== undefined ? { detail: d } : {}) };
};

/** the next event towards the snapshot's target, or null when there is none to apply */
export function nextEvent(o: OrderRecord, s: EngineSnapshot): OrderEvent | null {
  if (isTerminal(o.state)) return null;
  const T = s.target.state, R = s.target.reason, pre = PRE.includes(o.state), d = cut(s.detail), withDetail = d !== undefined ? { detail: d } : {};
  switch (T) {
    case 'CREATED': return null;
    case 'VALIDATED': case 'AWAITING_APPROVAL': case 'APPROVED': case 'SUBMITTING': return climb(o, T, s);
    case 'SUBMITTED': {
      if (RANK[o.state] < RANK.SUBMITTING) return climb(o, 'SUBMITTING', s);
      if (o.state === 'SUBMITTING') return s.venueOrderId ? { type: 'venue_accepted', venueOrderId: s.venueOrderId.slice(0, 200) } : found(o, s, 'resting');
      if (o.state === 'UNKNOWN') return found(o, s, R === 'VENUE_FROZEN' ? 'frozen' : 'resting');
      if (o.state === 'SUBMITTED') {
        if (R === 'VENUE_FROZEN' && o.reason !== 'VENUE_FROZEN') return found(o, s, 'frozen');
        if (s.venueOrderId && o.venueOrderId !== s.venueOrderId.slice(0, 200)) return found(o, s, 'resting');
      }
      return null;
    }
    case 'PARTIALLY_FILLED': {
      if (RANK[o.state] < RANK.SUBMITTING) return climb(o, 'SUBMITTING', s);
      return D.gt(D.from(s.filled), D.from(o.filledSize)) || o.state === 'SUBMITTING' || o.state === 'UNKNOWN' ? found(o, s, 'resting') : null;
    }
    case 'FILLED': return RANK[o.state] < RANK.SUBMITTING ? climb(o, 'SUBMITTING', s) : found(o, s, 'filled');
    case 'CANCELLED': {
      if (!pre) return found(o, s, 'cancelled');
      if (R === 'APPROVAL_EXPIRED') return o.state === 'AWAITING_APPROVAL' ? { type: 'approval_expired', ...withDetail } : RANK[o.state] < RANK.AWAITING_APPROVAL ? climb(o, 'AWAITING_APPROVAL', { ...s, approval: 'owner' }) : { type: 'expired', source: 'local', ...withDetail };
      if (has(LOCAL_CANCEL, R)) return { type: 'cancel_requested', reason: R, ...withDetail };
      if (R === 'ORDER_EXPIRED') return { type: 'expired', source: 'local', ...withDetail };
      // cancelled at the venue: the order was there, so the record first reaches the venue
      if (R === 'CANCELLED_AT_VENUE' || R === 'EXPIRED_AT_VENUE' || R === 'REMAINDER_CANCELLED' || s.venueOrderId) return climb(o, 'SUBMITTING', s);
      return { type: 'cancel_requested', reason: 'CANCELLED_BY_REQUEST', ...withDetail };
    }
    case 'REJECTED': {
      const venue: OrderEvent = { type: 'venue_rejected', reason: (d ?? 'rejected').slice(0, 500) };
      if (R === 'VENUE_REJECTED' || R === 'VENUE_REJECTED_AFTER_ACK') return pre ? climb(o, 'SUBMITTING', s) : venue;
      const reason = has(LOCAL_REJECT, R) ? R : 'INVALID_ORDER';
      return pre || o.state === 'SUBMITTING' ? { type: 'local_rejected', reason, ...withDetail } : venue;
    }
    case 'FAILED': {
      if (R === 'NEVER_PLACED') {
        if (RANK[o.state] < RANK.SUBMITTING) return climb(o, 'SUBMITTING', s);
        const policy = Object.hasOwn(VENUE_RECONCILE, s.venue) ? VENUE_RECONCILE[s.venue] : undefined;
        return { type: 'reconciled_absent', supportsClientIdLookup: policy?.supportsClientIdLookup ?? false, conclusiveAt: absenceConclusiveAt(policy, s.requestExpiresAt), ...withDetail };
      }
      const reason = has(LOCAL_FAIL, R) ? R : 'INTERNAL_ERROR';
      if (pre || o.state === 'SUBMITTING') return { type: 'local_failed', reason, ...withDetail };
      // past SUBMITTING no local event may close an order: what the chain or the venue said is a venue refusal
      return { type: 'venue_rejected', reason: (d ?? reason).slice(0, 500) };
    }
    case 'UNKNOWN': {
      if (RANK[o.state] < RANK.SUBMITTING) return climb(o, 'SUBMITTING', s);
      if (o.state === 'SUBMITTING') return { type: 'submit_ambiguous', reason: has(AMBIGUOUS, R) ? R : R === 'OUTCOME_EVENT_MISSING' ? 'RECEIPT_OVERDUE' : 'SUBMIT_UNREADABLE_ANSWER', ...withDetail };
      if (o.state === 'SUBMITTED' || o.state === 'PARTIALLY_FILLED') return { type: 'venue_lost', ...withDetail };
      return null;
    }
  }
}

export interface Advance { order: OrderRecord; steps: { event: OrderEvent; entry: OrderHistoryEntry }[]; /** set when the record could not reach the engine's state */ error: string | null }

/** applies events until the record is where the engine row is, or until nothing more can be applied */
export function advance(record: OrderRecord, s: EngineSnapshot, now: number): Advance {
  let o = record;
  const steps: Advance['steps'] = [];
  for (let k = 0; k < 10; k++) {
    const ev = nextEvent(o, s);
    if (ev === null) break;
    let r: ReturnType<typeof transition>;
    try { r = transition(o, ev, now); } catch (e) {
      if (e instanceof IllegalTransitionError || e instanceof RangeError) return { order: o, steps, error: `${ev.type} towards ${s.target.state}: ${e.message}`.slice(0, 300) };
      throw e;
    }
    const moved = r.order.state !== o.state || r.order.filledSize !== o.filledSize || r.order.venueOrderId !== o.venueOrderId || r.order.reason !== o.reason;
    if (!moved) break;                                    // the event changed nothing (a repeat): it is not recorded
    steps.push({ event: ev, entry: r.entry });
    o = r.order;
    // `reconciled_absent` inside the grace window keeps the order UNKNOWN: the engine's verdict is applied again later
    if (ev.type === 'reconciled_absent') break;
  }
  return { order: o, steps, error: reached(o, s) ? null : `the engine row maps to ${s.target.state}/${s.target.reason}; the unified order is ${o.state}/${o.reason}` };
}

/** is the record where the engine row says the order is? (states; a terminal record that agrees on the state is settled) */
export function reached(o: OrderRecord, s: EngineSnapshot): boolean {
  const T = s.target.state;
  if (o.state === T) return true;
  // ahead on the approval ladder: an engine row that is still before the venue while the service already recorded more
  if (RANK[T] <= RANK.SUBMITTING && RANK[o.state] >= RANK[T] && !isTerminal(o.state)) return true;
  // a failure after the venue step is recorded as a venue refusal (see nextEvent, FAILED)
  if (T === 'FAILED' && o.state === 'REJECTED' && (o.reason === 'VENUE_REJECTED' || o.reason === 'VENUE_REJECTED_AFTER_ACK')) return true;
  // inside the grace window of "never placed"
  if (T === 'FAILED' && s.target.reason === 'NEVER_PLACED' && o.state === 'UNKNOWN' && (o.reason === 'ABSENT_WITHIN_GRACE')) return true;
  // SUBMITTED engine row, order already partly filled here (fills arrive before the status)
  if (T === 'SUBMITTED' && o.state === 'PARTIALLY_FILLED') return true;
  return false;
}

/** the engine's refusal code → the closed reason of the unified order */
export function reasonOfCode(code: string): { event: 'local_rejected'; reason: 'INVALID_ORDER' | 'RISK_DENIED' | 'MANDATE_DENIED' | 'KILL_SWITCH_ACTIVE' | 'READ_ONLY_MODE' | 'INSTRUMENT_NOT_ALLOWED' | 'VENUE_NOT_ALLOWED' | 'BUILD_ERROR' | 'SIGNER_REFUSED' } {
  const r = (reason: ReturnType<typeof reasonOfCode>['reason']) => ({ event: 'local_rejected' as const, reason });
  if (code === 'kill_switch_active') return r('KILL_SWITCH_ACTIVE');
  if (code === 'read_only_mode') return r('READ_ONLY_MODE');
  if (code === 'instrument_not_allowed') return r('INSTRUMENT_NOT_ALLOWED');
  if (['mainnet_disabled', 'mandate_mainnet_disabled', 'gmx_disabled', 'mode_read_only', 'authorization_expired', 'venue_restricted', 'mandate_unavailable', 'paper_unsupported', 'asset_table_mismatch'].includes(code)) return r('VENUE_NOT_ALLOWED');
  if (code.startsWith('signer_')) return r('SIGNER_REFUSED');
  if (code.startsWith('mandate_')) return r('MANDATE_DENIED');
  if (code === 'venue_rejected') return r('BUILD_ERROR');
  if (code === 'risk_denied' || code === 'halted' || (RISK_CODES as readonly string[]).includes(code)) return r('RISK_DENIED');
  return r('INVALID_ORDER');
}


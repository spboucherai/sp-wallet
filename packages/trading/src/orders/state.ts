/**
 * The single order state machine of the V11 trading layer.
 *
 *   CREATED → VALIDATED → AWAITING_APPROVAL → APPROVED → SUBMITTING → SUBMITTED → PARTIALLY_FILLED → FILLED
 *                                                            └→ UNKNOWN ─(reconciliation)→ SUBMITTED | PARTIALLY_FILLED | FILLED | CANCELLED | REJECTED | FAILED
 *   terminal: FILLED, CANCELLED, REJECTED, FAILED
 *
 * Rules the table and `transition` enforce:
 *  1. A transition that is not in TRANSITIONS throws IllegalTransitionError. Terminal states have no outgoing transition.
 *  2. Nothing becomes PARTIALLY_FILLED or FILLED without a VENUE-ORIGINATED event (`fill`, `reconciled_found`): the answer of a
 *     submission never fills an order, and no local event can.
 *  3. A submission whose outcome is not known (`submit_ambiguous`: network error, timeout, unreadable answer AFTER the request may
 *     have left) is UNKNOWN, never FAILED. UNKNOWN is left only by a venue-originated event, by `reconciled_absent` under the
 *     conditions of rule 4, or by an explicit `operator_resolved`.
 *  4. `reconciled_absent` makes an order FAILED only when the venue supports a lookup by client order id, the order was never
 *     acknowledged by the venue, and `now` has reached `conclusiveAt` — the venue-specific instant after which the venue can no
 *     longer accept the request (expiry of the signed request + a grace window for the lag of the venue's read side). Otherwise
 *     the order stays UNKNOWN and the history says why.
 *  5. REJECTED = a refusal with a cause in the business rules (validation, risk, mandate, signer policy, the venue's own rules).
 *     FAILED = a technical failure after which it is PROVEN that no order exists. CANCELLED = withdrawn, expired or cancelled.
 *     The cause is a member of the closed REASON_CODES enum, never free text; `detail` is free text for people.
 *  6. Every transition yields a history entry { from, to, event, at, reason, detail }; `transition` never mutates its input.
 *
 * Pure: the clock is the `now` argument.
 */
import { z } from 'zod';
import { D, type DecStr } from '@spw/derivatives';
import { canon, NonNegDecSchema, PosDecSchema, TsMsSchema } from '../dec.ts';

export const ORDER_STATES = ['CREATED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;
export const OrderStateSchema = z.enum(ORDER_STATES);
export type OrderState = z.infer<typeof OrderStateSchema>;
export const TERMINAL_STATES: readonly OrderState[] = ['FILLED', 'CANCELLED', 'REJECTED', 'FAILED'];
export const isTerminal = (s: OrderState): boolean => TERMINAL_STATES.includes(s);
/** states in which the venue may hold (or may have held) the order */
export const AT_VENUE_STATES: readonly OrderState[] = ['SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN'];

// ------------------------------------------------------------------------------------------------------------------ reason codes

/** refusals → REJECTED */
export const REJECT_REASONS = [
  'INVALID_ORDER', 'RISK_DENIED', 'MANDATE_DENIED', 'KILL_SWITCH_ACTIVE', 'READ_ONLY_MODE', 'INSTRUMENT_NOT_ALLOWED', 'VENUE_NOT_ALLOWED', 'IDEMPOTENCY_CONFLICT',
  'BUILD_ERROR', 'SIGNER_REFUSED', 'SIGNER_REFUSED_OR_UNREACHABLE', 'VENUE_REJECTED', 'VENUE_REJECTED_AFTER_ACK',
] as const;
/** technical failures, each one proving that no order exists → FAILED */
export const FAILURE_REASONS = [
  'SIGNER_UNREACHABLE', 'SIGNER_INTERRUPTED', 'SIGNER_HASH_MISMATCH', 'NOT_SENT', 'NEVER_PLACED', 'TX_REVERTED', 'TX_REPLACED', 'NO_ORDER_EVENT', 'INTERNAL_ERROR', 'OPERATOR_RESOLVED',
] as const;
/** withdrawals, expiries and cancellations → CANCELLED */
export const CANCEL_REASONS = [
  'WITHDRAWN_BEFORE_APPROVAL', 'APPROVAL_EXPIRED', 'HALTED_BEFORE_APPROVAL', 'AUTHORIZATION_REVOKED', 'MANDATE_REVOKED', 'DATA_INCONSISTENT_BEFORE_APPROVAL', 'ORDER_EXPIRED',
  'CANCELLED_BY_REQUEST', 'CANCELLED_AT_VENUE', 'EXPIRED_AT_VENUE', 'REMAINDER_CANCELLED',
] as const;
/** why an outcome is not known → UNKNOWN */
export const UNKNOWN_REASONS = [
  'SUBMIT_TIMEOUT', 'SUBMIT_NETWORK_ERROR', 'SUBMIT_UNREADABLE_ANSWER', 'INTERRUPTED_AFTER_SIGNING', 'VENUE_LOST_ORDER', 'ABSENT_WITHIN_GRACE', 'ABSENT_UNVERIFIABLE', 'OUTCOME_EVENT_MISSING', 'RECEIPT_OVERDUE',
] as const;
/** ordinary progress */
export const PROGRESS_REASONS = [
  'ORDER_CREATED', 'VALIDATION_PASSED', 'APPROVAL_REQUESTED', 'APPROVED_BY_OWNER', 'APPROVED_BY_MANDATE', 'SUBMIT_STARTED', 'VENUE_ACCEPTED', 'VENUE_FILL', 'VENUE_FILLED', 'VENUE_RESTING', 'VENUE_FROZEN',
  'CANCEL_REQUESTED', 'DUPLICATE_EVENT_IGNORED', 'OPERATION_COMPLETED', 'LEGACY_UNSPECIFIED',
] as const;
export const REASON_CODES = [...PROGRESS_REASONS, ...REJECT_REASONS, ...FAILURE_REASONS, ...CANCEL_REASONS, ...UNKNOWN_REASONS] as const;
export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type FailureReason = (typeof FAILURE_REASONS)[number];
export type CancelReason = (typeof CANCEL_REASONS)[number];
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

// ------------------------------------------------------------------------------------------------------------------ events

const Detail = z.string().max(500).optional();
/** reasons a caller may give when it withdraws or expires an order that never left */
const LOCAL_CANCEL_REASONS = ['WITHDRAWN_BEFORE_APPROVAL', 'HALTED_BEFORE_APPROVAL', 'AUTHORIZATION_REVOKED', 'MANDATE_REVOKED', 'DATA_INCONSISTENT_BEFORE_APPROVAL', 'CANCELLED_BY_REQUEST'] as const;
const VENUE_CANCEL_REASONS = ['CANCELLED_BY_REQUEST', 'CANCELLED_AT_VENUE', 'EXPIRED_AT_VENUE'] as const;
const LOCAL_REJECT_REASONS = ['INVALID_ORDER', 'RISK_DENIED', 'MANDATE_DENIED', 'KILL_SWITCH_ACTIVE', 'READ_ONLY_MODE', 'INSTRUMENT_NOT_ALLOWED', 'VENUE_NOT_ALLOWED', 'IDEMPOTENCY_CONFLICT', 'BUILD_ERROR', 'SIGNER_REFUSED', 'SIGNER_REFUSED_OR_UNREACHABLE'] as const;
const LOCAL_FAILURE_REASONS = ['SIGNER_UNREACHABLE', 'SIGNER_INTERRUPTED', 'SIGNER_HASH_MISMATCH', 'NOT_SENT', 'TX_REVERTED', 'TX_REPLACED', 'NO_ORDER_EVENT', 'INTERNAL_ERROR'] as const;
const AMBIGUOUS_REASONS = ['SUBMIT_TIMEOUT', 'SUBMIT_NETWORK_ERROR', 'SUBMIT_UNREADABLE_ANSWER', 'INTERRUPTED_AFTER_SIGNING', 'RECEIPT_OVERDUE'] as const;

export const OrderEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('validated'), detail: Detail }),
  /** a refusal decided on this side, before anything left: validation, risk engine, mandate, signer policy */
  z.strictObject({ type: z.literal('local_rejected'), reason: z.enum(LOCAL_REJECT_REASONS), detail: Detail }),
  /** a technical failure after which it is proven that nothing reached the venue (the caller asserts it; see rule 3 for the other case) */
  z.strictObject({ type: z.literal('local_failed'), reason: z.enum(LOCAL_FAILURE_REASONS), detail: Detail }),
  z.strictObject({ type: z.literal('approval_requested'), detail: Detail }),
  /** `owner`: a passkey approval verified by the signer. `mandate`: the order is inside a mandate the owner approved before; no per-order approval */
  z.strictObject({ type: z.literal('approved'), by: z.enum(['owner', 'mandate']), detail: Detail }),
  z.strictObject({ type: z.literal('approval_expired'), detail: Detail }),
  z.strictObject({ type: z.literal('submit_started'), detail: Detail }),
  z.strictObject({ type: z.literal('venue_accepted'), venueOrderId: z.string().min(1).max(200), detail: Detail }),
  z.strictObject({ type: z.literal('venue_rejected'), reason: z.string().min(1).max(500), detail: Detail }),
  z.strictObject({ type: z.literal('submit_ambiguous'), reason: z.enum(AMBIGUOUS_REASONS), detail: Detail }),
  /** the venue acknowledged the order earlier and no longer knows it */
  z.strictObject({ type: z.literal('venue_lost'), detail: Detail }),
  /** reconciliation found the order on the venue. `filledSize` is cumulative. `resting` = accepted, on the book (or pending execution) */
  z.strictObject({ type: z.literal('reconciled_found'), status: z.enum(['resting', 'frozen', 'filled', 'cancelled', 'rejected']), filledSize: NonNegDecSchema,
    avgFillPrice: PosDecSchema.nullable().optional(), venueOrderId: z.string().min(1).max(200).optional(), detail: Detail }),
  /** reconciliation did not find the order. `conclusiveAt` (unix ms) is computed by `absenceConclusiveAt` from the venue's policy */
  z.strictObject({ type: z.literal('reconciled_absent'), supportsClientIdLookup: z.boolean(), conclusiveAt: TsMsSchema.nullable(), detail: Detail }),
  /** one execution reported by the venue. `fillId` makes the event idempotent */
  z.strictObject({ type: z.literal('fill'), size: PosDecSchema, price: PosDecSchema, fillId: z.string().min(1).max(200).optional(), detail: Detail }),
  z.strictObject({ type: z.literal('cancel_requested'), reason: z.enum(LOCAL_CANCEL_REASONS).optional(), detail: Detail }),
  /** the venue confirms that the order no longer rests */
  z.strictObject({ type: z.literal('cancelled'), reason: z.enum(VENUE_CANCEL_REASONS).optional(), detail: Detail }),
  /** `local`: the order's own validity window ended before it left. `venue`: the venue reports that it expired there */
  z.strictObject({ type: z.literal('expired'), source: z.enum(['local', 'venue']), detail: Detail }),
  /** a person closes an order that reconciliation cannot settle. It can never make an order filled. */
  z.strictObject({ type: z.literal('operator_resolved'), operator: z.string().min(1).max(80), detail: z.string().min(1).max(500) }),
]);
export type OrderEvent = z.infer<typeof OrderEventSchema>;
export type OrderEventType = OrderEvent['type'];
export const ORDER_EVENT_TYPES = ['validated', 'local_rejected', 'local_failed', 'approval_requested', 'approved', 'approval_expired', 'submit_started', 'venue_accepted', 'venue_rejected',
  'submit_ambiguous', 'venue_lost', 'reconciled_found', 'reconciled_absent', 'fill', 'cancel_requested', 'cancelled', 'expired', 'operator_resolved'] as const satisfies readonly OrderEventType[];
/** events that carry something the venue itself said about the order */
export const VENUE_ORIGINATED_EVENTS: readonly OrderEventType[] = ['venue_accepted', 'venue_rejected', 'venue_lost', 'reconciled_found', 'reconciled_absent', 'fill', 'cancelled'];

// ------------------------------------------------------------------------------------------------------------------ the table

/** for a state and an event: every state the order may be in afterwards. A missing entry is an illegal transition. */
export const TRANSITIONS: Readonly<Record<OrderState, Readonly<Partial<Record<OrderEventType, readonly OrderState[]>>>>> = {
  CREATED: {
    validated: ['VALIDATED'], local_rejected: ['REJECTED'], local_failed: ['FAILED'], cancel_requested: ['CANCELLED'], expired: ['CANCELLED'],
  },
  VALIDATED: {
    approval_requested: ['AWAITING_APPROVAL'], approved: ['APPROVED'], local_rejected: ['REJECTED'], local_failed: ['FAILED'], cancel_requested: ['CANCELLED'], expired: ['CANCELLED'],
  },
  AWAITING_APPROVAL: {
    approved: ['APPROVED'], approval_expired: ['CANCELLED'], local_rejected: ['REJECTED'], local_failed: ['FAILED'], cancel_requested: ['CANCELLED'], expired: ['CANCELLED'],
  },
  APPROVED: {
    submit_started: ['SUBMITTING'], local_rejected: ['REJECTED'], local_failed: ['FAILED'], cancel_requested: ['CANCELLED'], expired: ['CANCELLED'],
  },
  SUBMITTING: {
    venue_accepted: ['SUBMITTED'], venue_rejected: ['REJECTED'], submit_ambiguous: ['UNKNOWN'], local_rejected: ['REJECTED'], local_failed: ['FAILED'],
    reconciled_found: ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'], reconciled_absent: ['UNKNOWN', 'FAILED'],
    fill: ['PARTIALLY_FILLED', 'FILLED'], cancel_requested: ['SUBMITTING'],
  },
  SUBMITTED: {
    fill: ['PARTIALLY_FILLED', 'FILLED'], reconciled_found: ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'], venue_rejected: ['REJECTED'],
    venue_lost: ['UNKNOWN'], reconciled_absent: ['UNKNOWN'], cancel_requested: ['SUBMITTED'], cancelled: ['CANCELLED'], expired: ['CANCELLED'],
  },
  PARTIALLY_FILLED: {
    fill: ['PARTIALLY_FILLED', 'FILLED'], reconciled_found: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
    venue_lost: ['UNKNOWN'], reconciled_absent: ['UNKNOWN'], cancel_requested: ['PARTIALLY_FILLED'], cancelled: ['CANCELLED'], expired: ['CANCELLED'],
  },
  UNKNOWN: {
    venue_accepted: ['SUBMITTED'], venue_rejected: ['REJECTED'], reconciled_found: ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'],
    reconciled_absent: ['UNKNOWN', 'FAILED'], fill: ['PARTIALLY_FILLED', 'FILLED'], cancel_requested: ['UNKNOWN'], cancelled: ['CANCELLED'], operator_resolved: ['FAILED'],
  },
  FILLED: {}, CANCELLED: {}, REJECTED: {}, FAILED: {},
};

export const canTransition = (from: OrderState, event: OrderEventType): boolean => TRANSITIONS[from][event] !== undefined;
export const nextStates = (from: OrderState, event: OrderEventType): readonly OrderState[] => TRANSITIONS[from][event] ?? [];

export class IllegalTransitionError extends Error {
  readonly from: OrderState; readonly event: OrderEventType;
  constructor(from: OrderState, event: OrderEventType, why?: string) {
    super(`illegal order transition: ${event} in state ${from}${why ? ` (${why})` : ''}`);
    this.name = 'IllegalTransitionError'; this.from = from; this.event = event;
  }
}

// ------------------------------------------------------------------------------------------------------------------ records

export const OrderRecordSchema = z.strictObject({
  /** the order's id on this side: the client order id */
  id: z.string().min(1).max(128),
  state: OrderStateSchema,
  /** quantity of the base asset ordered, when known (an order given as a notional has none until the venue reports it) */
  size: PosDecSchema.nullable(),
  filledSize: NonNegDecSchema,
  avgFillPrice: PosDecSchema.nullable(),
  venueOrderId: z.string().nullable(),
  /** true once the venue itself has said that it knows the order */
  acknowledged: z.boolean(),
  cancelRequested: z.boolean(),
  /** fill ids already applied (idempotency of `fill`) */
  fillIds: z.array(z.string()),
  /** reason of the LAST transition */
  reason: ReasonCodeSchema, detail: z.string().nullable(),
  createdAt: TsMsSchema, updatedAt: TsMsSchema,
  /** number of transitions applied: an optimistic-concurrency token for the store */
  version: z.number().int().nonnegative(),
});
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

export const OrderHistoryEntrySchema = z.strictObject({
  orderId: z.string(), seq: z.number().int().positive(), from: OrderStateSchema, to: OrderStateSchema, event: z.enum(ORDER_EVENT_TYPES), at: TsMsSchema,
  reason: ReasonCodeSchema, detail: z.string().nullable(),
});
export type OrderHistoryEntry = z.infer<typeof OrderHistoryEntrySchema>;

export function newOrder(o: { id: string; size: DecStr | null }, now: number): OrderRecord {
  return OrderRecordSchema.parse({ id: o.id, state: 'CREATED', size: o.size === null ? null : canon(o.size), filledSize: '0', avgFillPrice: null, venueOrderId: null, acknowledged: false,
    cancelRequested: false, fillIds: [], reason: 'ORDER_CREATED', detail: null, createdAt: now, updatedAt: now, version: 0 });
}

export interface TransitionResult { order: OrderRecord; entry: OrderHistoryEntry }

// ------------------------------------------------------------------------------------------------------------------ transition

interface Step { to: OrderState; reason: ReasonCode; detail?: string | null; patch?: Partial<OrderRecord> }

function fillState(size: DecStr | null, filled: DecStr): 'PARTIALLY_FILLED' | 'FILLED' {
  return size !== null && D.gte(D.from(filled), D.from(size)) ? 'FILLED' : 'PARTIALLY_FILLED';
}

function decide(o: OrderRecord, e: OrderEvent, now: number): Step {
  switch (e.type) {
    case 'validated': return { to: 'VALIDATED', reason: 'VALIDATION_PASSED' };
    case 'local_rejected': return { to: 'REJECTED', reason: e.reason };
    case 'local_failed':
      // in SUBMITTING the only failures that prove nothing left are those that happen before the request is sent
      return { to: 'FAILED', reason: e.reason };
    case 'approval_requested': return { to: 'AWAITING_APPROVAL', reason: 'APPROVAL_REQUESTED' };
    case 'approved':
      if (o.state === 'VALIDATED' && e.by !== 'mandate') throw new IllegalTransitionError(o.state, e.type, 'an owner approval must be requested first; only a mandate approves without a request');
      if (o.state === 'AWAITING_APPROVAL' && e.by !== 'owner') throw new IllegalTransitionError(o.state, e.type, 'an order waiting for the owner is approved by the owner');
      return { to: 'APPROVED', reason: e.by === 'owner' ? 'APPROVED_BY_OWNER' : 'APPROVED_BY_MANDATE' };
    case 'approval_expired': return { to: 'CANCELLED', reason: 'APPROVAL_EXPIRED' };
    case 'submit_started': return { to: 'SUBMITTING', reason: 'SUBMIT_STARTED' };
    case 'venue_accepted': return { to: 'SUBMITTED', reason: 'VENUE_ACCEPTED', patch: { venueOrderId: e.venueOrderId, acknowledged: true } };
    case 'venue_rejected': return { to: 'REJECTED', reason: o.acknowledged ? 'VENUE_REJECTED_AFTER_ACK' : 'VENUE_REJECTED', detail: e.detail ?? e.reason };
    case 'submit_ambiguous': return { to: 'UNKNOWN', reason: e.reason };
    case 'venue_lost': return { to: 'UNKNOWN', reason: 'VENUE_LOST_ORDER' };
    case 'reconciled_found': {
      const filled = canon(e.filledSize);
      if (D.lt(D.from(filled), D.from(o.filledSize))) throw new IllegalTransitionError(o.state, e.type, `the venue reports ${filled} filled, less than the ${o.filledSize} already recorded`);
      const some = D.isPos(D.from(filled));
      const patch: Partial<OrderRecord> = { filledSize: filled, acknowledged: true, ...(e.venueOrderId !== undefined ? { venueOrderId: e.venueOrderId } : {}),
        ...(e.avgFillPrice !== undefined && e.avgFillPrice !== null ? { avgFillPrice: canon(e.avgFillPrice) } : {}) };
      if (e.status === 'filled') return { to: 'FILLED', reason: 'VENUE_FILLED', patch: o.size === null ? { ...patch, size: some ? filled : null } : patch };
      if (e.status === 'cancelled') return { to: 'CANCELLED', reason: some ? 'REMAINDER_CANCELLED' : o.cancelRequested ? 'CANCELLED_BY_REQUEST' : 'CANCELLED_AT_VENUE', patch };
      if (e.status === 'rejected') {
        if (some) throw new IllegalTransitionError(o.state, e.type, 'an order with executions cannot be rejected; the venue must report it cancelled or filled');
        return { to: 'REJECTED', reason: o.acknowledged ? 'VENUE_REJECTED_AFTER_ACK' : 'VENUE_REJECTED', patch };
      }
      // resting or frozen
      const to = some ? fillState(o.size, filled) : 'SUBMITTED';
      return { to, reason: to === 'FILLED' ? 'VENUE_FILLED' : e.status === 'frozen' ? 'VENUE_FROZEN' : some ? 'VENUE_FILL' : 'VENUE_RESTING', patch };
    }
    case 'reconciled_absent': {
      // an order the venue acknowledged and no longer shows is never "never placed"
      if (o.acknowledged) return { to: 'UNKNOWN', reason: 'VENUE_LOST_ORDER' };
      if (!e.supportsClientIdLookup || e.conclusiveAt === null) return { to: 'UNKNOWN', reason: 'ABSENT_UNVERIFIABLE' };
      if (now < e.conclusiveAt) return { to: 'UNKNOWN', reason: 'ABSENT_WITHIN_GRACE' };
      return { to: 'FAILED', reason: 'NEVER_PLACED' };
    }
    case 'fill': {
      if (e.fillId !== undefined && o.fillIds.includes(e.fillId)) return { to: o.state, reason: 'DUPLICATE_EVENT_IGNORED', detail: `fill ${e.fillId} was already applied` };
      const size = D.from(e.size), prev = D.from(o.filledSize), total = D.add(prev, size);
      // average price, half-even at 18 decimals: (prev·avg + size·price) / total
      const prevCost = o.avgFillPrice === null ? D.zero : D.mul(prev, D.from(o.avgFillPrice));
      const avg = D.div(D.add(prevCost, D.mul(size, D.from(e.price))), total, 18, 'half_even');
      const filled = D.str(total), to = fillState(o.size, filled);
      return { to, reason: to === 'FILLED' ? 'VENUE_FILLED' : 'VENUE_FILL', patch: { filledSize: filled, avgFillPrice: D.str(avg), acknowledged: true, fillIds: e.fillId !== undefined ? [...o.fillIds, e.fillId] : o.fillIds } };
    }
    case 'cancel_requested':
      // nothing has left: the order is withdrawn at once. Otherwise only the venue can say that it is cancelled.
      if (o.state === 'CREATED' || o.state === 'VALIDATED' || o.state === 'AWAITING_APPROVAL' || o.state === 'APPROVED') return { to: 'CANCELLED', reason: e.reason ?? 'WITHDRAWN_BEFORE_APPROVAL' };
      return { to: o.state, reason: 'CANCEL_REQUESTED', patch: { cancelRequested: true } };
    case 'cancelled': {
      const some = D.isPos(D.from(o.filledSize));
      return { to: 'CANCELLED', reason: some ? 'REMAINDER_CANCELLED' : e.reason ?? (o.cancelRequested ? 'CANCELLED_BY_REQUEST' : 'CANCELLED_AT_VENUE'), patch: { acknowledged: true } };
    }
    case 'expired': {
      const local = o.state === 'CREATED' || o.state === 'VALIDATED' || o.state === 'AWAITING_APPROVAL' || o.state === 'APPROVED';
      if (local !== (e.source === 'local')) throw new IllegalTransitionError(o.state, e.type, local ? 'an order that never left expires locally' : 'an order at the venue expires only when the venue says so');
      return local ? { to: 'CANCELLED', reason: 'ORDER_EXPIRED' } : { to: 'CANCELLED', reason: D.isPos(D.from(o.filledSize)) ? 'REMAINDER_CANCELLED' : 'EXPIRED_AT_VENUE' };
    }
    case 'operator_resolved': return { to: 'FAILED', reason: 'OPERATOR_RESOLVED', detail: `${e.operator}: ${e.detail}` };
  }
}

/**
 * Applies one event. Throws IllegalTransitionError when the table has no entry for (state, event), or when the event's content
 * contradicts the record. Returns a NEW record and the history entry to append; the input is not modified.
 */
export function transition(order: OrderRecord, event: OrderEvent, now: number): TransitionResult {
  const o = OrderRecordSchema.parse(order), e = OrderEventSchema.parse(event);
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be a unix time in milliseconds');
  const allowed = TRANSITIONS[o.state][e.type];
  if (allowed === undefined) throw new IllegalTransitionError(o.state, e.type, isTerminal(o.state) ? 'the state is final' : undefined);
  const step = decide(o, e, now);
  if (!allowed.includes(step.to)) throw new IllegalTransitionError(o.state, e.type, `${step.to} is not a permitted outcome`);
  if ((step.to === 'FILLED' || step.to === 'PARTIALLY_FILLED') && step.to !== o.state && !VENUE_ORIGINATED_EVENTS.includes(e.type)) throw new IllegalTransitionError(o.state, e.type, 'only a venue-originated event fills an order');
  const detail = step.detail !== undefined ? step.detail : 'detail' in e && e.detail !== undefined ? e.detail : null;
  const next: OrderRecord = { ...o, ...step.patch, state: step.to, reason: step.reason, detail, updatedAt: Math.max(now, o.updatedAt), version: o.version + 1 };
  return { order: next, entry: { orderId: o.id, seq: next.version, from: o.state, to: step.to, event: e.type, at: now, reason: step.reason, detail } };
}

/** replays events from a fresh order: the record and its whole history (used by tests and by stores that rebuild a record) */
export function replay(o: { id: string; size: DecStr | null }, events: readonly { event: OrderEvent; at: number }[], createdAt: number): { order: OrderRecord; history: OrderHistoryEntry[] } {
  let order = newOrder(o, createdAt);
  const history: OrderHistoryEntry[] = [];
  for (const { event, at } of events) { const r = transition(order, event, at); order = r.order; history.push(r.entry); }
  return { order, history };
}

// ------------------------------------------------------------------------------------------------------------------ reconciliation policy

/** what a venue lets reconciliation conclude from "the venue does not know this order" */
export interface VenueReconcilePolicy {
  /** the venue answers "no such order" for a client order id it never received (not merely "not found in recent history") */
  supportsClientIdLookup: boolean;
  /** lag allowed to the venue's read side after the signed request can no longer be accepted, ms */
  absentGraceMs: number;
  /** where the two facts above are documented or measured */
  basis: string;
}
/**
 * Known policies. Hyperliquid mirrors services/api/src/derivatives/exec.ts (NEVER_PLACED_GRACE_MS = 5 000 after the action's
 * `expiresAfter`). GMX has no client order id on the venue: the transaction hash is known before sending, and absence is settled
 * by the chain (a reverted, replaced or dropped transaction is a `local_failed`), never by this rule.
 */
export const VENUE_RECONCILE: Readonly<Record<string, VenueReconcilePolicy>> = {
  hyperliquid: { supportsClientIdLookup: true, absentGraceMs: 5_000, basis: 'orderStatus by cloid; the venue refuses an action after its expiresAfter (not independently verified: docs/v6/DERIVATIVE-MANDATE.md §7)' },
  gmx: { supportsClientIdLookup: false, absentGraceMs: 0, basis: 'no client order id on-chain; the outcome is read from the transaction receipt and the EventEmitter' },
};
/**
 * The instant from which "absent" is conclusive: the time after which the venue refuses the signed request, plus the venue's
 * grace. Null when the venue cannot prove absence or when the request has no venue-enforced expiry.
 */
export function absenceConclusiveAt(policy: VenueReconcilePolicy | undefined, requestExpiresAt: number | null): number | null {
  if (!policy || !policy.supportsClientIdLookup || requestExpiresAt === null) return null;
  return requestExpiresAt + policy.absentGraceMs;
}

// ------------------------------------------------------------------------------------------------------------------ rendering

/** the transition table as Markdown, generated from TRANSITIONS (docs/V11-EXECUTION-ENGINE.md embeds it; a test compares) */
export function renderTransitionTable(): string {
  const lines = ['| From | Event | To |', '|---|---|---|'];
  for (const from of ORDER_STATES) {
    const row = TRANSITIONS[from];
    const events = ORDER_EVENT_TYPES.filter((e) => row[e] !== undefined);
    if (!events.length) { lines.push(`| \`${from}\` | — (terminal) | — |`); continue; }
    for (const e of events) lines.push(`| \`${from}\` | \`${e}\` | ${row[e]!.map((s) => `\`${s}\``).join(', ')} |`);
  }
  return lines.join('\n');
}

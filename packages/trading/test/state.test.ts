import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D } from '@spw/derivatives';
import {
  absenceConclusiveAt, AT_VENUE_STATES, canTransition, CANCEL_REASONS, FAILURE_REASONS, IllegalTransitionError, isTerminal, newOrder, nextStates, ORDER_EVENT_TYPES, ORDER_STATES, OrderEventSchema,
  OrderHistoryEntrySchema, OrderRecordSchema, REASON_CODES, REJECT_REASONS, renderTransitionTable, replay, TERMINAL_STATES, transition, TRANSITIONS, UNKNOWN_REASONS, VENUE_ORIGINATED_EVENTS, VENUE_RECONCILE,
  type OrderEvent, type OrderEventType, type OrderRecord, type OrderState,
} from '../src/index.ts';

const T0 = 1_800_000_000_000;
const fresh = (size: string | null = '1'): OrderRecord => newOrder({ id: 'order-1', size }, T0);
function run(events: OrderEvent[], size: string | null = '1'): OrderRecord {
  return replay({ id: 'order-1', size }, events.map((event, i) => ({ event, at: T0 + 1 + i })), T0).order;
}
const toSubmitting: OrderEvent[] = [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }];
const toSubmitted: OrderEvent[] = [...toSubmitting, { type: 'venue_accepted', venueOrderId: 'v-1' }];
const toUnknown: OrderEvent[] = [...toSubmitting, { type: 'submit_ambiguous', reason: 'SUBMIT_TIMEOUT' }];

/** one valid sample of every event type */
const SAMPLES: Record<OrderEventType, OrderEvent> = {
  validated: { type: 'validated' }, local_rejected: { type: 'local_rejected', reason: 'RISK_DENIED' }, local_failed: { type: 'local_failed', reason: 'SIGNER_UNREACHABLE' },
  approval_requested: { type: 'approval_requested' }, approved: { type: 'approved', by: 'owner' }, approval_expired: { type: 'approval_expired' }, submit_started: { type: 'submit_started' },
  venue_accepted: { type: 'venue_accepted', venueOrderId: 'v-1' }, venue_rejected: { type: 'venue_rejected', reason: 'insufficient margin' }, submit_ambiguous: { type: 'submit_ambiguous', reason: 'SUBMIT_NETWORK_ERROR' },
  venue_lost: { type: 'venue_lost' }, reconciled_found: { type: 'reconciled_found', status: 'resting', filledSize: '0' },
  reconciled_absent: { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 }, fill: { type: 'fill', size: '0.25', price: '100' },
  cancel_requested: { type: 'cancel_requested' }, cancelled: { type: 'cancelled' }, expired: { type: 'expired', source: 'local' }, operator_resolved: { type: 'operator_resolved', operator: 'owner', detail: 'checked by hand' },
};
/** a path of events that reaches each state from a fresh order */
const REACH: Record<OrderState, OrderEvent[]> = {
  CREATED: [], VALIDATED: [{ type: 'validated' }], AWAITING_APPROVAL: [{ type: 'validated' }, { type: 'approval_requested' }], APPROVED: toSubmitting.slice(0, 3), SUBMITTING: toSubmitting, SUBMITTED: toSubmitted,
  PARTIALLY_FILLED: [...toSubmitted, { type: 'fill', size: '0.4', price: '100', fillId: 'f1' }], FILLED: [...toSubmitted, { type: 'fill', size: '1', price: '100' }], CANCELLED: [...toSubmitted, { type: 'cancelled' }],
  REJECTED: [{ type: 'local_rejected', reason: 'RISK_DENIED' }], FAILED: [{ type: 'validated' }, { type: 'local_failed', reason: 'INTERNAL_ERROR' }], UNKNOWN: toUnknown,
};

describe('order state machine — paths', () => {
  it('reaches every state', () => { for (const s of ORDER_STATES) expect(run(REACH[s]).state).toBe(s); });
  it('manual order: created → … → filled, with a full history', () => {
    const { order, history } = replay({ id: 'o', size: '1' }, [...toSubmitted, { type: 'fill', size: '0.4', price: '100', fillId: 'a' }, { type: 'fill', size: '0.6', price: '110', fillId: 'b' }].map((event, i) => ({ event: event as OrderEvent, at: T0 + 10 * (i + 1) })), T0);
    expect(history.map((h) => `${h.from}>${h.to}`)).toEqual(['CREATED>VALIDATED', 'VALIDATED>AWAITING_APPROVAL', 'AWAITING_APPROVAL>APPROVED', 'APPROVED>SUBMITTING', 'SUBMITTING>SUBMITTED', 'SUBMITTED>PARTIALLY_FILLED', 'PARTIALLY_FILLED>FILLED']);
    expect(history.map((h) => h.reason)).toEqual(['VALIDATION_PASSED', 'APPROVAL_REQUESTED', 'APPROVED_BY_OWNER', 'SUBMIT_STARTED', 'VENUE_ACCEPTED', 'VENUE_FILL', 'VENUE_FILLED']);
    expect(history.map((h) => h.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(history.every((h) => OrderHistoryEntrySchema.safeParse(h).success && h.orderId === 'o')).toBe(true);
    expect(order).toMatchObject({ state: 'FILLED', filledSize: '1', avgFillPrice: '106', venueOrderId: 'v-1', acknowledged: true, version: 7, updatedAt: T0 + 70, createdAt: T0 });
    expect(OrderRecordSchema.safeParse(order).success).toBe(true);
  });
  it('mandate order skips the approval request; an owner approval cannot', () => {
    expect(run([{ type: 'validated' }, { type: 'approved', by: 'mandate' }])).toMatchObject({ state: 'APPROVED', reason: 'APPROVED_BY_MANDATE' });
    expect(() => run([{ type: 'validated' }, { type: 'approved', by: 'owner' }])).toThrow(IllegalTransitionError);
    expect(() => run([{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'mandate' }])).toThrow(IllegalTransitionError);
  });
  it('refusals, failures and withdrawals before anything left', () => {
    expect(run([{ type: 'local_rejected', reason: 'INVALID_ORDER', detail: 'size below the lot' }])).toMatchObject({ state: 'REJECTED', reason: 'INVALID_ORDER', detail: 'size below the lot' });
    expect(run([{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approval_expired' }])).toMatchObject({ state: 'CANCELLED', reason: 'APPROVAL_EXPIRED' });
    expect(run([{ type: 'validated' }, { type: 'approval_requested' }, { type: 'cancel_requested' }])).toMatchObject({ state: 'CANCELLED', reason: 'WITHDRAWN_BEFORE_APPROVAL' });
    expect(run([{ type: 'validated' }, { type: 'cancel_requested', reason: 'HALTED_BEFORE_APPROVAL' }])).toMatchObject({ state: 'CANCELLED', reason: 'HALTED_BEFORE_APPROVAL' });
    expect(run([...toSubmitting.slice(0, 3), { type: 'local_rejected', reason: 'SIGNER_REFUSED' }])).toMatchObject({ state: 'REJECTED', reason: 'SIGNER_REFUSED' });
    expect(run([...toSubmitting.slice(0, 3), { type: 'local_failed', reason: 'SIGNER_UNREACHABLE' }])).toMatchObject({ state: 'FAILED', reason: 'SIGNER_UNREACHABLE' });
    expect(run([{ type: 'validated' }, { type: 'expired', source: 'local' }])).toMatchObject({ state: 'CANCELLED', reason: 'ORDER_EXPIRED' });
  });
  it('venue refusal: before and after an acknowledgement', () => {
    expect(run([...toSubmitting, { type: 'venue_rejected', reason: 'insufficient margin' }])).toMatchObject({ state: 'REJECTED', reason: 'VENUE_REJECTED', detail: 'insufficient margin' });
    expect(run([...toSubmitted, { type: 'venue_rejected', reason: 'keeper cancelled' }])).toMatchObject({ state: 'REJECTED', reason: 'VENUE_REJECTED_AFTER_ACK' });
  });
  it('cancel at the venue: requested, then confirmed by the venue only', () => {
    const asked = run([...toSubmitted, { type: 'cancel_requested' }]);
    expect(asked).toMatchObject({ state: 'SUBMITTED', cancelRequested: true, reason: 'CANCEL_REQUESTED' });
    expect(transition(asked, { type: 'cancelled' }, T0 + 99).order).toMatchObject({ state: 'CANCELLED', reason: 'CANCELLED_BY_REQUEST' });
    expect(run([...toSubmitted, { type: 'cancelled' }])).toMatchObject({ state: 'CANCELLED', reason: 'CANCELLED_AT_VENUE' });
    expect(run([...toSubmitted, { type: 'fill', size: '0.4', price: '100' }, { type: 'cancelled' }])).toMatchObject({ state: 'CANCELLED', reason: 'REMAINDER_CANCELLED', filledSize: '0.4' });
    expect(run([...toSubmitted, { type: 'fill', size: '0.4', price: '100' }, { type: 'cancel_requested' }])).toMatchObject({ state: 'PARTIALLY_FILLED', cancelRequested: true, filledSize: '0.4' });
    expect(run([...toUnknown, { type: 'cancel_requested' }])).toMatchObject({ state: 'UNKNOWN', cancelRequested: true });
    expect(run([...toSubmitted, { type: 'expired', source: 'venue' }])).toMatchObject({ state: 'CANCELLED', reason: 'EXPIRED_AT_VENUE' });
    expect(() => run([...toSubmitted, { type: 'expired', source: 'local' }])).toThrow(IllegalTransitionError);
    expect(() => run([{ type: 'validated' }, { type: 'expired', source: 'venue' }])).toThrow(IllegalTransitionError);
  });
});

describe('order state machine — ambiguity and reconciliation', () => {
  it('an ambiguous submission is UNKNOWN, never FAILED', () => {
    for (const reason of ['SUBMIT_TIMEOUT', 'SUBMIT_NETWORK_ERROR', 'SUBMIT_UNREADABLE_ANSWER', 'INTERRUPTED_AFTER_SIGNING', 'RECEIPT_OVERDUE'] as const)
      expect(run([...toSubmitting, { type: 'submit_ambiguous', reason }])).toMatchObject({ state: 'UNKNOWN', reason });
    expect(TRANSITIONS.SUBMITTING.submit_ambiguous).toEqual(['UNKNOWN']);
  });
  it('UNKNOWN cannot be closed by a local event', () => {
    for (const e of ['local_rejected', 'local_failed', 'expired', 'approval_expired', 'validated', 'submit_started'] as const) expect(canTransition('UNKNOWN', e)).toBe(false);
  });
  it('reconciled_found settles an unknown order from the venue\'s own records', () => {
    const u = run(toUnknown);
    expect(transition(u, { type: 'reconciled_found', status: 'resting', filledSize: '0', venueOrderId: 'v-9' }, T0 + 50).order).toMatchObject({ state: 'SUBMITTED', venueOrderId: 'v-9', acknowledged: true, reason: 'VENUE_RESTING' });
    expect(transition(u, { type: 'reconciled_found', status: 'resting', filledSize: '0.3', avgFillPrice: '101' }, T0 + 50).order).toMatchObject({ state: 'PARTIALLY_FILLED', filledSize: '0.3', avgFillPrice: '101' });
    expect(transition(u, { type: 'reconciled_found', status: 'resting', filledSize: '1' }, T0 + 50).order.state).toBe('FILLED');
    expect(transition(u, { type: 'reconciled_found', status: 'filled', filledSize: '1' }, T0 + 50).order).toMatchObject({ state: 'FILLED', reason: 'VENUE_FILLED' });
    expect(transition(u, { type: 'reconciled_found', status: 'cancelled', filledSize: '0' }, T0 + 50).order).toMatchObject({ state: 'CANCELLED', reason: 'CANCELLED_AT_VENUE' });
    expect(transition(u, { type: 'reconciled_found', status: 'cancelled', filledSize: '0.2' }, T0 + 50).order).toMatchObject({ state: 'CANCELLED', reason: 'REMAINDER_CANCELLED', filledSize: '0.2' });
    expect(transition(u, { type: 'reconciled_found', status: 'rejected', filledSize: '0' }, T0 + 50).order).toMatchObject({ state: 'REJECTED', reason: 'VENUE_REJECTED' });
    expect(transition(u, { type: 'reconciled_found', status: 'frozen', filledSize: '0' }, T0 + 50).order).toMatchObject({ state: 'SUBMITTED', reason: 'VENUE_FROZEN' });
    expect(() => transition(u, { type: 'reconciled_found', status: 'rejected', filledSize: '0.2' }, T0 + 50)).toThrow(/cannot be rejected/);
  });
  it('a notional order (no size) is FILLED only when the venue says so', () => {
    const o = run([...toSubmitted, { type: 'fill', size: '5', price: '100' }], null);
    expect(o.state).toBe('PARTIALLY_FILLED');
    expect(transition(o, { type: 'reconciled_found', status: 'filled', filledSize: '5' }, T0 + 50).order).toMatchObject({ state: 'FILLED', size: '5' });
  });
  it('the venue never reports less filled than recorded', () => {
    const o = run([...toSubmitted, { type: 'fill', size: '0.4', price: '100' }]);
    expect(() => transition(o, { type: 'reconciled_found', status: 'resting', filledSize: '0.3' }, T0 + 50)).toThrow(IllegalTransitionError);
  });
  describe('reconciled_absent → FAILED only with a client-id lookup, no acknowledgement, and after the grace', () => {
    const u = () => run(toUnknown);
    it('before the conclusive time: stays UNKNOWN', () => {
      expect(transition(u(), { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 + 10_000 }, T0 + 9_999).order).toMatchObject({ state: 'UNKNOWN', reason: 'ABSENT_WITHIN_GRACE' });
    });
    it('at the conclusive time: FAILED, never placed', () => {
      expect(transition(u(), { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 + 10_000 }, T0 + 10_000).order).toMatchObject({ state: 'FAILED', reason: 'NEVER_PLACED' });
    });
    it('a venue without a lookup by client id never concludes', () => {
      expect(transition(u(), { type: 'reconciled_absent', supportsClientIdLookup: false, conclusiveAt: T0 }, T0 + 10 ** 9).order).toMatchObject({ state: 'UNKNOWN', reason: 'ABSENT_UNVERIFIABLE' });
      expect(transition(u(), { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: null }, T0 + 10 ** 9).order).toMatchObject({ state: 'UNKNOWN', reason: 'ABSENT_UNVERIFIABLE' });
    });
    it('an acknowledged order that disappears is UNKNOWN, never "never placed"', () => {
      const lost = run([...toSubmitted, { type: 'venue_lost' }]);
      expect(lost).toMatchObject({ state: 'UNKNOWN', reason: 'VENUE_LOST_ORDER', acknowledged: true });
      expect(transition(lost, { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 }, T0 + 10 ** 9).order).toMatchObject({ state: 'UNKNOWN', reason: 'VENUE_LOST_ORDER' });
      expect(transition(run(toSubmitted), { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 }, T0 + 10 ** 9).order.state).toBe('UNKNOWN');
    });
    it('a crash between signing and sending (still SUBMITTING) follows the same rule', () => {
      expect(transition(run(toSubmitting), { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 + 5 }, T0 + 4).order.state).toBe('UNKNOWN');
      expect(transition(run(toSubmitting), { type: 'reconciled_absent', supportsClientIdLookup: true, conclusiveAt: T0 + 5 }, T0 + 5).order.state).toBe('FAILED');
    });
    it('absenceConclusiveAt: request expiry + the venue\'s grace, or null', () => {
      expect(absenceConclusiveAt(VENUE_RECONCILE['hyperliquid'], T0)).toBe(T0 + 5_000);
      expect(absenceConclusiveAt(VENUE_RECONCILE['gmx'], T0)).toBeNull();
      expect(absenceConclusiveAt(VENUE_RECONCILE['hyperliquid'], null)).toBeNull();
      expect(absenceConclusiveAt(undefined, T0)).toBeNull();
    });
  });
  it('an operator can close an unknown order as FAILED, and only an unknown one', () => {
    expect(transition(run(toUnknown), SAMPLES.operator_resolved, T0 + 9).order).toMatchObject({ state: 'FAILED', reason: 'OPERATOR_RESOLVED', detail: 'owner: checked by hand' });
    for (const s of ORDER_STATES) if (s !== 'UNKNOWN') expect(canTransition(s, 'operator_resolved')).toBe(false);
  });
});

describe('order state machine — fills', () => {
  it('accumulates size and the average price exactly', () => {
    const o = run([...toSubmitted, { type: 'fill', size: '0.25', price: '100' }, { type: 'fill', size: '0.25', price: '103' }, { type: 'fill', size: '0.5', price: '101' }]);
    expect(o).toMatchObject({ state: 'FILLED', filledSize: '1', avgFillPrice: '101.25' });
  });
  it('ignores a fill id already applied, and records that it did', () => {
    const o = run([...toSubmitted, { type: 'fill', size: '0.25', price: '100', fillId: 'f1' }]);
    const again = transition(o, { type: 'fill', size: '0.25', price: '100', fillId: 'f1' }, T0 + 99);
    expect(again.order).toMatchObject({ state: 'PARTIALLY_FILLED', filledSize: '0.25', reason: 'DUPLICATE_EVENT_IGNORED' });
    expect(again.entry).toMatchObject({ from: 'PARTIALLY_FILLED', to: 'PARTIALLY_FILLED', event: 'fill', reason: 'DUPLICATE_EVENT_IGNORED' });
  });
  it('a fill that arrives before the answer of the submission proves the order', () => {
    expect(run([...toSubmitting, { type: 'fill', size: '1', price: '100' }])).toMatchObject({ state: 'FILLED', acknowledged: true });
    expect(run([...toUnknown, { type: 'fill', size: '0.1', price: '100' }]).state).toBe('PARTIALLY_FILLED');
  });
  it('an overfill reported by the venue is recorded as the venue reports it', () => {
    expect(run([...toSubmitted, { type: 'fill', size: '1.5', price: '100' }])).toMatchObject({ state: 'FILLED', filledSize: '1.5' });
  });
});

describe('order state machine — the table', () => {
  it('terminal states are final', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'FAILED', 'FILLED', 'REJECTED']);
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true); expect(Object.keys(TRANSITIONS[s])).toEqual([]);
      for (const e of ORDER_EVENT_TYPES) expect(() => transition(run(REACH[s]), SAMPLES[e], T0 + 999)).toThrow(IllegalTransitionError);
    }
    for (const s of ORDER_STATES) if (!TERMINAL_STATES.includes(s)) expect(Object.keys(TRANSITIONS[s]).length).toBeGreaterThan(0);
  });
  it('every (state, event) outside the table throws, every one inside lands on a listed state', () => {
    for (const s of ORDER_STATES) for (const e of ORDER_EVENT_TYPES) {
      const o = run(REACH[s]);
      if (!canTransition(s, e)) { expect(() => transition(o, SAMPLES[e], T0 + 999)).toThrow(IllegalTransitionError); expect(nextStates(s, e)).toEqual([]); continue; }
      try { expect(nextStates(s, e)).toContain(transition(o, SAMPLES[e], T0 + 999).order.state); } catch (err) {
        // a sample whose CONTENT does not fit the state (e.g. an owner approval of a validated order) is refused with a reason, never with "not a permitted outcome"
        expect(err).toBeInstanceOf(IllegalTransitionError); expect((err as Error).message).not.toMatch(/not a permitted outcome/);
      }
    }
  });
  it('only venue-originated events lead to PARTIALLY_FILLED or FILLED', () => {
    for (const s of ORDER_STATES) for (const e of ORDER_EVENT_TYPES) {
      const to = TRANSITIONS[s][e] ?? [];
      // entering a filled state (a cancel request leaves a partially filled order where it is: not an entry)
      if (to.some((t) => (t === 'FILLED' || t === 'PARTIALLY_FILLED') && t !== s) || (to.includes('PARTIALLY_FILLED') && e !== 'cancel_requested')) { expect(VENUE_ORIGINATED_EVENTS).toContain(e); expect(['fill', 'reconciled_found']).toContain(e); expect(AT_VENUE_STATES).toContain(s); }
    }
  });
  it('FAILED is reached from an at-venue state only by proof of absence, a local proof, or an operator', () => {
    for (const s of ['SUBMITTED', 'PARTIALLY_FILLED'] as const) for (const e of ORDER_EVENT_TYPES) expect(TRANSITIONS[s][e] ?? []).not.toContain('FAILED');
    expect(ORDER_EVENT_TYPES.filter((e) => (TRANSITIONS.UNKNOWN[e] ?? []).includes('FAILED')).sort()).toEqual(['operator_resolved', 'reconciled_absent']);
  });
  it('every state and every event appears in the table and in its rendering', () => {
    const md = renderTransitionTable();
    for (const s of ORDER_STATES) expect(md).toContain(`\`${s}\``);
    for (const e of ORDER_EVENT_TYPES) { expect(ORDER_STATES.some((s) => canTransition(s, e))).toBe(true); expect(md).toContain(`\`${e}\``); }
    expect(md.split('\n').length).toBe(2 + ORDER_STATES.reduce((n, s) => n + Math.max(1, Object.keys(TRANSITIONS[s]).length), 0));
  });
  it('reason codes are a closed, duplicate-free enum, and each group leads where it says', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const s of ORDER_STATES) for (const e of ORDER_EVENT_TYPES) {
      if (!canTransition(s, e)) continue;
      let r; try { r = transition(run(REACH[s]), SAMPLES[e], T0 + 999).order; } catch { continue; }
      expect(REASON_CODES).toContain(r.reason);
      if (r.state === 'REJECTED') expect(REJECT_REASONS).toContain(r.reason);
      if (r.state === 'FAILED') expect(FAILURE_REASONS).toContain(r.reason);
      if (r.state === 'CANCELLED') expect(CANCEL_REASONS).toContain(r.reason);
      if (r.state === 'UNKNOWN' && r.reason !== 'CANCEL_REQUESTED') expect(UNKNOWN_REASONS).toContain(r.reason);
    }
  });
  it('refuses malformed events, records and clocks', () => {
    expect(() => transition(fresh(), { type: 'nope' } as unknown as OrderEvent, T0)).toThrow();
    expect(() => transition(fresh(), { type: 'local_rejected', reason: 'because' } as unknown as OrderEvent, T0)).toThrow();
    expect(() => transition(fresh(), { type: 'local_rejected', reason: 'VENUE_REJECTED' } as unknown as OrderEvent, T0)).toThrow();
    expect(() => transition(fresh(), { type: 'local_failed', reason: 'NEVER_PLACED' } as unknown as OrderEvent, T0)).toThrow();
    expect(() => transition({ ...fresh(), state: 'DONE' } as unknown as OrderRecord, { type: 'validated' }, T0)).toThrow();
    expect(() => transition(fresh(), { type: 'validated' }, Number.NaN)).toThrow(RangeError);
    expect(OrderEventSchema.safeParse({ type: 'fill', size: '0', price: '1' }).success).toBe(false);
    expect(OrderEventSchema.safeParse({ type: 'fill', size: '1', price: '1', extra: true }).success).toBe(false);
  });
  it('does not mutate its input', () => {
    const o = Object.freeze({ ...run(toSubmitted), fillIds: Object.freeze([]) as unknown as string[] });
    const before = JSON.stringify(o);
    transition(o, { type: 'fill', size: '0.1', price: '100', fillId: 'x' }, T0 + 99);
    expect(JSON.stringify(o)).toBe(before);
  });
});

describe('order state machine — properties', () => {
  const dec = fc.integer({ min: 1, max: 2000 }).map((n) => D.str(D.div(D.from(BigInt(n)), D.from(1000n), 3, 'down')));
  const event: fc.Arbitrary<OrderEvent> = fc.oneof(
    ...ORDER_EVENT_TYPES.filter((t) => t !== 'fill' && t !== 'reconciled_found' && t !== 'reconciled_absent' && t !== 'approved' && t !== 'expired').map((t) => fc.constant(SAMPLES[t])),
    fc.record({ type: fc.constant('fill' as const), size: dec, price: dec, fillId: fc.option(fc.constantFrom('a', 'b', 'c'), { nil: undefined }) }).map((e) => (e.fillId === undefined ? { type: e.type, size: e.size, price: e.price } : e)),
    fc.record({ type: fc.constant('reconciled_found' as const), status: fc.constantFrom('resting' as const, 'frozen' as const, 'filled' as const, 'cancelled' as const, 'rejected' as const), filledSize: fc.oneof(fc.constant('0'), dec) }),
    fc.record({ type: fc.constant('reconciled_absent' as const), supportsClientIdLookup: fc.boolean(), conclusiveAt: fc.option(fc.integer({ min: T0, max: T0 + 100 }), { nil: null }) }),
    fc.record({ type: fc.constant('approved' as const), by: fc.constantFrom('owner' as const, 'mandate' as const) }),
    fc.record({ type: fc.constant('expired' as const), source: fc.constantFrom('local' as const, 'venue' as const) }),
  );
  it('a venue answer "filled" with nothing executed is refused, not recorded as a fill (found by the property test, seed 1568288699)', () => {
    let o = newOrder({ id: 'z', size: '1' }, T0);
    o = transition(o, { type: 'validated' }, T0 + 1).order;
    o = transition(o, { type: 'approved', by: 'mandate' }, T0 + 2).order;
    o = transition(o, { type: 'submit_started' }, T0 + 3).order;
    expect(() => transition(o, { type: 'reconciled_found', status: 'filled', filledSize: '0' }, T0 + 4)).toThrow(IllegalTransitionError);
    expect(o.state).toBe('SUBMITTING');
  });
  it('any sequence of events keeps the invariants; an illegal one throws and changes nothing', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), fc.option(dec, { nil: null }), (events, size) => {
      let o = newOrder({ id: 'p', size }, T0), at = T0;
      const history: { from: OrderState; to: OrderState }[] = [];
      for (const e of events) {
        at += 1;
        const before = JSON.stringify(o);
        let r;
        try { r = transition(o, e, at); } catch (err) {
          expect(err).toBeInstanceOf(IllegalTransitionError);
          expect((err as Error).message).not.toMatch(/not a permitted outcome|only a venue-originated/);
          expect(JSON.stringify(o)).toBe(before);
          continue;
        }
        expect(JSON.stringify(o)).toBe(before);                                        // input untouched
        expect(isTerminal(o.state)).toBe(false);                                        // nothing leaves a terminal state
        expect(nextStates(o.state, e.type)).toContain(r.order.state);                   // the table is the law
        expect(r.entry).toMatchObject({ from: o.state, to: r.order.state, event: e.type, at, seq: o.version + 1, reason: r.order.reason });
        expect(r.order.version).toBe(o.version + 1);
        expect(D.gte(D.from(r.order.filledSize), D.from(o.filledSize))).toBe(true);     // fills never shrink
        if (r.order.state === 'FILLED' || r.order.state === 'PARTIALLY_FILLED') { expect(D.isPos(D.from(r.order.filledSize)) || (r.order.state === 'FILLED' && r.order.size === null)).toBe(true); expect(r.order.acknowledged).toBe(true); }
        if (D.gt(D.from(r.order.filledSize), D.from(o.filledSize))) expect(VENUE_ORIGINATED_EVENTS).toContain(e.type);
        if (r.order.state === 'FAILED') expect(D.isZero(D.from(r.order.filledSize)) || r.entry.event === 'operator_resolved').toBe(true);
        if (r.order.state === 'REJECTED') expect(D.isZero(D.from(r.order.filledSize))).toBe(true);
        if (o.acknowledged) expect(r.order.acknowledged).toBe(true);
        expect(OrderRecordSchema.safeParse(r.order).success).toBe(true);
        history.push({ from: o.state, to: r.order.state });
        o = r.order;
      }
      for (let i = 1; i < history.length; i++) expect(history[i]!.from).toBe(history[i - 1]!.to);
    }), { numRuns: 500 });
  });
  it('replaying the same events gives the same record (determinism)', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 25 }), (events) => {
      const go = () => { let o = newOrder({ id: 'p', size: '1' }, T0); let at = T0; for (const e of events) { at += 1; try { o = transition(o, e, at).order; } catch { /* illegal: skipped */ } } return o; };
      expect(go()).toEqual(go());
    }), { numRuns: 200 });
  });
});

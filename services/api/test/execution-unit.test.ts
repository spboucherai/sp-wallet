// V11 execution — the pure parts, without a database: the projection of EVERY state of every engine vocabulary onto the unified
// order (only through `transition()` of @spw/trading), the limit sets and "does this change allow more", the reason codes.
import { describe, expect, it } from 'vitest';
import { GMX_OP_STATES, HL_ORDER_STATES, mapGmxOp, mapHyperliquidOrder, newOrder, ORDER_STATES, RISK_CHECK_IDS, RiskLimitsSchema, transition, type OrderEvent, type OrderRecord, type OrderState } from '@spw/trading';
import { RISK_CODES } from '@spw/derivatives';
import { advance, gmxFailure, gmxSnapshot, hyperliquidSnapshot, mapPaperOrder, nextEvent, PAPER_ORDER_STATUSES, paperSnapshot, reached, reasonOfCode } from '../src/orders/projection.ts';
import { defaultLimits, effectiveLimits, LIVE_DEFAULT_LIMITS, loosenedLimits, PAPER_DEFAULT_LIMITS } from '../src/risk/limits.ts';

const T0 = 1_780_000_000_000;
const fresh = (size: string | null = '1'): OrderRecord => newOrder({ id: 'order-0001', size }, T0);
/** a record brought to `state` by legal events only */
function at(state: OrderState): OrderRecord {
  const path: Record<OrderState, OrderEvent[]> = {
    CREATED: [], VALIDATED: [{ type: 'validated' }], AWAITING_APPROVAL: [{ type: 'validated' }, { type: 'approval_requested' }],
    APPROVED: [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }],
    SUBMITTING: [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }],
    SUBMITTED: [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }, { type: 'venue_accepted', venueOrderId: '77' }],
    PARTIALLY_FILLED: [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }, { type: 'venue_accepted', venueOrderId: '77' }, { type: 'fill', size: '0.4', price: '100', fillId: 'f1' }],
    UNKNOWN: [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }, { type: 'submit_ambiguous', reason: 'SUBMIT_TIMEOUT' }],
    FILLED: [{ type: 'validated' }, { type: 'approval_requested' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }, { type: 'venue_accepted', venueOrderId: '77' }, { type: 'fill', size: '1', price: '100', fillId: 'f1' }],
    CANCELLED: [{ type: 'cancel_requested' }], REJECTED: [{ type: 'local_rejected', reason: 'RISK_DENIED' }], FAILED: [{ type: 'local_failed', reason: 'INTERNAL_ERROR' }],
  };
  let o = fresh();
  for (const e of path[state]) o = transition(o, e, T0).order;
  expect(o.state).toBe(state);
  return o;
}
const hlRow = (state: string, o: Record<string, unknown> = {}) => ({ state, status: 'pending', final: ['filled', 'cancelled', 'rejected'].includes(state), filled: state === 'filled' ? '1' : state === 'partially_filled' ? '0.4' : '0', size: '1',
  avg_fill_price: state === 'filled' || state === 'partially_filled' ? '100' : null, venue_order_id: ['submitted', 'open', 'partially_filled', 'filled'].includes(state) ? '77' : null, reject_reason: null, origin: 'owner',
  expires_at: new Date(T0 + 90_000), ...o });

describe('projection: every engine state becomes events of the unified order', () => {
  it('Hyperliquid: each of the 11 states (and the causes hidden in reject_reason) is reached from a fresh order through transition() only', () => {
    const cases: [string, Record<string, unknown>, OrderState, string][] = [
      ['proposed', {}, 'CREATED', 'ORDER_CREATED'], ['risk_checked', {}, 'AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], ['authorized', {}, 'APPROVED', 'APPROVED_BY_OWNER'], ['authorized', { origin: 'mandate' }, 'APPROVED', 'APPROVED_BY_MANDATE'],
      ['signed', {}, 'SUBMITTING', 'SUBMIT_STARTED'], ['submitted', {}, 'SUBMITTED', 'VENUE_ACCEPTED'], ['open', {}, 'SUBMITTED', 'VENUE_ACCEPTED'], ['unknown', { reject_reason: 'no usable answer from the venue (timeout)' }, 'UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER'],
      ['unknown', { reject_reason: 'interrupted between signing and sending; being looked up' }, 'UNKNOWN', 'INTERRUPTED_AFTER_SIGNING'], ['partially_filled', {}, 'PARTIALLY_FILLED', 'VENUE_FILL'],
      ['partially_filled', { final: true }, 'CANCELLED', 'REMAINDER_CANCELLED'], ['filled', {}, 'FILLED', 'VENUE_FILLED'], ['cancelled', { venue_order_id: '77' }, 'CANCELLED', 'CANCELLED_AT_VENUE'],
      ['cancelled', { reject_reason: 'withdrawn before approval; nothing was signed' }, 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL'], ['cancelled', { reject_reason: 'withdrawn: trading was halted before approval' }, 'CANCELLED', 'HALTED_BEFORE_APPROVAL'],
      ['cancelled', { reject_reason: 'withdrawn: the venue authorization was revoked before approval' }, 'CANCELLED', 'AUTHORIZATION_REVOKED'], ['cancelled', { reject_reason: 'expired before approval; nothing was signed' }, 'CANCELLED', 'APPROVAL_EXPIRED'],
      ['rejected', { reject_reason: 'order_notional_exceeded: too large' }, 'REJECTED', 'RISK_DENIED'], ['rejected', { reject_reason: 'kill_switch_active: the kill switch is on' }, 'REJECTED', 'KILL_SWITCH_ACTIVE'],
      ['rejected', { reject_reason: 'read_only_mode: read-only mode is on' }, 'REJECTED', 'READ_ONLY_MODE'], ['rejected', { reject_reason: 'risk_denied: gross_exposure: too much' }, 'REJECTED', 'RISK_DENIED'],
      ['rejected', { reject_reason: 'not signed: refused' }, 'REJECTED', 'SIGNER_REFUSED_OR_UNREACHABLE'], ['rejected', { reject_reason: 'refused by the venue (tick)' }, 'REJECTED', 'VENUE_REJECTED'],
      ['rejected', { reject_reason: 'not sent: mainnet lock' }, 'FAILED', 'NOT_SENT'], ['rejected', { reject_reason: 'interrupted while asking the signer; no signature was received' }, 'FAILED', 'SIGNER_INTERRUPTED'],
      ['rejected', { reject_reason: 'never placed: the venue has no order with this client id and the signature has expired' }, 'FAILED', 'NEVER_PLACED'],
    ];
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(HL_ORDER_STATES));                    // no state of the vocabulary is left out
    for (const [state, over, want, reason] of cases) {
      const snap = hyperliquidSnapshot(hlRow(state, over));
      const a = advance(fresh(), snap, T0 + 200_000);
      expect([a.order.state, a.order.reason, a.error], `${state} ${JSON.stringify(over)}`).toEqual([want, reason, null]);
      // the path is made of legal transitions only: replaying its events on a fresh record gives the same record
      let o = fresh();
      for (const s of a.steps) o = transition(o, s.event, T0 + 200_000).order;
      expect(o).toEqual(a.order);
      expect(advance(a.order, snap, T0 + 200_000).steps).toHaveLength(0);                           // idempotent: projecting again does nothing
    }
  });

  it('a fill is only ever recorded from what the engine read at the venue; a row the engine has not settled is not final here', () => {
    const filled = advance(fresh(), hyperliquidSnapshot(hlRow('filled')), T0);
    expect(filled.steps.at(-1)!.event).toMatchObject({ type: 'reconciled_found', status: 'filled', filledSize: '1', avgFillPrice: '100' });
    expect(filled.order).toMatchObject({ state: 'FILLED', filledSize: '1', avgFillPrice: '100', acknowledged: true });
    // cancelled at the venue but the engine still waits for the fills: the unified order stays open until `final`
    const waiting = advance(at('SUBMITTED'), hyperliquidSnapshot(hlRow('cancelled', { final: false, venue_order_id: '77' })), T0);
    expect(waiting.order.state).toBe('SUBMITTED');
    const settled = advance(waiting.order, hyperliquidSnapshot(hlRow('partially_filled', { final: true })), T0);
    expect(settled.order).toMatchObject({ state: 'CANCELLED', reason: 'REMAINDER_CANCELLED', filledSize: '0.4' });
    // no local event can fill: the state machine itself refuses
    expect(() => transition(at('SUBMITTING'), { type: 'local_failed', reason: 'INTERNAL_ERROR' }, T0)).not.toThrow();
    expect(() => transition(at('UNKNOWN'), { type: 'local_failed', reason: 'INTERNAL_ERROR' }, T0)).toThrow(/illegal order transition/);
    expect(() => transition(at('FILLED'), { type: 'cancel_requested' }, T0)).toThrow(/final/);
  });

  it('"never placed" is FAILED only once the venue\'s absence is conclusive: before, the unified order stays UNKNOWN', () => {
    const row = hlRow('rejected', { reject_reason: 'never placed: the venue has no order with this client id and the signature has expired', expires_at: new Date(T0 + 30_000) });
    const snap = hyperliquidSnapshot(row);
    const early = advance(at('UNKNOWN'), snap, T0 + 31_000);                                          // inside the 5 s grace after the expiry of the signed request
    expect([early.order.state, early.order.reason]).toEqual(['UNKNOWN', 'ABSENT_WITHIN_GRACE']);
    expect(reached(early.order, snap)).toBe(true);
    const late = advance(early.order, snap, T0 + 35_000);
    expect([late.order.state, late.order.reason]).toEqual(['FAILED', 'NEVER_PLACED']);
    // an order the venue acknowledged can never become "never placed": the difference is reported, the state is not forced
    const acked = advance(at('SUBMITTED'), snap, T0 + 60_000);
    expect(acked.order.state).toBe('UNKNOWN');
    expect(acked.order.reason).toBe('VENUE_LOST_ORDER');
    expect(acked.error).toMatch(/NEVER_PLACED/);
    // GMX has no client order id at the venue: absence is never conclusive by this rule
    expect(nextEvent(at('UNKNOWN'), { ...snap, venue: 'gmx' })).toMatchObject({ type: 'reconciled_absent', supportsClientIdLookup: false, conclusiveAt: null });
  });

  it('GMX: each of the 12 operation states; a failure is classified from its text, never guessed', () => {
    const want: Record<string, [OrderState, string]> = { pending_approval: ['AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], signed: ['APPROVED', 'APPROVED_BY_OWNER'], sent: ['SUBMITTING', 'SUBMIT_STARTED'], created: ['SUBMITTED', 'VENUE_ACCEPTED'],
      frozen: ['SUBMITTED', 'VENUE_FROZEN'], executed: ['FILLED', 'VENUE_FILLED'], cancelled: ['CANCELLED', 'CANCELLED_AT_VENUE'], done: ['FILLED', 'VENUE_FILLED'], failed: ['FAILED', 'TX_REVERTED'], expired: ['CANCELLED', 'APPROVAL_EXPIRED'],
      withdrawn: ['CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL'], unknown: ['UNKNOWN', 'RECEIPT_OVERDUE'] };
    expect(Object.keys(want).sort()).toEqual([...GMX_OP_STATES].sort());
    for (const state of GMX_OP_STATES) {
      const snap = gmxSnapshot({ state, kind: 'increase', final: false, order_key: ['created', 'frozen', 'executed', 'cancelled'].includes(state) ? '0xkey' : null, error: state === 'failed' ? 'the transaction reverted on-chain' : null, expires_at: null });
      expect(snap.target.state).toBe(state === 'failed' ? 'FAILED' : mapGmxOp(state).state);
      const a = advance(fresh(null), snap, T0);
      expect([a.order.state, a.order.reason, a.error], state).toEqual([...want[state]!, null]);
    }
    expect(gmxFailure('signer hash mismatch; nothing was sent').reason).toBe('SIGNER_HASH_MISMATCH');
    expect(gmxFailure('the transaction was replaced').reason).toBe('TX_REPLACED');
    expect(gmxFailure('no OrderCreated event in the receipt').reason).toBe('NO_ORDER_EVENT');
    expect(gmxFailure('the signer refused: policy. Nothing was signed or sent.')).toMatchObject({ state: 'REJECTED', reason: 'SIGNER_REFUSED_OR_UNREACHABLE' });
    expect(gmxFailure('something else entirely')).toMatchObject({ state: 'FAILED', reason: 'INTERNAL_ERROR' });
    // an operation whose outcome was unknown and then failed on-chain: past SUBMITTING no local event may close an order — it is a venue refusal
    const late = advance(at('UNKNOWN'), gmxSnapshot({ state: 'failed', kind: 'increase', final: true, order_key: null, error: 'the transaction reverted on-chain', expires_at: null }), T0);
    expect([late.order.state, late.order.reason, late.error]).toEqual(['REJECTED', 'VENUE_REJECTED', null]);
  });

  it('paper: each of the 7 statuses; the paper engine is the venue of a paper order', () => {
    const want: Record<string, [OrderState, string]> = { pending: ['SUBMITTED', 'VENUE_ACCEPTED'], triggered: ['SUBMITTED', 'VENUE_ACCEPTED'], open: ['SUBMITTED', 'VENUE_ACCEPTED'], partially_filled: ['PARTIALLY_FILLED', 'VENUE_FILL'],
      filled: ['FILLED', 'VENUE_FILLED'], cancelled: ['CANCELLED', 'CANCELLED_AT_VENUE'], rejected: ['REJECTED', 'VENUE_REJECTED'] };
    expect(Object.keys(want).sort()).toEqual([...PAPER_ORDER_STATUSES].sort());
    for (const status of PAPER_ORDER_STATUSES) {
      const filled = status === 'filled' ? '1' : status === 'partially_filled' ? '0.4' : '0';
      const snap = paperSnapshot({ status, filled, avg_fill_price: filled === '0' ? null : '100', venue_order_id: 'p1', reject_reason: status === 'rejected' ? 'post-only would cross' : null, origin: 'owner' });
      expect(snap.target.state).toBe(mapPaperOrder(status, { filled }).state);
      const a = advance(fresh(), snap, T0);
      expect([a.order.state, a.order.reason, a.error], status).toEqual([...want[status]!, null]);
    }
    expect(mapPaperOrder('cancelled', { filled: '0.2' })).toMatchObject({ state: 'CANCELLED', reason: 'REMAINDER_CANCELLED' });
    expect(paperSnapshot({ status: 'rejected', filled: '0', reject_reason: 'kill_switch_active: on', origin: 'owner' }).target.reason).toBe('KILL_SWITCH_ACTIVE');
    // an order of the service that already stands at SUBMITTING (it called the engine) is completed, not restarted
    const cont = advance(at('SUBMITTING'), paperSnapshot({ status: 'filled', filled: '1', avg_fill_price: '100', venue_order_id: 'p1', reject_reason: null, origin: 'owner' }), T0);
    expect(cont.steps.map((s) => s.event.type)).toEqual(['reconciled_found']);
  });

  it('from every unified state, towards every engine state: the record never leaves the state machine, and a terminal record never moves', () => {
    for (const from of ORDER_STATES) {
      for (const state of HL_ORDER_STATES) {
        const snap = hyperliquidSnapshot(hlRow(state)), a = advance(at(from), snap, T0 + 200_000);
        if (['FILLED', 'CANCELLED', 'REJECTED', 'FAILED'].includes(from)) { expect(a.steps, `${from} → ${state}`).toHaveLength(0); expect(a.order).toEqual(at(from)); }
        // whatever was applied was applied by transition(): every step's `from` is the state the previous one led to
        let prev = from as string;
        for (const s of a.steps) { expect(s.entry.from).toBe(prev); prev = s.entry.to; }
        if (a.error === null) expect(reached(a.order, snap), `${from} → ${state}`).toBe(true);
      }
    }
  });
});

describe('limits', () => {
  it('live defaults leave every capital limit absent — the engine then denies new risk; paper defaults are complete', () => {
    for (const k of ['allowedVenues', 'allowedInstruments', 'maxOrderNotional', 'maxDailyNotional', 'maxPositionNotional', 'maxOrderLeverage', 'maxAccountLeverage', 'maxGrossExposure', 'maxNetExposure', 'maxAssetExposure', 'maxVenueExposure',
      'maxVenueCollateralShareBps', 'maxDailyLoss', 'maxTotalLoss', 'maxDrawdownBps'] as const) { expect(LIVE_DEFAULT_LIMITS[k], k).toBeUndefined(); if (k !== 'allowedVenues' && k !== 'allowedInstruments') expect(PAPER_DEFAULT_LIMITS[k], k).toBeDefined(); }
    expect(RiskLimitsSchema.parse(defaultLimits('live'))).toEqual(LIVE_DEFAULT_LIMITS);
    const paper = effectiveLimits('paper', {}, { venue: 'hyperliquid', instrument: 'hyperliquid:BTC' }), live = effectiveLimits('live', {}, { venue: 'hyperliquid', instrument: 'hyperliquid:BTC' });
    expect([paper.allowedVenues, paper.allowedInstruments]).toEqual([['hyperliquid'], ['hyperliquid:BTC']]);
    expect([live.allowedVenues, live.allowedInstruments]).toEqual([undefined, undefined]);
    expect(effectiveLimits('paper', { allowedInstruments: ['hyperliquid:ETH'] }, { venue: 'hyperliquid', instrument: 'hyperliquid:BTC' }).allowedInstruments).toEqual(['hyperliquid:ETH']);
    expect(RISK_CHECK_IDS.length).toBe(30);
  });

  it('loosenedLimits: which changes allow more (a missing live limit denies, so setting it is a loosening; removing it is not)', () => {
    const L = (cur: object, next: object, mode: 'paper' | 'live' = 'live') => loosenedLimits(mode, RiskLimitsSchema.parse(cur), RiskLimitsSchema.parse(next));
    expect(L({}, {})).toEqual([]);
    expect(L({}, { maxOrderNotional: '1000' })).toEqual(['maxOrderNotional']);
    expect(L({ maxOrderNotional: '1000' }, { maxOrderNotional: '500' })).toEqual([]);
    expect(L({ maxOrderNotional: '1000' }, { maxOrderNotional: '1000.01' })).toEqual(['maxOrderNotional']);
    expect(L({ maxOrderNotional: '1000' }, {})).toEqual([]);                                            // back to "denied"
    expect(L({ allowedVenues: ['hyperliquid'] }, { allowedVenues: ['hyperliquid', 'gmx'] })).toEqual(['allowedVenues']);
    expect(L({ allowedVenues: ['hyperliquid', 'gmx'] }, { allowedVenues: ['gmx'] })).toEqual([]);
    expect(L({}, { allowedInstruments: ['hyperliquid:BTC'] })).toEqual(['allowedInstruments']);
    expect(L({ allowedInstruments: ['hyperliquid:BTC'] }, {}, 'paper')).toEqual(['allowedInstruments']);  // paper: no list = every instrument
    expect(L({ minLiquidationDistanceBps: '1000' }, { minLiquidationDistanceBps: '500' })).toEqual(['minLiquidationDistanceBps']);
    expect(L({ minLiquidationDistanceBps: '500' }, { minLiquidationDistanceBps: '1500' })).toEqual([]);
    expect(L({}, { minPriceSources: 1 })).toEqual(['minPriceSources']);                               // the live default asks for 2
    expect(L({ maxPositionNotional: { per: { 'hyperliquid:BTC': '100' }, default: '50' } }, { maxPositionNotional: { per: { 'hyperliquid:BTC': '100', 'hyperliquid:ETH': '60' }, default: '50' } })).toEqual(['maxPositionNotional']);
    expect(L({ maxPositionNotional: { per: { 'hyperliquid:BTC': '100' }, default: '50' } }, { maxPositionNotional: { per: { 'hyperliquid:BTC': '90' }, default: '50' } })).toEqual([]);
    expect(L({ maxPriceAgeMs: { per: {}, default: 5_000 } }, { maxPriceAgeMs: { per: {}, default: 20_000 } })).toEqual(['maxPriceAgeMs']);
    expect(L({ minLiquidity: { withinBps: '50', multiple: '3' } }, { minLiquidity: { withinBps: '50', multiple: '2' } })).toEqual(['minLiquidity']);
    expect(L({ maxDailyLoss: '100', maxTotalLoss: '500' }, { maxDailyLoss: '100', maxTotalLoss: '501' })).toEqual(['maxTotalLoss']);
    expect(L({}, { maxOrdersPerMinute: 7 })).toEqual(['maxOrdersPerMinute']);
    expect(L({}, { maxOrdersPerMinute: 3 })).toEqual([]);
  });

  it('reasonOfCode: the engines\' refusal codes map to the closed reasons, the server locks included', () => {
    expect(reasonOfCode('mainnet_disabled').reason).toBe('VENUE_NOT_ALLOWED');
    expect(reasonOfCode('mandate_mainnet_disabled').reason).toBe('VENUE_NOT_ALLOWED');
    expect(reasonOfCode('gmx_disabled').reason).toBe('VENUE_NOT_ALLOWED');
    expect(reasonOfCode('mandate_wind_down').reason).toBe('MANDATE_DENIED');
    expect(reasonOfCode('signer_policy').reason).toBe('SIGNER_REFUSED');
    expect(reasonOfCode('kill_switch_active').reason).toBe('KILL_SWITCH_ACTIVE');
    expect(reasonOfCode('read_only_mode').reason).toBe('READ_ONLY_MODE');
    for (const c of RISK_CODES) if (c !== 'instrument_not_allowed' && c !== 'mode_read_only') expect(reasonOfCode(c).reason, c).toBe('RISK_DENIED');
    expect(reasonOfCode('whatever').reason).toBe('INVALID_ORDER');
    expect(mapHyperliquidOrder('filled', { final: true }).state).toBe('FILLED');
  });
});

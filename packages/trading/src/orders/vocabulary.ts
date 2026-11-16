/**
 * Mappings from the four state vocabularies that exist in V10 to the unified order states (state.ts).
 *
 *  1. Hyperliquid live orders   `deriv_orders.state`    services/api/src/derivatives/exec.ts  (type LiveState)
 *  2. GMX operations            `deriv_gmx_ops.state`   services/api/src/derivatives/gmx-exec.ts (type GmxOpState)
 *  3. Collateral movements      `deriv_collateral.state` services/api/src/derivatives/collateral.ts (DepositState, WithdrawState)
 *  4. Venue actions             `deriv_actions.state`   services/api/src/derivatives/exec.ts (cancels and leverage changes)
 *
 * The lists below are copied from that code (they cannot be imported: the API service is not a dependency of this package);
 * test/vocabulary.test.ts reads the four source files and fails if a vocabulary there gains or loses a member.
 *
 * The legacy vocabularies overload `rejected` and `cancelled` with several causes kept as free text. `mapHyperliquidOrder` reads
 * the exact texts exec.ts writes and returns the closed reason code; a text it does not recognise maps to LEGACY_UNSPECIFIED,
 * never to a guess.
 *
 * Collateral movements and venue actions are not orders. They map to the same states with one convention: FILLED means "the
 * effect is confirmed by the venue or the chain" and carries the reason OPERATION_COMPLETED.
 */
import { RISK_CODES } from '@spw/derivatives';
import type { OrderState, ReasonCode } from './state.ts';

export interface UnifiedState { state: OrderState; reason: ReasonCode; note: string | null }
const u = (state: OrderState, reason: ReasonCode, note: string | null = null): UnifiedState => ({ state, reason, note });

// ------------------------------------------------------------------------------------------------------------------ 1. Hyperliquid

export const HL_ORDER_STATES = ['proposed', 'risk_checked', 'authorized', 'signed', 'submitted', 'unknown', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected'] as const;
export type HlOrderState = (typeof HL_ORDER_STATES)[number];

/** the free texts exec.ts stores in `reject_reason`, by prefix or fragment → (unified state, reason code) */
const HL_REASON_TEXTS: readonly { state: 'rejected' | 'cancelled'; test: RegExp; to: UnifiedState }[] = [
  { state: 'rejected', test: /^never placed:/, to: u('FAILED', 'NEVER_PLACED') },
  { state: 'rejected', test: /^interrupted while asking the signer/, to: u('FAILED', 'SIGNER_INTERRUPTED') },
  { state: 'rejected', test: /^not sent:/, to: u('FAILED', 'NOT_SENT') },
  { state: 'rejected', test: /^not signed:/, to: u('REJECTED', 'SIGNER_REFUSED_OR_UNREACHABLE', 'exec.ts files a signer refusal and an unreachable signer under the same text') },
  { state: 'rejected', test: /^refused by the venue/, to: u('REJECTED', 'VENUE_REJECTED') },
  { state: 'rejected', test: new RegExp(`^(${RISK_CODES.join('|')}): `), to: u('REJECTED', 'RISK_DENIED', 'the text starts with a code of the derivatives risk engine (RISK_CODES)') },
  { state: 'cancelled', test: /^withdrawn before approval/, to: u('CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL') },
  { state: 'cancelled', test: /^withdrawn: trading was halted/, to: u('CANCELLED', 'HALTED_BEFORE_APPROVAL') },
  { state: 'cancelled', test: /^withdrawn: the venue authorization was revoked/, to: u('CANCELLED', 'AUTHORIZATION_REVOKED') },
  { state: 'cancelled', test: /^(the approval window expired|expired before approval)/, to: u('CANCELLED', 'APPROVAL_EXPIRED') },
  { state: 'cancelled', test: /^withdrawn: /, to: u('CANCELLED', 'DATA_INCONSISTENT_BEFORE_APPROVAL', 'withdrawn at approval because the pinned asset table no longer matched the venue') },
];

/**
 * `final` and `rejectReason` are the columns of the same row. `partially_filled` is both a resting state and (with `final`) a
 * terminal one: the remainder was cancelled.
 */
export function mapHyperliquidOrder(state: HlOrderState, row: { final: boolean; rejectReason?: string | null } = { final: false }): UnifiedState {
  const text = row.rejectReason ?? null;
  switch (state) {
    case 'proposed': return u('CREATED', 'ORDER_CREATED');
    case 'risk_checked': return u('AWAITING_APPROVAL', 'APPROVAL_REQUESTED', 'Hyperliquid has one state for VALIDATED and AWAITING_APPROVAL: the row passed the risk engine and waits for the passkey');
    case 'authorized': return u('APPROVED', 'LEGACY_UNSPECIFIED', 'means "handed to the signer": the approval is verified by the signer, not before');
    case 'signed': return u('SUBMITTING', 'SUBMIT_STARTED');
    case 'submitted': return u('SUBMITTED', 'VENUE_ACCEPTED');
    case 'open': return u('SUBMITTED', 'VENUE_RESTING');
    case 'unknown': return u('UNKNOWN', text !== null && /no longer knows/.test(text) ? 'VENUE_LOST_ORDER' : text !== null && /^interrupted between signing and sending/.test(text) ? 'INTERRUPTED_AFTER_SIGNING' : 'SUBMIT_UNREADABLE_ANSWER',
      'exec.ts does not tell a timeout from a network error or an unreadable answer');
    case 'partially_filled': return row.final ? u('CANCELLED', 'REMAINDER_CANCELLED', 'filled in part; the remainder was cancelled') : u('PARTIALLY_FILLED', 'VENUE_FILL');
    case 'filled': return u('FILLED', 'VENUE_FILLED');
    case 'cancelled':
    case 'rejected': {
      if (text !== null) for (const t of HL_REASON_TEXTS) if (t.state === state && t.test.test(text)) return t.to;
      if (state === 'cancelled') return text === null ? u('CANCELLED', 'CANCELLED_AT_VENUE', 'no reason stored: cancelled at the venue') : u('CANCELLED', 'LEGACY_UNSPECIFIED');
      return u('REJECTED', 'LEGACY_UNSPECIFIED');
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------ 2. GMX

export const GMX_OP_STATES = ['pending_approval', 'signed', 'sent', 'created', 'executed', 'cancelled', 'frozen', 'done', 'failed', 'expired', 'withdrawn', 'unknown'] as const;
export type GmxOpState = (typeof GMX_OP_STATES)[number];

/** `kind` is the operation's kind: an `increase` or `decrease` IS an order; a `cancel` operation acts on another order */
export function mapGmxOp(state: GmxOpState, kind: 'increase' | 'decrease' | 'cancel' = 'increase'): UnifiedState {
  switch (state) {
    case 'pending_approval': return u('AWAITING_APPROVAL', 'APPROVAL_REQUESTED', 'GMX stores nothing before validation: there is no CREATED or VALIDATED row');
    case 'signed': return u('APPROVED', 'LEGACY_UNSPECIFIED', 'set BEFORE the signer is called: it means "handed to the signer"');
    case 'sent': return u('SUBMITTING', 'SUBMIT_STARTED', 'the transaction was relayed; no order exists on-chain until its receipt shows OrderCreated');
    case 'created': return u('SUBMITTED', 'VENUE_ACCEPTED', 'the order exists on-chain (its key is the venue order id) and waits for a keeper');
    case 'frozen': return u('SUBMITTED', 'VENUE_FROZEN', 'GMX froze the order: it rests and can be cancelled');
    case 'executed': return u('FILLED', 'VENUE_FILLED');
    case 'cancelled': return u('CANCELLED', 'CANCELLED_AT_VENUE', 'OrderCancelled event: a keeper or the owner\'s cancel transaction cancelled it');
    case 'done': return kind === 'cancel' ? u('FILLED', 'OPERATION_COMPLETED', 'a mined cancel transaction: the operation is complete; the ORDER it targets is cancelled') : u('FILLED', 'OPERATION_COMPLETED');
    case 'failed': return u('FAILED', 'LEGACY_UNSPECIFIED', 'signer refusal, hash mismatch, reverted or replaced transaction, or no OrderCreated event: the text column tells which');
    case 'expired': return u('CANCELLED', 'APPROVAL_EXPIRED');
    case 'withdrawn': return u('CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL');
    case 'unknown': return u('UNKNOWN', 'OUTCOME_EVENT_MISSING', 'no receipt after the overdue delay, or the order left the chain without an OrderExecuted / OrderCancelled event found');
  }
}

// ------------------------------------------------------------------------------------------------------------------ 3. collateral

export const DEPOSIT_STATES = ['pending_approval', 'signed', 'sent', 'awaiting_credit', 'credited', 'failed', 'expired', 'cancelled'] as const;
export type DepositState = (typeof DEPOSIT_STATES)[number];
export const WITHDRAW_STATES = ['pending_approval', 'approved', 'signed', 'submitted', 'unknown', 'completed', 'rejected', 'failed', 'expired', 'cancelled'] as const;
export type WithdrawState = (typeof WITHDRAW_STATES)[number];

export function mapDeposit(state: DepositState): UnifiedState {
  switch (state) {
    case 'pending_approval': return u('AWAITING_APPROVAL', 'APPROVAL_REQUESTED');
    case 'signed': return u('APPROVED', 'LEGACY_UNSPECIFIED', 'set before the signer is called: "handed to the signer"');
    case 'sent': return u('SUBMITTING', 'SUBMIT_STARTED', 'the wallet transaction was relayed');
    case 'awaiting_credit': return u('SUBMITTED', 'VENUE_ACCEPTED', 'the transfer is confirmed on-chain; the venue has not credited it yet');
    case 'credited': return u('FILLED', 'OPERATION_COMPLETED', 'the venue\'s ledger shows the credit');
    case 'failed': return u('FAILED', 'LEGACY_UNSPECIFIED');
    case 'expired': return u('CANCELLED', 'APPROVAL_EXPIRED');
    case 'cancelled': return u('CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL');
  }
}

/** `error` is the row's text column: collateral.ts files "no trace after 30 minutes" under `rejected` */
export function mapWithdraw(state: WithdrawState, row: { error?: string | null } = {}): UnifiedState {
  switch (state) {
    case 'pending_approval': return u('AWAITING_APPROVAL', 'APPROVAL_REQUESTED');
    case 'approved': return u('APPROVED', 'LEGACY_UNSPECIFIED', '"handed to the signer"');
    case 'signed': return u('SUBMITTING', 'SUBMIT_STARTED');
    case 'submitted': return u('SUBMITTED', 'VENUE_ACCEPTED');
    case 'unknown': return u('UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER');
    case 'completed': return u('FILLED', 'OPERATION_COMPLETED', 'the venue\'s ledger and the wallet show the withdrawal');
    case 'rejected': return row.error !== undefined && row.error !== null && /without any trace/.test(row.error)
      ? u('FAILED', 'NEVER_PLACED', 'given up after 30 minutes without a trace in the venue\'s ledger or on the wallet')
      : u('REJECTED', 'VENUE_REJECTED');
    case 'failed': return u('FAILED', row.error !== undefined && row.error !== null && /^interrupted while asking the signer/.test(row.error) ? 'SIGNER_INTERRUPTED' : 'LEGACY_UNSPECIFIED');
    case 'expired': return u('CANCELLED', 'APPROVAL_EXPIRED');
    case 'cancelled': return u('CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL');
  }
}

// ------------------------------------------------------------------------------------------------------------------ 4. deriv_actions

export const VENUE_ACTION_STATES = ['risk_checked', 'authorized', 'signed', 'submitted', 'confirmed', 'rejected', 'unknown', 'cancelled'] as const;
export type VenueActionState = (typeof VENUE_ACTION_STATES)[number];

/** cancels and leverage changes sent to Hyperliquid (one row per signed action) */
export function mapVenueAction(state: VenueActionState): UnifiedState {
  switch (state) {
    case 'risk_checked': return u('AWAITING_APPROVAL', 'APPROVAL_REQUESTED', 'a leverage change waiting for the passkey');
    case 'authorized': return u('APPROVED', 'LEGACY_UNSPECIFIED', '"handed to the signer"; a cancel starts here (no approval: stopping never needs one)');
    case 'signed': return u('SUBMITTING', 'SUBMIT_STARTED');
    case 'submitted': return u('SUBMITTED', 'VENUE_ACCEPTED');
    case 'confirmed': return u('FILLED', 'OPERATION_COMPLETED', 'the venue\'s own setting shows the change');
    case 'rejected': return u('REJECTED', 'LEGACY_UNSPECIFIED', 'a signer refusal ("not signed: …") or a venue refusal');
    case 'unknown': return u('UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER');
    case 'cancelled': return u('CANCELLED', 'APPROVAL_EXPIRED');
  }
}

// ------------------------------------------------------------------------------------------------------------------ rendering

export const VOCABULARIES = [
  { id: 'hyperliquid', title: 'Hyperliquid live orders', table: 'deriv_orders.state', source: 'services/api/src/derivatives/exec.ts (LiveState)', states: HL_ORDER_STATES as readonly string[] },
  { id: 'gmx', title: 'GMX operations', table: 'deriv_gmx_ops.state', source: 'services/api/src/derivatives/gmx-exec.ts (GmxOpState)', states: GMX_OP_STATES as readonly string[] },
  { id: 'deposit', title: 'Collateral deposits', table: 'deriv_collateral.state (kind = deposit)', source: 'services/api/src/derivatives/collateral.ts (DepositState)', states: DEPOSIT_STATES as readonly string[] },
  { id: 'withdraw', title: 'Collateral withdrawals', table: 'deriv_collateral.state (kind = withdraw)', source: 'services/api/src/derivatives/collateral.ts (WithdrawState)', states: WITHDRAW_STATES as readonly string[] },
  { id: 'action', title: 'Venue actions (cancel, leverage)', table: 'deriv_actions.state', source: 'services/api/src/derivatives/exec.ts (act, approveLeverage)', states: VENUE_ACTION_STATES as readonly string[] },
] as const;

function row(legacy: string, m: UnifiedState): string { return `| \`${legacy}\` | \`${m.state}\` | \`${m.reason}\` | ${m.note ?? ''} |`; }
/** the mapping tables as Markdown, generated from the functions above (embedded in docs/V11-EXECUTION-ENGINE.md) */
export function renderVocabularyTables(): string {
  const head = ['| Legacy state | Unified state | Reason code | Note |', '|---|---|---|---|'];
  const out: string[] = [];
  out.push(`#### ${VOCABULARIES[0].title} — \`${VOCABULARIES[0].table}\`, ${VOCABULARIES[0].source}`, '', ...head);
  for (const s of HL_ORDER_STATES) {
    if (s === 'partially_filled') { out.push(row('partially_filled (final = false)', mapHyperliquidOrder(s, { final: false })), row('partially_filled (final = true)', mapHyperliquidOrder(s, { final: true }))); continue; }
    out.push(row(s, mapHyperliquidOrder(s, { final: s === 'filled' || s === 'cancelled' || s === 'rejected' })));
  }
  out.push('', 'Causes hidden in `reject_reason` (the texts `exec.ts` writes), told apart by `mapHyperliquidOrder`:', '', '| Legacy state | Text matches | Unified state | Reason code |', '|---|---|---|---|');
  for (const t of HL_REASON_TEXTS) out.push(`| \`${t.state}\` | \`${t.test.source}\` | \`${t.to.state}\` | \`${t.to.reason}\` |`);
  out.push('', `#### ${VOCABULARIES[1].title} — \`${VOCABULARIES[1].table}\`, ${VOCABULARIES[1].source}`, '', ...head);
  for (const s of GMX_OP_STATES) out.push(row(s === 'done' ? 'done (cancel operation)' : s, mapGmxOp(s, s === 'done' ? 'cancel' : 'increase')));
  out.push('', `#### ${VOCABULARIES[2].title} — \`${VOCABULARIES[2].table}\`, ${VOCABULARIES[2].source}`, '', ...head);
  for (const s of DEPOSIT_STATES) out.push(row(s, mapDeposit(s)));
  out.push('', `#### ${VOCABULARIES[3].title} — \`${VOCABULARIES[3].table}\`, ${VOCABULARIES[3].source}`, '', ...head);
  for (const s of WITHDRAW_STATES) out.push(row(s, mapWithdraw(s)));
  out.push(row('rejected (error: "… without any trace …")', mapWithdraw('rejected', { error: '30 minutes without any trace of this withdrawal' })));
  out.push('', `#### ${VOCABULARIES[4].title} — \`${VOCABULARIES[4].table}\`, ${VOCABULARIES[4].source}`, '', ...head);
  for (const s of VENUE_ACTION_STATES) out.push(row(s, mapVenueAction(s)));
  return out.join('\n');
}

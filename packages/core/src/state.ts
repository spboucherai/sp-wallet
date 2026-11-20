// `not_broadcast` (v11): signed, but deliberately NOT relayed because broadcasting is disabled on this server (SPW_BROADCAST=off).
// Terminal and honest: the row never reads as "sent", never blocks the network with "a transfer is in flight", never confirms.
//
// `dropped` (NEXT): the signed transaction was handed to the network (or a relay was attempted and never acknowledged), no
// source knows it any more, and nothing proves it can no longer be included (EVM: its nonce is still unused; Bitcoin-style:
// its coins are still unspent). It is NOT a failure and NOT terminal: the worker keeps watching it, and it becomes
// `confirming` / `finalized` if it appears after all, or `replaced` once another transaction used its nonce or its coins.
// It no longer holds the network's in-flight slot: a new send reuses that nonce / those coins, so both can never confirm.
//
// `replaced` is no longer final either: the verdict comes from public endpoints that can lag, so the worker re-checks it
// for a while and a transaction that turns out to be mined goes back to `confirming` / `finalized`.
export const STATES = ['draft', 'pending_approval', 'approved', 'signed', 'broadcast', 'confirming', 'finalized',
  'rejected', 'expired', 'failed', 'replaced', 'reorged', 'not_broadcast', 'dropped'] as const;
export type ProposalState = (typeof STATES)[number];

const NEXT: Record<ProposalState, ProposalState[]> = {
  draft: ['pending_approval', 'rejected', 'expired', 'failed'],
  pending_approval: ['approved', 'rejected', 'expired', 'failed'],
  approved: ['signed', 'failed', 'expired'],
  signed: ['broadcast', 'not_broadcast', 'failed', 'dropped'],
  broadcast: ['confirming', 'finalized', 'failed', 'replaced', 'dropped'],
  confirming: ['finalized', 'failed', 'reorged', 'replaced'],
  reorged: ['confirming', 'finalized', 'failed', 'replaced', 'dropped'],
  dropped: ['confirming', 'finalized', 'failed', 'replaced'],
  replaced: ['confirming', 'finalized'],
  finalized: [], rejected: [], expired: [], failed: [], not_broadcast: [],
};

export function canTransition(from: ProposalState, to: ProposalState): boolean {
  return NEXT[from].includes(to);
}
export function assertTransition(from: ProposalState, to: ProposalState): void {
  if (!canTransition(from, to)) throw new Error(`illegal state transition ${from} -> ${to}`);
}
/** Nothing more will happen to it. `replaced` counts as ended (the worker only re-checks it against a lagging source). */
export const isTerminal = (s: ProposalState) => NEXT[s].length === 0 || s === 'replaced';
/** States during which a network accepts no other outgoing transaction of this wallet (same nonce / sequence / coins). */
export const IN_FLIGHT: readonly ProposalState[] = ['approved', 'signed', 'broadcast'];

/**
 * The life cycle as a client shows it (NEXT) — one vocabulary for web, macOS and iOS, derived from the stored state:
 *
 *   draft → awaiting_confirmation → awaiting_signature → signed → broadcasting → pending → confirming → confirmed
 *                                                              ↘ failed · replaced · dropped · expired · rejected · not_sent
 *
 * `relayAttempted`: a relay to the network has started for a `signed` row (its outcome may be unknown).
 * `confirming`: in a block, not final yet (a reorganisation can still undo it). `confirmed` is said only of a FINAL transaction:
 * a client may treat `confirmed` as done, and nothing else.
 */
export const LIFECYCLES = ['draft', 'awaiting_confirmation', 'awaiting_signature', 'signed', 'broadcasting', 'pending', 'confirming', 'confirmed',
  'failed', 'replaced', 'dropped', 'expired', 'rejected', 'not_sent'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export function lifecycleOf(state: ProposalState, o: { relayAttempted?: boolean; errorCode?: string | null } = {}): Lifecycle {
  switch (state) {
    case 'draft': return 'draft';
    case 'pending_approval': return 'awaiting_confirmation';
    case 'approved': return 'awaiting_signature';
    case 'signed': return o.relayAttempted ? 'broadcasting' : 'signed';
    case 'broadcast': return 'pending';
    case 'confirming': case 'reorged': return 'confirming';
    case 'finalized': return 'confirmed';
    case 'replaced': return 'replaced';
    case 'dropped': return 'dropped';
    case 'expired': return 'expired';
    case 'rejected': return 'rejected';
    case 'not_broadcast': return 'not_sent';
    // the validity window of the signed transaction closed on-chain before it was included: nothing moved, nothing can
    case 'failed': return o.errorCode === 'expired_onchain' ? 'expired' : 'failed';
  }
}
/** What clients written before `dropped` existed are told (their state enums are closed): a dropped transfer reads as not done. */
export const legacyState = (s: ProposalState): Exclude<ProposalState, 'dropped'> => (s === 'dropped' ? 'failed' : s);

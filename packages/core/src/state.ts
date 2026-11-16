// `not_broadcast` (v11): signed, but deliberately NOT relayed because broadcasting is disabled on this server (SPW_BROADCAST=off).
// Terminal and honest: the row never reads as "sent", never blocks the network with "a transfer is in flight", never confirms.
export const STATES = ['draft', 'pending_approval', 'approved', 'signed', 'broadcast', 'confirming', 'finalized',
  'rejected', 'expired', 'failed', 'replaced', 'reorged', 'not_broadcast'] as const;
export type ProposalState = (typeof STATES)[number];

const NEXT: Record<ProposalState, ProposalState[]> = {
  draft: ['pending_approval', 'rejected', 'expired', 'failed'],
  pending_approval: ['approved', 'rejected', 'expired', 'failed'],
  approved: ['signed', 'failed', 'expired'],
  signed: ['broadcast', 'not_broadcast', 'failed'],
  broadcast: ['confirming', 'finalized', 'failed', 'replaced'],
  confirming: ['finalized', 'failed', 'reorged', 'replaced'],
  reorged: ['confirming', 'finalized', 'failed'],
  finalized: [], rejected: [], expired: [], failed: [], replaced: [], not_broadcast: [],
};

export function canTransition(from: ProposalState, to: ProposalState): boolean {
  return NEXT[from].includes(to);
}
export function assertTransition(from: ProposalState, to: ProposalState): void {
  if (!canTransition(from, to)) throw new Error(`illegal state transition ${from} -> ${to}`);
}
export const isTerminal = (s: ProposalState) => NEXT[s].length === 0;

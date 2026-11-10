export const STATES = ['draft', 'pending_approval', 'approved', 'signed', 'broadcast', 'confirming', 'finalized',
  'rejected', 'expired', 'failed', 'replaced', 'reorged'] as const;
export type ProposalState = (typeof STATES)[number];

const NEXT: Record<ProposalState, ProposalState[]> = {
  draft: ['pending_approval', 'rejected', 'expired', 'failed'],
  pending_approval: ['approved', 'rejected', 'expired', 'failed'],
  approved: ['signed', 'failed', 'expired'],
  signed: ['broadcast', 'failed'],
  broadcast: ['confirming', 'finalized', 'failed', 'replaced'],
  confirming: ['finalized', 'failed', 'reorged', 'replaced'],
  reorged: ['confirming', 'finalized', 'failed'],
  finalized: [], rejected: [], expired: [], failed: [], replaced: [],
};

export function canTransition(from: ProposalState, to: ProposalState): boolean {
  return NEXT[from].includes(to);
}
export function assertTransition(from: ProposalState, to: ProposalState): void {
  if (!canTransition(from, to)) throw new Error(`illegal state transition ${from} -> ${to}`);
}
export const isTerminal = (s: ProposalState) => NEXT[s].length === 0;

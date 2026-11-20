// Unified execution status (v11). One shape for a transfer, a same-network swap, a CCTP transfer, a THORChain swap, a GMX
// order transaction and every leg of a plan: an ordered list of steps, each with a state, its transaction id, its explorer
// link and its timestamps. Pure: it only reads a proposal row (the existing phase persistence — `proposals.state`,
// `pre_state`, `bridge.phase`, `xswap.phase`), so it says after a restart exactly what it said before.
//
// It is ADDITIVE: the older fields of the proposal view (`state`, `swap.approvalState`, `bridge.stage`, `xswap.stage`) are
// unchanged. Timestamps that the wallet does not record are null — never guessed.
import { getNetwork } from '@spw/core';
import type { ProposalRow } from './transfers.ts';
import { xswapView } from './xswap-state.ts';

export type ExecState = 'pending' | 'awaiting_approval' | 'signing' | 'broadcast' | 'confirming' | 'confirmed' | 'failed' | 'refunded' | 'unknown';
export type ExecStepKind = 'approval' | 'send' | 'swap' | 'burn' | 'attestation' | 'mint' | 'deposit' | 'observation' | 'outbound' | 'order';
export interface ExecStep {
  /** stable within one execution */ id: string; kind: ExecStepKind;
  /** the network the step happens on; `circle` / `thorchain` for the two off-chain waits */ network: string; provider: string | null;
  state: ExecState; txid: string | null; explorer: string | null; startedAt: string | null; endedAt: string | null;
  /** why the step is waiting or ended (a hold code, an error code) — the UI translates it */ code: string | null;
}
export interface Execution { kind: ProposalRow['kind']; state: ExecState; steps: ExecStep[]; updatedAt: string | null }

const iso = (v: Date | number | null | undefined): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());
const DEAD = ['failed', 'replaced', 'rejected', 'expired', 'not_broadcast'];
/** State of the step carried by the proposal's own transaction. */
export function mainState(state: string): ExecState {
  switch (state) {
    case 'draft': return 'pending';
    case 'pending_approval': return 'awaiting_approval';
    case 'approved': case 'signed': return 'signing';
    case 'broadcast': return 'broadcast';
    case 'confirming': case 'reorged': return 'confirming';
    case 'finalized': return 'confirmed';
    case 'failed': case 'replaced': case 'rejected': case 'expired': case 'not_broadcast': return 'failed';
    case 'dropped': return 'unknown'; // NEXT: not confirmed, not provably dead — still watched
    default: return 'unknown';
  }
}
/** One state for the whole execution: a failure or a refund wins, then the first step that is not finished. */
export function overall(steps: ExecStep[]): ExecState {
  if (steps.some((s) => s.state === 'failed')) return 'failed';
  if (steps.some((s) => s.state === 'refunded')) return 'refunded';
  return steps.find((s) => s.state !== 'confirmed')?.state ?? 'confirmed';
}

export function executionOf(p: ProposalRow): Execution {
  const kind = p.kind ?? 'transfer', n = getNetwork(p.network), dead = DEAD.includes(p.state), steps: ExecStep[] = [];
  const step = (s: Partial<ExecStep> & Pick<ExecStep, 'id' | 'kind' | 'state'>): ExecStep => ({ network: p.network, provider: null, txid: null, explorer: null, startedAt: null, endedAt: null, code: null, ...s });
  const sent = ['broadcast', 'confirming', 'reorged', 'finalized'].includes(p.state) || (p.state === 'failed' && !!p.broadcast_at);
  const provider = kind === 'bridge' ? 'cctp' : kind === 'xswap' ? 'thorchain' : kind === 'gmx' ? 'gmx' : p.swap?.provider ?? null;

  // 0. the exact-amount token approval that precedes a swap, a burn or a vault deposit, when one is needed
  const needsApproval = !!p.pre_raw || (p.state === 'pending_approval' && !!(p.swap?.needsApproval || p.bridge?.needsApproval || p.xswap?.needsApproval));
  if (needsApproval) {
    // a proposal that ended: an approval that was relayed and whose outcome was not recorded is `unknown` (never "failed" on a guess); one that never left stays `pending`
    const st: ExecState = p.pre_state === 'confirmed' ? 'confirmed'
      : dead ? (p.pre_state === 'sent' ? (/approval_reverted$/.test(p.error_code ?? '') ? 'failed' : 'unknown') : 'pending')
      : p.pre_state === 'sent' ? 'broadcast' : p.state === 'pending_approval' ? 'awaiting_approval' : 'signing';
    steps.push(step({ id: 'approval', kind: 'approval', provider, state: st, txid: p.pre_txid, explorer: p.pre_txid && p.pre_state ? n.explorerTx + p.pre_txid : null }));
  }
  // 1. the proposal's own transaction
  const mainKind: ExecStepKind = kind === 'swap' ? 'swap' : kind === 'bridge' ? 'burn' : kind === 'xswap' ? 'deposit' : kind === 'gmx' ? 'order' : 'send';
  const waitingApproval = needsApproval && !dead && p.pre_state !== 'confirmed' && ['approved', 'signed'].includes(p.state);
  steps.push(step({ id: mainKind, kind: mainKind, provider, state: waitingApproval ? 'pending' : mainState(p.state), txid: p.txid, explorer: p.txid && sent ? n.explorerTx + p.txid : null,
    startedAt: iso(p.broadcast_at), endedAt: p.state === 'finalized' ? iso(p.finalized_at) : dead ? iso(p.updated_at) : null, code: dead ? p.error_code ?? null : null }));
  const mined = ['confirming', 'reorged', 'finalized'].includes(p.state);

  // 2. CCTP: Circle's attestation, then the mint on the destination
  if (kind === 'bridge' && p.bridge) {
    const b = p.bridge, d = getNetwork(b.toNetwork), ph = b.phase, after = ['ready', 'mint_sent', 'mint_failed', 'done'].includes(ph);
    steps.push(step({ id: 'attestation', kind: 'attestation', network: 'circle', provider: 'cctp', state: after ? 'confirmed' : ph === 'attesting' && mined ? 'confirming' : 'pending',
      startedAt: iso(b.attestingSince), endedAt: null, code: !after && b.hold ? b.hold : null }));
    const mtx = b.mintTxid ?? b.mint?.txid ?? null;
    steps.push(step({ id: 'mint', kind: 'mint', network: b.toNetwork, provider: 'cctp', state: ph === 'done' ? 'confirmed' : ph === 'mint_failed' ? 'failed' : ph === 'mint_sent' ? 'broadcast' : 'pending',
      txid: mtx, explorer: mtx ? d.explorerTx + mtx : null, startedAt: iso(b.mint?.sentAt), endedAt: iso(b.doneAt), code: after && ph !== 'done' && b.hold ? b.hold : null }));
  }
  // 3. THORChain: the deposit is observed by the network, then the outbound (or the refund) is paid and seen by the wallet itself
  if (kind === 'xswap' && p.xswap) {
    const x = p.xswap, ph = x.phase, v = xswapView(p, x), seen = ['observed', 'outbound', 'received', 'refunded'].includes(ph);
    steps.push(step({ id: 'observation', kind: 'observation', network: 'thorchain', provider: 'thorchain', state: seen ? 'confirmed' : ph === 'sent' && !dead ? 'confirming' : 'pending',
      startedAt: iso(x.sentAt), endedAt: iso(x.observedAt), code: !seen && x.hold ? x.hold : null }));
    steps.push(step({ id: 'outbound', kind: 'outbound', network: x.outKind === 'refund' ? p.network : x.toNetwork, provider: 'thorchain',
      state: ph === 'received' ? 'confirmed' : ph === 'refunded' ? 'refunded' : ph === 'outbound' ? 'confirming' : 'pending',
      txid: x.outTxid ?? null, explorer: v.outExplorer, startedAt: iso(x.outboundAt), endedAt: iso(x.doneAt), code: seen && x.hold ? x.hold : null }));
  }
  return { kind, state: overall(steps), steps, updatedAt: iso(p.updated_at) };
}

/** A plan leg that has no proposal yet (or whose proposal is gone): one step, not started — or done when the plan recorded it as settled. */
export function pendingExecution(kind: 'swap' | 'bridge' | 'xswap', network: string, settled = false): Execution {
  const k: ExecStepKind = kind === 'swap' ? 'swap' : kind === 'bridge' ? 'burn' : 'deposit', state: ExecState = settled ? 'confirmed' : 'pending';
  return { kind, state, steps: [{ id: k, kind: k, network, provider: null, state, txid: null, explorer: null, startedAt: null, endedAt: null, code: null }], updatedAt: null };
}

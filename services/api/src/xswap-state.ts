// State of a native cross-chain swap (THORChain) after its source transaction is signed, and the pure rules that move it.
// No I/O here: services/api/src/xswap.ts gathers the observations and stores the result. Every step is decided only by what
// is stored and what was observed, so a swap resumes after a restart, hours later, exactly where it was.
import { formatUnits, getNetwork } from '@spw/core';
import { svHold, type SvCode, type SvParams } from './sv-texts.ts';

export type XswapPhase = 'sending' | 'sent' | 'observed' | 'outbound' | 'received' | 'refunded';
export interface XswapState {
  provider: 'thorchain'; toNetwork: string; toAsset: string; toSymbol: string; toDecimals: number;
  expectedOut: string; minOut: string; limit1e8: string; memo: string; vault: string; vaultPubKey: string; router: string | null; expiry: number;
  /** fees THORChain takes from the output, destination base units (already deducted from expectedOut and from the minimum) */
  outboundFee: string; liquidityFee: string; estimatedSeconds: number | null; slippageBps: number;
  /** who confirmed the vault when the swap was prepared (the signer asks its own operators again before signing) */
  operators: string[]; quoteOperators: string[]; churnHeight: number; vaultMembers: number;
  /** second line: what the wallet's own chain data sources say the vault holds, in the source asset (base units), and recent router activity */
  evidence: { holds: string; multiple: number; transfersOut: number | null };
  needsApproval: boolean; simulated: boolean;
  phase: XswapPhase; hold?: string | null; holdDetail?: string | null; holdCode?: string | null; holdParams?: SvParams | null; polls: number; nextAt: number;
  sentAt?: number; observedAt?: number; outboundAt?: number; doneAt?: number; refundPlanned?: boolean;
  outTxid?: string; outKind?: 'out' | 'refund'; received?: string; refunded?: string;
}
export const xswapTerminal = (b: XswapState) => b.phase === 'received' || b.phase === 'refunded';

/** What the THORNode operators agree on for the inbound transaction (at least two identical answers), reduced to what matters. */
export interface ThorStatus { observed: boolean; refundPlanned: boolean; outs: { id: string; chain: string; to: string; memo: string }[] }
/** What the wallet's OWN chain adapters say about the outbound transaction THORChain named. */
export type OutboundSeen = { amount: bigint; confirmed: boolean } | 'mismatch' | null;
export interface XswapObs {
  now: number; /** state of the source transaction */ sourceState: string;
  /** null = the operators did not agree or did not answer */ status: ThorStatus | null;
  /** only looked at while the source transaction is unconfirmed: false = the vault is no longer confirmed as active */ vaultActive?: boolean | null;
  seen?: OutboundSeen;
}
const LATE = { observe: 2 * 3600_000, outbound: 3 * 3600_000, seen: 3 * 3600_000 };
const backoff = (polls: number) => Math.min(300_000, 10_000 * Math.ceil((polls + 1) / 6));
export type XswapEvent = [type: string, data: Record<string, unknown>];

/**
 * One step. Success ('received') is reached only through `seen`: the wallet's own adapters found the outbound transaction on
 * the destination chain, paying the wallet the expected asset with THORChain's OUT memo for this very swap. A refund is
 * 'refunded', never 'received'. Nothing here ever gives up: an overdue step raises a hold for the owner and keeps looking.
 */
export function xswapNext(b0: XswapState, o: XswapObs, inTxid: string): { b: XswapState; events: XswapEvent[] } {
  let b = { ...b0 }; const events: XswapEvent[] = [];
  if (xswapTerminal(b) || b.phase === 'sending') return { b, events };
  // the detail sentence of each hold is the catalogue entry `hold_<code>` (sv-texts.ts): the UI translates the code, API clients read the English text
  const hold = (code: string, _detail?: string) => { if (b.hold !== code) events.push(['xswap.hold', { hold: code }]); b = { ...b, ...svHold(code, `hold_${code}` as SvCode) }; };
  const clear = () => { b = { ...b, hold: null, holdDetail: null, holdCode: null, holdParams: null }; };
  if (b.phase === 'sent') {
    if (o.status?.observed) { b = { ...b, phase: 'observed', observedAt: o.now, polls: 0 }; clear(); events.push(['xswap.observed', {}]); }
    else if (o.sourceState === 'broadcast' && o.vaultActive === false) hold('vault_churned', 'the vault is no longer confirmed as active and the transaction is not confirmed yet. It cannot be cancelled; THORChain still watches a retiring vault, but this is not guaranteed');
    else if (o.sourceState !== 'broadcast' && o.now - (b.sentAt ?? o.now) > LATE.observe) hold('not_observed', 'THORChain has not reported this deposit yet. Nothing is marked as received until the wallet sees the outbound transaction itself');
    else if (b.hold === 'vault_churned' && o.vaultActive) clear();
  }
  if (b.phase === 'observed' && o.status) {
    if (o.status.refundPlanned && !b.refundPlanned) b = { ...b, refundPlanned: true };
    const want = `:${inTxid}`, out = o.status.outs.find((x) => /^REFUND:/.test(x.memo) && x.memo.endsWith(want)) ?? o.status.outs.find((x) => /^OUT:/.test(x.memo) && x.memo.endsWith(want));
    if (out) { b = { ...b, phase: 'outbound', outTxid: out.id, outKind: out.memo.startsWith('REFUND:') ? 'refund' : 'out', outboundAt: o.now, polls: 0 }; clear(); events.push(['xswap.outbound', { txid: out.id, kind: b.outKind }]); }
    else if (o.now - (b.observedAt ?? o.now) > Math.max(LATE.outbound, (b.estimatedSeconds ?? 0) * 4000)) hold('outbound_late', 'THORChain has observed the deposit but has not sent the outbound transaction yet');
  }
  if (b.phase === 'outbound' && o.seen !== undefined) {
    if (o.seen === 'mismatch') hold('outbound_mismatch', 'the outbound transaction THORChain names does not pay this wallet what was expected; it is not counted as received');
    else if (o.seen && o.seen.confirmed) {
      const amount = o.seen.amount.toString();
      if (b.outKind === 'refund') { b = { ...b, phase: 'refunded', refunded: amount, doneAt: o.now }; clear(); events.push(['xswap.refunded', { txid: b.outTxid, amount }]); }
      else {
        b = { ...b, phase: 'received', received: amount, doneAt: o.now }; clear(); events.push(['xswap.received', { txid: b.outTxid, amount, minOut: b.minOut }]);
        if (o.seen.amount < BigInt(b.minOut)) hold('below_minimum', 'the amount received is below the approved minimum');
      }
    } else if (o.now - (b.outboundAt ?? o.now) > LATE.seen) hold('outbound_not_seen', 'THORChain reports an outbound transaction that the wallet\'s own data sources do not show as confirmed yet');
    else if (b.hold === 'outbound_mismatch' && o.seen === null) clear();
  }
  if (!xswapTerminal(b)) b = { ...b, polls: b.polls + 1, nextAt: o.now + backoff(b.polls) };
  return { b, events };
}

/** A cross-chain swap as shown to the owner. */
export function xswapView(p: { state: string; network: string; decimals: number; txid: string | null; pre_raw: string | null; pre_txid: string | null; pre_state: string | null }, b: XswapState) {
  const d = getNetwork(b.toNetwork), s = getNetwork(p.network);
  const stage = ['failed', 'expired', 'rejected', 'replaced'].includes(p.state) ? 'failed' : p.state === 'pending_approval' ? 'review' : ['approved', 'signed'].includes(p.state) || b.phase === 'sending' ? 'sending' : b.phase;
  const out = (v: string | undefined, dec: number) => (v !== undefined ? formatUnits(BigInt(v), dec) : null);
  return { provider: b.provider, toNetwork: b.toNetwork, toNetworkName: d.name, toSymbol: b.toSymbol, stage, phase: b.phase,
    expectedOutDisplay: formatUnits(BigInt(b.expectedOut), b.toDecimals), minOutDisplay: formatUnits(BigInt(b.minOut), b.toDecimals),
    outboundFeeDisplay: formatUnits(BigInt(b.outboundFee), b.toDecimals), liquidityFeeDisplay: formatUnits(BigInt(b.liquidityFee), b.toDecimals), estimatedSeconds: b.estimatedSeconds, slippageBps: b.slippageBps,
    vault: b.vault, vaultExplorer: s.explorerAddr + b.vault, memo: b.memo, router: b.router, operators: b.operators, quoteOperators: b.quoteOperators, vaultMembers: b.vaultMembers, churnHeight: b.churnHeight,
    evidenceMultiple: b.evidence.multiple, evidenceTransfersOut: b.evidence.transfersOut, needsApproval: b.needsApproval, simulated: b.simulated,
    approvalTxid: p.pre_txid, approvalState: p.pre_raw ? (p.pre_state ?? 'pending') : null,
    hold: b.hold ?? null, holdDetail: b.holdDetail ?? null, holdCode: b.hold ? b.holdCode ?? null : null, holdParams: b.hold ? b.holdParams ?? null : null, refundPlanned: !!b.refundPlanned,
    outTxid: b.outTxid ?? null, outKind: b.outKind ?? null, outExplorer: b.outTxid ? (b.outKind === 'refund' ? s : d).explorerTx + (getNetwork((b.outKind === 'refund' ? s : d).id).family === 'evm' ? `0x${b.outTxid.toLowerCase()}` : b.outTxid.toLowerCase()) : null,
    receivedDisplay: out(b.received, b.toDecimals), refundedDisplay: out(b.refunded, p.decimals), done: xswapTerminal(b) };
}

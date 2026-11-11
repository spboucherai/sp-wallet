// State of an any-to-any plan (V7) and the pure rules that move it. No I/O here: services/api/src/plan-exec.ts gathers the
// observations (the state of the current leg's proposal) and stores the result. Every step is decided only by what is stored
// and what was observed, so a plan resumes after a restart, days later, exactly where it was.
//
// A plan never signs, never approves and never holds funds: each leg is an ordinary proposal (swap, CCTP transfer, THORChain
// swap) created when the previous leg has SETTLED, sized on what was actually received, approved with the owner's passkey.
import type { PlanLegSpec } from '@spw/swap';

export type PlanStatus = 'active' | 'paused' | 'done' | 'stopped';
export type LegStatus = 'pending' | 'ready' | 'proposed' | 'in_flight' | 'settled';
export interface LegAttempt { proposalId: string; amountIn: string; at: number; outcome?: 'settled' | 'failed' | 'rejected' | 'expired' | 'refunded'; error?: string | null }
export interface PlanLeg {
  spec: PlanLegSpec; state: LegStatus;
  /** what the plan showed when it was started (or re-planned): base units */
  planned: { expectedIn: string; worstIn: string; expectedOut: string; worstOut: string; seconds: number | null };
  proposalId?: string | null; attempts: LegAttempt[];
  /** what really happened */
  actualIn?: string; actualOut?: string; settledAt?: number;
}
export interface PlanPause { code: string; message: string; at: number; leg: number }
export interface PlanDoc {
  id: string; state: PlanStatus; current: number; legs: PlanLeg[];
  from: { network: string; asset: string }; to: { network: string; asset: string }; amountIn: string; slippageBps: number;
  /** overall floor chosen by the owner, base units of the destination asset: the plan stops before a leg when the estimated final result is below it */
  floor: string | null;
  /** where the funds are right now (the wallet's own address, an ordinary balance) and how much of them belongs to this plan */
  holding: { network: string; asset: string; amount: string };
  pause: PlanPause | null;
  /** last estimate of the final result made before a leg (expected / worst case), base units of the destination asset */
  estimate: { expectedOut: string; worstOut: string; at: number } | null;
  replans: number; createdAt: number; updatedAt: number; doneAt?: number;
}
export type PlanEvent = [type: string, data: Record<string, unknown>];
export interface Step { plan: PlanDoc; events: PlanEvent[] }

/** What the current leg's proposal looks like, reduced to what the plan needs. */
export type LegOutcome =
  | { kind: 'waiting_approval' } | { kind: 'in_flight' }
  | { kind: 'settled'; received: bigint }
  /** the proposal ended without moving the funds forward; `returned` = a THORChain refund came back (source asset, base units) */
  | { kind: 'failed'; reason: string; outcome: 'failed' | 'rejected' | 'expired' | 'refunded'; returned?: bigint };

export interface ProposalFacts {
  state: string; kind: string; confirmations: number; minConf: number; error: string | null; out_amount: string | null;
  bridge?: { phase: string } | null; xswap?: { phase: string; received?: string; refunded?: string } | null;
}
/** Read a proposal as a leg outcome. "Settled" needs the amount actually received, read from the chain by the existing flows. */
export function legOutcome(p: ProposalFacts): LegOutcome {
  if (p.state === 'draft' || p.state === 'pending_approval') return { kind: 'waiting_approval' };
  if (p.state === 'rejected') return { kind: 'failed', outcome: 'rejected', reason: p.error ?? 'rejected by owner' };
  if (p.state === 'expired') return { kind: 'failed', outcome: 'expired', reason: p.error ?? 'expired before approval' };
  if (p.state === 'failed' || p.state === 'replaced') return { kind: 'failed', outcome: 'failed', reason: p.error ?? `the transaction ${p.state}` };
  const mined = p.state === 'finalized' || (p.state === 'confirming' && p.confirmations >= p.minConf);
  if (p.kind === 'bridge') return p.bridge?.phase === 'done' && p.out_amount !== null ? { kind: 'settled', received: BigInt(p.out_amount) } : { kind: 'in_flight' };
  if (p.kind === 'xswap') {
    if (p.xswap?.phase === 'received' && p.xswap.received !== undefined) return { kind: 'settled', received: BigInt(p.xswap.received) };
    if (p.xswap?.phase === 'refunded') return { kind: 'failed', outcome: 'refunded', reason: 'THORChain refunded the swap: the source asset came back to the wallet, less the network fees', returned: BigInt(p.xswap.refunded ?? '0') };
    return { kind: 'in_flight' };
  }
  // same-network swap: mined deep enough AND the router's own event (or the Solana balance change) was read
  if (mined && p.out_amount !== null) return { kind: 'settled', received: BigInt(p.out_amount) };
  return { kind: 'in_flight' };
}

const touch = (p: PlanDoc, now: number, patch: Partial<PlanDoc>): PlanDoc => ({ ...p, ...patch, updatedAt: now });
const setLeg = (p: PlanDoc, k: number, patch: Partial<PlanLeg>): PlanLeg[] => p.legs.map((l, i) => (i === k ? { ...l, ...patch } : l));
const lastAttempt = (l: PlanLeg, patch: Partial<LegAttempt>): LegAttempt[] => l.attempts.map((a, i) => (i === l.attempts.length - 1 ? { ...a, ...patch } : a));

/** Build a plan document from priced legs. The first leg is ready at once; nothing is prepared or signed here. */
export function planCreate(o: { id: string; from: PlanDoc['from']; to: PlanDoc['to']; amountIn: bigint; slippageBps: number; floor: bigint | null; legs: { spec: PlanLegSpec; planned: PlanLeg['planned'] }[]; now: number }): PlanDoc {
  if (o.legs.length === 0) throw new Error('a plan needs at least one leg');
  return { id: o.id, state: 'active', current: 0, from: o.from, to: o.to, amountIn: o.amountIn.toString(), slippageBps: o.slippageBps, floor: o.floor === null ? null : o.floor.toString(),
    legs: o.legs.map((l, k) => ({ spec: l.spec, planned: l.planned, state: k === 0 ? 'ready' : 'pending', attempts: [] })),
    holding: { ...o.from, amount: o.amountIn.toString() }, pause: null, estimate: null, replans: 0, createdAt: o.now, updatedAt: o.now };
}

/** The amount the current leg must be sized on: what the plan holds — never an estimate — capped by what the wallet really has. */
export function legAmount(p: PlanDoc, balance: bigint | null): bigint {
  const held = BigInt(p.holding.amount);
  return balance !== null && balance < held ? balance : held;
}

/** A proposal was created for the current leg (by the ordinary preparation code, with its own checks). */
export function planAttach(p: PlanDoc, proposalId: string, amountIn: bigint, now: number): Step {
  const l = p.legs[p.current];
  if (p.state !== 'active' || !l || l.state !== 'ready') throw new Error('the plan has no leg ready to be prepared');
  return { plan: touch(p, now, { legs: setLeg(p, p.current, { state: 'proposed', proposalId, actualIn: amountIn.toString(), attempts: [...l.attempts, { proposalId, amountIn: amountIn.toString(), at: now }] }) }),
    events: [['plan.step_prepared', { id: p.id, step: p.current + 1, proposal: proposalId, amount: amountIn.toString() }]] };
}

/** One step from the observed outcome of the current leg's proposal. Never creates anything; never skips a leg. */
export function planAdvance(p: PlanDoc, o: LegOutcome, now: number): Step {
  const k = p.current, l = p.legs[k];
  if (p.state !== 'active' || !l || (l.state !== 'proposed' && l.state !== 'in_flight')) return { plan: p, events: [] };
  if (o.kind === 'waiting_approval') return { plan: p, events: [] };
  if (o.kind === 'in_flight') return l.state === 'in_flight' ? { plan: p, events: [] } : { plan: touch(p, now, { legs: setLeg(p, k, { state: 'in_flight' }) }), events: [['plan.step_sent', { id: p.id, step: k + 1 }]] };
  if (o.kind === 'settled') {
    const legs = setLeg(p, k, { state: 'settled', actualOut: o.received.toString(), settledAt: now, attempts: lastAttempt(l, { outcome: 'settled' }) });
    const holding = { ...l.spec.to, amount: o.received.toString() };
    const events: PlanEvent[] = [['plan.step_settled', { id: p.id, step: k + 1, received: o.received.toString(), plannedExpected: l.planned.expectedOut, plannedWorst: l.planned.worstOut }]];
    if (k + 1 >= p.legs.length) return { plan: touch(p, now, { legs, holding, state: 'done', doneAt: now }), events: [...events, ['plan.done', { id: p.id, received: o.received.toString(), steps: p.legs.length }]] };
    return { plan: touch(p, now, { legs: legs.map((x, i) => (i === k + 1 ? { ...x, state: 'ready' as const } : x)), holding, current: k + 1 }),
      events: [...events, ['plan.step_ready', { id: p.id, step: k + 2, steps: p.legs.length }]] };
  }
  // the proposal ended without moving the funds forward: they are where they were (or came back, for a THORChain refund)
  const legs = setLeg(p, k, { state: 'ready', proposalId: null, attempts: lastAttempt(l, { outcome: o.outcome, error: o.reason }) });
  const holding = o.returned !== undefined ? { ...p.holding, amount: o.returned.toString() } : p.holding;
  // an approval window that simply ran out is not a failure: the leg is ready again, the plan stays active
  if (o.outcome === 'expired') return { plan: touch(p, now, { legs, holding }), events: [['plan.step_expired', { id: p.id, step: k + 1 }]] };
  return planPause(touch(p, now, { legs, holding }), o.outcome === 'rejected' ? 'refused' : o.outcome === 'refunded' ? 'refunded' : 'leg_failed', o.reason, now);
}

/** Pause: nothing more happens until the owner chooses to retry, re-plan from the asset held, or stop. */
export function planPause(p: PlanDoc, code: string, message: string, now: number): Step {
  if (p.state !== 'active') return { plan: p, events: [] };
  return { plan: touch(p, now, { state: 'paused', pause: { code, message: message.slice(0, 300), at: now, leg: p.current } }), events: [['plan.paused', { id: p.id, step: p.current + 1, code, reason: message.slice(0, 200) }]] };
}

/** "Réessayer": the same leg becomes ready again. Allowed only while no proposal of the plan is alive. */
export function planRetry(p: PlanDoc, now: number): Step {
  const l = p.legs[p.current];
  if (p.state !== 'paused' || !l || l.state !== 'ready') throw new Error('this plan cannot be retried now');
  return { plan: touch(p, now, { state: 'active', pause: null }), events: [['plan.resumed', { id: p.id, step: p.current + 1 }]] };
}

/** "Arrêter ici": final. The funds stay where they are, as an ordinary balance of the wallet. */
export function planStop(p: PlanDoc, now: number): Step {
  const l = p.legs[p.current];
  if (p.state === 'done' || p.state === 'stopped') throw new Error('this plan is already finished');
  if (l && (l.state === 'proposed' || l.state === 'in_flight')) throw new Error('a step of this plan is in progress; wait for it to finish, or cancel its approval first');
  return { plan: touch(p, now, { state: 'stopped', pause: null, doneAt: now }), events: [['plan.stopped', { id: p.id, step: p.current + 1, holding: p.holding }]] };
}

/** "Re-planifier depuis l'actif actuel": the legs not yet done are replaced by a new route from the asset held to the same destination. */
export function planReplan(p: PlanDoc, legs: { spec: PlanLegSpec; planned: PlanLeg['planned'] }[], now: number): Step {
  const l = p.legs[p.current];
  if (p.state !== 'paused' && p.state !== 'active') throw new Error('this plan is finished');
  if (!l || l.state !== 'ready') throw new Error('a step of this plan is in progress; it cannot be re-planned now');
  if (legs.length === 0) throw new Error('no route from the asset held to the destination');
  const first = legs[0]!.spec.from, last = legs[legs.length - 1]!.spec.to;
  if (first.network !== p.holding.network || first.asset.toLowerCase() !== p.holding.asset.toLowerCase()) throw new Error('the new route does not start from the asset held');
  if (last.network !== p.to.network || last.asset.toLowerCase() !== p.to.asset.toLowerCase()) throw new Error('the new route does not end at the plan\'s destination');
  const done = p.legs.slice(0, p.current).filter((x) => x.state === 'settled');
  const next: PlanLeg[] = legs.map((x, i) => ({ spec: x.spec, planned: x.planned, state: i === 0 ? 'ready' : 'pending', attempts: [] }));
  return { plan: touch(p, now, { state: 'active', pause: null, legs: [...done, ...next], current: done.length, replans: p.replans + 1 }), events: [['plan.replanned', { id: p.id, from: p.holding, steps: done.length + next.length }]] };
}

/** The overall floor, checked before each leg: true = go on. `estimate` is the expected final result from the asset held now. */
export const floorHolds = (p: PlanDoc, estimateExpectedOut: bigint): boolean => p.floor === null || estimateExpectedOut >= BigInt(p.floor);

/** Errors of a leg's preparation that say "not now" rather than "this leg cannot go": the leg stays ready, the plan stays active. */
export const TRANSIENT = new Set(['pending_tx', 'provider_unavailable', 'rpc_degraded', 'signer_unreachable', 'rate_limited', 'conflict', 'quotes_disagree', 'vault_unconfirmed']);
export const planOpen = (p: PlanDoc) => p.state === 'active' || p.state === 'paused';

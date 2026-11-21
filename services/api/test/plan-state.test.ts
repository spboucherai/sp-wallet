/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/plan-state.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// The plan saga as a pure state machine (services/api/src/plan-state.ts): a leg is prepared only when the previous one has
// settled, on what was actually received; a failed or refused leg pauses the plan; nothing is ever skipped or auto-approved.
import { describe, expect, it } from 'vitest';
import type { PlanLegSpec } from '@spw/swap';
import { floorHolds, legAmount, legOutcome, planAdvance, planAttach, planCreate, planPause, planReplan, planRetry, planStop, type PlanDoc, type ProposalFacts } from '../src/plan-state.ts';

const A = { network: 'arbitrum', asset: '0xlink' }, UA = { network: 'arbitrum', asset: '0xusdcA' }, UB = { network: 'base', asset: '0xusdcB' }, C = { network: 'base', asset: '0xcbbtc' };
const specs: PlanLegSpec[] = [{ kind: 'swap', via: 'kyberswap', from: A, to: UA }, { kind: 'bridge', via: 'cctp', from: UA, to: UB, speed: 'standard' }, { kind: 'swap', via: 'kyberswap', from: UB, to: C }];
const planned = (i: string, o: string) => ({ expectedIn: i, worstIn: i, expectedOut: o, worstOut: o, seconds: 30 });
const fresh = (floor: bigint | null = null): PlanDoc => planCreate({ id: 'p1', from: A, to: C, amountIn: 4000n, slippageBps: 50, floor, now: 1000,
  legs: [{ spec: specs[0]!, planned: planned('4000', '40') }, { spec: specs[1]!, planned: planned('40', '40') }, { spec: specs[2]!, planned: planned('40', '5') }] });
const types = (s: { events: [string, unknown][] }) => s.events.map((e) => e[0]);
const facts = (o: Partial<ProposalFacts>): ProposalFacts => ({ state: 'finalized', kind: 'swap', confirmations: 20, minConf: 12, error: null, out_amount: null, ...o });

describe('reading a proposal as a leg outcome', () => {
  it('a swap is settled only when mined deep enough AND its real output was read from the chain', () => {
    expect(legOutcome(facts({ state: 'pending_approval' }))).toEqual({ kind: 'waiting_approval' });
    for (const state of ['approved', 'signed', 'broadcast']) expect(legOutcome(facts({ state, out_amount: '39' }))).toEqual({ kind: 'in_flight' });
    expect(legOutcome(facts({ state: 'confirming', confirmations: 3, out_amount: '39' }))).toEqual({ kind: 'in_flight' });
    expect(legOutcome(facts({ state: 'confirming', confirmations: 12, out_amount: '39' }))).toEqual({ kind: 'settled', received: 39n });
    expect(legOutcome(facts({ state: 'finalized', out_amount: null }))).toEqual({ kind: 'in_flight' });       // outcome not read yet: never assumed
    expect(legOutcome(facts({ state: 'finalized', out_amount: '39' }))).toEqual({ kind: 'settled', received: 39n });
    expect(legOutcome(facts({ state: 'reorged', out_amount: '39' }))).toEqual({ kind: 'in_flight' });
  });
  it('a CCTP transfer is settled when the destination minted, not when the burn is final', () => {
    expect(legOutcome(facts({ kind: 'bridge', state: 'finalized', bridge: { phase: 'attesting' } }))).toEqual({ kind: 'in_flight' });
    expect(legOutcome(facts({ kind: 'bridge', state: 'finalized', bridge: { phase: 'mint_failed' } }))).toEqual({ kind: 'in_flight' });   // the USDC stays mintable: the bridge flow asks for the passkey
    expect(legOutcome(facts({ kind: 'bridge', state: 'finalized', bridge: { phase: 'done' }, out_amount: '39994801' }))).toEqual({ kind: 'settled', received: 39994801n });
  });
  it('a THORChain swap is settled when the wallet saw the outbound itself; a refund is a failure that brings the source asset back', () => {
    expect(legOutcome(facts({ kind: 'xswap', state: 'finalized', xswap: { phase: 'outbound' } }))).toEqual({ kind: 'in_flight' });
    expect(legOutcome(facts({ kind: 'xswap', state: 'finalized', xswap: { phase: 'received', received: '777' } }))).toEqual({ kind: 'settled', received: 777n });
    expect(legOutcome(facts({ kind: 'xswap', state: 'finalized', xswap: { phase: 'refunded', refunded: '3990' } }))).toMatchObject({ kind: 'failed', outcome: 'refunded', returned: 3990n });
  });
  it('rejected, expired and failed are told apart', () => {
    expect(legOutcome(facts({ state: 'rejected', error: 'rejected by owner' }))).toMatchObject({ kind: 'failed', outcome: 'rejected' });
    expect(legOutcome(facts({ state: 'expired' }))).toMatchObject({ kind: 'failed', outcome: 'expired' });
    expect(legOutcome(facts({ state: 'failed', error: 'the swap would revert now' }))).toEqual({ kind: 'failed', outcome: 'failed', reason: 'the swap would revert now' });
  });
});

describe('the saga', () => {
  it('walks three legs, each sized on what the previous one ACTUALLY delivered', () => {
    let p = fresh();
    expect(p.legs.map((l) => l.state)).toEqual(['ready', 'pending', 'pending']); expect(p.holding).toEqual({ ...A, amount: '4000' });
    expect(legAmount(p, 10_000n)).toBe(4000n);
    let s = planAttach(p, 'prop-1', 4000n, 1100); p = s.plan;
    expect(p.legs[0]).toMatchObject({ state: 'proposed', proposalId: 'prop-1', actualIn: '4000' });
    expect(planAdvance(p, { kind: 'waiting_approval' }, 1200).plan).toBe(p);                                       // nothing happens without the owner
    s = planAdvance(p, { kind: 'in_flight' }, 1300); p = s.plan; expect(types(s)).toEqual(['plan.step_sent']);
    expect(planAdvance(p, { kind: 'in_flight' }, 1400).events).toEqual([]);
    s = planAdvance(p, { kind: 'settled', received: 39n }, 1500); p = s.plan;                                      // 39 received where 40 was expected
    expect(types(s)).toEqual(['plan.step_settled', 'plan.step_ready']);
    expect(s.events[1]![1]).toEqual({ id: 'p1', step: 2, steps: 3 });
    expect(p).toMatchObject({ state: 'active', current: 1, holding: { ...UA, amount: '39' } });
    expect(p.legs.map((l) => l.state)).toEqual(['settled', 'ready', 'pending']);
    expect(p.legs[0]).toMatchObject({ actualIn: '4000', actualOut: '39', planned: { expectedOut: '40' } });        // planned and actual side by side
    // the second leg is sized on 39 (what the plan holds), never on the 40 of the estimate — and never on more than the wallet has
    expect(legAmount(p, 1_000n)).toBe(39n); expect(legAmount(p, 30n)).toBe(30n); expect(legAmount(p, null)).toBe(39n);
    // a leg is never prepared ahead of its turn
    expect(() => planAttach({ ...p, current: 2 }, 'x', 1n, 0)).toThrow(/no leg ready/);
    p = planAttach(p, 'prop-2', 39n, 1600).plan; p = planAdvance(p, { kind: 'settled', received: 39n }, 1700).plan;
    p = planAttach(p, 'prop-3', 39n, 1800).plan;
    s = planAdvance(p, { kind: 'settled', received: 5n }, 1900); p = s.plan;
    expect(types(s)).toEqual(['plan.step_settled', 'plan.done']);
    expect(p).toMatchObject({ state: 'done', holding: { ...C, amount: '5' }, doneAt: 1900 });
    expect(planAdvance(p, { kind: 'settled', received: 9n }, 2000).plan).toBe(p);                                  // a finished plan does not move
    expect(() => planStop(p, 0)).toThrow(/already finished/);
  });
  it('a failed leg pauses the plan; the funds are where they were; the owner chooses', () => {
    let p = planAttach(fresh(), 'prop-1', 4000n, 1).plan; p = planAdvance(p, { kind: 'settled', received: 39n }, 2).plan; p = planAttach(p, 'prop-2', 39n, 3).plan;
    const s = planAdvance(p, { kind: 'failed', outcome: 'failed', reason: 'the burn would revert now' }, 4); p = s.plan;
    expect(types(s)).toEqual(['plan.paused']);
    expect(p).toMatchObject({ state: 'paused', current: 1, holding: { ...UA, amount: '39' }, pause: { code: 'leg_failed', message: 'the burn would revert now', leg: 1 } });
    expect(p.legs[1]).toMatchObject({ state: 'ready', proposalId: null, attempts: [{ proposalId: 'prop-2', outcome: 'failed', error: 'the burn would revert now' }] });
    expect(() => planAttach(p, 'x', 1n, 5)).toThrow();                                                             // nothing is prepared while paused
    // réessayer
    const again = planRetry(p, 6).plan; expect(again).toMatchObject({ state: 'active', pause: null });
    expect(planAttach(again, 'prop-2b', 39n, 7).plan.legs[1]!.attempts.map((a) => a.proposalId)).toEqual(['prop-2', 'prop-2b']);
    // arrêter ici: final, funds stay as an ordinary balance
    const stopped = planStop(p, 8); expect(stopped.plan).toMatchObject({ state: 'stopped', holding: { ...UA, amount: '39' } }); expect(stopped.events[0]![1]).toMatchObject({ holding: { ...UA, amount: '39' } });
    expect(() => planRetry(stopped.plan, 9)).toThrow();
    // re-planifier depuis l'actif actuel: the settled leg stays, the rest is replaced by a route that starts from USDC on Arbitrum
    const other: PlanLegSpec[] = [{ kind: 'bridge', via: 'cctp', from: UA, to: UB, speed: 'fast' }, specs[2]!];
    const re = planReplan(p, other.map((spec) => ({ spec, planned: planned('39', '39') })), 10).plan;
    expect(re).toMatchObject({ state: 'active', current: 1, replans: 1, pause: null });
    expect(re.legs.map((l) => [l.state, l.spec.kind, l.spec.speed ?? null])).toEqual([['settled', 'swap', null], ['ready', 'bridge', 'fast'], ['pending', 'swap', null]]);
    expect(() => planReplan(p, [{ spec: specs[2]!, planned: planned('1', '1') }], 11)).toThrow(/does not start from the asset held/);
    expect(() => planReplan(p, [{ spec: specs[1]!, planned: planned('1', '1') }], 11)).toThrow(/does not end at the plan's destination/);
    expect(() => planReplan(p, [], 11)).toThrow(/no route/);
  });
  it('a refused approval pauses; an approval window that ran out does not; a THORChain refund pauses with what came back', () => {
    const p = planAttach(fresh(), 'prop-1', 4000n, 1).plan;
    expect(planAdvance(p, { kind: 'failed', outcome: 'rejected', reason: 'rejected by owner' }, 2).plan).toMatchObject({ state: 'paused', pause: { code: 'refused' } });
    const exp = planAdvance(p, { kind: 'failed', outcome: 'expired', reason: 'expired before approval' }, 2);
    expect(exp.plan).toMatchObject({ state: 'active', pause: null }); expect(exp.plan.legs[0]).toMatchObject({ state: 'ready', attempts: [{ outcome: 'expired' }] }); expect(types(exp)).toEqual(['plan.step_expired']);
    const ref = planAdvance(planAdvance(p, { kind: 'in_flight' }, 2).plan, { kind: 'failed', outcome: 'refunded', reason: 'refunded', returned: 3990n }, 3).plan;
    expect(ref).toMatchObject({ state: 'paused', pause: { code: 'refunded' }, holding: { ...A, amount: '3990' } });
  });
  it('cannot be stopped or re-planned while a step is in progress', () => {
    const p = planAdvance(planAttach(fresh(), 'prop-1', 4000n, 1).plan, { kind: 'in_flight' }, 2).plan;
    expect(() => planStop(p, 3)).toThrow(/in progress/);
    expect(() => planReplan(p, [{ spec: specs[0]!, planned: planned('1', '1') }], 3)).toThrow(/in progress/);
    expect(() => planRetry(p, 3)).toThrow();
    expect(planPause(planStop(fresh(), 1).plan, 'x', 'y', 2).events).toEqual([]);
  });
  it('the overall floor is checked against the estimate made before each leg', () => {
    expect(floorHolds(fresh(), 1n)).toBe(true);                       // no floor
    const p = fresh(5n);
    expect(floorHolds(p, 5n)).toBe(true); expect(floorHolds(p, 4n)).toBe(false);
    const s = planPause(p, 'floor', 'the final result estimated now is below the floor', 9);
    expect(s.plan).toMatchObject({ state: 'paused', pause: { code: 'floor', leg: 0 }, holding: { ...A, amount: '4000' } }); expect(types(s)).toEqual(['plan.paused']);
  });
  it('survives a restart: the document is plain JSON and the next step depends only on it', () => {
    let p = planAttach(fresh(4n), 'prop-1', 4000n, 1).plan;
    p = JSON.parse(JSON.stringify(p)) as PlanDoc;                     // what the database gives back after a restart, days later
    const s = planAdvance(p, { kind: 'settled', received: 41n }, 9_999_999);
    expect(s.plan).toMatchObject({ current: 1, holding: { ...UA, amount: '41' }, floor: '4' }); expect(types(s)).toEqual(['plan.step_settled', 'plan.step_ready']);
  });
});

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/vocabulary.test.ts
 * Module           : trading
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_STATES, GMX_OP_STATES, HL_ORDER_STATES, mapDeposit, mapGmxOp, mapHyperliquidOrder, mapVenueAction, mapWithdraw, ORDER_STATES, REASON_CODES, renderVocabularyTables, TERMINAL_STATES, VENUE_ACTION_STATES,
  VOCABULARIES, WITHDRAW_STATES, mapPaperOrder, PAPER_ORDER_STATUSES, type OrderState, type ReasonCode,
} from '../src/index.ts';
import { ORDER_STATUSES } from '@spw/derivatives';

const api = (f: string) => fileURLToPath(new URL(`../../../services/api/src/derivatives/${f}`, import.meta.url));
const read = (f: string) => readFileSync(api(f), 'utf8');
/** members of `export type <name> = 'a' | 'b' | …;` in a source file */
function union(src: string, name: string): string[] {
  const m = new RegExp(`export type ${name} = ([^;]+);`).exec(src);
  if (!m) throw new Error(`type ${name} not found`);
  return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}
const have = (f: string) => existsSync(api(f));
type Row = [string, OrderState, ReasonCode];

describe('legacy vocabularies are the ones in the API code', () => {
  // these read the service's source: if a vocabulary there gains or loses a state, the mapping must be revisited
  it.skipIf(!have('exec.ts'))('Hyperliquid LiveState', () => { expect(union(read('exec.ts'), 'LiveState').sort()).toEqual([...HL_ORDER_STATES].sort()); });
  it.skipIf(!have('gmx-exec.ts'))('GMX GmxOpState', () => { expect(union(read('gmx-exec.ts'), 'GmxOpState').sort()).toEqual([...GMX_OP_STATES].sort()); });
  it.skipIf(!have('collateral.ts'))('collateral DepositState and WithdrawState', () => {
    expect(union(read('collateral.ts'), 'DepositState').sort()).toEqual([...DEPOSIT_STATES].sort());
    expect(union(read('collateral.ts'), 'WithdrawState').sort()).toEqual([...WITHDRAW_STATES].sort());
  });
  it.skipIf(!have('exec.ts'))('deriv_actions states written by exec.ts', () => {
    const src = read('exec.ts');
    const written = new Set<string>();
    for (const m of src.matchAll(/update deriv_actions set state = '([a-z_]+)'/g)) written.add(m[1]!);
    for (const m of src.matchAll(/insert into deriv_actions[^`]*`/g)) for (const q of m[0].matchAll(/'([a-z_]+)'/g)) if (q[1] !== 'leverage' && q[1] !== 'cancel') written.add(q[1]!);
    // `act` and `approveLeverage` set the others through a variable: each literal must still be in the file
    for (const st of ['signed', 'submitted', 'rejected', 'unknown', 'confirmed']) if (src.includes(`'${st}'`)) written.add(st);
    expect([...written].sort()).toEqual([...VENUE_ACTION_STATES].sort());
  });
  it.skipIf(!have('exec.ts'))('the reject_reason texts the Hyperliquid mapping reads are still written by exec.ts', () => {
    const src = read('exec.ts');
    for (const text of ['never placed: ', 'interrupted while asking the signer', 'not signed: ', 'not sent', 'refused by the venue', 'withdrawn before approval', 'withdrawn: trading was halted',
      'withdrawn: the venue authorization was revoked', 'the approval window expired', 'expired before approval', 'the venue no longer knows this order', 'interrupted between signing and sending']) expect(src).toContain(text);
    expect(src).toMatch(/\$\{c\.risk\.code\}: /);
  });
  it.skipIf(!have('collateral.ts'))('the withdrawal texts are still written by collateral.ts', () => {
    expect(read('collateral.ts')).toContain('minutes without any trace');
    expect(read('collateral.ts')).toContain('interrupted while asking the signer');
  });
});

describe('Hyperliquid order states', () => {
  const rows: Row[] = [
    ['proposed', 'CREATED', 'ORDER_CREATED'], ['risk_checked', 'AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], ['authorized', 'APPROVED', 'LEGACY_UNSPECIFIED'], ['signed', 'SUBMITTING', 'SUBMIT_STARTED'],
    ['submitted', 'SUBMITTED', 'VENUE_ACCEPTED'], ['open', 'SUBMITTED', 'VENUE_RESTING'], ['unknown', 'UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER'], ['partially_filled', 'PARTIALLY_FILLED', 'VENUE_FILL'], ['filled', 'FILLED', 'VENUE_FILLED'],
    ['cancelled', 'CANCELLED', 'CANCELLED_AT_VENUE'], ['rejected', 'REJECTED', 'LEGACY_UNSPECIFIED'],
  ];
  it('covers the whole vocabulary', () => { expect(rows.map((r) => r[0]).sort()).toEqual([...HL_ORDER_STATES].sort()); });
  it.each(rows)('%s → %s (%s)', (legacy, state, reason) => { expect(mapHyperliquidOrder(legacy as (typeof HL_ORDER_STATES)[number])).toMatchObject({ state, reason }); });
  it('partially_filled with final = true is a cancelled remainder', () => { expect(mapHyperliquidOrder('partially_filled', { final: true })).toMatchObject({ state: 'CANCELLED', reason: 'REMAINDER_CANCELLED' }); });
  const texts: [('rejected' | 'cancelled' | 'unknown'), string, OrderState, ReasonCode][] = [
    ['rejected', 'leverage_exceeded: gross exposure 10 on equity 1 exceeds 3x', 'REJECTED', 'RISK_DENIED'],
    ['rejected', 'halted: trading is halted: divergence', 'REJECTED', 'RISK_DENIED'],
    ['rejected', 'the asset table of the venue changed', 'REJECTED', 'LEGACY_UNSPECIFIED'],                       // a build error: free text
    ['rejected', 'error: something', 'REJECTED', 'LEGACY_UNSPECIFIED'],                                             // not a risk code: not guessed
    ['rejected', 'not signed: signer unreachable', 'REJECTED', 'SIGNER_REFUSED_OR_UNREACHABLE'],
    ['rejected', 'not sent: local rate limit', 'FAILED', 'NOT_SENT'],
    ['rejected', 'refused by the venue: Insufficient margin', 'REJECTED', 'VENUE_REJECTED'],
    ['rejected', 'refused by the venue (rejected)', 'REJECTED', 'VENUE_REJECTED'],
    ['rejected', 'never placed: the venue has no order with this client id and the signature has expired', 'FAILED', 'NEVER_PLACED'],
    ['rejected', 'interrupted while asking the signer; no signature was received, nothing was sent', 'FAILED', 'SIGNER_INTERRUPTED'],
    ['cancelled', 'withdrawn before approval; nothing was signed', 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL'],
    ['cancelled', 'withdrawn: trading was halted before approval', 'CANCELLED', 'HALTED_BEFORE_APPROVAL'],
    ['cancelled', 'withdrawn: trading was halted before the approval (divergence); nothing was signed', 'CANCELLED', 'HALTED_BEFORE_APPROVAL'],
    ['cancelled', 'withdrawn: the venue authorization was revoked before approval', 'CANCELLED', 'AUTHORIZATION_REVOKED'],
    ['cancelled', 'the approval window expired before the passkey approval; nothing was signed', 'CANCELLED', 'APPROVAL_EXPIRED'],
    ['cancelled', 'expired before approval; nothing was signed', 'CANCELLED', 'APPROVAL_EXPIRED'],
    ['cancelled', 'withdrawn: the pinned asset table differs from the venue', 'CANCELLED', 'DATA_INCONSISTENT_BEFORE_APPROVAL'],
    ['cancelled', 'something nobody wrote', 'CANCELLED', 'LEGACY_UNSPECIFIED'],
    ['unknown', 'the venue no longer knows this order', 'UNKNOWN', 'VENUE_LOST_ORDER'],
    ['unknown', 'interrupted between signing and sending; being looked up on the venue by its client id', 'UNKNOWN', 'INTERRUPTED_AFTER_SIGNING'],
    ['unknown', 'no usable answer from the venue (timeout); the order may or may not exist', 'UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER'],
  ];
  it.each(texts)('%s with "%s" → %s (%s)', (legacy, text, state, reason) => { expect(mapHyperliquidOrder(legacy, { final: legacy !== 'unknown', rejectReason: text })).toMatchObject({ state, reason }); });
});

describe('GMX operation states', () => {
  const rows: Row[] = [
    ['pending_approval', 'AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], ['signed', 'APPROVED', 'LEGACY_UNSPECIFIED'], ['sent', 'SUBMITTING', 'SUBMIT_STARTED'], ['created', 'SUBMITTED', 'VENUE_ACCEPTED'],
    ['frozen', 'SUBMITTED', 'VENUE_FROZEN'], ['executed', 'FILLED', 'VENUE_FILLED'], ['cancelled', 'CANCELLED', 'CANCELLED_AT_VENUE'], ['done', 'FILLED', 'OPERATION_COMPLETED'], ['failed', 'FAILED', 'LEGACY_UNSPECIFIED'],
    ['expired', 'CANCELLED', 'APPROVAL_EXPIRED'], ['withdrawn', 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL'], ['unknown', 'UNKNOWN', 'OUTCOME_EVENT_MISSING'],
  ];
  it('covers the whole vocabulary', () => { expect(rows.map((r) => r[0]).sort()).toEqual([...GMX_OP_STATES].sort()); });
  it.each(rows)('%s → %s (%s)', (legacy, state, reason) => {
    expect(mapGmxOp(legacy as (typeof GMX_OP_STATES)[number])).toMatchObject({ state, reason });
    expect(mapGmxOp(legacy as (typeof GMX_OP_STATES)[number], 'cancel')).toMatchObject({ state, reason });
  });
  it('"sent" is not yet an order and "created" is never "executed"', () => {
    expect(mapGmxOp('sent').state).not.toBe('SUBMITTED');
    expect(mapGmxOp('created').state).not.toBe('FILLED');
  });
});

describe('collateral states', () => {
  const dep: Row[] = [['pending_approval', 'AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], ['signed', 'APPROVED', 'LEGACY_UNSPECIFIED'], ['sent', 'SUBMITTING', 'SUBMIT_STARTED'], ['awaiting_credit', 'SUBMITTED', 'VENUE_ACCEPTED'],
    ['credited', 'FILLED', 'OPERATION_COMPLETED'], ['failed', 'FAILED', 'LEGACY_UNSPECIFIED'], ['expired', 'CANCELLED', 'APPROVAL_EXPIRED'], ['cancelled', 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL']];
  const wd: Row[] = [['pending_approval', 'AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], ['approved', 'APPROVED', 'LEGACY_UNSPECIFIED'], ['signed', 'SUBMITTING', 'SUBMIT_STARTED'], ['submitted', 'SUBMITTED', 'VENUE_ACCEPTED'],
    ['unknown', 'UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER'], ['completed', 'FILLED', 'OPERATION_COMPLETED'], ['rejected', 'REJECTED', 'VENUE_REJECTED'], ['failed', 'FAILED', 'LEGACY_UNSPECIFIED'], ['expired', 'CANCELLED', 'APPROVAL_EXPIRED'],
    ['cancelled', 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL']];
  it('covers both vocabularies', () => { expect(dep.map((r) => r[0]).sort()).toEqual([...DEPOSIT_STATES].sort()); expect(wd.map((r) => r[0]).sort()).toEqual([...WITHDRAW_STATES].sort()); });
  it.each(dep)('deposit %s → %s (%s)', (legacy, state, reason) => { expect(mapDeposit(legacy as (typeof DEPOSIT_STATES)[number])).toMatchObject({ state, reason }); });
  it.each(wd)('withdrawal %s → %s (%s)', (legacy, state, reason) => { expect(mapWithdraw(legacy as (typeof WITHDRAW_STATES)[number])).toMatchObject({ state, reason }); });
  it('a withdrawal given up without a trace is a failure, not a refusal', () => {
    expect(mapWithdraw('rejected', { error: '30 minutes without any trace of this withdrawal in the venue\'s ledger or on the wallet: it is taken as not made.' })).toMatchObject({ state: 'FAILED', reason: 'NEVER_PLACED' });
    expect(mapWithdraw('rejected', { error: 'the venue refused the withdrawal: insufficient balance' })).toMatchObject({ state: 'REJECTED', reason: 'VENUE_REJECTED' });
    expect(mapWithdraw('failed', { error: 'interrupted while asking the signer; nothing was sent to the venue' })).toMatchObject({ state: 'FAILED', reason: 'SIGNER_INTERRUPTED' });
  });
});

describe('venue action states (deriv_actions)', () => {
  const rows: Row[] = [['risk_checked', 'AWAITING_APPROVAL', 'APPROVAL_REQUESTED'], ['authorized', 'APPROVED', 'LEGACY_UNSPECIFIED'], ['signed', 'SUBMITTING', 'SUBMIT_STARTED'], ['submitted', 'SUBMITTED', 'VENUE_ACCEPTED'],
    ['confirmed', 'FILLED', 'OPERATION_COMPLETED'], ['rejected', 'REJECTED', 'LEGACY_UNSPECIFIED'], ['unknown', 'UNKNOWN', 'SUBMIT_UNREADABLE_ANSWER'], ['cancelled', 'CANCELLED', 'APPROVAL_EXPIRED']];
  it('covers the whole vocabulary', () => { expect(rows.map((r) => r[0]).sort()).toEqual([...VENUE_ACTION_STATES].sort()); });
  it.each(rows)('%s → %s (%s)', (legacy, state, reason) => { expect(mapVenueAction(legacy as (typeof VENUE_ACTION_STATES)[number])).toMatchObject({ state, reason }); });
});

describe('all mappings', () => {
  const all = [
    ...HL_ORDER_STATES.flatMap((s) => [mapHyperliquidOrder(s, { final: false }), mapHyperliquidOrder(s, { final: true })]), ...GMX_OP_STATES.flatMap((s) => [mapGmxOp(s, 'increase'), mapGmxOp(s, 'decrease'), mapGmxOp(s, 'cancel')]),
    ...DEPOSIT_STATES.map((s) => mapDeposit(s)), ...WITHDRAW_STATES.map((s) => mapWithdraw(s)), ...VENUE_ACTION_STATES.map((s) => mapVenueAction(s)),
  ];
  it('land on unified states and closed reason codes', () => { for (const m of all) { expect(ORDER_STATES).toContain(m.state); expect(REASON_CODES).toContain(m.reason); } });
  it('a legacy "unknown" is always UNKNOWN, and nothing legacy that is not venue-confirmed becomes FILLED', () => {
    expect(mapHyperliquidOrder('unknown').state).toBe('UNKNOWN'); expect(mapGmxOp('unknown').state).toBe('UNKNOWN'); expect(mapWithdraw('unknown').state).toBe('UNKNOWN'); expect(mapVenueAction('unknown').state).toBe('UNKNOWN');
    const filled = [...HL_ORDER_STATES.filter((s) => mapHyperliquidOrder(s).state === 'FILLED'), ...GMX_OP_STATES.filter((s) => mapGmxOp(s).state === 'FILLED'), ...DEPOSIT_STATES.filter((s) => mapDeposit(s).state === 'FILLED'),
      ...WITHDRAW_STATES.filter((s) => mapWithdraw(s).state === 'FILLED'), ...VENUE_ACTION_STATES.filter((s) => mapVenueAction(s).state === 'FILLED')];
    expect(filled.sort()).toEqual(['completed', 'confirmed', 'credited', 'done', 'executed', 'filled']);
  });
  it('every unified state except VALIDATED is produced by at least one legacy state', () => {
    const seen = new Set(all.map((m) => m.state));
    expect(ORDER_STATES.filter((s) => !seen.has(s))).toEqual(['VALIDATED']);
    for (const t of TERMINAL_STATES) expect(seen.has(t)).toBe(true);
  });
  it('the rendering lists the six tables and every legacy state', () => {
    const md = renderVocabularyTables();
    expect(VOCABULARIES).toHaveLength(6);
    for (const v of VOCABULARIES) { expect(md).toContain(v.title); for (const s of v.states) expect(md).toContain(`\`${s}`); }
  });
});

describe('paper order statuses (the paper engine is the venue of a paper order)', () => {
  const rows: [string, OrderState, ReasonCode][] = [['pending', 'SUBMITTED', 'VENUE_ACCEPTED'], ['triggered', 'SUBMITTED', 'VENUE_RESTING'], ['open', 'SUBMITTED', 'VENUE_RESTING'], ['partially_filled', 'PARTIALLY_FILLED', 'VENUE_FILL'],
    ['filled', 'FILLED', 'VENUE_FILLED'], ['cancelled', 'CANCELLED', 'CANCELLED_AT_VENUE'], ['rejected', 'REJECTED', 'VENUE_REJECTED']];
  it('is the vocabulary of @spw/derivatives (Order.status), whole', () => { expect([...PAPER_ORDER_STATUSES].sort()).toEqual([...ORDER_STATUSES].sort()); expect(rows.map((r) => r[0]).sort()).toEqual([...PAPER_ORDER_STATUSES].sort()); });
  it.each(rows)('%s → %s (%s)', (legacy, state, reason) => { expect(mapPaperOrder(legacy as (typeof PAPER_ORDER_STATUSES)[number])).toMatchObject({ state, reason }); });
  it('a cancel after a partial fill is a cancelled remainder; with nothing filled it is a cancel at the venue', () => {
    for (const filled of ['0.01', '1', '0.000001']) expect(mapPaperOrder('cancelled', { filled })).toMatchObject({ state: 'CANCELLED', reason: 'REMAINDER_CANCELLED' });
    for (const filled of ['0', '0.000', '', null, undefined, 'abc', '-1']) expect(mapPaperOrder('cancelled', { filled })).toMatchObject({ state: 'CANCELLED', reason: 'CANCELLED_AT_VENUE' });
  });
  it('no status is ambiguous or before the venue: nothing maps to UNKNOWN, CREATED, VALIDATED, AWAITING_APPROVAL or FAILED', () => {
    const states = PAPER_ORDER_STATUSES.flatMap((s) => [mapPaperOrder(s).state, mapPaperOrder(s, { filled: '1' }).state]);
    for (const s of ['UNKNOWN', 'CREATED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'FAILED']) expect(states).not.toContain(s);
  });
});

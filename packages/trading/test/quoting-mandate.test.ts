/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/quoting-mandate.test.ts
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

// compileToQuotingMandate: the trading mandate → `SPW-VENUE-QUOTING-MANDATE-v1`, and its enforced-by report.
import { describe, expect, it } from 'vitest';
import { QUOTING_MANDATE_BOUNDS, validateVenueQuotingMandate, venueQuotingMandateHash, VenueQuotingMandateSchema } from '@spw/derivatives/live';
import { compileToQuotingMandate, compileToVenueMandate, QUOTING_TERMS_FIELDS, REFERENCE_AUTHORIZATION, REFERENCE_MANDATE, renderQuotingEnforcementTable, TRADING_MANDATE_FIELDS, TradingMandateError, type QuotingTerms, type TradingMandate, type TradingMandateErrorCode } from '../src/index.ts';

const M: TradingMandate = { ...REFERENCE_MANDATE, notAfter: REFERENCE_MANDATE.createdAt + 7 * 86400 };
const TERMS: QuotingTerms = { levelsPerSide: 2, minHalfSpreadBps: 2, maxDistanceBps: 100, burstActions: 5, actionsPerMinute: 12, quotesPerHour: 1200, quotesPerDay: 2000, dailyTurnoverUsd: '500000', deadManSeconds: 60 };
const binding = { authorization: REFERENCE_AUTHORIZATION, ackSha256: 'c'.repeat(64) };
const compile = (over: Partial<TradingMandate> = {}, terms: Partial<QuotingTerms> = {}, b = binding) => compileToQuotingMandate({ ...M, ...over }, b, { ...TERMS, ...terms });
const code = (f: () => unknown): [TradingMandateErrorCode, string | null] | null => { try { f(); return null; } catch (e) { if (e instanceof TradingMandateError) return [e.code, e.field]; throw e; } };

describe('compileToQuotingMandate', () => {
  it('compiles the reference mandate; the result is a valid quoting mandate for its authorization and has a hash', () => {
    const c = compile();
    expect(c.shape).toBe('SPW-VENUE-QUOTING-MANDATE-v1');
    expect(VenueQuotingMandateSchema.safeParse(c.mandate).success).toBe(true);
    expect(() => validateVenueQuotingMandate(c.mandate, REFERENCE_AUTHORIZATION, M.createdAt)).not.toThrow();
    expect(venueQuotingMandateHash(c.mandate)).toHaveLength(32);
    expect(c.mandate).toMatchObject({ mandateId: M.mandateId, authorizationId: REFERENCE_AUTHORIZATION.authorizationId, account: REFERENCE_AUTHORIZATION.account, agentAddress: REFERENCE_AUTHORIZATION.agentAddress, agentId: 'agent-reference', strategySha256: M.strategySha256,
      maxRestingTotal: 8, maxGrossExposure: '15000', minHalfSpreadBps: 2, maxDistanceBps: 100, maxReduceDeviationBps: 50, floorEquity: '4000', deadManSeconds: 60, createdAt: M.createdAt, expiresAt: M.notAfter, ackSha256: 'c'.repeat(64),
      rate: { burstActions: 5, actionsPerMinute: 12, ordersPerHour: 1200, ordersPerDay: 2000, dailyTurnover: '500000' } });
    expect(c.mandate.instruments).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH'].map((instrument) => ({ instrument, maxLeverage: 3, maxQuoteNotional: '1000', maxRestingPerSide: 2, maxRestingNotionalPerSide: '2000', maxInventoryNotional: '4000' })));
    expect(c.derived.map((d) => d.field)).toEqual(['maxGrossExposure', 'instruments[].maxRestingNotionalPerSide', 'maxRestingTotal', 'instruments[].maxLeverage', 'maxReduceDeviationBps']);
  });

  it('the enforced-by report states every field of the trading mandate and every quoting term — consistently with the directional compilation', () => {
    const c = compile(), d = compileToVenueMandate(M, binding);
    expect(c.enforcement.map((e) => e.field)).toEqual(TRADING_MANDATE_FIELDS);
    expect(c.termsEnforcement.map((e) => e.term)).toEqual([...QUOTING_TERMS_FIELDS]);
    const by = Object.fromEntries(c.enforcement.map((e) => [e.field, e.enforcedBy]));
    // what a compromised API could ignore is said to be API-only, exactly as for the directional mandate
    expect(by.frequency).toBe('api_only');                                                             // a trading mandate's ≤ 500 orders a day cannot express a quoting rate: said, not hidden
    for (const f of ['maxDailyLossUsd', 'maxFeeUsd', 'stopConditions', 'label'] as const) { expect(by[f]).toBe('api_only'); expect(d.enforcement.find((e) => e.field === f)!.enforcedBy).toBe('api_only'); }
    for (const f of ['instruments', 'maxOrderNotionalUsd', 'maxPositionNotionalUsd', 'maxLeverage', 'floorEquityUsd', 'notAfter', 'accounts'] as const) { expect(by[f]).toBe('signer'); expect(d.enforcement.find((e) => e.field === f)!.enforcedBy).toBe('signer'); }
    for (const f of ['principal', 'strategySha256', 'maxCapitalUsd', 'maxSlippageBps'] as const) expect(by[f]).toBe('signer_partial');
    // the one difference: the order types are API-only in the directional shape and structural (signer) in the quoting shape
    expect(d.enforcement.find((e) => e.field === 'orderTypes')!.enforcedBy).toBe('api_only');
    expect(by.orderTypes).toBe('signer');
    expect(c.termsEnforcement.find((e) => e.term === 'deadManSeconds')!.enforcedBy).toBe('signer_partial');      // the signer cannot see that the venue received it
    expect(c.termsEnforcement.filter((e) => e.enforcedBy === 'signer').map((e) => e.term)).toEqual(['levelsPerSide', 'minHalfSpreadBps', 'maxDistanceBps', 'burstActions', 'actionsPerMinute', 'quotesPerHour', 'quotesPerDay', 'dailyTurnoverUsd']);
    for (const e of [...c.enforcement, ...c.termsEnforcement]) expect(e.note.length).toBeGreaterThan(10);
    const md = renderQuotingEnforcementTable(c);
    expect(md.split('\n')).toHaveLength(2 + TRADING_MANDATE_FIELDS.length + QUOTING_TERMS_FIELDS.length);
    expect(md).toContain('| `maxDailyLossUsd` | **API only**');
    expect(compile({ notBefore: M.createdAt + 60 }).enforcement.find((e) => e.field === 'notBefore')!.enforcedBy).toBe('api_only');
  });

  it('nothing is silently narrowed or widened: what cannot be expressed fails with a code and the field', () => {
    expect(code(() => compile({ mode: 'paper' }))).toEqual(['paper_mandate_has_no_signer_form', 'mode']);
    expect(code(() => compile({ venues: ['kyberswap'] }))).toEqual(['venue_not_in_mandate', 'venues']);
    expect(code(() => compile({ marketKinds: ['spot'] }))).toEqual(['market_kind_not_expressible', 'marketKinds']);
    expect(code(() => compile({ orderTypes: ['market'] }))).toEqual(['value_not_expressible', 'orderTypes']);
    expect(code(() => compile({ notAfter: M.createdAt + 7 * 86400 + 1 }))).toEqual(['duration_not_expressible', 'notAfter']);
    expect(code(() => compile({ strategySha256: null }))).toEqual(['strategy_hash_required', 'strategySha256']);
    expect(code(() => compile({ floorEquityUsd: '0' }))).toEqual(['value_not_expressible', 'floorEquityUsd']);
    expect(code(() => compile({ maxLeverage: '2.5' }))).toEqual(['value_not_expressible', 'maxLeverage']);
    expect(code(() => compile({ maxLeverage: '6' }))).toEqual(['value_not_expressible', 'maxLeverage']);                     // above the authorization's 5
    expect(code(() => compile({ instruments: ['hyperliquid:BTC', 'hyperliquid:DOGE', 'kyberswap:WETH-USDC'] }))).toEqual(['exceeds_authorization', 'instruments']);
    expect(code(() => compile({ maxOrderNotionalUsd: '2000.01' }))).toEqual(['value_not_expressible', 'maxOrderNotionalUsd']);   // compiled ceiling 2 000
    expect(code(() => compile({ maxPositionNotionalUsd: '8000.01', maxCapitalUsd: '6000' }))).toEqual(['exceeds_authorization', 'maxPositionNotionalUsd']);
    expect(code(() => compile({ maxCapitalUsd: '7000' }))).toEqual(['exceeds_authorization', 'maxCapitalUsd']);              // 21 000 > the authorization's 20 000
    expect(code(() => compile({ maxSlippageBps: 5 }))).toEqual(['value_not_expressible', 'maxSlippageBps']);                 // reduce band floor 10
    expect(code(() => compile({ maxSlippageBps: 301 }))?.[0]).toMatch(/exceeds_authorization|value_not_expressible/);
    expect(code(() => compile({}, { quotesPerHour: 3601, quotesPerDay: 20000 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { quotesPerHour: 2001 }))).toEqual(['value_not_expressible', null]);                       // per hour above per day
    expect(code(() => compile({}, { quotesPerDay: 20001 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { dailyTurnoverUsd: '2000000.01' }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { dailyTurnoverUsd: '0' }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { actionsPerMinute: 61 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { levelsPerSide: 6 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { levelsPerSide: 5, }))).toBeNull();                                                       // 5 × 2 × 2 = 20 = the ceiling
    expect(code(() => compile({ instruments: ['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL'] }, { levelsPerSide: 4 }))).toEqual(['value_not_expressible', null]);   // 24 > 20
    expect(code(() => compile({}, { minHalfSpreadBps: 0 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { minHalfSpreadBps: 100 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { maxDistanceBps: 301 }))).toEqual(['exceeds_authorization', null]);
    expect(code(() => compile({}, { deadManSeconds: 9 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { deadManSeconds: QUOTING_MANDATE_BOUNDS.maxDeadManSeconds + 1 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, { burstActions: 21 }))).toEqual(['value_not_expressible', null]);
    expect(code(() => compile({}, {}, { ...binding, authorization: { ...REFERENCE_AUTHORIZATION, account: `0x${'9'.repeat(40)}` } }))).toEqual(['binding_mismatch', 'accounts']);
    expect(code(() => compile({}, {}, { ...binding, authorization: { ...REFERENCE_AUTHORIZATION, expiresAt: M.notAfter - 1 } }))).toEqual(['exceeds_authorization', 'notAfter']);
    expect(code(() => compile({ extra: 1 } as never))).toEqual(['invalid_mandate', null]);
  });
});

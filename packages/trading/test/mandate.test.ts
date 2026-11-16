import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MandateSchema, mandateHash, validateMandate } from '@spw/core';
import { D } from '@spw/derivatives';
import { validateVenueMandate, VenueMandateSchema, venueMandateHash } from '@spw/derivatives/live';
import {
  canonicalOrder, checkOrder, checkTradingMandateOrder, compileToSpotMandate, compileToVenueMandate, compileTradingMandate, isSubsetOf, isSubsetOfSpotMandate, isSubsetOfVenueMandate, MANDATE_DENY_CODES,
  REFERENCE_AUTHORIZATION, REFERENCE_MANDATE, REFERENCE_SPOT_BINDING, renderEnforcementTable, revokeTradingMandate, SIGNER_MANDATE_SHAPES, TRADING_MANDATE_FIELDS, TRADING_MANDATE_MAX_DAYS, TRADING_MANDATE_WIND_DOWN_S,
  TradingMandateError, tradingMandateHashHex, tradingMandatePhase, TradingMandateRevocationSchema, TradingMandateSchema, validateTradingMandate,
  type CanonicalOrderInput, type MandateDenyCode, type TradingMandate, type TradingMandateErrorCode, type TradingMandateUsage,
} from '../src/index.ts';
import { order as baseOrder } from './fixtures.ts';

const M = REFERENCE_MANDATE, T = M.createdAt, NOW_MS = (T + 3600) * 1000;
const mandate = (over: Partial<TradingMandate> = {}): TradingMandate => ({ ...M, ...over });
const binding = { authorization: REFERENCE_AUTHORIZATION, ackSha256: 'c'.repeat(64) };
const HL_ACCOUNT = M.accounts[0]!, VAULT = M.accounts[1]!;
const ord = (over: Partial<CanonicalOrderInput> = {}) => canonicalOrder(baseOrder({ principal: { kind: 'agent', id: 'agent-reference' }, mandateId: M.mandateId, createdAt: NOW_MS, expiresAt: NOW_MS + 60_000, ...over }));
const usage = (over: Partial<TradingMandateUsage> = {}): TradingMandateUsage => ({ revokedAt: null, account: HL_ACCOUNT, reducing: false, referencePrice: '50000', positionNotionalAfterUsd: '1000', capitalInUseAfterUsd: '500', equityUsd: '5000',
  realizedLossTodayUsd: '0', totalLossUsd: '0', drawdownBps: 0, ordersLastMinute: 0, ordersLastHour: 0, ordersToday: 0, consecutiveRejects: 0, dataStaleMs: 0, signerUnreachableMs: 0, ...over });
const code = (f: () => unknown): TradingMandateErrorCode | null => { try { f(); return null; } catch (e) { if (e instanceof TradingMandateError) return e.code; throw e; } };

describe('trading mandate — schema and hash', () => {
  it('the reference mandate is valid', () => {
    expect(TradingMandateSchema.safeParse(M).success).toBe(true);
    expect(() => validateTradingMandate(M, T)).not.toThrow();
    expect(tradingMandateHashHex(M)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is pinned', () => { expect(tradingMandateHashHex(M)).toBe('6c3b3a8c2a17d3937be1effd2bec0da62a2ef9f66104096c081e950f101342f1'); });
  it('the hash does not depend on the order of lists', () => {
    const shuffled = mandate({ accounts: [...M.accounts].reverse(), venues: [...M.venues].reverse(), networks: [...M.networks].reverse(), instruments: [...M.instruments].reverse(), marketKinds: [...M.marketKinds].reverse(),
      orderTypes: [...M.orderTypes].reverse(), stopConditions: [...M.stopConditions].reverse() });
    expect(tradingMandateHashHex(shuffled)).toBe(tradingMandateHashHex(M));
    expect(tradingMandateHashHex(mandate({ maxCapitalUsd: '5000.00' }))).toBe(tradingMandateHashHex(M));
  });
  const changes: Partial<TradingMandate>[] = [
    { mandateId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f6ff' }, { principal: { kind: 'api_key', id: 'agent-reference' } }, { principal: { kind: 'agent', id: 'other' } }, { accounts: [HL_ACCOUNT] },
    { accounts: [{ ...HL_ACCOUNT, account: '0x1111111111111111111111111111111111111112' } as TradingMandate['accounts'][number], VAULT] }, { venues: ['hyperliquid'] }, { networks: ['mainnet'] },
    { instruments: ['hyperliquid:BTC', 'kyberswap:WETH-USDC'] }, { marketKinds: ['perp'] }, { orderTypes: ['market'] }, { maxCapitalUsd: '5001' }, { maxOrderNotionalUsd: '1001' }, { maxPositionNotionalUsd: '4001' },
    { maxLeverage: '4' }, { maxDailyLossUsd: '251' }, { floorEquityUsd: '3999' }, { createdAt: T + 1 }, { notBefore: T + 1 }, { notAfter: M.notAfter + 1 }, { frequency: { ...M.frequency, perMinute: 3 } },
    { frequency: { ...M.frequency, perHour: 21 } }, { frequency: { ...M.frequency, perDay: 101 } }, { maxSlippageBps: 51 }, { maxFeeUsd: '6' }, { stopConditions: M.stopConditions.slice(1) },
    { stopConditions: [{ kind: 'loss_gte', usd: '751' }, ...M.stopConditions.slice(1)] }, { mode: 'paper' }, { strategySha256: 'b'.repeat(64) }, { strategySha256: null }, { label: 'Another' },
  ];
  it.each(changes)('immutable: changing %j gives another hash', (over) => { expect(tradingMandateHashHex(mandate(over))).not.toBe(tradingMandateHashHex(M)); });
  it('the list of changes touches every field (nothing is outside the hash)', () => {
    const touched = new Set(changes.flatMap((c) => Object.keys(c)));
    expect(TRADING_MANDATE_FIELDS.filter((f) => f !== 'v' && !touched.has(f))).toEqual([]);
  });
  it('refuses unknown fields and malformed values', () => {
    for (const over of [{ extra: 1 }, { maxCapitalUsd: '0' }, { maxCapitalUsd: 5000 }, { instruments: ['*'] }, { instruments: [] }, { mode: 'research' }, { principal: { kind: 'owner', id: 'x' } }, { maxSlippageBps: 0 }, { v: 2 },
      { stopConditions: [{ kind: 'loss_gte', usd: '-1' }] }, { stopConditions: [{ kind: 'moon_phase', value: 1 }] }, { accounts: [{ kind: 'vault', vaultIndex: 0, address: VAULT.kind === 'vault' ? VAULT.address : '', network: 'base' }] }])
      expect(TradingMandateSchema.safeParse({ ...M, ...over }).success).toBe(false);
  });
});

describe('trading mandate — validity', () => {
  const bad: [string, Partial<TradingMandate>][] = [
    ['a wildcard in a live mandate', { instruments: ['hyperliquid:*', 'kyberswap:WETH-USDC'] }],
    ['an instrument on a venue outside the mandate', { venues: ['hyperliquid'], accounts: [HL_ACCOUNT], networks: ['mainnet'] }],
    ['a venue without an instrument', { venues: ['hyperliquid', 'kyberswap', 'gmx'] }],
    ['a duplicate instrument', { instruments: ['hyperliquid:BTC', 'hyperliquid:BTC', 'kyberswap:WETH-USDC'] }],
    ['a duplicate venue', { venues: ['hyperliquid', 'hyperliquid', 'kyberswap'] }],
    ['an account on a network outside the mandate', { networks: ['mainnet'] }],
    ['an order limit above the position limit', { maxOrderNotionalUsd: '4001' }],
    ['a position limit above capital × leverage', { maxPositionNotionalUsd: '15001' }],
    ['leverage below 1', { maxLeverage: '0.5' }],
    ['a floor at or above the capital', { floorEquityUsd: '5000' }],
    ['a daily loss above the capital', { maxDailyLossUsd: '5001' }],
    ['frequencies that do not grow with the window', { frequency: { perMinute: 30, perHour: 20, perDay: 100 } }],
    ['notBefore before the creation', { notBefore: T - 1 }],
    ['an empty window', { notBefore: T + 100, notAfter: T + 100 }],
    ['a duration above the maximum', { notAfter: T + TRADING_MANDATE_MAX_DAYS * 86400 + 1 }],
    ['two stop conditions of one kind', { stopConditions: [{ kind: 'loss_gte', usd: '1' }, { kind: 'loss_gte', usd: '2' }] }],
    ['an agent without a strategy hash', { strategySha256: null }],
    ['leverage on a spot-only mandate', { marketKinds: ['spot'] }],
  ];
  it.each(bad)('refuses %s', (_n, over) => { expect(code(() => validateTradingMandate(mandate(over), T))).toBe('invalid_mandate'); });
  it('refuses a mandate that is expired or not current', () => {
    expect(code(() => validateTradingMandate(M, M.notAfter))).toBe('invalid_mandate');
    expect(code(() => validateTradingMandate(M, T + 601))).toBe('invalid_mandate');
    expect(code(() => validateTradingMandate(M, T - 121))).toBe('invalid_mandate');
  });
  it('accepts a wildcard in a paper mandate, and an API key without a strategy', () => {
    expect(() => validateTradingMandate(mandate({ mode: 'paper', instruments: ['hyperliquid:*', 'kyberswap:WETH-USDC'] }), T)).not.toThrow();
    expect(() => validateTradingMandate(mandate({ principal: { kind: 'api_key', id: 'key-1' }, strategySha256: null }), T)).not.toThrow();
  });
  it('phases', () => {
    const m = mandate({ notBefore: T + 100 });
    expect(tradingMandatePhase(m, null, T + 99)).toBe('pending');
    expect(tradingMandatePhase(m, null, T + 100)).toBe('active');
    expect(tradingMandatePhase(m, null, m.notAfter)).toBe('wind_down');
    expect(tradingMandatePhase(m, null, m.notAfter + TRADING_MANDATE_WIND_DOWN_S)).toBe('ended');
    expect(tradingMandatePhase(m, T + 500, T + 500)).toBe('wind_down');
    expect(tradingMandatePhase(m, T + 500, T + 500 + TRADING_MANDATE_WIND_DOWN_S)).toBe('ended');
    expect(tradingMandatePhase(m, m.notAfter + 10, m.notAfter)).toBe('wind_down');                              // a revocation after the expiry changes nothing
  });
  it('revocation names the exact immutable object', () => {
    const r = revokeTradingMandate(M, { revokedAt: T + 10, revokedBy: { kind: 'owner', id: 'owner-key-0001' }, reason: 'owner_request', supersededBy: null, detail: null });
    expect(r).toMatchObject({ v: 1, mandateId: M.mandateId, mandateHash: tradingMandateHashHex(M), reason: 'owner_request' });
    expect(TradingMandateRevocationSchema.safeParse(r).success).toBe(true);
    expect(() => revokeTradingMandate(M, { revokedAt: T, revokedBy: { kind: 'owner', id: 'o' }, reason: 'superseded', supersededBy: null, detail: null })).toThrow(TradingMandateError);
    expect(() => revokeTradingMandate(M, { revokedAt: T, revokedBy: { kind: 'owner', id: 'o' }, reason: 'owner_request', supersededBy: M.mandateId, detail: null })).toThrow(TradingMandateError);
    expect(TradingMandateRevocationSchema.safeParse({ ...r, reason: 'bored' }).success).toBe(false);
  });
});

describe('trading mandate — checkOrder', () => {
  it('allows an order inside the mandate', () => {
    expect(checkOrder(M, ord({ size: '0.02' }), usage(), NOW_MS)).toEqual({ decision: 'allow', reasons: [], orderNotionalUsd: '1000' });
    expect(checkOrder(M, ord({ size: '0.01' }), usage(), NOW_MS)).toMatchObject({ decision: 'allow', orderNotionalUsd: '500' });
    expect(checkTradingMandateOrder).toBe(checkOrder);
  });
  const small: Partial<CanonicalOrderInput> = { size: '0.01' };                   // 0.01 × 50 000 = 500 USD
  const spot: Partial<CanonicalOrderInput> = { venue: 'kyberswap', network: 'base', instrument: 'kyberswap:WETH-USDC', marketKind: 'spot', leverage: null, marginMode: null, type: 'market', limitPrice: null, tif: 'ioc', size: null, notional: '500' };
  const cases: [MandateDenyCode, Partial<CanonicalOrderInput>, Partial<TradingMandateUsage>, Partial<TradingMandate>, number?][] = [
    ['MANDATE_NOT_YET_VALID', small, {}, { notBefore: T + 7200 }],
    ['MANDATE_ENDED', small, {}, {}, (M.notAfter + TRADING_MANDATE_WIND_DOWN_S) * 1000],
    ['MANDATE_REVOKED', small, { revokedAt: T + 10 }, {}, (T + 10 + TRADING_MANDATE_WIND_DOWN_S) * 1000],
    ['WIND_DOWN_REDUCING_ONLY', small, { revokedAt: T + 10 }, {}],
    ['PRINCIPAL_MISMATCH', { ...small, principal: { kind: 'agent', id: 'someone-else' } }, {}, {}],
    ['PRINCIPAL_MISMATCH', { ...small, principal: { kind: 'api_key', id: 'agent-reference' } }, {}, {}],
    ['MANDATE_ID_MISMATCH', { ...small, mandateId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f6ff' }, {}, {}],
    ['MODE_MISMATCH', { ...small, mode: 'paper' }, {}, {}],
    ['ACCOUNT_NOT_ALLOWED', small, { account: { kind: 'venue_account', venue: 'hyperliquid', network: 'mainnet', account: '0x9999999999999999999999999999999999999999' } }, {}],
    ['ACCOUNT_NOT_ALLOWED', small, { account: VAULT }, {}],                                                    // an allowed account, but not the order's venue network
    ['VENUE_NOT_ALLOWED', { ...small, venue: 'gmx', instrument: 'gmx:BTC' }, {}, {}],
    ['NETWORK_NOT_ALLOWED', { ...small, network: 'testnet' }, {}, {}],
    ['INSTRUMENT_NOT_ALLOWED', { ...small, instrument: 'hyperliquid:SOL' }, {}, {}],
    ['MARKET_KIND_NOT_ALLOWED', small, {}, { marketKinds: ['spot'], maxLeverage: '1' }],
    ['ORDER_TYPE_NOT_ALLOWED', { ...small, type: 'stop', triggerPrice: '49000' }, {}, {}],
    ['ORDER_NOTIONAL_EXCEEDED', { size: '0.0201' }, {}, {}],                                                    // 1 005 USD
    ['ORDER_NOTIONAL_EXCEEDED', { size: null, notional: '1000.01' }, {}, {}],
    ['NOTIONAL_UNKNOWN', { ...small, type: 'market', limitPrice: null }, { referencePrice: null }, {}],
    ['POSITION_NOTIONAL_EXCEEDED', small, { positionNotionalAfterUsd: '4000.01' }, {}],
    ['CAPITAL_EXCEEDED', small, { capitalInUseAfterUsd: '5000.01' }, {}],
    ['LEVERAGE_EXCEEDED', { ...small, leverage: '3.01' }, {}, {}],
    ['LEVERAGE_UNKNOWN', { ...small, leverage: null }, {}, {}],
    ['DAILY_LOSS_REACHED', small, { realizedLossTodayUsd: '250' }, {}],
    ['BELOW_FLOOR_EQUITY', small, { equityUsd: '3999.99' }, {}],
    ['RATE_PER_MINUTE', small, { ordersLastMinute: 2 }, {}],
    ['RATE_PER_HOUR', small, { ordersLastHour: 20 }, {}],
    ['RATE_PER_DAY', small, { ordersToday: 100 }, {}],
    ['SLIPPAGE_ABOVE_MANDATE', { ...small, maxSlippageBps: 51 }, {}, {}],
    ['FEE_ABOVE_MANDATE', { ...small, maxFeeUsd: '5.01' }, {}, {}],
    ['ORDER_OUTLIVES_MANDATE', { ...small, createdAt: M.notAfter * 1000 - 1000, expiresAt: M.notAfter * 1000 + 1 }, {}, {}, M.notAfter * 1000 - 1000],
    ['STOP_LOSS_GTE', small, { totalLossUsd: '750' }, {}],
    ['STOP_DRAWDOWN_GTE', small, { drawdownBps: 1500 }, {}],
    ['STOP_CONSECUTIVE_REJECTS_GTE', small, { consecutiveRejects: 5 }, {}],
    ['STOP_DATA_STALE_GTE', small, { dataStaleMs: 30_000 }, {}],
    ['STOP_SIGNER_UNREACHABLE_GTE', small, { signerUnreachableMs: 60_000 }, {}],
    ['INVALID_INPUT', small, { ordersToday: Number.NaN }, {}],
    ['INVALID_INPUT', small, { equityUsd: 'lots' }, {}],
  ];
  it.each(cases)('%s', (reason, o, u, m, now) => {
    const r = checkOrder(mandate(m), ord(o), usage(u), now ?? NOW_MS);
    expect(r.decision).toBe('deny'); expect(r.reasons).toContain(reason);
  });
  it('every deny code is exercised', () => { expect(MANDATE_DENY_CODES.filter((c) => !cases.some((k) => k[0] === c))).toEqual([]); });
  it('just inside each limit is allowed', () => {
    const u = usage({ positionNotionalAfterUsd: '4000', capitalInUseAfterUsd: '5000', realizedLossTodayUsd: '249.99', equityUsd: '4000', totalLossUsd: '749.99', drawdownBps: 1499, ordersLastMinute: 1, ordersLastHour: 19,
      ordersToday: 99, consecutiveRejects: 4, dataStaleMs: 29_999, signerUnreachableMs: 59_999 });
    expect(checkOrder(M, ord({ size: '0.02', maxSlippageBps: 50, maxFeeUsd: '5', leverage: '3' }), u, NOW_MS)).toMatchObject({ decision: 'allow', orderNotionalUsd: '1000' });
  });
  it('collects every reason, not only the first', () => {
    const r = checkOrder(M, ord({ size: '1', leverage: '10', maxSlippageBps: 500 }), usage({ ordersLastMinute: 9, equityUsd: '1' }), NOW_MS);
    expect(r.reasons).toEqual(expect.arrayContaining(['ORDER_NOTIONAL_EXCEEDED', 'LEVERAGE_EXCEEDED', 'SLIPPAGE_ABOVE_MANDATE', 'RATE_PER_MINUTE', 'BELOW_FLOOR_EQUITY']));
  });
  it('values a sized order at the highest of the reference price and the prices it names', () => {
    expect(checkOrder(M, ord({ size: '0.01', limitPrice: '60000' }), usage(), NOW_MS).orderNotionalUsd).toBe('600');
    expect(checkOrder(M, ord({ size: '0.01', limitPrice: '40000' }), usage(), NOW_MS).orderNotionalUsd).toBe('500');
    expect(checkOrder(M, ord({ size: '0.01', limitPrice: '40000' }), usage({ referencePrice: null }), NOW_MS).orderNotionalUsd).toBe('400');
  });
  it('a spot order from the vault', () => {
    expect(checkOrder(M, ord({ ...spot, type: 'market' }), usage({ account: VAULT }), NOW_MS).decision).toBe('allow');
    expect(checkOrder(M, ord(spot), usage({ account: HL_ACCOUNT }), NOW_MS).reasons).toContain('ACCOUNT_NOT_ALLOWED');
  });
  it('a paper mandate with a wildcard covers the venue\'s instruments, and only them', () => {
    const p = mandate({ mode: 'paper', instruments: ['hyperliquid:*', 'kyberswap:WETH-USDC'] });
    expect(checkOrder(p, ord({ ...small, mode: 'paper', instrument: 'hyperliquid:SOL' }), usage(), NOW_MS).decision).toBe('allow');
    expect(checkOrder(p, ord({ ...spot, mode: 'paper', instrument: 'kyberswap:WBTC-USDC' }), usage({ account: VAULT }), NOW_MS).reasons).toContain('INSTRUMENT_NOT_ALLOWED');
  });
  describe('a strictly reducing order', () => {
    const red: Partial<CanonicalOrderInput> = { side: 'sell', size: '0.01', reduceOnly: true, leverage: null, marginMode: null, type: 'market', limitPrice: null, tif: 'ioc' };
    const worst = usage({ reducing: true, positionNotionalAfterUsd: '999999', capitalInUseAfterUsd: '999999', equityUsd: '0', realizedLossTodayUsd: '999999', totalLossUsd: '999999', drawdownBps: 9999, ordersLastMinute: 999,
      ordersLastHour: 999, ordersToday: 999, consecutiveRejects: 999, dataStaleMs: 10 ** 9, signerUnreachableMs: 10 ** 9 });
    it('is exempt from capital, position, loss, floor, frequency, order-type and stop conditions', () => { expect(checkOrder(M, ord(red), worst, NOW_MS)).toMatchObject({ decision: 'allow', reasons: [] }); });
    it('stays possible during the wind-down, after a revocation or the expiry, and before notBefore', () => {
      expect(checkOrder(M, ord(red), { ...worst, revokedAt: T + 10 }, NOW_MS).decision).toBe('allow');
      const late = (M.notAfter + 100) * 1000;
      expect(checkOrder(M, ord({ ...red, createdAt: late, expiresAt: late + 60_000 }), worst, late).decision).toBe('allow');
      expect(checkOrder(mandate({ notBefore: T + 7200 }), ord(red), worst, NOW_MS).decision).toBe('allow');
    });
    it('ends with the wind-down, and stays bound to the principal, the account, the instrument and the per-order bounds', () => {
      const over = (M.notAfter + TRADING_MANDATE_WIND_DOWN_S) * 1000;
      expect(checkOrder(M, ord({ ...red, createdAt: over, expiresAt: over + 1000 }), worst, over).reasons).toEqual(['MANDATE_ENDED']);
      expect(checkOrder(M, ord({ ...red, principal: { kind: 'agent', id: 'x' } }), worst, NOW_MS).reasons).toEqual(['PRINCIPAL_MISMATCH']);
      expect(checkOrder(M, ord({ ...red, instrument: 'hyperliquid:SOL' }), worst, NOW_MS).reasons).toEqual(['INSTRUMENT_NOT_ALLOWED']);
      expect(checkOrder(M, ord({ ...red, size: '1' }), worst, NOW_MS).reasons).toEqual(['ORDER_NOTIONAL_EXCEEDED']);
      expect(checkOrder(M, ord({ ...red, maxSlippageBps: 500 }), worst, NOW_MS).reasons).toEqual(['SLIPPAGE_ABOVE_MANDATE']);
    });
  });
  it('fails closed on a malformed mandate or clock', () => {
    expect(checkOrder({ ...M, maxCapitalUsd: 'x' }, ord(), usage(), NOW_MS).reasons).toEqual(['INVALID_INPUT']);
    expect(checkOrder(M, ord(), usage(), Number.NaN).reasons).toEqual(['INVALID_INPUT']);
    expect(checkOrder(M, ord(), null as never, NOW_MS).reasons).toContain('INVALID_INPUT');
  });
  it('property: an allowed order never exceeds a limit of the mandate', () => {
    const arb = fc.record({ size: fc.integer({ min: 1, max: 60 }), lev: fc.integer({ min: 1, max: 6 }), slip: fc.integer({ min: 0, max: 100 }), pos: fc.integer({ min: 0, max: 8000 }), cap: fc.integer({ min: 0, max: 10_000 }),
      lossToday: fc.integer({ min: 0, max: 500 }), eq: fc.integer({ min: 3000, max: 6000 }), perMin: fc.integer({ min: 0, max: 4 }), perHour: fc.integer({ min: 0, max: 40 }), perDay: fc.integer({ min: 0, max: 200 }), dd: fc.integer({ min: 0, max: 3000 }) });
    fc.assert(fc.property(arb, (x) => {
      const o = ord({ size: D.str(D.div(D.from(BigInt(x.size)), D.from(1000n), 3, 'down')), leverage: String(x.lev), maxSlippageBps: x.slip });
      const u = usage({ positionNotionalAfterUsd: String(x.pos), capitalInUseAfterUsd: String(x.cap), realizedLossTodayUsd: String(x.lossToday), equityUsd: String(x.eq), ordersLastMinute: x.perMin, ordersLastHour: x.perHour, ordersToday: x.perDay, drawdownBps: x.dd });
      const r = checkOrder(M, o, u, NOW_MS);
      const inside = x.size * 50 <= 1000 && x.lev <= 3 && x.slip <= 50 && x.pos <= 4000 && x.cap <= 5000 && x.lossToday < 250 && x.eq >= 4000 && x.perMin < 2 && x.perHour < 20 && x.perDay < 100 && x.dd < 1500;
      expect(r.decision === 'allow').toBe(inside);
    }), { numRuns: 500 });
  });
});

describe('trading mandate — compilation to the derivative mandate', () => {
  const c = compileToVenueMandate(M, binding);
  it('produces a mandate the signer shape accepts and the existing validator passes', () => {
    expect(c.shape).toBe('SPW-VENUE-MANDATE-v1');
    expect(VenueMandateSchema.safeParse(c.mandate).success).toBe(true);
    expect(() => validateVenueMandate(c.mandate, REFERENCE_AUTHORIZATION, T)).not.toThrow();
    expect(venueMandateHash(c.mandate)).toHaveLength(32);
  });
  it('copies or derives every value as documented', () => {
    expect(c.mandate).toEqual({
      v: 1, mandateId: M.mandateId, authorizationId: REFERENCE_AUTHORIZATION.authorizationId, keyId: 'owner-key-0001', venue: 'hyperliquid', network: 'mainnet', account: '0x1111111111111111111111111111111111111111',
      agentAddress: '0x3333333333333333333333333333333333333333', strategySha256: 'a'.repeat(64), agentId: 'agent-reference',
      instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '4000' }, { instrument: 'hyperliquid:ETH', maxLeverage: 3, maxPositionNotional: '4000' }],
      maxOrderNotional: '1000', maxGrossExposure: '15000', maxOrdersPerDay: 100, maxOrdersPerHour: 20, maxDailyTurnover: '100000', floorEquity: '4000', maxPriceDeviationBps: 50,
      createdAt: T, expiresAt: M.notAfter, ackSha256: 'c'.repeat(64),
    });
    expect(c.derived.map((d) => d.field)).toEqual(['maxGrossExposure', 'maxDailyTurnover', 'instruments[].maxLeverage', 'maxPriceDeviationBps']);
  });
  it('reports the enforcement of EVERY field of the trading mandate', () => {
    expect(c.enforcement.map((e) => e.field)).toEqual(TRADING_MANDATE_FIELDS);
    const by = Object.fromEntries(c.enforcement.map((e) => [e.field, e.enforcedBy]));
    expect(by).toMatchObject({ instruments: 'signer', maxOrderNotionalUsd: 'signer', maxPositionNotionalUsd: 'signer', maxLeverage: 'signer', floorEquityUsd: 'signer', notAfter: 'signer', accounts: 'signer',
      maxCapitalUsd: 'signer_partial', frequency: 'signer_partial', maxSlippageBps: 'signer_partial', principal: 'signer_partial', strategySha256: 'signer_partial',
      maxDailyLossUsd: 'api_only', orderTypes: 'api_only', maxFeeUsd: 'api_only', stopConditions: 'api_only', label: 'api_only', notBefore: 'signer_partial', mode: 'not_applicable' });
    expect(c.enforcement.every((e) => e.note.length > 10 && (e.enforcedBy !== 'signer_partial' || e.note.length > 30))).toBe(true);
    // a later start is enforced by the API only, and the report says so
    expect(compileToVenueMandate(mandate({ notBefore: T + 3600 }), binding).enforcement.find((e) => e.field === 'notBefore')).toMatchObject({ enforcedBy: 'api_only', signerField: null });
  });
  it('the trading mandate is inside the mandate it compiles to', () => {
    expect(isSubsetOfVenueMandate(M, c.mandate)).toEqual({ ok: true, violations: [] });
    expect(isSubsetOf(M, c.mandate)).toEqual({ ok: true, violations: [] });
  });
  const errors: [TradingMandateErrorCode, Partial<TradingMandate>, Partial<typeof binding>?][] = [
    ['paper_mandate_has_no_signer_form', { mode: 'paper' }],
    ['venue_not_in_mandate', { venues: ['kyberswap'], instruments: ['kyberswap:WETH-USDC'], accounts: [VAULT], networks: ['base'], marketKinds: ['spot', 'perp'] }],
    ['market_kind_not_expressible', { marketKinds: ['spot'] }],
    ['account_not_in_mandate', { accounts: [VAULT] }],
    ['ambiguous_account', { accounts: [HL_ACCOUNT, { kind: 'venue_account', venue: 'hyperliquid', network: 'mainnet', account: '0x5555555555555555555555555555555555555555' }, VAULT] }],
    ['binding_mismatch', { accounts: [{ kind: 'venue_account', venue: 'hyperliquid', network: 'mainnet', account: '0x5555555555555555555555555555555555555555' }, VAULT] }],
    ['binding_mismatch', {}, { authorization: { ...REFERENCE_AUTHORIZATION, network: 'testnet' } }],
    ['exceeds_authorization', { instruments: ['hyperliquid:BTC', 'hyperliquid:HYPE', 'kyberswap:WETH-USDC'] }],
    ['instrument_not_expressible', { instruments: ['hyperliquid:BTC/USD', 'kyberswap:WETH-USDC'] }],
    ['value_not_expressible', { maxLeverage: '2.5' }],
    ['value_not_expressible', { maxLeverage: '6' }],                                                             // above the authorization's 5
    ['strategy_hash_required', { principal: { kind: 'api_key', id: 'key-1' }, strategySha256: null }],
    ['duration_not_expressible', { notAfter: T + 31 * 86400 }],
    ['exceeds_authorization', {}, { authorization: { ...REFERENCE_AUTHORIZATION, expiresAt: T + 86400 } }],
    ['value_not_expressible', { floorEquityUsd: '0' }],
    ['exceeds_authorization', { maxOrderNotionalUsd: '2001' }],
    ['exceeds_authorization', { maxPositionNotionalUsd: '8001' }],
    ['exceeds_authorization', { maxCapitalUsd: '7000' }],                                                         // 7 000 × 3 = 21 000 > 20 000
    ['exceeds_authorization', { frequency: { perMinute: 2, perHour: 20, perDay: 201 } }],
    ['value_not_expressible', { frequency: { perMinute: 2, perHour: 61, perDay: 100 } }],
    ['exceeds_authorization', { maxSlippageBps: 301 }],
    ['value_not_expressible', { maxSlippageBps: 5 }],                                                             // below the signer's minimum band of 10 bps
  ];
  it.each(errors)('fails with %s for %j', (c0, over, b) => { expect(code(() => compileToVenueMandate(mandate(over), { ...binding, ...b }))).toBe(c0); });
  it('a typed error names the field', () => {
    try { compileToVenueMandate(mandate({ maxLeverage: '2.5' }), binding); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(TradingMandateError); expect((e as TradingMandateError).field).toBe('maxLeverage'); }
  });
});

describe('trading mandate — compilation to the spot mandate', () => {
  const c = compileToSpotMandate(M, REFERENCE_SPOT_BINDING);
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  it('produces a mandate the signer shape accepts', () => {
    expect(c.shape).toBe('SPW-MANDATE-v1');
    expect(MandateSchema.safeParse(c.mandate).success).toBe(true);
    expect(mandateHash(c.mandate)).toHaveLength(32);
    // the validator of packages/core (real asset registry: WETH and USDC on Base) accepts it as it is
    expect(() => validateMandate(c.mandate, T)).not.toThrow();
  });
  it('turns USD limits into base units at the binding\'s prices, rounded down', () => {
    expect(c.mandate).toMatchObject({ mandateId: M.mandateId, keyId: 'owner-key-0001', vaultIndex: 1, vault: '0x2222222222222222222222222222222222222222', network: 'base', provider: 'kyberswap', assets: [WETH, USDC].sort(),
      maxOrdersPerDay: 100, maxSlippageBps: 50, createdAt: T, expiresAt: M.notAfter, strategySha256: 'a'.repeat(64), label: 'Reference mandate' });
    expect(c.mandate.maxOrder).toEqual({ [WETH]: '400000000000000000', [USDC]: '1000000000' });                    // 1 000 USD = 0.4 WETH at 2 500 = 1 000 USDC
    expect(c.mandate.maxDaily).toEqual({ [WETH]: '40000000000000000000', [USDC]: '100000000000' });
    const odd = compileToSpotMandate(M, { ...REFERENCE_SPOT_BINDING, assets: [{ id: WETH, decimals: 18, priceUsd: '3000', sellable: true }, { id: USDC, decimals: 6, priceUsd: '1', sellable: false }] });
    expect(odd.mandate.maxOrder).toEqual({ [WETH]: '333333333333333333' });                                          // rounded down; USDC cannot be sold
  });
  it('reports the enforcement of EVERY field', () => {
    expect(c.enforcement.map((e) => e.field)).toEqual(TRADING_MANDATE_FIELDS);
    const by = Object.fromEntries(c.enforcement.map((e) => [e.field, e.enforcedBy]));
    expect(by).toMatchObject({ accounts: 'signer', venues: 'signer', notAfter: 'signer', maxSlippageBps: 'signer', label: 'signer_partial', notBefore: 'signer_partial', mode: 'not_applicable', instruments: 'signer_partial', maxOrderNotionalUsd: 'signer_partial', frequency: 'signer_partial',
      maxCapitalUsd: 'api_only', maxPositionNotionalUsd: 'api_only', maxDailyLossUsd: 'api_only', floorEquityUsd: 'api_only', stopConditions: 'api_only', principal: 'api_only', maxFeeUsd: 'api_only', maxLeverage: 'not_applicable' });
  });
  it('the trading mandate is inside the mandate it compiles to', () => {
    expect(isSubsetOfSpotMandate(M, c.mandate, REFERENCE_SPOT_BINDING)).toEqual({ ok: true, violations: [] });
    expect(isSubsetOf(M, c.mandate, REFERENCE_SPOT_BINDING).ok).toBe(true);
    expect(isSubsetOf(M, c.mandate).ok).toBe(false);                                                                  // without the binding nothing can be compared
  });
  const errors: [TradingMandateErrorCode, Partial<TradingMandate>, Partial<typeof REFERENCE_SPOT_BINDING>?][] = [
    ['paper_mandate_has_no_signer_form', { mode: 'paper' }],
    ['market_kind_not_expressible', { marketKinds: ['perp'] }],
    ['account_not_in_mandate', { accounts: [HL_ACCOUNT] }],
    ['ambiguous_account', { accounts: [HL_ACCOUNT, VAULT, { kind: 'vault', vaultIndex: 2, address: '0x6666666666666666666666666666666666666666', network: 'base' }] }],
    ['instrument_not_expressible', { instruments: ['hyperliquid:BTC', 'kyberswap:WBTC-USDC'] }],
    ['missing_price', {}, { assets: REFERENCE_SPOT_BINDING.assets.slice(0, 1) }],
    ['missing_price', {}, { assets: [{ ...REFERENCE_SPOT_BINDING.assets[0]!, priceUsd: '0' }, REFERENCE_SPOT_BINDING.assets[1]!] }],
    ['strategy_hash_required', { principal: { kind: 'api_key', id: 'key-1' }, strategySha256: null }],
    ['value_not_expressible', { maxSlippageBps: 501 }],
    ['value_not_expressible', { maxSlippageBps: 9 }],
    ['value_not_expressible', { accounts: [HL_ACCOUNT, { kind: 'vault', vaultIndex: 1, address: 'So11111111111111111111111111111111111111112', network: 'base' }] }],
  ];
  it.each(errors)('fails with %s for %j', (c0, over, b) => { expect(code(() => compileToSpotMandate(mandate(over), { ...REFERENCE_SPOT_BINDING, ...b }))).toBe(c0); });
});

describe('trading mandate — whole-mandate compilation and subset', () => {
  it('compiles every venue of a live mandate', () => {
    const all = compileTradingMandate(M, { hyperliquid: binding, kyberswap: REFERENCE_SPOT_BINDING });
    expect(all.venue).toHaveLength(1); expect(all.spot).toHaveLength(1);
  });
  it('GMX has no signer-side mandate: compilation fails, typed', () => {
    const gmx = mandate({ venues: ['gmx', 'hyperliquid', 'kyberswap'], instruments: [...M.instruments, 'gmx:BTC-USD'], networks: [...M.networks, 'arbitrum'] });
    expect(() => validateTradingMandate(gmx, T)).not.toThrow();                                                       // a valid API-side mandate…
    expect(code(() => compileTradingMandate(gmx, { hyperliquid: binding, kyberswap: REFERENCE_SPOT_BINDING }))).toBe('no_signer_mandate_for_venue');   // …that the signer cannot bound
    expect(Object.keys(SIGNER_MANDATE_SHAPES).sort()).toEqual(['hyperliquid', 'kyberswap']);
  });
  it('a missing binding fails, typed', () => { expect(code(() => compileTradingMandate(M, { hyperliquid: binding }))).toBe('binding_mismatch'); expect(code(() => compileTradingMandate(M, {}))).toBe('binding_mismatch'); });
  it('widening the trading mandate beyond the signer mandate is detected, field by field', () => {
    const s = compileToVenueMandate(M, binding).mandate;
    const wide: [keyof TradingMandate, Partial<TradingMandate>][] = [
      ['maxOrderNotionalUsd', { maxOrderNotionalUsd: '1000.01' }], ['maxPositionNotionalUsd', { maxPositionNotionalUsd: '4000.01' }], ['maxLeverage', { maxLeverage: '4' }], ['maxCapitalUsd', { maxCapitalUsd: '5000.01' }],
      ['frequency', { frequency: { perMinute: 2, perHour: 21, perDay: 100 } }], ['frequency', { frequency: { perMinute: 2, perHour: 20, perDay: 101 } }], ['floorEquityUsd', { floorEquityUsd: '3999' }], ['maxSlippageBps', { maxSlippageBps: 51 }],
      ['notAfter', { notAfter: M.notAfter + 1 }], ['instruments', { instruments: [...M.instruments, 'hyperliquid:SOL'] }], ['strategySha256', { strategySha256: 'b'.repeat(64) }], ['mode', { mode: 'paper' }],
      ['accounts', { accounts: [VAULT] }],
    ];
    for (const [field, over] of wide) { const r = isSubsetOfVenueMandate(mandate(over), s); expect(r.ok).toBe(false); expect(r.violations.map((v) => v.field)).toContain(field); }
    // narrowing is fine
    expect(isSubsetOfVenueMandate(mandate({ maxOrderNotionalUsd: '500', maxLeverage: '2', frequency: { perMinute: 1, perHour: 5, perDay: 10 }, floorEquityUsd: '4500', notAfter: M.notAfter - 5, instruments: ['hyperliquid:BTC', 'kyberswap:WETH-USDC'] }), s).ok).toBe(true);
  });
  it('the same for the spot mandate', () => {
    const s = compileToSpotMandate(M, REFERENCE_SPOT_BINDING).mandate;
    for (const [field, over] of [['maxOrderNotionalUsd', { maxOrderNotionalUsd: '1001' }], ['frequency', { frequency: { perMinute: 2, perHour: 20, perDay: 101 } }], ['maxSlippageBps', { maxSlippageBps: 51 }], ['notAfter', { notAfter: M.notAfter + 1 }],
      ['instruments', { instruments: [...M.instruments, 'kyberswap:WBTC-USDC'] }], ['accounts', { accounts: [HL_ACCOUNT] }]] as [keyof TradingMandate, Partial<TradingMandate>][]) {
      const r = isSubsetOfSpotMandate(mandate(over), s, REFERENCE_SPOT_BINDING); expect(r.ok).toBe(false); expect(r.violations.map((v) => v.field)).toContain(field);
    }
    // the base-unit caps were fixed at 2 500 USD per WETH: if WETH falls to 2 000, the same USD limit is MORE base units than the signer allows
    const cheaper = { ...REFERENCE_SPOT_BINDING, assets: [{ ...REFERENCE_SPOT_BINDING.assets[0]!, priceUsd: '2000' }, REFERENCE_SPOT_BINDING.assets[1]!] };
    expect(isSubsetOfSpotMandate(M, s, cheaper).violations.map((v) => v.field)).toEqual(['maxOrderNotionalUsd']);
  });
  it('property: whatever compiles is a subset of its own compilation, and passes the signer-side validator', () => {
    const arb = fc.record({ cap: fc.integer({ min: 1500, max: 6000 }), order: fc.integer({ min: 100, max: 2000 }), pos: fc.integer({ min: 2000, max: 8000 }), lev: fc.integer({ min: 1, max: 5 }), floorPct: fc.integer({ min: 1, max: 99 }),
      perHour: fc.integer({ min: 1, max: 60 }), perDay: fc.integer({ min: 60, max: 200 }), slip: fc.integer({ min: 10, max: 300 }), days: fc.integer({ min: 1, max: 30 }) });
    fc.assert(fc.property(arb, (x) => {
      const m = mandate({ maxCapitalUsd: String(x.cap), maxOrderNotionalUsd: String(x.order), maxPositionNotionalUsd: String(x.pos), maxLeverage: String(x.lev), floorEquityUsd: String(Math.floor(x.cap * x.floorPct / 100)), maxDailyLossUsd: '100',
        frequency: { perMinute: 1, perHour: x.perHour, perDay: x.perDay }, maxSlippageBps: x.slip, notAfter: T + x.days * 86400 });
      let compiled;
      try { validateTradingMandate(m, T); compiled = compileToVenueMandate(m, binding); } catch (e) { expect(e).toBeInstanceOf(TradingMandateError); return; }
      expect(isSubsetOfVenueMandate(m, compiled.mandate).ok).toBe(true);
      expect(() => validateVenueMandate(compiled.mandate, REFERENCE_AUTHORIZATION, T)).not.toThrow();
      expect(compiled.enforcement).toHaveLength(TRADING_MANDATE_FIELDS.length);
    }), { numRuns: 300 });
  });
  it('renders the enforced-by table with one row per field', () => {
    const md = renderEnforcementTable(compileToVenueMandate(M, binding).enforcement, compileToSpotMandate(M, REFERENCE_SPOT_BINDING).enforcement);
    expect(md.split('\n')).toHaveLength(TRADING_MANDATE_FIELDS.length + 2);
    for (const f of TRADING_MANDATE_FIELDS) expect(md).toContain(`| \`${f}\` |`);
  });
});

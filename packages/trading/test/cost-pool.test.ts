/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/cost-pool.test.ts
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

// V11 additions to compare/cost.ts: depth at several distances, a venue without an order book (pool execution), a short-side
// carry of its own, annualised funding. The GMX figures are the market recorded read-only on 2026-11-15.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D, gmxBalanceOi, gmxPriceImpact, type GmxLiquidity, type Instrument, type Ticker } from '@spw/derivatives';
import { annualiseFunding, COST_ASSUMPTIONS, crossVenueDiscrepancy, depthWithin, gmxFeeSchedule, gmxFunding, gmxPoolExecution, POOL_ASSUMPTIONS, venueCost, type CostRequest, type PoolExecution, type VenueCostInput } from '../src/index.ts';
import { book, BTC, NOW, ticker } from './fixtures.ts';

const req = (over: Partial<CostRequest> = {}): CostRequest => ({ side: 'long', notionalUsd: '100000', leverage: '5', horizonHours: '24', depthBps: '5', liquidity: 'taker', now: NOW, maxAgeMs: 15_000, ...over });

describe('depthWithin', () => {
  it('sums price × size per side inside each distance, and says when the book ends before it', () => {
    // fixture book: mid 50 000, levels 5 USD (1 bp) apart, 1 BTC each, ten a side: the last ask is 50 050 = 10 bps
    const d = depthWithin(book(), ['1', '5', '10', '25'])!;
    expect(d.map((x) => x.bps)).toEqual(['1', '5', '10', '25']);
    expect(d[0]).toMatchObject({ askUsd: '50005', bidUsd: '49995', askComplete: true, bidComplete: true });
    expect(d[1]!.askUsd).toBe(String(50005 + 50010 + 50015 + 50020 + 50025));
    expect(d[2]).toMatchObject({ askUsd: '500275', bidUsd: '499725', askComplete: true, bidComplete: true });   // the whole book, which reaches exactly 10 bps
    expect(d[3]).toMatchObject({ askUsd: '500275', bidUsd: '499725', askComplete: false, bidComplete: false }); // 25 bps: a lower bound
    expect(depthWithin({ ...book(), asks: [] }, ['10'])).toBeNull();
    expect(() => depthWithin(book(), ['-1'])).toThrow(RangeError);
  });
});

describe('a venue without an order book', () => {
  const GMX: Instrument = { ...BTC, venue: 'gmx', symbol: 'BTC/USD [BTC-USDC]', id: 'gmx:BTC/USD [BTC-USDC]', lotSize: '0.00000001', maxLeverage: '100', marginModes: ['isolated'] };
  const pool = (over: Partial<PoolExecution> = {}): PoolExecution => ({ oracleMin: '49990', oracleMax: '50010', ts: NOW, source: 'test pool', impact: () => ({ usd: D.from('-30'), basis: 'test impact' }), ...over });
  const input = (over: Partial<VenueCostInput> = {}): VenueCostInput => ({ instrument: GMX, book: null, ticker: null, fees: { takerRate: '0.0006', makerRate: '0.0004', source: 'test' },
    funding: { rate: '0.00002', intervalSec: 3600, ts: NOW, source: 'test long' }, maintenanceMarginFraction: '0.005', pool: pool(), ...over });

  it('prices the legs at the oracle range plus the adverse price impact — hand-checked', () => {
    const r = venueCost(input(), req());
    expect(r.executionModel).toBe('pool');
    expect(r.midPrice.value).toBe('50000'); expect(r.spreadBps.value).toBe('4');           // (50 010 − 49 990) / 50 000
    expect(r.sizeBase.value).toBe('2');
    // entry (buy at the max): (50 010 − 50 000) × 2 = 20, plus 30 of impact against the trade = 50 USD → 5 bps of 100 000
    expect(r.entrySlippageUsd.value).toBe('50'); expect(r.entrySlippageBps.value).toBe('5'); expect(r.entryAvgPrice.value).toBe('50025');
    expect(r.exitSlippageUsd.value).toBe('50');
    expect(r.entryFeeUsd.value).toBe('60'); expect(r.fundingUsd.value).toBe('48');          // 100 000 × 0.00002 × 24
    expect(r.totalCostUsd.value).toBe('268'); expect(r.missing).toEqual([]);
    expect(r.depthAskUsd).toMatchObject({ value: null }); expect(r.depthAskUsd.reason).toMatch(/no order book/);
    expect(r.entrySlippageUsd.basis).toMatch(/oracle max/); expect(r.assumptions).toEqual(expect.arrayContaining([...POOL_ASSUMPTIONS]));
    expect(r.assumptions.some((a) => a.startsWith('the book supplied'))).toBe(false);
    // an order-book row is unchanged by the addition
    const b = venueCost({ instrument: BTC, book: book(), ticker: ticker(), fees: null, funding: null, maintenanceMarginFraction: null }, req());
    expect(b.executionModel).toBe('order_book'); expect(b.assumptions).toEqual([...COST_ASSUMPTIONS]);
  });
  it('a favourable impact is not credited; an impact that cannot be estimated leaves the slippage null with the reason', () => {
    expect(venueCost(input({ pool: pool({ impact: () => ({ usd: D.from('40'), basis: 'in favour' }) }) }), req()).entrySlippageUsd.value).toBe('20');
    const r = venueCost(input({ pool: pool({ impact: () => ({ usd: null, basis: 'the size is above the pool capacity' }) }) }), req());
    expect(r.entrySlippageUsd).toMatchObject({ value: null, reason: 'the size is above the pool capacity' }); expect(r.totalCostUsd.value).toBeNull(); expect(r.missing).toContain('entrySlippageUsd');
    expect(venueCost(input({ pool: pool({ ts: NOW - 60_000 }) }), req()).midPrice.reason).toMatch(/pool figures are 60000 ms old/);
    expect(venueCost(input({ pool: pool({ oracleMin: '50020' }) }), req()).midPrice.reason).toMatch(/oracle range/);
    // a book, when there is one, wins over the pool
    expect(venueCost(input({ book: { ...book(), instrument: GMX.id } }), req()).executionModel).toBe('order_book');
  });
  it('the short side has its own carry when the venue says so', () => {
    const short = { rate: '0.00001', intervalSec: 3600, ts: NOW, source: 'test short' };
    expect(venueCost(input({ fundingShort: short }), req({ side: 'short' })).fundingUsd.value).toBe('-24');      // shorts RECEIVE 0.00001 / h
    expect(venueCost(input({ fundingShort: short }), req({ side: 'long' })).fundingUsd.value).toBe('48');
    expect(venueCost(input({ fundingShort: { ...short, rate: '-0.00003' } }), req({ side: 'short' })).fundingUsd.value).toBe('72');   // shorts PAY
    expect(venueCost(input(), req({ side: 'short' })).fundingUsd.value).toBe('-48');                              // absent: the long rate, mirrored
    expect(venueCost(input({ fundingShort: null }), req({ side: 'short' })).fundingUsd.value).toBeNull();
  });
  it('a pool leg and a book leg can be compared: the discrepancy uses the pool\'s execution price', () => {
    const hl: VenueCostInput = { instrument: BTC, book: book(), ticker: ticker(), fees: { takerRate: '0.00045', makerRate: '0.00015', source: 'test' }, funding: { rate: '0', intervalSec: 3600, ts: NOW, source: 't' }, maintenanceMarginFraction: null };
    const d = crossVenueDiscrepancy(hl, input(), req(), '0');
    expect(d.reason).toBeNull(); expect(d.longVenue).toBe('hyperliquid'); expect(d.shortVenue).toBe('gmx');
    expect(Number(d.grossGapBps)).toBeLessThan(0);   // buy 50 007.5 on the book, sell 49 975 on the pool
    expect(d.flagged).toBe(false);
  });
});

describe('GMX helpers on the recorded market', () => {
  const rec = JSON.parse(readFileSync(new URL('../../../services/api/test/fixtures/markets-hub/gmx.json', import.meta.url), 'utf8')) as { recordedAt: number; liquidity: GmxLiquidity[]; instruments: Instrument[]; tickers: Ticker[] };
  const l = rec.liquidity.find((x) => x.instrument === 'gmx:BTC/USD [BTC-USDC]')!;
  it('the pool execution is the router\'s formula, capped, and refuses a size above the open capacity', () => {
    const p = gmxPoolExecution(l), size = D.from('1000');
    const oi = gmxBalanceOi(l), f = l.priceImpact;
    const want = gmxPriceImpact({ longOi: oi.long, shortOi: oi.short, sizeDeltaUsd: size, isLong: true, increase: true, virtualInventoryUsd: oi.virtualUsd,
      factorPositive: D.from(f.factorPositive), factorNegative: D.from(f.factorNegative), exponentPositive: D.from(f.exponentPositive), exponentNegative: D.from(f.exponentNegative) }).impactUsd;
    const got = p.impact(size, 'long', 'open');
    expect(got.usd).not.toBeNull();
    const cap = D.mul(size, D.from(D.isNeg(want) ? f.maxFactorNegative : f.maxFactorPositive));
    expect(D.str(got.usd!)).toBe(D.str(D.isNeg(want) ? D.max(want, D.neg(cap)) : D.min(want, cap)));
    expect(Math.abs(Number(D.str(got.usd!)))).toBeLessThan(5);       // a 1 000 USD order moves a pool of this size by cents
    expect(got.basis).toMatch(/opening of 1000 USD/);
    const huge = p.impact(D.add(D.from(l.capacityLongUsd), D.one), 'long', 'open');
    expect(huge.usd).toBeNull(); expect(huge.basis).toMatch(/above what can still be opened/);
    expect(p.oracleMin).toBe(l.oracleMin); expect(p.ts).toBe(l.ts);
  });
  it('fees and carry come from the market', () => {
    expect(gmxFeeSchedule(l)).toMatchObject({ takerRate: l.positionFeeFactor.balanceNotImproved, makerRate: l.positionFeeFactor.balanceImproved });
    const f = gmxFunding(l);
    expect(f.long.rate).toBe(D.str(D.neg(D.from(l.netRateLongPerHour)))); expect(f.short.rate).toBe(l.netRateShortPerHour); expect(f.long.intervalSec).toBe(3600);
    // a row from the recorded pool: complete, and cheap for 1 000 USD
    const inst = rec.instruments.find((i) => i.id === l.instrument)!;
    const r = venueCost({ instrument: inst, book: null, ticker: null, fees: gmxFeeSchedule(l), funding: f.long, fundingShort: f.short, maintenanceMarginFraction: l.minCollateralFactorForLiquidation, pool: gmxPoolExecution(l) },
      { side: 'long', notionalUsd: '1000', leverage: '3', horizonHours: '24', depthBps: '10', liquidity: 'taker', now: l.ts, maxAgeMs: 30_000 });
    expect(r.missing).toEqual([]); expect(Number(r.totalCostBps.value)).toBeGreaterThan(0); expect(Number(r.totalCostBps.value)).toBeLessThan(60);
    expect(r.collateralRequiredUsd.value).not.toBeNull(); expect(r.liquidationPrice.value).not.toBeNull();
  });
});

describe('annualiseFunding', () => {
  it('per hour and per year from the venue\'s interval, simple (not compounded)', () => {
    expect(annualiseFunding('0.0000125', 3600)).toEqual({ perHour: '0.0000125', perYear: '0.1095' });
    expect(annualiseFunding('0.00005', 14400)).toEqual({ perHour: '0.0000125', perYear: '0.1095' });          // edgeX: 4 h interval
    expect(annualiseFunding('-0.0001', 28800)).toEqual({ perHour: '-0.0000125', perYear: '-0.1095' });
    expect(() => annualiseFunding('0.1', 0)).toThrow(RangeError);
  });
});

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/cost.test.ts
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

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, initialMargin, liquidationPriceAtLeverage, ROUTER_FACTS, walkBook, type Book, type Instrument } from '@spw/derivatives';
import {
  compareVenues, COST_ASSUMPTIONS, COST_COMPONENTS, crossVenueDiscrepancy, DISCREPANCY_ASSUMPTIONS, DISCREPANCY_RISKS, findDiscrepancies, routerFeeSchedule, venueCost,
  type CostRequest, type VenueCostInput, type VenueCostRow,
} from '../src/index.ts';
import { book, BTC, NOW, ticker } from './fixtures.ts';

const req = (over: Partial<CostRequest> = {}): CostRequest => ({ side: 'long', notionalUsd: '100000', leverage: '5', horizonHours: '24', depthBps: '5', liquidity: 'taker', now: NOW, maxAgeMs: 15_000, ...over });
const input = (over: Partial<VenueCostInput> = {}): VenueCostInput => ({ instrument: BTC, book: book(), ticker: ticker(), fees: { takerRate: '0.00045', makerRate: '0.00015', source: 'test schedule' }, funding: null, maintenanceMarginFraction: '0.0125', ...over });
const GMX_BTC: Instrument = { ...BTC, venue: 'gmx', symbol: 'BTC-USD', id: 'gmx:BTC-USD', maxLeverage: '100' };
/** the fixture book shifted by `d` USD, for another instrument */
const shifted = (id: string, d: number): Book => ({ instrument: id, ts: NOW, bids: book().bids.map(([p, s]) => [String(Number(p) + d), s] as [string, string]), asks: book().asks.map(([p, s]) => [String(Number(p) + d), s] as [string, string]) });
const val = (r: VenueCostRow, k: keyof VenueCostRow): string | null => (r[k] as { value: string | null }).value;

describe('venue cost — one row', () => {
  const r = venueCost(input(), req());
  it('mid, spread and depth come from the book', () => {
    expect(val(r, 'midPrice')).toBe('50000');
    expect(val(r, 'spreadBps')).toBe('2');                                         // (50 005 − 49 995) / 50 000
    // within 5 bps of the mid (25 USD): asks 50 005 … 50 025 = 5 levels of 1 BTC
    expect(val(r, 'depthAskUsd')).toBe(String(50005 + 50010 + 50015 + 50020 + 50025));
    expect(val(r, 'depthBidUsd')).toBe(String(49995 + 49990 + 49985 + 49980 + 49975));
  });
  it('size = notional / mid, down to the lot; slippage by walking the book (router.walkBook)', () => {
    expect(val(r, 'sizeBase')).toBe('2');
    const w = walkBook(book().asks, D.from('2'), 'buy', null);
    expect(val(r, 'entryAvgPrice')).toBe(D.str(w.avg!));                           // 50 007.5
    expect(val(r, 'entrySlippageUsd')).toBe('15');                                 // (50 007.5 − 50 000) × 2
    expect(val(r, 'entrySlippageBps')).toBe('1.5');
    expect(val(r, 'exitSlippageUsd')).toBe('15');                                  // selling 2 into the bids: 49 992.5
  });
  it('fees: the taker or the maker rate on the position\'s notional, entry and exit', () => {
    expect(val(r, 'entryFeeUsd')).toBe('45'); expect(val(r, 'exitFeeUsd')).toBe('45');
    expect(val(venueCost(input(), req({ liquidity: 'maker' })), 'entryFeeUsd')).toBe('15');
    expect(r.entryFeeUsd.basis).toContain('test schedule');
  });
  it('funding: the current rate held constant, with the assumption stated; longs pay, shorts receive', () => {
    expect(val(r, 'fundingRatePerHour')).toBe('0.0000125');
    expect(val(r, 'fundingUsd')).toBe('30');                                       // 100 000 × 0.0000125 × 24
    expect(r.fundingUsd.basis).toMatch(/held constant for 24 h/);
    expect(val(venueCost(input(), req({ side: 'short' })), 'fundingUsd')).toBe('-30');
    expect(val(venueCost(input(), req({ horizonHours: '0' })), 'fundingUsd')).toBe('0');
    // an explicit funding input with an 8 h interval: 0.0001 per 8 h = 0.0000125 per hour
    expect(val(venueCost(input({ funding: { rate: '0.0001', intervalSec: 28_800, ts: NOW, source: 'venue API' } }), req()), 'fundingUsd')).toBe('30');
    expect(val(venueCost(input({ ticker: ticker({ funding: '-0.0000125' }) }), req()), 'fundingUsd')).toBe('-30');
  });
  it('collateral, liquidation price and distance use margin.ts', () => {
    expect(val(r, 'collateralRequiredUsd')).toBe(D.str(initialMargin(D.from('100000'), D.from('5'))));
    const liq = liquidationPriceAtLeverage({ side: 'long', entryPrice: D.from('50007.5'), leverage: D.from('5'), maintenanceFraction: D.from('0.0125') }).value!;
    expect(val(r, 'liquidationPrice')).toBe(D.str(D.div(liq, D.one, 10, 'half_even')));
    expect(Number(val(r, 'liquidationDistanceBps'))).toBeGreaterThan(1800); expect(Number(val(r, 'liquidationDistanceBps'))).toBeLessThan(2000);
    expect(val(r, 'maxLeverage')).toBe('40');
  });
  it('total = the five itemised components, and nothing else', () => {
    expect(COST_COMPONENTS).toEqual(['entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'exitFeeUsd', 'fundingUsd']);
    expect(val(r, 'totalCostUsd')).toBe('150');                                    // 15 + 15 + 45 + 45 + 30
    expect(val(r, 'totalCostBps')).toBe('15');
    expect(r.missing).toEqual([]);
    expect(r.assumptions).toEqual([...COST_ASSUMPTIONS]);
  });
  it('every non-null figure says how it was obtained; every null one says why', () => {
    for (const k of Object.keys(r) as (keyof VenueCostRow)[]) {
      const f = r[k] as { value?: string | null; reason?: string | null; basis?: string | null };
      if (typeof f !== 'object' || f === null || !('value' in f)) continue;
      if (f.value === null) expect(f.reason).toBeTruthy(); else { expect(f.reason).toBeNull(); expect(f.basis).toBeTruthy(); }
    }
  });
});

describe('venue cost — missing inputs are null with a reason, never estimated', () => {
  const nullOf = (over: Partial<VenueCostInput>, r: Partial<CostRequest> = {}) => { const row = venueCost(input(over), req(r)); return { row, nulls: (Object.keys(row) as (keyof VenueCostRow)[]).filter((k) => (row[k] as { value?: unknown })?.value === null) }; };
  it('no book: everything that needs it is null; the total is null and lists what is missing', () => {
    const { row, nulls } = nullOf({ book: null });
    expect(nulls).toEqual(expect.arrayContaining(['midPrice', 'spreadBps', 'depthBidUsd', 'depthAskUsd', 'sizeBase', 'entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'fundingUsd', 'collateralRequiredUsd', 'liquidationPrice', 'totalCostUsd']));
    expect(row.midPrice.reason).toBe('no order book was supplied');
    expect(row.missing).toEqual([...COST_COMPONENTS]);
    expect(row.totalCostUsd.reason).toMatch(/^incomplete: entrySlippageUsd/);
    expect(val(row, 'maxLeverage')).toBe('40');                                     // what does not depend on the book is still there
  });
  it('no fee schedule: the fees and the total are null, the rest is not', () => {
    const { row } = nullOf({ fees: null });
    expect(row.entryFeeUsd).toEqual({ value: null, reason: 'no fee schedule was supplied', basis: null });
    expect(row.missing).toEqual(['entryFeeUsd', 'exitFeeUsd']); expect(val(row, 'totalCostUsd')).toBeNull(); expect(val(row, 'entrySlippageUsd')).toBe('15');
  });
  it('no funding: null with the reason that applies', () => {
    expect(nullOf({ ticker: null }).row.fundingUsd.reason).toBe('no funding rate and no ticker were supplied');
    expect(nullOf({ ticker: ticker({ funding: null }) }).row.fundingUsd.reason).toBe('the venue publishes no funding rate in its ticker');
    expect(nullOf({ ticker: ticker({ ts: NOW - 60_000 }) }).row.fundingUsd.reason).toMatch(/stale/);
    expect(nullOf({ funding: { rate: '0.0001', intervalSec: 3600, ts: NOW - 60_000, source: 'x' } }).row.fundingUsd.reason).toMatch(/ms old/);
    expect(nullOf({ funding: { rate: '0.0001', intervalSec: 0, ts: NOW, source: 'x' } }).row.fundingUsd.reason).toMatch(/interval/);
    expect(nullOf({ ticker: null }).row.missing).toEqual(['fundingUsd']);
  });
  it('no maintenance fraction: no liquidation estimate, the total is unaffected', () => {
    const { row } = nullOf({ maintenanceMarginFraction: null });
    expect(row.liquidationPrice.reason).toBe('the maintenance margin fraction was not supplied'); expect(val(row, 'liquidationDistanceBps')).toBeNull(); expect(val(row, 'totalCostUsd')).toBe('150');
  });
  it('a stale, crossed, one-sided or foreign book is treated as missing', () => {
    expect(nullOf({ book: book({ ts: NOW - 15_001 }) }).row.midPrice.reason).toMatch(/ms old/);
    expect(nullOf({ book: book({ asks: [] }) }).row.midPrice.reason).toMatch(/empty side/);
    expect(nullOf({ book: book({ instrument: 'hyperliquid:ETH' }) }).row.midPrice.reason).toMatch(/another instrument/);
    expect(nullOf({ book: book({ bids: [['50010', '1']] }) }).row.midPrice.reason).toMatch(/crossed/);
  });
  it('a book too thin for the notional: the slippage is null — the missing depth is not extrapolated', () => {
    const { row } = nullOf({}, { notionalUsd: '1000000' });                          // 20 BTC against 10 on each side
    expect(row.entrySlippageUsd.reason).toMatch(/fills only 10 of 20 on the ask side/);
    expect(row.exitSlippageUsd.reason).toMatch(/bid side/);
    expect(val(row, 'entryFeeUsd')).toBe('450');                                    // fees are still known
    expect(val(row, 'totalCostUsd')).toBeNull();
  });
  it('a notional below one lot, or a leverage above the venue\'s maximum', () => {
    expect(nullOf({}, { notionalUsd: '10' }).row.sizeBase.reason).toBe('the notional is below one lot');
    const { row } = nullOf({}, { leverage: '50' });
    expect(row.collateralRequiredUsd.reason).toMatch(/above the venue's maximum 40/); expect(row.liquidationPrice.reason).toMatch(/maximum/); expect(val(row, 'totalCostUsd')).toBe('150');
  });
  it('refuses nonsense requests', () => {
    expect(() => venueCost(input(), req({ notionalUsd: '0' }))).toThrow(RangeError);
    expect(() => venueCost(input(), req({ leverage: '-1' }))).toThrow(RangeError);
    expect(() => venueCost(input(), req({ horizonHours: '-1' }))).toThrow(RangeError);
    expect(() => venueCost(input(), req({ now: Number.NaN }))).toThrow(RangeError);
  });
});

describe('venue cost — table and fee facts', () => {
  it('one comparable row per venue, in the order given', () => {
    const rows = compareVenues([input(), input({ instrument: GMX_BTC, book: shifted('gmx:BTC-USD', 0), ticker: ticker({ instrument: 'gmx:BTC-USD' }), fees: null })], req());
    expect(rows.map((x) => x.venue)).toEqual(['hyperliquid', 'gmx']);
    expect(Object.keys(rows[0]!)).toEqual(Object.keys(rows[1]!));
    expect(val(rows[0]!, 'totalCostUsd')).toBe('150'); expect(val(rows[1]!, 'totalCostUsd')).toBeNull(); expect(rows[1]!.missing).toEqual(['entryFeeUsd', 'exitFeeUsd']);
  });
  it('routerFeeSchedule reuses the router\'s reviewed constants', () => {
    expect(routerFeeSchedule('hyperliquid')).toMatchObject({ takerRate: ROUTER_FACTS.hyperliquid.takerRate, makerRate: ROUTER_FACTS.hyperliquid.makerRate });
    expect(routerFeeSchedule('dydx')!.takerRate).toBe('0.0005');
    expect(routerFeeSchedule('gmx')).toBeNull();                                     // GMX fee factors are per market: not a constant
  });
  it('properties: costs grow with the notional; a long\'s and a short\'s funding cancel; the total is the sum of its parts', () => {
    fc.assert(fc.property(fc.integer({ min: 1000, max: 240_000 }), fc.integer({ min: 1000, max: 240_000 }), fc.integer({ min: 0, max: 500 }), fc.integer({ min: -400, max: 400 }), (a, b, hours, rate) => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const mk = (n: number, side: 'long' | 'short') => venueCost(input({ ticker: ticker({ funding: D.str(D.div(D.from(BigInt(rate)), D.from(10_000_000n), 7, 'down')) }) }), req({ notionalUsd: String(n), horizonHours: String(hours), side }));
      const x = mk(lo, 'long'), y = mk(hi, 'long'), s = mk(hi, 'short');
      for (const k of ['entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'exitFeeUsd'] as const) expect(D.lte(D.from(val(x, k)!), D.from(val(y, k)!))).toBe(true);
      expect(D.isZero(D.add(D.from(val(y, 'fundingUsd')!), D.from(val(s, 'fundingUsd')!)))).toBe(true);
      const sum = COST_COMPONENTS.reduce((acc, k) => D.add(acc, D.from(val(y, k)!)), D.zero);
      expect(val(y, 'totalCostUsd')).toBe(D.str(D.div(sum, D.one, 6, 'half_even')));
      expect(D.isNeg(D.from(val(y, 'entrySlippageUsd')!))).toBe(false);
    }), { numRuns: 200 });
  });
});

describe('cross-venue discrepancy', () => {
  const hl = input();
  const gmx = (d: number, over: Partial<VenueCostInput> = {}): VenueCostInput => input({ instrument: GMX_BTC, book: shifted('gmx:BTC-USD', d), ticker: ticker({ instrument: 'gmx:BTC-USD' }), fees: { takerRate: '0.0005', makerRate: '0.0005', source: 'test' }, ...over });
  const r0 = { notionalUsd: '100000', leverage: '5', horizonHours: '0', depthBps: '5', liquidity: 'taker' as const, now: NOW, maxAgeMs: 15_000 };
  it('reports the gap gross and net of every cost, with assumptions and risks', () => {
    const d = crossVenueDiscrepancy(hl, gmx(200), r0, '5');
    // the hedge is the smaller size on both venues: 100 000 / 50 200 = 1.992 BTC
    // long on Hyperliquid: 1 @ 50 005 + 0.992 @ 50 010 = 50 007.4899598…; short on GMX: 1 @ 50 195 + 0.992 @ 50 190 = 50 192.5100402…
    expect(d).toMatchObject({ longVenue: 'hyperliquid', shortVenue: 'gmx', longInstrument: 'hyperliquid:BTC', shortInstrument: 'gmx:BTC-USD', reason: null });
    expect(d.grossGapBps).toBe('36.9985');                                          // 368.56 / 99 614.92
    // fees: 2 × 99 600 × 0.045 % + 2 × 99 998.4 × 0.05 %; exit slippage: 14.92 on each venue
    expect(d.costsUsd).toEqual({ feesUsd: '189.6384', exitSlippageUsd: '29.84', fundingUsd: '0' });
    expect(d.netEdgeEstimateBps).toBe('14.9658');                                   // (368.56 − 189.6384 − 29.84) / 99 614.92
    expect(d.flagged).toBe(true);
    expect(d.assumptions).toEqual([...DISCREPANCY_ASSUMPTIONS]); expect(d.risks).toEqual([...DISCREPANCY_RISKS]);
    expect(d.assumptions.length).toBeGreaterThanOrEqual(5); expect(d.risks.length).toBeGreaterThanOrEqual(5);
  });
  it('never calls it a profit, and never promises anything', () => {
    const d = crossVenueDiscrepancy(hl, gmx(200), r0, '5');
    expect(Object.keys(d)).toContain('netEdgeEstimateBps');
    expect(JSON.stringify(d)).not.toMatch(/profit|guarantee|risk-free|riskless|arbitrage/i);
    expect(JSON.stringify(Object.keys(d))).not.toMatch(/profit|pnl|gain/i);
  });
  it('a gap smaller than the costs is a negative estimate and is not flagged', () => {
    const d = crossVenueDiscrepancy(hl, gmx(20), r0, '5');
    expect(D.isNeg(D.from(d.netEdgeEstimateBps!))).toBe(true); expect(d.flagged).toBe(false);
    expect(crossVenueDiscrepancy(hl, gmx(200), r0, '15').flagged).toBe(false);       // 14.97 is not above 15
  });
  it('funding over the horizon is part of the costs, on both legs', () => {
    const paying = crossVenueDiscrepancy(hl, gmx(200, { ticker: ticker({ instrument: 'gmx:BTC-USD', funding: '0' }) }), { ...r0, horizonHours: '24' }, '5');
    expect(paying.costsUsd!.fundingUsd).toBe('29.88');                               // the long pays 99 600 × 0.0000125 × 24 on Hyperliquid; GMX's rate is zero
    expect(D.lt(D.from(paying.netEdgeEstimateBps!), D.from('14.9658'))).toBe(true);
    const offset = crossVenueDiscrepancy(hl, gmx(200), { ...r0, horizonHours: '24' }, '5');
    expect(offset.costsUsd!.fundingUsd).toBe('-0.11952');                            // the short receives 29.99952 on GMX's slightly larger notional
  });
  it('incomplete inputs give no estimate, with the reason', () => {
    const d = crossVenueDiscrepancy(hl, gmx(200, { fees: null }), r0, '5');
    expect(d).toMatchObject({ netEdgeEstimateBps: null, grossGapBps: null, costsUsd: null, flagged: false });
    expect(d.reason).toMatch(/incomplete: gmx fee \(no fee schedule was supplied\)/);
    expect(d.assumptions.length).toBeGreaterThan(0); expect(d.risks.length).toBeGreaterThan(0);
    expect(crossVenueDiscrepancy(hl, gmx(200, { book: null }), r0, '5').reason).toMatch(/no order book/);
    expect(crossVenueDiscrepancy(hl, gmx(200, { instrument: { ...GMX_BTC, base: 'ETH' } }), r0, '5').reason).toMatch(/same base asset/);
  });
  it('findDiscrepancies looks at every ordered pair and puts the highest estimate first', () => {
    const all = findDiscrepancies([hl, gmx(200), gmx(200, { fees: null, instrument: { ...GMX_BTC, id: 'gmx:BTC-USD' } })], r0, '5');
    expect(all).toHaveLength(6);
    expect(all[0]).toMatchObject({ longVenue: 'hyperliquid', shortVenue: 'gmx', flagged: true });
    expect(all.filter((x) => x.flagged)).toHaveLength(1);
    const est = all.map((x) => x.netEdgeEstimateBps);
    expect(est.indexOf(null)).toBeGreaterThan(0);                                    // the pairs without an estimate come last
    expect(est.slice(est.indexOf(null)).every((x) => x === null)).toBe(true);
  });
});

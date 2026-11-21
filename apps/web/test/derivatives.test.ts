/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/derivatives.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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
import { bpsBetween, D, dec, dpOf, fmt, fundingPerHour, naturalStep, numToDecStr, onTick, parseInput, pct, priceDp, quantizePrice, stepAt, toFixed, usd, usdToSize, worstPrice } from '../src/derivatives/dec.ts';
import { aggregateBars, applyTick, groupBook, mergeBook, mergeTrades, sma, toBars, type Bar } from '../src/derivatives/reducers.ts';
import type { Book, PublicTrade } from '../src/derivatives/types.ts';

const NB = ' ';

describe('decimal and formatting helpers', () => {
  it('formats in French and English without going through a JS number', () => {
    expect(fmt('1234567.891', { dp: 2, locale: 'fr' })).toBe(`1${NB}234${NB}567,89`);
    expect(fmt('1234567.891', { dp: 2, locale: 'en' })).toBe('1,234,567.89');
    expect(fmt('123456789012345678901234.5', { dp: 1, locale: 'en' })).toBe('123,456,789,012,345,678,901,234.5');   // beyond double precision
    expect(fmt('-0.004', { dp: 2, locale: 'fr' })).toBe('0,00');                 // no "−0,00"
    expect(fmt('-12.5', { dp: 1, locale: 'fr' })).toBe('−12,5');
    expect(fmt('12.5', { dp: 1, locale: 'fr', sign: true })).toBe('+12,5');
    expect(fmt('0.25', { dp: 2, locale: 'en' })).toBe('0.25');
    expect(fmt('2.5000', { locale: 'fr', trim: true })).toBe('2,5');
    expect(fmt(null)).toBe('—');
    expect(fmt('abc')).toBe('—');
  });
  it('rounds half to even and pads', () => {
    expect(toFixed(D.from('1.005'), 2)).toBe('1.00');
    expect(toFixed(D.from('1.015'), 2)).toBe('1.02');
    expect(toFixed(D.from('-2.5'), 0)).toBe('-2');
    expect(toFixed(D.from('7'), 3)).toBe('7.000');
  });
  it('percentages, dollars, basis points', () => {
    expect(pct('0.0123', 2, 'fr')).toBe(`1,23${NB}%`);
    expect(pct('-0.0000125', 5, 'en', true)).toBe(`−0.00125${NB}%`);
    expect(usd('1234.5', 'fr')).toBe(`1${NB}234,50${NB}$`);
    expect(usd('-1234.5', 'en', true)).toBe('−$1,234.50');
    expect(usd('3', 'en', true)).toBe('+$3.00');
    expect(D.str(bpsBetween(D.from('101'), D.from('100'))!)).toBe('100');
    expect(bpsBetween(D.from('1'), D.zero)).toBeNull();
  });
  it('normalises funding to the hour', () => {
    expect(D.str(fundingPerHour('0.0001', 28800)!)).toBe('0.0000125');
    expect(D.str(fundingPerHour('0.0000125', 3600)!)).toBe('0.0000125');
    expect(fundingPerHour(null, 3600)).toBeNull();
  });
  it('parses what an owner types', () => {
    expect(parseInput(`1${NB}234,5`)).toBe('1234.5');
    expect(parseInput('1,234.50')).toBe('1234.5');
    expect(parseInput('0,010')).toBe('0.01');
    expect(parseInput('.5')).toBe('0.5');
    expect(parseInput('007')).toBe('7');
    expect(parseInput('1e5')).toBeNull();
    expect(parseInput('-3')).toBeNull();
    expect(parseInput('')).toBeNull();
    expect(parseInput('1.2.3')).toBeNull();
  });
  it('sizes and worst prices stay on the lot and the tick, inside the bound', () => {
    expect(D.str(usdToSize(D.from('1500'), D.from('73716'), D.from('0.00001')))).toBe('0.02034');      // rounded DOWN
    expect(D.str(usdToSize(D.from('5'), D.from('73716'), D.from('0.001')))).toBe('0');
    expect(D.str(worstPrice(D.from('73716'), 'buy', 50, D.from('1')))).toBe('74084');                  // 74084.58 → down
    expect(D.str(worstPrice(D.from('73716'), 'sell', 50, D.from('1')))).toBe('73348');                 // 73347.42 → up
    expect(D.str(onTick(D.from('2090.57'), D.from('0.1')))).toBe('2090.5');
  });
  it('Hyperliquid price grid: five significant figures, never finer than the tick, integers always allowed', () => {
    const tick = D.from('0.1');
    expect(D.str(stepAt('hyperliquid', tick, D.from('73716')))).toBe('1');
    expect(D.str(stepAt('hyperliquid', tick, D.from('2090.5')))).toBe('0.1');
    expect(D.str(stepAt('hyperliquid', D.from('0.000001'), D.from('0.012345')))).toBe('0.000001');
    expect(D.str(stepAt('hyperliquid', D.from('0.0001'), D.from('157.3')))).toBe('0.01');
    expect(D.str(stepAt('hyperliquid', tick, D.from('123456')))).toBe('1');
    expect(D.str(stepAt('dydx', tick, D.from('73716')))).toBe('0.1');
    expect(D.str(quantizePrice('hyperliquid', tick, D.from('72241.7'), 'down'))).toBe('72241');
    expect(D.str(quantizePrice('hyperliquid', tick, D.from('72241.7'), 'up'))).toBe('72242');
    expect(D.str(worstPrice(D.from('73716.5'), 'buy', 50, tick, 'hyperliquid'))).toBe('74085');
  });
  it('display decimals and book step', () => {
    expect(dpOf('0.001')).toBe(3); expect(dpOf('1')).toBe(0);
    expect(priceDp('0.1', '73716.5')).toBe(1);
    expect(priceDp('0.0000000000000000000001', '73591.2622')).toBe(1);   // GMX: 22 decimals of precision, 6 significant digits shown
    expect(priceDp('0.000001', '0.012345')).toBe(6);
    expect(naturalStep([[['73716', '1'], ['73715', '2'], ['73713', '1']], [['73717', '1'], ['73718', '1']]], '0.1')).toBe('1');
    expect(naturalStep([[], []], '0.5')).toBe('0.5');
    expect(numToDecStr(4.5)).toBe('4.5'); expect(numToDecStr(1e-7)).toBe('0.0000001'); expect(dec(3)?.m).toBe(3n); expect(dec('1e3')).toBeNull();
  });
});

const book = (ts: number, bids: [string, string][], asks: [string, string][], instrument = 'hyperliquid:BTC'): Book => ({ instrument, bids, asks, ts });

describe('order book reducer', () => {
  it('accepts a newer snapshot, ignores an older one and another instrument', () => {
    const a = mergeBook(null, book(10, [['100', '1']], [['101', '1']]), 'hyperliquid:BTC')!;
    expect(a.ts).toBe(10);
    expect(mergeBook(a, book(9, [['99', '1']], [['100', '1']]), 'hyperliquid:BTC')).toBe(a);
    expect(mergeBook(a, book(11, [['99', '1']], [['100', '1']], 'hyperliquid:ETH'), 'hyperliquid:BTC')).toBe(a);
    expect(mergeBook(a, null, 'hyperliquid:BTC')).toBe(a);
    expect(mergeBook(a, book(11, [['99', '1']], [['100', '1']]), 'hyperliquid:BTC')!.bids[0]).toEqual(['99', '1']);
  });
  it('sorts, merges duplicate prices, drops empty and malformed levels, uncrosses', () => {
    const b = mergeBook(null, book(1, [['99', '1'], ['100', '2'], ['100.0', '0.5'], ['98', '0'], ['x', '1']], [['103', '1'], ['101', '3'], ['102', '-1']]), 'hyperliquid:BTC')!;
    expect(b.bids).toEqual([['100', '2.5'], ['99', '1']]);
    expect(b.asks).toEqual([['101', '3'], ['103', '1']]);
    const crossed = mergeBook(null, book(1, [['102', '1'], ['100', '5']], [['101', '4'], ['103', '1']]), 'hyperliquid:BTC')!;
    expect(D.cmp(D.from(crossed.bids[0]![0]), D.from(crossed.asks[0]![0]))).toBe(-1);
  });
  it('groups by step with exact totals; bids round down, asks round up; spread is the raw one', () => {
    const b = book(1, [['100.4', '1'], ['100.1', '0.1'], ['99.9', '0.2'], ['99.2', '3']], [['100.6', '0.3'], ['100.9', '0.7'], ['101.2', '1']]);
    const v = groupBook(b, '1', 10);
    expect(v.bids.map((r) => [r.price, r.size, r.total])).toEqual([['100', '1.1', '1.1'], ['99', '3.2', '4.3']]);
    expect(v.asks.map((r) => [r.price, r.size, r.total])).toEqual([['101', '1', '1'], ['102', '1', '2']]);
    expect(v.spread).toBe('0.2');
    expect(v.mid).toBe('100.5');
    expect(v.spreadBps).toBe('19.9');
    expect(v.bids[1]!.depth).toBe(1);
    expect(groupBook(b, '1', 1).bids).toHaveLength(1);
    expect(groupBook(b, '0.1', 10).bids).toHaveLength(4);
    expect(groupBook(null, '1', 5).spread).toBeNull();
    expect(groupBook(b, '0', 5).bids).toEqual([]);
    // 0.1 + 0.2 is exact here, unlike with doubles
    expect(groupBook(book(1, [['10', '0.1'], ['10', '0.2']], [['11', '1']]), '1', 5).bids[0]!.size).toBe('0.3');
  });
});

describe('trades reducer', () => {
  const tr = (id: string, ts: number): PublicTrade => ({ instrument: 'hyperliquid:BTC', price: '100', size: '1', side: 'buy', ts, id });
  it('keeps the newest first, one row per id, capped', () => {
    const a = mergeTrades([], [tr('a', 1), tr('b', 3), tr('c', 2)]);
    expect(a.map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(mergeTrades(a, [tr('b', 3), tr('d', 4)]).map((t) => t.id)).toEqual(['d', 'b', 'c', 'a']);
    expect(mergeTrades(a, [])).toBe(a);
    expect(mergeTrades(a, [tr('e', 9), tr('f', 8)], 3).map((t) => t.id)).toEqual(['e', 'f', 'b']);
  });
});

describe('candle reducers', () => {
  const bar = (ts: number, o: number, h: number, l: number, c: number, v = 1): Bar => ({ ts, o, h, l, c, v });
  it('aggregates finer candles into aligned buckets', () => {
    const m = 60_000, src = [bar(0, 10, 12, 9, 11), bar(m, 11, 15, 10, 14, 2), bar(2 * m, 14, 14, 8, 9, 3), bar(5 * m, 9, 10, 9, 10), bar(6 * m, 10, 11, 7, 8)];
    expect(aggregateBars(src, 5 * m)).toEqual([bar(0, 10, 15, 8, 9, 6), bar(5 * m, 9, 11, 7, 8, 2)]);
    expect(aggregateBars([], m)).toEqual([]);
  });
  it('applies a live tick: updates the current candle, opens the next at the previous close, ignores the past', () => {
    const m = 60_000, s0 = [bar(0, 10, 12, 9, 11)];
    const s1 = applyTick(s0, m, 13, 30_000, 0.5);
    expect(s1).toEqual([bar(0, 10, 13, 9, 13, 1.5)]);
    expect(applyTick(s1, m, 13, 31_000)).toBe(s1);                       // nothing changed: same array, no redraw
    const s2 = applyTick(s1, m, 12, 61_000);
    expect(s2[1]).toEqual(bar(m, 13, 13, 12, 12, 0));
    expect(applyTick(s2, m, 99, 10_000)).toBe(s2);                       // older than the last candle
    expect(applyTick(s2, m, Number.NaN, 70_000)).toBe(s2);
    expect(applyTick([], m, 5, 125_000)).toEqual([bar(2 * m, 5, 5, 5, 5, 0)]);
    let s = s0; for (let i = 1; i <= 10; i++) s = applyTick(s, m, 10 + i, i * m, 0, 5);
    expect(s).toHaveLength(5);
  });
  it('converts API candles and computes a moving average', () => {
    const bars = toBars([{ ts: 2, open: '2', high: '3', low: '1', close: '2.5', volume: '10' }, { ts: 1, open: '1', high: '2', low: '1', close: '2', volume: '5' }, { ts: 3, open: 'x', high: '1', low: '1', close: '1', volume: '1' }]);
    expect(bars.map((b) => b.ts)).toEqual([1, 2]);
    expect(sma([bar(0, 0, 0, 0, 1), bar(1, 0, 0, 0, 2), bar(2, 0, 0, 0, 3), bar(3, 0, 0, 0, 5)], 3)).toEqual([null, null, 2, 10 / 3]);
  });
});

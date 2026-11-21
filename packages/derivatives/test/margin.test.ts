/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/margin.test.ts
 * Module           : derivatives
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
import {
  applyOrderToPosition, D, effectiveLeverage, exposureByAsset, freeCollateralAfterOrder, grossExposure, initialMargin, liquidationPriceAtLeverage,
  liquidationPriceCross, liquidationPriceIsolated, maintenanceMargin, netExposure, notional, signedSize, unrealizedPnl,
  type ExposureInput, type PositionLite, type Side,
} from '../src/index.ts';
import { d, prng, randDec, randInt, s } from './helpers.ts';

const N = 300;

describe('margin: hand-computed examples', () => {
  it('notional, initial and maintenance margin', () => {
    // 0.5 BTC at 60 000 = 30 000 ; the sign of the size does not matter
    expect(s(notional(d('0.5'), d('60000')))).toBe('30000');
    expect(s(notional(d('-0.5'), d('60000')))).toBe('30000');
    // 30 000 / 20x = 1 500
    expect(s(initialMargin(d('30000'), d('20')))).toBe('1500');
    // 100 / 3 = 33.333… rounded UP at 18 decimals
    expect(s(initialMargin(d('100'), d('3')))).toBe('33.333333333333333334');
    // 30 000 · 0.5 % = 150
    expect(s(maintenanceMargin(d('30000'), d('0.005')))).toBe('150');
    expect(() => initialMargin(d('100'), d('0'))).toThrow(RangeError);
    expect(() => initialMargin(d('-1'), d('2'))).toThrow(RangeError);
  });

  it('unrealized PnL, long and short', () => {
    // long 0.5 from 60 000 to 61 000: 0.5 · 1 000 = +500 ; the same move costs a short 500
    expect(s(unrealizedPnl('long', d('0.5'), d('60000'), d('61000')))).toBe('500');
    expect(s(unrealizedPnl('short', d('0.5'), d('60000'), d('61000')))).toBe('-500');
    // short 3 from 2 000 to 1 950.5: 3 · 49.5 = +148.5
    expect(s(unrealizedPnl('short', d('3'), d('2000'), d('1950.5')))).toBe('148.5');
    expect(s(unrealizedPnl('long', d('3'), d('2000'), d('2000')))).toBe('0');
  });

  it('exposure and effective leverage of an account', () => {
    // long 0.5 BTC @ 60 000 = 30 000 ; short 10 ETH @ 2 000 = 20 000 ; long 100 SOL @ 150 = 15 000
    const positions: ExposureInput[] = [
      { asset: 'BTC', side: 'long', size: d('0.5'), markPrice: d('60000') },
      { asset: 'ETH', side: 'short', size: d('10'), markPrice: d('2000') },
      { asset: 'SOL', side: 'long', size: d('100'), markPrice: d('150') },
    ];
    expect(s(grossExposure(positions))).toBe('65000');          // 30 000 + 20 000 + 15 000
    expect(s(netExposure(positions))).toBe('25000');            // 30 000 − 20 000 + 15 000
    const by = exposureByAsset([...positions, { asset: 'BTC', side: 'short', size: d('0.1'), markPrice: d('60000') }]);
    expect(s(by.BTC!.long)).toBe('30000');
    expect(s(by.BTC!.short)).toBe('6000');                      // 0.1 · 60 000
    expect(s(by.BTC!.net)).toBe('24000');
    expect(s(by.BTC!.gross)).toBe('36000');
    expect(s(by.ETH!.net)).toBe('-20000');
    expect(Object.keys(by).sort()).toEqual(['BTC', 'ETH', 'SOL']);
    // 65 000 / 13 000 = 5x ; 65 000 / 30 000 = 2.1666… rounded up
    expect(s(effectiveLeverage(d('13000'), positions)!)).toBe('5');
    expect(s(effectiveLeverage(d('30000'), positions)!)).toBe('2.166666666666666667');
    expect(effectiveLeverage(d('0'), positions)).toBeNull();
    expect(effectiveLeverage(d('-5'), positions)).toBeNull();
    expect(s(effectiveLeverage(d('100'), [])!)).toBe('0');
  });

  it('isolated liquidation price, long', () => {
    // long 10 @ 100 with 100 of margin (10x), maintenance 6.25 %:
    //   p = (100·10 − 100) / (10 · (1 − 0.0625)) = 900 / 9.375 = 96
    //   check at 96: equity = 100 + 10·(96 − 100) = 60 ; maintenance = 0.0625 · 10 · 96 = 60
    const r = liquidationPriceIsolated({ side: 'long', size: d('10'), entryPrice: d('100'), margin: d('100'), maintenanceFraction: d('0.0625') });
    expect(r.source).toBe('estimate');
    expect(r.method).toMatch(/isolated, long/);
    expect(s(r.value!)).toBe('96');
    // maintenance 5 % + closing fee 1.25 % gives the same k = 6.25 %
    const f = liquidationPriceIsolated({ side: 'long', size: d('10'), entryPrice: d('100'), margin: d('100'), maintenanceFraction: d('0.05'), feeRate: d('0.0125') });
    expect(s(f.value!)).toBe('96');
    expect(f.method).toMatch(/closing fee/);
    // rounding: (60 000 − 6 000) / 0.995 = 54 271.356783919597989949748… rounded UP at 18 decimals
    const b = liquidationPriceIsolated({ side: 'long', size: d('1'), entryPrice: d('60000'), margin: d('6000'), maintenanceFraction: d('0.005') });
    expect(s(b.value!)).toBe('54271.35678391959798995');
    // margin ≥ notional: no positive price liquidates the long
    expect(liquidationPriceIsolated({ side: 'long', size: d('10'), entryPrice: d('100'), margin: d('1000'), maintenanceFraction: d('0.05') }).value).toBeNull();
    expect(() => liquidationPriceIsolated({ side: 'long', size: d('1'), entryPrice: d('100'), margin: d('10'), maintenanceFraction: d('1') })).toThrow(RangeError);
  });

  it('isolated liquidation price, short', () => {
    // short 10 @ 100 with 275 of margin, maintenance 6.25 %:
    //   p = (100·10 + 275) / (10 · 1.0625) = 1 275 / 10.625 = 120
    //   check at 120: equity = 275 + 10·(100 − 120) = 75 ; maintenance = 0.0625 · 10 · 120 = 75
    const r = liquidationPriceIsolated({ side: 'short', size: d('10'), entryPrice: d('100'), margin: d('275'), maintenanceFraction: d('0.0625') });
    expect(s(r.value!)).toBe('120');
    expect(r.source).toBe('estimate');
    // rounding: (1 000 + 100) / (10 · 1.05) = 104.761904761904761904761… rounded DOWN at 18 decimals
    expect(s(liquidationPriceIsolated({ side: 'short', size: d('10'), entryPrice: d('100'), margin: d('100'), maintenanceFraction: d('0.05') }).value!)).toBe('104.761904761904761904');
  });

  it('liquidation price from a leverage', () => {
    // long @ 100 at 10x, k = 6.25 %: margin per unit = 10 ; p = (100 − 10) / 0.9375 = 96
    expect(s(liquidationPriceAtLeverage({ side: 'long', entryPrice: d('100'), leverage: d('10'), maintenanceFraction: d('0.0625') }).value!)).toBe('96');
    // short @ 100 at 4x, k = 0 : margin per unit = 25 ; p = 125
    expect(s(liquidationPriceAtLeverage({ side: 'short', entryPrice: d('100'), leverage: d('4'), maintenanceFraction: d('0') }).value!)).toBe('125');
    // long at 1x: margin = notional, never liquidated
    expect(liquidationPriceAtLeverage({ side: 'long', entryPrice: d('100'), leverage: d('1'), maintenanceFraction: d('0.01') }).value).toBeNull();
  });

  it('cross liquidation price (single-position approximation)', () => {
    // only position: long 10 @ 100, account collateral 500, k = 6.25 %: p = (1 000 − 500) / 9.375 = 53.333… rounded up
    const alone = liquidationPriceCross({ side: 'long', size: d('10'), entryPrice: d('100'), accountCollateral: d('500'), maintenanceFraction: d('0.0625') });
    expect(s(alone.value!)).toBe('53.333333333333333334');
    expect(alone.source).toBe('estimate');
    expect(alone.method).toMatch(/single-position approximation/);
    // other positions frozen at −100 of PnL and 300 of maintenance: margin = 500 − 100 − 300 = 100 → 96 as in the isolated case
    const withOthers = liquidationPriceCross({ side: 'long', size: d('10'), entryPrice: d('100'), accountCollateral: d('500'), maintenanceFraction: d('0.0625'), otherUnrealizedPnl: d('-100'), otherMaintenanceMargin: d('300') });
    expect(s(withOthers.value!)).toBe('96');
    // short 10 @ 100, collateral 275 → 120
    expect(s(liquidationPriceCross({ side: 'short', size: d('10'), entryPrice: d('100'), accountCollateral: d('275'), maintenanceFraction: d('0.0625') }).value!)).toBe('120');
  });

  it('effect of an order on a position', () => {
    // open
    const open = applyOrderToPosition(null, { side: 'sell', size: d('2'), price: d('100') });
    expect(open.kind).toBe('open');
    expect([open.position!.side, s(open.position!.size), s(open.position!.entryPrice), s(open.realizedPnl)]).toEqual(['short', '2', '100', '0']);
    // increase: long 2 @ 100 + buy 1 @ 130 → 3 @ (200 + 130) / 3 = 110
    const long2: PositionLite = { side: 'long', size: d('2'), entryPrice: d('100') };
    const inc = applyOrderToPosition(long2, { side: 'buy', size: d('1'), price: d('130') });
    expect([inc.kind, s(inc.position!.size), s(inc.position!.entryPrice), s(inc.realizedPnl), s(inc.openedSize)]).toEqual(['increase', '3', '110', '0', '1']);
    // reduce: long 3 @ 110, sell 1 @ 120 → realised 1 · (120 − 110) = 10 ; 2 left at the same entry
    const red = applyOrderToPosition(inc.position, { side: 'sell', size: d('1'), price: d('120') });
    expect([red.kind, s(red.position!.size), s(red.position!.entryPrice), s(red.realizedPnl), s(red.closedSize)]).toEqual(['reduce', '2', '110', '10', '1']);
    // close: sell the 2 left @ 105 → 2 · (105 − 110) = −10
    const close = applyOrderToPosition(red.position, { side: 'sell', size: d('2'), price: d('105') });
    expect([close.kind, close.position, s(close.realizedPnl)]).toEqual(['close', null, '-10']);
    // flip: long 2 @ 100, sell 5 @ 90 → closes 2 with 2 · (90 − 100) = −20 and opens short 3 @ 90
    const flip = applyOrderToPosition(long2, { side: 'sell', size: d('5'), price: d('90') });
    expect([flip.kind, flip.position!.side, s(flip.position!.size), s(flip.position!.entryPrice), s(flip.realizedPnl), s(flip.closedSize), s(flip.openedSize)]).toEqual(['flip', 'short', '3', '90', '-20', '2', '3']);
    // short side: short 4 @ 50, buy 1 @ 40 → realised 1 · (50 − 40) = 10
    const sred = applyOrderToPosition({ side: 'short', size: d('4'), entryPrice: d('50') }, { side: 'buy', size: d('1'), price: d('40') });
    expect([sred.kind, s(sred.realizedPnl), s(sred.position!.size)]).toEqual(['reduce', '10', '3']);
    // average entry that does not terminate: 1 @ 100 + 2 @ 101 → 302 / 3 = 100.666… half-even at 18 decimals
    const avg = applyOrderToPosition({ side: 'long', size: d('1'), entryPrice: d('100') }, { side: 'buy', size: d('2'), price: d('101') });
    expect(s(avg.position!.entryPrice)).toBe('100.666666666666666667');
    expect(() => applyOrderToPosition(null, { side: 'buy', size: d('0'), price: d('1') })).toThrow(RangeError);
  });

  it('free collateral after a hypothetical order', () => {
    const base = { equity: d('1000'), marginUsed: d('200'), price: d('100'), leverage: d('5') };
    // buy 1 @ 100 at 5x from flat: 1 000 − 200 − 100/5 = 780
    const a = freeCollateralAfterOrder({ ...base, side: 'buy', size: d('1') });
    expect(s(a.value)).toBe('780');
    expect(a.source).toBe('estimate');
    expect(a.method).toMatch(/no fees/);
    // with a 0.1 % fee: 780 − 1 · 100 · 0.001 = 779.9
    expect(s(freeCollateralAfterOrder({ ...base, side: 'buy', size: d('1'), feeRate: d('0.001') }).value)).toBe('779.9');
    // reducing a long 2 by 1: no new margin → 800
    const long2: PositionLite = { side: 'long', size: d('2'), entryPrice: d('90') };
    expect(s(freeCollateralAfterOrder({ ...base, side: 'sell', size: d('1'), position: long2 }).value)).toBe('800');
    // flipping long 2 into short 1 (sell 3): |after| − |before| = 1 − 2 < 0 → no new margin → 800
    expect(s(freeCollateralAfterOrder({ ...base, side: 'sell', size: d('3'), position: long2 }).value)).toBe('800');
    // flipping long 2 into short 4 (sell 6): added = 4 − 2 = 2 → 2 · 100 / 5 = 40 → 760
    expect(s(freeCollateralAfterOrder({ ...base, side: 'sell', size: d('6'), position: long2 }).value)).toBe('760');
    // increasing: buy 3 on long 2 → 3 · 100 / 5 = 60 → 740
    expect(s(freeCollateralAfterOrder({ ...base, side: 'buy', size: d('3'), position: long2 }).value)).toBe('740');
  });

  it('signedSize', () => {
    expect(s(signedSize({ side: 'long', size: d('2') }))).toBe('2');
    expect(s(signedSize({ side: 'short', size: d('2') }))).toBe('-2');
    expect(s(signedSize(null))).toBe('0');
  });
});

describe('margin: properties (deterministic PRNG)', () => {
  const price = (r: () => number) => randDec(r, { intDigits: 5, fracDigits: 4, positive: true });
  const size = (r: () => number) => randDec(r, { intDigits: 3, fracDigits: 4, positive: true });
  const side = (r: () => number): Side => (r() < 0.5 ? 'long' : 'short');

  it('a long liquidates below its entry and the price rises with leverage; a short is the mirror image', () => {
    const r = prng(11);
    for (let i = 0; i < N; i++) {
      const entry = price(r), lev = randInt(r, 2, 49);
      const mmf = d('0.01');                                   // below 1/leverage for every leverage ≤ 50
      const at = (side_: Side, l: number) => liquidationPriceAtLeverage({ side: side_, entryPrice: entry, leverage: d(BigInt(l)), maintenanceFraction: mmf }).value!;
      const long = at('long', lev), longMore = at('long', lev + 1);
      expect(D.lt(long, entry)).toBe(true);
      expect(D.isPos(long)).toBe(true);
      expect(D.gt(longMore, long)).toBe(true);
      const short = at('short', lev), shortMore = at('short', lev + 1);
      expect(D.gt(short, entry)).toBe(true);
      expect(D.lt(shortMore, short)).toBe(true);
    }
  });

  it('at the estimated liquidation price, position equity equals the maintenance requirement (to rounding)', () => {
    const r = prng(12);
    const tol = d('0.000000001');
    for (let i = 0; i < N; i++) {
      const sd = side(r), entry = price(r), sz = size(r), mmf = d('0.02');
      const margin = initialMargin(D.mul(entry, sz), d(BigInt(randInt(r, 2, 20))));
      const p = liquidationPriceIsolated({ side: sd, size: sz, entryPrice: entry, margin, maintenanceFraction: mmf }).value!;
      const equity = D.add(margin, unrealizedPnl(sd, sz, entry, p));
      const maint = maintenanceMargin(notional(sz, p), mmf);
      expect(D.lt(D.abs(D.sub(equity, maint)), tol)).toBe(true);
      // more margin moves the liquidation price away from the entry
      // (for a long, enough margin removes the liquidation price altogether: null)
      const p2 = liquidationPriceIsolated({ side: sd, size: sz, entryPrice: entry, margin: D.add(margin, d('1')), maintenanceFraction: mmf }).value;
      if (p2 === null) expect(sd === 'long' && D.gte(D.add(margin, d('1')), D.mul(entry, sz))).toBe(true);
      else expect(sd === 'long' ? D.lt(p2, p) : D.gt(p2, p)).toBe(true);
    }
  });

  it('closing a position at its entry price realises zero; PnL is antisymmetric between long and short', () => {
    const r = prng(13);
    for (let i = 0; i < N; i++) {
      const sd = side(r), entry = price(r), sz = size(r), mark = price(r);
      const pos: PositionLite = { side: sd, size: sz, entryPrice: entry };
      const close = applyOrderToPosition(pos, { side: sd === 'long' ? 'sell' : 'buy', size: sz, price: entry });
      expect(close.kind).toBe('close');
      expect(close.position).toBeNull();
      expect(s(close.realizedPnl)).toBe('0');
      expect(s(unrealizedPnl(sd, sz, entry, entry))).toBe('0');
      expect(s(D.add(unrealizedPnl('long', sz, entry, mark), unrealizedPnl('short', sz, entry, mark)))).toBe('0');
    }
  });

  it('a flip realises exactly the PnL of the closed part and opens the rest at the execution price', () => {
    const r = prng(14);
    for (let i = 0; i < N; i++) {
      const sd = side(r), entry = price(r), sz = size(r), px = price(r), extra = size(r);
      const pos: PositionLite = { side: sd, size: sz, entryPrice: entry };
      const execSide = sd === 'long' ? 'sell' as const : 'buy' as const;
      const flip = applyOrderToPosition(pos, { side: execSide, size: D.add(sz, extra), price: px });
      expect(flip.kind).toBe('flip');
      expect(s(flip.realizedPnl)).toBe(s(unrealizedPnl(sd, sz, entry, px)));
      expect(s(flip.closedSize)).toBe(s(sz));
      expect(flip.position!.side).toBe(sd === 'long' ? 'short' : 'long');
      expect(s(flip.position!.size)).toBe(s(extra));
      expect(s(flip.position!.entryPrice)).toBe(s(px));
      // same as closing, then opening
      const closed = applyOrderToPosition(pos, { side: execSide, size: sz, price: px });
      const reopened = applyOrderToPosition(closed.position, { side: execSide, size: extra, price: px });
      expect(s(closed.realizedPnl)).toBe(s(flip.realizedPnl));
      expect(s(reopened.position!.size)).toBe(s(flip.position!.size));
    }
  });

  it('reducing in two steps at one price realises the same as one step; an increase keeps the cost basis', () => {
    const r = prng(15);
    const tol = d('0.00000000001');
    for (let i = 0; i < N; i++) {
      const sd = side(r), entry = price(r), a = size(r), b = size(r), px = price(r);
      const pos: PositionLite = { side: sd, size: D.add(a, b), entryPrice: entry };
      const out = sd === 'long' ? 'sell' as const : 'buy' as const, into = sd === 'long' ? 'buy' as const : 'sell' as const;
      const one = applyOrderToPosition(pos, { side: out, size: D.add(a, b), price: px });
      const first = applyOrderToPosition(pos, { side: out, size: a, price: px });
      const second = applyOrderToPosition(first.position, { side: out, size: b, price: px });
      expect(s(D.add(first.realizedPnl, second.realizedPnl))).toBe(s(one.realizedPnl));
      expect(second.position).toBeNull();
      // increase: size · entry stays the total cost (to the rounding of the average), entry lies between the two prices
      const inc = applyOrderToPosition({ side: sd, size: a, entryPrice: entry }, { side: into, size: b, price: px });
      const cost = D.add(D.mul(a, entry), D.mul(b, px));
      expect(D.lt(D.abs(D.sub(D.mul(inc.position!.size, inc.position!.entryPrice), cost)), tol)).toBe(true);
      expect(D.gte(inc.position!.entryPrice, D.min(entry, px)) && D.lte(inc.position!.entryPrice, D.max(entry, px))).toBe(true);
    }
  });

  it('exposure is additive', () => {
    const r = prng(16);
    const assets = ['BTC', 'ETH', 'SOL'];
    const gen = (): ExposureInput[] => Array.from({ length: randInt(r, 0, 5) }, () => ({ asset: assets[randInt(r, 0, 2)]!, side: side(r), size: size(r), markPrice: price(r) }));
    for (let i = 0; i < N; i++) {
      const a = gen(), b = gen(), all = [...a, ...b];
      expect(s(grossExposure(all))).toBe(s(D.add(grossExposure(a), grossExposure(b))));
      expect(s(netExposure(all))).toBe(s(D.add(netExposure(a), netExposure(b))));
      const by = exposureByAsset(all);
      const sum = (k: 'gross' | 'net') => Object.values(by).reduce((acc, e) => D.add(acc, e[k]), D.zero);
      expect(s(sum('gross'))).toBe(s(grossExposure(all)));
      expect(s(sum('net'))).toBe(s(netExposure(all)));
      expect(D.lte(D.abs(netExposure(all)), grossExposure(all))).toBe(true);
      const ba = exposureByAsset(a), bb = exposureByAsset(b);
      for (const k of assets) expect(s(by[k]?.gross ?? D.zero)).toBe(s(D.add(ba[k]?.gross ?? D.zero, bb[k]?.gross ?? D.zero)));
    }
  });
});

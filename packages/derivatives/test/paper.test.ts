/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/paper.test.ts
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStateSchema, PaperAccount, PaperStateSchema, PositionSchema, type Book, type Fill, type OrderRequest, type PaperConfig, type Ticker } from '../src/index.ts';

const ID = 'hyperliquid:BTC';
const T0 = 1_700_000_000_000;
/** round numbers so every expected value below can be checked by hand: taker 0.1 %, maker 0.05 %, 10x, maintenance 5 % */
const CONFIG: Partial<PaperConfig> = { takerFeeRate: '0.001', makerFeeRate: '0.0005', leverage: '10', maintenanceMarginFraction: '0.05' };

const book = (ts: number, bids: [string, string][], asks: [string, string][], instrument = ID): Book => ({ instrument, bids, asks, ts });
const ticker = (ts: number, mark: string, instrument = ID): Ticker => ({ instrument, mark, index: null, mid: null, funding: null, openInterest: null, volume24h: null, change24h: null, ts });
let n = 0;
const order = (o: Partial<OrderRequest> = {}): OrderRequest => ({ instrument: ID, side: 'buy', type: 'market', size: '1', price: '101', triggerPrice: null, reduceOnly: false, tif: 'ioc', clientId: `c-${++n}`, ...o });
const account = (collateral = '10000', config: Partial<PaperConfig> = {}): PaperAccount => PaperAccount.create({ venue: 'hyperliquid', account: 'paper-1', collateral, config: { ...CONFIG, ...config } });

afterEach(() => { vi.restoreAllMocks(); });

describe('paper: market orders', () => {
  it('long: walks the book, pays the taker fee, marks to market, closes with a profit', () => {
    const a = account();
    // buy 1 with worst price 101: 0.4 @ 100 + 0.6 @ 100.5 = 40 + 60.3 = 100.3 ; fee 0.1 % = 0.1003
    const r = a.submit(order(), book(T0, [['99.5', '5']], [['100', '0.4'], ['100.5', '0.6'], ['102', '5']]), ticker(T0, '100'), T0);
    expect(r.order!.status).toBe('filled');
    expect(r.order!.filled).toBe('1');
    expect(r.order!.avgFillPrice).toBe('100.3');
    expect(r.fills.map((f) => [f.price, f.size, f.fee, f.closedPnl, f.liquidation])).toEqual([['100', '0.4', '0.04', null, false], ['100.5', '0.6', '0.0603', null, false]]);
    expect(a.state.collateral).toBe('9999.8997');                     // 10 000 − 0.1003
    expect(a.state.positions).toEqual([{ instrument: ID, side: 'long', size: '1', entryPrice: '100.3', markPrice: '100', realizedPnl: '0', fundingPaid: '0' }]);

    // mark 110: unrealized = 1 · (110 − 100.3) = 9.7 ; equity = 9 999.8997 + 9.7 ; margin used = 110 / 10 = 11
    a.onTicker(ticker(T0 + 1000, '110'), T0 + 1000);
    const st = a.accountState(T0 + 1000);
    expect(AccountStateSchema.parse(st)).toEqual(st);
    expect([st.equity, st.collateral, st.marginUsed, st.freeCollateral, st.maintenanceMargin, st.source]).toEqual(['10009.5997', '9999.8997', '11', '9998.5997', '5.5', 'paper']);
    const [p] = a.positions();
    expect(PositionSchema.parse(p)).toEqual(p);
    expect([p!.unrealizedPnl, p!.leverage, p!.marginMode, p!.margin, p!.source]).toEqual(['9.7', '10', 'cross', '11', 'paper']);
    expect(p!.liquidationPrice).toBeNull();                           // collateral covers the whole notional

    // close: sell 1 at the bid 110 → realised 9.7 ; fee 0.11 ; collateral = 9 999.8997 + 9.7 − 0.11 = 10 009.4897
    const c = a.submit(order({ side: 'sell', price: '109', reduceOnly: true }), book(T0 + 2000, [['110', '2']], [['110.5', '2']]), ticker(T0 + 2000, '110'), T0 + 2000);
    expect(c.order!.status).toBe('filled');
    expect(c.fills[0]!.closedPnl).toBe('9.7');
    expect(a.state.positions).toEqual([]);
    expect(a.state.collateral).toBe('10009.4897');
    expect([a.state.realizedPnl, a.state.feesPaid]).toEqual(['9.7', '0.2103']);
    expect(a.accountState(T0 + 2000).equity).toBe('10009.4897');
  });

  it('short: profits when the price falls', () => {
    const a = account();
    // sell 2 @ 100 → short 2 ; fee 0.2
    a.submit(order({ side: 'sell', size: '2', price: '99' }), book(T0, [['100', '5']], [['100.5', '5']]), ticker(T0, '100'), T0);
    expect(a.state.positions[0]).toMatchObject({ side: 'short', size: '2', entryPrice: '100' });
    a.onTicker(ticker(T0 + 1, '90'), T0 + 1);
    expect(a.positions()[0]!.unrealizedPnl).toBe('20');               // 2 · (100 − 90)
    // buy 2 back @ 90 → realised 20 ; fee 0.18 ; collateral = 10 000 − 0.2 + 20 − 0.18 = 10 019.62
    const c = a.submit(order({ side: 'buy', size: '2', price: '91' }), book(T0 + 2, [['89.5', '5']], [['90', '5']]), ticker(T0 + 2, '90'), T0 + 2);
    expect(c.fills[0]!.closedPnl).toBe('20');
    expect(a.state.collateral).toBe('10019.62');
    expect(a.state.positions).toEqual([]);
  });

  it('partial fill: stops at the worst price and cancels the remainder', () => {
    const a = account();
    const r = a.submit(order({ price: '100.5' }), book(T0, [], [['100', '0.4'], ['101', '5']]), ticker(T0, '100'), T0);
    expect([r.order!.status, r.order!.filled, r.order!.avgFillPrice]).toEqual(['cancelled', '0.4', '100']);
    expect(r.order!.rejectReason).toMatch(/remainder cancelled/);
    expect(a.state.positions[0]!.size).toBe('0.4');
    expect(a.openOrders()).toEqual([]);
    // book thinner than the order, everything inside the bound: fills what is there
    const b = account();
    const r2 = b.submit(order({ size: '3' }), book(T0, [], [['100', '1'], ['100.5', '1']]), ticker(T0, '100'), T0);
    expect([r2.order!.status, r2.order!.filled, r2.fills.length]).toEqual(['cancelled', '2', 2]);
    // nothing within the bound: no fill, no position
    const c = account();
    const r3 = c.submit(order({ price: '99' }), book(T0, [], [['100', '1']]), ticker(T0, '100'), T0);
    expect([r3.order!.status, r3.order!.filled, r3.fills.length, c.state.positions.length, c.state.collateral]).toEqual(['cancelled', '0', 0, 0, '10000']);
  });

  it('flip: long 1 then sell 3 leaves short 2 and realises the closed part', () => {
    const a = account();
    a.submit(order(), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    const r = a.submit(order({ side: 'sell', size: '3', price: '94' }), book(T0 + 1, [['95', '5']], []), ticker(T0 + 1, '95'), T0 + 1);
    expect(r.fills[0]!.closedPnl).toBe('-5');                         // 1 · (95 − 100)
    expect(a.state.positions[0]).toMatchObject({ side: 'short', size: '2', entryPrice: '95', realizedPnl: '0' });
    expect(a.state.realizedPnl).toBe('-5');
    // collateral = 10 000 − 0.1 (fee 1 · 100) − 5 − 0.285 (fee 3 · 95) = 9 994.615
    expect(a.state.collateral).toBe('9994.615');
  });
});

describe('paper: limit orders', () => {
  it('fills the crossing part as a taker, rests the remainder, fills it later as a maker at its own price', () => {
    const a = account();
    const req = order({ type: 'limit', tif: 'gtc', price: '100' });
    const r = a.submit(req, book(T0, [['99', '1']], [['100', '0.4'], ['101', '5']]), ticker(T0, '100'), T0);
    expect([r.order!.status, r.order!.filled]).toEqual(['partially_filled', '0.4']);
    expect(a.openOrders().map((o) => o.clientId)).toEqual([req.clientId]);
    // a book that does not cross leaves it alone
    expect(a.onBook(book(T0 + 1, [['99', '1']], [['100.5', '3']]), T0 + 1).fills).toEqual([]);
    // asks at 99.5 cross the bid at 100: filled at 100 (the order's price) for the depth available, maker fee 0.05 %
    const f1 = a.onBook(book(T0 + 2, [['99', '1']], [['99.5', '0.3'], ['100.5', '3']]), T0 + 2);
    expect(f1.fills.map((f) => [f.price, f.size, f.fee])).toEqual([['100', '0.3', '0.015']]);
    expect(a.order(req.clientId)!.status).toBe('partially_filled');
    const f2 = a.onBook(book(T0 + 3, [], [['100', '10']]), T0 + 3);
    expect(f2.fills.map((f) => [f.price, f.size])).toEqual([['100', '0.3']]);
    expect([a.order(req.clientId)!.status, a.order(req.clientId)!.filled, a.order(req.clientId)!.avgFillPrice]).toEqual(['filled', '1', '100']);
    expect(a.state.positions[0]).toMatchObject({ size: '1', entryPrice: '100' });
    // fees: 0.4 · 100 · 0.001 + 0.6 · 100 · 0.0005 = 0.04 + 0.03
    expect(a.state.feesPaid).toBe('0.07');
    expect(a.openOrders()).toEqual([]);
  });

  it('a resting sell is filled by bids that reach it; two resting orders share the depth, oldest first', () => {
    const a = account();
    const s1 = order({ side: 'sell', type: 'limit', tif: 'gtc', price: '105', size: '1' }), s2 = order({ side: 'sell', type: 'limit', tif: 'gtc', price: '105', size: '1' });
    a.submit(s1, book(T0, [['100', '5']], [['101', '5']]), ticker(T0, '100'), T0);
    a.submit(s2, book(T0, [['100', '5']], [['101', '5']]), ticker(T0, '100'), T0);
    expect(a.openOrders().length).toBe(2);
    const r = a.onBook(book(T0 + 1, [['106', '1.5'], ['104', '9']], []), T0 + 1);
    expect(r.fills.map((f) => [f.clientId, f.size, f.price])).toEqual([[s1.clientId, '1', '105'], [s2.clientId, '0.5', '105']]);
    expect([a.order(s1.clientId)!.status, a.order(s2.clientId)!.status]).toEqual(['filled', 'partially_filled']);
    expect(a.state.positions[0]).toMatchObject({ side: 'short', size: '1.5', entryPrice: '105' });
  });

  it('ioc limit and post-only', () => {
    const a = account();
    const ioc = a.submit(order({ type: 'limit', tif: 'ioc', price: '100' }), book(T0, [], [['100', '0.25']]), ticker(T0, '100'), T0);
    expect([ioc.order!.status, ioc.order!.filled]).toEqual(['cancelled', '0.25']);
    const crossing = a.submit(order({ type: 'limit', tif: 'alo', price: '100' }), book(T0, [], [['100', '1']]), ticker(T0, '100'), T0);
    expect(crossing.order!.status).toBe('rejected');
    expect(crossing.order!.rejectReason).toMatch(/post-only/);
    const passive = a.submit(order({ type: 'limit', tif: 'alo', price: '99' }), book(T0, [], [['100', '1']]), ticker(T0, '100'), T0);
    expect([passive.order!.status, passive.fills.length]).toEqual(['open', 0]);
  });
});

describe('paper: rejections, cancellation, idempotency', () => {
  it('rejects malformed or impossible orders and records why', () => {
    const a = account();
    const b = book(T0, [['99', '5']], [['100', '5']]), t = ticker(T0, '100');
    const reason = (o: Partial<OrderRequest>, bk = b, tk = t) => { const r = a.submit(order(o), bk, tk, T0); expect(r.order!.status).toBe('rejected'); expect(r.fills).toEqual([]); return r.order!.rejectReason!; };
    expect(reason({ price: null })).toMatch(/price is required/);
    expect(reason({ size: '0' })).toMatch(/size/);
    expect(reason({ type: 'stop_market', triggerPrice: null })).toMatch(/trigger/);
    expect(reason({ triggerPrice: '90' })).toMatch(/no trigger/);
    expect(reason({ reduceOnly: true, side: 'sell', price: '99' })).toMatch(/no position to reduce/);
    expect(reason({}, book(T0, [], [], 'hyperliquid:ETH'))).toMatch(/another instrument/);
    expect(reason({}, b, ticker(T0, '100', 'hyperliquid:ETH'))).toMatch(/another instrument/);
    expect(reason({ tif: 'alo' })).toMatch(/post-only/);
    expect(a.state.positions).toEqual([]);
    expect(a.state.collateral).toBe('10000');
    expect(a.state.orders.every((o) => o.status === 'rejected')).toBe(true);
    // an order that is not even well formed is not recorded: it throws
    expect(() => a.submit({ ...order(), size: '1e3' }, b, t, T0)).toThrow();
    expect(() => a.submit({ ...order(), side: 'long' as 'buy' }, b, t, T0)).toThrow();
  });

  it('reduce-only: larger than the position is rejected; never increases', () => {
    const a = account();
    a.submit(order(), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    const big = a.submit(order({ side: 'sell', size: '1.5', price: '99', reduceOnly: true }), book(T0, [['100', '5']], []), ticker(T0, '100'), T0);
    expect(big.order!.status).toBe('rejected');
    expect(big.order!.rejectReason).toMatch(/larger than the position/);
    const same = a.submit(order({ side: 'buy', reduceOnly: true }), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    expect(same.order!.status).toBe('rejected');
    const part = a.submit(order({ side: 'sell', size: '0.4', price: '99', reduceOnly: true }), book(T0, [['100', '5']], []), ticker(T0, '100'), T0);
    expect(part.order!.status).toBe('filled');
    expect(a.state.positions[0]!.size).toBe('0.6');
  });

  it('a resting reduce-only order is clipped to the position and cancelled once it is gone', () => {
    const a = account();
    a.submit(order(), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    const tp = order({ side: 'sell', type: 'limit', tif: 'gtc', price: '110', size: '1', reduceOnly: true });
    expect(a.submit(tp, book(T0, [['100', '5']], []), ticker(T0, '100'), T0).order!.status).toBe('open');
    // the position shrinks to 0.3 by another order
    a.submit(order({ side: 'sell', size: '0.7', price: '99' }), book(T0, [['100', '5']], []), ticker(T0, '100'), T0);
    const r = a.onBook(book(T0 + 1, [['111', '5']], []), T0 + 1);
    expect(r.fills.map((f) => [f.size, f.price, f.closedPnl])).toEqual([['0.3', '110', '3']]);
    expect(a.state.positions).toEqual([]);
    expect(a.order(tp.clientId)!.status).toBe('cancelled');
    expect(a.order(tp.clientId)!.filled).toBe('0.3');
  });

  it('cancellation: a cancelled order never fills; cancelling twice or cancelling the unknown is harmless', () => {
    const a = account();
    const req = order({ type: 'limit', tif: 'gtc', price: '90' });
    expect(a.submit(req, book(T0, [], [['100', '5']]), ticker(T0, '100'), T0).order!.status).toBe('open');
    const c = a.cancel(req.clientId, T0 + 1);
    expect([c.order!.status, c.order!.updatedAt, c.order!.rejectReason]).toEqual(['cancelled', T0 + 1, 'cancelled by the user']);
    expect(a.openOrders()).toEqual([]);
    expect(a.onBook(book(T0 + 2, [], [['80', '5']]), T0 + 2).fills).toEqual([]);
    expect(a.state.positions).toEqual([]);
    const again = a.cancel(req.clientId, T0 + 3);
    expect([again.order!.status, again.order!.updatedAt, again.orders.length]).toEqual(['cancelled', T0 + 1, 0]);
    expect(a.cancel('nope', T0 + 3).order).toBeNull();
    // a filled order cannot be cancelled
    const done = order();
    a.submit(done, book(T0 + 4, [], [['100', '5']]), ticker(T0 + 4, '100'), T0 + 4);
    expect(a.cancel(done.clientId, T0 + 5).order!.status).toBe('filled');
  });

  it('the same fill delivered twice is applied once', () => {
    const a = account();
    const fill: Fill = { instrument: ID, orderId: null, clientId: null, side: 'buy', price: '100', size: '2', fee: '0.2', feeAsset: 'USDC', closedPnl: null, ts: T0, id: 'venue-fill-1', liquidation: false };
    expect(a.applyFill(fill)).toBe(true);
    const snapshot = a.serialize();
    expect(a.applyFill(fill)).toBe(false);
    expect(a.applyFill({ ...fill })).toBe(false);
    expect(a.serialize()).toBe(snapshot);
    expect(a.state.positions[0]).toMatchObject({ side: 'long', size: '2', entryPrice: '100' });
    expect([a.state.collateral, a.state.fills.length]).toEqual(['9999.8', 1]);
    // still deduplicated after a restart
    const b = PaperAccount.restore(snapshot);
    expect(b.applyFill(fill)).toBe(false);
    expect(b.applyFill({ ...fill, id: 'venue-fill-2', side: 'sell', price: '110' })).toBe(true);
    expect(b.state.fills[1]!.closedPnl).toBe('20');
    expect(b.state.collateral).toBe('10019.6');                       // 9 999.8 + 20 − 0.2
  });

  it('the same clientId submitted twice gives the same order and no second execution', () => {
    const a = account();
    const req = order();
    const b = book(T0, [], [['100', '5']]);
    const first = a.submit(req, b, ticker(T0, '100'), T0);
    const snapshot = a.serialize();
    const second = a.submit(req, book(T0 + 1, [], [['100', '5']]), ticker(T0 + 1, '100'), T0 + 1);
    expect(second.order).toEqual(first.order);
    expect(second.fills).toEqual([]);
    expect(a.serialize()).toBe(snapshot);
  });

  it('the same book delivered twice does not fill a resting order twice', () => {
    const a = account();
    const req = order({ type: 'limit', tif: 'gtc', price: '100', size: '2' });
    a.submit(req, book(T0, [], [['101', '5']]), ticker(T0, '101'), T0);
    const crossing = book(T0 + 1, [], [['100', '0.5']]);
    expect(a.onBook(crossing, T0 + 1).fills.length).toBe(1);
    expect(a.onBook(crossing, T0 + 2).fills).toEqual([]);
    expect(a.onBook(book(T0, [], [['100', '0.5']]), T0 + 3).fills).toEqual([]);     // older book
    expect(a.order(req.clientId)!.filled).toBe('0.5');
  });
});

describe('paper: collateral, liquidation, funding', () => {
  it('insufficient collateral: the order is rejected and nothing changes', () => {
    const a = account('100');
    // 11 @ 100 at 10x needs 110 of margin + 1.1 of fee > 100
    const r = a.submit(order({ size: '11', price: '100' }), book(T0, [], [['100', '50']]), ticker(T0, '100'), T0);
    expect(r.order!.status).toBe('rejected');
    expect(r.order!.rejectReason).toMatch(/insufficient collateral: needs 111.1, free 100/);
    expect([a.state.collateral, a.state.positions.length, a.state.fills.length]).toEqual(['100', 0, 0]);
    // 9 @ 100 needs 90 + 0.9: accepted
    const okr = a.submit(order({ size: '9', price: '100' }), book(T0, [], [['100', '50']]), ticker(T0, '100'), T0);
    expect(okr.order!.status).toBe('filled');
    expect(a.state.collateral).toBe('99.1');
    // free is now 99.1 − 90 = 9.1: one more unit (10 + 0.1) does not fit, but reducing always does
    expect(a.submit(order({ size: '1', price: '100' }), book(T0, [], [['100', '50']]), ticker(T0, '100'), T0).order!.status).toBe('rejected');
    expect(a.submit(order({ side: 'sell', size: '4', price: '100' }), book(T0, [['100', '50']], []), ticker(T0, '100'), T0).order!.status).toBe('filled');
    // a resting order is checked again when it fills
    const b = account('100');
    const rest = order({ type: 'limit', tif: 'gtc', size: '9', price: '100' });
    expect(b.submit(rest, book(T0, [], [['101', '50']]), ticker(T0, '101'), T0).order!.status).toBe('open');
    b.submit(order({ size: '5', price: '101' }), book(T0, [], [['101', '50']]), ticker(T0, '101'), T0);
    const later = b.onBook(book(T0 + 1, [], [['100', '50']]), T0 + 1);
    expect(later.fills).toEqual([]);
    expect(b.order(rest.clientId)!.status).toBe('cancelled');
    expect(b.order(rest.clientId)!.rejectReason).toMatch(/insufficient collateral/);
  });

  it('simulated liquidation when equity falls below the maintenance margin', () => {
    const a = account('100');
    a.submit(order({ size: '9', price: '100' }), book(T0, [], [['100', '50']]), ticker(T0, '100'), T0);    // collateral 99.1
    const resting = order({ side: 'sell', type: 'limit', tif: 'gtc', price: '120', size: '9', reduceOnly: true });
    a.submit(resting, book(T0, [['100', '50']], []), ticker(T0, '100'), T0);
    // the estimate shown for the position: (9 · 100 − 99.1) / (9 · 0.95) = 800.9 / 8.55 = 93.67251461988304…
    expect(a.positions()[0]!.liquidationPrice).toBe('93.672514619883040936');
    // mark 94: equity = 99.1 + 9 · (94 − 100) = 45.1 ; maintenance = 9 · 94 · 0.05 = 42.3 → alive
    const alive = a.onTicker(ticker(T0 + 1, '94'), T0 + 1);
    expect([alive.liquidated, alive.fills.length]).toEqual([false, 0]);
    expect(a.accountState(T0 + 1).equity).toBe('45.1');
    // mark 93: equity = 99.1 − 63 = 36.1 ; maintenance = 9 · 93 · 0.05 = 41.85 → liquidated at the mark
    const dead = a.onTicker(ticker(T0 + 2, '93'), T0 + 2);
    expect(dead.liquidated).toBe(true);
    expect(dead.fills.map((f) => [f.side, f.price, f.size, f.closedPnl, f.liquidation, f.orderId, f.id])).toEqual([['sell', '93', '9', '-63', true, null, 'paper-liq-4']]);
    expect(a.state.positions).toEqual([]);
    expect(a.state.collateral).toBe('36.1');
    expect(a.state.liquidations).toBe(1);
    expect(a.order(resting.clientId)!.status).toBe('cancelled');
    expect(a.order(resting.clientId)!.rejectReason).toMatch(/liquidated/);
    expect(a.openOrders()).toEqual([]);
    // nothing left to liquidate
    expect(a.onTicker(ticker(T0 + 3, '50'), T0 + 3).liquidated).toBe(false);
  });

  it('a liquidation fee is charged when configured, and a short is liquidated on the way up', () => {
    const a = account('100', { liquidationFeeRate: '0.01' });
    a.submit(order({ side: 'sell', size: '9', price: '100' }), book(T0, [['100', '50']], []), ticker(T0, '100'), T0);   // collateral 99.1
    // mark 107: equity = 99.1 − 63 = 36.1 ; maintenance = 9 · 107 · 0.05 = 48.15 → liquidated ; fee = 9 · 107 · 0.01 = 9.63
    const r = a.onTicker(ticker(T0 + 1, '107'), T0 + 1);
    expect(r.liquidated).toBe(true);
    expect(r.fills.map((f) => [f.side, f.fee, f.closedPnl])).toEqual([['buy', '9.63', '-63']]);
    expect(a.state.collateral).toBe('26.47');                         // 99.1 − 63 − 9.63
  });

  it('funding: a long pays a positive rate, a short receives it; once per timestamp', () => {
    const a = account();
    a.submit(order({ size: '2' }), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);      // long 2 @ 100, fee 0.2 → 9 999.8
    a.onTicker(ticker(T0 + 1, '110'), T0 + 1);
    // unfavourable: 2 · 110 · 0.0005 = 0.11 paid
    const r = a.applyFunding('0.0005', T0 + 3600_000);
    expect(r.funding).toEqual([{ instrument: ID, amount: '-0.11', rate: '0.0005', size: '2', ts: T0 + 3600_000 }]);
    expect([a.state.collateral, a.state.fundingNet, a.state.positions[0]!.fundingPaid]).toEqual(['9999.69', '-0.11', '0.11']);
    // delivered again for the same timestamp: ignored
    expect(a.applyFunding('0.0005', T0 + 3600_000).funding).toEqual([]);
    expect(a.state.collateral).toBe('9999.69');
    // negative rate: the long receives 2 · 110 · 0.0002 = 0.044
    expect(a.applyFunding('-0.0002', T0 + 7200_000, ID).funding[0]!.amount).toBe('0.044');
    expect([a.state.collateral, a.state.positions[0]!.fundingPaid, a.positions()[0]!.fundingPaid]).toEqual(['9999.734', '0.066', '0.066']);
    // another instrument: nothing
    expect(a.applyFunding('0.01', T0 + 9000_000, 'hyperliquid:ETH').funding).toEqual([]);
    // short side
    const b = account();
    b.submit(order({ side: 'sell', size: '2', price: '99' }), book(T0, [['100', '5']], []), ticker(T0, '100'), T0);
    expect(b.applyFunding('0.0005', T0 + 1).funding[0]!.amount).toBe('0.1');                  // 2 · 100 · 0.0005 received
    expect(b.state.positions[0]!.fundingPaid).toBe('-0.1');
    // flat account: nothing
    expect(account().applyFunding('0.01', T0).funding).toEqual([]);
  });

  it('unfavourable funding can push an account into liquidation', () => {
    const a = account('100');
    a.submit(order({ size: '9', price: '100' }), book(T0, [], [['100', '50']]), ticker(T0, '100'), T0);    // collateral 99.1, maintenance 45
    // 9 · 100 · 0.06 = 54 of funding: equity 45.1 → still above 45
    expect(a.applyFunding('0.06', T0 + 1).liquidated).toBe(false);
    expect(a.state.collateral).toBe('45.1');
    // 0.9 more: equity 44.2 < 45 → liquidated at the mark 100, no PnL
    const r = a.applyFunding('0.001', T0 + 2);
    expect(r.liquidated).toBe(true);
    expect(r.fills.map((f) => [f.price, f.closedPnl, f.liquidation])).toEqual([['100', '0', true]]);
    expect(a.state.collateral).toBe('44.2');
  });
});

describe('paper: stop and take-profit', () => {
  const longOne = (): PaperAccount => { const a = account(); a.submit(order(), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0); return a; };

  it('stop-market: triggers on the mark, executes on the next book within its worst price', () => {
    const a = longOne();
    const stop = order({ side: 'sell', type: 'stop_market', triggerPrice: '95', price: '94', reduceOnly: true });
    expect(a.submit(stop, book(T0, [['100', '5']], []), ticker(T0, '100'), T0).order!.status).toBe('pending');
    expect(a.onTicker(ticker(T0 + 1, '96'), T0 + 1).orders).toEqual([]);
    expect(a.onBook(book(T0 + 1, [['96', '5']], []), T0 + 1).fills).toEqual([]);
    const t = a.onTicker(ticker(T0 + 2, '95'), T0 + 2);
    expect(t.orders.map((o) => [o.clientId, o.status])).toEqual([[stop.clientId, 'triggered']]);
    expect(a.state.positions[0]!.size).toBe('1');                     // not executed yet: it needs a book
    const r = a.onBook(book(T0 + 3, [['94.5', '5']], []), T0 + 3);
    expect(r.fills.map((f) => [f.price, f.size, f.closedPnl, f.fee])).toEqual([['94.5', '1', '-5.5', '0.0945']]);
    expect(a.order(stop.clientId)!.status).toBe('filled');
    expect(a.state.positions).toEqual([]);
  });

  it('stop-market beyond its worst price is cancelled, not filled at any price', () => {
    const a = longOne();
    const stop = order({ side: 'sell', type: 'stop_market', triggerPrice: '95', price: '94', reduceOnly: true });
    a.submit(stop, book(T0, [['100', '5']], []), ticker(T0, '100'), T0);
    a.onTicker(ticker(T0 + 1, '90'), T0 + 1);
    const r = a.onBook(book(T0 + 2, [['90', '5']], []), T0 + 2);
    expect(r.fills).toEqual([]);
    expect(a.order(stop.clientId)!.status).toBe('cancelled');
    expect(a.state.positions[0]!.size).toBe('1');
  });

  it('take-profit limit: triggers upward for a sell, then behaves as a limit order', () => {
    const a = longOne();
    const tp = order({ side: 'sell', type: 'take_profit_limit', tif: 'gtc', triggerPrice: '110', price: '110', reduceOnly: true });
    a.submit(tp, book(T0, [['100', '5']], []), ticker(T0, '100'), T0);
    expect(a.onTicker(ticker(T0 + 1, '109.9'), T0 + 1).orders).toEqual([]);
    a.onTicker(ticker(T0 + 2, '110'), T0 + 2);
    expect(a.order(tp.clientId)!.status).toBe('triggered');
    // the book is below the limit: it rests
    a.onBook(book(T0 + 3, [['109', '5']], []), T0 + 3);
    expect(a.order(tp.clientId)!.status).toBe('open');
    const r = a.onBook(book(T0 + 4, [['110.5', '5']], []), T0 + 4);
    expect(r.fills.map((f) => [f.price, f.closedPnl])).toEqual([['110', '10']]);
    expect(a.order(tp.clientId)!.status).toBe('filled');
  });

  it('buy stop triggers upward, buy take-profit downward; a stop already through its trigger fires at once', () => {
    const a = account();
    const stop = order({ type: 'stop_market', triggerPrice: '105', price: '106' }), tp = order({ type: 'take_profit_market', triggerPrice: '95', price: '96' });
    a.submit(stop, book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    a.submit(tp, book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    a.onTicker(ticker(T0 + 1, '95'), T0 + 1);
    expect([a.order(stop.clientId)!.status, a.order(tp.clientId)!.status]).toEqual(['pending', 'triggered']);
    a.onTicker(ticker(T0 + 2, '105'), T0 + 2);
    expect(a.order(stop.clientId)!.status).toBe('triggered');
    const now = order({ type: 'stop_market', triggerPrice: '100', price: '106' });
    expect(a.submit(now, book(T0 + 3, [], [['105', '5']]), ticker(T0 + 3, '105'), T0 + 3).order!.status).toBe('triggered');
    // a pending trigger order can be cancelled
    const c = order({ type: 'stop_market', triggerPrice: '200', price: '201' });
    a.submit(c, book(T0 + 3, [], [['105', '5']]), ticker(T0 + 3, '105'), T0 + 3);
    expect(a.cancel(c.clientId, T0 + 4).order!.status).toBe('cancelled');
  });
});

describe('paper: determinism and restart', () => {
  /** a scenario that touches every feature; `cut` restarts the account (serialise → parse) after that many steps */
  function run(cut: number | null): string {
    let k = 0;
    const id = (): string => `s-${++k}`;
    let a = PaperAccount.create({ venue: 'hyperliquid', account: 'paper-r', collateral: '5000', config: CONFIG });
    const steps: ((x: PaperAccount) => void)[] = [
      (x) => { x.submit(order({ clientId: id(), size: '3', price: '100.5' }), book(T0, [['99.5', '9']], [['100', '2'], ['100.25', '4']]), ticker(T0, '100'), T0); },
      (x) => { x.submit(order({ clientId: id(), type: 'limit', tif: 'gtc', side: 'buy', size: '2', price: '98' }), book(T0 + 1, [['99.5', '9']], [['100', '2']]), ticker(T0 + 1, '100'), T0 + 1); },
      (x) => { x.submit(order({ clientId: id(), type: 'stop_market', side: 'sell', size: '5', triggerPrice: '96', price: '95', reduceOnly: true }), book(T0 + 2, [['99.5', '9']], [['100', '2']]), ticker(T0 + 2, '100'), T0 + 2); },
      (x) => { x.applyFunding('0.000125', T0 + 3); },
      (x) => { x.onTicker(ticker(T0 + 4, '98.37'), T0 + 4); },
      (x) => { x.onBook(book(T0 + 5, [['97.5', '9']], [['97.9', '1.3'], ['98.4', '3']]), T0 + 5); },
      (x) => { x.submit(order({ clientId: id(), type: 'limit', tif: 'gtc', side: 'sell', size: '1', price: '103', reduceOnly: true }), book(T0 + 6, [['97.5', '9']], [['98', '2']]), ticker(T0 + 6, '98'), T0 + 6); },
      (x) => { x.cancel('s-4', T0 + 7); },
      (x) => { x.onBook(book(T0 + 8, [['97', '9']], [['97.2', '5']]), T0 + 8); },
      (x) => { x.applyFunding('-0.0003', T0 + 9); },
      (x) => { x.onTicker(ticker(T0 + 10, '95.9'), T0 + 10); },
      (x) => { x.onBook(book(T0 + 11, [['95.6', '2'], ['95.1', '1'], ['94', '9']], [['96', '5']]), T0 + 11); },
      (x) => { x.submit(order({ clientId: id(), side: 'sell', size: '4', price: '94' }), book(T0 + 12, [['95', '9']], [['96', '5']]), ticker(T0 + 12, '95.5'), T0 + 12); },
      (x) => { x.onTicker(ticker(T0 + 13, '91.123456789'), T0 + 13); },
    ];
    steps.forEach((step, i) => {
      if (cut === i) a = PaperAccount.restore(a.serialize());
      step(a);
    });
    return JSON.stringify({ state: a.state, account: a.accountState(T0 + 99), positions: a.positions(), open: a.openOrders() });
  }

  it('never reads the clock or a random number', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock used'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('randomness used'); });
    expect(() => run(null)).not.toThrow();
  });

  it('the same inputs give the same state, byte for byte', () => {
    expect(run(null)).toBe(run(null));
  });

  it('restart at any point (serialise → parse → continue) gives the same result', () => {
    const reference = run(null);
    const parsed = JSON.parse(reference) as { state: { fills: unknown[]; orders: unknown[]; funding: unknown[]; positions: unknown[] } };
    // the scenario is not trivial: it produced fills, orders, funding and an open position
    expect(parsed.state.fills.length).toBeGreaterThan(4);
    expect(parsed.state.orders.length).toBe(5);
    expect(parsed.state.funding.length).toBe(2);
    expect(parsed.state.positions.length).toBe(1);
    for (let cut = 0; cut < 14; cut++) expect(run(cut), `restart before step ${cut}`).toBe(reference);
  });

  it('the serialised state validates, and a corrupted one is refused', () => {
    const a = account();
    a.submit(order(), book(T0, [], [['100', '5']]), ticker(T0, '100'), T0);
    const text = a.serialize();
    expect(PaperStateSchema.parse(JSON.parse(text))).toEqual(a.state);
    expect(PaperAccount.restore(text).serialize()).toBe(text);
    expect(PaperAccount.restore(JSON.parse(text)).serialize()).toBe(text);
    expect(() => PaperAccount.restore(text.replace('"collateral":"', '"collateral":"1e'))).toThrow();
    expect(() => PaperAccount.restore('{}')).toThrow();
    expect(() => PaperAccount.restore(JSON.stringify({ ...a.state, version: 2 }))).toThrow();
  });
});

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/mm.test.ts
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

// Market-making core: policy, quote planner, rate budget, circuit breakers, markouts, PnL attribution. Pure code, exact decimals.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import {
  AS_STUDY_DEFAULTS, avellanedaStoikov, breakersInit, breakersReset, cycleBudget, markoutAddFill, markoutInit, markoutOnMid, markouts10s, markoutSummary, midOf, planQuotes, pnlInit, pnlMarkToMarket, pnlOnFill, pnlOnFunding,
  pnlOnMid, pnlReport, shiftBps, stepBreakers, VOL_STUDY_DEFAULTS, volBps, volInit, volUpdate,
  type BookTop, type BreakerConfig, type BreakerObservation, type DesiredQuote, type PlanBudget, type PlanInput, type PlannerConfig, type QuoteRounder, type RateConfig, type RateState, type RestingOrder, type Side,
} from '../src/mm/index.ts';

// a BTC-like grid: integer prices, lot 0.00001, minimum value 10 USD. A bid rounds down, an ask up; a reduce rounds TOWARDS crossing.
const q = (x: string, step: string, mode: 'down' | 'up') => D.str(D.quantize(D.from(x), D.from(step), mode));
const round: QuoteRounder = (side, price, size) => {
  const p = q(price, '1', side === 'buy' ? 'down' : 'up'), s = q(size, '0.00001', 'down');
  if (!D.isPos(D.from(p)) || !D.isPos(D.from(s))) return { ok: false, reason: 'rounds to nothing' };
  if (D.lt(D.mul(D.from(p), D.from(s)), D.from('10'))) return { ok: false, reason: 'below the minimum value' };
  return { ok: true, price: p, size: s };
};
const roundReduce: QuoteRounder = (side, price, size) => { const p = q(price, '1', side === 'sell' ? 'down' : 'up'), s = q(size, '0.00001', 'down'); return D.isPos(D.from(s)) ? { ok: true, price: p, size: s } : { ok: false, reason: 'rounds to nothing' }; };
const book = (o: Partial<BookTop> = {}): BookTop => ({ bid: '64999', bidSize: '2', ask: '65001', askSize: '2', ts: 1_000_000, ...o });
const CFG: PlannerConfig = { requoteToleranceBps: '2', sizeToleranceBps: '2000', maxRestingPerSide: 2, softInventory: '0.004', hardInventory: '0.008', reduceSlippageBps: '10', maxReduceSize: '0.003' };
const BIG: PlanBudget = { places: 20, cancels: 40, reduces: 20, actions: 3 };
const want = (side: Side, price: string, size = '0.001', level = 0): DesiredQuote => ({ side, price, size, level });
const rest = (clientId: string, side: Side, price: string, size = '0.001', state: RestingOrder['state'] = 'resting'): RestingOrder => ({ clientId, side, price, size, state, placedAt: 0 });
const plan = (o: Partial<PlanInput> = {}, cfg: Partial<PlannerConfig> = {}) => planQuotes({ ...CFG, ...cfg }, { book: book(), position: '0', desired: [], resting: [], budget: BIG, mode: 'quote', round, roundReduce, ...o });

describe('Avellaneda–Stoikov policy (the lab study\'s formulas and parameters)', () => {
  const P = { ...AS_STUDY_DEFAULTS, kappa: 0.69, lotUsd: '1000', minHalfSpreadBps: '0.01', maxHalfSpreadBps: '500', fallbackVolBps: null };
  const run = (inventory: string, vol: number | null, over: object = {}, b = book()) => avellanedaStoikov({ ...P, ...over }).quotes({ nowMs: 0, book: b, inventory, volBps: vol });
  it('reproduces the study by hand: gamma 0.1, tau 12, sigma 2.54 bps, kappa 0.69, flat inventory', () => {
    const r = run('0', 2.54, {}, book({ bid: '65000', ask: '65000.0001' }));                       // a book so tight that the formula is not clamped by it
    // gamma·sigma²·tau/2 = 0.1 × 6.4516 × 12 / 2 = 3.87096 ; ln(1 + 0.1/0.69)/0.1 = 1.35333… → 5.2243 bps
    expect(Number(r.diagnostics.halfSpreadBps)).toBeCloseTo(3.87096 + Math.log(1 + 0.1 / 0.69) / 0.1, 5);
    expect(r.diagnostics.reservationBps).toBe('0');
    const [bid, ask] = r.quotes;
    expect(bid).toMatchObject({ side: 'buy', level: 0 }); expect(ask).toMatchObject({ side: 'sell', level: 0 });
    expect(Number(bid!.price)).toBeCloseTo(65000.00005 * (1 - 5.2243 / 1e4), 1);
    expect(Number(ask!.price)).toBeCloseTo(65000.00005 * (1 + 5.2243 / 1e4), 1);
    expect(Number(bid!.size)).toBeCloseTo(1000 / 65000, 6);                                          // one lot of 1 000 USD
  });
  it('inventory skew: long inventory lowers both quotes (reservation price below the mid), short raises them; the limit removes a side', () => {
    const b = book({ bid: '65000', ask: '65000.0001' }), flat = run('0', 2.54, {}, b), long = run('0.03', 2.54, {}, b), short = run('-0.03', 2.54, {}, b);   // ±1.95 lots
    expect(Number(long.diagnostics.reservationBps)).toBeLessThan(0); expect(Number(short.diagnostics.reservationBps)).toBeGreaterThan(0);
    expect(Number(long.quotes[0]!.price)).toBeLessThan(Number(flat.quotes[0]!.price)); expect(Number(long.quotes[1]!.price)).toBeLessThan(Number(flat.quotes[1]!.price));
    expect(Number(short.quotes[0]!.price)).toBeGreaterThan(Number(flat.quotes[0]!.price));
    expect(run('0.08', 2.54).quotes.map((x) => x.side)).toEqual(['sell']);                           // 5.2 lots ≥ 5: no bid
    expect(run('-0.08', 2.54).quotes.map((x) => x.side)).toEqual(['buy']);
  });
  it('post-only: never inside the book; floor and ceiling on the distance from the mid; no quote without a volatility or a book', () => {
    const tight = run('0', 0.01);                                                                    // the formula alone would quote ~1.35 bps from the mid: inside this 0.3 bps book? no — outside; clamp to the touch does not apply
    expect(D.lte(D.from(tight.quotes[0]!.price), D.from('64999'))).toBe(true); expect(D.gte(D.from(tight.quotes[1]!.price), D.from('65001'))).toBe(true);
    const wide = run('0', 0.01, {}, book({ bid: '64900', ask: '65100' }));                           // a 30 bps book: 1.35 bps from the mid is INSIDE it → moved back to the touch
    expect(wide.quotes.map((x) => x.price)).toEqual(['64900', '65100']);
    expect(wide.notes).toEqual(['bid moved back to the best bid', 'ask moved back to the best ask']);
    const floored = run('0', 0.01, { minHalfSpreadBps: '8' }), capped = run('0', 40, { maxHalfSpreadBps: '50' });
    expect(floored.diagnostics.halfSpreadBps).toBe('8'); expect(capped.diagnostics.halfSpreadBps).toBe('50');
    // with the skew, each quote still keeps the floor
    const skewed = run('0.06', 2.54, { minHalfSpreadBps: '3' }, book({ bid: '65000', ask: '65000.0001' }));
    expect(Number(skewed.diagnostics.askBps)).toBeGreaterThanOrEqual(3); expect(Number(skewed.diagnostics.bidBps)).toBeGreaterThanOrEqual(3);
    expect(run('0', null).quotes).toEqual([]);
    expect(run('0', null, { fallbackVolBps: 2 }).quotes).toHaveLength(2);
    expect(run('0', 2, {}, book({ bid: '65001', ask: '65000' })).quotes).toEqual([]);
    expect(() => avellanedaStoikov({ ...P, kappa: 0 })).toThrow(); expect(() => avellanedaStoikov({ ...P, minHalfSpreadBps: '600' })).toThrow();
  });
  it('property: whatever the inputs, the bid is below the mid by at least the floor and the ask above it — the policy never emits a crossing pair', () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 9_000_000 }), fc.integer({ min: 1, max: 4000 }), fc.integer({ min: -900, max: 900 }), fc.double({ min: 0.001, max: 80, noNaN: true }), fc.double({ min: 0.05, max: 5, noNaN: true }),
      (bidCents, spreadCents, invMilli, vol, kappa) => {
        const b = book({ bid: (bidCents / 100).toFixed(2), ask: ((bidCents + spreadCents) / 100).toFixed(2) }), mid = midOf(b);
        const r = avellanedaStoikov({ ...P, kappa, minHalfSpreadBps: '1', maxHalfSpreadBps: '200', lotUsd: '50' }).quotes({ nowMs: 0, book: b, inventory: (invMilli / 1000).toFixed(3), volBps: vol });
        const bid = r.quotes.find((x) => x.side === 'buy'), ask = r.quotes.find((x) => x.side === 'sell');
        if (bid) expect(D.lte(D.from(bid.price), D.from(shiftBps(mid, '-1')))).toBe(true);
        if (ask) expect(D.gte(D.from(ask.price), D.from(shiftBps(mid, '1')))).toBe(true);
        if (bid && ask) expect(D.lt(D.from(bid.price), D.from(ask.price))).toBe(true);
        if (bid) expect(D.lte(D.from(bid.price), D.from(b.bid))).toBe(true);
        if (ask) expect(D.gte(D.from(ask.price), D.from(b.ask))).toBe(true);
      }), { numRuns: 2000 });
  });
  it('volatility: EWMA(0.97) of squared changes per interval, past only; nothing before the warm-up; a gap is one observation', () => {
    let s = volInit(); const c = { ...VOL_STUDY_DEFAULTS, warmup: 3 };
    s = volUpdate(s, 65000, 0, c); expect(volBps(s, c)).toBeNull();
    s = volUpdate(s, 65010, 1000, c); expect(s.observations).toBe(0);                                 // inside the interval: ignored
    s = volUpdate(s, 65013, 5000, c);                                                                 // +2 bps
    expect(s.variance).toBeCloseTo(4, 6);
    s = volUpdate(s, 65013, 10000, c); s = volUpdate(s, 65000, 60000, c);                             // 0, then −2 bps after a long gap: ONE observation
    expect(s.observations).toBe(3);
    expect(volBps(s, c)).toBeCloseTo(Math.sqrt(0.97 * (0.97 * 4) + 0.03 * 3.9984), 2);
    expect(volUpdate(s, NaN, 70000, c)).toBe(s); expect(volUpdate(s, 0, 70000, c)).toBe(s);
  });
});

describe('the planner: desired quotes vs resting orders → keep / cancel / place', () => {
  it('nothing rests: both quotes are placed, rounded away from the other side', () => {
    const p = plan({ desired: [want('buy', '64990.7'), want('sell', '65010.2')] });
    expect(p).toMatchObject({ keep: [], cancel: [], reduce: [], actions: 1, degraded: false });
    expect(p.place).toEqual([{ side: 'buy', price: '64990', size: '0.001', level: 0 }, { side: 'sell', price: '65011', size: '0.001', level: 0 }]);
  });
  it('hysteresis: an order within the tolerance of its target is kept — an unchanged situation needs no action', () => {
    const resting = [rest('b', 'buy', '64990'), rest('a', 'sell', '65011')];
    expect(plan({ desired: [want('buy', '64995'), want('sell', '65008')], resting })).toMatchObject({ keep: ['b', 'a'], cancel: [], place: [], actions: 0 });   // 5 and 3 USD: under 2 bps (13 USD)
    const moved = plan({ desired: [want('buy', '64970'), want('sell', '65008')], resting });           // the bid target moved 20 USD: requote that side only
    expect(moved).toMatchObject({ keep: ['a'], cancel: ['b'], actions: 2 });
    expect(moved.place).toEqual([want('buy', '64970')]);
    expect(plan({ desired: [want('buy', '64970'), want('sell', '65008')], resting, toleranceMultiplier: '2' })).toMatchObject({ keep: ['b', 'a'], cancel: [], place: [] });   // under rate pressure the tolerance widens
    // a size too different (a partial fill left 60 %) is requoted
    expect(plan({ desired: [want('buy', '64990')], resting: [rest('b', 'buy', '64990', '0.0006')] })).toMatchObject({ cancel: ['b'] });
    expect(plan({ desired: [want('buy', '64990')], resting: [rest('b', 'buy', '64990', '0.0009')] })).toMatchObject({ keep: ['b'], cancel: [] });
  });
  it('never a crossing pair: against the book, against each other, against an order of ours that is still alive', () => {
    expect(plan({ desired: [want('buy', '65001'), want('sell', '64999')] }).place).toEqual([]);         // both would be refused by the venue (post-only)
    expect(plan({ desired: [want('buy', '65000.5'), want('sell', '65000.4')] }).place.map((x) => x.price)).toEqual(['65000', '65001']);   // a desired pair that touches: rounding moves each AWAY from the other, the placed pair does not cross
    const p = plan({ book: book({ bid: '64000', ask: '66000' }), desired: [want('buy', '65500'), want('sell', '65400')] });
    expect(p.place).toEqual([]);                                                                        // bid above ask: both dropped
    // an ask of ours still alive (its state is not known) at 65005: a bid at or above it waits
    const w = plan({ book: book({ bid: '64000', ask: '66000' }), desired: [want('buy', '65006')], resting: [rest('a', 'sell', '65005', '0.001', 'unknown')] });
    expect(w.place).toEqual([]); expect(w.notes.join(' ')).toMatch(/would cross an order of ours/);
  });
  it('inventory: the soft limit stops the increasing side; the worst case of a side never passes the hard limit; at the hard limit everything is pulled and the excess unwound reduce-only', () => {
    const desired = [want('buy', '64990'), want('sell', '65010')];
    expect(plan({ desired, position: '0.004' }).place.map((x) => x.side)).toEqual(['sell']);
    expect(plan({ desired, position: '-0.004' }).place.map((x) => x.side)).toEqual(['buy']);
    expect(plan({ desired, position: '0.004', resting: [rest('b', 'buy', '64990')] })).toMatchObject({ cancel: ['b'] });   // a resting bid is cancelled at the soft limit
    // position 0.003 + a pending bid of 0.004 + a new bid of 0.002 would reach 0.009 > 0.008
    const p = plan({ position: '0.003', desired: [want('buy', '64990', '0.002'), want('buy', '64900', '0.004', 1)], resting: [rest('p', 'buy', '64900', '0.004', 'pending')] });
    expect(p.keep).toEqual(['p']); expect(p.place).toEqual([]);
    expect(p.notes.join(' ')).toMatch(/hard inventory limit would be reachable/);
    const hard = plan({ desired, position: '0.0095', resting: [rest('b', 'buy', '64990'), rest('a', 'sell', '65010')] });
    expect(hard).toMatchObject({ cancel: ['a', 'b'], place: [], keep: [], actions: 2 });
    expect(hard.reduce).toEqual([{ side: 'sell', price: '64934', size: '0.003' }, { side: 'sell', price: '64934', size: '0.0025' }]);   // down to the soft limit, in chunks, 10 bps through the bid
    expect(plan({ desired, position: '-0.0095' }).reduce[0]).toMatchObject({ side: 'buy', price: '65067' });
  });
  it('modes: pull cancels everything and quotes nothing; flatten also unwinds the whole position', () => {
    const resting = [rest('b', 'buy', '64990'), rest('a', 'sell', '65010')], desired = [want('buy', '64990'), want('sell', '65010')];
    expect(plan({ mode: 'pull', desired, resting, position: '0.002' })).toMatchObject({ cancel: ['a', 'b'], place: [], reduce: [], keep: [] });
    const f = plan({ mode: 'flatten', desired, resting, position: '0.002' });
    expect(f.cancel).toHaveLength(2); expect(f.reduce).toEqual([{ side: 'sell', price: '64934', size: '0.002' }]);
    expect(plan({ mode: 'flatten', position: '0.002', book: book({ bid: '0', ask: '0' }) }).notes.join(' ')).toMatch(/no usable book/);
    // a crossed or empty book in quote mode pulls too
    expect(plan({ desired, resting, book: book({ bid: '65002', ask: '65001' }) })).toMatchObject({ cancel: ['a', 'b'], place: [] });
  });
  it('what is not known is not acted on: pending, cancelling and unknown orders keep their slot and are neither cancelled again nor replaced; a blocked side gets no new quote', () => {
    const p = plan({ desired: [want('buy', '64990'), want('sell', '65010')], resting: [rest('u', 'buy', '64800', '0.001', 'unknown'), rest('c', 'buy', '64700', '0.001', 'cancelling')] });
    expect(p.cancel).toEqual([]);
    expect(p.place.map((x) => x.side)).toEqual(['sell']);                                               // two slots taken on the bid side
    const b = plan({ desired: [want('buy', '64990'), want('sell', '65010')], blockedSides: ['buy'] });
    expect(b.place.map((x) => x.side)).toEqual(['sell']); expect(b.notes.join(' ')).toMatch(/buy side blocked until reconciled/);
    // a pending order at its target is kept, not duplicated
    expect(plan({ desired: [want('buy', '64990')], resting: [rest('p', 'buy', '64990', '0.001', 'pending')] })).toMatchObject({ keep: ['p'], place: [], cancel: [] });
  });
  it('budget: cancels first (the most exposed first), then reductions, then placements — never more than the budget', () => {
    const resting = [rest('far', 'buy', '64000'), rest('near', 'buy', '64995'), rest('a', 'sell', '65500')], desired = [want('buy', '64900'), want('sell', '65100')];
    const one = plan({ desired, resting, budget: { places: 20, cancels: 1, reduces: 20, actions: 3 } });
    expect(one.cancel).toEqual(['near']);                                                               // the closest to the mid goes first
    expect(one.place).toEqual([]); expect(one.degraded).toBe(true);                                     // placements wait for every cancel
    expect(plan({ desired, resting, budget: { places: 1, cancels: 40, reduces: 20, actions: 3 } }).place).toHaveLength(1);
    expect(plan({ desired, resting, budget: { places: 20, cancels: 40, reduces: 20, actions: 1 } })).toMatchObject({ place: [], actions: 1, degraded: true });
    expect(plan({ desired, resting, budget: { places: 20, cancels: 40, reduces: 20, actions: 0 } })).toMatchObject({ cancel: [], place: [], actions: 0, degraded: true });
    const hard = plan({ desired, resting, position: '0.02', budget: { places: 20, cancels: 40, reduces: 1, actions: 2 } });
    expect(hard.cancel).toHaveLength(3); expect(hard.reduce).toHaveLength(1); expect(hard.degraded).toBe(true);
  });

  // ---- properties ----
  const side = fc.constantFrom<Side>('buy', 'sell');
  const px = fc.integer({ min: 64000, max: 66000 }).map(String), size = fc.integer({ min: 16, max: 400 }).map((x) => (x / 1e5).toFixed(5));
  const desiredArb = fc.array(fc.record({ side, price: px, size, level: fc.integer({ min: 0, max: 2 }) }), { maxLength: 6 });
  const restingArb = fc.array(fc.record({ side, price: px, size, state: fc.constantFrom<RestingOrder['state']>('resting', 'resting', 'pending', 'cancelling', 'unknown') }), { maxLength: 6 })
    .map((xs) => xs.map((x, k): RestingOrder => ({ ...x, clientId: `o${k}`, placedAt: 0 })));
  const budgetArb = fc.record({ places: fc.integer({ min: 0, max: 6 }), cancels: fc.integer({ min: 0, max: 6 }), reduces: fc.integer({ min: 0, max: 4 }), actions: fc.integer({ min: 0, max: 3 }) });
  const bookArb = fc.tuple(fc.integer({ min: 64500, max: 65500 }), fc.integer({ min: -3, max: 40 })).map(([b, s]) => book({ bid: String(b), ask: String(b + s) }));
  const posArb = fc.integer({ min: -1200, max: 1200 }).map((x) => (x / 1e5).toFixed(5));
  const modeArb = fc.constantFrom<'quote' | 'pull' | 'flatten'>('quote', 'quote', 'quote', 'pull', 'flatten');
  const input = fc.record({ book: bookArb, position: posArb, desired: desiredArb, resting: restingArb, budget: budgetArb, mode: modeArb, blockedSides: fc.subarray<Side>(['buy', 'sell']) });

  it('property: never a crossing pair, never more than the budget, never an action on what is not known', () => {
    fc.assert(fc.property(input, (i) => {
      const p = plan(i), n = (x: string) => Number(x), gone = new Set(p.cancel), alive = i.resting.filter((o) => !gone.has(o.clientId));
      const bids = p.place.filter((x) => x.side === 'buy'), asks = p.place.filter((x) => x.side === 'sell');
      for (const b of bids) { expect(n(b.price)).toBeLessThan(n(i.book.ask)); for (const a of asks) expect(n(b.price)).toBeLessThan(n(a.price)); for (const o of alive.filter((x) => x.side === 'sell')) expect(n(b.price)).toBeLessThan(n(o.price)); }
      for (const a of asks) { expect(n(a.price)).toBeGreaterThan(n(i.book.bid)); for (const o of alive.filter((x) => x.side === 'buy')) expect(n(a.price)).toBeGreaterThan(n(o.price)); }
      expect(p.place.length).toBeLessThanOrEqual(i.budget.places); expect(p.cancel.length).toBeLessThanOrEqual(i.budget.cancels); expect(p.reduce.length).toBeLessThanOrEqual(i.budget.reduces);
      expect(p.actions).toBe((p.cancel.length ? 1 : 0) + (p.reduce.length ? 1 : 0) + (p.place.length ? 1 : 0)); expect(p.actions).toBeLessThanOrEqual(i.budget.actions);
      for (const id of p.cancel) expect(i.resting.find((o) => o.clientId === id)!.state).toBe('resting');
      expect(p.keep.filter((id) => gone.has(id))).toEqual([]);
      for (const x of p.place) { expect(i.blockedSides).not.toContain(x.side); expect(n(x.price) * n(x.size)).toBeGreaterThanOrEqual(10); }
      if (i.mode !== 'quote') expect(p.place).toEqual([]);
      for (const s of ['buy', 'sell'] as const) if (p.place.some((x) => x.side === s)) expect(alive.filter((o) => o.side === s).length + p.place.filter((x) => x.side === s).length).toBeLessThanOrEqual(CFG.maxRestingPerSide);
    }), { numRuns: 4000 });
  });
  it('property: the inventory can never pass the hard limit through a quote the planner placed, under ANY fill sequence; reductions only reduce', () => {
    fc.assert(fc.property(input, fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), (i, fills) => {
      const p = plan(i), pos = Number(i.position), hard = Number(CFG.hardInventory), soft = Number(CFG.softInventory), eps = 1e-9;
      const gone = new Set(p.cancel), alive = i.resting.filter((o) => !gone.has(o.clientId));
      const buys = p.place.filter((x) => x.side === 'buy'), sells = p.place.filter((x) => x.side === 'sell');
      if (buys.length) { expect(pos).toBeLessThan(soft); expect(pos + [...alive.filter((o) => o.side === 'buy'), ...buys].reduce((s, o) => s + Number(o.size), 0)).toBeLessThanOrEqual(hard + eps); }
      if (sells.length) { expect(pos).toBeGreaterThan(-soft); expect(-pos + [...alive.filter((o) => o.side === 'sell'), ...sells].reduce((s, o) => s + Number(o.size), 0)).toBeLessThanOrEqual(hard + eps); }
      // any subset of the orders alive after the plan fills: if the planner placed on a side, that side's fills cannot push past the hard limit
      const all = [...alive.map((o) => ({ side: o.side, size: Number(o.size) })), ...p.place.map((o) => ({ side: o.side, size: Number(o.size) }))];
      let after = pos; all.forEach((o, k) => { if (fills[k % fills.length]) after += o.side === 'buy' ? o.size : -o.size; });
      if (buys.length && after > pos) expect(after).toBeLessThanOrEqual(hard + eps);
      if (sells.length && after < pos) expect(after).toBeGreaterThanOrEqual(-hard - eps);
      // reductions: opposite to the position, never more than it
      const red = p.reduce.reduce((s, r) => s + Number(r.size), 0);
      for (const r of p.reduce) expect(r.side).toBe(pos > 0 ? 'sell' : 'buy');
      expect(red).toBeLessThanOrEqual(Math.abs(pos) + eps);
      if (Math.abs(pos) >= hard) expect(p.place).toEqual([]);
    }), { numRuns: 4000 });
  });
  it('property: the plan is stable — once it is applied, the same situation needs nothing more', () => {
    fc.assert(fc.property(input, (i0) => {
      const i = { ...i0, mode: 'quote' as const, blockedSides: [], budget: BIG, resting: i0.resting.filter((o) => o.state === 'resting') };
      const p = plan(i), gone = new Set(p.cancel);
      const after: RestingOrder[] = [...i.resting.filter((o) => !gone.has(o.clientId)), ...p.place.map((x, k) => rest(`n${k}`, x.side, x.price, x.size))];
      const again = plan({ ...i, resting: after });
      expect(again.cancel).toEqual([]);
      expect(again.place.every((x) => !p.place.some((y) => y.side === x.side && y.price === x.price))).toBe(true);   // nothing placed twice
    }), { numRuns: 2000 });
  });
});

describe('rate budget of a cycle', () => {
  const RC: RateConfig = { addressReserve: 500, addressComfort: 2000, ipReserve: 300, ipWeightPerQuoteBatch: 43, maxBatch: 20 };
  const S: RateState = { addressRemaining: 9000, ipWeightRemaining: 1100, signerActions: 5, signerOrdersHour: 1000, signerOrdersDay: 5000 };
  it('comfortable: a full batch; under pressure: one level and a wider hysteresis; at the reserve: no quote — cancels and reductions always', () => {
    expect(cycleBudget(S, RC)).toMatchObject({ places: 20, cancels: 40, reduces: 20, actions: 3, toleranceMultiplier: '1', maxLevels: null, reason: null });
    const tight = cycleBudget({ ...S, addressRemaining: 1500 }, RC);                                    // 1 000 above the reserve, comfort 2 000
    expect(tight).toMatchObject({ places: 2, maxLevels: 1, toleranceMultiplier: '2.5' }); expect(tight.reason).toMatch(/under pressure/);
    for (const [s, why] of [[{ ...S, addressRemaining: 500 }, /reserve reached/], [{ ...S, addressRemaining: null }, /not known/], [{ ...S, ipWeightRemaining: 320 }, /IP weight/], [{ ...S, signerActions: 0 }, /signer rate/], [{ ...S, signerOrdersHour: 0 }, /signer rate/]] as const) {
      const b = cycleBudget(s, RC);
      expect(b.places).toBe(0); expect(b.reason).toMatch(why); expect(b.cancels).toBe(40); expect(b.reduces).toBe(20); expect(b.actions).toBeGreaterThanOrEqual(1);
    }
    expect(cycleBudget({ ...S, signerOrdersHour: 3 }, RC).places).toBe(3);
  });
  it('property: quotes are never budgeted beyond any of the limits', () => {
    fc.assert(fc.property(fc.option(fc.integer({ min: 0, max: 20000 }), { nil: null }), fc.integer({ min: 0, max: 1200 }), fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }), (addr, ip, act, h, d) => {
      const b = cycleBudget({ addressRemaining: addr, ipWeightRemaining: ip, signerActions: act, signerOrdersHour: h, signerOrdersDay: d }, RC);
      expect(b.places).toBeLessThanOrEqual(Math.max(0, (addr ?? 0) - RC.addressReserve)); expect(b.places).toBeLessThanOrEqual(Math.min(h, d, RC.maxBatch));
      if (act === 0 || ip - RC.ipReserve < RC.ipWeightPerQuoteBatch) expect(b.places).toBe(0);
      expect(Number(b.toleranceMultiplier)).toBeGreaterThanOrEqual(1); expect(Number(b.toleranceMultiplier)).toBeLessThanOrEqual(4);
    }), { numRuns: 2000 });
  });
});

describe('circuit breakers: each one pulls the quotes', () => {
  const C: BreakerConfig = { maxDataAgeMs: 3000, maxSpreadBps: '10', minTopDepthUsd: '1000', volSpikeMultiple: 4, maxVolBps: 30, fillBurstCount: 4, fillBurstWindowMs: 10_000, minMarkoutBps: '-3', markoutSample: 5, consecutiveRejects: 5,
    maxSessionLossUsd: '-20', maxDayLossUsd: '-50', coolDownMs: 30_000, action: {} };
  const O = (o: Partial<BreakerObservation> = {}): BreakerObservation => ({ nowMs: 100_000, venueStatus: 'connected', bookTs: 99_500, bid: '64999', bidSize: '1', ask: '65001', askSize: '1', volBps: 2, baselineVolBps: 2, fillTimes: [], markouts10s: [], consecutiveRejects: 0,
    sessionPnlUsd: '0', dayPnlUsd: '0', killSwitch: false, ...o });
  const trip = (o: Partial<BreakerObservation>, cfg: Partial<BreakerConfig> = {}) => stepBreakers(breakersInit(), O(o), { ...C, ...cfg });
  it('a healthy observation trips nothing', () => { expect(trip({})).toMatchObject({ tripped: [], active: [], pull: false, flatten: false, halted: null }); });
  const cases: [string, Partial<BreakerObservation>, string][] = [
    ['data stale', { bookTs: 96_999 }, 'data_stale'], ['no book yet', { bookTs: null }, 'data_stale'], ['venue status not connected', { venueStatus: 'reconnecting' }, 'venue_disconnected'], ['venue stale', { venueStatus: 'stale' }, 'venue_disconnected'],
    ['book crossed', { bid: '65002', ask: '65001' }, 'book_crossed'], ['book locked', { bid: '65001', ask: '65001' }, 'book_crossed'], ['book thin', { askSize: '0.01' }, 'book_thin'], ['spread blow-out', { bid: '64900', ask: '65100' }, 'spread_blowout'],
    ['volatility spike vs baseline', { volBps: 9, baselineVolBps: 2 }, 'vol_spike'], ['volatility above the absolute ceiling', { volBps: 31, baselineVolBps: 20 }, 'vol_spike'],
    ['fill burst', { fillTimes: [91_000, 95_000, 96_000, 97_000, 99_000] }, 'fill_burst'], ['adverse selection', { markouts10s: ['1', '-4', '-5', '-4', '-6', '-3'] }, 'adverse_selection'],
    ['consecutive rejects', { consecutiveRejects: 5 }, 'consecutive_rejects'], ['session drawdown', { sessionPnlUsd: '-20.01' }, 'drawdown_session'], ['day drawdown', { dayPnlUsd: '-50.5' }, 'drawdown_day'], ['kill switch', { killSwitch: true }, 'kill_switch'],
  ];
  for (const [name, o, code] of cases) it(`${name} → ${code}: quotes pulled`, () => { const v = trip(o); expect(v.tripped).toContain(code); expect(v.pull).toBe(true); });
  it('just inside each threshold: nothing', () => {
    for (const o of [{ bookTs: 97_000 }, { bid: '64968', ask: '65032' }, { volBps: 8, baselineVolBps: 2 }, { fillTimes: [91_000, 95_000, 96_000, 97_000] }, { fillTimes: [80_000, 85_000, 89_000, 95_000, 96_000, 97_000, 99_000] }, { markouts10s: ['-9', '-9', '-3', '-3', '-3', '-3', '-3'] },
      { markouts10s: ['-9', '-9', '-9', '-9'] }, { consecutiveRejects: 4 }, { sessionPnlUsd: '-20' }, { dayPnlUsd: '-50' }, { askSize: '0.0154' }] as Partial<BreakerObservation>[]) expect(trip(o).tripped, JSON.stringify(o)).toEqual([]);
  });
  it('cool-down: quotes stay pulled after a transient breaker clears; drawdown and rejects stop the session until an operator resets; the kill switch ends when lifted', () => {
    let v = trip({ volBps: 40 });
    expect(v.active).toEqual(['vol_spike']);
    v = stepBreakers(v.state, O({ nowMs: 129_999, bookTs: 129_900 }), C); expect(v).toMatchObject({ tripped: [], active: ['vol_spike'], pull: true });
    v = stepBreakers(v.state, O({ nowMs: 130_000, bookTs: 129_900 }), C); expect(v).toMatchObject({ active: [], pull: false });
    let h = trip({ sessionPnlUsd: '-25' });
    expect(h.halted).toBe('drawdown_session');
    h = stepBreakers(h.state, O({ nowMs: 900_000, bookTs: 899_900 }), C); expect(h).toMatchObject({ pull: true, halted: 'drawdown_session' });   // the PnL is back to zero: still halted
    expect(stepBreakers(breakersReset(), O({}), C).pull).toBe(false);
    let k = trip({ killSwitch: true }); k = stepBreakers(k.state, O({ nowMs: 100_500 }), C); expect(k.pull).toBe(false);
  });
  it('the configured policy decides the inventory: hold by default, flatten or halt per breaker', () => {
    expect(trip({ volBps: 40 }).flatten).toBe(false);
    expect(trip({ volBps: 40 }, { action: { vol_spike: 'flatten' } }).flatten).toBe(true);
    expect(trip({ sessionPnlUsd: '-25' }, { action: { drawdown_session: 'flatten' } })).toMatchObject({ flatten: true, halted: 'drawdown_session' });
    expect(trip({ venueStatus: 'stale' }, { action: { venue_disconnected: 'halt' } }).halted).toBe('venue_disconnected');
  });
});

describe('markouts and PnL attribution', () => {
  it('markouts at 1 s, 10 s, 60 s: the first mid at or after each horizon; negative = adverse selection', () => {
    let s = markoutInit();
    s = markoutAddFill(s, { id: 'f1', ts: 1000, side: 'buy', price: '65000', size: '0.001' });
    s = markoutAddFill(s, { id: 'f1', ts: 1000, side: 'buy', price: '65000', size: '0.001' });        // the same fill twice is one fill
    s = markoutAddFill(s, { id: 'f2', ts: 1500, side: 'sell', price: '65010', size: '0.002' });
    s = markoutOnMid(s, 1900, '64990');                                                                 // before any horizon
    expect(s.fills.map((f) => f.bps)).toEqual([[null, null, null], [null, null, null]]);
    s = markoutOnMid(s, 2000, '64987');                                                                 // f1 at 1 s: bought 65000, mid 64987 → −2 bps
    expect(s.fills[0]!.bps[0]).toBe('-2'); expect(s.fills[1]!.bps[0]).toBeNull();
    s = markoutOnMid(s, 2600, '64997'); expect(s.fills[1]!.bps[0]).toBe('1.9997');                   // f2 sold 65010, mid 64997 → +2 bps
    s = markoutOnMid(s, 12_000, '65013'); s = markoutOnMid(s, 70_000, '65000');
    expect(s.fills[0]!.bps[1]).toBe('2'); expect(s.fills[0]!.bps[2]).toBe('0'); expect(s.open).toBe(0);
    expect(markouts10s(s)).toHaveLength(2);
    const sum = markoutSummary(s);
    expect(sum.map((x) => [x.horizonMs, x.fills])).toEqual([[1000, 2], [10_000, 2], [60_000, 2]]);
    expect(sum[0]).toMatchObject({ worstBps: '-2' }); expect(Number(sum[0]!.meanBps)).toBeCloseTo(0, 2);
    expect(markoutSummary(markoutInit())[0]).toMatchObject({ fills: 0, meanBps: null, weightedMeanBps: null, worstBps: null });
  });
  it('attribution by hand: spread capture, inventory PnL, fees, funding', () => {
    let p = pnlInit();
    p = pnlOnMid(p, '65000');
    p = pnlOnFill(p, { side: 'buy', price: '64990', size: '0.01', fee: '0.097485', mid: '65000' });    // captured 10 × 0.01 = 0.1; maker fee 1.5 bps of 649.9
    p = pnlOnMid(p, '64950');                                                                           // long 0.01 through −50: −0.5
    p = pnlOnFill(p, { side: 'sell', price: '64960', size: '0.01', fee: '-0.0065', mid: '64950' });    // captured 0.1; a rebate
    p = pnlOnFunding(p, '-0.02');
    expect(pnlReport(p)).toMatchObject({ spreadCaptureUsd: '0.2', inventoryPnlUsd: '-0.5', feesUsd: '-0.090985', fundingUsd: '-0.02', totalUsd: '-0.410985', position: '0', fills: 2, volumeUsd: '1299.5' });
    expect(pnlMarkToMarket(p)).toBe('-0.410985');
    expect(pnlReport(p).bpsOfVolume).toBe('-3.1626');
    expect(pnlReport(pnlInit())).toMatchObject({ totalUsd: '0', bpsOfVolume: null });
  });
  it('property: the attribution always adds up to the mark-to-market (cash + position × mid), exactly', () => {
    const ev = fc.oneof(
      fc.record({ k: fc.constant('mid' as const), mid: fc.integer({ min: 6_000_000, max: 7_000_000 }) }),
      fc.record({ k: fc.constant('fill' as const), side: fc.constantFrom<Side>('buy', 'sell'), off: fc.integer({ min: -3000, max: 3000 }), size: fc.integer({ min: 1, max: 500 }), fee: fc.integer({ min: -2000, max: 9000 }) }),
      fc.record({ k: fc.constant('funding' as const), usd: fc.integer({ min: -500, max: 500 }) }));
    fc.assert(fc.property(fc.array(ev, { maxLength: 60 }), (events) => {
      let p = pnlOnMid(pnlInit(), '65000'), mid = 6_500_000;
      for (const e of events) {
        if (e.k === 'mid') { mid = e.mid; p = pnlOnMid(p, (mid / 100).toFixed(2)); }
        else if (e.k === 'fill') p = pnlOnFill(p, { side: e.side, price: ((mid + e.off) / 100).toFixed(2), size: (e.size / 1e5).toFixed(5), fee: (e.fee / 1e6).toFixed(6), mid: (mid / 100).toFixed(2) });
        else p = pnlOnFunding(p, (e.usd / 1e4).toFixed(4));
      }
      expect(pnlReport(p).totalUsd).toBe(pnlMarkToMarket(p));
    }), { numRuns: 1500 });
  });
});

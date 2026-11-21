/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/paper-venue.ts
 * Module           : mm
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

// PAPER `OrderPort` of the market-making engine: the SAME engine, planner, breakers and quoting rule as live, on REAL books,
// against a simulated venue account. Nothing here reaches a venue or a signer.
//
// ONE FILL MODEL. Paper fills are decided by `mmFills` of agent-runtime/families.ts — the stream runtime's conservative rule, kept
// as the only paper fill model of the product:
//   1. a quote can be filled only by a book observed at least `minRestMs` AFTER it was placed (never the book it was priced from);
//   2. only when the market TRADES THROUGH it — a later best ask strictly BELOW a bid, a later best bid strictly ABOVE an ask
//      (a touch is not a fill: no queue position is modelled);
//   3. at OUR price, for at most the size displayed at the opposite best price that crossed; what is left of the quote is
//      withdrawn (it does not keep a place in a queue the model does not have);
//   4. the venue's maker fee on every fill; a reduce-only unwind is an immediate order against the displayed best price, at
//      that price, for at most the displayed size, at the taker fee.
// Why this one and not the queue model of the foundations' simulated venue: the runtime sees the top of the book only (the same
// rows it records and replays in a backtest — `replayRecorded` uses `mmFills` too), and a queue needs the public trades, which
// the runtime does not consume. The simulated venue is now a test double of the VENUE (services/api/test/mm-sim-venue.ts): its
// fills exist to exercise the live path, they are no paper model. Docs: docs/V11-MARKET-MAKING.md, "Paper mode".
import { D, type DecStr } from '@spw/derivatives';
import type { BookTop } from '@spw/trading/mm';
import { mmFills, type Quote } from '../agent-runtime/families.ts';
import type { AccountRead, BatchOutcome, CancelOutcome, OrderLookup, OrderPort, OrderResult, QuoteOrder, SwitchOutcome, VenueFill, VenueOpenOrder } from './ports.ts';

interface PaperOrder { clientId: string; oid: string; side: 'buy' | 'sell'; price: DecStr; size: DecStr; ts: number }
/** what survives a restart of the worker (stored in the agent's runtime) */
export interface PaperVenueState { position: DecStr; /** realised cash flow of the simulation: Σ sells − Σ buys − fees + funding */ cash: DecStr; fees: DecStr; funding: DecStr; turnover: DecStr; orders: PaperOrder[]; seq: number;
  switchDeadline: number | null; triggers: Record<string, number>; done: Record<string, 'filled' | 'cancelled' | 'rejected'> }
export const newPaperState = (): PaperVenueState => ({ position: '0', cash: '0', fees: '0', funding: '0', turnover: '0', orders: [], seq: 0, switchDeadline: null, triggers: {}, done: {} });
export interface PaperVenueOptions { instrument: string; now: () => number; book: () => BookTop | null; makerRate: DecStr; takerRate: DecStr; capitalUsd: DecStr; minRestMs?: number; minNotionalUsd?: DecStr; state?: PaperVenueState }

const d = D.from, s = D.str;
export class PaperVenue implements OrderPort {
  readonly actionTtlMs = 10_000;
  state: PaperVenueState;
  private recent: VenueFill[] = [];
  private readonly o: PaperVenueOptions;
  constructor(o: PaperVenueOptions) { this.o = o; this.state = o.state ? { ...newPaperState(), ...o.state, orders: [...(o.state.orders ?? [])] } : newPaperState(); }

  private finish(o: PaperOrder, how: 'filled' | 'cancelled' | 'rejected'): void {
    this.state.orders = this.state.orders.filter((x) => x.clientId !== o.clientId);
    this.state.done[o.clientId] = how;
    const keys = Object.keys(this.state.done); if (keys.length > 400) for (const k of keys.slice(0, keys.length - 300)) delete this.state.done[k];
  }
  private fill(o: { clientId: string; oid: string; side: 'buy' | 'sell' }, size: DecStr, price: DecStr, maker: boolean, ts: number): VenueFill {
    const sz = d(size), px = d(price), notional = D.mul(px, sz), fee = D.div(D.mul(notional, d(maker ? this.o.makerRate : this.o.takerRate)), D.one, 8, 'half_even'), buy = o.side === 'buy';
    this.state.position = s(buy ? D.add(d(this.state.position), sz) : D.sub(d(this.state.position), sz));
    this.state.cash = s(D.sub(buy ? D.sub(d(this.state.cash), notional) : D.add(d(this.state.cash), notional), fee));
    this.state.fees = s(D.add(d(this.state.fees), fee)); this.state.turnover = s(D.add(d(this.state.turnover), notional));
    this.state.seq += 1;
    const f: VenueFill = { id: `paper-${this.state.seq}`, clientId: o.clientId, venueOrderId: o.oid, side: o.side, price: s(px), size: s(sz), fee: s(fee), ts, maker };
    this.recent.push(f); if (this.recent.length > 1000) this.recent.shift();
    return f;
  }
  /** a funding settlement of the simulated position (positive = received) */
  funding(usd: DecStr): void { this.state.cash = s(D.add(d(this.state.cash), d(usd))); this.state.funding = s(D.add(d(this.state.funding), d(usd))); }

  /** follow the data: the dead man's switch of the simulation, then the maker fills the current book implies. Called before each engine cycle. */
  step(): VenueFill[] {
    const now = this.o.now(), out: VenueFill[] = [];
    if (this.state.switchDeadline !== null && now >= this.state.switchDeadline) {
      const day = new Date(now).toISOString().slice(0, 10);
      this.state.switchDeadline = null; this.state.triggers = { [day]: (this.state.triggers[day] ?? 0) + 1 };
      for (const o of [...this.state.orders]) this.finish(o, 'cancelled');
    }
    const b = this.o.book();
    if (!b || !this.state.orders.length) return out;
    const quotes: Quote[] = this.state.orders.map((o) => ({ id: o.clientId, side: o.side, price: Number(o.price), size: Number(o.size), ts: o.ts, instrument: this.o.instrument }));
    for (const f of mmFills(quotes, { id: this.o.instrument, bid: Number(b.bid), bidSize: Number(b.bidSize), ask: Number(b.ask), askSize: Number(b.askSize), bookTs: b.ts }, this.o.minRestMs ?? 1000)) {
      const o = this.state.orders.find((x) => x.clientId === f.quote.id);
      if (!o) continue;
      // at OUR price; at most the displayed size that crossed, and never more than the order
      const size = D.min(d(o.size), d(o.side === 'buy' ? b.askSize : b.bidSize));
      if (!D.isPos(size)) continue;
      out.push(this.fill(o, s(size), o.price, true, b.ts));
      this.finish(o, 'filled');                                                                   // the remainder, if any, is withdrawn
    }
    return out;
  }

  async submitQuotes(_instrument: string, quotes: readonly QuoteOrder[]): Promise<BatchOutcome> {
    const b = this.o.book(), now = this.o.now();
    if (!b) return { kind: 'refused', stage: 'venue', code: 'no_book', message: 'the simulated venue has no book to rest an order in' };
    const results = quotes.map((q): OrderResult => {
      if (this.state.orders.some((x) => x.clientId === q.clientId) || this.state.done[q.clientId]) return { clientId: q.clientId, outcome: 'rejected', code: 'duplicate_client_id', reason: 'client order id already used' };
      if (D.lt(D.mul(d(q.price), d(q.size)), d(this.o.minNotionalUsd ?? '10'))) return { clientId: q.clientId, outcome: 'rejected', code: 'min_notional', reason: 'Order must have minimum value of $10.' };
      if (q.side === 'buy' ? D.gte(d(q.price), d(b.ask)) : D.lte(d(q.price), d(b.bid))) return { clientId: q.clientId, outcome: 'rejected', code: 'post_only_would_cross', reason: `Post only order would have immediately matched, bbo was ${b.bid}@${b.ask}.` };
      this.state.seq += 1;
      const o: PaperOrder = { clientId: q.clientId, oid: `sim:${this.state.seq}`, side: q.side, price: q.price, size: q.size, ts: now };
      this.state.orders.push(o);
      return { clientId: q.clientId, outcome: 'resting', venueOrderId: o.oid };
    });
    return { kind: 'done', results };
  }
  async submitReduces(_instrument: string, orders: readonly QuoteOrder[]): Promise<BatchOutcome> {
    const b = this.o.book(), now = this.o.now();
    if (!b) return { kind: 'refused', stage: 'venue', code: 'no_book', message: 'the simulated venue has no book to execute against' };
    const results = orders.map((q): OrderResult => {
      const pos = d(this.state.position), sell = q.side === 'sell';
      if (D.isZero(pos) || (sell ? D.isNeg(pos) : D.isPos(pos))) return { clientId: q.clientId, outcome: 'rejected', code: 'reduce_only', reason: 'Reduce only order would increase position.' };
      const at = sell ? b.bid : b.ask, crosses = sell ? D.lte(d(q.price), d(b.bid)) : D.gte(d(q.price), d(b.ask));
      const size = D.min(D.min(d(q.size), D.abs(pos)), d(sell ? b.bidSize : b.askSize));
      if (!crosses || !D.isPos(size)) { this.state.done[q.clientId] = 'cancelled'; return { clientId: q.clientId, outcome: 'rejected', code: 'ioc_no_match', reason: 'Order could not immediately match against any resting orders.' }; }
      this.state.seq += 1;
      const oid = `sim:${this.state.seq}`;
      this.fill({ clientId: q.clientId, oid, side: q.side }, s(size), at, false, now);
      this.state.done[q.clientId] = 'filled';
      return { clientId: q.clientId, outcome: 'filled', venueOrderId: oid, size: s(size), price: at };
    });
    return { kind: 'done', results };
  }
  async cancel(_instrument: string, clientIds: readonly string[]): Promise<CancelOutcome> {
    return { kind: 'done', results: clientIds.map((clientId) => { const o = this.state.orders.find((x) => x.clientId === clientId); if (!o) return { clientId, outcome: 'gone' as const }; this.finish(o, 'cancelled'); return { clientId, outcome: 'cancelled' as const }; }) };
  }
  async scheduleCancel(timeMs: number | null): Promise<SwitchOutcome> {
    if (timeMs !== null && timeMs < this.o.now() + 5000) return { kind: 'refused', stage: 'venue', code: 'schedule_cancel_refused', message: 'Scheduled cancel time too early, must be at least 5 seconds from now' };
    this.state.switchDeadline = timeMs;
    return { kind: 'done' };
  }
  async openOrders(): Promise<VenueOpenOrder[]> { return this.state.orders.map((o) => ({ clientId: o.clientId, venueOrderId: o.oid, side: o.side, price: o.price, size: o.size, reduceOnly: false, timestamp: o.ts })); }
  async account(): Promise<AccountRead> { return { position: this.state.position, accountValue: this.equity(), ts: this.o.now() }; }
  async fills(_instrument: string, sinceMs: number): Promise<VenueFill[]> { return this.recent.filter((f) => f.ts >= sinceMs); }
  async lookup(_instrument: string, clientId: string): Promise<OrderLookup> { return this.state.orders.some((o) => o.clientId === clientId) ? 'open' : this.state.done[clientId] ?? 'not_found'; }
  async addressRequestsRemaining(): Promise<number> { return 10_000; }
  /** capital + realised cash flow + the position at the current mid */
  equity(): DecStr {
    const b = this.o.book(), mid = b ? D.div(D.add(d(b.bid), d(b.ask)), d('2'), 12, 'half_even') : D.zero;
    return s(D.add(D.add(d(this.o.capitalUsd), d(this.state.cash)), D.mul(d(this.state.position), mid)));
  }
  triggersToday(): number { return this.state.triggers[new Date(this.o.now()).toISOString().slice(0, 10)] ?? 0; }
}

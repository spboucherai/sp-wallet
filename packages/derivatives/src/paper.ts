/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/paper.ts
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

/**
 * Paper trading account: a simulated cross-margin account filled against the order books it is given.
 *
 * Deterministic: it never reads the clock and never draws a random number; every timestamp is the `now` passed in and every
 * id comes from a counter in the state. The whole account is `state`, a plain JSON-serialisable object (`serialize` /
 * `PaperAccount.restore`); continuing from a restored state gives exactly the same results. All arithmetic is on `Dec`.
 *
 * Simulation rules (simplifications are deliberate and listed here):
 *  - Market and IOC orders walk the opposite side of the supplied book, best level first, never beyond the order's price
 *    (limit price, or worst acceptable price of a market order). What cannot be filled is cancelled. Taker fee.
 *  - A GTC limit order fills its crossing part as a taker, then rests. A resting order is filled by a LATER book (`onBook`,
 *    strictly newer `ts` for that instrument) whose opposite side crosses its price: at the order's own price, for at most
 *    the crossing depth (shared between resting orders, oldest first). Maker fee. Queue position is not modelled.
 *  - `alo` (post only) is rejected if it would cross.
 *  - Stop / take-profit orders wait as 'pending'; `onTicker` turns them 'triggered' on the MARK price; the next `onBook`
 *    executes them (market variants as takers bounded by their worst price, limit variants as limit orders).
 *  - Reduce-only: rejected at submission when there is nothing to reduce or when it is larger than the position; a resting or
 *    triggered reduce-only order is clipped to the position when it executes and cancelled when the position is gone.
 *  - Margin: one leverage per instrument (config). An order that adds exposure needs free collateral ≥ initial margin of the
 *    added size at the order price + its fee; resting orders reserve nothing and are checked again when they fill.
 *  - Funding: amount = −size·mark·rate for a long, +size·mark·rate for a short (a positive rate is paid by longs), on the
 *    last mark seen. Idempotent per (instrument, ts).
 *  - Liquidation (simulated, flagged): when account equity < Σ maintenance margin, every open order is cancelled and every
 *    position is closed at its last mark with `liquidation: true` fills. Real venues liquidate through their book or a
 *    backstop, often partially; this is a pessimistic, simplified stand-in. Collateral can end negative (bad debt is shown,
 *    not hidden).
 */
import { z } from 'zod';
import { D, type Dec, type DecStr } from './decimal.ts';
import { applyOrderToPosition, CALC_SCALE, initialMargin, liquidationPriceCross, signedSize, unrealizedPnl } from './margin.ts';
import {
  BookSchema, DecStrSchema, FillSchema, FundingPaymentSchema, OrderRequestSchema, OrderSchema, SideSchema, TickerSchema, VenueIdSchema,
  type AccountState, type Book, type Fill, type FundingPayment, type Order, type OrderRequest, type Position, type Ticker, type VenueId,
} from './models.ts';

const NonNegDec = DecStrSchema.refine((x) => !x.startsWith('-'), 'must not be negative');
const PosDec = NonNegDec.refine((x) => /[1-9]/.test(x), 'must be positive');

export const PaperConfigSchema = z.object({
  /** fee rates as fractions of the notional (0.00045 = 4.5 bps); the maker rate may be negative (rebate) */
  takerFeeRate: NonNegDec,
  makerFeeRate: DecStrSchema,
  /** fee rate charged on simulated liquidation fills */
  liquidationFeeRate: NonNegDec,
  feeAsset: z.string().min(1),
  /** leverage used for initial margin, and per-instrument overrides */
  leverage: PosDec,
  leverageByInstrument: z.record(z.string(), PosDec),
  /** flat maintenance margin fraction of the notional at mark */
  maintenanceMarginFraction: NonNegDec,
});
export type PaperConfig = z.infer<typeof PaperConfigSchema>;

export const PaperPositionSchema = z.object({
  instrument: z.string().min(1), side: SideSchema, size: PosDec, entryPrice: PosDec, markPrice: PosDec,
  realizedPnl: DecStrSchema, fundingPaid: DecStrSchema,
});
export type PaperPosition = z.infer<typeof PaperPositionSchema>;

export const PaperStateSchema = z.object({
  version: z.literal(1),
  venue: VenueIdSchema,
  account: z.string().min(1),
  /** cash balance: deposits + realised PnL − fees + funding; excludes unrealized PnL */
  collateral: DecStrSchema,
  config: PaperConfigSchema,
  positions: z.array(PaperPositionSchema),
  /** every order ever submitted, oldest first */
  orders: z.array(OrderSchema),
  fills: z.array(FillSchema),
  funding: z.array(FundingPaymentSchema),
  /** last mark and last book timestamp seen per instrument */
  marks: z.record(z.string(), PosDec),
  lastBookTs: z.record(z.string(), z.number().int().nonnegative()),
  /** cumulative figures */
  realizedPnl: DecStrSchema,
  feesPaid: DecStrSchema,
  fundingNet: DecStrSchema,
  liquidations: z.number().int().nonnegative(),
  /** id counter */
  seq: z.number().int().nonnegative(),
});
export type PaperState = z.infer<typeof PaperStateSchema>;

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  takerFeeRate: '0.00045', makerFeeRate: '0.00015', liquidationFeeRate: '0', feeAsset: 'USDC',
  leverage: '5', leverageByInstrument: {}, maintenanceMarginFraction: '0.01',
};

export interface PaperResult {
  /** the order concerned (submit / cancel); null for market-data events */
  order: Order | null;
  /** fills created by this call, liquidation fills included */
  fills: Fill[];
  /** orders whose state changed in this call */
  orders: Order[];
  funding: FundingPayment[];
  /** true when this call triggered a simulated liquidation */
  liquidated: boolean;
}

type Level = { price: Dec; size: Dec };
const OPEN_STATUSES: readonly Order['status'][] = ['pending', 'triggered', 'open', 'partially_filled'];
const isOpen = (o: Order): boolean => OPEN_STATUSES.includes(o.status);
const isTriggerType = (t: Order['type']): boolean => t !== 'limit' && t !== 'market';
const isMarketLike = (t: Order['type']): boolean => t === 'market' || t === 'stop_market' || t === 'take_profit_market';

export class PaperAccount {
  /** the whole account; plain and serialisable */
  readonly state: PaperState;
  /** derived index of `state.fills` ids (rebuilt on restore) */
  readonly fillIds: Set<string>;

  constructor(state: PaperState) {
    this.state = PaperStateSchema.parse(state);
    this.fillIds = new Set(this.state.fills.map((f) => f.id));
  }

  static create(o: { venue: VenueId; account: string; collateral: DecStr; config?: Partial<PaperConfig> }): PaperAccount {
    return new PaperAccount({
      version: 1, venue: o.venue, account: o.account, collateral: D.str(D.from(o.collateral)),
      config: { ...DEFAULT_PAPER_CONFIG, ...(o.config ?? {}) },
      positions: [], orders: [], fills: [], funding: [], marks: {}, lastBookTs: {},
      realizedPnl: '0', feesPaid: '0', fundingNet: '0', liquidations: 0, seq: 0,
    });
  }

  /** rebuild an account from `serialize()` output (or the parsed object); validates everything */
  static restore(snapshot: string | unknown): PaperAccount {
    return new PaperAccount(PaperStateSchema.parse(typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot));
  }

  serialize(): string { return JSON.stringify(this.state); }

  // ---------------------------------------------------------------- reads

  openOrders(): Order[] { return this.state.orders.filter(isOpen).map((o) => ({ ...o })); }
  order(clientId: string): Order | null { const o = this.state.orders.find((x) => x.clientId === clientId); return o ? { ...o } : null; }

  accountState(now: number): AccountState {
    const equity = this.equity(), used = this.marginUsed(), free = D.sub(equity, used);
    return {
      venue: this.state.venue, account: this.state.account, equity: D.str(equity), collateral: this.state.collateral,
      freeCollateral: D.str(free), marginUsed: D.str(used), maintenanceMargin: D.str(this.maintenance()),
      withdrawable: D.str(D.max(D.zero, D.min(free, D.from(this.state.collateral)))), ts: now, source: 'paper',
    };
  }

  /** positions in the normalised model; `liquidationPrice` is an ESTIMATE (cross, single-position approximation) */
  positions(): Position[] {
    const mmf = D.from(this.state.config.maintenanceMarginFraction);
    return this.state.positions.map((p) => {
      const size = D.from(p.size), entry = D.from(p.entryPrice), mark = D.from(p.markPrice), lev = this.leverage(p.instrument);
      let otherPnl = D.zero, otherMm = D.zero;
      for (const q of this.state.positions) {
        if (q === p) continue;
        otherPnl = D.add(otherPnl, unrealizedPnl(q.side, D.from(q.size), D.from(q.entryPrice), D.from(q.markPrice)));
        otherMm = D.add(otherMm, D.mul(D.mul(D.from(q.size), D.from(q.markPrice)), mmf));
      }
      const liq = liquidationPriceCross({ side: p.side, size, entryPrice: entry, accountCollateral: D.from(this.state.collateral), maintenanceFraction: mmf, otherUnrealizedPnl: otherPnl, otherMaintenanceMargin: otherMm }).value;
      return {
        instrument: p.instrument, side: p.side, size: p.size, entryPrice: p.entryPrice, markPrice: p.markPrice,
        liquidationPrice: liq === null ? null : D.str(liq), leverage: D.str(lev), marginMode: 'cross',
        margin: D.str(initialMargin(D.mul(size, mark), lev)), unrealizedPnl: D.str(unrealizedPnl(p.side, size, entry, mark)),
        realizedPnl: p.realizedPnl, fundingPaid: p.fundingPaid, source: 'paper',
      };
    });
  }

  // ---------------------------------------------------------------- commands

  /**
   * Submit an order against the current book and ticker. Idempotent by `clientId`: submitting a client id again returns the
   * existing order and does nothing. A refused order is recorded with status 'rejected' and its reason.
   */
  submit(req: OrderRequest, book: Book, ticker: Ticker, now: number): PaperResult {
    const r = OrderRequestSchema.parse(req), b = BookSchema.parse(book), t = TickerSchema.parse(ticker);
    const res = this.result();
    const existing = this.state.orders.find((o) => o.clientId === r.clientId);
    if (existing) { res.order = { ...existing }; return res; }

    this.state.seq += 1;
    const order: Order = { ...r, venueOrderId: `paper-o-${this.state.seq}`, status: 'pending', filled: '0', avgFillPrice: null, createdAt: now, updatedAt: now, rejectReason: null };
    this.state.orders.push(order);
    const reject = (reason: string): PaperResult => { this.close(order, 'rejected', reason, now, res); res.order = { ...order }; return res; };

    if (b.instrument !== r.instrument || t.instrument !== r.instrument) return reject('book or ticker is for another instrument');
    if (!D.isPos(D.from(r.size))) return reject('size must be positive');
    if (r.price === null) return reject('a price is required (limit price, or worst acceptable price of a market order)');
    if (!D.isPos(D.from(r.price))) return reject('price must be positive');
    if (!D.isPos(D.from(t.mark))) return reject('mark price must be positive');
    if (isTriggerType(r.type)) {
      if (r.triggerPrice === null || !D.isPos(D.from(r.triggerPrice))) return reject(`${r.type} needs a positive trigger price`);
    } else if (r.triggerPrice !== null) return reject(`${r.type} takes no trigger price`);
    if (r.type === 'market' && r.tif === 'alo') return reject('a market order cannot be post-only');

    this.setMark(r.instrument, D.from(t.mark));
    this.state.lastBookTs[r.instrument] = Math.max(this.state.lastBookTs[r.instrument] ?? 0, b.ts);

    if (isTriggerType(r.type)) {
      // waits for the mark to reach the trigger; it may fire on this very ticker and then executes on the next book
      this.checkTriggers(r.instrument, D.from(t.mark), now, res);
    } else {
      this.activate(order, this.levels(b), now, res, true);
    }
    this.liquidateIfNeeded(now, res);
    res.order = { ...order };
    return res;
  }

  /** cancel an open order by client id; a no-op (order returned unchanged) when it is already closed; null when unknown */
  cancel(clientId: string, now: number): PaperResult {
    const res = this.result();
    const order = this.state.orders.find((o) => o.clientId === clientId);
    if (!order) return res;
    if (isOpen(order)) this.close(order, 'cancelled', 'cancelled by the user', now, res);
    res.order = { ...order };
    return res;
  }

  /** a new book: executes triggered orders and fills resting orders it crosses. Books not newer than the last one seen are ignored. */
  onBook(book: Book, now: number): PaperResult {
    const b = BookSchema.parse(book);
    const res = this.result();
    if (b.ts <= (this.state.lastBookTs[b.instrument] ?? -1)) return res;
    this.state.lastBookTs[b.instrument] = b.ts;
    const levels = this.levels(b);
    for (const order of this.state.orders) {
      if (order.instrument !== b.instrument) continue;
      if (order.status === 'triggered') this.activate(order, levels, now, res, false);
      else if (order.status === 'open' || order.status === 'partially_filled') this.fillResting(order, levels, now, res);
    }
    this.liquidateIfNeeded(now, res);
    return res;
  }

  /** a new ticker: updates the mark, fires stop / take-profit triggers, checks liquidation */
  onTicker(ticker: Ticker, now: number): PaperResult {
    const t = TickerSchema.parse(ticker);
    const res = this.result();
    const mark = D.from(t.mark);
    if (!D.isPos(mark)) throw new RangeError('mark price must be positive');
    this.setMark(t.instrument, mark);
    this.checkTriggers(t.instrument, mark, now, res);
    this.liquidateIfNeeded(now, res);
    return res;
  }

  /**
   * Apply a funding rate (per funding interval) at `now`: to one instrument, or to every position when `instrument` is omitted
   * (only sensible for a single-instrument account, since rates are per instrument). Idempotent per (instrument, now).
   */
  applyFunding(rate: DecStr, now: number, instrument?: string): PaperResult {
    const res = this.result();
    const rt = D.from(rate);
    for (const p of this.state.positions) {
      if (instrument !== undefined && p.instrument !== instrument) continue;
      if (this.state.funding.some((f) => f.instrument === p.instrument && f.ts === now)) continue;
      const payment = D.mul(D.mul(D.from(p.size), D.from(p.markPrice)), rt);       // what a long pays
      const amount = p.side === 'long' ? D.neg(payment) : payment;                  // signed for the account: negative = paid
      this.state.collateral = D.str(D.add(D.from(this.state.collateral), amount));
      this.state.fundingNet = D.str(D.add(D.from(this.state.fundingNet), amount));
      p.fundingPaid = D.str(D.sub(D.from(p.fundingPaid), amount));
      const f: FundingPayment = { instrument: p.instrument, amount: D.str(amount), rate: D.str(rt), size: p.size, ts: now };
      this.state.funding.push(f); res.funding.push({ ...f });
    }
    this.liquidateIfNeeded(now, res);
    return res;
  }

  /**
   * Apply a fill to the account: position, realised PnL, fee, order progress. Idempotent by fill id — a fill already applied is
   * ignored and `false` is returned. `closedPnl` is recomputed from the account's own position.
   */
  applyFill(fill: Fill): boolean {
    const f = FillSchema.parse(fill);
    if (this.fillIds.has(f.id)) return false;
    const size = D.from(f.size), price = D.from(f.price), fee = D.from(f.fee);
    if (!D.isPos(size) || !D.isPos(price)) throw new RangeError('fill size and price must be positive');

    const idx = this.state.positions.findIndex((p) => p.instrument === f.instrument);
    const cur = idx < 0 ? null : this.state.positions[idx]!;
    const eff = applyOrderToPosition(cur ? { side: cur.side, size: D.from(cur.size), entryPrice: D.from(cur.entryPrice) } : null, { side: f.side, size, price });
    const mark = this.state.marks[f.instrument] ?? f.price;
    if (eff.position === null) { if (idx >= 0) this.state.positions.splice(idx, 1); }
    else {
      const flipped = eff.kind === 'flip';
      const next: PaperPosition = {
        instrument: f.instrument, side: eff.position.side, size: D.str(eff.position.size), entryPrice: D.str(eff.position.entryPrice), markPrice: mark,
        realizedPnl: D.str(D.add(cur && !flipped ? D.from(cur.realizedPnl) : D.zero, flipped ? D.zero : eff.realizedPnl)),
        fundingPaid: cur && !flipped ? cur.fundingPaid : '0',
      };
      if (idx >= 0) this.state.positions[idx] = next; else this.state.positions.push(next);
    }
    this.state.collateral = D.str(D.sub(D.add(D.from(this.state.collateral), eff.realizedPnl), fee));
    this.state.realizedPnl = D.str(D.add(D.from(this.state.realizedPnl), eff.realizedPnl));
    this.state.feesPaid = D.str(D.add(D.from(this.state.feesPaid), fee));

    const order = f.orderId === null ? undefined : this.state.orders.find((o) => o.venueOrderId === f.orderId);
    if (order) {
      const filled = D.from(order.filled), total = D.add(filled, size);
      const cost = D.add(D.mul(order.avgFillPrice === null ? D.zero : D.from(order.avgFillPrice), filled), D.mul(price, size));
      order.filled = D.str(total);
      order.avgFillPrice = D.str(D.div(cost, total, CALC_SCALE, 'half_even'));
      order.updatedAt = f.ts;
      if (D.gte(total, D.from(order.size))) order.status = 'filled';
      else if (order.status === 'open') order.status = 'partially_filled';
    }
    this.state.fills.push({ ...f, closedPnl: D.isZero(eff.closedSize) ? null : D.str(eff.realizedPnl) });
    this.fillIds.add(f.id);
    return true;
  }

  // ---------------------------------------------------------------- internals

  result(): PaperResult { return { order: null, fills: [], orders: [], funding: [], liquidated: false }; }

  leverage(instrument: string): Dec { return D.from(this.state.config.leverageByInstrument[instrument] ?? this.state.config.leverage); }

  equity(): Dec {
    return this.state.positions.reduce((acc, p) => D.add(acc, unrealizedPnl(p.side, D.from(p.size), D.from(p.entryPrice), D.from(p.markPrice))), D.from(this.state.collateral));
  }

  marginUsed(): Dec {
    return this.state.positions.reduce((acc, p) => D.add(acc, initialMargin(D.mul(D.from(p.size), D.from(p.markPrice)), this.leverage(p.instrument))), D.zero);
  }

  maintenance(): Dec {
    const mmf = D.from(this.state.config.maintenanceMarginFraction);
    return this.state.positions.reduce((acc, p) => D.add(acc, D.mul(D.mul(D.from(p.size), D.from(p.markPrice)), mmf)), D.zero);
  }

  signedPosition(instrument: string): Dec {
    const p = this.state.positions.find((x) => x.instrument === instrument);
    return p ? signedSize({ side: p.side, size: D.from(p.size) }) : D.zero;
  }

  setMark(instrument: string, mark: Dec): void {
    const s = D.str(mark);
    this.state.marks[instrument] = s;
    const p = this.state.positions.find((x) => x.instrument === instrument);
    if (p) p.markPrice = s;
  }

  /** mutable copy of a book: depth consumed by one order is not offered to the next one */
  levels(b: Book): { bids: Level[]; asks: Level[] } {
    const side = (ls: [DecStr, DecStr][]): Level[] => ls.map(([p, s]) => ({ price: D.from(p), size: D.from(s) })).filter((l) => D.isPos(l.price) && D.isPos(l.size));
    return { bids: side(b.bids), asks: side(b.asks) };
  }

  close(order: Order, status: 'cancelled' | 'rejected', reason: string, now: number, res: PaperResult): void {
    order.status = status; order.rejectReason = reason; order.updatedAt = now;
    this.touch(order, res);
  }

  touch(order: Order, res: PaperResult): void {
    const i = res.orders.findIndex((o) => o.venueOrderId === order.venueOrderId);
    if (i >= 0) res.orders[i] = { ...order }; else res.orders.push({ ...order });
  }

  /** null when the order may add `size` at `price`; otherwise the reason it may not */
  cannotAfford(order: Order, size: Dec, price: Dec, feeRate: Dec): string | null {
    const before = this.signedPosition(order.instrument);
    const after = order.side === 'buy' ? D.add(before, size) : D.sub(before, size);
    const added = D.sub(D.abs(after), D.abs(before));
    if (!D.isPos(added)) return null;                                  // reduces exposure: always allowed
    const fee = D.max(D.zero, D.mul(D.mul(size, price), feeRate));
    const need = D.add(initialMargin(D.mul(added, price), this.leverage(order.instrument)), fee);
    const free = D.sub(this.equity(), this.marginUsed());
    return D.lt(free, need) ? `insufficient collateral: needs ${D.str(need)}, free ${D.str(free)}` : null;
  }

  /** quantity a reduce-only order may still execute: its remainder clipped to the opposite position */
  reducible(order: Order, remaining: Dec): Dec {
    const pos = this.signedPosition(order.instrument);
    const opposite = order.side === 'buy' ? D.isNeg(pos) : D.isPos(pos);
    return opposite ? D.min(remaining, D.abs(pos)) : D.zero;
  }

  fill(order: Order, price: Dec, size: Dec, feeRate: Dec, now: number, res: PaperResult): void {
    this.state.seq += 1;
    const f: Fill = {
      instrument: order.instrument, orderId: order.venueOrderId, clientId: order.clientId, side: order.side, price: D.str(price), size: D.str(size),
      fee: D.str(D.mul(D.mul(price, size), feeRate)), feeAsset: this.state.config.feeAsset, closedPnl: null, ts: now, id: `paper-f-${this.state.seq}`, liquidation: false,
    };
    this.applyFill(f);
    res.fills.push({ ...this.state.fills[this.state.fills.length - 1]! });
  }

  /** a non-resting order becomes active: submitted limit/market order, or a triggered stop / take-profit */
  activate(order: Order, levels: { bids: Level[]; asks: Level[] }, now: number, res: PaperResult, atSubmit: boolean): void {
    const refuse = (reason: string): void => this.close(order, atSubmit ? 'rejected' : 'cancelled', reason, now, res);
    const limit = D.from(order.price!);
    const opp = order.side === 'buy' ? levels.asks : levels.bids;
    const crosses = (l: Level): boolean => (order.side === 'buy' ? D.lte(l.price, limit) : D.gte(l.price, limit));
    let remaining = D.sub(D.from(order.size), D.from(order.filled));

    if (order.reduceOnly) {
      const can = this.reducible(order, remaining);
      if (D.isZero(can)) return refuse('reduce-only: no position to reduce');
      if (D.lt(can, remaining)) {
        if (atSubmit) return refuse('reduce-only: order is larger than the position');
        remaining = can;                                               // a triggered order is clipped to what is left
      }
    }
    if (order.tif === 'alo') {
      if (opp.length > 0 && crosses(opp[0]!)) return refuse('post-only order would cross the book');
      const why = this.cannotAfford(order, remaining, limit, D.max(D.zero, D.from(this.state.config.makerFeeRate)));
      if (why) return refuse(why);
      order.status = 'open'; order.updatedAt = now; this.touch(order, res);
      return;
    }
    const taker = D.from(this.state.config.takerFeeRate);
    const why = this.cannotAfford(order, remaining, limit, taker);
    if (why) return refuse(why);

    for (const l of opp) {
      if (D.isZero(remaining) || !crosses(l)) break;
      if (D.isZero(l.size)) continue;
      const take = D.min(remaining, l.size);
      this.fill(order, l.price, take, taker, now, res);
      l.size = D.sub(l.size, take);
      remaining = D.sub(remaining, take);
    }
    order.updatedAt = now;
    if (D.gte(D.from(order.filled), D.from(order.size))) order.status = 'filled';
    else if (isMarketLike(order.type) || order.tif === 'ioc' || (order.reduceOnly && D.isZero(remaining))) {
      order.status = 'cancelled';
      order.rejectReason = order.reduceOnly && D.isZero(remaining) ? 'reduce-only: remainder cancelled, position closed' : 'unfilled remainder cancelled: no liquidity within the price bound';
    } else order.status = D.isZero(D.from(order.filled)) ? 'open' : 'partially_filled';
    this.touch(order, res);
  }

  /** a resting limit order against a newer book: filled at its own price for at most the crossing depth */
  fillResting(order: Order, levels: { bids: Level[]; asks: Level[] }, now: number, res: PaperResult): void {
    const limit = D.from(order.price!);
    const opp = order.side === 'buy' ? levels.asks : levels.bids;
    const crosses = (l: Level): boolean => (order.side === 'buy' ? D.lte(l.price, limit) : D.gte(l.price, limit));
    let remaining = D.sub(D.from(order.size), D.from(order.filled));
    if (order.reduceOnly) {
      remaining = this.reducible(order, remaining);
      if (D.isZero(remaining)) return this.close(order, 'cancelled', 'reduce-only: no position left to reduce', now, res);
    }
    let depth = D.zero;
    for (const l of opp) { if (!crosses(l)) break; depth = D.add(depth, l.size); }
    let take = D.min(remaining, depth);
    if (D.isZero(take)) return;
    const maker = D.from(this.state.config.makerFeeRate);
    const why = this.cannotAfford(order, take, limit, maker);
    if (why) return this.close(order, 'cancelled', why, now, res);
    const size = take;
    for (const l of opp) {                                             // consume the depth this fill used
      if (D.isZero(take) || !crosses(l)) break;
      const used = D.min(take, l.size);
      l.size = D.sub(l.size, used); take = D.sub(take, used);
    }
    this.fill(order, limit, size, maker, now, res);
    if (order.status !== 'filled') {
      order.status = 'partially_filled';
      if (order.reduceOnly && D.isZero(this.reducible(order, D.sub(D.from(order.size), D.from(order.filled))))) {
        order.status = 'cancelled'; order.rejectReason = 'reduce-only: remainder cancelled, position closed';
      }
    }
    order.updatedAt = now;
    this.touch(order, res);
  }

  /** stop: buy fires when mark ≥ trigger, sell when mark ≤ trigger. take-profit: sell fires when mark ≥ trigger, buy when mark ≤ trigger. */
  checkTriggers(instrument: string, mark: Dec, now: number, res: PaperResult): void {
    for (const order of this.state.orders) {
      if (order.status !== 'pending' || order.instrument !== instrument || !isTriggerType(order.type) || order.triggerPrice === null) continue;
      const trig = D.from(order.triggerPrice);
      const stop = order.type === 'stop_market' || order.type === 'stop_limit';
      const up = stop ? order.side === 'buy' : order.side === 'sell';
      if (up ? D.gte(mark, trig) : D.lte(mark, trig)) { order.status = 'triggered'; order.updatedAt = now; this.touch(order, res); }
    }
  }

  /** simulated liquidation of the whole (cross) account when equity < maintenance margin */
  liquidateIfNeeded(now: number, res: PaperResult): void {
    if (this.state.positions.length === 0 || D.gte(this.equity(), this.maintenance())) return;
    for (const o of this.state.orders) if (isOpen(o)) this.close(o, 'cancelled', 'account liquidated (simulated)', now, res);
    const rate = D.from(this.state.config.liquidationFeeRate);
    for (const p of [...this.state.positions]) {
      this.state.seq += 1;
      const price = D.from(p.markPrice), size = D.from(p.size);
      const f: Fill = {
        instrument: p.instrument, orderId: null, clientId: null, side: p.side === 'long' ? 'sell' : 'buy', price: p.markPrice, size: p.size,
        fee: D.str(D.mul(D.mul(price, size), rate)), feeAsset: this.state.config.feeAsset, closedPnl: null, ts: now, id: `paper-liq-${this.state.seq}`, liquidation: true,
      };
      this.applyFill(f);
      res.fills.push({ ...this.state.fills[this.state.fills.length - 1]! });
    }
    this.state.liquidations += 1;
    res.liquidated = true;
  }
}

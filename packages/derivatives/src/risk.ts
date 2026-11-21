/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/risk.ts
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
 * Risk policy engine (docs/v4/DERIVATIVES-ARCHITECTURE.md, "Risk policy engine"). Deterministic and pure: no clock, no network,
 * no state. `checkOrder` answers one question — may this order be sent under this policy, given this context? — and names the
 * first rule that says no. Circuit breakers (`policy.halt`) are inputs, never side effects.
 *
 * Order of the checks (each has a stable code):
 *   0  inputs well formed                              bad_policy · bad_order · bad_input
 *   1  mode allows trading; circuit breaker            mode_read_only · halted (the halt and the order-rate limits do not block a reduce-only order that reduces)
 *   2  instrument allowed and active                   instrument_mismatch · instrument_not_allowed · instrument_halted
 *   3  data age (ticker.ts, book.ts ≤ maxDataAgeMs)    data_mismatch · stale_ticker · stale_book
 *   4  price sanity                                    price_required · trigger_required · bad_mark · price_deviation · mark_index_divergence
 *   5  tick / lot / minimum size                       price_not_on_tick · size_not_on_lot · below_min_size · below_min_notional
 *   5b reduce-only really reduces                      reduce_only_would_increase · reduce_only_would_flip · instrument_reduce_only
 *   --- a reduce-only order that reduces skips 6–13 (closing must always be possible) ---
 *   6  leverage after the order ≤ maxLeverage          leverage_exceeded
 *   7  notional of the order ≤ maxOrderNotional        order_notional_exceeded
 *   8  resulting gross exposure ≤ maxGrossExposure     gross_exposure_exceeded
 *   9  resulting position ≤ maxPositionNotional        position_notional_exceeded
 *   10 free collateral after initial margin            insufficient_collateral
 *   11 estimated liquidation distance                  liquidation_too_close
 *   12 daily loss                                      daily_loss_exceeded
 *   13 total loss                                      total_loss_exceeded
 *   14 order rate                                      order_rate_minute · order_rate_day
 *   15 duplicate clientId                              duplicate_client_id
 *
 * Valuation rules (all exact, comparisons are done by cross-multiplication, never by a rounded division):
 *  - positions are valued at their mark (`ticker.mark` for the order's instrument, `position.markPrice` for the others);
 *  - the ORDER is valued at the highest of the mark, its price and its trigger price (cautious upper bound of its notional);
 *  - resting open orders are NOT counted in exposure (only positions and the order under review are);
 *  - fees and funding accrual are ignored.
 */
import { z } from 'zod';
import { D, type Dec, type DecStr } from './decimal.ts';
import { initialMargin, liquidationPriceCross, liquidationPriceIsolated, signedSize } from './margin.ts';
import { DecStrSchema, OrderRequestSchema, type AccountState, type Book, type Instrument, type Order, type OrderRequest, type Position, type Ticker } from './models.ts';

export const ACCOUNT_MODES = ['READ_ONLY', 'PAPER', 'MANUAL_LIVE', 'MANDATE_LIVE'] as const;
export const AccountModeSchema = z.enum(ACCOUNT_MODES);
export type AccountMode = z.infer<typeof AccountModeSchema>;

const NonNegDec = DecStrSchema.refine((x) => !x.startsWith('-'), 'must not be negative');
const PosDec = NonNegDec.refine((x) => /[1-9]/.test(x), 'must be positive');

export const RiskPolicySchema = z.object({
  mode: AccountModeSchema,
  /** instrument ids (`${venue}:${symbol}`) the account may trade; an instrument that is not listed is refused */
  allowedInstruments: z.array(z.string().min(1)),
  /** circuit breaker: a non-null reason refuses every order */
  halt: z.string().nullable(),
  maxDataAgeMs: z.number().int().nonnegative(),
  /** limit / worst price vs mark (vs trigger price for trigger orders), in basis points */
  maxDeviationBps: NonNegDec,
  /** mark vs index, in basis points (skipped when the venue publishes no index) */
  maxMarkIndexBps: NonNegDec,
  /** account leverage after the order: gross exposure / equity */
  maxLeverage: PosDec,
  maxOrderNotional: NonNegDec,
  maxGrossExposure: NonNegDec,
  maxPositionNotional: NonNegDec,
  minFreeCollateral: NonNegDec,
  minLiquidationDistanceBps: NonNegDec,
  /** positive amounts: an order is refused once the loss reaches them */
  maxDailyLoss: NonNegDec,
  maxTotalLoss: NonNegDec,
  maxOrdersPerMinute: z.number().int().nonnegative(),
  maxOrdersPerDay: z.number().int().nonnegative(),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export interface RiskUsage {
  /** PnL realised since the start of the day (negative = loss), fees and funding included by the caller */
  realizedToday: DecStr;
  /** PnL realised since the account was opened (negative = loss) */
  realizedTotal: DecStr;
  /** orders already sent in the last minute / today, NOT counting the one under review */
  ordersLastMinute: number;
  ordersToday: number;
  /** client ids already used on this account (open orders are checked as well) */
  clientIds?: readonly string[];
}

export interface RiskContext {
  instrument: Instrument;
  account: AccountState;
  positions: readonly Position[];
  openOrders: readonly Order[];
  book: Book;
  ticker: Ticker;
  /** the caller's clock, ms */
  now: number;
  usage: RiskUsage;
  /** leverage setting of this instrument on the venue; default: the existing position's, else min(instrument.maxLeverage, policy.maxLeverage) */
  leverage?: DecStr;
  /** maintenance margin fraction of this instrument; default: 1 / (2 · instrument.maxLeverage) */
  maintenanceMarginFraction?: DecStr;
}

export const RISK_CODES = [
  'bad_policy', 'bad_order', 'bad_input',
  'mode_read_only', 'halted',
  'instrument_mismatch', 'instrument_not_allowed', 'instrument_halted', 'instrument_reduce_only',
  'data_mismatch', 'stale_ticker', 'stale_book',
  'price_required', 'trigger_required', 'bad_mark', 'price_deviation', 'mark_index_divergence',
  'price_not_on_tick', 'size_not_on_lot', 'below_min_size', 'below_min_notional',
  'reduce_only_would_increase', 'reduce_only_would_flip',
  'leverage_exceeded', 'order_notional_exceeded', 'gross_exposure_exceeded', 'position_notional_exceeded',
  'insufficient_collateral', 'liquidation_too_close',
  'daily_loss_exceeded', 'total_loss_exceeded',
  'order_rate_minute', 'order_rate_day', 'duplicate_client_id',
] as const;
export type RiskCode = (typeof RISK_CODES)[number];
export type RiskResult = { ok: true } | { ok: false; code: RiskCode; reason: string };

const BPS = D.from(10000n);
const TWO = D.from(2n);
const no = (code: RiskCode, reason: string): RiskResult => ({ ok: false, code, reason });
const isTrigger = (t: OrderRequest['type']): boolean => t !== 'limit' && t !== 'market';

/** |a − ref| / ref > bps / 10000, without dividing: |a − ref| · 10000 > bps · ref (ref > 0) */
function deviates(a: Dec, ref: Dec, bps: Dec): boolean {
  return D.gt(D.mul(D.abs(D.sub(a, ref)), BPS), D.mul(bps, ref));
}

export function checkOrder(policy: RiskPolicy, req: OrderRequest, ctx: RiskContext): RiskResult {
  const p = RiskPolicySchema.safeParse(policy);
  if (!p.success) return no('bad_policy', `invalid risk policy: ${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim());
  const r = OrderRequestSchema.safeParse(req);
  if (!r.success) return no('bad_order', `invalid order: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? ''}`.trim());
  try {
    return run(p.data, r.data, ctx);
  } catch (e) {
    // fail closed: a context the engine cannot read is a refusal, never an acceptance
    return no('bad_input', `risk context could not be evaluated: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function run(policy: RiskPolicy, req: OrderRequest, ctx: RiskContext): RiskResult {
  const { instrument, ticker, book, account, usage } = ctx;

  // 1 — mode and circuit breaker
  if (policy.mode === 'READ_ONLY') return no('mode_read_only', 'the account is read-only: no order may be sent');
  if (policy.halt !== null && !req.reduceOnly) return no('halted', `trading is halted: ${policy.halt}`);

  // 2 — instrument
  if (req.instrument !== instrument.id) return no('instrument_mismatch', `order is for ${req.instrument}, context is for ${instrument.id}`);
  if (!policy.allowedInstruments.includes(instrument.id)) return no('instrument_not_allowed', `${instrument.id} is not in the allowed instruments`);
  if (instrument.status === 'halted') return no('instrument_halted', `${instrument.id} is halted on the venue`);

  // 3 — data age
  if (ticker.instrument !== instrument.id || book.instrument !== instrument.id) return no('data_mismatch', 'ticker or book is for another instrument');
  if (!Number.isFinite(ctx.now)) return no('bad_input', 'now is not a finite timestamp');
  if (!Number.isFinite(ticker.ts) || Math.abs(ctx.now - ticker.ts) > policy.maxDataAgeMs) return no('stale_ticker', `ticker is ${ctx.now - ticker.ts} ms old (limit ${policy.maxDataAgeMs})`);
  if (!Number.isFinite(book.ts) || Math.abs(ctx.now - book.ts) > policy.maxDataAgeMs) return no('stale_book', `book is ${ctx.now - book.ts} ms old (limit ${policy.maxDataAgeMs})`);

  // 4 — price sanity
  const size = D.from(req.size);
  if (!D.isPos(size)) return no('bad_order', 'size must be positive');
  if (req.price === null) return no('price_required', 'a price is required: limit price, or worst acceptable price for market orders');
  const price = D.from(req.price);
  if (!D.isPos(price)) return no('bad_order', 'price must be positive');
  const trigger = req.triggerPrice === null ? null : D.from(req.triggerPrice);
  if (isTrigger(req.type)) {
    if (trigger === null) return no('trigger_required', `${req.type} needs a trigger price`);
    if (!D.isPos(trigger)) return no('bad_order', 'trigger price must be positive');
  } else if (trigger !== null) return no('bad_order', `${req.type} takes no trigger price`);
  const mark = D.from(ticker.mark);
  if (!D.isPos(mark)) return no('bad_mark', 'mark price is not positive');
  const maxDev = D.from(policy.maxDeviationBps);
  // a trigger order executes around its trigger price, so its limit/worst price is compared with the trigger, not with the mark
  const ref = trigger ?? mark;
  if (deviates(price, ref, maxDev)) return no('price_deviation', `price ${req.price} is more than ${policy.maxDeviationBps} bps away from ${trigger ? 'the trigger price' : 'the mark'} ${D.str(ref)}`);
  if (ticker.index !== null) {
    const index = D.from(ticker.index);
    if (!D.isPos(index)) return no('bad_mark', 'index price is not positive');
    if (deviates(mark, index, D.from(policy.maxMarkIndexBps))) return no('mark_index_divergence', `mark ${ticker.mark} is more than ${policy.maxMarkIndexBps} bps away from the index ${ticker.index}`);
  }

  // position on this instrument, and what the order does to it
  const pos = ctx.positions.find((x) => x.instrument === instrument.id) ?? null;
  const before = pos ? signedSize({ side: pos.side, size: D.from(pos.size) }) : D.zero;
  const after = req.side === 'buy' ? D.add(before, size) : D.sub(before, size);
  const opposite = !D.isZero(before) && (D.isPos(before) ? req.side === 'sell' : req.side === 'buy');
  const reduces = opposite && D.lte(size, D.abs(before));     // strictly inside the position, or closes it
  const closesAll = opposite && D.eq(size, D.abs(before));

  // 5 — tick, lot, minimum size
  const tick = D.from(instrument.tickSize), lot = D.from(instrument.lotSize);
  if (!D.isMultiple(price, tick)) return no('price_not_on_tick', `price ${req.price} is not a multiple of the tick ${instrument.tickSize}`);
  if (trigger !== null && !D.isMultiple(trigger, tick)) return no('price_not_on_tick', `trigger price ${req.triggerPrice} is not a multiple of the tick ${instrument.tickSize}`);
  if (!D.isMultiple(size, lot)) return no('size_not_on_lot', `size ${req.size} is not a multiple of the lot ${instrument.lotSize}`);
  // the order is valued at the highest of mark, price and trigger: an upper bound of what it can cost
  const valuePrice = D.max(D.max(mark, price), trigger ?? mark);
  const orderNotional = D.mul(size, valuePrice);
  // a reduce-only order that closes the whole position may be smaller than the minimums (dust must stay closable)
  if (!(req.reduceOnly && closesAll)) {
    if (instrument.minOrderSize !== null && D.lt(size, D.from(instrument.minOrderSize))) return no('below_min_size', `size ${req.size} is below the minimum ${instrument.minOrderSize}`);
    if (instrument.minNotional !== null && D.lt(D.mul(size, price), D.from(instrument.minNotional))) return no('below_min_notional', `notional ${D.str(D.mul(size, price))} is below the minimum ${instrument.minNotional}`);
  }

  // 5b — reduce-only must really reduce
  if (req.reduceOnly && !reduces) {
    if (!opposite) return no('reduce_only_would_increase', 'reduce-only order would open or increase the position');
    return no('reduce_only_would_flip', `reduce-only order of ${req.size} is larger than the position ${pos!.size}: it would flip it`);
  }
  if (instrument.status === 'reduce_only' && !reduces) return no('instrument_reduce_only', `${instrument.id} only accepts orders that reduce a position`);
  const exempt = req.reduceOnly && reduces;
  // a halt stops new risk, not the way out: closing a position stays possible (the brief separates the two)
  if (policy.halt !== null && !exempt) return no('halted', `trading is halted: ${policy.halt}`);

  if (!exempt) {
    const equity = D.from(account.equity);
    const afterNotional = D.mul(D.abs(after), mark);
    let gross = afterNotional;
    for (const x of ctx.positions) if (x.instrument !== instrument.id) gross = D.add(gross, D.mul(D.abs(D.from(x.size)), D.from(x.markPrice)));

    // 6 — leverage after the order: gross / equity ≤ maxLeverage  ⇔  gross ≤ maxLeverage · equity (equity ≤ 0 refuses any exposure)
    if (D.gt(gross, D.mul(D.from(policy.maxLeverage), equity)) && D.isPos(gross)) return no('leverage_exceeded', `gross exposure ${D.str(gross)} on equity ${account.equity} exceeds ${policy.maxLeverage}x`);
    // 7 — notional of the order
    if (D.gt(orderNotional, D.from(policy.maxOrderNotional))) return no('order_notional_exceeded', `order notional ${D.str(orderNotional)} exceeds ${policy.maxOrderNotional}`);
    // 8 — gross exposure
    if (D.gt(gross, D.from(policy.maxGrossExposure))) return no('gross_exposure_exceeded', `resulting gross exposure ${D.str(gross)} exceeds ${policy.maxGrossExposure}`);
    // 9 — position per instrument
    if (D.gt(afterNotional, D.from(policy.maxPositionNotional))) return no('position_notional_exceeded', `resulting position ${D.str(afterNotional)} on ${instrument.id} exceeds ${policy.maxPositionNotional}`);

    // 10 — free collateral after the initial margin of the added size (valued at the order's value price)
    const instMaxLev = D.from(instrument.maxLeverage);
    const lev = ctx.leverage !== undefined ? D.from(ctx.leverage) : pos ? D.from(pos.leverage) : D.min(instMaxLev, D.from(policy.maxLeverage));
    if (!D.isPos(lev) || !D.isPos(instMaxLev)) return no('bad_input', 'leverage must be positive');
    const added = D.sub(D.abs(after), D.abs(before));
    const addedMargin = D.isPos(added) ? initialMargin(D.mul(added, valuePrice), lev) : D.zero;
    const freeAfter = D.sub(D.from(account.freeCollateral), addedMargin);
    if (D.lt(freeAfter, D.from(policy.minFreeCollateral))) return no('insufficient_collateral', `free collateral after initial margin would be ${D.str(freeAfter)}, below ${policy.minFreeCollateral}`);

    // 11 — estimated liquidation distance of the resulting position, taken as if entered at the mark
    if (!D.isZero(after)) {
      const side = D.isPos(after) ? 'long' as const : 'short' as const;
      const mmf = ctx.maintenanceMarginFraction !== undefined ? D.from(ctx.maintenanceMarginFraction) : D.div(D.one, D.mul(TWO, instMaxLev), 18, 'up');
      const absAfter = D.abs(after);
      let liq: Dec | null;
      if (pos && pos.marginMode === 'isolated') {
        // isolated: same direction → the position's margin (with its PnL at mark) scaled to the new size, plus the added margin;
        // flipped → a fresh position at its initial margin
        const sameDirection = D.sign(after) === D.sign(before);
        const kept = D.min(absAfter, D.abs(before));
        const carried = sameDirection ? D.div(D.mul(D.add(D.from(pos.margin), D.from(pos.unrealizedPnl)), kept), D.abs(before), 18, 'down') : D.zero;
        const margin = sameDirection ? D.add(carried, addedMargin) : initialMargin(afterNotional, lev);
        liq = liquidationPriceIsolated({ side, size: absAfter, entryPrice: mark, margin, maintenanceFraction: mmf }).value;
      } else {
        // cross, single-position approximation: the whole equity backs this position, other positions frozen
        liq = liquidationPriceCross({ side, size: absAfter, entryPrice: mark, accountCollateral: equity, maintenanceFraction: mmf }).value;
      }
      if (liq !== null) {
        const wrongSide = side === 'long' ? D.gte(liq, mark) : D.lte(liq, mark);
        // distance = |mark − liq| / mark ≥ min/10000  ⇔  |mark − liq| · 10000 ≥ min · mark
        if (wrongSide || D.lt(D.mul(D.abs(D.sub(mark, liq)), BPS), D.mul(D.from(policy.minLiquidationDistanceBps), mark))) {
          return no('liquidation_too_close', `estimated liquidation price ${D.str(liq)} is closer than ${policy.minLiquidationDistanceBps} bps to the mark ${ticker.mark}`);
        }
      }
    }

    // 12, 13 — losses: realised + unrealised must stay above −max
    const unrealized = ctx.positions.reduce((acc, x) => D.add(acc, D.from(x.unrealizedPnl)), D.zero);
    const daily = D.add(D.from(usage.realizedToday), unrealized);
    if (D.lte(daily, D.neg(D.from(policy.maxDailyLoss)))) return no('daily_loss_exceeded', `daily PnL ${D.str(daily)} has reached the limit −${policy.maxDailyLoss}`);
    const total = D.add(D.from(usage.realizedTotal), unrealized);
    if (D.lte(total, D.neg(D.from(policy.maxTotalLoss)))) return no('total_loss_exceeded', `total PnL ${D.str(total)} has reached the limit −${policy.maxTotalLoss}`);
  }

  // 14 — order rate (counts exclude this order)
  if (!Number.isInteger(usage.ordersLastMinute) || !Number.isInteger(usage.ordersToday)) return no('bad_input', 'order counters must be integers');
  if (!exempt && usage.ordersLastMinute >= policy.maxOrdersPerMinute) return no('order_rate_minute', `${usage.ordersLastMinute} orders in the last minute (limit ${policy.maxOrdersPerMinute})`);
  if (!exempt && usage.ordersToday >= policy.maxOrdersPerDay) return no('order_rate_day', `${usage.ordersToday} orders today (limit ${policy.maxOrdersPerDay})`);

  // 15 — duplicate clientId
  if (ctx.openOrders.some((o) => o.clientId === req.clientId) || (usage.clientIds ?? []).includes(req.clientId)) return no('duplicate_client_id', `client id ${req.clientId} was already used on this account`);

  return { ok: true };
}

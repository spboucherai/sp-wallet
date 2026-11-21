/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/margin.ts
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
 * Margin engine (sp-margin-engine). Pure functions on `Dec`; no clock, no network, no `number` in any value.
 *
 * Conventions
 *  - `size` is a positive quantity of the base asset; the direction is `side` ('long' | 'short').
 *  - Products are exact. Every division states its scale (CALC_SCALE decimals) and its rounding, chosen on the cautious side:
 *    required margin and leverage round up, a long's liquidation price rounds up and a short's rounds down (closer to the mark).
 *  - A result that is an approximation of what the venue would compute is returned as
 *    `{ value, source: 'estimate', method }`. The venue's own figures are the truth (principle 5); these are not.
 *  - Unless a function says otherwise it ignores funding accrual, fees, tiered (size-dependent) maintenance margin,
 *    venue-specific mark-price rules and auto-deleveraging.
 */
import { D, type Dec } from './decimal.ts';
import type { Side } from './models.ts';

/** decimals kept by the divisions of this module */
export const CALC_SCALE = 18;

export interface Estimate<T> { readonly value: T; readonly source: 'estimate'; readonly method: string }
function estimate<T>(value: T, method: string): Estimate<T> { return { value, source: 'estimate', method }; }

/** the minimum needed to describe a position for the computations below */
export interface PositionLite { side: Side; size: Dec; entryPrice: Dec }
/** a position valued at a mark price, with the asset its exposure is counted under */
export interface ExposureInput { asset: string; side: Side; size: Dec; markPrice: Dec }

function requirePositive(x: Dec, name: string): void { if (!D.isPos(x)) throw new RangeError(`${name} must be positive`); }
function requireNonNegative(x: Dec, name: string): void { if (D.isNeg(x)) throw new RangeError(`${name} must not be negative`); }

/** signed size of a position: positive when long, negative when short, zero when there is none */
export function signedSize(p: { side: Side; size: Dec } | null | undefined): Dec {
  if (!p) return D.zero;
  return p.side === 'long' ? D.abs(p.size) : D.neg(D.abs(p.size));
}

/** notional = |size| · price. Exact. */
export function notional(size: Dec, price: Dec): Dec { return D.mul(D.abs(size), price); }

/**
 * Initial margin for a notional at a leverage: IM = notional / leverage, rounded up at CALC_SCALE decimals.
 * Assumes a flat initial-margin fraction of 1/leverage (no size tiers).
 */
export function initialMargin(notionalValue: Dec, leverage: Dec): Dec {
  requireNonNegative(notionalValue, 'notional'); requirePositive(leverage, 'leverage');
  return D.div(notionalValue, leverage, CALC_SCALE, 'up');
}

/**
 * Maintenance margin = notional · maintenanceFraction. Exact.
 * Assumes one flat maintenance fraction for the whole position (venues with tiers apply a schedule by size).
 */
export function maintenanceMargin(notionalValue: Dec, maintenanceFraction: Dec): Dec {
  requireNonNegative(notionalValue, 'notional'); requireNonNegative(maintenanceFraction, 'maintenance fraction');
  return D.mul(notionalValue, maintenanceFraction);
}

/**
 * Unrealized PnL at a mark price: long = size · (mark − entry); short = size · (entry − mark). Exact.
 * Linear (USD-margined) contract; ignores funding accrued but not yet paid and the fee of closing.
 */
export function unrealizedPnl(side: Side, size: Dec, entryPrice: Dec, markPrice: Dec): Dec {
  const diff = side === 'long' ? D.sub(markPrice, entryPrice) : D.sub(entryPrice, markPrice);
  return D.mul(D.abs(size), diff);
}

/** gross exposure = Σ |size_i| · mark_i. Exact. */
export function grossExposure(positions: readonly { size: Dec; markPrice: Dec }[]): Dec {
  return positions.reduce((acc, p) => D.add(acc, notional(p.size, p.markPrice)), D.zero);
}

/** net exposure = Σ (long notionals) − Σ (short notionals). Exact; positive = net long. Sums across assets in the quote currency. */
export function netExposure(positions: readonly { side: Side; size: Dec; markPrice: Dec }[]): Dec {
  return positions.reduce((acc, p) => (p.side === 'long' ? D.add(acc, notional(p.size, p.markPrice)) : D.sub(acc, notional(p.size, p.markPrice))), D.zero);
}

export interface AssetExposure { long: Dec; short: Dec; net: Dec; gross: Dec }
/** per-asset exposure: for each asset, long and short notionals at mark, net = long − short, gross = long + short. Exact. */
export function exposureByAsset(positions: readonly ExposureInput[]): Record<string, AssetExposure> {
  const out: Record<string, AssetExposure> = Object.create(null) as Record<string, AssetExposure>;
  for (const p of positions) {
    const cur = out[p.asset] ?? { long: D.zero, short: D.zero, net: D.zero, gross: D.zero };
    const n = notional(p.size, p.markPrice);
    const long = p.side === 'long' ? D.add(cur.long, n) : cur.long;
    const short = p.side === 'short' ? D.add(cur.short, n) : cur.short;
    out[p.asset] = { long, short, net: D.sub(long, short), gross: D.add(long, short) };
  }
  return out;
}

/**
 * Effective leverage of an account = gross exposure / equity, rounded up at CALC_SCALE decimals.
 * `equity` is collateral + unrealized PnL at the same marks. Returns null when equity ≤ 0 (leverage is not defined:
 * the account is insolvent at these marks) — callers must treat null as "over any limit".
 */
export function effectiveLeverage(equity: Dec, positions: readonly { size: Dec; markPrice: Dec }[]): Dec | null {
  if (!D.isPos(equity)) return null;
  return D.div(grossExposure(positions), equity, CALC_SCALE, 'up');
}

export interface IsolatedLiquidationInput {
  side: Side; size: Dec; entryPrice: Dec;
  /** collateral attached to this position alone, excluding its unrealized PnL */
  margin: Dec;
  /** maintenance margin as a fraction of the notional at the liquidation price, e.g. 0.005 */
  maintenanceFraction: Dec;
  /** optional fee rate charged on the notional of the liquidating close; ignored (zero) when absent */
  feeRate?: Dec;
}

/**
 * Estimated liquidation price of an isolated position.
 *
 * Liquidation is where position equity equals the maintenance requirement, with k = maintenanceFraction + feeRate:
 *   long :  margin + size·(p − entry) = k·size·p   ⇒   p = (entry·size − margin) / (size·(1 − k))
 *   short:  margin + size·(entry − p) = k·size·p   ⇒   p = (entry·size + margin) / (size·(1 + k))
 * Rounded towards the entry side that is reached first (long: up, short: down), CALC_SCALE decimals.
 *
 * Assumptions: linear contract; flat maintenance fraction applied to the notional at the liquidation price; no funding accrual;
 * no fee unless `feeRate` is given; margin is not topped up or withdrawn; liquidation happens exactly at the threshold on the
 * mark price. `value` is null when no positive price liquidates the position (a long whose margin covers the whole notional).
 * A long value ≥ entry (short ≤ entry) means the position is already at or past its threshold.
 */
export function liquidationPriceIsolated(i: IsolatedLiquidationInput): Estimate<Dec | null> {
  requirePositive(i.size, 'size'); requirePositive(i.entryPrice, 'entry price'); requireNonNegative(i.maintenanceFraction, 'maintenance fraction');
  if (i.feeRate) requireNonNegative(i.feeRate, 'fee rate');
  const k = D.add(i.maintenanceFraction, i.feeRate ?? D.zero);
  const method = `isolated, ${i.side}: equity = maintenance at p; flat maintenance fraction${i.feeRate ? ' + closing fee' : ', no fees'}; no funding accrual`;
  const entryNotional = D.mul(i.entryPrice, i.size);
  if (i.side === 'long') {
    const den = D.mul(i.size, D.sub(D.one, k));
    if (!D.isPos(den)) throw new RangeError('maintenance fraction + fee rate must be below 1');
    const num = D.sub(entryNotional, i.margin);
    if (!D.isPos(num)) return estimate(null, `${method}; margin covers the whole notional: no liquidation price`);
    return estimate(D.div(num, den, CALC_SCALE, 'up'), method);
  }
  const num = D.add(entryNotional, i.margin);
  if (!D.isPos(num)) return estimate(D.zero, `${method}; margin deficit exceeds the notional`);
  return estimate(D.div(num, D.mul(i.size, D.add(D.one, k)), CALC_SCALE, 'down'), method);
}

/**
 * Estimated liquidation price of an isolated position opened at `leverage` with exactly its initial margin:
 * margin = entry·size / leverage (rounded up), then the isolated formula. For a long this is
 * p = entry · (1 − 1/leverage) / (1 − k): below the entry when k < 1/leverage, and rising with leverage. Same assumptions.
 */
export function liquidationPriceAtLeverage(i: { side: Side; entryPrice: Dec; leverage: Dec; maintenanceFraction: Dec; feeRate?: Dec }): Estimate<Dec | null> {
  const margin = initialMargin(i.entryPrice, i.leverage);         // per unit of size
  const r = liquidationPriceIsolated({ side: i.side, size: D.one, entryPrice: i.entryPrice, margin, maintenanceFraction: i.maintenanceFraction, ...(i.feeRate ? { feeRate: i.feeRate } : {}) });
  return estimate(r.value, `${r.method}; margin = entry notional / leverage`);
}

export interface CrossLiquidationInput {
  side: Side; size: Dec; entryPrice: Dec;
  /** account collateral (cash balance), excluding the unrealized PnL of every position */
  accountCollateral: Dec;
  maintenanceFraction: Dec;
  /** unrealized PnL of the OTHER positions, held constant (default 0) */
  otherUnrealizedPnl?: Dec;
  /** maintenance margin of the OTHER positions, held constant (default 0) */
  otherMaintenanceMargin?: Dec;
  feeRate?: Dec;
}

/**
 * Estimated liquidation price of a cross-margin position — SINGLE-POSITION APPROXIMATION.
 *
 * The whole account backs the position: the isolated formula with
 *   margin = accountCollateral + otherUnrealizedPnl − otherMaintenanceMargin.
 * It is exact only if this is the account's only position. With several positions the other positions' PnL and maintenance
 * are frozen at their current values, which is wrong as soon as their prices move (correlated assets move together), so the
 * true liquidation price can be materially closer. Other assumptions as `liquidationPriceIsolated`.
 */
export function liquidationPriceCross(i: CrossLiquidationInput): Estimate<Dec | null> {
  const margin = D.sub(D.add(i.accountCollateral, i.otherUnrealizedPnl ?? D.zero), i.otherMaintenanceMargin ?? D.zero);
  const r = liquidationPriceIsolated({ side: i.side, size: i.size, entryPrice: i.entryPrice, margin, maintenanceFraction: i.maintenanceFraction, ...(i.feeRate ? { feeRate: i.feeRate } : {}) });
  return estimate(r.value, `cross, single-position approximation (other positions frozen); ${r.method}`);
}

export type PositionEffectKind = 'open' | 'increase' | 'reduce' | 'close' | 'flip';
export interface PositionEffect {
  kind: PositionEffectKind;
  /** resulting position, null when flat */
  position: PositionLite | null;
  /** PnL realised by the closed part (zero when nothing is closed); fees are not included */
  realizedPnl: Dec;
  /** quantity of the previous position that was closed */
  closedSize: Dec;
  /** quantity that opens or adds exposure in the direction of the order */
  openedSize: Dec;
}

/**
 * Effect of an execution (side, size, price) on a position.
 *  - open / increase: new entry = (oldSize·oldEntry + size·price) / (oldSize + size), half-even at CALC_SCALE decimals
 *    (the only rounding here; opening a position from flat has entry = price exactly).
 *  - reduce / close: the entry price is unchanged; realised PnL = closedSize · (price − entry) for a long,
 *    closedSize · (entry − price) for a short. Exact.
 *  - flip: the whole previous position is closed at `price` (realised as above) and the remainder opens the opposite side
 *    with entry = price.
 * Fees and funding are not part of the result; the caller accounts for them.
 */
export function applyOrderToPosition(position: PositionLite | null, exec: { side: 'buy' | 'sell'; size: Dec; price: Dec }): PositionEffect {
  requirePositive(exec.size, 'execution size'); requirePositive(exec.price, 'execution price');
  const dir: Side = exec.side === 'buy' ? 'long' : 'short';
  if (!position || D.isZero(position.size)) {
    return { kind: 'open', position: { side: dir, size: exec.size, entryPrice: exec.price }, realizedPnl: D.zero, closedSize: D.zero, openedSize: exec.size };
  }
  requirePositive(position.size, 'position size');
  if (position.side === dir) {
    const size = D.add(position.size, exec.size);
    const cost = D.add(D.mul(position.size, position.entryPrice), D.mul(exec.size, exec.price));
    return { kind: 'increase', position: { side: dir, size, entryPrice: D.div(cost, size, CALC_SCALE, 'half_even') }, realizedPnl: D.zero, closedSize: D.zero, openedSize: exec.size };
  }
  const closedSize = D.min(position.size, exec.size);
  const realizedPnl = unrealizedPnl(position.side, closedSize, position.entryPrice, exec.price);
  const c = D.cmp(exec.size, position.size);
  if (c < 0) return { kind: 'reduce', position: { side: position.side, size: D.sub(position.size, exec.size), entryPrice: position.entryPrice }, realizedPnl, closedSize, openedSize: D.zero };
  if (c === 0) return { kind: 'close', position: null, realizedPnl, closedSize, openedSize: D.zero };
  const openedSize = D.sub(exec.size, position.size);
  return { kind: 'flip', position: { side: dir, size: openedSize, entryPrice: exec.price }, realizedPnl, closedSize, openedSize };
}

export interface HypotheticalOrder {
  /** account equity (collateral + unrealized PnL) and margin already used, both at current marks */
  equity: Dec; marginUsed: Dec;
  side: 'buy' | 'sell'; size: Dec;
  /** price the order is valued at (limit price, or the worst acceptable price of a market order) */
  price: Dec;
  leverage: Dec;
  /** current position on the same instrument, if any */
  position?: PositionLite | null;
  /** optional fee rate on the order's notional; ignored (zero) when absent */
  feeRate?: Dec;
}

/**
 * Estimated free collateral after a hypothetical order:
 *   free = equity − marginUsed − IM(addedSize · price, leverage) − size · price · feeRate
 * where addedSize = max(0, |position after| − |position before|): only the part that increases the absolute position needs new
 * initial margin; a reducing order needs none.
 *
 * Assumptions: the order fills entirely at `price`; margin released by the reduced part is NOT credited (cautious);
 * the realised PnL of a closed part is not added (it is already inside `equity` as unrealized PnL when equity is at mark);
 * flat initial margin 1/leverage; resting orders reserve nothing; no funding; fee only if `feeRate` is given.
 */
export function freeCollateralAfterOrder(o: HypotheticalOrder): Estimate<Dec> {
  requirePositive(o.size, 'order size'); requirePositive(o.price, 'order price'); requirePositive(o.leverage, 'leverage');
  const before = signedSize(o.position ?? null);
  const after = o.side === 'buy' ? D.add(before, o.size) : D.sub(before, o.size);
  const added = D.sub(D.abs(after), D.abs(before));
  const margin = D.isPos(added) ? initialMargin(D.mul(added, o.price), o.leverage) : D.zero;
  const fee = o.feeRate ? D.mul(D.mul(o.size, o.price), o.feeRate) : D.zero;
  const free = D.sub(D.sub(D.sub(o.equity, o.marginUsed), margin), fee);
  return estimate(free, `equity − margin used − initial margin of the added size at the order price${o.feeRate ? ' − fee' : ', no fees'}; full fill assumed; released margin not credited`);
}

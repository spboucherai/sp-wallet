/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/simple.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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
 * The simple order form of a venue account — its pure rules (no React; tested in apps/web/test/derivatives-simple.test.ts).
 * Every figure the form shows comes from the API, or from one of the rules below; each rule is written where it is applied.
 *
 *  - amount in USD → size: `usdToSize` (dec.ts): amount ÷ the venue's mark price, rounded DOWN to the lot. The size is what is
 *    sent; the server's preview then says what that size is worth, and the approval sheet shows the order that is signed;
 *  - quick amounts: round figures between the venue's minimum and the owner's limits, then « Max »;
 *  - liquidation estimate: Hyperliquid's published rule, for a position that would be alone on the account — otherwise none.
 */
import { liquidationPriceAtLeverage, liquidationPriceCross } from '../../../../packages/derivatives/src/margin.ts';
import { D, dec, type Dec, type DecStr } from './dec';

const cents = (x: Dec): Dec => D.quantize(x, D.from('0.01'), 'down');

/**
 * The most the form proposes for one order, in USD: 99 % of the smaller of (a) the per-order limit and (b) what the free
 * collateral covers at the venue's present leverage (free collateral × leverage) — 1 % is left for the price moving between
 * the tap and the order. (b) is skipped while the leverage or the collateral is not known. Null when nothing is known.
 */
export function maxUsd(i: { orderLimit: DecStr | null | undefined; freeCollateral: DecStr | null | undefined; leverage: DecStr | null | undefined }): Dec | null {
  const limit = dec(i.orderLimit), free = dec(i.freeCollateral), lev = dec(i.leverage);
  const byMargin = free && lev && D.isPos(lev) && !D.isNeg(free) ? D.mul(free, lev) : null;
  const cap = limit && D.isPos(limit) ? (byMargin ? D.min(limit, byMargin) : limit) : byMargin;
  if (!cap || !D.isPos(cap)) return null;
  return cents(D.mul(cap, D.from('0.99')));
}

const STEPS = ['10', '25', '50', '100', '250', '500', '1000', '2500', '5000', '10000'];
/**
 * Quick amounts: the three largest round figures that are at least the venue's minimum order and strictly below « Max », then
 * « Max » itself (when it is at least the minimum).
 */
export function usdChips(max: Dec | null, minNotional: DecStr | null | undefined): { usd: DecStr; max: boolean }[] {
  if (!max) return [];
  const min = dec(minNotional) ?? D.zero;
  const steps = STEPS.filter((s) => D.gte(D.from(s), min) && D.lt(D.from(s), max)).slice(-3).map((usd) => ({ usd, max: false }));
  return D.gte(max, min) && D.isPos(max) ? [...steps, { usd: D.str(max), max: true }] : steps;
}

/** has the price moved more than `bps` since the size was computed? (the size is then computed again) */
export function drifted(then: Dec, now: Dec, bps = 50): boolean {
  if (!D.isPos(then)) return true;
  const diff = D.abs(D.sub(now, then));
  return D.gt(D.mul(diff, D.from(10_000n)), D.mul(then, D.from(BigInt(bps))));
}

export interface LiqInput {
  instrument: string; side: 'buy' | 'sell'; /** base size of the order */ size: DecStr; /** the venue's mark (the preview's) */ mark: DecStr;
  /** the venue's leverage setting for this instrument, and its margin mode (the preview's) */ leverage: DecStr; marginMode: 'cross' | 'isolated';
  /** the venue's maximum leverage for this instrument (the pinned table the API publishes) */ venueMaxLeverage: number | null | undefined;
  /** the account's equity as the venue reports it */ equity: DecStr | null | undefined; /** the venue's open positions */ positions: readonly { instrument: string }[] | null | undefined;
}
export type LiqEstimate = { ok: true; /** null = no price liquidates it */ price: Dec | null; basis: 'isolated' | 'cross' } | { ok: false; why: 'has_position' | 'other_positions' | 'unknown' };
/**
 * Estimated liquidation price of the position this order would OPEN, by Hyperliquid's published rule (docs/v4/venues/
 * hyperliquid.md, §margining): « the maintenance margin is currently set to half of the initial margin at max leverage », i.e.
 * a maintenance fraction of 1 ÷ (2 × the venue's maximum leverage for the asset); the position is liquidated where its equity
 * equals that requirement (packages/derivatives/src/margin.ts).
 *   isolated: the margin is the order's own (value ÷ leverage);
 *   cross   : the whole account backs it — computed only when the account holds no other position (its equity is then the margin).
 * No estimate when a position already exists on this asset (the result would be the COMBINED position's) or, in cross, when other
 * positions exist (their gains and losses move the price). Fees, funding and the venue's size tiers are not counted: an estimate.
 */
export function liqEstimate(i: LiqInput): LiqEstimate {
  const size = dec(i.size), mark = dec(i.mark), lev = dec(i.leverage), max = i.venueMaxLeverage;
  if (!size || !mark || !lev || !D.isPos(size) || !D.isPos(mark) || !D.isPos(lev) || !max || !Number.isInteger(max) || max < 1 || !i.positions) return { ok: false, why: 'unknown' };
  if (i.positions.some((p) => p.instrument === i.instrument)) return { ok: false, why: 'has_position' };
  const maintenanceFraction = D.div(D.one, D.from(BigInt(2 * max)), 18, 'up'), side = i.side === 'buy' ? 'long' as const : 'short' as const;
  try {
    if (i.marginMode === 'isolated') return { ok: true, price: liquidationPriceAtLeverage({ side, entryPrice: mark, leverage: lev, maintenanceFraction }).value, basis: 'isolated' };
    if (i.positions.length > 0) return { ok: false, why: 'other_positions' };
    const equity = dec(i.equity);
    if (!equity || !D.isPos(equity)) return { ok: false, why: 'unknown' };
    return { ok: true, price: liquidationPriceCross({ side, size, entryPrice: mark, accountCollateral: equity, maintenanceFraction }).value, basis: 'cross' };
  } catch { return { ok: false, why: 'unknown' }; }
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/mm/planner.ts
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

// Quote management: desired quotes vs what rests → the MINIMAL plan (keep / cancel / place / reduce). Pure and deterministic.
//
// Invariants (property-tested in test/mm.test.ts):
//   1. never a crossing pair: every bid placed is below every ask placed, below the book's best ask, and below every ask of
//      ours that is still alive; symmetrically for asks;
//   2. never more than the budget: orders placed ≤ budget.places, cancels ≤ budget.cancels, reductions ≤ budget.reduces,
//      actions (one batch of each kind) ≤ budget.actions — cancels first, then reductions, then placements;
//   3. never beyond the inventory limits, whatever fills: position + every live bid + every bid placed ≤ hardInventory (and the
//      mirror for asks); at or beyond the soft limit the increasing side is not quoted; at or beyond the hard limit everything
//      is cancelled and the excess is unwound with reduce-only orders;
//   4. hysteresis: an order within the tolerance of its target is kept — the plan of an unchanged situation is empty;
//   5. no blind action on what is not known: an order whose state is `pending`, `cancelling` or `unknown` is neither cancelled
//      again nor replaced; it keeps its slot and its weight in the inventory bound until a reconcile settles it. A side that is
//      blocked (unknown outcome) gets no new quote.
// The engine sends the cancels FIRST and places only if every cancel of the plan was confirmed.
import { D, type Dec, type DecStr } from '@spw/derivatives';
import type { BookTop, DesiredQuote, QuoteRounder, RestingOrder, Side } from './types.ts';

export interface PlannerConfig {
  /** a resting order is kept while its price is within this of its target (bps of the mid) */
  requoteToleranceBps: DecStr;
  /** … and its remaining size within this fraction of the target size (bps) */
  sizeToleranceBps: DecStr;
  maxRestingPerSide: number;
  /** |position| at which the increasing side stops being quoted, and at which everything is pulled and unwound — base units */
  softInventory: DecStr; hardInventory: DecStr;
  /** a reduce-only unwind is priced this far THROUGH the touch (bps): it is meant to execute */
  reduceSlippageBps: DecStr;
  /** largest single reduce-only order (base units) */
  maxReduceSize: DecStr;
}
export interface PlanBudget { /** new quotes */ places: number; cancels: number; /** reduce-only orders */ reduces: number; /** signed actions (batches) */ actions: number }
export type PlanMode = 'quote' | 'pull' | 'flatten';
export interface PlanInput {
  book: BookTop;
  /** signed position, base units — from the last reconcile */
  position: DecStr;
  desired: readonly DesiredQuote[];
  resting: readonly RestingOrder[];
  budget: PlanBudget;
  /** `pull`: cancel everything, quote nothing. `flatten`: the same, and unwind the whole position reduce-only */
  mode: PlanMode;
  /** sides on which nothing new is placed (an action of unknown outcome awaits a reconcile) */
  blockedSides?: readonly Side[];
  /** ≥ 1 (a decimal): widens the hysteresis when the rate budget is under pressure */
  toleranceMultiplier?: DecStr;
  round: QuoteRounder;
  /** rounding of a reduce-only order: the price may round TOWARDS crossing (it is meant to execute), the size down */
  roundReduce: QuoteRounder;
}
export interface ReduceOrder { side: Side; price: DecStr; size: DecStr }
export interface Plan { keep: string[]; cancel: string[]; place: DesiredQuote[]; reduce: ReduceOrder[]; /** batches this plan needs */ actions: number; degraded: boolean; notes: string[] }

const BPS = D.from(10000n);
const abs = D.abs, sum = (xs: Dec[]) => xs.reduce((a, b) => D.add(a, b), D.zero);

export function planQuotes(cfg: PlannerConfig, i: PlanInput): Plan {
  const notes: string[] = [], blocked = new Set(i.blockedSides ?? []);
  const bid = D.from(i.book.bid), ask = D.from(i.book.ask), pos = D.from(i.position), soft = D.from(cfg.softInventory), hard = D.from(cfg.hardInventory);
  const bookOk = D.isPos(bid) && D.gt(ask, bid);
  const mid = D.div(D.add(bid, ask), D.from(2n), 12, 'half_even');
  let degraded = false;
  const overHard = D.gte(abs(pos), hard);
  const quoting = i.mode === 'quote' && bookOk && !overHard;
  if (i.mode === 'quote' && !bookOk) notes.push('no two-sided, uncrossed book: quotes pulled');
  if (overHard && i.mode === 'quote') notes.push('hard inventory limit: quotes pulled, excess unwound reduce-only');

  // ---- 1. targets: rounded, inside the soft limit, not crossing the book nor each other ----
  let targets: DesiredQuote[] = [];
  if (quoting) {
    for (const q of [...i.desired].sort((a, b) => a.level - b.level)) {
      const r = i.round(q.side, q.price, q.size);
      if (!r.ok) { notes.push(`${q.side} level ${q.level} dropped: ${r.reason}`); continue; }
      targets.push({ side: q.side, price: r.price, size: r.size, level: q.level });
    }
    if (D.gte(pos, soft)) { if (targets.some((t) => t.side === 'buy')) notes.push('soft inventory limit (long): no bid'); targets = targets.filter((t) => t.side !== 'buy'); }
    if (D.lte(pos, D.neg(soft))) { if (targets.some((t) => t.side === 'sell')) notes.push('soft inventory limit (short): no ask'); targets = targets.filter((t) => t.side !== 'sell'); }
    targets = targets.filter((t) => (t.side === 'buy' ? D.lt(D.from(t.price), ask) : D.gt(D.from(t.price), bid)));       // post-only: would be refused by the venue
    const bids = targets.filter((t) => t.side === 'buy'), asks = targets.filter((t) => t.side === 'sell');
    if (bids.length && asks.length) {
      const maxBid = bids.map((t) => D.from(t.price)).reduce(D.max), minAsk = asks.map((t) => D.from(t.price)).reduce(D.min);
      targets = targets.filter((t) => (t.side === 'buy' ? D.lt(D.from(t.price), minAsk) : D.gt(D.from(t.price), maxBid)));
    }
  }

  // ---- 2. match targets to what rests (hysteresis) ----
  const tol = D.mul(mid, D.mul(D.from(cfg.requoteToleranceBps), D.max(D.one, D.from(i.toleranceMultiplier ?? '1'))));   // × 10000
  const keep: string[] = [], cancel: RestingOrder[] = [], place: DesiredQuote[] = [], matched = new Set<string>();
  const actionable = (o: RestingOrder) => o.state === 'resting';
  for (const t of targets) {
    let best: RestingOrder | null = null, bestDiff: Dec | null = null;
    for (const o of i.resting) {
      if (o.side !== t.side || matched.has(o.clientId) || o.state === 'cancelling') continue;
      const diff = abs(D.sub(D.from(o.price), D.from(t.price)));
      if (D.gt(D.mul(diff, BPS), tol)) continue;
      if (o.state === 'resting') {
        const ds = abs(D.sub(D.from(o.size), D.from(t.size)));
        if (D.gt(D.mul(ds, BPS), D.mul(D.from(t.size), D.from(cfg.sizeToleranceBps)))) continue;
      }
      if (bestDiff === null || D.lt(diff, bestDiff)) { best = o; bestDiff = diff; }
    }
    if (best) { matched.add(best.clientId); keep.push(best.clientId); } else place.push(t);
  }
  for (const o of i.resting) if (!matched.has(o.clientId) && actionable(o)) cancel.push(o);

  // ---- 3. budget: cancels first, the most exposed first ----
  const budget = { places: Math.max(0, Math.floor(i.budget.places)), cancels: Math.max(0, Math.floor(i.budget.cancels)), reduces: Math.max(0, Math.floor(i.budget.reduces)), actions: Math.max(0, Math.floor(i.budget.actions)) };
  let actions = 0;
  cancel.sort((a, b) => D.cmp(abs(D.sub(D.from(a.price), mid)), abs(D.sub(D.from(b.price), mid))) || (a.clientId < b.clientId ? -1 : 1));
  let cancels = cancel;
  if (cancels.length && budget.actions < 1) { cancels = []; degraded = true; notes.push('no action budget: nothing can be sent'); }
  else if (cancels.length > budget.cancels) { cancels = cancels.slice(0, budget.cancels); degraded = true; notes.push(`cancel budget: ${cancels.length} of ${cancel.length} cancels`); }
  if (cancels.length) actions += 1;
  const allCancelled = cancels.length === cancel.length;
  const gone = new Set(cancels.map((o) => o.clientId));
  const alive = i.resting.filter((o) => !gone.has(o.clientId));

  // ---- 4. reductions ----
  const reduce: ReduceOrder[] = [];
  const excess = i.mode === 'flatten' ? abs(pos) : overHard ? D.sub(abs(pos), soft) : D.zero;
  if (D.isPos(excess) && bookOk) {
    const side: Side = D.isPos(pos) ? 'sell' : 'buy', slip = D.from(cfg.reduceSlippageBps);
    const px = side === 'sell' ? D.div(D.mul(bid, D.sub(BPS, slip)), BPS, 12, 'down') : D.div(D.mul(ask, D.add(BPS, slip)), BPS, 12, 'up');
    let left = excess; const chunk = D.from(cfg.maxReduceSize);
    while (D.isPos(left) && reduce.length < budget.reduces && actions < budget.actions) {
      const r = i.roundReduce(side, D.str(px), D.str(D.min(left, chunk)));
      if (!r.ok) { notes.push(`reduce dropped: ${r.reason}`); break; }
      reduce.push({ side, price: r.price, size: r.size });
      left = D.sub(left, D.from(r.size));
    }
    if (reduce.length) actions += 1;
    if (D.isPos(left) && (reduce.length >= budget.reduces || actions >= budget.actions)) { degraded = true; notes.push('reduce budget: the unwind continues at the next cycle'); }
  } else if (D.isPos(excess)) notes.push('no usable book: the unwind waits');

  // ---- 5. placements: only when every cancel of the plan goes out; inside slots, the inventory bound and the budget ----
  let placing: DesiredQuote[] = [];
  if (place.length && !allCancelled) { degraded = true; notes.push('placements wait: not every cancel fits this cycle'); }
  else if (place.length) {
    for (const t of place) {
      const p = D.from(t.price), same = alive.filter((o) => o.side === t.side), other = alive.filter((o) => o.side !== t.side);
      if (blocked.has(t.side)) { notes.push(`${t.side} side blocked until reconciled`); continue; }
      const mine = placing.filter((x) => x.side === t.side);
      if (same.length + mine.length >= cfg.maxRestingPerSide) { notes.push(`${t.side} level ${t.level} dropped: ${cfg.maxRestingPerSide} orders already on that side`); continue; }
      // never above an ask of ours that is still alive (or below a bid)
      if (other.some((o) => (t.side === 'buy' ? D.gte(p, D.from(o.price)) : D.lte(p, D.from(o.price))))) { notes.push(`${t.side} level ${t.level} waits: it would cross an order of ours that is still alive`); continue; }
      // the inventory bound if every order of that side fills
      const signed = t.side === 'buy' ? pos : D.neg(pos);
      const worst = D.add(D.add(signed, sum(same.map((o) => D.from(o.size)))), D.add(sum(mine.map((x) => D.from(x.size))), D.from(t.size)));
      if (D.gt(worst, hard)) { notes.push(`${t.side} level ${t.level} dropped: the hard inventory limit would be reachable`); continue; }
      placing.push(t);
    }
    if (placing.length > budget.places) { placing = placing.slice(0, budget.places); degraded = true; notes.push(`place budget: ${placing.length} of ${place.length} quotes`); }
    if (placing.length && actions >= budget.actions) { placing = []; degraded = true; notes.push('action budget: placements wait'); }
    if (placing.length) actions += 1;
  }
  return { keep, cancel: cancels.map((o) => o.clientId), place: placing, reduce, actions, degraded, notes };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Rate budget → what one planning cycle may spend, and how hard to degrade

export interface RateState {
  /** address-based requests left at the venue (`userRateLimit`: cap − used); null = not known → treated as zero for placements */
  addressRemaining: number | null;
  /** IP weight left in the current minute */
  ipWeightRemaining: number;
  /** quote batches the signer's token bucket would sign now, and quotes left this hour / today */
  signerActions: number; signerOrdersHour: number; signerOrdersDay: number;
}
export interface RateConfig {
  /** address requests never spent on quotes: the heartbeat and the cancels of a shutdown must stay affordable */
  addressReserve: number;
  /** below this many requests above the reserve: thin to one level and widen the hysteresis */
  addressComfort: number;
  /** IP weight never spent on quotes */
  ipReserve: number;
  /** IP weight one quote batch costs in total (the exchange request + the signer's own venue read) */
  ipWeightPerQuoteBatch: number;
  maxBatch: number;
}
export interface CycleBudget extends PlanBudget { toleranceMultiplier: DecStr; maxLevels: number | null; reason: string | null }
/**
 * Cancels and reductions are always budgeted (the venue gives cancels their own, larger allowance; a reduction is what makes a
 * stop possible). Quotes are budgeted from what is left ABOVE the reserves, and thinned before the venue throttles the address.
 */
export function cycleBudget(s: RateState, cfg: RateConfig): CycleBudget {
  const free = Math.max(0, (s.addressRemaining ?? 0) - cfg.addressReserve), ipFree = Math.max(0, s.ipWeightRemaining - cfg.ipReserve);
  const byIp = Math.floor(ipFree / Math.max(1, cfg.ipWeightPerQuoteBatch)) > 0 ? cfg.maxBatch : 0;
  let places = Math.max(0, Math.min(cfg.maxBatch, free, s.signerOrdersHour, s.signerOrdersDay, byIp, s.signerActions > 0 ? cfg.maxBatch : 0));
  let toleranceMultiplier: DecStr = '1', maxLevels: number | null = null, reason: string | null = null;
  if (places === 0) reason = s.addressRemaining === null ? 'address rate limit not known' : free === 0 ? 'address rate limit: reserve reached' : byIp === 0 ? 'IP weight: reserve reached' : 'signer rate: used';
  else if (free < cfg.addressComfort) { toleranceMultiplier = D.str(D.div(D.from(BigInt(4 * cfg.addressComfort - 3 * free)), D.from(BigInt(cfg.addressComfort)), 4, 'half_even'));   /* 1 + 3 × (1 − free / comfort): from 1 to 4 */ maxLevels = 1; places = Math.min(places, 2); reason = 'address rate limit under pressure: one level, wider hysteresis'; }
  return { places, cancels: 40, reduces: cfg.maxBatch, actions: Math.max(1, Math.min(3, s.ipWeightRemaining)), toleranceMultiplier, maxLevels, reason };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/budget.ts
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

// The two rate limits of the venue, kept by the engine's side BEFORE the venue enforces them (docs/V11-MARKET-MAKING.md §7):
//
//   IP weight        "REST requests share an aggregated weight limit of 1200 per minute." The API process and the isolated signer
//                    leave through ONE public IP, so the budget counts both: every REST request this process sends (measured, with
//                    the documented weights of packages/derivatives/src/venues/hyperliquid/http.ts) and what the signer reads for
//                    each quote batch it is asked to sign (an ESTIMATE this process makes — it cannot see the signer's requests:
//                    `frontendOpenOrders` 20 + `clearinghouseState` 2, + `activeAssetData` 20 when the account is flat on the
//                    instrument, + `orderStatus` 2 per quote still pending in its ledger). WebSocket traffic costs no weight.
//   address requests "1 request per 1 USDC traded … initial buffer of 10000 requests"; a batch of n orders counts n; cancels have
//                    their own, larger allowance. The venue's own figure (`userRateLimit`, weight 20) is read at a slow cadence;
//                    between two reads the budget subtracts what it sent.
//
// A sliding one-minute window; time is injected. Nothing here sends anything.
import { hlExchangeWeight, hlInfoWeight, HL_WEIGHT_LIMIT_PER_MINUTE } from '@spw/derivatives';

export interface WeightSample { at: number; weight: number; kind: string }
export interface MmBudgetOptions { now: () => number; limitPerMinute?: number;
  /** weight this PROCESS spent on the venue in the last minute, when its HTTP client already keeps the window (`HlHttp.budget.used`): the
   *  requests noted here are then counted in the totals only, and the window is that figure plus the signer's estimated share */
  processUsed?: () => number }
/** what the signer reads itself to sign ONE quote batch — the estimate used by the budget */
export const signerQuoteReadWeight = (o: { flat: boolean; pendingQuotes: number }): number => hlInfoWeight('frontendOpenOrders') + hlInfoWeight('clearinghouseState') + (o.flat ? hlInfoWeight('activeAssetData') : 0) + hlInfoWeight('orderStatus') * Math.max(0, o.pendingQuotes);

export class MmBudget {
  readonly limit: number;
  private readonly now: () => number;
  private spent: WeightSample[] = [];
  /** totals since the budget was created, by kind (rest:<info type>, exchange:<action>, signer:quotes) */
  readonly totals: Record<string, { requests: number; weight: number }> = {};
  private peak = 0;
  private address: { remaining: number | null; at: number; spentSince: number; orders: number; cancels: number; heartbeats: number } = { remaining: null, at: 0, spentSince: 0, orders: 0, cancels: 0, heartbeats: 0 };
  private readonly processUsed: (() => number) | null;
  constructor(o: MmBudgetOptions) { this.now = o.now; this.limit = o.limitPerMinute ?? HL_WEIGHT_LIMIT_PER_MINUTE; this.processUsed = o.processUsed ?? null; }

  private note(kind: string, weight: number): void {
    const t = this.totals[kind] ?? (this.totals[kind] = { requests: 0, weight: 0 });
    t.requests += 1; t.weight += weight;
    if (!this.processUsed || kind.startsWith('signer:')) this.spent.push({ at: this.now(), weight, kind });
    this.peak = Math.max(this.peak, this.used());
  }
  /** weight spent in the last minute, by this process and (estimated) by the signer */
  used(): number {
    const cut = this.now() - 60_000;
    while (this.spent.length && this.spent[0]!.at <= cut) this.spent.shift();
    return this.spent.reduce((n, x) => n + x.weight, 0) + (this.processUsed ? this.processUsed() : 0);
  }
  remaining(): number { return Math.max(0, this.limit - this.used()); }
  /** the highest one-minute weight seen so far */
  peakPerMinute(): number { return this.peak; }
  /** an info request of this process */
  info(type: string): void { this.note(`rest:${type}`, hlInfoWeight(type)); }
  /** an exchange request of this process: `1 + floor(batch_length / 40)` */
  exchange(action: string, batchLength: number): void { this.note(`exchange:${action}`, hlExchangeWeight(batchLength)); }
  /** the signer's own reads for one quote batch (estimate) */
  signerQuoteBatch(o: { flat: boolean; pendingQuotes: number }): void { this.note('signer:quotes', signerQuoteReadWeight(o)); }

  // ---- address-based requests ----
  /** the venue's own figure, just read (`userRateLimit`: cap − used) */
  addressObserved(remaining: number): void { this.address = { ...this.address, remaining, at: this.now(), spentSince: 0 }; }
  /** requests this process sent since: orders and heartbeats count against the address limit, cancels against their own larger one */
  addressSpent(kind: 'orders' | 'cancels' | 'heartbeat', n: number): void {
    if (kind === 'orders') { this.address.orders += n; this.address.spentSince += n; }
    else if (kind === 'heartbeat') { this.address.heartbeats += n; this.address.spentSince += n; }
    else this.address.cancels += n;
  }
  /** what is believed to be left: the last figure of the venue minus what was sent since; null before the first read */
  addressRemaining(): number | null { return this.address.remaining === null ? null : Math.max(0, this.address.remaining - this.address.spentSince); }

  report() {
    const rest = Object.entries(this.totals).filter(([k]) => k.startsWith('rest:')).reduce((n, [, v]) => n + v.weight, 0), exchange = Object.entries(this.totals).filter(([k]) => k.startsWith('exchange:')).reduce((n, [, v]) => n + v.weight, 0);
    return { limitPerMinute: this.limit, usedLastMinute: this.used(), peakPerMinute: this.peak, totals: { ...this.totals }, restWeight: rest, exchangeWeight: exchange, signerWeightEstimate: this.totals['signer:quotes']?.weight ?? 0,
      address: { remaining: this.addressRemaining(), observedAt: this.address.at || null, orders: this.address.orders, cancels: this.address.cancels, heartbeats: this.address.heartbeats } };
  }
}

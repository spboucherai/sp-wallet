/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/mm/types.ts
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

// Market-making core — shared types. Pure and deterministic: no I/O, no clock (time is an argument), no randomness.
// Prices, sizes and money are decimal strings (`DecStr`) and are computed exactly; the two places where a `number` appears
// are statistical estimates that feed a decision but are never a price or a size themselves: a volatility (vol.ts) and the
// transcendental part of the Avellaneda–Stoikov half spread (policy.ts). Both are converted to a fixed number of decimals
// before they touch a price. Design: docs/V11-MARKET-MAKING.md.
import type { DecStr } from '@spw/derivatives';

export type Side = 'buy' | 'sell';
/** a quote the policy wants on the book; `level` 0 is the closest to the mid */
export interface DesiredQuote { side: Side; price: DecStr; size: DecStr; level: number }
/** rounding onto the venue's grid — injected, so that this package knows no venue. It must round a bid DOWN, an ask UP and a size DOWN, and refuse what falls under the venue's minimum */
export type QuoteRounder = (side: Side, price: DecStr, size: DecStr) => { ok: true; price: DecStr; size: DecStr } | { ok: false; reason: string };

/** top of the book and what the engine knows about its freshness */
export interface BookTop { bid: DecStr; bidSize: DecStr; ask: DecStr; askSize: DecStr; /** venue time of the snapshot (unix ms) */ ts: number }

export interface PolicyInput {
  nowMs: number;
  book: BookTop;
  /** signed position in base units: positive long */
  inventory: DecStr;
  /** volatility of the mid per policy interval, in basis points (vol.ts); null until enough observations exist */
  volBps: number | null;
}
export interface PolicyOutput { quotes: DesiredQuote[]; /** why, in numbers — journaled with the decision */ diagnostics: Record<string, string | number | null>; notes: string[] }
/**
 * A quoting rule. ONE interface for paper and live: the paper rule of the agents runtime (`spread_inventory`,
 * services/api/src/agent-runtime/families.ts `mmQuotes`) is to implement this interface at the integration step — it is not
 * copied here, so that there is one rule and not two (docs/v11/work/mm-core.md).
 */
export interface QuotePolicy { readonly id: string; readonly version: string; quotes(input: PolicyInput): PolicyOutput }

/** an order of ours as the engine currently believes it to be */
export interface RestingOrder {
  clientId: string; side: Side; price: DecStr; /** remaining size */ size: DecStr;
  /** `resting`: the venue confirmed it. `pending`: sent or being sent, not confirmed. `cancelling`: a cancel was sent, not confirmed. `unknown`: the outcome of its batch is not known */
  state: 'resting' | 'pending' | 'cancelling' | 'unknown';
  placedAt: number;
}

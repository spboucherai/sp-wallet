/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/mm/ports.ts
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

// Market-making engine — the ports it is built on. The engine (engine.ts) imports NOTHING from agents/, agent-runtime/, orders/,
// risk/ or quotes/: everything it needs from the rest of the service comes through these interfaces, bound at the integration
// step (docs/v11/work/mm-core.md). Design: docs/V11-MARKET-MAKING.md.
import type { DecStr } from '@spw/derivatives';
import type { BookTop, Side } from '@spw/trading/mm';

// ---- market data ----------------------------------------------------------------------------------------------------------------
export type VenueStatus = 'connected' | 'reconnecting' | 'stale' | 'idle';
export interface MarketSnapshot { status: VenueStatus; /** top of the book with the venue's own timestamp; null before the first one */ book: BookTop | null }
/** the quote hub at the integration step; a replay of recorded frames in the simulator */
export interface MarketDataPort { snapshot(instrument: string): MarketSnapshot }

// ---- orders ---------------------------------------------------------------------------------------------------------------------
export interface QuoteOrder { /** the venue's client order id (0x + 32 hex), chosen by the engine: the idempotency key */ clientId: string; side: Side; price: DecStr; size: DecStr }
export type OrderResult =
  | { clientId: string; outcome: 'resting'; venueOrderId: string }
  | { clientId: string; outcome: 'filled'; venueOrderId: string; size: DecStr; price: DecStr }
  /** the venue refused THIS order (post-only would cross, minimum value, margin …): it does not exist */
  | { clientId: string; outcome: 'rejected'; code: string; reason: string };
/**
 * Three outcomes, and the third is first-class:
 *   `done`     the venue answered order by order;
 *   `refused`  CERTAIN that nothing of the batch exists on the venue — refused before it was sent (a lock, the signer), or the
 *              venue refused the whole payload;
 *   `unknown`  the batch was sent (or may have been) and no readable answer came back: the orders may or may not exist.
 *              The engine never resends: it reconciles by client id first.
 */
export type BatchOutcome =
  | { kind: 'done'; results: OrderResult[] }
  | { kind: 'refused'; stage: 'lock' | 'signer' | 'venue'; code: string; message: string }
  | { kind: 'unknown'; message: string };
export type CancelResult = { clientId: string; outcome: 'cancelled' | 'gone' };
export type CancelOutcome = { kind: 'done'; results: CancelResult[] } | { kind: 'refused'; stage: 'lock' | 'signer' | 'venue'; code: string; message: string } | { kind: 'unknown'; message: string };
export type SwitchOutcome = { kind: 'done' } | { kind: 'refused'; stage: 'lock' | 'signer' | 'venue'; code: string; message: string } | { kind: 'unknown'; message: string };
export interface VenueOpenOrder { clientId: string | null; venueOrderId: string; side: Side; price: DecStr; /** remaining */ size: DecStr; reduceOnly: boolean; timestamp: number }
export interface VenueFill { id: string; clientId: string | null; venueOrderId: string; side: Side; price: DecStr; size: DecStr; /** the venue's sign: positive = paid, negative = rebate */ fee: DecStr; ts: number; maker: boolean }
export type OrderLookup = 'open' | 'filled' | 'cancelled' | 'rejected' | 'not_found';
export interface AccountRead { /** signed position of the instrument, base units */ position: DecStr; accountValue: DecStr; ts: number }
export interface OrderPort {
  /** post-only quotes, one batch, one instrument */
  submitQuotes(instrument: string, quotes: readonly QuoteOrder[]): Promise<BatchOutcome>;
  /** reduce-only immediate-or-cancel orders */
  submitReduces(instrument: string, orders: readonly QuoteOrder[]): Promise<BatchOutcome>;
  cancel(instrument: string, clientIds: readonly string[]): Promise<CancelOutcome>;
  /** the venue's dead man's switch: cancel everything at `timeMs`; null removes it */
  scheduleCancel(timeMs: number | null): Promise<SwitchOutcome>;
  // ---- reads: the venue is the truth; each throws when it cannot be read ----
  openOrders(instrument: string): Promise<VenueOpenOrder[]>;
  account(instrument: string): Promise<AccountRead>;
  fills(instrument: string, sinceMs: number): Promise<VenueFill[]>;
  lookup(instrument: string, clientId: string): Promise<OrderLookup>;
  /** address-based requests left at the venue (cap − used); throws when unreadable */
  addressRequestsRemaining(): Promise<number>;
  /** how long after it is sent a batch can still be accepted by the venue (the signed action's validity), ms */
  readonly actionTtlMs: number;
}

// ---- risk, mandate, clock, journal ----------------------------------------------------------------------------------------------
export interface RiskDecision { allow: boolean; code: string | null; message: string | null }
export interface RiskPort {
  /** pre-trade check of the unified risk engine at the integration step */
  evaluate(intent: { instrument: string; kind: 'quotes' | 'reduce'; orders: readonly QuoteOrder[]; position: DecStr }): Promise<RiskDecision>;
  /** the kill switch, read at every cycle */
  killSwitch(): Promise<boolean>;
}
export interface MandateView {
  mandateId: string; phase: 'active' | 'wind_down' | 'ended'; expiresAt: number;
  deadManSeconds: number;
  /** what the signer would still sign: quote batches right now (its token bucket), quotes left this hour and today */
  bucketActions: number; quotesLeftHour: number; quotesLeftDay: number;
  /** the signer's own record of the dead man's switch, when it gives one: armed until, and the deadlines that lapsed today (the venue allows 10 triggers a day; the signer stops opening at 8) */
  switch?: { armed: boolean; deadline: number | null; lapsesToday: number };
}
export interface MandatePort { /** null: no quoting mandate (or the signer cannot be asked) → no quote */ current(): Promise<MandateView | null> }
export interface ClockPort { now(): number }
export interface JournalEvent { ts: number; type: string; [k: string]: unknown }
export interface JournalPort { record(e: JournalEvent): void }

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venue.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

/**
 * Venue adapter contract (docs/v4/DERIVATIVES-ARCHITECTURE.md, "venue.ts"). Interfaces only: adapters live in `venues/<venue>/`.
 * Adapters BUILD and VERIFY actions; they never hold a key. Signing is injected.
 */
import type { DecStr } from './decimal.ts';
import type { AccountState, Book, Candle, Fill, FundingPayment, Instrument, Order, OrderRequest, Position, PublicTrade, Ticker, VenueId } from './models.ts';

export interface Capabilities { marketData: boolean; account: boolean; orders: boolean; orderTypes: OrderRequest['type'][];
  tif: OrderRequest['tif'][]; modify: boolean; leverage: boolean; marginModes: ('cross' | 'isolated')[]; subaccounts: boolean;
  testnet: boolean; stream: boolean; notes: string[] }

export interface VenueAdapter {
  readonly id: VenueId; readonly network: 'mainnet' | 'testnet'; readonly capabilities: Capabilities;
  instruments(): Promise<Instrument[]>;
  tickers(): Promise<Ticker[]>;
  book(symbol: string, depth?: number): Promise<Book>;
  trades(symbol: string, limit?: number): Promise<PublicTrade[]>;
  candles(symbol: string, interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d', o: { start?: number; end?: number; limit?: number }): Promise<Candle[]>;
  fundingHistory(symbol: string, o: { start: number; end?: number }): Promise<{ ts: number; rate: DecStr; premium: DecStr | null }[]>;
  // account (read): `account` is the venue's account identifier (an EVM address on Hyperliquid/GMX, a dydx1… address + subaccount on dYdX)
  account(account: string): Promise<AccountState>;
  positions(account: string): Promise<Position[]>;
  openOrders(account: string): Promise<Order[]>;
  orderHistory(account: string, o?: { limit?: number }): Promise<Order[]>;
  fills(account: string, o?: { start?: number; limit?: number }): Promise<Fill[]>;
  funding(account: string, o?: { start?: number }): Promise<FundingPayment[]>;
  /** subscribe to live data; returns an unsubscribe function. Reconnects by itself and reports gaps through onStatus. */
  stream?(sub: { type: 'book' | 'trades' | 'ticker'; symbol: string } | { type: 'account'; account: string },
    on: (ev: unknown) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void): () => void;
  // trading: adapters BUILD and VERIFY actions; they never hold a key. Signing is injected.
  trading?: VenueTrading;
}

export interface SignRequest { venue: VenueId; network: 'mainnet' | 'testnet'; kind: string; payload: unknown }  // typed per venue

export interface VenueTrading {
  /** canonical, venue-ready action for an order + the exact bytes/typed data to sign; pure, no network */
  buildOrder(req: OrderRequest, ctx: { instrument: Instrument; nonce: number }): { action: unknown; sign: SignRequest };
  buildCancel(o: { instrument: Instrument; venueOrderId?: string; clientId?: string; nonce: number }): { action: unknown; sign: SignRequest };
  /** independent re-derivation used by the signer: what does this signed payload do? throws if it is not exactly an order/cancel */
  describe(sign: SignRequest): { kind: 'order' | 'cancel' | 'leverage' | 'approve_agent' | 'schedule_cancel' | 'other'; orders?: OrderRequest[]; detail: Record<string, unknown> };
  submit(action: unknown, signature: unknown, nonce: number): Promise<{ accepted: boolean; venueOrderIds: string[]; error: string | null; raw: unknown }>;
}

// names used by the venue adapters
export type StreamSub = { type: 'book' | 'trades' | 'ticker'; symbol: string } | { type: 'account'; account: string };
export type StreamStatus = 'connected' | 'reconnecting' | 'stale';

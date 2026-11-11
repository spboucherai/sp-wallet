// Venue adapter contract (docs/v4/DERIVATIVES-ARCHITECTURE.md, "Core contract"). MINIMAL version written with the Hyperliquid
// adapter; the foundation module replaces this file at merge. Same names, same shapes.
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
  account(account: string): Promise<AccountState>;
  positions(account: string): Promise<Position[]>;
  openOrders(account: string): Promise<Order[]>;
  orderHistory(account: string, o?: { limit?: number }): Promise<Order[]>;
  fills(account: string, o?: { start?: number; limit?: number }): Promise<Fill[]>;
  funding(account: string, o?: { start?: number }): Promise<FundingPayment[]>;
  /** subscribe to live data; returns an unsubscribe function. Reconnects by itself and reports gaps through onStatus. */
  stream?(sub: { type: 'book' | 'trades' | 'ticker'; symbol: string } | { type: 'account'; account: string },
    on: (ev: unknown) => void, onStatus: (s: 'connected' | 'reconnecting' | 'stale') => void): () => void;
  /** trading: adapters BUILD and VERIFY actions; they never hold a key. Signing is injected. */
  trading?: VenueTrading;
}

export interface SignRequest { venue: VenueId; network: 'mainnet' | 'testnet'; kind: string; payload: unknown } // typed per venue

export interface VenueTrading {
  /** canonical, venue-ready action for an order + the exact bytes/typed data to sign; pure, no network */
  buildOrder(req: OrderRequest, ctx: { instrument: Instrument; nonce: number }): { action: unknown; sign: SignRequest };
  buildCancel(o: { instrument: Instrument; venueOrderId?: string; clientId?: string; nonce: number }): { action: unknown; sign: SignRequest };
  /** independent re-derivation used by the signer: what does this signed payload do? throws if it is not exactly an order/cancel */
  describe(sign: SignRequest): { kind: 'order' | 'cancel' | 'leverage' | 'approve_agent' | 'other'; orders?: OrderRequest[]; detail: Record<string, unknown> };
  submit(action: unknown, signature: unknown, nonce: number): Promise<{ accepted: boolean; venueOrderIds: string[]; error: string | null; raw: unknown }>;
}

export type VenueErrorCode = 'rate_limited' | 'unavailable' | 'bad_answer' | 'rejected' | 'unsupported' | 'stale';
export class VenueError extends Error {
  readonly venue: VenueId; readonly code: VenueErrorCode; readonly detail: Record<string, unknown>;
  constructor(venue: VenueId, code: VenueErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(`${venue}: ${message}`);
    this.name = 'VenueError'; this.venue = venue; this.code = code; this.detail = detail;
  }
}

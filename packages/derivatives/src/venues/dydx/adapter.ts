/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/dydx/adapter.ts
 * Module           : venues
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

// dYdX v4 (dYdX Chain) — READ side of the venue adapter, on the public Indexer API (see docs/v4/venues/dydx.md).
// Nothing here signs or sends anything: only GET requests and websocket subscriptions.
import { D, type DecStr } from '../../decimal.ts';
import type { AccountState, Book, Candle, FundingPayment, Instrument, PublicTrade, Ticker } from '../../models.ts';
import type { Capabilities, StreamStatus, StreamSub, VenueAdapter } from '../../venue.ts';
import { ds, venueError, venueHttp, type HttpAnswer } from '../http.ts';
import { DYDX, fillOf, instrumentId, instrumentOf, orderOf, parseAccount, positionOf, tickerOf, tradeOf, type DydxFill, type DydxOrder, type DydxPosition } from './map.ts';
import { DydxStream, type DydxStreamEvent, type WebSocketCtor } from './stream.ts';
import * as W from './wire.ts';
import { z } from 'zod';

/** Pinned public endpoints — https://docs.dydx.xyz/interaction/endpoints */
export const DYDX_ENDPOINTS = {
  mainnet: { rest: 'https://indexer.dydx.trade/v4', ws: 'wss://indexer.dydx.trade/v4/ws', chainId: 'dydx-mainnet-1' },
  testnet: { rest: 'https://indexer.v4testnet.dydx.exchange/v4', ws: 'wss://indexer.v4testnet.dydx.exchange/v4/ws', chainId: 'dydx-testnet-4' },
} as const;
const RESOLUTION = { '1m': '1MIN', '5m': '5MINS', '15m': '15MINS', '1h': '1HOUR', '4h': '4HOURS', '1d': '1DAY' } as const;
/** the indexer serves at most 1000 rows per page on these lists */
const PAGE = 1000;
const MAX_PAGES = 25;

export const DYDX_CAPABILITIES: Capabilities = {
  marketData: true, account: true, orders: false, orderTypes: [], tif: [], modify: false, leverage: false,
  marginModes: ['cross', 'isolated'], subaccounts: true, testnet: true, stream: true,
  notes: [
    'Read-only delivery: no order, cancel, deposit or withdrawal is built or sent.',
    'Trading would require a Cosmos secp256k1 key (dydx1… address), protobuf SIGN_DIRECT transactions (MsgPlaceOrder / MsgCancelOrder / MsgBatchCancel) broadcast to a validator, good-til-block handling for short-term orders and sequence handling for stateful ones; a trading-only key is possible through permissioned keys (authenticators) — see docs/v4/venues/dydx.md.',
    'The dYdX terms exclude the United States, Canada and the United Kingdom among others; the mainnet indexer answers account endpoints with HTTP 403 GEOBLOCKED from a blocked location (reported as VenueError "rejected"). Market data is not blocked.',
    'No separate mark price: mark = index = the protocol oracle price. Ticker.mid is null (read the book). Ticker.funding is the estimated next hourly rate.',
    'Account identifier: "dydx1…/<subaccountNumber>" (default 0). Subaccounts ≥ 128 are isolated-margin children of subaccount (n mod 128); they are read one at a time.',
    'Position.leverage, Position.margin are derived from venue figures (notional at oracle price ÷ subaccount equity; notional × initial margin fraction). Position.liquidationPrice, AccountState.maintenanceMargin and withdrawable are null: the indexer does not publish them.',
    'Order.createdAt is 0: the indexer gives the creation block height only. Indexer states BEST_EFFORT_OPENED / BEST_EFFORT_CANCELED are reported as "pending" (not final).',
    'FundingPayment.amount keeps the venue sign: positive = received by the account.',
  ],
};

export interface DydxAdapterOptions { network?: 'mainnet' | 'testnet'; fetch?: typeof fetch; now?: () => number; restUrl?: string; wsUrl?: string; WebSocket?: WebSocketCtor }
export interface DydxAdapter extends VenueAdapter {
  positions(account: string): Promise<DydxPosition[]>;
  openOrders(account: string): Promise<DydxOrder[]>;
  orderHistory(account: string, o?: { limit?: number }): Promise<DydxOrder[]>;
  fills(account: string, o?: { start?: number; limit?: number }): Promise<DydxFill[]>;
  stream(sub: StreamSub, on: (ev: unknown) => void, onStatus: (s: StreamStatus) => void): () => void;
  /** every subaccount number that exists for an address (parents and isolated children) */
  subaccounts(address: string): Promise<number[]>;
  /** latest block height and time the indexer has processed — how far behind the chain the answers may be */
  height(): Promise<{ height: string; ts: number }>;
}

export function createDydxAdapter(o: DydxAdapterOptions = {}): DydxAdapter {
  const network = o.network ?? 'mainnet', now = o.now ?? Date.now;
  const base = o.restUrl ?? DYDX_ENDPOINTS[network].rest;
  const http = venueHttp(DYDX, o.fetch);
  let streamConn: DydxStream | null = null;

  // 403 GEOBLOCKED, 404 "not found" and 400 validation errors all come as { errors: [{ msg, code? }] }
  const on4xx = (a: HttpAnswer) => {
    let msg = a.text.slice(0, 200), code: string | undefined;
    try { const p = W.errorAnswer.safeParse(JSON.parse(a.text)); if (p.success) { msg = p.data.errors[0]!.msg; code = p.data.errors[0]!.code; } } catch { /* keep the raw text */ }
    if (a.status === 403 && code === 'GEOBLOCKED') return venueError(DYDX, 'rejected', `GEOBLOCKED: the indexer refuses this request from the current location (${msg.slice(0, 120)})`);
    return venueError(DYDX, 'rejected', `HTTP ${a.status}: ${msg.slice(0, 200)}`);
  };
  const get = <T>(path: string, schema: z.ZodType<T>) => http.get(`${base}${path}`, schema, { on4xx });
  const q = (p: Record<string, string | number | undefined>) => {
    const s = Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    return s ? `?${s}` : '';
  };
  const sym = (symbol: string) => {
    if (!/^[A-Za-z0-9,._-]{1,80}$/.test(symbol)) throw venueError(DYDX, 'rejected', 'invalid market ticker');
    return encodeURIComponent(symbol);
  };
  const markets = async () => (await get('/perpetualMarkets', W.perpetualMarkets)).markets;
  const whose = (account: string) => { const a = parseAccount(account); return { ...a, qs: { address: a.address, subaccountNumber: a.subaccountNumber } }; };

  return {
    id: DYDX, network, capabilities: DYDX_CAPABILITIES,

    async instruments(): Promise<Instrument[]> { return Object.values(await markets()).map(instrumentOf); },
    async tickers(): Promise<Ticker[]> { const ts = now(); return Object.values(await markets()).map((m) => tickerOf(m, ts)); },

    async book(symbol: string, depth = 50): Promise<Book> {
      const b = await get(`/orderbooks/perpetualMarket/${sym(symbol)}`, W.orderbook);
      const side = (l: { price: string; size: string }[], dir: 1 | -1) =>
        l.map((x): [DecStr, DecStr] => [x.price, x.size]).sort((a, c) => dir * D.cmp(D.from(a[0]), D.from(c[0]))).slice(0, Math.max(1, depth));
      return { instrument: instrumentId(symbol), bids: side(b.bids, -1), asks: side(b.asks, 1), ts: now() };
    },

    async trades(symbol: string, limit = 100): Promise<PublicTrade[]> {
      const t = await get(`/trades/perpetualMarket/${sym(symbol)}${q({ limit: Math.min(Math.max(1, limit), PAGE) })}`, W.trades);
      return t.trades.map((x) => tradeOf(symbol, x));
    },

    async candles(symbol, interval, c): Promise<Candle[]> {
      const r = await get(`/candles/perpetualMarkets/${sym(symbol)}${q({ resolution: RESOLUTION[interval], limit: Math.min(Math.max(1, c.limit ?? 500), PAGE),
        fromISO: c.start === undefined ? undefined : new Date(c.start).toISOString(), toISO: c.end === undefined ? undefined : new Date(c.end).toISOString() })}`, W.candles);
      // volume is in base units (`baseTokenVolume`); oldest first
      return r.candles.map((x): Candle => ({ ts: Date.parse(x.startedAt), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.baseTokenVolume })).sort((a, b) => a.ts - b.ts);
    },

    async fundingHistory(symbol, f) {
      const out: { ts: number; rate: DecStr; premium: DecStr | null }[] = [];
      let before: number | undefined = f.end;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await get(`/historicalFunding/${sym(symbol)}${q({ limit: PAGE, effectiveBeforeOrAt: before === undefined ? undefined : new Date(before).toISOString() })}`, W.historicalFunding);
        const rows = r.historicalFunding.map((x) => ({ ts: Date.parse(x.effectiveAt), rate: x.rate, premium: null }));   // hourly rate actually applied; the premium is not published
        for (const row of rows) if (row.ts >= f.start && (f.end === undefined || row.ts <= f.end)) out.push(row);
        const oldest = rows.reduce((m, x) => Math.min(m, x.ts), Infinity);
        if (rows.length < PAGE || oldest <= f.start) break;
        before = oldest - 1;
      }
      const seen = new Set<number>();
      return out.filter((x) => (seen.has(x.ts) ? false : (seen.add(x.ts), true))).sort((a, b) => a.ts - b.ts);
    },

    async account(account: string): Promise<AccountState> {
      const a = whose(account);
      const s = (await get(`/addresses/${a.address}/subaccountNumber/${a.subaccountNumber}`, W.subaccountAnswer)).subaccount;
      const usdc = s.assetPositions.USDC;
      const collateral = usdc ? D.from(usdc.size) : D.from('0');
      return {
        venue: DYDX, account: a.id, equity: s.equity, freeCollateral: s.freeCollateral,
        collateral: ds(usdc?.side === 'SHORT' ? D.neg(D.abs(collateral)) : collateral),   // USDC balance of the subaccount (negative when borrowed against positions)
        marginUsed: ds(D.sub(D.from(s.equity), D.from(s.freeCollateral))),
        maintenanceMargin: null, withdrawable: null, ts: now(), source: 'venue',
      };
    },

    async positions(account: string): Promise<DydxPosition[]> {
      const a = whose(account);
      const [s, m] = await Promise.all([get(`/addresses/${a.address}/subaccountNumber/${a.subaccountNumber}`, W.subaccountAnswer), markets()]);
      return Object.values(s.subaccount.openPerpetualPositions).filter((p) => p.status === 'OPEN').map((p) => {
        const market = m[p.market];
        if (!market) throw venueError(DYDX, 'bad_answer', `position in unknown market ${p.market}`);
        return positionOf(p, market, s.subaccount.equity);
      });
    },

    async openOrders(account: string): Promise<DydxOrder[]> {
      const a = whose(account);
      return (await get(`/orders${q({ ...a.qs, status: 'OPEN,UNTRIGGERED,BEST_EFFORT_OPENED', limit: PAGE })}`, W.orders)).map(orderOf);
    },
    async orderHistory(account: string, h?: { limit?: number }): Promise<DydxOrder[]> {
      const a = whose(account);
      return (await get(`/orders${q({ ...a.qs, limit: Math.min(Math.max(1, h?.limit ?? 100), PAGE), returnLatestOrders: 'true' })}`, W.orders)).map(orderOf);
    },
    async fills(account: string, f?: { start?: number; limit?: number }): Promise<DydxFill[]> {
      const a = whose(account);
      const r = await get(`/fills${q({ ...a.qs, limit: Math.min(Math.max(1, f?.limit ?? 100), PAGE) })}`, W.fills);
      return r.fills.map(fillOf).filter((x) => f?.start === undefined || x.ts >= f.start);
    },
    async funding(account: string, f?: { start?: number }): Promise<FundingPayment[]> {
      const a = whose(account);
      const r = await get(`/fundingPayments${q({ ...a.qs, limit: PAGE })}`, W.fundingPayments);
      return r.fundingPayments
        .map((x): FundingPayment => ({ instrument: instrumentId(x.ticker), amount: x.payment, rate: x.rate, size: x.size, ts: Date.parse(x.createdAt) }))
        .filter((x) => f?.start === undefined || x.ts >= f.start);
    },

    async subaccounts(address: string): Promise<number[]> {
      const a = parseAccount(address);
      return (await get(`/addresses/${a.address}`, W.addressAnswer)).subaccounts.map((s) => s.subaccountNumber).sort((x, y) => x - y);
    },
    async height() {
      const h = await get('/height', z.object({ height: z.string().regex(/^\d+$/), time: z.string() }));
      return { height: h.height, ts: Date.parse(h.time) };
    },

    stream(sub: StreamSub, on: (ev: unknown) => void, onStatus: (s: StreamStatus) => void): () => void {
      streamConn ??= new DydxStream({ url: o.wsUrl ?? DYDX_ENDPOINTS[network].ws, WebSocket: o.WebSocket, now });
      const cb = on as (ev: DydxStreamEvent) => void;
      if (sub.type === 'account') return streamConn.subscribe('v4_subaccounts', parseAccount(sub.account).id, null, cb, onStatus);
      sym(sub.symbol);
      if (sub.type === 'book') return streamConn.subscribe('v4_orderbook', sub.symbol, null, cb, onStatus);
      if (sub.type === 'trades') return streamConn.subscribe('v4_trades', sub.symbol, null, cb, onStatus);
      return streamConn.subscribe('v4_markets', null, sub.symbol, cb, onStatus);
    },
  };
}

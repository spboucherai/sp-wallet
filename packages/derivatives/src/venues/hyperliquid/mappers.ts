// Hyperliquid wire → normalized models. Pure functions shared by the REST adapter and the websocket stream.
import type { z } from 'zod';
import { D, type DecStr } from '../../decimal.ts';
import type { Book, Fill, Instrument, Order, OrderRequest, PublicTrade, Ticker } from '../../models.ts';
import { VenueError } from '../../venue.ts';
import { HL_MIN_NOTIONAL, hlPriceDecimals, hlStep } from './format.ts';
import type { hlL2Book, hlTrades, HlAssetCtx, HlFill, HlFrontendOrder, HlMeta } from './schemas.ts';

const ID = 'hyperliquid' as const;
export const hlErr = (code: ConstructorParameters<typeof VenueError>[1], message: string, detail: Record<string, unknown> = {}) => new VenueError(ID, code, message, detail);

export const HL_FUNDING_INTERVAL_SEC = 3600; // "The funding rate on Hyperliquid is paid every hour." (trading/funding)
export const HL_INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as const;
/** "Only the most recent 5000 candles are available" (info endpoint, candle snapshot) */
export const HL_MAX_CANDLES = 5000;
const SETTLEMENT = 'Linear perpetual margined and settled in USDC; the oracle is USDT-denominated for most assets (quanto: USDT PnL paid in USDC, no conversion); funding every hour, peer to peer';
const MARK_METHOD = 'Median of (1) oracle + 150 s EMA of (Hyperliquid mid − oracle), (2) median of best bid, best ask, last trade, (3) weighted median of Binance, OKX, Bybit, Gate IO, MEXC perp mids; updated about every 3 s';

export function parseHl<S extends z.ZodType>(schema: S, body: unknown, what: string): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw hlErr('bad_answer', `${what}: unexpected answer (${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')})`.slice(0, 300));
  return r.data;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function hlAccount(account: string): string {
  if (typeof account !== 'string' || !ADDRESS.test(account)) throw hlErr('unsupported', 'account must be a 20-byte hex address (the account itself, never the API wallet)');
  return account.toLowerCase();
}

export function hlInstrument(u: HlMeta['universe'][number]): Instrument {
  const isolatedOnly = u.onlyIsolated === true || u.marginMode === 'strictIsolated' || u.marginMode === 'noCross';
  return {
    venue: ID, symbol: u.name, id: `${ID}:${u.name}`, base: u.name, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: SETTLEMENT,
    // No fixed tick on Hyperliquid: prices have at most 5 significant figures and at most 6 − szDecimals decimals (integers always
    // allowed). `tickSize` is the FINEST step that can exist for this asset; the step at a given price is `hlTickAt`.
    tickSize: hlStep(hlPriceDecimals(u.szDecimals)), lotSize: hlStep(u.szDecimals), minOrderSize: null, minNotional: HL_MIN_NOTIONAL,
    maxLeverage: String(u.maxLeverage), marginModes: isolatedOnly ? ['isolated'] : ['cross', 'isolated'],
    fundingIntervalSec: HL_FUNDING_INTERVAL_SEC, markPriceMethod: MARK_METHOD, status: u.isDelisted === true ? 'halted' : 'active',
  };
}

export function hlTicker(symbol: string, c: HlAssetCtx, ts: number): Ticker {
  const prev = D.from(c.prevDayPx);
  return {
    instrument: `${ID}:${symbol}`, mark: c.markPx, index: c.oraclePx, mid: c.midPx, funding: c.funding, openInterest: c.openInterest,
    volume24h: c.dayNtlVlm, // USD notional over 24 h (the base-asset volume is `dayBaseVlm`)
    change24h: D.isZero(prev) ? null : D.str(D.div(D.sub(D.from(c.markPx), prev), prev, 6, 'half_even')), // fraction: 0.0123 = +1.23 %
    ts,
  };
}

export function hlBook(b: z.output<typeof hlL2Book>, depth?: number): Book {
  const side = (levels: { px: DecStr; sz: DecStr }[]): [DecStr, DecStr][] => (depth === undefined ? levels : levels.slice(0, depth)).map((l) => [l.px, l.sz]);
  const bids = side(b.levels[0]), asks = side(b.levels[1]);
  for (let i = 1; i < bids.length; i++) if (D.cmp(D.from(bids[i]![0]), D.from(bids[i - 1]![0])) >= 0) throw hlErr('bad_answer', 'l2Book: bids are not strictly descending');
  for (let i = 1; i < asks.length; i++) if (D.cmp(D.from(asks[i]![0]), D.from(asks[i - 1]![0])) <= 0) throw hlErr('bad_answer', 'l2Book: asks are not strictly ascending');
  if (bids.length && asks.length && D.cmp(D.from(bids[0]![0]), D.from(asks[0]![0])) >= 0) throw hlErr('bad_answer', 'l2Book: crossed book');
  return { instrument: `${ID}:${b.coin}`, bids, asks, ts: b.time };
}

/** "For a globally unique trade id, use (block_time, coin, tid)" — websocket subscriptions page */
export const hlTradeId = (t: { time: number; tid: number }): string => `${t.time}-${t.tid}`;
export function hlPublicTrade(t: z.output<typeof hlTrades>[number]): PublicTrade {
  return { instrument: `${ID}:${t.coin}`, price: t.px, size: t.sz, side: t.side === 'B' ? 'buy' : 'sell', ts: t.time, id: hlTradeId(t) };
}

const ORDER_TYPES: Record<string, OrderRequest['type']> = {
  Limit: 'limit', Market: 'market', 'Stop Market': 'stop_market', 'Stop Limit': 'stop_limit', 'Take Profit Market': 'take_profit_market', 'Take Profit Limit': 'take_profit_limit',
};
const TIFS: Record<string, OrderRequest['tif']> = { Gtc: 'gtc', Ioc: 'ioc', Alo: 'alo', FrontendMarket: 'ioc', LiquidationMarket: 'ioc' };
/** order status strings (info endpoint, "Query order status by oid or cloid") → normalized status */
export function hlOrderStatus(status: string): { status: Order['status']; rejectReason: string | null } {
  if (status === 'open') return { status: 'open', rejectReason: null };
  if (status === 'filled') return { status: 'filled', rejectReason: null };
  if (status === 'triggered') return { status: 'triggered', rejectReason: null };
  if (status === 'canceled') return { status: 'cancelled', rejectReason: null };
  if (status === 'rejected' || /Rejected$/.test(status)) return { status: 'rejected', rejectReason: status };
  if (/Canceled$/.test(status)) return { status: 'cancelled', rejectReason: status }; // marginCanceled, reduceOnlyCanceled, …: the venue's reason is kept
  throw hlErr('bad_answer', `unknown order status '${status.slice(0, 40)}'`);
}
export function hlOrder(o: HlFrontendOrder, status: string, statusTimestamp: number): Order {
  const type = ORDER_TYPES[o.orderType];
  if (!type) throw hlErr('unsupported', `order ${o.oid}: order type '${o.orderType}' cannot be represented`);
  const tif = o.tif === null ? 'gtc' : TIFS[o.tif]; // trigger orders carry no time in force
  if (!tif) throw hlErr('unsupported', `order ${o.oid}: time in force '${o.tif}' cannot be represented`);
  const filled = D.sub(D.from(o.origSz), D.from(o.sz));
  if (filled.m < 0n) throw hlErr('bad_answer', `order ${o.oid}: remaining size above original size`);
  const s = hlOrderStatus(status);
  return {
    instrument: `${ID}:${o.coin}`, side: o.side === 'B' ? 'buy' : 'sell', type, size: o.origSz, price: o.limitPx,
    triggerPrice: o.isTrigger ? o.triggerPx : null, reduceOnly: o.reduceOnly, tif, clientId: o.cloid ?? '',
    venueOrderId: String(o.oid), status: s.status === 'open' && !D.isZero(filled) ? 'partially_filled' : s.status,
    filled: D.str(filled), avgFillPrice: null, createdAt: o.timestamp, updatedAt: statusTimestamp, rejectReason: s.rejectReason,
  };
}

/** a fill is identified by its transaction hash and trade id (one account sees a trade id once per side) */
export const hlFillId = (f: { hash: string; tid: number }): string => `${f.hash}-${f.tid}`;
export function hlFillOf(f: HlFill): Fill {
  return {
    instrument: `${ID}:${f.coin}`, orderId: String(f.oid), clientId: f.cloid ?? null, side: f.side === 'B' ? 'buy' : 'sell', price: f.px, size: f.sz,
    fee: f.fee, feeAsset: f.feeToken, closedPnl: f.closedPnl, ts: f.time, id: hlFillId(f), liquidation: f.liquidation != null,
  };
}

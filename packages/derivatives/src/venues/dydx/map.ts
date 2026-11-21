/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/dydx/map.ts
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

// dYdX v4 → normalized models. Pure functions shared by the REST adapter and the websocket stream.
// Every figure stays a decimal string; arithmetic goes through `D` (bigint).
import { D } from '../../decimal.ts';
import type { Fill, Instrument, Order, Position, PublicTrade, Ticker } from '../../models.ts';
import { ds, venueError } from '../http.ts';
import { stepSizeOf, tickSizeOf, type PerpetualMarket, type PerpetualPosition, type WireFill, type WireOrder } from './wire.ts';
import type { z } from 'zod';
import type { trade as wireTrade } from './wire.ts';

export const DYDX = 'dydx' as const;
const bad = (m: string) => venueError(DYDX, 'bad_answer', m);
export const instrumentId = (ticker: string): string => `${DYDX}:${ticker}`;

/** dYdX funding is computed and paid once per hour (https://docs.dydx.xyz/concepts/trading/funding). */
export const DYDX_FUNDING_INTERVAL_SEC = 3600;
export const DYDX_SETTLEMENT = 'USDC-margined linear perpetual on dYdX Chain: PnL and funding settle in USDC (Noble USDC over IBC) in the subaccount; no expiry, no delivery';
export const DYDX_MARK_METHOD = 'no separate mark price: the protocol oracle price (validator-aggregated index of exchange prices, updated per block) values positions, margin, liquidations and conditional triggers';
/** Subaccounts 128 and above are the front-end's isolated-margin children of subaccount (n mod 128). */
export const DYDX_ISOLATED_FROM = 128;

export function instrumentOf(m: PerpetualMarket): Instrument {
  // the indexer's display strings must agree with the protocol parameters they are derived from
  if (tickSizeOf(m) !== m.tickSize) throw bad(`${m.ticker}: tickSize ${m.tickSize} ≠ subticksPerTick-derived ${tickSizeOf(m)}`);
  if (stepSizeOf(m) !== m.stepSize) throw bad(`${m.ticker}: stepSize ${m.stepSize} ≠ stepBaseQuantums-derived ${stepSizeOf(m)}`);
  const imf = D.from(m.initialMarginFraction);
  if (imf.m <= 0n) throw bad(`${m.ticker}: initialMarginFraction ${m.initialMarginFraction}`);
  const dash = m.ticker.lastIndexOf('-');
  if (dash <= 0) throw bad(`ticker ${m.ticker}`);
  return {
    venue: DYDX, symbol: m.ticker, id: instrumentId(m.ticker), base: m.ticker.slice(0, dash), quote: m.ticker.slice(dash + 1), kind: 'perpetual',
    collateral: 'USDC', settlement: DYDX_SETTLEMENT,
    tickSize: m.tickSize, lotSize: m.stepSize, minOrderSize: m.stepSize, minNotional: null,
    // base initial margin fraction; it rises with open interest between openInterestLowerCap and openInterestUpperCap when those are set
    maxLeverage: ds(D.div(D.from('1'), imf, 4, 'down')),
    marginModes: m.marketType === 'ISOLATED' ? ['isolated'] : ['cross', 'isolated'],
    fundingIntervalSec: DYDX_FUNDING_INTERVAL_SEC, markPriceMethod: DYDX_MARK_METHOD,
    // only ACTIVE accepts every order type; the other states (post-only, cancel-only, paused, initializing, final settlement) are not tradable for a taker
    status: m.status === 'ACTIVE' ? 'active' : 'halted',
  };
}

export function tickerOf(m: PerpetualMarket, ts: number): Ticker {
  const oracle = D.from(m.oraclePrice), change = D.from(m.priceChange24H), prev = D.sub(oracle, change);
  return {
    instrument: instrumentId(m.ticker), mark: m.oraclePrice, index: m.oraclePrice, mid: null,
    funding: m.nextFundingRate,                                   // estimate of the next hourly rate; positive = longs pay shorts
    openInterest: m.openInterest,                                 // base units, one side
    volume24h: m.volume24H,                                       // USD
    change24h: prev.m > 0n ? ds(D.div(change, prev, 8, 'half_even')) : null,   // fraction of the oracle price 24 h ago
    ts,
  };
}

export const tradeOf = (ticker: string, t: z.infer<typeof wireTrade>): PublicTrade =>
  ({ instrument: instrumentId(ticker), price: t.price, size: t.size, side: t.side === 'BUY' ? 'buy' : 'sell', ts: Date.parse(t.createdAt), id: t.id });

const ORDER_TYPES: Record<string, Order['type']> = {
  LIMIT: 'limit', MARKET: 'market', STOP_LIMIT: 'stop_limit', STOP_MARKET: 'stop_market', TAKE_PROFIT: 'take_profit_limit', TAKE_PROFIT_MARKET: 'take_profit_market',
};
export interface DydxOrderDetail { status: string; type: string; timeInForce: string; orderFlags: string; clobPairId: string;
  goodTilBlock: string | null; goodTilBlockTime: string | null; subaccountNumber: number | null; removalReason: string | null; optimisticFill: boolean }
export type DydxOrder = Order & { dydx: DydxOrderDetail };

export function orderOf(o: WireOrder): DydxOrder {
  const type = ORDER_TYPES[o.type];
  if (!type) throw venueError(DYDX, 'unsupported', `order ${o.id}: type ${o.type} has no normalized equivalent`);
  const filledStr = o.totalFilled ?? o.totalOptimisticFilled;
  if (filledStr === undefined) throw bad(`order ${o.id}: no filled amount`);
  const filled = D.from(filledStr);
  let status: Order['status'];
  switch (o.status) {
    case 'OPEN': status = filled.m > 0n ? 'partially_filled' : 'open'; break;
    case 'UNTRIGGERED': status = 'open'; break;                 // resting conditional order
    case 'FILLED': status = 'filled'; break;
    case 'CANCELED': status = 'cancelled'; break;
    // "best effort" states are the indexer's unconfirmed view of a short-term order: not final, so never reported as final
    case 'BEST_EFFORT_OPENED': case 'BEST_EFFORT_CANCELED': case 'PENDING': status = 'pending'; break;
    default: throw bad(`order ${o.id}: status ${o.status}`);
  }
  let tif: Order['tif'];
  if (o.postOnly) tif = 'alo';
  else if (o.timeInForce === 'GTT') tif = 'gtc';
  else if (o.timeInForce === 'IOC' || o.timeInForce === 'FOK') tif = 'ioc';
  else throw bad(`order ${o.id}: timeInForce ${o.timeInForce}`);
  const updatedAt = o.updatedAt ? Date.parse(o.updatedAt) : 0;
  return {
    instrument: instrumentId(o.ticker), side: o.side === 'BUY' ? 'buy' : 'sell', type, size: o.size, price: o.price,
    triggerPrice: o.triggerPrice ?? null, reduceOnly: o.reduceOnly, tif, clientId: o.clientId,
    venueOrderId: o.id, status, filled: filledStr, avgFillPrice: null,
    createdAt: 0,                                                // the indexer reports the creation block height only, not a time
    updatedAt, rejectReason: o.removalReason ?? null,
    dydx: { status: o.status, type: o.type, timeInForce: o.timeInForce, orderFlags: o.orderFlags, clobPairId: o.clobPairId,
      goodTilBlock: o.goodTilBlock ?? null, goodTilBlockTime: o.goodTilBlockTime ?? null, subaccountNumber: o.subaccountNumber ?? null,
      removalReason: o.removalReason ?? null, optimisticFill: o.totalFilled === undefined },
  };
}

export type DydxFill = Fill & { dydx: { liquidity: 'MAKER' | 'TAKER'; type: string } };
export const fillOf = (f: WireFill): DydxFill => ({
  instrument: instrumentId(f.market), orderId: f.orderId ?? null, clientId: null, side: f.side === 'BUY' ? 'buy' : 'sell', price: f.price, size: f.size,
  fee: f.fee,                                                    // USDC; negative = maker rebate
  feeAsset: 'USDC', closedPnl: null, ts: Date.parse(f.createdAt), id: f.id,
  liquidation: f.type === 'LIQUIDATED' || f.type === 'DELEVERAGED',   // this account was liquidated / deleveraged
  dydx: { liquidity: f.liquidity, type: f.type },
});

export type DydxPosition = Position & { dydx: { subaccountNumber: number; notional: string; leverageDefined: boolean; netFunding: string } };
/** `equity` is the subaccount's equity as reported by the indexer; `market` supplies the oracle price and the margin fraction. */
export function positionOf(p: PerpetualPosition, market: PerpetualMarket, equity: string): DydxPosition {
  const size = D.abs(D.from(p.size)), notional = D.mul(size, D.from(market.oraclePrice)), eq = D.from(equity);
  const leverageDefined = eq.m > 0n;
  return {
    instrument: instrumentId(p.market), side: p.side === 'LONG' ? 'long' : 'short', size: ds(size), entryPrice: p.entryPrice, markPrice: market.oraclePrice,
    liquidationPrice: null,                                      // not published by the venue; any figure would be an estimate
    // derived: notional at the oracle price over the subaccount's equity (cross: the whole subaccount backs every position)
    leverage: leverageDefined ? ds(D.div(notional, eq, 4, 'half_even')) : '0',
    marginMode: p.subaccountNumber >= DYDX_ISOLATED_FROM ? 'isolated' : 'cross',
    margin: ds(D.mul(notional, D.from(market.initialMarginFraction))),   // derived: initial margin requirement at the base fraction
    unrealizedPnl: p.unrealizedPnl, realizedPnl: p.realizedPnl,
    fundingPaid: ds(D.neg(D.from(p.netFunding))),             // venue reports net funding received; paid = −received
    source: 'venue',
    dydx: { subaccountNumber: p.subaccountNumber, notional: ds(notional), leverageDefined, netFunding: p.netFunding },
  };
}

/** `dydx1…` or `dydx1…/<subaccountNumber>` (default subaccount 0). The address is not checksummed here; the venue rejects unknown ones. */
export function parseAccount(account: string): { address: string; subaccountNumber: number; id: string } {
  const m = /^(dydx1[02-9ac-hj-np-z]{38})(?:\/(\d{1,6}))?$/.exec(account);
  if (!m) throw venueError(DYDX, 'rejected', 'account must be a dydx1… address, optionally followed by /<subaccount number>');
  const n = Number(m[2] ?? '0');
  if (n > 128_000) throw venueError(DYDX, 'rejected', 'subaccount number out of range (0–128000)');
  return { address: m[1]!, subaccountNumber: n, id: `${m[1]}/${n}` };
}

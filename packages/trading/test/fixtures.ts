/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/fixtures.ts
 * Module           : trading
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

import type { Book, Instrument, Position, Ticker } from '@spw/derivatives';
import type { CanonicalOrderInput, RiskLimits, TradingRiskContext } from '../src/index.ts';

export const NOW = 1_800_000_000_000;
export const MANDATE_ID = '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f601';

export function order(over: Partial<CanonicalOrderInput> = {}): CanonicalOrderInput {
  return {
    v: 1, venue: 'hyperliquid', network: 'mainnet', instrument: 'hyperliquid:BTC', marketKind: 'perp', side: 'buy', type: 'limit', size: '0.1', notional: null, limitPrice: '50000', triggerPrice: null,
    reduceOnly: false, tif: 'gtc', maxSlippageBps: 50, maxFeeUsd: '5', leverage: '3', marginMode: 'cross', clientOrderId: '0x0123456789abcdef0123456789abcdef', mode: 'live',
    principal: { kind: 'agent', id: 'agent-1' }, mandateId: MANDATE_ID, createdAt: NOW, expiresAt: NOW + 60_000, ...over,
  };
}

export const BTC: Instrument = {
  venue: 'hyperliquid', symbol: 'BTC', id: 'hyperliquid:BTC', base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: 'USDC', tickSize: '1', lotSize: '0.001', minOrderSize: '0.001', minNotional: '10',
  maxLeverage: '40', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: 'oracle', status: 'active',
};

/** a symmetric book around 50 000: 10 levels a side, 1 BTC each, 5 USD apart, best bid 49 995 / best ask 50 005 */
export function book(over: Partial<Book> = {}): Book {
  const bids: [string, string][] = [], asks: [string, string][] = [];
  for (let i = 0; i < 10; i++) { bids.push([String(49995 - 5 * i), '1']); asks.push([String(50005 + 5 * i), '1']); }
  return { instrument: 'hyperliquid:BTC', bids, asks, ts: NOW, ...over };
}
export const ticker = (over: Partial<Ticker> = {}): Ticker => ({ instrument: 'hyperliquid:BTC', mark: '50000', index: '50000', mid: '50000', funding: '0.0000125', openInterest: null, volume24h: null, change24h: null, ts: NOW, ...over });

export function position(over: Partial<Position> = {}): Position {
  return { instrument: 'hyperliquid:BTC', side: 'long', size: '0.5', entryPrice: '48000', markPrice: '50000', liquidationPrice: null, leverage: '3', marginMode: 'cross', margin: '8000', unrealizedPnl: '1000', realizedPnl: null, fundingPaid: null, source: 'venue', ...over };
}

export function context(over: Partial<TradingRiskContext> = {}): TradingRiskContext {
  return {
    now: NOW, killSwitch: false, readOnly: false, instrument: BTC, asset: 'BTC', positions: [],
    accounts: [{ venue: 'hyperliquid', account: '0xabc', equity: '20000', collateral: '20000', freeCollateral: '20000', marginUsed: '0', ts: NOW }],
    marks: [{ instrument: 'hyperliquid:BTC', source: 'hyperliquid', price: '50000', ts: NOW - 1000 }, { instrument: 'hyperliquid:BTC', source: 'coinbase', price: '50010', ts: NOW - 2000 }],
    book: book(), pnl: { realizedToday: '0', unrealizedToday: '0', realizedInception: '0', unrealizedInception: '0' }, equity: { current: '100000', peak: '100000' },
    signer: { reachable: true, halted: false }, connections: { hyperliquid: { connected: true } }, usage: { ordersLastMinute: 0, ordersLastHour: 0, ordersToday: 0, notionalToday: '0' },
    ...over,
  };
}

/** every limit set, generously: the base order passes all of them */
export function limits(over: Partial<RiskLimits> = {}): RiskLimits {
  return {
    allowedVenues: ['hyperliquid', 'gmx'], allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxPositionNotional: { per: {}, default: '40000' }, maxOrderLeverage: '5', maxAccountLeverage: '2',
    maxDailyLoss: '1000', maxTotalLoss: '5000', maxDrawdownBps: '1000', maxGrossExposure: '80000', maxNetExposure: '60000', maxAssetExposure: { per: { BTC: '50000' } }, maxVenueExposure: { per: {}, default: '60000' },
    maxVenueCollateralShareBps: '5000', minLiquidationDistanceBps: '1000', maxSlippageBps: '30', maxPriceAgeMs: { per: { coinbase: 10_000 }, default: 5_000 }, maxBookAgeMs: 5_000, minPriceSources: 2,
    maxSourceDeviationBps: '20', maxOrdersPerMinute: 5, maxOrdersPerHour: 50, maxOrdersPerDay: 200, maxOrderNotional: '10000', maxDailyNotional: '50000', minLiquidity: { withinBps: '10', multiple: '5' },
    ...over,
  };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/edgex/map.ts
 * Module           : venues
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

// edgeX → normalized models. Pure functions shared by the REST adapter and the websocket stream.
import { D, type DecStr } from '../../decimal.ts';
import type { Book, Instrument, InstrumentCategory, PublicTrade, Ticker } from '../../models.ts';
import { ds, venueError } from '../http.ts';
import type { Contract, MetaData, WireDepth, WireTicker, WireTrade } from './wire.ts';

export const EDGEX = 'edgex' as const;
const bad = (m: string) => venueError(EDGEX, 'bad_answer', m);
export const instrumentId = (contractName: string): string => `${EDGEX}:${contractName}`;

export const EDGEX_SETTLEMENT = 'USDC-margined linear perpetual on edgeX (Edge chain): PnL and funding settle in USDC in the venue account; no expiry, no delivery; a synthetic cash-settled contract that confers no claim on the underlying';
export const EDGEX_MARK_METHOD = 'mark price as the venue publishes it (equal to its oracle price in every answer recorded on 2026-11-15); the index is published separately; edgeX does not state the index sources per instrument';

/** risk tier of a contract: position value up to `positionValueUpperBound` USDC may use `maxLeverage` */
export interface EdgeXRiskTier { tier: number; maxLeverage: DecStr; maintenanceMarginRate: DecStr; positionValueUpperBound: string }
/** what edgeX's metadata says about a contract beyond the shared Instrument model */
export interface EdgeXInstrumentDetail {
  contractId: string; makerFeeRate: DecStr; takerFeeRate: DecStr; liquidationFeeRate: DecStr; riskTiers: EdgeXRiskTier[];
  maxOrderSize: DecStr; maxPositionSize: DecStr; fundingRateCap: { min: DecStr; max: DecStr }; isStock: boolean; isFx: boolean;
  /** where the category comes from: the app's category tabs (undocumented endpoint), or the two metadata flags only */
  categorySource: 'contract-labels' | 'flags';
}
export type EdgeXInstrument = Instrument & { edgex: EdgeXInstrumentDetail };

/** category tabs of the edgeX app that say what the underlying is; the first match wins */
const LABEL_CATEGORY: [string, InstrumentCategory][] = [['tabs.pre-ipo', 'pre_ipo'], ['tabs.commodities', 'commodity'], ['tabs.forex', 'fx'], ['tabs.stocks', 'equity'], ['tabs.etf', 'equity']];
/** the tabs exist once per product of the app; only those of Perps V2 are read (another product's "commodities" tab lists two stocks) */
const LABEL_PRODUCT = 'PrepV2';
/** contractId → category from the app's tabs. Contracts in none of these tabs are absent from the map. */
export function categoriesOf(labels: { multiLanguageKey: string; productCategory?: string | undefined; contracts: { contractId: string }[] }[]): Map<string, InstrumentCategory> {
  const out = new Map<string, InstrumentCategory>();
  for (const [key, cat] of LABEL_CATEGORY) for (const l of labels) if (l.multiLanguageKey === key && (l.productCategory === undefined || l.productCategory === LABEL_PRODUCT)) for (const c of l.contracts) if (!out.has(c.contractId)) out.set(c.contractId, cat);
  return out;
}
/**
 * The two flags of the documented metadata always win: `isStock` → equity (or pre_ipo when the pre-IPO tab lists it), `isFx` → fx.
 * For the rest, with the tabs: commodity when the commodities tab lists it, crypto otherwise. Without the tabs (the endpoint is
 * undocumented and may disappear): NO category, because the metadata alone cannot tell a commodity from a crypto asset.
 */
export function categoryOf(c: Contract, labels: Map<string, InstrumentCategory> | null): InstrumentCategory | undefined {
  const tab = labels?.get(c.contractId);
  if (c.isStock) return tab === 'pre_ipo' ? 'pre_ipo' : 'equity';
  if (c.isFx) return 'fx';
  if (!labels) return undefined;
  return tab === 'commodity' ? 'commodity' : 'crypto';
}

export function instrumentOf(c: Contract, meta: MetaData, labels: Map<string, InstrumentCategory> | null): EdgeXInstrument {
  const coinName = (id: string, what: string): string => { const x = meta.coinList.find((k) => k.coinId === id); if (!x) throw bad(`${c.contractName}: unknown ${what} coin ${id}`); return x.coinName; };
  const base = coinName(c.baseCoinId, 'base'), quote = coinName(c.quoteCoinId, 'quote'), collateral = coinName(meta.global.collateralCoinId, 'collateral');
  const maxLeverage = c.riskTierList.reduce((m, t) => (D.gt(D.from(t.maxLeverage), m) ? D.from(t.maxLeverage) : m), D.zero);
  if (maxLeverage.m <= 0n) throw bad(`${c.contractName}: no positive leverage in riskTierList`);
  const category = categoryOf(c, labels);
  return {
    venue: EDGEX, symbol: c.contractName, id: instrumentId(c.contractName), base, quote, kind: 'perpetual', collateral, settlement: EDGEX_SETTLEMENT,
    tickSize: c.tickSize, lotSize: c.stepSize, minOrderSize: c.minOrderSize, minNotional: null, maxLeverage: ds(maxLeverage),
    marginModes: ['cross', 'isolated'], fundingIntervalSec: c.fundingRateIntervalMin * 60, markPriceMethod: EDGEX_MARK_METHOD,
    status: !c.enableTrade ? 'halted' : c.enableOpenPosition ? 'active' : 'reduce_only',
    ...(category ? { category } : {}),
    edgex: {
      contractId: c.contractId, makerFeeRate: c.defaultMakerFeeRate, takerFeeRate: c.defaultTakerFeeRate, liquidationFeeRate: c.liquidateFeeRate,
      riskTiers: [...c.riskTierList].sort((a, b) => a.tier - b.tier).map((t) => ({ tier: t.tier, maxLeverage: t.maxLeverage, maintenanceMarginRate: t.maintenanceMarginRate, positionValueUpperBound: t.positionValueUpperBound })),
      maxOrderSize: c.maxOrderSize, maxPositionSize: c.maxPositionSize, fundingRateCap: { min: c.fundingMinRate, max: c.fundingMaxRate }, isStock: c.isStock, isFx: c.isFx,
      categorySource: labels ? 'contract-labels' : 'flags',
    },
  };
}

/** `ts` is the time the answer was received: the venue's ticker carries no as-of time (`endTime` is the end of its 24 h window) */
export function tickerOf(t: WireTicker, ts: number): Ticker {
  const bid = t.bestBidPrice ?? null, ask = t.bestAskPrice ?? null;
  return {
    instrument: instrumentId(t.contractName), mark: t.markPrice, index: t.indexPrice,
    mid: bid !== null && ask !== null ? ds(D.div(D.add(D.from(bid), D.from(ask)), D.from(2n), 18, 'half_even')) : null,
    funding: t.fundingRate,                                        // running forecast for the current interval; positive = longs pay
    openInterest: t.openInterest,                                  // base units
    volume24h: t.value,                                            // 24 h turnover in USDC
    change24h: t.priceChangePercent,                               // a fraction (−0.000979 = −0.0979 %)
    ts,
    ...(t.lastPrice !== null ? { last: t.lastPrice } : {}), ...(t.size !== null ? { volumeBase24h: t.size } : {}), ...(t.nextFundingTime !== undefined ? { nextFundingTs: t.nextFundingTime } : {}),
  };
}

export const tradeOf = (t: WireTrade): PublicTrade =>
  ({ instrument: instrumentId(t.contractName), price: t.price, size: t.size, side: t.isBuyerMaker ? 'sell' : 'buy', ts: t.time, id: t.ticketId });

const cmp = (dir: 1 | -1) => (a: [DecStr, DecStr], b: [DecStr, DecStr]): number => dir * D.cmp(D.from(a[0]), D.from(b[0]));
/** best first on both sides, zero sizes dropped, at most `depth` levels; throws on a crossed book */
export function bookFrom(symbol: string, bids: Iterable<[DecStr, DecStr]>, asks: Iterable<[DecStr, DecStr]>, depth: number, ts: number): Book {
  const side = (l: Iterable<[DecStr, DecStr]>, dir: 1 | -1) => [...l].filter((x) => !D.isZero(D.from(x[1]))).sort(cmp(dir)).slice(0, Math.max(1, depth));
  const b = side(bids, -1), a = side(asks, 1);
  if (b[0] && a[0] && D.gte(D.from(b[0][0]), D.from(a[0][0]))) throw bad(`${symbol}: crossed book (bid ${b[0][0]} ≥ ask ${a[0][0]})`);
  return { instrument: instrumentId(symbol), bids: b, asks: a, ts };
}
export const bookOf = (d: WireDepth, depth: number, ts: number): Book =>
  bookFrom(d.contractName, d.bids.map((x): [DecStr, DecStr] => [x.price, x.size]), d.asks.map((x): [DecStr, DecStr] => [x.price, x.size]), depth, ts);

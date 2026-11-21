/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/edgex/wire.ts
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

// edgeX Perps V2 — wire shapes of the PUBLIC endpoints, as recorded live on 2026-11-15 (docs/v11/research/edgex-api.md §1;
// fixtures in test/fixtures/edgex/). The field tables of the official docs do not match the live answers: these schemas follow
// the live answers. Every figure is a string on the wire and stays a decimal string here; a figure that is not a plain decimal
// fails validation (it never becomes NaN).
import { z } from 'zod';
import { MAX_DIGITS } from '../../decimal.ts';
import { canonDec } from '../http.ts';

const PLAIN_DEC = /^-?\d+(\.\d+)?$/;
/** a plain decimal string ("65239.0", "0.00005000") → canonical decimal string ("65239", "0.00005") */
export const dec = z.string().max(MAX_DIGITS + 2).regex(PLAIN_DEC, 'not a decimal string')
  .refine((x) => x.replace(/[-.]/g, '').length <= MAX_DIGITS, `more than ${MAX_DIGITS} digits`).transform((x) => canonDec(x));
/** some fields are an empty string when the venue has no value (`forecastFundingRate` of a settled row) */
export const decOrEmpty = z.union([z.literal('').transform(() => null), dec]);
/** Unix milliseconds sent as a string of digits */
export const ms = z.string().regex(/^\d{1,15}$/, 'not a millisecond timestamp').transform((x) => Number(x));
const id = z.string().regex(/^\d{1,20}$/, 'not a numeric id');
const version = z.string().regex(/^\d{1,30}$/);

/** `{"code":"SUCCESS","data":…,"msg":null,…}` — identical on every endpoint; errors carry `code` ≠ SUCCESS and a `msg` */
export const envelope = z.object({ code: z.string().min(1).max(80), data: z.unknown().optional(), msg: z.string().nullable().optional() });

/** contract names are letters and digits; a few are not ASCII (two listings on 2026-11-15 have Chinese names) */
export const CONTRACT_NAME_RE = /^[\p{L}\p{N}]{2,40}$/u;
export const riskTier = z.object({ tier: z.number().int(), maxLeverage: dec, maintenanceMarginRate: dec, positionValueUpperBound: z.string().regex(/^\d+$/) });
export const contract = z.object({
  contractId: id, contractName: z.string().regex(CONTRACT_NAME_RE), baseCoinId: id, quoteCoinId: id,
  tickSize: dec, stepSize: dec, minOrderSize: dec, maxOrderSize: dec, maxPositionSize: dec,
  defaultMakerFeeRate: dec, defaultTakerFeeRate: dec, liquidateFeeRate: dec,
  fundingRateIntervalMin: z.string().regex(/^[1-9]\d{0,5}$/).transform((x) => Number(x)), fundingMaxRate: dec, fundingMinRate: dec, fundingInterestRate: dec,
  displayMaxLeverage: dec, enableTrade: z.boolean(), enableOpenPosition: z.boolean(), enableDisplay: z.boolean(),
  isStock: z.boolean(), isFx: z.boolean(), riskTierList: z.array(riskTier).min(1),
});
export type Contract = z.infer<typeof contract>;
export const coin = z.object({ coinId: id, coinName: z.string().min(1).max(40) });
/** contracts are validated one by one by the adapter: one unreadable listing must not hide the others */
export const metaData = z.object({ global: z.object({ collateralCoinId: id }), coinList: z.array(coin), contractList: z.array(z.unknown()).min(1) });
export type MetaData = Omit<z.infer<typeof metaData>, 'contractList'> & { contractList: Contract[] };

/** undocumented but live (`GET /api/v2/public/contract-labels`): the app's category tabs */
export const contractLabels = z.array(z.object({ multiLanguageKey: z.string(), productCategory: z.string().optional(), contracts: z.array(z.object({ contractId: id })) }));

/** REST `getTicker` and the websocket `ticker.*` channels (the websocket snapshot adds bestAskPrice / bestBidPrice / marketOpen) */
export const ticker = z.object({
  contractId: id, contractName: z.string().min(1), markPrice: dec, indexPrice: decOrEmpty, oraclePrice: decOrEmpty, lastPrice: decOrEmpty,
  openInterest: decOrEmpty, fundingRate: decOrEmpty, nextFundingTime: ms.optional(), size: decOrEmpty, value: decOrEmpty, priceChangePercent: decOrEmpty,
  bestAskPrice: decOrEmpty.optional(), bestBidPrice: decOrEmpty.optional(), marketOpen: z.boolean().optional(),
});
export type WireTicker = z.infer<typeof ticker>;
export const tickers = z.array(ticker);

const level = z.object({ price: dec, size: dec });
export const depth = z.object({ contractId: id, contractName: z.string().min(1), depthType: z.string(), startVersion: version, endVersion: version, level: z.number().int(), asks: z.array(level), bids: z.array(level) });
export type WireDepth = z.infer<typeof depth>;
export const depths = z.array(depth);

export const kline = z.object({ klineTime: ms, open: dec, high: dec, low: dec, close: dec, size: dec });
export const klinePage = z.object({ dataList: z.array(kline), nextPageOffsetData: z.string().max(400) });

export const fundingRow = z.object({ contractId: id, fundingTime: ms, fundingRate: dec, premiumIndex: decOrEmpty.optional(), isSettlement: z.boolean() });
export const fundingPage = z.object({ dataList: z.array(fundingRow), nextPageOffsetData: z.string().max(400) });

/** websocket `trades.{contractId}`: there is no `side`; `isBuyerMaker: false` means the taker bought */
export const trade = z.object({ contractId: id, contractName: z.string().min(1), price: dec, size: dec, isBuyerMaker: z.boolean(), time: ms, ticketId: z.string().min(1).max(80) });
export type WireTrade = z.infer<typeof trade>;

/** every websocket frame: connected / subscribed / unsubscribed / ping / error / quote-event */
export const wsFrame = z.object({
  type: z.string().min(1), channel: z.string().optional(), time: z.string().optional(), request: z.string().optional(),
  content: z.object({ channel: z.string().optional(), dataType: z.string().optional(), data: z.unknown().optional(), code: z.string().optional(), msg: z.string().optional() }).optional(),
});

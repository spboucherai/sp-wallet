/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/hyperliquid/builder.ts
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

// Hyperliquid — builder-deployed (HIP-3) perp dexes, READ side only. Part of the Hyperliquid adapter (`adapter.builder`): same
// HTTP client, same weight budget, same zod discipline. Dossier: docs/v11/research/private-markets.md §1.
//
// Info requests used (all `POST /info`, documented at
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals and verified live on 2026-11-15/16):
//   perpDexs                      the dexes; element 0 is `null` (the validator-operated main dex)
//   meta / metaAndAssetCtxs + dex one dex's universe (and contexts)
//   allPerpMetas                  every universe, in `perpDexs` order
//   perpCategories                [[coin, category], …] set by the deployers (inconsistent spelling: normalised here)
//   perpAnnotation + coin         the deployer's on-chain description; answers `null` under load → retried, never read as "none"
//   l2Book / candleSnapshot       unchanged, with the full `dex:COIN` name
//
// NOT TRADABLE THROUGH THE WALLET (`HL_BUILDER_NOT_TRADABLE`): nothing here reaches the trading object, the pinned live asset
// table (`live/hl-assets.ts`) or the signer. The asset id is computed for information only.
import { z } from 'zod';
import { D, type DecStr } from '../../decimal.ts';
import type { Book, Candle, Instrument, Ticker } from '../../models.ts';
import type { HlHttp } from './http.ts';
import { HL_MIN_NOTIONAL, hlPriceDecimals, hlStep } from './format.ts';
import { HL_FUNDING_INTERVAL_SEC, HL_INTERVAL_MS, HL_MAX_CANDLES, hlBook, hlErr as err, hlTicker, parseHl } from './mappers.ts';
import { hlAddressSchema, hlCandles, hlDec, hlL2Book, hlMeta, hlMetaAndAssetCtxs, type HlMeta } from './schemas.ts';

/** reason code + text shown wherever trading would otherwise be offered on a builder-dex instrument */
export const HL_BUILDER_NOT_TRADABLE = {
  code: 'builder_dex_read_only',
  reason: 'Builder-deployed (HIP-3) Hyperliquid markets are served for market data only: the wallet\'s trading path covers the validator-operated dex alone (pinned asset table, signer policy), each builder dex has its own collateral balance, deployer-set oracle and settlement powers, and the deployers\' terms restrict some jurisdictions. No order, transfer or signed action is built for them.',
} as const;

// --- wire schemas ---------------------------------------------------------------------------------------------------------------
const dexName = z.string().regex(/^[a-z0-9]{1,12}$/);
const coinDec = z.tuple([z.string().min(1).max(40), hlDec]);
export const hlPerpDex = z.looseObject({
  name: dexName, fullName: z.string().max(80), deployer: hlAddressSchema, oracleUpdater: hlAddressSchema.nullable().optional(),
  assetToStreamingOiCap: z.array(coinDec).max(2000).optional(), assetToFundingMultiplier: z.array(coinDec).max(2000).optional(),
});
export const hlPerpDexs = z.array(hlPerpDex.nullable()).min(1).max(200);
export const hlPerpCategories = z.array(z.tuple([z.string().min(1).max(40), z.string().max(40)])).max(20_000);
export const hlPerpAnnotation = z.looseObject({
  category: z.string().max(40).optional(), description: z.string().max(4000).optional(), displayName: z.string().max(80).optional(), keywords: z.array(z.string().max(80)).max(50).optional(),
}).nullable();
export const hlAllPerpMetas = z.array(hlMeta).min(1).max(200);

// --- models ---------------------------------------------------------------------------------------------------------------------
export const HL_BUILDER_CATEGORIES = ['preipo', 'stocks', 'indices', 'commodities', 'crypto', 'fx', 'rates'] as const;
export type HlBuilderCategory = (typeof HL_BUILDER_CATEGORIES)[number] | 'other';
/** deployer-set strings are inconsistent (`fx`/`FX`, `stock`/`stocks`): one spelling per category, anything else is `other` */
export function hlNormalizeCategory(raw: string): HlBuilderCategory {
  const c = raw.trim().toLowerCase(), k = c === 'stock' ? 'stocks' : c === 'pre-ipo' || c === 'pre_ipo' ? 'preipo' : c;
  return (HL_BUILDER_CATEGORIES as readonly string[]).includes(k) ? (k as HlBuilderCategory) : 'other';
}

/** collateral token indices resolved through `spotMeta` on 2026-11-15 (dossier §1.2); any other index is shown as `token #n` */
const COLLATERAL: Record<number, string> = { 0: 'USDC', 235: 'USDe', 268: 'USDT0', 360: 'USDH' };
export const hlCollateralName = (token: number | undefined): string => token === undefined ? 'USDC' : COLLATERAL[token] ?? `token #${token}`;

/** `100000 + perp_dex_index × 10000 + index_in_meta` — https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids */
export function hlBuilderAssetId(dexIndex: number, indexInMeta: number): number {
  if (!Number.isInteger(dexIndex) || dexIndex < 1 || !Number.isInteger(indexInMeta) || indexInMeta < 0 || indexInMeta >= 10_000) throw err('unsupported', 'asset id: the dex index must be ≥ 1 and the index in meta within 0…9999');
  return 100_000 + dexIndex * 10_000 + indexInMeta;
}

export interface HlPerpDexInfo {
  /** position in `perpDexs` (the main dex is 0 and is not listed here) */
  index: number; name: string; fullName: string; deployer: string; oracleUpdater: string | null;
  /** per-asset open-interest caps (USD) and funding multipliers, as published by the deployer; absent = not published */
  oiCapUsd: Record<string, DecStr>; fundingMultiplier: Record<string, DecStr>;
}
export type HlMarginRestriction = 'cross_allowed' | 'no_cross' | 'strict_isolated' | 'only_isolated';
export interface HlBuilderMarket {
  dex: string; dexIndex: number;
  /** the full coin name, e.g. `xyz:ANT` — the only key to use (display names collide across dexes) */
  coin: string; indexInMeta: number;
  /** informational: the integer an order action would carry. Computed from live `perpDexs` + `meta`; never used to trade. */
  assetId: number;
  szDecimals: number; maxLeverage: number; isDelisted: boolean;
  /** raw flags of `meta` */
  onlyIsolated: boolean; marginMode: string | null; margin: HlMarginRestriction;
  collateral: string; oiCapUsd: DecStr | null; fundingMultiplier: DecStr | null;
  /** 24 h volume in contracts (`dayBaseVlm`); `ticker.volume24h` is the USD notional (`dayNtlVlm`) */
  volumeBase24h: DecStr | null;
  instrument: Instrument;
  /** for a delisted market the prices are the FROZEN last values (funding, open interest and volume are zero) */
  ticker: Ticker;
  tradable: false; notTradable: typeof HL_BUILDER_NOT_TRADABLE;
}
export interface HlAnnotation { category: HlBuilderCategory | null; rawCategory: string | null; description: string; displayName: string | null; keywords: string[] }
export interface HlAnnotationRead {
  coin: string;
  /** null = the venue answered `null` on every attempt: UNKNOWN, not "no annotation" */
  annotation: HlAnnotation | null; attempts: number;
}

export interface HlBuilderDexes {
  readonly notTradable: typeof HL_BUILDER_NOT_TRADABLE;
  dexes(): Promise<HlPerpDexInfo[]>;
  /** every categorised coin of every dex: `coin → { category, raw }` (still lists delisted coins: join with `isDelisted`) */
  categories(): Promise<Map<string, { category: HlBuilderCategory; raw: string }>>;
  /** instruments and tickers of one dex, delisted ones included and flagged */
  markets(dex: string): Promise<HlBuilderMarket[]>;
  /** asset ids of every builder-dex coin, from ONE `allPerpMetas` call (cross-check of `markets`) */
  assetIds(): Promise<Map<string, { assetId: number; dex: string; isDelisted: boolean; szDecimals: number }>>;
  annotation(coin: string, o?: { retries?: number }): Promise<HlAnnotationRead>;
  book(coin: string, depth?: number): Promise<Book>;
  candles(coin: string, interval: keyof typeof HL_INTERVAL_MS, q: { start?: number; end?: number; limit?: number }): Promise<Candle[]>;
}

const COIN = /^([a-z0-9]{1,12}):([A-Za-z0-9._-]{1,24})$/;
/** `xyz:ANT` → { dex: 'xyz', name: 'ANT' }; anything else (a main-dex coin included) is refused */
export function hlBuilderCoin(coin: string): { dex: string; name: string } {
  const m = typeof coin === 'string' ? COIN.exec(coin) : null;
  if (!m) throw err('unsupported', `'${String(coin).slice(0, 40)}' is not a builder-dex coin (expected dex:COIN)`);
  return { dex: m[1]!, name: m[2]! };
}

function marginOf(u: HlMeta['universe'][number]): HlMarginRestriction {
  return u.marginMode === 'strictIsolated' ? 'strict_isolated' : u.marginMode === 'noCross' ? 'no_cross' : u.onlyIsolated === true ? 'only_isolated' : 'cross_allowed';
}

function builderInstrument(u: HlMeta['universe'][number], dex: HlPerpDexInfo, collateral: string): Instrument {
  const { name } = hlBuilderCoin(u.name), margin = marginOf(u);
  return {
    venue: 'hyperliquid', symbol: u.name, id: `hyperliquid:${u.name}`, base: name, quote: 'USD', kind: 'perpetual', collateral,
    settlement: `Builder-deployed (HIP-3) perpetual of the dex '${dex.name}' (${dex.fullName}), margined and settled in ${collateral}; funding every hour; the deployer may halt and settle the market at the mark price`,
    tickSize: hlStep(hlPriceDecimals(u.szDecimals)), lotSize: hlStep(u.szDecimals), minOrderSize: null, minNotional: HL_MIN_NOTIONAL,
    maxLeverage: String(u.maxLeverage), marginModes: margin === 'cross_allowed' ? ['cross', 'isolated'] : ['isolated'],
    fundingIntervalSec: HL_FUNDING_INTERVAL_SEC,
    markPriceMethod: `Set by the deployer of the dex '${dex.name}' (oracle pushed by the deployer's updater); not the main-dex mark formula`,
    status: u.isDelisted === true ? 'halted' : 'active',
  };
}

export function createHlBuilderDexes(o: { http: HlHttp; now: () => number; sleep?: (ms: number) => Promise<void>; ttlMs?: number }): HlBuilderDexes {
  const { http, now } = o, ttlMs = o.ttlMs ?? 60_000, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  let dexCache: { at: number; value: HlPerpDexInfo[] } | null = null;

  const dexes = async (): Promise<HlPerpDexInfo[]> => {
    if (dexCache && now() - dexCache.at < ttlMs) return dexCache.value;
    const list = parseHl(hlPerpDexs, await http.info({ type: 'perpDexs' }), 'perpDexs');
    if (list[0] !== null) throw err('bad_answer', 'perpDexs: the first element must be null (the main dex)');
    const value = list.flatMap((d, index): HlPerpDexInfo[] => d === null ? [] : [{
      index, name: d.name, fullName: d.fullName, deployer: d.deployer, oracleUpdater: d.oracleUpdater ?? null,
      oiCapUsd: Object.fromEntries(d.assetToStreamingOiCap ?? []), fundingMultiplier: Object.fromEntries(d.assetToFundingMultiplier ?? []),
    }]);
    if (new Set(value.map((d) => d.name)).size !== value.length) throw err('bad_answer', 'perpDexs: duplicate dex name');
    dexCache = { at: now(), value };
    return value;
  };
  const dexOf = async (name: string): Promise<HlPerpDexInfo> => {
    const d = (await dexes()).find((x) => x.name === name);
    if (!d) throw err('unsupported', `unknown perp dex '${String(name).slice(0, 20)}'`);
    return d;
  };
  /** the coin must exist in its dex's universe: an unknown coin is refused before any book or candle request */
  const known = async (coin: string): Promise<HlBuilderMarket> => {
    const { dex } = hlBuilderCoin(coin), m = (await markets(dex)).find((x) => x.coin === coin);
    if (!m) throw err('unsupported', `unknown instrument '${coin.slice(0, 40)}'`);
    return m;
  };

  const marketCache = new Map<string, { at: number; value: HlBuilderMarket[] }>();
  const markets = async (dexName_: string): Promise<HlBuilderMarket[]> => {
    const dex = await dexOf(dexName_), hit = marketCache.get(dex.name);
    if (hit && now() - hit.at < Math.min(ttlMs, 2_000)) return hit.value;
    const [meta, ctxs] = parseHl(hlMetaAndAssetCtxs, await http.info({ type: 'metaAndAssetCtxs', dex: dex.name }), `metaAndAssetCtxs ${dex.name}`);
    if (ctxs.length !== meta.universe.length) throw err('bad_answer', `metaAndAssetCtxs ${dex.name}: universe and contexts differ in length`);
    const ts = now(), collateral = hlCollateralName(meta.collateralToken);
    const value = meta.universe.map((u, i): HlBuilderMarket => {
      if (hlBuilderCoin(u.name).dex !== dex.name) throw err('bad_answer', `metaAndAssetCtxs ${dex.name}: coin '${u.name.slice(0, 40)}' belongs to another dex`);
      const c = ctxs[i]!;
      return {
        dex: dex.name, dexIndex: dex.index, coin: u.name, indexInMeta: i, assetId: hlBuilderAssetId(dex.index, i), szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
        isDelisted: u.isDelisted === true, onlyIsolated: u.onlyIsolated === true, marginMode: u.marginMode ?? null, margin: marginOf(u), collateral,
        oiCapUsd: dex.oiCapUsd[u.name] ?? null, fundingMultiplier: dex.fundingMultiplier[u.name] ?? null, volumeBase24h: c.dayBaseVlm ?? null,
        instrument: builderInstrument(u, dex, collateral), ticker: hlTicker(u.name, c, ts), tradable: false, notTradable: HL_BUILDER_NOT_TRADABLE,
      };
    });
    marketCache.set(dex.name, { at: ts, value });
    return value;
  };

  return {
    notTradable: HL_BUILDER_NOT_TRADABLE, dexes, markets,

    async categories() {
      const out = new Map<string, { category: HlBuilderCategory; raw: string }>();
      for (const [coin, raw] of parseHl(hlPerpCategories, await http.info({ type: 'perpCategories' }), 'perpCategories')) out.set(coin, { category: hlNormalizeCategory(raw), raw });
      return out;
    },

    async assetIds() {
      const [list, metas] = [await dexes(), parseHl(hlAllPerpMetas, await http.info({ type: 'allPerpMetas' }), 'allPerpMetas')];
      if (metas.length !== list.length + 1) throw err('bad_answer', `allPerpMetas: ${metas.length} universes for ${list.length + 1} dexes`);
      const out = new Map<string, { assetId: number; dex: string; isDelisted: boolean; szDecimals: number }>();
      for (const d of list) metas[d.index]!.universe.forEach((u, i) => {
        if (hlBuilderCoin(u.name).dex !== d.name) throw err('bad_answer', `allPerpMetas: universe ${d.index} is not the dex '${d.name}'`);
        out.set(u.name, { assetId: hlBuilderAssetId(d.index, i), dex: d.name, isDelisted: u.isDelisted === true, szDecimals: u.szDecimals });
      });
      return out;
    },

    async annotation(coin, q = {}) {
      hlBuilderCoin(coin);
      const retries = q.retries ?? 3;
      if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw err('unsupported', 'retries must be between 0 and 5');
      for (let attempt = 1; ; attempt++) {
        const a = parseHl(hlPerpAnnotation, await http.info({ type: 'perpAnnotation', coin }), 'perpAnnotation');
        if (a !== null) {
          const raw = a.category ?? null;
          return { coin, attempts: attempt, annotation: { category: raw === null ? null : hlNormalizeCategory(raw), rawCategory: raw, description: a.description ?? '', displayName: a.displayName ?? null, keywords: a.keywords ?? [] } };
        }
        if (attempt > retries) return { coin, annotation: null, attempts: attempt };
        await sleep(250 * attempt);
      }
    },

    async book(coin, depth) {
      if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) throw err('unsupported', 'depth must be a positive integer');
      await known(coin);
      const b = parseHl(hlL2Book, await http.info({ type: 'l2Book', coin }), 'l2Book');
      if (b.coin !== coin) throw err('bad_answer', 'l2Book: answer is for another coin');
      return hlBook(b, depth);
    },

    async candles(coin, interval, q) {
      const step = HL_INTERVAL_MS[interval];
      if (!step) throw err('unsupported', `interval '${String(interval)}' is not supported`);
      const limit = q.limit ?? 500;
      if (!Number.isInteger(limit) || limit < 1 || limit > HL_MAX_CANDLES) throw err('unsupported', `limit must be between 1 and ${HL_MAX_CANDLES}`);
      await known(coin);
      const end = q.end ?? now(), start = q.start ?? end - limit * step;
      if (!(start < end)) throw err('unsupported', 'start must be before end');
      const c = parseHl(hlCandles, await http.info({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }), 'candleSnapshot');
      if (c.some((x) => x.s !== coin || x.i !== interval)) throw err('bad_answer', 'candleSnapshot: answer is for another coin or interval');
      const out: Candle[] = c.map((x) => ({ ts: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v })).sort((a, b) => a.ts - b.ts);
      for (const x of out) if (D.cmp(D.from(x.low), D.from(x.high)) > 0) throw err('bad_answer', 'candleSnapshot: low above high');
      return q.start !== undefined ? out.slice(0, limit) : out.slice(-limit);
    },
  };
}

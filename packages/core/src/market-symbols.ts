/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/market-symbols.ts
 * Module           : core
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

// Registry asset <-> market symbol. Pure, no clock, no network.
//
// A MARKET SYMBOL is what the exchanges quote against USD (`BTC`, `ETH`, `LINK`…): candles, strategies and the signer's price
// view speak market symbols. A REGISTRY ASSET is one token contract (or the native coin) on one network. Several registry
// assets can be the same economic asset as one market symbol: native ETH and WETH are both `ETH`; WBTC, cbBTC, tBTC and
// BTCB are all `BTC` — each a distinct tradable asset with its OWN ISSUER. An agent picks ONE representation per symbol.
//
// ISSUER RISK, stated once: a wrapped or pegged asset can lose its peg to what it tracks (custodian failure, bridge
// exploit, redemption halt). The signer prices every asset at the UNDERLYING's exchange price, so after a depeg the swap's
// guaranteed output is no longer worth what the mandate requires and the signer refuses the order — it fails closed, in
// both directions: the agent stops buying the wrapped asset and can no longer sell it below the underlying's value either
// (the owner then withdraws it to the main wallet and deals with it by hand).
//
// Nothing here lists tokens: the tradable set is derived from the registry (networks.ts / tokens.ts) at run time, through
//   1. ASSET_TRACKS  — a small REVIEWED table keyed by registry symbol, for assets that are another symbol's wrapper;
//                      it tolerates symbols the registry does not hold yet;
//   2. identity      — any other registry asset is its own market symbol (LINK is `LINK`);
//   3. MARKET_LISTINGS — the build-time table of USD listings; a symbol without two exchanges has no market data.
import { MARKET_LISTINGS, type MarketListing } from './market-listings.ts';
import type { AssetDef, NetworkDef } from './networks.ts';

/** Cash legs, in order of preference. They are never universe symbols. */
export const CASH_SYMBOLS: readonly string[] = ['USDC', 'USDT'];
export const MAX_AGENT_SYMBOLS = 12;

export interface TrackDef {
  /** the market symbol this registry asset is economically the same as */
  tracks: string;
  kind: 'wrapped' | 'pegged';
  /** who must stay solvent and honest for one unit to stay worth one unit of `tracks` */
  issuer: string;
  /** default preference among the representations of one symbol on one network: lowest first (reviewed: deepest on-chain liquidity first) */
  rank: number;
}
/**
 * REVIEWED 2026-11-10. Only 1:1 redeemable wrappers and fiat-backed pegs. Deliberately absent: liquid-staking and
 * yield-bearing tokens (wstETH, cbETH, rETH, weETH, sUSDe, sDAI…): their price drifts away from the underlying by design,
 * so they are NOT the same economic asset and must never be priced as it.
 */
export const ASSET_TRACKS: Record<string, TrackDef> = {
  WETH: { tracks: 'ETH', kind: 'wrapped', issuer: 'the WETH deposit contract of the network (no custodian; canonical bridge on a layer 2)', rank: 1 },
  WBTC: { tracks: 'BTC', kind: 'wrapped', issuer: 'BitGo / BiT Global (custodians of the bitcoin)', rank: 1 },
  cbBTC: { tracks: 'BTC', kind: 'wrapped', issuer: 'Coinbase (custodian of the bitcoin)', rank: 2 },
  tBTC: { tracks: 'BTC', kind: 'wrapped', issuer: 'Threshold Network (signer set holding the bitcoin)', rank: 3 },
  BTCB: { tracks: 'BTC', kind: 'wrapped', issuer: 'Binance (custodian of the bitcoin)', rank: 4 },
  cbXRP: { tracks: 'XRP', kind: 'wrapped', issuer: 'Coinbase (custodian of the XRP)', rank: 1 },
  cbDOGE: { tracks: 'DOGE', kind: 'wrapped', issuer: 'Coinbase (custodian of the DOGE)', rank: 1 },
  cbADA: { tracks: 'ADA', kind: 'wrapped', issuer: 'Coinbase (custodian of the ADA)', rank: 1 },
  cbLTC: { tracks: 'LTC', kind: 'wrapped', issuer: 'Coinbase (custodian of the LTC)', rank: 1 },
  WBNB: { tracks: 'BNB', kind: 'wrapped', issuer: 'the WBNB deposit contract (no custodian)', rank: 1 },
  WAVAX: { tracks: 'AVAX', kind: 'wrapped', issuer: 'the WAVAX deposit contract (no custodian)', rank: 1 },
  WPOL: { tracks: 'POL', kind: 'wrapped', issuer: 'the WPOL deposit contract (no custodian)', rank: 1 },
  WHYPE: { tracks: 'HYPE', kind: 'wrapped', issuer: 'the WHYPE deposit contract (no custodian)', rank: 1 },
  EURC: { tracks: 'EUR', kind: 'pegged', issuer: 'Circle (euro reserves)', rank: 1 },
};

export type Listings = Record<string, MarketListing>;
export type SourceName = 'coinbase' | 'bitstamp' | 'kraken';
const SOURCES: readonly SourceName[] = ['coinbase', 'bitstamp', 'kraken'];
export const listingSources = (symbol: string, listings: Listings = MARKET_LISTINGS): SourceName[] => { const l = Object.hasOwn(listings, symbol) ? listings[symbol]! : {}; return SOURCES.filter((s) => typeof l[s] === 'string'); };
/** Market data exists when two exchanges list the symbol. */
export const hasMarketData = (symbol: string, listings: Listings = MARKET_LISTINGS): boolean => listingSources(symbol, listings).length >= 2;
/** The signer prices a symbol only from Coinbase AND Kraken together: without both, no delegated order can ever be signed. */
export const hasSignerPrice = (symbol: string, listings: Listings = MARKET_LISTINGS): boolean => { const s = listingSources(symbol, listings); return s.includes('coinbase') && s.includes('kraken'); };

export interface Representation {
  /** registry id: 'native' or the token address */
  id: string;
  /** the registry asset's own ticker and name (what the owner sees: "cbBTC — Coinbase Wrapped BTC") */
  assetSymbol: string; name: string; decimals: number;
  kind: 'native' | 'token' | 'wrapped' | 'pegged';
  /** null for the native coin and for the asset itself */
  issuer: string | null;
  rank: number;
}
export interface TradableSymbol {
  symbol: string;
  /** exchanges listing it against USD (at least two) */
  sources: SourceName[];
  /** false = paper trading only: the signer could never price it (it needs Coinbase and Kraken) */
  live: boolean;
  representations: Representation[];
  /** the representation chosen when the owner does not choose; null = ambiguous, an explicit choice is required */
  defaultId: string | null;
}

const isCash = (symbol: string) => CASH_SYMBOLS.includes(symbol);
/** The market symbol a registry asset is priced as; null for a cash leg. Says nothing about market data. */
export function marketSymbolOf(a: Pick<AssetDef, 'id' | 'symbol'>): string | null {
  if (isCash(a.symbol)) return null;
  const t = Object.hasOwn(ASSET_TRACKS, a.symbol) ? ASSET_TRACKS[a.symbol]! : null;
  if (t && a.id === 'native') throw new Error(`${a.symbol} is a native coin and is also listed as a wrapper of ${t.tracks}: ambiguous, refused`);
  return t ? t.tracks : a.symbol;
}
function representation(a: AssetDef): Representation {
  const t = Object.hasOwn(ASSET_TRACKS, a.symbol) ? ASSET_TRACKS[a.symbol]! : null;
  if (a.id === 'native') return { id: a.id, assetSymbol: a.symbol, name: a.name, decimals: a.decimals, kind: 'native', issuer: null, rank: -1 };
  if (!t) return { id: a.id, assetSymbol: a.symbol, name: a.name, decimals: a.decimals, kind: 'token', issuer: null, rank: 0 };
  return { id: a.id, assetSymbol: a.symbol, name: a.name, decimals: a.decimals, kind: t.kind, issuer: t.issuer, rank: t.rank };
}

/**
 * Every market symbol tradable on a network: registry assets grouped by the symbol they track, kept when the symbol has
 * market data. DEFAULT REPRESENTATION, in this order: the native coin; else the token that IS the symbol; else the wrapper
 * with the lowest reviewed rank. Two candidates at the winning level (two registry tokens with one ticker, equal ranks)
 * give no default: the choice must be explicit.
 */
export function tradableSymbols(n: NetworkDef, listings: Listings = MARKET_LISTINGS): TradableSymbol[] {
  const by = new Map<string, Representation[]>();
  for (const a of [n.native, ...n.tokens]) {
    const s = marketSymbolOf(a);
    if (s === null || !hasMarketData(s, listings)) continue;
    by.set(s, [...(by.get(s) ?? []), representation(a)]);
  }
  return [...by.entries()].map(([symbol, reps]) => {
    const representations = [...reps].sort((x, y) => x.rank - y.rank || x.assetSymbol.localeCompare(y.assetSymbol) || x.id.localeCompare(y.id));
    const best = representations.filter((r) => r.rank === representations[0]!.rank);
    return { symbol, sources: listingSources(symbol, listings), live: hasSignerPrice(symbol, listings), representations, defaultId: best.length === 1 ? best[0]!.id : null };
  }).sort((x, y) => x.symbol.localeCompare(y.symbol));
}

/** Cash legs available on a network, preferred first. */
export function cashLegs(n: NetworkDef): { id: string; symbol: string; name: string; decimals: number }[] {
  return CASH_SYMBOLS.flatMap((s) => { const found = n.tokens.filter((t) => t.symbol === s); return found.length === 1 ? [{ id: found[0]!.id, symbol: s, name: found[0]!.name, decimals: found[0]!.decimals }] : []; });
}

export interface AgentAsset { /** market symbol, or the cash symbol for the cash leg */ symbol: string; id: string; decimals: number; assetSymbol: string; name: string; kind: Representation['kind'] | 'cash'; issuer: string | null }
export interface AgentAssets { cash: AgentAsset; assets: AgentAsset[] }
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Resolve an agent's universe on its network: the cash leg (USDC unless the owner chose USDT; USDT must be chosen
 * explicitly where USDC does not exist) and exactly one registry asset per market symbol. Throws on anything unknown,
 * duplicated, without market data, ambiguous, or chosen wrongly.
 */
export function resolveAgentAssets(n: NetworkDef, universe: readonly string[], o: { cash?: string | null; assets?: Record<string, string> | null } = {}, listings: Listings = MARKET_LISTINGS): AgentAssets {
  if (n.family !== 'evm') throw new Error(`agents do not trade on ${n.name}`);
  const legs = cashLegs(n), want = o.cash ?? 'USDC';
  if (!isCash(want)) throw new Error(`${want} cannot be a cash leg (allowed: ${CASH_SYMBOLS.join(', ')})`);
  const leg = legs.find((l) => l.symbol === want);
  if (!leg) throw new Error(legs.length ? `${want} is not in the wallet registry on ${n.name}; choose ${legs.map((l) => l.symbol).join(' or ')} as the cash leg` : `no cash leg (${CASH_SYMBOLS.join(', ')}) in the wallet registry on ${n.name} yet`);
  if (universe.length < 1 || universe.length > MAX_AGENT_SYMBOLS) throw new Error(`an agent trades between 1 and ${MAX_AGENT_SYMBOLS} symbols`);
  if (new Set(universe).size !== universe.length) throw new Error('duplicate symbol in the universe');
  const chosen = o.assets ?? {};
  for (const k of Object.keys(chosen)) if (!universe.includes(k)) throw new Error(`a representation is chosen for ${k}, which is not in the universe`);
  const table = tradableSymbols(n, listings);
  const assets = universe.map((symbol): AgentAsset => {
    if (isCash(symbol)) throw new Error(`${symbol} is a cash leg, not a tradable symbol`);
    const t = table.find((x) => x.symbol === symbol);
    if (!t) throw new Error(hasMarketData(symbol, listings) ? `no asset of the wallet registry tracks ${symbol} on ${n.name}` : `${symbol} has no market data (it needs a USD pair on two exchanges)`);
    const pickId = Object.hasOwn(chosen, symbol) ? chosen[symbol]! : t.defaultId;
    if (pickId === null) throw new Error(`${symbol} has several representations on ${n.name} (${t.representations.map((r) => r.assetSymbol).join(', ')}) and no default: choose one`);
    const r = t.representations.find((x) => sameId(x.id, pickId));
    if (!r) throw new Error(`the asset chosen for ${symbol} does not track it on ${n.name}`);
    return { symbol, id: r.id, decimals: r.decimals, assetSymbol: r.assetSymbol, name: r.name, kind: r.kind, issuer: r.issuer };
  });
  return { cash: { symbol: leg.symbol, id: leg.id, decimals: leg.decimals, assetSymbol: leg.symbol, name: leg.name, kind: 'cash', issuer: null }, assets };
}

/**
 * The symbol whose exchange price values one registry asset, for the signer's price check: the UNDERLYING for a wrapper
 * (so a depeg makes the check fail), the asset's own ticker otherwise, the cash symbol for a cash leg.
 */
export function priceSymbolOf(a: Pick<AssetDef, 'id' | 'symbol'>): { symbol: string; cash: boolean } {
  const s = marketSymbolOf(a);
  return s === null ? { symbol: a.symbol, cash: true } : { symbol: s, cash: false };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/prices/cross.ts
 * Module           : prices
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
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

// Two price sources, one rule (V11 — docs/V11-MARKET-DATA-SOURCES.md). Pure: no clock of its own, no network.
//
// Until now CoinGecko's free tier was the ONLY price of the portfolio (docs/V11-AUDIT.md §8). With `APIBRICKS_API_KEY` set a
// second source answers for the symbols that map onto it with certainty (apibricks/asset-map.ts). The rule:
//
//   • every price says where it comes from: `source`, and `sources` lists what EACH source said, with its own date;
//   • the displayed price stays the PRIMARY one (CoinGecko) whenever it has a price that is not stale;
//   • when the primary has no price for the symbol, or serves a stale one, and the second source has a price that is not
//     stale, the second one is displayed — `source: 'apibricks'`, `fallback: true` — never silently;
//   • when both have a price that is not stale and their dates are at most MAX_SKEW_MS apart, they are compared:
//     `divergenceBps` = |a − b| / mean × 10⁴, and `divergent` when it exceeds the threshold. NOTHING IS AVERAGED: the
//     displayed price is one source's, the other one is shown beside it. Prices too far apart in time are not compared
//     (`divergenceBps: null`): a quarter of an hour of market movement is not a disagreement between sources;
//   • a symbol the second source does not map has one source, exactly as before.
//
// Without the key, `second` is null and every price is the primary's with `source: 'coingecko'`: nothing else changes.

export type PriceSourceId = 'coingecko' | 'apibricks';
export interface SourcePrice { source: PriceSourceId; usd: number; cad: number | null; priceAt: string | null; stale: boolean }
export interface CrossFields {
  /** the source of the displayed `usd` / `cad` / `priceAt` */ source: PriceSourceId;
  /** true when the displayed price is the second source's because the primary had none or a stale one */ fallback: boolean;
  sources: SourcePrice[];
  divergent: boolean; divergenceBps: number | null;
}
export interface PrimaryLike { usd: number; cad: number; priceAt: string | null; stale: boolean }
export interface SecondLike { usd: number; cad: number | null; priceAt: string; stale: boolean }
export interface CrossOptions { thresholdBps: number; maxSkewMs?: number }

export const DEFAULT_DIVERGENCE_BPS = 100, MAX_SKEW_MS = 10 * 60_000;
export const divergenceBps = (a: number, b: number): number => (Math.abs(a - b) / ((a + b) / 2)) * 1e4;

/**
 * `blank(symbol, second)` builds the non-price fields of a symbol the primary has no row for (daily change, market cap…:
 * unknown, never invented). Returns null only when neither source has anything.
 */
export function crossCheck<M extends PrimaryLike>(primary: Record<string, M> | null, second: Record<string, SecondLike> | null, o: CrossOptions, blank: (symbol: string, s: SecondLike) => M | null): Record<string, M & CrossFields> | null {
  if (!primary && !second) return null;
  const out: Record<string, M & CrossFields> = {}, skew = o.maxSkewMs ?? MAX_SKEW_MS;
  for (const symbol of new Set([...Object.keys(primary ?? {}), ...Object.keys(second ?? {})])) {
    const p = primary && Object.hasOwn(primary, symbol) ? primary[symbol]! : null, s = second && Object.hasOwn(second, symbol) ? second[symbol]! : null;
    const sources: SourcePrice[] = [];
    if (p) sources.push({ source: 'coingecko', usd: p.usd, cad: p.cad, priceAt: p.priceAt, stale: p.stale });
    if (s) sources.push({ source: 'apibricks', usd: s.usd, cad: s.cad, priceAt: s.priceAt, stale: s.stale });
    let bps: number | null = null;
    if (p && s && !p.stale && !s.stale && p.priceAt) {
      const dt = Math.abs(Date.parse(p.priceAt) - Date.parse(s.priceAt));
      if (Number.isFinite(dt) && dt <= skew && p.usd > 0 && s.usd > 0) bps = Math.round(divergenceBps(p.usd, s.usd) * 10) / 10;
    }
    const cross = { sources, divergenceBps: bps, divergent: bps !== null && bps > o.thresholdBps };
    const useSecond = s !== null && !s.stale && s.cad !== null && (p === null || p.stale);
    if (useSecond) {
      const base = p ?? blank(symbol, s!);
      if (!base) continue;
      out[symbol] = { ...base, usd: s!.usd, cad: s!.cad!, priceAt: s!.priceAt, stale: false, source: 'apibricks', fallback: true, ...cross };
    } else if (p) out[symbol] = { ...p, source: 'coingecko', fallback: false, ...cross };
    // the second source alone with a stale price (or no CAD rate) and no primary row: no price, as before
  }
  return Object.keys(out).length ? out : null;
}

/** what a whole price list says about its sources, for `/portfolio` and the Dashboard */
export function crossSummary(px: Record<string, CrossFields> | null, secondConfigured: boolean): { primary: PriceSourceId; second: PriceSourceId | null; fallback: string[]; divergent: string[]; compared: number; maxDivergenceBps: number | null } {
  const rows = Object.entries(px ?? {});
  const bps = rows.map(([, m]) => m.divergenceBps).filter((x): x is number => x !== null);
  return { primary: 'coingecko', second: secondConfigured ? 'apibricks' : null, fallback: rows.filter(([, m]) => m.fallback).map(([s]) => s).sort(), divergent: rows.filter(([, m]) => m.divergent).map(([s]) => s).sort(),
    compared: bps.length, maxDivergenceBps: bps.length ? Math.max(...bps) : null };
}

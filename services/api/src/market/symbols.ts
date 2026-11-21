/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/market/symbols.ts
 * Module           : market
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-11
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

// Which symbols the market data engine ingests. Nothing is listed by hand: the set is derived from the token registry —
// every market symbol that a registry asset tracks on a network where swap execution is enabled, and that two of the
// three exchanges list against USD (static table packages/core/src/market-listings.ts) — plus the base set of V3.
//
// Budget: a new symbol costs about 60 requests per source for two years of 1h bars (Coinbase, 298 bars per call), about
// 12 for the daily history, and one request per interval and per source at each new bar; Kraken calls are 3 s apart, so
// N symbols take 3·N seconds of Kraken time at the top of each hour. Hence:
//   - SPW_MARKET_MAX_SYMBOLS (default 40) bounds the set; symbols an agent trades are never left out and come first;
//   - SPW_MARKET_SYMBOLS=BTC,ETH,… replaces the base and registry-derived part with an explicit list (agents' symbols still added);
//   - 5-minute bars are ingested for the base set only (SPW_MARKET_5M_SYMBOLS to change): no agent decides on 5m.
import { getNetwork, hasMarketData, KYBER_ENABLED, tradableSymbols } from '@spw/core';
import { sql } from '../db.ts';
import { marketConfig, type MarketConfig } from './pipeline.ts';
import { SYMBOLS } from './types.ts';

/** Market symbols tradable on at least one execution-enabled network, most widely available first. */
export function registrySymbols(networks: readonly string[] = Object.keys(KYBER_ENABLED)): string[] {
  const count = new Map<string, number>();
  for (const id of networks) for (const t of tradableSymbols(getNetwork(id))) count.set(t.symbol, (count.get(t.symbol) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

const list = (v: string | undefined): string[] | null => (v === undefined || v.trim() === '' ? null : [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]);
export interface SymbolSet { symbols: string[]; first: string[]; fiveMinute: string[]; dropped: string[] }
/** Order: symbols used by an agent, the base set, then the registry-derived ones; cut at the size limit (never an agent's symbol). */
export function configuredSymbols(agentSymbols: readonly string[] = [], env: Record<string, string | undefined> = process.env, registry: readonly string[] = registrySymbols()): SymbolSet {
  const first = [...new Set(agentSymbols)].filter((s) => hasMarketData(s));
  const explicit = list(env.SPW_MARKET_SYMBOLS);
  const rest = (explicit ?? [...SYMBOLS, ...registry]).filter((s) => hasMarketData(s));
  const max = Math.max(1, Math.floor(Number(env.SPW_MARKET_MAX_SYMBOLS ?? 40)) || 40);
  const ordered = [...new Set([...first, ...rest])];
  const symbols = ordered.filter((s, k) => k < max || first.includes(s));
  const five = (list(env.SPW_MARKET_5M_SYMBOLS) ?? [...SYMBOLS]).filter((s) => symbols.includes(s));
  return { symbols, first, fiveMinute: five, dropped: ordered.filter((s) => !symbols.includes(s)) };
}

/** The configuration in force now: the registry-derived set, with the symbols of every agent that is not stopped first. */
export async function activeMarketConfig(): Promise<MarketConfig> {
  let used: string[] = [];
  try { used = (await sql<{ universe: string[] }[]>`select universe from agents where state not in ('STOPPED', 'FAILED') and kind = 'spot'`).flatMap((r) => r.universe); } catch { /* no agents table yet: the default set */ }
  return marketConfig(used);
}

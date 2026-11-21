/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/apibricks/index.ts
 * Module           : apibricks
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

// API Bricks (CoinAPI) market data — the optional, keyed SECOND source of the wallet (V11). READ-ONLY.
//
//   apiBricks()         the provider of this process, built once from config.apibricks; null without APIBRICKS_API_KEY
//   apiBricksStatus()   what the monitor and /stream/stats show: configured or `needsKey`, the budget counter, the last error
//
// What it feeds (docs/V11-MARKET-DATA-SOURCES.md):
//   a. prices.ts          the second price list of the portfolio (cross-check, failover) — prices/cross.ts holds the rule
//   b. market-source.ts   an additional CONFIRMING source of the market module (one independent exchange per symbol)
//   c. second             the metered spot source of the quote hub (symbols Coinbase does not stream)
// What it never feeds: the signer (its price check must not depend on a keyed third party — services/isolated-signer is
// untouched), an order, a transaction, a risk decision by itself.
import { config } from '../config.ts';
import { SYMBOLS, type MarketSource } from '../market/types.ts';
import { addConfirmingSource } from '../market/quality.ts';
import { registerMarketSource } from '../market/sources.ts';
import type { SecondSpotSource } from '../quotes/upstreams.ts';
import { ASSET_MAP, MARKET_PAIRS } from './asset-map.ts';
import { createBudget, type Budget, type BudgetSnapshot, type BudgetStore } from './budget.ts';
import { APIBRICKS_HOST, createApiBricksClient, type ApiBricksClient, type ApiBricksFetch, type ApiBricksStats } from './client.ts';
import { apiBricksMarketSource } from './market-source.ts';
import { createApiBricksPrices, type ApiBricksPrices } from './prices.ts';

export interface ApiBricksConfig {
  key: string; dailyCredits: number; marketDailyCredits: number; quoteDailyCredits: number; priceTtlMs: number; failoverTtlMs: number;
  divergenceBps: number; quotePollMs: number; marketIntervals: readonly ('1d' | '1h' | '5m')[]; marketSymbols: readonly string[]; marketHistoryBars: number;
}
export interface ApiBricks {
  readonly cfg: Omit<ApiBricksConfig, 'key'>;
  readonly client: ApiBricksClient; readonly budget: Budget; readonly prices: ApiBricksPrices;
  /** null when the market source is switched off (APIBRICKS_MARKET_INTERVALS=off) or no configured symbol has an independent series */
  readonly market: MarketSource | null;
  readonly second: SecondSpotSource;
  status(): ApiBricksStatus;
}
export type ApiBricksStatus =
  | { provider: 'apibricks'; configured: false; needsKey: true; missing: ['APIBRICKS_API_KEY'] }
  | { provider: 'apibricks'; configured: true; needsKey: false; host: string; status: 'ok' | 'idle' | 'degraded' | 'down'; reason: string | null;
      budget: BudgetSnapshot; calls: ApiBricksStats; prices: ReturnType<ApiBricksPrices['status']> & { mapped: number };
      market: { on: boolean; symbols: string[]; intervals: readonly string[]; historyBars: number } };

export const QUOTE_SOURCE = 'apibricks-rest';

export function createApiBricks(cfg: ApiBricksConfig, deps: { fetch?: ApiBricksFetch; now?: () => number; store?: BudgetStore } = {}): ApiBricks | null {
  if (!cfg.key) return null;
  const now = deps.now ?? Date.now;
  const budget = createBudget({ dailyCredits: cfg.dailyCredits, caps: { market: cfg.marketDailyCredits, quotes: cfg.quoteDailyCredits }, now, ...(deps.store ? { store: deps.store } : {}) });
  const client = createApiBricksClient({ key: cfg.key, budget, now, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const prices = createApiBricksPrices({ client, now, ttlMs: cfg.priceTtlMs });
  const symbols = (cfg.marketSymbols.length ? cfg.marketSymbols : SYMBOLS).filter((s) => Object.hasOwn(MARKET_PAIRS, s));
  const market = cfg.marketIntervals.length && symbols.length && cfg.marketDailyCredits > 0
    ? apiBricksMarketSource({ client, symbols, intervals: cfg.marketIntervals, historyBars: cfg.marketHistoryBars, now }) : null;
  const second: SecondSpotSource = {
    source: QUOTE_SOURCE, pollMs: cfg.quotePollMs, staleAfterMs: Math.max(15 * 60_000, 3 * cfg.quotePollMs),
    available: (symbol) => Object.hasOwn(ASSET_MAP, symbol) && budget.has('quotes'),
    async read() {
      const before = prices.status().fetchedAt;
      const r = await prices.read({ maxAgeMs: cfg.quotePollMs, consumer: 'quotes' });
      const st = prices.status();
      // a refresh was due and did not happen: say why (quota first), instead of serving the old list as if it were the feed
      if (st.lastErrorKind !== null && (st.fetchedAt === before) && (st.fetchedAt === null || now() - st.fetchedAt >= cfg.quotePollMs))
        return { down: true, reason: st.lastErrorKind === 'quota' ? 'quota' : st.lastErrorKind, detail: st.lastError ?? 'failed' };
      if (!r) return { down: true, reason: 'no_data', detail: 'the provider gave no rate' };
      return { prices: r.prices };
    },
    stats: () => ({ budget: budget.snapshot() }),
  };
  const { key: _key, ...shown } = cfg;
  void _key;
  return {
    cfg: shown, client, budget, prices, market, second,
    status() {
      const b = budget.snapshot(), c = client.stats(), p = prices.status();
      const quota = b.exhausted || c.lastErrorKind === 'quota' && c.lastErrorAt !== null && (c.lastOkAt === null || c.lastErrorAt > c.lastOkAt);
      const failing = c.lastErrorAt !== null && (c.lastOkAt === null || c.lastErrorAt > c.lastOkAt);
      return { provider: 'apibricks', configured: true, needsKey: false, host: APIBRICKS_HOST,
        status: quota ? 'down' : failing ? (c.lastErrorKind === 'auth' ? 'down' : 'degraded') : c.calls === 0 ? 'idle' : 'ok',
        reason: quota ? 'quota' : failing ? c.lastErrorKind : null,
        budget: b, calls: c, prices: { ...p, mapped: Object.keys(ASSET_MAP).length },
        market: { on: market !== null, symbols: market ? Object.keys(market.pairs) : [], intervals: market ? cfg.marketIntervals : [], historyBars: cfg.marketHistoryBars } };
    },
  };
}

let current: ApiBricks | null | undefined;
/** the provider of this process (null without the key). The first call registers the market source and its rank (last). */
export function apiBricks(): ApiBricks | null {
  if (current !== undefined) return current;
  current = createApiBricks(config.apibricks, { store: settingsStore() });
  const built = current;
  if (built?.market) { registerMarketSource(() => built.market); addConfirmingSource('apibricks'); }
  return current;
}
export function apiBricksStatus(): ApiBricksStatus {
  return apiBricks()?.status() ?? { provider: 'apibricks', configured: false, needsKey: true, missing: ['APIBRICKS_API_KEY'] };
}

/** the day's count in the settings table, so that a restart does not start the ceiling again (imported lazily: db.ts needs a database) */
function settingsStore(): BudgetStore {
  const KEY = 'apibricksBudget';
  return {
    async load() { const { getSetting } = await import('../db.ts'); return getSetting(KEY, null); },
    async save(s) { const { setSetting } = await import('../db.ts'); await setSetting(KEY, s); },
  };
}

export { ASSET_MAP, MARKET_PAIRS } from './asset-map.ts';
export { redact } from './redact.ts';
export type { BudgetSnapshot } from './budget.ts';

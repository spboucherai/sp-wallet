/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/apibricks/prices.ts
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

// API Bricks (CoinAPI) — the wallet's SECOND price source: one batched read of the provider's exchange rates.
//
//   GET /v1/exchangerate/USD?invert=true&filter_asset_id=BTC;ETH;…;CAD      one credit whatever the number of assets (measured)
//   → { asset_id_base: "USD", rates: [{ time, asset_id_quote: "BTC", rate: 64641.24… }, …] }   rate = USD for one unit
//
// What the number is (provider's specification): "Spot rates as a twenty-four hour rolling VWAP across curated markets and
// pairs" — an aggregate over many exchanges, each rate with its own `time`. It is independent of CoinGecko as a computation
// and as an operator, NOT as raw data (both read the same large exchanges). It is a reference to cross-check and to fall
// back on; it is not a tradable quote and nothing may authorise a trade on it (docs/V11-MARKET-DATA-SOURCES.md).
//
// Only the symbols of the reviewed table (asset-map.ts) are asked for; CAD comes from the same answer (USD per CAD).
// Cached: `maxAgeMs` per call (the caller asks for a fresher read when the primary source is down); concurrent callers share
// one request; after a failure the last good answer is served, marked with its real date, and nothing is retried before
// RETRY_MS (a refused call must not burn the daily budget); an exhausted budget is not retried before the budget has room.
import type { BudgetConsumer } from './budget.ts';
import type { ApiBricksClient } from './client.ts';
import { ApiBricksError, parseApiTime } from './client.ts';
import { ASSET_MAP } from './asset-map.ts';

export interface SecondPrice { usd: number; cad: number | null; /** the provider's own time of this rate */ priceAt: string; stale: boolean }
export interface SecondPrices { prices: Record<string, SecondPrice>; fetchedAt: number }
export interface ApiBricksPrices {
  /** the last answer no older than `maxAgeMs`, else a new read; null when the provider gave nothing usable */
  read(o?: { maxAgeMs?: number; /** who pays for a refresh (default `prices`) */ consumer?: BudgetConsumer }): Promise<SecondPrices | null>;
  status(): { fetchedAt: number | null; lastError: string | null; lastErrorKind: string | null; symbols: number; reads: number };
}
export interface ApiBricksPricesOptions {
  client: ApiBricksClient; now?: () => number;
  /** default refresh window */ ttlMs?: number; /** a rate older than this is stale */ staleMs?: number; retryMs?: number;
  map?: Record<string, { assetId: string }>; consumer?: BudgetConsumer;
}

interface RatesBody { asset_id_base?: unknown; rates?: unknown }
export const DEFAULT_PRICE_TTL_MS = 30 * 60_000, DEFAULT_SECOND_STALE_MS = 15 * 60_000;

/** the provider's answer → USD price per provider asset id, with its time; rows that are not a positive finite rate with a UTC time are dropped */
export function parseRates(body: unknown): Map<string, { usd: number; at: number }> {
  const b = body as RatesBody | null, out = new Map<string, { usd: number; at: number }>();
  if (!b || b.asset_id_base !== 'USD' || !Array.isArray(b.rates)) throw new ApiBricksError('schema', 'unexpected exchange-rate answer');
  for (const r of b.rates as { time?: unknown; asset_id_quote?: unknown; rate?: unknown }[]) {
    const at = parseApiTime(r?.time);
    if (typeof r?.asset_id_quote === 'string' && typeof r.rate === 'number' && Number.isFinite(r.rate) && r.rate > 0 && Number.isFinite(at)) out.set(r.asset_id_quote, { usd: r.rate, at });
  }
  return out;
}

export function createApiBricksPrices(o: ApiBricksPricesOptions): ApiBricksPrices {
  const now = o.now ?? Date.now, ttl = o.ttlMs ?? DEFAULT_PRICE_TTL_MS, staleMs = o.staleMs ?? DEFAULT_SECOND_STALE_MS, RETRY_MS = o.retryMs ?? 60_000;
  const map = o.map ?? ASSET_MAP, ids = [...new Set(Object.values(map).map((m) => m.assetId))].sort();
  const path = `/v1/exchangerate/USD?invert=true&filter_asset_id=${[...ids, 'CAD'].join(';')}`;
  let last: { rates: Map<string, { usd: number; at: number }>; fetchedAt: number } | null = null, failedAt: number | null = null, inflight: Promise<void> | null = null;
  let lastError: string | null = null, lastErrorKind: string | null = null, reads = 0;

  const view = (): SecondPrices | null => {
    if (!last) return null;
    const t = now(), cad = last.rates.get('CAD'), prices: Record<string, SecondPrice> = {};
    for (const [symbol, m] of Object.entries(map)) {
      const r = last.rates.get(m.assetId);
      if (!r || r.at > t + 60_000) continue;                       // absent, or dated in the future: not trusted
      prices[symbol] = { usd: r.usd, cad: cad ? r.usd / cad.usd : null, priceAt: new Date(r.at).toISOString(), stale: t - r.at > staleMs };
    }
    return { prices, fetchedAt: last.fetchedAt };
  };
  const refresh = (consumer: BudgetConsumer): Promise<void> => (inflight ??= (async () => {
    try {
      const rates = parseRates(await o.client.get(path, { consumer }));
      last = { rates, fetchedAt: now() }; failedAt = null; lastError = null; lastErrorKind = null; reads += 1;
    } catch (e) {
      failedAt = now(); lastError = e instanceof Error ? o.client.scrub(e.message) : 'failed'; lastErrorKind = e instanceof ApiBricksError ? e.kind : 'error';
    } finally { inflight = null; }
  })());

  return {
    async read(q = {}) {
      if (ids.length === 0) return null;
      const maxAge = Math.min(q.maxAgeMs ?? ttl, ttl), t = now();
      const fresh = last !== null && t - last.fetchedAt < maxAge;
      const consumer = q.consumer ?? o.consumer ?? 'prices';
      const backingOff = failedAt !== null && (lastErrorKind === 'quota' ? !o.client.budget.has(consumer) : t - failedAt < RETRY_MS);
      if (!fresh && !backingOff) await refresh(consumer);
      return view();
    },
    status: () => ({ fetchedAt: last?.fetchedAt ?? null, lastError, lastErrorKind, symbols: Object.keys(map).length, reads }),
  };
}

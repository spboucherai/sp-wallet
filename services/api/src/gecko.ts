/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/gecko.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// CoinGecko reads (public coin ids only — never an address or a balance), with a cache, stale-on-error and — since v10 — a
// short retry after a failure.
//
// Before v10 the answer of a call was cached for its TTL whatever it was: on a process that had no earlier value, ONE refused
// request (the free tier answers 429 to a burst) was kept as "no price" for four minutes. Home then showed « Prix désactivés »
// and no daily change although prices were enabled, and concurrent requests each made their own call, which is what the free
// tier refuses. Now: concurrent callers share one request; a refused request is retried once after a pause; a failure is
// remembered for RETRY_MS only (the stale value, when there is one, is served meanwhile).
export type GeckoFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface GeckoOpts { now?: () => number; retryMs?: number; pauseMs?: number; base?: string }

/** v11: when the value served for a key was really fetched, and whether it is older than its TTL (served because a refresh failed). */
export interface GeckoMeta { fetchedAt: number | null; stale: boolean }
export interface Gecko { <T>(key: string, ttlMs: number, path: string): Promise<T | null>; meta(key: string, ttlMs: number): GeckoMeta }

export function createGecko(fetchJson: GeckoFetch, o: GeckoOpts = {}): Gecko {
  const now = o.now ?? Date.now, RETRY_MS = o.retryMs ?? 15_000, PAUSE_MS = o.pauseMs ?? 1200, BASE = o.base ?? 'https://api.coingecko.com/api/v3';
  const fresh = new Map<string, { at: number; v: unknown }>(), stale = new Map<string, unknown>(), fetchedAt = new Map<string, number>(), failedAt = new Map<string, number>(), inflight = new Map<string, Promise<unknown>>();
  async function gecko<T>(key: string, ttlMs: number, path: string): Promise<T | null> {
    const c = fresh.get(key);
    if (c && now() - c.at < ttlMs) return c.v as T;
    const f = failedAt.get(key);
    if (f !== undefined && now() - f < RETRY_MS) return (stale.get(key) as T | undefined) ?? null;
    const running = inflight.get(key);
    if (running) return running as Promise<T | null>;
    const once = async (): Promise<T> => {
      const r = await fetchJson(BASE + path, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as T;
    };
    const p = (async (): Promise<T | null> => {
      try {
        let j: T;
        try { j = await once(); } catch { await new Promise((r) => setTimeout(r, PAUSE_MS)); j = await once(); }
        stale.set(key, j); fresh.set(key, { at: now(), v: j }); fetchedAt.set(key, now()); failedAt.delete(key);
        return j;
      } catch { failedAt.set(key, now()); return (stale.get(key) as T | undefined) ?? null; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  // the time of the last SUCCESSFUL fetch: a stale-on-error value keeps the date it was fetched, it is never re-dated
  gecko.meta = (key: string, ttlMs: number): GeckoMeta => { const at = fetchedAt.get(key) ?? null; return { fetchedAt: at, stale: at === null || now() - at > ttlMs }; };
  return gecko;
}

/**
 * v11: the date of ONE price and whether it must be shown as stale. `lastUpdated` are the source's own update times for
 * that price (CoinGecko `last_updated`, one per currency list); without one, the time the list was fetched is used.
 * Stale = the list was served past its refresh window (a refresh failed), or the price itself is older than `staleMs`.
 * A date in the future (clock skew beyond a minute) is ignored rather than trusted.
 */
export function priceStamp(lastUpdated: (string | undefined)[], fetchedAt: number | null, servedStale: boolean, now: number, staleMs: number): { priceAt: string | null; stale: boolean } {
  const ts = lastUpdated.map((x) => (x ? Date.parse(x) : NaN)).filter((x) => Number.isFinite(x) && x <= now + 60_000);
  const at = ts.length ? Math.min(...ts) : fetchedAt;
  return { priceAt: at === null ? null : new Date(at).toISOString(), stale: servedStale || at === null || now - at > staleMs };
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/apibricks/client.ts
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

// API Bricks (CoinAPI Market Data REST) — the one place that talks to the provider. READ-ONLY market data: there is no
// trading endpoint here and none may be added (the provider also sells an order-routing API; the wallet does not use it).
//
// Facts, verified live on 2026-11-17 with the owner's key (docs/v11/research/apibricks.md):
//   host      https://rest.coinapi.io   — the ONLY host the key is ever sent to (a constant, not an option)
//   auth      header `X-CoinAPI-Key`    — never the query string, never the URL path
//   metering  `x-ratelimit-request-cost` on every 200 answer (1 for every call made, including a 77-asset rate list and a
//             24-bar OHLCV page asked with limit=100); no `X-Credits-*` header on this plan; `x-tierlimit-rpm-limit: 160`, concurrency 4
//   errors    JSON `{ "error": "…" }` — 401 bad or missing key, 400 unknown symbol, 550 "single item that we don't have",
//             429 too many requests (documented); an error answer carries no cost header: it is counted as one credit
//
// Every call is paid from the budget first (budget.ts): past the ceiling the client throws `quota` WITHOUT calling.
// Every message that leaves this module is redacted (redact.ts).
import type { Budget, BudgetConsumer } from './budget.ts';
import { redact, redactError } from './redact.ts';

export const APIBRICKS_HOST = 'rest.coinapi.io';
export const APIBRICKS_BASE = `https://${APIBRICKS_HOST}`;
export const APIBRICKS_KEY_HEADER = 'X-CoinAPI-Key';

export type ApiBricksErrorKind = 'quota' | 'rate_limited' | 'auth' | 'not_found' | 'http' | 'schema' | 'network';
export class ApiBricksError extends Error {
  constructor(readonly kind: ApiBricksErrorKind, message: string, readonly status: number | null = null) { super(`apibricks: ${message}`); this.name = 'ApiBricksError'; }
}

export type ApiBricksFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
export interface ApiBricksClientOptions { key: string; budget: Budget; fetch?: ApiBricksFetch; now?: () => number }
export interface ApiBricksStats {
  calls: number; ok: number; failed: number; refusedByBudget: number; credits: number;
  lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null; lastErrorKind: ApiBricksErrorKind | null;
  /** what the provider last said about its own per-minute limits (headers `x-tierlimit-*`) */ tier: { rpmLimit: number | null; rpmRemaining: number | null; concurrencyLimit: number | null };
}
export interface ApiBricksClient {
  /** GET `path` (starting with `/v1/`); `expectCredits` is what is reserved before the call (rows / 100, rounded up, for a paged read) */
  get<T = unknown>(path: string, o: { consumer: BudgetConsumer; expectCredits?: number }): Promise<T>;
  stats(): ApiBricksStats;
  readonly budget: Budget;
  /** `text` without the key (for a caller that builds its own message) */ scrub(text: string): string;
}

// the wallet's HTTP helper (timeout, one retry, no redirect), loaded when first used: it reads the server configuration
const defaultFetch: ApiBricksFetch = async (url, init) => (await import('../chains/rpc.ts')).http(url, init);
const int = (v: string | null): number | null => { const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };

export function createApiBricksClient(o: ApiBricksClientOptions): ApiBricksClient {
  if (!o.key) throw new Error('apibricks: no key');
  const now = o.now ?? Date.now, doFetch = o.fetch ?? defaultFetch, key = o.key;
  const st: ApiBricksStats = { calls: 0, ok: 0, failed: 0, refusedByBudget: 0, credits: 0, lastOkAt: null, lastError: null, lastErrorAt: null, lastErrorKind: null, tier: { rpmLimit: null, rpmRemaining: null, concurrencyLimit: null } };
  const fail = (kind: ApiBricksErrorKind, message: string, status: number | null = null): ApiBricksError => {
    const e = new ApiBricksError(kind, redact(message, key).slice(0, 240), status);
    st.failed += 1; st.lastError = e.message; st.lastErrorAt = now(); st.lastErrorKind = kind;
    return e;
  };
  return {
    budget: o.budget,
    scrub: (text) => redact(text, key),
    stats: () => ({ ...st, tier: { ...st.tier } }),
    async get<T>(path: string, q: { consumer: BudgetConsumer; expectCredits?: number }): Promise<T> {
      if (!path.startsWith('/v1/') || path.includes('://') || /apikey/i.test(path)) throw fail('http', `refused path ${path}`);
      const reserve = Math.max(1, Math.ceil(q.expectCredits ?? 1));
      if (!(await o.budget.reserve(q.consumer, reserve))) {
        st.refusedByBudget += 1;
        const b = o.budget.snapshot();
        throw fail('quota', `the daily budget is exhausted (${b.used} of ${b.ceiling} credits used on ${b.day}; resets at ${b.resetsAt}): not called`);
      }
      let r: Awaited<ReturnType<ApiBricksFetch>>;
      st.calls += 1;
      try { r = await doFetch(APIBRICKS_BASE + path, { headers: { accept: 'application/json', [APIBRICKS_KEY_HEADER]: key } }); }
      catch (e) { o.budget.refund(q.consumer, reserve); throw fail('network', redactError(e, key)); }
      st.tier = { rpmLimit: int(r.headers.get('x-tierlimit-rpm-limit')) ?? st.tier.rpmLimit, rpmRemaining: int(r.headers.get('x-tierlimit-rpm-remaining')), concurrencyLimit: int(r.headers.get('x-tierlimit-concurrency-limit')) ?? st.tier.concurrencyLimit };
      const cost = int(r.headers.get('x-ratelimit-request-cost'));
      if (cost !== null) o.budget.settle(q.consumer, cost - reserve);
      st.credits += cost ?? reserve;
      let text = '';
      try { text = await r.text(); } catch (e) { throw fail('network', redactError(e, key), r.status); }
      if (r.status !== 200) {
        let said = text.slice(0, 200);
        try { const j = JSON.parse(text) as { error?: unknown; message?: unknown }; said = String(j.error ?? j.message ?? said); } catch { /* not JSON */ }
        // the provider answers 429 both for its per-minute limit and for an exhausted quota; 403 "may" mean either access or quota
        const kind: ApiBricksErrorKind = r.status === 401 ? 'auth' : r.status === 403 ? (/quota|credit|limit|exceed/i.test(said) ? 'quota' : 'auth')
          : r.status === 429 ? (/quota|credit|daily|exceed/i.test(said) ? 'quota' : 'rate_limited') : r.status === 550 || (r.status === 400 && /not found/i.test(said)) ? 'not_found' : 'http';
        throw fail(kind, `http ${r.status} ${said}`, r.status);
      }
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw fail('schema', 'the answer is not JSON', 200); }
      st.ok += 1; st.lastOkAt = now();
      return body as T;
    },
  };
}

/** `2026-11-17T07:55:03.4000000Z` (seven fractional digits) → epoch milliseconds; NaN when it is not a UTC ISO time */
export function parseApiTime(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(s);
  if (!m) return NaN;
  return Date.parse(`${m[1]}.${(m[2] ?? '0').padEnd(3, '0').slice(0, 3)}Z`);
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/market/budget.ts
 * Module           : nft
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

// Rate-limit budgeter of the market providers: ONE per provider, asked before every outbound request. Two windows — the last
// minute (in memory) and the UTC day (in memory, and persisted through `persist` so that a restart does not reset the day).
// A request the budget refuses is never sent: the caller gets `budget_exhausted` and serves its cache (marked stale) or says
// "unavailable". The counters are visible (GET /api/v1/nfts/market/providers) so the owner sees how close each source is to
// the quota this server allows itself — which is set BELOW the provider's documented limit.
import { NftProviderError } from '@spw/nft';

export interface BudgetLimits { perMinute: number; perDay: number }
export interface BudgetCounter { provider: string; minute: { used: number; limit: number }; day: { used: number; limit: number; date: string }; refused: number; lastRefusedAt: string | null; /** the provider itself answered 429 */ upstreamLimited: number; lastUpstreamLimitedAt: string | null }

export function createBudget(provider: string, limits: BudgetLimits, deps: { now: () => Date; /** called after each granted request (best effort; a failure to persist never blocks a read) */ persist?: (provider: string, day: string, used: number) => void; /** the day's count already stored (restart) */ restored?: { day: string; used: number } | null }) {
  let stamps: number[] = [], day = deps.restored?.day ?? '', used = deps.restored?.used ?? 0, refused = 0, lastRefusedAt: string | null = null, upstreamLimited = 0, lastUpstreamLimitedAt: string | null = null, pausedUntil = 0;
  const roll = (now: Date) => { const d = now.toISOString().slice(0, 10); if (d !== day) { day = d; used = 0; } const t = now.getTime(); stamps = stamps.filter((s) => t - s < 60_000); };
  return {
    provider, limits,
    /** Take one request from the budget, or throw `budget_exhausted` (detail: which window). */
    take(): void {
      const now = deps.now(); roll(now);
      const why = now.getTime() < pausedUntil ? 'upstream_backoff' : stamps.length >= limits.perMinute ? 'per_minute' : used >= limits.perDay ? 'per_day' : null;
      if (why) { refused += 1; lastRefusedAt = now.toISOString(); throw new NftProviderError('budget_exhausted', provider, why); }
      stamps.push(now.getTime()); used += 1;
      try { deps.persist?.(provider, day, used); } catch { /* the in-memory count stands */ }
    },
    /** The provider answered 429: stop asking for `ms` (default one minute) whatever the local windows say. */
    upstreamLimit(ms = 60_000): void { const now = deps.now(); upstreamLimited += 1; lastUpstreamLimitedAt = now.toISOString(); pausedUntil = Math.max(pausedUntil, now.getTime() + ms); },
    /** the day's count a previous process persisted (a restart must not reset the day) */
    restore(d: string, n: number): void { roll(deps.now()); if (d === day && n > used) used = n; },
    counter(): BudgetCounter { const now = deps.now(); roll(now); return { provider, minute: { used: stamps.length, limit: limits.perMinute }, day: { used, limit: limits.perDay, date: day }, refused, lastRefusedAt, upstreamLimited, lastUpstreamLimitedAt }; },
  };
}
export type Budget = ReturnType<typeof createBudget>;

/**
 * The one way a market adapter talks to its provider: budget first, then the request with a deadline and no redirect, then a
 * stable error code. The body of a failed answer is never read into an error; `secretHeaders` are sent and never echoed.
 */
export async function providerGet(o: { provider: string; budget: Budget; http: (url: string, init?: RequestInit) => Promise<Response>; url: string; headers?: Record<string, string>; timeoutMs?: number; /** statuses that mean "the provider does not know this object" */ notFound?: number[]; maxBytes?: number }): Promise<unknown> {
  o.budget.take();
  let r: Response;
  try { r = await o.http(o.url, { headers: { accept: 'application/json', 'user-agent': 'sp-wallet-nft/1', ...(o.headers ?? {}) }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), redirect: 'error' }); }
  catch { throw new NftProviderError('provider_unavailable', o.provider); }
  if (r.status === 429) { o.budget.upstreamLimit(); throw new NftProviderError('provider_rate_limited', o.provider); }
  if (r.status === 401 || r.status === 403) throw new NftProviderError('provider_not_configured', o.provider, `http_${r.status}`); // a key refused or missing: never retried blindly
  if ((o.notFound ?? [404]).includes(r.status)) throw new NftProviderError('not_found', o.provider);
  if (!r.ok) throw new NftProviderError('provider_unavailable', o.provider, `http_${r.status}`);
  let text: string;
  try { text = await r.text(); } catch { throw new NftProviderError('provider_unavailable', o.provider); }
  if (text.length > (o.maxBytes ?? 2_000_000)) throw new NftProviderError('provider_bad_answer', o.provider, 'too_large');
  try { return JSON.parse(text) as unknown; } catch { throw new NftProviderError('provider_bad_answer', o.provider, 'not_json'); }
}

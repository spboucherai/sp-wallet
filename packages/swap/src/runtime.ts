/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/src/runtime.ts
 * Module           : swap
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// Provider runtime: per-provider deadline, circuit breaker, token-bucket rate limit and latency statistics.
import { ProviderError, type HttpClient, type ProviderContext, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from './types.ts';

export interface ProviderPolicy { timeoutMs: number; ratePerSec: number; burst: number; breakerFailures: number; breakerCooldownMs: number }
export const DEFAULT_POLICY: ProviderPolicy = { timeoutMs: 2500, ratePerSec: 2, burst: 4, breakerFailures: 4, breakerCooldownMs: 30_000 };

export interface ProviderStats {
  id: string; enabled: boolean; state: 'closed' | 'open' | 'half_open';
  calls: number; failures: number; timeouts: number; lastError: string | null; lastOkAt: number | null;
  p50: number | null; p95: number | null; p99: number | null;
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : null);

export class ProviderRuntime {
  private lat: number[] = []; private calls = 0; private failures = 0; private timeouts = 0; private consecutive = 0;
  private openedAt = 0; private lastError: string | null = null; private lastOkAt: number | null = null;
  private tokens: number; private refilledAt: number;
  enabled = true;
  constructor(readonly provider: SwapProvider, readonly policy: ProviderPolicy, private http: HttpClient, private now: () => number = Date.now) {
    this.tokens = policy.burst; this.refilledAt = now();
  }
  private state(): 'closed' | 'open' | 'half_open' {
    if (this.consecutive < this.policy.breakerFailures) return 'closed';
    return this.now() - this.openedAt >= this.policy.breakerCooldownMs ? 'half_open' : 'open';
  }
  private take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.policy.burst, this.tokens + ((t - this.refilledAt) / 1000) * this.policy.ratePerSec); this.refilledAt = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
  /** Quote with the provider's own deadline. Never throws anything but ProviderError. */
  async quote(req: SwapQuoteRequest, outer?: AbortSignal, /** v11: a caller that can wait longer (plan pricing) — the rate limit and the breaker stay the shared ones */ timeoutMs?: number): Promise<SwapQuote[]> {
    const id = this.provider.id;
    if (!this.enabled) throw new ProviderError(id, 'unavailable', 'provider disabled');
    if (this.state() === 'open') throw new ProviderError(id, 'unavailable', 'circuit open after repeated failures');
    if (!this.take()) throw new ProviderError(id, 'rate_limited', 'local rate limit');
    const started = this.now(); this.calls += 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs ?? this.policy.timeoutMs);
    const onOuter = () => ac.abort(); outer?.addEventListener('abort', onOuter, { once: true });
    const ctx: ProviderContext = { signal: ac.signal, http: this.http, now: this.now };
    try {
      const quotes = await this.provider.quote(req, ctx);
      this.lat.push(this.now() - started); if (this.lat.length > 500) this.lat.shift();
      this.consecutive = 0; this.lastOkAt = this.now();
      return quotes;
    } catch (e) {
      // a caller that gave up (outer abort) says nothing about the provider's health
      if (outer?.aborted) throw new ProviderError(id, 'timeout', 'request cancelled by caller');
      this.failures += 1; this.consecutive += 1; if (this.consecutive === this.policy.breakerFailures) this.openedAt = this.now();
      const timedOut = ac.signal.aborted; if (timedOut) this.timeouts += 1;
      const err = e instanceof ProviderError ? e : new ProviderError(id, timedOut ? 'timeout' : 'bad_response', (e as Error).message?.slice(0, 200) ?? 'error');
      if (timedOut && err.code !== 'timeout') err.code = 'timeout';
      this.lastError = `${err.code}: ${err.message}`;
      if (this.state() === 'half_open') this.openedAt = this.now(); // failed probe: stay open for another cooldown
      throw err;
    } finally { clearTimeout(timer); outer?.removeEventListener('abort', onOuter); }
  }
  stats(): ProviderStats {
    const s = [...this.lat].sort((a, b) => a - b);
    return { id: this.provider.id, enabled: this.enabled, state: this.state(), calls: this.calls, failures: this.failures, timeouts: this.timeouts,
      lastError: this.lastError, lastOkAt: this.lastOkAt, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99) };
  }
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/test/helpers.ts
 * Module           : trading-sdk
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

// Mocked transport for the unit tests: a `fetch` that records every call and answers from a script.
import { SPWallet, type SPWalletOptions } from '../src/index.ts';

export const KEY = 'spw_live_spk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
export interface Call { method: string; url: URL; path: string; headers: Record<string, string>; body: string | undefined }
export type Step = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | { throw: unknown } | { hang: true };
export const ok = (json: unknown, headers: Record<string, string> = {}): Step => ({ status: 200, json, headers });
export const fail = (status: number, error: string, message = 'refused', extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Step => ({ status, json: { error, message, ...extra }, headers });

export function mock(steps: Step[] | ((c: Call, n: number) => Step), o: SPWalletOptions = {}) {
  const calls: Call[] = [], sleeps: number[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { method: init.method ?? 'GET', url, path: url.pathname, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: init.body as string | undefined };
    const n = calls.push(call) - 1;
    const step = typeof steps === 'function' ? steps(call, n) : steps[Math.min(n, steps.length - 1)]!;
    if ('throw' in step) throw step.throw;
    if ('hang' in step) return new Promise<Response>((_, rej) => { init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); });
    return new Response(step.text ?? (step.json === undefined ? '' : JSON.stringify(step.json)), { status: step.status, headers: { 'content-type': 'application/json', 'x-request-id': `req-${n + 1}`, ...step.headers } });
  }) as typeof fetch;
  const client = new SPWallet({ apiKey: KEY, baseUrl: 'https://wallet.test', fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...o });
  return { client, calls, sleeps };
}

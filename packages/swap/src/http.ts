/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/src/http.ts
 * Module           : swap
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

import { ProviderError, type HttpClient } from './types.ts';

/** Keep-alive JSON client (Node's fetch pools connections per origin). Refuses redirects and oversized or non-JSON answers. */
export function httpClient(provider: string, fetchImpl: typeof fetch = fetch, maxBytes = 2_000_000): HttpClient {
  const run = async (url: string, init: RequestInit): Promise<unknown> => {
    let r: Response;
    try { r = await fetchImpl(url, { ...init, redirect: 'error' }); }
    catch (e) { throw new ProviderError(provider, (e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError' ? 'timeout' : 'unavailable', (e as Error).message?.slice(0, 160) ?? 'network error'); }
    if (r.status === 429) throw new ProviderError(provider, 'rate_limited', 'provider rate limit (429)');
    const text = await r.text();
    if (text.length > maxBytes) throw new ProviderError(provider, 'bad_response', 'response too large');
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { throw new ProviderError(provider, 'bad_response', `non-JSON answer (HTTP ${r.status})`); }
    if (!r.ok) throw Object.assign(new ProviderError(provider, 'http', `HTTP ${r.status}: ${text.slice(0, 160)}`), { status: r.status, body });
    return body;
  };
  return {
    getJson: (url, init) => run(url, { method: 'GET', headers: { accept: 'application/json', ...init?.headers }, signal: init?.signal }),
    postJson: (url, body, init) => run(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), signal: init?.signal }),
  };
}

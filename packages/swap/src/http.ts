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

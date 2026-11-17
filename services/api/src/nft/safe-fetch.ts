// Server-side fetcher for creator-controlled URLs (NFT metadata and media) — the SSRF defence of brief §6/§7.
//
// For every hop (the first URL and each redirect):
//   1. the URL must be https, default port, no credentials, and its host must not be a local name;
//   2. the host is resolved ONCE; every address returned must be a public unicast address (netguard.ts) — one private address
//      in the answer refuses the whole host;
//   3. the connection is made to THAT validated address (the socket's `lookup` returns it; the name is not resolved again), with
//      TLS verified for the host name — a second DNS answer (rebinding) cannot move the connection;
//   4. no cookie, no authorization, no referer is ever sent; the body is read up to a byte cap and a total deadline.
// Redirects are followed by hand (at most MAX_REDIRECTS), each target going through steps 1–4 again.
// The transport and the resolver are injectable: the tests script DNS answers and observe the address actually dialled.
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { checkHttpsUrl, classifyAddress, forbiddenHostname, isIpLiteral } from '@spw/nft';

export type FetchRefusal = 'scheme_not_allowed' | 'malformed_uri' | 'credentials_in_url' | 'port_not_allowed' | 'forbidden_host' | 'dns_failed' | 'private_address'
  | 'too_many_redirects' | 'bad_redirect' | 'timeout' | 'too_large' | 'http_error' | 'connect_failed' | 'empty_uri' | 'uri_too_long' | 'bad_ipfs_path' | 'bad_arweave_id' | 'data_uri_not_allowed' | 'data_uri_malformed' | 'no_gateway' | 'budget_exhausted';
export type SafeFetchResult =
  | { ok: true; status: number; contentType: string | null; bytes: Uint8Array; finalUrl: string; hops: number }
  | { ok: false; code: FetchRefusal; /** redacted: an address class or an HTTP status, never a body */ detail?: string; status?: number };

export interface ResolvedAddress { address: string; family: 4 | 6 }
export interface TransportRequest { url: URL; address: string; family: 4 | 6; headers: Record<string, string>; maxBytes: number; deadline: number }
export interface TransportResponse { status: number; headers: Record<string, string | undefined>; body: Uint8Array; truncated: boolean }
export interface SafeFetchDeps {
  resolve: (host: string) => Promise<ResolvedAddress[]>;
  transport: (req: TransportRequest) => Promise<TransportResponse>;
  now: () => number;
}
export const MAX_REDIRECTS = 3;

const systemResolve = async (host: string): Promise<ResolvedAddress[]> => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** node:https with the socket pinned to the validated address. `agent: false`: one connection per request, never reused. */
export const httpsTransport = (req: TransportRequest): Promise<TransportResponse> => new Promise((resolve, reject) => {
  const ms = Math.max(1, req.deadline - Date.now());
  const r = https.request({
    protocol: 'https:', host: req.url.hostname, servername: isIpLiteral(req.url.hostname) ? undefined : req.url.hostname, port: 443, path: req.url.pathname + req.url.search, method: 'GET', headers: req.headers, agent: false, timeout: ms,
    lookup: (_h, opts, cb) => { const f = cb as (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void;
      if (typeof opts === 'object' && opts && (opts as { all?: boolean }).all) f(null, [{ address: req.address, family: req.family }]); else f(null, req.address, req.family); },
  }, (res) => {
    if (res.socket.remoteAddress && res.socket.remoteAddress !== req.address) { res.destroy(); reject(new Error('pinned address mismatch')); return; }
    const chunks: Buffer[] = []; let n = 0, truncated = false;
    res.on('data', (c: Buffer) => { n += c.length; if (n > req.maxBytes) { truncated = true; res.destroy(); done(); } else chunks.push(c); });
    const done = () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), body: new Uint8Array(Buffer.concat(chunks)), truncated });
    res.on('end', done); res.on('error', (e) => (truncated ? undefined : reject(e)));
  });
  const timer = setTimeout(() => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
  r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  r.on('error', (e) => { clearTimeout(timer); reject(e); }); r.on('close', () => clearTimeout(timer));
  r.end();
});
export const defaultFetchDeps: SafeFetchDeps = { resolve: systemResolve, transport: httpsTransport, now: Date.now };

export async function safeFetch(rawUrl: string, o: { maxBytes: number; timeoutMs: number; accept: string }, deps: SafeFetchDeps = defaultFetchDeps): Promise<SafeFetchResult> {
  const deadline = deps.now() + o.timeoutMs;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const c = checkHttpsUrl(current);
    if (!c.ok) return { ok: false, code: hop === 0 ? (c.code as FetchRefusal) : 'bad_redirect', detail: hop === 0 ? undefined : c.code };
    const url = c.url, host = url.hostname.replace(/^\[|\]$/g, '');
    if (forbiddenHostname(host) && !isIpLiteral(host)) return { ok: false, code: 'forbidden_host' };
    let addrs: ResolvedAddress[];
    if (isIpLiteral(host)) addrs = [{ address: host, family: host.includes(':') ? 6 : 4 }];
    else { try { addrs = await deps.resolve(host); } catch { return { ok: false, code: 'dns_failed' }; } }
    if (!addrs.length) return { ok: false, code: 'dns_failed' };
    for (const a of addrs) { const v = classifyAddress(a.address); if (!v.ok) return { ok: false, code: 'private_address', detail: v.reason }; }
    if (deps.now() >= deadline) return { ok: false, code: 'timeout' };
    let res: TransportResponse;
    try {
      // identity encoding: the byte cap applies to what is stored and served (no decompression bomb); nothing identifies the wallet
      res = await deps.transport({ url, address: addrs[0]!.address, family: addrs[0]!.family, headers: { accept: o.accept, 'accept-encoding': 'identity', 'user-agent': 'sp-wallet-nft/1' }, maxBytes: o.maxBytes, deadline });
    } catch (e) { const code = (e as { code?: string }).code; return { ok: false, code: code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' ? 'timeout' : 'connect_failed', detail: typeof code === 'string' ? code : undefined }; }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      if (!loc) return { ok: false, code: 'bad_redirect', detail: 'no location' };
      try { current = new URL(loc, url).href; } catch { return { ok: false, code: 'bad_redirect', detail: 'malformed location' }; }
      continue;
    }
    if (res.truncated) return { ok: false, code: 'too_large' };
    const len = Number(res.headers['content-length']);
    if (Number.isFinite(len) && len > o.maxBytes) return { ok: false, code: 'too_large' };
    if (res.status !== 200) return { ok: false, code: 'http_error', status: res.status, detail: String(res.status) };
    return { ok: true, status: 200, contentType: res.headers['content-type'] ?? null, bytes: res.body, finalUrl: url.href, hops: hop };
  }
  return { ok: false, code: 'too_many_redirects' };
}

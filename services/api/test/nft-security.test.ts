/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/nft-security.test.ts
 * Module           : services
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

// NFT security (brief §15 "Security", the read-only part): the fetcher of creator-controlled URLs against the SSRF list —
// localhost, private ranges, link-local, CGNAT, cloud metadata, IPv6 forms, numeric host spellings, DNS REBINDING (a scripted
// resolver whose second answer is private), redirect chains, schemes, oversized payloads, timeouts — and the headers of what
// the media proxy serves. No network: DNS answers and HTTP responses are scripted; what is asserted is the address actually
// dialled and what was sent. No database.
import { describe, expect, it } from 'vitest';
import type { ResolvedAddress, SafeFetchDeps, TransportRequest, TransportResponse } from '../src/nft/safe-fetch.ts';

Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { MAX_REDIRECTS, safeFetch } = await import('../src/nft/safe-fetch.ts');
const { mediaHeaders, mediaIdOf } = await import('../src/nft/resolver.ts'); // (imports the store: no query is made by these two functions)

const PUBLIC = '93.184.216.34';
type Script = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;
function world(dns: Record<string, (ResolvedAddress[] | Error)[] | ResolvedAddress[]>, script: Script = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{}'), truncated: false })) {
  const lookups: string[] = [], dialled: { host: string; address: string; path: string; headers: Record<string, string> }[] = [], seq = new Map<string, number>();
  let now = 1_000_000;
  const deps: SafeFetchDeps = {
    resolve: async (host) => { lookups.push(host); const e = dns[host]; if (!e) throw new Error('ENOTFOUND');
      if (Array.isArray(e[0]) || e[0] instanceof Error) { const k = seq.get(host) ?? 0; seq.set(host, k + 1); const a = (e as (ResolvedAddress[] | Error)[])[Math.min(k, e.length - 1)]!; if (a instanceof Error) throw a; return a; }
      return e as ResolvedAddress[]; },
    transport: async (req) => { dialled.push({ host: req.url.hostname, address: req.address, path: req.url.pathname + req.url.search, headers: req.headers }); return script(req); },
    now: () => now,
  };
  return { deps, lookups, dialled, tick: (ms: number) => { now += ms; } };
}
const v4 = (address: string): ResolvedAddress[] => [{ address, family: 4 }], v6 = (address: string): ResolvedAddress[] => [{ address, family: 6 }];
const O = { maxBytes: 1000, timeoutMs: 5000, accept: 'application/json' };
const redirect = (location: string): TransportResponse => ({ status: 302, headers: { location }, body: new Uint8Array(), truncated: false });

describe('safeFetch — what may be requested', () => {
  it('a public https host: resolved once, dialled at the resolved address, no credential of any kind sent', async () => {
    const w = world({ 'meta.example': v4(PUBLIC) }), r = await safeFetch('https://meta.example/a.json?x=1', O, w.deps);
    expect(r).toMatchObject({ ok: true, status: 200, finalUrl: 'https://meta.example/a.json?x=1', hops: 0 });
    expect(w.lookups).toEqual(['meta.example']); expect(w.dialled).toEqual([{ host: 'meta.example', address: PUBLIC, path: '/a.json?x=1', headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'sp-wallet-nft/1' } }]);
    expect(Object.keys(w.dialled[0]!.headers).map((h) => h.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie', 'authorization', 'referer', 'origin', 'x-spw-csrf']));
  });
  it('schemes other than https are refused before any DNS query', async () => {
    const w = world({});
    for (const u of ['http://meta.example/a', 'ftp://meta.example/a', 'file:///etc/passwd', 'gopher://meta.example/', 'javascript:alert(1)', 'data:text/plain,hi', 'ws://meta.example/', 'ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq']) expect(await safeFetch(u, O, w.deps), u).toMatchObject({ ok: false, code: 'scheme_not_allowed' });
    expect(await safeFetch('https://user:pw@meta.example/', O, w.deps)).toMatchObject({ ok: false, code: 'credentials_in_url' });
    expect(await safeFetch('https://meta.example:8443/', O, w.deps)).toMatchObject({ ok: false, code: 'port_not_allowed' });
    expect(await safeFetch('https://meta.example:22/', O, w.deps)).toMatchObject({ ok: false, code: 'port_not_allowed' });
    expect(await safeFetch('not a url', O, w.deps)).toMatchObject({ ok: false, code: 'malformed_uri' });
    expect(w.lookups).toEqual([]); expect(w.dialled).toEqual([]);
  });
  it('localhost, private, link-local, CGNAT and cloud-metadata targets — as literals, in every spelling', async () => {
    const w = world({});
    const cases: [string, string][] = [['https://127.0.0.1/', 'loopback'], ['https://localhost/', ''], ['https://10.0.0.5/x.png', 'private'], ['https://192.168.2.103/', 'private'], ['https://172.20.1.1/', 'private'], ['https://169.254.169.254/latest/meta-data/', 'cloud_metadata'],
      ['https://100.100.100.200/', 'cloud_metadata'], ['https://100.64.1.1/', 'cgnat'], ['https://0.0.0.0/', 'unspecified'], ['https://[::1]/', 'loopback'], ['https://[::ffff:127.0.0.1]/', 'loopback'], ['https://[::ffff:a9fe:a9fe]/', 'cloud_metadata'], ['https://[fe80::1]/', 'link_local'], ['https://[fd00:ec2::254]/', 'cloud_metadata'], ['https://[fc00::1]/', 'private'], ['https://[64:ff9b::7f00:1]/', 'loopback'],
      // numeric spellings the URL parser turns into 127.0.0.1 / 169.254.169.254
      ['https://2130706433/', 'loopback'], ['https://0x7f000001/', 'loopback'], ['https://0x7f.1/', 'loopback'], ['https://017700000001/', 'loopback'], ['https://127.1/', 'loopback'], ['https://2852039166/', 'cloud_metadata']];
    for (const [u, reason] of cases) { const r = await safeFetch(u, O, w.deps); expect(r.ok, u).toBe(false); if (!r.ok) { expect(['private_address', 'forbidden_host'], u).toContain(r.code); if (r.code === 'private_address') expect(r.detail, u).toBe(reason); } }
    for (const h of ['printer.local', 'db.internal', 'router.lan', 'intranet', 'x.localhost']) expect(await safeFetch(`https://${h}/`, O, w.deps), h).toMatchObject({ ok: false, code: 'forbidden_host' });
    expect(w.lookups).toEqual([]); expect(w.dialled).toEqual([]); // none of these ever reached a resolver or a socket
  });
  it('a public NAME that resolves to an internal address is refused — one private address among several is enough', async () => {
    const w = world({ 'rebind.example': v4('127.0.0.1'), 'meta.example': v4('169.254.169.254'), 'six.example': v6('::1'), 'mapped.example': v6('::ffff:10.0.0.1'), 'mixed.example': [{ address: PUBLIC, family: 4 }, { address: '10.0.0.7', family: 4 }], 'cgn.example': v4('100.125.225.117'), 'empty.example': [] });
    for (const [h, reason] of [['rebind.example', 'loopback'], ['meta.example', 'cloud_metadata'], ['six.example', 'loopback'], ['mapped.example', 'private'], ['mixed.example', 'private'], ['cgn.example', 'cgnat']] as const) expect(await safeFetch(`https://${h}/x`, O, w.deps), h).toEqual({ ok: false, code: 'private_address', detail: reason });
    expect(await safeFetch('https://empty.example/', O, w.deps)).toMatchObject({ ok: false, code: 'dns_failed' }); expect(await safeFetch('https://nxdomain.example/', O, w.deps)).toMatchObject({ ok: false, code: 'dns_failed' });
    expect(w.dialled).toEqual([]);
  });
  it('DNS rebinding: the name is resolved ONCE and the connection goes to that validated address — a second, private answer is never used', async () => {
    // first answer public (validated), every later answer 127.0.0.1: a client that resolved again at connect time would dial loopback
    const w = world({ 'rebind.example': [v4(PUBLIC), v4('127.0.0.1'), v4('127.0.0.1')] });
    const r = await safeFetch('https://rebind.example/meta.json', O, w.deps);
    expect(r.ok).toBe(true); expect(w.lookups).toEqual(['rebind.example']); expect(w.dialled.map((d) => d.address)).toEqual([PUBLIC]);
    // the next request resolves again — and is refused, because THIS answer is private
    expect(await safeFetch('https://rebind.example/meta.json', O, w.deps)).toEqual({ ok: false, code: 'private_address', detail: 'loopback' });
    expect(w.dialled.map((d) => d.address)).toEqual([PUBLIC]);
  });
  it('the real transport pins the socket: its `lookup` answers the validated address whatever name is asked', async () => {
    // httpsTransport is exercised live by scripts/record-nft-fixtures.mts (sol-core-reference-metadata, one redirect); here: its source keeps the invariant
    const src = (await import('node:fs')).readFileSync(new URL('../src/nft/safe-fetch.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/lookup: \(_h, opts, cb\)/); expect(src).toMatch(/agent: false/); expect(src).toMatch(/remoteAddress !== req\.address/); expect(src).not.toMatch(/\bfetch\(/);
  });
});

describe('safeFetch — redirects, size, time', () => {
  it('each redirect hop is validated like the first URL (resolved, classified, pinned)', async () => {
    const w = world({ 'a.example': v4(PUBLIC), 'b.example': v4('1.1.1.1') }, (req) => (req.url.hostname === 'a.example' ? redirect('https://b.example/final.json') : { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"ok":1}'), truncated: false }));
    const r = await safeFetch('https://a.example/start', O, w.deps);
    expect(r).toMatchObject({ ok: true, finalUrl: 'https://b.example/final.json', hops: 1 }); expect(w.lookups).toEqual(['a.example', 'b.example']); expect(w.dialled.map((d) => d.address)).toEqual([PUBLIC, '1.1.1.1']);
  });
  it('a redirect to an internal address, to another scheme, with credentials or without a location is refused', async () => {
    for (const [loc, code, detail] of [['https://169.254.169.254/latest/meta-data/iam/', 'private_address', 'cloud_metadata'], ['https://internal.example/', 'private_address', 'private'], ['https://[::1]/', 'private_address', 'loopback'], ['http://a.example/plain', 'bad_redirect', 'scheme_not_allowed'],
      ['file:///etc/passwd', 'bad_redirect', 'scheme_not_allowed'], ['https://u:p@a.example/', 'bad_redirect', 'credentials_in_url'], ['https://a.example:6379/', 'bad_redirect', 'port_not_allowed'], ['//localhost/x', 'forbidden_host', undefined]] as const) {
      const w = world({ 'a.example': v4(PUBLIC), 'internal.example': v4('10.1.2.3') }, (req) => (req.url.pathname === '/start' ? redirect(loc) : { status: 200, headers: {}, body: new Uint8Array(), truncated: false }));
      const r = await safeFetch('https://a.example/start', O, w.deps);
      expect(r, loc).toMatchObject({ ok: false, code }); if (!r.ok && detail) expect(r.detail, loc).toBe(detail);
      expect(w.dialled.length, loc).toBe(1); // the redirect target was never contacted
    }
    const none = world({ 'a.example': v4(PUBLIC) }, () => ({ status: 302, headers: {}, body: new Uint8Array(), truncated: false }));
    expect(await safeFetch('https://a.example/start', O, none.deps)).toMatchObject({ ok: false, code: 'bad_redirect' });
  });
  it('a redirect chain is cut after MAX_REDIRECTS; a loop cannot run forever', async () => {
    let n = 0; const w = world({ 'a.example': v4(PUBLIC) }, () => redirect(`https://a.example/hop${++n}`));
    expect(await safeFetch('https://a.example/hop0', O, w.deps)).toEqual({ ok: false, code: 'too_many_redirects' }); expect(w.dialled.length).toBe(MAX_REDIRECTS + 1);
    const ok = world({ 'a.example': v4(PUBLIC) }, (req) => (req.url.pathname === `/h${MAX_REDIRECTS}` ? { status: 200, headers: {}, body: new Uint8Array([1]), truncated: false } : redirect(`/h${Number(req.url.pathname.slice(2)) + 1}`)));
    expect(await safeFetch('https://a.example/h0', O, ok.deps)).toMatchObject({ ok: true, hops: MAX_REDIRECTS }); // relative locations resolve against the current URL
  });
  it('oversized payloads: cut while reading, or refused on the announced length; the cap is passed to the transport', async () => {
    const cut = world({ 'a.example': v4(PUBLIC) }, (req) => { expect(req.maxBytes).toBe(1000); return { status: 200, headers: {}, body: new Uint8Array(1000), truncated: true }; });
    expect(await safeFetch('https://a.example/big', O, cut.deps)).toEqual({ ok: false, code: 'too_large' });
    const len = world({ 'a.example': v4(PUBLIC) }, () => ({ status: 200, headers: { 'content-length': '5000000000' }, body: new Uint8Array(10), truncated: false }));
    expect(await safeFetch('https://a.example/big', O, len.deps)).toEqual({ ok: false, code: 'too_large' });
  });
  it('timeouts and connection failures have codes; an HTTP error is an error, with its status and no body', async () => {
    const t = world({ 'a.example': v4(PUBLIC) }, () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    expect(await safeFetch('https://a.example/', O, t.deps)).toMatchObject({ ok: false, code: 'timeout' });
    const c = world({ 'a.example': v4(PUBLIC) }, () => { throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), { code: 'ECONNREFUSED' }); });
    expect(await safeFetch('https://a.example/', O, c.deps)).toEqual({ ok: false, code: 'connect_failed', detail: 'ECONNREFUSED' });
    const h = world({ 'a.example': v4(PUBLIC) }, () => ({ status: 500, headers: {}, body: new TextEncoder().encode('stack trace with secrets'), truncated: false }));
    expect(await safeFetch('https://a.example/', O, h.deps)).toEqual({ ok: false, code: 'http_error', status: 500, detail: '500' });
    // the deadline covers the whole chain, redirects included
    const slow = world({ 'a.example': v4(PUBLIC) }, () => redirect('https://a.example/next')); const d = slow.deps.transport;
    slow.deps.transport = async (req) => { slow.tick(3000); return d(req); };
    expect(await safeFetch('https://a.example/', O, slow.deps)).toEqual({ ok: false, code: 'timeout' });
  });
});

describe('media proxy — what a served file carries', () => {
  it('ids are opaque and derived from the source URI only', () => {
    expect(mediaIdOf('https://evil.example/a.png')).toMatch(/^m[0-9a-f]{40}$/); expect(mediaIdOf('https://evil.example/a.png')).toBe(mediaIdOf('https://evil.example/a.png')); expect(mediaIdOf('https://evil.example/a.png')).not.toBe(mediaIdOf('https://evil.example/b.png'));
    expect(mediaIdOf('https://evil.example/a.png')).not.toContain('evil');
  });
  it('every response is sandboxed by its own CSP, typed by this server, and never sniffed', () => {
    const img = mediaHeaders('image/png', 'image', 'm0123456789abcdef', false);
    expect(img['content-type']).toBe('image/png'); expect(img['x-content-type-options']).toBe('nosniff'); expect(img['content-disposition']).toBe('inline; filename="nft-0123456789ab.png"');
    expect(img['content-security-policy']).toMatch(/^sandbox; default-src 'none'/); expect(img['x-frame-options']).toBe('DENY'); expect(img['cross-origin-resource-policy']).toBe('same-origin'); expect(img['referrer-policy']).toBe('no-referrer');
    const svg = mediaHeaders('image/svg+xml', 'image', 'm0123456789abcdef', false);
    expect(svg['content-security-policy']).toMatch(/^sandbox; default-src 'none'/); expect(svg['content-security-policy']).not.toContain('script'); // an SVG opened directly cannot run its scripts
  });
  it('HTML: no script by default; "run" allows scripts INSIDE the sandbox only — never same origin, network, navigation, forms or permissions', () => {
    const still = mediaHeaders('text/html', 'html', 'mabc', false)['content-security-policy']!, run = mediaHeaders('text/html', 'html', 'mabc', true)['content-security-policy']!;
    expect(still.startsWith("sandbox; default-src 'none'")).toBe(true); expect(still).not.toContain('allow-scripts'); expect(still).not.toContain('script-src');
    expect(run.startsWith("sandbox allow-scripts; default-src 'none'")).toBe(true);
    for (const csp of [still, run]) { for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-popups', 'allow-modals', 'allow-downloads', 'https:', 'http:', "'self'; "]) expect(csp.includes(forbidden) && forbidden !== "'self'; ", `${forbidden} in ${csp}`).toBe(false);
      expect(csp).toContain("connect-src 'none'"); expect(csp).toContain("form-action 'none'"); expect(csp).toContain("base-uri 'none'"); expect(csp).toContain("frame-ancestors 'self'"); }
    const h = mediaHeaders('text/html', 'html', 'mabc', true);
    expect(h['x-frame-options']).toBe('SAMEORIGIN'); expect(h['permissions-policy']).toContain('clipboard-read=()'); expect(h['permissions-policy']).toContain('publickey-credentials-get=()'); expect(h['content-type']).toBe('text/html; charset=utf-8');
  });
});

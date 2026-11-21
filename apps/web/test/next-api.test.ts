/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/next-api.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT W2 — every request has a time-out and a typed error: a lost answer (time-out, network, unreadable body: outcome
// UNKNOWN) is never confused with an answered HTTP error (outcome known), and a 200 that is not JSON is not an empty success.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, APPROVE_TIMEOUT_MS, get, outcomeUnknown, post, setUnauthHandler, TIMEOUT_MS } from '../src/api.ts';

type Init = RequestInit & { signal: AbortSignal };
/** a fetch that never answers, and rejects like a browser when its signal aborts */
const hang = () => vi.fn((_url: string, init: Init) => new Promise<Response>((_res, rej) => { init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); }));
const answer = (status: number, body: string, type = 'application/json') => vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }));
const caught = async (p: Promise<unknown>): Promise<ApiError> => { try { await p; } catch (e) { return e as ApiError; } throw new Error('the request did not fail'); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setUnauthHandler(() => {}); });

describe('api — time-out', () => {
  it('aborts after the default 20 s and says `timeout` (outcome unknown)', async () => {
    vi.useFakeTimers(); const f = hang(); vi.stubGlobal('fetch', f);
    const p = caught(get('/portfolio'));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1); expect(f.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await p;
    expect(e).toBeInstanceOf(ApiError); expect([e.kind, e.code, e.status]).toEqual(['timeout', 'timeout', 0]); expect(e.outcomeUnknown).toBe(true); expect(outcomeUnknown(e)).toBe(true);
  });
  it('gives an approval 45 s, and any call the time it asks for', async () => {
    vi.useFakeTimers(); const f = hang(); vi.stubGlobal('fetch', f);
    const a = caught(post('/transfers/proposals/x/approve', { assertion: {} }));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 5000); expect(f.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(APPROVE_TIMEOUT_MS - TIMEOUT_MS - 5000); expect((await a).kind).toBe('timeout');
    for (const p of ['/bridge/proposals/x/retry-mint', '/bridge/proposals/x/reclaim', '/risk/kill-switch/release', '/transfers/proposals/x/request-approval', '/nfts/transfer/prepare']) {   // the other long calls
      const f2 = hang(); vi.stubGlobal('fetch', f2); const q = caught(post(p)); await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1); expect(f2.mock.calls[0]![1].signal.aborted, p).toBe(false); await vi.advanceTimersByTimeAsync(APPROVE_TIMEOUT_MS); expect((await q).kind).toBe('timeout'); }
    { const f3 = hang(); vi.stubGlobal('fetch', f3); const q = caught(post('/mandates/m/approve/preview')); await vi.advanceTimersByTimeAsync(TIMEOUT_MS); expect((await q).kind).toBe('timeout'); }   // not an approval: 20 s
    vi.stubGlobal('fetch', hang());
    const b = caught(get('/networks', { timeoutMs: 50 })); await vi.advanceTimersByTimeAsync(50); expect((await b).kind).toBe('timeout');
    const c = caught(post('/mandates/m/approve', {}, undefined, { timeoutMs: 1000 })); await vi.advanceTimersByTimeAsync(1000); expect((await c).kind).toBe('timeout');   // overridable per call
  });
  it('a body that never arrives is a time-out too', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: Init) => ({ ok: true, status: 200, text: () => new Promise<string>((_r, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))) })));
    const p = caught(get('/portfolio')); await vi.advanceTimersByTimeAsync(TIMEOUT_MS); expect((await p).kind).toBe('timeout');
  });
  it('the timer is cleared once the answer is there', async () => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', answer(200, '{"ok":true}'));
    expect(await get('/x')).toEqual({ ok: true }); expect(vi.getTimerCount()).toBe(0);
  });
  it('a caller’s signal aborts the request as a network failure, not a time-out', async () => {
    const f = hang(); vi.stubGlobal('fetch', f); const ctl = new AbortController();
    const p = caught(get('/x', { signal: ctl.signal })); ctl.abort();
    expect((await p).kind).toBe('network');
  });
});

describe('api — typed errors', () => {
  it('network failure: status 0, code `offline` (as the screens test it), outcome unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const e = await caught(get('/x'));
    expect([e.kind, e.code, e.status, e.outcomeUnknown]).toEqual(['network', 'offline', 0, true]);
  });
  it('an HTTP error answer is known: code, message and body of the server', async () => {
    vi.stubGlobal('fetch', answer(409, '{"error":"pending_tx","message":"a previous transaction is pending","extra":1}'));
    const e = await caught(post('/transfers/proposals'));
    expect([e.kind, e.code, e.status, e.message, e.outcomeUnknown]).toEqual(['http', 'pending_tx', 409, 'a previous transaction is pending', false]);
    expect(e.body).toEqual({ error: 'pending_tx', message: 'a previous transaction is pending', extra: 1 }); expect(outcomeUnknown(e)).toBe(false);
  });
  it('an HTTP error whose body is not JSON (a gateway page) is still an HTTP error', async () => {
    vi.stubGlobal('fetch', answer(502, '<html>Bad Gateway</html>', 'text/html'));
    const e = await caught(get('/x')); expect([e.kind, e.code, e.status]).toEqual(['http', 'error', 502]); expect(e.body).toEqual({});
  });
  it('a 200 with a non-JSON body is an error, not `{}`', async () => {
    for (const body of ['<html>ok</html>', '', 'OK']) {
      vi.stubGlobal('fetch', answer(200, body, 'text/html'));
      const e = await caught(get('/x')); expect([e.kind, e.code, e.status, e.outcomeUnknown]).toEqual(['parse', 'bad_answer', 200, true]);
    }
  });
  it('a 200 with JSON is returned as it is (null and arrays included)', async () => {
    vi.stubGlobal('fetch', answer(200, '[1,2]')); expect(await get('/x')).toEqual([1, 2]);
    vi.stubGlobal('fetch', answer(200, 'null')); expect(await get('/x')).toBeNull();
  });
  it('401 unauthenticated calls the session handler; another 401 does not', async () => {
    const h = vi.fn(); setUnauthHandler(h);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}')); await caught(get('/x')); expect(h).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', answer(401, '{"error":"login_failed"}')); await caught(get('/x')); expect(h).toHaveBeenCalledTimes(1);
  });
  it('sends the CSRF header, JSON and the caller’s headers on a POST; nothing of the kind on a GET', async () => {
    const f = answer(200, '{}'); vi.stubGlobal('fetch', f);
    await api('POST', '/a', { x: 1 }, { 'idempotency-key': 'k' }); await get('/b');
    const [p, g] = f.mock.calls as unknown as [string, RequestInit][];
    expect(p![0]).toBe('/api/v1/a'); expect(p![1].headers).toEqual({ 'idempotency-key': 'k', 'x-spw-csrf': '1', 'content-type': 'application/json' }); expect(p![1].body).toBe('{"x":1}');
    expect(g![1].headers).toEqual({}); expect(g![1].body).toBeUndefined();
  });
  it('anything that is not an ApiError leaves the outcome unknown', () => { expect(outcomeUnknown(new TypeError('x'))).toBe(true); expect(outcomeUnknown(undefined)).toBe(true); });
});

// Error mapping, retries and idempotency with a mocked transport.
import { describe, expect, it } from 'vitest';
import { AmbiguousSymbol, APIError, AuthenticationError, canonicalJson, Conflict, ConfigurationError, errorFromResponse, ExecutionNotWired, IdempotencyConflict, MandateRequired, NetworkError, NotFound,
  NotImplementedError, OutcomeUnknown, PermissionDenied, RateLimited, responseMeta, ScopeDenied, ServerError, ServiceUnavailable, SPWalletError, TimeoutError, ValidationError } from '../src/index.ts';
import { canonicalJson as serverCanonicalJson } from '../../../services/api/src/trading-api/key-model.ts';
import { fail, mock, ok, type Step } from './helpers.ts';

const ORDER = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01' } as const;
const caught = async (p: Promise<unknown>): Promise<SPWalletError> => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as SPWalletError);
const net = (): Step => ({ throw: new TypeError('fetch failed') });

describe('error mapping: HTTP status + code → typed error', () => {
  const table: [number, string, new (...a: never[]) => APIError, (new (...a: never[]) => APIError)?][] = [
    [400, 'bad_request', ValidationError], [400, 'idempotency', ValidationError], [400, 'stale_request', ValidationError], [422, 'no_orderbook', ValidationError],
    [401, 'unauthenticated', AuthenticationError],
    [403, 'insufficient_scope', ScopeDenied, PermissionDenied], [403, 'scope_denied', ScopeDenied, PermissionDenied], [403, 'mandate_required', MandateRequired, PermissionDenied],
    [403, 'restricted', PermissionDenied], [403, 'ip_not_allowed', PermissionDenied], [403, 'key_path_forbidden', PermissionDenied],
    [404, 'unknown_order', NotFound], [404, 'unknown_instrument', NotFound],
    [409, 'idempotency_conflict', IdempotencyConflict, Conflict], [409, 'ambiguous_symbol', AmbiguousSymbol, Conflict], [409, 'something_else', Conflict],
    [429, 'rate_limited', RateLimited], [429, 'auth_throttled', RateLimited],
    [501, 'execution_not_wired', ExecutionNotWired, NotImplementedError], [501, 'other', NotImplementedError],
    [503, 'signer_unreachable', ServiceUnavailable, ServerError], [500, 'internal', ServerError], [418, 'teapot', APIError],
  ];
  for (const [status, code, cls, parent] of table) {
    it(`${status} ${code} → ${cls.name}`, async () => {
      const m = mock([fail(status, code, 'the sentence of the server', code === 'ambiguous_symbol' ? { candidates: ['hyperliquid:BTC', 'spot:BTC'] } : {})], { maxRetries: 0 });
      const e = await caught(m.client.getMarket('BTC'));
      expect(e).toBeInstanceOf(cls); expect(e).toBeInstanceOf(APIError); expect(e).toBeInstanceOf(SPWalletError); expect(e).toBeInstanceOf(Error);
      if (parent) expect(e).toBeInstanceOf(parent);
      expect(e.name).toBe(cls.name);
      expect({ code: e.code, status: e.status, requestId: e.requestId }).toEqual({ code, status, requestId: 'req-1' });
      expect(e.message).toContain('the sentence of the server'); expect(e.message).toContain('req-1');
      if (e instanceof AmbiguousSymbol) expect(e.candidates).toEqual(['hyperliquid:BTC', 'spot:BTC']);
    });
  }
  it('answers that are not the API\'s own: Fastify\'s 404 has no stable code; an HTML page is not parsed', async () => {
    const e = await caught(mock([{ status: 404, json: { message: 'Route GET:/x not found', error: 'Not Found', statusCode: 404 } }]).client.getRisk());
    expect(e).toBeInstanceOf(NotFound); expect(e.code).toBe('http_404');
    const h = await caught(mock([{ status: 500, text: '<html>oops</html>' }]).client.getRisk());
    expect(h).toBeInstanceOf(ServerError); expect(h.code).toBe('http_500');
    expect(errorFromResponse(403, { error: 'mandate_required', message: 'm' })).toBeInstanceOf(MandateRequired);
    const bad = await caught(mock([{ status: 200, text: 'not json' }]).client.getRisk());
    expect(bad).toBeInstanceOf(ServerError); expect(bad.code).toBe('invalid_response');
  });
  it('429 carries Retry-After, else RateLimit-Reset', async () => {
    const a = await caught(mock([fail(429, 'rate_limited', 'slow down', {}, { 'retry-after': '17', 'ratelimit-reset': '40' })], { maxRetries: 0 }).client.listAgents()) as RateLimited;
    expect(a.retryAfterSeconds).toBe(17);
    const b = await caught(mock([fail(429, 'rate_limited', 'slow down', {}, { 'ratelimit-reset': '40' })], { maxRetries: 0 }).client.listAgents()) as RateLimited;
    expect(b.retryAfterSeconds).toBe(40);
  });
});

describe('reads: safe retries', () => {
  it('retried on a network error, 429, 502, 503, 504 — with exponential backoff and jitter', async () => {
    const m = mock([net(), fail(503, 'venue_unavailable'), { status: 502, text: 'bad gateway' }, { status: 504, text: '' }, ok({ agents: [] })], { maxRetries: 4 });
    const r = await m.client.listAgents();
    expect(r).toEqual({ agents: [] });
    expect(m.calls).toHaveLength(5);
    expect(m.sleeps).toEqual([375, 750, 1500, 3000]); // random() = 0.5 → 75 % of 500 × 2^n
    expect(responseMeta(r)).toMatchObject({ attempts: 5, status: 200, requestId: 'req-5', idempotencyKey: null });
    for (const c of m.calls) expect(c.headers['idempotency-key']).toBeUndefined();
  });
  it('jitter stays inside [50 %, 100 %] of the step and the step is capped at 8 s', async () => {
    for (const [rnd, want] of [[0, [250, 500, 1000, 2000, 4000, 4000]], [0.999999, [500, 1000, 2000, 4000, 8000, 8000]]] as const) {
      const m = mock([net(), net(), net(), net(), net(), net(), ok({ agents: [] })], { maxRetries: 6, random: () => rnd });
      await m.client.listAgents();
      expect(m.sleeps.map((x) => Math.round(x))).toEqual(want);
    }
  });
  it('429 waits what the server asks (Retry-After, else RateLimit-Reset); a wait above the bound is not slept: RateLimited at once', async () => {
    const m = mock([fail(429, 'rate_limited', 'x', {}, { 'retry-after': '2' }), fail(429, 'rate_limited', 'x', {}, { 'ratelimit-reset': '7' }), ok({ agents: [] })]);
    await m.client.listAgents();
    expect(m.sleeps).toEqual([2000, 7000]);
    const long = mock([fail(429, 'rate_limited', 'x', {}, { 'retry-after': '120' }), ok({})]);
    const e = await caught(long.client.listAgents()) as RateLimited;
    expect(e).toBeInstanceOf(RateLimited); expect(e.retryAfterSeconds).toBe(120);
    expect(long.calls).toHaveLength(1); expect(long.sleeps).toEqual([]);
  });
  it('not retried: 400, 401, 403, 404, 409, 500, 501', async () => {
    for (const s of [400, 401, 403, 404, 409, 500, 501]) {
      const m = mock([fail(s, 'x'), ok({})]);
      await caught(m.client.getRisk());
      expect(m.calls, String(s)).toHaveLength(1);
    }
  });
  it('gives up after maxRetries: NetworkError, TimeoutError, or the last HTTP error', async () => {
    const n = mock([net()], { maxRetries: 2 });
    const e = await caught(n.client.getRisk());
    expect(e).toBeInstanceOf(NetworkError); expect(e).not.toBeInstanceOf(TimeoutError); expect(e.code).toBe('network_error'); expect(e.status).toBeNull();
    expect(n.calls).toHaveLength(3);
    const t = mock([{ hang: true }], { maxRetries: 1, timeoutMs: 20 });
    const te = await caught(t.client.getRisk());
    expect(te).toBeInstanceOf(TimeoutError); expect(te).toBeInstanceOf(NetworkError); expect(te.code).toBe('timeout');
    expect(t.calls).toHaveLength(2);
    const s = mock([fail(503, 'markets_unavailable')], { maxRetries: 1 });
    expect(await caught(s.client.listMarkets())).toBeInstanceOf(ServiceUnavailable);
    expect(s.calls).toHaveLength(2);
    const per = mock([net()], { maxRetries: 5 });
    await caught(per.client.getRisk({ maxRetries: 0 }));
    expect(per.calls).toHaveLength(1);
  });
  it('an aborted read is not retried', async () => {
    const ctl = new AbortController(), m = mock([{ hang: true }]);
    const p = caught(m.client.getRisk({ signal: ctl.signal }));
    ctl.abort();
    const e = await p;
    expect(e).toBeInstanceOf(NetworkError); expect(e.code).toBe('aborted');
    expect(m.calls).toHaveLength(1);
  });
});

describe('writes: retried only because of the Idempotency-Key', () => {
  it('one key per logical call, generated once; the SAME key and the SAME bytes on every retry', async () => {
    const m = mock([net(), fail(503, 'venue_unavailable'), { status: 502, text: '' }, fail(409, 'idempotency_in_progress'), ok({ orderId: 'o1' }, { 'idempotent-replay': 'true' })], { maxRetries: 4 });
    const r = await m.client.createOrder({ ...ORDER, clientOrderId: 'client-0001', reduceOnly: false });
    expect(m.calls).toHaveLength(5);
    const keys = new Set(m.calls.map((c) => c.headers['idempotency-key'])), bodies = new Set(m.calls.map((c) => c.body));
    expect(keys.size).toBe(1); expect(bodies.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(responseMeta(r)).toMatchObject({ idempotencyKey: [...keys][0], idempotentReplay: true, attempts: 5 });
    // a second logical call gets another key
    const again = await m.client.createOrder(ORDER);
    expect(responseMeta(again)!.idempotencyKey).not.toBe([...keys][0]);
  });
  it('the body is canonical: key order of the caller\'s object does not change the bytes, and they are the server\'s canonical form', async () => {
    const m = mock([ok({})]);
    await m.client.createOrder({ type: 'limit', size: '1', side: 'sell', price: '2', instrument: 'hyperliquid:ETH', mode: 'live', tif: undefined }, { idempotencyKey: 'resume-key-0001' });
    await m.client.createOrder({ mode: 'live', instrument: 'hyperliquid:ETH', side: 'sell', type: 'limit', price: '2', size: '1' }, { idempotencyKey: 'resume-key-0001' });
    expect(m.calls[0]!.body).toBe('{"instrument":"hyperliquid:ETH","mode":"live","price":"2","side":"sell","size":"1","type":"limit"}');
    expect(m.calls[1]!.body).toBe(m.calls[0]!.body);
    expect(m.calls.map((c) => c.headers['idempotency-key'])).toEqual(['resume-key-0001', 'resume-key-0001']);
    for (const v of [{ b: [1, { z: null, a: 'é"\n' }], a: { y: 1.5, x: true } }, [], {}, 'x', null, { nested: { deep: { k: [[], {}] } } }]) expect(canonicalJson(v)).toBe(serverCanonicalJson(v));
    expect(() => canonicalJson({ x: NaN })).toThrow(ConfigurationError);
  });
  it('a caller key is validated locally; X-SPW-Timestamp is sent only when asked', async () => {
    const m = mock([ok({})]);
    await expect(m.client.cancelOrder('o1', { idempotencyKey: 'short' })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(m.client.cancelOrder('o1', { idempotencyKey: 'bad key with spaces' })).rejects.toBeInstanceOf(ConfigurationError);
    expect(m.calls).toHaveLength(0);
    await m.client.cancelOrder('o1');
    expect(m.calls[0]!.headers['x-spw-timestamp']).toBeUndefined();
    const t = mock([ok({})], { sendTimestamp: true });
    await t.client.cancelOrder('o1');
    expect(Math.abs(Number(t.calls[0]!.headers['x-spw-timestamp']) - Date.now() / 1000)).toBeLessThan(5);
  });
  it('a timeout is OutcomeUnknown — not a failure — and carries the key to resume with', async () => {
    const m = mock([{ hang: true }], { maxRetries: 1, timeoutMs: 20 });
    const e = await caught(m.client.createOrder(ORDER)) as OutcomeUnknown;
    expect(e).toBeInstanceOf(OutcomeUnknown);
    expect(e).not.toBeInstanceOf(APIError); expect(e).not.toBeInstanceOf(NetworkError);
    expect(e.code).toBe('outcome_unknown');
    expect(m.calls).toHaveLength(2);
    expect(e.idempotencyKey).toBe(m.calls[0]!.headers['idempotency-key']);
    expect(m.calls[1]!.headers['idempotency-key']).toBe(e.idempotencyKey);
    expect(e.message).toContain(e.idempotencyKey!); expect(e.message).toMatch(/may or may not have been executed/); expect(e.message).toMatch(/do not retry with a new key/);
    expect({ method: e.method, path: e.path }).toEqual({ method: 'POST', path: '/api/v1/trading/orders' });
    // resuming: the same call with the key of the error
    const r = mock([ok({ orderId: 'o1' }, { 'idempotent-replay': 'true' })]);
    const out = await r.client.createOrder(ORDER, { idempotencyKey: e.idempotencyKey! });
    expect(r.calls[0]!.headers['idempotency-key']).toBe(e.idempotencyKey);
    expect(responseMeta(out)!.idempotentReplay).toBe(true);
  });
  it('OutcomeUnknown for every way a write can end without a trustworthy answer', async () => {
    const scripts: Record<string, Step[]> = {
      'connection lost': [net()], 'gateway 502': [{ status: 502, text: 'bad gateway' }], 'gateway 504': [{ status: 504, text: '' }], 'bare 500': [fail(500, 'internal')],
      '503 that is not the API\'s': [{ status: 503, text: '<html>maintenance</html>' }], 'still in progress': [fail(409, 'idempotency_in_progress')], '2xx without JSON': [{ status: 200, text: '' }],
      // an attempt without an answer, then an answer decided BEFORE the server looks at the key: it says nothing about the first attempt
      'timeout then 429': [{ throw: new TypeError('socket hang up') }, fail(429, 'rate_limited', 'x', {}, { 'retry-after': '600' })],
      'timeout then 401': [net(), fail(401, 'unauthenticated')], 'timeout then 403': [net(), fail(403, 'ip_not_allowed')], 'timeout then API 503': [net(), fail(503, 'signer_unreachable')],
    };
    for (const [name, steps] of Object.entries(scripts)) {
      const m = mock(steps, { maxRetries: 1 });
      const e = await caught(m.client.closePosition('p1'));
      expect(e, name).toBeInstanceOf(OutcomeUnknown);
      expect(e.idempotencyKey, name).toBe(m.calls[0]!.headers['idempotency-key']);
      expect(new Set(m.calls.map((c) => `${c.headers['idempotency-key']}|${c.body}`)).size, name).toBe(1);
    }
  });
  it('a definite answer stays a typed error, even after an attempt without an answer', async () => {
    // these are computed under the key (or are deterministic refusals of the request itself): the first attempt did not execute
    for (const [steps, cls] of [[[net(), fail(501, 'execution_not_wired')], ExecutionNotWired], [[net(), fail(400, 'bad_request')], ValidationError], [[net(), fail(404, 'unknown_order')], NotFound],
      [[net(), fail(409, 'idempotency_conflict')], IdempotencyConflict], [[fail(503, 'signer_unreachable')], ServiceUnavailable], [[fail(403, 'mandate_required')], MandateRequired],
      [[fail(429, 'rate_limited', 'x', {}, { 'retry-after': '600' })], RateLimited], [[fail(401, 'unauthenticated')], AuthenticationError]] as const) {
      const m = mock([...steps], { maxRetries: 1 });
      const e = await caught(m.client.cancelOrder('o1'));
      expect(e, cls.name).toBeInstanceOf(cls);
      expect(e.idempotencyKey).toBe(m.calls[0]!.headers['idempotency-key']);
    }
  });
  it('501 execution_not_wired is an error on every write method — never a success', async () => {
    const O = { side: 'buy', type: 'market', size: '1', instrument: 'hyperliquid:BTC' } as const;
    const writes: ((c: ReturnType<typeof mock>['client']) => Promise<unknown>)[] = [
      (c) => c.previewOrder(O), (c) => c.createOrder(O), (c) => c.cancelOrder('o'), (c) => c.closePosition('p'), (c) => c.reducePosition('p', { fraction: '0.5' }),
      (c) => c.createStrategy({ kind: 'spot', path: 'x' }), (c) => c.backtestStrategy('s'), (c) => c.startStrategy('s', { mode: 'paper' }), (c) => c.stopStrategy('s'),
      (c) => c.createAgent({ kind: 'spot', name: 'ab', universe: ['BTC'] }), (c) => c.startAgent('a', { mode: 'paper' }), (c) => c.stopAgent('a'),
    ];
    expect(writes).toHaveLength(12);
    for (const w of writes) {
      const m = mock([fail(501, 'execution_not_wired', 'declared but not connected to execution yet; nothing was done')]);
      const e = await caught(w(m.client));
      expect(e).toBeInstanceOf(ExecutionNotWired); expect(e).toBeInstanceOf(NotImplementedError);
      expect(e.status).toBe(501); expect(e.idempotencyKey).toBe(m.calls[0]!.headers['idempotency-key']);
      expect(m.calls).toHaveLength(1); // 501 is not retried
    }
  });
  it('an aborted write is OutcomeUnknown (the request may have left)', async () => {
    const ctl = new AbortController(), m = mock([{ hang: true }]);
    const p = caught(m.client.createOrder(ORDER, { signal: ctl.signal }));
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    expect(await p).toBeInstanceOf(OutcomeUnknown);
    expect(m.calls).toHaveLength(1);
  });
});

// Unit tests of the client surface with a mocked transport: every method sends exactly the documented request, the key is
// never visible, the constructor refuses unsafe configurations.
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError, OPERATIONS, responseMeta, SDK_VERSION, SPWallet, WaitTimeout, sizeFromNotional, type OperationId } from '../src/index.ts';
import { fail, KEY, mock, ok } from './helpers.ts';

const P = '/api/v1/trading';
const ORDER = { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01' } as const;

/** every operation of the OpenAPI document → the SDK call that performs it, and the request it must produce */
const CASES: Record<OperationId, { run: (c: SPWallet) => Promise<unknown>; path: string; query?: Record<string, string>; body?: unknown }> = {
  getOpenApi: { run: (c) => c.openapi(), path: '/openapi.json' },
  listMarkets: { run: (c) => c.listMarkets({ venue: 'hyperliquid', kind: 'perpetual', q: 'btc', limit: 5 }), path: '/markets', query: { venue: 'hyperliquid', kind: 'perpetual', q: 'btc', limit: '5' } },
  getMarket: { run: (c) => c.getMarket('gmx:BTC/USD [BTC-USDC]'), path: '/markets/gmx%3ABTC%2FUSD%20%5BBTC-USDC%5D' },
  getOrderbook: { run: (c) => c.getOrderbook('hyperliquid:BTC', { depth: 5 }), path: '/markets/hyperliquid%3ABTC/orderbook', query: { depth: '5' } },
  getCandles: { run: (c) => c.getCandles('hyperliquid:BTC', { interval: '1h', limit: 10 }), path: '/markets/hyperliquid%3ABTC/candles', query: { interval: '1h', limit: '10' } },
  getPortfolio: { run: (c) => c.getPortfolio(), path: '/portfolio' },
  getBalances: { run: (c) => c.getBalances({ network: 'ethereum' }), path: '/balances', query: { network: 'ethereum' } },
  getActivity: { run: (c) => c.getActivity({ limit: 20 }), path: '/activity', query: { limit: '20' } },
  listPositions: { run: (c) => c.getPositions({ mode: 'paper', venue: 'hyperliquid' }), path: '/positions', query: { mode: 'paper', venue: 'hyperliquid' } },
  listOrders: { run: (c) => c.listOrders({ mode: 'live', open: true, limit: 7 }), path: '/orders', query: { mode: 'live', open: 'true', limit: '7' } },
  getOrder: { run: (c) => c.getOrder('deriv:acc:cid'), path: '/orders/deriv%3Aacc%3Acid' },
  listStrategies: { run: (c) => c.listStrategies({ kind: 'perp' }), path: '/strategies', query: { kind: 'perp' } },
  listAgents: { run: (c) => c.listAgents(), path: '/agents' },
  getRisk: { run: (c) => c.getRisk(), path: '/risk' },
  previewOrder: { run: (c) => c.previewOrder(ORDER), path: '/orders/preview', body: ORDER },
  placeOrder: { run: (c) => c.createOrder({ ...ORDER, type: 'limit', price: '60000', tif: 'alo', reduceOnly: false, slippageBps: 10, clientOrderId: 'my-order-0001' }), path: '/orders',
    body: { ...ORDER, type: 'limit', price: '60000', tif: 'alo', reduceOnly: false, slippageBps: 10, clientOrderId: 'my-order-0001' } },
  cancelOrder: { run: (c) => c.cancelOrder('deriv:acc:cid'), path: '/orders/deriv%3Aacc%3Acid' },
  closePosition: { run: (c) => c.closePosition('pos-1', { slippageBps: 25 }), path: '/positions/pos-1/close', body: { slippageBps: 25 } },
  reducePosition: { run: (c) => c.reducePosition('pos-1', { fraction: '0.5' }), path: '/positions/pos-1/reduce', body: { fraction: '0.5' } },
  createStrategy: { run: (c) => c.createStrategy({ kind: 'perp', path: 'momentum/v1' }), path: '/strategies', body: { kind: 'perp', path: 'momentum/v1' } },
  backtestStrategy: { run: (c) => c.backtestStrategy('s1', { symbols: ['BTC'], interval: '1h' }), path: '/strategies/s1/backtest', body: { symbols: ['BTC'], interval: '1h' } },
  startStrategy: { run: (c) => c.startStrategy('s1', { mode: 'paper' }), path: '/strategies/s1/start', body: { mode: 'paper' } },
  stopStrategy: { run: (c) => c.stopStrategy('s1', { reason: 'done' }), path: '/strategies/s1/stop', body: { reason: 'done' } },
  createAgent: { run: (c) => c.createAgent({ kind: 'perp', name: 'alpha', universe: ['BTC', 'ETH'] }), path: '/agents', body: { kind: 'perp', name: 'alpha', universe: ['BTC', 'ETH'] } },
  startAgent: { run: (c) => c.startAgent('a1', { mode: 'paper' }), path: '/agents/a1/start', body: { mode: 'paper' } },
  stopAgent: { run: (c) => c.stopAgent('a1'), path: '/agents/a1/stop', body: {} },
};

describe('every operation of the OpenAPI document', () => {
  it('has a case here (a new operation in the document fails this test until the SDK covers it)', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(OPERATIONS).sort());
  });
  for (const [id, c] of Object.entries(CASES) as [OperationId, (typeof CASES)[OperationId]][]) {
    it(`${id}: ${OPERATIONS[id].method} ${OPERATIONS[id].path}`, async () => {
      const op = OPERATIONS[id], m = mock([ok({ fine: true })]);
      const out = await c.run(m.client);
      expect(out).toEqual({ fine: true });
      expect(m.calls).toHaveLength(1);
      const call = m.calls[0]!;
      expect(call.method).toBe(op.method);
      // the raw path the SDK sent, decoded, is the document's template with its parameters filled
      const re = new RegExp(`^${op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[a-z]+\}/g, '[^/]+')}$`);
      expect(new URL(call.url).pathname).toMatch(re);
      expect(call.url.href.split('?')[0]).toBe(`https://wallet.test${P}${c.path}`);
      expect(Object.fromEntries(call.url.searchParams)).toEqual(c.query ?? {});
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers['user-agent']).toBe(`sp-wallet-typescript/${SDK_VERSION}`);
      expect(call.headers.cookie).toBeUndefined();
      if (op.idempotent) {
        expect(call.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(responseMeta(out as object)?.idempotencyKey).toBe(call.headers['idempotency-key']);
      } else expect(call.headers['idempotency-key']).toBeUndefined();
      if (c.body === undefined) { expect(call.body).toBeUndefined(); expect(call.headers['content-type']).toBeUndefined(); }
      else { expect(JSON.parse(call.body!)).toEqual(c.body); expect(call.headers['content-type']).toBe('application/json'); }
    });
  }
});

describe('construction', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it('reads SP_WALLET_API_KEY and SP_WALLET_BASE_URL; the default base URL is the production wallet', () => {
    delete process.env.SP_WALLET_API_KEY; delete process.env.SP_WALLET_BASE_URL;
    expect(() => new SPWallet()).toThrow(ConfigurationError);
    process.env.SP_WALLET_API_KEY = KEY;
    expect(new SPWallet().baseUrl).toBe('https://wallet.spboucher.ai');
    process.env.SP_WALLET_BASE_URL = 'http://localhost:8650/';
    expect(new SPWallet().baseUrl).toBe('http://localhost:8650');
    expect(new SPWallet({ baseUrl: 'https://other.example' }).baseUrl).toBe('https://other.example');
  });
  it('refuses to send a key in clear, a URL with credentials, bad numbers', () => {
    expect(() => new SPWallet({ apiKey: KEY, baseUrl: 'http://wallet.example' })).toThrow(/https/);
    expect(new SPWallet({ apiKey: KEY, baseUrl: 'http://wallet.example', allowInsecureHttp: true }).baseUrl).toBe('http://wallet.example');
    expect(() => new SPWallet({ apiKey: KEY, baseUrl: 'https://u:p@wallet.example' })).toThrow(ConfigurationError);
    expect(() => new SPWallet({ apiKey: KEY, baseUrl: 'ftp://wallet.example' })).toThrow(ConfigurationError);
    expect(() => new SPWallet({ apiKey: `${KEY}\n` })).toThrow(ConfigurationError);
    expect(() => new SPWallet({ apiKey: KEY, maxRetries: -1 })).toThrow(ConfigurationError);
    expect(() => new SPWallet({ apiKey: KEY, timeoutMs: 0 })).toThrow(ConfigurationError);
  });
  it('user agent: sp-wallet-typescript/<version>, with the caller\'s suffix', async () => {
    const m = mock([ok({ agents: [] })], { userAgent: 'my-bot/2' });
    await m.client.listAgents();
    expect(m.calls[0]!.headers['user-agent']).toBe(`sp-wallet-typescript/${SDK_VERSION} my-bot/2`);
    expect(SDK_VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });
  it('the SDK has no runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });
});

describe('the API key is never shown', () => {
  it('not in inspect, JSON, String, nor in any own property', () => {
    const { client } = mock([ok({})]);
    for (const s of [inspect(client, { depth: 5, showHidden: true }), JSON.stringify(client), String(client), `${client}`, JSON.stringify(Object.entries(client))]) {
      expect(s).not.toContain(KEY); expect(s).not.toContain(KEY.slice(-20));
    }
    expect(JSON.stringify(client)).toContain('<redacted>');
  });
  it('not in an error, whatever the server or the network puts in its message', async () => {
    const errors: unknown[] = [];
    const scripts = [
      [fail(401, 'unauthenticated', `bad key ${KEY}`)], [fail(403, 'insufficient_scope', `Bearer ${KEY} lacks a scope`)], [{ status: 500, text: `<html>${KEY}</html>` }],
      [{ throw: new TypeError(`fetch failed for Authorization: Bearer ${KEY}`) }], [{ status: 502, text: `upstream said ${KEY}` }],
    ] as const;
    for (const steps of scripts) for (const write of [false, true]) {
      const m = mock([...steps], { maxRetries: 0 });
      try { await (write ? m.client.previewOrder(ORDER) : m.client.getPortfolio()); } catch (e) { errors.push(e); }
    }
    expect(errors).toHaveLength(10);
    for (const e of errors) {
      const all = [String(e), (e as Error).message, (e as Error).stack ?? '', inspect(e, { depth: 6 }), JSON.stringify(e, Object.getOwnPropertyNames(e as object)), JSON.stringify((e as { body?: unknown }).body ?? null)].join('\n');
      expect(all).not.toContain(KEY);
      expect(all).not.toContain(KEY.slice(-24));
    }
  });
  it('nothing is written to the console', async () => {
    const seen: unknown[][] = [], orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { seen.push(a); };
    try {
      const m = mock([fail(503, 'venue_unavailable'), { throw: new TypeError('fetch failed') }, ok({ agents: [] })]);
      await m.client.listAgents();
      await mock([fail(401, 'unauthenticated')]).client.listAgents().catch(() => {});
    } finally { Object.assign(console, orig); }
    expect(seen).toEqual([]);
  });
});

describe('orders', () => {
  it('exchange + symbol is the instrument; mode defaults to paper; a float is refused before any request', async () => {
    const m = mock([ok({})]);
    await m.client.previewOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', size: '0.01' });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.01' });
    for (const bad of [{ ...ORDER, size: 0.01 as never }, { ...ORDER, size: '1e-2' }, { ...ORDER, size: '-1' }, { ...ORDER, price: '60,000' }, { ...ORDER, size: undefined }, { ...ORDER, notionalUsdc: 100 },
      { ...ORDER, exchange: 'hyperliquid' }, { side: 'buy', type: 'market', size: '1' } as never, { ...ORDER, size: undefined, notionalUsdc: 99.5 }])
      await expect(m.client.createOrder(bad)).rejects.toBeInstanceOf(ConfigurationError);
    expect(m.calls).toHaveLength(1);
  });
  it('notionalUsdc: the SDK reads the market and sizes the order DOWN to the lot size, in exact decimal arithmetic', async () => {
    const market = { market: { id: 'hyperliquid:BTC', mark: '64907', stale: false }, instrument: { lotSize: '0.00001' } };
    const m = mock([ok(market), ok({ previewed: true })]);
    await m.client.previewOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notionalUsdc: 100 });
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${P}/markets/hyperliquid%3ABTC`, `POST ${P}/orders/preview`]);
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.00154' });
    // a stale or missing mark, or a notional below one lot: refused locally, nothing is posted
    for (const mk of [{ market: { mark: '64907', stale: true }, instrument: null }, { market: { mark: null, stale: false }, instrument: null }, { market: { mark: '64907', stale: false }, instrument: { lotSize: '1' } }]) {
      const x = mock([ok(mk)]);
      await expect(x.client.createOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notionalUsdc: '100' })).rejects.toBeInstanceOf(ConfigurationError);
      expect(x.calls).toHaveLength(1);
    }
  });
  it('sizeFromNotional is exact and rounds down', () => {
    expect(sizeFromNotional('100', '64907', '0.00001')).toBe('0.00154');
    expect(sizeFromNotional(100, '0.1', '0.001')).toBe('1000');
    expect(sizeFromNotional('0.3', '0.1', '0.1')).toBe('3'); // 0.1 + 0.2 territory: no float involved
    expect(sizeFromNotional('1000000000000000000000.5', '3', '0.01')).toBe('333333333333333333333.5');
    expect(sizeFromNotional('99.99', '100', '0.01')).toBe('0.99');
    expect(sizeFromNotional('5', '3')).toBe('1.666666');
    expect(() => sizeFromNotional('100', '0')).toThrow(ConfigurationError);
    expect(() => sizeFromNotional(0.1, '1')).toThrow(ConfigurationError);
  });
});

describe('waitForOrder', () => {
  const order = (status: string, final: boolean | null = null) => ok({ order: { id: 'o1', mode: 'paper', venue: 'hyperliquid', status, final }, fills: [] });
  it('polls until a final state; UNKNOWN is neither final nor a failure', async () => {
    const m = mock([order('SUBMITTED'), order('UNKNOWN'), order('PARTIALLY_FILLED'), order('FILLED')]);
    const r = await m.client.waitForOrder('o1', { pollIntervalMs: 10 });
    expect(r.order.status).toBe('FILLED');
    expect(m.calls).toHaveLength(4);
    expect(m.sleeps).toEqual([10, 10, 10]);
    for (const s of ['CANCELLED', 'canceled', 'REJECTED', 'FAILED', 'filled']) expect((await mock([order(s)]).client.waitForOrder('o1')).order.status).toBe(s);
  });
  it('statuses of the older tables are judged by the server\'s own `final` flag', async () => {
    const m = mock([order('open', false), order('triggered', false), order('expired', true)]);
    expect((await m.client.waitForOrder('o1', { pollIntervalMs: 1 })).order.status).toBe('expired');
    // …but a status that IS one of the twelve states is judged by the state: UNKNOWN + final:true still waits
    const u = mock([order('UNKNOWN', true)]);
    await expect(u.client.waitForOrder('o1', { waitTimeoutMs: 0 })).rejects.toBeInstanceOf(WaitTimeout);
  });
  it('timeout: WaitTimeout carries the last answer and says the order has not failed', async () => {
    const m = mock([order('SUBMITTED')]);
    const e = await m.client.waitForOrder('o1', { waitTimeoutMs: 0 }).catch((x: unknown) => x) as WaitTimeout;
    expect(e).toBeInstanceOf(WaitTimeout);
    expect(e.message).toMatch(/not failed/);
    expect((e.last as { order: { status: string } }).order.status).toBe('SUBMITTED');
    const custom = await mock([order('AWAITING_APPROVAL')]).client.waitForOrder('o1', { until: (o) => o.status === 'AWAITING_APPROVAL' });
    expect(custom.order.status).toBe('AWAITING_APPROVAL');
  });
});

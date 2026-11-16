// Unit tests of the client surface with a mocked transport: every method sends exactly the documented request, the key is
// never visible, the constructor refuses unsafe configurations.
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError, FINAL_ORDER_STATES, isTerminalOrder, OPERATIONS, ORDER_STATES, responseMeta, SDK_VERSION, ServerError, SPWallet, WaitTimeout, type OperationId } from '../src/index.ts';
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
  compareMarkets: { run: (c) => c.compareMarkets({ underlying: 'BTC', side: 'long', notional: '1000' }), path: '/markets/compare', query: { underlying: 'BTC', side: 'long', notional: '1000' } },
  listPrivateMarkets: { run: (c) => c.listPrivateMarkets({ delisted: true, size: '2', side: 'long' }), path: '/private-markets', query: { delisted: 'true', size: '2', side: 'long' } },
  getPrivateMarket: { run: (c) => c.getPrivateMarket('hyperliquid:io:ANTH', { interval: '1d', limit: 30 }), path: '/private-markets/hyperliquid%3Aio%3AANTH', query: { interval: '1d', limit: '30' } },
  getPrivateMarketCompany: { run: (c) => c.getPrivateMarketCompany('anthropic', { side: 'short' }), path: '/private-markets/companies/anthropic', query: { side: 'short' } },
  getPortfolio: { run: (c) => c.getPortfolio(), path: '/portfolio' },
  getBalances: { run: (c) => c.getBalances({ network: 'ethereum' }), path: '/balances', query: { network: 'ethereum' } },
  getActivity: { run: (c) => c.getActivity({ limit: 20, cursor: 'abc_-' }), path: '/activity', query: { limit: '20', cursor: 'abc_-' } },
  listPositions: { run: (c) => c.getPositions({ mode: 'paper', venue: 'hyperliquid' }), path: '/positions', query: { mode: 'paper', venue: 'hyperliquid' } },
  listOrders: { run: (c) => c.listOrders({ mode: 'live', open: true, limit: 7, cursor: 'abc_-' }), path: '/orders', query: { mode: 'live', open: 'true', limit: '7', cursor: 'abc_-' } },
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
  runCommand: { run: (c) => c.runCommand('LONG BTC-PERP 500 x2', { dryRun: true }), path: '/commands', body: { text: 'LONG BTC-PERP 500 x2', mode: 'paper', dryRun: true } },
  engageKillSwitch: { run: (c) => c.engageKillSwitch('drill'), path: '/risk/kill-switch', body: { reason: 'drill' } },
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
      try { await (write ? m.client.createOrder(ORDER) : m.client.getPortfolio()); } catch (e) { errors.push(e); }
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
    for (const bad of [{ ...ORDER, size: 0.01 as never }, { ...ORDER, size: '1e-2' }, { ...ORDER, size: '-1' }, { ...ORDER, price: '60,000' }, { ...ORDER, size: undefined }, { ...ORDER, notional: '100' }, { ...ORDER, notionalUsdc: 100 },
      { ...ORDER, size: undefined, notional: '100', notionalUsdc: 100 }, { ...ORDER, exchange: 'hyperliquid' }, { side: 'buy', type: 'market', size: '1' } as never, { ...ORDER, size: undefined, notional: 99.5 }, { ...ORDER, leverage: '2x' }])
      await expect(m.client.createOrder(bad)).rejects.toBeInstanceOf(ConfigurationError);
    expect(m.calls).toHaveLength(1);
  });
  it('notional: sent as it is — the SERVER reads the price and computes the size; the SDK makes no other request and no arithmetic', async () => {
    const m = mock([ok({ previewed: true })]);
    await m.client.previewOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notional: '100.50' });
    await m.client.createOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notionalUsdc: 100 });           // the quick-start name: the same field
    await m.client.createOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', price: '60000', notional: 250 });
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${P}/orders/preview`, `POST ${P}/orders`, `POST ${P}/orders`]);
    expect(m.calls.map((c) => JSON.parse(c.body!))).toEqual([
      { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notional: '100.50' },
      { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', notional: '100' },
      { mode: 'paper', instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', price: '60000', notional: '250' }]);
    expect((await import('../src/index.ts') as Record<string, unknown>).sizeFromNotional).toBeUndefined();
  });
  it('previewOrder and engageKillSwitch carry no Idempotency-Key (the contract declares none); a preview sends the caller\'s key when one is given', async () => {
    const m = mock([ok({})], { sendTimestamp: true });
    await m.client.previewOrder(ORDER); await m.client.engageKillSwitch(); await m.client.previewOrder(ORDER, { idempotencyKey: 'order-key-0001' });
    expect(m.calls.map((c) => c.headers['idempotency-key'])).toEqual([undefined, undefined, 'order-key-0001']);
    expect(m.calls.every((c) => c.headers['x-spw-timestamp'] === undefined)).toBe(true);
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({ reason: '' });
  });
  it('runCommand: mode defaults to paper, dryRun to false; an empty line is refused locally', async () => {
    const m = mock([ok({ kind: 'query' })]);
    await m.client.runCommand('SHOW POSITIONS', { mode: 'live', accountId: '00000000-0000-4000-8000-000000000000' }, { idempotencyKey: 'cmd-key-0001' });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ text: 'SHOW POSITIONS', mode: 'live', accountId: '00000000-0000-4000-8000-000000000000', dryRun: false });
    expect(m.calls[0]!.headers['idempotency-key']).toBe('cmd-key-0001');
    await expect(m.client.runCommand('  ')).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('pagination', () => {
  const page = (ids: string[], nextCursor: string | null) => ok({ orders: ids.map((id) => ({ id })), items: ids.map((id) => ({ id })), nextCursor, ts: 1 });
  it('iterateOrders follows nextCursor until null, with the same filters on every page', async () => {
    const m = mock([page(['a', 'b'], 'c1'), page(['c', 'd'], 'c2'), page(['e'], null)]);
    const got: string[] = [];
    for await (const o of m.client.iterateOrders({ open: true, mode: 'paper', limit: 2 })) got.push(o.id);
    expect(got).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(m.calls.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([{ open: 'true', mode: 'paper', limit: '2' }, { open: 'true', mode: 'paper', limit: '2', cursor: 'c1' }, { open: 'true', mode: 'paper', limit: '2', cursor: 'c2' }]);
  });
  it('maxItems stops early and asks for no page it does not need; iterateActivity pages the same way', async () => {
    const m = mock([page(['a', 'b'], 'c1'), page(['c', 'd'], 'c2'), page(['e'], null)]);
    const got: string[] = [];
    for await (const o of m.client.iterateOrders({}, { maxItems: 3 })) got.push(o.id);
    expect(got).toEqual(['a', 'b', 'c']); expect(m.calls).toHaveLength(2);
    const a = mock([page(['x'], 'n'), page(['y'], null)]), items: unknown[] = [];
    for await (const i of a.client.iterateActivity({ limit: 1 })) items.push(i.id);
    expect(items).toEqual(['x', 'y']); expect(a.calls.map((c) => c.path)).toEqual([`${P}/activity`, `${P}/activity`]);
    const none = mock([page([], null)]);
    for await (const _ of none.client.iterateOrders({}, { maxItems: 0 })) throw new Error('nothing is expected');
    expect(none.calls).toHaveLength(0);
    await expect((async () => { for await (const _ of none.client.iterateOrders({}, { maxItems: -1 })) { /* refused */ } })()).rejects.toBeInstanceOf(ConfigurationError);
  });
  it('a server that returns the cursor it was given is an error, not an endless loop', async () => {
    const m = mock([page(['a'], 'same'), page(['b'], 'same')]);
    const got: string[] = [];
    await expect((async () => { for await (const o of m.client.iterateOrders()) got.push(o.id); })()).rejects.toBeInstanceOf(ServerError);
    expect(got).toEqual(['a', 'b']); expect(m.calls).toHaveLength(2);
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
    for (const s of FINAL_ORDER_STATES) expect((await mock([order(s)]).client.waitForOrder('o1')).order.status).toBe(s);
  });
  it('the closed enum decides: exactly FILLED, CANCELLED, REJECTED and FAILED are final, whatever `final` says', async () => {
    expect([...ORDER_STATES].filter((s) => isTerminalOrder({ status: s }))).toEqual(['FILLED', 'CANCELLED', 'REJECTED', 'FAILED']);
    expect(ORDER_STATES).toHaveLength(12);
    for (const s of ['UNKNOWN', 'SUBMITTED', 'AWAITING_APPROVAL']) await expect(mock([order(s, true)]).client.waitForOrder('o1', { waitTimeoutMs: 0 }), s).rejects.toBeInstanceOf(WaitTimeout);
    // a word that is not one of the twelve (a server newer than this SDK) is never taken for final
    for (const s of ['filled', 'canceled', 'expired', 'open']) expect(isTerminalOrder({ status: s, final: true } as never), s).toBe(false);
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

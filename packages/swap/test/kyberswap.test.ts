/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/kyberswap.test.ts
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

// KyberSwap adapter against real answers recorded from the live API on 2026-11-10 (scripts/record-swap-kyberswap-fixtures.mts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, httpClient, ProviderError, ProviderRuntime, DEFAULT_POLICY, type AssetRef, type HttpClient, type ProviderContext, type SwapQuoteRequest } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import { createKyberswapProvider, KYBERSWAP_NATIVE, KYBERSWAP_ROUTER } from '../src/providers/kyberswap.ts';

interface Fixture { recordedAt: string; url: string; status: number; body: any }
const fx = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/kyberswap/${name}.json`, import.meta.url), 'utf8'));
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const native = (network: string): AssetRef => ({ network, asset: 'native' });
const SENDER = '0x1111111111111111111111111111111111111111', RECIPIENT = SENDER;
const req = (from: AssetRef, to: AssetRef, amountIn: bigint, slippageBps = 50): SwapQuoteRequest => ({ from, to, amountIn, sender: SENDER, recipient: RECIPIENT, slippageBps });

/** Replays a recorded HTTP exchange through the real http client (so status handling is the production path). */
function replay(f: Fixture, patch?: (body: any) => unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const body = patch ? patch(structuredClone(f.body)) : f.body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: f.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const now = Date.parse(f.recordedAt);
  const ctx: ProviderContext = { signal: new AbortController().signal, http: httpClient('kyberswap', fetchImpl), now: () => now };
  return { ctx, calls, now };
}
const p = createKyberswapProvider();
const CASES: [fixture: string, from: AssetRef, to: AssetRef, amountIn: bigint][] = [
  ['ethereum-eth-usdc', native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n],
  ['ethereum-usdc-wbtc', tok('ethereum', 'USDC'), tok('ethereum', 'WBTC'), 50_000_000n],
  ['base-usdc-eth', tok('base', 'USDC'), native('base'), 25_000_000n],
  ['arbitrum-usdc-link', tok('arbitrum', 'USDC'), tok('arbitrum', 'LINK'), 30_000_000n],
  ['polygon-pol-usdc', native('polygon'), tok('polygon', 'USDC'), 100n * 10n ** 18n],
  ['optimism-eth-usdc', native('optimism'), tok('optimism', 'USDC'), 10n ** 16n],
  ['bsc-bnb-fdusd', native('bsc'), tok('bsc', 'FDUSD'), 4n * 10n ** 16n],
  ['avalanche-usdc-usdt', tok('avalanche', 'USDC'), tok('avalanche', 'USDT'), 20_000_000n],
  ['hyperevm-hype-usdc', native('hyperevm'), tok('hyperevm', 'USDC'), 10n ** 18n],
];

describe('kyberswap: capabilities and pair filter', () => {
  it('is registered, keyless, same-chain only, on the eight EVM networks', () => {
    expect(createProviders().map((x) => x.id)).toContain('kyberswap');
    const c = p.capabilities();
    expect(c).toMatchObject({ crossChain: false, needsKey: false, configured: true, kinds: ['swap'] });
    expect(c.networks.sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon']);
    for (const n of c.networks) expect(NETWORKS[n]!.family).toBe('evm');
  });
  it('supportsPair is local and strict', () => {
    expect(p.supportsPair(native('base'), tok('base', 'USDC'))).toBe(true);
    expect(p.supportsPair(native('base'), native('base'))).toBe(false);
    expect(p.supportsPair(native('base'), tok('ethereum', 'USDC'))).toBe(false); // cross-chain
    expect(p.supportsPair(native('solana'), tok('solana', 'USDC'))).toBe(false);
    expect(p.supportsPair(native('base'), { network: 'base', asset: '0x000000000000000000000000000000000000dEaD' })).toBe(false); // not in the registry
    expect(p.supportsPair({ network: 'base', asset: tok('base', 'USDC').asset.toLowerCase() }, native('base'))).toBe(true);
  });
  it('rejects a client id that could break out of a header', () => {
    expect(() => createKyberswapProvider({ KYBERSWAP_CLIENT_ID: 'a\r\nx: y' })).toThrow();
  });
});

describe('kyberswap: field mapping from recorded answers', () => {
  it.each(CASES)('%s', async (name, from, to, amountIn) => {
    const f = fx(name), { ctx, calls, now } = replay(f), r = req(from, to, amountIn);
    const quotes = await p.quote(r, ctx);
    expect(quotes).toHaveLength(1);
    const q = quotes[0]!, s = f.body.data.routeSummary;
    // the request the adapter sent is the one that was recorded
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(f.url);
    expect(calls[0]!.headers['x-client-id']).toBe('swap-router');
    expect(calls[0]!.url).not.toContain(SENDER.slice(2)); // the wallet address is not disclosed for price discovery
    // amounts: exact strings -> bigint
    expect(q.amountOut.toString()).toBe(s.amountOut);
    expect(q.minAmountOut).toBe((BigInt(s.amountOut) * 9950n) / 10_000n);
    expect(q.fees).toEqual([{ kind: 'network', asset: native(from.network), amount: BigInt(s.gas) * BigInt(s.gasPrice), includedInOutput: false, estimated: true }]);
    expect(q.estimatedSeconds).toBeNull();
    expect(q.expiresAt).toBe(now + 10_000);
    expect(q.priceImpactBps).toBe(Math.round(((Number(s.amountInUsd) - Number(s.amountOutUsd)) / Number(s.amountInUsd)) * 10_000));
    expect(Math.abs(q.priceImpactBps!)).toBeLessThan(100); // small liquid trades
    expect(q).toMatchObject({ provider: 'kyberswap', id: `kyberswap-${s.routeID}`, firmness: 'indicative', atomic: true, refundable: true, request: r });
    expect(q.executability.class).toBe('opaque');
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0]).toMatchObject({ kind: 'swap', provider: 'kyberswap', from, to });
    expect(q.steps[0]!.via).toEqual([...new Set((s.route as any[][]).flat().map((h) => h.exchange))]);
    const roles = q.steps[0]!.contracts.map((c) => c.role);
    expect(roles).toEqual(from.asset === 'native' ? ['router'] : ['router', 'spender']); // an approval is only needed for a token input
    for (const c of q.steps[0]!.contracts) expect(c).toMatchObject({ network: from.network, address: KYBERSWAP_ROUTER });
    expect(q.raw).toEqual(f.body.data); // untouched payload, as /route/build needs it
    expect(checkQuote(q, r, now)).toBeNull();
  });

  it('decimals: 0.01 ETH -> about 20 USDC (6 decimals), 50 USDC -> WBTC (8 decimals)', async () => {
    const a = (await p.quote(req(native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n), replay(fx('ethereum-eth-usdc')).ctx))[0]!;
    expect(a.amountOut).toBeGreaterThan(15_000_000n); expect(a.amountOut).toBeLessThan(30_000_000n);
    const b = (await p.quote(req(tok('ethereum', 'USDC'), tok('ethereum', 'WBTC'), 50_000_000n), replay(fx('ethereum-usdc-wbtc')).ctx))[0]!;
    expect(b.amountOut).toBeGreaterThan(20_000n); expect(b.amountOut).toBeLessThan(200_000n); // 0.0002–0.002 BTC
  });
  it('native coin is sent as 0xEeee…, tokens by their registry address', () => {
    expect(fx('base-usdc-eth').url).toContain(`tokenOut=${KYBERSWAP_NATIVE}`);
    expect(fx('base-usdc-eth').url).toContain(`tokenIn=${tok('base', 'USDC').asset}`);
  });
});

describe('kyberswap: slippage', () => {
  const f = fx('arbitrum-usdc-link'), out = BigInt(f.body.data.routeSummary.amountOut);
  const run = (bps: number) => p.quote(req(tok('arbitrum', 'USDC'), tok('arbitrum', 'LINK'), 30_000_000n, bps), replay(f).ctx);
  it.each([[0, out], [1, (out * 9999n) / 10_000n], [50, (out * 9950n) / 10_000n], [300, (out * 9700n) / 10_000n], [2000, (out * 8000n) / 10_000n]])('%i bps', async (bps, min) => {
    const q = (await run(bps))[0]!;
    expect(q.minAmountOut).toBe(min); expect(q.minAmountOut <= q.amountOut).toBe(true);
  });
  it('rounds the minimum down, never up', async () => {
    const g = fx('avalanche-usdc-usdt'), o = BigInt(g.body.data.routeSummary.amountOut); // 20021713 * 0.9999 is not an integer
    const q = (await p.quote(req(tok('avalanche', 'USDC'), tok('avalanche', 'USDT'), 20_000_000n, 1), replay(g).ctx))[0]!;
    expect((o * 9999n) % 10_000n).not.toBe(0n);
    expect(q.minAmountOut).toBe(o - o / 10_000n - 1n);
  });
  it('above the 2000 bps the provider accepts: no quote, and no request', async () => {
    const r = replay(f); expect(await p.quote(req(tok('arbitrum', 'USDC'), tok('arbitrum', 'LINK'), 30_000_000n, 2001), r.ctx)).toEqual([]); expect(r.calls).toHaveLength(0);
  });
  it('fractional or negative slippage is refused', async () => {
    await expect(run(0.5)).rejects.toBeInstanceOf(ProviderError);
    await expect(run(-1)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('kyberswap: no route and provider errors (recorded)', () => {
  const eth = native('ethereum'), usdc = tok('ethereum', 'USDC');
  it('4008 route not found -> empty', async () => { expect(await p.quote(req(eth, usdc, 1n), replay(fx('no-route-1-wei')).ctx)).toEqual([]); });
  it('4011 token not found -> empty', async () => { expect(await p.quote(req(eth, usdc, 10n ** 16n), replay(fx('error-unknown-token')).ctx)).toEqual([]); });
  it('4009 amount above the maximum -> empty', async () => { expect(await p.quote(req(eth, usdc, 10n ** 33n), replay(fx('error-amount-too-large')).ctx)).toEqual([]); });
  it('4000 bad request -> throws http', async () => { await expect(p.quote(req(eth, usdc, 10n ** 16n), replay(fx('error-malformed-token')).ctx)).rejects.toMatchObject({ code: 'http', provider: 'kyberswap' }); });
  it('404 unknown chain -> throws http', async () => { await expect(p.quote(req(eth, usdc, 10n ** 16n), replay(fx('error-unknown-chain')).ctx)).rejects.toMatchObject({ code: 'http' }); });
  it('429 -> rate_limited; 500 -> http; HTML -> bad_response', async () => {
    const f = fx('ethereum-eth-usdc'), r = req(eth, usdc, 10n ** 16n);
    await expect(p.quote(r, replay({ ...f, status: 429 }).ctx)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(p.quote(r, replay({ ...f, status: 500, body: { code: 5000, message: 'internal' } }).ctx)).rejects.toMatchObject({ code: 'http' });
    await expect(p.quote(r, replay({ ...f, body: '<html>blocked</html>' }).ctx)).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('unsupported pair or zero amount: empty without any request', async () => {
    const r = replay(fx('ethereum-eth-usdc'));
    expect(await p.quote(req(eth, tok('base', 'USDC'), 10n ** 16n), r.ctx)).toEqual([]);
    expect(await p.quote(req(eth, usdc, 0n), r.ctx)).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });
});

describe('kyberswap: malformed and hostile answers are rejected', () => {
  const f = fx('ethereum-eth-usdc'), r = req(native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n);
  const hostile: [string, (b: any) => unknown][] = [
    ['another output token', (b) => { b.data.routeSummary.tokenOut = tok('ethereum', 'USDT').asset; return b; }],
    ['another input token', (b) => { b.data.routeSummary.tokenIn = tok('ethereum', 'WETH').asset; return b; }],
    ['another input amount', (b) => { b.data.routeSummary.amountIn = '1000000000000000'; return b; }],
    ['float output', (b) => { b.data.routeSummary.amountOut = '20480330.5'; return b; }],
    ['exponent output', (b) => { b.data.routeSummary.amountOut = '2e7'; return b; }],
    ['negative output', (b) => { b.data.routeSummary.amountOut = '-20480330'; return b; }],
    ['numeric (non-string) output', (b) => { b.data.routeSummary.amountOut = 20480330; return b; }],
    ['hex output', (b) => { b.data.routeSummary.amountOut = '0x1388'; return b; }],
    ['absurdly long output', (b) => { b.data.routeSummary.amountOut = '9'.repeat(90); return b; }],
    ['negative gas', (b) => { b.data.routeSummary.gas = '-1'; return b; }],
    ['missing amountOut', (b) => { delete b.data.routeSummary.amountOut; return b; }],
    ['missing routeSummary', (b) => { delete b.data.routeSummary; return b; }],
    ['missing data', (b) => ({ code: 0, message: 'successfully' })],
    ['missing route', (b) => { delete b.data.routeSummary.route; return b; }],
    ['empty route', (b) => { b.data.routeSummary.route = []; return b; }],
    ['missing checksum', (b) => { delete b.data.routeSummary.checksum; return b; }],
    ['non-zero code with data', (b) => { b.code = 1; return b; }],
    ['another router', (b) => { b.data.routerAddress = '0x000000000000000000000000000000000000bEEF'; return b; }],
    ['another router inside the summary', (b) => { b.data.routeSummary.routerAddress = '0x000000000000000000000000000000000000bEEF'; return b; }],
    ['malformed router', (b) => { b.data.routerAddress = '0x6131'; return b; }],
    ['a fee nobody asked for', (b) => { b.data.routeSummary.extraFee = { feeAmount: '100', chargeFeeBy: 'currency_out', isInBps: true, feeReceiver: '0x000000000000000000000000000000000000bEEF' }; return b; }],
    ['hop with a malformed token', (b) => { b.data.routeSummary.route[0][0].tokenOut = 'usdc'; return b; }],
    ['null body', () => null],
    ['array body', () => []],
  ];
  it.each(hostile)('%s', async (_n, patch) => {
    await expect(p.quote(r, replay(f, patch).ctx)).rejects.toMatchObject({ code: 'schema', provider: 'kyberswap' });
  });
  it('a stale (replayed) route is refused', async () => {
    const { ctx, now } = replay(f);
    await expect(p.quote(r, { ...ctx, now: () => now + 10 * 60_000 })).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('zero output is "no route", never a quote', async () => {
    expect(await p.quote(r, replay(f, (b) => { b.data.routeSummary.amountOut = '0'; return b; }).ctx)).toEqual([]);
    // 1 base unit out with slippage rounds the minimum to zero: nothing can be guaranteed
    expect(await p.quote(r, replay(f, (b) => { b.data.routeSummary.amountOut = '1'; return b; }).ctx)).toEqual([]);
  });
  it('nonsensical USD estimates give no price impact rather than an invented one', async () => {
    const q = (await p.quote(r, replay(f, (b) => { b.data.routeSummary.amountInUsd = '0'; return b; }).ctx))[0]!;
    expect(q.priceImpactBps).toBeNull();
    const q2 = (await p.quote(r, replay(f, (b) => { b.data.routeSummary.amountOutUsd = '900000'; return b; }).ctx))[0]!;
    expect(q2.priceImpactBps).toBeNull();
  });
  it('unknown extra fields are tolerated and preserved in raw', async () => {
    const q = (await p.quote(r, replay(f, (b) => { b.data.routeSummary.newField = { a: 1 }; return b; }).ctx))[0]!;
    expect((q.raw as any).routeSummary.newField).toEqual({ a: 1 });
  });
});

describe('kyberswap: timeout and abort', () => {
  const r = req(native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n);
  /** a server that never answers; honours the abort signal like fetch does */
  const hanging = (async (_u: string, init: RequestInit) => new Promise((_res, rej) => {
    const s = init.signal!; const fail = () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (s.aborted) fail(); else s.addEventListener('abort', fail, { once: true });
  })) as unknown as typeof fetch;
  it('passes ctx.signal to the HTTP layer: an abort surfaces as a timeout', async () => {
    const ac = new AbortController();
    const pending = p.quote(r, { signal: ac.signal, http: httpClient('kyberswap', hanging), now: Date.now });
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'timeout', provider: 'kyberswap' });
  });
  it('the runtime deadline cuts a hanging provider and counts a timeout', async () => {
    const rt = new ProviderRuntime(p, { ...DEFAULT_POLICY, timeoutMs: 40 }, httpClient('kyberswap', hanging));
    await expect(rt.quote(r)).rejects.toMatchObject({ code: 'timeout' });
    expect(rt.stats().timeouts).toBe(1);
  });
  it('a connection failure is "unavailable"', async () => {
    const down: HttpClient = httpClient('kyberswap', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    await expect(p.quote(r, { signal: new AbortController().signal, http: down, now: Date.now })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

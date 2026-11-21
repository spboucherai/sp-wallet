/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/keyed-comparison.test.ts
 * Module           : swap
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

// 0x (Swap API v2) and 1inch (Classic Swap v6.1): quote-only comparison sources that need an API key.
//
// NO KEY WAS AVAILABLE when these adapters were written (2026-11-15): the fixtures under fixtures/zerox and fixtures/oneinch
// are DOCUMENTATION-DERIVED — the documented response shape, with the documentation's example values where it gives them
// and constructed values (listed in each file) elsewhere. They are NOT recorded answers. What these tests prove is the
// request the adapter sends, the mapping of the documented fields, the refusal of anything else, and that without a key
// the provider is reported as `needsKey` and never asked.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, createEnabledProviders, DEFAULT_POLICY, httpClient, ProviderError, ProviderRuntime, QuoteAggregator, type AssetRef, type ProviderContext, type SwapProvider, type SwapQuoteRequest } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import { createOneinchProvider, ONEINCH_CHAINS, ONEINCH_NATIVE, ONEINCH_ROUTER } from '../src/providers/oneinch.ts';
import { createZeroxProvider, ZEROX_ALLOWANCE_HOLDER, ZEROX_CHAINS, ZEROX_NATIVE } from '../src/providers/zerox.ts';

const fx = (dir: string, name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${name}.json`, import.meta.url), 'utf8'));
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const native = (network: string): AssetRef => ({ network, asset: 'native' });
const SENDER = '0x1111111111111111111111111111111111111111';
const req = (from: AssetRef, to: AssetRef, amountIn: bigint, slippageBps = 50): SwapQuoteRequest => ({ from, to, amountIn, sender: SENDER, recipient: SENDER, slippageBps });
const NOW = Date.parse('2026-11-15T18:00:00.000Z');
/** Replays one exchange through the real http client (status handling is the production path). */
function replay(id: string, status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
  const ctx: ProviderContext = { signal: new AbortController().signal, http: httpClient(id, fetchImpl), now: () => NOW };
  return { ctx, calls };
}
const KEY = 'test-key_0123456789';
const zx = createZeroxProvider({ ZEROX_API_KEY: KEY }), oi = createOneinchProvider({ ONEINCH_API_KEY: KEY });

describe('keyed comparison sources: without a key the provider is absent — reported, never asked, never fabricated', () => {
  it.each([['zerox', createZeroxProvider, 'ZEROX_API_KEY'], ['oneinch', createOneinchProvider, 'ONEINCH_API_KEY']] as const)('%s', async (id, make, envName) => {
    expect(createProviders().map((p) => p.id)).toContain(id);
    const bare = make({});
    expect(bare.capabilities()).toMatchObject({ needsKey: true, configured: false, crossChain: false, kinds: ['swap'] });
    expect(make({ [envName]: '   ' }).capabilities().configured).toBe(false);
    expect(make({ [envName]: KEY }).capabilities()).toMatchObject({ needsKey: true, configured: true });
    expect(() => make({ [envName]: 'a\r\nx-evil: 1' })).toThrow(/unexpected format/);   // a key cannot break out of a header
    // through the aggregator: skipped with `not_configured`, and the HTTP client is never touched
    let touched = 0; const http = { getJson: async () => { touched += 1; throw new Error('no'); }, postJson: async () => { touched += 1; throw new Error('no'); } };
    const agg = new QuoteAggregator([new ProviderRuntime(bare, DEFAULT_POLICY, http)]);
    const r = await agg.collect(req(native('base'), tok('base', 'USDC'), 10n ** 16n));
    expect(r.quotes).toEqual([]); expect(touched).toBe(0);
    expect(r.events).toContainEqual({ type: 'provider', provider: id, status: 'skipped', code: 'not_configured', ms: 0 });
    // called directly anyway (a bug elsewhere): it refuses rather than asking without a key
    await expect(bare.quote(req(native('base'), tok('base', 'USDC'), 10n ** 16n), replay(id, 200, {}).ctx)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('they are in the enabled set (the key is the opt-in) with a low default rate, and serve only same-chain pairs of the registry on EVM networks', () => {
    const enabled = createEnabledProviders({});
    for (const id of ['zerox', 'oneinch']) expect(enabled.find((p) => p.id === id)!.policy).toMatchObject({ ratePerSec: 1, burst: 2 });
    for (const [p, chains] of [[zx, ZEROX_CHAINS], [oi, ONEINCH_CHAINS]] as [SwapProvider, Record<string, number>][]) {
      expect(p.capabilities().networks.sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon']);
      for (const [n, id] of Object.entries(chains)) { expect(NETWORKS[n]!.family).toBe('evm'); expect(String(id)).toBe(String(NETWORKS[n]!.chainRef)); } // the chain id sent is the registry's
      expect(p.supportsPair(native('base'), tok('base', 'USDC'))).toBe(true);
      expect(p.supportsPair(native('base'), native('base'))).toBe(false);
      expect(p.supportsPair(native('base'), tok('ethereum', 'USDC'))).toBe(false);
      expect(p.supportsPair(native('solana'), tok('solana', 'USDC'))).toBe(false);
      expect(p.supportsPair(native('base'), { network: 'base', asset: '0x000000000000000000000000000000000000dEaD' })).toBe(false);
    }
  });
});

describe('0x Swap API v2 — GET /swap/allowance-holder/price (documentation-derived fixtures)', () => {
  it('the guide\'s own example (100 WETH → DAI): request, headers, and every documented field mapped', async () => {
    const f = fx('zerox', 'ethereum-weth-dai'); expect(f.source).toBe('documentation');
    const r = req(tok('ethereum', 'WETH'), tok('ethereum', 'DAI'), 100n * 10n ** 18n, 100), { ctx, calls } = replay('zerox', f.status, f.body);
    const [q] = await zx.quote(r, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(f.url);                                              // chainId, sellToken, buyToken, sellAmount, slippagePpm = bps × 100
    expect(calls[0]!.headers).toMatchObject({ '0x-api-key': KEY, '0x-version': 'v2' });
    expect(calls[0]!.url).not.toContain('taker'); expect(calls[0]!.url).not.toContain(SENDER.slice(2)); // the wallet's address is not disclosed for a price
    expect(q).toMatchObject({ provider: 'zerox', request: r, firmness: 'indicative', estimatedSeconds: null, priceImpactBps: null, atomic: true, quotedAt: NOW, expiresAt: NOW + 15_000 });
    expect(q!.amountOut).toBe(458050129388884000000000n);                           // buyAmount, exact string → bigint
    expect(q!.minAmountOut).toBe(453462747021444000000000n);                        // minBuyAmount: 0x's own minimum, not recomputed
    expect(q!.executability).toMatchObject({ class: 'quote_only', code: 'comparison_only' }); // no execution path
    expect(q!.fees).toEqual([
      { kind: 'network', asset: native('ethereum'), amount: 2857331463231986n, includedInOutput: false, estimated: true },                       // totalNetworkFee
      { kind: 'provider', asset: tok('ethereum', 'DAI'), amount: 687075194083326000000n, includedInOutput: true, estimated: false },             // fees.zeroExFee, in the buy token
    ]);
    expect(q!.steps).toEqual([{ kind: 'swap', provider: 'zerox', from: r.from, to: r.to, via: ['Uniswap_V3', 'Curve'], contracts: [{ network: 'ethereum', address: f.body.allowanceTarget, role: 'spender' }] }]);
    expect(f.body.allowanceTarget.toLowerCase()).toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase());
    expect(checkQuote(q!, r, NOW)).toBeNull();
  });
  it('a native-coin sell: 0x\'s placeholder address, no spender, nullable fields absent → no fee line (never a zero invented)', async () => {
    const f = fx('zerox', 'base-eth-usdc'), r = req(native('base'), tok('base', 'USDC'), 10n ** 16n, 50), { ctx, calls } = replay('zerox', f.status, f.body);
    const [q] = await zx.quote(r, ctx);
    expect(calls[0]!.url).toBe(f.url); expect(calls[0]!.url).toContain(`sellToken=${ZEROX_NATIVE}`);
    expect(q!.amountOut).toBe(34512345n); expect(q!.minAmountOut).toBe(34339783n);
    expect(q!.fees).toEqual([]);                                                    // totalNetworkFee null, zeroExFee null
    expect(q!.steps[0]!.contracts).toEqual([]); expect(q!.steps[0]!.via).toEqual(['Aerodrome_V3']);
    expect(checkQuote(q!, r, NOW)).toBeNull();
  });
  it('no liquidity and the documented "this token is not tradable" errors are a no-route answer; every other error is a failure', async () => {
    const e = fx('zerox', 'errors'), r = req(native('base'), tok('base', 'USDC'), 10n ** 16n);
    expect(await zx.quote(r, replay('zerox', e.noLiquidity.status, e.noLiquidity.body).ctx)).toEqual([]);
    expect(await zx.quote(r, replay('zerox', e.tokenNotSupported.status, e.tokenNotSupported.body).ctx)).toEqual([]);
    expect(await zx.quote(r, replay('zerox', e.buyTokenNotAuthorized.status, e.buyTokenNotAuthorized.body).ctx)).toEqual([]);
    for (const k of ['inputInvalid', 'unauthorized', 'internal'] as const) await expect(zx.quote(r, replay('zerox', e[k].status, e[k].body).ctx), k).rejects.toMatchObject({ code: 'http' });
    await expect(zx.quote(r, replay('zerox', 429, {}).ctx)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(zx.quote(r, replay('zerox', 200, '<html>').ctx)).rejects.toBeInstanceOf(ProviderError);
  });
  it('refuses answers that are not what was asked or not what the schema allows', async () => {
    const f = fx('zerox', 'ethereum-weth-dai'), r = req(tok('ethereum', 'WETH'), tok('ethereum', 'DAI'), 100n * 10n ** 18n, 100);
    const withBody = (patch: (b: any) => void) => { const b = structuredClone(f.body); patch(b); return zx.quote(r, replay('zerox', 200, b).ctx); };
    await expect(withBody((b) => { b.buyToken = tok('ethereum', 'USDC').asset; })).rejects.toMatchObject({ code: 'schema', message: expect.stringMatching(/another token pair/) });
    await expect(withBody((b) => { b.sellAmount = '1'; })).rejects.toMatchObject({ code: 'schema', message: expect.stringMatching(/another input amount/) });
    await expect(withBody((b) => { b.fees.integratorFee = { amount: '5', token: b.buyToken, type: 'volume' }; })).rejects.toMatchObject({ message: expect.stringMatching(/integrator fee/) });
    await expect(withBody((b) => { b.fees.zeroExFee.token = tok('ethereum', 'USDC').asset; })).rejects.toMatchObject({ message: expect.stringMatching(/neither side/) });
    await expect(withBody((b) => { b.minBuyAmount = (BigInt(b.buyAmount) + 1n).toString(); })).rejects.toMatchObject({ message: expect.stringMatching(/minimum above/) });
    for (const patch of [(b: any) => { b.buyAmount = 4.58e23; }, (b: any) => { b.buyAmount = '-5'; }, (b: any) => { b.minBuyAmount = '1.5'; }, (b: any) => { delete b.route; }, (b: any) => { b.totalNetworkFee = 'lots'; }, (b: any) => { b.liquidityAvailable = 'yes'; }])
      await expect(withBody(patch)).rejects.toMatchObject({ code: 'schema' });
    expect(await withBody((b) => { b.buyAmount = '0'; b.minBuyAmount = '0'; })).toEqual([]);
  });
});

describe('1inch Classic Swap v6.1 — GET /swap/v6.1/{chainId}/quote (documentation-derived fixtures)', () => {
  it('request, bearer header, and the documented QuoteResponse mapped; the minimum is the owner\'s tolerance applied to dstAmount', async () => {
    const f = fx('oneinch', 'ethereum-eth-usdc'); expect(f.source).toBe('documentation');
    const r = req(native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n, 50), { ctx, calls } = replay('oneinch', f.status, f.body);
    const [q] = await oi.quote(r, ctx);
    expect(calls).toHaveLength(1); expect(calls[0]!.url).toBe(f.url);
    expect(calls[0]!.url).toContain(`src=${ONEINCH_NATIVE}`);
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(calls[0]!.url).not.toContain(SENDER.slice(2));                           // /quote takes no address
    expect(q).toMatchObject({ provider: 'oneinch', request: r, firmness: 'indicative', estimatedSeconds: null, priceImpactBps: null, atomic: true, quotedAt: NOW, expiresAt: NOW + 15_000 });
    expect(q!.amountOut).toBe(34561234n);
    expect(q!.minAmountOut).toBe((34561234n * 9950n) / 10_000n);
    expect(q!.fees).toEqual([]);                                                    // `gas` is units without a price: no native fee is stated; it stays in raw
    expect((q!.raw as any).gas).toBe(181000);
    expect(q!.executability).toMatchObject({ class: 'quote_only', code: 'comparison_only' });
    expect(q!.steps).toEqual([{ kind: 'swap', provider: 'oneinch', from: r.from, to: r.to, via: ['UNISWAP_V3', 'PMM11'], contracts: [{ network: 'ethereum', address: ONEINCH_ROUTER, role: 'router' }] }]);
    expect(checkQuote(q!, r, NOW)).toBeNull();
    // a token sell names the router as spender too; the optional parts of the answer may be absent
    const r2 = req(tok('ethereum', 'USDC'), native('ethereum'), 25_000_000n, 100);
    const [q2] = await oi.quote(r2, replay('oneinch', 200, { dstAmount: '7200000000000000' }).ctx);
    expect(q2!.minAmountOut).toBe(7128000000000000n); expect(q2!.steps[0]!.via).toEqual([]);
    expect(q2!.steps[0]!.contracts).toEqual([{ network: 'ethereum', address: ONEINCH_ROUTER, role: 'router' }, { network: 'ethereum', address: ONEINCH_ROUTER, role: 'spender' }]);
  });
  it('"insufficient liquidity" (HTTP 400) is a no-route answer; every other error is a failure', async () => {
    const e = fx('oneinch', 'errors'), r = req(native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n);
    expect(await oi.quote(r, replay('oneinch', e.insufficientLiquidity.status, e.insufficientLiquidity.body).ctx)).toEqual([]);
    for (const k of ['badToken', 'unauthorized', 'forbidden', 'internal'] as const) await expect(oi.quote(r, replay('oneinch', e[k].status, e[k].body).ctx), k).rejects.toMatchObject({ code: 'http' });
    await expect(oi.quote(r, replay('oneinch', 429, {}).ctx)).rejects.toMatchObject({ code: 'rate_limited' });
  });
  it('refuses answers that are not what was asked or not what the schema allows', async () => {
    const f = fx('oneinch', 'ethereum-eth-usdc'), r = req(native('ethereum'), tok('ethereum', 'USDC'), 10n ** 16n);
    const withBody = (patch: (b: any) => void) => { const b = structuredClone(f.body); patch(b); return oi.quote(r, replay('oneinch', 200, b).ctx); };
    await expect(withBody((b) => { b.dstToken.address = tok('ethereum', 'DAI').asset; })).rejects.toMatchObject({ code: 'schema', message: expect.stringMatching(/another destination token/) });
    await expect(withBody((b) => { b.srcToken.address = tok('ethereum', 'DAI').asset; })).rejects.toMatchObject({ code: 'schema', message: expect.stringMatching(/another source token/) });
    for (const patch of [(b: any) => { b.dstAmount = 34561234; }, (b: any) => { b.dstAmount = '3.4e7'; }, (b: any) => { b.dstAmount = '-1'; }, (b: any) => { delete b.dstAmount; }, (b: any) => { b.gas = '181000'; }, (b: any) => { b.protocols = 'UNISWAP'; }])
      await expect(withBody(patch)).rejects.toMatchObject({ code: 'schema' });
    expect(await withBody((b) => { b.dstAmount = '0'; })).toEqual([]);
    await expect(oi.quote({ ...r, slippageBps: 6000 }, replay('oneinch', 200, f.body).ctx)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

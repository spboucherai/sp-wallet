/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/card.test.ts
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

// The normalized route card (v11): the same object for every route, built only from what the adapters reported and from the
// caller's price reference. The rule under test: real values only — a figure that was not reported, or cannot be priced, is null.
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { assessRisk, buildRouteCard, DEFAULT_POLICY, LiquidityGraph, ProviderRuntime, QuoteAggregator, SwapRouter, valueQuote,
  type AssetRef, type FeeItem, type HttpClient, type SwapProvider, type SwapQuote, type SwapQuoteRequest, type Valuer } from '../src/index.ts';

const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const ETH: AssetRef = { network: 'base', asset: 'native' }, USDC = tok('base', 'USDC'), USDC_ARB = tok('arbitrum', 'USDC'), LINK_ARB = tok('arbitrum', 'LINK');
const noHttp: HttpClient = { getJson: async () => { throw new Error('no network in tests'); }, postJson: async () => { throw new Error('no network in tests'); } };
const PRICE: Record<string, number> = { ETH: 2000, USDC: 1, LINK: 10 };
const priced: Valuer = (a, amt) => { const n = NETWORKS[a.network]!, d = a.asset === 'native' ? n.native : n.tokens.find((t) => t.id.toLowerCase() === a.asset.toLowerCase())!; const p = PRICE[d.symbol]; return p === undefined ? null : (Number(amt) / 10 ** d.decimals) * p; };
const unpriced: Valuer = () => null;
const NOW = 1_800_000_000_000;
const req = (from: AssetRef, to: AssetRef, amountIn: bigint, slippageBps = 50): SwapQuoteRequest => ({ from, to, amountIn, sender: 'S', recipient: 'R', slippageBps });
const quote = (provider: string, r: SwapQuoteRequest, out: bigint, o: Partial<SwapQuote> = {}): SwapQuote => ({ id: `${provider}-1`, provider, request: r,
  steps: [{ kind: r.from.network === r.to.network ? 'swap' : 'bridge', provider, from: r.from, to: r.to, via: ['pool'], contracts: [] }], amountOut: out, minAmountOut: (out * BigInt(10_000 - r.slippageBps)) / 10_000n,
  fees: [], estimatedSeconds: null, priceImpactBps: null, quotedAt: NOW, expiresAt: NOW + 30_000, firmness: 'indicative', executability: { class: 'opaque', code: 'test_calldata', reason: 'test' }, refundable: true, atomic: true, ...o });
const provider = (id: string, answer: (r: SwapQuoteRequest) => SwapQuote[]): SwapProvider => ({ id, name: id, capabilities: () => ({ networks: ['base', 'arbitrum'], crossChain: true, needsKey: false, configured: true, kinds: ['swap', 'bridge'], docs: '' }),
  supportsPair: () => true, quote: async (r) => answer(r) });
async function routesOf(providers: SwapProvider[], r: SwapQuoteRequest, value: Valuer) {
  const router = new SwapRouter(new QuoteAggregator(providers.map((p) => new ProviderRuntime(p, DEFAULT_POLICY, noHttp))), new LiquidityGraph(providers), value);
  return (await router.search(r, { maxHops: 1 })).routes;
}
const FACTS = { executable: false, executor: null, reasonCode: 'opaque', fingerprint: 'f'.repeat(32) };

describe('normalized route card', () => {
  it('amounts, tolerance, age, steps and risk flags come straight from the route', async () => {
    const r = req(ETH, USDC, 10n ** 16n, 50);
    const [route] = await routesOf([provider('alpha', (q) => [quote('alpha', q, 19_900_000n, { estimatedSeconds: 12 })])], r, priced);
    const c = buildRouteCard(route!, priced, { ...FACTS, executable: true, executor: 'kyberswap', reasonCode: 'ignored' });
    expect(c).toMatchObject({ routeId: route!.id, providers: ['alpha'], fingerprint: 'f'.repeat(32), amountIn: 10n ** 16n, estimatedOut: 19_900_000n, minimumOut: 19_800_500n, toleranceBps: 50,
      etaSeconds: 12, quotedAt: NOW, expiresAt: NOW + 30_000, executable: true, executor: 'kyberswap', reasonCode: null, // an executable route has no "why not"
      steps: [{ kind: 'swap', network: 'base', toNetwork: 'base', provider: 'alpha', descriptionCode: 'step_swap' }] });
    expect(c.riskFlags).toEqual(route!.risk.flags.map((f) => f.code)); expect(c.riskLevel).toBe(route!.risk.level);
    expect(c.effectiveSlippageBps).toBe(50);                                        // 20 USD in, 19.90 USD estimated out at the reference price
    expect(buildRouteCard(route!, priced, FACTS)).toMatchObject({ executable: false, executor: null, reasonCode: 'opaque' });
  });
  it('a fee that was not reported is null — not zero; an ETA the provider does not give is null', async () => {
    const [route] = await routesOf([provider('alpha', (q) => [quote('alpha', q, 19_900_000n)])], req(ETH, USDC, 10n ** 16n), priced);
    expect(buildRouteCard(route!, priced, FACTS)).toMatchObject({ networkFee: null, protocolFee: null, etaSeconds: null });
  });
  it('network fee: native amounts per network with their USD total; estimated when any item is', async () => {
    const gas: FeeItem = { kind: 'network', asset: ETH, amount: 50_000_000_000_000n, includedInOutput: false, estimated: true };
    const [route] = await routesOf([provider('alpha', (q) => [quote('alpha', q, 19_900_000n, { fees: [gas] })])], req(ETH, USDC, 10n ** 16n), priced);
    const c = buildRouteCard(route!, priced, FACTS);
    expect(c.networkFee).toEqual({ items: [{ kind: 'network', asset: ETH, amount: 50_000_000_000_000n, estimated: true, includedInOutput: false, usd: 0.1 }], usd: 0.1, estimated: true, includedInOutput: false });
    expect(c.protocolFee).toBeNull();
  });
  it('protocol fee: USD and basis points of the amount sent — exact when charged in the asset sent, from the price reference otherwise', async () => {
    const r = req(USDC, ETH, 100_000_000n);
    const inFrom: FeeItem = { kind: 'provider', asset: USDC, amount: 150_000n, includedInOutput: true, estimated: false };                     // 0.15 USDC on 100 USDC
    const inTo: FeeItem = { kind: 'bridge', asset: ETH, amount: 25_000_000_000_000n, includedInOutput: true, estimated: false };               // 0.05 USD in ETH
    const one = buildRouteCard((await routesOf([provider('a', (q) => [quote('a', q, 49_000_000_000_000_000n, { fees: [inFrom] })])], r, priced))[0]!, priced, FACTS);
    expect(one.protocolFee).toMatchObject({ usd: 0.15, bps: 15, includedInOutput: true });
    const two = buildRouteCard((await routesOf([provider('a', (q) => [quote('a', q, 49_000_000_000_000_000n, { fees: [inFrom, inTo] })])], r, priced))[0]!, priced, FACTS);
    expect(two.protocolFee!.items.map((i) => i.kind)).toEqual(['provider', 'bridge']);
    expect(two.protocolFee!.usd).toBeCloseTo(0.2, 9); expect(two.protocolFee!.bps).toBe(20);
  });
  it('without a price reference: USD figures and the effective slippage are null; a fee in the asset sent still has its exact basis points', async () => {
    const r = req(USDC, ETH, 100_000_000n);
    const fees: FeeItem[] = [{ kind: 'provider', asset: USDC, amount: 150_000n, includedInOutput: true, estimated: false }, { kind: 'network', asset: ETH, amount: 1n, includedInOutput: false, estimated: true }];
    const c = buildRouteCard((await routesOf([provider('a', (q) => [quote('a', q, 49_000_000_000_000_000n, { fees })])], r, unpriced))[0]!, unpriced, FACTS);
    expect(c.effectiveSlippageBps).toBeNull();
    expect(c.networkFee).toMatchObject({ usd: null, estimated: true }); expect(c.networkFee!.items[0]!.usd).toBeNull();
    expect(c.protocolFee).toMatchObject({ usd: null, bps: 15 });
    // charged in another asset and unpriced: no basis points either
    const other = buildRouteCard((await routesOf([provider('a', (q) => [quote('a', q, 49_000_000_000_000_000n, { fees: [{ kind: 'provider', asset: ETH, amount: 5n, includedInOutput: true, estimated: false }] })])], r, unpriced))[0]!, unpriced, FACTS);
    expect(other.protocolFee).toMatchObject({ usd: null, bps: null });
    // one unpriced item makes the USD total unknown rather than a partial sum
    const half: Valuer = (a, amt) => (a.asset === 'native' ? null : priced(a, amt));
    const mixed = buildRouteCard((await routesOf([provider('a', (q) => [quote('a', q, 49_000_000_000_000_000n, { fees: [fees[0]!, { kind: 'bridge', asset: ETH, amount: 5n, includedInOutput: true, estimated: false }] })])], r, half))[0]!, half, FACTS);
    expect(mixed.protocolFee!.usd).toBeNull(); expect(mixed.protocolFee!.items.map((i) => i.usd)).toEqual([0.15, null]);
  });
  it('a two-leg route: steps of both legs with their networks, the age of the OLDEST leg, the first expiry', async () => {
    const leg1 = quote('cctp', req(USDC, USDC_ARB, 100_000_000n), 99_990_000n, { quotedAt: NOW - 4000, expiresAt: NOW + 60_000, estimatedSeconds: 900, atomic: false, refundable: false });
    const leg2 = quote('kyber', req(USDC_ARB, LINK_ARB, leg1.minAmountOut), 9_900_000_000_000_000_000n, { quotedAt: NOW - 1000, expiresAt: NOW + 9000, estimatedSeconds: 30 });
    // the router's own composition is private: rebuild a Route the same way it does, from the two legs
    const composite: SwapQuote = { ...leg2, id: `${leg1.id}+${leg2.id}`, provider: 'cctp+kyber', request: { ...leg1.request, to: leg2.request.to, recipient: leg2.request.recipient }, steps: [...leg1.steps, ...leg2.steps], fees: [],
      estimatedSeconds: 930, quotedAt: Math.min(leg1.quotedAt, leg2.quotedAt), expiresAt: Math.min(leg1.expiresAt, leg2.expiresAt), atomic: false, refundable: false };
    const valuation = valueQuote(composite, priced);
    const route = { id: composite.id, legs: [leg1, leg2], providers: ['cctp', 'kyber'], path: [USDC, USDC_ARB, LINK_ARB], amountIn: 100_000_000n, amountOut: composite.amountOut, minAmountOut: composite.minAmountOut,
      estimatedSeconds: 930, expiresAt: composite.expiresAt, executability: composite.executability, valuation, risk: assessRisk(composite, valuation), tags: [], pareto: false };
    const c = buildRouteCard(route, priced, FACTS);
    expect(c.steps).toEqual([{ kind: 'bridge', network: 'base', toNetwork: 'arbitrum', provider: 'cctp', descriptionCode: 'step_bridge' }, { kind: 'swap', network: 'arbitrum', toNetwork: 'arbitrum', provider: 'kyber', descriptionCode: 'step_swap' }]);
    expect(c).toMatchObject({ quotedAt: NOW - 4000, expiresAt: NOW + 9000, etaSeconds: 930, amountIn: 100_000_000n, toleranceBps: 50 });
    expect(c.riskFlags).toEqual(expect.arrayContaining(['cross_chain', 'multi_step']));
  });
  it('risk flags carry their figures as parameters, and a reason code instead of a sentence', () => {
    const r = req(ETH, USDC, 10n ** 16n);
    const q = quote('a', r, 21_000_000n, { priceImpactBps: 320, fees: [{ kind: 'network', asset: tok('base', 'LINK'), amount: 1n, includedInOutput: false, estimated: true }] });
    const half: Valuer = (a, amt) => (NETWORKS[a.network]!.tokens.find((t) => t.id === a.asset)?.symbol === 'LINK' ? null : priced(a, amt));
    const flags = Object.fromEntries(assessRisk(q, valueQuote(q, half)).flags.map((f) => [f.code, f]));
    expect(flags.high_price_impact).toMatchObject({ params: { bps: 320 }, detail: '320 bps' });
    expect(flags.better_than_market).toMatchObject({ params: { pct: 105 } });
    expect(flags.fee_unpriced).toMatchObject({ params: { n: 1 } });
    expect(flags.opaque_transaction).toMatchObject({ params: { reasonCode: 'test_calldata' }, detail: 'test' });
    expect(assessRisk({ ...q, executability: { class: 'quote_only', code: 'comparison_only', reason: 'x' } }, valueQuote(q, priced)).flags.find((f) => f.code === 'not_executable')).toMatchObject({ params: { reasonCode: 'comparison_only' } });
  });
});

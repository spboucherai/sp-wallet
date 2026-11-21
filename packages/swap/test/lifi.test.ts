/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/lifi.test.ts
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

// LI.FI adapter against real answers of POST https://li.quest/v1/advanced/routes recorded on 2026-11-10 (fixtures/lifi/*.json;
// the request bodies that produced them are in fixtures/lifi/_requests.json). The recordings are verbatim except for
// `unavailableRoutes`, a diagnostic list the adapter does not read, cut to its first entries (it weighs up to 700 kB per answer).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, DEFAULT_POLICY, httpClient, ProviderError, ProviderRuntime, type AssetRef, type ProviderContext, type SwapQuoteRequest } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import { createLifiProvider, LIFI_API, LIFI_CHAINS } from '../src/providers/lifi.ts';

const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/lifi/${name}.json`, import.meta.url), 'utf8'));
const REQUESTS = fx('_requests') as Record<string, any>;
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const nat = (network: string): AssetRef => ({ network, asset: 'native' });
const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', TRON = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
const BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', SUI = '0x7d20dcdb2bca4f508ea9613994683eb4e76e9c4ed371169677c1be02aaf0b58e';
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', FEE_FORWARDER = '0xDe2b920506EE931a6A2ABDF566526220214FBbAE';
const NOW = 1_794_000_000_000;

/** the requests that were recorded, as the wallet would express them */
const CASES: Record<string, SwapQuoteRequest> = {
  'base-usdc-sol-usdc': { from: tok('base', 'USDC'), to: tok('solana', 'USDC'), amountIn: 25_000_000n, sender: EVM, recipient: SOL, slippageBps: 50 },
  'eth-eth-sol-sol': { from: nat('ethereum'), to: nat('solana'), amountIn: 12_000_000_000_000_000n, sender: EVM, recipient: SOL, slippageBps: 50 },
  'sol-sol-arb-usdc': { from: nat('solana'), to: tok('arbitrum', 'USDC'), amountIn: 300_000_000n, sender: SOL, recipient: EVM, slippageBps: 50 },
  'arb-eth-arb-usdc': { from: nat('arbitrum'), to: tok('arbitrum', 'USDC'), amountIn: 12_000_000_000_000_000n, sender: EVM, recipient: EVM, slippageBps: 50 },
  'eth-link-sol-jup': { from: tok('ethereum', 'LINK'), to: tok('solana', 'JUP'), amountIn: 3_000_000_000_000_000_000n, sender: EVM, recipient: SOL, slippageBps: 50 },
  'btc-btc-eth-eth': { from: nat('bitcoin'), to: nat('ethereum'), amountIn: 40_000n, sender: BTC, recipient: EVM, slippageBps: 50 },
  'eth-usdc-btc-btc': { from: tok('ethereum', 'USDC'), to: nat('bitcoin'), amountIn: 40_000_000n, sender: EVM, recipient: BTC, slippageBps: 50 },
  'tron-usdt-eth-usdt': { from: tok('tron', 'USDT'), to: tok('ethereum', 'USDT'), amountIn: 30_000_000n, sender: TRON, recipient: EVM, slippageBps: 50 },
  'arb-usdc-tron-trx': { from: tok('arbitrum', 'USDC'), to: nat('tron'), amountIn: 30_000_000n, sender: EVM, recipient: TRON, slippageBps: 50 },
  'sui-sui-base-usdc': { from: nat('sui'), to: tok('base', 'USDC'), amountIn: 10_000_000_000n, sender: SUI, recipient: EVM, slippageBps: 50 },
  'hyper-hype-base-eth': { from: nat('hyperevm'), to: nat('base'), amountIn: 1_000_000_000_000_000_000n, sender: EVM, recipient: EVM, slippageBps: 50 },
  'no-route-dust': { from: tok('base', 'USDC'), to: tok('solana', 'USDC'), amountIn: 10n, sender: EVM, recipient: SOL, slippageBps: 50 },
};

const lifi = createLifiProvider();
/** context whose HTTP layer answers with `payload` and records what was asked */
function ctxOf(payload: unknown, seen: { url?: string; body?: unknown; headers?: Record<string, string> } = {}): ProviderContext {
  return { signal: new AbortController().signal, now: () => NOW,
    http: { getJson: async () => { throw new Error('LI.FI routes are requested with POST'); }, postJson: async (url, body, init) => { seen.url = url; seen.body = JSON.parse(JSON.stringify(body)); seen.headers = init?.headers; return payload; } } };
}
const run = (name: string, payload: unknown = fx(name), req: SwapQuoteRequest = CASES[name]!) => lifi.quote(req, ctxOf(payload));
/** a deep copy of a recording, modified */
const tamper = (name: string, f: (d: any) => void) => { const d = fx(name); f(d); return d; };
const schemaError = (p: Promise<unknown>, re?: RegExp) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof ProviderError && e.provider === 'lifi' && e.code === 'schema' && (!re || re.test(e.message)));

describe('lifi: capabilities', () => {
  it('declares the wallet networks LI.FI serves, with its own chain ids, and is registered', () => {
    const c = lifi.capabilities();
    expect(c.networks.sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bitcoin', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon', 'solana', 'sui', 'tron']);
    expect(c).toMatchObject({ crossChain: true, needsKey: false, configured: true, kinds: ['swap', 'bridge'] });
    expect(LIFI_CHAINS.solana!.chainId).toBe(1151111081099710); expect(LIFI_CHAINS.bitcoin!.chainId).toBe(20000000000001);
    expect(LIFI_CHAINS.sui!.chainId).toBe(9270000000000000); expect(LIFI_CHAINS.tron!.chainId).toBe(728126428); expect(LIFI_CHAINS.hyperevm!.chainId).toBe(999);
    for (const [net, c2] of Object.entries(LIFI_CHAINS)) if (NETWORKS[net]!.family === 'evm') expect(String(c2.chainId)).toBe(NETWORKS[net]!.chainRef);
    // Sui's id is above 2^53: it must survive JSON in both directions unchanged
    expect(JSON.stringify({ id: LIFI_CHAINS.sui!.chainId })).toBe('{"id":9270000000000000}'); expect(JSON.parse('{"id":9270000000000000}').id).toBe(LIFI_CHAINS.sui!.chainId);
    expect(createProviders().map((p) => p.id)).toContain('lifi');
  });
  it('filters pairs locally: registry assets on served networks, cross-chain and same-chain, never the same asset', () => {
    expect(lifi.supportsPair(tok('base', 'USDC'), tok('solana', 'USDC'))).toBe(true);
    expect(lifi.supportsPair(nat('arbitrum'), tok('arbitrum', 'USDC'))).toBe(true);
    expect(lifi.supportsPair(nat('bitcoin'), nat('sui'))).toBe(true);
    expect(lifi.supportsPair(nat('base'), nat('base'))).toBe(false);
    expect(lifi.supportsPair(nat('tron'), tok('tron', 'USDT'))).toBe(false); // LI.FI on TRON is cross-chain only
    expect(lifi.supportsPair(nat('solana'), tok('solana', 'USDC'))).toBe(true);
    expect(lifi.supportsPair(nat('base'), { network: 'base', asset: '0x0000000000000000000000000000000000000001' })).toBe(false);
    for (const n of ['litecoin', 'dogecoin', 'bitcoincash', 'stellar', 'xrpl', 'aptos', 'cosmos', 'near', 'ton']) expect(lifi.supportsPair(nat('base'), nat(n))).toBe(false);
    expect(lifi.supportsPair(nat('base'), nat('nowhere'))).toBe(false);
  });
  it('Stellar is left out on evidence: LI.FI lists the chain but answered no route for native XLM', () => {
    expect(fx('no-route-stellar').routes).toEqual([]);
  });
});

describe('lifi: request', () => {
  it('sends exactly the recorded request: LI.FI chain ids and token ids, base-unit amount as a string, slippage as a fraction, one-transaction routes only', async () => {
    for (const name of Object.keys(CASES)) {
      const seen: { url?: string; body?: unknown; headers?: Record<string, string> } = {};
      await lifi.quote(CASES[name]!, ctxOf(fx(name), seen));
      expect(seen.url).toBe(`${LIFI_API}/advanced/routes`); expect(LIFI_API).toBe('https://li.quest/v1');
      expect(seen.body, name).toEqual(REQUESTS[name]);
      expect(seen.headers).toBeUndefined();
    }
  });
  it('native assets use the ids LI.FI expects on each chain family', async () => {
    const seen: { body?: any } = {};
    await lifi.quote(CASES['btc-btc-eth-eth']!, ctxOf(fx('btc-btc-eth-eth'), seen));
    expect(seen.body).toMatchObject({ fromChainId: 20000000000001, fromTokenAddress: 'bitcoin', toTokenAddress: '0x0000000000000000000000000000000000000000', fromAmount: '40000', fromAddress: BTC, toAddress: EVM });
    await lifi.quote(CASES['sui-sui-base-usdc']!, ctxOf(fx('sui-sui-base-usdc'), seen));
    expect(seen.body.fromTokenAddress).toBe('0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI');
    await lifi.quote(CASES['arb-usdc-tron-trx']!, ctxOf(fx('arb-usdc-tron-trx'), seen));
    expect(seen.body.toTokenAddress).toBe('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb');
    await lifi.quote(CASES['sol-sol-arb-usdc']!, ctxOf(fx('sol-sol-arb-usdc'), seen));
    expect(seen.body.fromTokenAddress).toBe('11111111111111111111111111111111');
  });
  it('maps basis points to the fraction LI.FI uses and passes an API key and integrator only when configured', async () => {
    const seen: { body?: any; headers?: Record<string, string> } = {};
    const keyed = createLifiProvider({ LIFI_API_KEY: 'k-123', LIFI_INTEGRATOR: 'spw-test' });
    await keyed.quote({ ...CASES['no-route-dust']!, slippageBps: 125 }, ctxOf({ routes: [] }, seen));
    expect(seen.body.options).toEqual({ slippage: 0.0125, integrator: 'spw-test', allowSwitchChain: false });
    expect(seen.headers).toEqual({ 'x-lifi-api-key': 'k-123' });
    expect(keyed.capabilities()).toMatchObject({ needsKey: false, configured: true });
    await expect(lifi.quote({ ...CASES['no-route-dust']!, slippageBps: 0.5 }, ctxOf({ routes: [] }))).rejects.toBeInstanceOf(ProviderError);
    await expect(lifi.quote({ ...CASES['no-route-dust']!, amountIn: 0n }, ctxOf({ routes: [] }))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('lifi: field mapping (EVM -> Solana, USDC Base -> USDC Solana, 25 USDC)', () => {
  it('returns every single-transaction route as a quote that passes the aggregator checks', async () => {
    const quotes = await run('base-usdc-sol-usdc');
    expect(quotes.map((q) => q.steps[0]!.via.join('+'))).toEqual(['Polymer (Standard)', 'NearIntents', 'Mayan (Swift)', 'Relay', 'LI.FI Intents', 'Layerswap', 'CCTPv2 + Mayan', 'CCTP + Mayan']);
    for (const q of quotes) { expect(checkQuote(q, CASES['base-usdc-sol-usdc']!, NOW)).toBeNull(); expect(q.provider).toBe('lifi'); }
    expect(new Set(quotes.map((q) => q.id)).size).toBe(quotes.length);
  });
  it('maps amounts, the provider minimum, duration, fees, contracts and flags of the cheapest route exactly', async () => {
    const q = (await run('base-usdc-sol-usdc'))[0]!, route = fx('base-usdc-sol-usdc').routes[0];
    expect(q.id).toBe(`lifi:${route.id}`);
    expect(q.amountOut).toBe(24_937_500n); expect(q.minAmountOut).toBe(24_937_500n); // CCTP-style transfer: the provider's minimum equals its estimate
    expect(q.estimatedSeconds).toBe(1080); expect(q.priceImpactBps).toBeNull(); expect(q.expiresAt).toBe(NOW + 30_000);
    expect(q.firmness).toBe('indicative'); expect(q.atomic).toBe(false); expect(q.refundable).toBeNull();
    expect(q.executability.class).toBe('opaque'); expect((q.executability as { reason: string }).reason).toMatch(/Diamond/);
    expect(q.steps).toEqual([{ kind: 'bridge', provider: 'lifi', from: CASES['base-usdc-sol-usdc']!.from, to: CASES['base-usdc-sol-usdc']!.to, via: ['Polymer (Standard)'],
      contracts: [{ network: 'base', address: DIAMOND, role: 'router' }, { network: 'base', address: DIAMOND, role: 'spender' }, { network: 'base', address: FEE_FORWARDER, role: 'router' }] }]);
    expect(q.fees).toEqual([
      { kind: 'network', asset: nat('base'), amount: 2_040_000_000_000n, includedInOutput: false, estimated: true }, // gas on Base, in wei
      { kind: 'provider', asset: tok('base', 'USDC'), amount: 62_500n, includedInOutput: true, estimated: false }, // LI.FI fixed fee, 0.25 % of 25 USDC
    ]);
    expect(25_000_000n - 62_500n).toBe(q.amountOut); // the fee is inside the output, as `included: true` says
    expect((q.raw as { id: string }).id).toBe(route.id);
    expect(JSON.stringify(q.raw)).not.toMatch(/transactionRequest|logoURI/); // validated payload only; advanced/routes carries no calldata
  });
  it('uses the minimum LI.FI guarantees when a route has slippage, and classifies bridge fees', async () => {
    const q = (await run('base-usdc-sol-usdc')).find((x) => x.steps[0]!.via[0] === 'Relay')!;
    expect(q.amountOut).toBe(24_909_845n); expect(q.minAmountOut).toBe(24_785_296n);
    // 0.5 % applied by LI.FI on the bridge leg: floor(out * 0.995) rounded in LI.FI's favour by at most one unit
    expect(q.minAmountOut - (q.amountOut * 9950n) / 10_000n).toBeLessThanOrEqual(1n); expect(q.minAmountOut).toBeLessThan(q.amountOut);
    expect(q.estimatedSeconds).toBe(1);
    expect(q.fees.map((f) => [f.kind, f.amount, f.includedInOutput, f.estimated])).toEqual([
      ['network', 1_296_000_000_000n, false, true], ['provider', 62_500n, true, false], ['bridge', 171n, true, false], ['bridge', 27_484n, true, false]]);
    expect(q.steps[0]!.contracts).toContainEqual({ network: 'base', address: '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF', role: 'bridge' });
  });
});

describe('lifi: multi-step routes', () => {
  it('represents swap + bridge as two steps in order when the intermediate asset is in the registry', async () => {
    const quotes = await run('eth-link-sol-jup'), req = CASES['eth-link-sol-jup']!;
    const viaEth = quotes.find((q) => q.steps.length === 2 && q.steps[1]!.via[0] === 'Mayan (Swift)')!;
    expect(viaEth.steps.map((s) => [s.kind, s.from, s.to, s.via])).toEqual([
      ['swap', req.from, nat('ethereum'), ['Nordstern Finance']],
      ['bridge', nat('ethereum'), req.to, ['Mayan (Swift)']]]);
    expect(viaEth.steps[0]!.contracts.map((c) => c.role)).toEqual(['router', 'spender', 'router', 'router']); // Diamond, Diamond as spender, FeeForwarder, the DEX
    expect(viaEth.atomic).toBe(false);
    const viaUsdc = quotes.find((q) => q.steps.length === 2 && q.steps[1]!.via[0] === 'CCTPv2 + Mayan')!;
    expect(viaUsdc.steps[0]!.to).toEqual(tok('ethereum', 'USDC')); expect(viaUsdc.steps[1]!.from).toEqual(tok('ethereum', 'USDC'));
    expect(viaUsdc.fees).toContainEqual({ kind: 'bridge', asset: tok('ethereum', 'USDC'), amount: 381_124n, includedInOutput: true, estimated: false });
    expect(viaUsdc.fees).toContainEqual({ kind: 'provider', asset: req.from, amount: 7_500_000_000_000_000n, includedInOutput: true, estimated: false });
    for (const q of quotes) expect(checkQuote(q, req, NOW)).toBeNull();
  });
  it('merges legs that go through an asset outside the registry, keeping the venues in order and never naming that asset', async () => {
    const q = (await run('eth-link-sol-jup'))[0]!, req = CASES['eth-link-sol-jup']!; // LINK -> cirBTC (Kyberswap) -> JUP (Relay)
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0]).toMatchObject({ kind: 'bridge', from: req.from, to: req.to, via: ['Kyberswap', 'Relay'] });
    expect(q.amountOut).toBe(121_318_437n); expect(q.minAmountOut).toBe(120_109_147n);
    // the relayer fees are charged in cirBTC and already inside the output: they cannot be a FeeItem, they stay in raw
    expect(q.fees.map((f) => f.kind)).toEqual(['network', 'provider']);
    expect(JSON.stringify(q.raw)).toMatch(/cirBTC/);
    expect(JSON.stringify({ steps: q.steps, fees: q.fees }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E/i);
  });
  it('same-chain swaps are atomic single-step quotes', async () => {
    const quotes = await run('arb-eth-arb-usdc'), req = CASES['arb-eth-arb-usdc']!;
    expect(quotes).toHaveLength(7);
    for (const q of quotes) {
      expect(q.steps).toHaveLength(1); expect(q.steps[0]!.kind).toBe('swap'); expect(q.atomic).toBe(true); expect(q.refundable).toBe(true); expect(q.estimatedSeconds).toBe(0);
      expect(q.steps[0]!.contracts.filter((c) => c.role === 'spender')).toEqual([]); // native input: nothing to approve
      expect(checkQuote(q, req, NOW)).toBeNull();
    }
    expect(quotes[0]!.steps[0]!.via).toEqual(['SushiSwap Aggregator']); expect(quotes[0]!.amountOut).toBe(24_452_933n); expect(quotes[0]!.minAmountOut).toBe(24_330_668n);
    expect(quotes[0]!.fees[1]).toEqual({ kind: 'provider', asset: nat('arbitrum'), amount: 30_000_000_000_000n, includedInOutput: true, estimated: false });
  });
});

describe('lifi: other chain families and decimals', () => {
  it('Solana source: lamports in, 6-decimal USDC out, no EVM contract attributed to Solana', async () => {
    const quotes = await run('sol-sol-arb-usdc'), req = CASES['sol-sol-arb-usdc']!;
    expect(quotes).toHaveLength(7);
    expect(quotes[0]!.amountOut).toBe(24_780_166n); expect(quotes[0]!.minAmountOut).toBe(24_656_265n);
    expect(quotes[0]!.fees[0]).toEqual({ kind: 'network', asset: nat('solana'), amount: 135_000n, includedInOutput: false, estimated: true });
    expect(quotes[0]!.fees[1]).toEqual({ kind: 'provider', asset: nat('solana'), amount: 750_000n, includedInOutput: true, estimated: false });
    for (const q of quotes) { for (const c of q.steps.flatMap((s) => s.contracts)) expect(c.address.startsWith('0x')).toBe(false); expect(checkQuote(q, req, NOW)).toBeNull(); }
    const relay = quotes.find((q) => q.steps[0]!.via[0] === 'Relay')!;
    expect(relay.steps[0]!.contracts).toEqual([{ network: 'solana', address: 'G9sGMKGAdDDqTwPDuqYnxBPSoQk6A2KPbcJGoHpq2HPV', role: 'bridge' }]);
    // Chainflip charges fees in three assets on three chains, all inside the output
    const chainflip = quotes.find((q) => q.steps[0]!.via[0] === 'Chainflip')!;
    expect(chainflip.estimatedSeconds).toBe(168);
    expect(chainflip.fees.filter((f) => f.kind === 'bridge').map((f) => [f.asset, f.amount])).toEqual([[nat('solana'), 395_000n], [tok('ethereum', 'USDC'), 500_000n], [tok('ethereum', 'USDC'), 24_306n], [tok('arbitrum', 'USDC'), 4_121n]]);
  });
  it('Bitcoin in both directions: satoshis and wei are never mixed up', async () => {
    const out = await run('btc-btc-eth-eth');
    expect(out[0]!.amountOut).toBe(14_275_195_224_876_807n); expect(out[0]!.minAmountOut).toBe(14_203_819_248_752_422n); expect(out[0]!.estimatedSeconds).toBe(1712);
    expect(out[0]!.fees[0]).toEqual({ kind: 'network', asset: nat('bitcoin'), amount: 915n, includedInOutput: false, estimated: true });
    expect(out.find((q) => q.steps[0]!.via[0] === 'Relay')!.steps[0]!.contracts).toEqual([{ network: 'bitcoin', address: 'bc1qz8p3w089t3tq3uvqmzhgdh5vuzm7gxr45xjppj', role: 'bridge' }]);
    const back = await run('eth-usdc-btc-btc');
    expect(back[0]!.amountOut).toBe(53_701n); expect(back[0]!.minAmountOut).toBe(53_433n); expect(back[0]!.steps[0]!.to).toEqual(nat('bitcoin'));
    for (const q of [...out, ...back]) expect(q.atomic).toBe(false);
  });
  it('TRON, Sui and HyperEVM sources use their own Diamond or none', async () => {
    const tron = await run('tron-usdt-eth-usdt');
    expect(tron[0]!.steps[0]!.contracts.slice(0, 2)).toEqual([{ network: 'tron', address: 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt', role: 'router' }, { network: 'tron', address: 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt', role: 'spender' }]);
    expect(tron[0]!.fees[0]).toEqual({ kind: 'network', asset: nat('tron'), amount: 66_000_000n, includedInOutput: false, estimated: true }); // 66 TRX of energy
    expect(tron[0]!.amountOut).toBe(29_530_218n);
    const toTron = await run('arb-usdc-tron-trx');
    expect(toTron[0]!.amountOut).toBe(93_798_547n); expect(toTron[0]!.steps[0]!.to).toEqual(nat('tron'));
    const sui = await run('sui-sui-base-usdc');
    expect(sui[0]!.steps[0]!.contracts).toEqual([]); expect(sui[0]!.amountOut).toBe(8_219_844n);
    expect(sui[0]!.fees[0]).toEqual({ kind: 'network', asset: nat('sui'), amount: 43_000_000n, includedInOutput: false, estimated: true });
    const hype = await run('hyper-hype-base-eth');
    expect(hype[0]!.steps[0]!.contracts[0]).toEqual({ network: 'hyperevm', address: '0x0a0758d937d1059c356D4714e57F5df0239bce1A', role: 'router' });
    expect(hype[0]!.amountOut).toBe(34_749_813_921_318_502n);
  });
});

describe('lifi: no route and provider errors', () => {
  const viaFetch = (status: number, body: string) => ({ signal: new AbortController().signal, now: () => NOW, http: httpClient('lifi', (async () => new Response(body, { status })) as typeof fetch) });
  it('an answer without routes is an empty array', async () => {
    expect(await run('no-route-dust')).toEqual([]);
  });
  it('a token LI.FI does not list (HTTP 404, code 1003) is no route; other failures throw', async () => {
    const body = JSON.stringify(fx('error-unknown-token'));
    expect(JSON.parse(body).code).toBe(1003);
    expect(await lifi.quote(CASES['base-usdc-sol-usdc']!, viaFetch(404, body))).toEqual([]);
    await expect(lifi.quote(CASES['base-usdc-sol-usdc']!, viaFetch(400, '{"message":"Invalid request","code":1011}'))).rejects.toMatchObject({ code: 'http' });
    await expect(lifi.quote(CASES['base-usdc-sol-usdc']!, viaFetch(500, '{"message":"boom"}'))).rejects.toMatchObject({ code: 'http' });
    await expect(lifi.quote(CASES['base-usdc-sol-usdc']!, viaFetch(429, '{"message":"Rate limit exceeded"}'))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(lifi.quote(CASES['base-usdc-sol-usdc']!, viaFetch(200, '<html>'))).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('does not call the API for a pair it cannot serve', async () => {
    const http = { getJson: async () => { throw new Error('called'); }, postJson: async () => { throw new Error('called'); } };
    expect(await lifi.quote({ ...CASES['base-usdc-sol-usdc']!, to: nat('litecoin') }, { signal: new AbortController().signal, now: () => NOW, http })).toEqual([]);
  });
  it('reports a timeout when the deadline aborts the request', async () => {
    const slow = (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch;
    const rt = new ProviderRuntime(lifi, { ...DEFAULT_POLICY, timeoutMs: 30 }, httpClient('lifi', slow));
    await expect(rt.quote(CASES['base-usdc-sol-usdc']!)).rejects.toMatchObject({ code: 'timeout' });
    expect(rt.stats().timeouts).toBe(1);
    const ac = new AbortController(); ac.abort();
    const aborted = (async (_u: unknown, init?: RequestInit) => { if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return new Response('{}'); }) as typeof fetch;
    await expect(lifi.quote(CASES['base-usdc-sol-usdc']!, { signal: ac.signal, now: () => NOW, http: httpClient('lifi', aborted) })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('lifi: malformed and hostile answers are rejected', () => {
  const name = 'base-usdc-sol-usdc';
  it('rejects answers that are not the documented shape', async () => {
    await schemaError(run(name, null)); await schemaError(run(name, [])); await schemaError(run(name, {})); await schemaError(run(name, { routes: 'none' }));
    await schemaError(run(name, tamper(name, (d) => { delete d.routes[0].toAmountMin; })), /toAmountMin/);
    await schemaError(run(name, tamper(name, (d) => { delete d.routes[2].steps[0].estimate.executionDuration; })));
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].includedSteps = []; })));
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].includedSteps[1].type = 'teleport'; })));
  });
  it('rejects amounts that are not plain base-unit integers', async () => {
    for (const v of ['24937500.5', '-24937500', '2.49375e7', '0x17c8a1c', '', ' 24937500', 24937500, null]) {
      await schemaError(run(name, tamper(name, (d) => { d.routes[0].toAmount = v; })), /toAmount/);
      await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].estimate.feeCosts[0].amount = v; })));
      await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].estimate.gasCosts[0].amount = v; })));
    }
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toAmount = '0'; d.routes[0].toAmountMin = '0'; })), /inconsistent/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toAmountMin = '24937501'; })), /inconsistent/); // minimum above the estimate
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].estimate.toAmount = '99937500'; })), /differ/);
  });
  it('rejects a route for another token, another chain, other decimals or another amount', async () => {
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toToken.address = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; })), /another pair/); // USDT instead of USDC
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toToken.address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1x'; })), /another pair/); // not in the registry
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toChainId = 42161; })), /another pair/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].fromToken.address = '0x0000000000000000000000000000000000000000'; d.routes[0].fromToken.decimals = 18; })), /another pair/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toToken.decimals = 9; })), /decimals/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].fromAmount = '2500000'; })), /another amount/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].includedSteps[1].action.toToken.address = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; })), /connect/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].includedSteps[1].action.fromToken.address = '0x0000000000000000000000000000000000000000'; })), /contiguous/);
  });
  it('rejects output for another recipient, another sender, another slippage or another spender', async () => {
    const other = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].toAddress = other; })), /recipient/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].action.toAddress = other; })), /addresses/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].fromAddress = '0x000000000000000000000000000000000000dEaD'; })), /sender/);
    await schemaError(run(name, fx(name), { ...CASES[name]!, recipient: other }), /recipient/);
    await schemaError(run(name, fx(name), { ...CASES[name]!, slippageBps: 100 }), /slippage/);
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].estimate.approvalAddress = '0x000000000000000000000000000000000000dEaD'; })), /Diamond/);
    await schemaError(run(name, tamper(name, (d) => { delete d.routes[0].steps[0].estimate.approvalAddress; })), /Diamond/);
    // checksum-case differences on EVM addresses are not differences
    expect(await run(name, fx(name), { ...CASES[name]!, sender: EVM.toLowerCase() })).toHaveLength(8);
  });
  it('rejects gas quoted in an asset the wallet does not hold, and drops (without failing) routes it cannot represent', async () => {
    await schemaError(run(name, tamper(name, (d) => { d.routes[0].steps[0].estimate.gasCosts[0].token.chainId = 324; })), /gas/);
    // a second user transaction (destination-chain signature) is not a route this wallet can run
    const two = await run(name, tamper(name, (d) => { d.routes[0].steps.push(d.routes[0].steps[0]); }));
    expect(two).toHaveLength(7);
    const sw = await run(name, tamper(name, (d) => { d.routes[1].containsSwitchChain = true; }));
    expect(sw).toHaveLength(7);
    // a fee to pay on top in an asset outside the registry
    const fee = await run(name, tamper(name, (d) => { const f = d.routes[0].steps[0].estimate.feeCosts[0]; f.included = false; f.token.address = '0x000000000000000000000000000000000000dEaD'; }));
    expect(fee).toHaveLength(7);
    // a fee to pay on top in a registry asset is reported as such
    const onTop = await run(name, tamper(name, (d) => { d.routes[0].steps[0].estimate.feeCosts[0].included = false; }));
    expect(onTop[0]!.fees[1]).toMatchObject({ kind: 'provider', includedInOutput: false });
  });
  it('never returns more quotes than a sane answer holds', async () => {
    const many = await run(name, tamper(name, (d) => { d.routes = Array.from({ length: 40 }, (_x, k) => ({ ...d.routes[0], id: `r${k}` })); }));
    expect(many).toHaveLength(12);
    await schemaError(run(name, tamper(name, (d) => { d.routes = Array.from({ length: 65 }, () => d.routes[0]); })));
  });
});

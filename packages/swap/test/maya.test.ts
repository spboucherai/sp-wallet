// Maya Protocol adapter, exercised with answers recorded from the live MAYANode API on 2026-11-11 UTC (fixtures/maya).
// The engine is shared with THORChain (thorchain.test.ts covers it in depth); this file covers what differs on Maya:
// endpoints and pools, the HTTP-200 error envelope, always-requested streaming, and the limit being enforced before the outbound fee.
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, DEFAULT_POLICY, httpClient, ProviderRuntime, type AssetRef, type SwapQuote } from '../src/index.ts';
import { createMayaProvider, MAYA_API, MAYA_CONFIG, MAYA_STREAMING_INTERVAL } from '../src/providers/maya.ts';
import { chainBlocked, createNativeSwapProvider, InboundSchema, liquidityToleranceLimit, mapPools, parseSwapMemo } from '../src/providers/thorchain.ts';
import { clone, loadFixture, quoteCall, replay, requestFor, type Fixture } from './native-swap-helpers.ts';

const DIR = 'maya';
const fx = (name: string) => loadFixture(DIR, name);
const provider = () => createNativeSwapProvider(MAYA_CONFIG);
const families = Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, n.family]));
const token = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const BTC: AssetRef = { network: 'bitcoin', asset: 'native' }, ETH: AssetRef = { network: 'ethereum', asset: 'native' }, ARB_ETH: AssetRef = { network: 'arbitrum', asset: 'native' };
const GOOD = ['quote-btc-eth', 'quote-eth-btc', 'quote-btc-usdc', 'quote-usdc-btc', 'quote-eth-arbusdc', 'quote-arbeth-btc', 'quote-btc-eth-streaming'];

async function run(name: string, mutate?: (f: Fixture) => void, opts: Parameters<typeof replay>[3] = {}) {
  const p = provider(), f = clone(fx(name)); mutate?.(f);
  const req = requestFor(p, fx(name), families), r = replay('maya', DIR, f, opts);
  return { p, req, r, f, quotes: await p.quote(req, r.ctx) };
}
const one = (q: SwapQuote[]) => { expect(q).toHaveLength(1); return q[0]!; };

describe('asset mapping', () => {
  const p = provider();
  it('serves BTC, ETH, Arbitrum ETH and the registry stablecoins that have an Available Maya pool', () => {
    expect([...p.assets.values()].map((a) => a.notation).sort()).toEqual([
      'ARB.ETH', 'ARB.USDC-0XAF88D065E77C8CC2239327C5EDB3A432268E5831', 'BTC.BTC', 'ETH.ETH',
      'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7']);
    expect(p.capabilities()).toMatchObject({ networks: ['bitcoin', 'ethereum', 'arbitrum'], crossChain: true, needsKey: false, configured: true, kinds: ['native_swap'] });
    expect(createMayaProvider().id).toBe('maya');
  });
  it('pinned pools were Available in the recorded pool list; nothing Available for the wallet is missing; decimals agree', () => {
    const pools = fx('pools').body as { asset: string; status: string; decimals?: number }[];
    for (const n of MAYA_CONFIG.pools) expect(pools.find((x) => x.asset === n)?.status, n).toBe('Available');
    const chains = Object.keys(MAYA_CONFIG.chains);
    const live = mapPools({ chains: MAYA_CONFIG.chains, pools: pools.filter((x) => x.status === 'Available' && chains.includes(x.asset.split('.')[0]!)).map((x) => x.asset) });
    expect([...live.keys()].sort()).toEqual([...p.assets.keys()].sort());
    for (const a of p.assets.values()) { const d = pools.find((x) => x.asset === a.notation)!.decimals; if (d) expect(d, a.notation).toBe(a.decimals); }
  });
  it('does not serve THORChain-only chains, Staged pools, or tokens outside the registry', () => {
    expect(p.supportsPair(BTC, ETH)).toBe(true); expect(p.supportsPair(ARB_ETH, token('ethereum', 'USDT'))).toBe(true);
    expect(p.supportsPair({ network: 'dogecoin', asset: 'native' }, BTC)).toBe(false);
    expect(p.supportsPair(BTC, token('ethereum', 'PEPE'))).toBe(false);          // ETH.PEPE is Staged on Maya
    expect(p.supportsPair(BTC, token('arbitrum', 'LINK'))).toBe(false);
    expect(p.supportsPair(BTC, { network: 'base', asset: 'native' })).toBe(false);
  });
});

describe('quote mapping from recorded answers', () => {
  it('BTC → ETH: asks for streaming, and reports the floor NET of the outbound fee', async () => {
    const { req, r, quotes, f } = await run('quote-btc-eth');
    expect(quoteCall(r)).toBe(f.url);
    expect(new URL(f.url).searchParams.get('streaming_interval')).toBe(String(MAYA_STREAMING_INTERVAL));
    const q = one(quotes);
    expect(q).toMatchObject({ provider: 'maya', atomic: false, refundable: true, priceImpactBps: 1, estimatedSeconds: 600, expiresAt: 1794360512000 });
    expect(q.amountOut).toBe(19_710_080_000_000_000n);
    // memo limit 1961152 = floor(1971008 × 0.995) is checked by MAYAChain on the swap output BEFORE the 4892 outbound fee
    expect(parseSwapMemo(f.body.memo)).toMatchObject({ limit: 1961152n, interval: 3, quantity: 0 });
    expect(q.minAmountOut).toBe((1961152n - 4892n) * 10n ** 10n);
    expect(q.fees).toEqual([
      { kind: 'protocol', asset: ETH, amount: 2_090_000_000_000n, includedInOutput: true, estimated: true },
      { kind: 'network', asset: ETH, amount: 48_920_000_000_000n, includedInOutput: true, estimated: true }]);
    expect(q.steps[0]).toMatchObject({ kind: 'native_swap', via: ['Maya Protocol', 'BTC.BTC → ETH.ETH', 'single swap'],
      contracts: [{ network: 'bitcoin', address: 'bc1q0ys0mp5knhhxda5u8ug204ry5vznkr3yhukp6x', role: 'vault' }] });
    expect(q.raw).toMatchObject({ limit1e8: '1961152', guaranteed1e8: '1956260', streaming: { quoted: false, interval: 3, quantity: 1 } });
    expect(q.executability.class).toBe('quote_only');
    expect(checkQuote(q, req, r.ctx.now())).toBeNull();
  });
  it('every recorded pair maps, with the limit arithmetic of the protocol and Maya\'s routers', async () => {
    const expected: Record<string, [bigint, bigint]> = {
      'quote-eth-btc': [55_042n, 54_766n - 605n], 'quote-usdc-btc': [53_856n, 53_586n - 605n], 'quote-arbeth-btc': [54_963n, 54_688n - 605n],
      'quote-btc-usdc': [40_240_786n, (3_983_837_814n - 9_992_200n) / 100n], 'quote-eth-arbusdc': [40_400_061n, (4_019_806_069n - 9_909_100n) / 100n],
    };
    for (const name of GOOD) {
      const { req, r, quotes, f } = await run(name); const q = one(quotes);
      expect(quoteCall(r), name).toBe(f.url);
      expect(liquidityToleranceLimit(BigInt(f.body.expected_amount_out), req.slippageBps), name).toBe(parseSwapMemo(f.body.memo).limit);
      if (expected[name]) expect([q.amountOut, q.minAmountOut], name).toEqual(expected[name]);
      expect(checkQuote(q, req, r.ctx.now()), name).toBeNull();
    }
    expect(one((await run('quote-eth-btc')).quotes).steps[0]!.contracts[1]).toEqual({ network: 'ethereum', address: '0xe3985E6b61b814F7Cdb188766562ba71b446B46d', role: 'router' });
    const arb = one((await run('quote-arbeth-btc')).quotes);
    expect(arb.steps[0]!.contracts[1]).toEqual({ network: 'arbitrum', address: '0x700E97ef07219440487840Dc472E7120A7FF11F4', role: 'router' });
    expect(arb.estimatedSeconds).toBeNull(); // MAYANode gave no total_swap_seconds for this pair: never invented
  });
  it('reports streaming when the network would split the swap (2 BTC → ETH: 193 sub-swaps; 0.02 ETH → ARB.USDC: 2)', async () => {
    const big = one((await run('quote-btc-eth-streaming')).quotes);
    expect(big.steps[0]!.via[2]).toBe('streaming swap: 193 sub-swaps, every 3 block(s)');
    expect(big.raw).toMatchObject({ streaming: { quoted: true, interval: 3, quantity: 193, maxQuantity: 193, seconds: 3456 } });
    expect(big.estimatedSeconds).toBe(4056);
    expect(big.amountOut).toBe(71_579_458_990_000_000_000n); expect(big.minAmountOut).toBe((6_943_207_522n - 4_879n) * 10n ** 10n);
    expect(one((await run('quote-eth-arbusdc')).quotes).raw).toMatchObject({ streaming: { quoted: true, quantity: 2 } });
  });
});

describe('no route / failures (Maya answers refusals with HTTP 200 {error})', () => {
  it('recorded refusals: pool not Available, below dust, not enough to pay the outbound fee', async () => {
    for (const name of ['error-pool-not-available', 'error-below-dust', 'error-not-enough-fee']) {
      expect(fx(name).status, name).toBe(200); expect(typeof fx(name).body.error, name).toBe('string');
      expect((await run('quote-btc-eth', (f) => Object.assign(f, fx(name)))).quotes, name).toEqual([]);
    }
  });
  it('amount at or below dust, below the recommended minimum, or a floor eaten by the outbound fee', async () => {
    expect((await run('quote-btc-eth', (f) => { f.body.dust_threshold = '55000'; })).quotes).toEqual([]);
    expect((await run('quote-btc-eth', (f) => { f.body.recommended_min_amount_in = '55001'; })).quotes).toEqual([]);
    expect((await run('quote-btc-eth', (f) => { f.body.fees.outbound = '1961152'; f.body.fees.total = String(1961152 + 209); })).quotes).toEqual([]);
  });
  it('halted chain per inbound_addresses (Maya has no trading-pause flags there)', async () => {
    const inb = clone(fx('inbound_addresses')); inb.body.find((x: any) => x.chain === 'ETH').halted = true;
    expect((await run('quote-btc-eth', undefined, { inbound: inb })).quotes).toEqual([]);
    const parsed = InboundSchema.parse(fx('inbound_addresses').body);
    expect(['BTC', 'ETH', 'ARB'].map((c) => chainBlocked(parsed, c))).toEqual([null, null, null]);
  });
  it('other refusals and transport failures throw', async () => {
    await expect(run('quote-btc-eth', (f) => Object.assign(f, fx('error-bad-destination')))).rejects.toMatchObject({ provider: 'maya', code: 'http' });
    const p = provider(), req = requestFor(p, fx('quote-btc-eth'), families);
    await expect(p.quote(req, replay('maya', DIR, () => new Response('', { status: 429 })).ctx)).rejects.toMatchObject({ code: 'rate_limited' });
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const rt = new ProviderRuntime(provider(), { ...DEFAULT_POLICY, timeoutMs: 40 }, httpClient('maya', hang as unknown as typeof fetch));
    await expect(rt.quote(req)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('hostile or malformed answers', () => {
  const bad = async (name: string, mutate: (f: Fixture) => void) => { await expect(run(name, mutate), mutate.toString()).rejects.toMatchObject({ provider: 'maya', code: 'schema' }); };
  it('recipient, asset, limit, streaming interval, router, amounts', async () => {
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0x000000000000000000000000000000000000dEaD'); });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('=:e:', '=:a:'); });           // Arbitrum ETH instead of Ethereum ETH
    await bad('quote-btc-usdc', (f) => { f.body.memo = f.body.memo.replace('ETH.USDC', 'ARB.USDC'); });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace(':1961152/', ':1/'); });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('/3/0', ''); });                 // we asked for interval 3
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('/3/0', '/3/0:maya:100'); });
    await bad('quote-eth-btc', (f) => { f.body.router = '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146'; }); // THORChain's router is not Maya's
    await bad('quote-arbeth-btc', (f) => { f.body.router = '0xe3985E6b61b814F7Cdb188766562ba71b446B46d'; }); // Maya's Ethereum router on Arbitrum
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = '1971008.9'; });
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = -1971008; });
    await bad('quote-btc-eth', (f) => { delete f.body.fees.outbound; });
    await bad('quote-btc-eth', (f) => { f.body.fees.asset = 'ARB.ETH'; });
    await bad('quote-btc-eth', (f) => { f.body.error = 'ignored'; f.body.expected_amount_out = 'x'; });
  });
  it('pins the API base', async () => {
    const { r } = await run('quote-btc-eth');
    expect(r.calls.every((u) => u.startsWith(MAYA_API + '/'))).toBe(true); expect(MAYA_API).toBe('https://mayanode.mayachain.info/mayachain');
  });
});

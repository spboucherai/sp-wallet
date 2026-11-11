// THORChain adapter, exercised with answers recorded from the live THORNode API on 2026-11-11 UTC (fixtures/thorchain).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NETWORKS } from '@spw/core';
import { checkQuote, DEFAULT_POLICY, httpClient, ProviderRuntime, QuoteAggregator, type AssetRef, type SwapQuote } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import {
  chainBlocked, createNativeSwapProvider, fromProtocolAmount, InboundSchema, liquidityToleranceLimit, mapPools, memoAssetMatches, parseSwapMemo,
  THORCHAIN_API, THORCHAIN_CONFIG, toProtocolAmount,
} from '../src/providers/thorchain.ts';
import { clone, loadFixture, quoteCall, replay, requestFor, type Fixture } from './native-swap-helpers.ts';

const DIR = 'thorchain';
const fx = (name: string) => loadFixture(DIR, name);
const provider = () => createNativeSwapProvider(THORCHAIN_CONFIG);
const families = Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, n.family]));
const token = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const BTC: AssetRef = { network: 'bitcoin', asset: 'native' }, ETH: AssetRef = { network: 'ethereum', asset: 'native' }, USDC = token('ethereum', 'USDC');

/** Replay one recorded quote through the adapter with the request that produced it. */
async function run(name: string, mutate?: (f: Fixture) => void, opts: Parameters<typeof replay>[3] = {}) {
  const p = provider(), f = clone(fx(name)); mutate?.(f);
  const req = requestFor(p, fx(name), families), r = replay('thorchain', DIR, f, opts);
  return { p, req, r, f, quotes: await p.quote(req, r.ctx) };
}
const one = (q: SwapQuote[]) => { expect(q).toHaveLength(1); return q[0]!; };

describe('1e8 fixed point ⇄ asset decimals', () => {
  it('scales up exactly for assets with more than 8 decimals and floors the sub-1e-8 remainder on the way in', () => {
    expect(fromProtocolAmount(1959847n, 18)).toBe(19598470000000000n);            // 0.01959847 ETH
    expect(fromProtocolAmount(50_000_000n, 9)).toBe(500_000_000n);                // 0.5 SOL
    expect(toProtocolAmount(20_000_000_000_000_000n, 18)).toBe(2_000_000n);       // 0.02 ETH
    expect(toProtocolAmount(20_000_009_999_999_999n, 18)).toBe(2_000_000n);       // the last 9 999 999 999 wei are not credited
    expect(toProtocolAmount(9_999_999_999n, 18)).toBe(0n);
    expect(toProtocolAmount(500_000_000n, 9)).toBe(50_000_000n);
  });
  it('is the identity at 8 decimals and scales down exactly below 8, flooring on the way out', () => {
    expect(toProtocolAmount(55_000n, 8)).toBe(55_000n); expect(fromProtocolAmount(54_503n, 8)).toBe(54_503n);
    expect(toProtocolAmount(40_000_000n, 6)).toBe(4_000_000_000n);                // 40 USDC
    expect(fromProtocolAmount(4_019_330_000n, 6)).toBe(40_193_300n);              // 40.1933 USDC
    expect(fromProtocolAmount(3_979_136_799n, 6)).toBe(39_791_367n);              // never rounds up
    expect(fromProtocolAmount(99n, 6)).toBe(0n);
    expect(fromProtocolAmount(12_345n, 2)).toBe(0n); expect(fromProtocolAmount(1_234_567_890n, 2)).toBe(1234n); // GUSD-like, 2 decimals
    expect(toProtocolAmount(7n, 0)).toBe(700_000_000n);
  });
  it('never touches a JS number: values far beyond 2^53 stay exact', () => {
    const wei = 123_456_789_012_345_678_901_234_567_890n;
    expect(toProtocolAmount(wei, 18)).toBe(12_345_678_901_234_567_890n);
    expect(fromProtocolAmount(12_345_678_901_234_567_890n, 18)).toBe(123_456_789_012_345_678_900_000_000_000n);
  });
  it('round-trips: out→in is exact, in→out loses strictly less than one protocol unit', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 24 }), (v, d) => {
      expect(toProtocolAmount(fromProtocolAmount(v, d), d)).toBe(d >= 8 ? v : (v / 10n ** BigInt(8 - d)) * 10n ** BigInt(8 - d));
      const back = fromProtocolAmount(toProtocolAmount(v, d), d);
      expect(back <= v).toBe(true);
      expect(v - back < (d > 8 ? 10n ** BigInt(d - 8) : 1n)).toBe(true);
    }));
  });
  it('rejects negative amounts and absurd decimals', () => {
    expect(() => toProtocolAmount(-1n, 8)).toThrow(); expect(() => fromProtocolAmount(-1n, 8)).toThrow();
    expect(() => toProtocolAmount(1n, 1.5)).toThrow(); expect(() => fromProtocolAmount(1n, 99)).toThrow();
  });
});

describe('limit arithmetic (liquidity_tolerance_bps)', () => {
  it('reproduces the limit THORNode wrote in every recorded memo', () => {
    for (const name of ['quote-btc-eth', 'quote-eth-btc', 'quote-btc-usdc', 'quote-doge-btc', 'quote-usdc-btc', 'quote-sol-trx', 'quote-xrp-atom', 'quote-btc-eth-streaming']) {
      const f = fx(name), bps = Number(new URL(f.url).searchParams.get('liquidity_tolerance_bps'));
      expect(liquidityToleranceLimit(BigInt(f.body.expected_amount_out), bps), name).toBe(parseSwapMemo(f.body.memo).limit);
    }
  });
  it('floors, and refuses tolerances the protocol cannot express', () => {
    expect(liquidityToleranceLimit(1959847n, 50)).toBe(1950047n);   // 1959847 × 0.995 = 1950047.765
    expect(liquidityToleranceLimit(199n, 9999)).toBe(0n);
    for (const bad of [0, 10_000, -1, 0.5, NaN]) expect(() => liquidityToleranceLimit(1n, bad)).toThrow();
  });
});

describe('memo parsing', () => {
  it('reads plain and streaming limits', () => {
    expect(parseSwapMemo('=:e:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:1950047')).toEqual({ asset: 'e', destination: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', limit: 1950047n, interval: null, quantity: null });
    expect(parseSwapMemo(fx('quote-btc-eth-streaming').body.memo)).toMatchObject({ limit: 69499775758n, interval: 0, quantity: 370 });
  });
  it('rejects everything this adapter never asks for', () => {
    for (const m of ['=:e:0xabc', '=:e:0xabc:100:t:10', '=:e:0xabc/bc1qrefund:100', '+:e:0xabc:100', 'SWAP:e:0xabc:100', '=<:e:0xabc:100', '=:e:0xabc:1e6', '=:e:0xabc:100/1', '=:e:0xabc:-5', '=:e:0xabc:1.5', '=:e:0xabc:', '=:e:0xabc:100/0/370/9'])
      expect(() => parseSwapMemo(m), m).toThrow();
  });
  it('accepts only spellings of the requested asset', () => {
    const usdc = 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', sc = THORCHAIN_CONFIG.shortCodes;
    for (const ok of [usdc, usdc.toLowerCase(), 'ETH.USDC', 'ETH.USDC-6EB48', 'eth.usdc-eb48']) expect(memoAssetMatches(ok, usdc, sc), ok).toBe(true);
    for (const bad of ['ETH.USDT', 'AVAX.USDC', 'ETH.USDC-', 'ETH.USDC-EC7', 'e', 'b', 'ETH', 'USDC', 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB49']) expect(memoAssetMatches(bad, usdc, sc), bad).toBe(false);
    expect(memoAssetMatches('e', 'ETH.ETH', sc)).toBe(true); expect(memoAssetMatches('ETH.ETH', 'ETH.ETH', sc)).toBe(true);
    expect(memoAssetMatches('f', 'ETH.ETH', sc)).toBe(false); // BASE.ETH
    expect(memoAssetMatches('ETH', 'ETH.ETH', sc)).toBe(false);
  });
});

describe('asset mapping against the wallet registry', () => {
  const p = provider(), mapped = [...p.assets.values()];
  it('serves exactly the registry assets that have an Available pool, matched by chain + contract', () => {
    expect(mapped.map((a) => a.notation).sort()).toEqual([
      'AVAX.AVAX', 'AVAX.USDC-0XB97EF9EF8734C71904D8002F8B6BC66DD9C48A6E', 'AVAX.USDT-0X9702230A8EA53601F5CD2DC00FDBC13D4DF4A8C7',
      'BASE.ETH', 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', 'BCH.BCH', 'BSC.BNB', 'BTC.BTC', 'DOGE.DOGE',
      'ETH.AAVE-0X7FC66500C84A76AD7E9C93437BFC5AC33E2DDAE9', 'ETH.DAI-0X6B175474E89094C44DA98B954EEDEAC495271D0F', 'ETH.ETH',
      'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7',
      'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599', 'GAIA.ATOM', 'LTC.LTC', 'SOL.SOL', 'TRON.TRX',
      'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T', 'XRP.XRP',
    ]);
    for (const a of mapped) {
      const net = NETWORKS[a.ref.network]!, def = a.ref.asset === 'native' ? net.native : net.tokens.find((t) => t.id === a.ref.asset)!;
      expect(def.decimals, a.notation).toBe(a.decimals);
      if (a.ref.asset !== 'native') expect(a.notation.split('-')[1], a.notation).toBe(a.ref.asset.toUpperCase());
    }
    expect(p.capabilities()).toMatchObject({ crossChain: true, needsKey: false, configured: true, kinds: ['native_swap'] });
    expect(p.capabilities().networks.sort()).toEqual(['avalanche', 'base', 'bitcoin', 'bitcoincash', 'bsc', 'cosmos', 'dogecoin', 'ethereum', 'litecoin', 'solana', 'tron', 'xrpl']);
  });
  it('every pinned pool was Available in the recorded pool list, and recorded pool decimals agree with the registry', () => {
    const pools = fx('pools').body as { asset: string; status: string; decimals?: number; trading_halted?: boolean }[];
    for (const n of THORCHAIN_CONFIG.pools) expect(pools.find((x) => x.asset === n), n).toMatchObject({ status: 'Available', trading_halted: false });
    // nothing Available on a wallet chain is missing from the pinned list
    const chains = Object.keys(THORCHAIN_CONFIG.chains);
    const live = mapPools({ chains: THORCHAIN_CONFIG.chains, pools: pools.filter((x) => x.status === 'Available' && chains.includes(x.asset.split('.')[0]!)).map((x) => x.asset) });
    expect([...live.keys()].sort()).toEqual([...p.assets.keys()].sort());
    // THORNode reports `decimals` only for assets with fewer than 8 (or chain-specific) decimals
    for (const a of mapped) { const d = pools.find((x) => x.asset === a.notation)!.decimals; if (d) expect(d, a.notation).toBe(a.decimals); else expect(a.decimals, a.notation).toBeGreaterThanOrEqual(8); }
  });
  it('never maps by ticker: a pool with a known ticker but an unknown contract, or on an unmapped chain, is dropped', () => {
    const m = mapPools({ chains: THORCHAIN_CONFIG.chains, pools: ['ETH.USDC-0X000000000000000000000000000000000000DEAD', 'ETH.USDC', 'ZEC.ZEC', 'THOR.RUJI', 'ETH.LINK', 'BSC.ETH-0X2170ED0880AC9A755FD29B2688956BD959F933F8', 'ETH.BTC', 'eth.eth', 'ETH.ETH'] });
    expect([...m.values()].map((a) => a.notation)).toEqual(['ETH.ETH']);
  });
  it('supportsPair is local and strict', () => {
    expect(p.supportsPair(BTC, ETH)).toBe(true); expect(p.supportsPair(BTC, USDC)).toBe(true);
    expect(p.supportsPair(BTC, BTC)).toBe(false);
    expect(p.supportsPair(BTC, token('ethereum', 'LINK'))).toBe(false);          // pool is Staged
    expect(p.supportsPair(BTC, { network: 'stellar', asset: 'native' })).toBe(false);
    expect(p.supportsPair(BTC, { network: 'ethereum', asset: '0x000000000000000000000000000000000000dEaD' })).toBe(false);
    expect(p.supportsPair({ network: 'nope', asset: 'native' }, BTC)).toBe(false);
    expect(p.supportsPair(BTC, { network: 'ethereum', asset: USDC.asset.toLowerCase() })).toBe(true);
  });
  it('is registered', () => { expect(createProviders().map((x) => x.id)).toEqual(['thorchain', 'maya']); });
});

describe('quote mapping from recorded answers', () => {
  it('BTC → ETH: sends exactly the recorded request and maps every field', async () => {
    const { req, r, quotes, f } = await run('quote-btc-eth');
    expect(quoteCall(r)).toBe(f.url);
    expect(r.calls).toHaveLength(2); // one round: quote + inbound_addresses, concurrently
    const q = one(quotes);
    expect(q).toMatchObject({ provider: 'thorchain', request: req, atomic: false, refundable: true, firmness: 'indicative', priceImpactBps: 19, estimatedSeconds: 606, expiresAt: 1794360125000 });
    expect(q.amountOut).toBe(19_598_470_000_000_000n);       // 0.01959847 ETH
    expect(q.minAmountOut).toBe(19_500_470_000_000_000n);    // memo limit 1950047 = floor(1959847 × 9950 / 10000)
    expect(q.fees).toEqual([
      { kind: 'protocol', asset: ETH, amount: 39_500_000_000_000n, includedInOutput: true, estimated: true },
      { kind: 'network', asset: ETH, amount: 121_830_000_000_000n, includedInOutput: true, estimated: true },
    ]);
    expect(q.executability.class).toBe('quote_only');
    expect(q.steps).toEqual([{ kind: 'native_swap', provider: 'thorchain', from: BTC, to: ETH, via: ['THORChain', 'BTC.BTC → ETH.ETH', 'single swap'],
      contracts: [{ network: 'bitcoin', address: 'bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx', role: 'vault' }] }]);
    expect(q.raw).toMatchObject({ quote: f.body, amount1e8: '55000', limit1e8: '1950047', guaranteed1e8: '1950047', dustThreshold1e8: '1000', recommendedMinAmountIn1e8: '6108',
      inboundConfirmationSeconds: 600, outboundDelaySeconds: 6, streaming: { quoted: false, quantity: 1, maxQuantity: 1 } });
    expect(checkQuote(q, req, r.ctx.now())).toBeNull();
  });
  it('ETH → BTC: 18-decimal input, router named and pinned', async () => {
    const { req, r, quotes, f } = await run('quote-eth-btc');
    expect(req.amountIn).toBe(20_000_000_000_000_000n); expect(quoteCall(r)).toBe(f.url);
    const q = one(quotes);
    expect([q.amountOut, q.minAmountOut]).toEqual([54_503n, 54_230n]);
    expect(q.fees.map((x) => [x.kind, x.amount])).toEqual([['protocol', 111n], ['network', 1043n]]);
    expect(q.steps[0]!.contracts).toEqual([
      { network: 'ethereum', address: '0x6b4068070d95d87b321909bb21c8979fba2b8876', role: 'vault' },
      { network: 'ethereum', address: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146', role: 'router' }]);
    expect(q.estimatedSeconds).toBe(30);
  });
  it('BTC → USDC (6 decimals): output and fees floored to real base units, memo abbreviation accepted', async () => {
    const { req, quotes, f } = await run('quote-btc-usdc');
    expect(f.body.memo.startsWith('=:ETH.USDC:')).toBe(true); expect(req.slippageBps).toBe(100);
    const q = one(quotes);
    expect(q.amountOut).toBe(40_193_300n);      // 40.1933 USDC
    expect(q.minAmountOut).toBe(39_791_367n);   // 3979136700 / 100
    expect(q.fees.map((x) => x.amount)).toEqual([81_010n, 250_071n]);
    expect(q.fees.every((x) => x.asset.asset === USDC.asset)).toBe(true);
  });
  it('USDC → BTC: 6-decimal input scaled ×100, ERC-20 source goes through the router', async () => {
    const { req, r, quotes, f } = await run('quote-usdc-btc');
    expect(req.amountIn).toBe(40_000_000n); expect(quoteCall(r)).toBe(f.url);
    const q = one(quotes);
    expect([q.amountOut, q.minAmountOut]).toEqual([53_112n, 52_846n]);
    expect(q.steps[0]!.contracts.map((c) => c.role)).toEqual(['vault', 'router']);
  });
  it('DOGE → BTC, SOL → TRX, XRP → ATOM: per-chain decimals', async () => {
    const d = one((await run('quote-doge-btc')).quotes);
    expect([d.request.amountIn, d.amountOut, d.minAmountOut, d.estimatedSeconds]).toEqual([60_000_000_000n, 54_375n, 54_103n, 126]);
    const s = await run('quote-sol-trx'); const sq = one(s.quotes);
    expect(s.req.amountIn).toBe(500_000_000n);                                  // 0.5 SOL, 9 decimals
    expect([sq.amountOut, sq.minAmountOut]).toEqual([129_263_282n, 128_616_965n]); // TRX, 6 decimals: 12861696559 → floor
    expect(sq.fees.map((x) => x.amount)).toEqual([261_752n, 1_384_481n]);
    const x = await run('quote-xrp-atom'); const xq = one(x.quotes);
    expect(x.req.amountIn).toBe(40_000_000n);
    expect([xq.amountOut, xq.minAmountOut, xq.priceImpactBps]).toEqual([29_693_808n, 29_545_338n, 20]);
  });
  it('reports a streaming swap when the network quotes one (20 BTC → ETH, 370 sub-swaps)', async () => {
    const { req, quotes } = await run('quote-btc-eth-streaming');
    const q = one(quotes);
    expect(req.slippageBps).toBe(300);
    expect(q.amountOut).toBe(716_492_533_590_000_000_000n);
    expect(q.minAmountOut).toBe(694_997_757_580_000_000_000n);
    expect(q.steps[0]!.via[2]).toBe('streaming swap: 370 sub-swaps');
    expect(q.raw).toMatchObject({ streaming: { quoted: true, interval: 0, quantity: 370, maxQuantity: 370, seconds: 744 }, outboundDelaySeconds: 1200 });
    expect(q.estimatedSeconds).toBe(2400);
  });
  it('all good quotes survive the aggregator through the real runtime', async () => {
    const p = provider(), f = fx('quote-btc-eth'), req = requestFor(p, f, families), r = replay('thorchain', DIR, f);
    const agg = new QuoteAggregator([new ProviderRuntime(p, DEFAULT_POLICY, r.ctx.http, r.ctx.now)], r.ctx.now);
    const { quotes, events } = await agg.collect(req);
    expect(quotes).toHaveLength(1); expect(events.filter((e) => e.type === 'provider')).toEqual([]);
  });
  it('re-uses the halt flags for 15 s but asks for a fresh quote (and vault) every time', async () => {
    const p = provider(), f = fx('quote-btc-eth'), req = requestFor(p, f, families);
    let now = Date.parse(f.recordedAt); const r = replay('thorchain', DIR, f); const ctx = { ...r.ctx, now: () => now };
    await p.quote(req, ctx); now += 10_000; await p.quote(req, ctx);
    expect(r.calls.filter((u) => u.endsWith('/inbound_addresses'))).toHaveLength(1); expect(r.calls.filter((u) => u.includes('/quote/swap?'))).toHaveLength(2);
    now += 6_000; await p.quote(req, ctx);
    expect(r.calls.filter((u) => u.endsWith('/inbound_addresses'))).toHaveLength(2);
  });
});

describe('no route', () => {
  it('pool not Available (recorded refusal for the Staged ETH.LINK pool)', async () => {
    expect(fx('error-pool-not-available').body.message).toMatch(/pool\(ETH\.LINK-.*\) is not available/);
    expect((await run('quote-btc-eth', (f) => Object.assign(f, fx('error-pool-not-available')))).quotes).toEqual([]);
  });
  it('amount below the dust threshold / below the minimum swap amount (recorded refusals)', async () => {
    expect((await run('quote-btc-eth', (f) => Object.assign(f, fx('error-below-dust')))).quotes).toEqual([]);
    expect(fx('error-doge-below-min').body.message).toMatch(/min swap amount \(recommended_min_amount_in: \d+\)/);
    expect((await run('quote-doge-btc', (f) => Object.assign(f, fx('error-doge-below-min')))).quotes).toEqual([]);
  });
  it('amount below recommended_min_amount_in even though THORNode still answers a quote (3000 sats, minimum 6117)', async () => {
    const { quotes, f } = await run('quote-below-recommended-min');
    expect(BigInt(f.body.expected_amount_out) > 0n).toBe(true); expect(quotes).toEqual([]);
  });
  it('amount at the dust threshold is refused even if a quote comes back', async () => {
    expect((await run('quote-btc-eth', (f) => { f.body.dust_threshold = '55000'; f.body.recommended_min_amount_in = '1'; })).quotes).toEqual([]);
  });
  it('source or destination chain halted, or trading paused, per inbound_addresses', async () => {
    const flip = (chain: string, key: string) => { const inb = clone(fx('inbound_addresses')); inb.body.find((x: any) => x.chain === chain)[key] = true; return inb; };
    for (const [chain, key] of [['BTC', 'halted'], ['ETH', 'halted'], ['ETH', 'chain_trading_paused'], ['BTC', 'global_trading_paused']] as const)
      expect((await run('quote-btc-eth', undefined, { inbound: flip(chain, key) })).quotes, `${chain}.${key}`).toEqual([]);
    const gone = clone(fx('inbound_addresses')); gone.body = gone.body.filter((x: any) => x.chain !== 'ETH');
    expect((await run('quote-btc-eth', undefined, { inbound: gone })).quotes).toEqual([]);
    // a halt elsewhere does not matter
    expect((await run('quote-btc-eth', undefined, { inbound: flip('DOGE', 'halted') })).quotes).toHaveLength(1);
    const inb = InboundSchema.parse(fx('inbound_addresses').body);
    expect(inb.map((x) => chainBlocked(inb, x.chain)).filter(Boolean)).toEqual([]);
    expect(chainBlocked(inb, 'KUJI')).toMatch(/not active/);
  });
  it('a trading-halt refusal from the quote simulation itself', async () => {
    expect((await run('quote-btc-eth', (f) => { f.status = 400; f.body = { code: 3, message: 'failed to simulate swap: failed to validate message: trading is halted, can\'t process swap: invalid request', details: [] }; })).quotes).toEqual([]);
  });
  it('unsupported pairs, zero tolerance, sub-unit amounts: no HTTP at all', async () => {
    const p = provider(), r = replay('thorchain', DIR, fx('quote-btc-eth')), base = requestFor(p, fx('quote-btc-eth'), families);
    expect(await p.quote({ ...base, to: { network: 'stellar', asset: 'native' } }, r.ctx)).toEqual([]);
    expect(await p.quote({ ...base, slippageBps: 0 }, r.ctx)).toEqual([]);
    expect(await p.quote({ ...base, slippageBps: 12.5 }, r.ctx)).toEqual([]);
    expect(await p.quote({ ...base, slippageBps: 10_000 }, r.ctx)).toEqual([]);
    expect(await p.quote({ ...base, amountIn: 0n }, r.ctx)).toEqual([]);
    expect(await p.quote({ ...base, from: ETH, to: BTC, amountIn: 9_999_999_999n }, r.ctx)).toEqual([]); // < 1e-8 ETH
    expect(r.calls).toEqual([]);
  });
});

describe('provider failures throw', () => {
  it('stale node (recorded): retried once on the gateway, then → unavailable', async () => {
    const p = provider(), req = requestFor(p, fx('quote-btc-eth'), families), stale = fx('error-stale-node'), good = fx('quote-btc-eth');
    const answer = (f: Fixture) => new Response(JSON.stringify(f.body), { status: f.status });
    let n = 0; const twice = replay('thorchain', DIR, () => { n += 1; return answer(stale); }, { now: Date.parse(good.recordedAt) });
    await expect(p.quote(req, twice.ctx)).rejects.toMatchObject({ provider: 'thorchain', code: 'unavailable' }); expect(n).toBe(2);
    let m = 0; const once = replay('thorchain', DIR, () => { m += 1; return answer(m === 1 ? stale : good); }, { now: Date.parse(good.recordedAt) });
    expect(await provider().quote(req, once.ctx)).toHaveLength(1); expect(m).toBe(2);
  });
  it('a refusal that is neither a halt nor a minimum (recorded: destination on the wrong chain) → http', async () => {
    await expect(run('quote-btc-eth', (f) => Object.assign(f, fx('error-bad-destination')))).rejects.toMatchObject({ code: 'http' });
  });
  it('rate limit, gateway HTML, 5xx', async () => {
    const p = provider(), req = requestFor(p, fx('quote-btc-eth'), families);
    await expect(p.quote(req, replay('thorchain', DIR, () => new Response('', { status: 429 })).ctx)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(provider().quote(req, replay('thorchain', DIR, () => new Response('<html>Just a moment...</html>', { status: 200 })).ctx)).rejects.toMatchObject({ code: 'bad_response' });
    await expect(provider().quote(req, replay('thorchain', DIR, () => new Response('{"oops":1}', { status: 502 })).ctx)).rejects.toMatchObject({ code: 'http' });
  });
  it('fails closed when the halt flags cannot be read', async () => {
    const p = provider(), req = requestFor(p, fx('quote-btc-eth'), families);
    await expect(p.quote(req, replay('thorchain', DIR, fx('quote-btc-eth'), { inbound: () => new Response('{}', { status: 503 }) }).ctx)).rejects.toMatchObject({ code: 'http' });
    await expect(p.quote(req, replay('thorchain', DIR, fx('quote-btc-eth'), { inbound: () => new Response('[{"chain":"BTC","address":"x"}]', { status: 200 }) }).ctx)).rejects.toMatchObject({ code: 'schema' });
  });
  it('times out through the runtime and reports an abort as a timeout', async () => {
    const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const p = provider(), req = requestFor(p, fx('quote-btc-eth'), families);
    const rt = new ProviderRuntime(p, { ...DEFAULT_POLICY, timeoutMs: 40 }, httpClient('thorchain', hang as unknown as typeof fetch));
    await expect(rt.quote(req)).rejects.toMatchObject({ code: 'timeout' }); expect(rt.stats().timeouts).toBe(1);
    const ac = new AbortController(); const pending = p.quote(req, { signal: ac.signal, http: httpClient('thorchain', hang as unknown as typeof fetch), now: Date.now }); ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('hostile or malformed answers are rejected (schema)', () => {
  const bad = async (name: string, mutate: (f: Fixture) => void, code = 'schema') => { await expect(run(name, mutate), mutate.toString()).rejects.toMatchObject({ provider: 'thorchain', code }); };
  it('output for another recipient, or a refund/affiliate/aggregator smuggled into the memo', async () => {
    await bad('quote-btc-eth', (f) => { f.body.memo = '=:e:0x000000000000000000000000000000000000dEaD:1950047'; });
    await bad('quote-btc-eth', (f) => { f.body.memo += ':t:50'; });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace(':1950047', '/bc1qattacker:1950047'); });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('=:', '+:'); });
    await bad('quote-btc-eth', (f) => { f.body.memo += '/1/0'; }); // an interval we did not ask for
    // the recipient check is case-insensitive only where the chain is (EVM), exact elsewhere
    expect((await run('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'); })).quotes).toHaveLength(1);
    await bad('quote-eth-btc', (f) => { f.body.memo = f.body.memo.replace('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH'); });
  });
  it('wrong target asset: other token, ticker look-alike, other chain', async () => {
    await bad('quote-btc-usdc', (f) => { f.body.memo = f.body.memo.replace('ETH.USDC', 'ETH.USDT'); });
    await bad('quote-btc-usdc', (f) => { f.body.memo = f.body.memo.replace('ETH.USDC', 'AVAX.USDC'); });
    await bad('quote-btc-usdc', (f) => { f.body.memo = f.body.memo.replace('ETH.USDC', 'ETH.USDC-0X000000000000000000000000000000000000DEAD'); });
    await bad('quote-btc-usdc', (f) => { f.body.fees.asset = 'ETH.USDC-0X000000000000000000000000000000000000DEAD'; });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace('=:e:', '=:f:'); });
    await bad('quote-btc-eth', (f) => { f.body.fees.asset = 'BASE.ETH'; });
  });
  it('a limit that is not the requested tolerance', async () => {
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace(':1950047', ':1'); });
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace(':1950047', ':1950046'); });
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = '9959847'; }); // inflated output, memo limit left behind
    await bad('quote-btc-eth', (f) => { f.body.memo = f.body.memo.replace(':1950047', ''); });
  });
  it('float, negative, numeric or missing amounts', async () => {
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = '1959847.5'; });
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = '-1959847'; });
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = 1959847; });
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = '1.959847e6'; });
    await bad('quote-btc-eth', (f) => { f.body.expected_amount_out = '01959847'; });
    await bad('quote-btc-eth', (f) => { delete f.body.expected_amount_out; });
    await bad('quote-btc-eth', (f) => { delete f.body.memo; });
    await bad('quote-btc-eth', (f) => { delete f.body.fees; });
    await bad('quote-btc-eth', (f) => { delete f.body.recommended_min_amount_in; });
    await bad('quote-btc-eth', (f) => { f.body.fees.outbound = '-1'; });
    await bad('quote-btc-eth', (f) => { f.body.fees.liquidity = 3950; });
    await bad('quote-btc-eth', (f) => { f.body.fees.slippage_bps = 19.5; });
    await bad('quote-btc-eth', (f) => { f.body.fees.slippage_bps = 10_001; });
    await bad('quote-btc-eth', (f) => { f.body.expiry = '1794360125'; });
    await bad('quote-btc-eth', (f) => { f.body.total_swap_seconds = -5; });
    await bad('quote-btc-eth', (f) => { f.body = [f.body]; });
    await bad('quote-btc-eth', (f) => { f.body = null; });
  });
  it('fees that do not add up, or an affiliate nobody asked for', async () => {
    await bad('quote-btc-eth', (f) => { f.body.fees.total = '16134'; });
    await bad('quote-btc-eth', (f) => { f.body.fees.affiliate = '100'; f.body.fees.total = '16233'; });
  });
  it('router not pinned, router on a UTXO source, missing router on an EVM source, vault = router or = sender', async () => {
    await bad('quote-eth-btc', (f) => { f.body.router = '0x000000000000000000000000000000000000dEaD'; });
    await bad('quote-eth-btc', (f) => { delete f.body.router; });
    await bad('quote-eth-btc', (f) => { f.body.router = 'not-an-address'; });
    await bad('quote-eth-btc', (f) => { f.body.inbound_address = f.body.router; });
    await bad('quote-eth-btc', (f) => { f.body.inbound_address = 'bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx'; });
    await bad('quote-eth-btc', (f) => { f.body.inbound_address = '0x000000000000000000000000000000000000dEaD'; }); // the sender
    await bad('quote-btc-eth', (f) => { f.body.router = '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146'; });
    await bad('quote-btc-eth', (f) => { f.body.inbound_address = 'x'; });
    await bad('quote-btc-eth', (f) => { f.body.inbound_address = 'bc1q<script>alert(1)</script>aaaaaaaaaaaaaaaaaaaa'; });
    // inbound_addresses and the quote must name the same router
    const inb = clone(fx('inbound_addresses')); inb.body.find((x: any) => x.chain === 'ETH').router = '0x000000000000000000000000000000000000dEaD';
    await expect(run('quote-eth-btc', undefined, { inbound: inb })).rejects.toMatchObject({ code: 'schema' });
  });
  it('expiry in the past (stale answer) or absurdly far ahead', async () => {
    await bad('quote-btc-eth', (f) => { f.body.expiry = 1794359000; }, 'bad_response');
    await bad('quote-btc-eth', (f) => { f.body.expiry = 1794360125 + 86_400; });
  });
  it('pins the API base and identifies itself', async () => {
    const { r } = await run('quote-btc-eth');
    expect(r.calls.every((u) => u.startsWith(THORCHAIN_API + '/'))).toBe(true);
    expect(THORCHAIN_API).toBe('https://gateway.liquify.com/chain/thorchain_api/thorchain');
  });
});

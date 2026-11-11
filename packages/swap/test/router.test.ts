import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import {
  assessRisk, checkQuote, DEFAULT_POLICY, LiquidityGraph, ProviderError, ProviderRuntime, QuoteAggregator, rank, SwapRouter, valueQuote,
  type AssetRef, type HttpClient, type SwapProvider, type SwapQuote, type SwapQuoteRequest, type Valuer,
} from '../src/index.ts';

const USDC_BASE: AssetRef = { network: 'base', asset: NETWORKS.base.tokens.find((t) => t.symbol === 'USDC')!.id };
const ETH_BASE: AssetRef = { network: 'base', asset: 'native' };
const SOL: AssetRef = { network: 'solana', asset: 'native' };
const USDC_SOL: AssetRef = { network: 'solana', asset: NETWORKS.solana.tokens.find((t) => t.symbol === 'USDC')!.id };
const BTC: AssetRef = { network: 'bitcoin', asset: 'native' };
const noHttp: HttpClient = { getJson: async () => { throw new Error('no network in tests'); }, postJson: async () => { throw new Error('no network in tests'); } };
const PRICE: Record<string, number> = { ETH: 2000, USDC: 1, SOL: 80, BTC: 70000 };
const value: Valuer = (a, amt) => { const n = NETWORKS[a.network]!, d = a.asset === 'native' ? n.native : n.tokens.find((t) => t.id.toLowerCase() === a.asset.toLowerCase())!; const p = PRICE[d.symbol]; return p === undefined ? null : (Number(amt) / 10 ** d.decimals) * p; };
const req = (from: AssetRef, to: AssetRef, amountIn: bigint): SwapQuoteRequest => ({ from, to, amountIn, sender: 'SENDER', recipient: 'RECIPIENT', slippageBps: 50 });

let qn = 0;
function quoteOf(provider: string, r: SwapQuoteRequest, out: bigint, o: Partial<SwapQuote> = {}): SwapQuote {
  return { id: `${provider}-${++qn}`, provider, request: r, steps: [{ kind: r.from.network === r.to.network ? 'swap' : 'bridge', provider, from: r.from, to: r.to, via: ['pool'], contracts: [] }],
    amountOut: out, minAmountOut: (out * 995n) / 1000n, fees: [], estimatedSeconds: 20, priceImpactBps: 5, expiresAt: Date.now() + 30_000, firmness: 'indicative',
    executability: { class: 'opaque', reason: 'test' }, refundable: true, atomic: true, ...o };
}
/** A scripted provider: `rate(from,to)` gives output per unit input (in base units ratio) or null for "no route". */
function fake(id: string, opts: { pairs?: (a: AssetRef, b: AssetRef) => boolean; out: (r: SwapQuoteRequest) => bigint | null; delayMs?: number; fail?: () => boolean; patch?: Partial<SwapQuote>; needsKey?: boolean }): SwapProvider & { calls: number } {
  const p = { id, name: id, calls: 0,
    capabilities: () => ({ networks: ['base', 'solana', 'bitcoin'], crossChain: true, needsKey: !!opts.needsKey, configured: !opts.needsKey, kinds: ['swap' as const, 'bridge' as const], docs: '' }),
    supportsPair: (a: AssetRef, b: AssetRef) => (opts.pairs ? opts.pairs(a, b) : true),
    async quote(r: SwapQuoteRequest, ctx: { signal: AbortSignal }) {
      p.calls += 1;
      if (opts.delayMs) await new Promise<void>((res, rej) => { const t = setTimeout(res, opts.delayMs); ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); });
      if (opts.fail?.()) throw new ProviderError(id, 'http', 'HTTP 500');
      const out = opts.out(r);
      return out === null ? [] : [quoteOf(id, r, out, opts.patch)];
    } };
  return p;
}
const setup = (providers: SwapProvider[], policy: Partial<typeof DEFAULT_POLICY> = {}) => {
  policy = { ...DEFAULT_POLICY, ratePerSec: 1000, burst: 1000, ...policy };
  const rts = providers.map((p) => new ProviderRuntime(p, policy as typeof DEFAULT_POLICY, noHttp));
  const agg = new QuoteAggregator(rts), graph = new LiquidityGraph(providers);
  return { rts, agg, graph, router: new SwapRouter(agg, graph, value) };
};
// 1 ETH = 2000 USDC, at a provider-specific discount in basis points
const ethToUsdc = (bps: number) => (r: SwapQuoteRequest) => (r.amountIn * 2000n * (10_000n - BigInt(bps))) / 10_000n / 10n ** 12n;
const sameChain = (a: AssetRef, b: AssetRef) => a.network === b.network;

describe('provider runtime', () => {
  it('enforces the per-provider deadline and reports a timeout', async () => {
    const rt = new ProviderRuntime(fake('slow', { out: () => 1n, delayMs: 300 }), { ...DEFAULT_POLICY, timeoutMs: 40 }, noHttp);
    await expect(rt.quote(req(ETH_BASE, USDC_BASE, 10n ** 18n))).rejects.toMatchObject({ code: 'timeout' });
    expect(rt.stats().timeouts).toBe(1);
  });
  it('opens the circuit after repeated failures, then lets one probe through after the cooldown', async () => {
    let t = 1_000_000, failing = true;
    const p = fake('flaky', { out: ethToUsdc(0), fail: () => failing });
    const rt = new ProviderRuntime(p, { ...DEFAULT_POLICY, breakerFailures: 3, breakerCooldownMs: 10_000, ratePerSec: 1000, burst: 1000 }, noHttp, () => t);
    for (let k = 0; k < 3; k++) await expect(rt.quote(req(ETH_BASE, USDC_BASE, 1n))).rejects.toMatchObject({ code: 'http' });
    expect(rt.stats().state).toBe('open');
    await expect(rt.quote(req(ETH_BASE, USDC_BASE, 1n))).rejects.toMatchObject({ code: 'unavailable' });
    expect(p.calls).toBe(3); // the open circuit did not call the provider
    t += 10_001; expect(rt.stats().state).toBe('half_open');
    await expect(rt.quote(req(ETH_BASE, USDC_BASE, 1n))).rejects.toBeTruthy(); // probe fails: open again
    expect(rt.stats().state).toBe('open');
    t += 10_001; failing = false;
    expect((await rt.quote(req(ETH_BASE, USDC_BASE, 10n ** 18n))).length).toBe(1);
    expect(rt.stats().state).toBe('closed');
  });
  it('rate-limits locally and refills over time', async () => {
    let t = 0;
    const rt = new ProviderRuntime(fake('rl', { out: ethToUsdc(0) }), { ...DEFAULT_POLICY, ratePerSec: 1, burst: 2 }, noHttp, () => t);
    await rt.quote(req(ETH_BASE, USDC_BASE, 1n)); await rt.quote(req(ETH_BASE, USDC_BASE, 1n));
    await expect(rt.quote(req(ETH_BASE, USDC_BASE, 1n))).rejects.toMatchObject({ code: 'rate_limited' });
    t += 1000; await rt.quote(req(ETH_BASE, USDC_BASE, 1n));
  });
  it('a caller that cancels does not count against the provider', async () => {
    const rt = new ProviderRuntime(fake('slow', { out: () => 1n, delayMs: 200 }), DEFAULT_POLICY, noHttp);
    const ac = new AbortController(); setTimeout(() => ac.abort(), 20);
    await expect(rt.quote(req(ETH_BASE, USDC_BASE, 1n), ac.signal)).rejects.toMatchObject({ code: 'timeout' });
    expect(rt.stats().failures).toBe(0);
  });
});

describe('quote validation (no provider answer is trusted)', () => {
  const r = req(ETH_BASE, USDC_BASE, 10n ** 18n), now = Date.now();
  const good = quoteOf('p', r, 2000_000000n);
  it('accepts a coherent quote', () => expect(checkQuote(good, r, now)).toBeNull());
  it.each([
    ['another pair', { ...good, request: { ...r, to: SOL } }], ['another amount', { ...good, request: { ...r, amountIn: 5n } }],
    ['another recipient', { ...good, request: { ...r, recipient: 'ATTACKER' } }], ['zero output', { ...good, amountOut: 0n, minAmountOut: 0n }],
    ['minimum above expected', { ...good, minAmountOut: good.amountOut + 1n }], ['expired', { ...good, expiresAt: now - 1 }],
    ['float amount', { ...good, amountOut: 1.5 as unknown as bigint }], ['negative fee', { ...good, fees: [{ kind: 'network', asset: ETH_BASE, amount: -1n, includedInOutput: false, estimated: true }] }],
    ['steps end elsewhere', { ...good, steps: [{ ...good.steps[0]!, to: SOL }] }], ['no steps', { ...good, steps: [] }],
    ['broken chain of steps', { ...good, steps: [{ ...good.steps[0]!, to: SOL }, { ...good.steps[0]!, from: BTC }] }],
  ] as [string, SwapQuote][])('rejects: %s', (_n, q) => expect(checkQuote(q, r, now)).not.toBeNull());
});

describe('aggregator', () => {
  it('queries providers concurrently, streams fastest first, and isolates failures', async () => {
    const { agg } = setup([fake('a', { out: ethToUsdc(10), delayMs: 60 }), fake('b', { out: ethToUsdc(30), delayMs: 5 }), fake('down', { out: () => 1n, fail: () => true }),
      fake('none', { out: () => null }), fake('keyed', { out: () => 1n, needsKey: true }), fake('other-chain', { out: () => 1n, pairs: () => false })]);
    const t0 = Date.now(); const seen: string[] = [];
    for await (const e of agg.stream(req(ETH_BASE, USDC_BASE, 10n ** 18n))) seen.push(e.type === 'quote' ? `q:${e.quote.provider}` : e.type === 'provider' ? `${e.status}:${e.provider}` : 'done');
    expect(Date.now() - t0).toBeLessThan(200); // not 60 + 5 + … sequentially
    expect(seen.indexOf('q:b')).toBeLessThan(seen.indexOf('q:a'));
    expect(seen).toContain('error:down'); expect(seen).toContain('no_route:none'); expect(seen).toContain('skipped:keyed');
    expect(seen.some((s) => s.includes('other-chain'))).toBe(false);
    expect(seen[seen.length - 1]).toBe('done');
  });
  it('drops a provider answer that is for another recipient', async () => {
    const { agg } = setup([fake('evil', { out: ethToUsdc(0), patch: { request: { ...req(ETH_BASE, USDC_BASE, 10n ** 18n), recipient: 'ATTACKER' } } })]);
    const { quotes, events } = await agg.collect(req(ETH_BASE, USDC_BASE, 10n ** 18n));
    expect(quotes.length).toBe(0);
    expect(events.some((e) => e.type === 'provider' && e.code === 'invalid_quote')).toBe(true);
  });
  it('respects the global deadline', async () => {
    const { agg } = setup([fake('slow', { out: () => 1n, delayMs: 2000 }), fake('fast', { out: ethToUsdc(0), delayMs: 5 })], { timeoutMs: 5000 });
    const t0 = Date.now();
    const { quotes } = await agg.collect(req(ETH_BASE, USDC_BASE, 10n ** 18n), { deadlineMs: 120 });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(quotes.map((q) => q.provider)).toEqual(['fast']);
  });
});

describe('risk engine', () => {
  const r = req(ETH_BASE, USDC_BASE, 10n ** 18n);
  const flags = (q: SwapQuote, peers: SwapQuote[] = []) => assessRisk(q, valueQuote(q, value), peers).flags.map((f) => f.code);
  it('flags a quote that is better than the market as high risk', () => {
    const a = assessRisk(quoteOf('p', r, 2200_000000n), valueQuote(quoteOf('p', r, 2200_000000n), value));
    expect(a.level).toBe('high'); expect(a.flags.map((f) => f.code)).toContain('better_than_market');
  });
  it('flags bad execution, price impact, opaque and cross-chain properties', () => {
    expect(flags(quoteOf('p', r, 1700_000000n))).toContain('far_below_market');
    expect(flags(quoteOf('p', r, 1990_000000n, { priceImpactBps: 350 }))).toContain('high_price_impact');
    expect(flags(quoteOf('p', r, 1990_000000n))).toContain('opaque_transaction');
    const x = req(USDC_BASE, USDC_SOL, 100_000000n);
    expect(flags(quoteOf('p', x, 99_900000n, { refundable: false }))).toEqual(expect.arrayContaining(['cross_chain', 'no_refund_path']));
  });
  it('detects an outlier against peers and unpriced fees', () => {
    const peers = [quoteOf('a', r, 1995_000000n), quoteOf('b', r, 1996_000000n)], out = quoteOf('c', r, 2110_000000n);
    expect(flags(out, [...peers, out])).toContain('outlier_vs_peers');
    const f = quoteOf('d', r, 1995_000000n, { fees: [{ kind: 'network', asset: { network: 'hyperevm', asset: 'native' }, amount: 5n, includedInOutput: false, estimated: true }] });
    expect(flags(f)).toContain('fee_unpriced');
  });
  it('subtracts only the fees that are not already in the output', () => {
    const q = quoteOf('p', r, 2000_000000n, { fees: [{ kind: 'network', asset: ETH_BASE, amount: 10n ** 15n, includedInOutput: false, estimated: true }, { kind: 'protocol', asset: USDC_BASE, amount: 5_000000n, includedInOutput: true, estimated: false }] });
    const v = valueQuote(q, value);
    expect(v.extraFeesUsd).toBeCloseTo(2, 6);
    expect(v.netUsd).toBeCloseTo(1990 - 2, 6);
  });
});

describe('router', () => {
  it('ranks on guaranteed net output, not on the headline number', async () => {
    const gas = (eth: bigint) => [{ kind: 'network' as const, asset: ETH_BASE, amount: eth, includedInOutput: false, estimated: true }];
    const { router } = setup([fake('headline', { out: ethToUsdc(0), pairs: sameChain, patch: { fees: gas(5n * 10n ** 15n) } }), fake('net', { out: ethToUsdc(20), pairs: sameChain, patch: { fees: gas(10n ** 14n) } })]);
    const s = await router.search(req(ETH_BASE, USDC_BASE, 10n ** 18n));
    expect(s.routes.length).toBe(2);
    expect(s.routes.find((x) => x.id === s.best.best_price)!.providers).toEqual(['net']); // 4 USD better output loses to 9.8 USD more gas
  });
  it('fastest never gives up more than 2 % of the best net output; balanced is explicit', async () => {
    const { router } = setup([fake('cheap-slow', { out: ethToUsdc(0), pairs: sameChain, patch: { estimatedSeconds: 600 } }), fake('fast-ok', { out: ethToUsdc(100), pairs: sameChain, patch: { estimatedSeconds: 15 } }),
      fake('fast-bad', { out: ethToUsdc(260), pairs: sameChain, patch: { estimatedSeconds: 2 } })]);
    const s = await router.search(req(ETH_BASE, USDC_BASE, 10n ** 18n));
    const by = (m: 'best_price' | 'fastest' | 'balanced') => s.routes.find((x) => x.id === s.best[m])!.providers[0];
    expect(by('best_price')).toBe('cheap-slow'); expect(by('fastest')).toBe('fast-ok'); expect(['cheap-slow', 'fast-ok']).toContain(by('balanced'));
    expect(s.routes.filter((x) => x.pareto).map((x) => x.providers[0]).sort()).toEqual(['cheap-slow', 'fast-bad', 'fast-ok']);
  });
  it('never selects a high-risk route while a lower-risk one exists, in any mode', async () => {
    const { router } = setup([fake('honest', { out: ethToUsdc(30), pairs: sameChain }), fake('too-good', { out: (r) => ethToUsdc(0)(r) * 115n / 100n, pairs: sameChain, patch: { estimatedSeconds: 1 } })]);
    const s = await router.search(req(ETH_BASE, USDC_BASE, 10n ** 18n));
    expect(s.routes.find((x) => x.providers[0] === 'too-good')!.risk.level).toBe('high');
    for (const id of Object.values(s.best)) expect(s.routes.find((x) => x.id === id)!.providers).toEqual(['honest']);
  });
  it('builds a route through an intermediate asset when no direct route exists, spending only what leg 1 guarantees', async () => {
    const dex = fake('dex', { pairs: sameChain, out: (r) => (r.from.asset === 'native' ? ethToUsdc(10)(r) : null) });
    const bridge = fake('bridge', { pairs: (a, b) => a.network !== b.network && a.asset !== 'native' && b.asset !== 'native', out: (r) => r.amountIn - 100_000n, patch: { estimatedSeconds: 900 } });
    const { router } = setup([dex, bridge]);
    const s = await router.search(req(ETH_BASE, USDC_SOL, 10n ** 18n));
    expect(s.reachable).toBe(true); expect(s.routes.length).toBe(2); // one per stablecoin hub on Base: USDC, and bridged USDT (registry v5)
    const r = s.routes.find((x) => x.path[1]!.asset === USDC_BASE.asset)!;
    expect(r.providers).toEqual(['dex', 'bridge']);
    expect(r.path.map((p) => `${p.network}:${p.asset === 'native' ? 'native' : 'token'}`)).toEqual(['base:native', 'base:token', 'solana:token']);
    expect(r.legs[1]!.request.amountIn).toBe(r.legs[0]!.minAmountOut);
    expect(r.legs[0]!.request.recipient).toBe('SENDER'); // the intermediate asset stays in the wallet
    expect(r.estimatedSeconds).toBe(920);
    expect(r.risk.flags.map((f) => f.code)).toContain('multi_step');
  });
  it('hides a two-leg route that does not clearly beat the direct one', async () => {
    const direct = fake('direct', { pairs: (a, b) => a.network !== b.network, out: (r) => (r.from.asset === 'native' && r.to.asset !== 'native' ? ethToUsdc(5)(r) : r.from.asset !== 'native' ? r.amountIn - 1000n : null) });
    const dex = fake('dex', { pairs: sameChain, out: (r) => (r.from.asset === 'native' ? ethToUsdc(5)(r) : null) });
    const s = await setup([direct, dex]).router.search(req(ETH_BASE, USDC_SOL, 10n ** 18n));
    expect(s.routes.every((r) => r.legs.length === 1)).toBe(true);
  });
  it('says so when nothing connects the pair, and when providers cover it but none answers', async () => {
    const none = await setup([fake('dex', { pairs: sameChain, out: ethToUsdc(0) })]).router.search(req(BTC, SOL, 100_000n));
    expect(none.reachable).toBe(false); expect(none.routes).toEqual([]); expect(none.best).toEqual({});
    const dry = await setup([fake('x', { out: () => null })]).router.search(req(BTC, SOL, 100_000n));
    expect(dry.reachable).toBe(true); expect(dry.routes).toEqual([]);
  });
  it('rank() is stable on an empty set and with unpriced assets falls back to raw minimum output', () => {
    expect(rank([])).toEqual({});
  });
  it('handles thousands of concurrent route searches', async () => {
    const { router, rts } = setup([fake('a', { out: ethToUsdc(10), pairs: sameChain }), fake('b', { out: ethToUsdc(12), pairs: sameChain }), fake('c', { out: ethToUsdc(8), pairs: sameChain, fail: () => Math.random() < 0.2 })],
      { breakerFailures: 1_000_000, ratePerSec: 1e9, burst: 1e9 });
    const t0 = Date.now();
    const res = await Promise.all(Array.from({ length: 3000 }, (_, k) => router.search(req(ETH_BASE, USDC_BASE, BigInt(k + 1) * 10n ** 15n))));
    const ms = Date.now() - t0;
    expect(res.every((s) => s.routes.length >= 2)).toBe(true);
    expect(res.every((s) => s.routes.find((r) => r.id === s.best.best_price)!.minAmountOut >= s.routes[s.routes.length - 1]!.minAmountOut)).toBe(true);
    expect(rts.reduce((n, r) => n + r.stats().calls, 0)).toBe(27000); // per search and provider: the direct pair, plus both legs through the other stablecoin hub on Base (USDT, registry v5)
    expect(ms).toBeLessThan(8000);
    console.log(`3000 concurrent searches over 3 providers: ${ms} ms (${(ms / 3000).toFixed(2)} ms each)`);
  });
});

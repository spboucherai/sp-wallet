/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/jupiter.test.ts
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

// Jupiter adapter against REAL answers recorded from https://api.jup.ag/swap/v2 (scripts/record-swap-jupiter-fixtures.mts).
// No network: the real httpClient runs over a fetch stub that replays the recorded status + body.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, DEFAULT_POLICY, httpClient, ProviderError, ProviderRuntime, QuoteAggregator, type AssetRef, type ProviderContext, type SwapQuote, type SwapQuoteRequest } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import { createJupiterProvider, JUPITER_API_BASE, JUPITER_KEYLESS_POLICY, JUPITER_PROGRAM, jupiterBuildSchema, WSOL_MINT, type JupiterBuild } from '../src/providers/jupiter.ts';
import { JUPITER_DEX_PROGRAMS } from '../src/providers/jupiter-dexes.ts';

interface Fixture { recordedAt: string; url: string; status: number; body: unknown }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/jupiter/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const OTHER_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const token = (symbol: string) => NETWORKS.solana!.tokens.find((t) => t.symbol === symbol)!;
const ref = (symbol: string): AssetRef => ({ network: 'solana', asset: symbol === 'SOL' ? 'native' : token(symbol).id });
const SOL = ref('SOL'), USDC = ref('USDC'), PYUSD = ref('PYUSD'), USDG = ref('USDG');
const refOfMint = (mint: string): AssetRef => ({ network: 'solana', asset: mint === WSOL_MINT ? 'native' : mint });
const decimals = (a: AssetRef) => (a.asset === 'native' ? NETWORKS.solana!.native.decimals : NETWORKS.solana!.tokens.find((t) => t.id === a.asset)!.decimals);

/** the request that produced a recorded answer, rebuilt from the recorded URL */
function requestOf(f: Fixture): SwapQuoteRequest {
  const q = new URL(f.url).searchParams, taker = q.get('taker')!;
  return { from: refOfMint(q.get('inputMint')!), to: refOfMint(q.get('outputMint')!), amountIn: BigInt(q.get('amount')!), sender: taker, recipient: taker, slippageBps: Number(q.get('slippageBps')) };
}
/** replay a status + body through the real HTTP client; records what the adapter asked for */
function replay(status: number, body: unknown, calls: { url: string; init?: RequestInit }[] = []) {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); }) as typeof fetch;
  return { http: httpClient('jupiter', fetchImpl), calls };
}
const ctxFor = (f: Fixture, http: ProviderContext['http'], now = Date.parse(f.recordedAt) + 400): ProviderContext => ({ signal: new AbortController().signal, http, now: () => now });
const provider = createJupiterProvider();
async function quoteFixture(name: string, mutate?: (b: JupiterBuild) => unknown, req?: (r: SwapQuoteRequest) => SwapQuoteRequest): Promise<{ quotes: SwapQuote[]; f: Fixture; r: SwapQuoteRequest; calls: { url: string; init?: RequestInit }[] }> {
  const f = fixture(name); let body = clone(f.body);
  if (mutate) { const out = mutate(body as JupiterBuild); if (out !== undefined) body = out; }
  const r = req ? req(requestOf(f)) : requestOf(f), { http, calls } = replay(f.status, body);
  return { quotes: await provider.quote(r, ctxFor(f, http)), f, r, calls };
}
const SUCCESS = ['sol-usdc', 'usdc-sol', 'sol-pyusd', 'pyusd-sol', 'usdg-usdc', 'usdc-usdg', 'usdc-wbtc', 'usdc-bonk', 'wbtc-usdc-high-impact'] as const;

describe('jupiter: capabilities and pair filter (local, no network)', () => {
  it('is registered, keyless, Solana only, same-chain only', () => {
    const all = createProviders({});
    expect(all.map((p) => p.id)).toContain('jupiter');
    const cap = provider.capabilities();
    expect(cap).toMatchObject({ networks: ['solana'], crossChain: false, needsKey: false, configured: true, kinds: ['swap'] });
    expect(cap.docs).toMatch(/^https:\/\/developers\.jup\.ag\//);
    expect(provider.name).toContain('Metis'); // labelling required by Jupiter's API licence
    expect(JUPITER_API_BASE).toBe('https://api.jup.ag/swap/v2');
    expect(JUPITER_KEYLESS_POLICY.ratePerSec).toBeLessThanOrEqual(0.5);
  });
  it('accepts SOL and every registry token on Solana, both ways, including the Token-2022 mints', () => {
    expect(token('PYUSD').program).toBe('token2022'); expect(token('USDG').program).toBe('token2022');
    for (const t of NETWORKS.solana!.tokens) { const a = { network: 'solana', asset: t.id }; expect(provider.supportsPair(SOL, a)).toBe(true); expect(provider.supportsPair(a, SOL)).toBe(true); }
    expect(provider.supportsPair(PYUSD, USDG)).toBe(true);
  });
  it('refuses other networks, cross-chain pairs, identical assets and mints outside the registry', () => {
    const usdcBase = { network: 'base', asset: NETWORKS.base!.tokens.find((t) => t.symbol === 'USDC')!.id };
    expect(provider.supportsPair(SOL, usdcBase)).toBe(false);
    expect(provider.supportsPair(usdcBase, { network: 'base', asset: 'native' })).toBe(false);
    expect(provider.supportsPair(SOL, SOL)).toBe(false);
    expect(provider.supportsPair(USDC, USDC)).toBe(false);
    expect(provider.supportsPair(SOL, { network: 'solana', asset: WSOL_MINT })).toBe(false); // wrapped SOL is not a wallet asset
    expect(provider.supportsPair(SOL, { network: 'solana', asset: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB264' })).toBe(false);
    expect(provider.supportsPair({ network: 'nowhere', asset: 'native' }, SOL)).toBe(false);
  });
});

describe('jupiter: exact mapping of recorded answers', () => {
  it.each(SUCCESS)('%s: one HTTP round, exact amounts, guaranteed minimum, steps, validity', async (name) => {
    const { quotes, f, r, calls } = await quoteFixture(name);
    const b = f.body as JupiterBuild;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(f.url); // the adapter asks exactly what was recorded: mints, base-unit amount, taker, slippageBps
    expect(calls[0]!.init?.method).toBe('GET');
    expect(quotes).toHaveLength(1);
    const q = quotes[0]!;
    expect(q.provider).toBe('jupiter'); expect(q.request).toBe(r);
    expect(q.amountOut).toBe(BigInt(b.outAmount));
    expect(q.minAmountOut).toBe(BigInt(b.otherAmountThreshold));
    // slippage exactly as Jupiter defines it: outAmount − floor(outAmount × slippageBps / 10 000)
    expect(q.minAmountOut).toBe(q.amountOut - (q.amountOut * BigInt(r.slippageBps)) / 10_000n);
    expect(q.estimatedSeconds).toBeNull();
    expect(q.priceImpactBps).toBeCloseTo(Number(b.priceImpactPct) * 10_000, 2);
    expect(q.atomic).toBe(true); expect(q.refundable).toBe(true); expect(q.firmness).toBe('indicative');
    expect(q.executability.class).toBe('opaque');
    expect((q.executability as { reason: string }).reason).toMatch(/cannot rebuild/);
    // validity: 30 s from the moment Jupiter fetched the blockhash (never later than 30 s from now)
    const now = Date.parse(f.recordedAt) + 400;
    expect(q.expiresAt).toBe(Math.min(now, b.blockhashWithMetadata.fetchedAt.secs_since_epoch * 1000) + 30_000);
    expect(q.expiresAt).toBeGreaterThan(now); expect(q.expiresAt - now).toBeLessThanOrEqual(30_000);
    // one atomic step naming every venue, the aggregator program and every pool of the route plan
    expect(q.steps).toHaveLength(1);
    const s = q.steps[0]!;
    expect(s).toMatchObject({ kind: 'swap', provider: 'jupiter', from: r.from, to: r.to });
    expect(s.via).toEqual([...new Set(b.routePlan.map((l) => l.swapInfo.label))]);
    expect(s.contracts[0]).toEqual({ network: 'solana', address: JUPITER_PROGRAM, role: 'router' });
    for (const l of b.routePlan) expect(s.contracts).toContainEqual({ network: 'solana', address: l.swapInfo.ammKey, role: 'vault' });
    for (const c of s.contracts) expect(c.network).toBe('solana');
    // the raw payload is the validated answer, and the quote passes the aggregator's structural check
    expect(q.raw).toEqual(jupiterBuildSchema.parse(f.body));
    expect(checkQuote(q, r, now)).toBeNull();
    expect(checkQuote(q, r, q.expiresAt)).toBe('quote already expired');
  });

  it('pins the recorded numbers (base units, registry decimals)', async () => {
    const out = async (n: string) => { const { quotes } = await quoteFixture(n); return quotes[0]!; };
    const solUsdc = await out('sol-usdc'), usdcSol = await out('usdc-sol'), wbtc = await out('usdc-wbtc'), bonk = await out('usdc-bonk'), usdg0 = await out('usdc-usdg'), pyusdSol = await out('pyusd-sol');
    expect([solUsdc.request.amountIn, solUsdc.amountOut, solUsdc.minAmountOut]).toEqual([300_000_000n, 24_898_345n, 24_773_854n]); // 0.3 SOL -> 24.898345 USDC
    expect([usdcSol.amountOut, usdcSol.minAmountOut]).toEqual([301_259_329n, 299_753_033n]); // 25 USDC -> 0.301259329 SOL
    expect([wbtc.amountOut, wbtc.minAmountOut]).toEqual([34_088n, 33_918n]); // 25 USDC -> 0.00034088 WBTC (8 decimals)
    expect([bonk.amountOut, bonk.minAmountOut]).toEqual([885_426_761_904n, 880_999_628_095n]); // 25 USDC -> 8 854 267.61904 BONK (5 decimals)
    expect([usdg0.request.slippageBps, usdg0.amountOut, usdg0.minAmountOut]).toEqual([0, 24_999_274n, 24_999_274n]); // zero slippage: minimum = expected
    expect([pyusdSol.request.slippageBps, pyusdSol.amountOut, pyusdSol.minAmountOut]).toEqual([100, 301_284_623n, 298_271_777n]); // 1 %
    // decimals: the two directions of SOL/USDC imply the same price once scaled by the registry decimals
    const human = (q: SwapQuote) => ({ i: Number(q.request.amountIn) / 10 ** decimals(q.request.from), o: Number(q.amountOut) / 10 ** decimals(q.request.to) });
    const a = human(solUsdc), b = human(usdcSol);
    expect(a.o / a.i).toBeGreaterThan(10); expect(a.o / a.i).toBeLessThan(10_000); // USD per SOL
    expect(Math.abs(a.o / a.i / (b.i / b.o) - 1)).toBeLessThan(0.005);
  });

  it('reports price impact in basis points, including a near-total one', async () => {
    expect((await quoteFixture('wbtc-usdc-high-impact')).quotes[0]!.priceImpactBps).toBe(9949.8); // "0.99498…" = 99.498 %
    expect((await quoteFixture('sol-usdc')).quotes[0]!.priceImpactBps).toBe(3.19); // "0.000318522…"
    expect((await quoteFixture('pyusd-sol')).quotes[0]!.priceImpactBps).toBe(0); // "0"
  });

  it('classifies fees: only the network fee, in SOL, estimated, not included in the output', async () => {
    for (const name of SUCCESS) {
      const { quotes, f } = await quoteFixture(name), b = f.body as JupiterBuild;
      expect((b as { platformFee?: unknown }).platformFee).toBeUndefined(); // /build charges no Jupiter fee and we ask for no integrator fee
      const price = new DataView(Uint8Array.from(Buffer.from(b.computeBudgetInstructions[0]!.data, 'base64')).buffer).getBigUint64(1, true);
      expect(quotes[0]!.fees).toEqual([{ kind: 'network', asset: SOL, amount: 5_000n + (price * 1_400_000n + 999_999n) / 1_000_000n, includedInOutput: false, estimated: true }]);
    }
    // sol-usdc: 3 331 micro-lamports per compute unit -> 5 000 + ceil(3 331 × 1.4) = 9 664 lamports at most
    expect((await quoteFixture('sol-usdc')).quotes[0]!.fees[0]!.amount).toBe(9_664n);
    // no priority-fee instruction: the signature fee alone
    expect((await quoteFixture('sol-usdc', (b) => { b.computeBudgetInstructions = []; })).quotes[0]!.fees[0]!.amount).toBe(5_000n);
  });

  it('really routes the Token-2022 mints (PYUSD, USDG): token accounts are created under the Token-2022 program', async () => {
    for (const [name, sym] of [['sol-pyusd', 'PYUSD'], ['pyusd-sol', 'PYUSD'], ['usdg-usdc', 'USDG'], ['usdc-usdg', 'USDG']] as const) {
      const { quotes, f } = await quoteFixture(name), b = f.body as JupiterBuild, mint = token(sym).id;
      expect(quotes).toHaveLength(1);
      expect(b.routePlan.some((l) => l.swapInfo.inputMint === mint || l.swapInfo.outputMint === mint)).toBe(true);
      const keys = (ix: JupiterBuild['swapInstruction']) => ix.accounts.map((a) => a.pubkey);
      expect(keys(b.swapInstruction)).toContain(mint); expect(keys(b.swapInstruction)).toContain(TOKEN_2022);
      if (requestOf(f).to.asset === mint) expect(b.setupInstructions.some((ix) => ix.programId === ATA_PROGRAM && keys(ix).includes(mint) && keys(ix).includes(TOKEN_2022))).toBe(true);
    }
  });

  it('native SOL is the wrapped-SOL mint: wrap on the way in, unwrap (close account) on the way out', async () => {
    const wrap = fixture('sol-usdc'), unwrap = fixture('usdc-sol');
    expect(new URL(wrap.url).searchParams.get('inputMint')).toBe(WSOL_MINT);
    expect((wrap.body as JupiterBuild).setupInstructions.map((i) => i.programId)).toContain('11111111111111111111111111111111'); // SOL transfer into the wSOL account
    expect((unwrap.body as JupiterBuild).cleanupInstruction).toMatchObject({ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: 'CQ==' }); // CloseAccount
  });

  it('the DEX table is the recorded program-id-to-label answer, and names a program that the swap instruction really uses', async () => {
    const live = fixture('program-id-to-label').body as Record<string, string>;
    const fromLive: Record<string, string[]> = {};
    for (const [pid, label] of Object.entries(live)) (fromLive[label] ??= []).push(pid);
    for (const v of Object.values(fromLive)) v.sort();
    expect(JUPITER_DEX_PROGRAMS).toEqual(fromLive);
    for (const name of SUCCESS) {
      const { quotes, f } = await quoteFixture(name), b = f.body as JupiterBuild;
      const used = new Set(b.swapInstruction.accounts.map((a) => a.pubkey));
      for (const l of b.routePlan) {
        const programs = JUPITER_DEX_PROGRAMS[l.swapInfo.label]!;
        expect(programs, l.swapInfo.label).toBeDefined();
        expect(programs.some((p) => used.has(p)), `${name}: ${l.swapInfo.label}`).toBe(true);
        for (const p of programs) expect(quotes[0]!.steps[0]!.contracts).toContainEqual({ network: 'solana', address: p, role: 'program' });
      }
    }
  });

  it('a venue missing from the table is still quoted, without a program entry', async () => {
    const { quotes } = await quoteFixture('usdc-sol', (b) => { b.routePlan[0]!.swapInfo.label = 'Brand New DEX'; });
    expect(quotes[0]!.steps[0]!.via).toEqual(['Brand New DEX']);
    expect(quotes[0]!.steps[0]!.contracts.filter((c) => c.role === 'program')).toEqual([]);
  });

  it('keeps only validated fields in raw (unknown keys are dropped)', async () => {
    const { quotes } = await quoteFixture('usdc-sol', (b) => { (b as Record<string, unknown>).surprise = { transaction: 'AAAA' }; });
    expect(quotes[0]!.raw).not.toHaveProperty('surprise');
  });

  it('sends the optional API key as x-api-key, and nothing without one', async () => {
    const f = fixture('usdc-sol'), a = replay(200, f.body), b = replay(200, f.body);
    await createJupiterProvider({ JUPITER_API_KEY: ' jup_test ' }).quote(requestOf(f), ctxFor(f, a.http));
    await provider.quote(requestOf(f), ctxFor(f, b.http));
    expect(new Headers(a.calls[0]!.init?.headers).get('x-api-key')).toBe('jup_test');
    expect(new Headers(b.calls[0]!.init?.headers).has('x-api-key')).toBe(false);
  });
});

describe('jupiter: no route is an empty array', () => {
  it.each(['no-route-dust', 'no-route-liquidity'])('%s (recorded HTTP 400)', async (name) => {
    const { quotes, f, calls } = await quoteFixture(name);
    expect(f.status).toBe(400); expect(calls).toHaveLength(1); expect(quotes).toEqual([]);
  });
  it('requests it cannot serve as asked are refused locally, without calling the API', async () => {
    const f = fixture('sol-usdc'), base = requestOf(f);
    const none = async (r: SwapQuoteRequest) => { const { http, calls } = replay(200, f.body); expect(await provider.quote(r, ctxFor(f, http))).toEqual([]); expect(calls).toHaveLength(0); };
    await none({ ...base, recipient: OTHER_WALLET }); // the output of a /build swap lands in the taker's own account
    await none({ ...base, sender: 'SENDER', recipient: 'SENDER' }); // not a Solana address
    await none({ ...base, sender: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
    await none({ ...base, amountIn: 0n }); await none({ ...base, amountIn: -5n }); await none({ ...base, amountIn: 1n << 64n });
    await none({ ...base, slippageBps: 12.5 }); await none({ ...base, slippageBps: -1 }); await none({ ...base, slippageBps: 10_001 });
    await none({ ...base, to: { network: 'base', asset: 'native' } }); await none({ ...base, to: SOL });
  });
  it('through the aggregator: a quote for a recorded answer, no_route for a recorded 400', async () => {
    const run = async (name: string) => {
      const f = fixture(name), { http } = replay(f.status, f.body), now = Date.parse(f.recordedAt) + 400;
      const rt = new ProviderRuntime(provider, { ...DEFAULT_POLICY, ...JUPITER_KEYLESS_POLICY }, http, () => now);
      return new QuoteAggregator([rt], () => now).collect(requestOf(f));
    };
    const ok = await run('sol-pyusd');
    expect(ok.quotes).toHaveLength(1); expect(ok.quotes[0]!.amountOut).toBe(24_892_199n);
    const none = await run('no-route-dust');
    expect(none.quotes).toEqual([]); expect(none.events.find((e) => e.type === 'provider')).toMatchObject({ provider: 'jupiter', status: 'no_route' });
  });
});

describe('jupiter: provider failures throw', () => {
  const failing = async (status: number, body: unknown) => { const f = fixture('sol-usdc'); return provider.quote(requestOf(f), ctxFor(f, replay(status, body).http)); };
  it('recorded 400 that is not a no-route answer', async () => {
    const f = fixture('error-invalid-taker');
    await expect(failing(f.status, f.body)).rejects.toMatchObject({ provider: 'jupiter', code: 'http', status: 400 });
  });
  it('recorded transient upstream failure wrapped in a 400 (stale AMM oracle): a failure, not "no route"', async () => {
    const f = fixture('error-oracle-stale'), { http } = replay(f.status, f.body);
    await expect(provider.quote(requestOf(f), ctxFor(f, http))).rejects.toMatchObject({ provider: 'jupiter', code: 'http', status: 400 });
  });
  it('recorded 429 from the API gateway', async () => {
    const f = fixture('error-rate-limited');
    await expect(failing(f.status, f.body)).rejects.toMatchObject({ provider: 'jupiter', code: 'rate_limited' });
  });
  it('other 400 shapes, 5xx and non-JSON bodies', async () => {
    await expect(failing(400, { error: 'Invalid amount' })).rejects.toMatchObject({ code: 'http' });
    await expect(failing(400, { success: false, error: { issues: [], name: 'ZodError' } })).rejects.toMatchObject({ code: 'http' });
    await expect(failing(400, { error: 'No routes found, try later' })).rejects.toMatchObject({ code: 'http' }); // only the exact documented strings mean "no route"
    await expect(failing(500, { error: 'No routes found' })).rejects.toMatchObject({ code: 'http' });
    await expect(failing(502, '<html>Bad gateway</html>')).rejects.toMatchObject({ code: 'bad_response' });
    await expect(failing(200, '<html>maintenance</html>')).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('timeout and abort: the signal reaches fetch and the failure is a timeout', async () => {
    const f = fixture('sol-usdc'); let seen: AbortSignal | undefined;
    const hang = (async (_u: string | URL | Request, init?: RequestInit) => { seen = init?.signal ?? undefined; return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))); }) as typeof fetch;
    // the adapter alone, aborted by its context
    const ac = new AbortController(); setTimeout(() => ac.abort(), 20);
    await expect(provider.quote(requestOf(f), { signal: ac.signal, http: httpClient('jupiter', hang), now: Date.now })).rejects.toMatchObject({ provider: 'jupiter', code: 'timeout' });
    expect(seen).toBe(ac.signal);
    // under the runtime: the per-provider deadline fires and is counted
    const rt = new ProviderRuntime(provider, { ...DEFAULT_POLICY, timeoutMs: 30 }, httpClient('jupiter', hang));
    await expect(rt.quote(requestOf(f))).rejects.toMatchObject({ code: 'timeout' });
    expect(rt.stats().timeouts).toBe(1);
    // a caller that gives up does not count against the provider
    const rt2 = new ProviderRuntime(provider, DEFAULT_POLICY, httpClient('jupiter', hang)), outer = new AbortController(); setTimeout(() => outer.abort(), 20);
    await expect(rt2.quote(requestOf(f), outer.signal)).rejects.toMatchObject({ code: 'timeout' });
    expect(rt2.stats().failures).toBe(0);
  });
});

describe('jupiter: malformed or hostile answers are rejected (schema), never turned into a quote', () => {
  const rejects = async (name: string, mutate: (b: JupiterBuild) => unknown, fx = 'sol-usdc') => {
    const err = await quoteFixture(fx, mutate).then(() => null, (e: unknown) => e);
    expect(err, name).toBeInstanceOf(ProviderError);
    expect(err, name).toMatchObject({ provider: 'jupiter', code: 'schema' });
  };
  const any = (b: JupiterBuild) => b as unknown as Record<string, unknown>;
  const BONK = token('BONK').id, WBTC = token('WBTC').id;
  it('wrong tokens, amounts or terms', async () => {
    await rejects('output is another registry token', (b) => { b.outputMint = BONK; });
    await rejects('output is a look-alike mint', (b) => { b.outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1w'; });
    await rejects('input is another token', (b) => { b.inputMint = WBTC; });
    await rejects('mints swapped', (b) => { [b.inputMint, b.outputMint] = [b.outputMint, b.inputMint]; });
    await rejects('another input amount', (b) => { b.inAmount = '300000001'; });
    await rejects('another slippage', (b) => { b.slippageBps = 500; });
    await rejects('exact-out answer', (b) => { any(b).swapMode = 'ExactOut'; });
    await rejects('zero output', (b) => { b.outAmount = '0'; b.otherAmountThreshold = '0'; });
    await rejects('legacy transaction version', (b) => { any(b).transactionVersion = 1; });
  });
  it('amounts that are not unsigned integer strings', async () => {
    for (const v of ['24898345.5', '-24898345', '2.4898345e7', '0x17BE9A9', ' 24898345', '024898345', '', '1e3', 'NaN', '18446744073709551616', '9'.repeat(40)]) await rejects(`outAmount ${JSON.stringify(v)}`, (b) => { b.outAmount = v; });
    await rejects('outAmount as a JSON number', (b) => { any(b).outAmount = 24898345; });
    await rejects('outAmount as a float', (b) => { any(b).outAmount = 24898345.5; });
    await rejects('threshold as a float string', (b) => { b.otherAmountThreshold = '24773854.9'; });
    await rejects('negative threshold', (b) => { b.otherAmountThreshold = '-1'; });
    await rejects('negative input', (b) => { b.inAmount = '-300000000'; });
    await rejects('leg amount as a float', (b) => { b.routePlan[0]!.swapInfo.outAmount = '1.5'; });
    await rejects('slippage as a string', (b) => { any(b).slippageBps = '50'; });
    await rejects('price impact not a number', (b) => { b.priceImpactPct = 'low'; });
  });
  it('a guaranteed minimum outside the requested slippage', async () => {
    await rejects('minimum of 1 unit', (b) => { b.otherAmountThreshold = '1'; });
    await rejects('one unit below the exact floor', (b) => { b.otherAmountThreshold = String((BigInt(b.outAmount) * 9_950n) / 10_000n - 1n); });
    await rejects('minimum above the expected output', (b) => { b.otherAmountThreshold = String(BigInt(b.outAmount) + 1n); });
    await rejects('zero minimum', (b) => { b.otherAmountThreshold = '0'; });
    // the exact floor itself is inside the band: accepted, and taken as the provider states it
    const { quotes } = await quoteFixture('sol-usdc', (b) => { b.otherAmountThreshold = String((BigInt(b.outAmount) * 9_950n) / 10_000n); });
    expect(quotes[0]!.minAmountOut).toBe(24_773_853n);
  });
  it('missing fields and wrong shapes', async () => {
    for (const k of ['inputMint', 'outputMint', 'inAmount', 'outAmount', 'otherAmountThreshold', 'swapMode', 'slippageBps', 'priceImpactPct', 'routePlan', 'computeBudgetInstructions', 'setupInstructions', 'swapInstruction', 'cleanupInstruction', 'otherInstructions', 'addressesByLookupTableAddress', 'blockhashWithMetadata', 'transactionVersion']) await rejects(`missing ${k}`, (b) => { delete any(b)[k]; });
    await rejects('empty route plan', (b) => { b.routePlan = []; });
    await rejects('leg without pool', (b) => { delete (b.routePlan[0]!.swapInfo as Record<string, unknown>).ammKey; });
    await rejects('leg without bps', (b) => { delete (b.routePlan[0] as Record<string, unknown>).bps; });
    await rejects('no blockhash time', (b) => { delete (b.blockhashWithMetadata as Record<string, unknown>).fetchedAt; });
    await rejects('short blockhash', (b) => { b.blockhashWithMetadata.blockhash = [1, 2, 3]; });
    await rejects('pool key not base58', (b) => { b.routePlan[0]!.swapInfo.ammKey = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; });
    await rejects('null body', () => null);
    await rejects('array body', () => []);
    await rejects('error object with HTTP 200', () => ({ error: 'No routes found' }));
    await rejects('V1 quote shape (no instructions)', (b) => ({ inputMint: b.inputMint, inAmount: b.inAmount, outputMint: b.outputMint, outAmount: b.outAmount, otherAmountThreshold: b.otherAmountThreshold, swapMode: 'ExactIn', slippageBps: 50, platformFee: null, priceImpactPct: '0', routePlan: b.routePlan }));
  });
  it('a route plan that does not add up', async () => {
    await rejects('legs deliver less than quoted', (b) => { b.outAmount = String(BigInt(b.outAmount) + 1_000_000n); b.otherAmountThreshold = b.outAmount; });
    await rejects('legs take another input', (b) => { const l = b.routePlan.find((x) => x.swapInfo.inputMint === WSOL_MINT)!; l.swapInfo.inAmount = String(BigInt(l.swapInfo.inAmount) - 1n); });
    await rejects('route ends in another mint', (b) => { for (const l of b.routePlan) if (l.swapInfo.outputMint === b.outputMint) l.swapInfo.outputMint = BONK; });
    await rejects('self-swap leg', (b) => { b.routePlan[0]!.swapInfo.outputMint = b.routePlan[0]!.swapInfo.inputMint; });
  });
  it('instructions for another wallet, another program, or with extras nobody asked for', async () => {
    const SYSTEM = '11111111111111111111111111111111';
    await rejects('output for another recipient: every occurrence of the taker replaced', (b) => JSON.parse(JSON.stringify(b).replaceAll(requestOf(fixture('sol-usdc')).sender, OTHER_WALLET)));
    await rejects('a second signer', (b) => { b.setupInstructions[0]!.accounts.push({ pubkey: OTHER_WALLET, isSigner: true, isWritable: true }); });
    await rejects('swap signed by another wallet', (b) => { for (const a of b.swapInstruction.accounts) if (a.isSigner) a.pubkey = OTHER_WALLET; });
    await rejects('swap not signed by the taker', (b) => { for (const a of b.swapInstruction.accounts) a.isSigner = false; });
    await rejects('swap sent to another program', (b) => { b.swapInstruction.programId = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'; });
    await rejects('unknown program in setup', (b) => { b.setupInstructions[0]!.programId = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'; });
    await rejects('unknown program in cleanup', (b) => { b.cleanupInstruction!.programId = OTHER_WALLET; });
    await rejects('extra instruction', (b) => { b.otherInstructions.push({ programId: SYSTEM, accounts: [{ pubkey: b.swapInstruction.accounts.find((a) => a.isSigner)!.pubkey, isSigner: true, isWritable: true }, { pubkey: OTHER_WALLET, isSigner: false, isWritable: true }], data: 'AgAAAADKmjsAAAAA' }); });
    await rejects('tip instruction', (b) => { any(b).tipInstruction = b.setupInstructions[0]; });
    await rejects('platform fee nobody asked for', (b) => { any(b).platformFee = { amount: '100000', feeBps: 40 }; });
    await rejects('compute budget instruction that is not a price', (b) => { b.computeBudgetInstructions[0]!.data = 'AkANAwA='; });
    await rejects('compute budget slot used by another program', (b) => { b.computeBudgetInstructions[0]!.programId = SYSTEM; });
    await rejects('instruction data not base64', (b) => { b.swapInstruction.data = '<script>'; });
  });
});

// The execution dossier (docs/swap/providers/jupiter.md) states what an isolated signer could check by itself in a /build
// answer. These are those facts, pinned on every recorded answer (derivations with @solana/kit, a dev dependency).
describe('jupiter: structure of the recorded instructions (the facts the execution dossier relies on)', async () => {
  const { address, getAddressEncoder, getProgramDerivedAddress } = await import('@solana/kit');
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', SYSTEM = '11111111111111111111111111111111';
  const programOf = (mint: string) => (NETWORKS.solana!.tokens.find((t) => t.id === mint)?.program === 'token2022' ? TOKEN_2022 : TOKEN);
  const enc = getAddressEncoder();
  const ata = async (owner: string, mint: string) => (await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [enc.encode(address(owner)), enc.encode(address(programOf(mint))), enc.encode(address(mint))] }))[0] as string;
  const bytes = (b64: string) => Buffer.from(b64, 'base64');

  it.each(SUCCESS)('%s', async (name) => {
    const f = fixture(name), b = f.body as JupiterBuild, q = new URL(f.url).searchParams;
    const taker = q.get('taker')!, inMint = q.get('inputMint')!, outMint = q.get('outputMint')!;
    const src = await ata(taker, inMint), dst = await ata(taker, outMint);
    // swap instruction: Anchor `route_v2` or `shared_accounts_route_v2` of the aggregator, carrying the exact input, the
    // quoted output and the slippage (the program enforces quoted_out × (1 − slippage)); no platform fee
    const data = bytes(b.swapInstruction.data), disc = data.subarray(0, 8).toString('hex');
    expect(['bb64facc31c4af14', 'd19853937cfed8e9']).toContain(disc); // sha256("global:route_v2")[..8], sha256("global:shared_accounts_route_v2")[..8]
    const shared = disc === 'd19853937cfed8e9', o = shared ? 9 : 8;
    expect(data.readBigUInt64LE(o)).toBe(BigInt(b.inAmount));
    expect(data.readBigUInt64LE(o + 8)).toBe(BigInt(b.outAmount));
    expect(data.readUInt16LE(o + 16)).toBe(b.slippageBps);
    expect(data.readUInt16LE(o + 18)).toBe(0); // platform fee bps
    expect(data.readUInt32LE(o + 22)).toBe(b.routePlan.length);
    // accounts at fixed positions: the taker (only signer), its own source and destination token accounts, both mints
    const keys = b.swapInstruction.accounts.map((a) => a.pubkey), at = shared ? { taker: 1, src: 2, dst: 5, inMint: 6, outMint: 7 } : { taker: 0, src: 1, dst: 2, inMint: 3, outMint: 4 };
    expect([keys[at.taker], keys[at.src], keys[at.dst], keys[at.inMint], keys[at.outMint]]).toEqual([taker, src, dst, inMint, outMint]);
    expect(b.swapInstruction.accounts.filter((a) => a.isSigner).map((a) => a.pubkey)).toEqual([taker]);
    // setup: only idempotent creations of the taker's OWN associated token accounts (possibly for intermediate mints),
    // and, when SOL is the input, a transfer of exactly the input amount into the taker's wrapped-SOL account + SyncNative
    for (const ix of b.setupInstructions) {
      const k = ix.accounts.map((a) => a.pubkey), d = bytes(ix.data);
      if (ix.programId === ATA_PROGRAM) { expect(d).toEqual(Buffer.from([1])); expect([k[0], k[2]]).toEqual([taker, taker]); expect([TOKEN, TOKEN_2022]).toContain(k[5]); }
      else if (ix.programId === SYSTEM) { expect(inMint).toBe(WSOL_MINT); expect(d.readUInt32LE(0)).toBe(2); expect([k[0], k[1]]).toEqual([taker, src]); expect(d.readBigUInt64LE(4)).toBe(BigInt(b.inAmount)); }
      else { expect(ix.programId).toBe(TOKEN); expect(d).toEqual(Buffer.from([17])); expect(k).toEqual([src]); }
    }
    expect(b.setupInstructions.some((ix) => ix.programId === ATA_PROGRAM && ix.accounts[1]!.pubkey === dst)).toBe(true);
    // cleanup: present exactly when SOL is on either side — CloseAccount of the taker's wrapped-SOL account, back to the taker
    expect(b.cleanupInstruction !== null).toBe(inMint === WSOL_MINT || outMint === WSOL_MINT);
    if (b.cleanupInstruction) expect(b.cleanupInstruction.accounts.map((a) => a.pubkey)).toEqual([inMint === WSOL_MINT ? src : dst, taker, taker]);
    // versioned (v0) transaction material: at least one address lookup table
    expect(Object.keys(b.addressesByLookupTableAddress ?? {}).length).toBeGreaterThan(0);
  });
});

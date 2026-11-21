/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/cctp.test.ts
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

// CCTP adapter against responses recorded from Circle's live Iris API and from the registry's public RPC endpoints
// on 2026-11-11 (fixtures/cctp). No network here: the HttpClient below serves the recordings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, ProviderError, type AssetRef, type HttpClient, type ProviderContext, type SwapQuoteRequest } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import { CCTP_CHAINS, CCTP_EVM, CCTP_SOLANA, CCTPX, cctpFee, createCctpProvider, decodeCctpMessageV2, evmAddressToBytes32, solanaAddressToBytes32, USDC_BURN_LIMIT } from '../src/providers/cctp.ts';

const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/cctp/${name}.json`, import.meta.url), 'utf8'));
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const usdc = (n: string) => tok(n, 'USDC'), eurc = (n: string) => tok(n, 'EURC');
const EVM_A = '0x28C6c06298d514Db089934071355E5743bf21d60', EVM_B = '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549';
const SOL_A = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const addr = (n: string, alt = false) => (NETWORKS[n]!.family === 'evm' ? (alt ? EVM_B : EVM_A) : SOL_A);
const req = (from: AssetRef, to: AssetRef, amountIn: bigint, o: Partial<SwapQuoteRequest> = {}): SwapQuoteRequest => ({ from, to, amountIn, slippageBps: 50, ...o, sender: o.sender ?? addr(from.network), recipient: o.recipient ?? addr(to.network, true) });
const NOW = 1_794_359_750_000; // just after the EURC fixtures were issued, before they expire

type Reply = unknown | ((url: string, body: unknown) => unknown);
const httpError = (status: number, body: unknown) => Object.assign(new ProviderError('cctp', 'http', `HTTP ${status}`), { status, body });
/** Scripted HttpClient: the first rule whose key is contained in the URL (and, for RPC, whose method matches) answers. */
function mock(rules: [string, Reply][]) {
  const calls: { method: 'GET' | 'POST'; url: string; body?: any; signal?: AbortSignal }[] = [];
  const answer = (url: string, body: unknown) => {
    for (const [key, reply] of rules) {
      const [u, m] = key.split('#');
      const methods = Array.isArray(body) ? (body as any[]).map((b) => b.method) : [(body as any)?.method];
      if (!url.includes(u!) || (m && !methods.includes(m))) continue;
      const v = typeof reply === 'function' ? (reply as (u: string, b: unknown) => unknown)(url, body) : reply;
      if (v instanceof Error) throw v;
      return structuredClone(v);
    }
    throw new Error(`unexpected request in test: ${url}`);
  };
  const http: HttpClient = {
    getJson: async (url, init) => { calls.push({ method: 'GET', url, signal: init?.signal }); return answer(url, undefined); },
    postJson: async (url, body, init) => { calls.push({ method: 'POST', url, body, signal: init?.signal }); return answer(url, body); },
  };
  return { http, calls };
}
const ctxOf = (http: HttpClient, signal = new AbortController().signal): ProviderContext => ({ http, signal, now: () => NOW });
/** recorded eth_gasPrice answers; a network without its own recording is served Base's (the arithmetic is what is under test) */
const gas = (network: string) => fx(`rpc-${['ethereum', 'base', 'avalanche'].includes(network) ? network : 'base'}-gasprice`);
/** the recordings for a plain EVM -> EVM USDC route */
const evmRules = (fees: string, src: string, dst: string, extra: [string, Reply][] = []): [string, Reply][] => [
  ...extra, ['/v2/burn/USDC/fees/', fx(fees)], ['/v2/fastBurn/USDC/allowance', fx('allowance')],
  [NETWORKS[src]!.rpc[0]!, gas(src)], [NETWORKS[dst]!.rpc[0]!, gas(dst)],
];
const provider = createCctpProvider();
const ETH_GAS = BigInt(gas('ethereum').result), BASE_GAS = BigInt(gas('base').result), AVAX_GAS = BigInt(gas('avalanche').result);

describe('cctp: capabilities and pair filter', () => {
  it('is registered and keyless', () => {
    expect(createProviders().map((p) => p.id)).toContain('cctp');
    const c = provider.capabilities();
    expect(c).toMatchObject({ crossChain: true, needsKey: false, configured: true, kinds: ['bridge'], docs: 'https://developers.circle.com/cctp' });
    expect([...c.networks].sort()).toEqual(['arbitrum', 'avalanche', 'base', 'ethereum', 'hyperevm', 'optimism', 'polygon', 'solana']);
  });
  it('maps each wallet network to Circle\'s domain id and Fast availability', () => {
    expect(Object.fromEntries(Object.entries(CCTP_CHAINS).map(([n, c]) => [n, c.domain]))).toEqual({ ethereum: 0, avalanche: 1, optimism: 2, arbitrum: 3, solana: 5, base: 6, polygon: 7, hyperevm: 19 });
    expect(Object.entries(CCTP_CHAINS).filter(([, c]) => c.fastSource).map(([n]) => n).sort()).toEqual(['arbitrum', 'base', 'ethereum', 'optimism', 'solana']);
    for (const c of Object.values(CCTP_CHAINS)) expect(c.fastSource).toBe(c.fastSeconds !== null);
    // every CCTP network is in the wallet registry with a USDC deployment, and BNB Smart Chain (USYC only) is not served
    for (const n of Object.keys(CCTP_CHAINS)) expect(NETWORKS[n]!.tokens.some((t) => t.symbol === 'USDC')).toBe(true);
    expect(CCTP_CHAINS.bsc).toBeUndefined();
    expect(Object.entries(CCTP_CHAINS).filter(([, c]) => c.eurc).map(([n]) => n).sort()).toEqual(['avalanche', 'base', 'ethereum']);
  });
  it('accepts every USDC route between distinct CCTP networks and the three EURC networks', () => {
    const nets = Object.keys(CCTP_CHAINS);
    for (const a of nets) for (const b of nets) expect(provider.supportsPair(usdc(a), usdc(b))).toBe(a !== b);
    for (const a of ['ethereum', 'avalanche', 'base']) for (const b of ['ethereum', 'avalanche', 'base']) expect(provider.supportsPair(eurc(a), eurc(b))).toBe(a !== b);
    // EVM contract addresses are case-insensitive
    expect(provider.supportsPair({ network: 'base', asset: usdc('base').asset.toLowerCase() }, usdc('solana'))).toBe(true);
  });
  it('refuses anything that is not the registry USDC/EURC on a CCTP network', async () => {
    const no: [AssetRef, AssetRef][] = [
      [tok('ethereum', 'USDT'), usdc('base')], // another stablecoin
      [usdc('base'), tok('ethereum', 'USDT')],
      [{ network: 'polygon', asset: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' }, usdc('base')], // bridged USDC.e: not in the registry
      [{ network: 'solana', asset: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }, usdc('base')], // USDT mint
      [usdc('base'), { network: 'solana', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1V' }], // wrong case = another mint
      [{ network: 'ethereum', asset: 'native' }, usdc('base')],
      [usdc('ethereum'), { network: 'bsc', asset: 'native' }],
      [usdc('ethereum'), { network: 'bsc', asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' }], // Binance-Peg USDC
      [usdc('ethereum'), { network: 'stellar', asset: 'native' }],
      [usdc('ethereum'), { network: 'nowhere', asset: 'x' }],
      [usdc('ethereum'), usdc('ethereum')], // same network
      [usdc('ethereum'), eurc('base')], // not a swap
      [eurc('solana'), eurc('base')], [eurc('base'), eurc('solana')], // CCTP for non-USDC is EVM only
    ];
    const { http, calls } = mock([]);
    for (const [a, b] of no) {
      expect(provider.supportsPair(a, b)).toBe(false);
      expect(await provider.quote(req(a, b, 25_000_000n, { sender: EVM_A, recipient: EVM_B }), ctxOf(http))).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('cctp: fee arithmetic in base units', () => {
  it('rounds the charged fee down and maxFee up, exactly', () => {
    expect(cctpFee(25_000_000n, 1)).toEqual({ fee: 2_500n, maxFee: 2_500n });
    expect(cctpFee(25_000_000n, 1.3)).toEqual({ fee: 3_250n, maxFee: 3_250n });
    expect(cctpFee(25_000_000n, 0)).toEqual({ fee: 0n, maxFee: 0n });
    // real Arbitrum burns at 1.4 bps and what Iris executed (maxFee -> feeExecuted): 14363 -> 14081, 1396 -> 1395, 243528 -> 243527
    expect(cctpFee(100_584_300n, 1.4)).toEqual({ fee: 14_081n, maxFee: 14_082n });
    expect(cctpFee(9_966_740n, 1.4)).toEqual({ fee: 1_395n, maxFee: 1_396n });
    expect(cctpFee(1_739_483_528n, 1.4)).toEqual({ fee: 243_527n, maxFee: 243_528n });
    expect(cctpFee(1n, 1)).toEqual({ fee: 0n, maxFee: 1n });
    // no float anywhere: 10 million USDC at 1.3 bps
    expect(cctpFee(USDC_BURN_LIMIT, 1.3)).toEqual({ fee: 1_300_000_000n, maxFee: 1_300_000_000n });
    expect(cctpFee(9_999_999_999_999n, 1.3)).toEqual({ fee: 1_299_999_999n, maxFee: 1_300_000_000n });
  });
  it('refuses fee values that are not plain small decimals', () => {
    for (const bad of [-1, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, 1.2345678, 101, 5000]) expect(() => cctpFee(1_000_000n, bad)).toThrowError(ProviderError);
  });
});

describe('cctp: USDC quotes', () => {
  it('ethereum -> base: a Standard and a Fast quote, every field from the recorded answers', async () => {
    const { http, calls } = mock(evmRules('fees-0-6', 'ethereum', 'base'));
    const r = req(usdc('ethereum'), usdc('base'), 25_000_000n);
    const ac = new AbortController();
    const quotes = await provider.quote(r, ctxOf(http, ac.signal));
    expect(quotes.map((q) => (q.raw as any).transfer)).toEqual(['standard', 'fast']);
    const [std, fast] = quotes as [typeof quotes[0], typeof quotes[0]];

    expect(std.amountOut).toBe(25_000_000n); expect(std.minAmountOut).toBe(25_000_000n); expect(std.estimatedSeconds).toBe(19 * 60);
    expect(fast.amountOut).toBe(24_997_500n); expect(fast.minAmountOut).toBe(24_997_500n); expect(fast.estimatedSeconds).toBe(20);
    const srcGas = { kind: 'network', asset: { network: 'ethereum', asset: 'native' }, amount: 180_000n * ETH_GAS, includedInOutput: false, estimated: true };
    const dstGas = { kind: 'network', asset: { network: 'base', asset: 'native' }, amount: 200_000n * BASE_GAS, includedInOutput: false, estimated: true };
    expect(std.fees).toEqual([{ kind: 'protocol', asset: r.to, amount: 0n, includedInOutput: true, estimated: false }, srcGas, dstGas]);
    expect(fast.fees).toEqual([{ kind: 'protocol', asset: r.to, amount: 2_500n, includedInOutput: true, estimated: false }, srcGas, dstGas]);
    for (const q of quotes) {
      expect(checkQuote(q, r, NOW)).toBeNull();
      expect(q).toMatchObject({ provider: 'cctp', request: r, priceImpactBps: 0, expiresAt: NOW + 30_000, firmness: 'indicative', atomic: false, refundable: false });
      expect(q.executability.class).toBe('quote_only');
      expect(q.steps).toHaveLength(1);
      expect(q.steps[0]).toMatchObject({ kind: 'bridge', provider: 'cctp', from: r.from, to: r.to });
      expect(q.steps[0]!.contracts).toEqual([
        { network: 'ethereum', address: CCTP_EVM.tokenMessenger, role: 'spender' }, { network: 'ethereum', address: CCTP_EVM.tokenMessenger, role: 'bridge' },
        { network: 'base', address: CCTP_EVM.messageTransmitter, role: 'bridge' }, { network: 'base', address: CCTP_EVM.tokenMessenger, role: 'bridge' },
      ]);
      // the destination-side requirement is spelled out in the step
      expect(q.steps[0]!.via.join('\n')).toMatch(/mint on base: MessageTransmitterV2\.receiveMessage; the wallet submits the mint itself and needs ETH on base/);
    }
    expect(new Set(quotes.map((q) => q.id)).size).toBe(2);
    // the burn the signer would have to verify, argument by argument
    expect((fast.raw as any).burn).toMatchObject({
      network: 'ethereum', contract: CCTP_EVM.tokenMessenger,
      approval: { token: usdc('ethereum').asset, spender: CCTP_EVM.tokenMessenger, amount: '25000000' },
      args: { amount: '25000000', destinationDomain: 6, mintRecipient: `0x${'0'.repeat(24)}${EVM_B.slice(2).toLowerCase()}`, burnToken: usdc('ethereum').asset, destinationCaller: `0x${'0'.repeat(64)}`, maxFee: '2500', minFinalityThreshold: 1000 },
    });
    expect((std.raw as any).burn.args).toMatchObject({ maxFee: '0', minFinalityThreshold: 2000 });
    expect((std.raw as any).fees).toEqual(fx('fees-0-6')); // raw = the validated provider payload
    expect((std.raw as any).forwardingService).toEqual({ low: 53880, med: 54176, high: 56413 });
    expect((std.raw as any).mint).toMatchObject({ network: 'base', contract: CCTP_EVM.messageTransmitter, submittedBy: 'wallet' });
    // one round: fee schedule, Fast allowance, one gas price per side — each with the caller's abort signal
    expect(calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([
      'GET https://iris-api.circle.com/v2/burn/USDC/fees/0/6?forward=true', 'GET https://iris-api.circle.com/v2/fastBurn/USDC/allowance',
      `POST ${NETWORKS.base.rpc[0]}`, `POST ${NETWORKS.ethereum.rpc[0]}`,
    ].sort());
    for (const c of calls) expect(c.signal).toBe(ac.signal);
    expect(calls.filter((c) => c.method === 'POST').every((c) => c.body.method === 'eth_gasPrice')).toBe(true);
  });

  it('applies a fractional basis-point fee exactly (arbitrum -> optimism at 1.4 bps)', async () => {
    const rules = evmRules('fees-3-2', 'arbitrum', 'optimism');
    const r = req(usdc('arbitrum'), usdc('optimism'), 100_584_300n);
    const [std, fast] = await provider.quote(r, ctxOf(mock(rules).http));
    expect(std!.amountOut).toBe(100_584_300n);
    expect(fast!.amountOut).toBe(100_584_300n - 14_081n); // what Iris executed for this very amount on mainnet
    expect(fast!.minAmountOut).toBe(100_584_300n - 14_082n); // maxFee, rounded up
    expect(fast!.fees[0]).toMatchObject({ kind: 'protocol', amount: 14_081n, includedInOutput: true });
    expect((fast!.raw as any)).toMatchObject({ feeBps: '1.4', protocolFee: '14081', maxFee: '14082' });
    expect(fast!.estimatedSeconds).toBe(8);
    expect(checkQuote(fast!, r, NOW)).toBeNull();
    // the requested slippage does not move a 1:1 mint: the only possible deduction is maxFee
    const [, loose] = await provider.quote({ ...r, slippageBps: 500 }, ctxOf(mock(rules).http));
    expect(loose!.minAmountOut).toBe(fast!.minAmountOut);
  });

  it('offers Standard only from a source without Fast Transfer (polygon, avalanche, hyperevm) and does not ask for the allowance', async () => {
    for (const [src, dst, fees] of [['polygon', 'ethereum', 'fees-7-0'], ['avalanche', 'hyperevm', 'fees-1-19']] as const) {
      const { http, calls } = mock([['/v2/burn/USDC/fees/', fx(fees)], [NETWORKS[src].rpc[0]!, gas('avalanche')], [NETWORKS[dst].rpc[0]!, gas('ethereum')]]);
      const r = req(usdc(src), usdc(dst), 20_000_000n);
      const quotes = await provider.quote(r, ctxOf(http));
      expect(quotes).toHaveLength(1);
      expect(quotes[0]).toMatchObject({ amountOut: 20_000_000n, minAmountOut: 20_000_000n, estimatedSeconds: CCTP_CHAINS[src]!.standardSeconds });
      expect((quotes[0]!.raw as any).transfer).toBe('standard');
      expect(quotes[0]!.fees[1]).toMatchObject({ asset: { network: src, asset: 'native' }, amount: 180_000n * AVAX_GAS });
      expect(calls.some((c) => c.url.includes('allowance'))).toBe(false);
      expect(checkQuote(quotes[0]!, r, NOW)).toBeNull();
    }
  });

  it('base -> solana: the mint needs SOL — fee, used-nonce rent, and the token account when it is missing', async () => {
    const run = async (batch: unknown, recipient = SOL_A) => {
      const m = mock([['/v2/burn/USDC/fees/', fx('fees-6-5')], ['/v2/fastBurn/USDC/allowance', fx('allowance')], [NETWORKS.base.rpc[0]!, gas('base')], [NETWORKS.solana.rpc[0]!, batch]]);
      const r = req(usdc('base'), usdc('solana'), 25_000_000n, { recipient });
      return { quotes: await provider.quote(r, ctxOf(m.http)), calls: m.calls, r };
    };
    const has = await run(fx('rpc-solana-mint-batch'));
    expect(has.quotes).toHaveLength(2);
    expect(has.quotes[1]!.amountOut).toBe(25_000_000n - 3_250n); // 1.3 bps
    expect(has.quotes[0]!.fees[2]).toEqual({ kind: 'network', asset: { network: 'solana', asset: 'native' }, amount: 5_000n + 695_960n, includedInOutput: false, estimated: true });
    expect(has.quotes[0]!.steps[0]!.contracts.slice(2)).toEqual([{ network: 'solana', address: CCTP_SOLANA.messageTransmitter, role: 'program' }, { network: 'solana', address: CCTP_SOLANA.tokenMessengerMinter, role: 'program' }]);
    expect((has.quotes[0]!.raw as any).burn.args.mintRecipient).toBeNull(); // the token account, derived at build time
    const sol = has.calls.find((c) => c.url === NETWORKS.solana.rpc[0])!;
    expect(sol.body.map((b: any) => [b.method, b.params[0]])).toEqual([['getMinimumBalanceForRentExemption', 9], ['getMinimumBalanceForRentExemption', 165], ['getTokenAccountsByOwner', SOL_A]]);
    expect(sol.body[2].params[1]).toEqual({ mint: usdc('solana').asset });
    for (const q of has.quotes) expect(checkQuote(q, has.r, NOW)).toBeNull();

    const missing = await run(fx('rpc-solana-mint-batch-no-token-account'));
    expect(missing.quotes[0]!.fees[2]!.amount).toBe(5_000n + 695_960n + 1_488_440n);
    expect(missing.quotes[0]!.steps[0]!.via[3]).toMatch(/to create the recipient's USDC token account \(it does not exist yet/);

    // a placeholder recipient (indicative quote): existence cannot be checked, so the account is priced in
    const rents = fx('rpc-solana-mint-batch-no-token-account').filter((a: any) => a.id < 2);
    const unknown = await run(rents, 'RECIPIENT');
    expect(unknown.quotes[0]!.fees[2]!.amount).toBe(5_000n + 695_960n + 1_488_440n);
    expect(unknown.calls.find((c) => c.url === NETWORKS.solana.rpc[0])!.body).toHaveLength(2);
  });

  it('solana -> arbitrum: two signatures and the refundable MessageSent rent on the source side', async () => {
    const { http } = mock([['/v2/burn/USDC/fees/', fx('fees-5-3')], ['/v2/fastBurn/USDC/allowance', fx('allowance')], [NETWORKS.solana.rpc[0]!, fx('rpc-solana-burn-batch')], [NETWORKS.arbitrum.rpc[0]!, gas('base')]]);
    const r = req(usdc('solana'), usdc('arbitrum'), 40_000_000n);
    const [std, fast] = await provider.quote(r, ctxOf(http));
    expect(std!.estimatedSeconds).toBe(17); expect(fast!.estimatedSeconds).toBe(1);
    expect(fast!.amountOut).toBe(39_996_000n);
    const sol = { network: 'solana', asset: 'native' };
    expect(fast!.fees).toEqual([
      { kind: 'protocol', asset: r.to, amount: 4_000n, includedInOutput: true, estimated: false },
      { kind: 'network', asset: sol, amount: 10_000n, includedInOutput: false, estimated: true },
      { kind: 'network', asset: sol, amount: 2_824_480n, includedInOutput: false, estimated: true },
      { kind: 'network', asset: { network: 'arbitrum', asset: 'native' }, amount: 200_000n * BASE_GAS, includedInOutput: false, estimated: true },
    ]);
    expect(fast!.steps[0]!.contracts.slice(0, 2)).toEqual([{ network: 'solana', address: CCTP_SOLANA.tokenMessengerMinter, role: 'program' }, { network: 'solana', address: CCTP_SOLANA.messageTransmitter, role: 'program' }]);
    expect((fast!.raw as any).burn).toMatchObject({ approval: null, args: { destinationDomain: 3, mintRecipient: evmAddressToBytes32(EVM_B), burnToken: usdc('solana').asset } });
    expect(checkQuote(fast!, r, NOW)).toBeNull();
  });

  it('drops the Fast quote when Circle\'s allowance cannot absorb the burn, and tiny or oversized amounts', async () => {
    const low = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/fastBurn/USDC/allowance', { allowance: 24.999999, lastUpdated: '2026-11-11T01:15:46.761Z' }]]));
    expect((await provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(low.http))).map((q) => (q.raw as any).transfer)).toEqual(['standard']);
    const exact = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/fastBurn/USDC/allowance', { allowance: 25, lastUpdated: 'x' }]]));
    expect(await provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(exact.http))).toHaveLength(2);
    // one base unit: maxFee (1) would not be below the amount, which the contract requires
    expect((await provider.quote(req(usdc('ethereum'), usdc('base'), 1n), ctxOf(mock(evmRules('fees-0-6', 'ethereum', 'base')).http))).map((q) => (q.raw as any).transfer)).toEqual(['standard']);
    const none = mock([]);
    expect(await provider.quote(req(usdc('ethereum'), usdc('base'), USDC_BURN_LIMIT + 1n), ctxOf(none.http))).toEqual([]);
    expect(await provider.quote(req(usdc('ethereum'), usdc('base'), 0n), ctxOf(none.http))).toEqual([]);
    expect(none.calls).toHaveLength(0);
    expect(await provider.quote(req(usdc('ethereum'), usdc('base'), USDC_BURN_LIMIT), ctxOf(mock(evmRules('fees-0-6', 'ethereum', 'base')).http))).toHaveLength(2);
  });

  it('treats Iris\' "invalid domain" as no route and every other failure as a failure', async () => {
    const noRoute = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/burn/USDC/fees/', httpError(400, fx('error-invalid-domain'))]]));
    expect(await provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(noRoute.http))).toEqual([]);
    const cases: [Error, string][] = [[httpError(500, { error: 'boom' }), 'http'], [new ProviderError('cctp', 'rate_limited', '429'), 'rate_limited'], [new ProviderError('cctp', 'unavailable', 'fetch failed'), 'unavailable'], [new ProviderError('cctp', 'bad_response', 'non-JSON answer'), 'bad_response']];
    for (const [err, code] of cases) {
      const m = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/burn/USDC/fees/', err]]));
      await expect(provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(m.http))).rejects.toMatchObject({ code });
    }
    // the allowance endpoint failing is a failure too (a Fast quote is never advertised blind)
    const noAllowance = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/fastBurn/USDC/allowance', httpError(503, {})]]));
    await expect(provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(noAllowance.http))).rejects.toMatchObject({ code: 'http' });
  });

  it('falls back to the registry\'s second RPC endpoint, and fails when no endpoint answers', async () => {
    const down = new ProviderError('cctp', 'unavailable', 'connect ECONNREFUSED');
    const second = mock(evmRules('fees-0-6', 'ethereum', 'base', [[NETWORKS.ethereum.rpc[0]!, down], [NETWORKS.ethereum.rpc[1]!, gas('ethereum')]]));
    const quotes = await provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(second.http));
    expect(quotes[0]!.fees[1]!.amount).toBe(180_000n * ETH_GAS);
    expect(second.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(expect.arrayContaining([...NETWORKS.ethereum.rpc]));
    const dead = mock(evmRules('fees-0-6', 'ethereum', 'base', [[NETWORKS.base.rpc[0]!, down], [NETWORKS.base.rpc[1]!, down]]));
    await expect(provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(dead.http))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects malformed or hostile answers with a schema error', async () => {
    const good = fx('fees-0-6');
    const patched = (f: (a: any[]) => unknown) => { const a = structuredClone(good); return f(a) ?? a; };
    const badFees: unknown[] = [
      patched((a) => { a[0].minimumFee = -1; }), patched((a) => { a[0].minimumFee = '1'; }), patched((a) => { a[0].minimumFee = 1e-7; }),
      patched((a) => { a[0].minimumFee = 1.23456789; }), patched((a) => { a[0].minimumFee = 5000; }), patched((a) => { a[1].minimumFee = null; }),
      patched((a) => { delete a[0].minimumFee; }), patched((a) => { a[0].finalityThreshold = 500; }), patched((a) => { a[1].finalityThreshold = 1000; }),
      patched((a) => [a[0]]), // no Standard entry
      patched((a) => [...a, a[0]]), patched((a) => { a[0].forwardFee = { low: -1, med: 1.5, high: 'x' }; }),
      [], {}, null, 'ok', { finalityThreshold: 2000, minimumFee: 0 },
    ];
    for (const bad of badFees) {
      const m = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/burn/USDC/fees/', () => bad]]));
      await expect(provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(m.http)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'schema' });
    }
    for (const bad of [{ allowance: -5, lastUpdated: 'x' }, { allowance: '1000000' }, { lastUpdated: 'x' }, { allowance: 1e21, lastUpdated: 'x' }, null]) {
      const m = mock(evmRules('fees-0-6', 'ethereum', 'base', [['/v2/fastBurn/USDC/allowance', () => bad]]));
      await expect(provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(m.http)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'schema' });
    }
    for (const bad of [{ result: '12' }, { result: '0x' }, { result: '0x0' }, { result: `0x${'f'.repeat(20)}` }, { result: 41 }, { error: { code: -32000 } }, null]) {
      const m = mock(evmRules('fees-0-6', 'ethereum', 'base', [[NETWORKS.base.rpc[0]!, () => bad], [NETWORKS.base.rpc[1]!, () => bad]]));
      await expect(provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(m.http)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'schema' });
    }
    for (const bad of [[{ id: 0, result: 695960.5 }, { id: 1, result: 1 }, { id: 2, result: { value: [] } }], [{ id: 0, result: -1 }, { id: 1, result: 1 }, { id: 2, result: { value: [] } }], [{ id: 0, result: 1 }, { id: 0, result: 1 }, { id: 2, result: { value: [] } }], [{ id: 0, result: 1 }, { id: 1, result: 1 }, { id: 2, result: {} }], [{ id: 0, result: 1 }]]) {
      const m = mock([['/v2/burn/USDC/fees/', fx('fees-6-5')], ['/v2/fastBurn/USDC/allowance', fx('allowance')], [NETWORKS.base.rpc[0]!, gas('base')], ['solana', () => bad]]);
      await expect(provider.quote(req(usdc('base'), usdc('solana'), 25_000_000n, { recipient: SOL_A }), ctxOf(m.http)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'schema' });
    }
  });

  it('propagates a timeout when the caller aborts', async () => {
    const ac = new AbortController();
    const hang = (signal?: AbortSignal) => new Promise<never>((_res, rej) => signal!.addEventListener('abort', () => rej(new ProviderError('cctp', 'timeout', 'This operation was aborted')), { once: true }));
    const http: HttpClient = { getJson: (_u, init) => hang(init?.signal), postJson: (_u, _b, init) => hang(init?.signal) };
    const p = provider.quote(req(usdc('ethereum'), usdc('base'), 25_000_000n), ctxOf(http, ac.signal));
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('cctp: EURC quotes (CCTP for non-USDC)', () => {
  const QUOTE = '/v2/quote/cctpx/';
  const byRequest = (std: Reply, fast: Reply): Reply => (_u: string, body: any) => { const v = body.requests.length ? fast : std; return typeof v === 'function' ? (v as any)() : v; };
  const rules = (std: Reply, fast: Reply, src = 'base', dst = 'ethereum'): [string, Reply][] => [[QUOTE, byRequest(std, fast)], [NETWORKS[src]!.rpc[0]!, gas('base')], [NETWORKS[dst]!.rpc[0]!, gas('ethereum')]];

  it('base -> ethereum: full amount minted, Circle\'s fee paid upfront in ETH on the source chain', async () => {
    const { http, calls } = mock(rules(fx('eurc-quote-6-0-standard'), fx('eurc-quote-6-0-fast')));
    const r = req(eurc('base'), eurc('ethereum'), 25_000_000n);
    const quotes = await provider.quote(r, ctxOf(http));
    expect(quotes.map((q) => (q.raw as any).transfer)).toEqual(['standard', 'fast']);
    const [std, fast] = quotes as [typeof quotes[0], typeof quotes[0]];
    const eth = { network: 'base', asset: 'native' };
    const gasFees = [
      { kind: 'network', asset: eth, amount: 440_000n * BASE_GAS, includedInOutput: false, estimated: true },
      { kind: 'network', asset: { network: 'ethereum', asset: 'native' }, amount: 240_000n * ETH_GAS, includedInOutput: false, estimated: true },
    ];
    expect(std.fees).toEqual([{ kind: 'protocol', asset: eth, amount: 122_436_486_072_850n, includedInOutput: false, estimated: false }, ...gasFees]);
    expect(fast.fees).toEqual([
      { kind: 'protocol', asset: eth, amount: 1_366_555_249_465n, includedInOutput: false, estimated: false },
      { kind: 'protocol', asset: eth, amount: 122_436_486_072_850n, includedInOutput: false, estimated: false }, ...gasFees,
    ]);
    for (const q of quotes) {
      expect(q).toMatchObject({ amountOut: 25_000_000n, minAmountOut: 25_000_000n, priceImpactBps: 0, atomic: false, refundable: false, executability: { class: 'quote_only' } });
      expect(checkQuote(q, r, NOW)).toBeNull();
      expect(q.steps[0]!.contracts).toEqual([
        { network: 'base', address: CCTPX.eurcTokenManager, role: 'spender' }, { network: 'base', address: CCTPX.service, role: 'bridge' },
        { network: 'ethereum', address: CCTP_EVM.messageTransmitter, role: 'bridge' }, { network: 'ethereum', address: CCTPX.service, role: 'bridge' },
      ]);
    }
    // the provider's own validity
    expect(std.expiresAt).toBe(1_794_359_868_000); expect(fast.expiresAt).toBe(1_794_359_869_000);
    expect(std.estimatedSeconds).toBe(19 * 60); expect(fast.estimatedSeconds).toBe(8);
    expect((fast.raw as any).quote).toEqual(fx('eurc-quote-6-0-fast'));
    expect((fast.raw as any).burn).toMatchObject({ contract: CCTPX.service, approval: { token: eurc('base').asset, spender: CCTPX.eurcTokenManager, amount: '25000000' }, value: '123803041322315', minFinalityThreshold: 1000 });
    const posts = calls.filter((c) => c.url.includes(QUOTE));
    expect(posts.map((c) => c.url)).toEqual(Array(2).fill(`https://iris-api.circle.com/v2/quote/cctpx/${CCTPX.eurcTokenId}/6/0`));
    expect(posts.map((c) => c.body)).toEqual([
      { amount: '25000000', feeToken: `0x${'0'.repeat(40)}`, requests: [] },
      { amount: '25000000', feeToken: `0x${'0'.repeat(40)}`, requests: [{ type: 'PRE_FINALITY' }] },
    ]);
  });

  it('avalanche -> base: Standard only, one quote request', async () => {
    const { http, calls } = mock([[QUOTE, fx('eurc-quote-1-6-standard')], [NETWORKS.avalanche.rpc[0]!, gas('avalanche')], [NETWORKS.base.rpc[0]!, gas('base')]]);
    const r = req(eurc('avalanche'), eurc('base'), 25_000_000n);
    const quotes = await provider.quote(r, ctxOf(http));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ amountOut: 25_000_000n, estimatedSeconds: 8 });
    expect(quotes[0]!.fees[0]).toEqual({ kind: 'protocol', asset: { network: 'avalanche', asset: 'native' }, amount: 29_776_083_849_452_121n, includedInOutput: false, estimated: false });
    expect(calls.filter((c) => c.url.includes(QUOTE))).toHaveLength(1);
    expect(checkQuote(quotes[0]!, r, NOW)).toBeNull();
  });

  it('no route when Iris refuses the route; Standard only when it refuses the fast quote; failures otherwise', async () => {
    const refused = httpError(400, fx('eurc-error-token-not-on-route'));
    expect(await provider.quote(req(eurc('base'), eurc('ethereum'), 25_000_000n), ctxOf(mock(rules(refused, refused)).http))).toEqual([]);
    const stdOnly = await provider.quote(req(eurc('base'), eurc('ethereum'), 25_000_000n), ctxOf(mock(rules(fx('eurc-quote-6-0-standard'), httpError(400, { errorCode: 'FX_SYMBOL_NOT_CONFIGURED' }))).http));
    expect(stdOnly.map((q) => (q.raw as any).transfer)).toEqual(['standard']);
    await expect(provider.quote(req(eurc('base'), eurc('ethereum'), 25_000_000n), ctxOf(mock(rules(httpError(502, {}), fx('eurc-quote-6-0-fast'))).http))).rejects.toMatchObject({ code: 'http' });
    await expect(provider.quote(req(eurc('base'), eurc('ethereum'), 25_000_000n), ctxOf(mock(rules(fx('eurc-quote-6-0-standard'), httpError(500, {}))).http))).rejects.toMatchObject({ code: 'http' });
  });

  it('rejects malformed or hostile quotes', async () => {
    const std = fx('eurc-quote-6-0-standard'), fast = fx('eurc-quote-6-0-fast');
    const patch = (base: any, f: (q: any) => void) => { const q = structuredClone(base); f(q); return q; };
    const badStd = [
      patch(std, (q) => { q.feeToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; }), // fee in another token
      patch(std, (q) => { q.feeTotalAmount = '122436486072851'; }), // items do not add up
      patch(std, (q) => { q.feeTotalAmount = '1.5'; }), patch(std, (q) => { q.items[0].amount = '-5'; }), patch(std, (q) => { q.items[0].amount = 122436486072850; }),
      patch(std, (q) => { q.items[0].args[0] = '0x3d26699fb5d40190fc3fa0dcbc1cd24e558355043c1997572ff9fd6efbb3fdca'; }), // quote for cirBTC
      patch(std, (q) => { q.items = fast.items; q.feeTotalAmount = fast.feeTotalAmount; }), // a fast fee nobody asked for
      patch(std, (q) => { q.items[0].type = 'FORWARD'; }),
      patch(std, (q) => { q.items[0].amount = q.feeTotalAmount = '2000000000000000000'; }), // 2 ETH for a 25 EURC transfer
      patch(std, (q) => { q.expiry.expiresAt = 1_794_359_749; }), // already expired
      patch(std, (q) => { q.expiry.mode = 'BLOCK'; }), patch(std, (q) => { delete q.signedQuote; }), patch(std, (q) => { q.signedQuote = 'not hex'; }), patch(std, (q) => { q.items = []; }), null, [],
    ];
    for (const bad of badStd) await expect(provider.quote(req(eurc('base'), eurc('ethereum'), 25_000_000n), ctxOf(mock(rules(bad, fast)).http)), JSON.stringify(bad).slice(0, 200)).rejects.toMatchObject({ code: 'schema' });
    const badFast = [
      patch(fast, (q) => { q.items[0].args[1] = '26000000'; }), // priced for another amount
      std, // the fast fee is missing
    ];
    for (const bad of badFast) await expect(provider.quote(req(eurc('base'), eurc('ethereum'), 25_000_000n), ctxOf(mock(rules(std, bad)).http))).rejects.toMatchObject({ code: 'schema' });
  });
});

describe('cctp: recipient encoding and message parsing (what the signer will verify)', () => {
  it('encodes EVM and Solana recipients as bytes32', () => {
    expect(evmAddressToBytes32('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d')).toBe('0x00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d');
    expect(() => evmAddressToBytes32('0x1234')).toThrow();
    expect(solanaAddressToBytes32('11111111111111111111111111111111')).toBe(`0x${'0'.repeat(64)}`);
    expect(solanaAddressToBytes32('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61');
    expect(() => solanaAddressToBytes32('0OIl')).toThrow();
  });
  it('decodes a real attested V2 burn message exactly as Iris does', () => {
    const m = fx('message-arbitrum-base-fast').messages[0], d = m.decodedMessage, b = d.decodedMessageBody;
    const got = decodeCctpMessageV2(m.message);
    const pad = (a: string) => evmAddressToBytes32(a);
    expect(got).toMatchObject({
      version: 1, sourceDomain: Number(d.sourceDomain), destinationDomain: Number(d.destinationDomain), nonce: d.nonce,
      sender: pad(d.sender), recipient: pad(d.recipient), destinationCaller: d.destinationCaller,
      minFinalityThreshold: Number(d.minFinalityThreshold), finalityThresholdExecuted: Number(d.finalityThresholdExecuted),
    });
    expect(got.body).toEqual({
      version: 1, burnToken: pad(b.burnToken), mintRecipient: pad(b.mintRecipient), amount: BigInt(b.amount), messageSender: pad(b.messageSender),
      maxFee: BigInt(b.maxFee), feeExecuted: BigInt(b.feeExecuted), expirationBlock: BigInt(b.expirationBlock), hookData: '0x',
    });
    // the checks the signer would apply before signing receiveMessage for this transfer
    expect(got).toMatchObject({ sourceDomain: CCTP_CHAINS.arbitrum!.domain, destinationDomain: CCTP_CHAINS.base!.domain, sender: pad(CCTP_EVM.tokenMessenger), recipient: pad(CCTP_EVM.tokenMessenger), destinationCaller: `0x${'0'.repeat(64)}` });
    expect(got.body.burnToken).toBe(pad(usdc('arbitrum').asset));
    expect(got.body.feeExecuted).toBe(cctpFee(got.body.amount, 1.4).fee);
    expect(got.body.feeExecuted <= got.body.maxFee).toBe(true);
    expect(() => decodeCctpMessageV2(m.message.slice(0, 300))).toThrow();
    expect(() => decodeCctpMessageV2('nope')).toThrow();
  });
});

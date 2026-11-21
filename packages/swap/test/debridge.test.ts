/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/debridge.test.ts
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

// deBridge (DLN) adapter against real, unmodified answers of GET https://dln.debridge.finance/v1.0/dln/order/create-tx
// recorded on 2026-11-10 (fixtures/debridge/*.json) with public addresses. Nothing in those answers was signed or submitted.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import { checkQuote, DEFAULT_POLICY, httpClient, ProviderError, ProviderRuntime, type AssetRef, type ProviderContext, type SwapQuoteRequest } from '../src/index.ts';
import { createProviders } from '../src/providers/index.ts';
import { createDebridgeProvider, DLN_API, DLN_CHAINS } from '../src/providers/debridge.ts';

const fx = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/debridge/${name}.json`, import.meta.url), 'utf8'));
const tok = (network: string, symbol: string): AssetRef => ({ network, asset: NETWORKS[network]!.tokens.find((t) => t.symbol === symbol)!.id });
const nat = (network: string): AssetRef => ({ network, asset: 'native' });
const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', TRON = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
const DLN_SOURCE = '0xeF4fB24aD0916217251F553c0596F8Edc630EB66', DLN_DESTINATION = '0xE7351Fd770A37282b91D153Ee690B63579D6dd7f', ROUTER = '0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251';
const NOW = 1_794_000_000_000;

const CASES: Record<string, SwapQuoteRequest> = {
  'base-usdc-sol-usdc': { from: tok('base', 'USDC'), to: tok('solana', 'USDC'), amountIn: 25_000_000n, sender: EVM, recipient: SOL, slippageBps: 50 },
  'eth-link-sol-sol': { from: tok('ethereum', 'LINK'), to: nat('solana'), amountIn: 3_000_000_000_000_000_000n, sender: EVM, recipient: SOL, slippageBps: 50 },
  'eth-eth-sol-sol': { from: nat('ethereum'), to: nat('solana'), amountIn: 12_000_000_000_000_000n, sender: EVM, recipient: SOL, slippageBps: 50 },
  'sol-usdc-arb-usdc': { from: tok('solana', 'USDC'), to: tok('arbitrum', 'USDC'), amountIn: 25_000_000n, sender: SOL, recipient: EVM, slippageBps: 50 },
  'arb-usdc-tron-usdt': { from: tok('arbitrum', 'USDC'), to: tok('tron', 'USDT'), amountIn: 30_000_000n, sender: EVM, recipient: TRON, slippageBps: 50 },
  'arb-usdc-tron-trx': { from: tok('arbitrum', 'USDC'), to: nat('tron'), amountIn: 30_000_000n, sender: EVM, recipient: TRON, slippageBps: 50 },
  'tron-usdt-eth-usdt': { from: tok('tron', 'USDT'), to: tok('ethereum', 'USDT'), amountIn: 30_000_000n, sender: TRON, recipient: EVM, slippageBps: 50 },
  'base-usdc-hyper-usdc': { from: tok('base', 'USDC'), to: tok('hyperevm', 'USDC'), amountIn: 25_000_000n, sender: EVM, recipient: EVM, slippageBps: 50 },
  'tron-trx-base-usdc': { from: nat('tron'), to: tok('base', 'USDC'), amountIn: 100_000_000n, sender: TRON, recipient: EVM, slippageBps: 50 },
  'hyper-hype-base-usdc': { from: nat('hyperevm'), to: tok('base', 'USDC'), amountIn: 500_000_000_000_000_000n, sender: EVM, recipient: EVM, slippageBps: 50 },
  'polygon-pol-bsc-bnb': { from: nat('polygon'), to: nat('bsc'), amountIn: 100_000_000_000_000_000_000n, sender: EVM, recipient: EVM, slippageBps: 50 },
};
const dln = createDebridgeProvider();
function ctxOf(payload: unknown, seen: { url?: string } = {}): ProviderContext {
  return { signal: new AbortController().signal, now: () => NOW,
    http: { postJson: async () => { throw new Error('DLN estimates are requested with GET'); }, getJson: async (url) => { seen.url = url; return payload; } } };
}
const viaFetch = (status: number, body: string): ProviderContext => ({ signal: new AbortController().signal, now: () => NOW, http: httpClient('debridge', (async () => new Response(body, { status })) as typeof fetch) });
const run = async (name: string, payload: unknown = fx(name), req: SwapQuoteRequest = CASES[name]!) => (await dln.quote(req, ctxOf(payload)));
const one = async (name: string) => { const q = await run(name); expect(q).toHaveLength(1); expect(checkQuote(q[0]!, CASES[name]!, NOW)).toBeNull(); return q[0]!; };
const tamper = (name: string, f: (d: any) => void) => { const d = fx(name); f(d); return d; };
const schemaError = (p: Promise<unknown>, re?: RegExp) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof ProviderError && e.provider === 'debridge' && e.code === 'schema' && (!re || re.test(e.message)));

describe('debridge: capabilities', () => {
  it('declares the wallet networks DLN serves, with deBridge chain ids, and is registered', () => {
    const c = dln.capabilities();
    expect(c.networks.sort()).toEqual(['arbitrum', 'avalanche', 'base', 'bsc', 'ethereum', 'hyperevm', 'optimism', 'polygon', 'solana', 'tron']);
    expect(c).toMatchObject({ crossChain: true, needsKey: false, configured: true, kinds: ['bridge'] });
    // deBridge has its own ids for Solana, HyperEVM (not 999) and TRON (not 728126428)
    expect(DLN_CHAINS.solana!.chainId).toBe(7565164); expect(DLN_CHAINS.hyperevm!.chainId).toBe(100000022); expect(DLN_CHAINS.tron!.chainId).toBe(100000026);
    for (const net of ['ethereum', 'optimism', 'bsc', 'polygon', 'base', 'arbitrum', 'avalanche']) expect(String(DLN_CHAINS[net]!.chainId)).toBe(NETWORKS[net]!.chainRef);
    expect(createProviders().map((p) => p.id)).toContain('debridge');
  });
  it('filters pairs locally: cross-chain only, registry assets only', () => {
    expect(dln.supportsPair(tok('base', 'USDC'), tok('solana', 'USDC'))).toBe(true);
    expect(dln.supportsPair(tok('tron', 'USDT'), nat('hyperevm'))).toBe(true);
    expect(dln.supportsPair(nat('arbitrum'), tok('arbitrum', 'USDC'))).toBe(false); // DLN has no same-chain swap (recorded: error-same-chain)
    expect(fx('error-same-chain').errorId).toBe('SAME_SOURCE_AND_DESTINATION_CHAINS');
    for (const n of ['bitcoin', 'sui', 'litecoin', 'stellar', 'xrpl', 'aptos', 'cosmos', 'near', 'ton']) expect(dln.supportsPair(nat('base'), nat(n))).toBe(false);
    expect(dln.supportsPair(nat('base'), { network: 'solana', asset: 'So11111111111111111111111111111111111111112' })).toBe(false);
  });
});

describe('debridge: request', () => {
  it('asks for a market order with the wallet addresses as recipient and as both order authorities', async () => {
    const seen: { url?: string } = {};
    await dln.quote(CASES['base-usdc-sol-usdc']!, ctxOf(fx('base-usdc-sol-usdc'), seen));
    const u = new URL(seen.url!);
    expect(u.origin + u.pathname).toBe(`${DLN_API}/dln/order/create-tx`); expect(DLN_API).toBe('https://dln.debridge.finance/v1.0');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      srcChainId: '8453', srcChainTokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', srcChainTokenInAmount: '25000000',
      dstChainId: '7565164', dstChainTokenOut: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dstChainTokenOutAmount: 'auto', prependOperatingExpenses: 'false',
      dstChainTokenOutRecipient: SOL, senderAddress: EVM, srcChainOrderAuthorityAddress: EVM, dstChainOrderAuthorityAddress: SOL,
    });
  });
  it('uses the chain-coin ids DLN expects per family and large amounts without loss', async () => {
    const seen: { url?: string } = {};
    await dln.quote(CASES['polygon-pol-bsc-bnb']!, ctxOf(fx('polygon-pol-bsc-bnb'), seen));
    let p = new URL(seen.url!).searchParams;
    expect([p.get('srcChainId'), p.get('srcChainTokenIn'), p.get('srcChainTokenInAmount'), p.get('dstChainId')]).toEqual(['137', '0x0000000000000000000000000000000000000000', '100000000000000000000', '56']);
    await dln.quote(CASES['arb-usdc-tron-trx']!, ctxOf(fx('arb-usdc-tron-trx'), seen));
    p = new URL(seen.url!).searchParams;
    expect([p.get('dstChainId'), p.get('dstChainTokenOut'), p.get('dstChainTokenOutRecipient')]).toEqual(['100000026', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', TRON]);
    await dln.quote(CASES['eth-eth-sol-sol']!, ctxOf(fx('eth-eth-sol-sol'), seen));
    expect(new URL(seen.url!).searchParams.get('dstChainTokenOut')).toBe('11111111111111111111111111111111');
    await dln.quote(CASES['base-usdc-hyper-usdc']!, ctxOf(fx('base-usdc-hyper-usdc'), seen));
    expect(new URL(seen.url!).searchParams.get('dstChainId')).toBe('100000022');
  });
});

describe('debridge: field mapping', () => {
  it('EVM -> Solana, USDC Base -> USDC Solana: fixed output, every fee component, contracts, flags', async () => {
    const q = await one('base-usdc-sol-usdc'), req = CASES['base-usdc-sol-usdc']!, raw = fx('base-usdc-sol-usdc');
    expect(q.id).toBe(`debridge:${raw.orderId}`); expect(q.provider).toBe('debridge');
    // the take amount is written in the order: the recipient gets exactly this or the order is not filled
    expect(q.amountOut).toBe(24_242_915n); expect(q.minAmountOut).toBe(24_242_915n);
    expect(q.fees).toEqual([
      { kind: 'protocol', asset: nat('base'), amount: 1_000_000_000_000_000n, includedInOutput: false, estimated: false }, // flat fee 0.001 ETH, paid on top
      { kind: 'network', asset: nat('base'), amount: 4_369_714_560_000n, includedInOutput: false, estimated: true }, // gas of the order transaction
      { kind: 'protocol', asset: tok('base', 'USDC'), amount: 10_000n, includedInOutput: true, estimated: false }, // 4 bps of the input
      { kind: 'provider', asset: tok('solana', 'USDC'), amount: 9_996n, includedInOutput: true, estimated: false }, // taker margin, 4 bps
      { kind: 'bridge', asset: tok('solana', 'USDC'), amount: 737_089n, includedInOutput: true, estimated: true }, // solver's operating expenses
    ]);
    expect(25_000_000n - 10_000n - 9_996n - 737_089n).toBe(q.amountOut); // the three deducted components account for the whole difference
    expect(q.estimatedSeconds).toBe(1); expect(q.priceImpactBps).toBe(303); // usdPriceImpact -3.02834 %
    expect(q.expiresAt).toBe(NOW + 30_000); expect(q.firmness).toBe('firm'); expect(q.atomic).toBe(false); expect(q.refundable).toBe(true);
    expect(q.executability.class).toBe('opaque'); expect((q.executability as { reason: string }).reason).toMatch(/DLN API builds/);
    expect(q.steps).toEqual([{ kind: 'bridge', provider: 'debridge', from: req.from, to: req.to, via: ['DLN'], contracts: [
      { network: 'base', address: DLN_SOURCE, role: 'router' }, { network: 'base', address: DLN_SOURCE, role: 'spender' }, { network: 'base', address: DLN_SOURCE, role: 'vault' },
      { network: 'solana', address: 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo', role: 'program' }] }]);
    expect((q.raw as { orderId: string }).orderId).toBe(raw.orderId);
    expect(JSON.stringify(q.raw)).not.toMatch(/userPoints/); // validated fields only
  });
  it('a token that is not a reserve asset goes through DeBridgeRouter with a pre-order swap and a destination swap', async () => {
    const q = await one('eth-link-sol-sol');
    expect(q.amountOut).toBe(361_149_576n); expect(q.minAmountOut).toBe(q.amountOut); // not maxTheoreticalAmount (363326262): slippage reserves are already taken
    expect(q.steps[0]!.via).toEqual(['pre-order swap', 'DLN', 'destination swap']);
    expect(q.steps[0]!.contracts.slice(0, 3)).toEqual([{ network: 'ethereum', address: ROUTER, role: 'router' }, { network: 'ethereum', address: ROUTER, role: 'spender' }, { network: 'ethereum', address: DLN_SOURCE, role: 'vault' }]);
    expect(q.fees.map((f) => [f.kind, f.asset, f.amount, f.includedInOutput])).toEqual([
      ['protocol', nat('ethereum'), 1_000_000_000_000_000n, false], ['network', nat('ethereum'), 906_615_166_565_682n, false],
      ['protocol', tok('ethereum', 'USDC'), 12_325n, true], ['provider', tok('solana', 'USDC'), 12_320n, true], ['bridge', tok('solana', 'USDC'), 743_910n, true]]);
    expect(q.priceImpactBps).toBe(308);
  });
  it('a native input is sent as value together with the flat fee; no spender', async () => {
    const q = await one('eth-eth-sol-sol');
    expect(BigInt(fx('eth-eth-sol-sol').tx.value)).toBe(12_000_000_000_000_000n + 1_000_000_000_000_000n);
    expect(q.amountOut).toBe(284_608_568n); expect(q.steps[0]!.contracts.some((c) => c.role === 'spender')).toBe(false);
    expect(q.fees[0]).toEqual({ kind: 'protocol', asset: nat('ethereum'), amount: 1_000_000_000_000_000n, includedInOutput: false, estimated: false });
    const pol = await one('polygon-pol-bsc-bnb');
    expect(pol.amountOut).toBe(12_238_319_658_602_409n); expect(pol.fees[0]!.amount).toBe(500_000_000_000_000_000n); // flat fee on Polygon: 0.5 POL
    // taker margin and operating expenses are charged in USDC on BNB Chain (Binance-Peg USDC, in the registry since v5): reported as fee items; the raw answer is kept too
    expect(pol.fees.map((f) => [f.kind, f.asset])).toEqual([['protocol', nat('polygon')], ['network', nat('polygon')], ['protocol', tok('polygon', 'USDC')], ['provider', tok('bsc', 'USDC')], ['bridge', tok('bsc', 'USDC')]]);
    expect(JSON.stringify(pol.raw)).toMatch(/EstimatedOperatingExpenses/);
  });
  it('Solana source: flat fee and network cost in lamports, programs instead of contracts', async () => {
    const q = await one('sol-usdc-arb-usdc');
    expect(q.amountOut).toBe(24_201_767n); expect(q.estimatedSeconds).toBe(9);
    expect(q.fees.slice(0, 2)).toEqual([
      { kind: 'protocol', asset: nat('solana'), amount: 15_000_000n, includedInOutput: false, estimated: false }, // 0.015 SOL
      { kind: 'network', asset: nat('solana'), amount: 24_162_360n, includedInOutput: false, estimated: true }]); // fee + priority fee + account rents
    expect(q.steps[0]!.contracts).toEqual([{ network: 'solana', address: 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4', role: 'program' }, { network: 'arbitrum', address: DLN_DESTINATION, role: 'bridge' }]);
  });
  it('TRON in both directions and HyperEVM', async () => {
    const from = await one('tron-usdt-eth-usdt');
    expect(from.amountOut).toBe(27_939_980n); expect(from.estimatedSeconds).toBe(15);
    expect(from.fees[0]).toEqual({ kind: 'protocol', asset: nat('tron'), amount: 4_000_000n, includedInOutput: false, estimated: false }); // 4 TRX
    expect(from.fees[1]).toEqual({ kind: 'network', asset: nat('tron'), amount: 35_750_000n, includedInOutput: false, estimated: true });
    // the API names the TRON contract in 0x form; the quote reports the pinned base58 DlnSource it corresponds to
    expect(fx('tron-usdt-eth-usdt').tx.to).toBe('0xE6f924E3C42350684aF70F798c3cA2533A4c5Bd0');
    expect(from.steps[0]!.contracts[0]).toEqual({ network: 'tron', address: 'TX2Ut1reF59i2WPzsYVoMfA25EkUkavnd5', role: 'router' });
    expect(from.steps[0]!.via).toEqual(['DLN', 'destination swap']);
    const to = await one('arb-usdc-tron-usdt');
    expect(to.amountOut).toBe(23_951_643n); expect(to.priceImpactBps).toBe(2024); // 6 USDT of operating expenses on a 30 USDC order
    expect(to.fees[4]).toEqual({ kind: 'bridge', asset: tok('tron', 'USDT'), amount: 6_006_369n, includedInOutput: true, estimated: true });
    expect(to.steps[0]!.contracts.at(-1)).toEqual({ network: 'tron', address: 'TXCbCdoHjg28g36X5jnWTP88mRzx54RqXp', role: 'bridge' });
    const trx = await one('arb-usdc-tron-trx');
    expect(trx.amountOut).toBe(25_708_107n); expect(trx.steps[0]!.to).toEqual(nat('tron')); expect(trx.priceImpactBps).toBe(7272);
    // native TRX input: TRON's DeBridgeRouter (0x form in the answer), value = 100 TRX + the 4 TRX flat fee
    const trxIn = await one('tron-trx-base-usdc');
    expect(BigInt(fx('tron-trx-base-usdc').tx.value)).toBe(104_000_000n);
    expect(trxIn.steps[0]!.contracts.slice(0, 2)).toEqual([{ network: 'tron', address: 'TRsqznGXF7mSYhRxU49L3HY13QW1v9yBZa', role: 'router' }, { network: 'tron', address: 'TX2Ut1reF59i2WPzsYVoMfA25EkUkavnd5', role: 'vault' }]);
    expect(trxIn.amountOut).toBe(29_667_770n); expect(trxIn.steps[0]!.via).toEqual(['pre-order swap', 'DLN']);
    // native HYPE input: flat fee 0.05 HYPE
    const hypeIn = await one('hyper-hype-base-usdc');
    expect(hypeIn.fees[0]).toEqual({ kind: 'protocol', asset: nat('hyperevm'), amount: 50_000_000_000_000_000n, includedInOutput: false, estimated: false });
    expect(hypeIn.amountOut).toBe(35_483_289n);
    const hype = await one('base-usdc-hyper-usdc');
    expect(hype.amountOut).toBe(24_546_646n); expect(hype.steps[0]!.contracts.at(-1)).toEqual({ network: 'hyperevm', address: DLN_DESTINATION, role: 'bridge' });
  });
  it('the requested slippage does not change a DLN quote (the output is fixed, there is no slippage parameter)', async () => {
    const seen: { url?: string } = {};
    const a = await dln.quote({ ...CASES['eth-link-sol-sol']!, slippageBps: 10 }, ctxOf(fx('eth-link-sol-sol'), seen));
    expect(a[0]!.minAmountOut).toBe(361_149_576n); expect(seen.url).not.toMatch(/slippage/i);
  });
});

describe('debridge: no route and provider errors', () => {
  it('"amount too small" (HTTP 400, ERROR_LOW_GIVE_AMOUNT) is no route', async () => {
    const body = JSON.stringify(fx('no-route-low-amount'));
    expect(JSON.parse(body).errorId).toBe('ERROR_LOW_GIVE_AMOUNT');
    expect(await dln.quote({ ...CASES['base-usdc-sol-usdc']!, amountIn: 1000n }, viaFetch(400, body))).toEqual([]);
  });
  it('other provider errors throw', async () => {
    const req = CASES['base-usdc-sol-usdc']!;
    await expect(dln.quote(req, viaFetch(400, JSON.stringify(fx('error-not-a-token'))))).rejects.toMatchObject({ code: 'http' });
    await expect(dln.quote(req, viaFetch(400, JSON.stringify(fx('error-same-chain'))))).rejects.toMatchObject({ code: 'http' });
    await expect(dln.quote(req, viaFetch(500, '{"errorId":"INTERNAL_SERVER_ERROR"}'))).rejects.toMatchObject({ code: 'http' });
    await expect(dln.quote(req, viaFetch(429, 'Too Many Requests'))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(dln.quote(req, viaFetch(200, 'gateway timeout'))).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('does not call the API for a pair it cannot serve', async () => {
    const http = { getJson: async () => { throw new Error('called'); }, postJson: async () => { throw new Error('called'); } };
    expect(await dln.quote({ ...CASES['base-usdc-sol-usdc']!, to: nat('bitcoin') }, { signal: new AbortController().signal, now: () => NOW, http })).toEqual([]);
    expect(await dln.quote({ ...CASES['base-usdc-sol-usdc']!, to: nat('base') }, { signal: new AbortController().signal, now: () => NOW, http })).toEqual([]);
  });
  it('reports a timeout when the deadline aborts the request', async () => {
    const slow = (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch;
    const rt = new ProviderRuntime(dln, { ...DEFAULT_POLICY, timeoutMs: 30 }, httpClient('debridge', slow));
    await expect(rt.quote(CASES['base-usdc-sol-usdc']!)).rejects.toMatchObject({ code: 'timeout' });
    expect(rt.stats().timeouts).toBe(1);
  });
});

describe('debridge: malformed and hostile answers are rejected', () => {
  const name = 'base-usdc-sol-usdc';
  it('rejects answers that are not the documented shape', async () => {
    await schemaError(run(name, null)); await schemaError(run(name, {})); await schemaError(run(name, []));
    await schemaError(run(name, fx('estimate-without-addresses'))); // an estimate with no order and no transaction is not what was asked
    for (const k of ['estimation', 'tx', 'order', 'orderId', 'fixFee']) await schemaError(run(name, tamper(name, (d) => { delete d[k]; })), new RegExp(k));
    await schemaError(run(name, tamper(name, (d) => { delete d.estimation.dstChainTokenOut.amount; })));
    await schemaError(run(name, tamper(name, (d) => { delete d.order.approximateFulfillmentDelay; })));
    await schemaError(run(name, tamper(name, (d) => { d.tx.data = 'b930370100'; })));
    await schemaError(run(name, tamper(name, (d) => { delete d.estimation.costsDetails[2].payload; })), /EstimatedOperatingExpenses/);
  });
  it('rejects amounts that are not plain base-unit integers', async () => {
    for (const v of ['24242915.5', '-24242915', '2.4e7', '0x171eb23', '', 24242915, null]) {
      await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.amount = v; })));
      await schemaError(run(name, tamper(name, (d) => { d.fixFee = v; })));
      await schemaError(run(name, tamper(name, (d) => { d.estimation.costsDetails[0].payload.feeAmount = v; })));
      await schemaError(run(name, tamper(name, (d) => { d.estimatedTransactionFee.total = v; })));
    }
    await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.amount = '0'; d.estimation.dstChainTokenOut.recommendedAmount = '0'; })), /output amount/);
    await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.amount = '25000000'; })), /recommended/); // more than a solver would fill
  });
  it('rejects an estimate for another token, chain, decimals or input amount', async () => {
    await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.address = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; })), /another pair/);
    await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1x'; })), /another pair/);
    await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.chainId = 42161; })), /another pair/);
    await schemaError(run(name, tamper(name, (d) => { d.estimation.srcChainTokenIn.address = '0x0000000000000000000000000000000000000000'; })), /another pair/);
    await schemaError(run(name, tamper(name, (d) => { d.estimation.dstChainTokenOut.decimals = 9; })), /decimals/);
    await schemaError(run(name, tamper(name, (d) => { d.estimation.srcChainTokenIn.amount = '25736992'; d.estimation.srcChainTokenIn.mutatedWithOperatingExpense = true; })), /input amount/);
    await schemaError(run(name, fx(name), { ...CASES[name]!, amountIn: 26_000_000n }), /input amount/);
  });
  it('rejects an order for another recipient, another target contract or another value', async () => {
    await schemaError(run(name, fx(name), { ...CASES[name]!, recipient: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy' }), /recipient/);
    await schemaError(run('sol-usdc-arb-usdc', fx('sol-usdc-arb-usdc'), { ...CASES['sol-usdc-arb-usdc']!, recipient: '0x000000000000000000000000000000000000dEaD' }), /recipient/);
    await schemaError(run('arb-usdc-tron-usdt', fx('arb-usdc-tron-usdt'), { ...CASES['arb-usdc-tron-usdt']!, recipient: 'TXCbCdoHjg28g36X5jnWTP88mRzx54RqXp' }), /recipient/);
    await expect(run(name, fx(name), { ...CASES[name]!, recipient: 'not-an-address' })).rejects.toMatchObject({ code: 'bad_response' });
    await schemaError(run(name, tamper(name, (d) => { d.tx.to = '0x000000000000000000000000000000000000dEaD'; })), /pinned DLN contract/);
    await schemaError(run(name, tamper(name, (d) => { delete d.tx.to; })), /pinned DLN contract/);
    await schemaError(run('tron-usdt-eth-usdt', tamper('tron-usdt-eth-usdt', (d) => { d.tx.to = DLN_SOURCE; })), /pinned DLN contract/); // the EVM DlnSource is not TRON's
    await schemaError(run(name, tamper(name, (d) => { d.tx.value = '2000000000000000'; })), /value/);
    await schemaError(run('eth-eth-sol-sol', tamper('eth-eth-sol-sol', (d) => { d.tx.value = d.fixFee; })), /value/); // the native input must be in the value
    await schemaError(run('sol-usdc-arb-usdc', tamper('sol-usdc-arb-usdc', (d) => { d.tx.to = DLN_SOURCE; })), /Solana/);
    // checksum-case differences on EVM addresses are not differences
    expect(await run('sol-usdc-arb-usdc', fx('sol-usdc-arb-usdc'), { ...CASES['sol-usdc-arb-usdc']!, recipient: EVM.toLowerCase() })).toHaveLength(1);
  });
  it('a price impact outside the plausible range is dropped by the aggregator check', async () => {
    const q = await run(name, tamper(name, (d) => { d.usdPriceImpact = -150; }));
    expect(checkQuote(q[0]!, CASES[name]!, NOW)).toBe('invalid price impact');
    const none = await run(name, tamper(name, (d) => { delete d.usdPriceImpact; }));
    expect(none[0]!.priceImpactBps).toBeNull();
  });
});

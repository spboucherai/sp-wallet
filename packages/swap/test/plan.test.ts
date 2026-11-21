/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/test/plan.test.ts
 * Module           : swap
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// The any-to-any planner (packages/swap/src/plan.ts): enumeration over executable legs only, amounts chained leg after leg
// (expected and worst case), limits of each leg's own asset, missing gas named per network, ranking, comparison-only quotes.
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@spw/core';
import {
  checkPlan, comparisonQuotes, enumeratePlans, planId, PlanQuoteError, pricePlan, rankPlans, whyNotExecutable,
  type AssetRef, type LegQuote, type PlanCaps, type PlanContext, type PlanLegSpec, type PricedPlan, type QuoteLeg,
} from '../src/index.ts';

const tok = (n: string, s: string): AssetRef => ({ network: n, asset: NETWORKS[n]!.tokens.find((t) => t.symbol === s)!.id });
const nat = (n: string): AssetRef => ({ network: n, asset: 'native' });
const USDC = (n: string) => tok(n, 'USDC');
const LINK_ARB = tok('arbitrum', 'LINK'), CBBTC_BASE = tok('base', 'cbBTC'), BTC = nat('bitcoin'), LTC = nat('litecoin'), SOL = nat('solana');
const CAPS: PlanCaps = {
  swap: { ethereum: 'kyberswap', base: 'kyberswap', arbitrum: 'kyberswap', optimism: 'kyberswap', polygon: 'kyberswap', bsc: 'kyberswap', avalanche: 'kyberswap', hyperevm: 'kyberswap', solana: 'jupiter' },
  cctp: Object.fromEntries(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'hyperevm'].map((n) => [n, { usdc: USDC(n).asset, fast: ['ethereum', 'base', 'arbitrum', 'optimism'].includes(n) }])),
  thor: [{ network: 'bitcoin', asset: 'native', source: true }, { network: 'litecoin', asset: 'native', source: true }, { network: 'dogecoin', asset: 'native', source: false },
    { network: 'ethereum', asset: 'native', source: true }, { network: 'ethereum', asset: USDC('ethereum').asset, source: true }, { network: 'ethereum', asset: tok('ethereum', 'WBTC').asset, source: true }],
};
const shape = (legs: PlanLegSpec[]) => legs.map((l) => `${l.kind}${l.speed ? `(${l.speed})` : ''}@${l.from.network}${l.from.network === l.to.network ? '' : `>${l.to.network}`}`).join(' → ');
const shapes = (from: AssetRef, to: AssetRef) => enumeratePlans(from, to, CAPS).map(shape);

describe('enumeration: only legs the wallet executes, hub = native USDC', () => {
  it('same network: one direct swap', () => {
    expect(shapes(LINK_ARB, nat('arbitrum'))).toEqual(['swap@arbitrum']);
    expect(shapes(SOL, tok('solana', 'USDC'))).toEqual(['swap@solana']);
  });
  it('USDC on A → token on B is "bridge then swap"; token → USDC is "swap then bridge"; USDC → USDC is the bridge alone', () => {
    expect(shapes(USDC('arbitrum'), CBBTC_BASE)).toEqual(['bridge(fast)@arbitrum>base → swap@base', 'bridge(standard)@arbitrum>base → swap@base']);
    expect(shapes(LINK_ARB, USDC('base'))).toEqual(['swap@arbitrum → bridge(fast)@arbitrum>base', 'swap@arbitrum → bridge(standard)@arbitrum>base']);
    expect(shapes(USDC('arbitrum'), USDC('base'))).toEqual(['bridge(fast)@arbitrum>base', 'bridge(standard)@arbitrum>base']);
    // Polygon is not a Fast source
    expect(shapes(USDC('polygon'), USDC('base'))).toEqual(['bridge(standard)@polygon>base']);
  });
  it('token on A → token on B: swap, bridge, swap — the three legs chain through USDC on both networks', () => {
    const plans = enumeratePlans(LINK_ARB, CBBTC_BASE, CAPS);
    expect(plans.map(shape)).toEqual(['swap@arbitrum → bridge(fast)@arbitrum>base → swap@base', 'swap@arbitrum → bridge(standard)@arbitrum>base → swap@base']);
    for (const p of plans) {
      expect(p[0]!.to).toEqual(USDC('arbitrum')); expect(p[1]!.from).toEqual(USDC('arbitrum')); expect(p[1]!.to).toEqual(USDC('base')); expect(p[2]!.from).toEqual(USDC('base')); expect(p[2]!.to).toEqual(CBBTC_BASE);
      for (let k = 1; k < p.length; k++) expect(p[k]!.from).toEqual(p[k - 1]!.to);            // contiguous
    }
    expect(new Set(plans.map(planId)).size).toBe(plans.length);
  });
  it('THORChain variants: direct pinned pair, and through USDC on Ethereum to continue by CCTP', () => {
    expect(shapes(BTC, nat('ethereum'))).toEqual(['xswap@bitcoin>ethereum', 'xswap@bitcoin>ethereum → swap@ethereum']);
    expect(shapes(BTC, LTC)).toEqual(['xswap@bitcoin>litecoin']);
    expect(shapes(BTC, USDC('base'))).toEqual(['xswap@bitcoin>ethereum → bridge(fast)@ethereum>base', 'xswap@bitcoin>ethereum → bridge(standard)@ethereum>base']);
    expect(shapes(BTC, CBBTC_BASE)).toEqual(['xswap@bitcoin>ethereum → bridge(fast)@ethereum>base → swap@base', 'xswap@bitcoin>ethereum → bridge(standard)@ethereum>base → swap@base']);
    // towards Bitcoin from another EVM network: swap to USDC, CCTP to Ethereum, THORChain out
    expect(shapes(LINK_ARB, BTC)).toEqual(['swap@arbitrum → bridge(fast)@arbitrum>ethereum → xswap@ethereum>bitcoin', 'swap@arbitrum → bridge(standard)@arbitrum>ethereum → xswap@ethereum>bitcoin']);
    // Dogecoin is a destination only
    expect(shapes(nat('dogecoin'), BTC)).toEqual([]);
    expect(shapes(nat('ethereum'), nat('dogecoin'))).toContain('xswap@ethereum>dogecoin');
  });
  it('never more than three legs, never the same network twice, never two legs of the same kind in a row', () => {
    for (const [a, b] of [[LINK_ARB, CBBTC_BASE], [BTC, CBBTC_BASE], [LINK_ARB, BTC], [tok('polygon', 'LINK'), tok('avalanche', 'USDT')], [nat('ethereum'), LTC]] as const) for (const p of enumeratePlans(a, b, CAPS)) {
      expect(p.length).toBeLessThanOrEqual(3);
      for (let k = 1; k < p.length; k++) expect(p[k]!.kind === p[k - 1]!.kind, shape(p)).toBe(false);
      const visits = p.flatMap((l) => (l.from.network === l.to.network ? [] : [l.from.network])); expect(new Set(visits).size, shape(p)).toBe(visits.length);
    }
  });
  it('v8 — with the Solana CCTP leg in the capabilities, Solana ↔ EVM plans exist: Jupiter, CCTP, KyberSwap, each an executable leg', () => {
    const caps: PlanCaps = { ...CAPS, cctp: { ...CAPS.cctp, solana: { usdc: USDC('solana').asset, fast: true } } };
    const sh = (a: AssetRef, b: AssetRef) => enumeratePlans(a, b, caps).map(shape);
    expect(sh(USDC('solana'), USDC('base'))).toEqual(['bridge(fast)@solana>base', 'bridge(standard)@solana>base']);
    expect(sh(USDC('polygon'), USDC('solana'))).toEqual(['bridge(standard)@polygon>solana']);
    expect(sh(SOL, USDC('base'))).toEqual(['swap@solana → bridge(fast)@solana>base', 'swap@solana → bridge(standard)@solana>base']);
    expect(sh(SOL, CBBTC_BASE)).toEqual(['swap@solana → bridge(fast)@solana>base → swap@base', 'swap@solana → bridge(standard)@solana>base → swap@base']);
    expect(sh(LINK_ARB, SOL)).toEqual(['swap@arbitrum → bridge(fast)@arbitrum>solana → swap@solana', 'swap@arbitrum → bridge(standard)@arbitrum>solana → swap@solana']);
    for (const p of enumeratePlans(SOL, CBBTC_BASE, caps)) { expect(p.map((l) => l.via)).toEqual(['jupiter', 'cctp', 'kyberswap']); expect(p[1]!.from).toEqual(USDC('solana')); expect(p[1]!.to).toEqual(USDC('base')); }
    // Bitcoin ↔ Solana: THORChain to USDC on Ethereum, CCTP to Solana, Jupiter — and back
    expect(sh(BTC, USDC('solana'))).toEqual(['xswap@bitcoin>ethereum → bridge(fast)@ethereum>solana', 'xswap@bitcoin>ethereum → bridge(standard)@ethereum>solana']);
    expect(sh(BTC, SOL)).toEqual(['xswap@bitcoin>ethereum → bridge(fast)@ethereum>solana → swap@solana', 'xswap@bitcoin>ethereum → bridge(standard)@ethereum>solana → swap@solana']);
    expect(sh(SOL, BTC)).toEqual(['swap@solana → bridge(fast)@solana>ethereum → xswap@ethereum>bitcoin', 'swap@solana → bridge(standard)@solana>ethereum → xswap@ethereum>bitcoin']);
    // where no path exists the reason is no longer "solana_evm_bridge": the bridge exists, something else is missing
    expect(sh(nat('bsc'), SOL)).toEqual([]);
    expect(whyNotExecutable(nat('bsc'), SOL, caps)).toEqual({ code: 'no_executable_path' });
    expect(whyNotExecutable(nat('tron'), SOL, caps)).toEqual({ code: 'network_without_execution', network: 'tron' });
  });
  it('without that leg (capabilities that do not list Solana for CCTP) Solana ↔ EVM has NO plan, and the reason is said — not faked', () => {
    expect(shapes(SOL, USDC('base'))).toEqual([]);
    expect(shapes(nat('ethereum'), SOL)).toEqual([]);
    expect(shapes(tok('solana', 'USDC'), USDC('base'))).toEqual([]);          // CCTP supports Solana; this wallet's signer does not, yet
    expect(whyNotExecutable(SOL, USDC('base'), CAPS)).toEqual({ code: 'solana_evm_bridge' });
    expect(whyNotExecutable(nat('ethereum'), SOL, CAPS)).toEqual({ code: 'solana_evm_bridge' });
    expect(whyNotExecutable(nat('tron'), USDC('base'), CAPS)).toEqual({ code: 'network_without_execution', network: 'tron' });
    expect(whyNotExecutable(USDC('base'), nat('xrpl'), CAPS)).toEqual({ code: 'network_without_execution', network: 'xrpl' });
    expect(whyNotExecutable(nat('bsc'), USDC('base'), CAPS)).toEqual({ code: 'no_executable_path' });   // swaps on BNB Chain, but no CCTP there
    expect(whyNotExecutable(SOL, SOL, CAPS)).toEqual({ code: 'same_asset' });
  });
});

// a scripted market: 1 LINK = 10 USDC, 1 cbBTC = 80 000 USDC, 0.5 % slippage on swaps; CCTP Standard free, Fast 1.3 bps
const gasFee = (network: string, amount: bigint) => ({ kind: 'network' as const, asset: nat(network), amount, includedInOutput: false, estimated: true });
const calls: string[] = [];
const market: QuoteLeg = async (leg, amountIn): Promise<LegQuote | null> => {
  calls.push(`${leg.kind}:${amountIn}`);
  if (leg.kind === 'bridge') { const fee = leg.speed === 'fast' ? (amountIn * 13n + 99_999n) / 100_000n : 0n;
    return { amountOut: amountIn - fee, minAmountOut: amountIn - fee, seconds: leg.speed === 'fast' ? 8 : 1140, fees: [{ kind: 'protocol', asset: leg.to, amount: fee, includedInOutput: true, estimated: false }, gasFee(leg.from.network, 30_000_000_000_000n), gasFee(leg.to.network, 20_000_000_000_000n)] }; }
  if (leg.kind === 'xswap') return { amountOut: amountIn * 700n, minAmountOut: amountIn * 693n, seconds: 1200, fees: [{ kind: 'network', asset: leg.to, amount: 1_000_000n, includedInOutput: true, estimated: false }], minIn: 20_000n };
  const out = leg.to.asset === USDC(leg.to.network).asset ? amountIn / 10n ** 11n : amountIn / 800n;   // LINK(18) → USDC(6); USDC(6) → cbBTC(8)
  return { amountOut: out, minAmountOut: (out * 995n) / 1000n, seconds: 45, fees: [gasFee(leg.from.network, 40_000_000_000_000n)] };
};
const usd = (a: AssetRef, amt: bigint) => (a.asset === 'native' && a.network !== 'bitcoin' ? Number(amt) / 1e18 * 2000 : null);
const ctx = (o: Partial<PlanContext> & { bal?: Record<string, bigint | null> } = {}): PlanContext => ({
  asset: (a) => { const n = NETWORKS[a.network]!, d = a.asset === 'native' ? n.native : n.tokens.find((t) => t.id.toLowerCase() === a.asset.toLowerCase())!; return { symbol: d.symbol, decimals: d.decimals }; },
  perTx: { 'arbitrum:LINK': '5000000000000000000', 'arbitrum:USDC': '50000000', 'base:USDC': '50000000', 'ethereum:USDC': '50000000', 'bitcoin:BTC': '70000' },
  daily: { 'arbitrum:LINK': '10000000000000000000', 'arbitrum:USDC': '100000000', 'base:USDC': '100000000', 'ethereum:USDC': '100000000', 'bitcoin:BTC': '140000' }, spentToday: {},
  balance: (a) => { const k = `${a.network}:${a.asset === 'native' ? 'native' : 'token'}`; return o.bal && k in o.bal ? o.bal[k]! : 10n ** 20n; }, ...o });
const three = () => enumeratePlans(LINK_ARB, CBBTC_BASE, CAPS);
const LINK4 = 4n * 10n ** 18n;

describe('pricing: real quotes leg after leg, on the expected AND on the guaranteed amount', () => {
  it('chains amounts: leg 2 is quoted on leg 1 expected output and on its minimum; the plan shows both ends', async () => {
    calls.length = 0;
    const std = await pricePlan(three().find((p) => p[1]!.speed === 'standard')!, LINK4, market, usd);
    expect(std.legs.map((l) => [l.expectedIn, l.worstIn, l.expectedOut, l.worstOut])).toEqual([
      [LINK4, LINK4, 40_000000n, 39_800000n],                 // 4 LINK → 40 USDC expected, 39.8 guaranteed
      [40_000000n, 39_800000n, 40_000000n, 39_800000n],       // Standard: no fee
      [40_000000n, 39_800000n, 50000n, 49501n],               // 40 USDC → 0.0005 cbBTC expected; worst: 39.8 USDC → 0.0004975, less 0.5 %
    ]);
    expect([std.expectedOut, std.worstOut]).toEqual([50000n, 49501n]);
    expect(calls).toEqual([`swap:${LINK4}`, 'bridge:40000000', 'bridge:39800000', 'swap:40000000', 'swap:39800000']);   // the first leg is asked once
    expect(std.seconds).toBe(45 + 1140 + 45); expect(std.approvals).toBe(3);
    // fees not deducted from an output, valued: gas on Arbitrum (swap + burn) and on Base (mint + swap)
    expect(std.extraFeesUsd).toBeCloseTo((40e12 + 30e12 + 20e12 + 40e12) / 1e18 * 2000, 6);
    const fast = await pricePlan(three().find((p) => p[1]!.speed === 'fast')!, LINK4, market, usd);
    expect(fast.legs[1]!.expectedOut).toBe(40_000000n - 5200n);          // 1.3 bps of 40 USDC
    expect(fast.expectedOut).toBeLessThan(std.expectedOut); expect(fast.seconds).toBe(98);
  });
  it('a leg without a quote names itself; nothing is invented', async () => {
    const none: QuoteLeg = async (leg, a) => (leg.kind === 'bridge' ? null : market(leg, a));
    await expect(pricePlan(three()[0]!, LINK4, none)).rejects.toMatchObject({ leg: 1, code: 'no_route' });
    const down: QuoteLeg = async (leg, a) => { if (leg.from.network === 'base') throw new Error('HTTP 500'); return market(leg, a); };
    const e = await pricePlan(three()[0]!, LINK4, down).catch((x) => x);
    expect(e).toBeInstanceOf(PlanQuoteError); expect(e).toMatchObject({ leg: 2, code: 'provider', message: 'HTTP 500' });
    const liar: QuoteLeg = async (leg, a) => ({ ...(await market(leg, a))!, minAmountOut: 10n ** 30n });
    await expect(pricePlan(three()[0]!, LINK4, liar)).rejects.toMatchObject({ leg: 0, code: 'provider' });
  });
});

describe('constraints: each leg within the limits of ITS asset, minimums, gas on every network', () => {
  const priced = (amount = LINK4) => pricePlan(three().find((p) => p[1]!.speed === 'standard')!, amount, market, usd);
  it('a clean plan is startable', async () => {
    const p = checkPlan(await priced(), ctx());
    expect(p.executable).toBe(true); expect(p.issues).toEqual([]);
  });
  it('a three-leg plan consumes limits on three assets: the one that is exceeded is named', async () => {
    // 5 LINK is inside the LINK limit, but worth 50 USDC … and 6 LINK is not
    const six = checkPlan(await priced(6n * 10n ** 18n), ctx());
    expect(six.executable).toBe(false);
    expect(six.issues.filter((i) => i.blocking).map((i) => [i.code, i.leg, `${i.network}:${i.symbol}`])).toEqual([['limit_per_transfer', 0, 'arbitrum:LINK'], ['limit_per_transfer', 1, 'arbitrum:USDC'], ['limit_per_transfer', 2, 'base:USDC']]);
    // LINK fits its own limit; the USDC it becomes does not fit the USDC limit of the second and third legs
    const pricey: QuoteLeg = async (leg, a) => { const q = (await market(leg, a))!; return leg.kind === 'swap' && leg.from.network === 'arbitrum' ? { ...q, amountOut: q.amountOut * 13n / 10n, minAmountOut: q.minAmountOut * 13n / 10n } : q; };
    const p = checkPlan(await pricePlan(three()[1]!, LINK4, pricey), ctx());
    expect(p.issues.map((i) => [i.code, i.leg, i.symbol, i.need, i.have])).toEqual([['limit_per_transfer', 1, 'USDC', '52000000', '50000000'], ['limit_per_transfer', 2, 'USDC', '52000000', '50000000']]);
    // the daily limit counts what was already spent today on that asset
    const day = checkPlan(await priced(), ctx({ spentToday: { 'base:USDC': '70000000' } }));
    expect(day.issues.map((i) => [i.code, i.leg, i.have])).toEqual([['limit_daily', 2, '30000000']]);
    // an asset without a limit cannot be moved at all
    const none = checkPlan(await priced(), ctx({ perTx: { 'arbitrum:LINK': '5000000000000000000', 'base:USDC': '50000000' } }));
    expect(none.issues.find((i) => i.blocking)).toMatchObject({ code: 'limit_missing', leg: 1, network: 'arbitrum' });
    // close to a limit: a warning, not a refusal — the leg's own check decides when the real amount is known
    const near = checkPlan(await priced(49n * 10n ** 17n), ctx());
    expect(near.executable).toBe(true); expect(near.issues.map((i) => [i.code, i.blocking, i.leg])).toEqual([['limit_margin', false, 1], ['limit_margin', false, 2]]);
  });
  it('says exactly which coin is missing on which network', async () => {
    const p = checkPlan(await priced(), ctx({ bal: { 'base:native': 0n } }));
    expect(p.executable).toBe(false);
    expect(p.issues).toEqual([{ code: 'gas_missing', blocking: true, leg: null, network: 'base', symbol: 'ETH', need: String((20e12 + 40e12) * 2), have: '0', decimals: 18 }]);
    const both = checkPlan(await priced(), ctx({ bal: { 'base:native': 1n, 'arbitrum:native': 139_999_999_999_999n } }));
    expect(both.issues.map((i) => [i.code, i.network, i.need])).toEqual([['gas_missing', 'arbitrum', '140000000000000'], ['gas_missing', 'base', '120000000000000']]);
    // a balance that could not be read is said, and does not block: the leg's own preparation checks it again
    const unk = checkPlan(await priced(), ctx({ bal: { 'base:native': null } }));
    expect(unk.executable).toBe(true); expect(unk.issues.map((i) => i.code)).toEqual(['gas_unknown']);
  });
  it('the source amount is not available for fees when it is the network coin itself; the source balance must cover the amount', async () => {
    const ethToUsdc = enumeratePlans(nat('arbitrum'), USDC('base'), CAPS).find((p) => p[1]!.speed === 'standard')!;
    const swapEth: QuoteLeg = async (leg, a) => (leg.kind === 'swap' ? { amountOut: a / 500_000_000n, minAmountOut: a / 500_000_000n - 1n, seconds: 45, fees: [gasFee('arbitrum', 40_000_000_000_000n)] } : market(leg, a));   // 0.01 ETH → 20 USDC
    const c = ctx({ perTx: { 'arbitrum:ETH': '25000000000000000', 'arbitrum:USDC': '50000000' }, daily: { 'arbitrum:ETH': '50000000000000000', 'arbitrum:USDC': '100000000' }, bal: { 'arbitrum:native': 10n ** 16n + 100n } });
    const p = checkPlan(await pricePlan(ethToUsdc, 10n ** 16n, swapEth), c);
    expect(p.issues.filter((i) => i.blocking).map((i) => [i.code, i.network, i.have])).toEqual([['gas_missing', 'arbitrum', '100']]);
    const poor = checkPlan(await priced(), ctx({ bal: { 'arbitrum:token': 10n ** 18n } }));
    expect(poor.issues[0]).toMatchObject({ code: 'insufficient_balance', blocking: true, leg: 0, symbol: 'LINK', need: LINK4.toString(), have: (10n ** 18n).toString() });
  });
  it('THORChain minimum: a leg below the provider minimum is refused at planning', async () => {
    const legs = enumeratePlans(BTC, USDC('base'), CAPS).find((p) => p[1]!.speed === 'standard')!;
    const c = ctx({ bal: { 'bitcoin:native': 10n ** 8n } });
    expect(checkPlan(await pricePlan(legs, 15_000n, market), c).issues.find((i) => i.blocking)).toMatchObject({ code: 'below_minimum', leg: 0, symbol: 'BTC', need: '20000', have: '15000' });
    expect(checkPlan(await pricePlan(legs, 60_000n, market), c).executable).toBe(true);
    // the THORChain outbound fee is deducted from the output: it is a cost shown, not gas the wallet must hold
    expect((await pricePlan(legs, 60_000n, market)).legs[0]!.fees).toEqual([expect.objectContaining({ kind: 'network', includedInOutput: true, leg: 0 })]);
  });
});

describe('ranking and comparison-only quotes', () => {
  const mk = (id: string, worst: bigint, expected: bigint, o: Partial<PricedPlan> = {}): PricedPlan => ({ id, legs: [], amountIn: 1n, expectedOut: expected, worstOut: worst, seconds: 100, extraFeesUsd: 0, approvals: 1, issues: [], executable: true, ...o });
  it('ranks on the guaranteed worst case, expected output alongside; a startable plan always comes before one that is not', () => {
    const r = rankPlans([mk('a', 90n, 120n), mk('b', 95n, 100n), mk('c', 99n, 130n, { executable: false }), mk('d', 95n, 101n), mk('e', 95n, 101n, { seconds: 10 })]);
    expect(r.map((p) => p.id)).toEqual(['e', 'd', 'b', 'a', 'c']);
  });
  it('the real three-leg candidates: Standard guarantees more than Fast (no fee), Fast is faster', async () => {
    const plans = rankPlans(await Promise.all(three().map(async (legs) => checkPlan(await pricePlan(legs, LINK4, market), ctx()))));
    expect(plans.map((p) => p.legs[1]!.spec.speed)).toEqual(['standard', 'fast']);
    expect(plans[0]!.worstOut).toBeGreaterThan(plans[1]!.worstOut);
  });
  it('a cheaper quote the wallet cannot execute is never hidden: it is labelled comparison only', () => {
    const plans = [mk('plan', 95n, 100n)];
    const c = comparisonQuotes(plans, [{ id: 'lifi-1', providers: ['lifi'], amountOut: 104n, minAmountOut: 103n, executable: false }, { id: 'debridge-1', providers: ['debridge'], amountOut: 96n, minAmountOut: 94n, executable: false },
      { id: 'cctp-1', providers: ['cctp'], amountOut: 100n, minAmountOut: 100n, executable: true }]);
    expect(c.map((q) => [q.id, q.comparisonOnly, q.aboveBestPlan])).toEqual([['lifi-1', true, true], ['debridge-1', true, false]]);
    expect(comparisonQuotes([], [{ id: 'x', providers: ['lifi'], amountOut: 5n, minAmountOut: 4n, executable: false }])).toEqual([expect.objectContaining({ comparisonOnly: true, aboveBestPlan: true })]);
  });
});

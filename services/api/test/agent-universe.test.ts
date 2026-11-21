/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/agent-universe.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// V5, pure parts: agents on any execution-enabled network, universes of up to 12 market symbols, a cash leg, the gas
// reserve per network, mandates per network, universe-generic strategies, the registry-derived market symbol set.
import { beforeAll, describe, expect, it } from 'vitest';
import { cashLegs, DEFAULT_POLICY, getNetwork, hasMarketData, MANDATE_NETWORKS, parseUnits, tradableSymbols, type AssetDef, type NetworkDef } from '@spw/core';
import type { AgentRow } from '../src/agents/routes.ts';
import type { Holding } from '../src/agents/engine.ts';

let engine: typeof import('../src/agents/engine.ts'), routes: typeof import('../src/agents/routes.ts'), gas: typeof import('../src/agents/gas.ts'), strategies: typeof import('../src/agents/strategies.ts'),
  symbols: typeof import('../src/market/symbols.ts'), pipeline: typeof import('../src/market/pipeline.ts');
beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_WORKERS: 'off' });
  engine = await import('../src/agents/engine.ts'); routes = await import('../src/agents/routes.ts'); gas = await import('../src/agents/gas.ts'); strategies = await import('../src/agents/strategies.ts');
  symbols = await import('../src/market/symbols.ts'); pipeline = await import('../src/market/pipeline.ts');
});
const RISK = { maxExposurePct: 100, maxLossPct: 5, maxOrderUsd: 25, maxDailyUsd: 1000, maxOrdersPerDay: 50, mandateDays: 30, slippageBps: 50 };
const agent = (o: Partial<AgentRow> = {}) => ({ id: 'a', name: 'Any', network: 'base', universe: ['ETH', 'LINK'], cash: null, assets: null, risk: RISK, vault_index: 3, vault_address: '0x' + '11'.repeat(20), ...o }) as unknown as AgentRow;
const TWELVE = ['AAVE', 'AVAX', 'BNB', 'BTC', 'DOGE', 'ETH', 'LINK', 'LTC', 'POL', 'SOL', 'UNI', 'XRP'];
const tok = (symbol: string, k: number, decimals = 18): AssetDef => ({ id: `0x${k.toString(16).padStart(40, '0')}`, symbol, name: symbol, decimals });
/** A FIXED registry for one network: only the named tokens of today's registry, plus injected ones (stable when the real one grows). */
const fixed = (id: string, keep: string[], extra: AssetDef[] = []): NetworkDef => { const n = getNetwork(id); return { ...n, tokens: [...keep.map((x) => { const t = n.tokens.find((y) => y.symbol === x); if (!t) throw new Error(`${x} is not on ${id}`); return t; }), ...extra] }; };

describe('planning with many symbols', () => {
  const px = Object.fromEntries(TWELVE.map((s, k) => [s, 10 * (k + 1)]));
  const hold = (cash: number, units: Record<string, number> = {}, cashSymbol = 'USDC'): Holding[] => [{ symbol: cashSymbol, id: '0xcash', decimals: 6, units: cash }, ...TWELVE.map((s, k) => ({ symbol: s, id: `0x${k}`, decimals: k % 2 ? 8 : 18, units: units[s] ?? 0 }))];
  it('validates weights for 12 symbols and refuses a 13th', () => {
    const w = Object.fromEntries(TWELVE.map((s) => [s, 1 / 12]));
    expect(Object.keys(engine.checkWeights(w, TWELVE))).toHaveLength(12);
    expect(() => engine.checkWeights({ ...w, ADA: 0.01 }, TWELVE)).toThrow(/outside the agent's universe/);
    expect(() => engine.checkWeights(Object.fromEntries(TWELVE.map((s) => [s, 0.09])), TWELVE)).toThrow(/more than 1/);
    expect(engine.checkWeights({ ETH: 0.5, USDT: 0.5 }, ['ETH'], 'USDT')).toEqual({ ETH: 0.5 }); // the cash leg is not a weight
    expect(() => engine.checkWeights({ ETH: 0.5, USDC: 0.5 }, ['ETH'], 'USDT')).toThrow(/outside/);
  });
  it('walks a 12-symbol portfolio to its target one order at a time: sells first, then the largest buy', () => {
    const a = agent({ universe: TWELVE }), w = Object.fromEntries(TWELVE.map((s) => [s, 1 / 12])); // 1 200 USD → 100 USD each
    let h = hold(1200), orders = 0;
    for (; orders < 60; orders++) { // order cap 25 USD: four orders per symbol
      const p = engine.planOrder(a, w, h, px, 0, 0);
      if (!p.order) { expect(p.note).toBe('portfolio already at target'); break; }
      expect(p.order.fromSymbol).toBe('USDC'); expect(p.order.usd).toBeLessThanOrEqual(25);
      const usd = Number(p.order.amountIn) / 1e6, to = p.order.toSymbol;
      h = h.map((x) => (x.symbol === 'USDC' ? { ...x, units: x.units - usd } : x.symbol === to ? { ...x, units: x.units + usd / px[to]! } : x));
    }
    expect(orders).toBe(48);
    for (const s of TWELVE) expect(h.find((x) => x.symbol === s)!.units * px[s]!).toBeCloseTo(100, 6);
    expect(h[0]!.units).toBeCloseTo(0, 6);
    // one symbol far above its target and eleven below: the sale comes first, sized by the order cap, in the asset's own decimals
    const heavy = engine.planOrder(a, w, hold(0, { BTC: 30 }), px, 0, 0); // 30 BTC at 40 = 1 200 USD, target 100
    expect(heavy.order).toMatchObject({ fromSymbol: 'BTC', toSymbol: 'USDC', fromDecimals: 8, amountIn: 62_500_000n }); // 25 USD / 40 = 0.625 BTC
    expect(engine.planOrder(a, Object.fromEntries(TWELVE.map((s) => [s, 0])), hold(0, { XRP: 1 }), px, 0, 0).order).toMatchObject({ fromSymbol: 'XRP', toSymbol: 'USDC' });
  });
  it('trades against the cash leg the owner chose', () => {
    const a = agent({ universe: ['AVAX'], cash: 'USDT', network: 'avalanche' });
    const buy = engine.planOrder(a, { AVAX: 0.5 }, [{ symbol: 'USDT', id: '0xt', decimals: 6, units: 100 }, { symbol: 'AVAX', id: 'native', decimals: 18, units: 0 }], { AVAX: 20 }, 0, 0);
    expect(buy.order).toMatchObject({ fromSymbol: 'USDT', toSymbol: 'AVAX', fromId: '0xt', amountIn: 25_000000n });
    const sell = engine.planOrder(a, { AVAX: 0 }, [{ symbol: 'USDT', id: '0xt', decimals: 6, units: 0 }, { symbol: 'AVAX', id: 'native', decimals: 18, units: 1 }], { AVAX: 20 }, 0, 0);
    expect(sell.order).toMatchObject({ fromSymbol: 'AVAX', toSymbol: 'USDT', toId: '0xt' });
    // a USDC balance is not this agent's cash
    expect(engine.planOrder(a, { AVAX: 0.5 }, [{ symbol: 'USDC', id: '0xc', decimals: 6, units: 100 }, { symbol: 'AVAX', id: 'native', decimals: 18, units: 0 }], { AVAX: 20 }, 0, 0).order).toBeNull();
  });
  it('sizes every order in the decimals of the asset given up: an 18-decimal cash leg (BNB Smart Chain) like a 6-decimal one', () => {
    // the same portfolio on every execution-enabled network, with that network's own cash leg and native coin from the registry
    for (const id of MANDATE_NETWORKS) { const n = getNetwork(id), sym = n.native.symbol, a = agent({ network: id, universe: [sym] });
      const [cash, coin] = routes.agentAssets(a), held = (c: number, u: number): Holding[] => [{ symbol: cash!.symbol, id: cash!.id, decimals: cash!.decimals, units: c }, { symbol: coin!.symbol, id: coin!.id, decimals: coin!.decimals, units: u }];
      expect(cash!.decimals, id).toBe(cashLegs(n)[0]!.decimals);
      const buy = engine.planOrder(a, { [sym]: 0.5 }, held(100, 0), { [sym]: 50 }, 0, 0).order!; // target 50 USD, order cap 25 USD
      expect(buy, id).toMatchObject({ fromSymbol: 'USDC', toSymbol: sym, fromId: cash!.id, fromDecimals: cash!.decimals, toDecimals: 18, usd: 25 });
      expect(buy.amountIn, id).toBe(25n * 10n ** BigInt(cash!.decimals)); // 25 USDC: 25000000 in 6 decimals, 25000000000000000000 in 18
      const sell = engine.planOrder(a, { [sym]: 0 }, held(0, 3), { [sym]: 50 }, 0, 0).order!; // 150 USD of the coin, order cap 25 USD → 0.5 coin
      expect(sell, id).toMatchObject({ fromSymbol: sym, toSymbol: 'USDC', toId: cash!.id, toDecimals: cash!.decimals, amountIn: 500_000_000_000_000_000n });
      const odd = engine.planOrder(a, { [sym]: 1 }, held(7.654321, 0), { [sym]: 50 }, 0, 0).order!; // buys with the cash actually held, to the micro-dollar
      expect(odd.amountIn, id).toBe(parseUnits('7.654321', cash!.decimals));
    }
    expect(cashLegs(getNetwork('bsc'))[0]!.decimals).toBe(18); // the case this test exists for
    // the allocated capital is a USD amount kept in 6-decimal units whatever the cash leg: the paper book starts from it in whole units
    expect(routes.agentAssets(agent({ network: 'bsc', universe: ['BNB', 'ETH', 'BTC'] })).map((x) => [x.symbol, x.assetSymbol, x.decimals])).toEqual([['USDC', 'USDC', 18], ['BNB', 'BNB', 18], ['ETH', 'ETH', 18], ['BTC', 'WBTC', 8]]);
  });
});

describe('agent assets: one registry asset per market symbol, on the agent\'s network', () => {
  it('an agent created before V5 (no cash, no recorded choice) resolves exactly as before', () => {
    const base = getNetwork('base'), id = (s: string) => base.tokens.find((t) => t.symbol === s)!.id;
    expect(routes.agentAssets(agent({ universe: ['ETH', 'LINK', 'AAVE'] })).map((x) => [x.symbol, x.id, x.decimals])).toEqual([['USDC', id('USDC'), 6], ['ETH', 'native', 18], ['LINK', id('LINK'), 18], ['AAVE', id('AAVE'), 18]]);
    expect(routes.agentAssets(agent({ universe: ['USDC', 'ETH'] })).map((x) => x.symbol)).toEqual(['USDC', 'ETH']); // old rows could list the cash leg
    expect(routes.cashOf(agent())).toBe('USDC');
  });
  it('resolves per network, with the recorded representation, and reports the registry asset by name', () => {
    const eth = getNetwork('ethereum'), weth = eth.tokens.find((t) => t.symbol === 'WETH')!.id;
    const a = agent({ network: 'ethereum', universe: ['BTC', 'ETH', 'UNI'], assets: { ETH: weth } });
    expect(routes.agentAssets(a).map((x) => [x.symbol, x.assetSymbol, x.kind])).toEqual([['USDC', 'USDC', 'cash'], ['BTC', 'WBTC', 'wrapped'], ['ETH', 'WETH', 'wrapped'], ['UNI', 'UNI', 'token']]);
    expect(routes.agentAssets(agent({ network: 'arbitrum', universe: ['ETH', 'LINK', 'UNI', 'AAVE'] })).map((x) => x.id.length)).toEqual([42, 6, 42, 42, 42]);
    // a fixed small registry (Arbitrum with USDC, LINK and UNI only): what is not there is refused with a reason…
    const small = fixed('arbitrum', ['USDC', 'LINK', 'UNI']);
    expect(() => routes.agentAssets(agent({ network: 'arbitrum', universe: ['BTC'] }), small)).toThrow(/no asset of the wallet registry tracks BTC on Arbitrum One/);
    expect(() => routes.agentAssets(agent({ network: 'bsc', universe: ['BNB'] }), fixed('bsc', []))).toThrow(/no cash leg/);
    // …and when the registry grows, the same call picks the new asset up
    const grown = fixed('arbitrum', ['USDC', 'LINK', 'UNI'], [tok('cbBTC', 0xa1, 8), tok('ARB', 0xa2)]);
    expect(routes.agentAssets(agent({ network: 'arbitrum', universe: ['BTC', 'ARB'] }), grown).map((x) => x.assetSymbol)).toEqual(['USDC', 'cbBTC', 'ARB']);
    expect(tradableSymbols(grown).length).toBe(tradableSymbols(small).length + 2);
    // today's registry: bitcoin on Arbitrum is WBTC by default (reviewed rank 1) and cbBTC or tBTC by choice; on a real symbol that
    // no asset of the network tracks, the same refusal
    const arb = getNetwork('arbitrum');
    expect(routes.agentAssets(agent({ network: 'arbitrum', universe: ['BTC'] })).map((x) => [x.assetSymbol, x.decimals])).toEqual([['USDC', 6], ['WBTC', 8]]);
    expect(routes.agentAssets(agent({ network: 'arbitrum', universe: ['BTC'], assets: { BTC: arb.tokens.find((t) => t.symbol === 'tBTC')!.id } }))[1]).toMatchObject({ assetSymbol: 'tBTC', decimals: 18, issuer: expect.stringMatching(/Threshold/) });
    for (const s of ['SOL', 'XRP', 'DOGE'].filter((x) => hasMarketData(x) && !tradableSymbols(arb).some((t) => t.symbol === x)))
      expect(() => routes.agentAssets(agent({ network: 'arbitrum', universe: [s] })), s).toThrow(new RegExp(`no asset of the wallet registry tracks ${s} on Arbitrum One`));
    // BNB Smart Chain has a cash leg since registry v5: Binance-Peg USDC, 18 decimals
    expect(routes.agentAssets(agent({ network: 'bsc', universe: ['BNB'] })).map((x) => [x.symbol, x.name, x.kind, x.decimals])).toEqual([['USDC', 'Binance-Peg USD Coin', 'cash', 18], ['BNB', 'BNB', 'native', 18]]);
  });
});

describe('gas reserve per network', () => {
  const fee = DEFAULT_POLICY.maxFee, gwei = (x: number) => BigInt(Math.round(x * 1e9));
  it('is sized from the recent gas price, capped per order by the signer fee ceiling, with a floor of two orders at that ceiling', () => {
    for (const id of MANDATE_NETWORKS) expect(fee[id], id).toBeDefined(); // every execution-enabled network has a ceiling in the default policy
    const base = gas.reserveFromGas(gwei(0.01), BigInt(fee.base!)); // 450 000 gas at 0.01 gwei = 0.0000045 ETH per order
    expect(base.perOrder).toBe(4_500_000_000_000n);
    expect(base.reserve).toBe(2n * BigInt(fee.base!)); // 8 orders = 0.000036 ETH: the floor (2 × ceiling) governs
    const busyBase = gas.reserveFromGas(gwei(0.5), BigInt(fee.base!)); // 0.000225 ETH per order
    expect(busyBase.reserve).toBe(8n * 225_000_000_000_000n);
    const eth = gas.reserveFromGas(gwei(3), BigInt(fee.ethereum!)); // 0.00135 ETH per order
    expect(eth.perOrder).toBe(1_350_000_000_000_000n); expect(eth.reserve).toBe(10_800_000_000_000_000n); // 0.0108 ETH
    const spike = gas.reserveFromGas(gwei(80), BigInt(fee.ethereum!)); // one order would cost 0.036 ETH: above the ceiling, the signer would refuse it
    expect(spike.perOrder).toBe(BigInt(fee.ethereum!)); expect(spike.reserve).toBe(8n * BigInt(fee.ethereum!));
    expect(gas.reserveFromGas(0n, BigInt(fee.polygon!)).reserve).toBe(2n * BigInt(fee.polygon!)); // never zero
    for (const id of MANDATE_NETWORKS) { const r = gas.reserveFromGas(gwei(1), BigInt(fee[id]!)); expect(r.reserve >= 2n * BigInt(fee[id]!) && r.reserve <= 8n * BigInt(fee[id]!), id).toBe(true); }
    expect(() => gas.reserveFromGas(gwei(1), 0n)).toThrow();
  });
  it('measures how much of an order the network fee eats: dollars on Ethereum, a fraction of a cent on a layer 2', () => {
    const eth = gas.reserveFromGas(gwei(3), BigInt(fee.ethereum!)), base = gas.reserveFromGas(gwei(0.01), BigInt(fee.base!));
    const onEth = gas.feeShare(eth.perOrder, 18, 2000, 25), onBase = gas.feeShare(base.perOrder, 18, 2000, 25);
    expect(onEth).toBeCloseTo(0.108, 6); // 2.70 USD on a 25 USD order
    expect(onEth).toBeGreaterThan(gas.FEE_WARN_SHARE); expect(onBase).toBeLessThan(gas.FEE_WARN_SHARE);
    expect(gas.feeShare(eth.perOrder, 18, 2000, 5000)).toBeLessThan(gas.FEE_WARN_SHARE); // a large order absorbs it
  });
  it('no fee ceiling in the policy, no reserve: live trading cannot start', async () => {
    await expect(gas.gasReserve(getNetwork('base'), undefined)).rejects.toThrow(/no fee ceiling/);
  });
});

describe('mandate built for the agent\'s own network', () => {
  const now = Math.floor(Date.now() / 1000), px = { ETH: 2000, LINK: 10, UNI: 5, AAVE: 100, BTC: 60_000, AVAX: 20, POL: 0.5, HYPE: 25, EUR: 1.1 };
  it('pins network, vault and that network\'s asset ids, with caps in each asset\'s own decimals', () => {
    for (const id of MANDATE_NETWORKS) {
      const n = getNetwork(id);
      if (!cashLegs(n).length) { expect(() => routes.mandateFor(agent({ network: id, universe: [n.native.symbol] }), 'spw-0123456789abcdef', 'ab'.repeat(32), px, now), id).toThrow(/no cash leg/); continue; }
      const m = routes.mandateFor(agent({ network: id, universe: [n.native.symbol] }), 'spw-0123456789abcdef', 'ab'.repeat(32), { ...px, [n.native.symbol]: 50 }, now);
      expect(m.network, id).toBe(id); expect(m.vaultIndex).toBe(3);
      expect(m.assets, id).toEqual([cashLegs(n)[0]!.id, 'native']);
      const cash = cashLegs(n)[0]!; // 25 USD and 1 000 USD a day, in the cash leg's own decimals on that network
      expect(m.maxOrder[cash.id], id).toBe((25n * 10n ** BigInt(cash.decimals)).toString()); expect(m.maxDaily[cash.id], id).toBe((1000n * 10n ** BigInt(cash.decimals)).toString());
      expect(m.maxOrder.native, id).toBe('500000000000000000'); // 25 USD at 50 USD
      expect(m.maxSlippageBps).toBe(150); expect(m.expiresAt - m.createdAt).toBe(30 * 86400);
    }
    // pinned on purpose: 6 decimals on Base, 18 on BNB Smart Chain (Binance-Peg USDC) — the same 25 USD
    const capOn = (id: string) => { const n = getNetwork(id); return routes.mandateFor(agent({ network: id, universe: [n.native.symbol] }), 'spw-0123456789abcdef', 'ab'.repeat(32), { [n.native.symbol]: 50 }, now).maxOrder[cashLegs(n)[0]!.id]; };
    expect(capOn('base')).toBe('25000000'); expect(capOn('bsc')).toBe('25000000000000000000');
    const usdt = routes.mandateFor(agent({ network: 'bsc', universe: ['BNB'], cash: 'USDT' }), 'spw-0123456789abcdef', 'ab'.repeat(32), { BNB: 50 }, now);
    expect(usdt.assets[0]).toBe(cashLegs(getNetwork('bsc')).find((c) => c.symbol === 'USDT')!.id); expect(usdt.maxOrder[usdt.assets[0]!]).toBe('25000000000000000000');
    const eth = getNetwork('ethereum'), m = routes.mandateFor(agent({ network: 'ethereum', universe: ['BTC', 'ETH'] }), 'spw-0123456789abcdef', 'ab'.repeat(32), px, now);
    const wbtc = eth.tokens.find((t) => t.symbol === 'WBTC')!.id;
    expect(m.assets).toContain(wbtc); expect(m.maxOrder[wbtc]).toBe('41667'); // 25 USD of bitcoin, in WBTC's 8 decimals, at the BTC price
    // the owner chose tBTC (18 decimals) for the same symbol: the same 25 USD of bitcoin, in tBTC's own decimals, at the BTC price
    const tbtc = eth.tokens.find((t) => t.symbol === 'tBTC')!.id, m2 = routes.mandateFor(agent({ network: 'ethereum', universe: ['BTC', 'ETH'], assets: { BTC: tbtc } }), 'spw-0123456789abcdef', 'ab'.repeat(32), px, now);
    expect(m2.assets).toContain(tbtc); expect(m2.assets).not.toContain(wbtc); expect(m2.maxOrder[tbtc]).toBe('416670000000000'); // 0.00041667 tBTC
  });
  it('is refused when the signer could never price a symbol, when a price is missing, or above 12 assets', () => {
    expect(() => routes.mandateFor(agent({ universe: ['ETH', 'EUR'] }), 'spw-0123456789abcdef', 'ab'.repeat(32), px, now)).toThrow(/EUR is not listed on both/);
    expect(() => routes.mandateFor(agent({ universe: ['ETH', 'LINK'] }), 'spw-0123456789abcdef', 'ab'.repeat(32), { ETH: 2000 }, now)).toThrow(/no market price for LINK/);
    const all = tradableSymbols(getNetwork('ethereum')).filter((t) => t.live).map((t) => t.symbol);
    expect(all.length).toBeGreaterThanOrEqual(11);
    const prices = Object.fromEntries(all.map((s) => [s, 7]));
    expect(routes.mandateFor(agent({ network: 'ethereum', universe: all.slice(0, 11) }), 'spw-0123456789abcdef', 'ab'.repeat(32), prices, now).assets).toHaveLength(12); // 11 symbols + cash
    if (all.length >= 12) expect(() => routes.mandateFor(agent({ network: 'ethereum', universe: all.slice(0, 12) }), 'spw-0123456789abcdef', 'ab'.repeat(32), prices, now)).toThrow(/at most 12 assets/);
  });
});

describe('strategy ↔ agent fit', () => {
  const info = (universe: string[], o: { min?: number; max?: number; interval?: string } = {}) => { const generic = strategies.isGeneric(universe);
    return { generic, minSymbols: generic ? o.min ?? 1 : universe.length, maxSymbols: generic ? o.max ?? 12 : universe.length, meta: { name: 's', version: '3', universe, interval: o.interval ?? '1h', lookback: 10, params: {} } }; };
  it('a generic strategy fits any universe within its bounds; a fixed one needs the same symbols', () => {
    expect(strategies.isGeneric(['*'])).toBe(true);
    for (const u of [['*', 'ETH'], ['ETH'], ['*', '*'], []]) expect(strategies.isGeneric(u)).toBe(false);
    for (const u of [['ETH'], ['ETH', 'LINK', 'UNI'], TWELVE]) expect(strategies.fitsAgent(info(['*']), u, '1h')).toEqual({ ok: true });
    expect(strategies.fitsAgent(info(['*'], { min: 3 }), ['ETH', 'LINK'], '1h')).toMatchObject({ ok: false, code: 'universe_size' }); // cross-sectional momentum
    expect(strategies.fitsAgent(info(['*'], { min: 3 }), ['ETH', 'LINK', 'UNI'], '1h')).toEqual({ ok: true });
    expect(strategies.fitsAgent(info(['*'], { max: 4 }), TWELVE, '1h')).toMatchObject({ ok: false, code: 'universe_size' });
    expect(strategies.fitsAgent(info(['*']), ['ETH'], '1d')).toMatchObject({ ok: false, code: 'interval_mismatch' });
    expect(strategies.fitsAgent(info(['ETH', 'LINK', 'AAVE']), ['AAVE', 'ETH', 'LINK'], '1h')).toEqual({ ok: true });
    expect(strategies.fitsAgent(info(['ETH', 'LINK', 'AAVE']), ['ETH', 'LINK'], '1h')).toMatchObject({ ok: false, code: 'universe_mismatch' });
    expect(strategies.fitsAgent(info(['ETH', 'LINK', 'AAVE']), ['ETH', 'LINK', 'UNI'], '1h')).toMatchObject({ ok: false, code: 'universe_mismatch' });
  });
  it('backtests on one candle source: the first that lists every symbol', () => {
    expect(strategies.backtestSource(['ETH', 'LINK', 'UNI'])).toBe('coinbase');
    expect(strategies.backtestSource(['ETH', 'EUR'])).toBe('bitstamp'); // the euro is not on Coinbase
    expect(strategies.backtestSource(['ETH', 'EUR', 'USDS'])).toBe('kraken'); // USDS is not on Bitstamp
    expect(strategies.backtestSource(['ETH', 'NOPE'])).toBeNull();
  });
});

describe('market symbol set: derived from the registry, bounded, agents first', () => {
  const BASE = ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE', 'AVAX', 'BNB', 'DOGE', 'LTC', 'XRP'];
  it('is the base ten plus every symbol tradable on an execution-enabled network, cut at the limit', () => {
    const reg = symbols.registrySymbols(), set = symbols.configuredSymbols([], {});
    expect(reg).toEqual(expect.arrayContaining(['ETH', 'BTC', 'LINK', 'UNI', 'AAVE', 'POL', 'BNB', 'AVAX', 'HYPE', 'EUR']));
    expect(reg).not.toContain('USDC'); expect(reg).not.toContain('USDT'); // cash legs are never market symbols
    for (const s of ['USDC.e', 'USDT0', 'BTC.b', 'WETH.e', 'LINK.e', 'WBTC', 'cbBTC', 'WETH', 'wstETH']) expect(reg, s).not.toContain(s); // registry tickers are not market symbols: wrappers count as what they track, bridged variants as nothing
    // exactly what the registry says, most widely available first: a symbol is there when an asset of an execution-enabled network tracks it
    const count = (s: string) => MANDATE_NETWORKS.filter((id) => tradableSymbols(getNetwork(id)).some((t) => t.symbol === s)).length;
    expect(new Set(reg)).toEqual(new Set(MANDATE_NETWORKS.flatMap((id) => tradableSymbols(getNetwork(id)).map((t) => t.symbol))));
    for (let k = 1; k < reg.length; k++) expect(count(reg[k - 1]!) > count(reg[k]!) || (count(reg[k - 1]!) === count(reg[k]!) && reg[k - 1]! < reg[k]!), `${reg[k - 1]} before ${reg[k]}`).toBe(true);
    expect(reg).toContain('SOL'); expect(count('SOL')).toBe(1); // since registry v5: Binance-Peg SOL on BNB Smart Chain
    // the set: the base ten first, then the registry-derived symbols in that order, cut at the limit (default 40); the rest is reported
    const ordered = [...new Set([...BASE, ...reg])];
    expect(set.symbols.slice(0, 10)).toEqual(BASE);
    expect(set.symbols).toEqual(ordered.slice(0, 40)); expect(set.dropped).toEqual(ordered.slice(40));
    expect(set.symbols.length).toBeLessThanOrEqual(40); expect(set.first).toEqual([]);
    expect(symbols.configuredSymbols([], { SPW_MARKET_MAX_SYMBOLS: '12' }).symbols).toEqual(ordered.slice(0, 12));
    expect(symbols.configuredSymbols([], { SPW_MARKET_MAX_SYMBOLS: '500' })).toMatchObject({ symbols: ordered, dropped: [] });
    expect(set.fiveMinute).toEqual(BASE); // 5-minute bars stay on the base set
    // a fixed registry: the order and the cut do not depend on today's tokens
    const inj = symbols.configuredSymbols([], { SPW_MARKET_MAX_SYMBOLS: '13' }, ['UNI', 'BTC', 'NOPE', 'POL', 'HYPE', 'PEPE']);
    expect(inj.symbols).toEqual([...BASE, 'UNI', 'POL', 'HYPE']); expect(inj.dropped).toEqual(['PEPE']); // BTC once, NOPE has no market data
  });
  it('bounds the backfill load however large the registry grows; only symbols of agents go past the limit', () => {
    // an injected registry of more than 45 tradable symbols: still 40 series per interval, 10 on 5-minute bars
    const every = ['BTC', 'ETH', 'SOL', 'LINK', 'AAVE', 'AVAX', 'BNB', 'DOGE', 'LTC', 'XRP', 'UNI', 'POL', 'HYPE', 'LDO', 'ONDO', 'PEPE', 'SHIB', 'PAXG', 'ADA', 'DOT', 'ATOM', 'NEAR', 'ARB', 'OP', 'CRV', 'MKR', 'COMP', 'SNX', 'GRT', 'FIL', 'ICP', 'APT', 'SUI', 'SEI', 'TIA', 'INJ', 'RENDER', 'FET', 'ALGO', 'XLM', 'ETC', 'BCH', 'TRX', 'TON', 'ENA', 'JUP', 'WIF', 'BONK', 'PENDLE', 'EUR', 'USDS', 'MORPHO', 'CAKE', 'AERO', 'EIGEN'].filter((s) => hasMarketData(s));
    expect(every.length).toBeGreaterThan(45);
    const none = symbols.configuredSymbols([], {}, every);
    expect(none.symbols).toHaveLength(40); expect(none.symbols.slice(0, 10)).toEqual(BASE); expect(none.dropped).toHaveLength(every.length - 40);
    const agents = every.slice(-3), withAgents = symbols.configuredSymbols(agents, {}, every); // three symbols from the very end of the list
    expect(withAgents.symbols.slice(0, 3)).toEqual(agents); expect(withAgents.symbols.slice(3, 13)).toEqual(BASE); expect(withAgents.symbols).toHaveLength(40);
    expect(withAgents.dropped.some((s) => agents.includes(s))).toBe(false);
    // only agents can push it past the limit: 12 symbols of one agent with a limit of 5 → those 12, nothing else
    const twelve = every.slice(20, 32), tight = symbols.configuredSymbols(twelve, { SPW_MARKET_MAX_SYMBOLS: '5' }, every);
    expect(tight.symbols).toEqual(twelve); expect(tight.fiveMinute).toEqual(BASE.filter((s) => twelve.includes(s)));
    const cfg = { symbols: none.symbols, intervals: ['1h', '1d', '5m'] as const, only: { '5m': none.fiveMinute }, first: none.first, depthMs: { '1h': 1, '1d': null, '5m': 1 } };
    expect(pipeline.seriesOrder(cfg as never)).toHaveLength(40 + 40 + 10);
  });
  it('puts the symbols of agents first, never drops them, and honours the limit and the explicit list', () => {
    const many = Array.from({ length: 60 }, (_, k) => ['UNI', 'POL', 'HYPE', 'LDO', 'ONDO', 'PEPE', 'SHIB', 'PAXG'][k % 8]!);
    const set = symbols.configuredSymbols(['UNI', 'NOPE', 'PEPE'], { SPW_MARKET_MAX_SYMBOLS: '5' });
    expect(set.first).toEqual(['UNI', 'PEPE']); // a symbol without market data is ignored
    expect(set.symbols).toEqual(['UNI', 'PEPE', 'BTC', 'ETH', 'SOL']); expect(set.dropped).toContain('LINK');
    expect(symbols.configuredSymbols(['SHIB', 'LDO', 'ONDO'], { SPW_MARKET_MAX_SYMBOLS: '2' }).symbols).toEqual(['SHIB', 'LDO', 'ONDO']);
    expect(symbols.configuredSymbols(['UNI'], { SPW_MARKET_SYMBOLS: 'BTC, ETH,NOPE' }).symbols).toEqual(['UNI', 'BTC', 'ETH']);
    expect(symbols.configuredSymbols([], { SPW_MARKET_SYMBOLS: 'BTC,UNI', SPW_MARKET_5M_SYMBOLS: 'UNI,DOGE' }).fiveMinute).toEqual(['UNI']);
    expect(symbols.configuredSymbols(many, {}).first).toHaveLength(8);
    // injected registry: forty more tradable symbols do not push the set past the limit
    const big = symbols.configuredSymbols(['PEPE'], {}, ['ADA', 'DOT', 'ATOM', 'NEAR', 'ARB', 'OP', 'CRV', 'MKR', 'COMP', 'SNX', 'GRT', 'FIL', 'ICP', 'APT', 'SUI', 'SEI', 'TIA', 'INJ', 'RENDER', 'FET', 'ALGO', 'XLM', 'ETC', 'BCH', 'TRX', 'TON', 'ENA', 'JUP', 'WIF', 'BONK', 'PENDLE', 'LDO', 'ONDO', 'UNI', 'POL']);
    expect(big.symbols).toHaveLength(40); expect(big.symbols[0]).toBe('PEPE'); expect(big.dropped.length).toBeGreaterThan(0);
  });
  it('serves every interval of the agents\' symbols before the rest (update and backfill order)', () => {
    const order = pipeline.seriesOrder({ symbols: ['UNI', 'BTC', 'ETH'], intervals: ['1h', '1d', '5m'], only: { '5m': ['BTC'] }, first: ['UNI'], depthMs: { '1h': 1, '1d': null, '5m': 1 } });
    expect(order).toEqual([['1h', 'UNI'], ['1d', 'UNI'], ['1h', 'BTC'], ['1h', 'ETH'], ['1d', 'BTC'], ['1d', 'ETH'], ['5m', 'BTC']]);
  });
});

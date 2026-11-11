// V5, pure parts: agents on any execution-enabled network, universes of up to 12 market symbols, a cash leg, the gas
// reserve per network, mandates per network, universe-generic strategies, the registry-derived market symbol set.
import { beforeAll, describe, expect, it } from 'vitest';
import { cashLegs, DEFAULT_POLICY, getNetwork, MANDATE_NETWORKS, tradableSymbols, type AssetDef, type NetworkDef } from '@spw/core';
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
    expect(() => routes.agentAssets(agent({ network: 'arbitrum', universe: ['BTC'] }))).toThrow(/no asset of the wallet registry tracks BTC on Arbitrum One/);
    expect(() => routes.agentAssets(agent({ network: 'bsc', universe: ['BNB'] }))).toThrow(/no cash leg/);
    // the registry grows: the same call picks the new asset up
    const grown: NetworkDef = { ...getNetwork('arbitrum'), tokens: [...getNetwork('arbitrum').tokens, tok('cbBTC', 0xa1, 8), tok('ARB', 0xa2)] };
    expect(routes.agentAssets(agent({ network: 'arbitrum', universe: ['BTC', 'ARB'] }), grown).map((x) => x.assetSymbol)).toEqual(['USDC', 'cbBTC', 'ARB']);
    expect(tradableSymbols(grown).length).toBe(tradableSymbols(getNetwork('arbitrum')).length + 2);
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
      expect(m.maxOrder[cashLegs(n)[0]!.id], id).toBe('25000000'); expect(m.maxOrder.native, id).toBe('500000000000000000'); // 25 USD at 50 USD
      expect(m.maxSlippageBps).toBe(150); expect(m.expiresAt - m.createdAt).toBe(30 * 86400);
    }
    const eth = getNetwork('ethereum'), m = routes.mandateFor(agent({ network: 'ethereum', universe: ['BTC', 'ETH'] }), 'spw-0123456789abcdef', 'ab'.repeat(32), px, now);
    const wbtc = eth.tokens.find((t) => t.symbol === 'WBTC')!.id;
    expect(m.assets).toContain(wbtc); expect(m.maxOrder[wbtc]).toBe('41667'); // 25 USD of bitcoin, in WBTC's 8 decimals, at the BTC price
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
  it('is the base ten plus every symbol tradable on an execution-enabled network', () => {
    const reg = symbols.registrySymbols(), set = symbols.configuredSymbols([], {});
    expect(reg).toEqual(expect.arrayContaining(['ETH', 'BTC', 'LINK', 'UNI', 'AAVE', 'POL', 'BNB', 'AVAX', 'HYPE', 'EUR']));
    expect(reg).not.toContain('USDC'); expect(reg).not.toContain('SOL'); // cash leg; not on an EVM execution network
    expect(set.symbols.slice(0, 10)).toEqual(BASE);
    expect(new Set(set.symbols)).toEqual(new Set([...BASE, ...reg])); expect(set.dropped).toEqual([]);
    expect(set.fiveMinute).toEqual(BASE); // 5-minute bars stay on the base set
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

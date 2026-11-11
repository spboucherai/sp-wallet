import { describe, expect, it } from 'vitest';
import {
  ASSET_TRACKS, cashLegs, getNetwork, hasMarketData, hasSignerPrice, KYBER_ENABLED, MANDATE_NETWORKS, MARKET_LISTINGS, marketSymbolOf, MAX_AGENT_SYMBOLS, MandateSchema, priceSymbolOf,
  resolveAgentAssets, tradableSymbols, validateMandate, type AssetDef, type Mandate, type NetworkDef,
} from '../src/index.ts';

/** A network of the registry with extra assets injected: what the registry will look like once it grows. */
const grown = (id: string, extra: AssetDef[], drop: string[] = []): NetworkDef => { const n = getNetwork(id); return { ...n, tokens: [...n.tokens.filter((t) => !drop.includes(t.symbol)), ...extra] }; };
const tok = (symbol: string, k: number, name = symbol, decimals = 18): AssetDef => ({ id: `0x${k.toString(16).padStart(40, '0')}`, symbol, name, decimals });
const sym = (n: NetworkDef, s: string) => tradableSymbols(n).find((x) => x.symbol === s);

describe('static table of listings', () => {
  it('holds only tickers listed against USD on at least two exchanges, with well-formed pair names', () => {
    expect(Object.keys(MARKET_LISTINGS).length).toBeGreaterThan(100);
    for (const [s, l] of Object.entries(MARKET_LISTINGS)) {
      expect(s, s).toMatch(/^[A-Z0-9]{2,10}$/);
      expect([l.coinbase, l.bitstamp, l.kraken].filter(Boolean).length, s).toBeGreaterThanOrEqual(2);
      if (l.coinbase) expect(l.coinbase).toBe(`${s}-USD`);
      if (l.bitstamp) expect(l.bitstamp).toBe(`${s.toLowerCase()}usd`);
      if (l.kraken) expect(l.kraken).toMatch(/^[A-Z0-9]{4,14}$/);
    }
    expect(MARKET_LISTINGS.BTC).toEqual({ coinbase: 'BTC-USD', bitstamp: 'btcusd', kraken: 'XBTUSD' }); // Kraken's own names
    expect(MARKET_LISTINGS.DOGE!.kraken).toBe('XDGUSD');
    expect(hasMarketData('ETH') && hasSignerPrice('ETH')).toBe(true);
    expect(hasMarketData('EUR')).toBe(true); expect(hasSignerPrice('EUR')).toBe(false); // Bitstamp + Kraken: data, but no signer price
    for (const s of ['NOPE', 'constructor', '__proto__', 'toString', '']) expect(hasMarketData(s), s).toBe(false);
  });
  it('every reviewed wrapper tracks a symbol that has market data', () => {
    for (const [s, t] of Object.entries(ASSET_TRACKS)) { expect(hasMarketData(t.tracks), s).toBe(true); expect(t.issuer.length, s).toBeGreaterThan(5); }
    for (const yieldBearing of ['wstETH', 'cbETH', 'rETH', 'weETH', 'sUSDe', 'stETH']) expect(ASSET_TRACKS[yieldBearing], yieldBearing).toBeUndefined(); // not the same economic asset
  });
});

describe('registry asset → market symbol', () => {
  it('maps natives and tokens to themselves, wrappers to what they track, cash legs to nothing', () => {
    expect(marketSymbolOf({ id: 'native', symbol: 'ETH' })).toBe('ETH');
    expect(marketSymbolOf(tok('LINK', 1))).toBe('LINK');
    for (const [w, s] of [['WETH', 'ETH'], ['WBTC', 'BTC'], ['cbBTC', 'BTC'], ['tBTC', 'BTC'], ['BTCB', 'BTC'], ['cbXRP', 'XRP'], ['EURC', 'EUR']] as const) expect(marketSymbolOf(tok(w, 2)), w).toBe(s);
    expect(marketSymbolOf(tok('USDC', 3))).toBeNull(); expect(marketSymbolOf(tok('USDT', 4))).toBeNull();
    expect(marketSymbolOf(tok('wstETH', 5))).toBe('wstETH'); // its own symbol (no market data), never ETH
    expect(() => marketSymbolOf({ id: 'native', symbol: 'WETH' })).toThrow(/ambiguous/);
    expect(priceSymbolOf(tok('cbBTC', 6))).toEqual({ symbol: 'BTC', cash: false }); // the signer prices a wrapper as its underlying
    expect(priceSymbolOf(tok('USDC', 7))).toEqual({ symbol: 'USDC', cash: true });
  });

  it("today's registry: what each execution-enabled network can trade", () => {
    const eth = getNetwork('ethereum'), base = getNetwork('base');
    expect(sym(eth, 'ETH')!.representations.map((r) => [r.assetSymbol, r.kind])).toEqual([['ETH', 'native'], ['WETH', 'wrapped']]);
    expect(sym(eth, 'ETH')!.defaultId).toBe('native'); // rule 1: the native coin
    expect(sym(eth, 'BTC')!.representations.map((r) => r.assetSymbol)).toEqual(['WBTC']);
    expect(sym(eth, 'BTC')!.representations[0]!.issuer).toMatch(/BitGo/);
    expect(sym(base, 'LINK')!).toMatchObject({ live: true, defaultId: base.tokens.find((t) => t.symbol === 'LINK')!.id });
    expect(sym(base, 'EUR')!).toMatchObject({ live: false, sources: ['bitstamp', 'kraken'] }); // EURC, paper only
    expect(sym(base, 'EUR')!.representations[0]).toMatchObject({ assetSymbol: 'EURC', kind: 'pegged', issuer: expect.stringMatching(/Circle/) });
    for (const id of Object.keys(KYBER_ENABLED)) { const n = getNetwork(id), t = tradableSymbols(n);
      expect(t.some((x) => x.symbol === n.native.symbol), id).toBe(true); // every native coin of an execution network has market data
      for (const x of t) { expect(x.sources.length, `${id}:${x.symbol}`).toBeGreaterThanOrEqual(2); expect(['USDC', 'USDT']).not.toContain(x.symbol); } }
    expect(cashLegs(getNetwork('avalanche')).map((c) => c.symbol)).toEqual(['USDC', 'USDT']);
    expect(cashLegs(getNetwork('bsc'))).toEqual([]); // neither is in the registry on BNB Smart Chain today
  });

  it('picks up assets the registry does not hold yet, with no code change', () => {
    const base = getNetwork('base');
    expect(sym(base, 'BTC')).toBeUndefined(); expect(sym(base, 'XRP')).toBeUndefined(); expect(sym(base, 'UNI')).toBeUndefined();
    const n = grown('base', [tok('cbBTC', 0xb1, 'Coinbase Wrapped BTC', 8), tok('tBTC', 0xb2, 'Threshold BTC'), tok('WBTC', 0xb3, 'Wrapped Bitcoin', 8), tok('cbXRP', 0xb4, 'Coinbase Wrapped XRP', 6), tok('UNI', 0xb5, 'Uniswap'),
      tok('WETH', 0xb6, 'Wrapped Ether'), tok('wstETH', 0xb7, 'Wrapped staked ETH'), tok('NEWCOIN', 0xb8)]);
    expect(sym(n, 'BTC')!.representations.map((r) => r.assetSymbol)).toEqual(['WBTC', 'cbBTC', 'tBTC']); // reviewed rank order
    expect(sym(n, 'BTC')!.defaultId).toBe(tok('WBTC', 0xb3).id);
    expect(sym(n, 'XRP')!.representations[0]).toMatchObject({ assetSymbol: 'cbXRP', name: 'Coinbase Wrapped XRP', issuer: expect.stringMatching(/Coinbase/) });
    expect(sym(n, 'UNI')!.representations[0]!.kind).toBe('token');
    expect(sym(n, 'ETH')!.representations.map((r) => r.assetSymbol)).toEqual(['ETH', 'WETH']);
    expect(sym(n, 'wstETH')).toBeUndefined(); expect(sym(n, 'NEWCOIN')).toBeUndefined(); // no USD listing on two exchanges: no market data
    const r = resolveAgentAssets(n, ['BTC', 'XRP', 'UNI', 'ETH', 'LINK']);
    expect(r.assets.map((a) => [a.symbol, a.assetSymbol])).toEqual([['BTC', 'WBTC'], ['XRP', 'cbXRP'], ['UNI', 'UNI'], ['ETH', 'ETH'], ['LINK', 'LINK']]);
    expect(resolveAgentAssets(n, ['BTC', 'ETH'], { assets: { BTC: tok('cbBTC', 0xb1).id, ETH: tok('WETH', 0xb6).id } }).assets.map((a) => [a.assetSymbol, a.decimals, a.kind])).toEqual([['cbBTC', 8, 'wrapped'], ['WETH', 18, 'wrapped']]);
    // without WBTC the default falls to the next rank
    expect(sym(grown('base', [tok('cbBTC', 0xb1), tok('tBTC', 0xb2)]), 'BTC')!.defaultId).toBe(tok('cbBTC', 0xb1).id);
  });

  it('refuses every ambiguous or wrong choice', () => {
    const base = getNetwork('base');
    // two registry tokens with the same ticker: no default, the owner must choose
    const twin = grown('base', [tok('cbBTC', 0xc1), tok('cbBTC', 0xc2)]);
    expect(sym(twin, 'BTC')!.defaultId).toBeNull();
    expect(() => resolveAgentAssets(twin, ['BTC'])).toThrow(/several representations.*choose one/);
    expect(resolveAgentAssets(twin, ['BTC'], { assets: { BTC: tok('cbBTC', 0xc2).id } }).assets[0]!.id).toBe(tok('cbBTC', 0xc2).id);
    const link = base.tokens.find((t) => t.symbol === 'LINK')!.id;
    expect(() => resolveAgentAssets(base, ['ETH'], { assets: { ETH: link } })).toThrow(/does not track/); // LINK is not ETH
    expect(() => resolveAgentAssets(base, ['ETH'], { assets: { LINK: link } })).toThrow(/not in the universe/);
    expect(() => resolveAgentAssets(base, ['BTC'])).toThrow(/no asset of the wallet registry tracks BTC on Base/);
    expect(() => resolveAgentAssets(base, ['NOPE'])).toThrow(/no market data/);
    expect(() => resolveAgentAssets(base, ['ETH', 'ETH'])).toThrow(/duplicate/);
    expect(() => resolveAgentAssets(base, ['USDC'])).toThrow(/cash leg/);
    expect(() => resolveAgentAssets(base, [])).toThrow(/between 1 and 12/);
    expect(() => resolveAgentAssets(getNetwork('solana'), ['SOL'])).toThrow(/do not trade/);
    const many = grown('ethereum', []), all = tradableSymbols(many).map((t) => t.symbol);
    expect(all.length).toBeGreaterThan(MAX_AGENT_SYMBOLS);
    expect(resolveAgentAssets(many, all.slice(0, 12)).assets).toHaveLength(12);
    expect(() => resolveAgentAssets(many, all.slice(0, 13))).toThrow(/between 1 and 12/);
  });

  it('cash leg: USDC by default, USDT only by explicit choice, nothing else', () => {
    const avax = getNetwork('avalanche');
    expect(resolveAgentAssets(avax, ['AVAX']).cash).toMatchObject({ symbol: 'USDC', kind: 'cash' });
    expect(resolveAgentAssets(avax, ['AVAX'], { cash: 'USDT' }).cash).toMatchObject({ symbol: 'USDT', decimals: 6 });
    expect(() => resolveAgentAssets(getNetwork('base'), ['ETH'], { cash: 'USDT' })).toThrow(/USDT is not in the wallet registry on Base; choose USDC/);
    expect(() => resolveAgentAssets(getNetwork('base'), ['ETH'], { cash: 'USDS' })).toThrow(/cannot be a cash leg/);
    expect(() => resolveAgentAssets(getNetwork('bsc'), ['BNB'])).toThrow(/no cash leg/);
    const bsc = grown('bsc', [tok('USDT', 0xd1, 'Tether USD')]); // where USDC does not exist: the owner chooses USDT
    expect(() => resolveAgentAssets(bsc, ['BNB'])).toThrow(/choose USDT as the cash leg/);
    expect(resolveAgentAssets(bsc, ['BNB'], { cash: 'USDT' })).toMatchObject({ cash: { symbol: 'USDT', decimals: 18 }, assets: [{ symbol: 'BNB', id: 'native' }] });
  });
});

describe('mandates on every execution-enabled network', () => {
  const now = 1_800_000_000;
  const mandate = (network: string, o: Partial<Mandate> = {}): Mandate => { const n = getNetwork(network), cash = cashLegs(n)[0];
    const assets = ['native', ...(cash ? [cash.id] : [n.tokens[0]!.id])];
    return MandateSchema.parse({ v: 1, mandateId: '7a1c1f0e-8f5f-4b1e-9c56-000000000001', keyId: 'spw-0123456789abcdef', vaultIndex: 3, vault: '0x' + '11'.repeat(20), network, provider: 'kyberswap', assets,
      maxOrder: Object.fromEntries(assets.map((a) => [a, '1000'])), maxDaily: Object.fromEntries(assets.map((a) => [a, '5000'])), maxOrdersPerDay: 4, maxSlippageBps: 150, createdAt: now, expiresAt: now + 86400, strategySha256: 'ab'.repeat(32), label: 'x', ...o }); };
  it('are exactly the networks whose router was reviewed', () => {
    expect([...MANDATE_NETWORKS]).toEqual(['base', 'ethereum', 'arbitrum', 'polygon', 'optimism', 'bsc', 'avalanche', 'hyperevm']);
    expect([...MANDATE_NETWORKS]).toEqual(Object.keys(KYBER_ENABLED));
    for (const id of MANDATE_NETWORKS) expect(() => validateMandate(mandate(id), now), id).not.toThrow();
  });
  it('refuse any other network and any asset that is not of the mandate network', () => {
    for (const id of ['solana', 'bitcoin', 'tron']) expect(() => validateMandate({ ...mandate('base'), network: id }, now), id).toThrow();
    expect(() => validateMandate({ ...mandate('base'), network: 'nowhere' }, now)).toThrow(/unknown network/);
    const baseUsdc = cashLegs(getNetwork('base'))[0]!.id;
    for (const id of MANDATE_NETWORKS.filter((x) => x !== 'base')) // Base's USDC address is not an asset of any other network
      expect(() => validateMandate({ ...mandate(id), assets: ['native', baseUsdc], maxOrder: { native: '1' }, maxDaily: { native: '1' } }, now), id).toThrow(/not allowlisted/);
    expect(() => validateMandate({ ...mandate('arbitrum'), expiresAt: now + 91 * 86400 }, now)).toThrow(/90 days/); // limits unchanged
    expect(MandateSchema.safeParse({ ...mandate('base'), assets: Array.from({ length: 13 }, (_, k) => `a${k}`) }).success).toBe(false); // still 12 assets at most
  });
});

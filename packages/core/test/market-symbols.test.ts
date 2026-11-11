import { describe, expect, it } from 'vitest';
import {
  ASSET_TRACKS, cashLegs, getNetwork, hasMarketData, hasSignerPrice, KYBER_ENABLED, MANDATE_NETWORKS, MARKET_LISTINGS, marketSymbolOf, MAX_AGENT_SYMBOLS, MandateSchema, priceSymbolOf,
  resolveAgentAssets, tradableSymbols, validateMandate, type AssetDef, type Mandate, type NetworkDef,
} from '../src/index.ts';

/** A FIXED registry for one network: only the named tokens of today's registry, plus injected ones. The expectations built on it
 *  do not move when the real registry grows (which is how these tests broke once: they pinned "what Base does not hold yet"). */
const fixed = (id: string, keep: string[], extra: AssetDef[] = []): NetworkDef => { const n = getNetwork(id), tokens = keep.map((s) => { const t = n.tokens.find((x) => x.symbol === s); if (!t) throw new Error(`${s} is not on ${id}`); return t; }); return { ...n, tokens: [...tokens, ...extra] }; };
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
    // bitcoin on Ethereum: every reviewed wrapper the registry holds there, in reviewed rank order; WBTC (rank 1) is the default
    const btc = sym(eth, 'BTC')!;
    expect(btc.representations.map((r) => r.assetSymbol)).toEqual(eth.tokens.filter((t) => ASSET_TRACKS[t.symbol]?.tracks === 'BTC').sort((x, y) => ASSET_TRACKS[x.symbol]!.rank - ASSET_TRACKS[y.symbol]!.rank).map((t) => t.symbol));
    expect(btc.representations.map((r) => r.assetSymbol)).toEqual(expect.arrayContaining(['WBTC', 'cbBTC', 'tBTC'])); // registry v5
    expect(btc.representations[0]).toMatchObject({ assetSymbol: 'WBTC', kind: 'wrapped', issuer: expect.stringMatching(/BitGo/) });
    expect(btc.defaultId).toBe(eth.tokens.find((t) => t.symbol === 'WBTC')!.id);
    expect(btc.representations.find((r) => r.assetSymbol === 'cbBTC')).toMatchObject({ decimals: 8, issuer: expect.stringMatching(/Coinbase/) });
    expect(btc.representations.find((r) => r.assetSymbol === 'tBTC')).toMatchObject({ decimals: 18, issuer: expect.stringMatching(/Threshold/) }); // its own decimals, not WBTC's
    expect(sym(getNetwork('bsc'), 'BTC')!.representations.map((r) => r.assetSymbol)).toEqual(['WBTC', 'BTCB']);
    expect(sym(base, 'LINK')!).toMatchObject({ live: true, defaultId: base.tokens.find((t) => t.symbol === 'LINK')!.id });
    expect(sym(base, 'EUR')!).toMatchObject({ live: false, sources: ['bitstamp', 'kraken'] }); // EURC, paper only
    expect(sym(base, 'EUR')!.representations[0]).toMatchObject({ assetSymbol: 'EURC', kind: 'pegged', issuer: expect.stringMatching(/Circle/) });
    for (const id of Object.keys(KYBER_ENABLED)) { const n = getNetwork(id), t = tradableSymbols(n);
      expect(t.some((x) => x.symbol === n.native.symbol), id).toBe(true); // every native coin of an execution network has market data
      for (const x of t) { const at = `${id}:${x.symbol}`;
        expect(x.sources.length, at).toBeGreaterThanOrEqual(2); expect(['USDC', 'USDT']).not.toContain(x.symbol);
        // the default rule, restated: the native coin; else the token that is the symbol; else the lowest reviewed rank; a tie at the winning level → none
        const reps = x.representations, nat = reps.find((r) => r.kind === 'native'), own = reps.filter((r) => r.kind === 'token'), low = Math.min(...reps.map((r) => r.rank)), wrap = reps.filter((r) => r.rank === low);
        expect(x.defaultId, at).toBe(nat ? 'native' : own.length ? (own.length === 1 ? own[0]!.id : null) : wrap.length === 1 ? wrap[0]!.id : null);
        expect(x.defaultId, `${at}: today's registry never needs an explicit choice`).not.toBeNull();
        for (const r of reps) { expect(r.decimals, at).toBe([n.native, ...n.tokens].find((a) => a.id === r.id)!.decimals); // the registry's decimals for THAT network
          if (r.kind === 'wrapped' || r.kind === 'pegged') expect(r.issuer, `${at}:${r.assetSymbol}`).toBeTruthy(); else expect(r.assetSymbol, at).toBe(x.symbol); } } }
    expect(cashLegs(getNetwork('avalanche')).map((c) => c.symbol)).toEqual(['USDC', 'USDT']);
    // BNB Smart Chain since registry v5: Binance-Peg USDC and USDT, the only cash legs in 18 decimals
    expect(cashLegs(getNetwork('bsc')).map((c) => [c.symbol, c.decimals, /Binance-Peg/.test(c.name)])).toEqual([['USDC', 18, true], ['USDT', 18, true]]);
    for (const id of Object.keys(KYBER_ENABLED)) for (const c of cashLegs(getNetwork(id))) expect(c, id).toMatchObject({ id: getNetwork(id).tokens.find((t) => t.symbol === c.symbol)!.id, decimals: getNetwork(id).tokens.find((t) => t.symbol === c.symbol)!.decimals });
  });

  it('spells tickers exactly as the registry does, and never takes a bridged or re-issued variant for the asset itself', () => {
    const all = Object.keys(KYBER_ENABLED).flatMap((id) => getNetwork(id).tokens.map((t) => ({ id, t })));
    const tickers = new Set(all.map((x) => x.t.symbol));
    // a table key that differs from a registry ticker only by case (CBBTC for cbBTC) would silently never match; BTCB (Binance) and BTC.b (Avalanche Bridge) are two assets
    const fold = (x: string) => x.toLowerCase();
    for (const k of Object.keys(ASSET_TRACKS)) for (const s of tickers) if (fold(s) === fold(k)) expect(s, `ASSET_TRACKS.${k} against the registry ticker ${s}`).toBe(k);
    for (const k of ['cbBTC', 'tBTC', 'BTCB', 'WBTC', 'WETH', 'cbXRP', 'cbDOGE', 'cbADA', 'cbLTC', 'WBNB', 'WAVAX', 'WPOL', 'WHYPE', 'EURC']) { expect(tickers.has(k), k).toBe(true); expect(ASSET_TRACKS[k], k).toBeDefined(); }
    // bridged dollars are other assets from other issuers: never a cash leg, never priced as USDC / USDT, not tradable
    for (const s of ['USDC.e', 'USDT0']) { expect(tickers.has(s), s).toBe(true);
      expect(marketSymbolOf(tok(s, 9)), s).toBe(s); expect(priceSymbolOf(tok(s, 9)), s).toEqual({ symbol: s, cash: false }); expect(hasMarketData(s), s).toBe(false); expect(ASSET_TRACKS[s], s).toBeUndefined(); }
    for (const { id, t } of all.filter((x) => /^USD[CT]/.test(x.t.symbol) && !['USDC', 'USDT'].includes(x.t.symbol))) {
      expect(cashLegs(getNetwork(id)).some((c) => c.id === t.id), `${id}:${t.symbol}`).toBe(false);
      expect(tradableSymbols(getNetwork(id)).some((x) => x.representations.some((r) => r.id === t.id)), `${id}:${t.symbol}`).toBe(false);
    }
    const onlyBridged: NetworkDef = { ...getNetwork('arbitrum'), tokens: getNetwork('arbitrum').tokens.filter((t) => !['USDC', 'USDT'].includes(t.symbol)) }; // USDC.e and USDT0 remain
    expect(onlyBridged.tokens.map((t) => t.symbol)).toEqual(expect.arrayContaining(['USDC.e', 'USDT0']));
    expect(cashLegs(onlyBridged)).toEqual([]); expect(() => resolveAgentAssets(onlyBridged, ['ETH'])).toThrow(/no cash leg/);
    // bridge tickers with no reviewed entry (no issuer named in the table) are their own symbol: no USD listing, so not tradable —
    // and they do not ride on the underlying's price either
    for (const s of ['BTC.b', 'WETH.e', 'LINK.e']) { expect(tickers.has(s), s).toBe(true); expect(ASSET_TRACKS[s], s).toBeUndefined();
      expect(marketSymbolOf(tok(s, 9)), s).toBe(s); expect(hasMarketData(s), s).toBe(false); }
    const avax = getNetwork('avalanche');
    expect(sym(avax, 'BTC')!.representations.map((r) => r.assetSymbol)).not.toContain('BTC.b'); expect(sym(avax, 'ETH')).toBeUndefined(); expect(sym(avax, 'LINK')).toBeUndefined();
    // in general: a registry ticker that is not a plain exchange ticker is tradable only through a reviewed entry naming its issuer
    for (const { id, t } of all) { const rep = tradableSymbols(getNetwork(id)).flatMap((x) => x.representations).find((r) => r.id === t.id);
      if (rep && !/^[A-Z0-9]{2,10}$/.test(t.symbol)) { expect(ASSET_TRACKS[t.symbol], `${id}:${t.symbol}`).toBeDefined(); expect(rep.issuer, `${id}:${t.symbol}`).toBeTruthy(); } }
  });

  it('picks up assets the registry does not hold yet, with no code change', () => {
    const small = fixed('base', ['USDC', 'LINK']); // a fixed small registry: what Base held before these assets were added
    expect(sym(small, 'BTC')).toBeUndefined(); expect(sym(small, 'XRP')).toBeUndefined(); expect(sym(small, 'UNI')).toBeUndefined();
    const n = fixed('base', ['USDC', 'LINK'], [tok('cbBTC', 0xb1, 'Coinbase Wrapped BTC', 8), tok('tBTC', 0xb2, 'Threshold BTC'), tok('WBTC', 0xb3, 'Wrapped Bitcoin', 8), tok('cbXRP', 0xb4, 'Coinbase Wrapped XRP', 6), tok('UNI', 0xb5, 'Uniswap'),
      tok('WETH', 0xb6, 'Wrapped Ether'), tok('wstETH', 0xb7, 'Wrapped staked ETH'), tok('NEWCOIN', 0xb8), tok('BTC.b', 0xb9, 'Bitcoin (BTC.b)', 8), tok('USDC.e', 0xba, 'Bridged USDC', 6)]);
    expect(sym(n, 'BTC')!.representations.map((r) => r.assetSymbol)).toEqual(['WBTC', 'cbBTC', 'tBTC']); // reviewed rank order; BTC.b has no reviewed entry
    expect(sym(n, 'BTC')!.defaultId).toBe(tok('WBTC', 0xb3).id);
    expect(sym(n, 'XRP')!.representations[0]).toMatchObject({ assetSymbol: 'cbXRP', name: 'Coinbase Wrapped XRP', issuer: expect.stringMatching(/Coinbase/) });
    expect(sym(n, 'UNI')!.representations[0]!.kind).toBe('token');
    expect(sym(n, 'ETH')!.representations.map((r) => r.assetSymbol)).toEqual(['ETH', 'WETH']);
    expect(sym(n, 'wstETH')).toBeUndefined(); expect(sym(n, 'NEWCOIN')).toBeUndefined(); // no USD listing on two exchanges: no market data
    expect(tradableSymbols(n).map((t) => t.symbol)).toEqual(['BTC', 'ETH', 'LINK', 'UNI', 'XRP']); // nothing else: neither BTC.b nor USDC.e
    const r = resolveAgentAssets(n, ['BTC', 'XRP', 'UNI', 'ETH', 'LINK']);
    expect(r.assets.map((a) => [a.symbol, a.assetSymbol])).toEqual([['BTC', 'WBTC'], ['XRP', 'cbXRP'], ['UNI', 'UNI'], ['ETH', 'ETH'], ['LINK', 'LINK']]);
    expect(resolveAgentAssets(n, ['BTC', 'ETH'], { assets: { BTC: tok('cbBTC', 0xb1).id, ETH: tok('WETH', 0xb6).id } }).assets.map((a) => [a.assetSymbol, a.decimals, a.kind])).toEqual([['cbBTC', 8, 'wrapped'], ['WETH', 18, 'wrapped']]);
    // without WBTC the default falls to the next rank
    expect(sym(fixed('base', ['USDC'], [tok('cbBTC', 0xb1), tok('tBTC', 0xb2)]), 'BTC')!.defaultId).toBe(tok('cbBTC', 0xb1).id);
    expect(sym(fixed('base', ['USDC'], [tok('BTCB', 0xb1), tok('tBTC', 0xb2)]), 'BTC')!.defaultId).toBe(tok('tBTC', 0xb2).id);
    // a token that IS the symbol comes before any wrapper of it, whatever the wrapper's rank (rule 2)
    const own = fixed('polygon', ['USDC'], [tok('WETH', 0xb6), tok('ETH', 0xbb)]);
    expect(sym(own, 'ETH')!.representations.map((x) => [x.assetSymbol, x.kind])).toEqual([['ETH', 'token'], ['WETH', 'wrapped']]); expect(sym(own, 'ETH')!.defaultId).toBe(tok('ETH', 0xbb).id);
    // and the real registry of today resolves the same way with what it holds now
    const base = getNetwork('base');
    expect(resolveAgentAssets(base, ['BTC', 'XRP']).assets.map((a) => [a.symbol, a.assetSymbol, a.decimals])).toEqual([['BTC', 'WBTC', 8], ['XRP', 'cbXRP', 6]]);
    expect(resolveAgentAssets(base, ['BTC'], { assets: { BTC: base.tokens.find((t) => t.symbol === 'tBTC')!.id } }).assets[0]).toMatchObject({ assetSymbol: 'tBTC', decimals: 18 });
  });

  it('refuses every ambiguous or wrong choice', () => {
    const base = getNetwork('base'), bare = fixed('base', ['USDC', 'LINK']);
    // two registry tokens with the same ticker at the winning level: no default, the owner must choose
    const twin = fixed('base', ['USDC', 'LINK'], [tok('cbBTC', 0xc1), tok('cbBTC', 0xc2)]);
    expect(sym(twin, 'BTC')!.defaultId).toBeNull();
    expect(() => resolveAgentAssets(twin, ['BTC'])).toThrow(/several representations.*choose one/);
    expect(resolveAgentAssets(twin, ['BTC'], { assets: { BTC: tok('cbBTC', 0xc2).id } }).assets[0]!.id).toBe(tok('cbBTC', 0xc2).id);
    // the same twins below a single better-ranked wrapper: the tie is not at the winning level, the default stands
    const under = fixed('base', ['USDC', 'LINK'], [tok('cbBTC', 0xc1), tok('cbBTC', 0xc2), tok('WBTC', 0xc3, 'Wrapped Bitcoin', 8)]);
    expect(sym(under, 'BTC')!.defaultId).toBe(tok('WBTC', 0xc3).id);
    // two tokens that both ARE the symbol: no default either
    const two = fixed('base', ['USDC'], [tok('UNI', 0xc4), tok('UNI', 0xc5)]);
    expect(sym(two, 'UNI')!.defaultId).toBeNull(); expect(() => resolveAgentAssets(two, ['UNI'])).toThrow(/choose one/);
    const link = base.tokens.find((t) => t.symbol === 'LINK')!.id;
    expect(() => resolveAgentAssets(base, ['ETH'], { assets: { ETH: link } })).toThrow(/does not track/); // LINK is not ETH
    expect(() => resolveAgentAssets(base, ['ETH'], { assets: { LINK: link } })).toThrow(/not in the universe/);
    expect(() => resolveAgentAssets(bare, ['BTC'])).toThrow(/no asset of the wallet registry tracks BTC on Base/);
    // on the real registry: a symbol the exchanges list but that no asset of the network tracks
    const absent = Object.keys(MARKET_LISTINGS).filter((s) => hasMarketData(s) && !['USDC', 'USDT'].includes(s) && !sym(base, s));
    expect(absent.length).toBeGreaterThan(0);
    for (const s of absent.slice(0, 5)) expect(() => resolveAgentAssets(base, [s]), s).toThrow(new RegExp(`no asset of the wallet registry tracks ${s} on Base`));
    expect(() => resolveAgentAssets(base, ['NOPE'])).toThrow(/no market data/);
    expect(() => resolveAgentAssets(base, ['ETH', 'ETH'])).toThrow(/duplicate/);
    expect(() => resolveAgentAssets(base, ['USDC'])).toThrow(/cash leg/);
    expect(() => resolveAgentAssets(base, [])).toThrow(/between 1 and 12/);
    expect(() => resolveAgentAssets(getNetwork('solana'), ['SOL'])).toThrow(/do not trade/);
    const many = getNetwork('ethereum'), all = tradableSymbols(many).map((t) => t.symbol);
    expect(all.length).toBeGreaterThan(MAX_AGENT_SYMBOLS);
    expect(resolveAgentAssets(many, all.slice(0, 12)).assets).toHaveLength(12);
    expect(() => resolveAgentAssets(many, all.slice(0, 13))).toThrow(/between 1 and 12/);
  });

  it('cash leg: USDC by default, USDT only by explicit choice, nothing else', () => {
    const avax = getNetwork('avalanche');
    expect(resolveAgentAssets(avax, ['AVAX']).cash).toMatchObject({ symbol: 'USDC', kind: 'cash' });
    expect(resolveAgentAssets(avax, ['AVAX'], { cash: 'USDT' }).cash).toMatchObject({ symbol: 'USDT', decimals: 6 });
    // every execution-enabled network: USDC when the registry holds it there, in the registry's decimals for that network; USDT never by default
    for (const id of MANDATE_NETWORKS) { const n = getNetwork(id), legs = cashLegs(n), usdc = n.tokens.find((t) => t.symbol === 'USDC'), usdt = n.tokens.find((t) => t.symbol === 'USDT');
      if (usdc) expect(resolveAgentAssets(n, [n.native.symbol]).cash, id).toMatchObject({ symbol: 'USDC', id: usdc.id, decimals: usdc.decimals, name: usdc.name });
      else expect(() => resolveAgentAssets(n, [n.native.symbol]), id).toThrow(legs.length ? /choose USDT as the cash leg/ : /no cash leg/);
      if (usdt) expect(resolveAgentAssets(n, [n.native.symbol], { cash: 'USDT' }).cash, id).toMatchObject({ symbol: 'USDT', id: usdt.id, decimals: usdt.decimals });
      else expect(() => resolveAgentAssets(n, [n.native.symbol], { cash: 'USDT' }), id).toThrow(new RegExp(`USDT is not in the wallet registry on ${n.name}`)); }
    // BNB Smart Chain: Binance-Peg dollars in 18 decimals (everywhere else a cash leg has 6)
    expect(resolveAgentAssets(getNetwork('bsc'), ['BNB'])).toMatchObject({ cash: { symbol: 'USDC', decimals: 18, name: 'Binance-Peg USD Coin' }, assets: [{ symbol: 'BNB', id: 'native' }] });
    expect(resolveAgentAssets(getNetwork('bsc'), ['BNB'], { cash: 'USDT' }).cash).toMatchObject({ symbol: 'USDT', decimals: 18 });
    // fixed registries: a network holding USDC only, one holding USDT only, one holding neither
    const usdcOnly = fixed('base', ['USDC', 'LINK']);
    expect(() => resolveAgentAssets(usdcOnly, ['ETH'], { cash: 'USDT' })).toThrow(/USDT is not in the wallet registry on Base; choose USDC/);
    expect(() => resolveAgentAssets(getNetwork('base'), ['ETH'], { cash: 'USDS' })).toThrow(/cannot be a cash leg/);
    expect(() => resolveAgentAssets(getNetwork('base'), ['ETH'], { cash: 'USDC.e' })).toThrow(/cannot be a cash leg/);
    expect(() => resolveAgentAssets(fixed('bsc', []), ['BNB'])).toThrow(/no cash leg/);
    const bsc = fixed('bsc', [], [tok('USDT', 0xd1, 'Tether USD')]); // where USDC does not exist: the owner chooses USDT
    expect(() => resolveAgentAssets(bsc, ['BNB'])).toThrow(/choose USDT as the cash leg/);
    expect(resolveAgentAssets(bsc, ['BNB'], { cash: 'USDT' })).toMatchObject({ cash: { symbol: 'USDT', decimals: 18 }, assets: [{ symbol: 'BNB', id: 'native' }] });
    // two tokens answering to "USDC" on one network: neither is taken
    expect(cashLegs(fixed('base', ['USDC'], [tok('USDC', 0xd2, 'Another USDC', 6)]))).toEqual([]);
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

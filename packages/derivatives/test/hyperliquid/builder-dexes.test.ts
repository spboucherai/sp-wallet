// Hyperliquid builder-deployed (HIP-3) perp dexes, read side — against REAL answers of the public info endpoint recorded on
// 2026-11-16 (00:42–00:44 UTC) by fixtures/hyperliquid/record-builder-dexes.mts. No network.
import { describe, expect, it } from 'vitest';
import { BookSchema, CandleSchema, InstrumentSchema, TickerSchema, VenueError } from '../../src/index.ts';
import { HL_BUILDER_NOT_TRADABLE, createHyperliquidAdapter, hlBuilderAssetId, hlBuilderCoin, hlNormalizeCategory } from '../../src/venues/hyperliquid/index.ts';
import { fx, replay, type Route } from './helpers.ts';

const B = (n: string) => fx(`builder-${n}`);
const RECORDED = Date.parse(B('perpDexs').recordedAt);
const ANNOT = B('perpAnnotation').body as Record<string, { attempts: unknown[] }>;

function make(extra: Record<string, Route> = {}) {
  const r = replay({
    meta: { body: fx('mainnet-meta').body }, metaAndAssetCtxs: (b) => b.dex === undefined ? { body: fx('mainnet-metaAndAssetCtxs').body } : ['xyz', 'io', 'para', 'vntl'].includes(b.dex) ? { body: B(`metaAndAssetCtxs-${b.dex}`).body } : { status: 500, body: 'no fixture' },
    perpDexs: { body: B('perpDexs').body }, perpCategories: { body: B('perpCategories').body }, allPerpMetas: { body: B('allPerpMetas').body },
    perpAnnotation: (b) => ({ body: ANNOT[b.coin]?.attempts.at(-1) ?? null }),
    l2Book: (b) => ({ body: B(`l2Book-${String(b.coin).replace(':', '-')}`).body }),
    candleSnapshot: (b) => ({ body: B(`candleSnapshot-${String(b.req.coin).replace(':', '-')}-${b.req.interval}`).body }),
    ...extra,
  });
  let t = RECORDED;
  const sleeps: number[] = [];
  const adapter = createHyperliquidAdapter({ network: 'mainnet', fetch: r.fetchImpl, now: () => t, sleep: async (ms) => { sleeps.push(ms); } });
  return { adapter, b: adapter.builder, calls: r.calls, sleeps, advance: (ms: number) => { t += ms; } };
}
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'no error'; } catch (e) { return e instanceof VenueError ? e.code : `not a VenueError: ${e}`; } };

describe('hyperliquid builder dexes — discovery (fixtures of 2026-11-16)', () => {
  it('the fixtures are the capture of 2026-11-16', () => { expect(B('perpDexs').recordedAt.slice(0, 10)).toBe('2026-11-16'); expect(B('perpDexs').request).toEqual({ type: 'perpDexs' }); });

  it('perpDexs: the main dex (null) is skipped, indices are the positions in the array', async () => {
    const { b, calls } = make(), list = await b.dexes();
    expect(calls[0]!.body).toEqual({ type: 'perpDexs' });
    expect(list.map((d) => `${d.index}:${d.name}`)).toEqual(['1:xyz', '2:flx', '3:vntl', '4:hyna', '5:km', '6:abcd', '7:cash', '8:para', '9:mkts', '10:io']);
    const io = list.find((d) => d.name === 'io')!;
    expect(io).toMatchObject({ fullName: 'EntropyIO', deployer: '0x320c8988e3d1b5198f335802d7bfd2728a8fcac6' });
    expect(io.oiCapUsd['io:ANTH']).toBe('275000000'); expect(io.fundingMultiplier['io:ANTH']).toBe('0.125');
    expect(list.find((d) => d.name === 'xyz')!.fundingMultiplier['xyz:ANT']).toBe('0.005');
    await b.dexes();
    expect(calls.filter((c) => c.body.type === 'perpDexs').length).toBe(1);          // cached
  });
  it('perpDexs whose first element is not null is a bad answer', async () => {
    expect(await code(make({ perpDexs: { body: (B('perpDexs').body as unknown[]).slice(1) } }).b.dexes())).toBe('bad_answer');
  });

  it('perpCategories: deployer spellings are normalised; the pre-IPO coins of the day', async () => {
    const cats = await make().b.categories();
    const pre = [...cats].filter(([, c]) => c.category === 'preipo').map(([coin]) => coin).sort();
    expect(pre).toEqual(['io:ANTH', 'io:OAI', 'para:ANTH', 'vntl:ANTHROPIC', 'vntl:OPENAI', 'vntl:SPACEX', 'xyz:ANT', 'xyz:OURA']);
    expect(cats.get('xyz:SPCX')).toEqual({ category: 'stocks', raw: 'stocks' });       // SpaceX is a listed stock today
    const raws = new Set([...cats.values()].map((c) => c.raw));
    expect(raws.has('FX') && raws.has('fx') && raws.has('stock') && raws.has('stocks')).toBe(true);
    expect(new Set([...cats.values()].map((c) => c.category)).has('other')).toBe(false);
    expect(hlNormalizeCategory('FX')).toBe('fx'); expect(hlNormalizeCategory('stock')).toBe('stocks'); expect(hlNormalizeCategory('memes')).toBe('other');
  });

  it('asset id = 100000 + dex index × 10000 + index in meta, from live data', async () => {
    expect(hlBuilderAssetId(1, 138)).toBe(110138);
    expect(() => hlBuilderAssetId(0, 1)).toThrow(); expect(() => hlBuilderAssetId(1, 10_000)).toThrow();
    const { b } = make(), xyz = await b.markets('xyz'), io = await b.markets('io'), para = await b.markets('para'), vntl = await b.markets('vntl');
    const id = (list: typeof xyz, coin: string) => list.find((m) => m.coin === coin)!.assetId;
    expect(id(xyz, 'xyz:ANT')).toBe(110138); expect(id(xyz, 'xyz:OURA')).toBe(110123);
    expect(id(io, 'io:ANTH')).toBe(200001); expect(id(io, 'io:OAI')).toBe(200000); expect(id(para, 'para:ANTH')).toBe(180031);
    expect(id(vntl, 'vntl:SPACEX')).toBe(130000); expect(id(vntl, 'vntl:ANTHROPIC')).toBe(130002);
    // one allPerpMetas call gives the same ids for every dex
    const all = await b.assetIds();
    for (const m of [...xyz, ...io, ...para, ...vntl]) expect(all.get(m.coin)).toEqual({ assetId: m.assetId, dex: m.dex, isDelisted: m.isDelisted, szDecimals: m.szDecimals });
    expect(all.has('BTC')).toBe(false);                                                 // main-dex coins are not builder assets
  });
});

describe('hyperliquid builder dexes — instruments and tickers', () => {
  it('xyz:ANT: full coin symbol, cross allowed, 10x, szDecimals 2, USDC, ticker fields from the recorded context', async () => {
    const { b, calls } = make(), m = (await b.markets('xyz')).find((x) => x.coin === 'xyz:ANT')!;
    expect(calls.at(-1)!.body).toEqual({ type: 'metaAndAssetCtxs', dex: 'xyz' });
    InstrumentSchema.parse(m.instrument); TickerSchema.parse(m.ticker);
    expect(m).toMatchObject({ dex: 'xyz', dexIndex: 1, coin: 'xyz:ANT', szDecimals: 2, maxLeverage: 10, isDelisted: false, onlyIsolated: false, marginMode: null, margin: 'cross_allowed', collateral: 'USDC',
      oiCapUsd: '150000000', fundingMultiplier: '0.005', tradable: false });
    expect(m.notTradable).toBe(HL_BUILDER_NOT_TRADABLE);
    expect(m.instrument).toMatchObject({ id: 'hyperliquid:xyz:ANT', symbol: 'xyz:ANT', base: 'ANT', quote: 'USD', lotSize: '0.01', maxLeverage: '10', marginModes: ['cross', 'isolated'], status: 'active', fundingIntervalSec: 3600 });
    expect(m.instrument.markPriceMethod).toMatch(/deployer/);
    expect(m.ticker).toMatchObject({ instrument: 'hyperliquid:xyz:ANT', mark: '102.27', index: '102', mid: '102.285', funding: '0.0000000625', ts: RECORDED });
    expect(m.ticker.openInterest).toBe('1088440.8199999982'); expect(m.ticker.volume24h).toBe('8681326.6791999917'); expect(m.volumeBase24h).toBe('85422.3199999997');
  });
  it('margin restrictions: noCross (xyz:OURA) and strictIsolated (para:ANTH) are isolated only', async () => {
    const { b } = make();
    const oura = (await b.markets('xyz')).find((x) => x.coin === 'xyz:OURA')!, anth = (await b.markets('para')).find((x) => x.coin === 'para:ANTH')!;
    expect(oura).toMatchObject({ onlyIsolated: true, marginMode: 'noCross', margin: 'no_cross', maxLeverage: 5, szDecimals: 1 }); expect(oura.instrument.marginModes).toEqual(['isolated']);
    expect(anth).toMatchObject({ onlyIsolated: true, marginMode: 'strictIsolated', margin: 'strict_isolated', maxLeverage: 10, szDecimals: 3, fundingMultiplier: '0.006' }); expect(anth.instrument.marginModes).toEqual(['isolated']);
  });
  it('io:ANTH and io:OAI: valuation-level prices, cross allowed', async () => {
    const io = await make().b.markets('io'), anth = io.find((x) => x.coin === 'io:ANTH')!, oai = io.find((x) => x.coin === 'io:OAI')!;
    expect(anth).toMatchObject({ maxLeverage: 15, szDecimals: 3, margin: 'cross_allowed', oiCapUsd: '275000000' }); expect(anth.ticker).toMatchObject({ mark: '1776.6', index: '1776.5' });
    expect(oai).toMatchObject({ maxLeverage: 6, margin: 'cross_allowed', oiCapUsd: '12000000' }); expect(oai.ticker).toMatchObject({ mark: '1313.9', index: '1311.7' });
  });
  it('a delisted Ventuals market is flagged, halted, with frozen prices and no activity', async () => {
    const vntl = await make().b.markets('vntl');
    expect(vntl.every((m) => m.isDelisted)).toBe(true);
    const a = vntl.find((m) => m.coin === 'vntl:ANTHROPIC')!;
    expect(a).toMatchObject({ isDelisted: true, margin: 'strict_isolated', collateral: 'USDH' }); expect(a.instrument.status).toBe('halted');
    expect(a.ticker).toMatchObject({ mark: '1619.3', index: '1618.9', mid: null, funding: '0', openInterest: '0', volume24h: '0' });
  });
  it('the main dex is untouched: instruments() and tickers() list no builder coin, and the asset table is the main one', async () => {
    const { adapter, calls } = make();
    const inst = await adapter.instruments(), tick = await adapter.tickers(), assets = await adapter.assets();
    expect(inst.some((i) => i.symbol.includes(':'))).toBe(false); expect(tick.some((t) => /hyperliquid:[a-z]+:/.test(t.instrument))).toBe(false);
    expect(assets.some((a) => a.symbol.includes(':'))).toBe(false);
    expect(calls.every((c) => !('dex' in c.body))).toBe(true);
    expect(await code(adapter.book('xyz:ANT'))).toBe('unsupported');                    // the VenueAdapter path does not know builder coins
    expect(adapter.trading).toBeUndefined();
    expect(adapter.capabilities.notes.some((n) => n.includes('builder_dex_read_only'))).toBe(true);
    expect(calls.every((c) => c.url.endsWith('/info'))).toBe(true);
  });
  it('unknown dex, a main-dex coin and a coin of another dex are refused; a short answer is a bad answer', async () => {
    const { b } = make();
    expect(await code(b.markets('nope'))).toBe('unsupported');
    expect(() => hlBuilderCoin('BTC')).toThrow(VenueError); expect(hlBuilderCoin('xyz:ANT')).toEqual({ dex: 'xyz', name: 'ANT' });
    const [meta, ctxs] = B('metaAndAssetCtxs-io').body as [unknown, unknown[]];
    expect(await code(make({ metaAndAssetCtxs: { body: [meta, ctxs.slice(1)] } }).b.markets('io'))).toBe('bad_answer');
    expect(await code(make({ metaAndAssetCtxs: { body: B('metaAndAssetCtxs-xyz').body } }).b.markets('io'))).toBe('bad_answer');
  });
});

describe('hyperliquid builder dexes — annotation (null under load is "unknown, retry")', () => {
  it('reads the deployer\'s description; an empty description stays empty (io:ANTH)', async () => {
    const { b } = make();
    const ant = await b.annotation('xyz:ANT'), io = await b.annotation('io:ANTH');
    expect(ant).toMatchObject({ coin: 'xyz:ANT', attempts: 1 }); expect(ant.annotation).toMatchObject({ category: 'preipo', displayName: 'ANT' });
    expect(ant.annotation!.description).toMatch(/^ANT references 1 share of Anthropic, PBC Class A common stock/);
    expect(io.annotation).toMatchObject({ category: 'preipo', description: '', displayName: 'ANT', keywords: ['anthropic'] });
    expect((await b.annotation('vntl:OPENAI')).annotation).toMatchObject({ displayName: null }); // no displayName on-chain
  });
  it('null then the value: retried with a pause, the value is returned', async () => {
    // the real null body of the endpoint (recorded for io:MOONSHOT), then the real recorded annotation of xyz:ANT
    const nullBody = ANNOT['io:MOONSHOT']!.attempts[0], value = ANNOT['xyz:ANT']!.attempts[0];
    expect(nullBody).toBeNull();
    let n = 0;
    const { b, calls, sleeps } = make({ perpAnnotation: () => ({ body: ++n <= 2 ? nullBody : value }) });
    const r = await b.annotation('xyz:ANT');
    expect(r.attempts).toBe(3); expect(r.annotation!.description).toMatch(/Anthropic/);
    expect(calls.filter((c) => c.body.type === 'perpAnnotation').length).toBe(3); expect(sleeps).toEqual([250, 500]);
  });
  it('null on every attempt: reported as unknown, never as "no annotation"', async () => {
    const { b, calls } = make();
    const r = await b.annotation('io:MOONSHOT');
    expect(r).toEqual({ coin: 'io:MOONSHOT', annotation: null, attempts: 4 });
    expect(calls.length).toBe(4);
    expect((await b.annotation('io:MOONSHOT', { retries: 0 })).attempts).toBe(1);
  });
});

describe('hyperliquid builder dexes — book and candles', () => {
  it('book of xyz:ANT with the full coin name; depth applies', async () => {
    const { b, calls } = make(), book = await b.book('xyz:ANT', 5);
    expect(calls.at(-1)!.body).toEqual({ type: 'l2Book', coin: 'xyz:ANT' });
    BookSchema.parse(book);
    expect(book.instrument).toBe('hyperliquid:xyz:ANT'); expect(book.bids.length).toBe(5); expect(book.asks.length).toBe(5);
    expect(Number(book.bids[0]![0])).toBeLessThan(Number(book.asks[0]![0]));
  });
  it('a delisted market has an empty book', async () => {
    const book = await make().b.book('vntl:ANTHROPIC');
    expect(book.bids).toEqual([]); expect(book.asks).toEqual([]);
  });
  it('candles of io:ANTH (1h) and the last daily candle of a delisted market (2026-06-15)', async () => {
    const { b, calls } = make(), c = await b.candles('io:ANTH', '1h', { limit: 24 });
    expect(calls.at(-1)!.body.req).toMatchObject({ coin: 'io:ANTH', interval: '1h' });
    expect(c.length).toBe(24); for (const x of c) CandleSchema.parse(x);
    expect(c.every((x, i) => i === 0 || x.ts > c[i - 1]!.ts)).toBe(true);
    const d = await b.candles('vntl:ANTHROPIC', '1d', { limit: 500 });
    expect(new Date(d.at(-1)!.ts).toISOString().slice(0, 10)).toBe('2026-06-15'); expect(d.at(-1)!.close).toBe('1619.3');
  });
  it('an unknown coin is refused before any book or candle request; an answer for another coin is a bad answer', async () => {
    const { b, calls } = make();
    expect(await code(b.book('xyz:NOPE'))).toBe('unsupported'); expect(await code(b.candles('io:NOPE', '1h', {}))).toBe('unsupported'); expect(await code(b.book('BTC'))).toBe('unsupported');
    expect(calls.some((c) => c.body.type === 'l2Book' || c.body.type === 'candleSnapshot')).toBe(false);
    expect(await code(make({ l2Book: { body: B('l2Book-io-ANTH').body } }).b.book('xyz:ANT'))).toBe('bad_answer');
  });
});

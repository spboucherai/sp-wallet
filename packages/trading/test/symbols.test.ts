// Symbol normalisation on the REAL instrument lists of the four venues, recorded read-only on 2026-11-15 through the wallet's
// own adapters (scripts/record-markets-hub-fixtures.mts → services/api/test/fixtures/markets-hub/).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D, type Book, type Instrument, type Ticker } from '@spw/derivatives';
import {
  groupByUnderlying, looksLikeMultiplier, normaliseSymbols, priceOutliers, REVIEWED_OVERRIDES, REVIEWED_TICKERS, toUnderlyingUnits, unitPrice, venueCost, crossVenueDiscrepancy,
  type CostRequest, type SymbolMapping,
} from '../src/index.ts';

interface Recorded { venue: string; recordedAt: number; instruments: Instrument[]; tickers: Ticker[]; books: Record<string, Book> }
const load = (v: string): Recorded => JSON.parse(readFileSync(new URL(`../../../services/api/test/fixtures/markets-hub/${v}.json`, import.meta.url), 'utf8'));
const venues = ['hyperliquid', 'gmx', 'dydx', 'edgex'].map(load);
const instruments = venues.flatMap((v) => v.instruments);
const tickers = new Map(venues.flatMap((v) => v.tickers).map((t) => [t.instrument, t]));
const maps = normaliseSymbols(instruments);
const of = (id: string): SymbolMapping => { const m = maps.find((x) => x.instrument === id); if (!m) throw new Error(`${id} is not in the recorded lists`); return m; };
const within = (a: string, b: string, pct: number): boolean => Math.abs(Number(a) / Number(b) - 1) <= pct / 100;

describe('symbol normalisation — recorded instrument lists of the four venues', () => {
  it('the recorded lists are the real ones', () => {
    expect(venues.map((v) => [v.venue, v.instruments.length])).toEqual([['hyperliquid', 235], ['gmx', 124], ['dydx', 296], ['edgex', 157]]);
    expect(maps).toHaveLength(instruments.length);
  });

  it('BTC and ETH: the four spellings map to one underlying, multiplier 1', () => {
    for (const id of ['hyperliquid:BTC', 'dydx:BTC-USD', 'gmx:BTC/USD [BTC-USDC]', 'edgex:BTCUSDC']) expect(of(id)).toMatchObject({ underlying: 'BTC', category: 'crypto', multiplier: '1', unmapped: null });
    for (const id of ['hyperliquid:ETH', 'dydx:ETH-USD', 'gmx:ETH/USD [WETH-USDC]', 'edgex:ETHUSDC']) expect(of(id)).toMatchObject({ underlying: 'ETH', multiplier: '1' });
    expect(of('hyperliquid:BTC').rule).toBe('venue_metadata'); expect(of('edgex:BTCUSDC').rule).toBe('venue_metadata');
    expect(of('gmx:BTC/USD [BTC-USDC]').rule).toBe('reviewed_ticker'); expect(of('dydx:BTC-USD').rule).toBe('reviewed_ticker');
    // GMX lists one instrument per pool: several instruments of one venue share the underlying
    const btc = groupByUnderlying(maps).get('BTC')!;
    expect(btc.filter((m) => m.venue === 'gmx').length).toBeGreaterThan(1);
    expect(new Set(btc.map((m) => m.venue))).toEqual(new Set(['hyperliquid', 'gmx', 'dydx', 'edgex']));
  });

  it('a 1000-multiplier contract is never merged with the plain asset by its name: only a reviewed row maps it, with its multiplier', () => {
    expect(of('hyperliquid:kPEPE')).toMatchObject({ underlying: 'PEPE', multiplier: '1000', rule: 'reviewed_override' });
    expect(of('edgex:1000PEPEUSDC')).toMatchObject({ underlying: 'PEPE', multiplier: '1000', rule: 'reviewed_override' });
    expect(of('dydx:PEPE-USD')).toMatchObject({ underlying: 'PEPE', multiplier: '1', rule: 'reviewed_override' });
    // GMX spells the market kPEPE but prices it per 1 PEPE: the same NAME as Hyperliquid's contract, a different unit
    expect(of('gmx:kPEPE/USD [WETH-USDC]')).toMatchObject({ underlying: 'PEPE', multiplier: '1', rule: 'reviewed_override' });
    expect(Number(tickers.get('hyperliquid:kPEPE')!.mark) / Number(tickers.get('gmx:kPEPE/USD [WETH-USDC]')!.mark)).toBeGreaterThan(900);
    // multiplier names nobody reviewed stay unmapped — on every venue
    for (const id of ['hyperliquid:kLUNC', 'hyperliquid:kNEIRO', 'hyperliquid:kDOGS', 'edgex:1000RATSUSDC', 'edgex:1000AKEUSDC']) expect(of(id)).toMatchObject({ underlying: null, multiplier: null, unmapped: 'multiplier_unreviewed' });
    for (const b of ['kPEPE', '1000PEPE', '1MBABYDOGE']) expect(looksLikeMultiplier(b)).toBe(true);
    for (const b of ['KAS', 'KAITO', 'PEPE', '1INCH', 'K']) expect(looksLikeMultiplier(b)).toBe(false);
    // no mapped instrument keeps a multiplier-looking underlying
    expect(maps.filter((m) => m.underlying !== null && looksLikeMultiplier(m.underlying))).toEqual([]);
  });

  it('every reviewed multiplier row agrees with the recorded prices: unit price = mark / multiplier, within 1 % across venues', () => {
    const groups = groupByUnderlying(maps);
    const reviewed = new Set(Object.values(REVIEWED_OVERRIDES).map((o) => o.underlying));
    expect([...reviewed].sort()).toEqual(['BONK', 'FLOKI', 'PEPE', 'SHIB']);
    for (const u of reviewed) {
      const active = groups.get(u)!.filter((m) => instruments.find((i) => i.id === m.instrument)!.status === 'active');
      expect(active.length, u).toBeGreaterThan(1);
      const unit = active.map((m) => unitPrice(tickers.get(m.instrument)!.mark, m.multiplier!));
      for (const p of unit) expect(within(p, unit[0]!, 1), `${u}: ${unit.join(' / ')}`).toBe(true);
      expect(priceOutliers(active.map((m, k) => ({ instrument: m.instrument, unitPrice: unit[k]! }))).size).toBe(0);
    }
    // without the multiplier the same instruments are three orders of magnitude apart — the guard would flag them
    const pepe = groups.get('PEPE')!.filter((m) => instruments.find((i) => i.id === m.instrument)!.status === 'active');
    expect(priceOutliers(pepe.map((m) => ({ instrument: m.instrument, unitPrice: tickers.get(m.instrument)!.mark }))).size).toBeGreaterThan(0);
  });

  it('every reviewed GMX / dYdX ticker is active there and priced within 1 % of the same crypto ticker on Hyperliquid or edgeX', () => {
    const anchor = (t: string): string | undefined => tickers.get(`hyperliquid:${t}`)?.mark ?? tickers.get(`edgex:${t}USDC`)?.mark;
    for (const v of ['gmx', 'dydx'] as const) {
      const active = instruments.filter((i) => i.venue === v && i.status === 'active');
      for (const t of REVIEWED_TICKERS[v]) {
        const mine = active.filter((i) => i.base === t);
        expect(mine.length, `${v} ${t}`).toBeGreaterThan(0);
        const a = anchor(t);
        expect(a, `${v} ${t} has no anchor`).toBeDefined();
        for (const i of mine) expect(within(tickers.get(i.id)!.mark, a!, 1), `${i.id} ${tickers.get(i.id)!.mark} vs ${a}`).toBe(true);
      }
      // and nothing else of that venue is mapped by its ticker alone
      expect(maps.filter((m) => m.venue === v && m.rule === 'reviewed_ticker').every((m) => REVIEWED_TICKERS[v].includes(m.underlying!))).toBe(true);
    }
  });

  it('the same letters for two asset classes are not merged: edgeX equities and commodities vs GMX / dYdX tickers without a category', () => {
    expect(of('edgex:SPYUSDC')).toMatchObject({ underlying: 'SPY', category: 'equity', rule: 'venue_metadata' });
    expect(of('edgex:ANTHROPICUSDC')).toMatchObject({ underlying: 'ANTHROPIC', category: 'pre_ipo' });
    expect(of('edgex:XAUUSDC')).toMatchObject({ category: 'commodity' }); expect(of('edgex:USDJPYUSDC')).toMatchObject({ category: 'fx' });
    for (const id of ['gmx:SPY/USD [WETH-USDC]', 'gmx:QQQ/USD [WETH-USDC]', 'gmx:NATGAS/USD [WETH-USDC]'].filter((x) => instruments.some((i) => i.id === x))) expect(of(id)).toMatchObject({ underlying: null, unmapped: 'no_category_metadata' });
    const gmxSpy = maps.filter((m) => m.venue === 'gmx' && instruments.find((i) => i.id === m.instrument)!.base === 'SPY');
    expect(gmxSpy.length).toBeGreaterThan(0);
    for (const m of gmxSpy) expect(m).toMatchObject({ underlying: null, unmapped: 'no_category_metadata' });
    // an underlying never has two categories
    for (const [u, g] of groupByUnderlying(maps)) expect(new Set(g.map((m) => m.category)).size, u).toBe(1);
    // an equity ticker that is ALSO a crypto ticker on a venue that maps by metadata is refused (synthetic case: none in the recorded lists)
    const clash = normaliseSymbols([{ venue: 'hyperliquid', symbol: 'NET', id: 'hyperliquid:NET', base: 'NET' }, { venue: 'edgex', symbol: 'NETUSDC', id: 'edgex:NETUSDC', base: 'NET', category: 'equity' }]);
    expect(clash[0]).toMatchObject({ underlying: 'NET', category: 'crypto' }); expect(clash[1]).toMatchObject({ underlying: null, unmapped: 'ticker_in_two_asset_classes' });
  });

  it('what cannot be mapped with certainty stays unmapped, with the reason', () => {
    expect(of('gmx:GOLD/USD [WETH-USDC]')).toMatchObject({ underlying: null, unmapped: 'ticker_not_reviewed' });
    const odd = instruments.find((i) => i.venue === 'dydx' && i.base.includes(','))!;
    expect(of(odd.id)).toMatchObject({ underlying: null, unmapped: 'bad_ticker' });
    expect(normaliseSymbols([{ venue: 'hyperliquid', symbol: 'xyz:NVDA', id: 'hyperliquid:xyz:NVDA', base: 'NVDA' }])[0]).toMatchObject({ underlying: null, unmapped: 'builder_dex_unreviewed' });
    expect(normaliseSymbols([{ venue: 'edgex', symbol: 'NEWUSDC', id: 'edgex:NEWUSDC', base: 'NEW' }])[0]).toMatchObject({ underlying: null, unmapped: 'no_category_metadata' });
    const counts = maps.reduce<Record<string, number>>((m, x) => { const k = x.unmapped ?? 'mapped'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
    expect(counts.mapped).toBeGreaterThan(450);
    expect(Object.keys(counts).sort()).toEqual(['bad_ticker', 'mapped', 'multiplier_unreviewed', 'no_category_metadata', 'ticker_not_reviewed']);
  });
});

describe('contract units', () => {
  const hl = load('hyperliquid');
  const inst = hl.instruments.find((i) => i.id === 'hyperliquid:kPEPE')!, ticker = hl.tickers.find((t) => t.instrument === inst.id)!;
  const NOW = hl.recordedAt;
  const book: Book = { instrument: inst.id, ts: NOW, bids: [['0.003800', '500000'], ['0.003799', '900000']], asks: [['0.003804', '400000'], ['0.003806', '800000']] };
  const input = { instrument: inst, book, ticker: { ...ticker, ts: NOW }, fees: { takerRate: '0.00045', makerRate: '0.00015', source: 'test' }, funding: null, maintenanceMarginFraction: '0.05' };
  const req: CostRequest = { side: 'long', notionalUsd: '1000', leverage: '3', horizonHours: '24', depthBps: '10', liquidity: 'taker', now: NOW, maxAgeMs: 15_000 };

  it('toUnderlyingUnits moves the decimal point only: every USD figure is unchanged', () => {
    const u = toUnderlyingUnits(input, of('hyperliquid:kPEPE'));
    expect(u.instrument.base).toBe('PEPE'); expect(u.instrument.id).toBe('hyperliquid:kPEPE');
    expect(u.instrument.lotSize).toBe(D.str(D.mul(D.from(inst.lotSize), D.from('1000')))); expect(u.instrument.tickSize).toBe('0.000000001');
    expect(u.book!.bids[0]).toEqual(['0.0000038', '500000000']); expect(u.book!.asks[1]).toEqual(['0.000003806', '800000000']);
    expect(u.ticker!.mark).toBe(unitPrice(ticker.mark, '1000'));
    const a = venueCost(input, req), b = venueCost(u, req);
    for (const k of ['spreadBps', 'entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'fundingUsd', 'collateralRequiredUsd', 'totalCostUsd', 'totalCostBps', 'liquidationDistanceBps'] as const) expect(b[k].value, k).toBe(a[k].value);
    expect(b.sizeBase.value).toBe(D.str(D.mul(D.from(a.sizeBase.value!), D.from('1000'))));
    expect(b.midPrice.value).toBe(unitPrice(a.midPrice.value!, '1000'));
    // multiplier 1: only the base changes
    const same = toUnderlyingUnits(input, { underlying: 'X', multiplier: '1' });
    expect(same.book).toBe(input.book); expect(same.instrument.base).toBe('X');
    expect(() => toUnderlyingUnits(input, { underlying: 'X', multiplier: '250' })).toThrow(/power of ten/);
    expect(() => toUnderlyingUnits(input, { underlying: null, multiplier: null })).toThrow(/not mapped/);
  });

  it('a discrepancy between a ×1000 contract and a ×1 contract is computed only once both are in the same unit', () => {
    const dy = load('dydx').instruments.find((i) => i.id === 'dydx:PEPE-USD')!;
    const dyBook: Book = { instrument: dy.id, ts: NOW, bids: [['0.0000038000', '900000000']], asks: [['0.0000038040', '900000000']] };
    const other = { instrument: dy, book: dyBook, ticker: null, fees: { takerRate: '0.0005', makerRate: '0.0001', source: 'test' }, funding: { rate: '0', intervalSec: 3600, ts: NOW, source: 'test' }, maintenanceMarginFraction: null };
    const raw = crossVenueDiscrepancy({ ...input, funding: { rate: '0', intervalSec: 3600, ts: NOW, source: 'test' } }, other, req, '0');
    expect(raw.netEdgeEstimateBps).toBeNull(); expect(raw.reason).toMatch(/same base asset/);
    const a = toUnderlyingUnits({ ...input, funding: { rate: '0', intervalSec: 3600, ts: NOW, source: 'test' } }, of('hyperliquid:kPEPE')), b = toUnderlyingUnits(other, of('dydx:PEPE-USD'));
    const d = crossVenueDiscrepancy(a, b, req, '0');
    expect(d.reason).toBeNull();
    // buy at 0.000003804 on Hyperliquid, sell at 0.0000038 on dYdX: a small NEGATIVE gap before costs — not the 1000× artefact
    expect(Number(d.grossGapBps)).toBeCloseTo(-10.5152, 3);
    expect(Number(d.netEdgeEstimateBps)).toBeLessThan(Number(d.grossGapBps));
    expect(d.flagged).toBe(false);
  });

  it('priceOutliers: the median decides; two prices far apart are both flagged', () => {
    expect([...priceOutliers([{ instrument: 'a', unitPrice: '100' }, { instrument: 'b', unitPrice: '100.5' }, { instrument: 'c', unitPrice: '99.8' }, { instrument: 'd', unitPrice: '140' }])]).toEqual(['d']);
    expect(priceOutliers([{ instrument: 'a', unitPrice: '100' }, { instrument: 'b', unitPrice: '100.5' }]).size).toBe(0);
    expect([...priceOutliers([{ instrument: 'a', unitPrice: '100' }, { instrument: 'b', unitPrice: '120' }])].sort()).toEqual(['a', 'b']);
    expect(priceOutliers([{ instrument: 'a', unitPrice: '100' }]).size).toBe(0);
    expect([...priceOutliers([{ instrument: 'a', unitPrice: '100' }, { instrument: 'b', unitPrice: '101' }, { instrument: 'c', unitPrice: '102' }], '50')].sort()).toEqual(['a', 'c']);
  });
});

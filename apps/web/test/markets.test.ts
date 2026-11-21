/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/markets.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// V11 Markets explorer and venue comparator — component-level checks, as the repository does for its other screens (pure
// helpers + source conventions): filters → query string, sorting, the comparator form through the wallet's single amount rule,
// freshness, where a row leads, the multi-series chart geometry, the `mk` / `cp` block of i18n.ts (contiguous, two languages,
// every key used, every used key present) and the wording (no sentence may promise an outcome).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fundingSeries, gapToMedianBps, multiSeriesGeometry, nearestTime, valueAt } from '../src/chart-geom';
import {
  ageLabel, CATEGORIES, COMPARE_BOUNDS, compareParams, compareQuery, COST_ITEMS, costItems, defaultCompareForm, defaultFilters, FORBIDDEN_WORDING, freshness, hubQuery, nextSort, pctText, reasonKey, rowTarget, TEXT_CODES, textKey,
  topDiscrepancies, TRADABLE_REASONS, UNMAPPED_REASONS, unmappedKey, type Discrepancy, type VenueCost,
} from '../src/markets';
import { COST_ASSUMPTIONS, COST_COMPONENTS, DISCREPANCY_ASSUMPTIONS, DISCREPANCY_RISKS, POOL_ASSUMPTIONS } from '../../../packages/trading/src/compare/cost.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');

describe('explorer: filters, sort, pagination', () => {
  it('builds the query string; empty filters are left out; venue and category do not apply to spot', () => {
    expect(hubQuery(defaultFilters())).toBe('?kind=perp&sort=volume&dir=desc&limit=50&offset=0');
    expect(hubQuery({ ...defaultFilters(), venue: 'edgex', category: 'pre_ipo', q: '  anth ropic ', tradable: 'no', sort: 'funding', dir: 'asc', offset: 100 }))
      .toBe('?kind=perp&venue=edgex&category=pre_ipo&q=anth%20ropic&tradable=no&sort=funding&dir=asc&limit=50&offset=100');
    expect(hubQuery({ ...defaultFilters('spot'), venue: 'edgex', category: 'equity' })).toBe('?kind=spot&sort=volume&dir=desc&limit=50&offset=0');
    expect(hubQuery({ ...defaultFilters(), q: 'x'.repeat(60) })).toContain(`q=${'x'.repeat(40)}&`);
  });
  it('a click on the sorted column flips the direction; another column starts descending (the name: ascending); the page goes back to the start', () => {
    expect(nextSort({ sort: 'volume', dir: 'desc' }, 'volume')).toEqual({ sort: 'volume', dir: 'asc', offset: 0 });
    expect(nextSort({ sort: 'volume', dir: 'asc' }, 'volume')).toEqual({ sort: 'volume', dir: 'desc', offset: 0 });
    expect(nextSort({ sort: 'volume', dir: 'asc' }, 'funding')).toEqual({ sort: 'funding', dir: 'desc', offset: 0 });
    expect(nextSort({ sort: 'volume', dir: 'desc' }, 'symbol')).toEqual({ sort: 'symbol', dir: 'asc', offset: 0 });
  });
});

describe('a row: freshness, tradability, where it leads', () => {
  const row = (o: Record<string, unknown> = {}) => ({ price: '100', ageMs: 2_000, stale: false, staleAfterMs: 15_000, ...o }) as never;
  it('freshness follows the age against the venue\'s own bound, and the server\'s flag', () => {
    expect(freshness(row())).toBe('fresh'); expect(freshness(row({ ageMs: 9_000 }))).toBe('aging'); expect(freshness(row({ ageMs: 16_000 }))).toBe('stale');
    expect(freshness(row({ stale: true }))).toBe('stale'); expect(freshness(row({ price: null }))).toBe('none'); expect(freshness(row({ ageMs: null }))).toBe('none');
    expect(freshness(row({ ageMs: 20_000, staleAfterMs: 30_000 }))).toBe('aging');             // edgeX and GMX have a 30 s bound
    expect([ageLabel(900, 'fr'), ageLabel(59_400, 'fr'), ageLabel(240_000, 'fr'), ageLabel(3 * 3_600_000, 'fr'), ageLabel(3 * 86_400_000, 'fr'), ageLabel(3 * 86_400_000, 'en'), ageLabel(null, 'fr')]).toEqual(['1 s', '59 s', '4 min', '3 h', '3 j', '3 d', '—']);
  });
  it('spot → the Asset screen; a perp the wallet can trade → the Futures terminal; any other market → the read-only sheet', () => {
    expect(rowTarget({ kind: 'spot', id: 'spot:BTC', tradable: true, networks: [{ network: 'bitcoin', asset: 'native' }, { network: 'ethereum', asset: '0xabc' }] })).toEqual({ kind: 'asset', network: 'bitcoin', asset: 'native' });
    expect(rowTarget({ kind: 'perp', id: 'hyperliquid:BTC', tradable: true })).toEqual({ kind: 'futures', instrument: 'hyperliquid:BTC' });
    for (const id of ['edgex:ANTHROPICUSDC', 'dydx:BTC-USD', 'hyperliquid:HYPE', 'gmx:SOL/USD [SOL-USDC]']) expect(rowTarget({ kind: 'perp', id, tradable: false })).toEqual({ kind: 'sheet', instrument: id });
    expect(rowTarget({ kind: 'spot', id: 'spot:X', tradable: false })).toEqual({ kind: 'sheet', instrument: 'spot:X' });
  });
  it('every reason code has a sentence; an unknown code falls back to a generic one, never to a raw code', () => {
    for (const c of TRADABLE_REASONS) expect(reasonKey(c)).toBe(`mkWhy_${c}`);
    expect(reasonKey('something_new')).toBe('mkWhy_other'); expect(reasonKey(null)).toBe('mkWhy_other');
    for (const c of UNMAPPED_REASONS) expect(unmappedKey(c)).toBe(`mkUnmapped_${c}`);
    expect(unmappedKey('x')).toBe('mkUnmapped_other');
    // the same codes as the server's (services/api/src/markets-hub/hub.ts, packages/trading/src/compare/symbols.ts)
    const hub = read('../../../services/api/src/markets-hub/hub.ts'), sym = read('../../../packages/trading/src/compare/symbols.ts');
    const server = /export type TradableReason = ([^;]+);/.exec(hub)![1]!.match(/'([a-z_]+)'/g)!.map((x) => x.slice(1, -1)).sort();
    expect([...TRADABLE_REASONS].sort()).toEqual(server);
    expect([...UNMAPPED_REASONS].sort()).toEqual(/export type UnmappedReason = ([^;]+);/.exec(sym)![1]!.match(/'([a-z_]+)'/g)!.map((x) => x.slice(1, -1)).sort());
    expect([...CATEGORIES]).toEqual(['crypto', 'equity', 'pre_ipo', 'commodity', 'fx']);
  });
  it('percentages: sign, decimals, no negative zero', () => {
    expect(pctText('0.1095', 2, 'fr', true)).toBe('+10,95 %'); expect(pctText('-0.2194', 2, 'en', true)).toBe('−21.94 %'); expect(pctText('-0.000001', 2, 'fr', true)).toBe('0,00 %');
    expect(pctText('0.0312', 2, 'en')).toBe('3.12 %'); expect(pctText(null, 2, 'fr')).toBe('—'); expect(pctText('x', 2, 'fr')).toBe('—');
  });
});

describe('comparator form — the wallet\'s single amount rule', () => {
  const f = defaultCompareForm('ETH');
  it('the default form is BTC-like: long, 1 000 USD, ×3, 24 h', () => {
    expect(compareParams(defaultCompareForm(), 'fr')).toEqual({ ok: true, params: { underlying: 'BTC', side: 'long', notional: '1000', leverage: '3', horizonHours: '24' } });
    expect(compareQuery({ underlying: 'ETH', side: 'short', notional: '2500.5', leverage: '2', horizonHours: '0' })).toBe('?underlying=ETH&side=short&notional=2500.5&leverage=2&horizonHours=0');
  });
  it('French and English spellings give the same canonical numbers', () => {
    expect(compareParams({ ...f, notional: '1 000,50', leverage: '2,5', horizon: '12,5' }, 'fr')).toEqual({ ok: true, params: { underlying: 'ETH', side: 'long', notional: '1000.50', leverage: '2.5', horizonHours: '12.5' } });
    expect(compareParams({ ...f, notional: '1,000.50', leverage: '2.5', horizon: '12.5' }, 'en')).toEqual({ ok: true, params: { underlying: 'ETH', side: 'long', notional: '1000.50', leverage: '2.5', horizonHours: '12.5' } });
    expect(compareParams({ ...f, horizon: '0' }, 'fr')).toMatchObject({ ok: true });                                   // entry and exit only
  });
  it('what cannot be read is refused with the field and the reason — never guessed, never clamped', () => {
    expect(compareParams({ ...f, notional: '1,000' }, 'en')).toEqual({ ok: false, problem: { field: 'notional', error: 'ambiguous' } });
    expect(compareParams({ ...f, notional: '1.000' }, 'fr')).toEqual({ ok: false, problem: { field: 'notional', error: 'ambiguous' } });
    expect(compareParams({ ...f, notional: '' }, 'fr')).toEqual({ ok: false, problem: { field: 'notional', error: 'empty' } });
    expect(compareParams({ ...f, notional: '1e3' }, 'fr')).toEqual({ ok: false, problem: { field: 'notional', error: 'invalid' } });
    expect(compareParams({ ...f, notional: '0' }, 'fr')).toEqual({ ok: false, problem: { field: 'notional', error: 'range' } });
    expect(compareParams({ ...f, notional: String(COMPARE_BOUNDS.notionalMax + 1) }, 'fr')).toEqual({ ok: false, problem: { field: 'notional', error: 'range' } });
    expect(compareParams({ ...f, leverage: '0' }, 'fr')).toEqual({ ok: false, problem: { field: 'leverage', error: 'range' } });
    expect(compareParams({ ...f, leverage: '201' }, 'fr')).toEqual({ ok: false, problem: { field: 'leverage', error: 'range' } });
    expect(compareParams({ ...f, horizon: '9000' }, 'fr')).toEqual({ ok: false, problem: { field: 'horizon', error: 'range' } });
    expect(compareParams({ ...f, horizon: '1,23456' }, 'fr')).toEqual({ ok: false, problem: { field: 'horizon', error: 'too_many_decimals' } });
  });
  it('the form reads its numbers through amount.ts and nowhere else', () => {
    const src = read('../src/markets.ts'), cmp = read('../src/derivatives/Compare.tsx');
    expect(src).toContain("import { parseAmountInput, type AmountLocale } from './amount'"); expect(cmp).toContain('sanitizeAmountText'); expect(cmp).toContain('<AmountProblem');
    expect(cmp.slice(cmp.indexOf('export function CostCompare'))).not.toMatch(/parseFloat|Number\(form\./);
  });
});

describe('comparator: itemised cost and discrepancies', () => {
  const fig = (value: string | null, reason: string | null = null) => ({ value, reason, basis: value === null ? null : 'basis' });
  it('lists the five components of the total in order; a missing one carries its reason', () => {
    expect([...COST_ITEMS]).toEqual([...COST_COMPONENTS]);                                           // the same five as the server's total
    const c = { entrySlippageUsd: fig('0.01'), exitSlippageUsd: fig(null, 'no order book was supplied'), entryFeeUsd: fig('0.45'), exitFeeUsd: fig('0.45'), fundingUsd: fig('-0.3') } as unknown as VenueCost;
    expect(costItems(c)).toEqual([{ id: 'entrySlippageUsd', usd: '0.01', reason: null, basis: 'basis' }, { id: 'exitSlippageUsd', usd: null, reason: 'no order book was supplied', basis: null },
      { id: 'entryFeeUsd', usd: '0.45', reason: null, basis: 'basis' }, { id: 'exitFeeUsd', usd: '0.45', reason: null, basis: 'basis' }, { id: 'fundingUsd', usd: '-0.3', reason: null, basis: 'basis' }]);
    expect(costItems(null).every((x) => x.usd === null && x.reason === null)).toBe(true);
  });
  it('shows the pairs that have an estimate, in the server\'s order', () => {
    const d = (net: string | null) => ({ netEdgeEstimateBps: net }) as Discrepancy;
    expect(topDiscrepancies([d('5'), d(null), d('-2'), d('-3'), d('-4'), d('-9')]).map((x) => x.netEdgeEstimateBps)).toEqual(['5', '-2', '-3', '-4']);
    expect(topDiscrepancies([d(null)])).toEqual([]);
  });
  it('every coded sentence of the server has a translation key — the same count as the server\'s lists', () => {
    const count = (p: string) => TEXT_CODES.filter((c) => c.startsWith(p)).length;
    expect(count('cost_')).toBe(COST_ASSUMPTIONS.length); expect(count('pool_')).toBe(POOL_ASSUMPTIONS.length); expect(count('disc_assume_')).toBe(DISCREPANCY_ASSUMPTIONS.length); expect(count('disc_risk_')).toBe(DISCREPANCY_RISKS.length);
    expect(textKey('disc_risk_3')).toBe('cpText_disc_risk_3'); expect(textKey('something_new')).toBeNull();          // unknown code: the server's own sentence is shown
    const api = read('../../../services/api/src/markets-hub/compare.ts');
    for (const p of ["coded('cost'", "coded('pool'", "coded('disc_assume'", "coded('disc_risk'", "code: 'price_guard'", "code: 'not_tradable'"]) expect(api).toContain(p);
  });
});

describe('MultiSeriesChart geometry', () => {
  const pad = { t: 10, r: 0, b: 20, l: 0 };
  const s = (id: string, pts: [number, number][]) => ({ id, label: id, points: pts.map(([t, v]) => ({ t, v })) });
  it('one time axis and one value axis for every series; a series without data keeps its place with an empty path', () => {
    const g = multiSeriesGeometry([s('a', [[0, 10], [100, 20]]), s('b', [[50, 0], [100, 30]]), s('c', [])], 200, 130, pad)!;
    expect([g.t0, g.t1, g.min, g.max]).toEqual([0, 100, 0, 30]); expect(g.times).toEqual([0, 50, 100]);
    expect(g.x(0)).toBe(0); expect(g.x(100)).toBe(200); expect(g.y(30)).toBe(10); expect(g.y(0)).toBe(110);
    expect(g.paths.map((p) => p.id)).toEqual(['a', 'b', 'c']); expect(g.paths[0]!.d).toBe('M0.0 76.7L200.0 43.3'); expect(g.paths[1]!.d).toBe('M100.0 110.0L200.0 10.0'); expect(g.paths[2]).toEqual({ id: 'c', d: '', last: null });
    expect(g.paths[0]!.last).toMatchObject({ x: 200, v: 20, t: 100 }); expect(g.zeroY).toBe(110);
  });
  it('`zero` keeps 0 in range; a flat series still has a range; no series with two points → null', () => {
    const g = multiSeriesGeometry([s('a', [[0, 5], [10, 7]])], 100, 100, pad, { zero: true })!;
    expect(g.min).toBe(0); expect(g.zeroY).toBe(g.y(0));
    expect(multiSeriesGeometry([s('a', [[0, 5], [10, 7]])], 100, 100, pad)!.zeroY).toBeNull();
    const flat = multiSeriesGeometry([s('a', [[0, 5], [10, 5]])], 100, 100, pad)!;
    expect(flat.max).toBeGreaterThan(flat.min);
    expect(multiSeriesGeometry([s('a', [[0, 5]]), s('b', [])], 100, 100, pad)).toBeNull(); expect(multiSeriesGeometry([], 100, 100, pad)).toBeNull();
    expect(multiSeriesGeometry([s('a', [[0, NaN], [5, 1], [10, 2]])], 100, 100, pad)!.times).toEqual([5, 10]);       // unreadable points are dropped
  });
  it('the crosshair snaps to the nearest time; a series is read at that time or just before it', () => {
    expect(nearestTime([0, 50, 100], 20)).toBe(0); expect(nearestTime([0, 50, 100], 26)).toBe(50); expect(nearestTime([0, 50, 100], 999)).toBe(100); expect(nearestTime([], 5)).toBeNull(); expect(nearestTime([7], 0)).toBe(7);
    const pts = [{ t: 0, v: 1 }, { t: 3_600_000, v: 2 }, { t: 14_400_000, v: 3 }];
    expect(valueAt(pts, 3_600_000, 7_200_000)).toEqual({ t: 3_600_000, v: 2 }); expect(valueAt(pts, 7_200_000, 7_200_000)).toEqual({ t: 3_600_000, v: 2 });
    expect(valueAt(pts, 12_000_000, 7_200_000)).toBeNull();                                          // nothing recent enough: « — », not an old value
  });
  it('price gap: each venue against the median at the same hour, in basis points; funding: annualised percent from the venue\'s interval', () => {
    const g = gapToMedianBps([s('a', [[0, 100], [1, 100]]), s('b', [[0, 101], [1, 100]]), s('c', [[0, 99]])]);
    expect(g[0]!.points).toEqual([{ t: 0, v: 0 }, { t: 1, v: 0 }]); expect(g[1]!.points[0]!.v).toBeCloseTo(100, 6); expect(g[2]!.points[0]!.v).toBeCloseTo(-100, 6);
    expect(gapToMedianBps([s('a', [[0, 100]]), s('b', [[5, 100]])]).every((x) => x.points.length === 0)).toBe(true);   // no common time: nothing to compare
    expect(fundingSeries([{ ts: 1, rate: '0.0000125' }], 3600)[0]!.v).toBeCloseTo(10.95, 6); expect(fundingSeries([{ ts: 1, rate: '0.00005' }], 14400)[0]!.v).toBeCloseTo(10.95, 6);
  });
  it('the chart is hand-written SVG in a module of its own: no chart library, and nothing added to the first chunk', () => {
    const src = read('../src/chart-multi.tsx'), pkg = JSON.parse(read('../package.json'));
    expect(src).toContain('<svg'); expect(src).toContain('export function MultiSeriesChart');
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /chart|d3|recharts|plot|visx|echarts/i.test(d))).toEqual([]);
    expect(read('../src/chart.tsx')).not.toMatch(/from '\.\/chart-(multi|geom)'/);
    const app = read('../src/App.tsx');
    expect(app).toContain("markets: () => import('./screens/Markets')"); expect(app).not.toMatch(/import \{[^}]*\} from '\.\/screens\/Markets'/); expect(app).not.toMatch(/screens\.markets,/);   // lazy, and not in the idle preload queue
  });
});

describe('i18n: the mk / cp block, and the wording', () => {
  const i18n = read('../src/i18n.ts'), sources = ['../src/screens/Markets.tsx', '../src/derivatives/Compare.tsx', '../src/App.tsx', '../src/markets.ts'].map(read).join('\n');
  const a = i18n.indexOf('// >>> v11 Markets explorer'), b = i18n.indexOf('// <<< end of the `mk` / `cp` block');
  const block = i18n.slice(a, b);
  const pairs = [...block.matchAll(/\b((?:mk|cp)[A-Za-z0-9_]+): \[\s*'((?:[^'\\]|\\.)+)',\s*'((?:[^'\\]|\\.)+)'\]/g)].map((m) => ({ key: m[1]!, fr: m[2]!, en: m[3]! }));
  const keys = new Set(pairs.map((p) => p.key));

  it('one contiguous block; every key has a French and an English sentence with the same placeholders; no mk / cp key outside it', () => {
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(pairs.length).toBeGreaterThan(150); expect(keys.size).toBe(pairs.length);
    expect([...block.matchAll(/\b((?:mk|cp)[A-Za-z0-9_]+): \[/g)].length).toBe(pairs.length);
    expect((i18n.slice(0, a) + i18n.slice(b)).match(/\b(mk|cp)[A-Z][A-Za-z0-9_]*: \[/g)).toBeNull();
    const vars = (x: string) => [...x.matchAll(/\{([a-z]+)\}/gi)].map((m) => m[1]!).sort().join(',');
    for (const p of pairs) expect(vars(p.fr), p.key).toBe(vars(p.en));
  });
  it('every key the screens use exists, and every key of the block is used', () => {
    const used = new Set<string>([...sources.matchAll(/'((?:mk|cp)[A-Z][A-Za-z0-9_]*)'/g)].map((m) => m[1]!));
    const families: Record<string, readonly string[]> = { mkWhy_: [...TRADABLE_REASONS, 'other'], mkUnmapped_: [...UNMAPPED_REASONS, 'other'], mkCat_: CATEGORIES, mkVenue_: ['ok', 'stale', 'error'], cpText_: TEXT_CODES, cpItem_: COST_ITEMS,
      cpRange_: ['notional', 'leverage', 'horizon'], cpChart_: ['funding', 'gap', 'price'] };
    for (const [prefix, ids] of Object.entries(families)) { expect(sources, prefix).toContain(`${prefix}\${`); for (const id of ids) used.add(`${prefix}${id}`); }
    expect([...used].filter((k) => !keys.has(k)).sort()).toEqual([]);
    expect([...keys].filter((k) => !used.has(k)).sort()).toEqual([]);
  });
  it('no sentence of the two screens promises an outcome: the forbidden words are absent from the block, in both languages', () => {
    for (const p of pairs) { expect(p.fr.match(FORBIDDEN_WORDING)?.[0] ?? null, `${p.key} (fr)`).toBeNull(); expect(p.en.match(FORBIDDEN_WORDING)?.[0] ?? null, `${p.key} (en)`).toBeNull(); }
    for (const bad of ['Profit estimé', 'rendement garanti', 'guaranteed', 'risk-free', 'risk free carry', 'sans risque', 'bénéfice', 'gain assuré']) expect(FORBIDDEN_WORDING.test(bad), bad).toBe(true);
    // what is said instead: an estimate, with assumptions and risks, never a recommendation
    const text = (k: string) => pairs.find((p) => p.key === k)!;
    expect(text('cpDiscIntro').en).toMatch(/estimate under assumptions.*risks.*never a recommendation/); expect(text('cpDiscIntro').fr).toMatch(/estimation sous hypothèses.*risques.*jamais une recommandation/);
    expect(text('cpDisclaimer').en).toMatch(/neither a quote nor a recommendation/); expect(text('cpDiscAbove').en).toMatch(/An estimate is not an outcome/);
    // the server's own sentences obey the same rule
    for (const t of [...COST_ASSUMPTIONS, ...POOL_ASSUMPTIONS, ...DISCREPANCY_ASSUMPTIONS, ...DISCREPANCY_RISKS, read('../../../services/api/src/markets-hub/compare.ts').replace(/\/\/[^\n]*/g, '')]) expect(t.match(FORBIDDEN_WORDING)?.[0] ?? null).toBeNull();
  });
  it('the screens: read-only, a discrepancy is always shown with its assumptions and risks, a non-tradable venue is flagged with its reason', () => {
    const markets = read('../src/screens/Markets.tsx'), cmp = read('../src/derivatives/Compare.tsx'), pure = read('../src/markets.ts');
    for (const src of [markets, pure, cmp.slice(cmp.indexOf('export function CostCompare'))]) expect(src).not.toMatch(/\bpost\(|placeOrder|\/orders|idempotency/i);
    expect(pure).not.toMatch(/import \{[^}]*\bpost\b/);
    const disc = cmp.slice(cmp.indexOf("t('cpDiscTitle')"));
    expect(disc).toContain('d.assumptions.map'); expect(disc).toContain('d.risks.map'); expect(disc).toContain("t('cpDiscNotActionable')");
    expect(cmp).toContain('data-testid="cp-not-tradable"'); expect(markets).toContain('data-testid="mk-not-tradable"'); expect(markets).toContain('reasonKey(r.tradableReason)');
    expect(markets).toContain('data-testid="mk-fresh"'); expect(markets).toContain("t('mkReadOnly')");
    // the read-only sheet has no order control
    const sheet = markets.slice(markets.indexOf('function MarketSheet'));
    expect(sheet).not.toMatch(/OrderPanel|fxBuy|fxSell|type="submit"/);
  });
});

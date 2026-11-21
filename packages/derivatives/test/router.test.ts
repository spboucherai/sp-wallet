/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/router.test.ts
 * Module           : derivatives
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

// Universal derivatives router (src/router.ts) on the venues' recorded answers: the REAL adapters over a replaying fetch
// (fixtures of 2026-11-10/11), no network. The GMX price-impact formula is checked against the venue's own number for a real
// position; the Hyperliquid book walk against a second, independent computation.
import { describe, expect, it } from 'vitest';
import {
  createDydxAdapter, createGmxAdapter, D, OrderIntentSchema, contractDifferences, estimateVenue, gmxBalanceOi, gmxPriceImpact, orderBodyFor, powDec, rankCandidates, routeOrder, walkBook,
  ARBITRUM_GAS_UNITS, ROUTER_FACTS, ROUTER_MAX_AGE_MS, TERM_KEYS,
  type Book, type ChainCosts, type ExecutionEstimate, type GmxLiquidity, type Instrument, type Ticker, type VenueSnapshot,
} from '../src/index.ts';
import { createHyperliquidAdapter } from '../src/venues/hyperliquid/index.ts';
import { fx as hlFx, replay as hlReplay } from './hyperliquid/helpers.ts';
import { fx, replay, type Route } from './venue-helpers.ts';

const NOW = Date.parse('2026-11-11T03:05:30Z');
const GMX_ROUTES: Route[] = [
  ['/markets/tickers', fx('gmx', 'v1-markets-tickers')], ['/markets/config', fx('gmx', 'v1-markets-config')], [/\/v1\/markets$/, fx('gmx', 'v1-markets')],
  ['/tokens/info', fx('gmx', 'v1-tokens-info')], ['/pairs', fx('gmx', 'v1-pairs')], ['/positions', fx('gmx', 'v1-positions')],
];
const DYDX_ROUTES: Route[] = [[/\/v4\/perpetualMarkets$/, fx('dydx', 'perpetualMarkets')], ['/orderbooks/perpetualMarket/BTC-USD', fx('dydx', 'orderbook-BTC-USD')]];
const gmx = createGmxAdapter({ fetch: replay(GMX_ROUTES).fetch, now: () => NOW });
const dydx = createDydxAdapter({ fetch: replay(DYDX_ROUTES).fetch, now: () => NOW });
const hlRoute = (n: string) => { const x = hlFx(`mainnet-${n}`); return { status: x.status, body: x.body }; };
const hl = createHyperliquidAdapter({ network: 'mainnet', now: () => NOW, fetch: hlReplay({ meta: hlRoute('meta'), metaAndAssetCtxs: hlRoute('metaAndAssetCtxs'), l2Book: hlRoute('l2Book-BTC') }).fetchImpl });

const GMX_ACCOUNT = '0x46a3BA57e146A4906bc68759Fb7ad1E74d3B66f6', GMX_BTC = 'BTC/USD [BTC-USDC]';
const CHAIN: ChainCosts = { gasPriceEth: '0.00000000002', ethUsd: '2065.7', ethUsdSource: 'test', gmxExecutionFeeEth: '0.00012', gmxExecutionFeeNote: 'test value', ts: NOW };
const PAPER = { trading: 'paper' as const, note: 'paper trading on this venue; live trading exists and is disabled' };
const NONE = { trading: 'none' as const, note: 'this wallet cannot trade on this venue: read only' };
const d = D.from, n = (x: string) => Number(x);

async function snapshots(): Promise<{ hl: VenueSnapshot; gmx: VenueSnapshot; dydx: VenueSnapshot; all: VenueSnapshot[] }> {
  const pick = <T extends { id: string }>(l: T[], id: string): T => { const x = l.find((i) => i.id === id); if (!x) throw new Error(`no ${id}`); return x; };
  const tk = (l: Ticker[], id: string): Ticker => ({ ...l.find((t) => t.instrument === id)!, ts: NOW });
  const [hi, ht, hb, gi, gt, gl, di, dt, db] = await Promise.all([hl.instruments(), hl.tickers(), hl.book('BTC'), gmx.instruments(), gmx.tickers(), gmx.liquidity(GMX_BTC), dydx.instruments(), dydx.tickers(), dydx.book('BTC-USD')]);
  const common = { fundingRange: null, chain: CHAIN, account: null };
  const a: VenueSnapshot = { venue: 'hyperliquid', restriction: null, wallet: PAPER, instrument: pick(hi, 'hyperliquid:BTC'), ticker: tk(ht, 'hyperliquid:BTC'), book: { ...hb, ts: NOW }, gmx: null, ...common };
  const b: VenueSnapshot = { venue: 'gmx', restriction: null, wallet: NONE, instrument: pick(gi, `gmx:${GMX_BTC}`), ticker: tk(gt, `gmx:${GMX_BTC}`), book: null, gmx: gl[0]!, ...common };
  const c: VenueSnapshot = { venue: 'dydx', restriction: 'dYdX is not available to you: its terms exclude Canada', wallet: NONE, instrument: pick(di, 'dydx:BTC-USD'), ticker: tk(dt, 'dydx:BTC-USD'), book: { ...db, ts: NOW }, gmx: null, ...common };
  return { hl: a, gmx: b, dydx: c, all: [a, b, c] };
}
// loosely typed on purpose: the tests also feed the schema what it must refuse
const intent = (o: Record<string, unknown> = {}): any => ({ base: 'BTC', side: 'long', notionalUsd: '25000', leverage: '3', type: 'market', horizonHours: '24', ...o });
const costOf = (e: ExecutionEstimate, id: string) => e.costs.find((c) => c.id === id)!;
const codes = (e: ExecutionEstimate, kind?: string) => e.eligibility.reasons.filter((r) => !kind || r.kind === kind).map((r) => r.code);

describe('intent', () => {
  it('takes exactly one size, a price only on a limit order, and a bounded horizon', () => {
    expect(OrderIntentSchema.parse(intent())).toMatchObject({ reduceOnly: false, price: null, horizonHours: '24' });
    expect(OrderIntentSchema.safeParse(intent({ sizeBase: '0.1' })).success).toBe(false);                       // both sizes
    expect(OrderIntentSchema.safeParse(intent({ notionalUsd: undefined })).success).toBe(false);                  // none
    expect(OrderIntentSchema.safeParse(intent({ type: 'limit' })).success).toBe(false);                           // limit without a price
    expect(OrderIntentSchema.safeParse(intent({ price: '70000' })).success).toBe(false);                          // market with a price
    expect(OrderIntentSchema.safeParse(intent({ type: 'limit', price: '70000' })).success).toBe(true);
    expect(OrderIntentSchema.safeParse(intent({ horizonHours: '8761' })).success).toBe(false);
    expect(OrderIntentSchema.safeParse(intent({ leverage: '0' })).success).toBe(false);
    expect(OrderIntentSchema.safeParse(intent({ notionalUsd: 25000 })).success).toBe(false);                      // a number is not a decimal string
    expect(OrderIntentSchema.safeParse(intent({ venue: 'gmx' })).success).toBe(false);                            // strict: the caller cannot pre-select a venue
  });
});

describe('exact power', () => {
  it('multiplies integer exponents out exactly and matches known values to 30 decimals otherwise', () => {
    expect(D.str(powDec(d('1.5'), d('2')))).toBe('2.25');
    expect(D.str(powDec(d('12345.678'), d('1')))).toBe('12345.678');
    expect(D.str(powDec(d('2'), d('0.5')))).toBe('1.41421356237309504880168872421');            // √2 = 1.41421356237309504880168872420969807… (30 decimals, trailing zero dropped)
    expect(D.str(powDec(d('10'), d('1.5')))).toBe('31.622776601683793319988935444327');         // 10·√10
    expect(D.str(powDec(d('1000000'), d('1.5')))).toBe('1000000000');
    expect(D.str(powDec(d('0.25'), d('0.5')))).toBe('0.5');
    // e^1 through x = e (60 digits of e): ln then exp must give e back
    expect(D.str(powDec(d('2.718281828459045235360287471352662497757247093699959574966'), d('1.000000000000000000000000000001'))).slice(0, 30)).toBe('2.7182818284590452353602874713');
    expect(() => powDec(d('0'), d('1.5'))).toThrow(); expect(() => powDec(d('2'), d('-1'))).toThrow();
  });
});

describe('GMX price impact: the documented formula against the venue\'s own figure', () => {
  it('reproduces closePriceImpactDeltaUsd of a real recorded position — with open interest in tokens × price, not with the USD cost basis', async () => {
    const [p] = await gmx.positions(GMX_ACCOUNT), all = await gmx.liquidity();
    const l = all.find((x) => x.instrument === p!.instrument)!;
    expect(p!.instrument).toBe('gmx:LTC/USD [WETH-USDC]'); expect(l.useOpenInterestInTokensForBalance).toBe(true);
    const venue = d(p!.gmx.closePriceImpactDeltaUsd), pi = l.priceImpact;
    const oi = gmxBalanceOi(l);
    // a decrease takes TOKENS off the side: its USD delta is the position's tokens × the current price
    const size = D.mul(d(p!.size), D.div(D.add(d(l.oracleMin), d(l.oracleMax)), d('2'), 30, 'half_even'));
    const args = { sizeDeltaUsd: size, isLong: p!.side === 'long', increase: false, factorPositive: d(pi.factorPositive), factorNegative: d(pi.factorNegative), exponentPositive: d(pi.exponentPositive), exponentNegative: d(pi.exponentNegative) };
    expect(oi.basis).toBe('tokens × oracle mid'); expect(oi.virtual).toBe('unknown');                     // this older fixture set has no /markets/values
    const mine = gmxPriceImpact({ ...args, longOi: oi.long, shortOi: oi.short });
    // closing a short on a short-heavy market reduces the imbalance: positive impact, same side
    expect(mine.balanceWasImproved).toBe(true); expect(mine.crossover).toBe(false);
    const rel = Math.abs(D.toNumber(mine.impactUsd) / D.toNumber(venue) - 1);
    // the two fixtures were recorded seconds apart (the price moved by a few 1e-4): the figures agree to 0.1 %
    expect(D.toNumber(venue)).toBeCloseTo(0.2187, 4); expect(rel).toBeLessThan(0.001);
    // the USD cost-basis open interest the liquidity view used to be limited to gives three times the venue's figure
    const usd = gmxPriceImpact({ ...args, longOi: d(l.openInterestLongUsd), shortOi: d(l.openInterestShortUsd) });
    expect(D.toNumber(usd.impactUsd) / D.toNumber(venue)).toBeGreaterThan(2.5);
    expect(gmxBalanceOi({ ...l, useOpenInterestInTokensForBalance: null }).basis).toBe('USD cost basis');
  });

  it('reproduces the venue\'s figure on a consistent recorded set — four real positions, one of them decided by the virtual inventory', async () => {
    const R = (name: string) => fx('gmx-router', name);
    const routes = (positions: string): Route[] => [['/markets/tickers', R('v1-markets-tickers')], ['/markets/config', R('v1-markets-config')], ['/markets/values', R('v1-markets-values')],
      [/\/v1\/markets$/, R('v1-markets')], ['/tokens/info', R('v1-tokens-info')], ['/positions', R(positions)]];
    const seen: Record<string, { rel: number; virtual: boolean; sign: number }> = {};
    for (const label of ['eth-short', 'eth-long', 'btc-long', 'btc-short']) {
      const a = createGmxAdapter({ fetch: replay(routes(`v1-positions-${label}`)).fetch, now: () => NOW });
      const [p] = await a.positions('0x0000000000000000000000000000000000000001'), l = (await a.liquidity()).find((x) => x.instrument === p!.instrument)!;
      const oi = gmxBalanceOi(l), pi = l.priceImpact, mid = D.div(D.add(d(l.oracleMin), d(l.oracleMax)), d('2'), 30, 'half_even');
      expect(oi.virtual).toBe(label.startsWith('eth') ? 'known' : 'none');                               // ETH markets share a virtual inventory, BTC/USD [BTC-USDC] has none
      const mine = gmxPriceImpact({ longOi: oi.long, shortOi: oi.short, sizeDeltaUsd: D.mul(d(p!.size), mid), isLong: p!.side === 'long', increase: false, virtualInventoryUsd: oi.virtualUsd,
        factorPositive: d(pi.factorPositive), factorNegative: d(pi.factorNegative), exponentPositive: d(pi.exponentPositive), exponentNegative: d(pi.exponentNegative) });
      const venue = D.toNumber(d(p!.gmx.closePriceImpactDeltaUsd));
      seen[label] = { rel: Math.abs(D.toNumber(mine.impactUsd) / venue - 1), virtual: mine.fromVirtualInventory, sign: Math.sign(venue) };
      // without the virtual inventory the market's own imbalance gives another figure whenever the virtual one decides
      if (mine.fromVirtualInventory) expect(Math.abs(D.toNumber(mine.marketImpactUsd) / venue - 1)).toBeGreaterThan(0.05);
    }
    // positions and market state were read within a few seconds of each other: agreement to 0.2 % at worst
    for (const [label, x] of Object.entries(seen)) expect(x.rel, label).toBeLessThan(0.002);
    expect(Object.values(seen).some((x) => x.virtual)).toBe(true);
  });

  it('same-side and crossover cases follow the contract code', () => {
    const f = { factorPositive: d('0.00000001'), factorNegative: d('0.00000002'), exponentPositive: d('2'), exponentNegative: d('2') };
    // longs 100, shorts 300: a 100 long reduces the gap 200 → 100: + (200² − 100²) × 1e-8
    expect(D.str(gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('100'), isLong: true, increase: true }).impactUsd)).toBe('0.0003');
    // a 100 short widens it 200 → 300: − (300² − 200²) × 2e-8
    expect(D.str(gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('100'), isLong: false, increase: true }).impactUsd)).toBe('-0.001');
    // a 500 long crosses the balance point: +200² × 1e-8 − 300² × 2e-8
    const x = gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('500'), isLong: true, increase: true });
    expect(x.crossover).toBe(true); expect(x.balanceWasImproved).toBe(false); expect(D.str(x.impactUsd)).toBe('-0.0014');
    // the positive factor is never above the negative one; a difference under 1 USD contributes nothing
    expect(D.str(gmxPriceImpact({ ...f, factorPositive: d('1'), longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('100'), isLong: true, increase: true }).impactUsd)).toBe('0.0006');
    expect(D.str(gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('100.5'), sizeDeltaUsd: d('0.4'), isLong: true, increase: true }).impactUsd)).toBe('0');
    // a decrease larger than the side's open interest floors it at zero
    expect(D.str(gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('1000'), isLong: true, increase: false }).nextDiffUsd)).toBe('300');
    // virtual inventory: only looked at when the market's own impact is negative, and only applied when it is worse.
    // traders net long 1000 across the index (−1000): a 100 short on a market that is short-heavy by 200 → own −0.001; virtual: long 1000, short 0 → 100 short REDUCES the gap → positive → not worse → own figure
    const own = gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('100'), isLong: false, increase: true, virtualInventoryUsd: d('-1000') });
    expect([D.str(own.impactUsd), own.fromVirtualInventory]).toEqual(['-0.001', false]);
    // traders net short 1000 (+1000): the same short widens the virtual gap 1000 → 1100: −(1100² − 1000²) × 2e-8 = −0.0042, worse → applied
    const v = gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('100'), isLong: false, increase: true, virtualInventoryUsd: d('1000') });
    expect([D.str(v.impactUsd), D.str(v.marketImpactUsd), v.fromVirtualInventory, v.balanceWasImproved]).toEqual(['-0.0042', '-0.001', true, false]);
    // a decrease first shifts both virtual sides by the size (the contracts do it to avoid an underflow), then removes it from the order's side.
    // closing a 100 short on a long-heavy market (300 vs 100) widens its gap 200 → 300: −0.001; virtual: long 1000 + 100, short 0 + 100 − 100: gap 1000 → 1100: −0.0042
    const dec = gmxPriceImpact({ ...f, longOi: d('300'), shortOi: d('100'), sizeDeltaUsd: d('100'), isLong: false, increase: false, virtualInventoryUsd: d('-1000') });
    expect([D.str(dec.impactUsd), dec.fromVirtualInventory]).toEqual(['-0.0042', true]);
    // a positive own impact never consults the virtual inventory
    expect(gmxPriceImpact({ ...f, longOi: d('100'), shortOi: d('300'), sizeDeltaUsd: d('100'), isLong: true, increase: true, virtualInventoryUsd: d('-100000') }).fromVirtualInventory).toBe(false);
  });
});

describe('order book walk', () => {
  const asks: [string, string][] = [['100', '1'], ['101', '2'], ['103', '5']];
  it('fills level by level, reports the worst price, and stops where the snapshot or the limit stops', () => {
    const w = walkBook(asks, d('2.5'), 'buy', null);
    expect([D.str(w.filled), D.str(w.cost), D.str(w.avg!), D.str(w.worst!), w.levels, w.stoppedBy]).toEqual(['2.5', '251.5', '100.6', '101', 2, 'filled']);
    const end = walkBook(asks, d('10'), 'buy', null);
    expect([D.str(end.filled), D.str(end.remainder), end.stoppedBy, D.str(end.sideTotal)]).toEqual(['8', '2', 'book_snapshot_ends', '8']);
    const lim = walkBook(asks, d('10'), 'buy', d('101'));
    expect([D.str(lim.filled), D.str(lim.remainder), lim.stoppedBy]).toEqual(['3', '7', 'limit_price']);
    expect(walkBook([['99', '1'], ['98', '1']], d('2'), 'sell', d('98.5')).stoppedBy).toBe('limit_price');
    expect(walkBook(asks, d('1'), 'buy', d('99')).avg).toBeNull();
  });

  it('agrees with a second, independent computation on the recorded Hyperliquid book (floating point, level by level)', async () => {
    const s = await snapshots();
    for (const usd of ['1000', '25000', '500000']) for (const side of ['long', 'short'] as const) {
      const e = estimateVenue(s.hl, { intent: OrderIntentSchema.parse(intent({ notionalUsd: usd, side })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
      const levels = side === 'long' ? s.hl.book!.asks : s.hl.book!.bids;
      let left = n(e.order!.sizeBase), cost = 0, worst = 0;
      for (const [p, q] of levels) { if (left <= 1e-12) break; const take = Math.min(left, n(q)); cost += take * n(p); left -= take; worst = n(p); }
      const filled = n(e.order!.sizeBase) - left, mid = (n(s.hl.book!.bids[0]![0]) + n(s.hl.book!.asks[0]![0])) / 2;
      expect(n(e.fill!.filledBase)).toBeCloseTo(filled, 9);
      if (filled > 0) {
        expect(n(e.fill!.avgPrice!)).toBeCloseTo(cost / filled, 6); expect(n(e.fill!.worstPrice!)).toBe(worst);
        expect(n(e.fill!.slippageBps!)).toBeCloseTo(((side === 'long' ? 1 : -1) * (cost / filled - mid) / mid) * 1e4, 4);
      }
      expect(n(e.fill!.unfilledBase)).toBeCloseTo(Math.max(0, left), 9);
    }
  });
});

describe('estimate on Hyperliquid (order book)', () => {
  it('itemises spread, fee and funding with their inputs and sources; margin and liquidation are estimates', async () => {
    const s = await snapshots();
    const e = estimateVenue(s.hl, { intent: OrderIntentSchema.parse(intent()), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(e.eligibility).toMatchObject({ eligible: true, executableNow: false });                      // no account with collateral was given
    expect(codes(e, 'blocker')).toEqual([]); expect(codes(e, 'setup')).toEqual(['no_collateral_account']); expect(codes(e, 'note')).toContain('paper_only');
    const mid = (n(s.hl.book!.bids[0]![0]) + n(s.hl.book!.asks[0]![0])) / 2;
    expect(e.order).toMatchObject({ side: 'buy', sizeUnit: 'base', type: 'market' });
    expect(D.isMultiple(d(e.order!.sizeBase), d(s.hl.instrument.lotSize))).toBe(true);
    expect(n(e.order!.sizeBase) * mid).toBeLessThanOrEqual(25000); expect(n(e.order!.sizeBase) * mid).toBeGreaterThan(25000 - mid * 0.00001);
    expect(e.order!.rounding).toContain('lot');
    expect(e.fill).toMatchObject({ method: 'order_book_walk', unfilledBase: '0', unfilledReason: 'none', restingBase: '0', referenceSource: 'venue', source: 'estimate' });
    expect(n(e.fill!.depthConsumedPct!)).toBeGreaterThan(0); expect(n(e.fill!.depthConsumedPct!)).toBeLessThan(100);
    expect(e.costs.map((c) => c.id)).toEqual(['spread_slippage', 'trading_fee', 'funding', 'collateral_transfer']);
    expect(e.costs.every((c) => c.source === 'estimate' && c.basis.length > 20 && c.uncertainty.length > 3)).toBe(true);
    // fee = base-tier taker rate (a documented constant) × the filled notional, exactly
    const fee = costOf(e, 'trading_fee');
    expect(fee.usd).toBe(D.str(D.div(D.mul(d(e.fill!.filledUsd), d('0.00045')), D.one, 6, 'half_even')));
    expect(fee.inputs.find((i) => i.name === 'taker rate')).toEqual({ name: 'taker rate', value: '0.00045', source: 'constant' });
    expect(n(fee.bps!)).toBeCloseTo(4.5, 1);
    // funding = size × oracle price × the venue's hourly rate × 24, paid by the long; the basis says the rate changes
    const f = costOf(e, 'funding'), rate = s.hl.ticker.funding!;
    expect(n(f.usd!)).toBeCloseTo(n(e.order!.sizeBase) * n(s.hl.ticker.index!) * n(rate) * 24, 5);
    expect(f.inputs[0]).toMatchObject({ value: D.str(d(rate)), source: 'venue' }); expect(f.basis).toMatch(/RATE CHANGES/); expect(f.timing).toBe('over_horizon');
    expect(f.uncertaintyUsd).toBe(D.str(D.abs(d(f.usd!))));                                           // no history supplied: ±100 %
    // a short receives what the long pays
    const sh = estimateVenue(s.hl, { intent: OrderIntentSchema.parse(intent({ side: 'short' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(n(costOf(sh, 'funding').usd!)).toBeCloseTo(-n(f.usd!), 2);
    // collateral: a USDC transfer on Arbitrum at the snapshot's gas price, with the venue's deposit facts as constants
    const col = costOf(e, 'collateral_transfer');
    expect(n(col.usd!)).toBeCloseTo(n(ARBITRUM_GAS_UNITS.erc20Transfer) * 0.00000000002 * 2065.7, 6);
    expect(col.inputs[0]!.value).toMatch(/Minimum 5 USDC/); expect(col.timing).toBe('before_trading');
    // margin: notional / leverage; maintenance = half the initial margin at the venue's maximum leverage
    const maxLev = n(s.hl.instrument.maxLeverage);
    expect(n(e.margin!.initialMarginUsd)).toBeCloseTo(n(e.margin!.notionalUsd) / 3, 4); expect(n(e.margin!.maintenanceFraction!)).toBeCloseTo(1 / (2 * maxLev), 9);
    expect(e.margin!.liquidationPrice.source).toBe('estimate'); expect(e.margin!.maintenanceSource).toBe('constant');
    const entry = n(e.margin!.notionalUsd) / n(e.order!.sizeBase), liq = n(e.margin!.liquidationPrice.value!);
    expect(liq).toBeCloseTo(entry * (1 - 1 / 3) / (1 - 1 / (2 * maxLev)), 3);
    expect(n(e.margin!.liquidationDistanceBps!)).toBeCloseTo(((entry - liq) / entry) * 1e4, 2);
    // all-in = the sum of the known components; exit is separate information
    const sum = e.costs.reduce((a, c) => a + n(c.usd!), 0);
    expect(n(e.allIn!.usd)).toBeCloseTo(sum, 5); expect(e.allIn).toMatchObject({ complete: true, unknown: [], horizonHours: '24' });
    expect(n(e.allIn!.bps)).toBeCloseTo((sum / n(e.order!.sizeUsd)) * 1e4, 2);
    expect(e.exit!.parts.map((p) => p.id)).toEqual(['spread_slippage', 'trading_fee']); expect(e.exit!.note).toMatch(/information only/);
    expect(orderBodyFor(e)).toEqual({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: e.order!.sizeBase, price: null, reduceOnly: false, leverage: '3', slippageBps: 50 });
  });

  it('an account with enough collateral makes the order executable (as paper) and the collateral cost zero; a funding history narrows the uncertainty', async () => {
    const s = await snapshots();
    const acct = { id: 'a1', label: 'Sim', kind: 'paper' as const, mode: 'PAPER', equity: '50000', freeCollateral: '50000' };
    const e = estimateVenue({ ...s.hl, account: acct, fundingRange: { minPerHour: '0.00001', maxPerHour: '0.000014', hours: 24 } }, { intent: OrderIntentSchema.parse(intent()), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(e.eligibility).toMatchObject({ eligible: true, executableNow: true, executableAs: 'paper' });
    expect(costOf(e, 'collateral_transfer')).toMatchObject({ usd: '0' }); expect(costOf(e, 'collateral_transfer').basis).toMatch(/SIMULATED/);
    expect(n(costOf(e, 'funding').uncertaintyUsd)).toBeCloseTo(n(e.order!.sizeBase) * n(s.hl.ticker.index!) * 24 * 0.000002, 4);
    const poor = estimateVenue({ ...s.hl, account: { ...acct, freeCollateral: '100' } }, { intent: OrderIntentSchema.parse(intent()), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(codes(poor, 'setup')).toEqual(['insufficient_collateral_there']); expect(poor.eligibility.executableNow).toBe(false);
  });

  it('refuses with a named reason: lot, minimum, leverage, halted, reduce-only instrument, stale data, a book that ends', async () => {
    const s = await snapshots(), run = (snap: VenueSnapshot, o: Record<string, unknown>, now = NOW) => estimateVenue(snap, { intent: OrderIntentSchema.parse(intent(o)), now, maxAge: ROUTER_MAX_AGE_MS });
    expect(codes(run(s.hl, { notionalUsd: '0.5' }), 'blocker')).toEqual(['size_rounds_to_zero']);
    expect(codes(run(s.hl, { notionalUsd: '5' }), 'blocker')).toEqual(['below_min_notional']);
    expect(codes(run(s.hl, { leverage: '41' }), 'blocker')).toEqual(['leverage_above_venue_max']);
    expect(codes(run(s.hl, { leverage: '2.5' }), 'blocker')).toEqual(['leverage_not_integer']);
    expect(codes(run({ ...s.hl, instrument: { ...s.hl.instrument, status: 'halted' } }, {}), 'blocker')).toEqual(['instrument_halted']);
    expect(codes(run({ ...s.hl, instrument: { ...s.hl.instrument, status: 'reduce_only' } }, {}), 'blocker')).toEqual(['instrument_reduce_only']);
    expect(codes(run({ ...s.hl, instrument: { ...s.hl.instrument, status: 'reduce_only' } }, { reduceOnly: true }), 'blocker')).toEqual([]);
    // stale data: no fill, no cost, no total — the router does not estimate on it
    const old = run(s.hl, {}, NOW + ROUTER_MAX_AGE_MS.ticker + 1);
    expect(codes(old, 'blocker')).toEqual(['stale_data']); expect(old).toMatchObject({ fill: null, costs: [], allIn: null, margin: null });
    const oldBook = run({ ...s.hl, book: { ...s.hl.book!, ts: NOW - ROUTER_MAX_AGE_MS.book - 1 } }, {});
    expect(codes(oldBook, 'blocker')).toEqual(['stale_data']); expect(oldBook.fill).toBeNull();
    expect(codes(run({ ...s.hl, book: null }, {}), 'blocker')).toEqual(['no_depth_data']);
    // a size beyond the snapshot: the remainder is named, not extrapolated, and the instrument is not ranked
    const thin: Book = { instrument: 'hyperliquid:BTC', bids: [['73000', '0.1']], asks: [['73010', '0.1'], ['73020', '0.1']], ts: NOW };
    const big = run({ ...s.hl, book: thin }, { notionalUsd: '50000' });
    expect(codes(big, 'blocker')).toEqual(['book_snapshot_ends']);
    expect(big.fill).toMatchObject({ filledBase: '0.2', unfilledReason: 'book_snapshot_ends', levelsConsumed: 2, snapshotLevels: 2, depthConsumedPct: '100' });
    expect(n(big.fill!.unfilledBase)).toBeGreaterThan(0.4); expect(big.fill!.notes[0]).toMatch(/snapshot ends/);
    expect(big.eligibility.reasons.find((r) => r.code === 'book_snapshot_ends')!.message).toMatch(/not extrapolated/);
    expect(big.allIn).toMatchObject({ complete: false }); expect(big.allIn!.note).toMatch(/^PARTIAL/);
    expect(rankCandidates([big]).rows).toEqual([]);
  });

  it('a limit order fills what is marketable and says what would rest; a reduce-only order needs no margin and has no carry', async () => {
    const s = await snapshots(), book: Book = { instrument: 'hyperliquid:BTC', bids: [['73000', '1']], asks: [['73010', '0.1'], ['73020', '5']], ts: NOW };
    const e = estimateVenue({ ...s.hl, book }, { intent: OrderIntentSchema.parse(intent({ notionalUsd: undefined, sizeBase: '0.3', type: 'limit', price: '73010' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(e.fill).toMatchObject({ filledBase: '0.1', restingBase: '0.2', unfilledBase: '0', unfilledReason: 'limit_price' });
    expect(codes(e, 'note')).toContain('limit_rests'); expect(e.eligibility.eligible).toBe(true);
    // 0.1 taker at 73010 + 0.2 maker at 73010
    expect(costOf(e, 'trading_fee').usd).toBe(D.str(D.add(D.mul(d('7301'), d('0.00045')), D.mul(d('14602'), d('0.00015')))));
    expect(costOf(e, 'spread_slippage').usd).toBe('1.5');                                              // 0.3 × (73010 − 73005)
    const rest = estimateVenue({ ...s.hl, book }, { intent: OrderIntentSchema.parse(intent({ notionalUsd: undefined, sizeBase: '0.3', type: 'limit', price: '72000' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(rest.fill).toMatchObject({ filledBase: '0', restingBase: '0.3', unfilledReason: 'not_marketable', avgPrice: null });
    expect(n(costOf(rest, 'spread_slippage').usd!)).toBeLessThan(0);                                   // resting below the mid: a price improvement IF it fills
    expect(codes(estimateVenue({ ...s.hl, book }, { intent: OrderIntentSchema.parse(intent({ notionalUsd: undefined, sizeBase: '0.3', type: 'limit', price: '73010.55' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS }), 'blocker')).toEqual(['price_not_on_tick']);
    const ro = estimateVenue(s.hl, { intent: OrderIntentSchema.parse(intent({ reduceOnly: true, leverage: '100' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(ro.order!.side).toBe('sell'); expect(ro.margin).toBeNull(); expect(ro.costs.map((c) => c.id)).toEqual(['spread_slippage', 'trading_fee']); expect(codes(ro, 'blocker')).toEqual([]);
  });
});

describe('estimate on GMX (no order book)', () => {
  it('prices from the oracle range, the impact formula inside its caps, the position fee tier, execution fee, gas, funding and borrowing', async () => {
    const s = await snapshots(), l = s.gmx.gmx!;
    const e = estimateVenue(s.gmx, { intent: OrderIntentSchema.parse(intent({ notionalUsd: '500000' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(e.eligibility).toMatchObject({ eligible: true, executableNow: false, executableAs: null });
    expect(codes(e, 'setup')).toEqual(['wallet_cannot_trade_here', 'no_collateral_account']); expect(codes(e, 'note')).toEqual(expect.arrayContaining(['two_step_execution', 'gmx_interface_leverage']));
    expect(e.order).toMatchObject({ sizeUnit: 'usd', sizeUsd: '500000', side: 'buy' });
    expect(e.fill).toMatchObject({ method: 'gmx_oracle_impact', levelsConsumed: null, unfilledBase: '0' });
    expect(e.fill!.gmx).toMatchObject({ oracleMin: l.oracleMin, oracleMax: l.oracleMax, openInterestBasis: 'tokens × oracle mid', capNegativeUsd: '2500', capPositiveUsd: '2000', capped: false, virtualInventory: 'none', fromVirtualInventory: false });
    // BTC's published oracle range has min = max in this snapshot: no spread, and that is said; a range with a spread is charged on the side the order executes at
    expect(costOf(e, 'spread_slippage').usd).toBe('0'); expect(costOf(e, 'spread_slippage').basis).toMatch(/min = max/);
    const mid = n(l.oracleMin);
    const wide = estimateVenue({ ...s.gmx, gmx: { ...l, oracleMin: D.str(d(String(mid - 4))), oracleMax: D.str(d(String(mid + 4))) } }, { intent: OrderIntentSchema.parse(intent({ notionalUsd: '500000' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(n(costOf(wide, 'spread_slippage').usd!)).toBeCloseTo((500000 / (mid + 4)) * 4, 2); expect(n(wide.fill!.avgPrice!)).toBeCloseTo(mid + 4, 6); expect(costOf(wide, 'spread_slippage').basis).not.toMatch(/min = max/);
    // longs are the smaller side by more than 500 000 USD: a long reduces the imbalance → positive impact, lower fee factor
    const oi = gmxBalanceOi(l), gap = D.toNumber(D.sub(oi.short, oi.long));
    expect(gap).toBeGreaterThan(500000);
    expect(e.fill!.gmx).toMatchObject({ balanceWasImproved: true, crossover: false });
    const f = n(l.priceImpact.factorPositive), x = n(l.priceImpact.exponentPositive);
    expect(n(e.fill!.gmx!.impactUsd)).toBeCloseTo(f * (gap ** x - (gap - 500000) ** x), 3);
    expect(n(costOf(e, 'price_impact').usd!)).toBeCloseTo(-n(e.fill!.gmx!.impactUsd), 6); expect(costOf(e, 'price_impact').timing).toBe('at_close');
    expect(costOf(e, 'price_impact').basis).toMatch(/impact pool balance is not modelled/); expect(costOf(e, 'price_impact').basis).toMatch(/positive impact is a credit RECORDED at the open and SETTLED at the close/);
    expect(costOf(e, 'price_impact').uncertaintyUsd).toBe(D.str(D.abs(d(costOf(e, 'price_impact').usd!))));     // ±100 %: it is settled at the close
    // an immediate close under the same snapshot takes the credit back: the round trip costs more than the entry figure says
    expect(e.exit!.parts.map((p) => p.id)).toEqual(['price_impact', 'spread_slippage', 'trading_fee', 'execution_fee', 'network_gas']);
    expect(n(e.exit!.parts[0]!.usd)).toBeGreaterThan(-n(costOf(e, 'price_impact').usd!)); expect(n(e.exit!.roundTripUsd)).toBeCloseTo(n(e.allIn!.usd) + n(e.exit!.usd), 4);
    expect(costOf(e, 'trading_fee')).toMatchObject({ usd: '200', bps: '4' });                            // 0.04 % of 500 000
    expect(costOf(e, 'trading_fee').inputs[0]).toMatchObject({ value: '0.0004', source: 'venue' });
    expect(n(costOf(e, 'execution_fee').usd!)).toBeCloseTo(0.00012 * 2065.7, 6);
    expect(n(costOf(e, 'network_gas').usd!)).toBeCloseTo(n(ARBITRUM_GAS_UNITS.gmxCreateOrder) * 0.00000000002 * 2065.7, 6);
    // venue sign: the long side's funding rate is negative (it pays) → a cost; longs pay no borrowing today
    expect(n(l.fundingRateLongPerHour)).toBeLessThan(0);
    expect(n(costOf(e, 'funding').usd!)).toBeCloseTo(-n(l.fundingRateLongPerHour) * 500000 * 24, 4);
    expect(costOf(e, 'borrow').usd).toBe('0'); expect(n(costOf(e, 'borrow').uncertaintyUsd)).toBeCloseTo(n(l.borrowingRateShortPerHour) * 500000 * 24, 4);
    expect(costOf(e, 'collateral_transfer').usd).toBeNull();                                           // unknown: said, not guessed
    expect(e.allIn).toMatchObject({ complete: false, unknown: ['collateral_transfer'] }); expect(e.allIn!.note).toMatch(/NOT included because unknown: collateral_transfer/);
    // a short widens the imbalance: negative impact, higher fee factor, and it pays borrowing
    const sh = estimateVenue(s.gmx, { intent: OrderIntentSchema.parse(intent({ notionalUsd: '500000', side: 'short' })), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(sh.fill!.gmx!.balanceWasImproved).toBe(false); expect(n(costOf(sh, 'price_impact').usd!)).toBeGreaterThan(0);
    expect(costOf(sh, 'trading_fee')).toMatchObject({ usd: '300', bps: '6' }); expect(n(costOf(sh, 'borrow').usd!)).toBeGreaterThan(0);
    expect(n(costOf(sh, 'funding').usd!)).toBeLessThan(0);                                             // shorts receive funding today
    // margin: liquidation from the market's own minimum collateral factor
    expect(e.margin).toMatchObject({ maintenanceFraction: '0.005', maintenanceSource: 'venue' }); expect(e.margin!.liquidationPrice.method).toMatch(/opening fee/);
    expect(n(e.margin!.liquidationPrice.value!)).toBeLessThan(n(l.oracleMin));
    expect(orderBodyFor(e)).toBeNull();                                                                // a USD-sized GMX estimate is not an order for a book account
    // without a chain snapshot the two chain costs are unknown and named
    const dry = estimateVenue({ ...s.gmx, chain: null }, { intent: OrderIntentSchema.parse(intent()), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    expect(dry.allIn!.unknown).toEqual(['execution_fee', 'network_gas', 'collateral_transfer']);
  });

  it('caps the impact at the market\'s maximum factor, and refuses above capacity, above the open-interest cap and above the leverage the market allows', async () => {
    const s = await snapshots(), l = s.gmx.gmx!, run = (g: GmxLiquidity, o: Record<string, unknown>) => estimateVenue({ ...s.gmx, gmx: g }, { intent: OrderIntentSchema.parse(intent(o)), now: NOW, maxAge: ROUTER_MAX_AGE_MS });
    const steep = run({ ...l, priceImpact: { ...l.priceImpact, factorNegative: '0.001' } }, { notionalUsd: '500000', side: 'short' });
    expect(steep.fill!.gmx).toMatchObject({ capped: true, impactCappedUsd: '-2500' }); expect(costOf(steep, 'price_impact').usd).toBe('2500'); expect(costOf(steep, 'price_impact').basis).toMatch(/CAPPED/);
    expect(codes(run(l, { notionalUsd: '90000000' }), 'blocker')).toEqual(['above_capacity']);
    expect(codes(run({ ...l, maxOpenInterestLongUsd: '9700000' }, { notionalUsd: '500000' }), 'blocker')).toEqual(['above_open_interest_cap']);
    expect(codes(run(l, { leverage: '201' }), 'blocker')).toEqual(['leverage_above_venue_max']);
    // the minimum collateral factor grows with open interest: 6e-11 per USD × 100 M = 0.6 % → 166× at most
    expect(codes(run({ ...l, openInterestLongUsd: '100000000', maxOpenInterestLongUsd: '200000000' }, { leverage: '180' }), 'blocker')).toEqual(['leverage_above_venue_max']);
    expect(codes(run(l, { notionalUsd: '0.5' }), 'blocker')).toEqual(['below_min_notional']);
    expect(codes(run({ ...l, ts: NOW - ROUTER_MAX_AGE_MS.liquidity - 1 }, {}), 'blocker')).toEqual(['stale_data']);
    // a market with a virtual inventory whose value could not be read: a negative impact is widened to the cap, and that is said
    const blind = run({ ...l, virtualInventory: { applies: true, tokens: null, usd: null } }, { notionalUsd: '500000', side: 'short' });
    expect(blind.fill!.gmx!.virtualInventory).toBe('unknown'); expect(costOf(blind, 'price_impact').basis).toMatch(/VIRTUAL INVENTORY UNKNOWN/);
    expect(n(costOf(blind, 'price_impact').uncertaintyUsd)).toBeCloseTo(2500 - n(costOf(blind, 'price_impact').usd!), 4);
    // …and when it is known and worse than the market's own imbalance, it gives the figure
    const worse = run({ ...l, virtualInventory: { applies: true, tokens: '200', usd: '0' } }, { notionalUsd: '500000', side: 'short' });
    expect(worse.fill!.gmx).toMatchObject({ virtualInventory: 'known', fromVirtualInventory: true }); expect(n(costOf(worse, 'price_impact').usd!)).toBeGreaterThan(n(costOf(blind, 'price_impact').usd!));
  });
});

describe('the whole comparison', () => {
  it('estimates every instrument, never ranks a restricted venue, selects nothing, and refuses to call two contracts the same', async () => {
    const s = await snapshots();
    const r = routeOrder(intent(), s.all, { now: NOW });
    expect(r.candidates.map((c) => c.venue)).toEqual(['hyperliquid', 'gmx', 'dydx']); expect(r.source).toBe('estimate'); expect(r.ts).toBe(NOW);
    const dy = r.candidates[2]!;
    expect(dy.eligibility.eligible).toBe(false); expect(codes(dy, 'blocker')).toEqual(['venue_restricted']); expect(dy.eligibility.reasons[0]!.message).toMatch(/Canada/);
    expect(dy.fill).not.toBeNull();                                                                    // public data, shown for information
    expect(costOf(dy, 'collateral_transfer').basis).toMatch(/not available to the owner/);
    expect(r.ranking.selected).toBeNull(); expect(r.ranking.note).toMatch(/selects nothing/); expect(r.ranking.note).toMatch(/not "best"/);
    expect(r.ranking.rows.map((x) => x.venue).sort()).toEqual(['gmx', 'hyperliquid']);
    expect(r.ranking.excluded).toEqual([{ instrument: 'dydx:BTC-USD', venue: 'dydx', reasons: ['venue_restricted'] }]);
    const [first, second] = r.ranking.rows;
    expect(first!.rank).toBe(1); expect(second!.rank).toBe(2); expect(D.lte(d(first!.allInUsd), d(second!.allInUsd))).toBe(true);
    expect(r.ranking.rows.every((x) => x.executableNow === false)).toBe(true);
    expect(r.differences.interchangeable).toBe(false); expect(r.differences.statement).toMatch(/3 different contracts on BTC\. None of them is the same contract/);
    const fields = r.differences.fields.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['collateral', 'settlement', 'markPrice', 'fundingInterval', 'maxLeverage', 'structure', 'execution', 'lot', 'maintenance']));
    expect(r.differences.fields.find((f) => f.field === 'fundingInterval')!.values.map((v) => v.value)).toEqual(['every 1 h', 'continuous (per second), quoted per 1 h', 'every 1 h']);
    expect(r.differences.never.length).toBeGreaterThanOrEqual(4);
    expect(r.warnings.join(' ')).toMatch(/Simulation only/); expect(r.warnings.join(' ')).toMatch(/rates change/); expect(r.warnings.join(' ')).toMatch(/NOT in the totals/); expect(r.warnings.join(' ')).toMatch(/never ranked/);
    expect(TERM_KEYS.every((k) => r.candidates.every((c) => c.terms[k].value.length > 0))).toBe(true);
    // another base: nothing to compare, said so
    const none = routeOrder(intent({ base: 'ZZZ' }), s.all, { now: NOW });
    expect(none.candidates).toEqual([]); expect(none.ranking.rows).toEqual([]); expect(none.warnings.join(' ')).toMatch(/No venue lists a perpetual on ZZZ/);
    expect(() => routeOrder({ ...intent(), leverage: 'abc' }, s.all, { now: NOW })).toThrow();
  });

  it('reports ties and near-ties instead of an order the estimates do not establish', () => {
    const mk = (instrument: string, usd: string, unc: string, eligible = true, trip: string | null = null): ExecutionEstimate => ({
      venue: 'hyperliquid', venueName: 'x', instrument, symbol: instrument, eligibility: { eligible, executableNow: false, executableAs: null, reasons: eligible ? [] : [{ code: 'stale_data', kind: 'blocker', message: '' }] },
      order: null, fill: null, costs: [], margin: null, terms: {} as never, data: { tickerAgeMs: 0, depthAgeMs: 0 }, source: 'estimate', ts: 0,
      allIn: { usd, bps: '0', uncertaintyUsd: unc, included: [], unknown: [], horizonHours: '24', complete: true, note: '' },
      exit: trip === null ? null : { usd: '0', bps: '0', roundTripUsd: trip, roundTripBps: '0', parts: [], note: '' } });
    const r = rankCandidates([mk('c', '20', '1'), mk('a', '10', '0.5'), mk('b', '10', '0.5'), mk('d', '10.8', '0.4'), mk('e', '5', '0', false)]);
    expect(r.orderChangesWithExit).toBe(false); expect(r.rows.every((x) => x.roundTripUsd === null && x.roundTripRank === null)).toBe(true);
    // the round trip can order the instruments differently: said, never used to rank
    const t = rankCandidates([mk('x', '10', '0', true, '30'), mk('y', '12', '0', true, '20')]);
    expect(t.rows.map((x) => [x.instrument, x.rank, x.roundTripRank])).toEqual([['x', 1, 2], ['y', 2, 1]]); expect(t.orderChangesWithExit).toBe(true);
    expect(rankCandidates([mk('x', '10', '0', true, '20'), mk('y', '12', '0', true, '30')]).orderChangesWithExit).toBe(false);
    expect(r.rows.map((x) => [x.instrument, x.rank])).toEqual([['a', 1], ['b', 1], ['d', 3], ['c', 4]]);
    expect(r.rows[0]).toMatchObject({ tiedWith: ['b'], nearTieWith: ['d'] });                           // 10.8 − 10 ≤ 0.5 + 0.4
    expect(r.rows[2]).toMatchObject({ tiedWith: [], nearTieWith: ['a', 'b'] });
    expect(r.rows[3]).toMatchObject({ tiedWith: [], nearTieWith: [] });
    expect(r.excluded).toEqual([{ instrument: 'e', venue: 'hyperliquid', reasons: ['stale_data'] }]); expect(r.selected).toBeNull();
    expect(contractDifferences('BTC', []).interchangeable).toBe(false);
    expect(contractDifferences('BTC', [mk('a', '1', '0')].map((e) => ({ ...e, terms: Object.fromEntries(TERM_KEYS.map((k) => [k, { value: 'v', source: 'venue' }])) as never }))).statement).toMatch(/not the same contract as a BTC perpetual anywhere else/);
  });

  it('every documented constant names its page', () => {
    for (const f of Object.values(ROUTER_FACTS)) { expect(f.feeSource).toMatch(/https:\/\//); expect(f.maintenanceText).toMatch(/https:\/\//); expect(f.collateral.source.length).toBeGreaterThan(10); }
    const inst = null as unknown as Instrument; void inst;
  });
});

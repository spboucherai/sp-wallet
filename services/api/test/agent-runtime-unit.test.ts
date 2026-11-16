// V11 agent runtime — the pure parts, no database and no network:
//   the agent model (families, modes, live capability, templates, library manifest), the performance module on hand-computed
//   cases, the three stream rules and the paper book / fill model, the risk supervisor (findings, its two permitted actions,
//   and what it can never do), the module boundaries (the runtime imports nothing that writes a mandate) and a reading of the
//   SQL of the read model (every query on a table shared by paper and live names the mode).
import './agent-env.ts';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Instrument } from '@spw/derivatives';
import { REPO_ROOT } from './test-db.ts';
import { apiMode, configHash, dbMode, FAMILIES, FAMILY_MODES, inLibraryManifest, lifecycleOf, liveVerdict, matchesStrategyName, modeOf, NO_LIVE_ONE_VENUE, ruleHash, RULES, TEMPLATES } from '../src/agent-runtime/model.ts';
import { computePerformance, maxDrawdown, MIN_POINTS_FOR_RATIOS, spotTrades, stdev } from '../src/agent-runtime/performance.ts';
import { accrueFunding, applyFill, crossDecision, fundingDecision, hourlyBps, mmFills, mmQuotes, needsRequote, newPaperBook, paperEquity, volBps, type MarketView, type Quote } from '../src/agent-runtime/families.ts';
import { evaluatePortfolio, supervise, type AgentSnapshot, type Finding, type SupervisorLimits, type SupervisorPorts } from '../src/agent-runtime/risk-supervisor.ts';
import { backoffMs, MAX_ATTEMPTS } from '../src/agent-runtime/queue.ts';
import { decisionOf } from '../src/agent-runtime/journal.ts';

const H = 3_600_000;

describe('agent model', () => {
  it('eight families, each with an engine and the modes it runs in; only single-venue bar families and the supervisor reach live', () => {
    expect([...FAMILIES]).toEqual(['momentum', 'mean_reversion', 'stat_arb', 'funding_arb', 'market_making', 'cross_exchange', 'risk_manager', 'custom']);
    const live = FAMILIES.filter((f) => FAMILY_MODES[f].modes.includes('live'));
    expect(live).toEqual(['momentum', 'mean_reversion', 'stat_arb', 'risk_manager', 'custom']);
    for (const f of ['funding_arb', 'market_making', 'cross_exchange'] as const) {
      expect(FAMILY_MODES[f].engine).toBe('stream'); expect([...FAMILY_MODES[f].modes]).toEqual(['research', 'paper']); expect(FAMILY_MODES[f].liveReason).toBeTruthy();
    }
    // the sentence the product shows for the two-venue families
    expect(FAMILY_MODES.cross_exchange.liveReason).toBe('mode réel indisponible : une seule plateforme autorise l\'exécution sous mandat');
    expect(FAMILY_MODES.funding_arb.liveReason).toBe(NO_LIVE_ONE_VENUE);
  });

  it('historical states project onto active | paused | stopped; the mode is research unless the agent trades', () => {
    expect(['PAPER_TRADING', 'LIVE', 'STOPPING', 'RUNNING'].map(lifecycleOf)).toEqual(['active', 'active', 'active', 'active']);
    expect(lifecycleOf('PAUSED')).toBe('paused');
    expect(['CREATED', 'AWAITING_APPROVAL', 'STOPPED', 'FAILED', 'RESEARCH', 'RESEARCHING', 'BACKTESTING'].map(lifecycleOf).every((x) => x === 'stopped')).toBe(true);
    expect([modeOf({ state: 'LIVE', mode: 'LIVE' }), modeOf({ state: 'PAUSED', mode: 'LIVE' }), modeOf({ state: 'PAPER_TRADING', mode: 'PAPER' }), modeOf({ state: 'CREATED', mode: 'RESEARCH' })]).toEqual(['live', 'live', 'paper', 'research']);
    expect([dbMode('paper'), apiMode('LIVE'), apiMode(null), apiMode('RESEARCH')]).toEqual(['PAPER', 'live', 'research', 'research']);
  });

  it('D1: a perp agent may go live only on the signer\'s pinned instruments; a stream family never', () => {
    expect(liveVerdict('momentum', 'perp', ['BTC', 'ETH', 'SOL'])).toEqual({ capable: true });
    expect(liveVerdict('stat_arb', 'perp', ['BTC', 'ETH'])).toEqual({ capable: true });
    const hype = liveVerdict('momentum', 'perp', ['BTC', 'ETH', 'SOL', 'HYPE']);
    expect(hype.capable).toBe(false);
    if (!hype.capable) { expect(hype.code).toBe('universe_not_pinned'); expect(hype.reason).toMatch(/HYPE is not/); expect(hype.reason).toMatch(/BTC, ETH, SOL/); }
    const mm = liveVerdict('market_making', 'stream', ['BTC']);
    expect(mm.capable).toBe(false); if (!mm.capable) expect(mm.code).toBe('family_not_live');
    const cx = liveVerdict('cross_exchange', 'stream', ['BTC']);
    if (!cx.capable) expect(cx.reason).toBe(NO_LIVE_ONE_VENUE);
  });

  it('the seven templates: one per agent, a real code path behind each, strategies bound by NAME', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['stat-arb', 'funding-arb', 'market-making', 'momentum', 'mean-reversion', 'cross-exchange', 'risk-manager']);
    for (const t of TEMPLATES) {
      if (t.engine === 'bar') { expect(t.strategies.length, t.id).toBeGreaterThan(0); expect(t.rule).toBeNull(); }
      else { expect(t.strategies, t.id).toEqual([]); expect(RULES[t.rule!], t.id).toBeDefined(); expect(RULES[t.rule!]!.family).toBe(t.family); expect(ruleHash(t.rule!)).toMatch(/^[0-9a-f]{64}$/); }
      expect(t.name.fr && t.name.en && t.summary.fr && t.summary.en, t.id).toBeTruthy();
    }
    // the names the laboratory workstream is adding come first; the versions present today follow
    expect(TEMPLATES.find((t) => t.id === 'momentum')!.strategies).toEqual(['momentum_xs_perp', 'ts_momentum_perp', 'ma_trend_perp', 'vol_breakout_perp']);
    expect(TEMPLATES.find((t) => t.id === 'stat-arb')!.strategies).toEqual(['statarb_basket_perp', 'pairs_coint_perp']);
    expect(TEMPLATES.find((t) => t.id === 'mean-reversion')!.strategies).toEqual(['mean_reversion_bands_perp', 'zscore_reversion_perp']);
    expect([matchesStrategyName('momentum_xs_perp', 'momentum_xs_perp'), matchesStrategyName('momentum_xs_perp_bes', 'momentum_xs_perp'), matchesStrategyName('ts_momentum_perp', 'momentum_xs_perp')]).toEqual([true, true, false]);
  });

  it('D10: the library manifest lists production strategies; a fixture, a scratch copy or a research job is not in it', () => {
    for (const ok of ['ma_trend', 'pairs_coint_perp', 'momentum_xs_perp', 'momentum_xs_perp_btc_eth_sol', 'risk_supervisor', 'vol_forecast']) expect(inLibraryManifest(ok), ok).toBe(true);
    for (const no of ['zz_forktest', 'rj_0eb9b833115a', 'fake_perp', 'tmp', 'ma_trend_copy', 'pairs_coint_perp2']) expect(inLibraryManifest(no), no).toBe(false);
    const before = process.env.SPW_LAB_EXTRA_STRATEGIES;
    process.env.SPW_LAB_EXTRA_STRATEGIES = 'zz_forktest, ../etc';
    expect([inLibraryManifest('zz_forktest'), inLibraryManifest('../etc')]).toEqual([true, false]);
    if (before === undefined) delete process.env.SPW_LAB_EXTRA_STRATEGIES; else process.env.SPW_LAB_EXTRA_STRATEGIES = before;
  });

  it('a configuration hash does not depend on key order; a change is another hash', () => {
    expect(configHash({ a: 1, b: { y: 2, x: [1, 2] } })).toBe(configHash({ b: { x: [1, 2], y: 2 }, a: 1 }));
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }));
  });

  it('queue backoff: per kind, increasing, capped at the last value', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs('tick', n))).toEqual([120_000, 300_000, 600_000, 900_000, 900_000, 900_000]);
    expect(backoffMs('backtest', 1)).toBe(60_000);
    expect(MAX_ATTEMPTS.tick).toBe(5);
  });

  it('a finished bar is `acted` when an order reached the account, else `skipped` with the reason code', () => {
    expect(decisionOf([{ status: 'filled' }, { status: 'refused' }], 2)).toEqual({ decision: 'acted', reasonCode: 'acted' });
    expect(decisionOf([{ status: 'deferred' }], 1)).toEqual({ decision: 'skipped', reasonCode: 'orders_deferred' });
    expect(decisionOf([{ status: 'refused' }], 1)).toEqual({ decision: 'skipped', reasonCode: 'orders_refused' });
    expect(decisionOf([], 0)).toEqual({ decision: 'skipped', reasonCode: 'at_target' });
  });
});

describe('performance — one module, hand-computed cases', () => {
  // equity 100 → 110 → 99 → 108.9, hourly: returns +10 %, −10 %, +10 %
  const equity = [100, 110, 99, 108.9].map((e, i) => ({ ts: i * H, equity: e }));
  const trades = [{ ts: 1, notionalUsd: 100, feeUsd: 0.05, slippageUsd: 0.02, closedPnlUsd: 10 }, { ts: 2, notionalUsd: 200, feeUsd: 0.1, slippageUsd: 0.03, closedPnlUsd: -5 },
    { ts: 3, notionalUsd: 50, feeUsd: 0.025, slippageUsd: 0, closedPnlUsd: 3 }, { ts: 4, notionalUsd: 50, feeUsd: 0.025, slippageUsd: 0.01, closedPnlUsd: null }];
  const p = computePerformance({ equity, trades, funding: [{ ts: 1, amountUsd: -0.4 }, { ts: 2, amountUsd: 0.1 }] });

  it('returns, volatility, Sharpe, Sortino, drawdown', () => {
    expect(p.returns.map((r) => Number(r.toFixed(10)))).toEqual([0.1, -0.1, 0.1]);
    expect(p.periodsPerYear).toBe(8760);                                       // hourly points: 365 × 24
    // mean 1/30; sd (ddof 1) = √(0.08/3 / 2) = 0.11547005; √8760 = 93.594872
    expect(stdev([0.1, -0.1, 0.1])).toBeCloseTo(0.11547005, 8);
    expect(p.volatility.value).toBeCloseTo(10.80741, 4);                       // 0.11547005 × 93.594872
    expect(p.sharpe.value).toBeCloseTo(27.01851, 4);                           // (1/30) / 0.11547005 × 93.594872
    expect(p.sortino.value).toBeCloseTo(54.03703, 4);                          // downside deviation √(0.01/3) = 0.05773503
    expect(p.maxDrawdown.value).toBeCloseTo(0.1, 12);                          // 110 → 99
    expect(p.totalReturn.value).toBeCloseTo(0.089, 12);
    expect(p.netPnlUsd.value).toBeCloseTo(8.9, 10);
    expect(maxDrawdown([100, 120, 90, 130, 65])).toBe(0.5);
  });

  it('win rate, profit factor, turnover, fees, funding, slippage', () => {
    expect(p.closedTrades).toBe(3); expect(p.orders).toBe(4);
    expect(p.winRate.value).toBeCloseTo(2 / 3, 12);
    expect(p.profitFactor.value).toBeCloseTo(2.6, 12);                         // (10 + 3) / 5
    expect(p.turnover.value).toBeCloseTo(400 / 104.475, 10);                   // Σ notional / mean equity
    expect(p.feesUsd.value).toBeCloseTo(0.2, 12);
    expect(p.fundingUsd.value).toBeCloseTo(-0.3, 12);
    expect(p.slippageUsd.value).toBeCloseTo(0.06, 12);
  });

  it('small samples are flagged, and a figure that cannot be computed is null WITH its reason — never a zero', () => {
    expect(p.warnings.map((w) => w.code)).toEqual(['small_sample', 'few_trades']);
    expect(p.warnings[0]!.message).toContain(String(MIN_POINTS_FOR_RATIOS));
    const empty = computePerformance({ equity: [], trades: [], funding: [] });
    for (const k of ['totalReturn', 'volatility', 'sharpe', 'sortino', 'maxDrawdown', 'winRate', 'profitFactor', 'netPnlUsd'] as const) { expect(empty[k].value, k).toBeNull(); expect(empty[k].reason, k).toBeTruthy(); }
    const one = computePerformance({ equity: [{ ts: 0, equity: 100 }], trades: [], funding: [] });
    expect([one.sharpe.value, one.sharpe.reason]).toEqual([null, 'fewer than two returns']);
    const flat = computePerformance({ equity: [0, 1, 2, 3].map((i) => ({ ts: i * H, equity: 100 })), trades: [], funding: [] });
    expect([flat.sharpe.value, flat.sharpe.reason, flat.maxDrawdown.value]).toEqual([null, 'the returns do not vary', 0]);
    const noted = computePerformance({ equity, trades: [], funding: [], notes: { fees: 'not simulated', slippage: 'no reference price' } });
    expect([noted.feesUsd, noted.slippageUsd]).toEqual([{ value: null, reason: 'not simulated' }, { value: null, reason: 'no reference price' }]);
    // a stopped-and-restarted agent: uneven spacing is said, because the annualisation assumes evenly spaced points
    const gappy = computePerformance({ equity: [0, 1, 2, 3, 40].map((i) => ({ ts: i * H, equity: 100 + i })), trades: [], funding: [] });
    expect(gappy.warnings.map((w) => w.code)).toContain('irregular_sampling');
  });

  it('spot round trips at average cost', () => {
    const t = spotTrades([{ ts: 1, symbol: 'ETH', side: 'buy', units: 1, usd: 2000, expectedUsd: 2001 }, { ts: 2, symbol: 'ETH', side: 'buy', units: 1, usd: 3000, expectedUsd: null },
      { ts: 3, symbol: 'ETH', side: 'sell', units: 1, usd: 2800, expectedUsd: 2805 }, { ts: 4, symbol: 'BTC', side: 'sell', units: 0.01, usd: 900, expectedUsd: null }]);
    expect(t.map((x) => x.closedPnlUsd)).toEqual([null, null, 300, null]);     // sold 1 ETH at 2800 against an average cost of 2500; the BTC was never bought by the agent: no cost basis
    expect(t.map((x) => x.slippageUsd)).toEqual([1, null, 5, null]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ stream rules

const inst = (venue: string, symbol: string, o: Partial<Instrument> = {}): Instrument => ({ venue: venue as never, symbol, id: `${venue}:${symbol}`, base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '1', lotSize: '0.00001',
  minOrderSize: null, minNotional: '10', maxLeverage: '40', marginModes: ['cross'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active', ...o });
function view(venue: string, symbol: string, bid: number, ask: number, o: Partial<MarketView> & { size?: number; interval?: number; taker?: string } = {}): MarketView {
  const i = inst(venue, symbol, { fundingIntervalSec: o.interval ?? 3600 }), ts = o.bookTs ?? 1_000_000, size = String(o.size ?? 5);
  return { id: i.id, venue, symbol, instrument: i, bid, bidSize: Number(size), ask, askSize: Number(size), mark: (bid + ask) / 2, index: null, funding: '0', fundingIntervalSec: i.fundingIntervalSec, bookTs: ts, tickerTs: ts,
    book: { instrument: i.id, bids: [[String(bid), size]], asks: [[String(ask), size]], ts }, ticker: { instrument: i.id, mark: String((bid + ask) / 2), index: null, mid: null, funding: '0', openInterest: null, volume24h: null, change24h: null, ts },
    fees: { takerRate: o.taker ?? '0.00045', makerRate: '0.00015', source: 'test' }, ...o };
}
const MM = { quoteSizeUsd: 50, minHalfSpreadBps: 2, volMultiplier: 1.5, skewBps: 4, maxInventoryUsd: 250, volWindow: 30 };

describe('market making — spread and inventory quoting', () => {
  const v = view('hyperliquid', 'BTC', 99_990, 100_010);
  it('flat inventory, quiet market: the minimum half-spread on both sides of the mid, on the tick and the lot', () => {
    const q = mmQuotes(MM, v, [100_000, 100_000, 100_000, 100_000], 0);
    expect([q.mid, q.volBps, q.halfSpreadBps, q.skewBps]).toEqual([100_000, 0, 2, -0]);
    expect(q.bid).toEqual({ price: 99_980, size: 0.0005 });                     // 100 000 × (1 − 2 bps), 50 USD / 100 000
    expect(q.ask).toEqual({ price: 100_020, size: 0.0005 });
  });
  it('volatility widens the spread; inventory skews both quotes against itself', () => {
    const mids = [100_000, 100_100, 100_000, 100_100, 100_000];                 // ±10 bps moves
    expect(volBps(mids)).toBeGreaterThan(10);
    const wide = mmQuotes(MM, v, mids, 0);
    expect(wide.halfSpreadBps).toBeCloseTo(1.5 * volBps(mids), 10);
    expect(wide.bid!.price).toBeLessThan(99_980); expect(wide.ask!.price).toBeGreaterThan(100_020);
    // long 0.00125 BTC = 125 USD = half the limit → skew −2 bps: reservation price 99 980
    const long = mmQuotes(MM, v, [100_000, 100_000, 100_000], 0.00125);
    expect(long.skewBps).toBe(-2);
    expect([long.bid!.price, long.ask!.price]).toEqual([99_960, 100_000]);       // 99 980 × (1 ∓ 2 bps), bid rounded down, ask rounded up
  });
  it('at the inventory limit the side that would add to it is not quoted; a quote never crosses the book', () => {
    const full = mmQuotes(MM, v, [100_000, 100_000, 100_000], 0.0025);          // 250 USD long: the limit
    expect(full.bid).toBeNull(); expect(full.ask).not.toBeNull(); expect(full.notes.join()).toMatch(/long limit: no bid/);
    const short = mmQuotes(MM, v, [100_000, 100_000, 100_000], -0.0025);
    expect(short.ask).toBeNull(); expect(short.bid).not.toBeNull();
    // a very tight configured spread inside a wide market still never crosses
    const wideBook = view('hyperliquid', 'BTC', 99_000, 101_000);
    const q = mmQuotes({ ...MM, skewBps: 300 }, wideBook, [100_000, 100_000, 100_000], -0.0024);     // strongly short: the reservation price is pushed up, above the ask
    expect(q.bid!.price).toBeLessThan(wideBook.ask); expect(q.ask === null || q.ask.price > wideBook.bid).toBe(true);
    // below the venue's minimum notional nothing is quoted
    expect(mmQuotes({ ...MM, quoteSizeUsd: 5 }, v, [100_000, 100_000], 0).bid).toBeNull();
  });
  it('requote hysteresis: a quote is replaced only when it moved by more than the tolerance', () => {
    const cur: Quote = { id: 'q', side: 'buy', price: 99_980, size: 0.0005, ts: 0, instrument: v.id };
    expect([needsRequote(cur, { price: 99_981, size: 0.0005 }, 2), needsRequote(cur, { price: 99_950, size: 0.0005 }, 2), needsRequote(cur, null, 2), needsRequote(undefined, null, 2), needsRequote(undefined, { price: 1, size: 1 }, 2)])
      .toEqual([false, true, true, false, true]);
  });
});

describe('market making — the paper fill model (conservative, on real books)', () => {
  const bid: Quote = { id: 'b', side: 'buy', price: 99_980, size: 0.0005, ts: 10_000, instrument: 'hyperliquid:BTC' };
  const ask: Quote = { id: 'a', side: 'sell', price: 100_020, size: 0.0005, ts: 10_000, instrument: 'hyperliquid:BTC' };
  const book = (b: number, a: number, ts: number, size = 5) => ({ id: 'hyperliquid:BTC', bid: b, bidSize: size, ask: a, askSize: size, bookTs: ts });
  it('1 — never on the book the quote was priced from: it must have rested', () => {
    expect(mmFills([bid], book(99_900, 99_950, 10_500), 1000)).toEqual([]);     // traded through, but only 500 ms after the quote
    expect(mmFills([bid], book(99_900, 99_950, 11_000), 1000)).toHaveLength(1);
  });
  it('2 — a touch is not a fill: the market must trade THROUGH the quote', () => {
    expect(mmFills([bid, ask], book(99_970, 99_980, 20_000), 1000)).toEqual([]);                 // best ask = our bid: behind the queue
    expect(mmFills([bid, ask], book(100_020, 100_030, 20_000), 1000)).toEqual([]);               // best bid = our ask
    expect(mmFills([bid, ask], book(99_970, 99_979, 20_000), 1000).map((f) => f.quote.id)).toEqual(['b']);
    expect(mmFills([bid, ask], book(100_021, 100_030, 20_000), 1000).map((f) => f.quote.id)).toEqual(['a']);
  });
  it('3 — at OUR price, never better, and never more than what rested at the crossing best price', () => {
    const [f] = mmFills([bid], book(99_900, 99_950, 20_000, 0.0002), 1000);
    expect(f).toMatchObject({ price: 99_980, size: 0.0002 });
    expect(mmFills([bid], book(99_900, 99_950, 20_000, 0), 1000)).toEqual([]);
    expect(mmFills([{ ...bid, instrument: 'edgex:BTCUSD' }], book(99_900, 99_950, 20_000), 1000)).toEqual([]);   // another instrument's book fills nothing
  });
  it('the paper book: average cost, realised PnL on the closing part, maker fee on every fill, equity at the mark', () => {
    const b = newPaperBook(1000);
    applyFill(b, 'hyperliquid:BTC', 'buy', 0.001, 100_000, 0.00015);            // +0.001 @ 100 000, fee 0.015
    applyFill(b, 'hyperliquid:BTC', 'buy', 0.001, 102_000, 0.00015);            // avg 101 000, fee 0.0153
    expect(b.positions['hyperliquid:BTC']).toEqual({ size: 0.002, avgPrice: 101_000 });
    const r = applyFill(b, 'hyperliquid:BTC', 'sell', 0.003, 103_000, 0.00015); // closes 0.002 at +2 000 each = +4, flips to −0.001 @ 103 000
    expect(r.realized).toBeCloseTo(4, 10);
    expect(b.positions['hyperliquid:BTC']!.size).toBeCloseTo(-0.001, 12); expect(b.positions['hyperliquid:BTC']!.avgPrice).toBe(103_000);
    expect(b.fees).toBeCloseTo(0.015 + 0.0153 + 0.04635, 10);
    expect(b.turnover).toBeCloseTo(100 + 102 + 309, 10);
    // equity at mark 102 000: 1000 + 4 − fees + (−0.001 × (102 000 − 103 000) = +1)
    expect(paperEquity(b, { 'hyperliquid:BTC': 102_000 })).toBeCloseTo(1005 - b.fees, 10);
  });
});

describe('funding arbitrage — rates per HOUR with each venue\'s real interval, net of the fees of four legs', () => {
  it('normalises a rate per interval to basis points per hour', () => {
    expect(hourlyBps('0.0000125', 3600)).toBeCloseTo(0.125, 12);                // Hyperliquid: hourly
    expect(hourlyBps('0.0001', 28_800)).toBeCloseTo(0.125, 12);                 // an 8 h venue publishing 1 bp per interval
    expect(hourlyBps('0.00005', 14_400)).toBeCloseTo(0.125, 12);                // edgeX: 4 h
    expect([hourlyBps(null, 3600), hourlyBps('0.0001', 0)]).toEqual([null, null]);
  });
  const A = view('edgex', 'BTCUSD', 99_990, 100_010, { funding: '0.0004', interval: 28_800, taker: '0.00045' });     // 0.5 bps/h
  const B = view('hyperliquid', 'BTC', 99_995, 100_005, { funding: '0.0000125', interval: 3600, taker: '0.0005' });   // 0.125 bps/h
  it('holds when the carry over the horizon does not pay for the four legs', () => {
    const d = fundingDecision(A, B, { notionalUsd: '250', horizonHours: '24', minNetCarryBps: '5', exitNetCarryBps: '0' }, null);
    expect(d.action).toBe('hold'); expect(d.reasonCode).toBe('edge_below_threshold');
    expect(d.diffBpsPerHour).toBeCloseTo(0.375, 12); expect(d.grossCarryBps).toBeCloseTo(9, 10); expect(d.feesBps).toBeCloseTo(19, 10); expect(d.netCarryBps).toBeCloseTo(-10, 10);
    expect([d.shortVenue, d.longVenue]).toEqual(['edgex', 'hyperliquid']);
  });
  it('opens short where longs pay the most, long where they pay the least, when the net carry clears the threshold', () => {
    const d = fundingDecision(A, B, { notionalUsd: '250', horizonHours: '72', minNetCarryBps: '5', exitNetCarryBps: '0' }, null);
    expect(d.action).toBe('open'); expect(d.netCarryBps).toBeCloseTo(8, 10);    // 0.375 × 72 − 19
    expect(d.legs).toEqual([{ instrument: 'hyperliquid:BTC', side: 'buy', size: 0.00249, price: 100_005, reduceOnly: false }, { instrument: 'edgex:BTCUSD', side: 'sell', size: 0.00249, price: 99_990, reduceOnly: false }]);
  });
  it('closes when the carry of the HELD position falls below the exit level (the sign may have turned)', () => {
    const pair = { longInstrument: 'hyperliquid:BTC', shortInstrument: 'edgex:BTCUSD', sizeBase: 0.00249, openedAt: 0, entryGapBps: null, tag: 'funding_differential' };
    expect(fundingDecision(A, B, { notionalUsd: '250', horizonHours: '72', minNetCarryBps: '5', exitNetCarryBps: '0' }, pair).action).toBe('hold');
    const turned = fundingDecision({ ...A, funding: '-0.0004' }, B, { notionalUsd: '250', horizonHours: '72', minNetCarryBps: '5', exitNetCarryBps: '0' }, pair);
    expect(turned.action).toBe('close');
    expect(turned.legs).toEqual([{ instrument: 'hyperliquid:BTC', side: 'sell', size: 0.00249, price: 99_995, reduceOnly: true }, { instrument: 'edgex:BTCUSD', side: 'buy', size: 0.00249, price: 100_010, reduceOnly: true }]);
  });
  it('no published rate, or no reviewed fee schedule: no decision', () => {
    expect(fundingDecision({ ...A, funding: null }, B, { notionalUsd: '250', horizonHours: '72', minNetCarryBps: '5', exitNetCarryBps: '0' }, null)).toMatchObject({ action: 'hold', reasonCode: 'data_not_fresh' });
    expect(fundingDecision({ ...A, fees: null }, B, { notionalUsd: '250', horizonHours: '72', minNetCarryBps: '5', exitNetCarryBps: '0' }, null)).toMatchObject({ action: 'hold', reasonCode: 'data_not_fresh' });
  });
  it('paper funding: one settlement per interval boundary, with the published rate, never for intervals that were not observed', () => {
    const b = newPaperBook(1000);
    b.positions['hyperliquid:BTC'] = { size: -0.01, avgPrice: 100_000 };        // short: receives a positive rate
    const v = { ...view('hyperliquid', 'BTC', 99_990, 100_010), funding: '0.0001' };
    expect(accrueFunding(b, [v], 10 * H + 5)).toEqual([]);                      // first sight: the boundary is only remembered
    expect(accrueFunding(b, [v], 10 * H + 60_000)).toEqual([]);                 // same interval
    const s = accrueFunding(b, [v], 11 * H + 1);
    expect(s).toHaveLength(1); expect(s[0]!.amount).toBeCloseTo(0.01 * 100_000 * 0.0001, 12);   // +0.1 USD
    expect(accrueFunding(b, [v], 15 * H + 1)).toHaveLength(1);                  // four boundaries passed unobserved: ONE settlement, not four
    expect(b.funding).toBeCloseTo(0.2, 12);
  });
});

describe('cross-exchange — the gap net of costs (@spw/trading crossVenueDiscrepancy)', () => {
  const cfg = { notionalUsd: '250', horizonHours: '0', minNetEdgeBps: '5', exitGapBps: '1', maxDataAgeMs: 5000 };
  it('holds on a gap that fees eat', () => {
    const a = view('hyperliquid', 'BTC', 99_990, 100_000), b = view('edgex', 'BTCUSD', 100_005, 100_015);     // sell 100 005 − buy 100 000 = 0.5 bp gross
    const d = crossDecision(a, b, cfg, null, 1_000_000);
    expect(d.action).toBe('hold'); expect(d.reasonCode).toBe('edge_below_threshold');
    expect(Number(d.best.grossGapBps)).toBeCloseTo(0.5, 6); expect(Number(d.best.netEdgeEstimateBps)).toBeLessThan(0);
  });
  it('opens when the gap clears four legs of fees and the exit slippage: buys the cheap venue, sells the dear one', () => {
    const a = view('hyperliquid', 'BTC', 99_990, 100_000), b = view('edgex', 'BTCUSD', 100_400, 100_410);     // 40 bps gross
    const d = crossDecision(a, b, cfg, null, 1_000_000);
    expect(d.action).toBe('open');
    expect([d.best.longVenue, d.best.shortVenue]).toEqual(['hyperliquid', 'edgex']);
    expect(Number(d.best.grossGapBps)).toBeCloseTo(40, 4);
    expect(Number(d.best.netEdgeEstimateBps)).toBeGreaterThan(5); expect(Number(d.best.netEdgeEstimateBps)).toBeLessThan(Number(d.best.grossGapBps));
    expect(d.legs).toEqual([{ instrument: 'hyperliquid:BTC', side: 'buy', size: 0.0025, price: 100_000, reduceOnly: false }, { instrument: 'edgex:BTCUSD', side: 'sell', size: 0.0025, price: 100_400, reduceOnly: false }]);
    expect(d.best.assumptions.length).toBeGreaterThan(3); expect(d.best.risks.length).toBeGreaterThan(3);      // the estimate carries what it assumes
  });
  it('closes the held pair when the gap has converged; keeps it otherwise', () => {
    const pair = { longInstrument: 'hyperliquid:BTC', shortInstrument: 'edgex:BTCUSD', sizeBase: 0.0025, openedAt: 0, entryGapBps: 40, tag: 'net_spread' };
    const still = crossDecision(view('hyperliquid', 'BTC', 99_990, 100_000), view('edgex', 'BTCUSD', 100_200, 100_210), cfg, pair, 1_000_000);
    expect(still.action).toBe('hold');
    const conv = crossDecision(view('hyperliquid', 'BTC', 99_990, 100_000), view('edgex', 'BTCUSD', 100_000, 100_010), cfg, pair, 1_000_000);
    expect(conv.action).toBe('close');
    expect(conv.legs).toEqual([{ instrument: 'hyperliquid:BTC', side: 'sell', size: 0.0025, price: 99_990, reduceOnly: true }, { instrument: 'edgex:BTCUSD', side: 'buy', size: 0.0025, price: 100_010, reduceOnly: true }]);
  });
  it('a stale book on one venue is not an estimate: no decision', () => {
    const d = crossDecision(view('hyperliquid', 'BTC', 99_990, 100_000), view('edgex', 'BTCUSD', 100_400, 100_410, { bookTs: 1_000_000 - 60_000 }), cfg, null, 1_000_000);
    expect(d.action).toBe('hold'); expect(d.reasonCode).toBe('data_not_fresh'); expect(d.reason).toMatch(/ms old/);
  });
});

// ------------------------------------------------------------------------------------------------------------------ risk supervisor

const LIM: SupervisorLimits = { maxGrossUsd: 5000, maxAgentDrawdownPct: 8, maxPortfolioDailyLossPct: 4, minLiquidationDistanceBps: 800, maxFundingBleedBpsPerDay: 15, killSwitchDailyLossPct: 10 };
const snap = (o: Partial<AgentSnapshot> & { agentId: string }): AgentSnapshot => ({ name: o.agentId, mode: 'paper', lifecycle: 'active', capitalUsd: 1000, equityUsd: 1000, peakEquityUsd: 1000, dayStartEquityUsd: 1000, grossUsd: 0, minLiquidationDistanceBps: null, funding24hUsd: 0, unreadable: null, ...o });

describe('risk supervisor — findings, per mode', () => {
  it('nothing to say about a healthy portfolio', () => { expect(evaluatePortfolio('paper', [snap({ agentId: 'a' }), snap({ agentId: 'b', mode: 'live' })], LIM)).toEqual([]); });
  it('drawdown → pause; liquidation distance and funding bleed → REDUCE (a proposal: the supervisor places no order)', () => {
    const f = evaluatePortfolio('paper', [snap({ agentId: 'dd', equityUsd: 900, peakEquityUsd: 1000 }), snap({ agentId: 'liq', minLiquidationDistanceBps: 300, grossUsd: 800 }), snap({ agentId: 'bleed', funding24hUsd: -2 }), snap({ agentId: 'fine', funding24hUsd: 5 })], LIM);
    expect(f.map((x) => [x.agentId, x.action, x.code])).toEqual([['dd', 'pause', 'agent_drawdown'], ['liq', 'reduce', 'liquidation_distance'], ['bleed', 'reduce', 'funding_bleed']]);
    expect(f[0]!.metrics.drawdownPct).toBeCloseTo(10, 10); expect(f[2]!.metrics.fundingBleedBps).toBeCloseTo(20, 10);
    expect(f.every((x) => x.mode === 'paper' && x.key.startsWith('paper|'))).toBe(true);
  });
  it('paper and live are judged SEPARATELY: a paper exposure never counts against the live limit, nor a paper loss against the live kill level', () => {
    const agents = [snap({ agentId: 'p1', grossUsd: 4000 }), snap({ agentId: 'p2', grossUsd: 3000 }), snap({ agentId: 'l1', mode: 'live', grossUsd: 2000 }), snap({ agentId: 'p3', equityUsd: 500, dayStartEquityUsd: 1000, peakEquityUsd: 500 })];
    expect(evaluatePortfolio('live', agents, LIM)).toEqual([]);                  // 2 000 USD live, under 5 000; no live loss
    const paper = evaluatePortfolio('paper', agents, LIM);
    expect(paper.find((x) => x.code === 'gross_exposure')).toMatchObject({ agentId: 'p1', action: 'reduce', metrics: { grossUsd: 7000 } });
    // paper lost 500 of 3000 today (16.7 %): every active paper agent is proposed a pause — and never the kill switch, which is for LIVE losses
    expect(paper.filter((x) => x.code === 'portfolio_daily_loss').map((x) => x.agentId).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(paper.some((x) => x.action === 'kill_switch')).toBe(false);
  });
  it('a LIVE loss at the kill level → kill switch; below it → pause; an unreadable live account → pause', () => {
    const big = evaluatePortfolio('live', [snap({ agentId: 'l1', mode: 'live', equityUsd: 880, dayStartEquityUsd: 1000, peakEquityUsd: 880 })], LIM);
    expect(big.map((x) => [x.agentId, x.action, x.code])).toEqual([[null, 'kill_switch', 'portfolio_daily_loss_kill']]);
    const mid = evaluatePortfolio('live', [snap({ agentId: 'l1', mode: 'live', equityUsd: 950, dayStartEquityUsd: 1000, peakEquityUsd: 950 })], LIM);
    expect(mid.map((x) => [x.agentId, x.action])).toEqual([['l1', 'pause']]);
    expect(evaluatePortfolio('live', [snap({ agentId: 'l2', mode: 'live', unreadable: 'venue 503' })], LIM).map((x) => x.code)).toEqual(['account_unreadable']);
    expect(evaluatePortfolio('paper', [snap({ agentId: 'p', unreadable: 'x' })], LIM)).toEqual([]);
    expect(evaluatePortfolio('paper', [snap({ agentId: 's', lifecycle: 'stopped', equityUsd: 1, peakEquityUsd: 1000 })], LIM)).toEqual([]);   // a stopped agent is not supervised
  });
});

function ports(agents: AgentSnapshot[], o: { pauseFails?: boolean } = {}) {
  const log = { paused: [] as string[], kills: [] as string[], proposals: [] as { f: Finding; acted: string; note: string }[] };
  let t = 1_000_000;
  const p: SupervisorPorts = { now: () => t, snapshots: async () => agents, propose: async (f, acted, note) => { log.proposals.push({ f, acted, note }); },
    pause: async (id) => { if (o.pauseFails) throw new Error('signer unreachable'); log.paused.push(id); }, killSwitch: { engage: async (reason) => { log.kills.push(reason); return { engaged: true, at: t, already: log.kills.length > 1 }; } } };
  return { p, log, advance: (ms: number) => { t += ms; } };
}

describe('risk supervisor — proposals, and its two permitted actions', () => {
  // drawdowns from the peak WITHOUT a loss of the day (the day started at today's equity): only the per-agent finding fires
  const bad = [snap({ agentId: 'paperDD', equityUsd: 900, dayStartEquityUsd: 900 }), snap({ agentId: 'liveDD', mode: 'live', equityUsd: 900, dayStartEquityUsd: 905 }), snap({ agentId: 'liq', minLiquidationDistanceBps: 100 })];
  it('research mode, or acting switched off: it proposes and changes nothing', async () => {
    for (const own of [{ mode: 'research' as const, act: true }, { mode: 'live' as const, act: false }]) {
      const { p, log } = ports(bad);
      const r = await supervise({ ...own, limits: LIM }, {}, p);
      expect(r.findings.map((f) => f.code).sort()).toEqual(['agent_drawdown', 'agent_drawdown', 'liquidation_distance']);
      expect([log.paused, log.kills]).toEqual([[], []]);
      expect(log.proposals).toHaveLength(3);
      expect(log.proposals.filter((x) => x.f.action === 'pause').every((x) => x.acted === 'not_allowed')).toBe(true);
    }
  });
  it('paper mode: pauses PAPER agents only — a live agent is proposed, not touched; a reduction is never an action', async () => {
    const { p, log } = ports(bad);
    const r = await supervise({ mode: 'paper', act: true, limits: LIM }, {}, p);
    expect(log.paused).toEqual(['paperDD']); expect(log.kills).toEqual([]);
    const by = Object.fromEntries(log.proposals.map((x) => [x.f.agentId, x.acted]));
    expect(by).toEqual({ paperDD: 'paused', liveDD: 'not_allowed', liq: 'proposed' });
    expect(log.proposals.find((x) => x.f.agentId === 'liq')!.note).toMatch(/places no order/);
    expect(r.actions.filter((a) => a.action === 'paused')).toHaveLength(1);
  });
  it('live mode: pauses paper and live agents and engages the kill switch — its only two actions', async () => {
    const { p, log } = ports([...bad, snap({ agentId: 'l2', mode: 'live', equityUsd: 500, dayStartEquityUsd: 1000, peakEquityUsd: 500 })]);
    await supervise({ mode: 'live', act: true, limits: LIM }, {}, p);
    expect(log.paused.sort()).toEqual(['liveDD', 'paperDD']);
    expect(log.kills).toHaveLength(1); expect(log.kills[0]).toMatch(/kill-switch level/);
    expect(log.proposals.find((x) => x.f.action === 'kill_switch')!.acted).toBe('kill_switch');
  });
  it('says a thing once: no repeat while the condition lasts, again after an hour, and again if it comes back', async () => {
    const { p, log, advance } = ports([snap({ agentId: 'paperDD', equityUsd: 900, dayStartEquityUsd: 900 })]);
    let st = (await supervise({ mode: 'paper', act: true, limits: LIM }, {}, p)).state;
    st = (await supervise({ mode: 'paper', act: true, limits: LIM }, st, p)).state;
    expect([log.proposals.length, log.paused.length]).toEqual([1, 1]);
    advance(3_600_001);
    st = (await supervise({ mode: 'paper', act: true, limits: LIM }, st, p)).state;
    expect(log.proposals.length).toBe(2);
    const gone = ports([snap({ agentId: 'paperDD' })]);
    st = (await supervise({ mode: 'paper', act: true, limits: LIM }, st, gone.p)).state;
    expect(st.announced).toEqual({});
  });
  it('a failed action is reported as failed, never as done', async () => {
    const { p, log } = ports([snap({ agentId: 'paperDD', equityUsd: 900, dayStartEquityUsd: 900 })], { pauseFails: true });
    const r = await supervise({ mode: 'paper', act: true, limits: LIM }, {}, p);
    expect(r.actions).toEqual([{ key: 'paper|paperDD|agent_drawdown', action: 'failed', ok: false, note: 'the action failed: signer unreachable' }]);
    expect(log.proposals[0]!.acted).toBe('failed');
  });
  it('the ports it is given have nothing that starts, resumes, orders, releases or approves', () => {
    const { p } = ports([]);
    expect(Object.keys(p).sort()).toEqual(['killSwitch', 'now', 'pause', 'propose', 'snapshots']);
    expect(Object.keys(p.killSwitch)).toEqual(['engage']);
  });
});

// ------------------------------------------------------------------------------------------------------------------ module boundaries

const SRC = path.join(REPO_ROOT, 'services/api/src');
const files = (dir: string): string[] => readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith('.ts')).map((f) => path.join(dir, f));
const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8');
/** every module specifier a file imports, statically or dynamically */
const imports = (src: string): string[] => [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
/** the code of a file without its comments (a comment may NAME a function it must not call) */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');

describe('module boundaries — an agent cannot create, widen or approve its own mandate', () => {
  const runtime = files('agent-runtime');
  const engines = ['engine.ts', 'live.ts', 'perp-engine.ts', 'perp-live.ts', 'perp-exec.ts', 'perp-exec-live.ts', 'perp-gateway.ts', 'spot-seam.ts', 'perp-signal.ts', 'perp-data.ts', 'lifecycle.ts', 'runtime-bindings.ts', 'templates.ts', 'trading-handlers.ts', 'runtime-routes.ts',
    'strategies.ts', 'perp-strategies.ts', 'lab.ts', 'perp-live-cycle.ts'].map((f) => path.join('agents', f));

  it('the agent runtime, the engines, the life cycle and the trading-API handlers import nothing from the mandate-writing module', () => {
    expect(runtime.length).toBeGreaterThan(10);
    for (const f of [...runtime, ...engines]) {
      const bad = imports(read(f)).filter((s) => /mandate-write/.test(s) || /(^|\/)mandates\//.test(s));
      expect(bad, `${f} imports ${bad.join(', ')}`).toEqual([]);
    }
  });
  it('the mandate-writing module is imported by the two owner route files and by nothing else', () => {
    const users = [...files('agents'), ...files('agent-runtime'), ...files('trading-api'), 'main.ts', 'agent-worker-main.ts', 'server.ts'].filter((f) => imports(read(f)).some((s) => /mandate-write/.test(s)));
    expect(users.sort()).toEqual(['agents/perp-routes.ts', 'agents/routes.ts']);
  });
  it('only the mandate-writing module calls the signer\'s approval (spot) and the live module\'s prepare / approve (derivative)', () => {
    const calls = /\b(mandateApprove|approveMandate|prepareMandate)\s*\(/;
    const callers = [...files('agents'), ...files('agent-runtime')].filter((f) => calls.test(code(read(f))));
    expect(callers).toEqual(['agents/mandate-write.ts']);
  });
  it('the agent runtime never reaches the signer client, and only its admin module can release the kill switch', () => {
    for (const f of runtime) expect(imports(read(f)).filter((s) => /signer-client/.test(s)), f).toEqual([]);
    const releasers = [...files('agents'), ...files('agent-runtime')].filter((f) => /releaseKillSwitch/.test(code(read(f))));
    expect(releasers.sort()).toEqual(['agent-runtime/kill-switch-admin.ts', 'agents/runtime-routes.ts']);
    // the supervisor module itself: types of the kill switch port and of the model, nothing else
    expect(imports(read('agent-runtime/risk-supervisor.ts')).sort()).toEqual(['./kill-switch.ts', './model.ts']);
    expect(/import type \{ KillSwitchPort \}/.test(read('agent-runtime/risk-supervisor.ts'))).toBe(true);
  });
  it('the engines place orders through the gateway only: no direct call of an executor\'s place() or of the paper service outside the seams', () => {
    for (const f of ['agents/engine.ts', 'agents/perp-engine.ts', 'agent-runtime/stream-engine.ts']) {
      const c = code(read(f));
      expect(/\.submit\(/.test(c) || /ex\.place\(/.test(c), f).toBe(true);
      expect(/placeMandateOrder|paper\.order\(|signer\.|mandateSign/.test(c), f).toBe(false);
    }
    // the perp engine's `ex` IS the gateway executor
    expect(read('agents/perp-engine.ts')).toMatch(/const ex = gatewayExecutor\(a, d\.executor\(a\), d\)/);
    expect(read('agents/perp-engine.ts')).toMatch(/ex = gatewayExecutor\(a, inner, d\)/);
    expect(code(read('agents/engine.ts'))).not.toMatch(/d\.placeLive\(/);        // only the spot seam calls it
  });
});

describe('mode separation — the SQL of the read model', () => {
  const SHARED = ['agent_equity', 'agent_signals', 'research_log', 'agent_orders', 'agent_order_intents'];
  /** every `select … from <shared table>` inside a sql`…` template of a file */
  function reads(rel: string): string[] {
    const out: string[] = [];
    for (const m of read(rel).matchAll(/sql(?:<[^`]*?>)?`([^`]*)`/g)) {
      const q = m[1]!;
      // a template may hold several statements / sub-selects: judge each `from <table> … ` segment up to the next `from` of a shared table
      for (const t of SHARED) for (const seg of q.split(new RegExp(`\\bfrom ${t}\\b`)).slice(1)) out.push(`${t}: ${seg.split(/\bfrom (?:agent_equity|agent_signals|research_log|agent_orders|agent_order_intents)\b/)[0]!.trim().slice(0, 400)}`);
    }
    return out;
  }
  const READ_MODEL = ['agent-runtime/store.ts', 'agent-runtime/scheduler.ts', 'agents/routes.ts', 'agents/perp-routes.ts', 'agents/runtime-routes.ts', 'agents/runtime-bindings.ts', 'agents/perp-live-cycle.ts', 'agents/engine.ts', 'agents/perp-engine.ts', 'agents/live.ts'];
  it('every read of a table shared by paper and live names the mode', () => {
    let n = 0;
    for (const f of READ_MODEL) for (const r of reads(f)) {
      n += 1;
      expect(/\bmode = \$\{|\bmode = '(PAPER|LIVE)'/.test(r), `${f}: a read without a mode filter → ${r}`).toBe(true);
    }
    expect(n).toBeGreaterThan(15);                                             // the scan really found the queries
  });
  it('the performance path reads ONE mode: equity, fills and funding of that mode\'s account, and no query takes two modes', () => {
    const src = read('agent-runtime/store.ts');
    const fn = src.slice(src.indexOf('export async function performanceInput'), src.indexOf('export interface PerformanceView'));
    expect(fn).toMatch(/from agent_equity where agent_id = \$\{a\.id\} and mode = \$\{m\}/);
    expect(fn).toMatch(/from agent_orders where agent_id = \$\{a\.id\} and mode = \$\{m\}/);
    expect(fn).toMatch(/const acct = perpAccount\(a, mode\)/);                  // perp fills and funding come from the account of that mode
    expect(fn).not.toMatch(/mode in \(|mode <> |mode != /);
    expect(src).not.toMatch(/from agent_equity[^`]*mode in \(/);
    // the answer names its mode, and research has no performance of its own
    expect(src).toMatch(/label: mode === 'paper' \? 'PAPER — simulated/);
  });
});

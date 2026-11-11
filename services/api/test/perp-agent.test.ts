// Perp agents (V6, paper only). Three layers, no network, no signer:
//  1. the pure parts of the engine (weights, scaling, targets, order plan, gate checks);
//  2. the engine step against PostgreSQL (database spw_perp_agent_test, created here if missing) with a FAKE executor, gate and
//     signal: one decision per bar, holds, restart idempotency, loss limits, account events;
//  3. the real thing end to end on fixture-backed venue adapters: routes, the bar store and its gate, the paper executor on a
//     real paper account (risk engine + paper engine), and the laboratory's refusal to mix spot and perp strategies.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D, type Dec, type Instrument, type OrderRequest, type Position } from '@spw/derivatives';
import { BTC, Clock, T0, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

type Eng = typeof import('../src/agents/perp-engine.ts');
let sql: any, eng: Eng, pd: typeof import('../src/agents/perp-data.ts'), ps: typeof import('../src/agents/perp-strategies.ts'), pl: typeof import('../src/agents/perp-live.ts');
let mod: typeof import('../src/derivatives/index.ts'), wk: typeof import('../src/derivatives/worker.ts');

beforeAll(async () => {
  await useDatabase('spw_perp_agent_test');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate(); await db.migrate();
  eng = await import('../src/agents/perp-engine.ts'); pd = await import('../src/agents/perp-data.ts'); ps = await import('../src/agents/perp-strategies.ts'); pl = await import('../src/agents/perp-live.ts');
  mod = await import('../src/derivatives/index.ts'); wk = await import('../src/derivatives/worker.ts');
});
afterAll(async () => { await sql?.end(); });

const d = (x: string): Dec => D.from(x);
const RISK = { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };
const META = { max_leverage: 2, max_gross_exposure: 2 };
const strs = (o: Record<string, Dec>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, D.str(v)]));

describe('perp engine: signed weights', () => {
  it('accepts signed weights inside the META bounds pinned at registration, and nothing else', () => {
    const ok = eng.checkPerpWeights({ weights: { BTC: 0.5, ETH: -0.4 }, maxLeverage: 2, maxGrossExposure: 2 }, ['BTC', 'ETH', 'SOL'], META);
    expect(strs(ok)).toEqual({ BTC: '0.5', ETH: '-0.4', SOL: '0' });
    const bad: unknown[] = [null, { weights: [], maxLeverage: 2, maxGrossExposure: 2 }, { weights: { DOGE: 0.1 }, maxLeverage: 2, maxGrossExposure: 2 }, { weights: { BTC: 2.5 }, maxLeverage: 2, maxGrossExposure: 2 },
      { weights: { BTC: -2.5 }, maxLeverage: 2, maxGrossExposure: 2 }, { weights: { BTC: 1.5, ETH: -1.5 }, maxLeverage: 2, maxGrossExposure: 2 }, { weights: { BTC: NaN }, maxLeverage: 2, maxGrossExposure: 2 },
      { weights: { BTC: '0.5' }, maxLeverage: 2, maxGrossExposure: 2 }, { weights: { BTC: 0.5 }, maxLeverage: 5, maxGrossExposure: 2 }, { weights: { BTC: 0.5 } }];
    for (const b of bad) expect(() => eng.checkPerpWeights(b, ['BTC', 'ETH', 'SOL'], META)).toThrow();
  });

  it('scales every weight by ONE factor ≤ 1 to the owner\'s caps, and never up', () => {
    const eq = d('10000'), cap = d('10000');
    // inside every cap: untouched
    const a = eng.scalePerpWeights({ BTC: d('0.5'), ETH: d('-0.4') }, eq, cap, RISK);
    expect([D.str(a.factor), a.binding, strs(a.scaled)]).toEqual(['1', 'none', { BTC: '0.5', ETH: '-0.4' }]);
    // tiny weights are not raised to the caps
    expect(D.str(eng.scalePerpWeights({ BTC: d('0.01'), ETH: d('0') }, eq, cap, RISK).factor)).toBe('1');
    // gross 4 × equity = 40 000 against: leverage 2 × 10 000 × 0.9 = 18 000, gross 1.5 × 10 000 × 0.977 = 14 655, position 9 770 (wanted 20 000)
    const b = eng.scalePerpWeights({ BTC: d('2'), ETH: d('-2') }, eq, cap, RISK);
    expect([D.str(b.factor), b.binding, strs(b.scaled)]).toEqual(['0.366375', 'gross', { BTC: '0.73275', ETH: '-0.73275' }]);
    // the leverage cap binds on a shrunken equity (2 × 3 000 × 0.9 = 5 400 against 0.9 × 2 × 3 000... wanted 6 000)
    const c = eng.scalePerpWeights({ BTC: d('1'), ETH: d('-1') }, d('3000'), cap, RISK);
    expect([D.str(c.factor), c.binding]).toEqual(['0.9', 'leverage']);
    // one instrument above the per-instrument cap pulls ALL weights down by the same factor (proportions kept)
    const e = eng.scalePerpWeights({ BTC: d('1.2'), ETH: d('-0.2') }, eq, cap, RISK);
    expect(e.binding).toBe('position');
    expect(D.str(D.div(e.scaled.BTC!, e.scaled.ETH!, 6, 'half_even'))).toBe('-6');
    expect(D.lte(D.mul(e.scaled.BTC!, eq), d('9770'))).toBe(true);
    // no equity: nothing is targeted
    expect(strs(eng.scalePerpWeights({ BTC: d('1') }, d('0'), cap, RISK).scaled)).toEqual({ BTC: '0' });
  });

  it('computes target sizes in base units from equity and mark, exactly, truncated to the lot', () => {
    expect(D.str(eng.targetSize(d('0.5'), d('10000'), d('50000'), d('0.00001')))).toBe('0.1');
    expect(D.str(eng.targetSize(d('-0.4'), d('10000'), d('2500'), d('0.0001')))).toBe('-1.6');
    // 0.33 × 9 876.54 / 103 456.7 = 0.031504… → truncated toward zero on the lot, short or long
    expect(D.str(eng.targetSize(d('0.33'), d('9876.54'), d('103456.7'), d('0.00001')))).toBe('0.0315');
    expect(D.str(eng.targetSize(d('-0.33'), d('9876.54'), d('103456.7'), d('0.001')))).toBe('-0.031');
    expect(D.str(eng.targetSize(d('0.5'), d('10000'), d('0'), d('0.001')))).toBe('0');
    // exact where floats are not: 0.1 + 0.2 style inputs
    expect(D.str(eng.targetSize(d('0.3'), d('0.3'), d('0.1'), d('0.0000000001')))).toBe('0.9');
  });
});

describe('perp engine: order plan', () => {
  const marks = { BTC: d('50000'), ETH: d('2500'), SOL: d('100') }, min = { BTC: d('10'), ETH: d('10'), SOL: d('10') }, thr = d('200');
  const plan = (t: Record<string, string>, c: Record<string, string>) => eng.planPerpOrders(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, d(v)])), Object.fromEntries(Object.entries(c).map(([k, v]) => [k, d(v)])), marks, min, thr)
    .map((o) => `${o.phase} ${o.symbol} ${o.side} ${o.size}${o.reduceOnly ? ' RO' : ''}${o.afterClose ? ' after-close' : ''}`);

  it('orders are the deltas; every reducing order comes before every opening one (margin is freed first)', () => {
    // BTC long 0.2 → 0.05 (reduce 7 500), ETH flat → short 1.6 (open 4 000), SOL long 30 → 60 (increase 3 000)
    expect(plan({ BTC: '0.05', ETH: '-1.6', SOL: '60' }, { BTC: '0.2', SOL: '30' })).toEqual(['reduce BTC sell 0.15 RO', 'open ETH sell 1.6', 'open SOL buy 30']);
    // the small reduce still goes before the large open
    expect(plan({ BTC: '1', SOL: '25' }, { SOL: '30' })).toEqual(['reduce SOL sell 5 RO', 'open BTC buy 1']);
  });

  it('a flip long → short is a reduce-only close of the whole position, THEN an open — never one crossing order', () => {
    expect(plan({ BTC: '-0.1' }, { BTC: '0.2' })).toEqual(['reduce BTC sell 0.2 RO', 'open BTC sell 0.1 after-close']);
    expect(plan({ ETH: '2' }, { ETH: '-1' })).toEqual(['reduce ETH buy 1 RO', 'open ETH buy 2 after-close']);
    // two flips and an increase: both closes first (largest first), then the opens
    expect(plan({ BTC: '-0.1', ETH: '2', SOL: '40' }, { BTC: '0.2', ETH: '-1', SOL: '30' })).toEqual(['reduce BTC sell 0.2 RO', 'reduce ETH buy 1 RO', 'open BTC sell 0.1 after-close', 'open ETH buy 2 after-close', 'open SOL buy 10']);
  });

  it('a rebalance below the threshold is not traded; a full exit always is', () => {
    expect(plan({ BTC: '0.203' }, { BTC: '0.2' })).toEqual([]);                    // 150 USD < 200
    expect(plan({ BTC: '0.197' }, { BTC: '0.2' })).toEqual([]);
    expect(plan({ BTC: '0' }, { BTC: '0.001' })).toEqual(['reduce BTC sell 0.001 RO']);   // 50 USD, but an exit
    expect(plan({ SOL: '-1' }, { SOL: '1' })).toEqual(['reduce SOL sell 1 RO']);    // the flip closes; the 100 USD open is below the threshold
    expect(plan({ BTC: '0.2' }, { BTC: '0.2' })).toEqual([]);
    // the venue's minimum notional (10 USD, with a 5 % margin) also applies when the threshold is lower
    expect(eng.planPerpOrders({ SOL: d('0.1') }, {}, marks, min, d('1'))).toEqual([]);
    expect(eng.planPerpOrders({ SOL: d('0.11') }, {}, marks, min, d('1'))).toHaveLength(1);
  });

  it('the owner\'s limits become the account\'s risk policy, in USDC', () => {
    expect(eng.perpPolicy(['BTC', 'ETH'], '2000', RISK)).toEqual({ mode: 'PAPER', allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], halt: null, maxDataAgeMs: 10_000, maxDeviationBps: '200', maxMarkIndexBps: '100',
      maxLeverage: '2', maxOrderNotional: '2000', maxGrossExposure: '3000', maxPositionNotional: '2000', minFreeCollateral: '100', minLiquidationDistanceBps: '1000', maxDailyLoss: '60', maxTotalLoss: '200',
      maxOrdersPerMinute: 40, maxOrdersPerDay: 400 });
  });

  it('loss limits: total against the capital, daily against the equity at the start of the day', () => {
    expect(eng.lossBreach(d('9100'), d('10000'), d('9100'), RISK)).toBeNull();
    expect(eng.lossBreach(d('9000'), d('10000'), d('9000'), RISK)).toMatch(/total loss limit/);
    expect(eng.lossBreach(d('9900'), d('10000'), d('10200'), RISK)).toMatch(/daily loss limit/);
    expect(eng.lossBreach(d('10500'), d('10000'), d('10700'), RISK)).toBeNull();
  });
});

describe('perp data gate (pure checks)', () => {
  const H = 3_600_000, t0 = Math.floor(T0 / H) * H;          // T0 = 03:05:30 → the last closed bar opens at 02:00
  const series = (n = 6) => {
    const bars = Array.from({ length: n }, (_, i) => ({ ts: t0 - (n - i) * H, open: 100 + i, high: 103 + i, low: 99 + i, close: 101 + i, volume: 5 }));
    return { bars, funding: bars.map((b) => ({ ts: b.ts, rate: 0.0000125, premium: null })), lastClose: String(bars[n - 1]!.close) };
  };
  const check = (s: ReturnType<typeof series>, lookback = 6, now = T0) => pd.checkSeries('BTC', s, { interval: '1h', lookback, now });
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  it('passes on the latest closed bar with a gap-free lookback and aligned funding', () => { expect(check(series())).toBe(t0 - H); });
  it('fails closed on anything else', () => {
    expect(code(() => check(series(), 7))).toBe('history');
    expect(code(() => check(series(), 6, T0 + H))).toBe('stale');                                       // an hour later the newest closed bar is missing
    const gap = series(); gap.bars.splice(2, 1); gap.bars.unshift({ ...gap.bars[0]!, ts: gap.bars[0]!.ts - H });
    expect(code(() => check(gap))).toBe('gap');
    const open = series(); open.bars.push({ ...open.bars[5]!, ts: t0 });
    expect(code(() => check(open))).toBe('unclosed');
    const bad = series(); bad.bars[3]!.low = 200;
    expect(code(() => check(bad))).toBe('bad_bar');
    const noLast = series(); noLast.funding.pop();
    expect(code(() => check(noLast))).toBe('funding_stale');                                            // the settlement of the decision bar's open is not there
    const two = series(); two.funding.splice(1, 2);
    expect(code(() => check(two))).toBe('funding_gap');
    const one = series(); one.funding.splice(2, 1);
    expect(code(() => check(one))).toBe('ok');                                                          // one isolated settlement missing is tolerated (and stated)
    const future = series(); future.funding.push({ ts: t0, rate: 0.1, premium: null });
    expect(code(() => check(future))).toBe('future_funding');                                           // a rate settled after the decision bar is never an input
  });
  it('cross-checks the live mark against the venue\'s spot index, or the spot market when there is no index', () => {
    const tk = (o: Record<string, unknown>) => ({ instrument: BTC, mark: '100', index: '100', mid: '100', funding: '0', openInterest: null, volume24h: null, change24h: null, ts: T0, ...o }) as never;
    const run = (o: Record<string, unknown>, last: string | null = '100', spot: string | null = null) => code(() => pd.checkMark('BTC', tk(o), last, spot, T0));
    expect(run({})).toBe('ok');
    expect(run({ mark: '100.9' })).toBe('ok');
    expect(run({ mark: '101.1' })).toBe('mark_index');                                                  // band: 100 bps
    expect(run({ ts: T0 - 20_000 })).toBe('stale_ticker');
    expect(run({ index: null })).toBe('no_reference');
    expect(run({ index: null }, '100', '102')).toBe('ok');
    expect(run({ index: null }, '100', '104')).toBe('mark_spot');                                       // band: 300 bps
    expect(run({}, '80')).toBe('last_close');                                                           // the stored series is not this market's
    expect(run({ mark: '0' })).toBe('bad_mark');
  });
});

describe('strategy kinds never cross', () => {
  it('fit: same instruments, same interval, no spot legs', () => {
    const info = { spotLegs: false, meta: { name: 'x', version: '1', kind: 'perp' as const, universe: ['BTC', 'ETH'], interval: '1h', lookback: 10, max_leverage: 2, max_gross_exposure: 2, params: {} } };
    expect(ps.fitsPerpAgent(info, ['ETH', 'BTC'], '1h')).toEqual({ ok: true });
    expect(ps.fitsPerpAgent(info, ['BTC'], '1h')).toMatchObject({ ok: false, code: 'universe_mismatch' });
    expect(ps.fitsPerpAgent(info, ['BTC', 'ETH'], '4h')).toMatchObject({ ok: false, code: 'interval_mismatch' });
    expect(ps.fitsPerpAgent({ ...info, spotLegs: true }, ['BTC', 'ETH'], '1h')).toMatchObject({ ok: false, code: 'spot_leg_unsupported' });
  });
  it('a report is approvable only as a version-2 report for this hash and these instruments with its integrity checks passing', () => {
    const good = { schema_version: 2, kind: 'perp', strategy_sha256: 'a'.repeat(64), config: { symbols: ['BTC'] }, checks: { lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass', data_quality: 'fail' } };
    expect(ps.perpReportProblem(good, 'a'.repeat(64), ['BTC'])).toBeNull();
    expect(ps.perpReportProblem({ ...good, schema_version: 1 }, 'a'.repeat(64), ['BTC'])).toMatch(/version-2/);
    expect(ps.perpReportProblem({ ...good, kind: undefined }, 'a'.repeat(64), ['BTC'])).toMatch(/version-2/);
    expect(ps.perpReportProblem(good, 'b'.repeat(64), ['BTC'])).toMatch(/another code hash/);
    expect(ps.perpReportProblem(good, 'a'.repeat(64), ['BTC', 'ETH'])).toMatch(/other instruments/);
    expect(ps.perpReportProblem({ ...good, checks: { ...good.checks, lookahead: 'fail' } }, 'a'.repeat(64), ['BTC'])).toMatch(/lookahead/);
  });
  it('the laboratory itself refuses the wrong contract: describe and signal, both ways', async () => {
    const spot = await import('../src/agents/strategies.ts'), live = await import('../src/agents/live.ts'), sig = await import('../src/agents/perp-signal.ts');
    // spot listing path (no --contract 2): a perp strategy is "not loadable: not offered"
    await expect(spot.describe('ts_momentum_perp/1')).rejects.toMatchObject({ code: 'bad_strategy' });
    // perp listing path: a spot strategy is refused, a perp one is described with its bounds
    await expect(ps.describePerp('ts_momentum/3')).rejects.toMatchObject({ code: 'wrong_kind' });
    const p = await ps.describePerp('pairs_coint_perp/1');
    expect(p).toMatchObject({ kind: 'perp', spotLegs: false, meta: { kind: 'perp', universe: ['BTC', 'ETH'], interval: '1h', max_leverage: 2 } });
    expect((await ps.describePerp('funding_carry_neutral_perp/1')).spotLegs).toBe(true);
    // signal runners: the spot runner on a perp strategy, the perp runner on a spot strategy — both fail before any weight is read
    const H = 3_600_000, t0 = Math.floor(T0 / H) * H, bars = Array.from({ length: 400 }, (_, i) => ({ ts: t0 - (400 - i) * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    await expect(live.runSignal({ path: p.path, sha256: p.sha256 }, { BTC: bars, ETH: bars }, '1h')).rejects.toThrow(/signal exit 2/);
    const s3 = await spot.describe('ts_momentum/3'), series = { bars, funding: bars.map((b) => ({ ts: b.ts, rate: 0.00001, premium: null })), lastClose: '100' };
    await expect(sig.runPerpSignal({ path: s3.path, sha256: s3.sha256 }, { BTC: series }, '1h')).rejects.toThrow(/signal exit 2/);
  }, 120_000);
});

// ------------------------------------------------------------------ engine step with fakes

const inst = (symbol: string, lot: string): Instrument => ({ venue: 'hyperliquid', symbol, id: `hyperliquid:${symbol}`, base: symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0.01', lotSize: lot,
  minOrderSize: null, minNotional: '10', maxLeverage: '40', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' });
const INST: Record<string, Instrument> = { BTC: inst('BTC', '0.00001'), ETH: inst('ETH', '0.0001') };

/** an in-memory account that fills at the mark; it records every call and honours the idempotency key like the paper service */
class FakeExec {
  collateral = d('10000'); pos = new Map<string, { size: Dec; entry: Dec }>(); halt: string | null = null; events: { id: number; ts: number; kind: string; code: string | null; message: string }[] = [];
  calls: { clientId: string; symbol: string; side: string; size: string; reduceOnly: boolean; price: string | null; tif: string; type: string; leverage: string }[] = [];
  first = new Map<string, any>(); throwAt = 0; fillFraction = '1';
  marks: Record<string, string>;
  constructor(marks: Record<string, string>) { this.marks = marks; }
  equity(): Dec { let e = this.collateral; for (const [s, p] of this.pos) e = D.add(e, D.mul(p.size, D.sub(d(this.marks[s]!), p.entry))); return e; }
  async account(since = 0) {
    return { state: { venue: 'hyperliquid' as const, account: 'fake', equity: D.str(this.equity()), collateral: D.str(this.collateral), freeCollateral: D.str(this.equity()), marginUsed: '0', maintenanceMargin: null, withdrawable: null, ts: 0, source: 'paper' as const },
      policy: eng.perpPolicy(['BTC', 'ETH'], '10000', RISK, this.halt), events: this.events.filter((e) => e.id > since) };
  }
  async positions(): Promise<Position[]> {
    return [...this.pos].map(([s, p]) => ({ instrument: `hyperliquid:${s}`, side: D.isPos(p.size) ? 'long' as const : 'short' as const, size: D.str(D.abs(p.size)), entryPrice: D.str(p.entry), markPrice: this.marks[s]!, liquidationPrice: null,
      leverage: '2', marginMode: 'cross' as const, margin: '0', unrealizedPnl: '0', realizedPnl: '0', fundingPaid: '0', source: 'paper' as const }));
  }
  async place(o: OrderRequest, leverage: string) {
    const symbol = o.instrument.split(':')[1]!;
    this.calls.push({ clientId: o.clientId, symbol, side: o.side, size: o.size, reduceOnly: o.reduceOnly, price: o.price, tif: o.tif, type: o.type, leverage });
    if (this.throwAt && this.calls.length === this.throwAt) throw new Error('venue unavailable (scripted)');
    const prior = this.first.get(o.clientId);
    if (prior) return { ...prior, idempotent: true };
    const cur = this.pos.get(symbol), before = cur?.size ?? D.zero, sign = o.side === 'buy' ? D.one : D.neg(D.one);
    if (this.halt && !o.reduceOnly) return { status: 'refused' as const, code: 'halted', reason: `trading is halted: ${this.halt}` };
    if (o.reduceOnly && (D.isZero(before) || D.sign(before) === D.sign(sign) || D.gt(d(o.size), D.abs(before)))) return { status: 'refused' as const, code: 'reduce_only_would_increase', reason: 'reduce-only order would open or flip' };
    const size = D.mul(d(o.size), d(this.fillFraction)), mark = d(this.marks[symbol]!), after = D.add(before, D.mul(sign, size));
    if (cur && D.sign(before) !== D.sign(sign)) this.collateral = D.add(this.collateral, D.mul(D.mul(D.min(size, D.abs(before)), D.sub(mark, cur.entry)), D.from(BigInt(D.sign(before)))));   // realised PnL of the closed part
    if (D.isZero(after)) this.pos.delete(symbol);
    else this.pos.set(symbol, { size: after, entry: cur && D.sign(after) === D.sign(before) && D.gt(D.abs(after), D.abs(before)) ? D.div(D.add(D.mul(D.abs(before), cur.entry), D.mul(size, mark)), D.abs(after), 12, 'half_even') : cur && D.sign(after) === D.sign(before) ? cur.entry : mark });
    const full = this.fillFraction === '1';
    const res = { status: 'placed' as const, order: { ...o, venueOrderId: `f-${this.calls.length}`, status: full ? 'filled' as const : 'cancelled' as const, filled: D.str(size), avgFillPrice: D.str(mark), createdAt: 0, updatedAt: 0, rejectReason: full ? null : 'unfilled remainder cancelled' }, fills: [], idempotent: false };
    this.first.set(o.clientId, res);
    return res;
  }
}

const H = 3_600_000, BAR0 = Math.floor(T0 / H) * H - H;
interface World { id: string; ex: FakeExec; clock: Clock; bar: number; weights: Record<string, number> | Error; gateError: Error | null; signals: number; deps: import('../src/agents/perp-engine.ts').PerpEngineDeps; row: () => Promise<any>; tick: () => Promise<string>; sha: string }
async function world(o: { risk?: Partial<typeof RISK>; approved?: boolean; meta?: Record<string, unknown> } = {}): Promise<World> {
  const id = randomUUID(), sv = randomUUID(), sha = createHash('sha256').update(id).digest('hex');
  const [{ next }] = await sql`select least(coalesce(min(vault_index), 0), 0) - 1 as next from agents`;
  await sql`insert into agents (id, kind, name, network, universe, interval, risk, vault_index, vault_address, capital_usdc, deriv_account_id, state, mode, strategy_version_id)
    values (${id}, 'perp', 'fake', 'hyperliquid', ${sql.json(['BTC', 'ETH'])}, '1h', ${sql.json({ ...RISK, ...o.risk })}, ${next}, '', '10000000000', ${randomUUID()}, 'PAPER_TRADING', 'PAPER', ${sv})`;
  await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${id}, 'fake_perp', '1', ${sha}, 'strategies/fake_perp/1',
    ${sql.json({ kind: 'perp', lookback: 10, max_leverage: 2, max_gross_exposure: 2, ...o.meta })}, ${o.approved === false ? 'draft' : 'approved'}, ${sql.json({})})`;
  const clock = new Clock(), ex = new FakeExec({ BTC: '50000', ETH: '2500' });
  const w: World = { id, ex, clock, bar: BAR0, weights: { BTC: 0.5, ETH: -0.4 }, gateError: null, signals: 0, sha,
    deps: {
      now: clock.now,
      gate: async () => { if (w.gateError) throw w.gateError; return { bar: w.bar, data: {} }; },
      signal: async () => { w.signals += 1; if (w.weights instanceof Error) throw w.weights; return { weights: w.weights, maxLeverage: 2, maxGrossExposure: 2 }; },
      market: async (s) => { const m = Number(ex.marks[s]); return { inst: INST[s]!, ticker: { instrument: `hyperliquid:${s}`, mark: ex.marks[s]!, index: ex.marks[s]!, mid: ex.marks[s]!, funding: '0', openInterest: null, volume24h: null, change24h: null, ts: clock.now() },
        book: { instrument: `hyperliquid:${s}`, bids: [[String(m - 1), '1000']], asks: [[String(m + 1), '1000']], ts: clock.now() } }; },
      executor: () => ex as never,
    },
    row: async () => (await sql`select * from agents where id = ${id}`)[0],
    tick: async () => eng.tickPerpAgent(await w.row(), w.deps) };
  return w;
}
const signalRows = (id: string) => sql`select bar, status, reason, weights, scaled, scale, targets, orders from perp_agent_signals where agent_id = ${id} order by bar`;
const size = (w: World, s: string) => { const p = w.ex.pos.get(s); return p ? D.str(p.size) : '0'; };

describe('perp engine step (fake executor)', () => {
  it('opens a long and a short on the first closed bar, as IOC market orders bounded by the slippage limit, once', async () => {
    const w = await world();
    expect(await w.tick()).toBe('2 order(s)');
    expect([size(w, 'BTC'), size(w, 'ETH')]).toEqual(['0.1', '-1.6']);                 // 0.5 × 10 000 / 50 000 and −0.4 × 10 000 / 2 500
    expect(w.ex.calls.map((c) => `${c.symbol} ${c.side} ${c.size} ${c.type}/${c.tif} @${c.price} lev ${c.leverage}`)).toEqual(['BTC buy 0.1 market/ioc @50151 lev 2', 'ETH sell 1.6 market/ioc @2491.6 lev 2']);   // best ask + 30 bps (rounded down), best bid − 30 bps (rounded up), on the venue's 5-significant-figure grid
    const [s] = await signalRows(w.id);
    expect(s).toMatchObject({ status: 'done', weights: { BTC: 0.5, ETH: -0.4 }, scaled: { BTC: '0.5', ETH: '-0.4' }, scale: '1', targets: { BTC: '0.1', ETH: '-1.6' } });
    expect(s.orders.list.map((x: any) => x.status)).toEqual(['filled', 'filled']);
    expect((await w.row()).last_bar.getTime()).toBe(BAR0);
    // the same bar again: one decision per bar
    expect(await w.tick()).toBe('waiting for the next bar');
    expect([w.signals, w.ex.calls.length]).toEqual([1, 2]);
    expect((await sql`select equity_usd from agent_equity where agent_id = ${w.id}`)[0].equity_usd).toBe(10000);
  });

  it('rebalances on the next bar: closes before it opens, flips as close-then-open, and skips the open when the close is not complete', async () => {
    const w = await world();
    await w.tick();
    w.bar += H; w.clock.advance(H); w.weights = { BTC: -0.3, ETH: -0.6 };            // BTC long → short, ETH short larger
    expect(await w.tick()).toBe('3 order(s)');
    expect(w.ex.calls.slice(2).map((c) => `${c.symbol} ${c.side} ${c.size}${c.reduceOnly ? ' RO' : ''}`)).toEqual(['BTC sell 0.1 RO', 'BTC sell 0.06', 'ETH sell 0.8']);   // the close, then the opens by size (3 000 USD, 2 000 USD)
    expect([size(w, 'BTC'), size(w, 'ETH')]).toEqual(['-0.06', '-2.4']);
    // next bar: flip back, but the closing order only half fills → the opening half of the flip is NOT sent
    w.bar += H; w.clock.advance(H); w.weights = { BTC: 0.3, ETH: -0.6 }; w.ex.fillFraction = '0.5';
    expect(await w.tick()).toBe('1 order(s), 1 not sent');
    expect(size(w, 'BTC')).toBe('-0.03');
    const rows = await signalRows(w.id);
    expect(rows[2].orders.list.map((x: any) => [x.symbol, x.status])).toEqual([['BTC', 'cancelled'], ['BTC', 'skipped']]);
  });

  it('holds on stale or inconsistent data: no signal, no order, the bar stays undecided', async () => {
    const w = await world();
    w.gateError = new pd.PerpDataError('stale', 'BTC: the latest closed bar is missing');
    expect(await w.tick()).toMatch(/^hold: BTC: the latest closed bar is missing/);
    expect([w.signals, w.ex.calls.length, (await signalRows(w.id)).length, (await w.row()).last_bar]).toEqual([0, 0, 0, null]);
    expect((await w.row()).perp.hold.reason).toMatch(/latest closed bar/);
    w.gateError = null;                                                              // data back: the same bar is decided now
    expect(await w.tick()).toBe('2 order(s)');
    expect((await w.row()).perp.hold).toBeNull();
  });

  it('holds on a failed or invalid signal: the bar is recorded as a hold and nothing is traded', async () => {
    for (const bad of [new Error('signal exit 5: strategy failed'), { BTC: 2.5 }, { BTC: 1.5, ETH: -1.5 }, { DOGE: 0.2 }, { BTC: Number.NaN }] as (Record<string, number> | Error)[]) {
      const w = await world(); w.weights = bad;
      expect(await w.tick()).toBe('hold: no valid signal');
      expect(w.ex.calls).toHaveLength(0);
      const [s] = await signalRows(w.id);
      expect(s.status).toBe('hold'); expect(s.reason.length).toBeGreaterThan(5);
      expect((await w.row()).last_bar.getTime()).toBe(BAR0);
      expect(await w.tick()).toBe('waiting for the next bar');
      expect(w.signals).toBe(1);
    }
    // a version that is not approved, or not a contract-2 strategy, never runs
    const draft = await world({ approved: false });
    expect(await draft.tick()).toBe('strategy not approved');
    const spot = await world({ meta: { kind: 'spot' } });
    expect(await spot.tick()).toBe('stopped');
    expect([draft.signals, spot.signals]).toEqual([0, 0]);
  });

  it('restart in the middle of a bar: the decision is read back, not taken again, and no order is placed twice', async () => {
    const w = await world();
    w.ex.throwAt = 2;                                                                // the process "dies" on the second order
    await expect(w.tick()).rejects.toThrow(/scripted/);
    expect(size(w, 'BTC')).toBe('0.1'); expect(size(w, 'ETH')).toBe('0');
    expect((await signalRows(w.id))[0].status).toBe('decided');
    expect((await w.row()).last_bar).toBeNull();
    // restart: a strategy that would now answer something else must not be asked again for this bar
    w.ex.throwAt = 0; w.weights = { BTC: -1, ETH: 1 };
    expect(await w.tick()).toBe('1 order(s)');
    expect(w.signals).toBe(1);
    expect([size(w, 'BTC'), size(w, 'ETH')]).toEqual(['0.1', '-1.6']);
    // crash AFTER the orders but before the bar was marked complete: every order is sent again with the same key and changes nothing
    await sql`update agents set last_bar = null where id = ${w.id}`;
    await sql`update perp_agent_signals set status = 'decided' where agent_id = ${w.id}`;
    w.ex.pos.clear();                                                                // as if the engine did not know the fills (worst case: it plans both orders again)
    const before = w.ex.first.size;
    await w.tick();
    expect(w.ex.first.size).toBe(before);                                            // no new client id: the two orders were the same two
    expect(new Set(w.ex.calls.map((c) => c.clientId)).size).toBe(2);
    expect(w.ex.calls.every((c) => c.clientId.startsWith(`ag-${w.id}-${w.sha.slice(0, 8)}-${BAR0 / 1000}-`))).toBe(true);
    expect(w.signals).toBe(1);
  });

  it('loss limit: flattens with reduce-only orders, then stops — also when the close needs two passes', async () => {
    const w = await world();
    await w.tick();
    w.ex.marks = { BTC: '40000', ETH: '2600' };                                      // −1 000 on the long, −160 on the short: equity 8 840, limit 10 % of 10 000
    w.ex.fillFraction = '0.5';
    expect(await w.tick()).toBe('flattening: 2 position(s) still open');
    expect(w.ex.calls.slice(2).map((c) => `${c.symbol} ${c.side} ${c.size} RO:${c.reduceOnly}`)).toEqual(['BTC sell 0.1 RO:true', 'ETH buy 1.6 RO:true']);
    let a = await w.row();
    expect([a.state, a.perp.flatten.reason]).toEqual(['PAPER_TRADING', expect.stringMatching(/total loss limit reached: equity 8840 USDC against 10000 allocated \(limit 10 %\)/)]);
    w.ex.fillFraction = '1'; w.clock.advance(60_000);
    expect(await w.tick()).toBe('stopped: loss limit');
    a = await w.row();
    expect(a.state).toBe('STOPPED'); expect(a.stop_reason).toMatch(/total loss limit reached.*closed with reduce-only orders/);
    expect(w.ex.pos.size).toBe(0);
    expect(w.ex.calls.every((c, k) => k < 2 || c.reduceOnly)).toBe(true);
    expect(w.signals).toBe(1);                                                       // no new decision while flattening
    expect(await w.tick()).toBe('idle');
  });

  it('closing works under a halt: the breaker of the account flattens and stops the agent, nothing new is opened', async () => {
    const w = await world();
    await w.tick();
    w.ex.halt = 'daily loss limit reached (set by the paper worker)';
    w.bar += H; w.clock.advance(H); w.weights = { BTC: 1, ETH: -1 };                 // a signal that wants more exposure
    expect(await w.tick()).toBe('stopped: loss limit');
    expect(w.ex.calls.slice(2).map((c) => c.reduceOnly)).toEqual([true, true]);
    expect([w.ex.pos.size, w.signals, (await w.row()).stop_reason]).toEqual([0, 1, expect.stringMatching(/circuit breaker/)]);
  });

  it('daily loss limit, against the equity at the first pass of the UTC day', async () => {
    const w = await world({ risk: { maxDailyLossPct: 1 } });
    await w.tick();
    w.ex.marks = { BTC: '49000', ETH: '2500' };                                      // −100 = 1 % of the capital
    expect(await w.tick()).toBe('stopped: loss limit');
    expect((await w.row()).stop_reason).toMatch(/daily loss limit reached/);
  });

  it('a liquidation of the account stops the agent; a margin warning flags it and trading goes on', async () => {
    const w = await world();
    w.ex.events.push({ id: 7, ts: T0, kind: 'margin_warning', code: 'margin_warning', message: 'maintenance margin has reached 80 % of equity' });
    expect(await w.tick()).toBe('2 order(s)');
    let a = await w.row();
    expect([a.state, a.perp.flag.message, a.perp.lastEventId]).toEqual(['PAPER_TRADING', 'maintenance margin has reached 80 % of equity', 7]);
    w.ex.events.push({ id: 9, ts: T0, kind: 'liquidation', code: 'liquidated', message: 'simulated liquidation: 2 position(s) closed at the mark' });
    expect(await w.tick()).toBe('stopped: liquidation');
    a = await w.row();
    expect([a.state, a.perp.lastEventId]).toEqual(['STOPPED', 9]);
    expect(a.stop_reason).toMatch(/liquidated \(simulated\)/);
  });

  it('holds when the account carries a position the agent does not manage', async () => {
    const w = await world();
    w.ex.marks.SOL = '100'; w.ex.pos.set('SOL', { size: d('5'), entry: d('100') });
    expect(await w.tick()).toMatch(/hold: the account holds hyperliquid:SOL/);
    expect(w.ex.calls).toHaveLength(0);
  });

  it('the spot engine never trades a perp agent', async () => {
    const w = await world(), spot = await import('../src/agents/engine.ts');
    expect(await spot.tickAgent(await w.row(), {} as never)).toBe('idle');
  });
});

// ------------------------------------------------------------------ end to end on fixture venues: routes, bar store, paper account

describe('perp agent through the API (fixture venues, real paper service)', () => {
  const ORIGIN = 'https://wallet.test';
  let app: any, cookie = '', clock: Clock, v: Venues, dv: import('../src/derivatives/index.ts').Derivatives, rt: import('../src/agents/perp-live.ts').PerpRuntime;
  let next: Record<string, number> = { BTC: 0.5 }, calls = 0, mid = 0;
  const api = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const r = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...(method === 'POST' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    return { status: r.statusCode, json: r.json() };
  };
  /** a new scripted market, a few seconds later (the data service's one-second caches are then stale) */
  const market = (m: number) => { mid = m; clock.advance(6_000); setMarket(v, m, { bids: [[String(m - 5), '5'], [String(m - 10), '5']], asks: [[String(m + 5), '5'], [String(m + 10), '5']] }); };
  const create = async (name: string, risk: Record<string, unknown> = {}) => (await api('POST', '/agents', { kind: 'perp', name, instruments: ['BTC'], interval: '1h', capitalUsdc: '10000', risk: { ...RISK, ...risk } })).json;
  const arm = async (id: string) => {
    const sv = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${id}, 'fixed_perp', '1', ${createHash('sha256').update(id).digest('hex')}, 'strategies/fixed_perp/1',
      ${sql.json({ kind: 'perp', lookback: 10, max_leverage: 2, max_gross_exposure: 2 })}, 'approved', ${sql.json({})})`;
    await sql`update agents set strategy_version_id = ${sv} where id = ${id}`;
    expect((await api('POST', `/agents/${id}/mode`, { mode: 'PAPER' })).json.state).toBe('PAPER_TRADING');
  };
  const pass = async (id: string) => (await pl.perpEnginePass(rt, clock.now()))[id];
  const orders = (acct: string) => sql`select client_id, side, reduce_only, status, size::text, origin, type, tif from deriv_orders where account_id = ${acct} order by created_at, venue_order_id`;

  beforeAll(async () => {
    await sql`delete from perp_agent_signals`; await sql`delete from agent_equity`; await sql`delete from research_log`; await sql`delete from strategy_versions`; await sql`delete from agents`;
    await sql`truncate deriv_paper_accounts cascade`; await sql`delete from perp_candles`; await sql`delete from perp_funding`;
    const token = randomBytes(32).toString('base64url');
    await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
    cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
    clock = new Clock(); v = fixtureVenues(clock);
    // the recorded answers are static: like the venue, serve only what is at or after the requested start time
    const hl = v.adapters.hyperliquid, candles = hl.candles.bind(hl), funding = hl.fundingHistory.bind(hl);
    hl.candles = async (s, i, o) => (await candles(s, i, { limit: 5000 })).filter((b) => b.ts >= (o.start ?? 0) && b.ts <= (o.end ?? Infinity)).slice(0, o.limit ?? 500);
    hl.fundingHistory = async (s, o) => (await funding(s, o)).filter((f) => f.ts >= o.start);
    dv = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
    app = await (await import('../src/server.ts')).buildServer({ derivatives: dv });
    rebuild();
  });
  /** a new process on the same database: fresh caches, the scripted signal */
  const rebuild = () => {
    dv = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
    rt = pl.createPerpRuntime(dv, { signal: async () => { calls += 1; return { weights: next, maxLeverage: 2, maxGrossExposure: 2 }; } });
    pl.setPerpRuntime(rt);
  };
  afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); });
  beforeEach(() => { v.hl.ticker = null; v.hl.book = null; v.hl.down = false; });

  it('the bar store keeps the venue\'s closed bars and funding, asks nothing twice, and its gate fails closed', async () => {
    const btc = await dv.data.instrument(BTC), store = rt.store;
    const g = await store.gate(btc, '1h', 10);
    expect(g.bar).toBe(BAR0);
    expect([g.series.bars.length, g.series.funding.length, g.series.bars.at(-1)!.ts, g.series.funding.at(-1)!.ts]).toEqual([10, 10, BAR0, BAR0]);   // the 03:00 settlement and the bar in progress are not inputs
    expect((await sql`select count(*)::int as n from perp_candles where ts > ${new Date(BAR0)}`)[0].n).toBe(0);            // the bar in progress is never stored
    expect(store.stats).toEqual({ candles: 1, funding: 1 });
    await store.gate(btc, '1h', 10); await store.gate(btc, '1h', 10);
    expect(store.stats).toEqual({ candles: 1, funding: 1 });                                                               // complete window: no request
    mid = Math.round(Number(g.series.lastClose));
    // mark far from the venue's spot index → hold
    v.hl.ticker = { mark: String(mid), index: String(Math.round(mid * 1.02)), mid: String(mid), funding: '0.0000125' }; clock.advance(6_000);
    await expect(store.gate(btc, '1h', 10)).rejects.toMatchObject({ code: 'mark_index' });
    // venue unreachable → hold
    v.hl.ticker = null; v.hl.down = true; clock.advance(20_000);
    await expect(store.gate(btc, '1h', 10)).rejects.toMatchObject({ code: 'venue' });
    v.hl.down = false;
    // an hour later the next bar has closed: ONE small request each; the venue now serves a stored bar with another close → held once, then fine
    clock.advance(H);
    await sql`update perp_candles set close = close + 1 where ts = ${new Date(BAR0)}`;
    await expect(store.gate(btc, '1h', 10)).rejects.toMatchObject({ code: 'revised' });
    expect(store.stats).toEqual({ candles: 2, funding: 1 });
    expect((await store.gate(btc, '1h', 10)).bar).toBe(BAR0 + H);
    expect(store.stats).toEqual({ candles: 2, funding: 1 });                                                               // the 03:00 settlement was already stored: no funding request
    // two hours later the venue (a recorded answer) has no newer bar: the latest closed bar is missing → hold
    clock.advance(H);
    await expect(store.gate(btc, '1h', 10)).rejects.toMatchObject({ code: 'stale' });
    // our share of the venue's rate limit is spent before the request is sent
    const tight = new pd.PerpDataStore(dv.data, { now: clock.now, weightPerMinute: 30 });
    await sql`delete from perp_candles where ts >= ${new Date(BAR0)}`;
    await expect(tight.sync(btc, '1h', 10)).rejects.toMatchObject({ code: 'rate_budget' });
    expect(tight.stats.candles).toBe(0);
    clock.t = T0; await sql`delete from perp_candles`; await sql`delete from perp_funding`; rebuild();
  });

  it('creates a perp agent with its own paper account and policy, without a vault, a mandate or a signer call', async () => {
    const a = await create('Perp one');
    expect(a).toMatchObject({ kind: 'perp', simulation: true, state: 'CREATED', mode: 'PAPER', venue: 'hyperliquid', universe: ['BTC'], instruments: [BTC], capitalUsdc: '10000', vaultAddress: '', mandateId: null, risk: RISK });
    const row = (await sql`select * from agents where id = ${a.id}`)[0];
    expect(row.vault_index).toBeLessThan(0);
    const det = (await api('GET', `/agents/${a.id}`)).json;
    expect(det.account).toMatchObject({ id: a.accountId, positions: [], state: { equity: '10000' }, policy: { mode: 'PAPER', allowedInstruments: [BTC], maxLeverage: '2', maxGrossExposure: '15000', maxPositionNotional: '10000', maxDailyLoss: '300', maxTotalLoss: '1000', halt: null } });
    expect(det.live).toMatchObject({ available: false }); expect(det.live.reason).toMatch(/signer/);
    expect((await api('GET', '/agents')).json.agents.find((x: any) => x.id === a.id)).toMatchObject({ kind: 'perp', networkName: 'Hyperliquid' });
    // vault and mandate routes do not exist for it (and would have needed the signer, which is unreachable in this test)
    for (const r of ['mandate/prepare', 'mandate/approve', 'revoke', 'withdraw']) expect((await api('POST', `/agents/${a.id}/${r}`, r === 'withdraw' ? { asset: 'native' } : r === 'mandate/approve' ? { assertion: {} } : {})).json.error).toBe('perp_agent');
    expect((await api('GET', `/agents/${a.id}/elsewhere`)).status).toBe(409);
    // refused creations
    for (const bad of [{ instruments: ['NOPE'] }, { instruments: [] }, { instruments: ['BTC', 'BTC'] }, { capitalUsdc: '20' }, { risk: { ...RISK, maxLeverage: 9 } }, { risk: { ...RISK, maxDailyLossPct: 20 } }, { interval: '5m' }, { vault: 1 }]) {
      expect((await api('POST', '/agents', { kind: 'perp', name: 'bad', instruments: ['BTC'], capitalUsdc: '10000', ...bad })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await sql`select count(*)::int as n from deriv_paper_accounts`)[0].n).toBe(1);                                   // no orphan account
    const ven = (await api('GET', '/agents/perp/venues')).json;
    expect(ven).toMatchObject({ maxInstruments: 8, live: { available: false } });
    expect(ven.venues[0].instruments.find((x: any) => x.symbol === 'BTC')).toMatchObject({ id: BTC, eligible: true });
    // approval needs a version-2 report whose integrity checks pass
    const sv = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, report) values (${sv}, ${a.id}, 'x_perp', '1', ${'c'.repeat(64)}, 'strategies/x_perp/1', ${sql.json({ kind: 'perp' })}, ${sql.json({ schema_version: 1 })})`;
    expect((await api('POST', `/agents/${a.id}/strategies/${sv}/approve`)).json).toMatchObject({ error: 'bad_report' });
    await sql`update strategy_versions set report = ${sql.json({ schema_version: 2, kind: 'perp', strategy_sha256: 'c'.repeat(64), config: { symbols: ['BTC'], start: '2026-04-16T20:00:00+00:00', end: '2026-11-11T03:00:00+00:00' },
      checks: { lookahead: 'pass', ledger: 'pass', funding_alignment: 'pass', data_quality: 'pass', notes: [] }, liquidations: { train: [{}], validation: [], test: [] }, robustness: { deflated_sharpe: 0.01, trials_tested: 9 }, metrics: { test: { total_return: -0.02, liquidations: 0 } } })} where id = ${sv}`;
    expect((await api('POST', `/agents/${a.id}/strategies/${sv}/approve`)).json).toMatchObject({ kind: 'perp', state: 'AWAITING_APPROVAL', strategyVersionId: sv });
    const ver = (await api('GET', `/agents/${a.id}`)).json.versions[0];
    expect(ver.summary).toMatchObject({ historyDays: 208, liquidations: { train: 1, validation: 0, test: 0 }, robustness: { deflated_sharpe: 0.01, trials_tested: 9 }, checks: { lookahead: 'pass' }, problem: null });
    // a spot agent can never approve a contract-2 version
    const spot = randomUUID(), sv2 = randomUUID();
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address) values (${spot}, 'spot', ${sql.json(['ETH'])}, ${sql.json({})}, 1, '0x0000000000000000000000000000000000000001')`;
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, report) values (${sv2}, ${spot}, 'x_perp', '1', ${'d'.repeat(64)}, 'strategies/x_perp/1', ${sql.json({ kind: 'perp' })}, ${sql.json({ schema_version: 2 })})`;
    expect((await api('POST', `/agents/${spot}/strategies/${sv2}/approve`)).json).toMatchObject({ error: 'wrong_kind' });
    await sql`delete from strategy_versions where agent_id = ${spot}`; await sql`delete from agents where id = ${spot}`;
  });

  it('trades the paper account bar by bar: long, flip to short as close-then-open, idempotent after a restart, flat and stopped under a halt', async () => {
    const a = await create('Perp two'), acct = a.accountId as string;
    await arm(a.id);
    const g0 = await rt.store.gate(await dv.data.instrument(BTC), '1h', 10);
    market(Math.round(Number(g0.series.lastClose)));
    // bar 02:00 — long 0.5 × equity
    next = { BTC: 0.5 }; calls = 0;
    expect(await pass(a.id)).toBe('1 order(s)');
    let det = (await api('GET', `/agents/${a.id}`)).json;
    expect(det.account.positions).toHaveLength(1);
    expect(det.account.positions[0]).toMatchObject({ instrument: BTC, side: 'long', leverage: '2' });
    const want = D.quantize(D.div(d('5000'), d(String(mid)), 18, 'down'), d('0.00001'), 'down');
    expect(det.account.positions[0].size).toBe(D.str(want));
    expect(det.account.positions[0]).toHaveProperty('liquidationPrice');            // an estimate; null here (0.5× on a cross account cannot be liquidated above zero)
    expect(det.signals[0]).toMatchObject({ status: 'done', weights: { BTC: 0.5 }, scale: '1' });
    expect(await orders(acct)).toMatchObject([{ side: 'buy', reduce_only: false, status: 'filled', origin: 'agent', type: 'market', tif: 'ioc' }]);
    expect(await pass(a.id)).toBe('waiting for the next bar');
    // bar 03:00 — the strategy goes short: reduce-only close first, then the open (the paper engine would refuse one crossing reduce-only order)
    clock.t = T0 + H; market(mid); next = { BTC: -0.5 };
    expect(await pass(a.id)).toBe('2 order(s)');
    const o = await orders(acct);
    expect(o.slice(1)).toMatchObject([{ side: 'sell', reduce_only: true, status: 'filled', size: D.str(want), origin: 'agent' }, { side: 'sell', reduce_only: false, status: 'filled', origin: 'agent' }]);
    det = (await api('GET', `/agents/${a.id}`)).json;
    expect(det.account.positions[0]).toMatchObject({ side: 'short' });
    expect(det.account.fills.length).toBe(3);
    expect(calls).toBe(2);
    // restart after the orders, before the bar was marked complete: same keys, nothing placed twice, the signal is not asked again
    await sql`update agents set last_bar = ${new Date(BAR0)} where id = ${a.id}`;
    await sql`update perp_agent_signals set status = 'decided' where agent_id = ${a.id} and bar = ${new Date(BAR0 + H)}`;
    next = { BTC: 1 }; rebuild();                                                    // a strategy that would now answer something else
    await pass(a.id);
    expect([(await orders(acct)).length, calls, (await api('GET', `/agents/${a.id}`)).json.account.positions[0].size]).toEqual([3, 2, det.account.positions[0].size]);
    // the account's circuit breaker trips (as the paper worker sets it on a loss limit): closing still passes the real risk engine
    const pol = (await rt.deriv.paper.get(acct)).policy;
    await rt.deriv.paper.setPolicy(acct, { ...pol, halt: 'daily loss limit reached (test)' });
    market(mid);
    expect(await pass(a.id)).toBe('stopped: loss limit');
    det = (await api('GET', `/agents/${a.id}`)).json;
    expect([det.state, det.account.positions.length]).toEqual(['STOPPED', 0]);
    expect(det.stopReason).toMatch(/circuit breaker.*closed with reduce-only orders/);
    expect((await orders(acct)).at(-1)).toMatchObject({ side: 'buy', reduce_only: true, status: 'filled' });
    // it does not restart while the account is halted
    expect((await api('POST', `/agents/${a.id}/mode`, { mode: 'PAPER' })).json.error).toBe('halted');
  });

  it('lowering a loss limit reaches the account policy and the engine: flatten, then stop', async () => {
    market(mid);
    const a = await create('Perp three'), acct = a.accountId as string;
    await arm(a.id);
    next = { BTC: 0.5 };
    expect(await pass(a.id)).toBe('1 order(s)');
    // the fee of that order (≈ 2.25 USDC) is already more than 0.01 % of the capital (1 USDC)
    const r = (await api('POST', `/agents/${a.id}/perp/risk`, { risk: { ...RISK, maxDailyLossPct: 0.01, maxTotalLossPct: 0.01 } })).json;
    expect(r.risk.maxTotalLossPct).toBe(0.01);
    expect((await rt.deriv.paper.get(acct)).policy).toMatchObject({ maxTotalLoss: '1', maxDailyLoss: '1', halt: null });
    market(mid);
    expect(await pass(a.id)).toBe('stopped: loss limit');
    const det = (await api('GET', `/agents/${a.id}`)).json;
    expect([det.state, det.account.positions.length]).toEqual(['STOPPED', 0]);
    expect(det.stopReason).toMatch(/loss limit reached/);
    expect(det.log.map((l: any) => l.title)).toEqual(expect.arrayContaining(['Agent stopped', 'Loss limit: closing every position']));
    // the owner can also close everything by hand: nothing left to close here
    expect((await api('POST', `/agents/${a.id}/perp/flatten`)).json).toEqual({ orders: [], positionsLeft: 0 });
    // the paper worker and the agent share the account: a worker step changes nothing on a flat account
    expect((await wk.paperStep(rt.deriv.paper)).accounts).toBe(0);
  });
});

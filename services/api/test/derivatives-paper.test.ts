// Paper accounts and the paper worker against PostgreSQL (database spw_deriv_paper_test, created here if missing) with
// fixture-backed venue adapters and a scripted Hyperliquid BTC market. No network, no signer, no trading endpoint.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import { BTC, Clock, T0, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

let sql: any, mod: typeof import('../src/derivatives/index.ts'), wk: typeof import('../src/derivatives/worker.ts'), pp: typeof import('../src/derivatives/paper.ts');
type Deriv = import('../src/derivatives/index.ts').Derivatives;

beforeAll(async () => {
  await useDatabase('spw_deriv_paper_test');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await db.migrate(); // the schema is idempotent
  mod = await import('../src/derivatives/index.ts'); wk = await import('../src/derivatives/worker.ts'); pp = await import('../src/derivatives/paper.ts');
});
beforeEach(async () => { await sql`truncate deriv_paper_accounts cascade`; });
afterAll(async () => { await sql?.end(); });

let seq = 0;
const key = () => `test-key-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
function world(t = T0) {
  const clock = new Clock(t), v = fixtureVenues(clock);
  const build = (): Deriv => mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  const w = { clock, v, d: build(), restart: () => { w.d = build(); }, step: () => wk.paperStep(w.d.paper),
    /** a few seconds later, with a new market */
    next: (mid: number, o: Parameters<typeof setMarket>[2] = {}) => { clock.advance(5_000); setMarket(v, mid, o); return wk.paperStep(w.d.paper); } };
  setMarket(v, 50_000);
  return w;
}
type World = ReturnType<typeof world>;
const open = async (w: World, collateral = '10000', policy?: Record<string, unknown>) => (await w.d.paper.create({ venue: 'hyperliquid', label: 'test', collateral, ...(policy ? { policy } : {}) } as never)).id;
const order = (w: World, id: string, o: Record<string, unknown>, k = key()) => w.d.paper.order(id, pp.OrderBodySchema.parse({ instrument: BTC, ...o }), k);
const market = (w: World, id: string, side: 'buy' | 'sell', size: string, extra: Record<string, unknown> = {}) => order(w, id, { side, type: 'market', size, slippageBps: 50, tif: 'ioc', ...extra });
const refusal = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? { code: e.code as string, status: e.status as number, message: e.message as string } : null; };
const rows = async (id: string) => {
  const n = async (t: string) => (await sql.unsafe(`select count(*)::int as n from ${t} where account_id = $1`, [id]))[0].n as number;
  return { orders: await n('deriv_orders'), fills: await n('deriv_fills'), funding: await n('deriv_funding'), events: await n('deriv_risk_events'), equity: await n('deriv_equity') };
};
const stored = async (id: string) => (await sql`select state, policy, meta from deriv_paper_accounts where id = ${id}`)[0] as { state: any; policy: any; meta: any };
const events = async (id: string, kind: string) => sql`select * from deriv_risk_events where account_id = ${id} and kind = ${kind} order by id`;
const audits = async (id: string) => (await sql`select type from audit_events where data->>'account' = ${id} order by seq`).map((r: { type: string }) => r.type) as string[];
const LOOSE = { maxLeverage: '20', maxOrderNotional: '100000', maxGrossExposure: '100000', maxPositionNotional: '100000', minFreeCollateral: '0', minLiquidationDistanceBps: '0', maxDailyLoss: '100000', maxTotalLoss: '100000' };

describe('paper accounts', () => {
  it('a new account is PAPER with a conservative, explicit policy proportional to the collateral', async () => {
    const w = world(), a = await w.d.paper.create(pp.CreateBodySchema.parse({ venue: 'hyperliquid', label: '  first  ', collateral: '10000.00' }));
    expect(a).toMatchObject({ venue: 'hyperliquid', network: 'mainnet', kind: 'paper', mode: 'PAPER', label: 'first', initialCollateral: '10000', positions: [], openOrders: [], orders: [], fills: [] });
    expect(a.policy).toEqual({ mode: 'PAPER', allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], halt: null, maxDataAgeMs: 10_000, maxDeviationBps: '200', maxMarkIndexBps: '100', maxLeverage: '3',
      maxOrderNotional: '10000', maxGrossExposure: '30000', maxPositionNotional: '20000', minFreeCollateral: '1000', minLiquidationDistanceBps: '1000', maxDailyLoss: '500', maxTotalLoss: '2000',
      maxOrdersPerMinute: 10, maxOrdersPerDay: 200 });
    expect(a.state).toMatchObject({ equity: '10000', collateral: '10000', freeCollateral: '10000', marginUsed: '0', source: 'paper' });
    expect(a.equity).toHaveLength(1);
    expect(await audits(a.id)).toEqual(['deriv.paper.account_created']);
    const custom = await w.d.paper.create({ venue: 'hyperliquid', label: 'x', collateral: '500', policy: { maxLeverage: '2', allowedInstruments: ['hyperliquid:BTC'] } });
    expect(custom.policy).toMatchObject({ mode: 'PAPER', maxLeverage: '2', allowedInstruments: ['hyperliquid:BTC'], maxOrderNotional: '500' });
    expect(custom.settings.leverage).toBe('2');
    expect((await w.d.paper.list()).map((x) => x.label)).toEqual(['first', 'x']);
  });

  it('no paper account on dYdX (restriction text) or GMX (no book); a paper account can never be put in a live mode', async () => {
    const w = world();
    const dydx = await refusal(w.d.paper.create({ venue: 'dydx', label: 'x', collateral: '1000' }));
    expect(dydx).toMatchObject({ code: 'venue_restricted', status: 403 });
    expect(dydx!.message).toContain('Canada'); expect(dydx!.message).toContain('geoblocks');
    expect(await refusal(w.d.paper.create({ venue: 'gmx', label: 'x', collateral: '1000' }))).toMatchObject({ code: 'paper_unsupported', status: 422 });
    expect(await refusal(w.d.paper.create({ venue: 'nope', label: 'x', collateral: '1000' }))).toMatchObject({ code: 'unknown_venue', status: 404 });
    expect(await refusal(w.d.paper.create({ venue: 'hyperliquid', label: 'x', collateral: '1000', policy: { mode: 'MANUAL_LIVE' } }))).toMatchObject({ code: 'live_not_available', status: 422 });
    const id = await open(w), p = (await stored(id)).policy;
    expect(await refusal(w.d.paper.setPolicy(id, { ...p, mode: 'MANDATE_LIVE' }))).toMatchObject({ code: 'live_not_available' });
    expect(w.v.dydx.accountCalls).toBe(0);
    expect(w.v.hl.calls.exchange).toBeUndefined();
  });

  it('long: market buy fills at the ask with the taker fee; close sells at the bid; state, rows and audit agree', async () => {
    const w = world(), id = await open(w);
    const r = await market(w, id, 'buy', '0.1');
    expect(r.order).toMatchObject({ status: 'filled', filled: '0.1', avgFillPrice: '50005', price: '50255', type: 'market', reduceOnly: false });   // worst price: 50005 × 1.005, on the venue grid
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ price: '50005', size: '0.1', fee: '2.250225', feeAsset: 'USDC', side: 'buy', liquidation: false, closedPnl: null });
    let a = await w.d.paper.get(id);
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0]).toMatchObject({ instrument: BTC, side: 'long', size: '0.1', entryPrice: '50005', markPrice: '50000', leverage: '3', marginMode: 'cross', unrealizedPnl: '-0.5', source: 'paper' });
    expect(a.state).toMatchObject({ collateral: '9997.749775', equity: '9997.249775', source: 'paper' });
    expect(a.orders).toHaveLength(1); expect(a.fills).toHaveLength(1); expect(a.fills[0]).toMatchObject({ price: '50005', fee: '2.250225' });
    expect(a.equity.at(-1)).toMatchObject({ equity: '9997.249775', unrealizedPnl: '-0.5', source: 'paper' });

    const c = await w.d.paper.close(id, { instrument: BTC, fraction: '1' });
    expect(c).toMatchObject({ worstPrice: '49746', slippageBoundBps: 50, idempotent: false });      // 49995 × 0.995 = 49745.025, rounded up onto the grid: never below the bound
    expect(c.order).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true, status: 'filled', avgFillPrice: '49995' });
    expect(c.fills[0]).toMatchObject({ price: '49995', closedPnl: '-1', fee: '2.249775' });
    a = await w.d.paper.get(id);
    expect(a.positions).toEqual([]);
    expect(a.state).toMatchObject({ collateral: '9994.5', equity: '9994.5', marginUsed: '0' });
    expect(a.totals).toEqual({ realizedPnl: '-1', feesPaid: '4.5', fundingNet: '0', liquidations: 0 });
    expect(await rows(id)).toMatchObject({ orders: 2, fills: 2 });
    expect(await audits(id)).toEqual(['deriv.paper.account_created', 'deriv.paper.order', 'deriv.paper.close']);
    expect(await refusal(w.d.paper.close(id, { instrument: BTC, fraction: '1' }))).toMatchObject({ code: 'no_position', status: 422 });
  });

  it('short: sells at the bid, gains when the mark falls, a partial close then the rest', async () => {
    const w = world(), id = await open(w);
    const r = await market(w, id, 'sell', '0.1');
    expect(r.fills[0]).toMatchObject({ side: 'sell', price: '49995', fee: '2.249775' });
    await w.next(49_000);
    let a = await w.d.paper.get(id);
    expect(a.positions[0]).toMatchObject({ side: 'short', size: '0.1', entryPrice: '49995', markPrice: '49000', unrealizedPnl: '99.5' });
    const half = await w.d.paper.close(id, { instrument: BTC, fraction: '0.5' });
    expect(half.order).toMatchObject({ side: 'buy', size: '0.05', status: 'filled', reduceOnly: true });
    expect(half.fills[0]).toMatchObject({ price: '49005', closedPnl: '49.5' });
    const rest = await w.d.paper.close(id, { instrument: BTC, fraction: '1' });
    expect(rest.fills[0]).toMatchObject({ size: '0.05', closedPnl: '49.5' });
    a = await w.d.paper.get(id);
    expect(a.positions).toEqual([]);
    // 10000 + 99 − fees (4999.5 + 2450.25 + 2450.25) × 0.00045
    expect(a.state.collateral).toBe(D.str(D.sub(D.from('10099'), D.mul(D.from('9900'), D.from('0.00045')))));
    expect(a.totals.realizedPnl).toBe('99');
  });

  it('partial fill on a thin book: what the book cannot give within the price bound is cancelled', async () => {
    const w = world(), id = await open(w);
    setMarket(w.v, 50_000, { asks: [['50005', '0.01'], ['50900', '5']] });
    const r = await market(w, id, 'buy', '0.05');
    expect(r.order).toMatchObject({ status: 'cancelled', filled: '0.01', avgFillPrice: '50005' });
    expect(r.order.rejectReason).toMatch(/no liquidity within the price bound/);
    expect(r.fills).toHaveLength(1);
    expect((await w.d.paper.get(id)).positions[0]).toMatchObject({ size: '0.01' });
  });

  it('preview runs the same checks and the same simulation and stores nothing', async () => {
    const w = world(), id = await open(w), before = await stored(id), n = await rows(id);
    const p = await w.d.paper.preview(id, pp.OrderBodySchema.parse({ instrument: BTC, side: 'buy', type: 'market', size: '0.1', slippageBps: 50 }));
    expect(p.risk).toEqual({ ok: true });
    expect(p.request).toMatchObject({ price: '50255', clientId: 'preview' });
    expect(p.estimate).toMatchObject({ notional: '5000.5', fee: '2.250225', avgFillPrice: '50005', slippageBps: '1', filledSize: '0.1', restingSize: '0', status: 'filled', leverage: '3', source: 'estimate',
      initialMargin: '1666.833333333333333334' });
    // the whole account backs 0.1 BTC: no price liquidates it — said as such, and labelled an estimate
    expect(p.estimate.liquidationPrice).toMatchObject({ value: null, source: 'estimate' });
    expect(D.str(D.add(D.from(p.estimate.freeCollateralAfter), D.from('1666.666666666666666667')))).toBe('9997.249775');       // equity − margin at the mark
    // a resting limit: nothing fills, the estimate says so
    const lim = await w.d.paper.preview(id, pp.OrderBodySchema.parse({ instrument: BTC, side: 'buy', type: 'limit', size: '0.1', price: '49900' }));
    expect(lim.estimate).toMatchObject({ avgFillPrice: null, slippageBps: null, filledSize: '0', restingSize: '0.1', status: 'open', notional: '4990', fee: '0.7485' });
    // refused orders are previewed with their code
    const big = await w.d.paper.preview(id, pp.OrderBodySchema.parse({ instrument: BTC, side: 'buy', type: 'market', size: '0.25', slippageBps: 50 }));
    expect(big.risk).toMatchObject({ ok: false, code: 'order_notional_exceeded' });
    const noPrice = await w.d.paper.preview(id, pp.OrderBodySchema.parse({ instrument: BTC, side: 'buy', type: 'market', size: '0.1' }));
    expect(noPrice.risk).toMatchObject({ ok: false, code: 'price_required' });
    expect(await stored(id)).toEqual(before);
    expect(await rows(id)).toEqual(n);
  });

  it('risk refusals carry the engine code, are recorded as risk events and place nothing', async () => {
    const w = world(), id = await open(w);
    const cases: [Record<string, unknown>, string][] = [
      [{ side: 'buy', type: 'market', size: '1', slippageBps: 50 }, 'leverage_exceeded'],
      [{ side: 'buy', type: 'market', size: '0.25', slippageBps: 50 }, 'order_notional_exceeded'],
      [{ side: 'buy', type: 'limit', size: '0.1', price: '45000' }, 'price_deviation'],
      [{ side: 'buy', type: 'limit', size: '0.100001', price: '49900' }, 'size_not_on_lot'],
      [{ side: 'buy', type: 'limit', size: '0.1', price: '49900.5' }, 'price_not_on_tick'],          // Hyperliquid: 5 significant figures
      [{ side: 'buy', type: 'limit', size: '0.0001', price: '49900' }, 'below_min_notional'],
      [{ side: 'buy', type: 'market', size: '0.1' }, 'price_required'],
      [{ side: 'sell', type: 'market', size: '0.1', slippageBps: 50, reduceOnly: true }, 'reduce_only_would_increase'],
      [{ side: 'buy', type: 'stop_market', size: '0.1', price: '50500' }, 'trigger_required'],
      [{ side: 'buy', type: 'market', size: '0.1', slippageBps: 50, leverage: '5' }, 'leverage_exceeded'],
      [{ side: 'buy', type: 'market', size: '0.1', slippageBps: 50, leverage: '2.5' }, 'leverage_exceeded'],
      [{ instrument: 'hyperliquid:SOL', side: 'buy', type: 'market', size: '1', slippageBps: 50 }, 'instrument_not_allowed'],
    ];
    setMarket(w.v, 50_000);
    for (const [o, code] of cases) {
      if (o.instrument === 'hyperliquid:SOL') { expect(await refusal(order(w, id, o)), JSON.stringify(o)).not.toBeNull(); continue; }   // no recorded SOL book: refused before the engine
      expect(await refusal(order(w, id, o)), JSON.stringify(o)).toMatchObject({ code, status: 422 });
    }
    expect(await rows(id)).toMatchObject({ orders: 0, fills: 0 });
    const ev = await events(id, 'order_refused');
    expect(ev.map((e: any) => e.code)).toEqual(cases.filter(([o]) => !o.instrument).map(([, c]) => c));
    expect((await stored(id)).state.orders).toEqual([]);
    // the venue stops answering: an order needs a ticker and a book read within the last second — an older cached one is not used
    w.v.hl.down = true; w.clock.advance(2_000);
    expect(await refusal(market(w, id, 'buy', '0.1'))).toMatchObject({ code: 'venue_unavailable', status: 503 });
    expect(await rows(id)).toMatchObject({ orders: 0, fills: 0 });
    w.v.hl.down = false; w.clock.advance(2_000);
    // an instrument on another venue, an unknown one
    expect(await refusal(order(w, id, { instrument: 'dydx:BTC-USD', side: 'buy', type: 'market', size: '0.1', slippageBps: 50 }))).toMatchObject({ code: 'instrument_mismatch', status: 422 });
    expect(await refusal(order(w, id, { instrument: 'hyperliquid:NOPE', side: 'buy', type: 'market', size: '0.1', slippageBps: 50 }))).toMatchObject({ code: 'unknown_instrument', status: 404 });
  });

  it('idempotent submission: a repeated key returns the first result and places nothing, even when sent twice at once', async () => {
    const w = world(), id = await open(w), k = key();
    const first = await market(w, id, 'buy', '0.1', {}), again = await w.d.paper.order(id, pp.OrderBodySchema.parse({ instrument: BTC, side: 'buy', type: 'market', size: '0.1', slippageBps: 50 }), first.order.clientId);
    expect(first.idempotent).toBe(false); expect(again.idempotent).toBe(true);
    expect(again.order).toEqual(first.order); expect(again.fills).toEqual(first.fills);
    // the market moved: the first result is still what the key returns
    await w.next(51_000);
    expect((await w.d.paper.order(id, pp.OrderBodySchema.parse({ instrument: BTC, side: 'sell', type: 'market', size: '0.05', slippageBps: 50 }), first.order.clientId)).order).toEqual(first.order);
    await market(w, id, 'buy', '0.02');
    const pair = await Promise.all([order(w, id, { side: 'buy', type: 'market', size: '0.03', slippageBps: 50 }, k), order(w, id, { side: 'buy', type: 'market', size: '0.03', slippageBps: 50 }, k)]);
    expect(pair.map((p) => p.idempotent).sort()).toEqual([false, true]);
    expect(pair[0].order.venueOrderId).toBe(pair[1].order.venueOrderId);
    const a = await w.d.paper.get(id);
    expect(a.positions[0]!.size).toBe('0.15');                       // 0.1 + 0.02 + 0.03, each once
    expect(await rows(id)).toMatchObject({ orders: 3, fills: 3 });
    expect((await stored(id)).state.orders).toHaveLength(3);
  });

  it('cancel and reset', async () => {
    const w = world(), id = await open(w);
    const lim = await order(w, id, { side: 'buy', type: 'limit', size: '0.1', price: '49900' });
    expect(lim.order.status).toBe('open'); expect(lim.fills).toEqual([]);
    expect((await w.d.paper.get(id)).openOrders).toHaveLength(1);
    const c = await w.d.paper.cancel(id, lim.order.clientId);
    expect(c.order).toMatchObject({ status: 'cancelled', clientId: lim.order.clientId });
    expect((await w.d.paper.cancel(id, lim.order.clientId)).order.status).toBe('cancelled');       // again: unchanged
    expect(await refusal(w.d.paper.cancel(id, 'never-seen'))).toMatchObject({ code: 'unknown_order', status: 404 });
    expect((await sql`select status from deriv_orders where account_id = ${id}`)[0].status).toBe('cancelled');
    await market(w, id, 'buy', '0.1');
    const r = await w.d.paper.reset(id);
    expect(r).toMatchObject({ positions: [], openOrders: [], orders: [], fills: [], funding: [] });
    expect(r.state).toMatchObject({ collateral: '10000', equity: '10000' });
    expect(await rows(id)).toMatchObject({ orders: 0, fills: 0, funding: 0, equity: 1 });
    expect((await events(id, 'reset'))).toHaveLength(1);
    expect((await audits(id)).slice(-1)).toEqual(['deriv.paper.reset']);
    expect(await refusal(w.d.paper.reset('00000000-0000-4000-8000-000000000000'))).toMatchObject({ code: 'unknown_account', status: 404 });
  });
});

describe('paper worker', () => {
  it('a resting limit is filled later by the worker, as a maker, for the crossing depth only; the same inputs twice change nothing', async () => {
    const w = world(), id = await open(w);
    const lim = await order(w, id, { side: 'buy', type: 'limit', size: '0.1', price: '49900' });
    expect(lim.order.status).toBe('open');
    expect(await w.next(50_000)).toMatchObject({ accounts: 1, fed: 1, fills: 0 });
    // the book comes down through the limit with 0.04 at 49890: 0.04 fills at the order's own price
    expect(await w.next(49_895, { asks: [['49890', '0.04'], ['49910', '3']], bids: [['49880', '1']] })).toMatchObject({ fills: 1 });
    let a = await w.d.paper.get(id);
    expect(a.openOrders[0]).toMatchObject({ status: 'partially_filled', filled: '0.04', avgFillPrice: '49900' });
    expect(a.fills[0]).toMatchObject({ price: '49900', size: '0.04', fee: '0.2994', side: 'buy' });   // maker: 0.04 × 49900 × 0.00015
    // the loop again over the very same inputs: nothing
    const snap = await stored(id), n = await rows(id);
    expect(await w.step()).toMatchObject({ fed: 1, fills: 0, funding: 0 });
    expect(await w.step()).toMatchObject({ fills: 0 });
    expect(await stored(id)).toEqual(snap); expect(await rows(id)).toEqual(n);
    // the rest
    expect(await w.next(49_885, { asks: [['49880', '1']], bids: [['49870', '1']] })).toMatchObject({ fills: 1 });
    a = await w.d.paper.get(id);
    expect(a.openOrders).toEqual([]);
    expect(a.orders[0]).toMatchObject({ status: 'filled', filled: '0.1', avgFillPrice: '49900' });
    expect(a.positions[0]).toMatchObject({ side: 'long', size: '0.1', entryPrice: '49900', markPrice: '49885' });
    expect(await rows(id)).toMatchObject({ orders: 1, fills: 2 });
    expect((await audits(id)).filter((t) => t === 'deriv.paper.fill')).toHaveLength(2);
  });

  it('stop and take-profit orders trigger on the mark and execute on the next book', async () => {
    const w = world(), id = await open(w);
    await market(w, id, 'buy', '0.1');
    const stop = await order(w, id, { side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '49500', price: '49000', reduceOnly: true });
    const tp = await order(w, id, { side: 'sell', type: 'take_profit_market', size: '0.1', triggerPrice: '50500', price: '50000', reduceOnly: true });
    expect(stop.order.status).toBe('pending'); expect(tp.order.status).toBe('pending');
    expect(await w.next(50_300)).toMatchObject({ fills: 0 });
    // the mark reaches the take-profit: it sells at the bid; the position is gone
    expect(await w.next(50_600)).toMatchObject({ fills: 1 });
    let a = await w.d.paper.get(id);
    expect(a.positions).toEqual([]);
    expect(a.orders.find((o) => o.clientId === tp.order.clientId)).toMatchObject({ status: 'filled', avgFillPrice: '50595' });
    expect(a.fills[0]).toMatchObject({ price: '50595', closedPnl: '59', side: 'sell' });
    expect(a.openOrders.map((o) => o.clientId)).toEqual([stop.order.clientId]);
    // the stop fires later with nothing left to reduce: cancelled, never a new short
    await w.next(49_400);
    a = await w.d.paper.get(id);
    expect(a.orders.find((o) => o.clientId === stop.order.clientId)).toMatchObject({ status: 'cancelled' });
    expect(a.positions).toEqual([]); expect(a.openOrders).toEqual([]);

    // a stop that protects a long
    const id2 = await open(w);
    setMarket(w.v, 50_000); w.clock.advance(5_000);
    await market(w, id2, 'buy', '0.1');
    const s2 = await order(w, id2, { side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '49500', price: '49000', reduceOnly: true });
    await w.next(49_600);
    expect((await w.d.paper.get(id2)).openOrders[0]).toMatchObject({ status: 'pending' });
    await w.next(49_400);
    const b = await w.d.paper.get(id2);
    expect(b.orders.find((o) => o.clientId === s2.order.clientId)).toMatchObject({ status: 'filled', avgFillPrice: '49395' });
    expect(b.positions).toEqual([]);
    expect(b.fills[0]).toMatchObject({ price: '49395', closedPnl: '-61' });
  });

  it('funding is applied once per funding time, with the rate the venue published for it; restart-safe', async () => {
    const w = world(), id = await open(w), H = 3_600_000, hour = Math.floor(T0 / H) * H;
    await market(w, id, 'buy', '0.1');
    expect((await stored(id)).meta.fundingCursor).toEqual({ [BTC]: hour });   // the funding time already passed is not owed
    w.v.hl.funding = [];
    expect(await w.next(50_000)).toMatchObject({ funding: 0 });
    // the next funding time passes; the venue publishes its rate 27 ms after the hour
    w.clock.t = hour + H + 10_000; w.v.hl.funding = [{ ts: hour + H + 27, rate: '0.0000125' }]; setMarket(w.v, 50_000);
    expect(await w.step()).toMatchObject({ funding: 1 });
    let a = await w.d.paper.get(id);
    expect(a.funding).toEqual([{ instrument: BTC, amount: '-0.0625', rate: '0.0000125', size: '0.1', ts: hour + H }]);   // a long pays 0.1 × 50000 × 0.0000125
    expect(a.totals.fundingNet).toBe('-0.0625');
    expect(a.positions[0]!.fundingPaid).toBe('0.0625');
    // again, then after a restart: still once
    w.clock.advance(5_000); expect(await w.step()).toMatchObject({ funding: 0 });
    w.restart(); w.clock.advance(5_000); expect(await w.step()).toMatchObject({ funding: 0 });
    expect(await rows(id)).toMatchObject({ funding: 1 });
    expect((await stored(id)).state.funding).toHaveLength(1);
    // the worker was down for three funding times: each is applied once, with its own rate
    w.clock.t = hour + 4 * H + 10_000; setMarket(w.v, 50_000);
    w.v.hl.funding = [1, 2, 3, 4].map((k) => ({ ts: hour + k * H + 40, rate: `0.00001${k}` }));
    expect(await w.step()).toMatchObject({ funding: 3 });
    a = await w.d.paper.get(id);
    expect(a.funding.map((f) => [f.ts, f.rate])).toEqual([[hour + 4 * H, '0.000014'], [hour + 3 * H, '0.000013'], [hour + 2 * H, '0.000012'], [hour + H, '0.0000125']]);
    // a rate the venue has not published yet is waited for, then skipped with a risk event — never invented
    w.clock.t = hour + 5 * H + 10_000; setMarket(w.v, 50_000);
    expect(await w.step()).toMatchObject({ funding: 0 });
    expect((await stored(id)).meta.fundingCursor[BTC]).toBe(hour + 4 * H);
    w.clock.t = hour + 5 * H + 16 * 60_000; setMarket(w.v, 50_000);
    expect(await w.step()).toMatchObject({ funding: 0 });
    expect((await stored(id)).meta.fundingCursor[BTC]).toBe(hour + 5 * H);
    expect((await events(id, 'funding_skipped')).map((e: any) => e.code)).toEqual(['funding_rate_missing']);
    expect(await rows(id)).toMatchObject({ funding: 4 });
    // a closed position owes nothing more
    await w.d.paper.close(id, { instrument: BTC, fraction: '1' });
    expect((await stored(id)).meta.fundingCursor).toEqual({});
  });

  it('margin warning, then simulated liquidation → risk events, positions closed at the mark, orders cancelled', async () => {
    const w = world(), id = await open(w, '1000', LOOSE);
    const r = await market(w, id, 'buy', '0.3', { leverage: '20' });
    expect(r.order.status).toBe('filled');
    const resting = await order(w, id, { side: 'sell', type: 'limit', size: '0.1', price: '50900', reduceOnly: true });
    expect(resting.order.status).toBe('open');
    expect(await w.next(49_000)).toMatchObject({ liquidations: 0 });
    expect(await events(id, 'margin_warning')).toHaveLength(0);
    // equity 331.75 against a maintenance margin of 286.8: inside the warning zone, once
    expect(await w.next(47_800)).toMatchObject({ liquidations: 0 });
    await w.next(47_810);
    const warn = await events(id, 'margin_warning');
    expect(warn).toHaveLength(1);
    expect(warn[0].data).toEqual({ equity: '331.749325', maintenanceMargin: '286.8' });
    // equity 271.75 < 285.6: liquidated at the mark
    expect(await w.next(47_600)).toMatchObject({ liquidations: 1, fills: 1 });
    const a = await w.d.paper.get(id);
    expect(a.positions).toEqual([]); expect(a.openOrders).toEqual([]);
    expect(a.fills[0]).toMatchObject({ liquidation: true, price: '47600', size: '0.3', side: 'sell', closedPnl: '-721.5', orderId: null });
    expect(a.state.collateral).toBe('271.749325');
    expect(a.totals.liquidations).toBe(1);
    expect(a.orders.find((o) => o.clientId === resting.order.clientId)).toMatchObject({ status: 'cancelled', rejectReason: 'account liquidated (simulated)' });
    const liq = await events(id, 'liquidation');
    expect(liq).toHaveLength(1);
    expect(liq[0]).toMatchObject({ code: 'liquidated' });
    expect(liq[0].data.collateralAfter).toBe('271.749325');
    expect(await audits(id)).toContain('deriv.paper.liquidation');
    // the account is flat: the worker has nothing more to do with it, and running again changes nothing
    expect(await w.next(47_000)).toMatchObject({ accounts: 0 });
    expect(await events(id, 'liquidation')).toHaveLength(1);
    expect((await w.d.paper.get(id)).equity.at(-1)).toMatchObject({ equity: '271.749325' });
  });

  it('loss limit → halt: resting orders withdrawn, a new order refused, a reduce-only close accepted; the halt lasts until the policy is replaced', async () => {
    const w = world(), id = await open(w);
    await market(w, id, 'buy', '0.19');
    const lim = await order(w, id, { side: 'buy', type: 'limit', size: '0.01', price: '49500' });
    const tp = await order(w, id, { side: 'sell', type: 'limit', size: '0.19', price: '50900', reduceOnly: true });
    expect(await w.next(49_990, { asks: [['49995', '1']], bids: [['49985', '1']] })).toMatchObject({ halts: 0 });
    // −0.19 × (50005 − 47000) = −570.95 and the fee: beyond the daily limit of 500
    expect(await w.next(47_000, { asks: [['49600', '1']], bids: [['46990', '1']] })).toMatchObject({ halts: 1, liquidations: 0 });
    const s = await stored(id);
    expect(s.policy.halt).toMatch(/^daily loss limit reached: PnL -575\.\d+ against a limit of −500/);
    const ev = await events(id, 'loss_limit');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ code: 'daily_loss_exceeded' });
    expect(ev[0].data.cancelledOrders).toEqual([lim.order.clientId]);
    let a = await w.d.paper.get(id);
    expect(a.orders.find((o) => o.clientId === lim.order.clientId)).toMatchObject({ status: 'cancelled', rejectReason: 'cancelled: trading halted by a loss limit' });
    expect(a.openOrders.map((o) => o.clientId)).toEqual([tp.order.clientId]);                     // the reduce-only order stays
    expect(await audits(id)).toContain('deriv.paper.halt');
    // once: the next steps record nothing more
    await w.next(46_990, { asks: [['47000', '1']], bids: [['46980', '1']] });
    expect(await events(id, 'loss_limit')).toHaveLength(1);
    // new risk is refused …
    expect(await refusal(market(w, id, 'buy', '0.01'))).toMatchObject({ code: 'halted', status: 422 });
    expect(await refusal(market(w, id, 'sell', '0.3'))).toMatchObject({ code: 'halted' });       // a flip is new risk too
    // … closing is not
    const c = await w.d.paper.close(id, { instrument: BTC, fraction: '1' });
    expect(c.order).toMatchObject({ status: 'filled', reduceOnly: true, avgFillPrice: '46980' });
    a = await w.d.paper.get(id);
    expect(a.positions).toEqual([]);
    expect(a.policy.halt).not.toBeNull();
    // the owner lifts the halt: the daily loss itself still refuses new exposure today
    const p = await w.d.paper.setPolicy(id, { ...a.policy, halt: null });
    expect(p.policy.halt).toBeNull();
    expect(await refusal(market(w, id, 'buy', '0.01'))).toMatchObject({ code: 'daily_loss_exceeded', status: 422 });
    const raised = await w.d.paper.setPolicy(id, { ...a.policy, halt: null, maxDailyLoss: '5000' });
    expect(raised.policy.maxDailyLoss).toBe('5000');
    expect((await market(w, id, 'buy', '0.01')).order.status).toBe('filled');
  });

  it('restart mid-flow: a new process between every step ends in exactly the same state', async () => {
    const H = 3_600_000, hour = Math.floor(T0 / H) * H;
    const run = async (restart: boolean) => {
      const w = world(), id = await open(w), hop = () => { if (restart) w.restart(); };
      w.v.hl.funding = [{ ts: hour + H + 31, rate: '0.0000125' }];
      const keys = ['flow-key-0001', 'flow-key-0002', 'flow-key-0003'];
      await order(w, id, { side: 'buy', type: 'market', size: '0.1', slippageBps: 50 }, keys[0]); hop();
      await order(w, id, { side: 'buy', type: 'limit', size: '0.05', price: '49900' }, keys[1]); hop();
      await order(w, id, { side: 'sell', type: 'stop_market', size: '0.1', triggerPrice: '49000', price: '48600', reduceOnly: true }, keys[2]); hop();
      await w.next(49_895, { asks: [['49890', '0.02'], ['49920', '1']], bids: [['49885', '1']] }); hop();
      await order(w, id, { side: 'buy', type: 'market', size: '0.1', slippageBps: 50 }, keys[0]); hop();   // a replayed key
      w.clock.t = hour + H + 2_000; setMarket(w.v, 49_900); await w.step(); hop();
      await w.next(48_900, { asks: [['48905', '1']], bids: [['48895', '1']] }); hop();
      await w.next(48_950); hop();
      const s = await stored(id);
      s.state.account = 'x';
      return { s, n: await rows(id), view: await w.d.paper.get(id) };
    };
    const a = await run(false), b = await run(true);
    expect(b.s).toEqual(a.s);
    expect(b.n).toEqual(a.n);
    expect(b.view.fills.map((f) => [f.id, f.price, f.size, f.fee, f.ts])).toEqual(a.view.fills.map((f) => [f.id, f.price, f.size, f.fee, f.ts]));
    expect(b.view.funding).toEqual(a.view.funding);
    // and the flow did what it was meant to: limit filled in two parts, one funding payment, the stop sold 0.1
    expect(a.n).toMatchObject({ orders: 3, fills: 4, funding: 1 });
    expect(a.view.positions[0]).toMatchObject({ side: 'long', size: '0.05' });
    expect(a.view.orders.map((o) => o.status).sort()).toEqual(['filled', 'filled', 'filled']);
  });

  it('a venue that stops answering: nothing is fed, nothing is invented', async () => {
    const w = world(), id = await open(w);
    await market(w, id, 'buy', '0.1');
    const snap = await stored(id);
    w.v.hl.down = true;
    w.clock.advance(20_000);
    const s = await w.step();
    expect(s).toMatchObject({ accounts: 1, fed: 0, fills: 0 });
    expect(s.errors[0]).toMatch(/hyperliquid/);
    expect(await stored(id)).toEqual(snap);
    w.v.hl.down = false;
    expect(await w.next(50_100)).toMatchObject({ fed: 1 });
    expect((await w.d.paper.get(id)).positions[0]!.markPrice).toBe('50100');
  });
});

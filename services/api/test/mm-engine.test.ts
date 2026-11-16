// Market-making engine, end to end and deterministic: the engine over the live adapter, the REAL isolated-signer code and a
// fake venue replaying a RECORDED Hyperliquid tape (public websocket, BTC, 2026-11-16 — fixtures/mm/hl-btc-tape.json.gz).
// The fake venue enforces what the real one documents: post-only rejection, tick, lot, minimum value, nonce, action expiry,
// the address-based rate limit, the dead man's switch and its trigger count; it verifies every signature against the account's
// API wallet. FILLS ARE MODELLED (queue behind the displayed size; a trade through the quote fills it): see sim-venue.ts.
// Nothing here reaches a network.
import { describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import type { BreakerCode, BreakerConfig, QuotePolicy } from '@spw/trading/mm';
import { createLiveMmAdapter, envMmLocks, MM_MAINNET_LOCK } from '../src/mm/live-adapter.ts';
import { BREAKERS, createWorld, INSTRUMENT, studyPolicy, TAPE, type World, type WorldOptions } from './mm-harness.ts';

const MIN = 60_000;
/** a policy that quotes at once (a fixed volatility instead of the 60 s warm-up), for the scenario tests */
const quick = (over: Parameters<typeof studyPolicy>[0] = {}) => studyPolicy({ fallbackVolBps: 1.5, ...over });
/** a world whose engine has quotes resting on both sides */
async function quoting(o: WorldOptions = {}, seconds = 8): Promise<World> {
  const w = await createWorld({ toMs: 6 * MIN, policy: quick(), ...o });
  w.engine.start();
  await w.run(seconds * 1000);
  return w;
}
const types = (w: World) => w.journal.map((e) => e.type);
const kinds = (w: World) => w.signerCalls.filter((c) => c.ok).map((c) => c.kind);
const venueLog = (w: World, type: string) => w.sim.log.filter((x) => x.type === type);
const bothSides = (w: World) => { const r = w.resting(); expect(r.buy.length, 'a bid rests').toBe(1); expect(r.sell.length, 'an ask rests').toBe(1); return r; };
const nothingRests = (w: World) => { const r = w.resting(); expect(r.buy.length + r.sell.length, 'nothing rests on the venue').toBe(0); };

describe('the recorded tape', () => {
  it('is a recording of the public feed with its provenance: at least 30 minutes, book states and trades, no reconnect gap', () => {
    expect(TAPE.provenance).toMatchObject({ source: 'wss://api.hyperliquid.xyz/ws (public, read-only): channels bbo + trades, coin BTC', reconnectGaps: 0 });
    expect(TAPE.provenance.minutes as number).toBeGreaterThanOrEqual(30);
    expect(TAPE.b.length).toBeGreaterThan(5000); expect(TAPE.t.length).toBeGreaterThan(1000);
    for (const [, bid, , ask] of TAPE.b.slice(0, 2000)) expect(Number(ask)).toBeGreaterThan(Number(bid));
  });
});

describe('start-up, normal quoting, shutdown', () => {
  it('start-up sequence: reconcile → arm the dead man\'s switch → quote; nothing is quoted before the switch is armed', async () => {
    const w = await quoting();
    expect(kinds(w)[0]).toBe('schedule_cancel');                                                       // the first signature of the session
    expect(w.sim.log[0]).toMatchObject({ type: 'scheduleCancel', result: 'ok' });                       // … and the first action the venue saw
    expect(w.sim.log.findIndex((x) => x.type === 'order')).toBeGreaterThan(0);
    expect(types(w).slice(0, 3)).toEqual(['mm.start', 'mm.quoting', 'mm.quote']);
    bothSides(w);
    expect(w.sim.scheduledAt()).toBeGreaterThan(w.sim.now + 12_000);
    expect(w.engine.status()).toMatchObject({ phase: 'quoting', position: '0', blockedSides: [], activeBreakers: [] });
  });

  it('normal quoting on five minutes of tape: one quote per side, each on its side of the mid, post-only, the switch always armed, the signer never refuses, the venue never rejects', async () => {
    const w = await createWorld({ toMs: 6 * MIN, policy: quick() });
    w.engine.start();
    let checks = 0;
    await w.run(5 * MIN, 1000, () => {
      const r = w.resting(), mid = w.midNumber();
      expect(r.buy.length).toBeLessThanOrEqual(1); expect(r.sell.length).toBeLessThanOrEqual(1);
      for (const o of r.buy) expect(Number(o.px)).toBeLessThan(mid);
      for (const o of r.sell) expect(Number(o.px)).toBeGreaterThan(mid);
      if (r.buy.length + r.sell.length > 0) { expect(w.sim.scheduledAt(), 'orders rest: the switch is armed').not.toBeNull(); expect(w.sim.scheduledAt()!).toBeGreaterThan(w.sim.now); checks += 1; }
      expect(Math.abs(Number(w.sim.positionSize()))).toBeLessThanOrEqual(0.0015 + 1e-9);                 // the engine's hard limit
    });
    expect(checks).toBeGreaterThan(250);
    const c = w.engine.status().counters;
    expect(c.quoteBatches).toBeGreaterThan(10); expect(c.signerRefusals).toBe(0); expect(c.venueRejects).toBe(0); expect(c.unknownOutcomes).toBe(0);
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);
    expect(w.sim.triggersToday()).toBe(0);                                                             // the switch never fired
    expect(venueLog(w, 'order').every((x) => x.result === 'ok')).toBe(true);
    // every quote the venue took was post-only, and the signer read the venue itself for each batch
    expect(w.infoCalls.filter((t) => t === 'frontendOpenOrders').length).toBeGreaterThanOrEqual(c.quoteBatches!);
    // hysteresis: far fewer requotes than ticks
    expect(c.quoteBatches!).toBeLessThan(c.ticks! / 2);
    // the address budget moved as documented: one request per order, per cancel, per heartbeat
    expect(w.sim.rateLimit().nRequestsUsed).toBe(venueLog(w, 'order').reduce((s, x) => s + x.n, 0) + venueLog(w, 'scheduleCancel').length);
  }, 60_000);

  it('shutdown: cancel-all → reconcile → disarm; nothing rests, the switch is removed without firing', async () => {
    const w = await quoting();
    bothSides(w);
    w.engine.stop();
    await w.run(6000);
    nothingRests(w);
    expect(w.engine.status().phase).toBe('stopped');
    expect(w.sim.scheduledAt()).toBeNull(); expect(w.sim.triggersToday()).toBe(0);
    expect(w.events('mm.stopped')[0]).toMatchObject({ disarmed: true });
    expect(kinds(w).slice(-2)).toEqual(['cancel', 'schedule_cancel']);
    await w.run(5000); expect(w.sim.log.at(-1)!.type).toBe('scheduleCancel');                           // a stopped engine sends nothing more
  });
});

describe('inventory', () => {
  it('skew: with a long inventory both quotes sit lower — the bid further from the mid than the ask; short, the mirror', async () => {
    const dist = async (startPosition: string) => {
      const w = await quoting({ startPosition, engine: { planner: { requoteToleranceBps: '0.2', sizeToleranceBps: '5000', maxRestingPerSide: 1, softInventory: '0.0012', hardInventory: '0.0015', reduceSlippageBps: '5', maxReduceSize: '0.0006' } } });
      const r = bothSides(w), mid = w.midNumber();
      return { bid: (mid - Number(r.buy[0]!.px)) / mid * 1e4, ask: (Number(r.sell[0]!.px) - mid) / mid * 1e4 };
    };
    const long = await dist('0.0006'), short = await dist('-0.0006'), flat = await dist('0');
    expect(long.bid).toBeGreaterThan(long.ask + 1);                                                    // about 2 lots × gamma·sigma²·tau = 2 × 2.7 bps of reservation shift
    expect(short.ask).toBeGreaterThan(short.bid + 1);
    expect(Math.abs(flat.bid - flat.ask)).toBeLessThan(1);
    expect(long.ask).toBeGreaterThanOrEqual(1.1); expect(short.bid).toBeGreaterThanOrEqual(1.1);       // never inside the floor
  });
  it('soft limit: the side that would add is not quoted', async () => {
    const w = await quoting({ startPosition: '0.001' });                                               // soft 0.0009
    const r = w.resting();
    expect(r.buy).toHaveLength(0); expect(r.sell).toHaveLength(1);
  });
  it('hard limit: quotes are pulled and the excess is unwound with reduce-only orders that the signer signs and the venue fills', async () => {
    const w = await quoting({ startPosition: '0.002' }, 15);                                           // hard 0.0015, soft 0.0009
    expect(kinds(w)).toContain('reduce');
    expect(Number(w.sim.positionSize())).toBeLessThanOrEqual(0.0009 + 1e-9);
    expect(Number(w.sim.positionSize())).toBeGreaterThan(0);                                           // down to the soft limit, not flat
    const taker = w.sim.fills.filter((f) => f.crossed);
    expect(taker.length).toBeGreaterThanOrEqual(2);                                                    // in chunks of at most 0.0006
    for (const f of taker) expect(f.side).toBe('A');
    expect((w.events('mm.reduce')[0]!.orders as unknown[]).length).toBe(2);                            // ONE batch of two reduce-only orders
    expect(w.signerJournal('venue.quoting.sign.ok').filter((j) => (j.data as { kind: string }).kind === 'reduce').length).toBeGreaterThanOrEqual(1);
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);
    // once under the soft limit, the reducing side is quoted again
    await w.run(10_000);
    expect(w.resting().sell.length).toBe(1);
  });
});

describe('circuit breakers: each one pulls the quotes', () => {
  const cases: [BreakerCode, { cfg?: Partial<BreakerConfig>; engine?: object; act?: (w: World) => void | Promise<void>; seconds?: number; halted?: boolean }][] = [
    ['data_stale', { act: (w) => { w.flags.freezeBook = w.sim.top(); } }],
    ['venue_disconnected', { act: (w) => { w.flags.status = 'reconnecting'; } }],
    ['book_crossed', { act: (w) => { w.flags.bookOverride = () => ({ ...w.sim.top(), bid: w.sim.top().ask, ask: w.sim.top().bid }); } }],
    ['spread_blowout', { act: (w) => { w.flags.bookOverride = () => { const t = w.sim.top(); return { ...t, bid: D.str(D.sub(D.from(t.bid), D.from('100'))), ask: D.str(D.add(D.from(t.ask), D.from('100'))) }; }; } }],
    ['book_thin', { cfg: { minTopDepthUsd: '500' }, act: (w) => { w.flags.bookOverride = () => ({ ...w.sim.top(), askSize: '0.00001' }); } }],
    ['vol_spike', { cfg: { maxVolBps: 0.000001 }, engine: { vol: { intervalMs: 1000, lambda: 0.97, warmup: 2 } }, seconds: 30 }],
    ['fill_burst', { cfg: { fillBurstCount: 0 }, act: (w) => { w.sim.injectTrade('A', D.str(D.sub(D.from(w.sim.top().bid), D.from('500'))), '1'); } }],
    ['adverse_selection', { cfg: { minMarkoutBps: '1000', markoutSample: 1 }, act: (w) => { w.sim.injectTrade('A', D.str(D.sub(D.from(w.sim.top().bid), D.from('500'))), '1'); }, seconds: 25 }],
    ['consecutive_rejects', { act: (w) => { w.flags.riskDeny = 'limit_test'; }, cfg: { consecutiveRejects: 3 }, engine: { planner: { requoteToleranceBps: '0.01', sizeToleranceBps: '5000', maxRestingPerSide: 1, softInventory: '0.0009', hardInventory: '0.0015', reduceSlippageBps: '5', maxReduceSize: '0.0006' } }, seconds: 120, halted: true }],
    ['drawdown_session', { act: (w) => { w.sim.injectTrade('A', D.str(D.sub(D.from(w.sim.top().bid), D.from('500'))), '1'); }, cfg: { maxSessionLossUsd: '-0.0000001' }, halted: true }],
    ['kill_switch', { act: (w) => { w.flags.kill = true; } }],
  ];
  for (const [code, c] of cases) {
    it(`${code}`, async () => {
      const w = await quoting({ engine: { breakers: { ...BREAKERS, ...c.cfg }, ...c.engine } }, c.cfg && !c.act ? 3 : 8);
      const batchesBefore = venueLog(w, 'order').length;
      await c.act?.(w);
      await w.run((c.seconds ?? 12) * 1000);
      expect(w.events('mm.breaker').map((e) => e.code)).toContain(code);
      nothingRests(w);
      const s = w.engine.status();
      expect(s.activeBreakers).toContain(code);
      expect(s.phase).toBe(c.halted ? 'halted' : 'pulled');
      if (c.halted) expect(s.halted).toBe(code);
      // nothing was quoted after the breaker tripped
      const tripAt = w.events('mm.breaker').find((e) => e.code === code)!.ts;
      expect(w.events('mm.quote').filter((e) => e.ts > tripAt)).toHaveLength(0);
      if (c.act && code !== 'consecutive_rejects' && code !== 'adverse_selection') expect(venueLog(w, 'order').length - batchesBefore).toBeLessThanOrEqual(1);
    }, 30_000);
  }
  it('a transient breaker clears after its cool-down and the engine quotes again; a halt needs an operator', async () => {
    const w = await quoting();
    w.flags.status = 'reconnecting'; await w.run(5000); nothingRests(w);
    w.flags.status = 'connected'; await w.run(10_000); nothingRests(w);                                 // cooling down (15 s)
    await w.run(12_000); bothSides(w);
    expect(types(w)).toContain('mm.quoting_again');
    const h = await quoting({ engine: { breakers: { ...BREAKERS, maxSessionLossUsd: '1000' } } }, 3);   // "lost" at once
    expect(h.engine.status().phase).toBe('halted');
    await h.run(40_000); nothingRests(h);
    h.engine.resume(); await h.run(2000);
    expect(h.engine.status().phase).toBe('halted');                                                    // the cause is still there: it halts again
  });
  it('kill switch with the flatten policy: quotes pulled at the same cycle, the inventory unwound reduce-only — reductions stay possible', async () => {
    const w = await quoting({ startPosition: '0.0006', engine: { breakers: { ...BREAKERS, action: { kill_switch: 'flatten' } } } });
    expect(w.resting().buy.length + w.resting().sell.length).toBeGreaterThan(0);
    w.flags.kill = true;
    await w.run(1000);
    nothingRests(w);                                                                                    // one cycle
    await w.run(8000);
    expect(w.sim.positionSize()).toBe('0');
    expect(kinds(w)).toContain('reduce');
    expect(w.events('mm.quote').filter((e) => e.ts > w.events('mm.breaker')[0]!.ts)).toHaveLength(0);
  });
});

describe('the venue is unreachable with resting orders: the dead man\'s switch fires at the venue', () => {
  it('the engine can neither cancel nor renew; the venue cancels everything at the last deadline it took; afterwards the engine reconciles, re-arms and quotes again', async () => {
    const w = await quoting();
    bothSides(w);
    const deadline = w.sim.scheduledAt()!;
    w.sim.down = true; w.flags.status = 'reconnecting';
    await w.run(deadline - w.sim.now - 1000);
    const left = w.sim.openCount();                                                                     // one second before: nothing could be cancelled (the tape may have FILLED a quote meanwhile — the market does not stop)
    expect(left).toBeGreaterThanOrEqual(1); expect(left).toBe(2 - w.sim.fills.length);
    expect(w.events('mm.cancel_failed').length).toBeGreaterThan(0);
    await w.run(2000);
    nothingRests(w);
    expect(w.sim.triggersToday()).toBe(1);
    expect(w.sim.log.find((x) => x.type === 'scheduleCancel.fired')).toMatchObject({ n: left });
    expect(Math.max(...w.sim.log.filter((x) => x.type === 'scheduleCancel.fired').map((x) => x.t))).toBeLessThanOrEqual(deadline);
    // the venue is back
    w.sim.down = false; w.flags.status = 'connected';
    await w.run(30_000);
    bothSides(w);
    expect(w.engine.status().orders.every((o) => o.state === 'resting')).toBe(true);
    expect(w.sim.scheduledAt()).toBeGreaterThan(w.sim.now);
    // the two cancelled orders are known to the venue as cancelled by the switch
    const statuses = await Promise.all(w.events('mm.quote').flatMap((e) => e.quotes as { clientId: string }[]).map(async (q) => ((await w.sim.info({ type: 'orderStatus', user: w.mandate.account, oid: q.clientId })) as { order: { status: string } }).order.status));
    expect(statuses.filter((x) => x === 'scheduledCancel')).toHaveLength(left);
  }, 30_000);
});

describe('an action of unknown outcome is reconciled, never resent', () => {
  const failFirstOrder = (w: World, mode: 'lost_after_apply' | 'lost_before_apply' | 'garbage') => { let done = false; w.flags.onExchange = (body) => { if (!done && body.action.type === 'order') { done = true; w.sim.failNextExchange = mode; } }; };
  for (const mode of ['lost_after_apply', 'garbage'] as const) {
    it(`the answer to a quote batch is lost AFTER the venue took it (${mode}): the orders exist — the engine finds them by client id and does not place them twice`, async () => {
      const w = await createWorld({ toMs: 6 * MIN, policy: quick() });
      failFirstOrder(w, mode);
      w.engine.start();
      await w.run(1000);
      bothSides(w);                                                                                     // on the venue …
      expect(w.engine.status()).toMatchObject({ blockedSides: ['buy', 'sell'], counters: { unknownOutcomes: 1 } });   // … and not known to the engine
      expect(w.engine.status().orders.map((o) => o.state)).toEqual(['unknown', 'unknown']);
      await w.run(4000, 1000, () => { const r = w.resting(); expect(r.buy.length).toBeLessThanOrEqual(1); expect(r.sell.length).toBeLessThanOrEqual(1); });
      expect(venueLog(w, 'order')).toHaveLength(1);                                                     // ONE batch reached the venue: no resend
      expect(w.engine.status()).toMatchObject({ blockedSides: [] });
      expect(w.engine.status().orders.map((o) => o.state)).toEqual(['resting', 'resting']);
      expect(types(w)).toContain('mm.outcome_unknown'); expect(w.events('mm.side_unblocked')).toHaveLength(2);
    });
  }
  it('the batch never reached the venue: the engine does not assume so — it waits until the signed action can no longer be accepted, then quotes again', async () => {
    const w = await createWorld({ toMs: 6 * MIN, policy: quick() });
    failFirstOrder(w, 'lost_before_apply');
    w.engine.start();
    await w.run(14_000, 1000, () => nothingRests(w));
    expect(venueLog(w, 'order')).toHaveLength(0);                                                       // nothing was sent again for 14 s (validity 10 s + 5 s)
    expect(w.engine.status().blockedSides).toEqual(['buy', 'sell']);
    await w.run(4000);
    bothSides(w);
    expect(w.events('mm.reconciled_order').map((e) => e.venue)).toEqual(['never_placed', 'never_placed']);
    expect(venueLog(w, 'order')).toHaveLength(1);
  });
  it('the API process dies with orders resting: a new engine assumes orders may rest — cancel-all → reconcile → arm → quote; nothing of the old session is left', async () => {
    const w = await quoting();
    const old = bothSides(w), oldIds = new Set([...old.buy, ...old.sell].map((o) => (o as unknown as { cloid: string }).cloid));
    const before = w.signerCalls.length;
    w.engine = w.makeEngine({ sessionId: '00000000000000b2' });                                         // the old engine is gone, with everything it knew
    w.engine.start();
    await w.run(3000);
    expect(w.signerCalls.slice(before).filter((c) => c.ok).map((c) => c.kind).slice(0, 3)).toEqual(['cancel', 'schedule_cancel', 'quotes']);
    expect(w.events('mm.adopted_order')).toHaveLength(2);
    const now = bothSides(w);
    for (const o of [...now.buy, ...now.sell]) expect(oldIds.has((o as unknown as { cloid: string }).cloid)).toBe(false);
    expect((now.buy[0] as unknown as { cloid: string }).cloid.startsWith('0x00000000000000b2')).toBe(true);
  });
  it('a crash while the venue is also down: the switch still protects — the venue cancels at the deadline with no engine alive', async () => {
    const w = await quoting();
    bothSides(w);
    const deadline = w.sim.scheduledAt()!;
    w.sim.advance(deadline + 1);                                                                        // nobody ticks
    nothingRests(w);
    expect(w.sim.triggersToday()).toBe(1);
  });
});

describe('the signer is down, or refuses', () => {
  it('signer down: no quote and no cancel can be signed, the heartbeat stops — the venue cancels at the deadline; when the signer is back the session resumes, and the signer counted the lapse', async () => {
    const w = await quoting();
    bothSides(w);
    const deadline = w.sim.scheduledAt()!, quotesBefore = w.events('mm.quote').length;
    w.flags.signerDown = true;
    await w.run(deadline - w.sim.now + 1000);
    nothingRests(w);
    expect(w.sim.triggersToday()).toBe(1);
    expect(w.events('mm.quote').length).toBe(quotesBefore);
    expect(w.events('mm.cancel_failed').some((e) => e.code === 'signer_unreachable')).toBe(true);
    expect(w.events('mm.pulled').map((e) => e.why)).toContain('no quoting mandate');
    w.flags.signerDown = false;
    await w.run(25_000);
    bothSides(w);
    expect(w.signer.status().venueQuotingMandates[0]!.today.lapses).toBe(1);
  }, 30_000);

  const refusedBy = async (policy: QuotePolicy, code: string, o: WorldOptions = {}) => {
    const w = await createWorld({ toMs: 6 * MIN, policy, engine: { planner: { requoteToleranceBps: '1.5', sizeToleranceBps: '5000', maxRestingPerSide: 2, softInventory: '0.01', hardInventory: '0.02', reduceSlippageBps: '5', maxReduceSize: '0.0006' } }, ...o });
    w.engine.start();
    await w.run(30_000);
    nothingRests(w);                                                                                    // the signer is the last line, and it held
    expect(venueLog(w, 'order')).toHaveLength(0);                                                       // nothing even reached the venue
    expect(w.events('mm.batch_refused').length).toBeGreaterThanOrEqual(5);
    for (const e of w.events('mm.batch_refused')) expect(e).toMatchObject({ stage: 'signer', code: `signer_${code}` });
    expect(w.signerJournal('venue.quoting.sign.denied').every((j) => (j.data as { code: string }).code === code)).toBe(true);
    expect(w.engine.status()).toMatchObject({ phase: 'halted', halted: 'consecutive_rejects', position: '0' });
    return w;
  };
  it('a buggy policy that quotes at the touch (0.08 bps from the mid): the signer refuses every batch — too tight', async () => {
    await refusedBy({ id: 'buggy_touch', version: '0', quotes: (i) => ({ quotes: [{ side: 'buy', price: i.book.bid, size: '0.0003', level: 0 }, { side: 'sell', price: i.book.ask, size: '0.0003', level: 0 }], diagnostics: {}, notes: [] }) }, 'quote_too_tight');
  });
  it('a buggy policy that quotes ten times the size: refused — above the mandate\'s size per quote', async () => {
    await refusedBy(studyPolicy({ fallbackVolBps: 1.5, lotUsd: '200' }), 'quote_notional');
  });
  it('a buggy policy that ladders far more than the mandate lets rest: refused — worst-case inventory / resting notional', async () => {
    const ladder: QuotePolicy = { id: 'buggy_ladder', version: '0', quotes: (i) => ({ quotes: [0, 1].flatMap((level) => [{ side: 'buy' as const, price: D.str(D.sub(D.from(i.book.bid), D.from(String(20 + 10 * level)))), size: '0.0006', level }]), diagnostics: {}, notes: [] }) };
    await refusedBy(ladder, 'resting_notional', { instrument: { maxQuoteNotional: '40', maxRestingNotionalPerSide: '60' } });
    await refusedBy(ladder, 'inventory_exceeded', { instrument: { maxQuoteNotional: '40', maxRestingNotionalPerSide: '80', maxInventoryNotional: '70' }, mandate: { maxGrossExposure: '300' } });
  });
  it('the signer\'s mid is not the venue\'s: with the venue 5 bps above the signer\'s price, a correct bid is THROUGH the signer\'s mid and is refused — the cost of an independent price', async () => {
    const w = await createWorld({ toMs: 6 * MIN, policy: quick() });
    w.flags.priceOffsetBps = -5;
    w.engine.start();
    await w.run(20_000);
    expect(w.signerJournal('venue.quoting.sign.denied').map((j) => (j.data as { code: string }).code)).toContain('quote_crosses_mid');
    nothingRests(w);                                                                                    // a batch is refused whole: the ask does not go either
  });
});

describe('mandate expiry mid-session, and rates', () => {
  it('the mandate expires while quotes rest: the engine pulls them (cancels are signed during the wind-down); a quote asked directly is refused by the signer', async () => {
    const w = await quoting({ mandateSeconds: 40 }, 30);
    bothSides(w);
    await w.run(15_000);
    nothingRests(w);
    expect(w.events('mm.pulled').map((e) => e.why)).toContain('mandate wind_down: wind-down');
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);                               // the engine did not even ask
    const direct = await w.adapter.submitQuotes(INSTRUMENT, [{ clientId: `0x${'c'.repeat(32)}`, side: 'buy', price: D.str(D.sub(D.from(w.sim.top().bid), D.from('20'))), size: '0.0003' }]);
    expect(direct).toMatchObject({ kind: 'refused', stage: 'signer', code: 'signer_wind_down' });
    expect(await w.adapter.cancel(INSTRUMENT, [`0x${'d'.repeat(32)}`])).toMatchObject({ kind: 'done', results: [{ outcome: 'gone' }] });   // cancels still pass
    expect((await w.adapter.scheduleCancel(w.sim.now + 20_000)).kind).toBe('done');
  });
  it('address rate limit of the venue at the engine\'s reserve: no quote is sent — before the venue throttles; the heartbeat continues inside the reserve', async () => {
    const w = await createWorld({ toMs: 6 * MIN, policy: quick(), startUsed: 9500, engine: { rateEveryMs: 2000, planner: { requoteToleranceBps: '0.05', sizeToleranceBps: '5000', maxRestingPerSide: 1, softInventory: '0.0009', hardInventory: '0.0015', reduceSlippageBps: '5', maxReduceSize: '0.0006' } } });
    w.engine.start();                                                                                   // 500 requests left = the reserve (how the budget THINS before that: cycleBudget, packages/trading/test/mm.test.ts)
    await w.run(60_000);
    expect(w.sim.log.filter((x) => x.result === 'rate_limited')).toHaveLength(0);                       // the venue never had to refuse
    expect(w.events('mm.degraded').map((e) => e.reason)).toContain('address rate limit: reserve reached');
    expect(w.events('mm.quote')).toHaveLength(0); expect(venueLog(w, 'order')).toHaveLength(0);
    expect(venueLog(w, 'scheduleCancel').length).toBeGreaterThanOrEqual(6);                             // the heartbeat goes on (one request each, out of the reserve)
    expect(w.sim.rateLimit().nRequestsCap - w.sim.rateLimit().nRequestsUsed).toBeGreaterThan(480);
    nothingRests(w);
  }, 30_000);
  it('the signer\'s own rate (token bucket): the engine reads what is left and never asks for more — the signer never has to refuse', async () => {
    const w = await createWorld({ toMs: 6 * MIN, policy: quick(), mandate: { rate: { burstActions: 2, actionsPerMinute: 2, ordersPerHour: 3600, ordersPerDay: 20_000, dailyTurnover: '500000' } },
      engine: { planner: { requoteToleranceBps: '0.05', sizeToleranceBps: '5000', maxRestingPerSide: 1, softInventory: '0.0009', hardInventory: '0.0015', reduceSlippageBps: '5', maxReduceSize: '0.0006' } } });
    w.engine.start();
    await w.run(3 * MIN);
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);
    const batches = w.engine.status().counters.quoteBatches!;
    expect(batches).toBeGreaterThanOrEqual(4); expect(batches).toBeLessThanOrEqual(2 + 2 * 3);         // burst 2 + 2 a minute
    expect(w.events('mm.degraded').map((e) => e.reason)).toContain('signer rate: used');
  }, 30_000);
});

describe('the live adapter and the three mainnet locks', () => {
  const make = (env: Record<string, string | undefined>) => {
    const signed: string[] = [], sent: string[] = [];
    const adapter = createLiveMmAdapter({ network: 'mainnet', account: `0x${'11'.repeat(20)}`, mandateId: 'm', now: () => 1_794_800_000_000, locks: envMmLocks(env),
      signer: { venueQuotingSign: async (p) => { signed.push(((p.sign.payload as { action: { type: string } }).action).type); return { signature: { r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, v: 27 }, signer: '0x', kind: 'x', hash: '', mandateId: 'm', phase: 'active', orders: 1 }; } },
      venue: { exchange: async (body) => { const t = (body as { action: { type: string; cancels?: unknown[]; orders?: unknown[] } }).action; sent.push(t.type); return t.type === 'scheduleCancel' ? { status: 'ok', response: { type: 'default' } } : { status: 'ok', response: { type: t.type, data: { statuses: t.type === 'order' ? [{ resting: { oid: 5 } }] : ['success'] } } }; }, info: async () => [] } });
    return { adapter, signed, sent };
  };
  const q = [{ clientId: `0x${'a'.repeat(32)}`, side: 'buy' as const, price: '64990', size: '0.0003' }];
  const ALL = { SPW_DERIV_LIVE_MAINNET: 'on', SPW_DERIV_MANDATE_MAINNET: 'on', [MM_MAINNET_LOCK]: 'on' };
  it('SPW_DERIV_MM_MAINNET is a third lock, off by default: with ANY of the three off, a quote is refused with a precise code before anything is signed', async () => {
    expect(MM_MAINNET_LOCK).toBe('SPW_DERIV_MM_MAINNET');
    for (const [env, code] of [[{}, 'mainnet_disabled'], [{ ...ALL, SPW_DERIV_LIVE_MAINNET: undefined }, 'mainnet_disabled'], [{ ...ALL, SPW_DERIV_MANDATE_MAINNET: 'off' }, 'mandate_mainnet_disabled'], [{ ...ALL, [MM_MAINNET_LOCK]: undefined }, 'mm_mainnet_disabled'],
      [{ ...ALL, [MM_MAINNET_LOCK]: 'true' }, 'mm_mainnet_disabled'], [{ SPW_DERIV_LIVE_MAINNET: 'on', SPW_DERIV_MANDATE_MAINNET: 'on' }, 'mm_mainnet_disabled']] as const) {
      const { adapter, signed, sent } = make(env);
      expect(await adapter.submitQuotes(INSTRUMENT, q), JSON.stringify(env)).toMatchObject({ kind: 'refused', stage: 'lock', code });
      expect(signed).toEqual([]); expect(sent).toEqual([]);
    }
  });
  it('with the locks off, cancels, reduce-only orders and the dead man\'s switch still pass: a lock never blocks a way out', async () => {
    const { adapter, signed, sent } = make({});
    expect(await adapter.cancel(INSTRUMENT, [q[0]!.clientId])).toEqual({ kind: 'done', results: [{ clientId: q[0]!.clientId, outcome: 'cancelled' }] });
    expect(await adapter.submitReduces(INSTRUMENT, [{ ...q[0]!, side: 'sell' }])).toMatchObject({ kind: 'done', results: [{ outcome: 'resting' }] });
    expect(await adapter.scheduleCancel(1_794_800_020_000)).toEqual({ kind: 'done' });
    expect(await adapter.scheduleCancel(null)).toEqual({ kind: 'done' });
    expect(signed).toEqual(['cancelByCloid', 'order', 'scheduleCancel', 'scheduleCancel']); expect(sent).toEqual(signed);
  });
  it('all three on: the quote is built post-only, signed and sent; the locks are read at every use', async () => {
    const env: Record<string, string | undefined> = { ...ALL }, { adapter, sent } = make(env);
    expect(await adapter.submitQuotes(INSTRUMENT, q)).toEqual({ kind: 'done', results: [{ clientId: q[0]!.clientId, outcome: 'resting', venueOrderId: '5' }] });
    env[MM_MAINNET_LOCK] = 'off';
    expect(await adapter.submitQuotes(INSTRUMENT, q)).toMatchObject({ kind: 'refused', code: 'mm_mainnet_disabled' });
    expect(sent).toEqual(['order']);
  });
  it('outcomes: a signer refusal or an unreachable signer is `refused` (nothing was sent); a lost or unreadable venue answer is `unknown`; an off-grid price is refused here, never rounded', async () => {
    const base = { network: 'testnet' as const, account: `0x${'11'.repeat(20)}`, mandateId: 'm', now: () => 1_794_800_000_000, locks: envMmLocks({}) };
    const okSig = async () => ({ signature: { r: `0x${'1'.repeat(64)}` as const, s: `0x${'2'.repeat(64)}` as const, v: 27 }, signer: '0x', kind: 'x', hash: '', mandateId: 'm', phase: 'active', orders: 1 });
    const venue = (exchange: () => Promise<unknown>) => ({ exchange, info: async () => [] });
    const denied = createLiveMmAdapter({ ...base, signer: { venueQuotingSign: async () => { throw Object.assign(new Error('worst-case inventory …'), { code: 'inventory_exceeded' }); } }, venue: venue(async () => { throw new Error('must not be called'); }) });
    expect(await denied.submitQuotes(INSTRUMENT, q)).toMatchObject({ kind: 'refused', stage: 'signer', code: 'signer_inventory_exceeded' });
    const down = createLiveMmAdapter({ ...base, signer: { venueQuotingSign: async () => { throw new Error('ECONNREFUSED'); } }, venue: venue(async () => ({})) });
    expect(await down.cancel(INSTRUMENT, [q[0]!.clientId])).toMatchObject({ kind: 'refused', stage: 'signer', code: 'signer_unreachable' });
    const lost = createLiveMmAdapter({ ...base, signer: { venueQuotingSign: okSig }, venue: venue(async () => { throw new Error('timeout'); }) });
    expect((await lost.submitQuotes(INSTRUMENT, q)).kind).toBe('unknown'); expect((await lost.scheduleCancel(1_794_800_020_000)).kind).toBe('unknown');
    const garbage = createLiveMmAdapter({ ...base, signer: { venueQuotingSign: okSig }, venue: venue(async () => '<html>') });
    expect((await garbage.submitQuotes(INSTRUMENT, q)).kind).toBe('unknown'); expect((await garbage.cancel(INSTRUMENT, [q[0]!.clientId])).kind).toBe('unknown');
    const whole = createLiveMmAdapter({ ...base, signer: { venueQuotingSign: okSig }, venue: venue(async () => ({ status: 'err', response: 'Too many cumulative requests sent (10001 > 10000) for cumulative volume traded $0.00.' })) });
    expect(await whole.submitQuotes(INSTRUMENT, q)).toMatchObject({ kind: 'refused', stage: 'venue', code: 'rate_limited' });
    const alo = createLiveMmAdapter({ ...base, signer: { venueQuotingSign: okSig }, venue: venue(async () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Post only order would have immediately matched, bbo was 64990@64991.' }] } } })) });
    expect(await alo.submitQuotes(INSTRUMENT, q)).toMatchObject({ kind: 'done', results: [{ outcome: 'rejected', code: 'post_only_would_cross' }] });
    expect(await lost.submitQuotes(INSTRUMENT, [{ ...q[0]!, price: '64990.55' }])).toMatchObject({ kind: 'refused', code: 'not_buildable' });
    expect(await lost.submitQuotes('hyperliquid:DOGE', q).catch((e: Error) => e.message)).toMatch(/not in the pinned/);
  });
});

describe('the whole recorded session — a SIMULATION with a modelled queue, reported as it came out', () => {
  it('36 minutes of BTC, the lab study\'s policy (gamma 0.1, tau 12 × 5 s, kappa 0.69), 20 USD quotes, maker fee 1.5 bps: fills on both sides, adverse markouts, a small negative PnL', async () => {
    const w = await createWorld({ policy: studyPolicy() });
    w.engine.start();
    let worstInventory = 0;
    await w.run(TAPE.b.at(-1)![0] - 40_000, 1000, () => { worstInventory = Math.max(worstInventory, Math.abs(Number(w.sim.positionSize()))); });
    w.engine.stop();
    for (let k = 0; k < 40 && w.engine.status().phase !== 'stopped'; k++) await w.run(1000);            // the shutdown sequence, and not a tick more: the engine and the venue are compared at the same instant
    const s = w.engine.status(), buys = w.sim.fills.filter((f) => f.side === 'B').length, sells = w.sim.fills.filter((f) => f.side === 'A').length;
    console.log(`[mm simulation] ${JSON.stringify({ minutes: TAPE.provenance.minutes, counters: s.counters, pnl: s.pnl, markouts: s.markouts, fills: { buys, sells }, worstInventory, addressRequests: w.sim.rateLimit(), signerVenueReads: w.infoCalls.length, switchTriggers: w.sim.triggersToday() })}`);
    // the machinery held for the whole session
    expect(s.phase).toBe('stopped'); nothingRests(w); expect(w.sim.scheduledAt()).toBeNull();
    expect(w.signerJournal('venue.quoting.sign.denied')).toHaveLength(0);
    expect(s.counters).toMatchObject({ signerRefusals: 0, venueRejects: 0, unknownOutcomes: 0, riskRefusals: 0 });
    expect(w.sim.triggersToday()).toBe(0);
    expect(worstInventory).toBeLessThanOrEqual(0.0015 + 1e-9);
    expect(w.sim.log.filter((x) => x.result === 'rate_limited' || x.result === 'expired')).toHaveLength(0);
    // fills on both sides (modelled), every one as a maker
    expect(buys).toBeGreaterThan(5); expect(sells).toBeGreaterThan(5); expect(w.sim.fills.every((f) => !f.crossed)).toBe(true);
    expect(s.pnl.fills).toBe(w.sim.fills.length);
    // the attribution adds up to what the venue's own account says happened (the venue rounds each fee to 8 decimals)
    const venueChange = Number(w.sim.accountValue()) - 1000;
    expect(Number(s.pnl.totalUsd)).toBeCloseTo(venueChange, 6);
    expect(Number(s.pnl.spreadCaptureUsd) + Number(s.pnl.inventoryPnlUsd) + Number(s.pnl.feesUsd)).toBeCloseTo(Number(s.pnl.totalUsd), 9);
    // fees at the base tier: 1.5 bps of the volume, paid
    expect(Number(s.pnl.feesUsd)).toBeCloseTo(-0.00015 * Number(s.pnl.volumeUsd), 4);
    // the result (the run is deterministic): NEGATIVE, as in the lab's study — and adversely selected at every horizon
    expect(Number(s.pnl.totalUsd)).toBeLessThan(0);
    for (const m of s.markouts) { expect(m.fills).toBeGreaterThan(20); expect(Number(m.meanBps)).toBeLessThan(0); }
    expect(Number(s.pnl.bpsOfVolume)).toBeGreaterThan(-5); expect(Number(s.pnl.bpsOfVolume)).toBeLessThan(0);
  }, 120_000);
});

// The stream engine (market making, cross-exchange, funding arbitrage) against PostgreSQL, fed by the REAL Hyperliquid stream
// client replaying frames RECORDED from mainnet (packages/derivatives/test/fixtures/hyperliquid/mainnet-ws.json: two l2Book
// frames 5.5 s apart and the asset contexts between them) through an injected socket. Between the two recorded books the
// market fell by about 10 USD: with a tight quote the second REAL book trades through the bid placed on the first — a fill of
// the paper model on recorded data, not on a scripted price.
//   freshness: no decision on an old book · gap: the socket drops → quoting pauses → reconnect → decisions resume
//   recording: top of book + mark + funding per cadence slot, the holes accounted for · replay: the backtest on those rows
//   modes: research stores the decision and places nothing; paper goes through the order gateway into a simulated book
// The second venue of the cross-exchange test is NOT recorded: it is the recorded Hyperliquid book shifted by a stated amount.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHlStream, type HlStreamEvent, type HlWebSocketLike } from '../../../packages/derivatives/src/venues/hyperliquid/index.ts';
import type { Book, Instrument, Ticker } from '@spw/derivatives';
import { Clock, fixtureVenues } from './derivatives-helpers.ts';
import { useTestDatabase } from './test-db.ts';

class FakeSocket implements HlWebSocketLike {
  static all: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null; onclose: ((ev: unknown) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
  sent: any[] = []; closed = false;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string): void { if (this.closed) throw new Error('socket is closed'); this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.({}); }
  push(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(): void { this.closed = true; this.onerror?.({}); this.onclose?.({ code: 1006 }); }
}
const sock = () => FakeSocket.all.at(-1)!;
const REC = JSON.parse(readFileSync(new URL('../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-ws.json', import.meta.url), 'utf8')) as { messages: any[] };
const books = REC.messages.filter((m) => m.channel === 'l2Book'), ctxs = REC.messages.filter((m) => m.channel === 'activeAssetCtx');
const T1 = books[0].data.time as number, T2 = books[1].data.time as number;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sql: any, se: typeof import('../src/agent-runtime/stream-engine.ts'), tpl: typeof import('../src/agents/templates.ts'), life: typeof import('../src/agents/lifecycle.ts'), store: typeof import('../src/agent-runtime/store.ts');
let BTC: Instrument;
const clock = new Clock(T1 - 3000);
const FEES = { takerRate: '0.00045', makerRate: '0.00015', source: 'test (Hyperliquid base tier)' };

/** the engine's feed over the real stream client: what derivatives/data.ts does for a venue that has a stream */
function hlFeed() {
  const stream = createHlStream({ network: 'mainnet', WebSocket: FakeSocket, now: clock.now, random: () => 1, backoffMinMs: 5, backoffMaxMs: 10 });
  const feed: import('../src/agent-runtime/stream-engine.ts').StreamFeed = {
    now: clock.now, fees: () => FEES,
    resolve: async (venue, base) => (venue === 'hyperliquid' && base === 'BTC' ? BTC : null),
    subscribe: (inst, on) => {
      const a = stream.subscribe({ type: 'book', symbol: inst.symbol }, (ev) => { const e = ev as HlStreamEvent; if (e.type === 'book') on({ event: 'book', data: e.book }); }, (status) => on({ event: 'status', data: { status, ts: clock.now() } }));
      const b = stream.subscribe({ type: 'ticker', symbol: inst.symbol }, (ev) => { const e = ev as HlStreamEvent; if (e.type === 'ticker') on({ event: 'ticker', data: e.ticker }); }, () => {});
      return () => { a(); b(); };
    },
  };
  return { feed, stream };
}

beforeAll(async () => {
  await useTestDatabase('agent_stream');
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  // V11.2: bound as a process binds it — the stream agents' simulated orders stay on the seam gateway and read the ONE kill switch
  (await import('../src/agents/execution-bind.ts')).bindExecution((await import('../src/orders/index.ts')).createExecution());
  se = await import('../src/agent-runtime/stream-engine.ts'); tpl = await import('../src/agents/templates.ts'); life = await import('../src/agents/lifecycle.ts'); store = await import('../src/agent-runtime/store.ts');
  BTC = (await fixtureVenues(new Clock()).adapters.hyperliquid.instruments()).find((i) => i.symbol === 'BTC')!;
});
afterAll(async () => { await sql?.end(); });

const rows = (id: string) => sql`select id, name, state, mode, kind, engine, family, universe, risk, capital_usdc::text as capital_usdc, config_version, runtime from agents where id = ${id}` as Promise<any[]>;
const signals = (id: string) => sql`select bar, mode, kind, status, decision, reason_code, reason, weights, config_version, strategy_sha256, inputs_digest from agent_signals where agent_id = ${id} order by bar` as Promise<any[]>;
const intents = (id: string) => sql`select id, state, reason, side, order_json, record, fills from agent_order_intents where agent_id = ${id} order by created_at, id` as Promise<any[]>;
const journal = (id: string) => sql`select kind, code, mode, severity, title from research_log where agent_id = ${id} order by id` as Promise<any[]>;
const MM_CFG = { quoteSizeUsd: '50', minHalfSpreadBps: '0.5', volMultiplier: '0', skewBps: '1', maxInventoryUsd: '250', volWindow: 30, decisionEveryMs: 1000 };

describe('market making on recorded Hyperliquid frames — paper', () => {
  let id = '', engine: import('../src/agent-runtime/stream-engine.ts').StreamEngine, stream: ReturnType<typeof hlFeed>['stream'];
  const pass = async () => (await engine.pass(await rows(id)))[id]!;

  it('created from the template: a stream agent, research by default, the rule pinned by name and version — and no live mode', async () => {
    const r = await tpl.createFromTemplate({ template: 'market-making', name: 'MM BTC', venues: ['hyperliquid'], universe: ['BTC'], capitalUsdc: '1000', config: MM_CFG, risk: { maxDataAgeMs: 5000 } }, 'owner');
    id = r.agent.id;
    expect([r.agent.kind, r.agent.family, r.agent.engine, r.agent.state, r.agent.mode, r.agent.venue, r.agent.configVersion]).toEqual(['stream', 'market_making', 'stream', 'stopped', 'research', 'hyperliquid', 1]);
    expect(r.agent.strategy).toMatchObject({ name: 'spread_inventory', version: '1', kind: 'rule' }); expect(r.agent.strategy!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.agent.live.capable).toBe(false); expect(r.warnings[0]!.code).toBe('no_live');
    await expect(life.startAgent(id, 'live', { kind: 'owner' })).rejects.toMatchObject({ code: 'live_unavailable', status: 409 });
    expect((await life.startAgent(id, 'paper', { kind: 'owner' })).state).toBe('PAPER_TRADING');
    const f = hlFeed(); stream = f.stream;
    engine = new se.StreamEngine(f.feed, { snapshotMs: 1000, equityEveryMs: 1000, signalEveryMs: 60_000 });
  });

  it('before the stream is connected there is no decision: a GAP hold, journaled once', async () => {
    expect(await pass()).toMatch(/^hold: hyperliquid:BTC: the stream is idle/);
    clock.advance(1200);
    expect(await pass()).toMatch(/^hold:/);
    expect((await journal(id)).filter((j) => j.code === 'data_gap')).toHaveLength(1);
    expect((await signals(id)).map((s) => [s.decision, s.reason_code, s.mode, s.kind])).toEqual([['skipped', 'data_gap', 'PAPER', 'stream']]);
    expect(await intents(id)).toEqual([]);
  });

  it('first recorded book: two post-only quotes around the real mid, through the order gateway, resting in the SIMULATED book', async () => {
    clock.t = T1 + 50;
    sock().open(); sock().push(books[0]); sock().push(ctxs[0]);
    expect(await pass()).toMatch(/^acted: quotes 73698\.8 \/ 73706\.2/);        // recorded book 73702 / 73703: mid 73702.5 ∓ 0.5 bps (3.685 USD), on the venue's 0.1 USD tick — bid down, ask up
    const q = await intents(id);
    expect(q.map((x) => [x.side, x.state, x.reason, x.order_json.type, x.order_json.tif, x.order_json.limitPrice, x.order_json.mode])).toEqual([['buy', 'SUBMITTED', 'VENUE_RESTING', 'limit', 'alo', '73698.8', 'paper'], ['sell', 'SUBMITTED', 'VENUE_RESTING', 'limit', 'alo', '73706.2', 'paper']]);
    expect(q[0].order_json.size).toBe('0.00067');                               // 50 USD / 73 702.5 on the 0.00001 lot
    const [, s] = await signals(id);
    expect([s.decision, s.reason_code, s.mode, s.config_version]).toEqual(['acted', 'acted', 'PAPER', 1]); expect(s.inputs_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.weights).toMatchObject({ mid: 73702.5, bid: { price: 73698.8, size: 0.00067 }, ask: { price: 73706.2, size: 0.00067 }, halfSpreadBps: 0.5 });
    expect((await journal(id)).map((j) => j.code)).toEqual(['started_paper', 'data_gap', 'data_ok', 'SUBMITTED', 'SUBMITTED']);
    expect((await rows(id))[0].runtime.book.quotes).toHaveLength(2);
  });

  it('second recorded book, 5.5 s later: the market traded THROUGH the bid — a simulated maker fill at OUR price, never better', async () => {
    clock.t = T2 + 50; sock().push(ctxs[2]); sock().push(books[1]);            // real book now 73692 / 73693: the best ask is below our 73698.8 bid
    const out = await pass();
    const all = await intents(id), bid = all[0];
    expect([bid.state, bid.reason, bid.record.filledSize, bid.record.avgFillPrice]).toEqual(['FILLED', 'VENUE_FILLED', '0.00067', '73698.8']);
    expect(Number(bid.fills[0].feeUsd)).toBeCloseTo(0.00067 * 73698.8 * 0.00015, 6);   // the venue's maker rate
    const rt = (await rows(id))[0].runtime;
    expect(rt.book.positions['hyperliquid:BTC']).toEqual({ size: 0.00067, avgPrice: 73698.8 });
    expect(rt.counters.fills).toBe(1);
    // the fill is followed, in the same pass, by a decision on the new book: long inventory skews the quotes down
    expect(out).toMatch(/^acted: quotes/);
    const last = (await signals(id)).at(-1);
    expect(last.weights.inventoryUsd).toBeGreaterThan(49); expect(last.weights.skewBps).toBeLessThan(0);
    expect((await journal(id)).filter((j) => j.kind === 'fill').map((j) => [j.mode, j.title])).toEqual([['PAPER', 'Filled 0.00067 at 73698.8']]);
    // the ask placed on the first book did not fill (the market went the other way) — it was replaced, not filled
    expect(all[1].state === 'CANCELLED' || all[1].state === 'SUBMITTED').toBe(true); expect(all[1].record.filledSize).toBe('0');
  });

  it('FRESHNESS: 20 s without a frame — no decision on that book, resting quotes are withdrawn', async () => {
    clock.advance(20_000);
    expect(await pass()).toMatch(/^hold: hyperliquid:BTC: the book is 2\d{4} ms old \(limit 5000\)/);
    const open = (await intents(id)).filter((x) => ['SUBMITTED', 'PARTIALLY_FILLED'].includes(x.state));
    expect(open).toEqual([]);
    expect((await rows(id))[0].runtime.book.quotes).toEqual([]);
    expect((await signals(id)).at(-1)).toMatchObject({ decision: 'skipped', reason_code: 'data_not_fresh' });
    expect((await rows(id))[0].runtime.counters.skippedStale).toBe(1);
  });

  it('GAP and RECONNECT: the socket drops → quoting stays paused; after the reconnect and a fresh book, decisions resume; the gap is recorded', async () => {
    sock().drop();
    expect(await pass()).toMatch(/^hold: hyperliquid:BTC: the stream is reconnecting/);
    expect((await signals(id)).at(-1)).toMatchObject({ decision: 'skipped', reason_code: 'data_gap' });
    const before = FakeSocket.all.length;
    await sleep(40);                                                            // the client's own backoff (5–10 ms here)
    expect(FakeSocket.all.length).toBe(before + 1);
    clock.advance(3000);
    sock().open();
    // the reconnect alone is not data: the engine waits for the snapshot after the gap
    expect(await pass()).toMatch(/^hold: hyperliquid:BTC: no two-sided book yet/);
    clock.advance(1200);
    sock().push({ ...books[1], data: { ...books[1].data, time: clock.now() } }); sock().push(ctxs[2]);     // the venue's snapshot after the reconnect (the recorded book, stamped now)
    expect(await pass()).toMatch(/^acted: quotes/);
    const j = await journal(id);
    expect(j.filter((x) => x.kind === 'hold').map((x) => x.code)).toEqual(['data_gap', 'data_not_fresh', 'data_gap', 'data_not_fresh']);
    expect(j.filter((x) => x.code === 'data_ok')).toHaveLength(2);
    const gaps = await sql`select kind, duration_ms from market_snapshot_gaps where venue = 'hyperliquid' and symbol = 'BTC' order by id`;
    // two holes in the recording (before the first book; the stale + disconnected stretch), and the stream's own gap
    expect(gaps.map((g: any) => g.kind).sort()).toEqual(['missing', 'missing', 'stream_gap']);
    expect(Number(gaps.find((g: any) => g.kind === 'stream_gap').duration_ms)).toBe(3000);
    expect(engine.stats.gaps).toBe(1);
  });

  it('RECORDING: top of book, mark, index and funding with the venue\'s real interval, one row per cadence slot that had usable data', async () => {
    const snaps = await sql`select ts, bid::text as bid, ask::text as ask, bid_size::text as bid_size, mark::text as mark, index_price::text as idx, funding::text as funding, funding_interval_sec from market_snapshots where venue = 'hyperliquid' and symbol = 'BTC' order by ts`;
    expect(snaps.map((s: any) => [s.bid, s.ask])).toEqual([['73702.0', '73703.0'].map((x) => String(Number(x))), ['73692', '73693'], ['73692', '73693']].map((p) => p.map(String)));
    expect(snaps[0]).toMatchObject({ bid_size: '0.0015', mark: '73714', idx: '73736.8', funding: '0.0000125', funding_interval_sec: 3600 });
    expect(snaps.every((s: any) => s.ts.getTime() % 1000 === 0)).toBe(true);
    expect(engine.stats.snapshots).toBe(3); expect(engine.stats.missing).toBeGreaterThanOrEqual(2);       // the idle, stale and gap passes recorded nothing — and said so
  });

  it('performance of the PAPER mode is computed from the simulation\'s own records; live and research have none', async () => {
    const a = await store.loadAgent(id);
    const p = await store.agentPerformance(a, 'paper');
    expect(p.mode).toBe('paper'); expect(p.label).toMatch(/^PAPER — simulated/);
    expect(p.points).toBeGreaterThanOrEqual(2); expect(p.orders).toBe(1);
    expect(p.feesUsd.value).toBeCloseTo(0.00067 * 73698.8 * 0.00015, 6);
    expect(p.winRate).toEqual({ value: null, reason: expect.stringMatching(/average cost/) });
    expect(p.warnings.map((w) => w.code)).toContain('small_sample');
    expect((await store.agentPerformance(a, 'live')).points).toBe(0);
    expect(await store.agentOrders(a, 'live')).toEqual([]); expect(await store.agentSignals(a.id, 'live')).toEqual([]);
    expect((await store.agentOrders(a, 'paper')).every((o) => o.mode === 'paper' && o.source === 'gateway')).toBe(true);
  });

  it('BACKTEST on the recorded snapshots: the same rule and fill model, labelled a backtest, with its warnings — never a performance', async () => {
    const rt = (await rows(id))[0];
    const rep = await se.replayRecorded({ rule: 'spread_inventory', config: rt.runtime.config, risk: rt.risk, capital: 1000, instruments: [BTC], fees: () => FEES, from: T1 - 60_000, to: clock.now() + 60_000, snapshotMs: 1000 });
    expect([rep.kind, rep.label, rep.rule, rep.instruments]).toEqual(['recorded_replay', 'backtest', 'spread_inventory', ['hyperliquid:BTC']]);
    expect(rep.snapshots).toBe(3); expect(rep.missing).toBeGreaterThan(10); expect(rep.gaps).toBe(3);
    expect(rep.fills).toBe(1);                                                  // the same recorded trade-through, found again by the replay
    expect(rep.warnings.join(' ')).toMatch(/far too few/); expect(rep.warnings.join(' ')).toMatch(/expected snapshots are missing/);
    expect(rep.model[0]).toBe('BACKTEST on recorded top-of-book snapshots — not a track record');
    expect(rep.performance.points).toBe(3);
  });

  it('pause withdraws the simulated quotes; stop is always allowed; the paused agent is not ticked', async () => {
    expect((await life.pauseAgent(id, { kind: 'owner' })).state).toBe('PAUSED');
    expect((await rows(id))[0].runtime.book.quotes).toEqual([]);
    expect(await engine.tick((await rows(id))[0])).toBe('idle');
    expect((await life.resumeAgent(id, { kind: 'owner' })).state).toBe('PAPER_TRADING');
    sock().push({ ...books[1], data: { ...books[1].data, time: clock.advance(1500) } });
    await pass();
    expect((await intents(id)).filter((x) => x.state === 'SUBMITTED').length).toBe(2);       // the quotes the pause withdrew are settled CANCELLED; two new ones rest
    expect((await life.stopAgent(id, { kind: 'api_key', id: 'spk_test' }, 'done')).state).toBe('STOPPED');
    expect((await life.stopAgent(id, { kind: 'owner' })).state).toBe('STOPPED');               // idempotent
    stream.close();
  });
});

// ------------------------------------------------------------------------------------------------------------------ research mode, kill switch

function manualFeed(insts: Record<string, Instrument>) {
  const subs = new Map<string, (ev: any) => void>();
  const feed: import('../src/agent-runtime/stream-engine.ts').StreamFeed = { now: clock.now, fees: () => FEES, resolve: async (venue) => insts[venue] ?? null, subscribe: (inst, on) => { subs.set(inst.id, on); on({ event: 'status', data: { status: 'connected', ts: clock.now() } }); return () => { subs.delete(inst.id); }; } };
  const emit = (id: string, bid: number, ask: number, o: { funding?: string; size?: string } = {}): void => {
    const book: Book = { instrument: id, bids: [[String(bid), o.size ?? '5']], asks: [[String(ask), o.size ?? '5']], ts: clock.now() };
    const ticker: Ticker = { instrument: id, mark: String((bid + ask) / 2), index: null, mid: null, funding: o.funding ?? '0.0000125', openInterest: null, volume24h: null, change24h: null, ts: clock.now() };
    subs.get(id)?.({ event: 'book', data: book }); subs.get(id)?.({ event: 'ticker', data: ticker });
  };
  return { feed, emit, subs };
}

describe('research mode and the kill switch', () => {
  it('RESEARCH: the decision is computed and stored (skipped / research_mode) — no order, no simulated book, no equity', async () => {
    const r = await tpl.createFromTemplate({ template: 'market-making', name: 'MM research', venues: ['hyperliquid'], universe: ['BTC'], config: MM_CFG }, 'owner');
    expect((await life.startAgent(r.agent.id, 'research', { kind: 'api_key', id: 'spk_k1' })).state).toBe('RUNNING');
    const m = manualFeed({ hyperliquid: BTC }), engine = new se.StreamEngine(m.feed, { record: false });
    await engine.pass(await rows(r.agent.id));                                  // subscribes
    m.emit('hyperliquid:BTC', 73702, 73703);
    expect((await engine.pass(await rows(r.agent.id)))[r.agent.id]).toMatch(/^research_mode: research mode/);
    const s = (await signals(r.agent.id)).at(-1);
    expect([s.mode, s.decision, s.reason_code]).toEqual(['RESEARCH', 'skipped', 'research_mode']); expect(s.weights.bid).toEqual({ price: 73698.8, size: 0.00067 });
    expect(await intents(r.agent.id)).toEqual([]);
    expect((await sql`select count(*)::int as n from agent_equity where agent_id = ${r.agent.id}`)[0].n).toBe(0);
    expect((await store.agentSummary(await store.loadAgent(r.agent.id))).mode).toBe('research');
    // an order submitted by hand for a research agent is refused by the gateway itself
    const { orderGateway } = await import('../src/agent-runtime/gateway.ts'), a = (await rows(r.agent.id))[0], now = Date.now();
    const rec = await orderGateway({ agent: a, seam: { execute: async () => { throw new Error('never'); }, lookup: async () => null, absenceConclusiveAt: () => 0 }, authorityId: a.id }).submit({ kind: 'agent', id: a.id },
      { v: 1, venue: 'hyperliquid', network: 'mainnet', instrument: 'hyperliquid:BTC', marketKind: 'perp', side: 'buy', type: 'market', size: '0.001', notional: null, limitPrice: null, triggerPrice: null, reduceOnly: false, tif: 'ioc', maxSlippageBps: 10, maxFeeUsd: '1',
        leverage: '1', marginMode: 'cross', clientOrderId: 'research-order-1', mode: 'research', principal: { kind: 'agent', id: a.id }, mandateId: a.id, createdAt: now, expiresAt: now + 1000 }, { idempotencyKey: 'research-order-1' });
    expect([rec.state, rec.reason]).toEqual(['REJECTED', 'READ_ONLY_MODE']);
    engine.close();
  });

  it('kill switch engaged: a paper market maker\'s quotes are refused by the gateway (they add risk); the signal says kill_switch', async () => {
    const r = await tpl.createFromTemplate({ template: 'market-making', name: 'MM halted', venues: ['hyperliquid'], universe: ['BTC'], config: MM_CFG }, 'owner');
    await life.startAgent(r.agent.id, 'paper', { kind: 'owner' });
    const m = manualFeed({ hyperliquid: BTC }), engine = new se.StreamEngine(m.feed, { record: false, killSwitch: { engaged: async () => ({ engaged: true, reason: 'test' }) } });
    await engine.pass(await rows(r.agent.id)); m.emit('hyperliquid:BTC', 73702, 73703);
    await engine.pass(await rows(r.agent.id));
    expect((await intents(r.agent.id)).map((x) => [x.state, x.reason])).toEqual([['REJECTED', 'KILL_SWITCH_ACTIVE'], ['REJECTED', 'KILL_SWITCH_ACTIVE']]);
    expect((await rows(r.agent.id))[0].runtime.book.quotes).toEqual([]);
    engine.close();
  });
});

// ------------------------------------------------------------------------------------------------------------------ two venues (paper only)

describe('cross-exchange and funding arbitrage — two venues, paper only', () => {
  const EDGEX: Instrument = { venue: 'edgex' as never, symbol: 'BTCUSD', id: 'edgex:BTCUSD', base: 'BTC', quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0.1', lotSize: '0.001', minOrderSize: null, minNotional: '10', maxLeverage: '50',
    marginModes: ['cross'], fundingIntervalSec: 14_400, markPriceMethod: '', status: 'active' };

  it('cross-exchange: opens both legs when the gap clears the costs, closes them when it converges; live is refused with the product\'s sentence', async () => {
    const r = await tpl.createFromTemplate({ template: 'cross-exchange', name: 'X-venue', venues: ['hyperliquid', 'edgex'], universe: ['BTC'], config: { notionalUsd: '250', horizonHours: '0', minNetEdgeBps: '5', exitGapBps: '1', decisionEveryMs: 1000 } }, 'owner');
    const id = r.agent.id;
    await expect(life.startAgent(id, 'live', { kind: 'owner' })).rejects.toMatchObject({ code: 'live_unavailable', message: 'mode réel indisponible : une seule plateforme autorise l\'exécution sous mandat' });
    await life.startAgent(id, 'paper', { kind: 'owner' });
    const m = manualFeed({ hyperliquid: BTC, edgex: EDGEX }), engine = new se.StreamEngine(m.feed, { record: false, equityEveryMs: 1000 });
    const pass = async () => (await engine.pass(await rows(id)))[id]!;
    await pass();
    // the recorded Hyperliquid top of book, and a second venue 40 bps dearer (scripted: 73 703 × 1.004 ≈ 73 997.8)
    m.emit('hyperliquid:BTC', 73702, 73703); m.emit('edgex:BTCUSD', 73997.8, 73998.8);
    expect(await pass()).toMatch(/^acted: net edge .* bps after costs .*buy hyperliquid, sell edgex/);
    const legs = await intents(id);
    expect(legs.map((x) => [x.order_json.instrument, x.side, x.state, x.order_json.size, x.order_json.reduceOnly])).toEqual([['hyperliquid:BTC', 'buy', 'FILLED', '0.003', false], ['edgex:BTCUSD', 'sell', 'FILLED', '0.003', false]]);
    expect(legs.map((x) => x.record.avgFillPrice)).toEqual(['73703', '73997.8']);             // each leg at the price the decision read on that venue's book
    let rt = (await rows(id))[0].runtime;
    expect(rt.book.pair).toMatchObject({ longInstrument: 'hyperliquid:BTC', shortInstrument: 'edgex:BTCUSD', sizeBase: 0.003 });
    // held while the gap lasts
    clock.advance(1500); m.emit('hyperliquid:BTC', 73702, 73703); m.emit('edgex:BTCUSD', 73900, 73901);
    expect(await pass()).toMatch(/^edge_below_threshold: position kept/);
    // convergence: both legs closed, reduce-only
    clock.advance(1500); m.emit('hyperliquid:BTC', 73702, 73703); m.emit('edgex:BTCUSD', 73703, 73704);
    expect(await pass()).toMatch(/^acted: the gap is .* closing both legs/);
    const all = await intents(id);
    expect(all.slice(2).map((x) => [x.order_json.instrument, x.side, x.state, x.order_json.reduceOnly])).toEqual([['hyperliquid:BTC', 'sell', 'FILLED', true], ['edgex:BTCUSD', 'buy', 'FILLED', true]]);
    rt = (await rows(id))[0].runtime;
    expect(rt.book.pair).toBeNull(); expect(rt.book.positions['hyperliquid:BTC'].size).toBe(0); expect(rt.book.positions['edgex:BTCUSD'].size).toBe(0);
    // realised: bought 73 703 / sold 73 702 on one venue, sold 73 997.8 / bought 73 704 on the other, on 0.003 BTC, minus four taker fees
    expect(rt.book.realizedPnl).toBeCloseTo(0.003 * (73702 - 73703) + 0.003 * (73997.8 - 73704), 6);
    expect(rt.book.fees).toBeCloseTo(0.003 * (73703 + 73997.8 + 73702 + 73704) * 0.00045, 6);
    expect((await signals(id)).filter((s) => s.decision === 'acted')).toHaveLength(2);
    engine.close();
  });

  it('funding arbitrage: each venue\'s rate per hour with its own interval; holds when the carry does not pay the four legs; an old book on ONE venue stops the decision', async () => {
    const r = await tpl.createFromTemplate({ template: 'funding-arb', name: 'Funding', venues: ['hyperliquid', 'edgex'], universe: ['BTC'], config: { notionalUsd: '250', horizonHours: '72', minNetCarryBps: '5', exitNetCarryBps: '0', decisionEveryMs: 1000 } }, 'owner');
    const id = r.agent.id;
    await life.startAgent(id, 'paper', { kind: 'owner' });
    const m = manualFeed({ hyperliquid: BTC, edgex: EDGEX }), engine = new se.StreamEngine(m.feed, { record: false });
    const pass = async () => (await engine.pass(await rows(id)))[id]!;
    await pass();
    // Hyperliquid 0.0000125 per 1 h = 0.125 bps/h; edgeX 0.00005 per 4 h = 0.125 bps/h: no differential
    m.emit('hyperliquid:BTC', 73702, 73703, { funding: '0.0000125' }); m.emit('edgex:BTCUSD', 73702, 73703, { funding: '0.00005' });
    expect(await pass()).toMatch(/^edge_below_threshold: net carry -18\.00 bps over 72 h/);
    let s = (await signals(id)).at(-1);
    expect(s.weights.a).toMatchObject({ venue: 'hyperliquid', intervalSec: 3600, hourlyBps: 0.125 }); expect(s.weights.b).toMatchObject({ venue: 'edgex', intervalSec: 14_400, hourlyBps: 0.125 });
    // edgeX at 0.0002 per 4 h = 0.5 bps/h: 0.375 × 72 = 27 bps gross, 18 bps of fees → 9 bps net: short edgeX, long Hyperliquid
    clock.advance(1500); m.emit('hyperliquid:BTC', 73702, 73703, { funding: '0.0000125' }); m.emit('edgex:BTCUSD', 73702, 73703, { funding: '0.0002' });
    expect(await pass()).toMatch(/^acted: net carry 9\.00 bps over 72 h: short edgex .* long hyperliquid/);
    expect((await intents(id)).map((x) => [x.order_json.instrument, x.side, x.state])).toEqual([['hyperliquid:BTC', 'buy', 'FILLED'], ['edgex:BTCUSD', 'sell', 'FILLED']]);
    // one venue goes quiet: its book is older than the limit → nothing is decided, the position is kept
    clock.advance(10_000); m.emit('hyperliquid:BTC', 73702, 73703, { funding: '0.0000125' });
    expect(await pass()).toMatch(/^hold: edgex:BTCUSD: the book is 1\d{4} ms old/);
    s = (await signals(id)).at(-1); expect(s.reason_code).toBe('data_not_fresh');
    expect((await rows(id))[0].runtime.book.pair).not.toBeNull();
    engine.close();
  });

  it('a venue that does not list the asset: the agent holds with the reason, and says so once', async () => {
    const r = await tpl.createFromTemplate({ template: 'cross-exchange', name: 'No market', venues: ['hyperliquid', 'dydx'], universe: ['BTC'] }, 'owner');
    await life.startAgent(r.agent.id, 'paper', { kind: 'owner' });
    const m = manualFeed({ hyperliquid: BTC }), engine = new se.StreamEngine(m.feed, { record: false });
    expect((await engine.pass(await rows(r.agent.id)))[r.agent.id]).toBe('hold: dydx does not list a perpetual on BTC');
    await engine.pass(await rows(r.agent.id));
    expect((await journal(r.agent.id)).filter((j) => j.code === 'no_market')).toHaveLength(1);
    engine.close();
  });

  it('template validation: venues, base asset, configuration keys and bounds', async () => {
    const bad: [Record<string, unknown>, RegExp][] = [[{ template: 'market-making', name: 'x1', venues: ['hyperliquid', 'edgex'] }, /needs 1 venue/], [{ template: 'cross-exchange', name: 'x2', venues: ['hyperliquid'] }, /needs 2 different venues/],
      [{ template: 'cross-exchange', name: 'x3', venues: ['edgex', 'edgex'] }, /2 different venues/], [{ template: 'market-making', name: 'x4', venues: ['gmx'] }, /no order book/], [{ template: 'market-making', name: 'x5', universe: ['BTC', 'ETH'] }, /ONE base asset/],
      [{ template: 'market-making', name: 'x6', config: { leverage: 10 } }, /unknown configuration key leverage/], [{ template: 'market-making', name: 'x7', config: { decisionEveryMs: 10 } }, /at least 1000/], [{ template: 'market-making', name: 'x8', capitalUsdc: '10' }, /at least 50 USDC/],
      [{ template: 'market-making', name: 'x9', risk: { maxDataAgeMs: 5 } }, /maxDataAgeMs must be between/], [{ template: 'nope', name: 'x10' }, /unknown template/]];
    for (const [body, why] of bad) await expect(tpl.createFromTemplate(body, 'owner'), JSON.stringify(body)).rejects.toThrow(why);
  });
});

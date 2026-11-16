// The stream engine: the second, small engine for the families that decide between bars — market making, cross-exchange,
// funding arbitrage. It does not bend the bar engines; it shares nothing with them but the order gateway, the journal, the
// signal table and the equity table.
//
//   data        the venues' own streams through the derivatives data service (`DerivData.subscribe`): Hyperliquid and edgeX
//               over WebSocket (heartbeat, reconnect, gap events), dYdX and GMX by polling the cached REST reads. One hub per
//               instrument, shared with the terminal.
//   freshness   NO decision on a book or a ticker older than `maxDataAgeMs` (the agent's limit). A stream that is not
//               `connected` is a GAP: quoting pauses (resting paper quotes are cancelled), nothing is decided until a fresh
//               snapshot arrives. Both are counted and journaled once per transition.
//   recording   what the engine consumed, compact: top of book + mark + index + funding per instrument every `snapshotMs`
//               (table market_snapshots, pruned after `retentionDays`), and every hole in it (market_snapshot_gaps).
//               `replayRecorded` runs the SAME rules and the SAME paper fill model over those rows: a backtest on recorded data.
//   modes       research (the decision is computed and stored, no order, no book) and paper (orders through the gateway into a
//               simulated book). There is NO live mode here: see agent-runtime/model.ts FAMILY_MODES for why.
import type { Book, Instrument, Ticker } from '@spw/derivatives';
import type { CanonicalOrderInput, FeeSchedule } from '@spw/trading';
import { sql } from '../db.ts';
import { accrueFunding, applyFill, crossDecision, fundingDecision, grossUsd, mid, mmFills, mmQuotes, needsRequote, newPaperBook, paperEquity, type CrossConfig, type FundingConfig, type MarketView, type MmConfig, type PaperBook, type Quote } from './families.ts';
import { orderGateway, type AgentOrderGateway, type KillSwitchRead, type OrderSeam, type SeamResult } from './gateway.ts';
import { inputsDigest, journal, type ReasonCode } from './journal.ts';
import { killSwitchRead } from './kill-switch.ts';
import { RULES, ruleHash, type DbMode } from './model.ts';
import { computePerformance, type EquityPoint, type Performance } from './performance.ts';

export type FeedEvent = { event: 'status'; data: { status: 'connected' | 'reconnecting' | 'stale'; ts: number } } | { event: 'ticker'; data: Ticker } | { event: 'book'; data: Book } | { event: string; data: unknown };
/** what the engine needs from the market-data side (the derivatives data service, or a replay of recorded frames in tests) */
export interface StreamFeed {
  now(): number;
  /** the instrument of a venue for a base asset (BTC → hyperliquid:BTC, dydx:BTC-USD, edgex:BTCUSD…); null when the venue does not list it */
  resolve(venue: string, base: string): Promise<Instrument | null>;
  subscribe(inst: Instrument, on: (ev: FeedEvent) => void): () => void;
  fees(venue: string): FeeSchedule | null;
}
export interface StreamAgentRow { id: string; name: string; state: string; mode: string; kind: string; engine: string; family: string; universe: string[]; risk: { maxPositionUsd: number; maxGrossUsd: number; maxDailyLossPct: number; maxTotalLossPct: number; maxDataAgeMs: number };
  capital_usdc: string; config_version: number; runtime: StreamRuntime }
export interface StreamRuntime { venues: string[]; rule: string; config: Record<string, unknown>; book?: PaperBook; lastDecisionAt?: number; lastSignalAt?: number; lastEquityAt?: number; lastCode?: string; hold?: { code: string; since: number } | null;
  counters?: { decisions: number; acted: number; skippedStale: number; skippedGap: number; fills: number }; day?: { date: string; equity: number }; backtest?: unknown }
interface Market { inst: Instrument; status: 'connected' | 'reconnecting' | 'stale' | 'idle'; book: Book | null; bookAt: number; ticker: Ticker | null; tickerAt: number; stop: () => void; lastSnapshotAt: number; gapSince: number | null; missingSince: number | null; refs: number }
export interface StreamOptions { snapshotMs?: number; retentionDays?: number; signalEveryMs?: number; equityEveryMs?: number; gateway?: (a: StreamAgentRow, seam: OrderSeam) => AgentOrderGateway; killSwitch?: KillSwitchRead; record?: boolean }

const num = (x: string | null | undefined): number | null => (x === null || x === undefined ? null : Number(x));
const capitalOf = (a: Pick<StreamAgentRow, 'capital_usdc'>): number => Number(a.capital_usdc) / 1e6;
const dec = (n: number, dp = 10): string => { const s = n.toFixed(dp); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };

/** a MarketView from the engine's live market state, or null when there is no two-sided book yet */
export function viewOf(inst: Instrument, book: Book | null, ticker: Ticker | null, fees: FeeSchedule | null, bookTs: number, tickerTs: number | null): MarketView | null {
  const b = book?.bids[0], a = book?.asks[0];
  if (!book || !b || !a) return null;
  return { id: inst.id, venue: inst.venue, symbol: inst.symbol, instrument: inst, bid: Number(b[0]), bidSize: Number(b[1]), ask: Number(a[0]), askSize: Number(a[1]), mark: num(ticker?.mark), index: num(ticker?.index),
    funding: ticker?.funding ?? null, fundingIntervalSec: inst.fundingIntervalSec, bookTs, tickerTs, book, ticker, fees };
}

/** the simulated book of a stream agent, seen from the order gateway: a post-only limit order rests, a market order fills at the price the engine read on the book */
export function streamPaperSeam(book: PaperBook, feeRate: (instrument: string, liquidity: 'maker' | 'taker') => number, now: () => number): OrderSeam & { filled: Map<string, { size: number; price: number }>; gone: Set<string> } {
  const filled = new Map<string, { size: number; price: number }>(), gone = new Set<string>();
  const resting = (id: string): SeamResult => ({ status: 'accepted', venueOrderId: `sim:${id}`, filledSize: '0', avgFillPrice: null, fills: [], final: false, note: 'simulated resting quote: nothing reached a venue' });
  return {
    filled, gone,
    async execute(order, ctx) {
      if (order.type === 'limit') {
        book.quotes.push({ id: order.clientOrderId, side: order.side, price: Number(order.limitPrice), size: Number(order.size), ts: now(), instrument: order.instrument });
        return resting(order.clientOrderId);
      }
      const price = Number(ctx.worstPrice), size = Number(order.size);
      if (!(price > 0) || !(size > 0)) return { status: 'rejected', by: 'risk', code: 'bad_request', reason: 'a simulated market order needs the book price it was decided on' };
      const { fee } = applyFill(book, order.instrument, order.side, size, price, feeRate(order.instrument, 'taker'));
      return { status: 'accepted', venueOrderId: `sim:${order.clientOrderId}`, filledSize: order.size!, avgFillPrice: dec(price), fills: [{ id: `sim:${order.clientOrderId}:1`, size: order.size!, price: dec(price), feeUsd: dec(fee, 6), ts: now() }], final: true,
        note: 'SIMULATED taker fill at the book price the decision read; nothing reached a venue' };
    },
    async lookup(order) {
      const f = filled.get(order.clientOrderId);
      if (f) return { status: 'accepted', venueOrderId: `sim:${order.clientOrderId}`, filledSize: dec(f.size), avgFillPrice: dec(f.price), fills: [{ id: `sim:${order.clientOrderId}:1`, size: dec(f.size), price: dec(f.price), feeUsd: dec(f.size * f.price * feeRate(order.instrument, 'maker'), 6), ts: now() }], final: true,
        note: 'SIMULATED maker fill (paper fill model: the market traded through the quote)' };
      if (book.quotes.some((q) => q.id === order.clientOrderId)) return resting(order.clientOrderId);
      if (gone.has(order.clientOrderId)) return { status: 'accepted', venueOrderId: `sim:${order.clientOrderId}`, filledSize: '0', avgFillPrice: null, fills: [], final: true, note: 'simulated quote cancelled' };
      return { status: 'not_sent', code: 'not_resting', reason: 'the simulated book no longer holds this quote' };
    },
    absenceConclusiveAt: (_o, at) => at,
    async cancel(order) { book.quotes = book.quotes.filter((q) => q.id !== order.clientOrderId); gone.add(order.clientOrderId); return { status: 'accepted', venueOrderId: `sim:${order.clientOrderId}`, filledSize: '0', avgFillPrice: null, fills: [], final: true, note: 'simulated quote cancelled' }; },
  };
}

export class StreamEngine {
  private readonly markets = new Map<string, Market>();
  private readonly resolved = new Map<string, Instrument | null>();
  private prunedAt = 0;
  readonly stats = { passes: 0, snapshots: 0, gaps: 0, missing: 0, decisions: 0 };
  private readonly feed: StreamFeed; private readonly o: StreamOptions;
  constructor(feed: StreamFeed, o: StreamOptions = {}) { this.feed = feed; this.o = o; }

  private async instrument(venue: string, base: string): Promise<Instrument | null> {
    const k = `${venue}|${base}`;
    if (!this.resolved.has(k) || this.resolved.get(k) === null) this.resolved.set(k, await this.feed.resolve(venue, base).catch(() => null));
    return this.resolved.get(k) ?? null;
  }
  private market(inst: Instrument): Market {
    let m = this.markets.get(inst.id);
    if (m) return m;
    const mk: Market = { inst, status: 'idle', book: null, bookAt: 0, ticker: null, tickerAt: 0, stop: () => {}, lastSnapshotAt: 0, gapSince: null, missingSince: null, refs: 0 };
    this.markets.set(inst.id, mk);
    mk.stop = this.feed.subscribe(inst, (ev) => {
      const now = this.feed.now();
      if (ev.event === 'book') { mk.book = ev.data as Book; mk.bookAt = now; }
      else if (ev.event === 'ticker') { mk.ticker = ev.data as Ticker; mk.tickerAt = now; }
      else if (ev.event === 'status') {
        const s = (ev.data as { status: Market['status'] }).status, was = mk.status;
        mk.status = s;
        if (s !== 'connected' && was === 'connected') { mk.gapSince = now; mk.book = null; mk.ticker = null; this.stats.gaps += 1; }   // whatever we held may be wrong: wait for the snapshot after the gap
        if (s === 'connected' && mk.gapSince !== null) { void this.gap(mk, 'stream_gap', `the ${inst.venue} stream was ${was} and is connected again`, mk.gapSince, now); mk.gapSince = null; }
      }
    });
    return mk;
  }
  private async gap(m: Market, kind: string, detail: string, from: number, to: number): Promise<void> {
    if (this.o.record === false) return;
    await sql`insert into market_snapshot_gaps (venue, symbol, ts, kind, detail, duration_ms) values (${m.inst.venue}, ${m.inst.symbol}, ${new Date(from)}, ${kind}, ${detail.slice(0, 300)}, ${Math.max(0, to - from)})`.catch(() => {});
  }
  /** the view a decision may use, or why not: a gap, or data older than the agent's limit */
  private fresh(m: Market, maxAgeMs: number, needTicker: boolean, now: number): { view: MarketView } | { code: 'data_gap' | 'data_not_fresh'; reason: string } {
    if (m.status !== 'connected') return { code: 'data_gap', reason: `${m.inst.id}: the stream is ${m.status}` };
    const v = viewOf(m.inst, m.book, m.ticker, this.feed.fees(m.inst.venue), m.book?.ts ?? m.bookAt, m.ticker?.ts ?? null);
    if (!v) return { code: 'data_not_fresh', reason: `${m.inst.id}: no two-sided book yet` };
    // both ages: when the venue produced the book, and when we received it (a stalled connection keeps repeating an old book)
    const age = now - Math.min(m.bookAt, v.bookTs || m.bookAt);
    if (age > maxAgeMs) return { code: 'data_not_fresh', reason: `${m.inst.id}: the book is ${age} ms old (limit ${maxAgeMs})` };
    if (needTicker && (!m.ticker || now - m.tickerAt > Math.max(maxAgeMs, 15_000))) return { code: 'data_not_fresh', reason: `${m.inst.id}: no recent ticker (mark, funding)` };
    return { view: v };
  }

  /** top of book + mark + funding at a fixed cadence; a slot without usable data opens a "missing" interval, closed when data is back */
  private async record(now: number): Promise<void> {
    if (this.o.record === false) return;
    const every = this.o.snapshotMs ?? 10_000;
    for (const m of this.markets.values()) {
      if (now - m.lastSnapshotAt < every) continue;
      m.lastSnapshotAt = now;
      const ok = this.fresh(m, 2 * every, false, now);
      if ('view' in ok) {
        const v = ok.view;
        if (m.missingSince !== null) { await this.gap(m, 'missing', 'no usable book at the snapshot cadence', m.missingSince, now); m.missingSince = null; }
        await sql`insert into market_snapshots (venue, symbol, ts, bid, bid_size, ask, ask_size, mark, index_price, funding, funding_interval_sec, source_ts)
          values (${v.venue}, ${v.symbol}, ${new Date(Math.floor(now / every) * every)}, ${m.book!.bids[0]![0]}, ${m.book!.bids[0]![1]}, ${m.book!.asks[0]![0]}, ${m.book!.asks[0]![1]}, ${m.ticker?.mark ?? null}, ${m.ticker?.index ?? null},
            ${m.ticker?.funding ?? null}, ${v.fundingIntervalSec}, ${new Date(v.bookTs || now)}) on conflict do nothing`.catch(() => {});
        this.stats.snapshots += 1;
      } else { m.missingSince ??= now; this.stats.missing += 1; }
    }
    if (now - this.prunedAt > 3_600_000) { this.prunedAt = now; const days = this.o.retentionDays ?? 7;
      await sql`delete from market_snapshots where ts < ${new Date(now - days * 86_400_000)}`.catch(() => {}); await sql`delete from market_snapshot_gaps where ts < ${new Date(now - 4 * days * 86_400_000)}`.catch(() => {}); }
  }

  /** One pass: record what the streams delivered, then let every agent in `agents` decide (the caller holds each agent's lease). */
  async pass(agents: StreamAgentRow[], onAgent?: (a: StreamAgentRow, run: () => Promise<string>) => Promise<string | null>): Promise<Record<string, string>> {
    const now = this.feed.now(), out: Record<string, string> = {};
    this.stats.passes += 1;
    for (const a of agents) {
      try { const r = onAgent ? await onAgent(a, () => this.tick(a)) : await this.tick(a); if (r !== null) out[a.id] = r; }
      catch (e) { out[a.id] = `error: ${(e as Error).message.slice(0, 160)}`; await journal(a.id, { kind: 'error', code: 'tick_error', severity: 'error', title: 'Stream engine pass interrupted', body: (e as Error).message.slice(0, 300) }); }
    }
    await this.record(now);
    return out;
  }

  /** One decision step of one stream agent. Safe to call every second: it decides at most every `decisionEveryMs`. */
  async tick(a: StreamAgentRow): Promise<string> {
    const now = this.feed.now(), rt: StreamRuntime = { ...a.runtime }, cfg = rt.config, rule = rt.rule, mode: DbMode = a.mode === 'PAPER' ? 'PAPER' : 'RESEARCH';
    if (a.engine !== 'stream' || !RULES[rule] || (a.state !== 'PAPER_TRADING' && a.state !== 'RUNNING')) return 'idle';
    const paper = mode === 'PAPER' && a.state === 'PAPER_TRADING', base = a.universe[0]!;
    const counters = rt.counters ?? { decisions: 0, acted: 0, skippedStale: 0, skippedGap: 0, fills: 0 };
    const book = rt.book ?? newPaperBook(capitalOf(a));
    const save = async (): Promise<void> => { await sql`update agents set runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ book, counters, lastDecisionAt: rt.lastDecisionAt ?? null, lastSignalAt: rt.lastSignalAt ?? null, lastEquityAt: rt.lastEquityAt ?? null, lastCode: rt.lastCode ?? null, hold: rt.hold ?? null, day: rt.day ?? null } as never)}, updated_at = now() where id = ${a.id}`; };

    // instruments and their streams
    const markets: Market[] = [];
    for (const venue of rt.venues) { const inst = await this.instrument(venue, base); if (!inst) return this.hold(a, rt, mode, 'no_market', `${venue} does not list a perpetual on ${base}`, save); markets.push(this.market(inst)); }
    const feeRate = (instrument: string, liq: 'maker' | 'taker'): number => { const f = this.feed.fees(instrument.slice(0, instrument.indexOf(':'))); return f ? Number(liq === 'maker' ? f.makerRate : f.takerRate) : 0.0005; };
    const seam = streamPaperSeam(book, feeRate, () => this.feed.now());
    // the agent's instruments are the ones resolved on its venues (a venue's own symbol for BTC may be BTC-USD or BTCUSD)
    const allowed = new Set(markets.map((m) => m.inst.id));
    const gw = this.o.gateway?.(a, seam) ?? orderGateway({ agent: a, seam, authorityId: a.id, killSwitch: this.o.killSwitch ?? killSwitchRead, now: () => this.feed.now(),
      risk: { check: async (_a, o) => (allowed.has(o.instrument) ? { ok: true } : { ok: false, code: 'INSTRUMENT_NOT_ALLOWED', reason: `${o.instrument} is not one of this agent's instruments (${[...allowed].join(', ')})` }) } });
    const submit = async (o: { instrument: string; side: 'buy' | 'sell'; size: number; type: 'limit' | 'market'; price: number; reduceOnly: boolean; tag: string }, signalId: string | null) => {
      book.seq += 1;
      const id = `st-${a.id}-${now}-${book.seq}-${o.tag}`, venue = o.instrument.slice(0, o.instrument.indexOf(':'));
      const order: CanonicalOrderInput = { v: 1, venue, network: 'mainnet', instrument: o.instrument, marketKind: 'perp', side: o.side, type: o.type, size: dec(o.size), notional: null, limitPrice: o.type === 'limit' ? dec(o.price) : null, triggerPrice: null, reduceOnly: o.reduceOnly,
        tif: o.type === 'limit' ? 'alo' : 'ioc', maxSlippageBps: 0, maxFeeUsd: dec(Math.max(0.01, o.size * o.price * 0.002), 2), leverage: '1', marginMode: 'cross', clientOrderId: id, mode: 'paper', principal: { kind: 'agent', id: a.id }, mandateId: a.id, createdAt: now, expiresAt: now + 3_600_000 };
      return gw.submit({ kind: 'agent', id: a.id }, order, { idempotencyKey: id, resolved: { worstPrice: dec(o.price) }, context: { signalId, configVersion: a.config_version, strategySha256: ruleHash(rule), bar: now } });
    };

    // after a start, a resume or a restart: the ledger's open orders are settled against the simulated book as it is now
    if (paper && (!rt.lastDecisionAt || now - rt.lastDecisionAt > 30_000)) await gw.reconcile?.().catch(() => []);
    // freshness: a gap pauses everything; resting quotes are withdrawn at once
    const needTicker = rule !== 'spread_inventory', views: MarketView[] = [];
    for (const m of markets) {
      const f = this.fresh(m, a.risk.maxDataAgeMs, needTicker, now);
      if ('view' in f) { views.push(f.view); continue; }
      if (f.code === 'data_gap') counters.skippedGap += 1; else counters.skippedStale += 1;
      if (paper && book.quotes.length) { for (const q of [...book.quotes]) await gw.cancel({ kind: 'agent', id: a.id }, q.id).catch(() => {}); book.quotes = []; }
      rt.counters = counters; rt.book = book;
      return this.hold(a, rt, mode, f.code, f.reason, save);
    }
    if (rt.hold) { await journal(a.id, { mode, kind: 'state', code: 'data_ok', title: 'Data is fresh again: decisions resume', body: `after ${Math.round((now - rt.hold.since) / 1000)} s (${rt.hold.code})`, configVersion: a.config_version }); rt.hold = null; }
    const marks = Object.fromEntries(views.map((v) => [v.id, v.mark ?? mid(v)]));

    // paper bookkeeping that follows the data, not the decision cadence: maker fills and funding settlements
    let filledNow = 0;
    if (paper) {
      for (const v of views) for (const f of mmFills(book.quotes, v, Number(cfg.minRestMs ?? 1000))) {
        applyFill(book, f.quote.instrument, f.quote.side, f.size, f.price, feeRate(f.quote.instrument, 'maker'));
        book.quotes = book.quotes.filter((q) => q.id !== f.quote.id); seam.filled.set(f.quote.id, { size: f.size, price: f.price }); filledNow += 1; counters.fills += 1;
      }
      if (filledNow) await gw.reconcile?.().catch(() => []);
      for (const s of accrueFunding(book, views, now)) await journal(a.id, { mode, kind: 'fill', code: 'FUNDING', title: `Funding settlement (simulated): ${s.amount >= 0 ? '+' : ''}${s.amount.toFixed(4)} USD`, body: `${s.instrument} at ${new Date(s.at).toISOString()}`, configVersion: a.config_version });
    }
    const equity = paperEquity(book, marks), capital = capitalOf(a), date = new Date(now).toISOString().slice(0, 10);
    if (rt.day?.date !== date) rt.day = { date, equity };

    // loss limits (paper): close everything at the book, then stop
    if (paper && (equity < capital * (1 - a.risk.maxTotalLossPct / 100) || equity < rt.day.equity - capital * a.risk.maxDailyLossPct / 100)) {
      for (const q of [...book.quotes]) await gw.cancel({ kind: 'agent', id: a.id }, q.id).catch(() => {});
      book.quotes = [];
      for (const v of views) { const p = book.positions[v.id]; if (p && p.size !== 0) await submit({ instrument: v.id, side: p.size > 0 ? 'sell' : 'buy', size: Math.abs(p.size), type: 'market', price: p.size > 0 ? v.bid : v.ask, reduceOnly: true, tag: 'x' }, null); }
      book.pair = null; rt.book = book; rt.counters = counters; await save();
      const why = `loss limit reached: simulated equity ${equity.toFixed(2)} USD against ${capital.toFixed(2)} allocated; quotes cancelled and positions closed at the book`;
      await sql`update agents set state = 'STOPPED', stop_reason = ${why}, updated_at = now() where id = ${a.id}`;
      await journal(a.id, { mode, kind: 'stop', code: 'loss_limit', severity: 'warning', title: 'Agent stopped', body: why, configVersion: a.config_version });
      return 'stopped: loss limit';
    }

    const every = Number(cfg.decisionEveryMs ?? 5000);
    if (rt.lastDecisionAt && now - rt.lastDecisionAt < every && !filledNow) { rt.book = book; rt.counters = counters; if (filledNow) await save(); return 'waiting'; }
    rt.lastDecisionAt = now; counters.decisions += 1; this.stats.decisions += 1;

    // the rule
    let output: Record<string, unknown>, code: ReasonCode, reason: string, acted = false;
    const inputs = { rule, config: cfg, views: views.map((v) => ({ id: v.id, bid: v.bid, bidSize: v.bidSize, ask: v.ask, askSize: v.askSize, mark: v.mark, funding: v.funding, bookTs: v.bookTs })) };
    const record = async (decision: 'acted' | 'skipped'): Promise<string | null> => {
      // every action is a signal row; holds are stored when the reason changes, and at most every `signalEveryMs`
      if (decision === 'skipped' && rt.lastCode === code && rt.lastSignalAt && now - rt.lastSignalAt < (this.o.signalEveryMs ?? 60_000)) return null;
      rt.lastSignalAt = now; rt.lastCode = code;
      const [row] = await sql<{ id: string }[]>`insert into agent_signals (agent_id, bar, mode, kind, config_version, strategy_sha256, inputs_digest, status, reason, decision, reason_code, weights, equity)
        values (${a.id}, ${new Date(now)}, ${mode}, 'stream', ${a.config_version}, ${ruleHash(rule)}, ${inputsDigest(inputs)}, 'done', ${reason.slice(0, 300)}, ${decision}, ${code}, ${sql.json(output as never)}, ${paper ? dec(equity, 6) : null})
        on conflict (agent_id, mode, bar) do update set status = excluded.status, reason = excluded.reason, decision = excluded.decision, reason_code = excluded.reason_code, weights = excluded.weights, equity = excluded.equity,
          inputs_digest = excluded.inputs_digest, config_version = excluded.config_version, updated_at = now() returning id`;   // two decisions in the same millisecond: the later one is the record of that instant
      return row ? String(row.id) : null;
    };

    if (rule === 'spread_inventory') {
      const v = views[0]!, c = cfg as unknown as MmConfig, inv = book.positions[v.id]?.size ?? 0;
      book.mids.push(mid(v)); if (book.mids.length > 240) book.mids.splice(0, book.mids.length - 240);
      const q = mmQuotes({ ...c, quoteSizeUsd: Number(c.quoteSizeUsd), minHalfSpreadBps: Number(c.minHalfSpreadBps), volMultiplier: Number(c.volMultiplier), skewBps: Number(c.skewBps), maxInventoryUsd: Math.min(Number(c.maxInventoryUsd), a.risk.maxPositionUsd), volWindow: Number(c.volWindow) }, v, book.mids, inv);
      output = { bid: q.bid, ask: q.ask, mid: q.mid, volBps: q.volBps, halfSpreadBps: q.halfSpreadBps, skewBps: q.skewBps, inventoryUsd: q.inventoryUsd, notes: q.notes };
      if (!paper) { code = 'research_mode'; reason = 'research mode: the quotes are computed and stored, nothing is placed'; await record('skipped'); }
      else {
        const cur = (side: 'buy' | 'sell'): Quote | undefined => book.quotes.find((x) => x.instrument === v.id && x.side === side), rb = Number(c.requoteBps ?? 2);
        const moves: ['buy' | 'sell', { price: number; size: number } | null][] = [['buy', q.bid], ['sell', q.ask]];
        const todo = moves.filter(([side, t]) => needsRequote(cur(side), t, rb));
        code = todo.length ? 'acted' : !q.bid && !q.ask ? 'inventory_limit' : 'at_target';
        reason = todo.length ? `quotes ${q.bid ? q.bid.price : '—'} / ${q.ask ? q.ask.price : '—'} (half-spread ${q.halfSpreadBps.toFixed(2)} bps, skew ${q.skewBps.toFixed(2)} bps)` : q.notes.join('; ') || 'quotes already in place';
        const sid = await record(todo.length ? 'acted' : 'skipped');
        for (const [side, t] of todo) {
          const old = cur(side);
          if (old) await gw.cancel({ kind: 'agent', id: a.id }, old.id).catch(() => {});
          book.quotes = book.quotes.filter((x) => x.id !== old?.id);
          if (t) { const r = await submit({ instrument: v.id, side, size: t.size, type: 'limit', price: t.price, reduceOnly: false, tag: side === 'buy' ? 'b' : 'a' }, sid); if (r.state === 'REJECTED') { code = r.reason === 'KILL_SWITCH_ACTIVE' ? 'kill_switch' : 'orders_refused'; } else acted = true; }
        }
      }
    } else {
      const [va, vb] = [views[0]!, views[1]!];
      const d = rule === 'net_spread'
        ? crossDecision(va, vb, { notionalUsd: String(cfg.notionalUsd), horizonHours: String(cfg.horizonHours), minNetEdgeBps: String(cfg.minNetEdgeBps), exitGapBps: String(cfg.exitGapBps), maxDataAgeMs: a.risk.maxDataAgeMs } satisfies CrossConfig, book.pair, now)
        : fundingDecision(va, vb, { notionalUsd: String(cfg.notionalUsd), horizonHours: String(cfg.horizonHours), minNetCarryBps: String(cfg.minNetCarryBps), exitNetCarryBps: String(cfg.exitNetCarryBps) } satisfies FundingConfig, book.pair);
      const { legs, ...rest } = d; output = { ...rest, legs };
      code = d.reasonCode; reason = d.reason;
      // the agent's own exposure limit, before any leg
      const legUsd = legs.filter((l) => !l.reduceOnly).reduce((s, l) => s + l.size * l.price, 0);
      const blocked = d.action === 'open' && (grossUsd(book, marks) + legUsd > a.risk.maxGrossUsd || legs.some((l) => l.size * l.price > a.risk.maxPositionUsd));
      if (blocked) { code = 'risk_limit'; reason = `${reason} — NOT opened: the two legs (${legUsd.toFixed(2)} USD) exceed the agent's limits (position ${a.risk.maxPositionUsd}, gross ${a.risk.maxGrossUsd})`; }
      if (!paper) { if (d.action !== 'hold') { code = 'research_mode'; reason = `research mode — would ${d.action}: ${d.reason}`; } await record('skipped'); }
      else if (d.action === 'hold' || blocked) await record('skipped');
      else {
        const sid = await record('acted'), recs = [];
        for (const [i, l] of legs.entries()) recs.push(await submit({ instrument: l.instrument, side: l.side, size: l.size, type: 'market', price: l.price, reduceOnly: l.reduceOnly, tag: `${d.action === 'open' ? 'o' : 'c'}${i}` }, sid));
        if (recs.every((r) => r.state === 'FILLED')) {
          acted = true;
          book.pair = d.action === 'open' ? { longInstrument: legs[0]!.instrument, shortInstrument: legs[1]!.instrument, sizeBase: legs[0]!.size, openedAt: now, entryGapBps: 'best' in d ? num(d.best.grossGapBps) : null, tag: rule } : null;
        } else {
          // a leg was refused (kill switch, limits): whatever the other leg opened is closed at once — a simulated book is never left with one leg
          code = recs.some((r) => r.reason === 'KILL_SWITCH_ACTIVE') ? 'kill_switch' : 'orders_refused';
          for (const v of views) { const p = book.positions[v.id]; if (d.action === 'open' && p && p.size !== 0) await submit({ instrument: v.id, side: p.size > 0 ? 'sell' : 'buy', size: Math.abs(p.size), type: 'market', price: p.size > 0 ? v.bid : v.ask, reduceOnly: true, tag: 'u' }, sid); }
        }
      }
    }
    if (acted) counters.acted += 1;
    // equity curve of the simulation, at a fixed cadence
    const eqEvery = this.o.equityEveryMs ?? 60_000;
    if (paper && (!rt.lastEquityAt || now - rt.lastEquityAt >= eqEvery)) {
      rt.lastEquityAt = now;
      await sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${a.id}, ${new Date(Math.floor(now / eqEvery) * eqEvery)}, 'PAPER', ${paperEquity(book, marks)}, ${sql.json(Object.fromEntries(Object.entries(book.positions).map(([k, p]) => [k, p.size])) as never)})
        on conflict (agent_id, ts, mode) do update set equity_usd = excluded.equity_usd, positions = excluded.positions`;
    }
    rt.book = book; rt.counters = counters;
    await save();
    return acted ? `acted: ${reason.slice(0, 120)}` : `${code}: ${reason.slice(0, 120)}`;
  }

  private async hold(a: StreamAgentRow, rt: StreamRuntime, mode: DbMode, code: string, reason: string, save: () => Promise<void>): Promise<string> {
    const now = this.feed.now();
    if (rt.hold?.code !== code) {
      rt.hold = { code, since: now };
      await journal(a.id, { mode, kind: 'hold', code, severity: 'warning', title: code === 'data_gap' ? 'Data gap: quoting and decisions paused' : code === 'no_market' ? 'No market on a venue' : 'Data too old: no decision', body: reason, configVersion: a.config_version });
      await sql`insert into agent_signals (agent_id, bar, mode, kind, config_version, strategy_sha256, status, reason, decision, reason_code) values (${a.id}, ${new Date(now)}, ${mode}, 'stream', ${a.config_version}, ${ruleHash(rt.rule)}, 'hold', ${reason.slice(0, 300)}, 'skipped', ${code})
        on conflict (agent_id, mode, bar) do update set status = 'hold', reason = excluded.reason, decision = 'skipped', reason_code = excluded.reason_code, weights = null, updated_at = now()`;
    }
    await save();
    return `hold: ${reason.slice(0, 120)}`;
  }

  /** release the streams of instruments no agent uses any more */
  retain(instrumentIds: Set<string>): void { for (const [id, m] of this.markets) if (!instrumentIds.has(id)) { m.stop(); this.markets.delete(id); } }
  close(): void { for (const m of this.markets.values()) m.stop(); this.markets.clear(); }
  marketStatus(): { id: string; status: string; bookAgeMs: number | null; gap: boolean }[] { const now = this.feed.now(); return [...this.markets.values()].map((m) => ({ id: m.inst.id, status: m.status, bookAgeMs: m.bookAt ? now - m.bookAt : null, gap: m.gapSince !== null })); }
}

// ------------------------------------------------------------------------------------------------------------------ backtest on recorded data

export interface ReplayReport { kind: 'recorded_replay'; label: 'backtest'; rule: string; ruleSha256: string; instruments: string[]; from: number | null; to: number | null; snapshots: number; expected: number; missing: number; gaps: number;
  performance: Performance; decisions: number; actions: number; fills: number; model: string[]; warnings: string[] }
interface SnapRow { venue: string; symbol: string; ts: Date; bid: string; bid_size: string; ask: string; ask_size: string; mark: string | null; index_price: string | null; funding: string | null; funding_interval_sec: number | null }

/** Run a stream rule over the snapshots the engine recorded: the same decision functions, the same paper fill model, no gateway and
 *  no order (research). The book of a recorded instant is its top level only, so a size larger than what rested there is not filled. */
export async function replayRecorded(o: { rule: string; config: Record<string, unknown>; risk: StreamAgentRow['risk']; capital: number; instruments: Instrument[]; fees: (venue: string) => FeeSchedule | null; from: number; to: number; snapshotMs?: number }): Promise<ReplayReport> {
  const every = o.snapshotMs ?? 10_000, book = newPaperBook(o.capital), equity: EquityPoint[] = [];
  const keys = o.instruments.map((i) => `${i.venue}:${i.symbol}`);
  const rows = await sql<SnapRow[]>`select venue, symbol, ts, bid::text as bid, bid_size::text as bid_size, ask::text as ask, ask_size::text as ask_size, mark::text as mark, index_price::text as index_price, funding::text as funding, funding_interval_sec
    from market_snapshots where venue || ':' || symbol in ${sql(keys)} and ts >= ${new Date(o.from)} and ts < ${new Date(o.to)} and bid is not null and ask is not null order by ts`;
  const [g] = await sql<{ n: number }[]>`select count(*)::int as n from market_snapshot_gaps where venue || ':' || symbol in ${sql(keys)} and ts >= ${new Date(o.from)} and ts < ${new Date(o.to)}`;
  const byTs = new Map<number, Map<string, SnapRow>>();
  for (const r of rows) { const t = r.ts.getTime(); if (!byTs.has(t)) byTs.set(t, new Map()); byTs.get(t)!.set(`${r.venue}:${r.symbol}`, r); }
  const times = [...byTs.keys()].sort((x, y) => x - y);
  const feeRate = (venue: string, liq: 'maker' | 'taker'): number => { const f = o.fees(venue); return f ? Number(liq === 'maker' ? f.makerRate : f.takerRate) : 0.0005; };
  let decisions = 0, actions = 0, fills = 0, complete = 0, lastDecision = 0;
  const decideEvery = Number(o.config.decisionEveryMs ?? 5000);
  for (const t of times) {
    const at = byTs.get(t)!, views: MarketView[] = [];
    for (const inst of o.instruments) {
      const r = at.get(`${inst.venue}:${inst.symbol}`); if (!r) break;
      const bk: Book = { instrument: inst.id, bids: [[r.bid, r.bid_size]], asks: [[r.ask, r.ask_size]], ts: t };
      const tk: Ticker = { instrument: inst.id, mark: r.mark ?? r.bid, index: r.index_price, mid: null, funding: r.funding, openInterest: null, volume24h: null, change24h: null, ts: t };
      const v = viewOf(inst, bk, tk, o.fees(inst.venue), t, t); if (v) views.push(v);
    }
    if (views.length !== o.instruments.length) continue;                      // an instant without every instrument is not decided on (it is counted as missing below)
    complete += 1;
    const marks = Object.fromEntries(views.map((v) => [v.id, v.mark ?? mid(v)]));
    for (const v of views) for (const f of mmFills(book.quotes, v, Number(o.config.minRestMs ?? 1000))) { applyFill(book, f.quote.instrument, f.quote.side, f.size, f.price, feeRate(v.venue, 'maker')); book.quotes = book.quotes.filter((q) => q.id !== f.quote.id); fills += 1; }
    accrueFunding(book, views, t);
    if (t - lastDecision >= decideEvery) {
      lastDecision = t; decisions += 1;
      if (o.rule === 'spread_inventory') {
        const v = views[0]!, c = o.config as unknown as MmConfig;
        book.mids.push(mid(v)); if (book.mids.length > 240) book.mids.shift();
        const q = mmQuotes({ quoteSizeUsd: Number(c.quoteSizeUsd), minHalfSpreadBps: Number(c.minHalfSpreadBps), volMultiplier: Number(c.volMultiplier), skewBps: Number(c.skewBps), maxInventoryUsd: Math.min(Number(c.maxInventoryUsd), o.risk.maxPositionUsd), volWindow: Number(c.volWindow) }, v, book.mids, book.positions[v.id]?.size ?? 0);
        for (const [side, tq] of [['buy', q.bid], ['sell', q.ask]] as const) {
          const cur = book.quotes.find((x) => x.instrument === v.id && x.side === side);
          if (!needsRequote(cur, tq, Number(c.requoteBps ?? 2))) continue;
          book.quotes = book.quotes.filter((x) => x !== cur); actions += 1;
          if (tq) book.quotes.push({ id: `r-${t}-${side}`, side, price: tq.price, size: tq.size, ts: t, instrument: v.id });
        }
      } else {
        const d = o.rule === 'net_spread'
          ? crossDecision(views[0]!, views[1]!, { notionalUsd: String(o.config.notionalUsd), horizonHours: String(o.config.horizonHours), minNetEdgeBps: String(o.config.minNetEdgeBps), exitGapBps: String(o.config.exitGapBps), maxDataAgeMs: 2 * every }, book.pair, t)
          : fundingDecision(views[0]!, views[1]!, { notionalUsd: String(o.config.notionalUsd), horizonHours: String(o.config.horizonHours), minNetCarryBps: String(o.config.minNetCarryBps), exitNetCarryBps: String(o.config.exitNetCarryBps) }, book.pair);
        if (d.action !== 'hold') {
          actions += 1;
          for (const l of d.legs) { applyFill(book, l.instrument, l.side, l.size, l.price, feeRate(l.instrument.slice(0, l.instrument.indexOf(':')), 'taker')); fills += 1; }
          book.pair = d.action === 'open' ? { longInstrument: d.legs[0]!.instrument, shortInstrument: d.legs[1]!.instrument, sizeBase: d.legs[0]!.size, openedAt: t, entryGapBps: null, tag: o.rule } : null;
        }
      }
    }
    equity.push({ ts: t, equity: paperEquity(book, marks) });
  }
  const expected = Math.max(0, Math.floor((Math.min(o.to, times.at(-1) ?? o.to) - Math.max(o.from, times[0] ?? o.from)) / every) + (times.length ? 1 : 0));
  const perf = computePerformance({ equity, trades: [], funding: [], notes: { trades: 'the replay keeps no trade list', fees: 'inside the equity', slippage: 'the fill model has no slippage figure', funding: 'inside the equity' } });
  const warnings: string[] = [];
  if (complete < 360) warnings.push(`${complete} recorded instant(s): far too few to conclude anything`);
  if (expected > complete) warnings.push(`${expected - complete} of ${expected} expected snapshots are missing in this window: the replay skipped them`);
  return { kind: 'recorded_replay', label: 'backtest', rule: o.rule, ruleSha256: ruleHash(o.rule), instruments: o.instruments.map((i) => i.id), from: times[0] ?? null, to: times.at(-1) ?? null, snapshots: complete, expected, missing: Math.max(0, expected - complete), gaps: g?.n ?? 0,
    performance: { ...perf, feesUsd: { value: book.fees, reason: null }, fundingUsd: { value: book.funding, reason: null }, turnover: perf.turnover.value === null && equity.length ? { value: book.turnover / (equity.reduce((s, p) => s + p.equity, 0) / equity.length), reason: null } : perf.turnover },
    decisions, actions, fills,
    model: ['BACKTEST on recorded top-of-book snapshots — not a track record', `snapshot cadence ${every} ms: whatever happened between two snapshots is not seen`, 'maker fills: only when a later best price trades strictly through the quote; at the quote price; at most the size that rested at the crossing best price',
      'taker fills: at the recorded best bid/ask, limited by nothing but the lot (depth beyond the top level is not recorded)', 'fees: the venue\'s reviewed base tier; funding: the recorded rate at each real interval boundary', 'no latency, no queue position, no market impact'],
    warnings };
}

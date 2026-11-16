// Perp agent engine (V6 PAPER; V7 also LIVE on a venue account — see perp-exec-live.ts and perp-live-cycle.ts). Same discipline as the spot engine (engine.ts): deterministic, no LLM, decisions on closed
// bars only, a data gate in front of the signal, a strategy pinned by its hash, and "hold" whenever anything is not trustworthy.
//
// Per closed bar:  gate → signal (spq.signal --contract 2, a separate process) → weights validated against the META bounds
// pinned at registration → scaled DOWN together to the owner's limits (never up) → target sizes in base units from equity and
// mark (exact decimals) → orders = deltas, reduce first → the executor (risk engine, then the paper engine) → signal log.
// On every pass, before anything else: risk events of the account (a liquidation stops the agent, a margin warning flags it)
// and the loss limits (breach → flatten with reduce-only orders, then stop).
//
// Execution goes through ONE narrow interface, `PerpExecutor`: the paper account (perp-exec.ts) or, for a LIVE agent, a venue
// account whose orders the isolated signer signs under a derivative mandate (perp-exec-live.ts). The engine itself never
// signs, never calls the signer and never reaches a venue's trading endpoint.
//
// Numbers: the strategy's weights are the only floats; each is converted once to an 8-decimal string. Equity, marks, sizes,
// notionals and prices are `D` decimals from there on.
import { z } from 'zod';
import { formatUnits } from '@spw/core';
import { D, type AccountState, type Book, type Dec, type DecStr, type Fill, type Instrument, type Order, type OrderRequest, type Position, type RiskPolicy, type Ticker } from '@spw/derivatives';
import { audit, sql } from '../db.ts';
import { worstPrice } from '../derivatives/paper.ts';
import type { AgentOrderGateway, KillSwitchRead, SeamResult } from '../agent-runtime/gateway.ts';
import { decisionOf, inputsDigest, journal } from '../agent-runtime/journal.ts';
import type { PerpInterval, PerpSeries } from './perp-data.ts';
import { GatewayPerpExecutor } from './perp-gateway.ts';
import type { AgentRow } from './routes.ts';

// ------------------------------------------------------------------ the owner's limits

/** Set by the owner at creation. They feed BOTH the derivatives risk engine (`perpPolicy`) and the engine's own sizing. */
export const PerpRisk = z.strictObject({
  /** account leverage: gross exposure / equity. Also the leverage setting of every order (an integer on Hyperliquid). */
  maxLeverage: z.number().int().min(1).max(5).default(2),
  /** gross exposure (sum of |notional|) as a multiple of the capital */
  maxGrossExposureX: z.number().min(0.1).max(5).default(1.5),
  /** position on one instrument as a multiple of the capital */
  maxPositionX: z.number().min(0.05).max(5).default(1),
  /** loss in one UTC day / since creation, in percent of the capital: flatten, then stop (can be overshot by a gap) */
  maxDailyLossPct: z.number().min(0.01).max(50).default(3),
  maxTotalLossPct: z.number().min(0.01).max(90).default(10),
  /** worst price of a market order: this far beyond the best opposite price, in basis points */
  slippageBps: z.number().int().min(5).max(100).default(30),
  /** a rebalance smaller than this share of equity is not traded (a full exit always is), percent */
  minTradePct: z.number().min(0.5).max(20).default(2),
});
export type PerpRisk = z.infer<typeof PerpRisk>;

/** bookkeeping of the engine on the agent row (`agents.perp`) */
export interface PerpBook {
  lastEventId?: number;
  /** a margin warning seen on the account */
  flag?: { ts: number; message: string } | null;
  /** why the last pass held */
  hold?: { ts: number; reason: string } | null;
  /** equity at the first pass of the UTC day (daily loss reference) */
  day?: { date: string; equity: DecStr };
  /** set when a loss limit is breached: the agent closes everything, then stops */
  flatten?: { ts: number; reason: string } | null;
  /** V7: the agent trades (or traded) a venue account under a derivative mandate — written by perp-live-cycle.ts only */
  live?: PerpLiveBook | null;
}
/** bookkeeping of the LIVE life cycle (perp-live-cycle.ts) */
export interface PerpLiveBook {
  accountId: string; network: 'testnet' | 'mainnet'; mandateId: string; strategySha256: string; since: number; /** V11.2: mandateId is an owner-approved TRADING mandate (mandates/service.ts) — the only authority for new risk */ unified?: boolean;
  /** reference capital of the loss limits and of the absolute caps: the venue's account value when the mandate was prepared */
  capital: DecStr;
  /** why the agent left LIVE; `done` once it is STOPPED; `retryAt`: no closing attempt before this time (after a refused one) */
  exit?: { ts: number; code: string; reason: string; retryAt?: number; done?: number; closed?: number } | null;
}
export type PerpAgentRow = Omit<AgentRow, 'risk'> & { kind: 'perp'; risk: PerpRisk; deriv_account_id: string; perp: PerpBook | null };

export const PERP_VENUE = 'hyperliquid' as const;
/** margin kept free: the engine never targets more than this share of leverage × equity */
export const LEVERAGE_HEADROOM = '0.9';
/** the absolute caps are approached to within 2 % plus the slippage bound (the risk engine values an order at its worst price) */
export const CAP_HEADROOM = '0.02';
/** an order must clear the venue's minimum notional by this factor at the mark (its worst price is below the mark for a sell) */
const MIN_NOTIONAL_FACTOR = D.from('1.05');
const HUNDRED = D.from(100n), BPS = D.from(10000n);

const numDec = (n: number, dp = 8): Dec => {
  if (!Number.isFinite(n)) throw new Error('not a finite number');
  return D.from(n.toFixed(dp).replace(/^-0(\.0+)?$/, '0'));
};
const capitalOf = (a: Pick<AgentRow, 'capital_usdc'>): Dec => D.from(formatUnits(BigInt(a.capital_usdc), 6));
export const instrumentId = (symbol: string): string => `${PERP_VENUE}:${symbol}`;

/** The risk policy of the agent's account, derived from the owner's limits: the derivatives risk engine enforces it on every order. */
export function perpPolicy(symbols: string[], capital: DecStr, r: PerpRisk, halt: string | null = null): RiskPolicy {
  const c = D.from(capital), times = (k: Dec): DecStr => D.str(D.mul(c, k));
  return {
    mode: 'PAPER', allowedInstruments: symbols.map(instrumentId), halt,
    maxDataAgeMs: 10_000, maxDeviationBps: '200', maxMarkIndexBps: '100', maxLeverage: String(r.maxLeverage),
    maxOrderNotional: times(numDec(r.maxPositionX, 4)), maxGrossExposure: times(numDec(r.maxGrossExposureX, 4)), maxPositionNotional: times(numDec(r.maxPositionX, 4)),
    minFreeCollateral: times(D.from('0.05')), minLiquidationDistanceBps: '1000',
    maxDailyLoss: times(D.div(numDec(r.maxDailyLossPct, 4), HUNDRED, 8, 'down')), maxTotalLoss: times(D.div(numDec(r.maxTotalLossPct, 4), HUNDRED, 8, 'down')),
    maxOrdersPerMinute: 40, maxOrdersPerDay: 400,
  };
}

// ------------------------------------------------------------------ the one interface a live path will implement

export interface ExecEvent { id: number; ts: number; kind: string; code: string | null; message: string }
export interface ExecAccount { state: AccountState; /** the policy in force, with its circuit breaker (`halt`) */ policy: RiskPolicy; /** liquidations and margin warnings recorded after `sinceEventId` */ events: ExecEvent[] }
export type PlaceResult =
  | { status: 'placed'; order: Order; fills: Fill[]; idempotent: boolean }
  /** refused by the risk engine (or by the signer's mandate): nothing was sent, or the venue refused it — nothing more on this bar */
  | { status: 'refused'; code: string; reason: string }
  /** LIVE only: nothing was sent NOW (an earlier order is still being checked on the venue, or the signer still counts the
   *  last one): the bar stays open and the next pass plans again from the venue's real positions */
  | { status: 'deferred'; code: string; reason: string };

/**
 * Everything the engine needs from "an account that can hold perpetual positions". PAPER: the derivatives paper account
 * (perp-exec.ts). LIVE (V7, perp-exec-live.ts): the same three calls over a venue account whose orders the signer signs under a
 * derivative mandate; the account state and the positions are then the VENUE's own (`source: 'venue'`).
 *  - `place` takes a complete order: `price` is the worst acceptable price (market orders are IOC with that bound), `clientId`
 *    is the idempotency key (placing it twice returns the first result). A refusal is returned, never thrown; an exception
 *    means "could not be attempted now" and the engine retries the bar on its next pass.
 */
export interface PerpExecutor {
  account(sinceEventId?: number): Promise<ExecAccount>;
  positions(): Promise<Position[]>;
  place(order: OrderRequest, leverage: DecStr): Promise<PlaceResult>;
  /** LIVE only: instruments on which an order of the agent is not confirmed by the venue yet — the bar stays open for them */
  unconfirmed?(): string[];
  /** V11.2, LIVE only: what the executor decides before an order exists, and what it is told once the unified order service answered */
  prepare?(order: OrderRequest, leverage: DecStr): Promise<{ proceed: true; size: DecStr } | { proceed: false; result: PlaceResult }>;
  observe?(order: OrderRequest, outcome: { state: string; rejectCode: string | null; detail: string | null }): Promise<void>;
}

/** What a LIVE agent adds to an engine step (perp-live-cycle.ts). Absent = PAPER, exactly as before. */
export interface PerpLiveHooks {
  /** reference capital of the loss limits and of the absolute caps (the venue's account value at go-live), instead of the simulated capital */
  capital: DecStr;
  /** a paused live agent: account events and loss limits only — no signal, no order; its positions are kept */
  riskOnly?: boolean;
  /** a loss limit is breached: the live life cycle takes over (revoke the mandate, close with reduce-only orders, stop) */
  onBreach(reason: string): Promise<string>;
}

export interface PerpSignal { weights: Record<string, number>; maxLeverage: number; maxGrossExposure: number }
export interface PerpMarket { inst: Instrument; ticker: Ticker; book: Book }
export interface PerpEngineDeps {
  now(): number;
  /** closed bars + aligned funding of every symbol, fresh, gap-free and cross-checked right now; throws otherwise (→ hold) */
  gate(symbols: string[], interval: PerpInterval, lookback: number): Promise<{ bar: number; data: Record<string, PerpSeries> }>;
  /** run the approved strategy version (contract 2) on these series; throws on any problem (→ hold) */
  signal(strategy: { path: string; sha256: string }, data: Record<string, PerpSeries>, interval: PerpInterval): Promise<PerpSignal>;
  /** instrument, live ticker and live book of one symbol */
  market(symbol: string): Promise<PerpMarket>;
  executor(a: PerpAgentRow): PerpExecutor;
  /** V11: what the execution side knows about an order of this agent by its client id, without sending anything (LIVE: the venue
   *  account's stored order). Used by the order gateway to settle an order whose outcome is not known. Absent = the paper account. */
  lookupOrder?(clientId: string): Promise<SeamResult | null>;
  /** V11, tests: the order gateway and the kill switch of this tick instead of the bound ones */
  gateway?(a: PerpAgentRow, inner: PerpExecutor): AgentOrderGateway;
  killSwitch?: KillSwitchRead;
}

/** V11 — every order of a perp agent goes through the order gateway: the engine's executor is wrapped, reads pass through. */
export function gatewayExecutor(a: PerpAgentRow, inner: PerpExecutor, d: Pick<PerpEngineDeps, 'now' | 'lookupOrder' | 'gateway' | 'killSwitch'>): GatewayPerpExecutor {
  if (inner instanceof GatewayPerpExecutor) return inner;
  const lb = a.mode === 'LIVE' ? a.perp?.live ?? null : null, gw = d.gateway?.(a, inner);
  // the authority an order names: LIVE — the owner-approved TRADING mandate in force (`unified`; a derivative mandate approved
  // before the trading mandates existed authorises reduce-only exits only); PAPER — the agent's paper trading mandate
  const paper = (a as unknown as { runtime?: { paperMandate?: { id: string } } | null }).runtime?.paperMandate?.id ?? null;
  return new GatewayPerpExecutor(a, inner, { mode: lb ? 'live' : 'paper', network: lb?.network ?? 'mainnet', authorityId: lb ? (lb.unified ? lb.mandateId : null) : paper, legacyAuthorityId: lb && !lb.unified ? lb.mandateId : null, accountId: lb?.accountId ?? a.deriv_account_id,
    slippageBps: a.risk.slippageBps, now: d.now, configVersion: a.config_version ?? 1, ...(d.lookupOrder ? { lookup: d.lookupOrder } : {}), ...(gw ? { gateway: gw } : {}), ...(d.killSwitch ? { killSwitch: d.killSwitch } : {}) });
}

// ------------------------------------------------------------------ pure parts

export interface PerpMetaBounds { max_leverage: number; max_gross_exposure: number }
/** Validate a contract-2 answer against the META bounds pinned at registration. Anything else means "hold". */
export function checkPerpWeights(sig: unknown, symbols: string[], meta: PerpMetaBounds): Record<string, Dec> {
  const s = sig as Partial<PerpSignal> | null;
  if (!s || typeof s !== 'object') throw new Error('no signal');
  if (s.maxLeverage !== meta.max_leverage || s.maxGrossExposure !== meta.max_gross_exposure) throw new Error('the signal declares other leverage bounds than the registered version');
  const w = s.weights;
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error('weights are not an object');
  const out: Record<string, Dec> = {}; let gross = 0;
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
    if (!symbols.includes(k)) throw new Error(`weight for ${k}, which is outside the agent's instruments`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`weight for ${k} is not a finite number`);
    if (Math.abs(v) > meta.max_leverage + 1e-9) throw new Error(`weight for ${k} is outside ±${meta.max_leverage} (META max_leverage)`);
    gross += Math.abs(v); out[k] = numDec(v);
  }
  if (gross > meta.max_gross_exposure + 1e-9) throw new Error(`gross exposure ${gross} exceeds META max_gross_exposure ${meta.max_gross_exposure}`);
  for (const sym of symbols) out[sym] ??= D.zero;
  return out;
}

/**
 * The owner's caps, applied to all weights TOGETHER by one factor ≤ 1 (the strategy's proportions are kept; nothing is ever
 * scaled up):  gross ≤ min(maxLeverage · equity · 0.9, maxGrossExposureX · capital · h),  each position ≤ maxPositionX · capital · h,
 * with h = 1 − 2 % − slippage bound.
 */
export function scalePerpWeights(w: Record<string, Dec>, equity: Dec, capital: Dec, r: PerpRisk): { scaled: Record<string, Dec>; factor: Dec; binding: 'none' | 'leverage' | 'gross' | 'position' | 'no_equity' } {
  const syms = Object.keys(w), zero = Object.fromEntries(syms.map((s) => [s, D.zero]));
  if (!D.isPos(equity)) return { scaled: zero, factor: D.zero, binding: 'no_equity' };
  const gross = syms.reduce((a, s) => D.add(a, D.abs(w[s]!)), D.zero), largest = syms.reduce((a, s) => D.max(a, D.abs(w[s]!)), D.zero);
  if (D.isZero(gross)) return { scaled: zero, factor: D.one, binding: 'none' };
  const h = D.sub(D.sub(D.one, D.from(CAP_HEADROOM)), D.div(D.from(BigInt(r.slippageBps)), BPS, 6, 'up'));
  const caps: [Dec, Dec, 'leverage' | 'gross' | 'position'][] = [
    [D.mul(D.mul(D.from(BigInt(r.maxLeverage)), equity), D.from(LEVERAGE_HEADROOM)), D.mul(gross, equity), 'leverage'],
    [D.mul(D.mul(numDec(r.maxGrossExposureX, 4), capital), h), D.mul(gross, equity), 'gross'],
    [D.mul(D.mul(numDec(r.maxPositionX, 4), capital), h), D.mul(largest, equity), 'position'],
  ];
  let factor = D.one, binding: 'none' | 'leverage' | 'gross' | 'position' = 'none';
  for (const [cap, wanted, name] of caps) {
    if (D.lte(wanted, cap)) continue;
    const f = D.div(cap, wanted, 12, 'down');
    if (D.lt(f, factor)) { factor = f; binding = name; }
  }
  return { scaled: Object.fromEntries(syms.map((s) => [s, D.mul(w[s]!, factor)])), factor, binding };
}

/** Signed target size in base units: |weight| · equity / mark, truncated to the lot. */
export function targetSize(weight: Dec, equity: Dec, mark: Dec, lot: Dec): Dec {
  if (!D.isPos(mark) || !D.isPos(equity) || D.isZero(weight)) return D.zero;
  const size = D.quantize(D.div(D.mul(D.abs(weight), equity), mark, 18, 'down'), lot, 'down');
  return D.isNeg(weight) ? D.neg(size) : size;
}

export interface PlannedPerpOrder {
  symbol: string; side: 'buy' | 'sell'; size: DecStr; reduceOnly: boolean;
  /** 'reduce' orders go first: they free margin */
  phase: 'reduce' | 'open';
  /** closes the whole position */
  closes: boolean;
  /** the opening half of a flip: only sent once the closing half is completely filled */
  afterClose: boolean;
  notional: DecStr; reason: string;
}

/**
 * Orders = target − current, per instrument. Pure.
 *  - target 0 → close everything (never blocked by the threshold);
 *  - opposite sign (long → short, short → long) → TWO orders: a reduce-only close of the whole position, then an open;
 *  - same sign, smaller → one reduce-only order; same sign, larger (or from flat) → one opening order;
 *  - an order below `threshold` (or the venue's minimum notional) is not sent, except a full close;
 *  - order: every reduce first (largest notional first), then every open (largest first); ties by symbol.
 */
export function planPerpOrders(targets: Record<string, Dec>, current: Record<string, Dec>, marks: Record<string, Dec>, minNotional: Record<string, Dec | null>, threshold: Dec): PlannedPerpOrder[] {
  const out: PlannedPerpOrder[] = [];
  for (const symbol of Object.keys(targets).sort()) {
    const tgt = targets[symbol]!, cur = current[symbol] ?? D.zero, mark = marks[symbol];
    if (!mark || !D.isPos(mark) || D.eq(tgt, cur)) continue;
    const floor = D.max(threshold, minNotional[symbol] ? D.mul(minNotional[symbol]!, MIN_NOTIONAL_FACTOR) : D.zero);
    const worth = (size: Dec): Dec => D.mul(D.abs(size), mark), big = (size: Dec): boolean => D.gte(worth(size), floor);
    const order = (side: 'buy' | 'sell', size: Dec, o: Pick<PlannedPerpOrder, 'reduceOnly' | 'phase' | 'closes' | 'afterClose' | 'reason'>): void => {
      out.push({ symbol, side, size: D.str(D.abs(size)), notional: D.str(worth(size)), ...o });
    };
    const curLong = D.isPos(cur), closeSide = curLong ? 'sell' as const : 'buy' as const;
    if (!D.isZero(cur) && (D.isZero(tgt) || D.sign(tgt) !== D.sign(cur))) {
      order(closeSide, cur, { reduceOnly: true, phase: 'reduce', closes: true, afterClose: false, reason: D.isZero(tgt) ? 'target flat: close' : `flip ${curLong ? 'long → short' : 'short → long'}: close first` });
      if (!D.isZero(tgt) && big(tgt)) order(D.isPos(tgt) ? 'buy' : 'sell', tgt, { reduceOnly: false, phase: 'open', closes: false, afterClose: true, reason: `flip: open ${D.isPos(tgt) ? 'long' : 'short'}` });
      continue;
    }
    const delta = D.sub(D.abs(tgt), D.abs(cur));
    if (!big(delta)) continue;
    if (D.isNeg(delta)) order(closeSide, delta, { reduceOnly: true, phase: 'reduce', closes: false, afterClose: false, reason: 'reduce toward target' });
    else order(D.isPos(tgt) ? 'buy' : 'sell', delta, { reduceOnly: false, phase: 'open', closes: false, afterClose: false, reason: D.isZero(cur) ? `open ${D.isPos(tgt) ? 'long' : 'short'}` : 'increase toward target' });
  }
  const rank = (o: PlannedPerpOrder): number => (o.phase === 'reduce' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || D.cmp(D.from(b.notional), D.from(a.notional)) || a.symbol.localeCompare(b.symbol));
}

/** signed size of a position */
const signed = (p: Pick<Position, 'side' | 'size'>): Dec => (p.side === 'long' ? D.from(p.size) : D.neg(D.from(p.size)));
/** equity = collateral + unrealised PnL of every position at the given marks (a position without a mark keeps its own) */
export function equityAt(collateral: DecStr, positions: Position[], marks: Record<string, Dec>): Dec {
  return positions.reduce((acc, p) => {
    const sym = p.instrument.slice(p.instrument.indexOf(':') + 1), mark = marks[sym] ?? D.from(p.markPrice);
    return D.add(acc, D.mul(signed(p), D.sub(mark, D.from(p.entryPrice))));
  }, D.from(collateral));
}

/** Loss limits of the engine, on equity against the capital and against the equity at the start of the UTC day. */
export function lossBreach(equity: Dec, capital: Dec, dayEquity: Dec, r: PerpRisk): string | null {
  const total = D.sub(capital, equity), daily = D.sub(dayEquity, equity);
  const limit = (pct: number): Dec => D.div(D.mul(capital, numDec(pct, 4)), HUNDRED, 8, 'down');
  if (D.gte(total, limit(r.maxTotalLossPct))) return `total loss limit reached: equity ${D.str(D.quantize(equity, D.from('0.01'), 'down'))} USDC against ${D.str(capital)} allocated (limit ${r.maxTotalLossPct} %)`;
  if (D.gte(daily, limit(r.maxDailyLossPct))) return `daily loss limit reached: equity ${D.str(D.quantize(equity, D.from('0.01'), 'down'))} USDC against ${D.str(D.quantize(dayEquity, D.from('0.01'), 'down'))} at the start of the day (limit ${r.maxDailyLossPct} % of the capital)`;
  return null;
}

// ------------------------------------------------------------------ one engine step

/** journal line of the engine, tagged with the mode the agent trades in (V11: no mode-less line) */
const log = (a: { id: string; mode?: string; config_version?: number }, kind: 'hold' | 'stop' | 'risk' | 'flag', title: string, body = '', data?: unknown) =>
  journal(a.id, { mode: a.mode === 'LIVE' ? 'LIVE' : 'PAPER', kind, title, body, ...(data === undefined ? {} : { data }), severity: kind === 'hold' ? 'info' : 'warning', configVersion: a.config_version ?? null });
/** The engine's own bookkeeping. The keys of the LIVE life cycle (`live`, `livePending`) are never written from here: they are
 *  kept as they are in the database, so that a pass that started before the owner stopped the agent cannot undo the stop. */
const saveBook = (a: { id: string }, book: PerpBook) => {
  const own: Record<string, unknown> = { ...book }; delete own.live; delete own.livePending;
  return sql`update agents set perp = jsonb_strip_nulls(jsonb_build_object('live', perp->'live', 'livePending', perp->'livePending')) || ${sql.json(own as never)}, updated_at = now() where id = ${a.id}`;
};
const str = (o: Record<string, Dec>): Record<string, DecStr> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, D.str(v)]));

async function stop(a: PerpAgentRow, reason: string): Promise<void> {
  await sql`update agents set state = 'STOPPED', stop_reason = ${reason}, updated_at = now() where id = ${a.id}`;
  await log(a, 'stop', 'Agent stopped', reason);
  await audit('agent.stopped', 'engine', { id: a.id, kind: 'perp', reason });
}

/** client id of an agent order: one per agent, strategy version, bar, instrument and phase — a restart cannot place it twice */
export const orderClientId = (agentId: string, sha256: string, bar: number, symbol: string, phase: 'reduce' | 'open'): string => `ag-${agentId}-${sha256.slice(0, 8)}-${Math.floor(bar / 1000)}-${symbol}-${phase === 'reduce' ? 'r' : 'o'}`;

function request(m: PerpMarket, side: 'buy' | 'sell', size: DecStr, reduceOnly: boolean, slippageBps: number, clientId: string): OrderRequest {
  // a "market" order is immediate-or-cancel at a worst price this far beyond the best opposite price, on the venue's price grid
  return { instrument: m.inst.id, side, type: 'market', size, price: worstPrice(m.inst, m.book, side, slippageBps), triggerPrice: null, reduceOnly, tif: 'ioc', clientId };
}
const leverageFor = (a: PerpAgentRow, inst: Instrument): DecStr => D.str(D.quantize(D.min(D.from(BigInt(a.risk.maxLeverage)), D.from(inst.maxLeverage)), D.one, 'down'));
const symbolOf = (instrument: string): string => instrument.slice(instrument.indexOf(':') + 1);

/** Close every position with reduce-only IOC orders (works under a halt). Returns the positions still open afterwards. */
export async function flattenPerp(a: PerpAgentRow, d: PerpEngineDeps, inner: PerpExecutor, tag: string, only?: (p: Position) => boolean): Promise<{ left: Position[]; results: Record<string, unknown>[] }> {
  const results: Record<string, unknown>[] = [], ex = gatewayExecutor(a, inner, d);
  for (const p of await ex.positions()) {
    if (only && !only(p)) continue;
    const symbol = symbolOf(p.instrument), m = await d.market(symbol), side = p.side === 'long' ? 'sell' as const : 'buy' as const;
    const r = await ex.place(request(m, side, p.size, true, a.risk.slippageBps, `ag-${a.id}-x${tag}-${symbol}`), leverageFor(a, m.inst));
    results.push(r.status === 'placed' ? { symbol, side, size: p.size, status: r.order.status, filled: r.order.filled, avgFillPrice: r.order.avgFillPrice } : { symbol, side, size: p.size, status: r.status, code: r.code, reason: r.reason });
  }
  return { left: await ex.positions(), results };
}

/** One engine step for one perp agent. Safe to call as often as wanted: it decides at most once per closed bar. */
export async function tickPerpAgent(a: PerpAgentRow, d: PerpEngineDeps, live?: PerpLiveHooks): Promise<string> {
  // PAPER: state PAPER_TRADING, no hooks. LIVE: only through perp-live-cycle.ts, which passes the hooks (a paused live agent runs `riskOnly`).
  const runs = live ? a.mode === 'LIVE' && (a.state === 'LIVE' || (a.state === 'PAUSED' && live.riskOnly === true)) : a.state === 'PAPER_TRADING' && a.mode !== 'LIVE';
  if (a.kind !== 'perp' || !runs) return 'idle';
  const ex = gatewayExecutor(a, d.executor(a), d), book: PerpBook = { ...(a.perp ?? {}) }, now = d.now(), capital = live ? D.from(live.capital) : capitalOf(a);
  const mode = live ? 'LIVE' : 'PAPER', cfg = a.config_version ?? 1;
  const what = live ? 'venue account' : 'paper account';
  /** equity: the venue's own account value when the state comes from the venue; the paper account's collateral + PnL at the live marks otherwise */
  const equityOf = (state: AccountState, pos: Position[]): Dec => (state.source === 'venue' ? D.from(state.equity) : equityAt(state.collateral, pos, marks));

  // 1 — what happened to the account since the last pass
  const acct = await ex.account(book.lastEventId ?? 0);
  let liquidated: ExecEvent | null = null;
  for (const e of acct.events) {
    book.lastEventId = Math.max(book.lastEventId ?? 0, e.id);
    if (e.kind === 'liquidation') liquidated = e;
    else if (e.kind === 'margin_warning') { book.flag = { ts: e.ts, message: e.message }; await log(a, 'flag', `Margin warning on the ${what}`, e.message); }
  }
  if (liquidated) { await saveBook(a, book); await stop(a, live ? `the venue account was liquidated: ${liquidated.message}` : `the paper account was liquidated (simulated): ${liquidated.message}`); return 'stopped: liquidation'; }

  // 2 — loss limits, on every pass (a gap can carry the loss past them before this runs)
  let positions = await ex.positions();
  const marks: Record<string, Dec> = {}, markets = new Map<string, PerpMarket>();
  const market = async (symbol: string): Promise<PerpMarket> => { let m = markets.get(symbol); if (!m) { m = await d.market(symbol); markets.set(symbol, m); marks[symbol] = D.from(m.ticker.mark); } return m; };
  let liveMarks = true;
  for (const p of positions) { try { await market(symbolOf(p.instrument)); } catch { liveMarks = false; } }   // no live mark: the account's own last mark is used
  const equity = equityOf(acct.state, positions);
  const date = new Date(now).toISOString().slice(0, 10);
  if (book.day?.date !== date) book.day = { date, equity: D.str(equity) };
  const breach = book.flatten?.reason ?? lossBreach(equity, capital, D.from(book.day.equity), a.risk) ?? (acct.policy.halt !== null ? `the account's circuit breaker is set: ${acct.policy.halt}` : null);
  if (breach && live) { await saveBook(a, book); return live.onBreach(breach); }
  if (live?.riskOnly) { await saveBook(a, book); return 'paused: positions kept, no new exposure (loss limits still watched)'; }
  if (breach) {
    if (!book.flatten) { book.flatten = { ts: now, reason: breach }; await log(a, 'risk', 'Loss limit: closing every position', breach); }
    await saveBook(a, book);
    const f = await flattenPerp(a, d, ex, String(Math.floor(now / 60_000)));
    if (f.results.length) await log(a, 'risk', 'Reduce-only closing orders', '', f.results);
    if (f.left.length) return `flattening: ${f.left.length} position(s) still open`;
    await stop(a, `${breach}; every position was closed with reduce-only orders`);
    return 'stopped: loss limit';
  }

  // 3 — the approved strategy version and the data gate
  if (!a.strategy_version_id) { await saveBook(a, book); return 'no strategy'; }
  const [sv] = await sql<{ path: string; code_sha256: string; status: string; meta: { kind?: string; lookback?: number; max_leverage?: number; max_gross_exposure?: number } }[]>`select path, code_sha256, status, meta from strategy_versions where id = ${a.strategy_version_id}`;
  if (!sv || sv.status !== 'approved') { await saveBook(a, book); return 'strategy not approved'; }
  if (sv.meta.kind !== 'perp' || typeof sv.meta.lookback !== 'number' || typeof sv.meta.max_leverage !== 'number' || typeof sv.meta.max_gross_exposure !== 'number') { await stop(a, 'the approved version is not a perpetual-futures strategy (contract 2)'); return 'stopped'; }
  const symbols = a.universe, interval = a.interval as PerpInterval;
  const foreign = positions.filter((p) => !symbols.includes(symbolOf(p.instrument)));
  if (foreign.length) { book.hold = { ts: now, reason: `the account holds ${foreign.map((p) => p.instrument).join(', ')}, which this agent does not manage` }; await saveBook(a, book); return `hold: ${book.hold.reason}`; }
  let gated: Awaited<ReturnType<PerpEngineDeps['gate']>>;
  try { gated = await d.gate(symbols, interval, sv.meta.lookback); }
  catch (e) { book.hold = { ts: now, reason: (e as Error).message.slice(0, 240) }; await saveBook(a, book); return `hold: ${book.hold.reason.slice(0, 120)}`; }   // stale or inconsistent data: never trade on it
  const bar = gated.bar;
  if (a.last_bar && a.last_bar.getTime() >= bar) { book.hold = null; await saveBook(a, book); return 'waiting for the next bar'; }

  // 4 — ONE decision per bar: the row is written before any order, and a restart reads it back instead of deciding again
  const complete = async (): Promise<void> => { await sql`update agents set last_bar = ${new Date(bar)}, updated_at = now() where id = ${a.id}`; };
  // V11: the signal log is `agent_signals` (one row per agent, MODE and bar), with the configuration version and a digest of the inputs
  let [row] = await sql<{ id: string; status: string; weights: Record<string, number> | null; strategy_sha256: string; orders?: { list?: Record<string, unknown>[] } | null }[]>`select id, status, weights, strategy_sha256, orders from agent_signals where agent_id = ${a.id} and mode = ${mode} and bar = ${new Date(bar)}`;
  if (!row) {
    let sig: PerpSignal | null = null, why = '';
    try { sig = await d.signal({ path: sv.path, sha256: sv.code_sha256 }, gated.data, interval); checkPerpWeights(sig, symbols, sv.meta as PerpMetaBounds); }
    catch (e) { sig = null; why = (e as Error).message.slice(0, 300); }
    const digest = inputsDigest({ interval, bar, data: gated.data });
    [row] = await sql<{ id: string; status: string; weights: Record<string, number> | null; strategy_sha256: string }[]>`insert into agent_signals (agent_id, bar, mode, kind, config_version, strategy_sha256, inputs_digest, status, reason, decision, reason_code, weights)
      values (${a.id}, ${new Date(bar)}, ${mode}, 'perp', ${cfg}, ${sv.code_sha256}, ${digest}, ${sig ? 'decided' : 'hold'}, ${why}, ${sig ? 'pending' : 'skipped'}, ${sig ? null : 'no_valid_signal'}, ${sig ? sql.json(sig.weights as never) : null})
      on conflict (agent_id, mode, bar) do update set updated_at = now() returning id, status, weights, strategy_sha256`;
    if (!sig) await log(a, 'hold', 'No valid signal: holding', why);
  }
  book.hold = null;
  ex.signalId = String(row!.id); ex.strategySha256 = sv.code_sha256; ex.bar = bar;
  if (row!.status === 'hold') { await saveBook(a, book); await complete(); return 'hold: no valid signal'; }
  if (row!.status === 'done') { await saveBook(a, book); await complete(); return 'waiting for the next bar'; }
  if (row!.strategy_sha256 !== sv.code_sha256) { await saveBook(a, book); await complete(); return 'hold: this bar was decided by another strategy version'; }
  const weights = checkPerpWeights({ weights: row!.weights, maxLeverage: sv.meta.max_leverage, maxGrossExposure: sv.meta.max_gross_exposure }, symbols, sv.meta as PerpMetaBounds);

  // 5 — targets and orders, from the account as it stands now
  try { for (const s of symbols) await market(s); liveMarks = true; }
  catch (e) { book.hold = { ts: now, reason: `no live market for the orders: ${(e as Error).message.slice(0, 160)}` }; await saveBook(a, book); return `hold: ${book.hold.reason.slice(0, 120)}`; }  // the bar stays open: retried on the next pass
  void liveMarks;
  const eq = equityOf(acct.state, positions);
  const { scaled, factor, binding } = scalePerpWeights(weights, eq, capital, a.risk);
  const targets: Record<string, Dec> = {}, current: Record<string, Dec> = {}, minNotional: Record<string, Dec | null> = {};
  for (const s of symbols) {
    const m = markets.get(s)!;
    targets[s] = targetSize(scaled[s]!, eq, marks[s]!, D.from(m.inst.lotSize));
    minNotional[s] = m.inst.minNotional === null ? null : D.from(m.inst.minNotional);
    const p = positions.find((x) => x.instrument === m.inst.id);
    current[s] = p ? signed(p) : D.zero;
  }
  const threshold = D.div(D.mul(eq, numDec(a.risk.minTradePct, 4)), HUNDRED, 8, 'up');
  const plan = planPerpOrders(targets, current, marks, minNotional, threshold);
  const results: Record<string, unknown>[] = [], closed = new Set<string>();
  let placed = 0, deferred = 0;
  for (const o of plan) {
    const base = { symbol: o.symbol, side: o.side, size: o.size, reduceOnly: o.reduceOnly, reason: o.reason };
    if (o.afterClose && !closed.has(o.symbol)) { results.push({ ...base, status: 'skipped', why: 'the closing order was not completely filled' }); continue; }
    const m = markets.get(o.symbol)!, clientId = orderClientId(a.id, sv.code_sha256, bar, o.symbol, o.phase);
    const r = await ex.place(request(m, o.side, o.size, o.reduceOnly, a.risk.slippageBps, clientId), leverageFor(a, m.inst));   // throws = not attempted: the bar stays open
    if (r.status === 'refused') { results.push({ ...base, status: 'refused', code: r.code, why: r.reason, clientId }); continue; }
    if (r.status === 'deferred') { deferred += 1; results.push({ ...base, status: 'deferred', code: r.code, why: r.reason, clientId }); continue; }
    if (!live || !r.idempotent) placed += 1;
    if (o.closes && r.order.status === 'filled') closed.add(o.symbol);
    results.push({ ...base, status: r.order.status, filled: r.order.filled, avgFillPrice: r.order.avgFillPrice, worstPrice: r.order.price, why: r.order.rejectReason, clientId, idempotent: r.idempotent });
  }

  // LIVE: an order the venue has not confirmed keeps the bar open, also when nothing is planned on its instrument right now
  // (the venue's positions may already show it): the bar is complete only once the venue has said what became of it
  for (const instrument of ex.unconfirmed?.() ?? []) {
    const symbol = symbolOf(instrument);
    if (!symbols.includes(symbol) || results.some((x) => x.symbol === symbol && x.status === 'deferred')) continue;
    deferred += 1; results.push({ symbol, status: 'deferred', code: 'live_unknown_pending', why: `an order on ${instrument} is still being checked on the venue` });
  }
  const sentNow = results.length;
  // LIVE: orders of this bar sent on an earlier pass and no longer planned stay in the log of the bar
  const earlier = live ? (row!.orders?.list ?? []).filter((x) => typeof x.clientId === 'string' && x.status !== 'deferred' && x.status !== 'skipped' && !results.some((y) => y.clientId === x.clientId)) : [];
  if (earlier.length) results.unshift(...earlier);
  if (deferred > 0) {
    // LIVE: something waits (the venue has not confirmed an order, or the signer still counts the last one). The bar stays
    // open: the next pass reads the decision back and plans again from the venue's real positions — same client ids, no new signal.
    await sql`update agent_signals set scaled = ${sql.json(str(scaled) as never)}, scale = ${D.str(factor)}, equity = ${D.str(eq)}, targets = ${sql.json(str(targets) as never)},
      orders = ${sql.json({ binding, threshold: D.str(threshold), slippageBps: a.risk.slippageBps, list: results } as never)}, updated_at = now() where agent_id = ${a.id} and mode = ${mode} and bar = ${new Date(bar)}`;
    await saveBook(a, book);
    if (placed) await audit('agent.perp_orders', 'engine', { agent: a.id, bar: new Date(bar).toISOString(), orders: results.length, placed, deferred, sha256: sv.code_sha256 });
    return `${placed} order(s), ${deferred} waiting for the next pass`;
  }

  // 6 — the bar is complete: signal log, equity point
  positions = await ex.positions();
  const after = await ex.account(book.lastEventId ?? 0);
  const eqAfter = equityOf(after.state, positions);
  const verdict = decisionOf(results, plan.length);
  await sql`update agent_signals set status = 'done', decision = ${verdict.decision}, reason_code = ${verdict.reasonCode}, scaled = ${sql.json(str(scaled) as never)}, scale = ${D.str(factor)}, equity = ${D.str(eq)}, targets = ${sql.json(str(targets) as never)},
    orders = ${sql.json({ binding, threshold: D.str(threshold), slippageBps: a.risk.slippageBps, list: results } as never)}, updated_at = now() where agent_id = ${a.id} and mode = ${mode} and bar = ${new Date(bar)}`;
  await sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${a.id}, ${new Date(bar)}, ${live ? 'LIVE' : 'PAPER'}, ${D.toNumber(eqAfter)}, ${sql.json(Object.fromEntries(positions.map((p) => [symbolOf(p.instrument), D.str(signed(p))])))})
    on conflict (agent_id, ts, mode) do update set equity_usd = excluded.equity_usd, positions = excluded.positions`;
  await saveBook(a, book);
  await complete();
  if (placed) await audit('agent.perp_orders', 'engine', { agent: a.id, bar: new Date(bar).toISOString(), orders: results.length, placed, sha256: sv.code_sha256 });
  return placed ? `${placed} order(s)${sentNow > placed ? `, ${sentNow - placed} not sent` : ''}` : plan.length ? `${sentNow} order(s) not sent` : 'portfolio already at target';
}

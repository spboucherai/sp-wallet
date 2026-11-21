/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/engine.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// Trading engine (V3). Deterministic and independent of any LLM: at every newly closed bar it asks the approved strategy for
// target weights, checks its own risk rules, and trades the difference — on paper, or for real through the signer's mandate.
// It cannot sign, cannot change a limit, and holds (does nothing) whenever data or signal are not trustworthy.
import { formatUnits, parseUnits } from '@spw/core';
import { audit, sql } from '../db.ts';
import { orderGateway, type AgentOrderGateway, type KillSwitchRead } from '../agent-runtime/gateway.ts';
import { decideSignal, getSignal, inputsDigest, journal, recordSignal, type ReasonCode, type SignalRow } from '../agent-runtime/journal.ts';
import { killSwitchRead } from '../agent-runtime/kill-switch.ts';
import { spotCanonical, spotClientOrderId, spotSeam } from './spot-seam.ts';
import { agentAssets, agentSymbols, cashOf, type AgentRow } from './routes.ts';

export interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
export interface Holding { symbol: string; id: string; decimals: number; units: number }
export interface EngineDeps {
  /** closed bars, oldest first */
  series(symbol: string, interval: string, limit: number): Promise<Bar[]>;
  /** throws unless the series is fresh, gap-free and consistent across sources right now */
  assertFresh(symbol: string, interval: string): Promise<void>;
  /** run the approved strategy version on these bars; throws on any problem (timeout, wrong hash, invalid output) */
  signal(strategy: { path: string; sha256: string }, data: Record<string, Bar[]>): Promise<Record<string, number>>;
  /** holdings of the agent: the real vault in LIVE mode, the paper book otherwise */
  holdings(a: AgentRow, mode: 'PAPER' | 'LIVE'): Promise<Holding[]>;
  /** expected output of a swap right now (base units), from the same provider used for execution */
  quote(a: AgentRow, fromId: string, toId: string, amountIn: bigint): Promise<bigint>;
  /** LIVE only: prepare, obtain the delegated signature and record the order; returns once the order is in flight */
  placeLive(a: AgentRow, o: PlannedOrder, bar: number, ref?: OrderRef): Promise<void>;
  /** V11: the order gateway of this agent's tick (default: the bound factory over the spot seam) and the kill switch it reads — tests inject their own */
  gateway?(a: AgentRow, mode: 'PAPER' | 'LIVE', bar: number): AgentOrderGateway;
  killSwitch?: KillSwitchRead;
  /** is a live order of this agent still unsettled? */
  inFlight(a: AgentRow): Promise<boolean>;
  halted(): Promise<boolean>;
  /** V11 (D2): revoke the agent's mandate AT THE SIGNER when the engine stops it — a stopped agent must not leave a mandate that still signs. Never throws. */
  revokeMandate?(a: AgentRow, reason: string): Promise<void>;
  now(): number;
}
/** what an order row records about where it came from (V11) */
export interface OrderRef { clientOrderId: string; signalId: string | null; configVersion: number | null; strategySha256: string | null }
export interface PlannedOrder { fromSymbol: string; toSymbol: string; fromId: string; toId: string; fromDecimals: number; toDecimals: number; amountIn: bigint; usd: number; reason: string }

const LOOKBACK = 2500, MIN_TRADE_USD = 2, MIN_TRADE_FRACTION = 0.02;
/** paper orders per bar: enough to sell and buy every symbol once (an agent trades up to 12 symbols) */
const maxOrdersPerBar = (symbols: number) => Math.max(6, 2 * symbols);
/** journal line of the engine, tagged with the mode the agent trades in (V11: no mode-less line) */
const log = (a: AgentRow, kind: 'hold' | 'stop' | 'risk' | 'decision', title: string, body = '', data?: unknown, code?: string) =>
  journal(a.id, { mode: a.state === 'LIVE' || a.mode === 'LIVE' ? 'LIVE' : 'PAPER', kind, title, body, ...(data === undefined ? {} : { data }), code: code ?? null, severity: kind === 'stop' || kind === 'risk' ? 'warning' : 'info', configVersion: a.config_version ?? null });
const NOTE_CODE: Record<string, ReasonCode> = { 'portfolio already at target': 'at_target', 'daily order count reached': 'risk_limit', 'daily volume limit reached': 'risk_limit', 'order too small': 'below_threshold', 'the agent wallet holds nothing to trade': 'below_threshold' };

/** Validate a strategy's answer: only universe symbols, each weight in [0, 1], total at most 1. Anything else means "hold". */
export function checkWeights(w: unknown, universe: string[], cash = 'USDC'): Record<string, number> {
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error('weights are not an object');
  const out: Record<string, number> = {}; let sum = 0;
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
    if (k === cash) continue;
    if (!universe.includes(k)) throw new Error(`weight for ${k}, which is outside the agent's universe`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`weight for ${k} is not in [0, 1]`);
    out[k] = v; sum += v;
  }
  if (sum > 1 + 1e-9) throw new Error('weights sum to more than 1');
  for (const s of universe) if (s !== cash && out[s] === undefined) out[s] = 0;
  return out;
}

/** Turn target weights into at most one order: sells first (largest), then buys (largest). Pure. */
export function planOrder(a: AgentRow, weights: Record<string, number>, holdings: Holding[], prices: Record<string, number>, spentTodayUsd: number, ordersToday: number): { order: PlannedOrder | null; equity: number; note: string } {
  const cash = cashOf(a), usdc = holdings.find((h) => h.symbol === cash); // the cash leg: USDC, or USDT when the owner chose it
  const value = (h: Holding) => (h.symbol === cash ? h.units : h.units * (prices[h.symbol] ?? 0));
  // the native coin held for gas is not part of the strategy's equity unless it is in the universe
  const tradable = holdings.filter((h) => h.symbol === cash || a.universe.includes(h.symbol));
  const equity = tradable.reduce((s, h) => s + value(h), 0);
  if (!usdc || !(equity > 0)) return { order: null, equity, note: 'the agent wallet holds nothing to trade' };
  // exposure cap: scale all weights down together if they exceed it
  const cap = a.risk.maxExposurePct / 100, total = Object.values(weights).reduce((s, v) => s + v, 0), scale = total > cap ? cap / total : 1;
  const threshold = Math.max(MIN_TRADE_USD, equity * MIN_TRADE_FRACTION);
  const deltas = a.universe.filter((s) => s !== cash).map((s) => { const h = tradable.find((x) => x.symbol === s)!; return { h, delta: (weights[s] ?? 0) * scale * equity - value(h) }; }).filter((d) => d.h && Math.abs(d.delta) >= threshold);
  if (!deltas.length) return { order: null, equity, note: 'portfolio already at target' };
  if (ordersToday >= a.risk.maxOrdersPerDay) return { order: null, equity, note: 'daily order count reached' };
  const room = a.risk.maxDailyUsd - spentTodayUsd;
  if (room < MIN_TRADE_USD) return { order: null, equity, note: 'daily volume limit reached' };
  const sells = deltas.filter((d) => d.delta < 0).sort((x, y) => x.delta - y.delta), buys = deltas.filter((d) => d.delta > 0).sort((x, y) => y.delta - x.delta);
  const pick = sells[0] ?? buys[0]!;
  let usd = Math.min(Math.abs(pick.delta), a.risk.maxOrderUsd, room);
  const price = prices[pick.h.symbol];
  if (!price || !(price > 0)) return { order: null, equity, note: `no price for ${pick.h.symbol}` };
  if (pick.delta < 0) { // sell the asset for cash
    const units = Math.min(pick.h.units, usd / price);
    const amountIn = parseUnits(units.toFixed(Math.min(pick.h.decimals, 10)), pick.h.decimals);
    if (amountIn <= 0n) return { order: null, equity, note: 'order too small' };
    return { equity, note: '', order: { fromSymbol: pick.h.symbol, toSymbol: cash, fromId: pick.h.id, toId: usdc.id, fromDecimals: pick.h.decimals, toDecimals: usdc.decimals, amountIn, usd: units * price, reason: `target ${(100 * (weights[pick.h.symbol] ?? 0) * scale).toFixed(1)} %` } };
  }
  usd = Math.min(usd, usdc.units); // buy with the cash actually held
  if (usd < MIN_TRADE_USD) return { order: null, equity, note: `not enough ${cash} to buy` };
  return { equity, note: '', order: { fromSymbol: cash, toSymbol: pick.h.symbol, fromId: usdc.id, toId: pick.h.id, fromDecimals: usdc.decimals, toDecimals: pick.h.decimals, amountIn: parseUnits(usd.toFixed(Math.min(6, usdc.decimals)), usdc.decimals), usd, reason: `target ${(100 * (weights[pick.h.symbol] ?? 0) * scale).toFixed(1)} %` } };
}

async function usage(a: AgentRow, mode: string, now: number): Promise<{ usd: number; orders: number }> {
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = await sql<{ usd: number; n: number }[]>`select coalesce(sum((aux->>'usd')::float), 0)::float as usd, count(*)::int as n from agent_orders where agent_id = ${a.id} and mode = ${mode} and ts >= ${day}::date and state <> 'skipped' and state <> 'failed'`;
  return { usd: rows[0]?.usd ?? 0, orders: rows[0]?.n ?? 0 };
}

/** One engine step for one agent. Safe to call as often as wanted: it acts at most once per closed bar and per in-flight order. */
export async function tickAgent(a: AgentRow, d: EngineDeps): Promise<string> {
  if (a.state !== 'PAPER_TRADING' && a.state !== 'LIVE') return 'idle';
  if (a.kind === 'perp') return 'idle'; // v6: a perp agent is never traded by the spot engine
  const mode = a.state === 'LIVE' ? 'LIVE' : 'PAPER';
  if (mode === 'LIVE' && (await d.halted())) return 'halted';
  if (mode === 'LIVE' && (await d.inFlight(a))) return 'order in flight';
  if (!a.strategy_version_id) return 'no strategy';
  const [sv] = await sql<{ path: string; code_sha256: string; status: string }[]>`select path, code_sha256, status from strategy_versions where id = ${a.strategy_version_id}`;
  if (!sv || sv.status !== 'approved') return 'strategy not approved';
  // LIVE runs only the exact code the mandate was approved for
  if (mode === 'LIVE' && a.mandate?.strategySha256 !== sv.code_sha256) { await stop(a, 'the approved strategy no longer matches the mandate', d); return 'stopped'; }
  const cash = cashOf(a), symbols = agentSymbols(a);
  const data: Record<string, Bar[]> = {};
  try { for (const s of symbols) { await d.assertFresh(s, a.interval); data[s] = await d.series(s, a.interval, LOOKBACK); if (data[s]!.length < 50) throw new Error(`not enough history for ${s}`); } }
  catch (e) { return `hold: ${(e as Error).message.slice(0, 120)}`; } // stale or inconsistent data: never trade on it
  const bar = Math.min(...symbols.map((s) => data[s]![data[s]!.length - 1]!.ts));
  const done = a.last_bar && a.last_bar.getTime() >= bar;
  const prices = Object.fromEntries(symbols.map((s) => [s, data[s]![data[s]!.length - 1]!.close]));
  const holdings = await d.holdings(a, mode);
  const capital = Number(formatUnits(BigInt(a.capital_usdc), 6));

  // loss limit: monitored here on every tick; a gap can carry the loss past it before this runs
  const eqNow = holdings.filter((h) => h.symbol === cash || a.universe.includes(h.symbol)).reduce((s, h) => s + (h.symbol === cash ? h.units : h.units * (prices[h.symbol] ?? 0)), 0);
  const breached = capital > 0 && eqNow > 0 && eqNow < capital * (1 - a.risk.maxLossPct / 100);
  let weights: Record<string, number>, signal: SignalRow | null = null;
  if (breached) weights = Object.fromEntries(symbols.map((s) => [s, 0])); // liquidate to USDC, then stop
  else {
    if (done) return 'waiting for the next bar';
    // V11 (D8): the signal is stored BEFORE anything is done with it, with the mode, the configuration version, the code hash and a
    // digest of its inputs. A restart in the middle of a bar reads the decision back instead of asking the strategy again.
    signal = await getSignal(a.id, mode, bar);
    if (signal && signal.strategy_sha256 !== sv.code_sha256) { await sql`update agents set last_bar = ${new Date(bar)}, updated_at = now() where id = ${a.id}`; return 'hold: this bar was decided by another strategy version'; }
    if (!signal) {
      const digest = inputsDigest({ interval: a.interval, bar, data: Object.fromEntries(symbols.map((s) => [s, data[s]!.map((b) => [b.ts, b.open, b.high, b.low, b.close, b.volume])])) });
      let out: Record<string, number> | null = null, why = '';
      try { out = checkWeights(await d.signal({ path: sv.path, sha256: sv.code_sha256 }, data), symbols, cash); } catch (e) { why = (e as Error).message.slice(0, 300); }
      signal = await recordSignal({ agentId: a.id, mode, kind: 'spot', bar, configVersion: a.config_version ?? 1, strategySha256: sv.code_sha256, inputsDigest: digest, output: out, status: out ? 'decided' : 'hold', reason: why });
      if (!out) await log(a, 'hold', 'No valid signal: holding', why, undefined, 'no_valid_signal');
    }
    if (signal.status === 'hold' || !signal.weights) { await sql`update agents set last_bar = ${new Date(bar)}, updated_at = now() where id = ${a.id}`; return 'hold: no valid signal'; }
    weights = checkWeights(signal.weights, symbols, cash);
  }
  // V11: every order goes through the order gateway (kill switch, mode, mandate presence, the agent's limits), then the existing seam
  const seam = spotSeam(a, d, mode, bar);
  const gw = d.gateway?.(a, mode, bar) ?? orderGateway({ agent: a, seam, authorityId: mode === 'LIVE' ? a.mandate_id : a.id, killSwitch: d.killSwitch ?? killSwitchRead, now: d.now });
  if (mode === 'LIVE') await gw.reconcile?.().catch(() => []);
  const [{ n: seqBase } = { n: 0 }] = await sql<{ n: number }[]>`select count(*)::int as n from agent_orders where agent_id = ${a.id} and mode = ${mode} and bar = ${new Date(bar)}`;
  const ctx = { signalId: signal?.id ?? null, configVersion: a.config_version ?? 1, strategySha256: sv.code_sha256, bar };
  let placed = 0, note = '', refused: ReasonCode | null = null;
  for (let k = 0; k < (mode === 'LIVE' ? 1 : maxOrdersPerBar(symbols.length)); k++) {
    const u = await usage(a, mode, d.now());
    const plan = planOrder(a, weights, k === 0 ? holdings : await d.holdings(a, mode), prices, u.usd, u.orders);
    note = plan.note;
    if (!plan.order) break;
    const o = plan.order;
    const clientOrderId = spotClientOrderId(a.id, mode, bar, seqBase + k);
    seam.plan(clientOrderId, o);
    const rec = await gw.submit({ kind: 'agent', id: a.id }, spotCanonical(a, o, mode, clientOrderId, (mode === 'LIVE' ? a.mandate_id : a.id) ?? a.id, d.now()), { idempotencyKey: clientOrderId, context: { ...ctx, reason: o.reason } });
    if (mode === 'LIVE') {
      // a refusal (signer, mandate, kill switch) or a failure to prepare: the pass ends with the reason, as before (the engine loop backs off)
      if (rec.state === 'REJECTED' || rec.state === 'FAILED') throw new Error(rec.detail ?? rec.reason);
      placed += 1; break;
    }
    if (rec.state === 'FAILED') { await log(a, 'hold', 'No executable quote: order skipped', rec.detail ?? '', undefined, 'no_quote'); note = 'no executable quote'; break; }
    if (rec.state !== 'FILLED') { note = `order ${rec.state.toLowerCase()}: ${rec.detail ?? rec.reason}`; refused = rec.reason === 'KILL_SWITCH_ACTIVE' ? 'kill_switch' : 'orders_refused'; break; }
    placed += 1;
  }
  // the bar is complete when nothing more is to be done for it (in LIVE the next tick continues after the order settles)
  if (mode === 'PAPER' || placed === 0) {
    await sql`update agents set last_bar = ${new Date(bar)}, updated_at = now() where id = ${a.id}`;
    const h2 = await d.holdings(a, mode);
    const eq = h2.filter((h) => h.symbol === cash || a.universe.includes(h.symbol)).reduce((s, h) => s + (h.symbol === cash ? h.units : h.units * (prices[h.symbol] ?? 0)), 0);
    await sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${a.id}, ${new Date(bar)}, ${mode}, ${eq}, ${sql.json(Object.fromEntries(h2.map((h) => [h.symbol, h.units])))}) on conflict do nothing`;
    if (signal) await decideSignal(signal.id, placed ? { decision: 'acted', reasonCode: 'acted', equity: eq } : { decision: 'skipped', reasonCode: refused ?? NOTE_CODE[note] ?? (note === 'no executable quote' ? 'no_quote' : 'below_threshold'), reason: note, equity: eq });
    if (breached) { await stop(a, `loss limit reached: equity ${eqNow.toFixed(2)} USD against ${capital.toFixed(2)} USD allocated (limit ${a.risk.maxLossPct} %); positions were sold to ${cash}`, d); return 'stopped: loss limit'; }
  }
  return placed ? `${placed} order(s)` : note || 'no order';
}

async function stop(a: AgentRow, reason: string, d?: EngineDeps): Promise<void> {
  await sql`update agents set state = 'STOPPED', stop_reason = ${reason}, updated_at = now() where id = ${a.id}`;
  // V11 (D2): the engine's stop is not enough — the signer would go on signing for this vault if asked. The mandate is revoked there.
  if (a.mode === 'LIVE' && a.mandate_id && d?.revokeMandate) await d.revokeMandate(a, reason);
  await log(a, 'stop', 'Agent stopped', reason, undefined, 'agent_stopped');
  await audit('agent.stopped', 'engine', { id: a.id, reason });
}

/** The paper book: starts as the allocated capital in the cash leg. Keyed by market symbol (the cash symbol for cash). */
export async function paperHoldings(a: AgentRow): Promise<Holding[]> {
  const assets = agentAssets(a), cash = cashOf(a), capital = Number(formatUnits(BigInt(a.capital_usdc), 6));
  let rows: { symbol: string; units: number }[] = await sql<{ symbol: string; units: number }[]>`select symbol, units from agent_paper where agent_id = ${a.id}`;
  if (!rows.length) { await sql`insert into agent_paper (agent_id, symbol, units) values (${a.id}, ${cash}, ${capital}) on conflict do nothing`; rows = [{ symbol: cash, units: capital }]; }
  return assets.map((x) => ({ symbol: x.symbol, id: x.id, decimals: x.decimals, units: Math.max(0, rows.find((r) => r.symbol === x.symbol)?.units ?? 0) }));
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/paper.ts
 * Module           : derivatives
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

// Paper trading accounts (service). The simulated account itself is the paper engine of @spw/derivatives; this file stores it,
// feeds it live venue data, runs the risk engine in front of it and mirrors what happens into queryable tables.
//
// Storage: `deriv_paper_accounts.state` is the engine's serialised state (the truth of the account), `policy` the risk policy,
// `meta` the service's own bookkeeping (funding cursors, margin-warning flag, last equity minute). Orders, fills, funding
// payments, risk events and equity snapshots are copied to their tables in the SAME transaction as the state, under a row lock
// on the account, so a fill or a funding payment exists exactly once whatever is retried or restarted.
//
// Nothing here signs, calls the signer or talks to a venue's trading endpoint: the only venue calls are public reads through
// `DerivData`.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import {
  checkOrder, D, DecStrSchema, hlFormatPrice, hlQuantizePrice, initialMargin, freeCollateralAfterOrder, OrderSideSchema, OrderTypeSchema, PaperAccount, RiskPolicySchema, TifSchema,
  type AccountState, type Book, type Dec, type DecStr, type Fill, type FundingPayment, type Instrument, type Order, type OrderRequest, type PaperResult, type PaperState,
  type Position, type RiskPolicy, type RiskResult, type RiskUsage, type Ticker, type VenueId,
} from '@spw/derivatives';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import type { DerivData } from './data.ts';
import type { PreTradeGate } from './gate.ts';

type Tx = TransactionSql;
const BPS = D.from(10000n);

/** default slippage bound of `close` and of a market order sent without a price, in basis points from the best opposite price */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;
/** an order is checked and filled on a ticker and a book read at most one second ago, never on an older cached value */
const LIVE = { within: 1_000 };
export const MAX_PAPER_ACCOUNTS = 20;
/** flat maintenance margin fraction of a Hyperliquid paper account (the engine has one fraction per account): ETH's 2 %, cautious for BTC (1.25 %) */
export const PAPER_MAINTENANCE_FRACTION = '0.02';
/** margin warning: maintenance margin ≥ 80 % of equity */
export const MARGIN_WARNING_RATIO = '0.8';
/** a funding time whose rate the venue has still not published after this long is skipped, with a risk event */
export const FUNDING_GRACE_MS = 15 * 60_000;
/** closed orders, fills and funding payments kept inside the engine state (the tables keep everything) */
const KEEP = { closedOrders: 200, fills: 500, funding: 500 };

export interface Meta { fundingCursor: Record<string, number>; marginWarning: boolean; lastEquityMinute: number }
interface AccountRow { id: string; venue: VenueId; network: string; label: string; initial_collateral: string; state: PaperState; policy: RiskPolicy; meta: Partial<Meta>; created_at: Date; updated_at: Date }
interface RiskEvent { kind: string; code: string | null; message: string; data: Record<string, unknown>; dedupe: string | null; ts: number }
interface Loaded { row: AccountRow; acct: PaperAccount; policy: RiskPolicy; meta: Meta; events: RiskEvent[]; audits: { type: string; actor: string; data: Record<string, unknown> }[] }
export interface MarketFeed { inst: Instrument; ticker: Ticker; book: Book | null; fundingRates: Map<number, DecStr> | null }

const PosDec = DecStrSchema.refine((x) => !x.startsWith('-') && /[1-9]/.test(x), 'must be positive');
/** a refinement on the decimal value; false (never a throw) when the string is not a decimal at all */
const dec = (test: (x: Dec) => boolean) => (x: string): boolean => D.isValid(x) && test(D.from(x));
export const OrderBodySchema = z.strictObject({
  instrument: z.string().min(3).max(120), side: OrderSideSchema, type: OrderTypeSchema, size: PosDec,
  price: PosDec.nullable().default(null), triggerPrice: PosDec.nullable().default(null),
  reduceOnly: z.boolean().default(false), tif: TifSchema.default('gtc'),
  /** leverage setting of this instrument on the account (initial margin = notional / leverage) */
  leverage: PosDec.optional(),
  /** market orders only: when `price` is null the worst acceptable price is derived from the book with this bound */
  slippageBps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS).optional(),
});
export type OrderBody = z.infer<typeof OrderBodySchema>;
export const CloseBodySchema = z.strictObject({
  instrument: z.string().min(3).max(120),
  fraction: PosDec.refine(dec((x) => D.lte(x, D.one)), 'fraction must be in (0, 1]'),
  slippageBps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS).optional(),
});
export const CreateBodySchema = z.strictObject({
  venue: z.string().min(1).max(40), label: z.string().trim().min(1).max(60),
  collateral: PosDec.refine(dec((x) => D.gte(x, D.from(10n)) && D.lte(x, D.from(1_000_000_000n))), 'collateral must be between 10 and 1000000000'),
  policy: RiskPolicySchema.partial().strict().optional(),
});

export interface OrderEstimate {
  notional: DecStr; initialMargin: DecStr; fee: DecStr; avgFillPrice: DecStr | null; slippageBps: DecStr | null;
  liquidationPrice: { value: DecStr | null; source: 'estimate'; method: string } | null; freeCollateralAfter: DecStr;
  filledSize: DecStr; restingSize: DecStr; status: Order['status']; rejectReason: string | null; leverage: DecStr; price: DecStr | null; source: 'estimate';
}

/** conservative, explicit default: every limit is stated and proportional to the collateral; the owner can replace it */
export function defaultPolicy(venue: VenueId, collateral: DecStr): RiskPolicy {
  const c = D.from(collateral), times = (k: string): DecStr => D.str(D.mul(c, D.from(k)));
  return {
    mode: 'PAPER', allowedInstruments: [`${venue}:BTC`, `${venue}:ETH`], halt: null,
    maxDataAgeMs: 10_000, maxDeviationBps: '200', maxMarkIndexBps: '100', maxLeverage: '3',
    maxOrderNotional: times('1'), maxGrossExposure: times('3'), maxPositionNotional: times('2'),
    minFreeCollateral: times('0.1'), minLiquidationDistanceBps: '1000',
    maxDailyLoss: times('0.05'), maxTotalLoss: times('0.2'), maxOrdersPerMinute: 10, maxOrdersPerDay: 200,
  };
}

function assertPaperPolicy(p: RiskPolicy): RiskPolicy {
  if (p.mode !== 'PAPER' && p.mode !== 'READ_ONLY') throw new UserError('live_not_available', 'a paper account can only be PAPER or READ_ONLY: live trading does not exist in this delivery', 422);
  return p;
}

const canon = (x: string): DecStr => D.str(D.from(x));
const canonN = (x: string | null): DecStr | null => (x === null ? null : canon(x));
const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
const isOpen = (o: Order): boolean => o.status === 'pending' || o.status === 'triggered' || o.status === 'open' || o.status === 'partially_filled';
const decimalsOf = (step: DecStr): number => { const i = step.indexOf('.'); return i < 0 ? 0 : step.length - i - 1; };

/** venue price rules beyond the instrument's finest tick (Hyperliquid: 5 significant figures) */
function priceRules(inst: Instrument): { check: (price: DecStr) => string | null; quantize: (price: Dec, mode: 'down' | 'up') => DecStr } {
  if (inst.venue === 'hyperliquid') {
    const sz = decimalsOf(inst.lotSize);
    return {
      check: (p) => { const r = hlFormatPrice(canon(p), sz); return r.ok ? null : r.reason; },
      quantize: (p, mode) => {
        // the venue's grid needs at most 6 − szDecimals decimals: cut there first, then onto the grid at that price
        const pre = D.str(D.quantize(p, D.from(inst.tickSize), mode));
        return hlQuantizePrice(pre, sz, mode);
      },
    };
  }
  return { check: () => null, quantize: (p, mode) => D.str(D.quantize(p, D.from(inst.tickSize), mode)) };
}

/** worst acceptable price of a taker order: the best opposite price moved by `bps`, onto the venue's price grid on the cautious side */
export function worstPrice(inst: Instrument, book: Book, side: 'buy' | 'sell', bps: number): DecStr {
  const best = side === 'buy' ? book.asks[0] : book.bids[0];
  if (!best) throw new UserError('no_liquidity', `the ${inst.venue} book of ${inst.symbol} has no ${side === 'buy' ? 'ask' : 'bid'}: no price to derive`, 503);
  const k = D.from(BigInt(bps)), px = D.from(best[0]);
  const raw = side === 'buy' ? D.div(D.mul(px, D.add(BPS, k)), BPS, 18, 'down') : D.div(D.mul(px, D.sub(BPS, k)), BPS, 18, 'up');
  // rounding stays inside the bound: a buy never pays above it, a sell never accepts below it
  const q = priceRules(inst).quantize(raw, side === 'buy' ? 'down' : 'up');
  if (!D.isPos(D.from(q))) throw new UserError('no_liquidity', 'no positive price can be derived from the book', 503);
  return q;
}

/** V11: the same bound from a given reference price (the trigger of a stop / take-profit market order) instead of the best opposite price */
export function boundPrice(inst: Instrument, reference: DecStr, side: 'buy' | 'sell', bps: number): DecStr {
  const k = D.from(BigInt(bps)), px = D.from(reference);
  const raw = side === 'buy' ? D.div(D.mul(px, D.add(BPS, k)), BPS, 18, 'down') : D.div(D.mul(px, D.sub(BPS, k)), BPS, 18, 'up');
  const q = priceRules(inst).quantize(raw, side === 'buy' ? 'down' : 'up');
  if (!D.isPos(D.from(q))) throw new UserError('no_liquidity', 'no positive price can be derived from the reference', 503);
  return q;
}

function compact(state: PaperState): void {
  const closed = state.orders.filter((o) => !isOpen(o));
  if (closed.length > KEEP.closedOrders) {
    const drop = new Set(closed.slice(0, closed.length - KEEP.closedOrders).map((o) => o.venueOrderId));
    state.orders = state.orders.filter((o) => !drop.has(o.venueOrderId));
  }
  if (state.fills.length > KEEP.fills) state.fills = state.fills.slice(-KEEP.fills);
  if (state.funding.length > KEEP.funding) state.funding = state.funding.slice(-KEEP.funding);
}

export class PaperService {
  readonly data: DerivData;
  readonly now: () => number;
  /** V11: the unified risk gate (derivatives/gate.ts), set by the server; null = the account's own policy alone judges */
  preTrade: PreTradeGate | null = null;
  constructor(data: DerivData, now: () => number = Date.now) { this.data = data; this.now = now; }

  // ------------------------------------------------------------------ storage

  private load(row: AccountRow): Loaded {
    return { row, acct: PaperAccount.restore(row.state), policy: RiskPolicySchema.parse(row.policy),
      meta: { fundingCursor: { ...(row.meta.fundingCursor ?? {}) }, marginWarning: row.meta.marginWarning === true, lastEquityMinute: row.meta.lastEquityMinute ?? 0 }, events: [], audits: [] };
  }

  /** one transaction, the account row locked: load, run `fn`, write back whatever changed, then (after commit) the audit events */
  private async mutate<T>(id: string, fn: (l: Loaded, tx: Tx) => Promise<T>): Promise<T> {
    let audits: Loaded['audits'] = [];
    const out = await sql.begin(async (tx) => {
      const [row] = await tx<AccountRow[]>`select * from deriv_paper_accounts where id = ${id} for update`;
      if (!row) throw new UserError('unknown_account', 'unknown derivatives account', 404);
      const l = this.load(row);
      const result = await fn(l, tx);
      compact(l.acct.state);
      const state = JSON.parse(l.acct.serialize()) as PaperState;
      if (!isDeepStrictEqual(state, row.state) || !isDeepStrictEqual(l.policy, row.policy) || !isDeepStrictEqual(l.meta, row.meta)) {
        await tx`update deriv_paper_accounts set state = ${tx.json(state as never)}, policy = ${tx.json(l.policy as never)}, meta = ${tx.json(l.meta as never)}, updated_at = ${new Date(this.now())} where id = ${id}`;
      }
      for (const e of l.events) {
        await tx`insert into deriv_risk_events (account_id, ts, kind, code, message, data, dedupe) values (${id}, ${new Date(e.ts)}, ${e.kind}, ${e.code}, ${e.message}, ${tx.json(e.data as never)}, ${e.dedupe})
          on conflict (account_id, dedupe) do nothing`;
      }
      audits = l.audits;
      return result;
    }) as T;
    for (const a of audits) await audit(a.type, a.actor, a.data).catch((e: Error) => console.error(`[derivatives] audit ${a.type} failed: ${e.message}`));
    return out;
  }

  /** copies what an engine call produced into the tables (idempotent: fills and funding are keyed by their engine ids) */
  private async record(tx: Tx, l: Loaded, res: PaperResult, origin: 'owner' | 'worker'): Promise<void> {
    const id = l.row.id, orders = new Map<string, Order>();
    for (const o of res.orders) orders.set(o.clientId, o);
    if (res.order) orders.set(res.order.clientId, res.order);
    for (const o of orders.values()) {
      await tx`insert into deriv_orders (account_id, client_id, venue_order_id, instrument, side, type, size, price, trigger_price, reduce_only, tif, status, filled, avg_fill_price, reject_reason, origin, created_at, updated_at)
        values (${id}, ${o.clientId}, ${o.venueOrderId}, ${o.instrument}, ${o.side}, ${o.type}, ${o.size}, ${o.price}, ${o.triggerPrice}, ${o.reduceOnly}, ${o.tif}, ${o.status}, ${o.filled}, ${o.avgFillPrice},
          ${o.rejectReason}, ${origin}, ${new Date(o.createdAt)}, ${new Date(o.updatedAt)})
        on conflict (account_id, client_id) do update set status = excluded.status, filled = excluded.filled, avg_fill_price = excluded.avg_fill_price, reject_reason = excluded.reject_reason, updated_at = excluded.updated_at`;
    }
    for (const f of res.fills) {
      await tx`insert into deriv_fills (account_id, fill_id, instrument, order_id, client_id, side, price, size, fee, fee_asset, closed_pnl, liquidation, ts)
        values (${id}, ${f.id}, ${f.instrument}, ${f.orderId}, ${f.clientId}, ${f.side}, ${f.price}, ${f.size}, ${f.fee}, ${f.feeAsset}, ${f.closedPnl}, ${f.liquidation}, ${new Date(f.ts)})
        on conflict (account_id, fill_id) do nothing`;
    }
    for (const p of res.funding) {
      await tx`insert into deriv_funding (account_id, instrument, ts, amount, rate, size) values (${id}, ${p.instrument}, ${new Date(p.ts)}, ${p.amount}, ${p.rate}, ${p.size})
        on conflict (account_id, instrument, ts) do nothing`;
    }
    if (res.liquidated) {
      const fills = res.fills.filter((f) => f.liquidation), ts = fills[0]?.ts ?? this.now();
      const message = `simulated liquidation: equity fell below the maintenance margin; ${fills.length} position(s) closed at the mark, open orders cancelled`;
      l.events.push({ kind: 'liquidation', code: 'liquidated', message, ts, dedupe: `liquidation:${l.acct.state.liquidations}:${ts}`,
        data: { fills: fills.map((f) => ({ id: f.id, instrument: f.instrument, side: f.side, size: f.size, price: f.price, closedPnl: f.closedPnl })), collateralAfter: l.acct.state.collateral } });
      l.audits.push({ type: 'deriv.paper.liquidation', actor: 'paper-engine', data: { account: id, positions: fills.length, collateralAfter: l.acct.state.collateral } });
    }
  }

  private async usage(tx: Tx, id: string, acct: PaperAccount, now: number): Promise<RiskUsage> {
    const day = new Date(dayStart(now));
    const [f] = await tx<{ pnl: string }[]>`select coalesce(sum(coalesce(closed_pnl, 0) - fee), 0)::text as pnl from deriv_fills where account_id = ${id} and ts >= ${day}`;
    const [g] = await tx<{ amount: string }[]>`select coalesce(sum(amount), 0)::text as amount from deriv_funding where account_id = ${id} and ts >= ${day}`;
    const [c] = await tx<{ minute: number; today: number }[]>`select count(*) filter (where created_at > ${new Date(now - 60_000)})::int as minute, count(*) filter (where created_at >= ${day})::int as today
      from deriv_orders where account_id = ${id}`;
    const s = acct.state;
    return {
      realizedToday: D.str(D.add(D.from(f!.pnl), D.from(g!.amount))),
      realizedTotal: D.str(D.add(D.sub(D.from(s.realizedPnl), D.from(s.feesPaid)), D.from(s.fundingNet))),
      ordersLastMinute: c!.minute, ordersToday: c!.today, clientIds: [],
    };
  }

  /** funding cursors follow the positions: a new position owes nothing for the funding time already passed; a closed one owes nothing more */
  private syncCursors(l: Loaded, before: Set<string>, intervals: Map<string, number>, now: number): void {
    const after = new Set(l.acct.state.positions.map((p) => p.instrument));
    for (const k of Object.keys(l.meta.fundingCursor)) if (!after.has(k)) delete l.meta.fundingCursor[k];
    for (const k of after) {
      if (before.has(k) && l.meta.fundingCursor[k] !== undefined) continue;
      const iv = (intervals.get(k) ?? 3600) * 1000;
      l.meta.fundingCursor[k] = Math.floor(now / iv) * iv;
    }
  }

  private async snapshotEquity(tx: Tx, l: Loaded, now: number): Promise<void> {
    const minute = Math.floor(now / 60_000) * 60_000, a = l.acct.accountState(now);
    const unrealized = D.str(D.sub(D.from(a.equity), D.from(a.collateral)));
    await tx`insert into deriv_equity (account_id, ts, equity, collateral, margin_used, unrealized_pnl) values (${l.row.id}, ${new Date(minute)}, ${a.equity}, ${a.collateral}, ${a.marginUsed}, ${unrealized})
      on conflict (account_id, ts) do update set equity = excluded.equity, collateral = excluded.collateral, margin_used = excluded.margin_used, unrealized_pnl = excluded.unrealized_pnl`;
    l.meta.lastEquityMinute = minute;
  }

  // ------------------------------------------------------------------ views

  private view(row: AccountRow, acct: PaperAccount, policy: RiskPolicy) {
    const ts = row.updated_at.getTime(), s = acct.state;
    return {
      id: row.id, venue: row.venue, network: row.network, kind: 'paper' as const, mode: policy.mode, label: row.label, policy,
      // figures at the marks of the last update (`state.ts`): the worker refreshes them every few seconds while the account has exposure
      state: acct.accountState(ts) as AccountState, positions: acct.positions() as Position[], openOrders: acct.openOrders(),
      initialCollateral: canon(row.initial_collateral),
      settings: { leverage: s.config.leverage, leverageByInstrument: s.config.leverageByInstrument, takerFeeRate: s.config.takerFeeRate, makerFeeRate: s.config.makerFeeRate,
        maintenanceMarginFraction: s.config.maintenanceMarginFraction, liquidationPrice: 'estimate (cross, single-position approximation)' },
      totals: { realizedPnl: s.realizedPnl, feesPaid: s.feesPaid, fundingNet: s.fundingNet, liquidations: s.liquidations },
      createdAt: row.created_at.getTime(), updatedAt: ts,
    };
  }

  async list() {
    const rows = await sql<AccountRow[]>`select * from deriv_paper_accounts order by created_at`;
    return rows.map((r) => this.view(r, PaperAccount.restore(r.state), RiskPolicySchema.parse(r.policy)));
  }

  async get(id: string) {
    const [row] = await sql<AccountRow[]>`select * from deriv_paper_accounts where id = ${id}`;
    if (!row) throw new UserError('unknown_account', 'unknown derivatives account', 404);
    const [orders, fills, funding, events, equity] = await Promise.all([
      sql`select * from deriv_orders where account_id = ${id} order by created_at desc, venue_order_id desc limit 100`,
      sql`select * from deriv_fills where account_id = ${id} order by ts desc, fill_id desc limit 100`,
      sql`select * from deriv_funding where account_id = ${id} order by ts desc limit 100`,
      sql`select * from deriv_risk_events where account_id = ${id} order by ts desc, id desc limit 100`,
      sql`select * from (select * from deriv_equity where account_id = ${id} order by ts desc limit 1500) e order by ts`,
    ]);
    return {
      ...this.view(row, PaperAccount.restore(row.state), RiskPolicySchema.parse(row.policy)),
      orders: orders.map(orderOf),
      fills: fills.map((f): Fill => ({ instrument: f.instrument, orderId: f.order_id, clientId: f.client_id, side: f.side, price: canon(f.price), size: canon(f.size), fee: canon(f.fee), feeAsset: f.fee_asset,
        closedPnl: canonN(f.closed_pnl), ts: f.ts.getTime(), id: f.fill_id, liquidation: f.liquidation })),
      funding: funding.map((f): FundingPayment => ({ instrument: f.instrument, amount: canon(f.amount), rate: canon(f.rate), size: canon(f.size), ts: f.ts.getTime() })),
      riskEvents: events.map((e) => ({ id: Number(e.id), ts: e.ts.getTime(), kind: e.kind as string, code: e.code as string | null, message: e.message as string, data: e.data as Record<string, unknown> })),
      equity: equity.map((e) => ({ ts: e.ts.getTime(), equity: canon(e.equity), collateral: canon(e.collateral), marginUsed: canon(e.margin_used), unrealizedPnl: canon(e.unrealized_pnl), source: 'paper' as const })),
    };
  }

  // ------------------------------------------------------------------ commands

  async create(body: z.infer<typeof CreateBodySchema>) {
    const entry = this.data.registry.get(body.venue);
    if (entry.restriction !== null) throw new UserError('venue_restricted', entry.restriction, 403);
    if (!entry.facts.paperFees || !entry.facts.hasOrderBook) throw new UserError('paper_unsupported', `${entry.name} has no order book: the paper engine fills against a live book, so no paper account is offered on this venue`, 422);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from deriv_paper_accounts`;
    if (n!.n >= MAX_PAPER_ACCOUNTS) throw new UserError('too_many_accounts', `at most ${MAX_PAPER_ACCOUNTS} paper accounts`, 422);
    const collateral = canon(body.collateral), id = randomUUID(), now = this.now();
    const merged = RiskPolicySchema.safeParse({ ...defaultPolicy(entry.id, collateral), ...(body.policy ?? {}) });
    if (!merged.success) throw new UserError('bad_policy', 'invalid risk policy', 400);
    const policy = assertPaperPolicy(merged.data);
    const acct = PaperAccount.create({ venue: entry.id, account: `paper:${id}`, collateral, config: {
      takerFeeRate: entry.facts.paperFees.taker, makerFeeRate: entry.facts.paperFees.maker, liquidationFeeRate: '0', feeAsset: 'USDC',
      leverage: policy.maxLeverage, leverageByInstrument: {}, maintenanceMarginFraction: PAPER_MAINTENANCE_FRACTION } });
    const meta: Meta = { fundingCursor: {}, marginWarning: false, lastEquityMinute: 0 };
    await sql`insert into deriv_paper_accounts (id, venue, network, label, initial_collateral, state, policy, meta, created_at, updated_at)
      values (${id}, ${entry.id}, ${entry.adapter.network}, ${body.label}, ${collateral}, ${sql.json(JSON.parse(acct.serialize()) as never)}, ${sql.json(policy as never)}, ${sql.json(meta as never)}, ${new Date(now)}, ${new Date(now)})`;
    await this.mutate(id, async (l, tx) => { await this.snapshotEquity(tx, l, now); });
    await audit('deriv.paper.account_created', 'owner', { account: id, venue: entry.id, label: body.label, collateral });
    return this.get(id);
  }

  async setPolicy(id: string, policy: RiskPolicy) {
    assertPaperPolicy(policy);
    await this.mutate(id, async (l) => {
      const was = l.policy;
      l.policy = policy;
      l.audits.push({ type: 'deriv.paper.policy_replaced', actor: 'owner', data: { account: id, mode: policy.mode, halt: policy.halt, maxLeverage: policy.maxLeverage, haltCleared: was.halt !== null && policy.halt === null } });
    });
    return this.get(id);
  }

  async reset(id: string) {
    await this.mutate(id, async (l, tx) => {
      const s = l.acct.state, now = this.now();
      const fresh = PaperAccount.create({ venue: s.venue, account: s.account, collateral: canon(l.row.initial_collateral), config: { ...s.config, leverageByInstrument: {} } });
      await tx`delete from deriv_orders where account_id = ${id}`; await tx`delete from deriv_fills where account_id = ${id}`;
      await tx`delete from deriv_funding where account_id = ${id}`; await tx`delete from deriv_equity where account_id = ${id}`;
      l.acct = fresh; l.meta = { fundingCursor: {}, marginWarning: false, lastEquityMinute: 0 };
      // the losses that justified a halt are wiped with the account: the breaker is released, the limits themselves stay
      const hadHalt = l.policy.halt;
      l.policy = { ...l.policy, halt: null };
      l.events.push({ kind: 'reset', code: null, message: `paper account reset: positions, orders and history wiped, collateral restored to ${fresh.state.collateral}${hadHalt ? '; halt released' : ''}`, data: { haltReleased: hadHalt }, dedupe: null, ts: now });
      l.audits.push({ type: 'deriv.paper.reset', actor: 'owner', data: { account: id, collateral: fresh.state.collateral } });
      await this.snapshotEquity(tx, l, now);
    });
    return this.get(id);
  }

  /** instrument, live ticker and live book of an order — read BEFORE the account is locked (no network inside a transaction) */
  private async live(l: { venue: VenueId }, instrumentId: string): Promise<{ inst: Instrument; ticker: Ticker; book: Book }> {
    const inst = await this.data.instrument(instrumentId);
    if (inst.venue !== l.venue) throw new UserError('instrument_mismatch', `this account is on ${l.venue}; ${inst.id} is on another venue`, 422);
    const [ticker, book] = await Promise.all([this.data.ticker(inst, LIVE), this.data.book(inst, LIVE)]);
    if (!book) throw new UserError('paper_unsupported', `${inst.venue} has no order book`, 422);
    return { inst, ticker, book };
  }

  private async venueOf(id: string): Promise<{ venue: VenueId }> {
    const [row] = await sql<{ venue: VenueId }[]>`select venue from deriv_paper_accounts where id = ${id}`;
    if (!row) throw new UserError('unknown_account', 'unknown derivatives account', 404);
    return row;
  }

  /** leverage of an order on its instrument, and the refusal when the requested setting is not allowed */
  private leverageFor(l: Loaded, inst: Instrument, asked: DecStr | undefined): { lev: DecStr; refusal: RiskResult | null } {
    const cfg = l.acct.state.config, max = D.from(inst.maxLeverage);
    if (asked === undefined) return { lev: cfg.leverageByInstrument[inst.id] ?? D.str(D.min(D.from(cfg.leverage), max)), refusal: null };
    const lev = D.from(asked), no = (reason: string): { lev: DecStr; refusal: RiskResult } => ({ lev: canon(asked), refusal: { ok: false, code: 'leverage_exceeded', reason } });
    if (D.gt(lev, max)) return no(`leverage ${asked} is above the venue maximum ${inst.maxLeverage} for ${inst.id}`);
    if (D.gt(lev, D.from(l.policy.maxLeverage))) return no(`leverage ${asked} is above the policy maximum ${l.policy.maxLeverage}`);
    if (inst.venue === 'hyperliquid' && (!D.isMultiple(lev, D.one) || D.lt(lev, D.one))) return no('leverage on Hyperliquid is an integer of at least 1');
    return { lev: canon(asked), refusal: null };
  }

  /** the order as the engines take it: canonical decimals, the worst price of a market order derived when asked */
  private request(body: OrderBody, inst: Instrument, book: Book, clientId: string): { req: OrderRequest; refusal: RiskResult | null } {
    let price = body.price === null ? null : canon(body.price);
    if (price === null && body.type === 'market' && body.slippageBps !== undefined) price = worstPrice(inst, book, body.side, body.slippageBps);
    const req: OrderRequest = { instrument: inst.id, side: body.side, type: body.type, size: canon(body.size), price, triggerPrice: body.triggerPrice === null ? null : canon(body.triggerPrice),
      reduceOnly: body.reduceOnly, tif: body.tif, clientId };
    const rules = priceRules(inst);
    for (const [name, p] of [['price', req.price], ['trigger price', req.triggerPrice]] as const) {
      const why = p === null ? null : rules.check(p);
      if (why) return { req, refusal: { ok: false, code: 'price_not_on_tick', reason: `${name}: ${why}` } };
    }
    return { req, refusal: null };
  }

  /** risk engine on the account as it stands at the live ticker */
  private async risk(tx: Tx, l: Loaded, req: OrderRequest, m: { inst: Instrument; ticker: Ticker; book: Book }, lev: DecStr, now: number, preview = false): Promise<RiskResult> {
    const own = checkOrder(l.policy, req, {
      instrument: m.inst, account: l.acct.accountState(now), positions: l.acct.positions(), openOrders: l.acct.openOrders(), book: m.book, ticker: m.ticker, now,
      usage: await this.usage(tx, l.row.id, l.acct, now), leverage: lev, maintenanceMarginFraction: l.acct.state.config.maintenanceMarginFraction,
    });
    if (!own.ok || !this.preTrade) return own;
    // V11: the unified risk engine — the same one as for live orders, with the paper limits; the paper book only (never a live position)
    const g = await this.preTrade({ mode: 'paper', venue: l.row.venue, network: l.row.network, accountId: l.row.id, req, instrument: m.inst, origin: 'owner', preview,
      known: { ticker: m.ticker, book: m.book, account: l.acct.accountState(now), positions: l.acct.positions(), leverage: lev, maintenanceMarginFraction: l.acct.state.config.maintenanceMarginFraction } });
    return g.ok ? own : { ok: false, code: g.code as never, reason: g.reason };
  }

  private estimate(l: Loaded, req: OrderRequest, m: { inst: Instrument; ticker: Ticker; book: Book }, lev: DecStr, now: number): OrderEstimate {
    const sim = PaperAccount.restore(l.acct.serialize());
    sim.state.config.leverageByInstrument[m.inst.id] = lev;
    const before = sim.signedPosition(m.inst.id), cfg = sim.state.config, levD = D.from(lev);
    const size = D.from(req.size), limit = req.price === null ? null : D.from(req.price);
    const base = { leverage: lev, price: req.price, source: 'estimate' as const };
    if (limit === null) {
      return { ...base, notional: D.str(D.mul(size, D.from(m.ticker.mark))), initialMargin: D.str(initialMargin(D.mul(size, D.from(m.ticker.mark)), levD)), fee: '0', avgFillPrice: null, slippageBps: null,
        liquidationPrice: null, freeCollateralAfter: sim.accountState(now).freeCollateral, filledSize: '0', restingSize: '0', status: 'rejected', rejectReason: 'a price is required (limit price, or worst acceptable price of a market order)' };
    }
    const res = sim.submit(req, m.book, m.ticker, now), order = res.order!;
    const mine = res.fills.filter((f) => f.clientId === req.clientId);
    const filled = mine.reduce((a, f) => D.add(a, D.from(f.size)), D.zero), cost = mine.reduce((a, f) => D.add(a, D.mul(D.from(f.size), D.from(f.price))), D.zero);
    let fee = mine.reduce((a, f) => D.add(a, D.from(f.fee)), D.zero);
    const resting = isOpen(order) ? D.sub(size, filled) : D.zero;
    const rejected = order.status === 'rejected';
    const avg = D.isPos(filled) ? D.div(cost, filled, 18, 'half_even') : null;
    const maker = D.max(D.zero, D.from(cfg.makerFeeRate));
    fee = D.add(fee, D.mul(D.mul(resting, limit), maker));
    const notional = rejected ? D.mul(size, limit) : D.add(cost, D.mul(resting, limit));
    const total = rejected ? size : D.add(filled, resting);
    const after = req.side === 'buy' ? D.add(before, total) : D.sub(before, total);
    const added = D.max(D.zero, D.sub(D.abs(after), D.abs(before)));
    const perUnit = D.isPos(total) ? D.div(notional, total, 18, 'up') : limit;
    const ref = D.from(m.ticker.mid ?? m.ticker.mark);
    const slip = avg === null ? null : D.div(D.mul(req.side === 'buy' ? D.sub(avg, ref) : D.sub(ref, avg), BPS), ref, 4, 'half_even');
    const pos = sim.positions().find((p) => p.instrument === m.inst.id);
    let free = D.from(sim.accountState(now).freeCollateral);
    if (D.isPos(resting)) {
      const cur = sim.state.positions.find((p) => p.instrument === m.inst.id);
      free = freeCollateralAfterOrder({ equity: sim.equity(), marginUsed: sim.marginUsed(), side: req.side, size: resting, price: limit, leverage: levD,
        position: cur ? { side: cur.side, size: D.from(cur.size), entryPrice: D.from(cur.entryPrice) } : null, feeRate: maker }).value;
    }
    return {
      ...base, notional: D.str(notional), initialMargin: D.str(initialMargin(D.mul(added, perUnit), levD)), fee: D.str(fee), avgFillPrice: avg === null ? null : D.str(avg),
      slippageBps: slip === null ? null : D.str(slip),
      liquidationPrice: pos ? { value: pos.liquidationPrice, source: 'estimate', method: `cross, single-position approximation at a flat maintenance fraction of ${cfg.maintenanceMarginFraction}; position after the immediate fills${D.isPos(resting) ? ' (the resting part is not included)' : ''}; no funding, no fees` } : null,
      freeCollateralAfter: D.str(free), filledSize: D.str(filled), restingSize: D.str(resting), status: order.status, rejectReason: order.rejectReason,
    };
  }

  /** same checks and the same simulation as an order, on a copy: nothing is stored */
  async preview(id: string, body: OrderBody): Promise<{ risk: RiskResult; estimate: OrderEstimate; request: OrderRequest; ts: number }> {
    const m = await this.live(await this.venueOf(id), body.instrument), now = this.now();
    return sql.begin(async (tx) => {
      const [row] = await tx<AccountRow[]>`select * from deriv_paper_accounts where id = ${id}`;
      if (!row) throw new UserError('unknown_account', 'unknown derivatives account', 404);
      const l = this.load(row);
      l.acct.onTicker(m.ticker, now);                               // on the loaded copy only: equity at the live mark
      const { lev, refusal: levRefusal } = this.leverageFor(l, m.inst, body.leverage);
      const { req, refusal: priceRefusal } = this.request(body, m.inst, m.book, 'preview');
      const risk = levRefusal ?? priceRefusal ?? await this.risk(tx, l, req, m, lev, now, true);
      return { risk, estimate: this.estimate(l, req, m, lev, now), request: req, ts: now };
    }) as Promise<{ risk: RiskResult; estimate: OrderEstimate; request: OrderRequest; ts: number }>;
  }

  private async stored(tx: Tx, id: string, clientId: string): Promise<{ order: Order; first: { order: Order; fills: Fill[] } | null } | null> {
    const [r] = await tx`select * from deriv_orders where account_id = ${id} and client_id = ${clientId}`;
    return r ? { order: orderOf(r), first: r.first_result as { order: Order; fills: Fill[] } | null } : null;
  }

  /**
   * validate → live context → risk engine → paper engine against the live book → state and rows in one transaction → audit.
   * `clientId` is the Idempotency-Key: a key already used on the account returns the first result and does nothing.
   */
  async order(id: string, body: OrderBody, clientId: string, origin: 'order' | 'close' = 'order'): Promise<{ order: Order; fills: Fill[]; idempotent: boolean }> {
    const [prior] = await sql`select first_result from deriv_orders where account_id = ${id} and client_id = ${clientId}`;
    if (prior?.first_result) return { ...(prior.first_result as { order: Order; fills: Fill[] }), idempotent: true };
    const m = await this.live(await this.venueOf(id), body.instrument), now = this.now();
    const out = await this.mutate(id, async (l, tx): Promise<{ refusal: Extract<RiskResult, { ok: false }> } | { order: Order; fills: Fill[]; idempotent: boolean }> => {
      const again = await this.stored(tx, id, clientId);            // decided under the lock: two requests with one key cannot both place
      if (again) return { ...(again.first ?? { order: again.order, fills: [] }), idempotent: true };
      const before = new Set(l.acct.state.positions.map((p) => p.instrument));
      const intervals = new Map([[m.inst.id, m.inst.fundingIntervalSec]]);
      // the account first sees the live mark (as the worker would feed it): equity, triggers and liquidation are current
      const fed = l.acct.onTicker(m.ticker, now);
      await this.record(tx, l, fed, 'worker');
      const { lev, refusal: levRefusal } = this.leverageFor(l, m.inst, body.leverage);
      const { req, refusal: priceRefusal } = this.request(body, m.inst, m.book, clientId);
      const risk = levRefusal ?? priceRefusal ?? await this.risk(tx, l, req, m, lev, now);
      if (!risk.ok) {
        l.events.push({ kind: 'order_refused', code: risk.code, message: risk.reason, ts: now, dedupe: null,
          data: { instrument: req.instrument, side: req.side, type: req.type, size: req.size, price: req.price, reduceOnly: req.reduceOnly, origin } });
        this.syncCursors(l, before, intervals, now);
        return { refusal: risk };
      }
      l.acct.state.config.leverageByInstrument[m.inst.id] = lev;
      const res = l.acct.submit(req, m.book, m.ticker, now);
      await this.record(tx, l, res, 'owner');
      const result = { order: res.order!, fills: res.fills.filter((f) => f.clientId === clientId) };
      await tx`update deriv_orders set first_result = ${tx.json(result as never)}, origin = ${origin === 'close' ? 'close' : 'owner'} where account_id = ${id} and client_id = ${clientId}`;
      this.syncCursors(l, before, intervals, now);
      await this.snapshotEquity(tx, l, now);
      l.audits.push({ type: origin === 'close' ? 'deriv.paper.close' : 'deriv.paper.order', actor: 'owner', data: { account: id, clientId, instrument: req.instrument, side: req.side, type: req.type, size: req.size, price: req.price,
        reduceOnly: req.reduceOnly, status: result.order.status, filled: result.order.filled, avgFillPrice: result.order.avgFillPrice, fills: result.fills.length } });
      return { ...result, idempotent: false };
    });
    if ('refusal' in out) throw new UserError(out.refusal.code, out.refusal.reason, 422);
    return out;
  }

  async cancel(id: string, clientId: string): Promise<{ order: Order }> {
    return this.mutate(id, async (l, tx) => {
      const res = l.acct.cancel(clientId, this.now());
      if (!res.order) {
        const kept = await this.stored(tx, id, clientId);           // an old closed order may have left the engine state
        if (!kept) throw new UserError('unknown_order', 'unknown order', 404);
        return { order: kept.order };
      }
      await this.record(tx, l, res, 'owner');
      if (res.orders.length) l.audits.push({ type: 'deriv.paper.cancel', actor: 'owner', data: { account: id, clientId, instrument: res.order.instrument } });
      return { order: res.order };
    });
  }

  /** reduce-only market order on a fraction of the position; the worst price comes from the book with a stated bound */
  async close(id: string, body: z.infer<typeof CloseBodySchema>, clientId: string = `close-${randomUUID()}`) {
    const [prior] = await sql`select first_result from deriv_orders where account_id = ${id} and client_id = ${clientId}`;
    if (prior?.first_result) return { ...(prior.first_result as { order: Order; fills: Fill[] }), idempotent: true, worstPrice: (prior.first_result as { order: Order }).order.price, slippageBoundBps: null };
    const [row] = await sql<AccountRow[]>`select * from deriv_paper_accounts where id = ${id}`;
    if (!row) throw new UserError('unknown_account', 'unknown derivatives account', 404);
    const inst = await this.data.instrument(body.instrument);
    const pos = row.state.positions.find((p) => p.instrument === inst.id);
    if (!pos) throw new UserError('no_position', `no open position on ${inst.id}`, 422);
    const whole = D.eq(D.from(body.fraction), D.one);
    const size = whole ? D.from(pos.size) : D.quantize(D.mul(D.from(pos.size), D.from(body.fraction)), D.from(inst.lotSize), 'down');
    if (!D.isPos(size)) throw new UserError('below_min_size', `${body.fraction} of the position is less than one lot (${inst.lotSize})`, 422);
    const side = pos.side === 'long' ? 'sell' as const : 'buy' as const;
    const bound = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const book = await this.data.book(inst, LIVE);
    if (!book) throw new UserError('paper_unsupported', `${inst.venue} has no order book`, 422);
    const price = worstPrice(inst, book, side, bound);
    const r = await this.order(id, { instrument: inst.id, side, type: 'market', size: D.str(size), price, triggerPrice: null, reduceOnly: true, tif: 'ioc' }, clientId, 'close');
    return { ...r, worstPrice: price, slippageBoundBps: bound };
  }

  // ------------------------------------------------------------------ worker step

  /** accounts with something for the worker to do, and the instruments they need (positions and open orders) */
  async active(): Promise<{ id: string; venue: VenueId; instruments: string[]; cursors: Record<string, number> }[]> {
    const rows = await sql<Pick<AccountRow, 'id' | 'venue' | 'state' | 'meta'>[]>`select id, venue, state, meta from deriv_paper_accounts
      where jsonb_array_length(state->'positions') > 0 or exists (select 1 from jsonb_array_elements(state->'orders') o where o->>'status' in ('pending', 'triggered', 'open', 'partially_filled'))
      order by created_at`;
    return rows.map((r) => ({ id: r.id, venue: r.venue, cursors: r.meta.fundingCursor ?? {},
      instruments: [...new Set([...r.state.positions.map((p) => p.instrument), ...r.state.orders.filter(isOpen).map((o) => o.instrument)])] }));
  }

  /**
   * One worker step for one account, with market data read beforehand. Idempotent: a book the account has already seen does
   * nothing, a funding time is applied once (engine state, cursor and primary key agree), the equity snapshot is one row per minute.
   */
  async tick(id: string, feeds: MarketFeed[], now: number): Promise<{ fills: number; funding: number; liquidated: boolean; halted: string | null }> {
    return this.mutate(id, async (l, tx) => {
      const summary = { fills: 0, funding: 0, liquidated: false, halted: null as string | null };
      const before = new Set(l.acct.state.positions.map((p) => p.instrument));
      const intervals = new Map(feeds.map((f) => [f.inst.id, f.inst.fundingIntervalSec]));
      const take = async (res: PaperResult): Promise<void> => {
        await this.record(tx, l, res, 'worker');
        summary.fills += res.fills.length; summary.funding += res.funding.length; summary.liquidated ||= res.liquidated;
        for (const f of res.fills) if (!f.liquidation) l.audits.push({ type: 'deriv.paper.fill', actor: 'paper-engine', data: { account: id, fill: f.id, clientId: f.clientId, instrument: f.instrument, side: f.side, size: f.size, price: f.price } });
      };

      // 1 — funding at the venue's funding times, each with the rate the venue published for it
      for (const f of feeds) {
        const iv = f.inst.fundingIntervalSec * 1000;
        let cursor = l.meta.fundingCursor[f.inst.id];
        if (cursor === undefined || !f.fundingRates) continue;
        for (let t = cursor + iv; t <= now; t += iv) {
          if (!l.acct.state.positions.some((p) => p.instrument === f.inst.id)) break;
          const rate = f.fundingRates.get(t);
          if (rate === undefined) {
            if (now - t <= FUNDING_GRACE_MS) break;                 // not published yet: the next step asks again
            l.events.push({ kind: 'funding_skipped', code: 'funding_rate_missing', message: `${f.inst.id}: the venue published no funding rate for ${new Date(t).toISOString()}; nothing was applied for that time`,
              data: { instrument: f.inst.id, fundingTime: t }, dedupe: `funding_skipped:${f.inst.id}:${t}`, ts: now });
          } else {
            l.acct.setMark(f.inst.id, D.from(f.ticker.mark));
            await take(l.acct.applyFunding(rate, t, f.inst.id));
          }
          cursor = t; l.meta.fundingCursor[f.inst.id] = t;
        }
      }
      // 2 — the live ticker (mark, triggers, liquidation), then the live book (triggered and resting orders)
      for (const f of feeds) {
        await take(l.acct.onTicker(f.ticker, now));
        if (f.book) await take(l.acct.onBook(f.book, now));
      }
      this.syncCursors(l, before, intervals, now);

      // 3 — margin warning: recorded when the account enters the zone, cleared when it leaves it
      const equity = l.acct.equity(), maintenance = l.acct.maintenance();
      const inZone = l.acct.state.positions.length > 0 && D.gte(maintenance, D.mul(equity, D.from(MARGIN_WARNING_RATIO)));
      if (inZone && !l.meta.marginWarning) {
        l.events.push({ kind: 'margin_warning', code: 'margin_warning', message: `maintenance margin ${D.str(maintenance)} has reached ${D.str(D.mul(D.from(MARGIN_WARNING_RATIO), D.from(100n)))} % of equity ${D.str(equity)}: the account is close to a simulated liquidation`,
          data: { equity: D.str(equity), maintenanceMargin: D.str(maintenance) }, dedupe: null, ts: now });
      }
      l.meta.marginWarning = inZone;

      // 4 — loss limits: a breach sets the circuit breaker. It stops new risk only: reduce-only orders that reduce still pass.
      if (l.policy.halt === null) {
        const u = await this.usage(tx, id, l.acct, now);
        const unrealized = D.sub(equity, D.from(l.acct.state.collateral));
        const daily = D.add(D.from(u.realizedToday), unrealized), total = D.add(D.from(u.realizedTotal), unrealized);
        const breach = D.lte(total, D.neg(D.from(l.policy.maxTotalLoss))) ? { code: 'total_loss_exceeded', text: `total loss limit reached: PnL ${D.str(total)} against a limit of −${l.policy.maxTotalLoss}` }
          : D.lte(daily, D.neg(D.from(l.policy.maxDailyLoss))) ? { code: 'daily_loss_exceeded', text: `daily loss limit reached: PnL ${D.str(daily)} against a limit of −${l.policy.maxDailyLoss}` } : null;
        if (breach) {
          l.policy = { ...l.policy, halt: `${breach.text} (${new Date(now).toISOString()})` };
          summary.halted = breach.code;
          // resting orders that could add exposure are withdrawn; reduce-only orders stay
          const cancelled: string[] = [];
          for (const o of l.acct.openOrders()) {
            if (o.reduceOnly) continue;
            const res = l.acct.cancel(o.clientId, now);
            const kept = l.acct.state.orders.find((x) => x.clientId === o.clientId);
            if (kept) kept.rejectReason = 'cancelled: trading halted by a loss limit';
            if (res.order) res.order.rejectReason = 'cancelled: trading halted by a loss limit';
            for (const x of res.orders) x.rejectReason = 'cancelled: trading halted by a loss limit';
            await this.record(tx, l, res, 'worker');
            cancelled.push(o.clientId);
          }
          l.events.push({ kind: 'loss_limit', code: breach.code, message: `${breach.text}; trading halted (closing with reduce-only orders stays possible); the halt lasts until the policy is replaced`,
            data: { daily: D.str(daily), total: D.str(total), maxDailyLoss: l.policy.maxDailyLoss, maxTotalLoss: l.policy.maxTotalLoss, cancelledOrders: cancelled }, dedupe: null, ts: now });
          l.audits.push({ type: 'deriv.paper.halt', actor: 'paper-engine', data: { account: id, code: breach.code, daily: D.str(daily), total: D.str(total) } });
        }
      }
      // 5 — equity: one row per minute, rewritten within the minute when something happened to the account
      if (Math.floor(now / 60_000) * 60_000 !== l.meta.lastEquityMinute || summary.fills > 0 || summary.funding > 0 || summary.liquidated) await this.snapshotEquity(tx, l, now);
      return summary;
    });
  }
}

function orderOf(r: Record<string, any>): Order {
  return { instrument: r.instrument, side: r.side, type: r.type, size: canon(r.size), price: canonN(r.price), triggerPrice: canonN(r.trigger_price), reduceOnly: r.reduce_only, tif: r.tif,
    clientId: r.client_id, venueOrderId: r.venue_order_id, status: r.status, filled: canon(r.filled), avgFillPrice: canonN(r.avg_fill_price),
    createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(), rejectReason: r.reject_reason };
}

// Read model and versioned configuration of the agents (V11).
//
// EVERY query of this file that reads a table shared by paper and live — agent_signals, research_log, agent_orders,
// agent_order_intents, agent_equity, deriv_fills / deriv_funding through the account of ONE mode — names the mode. There is no
// function here that returns two modes in one list, one curve or one figure (test: agent-modes.test.ts reads this source).
import { randomUUID } from 'node:crypto';
import { formatUnits } from '@spw/core';
import { mapHyperliquidOrder, type HlOrderState, type OrderState } from '@spw/trading';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { listAgentOrders } from './gateway.ts';
import { apiMode, configHash, dbMode, lifecycleOf, liveVerdict, modeOf, type DbMode, type Family, type Mode } from './model.ts';
import { computePerformance, spotTrades, type FundingRow, type PerfInput, type Performance, type SpotFill, type TradeRow } from './performance.ts';

export interface RuntimeAgentRow { id: string; name: string; mission: string; state: string; mode: string; kind: string | null; engine: string; family: string | null; template: string | null; network: string; universe: string[]; interval: string;
  cash: string | null; risk: Record<string, unknown>; capital_usdc: string; strategy_version_id: string | null; mandate_id: string | null; deriv_account_id: string | null; live_account_id: string | null;
  perp: { live?: { accountId: string; mandateId: string; network: string; since: number; exit?: { done?: number } | null } | null } | null; runtime: Record<string, unknown> | null; config_version: number; stop_reason: string | null; last_bar: Date | null; created_at: Date; updated_at: Date }

export async function loadAgent(id: string): Promise<RuntimeAgentRow> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new UserError('not_found', 'agent not found', 404);
  const [a] = await sql<RuntimeAgentRow[]>`select * from agents where id = ${id}`;
  if (!a) throw new UserError('not_found', 'agent not found', 404);
  return a;
}
export const parseMode = (m: unknown, dflt?: Mode): Mode => { if (m === 'research' || m === 'paper' || m === 'live') return m; if (m === undefined && dflt) return dflt; throw new UserError('bad_request', 'mode must be research, paper or live', 400); };

// ------------------------------------------------------------------------------------------------------------------ configuration versions

export function configOf(a: RuntimeAgentRow): Record<string, unknown> {
  return { kind: a.kind ?? 'spot', family: a.family ?? 'custom', template: a.template, engine: a.engine, network: a.network, universe: a.universe, interval: a.interval, cash: a.cash, capitalUsdc: String(a.capital_usdc), risk: a.risk,
    strategyVersionId: a.strategy_version_id, ...(a.engine !== 'bar' ? { venues: a.runtime?.venues ?? [], rule: a.runtime?.rule ?? null, config: a.runtime?.config ?? {} } : {}) };
}
/** Record the agent's CURRENT configuration as a new version when it differs from the running one. Returns the running version. */
export async function bumpConfig(agentId: string, actor: string, reason: string): Promise<number> {
  return sql.begin(async (tx) => {
    const [a] = await tx<RuntimeAgentRow[]>`select * from agents where id = ${agentId} for update`;
    if (!a) throw new UserError('not_found', 'agent not found', 404);
    const config = configOf(a), hash = configHash(config);
    const [cur] = await tx<{ version: number; config_sha256: string }[]>`select version, config_sha256 from agent_config_versions where agent_id = ${agentId} order by version desc limit 1`;
    if (cur && cur.config_sha256 === hash) return cur.version;
    const version = (cur?.version ?? 0) + 1;
    await tx`insert into agent_config_versions (agent_id, version, config, config_sha256, actor, reason) values (${agentId}, ${version}, ${tx.json(config as never)}, ${hash}, ${actor}, ${reason.slice(0, 200)})`;
    await tx`update agents set config_version = ${version}, updated_at = now() where id = ${agentId}`;
    await tx`insert into research_log (agent_id, kind, title, body, code, config_version) values (${agentId}, 'state', ${`Configuration version ${version}`}, ${reason.slice(0, 300)}, 'config_version', ${version})`;
    return version;
  }) as unknown as Promise<number>;
}
export const configVersions = (agentId: string) => sql`select version, config, config_sha256 as sha256, actor, reason, created_at from agent_config_versions where agent_id = ${agentId} order by version desc limit 50`;

// ------------------------------------------------------------------------------------------------------------------ views

export interface StrategyRef { name: string; version: string; sha256: string; path: string | null; status: string; kind: 'python' | 'rule' }
export async function strategyOf(a: RuntimeAgentRow): Promise<StrategyRef | null> {
  if (a.engine !== 'bar') { const rule = String(a.runtime?.rule ?? ''); const { RULES, ruleHash } = await import('./model.ts'); return RULES[rule] ? { name: rule, version: RULES[rule]!.version, sha256: ruleHash(rule), path: null, status: 'built_in', kind: 'rule' } : null; }
  if (!a.strategy_version_id) return null;
  const [v] = await sql<{ name: string; version: string; code_sha256: string; path: string; status: string }[]>`select name, version, code_sha256, path, status from strategy_versions where id = ${a.strategy_version_id}`;
  return v ? { name: v.name, version: v.version, sha256: v.code_sha256, path: v.path, status: v.status, kind: 'python' } : null;
}
/** the authorization policy of an agent: which mandate, if any, is in force for it (a reference — the mandate itself lives at the signer) */
export function mandateRef(a: RuntimeAgentRow): { kind: 'spot' | 'derivative'; id: string; accountId: string | null } | null {
  if (a.kind === 'perp') { const lb = a.perp?.live; return a.mode === 'LIVE' && lb && !lb.exit?.done && ['LIVE', 'PAUSED', 'STOPPING'].includes(a.state) ? { kind: 'derivative', id: lb.mandateId, accountId: lb.accountId } : null; }
  if ((a.kind ?? 'spot') === 'spot') return a.state === 'LIVE' && a.mandate_id ? { kind: 'spot', id: a.mandate_id, accountId: null } : null;
  return null;
}
export async function agentSummary(a: RuntimeAgentRow) {
  const family = (a.family ?? 'custom') as Family, kind = a.kind ?? 'spot', lv = liveVerdict(family, kind, a.universe);
  return { id: a.id, name: a.name, mission: a.mission, kind, family, template: a.template, engine: a.engine, state: lifecycleOf(a.state), phase: a.state, mode: modeOf(a), venue: kind === 'spot' ? 'spot' : kind === 'perp' ? 'hyperliquid' : (a.runtime?.venues as string[] | undefined)?.join('+') ?? 'all',
    network: a.network, universe: a.universe, interval: a.interval, capitalUsd: formatUnits(BigInt(a.capital_usdc), 6), riskLimits: a.risk, configVersion: a.config_version, strategy: await strategyOf(a), mandate: mandateRef(a),
    pausedFrom: (a.runtime as { pausedFrom?: string } | null)?.pausedFrom ?? null, live: lv.capable ? { capable: true as const, code: null, reason: null } : { capable: false as const, code: lv.code, reason: lv.reason },
    stopReason: a.stop_reason, lastBar: a.last_bar?.getTime() ?? null, createdAt: a.created_at.getTime(), updatedAt: a.updated_at.getTime() };
}

// ------------------------------------------------------------------------------------------------------------------ mode-scoped reads

const page = (q: { limit?: number; before?: number }) => ({ limit: Math.min(Math.max(q.limit ?? 100, 1), 500), before: q.before ? new Date(q.before) : null });

export async function agentSignals(agentId: string, mode: Mode, q: { limit?: number; before?: number } = {}) {
  const m = dbMode(mode), p = page(q);
  const rows = await sql`select id, bar, mode, kind, config_version, strategy_sha256, inputs_digest, status, reason, decision, reason_code, weights as output, scaled, scale, equity::text as equity, targets, orders, created_at, updated_at
    from agent_signals where agent_id = ${agentId} and mode = ${m} and (${p.before}::timestamptz is null or bar < ${p.before}) order by bar desc limit ${p.limit}`;
  return rows.map((r) => ({ id: String(r.id), ts: (r.bar as Date).getTime(), mode: apiMode(r.mode), kind: r.kind, configVersion: r.config_version, strategySha256: r.strategy_sha256, inputsDigest: r.inputs_digest, status: r.status, decision: r.decision, reasonCode: r.reason_code,
    reason: r.reason, output: r.output, scaled: r.scaled, scale: r.scale, equity: r.equity, targets: r.targets, orders: r.orders, createdAt: (r.created_at as Date).getTime(), updatedAt: (r.updated_at as Date).getTime() }));
}

export async function agentJournal(agentId: string, mode: Mode, q: { limit?: number; before?: number } = {}) {
  const m = dbMode(mode), p = page(q);
  const rows = await sql`select id, ts, mode, kind, severity, code, title, body, data, ref, config_version from research_log where agent_id = ${agentId} and mode = ${m} and (${p.before}::timestamptz is null or ts < ${p.before}) order by id desc limit ${p.limit}`;
  return rows.map((r) => ({ id: String(r.id), ts: (r.ts as Date).getTime(), mode: apiMode(r.mode), kind: r.kind, severity: r.severity, code: r.code, title: r.title, body: r.body, data: r.data, ref: r.ref, configVersion: r.config_version }));
}

const SPOT_STATE: Record<string, OrderState> = { prepared: 'APPROVED', signed: 'SUBMITTING', broadcast: 'SUBMITTED', filled: 'FILLED', failed: 'FAILED', skipped: 'CANCELLED' };
const PAPER_STATUS: Record<string, OrderState> = { filled: 'FILLED', partially_filled: 'CANCELLED', cancelled: 'CANCELLED', rejected: 'REJECTED', open: 'SUBMITTED', pending: 'SUBMITTED', triggered: 'SUBMITTED' };
/** the account whose orders, fills and funding belong to ONE mode of a perp agent */
export function perpAccount(a: RuntimeAgentRow, mode: Mode): string | null { return mode === 'paper' ? a.deriv_account_id : mode === 'live' ? a.perp?.live?.accountId ?? null : null; }

/** Orders of ONE mode, each from ONE place: a unified order is read from `orders` (`source: 'orders'` — perp agents through the
 *  order service, and spot swaps through the execution layer's projection of `agent_orders`); what is not a unified order is read
 *  from the seam gateway's ledger (`gateway`: the stream agents' simulated orders) or from the engine tables of before (`legacy`).
 *  An order that exists as a unified order is never also answered from the ledger or from an engine table. */
export async function agentOrders(a: RuntimeAgentRow, mode: Mode, q: { limit?: number; before?: number; open?: boolean } = {}) {
  const m = dbMode(mode), p = page(q), kind = a.kind ?? 'spot';
  // spot: the swaps the execution layer projected into `orders` (engine 'spot', engine_ref 'agent:<agent_orders.id>'), with the context the engine wrote on its row
  const projected = kind === 'spot' ? await sql<{ ao_id: string; client_order_id: string | null; order_id: string; signal_id: string | null; config_version: number | null; strategy_sha256: string | null }[]>`select ao.id::text as ao_id, ao.client_order_id, o.id as order_id, ao.signal_id::text as signal_id, ao.config_version, ao.strategy_sha256
    from agent_orders ao join orders o on o.engine = 'spot' and o.engine_ref = 'agent:' || ao.id::text where ao.agent_id = ${a.id} and ao.mode = ${m}` : [];
  const byOrder = new Map(projected.map((x) => [x.order_id, x])), seenClient = new Set(projected.map((x) => x.client_order_id).filter(Boolean)), seenRow = new Set(projected.map((x) => x.ao_id));
  const all = (await listAgentOrders(a.id, { mode, limit: p.limit, ...(q.before ? { before: q.before } : {}), ...(q.open ? { open: true } : {}) })).filter((o) => !(o.source === 'ledger' && seenClient.has(o.clientOrderId)));
  const ledger = all.map((o) => ({ ...o, signalId: o.signalId ?? byOrder.get(o.id)?.signal_id ?? null, configVersion: o.configVersion ?? byOrder.get(o.id)?.config_version ?? null, strategySha256: o.strategySha256 ?? byOrder.get(o.id)?.strategy_sha256 ?? null }))
    .map((o) => ({ id: o.id, source: (o.source === 'orders' ? 'orders' : 'gateway') as 'orders' | 'gateway', mode: o.mode, ts: o.createdAt, updatedAt: o.updatedAt, venue: o.venue, instrument: o.instrument, side: o.side,
    reduceOnly: o.reduceOnly, size: o.size, notional: o.order?.notional ?? null, filledSize: o.filledSize, avgFillPrice: o.avgFillPrice, state: o.state, reason: o.reason, detail: o.detail, venueOrderId: o.venueOrderId, fills: o.fills,
    signalId: o.signalId, configVersion: o.configVersion, strategySha256: o.strategySha256, history: o.history.map((h) => ({ at: h.at, from: h.from, to: h.to, event: h.event, reason: h.reason })) }));
  let legacy: typeof ledger = [];
  if (kind === 'spot') {
    const rows = await sql`select id, ts, updated_at, from_symbol, to_symbol, amount_in::text as amount_in, received::text as received, state, reason, txid, mode from agent_orders
      where agent_id = ${a.id} and mode = ${m} and client_order_id is null and (${p.before}::timestamptz is null or ts < ${p.before}) order by ts desc limit ${p.limit}`;
    legacy = rows.filter((r) => !seenRow.has(String(r.id))).map((r) => { const sell = r.to_symbol === (a.cash ?? 'USDC'); return { id: r.id, source: 'gateway' as const, mode: apiMode(r.mode) as 'paper' | 'live', ts: (r.ts as Date).getTime(), updatedAt: (r.updated_at as Date).getTime(), venue: 'kyberswap', instrument: `kyberswap:${sell ? r.from_symbol : r.to_symbol}`,
      side: sell ? 'sell' as const : 'buy' as const, reduceOnly: false, size: null, notional: null, filledSize: '0', avgFillPrice: null, state: SPOT_STATE[r.state] ?? 'UNKNOWN', reason: 'LEGACY_UNSPECIFIED' as never, detail: r.reason, venueOrderId: r.txid, fills: [],
      signalId: null, configVersion: null, strategySha256: null, history: [] }; }).map((x) => ({ ...x, source: 'legacy' as never }));
  } else if (kind === 'perp') {
    const acct = perpAccount(a, mode);
    if (acct) {
      const rows = await sql`select client_id, instrument, side, size::text as size, filled::text as filled, avg_fill_price::text as avg, status, state, final, reject_reason, reduce_only, venue_order_id, created_at, updated_at from deriv_orders
        where account_id = ${acct} and origin in ('agent', 'mandate') and (${p.before}::timestamptz is null or created_at < ${p.before}) and client_id not in (select client_order_id from agent_order_intents where agent_id = ${a.id} and mode = ${m})
          and not exists (select 1 from orders o where o.principal_kind = 'agent' and o.principal_id = ${a.id} and o.engine_ref = ${acct} || ':' || deriv_orders.client_id)
        order by created_at desc limit ${p.limit}`;
      legacy = rows.map((r) => { const u = r.state ? mapHyperliquidOrder(r.state as HlOrderState, { final: r.final, rejectReason: r.reject_reason }) : { state: PAPER_STATUS[r.status] ?? 'UNKNOWN', reason: 'LEGACY_UNSPECIFIED', note: null };
        return { id: r.client_id, source: 'legacy' as never, mode: mode as 'paper' | 'live', ts: (r.created_at as Date).getTime(), updatedAt: (r.updated_at as Date).getTime(), venue: 'hyperliquid', instrument: r.instrument, side: r.side, reduceOnly: r.reduce_only, size: r.size, notional: null,
          filledSize: r.filled, avgFillPrice: r.avg, state: u.state as OrderState, reason: u.reason as never, detail: r.reject_reason, venueOrderId: r.venue_order_id, fills: [], signalId: null, configVersion: null, strategySha256: null, history: [] }; });
    }
  }
  return [...ledger, ...legacy].sort((x, y) => y.ts - x.ts).slice(0, p.limit);
}

/** The inputs of the performance module for ONE mode of one agent. */
export async function performanceInput(a: RuntimeAgentRow, mode: Mode): Promise<PerfInput> {
  const m = dbMode(mode), kind = a.kind ?? 'spot';
  const eq = await sql<{ ts: Date; equity_usd: number }[]>`select ts, equity_usd from agent_equity where agent_id = ${a.id} and mode = ${m} order by ts desc limit 5000`;
  const equity = eq.reverse().map((r) => ({ ts: r.ts.getTime(), equity: r.equity_usd }));
  if (kind === 'spot') {
    const cash = a.cash ?? 'USDC';
    const rows = await sql<{ ts: Date; from_symbol: string; to_symbol: string; amount_in: string; expected_out: string | null; received: string | null; usd: number | null; decimals_hint: number | null }[]>`select ts, from_symbol, to_symbol, amount_in::text as amount_in, expected_out::text as expected_out,
      received::text as received, (aux->>'usd')::float as usd, null::int as decimals_hint from agent_orders where agent_id = ${a.id} and mode = ${m} and state = 'filled' order by ts`;
    const fills: SpotFill[] = rows.filter((r) => r.usd !== null && r.usd > 0).map((r) => {
      const sell = r.to_symbol === cash, exp = r.expected_out ? Number(r.expected_out) : null, got = r.received ? Number(r.received) : null;
      // what the quote promised against what arrived, valued at this fill's own price (the same base units on both sides of the ratio)
      const expectedUsd = exp !== null && got !== null && got > 0 ? (sell ? r.usd! * (exp / got) : r.usd! * (exp / got)) : null;
      return { ts: r.ts.getTime(), symbol: sell ? r.from_symbol : r.to_symbol, side: sell ? 'sell' as const : 'buy' as const, units: 0, usd: r.usd!, expectedUsd };
    });
    // units: a spot fill's size in units is not needed for the cost basis when expressed per USD — use USD at the fill as the unit count of the cash leg and track the asset by its USD cost
    const trades = spotTrades(await withUnits(a, fills, rows));
    return { equity, trades, funding: [], notes: { fees: mode === 'paper' ? 'paper fills are the provider\'s quote: network fees are not simulated' : 'network fees are paid by the vault in the native coin and are not in this figure', funding: 'spot: no funding' } };
  }
  if (kind === 'perp') {
    const acct = perpAccount(a, mode);
    if (!acct) return { equity, trades: [], funding: [], notes: { trades: `this agent has no ${mode} account` } };
    const fills = await sql<{ ts: Date; price: string; size: string; fee: string; closed_pnl: string | null }[]>`select ts, price::text as price, size::text as size, fee::text as fee, closed_pnl::text as closed_pnl from deriv_fills where account_id = ${acct} order by ts`;
    const fund = await sql<{ ts: Date; amount: string }[]>`select ts, amount::text as amount from deriv_funding where account_id = ${acct} order by ts`;
    const trades: TradeRow[] = fills.map((f) => ({ ts: f.ts.getTime(), notionalUsd: Number(f.price) * Number(f.size), feeUsd: Number(f.fee), slippageUsd: null, closedPnlUsd: f.closed_pnl === null ? null : Number(f.closed_pnl) }));
    const funding: FundingRow[] = fund.map((f) => ({ ts: f.ts.getTime(), amountUsd: Number(f.amount) }));
    return { equity, trades, funding, notes: { slippage: 'the fills carry no reference price: slippage against the decision price is not recorded' } };
  }
  // stream agents: the gateway's ledger of THIS mode
  const orders = await listAgentOrders(a.id, { mode, limit: 500 });
  const trades: TradeRow[] = orders.flatMap((o) => o.fills.map((f) => ({ ts: f.ts, notionalUsd: Number(f.size) * Number(f.price), feeUsd: f.feeUsd === null ? null : Number(f.feeUsd), slippageUsd: 0, closedPnlUsd: null })));
  const book = a.runtime?.book as { funding?: number } | undefined;
  return { equity, trades, funding: mode === 'paper' && book?.funding ? [{ ts: Date.now(), amountUsd: book.funding }] : [], notes: { trades: 'the simulated book keeps positions at average cost: per-trade results are not kept (win rate and profit factor are not computed)', slippage: 'simulated fills are at the quote or at the book price read by the decision' } };
}
/** units of the asset leg of each spot fill, from the stored base units and the registry decimals */
async function withUnits(a: RuntimeAgentRow, fills: SpotFill[], rows: { from_symbol: string; to_symbol: string; amount_in: string; received: string | null; usd: number | null }[]): Promise<SpotFill[]> {
  const { agentAssets } = await import('../agents/routes.ts'), cash = a.cash ?? 'USDC';
  let dec: Record<string, number> = {};
  try { dec = Object.fromEntries(agentAssets(a as never).map((x) => [x.symbol, x.decimals])); } catch { /* an asset no longer in the registry: 18 */ }
  const usable = rows.filter((r) => r.usd !== null && r.usd > 0);
  return fills.map((f, i) => { const r = usable[i]!, sell = r.to_symbol === cash, base = sell ? r.amount_in : r.received ?? '0'; return { ...f, units: Number(formatUnits(BigInt(base.split('.')[0] ?? '0'), dec[f.symbol] ?? 18)) }; }).filter((f) => f.units > 0);
}

export interface PerformanceView extends Omit<Performance, 'equityCurve' | 'returns'> { mode: Mode; label: string; equityCurve: { ts: number; equity: number }[] }
export async function agentPerformance(a: RuntimeAgentRow, mode: Mode): Promise<PerformanceView> {
  if (mode === 'research') {
    // research produces no equity of its own: backtests are reports (labelled as such), never a performance figure
    const p = computePerformance({ equity: [], trades: [], funding: [] });
    const { equityCurve: _c, returns: _r, ...rest } = p; void _c; void _r;
    return { ...rest, mode, label: 'RESEARCH — no order is placed in this mode; backtest reports are under the agent\'s strategy and are not performance', equityCurve: [] };
  }
  const p = computePerformance(await performanceInput(a, mode));
  const { equityCurve, returns: _r, ...rest } = p; void _r;
  return { ...rest, mode, label: mode === 'paper' ? 'PAPER — simulated orders and fills; no money moved' : 'LIVE — real orders on a venue or on-chain account', equityCurve: equityCurve.slice(-1000) };
}

/** signal → decision → order → fill → error, newest first: ONE mode of one agent */
export async function agentTimeline(a: RuntimeAgentRow, mode: Mode, q: { limit?: number; before?: number } = {}) {
  const limit = Math.min(q.limit ?? 120, 300);
  const [journal, signals, orders] = await Promise.all([agentJournal(a.id, mode, { limit, ...(q.before ? { before: q.before } : {}) }), agentSignals(a.id, mode, { limit, ...(q.before ? { before: q.before } : {}) }), agentOrders(a, mode, { limit, ...(q.before ? { before: q.before } : {}) })]);
  const items = [
    ...journal.map((j) => ({ ts: j.ts, type: j.kind as string, severity: j.severity as string, code: j.code as string | null, title: j.title as string, body: j.body as string, ref: j.ref as unknown, configVersion: j.configVersion as number | null })),
    ...signals.map((s) => ({ ts: s.createdAt, type: 'signal', severity: 'info', code: s.reasonCode as string | null, title: `Signal for ${new Date(s.ts).toISOString()} — ${s.decision}${s.reasonCode ? ` (${s.reasonCode})` : ''}`, body: String(s.reason ?? ''), ref: { signal: s.id }, configVersion: s.configVersion as number | null })),
    ...orders.filter((o) => o.source === ('legacy' as never)).map((o) => ({ ts: o.ts, type: 'order', severity: o.state === 'REJECTED' || o.state === 'FAILED' || o.state === 'UNKNOWN' ? 'warning' : 'info', code: o.state as string | null, title: `Order ${String(o.state).toLowerCase()}: ${o.side} ${o.instrument}`, body: String(o.detail ?? ''), ref: { order: o.id }, configVersion: null })),
  ].sort((x, y) => y.ts - x.ts).slice(0, limit);
  return { mode, items };
}

// ------------------------------------------------------------------------------------------------------------------ creation (stream and supervisor agents)

export async function insertRuntimeAgent(o: { kind: 'stream' | 'supervisor'; family: Family; template: string; name: string; mission: string; universe: string[]; venues: string[]; rule: string; config: Record<string, unknown>; risk: Record<string, unknown>; capitalUsdc: string; actor: string }): Promise<RuntimeAgentRow> {
  const id = randomUUID(), capital = BigInt(Math.round(Number(o.capitalUsdc) * 1e6)).toString();
  const [row] = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7707002)`;
    if (o.kind === 'supervisor' && (await tx`select 1 from agents where kind = 'supervisor' and state <> 'STOPPED' limit 1`).length) throw new UserError('exists', 'a risk-management agent already exists: stop it before creating another one', 409);
    const rows = await tx<{ next: number }[]>`select least(coalesce(min(vault_index), 0), 0) - 1 as next from agents`;   // no vault: a negative index, like a perp agent
    return tx<RuntimeAgentRow[]>`insert into agents (id, kind, engine, family, template, name, mission, network, universe, cash, assets, interval, risk, vault_index, vault_address, capital_usdc, mode, state, runtime)
      values (${id}, ${o.kind}, ${o.kind}, ${o.family}, ${o.template}, ${o.name}, ${o.mission}, ${o.kind === 'supervisor' ? 'all' : o.venues.join('+')}, ${tx.json(o.universe)}, 'USDC', ${tx.json({})}, ${o.kind}, ${tx.json(o.risk as never)}, ${rows[0]!.next}, '',
        ${capital}, 'RESEARCH', 'CREATED', ${tx.json({ venues: o.venues, rule: o.rule, config: o.config } as never)}) returning *`;
  }) as unknown as RuntimeAgentRow[];
  await sql`insert into agent_config_versions (agent_id, version, config, config_sha256, actor, reason) values (${id}, 1, ${sql.json(configOf(row!) as never)}, ${configHash(configOf(row!))}, ${o.actor}, 'created from a template')`;
  await audit('agent.created', o.actor, { id, kind: o.kind, family: o.family, template: o.template, name: o.name, venues: o.venues, universe: o.universe });
  return row!;
}
export type { DbMode };

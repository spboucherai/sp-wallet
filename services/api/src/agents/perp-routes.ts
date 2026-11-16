// Perp agents (V6): lifecycle and views. A perp agent is bound to ONE venue (Hyperliquid), 1 to 8 of its instruments, one
// interval and ONE derivatives paper account created for it (collateral = the agent's capital, risk policy = the owner's limits).
// It is created in SIMULATION: no vault, no mandate, creation never asks the signer for anything. V7: it can go LIVE on a
// venue account under a derivative mandate enforced by the isolated signer (perp-live-cycle.ts) — the routes are at the end.
// The routes live in the `/api/v1/agents` family; the shared ones (list, create, detail, mode, approve) delegate here from
// routes.ts when the agent's kind is 'perp'.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, parseUnits } from '@spw/core';
import { D } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import type { LiveService } from '../derivatives/exec.ts';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import { liveLocale } from '../derivatives/live-texts.ts';
import { isLiveActive, LiveApproveBody, liveBlock, LivePrepareBody, liveReadiness, pauseLive, resumeLive, stopLive } from './perp-live-cycle.ts';
import { GATE, PERP_INTERVALS } from './perp-data.ts';
import { CAP_HEADROOM, flattenPerp, instrumentId, LEVERAGE_HEADROOM, PERP_VENUE, perpPolicy, PerpRisk, type PerpAgentRow, type PerpBook } from './perp-engine.ts';
import { createPerpRuntime, perpRuntime, setPerpRuntime } from './perp-live.ts';
import { perpLibrary, perpReportProblem, registerPerpStrategy } from './perp-strategies.ts';
import type { AgentRow } from './routes.ts';

export const MAX_PERP_INSTRUMENTS = 8;
export const LIVE_UNAVAILABLE = 'Live trading of a perp agent needs a derivatives mandate enforced by the isolated signer (instruments, leverage, notional and loss limits checked by the signer on every order). A perp agent has no spot vault and no spot mandate: it goes live from its own page (venue account, then mandate).';
/** symbols the laboratory accepts as they are (upper-case tickers); mixed-case listings (kPEPE…) are not offered */
const SYMBOL = /^[A-Z0-9]{2,10}$/;
const PerpCreate = z.strictObject({
  kind: z.literal('perp'), name: z.string().min(2).max(40), mission: z.string().max(400).default(''), venue: z.literal(PERP_VENUE).default(PERP_VENUE),
  instruments: z.array(z.string().regex(SYMBOL)).min(1).max(MAX_PERP_INSTRUMENTS).refine((x) => new Set(x).size === x.length, 'duplicate instrument'),
  interval: z.enum(PERP_INTERVALS).default('1h'),
  /** collateral of the paper account, USDC */
  capitalUsdc: z.string().regex(/^\d{2,7}(\.\d{1,6})?$/), risk: PerpRisk.default(PerpRisk.parse({})) });

export const isPerp = (a: Pick<AgentRow, 'id'> & { kind?: string }): a is PerpAgentRow => a.kind === 'perp';
/** routes that only make sense for a spot agent's vault and mandate */
export function spotOnly(a: Pick<AgentRow, 'id'> & { kind?: string }): void {
  if (isPerp(a)) throw new UserError('perp_agent', `not available for a perp agent. ${LIVE_UNAVAILABLE}`, 409);
}

export const perpView = (a: PerpAgentRow) => ({
  id: a.id, kind: 'perp' as const, simulation: a.mode !== 'LIVE', name: a.name, mission: a.mission, state: a.state, mode: a.mode === 'LIVE' ? 'LIVE' as const : 'PAPER' as const,
  /** V7: the network of the venue account of an agent whose mode is LIVE (testnet = the money is not real); null in simulation */
  liveNetwork: a.mode === 'LIVE' ? a.perp?.live?.network ?? null : null, venue: PERP_VENUE, network: PERP_VENUE, networkName: 'Hyperliquid', universe: a.universe,
  instruments: a.universe.map(instrumentId), cash: 'USDC', interval: a.interval, risk: a.risk, capitalUsdc: formatUnits(BigInt(a.capital_usdc), 6), accountId: a.deriv_account_id,
  strategyVersionId: a.strategy_version_id, mandateId: null, mandate: null, vaultAddress: '', holdings: null,
  flag: a.perp?.flag ?? null, hold: a.perp?.hold ?? null, flattening: a.perp?.flatten ?? null,
  family: (a as { family?: string | null }).family ?? 'custom', template: (a as { template?: string | null }).template ?? null, engine: 'bar', configVersion: a.config_version ?? 1,
  lastBar: a.last_bar, stopReason: a.stop_reason, createdAt: a.created_at, updatedAt: a.updated_at });

const rt = () => perpRuntime();
const paper = () => rt().deriv.paper;
const data = () => rt().deriv.data;

export async function createPerpAgent(body: unknown) {
  const b = PerpCreate.parse(body);
  const capital = D.str(D.from(b.capitalUsdc));
  if (D.lt(D.from(capital), D.from(50n))) throw new UserError('bad_request', 'a perp agent needs at least 50 USDC of simulated capital (the venue\'s minimum order is 10 USD)', 400);
  if (b.risk.maxDailyLossPct > b.risk.maxTotalLossPct) throw new UserError('bad_request', 'the daily loss limit cannot exceed the total loss limit', 400);
  // every instrument must exist on the venue, be active and accept cross margin (the paper account is cross-margin)
  const list = (await data().instruments(PERP_VENUE)).value, warnings: { code: string; message: string }[] = [];
  for (const s of b.instruments) {
    const inst = list.find((i) => i.symbol === s);
    if (!inst) throw new UserError('unknown_instrument', `${s} is not a Hyperliquid perpetual`, 422);
    if (inst.status !== 'active') throw new UserError('instrument_halted', `${inst.id} is ${inst.status} on the venue`, 422);
    if (!inst.marginModes.includes('cross')) throw new UserError('unsupported_instrument', `${inst.id} is isolated-margin only; the paper account is cross-margin`, 422);
    if (D.lt(D.from(inst.maxLeverage), D.from(BigInt(b.risk.maxLeverage)))) warnings.push({ code: 'leverage', message: `${s}: the venue allows ${inst.maxLeverage}x at most; its orders use that setting, the account limit stays ${b.risk.maxLeverage}x` });
  }
  // the paper account of the agent: collateral = capital, policy = the owner's limits, only the agent's instruments allowed
  const account = await paper().create({ venue: PERP_VENUE, label: `Agent · ${b.name}`.slice(0, 60), collateral: capital, policy: perpPolicy(b.instruments, capital, b.risk) });
  const id = randomUUID();
  let row: PerpAgentRow;
  try {
    const rows = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(7707002)`;
      // no vault: a negative index keeps the unique column and can never collide with a signer-derived vault (index ≥ 1)
      const rows = await tx<{ next: number }[]>`select least(coalesce(min(vault_index), 0), 0) - 1 as next from agents`;
      return tx<PerpAgentRow[]>`insert into agents (id, kind, name, mission, network, universe, cash, assets, interval, risk, vault_index, vault_address, capital_usdc, deriv_account_id, mode)
        values (${id}, 'perp', ${b.name}, ${b.mission}, ${PERP_VENUE}, ${tx.json(b.instruments)}, 'USDC', ${tx.json({})}, ${b.interval}, ${tx.json(b.risk as never)}, ${rows[0]!.next}, '', ${parseUnits(capital, 6).toString()}, ${account.id}, 'PAPER') returning *`;
    }) as unknown as PerpAgentRow[];
    row = rows[0]!;
  } catch (e) { await sql`delete from deriv_paper_accounts where id = ${account.id}`.catch(() => {}); throw e; }
  await audit('agent.created', 'owner', { id, kind: 'perp', name: b.name, venue: PERP_VENUE, instruments: b.instruments, account: account.id, capital, risk: b.risk });
  await (await import('../agent-runtime/store.ts')).bumpConfig(id, 'owner', 'created');   // V11: configuration version 1
  return { ...perpView(row), warnings };
}

const pick = (o: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | null => (o ? Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) : null);
const SPLIT_KEYS = ['total_return', 'sharpe', 'max_drawdown', 'worst_intrabar_drawdown', 'trades', 'fees_paid', 'slippage_paid', 'funding_pnl', 'liquidations', 'wiped_out', 'gross_leverage_max', 'margin_utilisation_max', 'orders_cut', 'orders_refused',
  // version 3: price PnL → funding → fees → slippage → latency → net (an exact identity), with gross and net Sharpe; null in a version-2 report
  'gross_to_net'];
/** What the owner must read before approving: the figures, and every reason to distrust them. */
export function perpReportSummary(report: any, sha256: string, symbols: string[]) {
  if (!report) return null;
  const c = report.config ?? {}, notes: string[] = Array.isArray(report.checks?.notes) ? report.checks.notes : [];
  const days = c.start && c.end ? Math.round((Date.parse(c.end) - Date.parse(c.start)) / 86_400_000) : null;
  const liq = (split: string): number => (Array.isArray(report.liquidations?.[split]) ? report.liquidations[split].length : 0);
  return {
    schemaVersion: report.schema_version ?? null, generatedAt: report.generated_at ?? null,
    config: pick(c, ['symbols', 'interval', 'start', 'end', 'bars', 'fee_bps', 'slippage_bps', 'leverage', 'max_leverage', 'max_gross_exposure', 'liquidation_penalty_bps', 'funding_reference_price', 'initial_cash', 'source']),
    historyDays: days, splits: report.splits ?? null,
    metrics: Object.fromEntries(['train', 'validation', 'test'].map((s) => [s, pick(report.metrics?.[s], SPLIT_KEYS)])),
    benchmarks: { buy_and_hold: pick(report.benchmarks?.buy_and_hold, ['total_return', 'sharpe', 'max_drawdown']), perp_long_1x: pick(report.benchmarks?.perp_long_1x, ['total_return', 'sharpe', 'max_drawdown']) },
    /** false: no spot candles were supplied, the "buy and hold" benchmark is the perpetual's own price held */
    buyAndHoldIsSpot: !notes.some((n) => n.startsWith('no spot candles were supplied')),
    robustness: pick(report.robustness, ['trials_tested', 'deflated_sharpe', 'bootstrap_sharpe_ci']),
    checks: pick(report.checks, ['lookahead', 'data_quality', 'ledger', 'funding_alignment']),
    liquidations: { train: liq('train'), validation: liq('validation'), test: liq('test') },
    // V11, version-3 reports only (null for the version-2 reports stored before V11 — they stay readable as they are):
    /** latency bound, size-dependent slippage, fee table per venue, funding interval per venue, one account per venue */
    executionModel: report.execution_model ?? null,
    /** the live engine's sizing and stop rules applied to the backtest; `observed.<split>.stop` non-null = the engine's own
     *  loss limit (or a liquidation) ended that split and its equity is flat afterwards */
    engineParity: report.engine_parity ?? null,
    /** survivorship, listing-date truncation, missing / stale bars, common-clock drop */
    dataBias: report.data_bias ?? null,
    /** strategy hash, laboratory code hash, data snapshot hash, parameters, seed */
    journal: report.journal ?? null,
    /** non-null: the version cannot be approved */
    problem: perpReportProblem(report, sha256, symbols),
  };
}

export async function perpDetail(a: PerpAgentRow) {
  const account = await paper().get(a.deriv_account_id).catch(() => null);
  const rows = await sql`select id, name, version, code_sha256, status, notes, created_at, approved_at, meta, report from strategy_versions where agent_id = ${a.id} order by created_at desc`;
  const versions = rows.map((v) => ({ id: v.id, name: v.name, version: v.version, code_sha256: v.code_sha256, status: v.status, notes: v.notes, created_at: v.created_at, approved_at: v.approved_at,
    meta: v.meta, summary: perpReportSummary(v.report, v.code_sha256, a.universe) }));
  // V11 (D5): the page of an agent shows the records of the mode it is in NOW — paper and live are never one list or one curve
  const mode = a.mode === 'LIVE' ? 'LIVE' : 'PAPER';
  const signals = await sql`select bar, status, reason, strategy_sha256, weights, scaled, scale, equity::text as equity, targets, orders, updated_at, mode, decision, reason_code, config_version from agent_signals where agent_id = ${a.id} and mode = ${mode} order by bar desc limit 60`;
  const equity = await sql`select ts, mode, equity_usd from agent_equity where agent_id = ${a.id} and mode = ${mode} order by ts desc limit 500`;
  const log = await sql`select ts, kind, title, body, mode, severity, code from research_log where agent_id = ${a.id} and mode = ${mode} order by id desc limit 40`;
  return { ...perpView(a),
    account: account ? { id: account.id, label: account.label, state: account.state, policy: account.policy, settings: account.settings, totals: account.totals, initialCollateral: account.initialCollateral,
      positions: account.positions, openOrders: account.openOrders, orders: account.orders.slice(0, 60), fills: account.fills.slice(0, 60), funding: account.funding.slice(0, 60),
      riskEvents: account.riskEvents.slice(0, 60), equity: account.equity, updatedAt: account.updatedAt } : null,
    versions, signals, equity: equity.reverse(), log,
    execution: a.mode === 'LIVE' && a.perp?.live
      ? { kind: 'live' as const, network: a.perp.live.network, note: `Orders are REAL orders on the Hyperliquid ${a.perp.live.network} account${a.perp.live.network === 'testnet' ? ' (test network: the money is not real)' : ' (real money)'}: signed by the isolated signer under the mandate, without a passkey, and confirmed by the venue's own records. Positions, fills, funding and equity are read from the venue.` }
      : { kind: 'paper' as const, note: 'Orders are simulated against the venue\'s live order book by the paper engine. Nothing is signed and no order reaches the venue.' },
    live: await liveBlock(a, rt(), true),
    rules: { markIndexBps: GATE.markIndexBps, lastCloseBps: GATE.lastCloseBps, leverageHeadroom: LEVERAGE_HEADROOM, capHeadroom: CAP_HEADROOM,
      simplifications: ['flat 2 % maintenance margin fraction', 'cross margin only', 'the liquidation price is a single-position estimate', 'a simulated liquidation closes the whole account at the mark',
        'fills walk the live book with no latency, no queue position and no market impact', 'funding is applied on the mark at the venue\'s funding times with the venue\'s published rate'] } };
}

/** Owner changes of state. PAPER needs an approved version and an account whose circuit breaker is not set. */
export async function perpMode(a: PerpAgentRow, mode: 'PAPER' | 'PAUSED' | 'STOPPED' | 'RESEARCH', actor = 'owner') {
  // V7: an agent that is on a venue account changes state through the live life cycle only (pause keeps positions; stop
  // revokes the mandate and closes them). It returns to simulation once it is STOPPED.
  if (isLiveActive(a)) {
    if (mode === 'PAUSED') return perpView(a.state === 'PAUSED' ? a : await pauseLive(a));
    if (mode === 'STOPPED') { await stopLive(a, rt(), 'en'); return perpView((await sql<PerpAgentRow[]>`select * from agents where id = ${a.id}`)[0]!); }
    throw new UserError('bad_state', 'this agent is on a venue account: stop it first (the mandate is revoked and its positions are closed), then return to simulation', 409);
  }
  if (mode === 'PAPER') {
    if (!a.strategy_version_id) throw new UserError('no_strategy', 'approve a strategy version first', 409);
    const acct = await paper().get(a.deriv_account_id);
    if (acct.policy.halt !== null) throw new UserError('halted', `the paper account is halted (${acct.policy.halt}); replace the limits and lift the halt, or reset the account in the Futures terminal`, 409);
    // V11.2: the unified order service executes an agent's order only under a trading mandate — the PAPER mandate of this agent,
    // created here by whoever starts it (the owner, or a key holding agents:manage inside its own limits). Nothing is signed.
    await (await import('./paper-mandate.ts')).ensurePaperMandate(a, actor);
  }
  // V11 (D11): RESEARCH is a mode, not a state — the agent goes back to its pre-trading state
  const state = mode === 'PAPER' ? 'PAPER_TRADING' : mode === 'RESEARCH' ? (a.strategy_version_id ? 'AWAITING_APPROVAL' : 'CREATED') : mode;
  const book: PerpBook = { ...(a.perp ?? {}) };
  if (mode === 'PAPER') { book.flatten = null; book.hold = null; }
  const [r] = await sql<PerpAgentRow[]>`update agents set state = ${state}, mode = ${mode === 'RESEARCH' ? 'RESEARCH' : 'PAPER'}, perp = ${sql.json(book as never)}, stop_reason = ${mode === 'STOPPED' ? `stopped by the ${actor}` : null}, updated_at = now() where id = ${a.id} returning *`;
  await audit('agent.mode', actor, { id: a.id, kind: 'perp', state });
  await sql`insert into research_log (agent_id, kind, title, mode, code) values (${a.id}, 'state', ${`${state === 'PAPER_TRADING' ? 'Paper trading started' : state === 'PAUSED' ? 'Paused' : state === 'STOPPED' ? 'Stopped' : 'Back to research'} by the ${actor}`}, ${mode === 'RESEARCH' ? 'RESEARCH' : 'PAPER'}, ${`state_${state.toLowerCase()}`})`.catch(() => {});
  return perpView(r!);
}

/** Approval of a perp version: the report must be a version-2 or version-3 report (version 3: with engine parity applied) for this hash and these instruments, with its integrity checks passing. */
export function assertPerpApprovable(a: PerpAgentRow, v: { code_sha256: string; report: unknown; meta: { kind?: string } }): void {
  if (v.meta?.kind !== 'perp') throw new UserError('wrong_kind', 'this version is not a perpetual-futures strategy', 409);
  const why = perpReportProblem(v.report, v.code_sha256, a.universe);
  if (why) throw new UserError('bad_report', why, 409);
}

export const registerPerp = (a: PerpAgentRow, rel: string) => registerPerpStrategy(a, rel, rt().lab);
export { perpLibrary };

const loadPerp = async (id: string): Promise<PerpAgentRow> => {
  if (!z.uuid().safeParse(id).success) throw new UserError('not_found', 'agent not found', 404);
  const [a] = await sql<PerpAgentRow[]>`select * from agents where id = ${id}`;
  if (!a || a.kind !== 'perp') throw new UserError('not_found', 'perp agent not found', 404);
  return a;
};

export function perpAgentRoutes(app: FastifyInstance, d?: Derivatives, l?: LiveService): void {
  // an injected derivatives instance or live engine (tests, the simulation scripts) gets its own runtime: same caches, same rate budget
  if (d || l) setPerpRuntime(createPerpRuntime(d ?? derivatives(), l ? { live: l } : {}));
  app.addHook('onClose', async () => { if (d || l) setPerpRuntime(null); });

  // what a perp agent can be built from: the venue, its instruments as the venue lists them now, the limits' bounds
  app.get('/api/v1/agents/perp/venues', async () => {
    const [list, tickers] = await Promise.all([data().instruments(PERP_VENUE), data().tickers(PERP_VENUE).catch(() => null)]);
    const instruments = list.value.map((i) => {
      const t = tickers?.value.find((x) => x.instrument === i.id);
      const why = !SYMBOL.test(i.symbol) ? 'ticker format not supported by the laboratory' : i.status !== 'active' ? `${i.status} on the venue` : !i.marginModes.includes('cross') ? 'isolated margin only' : null;
      return { symbol: i.symbol, id: i.id, maxLeverage: i.maxLeverage, lotSize: i.lotSize, minNotional: i.minNotional, mark: t?.mark ?? null, funding: t?.funding ?? null, volume24h: t?.volume24h ?? null, eligible: why === null, why };
    }).sort((x, y) => Number(y.volume24h ?? 0) - Number(x.volume24h ?? 0));
    return { venues: [{ id: PERP_VENUE, name: 'Hyperliquid', network: data().registry.get(PERP_VENUE).adapter.network, paper: true, instruments }], maxInstruments: MAX_PERP_INSTRUMENTS, intervals: PERP_INTERVALS,
      riskDefaults: PerpRisk.parse({}), minCapital: '50', live: (() => { const m = rt().live().config('en').mandateLive; return { available: m.available, reason: m.reason }; })(), ts: data().now() };
  });

  // the owner replaces the limits: the agent's own and the account's risk policy change together
  app.post('/api/v1/agents/:id/perp/risk', async (req) => {
    const a = await loadPerp((req.params as { id: string }).id);
    const b = z.strictObject({ risk: PerpRisk, liftHalt: z.boolean().default(false) }).parse(req.body);
    if (isLiveActive(a)) throw new UserError('bad_state', 'the limits of an agent that is on a venue account are those of its mandate: stop the agent, change the limits, then approve a new mandate', 409);
    if (b.risk.maxDailyLossPct > b.risk.maxTotalLossPct) throw new UserError('bad_request', 'the daily loss limit cannot exceed the total loss limit', 400);
    const acct = await paper().get(a.deriv_account_id);
    await paper().setPolicy(a.deriv_account_id, perpPolicy(a.universe, formatUnits(BigInt(a.capital_usdc), 6), b.risk, b.liftHalt ? null : acct.policy.halt));
    const [r] = await sql<PerpAgentRow[]>`update agents set risk = ${sql.json(b.risk as never)}, updated_at = now() where id = ${a.id} returning *`;
    await audit('agent.perp_risk', 'owner', { id: a.id, risk: b.risk, liftHalt: b.liftHalt });
    await (await import('../agent-runtime/store.ts')).bumpConfig(a.id, 'owner', 'risk limits replaced by the owner');   // V11: every change is a configuration version
    return perpView(r!);
  });

  // close every position of the agent's account with reduce-only orders (always possible, also when stopped or halted)
  app.post('/api/v1/agents/:id/perp/flatten', async (req) => {
    const a = await loadPerp((req.params as { id: string }).id), run = rt();
    if (a.mode === 'LIVE') throw new UserError('bad_state', 'this agent is (or was) on a venue account: "stop" closes its positions with reduce-only orders under the mandate; afterwards, close by hand in the Futures terminal with your passkey', 409);
    const f = await flattenPerp(a, run.deps, run.deps.executor(a), `m${Math.floor(run.deps.now() / 1000)}`);
    await audit('agent.perp_flatten', 'owner', { id: a.id, orders: f.results.length, left: f.left.length });
    return { orders: f.results, positionsLeft: f.left.length };
  });

  // >>> v7 perp agents LIVE — going live on a venue account under a signer-enforced mandate, and leaving it. No route places
  // an order. Pause, resume and stop need no passkey; going live needs exactly one (judged by the signer, not here).
  const param = (req: { params: unknown }) => loadPerp((req.params as { id: string }).id);
  /** the checklist: approved version · authorised venue account · funded · mandate — and the mandate that would be proposed */
  app.get('/api/v1/agents/:id/perp/live', async (req) => {
    const q = z.object({ account: z.uuid().optional(), locale: z.string().max(5).optional(), days: z.coerce.number().int().min(1).max(30).optional() }).parse(req.query);
    return liveReadiness(await param(req), rt(), { account: q.account, locale: liveLocale(q.locale), days: q.days });
  });
  // V11: the two mandate-writing functions live in mandate-write.ts, which only these owner routes import
  // V11.2: the Risk-screen way — the live trading mandate is CREATED from the agent's limits (nothing is approved); the owner
  // approves it in /risk?mandate=<id> with the passkey, then starts the agent live
  app.post('/api/v1/agents/:id/perp/live/mandate', async (req) => { const r = await (await import('./mandate-write.ts')).createLiveMandate(await param(req), rt(), LivePrepareBody.parse(req.body));
    return { mandateId: r.created.id, state: r.created.state, hash: r.created.hash, enforcement: r.created.enforcement, derived: r.created.derived, proposal: r.proposal, approval: { route: `/risk?mandate=${r.created.id}`, passkey: true } }; });
  app.post('/api/v1/agents/:id/perp/live/prepare', async (req) => (await import('./mandate-write.ts')).prepareLive(await param(req), rt(), LivePrepareBody.parse(req.body)));
  app.post('/api/v1/agents/:id/perp/live/approve', async (req) => perpDetail(await (await import('./mandate-write.ts')).approveLive(await param(req), rt(), LiveApproveBody.parse(req.body))));
  app.post('/api/v1/agents/:id/perp/live/pause', async (req) => perpDetail(await pauseLive(await param(req))));
  app.post('/api/v1/agents/:id/perp/live/resume', async (req) => perpDetail(await resumeLive(await param(req), rt())));
  app.post('/api/v1/agents/:id/perp/live/stop', async (req) => {
    const a = await param(req), b = z.strictObject({ locale: z.enum(['fr', 'en']).default('en') }).parse(req.body ?? {});
    const r = await stopLive(a, rt(), b.locale);
    return { ...(await perpDetail(await loadPerp(a.id))), windDown: r.windDown, result: r.result };
  });
  // <<< v7 perp agents LIVE
}

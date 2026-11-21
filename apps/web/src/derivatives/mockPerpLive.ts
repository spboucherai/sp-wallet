/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/mockPerpLive.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

/**
 * In-browser stand-in for the perp-agent routes (`/api/v1/agents*`) — DEVELOPMENT BUILDS ONLY (imported by `mock.ts` alone,
 * behind `import.meta.env.DEV`). ONE scripted perp agent on Hyperliquid BTC, 1 h, with an approved strategy version, whose
 * real mode runs on the venue accounts of `mockLive.ts`: readiness checklist, mandate preparation from the agent's risk
 * settings (the canonical mandate, its hash and its validity rules are the repository's own), one passkey, LIVE, pause, stop →
 * wind-down → reduce-only closes → STOPPED.
 *
 * What is simulated: the engine (a few scripted bars: one fill, one refusal by the simulated signer, one deferred order),
 * the venue (a paper account filled against the mock's book — play money whatever the network is called) and the signer.
 * Nothing here proves that the backend behaves the same way; shapes follow services/api/src/agents/perp-routes.ts.
 *
 * Test hooks: `window.__spwMock.perp` — see `PerpHooks`.
 */
import { D } from '../../../../packages/derivatives/src/decimal.ts';
import type { VenuePolicy } from '../../../../packages/derivatives/src/live/canonical.ts';
import type { createLiveMock } from './mockLive';

type Side = ReturnType<typeof createLiveMock>['agentSide'];
type Out = { status: number; json: any };
type Loc = 'fr' | 'en';
export interface PerpHooks {
  /** the scripted agent's id (the page is /agents/<id>) */ id: string;
  /**
   * `paper`: approved strategy, no venue account · `no_strategy`: nothing approved · `ready`: testnet account funded and
   * authorized · `small`: authorized but below the minimum equity · `live`: LIVE on testnet with a position, a refusal and a
   * deferred order · `mainnet_locked`: an authorized mainnet account, autonomous trading locked by the server setting
   */
  scenario: (name: 'paper' | 'no_strategy' | 'ready' | 'small' | 'live' | 'mainnet_locked') => void;
  /** keep the agent in STOPPING (the engine does not close yet) until released */ holdStop: (on: boolean) => void;
  /** the agent leaves LIVE for this reason (an exit code of the backend) */ exit: (code: string, reason: string) => void;
  state: () => { state: string; mode: string; accountId: string | null };
  /** the agent leaves LIVE without being able to close (the signer signs nothing any more): STOPPED, positions left open on the venue */ stopOpen: (code: string) => void;
}

const ID = '7e57a9e1-0000-4000-8000-000000000001', SV = '7e57a9e1-0000-4000-8000-0000000000a1', SHA = 'c0de5eed'.repeat(8), BTC = 'hyperliquid:BTC';
const RISK = { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };
const POLICY: VenuePolicy = { allowedInstruments: [BTC], maxLeverage: 3, maxOrderNotional: '1000', maxPositionNotional: '1000', maxGrossExposure: '1500', maxOrdersPerDay: 100, maxPriceDeviationBps: 1000 };
const ORDERS_PER_POSITION = 5, MIN_ORDER = '10.5', H = 3_600_000;
const d = (x: string) => D.from(x), cents = (x: ReturnType<typeof d>) => D.str(D.quantize(x, d('0.01'), 'down'));
class Refuse extends Error { status: number; code: string; constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; } }

export function createPerpMock(live: Side, env: { mark: (instrument: string) => string | null; lot: (instrument: string) => string; /** collateral the next venue account of a network starts with */ fund: (network: 'testnet' | 'mainnet', usdc: string) => void }) {
  const now = () => Date.now(), created = now() - 6 * 86_400_000;
  const A = {
    name: 'BTC momentum', mission: 'Suit la tendance du BTC sur barres d’une heure.', state: 'PAPER_TRADING', mode: 'PAPER' as 'PAPER' | 'LIVE', approved: true, stopReason: null as string | null, lastBar: null as number | null,
    live: null as null | { accountId: string; network: 'testnet' | 'mainnet'; mandateId: string; since: number; capital: string; exit: { ts: number; code: string; reason: string } | null },
    signals: [] as any[], log: [] as { ts: number; kind: string; title: string; body: string }[],
  };
  let HOLD_STOP = false, SEQ = 0;
  const log = (kind: string, title: string, body = '') => { A.log.unshift({ ts: now(), kind, title, body }); };
  const acct = () => (A.live ? live.get(A.live.accountId) ?? null : null);
  const active = () => A.mode === 'LIVE' && ['LIVE', 'PAUSED', 'STOPPING'].includes(A.state);
  const bar = (k = 0) => Math.floor(now() / H) * H - H - k * H;

  // ------------------------------------------------------------------ views (perp-routes.ts `perpView` / `perpDetail`)
  const view = () => ({ id: ID, kind: 'perp' as const, simulation: A.mode !== 'LIVE', name: A.name, mission: A.mission, state: A.state, mode: A.mode, venue: 'hyperliquid', network: 'hyperliquid', networkName: 'Hyperliquid', universe: ['BTC'],
    liveNetwork: A.mode === 'LIVE' ? A.live?.network ?? null : null, instruments: [BTC], cash: 'USDC', interval: '1h', risk: RISK, capitalUsdc: '1000', accountId: 'paper-of-agent', strategyVersionId: A.approved ? SV : null, mandateId: null, mandate: null, vaultAddress: '', holdings: null,
    flag: null, hold: null, flattening: null, lastBar: A.lastBar === null ? null : new Date(A.lastBar).toISOString(), stopReason: A.stopReason, createdAt: new Date(created).toISOString(), updatedAt: new Date(now()).toISOString() });
  const versions = () => [{ id: SV, name: 'ts_momentum_perp', version: '1', code_sha256: SHA, status: A.approved ? 'approved' : 'backtested', notes: '', created_at: new Date(created).toISOString(), approved_at: A.approved ? new Date(created + H).toISOString() : null,
    meta: { kind: 'perp', universe: ['BTC'], interval: '1h', lookback: 240, max_leverage: 2, max_gross_exposure: 2 },
    summary: { schemaVersion: 2, generatedAt: new Date(created).toISOString(), config: { symbols: ['BTC'], interval: '1h', bars: 4990, fee_bps: 4.5, slippage_bps: 3, liquidation_penalty_bps: 50 }, historyDays: 208, splits: null,
      metrics: { train: null, validation: null, test: { total_return: 0.031, sharpe: 0.84, max_drawdown: -0.062, worst_intrabar_drawdown: -0.081, trades: 61, liquidations: 0, wiped_out: false } },
      benchmarks: { buy_and_hold: { total_return: -0.04 }, perp_long_1x: { total_return: -0.047, sharpe: -0.3, max_drawdown: -0.19 } }, buyAndHoldIsSpot: false,
      robustness: { trials_tested: 9, deflated_sharpe: 0.21, bootstrap_sharpe_ci: [-0.4, 1.9] }, checks: { lookahead: 'pass', data_quality: 'pass', ledger: 'pass', funding_alignment: 'pass' }, liquidations: { train: 0, validation: 0, test: 0 }, problem: null } }];
  const paperAccount = () => ({ id: 'paper-of-agent', label: `Agent · ${A.name}`, state: { venue: 'hyperliquid', account: 'paper', equity: '1000', collateral: '1000', freeCollateral: '1000', marginUsed: '0', maintenanceMargin: '0', withdrawable: null, ts: now(), source: 'paper' },
    policy: { mode: 'PAPER', allowedInstruments: [BTC], halt: null, maxDataAgeMs: 10_000, maxDeviationBps: '200', maxMarkIndexBps: '100', maxLeverage: '2', maxOrderNotional: '1000', maxGrossExposure: '1500', maxPositionNotional: '1000', minFreeCollateral: '50',
      minLiquidationDistanceBps: '1000', maxDailyLoss: '30', maxTotalLoss: '100', maxOrdersPerMinute: 40, maxOrdersPerDay: 400 },
    settings: {}, totals: { realizedPnl: '0', feesPaid: '0', fundingNet: '0', liquidations: 0 }, initialCollateral: '1000', positions: [], openOrders: [], orders: [], fills: [], funding: [], riskEvents: [], equity: [], updatedAt: now() });
  const holds = () => A.signals.flatMap((s) => ((s.orders?.list ?? []) as any[]).filter((o) => o.status === 'refused' || o.status === 'deferred').map((o) => ({ ts: s.ts as number, bar: s.bar as string, symbol: o.symbol as string, code: o.code as string, reason: String(o.why ?? '') })));
  function detail() {
    const a = acct(), L = A.live;
    return { ...view(), account: paperAccount(), versions: versions(), signals: A.signals, equity: [], log: A.log,
      execution: A.mode === 'LIVE' && L ? { kind: 'live', network: L.network, note: 'Orders are placed on the venue account under the derivative mandate the owner approved; the isolated signer enforces its limits on every order.' }
        : { kind: 'paper', note: 'Orders are simulated against the venue\'s live order book by the paper engine. Nothing is signed and no order reaches the venue.' },
      live: { available: true, reason: null, active: active(), accountId: L?.accountId ?? null, network: L?.network ?? null, mandateId: L?.mandateId ?? null, strategySha256: L ? SHA : null, since: L?.since ?? null, capital: L?.capital ?? null,
        paused: A.mode === 'LIVE' && A.state === 'PAUSED', exit: L?.exit ?? null, account: a ? live.detail(a) : null, signer: a ? live.mandateStatus(a).signer : null, holds: holds() },
      rules: { markIndexBps: 100, lastCloseBps: 1000, leverageHeadroom: '0.9', capHeadroom: '0.02', simplifications: [] } };
  }

  // ------------------------------------------------------------------ readiness and the mandate derived from the agent's limits
  function readiness(accountId: string | null, locale: Loc, wantDays?: number) {
    const all = live.accounts(), cfg = live.config(locale);
    const pick = all.find((x) => x.id === accountId) ?? (A.live ? all.find((x) => x.id === A.live!.accountId) : undefined) ?? all.find((x) => x.network === 'testnet') ?? all[0];
    const accounts = all.map((x) => { const s = live.summary(x), v = x === pick ? live.venueState(x) : null; return { id: x.id, network: x.network, label: x.label, account: x.account, mode: x.mode, modes: s.modes, tradable: s.tradable,
      authorization: s.authorization ? { active: s.authorization.active, expiresAt: s.authorization.expiresAt } : null, mandate: s.mandate ? { id: s.mandate.id, phase: s.mandate.phase, agentId: s.mandate.agentId } : null,
      usedBy: s.mandate && s.mandate.phase !== 'ended' ? { agentId: s.mandate.agentId, name: s.mandate.agentId === ID ? A.name : s.mandate.agentId } : null, equity: v?.state?.equity ?? null, error: v?.error ?? null }; });   // read on the venue for the selected account only
    const a = pick;
    const sum = a ? live.summary(a) : null, vs = a ? live.venueState(a) : null, nowMs = now();
    const strategy = { ok: A.approved, versionId: A.approved ? SV : null, sha256: A.approved ? SHA : null, name: A.approved ? 'ts_momentum_perp' : null, version: A.approved ? '1' : null, reason: A.approved ? null : 'no strategy version is approved for this agent' };
    const auth = sum?.authorization ?? null, maxDays = auth ? Math.min(30, Math.floor((auth.expiresAt - nowMs - 86_400_000) / 86_400_000)) : 0;
    const missing = auth ? [BTC].filter((i) => !auth.policy.allowedInstruments.includes(i)) : [];
    let code: string | null = null, reason: string | null = null;
    if (!a || !sum) { code = 'no_account'; reason = 'no venue account exists yet: create and authorise one in Futures → Accounts'; }
    else if (a.network === 'mainnet' && !live.mainnet()) { code = 'mainnet_disabled'; reason = cfg.reasons.mainnet_disabled[locale]; }
    else if (a.mode !== 'MANUAL_LIVE' || !auth) { code = 'read_only'; reason = 'this venue account is read-only: authorise live trading on it with your passkey (Futures → Accounts)'; }
    else if (auth.expired) { code = 'authorization_expired'; reason = 'the venue authorization has expired: approve a new one'; }
    else if (maxDays < 1) { code = 'authorization_too_short'; reason = 'the venue authorization expires in less than 48 hours: a mandate must end at least 24 hours before it, so that positions can be closed during the wind-down'; }
    else if (missing.length) { code = 'instruments_not_allowed'; reason = `the venue authorization does not allow ${missing.join(', ')}`; }
    else if (sum.mandate && sum.mandate.phase === 'active' && sum.mandate.agentId !== ID) { code = 'used_by_other_agent'; reason = 'another agent already trades this venue account'; }
    else if (sum.mandate && sum.mandate.phase === 'active' && !active()) { code = 'mandate_exists'; reason = 'a mandate is already active on this venue account: revoke it in Futures → Accounts'; }
    else if (!active() && vs && !vs.error && (vs.positions.length > 0 || vs.openOrders.length > 0)) { code = 'account_not_flat'; reason = 'the venue account already holds positions or resting orders: an agent starts on a flat account — close or cancel them in the Futures terminal'; }
    const account = { ok: code === null, code, reason, network: a?.network ?? null, authorization: auth ? { active: auth.active, expiresAt: auth.expiresAt, maxMandateDays: Math.max(0, maxDays) } : null, instrumentsMissing: missing };
    const minEquity = D.str(D.max(d('50'), D.quantize(D.div(D.mul(d(String(ORDERS_PER_POSITION)), d(MIN_ORDER)), d(String(RISK.maxGrossExposureX)), 2, 'up'), d('1'), 'up')));
    const equity = vs?.state?.equity ?? null, never = !!a && !a.venue;
    const capital = equity ? cents(d(equity)) : '0', floor = cents(D.mul(d(capital), d(String(1 - RISK.maxTotalLossPct / 100))));
    let fcode: string | null = null, freason: string | null = null;
    if (!a) { fcode = 'no_account'; freason = 'no venue account'; }
    else if (vs?.error) { fcode = 'venue_unreadable'; freason = vs.error; }
    else if (never || !equity || D.isZero(d(equity))) { fcode = 'unfunded'; freason = 'the venue account never received a deposit: the venue refuses every action of such an account ("Must deposit before performing actions")'; }
    else if (D.lt(d(equity), d(minEquity))) { fcode = 'below_minimum'; freason = `account value ${equity} USDC is below the ${minEquity} USDC this agent needs`; }
    const funded = { ok: fcode === null, code: fcode, equity, minEquity, basis: { instruments: [{ instrument: BTC, minOrder: MIN_ORDER }], ordersPerPosition: ORDERS_PER_POSITION, grossX: RISK.maxGrossExposureX, floor }, reason: freason };
    const lockErr = a ? live.mandateLock(a) : null;
    const lock = lockErr ? { code: lockErr.code, reason: (cfg.reasons as Record<string, Record<Loc, string>>)[lockErr.code]?.[locale] ?? lockErr.message } : null;
    const mine = sum?.mandate && sum.mandate.agentId === ID ? sum.mandate : null;
    const mandate = { ok: !!mine && mine.phase === 'active' && A.state === 'LIVE', phase: mine?.phase ?? null, mandateId: mine?.id ?? null, lock };
    const next = !strategy.ok ? 'strategy' : !account.ok ? 'account' : !funded.ok ? 'fund' : lock ? 'locked' : mandate.ok || active() ? 'live' : 'mandate';
    return { agentId: ID, locale, config: cfg, accounts, accountId: a?.id ?? null, steps: { strategy, account, funded, mandate }, next,
      proposal: strategy.ok && account.ok && funded.ok && auth ? proposal(auth.policy, capital, maxDays, wantDays && wantDays >= 1 ? Math.min(wantDays, maxDays) : undefined) : null, ts: nowMs };
  }
  function proposal(p: VenuePolicy, capital: string, maxDays: number, days = Math.min(30, maxDays)) {
    const c = d(capital), min = (x: string, y: string) => D.str(D.min(d(x), d(y))), notes: string[] = [];
    const wantPos = cents(D.mul(c, d(String(RISK.maxPositionX)))), wantGross = cents(D.mul(c, d(String(RISK.maxGrossExposureX))));
    const pos = min(wantPos, p.maxPositionNotional), gross = min(wantGross, p.maxGrossExposure), order = min(pos, p.maxOrderNotional), lev = Math.min(RISK.maxLeverage, p.maxLeverage);
    if (pos !== wantPos || gross !== wantGross || order !== pos || lev !== RISK.maxLeverage) notes.push('some limits are lower than the agent\'s own because the venue authorization is tighter: a mandate can never be wider than its authorization');
    const perDay = Math.min(p.maxOrdersPerDay, Math.max(10, 2 * 24)), perHour = Math.min(perDay, 60, Math.max(4, 2)), turnover = cents(D.mul(d(gross), d('4')));
    const floorEquity = cents(D.mul(c, d(String(1 - RISK.maxTotalLossPct / 100))));
    const body = { instruments: [{ instrument: BTC, maxLeverage: lev, maxPositionNotional: pos }], maxOrderNotional: order, maxGrossExposure: gross, maxDailyTurnover: turnover, floorEquity, maxOrdersPerDay: perDay, maxOrdersPerHour: perHour,
      maxPriceDeviationBps: p.maxPriceDeviationBps, days, strategySha256: SHA, agentId: ID };
    const derived = [
      { field: 'instruments', value: 'BTC', from: 'the agent\'s instruments' },
      { field: 'maxLeverage', value: `${lev}`, from: `the agent's maximum leverage (${RISK.maxLeverage}x), never above the authorization's` },
      { field: 'maxPositionNotional', value: pos, from: `${RISK.maxPositionX} x the allocated capital (${capital} USDC)` },
      { field: 'maxOrderNotional', value: order, from: 'the position limit: one order can close a whole position' },
      { field: 'maxGrossExposure', value: gross, from: `${RISK.maxGrossExposureX} x the allocated capital` },
      { field: 'maxDailyTurnover', value: turnover, from: '4 x the gross exposure limit per UTC day' },
      { field: 'floorEquity', value: floorEquity, from: `the allocated capital less the total-loss limit (${RISK.maxTotalLossPct} %)` },
      { field: 'maxOrdersPerDay', value: `${perDay}`, from: 'two orders per instrument and closed bar (1 h bars)' },
      { field: 'maxOrdersPerHour', value: `${perHour}`, from: 'two orders per instrument and bar, at least 4' },
      { field: 'maxPriceDeviationBps', value: `${p.maxPriceDeviationBps}`, from: 'the price band of the venue authorization' },
      { field: 'days', value: `${days}`, from: `at most 30 days, and ending at least 24 h before the authorization expires (at most ${maxDays} days here)` },
    ];
    return { capital, days, maxDays, body, derived, notes };
  }
  function need(accountId: unknown, locale: Loc) {
    const r = readiness(typeof accountId === 'string' ? accountId : null, locale), a = r.accountId ? live.get(r.accountId) : undefined;
    for (const k of ['strategy', 'account', 'funded'] as const) if (!r.steps[k].ok) throw new Refuse('not_ready', `not ready to go live — ${k}: ${r.steps[k].reason}`, 409);
    if (!a || a.id !== accountId) throw new Refuse('not_ready', 'not ready to go live — account: choose a venue account', 409);
    return { r, a };
  }

  // ------------------------------------------------------------------ the scripted engine
  const size = (usd: string) => { const mark = env.mark(BTC) ?? '70000'; return D.str(D.quantize(D.div(d(usd), d(mark), 12, 'down'), d(env.lot(BTC)), 'down')); };
  function trade(side: 'buy' | 'sell', sz: string, reduceOnly: boolean, k: number, reasonText: string) {
    const a = acct()!, clientId = `ag-${ID}-${SHA.slice(0, 8)}-${Math.floor(bar(k) / 1000)}-BTC-${reduceOnly ? 'r' : 'o'}${SEQ++ ? `-${SEQ}` : ''}`;
    const base = { symbol: 'BTC', side, size: sz, reduceOnly, reason: reasonText, clientId };
    try { const o = live.placeMandate(a, { instrument: BTC, side, size: sz, reduceOnly, clientId, slippageBps: RISK.slippageBps });
      return { ...base, status: o.state === 'filled' ? 'filled' : o.state, filled: o.filled, avgFillPrice: o.avgFillPrice, worstPrice: o.price, why: o.reason, idempotent: false }; }
    catch (e) { const x = e as Refuse; return { ...base, status: 'refused', code: x.code ?? 'error', why: x.message }; }
  }
  const signal = (k: number, weight: number, list: any[], targets: string) => { A.signals.unshift({ ts: bar(k) + H + 20_000, bar: new Date(bar(k)).toISOString(), status: 'done', reason: '', strategy_sha256: SHA, weights: { BTC: weight }, scaled: { BTC: String(weight) }, scale: '1',
    equity: A.live?.capital ?? '1000', targets: { BTC: targets }, orders: { binding: 'none', threshold: '20', slippageBps: RISK.slippageBps, list }, updated_at: new Date(now()).toISOString() }); A.lastBar = bar(k); };
  /** what the engine did since the mandate: a long, then a bar the signer held, then an order waiting for the signer's 40 s over-count */
  function script() {
    const a = acct()!, cap = A.live!.capital, first = size(D.str(D.mul(d(cap), d('0.5'))));
    signal(2, 0.5, [trade('buy', first, false, 2, 'open long')], first);
    const more = size(D.str(D.mul(d(cap), d('0.6'))));
    signal(1, 1.1, [trade('buy', more, false, 1, 'increase toward target')], D.str(D.add(d(first), d(more))));
    const small = size(D.str(D.mul(d(cap), d('0.2'))));
    signal(0, 0.7, [{ symbol: 'BTC', side: 'buy', size: small, reduceOnly: false, reason: 'increase toward target', status: 'deferred', code: 'live_cooldown',
      why: 'an order of this account reached the signer less than 45 s ago: the signer still counts it twice, so the next order that adds exposure waits for the next pass' }], D.str(D.add(d(first), d(small))));
    A.signals[0].status = 'decided';
    if (a.venue) { a.venue.applyFunding('0.0000125', now() - 1000, BTC); const t0 = Math.floor(now() / 60_000) * 60_000, st = a.venue.accountState(now());
      a.equity = [...Array.from({ length: 5 }, (_, i) => ({ ts: t0 - (5 - i) * 60_000, equity: cap, collateral: cap, marginUsed: '0', unrealizedPnl: '0', source: 'venue' as const })),
        { ts: t0, equity: st.equity, collateral: st.collateral, marginUsed: st.marginUsed, unrealizedPnl: D.str(D.sub(d(st.equity), d(st.collateral))), source: 'venue' as const }]; }
  }
  function leave(code: string, reason: string, locale: Loc = 'en') {
    const a = acct();
    let windDown: unknown = null;
    if (a?.mandate) { const r = live.revokeMandate(a, { cancelOpenOrders: true, locale }); windDown = r.windDown; }
    if (A.live) A.live.exit = { ts: now(), code, reason };
    A.state = 'STOPPING'; log('risk', 'Leaving LIVE', reason);
    return windDown;
  }
  /** one engine pass of a stopping agent: reduce-only closes, then STOPPED */
  function step() {
    if (A.state !== 'STOPPING' || HOLD_STOP) return;
    const a = acct(), L = A.live; if (!a || !L) { A.state = 'STOPPED'; return; }
    const results = live.venueState(a).positions.map((p) => trade(p.side === 'long' ? 'sell' : 'buy', p.size, true, 0, 'leaving LIVE: close'));
    if (results.length) log('risk', 'Reduce-only closing orders', results.map((r) => `${r.symbol} ${r.side} ${r.size} → ${r.status}`).join('\n'));
    const left = live.venueState(a).positions.length;
    if (left) return;
    A.state = 'STOPPED'; A.stopReason = `${L.exit?.reason ?? 'stopped'}; ${results.length ? 'every position was closed with reduce-only orders' : 'no position was open'}`;
    log('stop', 'Agent stopped', A.stopReason);
  }

  function reset() { for (const a of live.accounts()) if (a.mandate && a.mandate.revokedAt === null) a.mandate.revokedAt = now() - 2 * 86_400_000; Object.assign(A, { state: 'PAPER_TRADING', mode: 'PAPER', approved: true, stopReason: null, lastBar: null, live: null, signals: [], log: [] }); HOLD_STOP = false; }
  function goLive(a: NonNullable<ReturnType<Side['get']>>, capital: string) {
    A.live = { accountId: a.id, network: a.network, mandateId: a.mandate!.mandate.mandateId, since: now(), capital, exit: null };
    A.state = 'LIVE'; A.mode = 'LIVE'; A.stopReason = null; A.signals = [];
    // the engine sets the venue's leverage to the agent's before its first order (one leverage change, counted by the signer)
    a.leverage[BTC] = { leverage: String(RISK.maxLeverage), marginMode: 'cross' }; if (a.venue) a.venue.state.config.leverageByInstrument[BTC] = String(RISK.maxLeverage); if (a.mstats) a.mstats.leverage = 1;
    log('live', 'Agent is LIVE', `mandate ${a.mandate!.mandate.mandateId} on the ${a.network} venue account; strategy ${SHA.slice(0, 12)}…`);
    script();
  }
  const hooks: PerpHooks = {
    id: ID,
    scenario(name) {
      reset();
      if (name === 'no_strategy') { A.approved = false; A.state = 'CREATED'; return; }
      if (name === 'paper') return;
      if (name === 'small') { env.fund('testnet', '20'); live.force('testnet', POLICY); env.fund('testnet', '1000'); return; }   // on a fresh page: the account is created with 20 USDC
      if (name === 'mainnet_locked') { live.force('mainnet', { ...POLICY, maxPriceDeviationBps: 200 }); return; }
      const a = live.force('testnet', POLICY);
      if (name === 'live') {
        const r = readiness(a.id, 'fr'), p = live.prepareMandate(a, { ...r.proposal!.body, locale: 'fr' });
        a.pendingMandate = null; a.mandate = { mandate: p.mandate, hash: p.hash, approvedAt: now(), revokedAt: null }; a.mstats = { orders: 0, reduceOnly: 0, cancels: 0, leverage: 1, turnover: '0', stamps: [] };
        goLive(a, r.proposal!.capital);
      }
    },
    holdStop: (on) => { HOLD_STOP = on; },
    exit: (code, reason) => { if (active()) leave(code, reason); },
    state: () => ({ state: A.state, mode: A.mode, accountId: A.live?.accountId ?? null }),
    stopOpen: (code) => { if (!active()) return; const a = acct()!; HOLD_STOP = true; leave(code, 'the signer no longer signs for this mandate');
      const left = live.venueState(a).positions.map((p) => `${p.side} ${p.size} ${p.instrument.slice(p.instrument.indexOf(':') + 1)}`);
      A.state = 'STOPPED'; A.stopReason = `the signer no longer signs for this mandate; ${left.length} position(s) REMAIN OPEN on the venue account (${left.join(', ')}) and the signer no longer signs for this mandate: close them in the Futures terminal with your passkey`;
      log('stop', 'Agent stopped', A.stopReason); },
  };

  // ------------------------------------------------------------------ HTTP
  function handle(method: string, path: string, b: any, q: URLSearchParams): Out {
    const ok = (json: unknown): Out => ({ status: 200, json }), locale: Loc = (q.get('locale') ?? b?.locale) === 'fr' ? 'fr' : 'en';
    if (path === '/strategies') return ok({ strategies: [] });
    if (path === '/agents' && method === 'GET') return ok({ agents: [view()] });
    if (path === '/agents/networks') return ok({ networks: [], maxSymbols: 12, maxLiveSymbols: 11 });
    if (path === '/agents/perp/venues') return ok({ venues: [{ id: 'hyperliquid', name: 'Hyperliquid', network: 'mainnet', paper: true, instruments: [{ symbol: 'BTC', id: BTC, maxLeverage: '40', lotSize: env.lot(BTC), minNotional: '10', mark: env.mark(BTC), funding: null, volume24h: null, eligible: true, why: null }] }],
      maxInstruments: 8, intervals: ['1h', '4h'], riskDefaults: RISK, minCapital: '50', live: { available: true, reason: null }, ts: now() });
    const m = /^\/agents\/([^/]+)(\/.*)?$/.exec(path);
    if (!m || m[1] !== ID) throw new Refuse('not_found', 'agent not found (mock mode simulates one perp agent)', 404);
    const rest = m[2] ?? '';
    if (rest === '' && method === 'GET') return ok(detail());
    if (rest === '/perp/live' && method === 'GET') return ok(readiness(q.get('account'), locale, Number(q.get('days')) || undefined));
    if (rest === '/perp/live/prepare') {
      if (active()) throw new Refuse('bad_state', 'this agent is already live', 409);
      const { r, a } = need(b.accountId, locale), lock = live.mandateLock(a); if (lock) throw lock;
      // the body is strict: { accountId, days?, locale } — the reference capital is always the venue account value at preparation
      if (Object.keys(b).some((k) => !['accountId', 'days', 'locale'].includes(k)) || (b.days !== undefined && (!Number.isInteger(b.days) || b.days < 1 || b.days > 30))) throw new Refuse('bad_request', 'invalid body', 400);
      const days = b.days === undefined ? r.proposal!.days : Math.min(b.days, r.proposal!.maxDays), auth = live.summary(a).authorization!;
      const prop = proposal(auth.policy, r.proposal!.capital, r.proposal!.maxDays, days);
      return ok({ ...live.prepareMandate(a, { ...prop.body, locale }), proposal: prop });
    }
    if (rest === '/perp/live/approve') {
      const { a } = need(b.accountId, locale), pending = a.pendingMandate;
      if (!pending) throw new Refuse('bad_state', 'prepare the mandate first', 409);
      const floor = pending.mandate.floorEquity, capital = cents(D.div(d(floor), d(String(1 - RISK.maxTotalLossPct / 100)), 6, 'half_even'));
      live.approveMandate(a, b); goLive(a, capital);
      return ok(detail());
    }
    if (rest === '/perp/live/pause') { if (A.mode !== 'LIVE' || A.state !== 'LIVE') throw new Refuse('bad_state', 'the agent is not live', 409); A.state = 'PAUSED'; log('pause', 'Paused by the owner', 'no new exposure; positions are kept; the loss limits are still watched'); return ok(detail()); }
    if (rest === '/perp/live/resume') { if (A.mode !== 'LIVE' || A.state !== 'PAUSED') throw new Refuse('bad_state', 'the agent is not paused', 409); A.state = 'LIVE'; log('resume', 'Resumed by the owner'); return ok(detail()); }
    if (rest === '/perp/live/stop') { if (!active()) throw new Refuse('bad_state', 'the agent is not live', 409);
      const windDown = A.state === 'STOPPING' ? null : leave('owner_stop', 'stopped by the owner', locale); step(); const left = acct() ? live.venueState(acct()!).positions : [];
      return ok({ ...detail(), windDown, result: A.state === 'STOPPED' ? 'stopped' : `stopping: ${left.length} position(s) still open (${left.map((p) => `${p.side} ${p.size} ${p.instrument.slice(p.instrument.indexOf(':') + 1)}`).join(', ')})` }); }
    if (rest === '/mode') {
      if (active()) { if (b.mode === 'STOPPED') { leave('owner_stop', 'stopped by the owner', locale); step(); return ok(view()); } throw new Refuse('bad_state', 'stop the live agent first', 409); }
      if (b.mode === 'PAPER' && !A.approved) throw new Refuse('no_strategy', 'approve a strategy version first', 409);
      A.state = b.mode === 'PAPER' ? 'PAPER_TRADING' : String(b.mode); A.mode = 'PAPER'; A.stopReason = b.mode === 'STOPPED' ? 'stopped by the owner' : null; return ok(view());
    }
    if (/^\/strategies\/[^/]+\/approve$/.test(rest)) { A.approved = true; if (['CREATED', 'AWAITING_APPROVAL'].includes(A.state)) A.state = 'AWAITING_APPROVAL'; return ok(view()); }
    if (rest === '/perp/flatten' || rest === '/perp/risk') { if (A.mode === 'LIVE') throw new Refuse('bad_state', 'the agent is on a venue account: its limits are the mandate\'s; stop it first', 409); return ok(rest === '/perp/risk' ? view() : { orders: [], positionsLeft: 0 }); }
    throw new Refuse('not_found', 'unknown route', 404);
  }
  return {
    hooks, step,
    handles: (path: string) => path === '/strategies' || path === '/agents' || path.startsWith('/agents/'),
    route(method: string, path: string, b: any, q: URLSearchParams): Out {
      try { return handle(method, path, b, q); }
      catch (e) { const x = e as { code?: string; status?: number; message?: string }; if (typeof x?.code === 'string' && typeof x?.status === 'number') return { status: x.status, json: { error: x.code, message: x.message } }; throw e; }
    },
  };
}

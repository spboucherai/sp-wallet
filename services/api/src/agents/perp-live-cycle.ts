/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-live-cycle.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// Perp agents, LIVE (V7): the life cycle that connects an approved perpetual-futures strategy to a real venue account under a
// derivative mandate enforced by the isolated signer (docs/v6/DERIVATIVE-MANDATE.md), and takes it out again.
//
//   PAPER ──(readiness: approved version · authorised venue account · funded · mandate approved with ONE passkey)──▶ LIVE
//   LIVE ──pause──▶ PAUSED (no new exposure, positions kept, loss limits and stop conditions still watched) ──resume──▶ LIVE
//   LIVE | PAUSED ──(owner stop · mandate revoked/expired · authorization gone · server lock · halt · divergence · manual
//                    order · liquidation · loss limit · a signer refusal that says the mandate is over)──▶ STOPPING
//   STOPPING: the mandate is revoked on the signer at once (no passkey: nothing that adds exposure is signed any more), then
//             the engine closes the positions with reduce-only orders while the signer's wind-down allows it ──▶ STOPPED
//             (flat, or — when nothing can be signed any more — with the positions that remain named in the stop reason).
//
// Nothing here widens anything: the mandate is DERIVED from the agent's risk settings and clamped to the venue authorization the
// owner approved; the signer checks it again at approval and on every order. There is no route that places an order: orders
// come from the engine pass only (perp-engine.ts through perp-exec-live.ts through derivatives/mandate.ts).
// Mainnet: prepare/approve/place answer 403 unless SPW_DERIV_LIVE_MAINNET=on AND SPW_DERIV_MANDATE_MAINNET=on (read by the live
// module at every use). This file never reads or sets either.
import { z } from 'zod';
import { D, type DecStr, type Position } from '@spw/derivatives';
import { hlPinnedAsset, VENUE_MANDATE_BOUNDS, VENUE_MANDATE_WIND_DOWN_S } from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import type { LiveService } from '../derivatives/exec.ts';
import { liveReason, liveTexts, type LiveLocale, type LiveReasonCode } from '../derivatives/live-texts.ts';
import { mandateAccountState, mandateOrder, type MandateAccountState } from '../derivatives/mandate.ts';
import { PERP_STEP_MS, type PerpInterval } from './perp-data.ts';
import { flattenPerp, instrumentId, tickPerpAgent, type PerpAgentRow, type PerpEngineDeps, type PerpLiveBook } from './perp-engine.ts';
import { LIVE_EXIT_CODES, LivePerpExecutor } from './perp-exec-live.ts';
import { executionBound } from './execution-bind.ts';
import { liveOrderResult } from './perp-gateway.ts';

/** what the engine needs from the runtime (perp-live.ts builds it; tests and the simulation script build their own) */
export interface PerpLiveRuntime { deps: PerpEngineDeps; live: () => LiveService }

export const LIVE_ACTIVE_STATES = ['LIVE', 'PAUSED', 'STOPPING'] as const;
/** the agent is on a venue account right now (trading, paused, or closing during the wind-down) */
export const isLiveActive = (a: Pick<PerpAgentRow, 'mode' | 'state'>): boolean => a.mode === 'LIVE' && (LIVE_ACTIVE_STATES as readonly string[]).includes(a.state);

/** funding minimum: every instrument must be able to hold this many minimum orders when the gross limit is split equally */
export const MIN_ORDERS_PER_POSITION = 5;
/** … and never less than this (the venue's minimum order is 10 USD) */
export const MIN_LIVE_EQUITY = '50';
/** an order must clear the venue's minimum notional by this factor (the engine's own rule, perp-engine.ts) */
const MIN_ORDER_FACTOR = '1.05';
/** daily turnover of the mandate, as a multiple of its gross exposure limit */
export const TURNOVER_X = 4;
/** after a refused closing attempt during the wind-down, the next one waits this long */
const CLOSE_RETRY_MS = 5 * 60_000;
const CENT = D.from('0.01'), HUNDRED = D.from(100n);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 240);
const numDec = (n: number, dp = 4) => D.from(n.toFixed(dp));
export const log = (a: { id: string }, kind: string, title: string, body = '', data?: unknown) => sql`insert into research_log (agent_id, kind, title, body, data) values (${a.id}, ${kind}, ${title}, ${body.slice(0, 2000)}, ${data === undefined ? null : sql.json(data as never)})`;
const reload = async (id: string): Promise<PerpAgentRow> => (await sql<PerpAgentRow[]>`select * from agents where id = ${id}`)[0]!;
const setLive = (id: string, live: PerpLiveBook | null) => sql`update agents set perp = perp || ${sql.json({ live } as never)}, updated_at = now() where id = ${id}`;
const symbolOf = (instrument: string): string => instrument.slice(instrument.indexOf(':') + 1);

/** why the agent left LIVE, in plain words (English; the UI has its own sentence per code) */
export const EXIT_TEXT: Record<string, string> = {
  owner_stop: 'stopped by the owner',
  mandate_revoked: 'the mandate was revoked',
  mandate_expired: 'the mandate has expired',
  mandate_ended: 'the mandate is no longer in force on the venue account',
  authorization_ended: 'the venue authorization was revoked or has expired',
  mainnet_disabled: 'live trading on mainnet is switched off on the server',
  mandate_mainnet_disabled: 'autonomous (mandate) trading on mainnet is switched off on the server',
  halted: 'trading was halted on the venue account',
  divergence: 'the venue\'s state and the wallet\'s records differ (an order or a position the wallet did not create)',
  manual_order: 'a manual order was placed on the venue account while the agent was live',
  liquidation: 'the venue liquidated a position of the account',
  strategy_changed: 'the approved strategy version is no longer the one pinned in the mandate',
  loss_limit: 'a loss limit of the agent was reached',
  engine_stop: 'the engine stopped the agent',
  signer_revoked: 'the signer reports the mandate as revoked',
  signer_expired: 'the signer reports the mandate as expired',
  signer_wind_down: 'the signer only signs reduce-only orders for this mandate (wind-down)',
  signer_no_authorization: 'the signer no longer holds the venue authorization',
  signer_not_found: 'the signer does not know this mandate',
  signer_halted: 'the signer\'s emergency halt is active',
};
const exitText = (code: string, detail = ''): string => `${EXIT_TEXT[code] ?? `the mandate no longer allows trading (${code})`}${detail ? ` — ${detail}` : ''}`;

// ------------------------------------------------------------------ readiness and the mandate derived from the agent's limits

type Summary = Awaited<ReturnType<LiveService['list']>>[number];
interface Version { id: string; name: string; version: string; code_sha256: string; status: string; meta: { kind?: string } | null }

export async function approvedVersion(a: PerpAgentRow): Promise<Version | null> {
  if (!a.strategy_version_id) return null;
  const [v] = await sql<Version[]>`select id, name, version, code_sha256, status, meta from strategy_versions where id = ${a.strategy_version_id}`;
  return v && v.status === 'approved' && v.meta?.kind === 'perp' ? v : null;
}

/** the smallest account value on which the agent's orders make sense, and why */
async function minimumEquity(a: PerpAgentRow, svc: LiveService, network: string) {
  const venue = svc.deps.venues.get(network), instruments: { instrument: string; minOrder: DecStr }[] = [];
  let largest = D.zero;
  for (const s of a.universe) {
    const inst = await venue.instrument(instrumentId(s)), min = D.mul(D.from(inst.minNotional ?? '10'), D.from(MIN_ORDER_FACTOR));
    instruments.push({ instrument: inst.id, minOrder: D.str(min) }); largest = D.max(largest, min);
  }
  // gross exposure the engine may reach, as a multiple of equity: the tighter of the gross limit and 0.9 × leverage
  const grossX = Math.min(a.risk.maxGrossExposureX, a.risk.maxLeverage * 0.9);
  const need = D.div(D.mul(D.mul(D.from(BigInt(MIN_ORDERS_PER_POSITION)), D.from(BigInt(a.universe.length))), largest), numDec(grossX), 2, 'up');
  return { minEquity: D.str(D.quantize(D.max(D.from(MIN_LIVE_EQUITY), need), D.one, 'up')), basis: { instruments, ordersPerPosition: MIN_ORDERS_PER_POSITION, grossX, floor: MIN_LIVE_EQUITY } };
}

export interface LiveProposal {
  capital: DecStr; days: number; maxDays: number;
  body: { instruments: { instrument: string; maxLeverage: number; maxPositionNotional: DecStr }[]; maxOrderNotional: DecStr; maxGrossExposure: DecStr; maxDailyTurnover: DecStr; floorEquity: DecStr;
    maxOrdersPerDay: number; maxOrdersPerHour: number; days: number; strategySha256: string; agentId: string };
  derived: { field: string; value: string; from: string }[]; notes: string[];
}

/**
 * The mandate of a live agent, DERIVED from its risk settings and the account value, then clamped to the venue authorization
 * (a mandate can never be wider than the authorization; the signer checks it again). Pure.
 */
export function deriveMandate(a: Pick<PerpAgentRow, 'id' | 'universe' | 'interval' | 'risk'>, sha256: string, network: 'testnet' | 'mainnet', equity: DecStr,
  auth: { expiresAt: number; policy: { maxLeverage: number; maxOrderNotional: DecStr; maxPositionNotional: DecStr; maxGrossExposure: DecStr; maxOrdersPerDay: number } }, nowMs: number, days?: number): LiveProposal {
  const r = a.risk, C = D.quantize(D.from(equity), CENT, 'down'), p = auth.policy, notes: string[] = [];
  const usd = (x: ReturnType<typeof D.from>): DecStr => D.str(D.quantize(x, CENT, 'down'));
  const clamp = (name: string, wanted: ReturnType<typeof D.from>, limit: DecStr): ReturnType<typeof D.from> => {
    if (D.lte(wanted, D.from(limit))) return wanted;
    notes.push(`${name}: ${usd(wanted)} from the agent's limits, lowered to the venue authorization's ${D.str(D.from(limit))}`);
    return D.from(limit);
  };
  const gross = clamp('gross exposure', D.mul(C, numDec(r.maxGrossExposureX)), p.maxGrossExposure);
  const position = D.min(clamp('position per instrument', D.mul(C, numDec(r.maxPositionX)), p.maxPositionNotional), gross);
  const order = clamp('notional per order', position, p.maxOrderNotional);
  const instruments = a.universe.map((s) => {
    const id = instrumentId(s), pin = hlPinnedAsset(network, id);
    return { instrument: id, maxLeverage: Math.max(1, Math.min(r.maxLeverage, p.maxLeverage, pin?.maxLeverage ?? 1)), maxPositionNotional: usd(position) };
  });
  const barsPerDay = Math.round(86_400_000 / PERP_STEP_MS[a.interval as PerpInterval]), n = a.universe.length;
  const perDay = Math.min(500, p.maxOrdersPerDay, Math.max(12, 2 * n * barsPerDay));
  const perHour = Math.min(VENUE_MANDATE_BOUNDS.maxOrdersPerHour, perDay, Math.max(4, 2 * n));
  const turnover = D.max(order, D.mul(gross, D.from(BigInt(TURNOVER_X))));
  const floor = D.quantize(D.mul(C, D.sub(D.one, D.div(numDec(r.maxTotalLossPct), HUNDRED, 8, 'down'))), CENT, 'up');
  // the mandate ends at least one wind-down (24 h) before the authorization, so that positions can still be closed after it expires
  const maxDays = Math.min(VENUE_MANDATE_BOUNDS.maxDays, Math.floor((auth.expiresAt - nowMs - VENUE_MANDATE_WIND_DOWN_S * 1000) / 86_400_000));
  const d = Math.max(1, Math.min(days ?? maxDays, maxDays));
  const lev = instruments.map((i) => `${symbolOf(i.instrument)} ${i.maxLeverage}x`).join(', ');
  return {
    capital: D.str(C), days: d, maxDays,
    body: { instruments, maxOrderNotional: usd(order), maxGrossExposure: usd(gross), maxDailyTurnover: usd(turnover), floorEquity: D.str(floor), maxOrdersPerDay: perDay, maxOrdersPerHour: perHour, days: d, strategySha256: sha256, agentId: a.id },
    derived: [
      { field: 'capital', value: D.str(C), from: 'the venue\'s account value now: the reference of every limit below and of the loss limits' },
      { field: 'instruments', value: instruments.map((i) => i.instrument).join(', '), from: 'the agent\'s instruments' },
      { field: 'maxLeverage', value: lev, from: `the agent's leverage limit (${r.maxLeverage}x), never above the authorization's (${p.maxLeverage}x) or the venue's maximum` },
      { field: 'maxPositionNotional', value: usd(position), from: `position per instrument: ${r.maxPositionX} × the capital` },
      { field: 'maxOrderNotional', value: usd(order), from: 'one order may be as large as one position (a full close in one order); closes are bounded too' },
      { field: 'maxGrossExposure', value: usd(gross), from: `gross exposure: ${r.maxGrossExposureX} × the capital` },
      { field: 'maxOrdersPerDay', value: String(perDay), from: `${n} instrument(s) × ${barsPerDay} bar(s) a day × 2 orders that can add exposure, at least 12` },
      { field: 'maxOrdersPerHour', value: String(perHour), from: `${n} instrument(s) × 2 orders that can add exposure, at least 4` },
      { field: 'maxDailyTurnover', value: usd(turnover), from: `${TURNOVER_X} × the gross exposure limit a day (orders that can add exposure)` },
      { field: 'floorEquity', value: D.str(floor), from: `the total-loss limit: the capital less ${r.maxTotalLossPct} % — below it the signer signs only cancels and reduce-only orders` },
      { field: 'days', value: String(d), from: `at most ${VENUE_MANDATE_BOUNDS.maxDays} days, and ending at least 24 h before the venue authorization expires (${new Date(auth.expiresAt).toISOString()}) so that positions can be closed during the wind-down` },
    ],
    notes,
  };
}

type Step = { ok: boolean; code: string | null; reason: string | null };
const bad = (code: string, reason: string): Step => ({ ok: false, code, reason }), good: Step = { ok: true, code: null, reason: null };

/** Everything the "go live" checklist shows, computed from the server's own state. Read-only. */
export async function liveReadiness(a: PerpAgentRow, rt: PerpLiveRuntime, q: { account?: string | undefined; locale: LiveLocale; days?: number | undefined }) {
  const svc = rt.live(), cfg = svc.config(q.locale), now = svc.now();
  const sv = await approvedVersion(a);
  const list = await svc.list();
  const users = await sql<{ id: string; name: string; live_account_id: string }[]>`select id, name, live_account_id from agents where live_account_id is not null`;
  const usedBy = (id: string) => { const u = users.find((x) => x.live_account_id === id); return u ? { agentId: u.id, name: u.name } : null; };
  const current = isLiveActive(a) ? a.perp?.live?.accountId : undefined;
  const pick: Summary | undefined = list.find((x) => x.id === (q.account ?? current)) ?? (q.account ? undefined : list.find((x) => x.network === 'testnet') ?? list[0]);
  let state: MandateAccountState | null = null;
  if (pick) state = await mandateAccountState(pick.id, svc).catch(() => null);
  const accounts = list.map((x) => ({ id: x.id, network: x.network, label: x.label, account: x.account, mode: x.mode, modes: x.modes, tradable: x.tradable,
    authorization: x.authorization ? { active: x.authorization.active, expiresAt: x.authorization.expiresAt } : null,
    mandate: x.mandate ? { id: x.mandate.id, phase: x.mandate.phase, agentId: x.mandate.agentId } : null, usedBy: usedBy(x.id),
    equity: x.id === pick?.id ? state?.state?.equity ?? null : null, error: x.id === pick?.id ? (state ? state.error : 'the venue account could not be read') : null }));

  // 1 — an approved strategy version: its hash is what the mandate pins
  const strategy = sv ? { ok: true, versionId: sv.id, sha256: sv.code_sha256, name: sv.name, version: sv.version, reason: null as string | null }
    : { ok: false, versionId: null, sha256: null, name: null, version: null, reason: 'approve a perpetual-futures strategy version first: its code hash is pinned in the mandate' as string | null };

  // 2 — a venue account with an ACTIVE manual authorization (created and authorised by the owner in Futures → Accounts)
  const auth = pick?.authorization ?? null;
  const maxMandateDays = auth ? Math.min(VENUE_MANDATE_BOUNDS.maxDays, Math.floor((auth.expiresAt - now - VENUE_MANDATE_WIND_DOWN_S * 1000) / 86_400_000)) : 0;
  const ids = a.universe.map(instrumentId), other = pick ? usedBy(pick.id) : null;
  const notPinned = pick ? ids.filter((i) => !hlPinnedAsset(pick.network, i)) : [], notAllowed = auth ? ids.filter((i) => !auth.policy.allowedInstruments.includes(i)) : [];
  const mine = !!pick && isLiveActive(a) && a.perp?.live?.accountId === pick.id;
  let acct: Step;
  if (!pick) acct = bad('no_account', 'no venue account yet: create one and authorise it with your passkey in Futures → Accounts');
  else if (pick.network === 'mainnet' && !cfg.mainnet.enabled) acct = bad('mainnet_disabled', cfg.mainnet.reason ?? 'mainnet is disabled on this server');
  else if (!auth || pick.mode !== 'MANUAL_LIVE') acct = bad('read_only', 'this venue account is read-only: authorise live trading on it with your passkey in Futures → Accounts');
  else if (!auth.active) acct = bad('authorization_expired', 'the venue authorization has expired: approve a new one in Futures → Accounts');
  else if (other && other.agentId !== a.id) acct = bad('used_by_other_agent', `this venue account is used by the agent "${other.name}": one agent per venue account`);
  else if (notPinned.length) acct = bad('instruments_not_pinned', `${notPinned.join(', ')}: not in the asset table pinned in the wallet and in the signer for ${pick.network} (live trading exists for the pinned instruments only)`);
  else if (notAllowed.length) acct = bad('instruments_not_allowed', `${notAllowed.join(', ')}: not allowed by the venue authorization of this account (approve one that lists them)`);
  else if (maxMandateDays < 1) acct = bad('authorization_too_short', 'the venue authorization expires in less than 48 hours: a mandate must end at least 24 hours before it, so that positions can be closed during the wind-down. Approve a new authorization');
  else if (!mine && pick.mandate?.phase === 'active') acct = bad('mandate_exists', 'a mandate is already active on this venue account: revoke it in Futures → Accounts before preparing another one');
  else if (!mine && state && state.error === null && (state.positions.length > 0 || state.openOrders.length > 0)) acct = bad('account_not_flat', `the venue account holds ${state.positions.length} position(s) and ${state.openOrders.length} resting order(s): an agent starts on a flat account — close and cancel them in the Futures terminal`);
  else acct = good;

  // 3 — funded: the venue's own account value against a minimum that makes the venue's minimum order sizes workable
  const min = pick ? await minimumEquity(a, svc, pick.network).catch(() => null) : null;
  const equity = state?.error === null ? state.state?.equity ?? null : null;
  let fund: Step;
  if (!pick) fund = bad('no_account', 'no venue account');
  else if (!state || state.error !== null || !min || equity === null) fund = bad('venue_unreadable', `the venue account could not be read${state?.error ? `: ${state.error}` : ''}`);
  else if (!D.isPos(D.from(equity))) fund = bad('unfunded', `the venue account holds no collateral: deposit USDC to it on the venue (at least ${min.minEquity} USDC for this agent)`);
  else if (D.lt(D.from(equity), D.from(min.minEquity))) fund = bad('below_minimum', `account value ${equity} USDC is below the ${min.minEquity} USDC this agent needs`);
  else fund = good;

  // 4 — the mandate: one passkey. Mainnet needs the two server settings.
  const lock = !cfg.mandateLive.available ? { code: 'mandate_unavailable', reason: cfg.mandateLive.reason ?? '' }
    : pick?.network === 'mainnet' && !cfg.mainnet.enabled ? { code: 'mainnet_disabled', reason: cfg.mainnet.reason ?? '' }
    : pick?.network === 'mainnet' && !cfg.mandateLive.mainnet.enabled ? { code: 'mandate_mainnet_disabled', reason: cfg.mandateLive.mainnet.reason ?? '' } : null;
  const m = pick?.mandate ?? null, mandateOk = mine && !!m && m.phase === 'active' && m.agentId === a.id && m.id === a.perp?.live?.mandateId;
  const ready = strategy.ok && acct.ok && fund.ok;
  const proposal = ready && sv && pick && auth && equity !== null && !mandateOk ? deriveMandate(a, sv.code_sha256, pick.network, equity, auth, now, q.days) : null;
  const next = !strategy.ok ? 'strategy' : !acct.ok ? 'account' : !fund.ok ? 'fund' : mandateOk ? 'live' : lock ? 'locked' : 'mandate';
  return {
    agentId: a.id, locale: q.locale, config: cfg, accounts, accountId: pick?.id ?? null,
    steps: {
      strategy,
      account: { ...acct, network: pick?.network ?? null, authorization: auth ? { active: auth.active, expiresAt: auth.expiresAt, maxMandateDays } : null, instrumentsMissing: [...new Set([...notPinned, ...notAllowed])] },
      funded: { ...fund, equity, minEquity: min?.minEquity ?? MIN_LIVE_EQUITY, basis: min?.basis ?? { instruments: [], ordersPerPosition: MIN_ORDERS_PER_POSITION, grossX: Math.min(a.risk.maxGrossExposureX, a.risk.maxLeverage * 0.9), floor: MIN_LIVE_EQUITY } },
      mandate: { ok: mandateOk, phase: m?.phase ?? null, mandateId: m?.id ?? null, lock },
    },
    next: next as 'strategy' | 'account' | 'fund' | 'mandate' | 'live' | 'locked', proposal, ts: now,
  };
}

export const LivePrepareBody = z.strictObject({ accountId: z.uuid(), days: z.number().int().min(1).max(VENUE_MANDATE_BOUNDS.maxDays).optional(), locale: z.enum(['fr', 'en']).default('en') });
export const LiveApproveBody = z.strictObject({ accountId: z.uuid(), assertion: z.record(z.string(), z.unknown()), /** V11.2: the API's own passkey step over the FULL trading mandate hash (mandates/service.ts `binding`) */ bindingAssertion: z.record(z.string(), z.unknown()).optional(), acknowledged: z.literal(true) });

// Steps 1 and 2 of going live — `prepareLive` and `approveLive`, the only functions that WRITE a derivative mandate for an agent —
// are in mandate-write.ts (V11): the engines and the agent runtime never import that module (agent-boundaries.test.ts).

// ------------------------------------------------------------------ the engine pass of a live agent

function liveDeps(rt: PerpLiveRuntime, network: string, ex: LivePerpExecutor): PerpEngineDeps {
  const venue = rt.live().deps.venues.get(network);
  return {
    ...rt.deps, executor: () => ex,
    // V11: the order gateway settles an order whose outcome is not known from the venue account's own record of it (nothing is sent)
    lookupOrder: async (clientId) => { const o = await mandateOrder(ex.accountId, clientId, rt.live()); return o ? liveOrderResult(o) : null; },
    // the market the orders are sent to: the account's own network (the signal still comes from the gate's closed bars)
    market: async (symbol) => { const inst = await venue.instrument(instrumentId(symbol)); const { ticker, book } = await venue.market(inst); return { inst, ticker, book }; },
  };
}
const executorOf = (a: PerpAgentRow, rt: PerpLiveRuntime, lb: PerpLiveBook): LivePerpExecutor =>
  new LivePerpExecutor(rt.live(), { accountId: lb.accountId, agentId: a.id, strategySha256: lb.strategySha256, symbols: a.universe, risk: a.risk, capital: lb.capital });

/** a condition that takes the agent out of LIVE, seen from the server's own state (before any order is planned) */
async function exitCondition(a: PerpAgentRow, lb: PerpLiveBook, s: MandateAccountState): Promise<{ code: string; detail: string } | null> {
  if (s.blocked) return { code: s.blocked.code === 'mode_read_only' || s.blocked.code === 'authorization_expired' ? 'authorization_ended' : s.blocked.code, detail: s.blocked.message };
  const m = s.mandate;
  if (!m || m.id !== lb.mandateId) return { code: 'mandate_ended', detail: '' };
  if (m.phase !== 'active') return { code: m.revokedAt !== null ? 'mandate_revoked' : m.expired ? 'mandate_expired' : 'authorization_ended', detail: '' };
  const sv = await approvedVersion(a);
  if (!sv || sv.code_sha256 !== lb.strategySha256) return { code: 'strategy_changed', detail: '' };
  if (s.halted) return { code: s.divergence ? 'divergence' : 'halted', detail: s.halted };
  const [liq] = await sql<{ instrument: string }[]>`select instrument from deriv_fills where account_id = ${lb.accountId} and liquidation and ts >= ${new Date(lb.since)} limit 1`;
  if (liq) return { code: 'liquidation', detail: liq.instrument };
  // an order of the owner on this account that reached the signer: the agent no longer knows whose positions these are
  const [manual] = await sql<{ client_id: string; instrument: string }[]>`select client_id, instrument from deriv_orders where account_id = ${lb.accountId} and state is not null and origin <> 'mandate'
    and signature is not null and created_at >= ${new Date(lb.since)} order by created_at limit 1`;
  if (manual) return { code: 'manual_order', detail: `${manual.instrument}, order ${manual.client_id}` };
  return null;
}

const lastHold = new Map<string, string>();

/** One pass for one agent that is on a venue account. Safe to call as often as wanted. */
export async function tickLivePerpAgent(a: PerpAgentRow, rt: PerpLiveRuntime): Promise<string> {
  const lb = a.perp?.live;
  if (a.kind !== 'perp' || a.mode !== 'LIVE' || !lb) return 'idle';
  if (a.state === 'STOPPING') return windDownStep(a, rt);
  if (a.state !== 'LIVE' && a.state !== 'PAUSED') return 'idle';
  const s = await mandateAccountState(lb.accountId, rt.live());
  const over = await exitCondition(a, lb, s);
  if (over) return beginExit(a, rt, over.code, exitText(over.code, over.detail), 'engine');
  if (s.error !== null) return `hold: the venue account could not be read (${s.error.slice(0, 120)})`;
  const ex = executorOf(a, rt, lb);
  const out = await tickPerpAgent(a, liveDeps(rt, s.network, ex), { capital: lb.capital, riskOnly: a.state === 'PAUSED', onBreach: (reason) => beginExit(a, rt, 'loss_limit', reason, 'engine') });
  const now = await reload(a.id);
  if (!isLiveActive(now)) {
    // the engine stopped the agent itself (liquidation event, a version that is not a perp strategy): nothing may stay authorised
    if (now.state === 'STOPPED' && now.perp?.live && !now.perp.live.exit?.done) return beginExit({ ...now, state: 'LIVE' }, rt, 'engine_stop', now.stop_reason ?? exitText('engine_stop'), 'engine');
    return out;
  }
  if (now.state === 'STOPPING') return out;                                    // a loss limit took it out during the step
  if (ex.exit && LIVE_EXIT_CODES.has(ex.exit.code)) return beginExit(now, rt, ex.exit.code, exitText(ex.exit.code, ex.exit.reason), 'engine');
  // a signer or risk refusal holds the instrument until the next bar: said once, not on every pass
  const refused = ex.holds.filter((h) => h.kind === 'refused');
  if (refused.length) {
    const text = refused.map((h) => `${h.instrument}: ${h.code} — ${h.reason}`).join('\n');
    if (lastHold.get(a.id) !== text) { lastHold.set(a.id, text); await log(a, 'hold', 'Order refused: holding until the next bar', text, refused); }
  }
  return out;
}

/**
 * The agent leaves LIVE. First the mandate is revoked on the signer (no passkey): from that instant nothing that can add
 * exposure is signed. Then the positions are closed with reduce-only orders, which the signer still signs during the wind-down.
 */
export async function beginExit(stale: PerpAgentRow, rt: PerpLiveRuntime, code: string, reason: string, actor: 'owner' | 'engine'): Promise<string> {
  // the row as it is NOW: the agent may have been stopped (by the owner, by another pass) since the caller read it — the first reason stands
  const a = await reload(stale.id);
  if (a.mode === 'LIVE' && a.state === 'STOPPING' && a.perp?.live?.exit) return windDownStep(a, rt);
  if (a.state === 'STOPPED' && a.perp?.live?.exit?.done) return 'stopped';
  const lb = a.perp?.live;
  if (!lb) return 'idle';
  const svc = rt.live();
  let note = '';
  try {
    const s = await mandateAccountState(lb.accountId, svc);
    if (s.mandate?.id === lb.mandateId && s.mandate.phase === 'active') await revokeLiveMandate(lb, svc, actor, code, reason);
  } catch (e) { note = ` The mandate could not be revoked at once (${msg(e)}); it is tried again on every pass.`; }
  const exit = { ts: svc.now(), code, reason };
  await sql`update agents set state = 'STOPPING', stop_reason = ${reason}, perp = perp || ${sql.json({ live: { ...lb, exit } } as never)}, updated_at = now() where id = ${a.id}`;
  await log(a, 'risk', 'Leaving LIVE: no new exposure; closing every position with reduce-only orders', `${reason}.${note}`);
  await audit('agent.perp_live_exit', actor, { id: a.id, account: lb.accountId, mandateId: lb.mandateId, code, reason });
  // the agent is out of LIVE whatever happens next: a closing attempt that cannot be made now is made on the next pass
  return windDownStep(await reload(a.id), rt).catch((e: unknown) => `stopping: the closing orders could not be attempted now (${msg(e)}); tried again on the next pass`);
}

async function finish(a: PerpAgentRow, lb: PerpLiveBook, reason: string, at: number): Promise<string> {
  await sql`update agents set state = 'STOPPED', stop_reason = ${reason}, live_account_id = null, perp = perp || ${sql.json({ live: { ...lb, exit: { ...lb.exit, done: at } } } as never)}, updated_at = now() where id = ${a.id}`;
  await log(a, 'stop', 'Agent stopped', reason);
  await audit('agent.stopped', 'engine', { id: a.id, kind: 'perp', mode: 'LIVE', reason });
  return 'stopped';
}

/** One pass of the wind-down: revoke if still needed, close what is open with reduce-only orders, stop when flat or when nothing can be signed. */
export async function windDownStep(a: PerpAgentRow, rt: PerpLiveRuntime): Promise<string> {
  const lb0 = a.perp?.live, svc = rt.live(), now = svc.now();
  if (!lb0) return 'idle';
  // a STOPPING agent always has a reason; if it were ever missing, the wind-down still runs
  const lb: PerpLiveBook & { exit: NonNullable<PerpLiveBook['exit']> } = { ...lb0, exit: lb0.exit ?? { ts: now, code: 'engine_stop', reason: a.stop_reason ?? exitText('engine_stop') } };
  const why = lb.exit.reason;
  let s = await mandateAccountState(lb.accountId, svc);
  if (s.mandate?.id === lb.mandateId && s.mandate.phase === 'active') {
    try { await revokeLiveMandate(lb, svc, lb.exit.code === 'owner_stop' ? 'owner' : 'engine', lb.exit.code, why); s = await mandateAccountState(lb.accountId, svc); }
    catch (e) { return `stopping: the mandate could not be revoked yet (${msg(e)})`; }
  }
  if (s.error !== null) return `stopping: the venue account could not be read (${s.error.slice(0, 120)})`;
  const allowed = new Set(s.mandate?.id === lb.mandateId ? s.mandate.limits.instruments.map((i) => i.instrument) : []);
  const mine = (p: Position): boolean => allowed.has(p.instrument);
  const names = (ps: Position[]): string => ps.map((p) => `${p.side} ${p.size} ${symbolOf(p.instrument)}`).join(', ');
  const closedNote = (lb.exit.closed ?? 0) > 0 ? 'every position was closed with reduce-only orders' : 'no position was open';
  if (s.positions.length === 0) return finish(a, lb, `${why}; ${closedNote}`, now);
  const manual = 'close them in the Futures terminal with your passkey (while the venue authorization lives), or on the venue\'s own interface';
  if (!s.positions.some(mine)) return finish(a, lb, `${why}; ${s.positions.length} position(s) remain open on the venue account (${names(s.positions)}) on instruments outside the mandate: ${manual}`, now);
  if (!s.canReduce) {
    const cause = s.blocked ? s.blocked.message : s.mandate?.phase === 'ended' ? 'the wind-down of the mandate is over, or the venue authorization is gone' : 'the mandate is no longer in force';
    return finish(a, lb, `${why}; ${s.positions.length} position(s) REMAIN OPEN on the venue account (${names(s.positions)}) and the signer no longer signs for this mandate (${cause}): ${manual}`, now);
  }
  if ((lb.exit.retryAt ?? 0) > now) return `stopping: ${s.positions.length} position(s) open; next closing attempt at ${new Date(lb.exit.retryAt!).toISOString()}`;
  const ex = executorOf(a, rt, lb);
  await ex.account();
  const f = await flattenPerp(a, liveDeps(rt, s.network, ex), ex, String(Math.floor(now / 60_000)), mine);
  const sent = f.results.filter((r) => r.status !== 'refused' && r.status !== 'deferred').length, refused = f.results.filter((r) => r.status === 'refused');
  const exit = { ...lb.exit, closed: (lb.exit.closed ?? 0) + sent, ...(refused.length ? { retryAt: now + CLOSE_RETRY_MS } : {}) };
  if (!refused.length) delete (exit as { retryAt?: number }).retryAt;
  await setLive(a.id, { ...lb, exit });
  if (f.results.length) await log(a, 'risk', 'Reduce-only closing orders (wind-down)', '', f.results);
  const left = f.left;
  if (left.length === 0) return finish(a, { ...lb, exit }, `${why}; every position was closed with reduce-only orders`, now);
  // the signer or the server said that nothing will be signed any more: say what remains instead of trying for 24 hours
  if (ex.exit && refused.length === f.results.length) return finish(a, { ...lb, exit }, `${why}; ${left.length} position(s) REMAIN OPEN on the venue account (${names(left)}) — the closing orders were refused (${ex.exit.code}: ${ex.exit.reason}): ${manual}`, now);
  return `stopping: ${left.length} position(s) still open (${names(left)})`;
}

// ------------------------------------------------------------------ owner actions (no passkey: stopping never needs one)

/**
 * V11.2 — revocation REMOVES authority, so the engines may ask for it. A mandate that is a trading mandate of the execution
 * layer (`unified`) is revoked THROUGH the mandate service: it revokes at the signer first, then closes its own record (reason,
 * wind-down, the Risk screen), so the API's mandate and the signer's can never disagree. A derivative mandate approved before
 * the trading mandates existed is revoked on the live module, as before.
 */
async function revokeLiveMandate(lb: PerpLiveBook, svc: LiveService, actor: 'owner' | 'engine', code: string, reason: string): Promise<void> {
  const ex = lb.unified ? executionBound() : null;
  // the signer first, with every open order of the account cancelled at the venue (as before); then the mandate service closes
  // its own record — it finds the signer's copy already revoked
  await svc.revokeMandate(lb.accountId, { cancelOpenOrders: true });
  if (!ex) return;
  const r = await ex.mandates.revoke(lb.mandateId, { by: actor === 'owner' ? 'owner' : 'system', reason: actor === 'owner' ? 'owner_request' : 'stop_condition', detail: `${code.toUpperCase()}: ${reason}`.slice(0, 300), cancelOpenOrders: true });
  if (r.signerRevoked === false) throw new Error(r.signerError ?? 'the signer has not taken the revocation yet');
}

/**
 * V11.2 — the agent goes LIVE under a trading mandate the OWNER approved (here nothing is created, prepared or approved: the
 * mandate in force is READ from the mandate service and recorded on the agent). Called after the passkey approval of the agent
 * page, or by "start live" once the owner approved the mandate in the Risk screen.
 */
export async function activateLive(a: PerpAgentRow, rt: Pick<PerpLiveRuntime, 'live'>, actor: 'owner'): Promise<PerpAgentRow> {
  const pend = (a.perp as { livePending?: { accountId: string; mandateId: string; capital: DecStr; strategySha256: string; unified?: boolean } } | null)?.livePending, ex = executionBound();
  if (isLiveActive(a)) throw new UserError('bad_state', 'this agent is already on a venue account', 409);
  if (!pend?.unified || !ex) throw new UserError('mandate_required', 'no trading mandate was prepared for this agent', 409);
  const m = await ex.mandates.get(pend.mandateId), sv = await approvedVersion(a);
  if (m.principal.kind !== 'agent' || m.principal.id !== a.id || m.mode !== 'live') throw new UserError('mandate_required', 'the mandate prepared for this agent is not a live mandate of this agent', 409);
  if (m.state !== 'active' || m.phase !== 'active' || !m.signer) throw new UserError('mandate_required', `the trading mandate of this agent is ${m.state === 'active' ? m.phase : m.state}: the owner approves it with the passkey (agent page, or Risk)`, 409);
  if (!sv || sv.code_sha256 !== m.mandate.strategySha256 || sv.code_sha256 !== pend.strategySha256) throw new UserError('mandate_required', 'the mandate was approved for another strategy version than the one approved now', 409);
  if (m.signer.accountId !== pend.accountId) throw new UserError('mandate_required', 'the mandate was approved on another venue account', 409);
  const svc = rt.live();
  const [acct] = await sql<{ network: 'testnet' | 'mainnet' }[]>`select network from deriv_accounts where id = ${pend.accountId}`;
  if (!acct) throw new UserError('unknown_account', 'unknown venue account', 404);
  // one agent per venue account
  try { await sql`update agents set live_account_id = ${pend.accountId}, updated_at = now() where id = ${a.id}`; }
  catch (e) { if ((e as { code?: string }).code === '23505') throw new UserError('used_by_other_agent', 'this venue account is used by another agent: one agent per venue account', 409); throw e; }
  const live: PerpLiveBook = { accountId: pend.accountId, network: acct.network, mandateId: pend.mandateId, strategySha256: pend.strategySha256, since: svc.now(), capital: pend.capital, exit: null, unified: true };
  // the daily-loss reference, a paper hold and a paper flatten do not carry over to the venue account
  const [row] = await sql<PerpAgentRow[]>`update agents set state = 'LIVE', mode = 'LIVE', stop_reason = null,
    perp = (perp - 'livePending' - 'day' - 'hold' - 'flatten') || ${sql.json({ live } as never)}, updated_at = now() where id = ${a.id} returning *`;
  await log(a, 'live', `LIVE on the ${acct.network} venue account`, `mandate ${pend.mandateId}, strategy ${pend.strategySha256.slice(0, 12)}…, reference capital ${pend.capital} USDC. Orders inside the mandate are placed without a passkey.`);
  await audit('agent.perp_live', actor, { id: a.id, account: pend.accountId, network: acct.network, mandateId: pend.mandateId, tradingMandate: m.hash, strategySha256: pend.strategySha256, capital: pend.capital });
  return row!;
}

export async function stopLive(a: PerpAgentRow, rt: PerpLiveRuntime, locale: LiveLocale) {
  if (!isLiveActive(a) || !a.perp?.live) throw new UserError('bad_state', 'this agent is not on a venue account', 409);
  const lb = a.perp.live;
  const result = a.state === 'STOPPING' ? await windDownStep({ ...a, perp: { ...a.perp, live: { ...lb, exit: lb.exit ? { ...lb.exit, retryAt: 0 } : lb.exit } } }, rt) : await beginExit(a, rt, 'owner_stop', exitText('owner_stop'), 'owner');
  const s = await mandateAccountState(lb.accountId, rt.live()).catch(() => null);
  return { result, windDown: { until: s?.mandate?.windDownUntil ?? null, text: liveTexts(locale).windDown, openPositions: s?.positions.length ?? null, openOrders: s?.openOrders.length ?? null } };
}

export async function pauseLive(a: PerpAgentRow): Promise<PerpAgentRow> {
  if (a.mode !== 'LIVE' || a.state !== 'LIVE') throw new UserError('bad_state', 'only an agent that is LIVE can be paused', 409);
  const [r] = await sql<PerpAgentRow[]>`update agents set state = 'PAUSED', updated_at = now() where id = ${a.id} returning *`;
  await log(a, 'live', 'Paused by the owner', 'No new exposure. Positions are KEPT on the venue account and nothing is closed; the loss limits and the stop conditions are still watched. The mandate stays active: stop the agent to revoke it.');
  await audit('agent.perp_live_pause', 'owner', { id: a.id });
  return r!;
}

export async function resumeLive(a: PerpAgentRow, rt: PerpLiveRuntime): Promise<PerpAgentRow> {
  const lb = a.perp?.live;
  if (a.mode !== 'LIVE' || a.state !== 'PAUSED' || !lb) throw new UserError('bad_state', 'only a paused live agent can be resumed', 409);
  const s = await mandateAccountState(lb.accountId, rt.live());
  if (s.mandate?.id !== lb.mandateId || s.mandate.phase !== 'active' || s.blocked) throw new UserError('bad_state', 'the mandate of this agent is no longer active: stop the agent and approve a new mandate', 409);
  const [r] = await sql<PerpAgentRow[]>`update agents set state = 'LIVE', updated_at = now() where id = ${a.id} returning *`;
  await log(a, 'live', 'Resumed by the owner');
  await audit('agent.perp_live_resume', 'owner', { id: a.id });
  return r!;
}

// ------------------------------------------------------------------ what the agent page shows

/** the `live` block of the agent view; with `full`, the venue account as the live module reports it and the signer's counters */
export async function liveBlock(a: PerpAgentRow, rt: PerpLiveRuntime, full: boolean) {
  const svc = rt.live(), cfg = svc.config('en'), lb = a.perp?.live ?? null, active = isLiveActive(a);
  const base = { available: cfg.mandateLive.available, reason: cfg.mandateLive.reason, active, accountId: lb?.accountId ?? null, network: lb?.network ?? null, mandateId: lb?.mandateId ?? null,
    strategySha256: lb?.strategySha256 ?? null, since: lb?.since ?? null, capital: lb?.capital ?? null, paused: active && a.state === 'PAUSED', exit: lb?.exit ? { ts: lb.exit.ts, code: lb.exit.code, reason: lb.exit.reason } : null };
  if (!full || !lb || a.mode !== 'LIVE') return { ...base, account: null, signer: null, holds: [] as { ts: number; bar: string; symbol: string; code: string; reason: string }[] };
  const [account, status] = await Promise.all([svc.get(lb.accountId).catch(() => null), svc.mandateStatus(lb.accountId).catch(() => null)]);
  const rows = await sql<{ bar: Date; updated_at: Date; orders: { list?: { symbol?: string; status?: string; code?: string; why?: string }[] } | null }[]>`select bar, updated_at, orders from agent_signals
    where agent_id = ${a.id} and mode = 'LIVE' and bar >= ${new Date(lb.since - 86_400_000)} order by bar desc limit 30`;
  const holds = rows.flatMap((r) => (r.orders?.list ?? []).filter((o) => o.status === 'refused' || o.status === 'deferred')
    .map((o) => ({ ts: r.updated_at.getTime(), bar: r.bar.toISOString(), symbol: String(o.symbol ?? ''), code: String(o.code ?? o.status), reason: String(o.why ?? '') }))).slice(0, 20);
  return { ...base, account, signer: status?.signer ?? null, holds };
}

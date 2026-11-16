// The mandate-WRITING module (V11). The only functions of the agent code that ask the signer to store a mandate are here:
//
//   spot   prepareSpotMandate / approveSpotMandate   (SPW-MANDATE-v1: the vault's swap mandate)
//   perp   createLiveMandate / prepareLive / approveLive   (SPW-TRADING-MANDATE-v1 of the execution layer, compiled by the
//                                                    mandate service into the signer's SPW-VENUE-MANDATE-v1)
//
// Every one of them is reached from an OWNER route only, and the approval is a passkey assertion that the SIGNER judges over
// the hash it recomputes. Nothing in the engines, in the order gateway or in the agent runtime imports this file
// (services/api/test/agent-boundaries.test.ts): an agent has no code path to create, widen or approve its own mandate.
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { z } from 'zod';
import { formatUnits, getNetwork, mandateHash, toB64u, toHex } from '@spw/core';
import { D, type DecStr } from '@spw/derivatives';
import { listCreds } from '../auth.ts';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { liveReason, type LiveReasonCode } from '../derivatives/live-texts.ts';
import { signer } from '../signer-client.ts';
import { execution } from './execution-bind.ts';
import { revokeAgentMandate } from './live.ts';
import type { PerpAgentRow } from './perp-engine.ts';
import { approvedVersion, isLiveActive, liveReadiness, type LiveApproveBody, type LivePrepareBody, type PerpLiveRuntime } from './perp-live-cycle.ts';
import { agentAssets, agentSymbols, mandateFor, requireGasReserve, symbolPrices, type AgentDeps, type AgentRow } from './routes.ts';

/** V11: a LIVE mandate pins only a strategy version that the OWNER approved. A version started on paper through an API key
 *  (approved_by = 'key:…') must be approved again by the owner before any mandate is prepared for it. */
export async function requireOwnerApproval(a: Pick<AgentRow, 'strategy_version_id'>): Promise<void> {
  if (!a.strategy_version_id) throw new UserError('no_strategy', 'approve a strategy version first', 409);
  const [v] = await sql<{ approved_by: string | null; status: string }[]>`select approved_by, status from strategy_versions where id = ${a.strategy_version_id}`;
  if (!v || v.status !== 'approved') throw new UserError('no_strategy', 'approve a strategy version first', 409);
  if (v.approved_by !== null && v.approved_by !== 'owner') throw new UserError('owner_approval_required', 'this strategy version was started on paper through an API key: the owner must approve it (its backtest report) before a live mandate can be prepared', 409);
}

// ------------------------------------------------------------------------------------------------------------------ spot

/** The spot mandate built from the agent's limits and the WebAuthn request whose challenge IS its hash. */
export async function prepareSpotMandate(a: AgentRow, deps: AgentDeps) {
  if (!a.strategy_version_id) throw new UserError('no_strategy', 'approve a strategy version first', 409);
  if (a.state === 'LIVE') throw new UserError('bad_state', 'a mandate is already active; revoke it to change limits', 409);
  await requireOwnerApproval(a);
  const [v] = await sql`select code_sha256 from strategy_versions where id = ${a.strategy_version_id}`;
  const st = await signer.status(true);
  if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
  const px = await symbolPrices(agentSymbols(a), await deps.prices().catch(() => null));
  const mandate = mandateFor(a, st.keyId, v!.code_sha256, px, Math.floor(Date.now() / 1000));
  const gas = await requireGasReserve(a, st.policy.maxFee[a.network]); // no reserve, no live trading
  const hash = mandateHash(mandate);
  await sql`update agents set mandate = ${sql.json(mandate as never)}, updated_at = now() where id = ${a.id}`;
  const creds = await listCreds();
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 120_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
  if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
  const n = getNetwork(a.network);
  const human = agentAssets(a, n).map((x) => ({ symbol: x.assetSymbol === x.symbol ? x.symbol : `${x.assetSymbol} (${x.symbol})`, tracks: x.symbol, assetSymbol: x.assetSymbol, kind: x.kind, issuer: x.issuer, maxOrder: formatUnits(BigInt(mandate.maxOrder[x.id]!), x.decimals), maxDaily: formatUnits(BigInt(mandate.maxDaily[x.id]!), x.decimals) }));
  return { mandate, hash: toHex(hash), limits: human, options, network: n.id, networkName: n.name, gasReserve: { required: formatUnits(gas.reserve, n.native.decimals), held: formatUnits(gas.held, n.native.decimals), symbol: n.native.symbol } };
}

/** The ONE passkey approval of a spot mandate: only the signer judges it and stores the limits. Returns the agent row, LIVE. */
export async function approveSpotMandate(a: AgentRow, assertion: Record<string, unknown>): Promise<AgentRow> {
  if (!a.mandate) throw new UserError('bad_state', 'prepare the mandate first', 409);
  await requireOwnerApproval(a);
  await requireGasReserve(a, (await signer.status(true)).policy.maxFee[a.network]);
  // V11 (D2): the signer holds ONE active mandate per vault. The previous one of this agent ends before the new one is asked for.
  if (a.mandate_id && a.mandate_id !== a.mandate.mandateId && !(await revokeAgentMandate(a, 'replaced by a new mandate'))) throw new UserError('signer_unreachable', 'the previous mandate could not be revoked on the signer; nothing was approved', 503);
  const r = await signer.mandateApprove(a.mandate, assertion); // only the signer judges the passkey and stores the limits
  const [row] = await sql<AgentRow[]>`update agents set mandate_id = ${r.mandateId}, state = 'LIVE', mode = 'LIVE', stop_reason = null, runtime = coalesce(runtime, '{}'::jsonb) - 'pausedFrom', updated_at = now() where id = ${a.id} returning *`;
  await audit('mandate.approved', 'owner', { agent: a.id, mandateId: r.mandateId, hash: r.hash });
  await sql`insert into research_log (agent_id, kind, title, body, mode, code) values (${a.id}, 'mandate', 'Mandate approved by the owner: LIVE', ${`mandate ${r.mandateId}, strategy ${a.mandate.strategySha256.slice(0, 12)}…, expires ${new Date(a.mandate.expiresAt * 1000).toISOString()}`}, 'LIVE', 'mandate_approved')`.catch(() => {});
  return row!;
}

// ------------------------------------------------------------------------------------------------------------------ perp

// V11.2 — a perp agent goes live under a TRADING MANDATE of the execution layer (mandates/service.ts), not under a mandate of
// its own making: the mandate is created from the agent's limits (`deriveMandate`, unchanged), COMPILED by the mandate service
// into the derivative mandate the signer enforces (SPW-VENUE-MANDATE-v1 — the shape, the hash and the passkey ceremony the
// signer verifies are exactly those of before), approved through the mandate service, and from then on has its usage counters,
// its stop conditions, its revocation and its place in the Risk screen like the mandate of any other principal.
//
// Two ways to the same approval, both the owner's:
//   agent page   perp/live/prepare (create + prepare the approval) → perp/live/approve (one passkey) → the agent is LIVE
//   Risk screen  perp/live/mandate (create only) → /risk?mandate=<id>: the owner approves it there → "start live" on the agent
//                (lifecycle.ts → perp-live-cycle.ts `activateLive`: the mandate in force is recorded on the agent, nothing is written)

interface LivePending { accountId: string; mandateId: string; capital: DecStr; strategySha256: string; preparedAt: number; unified: true }

/** The trading mandate (mode live) that says what the proposal says. What the signer will enforce is compiled from it by the mandate service. */
function tradingMandateBody(a: PerpAgentRow, accountId: string, p: NonNullable<Awaited<ReturnType<typeof liveReadiness>>['proposal']>, band: number, locale: 'fr' | 'en') {
  // A trading mandate states capital and leverage; the signer's gross-exposure bound is COMPILED as capital × leverage, and the
  // floor must stay below the capital. The mandate must never let the signer accept more gross exposure than the agent's limits
  // say, so: the largest whole leverage (≤ the agent's) for which  gross ÷ leverage  is still above the floor, and that quotient
  // as the capital. With the usual limits (gross 1.5 × capital, floor 0.9 × capital) that is 1× — see docs/TRADING-MANDATES.md §agents.
  const b = p.body, wanted = Math.max(1, Math.min(...b.instruments.map((i) => i.maxLeverage))), fit = Math.floor(Number(b.maxGrossExposure) / (Number(b.floorEquity) + 0.01));
  const lev = Math.max(1, Math.min(wanted, fit)), cap = D.from(p.capital), cents = (x: ReturnType<typeof D.from>, dir: 'up' | 'down'): DecStr => D.str(D.quantize(x, D.from('0.01'), dir));
  const position = b.instruments.reduce((m, i) => D.min(m, D.from(i.maxPositionNotional)), D.from(b.instruments[0]!.maxPositionNotional));
  const maxTotalLoss = D.max(D.from('0.01'), D.sub(cap, D.from(b.floorEquity)));
  return {
    principal: { kind: 'agent' as const, id: a.id }, mode: 'live' as const, accountIds: [accountId], instruments: b.instruments.map((i) => i.instrument), marketKinds: ['perp' as const], orderTypes: ['market' as const],
    // the signer's gross-exposure bound is compiled as capital × leverage: the capital that gives exactly the proposal's bound
    maxCapitalUsd: cents(D.div(D.from(b.maxGrossExposure), D.from(String(lev)), 6, 'down'), 'down'), maxOrderNotionalUsd: b.maxOrderNotional, maxPositionNotionalUsd: cents(position, 'down'), maxLeverage: String(lev),
    maxDailyLossUsd: cents(D.max(D.from('0.01'), D.mul(cap, D.div(D.from(String(a.risk.maxDailyLossPct)), D.from('100'), 8, 'down'))), 'up'), floorEquityUsd: b.floorEquity,
    days: b.days, frequency: { perMinute: Math.max(1, Math.min(40, b.maxOrdersPerHour)), perHour: b.maxOrdersPerHour, perDay: b.maxOrdersPerDay },
    // the price band of the venue authorization (what the direct flow used); an agent order is bounded by the agent's own, tighter, slippage limit
    maxSlippageBps: Math.max(band, Math.min(2000, a.risk.slippageBps)), maxFeeUsd: cents(D.add(D.mul(D.from(b.maxOrderNotional), D.from('0.002')), D.from('0.01')), 'up'),
    // the agent's total-loss limit, also as a stop condition of the mandate: the mandate supervisor engages the wind-down by itself
    stopConditions: [{ kind: 'loss_gte' as const, usd: cents(maxTotalLoss, 'up') }, { kind: 'consecutive_rejects_gte' as const, count: 25 }],
    strategySha256: b.strategySha256, label: `live · ${a.name}`.slice(0, 60), locale,
  };
}

/** Creates the live trading mandate of this agent on this venue account (state `created`: it authorises nothing until approved). */
export async function createLiveMandate(a: PerpAgentRow, rt: PerpLiveRuntime, body: z.infer<typeof LivePrepareBody>) {
  if (isLiveActive(a)) throw new UserError('bad_state', 'this agent is already on a venue account: stop it first', 409);
  await requireOwnerApproval(a);
  const r = await liveReadiness(a, rt, { account: body.accountId, locale: body.locale, days: body.days });
  if (r.accountId !== body.accountId) throw new UserError('unknown_account', 'unknown venue account', 404);
  const st = r.steps;
  if (r.next === 'locked') { const code = st.mandate.lock!.code as LiveReasonCode; throw new UserError(code, liveReason(code), code === 'mandate_unavailable' ? 503 : 403); }
  if (r.next !== 'mandate' || !r.proposal) {
    const why = !st.strategy.ok ? st.strategy.reason : !st.account.ok ? st.account.reason : !st.funded.ok ? st.funded.reason : 'the agent is already live';
    throw new UserError('not_ready', `not ready to go live (${r.next}): ${why}`, 409);
  }
  const ex = execution(), svc = rt.live();
  const [acct] = await sql<{ venue_authorization: { policy: { maxPriceDeviationBps: number } } | null }[]>`select venue_authorization from deriv_accounts where id = ${body.accountId}`;
  // a mandate of this agent that was created and never approved is withdrawn: one pending mandate per agent
  const old = (a.perp as { livePending?: LivePending } | null)?.livePending;
  if (old?.unified) await ex.mandates.revoke(old.mandateId, { by: 'owner', reason: 'superseded', cancelOpenOrders: false }).catch(() => {});
  const created = await ex.mandates.create(tradingMandateBody(a, body.accountId, r.proposal, acct?.venue_authorization?.policy.maxPriceDeviationBps ?? 300, body.locale));
  const pending: LivePending = { accountId: body.accountId, mandateId: created.id, capital: r.proposal.capital, strategySha256: r.proposal.body.strategySha256, preparedAt: svc.now(), unified: true };
  await sql`update agents set perp = perp || ${sql.json({ livePending: pending } as never)}, updated_at = now() where id = ${a.id}`;
  await audit('agent.perp_live_prepared', 'owner', { id: a.id, account: body.accountId, mandateId: created.id, tradingMandate: created.hash, capital: r.proposal.capital, limits: r.proposal.body });
  return { created, proposal: r.proposal };
}

/** Step 1 of going live from the agent page: the trading mandate is created and its approval prepared. TWO passkey prompts, as
 *  for every live trading mandate: `options` — built by the live module over the hash of the COMPILED derivative mandate, the
 *  one the signer verifies, as before — and `binding.options` — the API's own, over an intent that names the FULL mandate hash. */
export async function prepareLive(a: PerpAgentRow, rt: PerpLiveRuntime, body: z.infer<typeof LivePrepareBody>) {
  const { created, proposal } = await createLiveMandate(a, rt, body);
  const p = await execution().mandates.prepareApproval(created.id, body.locale);
  if (!p.passkey) throw new UserError('bad_state', 'a live mandate is approved with the passkey', 409);
  const sg = p.signer;
  return { locale: body.locale, mandate: sg.mandate, hash: sg.hash, options: sg.options, acknowledgement: sg.acknowledgement, warning: sg.warning, enforcedBySigner: sg.enforcedBySigner, trustedBySigner: sg.trustedBySigner, notEnforced: sg.notEnforced, windDown: sg.windDown, proposal, binding: p.binding,
    /** the trading mandate this derivative mandate was compiled from: field by field, what the signer enforces and what only the API enforces */
    tradingMandate: { id: created.id, hash: p.hash, mandate: p.mandate, enforcement: p.enforcement, derived: p.derived, risk: `/risk?mandate=${created.id}` } };
}

/** Step 2: the approval, through the mandate service (the signer judges the first assertion, the API the binding one); on success the agent is LIVE on that venue account. */
export async function approveLive(a: PerpAgentRow, rt: PerpLiveRuntime, body: z.infer<typeof LiveApproveBody>): Promise<PerpAgentRow> {
  const svc = rt.live(), pend = (a.perp as { livePending?: LivePending } | null)?.livePending;
  if (isLiveActive(a)) throw new UserError('bad_state', 'this agent is already on a venue account', 409);
  const sv = await approvedVersion(a);
  await requireOwnerApproval(a);
  const [prepared] = await sql<{ id: string; mandate: { agentId: string; strategySha256: string } }[]>`select id, mandate from deriv_mandates where account_id = ${body.accountId} and state = 'prepared' order by prepared_at desc limit 1`;
  if (!pend || !pend.unified || pend.accountId !== body.accountId || !prepared || prepared.id !== pend.mandateId || prepared.mandate.agentId !== a.id || !sv || sv.code_sha256 !== prepared.mandate.strategySha256) {
    throw new UserError('not_ready', 'prepare the mandate of this agent on this venue account first (the preparation is used once, and only for the strategy version that is approved now)', 409);
  }
  // one agent per venue account: the account is taken before the passkey is judged, and released if the approval fails
  try { await sql`update agents set live_account_id = ${body.accountId}, updated_at = now() where id = ${a.id}`; }
  catch (e) { if ((e as { code?: string }).code === '23505') throw new UserError('used_by_other_agent', 'this venue account is used by another agent: one agent per venue account', 409); throw e; }
  try { await execution().mandates.approve(pend.mandateId, { assertion: body.assertion, ...(body.bindingAssertion ? { bindingAssertion: body.bindingAssertion } : {}), acknowledged: true }); }
  catch (e) { await sql`update agents set live_account_id = null, perp = perp - 'livePending', updated_at = now() where id = ${a.id}`; throw e; }
  return (await import('./perp-live-cycle.ts')).activateLive((await sql<PerpAgentRow[]>`select * from agents where id = ${a.id}`)[0]!, { live: () => svc }, 'owner');
}

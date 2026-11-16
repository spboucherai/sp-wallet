// The mandate-WRITING module (V11). The only functions of the agent code that ask the signer to store a mandate are here:
//
//   spot   prepareSpotMandate / approveSpotMandate   (SPW-MANDATE-v1: the vault's swap mandate)
//   perp   prepareLive / approveLive                 (SPW-VENUE-MANDATE-v1: the derivative mandate of a venue account)
//
// Every one of them is reached from an OWNER route only, and the approval is a passkey assertion that the SIGNER judges over
// the hash it recomputes. Nothing in the engines, in the order gateway or in the agent runtime imports this file
// (services/api/test/agent-boundaries.test.ts): an agent has no code path to create, widen or approve its own mandate.
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { z } from 'zod';
import { formatUnits, getNetwork, mandateHash, toB64u, toHex } from '@spw/core';
import type { DecStr } from '@spw/derivatives';
import { listCreds } from '../auth.ts';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { liveReason, type LiveReasonCode } from '../derivatives/live-texts.ts';
import { signer } from '../signer-client.ts';
import { revokeAgentMandate } from './live.ts';
import type { PerpAgentRow, PerpLiveBook } from './perp-engine.ts';
import { approvedVersion, isLiveActive, liveReadiness, log, type LiveApproveBody, type LivePrepareBody, type PerpLiveRuntime } from './perp-live-cycle.ts';
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

/** Step 1 of going live: the mandate derived from the agent's limits, prepared on the live module (which builds the WebAuthn request). */
export async function prepareLive(a: PerpAgentRow, rt: PerpLiveRuntime, body: z.infer<typeof LivePrepareBody>) {
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
  const prep = await rt.live().prepareMandate(body.accountId, { ...r.proposal.body, locale: body.locale });
  await sql`update agents set perp = perp || ${sql.json({ livePending: { accountId: body.accountId, mandateId: prep.mandate.mandateId, capital: r.proposal.capital, strategySha256: r.proposal.body.strategySha256, preparedAt: rt.live().now() } } as never)}, updated_at = now() where id = ${a.id}`;
  await audit('agent.perp_live_prepared', 'owner', { id: a.id, account: body.accountId, mandateId: prep.mandate.mandateId, capital: r.proposal.capital, limits: r.proposal.body });
  return { ...prep, proposal: r.proposal };
}

/** Step 2: the ONE passkey approval. The signer judges it; on success the agent is LIVE on that venue account. */
export async function approveLive(a: PerpAgentRow, rt: PerpLiveRuntime, body: z.infer<typeof LiveApproveBody>): Promise<PerpAgentRow> {
  const svc = rt.live(), pend = (a.perp as { livePending?: { accountId: string; mandateId: string; capital: DecStr; strategySha256: string } } | null)?.livePending;
  if (isLiveActive(a)) throw new UserError('bad_state', 'this agent is already on a venue account', 409);
  const sv = await approvedVersion(a);
  await requireOwnerApproval(a);
  const [prepared] = await sql<{ id: string; mandate: { agentId: string; strategySha256: string } }[]>`select id, mandate from deriv_mandates where account_id = ${body.accountId} and state = 'prepared' order by prepared_at desc limit 1`;
  if (!pend || pend.accountId !== body.accountId || !prepared || prepared.id !== pend.mandateId || prepared.mandate.agentId !== a.id || !sv || sv.code_sha256 !== prepared.mandate.strategySha256) {
    throw new UserError('not_ready', 'prepare the mandate of this agent on this venue account first (the preparation is used once, and only for the strategy version that is approved now)', 409);
  }
  // one agent per venue account: the account is taken before the passkey is judged, and released if the approval fails
  try { await sql`update agents set live_account_id = ${body.accountId}, updated_at = now() where id = ${a.id}`; }
  catch (e) { if ((e as { code?: string }).code === '23505') throw new UserError('used_by_other_agent', 'this venue account is used by another agent: one agent per venue account', 409); throw e; }
  let network: 'testnet' | 'mainnet';
  try { network = (await svc.approveMandate(body.accountId, { assertion: body.assertion, acknowledged: true })).network; }
  catch (e) { await sql`update agents set live_account_id = null, perp = perp - 'livePending', updated_at = now() where id = ${a.id}`; throw e; }
  const live: PerpLiveBook = { accountId: body.accountId, network, mandateId: pend.mandateId, strategySha256: pend.strategySha256, since: svc.now(), capital: pend.capital, exit: null };
  // the daily-loss reference, a paper hold and a paper flatten do not carry over to the venue account
  const [row] = await sql<PerpAgentRow[]>`update agents set state = 'LIVE', mode = 'LIVE', stop_reason = null,
    perp = (perp - 'livePending' - 'day' - 'hold' - 'flatten') || ${sql.json({ live } as never)}, updated_at = now() where id = ${a.id} returning *`;
  await log(a, 'live', `LIVE on the ${network} venue account`, `mandate ${pend.mandateId}, strategy ${pend.strategySha256.slice(0, 12)}…, reference capital ${pend.capital} USDC. Orders inside the mandate are placed without a passkey.`);
  await audit('agent.perp_live', 'owner', { id: a.id, account: body.accountId, network, mandateId: pend.mandateId, strategySha256: pend.strategySha256, capital: pend.capital });
  return row!;
}


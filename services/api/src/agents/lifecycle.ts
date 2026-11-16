// start / pause / resume / stop of ANY agent — one place, used by the owner's routes, the trading API (keys) and the
// risk-management agent. Three rules hold whoever calls:
//
//   1. LIVE needs a mandate the OWNER approved with the passkey. Nothing here creates, prepares or approves one (this file does
//      not import mandate-write.ts): an agent without an active mandate that is asked to go live answers 409 `mandate_required`
//      with what the owner has to do. Resuming a paused live PERP agent is possible because its derivative mandate is still in
//      force at the signer (pause keeps it; the signer goes on enforcing it); a paused live SPOT agent has NO mandate any more
//      (pause revokes it — V11 Phase B), so resuming it is a new mandate.
//   2. stop is always allowed and is the safe wind-down: a live perp agent's mandate is revoked and its positions are closed with
//      reduce-only orders (perp-live-cycle.ts); a live spot agent's mandate is revoked at the signer; a stream agent's simulated
//      quotes are withdrawn.
//   3. pause and stop only ever REMOVE authority or activity.
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { journal } from '../agent-runtime/journal.ts';
import { FAMILY_MODES, modeOf, type Family, type Mode } from '../agent-runtime/model.ts';
import { loadAgent, type RuntimeAgentRow } from '../agent-runtime/store.ts';
import type { PerpAgentRow } from './perp-engine.ts';
import { isLiveActive, pauseLive, resumeLive } from './perp-live-cycle.ts';
import { perpReportProblem } from './perp-strategies.ts';
import type { AgentRow } from './routes.ts';

export interface Actor { kind: 'owner' | 'api_key' | 'agent'; id?: string }
export const actorName = (x: Actor): string => (x.kind === 'owner' ? 'owner' : x.kind === 'api_key' ? `key:${x.id}` : `agent:${x.id}`);
type Listener = (a: RuntimeAgentRow, what: 'started' | 'paused' | 'stopped') => Promise<void>;
let listener: Listener | null = null;
/** main.ts binds the webhook emitter (`agent.updated`) here */
export const onAgentChange = (l: Listener | null): void => { listener = l; };
const changed = async (id: string, what: 'started' | 'paused' | 'stopped'): Promise<RuntimeAgentRow> => { const a = await loadAgent(id); await listener?.(a, what).catch(() => {}); return a; };
const kindOf = (a: RuntimeAgentRow): 'spot' | 'perp' | 'stream' | 'supervisor' => (a.kind ?? 'spot') as never;

export class MandateRequired extends UserError {
  readonly agentId: string; readonly kind: string;
  constructor(agentId: string, kind: string, why: string) {
    super('mandate_required', `LIVE needs a mandate approved by the owner with the passkey, in force at the signer: ${why}. A key, an agent or this route can never approve one.`, 409);
    this.agentId = agentId; this.kind = kind;
  }
}

/** A version can run on PAPER once its backtest report passes the same integrity checks an owner approval requires. The approval
 *  is recorded with WHO gave it; one given by a key lets the agent trade on paper and can never be pinned by a live mandate. */
async function ensurePaperVersion(a: RuntimeAgentRow, actor: Actor): Promise<void> {
  const [cur] = a.strategy_version_id ? await sql<{ status: string }[]>`select status from strategy_versions where id = ${a.strategy_version_id}` : [];
  if (cur?.status === 'approved') return;
  const [v] = await sql<{ id: string; name: string; version: string; code_sha256: string; report: unknown; meta: { kind?: string } | null }[]>`select id, name, version, code_sha256, report, meta from strategy_versions where agent_id = ${a.id} and status in ('draft', 'approved') order by created_at desc limit 1`;
  if (!v) throw new UserError('no_strategy', 'this agent has no strategy version: register one first', 409);
  if (!v.report) throw new UserError('no_report', 'this strategy version has no backtest report yet: run the backtest (POST /strategies/{id}/backtest) and wait for it', 409);
  const problem = kindOf(a) === 'perp' ? perpReportProblem(v.report, v.code_sha256, a.universe) : (v.report as { checks?: Record<string, unknown> }).checks?.lookahead === 'pass' ? null : 'the report\'s own look-ahead check did not pass';
  if (problem) throw new UserError('bad_report', `${problem}: this version cannot run, even on paper`, 409);
  await sql`update strategy_versions set status = 'retired' where agent_id = ${a.id} and status = 'approved' and id <> ${v.id}`;
  await sql`update strategy_versions set status = 'approved', approved_at = now(), approved_by = ${actorName(actor)} where id = ${v.id}`;
  await sql`update agents set strategy_version_id = ${v.id}, updated_at = now() where id = ${a.id}`;
  await audit('strategy.approved', actorName(actor), { agent: a.id, version: v.id, sha256: v.code_sha256, scope: actor.kind === 'owner' ? 'owner' : 'paper only' });
  await (await import('../agent-runtime/store.ts')).bumpConfig(a.id, actorName(actor), `strategy version ${v.name}/${v.version} (${v.code_sha256.slice(0, 12)}…) approved${actor.kind === 'owner' ? '' : ' for paper trading'}`);
}

export async function startAgent(id: string, mode: Mode, actor: Actor): Promise<RuntimeAgentRow> {
  const a = await loadAgent(id), kind = kindOf(a), family = (a.family ?? 'custom') as Family, fm = FAMILY_MODES[family];
  if (!fm.modes.includes(mode)) throw new UserError(mode === 'live' ? 'live_unavailable' : 'mode_unavailable', fm.liveReason && mode === 'live' ? fm.liveReason : `a ${family} agent does not run in ${mode} mode`, 409);
  if (a.state === 'STOPPING') throw new UserError('bad_state', 'this agent is closing its positions: wait until it is stopped', 409);
  const who = actorName(actor);

  if (mode === 'live') {
    if (kind === 'supervisor') {
      // the supervisor places no order and holds no mandate; letting it pause LIVE agents and engage the kill switch is the owner's decision
      if (actor.kind !== 'owner') throw new UserError('owner_required', 'only the owner can let the risk-management agent act on LIVE agents', 403);
      await sql`update agents set state = 'RUNNING', mode = 'LIVE', stop_reason = null, updated_at = now() where id = ${a.id}`;
    } else if (kind === 'perp') {
      const p = a as unknown as PerpAgentRow;
      if (!isLiveActive(p)) throw new MandateRequired(a.id, kind, 'this agent has no derivative mandate in force (go live from the agent page: venue account, then the mandate)');
      if (p.state === 'PAUSED') await resumeLive(p, (await import('./perp-live.ts')).perpRuntime());   // refuses when the mandate is no longer active at the signer
    } else if (kind === 'spot') {
      if (a.state !== 'LIVE') throw new MandateRequired(a.id, kind, a.mode === 'LIVE' ? 'the mandate of this agent was revoked when it left LIVE (pause, stop, loss limit or expiry) — a new one must be approved' : 'no mandate was ever approved for this agent');
    } else throw new UserError('live_unavailable', fm.liveReason ?? 'live mode is not available for this agent', 409);
    await journal(a.id, { mode: 'LIVE', kind: 'state', code: 'started_live', title: `Live ${a.state === 'PAUSED' ? 'resumed' : 'confirmed'} by ${who}`, body: 'under the mandate in force at the signer' });
    await audit('agent.start', who, { id: a.id, mode });
    return changed(a.id, 'started');
  }

  // research and paper: nothing is signed. An agent that is on a venue account or under a spot mandate leaves it first (stop).
  if (kind === 'perp' && isLiveActive(a as unknown as PerpAgentRow)) throw new UserError('bad_state', 'this agent is on a venue account: stop it first (the mandate is revoked and its positions are closed)', 409);
  if (kind === 'spot' && a.state === 'LIVE') throw new UserError('bad_state', 'this agent is LIVE: stop or pause it first (the mandate is revoked at the signer)', 409);
  if (mode === 'paper' && (kind === 'spot' || kind === 'perp')) await ensurePaperVersion(a, actor);
  const fresh = await loadAgent(a.id);
  if (kind === 'spot') await (await import('./routes.ts')).setSpotMode(fresh as unknown as AgentRow, mode === 'paper' ? 'PAPER' : 'RESEARCH', who);
  else if (kind === 'perp') await (await import('./perp-routes.ts')).perpMode(fresh as unknown as PerpAgentRow, mode === 'paper' ? 'PAPER' : 'RESEARCH', who);
  else {
    const state = kind === 'stream' && mode === 'paper' ? 'PAPER_TRADING' : 'RUNNING', m = mode === 'paper' ? 'PAPER' : 'RESEARCH';
    await sql`update agents set state = ${state}, mode = ${m}, stop_reason = null, runtime = (coalesce(runtime, '{}'::jsonb) - 'hold' - 'pausedFrom') || '{"lastDecisionAt":null}'::jsonb, updated_at = now() where id = ${a.id}`;
    await journal(a.id, { mode: m, kind: 'state', code: `started_${mode}`, title: `${mode === 'paper' ? 'Paper trading' : 'Research'} started by ${who}`, body: kind === 'supervisor' ? (mode === 'paper' ? 'observes every agent; may pause PAPER agents' : 'observes every agent and proposes; acts on nothing') : mode === 'paper' ? 'SIMULATED orders and fills on real books; nothing reaches a venue' : 'decisions are computed and stored; no order is placed' });
    await audit('agent.mode', who, { id: a.id, state, mode: m });
  }
  await audit('agent.start', who, { id: a.id, mode });
  return changed(a.id, 'started');
}

export async function pauseAgent(id: string, actor: Actor, reason = ''): Promise<RuntimeAgentRow> {
  const a = await loadAgent(id), kind = kindOf(a), who = actorName(actor);
  if (a.state === 'PAUSED') return a;
  if (!['PAPER_TRADING', 'LIVE', 'RUNNING'].includes(a.state)) throw new UserError('bad_state', `only an active agent can be paused (this one is ${a.state})`, 409);
  if (kind === 'perp') {
    const p = a as unknown as PerpAgentRow;
    if (isLiveActive(p)) await pauseLive(p); else await (await import('./perp-routes.ts')).perpMode(p, 'PAUSED', who);
  } else if (kind === 'spot') await (await import('./routes.ts')).setSpotMode(a as unknown as AgentRow, 'PAUSED', who);
  else {
    // a paused stream agent quotes nothing: its simulated resting quotes are withdrawn (the gateway's ledger follows at the next pass)
    await sql`update agents set state = 'PAUSED', runtime = jsonb_set(coalesce(runtime, '{}'::jsonb) || ${sql.json({ pausedFrom: modeOf(a).toUpperCase() } as never)}, '{book,quotes}', '[]'::jsonb, false), updated_at = now() where id = ${a.id}`;
    await audit('agent.mode', who, { id: a.id, state: 'PAUSED' });
  }
  await journal(a.id, { kind: 'state', code: 'paused', severity: actor.kind === 'agent' ? 'warning' : 'info', title: `Paused by ${who}`, body: reason });
  return changed(a.id, 'paused');
}

/** Resume = start again in the mode the agent was paused in. */
export async function resumeAgent(id: string, actor: Actor): Promise<RuntimeAgentRow> {
  const a = await loadAgent(id);
  if (a.state !== 'PAUSED') throw new UserError('bad_state', 'only a paused agent can be resumed', 409);
  const from = (a.runtime as { pausedFrom?: string } | null)?.pausedFrom;
  return startAgent(id, from === 'LIVE' || (a.mode === 'LIVE' && !from) ? 'live' : from === 'RESEARCH' || (a.mode === 'RESEARCH' && !from) ? 'research' : 'paper', actor);
}

/** Always allowed. The safe wind-down of whatever the agent is doing. */
export async function stopAgent(id: string, actor: Actor, reason = ''): Promise<RuntimeAgentRow & { windDown?: unknown }> {
  const a = await loadAgent(id), kind = kindOf(a), who = actorName(actor);
  let windDown: unknown;
  if (a.state === 'STOPPED') return a;
  if (kind === 'perp') {
    const p = a as unknown as PerpAgentRow;
    if (isLiveActive(p)) { const { stopLive } = await import('./perp-live-cycle.ts'); const r = await stopLive(p, (await import('./perp-live.ts')).perpRuntime(), 'en'); windDown = { ...r.windDown, result: r.result }; }
    else await (await import('./perp-routes.ts')).perpMode(p, 'STOPPED', who);
  } else if (kind === 'spot') await (await import('./routes.ts')).setSpotMode(a as unknown as AgentRow, 'STOPPED', who);
  else {
    await sql`update agents set state = 'STOPPED', stop_reason = ${`stopped by ${who}${reason ? `: ${reason}` : ''}`.slice(0, 300)}, runtime = jsonb_set(coalesce(runtime, '{}'::jsonb), '{book,quotes}', '[]'::jsonb, false), updated_at = now() where id = ${a.id}`;
    await audit('agent.mode', who, { id: a.id, state: 'STOPPED' });
  }
  await journal(a.id, { kind: 'state', code: 'stopped', title: `Stop requested by ${who}`, body: reason || (windDown ? 'the mandate is revoked; positions are being closed with reduce-only orders' : '') });
  await audit('agent.stop', who, { id: a.id, reason: reason.slice(0, 200) });
  return { ...(await changed(a.id, 'stopped')), ...(windDown ? { windDown } : {}) };
}

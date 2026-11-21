/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/trading-handlers.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// Trading API — the `strategies` and `agents` operations (spec.ts), for an API key or the owner session.
//
// What a key holding `agents:manage` / `strategies:manage` CAN do: create a perp, stream or supervisor agent (nothing is
// signed, no vault is derived), register a library strategy on an agent, ask for a backtest (a job), start research or paper
// trading, pause, stop. What it can NEVER do: approve a mandate (no such route exists under /api/v1/trading), start an agent
// LIVE unless a mandate the OWNER approved with the passkey is in force for THAT agent at the signer (409 `mandate_required`),
// let the supervisor act on live agents (403 `owner_required`), create a spot agent (it needs a vault from the signer: the
// owner's app). `stop` is always allowed and is the safe wind-down.
// Every read is mode-scoped: `mode` is a required part of the answer and no answer carries two modes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { enqueue, getJob, jobView } from '../agent-runtime/queue.ts';
import { agentJournal, agentOrders, agentPerformance, agentSignals, agentSummary, loadAgent, parseMode, type RuntimeAgentRow } from '../agent-runtime/store.ts';
import { withIdempotency } from '../trading-api/idempotency.ts';
import type { Principal } from '../trading-api/principal.ts';
import { venueAllowed } from '../trading-api/read.ts';
import { actorName, pauseAgent, startAgent, stopAgent, type Actor } from './lifecycle.ts';
import { mandateDraft, overview } from './runtime-routes.ts';
import { createFromTemplate, templatesView } from './templates.ts';

interface Input { params: any; query: any; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by the operation's zod schemas
type Handler = (p: Principal, i: Input, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const actorOf = (p: Principal): Actor => (p.kind === 'owner' ? { kind: 'owner' } : { kind: 'api_key', id: p.id });
const venuesOf = (a: RuntimeAgentRow): string[] => ((a.kind ?? 'spot') === 'spot' ? ['spot'] : a.kind === 'perp' ? ['hyperliquid'] : a.kind === 'stream' ? ((a.runtime?.venues as string[] | undefined) ?? []) : []);
/** a key restricted to venues reaches only the agents that trade there */
async function agentFor(p: Principal, id: string): Promise<RuntimeAgentRow> {
  const a = await loadAgent(id);
  if (!venuesOf(a).every((v) => venueAllowed(p, v))) throw new UserError('restricted', 'this key is not allowed on this agent\'s venue', 403);
  return a;
}
async function versionAgent(p: Principal, versionId: string): Promise<{ agent: RuntimeAgentRow; versionId: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new UserError('not_found', 'strategy version not found', 404);
  const [v] = await sql<{ agent_id: string }[]>`select agent_id from strategy_versions where id = ${versionId}`;
  if (!v) throw new UserError('not_found', 'strategy version not found', 404);
  return { agent: await agentFor(p, v.agent_id), versionId };
}
const mutate = (fn: (p: Principal, i: Input) => Promise<unknown>): Handler => (p, i, req, reply) => withIdempotency(req, reply, () => fn(p, i));
const modeOfAgent = (a: RuntimeAgentRow): 'research' | 'paper' | 'live' => (a.mode === 'LIVE' ? 'live' : a.mode === 'PAPER' ? 'paper' : 'research');

export function agentTradingHandlers(): Record<string, Handler> {
  return {
    // ------------------------------------------------------------------------------------------------ strategies
    createStrategy: mutate(async (p, i) => {
      if (!i.body.agentId) throw new UserError('bad_request', 'agentId is required: a strategy version is pinned to ONE agent (by the hash of its file) and backtested on that agent\'s markets', 400);
      const a = await agentFor(p, i.body.agentId);
      if ((a.kind ?? 'spot') !== i.body.kind) throw new UserError('wrong_kind', `this agent is a ${a.kind ?? 'spot'} agent`, 409);
      const r = await (await import('./strategies.ts')).registerStrategy(a.id, String(i.body.path).replace(/^strategies\//, ''), actorName(actorOf(p)));
      return { strategy: { id: r.id, agentId: a.id, sha256: r.sha256, status: r.status }, note: 'registered and queued for its backtest; approval for LIVE stays the owner\'s' };
    }),
    backtestStrategy: mutate(async (p, i) => {
      const { agent, versionId } = await versionAgent(p, i.params.id);
      const j = await enqueue('backtest', { agentId: agent.id, payload: { versionId }, dedupeKey: `backtest:${agent.id}:${versionId}` });
      await audit('agent.backtest_requested', actorName(actorOf(p)), { id: agent.id, version: versionId, job: j.id });
      return { job: jobView((await getJob(j.id))!), label: 'backtest' };
    }),
    startStrategy: mutate(async (p, i) => {
      const { agent, versionId } = await versionAgent(p, i.params.id);
      if (i.body.agentId && i.body.agentId !== agent.id) throw new UserError('bad_request', 'this strategy version is pinned to another agent', 409);
      // the version that runs is the agent's approved one; a key cannot swap an approved version for another
      if (agent.strategy_version_id && agent.strategy_version_id !== versionId) {
        const [cur] = await sql<{ status: string }[]>`select status from strategy_versions where id = ${agent.strategy_version_id}`;
        if (cur?.status === 'approved') throw new UserError('other_version', 'this agent runs another approved strategy version; a new version is approved by the owner in the app', 409);
      }
      const [latest] = await sql<{ id: string }[]>`select id from strategy_versions where agent_id = ${agent.id} and status in ('draft', 'approved') order by created_at desc limit 1`;
      if (i.body.mode !== 'live' && agent.strategy_version_id !== versionId && latest?.id !== versionId) throw new UserError('other_version', 'only the most recent version of an agent can be started; register this one again', 409);
      return { agent: await agentSummary(await startAgent(agent.id, i.body.mode, actorOf(p))), strategyVersionId: versionId };
    }),
    stopStrategy: mutate(async (p, i) => {
      const { agent } = await versionAgent(p, i.params.id);
      const r = await stopAgent(agent.id, actorOf(p), i.body?.reason ?? '');
      return { agent: await agentSummary(r), windDown: r.windDown ?? null };
    }),

    // ------------------------------------------------------------------------------------------------ agents
    listAgents: async (p) => {
      const rows = await sql<RuntimeAgentRow[]>`select * from agents order by created_at desc`;
      const out = [];
      for (const a of rows) {
        if (!venuesOf(a).every((v) => venueAllowed(p, v))) continue;
        const s = await agentSummary(a);
        // `state` / `mode` keep their historical raw values; `lifecycle` and `tradingMode` are the V11 vocabulary
        out.push({ ...s, kind: s.kind as 'spot' | 'perp' | 'stream' | 'supervisor', state: a.state, mode: a.mode, lifecycle: s.state, tradingMode: s.mode, strategyVersionId: a.strategy_version_id, mandateId: s.mandate?.id ?? null,
          accountId: a.live_account_id ?? a.deriv_account_id ?? null });
      }
      return { agents: out };
    },
    listAgentTemplates: async () => ({ templates: await templatesView() }),
    getAgent: async (p, i) => { const a = await agentFor(p, i.params.id); return { agent: await overview(a), mandateDraft: await mandateDraft(a).catch(() => null) }; },
    listAgentSignals: async (p, i) => { const a = await agentFor(p, i.params.id), mode = parseMode(i.query.mode, modeOfAgent(a)); return { mode, signals: await agentSignals(a.id, mode, i.query) }; },
    listAgentJournal: async (p, i) => { const a = await agentFor(p, i.params.id), mode = parseMode(i.query.mode, modeOfAgent(a)); return { mode, entries: await agentJournal(a.id, mode, i.query) }; },
    listAgentOrders: async (p, i) => { const a = await agentFor(p, i.params.id), mode = parseMode(i.query.mode, modeOfAgent(a)); return { mode, orders: await agentOrders(a, mode, { ...i.query, open: i.query.open === 'true' }) }; },
    getAgentPerformance: async (p, i) => { const a = await agentFor(p, i.params.id); return agentPerformance(a, parseMode(i.query.mode, modeOfAgent(a))); },
    getJob: async (p, i) => {
      const j = await getJob(i.params.id).catch(() => null);
      if (!j) throw new UserError('not_found', 'job not found', 404);
      if (j.agent_id) await agentFor(p, j.agent_id);
      return { job: jobView(j) };
    },
    createAgent: mutate(async (p, i) => {
      const b = i.body, actor = actorName(actorOf(p));
      if (b.template) {
        const r = await createFromTemplate({ template: b.template, name: b.name, mission: b.mission, ...(b.strategyPath ? { strategyPath: b.strategyPath } : {}), ...(b.universe ? { universe: b.universe } : {}), ...(b.venues ? { venues: b.venues } : {}),
          ...(b.capitalUsdc ? { capitalUsdc: b.capitalUsdc } : {}), ...(b.risk ? { risk: b.risk } : {}), ...(b.config ? { config: b.config } : {}) }, actor);
        if (b.mode === 'paper' && r.agent.engine !== 'bar') return { ...r, agent: await agentSummary(await startAgent(r.agent.id, 'paper', actorOf(p))) };
        return r;
      }
      if (b.kind === 'spot') throw new UserError('owner_required', 'a spot agent gets a vault whose address the signer derives: create it in the wallet app. A key can create perp, stream and supervisor agents.', 403);
      if (b.kind !== 'perp' || !b.universe) throw new UserError('bad_request', 'give a template, or kind "perp" with its instruments (universe)', 400);
      const created = await (await import('./perp-routes.ts')).createPerpAgent({ kind: 'perp', name: b.name, mission: b.mission ?? '', instruments: b.universe, interval: b.interval ?? '1h', capitalUsdc: b.capitalUsdc ?? '1000', ...(b.risk ? { risk: b.risk } : {}) });
      return { agent: await agentSummary(await loadAgent(created.id)), strategy: null, warnings: created.warnings };
    }),
    startAgent: mutate(async (p, i) => { const a = await agentFor(p, i.params.id); return { agent: await agentSummary(await startAgent(a.id, i.body.mode, actorOf(p))) }; }),
    pauseAgent: mutate(async (p, i) => { const a = await agentFor(p, i.params.id); return { agent: await agentSummary(await pauseAgent(a.id, actorOf(p), i.body?.reason ?? '')) }; }),
    stopAgent: mutate(async (p, i) => { const a = await agentFor(p, i.params.id); const r = await stopAgent(a.id, actorOf(p), i.body?.reason ?? ''); return { agent: await agentSummary(r), windDown: r.windDown ?? null }; }),
    backtestAgent: mutate(async (p, i) => {
      const a = await agentFor(p, i.params.id);
      if (a.engine === 'supervisor') throw new UserError('wrong_kind', 'the risk-management agent has no backtest', 409);
      const versionId = i.body?.versionId ?? a.strategy_version_id ?? (await sql<{ id: string }[]>`select id from strategy_versions where agent_id = ${a.id} order by created_at desc limit 1`)[0]?.id ?? null;
      if (a.engine === 'bar' && !versionId) throw new UserError('no_strategy', 'this agent has no strategy version to backtest', 409);
      const j = await enqueue('backtest', { agentId: a.id, payload: a.engine === 'stream' ? { hours: i.body?.hours ?? 24 } : { versionId }, dedupeKey: `backtest:${a.id}:${a.engine === 'stream' ? 'recorded' : versionId}` });
      await audit('agent.backtest_requested', actorName(actorOf(p)), { id: a.id, job: j.id });
      return { job: jobView((await getJob(j.id))!), label: 'backtest' };
    }),
  };
}

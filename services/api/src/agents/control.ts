// STOP ALL AGENTS — the agents runtime's side of the port the execution layer consumes (orders/agent-control.ts
// `AgentControlPort { stopAll(reason) }`, used by the command engine). Bound by `bindExecution` (execution-bind.ts).
//
// Every agent that trades — spot, perp, stream — is stopped through `stopAgent` (lifecycle.ts), the one function the owner's
// routes and the trading API already use: a live perp agent's mandate is revoked and its positions closed with reduce-only
// orders, a live spot agent's mandate is revoked at the signer and its state set, a stream agent's simulated quotes are
// withdrawn. Stop only ever removes authority or activity. The risk-management agent places no order: it keeps watching.
import { sql } from '../db.ts';
import type { AgentControlPort } from '../orders/agent-control.ts';
import { stopAgent } from './lifecycle.ts';

export function agentControlPort(): AgentControlPort {
  return {
    async stopAll(reason) {
      const stopped: string[] = [], notStopped: { id: string; reason: string }[] = [];
      const agents = await sql<{ id: string }[]>`select id from agents where state in ('PAPER_TRADING', 'LIVE', 'PAUSED', 'RUNNING', 'STOPPING') and coalesce(kind, 'spot') <> 'supervisor' order by created_at`;
      for (const a of agents) {
        try { await stopAgent(a.id, { kind: 'owner' }, `STOP ALL AGENTS: ${reason}`.slice(0, 200)); stopped.push(a.id); }
        catch (e) { notStopped.push({ id: a.id, reason: `the agent could not be stopped: ${(e as Error).message.slice(0, 200)}` }); }
      }
      return { stopped, ...(notStopped.length ? { notStopped } : {}) };
    },
  };
}

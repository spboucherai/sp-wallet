// STOP ALL AGENTS (V11 exec2) — the narrow port between the command engine and the agents runtime.
//
// The default implementation uses ONLY what services/api/src/agents exports today, and edits nothing there:
//   perp agents   `perpMode(agent, 'STOPPED')` (agents/perp-routes.ts): the very function the owner's route calls — a paper agent
//                 is stopped; a live one is stopped through its live life cycle (mandate revoked, positions closed);
//   spot agents   there is NO exported function that sets a spot agent's state: that logic is inline in the handler of
//                 POST /api/v1/agents/:id/mode (agents/routes.ts). This port does not write the `agents` table behind the
//                 runtime's back. For a LIVE spot agent it calls the exported `revokeAgentMandate` (agents/live.ts): the signer
//                 then signs nothing more for that vault. Such an agent is reported in `notStopped`, with that reason — never as
//                 stopped: its state is still LIVE and its engine still ticks (every order is refused by the signer). A PAPER
//                 spot agent is reported in `notStopped` too.
// The gap is written for the agents workstream in docs/v11/work/exec2-notes-agents.md (export a `setAgentMode`).
import { sql } from '../db.ts';

export interface AgentControlResult { stopped: string[]; notStopped?: { id: string; reason: string }[] }
export interface AgentControlPort { stopAll(reason: string): Promise<AgentControlResult> }
export const SPOT_NOT_STOPPED = 'no exported function of the agents runtime stops a spot agent (the logic is inline in POST /api/v1/agents/:id/mode): stop it in the Agents screen';
export const SPOT_LIVE_REVOKED = `${SPOT_NOT_STOPPED}. Its vault mandate was revoked at the signer: the signer signs nothing more for this agent`;
export const SPOT_LIVE_REVOKE_FAILED = `${SPOT_NOT_STOPPED}. Its vault mandate could NOT be revoked at the signer (unreachable): the agents engine revokes mandates no live agent should hold at its next pass`;
const RUNNING = ['PAPER_TRADING', 'LIVE', 'PAUSED'];

export interface AgentControlDeps {
  /** agents/perp-routes.ts `perpMode` */ stopPerp: (agent: Record<string, unknown>) => Promise<unknown>;
  /** agents/live.ts `revokeAgentMandate`: true when the signer revoked */ revokeSpotMandate: (agent: { id: string; mandate_id: string | null }, reason: string) => Promise<boolean>;
}
export function agentControl(deps?: AgentControlDeps): AgentControlPort {
  const load = async (): Promise<AgentControlDeps> => deps ?? {
    stopPerp: async (a) => (await import('../agents/perp-routes.ts')).perpMode(a as never, 'STOPPED'),
    revokeSpotMandate: async (a, reason) => (await import('../agents/live.ts')).revokeAgentMandate(a, reason),
  };
  return {
    async stopAll(reason) {
      const d = await load(), stopped: string[] = [], notStopped: { id: string; reason: string }[] = [];
      const agents = await sql<Record<string, unknown>[]>`select * from agents where state in ${sql(RUNNING)} order by created_at`;
      for (const a of agents) {
        const id = String(a.id);
        if (a.kind === 'perp') {
          try { await d.stopPerp(a); stopped.push(id); } catch (e) { notStopped.push({ id, reason: `the perp agent could not be stopped: ${(e as Error).message.slice(0, 200)}` }); }
        } else if (a.state === 'LIVE' && a.mandate_id) {
          const ok = await d.revokeSpotMandate({ id, mandate_id: String(a.mandate_id) }, `STOP ALL AGENTS: ${reason}`.slice(0, 200)).catch(() => false);
          notStopped.push({ id, reason: ok ? SPOT_LIVE_REVOKED : SPOT_LIVE_REVOKE_FAILED });
        } else notStopped.push({ id, reason: SPOT_NOT_STOPPED });
      }
      return { stopped, ...(notStopped.length ? { notStopped } : {}) };
    },
  };
}

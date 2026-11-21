/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/control.ts
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

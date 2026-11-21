/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/execution-bind.ts
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

// The agents' binding to the EXECUTION LAYER of the process (V11: orders/, risk/, mandates/ — `Execution`).
//
//   bindExecution(ex)            one call per process (bindAgentRuntime, or a server instance when it becomes ready):
//                                  - the order gateway factory → `unifiedGatewayFactory(ex)`
//                                  - the kill switch port and read → `riskKillSwitch(ex)`: the risk engine's switch, the only one
//   unifiedGatewayFactory(ex)    which gateway an agent's tick gets:
//                                  perp agents (bar engine, paper and live)   UnifiedOrderGateway — orders.submitCanonical
//                                  spot agents, stream agents                 SeamOrderGateway — NOT unified orders (see below)
//   riskKillSwitch(ex)           engage → risk.engageKillSwitch({ kind: 'agent' | 'owner', id }, reason). There is no release
//                                here: releasing is risk.release(), which needs the owner's passkey (routes /api/v1/risk/…).
//
// Why two families stay on the seam gateway (docs/v11/work/agents-bind.md, item 1):
//   spot     the order service refuses spot for an agent principal (`spot_execution_requires_agent_vault`); the projection of
//            `agent_orders` into the unified table is the execution workstream's. The spot guard the execution layer installed
//            (`signerGuards.beforeMandateSign`) already stops a live swap while the ONE switch is engaged.
//   stream   a stream agent trades a SIMULATED book of its own (maker fills on recorded books), on venues the order service
//            refuses for everybody in any mode (dYdX, edgeX), with no wallet account a trading mandate could name.
// Both read the ONE kill switch (`KillSwitchRead` bound here), and neither can reach a venue through this path.
import type { Execution } from '../orders/index.ts';
import { GatewayError, SeamOrderGateway, setOrderGatewayFactory, type KillSwitchRead, type OrderGatewayFactory } from '../agent-runtime/gateway.ts';
import { setKillSwitch, type KillSwitchPort } from '../agent-runtime/kill-switch.ts';
import { agentControlPort } from './control.ts';
import { UnifiedOrderGateway } from './unified-gateway.ts';

let current: Execution | null = null;
/** the execution layer bound in this process; throws when nothing is bound (no order, no paper mandate without it) */
export function execution(): Execution {
  if (!current) throw new GatewayError('execution_unbound', 'the agents are not bound to the execution layer in this process');
  return current;
}
export const executionBound = (): Execution | null => current;

export const unifiedGatewayFactory = (ex: Execution): OrderGatewayFactory => (b) => ((b.agent.kind ?? 'spot') === 'perp' ? new UnifiedOrderGateway(b, ex) : new SeamOrderGateway(b));

export function riskKillSwitch(ex: Execution): { port: KillSwitchPort; read: KillSwitchRead } {
  return {
    port: {
      async engage(reason, by) {
        const before = await ex.risk.switches();
        if (before.killSwitch.on) return { engaged: true, at: before.killSwitch.at ?? 0, already: true };
        const s = await ex.risk.engageKillSwitch(by?.kind === 'owner' ? { kind: 'owner', id: 'owner' } : { kind: 'agent', id: by?.id ?? 'risk-manager' }, reason);
        return { engaged: true, at: s.killSwitch.at ?? ex.risk.now(), already: false };
      },
    },
    read: { engaged: async () => { const s = await ex.risk.switches(); return { engaged: s.killSwitch.on, reason: s.killSwitch.on ? s.killSwitch.reason : s.readOnly.reason, readOnly: s.readOnly.on }; } },
  };
}

export function bindExecution(ex: Execution | null, o: { gateway?: OrderGatewayFactory; killSwitch?: KillSwitchPort } = {}): void {
  current = ex;
  if (!ex) { setOrderGatewayFactory(o.gateway ?? null); setKillSwitch(o.killSwitch ?? null); return; }
  const ks = riskKillSwitch(ex);
  // STOP ALL AGENTS (the command engine): every trading agent, through the runtime's own stop (control.ts)
  ex.agents = agentControlPort();
  setOrderGatewayFactory(o.gateway ?? unifiedGatewayFactory(ex));
  setKillSwitch(o.killSwitch ?? ks.port, ks.read);
}

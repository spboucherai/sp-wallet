// The global kill switch as the agents see it. There is ONE switch: the risk engine's (services/api/src/risk/service.ts,
// settings key `risk.switches`). Nothing in the agent code holds a switch state of its own any more.
//
//   interface KillSwitchPort { engage(reason) }   the ONLY thing the risk-management agent may do to the switch. There is no
//                                                 `release` on the port, and no release anywhere in the agent code: the switch is
//                                                 released with the owner's passkey through the risk routes (/api/v1/risk/
//                                                 kill-switch/release/prepare → release), and nowhere else.
//   setKillSwitch(port, read)                     dependency injection: `bindAgentRuntime` binds both to the risk service of the
//                                                 process (`riskKillSwitch` in agents/execution-bind.ts).
//   killSwitchRead                                what the seam gateway consults before an order of a family whose orders are not
//                                                 unified orders yet (spot, stream). Orders that go through the unified order
//                                                 service are judged by the risk engine itself (`kill_switch`, `read_only`).
//
// Unbound (a script, a unit test that binds nothing): the READ still answers the one switch — it reads the risk engine's own
// record — and `engage` refuses loudly: an agent that cannot reach the risk service must not believe it halted anything.
import { getSetting } from '../db.ts';
import type { KillSwitchRead } from './gateway.ts';

export interface KillSwitchActor { kind: 'agent' | 'owner'; id: string }
export interface KillSwitchPort { engage(reason: string, by?: KillSwitchActor): Promise<{ engaged: true; at: number; already: boolean }> }
export interface KillSwitchState { engaged: boolean; reason: string | null; at: number | null; by: string | null; readOnly: boolean; readOnlyReason: string | null;
  /** where the switch is released: never here */
  release: { route: '/risk'; passkey: true } }

/** the risk engine's record (risk/service.ts `SWITCHES_KEY`); read-only from here */
export const RISK_SWITCHES_KEY = 'risk.switches';
/** the pre-V11.2 agents-side flag: migrated into the risk engine's record by db.ts, never read or written again */
export const LEGACY_AGENTS_KILL_SWITCH_KEY = 'agents.kill_switch';
interface StoredSwitch { on?: boolean; at?: number | null; by?: { kind: string; id: string } | null; reason?: string | null }

export async function killSwitchState(): Promise<KillSwitchState> {
  const s = await getSetting<{ killSwitch?: StoredSwitch; readOnly?: StoredSwitch } | null>(RISK_SWITCHES_KEY, null), k = s?.killSwitch, r = s?.readOnly;
  return { engaged: k?.on === true, reason: k?.on ? k.reason ?? null : null, at: k?.on ? k.at ?? null : null, by: k?.on && k.by ? `${k.by.kind}:${k.by.id}` : null, readOnly: r?.on === true, readOnlyReason: r?.on ? r.reason ?? null : null,
    release: { route: '/risk', passkey: true } };
}
const storedRead: KillSwitchRead = { engaged: async () => { const s = await killSwitchState(); return { engaged: s.engaged, reason: s.reason, readOnly: s.readOnly }; } };
const unboundPort: KillSwitchPort = { engage: async () => { throw new Error('the kill switch is not bound to the risk service in this process: nothing was engaged'); } };

let port: KillSwitchPort = unboundPort, read: KillSwitchRead = storedRead;
export function setKillSwitch(p: KillSwitchPort | null, r: KillSwitchRead | null = null): void { port = p ?? unboundPort; read = r ?? storedRead; }
export const killSwitch = (): KillSwitchPort => port;
/** what the seam gateway consults before every order (a stable object: the binding is read at call time) */
export const killSwitchRead: KillSwitchRead = { engaged: () => read.engaged() };

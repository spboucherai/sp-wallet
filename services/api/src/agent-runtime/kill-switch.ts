// The global kill switch as the agents see it.
//
//   interface KillSwitchPort { engage(reason) }   the ONLY thing the risk-management agent may do to the switch. There is no
//                                                 `release` on the port: an agent can never lift a halt.
//   localKillSwitch(deps)                         this branch's implementation, over what exists on the API side: a recorded
//                                                 switch state (settings `agents.kill_switch`) that the order gateway reads —
//                                                 while it is engaged only orders that reduce risk pass — plus the existing
//                                                 per-account halt of the venue accounts (`LiveService.halt`, which stops new
//                                                 orders and never a reduce-only one). The signer's emergency halt is NOT
//                                                 touched from here: it is one-way from the application and stays the owner's.
//   setKillSwitch()                               dependency injection: main.ts binds the local implementation; the execution
//                                                 workstream's risk service binds its own `engage`.
//
// Releasing is in kill-switch-admin.ts, which only the owner's routes import. The per-account halts the switch set are lifted
// by their own passkey flow (derivatives live routes): releasing the switch does not lift them.
import { audit, getSetting, setSetting } from '../db.ts';
import type { KillSwitchRead } from './gateway.ts';

export interface KillSwitchPort { engage(reason: string): Promise<{ engaged: true; at: number; already: boolean }> }
export interface KillSwitchState { engaged: boolean; reason: string | null; at: number | null; by: string | null; haltedAccounts: string[] }
export const KILL_SWITCH_KEY = 'agents.kill_switch';
const OFF: KillSwitchState = { engaged: false, reason: null, at: null, by: null, haltedAccounts: [] };

export const killSwitchState = (): Promise<KillSwitchState> => getSetting<KillSwitchState>(KILL_SWITCH_KEY, OFF);
/** what the order gateway consults before every order */
export const killSwitchRead: KillSwitchRead = { engaged: async () => { const s = await killSwitchState(); return { engaged: s.engaged, reason: s.reason }; } };

export interface LocalKillSwitchDeps {
  /** halt every venue account an agent trades on (the existing API-side halt); returns the ids halted. Never throws. */
  haltAccounts?: (reason: string) => Promise<string[]>;
  /** told once per engagement (webhook `risk.kill_switch`, alert) */
  notify?: (s: KillSwitchState) => Promise<void>;
  now?: () => number;
}
export function localKillSwitch(d: LocalKillSwitchDeps = {}, actor = 'agent:risk'): KillSwitchPort {
  return {
    async engage(reason: string) {
      const cur = await killSwitchState();
      if (cur.engaged) return { engaged: true, at: cur.at ?? 0, already: true };
      const at = (d.now ?? Date.now)();
      // the switch is recorded FIRST: from this line on the gateway refuses whatever adds risk, whatever happens next
      const next: KillSwitchState = { engaged: true, reason: reason.slice(0, 300), at, by: actor, haltedAccounts: [] };
      await setSetting(KILL_SWITCH_KEY, next);
      next.haltedAccounts = await (d.haltAccounts?.(reason).catch(() => []) ?? Promise.resolve([]));
      await setSetting(KILL_SWITCH_KEY, next);
      await audit('agents.kill_switch_engaged', actor, { reason: next.reason, haltedAccounts: next.haltedAccounts });
      await d.notify?.(next).catch(() => {});
      return { engaged: true, at, already: false };
    },
  };
}

let port: KillSwitchPort = localKillSwitch();
export function setKillSwitch(p: KillSwitchPort | null): void { port = p ?? localKillSwitch(); }
export const killSwitch = (): KillSwitchPort => port;

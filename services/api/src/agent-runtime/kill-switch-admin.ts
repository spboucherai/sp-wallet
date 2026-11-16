// Releasing the agents' kill switch: an OWNER action (session routes only — never an API key, never an agent). Kept in its own
// module so that the agent runtime cannot import it (test: agent-boundaries.test.ts). Venue accounts the switch halted keep
// their halt: lifting an account halt needs the passkey, through the derivatives live routes (V11 Phase B, item 8).
import { audit, setSetting } from '../db.ts';
import { KILL_SWITCH_KEY, killSwitchState, type KillSwitchState } from './kill-switch.ts';

export async function releaseKillSwitch(actor: 'owner'): Promise<KillSwitchState & { stillHaltedAccounts: string[] }> {
  const cur = await killSwitchState();
  const next: KillSwitchState = { engaged: false, reason: null, at: null, by: null, haltedAccounts: [] };
  await setSetting(KILL_SWITCH_KEY, next);
  if (cur.engaged) await audit('agents.kill_switch_released', actor, { was: { reason: cur.reason, at: cur.at, by: cur.by }, stillHaltedAccounts: cur.haltedAccounts });
  return { ...next, stillHaltedAccounts: cur.haltedAccounts };
}

// The Risk Management agent: a supervisor over every other agent, PER MODE (paper figures and live figures are computed and
// judged separately; nothing is added across modes).
//
//   it READS     exposure, equity against capital, drawdown from the peak, loss of the day, distance to liquidation, funding
//                paid over 24 h — of each agent and of the portfolio of one mode
//   it PROPOSES  reductions and pauses: a journal line on its own timeline and on the agent's, an alert (the alert dispatcher
//                tails the journal) and a webhook (`risk.proposal`)
//   it may ACT   in exactly two ways, and only when its own mode allows it (research: never; paper: on PAPER agents; live: on
//                PAPER and LIVE agents):   (i) PAUSE another agent   (ii) ENGAGE the global kill switch (`KillSwitchPort`).
//   it NEVER     places an order, opens or increases risk, starts or resumes an agent, releases a halt, lifts the kill switch,
//                touches a mandate. The ports it is given have no function that could (test: agent-risk-supervisor.test.ts and
//                agent-boundaries.test.ts).
//
// `evaluatePortfolio` is pure: snapshots in, findings out.
import type { KillSwitchPort } from './kill-switch.ts';
import type { Mode } from './model.ts';

export interface SupervisorLimits { maxGrossUsd: number; maxAgentDrawdownPct: number; maxPortfolioDailyLossPct: number; minLiquidationDistanceBps: number; maxFundingBleedBpsPerDay: number; killSwitchDailyLossPct: number }
export interface AgentSnapshot {
  agentId: string; name: string; mode: 'paper' | 'live'; lifecycle: 'active' | 'paused' | 'stopped';
  capitalUsd: number; equityUsd: number | null; peakEquityUsd: number | null; dayStartEquityUsd: number | null;
  grossUsd: number | null; minLiquidationDistanceBps: number | null; funding24hUsd: number | null;
  /** what could not be read (the agent is judged on what is known; an unreadable LIVE account is itself a finding) */
  unreadable: string | null;
}
export type FindingAction = 'reduce' | 'pause' | 'kill_switch';
export interface Finding { key: string; mode: 'paper' | 'live'; agentId: string | null; action: FindingAction; code: string; severity: 'warning' | 'error'; message: string; metrics: Record<string, number | null> }
const pct = (x: number): string => `${x.toFixed(2)} %`;

/** Findings for the agents of ONE mode. Pure. */
export function evaluatePortfolio(mode: 'paper' | 'live', agents: AgentSnapshot[], lim: SupervisorLimits): Finding[] {
  const out: Finding[] = [], mine = agents.filter((a) => a.mode === mode && a.lifecycle !== 'stopped');
  const f = (agentId: string | null, action: FindingAction, code: string, severity: Finding['severity'], message: string, metrics: Finding['metrics']): void => { out.push({ key: `${mode}|${agentId ?? '*'}|${code}`, mode, agentId, action, code, severity, message, metrics }); };
  for (const a of mine) {
    if (a.unreadable && mode === 'live') f(a.agentId, 'pause', 'account_unreadable', 'warning', `${a.name}: its ${mode} account cannot be read (${a.unreadable}) — it should not add exposure blind`, {});
    if (a.equityUsd !== null && a.peakEquityUsd !== null && a.peakEquityUsd > 0) {
      const dd = 100 * (1 - a.equityUsd / a.peakEquityUsd);
      if (dd >= lim.maxAgentDrawdownPct) f(a.agentId, 'pause', 'agent_drawdown', 'error', `${a.name}: drawdown ${pct(dd)} from its peak equity (${a.peakEquityUsd.toFixed(2)} → ${a.equityUsd.toFixed(2)} USD), limit ${pct(lim.maxAgentDrawdownPct)}`, { drawdownPct: dd, equityUsd: a.equityUsd, peakEquityUsd: a.peakEquityUsd });
    }
    if (a.minLiquidationDistanceBps !== null && a.minLiquidationDistanceBps < lim.minLiquidationDistanceBps) {
      f(a.agentId, 'reduce', 'liquidation_distance', 'error', `${a.name}: a position is ${a.minLiquidationDistanceBps.toFixed(0)} bps from its liquidation price (minimum ${lim.minLiquidationDistanceBps} bps): reduce it`, { liquidationDistanceBps: a.minLiquidationDistanceBps });
    }
    if (a.funding24hUsd !== null && a.equityUsd !== null && a.equityUsd > 0 && a.funding24hUsd < 0) {
      const bleed = (-a.funding24hUsd / a.equityUsd) * 1e4;
      if (bleed > lim.maxFundingBleedBpsPerDay) f(a.agentId, 'reduce', 'funding_bleed', 'warning', `${a.name}: paid ${(-a.funding24hUsd).toFixed(2)} USD of funding in 24 h (${bleed.toFixed(1)} bps of its equity, limit ${lim.maxFundingBleedBpsPerDay} bps)`, { fundingBleedBps: bleed, funding24hUsd: a.funding24hUsd });
    }
  }
  // the portfolio of this mode
  const gross = mine.reduce((s, a) => s + (a.grossUsd ?? 0), 0);
  if (gross > lim.maxGrossUsd) {
    const top = [...mine].sort((x, y) => (y.grossUsd ?? 0) - (x.grossUsd ?? 0))[0];
    f(top?.agentId ?? null, 'reduce', 'gross_exposure', 'warning', `${mode} agents hold ${gross.toFixed(2)} USD of gross exposure together (limit ${lim.maxGrossUsd}); the largest is ${top?.name ?? '?'} (${(top?.grossUsd ?? 0).toFixed(2)} USD): reduce it`, { grossUsd: gross });
  }
  const known = mine.filter((a) => a.equityUsd !== null && a.dayStartEquityUsd !== null), start = known.reduce((s, a) => s + a.dayStartEquityUsd!, 0), now = known.reduce((s, a) => s + a.equityUsd!, 0);
  if (start > 0) {
    const loss = 100 * (1 - now / start);
    if (mode === 'live' && loss >= lim.killSwitchDailyLossPct) f(null, 'kill_switch', 'portfolio_daily_loss_kill', 'error', `LIVE agents lost ${pct(loss)} today (${start.toFixed(2)} → ${now.toFixed(2)} USD), at or beyond the kill-switch level ${pct(lim.killSwitchDailyLossPct)}`, { dailyLossPct: loss });
    else if (loss >= lim.maxPortfolioDailyLossPct) for (const a of known.filter((x) => x.lifecycle === 'active')) f(a.agentId, 'pause', 'portfolio_daily_loss', 'error', `${mode} agents lost ${pct(loss)} today together (limit ${pct(lim.maxPortfolioDailyLossPct)}): ${a.name} should stop adding exposure`, { dailyLossPct: loss });
  }
  return out;
}

/** What the supervisor may touch. There is deliberately nothing here that starts, resumes, orders, releases or approves. */
export interface SupervisorPorts {
  snapshots(): Promise<AgentSnapshot[]>;
  /** journal + alert + webhook; never changes anything */
  propose(f: Finding, acted: 'proposed' | 'paused' | 'kill_switch' | 'not_allowed' | 'failed', note: string): Promise<void>;
  /** permitted action (i): pause another agent */
  pause(agentId: string, reason: string): Promise<void>;
  /** permitted action (ii) */
  killSwitch: KillSwitchPort;
  now(): number;
}
export interface SupervisorState { announced?: Record<string, number> }
export const REANNOUNCE_MS = 3_600_000;

/** One pass of the supervisor in its own mode. Returns what it found and what it did; `state` remembers what was already said. */
export async function supervise(own: { mode: Mode; act: boolean; limits: SupervisorLimits }, state: SupervisorState, p: SupervisorPorts): Promise<{ findings: Finding[]; actions: { key: string; action: string; ok: boolean; note: string }[]; state: SupervisorState }> {
  const snaps = await p.snapshots(), now = p.now(), announced = { ...(state.announced ?? {}) };
  const findings = [...evaluatePortfolio('paper', snaps, own.limits), ...evaluatePortfolio('live', snaps, own.limits)];
  const actions: { key: string; action: string; ok: boolean; note: string }[] = [];
  const live = new Set(findings.map((f) => f.key));
  for (const k of Object.keys(announced)) if (!live.has(k)) delete announced[k];              // the condition is gone: it will be said again if it comes back
  for (const f of findings) {
    if (announced[f.key] && now - announced[f.key]! < REANNOUNCE_MS) continue;
    announced[f.key] = now;
    // research: proposes only. paper: may act on paper agents. live: on both. `act` (the owner's setting) must be on.
    const allowed = own.act && own.mode !== 'research' && (f.mode === 'paper' || own.mode === 'live');
    let acted: Parameters<SupervisorPorts['propose']>[1] = 'proposed', note = 'proposal only';
    if (f.action === 'reduce') note = 'a reduction is the owner\'s (or the agent\'s own engine\'s) to make: the supervisor places no order';
    else if (!allowed) { acted = 'not_allowed'; note = own.act ? `the supervisor runs in ${own.mode} mode: it does not act on ${f.mode} agents` : 'acting is switched off for this supervisor: proposal only'; }
    else {
      try {
        if (f.action === 'pause' && f.agentId) { await p.pause(f.agentId, f.message); acted = 'paused'; note = 'the agent was paused'; }
        else if (f.action === 'kill_switch') { const r = await p.killSwitch.engage(f.message); acted = 'kill_switch'; note = r.already ? 'the kill switch was already engaged' : 'the kill switch was engaged'; }
      } catch (e) { acted = 'failed'; note = `the action failed: ${(e as Error).message.slice(0, 200)}`; }
    }
    actions.push({ key: f.key, action: acted, ok: acted !== 'failed', note });
    await p.propose(f, acted, note).catch(() => {});
  }
  return { findings, actions, state: { announced } };
}

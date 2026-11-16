// The seven built-in agents as templates, bound to REAL code paths:
//   bar templates (stat-arb, momentum, mean-reversion)       a laboratory strategy found BY NAME in the strategy library
//                                                            (agent-runtime/model.ts TEMPLATES[].strategies, first installed
//                                                            first). None installed → `installed: []`: the template says
//                                                            "strategy not installed" — there is no placeholder strategy.
//   stream templates (funding-arb, market-making, cross-exchange)   a TypeScript rule of the stream engine (families.ts)
//   supervisor (risk-manager)                                the portfolio supervisor (risk-supervisor.ts)
import { z } from 'zod';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { FAMILY_MODES, LIVE_PINNED, matchesStrategyName, RULES, ruleHash, template, TEMPLATES, type AgentTemplate } from '../agent-runtime/model.ts';
import { agentSummary, bumpConfig, insertRuntimeAgent, loadAgent } from '../agent-runtime/store.ts';
import { perpLibrary, type PerpStrategyInfo } from './perp-strategies.ts';

export interface InstalledStrategy { path: string; name: string; version: string; sha256: string; universe: string[]; interval: string; spotLegs: boolean;
  /** every instrument is in the signer's pinned table (BTC, ETH, SOL): an agent on this version can be proposed a live mandate */
  liveCapable: boolean; liveReason: string | null }
const liveOf = (s: Pick<PerpStrategyInfo, 'meta' | 'spotLegs'>): { liveCapable: boolean; liveReason: string | null } => {
  if (s.spotLegs) return { liveCapable: false, liveReason: 'holds spot legs next to the perpetuals: a perp agent cannot run it' };
  const off = s.meta.universe.filter((u) => !(LIVE_PINNED as readonly string[]).includes(u));
  return off.length ? { liveCapable: false, liveReason: `its universe includes ${off.join(', ')}, outside the signer's pinned instruments (${LIVE_PINNED.join(', ')}); an agent runs a perp strategy only on its exact universe, so it stays on paper` } : { liveCapable: true, liveReason: null };
};
const dirOf = (path: string): string => path.split('/')[1] ?? '';

let cache: { at: number; list: PerpStrategyInfo[] } | null = null;
/** the perp library (manifest-filtered), cached for a minute: one laboratory process per version otherwise */
export async function installedPerp(library: () => Promise<PerpStrategyInfo[]> = perpLibrary): Promise<PerpStrategyInfo[]> {
  if (library !== perpLibrary) return library();
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), list: await perpLibrary().catch(() => []) };
  return cache.list;
}

export async function templatesView(library?: () => Promise<PerpStrategyInfo[]>) {
  const lib = TEMPLATES.some((t) => t.engine === 'bar') ? await installedPerp(library) : [];
  return TEMPLATES.map((t) => {
    const installed: InstalledStrategy[] = t.strategies.flatMap((name) => lib.filter((s) => matchesStrategyName(dirOf(s.path), name) && !s.spotLegs))
      .map((s) => ({ path: s.path.replace(/^strategies\//, ''), name: s.meta.name, version: s.meta.version, sha256: s.sha256, universe: s.meta.universe, interval: s.meta.interval, spotLegs: s.spotLegs, ...liveOf(s) }));
    const backtestInstalled = t.backtestStrategies.filter((name) => lib.some((s) => matchesStrategyName(dirOf(s.path), name)));
    const fm = FAMILY_MODES[t.family];
    return { id: t.id, family: t.family, engine: t.engine, kind: t.kind, name: t.name, summary: t.summary, modes: fm.modes, liveReason: fm.liveReason,
      strategyNames: t.strategies, installed, strategyInstalled: t.engine !== 'bar' || installed.length > 0,
      rule: t.rule ? { name: t.rule, version: RULES[t.rule]!.version, sha256: ruleHash(t.rule) } : null,
      labBacktest: { wanted: t.backtestStrategies, installed: backtestInstalled }, defaults: t.defaults };
  });
}

export const FromTemplateBody = z.strictObject({
  template: z.string().min(2).max(40), name: z.string().min(2).max(40), mission: z.string().max(400).default(''),
  /** bar templates: the library path of the strategy version to bind (one of the template's `installed`); default = the first installed */
  strategyPath: z.string().regex(/^[a-z0-9_]{1,40}\/[a-z0-9_]{1,12}$/).optional(),
  /** stream templates: the base asset (one) and the venues (one for market making, two otherwise) */
  universe: z.array(z.string().regex(/^[A-Z0-9]{2,10}$/)).min(1).max(8).optional(), venues: z.array(z.enum(['hyperliquid', 'edgex', 'dydx', 'gmx'])).min(1).max(2).optional(),
  capitalUsdc: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/).optional(), risk: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(), config: z.record(z.string(), z.unknown()).optional(),
});

const NUM = (v: unknown, min: number, max: number, what: string): number => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new UserError('bad_request', `${what} must be between ${min} and ${max}`, 400); return n; };
function streamRisk(t: AgentTemplate, r: Record<string, unknown> | undefined): Record<string, number> {
  const d = { ...t.defaults.risk, ...(r ?? {}) } as Record<string, unknown>;
  if (t.kind === 'supervisor') return { maxGrossUsd: NUM(d.maxGrossUsd, 10, 10_000_000, 'maxGrossUsd'), maxAgentDrawdownPct: NUM(d.maxAgentDrawdownPct, 0.5, 90, 'maxAgentDrawdownPct'), maxPortfolioDailyLossPct: NUM(d.maxPortfolioDailyLossPct, 0.1, 90, 'maxPortfolioDailyLossPct'),
    minLiquidationDistanceBps: NUM(d.minLiquidationDistanceBps, 50, 9000, 'minLiquidationDistanceBps'), maxFundingBleedBpsPerDay: NUM(d.maxFundingBleedBpsPerDay, 0.1, 1000, 'maxFundingBleedBpsPerDay'), killSwitchDailyLossPct: NUM(d.killSwitchDailyLossPct, 0.5, 95, 'killSwitchDailyLossPct') };
  return { maxPositionUsd: NUM(d.maxPositionUsd, 10, 1_000_000, 'maxPositionUsd'), maxGrossUsd: NUM(d.maxGrossUsd, 10, 5_000_000, 'maxGrossUsd'), maxDailyLossPct: NUM(d.maxDailyLossPct, 0.1, 50, 'maxDailyLossPct'), maxTotalLossPct: NUM(d.maxTotalLossPct, 0.1, 90, 'maxTotalLossPct'),
    maxDataAgeMs: NUM(d.maxDataAgeMs, 250, 120_000, 'maxDataAgeMs') };
}
/** the configuration of a rule: the template's keys only, each a finite number within sane bounds (a string is kept for decimal fields) */
function ruleConfig(t: AgentTemplate, c: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...t.defaults.config };
  for (const [k, v] of Object.entries(c ?? {})) {
    if (!(k in t.defaults.config)) throw new UserError('bad_request', `unknown configuration key ${k} for ${t.id} (known: ${Object.keys(t.defaults.config).join(', ')})`, 400);
    if (typeof t.defaults.config[k] === 'boolean') { out[k] = v === true; continue; }
    const n = NUM(v, 0, 1e9, k);
    if (k === 'decisionEveryMs' && n < 1000) throw new UserError('bad_request', 'decisionEveryMs is at least 1000', 400);
    out[k] = typeof t.defaults.config[k] === 'string' ? String(v) : n;
  }
  return out;
}

/** Create an agent from a template. Nothing is signed; the agent starts STOPPED in research mode (a perp one on its paper account). */
export async function createFromTemplate(body: unknown, actor: string, library?: () => Promise<PerpStrategyInfo[]>) {
  const b = FromTemplateBody.parse(body), t = template(b.template);
  if (!t) throw new UserError('unknown_template', `unknown template; one of ${TEMPLATES.map((x) => x.id).join(', ')}`, 404);
  if (t.engine === 'bar') {
    const view = (await templatesView(library)).find((x) => x.id === t.id)!;
    if (!view.installed.length) throw new UserError('strategy_not_installed', `no strategy of the ${t.name.en} template is installed in the laboratory (wanted, by name: ${t.strategies.join(', ')}). Nothing was created.`, 409);
    const pick = b.strategyPath ? view.installed.find((s) => s.path === b.strategyPath) : view.installed[0];
    if (!pick) throw new UserError('bad_request', `${b.strategyPath} is not one of this template's installed strategies (${view.installed.map((s) => s.path).join(', ')})`, 400);
    if (b.universe && [...b.universe].sort().join() !== [...pick.universe].sort().join()) throw new UserError('universe_mismatch', `${pick.path} trades ${pick.universe.join(', ')} and nothing else: a perp strategy runs on its exact universe`, 422);
    const p = await import('./perp-routes.ts');
    const created = await p.createPerpAgent({ kind: 'perp', name: b.name, mission: b.mission, instruments: pick.universe, interval: pick.interval, capitalUsdc: b.capitalUsdc ?? t.defaults.capitalUsdc, risk: { ...t.defaults.risk, ...(b.risk ?? {}) } });
    await sql`update agents set family = ${t.family}, template = ${t.id}, engine = 'bar', mode = 'RESEARCH' where id = ${created.id}`;
    await bumpConfig(created.id, actor, `created from the ${t.id} template`);
    const reg = await (await import('./strategies.ts')).registerStrategy(created.id, pick.path, actor);
    return { agent: await agentSummary(await loadAgent(created.id)), strategy: { ...pick, versionId: reg.id, status: reg.status }, warnings: created.warnings };
  }
  if (t.kind === 'supervisor') {
    const row = await insertRuntimeAgent({ kind: 'supervisor', family: t.family, template: t.id, name: b.name, mission: b.mission, universe: [], venues: [], rule: t.rule!, config: ruleConfig(t, b.config), risk: streamRisk(t, b.risk), capitalUsdc: '0', actor });
    return { agent: await agentSummary(row), strategy: null, warnings: [] };
  }
  const venues = b.venues ?? t.defaults.venues, universe = b.universe ?? t.defaults.universe, need = t.rule === 'spread_inventory' ? 1 : 2;
  if (venues.length !== need || new Set(venues).size !== need) throw new UserError('bad_request', `${t.name.en} needs ${need} ${need === 1 ? 'venue' : 'different venues'}`, 400);
  if (universe.length !== 1) throw new UserError('bad_request', 'a stream agent trades ONE base asset (the same contract on each venue)', 400);
  if (t.rule === 'spread_inventory' && venues[0] === 'gmx') throw new UserError('bad_request', 'GMX has no order book: market making cannot be simulated on it', 422);
  const capital = b.capitalUsdc ?? t.defaults.capitalUsdc;
  if (Number(capital) < 50) throw new UserError('bad_request', 'at least 50 USDC of simulated capital', 400);
  const row = await insertRuntimeAgent({ kind: 'stream', family: t.family, template: t.id, name: b.name, mission: b.mission, universe, venues, rule: t.rule!, config: ruleConfig(t, b.config), risk: streamRisk(t, b.risk), capitalUsdc: capital, actor });
  return { agent: await agentSummary(row), strategy: null, warnings: [{ code: 'no_live', message: FAMILY_MODES[t.family].liveReason ?? '' }] };
}

/** Replace the rule configuration and/or the limits of a stream or supervisor agent: a new configuration version. Not while it runs. */
export async function updateRuntimeConfig(id: string, body: unknown, actor: string) {
  const b = z.strictObject({ config: z.record(z.string(), z.unknown()).optional(), risk: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional() }).parse(body);
  const a = await loadAgent(id), t = template(a.template ?? '');
  if (!t || t.engine === 'bar') throw new UserError('wrong_kind', 'the limits of a spot or perp agent are changed on its own page', 409);
  if (['PAPER_TRADING', 'RUNNING', 'LIVE'].includes(a.state)) throw new UserError('bad_state', 'pause or stop the agent before changing its configuration', 409);
  const cur = (a.runtime ?? {}) as { config?: Record<string, unknown> };
  const config = b.config ? ruleConfig(t, { ...cur.config, ...b.config }) : cur.config ?? t.defaults.config, risk = b.risk ? streamRisk(t, { ...a.risk, ...b.risk }) : a.risk;
  await sql`update agents set risk = ${sql.json(risk as never)}, runtime = coalesce(runtime, '{}'::jsonb) || ${sql.json({ config } as never)}, updated_at = now() where id = ${a.id}`;
  const version = await bumpConfig(a.id, actor, 'configuration or limits replaced');
  return { agent: await agentSummary(await loadAgent(a.id)), configVersion: version };
}

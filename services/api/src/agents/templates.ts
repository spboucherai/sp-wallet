// The seven built-in agents as templates, bound to REAL code paths:
//   bar templates (stat-arb, momentum, mean-reversion)       a laboratory strategy found BY NAME in the strategy library
//                                                            (agent-runtime/model.ts TEMPLATES[].strategies, first installed
//                                                            first). None installed → `installed: []`: the template says
//                                                            "strategy not installed" — there is no placeholder strategy.
//                                                            A GENERIC strategy (universe ['*']) runs on the instruments
//                                                            the AGENT is given (body.universe, default: the template's).
//   stream templates (funding-arb, market-making, cross-exchange)   a TypeScript rule of the stream engine (families.ts)
//   supervisor (risk-manager)                                the portfolio supervisor (risk-supervisor.ts)
import { z } from 'zod';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { FAMILY_MODES, LIVE_PINNED, matchesStrategy, matchesStrategyName, RULES, ruleHash, strategyNamesOf, template, TEMPLATES, type AgentTemplate } from '../agent-runtime/model.ts';
import { agentSummary, bumpConfig, insertRuntimeAgent, loadAgent } from '../agent-runtime/store.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RESEARCH_DIR } from './lab.ts';
import { labVerdictsFor } from './lab-verdicts.ts';
import { fitsPerpAgent, isGenericPerp, perpLibrary, type PerpStrategyInfo } from './perp-strategies.ts';

export interface InstalledStrategy { path: string; name: string; version: string; sha256: string; universe: string[]; interval: string; spotLegs: boolean;
  /** universe ['*']: the instruments are the agent's — between minSymbols and maxSymbols of them; `defaultUniverse` is what the template proposes */
  generic: boolean; minSymbols: number; maxSymbols: number; defaultUniverse: string[] | null;
  /** fixed universe: every instrument is in the signer's pinned table (BTC, ETH, SOL), an agent on this version can be proposed a
   *  live mandate. Generic universe: true, CONDITIONALLY — see `liveCondition`; the agent's own instruments decide (liveVerdict). */
  liveCapable: boolean; liveReason: string | null; liveCondition: string | null }
const genericOf = (s: Pick<PerpStrategyInfo, 'meta'> & Partial<Pick<PerpStrategyInfo, 'generic' | 'minSymbols' | 'maxSymbols'>>) => {
  const generic = s.generic ?? isGenericPerp(s.meta.universe);
  return { generic, minSymbols: generic ? s.minSymbols ?? s.meta.min_symbols ?? 1 : s.meta.universe.length, maxSymbols: generic ? s.maxSymbols ?? Math.min(s.meta.max_symbols ?? 8, 8) : s.meta.universe.length };
};
const liveOf = (s: Pick<PerpStrategyInfo, 'meta' | 'spotLegs'> & Partial<Pick<PerpStrategyInfo, 'generic'>>): { liveCapable: boolean; liveReason: string | null; liveCondition: string | null } => {
  if (s.spotLegs) return { liveCapable: false, liveReason: 'holds spot legs next to the perpetuals: a perp agent cannot run it', liveCondition: null };
  // a generic universe has no instruments of its own: the AGENT's decide, one agent at a time
  if (s.generic ?? isGenericPerp(s.meta.universe)) return { liveCapable: true, liveReason: null, liveCondition: `generic universe: an agent on this version can go live only if ALL its instruments are among ${LIVE_PINNED.join(', ')} (the signer's pinned instruments); with any other instrument it stays on paper` };
  const off = s.meta.universe.filter((u) => !(LIVE_PINNED as readonly string[]).includes(u));
  return off.length ? { liveCapable: false, liveReason: `its universe includes ${off.join(', ')}, outside the signer's pinned instruments (${LIVE_PINNED.join(', ')}); an agent runs a fixed-universe strategy only on its exact universe, so it stays on paper`, liveCondition: null } : { liveCapable: true, liveReason: null, liveCondition: null };
};
const dirOf = (path: string): string => path.split('/')[1] ?? '';

let cache: { at: number; list: PerpStrategyInfo[] } | null = null;
/** the perp library (manifest-filtered), cached for a minute: one laboratory process per version otherwise */
export async function installedPerp(library: () => Promise<PerpStrategyInfo[]> = perpLibrary): Promise<PerpStrategyInfo[]> {
  if (library !== perpLibrary) return library();
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), list: await perpLibrary().catch(() => []) };
  return cache.list;
}

/** the default instruments of a generic strategy under a template: the template's, cut to the strategy's bounds (null: they do not fit) */
function defaultUniverse(t: AgentTemplate, g: { minSymbols: number; maxSymbols: number }): string[] | null {
  const u = t.defaults.universe.slice(0, g.maxSymbols);
  return u.length >= g.minSymbols ? u : null;
}
/** is a laboratory reference (a strategy no agent runs, a study, a policy) present in this installation, and where? */
const labWhere = (name: string): 'strategies' | 'strategies_xvenue' | 'studies' | null =>
  (['strategies', 'strategies_xvenue', 'studies'] as const).find((d) => /^[a-z0-9_]{1,40}$/.test(name) && existsSync(path.join(RESEARCH_DIR, d, name))) ?? null;

export async function templatesView(library?: () => Promise<PerpStrategyInfo[]>) {
  const lib = TEMPLATES.some((t) => t.engine === 'bar') ? await installedPerp(library) : [];
  const rel = (s: PerpStrategyInfo): string => s.path.replace(/^strategies\//, '');
  return TEMPLATES.map((t) => {
    // in the template's order of preference (`name/version` entries first as written, then every other version of a name), once each
    const seen = new Set<string>(), installed: InstalledStrategy[] = [];
    for (const wanted of t.strategies) for (const s of lib) {
      if (s.spotLegs || seen.has(s.path) || !matchesStrategy(rel(s), wanted)) continue;
      seen.add(s.path); const g = genericOf(s);
      installed.push({ path: rel(s), name: s.meta.name, version: s.meta.version, sha256: s.sha256, universe: s.meta.universe, interval: s.meta.interval, spotLegs: s.spotLegs, ...g, defaultUniverse: g.generic ? defaultUniverse(t, g) : null, ...liveOf(s) });
    }
    // references no agent can run: listed when the laboratory has them (research/strategies with spot legs, research/strategies_xvenue)
    const backtestInstalled = t.backtestStrategies.filter((name) => lib.some((s) => matchesStrategyName(dirOf(s.path), name)) || labWhere(name) === 'strategies_xvenue');
    const fm = FAMILY_MODES[t.family];
    return { id: t.id, family: t.family, engine: t.engine, kind: t.kind, name: t.name, summary: t.summary, modes: fm.modes, liveReason: fm.liveReason,
      strategyNames: strategyNamesOf(t.strategies), installed, strategyInstalled: t.engine !== 'bar' || installed.length > 0,
      rule: t.rule ? { name: t.rule, version: RULES[t.rule]!.version, sha256: ruleHash(t.rule) } : null,
      /** laboratory strategies that document the family and that NO agent can run (two venues, spot legs): backtest / research reference only */
      labBacktest: { wanted: t.backtestStrategies, installed: backtestInstalled, agentRunnable: false as const },
      /** model studies and policies of the laboratory behind the family (research/studies): not strategies */
      labStudies: t.labStudies.map((x) => ({ ...x, installed: labWhere(x.name) === 'studies' })),
      /** the laboratory's out-of-sample results for the template's strategies, references and studies — read from its files
       *  (lab-verdicts.ts); BACKTEST figures, never a promise. `available: false` when the files are not in this installation. */
      labVerdicts: labVerdictsFor([...t.strategies, ...t.backtestStrategies], t.labStudies),
      defaults: t.defaults };
  });
}

export const FromTemplateBody = z.strictObject({
  template: z.string().min(2).max(40), name: z.string().min(2).max(40), mission: z.string().max(400).default(''),
  /** bar templates: the library path of the strategy version to bind (one of the template's `installed`); default = the first installed */
  strategyPath: z.string().regex(/^[a-z0-9_]{1,40}\/[a-z0-9_]{1,12}$/).optional(),
  /** stream templates: the base asset (one) and the venues (one for market making, two otherwise).
   *  bar templates: the agent's instruments — needed by a GENERIC strategy (default: the template's), and for a fixed one it must equal the strategy's universe */
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
    let instruments = pick.universe;
    if (pick.generic) {
      // a generic strategy has no list of its own: the agent's instruments come from the body (default: the template's) and are checked against its bounds
      const u = b.universe ?? pick.defaultUniverse;
      if (!u) throw new UserError('universe_required', `${pick.path} is universe-generic and needs between ${pick.minSymbols} and ${pick.maxSymbols} instruments: give them in "universe"`, 422);
      if (new Set(u).size !== u.length) throw new UserError('bad_request', 'duplicate instrument', 400);
      const fit = fitsPerpAgent({ spotLegs: pick.spotLegs, generic: true, minSymbols: pick.minSymbols, maxSymbols: pick.maxSymbols, meta: { universe: pick.universe, interval: pick.interval } as PerpStrategyInfo['meta'] }, u, pick.interval);
      if (!fit.ok) throw new UserError(fit.code, fit.message, 422);
      instruments = u;
    } else if (b.universe && [...b.universe].sort().join() !== [...pick.universe].sort().join()) throw new UserError('universe_mismatch', `${pick.path} trades ${pick.universe.join(', ')} and nothing else: a fixed-universe perp strategy runs on its exact universe`, 422);
    const p = await import('./perp-routes.ts');
    const created = await p.createPerpAgent({ kind: 'perp', name: b.name, mission: b.mission, instruments, interval: pick.interval, capitalUsdc: b.capitalUsdc ?? t.defaults.capitalUsdc, risk: { ...t.defaults.risk, ...(b.risk ?? {}) } });
    await sql`update agents set family = ${t.family}, template = ${t.id}, engine = 'bar', mode = 'RESEARCH' where id = ${created.id}`;
    await bumpConfig(created.id, actor, `created from the ${t.id} template`);
    const reg = await (await import('./strategies.ts')).registerStrategy(created.id, pick.path, actor);
    return { agent: await agentSummary(await loadAgent(created.id)), strategy: { ...pick, instruments, versionId: reg.id, status: reg.status }, warnings: created.warnings };
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

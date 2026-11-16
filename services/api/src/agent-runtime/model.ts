// V11 agent model. One vocabulary for every agent, whatever engine runs it:
//
//   family     momentum | mean_reversion | stat_arb | funding_arb | market_making | cross_exchange | risk_manager | custom
//   engine     bar (the two existing engines: closed 1h/4h/1d bars, a hash-pinned Python strategy)
//              stream (agent-runtime/stream-engine.ts: sub-bar, driven by the venues' streams, a deterministic TypeScript rule)
//              supervisor (agent-runtime/risk-supervisor.ts: reads the other agents, proposes, may only pause and halt)
//   mode       research (analysis and backtests, never an order) | paper (explicit simulation) | live (a venue, under a mandate)
//   lifecycle  active | paused | stopped   — a projection of the historical `agents.state` values, which stay as they are
//
// This file is pure (no database, no signer): the tables of what exists and what may go live, and nothing that acts.
import { createHash } from 'node:crypto';

export const FAMILIES = ['momentum', 'mean_reversion', 'stat_arb', 'funding_arb', 'market_making', 'cross_exchange', 'risk_manager', 'custom'] as const;
export type Family = (typeof FAMILIES)[number];
export const ENGINES = ['bar', 'stream', 'supervisor'] as const;
export type EngineKind = (typeof ENGINES)[number];
export const MODES = ['research', 'paper', 'live'] as const;
export type Mode = (typeof MODES)[number];
/** the value stored in the `mode` columns */
export type DbMode = 'RESEARCH' | 'PAPER' | 'LIVE';
export const dbMode = (m: Mode): DbMode => m.toUpperCase() as DbMode;
export const apiMode = (m: string | null | undefined): Mode => (m === 'LIVE' ? 'live' : m === 'PAPER' ? 'paper' : 'research');
export const LIFECYCLES = ['active', 'paused', 'stopped'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** `agents.state` → active | paused | stopped. STOPPING is still active: the engine is closing positions. */
export function lifecycleOf(state: string): Lifecycle {
  if (state === 'PAPER_TRADING' || state === 'LIVE' || state === 'STOPPING' || state === 'RUNNING') return 'active';
  if (state === 'PAUSED') return 'paused';
  return 'stopped';
}
/** The mode an agent is in NOW. An agent that never traded, or was sent back to research, is in research. */
export function modeOf(a: { state: string; mode: string }): Mode {
  if (a.mode === 'LIVE') return 'live';
  if (a.mode === 'PAPER') return 'paper';
  return 'research';
}

// ------------------------------------------------------------------------------------------------------------------ live capability

/** instruments the signer's pinned Hyperliquid asset table covers (packages/derivatives/src/live/hl-assets.ts) */
export const LIVE_PINNED = ['BTC', 'ETH', 'SOL'] as const;
export const LIVE_VENUE = 'hyperliquid' as const;
export type LiveVerdict = { capable: true } | { capable: false; code: string; reason: string };
export const NO_LIVE_ONE_VENUE = 'mode réel indisponible : une seule plateforme autorise l\'exécution sous mandat';
export const NO_LIVE_ONE_VENUE_EN = 'live mode unavailable: only one venue allows execution under a mandate';

/** Which families may go live, and why the others may not. The wallet can sign under a mandate on Hyperliquid only; GMX needs a
 *  passkey for every order; dYdX and edgeX are read-only. A strategy with two venues therefore has no second leg to execute. */
export const FAMILY_MODES: Readonly<Record<Family, { engine: EngineKind; modes: readonly Mode[]; liveReason: string | null }>> = {
  momentum: { engine: 'bar', modes: ['research', 'paper', 'live'], liveReason: null },
  mean_reversion: { engine: 'bar', modes: ['research', 'paper', 'live'], liveReason: null },
  stat_arb: { engine: 'bar', modes: ['research', 'paper', 'live'], liveReason: null },
  funding_arb: { engine: 'stream', modes: ['research', 'paper'], liveReason: NO_LIVE_ONE_VENUE },
  cross_exchange: { engine: 'stream', modes: ['research', 'paper'], liveReason: NO_LIVE_ONE_VENUE },
  // V11 market making: live on Hyperliquid for the pinned instruments, under a QUOTING mandate (SPW-VENUE-QUOTING-MANDATE-v1) the
  // owner approved with the passkey — services/api/src/mm. `liveVerdict` says which agents of the family qualify.
  market_making: { engine: 'stream', modes: ['research', 'paper', 'live'], liveReason: null },
  // research = observes and proposes only; paper = may pause PAPER agents; live = may also pause LIVE agents and engage the kill switch
  risk_manager: { engine: 'supervisor', modes: ['research', 'paper', 'live'], liveReason: null },
  custom: { engine: 'bar', modes: ['research', 'paper', 'live'], liveReason: null },
};

/** A bar agent on Hyperliquid may go live only when every instrument is pinned (audit D1). */
export function liveVerdict(family: Family, kind: string, universe: readonly string[], venues?: readonly string[]): LiveVerdict {
  const f = FAMILY_MODES[family];
  if (!f.modes.includes('live')) return { capable: false, code: 'family_not_live', reason: f.liveReason ?? NO_LIVE_ONE_VENUE };
  if (family === 'risk_manager') return { capable: true };
  if (family === 'market_making') {
    // one venue signs under a quoting mandate, for the instruments of its pinned table only; `venues` is given by the callers that know it
    if (venues && (venues.length !== 1 || venues[0] !== LIVE_VENUE)) return { capable: false, code: 'venue_not_live', reason: `live market making runs on ${LIVE_VENUE} only (the one venue with a signer-enforced quoting mandate); this agent quotes on ${venues.join(', ') || 'no venue'}` };
    const off = universe.filter((s) => !(LIVE_PINNED as readonly string[]).includes(s));
    if (off.length || universe.length !== 1) return { capable: false, code: 'universe_not_pinned', reason: `a live market-making agent quotes ONE instrument among ${LIVE_PINNED.join(', ')} (the signer's pinned asset table)${off.length ? `; ${off.join(', ')} is not` : ''}` };
    return { capable: true };
  }
  if (kind === 'perp') {
    const off = universe.filter((s) => !(LIVE_PINNED as readonly string[]).includes(s));
    if (off.length) return { capable: false, code: 'universe_not_pinned', reason: `the instruments of a live perp agent must all be among ${LIVE_PINNED.join(', ')} (the signer's pinned asset table); ${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} not. A fixed-universe strategy runs only on its exact universe, and a generic one on the agent's instruments: with these instruments this agent cannot go live.` };
  }
  return { capable: true };
}

// ------------------------------------------------------------------------------------------------------------------ templates

export interface RiskDefaults { [k: string]: number | string | boolean }
export interface AgentTemplate {
  id: string; family: Family; engine: EngineKind; name: { fr: string; en: string }; summary: { fr: string; en: string };
  /** bar templates: strategies of the laboratory BY NAME, in order of preference — `name` (every installed version of that
   *  directory) or `name/version` (that version). The first installed one is bound; none installed → "strategy not installed". */
  strategies: readonly string[];
  /** stream / supervisor templates: the TypeScript rule (agent-runtime/families) */
  rule: string | null;
  /** laboratory strategies that are the BACKTEST / research reference of the family and that NO agent can run (two venues, or
   *  spot legs): shown with their results, never bound to an agent */
  backtestStrategies: readonly string[];
  /** model studies and policies of the laboratory (research/studies and the lab's studies package) that document the family: not strategies */
  labStudies: readonly { name: string; kind: 'study' | 'policy' }[];
  kind: 'perp' | 'stream' | 'supervisor';
  defaults: { universe: string[]; venues: string[]; interval: string; capitalUsdc: string; config: Record<string, unknown>; risk: RiskDefaults };
}

const PERP_RISK: RiskDefaults = { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 3, maxTotalLossPct: 10, slippageBps: 30, minTradePct: 2 };
const STREAM_RISK: RiskDefaults = { maxPositionUsd: 500, maxGrossUsd: 1000, maxDailyLossPct: 2, maxTotalLossPct: 5, maxDataAgeMs: 5000 };

/** The seven built-in agents, bound BY NAME to what the quant lab installed (research/strategies, research/strategies_xvenue,
 *  research/studies): the V11 strategies first — the BTC/ETH/SOL version before the generic one, because it is the one whose
 *  universe the signer can execute live — then the older library versions. Nothing here is a placeholder, and nothing here
 *  says how a strategy performed: the laboratory's results are read from its files (agents/lab-verdicts.ts). */
export const TEMPLATES: readonly AgentTemplate[] = [
  { id: 'stat-arb', family: 'stat_arb', engine: 'bar', kind: 'perp', rule: null, backtestStrategies: [], labStudies: [],
    name: { fr: 'Arbitrage statistique', en: 'Statistical Arbitrage' },
    summary: { fr: 'Paire ou panier co-intégré de contrats perpétuels Hyperliquid : achète l\'écart quand il s\'éloigne de sa moyenne, le revend quand il y revient.', en: 'A co-integrated pair or basket of Hyperliquid perpetuals: buys the spread when it is far from its mean, sells it back when it returns.' },
    strategies: ['statarb_basket_perp', 'pairs_coint_perp'],
    defaults: { universe: ['BTC', 'ETH'], venues: ['hyperliquid'], interval: '1h', capitalUsdc: '1000', config: {}, risk: PERP_RISK } },
  { id: 'funding-arb', family: 'funding_arb', engine: 'stream', kind: 'stream', rule: 'funding_differential', backtestStrategies: ['funding_arb_cross_venue', 'basis_cash_carry'], labStudies: [],
    name: { fr: 'Arbitrage de financement', en: 'Funding Arbitrage' },
    summary: { fr: 'Compare le taux de financement du même contrat sur deux plateformes, ramené à l\'heure avec l\'intervalle réel de chacune, net des frais des quatre jambes.', en: 'Compares the funding rate of the same contract on two venues, per hour with each venue\'s real interval, net of the fees of four legs.' },
    strategies: [],
    defaults: { universe: ['BTC'], venues: ['hyperliquid', 'dydx'], interval: 'stream', capitalUsdc: '1000',
      config: { notionalUsd: '250', horizonHours: '24', minNetCarryBps: '5', exitNetCarryBps: '0', decisionEveryMs: 60_000 }, risk: STREAM_RISK } },
  { id: 'market-making', family: 'market_making', engine: 'stream', kind: 'stream', rule: 'spread_inventory', backtestStrategies: [], labStudies: [{ name: 'market_making_as', kind: 'study' }, { name: 'vol_forecast', kind: 'study' }],
    name: { fr: 'Tenue de marché', en: 'Market Making' },
    summary: { fr: 'Cote un prix acheteur et un prix vendeur autour du milieu du carnet ; l\'écart s\'élargit avec la volatilité et se décale contre l\'inventaire.', en: 'Quotes a bid and an ask around the mid; the spread widens with volatility and skews against the inventory.' },
    strategies: [],
    defaults: { universe: ['BTC'], venues: ['hyperliquid'], interval: 'stream', capitalUsdc: '1000',
      // `policy`: spread_inventory (the family's rule) or avellaneda_stoikov (the lab study's formulas; as* and maxHalfSpreadBps are its parameters)
      config: { quoteSizeUsd: '50', minHalfSpreadBps: '2', volMultiplier: '1.5', skewBps: '4', maxInventoryUsd: '250', volWindow: 30, decisionEveryMs: 5_000, policy: 'spread_inventory', asGamma: '0.1', asTauIntervals: 12, asKappa: '0.69', maxHalfSpreadBps: '150' }, risk: STREAM_RISK } },
  { id: 'momentum', family: 'momentum', engine: 'bar', kind: 'perp', rule: null, backtestStrategies: [], labStudies: [],
    name: { fr: 'Momentum', en: 'Momentum' },
    summary: { fr: 'Suit la tendance : acheteur quand le rendement passé est positif, vendeur quand il est négatif.', en: 'Follows the trend: long when the past return is positive, short when it is negative.' },
    strategies: ['momentum_xs_perp/2', 'momentum_xs_perp/1', 'momentum_xs_perp', 'ts_momentum_perp', 'ma_trend_perp', 'vol_breakout_perp'],
    defaults: { universe: ['BTC', 'ETH', 'SOL'], venues: ['hyperliquid'], interval: '1h', capitalUsdc: '1000', config: {}, risk: PERP_RISK } },
  { id: 'mean-reversion', family: 'mean_reversion', engine: 'bar', kind: 'perp', rule: null, backtestStrategies: [], labStudies: [],
    name: { fr: 'Retour à la moyenne', en: 'Mean Reversion' },
    summary: { fr: 'Prend le contre-pied des écarts extrêmes à la moyenne, avec un stop.', en: 'Fades extreme deviations from the mean, with a stop.' },
    strategies: ['mean_reversion_bands_perp/2', 'mean_reversion_bands_perp/1', 'mean_reversion_bands_perp', 'zscore_reversion_perp'],
    defaults: { universe: ['BTC', 'ETH', 'SOL'], venues: ['hyperliquid'], interval: '1h', capitalUsdc: '1000', config: {}, risk: PERP_RISK } },
  { id: 'cross-exchange', family: 'cross_exchange', engine: 'stream', kind: 'stream', rule: 'net_spread', backtestStrategies: [], labStudies: [{ name: 'cross_exchange_spread', kind: 'study' }],
    name: { fr: 'Inter-plateformes', en: 'Cross-Exchange' },
    summary: { fr: 'Mesure l\'écart de prix du même contrat entre deux plateformes, net des frais, du glissement de sortie et du financement.', en: 'Measures the price gap of the same contract between two venues, net of fees, exit slippage and funding.' },
    strategies: [],
    defaults: { universe: ['BTC'], venues: ['hyperliquid', 'edgex'], interval: 'stream', capitalUsdc: '1000',
      config: { notionalUsd: '250', horizonHours: '8', minNetEdgeBps: '5', exitGapBps: '1', decisionEveryMs: 5_000 }, risk: STREAM_RISK } },
  { id: 'risk-manager', family: 'risk_manager', engine: 'supervisor', kind: 'supervisor', rule: 'portfolio_supervisor', backtestStrategies: [], labStudies: [{ name: 'risk_supervisor', kind: 'policy' }, { name: 'vol_forecast', kind: 'study' }],
    name: { fr: 'Gestion du risque', en: 'Risk Management' },
    summary: { fr: 'Surveille l\'exposition, les pertes, la distance de liquidation et le coût de financement de tous les agents, par mode. Propose des réductions ; ne peut que mettre en pause et déclencher l\'arrêt d\'urgence.', en: 'Watches exposure, losses, liquidation distance and funding cost of every agent, per mode. Proposes reductions; can only pause agents and engage the kill switch.' },
    strategies: [],
    defaults: { universe: [], venues: [], interval: 'supervisor', capitalUsdc: '0',
      config: { act: false, decisionEveryMs: 60_000 },
      risk: { maxGrossUsd: 5000, maxAgentDrawdownPct: 8, maxPortfolioDailyLossPct: 4, minLiquidationDistanceBps: 800, maxFundingBleedBpsPerDay: 15, killSwitchDailyLossPct: 10 } } },
];
export const template = (id: string): AgentTemplate | null => TEMPLATES.find((t) => t.id === id) ?? null;

// ------------------------------------------------------------------------------------------------------------------ library manifest (audit D10)

/** The production strategy library is this explicit list of names — a directory under research/strategies that is not here
 *  (a research job's `rj_*`, a test fixture such as `zz_forktest`, a scratch copy) is never listed. Research-job strategies keep
 *  their own listing (research routes). A name without a directory is simply absent. The listing reads research/strategies ONLY:
 *  `funding_arb_cross_venue` lives in research/strategies_xvenue (two venues: research only) and the studies / the policy live
 *  in research/studies — none of those is ever offered to an agent (LAB_RESEARCH_ONLY). */
export const LIBRARY_MANIFEST: readonly string[] = [
  // spot
  'ma_trend', 'ts_momentum', 'xs_momentum', 'donchian_breakout', 'vol_target_trend', 'garch_regime', 'mean_reversion', 'pairs_rotation',
  // perp, present today
  'ts_momentum_perp', 'ma_trend_perp', 'vol_breakout_perp', 'zscore_reversion_perp', 'pairs_coint_perp', 'funding_carry_perp', 'funding_carry_neutral_perp', 'har_rv_perp',
  // perp, V11 quant lab, installed in research/strategies (versions: `/1` generic or wide, `/2` BTC/ETH/SOL; `<name>_<suffix>` variants are accepted)
  'statarb_basket_perp', 'momentum_xs_perp', 'mean_reversion_bands_perp',
  // spot + perp legs: listed (with `spotLegs: true`) so that its backtest is reachable; a perp agent refuses it
  'basis_cash_carry',
];
/** Laboratory names that are NOT agent-runnable strategies and are therefore never in the library, wherever a directory of
 *  that name might appear: the cross-venue strategy (research/strategies_xvenue), the model studies and the policy. */
export const LAB_RESEARCH_ONLY: readonly string[] = ['funding_arb_cross_venue', 'market_making_as', 'cross_exchange_spread', 'vol_forecast', 'risk_supervisor'];
const VARIANT_BASES = ['statarb_basket_perp', 'momentum_xs_perp', 'mean_reversion_bands_perp', 'ts_momentum_perp', 'ma_trend_perp', 'vol_breakout_perp', 'zscore_reversion_perp', 'funding_carry_perp', 'har_rv_perp'];
/** extra names for a deployment or a test: SPW_LAB_EXTRA_STRATEGIES=name1,name2 */
const extra = (): string[] => (process.env.SPW_LAB_EXTRA_STRATEGIES ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_]{1,40}$/.test(s));
export function inLibraryManifest(name: string): boolean {
  if (LAB_RESEARCH_ONLY.includes(name)) return false;
  if (LIBRARY_MANIFEST.includes(name) || extra().includes(name)) return true;
  return VARIANT_BASES.some((b) => name.startsWith(`${b}_`) && /^[a-z0-9_]{1,40}$/.test(name));
}
/** does a library directory name satisfy a template's strategy name (the name itself, or one of its variants)? */
export const matchesStrategyName = (dir: string, wanted: string): boolean => dir === wanted || dir.startsWith(`${wanted}_`);
/** does a library path `dir/version` satisfy a template entry — `name` (any version, variants included) or `name/version` (that one)? */
export const matchesStrategy = (rel: string, wanted: string): boolean => (wanted.includes('/') ? rel === wanted : matchesStrategyName(rel.split('/')[0] ?? '', wanted));
/** the distinct strategy NAMES of a template's entries, in order (`momentum_xs_perp/2` and `momentum_xs_perp/1` → one name) */
export const strategyNamesOf = (entries: readonly string[]): string[] => [...new Set(entries.map((e) => e.split('/')[0]!))];

// ------------------------------------------------------------------------------------------------------------------ configuration versions

/** canonical JSON: keys sorted at every level, no whitespace */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const configHash = (config: unknown): string => sha256Hex(canonicalJson(config));

/** TypeScript rules of the stream engine and the supervisor: pinned by name and version, like a strategy file by its hash */
export const RULES: Readonly<Record<string, { version: string; family: Family }>> = {
  spread_inventory: { version: '1', family: 'market_making' },
  net_spread: { version: '1', family: 'cross_exchange' },
  funding_differential: { version: '1', family: 'funding_arb' },
  portfolio_supervisor: { version: '1', family: 'risk_manager' },
};
export const ruleHash = (rule: string): string => { const r = RULES[rule]; if (!r) throw new Error(`unknown rule ${rule}`); return sha256Hex(`spw-agent-rule:${rule}@${r.version}`); };

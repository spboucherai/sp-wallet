// Any-to-any planner (V7). A plan is a SEQUENCE OF LEGS THE WALLET CAN ALREADY EXECUTE — a same-network swap (KyberSwap,
// Jupiter), a USDC transfer between two CCTP networks (Circle CCTP: seven EVM networks and, since v8, Solana), a native swap
// through THORChain — never a new trust path.
// This file is pure: no network, no database. The caller supplies what is executable (`PlanCaps`), a function that returns a
// REAL quote for one leg, balances and limits. Docs: docs/v7/ANY-TO-ANY.md.
//
// Amounts chain: leg k+1 is quoted twice, on what leg k is EXPECTED to deliver and on the MINIMUM it guarantees. The first
// chain gives the expected result, the second the worst case. Neither is a promise for the whole plan: each leg is approved
// (and guaranteed) on its own when its turn comes, sized on what was actually received.
import { getNetwork } from '@spw/core';
import { assetKey, sameAsset, type AssetRef, type FeeItem } from './types.ts';

export type PlanLegKind = 'swap' | 'bridge' | 'xswap';
export type PlanVia = 'kyberswap' | 'jupiter' | 'cctp' | 'thorchain';
export interface PlanLegSpec { kind: PlanLegKind; via: PlanVia; from: AssetRef; to: AssetRef; /** CCTP only */ speed?: 'standard' | 'fast' }

/** What the wallet can execute today, as data (built by the API from the pinned tables of @spw/core). */
export interface PlanCaps {
  /** network -> provider of the same-network swap the signer verifies there */
  swap: Record<string, 'kyberswap' | 'jupiter'>;
  /** network -> the native USDC that CCTP burns and mints there, and whether Circle offers Fast from it */
  cctp: Record<string, { usdc: string; fast: boolean }>;
  /** assets THORChain swaps; `source` = may be the input */
  thor: { network: string; asset: string; source: boolean }[];
}

export const MAX_PLAN_LEGS = 3;
const key = (a: AssetRef) => assetKey(a);
export const legId = (l: PlanLegSpec) => `${l.via}${l.speed ? `.${l.speed}` : ''}:${key(l.from)}>${key(l.to)}`;
/** Stable identity of a plan shape: the same legs in the same order. */
export const planId = (legs: PlanLegSpec[]) => legs.map(legId).join('|');

const thorOf = (c: PlanCaps, a: AssetRef) => c.thor.find((t) => t.network === a.network && key({ network: t.network, asset: t.asset }) === key(a));
const usdcOf = (c: PlanCaps, network: string): AssetRef | null => (c.cctp[network] ? { network, asset: c.cctp[network]!.usdc } : null);
const isUsdc = (c: PlanCaps, a: AssetRef) => { const u = usdcOf(c, a.network); return !!u && sameAsset(u, a); };
/** The only intermediate assets: native USDC of a CCTP network. Funds resting between two legs are an ordinary USDC balance. */
const isHub = (c: PlanCaps, a: AssetRef) => isUsdc(c, a);

/**
 * Every plan of at most three legs from `from` to `to` over the executable legs. Rules: an intermediate asset is a hub
 * (native USDC), a network is never visited twice, no two legs of the same kind in a row.
 */
export function enumeratePlans(from: AssetRef, to: AssetRef, caps: PlanCaps, maxLegs = MAX_PLAN_LEGS): PlanLegSpec[][] {
  const out: PlanLegSpec[][] = [], dst = key(to);
  if (key(from) === dst) return out;
  const walk = (at: AssetRef, legs: PlanLegSpec[], left: Set<string>) => {
    if (legs.length >= maxLegs) return;
    const prev = legs[legs.length - 1], next: PlanLegSpec[] = [];
    // same-network swap: to the destination when it lives here, otherwise to this network's hub
    const via = caps.swap[at.network];
    if (via && prev?.kind !== 'swap') {
      if (to.network === at.network) next.push({ kind: 'swap', via, from: at, to });
      const hub = usdcOf(caps, at.network);
      if (hub && !sameAsset(hub, at) && !sameAsset(hub, to)) next.push({ kind: 'swap', via, from: at, to: hub });
    }
    // CCTP: native USDC to native USDC of another network
    if (isUsdc(caps, at) && prev?.kind !== 'bridge') for (const m of Object.keys(caps.cctp)) {
      if (m === at.network || left.has(m)) continue;
      const usdc = usdcOf(caps, m)!;
      next.push({ kind: 'bridge', via: 'cctp', from: at, to: usdc, speed: 'standard' });
      if (caps.cctp[at.network]!.fast) next.push({ kind: 'bridge', via: 'cctp', from: at, to: usdc, speed: 'fast' });
    }
    // THORChain: a pinned source asset to a pinned asset on another network
    if (thorOf(caps, at)?.source && prev?.kind !== 'xswap') for (const t of caps.thor) {
      if (t.network === at.network || left.has(t.network)) continue;
      next.push({ kind: 'xswap', via: 'thorchain', from: at, to: { network: t.network, asset: t.asset } });
    }
    for (const l of next) {
      const path = [...legs, l];
      if (key(l.to) === dst) { out.push(path); continue; }
      if (!isHub(caps, l.to)) continue;
      walk(l.to, path, l.to.network === at.network ? left : new Set([...left, at.network]));
    }
  };
  walk(from, [], new Set());
  // shortest first, then by identity: a deterministic order before pricing
  const seen = new Set<string>();
  return out.filter((p) => { const id = planId(p); if (seen.has(id)) return false; seen.add(id); return true; }).sort((a, b) => a.length - b.length || planId(a).localeCompare(planId(b)));
}

export type NotExecutable = { code: 'same_asset' | 'solana_evm_bridge' | 'network_without_execution' | 'no_executable_path'; network?: string };
/** Why no plan exists for a pair, said precisely. Called only when `enumeratePlans` returned nothing. */
export function whyNotExecutable(from: AssetRef, to: AssetRef, caps: PlanCaps): NotExecutable {
  if (key(from) === key(to)) return { code: 'same_asset' };
  const fam = (a: AssetRef) => getNetwork(a.network).family;
  // v8: Solana ↔ EVM is executable through CCTP when the caller's capabilities list Solana among the CCTP networks (the signer
  // then builds the Solana burn and mint itself, docs/swap/providers/cctp.md §13). Without that leg the pair has no bridge: said so.
  const sol = [from, to].find((a) => fam(a) === 'sol');
  if (from.network !== to.network && (fam(from) === 'sol') !== (fam(to) === 'sol') && !(sol && caps.cctp[sol.network])) return { code: 'solana_evm_bridge' };
  const reach = (a: AssetRef) => !!caps.swap[a.network] || !!thorOf(caps, a) || isUsdc(caps, a);
  if (!reach(from)) return { code: 'network_without_execution', network: from.network };
  if (!reach(to)) return { code: 'network_without_execution', network: to.network };
  return { code: 'no_executable_path' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pricing

export interface LegQuote {
  amountOut: bigint; minAmountOut: bigint; fees: FeeItem[]; seconds: number | null;
  /** the provider's own minimum input for this leg, when it has one (THORChain) */
  minIn?: bigint | null;
  /** venues, for display */
  via?: string[];
}
/** A real quote for one leg and one exact input. `null` = no route right now. Throws on provider failure. */
export type QuoteLeg = (leg: PlanLegSpec, amountIn: bigint) => Promise<LegQuote | null>;
export type PlanValuer = (asset: AssetRef, amount: bigint) => number | null;

export interface PlanFee extends FeeItem { usd: number | null; /** fee of the expected chain (the worst-case chain pays about the same) */ leg: number }
export interface PricedLeg {
  spec: PlanLegSpec;
  expectedIn: bigint; worstIn: bigint; expectedOut: bigint; worstOut: bigint;
  fees: PlanFee[]; seconds: number | null; minIn: bigint | null; via: string[];
}
export interface PricedPlan {
  id: string; legs: PricedLeg[]; amountIn: bigint;
  /** "attendu": every leg at its quoted output. "garanti au pire": every leg at its guaranteed minimum. */
  expectedOut: bigint; worstOut: bigint;
  seconds: number | null;
  /** fees not already deducted from an output, in USD (null when one of them has no price) */
  extraFeesUsd: number | null;
  /** one passkey approval per leg */
  approvals: number;
  issues: PlanIssue[]; executable: boolean;
}
export class PlanQuoteError extends Error { leg: number; code: 'no_route' | 'provider'; constructor(leg: number, code: 'no_route' | 'provider', message: string) { super(message); this.leg = leg; this.code = code; } }

/** Price one plan with real quotes, leg after leg. Throws PlanQuoteError naming the leg that has no quote. */
export async function pricePlan(specs: PlanLegSpec[], amountIn: bigint, quote: QuoteLeg, value: PlanValuer = () => null): Promise<PricedPlan> {
  const legs: PricedLeg[] = [];
  let expected = amountIn, worst = amountIn;
  for (const [k, spec] of specs.entries()) {
    let qe: LegQuote | null, qw: LegQuote | null;
    try { qe = await quote(spec, expected); qw = worst === expected ? qe : await quote(spec, worst); }
    catch (e) { throw new PlanQuoteError(k, 'provider', (e as Error).message); }
    if (!qe || !qw) throw new PlanQuoteError(k, 'no_route', 'no route for this leg and amount right now');
    if (qe.amountOut <= 0n || qw.minAmountOut <= 0n || qw.minAmountOut > qe.amountOut) throw new PlanQuoteError(k, 'provider', 'inconsistent quote for this leg');
    legs.push({ spec, expectedIn: expected, worstIn: worst, expectedOut: qe.amountOut, worstOut: qw.minAmountOut, seconds: qe.seconds, minIn: qe.minIn ?? null, via: qe.via ?? [],
      fees: qe.fees.map((f) => ({ ...f, usd: value(f.asset, f.amount), leg: k })) });
    expected = qe.amountOut; worst = qw.minAmountOut;
  }
  const extra = legs.flatMap((l) => l.fees).filter((f) => !f.includedInOutput);
  return { id: planId(specs), legs, amountIn, expectedOut: expected, worstOut: worst,
    seconds: legs.every((l) => l.seconds !== null) ? legs.reduce((s, l) => s + l.seconds!, 0) : null,
    extraFeesUsd: extra.every((f) => f.usd !== null) ? extra.reduce((s, f) => s + f.usd!, 0) : null,
    approvals: legs.length, issues: [], executable: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Constraints: limits of EACH leg's own asset, minimums, balance, gas on every network involved

export interface PlanIssue {
  code: 'insufficient_balance' | 'limit_missing' | 'limit_per_transfer' | 'limit_daily' | 'limit_margin' | 'below_minimum' | 'gas_missing' | 'gas_unknown';
  /** a blocking issue makes the plan non-startable; a warning is shown and the leg's own check decides when its turn comes */
  blocking: boolean;
  leg: number | null; network: string; symbol: string;
  /** base units, as decimal strings (limits, amounts) — the UI formats them */
  need: string; have: string; decimals: number;
}
export interface PlanContext {
  /** symbol and decimals of an asset (registry) */
  asset: (a: AssetRef) => { symbol: string; decimals: number };
  /** signer policy, keyed "<network>:<symbol>", base units; a missing key means the asset cannot be moved at all */
  perTx: Record<string, string>; daily: Record<string, string>; spentToday: Record<string, string>;
  /** the wallet's balance of an asset, or null when it could not be read */
  balance: (a: AssetRef) => bigint | null;
}
/** Network fees are estimates and the signer signs a ceiling of about twice the current price: require that much. */
export const GAS_MARGIN = 2n;
/** A leg whose expected input is within this of its per-transfer limit may be refused when the real amount arrives. */
export const LIMIT_MARGIN_BPS = 300n;

export function checkPlan(p: PricedPlan, c: PlanContext): PricedPlan {
  const issues: PlanIssue[] = [], first = p.legs[0]!.spec.from;
  const src = c.asset(first), have = c.balance(first);
  if (have !== null && have < p.amountIn) issues.push({ code: 'insufficient_balance', blocking: true, leg: 0, network: first.network, symbol: src.symbol, need: p.amountIn.toString(), have: have.toString(), decimals: src.decimals });
  const day = new Map<string, bigint>();
  for (const [k, l] of p.legs.entries()) {
    const a = c.asset(l.spec.from), id = `${l.spec.from.network}:${a.symbol}`, base = { leg: k, network: l.spec.from.network, symbol: a.symbol, decimals: a.decimals };
    const perTx = BigInt(c.perTx[id] ?? '0'), daily = BigInt(c.daily[id] ?? '0'), spent = BigInt(c.spentToday[id] ?? '0') + (day.get(id) ?? 0n);
    if (perTx === 0n) issues.push({ ...base, code: 'limit_missing', blocking: true, need: l.expectedIn.toString(), have: '0' });
    else if (l.expectedIn > perTx) issues.push({ ...base, code: 'limit_per_transfer', blocking: true, need: l.expectedIn.toString(), have: perTx.toString() });
    else if (spent + l.expectedIn > daily) issues.push({ ...base, code: 'limit_daily', blocking: true, need: l.expectedIn.toString(), have: (daily > spent ? daily - spent : 0n).toString() });
    else if (k > 0 && l.expectedIn * 10_000n > perTx * (10_000n - LIMIT_MARGIN_BPS)) issues.push({ ...base, code: 'limit_margin', blocking: false, need: l.expectedIn.toString(), have: perTx.toString() });
    day.set(id, (day.get(id) ?? 0n) + l.expectedIn);
    if (l.minIn !== null && l.worstIn < l.minIn) issues.push({ ...base, code: 'below_minimum', blocking: true, need: l.minIn.toString(), have: l.worstIn.toString() });
  }
  // gas: every network fee the wallet pays itself, per network, in that network's coin
  const gas = new Map<string, bigint>();
  for (const f of p.legs.flatMap((l) => l.fees)) if (f.kind === 'network' && !f.includedInOutput && f.asset.asset === 'native') gas.set(f.asset.network, (gas.get(f.asset.network) ?? 0n) + f.amount * GAS_MARGIN);
  for (const [network, need] of gas) {
    const ref = { network, asset: 'native' }, a = c.asset(ref), bal = c.balance(ref);
    if (bal === null) { issues.push({ code: 'gas_unknown', blocking: false, leg: null, network, symbol: a.symbol, need: need.toString(), have: '0', decimals: a.decimals }); continue; }
    // the source amount itself may be this network's coin: it is not available for fees
    const free = sameAsset(first, ref) ? (bal > p.amountIn ? bal - p.amountIn : 0n) : bal;
    if (free < need) issues.push({ code: 'gas_missing', blocking: true, leg: null, network, symbol: a.symbol, need: need.toString(), have: free.toString(), decimals: a.decimals });
  }
  return { ...p, issues, executable: !issues.some((i) => i.blocking) };
}

/** Startable plans first; then the highest guaranteed worst case, then the highest expected result, then the fastest. */
export function rankPlans(plans: PricedPlan[]): PricedPlan[] {
  const t = (p: PricedPlan) => p.seconds ?? Number.POSITIVE_INFINITY;
  return [...plans].sort((a, b) => Number(b.executable) - Number(a.executable) || (a.worstOut === b.worstOut ? 0 : a.worstOut > b.worstOut ? -1 : 1)
    || (a.expectedOut === b.expectedOut ? 0 : a.expectedOut > b.expectedOut ? -1 : 1) || t(a) - t(b) || a.id.localeCompare(b.id));
}

export interface ComparisonQuote { id: string; providers: string[]; amountOut: bigint; minAmountOut: bigint; executable: boolean }
export interface Comparison extends ComparisonQuote { /** always: the wallet cannot execute this quote */ comparisonOnly: true; /** its guaranteed minimum is above the best plan's worst case */ aboveBestPlan: boolean }
/** Quotes of providers the wallet cannot execute are never hidden, even when they are better: they are labelled. */
export function comparisonQuotes(plans: PricedPlan[], quotes: ComparisonQuote[]): Comparison[] {
  const best = rankPlans(plans).find((p) => p.executable)?.worstOut ?? rankPlans(plans)[0]?.worstOut ?? null;
  return quotes.filter((q) => !q.executable).map((q) => ({ ...q, comparisonOnly: true as const, aboveBestPlan: best === null || q.minAmountOut > best }))
    .sort((a, b) => (a.minAmountOut === b.minAmountOut ? 0 : a.minAmountOut > b.minAmountOut ? -1 : 1));
}

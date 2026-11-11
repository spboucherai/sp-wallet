import { assetKey, type AssetRef, type RiskAssessment, type RiskFlag, type SwapQuote } from './types.ts';

/** USD value of an amount, or null when the asset has no trusted price. Display/ranking only. */
export type Valuer = (asset: AssetRef, amount: bigint) => number | null;

export interface Valuation { inUsd: number | null; outUsd: number | null; minOutUsd: number | null; extraFeesUsd: number; unpricedFees: number; netUsd: number | null }

/** Value a quote: guaranteed output minus the fees that are not already deducted from it. */
export function valueQuote(q: SwapQuote, value: Valuer): Valuation {
  const inUsd = value(q.request.from, q.request.amountIn), outUsd = value(q.request.to, q.amountOut), minOutUsd = value(q.request.to, q.minAmountOut);
  let extraFeesUsd = 0, unpricedFees = 0;
  for (const f of q.fees) { if (f.includedInOutput) continue; const v = value(f.asset, f.amount); if (v === null) unpricedFees += 1; else extraFeesUsd += v; }
  return { inUsd, outUsd, minOutUsd, extraFeesUsd, unpricedFees, netUsd: minOutUsd === null ? null : minOutUsd - extraFeesUsd };
}

const order = { low: 0, medium: 1, high: 2 } as const;
/**
 * Mandatory, mode-independent checks. A quote that is far better than the market is treated as more suspicious than
 * one that is worse: providers do not give money away, but a tampered or mis-decimalled answer looks exactly like that.
 */
export function assessRisk(q: SwapQuote, v: Valuation, peers: SwapQuote[] = []): RiskAssessment {
  const flags: RiskFlag[] = [];
  const add = (code: string, level: RiskFlag['level'], detail?: string) => flags.push({ code, level, detail });
  if (q.minAmountOut <= 0n || q.amountOut <= 0n || q.minAmountOut > q.amountOut) add('inconsistent_amounts', 'high');
  if (q.executability.class === 'quote_only') add('not_executable', 'medium', q.executability.reason);
  if (q.executability.class === 'opaque') add('opaque_transaction', 'medium', q.executability.reason);
  if (q.priceImpactBps !== null) { if (q.priceImpactBps >= 300) add('high_price_impact', 'high', `${q.priceImpactBps} bps`); else if (q.priceImpactBps >= 100) add('price_impact', 'medium', `${q.priceImpactBps} bps`); }
  if (q.steps.some((s) => s.kind === 'bridge' || s.kind === 'native_swap')) { add('cross_chain', 'medium'); if (q.refundable === false) { if (q.recoverable) add('recoverable_not_refundable', 'medium'); else add('no_refund_path', 'high'); } if (q.refundable === null) add('refund_unknown', 'medium'); }
  if (!q.atomic && q.steps.length > 1) add('multi_step', 'medium', `${q.steps.length} steps`);
  if (q.estimatedSeconds === null) add('no_time_estimate', 'low');
  if (v.unpricedFees > 0) add('fee_unpriced', 'low', `${v.unpricedFees} fee item(s) without a price`);
  if (v.inUsd !== null && v.outUsd !== null && v.inUsd > 0) {
    const ratio = v.outUsd / v.inUsd;
    if (ratio > 1.03) add('better_than_market', 'high', `output worth ${(ratio * 100).toFixed(1)} % of input`);
    else if (ratio < 0.9) add('far_below_market', 'high', `output worth ${(ratio * 100).toFixed(1)} % of input`);
    else if (ratio < 0.97) add('below_market', 'medium', `output worth ${(ratio * 100).toFixed(1)} % of input`);
  } else add('no_market_reference', 'medium');
  // disagreement between providers on the same pair: an answer far above every peer is not trusted
  const same = peers.filter((p) => p.id !== q.id && assetKey(p.request.to) === assetKey(q.request.to) && p.request.amountIn === q.request.amountIn).map((p) => p.amountOut).sort((a, b) => (a < b ? -1 : 1));
  if (same.length >= 2) { const med = same[Math.floor(same.length / 2)]!; if (med > 0n && q.amountOut * 100n > med * 105n) add('outlier_vs_peers', 'high', 'more than 5 % above the median of other providers'); }
  const level = flags.reduce<RiskFlag['level']>((m, f) => (order[f.level] > order[m] ? f.level : m), 'low');
  const score = Math.min(100, flags.reduce((s, f) => s + (f.level === 'high' ? 40 : f.level === 'medium' ? 12 : 3), 0));
  return { level, score, flags };
}

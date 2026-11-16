// Smart route optimizer: direct quotes from every compatible provider, plus bounded two-leg routes through a hub asset,
// ranked on what the user is guaranteed to receive net of all known costs — not on path length.
import { QuoteAggregator, type QuoteEvent } from './aggregator.ts';
import { LiquidityGraph } from './graph.ts';
import { assessRisk, valueQuote, type Valuation, type Valuer } from './risk.ts';
import { assetKey, type AssetRef, type Executability, type RiskAssessment, type RoutingMode, type SwapQuote, type SwapQuoteRequest } from './types.ts';

export interface Route {
  id: string;
  /** one quote for a direct route, two for a route through an intermediate asset */
  legs: SwapQuote[];
  providers: string[];
  path: AssetRef[];
  amountIn: bigint; amountOut: bigint; minAmountOut: bigint;
  estimatedSeconds: number | null;
  expiresAt: number;
  executability: Executability;
  valuation: Valuation; risk: RiskAssessment;
  /** which optimisation modes pick this route */
  tags: RoutingMode[];
  /** on the price/time/risk Pareto frontier: no other route is at least as good on all three and better on one */
  pareto: boolean;
}
export interface RouteSearch { routes: Route[]; best: Partial<Record<RoutingMode, string>>; events: QuoteEvent[]; reachable: boolean; ms: number }
export interface RouterOptions { deadlineMs?: number; maxHops?: 1 | 2; signal?: AbortSignal; onEvent?: (e: QuoteEvent) => void; onRoute?: (r: Route) => void }

const worst = (a: Executability, b: Executability): Executability => { const rank = { verified: 0, opaque: 1, quote_only: 2 } as const; return rank[a.class] >= rank[b.class] ? a : b; };
const riskRank = { low: 0, medium: 1, high: 2 } as const;

export class SwapRouter {
  constructor(private agg: QuoteAggregator, private graph: LiquidityGraph, private value: Valuer, private now: () => number = Date.now) {}

  private route(legs: SwapQuote[], peers: SwapQuote[]): Route {
    const first = legs[0]!, last = legs[legs.length - 1]!;
    // a composed route is valued on its real endpoints: input of the first leg, guaranteed output of the last
    const composite: SwapQuote = legs.length === 1 ? first : { ...last, id: legs.map((l) => l.id).join('+'), provider: legs.map((l) => l.provider).join('+'),
      request: { ...first.request, to: last.request.to, recipient: last.request.recipient }, steps: legs.flatMap((l) => l.steps), fees: legs.flatMap((l) => l.fees),
      estimatedSeconds: legs.every((l) => l.estimatedSeconds !== null) ? legs.reduce((s, l) => s + l.estimatedSeconds!, 0) : null,
      priceImpactBps: legs.every((l) => l.priceImpactBps !== null) ? legs.reduce((s, l) => s + l.priceImpactBps!, 0) : null,
      quotedAt: Math.min(...legs.map((l) => l.quotedAt)), expiresAt: Math.min(...legs.map((l) => l.expiresAt)), executability: legs.map((l) => l.executability).reduce(worst), atomic: false,
      refundable: legs.some((l) => l.refundable === false) ? false : legs.some((l) => l.refundable === null) ? null : true };
    const valuation = valueQuote(composite, this.value);
    return { id: composite.id, legs, providers: legs.map((l) => l.provider), path: [first.request.from, ...legs.map((l) => l.request.to)], amountIn: first.request.amountIn,
      amountOut: composite.amountOut, minAmountOut: composite.minAmountOut, estimatedSeconds: composite.estimatedSeconds, expiresAt: composite.expiresAt,
      executability: composite.executability, valuation, risk: assessRisk(composite, valuation, legs.length === 1 ? peers : []), tags: [], pareto: false };
  }

  async search(req: SwapQuoteRequest, opts: RouterOptions = {}): Promise<RouteSearch> {
    const t0 = this.now(), deadline = opts.deadlineMs ?? 4500;
    const events: QuoteEvent[] = [], direct: SwapQuote[] = [], routes: Route[] = [];
    const emit = (e: QuoteEvent) => { events.push(e); opts.onEvent?.(e); };
    const paths = this.graph.paths(req.from, req.to, opts.maxHops ?? 2);
    const reachable = paths.length > 0;
    const hubs = paths.filter((p) => p.length === 3).map((p) => this.graph.nodes.get(p[1]!)!).slice(0, 4);
    const remaining = () => Math.max(300, deadline - (this.now() - t0));

    // direct quotes and the first legs of hub routes are requested at the same time
    const directJob = (async () => {
      if (!paths.some((p) => p.length === 2)) return;
      for await (const e of this.agg.stream(req, { deadlineMs: deadline, signal: opts.signal })) { emit(e);
        if (e.type === 'quote') { direct.push(e.quote); this.observe(e.quote, e.ms); const r = this.route([e.quote], direct); routes.push(r); opts.onRoute?.(r); } }
    })();
    const hubJobs = hubs.map(async (hub) => {
      // leg 1 delivers the intermediate asset to the wallet itself; leg 2 spends only what leg 1 guarantees
      const hubRecipient = hub.network === req.from.network ? req.sender : req.recipient;
      const leg1 = await this.agg.collect({ ...req, to: { network: hub.network, asset: hub.asset }, recipient: hubRecipient }, { deadlineMs: Math.floor(deadline * 0.5), signal: opts.signal, role: 'leg' });
      for (const q of leg1.quotes) this.observe(q, 0);
      const best1 = leg1.quotes.sort((a, b) => (a.minAmountOut > b.minAmountOut ? -1 : 1))[0];
      if (!best1) return;
      const leg2 = await this.agg.collect({ from: { network: hub.network, asset: hub.asset }, to: req.to, amountIn: best1.minAmountOut, sender: hubRecipient, recipient: req.recipient, slippageBps: req.slippageBps },
        { deadlineMs: remaining(), signal: opts.signal, role: 'leg' });
      for (const q of leg2.quotes) this.observe(q, 0);
      const best2 = leg2.quotes.sort((a, b) => (a.minAmountOut > b.minAmountOut ? -1 : 1))[0];
      if (!best2) return;
      const r = this.route([best1, best2], []); routes.push(r); opts.onRoute?.(r);
    });
    await Promise.allSettled([directJob, ...hubJobs]);

    // re-assess direct routes now that every peer is known (outlier detection needs the full set)
    for (const r of routes) if (r.legs.length === 1) r.risk = assessRisk(r.legs[0]!, r.valuation, direct);
    // a route through an intermediate asset is only worth showing if it clearly beats the best direct route
    const bestDirect = routes.filter((r) => r.legs.length === 1).reduce((m, r) => (r.minAmountOut > m ? r.minAmountOut : m), 0n);
    const kept = routes.filter((r) => r.legs.length === 1 || bestDirect === 0n || r.minAmountOut * 1000n > bestDirect * 1003n);
    const best = rank(kept);
    return { routes: kept, best, events, reachable, ms: this.now() - t0 };
  }
  private observe(q: SwapQuote, ms: number): void {
    this.graph.observe({ provider: q.provider, from: assetKey(q.request.from), to: assetKey(q.request.to), amountIn: q.request.amountIn.toString(), amountOut: q.amountOut.toString(), minAmountOut: q.minAmountOut.toString(), ms, at: this.now(), ok: true });
  }
}

/** Order routes and pick one per mode. Security policy first: a high-risk route is never selected while a lower-risk one exists. */
export function rank(routes: Route[]): Partial<Record<RoutingMode, string>> {
  for (const r of routes) { r.tags = []; r.pareto = false; }
  if (!routes.length) return {};
  // net guaranteed output: in fiat when priced (so fees paid in another asset count), otherwise raw minimum output
  const priced = routes.every((r) => r.valuation.netUsd !== null);
  const net = (r: Route) => (priced ? r.valuation.netUsd! : Number(r.minAmountOut));
  const time = (r: Route) => r.estimatedSeconds ?? Number.POSITIVE_INFINITY;
  const lowest = Math.min(...routes.map((r) => riskRank[r.risk.level]));
  const admissible = routes.filter((r) => riskRank[r.risk.level] === lowest || r.risk.level !== 'high');
  const pool = admissible.length ? admissible : routes;
  const byPrice = [...pool].sort((a, b) => net(b) - net(a) || time(a) - time(b));
  const bestNet = net(byPrice[0]!);
  // fastest: among routes that give up at most 2 % of the best net output
  const near = pool.filter((r) => net(r) >= bestNet - Math.abs(bestNet) * 0.02);
  const byTime = [...near].sort((a, b) => time(a) - time(b) || net(b) - net(a));
  // balanced: normalised net output, minus time and risk penalties (weights are explicit and fixed)
  const maxT = Math.max(1, ...pool.map((r) => (Number.isFinite(time(r)) ? time(r) : 0)));
  const score = (r: Route) => (bestNet !== 0 ? net(r) / Math.abs(bestNet) : 0) - 0.03 * (Number.isFinite(time(r)) ? time(r) / maxT : 1) - 0.004 * r.risk.score;
  const byScore = [...pool].sort((a, b) => score(b) - score(a));
  const pick: Partial<Record<RoutingMode, string>> = { best_price: byPrice[0]!.id, fastest: byTime[0]!.id, balanced: byScore[0]!.id };
  for (const [mode, id] of Object.entries(pick) as [RoutingMode, string][]) routes.find((r) => r.id === id)!.tags.push(mode);
  for (const r of routes) r.pareto = !routes.some((o) => o !== r && net(o) >= net(r) && time(o) <= time(r) && o.risk.score <= r.risk.score && (net(o) > net(r) || time(o) < time(r) || o.risk.score < r.risk.score));
  routes.sort((a, b) => net(b) - net(a));
  return pick;
}

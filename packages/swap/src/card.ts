// The normalized route card (v11): the SAME object for every route of a quote response, whatever the provider.
// Built only from what the provider adapters reported (`SwapQuote`) and from the caller's price reference. A value a
// provider does not give is `null` — it is never estimated here. The type is `RouteCard` in types.ts.
import type { Route } from './router.ts';
import type { Valuer } from './risk.ts';
import { sameAsset, type FeeItem, type FeeKind, type RouteCard, type RouteCardFee } from './types.ts';

/** What only the caller knows: whether the wallet can execute the route itself, through whom, and the route's fingerprint. */
export interface RouteCardFacts { executable: boolean; executor: string | null; reasonCode: string | null; fingerprint: string }

const PROTOCOL: FeeKind[] = ['protocol', 'provider', 'bridge', 'affiliate'];

export function buildRouteCard(r: Route, value: Valuer, facts: RouteCardFacts): RouteCard {
  const fees = r.legs.flatMap((l) => l.fees), first = r.legs[0]!, from = r.path[0]!;
  const item = (f: FeeItem): RouteCardFee => ({ kind: f.kind, asset: f.asset, amount: f.amount, estimated: f.estimated, includedInOutput: f.includedInOutput, usd: value(f.asset, f.amount) });
  // USD total of a group: null as soon as one item has no price (a partial sum would understate the fee)
  const usdOf = (items: RouteCardFee[]): number | null => (items.every((i) => i.usd !== null) ? items.reduce((s, i) => s + i.usd!, 0) : null);

  const net = fees.filter((f) => f.kind === 'network').map(item);
  const proto = fees.filter((f) => PROTOCOL.includes(f.kind)).map(item);
  const inUsd = r.valuation.inUsd, protoUsd = usdOf(proto);
  // protocol fee in basis points of the amount sent: exact when every item is charged in the asset sent, otherwise from the price reference
  const protoBps = !proto.length ? null
    : proto.every((i) => sameAsset(i.asset, from)) && r.amountIn > 0n ? Number((proto.reduce((s, i) => s + i.amount, 0n) * 10_000n) / r.amountIn)
    : protoUsd !== null && inUsd !== null && inUsd > 0 ? Math.round((protoUsd / inUsd) * 10_000) : null;

  return {
    routeId: r.id, providers: r.providers, fingerprint: facts.fingerprint,
    amountIn: r.amountIn, estimatedOut: r.amountOut, minimumOut: r.minAmountOut,
    networkFee: net.length ? { items: net, usd: usdOf(net), estimated: net.some((i) => i.estimated), includedInOutput: net.every((i) => i.includedInOutput) } : null,
    protocolFee: proto.length ? { items: proto, usd: protoUsd, bps: protoBps, includedInOutput: proto.every((i) => i.includedInOutput) } : null,
    toleranceBps: first.request.slippageBps,
    // what the estimated output is worth against the amount sent at the reference price: positive = the route costs that much
    effectiveSlippageBps: inUsd !== null && r.valuation.outUsd !== null && inUsd > 0 ? Math.round(((inUsd - r.valuation.outUsd) / inUsd) * 10_000) : null,
    etaSeconds: r.estimatedSeconds,
    riskLevel: r.risk.level, riskFlags: r.risk.flags.map((f) => f.code),
    steps: r.legs.flatMap((l) => l.steps.map((s) => ({ kind: s.kind, network: s.from.network, toNetwork: s.to.network, provider: s.provider, descriptionCode: `step_${s.kind}` }))),
    // a route is as old as its oldest leg, and expires with the first one that does
    quotedAt: Math.min(...r.legs.map((l) => l.quotedAt)), expiresAt: r.expiresAt,
    executable: facts.executable, executor: facts.executor, reasonCode: facts.executable ? null : facts.reasonCode,
  };
}

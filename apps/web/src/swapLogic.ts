// The two decisions of the Swap screen that must not drift from what is executed (v11) — pure, tested without a browser:
//
//  heroOf     (B1) what « Vous recevez » shows: ALWAYS the option the action executes — the selected CCTP speed on a CCTP pair,
//             the executable route otherwise — never the top-ranked quote of a comparison-only provider.
//  prepareOf  (B6) which route is prepared and how: the executor is the one the SERVER stated on the displayed route (it used to
//             be guessed from which routes happened to be in the stream), and the route's reference travels with the request.
export type Executor = 'kyberswap' | 'cctp' | 'jupiter' | 'thorchain';
export interface QuoteRefV { id: string; provider: string; fingerprint: string; amountOut: string; minAmountOut: string; quotedAt: number }
export interface HeroRoute { id: string; executable: boolean; executor?: Executor | null; exec?: { via: Executor; speed?: 'standard' | 'fast' | null } | null; providers: string[];
  amountOutDisplay: string; minAmountOutDisplay: string; valuation: { outUsd: number | null }; fingerprint?: string; quotedAt?: number; amountOut?: string; minAmountOut?: string }
export interface BridgeOption { speed: 'standard' | 'fast'; available: boolean; minReceiveDisplay: string; quote?: QuoteRefV | null }
export interface Hero { source: 'cctp' | Executor; out: string; min: string; usd: number | null; provider: string }

/** The executor of a route as the server stated it (`executor`; `exec.via` is the same fact in the older field). */
export const executorOf = (r: HeroRoute | null | undefined): Executor | null => (r && r.executable ? r.executor ?? r.exec?.via ?? null : null);

/**
 * `sorted` = the routes in display order (best first). Returns the figure of the hero, or null when nothing is executable here —
 * and, separately, the best route when it is NOT the one executed (to be named as a comparison, never as the amount received).
 */
export function heroOf(o: { isBridge: boolean; option?: BridgeOption | null; sorted: HeroRoute[] }): { hero: Hero | null; ex: HeroRoute | null; bestOther: HeroRoute | null } {
  const ex = o.sorted.find((r) => executorOf(r) !== null) ?? null;
  if (o.isBridge) {
    // a CCTP transfer is executed with the selected speed: its own minimum, whatever the stream ranks first
    const opt = o.option && o.option.available ? o.option : null;
    return { hero: opt ? { source: 'cctp', out: opt.minReceiveDisplay, min: opt.minReceiveDisplay, usd: null, provider: 'cctp' } : null, ex, bestOther: null };
  }
  const top = o.sorted[0] ?? null;
  return { hero: ex ? { source: executorOf(ex)!, out: ex.amountOutDisplay, min: ex.minAmountOutDisplay, usd: ex.valuation.outUsd, provider: ex.providers[0]! } : null, ex, bestOther: top && top.id !== ex?.id ? top : null };
}

export interface Pair { from: { network: string; asset: string }; to: { network: string; asset: string } }
export interface Prepared { path: '/bridge/proposals' | '/xswap/proposals' | '/swap/proposals'; body: Record<string, unknown>; via: Executor }
/** The request that prepares what is displayed, or null when nothing here is executable. */
export function prepareOf(o: Pair & { amount: string; slippageBps: number; isBridge: boolean; speed: 'standard' | 'fast'; option?: BridgeOption | null; ex: HeroRoute | null }): Prepared | null {
  const via: Executor | null = o.isBridge ? 'cctp' : executorOf(o.ex);
  if (!via) return null;
  const ex = o.ex;
  // the reference of what was shown: the selected CCTP option, or the executable route of the stream (a CCTP route of the stream
  // is quoted with the swap tolerance, not as the option that is executed: no reference is sent for it)
  const ref: QuoteRefV | undefined = o.isBridge ? o.option?.quote ?? undefined
    : via !== 'cctp' && ex?.fingerprint && ex.amountOut && ex.minAmountOut ? { id: ex.id, provider: ex.providers[0]!, fingerprint: ex.fingerprint, amountOut: ex.amountOut, minAmountOut: ex.minAmountOut, quotedAt: ex.quotedAt ?? Date.now() } : undefined;
  const quote = ref ? { quote: ref } : {};
  if (via === 'cctp') return { via, path: '/bridge/proposals', body: { fromNetwork: o.from.network, toNetwork: o.to.network, amount: o.amount, speed: o.isBridge ? o.speed : ex?.exec?.speed ?? 'standard', ...quote } };
  if (via === 'thorchain') return { via, path: '/xswap/proposals', body: { fromNetwork: o.from.network, fromAsset: o.from.asset, toNetwork: o.to.network, toAsset: o.to.asset, amount: o.amount, slippageBps: o.slippageBps, ...quote } };
  return { via, path: '/swap/proposals', body: { network: o.from.network, fromAsset: o.from.asset, toAsset: o.to.asset, amount: o.amount, slippageBps: o.slippageBps, ...quote } };
}

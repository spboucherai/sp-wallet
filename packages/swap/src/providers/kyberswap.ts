// KyberSwap Aggregator — same-chain EVM swaps, price discovery only (see docs/swap/providers/kyberswap.md).
// One keyless round: GET {BASE}/{chain}/api/v1/routes. The route is never encoded here (POST /route/build is the
// execution phase); slippage, recipient and deadline only exist in that second call, so the guaranteed minimum is
// derived from the quoted output exactly as KyberSwap defines it: output reduced by `slippageTolerance` basis points.
import { z } from 'zod';
import { getNetwork } from '@spw/core';
import { ProviderError, resolveAsset, sameAsset, type AssetRef, type FeeItem, type ProviderContext, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from '../types.ts';
import type { ProviderEnv } from './index.ts';

const ID = 'kyberswap';
/** Pinned. Keyless base (public limit 3 requests/s); the keyed gateway https://api.kyberswap.com/swap/ is not used. */
export const KYBERSWAP_API_BASE = 'https://aggregator-api.kyberswap.com';
export const KYBERSWAP_API_VERSION = 'v1';
const DOCS = 'https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps';
/** MetaAggregationRouterV2, same address on every supported chain — https://docs.kyberswap.com/developer-guide/aggregator-api/contracts */
export const KYBERSWAP_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
/** How KyberSwap designates a chain's native coin. */
export const KYBERSWAP_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
/** wallet network id -> KyberSwap chain path segment. Each one is listed in the API specification and answered live on 2026-11-10. */
export const KYBERSWAP_CHAINS: Record<string, string> = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', optimism: 'optimism', bsc: 'bsc', avalanche: 'avalanche', hyperevm: 'hyperevm',
};
/** `slippageTolerance` is accepted in [0, 2000] bps unless `ignoreCappedSlippage` is set, which this wallet never does. */
export const KYBERSWAP_MAX_SLIPPAGE_BPS = 2000;
/** "it is recommended to not cache routes from client side for more than 5-10 seconds" */
const VALIDITY_MS = 10_000;
/** a route stamped this far from our clock is a cached or replayed answer */
const MAX_CLOCK_SKEW_MS = 120_000;
/** error codes that mean "nothing to trade", not "provider failure": route not found, no eligible pool, token unknown, amount above the maximum */
const NO_ROUTE_CODES = new Set([4008, 4009, 4010, 4011]);

const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const usd = z.string().regex(/^\d+(\.\d+)?([eE][-+]?\d+)?$/);
// loose objects: unknown keys are kept, because `routeSummary` must later be sent back to /route/build exactly as received
const hop = z.looseObject({ pool: z.string().max(200), tokenIn: address, tokenOut: address, swapAmount: uint, amountOut: uint, exchange: z.string().min(1).max(64), poolType: z.string().max(64) });
const routeSummary = z.looseObject({
  tokenIn: address, amountIn: uint, amountInUsd: usd, tokenOut: address, amountOut: uint, amountOutUsd: usd,
  gas: uint, gasPrice: uint, gasUsd: usd, l1FeeUsd: usd.optional(),
  extraFee: z.looseObject({ feeAmount: z.string(), chargeFeeBy: z.string(), isInBps: z.boolean(), feeReceiver: z.string() }),
  route: z.array(z.array(hop).min(1).max(12)).min(1).max(32),
  routerAddress: address.optional(), routeID: z.string().min(1).max(128), checksum: z.string().min(1).max(128), timestamp: z.number().int().positive(),
});
export const kyberswapRoutesSchema = z.looseObject({ code: z.literal(0), data: z.looseObject({ routeSummary, routerAddress: address }) });
export type KyberswapRoutes = z.infer<typeof kyberswapRoutesSchema>;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const wire = (a: AssetRef) => (a.asset === 'native' ? KYBERSWAP_NATIVE : a.asset);
const bad = (msg: string) => new ProviderError(ID, 'schema', msg);

export function createKyberswapProvider(env: ProviderEnv = {}): SwapProvider {
  // sent as x-client-id ("your app or company name"); requests without it are rate limited more strictly
  const clientId = env.KYBERSWAP_CLIENT_ID ?? 'swap-router';
  if (!/^[\w.-]{1,64}$/.test(clientId)) throw new Error('KYBERSWAP_CLIENT_ID: letters, digits, dot, dash, underscore (1–64)');
  const networks = Object.keys(KYBERSWAP_CHAINS);
  const known = (a: AssetRef) => { try { resolveAsset(a); return true; } catch { return false; } };
  const supportsPair = (from: AssetRef, to: AssetRef) =>
    from.network === to.network && from.network in KYBERSWAP_CHAINS && known(from) && known(to) && getNetwork(from.network).family === 'evm' && !sameAsset(from, to);

  return {
    id: ID, name: 'KyberSwap',
    capabilities: () => ({ networks, crossChain: false, needsKey: false, configured: true, kinds: ['swap'], docs: DOCS }),
    supportsPair,
    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!supportsPair(req.from, req.to)) return [];
      if (req.amountIn <= 0n) return [];
      if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0) throw new ProviderError(ID, 'bad_response', 'slippage must be a whole number of basis points');
      if (req.slippageBps > KYBERSWAP_MAX_SLIPPAGE_BPS) return []; // the provider would refuse to encode it
      const net = getNetwork(req.from.network), tokenIn = wire(req.from), tokenOut = wire(req.to);
      // `origin` (the user's address) is deliberately not sent: it is optional and price discovery should not disclose the wallet
      const url = `${KYBERSWAP_API_BASE}/${KYBERSWAP_CHAINS[net.id]}/api/${KYBERSWAP_API_VERSION}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${req.amountIn.toString()}`;
      let body: unknown;
      try { body = await ctx.http.getJson(url, { headers: { 'x-client-id': clientId }, signal: ctx.signal }); }
      catch (e) {
        const code = (e as { body?: { code?: unknown } }).body?.code;
        if (e instanceof ProviderError && e.code === 'http' && typeof code === 'number' && NO_ROUTE_CODES.has(code)) return [];
        throw e;
      }
      const parsed = kyberswapRoutesSchema.safeParse(body);
      if (!parsed.success) throw bad(`unexpected answer: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 200));
      const { routeSummary: s, routerAddress } = parsed.data.data;
      if (!eq(s.tokenIn, tokenIn) || !eq(s.tokenOut, tokenOut)) throw bad('route is for another token pair');
      if (BigInt(s.amountIn) !== req.amountIn) throw bad('route is for another input amount');
      if (!eq(routerAddress, KYBERSWAP_ROUTER) || (s.routerAddress !== undefined && !eq(s.routerAddress, KYBERSWAP_ROUTER))) throw bad('router is not the pinned MetaAggregationRouterV2');
      if (s.extraFee.chargeFeeBy !== '' || !['', '0'].includes(s.extraFee.feeAmount)) throw bad('route carries a fee that was not requested');
      const now = ctx.now();
      if (Math.abs(now - s.timestamp * 1000) > MAX_CLOCK_SKEW_MS) throw new ProviderError(ID, 'bad_response', 'route timestamp is stale');
      const amountOut = BigInt(s.amountOut);
      if (amountOut <= 0n) return [];
      // KyberSwap: "the estimated output adjusted by the selected max slippage", slippageTolerance in bps. Rounded down.
      const minAmountOut = (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
      if (minAmountOut <= 0n) return [];
      const fees: FeeItem[] = [{ kind: 'network', asset: { network: net.id, asset: 'native' }, amount: BigInt(s.gas) * BigInt(s.gasPrice), includedInOutput: false, estimated: true }];
      // the provider's own USD estimates of both sides; the same ratio its interface shows as price impact. Display only.
      const inUsd = Number(s.amountInUsd), outUsd = Number(s.amountOutUsd);
      const impact = inUsd > 0 && outUsd > 0 ? Math.round(((inUsd - outUsd) / inUsd) * 10_000) : null;
      const via = [...new Set(s.route.flat().map((h) => h.exchange))].slice(0, 12);
      const contracts: SwapQuote['steps'][number]['contracts'] = [{ network: net.id, address: KYBERSWAP_ROUTER, role: 'router' }];
      if (req.from.asset !== 'native') contracts.push({ network: net.id, address: KYBERSWAP_ROUTER, role: 'spender' });
      return [{
        id: `${ID}-${s.routeID}`, provider: ID, request: req,
        steps: [{ kind: 'swap', provider: ID, from: req.from, to: req.to, via, contracts }],
        amountOut, minAmountOut, fees,
        estimatedSeconds: null,
        priceImpactBps: impact !== null && impact >= -10_000 && impact <= 10_000 ? impact : null,
        quotedAt: now, expiresAt: now + VALIDITY_MS,
        firmness: 'indicative',
        executability: { class: 'opaque', code: 'kyber_calldata', reason: 'KyberSwap returns router calldata (MetaAggregationRouterV2) built by its API; the signer can pin the router, the allowance, the recipient and the minimum output but cannot rebuild the route' },
        refundable: true, // one transaction: it settles in full or reverts, the input never leaves the sender otherwise
        atomic: true,
        raw: parsed.data.data,
      }];
    },
  };
}

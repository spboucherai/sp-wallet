/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/src/providers/lifi.ts
 * Module           : providers
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// LI.FI — cross-chain and same-chain routing aggregator (bridges + DEX aggregators behind one "Diamond" contract).
// Price discovery only: this adapter asks POST /v1/advanced/routes, which returns priced routes WITHOUT transaction data
// (calldata is only produced later by /v1/advanced/stepTransaction, which this adapter never calls). Nothing is built,
// signed or sent. Execution dossier: docs/swap/providers/lifi.md.
//
// Verified live on 2026-11-10 (GET /v1/chains?chainTypes=SVM,UTXO,MVM,TVM,STL and /v1/chains): chain ids and Diamond
// addresses below. Stellar is listed by LI.FI (id 1201081091099710) but no route delivers native XLM today, and Litecoin,
// Dogecoin, Bitcoin Cash, XRPL, Aptos, Cosmos, NEAR and TON are not LI.FI chains: none of them is declared here.
import { z } from 'zod';
import { isValidAddress } from '@spw/core';
import {
  ProviderError, resolveAsset, sameAsset,
  type AssetRef, type FeeItem, type FeeKind, type ProviderContext, type RouteStep, type SwapProvider, type SwapQuote, type SwapQuoteRequest,
} from '../types.ts';
import type { ProviderEnv } from './index.ts';

const ID = 'lifi';
/** pinned API base and version */
export const LIFI_API = 'https://li.quest/v1';
export const LIFI_DOCS = 'https://docs.li.fi/api-reference/advanced/get-a-set-of-routes-for-a-request-that-describes-a-transfer-of-tokens';
/** LI.FI gives no validity for a route: conservative default from the provider contract */
const VALIDITY_MS = 30_000;
const MAX_ROUTES = 12;

/** wallet network id -> LI.FI chain id, the id LI.FI uses for the chain coin, and the LiFiDiamond where one exists (GET /v1/chains, 2026-11-10) */
export const LIFI_CHAINS: Record<string, { chainId: number; native: string; diamond?: string }> = {
  ethereum: { chainId: 1, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  base: { chainId: 8453, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  arbitrum: { chainId: 42161, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  polygon: { chainId: 137, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  optimism: { chainId: 10, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  bsc: { chainId: 56, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  avalanche: { chainId: 43114, native: '0x0000000000000000000000000000000000000000', diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  hyperevm: { chainId: 999, native: '0x0000000000000000000000000000000000000000', diamond: '0x0a0758d937d1059c356D4714e57F5df0239bce1A' },
  tron: { chainId: 728126428, native: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', diamond: 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt' },
  solana: { chainId: 1151111081099710, native: '11111111111111111111111111111111' },
  bitcoin: { chainId: 20000000000001, native: 'bitcoin' },
  sui: { chainId: 9270000000000000, native: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI' },
};
const NETWORK_OF = new Map(Object.entries(LIFI_CHAINS).map(([net, c]) => [c.chainId, net]));

// ---- response schema (unknown keys are stripped; `raw` is the validated route) ----
/** base units as a decimal string: no sign, no fraction, no exponent */
const Amount = z.string().regex(/^\d{1,78}$/);
/** LI.FI's ids for non-EVM chains are large (Sui: 9270000000000000, above 2^53 but an exact double): integer-valued, not "safe" */
const ChainId = z.number().positive().max(1e17).refine(Number.isInteger, 'not an integer');
const Token = z.object({ address: z.string().min(1).max(128), chainId: ChainId, symbol: z.string().max(64), decimals: z.number().int().min(0).max(36) });
const FeeCost = z.object({
  name: z.string().max(128), token: Token, amount: Amount, included: z.boolean(),
  feeSplit: z.object({ lifiFee: Amount, integratorFee: Amount }).optional(),
});
const GasCost = z.object({ type: z.string().max(32), amount: Amount, token: Token });
const Duration = z.number().finite().min(0).max(7 * 86400);
const IncludedStep = z.object({
  id: z.string().max(128), type: z.enum(['swap', 'cross', 'protocol']), tool: z.string().max(64),
  toolDetails: z.object({ key: z.string().max(64), name: z.string().min(1).max(64) }),
  action: z.object({ fromChainId: ChainId, toChainId: ChainId, fromToken: Token, toToken: Token, fromAmount: Amount, toAddress: z.string().max(128).optional() }),
  estimate: z.object({ fromAmount: Amount, toAmount: Amount, toAmountMin: Amount, approvalAddress: z.string().max(128).optional(), feeCosts: z.array(FeeCost).max(32).optional() }),
});
const Step = z.object({
  id: z.string().max(128), type: z.enum(['lifi', 'swap', 'cross']), tool: z.string().max(64),
  toolDetails: z.object({ key: z.string().max(64), name: z.string().min(1).max(64) }),
  action: z.object({
    fromChainId: ChainId, toChainId: ChainId, fromToken: Token, toToken: Token, fromAmount: Amount,
    slippage: z.number().finite().min(0).max(1), fromAddress: z.string().max(128), toAddress: z.string().max(128),
  }),
  estimate: z.object({
    fromAmount: Amount, toAmount: Amount, toAmountMin: Amount, approvalAddress: z.string().max(128).optional(),
    feeCosts: z.array(FeeCost).max(32).optional(), gasCosts: z.array(GasCost).max(16).optional(), executionDuration: Duration,
  }),
  includedSteps: z.array(IncludedStep).min(1).max(12),
});
const Route = z.object({
  id: z.string().min(1).max(128),
  fromChainId: ChainId, toChainId: ChainId, fromToken: Token, toToken: Token,
  fromAmount: Amount, toAmount: Amount, toAmountMin: Amount, fromAddress: z.string().max(128), toAddress: z.string().max(128),
  containsSwitchChain: z.boolean().optional(), tags: z.array(z.string().max(32)).max(8).optional(),
  steps: z.array(Step).min(1).max(8),
});
const RoutesResponse = z.object({ routes: z.array(Route).max(64) });
type LifiToken = z.infer<typeof Token>;
type LifiRoute = z.infer<typeof Route>;

const bad = (msg: string): never => { throw new ProviderError(ID, 'schema', msg); };
const isEvm = (network: string) => resolveAsset({ network, asset: 'native' }).net.family === 'evm';
const sameAddr = (network: string, a: string, b: string) => (isEvm(network) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** the identifier LI.FI uses for a registry asset */
function lifiToken(a: AssetRef): string { return a.asset === 'native' ? LIFI_CHAINS[a.network]!.native : a.asset; }
/** a LI.FI token -> registry asset, or null when the chain or the token is outside the wallet's registry. Wrong decimals are a schema error. */
function refOf(t: LifiToken): AssetRef | null {
  const network = NETWORK_OF.get(t.chainId);
  if (!network) return null;
  const ref: AssetRef = sameAddr(network, t.address, LIFI_CHAINS[network]!.native) ? { network, asset: 'native' } : { network, asset: t.address };
  let def;
  try { def = resolveAsset(ref).def; } catch { return null; }
  if (def.decimals !== t.decimals) bad(`decimals mismatch for ${t.symbol} on ${network}: provider ${t.decimals}, registry ${def.decimals}`);
  return ref.asset === 'native' ? ref : { network, asset: def.id };
}
const sameToken = (a: LifiToken, b: LifiToken) => a.chainId === b.chainId && (NETWORK_OF.has(a.chainId) ? sameAddr(NETWORK_OF.get(a.chainId)!, a.address, b.address) : a.address === b.address);

/**
 * One LI.FI route -> SwapQuote, or null when the wallet cannot represent it (several user transactions, a fee the user would
 * have to pay in an asset outside the registry). Anything that contradicts the request is a schema error.
 */
function toQuote(route: LifiRoute, req: SwapQuoteRequest, now: number): SwapQuote | null {
  const src = LIFI_CHAINS[req.from.network]!, dst = LIFI_CHAINS[req.to.network]!;
  const from = refOf(route.fromToken), to = refOf(route.toToken);
  if (route.fromChainId !== src.chainId || route.toChainId !== dst.chainId || !from || !to || !sameAsset(from, req.from) || !sameAsset(to, req.to)) bad('route is for another pair');
  if (BigInt(route.fromAmount) !== req.amountIn) bad('route is for another amount');
  if (!sameAddr(req.from.network, route.fromAddress, req.sender)) bad('route is for another sender');
  if (!sameAddr(req.to.network, route.toAddress, req.recipient)) bad('route pays another recipient');
  const amountOut = BigInt(route.toAmount), minAmountOut = BigInt(route.toAmountMin);
  if (amountOut <= 0n || minAmountOut <= 0n || minAmountOut > amountOut) bad('inconsistent output amounts');
  // one top-level step = one transaction signed by the user; more than one needs a second signature (often on the destination chain)
  if (route.containsSwitchChain || route.steps.length !== 1) return null;
  const step = route.steps[0]!;
  if (Math.abs(step.action.slippage - req.slippageBps / 10_000) > 1e-9) bad('route was priced with another slippage');
  if (BigInt(step.action.fromAmount) !== req.amountIn || BigInt(step.estimate.toAmount) !== amountOut || BigInt(step.estimate.toAmountMin) !== minAmountOut) bad('step amounts differ from the route');
  if (!sameAddr(req.to.network, step.action.toAddress, req.recipient) || !sameAddr(req.from.network, step.action.fromAddress, req.sender)) bad('step is for other addresses');
  // the contract the user approves / calls must be the pinned Diamond wherever LI.FI has one (EVM, TRON)
  if (src.diamond && (!step.estimate.approvalAddress || !sameAddr(req.from.network, step.estimate.approvalAddress, src.diamond))) bad('approval address is not the pinned LI.FI Diamond');

  // ---- steps: included steps in order; legs through an asset outside the registry are merged into the next one ----
  const inc = step.includedSteps;
  if (!sameToken(inc[0]!.action.fromToken, route.fromToken) || !sameToken(inc[inc.length - 1]!.action.toToken, route.toToken)) bad('included steps do not connect the requested assets');
  const steps: RouteStep[] = [];
  const feeKindByName = new Map<string, FeeKind>();
  let open: { from: AssetRef; via: string[]; contracts: RouteStep['contracts']; cross: boolean } | null = null, cursor: AssetRef = req.from;
  // the Diamond is the contract called, and the spender to approve when the input is a token
  const carried: RouteStep['contracts'] = !src.diamond ? [] : [{ network: req.from.network, address: src.diamond, role: 'router' }];
  if (src.diamond && req.from.asset !== 'native') carried.push({ network: req.from.network, address: src.diamond, role: 'spender' });
  for (let k = 0; k < inc.length; k++) {
    const s = inc[k]!;
    if (k > 0 && !sameToken(inc[k - 1]!.action.toToken, s.action.fromToken)) bad('included steps are not contiguous');
    if (s.action.fromToken.chainId !== s.action.fromChainId || s.action.toToken.chainId !== s.action.toChainId) bad('included step token is on another chain');
    for (const f of s.estimate.feeCosts ?? []) feeKindByName.set(f.name, s.type === 'cross' ? 'bridge' : s.type === 'swap' ? 'protocol' : 'provider');
    const net = NETWORK_OF.get(s.action.fromChainId), addr = s.estimate.approvalAddress;
    const usable = !!net && !!addr && isValidAddress(net, addr) && !sameAddr(net, addr, LIFI_CHAINS[net]!.diamond ?? '') && addr !== req.sender && addr !== req.recipient;
    if (s.type === 'protocol' && sameToken(s.action.fromToken, s.action.toToken)) {
      // LI.FI's fee step ("FeeForwarder" contract): no asset changes; its contract is reported with the next leg, its fee in `fees`
      if (usable) carried.push({ network: net!, address: addr!, role: 'router' });
      continue;
    }
    if ((s.type === 'cross') !== (s.action.fromChainId !== s.action.toChainId)) bad('step type contradicts its chains');
    open ??= { from: cursor, via: [], contracts: carried.splice(0), cross: false };
    open.via.push(s.toolDetails.name); open.cross ||= s.type === 'cross';
    if (usable) open.contracts.push({ network: net!, address: addr!, role: s.type === 'cross' ? 'bridge' : 'router' });
    const reached = refOf(s.action.toToken);
    if (reached) { steps.push({ kind: open.cross ? 'bridge' : 'swap', provider: ID, from: open.from, to: reached, via: open.via, contracts: open.contracts }); cursor = reached; open = null; }
  }
  if (open || steps.length === 0) bad('included steps do not end on the requested asset');
  if (steps.length > 6) return null;

  // ---- fees ----
  const fees: FeeItem[] = [];
  for (const g of step.estimate.gasCosts ?? []) {
    const asset = refOf(g.token);
    if (!asset || asset.network !== req.from.network) return bad('gas is quoted in an asset the wallet does not hold on the source network');
    fees.push({ kind: 'network', asset, amount: BigInt(g.amount), includedInOutput: false, estimated: true });
  }
  for (const f of step.estimate.feeCosts ?? []) {
    const asset = refOf(f.token);
    if (!asset) { if (f.included) continue; return null; } // already inside the output (kept in `raw`) / would have to be paid in an unknown asset
    const amount = BigInt(f.amount), kind = feeKindByName.get(f.name) ?? (req.from.network === req.to.network ? 'protocol' : 'bridge');
    const lifi = f.feeSplit ? BigInt(f.feeSplit.lifiFee) : 0n, integrator = f.feeSplit ? BigInt(f.feeSplit.integratorFee) : 0n;
    if (f.feeSplit && lifi + integrator === amount) {
      if (lifi > 0n) fees.push({ kind: 'provider', asset, amount: lifi, includedInOutput: f.included, estimated: false });
      if (integrator > 0n) fees.push({ kind: 'affiliate', asset, amount: integrator, includedInOutput: f.included, estimated: false });
    } else fees.push({ kind, asset, amount, includedInOutput: f.included, estimated: false });
  }

  const sameChain = req.from.network === req.to.network && steps.every((s) => s.kind === 'swap');
  return {
    id: `${ID}:${route.id}`, provider: ID, request: req, steps, amountOut, minAmountOut, fees,
    estimatedSeconds: Math.ceil(step.estimate.executionDuration), priceImpactBps: null, quotedAt: now, expiresAt: now + VALIDITY_MS,
    firmness: 'indicative',
    executability: { class: 'opaque', code: 'lifi_diamond', reason: 'LI.FI builds the calldata for its Diamond contract (bridge and DEX facets, per-bridge data); the signer can pin the target contract and the exact allowance but cannot recompute the recipient, the minimum output or the bridge payload by itself' },
    // same chain: one transaction that reverts as a whole. Cross-chain: refund depends on the bridge LI.FI picked (status REFUNDED / PARTIAL), not stated per route
    refundable: sameChain ? true : null, atomic: sameChain,
    raw: route,
  };
}

export function createLifiProvider(env: ProviderEnv = {}): SwapProvider {
  const key = env.LIFI_API_KEY?.trim() || undefined, integrator = env.LIFI_INTEGRATOR?.trim() || 'sp-wallet';
  const networks = Object.keys(LIFI_CHAINS);
  const known = (a: AssetRef) => { if (!LIFI_CHAINS[a.network]) return false; try { resolveAsset(a); return true; } catch { return false; } };
  return {
    id: ID, name: 'LI.FI',
    // the public API works without a key (75 route requests per 2 h per IP); a key only raises the limit
    capabilities: () => ({ networks, crossChain: true, needsKey: false, configured: true, kinds: ['swap', 'bridge'], docs: LIFI_DOCS }),
    // LI.FI on TRON is cross-chain only ("quotes with Tron as the source chain are always cross-chain", docs, 2026-11-10)
    supportsPair: (from, to) => known(from) && known(to) && !sameAsset(from, to) && !(from.network === to.network && from.network === 'tron'),
    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!this.supportsPair(req.from, req.to)) return [];
      if (req.amountIn <= 0n || !Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 5000) throw new ProviderError(ID, 'bad_response', 'invalid amount or slippage');
      const body = {
        fromChainId: LIFI_CHAINS[req.from.network]!.chainId, toChainId: LIFI_CHAINS[req.to.network]!.chainId,
        fromTokenAddress: lifiToken(req.from), toTokenAddress: lifiToken(req.to),
        fromAmount: req.amountIn.toString(), fromAddress: req.sender, toAddress: req.recipient,
        // slippage is a fraction (0.005 = 0.5 %), applied by LI.FI per step; allowSwitchChain:false keeps routes to one user transaction
        options: { slippage: req.slippageBps / 10_000, integrator, allowSwitchChain: false },
      };
      let payload: unknown;
      try { payload = await ctx.http.postJson(`${LIFI_API}/advanced/routes`, body, { signal: ctx.signal, headers: key ? { 'x-lifi-api-key': key } : undefined }); }
      catch (e) {
        // 404 = LI.FI does not list one of the tokens (code 1003): nothing to route, not a failure
        if (e instanceof ProviderError && e.code === 'http' && (e as { status?: number }).status === 404) return [];
        throw e;
      }
      const parsed = RoutesResponse.safeParse(payload);
      if (!parsed.success) throw new ProviderError(ID, 'schema', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const now = ctx.now(), quotes: SwapQuote[] = [];
      for (const r of parsed.data.routes) { const q = toQuote(r, req, now); if (q && quotes.length < MAX_ROUTES) quotes.push(q); }
      return quotes;
    },
  };
}

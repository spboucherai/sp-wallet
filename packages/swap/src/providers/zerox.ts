// 0x Swap API v2 — same-chain EVM swaps, COMPARISON ONLY (docs/swap/providers/0x.md).
//
// 0x requires an API key on every call ("Every 0x API call requires an API key"): without ZEROX_API_KEY this provider is
// reported as `needsKey` / not configured and is never asked — no quote is ever fabricated. With a key it asks ONE
// indicative price per search: GET /swap/allowance-holder/price. It never asks a firm quote (/quote returns a transaction;
// this wallet has no signer-verified execution path for 0x Settler transactions), so a 0x route is `quote_only`.
//
// Implemented against the official documentation read on 2026-11-15 (no key was available: nothing here was checked live;
// the tests replay documentation-derived fixtures, labelled as such).
import { z } from 'zod';
import { getNetwork } from '@spw/core';
import { ProviderError, resolveAsset, sameAsset, type AssetRef, type FeeItem, type ProviderContext, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from '../types.ts';
import type { ProviderEnv } from './index.ts';

const ID = 'zerox';
/** Pinned. https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getprice.md */
export const ZEROX_API_BASE = 'https://api.0x.org';
export const ZEROX_API_VERSION = 'v2';
export const ZEROX_PRICE_PATH = '/swap/allowance-holder/price';
const DOCS = 'https://docs.0x.org/evm/0x-swap-api/guides/swap-tokens-with-0x-swap-api.md';
/** How 0x designates a chain's native coin (https://docs.0x.org/docs/0x-swap-api/additional-topics/handling-native-tokens). */
export const ZEROX_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
/** wallet network id -> chain id, each one in 0x's "Swap API supported chains" table (https://docs.0x.org/docs/introduction/supported-chains.md, 2026-11-15). */
export const ZEROX_CHAINS: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, bsc: 56, avalanche: 43114, hyperevm: 999 };
/** AllowanceHolder (the only contract a taker approves) on the Cancun-hardfork chains — every chain above. Shown as the step's spender; never trusted for execution. */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
/** The price answer has no expiry field. An indicative price is kept this long, then asked again (our choice, like KyberSwap's 10 s). */
const VALIDITY_MS = 15_000;
/** error names that mean "nothing to trade for this pair", not "provider failure" */
const NO_ROUTE_ERRORS = new Set(['TOKEN_NOT_SUPPORTED', 'BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE', 'SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE']);

const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const fee = z.looseObject({ amount: uint, token: address, type: z.string().max(20) });
// loose objects: fields the documentation does not list are kept (in `raw`) but never used
export const zeroxPriceSchema = z.looseObject({
  liquidityAvailable: z.literal(true),
  buyAmount: uint, minBuyAmount: uint, sellAmount: uint, buyToken: address, sellToken: address,
  allowanceTarget: address.nullish(),
  fees: z.looseObject({ integratorFee: fee.nullish(), integratorFees: z.array(fee).max(8).nullish(), zeroExFee: fee.nullish(), gasFee: fee.nullish() }),
  gas: z.union([uint, z.number().int().nonnegative()]).nullish(), gasPrice: uint.nullish(), totalNetworkFee: uint.nullish(),
  route: z.looseObject({ fills: z.array(z.looseObject({ from: address, to: address, source: z.string().min(1).max(64), proportionBps: z.string().max(8) })).max(64), tokens: z.array(z.looseObject({ address, symbol: z.string().max(40) })).max(64) }),
  zid: z.string().max(80).optional(),
});
const noLiquiditySchema = z.looseObject({ liquidityAvailable: z.literal(false) });

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const wire = (a: AssetRef) => (a.asset === 'native' ? ZEROX_NATIVE : a.asset);
const bad = (msg: string) => new ProviderError(ID, 'schema', msg);

export function createZeroxProvider(env: ProviderEnv = {}): SwapProvider {
  const key = env.ZEROX_API_KEY?.trim() ?? '';
  if (key && !/^[\w.-]{8,128}$/.test(key)) throw new Error('ZEROX_API_KEY: unexpected format (letters, digits, dot, dash, underscore; 8–128)');
  const networks = Object.keys(ZEROX_CHAINS);
  const known = (a: AssetRef) => { try { resolveAsset(a); return true; } catch { return false; } };
  const supportsPair = (from: AssetRef, to: AssetRef) =>
    from.network === to.network && from.network in ZEROX_CHAINS && known(from) && known(to) && getNetwork(from.network).family === 'evm' && !sameAsset(from, to);

  return {
    id: ID, name: '0x',
    capabilities: () => ({ networks, crossChain: false, needsKey: true, configured: key !== '', kinds: ['swap'], docs: DOCS }),
    supportsPair,
    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!key) throw new ProviderError(ID, 'unavailable', '0x needs an API key (ZEROX_API_KEY)'); // the aggregator never gets here without one
      if (!supportsPair(req.from, req.to) || req.amountIn <= 0n) return [];
      if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 10_000) throw new ProviderError(ID, 'bad_response', 'slippage must be a whole number of basis points');
      const net = getNetwork(req.from.network), sellToken = wire(req.from), buyToken = wire(req.to);
      // `taker` is optional and deliberately not sent: an indicative price should not disclose the wallet's address to a third party.
      // Tolerance: `slippagePpm` (parts per million; 1 bps = 100 ppm). The documentation marks `slippageBps` as deprecated in its favour,
      // and the two are mutually exclusive. `minBuyAmount` in the answer is 0x's own minimum for that tolerance.
      const url = `${ZEROX_API_BASE}${ZEROX_PRICE_PATH}?chainId=${ZEROX_CHAINS[net.id]}&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${req.amountIn.toString()}&slippagePpm=${req.slippageBps * 100}`;
      let body: unknown;
      try { body = await ctx.http.getJson(url, { headers: { '0x-api-key': key, '0x-version': ZEROX_API_VERSION }, signal: ctx.signal }); }
      catch (e) {
        const name = (e as { body?: { name?: unknown } }).body?.name;
        if (e instanceof ProviderError && e.code === 'http' && typeof name === 'string' && NO_ROUTE_ERRORS.has(name)) return [];
        throw e;
      }
      if (noLiquiditySchema.safeParse(body).success) return [];
      const parsed = zeroxPriceSchema.safeParse(body);
      if (!parsed.success) throw bad(`unexpected answer: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 200));
      const p = parsed.data;
      if (!eq(p.sellToken, sellToken) || !eq(p.buyToken, buyToken)) throw bad('price is for another token pair');
      if (BigInt(p.sellAmount) !== req.amountIn) throw bad('price is for another input amount');
      if (p.fees.integratorFee || (p.fees.integratorFees?.length ?? 0) > 0) throw bad('price carries an integrator fee that was not requested');
      const amountOut = BigInt(p.buyAmount), minAmountOut = BigInt(p.minBuyAmount); // 0x's own minimum for the tolerance sent: "the transaction reverts below this"
      if (amountOut <= 0n || minAmountOut <= 0n) return [];
      if (minAmountOut > amountOut) throw bad('minimum above the expected amount');
      const now = ctx.now();

      const fees: FeeItem[] = [];
      // network cost as 0x estimates it (wei of the native coin); not part of the output
      if (p.totalNetworkFee != null) fees.push({ kind: 'network', asset: { network: net.id, asset: 'native' }, amount: BigInt(p.totalNetworkFee), includedInOutput: false, estimated: true });
      // 0x's own fee: charged in the sell or the buy token. `buyAmount` is documented as "the amount of buyToken to receive",
      // i.e. after it — so it is reported as already included in the output (never subtracted a second time).
      for (const f of [p.fees.zeroExFee, p.fees.gasFee]) {
        if (!f) continue;
        const asset = eq(f.token, buyToken) ? req.to : eq(f.token, sellToken) ? req.from : null;
        if (!asset) throw bad('a fee is charged in a token that is neither side of the pair');
        fees.push({ kind: f.type === 'gas' ? 'network' : 'provider', asset, amount: BigInt(f.amount), includedInOutput: true, estimated: false });
      }
      const via = [...new Set(p.route.fills.map((f) => f.source))].slice(0, 12);
      const contracts: SwapQuote['steps'][number]['contracts'] = req.from.asset === 'native' ? [] : [{ network: net.id, address: p.allowanceTarget ?? ZEROX_ALLOWANCE_HOLDER, role: 'spender' }];
      return [{
        id: `${ID}-${p.zid ?? `${now}`}`, provider: ID, request: req,
        steps: [{ kind: 'swap', provider: ID, from: req.from, to: req.to, via, contracts }],
        amountOut, minAmountOut, fees,
        estimatedSeconds: null, // one transaction; 0x gives no duration
        priceImpactBps: null,   // the price answer has no impact field
        quotedAt: now, expiresAt: now + VALIDITY_MS,
        firmness: 'indicative',
        executability: { class: 'quote_only', code: 'comparison_only', reason: '0x is a price comparison source in this wallet: its transactions go through Settler contracts that are redeployed over time and that the isolated signer does not decode, so nothing is built or signed from this quote' },
        refundable: true, atomic: true, // informative: a 0x swap is one transaction that settles in full or reverts
        raw: p,
      }];
    },
  };
}

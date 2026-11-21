/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/src/providers/oneinch.ts
 * Module           : providers
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

// 1inch Classic Swap API v6.1 — same-chain EVM swaps, COMPARISON ONLY (docs/swap/providers/1inch.md).
//
// 1inch requires an API key (`Authorization: Bearer <key>`, 1inch Business portal): without ONEINCH_API_KEY this provider is
// reported as `needsKey` / not configured and is never asked — no quote is ever fabricated. With a key it asks ONE quote per
// search: GET /swap/v6.1/{chainId}/quote. It never calls /swap (which returns a transaction for AggregationRouterV6; this
// wallet has no signer-verified execution path for it), so a 1inch route is `quote_only`.
//
// Implemented against the official documentation read on 2026-11-15 (no key was available: nothing here was checked live;
// the tests replay documentation-derived fixtures, labelled as such).
import { z } from 'zod';
import { getNetwork } from '@spw/core';
import { ProviderError, resolveAsset, sameAsset, type AssetRef, type ProviderContext, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from '../types.ts';
import type { ProviderEnv } from './index.ts';

const ID = 'oneinch';
/** Pinned. https://business.1inch.com/portal/documentation/apis/swap/classic-swap/methods/v6.1/chainId/quote/method/get */
export const ONEINCH_API_BASE = 'https://api.1inch.com/swap';
export const ONEINCH_API_VERSION = 'v6.1';
const DOCS = 'https://business.1inch.com/portal/documentation/apis/swap/classic-swap/quick-start';
/** How the documentation's own example designates the native coin (`src=0xeeee…eeee`). */
export const ONEINCH_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/** AggregationRouterV6: the spender of a 1inch swap (quick start). Shown as the step's contract; never trusted for execution. */
export const ONEINCH_ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65';
/** wallet network id -> chain id; each is in 1inch's current chain list for Classic Swap v6.1 (dossier: the lists differ between pages). */
export const ONEINCH_CHAINS: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, bsc: 56, avalanche: 43114, hyperevm: 999 };
/** The quote has no expiry field. It is kept this long, then asked again (our choice, like KyberSwap's 10 s). */
const VALIDITY_MS = 15_000;

const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/);
// loose objects: fields the documentation does not list are kept (in `raw`) but never used
export const oneinchQuoteSchema = z.looseObject({
  dstAmount: uint,
  gas: z.number().int().nonnegative().max(100_000_000).optional(),
  protocols: z.array(z.looseObject({ token: z.string().max(80), hops: z.array(z.looseObject({ part: z.number(), dst: z.string().max(80),
    protocols: z.array(z.looseObject({ name: z.string().min(1).max(64), part: z.number() })).max(64) })).max(64) })).max(32).optional(),
  srcToken: z.looseObject({ address: z.string().max(80) }).optional(), dstToken: z.looseObject({ address: z.string().max(80) }).optional(),
});

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const wire = (a: AssetRef) => (a.asset === 'native' ? ONEINCH_NATIVE : a.asset);
const bad = (msg: string) => new ProviderError(ID, 'schema', msg);

export function createOneinchProvider(env: ProviderEnv = {}): SwapProvider {
  const key = env.ONEINCH_API_KEY?.trim() ?? '';
  if (key && !/^[\w.-]{8,128}$/.test(key)) throw new Error('ONEINCH_API_KEY: unexpected format (letters, digits, dot, dash, underscore; 8–128)');
  const networks = Object.keys(ONEINCH_CHAINS);
  const known = (a: AssetRef) => { try { resolveAsset(a); return true; } catch { return false; } };
  const supportsPair = (from: AssetRef, to: AssetRef) =>
    from.network === to.network && from.network in ONEINCH_CHAINS && known(from) && known(to) && getNetwork(from.network).family === 'evm' && !sameAsset(from, to);

  return {
    id: ID, name: '1inch',
    capabilities: () => ({ networks, crossChain: false, needsKey: true, configured: key !== '', kinds: ['swap'], docs: DOCS }),
    supportsPair,
    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!key) throw new ProviderError(ID, 'unavailable', '1inch needs an API key (ONEINCH_API_KEY)'); // the aggregator never gets here without one
      if (!supportsPair(req.from, req.to) || req.amountIn <= 0n) return [];
      if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 5000) throw new ProviderError(ID, 'bad_response', 'slippage must be a whole number of basis points (at most 50 %)');
      const net = getNetwork(req.from.network), src = wire(req.from), dst = wire(req.to);
      // no address is sent: /quote takes none (the wallet's address would only appear in /swap, which is never called)
      const url = `${ONEINCH_API_BASE}/${ONEINCH_API_VERSION}/${ONEINCH_CHAINS[net.id]}/quote?src=${src}&dst=${dst}&amount=${req.amountIn.toString()}&includeTokensInfo=true&includeProtocols=true&includeGas=true`;
      let body: unknown;
      try { body = await ctx.http.getJson(url, { headers: { Authorization: `Bearer ${key}` }, signal: ctx.signal }); }
      catch (e) {
        // the documentation does not publish the error body; the one message that means "nothing to trade" is matched narrowly, the rest is a failure
        const b = (e as { body?: { description?: unknown; error?: unknown }; status?: number });
        if (e instanceof ProviderError && e.code === 'http' && b.status === 400 && /insufficient liquidity/i.test(`${String(b.body?.description ?? '')} ${String(b.body?.error ?? '')}`)) return [];
        throw e;
      }
      const parsed = oneinchQuoteSchema.safeParse(body);
      if (!parsed.success) throw bad(`unexpected answer: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 200));
      const q = parsed.data;
      // when the answer names its tokens (includeTokensInfo), they must be the pair that was asked
      if (q.srcToken && !eq(q.srcToken.address, src)) throw bad('quote is for another source token');
      if (q.dstToken && !eq(q.dstToken.address, dst)) throw bad('quote is for another destination token');
      const amountOut = BigInt(q.dstAmount);
      if (amountOut <= 0n) return [];
      // /quote takes no tolerance. The minimum is what 1inch's own /swap would enforce for the tolerance the owner chose
      // (`slippage`, in percent of the quoted amount): quoted output reduced by that tolerance, rounded down. Nothing is signed from it.
      const minAmountOut = (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
      if (minAmountOut <= 0n) return [];
      const now = ctx.now();
      const via = [...new Set((q.protocols ?? []).flatMap((p) => p.hops.flatMap((h) => h.protocols.map((x) => x.name))))].slice(0, 12);
      const contracts: SwapQuote['steps'][number]['contracts'] = [{ network: net.id, address: ONEINCH_ROUTER, role: 'router' }];
      if (req.from.asset !== 'native') contracts.push({ network: net.id, address: ONEINCH_ROUTER, role: 'spender' });
      return [{
        id: `${ID}-${net.id}-${now}-${amountOut}`, provider: ID, request: req,
        steps: [{ kind: 'swap', provider: ID, from: req.from, to: req.to, via, contracts }],
        amountOut, minAmountOut,
        // The quote gives gas UNITS only (`gas`), no gas price: a fee in the native coin cannot be stated without inventing a price,
        // so no network fee is reported (the units stay in `raw`). 1inch charges no protocol fee unless the caller asks for one.
        fees: [],
        estimatedSeconds: null, priceImpactBps: null,
        quotedAt: now, expiresAt: now + VALIDITY_MS,
        firmness: 'indicative',
        executability: { class: 'quote_only', code: 'comparison_only', reason: '1inch is a price comparison source in this wallet: its swaps are calldata for AggregationRouterV6 in several encodings that the isolated signer does not decode, so nothing is built or signed from this quote' },
        refundable: true, atomic: true, // informative: a 1inch swap is one transaction that settles in full or reverts
        raw: q,
      }];
    },
  };
}

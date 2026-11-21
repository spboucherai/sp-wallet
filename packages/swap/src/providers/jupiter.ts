/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/swap/src/providers/jupiter.ts
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

// Jupiter (Solana) — price discovery through the Swap API V2 "Router" path: GET /swap/v2/build (Metis on-chain routing only,
// no Jupiter swap fee). One call returns the quote AND the raw instructions; nothing here assembles, signs or sends anything.
//
// Why /build and not the other endpoints (checked against https://developers.jup.ag/docs on 2026-11-10):
//  - Swap API V1 (/swap/v1/quote, /swap, /swap-instructions) still answers but is documented as "no longer actively
//    maintained and superseded by Swap V2"; lite-api.jup.ag is being phased out in favour of keyless api.jup.ag.
//  - /swap/v2/order is the Meta-Aggregator: its transaction cannot be modified and must be landed by Jupiter's /execute,
//    it charges a Jupiter platform fee, and without a taker it returns slippageBps 0 and no guaranteed minimum.
//  - /build states `otherAmountThreshold` for exactly the slippage we ask for and returns the instructions a self-custody
//    wallet would have to inspect. Execution dossier: docs/swap/providers/jupiter.md.
import { z } from 'zod';
import { NETWORKS } from '@spw/core';
import { ProviderError, resolveAsset, sameAsset, type AssetRef, type FeeItem, type ProviderContext, type RouteStep, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from '../types.ts';
import { JUPITER_DEX_PROGRAMS } from './jupiter-dexes.ts';
import type { ProviderEnv } from './index.ts';

export const JUPITER_ID = 'jupiter';
/** Pinned API: keyless on api.jup.ag (0.5 request/s; measured 5 requests per 10 s sliding window). */
export const JUPITER_API_BASE = 'https://api.jup.ag/swap/v2';
export const JUPITER_API_VERSION = 'Swap API V2 — Router (GET /build), instruction format V2';
export const JUPITER_DOCS = 'https://developers.jup.ag/docs/swap/build';
/** Jupiter v6 swap aggregator program (named in https://developers.jup.ag/docs/swap/routing/rfq/v2/streaming). */
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Native SOL is quoted as the wrapped-SOL mint; /build wraps and unwraps by default (wrapAndUnwrapSol=true). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** What a keyless caller may send: use this for the provider runtime (the default policy of 2 requests/s would be throttled). */
export const JUPITER_KEYLESS_POLICY = { ratePerSec: 0.5, burst: 4 } as const;
const SOLANA = 'solana';
/** Jupiter states no price validity; a quote is treated as stale after 30 s (the blockhash it carries lives ~150 slots ≈ 60 s). */
const QUOTE_TTL_MS = 30_000;
/** Programs a /build answer may use outside the swap instruction itself (compute budget, wrap/unwrap, token accounts). */
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const AUX_PROGRAMS = new Set([
  COMPUTE_BUDGET,
  '11111111111111111111111111111111', // System (SOL transfer into the wrapped-SOL account)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token (SyncNative, CloseAccount)
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account (CreateIdempotent)
]);
/** Solana protocol constants used for the network-fee ceiling: 5 000 lamports per signature, at most 1.4 M compute units. */
const LAMPORTS_PER_SIGNATURE = 5_000n, MAX_COMPUTE_UNITS = 1_400_000n;
/** `400 {"error": …}` answers that mean "no route for this pair/size" rather than a failure (observed live 2026-11-10). */
const NO_ROUTE_ERRORS = new Set(['No routes found', 'Insufficient liquidity']);
const U64_MAX = (1n << 64n) - 1n;

const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'not a base58 public key');
/** u64 as a decimal string: digits only, no sign, no fraction, no exponent, no leading zero. */
const u64 = z.string().refine((s) => /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= U64_MAX, 'not an unsigned 64-bit integer string');
const instruction = z.object({
  programId: pubkey,
  accounts: z.array(z.object({ pubkey, isSigner: z.boolean(), isWritable: z.boolean() })).max(256),
  data: z.string().max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64'),
});
const leg = z.object({
  swapInfo: z.object({ ammKey: pubkey, label: z.string().min(1).max(64), inputMint: pubkey, outputMint: pubkey, inAmount: u64, outAmount: u64 }),
  /** share of the amount entering this leg's input mint, basis points (canonical in V2; `percent` is the legacy field) */
  bps: z.number().int().min(0).max(10_000),
  percent: z.number().min(0).max(100).nullish(),
});
/** GET /swap/v2/build, 200. Unknown extra keys are dropped: `raw` only ever carries what was validated here. */
export const jupiterBuildSchema = z.object({
  inputMint: pubkey, outputMint: pubkey,
  inAmount: u64, outAmount: u64, otherAmountThreshold: u64,
  swapMode: z.literal('ExactIn'),
  slippageBps: z.number().int().min(0).max(10_000),
  /** decimal ratio, e.g. "0.001" = 0.1 % */
  priceImpactPct: z.string().max(64).regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/, 'not a decimal'),
  routePlan: z.array(leg).min(1).max(32),
  computeBudgetInstructions: z.array(instruction).max(4),
  setupInstructions: z.array(instruction).max(16),
  swapInstruction: instruction,
  cleanupInstruction: instruction.nullable(),
  // nothing we ask for produces these: no tip, no integrator fee, no extra instruction
  otherInstructions: z.array(instruction).max(0),
  tipInstruction: z.null().optional(),
  platformFee: z.null().optional(),
  addressesByLookupTableAddress: z.record(pubkey, z.array(pubkey).max(256)).nullable(),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number().int().min(0).max(255)).length(32),
    lastValidBlockHeight: z.number().int().positive(),
    fetchedAt: z.object({ secs_since_epoch: z.number().int().positive(), nanos_since_epoch: z.number().int().min(0) }),
  }),
  transactionVersion: z.literal(0),
});
export type JupiterBuild = z.infer<typeof jupiterBuildSchema>;

const mintOf = (a: AssetRef): string => (a.asset === 'native' ? WSOL_MINT : a.asset);
const isRegistered = (a: AssetRef): boolean => { try { resolveAsset(a); return true; } catch { return false; } };
const bad = (msg: string): never => { throw new ProviderError(JUPITER_ID, 'schema', msg); };

/** Priority-fee price (micro-lamports per compute unit) from a SetComputeUnitPrice instruction: tag 0x03 + u64 LE. */
function computeUnitPrice(b: JupiterBuild): bigint {
  let price = 0n;
  for (const ix of b.computeBudgetInstructions) {
    const raw = Uint8Array.from(atob(ix.data), (c) => c.charCodeAt(0));
    if (raw.length !== 9 || raw[0] !== 3) bad('unexpected compute budget instruction');
    price = new DataView(raw.buffer).getBigUint64(1, true);
  }
  return price;
}

/** Everything the answer must agree with before it becomes a quote. Any mismatch is a schema error: the answer is not trusted. */
function crossCheck(b: JupiterBuild, req: SwapQuoteRequest, inMint: string, outMint: string): { amountOut: bigint; minAmountOut: bigint } {
  if (b.inputMint !== inMint || b.outputMint !== outMint) bad('answer is for other mints');
  if (BigInt(b.inAmount) !== req.amountIn) bad('answer is for another input amount');
  if (b.slippageBps !== req.slippageBps) bad('answer uses another slippage');
  const amountOut = BigInt(b.outAmount), minAmountOut = BigInt(b.otherAmountThreshold);
  if (amountOut <= 0n) bad('non-positive output');
  // Jupiter's guaranteed minimum is outAmount − floor(outAmount × slippageBps / 10 000). It is taken as given, but only
  // inside the band the requested slippage allows: never above the expected output, never below the exact floor.
  const floor = (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
  if (minAmountOut > amountOut || minAmountOut < floor || minAmountOut <= 0n) bad('guaranteed minimum outside the requested slippage');
  // route plan: what leaves the input mint and what reaches the output mint must be the quoted amounts
  let fromIn = 0n, toOut = 0n;
  for (const { swapInfo: s } of b.routePlan) {
    if (s.inputMint === s.outputMint) bad('route leg swaps a mint for itself');
    if (s.inputMint === inMint) fromIn += BigInt(s.inAmount);
    if (s.outputMint === outMint) toOut += BigInt(s.outAmount);
  }
  if (fromIn !== req.amountIn || toOut !== amountOut) bad('route plan does not add up to the quoted amounts');
  // instructions: the swap goes to the Jupiter aggregator, everything else to the few programs wrap/unwrap and token
  // accounts need, and the only signer anywhere is the wallet the quote was asked for
  if (b.swapInstruction.programId !== JUPITER_PROGRAM) bad('swap instruction is not for the Jupiter aggregator program');
  const aux = [...b.computeBudgetInstructions, ...b.setupInstructions, ...(b.cleanupInstruction ? [b.cleanupInstruction] : [])];
  for (const ix of b.computeBudgetInstructions) if (ix.programId !== COMPUTE_BUDGET) bad('unexpected compute budget program');
  for (const ix of aux) if (!AUX_PROGRAMS.has(ix.programId)) bad(`unexpected program ${ix.programId}`);
  let takerSigns = false;
  for (const ix of [...aux, b.swapInstruction]) for (const a of ix.accounts) if (a.isSigner) { if (a.pubkey !== req.sender) bad('answer is for another wallet'); if (ix === b.swapInstruction) takerSigns = true; }
  if (!takerSigns) bad('swap instruction is not signed by the requesting wallet');
  return { amountOut, minAmountOut };
}

export function createJupiterProvider(env: ProviderEnv = {}): SwapProvider {
  const key = env.JUPITER_API_KEY?.trim() || undefined; // optional: only raises the rate limit
  let seq = 0;
  const supportsPair = (from: AssetRef, to: AssetRef): boolean => from.network === SOLANA && to.network === SOLANA && isRegistered(from) && isRegistered(to) && !sameAsset(from, to);
  return {
    policy: JUPITER_KEYLESS_POLICY,
    id: JUPITER_ID,
    // the licence requires any non-Ultra use of the API to be labelled "Metis" to end users (SDK & API License Agreement §2.3)
    name: 'Jupiter (Metis)',
    capabilities: () => ({ networks: SOLANA in NETWORKS ? [SOLANA] : [], crossChain: false, needsKey: false, configured: true, kinds: ['swap'], docs: JUPITER_DOCS }),
    supportsPair,
    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!supportsPair(req.from, req.to)) return [];
      // What this adapter cannot serve as asked is "no route", decided locally: the output of a /build swap lands in the
      // taker's own token account (no third-party recipient), amounts are positive u64, slippage is whole basis points.
      if (req.recipient !== req.sender || !pubkey.safeParse(req.sender).success) return [];
      if (req.amountIn <= 0n || req.amountIn > U64_MAX || !Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 10_000) return [];
      const inMint = mintOf(req.from), outMint = mintOf(req.to);
      const url = `${JUPITER_API_BASE}/build?${new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: req.amountIn.toString(), taker: req.sender, slippageBps: String(req.slippageBps) })}`;
      let body: unknown;
      try { body = await ctx.http.getJson(url, { signal: ctx.signal, ...(key ? { headers: { 'x-api-key': key } } : {}) }); }
      catch (e) {
        const err = e as ProviderError & { status?: number; body?: unknown };
        const msg = (err.body as { error?: unknown } | null | undefined)?.error;
        if (err instanceof ProviderError && err.code === 'http' && err.status === 400 && typeof msg === 'string' && NO_ROUTE_ERRORS.has(msg)) return [];
        throw e;
      }
      const parsed = jupiterBuildSchema.safeParse(body);
      if (!parsed.success) return bad(`unexpected /build answer: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const b = parsed.data;
      const { amountOut, minAmountOut } = crossCheck(b, req, inMint, outMint);

      const labels = [...new Set(b.routePlan.map((l) => l.swapInfo.label))];
      const contracts: RouteStep['contracts'] = [{ network: SOLANA, address: JUPITER_PROGRAM, role: 'router' }];
      for (const p of new Set(labels.flatMap((l) => JUPITER_DEX_PROGRAMS[l] ?? []))) contracts.push({ network: SOLANA, address: p, role: 'program' });
      for (const k of new Set(b.routePlan.map((l) => l.swapInfo.ammKey))) contracts.push({ network: SOLANA, address: k, role: 'vault' });
      // Network fee as a ceiling from the answer and protocol constants: one signature plus the returned compute-unit price
      // at the maximum compute budget (the real limit is only known after simulation). Rent for a token account the swap
      // may have to create (≈0.002 SOL, refundable) is not reported by Jupiter and not included.
      const networkFee = LAMPORTS_PER_SIGNATURE + (computeUnitPrice(b) * MAX_COMPUTE_UNITS + 999_999n) / 1_000_000n;
      const fees: FeeItem[] = [{ kind: 'network', asset: { network: SOLANA, asset: 'native' }, amount: networkFee, includedInOutput: false, estimated: true }];
      const impact = Number(b.priceImpactPct) * 10_000;
      const now = ctx.now();
      return [{
        id: `${JUPITER_ID}-${now.toString(36)}-${(seq++).toString(36)}`,
        provider: JUPITER_ID,
        request: req,
        // One step: the whole route (splits, intermediate mints, wrap/unwrap) is a single atomic Jupiter instruction, and its
        // intermediate mints are not wallet assets. The venues are named in `via`; the detail stays in `raw.routePlan`.
        steps: [{ kind: 'swap', provider: JUPITER_ID, from: req.from, to: req.to, via: labels, contracts }],
        amountOut, minAmountOut, fees,
        estimatedSeconds: null,
        priceImpactBps: Number.isFinite(impact) ? Math.round(impact * 100) / 100 : null,
        quotedAt: now, expiresAt: Math.min(now, b.blockhashWithMetadata.fetchedAt.secs_since_epoch * 1000) + QUOTE_TTL_MS,
        firmness: 'indicative',
        executability: { class: 'opaque', code: 'jupiter_instructions', reason: 'Jupiter returns provider-built instructions (route data for many AMM programs, dozens of accounts, address lookup tables) that the isolated signer cannot rebuild; it could only constrain them structurally and by simulation' },
        refundable: true, // a single transaction: it either settles in full or reverts, funds never leave the wallet otherwise
        atomic: true,
        raw: b,
      }];
    },
  };
}

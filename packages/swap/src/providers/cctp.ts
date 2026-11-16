// Circle Cross-Chain Transfer Protocol (CCTP) — quote adapter. Price discovery only: nothing here builds, signs or sends.
//
// What it quotes: Circle-issued stablecoins burned on one of the wallet's networks and minted 1:1 on another.
//   USDC — CCTP V2 (TokenMessengerV2.depositForBurn -> Iris attestation -> MessageTransmitterV2.receiveMessage)
//   EURC — "CCTP for non-USDC" (CrossChainTokenService.crossChainTransfer, same attestation service), EVM only
// Two quotes per pair where the source chain has both speeds: Standard (attested at finality) and Fast (attested at
// confirmation, charged in basis points). The destination mint is a separate transaction that the wallet itself must
// submit and pay in the destination chain's coin; that cost is a FeeItem and is named in the step.
//
// Every address, domain id, duration and size below is pinned from Circle's documentation (read 2026-11-10) and is
// re-checked on-chain by scripts/smoke-swap-cctp.mts. Sources and the execution path: docs/swap/providers/cctp.md.
import { z } from 'zod';
import { isValidAddress } from '@spw/core';
import { ProviderError, resolveAsset, type AssetRef, type FeeItem, type ProviderContext, type RouteStep, type SwapProvider, type SwapQuote, type SwapQuoteRequest } from '../types.ts';
import type { ProviderEnv } from './index.ts';

const ID = 'cctp';
/** Circle's attestation service ("Iris"), mainnet. Keyless; 40 requests/s, a breach blocks the caller for five minutes. */
export const CCTP_API = 'https://iris-api.circle.com';
export const CCTP_API_VERSION = 'v2';
export const CCTP_DOCS = 'https://developers.circle.com/cctp';

/** minFinalityThreshold values defined by CCTP V2 (anything <= 1000 is Fast, anything above is Standard). */
export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

/** CCTP V2 on EVM: the same addresses on every chain (https://developers.circle.com/cctp/references/contract-addresses). */
export const CCTP_EVM = {
  tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  tokenMinter: '0xfd78EE919681417d192449715b2594ab58f5D002',
} as const;
/** CCTP V2 on Solana (https://developers.circle.com/cctp/references/solana-programs). */
export const CCTP_SOLANA = {
  messageTransmitter: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  tokenMessengerMinter: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
} as const;
/** CCTP for non-USDC assets (EURC): one service address on every EVM chain, one TokenManager per token. */
export const CCTPX = {
  service: '0x431871229103b780868f8C6BB820cd16ECf942BC',
  eurcTokenId: '0x6ca9e29fa53becc29becaf4a90b9ca7a995ad4d2234880da13ca38c657fb241c',
  eurcTokenManager: '0x8c27579e24f9f19d96724e19fc059dacd1469e10',
} as const;

export interface CctpChain {
  /** Circle's domain id — not a chain id */
  domain: number;
  /** can this chain be the SOURCE of a Fast Transfer (Circle disables it where finality is already fast) */
  fastSource: boolean;
  /** documented time for the attestation to become available, seconds (upper bound of the documented range) */
  standardSeconds: number; fastSeconds: number | null;
  /** EURC is deployed here and enabled in CCTP for non-USDC */
  eurc: boolean;
}
/**
 * The wallet's networks that CCTP V2 serves with native USDC. Domains: /cctp/concepts/supported-chains-and-domains;
 * times: /cctp/concepts/finality-and-block-confirmations. BNB Smart Chain has a domain (17) but carries USYC only, and
 * Stellar/Sui/Aptos are CCTP chains whose USDC is not in the wallet's registry: none of them is listed.
 */
export const CCTP_CHAINS: Record<string, CctpChain> = {
  ethereum: { domain: 0, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 20, eurc: true },
  avalanche: { domain: 1, fastSource: false, standardSeconds: 8, fastSeconds: null, eurc: true },
  optimism: { domain: 2, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 8, eurc: false },
  arbitrum: { domain: 3, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 8, eurc: false },
  solana: { domain: 5, fastSource: true, standardSeconds: 17, fastSeconds: 1, eurc: false },
  base: { domain: 6, fastSource: true, standardSeconds: 19 * 60, fastSeconds: 8, eurc: true },
  polygon: { domain: 7, fastSource: false, standardSeconds: 8, fastSeconds: null, eurc: false },
  hyperevm: { domain: 19, fastSource: false, standardSeconds: 5, fastSeconds: null, eurc: false },
};

/** "There is a $10 million limit on the amount of USDC that can be burned in a single CCTP transaction." */
export const USDC_BURN_LIMIT = 10_000_000n * 1_000_000n;
/** A fee schedule above this is treated as a corrupted answer, not as a price (Circle's Fast fees are 0–14 bps). */
const MAX_SANE_FEE_BPS = 100n;
/** Gas units, pinned above what real mainnet transactions used on 2026-11-10 (samples in the dossier). Estimates. */
const GAS = {
  approve: 60_000n,
  usdcBurn: 120_000n, usdcMint: 200_000n,
  eurcBurn: 380_000n, eurcMint: 240_000n,
} as const;
/** Solana: lamports per signature (protocol constant) and the sizes of the accounts a transfer creates. */
const SOL = { lamportsPerSignature: 5_000n, burnSignatures: 2n, mintSignatures: 1n, messageSentBytes: 428, usedNonceBytes: 9, tokenAccountBytes: 165 } as const;

const ZERO32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const schemaError = (m: string) => new ProviderError(ID, 'schema', m);

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests and for the next phase)

/** A JSON number as an exact decimal scaled by 10^decimals. Refuses exponents, signs and non-finite values. */
function scaled(n: number, decimals: number, what: string, truncate = false): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(n));
  if (!m) throw schemaError(`${what}: not a plain non-negative decimal`);
  const frac = m[2] ?? '';
  if (frac.length > decimals && !truncate) throw schemaError(`${what}: more than ${decimals} decimals`);
  return BigInt(m[1]! + frac.slice(0, decimals).padEnd(decimals, '0'));
}
const BPS_DECIMALS = 6;
const BPS_DENOMINATOR = 10_000n * 10n ** BigInt(BPS_DECIMALS);

/**
 * Fee for `amount` at `bps` basis points (Circle publishes fractional values such as 1.3), in base units.
 * `fee` is what Iris charges — amount × bps / 10 000 rounded DOWN (observed on mainnet burns, see the dossier);
 * `maxFee` is the same product rounded UP: the smallest `maxFee` argument that still covers it, and therefore the
 * most the mint can ever deduct.
 */
export function cctpFee(amount: bigint, bps: number): { fee: bigint; maxFee: bigint } {
  const s = scaled(bps, BPS_DECIMALS, 'minimumFee');
  if (s > MAX_SANE_FEE_BPS * 10n ** BigInt(BPS_DECIMALS)) throw schemaError(`minimumFee ${bps} bps is not a plausible CCTP fee`);
  const product = amount * s;
  return { fee: product / BPS_DENOMINATOR, maxFee: (product + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A Solana address (base58, 32 bytes) as the bytes32 CCTP uses for recipients. */
export function solanaAddressToBytes32(address: string): string {
  let v = 0n;
  for (const c of address) { const i = B58.indexOf(c); if (i < 0) throw new Error('invalid base58'); v = v * 58n + BigInt(i); }
  const hex = v.toString(16);
  if (hex.length > 64) throw new Error('not a 32-byte address');
  return `0x${hex.padStart(64, '0')}`;
}
/** An EVM address left-padded to bytes32, as `Message.addressToBytes32` does. */
export function evmAddressToBytes32(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('invalid EVM address');
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

export interface CctpMessageV2 {
  version: number; sourceDomain: number; destinationDomain: number; nonce: string; sender: string; recipient: string;
  destinationCaller: string; minFinalityThreshold: number; finalityThresholdExecuted: number;
  body: { version: number; burnToken: string; mintRecipient: string; amount: bigint; messageSender: string; maxFee: bigint; feeExecuted: bigint; expirationBlock: bigint; hookData: string };
}
/**
 * Decode an attested CCTP V2 burn message (148-byte header + BurnMessageV2 body) by its documented offsets. This is the
 * parse the signer needs before it may sign `receiveMessage(message, attestation)`: every field that decides who is
 * minted how much is in here. Throws on any length or range problem.
 */
export function decodeCctpMessageV2(message: string): CctpMessageV2 {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(message)) throw new Error('message is not hex');
  const h = message.slice(2).toLowerCase();
  if (h.length < (148 + 228) * 2) throw new Error('message shorter than a V2 burn message');
  const at = (off: number, len: number) => h.slice(off * 2, (off + len) * 2);
  const u32 = (off: number) => Number.parseInt(at(off, 4), 16);
  const b32 = (off: number) => `0x${at(off, 32)}`;
  const B = 148; // body offset
  return {
    version: u32(0), sourceDomain: u32(4), destinationDomain: u32(8), nonce: b32(12), sender: b32(44), recipient: b32(76),
    destinationCaller: b32(108), minFinalityThreshold: u32(140), finalityThresholdExecuted: u32(144),
    body: {
      version: u32(B), burnToken: b32(B + 4), mintRecipient: b32(B + 36), amount: BigInt(b32(B + 68)), messageSender: b32(B + 100),
      maxFee: BigInt(b32(B + 132)), feeExecuted: BigInt(b32(B + 164)), expirationBlock: BigInt(b32(B + 196)), hookData: `0x${h.slice((B + 228) * 2)}`,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider payload schemas

const uint = z.number().int().nonnegative();
const FeesSchema = z.array(z.object({
  finalityThreshold: z.union([z.literal(FINALITY_FAST), z.literal(FINALITY_STANDARD)]),
  minimumFee: z.number().finite().nonnegative(),
  /** Circle Forwarding Service fee for this route, USDC base units (returned because we ask with forward=true) */
  forwardFee: z.object({ low: uint, med: uint, high: uint }).optional(),
})).min(1).max(2);
const AllowanceSchema = z.object({ allowance: z.number().finite().nonnegative(), lastUpdated: z.string() });
const numeric = z.string().regex(/^\d{1,40}$/);
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})+$/);
const CctpxQuoteSchema = z.object({
  signedQuote: hex,
  issuedAt: uint,
  expiry: z.object({ mode: z.literal('TIMESTAMP'), expiresAt: uint }),
  feeTotalAmount: numeric,
  feeToken: z.string().regex(/^0x0{40}$/),
  items: z.array(z.object({ type: z.enum(['PROTOCOL', 'PRE_FINALITY']), amount: numeric, args: z.array(z.string()).min(1), argsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })).min(1).max(2),
  nonce: z.string(),
});
const EvmQuantity = z.object({ result: z.string().regex(/^0x[0-9a-fA-F]{1,24}$/) });

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw schemaError(`${what}: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? 'invalid'}`.trim());
  return r.data;
}
const httpStatus = (e: unknown): number | null => (e instanceof ProviderError && e.code === 'http' ? ((e as { status?: number }).status ?? null) : null);

// ---------------------------------------------------------------------------------------------------------------------
// Costs on each side (estimates, live)

type Token = 'USDC' | 'EURC';
interface Leg { ref: AssetRef; chain: CctpChain; family: 'evm' | 'sol'; rpc: string[]; nativeSymbol: string }
interface Cost { fees: FeeItem[]; note: string; detail: Record<string, string> }

/** Classify strictly through the registry: only the allowlisted USDC / EURC deployment on a CCTP network qualifies. */
function leg(a: AssetRef): { token: Token; leg: Leg } | null {
  const chain = CCTP_CHAINS[a.network];
  if (!chain || a.asset === 'native') return null;
  let r: ReturnType<typeof resolveAsset>;
  try { r = resolveAsset(a); } catch { return null; }
  if (r.net.family !== 'evm' && r.net.family !== 'sol') return null;
  const token: Token | null = r.def.symbol === 'USDC' ? 'USDC' : r.def.symbol === 'EURC' && chain.eurc && r.net.family === 'evm' ? 'EURC' : null;
  if (!token || r.def.decimals !== 6) return null;
  return { token, leg: { ref: { network: a.network, asset: r.def.id }, chain, family: r.net.family, rpc: r.net.rpc, nativeSymbol: r.net.native.symbol } };
}
function pair(from: AssetRef, to: AssetRef): { token: Token; src: Leg; dst: Leg } | null {
  const a = leg(from), b = leg(to);
  if (!a || !b || a.token !== b.token || from.network === to.network) return null;
  return { token: a.token, src: a.leg, dst: b.leg };
}

/** One JSON-RPC call against the registry's endpoints, in order; the first well-formed answer wins. */
async function rpcCall(l: Leg, body: unknown, ctx: ProviderContext): Promise<unknown> {
  let last: unknown = new ProviderError(ID, 'unavailable', `no RPC endpoint for ${l.ref.network}`);
  for (const url of l.rpc) {
    if (ctx.signal.aborted) break;
    try { return await ctx.http.postJson(url, body, { signal: ctx.signal }); } catch (e) { last = e; }
  }
  throw last;
}
async function evmGasPrice(l: Leg, ctx: ProviderContext): Promise<bigint> {
  const r = parse(EvmQuantity, await rpcCall(l, { jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }, ctx), `${l.ref.network} eth_gasPrice`);
  const v = BigInt(r.result);
  if (v <= 0n || v > 10n ** 13n) throw schemaError(`${l.ref.network} eth_gasPrice out of range`);
  return v;
}
const native = (l: Leg): AssetRef => ({ network: l.ref.network, asset: 'native' });
const networkFee = (l: Leg, amount: bigint): FeeItem => ({ kind: 'network', asset: native(l), amount, includedInOutput: false, estimated: true });

/** Solana: rent-exempt minimum for each size, plus (optionally) whether `owner` already holds a token account of `mint`. */
async function solanaRent(l: Leg, sizes: number[], ctx: ProviderContext, holder?: { owner: string; mint: string }): Promise<{ rent: bigint[]; hasTokenAccount: boolean | null }> {
  const calls: unknown[] = sizes.map((s, i) => ({ jsonrpc: '2.0', id: i, method: 'getMinimumBalanceForRentExemption', params: [s] }));
  if (holder) calls.push({ jsonrpc: '2.0', id: sizes.length, method: 'getTokenAccountsByOwner', params: [holder.owner, { mint: holder.mint }, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] });
  const Batch = z.array(z.object({ id: uint, result: z.unknown() })).length(calls.length);
  const answers = parse(Batch, await rpcCall(l, calls, ctx), 'solana rpc batch');
  const byId = (i: number) => { const a = answers.find((x) => x.id === i); if (!a) throw schemaError('solana rpc batch: missing answer'); return a.result; };
  const rent = sizes.map((_s, i) => { const v = parse(z.number().int().positive().max(1e9), byId(i), 'solana rent'); return BigInt(v); });
  const hasTokenAccount = holder ? parse(z.object({ value: z.array(z.unknown()) }), byId(sizes.length), 'solana token accounts').value.length > 0 : null;
  return { rent, hasTokenAccount };
}

async function sourceCost(token: Token, l: Leg, ctx: ProviderContext): Promise<Cost> {
  if (l.family === 'evm') {
    const price = await evmGasPrice(l, ctx), units = GAS.approve + (token === 'USDC' ? GAS.usdcBurn : GAS.eurcBurn);
    return { fees: [networkFee(l, units * price)], note: `source gas ≈ ${units} units (exact-amount approve + burn), paid in ${l.nativeSymbol}`, detail: { gasPrice: price.toString(), gasUnits: units.toString() } };
  }
  const { rent } = await solanaRent(l, [SOL.messageSentBytes], ctx);
  const tx = SOL.lamportsPerSignature * SOL.burnSignatures;
  return {
    fees: [networkFee(l, tx), networkFee(l, rent[0]!)],
    note: `source cost in SOL: transaction fee (2 signatures, priority fee excluded) + ${rent[0]} lamports rent deposit for the MessageSent account, reclaimable by the wallet 5 days later (reclaim_event_account)`,
    detail: { transactionFee: tx.toString(), messageSentRent: rent[0]!.toString() },
  };
}
async function destinationCost(token: Token, l: Leg, recipient: string, ctx: ProviderContext): Promise<Cost> {
  if (l.family === 'evm') {
    const price = await evmGasPrice(l, ctx), units = token === 'USDC' ? GAS.usdcMint : GAS.eurcMint;
    return { fees: [networkFee(l, units * price)], note: `the wallet submits the mint itself and needs ${l.nativeSymbol} on ${l.ref.network} for it (≈ ${units} gas units)`, detail: { gasPrice: price.toString(), gasUnits: units.toString() } };
  }
  const known = isValidAddress(l.ref.network, recipient);
  const { rent, hasTokenAccount } = await solanaRent(l, [SOL.usedNonceBytes, SOL.tokenAccountBytes], ctx, known ? { owner: recipient, mint: l.ref.asset } : undefined);
  const needsAccount = hasTokenAccount !== true;
  const total = SOL.lamportsPerSignature * SOL.mintSignatures + rent[0]! + (needsAccount ? rent[1]! : 0n);
  return {
    fees: [networkFee(l, total)],
    note: `the wallet submits the mint itself and needs SOL for it: transaction fee + ${rent[0]} lamports for the used-nonce record${needsAccount ? ` + ${rent[1]} lamports to create the recipient's USDC token account (${hasTokenAccount === null ? 'existence not checked' : 'it does not exist yet'}; the mint reverts without it)` : ' (the recipient already has a USDC token account)'}`,
    detail: { transactionFee: (SOL.lamportsPerSignature * SOL.mintSignatures).toString(), usedNonceRent: rent[0]!.toString(), tokenAccountRent: rent[1]!.toString(), recipientTokenAccount: hasTokenAccount === null ? 'unknown' : hasTokenAccount ? 'exists' : 'missing' },
  };
}

// ---------------------------------------------------------------------------------------------------------------------

const QUOTE_ONLY_USDC = 'CCTP is quote-only in this phase: the wallet has no burn/mint builder yet. Every value-moving argument of depositForBurn (amount, destination domain, mintRecipient, burnToken, destinationCaller = 0, maxFee, minFinalityThreshold) is derivable by the signer from the approved intent and the pinned TokenMessengerV2 address — see docs/swap/providers/cctp.md for the path to "verified".';
const QUOTE_ONLY_EURC = 'CCTP for non-USDC is quote-only in this phase: crossChainTransfer carries a Circle-signed fee quote the signer cannot rebuild (it can only bound the attached value); see docs/swap/providers/cctp.md.';
let seq = 0;
const quoteId = (variant: string, now: number) => `${ID}-${variant}-${now.toString(36)}-${(++seq).toString(36)}`;

function settled<T>(r: PromiseSettledResult<T>): T { if (r.status === 'rejected') throw r.reason; return r.value; }

async function quoteUsdc(req: SwapQuoteRequest, src: Leg, dst: Leg, ctx: ProviderContext): Promise<SwapQuote[]> {
  if (req.amountIn > USDC_BURN_LIMIT) return [];
  const feesUrl = `${CCTP_API}/${CCTP_API_VERSION}/burn/USDC/fees/${src.chain.domain}/${dst.chain.domain}?forward=true`;
  const [feesR, allowanceR, srcR, dstR] = await Promise.allSettled([
    ctx.http.getJson(feesUrl, { signal: ctx.signal }),
    src.chain.fastSource ? ctx.http.getJson(`${CCTP_API}/${CCTP_API_VERSION}/fastBurn/USDC/allowance`, { signal: ctx.signal }) : Promise.resolve(null),
    sourceCost('USDC', src, ctx),
    destinationCost('USDC', dst, req.recipient, ctx),
  ]);
  // Iris answers 400 for a domain pair it does not serve: that is "no route", not a failure
  if (feesR.status === 'rejected' && httpStatus(feesR.reason) === 400) return [];
  const fees = parse(FeesSchema, settled(feesR), 'fees');
  if (new Set(fees.map((f) => f.finalityThreshold)).size !== fees.length) throw schemaError('fees: duplicate finality threshold');
  const standard = fees.find((f) => f.finalityThreshold === FINALITY_STANDARD);
  if (!standard) throw schemaError('fees: no Standard Transfer entry');
  const fast = src.chain.fastSource ? fees.find((f) => f.finalityThreshold === FINALITY_FAST) : undefined;
  const allowanceRaw = settled(allowanceR);
  const allowance = src.chain.fastSource ? parse(AllowanceSchema, allowanceRaw, 'allowance') : null;
  const fastCapacity = allowance ? scaled(allowance.allowance, 6, 'allowance', true) : 0n;
  const srcCost = settled(srcR), dstCost = settled(dstR);
  const now = ctx.now();

  const evmSrc = src.family === 'evm', evmDst = dst.family === 'evm';
  const mintRecipient = !isValidAddress(dst.ref.network, req.recipient) ? null : evmDst ? evmAddressToBytes32(req.recipient) : null; // Solana: the recipient's USDC associated token account, derived when the transaction is built
  const contracts: RouteStep['contracts'] = [
    ...(evmSrc
      ? [{ network: src.ref.network, address: CCTP_EVM.tokenMessenger, role: 'spender' as const }, { network: src.ref.network, address: CCTP_EVM.tokenMessenger, role: 'bridge' as const }]
      : [{ network: src.ref.network, address: CCTP_SOLANA.tokenMessengerMinter, role: 'program' as const }, { network: src.ref.network, address: CCTP_SOLANA.messageTransmitter, role: 'program' as const }]),
    ...(evmDst
      ? [{ network: dst.ref.network, address: CCTP_EVM.messageTransmitter, role: 'bridge' as const }, { network: dst.ref.network, address: CCTP_EVM.tokenMessenger, role: 'bridge' as const }]
      : [{ network: dst.ref.network, address: CCTP_SOLANA.messageTransmitter, role: 'program' as const }, { network: dst.ref.network, address: CCTP_SOLANA.tokenMessengerMinter, role: 'program' as const }]),
  ];

  const build = (variant: 'standard' | 'fast', entry: z.infer<typeof FeesSchema>[number], seconds: number): SwapQuote | null => {
    const { fee, maxFee } = cctpFee(req.amountIn, entry.minimumFee);
    if (maxFee >= req.amountIn) return null; // the contract requires maxFee < amount
    const threshold = variant === 'fast' ? FINALITY_FAST : FINALITY_STANDARD;
    const label = variant === 'fast' ? 'CCTP V2 Fast Transfer' : 'CCTP V2 Standard Transfer';
    return {
      id: quoteId(variant, now), provider: ID, request: req,
      steps: [{
        kind: 'bridge', provider: ID, from: req.from, to: req.to,
        via: [
          label,
          `burn on ${src.ref.network}: ${evmSrc ? 'TokenMessengerV2.depositForBurn' : 'TokenMessengerMinterV2 deposit_for_burn'} (minFinalityThreshold ${threshold}, maxFee ${maxFee}); ${srcCost.note}`,
          `attestation by Circle (Iris) about ${seconds} s after the burn`,
          `mint on ${dst.ref.network}: ${evmDst ? 'MessageTransmitterV2.receiveMessage' : 'MessageTransmitterV2 receive_message'}; ${dstCost.note}`,
        ],
        contracts,
      }],
      amountOut: req.amountIn - fee, minAmountOut: req.amountIn - maxFee,
      fees: [{ kind: 'protocol', asset: req.to, amount: fee, includedInOutput: true, estimated: false }, ...srcCost.fees, ...dstCost.fees],
      estimatedSeconds: seconds, priceImpactBps: 0, quotedAt: now, expiresAt: now + 30_000, firmness: 'indicative',
      executability: { class: 'quote_only', code: 'cctp_pair_not_wired', reason: QUOTE_ONLY_USDC },
      // burned, not escrowed: nothing ever returns to the sender. If the mint is not submitted the funds stay
      // mintable — by anyone holding the attestation, only ever to mintRecipient — with no deadline.
      refundable: false, recoverable: true, atomic: false,
      raw: {
        product: 'cctp-v2', token: 'USDC', transfer: variant, sourceDomain: src.chain.domain, destinationDomain: dst.chain.domain,
        fees, allowance, feeBps: String(entry.minimumFee), protocolFee: fee.toString(), maxFee: maxFee.toString(),
        burn: {
          network: src.ref.network, contract: evmSrc ? CCTP_EVM.tokenMessenger : CCTP_SOLANA.tokenMessengerMinter,
          approval: evmSrc ? { token: src.ref.asset, spender: CCTP_EVM.tokenMessenger, amount: req.amountIn.toString() } : null,
          args: { amount: req.amountIn.toString(), destinationDomain: dst.chain.domain, mintRecipient, burnToken: src.ref.asset, destinationCaller: ZERO32, maxFee: maxFee.toString(), minFinalityThreshold: threshold },
          cost: srcCost.detail,
        },
        mint: { network: dst.ref.network, contract: evmDst ? CCTP_EVM.messageTransmitter : CCTP_SOLANA.messageTransmitter, submittedBy: 'wallet', cost: dstCost.detail },
        // the alternative the wallet does not use yet: Circle submits the mint and deducts this from the minted amount
        forwardingService: entry.forwardFee ?? null,
        ifMintNeverSubmitted: 'USDC is burned on the source chain and stays mintable to mintRecipient by anyone holding the attestation; no expiry for Standard, re-attestation for an expired Fast attestation; never refunded to the sender',
      },
    };
  };

  const out: SwapQuote[] = [];
  const s = build('standard', standard, src.chain.standardSeconds); if (s) out.push(s);
  // Fast only where Circle offers it from this source and the global Fast allowance can absorb the burn right now
  if (fast && src.chain.fastSeconds !== null && fastCapacity >= req.amountIn) { const f = build('fast', fast, src.chain.fastSeconds); if (f) out.push(f); }
  return out;
}

async function quoteEurc(req: SwapQuoteRequest, src: Leg, dst: Leg, ctx: ProviderContext): Promise<SwapQuote[]> {
  const url = `${CCTP_API}/${CCTP_API_VERSION}/quote/cctpx/${CCTPX.eurcTokenId}/${src.chain.domain}/${dst.chain.domain}`;
  const body = (requests: { type: string }[]) => ({ amount: req.amountIn.toString(), feeToken: ZERO_ADDRESS, requests });
  const [stdR, fastR, srcR, dstR] = await Promise.allSettled([
    ctx.http.postJson(url, body([]), { signal: ctx.signal }),
    src.chain.fastSource ? ctx.http.postJson(url, body([{ type: 'PRE_FINALITY' }]), { signal: ctx.signal }) : Promise.resolve(null),
    sourceCost('EURC', src, ctx),
    destinationCost('EURC', dst, req.recipient, ctx),
  ]);
  if (stdR.status === 'rejected' && httpStatus(stdR.reason) === 400) return []; // UNSUPPORTED_ROUTE, TOKEN_NOT_SUPPORTED_ON_ROUTE, amount refused
  const srcCost = settled(srcR), dstCost = settled(dstR);
  const now = ctx.now();
  // Iris refuses a fast quote outright when the per-token allowance or its FX pricing is unavailable: no Fast quote then
  const fastRefused = fastR.status === 'rejected' && httpStatus(fastR.reason) === 400;
  const fastRaw = fastRefused ? null : settled(fastR);

  const build = (variant: 'standard' | 'fast', payload: unknown, seconds: number): SwapQuote => {
    const q = parse(CctpxQuoteSchema, payload, `${variant} quote`);
    const types = q.items.map((i) => i.type);
    const want = variant === 'fast' ? ['PRE_FINALITY', 'PROTOCOL'] : ['PROTOCOL'];
    if ([...types].sort().join() !== want.join()) throw schemaError(`${variant} quote: unexpected fee items ${types.join('+')}`);
    for (const i of q.items) {
      if (i.args[0]!.toLowerCase() !== CCTPX.eurcTokenId) throw schemaError('quote is for another token');
      if (i.type === 'PRE_FINALITY' && i.args[1] !== req.amountIn.toString()) throw schemaError('quote is for another amount');
    }
    const total = BigInt(q.feeTotalAmount);
    if (q.items.reduce((a, i) => a + BigInt(i.amount), 0n) !== total) throw schemaError('quote items do not add up to feeTotalAmount');
    if (total > 10n ** 18n) throw schemaError('quote fee is not plausible');
    if (q.expiry.expiresAt * 1000 <= now) throw schemaError('quote already expired');
    const threshold = variant === 'fast' ? FINALITY_FAST : FINALITY_STANDARD;
    return {
      id: quoteId(`eurc-${variant}`, now), provider: ID, request: req,
      steps: [{
        kind: 'bridge', provider: ID, from: req.from, to: req.to,
        via: [
          variant === 'fast' ? 'CCTP for non-USDC, Fast Transfer' : 'CCTP for non-USDC, Standard Transfer',
          `burn on ${src.ref.network}: CrossChainTokenService.crossChainTransfer (minFinalityThreshold ${threshold}) with ${total} wei of ${src.nativeSymbol} attached for Circle's fee; ${srcCost.note}`,
          `attestation by Circle (Iris) about ${seconds} s after the burn`,
          `mint on ${dst.ref.network}: MessageTransmitterV2.receiveMessage; ${dstCost.note}`,
        ],
        contracts: [
          { network: src.ref.network, address: CCTPX.eurcTokenManager, role: 'spender' },
          { network: src.ref.network, address: CCTPX.service, role: 'bridge' },
          { network: dst.ref.network, address: CCTP_EVM.messageTransmitter, role: 'bridge' },
          { network: dst.ref.network, address: CCTPX.service, role: 'bridge' },
        ],
      }],
      // fees are paid upfront in the source chain's coin: the full amount is minted
      amountOut: req.amountIn, minAmountOut: req.amountIn,
      fees: [...q.items.map((i): FeeItem => ({ kind: 'protocol', asset: native(src), amount: BigInt(i.amount), includedInOutput: false, estimated: false })), ...srcCost.fees, ...dstCost.fees],
      estimatedSeconds: seconds, priceImpactBps: 0, quotedAt: now, expiresAt: q.expiry.expiresAt * 1000, firmness: 'indicative',
      executability: { class: 'quote_only', code: 'cctp_eurc', reason: QUOTE_ONLY_EURC },
      refundable: false, recoverable: true, atomic: false,
      raw: {
        product: 'cctp-non-usdc', token: 'EURC', transfer: variant, sourceDomain: src.chain.domain, destinationDomain: dst.chain.domain, quote: q,
        burn: { network: src.ref.network, contract: CCTPX.service, approval: { token: src.ref.asset, spender: CCTPX.eurcTokenManager, amount: req.amountIn.toString() }, value: total.toString(), minFinalityThreshold: threshold, cost: srcCost.detail },
        mint: { network: dst.ref.network, contract: CCTP_EVM.messageTransmitter, submittedBy: 'wallet', cost: dstCost.detail },
        ifMintNeverSubmitted: 'EURC is burned on the source chain and stays mintable to the recipient by anyone holding the attestation; never refunded to the sender',
      },
    };
  };
  const out = [build('standard', settled(stdR), src.chain.standardSeconds)];
  if (src.chain.fastSource && src.chain.fastSeconds !== null && !fastRefused) out.push(build('fast', fastRaw, src.chain.fastSeconds));
  return out;
}

export function createCctpProvider(_env: ProviderEnv = {}): SwapProvider {
  return {
    id: ID, name: 'Circle CCTP',
    capabilities: () => ({ networks: Object.keys(CCTP_CHAINS), crossChain: true, needsKey: false, configured: true, kinds: ['bridge'], docs: CCTP_DOCS }),
    supportsPair: (from, to) => pair(from, to) !== null,
    async quote(req, ctx) {
      const p = pair(req.from, req.to);
      if (!p || req.amountIn <= 0n) return [];
      // the request is echoed untouched (the aggregator compares it); the registry's own form of each asset is used for the legs
      return p.token === 'USDC' ? quoteUsdc(req, p.src, p.dst, ctx) : quoteEurc(req, p.src, p.dst, ctx);
    },
  };
}

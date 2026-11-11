// deBridge Liquidity Network (DLN) — intent-based cross-chain swaps: the user locks the input in DlnSource, a solver
// ("taker") delivers a fixed amount of the output token on the destination chain, then unlocks the input for itself.
// Price discovery only. The DLN API has a single endpoint for estimating and for creating an order
// (GET /v1.0/dln/order/create-tx): its answer carries the estimate AND the calldata of the order. This adapter reads the
// estimate, uses the calldata only for two sanity checks (target contract, recipient bytes) and never signs, relays or
// submits anything. Execution dossier: docs/swap/providers/debridge.md.
//
// Verified live on 2026-11-10 (GET /v1.0/supported-chains-info): the chain ids below. DLN has no same-chain swaps
// (error 25 SAME_SOURCE_AND_DESTINATION_CHAINS) and does not serve Bitcoin, Sui or the wallet's other non-EVM networks.
import { z } from 'zod';
import {
  ProviderError, resolveAsset, sameAsset,
  type AssetRef, type FeeItem, type ProviderContext, type RouteStep, type SwapProvider, type SwapQuote, type SwapQuoteRequest,
} from '../types.ts';
import type { ProviderEnv } from './index.ts';

const ID = 'debridge';
/** pinned API base and version */
export const DLN_API = 'https://dln.debridge.finance/v1.0';
export const DLN_DOCS = 'https://docs.debridge.com/dln-details/integration-guidelines/order-creation/creating-order/creating-order';
/** deBridge: "sign and submit within 30 seconds" of the create-tx answer */
const VALIDITY_MS = 30_000;

type Kind = 'evm' | 'sol' | 'tron';
interface DlnChain { chainId: number; kind: Kind; native: string; source: string; destination: string; router?: string }
const EVM = { kind: 'evm' as const, native: '0x0000000000000000000000000000000000000000', source: '0xeF4fB24aD0916217251F553c0596F8Edc630EB66', destination: '0xE7351Fd770A37282b91D153Ee690B63579D6dd7f', router: '0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251' };
/**
 * wallet network id -> DLN chain id (deBridge's own ids for Solana, HyperEVM and TRON), the id DLN uses for the chain coin,
 * and the DLN contracts: DlnSource (holds the input), DlnDestination (fulfilment), DeBridgeRouter (pre-order swap + order).
 * Source: https://docs.debridge.com/dln-details/overview/deployed-contracts (read 2026-11-10).
 */
export const DLN_CHAINS: Record<string, DlnChain> = {
  ethereum: { chainId: 1, ...EVM }, optimism: { chainId: 10, ...EVM }, bsc: { chainId: 56, ...EVM }, polygon: { chainId: 137, ...EVM },
  base: { chainId: 8453, ...EVM }, arbitrum: { chainId: 42161, ...EVM }, avalanche: { chainId: 43114, ...EVM }, hyperevm: { chainId: 100000022, ...EVM },
  solana: { chainId: 7565164, kind: 'sol', native: '11111111111111111111111111111111', source: 'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4', destination: 'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo' },
  tron: { chainId: 100000026, kind: 'tron', native: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', source: 'TX2Ut1reF59i2WPzsYVoMfA25EkUkavnd5', destination: 'TXCbCdoHjg28g36X5jnWTP88mRzx54RqXp', router: 'TRsqznGXF7mSYhRxU49L3HY13QW1v9yBZa' },
};
const NETWORK_OF = new Map(Object.entries(DLN_CHAINS).map(([net, c]) => [c.chainId, net]));
/** "nothing can be quoted for this request" answers (HTTP 400): reported as no route, not as a provider failure */
const NO_ROUTE = new Set(['ERROR_LOW_GIVE_AMOUNT', 'IMPOSSIBLE_ROUTE', 'UNSUPPORTED_TOKEN_IN', 'UNSUPPORTED_TOKEN_OUT']);

// ---- response schema (unknown keys are stripped; `raw` is the validated payload) ----
const Amount = z.string().regex(/^\d{1,78}$/);
const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/).max(200_000);
const Addr = z.string().min(1).max(128);
const Estimate = z.object({
  estimation: z.object({
    srcChainTokenIn: z.object({ chainId: z.number().int().positive(), address: Addr, decimals: z.number().int().min(0).max(36), amount: Amount, approximateOperatingExpense: Amount.optional(), mutatedWithOperatingExpense: z.boolean() }),
    /** present when the input is first swapped into a reserve asset (pre-order swap) */
    srcChainTokenOut: z.object({ chainId: z.number().int().positive(), address: Addr, decimals: z.number().int().min(0).max(36), amount: Amount, maxRefundAmount: Amount.optional() }).optional(),
    dstChainTokenOut: z.object({ chainId: z.number().int().positive(), address: Addr, decimals: z.number().int().min(0).max(36), amount: Amount, recommendedAmount: Amount, maxTheoreticalAmount: Amount.optional() }),
    costsDetails: z.array(z.object({
      chain: z.string().regex(/^\d{1,12}$/), tokenIn: Addr, tokenOut: Addr, amountIn: Amount, amountOut: Amount, type: z.string().max(64),
      payload: z.object({ feeAmount: Amount.optional(), feeBps: z.string().max(16).optional() }).optional(),
    })).max(16),
    recommendedSlippage: z.number().finite().min(0).max(100).optional(),
  }),
  tx: z.object({ data: Hex, to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(), value: Amount.optional() }),
  order: z.object({ approximateFulfillmentDelay: z.number().finite().min(0).max(7 * 86400) }),
  orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  fixFee: Amount,
  protocolFee: Amount.optional(),
  estimatedTransactionFee: z.object({ total: Amount }).optional(),
  usdPriceImpact: z.number().finite().nullable().optional(),
});
const ErrorBody = z.object({ errorId: z.string().max(80), errorCode: z.number().optional(), errorMessage: z.string().optional() });

const bad = (msg: string): never => { throw new ProviderError(ID, 'schema', msg); };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i); }
  const body: number[] = [];
  for (; n > 0n; n >>= 8n) body.unshift(Number(n & 0xffn));
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** the bytes of an account as they appear inside a DLN order: 20 (EVM, TRON without its 0x41 prefix) or 32 (Solana) */
function accountHex(kind: Kind, addr: string): string {
  if (kind === 'evm') { if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('not an EVM address'); return addr.slice(2).toLowerCase(); }
  const raw = base58Decode(addr);
  if (kind === 'sol') { if (raw.length !== 32) throw new Error('not a Solana address'); return hex(raw); }
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error('not a TRON address');
  return hex(raw.slice(1, 21));
}
const dlnToken = (a: AssetRef) => (a.asset === 'native' ? DLN_CHAINS[a.network]!.native : a.asset);
const sameAddr = (kind: Kind, a: string, b: string) => (kind === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b);
/** a (chain, token) pair named by DLN -> registry asset, or null when it is outside the wallet's registry */
function refOf(chainId: number, address: string): AssetRef | null {
  const network = NETWORK_OF.get(chainId);
  if (!network) return null;
  const c = DLN_CHAINS[network]!;
  if (sameAddr(c.kind, address, c.native)) return { network, asset: 'native' };
  try { return { network, asset: resolveAsset({ network, asset: address }).def.id }; } catch { return null; }
}

function toQuote(p: z.infer<typeof Estimate>, req: SwapQuoteRequest, now: number): SwapQuote {
  const src = DLN_CHAINS[req.from.network]!, dst = DLN_CHAINS[req.to.network]!;
  const { srcChainTokenIn: tin, dstChainTokenOut: tout, costsDetails } = p.estimation;
  const from = refOf(tin.chainId, tin.address), to = refOf(tout.chainId, tout.address);
  if (!from || !to || !sameAsset(from, req.from) || !sameAsset(to, req.to)) bad('estimate is for another pair');
  if (tin.decimals !== resolveAsset(req.from).def.decimals || tout.decimals !== resolveAsset(req.to).def.decimals) bad('decimals differ from the registry');
  // prependOperatingExpenses=false: the order takes exactly the requested input
  if (tin.mutatedWithOperatingExpense || BigInt(tin.amount) !== req.amountIn) bad('estimate is for another input amount');
  // dstChainTokenOutAmount=auto: the order's take amount is the recommended amount. It is fixed inside the order, so the
  // recipient gets exactly this amount or the order is not filled: expected and guaranteed minimum are the same figure.
  const amountOut = BigInt(tout.amount);
  if (amountOut <= 0n || amountOut !== BigInt(tout.recommendedAmount)) bad('output amount is not the recommended amount');
  const fixFee = BigInt(p.fixFee), native: AssetRef = { network: req.from.network, asset: 'native' };

  // ---- the calldata is not used for anything but these checks. They are necessary conditions, not a verification of the
  // order: the recipient bytes must appear in it (they also appear as the destination authority), the target must be pinned ----
  const data = p.tx.data.toLowerCase();
  let recipient: string;
  try { recipient = accountHex(dst.kind, req.recipient); } catch { throw new ProviderError(ID, 'bad_response', 'recipient is not an address of the destination network'); }
  if (!data.includes(recipient)) bad('order does not pay the requested recipient');
  let target: string | null = null;
  if (src.kind === 'sol') { if (p.tx.to !== undefined || p.tx.value !== undefined) bad('unexpected EVM fields for a Solana order'); } else {
    // EVM and TRON (TRON contracts are returned in 0x form): the order goes to DlnSource, or to DeBridgeRouter when a pre-order swap is needed
    const allowed = [src.source, src.router!].map((a) => [a, src.kind === 'tron' ? accountHex('tron', a) : a.slice(2).toLowerCase()] as const);
    target = allowed.find(([, h]) => h === p.tx.to?.slice(2).toLowerCase())?.[0] ?? bad('transaction target is not a pinned DLN contract');
    // value = flat fee, plus the input itself when the input is the chain coin
    if (p.tx.value === undefined || BigInt(p.tx.value) !== fixFee + (req.from.asset === 'native' ? req.amountIn : 0n)) bad('transaction value is not the flat fee (plus a native input)');
  }

  // ---- fees ----
  const fees: FeeItem[] = [{ kind: 'protocol', asset: native, amount: fixFee, includedInOutput: false, estimated: false }]; // flat fee, chain coin of the source, paid on top
  if (p.estimatedTransactionFee) fees.push({ kind: 'network', asset: native, amount: BigInt(p.estimatedTransactionFee.total), includedInOutput: false, estimated: true });
  const via: string[] = [];
  for (const c of costsDetails) {
    if (c.type === 'PreSwap') via.unshift('pre-order swap');
    if (c.type === 'AfterSwap') via.push('destination swap');
    const kind = c.type === 'DlnProtocolFee' ? 'protocol' as const : c.type === 'TakerMargin' ? 'provider' as const : c.type === 'EstimatedOperatingExpenses' ? 'bridge' as const : null;
    if (!kind) continue; // PreSwap/AfterSwap legs and their slippage reserves are not fees; they are already inside the fixed output
    if (c.payload?.feeAmount === undefined) return bad(`${c.type} without an amount`);
    // charged in the reserve asset of that chain; outside the registry (e.g. USDC on BNB Chain) it cannot be expressed as a FeeItem — it stays in `raw`
    const asset = refOf(Number(c.chain), c.tokenIn);
    if (asset) fees.push({ kind, asset, amount: BigInt(c.payload.feeAmount), includedInOutput: true, estimated: c.type === 'EstimatedOperatingExpenses' });
  }
  via.splice(via.includes('pre-order swap') ? 1 : 0, 0, 'DLN');

  const contracts: RouteStep['contracts'] = [];
  if (target) { contracts.push({ network: req.from.network, address: target, role: 'router' }); if (req.from.asset !== 'native') contracts.push({ network: req.from.network, address: target, role: 'spender' }); }
  contracts.push({ network: req.from.network, address: src.source, role: src.kind === 'sol' ? 'program' : 'vault' });
  contracts.push({ network: req.to.network, address: dst.destination, role: dst.kind === 'sol' ? 'program' : 'bridge' });

  return {
    id: `${ID}:${p.orderId}`, provider: ID, request: req,
    steps: [{ kind: 'bridge', provider: ID, from: req.from, to: req.to, via, contracts }],
    amountOut, minAmountOut: amountOut, fees,
    estimatedSeconds: Math.ceil(p.order.approximateFulfillmentDelay),
    // deBridge reports the USD value lost between input and output (all fees included), in percent, negative = loss
    priceImpactBps: p.usdPriceImpact == null ? null : Math.round(-p.usdPriceImpact * 100),
    expiresAt: now + VALIDITY_MS, firmness: 'firm',
    executability: { class: 'opaque', reason: 'the DLN API builds the order transaction (calldata for DlnSource or DeBridgeRouter, a serialized transaction on Solana); the signer can pin the target contract, the value and the allowance but does not rebuild the order struct (recipient, take amount, authorities) by itself yet' },
    // an unfilled order can be cancelled from the destination chain by the order authority; the input and both fees return on the source chain
    refundable: true, atomic: false,
    raw: p,
  };
}

export function createDebridgeProvider(_env: ProviderEnv = {}): SwapProvider {
  const networks = Object.keys(DLN_CHAINS);
  const known = (a: AssetRef) => { if (!DLN_CHAINS[a.network]) return false; try { resolveAsset(a); return true; } catch { return false; } };
  return {
    id: ID, name: 'deBridge',
    // public API, 50 requests per minute without a key
    capabilities: () => ({ networks, crossChain: true, needsKey: false, configured: true, kinds: ['bridge'], docs: DLN_DOCS }),
    supportsPair: (from, to) => known(from) && known(to) && from.network !== to.network,
    async quote(req: SwapQuoteRequest, ctx: ProviderContext): Promise<SwapQuote[]> {
      if (!this.supportsPair(req.from, req.to)) return [];
      if (req.amountIn <= 0n) throw new ProviderError(ID, 'bad_response', 'invalid amount');
      const q = new URLSearchParams({
        srcChainId: String(DLN_CHAINS[req.from.network]!.chainId), srcChainTokenIn: dlnToken(req.from), srcChainTokenInAmount: req.amountIn.toString(),
        dstChainId: String(DLN_CHAINS[req.to.network]!.chainId), dstChainTokenOut: dlnToken(req.to),
        // market order: DLN sets the output so that a solver fills it. There is no slippage parameter: the output is fixed in the order.
        dstChainTokenOutAmount: 'auto', prependOperatingExpenses: 'false',
        dstChainTokenOutRecipient: req.recipient, senderAddress: req.sender,
        // both authorities are the wallet's own addresses: only they can cancel the order and receive the refund
        srcChainOrderAuthorityAddress: req.sender, dstChainOrderAuthorityAddress: req.recipient,
      });
      let payload: unknown;
      try { payload = await ctx.http.getJson(`${DLN_API}/dln/order/create-tx?${q}`, { signal: ctx.signal }); }
      catch (e) {
        if (e instanceof ProviderError && e.code === 'http') { const err = ErrorBody.safeParse((e as { body?: unknown }).body); if (err.success && NO_ROUTE.has(err.data.errorId)) return []; }
        throw e;
      }
      const parsed = Estimate.safeParse(payload);
      if (!parsed.success) throw new ProviderError(ID, 'schema', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return [toQuote(parsed.data, req, ctx.now())];
    },
  };
}

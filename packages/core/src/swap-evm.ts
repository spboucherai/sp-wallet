/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/swap-evm.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-11
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

// EVM same-chain swaps through the KyberSwap MetaAggregationRouterV2.
//
// The provider's calldata is NOT trusted. From the router's verified source (read on Base, 2026-11-10):
//   - the router pulls at most `desc.amount` of `desc.srcToken` from the caller (sum of srcAmounts ≤ desc.amount), or requires
//     msg.value == desc.amount for the native coin;
//   - it measures the output as the balance increase of `desc.dstToken` at `desc.dstReceiver` and reverts unless that is
//     ≥ `desc.minReturnAmount` (proportionally with the partial-fill flag, which also refunds the unspent input);
//   - fees are only taken when feeReceivers is non-empty.
// So if the signer checks srcToken, dstToken, amount, dstReceiver = the wallet itself, minReturnAmount ≥ the approved minimum,
// no fee receivers, no permit, exact allowance and exact value, the route data in between can be anything: the transaction either
// delivers at least the approved minimum to the wallet or reverts. The executor and route bytes stay opaque and do not matter.
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Abi, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { sha256 } from '@noble/hashes/sha2.js';
import routerAbi from './kyber-router-abi.json' with { type: 'json' };
import { baseUnits } from './amounts.ts';
import { getAsset, getNetwork } from './networks.ts';
import type { Intent } from './intent.ts';

export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
export const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const KYBER_ROUTER_ABI = routerAbi as Abi;
/**
 * Networks where swap execution is enabled, with the SHA-256 of the router's runtime bytecode as deployed there.
 * A network is added only after its verified source has been read (the bytecode differs per chain: the WETH address is immutable).
 * The router owner could misuse a standing allowance (swapGeneric + whitelist): approvals here are always exact-amount and consumed by the swap.
 * The API refuses to prepare a swap if the on-chain code no longer hashes to this value.
 */
export const KYBER_ENABLED: Record<string, { codeSha256: string; reviewed: string; reduced?: true }> = {
  base: { codeSha256: '0596142c28e41e14a9b2374f1b05c1f9daffe3e8185982e475e194165ec1ba30', reviewed: '2026-11-10, verified source on basescan (MetaAggregationRouterV2, solc 0.8.9, not a proxy)' },
  ethereum: { codeSha256: 'a2848fcf2af625baa810eccbe1cc2a4d0738dcfeb75519fd697f4e7df5b43d70', reviewed: '2026-11-10, verified source (etherscan) compared with Base: same router logic (solc 0.8.9, not a proxy); runtime bytecode equals Ethereum\'s except the wrapped-native immutable; swap proven on a fork' },
  arbitrum: { codeSha256: 'f415153fc009cc188942e61f932d74a0e3a57f8edf1ff15e86b80316566bc0be', reviewed: '2026-11-10, verified source (arbiscan) compared with Base: same router logic (solc 0.8.9, not a proxy); runtime bytecode equals Ethereum\'s except the wrapped-native immutable; swap proven on a fork' },
  polygon: { codeSha256: '84f1d59e289065de78be6d415e06b83c525ae1b1d045df4d219fd78b9921e216', reviewed: '2026-11-10, verified source (polygonscan) compared with Base: same router logic (solc 0.8.9, not a proxy); runtime bytecode equals Ethereum\'s except the wrapped-native immutable; swap proven on a fork' },
  optimism: { codeSha256: 'cc975fd0c7202ae680b44835ebe84b66c35c3312ba65a788cff1797843ad9a24', reviewed: '2026-11-10, verified source (optimistic.etherscan) compared with Base: same router logic (solc 0.8.9, not a proxy); runtime bytecode equals Ethereum\'s except the wrapped-native immutable; swap proven on a fork' },
  bsc: { codeSha256: '490e7b952f674cef0c24dd14a7e186dde993f609c9a6c29b0c217d188f5ec264', reviewed: '2026-11-10, verified source (bscscan) compared with Base: same router logic (solc 0.8.9, not a proxy); runtime bytecode equals Ethereum\'s except the wrapped-native immutable; swap proven on a fork' },
  avalanche: { codeSha256: 'e8cd97d1ba8070943c359bb199bbe5453ad81dcbe552a4d74f37af56e24c66d5', reviewed: '2026-11-10, verified source (snowscan) compared with Base: same router logic (solc 0.8.9, not a proxy); runtime bytecode equals Ethereum\'s except the wrapped-native immutable; swap proven on a fork' },
  // HyperEVM runs a cut-down router (solc 0.8.17): no swapGeneric, no whitelist, no partial fill (flag 0x01 is ignored, the
  // minimum-return check is always strict). `reduced` makes the verifier refuse swapGeneric and the partial-fill flag there.
  hyperevm: { codeSha256: 'bacf3c0d4d75039f6fce97796ec7262cc19459adaaff6e90fdde7ff7d56bee5d', reduced: true, reviewed: '2026-11-10, verified source read in full (MetaAggregationRouterV2 reduced variant, not a proxy): pulls at most desc.amount, strict minReturnAmount at dstReceiver, fees only with feeReceivers; swap proven on a fork' },
};
const FLAG_PARTIAL_FILL = 0x01n;
const FLAG_REQUIRES_EXTRA_ETH = 0x02n, FLAG_SIMPLE_SWAP = 0x20n;
const MAX_SWAP_GAS = 2_000_000n, APPROVE_GAS_CAP = 120_000n;

export interface SwapDesc { srcToken: string; dstToken: string; dstReceiver: string; amount: bigint; minReturnAmount: bigint; flags: bigint; functionName: string }

/** sha256 of the calldata bytes, lowercase hex: this is what the approved intent commits to. */
export const swapDataHash = (data: string): string => { if (!/^0x([0-9a-fA-F]{2})+$/.test(data)) throw new Error('swap calldata is not hex'); return Buffer.from(sha256(Buffer.from(data.slice(2), 'hex'))).toString('hex'); };

/** Decode the router call and check every value-moving field against the approved intent. Throws on any mismatch. */
export function verifyKyberSwap(i: Intent, data: string): SwapDesc {
  const n = getNetwork(i.network), s = i.swap;
  if (n.family !== 'evm' || !i.evm || !s) throw new Error('not an EVM swap intent');
  if (i.bridge || i.xswap) throw new Error('an intent is a swap or a bridge, not both');
  if (s.provider !== 'kyberswap') throw new Error('unknown swap provider');
  if (!KYBER_ENABLED[i.network]) throw new Error(`swap execution is not enabled on ${n.name}`);
  if (i.chainRef !== n.chainRef) throw new Error('chain id mismatch');
  if (s.router !== KYBER_ROUTER) throw new Error('router is not the pinned KyberSwap router');
  if (i.to !== i.from) throw new Error('a swap must deliver to the wallet itself');
  const src = getAsset(i.network, i.asset), dst = getAsset(i.network, s.toAsset); // throws unless both are in the registry
  if (src.decimals !== i.decimals || src.symbol !== i.symbol) throw new Error('input asset metadata mismatch');
  if (src.id === dst.id) throw new Error('input and output are the same asset');
  const amount = baseUnits(i.amount), minOut = baseUnits(s.minOut);
  if (amount <= 0n || minOut <= 0n) throw new Error('amounts must be positive');
  if (swapDataHash(data) !== s.dataHash) throw new Error('calldata does not match the approved hash');
  let fn: string, desc: any;
  try {
    const d = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: data as Hex });
    fn = d.functionName;
    if (fn === 'swap' || fn === 'swapGeneric') desc = (d.args as any[])[0].desc;
    else if (fn === 'swapSimpleMode') desc = (d.args as any[])[1];
    else throw new Error('unexpected router function');
    // the decoder accepts trailing garbage: re-encoding must give back the exact bytes
    if (encodeFunctionData({ abi: KYBER_ROUTER_ABI, functionName: fn, args: d.args as never }).toLowerCase() !== data.toLowerCase()) throw new Error('calldata is not canonical');
  } catch (e) { throw new Error(`swap calldata rejected: ${(e as Error).message.slice(0, 120)}`); }
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const want = (a: { id: string }) => (a.id === 'native' ? KYBER_NATIVE : a.id);
  if (!eq(desc.srcToken, want(src))) throw new Error('calldata spends another token');
  if (!eq(desc.dstToken, want(dst))) throw new Error('calldata buys another token');
  if (!eq(desc.dstReceiver, i.from)) throw new Error('calldata pays another address');
  if (desc.amount !== amount) throw new Error('calldata spends another amount');
  if (desc.minReturnAmount < minOut) throw new Error('calldata guarantees less than the approved minimum');
  if (desc.feeReceivers.length !== 0 || desc.feeAmounts.length !== 0) throw new Error('calldata carries fee receivers');
  if (desc.permit !== '0x') throw new Error('calldata carries a permit');
  if (KYBER_ENABLED[i.network]!.reduced && (fn === 'swapGeneric' || (desc.flags & FLAG_PARTIAL_FILL) !== 0n)) throw new Error('calldata uses a router feature that does not exist on this network');
  if ((desc.flags & FLAG_REQUIRES_EXTRA_ETH) !== 0n) throw new Error('calldata asks for extra native coin');
  // simple mode skips the router's msg.value check: native coin sent with it would stay in the router
  if (src.id === 'native' && (fn === 'swapSimpleMode' || (desc.flags & FLAG_SIMPLE_SWAP) !== 0n)) throw new Error('simple-mode calldata cannot spend the native coin');
  let direct = 0n; for (const a of desc.srcAmounts as bigint[]) direct += a;
  if (direct > amount || desc.srcReceivers.length !== desc.srcAmounts.length) throw new Error('calldata distributes more than the input amount');
  return { srcToken: desc.srcToken, dstToken: desc.dstToken, dstReceiver: desc.dstReceiver, amount: desc.amount, minReturnAmount: desc.minReturnAmount, flags: desc.flags, functionName: fn };
}

/** The transactions the signer will sign for a swap: an exact-amount approval when asked, then the router call. */
export function buildEvmSwapTxs(i: Intent, data: string): { approve: TransactionSerializableEIP1559 | null; swap: TransactionSerializableEIP1559 } {
  verifyKyberSwap(i, data);
  const n = getNetwork(i.network), s = i.swap!, e = i.evm!;
  const src = getAsset(i.network, i.asset), amount = baseUnits(i.amount);
  const gas = baseUnits(e.gasLimit), maxFeePerGas = baseUnits(e.maxFeePerGas), tip = baseUnits(e.maxPriorityFeePerGas), approveGas = baseUnits(s.approveGas);
  if (tip > maxFeePerGas) throw new Error('priority fee above max fee');
  if (gas < 60_000n || gas > MAX_SWAP_GAS) throw new Error('swap gas limit out of range');
  // approveGas 0 = no approval transaction: native input, or a token whose existing allowance already covers the amount
  // (the signer cannot see allowances; if it were insufficient the swap simply reverts)
  if (approveGas !== 0n && (src.id === 'native' || approveGas < 30_000n || approveGas > APPROVE_GAS_CAP)) throw new Error('approval gas out of range');
  if ((gas + approveGas) * maxFeePerGas > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const common = { type: 'eip1559' as const, chainId: Number(n.chainRef), maxFeePerGas, maxPriorityFeePerGas: tip };
  const approve = approveGas === 0n ? null : {
    ...common, nonce: e.nonce, gas: approveGas, to: src.id as Hex, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER as Hex, amount] }), // exact amount, never unlimited
  };
  const swap = { ...common, nonce: e.nonce + (approve ? 1 : 0), gas, to: KYBER_ROUTER as Hex, value: src.id === 'native' ? amount : 0n, data: data as Hex };
  return { approve, swap };
}

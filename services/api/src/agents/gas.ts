// Gas reserve of an agent vault, per network. The vault pays its own network fees in the native coin of its network; the
// reserve is the amount of that coin the engine never counts as tradable and without which an agent may not go LIVE.
//
// RULE (same on every network, sized from recent gas prices, never from a constant per chain):
//   one order  = ORDER_GAS gas (a routed swap plus its exact-amount approval, with margin) at the recent gas price
//                (highest base fee of the last 20 blocks + the median tip), never counted above the signer policy's fee
//                ceiling for that network (the signer refuses any order whose fee could exceed it);
//   reserve    = RESERVE_ORDERS orders at that cost, and at least FLOOR_ORDERS orders at the policy ceiling itself, so a
//                fee spike right after funding still leaves room to sell and to withdraw.
// On Ethereum mainnet one order costs dollars: an agent with small orders there is eaten by fees. feeShare() measures it.
import { hexToBigInt } from 'viem';
import type { NetworkDef } from '@spw/core';
import { rpcAny } from '../chains/rpc.ts';

export const ORDER_GAS = 450_000n, RESERVE_ORDERS = 8n, FLOOR_ORDERS = 2n;
/** share of an order's value above which network fees are flagged as eating the agent */
export const FEE_WARN_SHARE = 0.01;

export interface GasReserve { /** wei per gas used for the estimate */ gasPrice: bigint; /** native base units for one order */ perOrder: bigint; reserve: bigint }
/** Pure: the reserve for a recent gas price and the signer policy's fee ceiling (native base units) on that network. */
export function reserveFromGas(gasPrice: bigint, feeCeiling: bigint): GasReserve {
  if (gasPrice < 0n || feeCeiling <= 0n) throw new Error('gas reserve needs a gas price and a fee ceiling');
  const raw = ORDER_GAS * gasPrice, perOrder = raw > feeCeiling ? feeCeiling : raw;
  const byPrice = RESERVE_ORDERS * perOrder, floor = FLOOR_ORDERS * feeCeiling;
  return { gasPrice, perOrder, reserve: byPrice > floor ? byPrice : floor };
}
/** Network fee of one order as a share of the order's value (both in USD). */
export const feeShare = (perOrder: bigint, nativeDecimals: number, nativeUsd: number, orderUsd: number): number => (Number(perOrder) / 10 ** nativeDecimals) * nativeUsd / orderUsd;

/** Recent gas price: highest base fee of the last 20 blocks plus the median of their median tips. */
export async function recentGasPrice(n: NetworkDef): Promise<bigint> {
  try {
    const h = await rpcAny<{ baseFeePerGas: `0x${string}`[]; reward?: `0x${string}`[][] }>(n.rpc, 'eth_feeHistory', ['0x14', 'latest', [50]]);
    const base = h.baseFeePerGas.map((x) => hexToBigInt(x)), tips = (h.reward ?? []).map((r) => hexToBigInt(r[0] ?? '0x0')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!base.length) throw new Error('empty fee history');
    return base.reduce((m, x) => (x > m ? x : m), 0n) + (tips[Math.floor(tips.length / 2)] ?? 0n);
  } catch {
    return hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_gasPrice', [])); // a node without fee history: its own suggestion
  }
}

const cache = new Map<string, { at: number; v: GasReserve }>();
/** The reserve of a network right now (cached one minute). Throws when no gas price can be read or the policy sets no ceiling: no reserve, no LIVE. */
export async function gasReserve(n: NetworkDef, feeCeiling: string | undefined, now = Date.now()): Promise<GasReserve> {
  if (feeCeiling === undefined) throw new Error(`the signer policy sets no fee ceiling on ${n.name}`);
  const key = `${n.id}:${feeCeiling}`, c = cache.get(key);
  if (c && now - c.at < 60_000) return c.v;
  const v = reserveFromGas(await recentGasPrice(n), BigInt(feeCeiling));
  cache.set(key, { at: now, v });
  return v;
}

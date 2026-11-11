import { encodeFunctionData, erc20Abi, serializeTransaction, type TransactionSerializableEIP1559 } from 'viem';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import { getAsset, getNetwork } from './networks.ts';
import type { Intent } from './intent.ts';

/** Rebuild the exact unsigned EIP-1559 transaction from an intent. Only native + allowlisted ERC-20 transfer. */
export function buildEvmTx(i: Intent): TransactionSerializableEIP1559 {
  const n = getNetwork(i.network);
  if (n.family !== 'evm' || !i.evm) throw new Error('not an EVM intent');
  if (i.swap) throw new Error('this is a swap intent, not a transfer');
  if (i.bridge) throw new Error('this is a bridge intent, not a transfer');
  if (i.chainRef !== n.chainRef) throw new Error('chain id mismatch');
  const asset = getAsset(i.network, i.asset); // throws when token is not allowlisted
  if (asset.decimals !== i.decimals || asset.symbol !== i.symbol) throw new Error('asset metadata mismatch');
  const to = normalizeAddress(i.network, i.to) as `0x${string}`;
  if (to !== i.to) throw new Error('destination not normalized');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  const gas = baseUnits(i.evm.gasLimit), maxFeePerGas = baseUnits(i.evm.maxFeePerGas), tip = baseUnits(i.evm.maxPriorityFeePerGas);
  if (tip > maxFeePerGas) throw new Error('priority fee above max fee');
  if (gas * maxFeePerGas > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const common = { type: 'eip1559' as const, chainId: Number(n.chainRef), nonce: i.evm.nonce, gas, maxFeePerGas, maxPriorityFeePerGas: tip };
  if (asset.id === 'native') {
    if (gas !== 21000n) throw new Error('native transfer must use 21000 gas (EOA destinations only)');
    return { ...common, to, value: amount };
  }
  if (gas > 200_000n) throw new Error('gas limit too high for ERC-20 transfer');
  if (to.toLowerCase() === asset.id.toLowerCase()) throw new Error('destination is the token contract');
  return {
    ...common, to: asset.id as `0x${string}`, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  };
}

export const serializeEvmUnsigned = (i: Intent) => serializeTransaction(buildEvmTx(i));

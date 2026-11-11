import { bchIsP2sh, encodeBchInputs, estimateBchSize, type NetworkDef } from '@spw/core';
import { utxoAdapter, type Source } from './btc.ts';
import type { Adapter } from './rpc.ts';

/**
 * Bitcoin Cash: same indexer sources and coin selection as the other Bitcoin-style chains (two independent indexers must agree
 * on the spendable coin set); the intent carries the coins in the plugin section `x`. No previous transactions are needed:
 * the signature digest commits to every input value. Chain identity is the first block after the last chain split (registry
 * `refHeight`, block 661648), because the genesis block is also Bitcoin's, Bitcoin SV's and eCash's.
 */
export function bchAdapter(n: NetworkDef, sources?: Source[]): Adapter {
  return utxoAdapter(n, {
    size: (k, to, hasChange) => estimateBchSize(k, bchIsP2sh(n, to), hasChange),
    section: async (chosen, change, fee) => ({ section: { x: { inputs: encodeBchInputs(chosen), change: change.toString(), fee: fee.toString() } } }),
  }, sources);
}

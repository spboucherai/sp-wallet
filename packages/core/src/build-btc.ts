import { Address, NETWORK, OutScript, Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import type { Intent } from './intent.ts';

export const BTC_DUST = 546n;

/** Rebuild the unsigned PSBT-style transaction. All inputs are P2WPKH outputs of `from`; change returns to `from`. */
export function buildBtcTx(i: Intent): Transaction {
  if (i.network !== 'bitcoin' || !i.btc) throw new Error('not a BTC intent');
  if (i.asset !== 'native' || i.decimals !== 8 || i.symbol !== 'BTC') throw new Error('asset mismatch');
  if (normalizeAddress('bitcoin', i.to) !== i.to) throw new Error('destination not normalized');
  const fromDecoded = Address(NETWORK).decode(i.from);
  if (fromDecoded.type !== 'wpkh') throw new Error('source must be native SegWit (P2WPKH)');
  const script = OutScript.encode(fromDecoded);
  const amount = baseUnits(i.amount), change = baseUnits(i.btc.change), fee = baseUnits(i.btc.fee);
  if (amount < BTC_DUST) throw new Error('amount below dust');
  if (change !== 0n && change < BTC_DUST) throw new Error('change below dust');
  if (fee > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const seen = new Set<string>();
  let total = 0n;
  const tx = new Transaction();
  for (const u of i.btc.inputs) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new Error('duplicate input');
    seen.add(k);
    const v = baseUnits(u.value);
    total += v;
    tx.addInput({ txid: hex.decode(u.txid), index: u.vout, witnessUtxo: { script, amount: v }, sequence: 0xfffffffd });
  }
  if (total !== amount + change + fee) throw new Error('inputs != outputs + fee');
  tx.addOutputAddress(i.to, amount, NETWORK);
  if (change > 0n) tx.addOutputAddress(i.from, change, NETWORK);
  return tx;
}

/** Conservative vsize estimate for P2WPKH inputs and up to two outputs. */
export function estimateBtcVsize(nInputs: number, toAddr: string, hasChange: boolean): number {
  const t = Address(NETWORK).decode(toAddr).type;
  const outSize = t === 'wpkh' ? 31 : t === 'tr' || t === 'wsh' ? 43 : t === 'sh' ? 32 : 34;
  return Math.ceil(10.5 + 68 * nInputs + outSize + (hasChange ? 31 : 0)) + 1;
}

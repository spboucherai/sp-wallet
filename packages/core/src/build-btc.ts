import { Address, OutScript, Transaction } from '@scure/btc-signer';
import { getNetwork, type NetworkDef } from './networks.ts';
import { hex } from '@scure/base';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import type { Intent } from './intent.ts';

export const BTC_DUST = 546n;
/** Address/script parameters of a Bitcoin-style network, in the shape @scure/btc-signer expects. */
export function btcParams(n: NetworkDef) {
  if (!n.utxo) throw new Error(`${n.id} is not a UTXO network`);
  return { bech32: n.utxo.bech32 ?? 'none', pubKeyHash: n.utxo.pubKeyHash, scriptHash: n.utxo.scriptHash, wif: 0x80 };
}
export const dustOf = (n: NetworkDef) => BigInt(n.utxo?.dust ?? 546);

/** Rebuild the unsigned PSBT-style transaction. All inputs are P2WPKH outputs of `from`; change returns to `from`. */
export function buildBtcTx(i: Intent, aux?: Record<string, unknown>): Transaction {
  const n = getNetwork(i.network);
  if (n.family !== 'btc' || !n.utxo || !i.btc) throw new Error('not a UTXO intent');
  if (i.xswap) throw new Error('this is a cross-chain swap intent, not a transfer');
  if (i.chainRef !== n.chainRef) throw new Error('chain identity mismatch');
  if (i.asset !== 'native' || i.decimals !== n.native.decimals || i.symbol !== n.native.symbol) throw new Error('asset mismatch');
  const P = btcParams(n), DUST = dustOf(n);
  if (normalizeAddress(i.network, i.to) !== i.to) throw new Error('destination not normalized');
  const fromDecoded = Address(P).decode(i.from);
  if (fromDecoded.type !== n.utxo.kind) throw new Error(n.utxo.kind === 'wpkh' ? 'source must be native SegWit (P2WPKH)' : 'source must be P2PKH');
  const script = OutScript.encode(fromDecoded);
  const amount = baseUnits(i.amount), change = baseUnits(i.btc.change), fee = baseUnits(i.btc.fee);
  if (amount < DUST) throw new Error('amount below dust');
  if (change !== 0n && change < DUST) throw new Error('change below dust');
  if (fee > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const prev = (aux?.prevTx ?? {}) as Record<string, string>;
  const seen = new Set<string>();
  let total = 0n;
  const tx = new Transaction();
  for (const u of i.btc.inputs) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new Error('duplicate input');
    seen.add(k);
    const v = baseUnits(u.value);
    total += v;
    if (n.utxo.kind === 'wpkh') tx.addInput({ txid: hex.decode(u.txid), index: u.vout, witnessUtxo: { script, amount: v }, sequence: 0xfffffffd });
    else {
      // legacy signatures do not commit to the input value: the full previous transaction is required and is checked
      // against the input's txid, script and value, so a lying API cannot inflate the fee
      const raw = prev[u.txid];
      if (!raw) throw new Error('missing previous transaction for a legacy input');
      const pt = Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
      if (pt.id !== u.txid) throw new Error('previous transaction does not match input txid');
      const o = pt.getOutput(u.vout);
      if (o.amount !== v || !o.script || hex.encode(o.script) !== hex.encode(script)) throw new Error('previous output does not match the approved input');
      tx.addInput({ txid: hex.decode(u.txid), index: u.vout, nonWitnessUtxo: hex.decode(raw), sequence: 0xfffffffd });
    }
  }
  if (total !== amount + change + fee) throw new Error('inputs != outputs + fee');
  tx.addOutputAddress(i.to, amount, P);
  if (change > 0n) tx.addOutputAddress(i.from, change, P);
  return tx;
}

/** Conservative vsize estimate for P2WPKH inputs and up to two outputs. */
export function estimateBtcVsize(nInputs: number, toAddr: string, hasChange: boolean, n: NetworkDef = getNetwork('bitcoin')): number {
  const t = Address(btcParams(n)).decode(toAddr).type;
  const outSize = t === 'wpkh' ? 31 : t === 'tr' || t === 'wsh' ? 43 : t === 'sh' ? 32 : 34;
  const legacy = n.utxo?.kind === 'pkh';
  return Math.ceil(10.5 + (legacy ? 148 : 68) * nInputs + outSize + (hasChange ? (legacy ? 34 : 31) : 0)) + 1;
}

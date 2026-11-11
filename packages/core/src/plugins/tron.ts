// TRON family plugin: deterministic `Transaction.raw` protobuf encoder for exactly two shapes —
// a native TRX transfer (TransferContract) and an allowlisted TRC-20 `transfer(address,uint256)` (TriggerSmartContract).
// Pure module: no network access. The encoding is proven byte-identical to tronweb (tests) and to java-tron full nodes
// (scripts/smoke-tron.mts). Protobuf layout: https://github.com/tronprotocol/protocol/blob/master/core/Tron.proto
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createBase58check } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

const b58c = createBase58check(sha256);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const enc = new TextEncoder();

/** Bandwidth burn price (chain parameter getTransactionFee), sun per byte. The API adapter refuses to prepare if the chain disagrees. */
export const TRON_BANDWIDTH_PRICE = 1000n;
/** java-tron adds this to the serialized size when charging bandwidth (Constant.MAX_RESULT_SIZE_IN_TX). */
export const TRON_RESULT_OVERHEAD = 64;
/** Burned by the sender when a TRX transfer creates the destination account (getCreateNewAccountFeeInSystemContract). */
export const TRON_ACTIVATION_FEE = 1_000_000n;
/** Added to the activation fee when the sender has no staked bandwidth for the creating transaction (getCreateAccountFee). */
export const TRON_CREATE_ACCOUNT_BANDWIDTH_FEE = 100_000n;
/** Protocol ceiling for fee_limit (getMaxFeeLimit), in sun. */
export const TRON_MAX_FEE_LIMIT = 15_000_000_000n;
const INT64_MAX = (1n << 63n) - 1n;
const DAY_MS = 86_400_000n;
const SKEW_MS = 600_000n; // tolerated distance between the chain timestamps and the approval window
const TRANSFER_SELECTOR = 'a9059cbb'; // keccak256("transfer(address,uint256)")[0:4]
const X_NATIVE = ['expiration', 'ref_block_bytes', 'ref_block_hash', 'timestamp'];
const X_TOKEN = [...X_NATIVE, 'fee_limit'].sort();

/** base58check address -> 21 bytes (0x41 || 20-byte account id). Throws unless it is the canonical mainnet form. */
export function tronAddressBytes(addr: string): Uint8Array {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) throw new Error('invalid TRON address');
  let raw: Uint8Array;
  try { raw = b58c.decode(addr); } catch { throw new Error('invalid TRON address checksum'); }
  if (raw.length !== 21 || raw[0] !== 0x41) throw new Error('invalid TRON address');
  if (b58c.encode(raw) !== addr) throw new Error('non-canonical TRON address');
  if (raw.subarray(1).every((b) => b === 0)) throw new Error('zero address');
  return raw;
}
export const tronAddressFromBytes = (raw21: Uint8Array): string => {
  if (raw21.length !== 21 || raw21[0] !== 0x41) throw new Error('invalid TRON address bytes');
  return b58c.encode(raw21);
};
/** 33-byte compressed (or 65-byte uncompressed) secp256k1 key -> address: base58check(0x41 || keccak256(X||Y)[12:]). */
export function tronAddressFromPublicKey(publicKey: Uint8Array): string {
  const un = secp256k1.Point.fromBytes(publicKey).toBytes(false); // 0x04 || X || Y
  const raw = new Uint8Array(21);
  raw[0] = 0x41;
  raw.set(keccak_256(un.subarray(1)).subarray(12), 1);
  return b58c.encode(raw);
}

// ---- minimal protobuf writer (proto3: varint and length-delimited fields only) ----
function varint(n: bigint): number[] {
  if (n < 0n || n > INT64_MAX) throw new Error('int64 out of range');
  const out: number[] = [];
  for (;;) { const b = Number(n & 0x7fn); n >>= 7n; if (n === 0n) { out.push(b); return out; } out.push(b | 0x80); }
}
const cat = (...a: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
};
const fVarint = (field: number, v: bigint) => cat(varint(BigInt(field << 3)), varint(v));
const fBytes = (field: number, v: Uint8Array) => cat(varint(BigInt((field << 3) | 2)), varint(BigInt(v.length)), v);

/** ABI call data of `transfer(address,uint256)`: selector || 32-byte address word || 32-byte amount word. */
export function trc20TransferData(to: string, amount: bigint): Uint8Array {
  if (amount <= 0n || amount >= 1n << 256n) throw new Error('amount out of range');
  const data = new Uint8Array(68);
  data.set(unhex(TRANSFER_SELECTOR), 0);
  data.set(tronAddressBytes(to).subarray(1), 16);
  data.set(unhex(amount.toString(16).padStart(64, '0')), 36);
  return data;
}

export interface TronTx {
  kind: 'TransferContract' | 'TriggerSmartContract';
  /** serialized Transaction.raw */
  rawData: Uint8Array;
  /** sha256(rawData) — the transaction id and the digest that is signed */
  txid: Uint8Array;
  /** fee_limit in sun (0 for a native transfer) */
  feeLimit: bigint;
  /** bytes charged as bandwidth once signed with one 65-byte signature (serialized Transaction + 64) */
  bandwidthBytes: number;
  /** most the transaction itself can burn: fee_limit + bandwidth paid in TRX (activation of the recipient not included) */
  worstFee: bigint;
}

const dec = (v: string | undefined, name: string): bigint => {
  if (v === undefined || !/^(0|[1-9]\d{0,18})$/.test(v)) throw new Error(`x.${name} must be a decimal integer`);
  const n = BigInt(v);
  if (n > INT64_MAX) throw new Error(`x.${name} out of range`);
  return n;
};

/** Rebuild the exact `Transaction.raw` bytes from an intent. Throws on anything that is not one of the two supported shapes. */
export function buildTronTx(i: Intent, net: NetworkDef): TronTx {
  if (net.family !== 'tron' || i.network !== net.id) throw new Error('not a TRON intent');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (genesis block id)');
  if (i.evm || i.btc || i.sol) throw new Error('foreign chain section in a TRON intent');
  if (i.memo !== undefined) throw new Error('memo is not supported on TRON transfers');
  if (!i.x) throw new Error('missing TRON parameters');
  const asset = i.asset === 'native' ? net.native : net.tokens.find((t) => t.id === i.asset);
  if (!asset) throw new Error(`asset not allowlisted on ${net.id}: ${i.asset}`);
  if (asset.decimals !== i.decimals || asset.symbol !== i.symbol) throw new Error('asset metadata mismatch');
  const native = asset.id === 'native';

  const keys = Object.keys(i.x).sort();
  const want = native ? X_NATIVE : X_TOKEN;
  if (keys.length !== want.length || keys.some((k, n) => k !== want[n])) throw new Error(`TRON parameters must be exactly: ${want.join(', ')}`);
  const x = i.x as Record<string, string>;
  if (!/^[0-9a-f]{4}$/.test(x.ref_block_bytes!)) throw new Error('x.ref_block_bytes must be 2 bytes of lowercase hex');
  if (!/^[0-9a-f]{16}$/.test(x.ref_block_hash!)) throw new Error('x.ref_block_hash must be 8 bytes of lowercase hex');
  const expiration = dec(x.expiration, 'expiration'), timestamp = dec(x.timestamp, 'timestamp');
  if (timestamp <= 0n || expiration <= timestamp) throw new Error('expiration must be after timestamp');
  if (expiration - timestamp >= DAY_MS) throw new Error('expiration too far (the protocol allows less than 24 h)');
  // the signed transaction must not outlive the approval window by more than the tolerated clock skew
  const created = BigInt(i.createdAt) * 1000n, expires = BigInt(i.expiresAt) * 1000n;
  if (timestamp < created - SKEW_MS || timestamp > created + SKEW_MS) throw new Error('timestamp outside the approval window');
  if (expiration > expires + SKEW_MS) throw new Error('expiration outlives the approval window');

  const from = tronAddressBytes(i.from), to = tronAddressBytes(i.to);
  if (i.from === i.to) throw new Error('source equals destination');
  if (net.tokens.some((t) => t.id === i.to)) throw new Error('destination is a token contract');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');

  let type: number, typeName: TronTx['kind'], param: Uint8Array, feeLimit = 0n;
  if (native) {
    if (amount > INT64_MAX) throw new Error('amount out of range');
    type = 1; typeName = 'TransferContract';
    param = cat(fBytes(1, from), fBytes(2, to), fVarint(3, amount));
  } else {
    feeLimit = dec(x.fee_limit, 'fee_limit');
    if (feeLimit <= 0n || feeLimit > TRON_MAX_FEE_LIMIT) throw new Error('fee_limit out of range');
    type = 31; typeName = 'TriggerSmartContract';
    // owner, contract, (call_value = 0 omitted), data — never any TRX or TRC-10 value attached
    param = cat(fBytes(1, from), fBytes(2, tronAddressBytes(asset.id)), fBytes(4, trc20TransferData(i.to, amount)));
  }
  const any = cat(fBytes(1, enc.encode(`type.googleapis.com/protocol.${typeName}`)), fBytes(2, param));
  const contract = cat(fVarint(1, BigInt(type)), fBytes(2, any));
  const rawData = cat(
    fBytes(1, unhex(x.ref_block_bytes!)), fBytes(4, unhex(x.ref_block_hash!)), fVarint(8, expiration),
    fBytes(11, contract), fVarint(14, timestamp), native ? [] : fVarint(18, feeLimit),
  );
  const bandwidthBytes = tronWire(rawData, new Uint8Array(65)).length + TRON_RESULT_OVERHEAD;
  const worstFee = feeLimit + BigInt(bandwidthBytes) * TRON_BANDWIDTH_PRICE;
  if (worstFee > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  return { kind: typeName, rawData, txid: sha256(rawData), feeLimit, bandwidthBytes, worstFee };
}

/** Serialized `Transaction`: field 1 = raw_data, field 2 = one 65-byte signature (r || s || v). This is what /wallet/broadcasthex takes. */
export function tronWire(rawData: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) throw new Error('bad signature length');
  return cat(fBytes(1, rawData), fBytes(2, signature));
}

export const tronPlugin: FamilyPlugin = {
  family: 'tron',
  curve: 'secp256k1',
  path: (net) => `m/44'/${net.coinType ?? 195}'/0'/0/0`,
  address: (_net, publicKey) => tronAddressFromPublicKey(publicKey),
  normalizeAddress: (_net, addr) => tronAddressFromBytes(tronAddressBytes(addr.trim())),
  build(i, net) {
    const t = buildTronTx(i, net);
    return { signDocs: [t.txid], describe: {
      kind: t.kind, from: i.from, to: i.to, asset: i.asset, amount: i.amount, txid: hex(t.txid), rawDataHex: hex(t.rawData),
      feeLimit: t.feeLimit.toString(), bandwidthBytes: String(t.bandwidthBytes), worstFee: t.worstFee.toString(),
    } };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const t = buildTronTx(i, net);
    if (key.curve !== 'secp256k1' || !key.signDigest) throw new Error('TRON needs a secp256k1 key');
    if (tronAddressFromPublicKey(key.publicKey) !== i.from) throw new Error('source address is not controlled by this key');
    const s = key.signDigest(t.txid);
    if (s.compact.length !== 64 || (s.recovery !== 0 && s.recovery !== 1)) throw new Error('unexpected signature shape');
    // never release a signature that does not verify against our own public key
    if (!secp256k1.verify(s.compact, t.txid, key.publicKey, { prehash: false, lowS: true })) throw new Error('signature self-check failed');
    const sig = cat(s.compact, [27 + s.recovery]);
    return { raw: hex(tronWire(t.rawData, sig)), txid: hex(t.txid) };
  },
};

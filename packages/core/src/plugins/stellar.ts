// Stellar (family "stellar"): native XLM only, one operation per transaction.
// Pure module: no network access, no side effects. The TransactionEnvelope XDR is written by hand from the approved
// intent and proven byte-for-byte against @stellar/stellar-base in test/stellar.test.ts.
//
// References: Stellar-transaction.x / Stellar-ledger-entries.x / Stellar-types.x (stellar-xdr), SEP-0005 (key derivation),
// SEP-0023 (strkey). Intent parameters (x):
//   op        "payment" (destination exists) | "createAccount" (it does not; amount is the starting balance, >= 1 XLM)
//   sequence  the transaction sequence number (account sequence + 1), decimal int64
//   fee       the transaction fee bid in stroops, decimal uint32, <= intent.maxFee
//   maxTime   time bound (unix seconds): the transaction is invalid in any ledger closing after it
//   memoType  "none" | "text" | "id" — must equal stellarMemoType(intent.memo)
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base32nopad } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

export const STELLAR_PUBNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
/** 1 XLM: smallest starting balance this wallet will create an account with (2 base reserves at 0.5 XLM). */
export const STELLAR_MIN_CREATE = 10_000_000n;
/** network minimum fee per operation, in stroops */
export const STELLAR_MIN_FEE = 100n;
/** longest validity window (maxTime - createdAt) the signer accepts, in seconds */
export const STELLAR_MAX_VALIDITY_SEC = 900;

const INT64_MAX = (1n << 63n) - 1n, UINT64_MAX = (1n << 64n) - 1n, UINT32_MAX = 0xffff_ffffn;
const VERSION_ACCOUNT = 6 << 3; // 'G'
const X_KEYS = ['fee', 'maxTime', 'memoType', 'op', 'sequence'];
const enc = new TextEncoder();

function crc16xmodem(b: Uint8Array): number {
  let crc = 0;
  for (const byte of b) {
    crc ^= byte << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** strkey "G…" account id of an ed25519 public key */
export function stellarEncodeAccount(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  const body = new Uint8Array(35);
  body[0] = VERSION_ACCOUNT; body.set(publicKey, 1);
  const crc = crc16xmodem(body.subarray(0, 33));
  body[33] = crc & 0xff; body[34] = crc >> 8; // little-endian
  return base32nopad.encode(body);
}

/** Decode a canonical "G…" account id to its 32-byte key. Muxed (M…), secret (S…), contract (C…) and any other strkey are refused. */
export function stellarDecodeAccount(addr: string): Uint8Array {
  if (typeof addr !== 'string') throw new Error('invalid Stellar address');
  if (/^M[A-Z2-7]{68}$/.test(addr)) throw new Error('muxed Stellar addresses (M…) are not supported: use the G… address and a memo');
  if (!/^G[A-Z2-7]{55}$/.test(addr)) throw new Error('invalid Stellar address: expected 56 characters starting with G');
  let raw: Uint8Array;
  try { raw = base32nopad.decode(addr); } catch { throw new Error('invalid Stellar address encoding'); }
  if (raw.length !== 35 || raw[0] !== VERSION_ACCOUNT) throw new Error('invalid Stellar address: not an account id');
  const crc = crc16xmodem(raw.subarray(0, 33));
  if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8) throw new Error('invalid Stellar address checksum');
  const key = raw.slice(1, 33);
  if (stellarEncodeAccount(key) !== addr) throw new Error('non-canonical Stellar address');
  return key;
}

/**
 * The single memo rule, used by the API and re-checked by the signer:
 *   no memo                                             -> "none"
 *   canonical decimal integer in [0, 2^64-1] ("0" or no leading zero, digits only) -> "id"   (MEMO_ID)
 *   anything else, 1..28 UTF-8 bytes                    -> "text" (MEMO_TEXT)
 * Everything else throws. A numeric string with leading zeros or above 2^64-1 is text (an id could not carry it unchanged).
 */
export function stellarMemoType(memo: string | undefined): 'none' | 'text' | 'id' {
  if (memo === undefined) return 'none';
  if (memo.length === 0) throw new Error('empty memo');
  if (/^(0|[1-9]\d{0,19})$/.test(memo) && BigInt(memo) <= UINT64_MAX) return 'id';
  const bytes = enc.encode(memo);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== memo) throw new Error('memo is not valid Unicode text');
  if (bytes.length > 28) throw new Error('memo too long: a Stellar text memo holds at most 28 bytes');
  return 'text';
}

// ---- XDR writer (big-endian, 4-byte aligned) ----
class Xdr {
  private parts: Uint8Array[] = [];
  u32(n: bigint | number): this {
    const v = BigInt(n);
    if (v < 0n || v > UINT32_MAX) throw new Error('uint32 out of range');
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v)); this.parts.push(b); return this;
  }
  u64(v: bigint): this {
    if (v < 0n || v > UINT64_MAX) throw new Error('uint64 out of range');
    const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v); this.parts.push(b); return this;
  }
  i64(v: bigint): this {
    if (v < -(1n << 63n) || v > INT64_MAX) throw new Error('int64 out of range');
    const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v); this.parts.push(b); return this;
  }
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len || len % 4 !== 0) throw new Error('bad fixed opaque length');
    this.parts.push(b); return this;
  }
  varOpaque(b: Uint8Array, max: number): this {
    if (b.length > max) throw new Error('variable opaque too long');
    this.u32(b.length); this.parts.push(b);
    const pad = (4 - (b.length % 4)) % 4;
    if (pad) this.parts.push(new Uint8Array(pad));
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

const ENVELOPE_TYPE_TX = 2, KEY_TYPE_ED25519 = 0, PRECOND_TIME = 1, MEMO_NONE = 0, MEMO_TEXT = 1, MEMO_ID = 2;
const OP_CREATE_ACCOUNT = 0, OP_PAYMENT = 1, ASSET_TYPE_NATIVE = 0;

const canonicalInt = (name: string, s: string | undefined, min: bigint, max: bigint): bigint => {
  if (s === undefined || !/^(0|[1-9]\d{0,19})$/.test(s)) throw new Error(`x.${name} must be a canonical decimal integer`);
  const v = BigInt(s);
  if (v < min || v > max) throw new Error(`x.${name} out of range`);
  return v;
};

export interface StellarBuilt {
  /** Transaction XDR (what the hash commits to, without envelope type or signatures) */
  tx: Uint8Array;
  /** sha256(networkId || ENVELOPE_TYPE_TX || tx): the 32 bytes ed25519 signs, and the transaction id */
  hash: Uint8Array;
  describe: Record<string, string>;
}

/** Rebuild the exact Transaction XDR from the intent alone. Throws on anything that is not a plain XLM payment / account creation. */
export function buildStellarTx(i: Intent, net: NetworkDef): StellarBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'stellar' || i.network !== net.id) throw new Error('not a Stellar intent');
  if (net.chainRef !== STELLAR_PUBNET_PASSPHRASE) throw new Error('unknown Stellar network: only the public network is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (network passphrase)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in a Stellar intent');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native XLM can be sent on Stellar');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 7) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing Stellar parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing Stellar parameter (expected fee, maxTime, memoType, op, sequence)');

  const source = stellarDecodeAccount(i.from), dest = stellarDecodeAccount(i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > INT64_MAX) throw new Error('amount out of range');
  const op = x.op;
  if (op !== 'payment' && op !== 'createAccount') throw new Error('x.op must be "payment" or "createAccount"');
  if (op === 'createAccount' && amount < STELLAR_MIN_CREATE) throw new Error('creating an account needs a starting balance of at least 1 XLM');

  const fee = canonicalInt('fee', x.fee, STELLAR_MIN_FEE, UINT32_MAX);
  if (fee > baseUnits(i.maxFee)) throw new Error('fee above approved maximum');
  const sequence = canonicalInt('sequence', x.sequence, 1n, INT64_MAX);
  const maxTime = canonicalInt('maxTime', x.maxTime, 1n, UINT64_MAX);
  if (maxTime <= BigInt(i.createdAt)) throw new Error('time bound is not after the intent creation time');
  if (maxTime < BigInt(i.expiresAt)) throw new Error('time bound ends before the approval window');
  if (maxTime > BigInt(i.createdAt) + BigInt(STELLAR_MAX_VALIDITY_SEC)) throw new Error('time bound too far in the future');

  const memoType = stellarMemoType(i.memo);
  if (x.memoType !== memoType) throw new Error(`x.memoType must be "${memoType}" for this memo`);

  const w = new Xdr();
  w.u32(KEY_TYPE_ED25519).fixed(source, 32); // sourceAccount: MuxedAccount
  w.u32(fee); // fee
  w.i64(sequence); // seqNum
  w.u32(PRECOND_TIME).u64(0n).u64(maxTime); // cond: TimeBounds { minTime: 0, maxTime }
  if (memoType === 'none') w.u32(MEMO_NONE);
  else if (memoType === 'text') w.u32(MEMO_TEXT).varOpaque(enc.encode(i.memo!), 28);
  else w.u32(MEMO_ID).u64(BigInt(i.memo!));
  w.u32(1); // operations<100>: exactly one
  w.u32(0); // operation.sourceAccount: absent (the transaction source)
  if (op === 'payment') w.u32(OP_PAYMENT).u32(KEY_TYPE_ED25519).fixed(dest, 32).u32(ASSET_TYPE_NATIVE).i64(amount);
  else w.u32(OP_CREATE_ACCOUNT).u32(KEY_TYPE_ED25519).fixed(dest, 32).i64(amount);
  w.u32(0); // ext
  const tx = w.bytes();

  const hash = txHash(net, tx);
  return {
    tx, hash,
    describe: {
      network: net.name, operation: op === 'payment' ? 'Payment (native XLM)' : 'CreateAccount', from: i.from, to: i.to, amountStroops: amount.toString(),
      feeStroops: fee.toString(), sequence: sequence.toString(), maxTime: maxTime.toString(), memoType, memo: i.memo ?? '', txid: hexOf(hash),
    },
  };
}

function concat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
}
/** TransactionSignaturePayload hash: sha256(networkId || ENVELOPE_TYPE_TX || tx), networkId = sha256(passphrase) */
const txHash = (net: NetworkDef, tx: Uint8Array) => sha256(concat(sha256(enc.encode(net.chainRef)), new Xdr().u32(ENVELOPE_TYPE_TX).bytes(), tx));
const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** TransactionEnvelope (ENVELOPE_TYPE_TX) with one decorated signature. */
export function stellarEnvelope(tx: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64 || publicKey.length !== 32) throw new Error('bad signature or key length');
  return concat(new Xdr().u32(ENVELOPE_TYPE_TX).bytes(), tx, new Xdr().u32(1).fixed(publicKey.slice(28), 4).varOpaque(signature, 64).bytes());
}

/** Transaction id (hex) of a single-signature envelope produced by this module; used by the API to recognise an already-included transaction. */
export function stellarEnvelopeTxid(net: NetworkDef, rawBase64: string): string {
  const raw = Uint8Array.from(atob(rawBase64), (c) => c.charCodeAt(0));
  const tail = 4 + 4 + 4 + 64; // signature count, hint, length, signature
  if (raw.length < 4 + tail || new DataView(raw.buffer, raw.byteOffset).getUint32(0) !== ENVELOPE_TYPE_TX) throw new Error('not a Stellar transaction envelope');
  const tx = raw.subarray(4, raw.length - tail);
  return hexOf(txHash(net, tx));
}

export const stellarPlugin: FamilyPlugin = {
  family: 'stellar',
  curve: 'ed25519',
  path(net: NetworkDef): string {
    if (net.coinType !== 148) throw new Error('Stellar derivation requires coin type 148 (SEP-0005)');
    return "m/44'/148'/0'";
  },
  address: (_net: NetworkDef, publicKey: Uint8Array) => stellarEncodeAccount(publicKey),
  normalizeAddress(_net: NetworkDef, addr: string): string {
    stellarDecodeAccount(addr);
    return addr;
  },
  build(i: Intent, net: NetworkDef) {
    const b = buildStellarTx(i, net);
    return { signDocs: [b.hash], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const b = buildStellarTx(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage || key.publicKey.length !== 32) throw new Error('Stellar needs an ed25519 key');
    if (stellarEncodeAccount(key.publicKey) !== i.from) throw new Error('signing key does not control the source account');
    const sig = key.signMessage(b.hash);
    if (sig.length !== 64 || !ed25519.verify(sig, b.hash, key.publicKey)) throw new Error('signature self-check failed');
    return { raw: b64(stellarEnvelope(b.tx, key.publicKey, sig)), txid: hexOf(b.hash) };
  },
};

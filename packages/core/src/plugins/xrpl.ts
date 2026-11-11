// XRP Ledger family: native XRP Payment only (no issued currencies, no trust lines, no paths, no partial payments).
// Pure module: the transaction is a fixed set of fields in the ledger's canonical binary format
// (https://xrpl.org/docs/references/protocol/binary-format), proven byte-for-byte against xrpl.js / ripple-binary-codec
// in packages/core/test/xrpl.test.ts. The official codec is a test-only dependency: the encoding below is ~40 lines and
// keeps the signer's runtime on @noble / @scure only.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58xrp } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** Hash prefixes: "STX\0" for single-signing, "TXN\0" for the transaction id. */
const PREFIX_SIGN = Uint8Array.of(0x53, 0x54, 0x58, 0x00), PREFIX_TXID = Uint8Array.of(0x54, 0x58, 0x4e, 0x00);
/** tfFullyCanonicalSig: only the low-S form of the signature is valid (always enforced on mainnet today; set explicitly anyway). */
export const XRPL_TF_FULLY_CANONICAL_SIG = 0x8000_0000;
/** The ledger holds 10^17 drops in total; nothing larger can be a valid amount. */
const MAX_DROPS = 100_000_000_000_000_000n;
/** Absolute fee bound of this builder (1 XRP), independent of the policy ceiling: the whole Fee field is destroyed. */
export const XRPL_MAX_FEE_DROPS = 1_000_000n;
const X_KEYS = ['fee', 'lastLedgerSequence', 'sequence'];
const UINT32 = /^(0|[1-9]\d{0,9})$/;

const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const hexUp = (b: Uint8Array) => bytesToHex(b).toUpperCase();
export const sha512Half = (b: Uint8Array): Uint8Array => sha512(b).slice(0, 32);

function uint32(s: string | undefined, what: string): number {
  if (s === undefined || !UINT32.test(s)) throw new Error(`invalid ${what}`);
  const v = Number(s);
  if (v > 0xffff_ffff) throw new Error(`${what} out of range`);
  return v;
}
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; };
/** Native amount: bit 63 = 0 (XRP), bit 62 = 1 (positive), 62 bits of drops. */
function drops(v: bigint): Uint8Array {
  if (v < 0n || v > MAX_DROPS) throw new Error('amount out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, 0x4000_0000_0000_0000n | v);
  return b;
}
/** Length-prefixed blob; every blob in a Payment (key, signature) is at most 72 bytes, i.e. a one-byte length. */
function vl(b: Uint8Array): Uint8Array {
  if (b.length > 192) throw new Error('blob too long');
  return cat([b.length], b);
}

/** 20-byte account id of a classic address. X-addresses, other networks' encodings and non-canonical strings throw. */
export function xrplAccountId(addr: string): Uint8Array {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) {
    if (/^[XT][1-9A-HJ-NP-Za-km-z]{46}$/.test(addr)) throw new Error('X-addresses are not supported: use the classic r… address and enter the destination tag separately');
    throw new Error('invalid XRP Ledger address');
  }
  let raw: Uint8Array;
  try { raw = base58xrp.decode(addr); } catch { throw new Error('invalid XRP Ledger address'); }
  if (raw.length !== 25 || raw[0] !== 0x00) throw new Error('invalid XRP Ledger address');
  const sum = sha256(sha256(raw.subarray(0, 21)));
  for (let k = 0; k < 4; k++) if (raw[21 + k] !== sum[k]) throw new Error('bad XRP Ledger address checksum');
  if (base58xrp.encode(raw) !== addr) throw new Error('non-canonical XRP Ledger address');
  return raw.slice(1, 21);
}
function encodeAccountId(id: Uint8Array): string {
  const body = cat([0x00], id);
  return base58xrp.encode(cat(body, sha256(sha256(body)).subarray(0, 4)));
}
export function xrplAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 33 || (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) throw new Error('expected a 33-byte compressed secp256k1 public key');
  secp256k1.Point.fromBytes(publicKey); // throws when the point is not on the curve
  return encodeAccountId(ripemd160(sha256(publicKey)));
}

interface Payment { account: Uint8Array; destination: Uint8Array; amount: bigint; fee: bigint; sequence: number; lastLedgerSequence: number; destinationTag: number | undefined }

/**
 * Canonical serialization: fields ordered by (type code, field code).
 * TransactionType(1,2) Flags(2,2) Sequence(2,4) DestinationTag(2,14) LastLedgerSequence(2,27) Amount(6,1) Fee(6,8)
 * SigningPubKey(7,3) TxnSignature(7,4) Account(8,1) Destination(8,3).
 */
function serialize(p: Payment, signingPubKey: Uint8Array, signature?: Uint8Array): Uint8Array {
  return cat(
    [0x12, 0x00, 0x00], // TransactionType = Payment
    [0x22], u32(XRPL_TF_FULLY_CANONICAL_SIG),
    [0x24], u32(p.sequence),
    p.destinationTag === undefined ? [] : cat([0x2e], u32(p.destinationTag)),
    [0x20, 0x1b], u32(p.lastLedgerSequence),
    [0x61], drops(p.amount),
    [0x68], drops(p.fee),
    [0x73], vl(signingPubKey),
    signature ? cat([0x74], vl(signature)) : [],
    [0x81, 0x14], p.account,
    [0x83, 0x14], p.destination,
  );
}

/** Everything the signer accepts, checked against the intent alone. */
function paymentOf(i: Intent, net: NetworkDef): Payment {
  if (net.family !== 'xrpl' || i.network !== net.id) throw new Error('intent is not for this XRP Ledger network');
  if (i.chainRef !== net.chainRef) throw new Error('wrong chain: ledger identity mismatch');
  if (i.evm || i.btc || i.sol) throw new Error('foreign chain section in an XRP Ledger intent');
  if (i.asset !== 'native' || i.symbol !== net.native.symbol || i.decimals !== net.native.decimals) throw new Error('only native XRP can be sent on the XRP Ledger');
  const x = i.x;
  if (!x) throw new Error('missing XRP Ledger parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing XRP Ledger parameters');
  const sequence = uint32(x.sequence, 'sequence'), lastLedgerSequence = uint32(x.lastLedgerSequence, 'lastLedgerSequence');
  if (sequence < 1) throw new Error('invalid sequence');
  if (lastLedgerSequence < 1) throw new Error('invalid lastLedgerSequence');
  const fee = baseUnits(x.fee!), amount = baseUnits(i.amount), maxFee = baseUnits(i.maxFee);
  if (fee <= 0n) throw new Error('fee must be positive');
  if (fee > maxFee) throw new Error('fee above the approved maximum');
  if (fee > XRPL_MAX_FEE_DROPS) throw new Error('fee above the absolute XRP Ledger limit of this wallet');
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > MAX_DROPS) throw new Error('amount out of range');
  const account = xrplAccountId(i.from), destination = xrplAccountId(i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  if (destination.every((b) => b === 0) || (destination.subarray(0, 19).every((b) => b === 0) && destination[19] === 1)) throw new Error('destination is a black-hole address');
  const destinationTag = i.memo === undefined ? undefined : uint32(i.memo, 'destination tag');
  return { account, destination, amount, fee, sequence, lastLedgerSequence, destinationTag };
}

function describe(i: Intent, p: Payment): Record<string, string> {
  return { type: 'Payment', from: i.from, to: i.to, amountDrops: p.amount.toString(), feeDrops: p.fee.toString(), sequence: String(p.sequence),
    lastLedgerSequence: String(p.lastLedgerSequence), destinationTag: p.destinationTag === undefined ? '' : String(p.destinationTag),
    flags: '0x' + XRPL_TF_FULLY_CANONICAL_SIG.toString(16) };
}

/** `aux` may only carry the wallet's public key, and only if it hashes to the intent's source address. */
function auxKey(i: Intent, aux?: Record<string, unknown>): Uint8Array | undefined {
  if (!aux) return undefined;
  const keys = Object.keys(aux);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== 'signingPubKey' || typeof aux.signingPubKey !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(aux.signingPubKey)) throw new Error('unknown helper data for an XRP Ledger transfer');
  const pk = hexToBytes(aux.signingPubKey);
  if (xrplAddressFromPublicKey(pk) !== i.from) throw new Error('public key does not match the source address');
  return pk;
}

/** The exact bytes hashed for signing: "STX\0" + the transaction without TxnSignature. */
export function xrplSigningBytes(i: Intent, net: NetworkDef, publicKey: Uint8Array): Uint8Array {
  const p = paymentOf(i, net);
  if (xrplAddressFromPublicKey(publicKey) !== i.from) throw new Error('public key does not match the source address');
  return cat(PREFIX_SIGN, serialize(p, publicKey));
}

/** Transaction id of a signed blob (hex): SHA-512Half("TXN\0" + blob), upper-case hex as the ledger prints it. */
export function xrplTxid(signedBlobHex: string): string {
  if (!/^([0-9a-fA-F]{2})+$/.test(signedBlobHex)) throw new Error('invalid transaction blob');
  return hexUp(sha512Half(cat(PREFIX_TXID, hexToBytes(signedBlobHex))));
}

export const xrplPlugin: FamilyPlugin = {
  family: 'xrpl',
  curve: 'secp256k1',
  path(net) {
    if (net.family !== 'xrpl' || net.coinType === undefined) throw new Error('not an XRP Ledger network');
    return `m/44'/${net.coinType}'/0'/0/0`;
  },
  address(net, publicKey) {
    if (net.family !== 'xrpl') throw new Error('not an XRP Ledger network');
    return xrplAddressFromPublicKey(publicKey);
  },
  normalizeAddress(net, addr) {
    if (net.family !== 'xrpl') throw new Error('not an XRP Ledger network');
    xrplAccountId(addr);
    return addr;
  },
  /**
   * The signing bytes contain SigningPubKey, which this method is not given: `from` (its hash) commits to it instead.
   * With `aux.signingPubKey` (verified against `from`) the result is the exact signing pre-image; without it, the same
   * pre-image with an empty SigningPubKey (the form the ledger's `simulate` accepts). sign() always uses the real key
   * and refuses a key that does not hash to `from`.
   */
  build(i, net, aux) {
    const p = paymentOf(i, net);
    const pk = auxKey(i, aux);
    return { signDocs: [cat(PREFIX_SIGN, serialize(p, pk ?? new Uint8Array(0)))], describe: { ...describe(i, p), signingPubKey: pk ? hexUp(pk) : '' } };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle, aux?: Record<string, unknown>): Signed {
    const p = paymentOf(i, net);
    auxKey(i, aux);
    if (key.curve !== 'secp256k1' || !key.signDigest) throw new Error('XRP Ledger signing needs a secp256k1 key');
    if (xrplAddressFromPublicKey(key.publicKey) !== i.from) throw new Error('source address is not controlled by this key');
    const digest = sha512Half(cat(PREFIX_SIGN, serialize(p, key.publicKey)));
    const sig = key.signDigest(digest);
    // never release a signature that the network would not accept: it must verify and be in low-S (canonical) form
    if (!secp256k1.verify(sig.compact, digest, key.publicKey, { prehash: false, lowS: true })) throw new Error('signature self-check failed');
    if (hexUp(secp256k1.Signature.fromBytes(sig.compact, 'compact').toBytes('der')) !== hexUp(sig.der)) throw new Error('signature encoding self-check failed');
    const raw = hexUp(serialize(p, key.publicKey, sig.der));
    return { raw, txid: xrplTxid(raw) };
  },
};

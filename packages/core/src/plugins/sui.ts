// Sui (family "sui"): native SUI only, one fixed transaction shape.
// Pure module: no network access, no side effects. The BCS `TransactionData` (V1) is written by hand from the approved intent
// and proven byte-for-byte against @mysten/sui in test/sui.test.ts.
//
// The only transaction this module can produce is the standard "pay SUI" programmable transaction:
//   inputs   [ Pure(u64 amount), Pure(address recipient) ]
//   commands [ SplitCoins(GasCoin, [Input 0]), TransferObjects([NestedResult(0, 0)], Input 1) ]
// paid by the sender's own SUI coins (they are merged into the gas coin by the protocol, the amount is split from it).
//
// References: sui-types `TransactionData` / `ProgrammableTransaction` (crates/sui-types/src/transaction.rs), intent signing
// (crates/shared-crypto/src/intent.rs), address and signature formats (docs.sui.io "Signatures", "Cryptography").
// Intent parameters (x), all required, nothing else accepted:
//   payment     the gas payment coins, "objectId:version:digest" joined by ","  (1..SUI_MAX_GAS_COINS, 0x-hex id, decimal
//               version, base58 digest) — exact object references: the transaction is void once any of them has changed
//   gasPrice    price per gas unit in MIST (the epoch's reference gas price), decimal u64
//   gasBudget   the most the transaction may charge, in MIST, decimal u64, <= intent.maxFee
//   expiration  last epoch in which the transaction may execute (TransactionExpiration::Epoch), decimal u64
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { base58 } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** Digest of the mainnet genesis checkpoint (checkpoint 0). Its first four bytes, in hex, are the "chain identifier" 35834a8a. */
export const SUI_MAINNET_GENESIS = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';
/** most coins this wallet puts in one gas payment (the protocol allows 256) */
export const SUI_MAX_GAS_COINS = 32;
/** protocol ceiling for a gas budget (max_tx_gas), in MIST: 50 SUI */
export const SUI_MAX_GAS_BUDGET = 50_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const X_KEYS = ['expiration', 'gasBudget', 'gasPrice', 'payment'];
const enc = new TextEncoder();

const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error('invalid base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
function concat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
}
const blake2b256 = (m: Uint8Array) => blake2b(m, { dkLen: 32 });

/** Canonical Sui address / object id: "0x" + 64 lowercase hex digits. Returns its 32 bytes; throws on anything else. */
export function suiAddressBytes(addr: string): Uint8Array {
  if (typeof addr !== 'string' || !/^0x[0-9a-f]{64}$/.test(addr)) throw new Error('invalid Sui address: expected 0x followed by 64 lowercase hex digits');
  const out = new Uint8Array(32);
  for (let k = 0; k < 32; k++) out[k] = parseInt(addr.slice(2 + 2 * k, 4 + 2 * k), 16);
  return out;
}
/** Address of an ed25519 public key: blake2b-256(0x00 || key), the flag byte 0x00 naming the ed25519 scheme. */
export function suiAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return '0x' + hexOf(blake2b256(concat(new Uint8Array([0x00]), publicKey)));
}
/**
 * A destination this wallet accepts: a full 32-byte address. Short forms ("0x2") are refused rather than padded, and so are the
 * addresses below 2^16, which the protocol reserves for its own packages and system objects (0x1, 0x2, 0x5, 0x6, …): coins sent
 * there cannot be recovered.
 */
function checkDestination(addr: string): Uint8Array {
  const b = suiAddressBytes(addr);
  if (b.subarray(0, 30).every((v) => v === 0)) throw new Error('reserved Sui address (zero address or system object)');
  return b;
}

export interface SuiObjectRef { objectId: string; version: bigint; digest: string }
const canonicalU64 = (name: string, s: string | undefined, min: bigint): bigint => {
  if (s === undefined || !/^(0|[1-9]\d{0,19})$/.test(s)) throw new Error(`${name} must be a canonical decimal integer`);
  const v = BigInt(s);
  if (v < min || v > U64_MAX) throw new Error(`${name} out of range`);
  return v;
};
function digestBytes(d: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d)) throw new Error('invalid object digest');
  let raw: Uint8Array;
  try { raw = base58.decode(d); } catch { throw new Error('invalid object digest'); }
  if (raw.length !== 32 || base58.encode(raw) !== d) throw new Error('invalid object digest');
  return raw;
}
/** Parse x.payment. Strict: canonical ids, versions and digests, no duplicates, 1..SUI_MAX_GAS_COINS entries. */
export function suiParsePayment(s: string | undefined): SuiObjectRef[] {
  if (typeof s !== 'string' || s.length === 0) throw new Error('x.payment is missing');
  const parts = s.split(',');
  if (parts.length > SUI_MAX_GAS_COINS) throw new Error('too many gas payment coins');
  const seen = new Set<string>();
  return parts.map((p) => {
    const f = p.split(':');
    if (f.length !== 3) throw new Error('x.payment entries must be objectId:version:digest');
    suiAddressBytes(f[0]!);
    digestBytes(f[2]!);
    if (seen.has(f[0]!)) throw new Error('duplicate gas payment coin');
    seen.add(f[0]!);
    return { objectId: f[0]!, version: canonicalU64('x.payment version', f[1], 1n), digest: f[2]! };
  });
}
export const suiFormatPayment = (refs: SuiObjectRef[]): string => refs.map((r) => `${r.objectId}:${r.version}:${r.digest}`).join(',');

// ---- BCS writer (little-endian integers, ULEB128 lengths) ----
const u64le = (v: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const uleb = (n: number): Uint8Array => { const out: number[] = []; do { const b = n & 0x7f; n >>>= 7; out.push(n ? b | 0x80 : b); } while (n); return Uint8Array.from(out); };

export interface SuiBuilt {
  /** BCS TransactionData: the bytes a node executes and the bytes the signature commits to */
  tx: Uint8Array;
  /** blake2b-256(intent prefix [0, 0, 0] || tx): the 32 bytes ed25519 signs */
  signingDigest: Uint8Array;
  /** transaction digest (base58): the transaction id */
  txid: string;
  describe: Record<string, string>;
}

/** Transaction digest of BCS TransactionData bytes: base58(blake2b-256("TransactionData::" || tx)). */
export const suiTxDigest = (tx: Uint8Array): string => base58.encode(blake2b256(concat(enc.encode('TransactionData::'), tx)));

/** Rebuild the exact TransactionData from the intent alone. Throws on anything that is not a plain SUI payment. */
export function buildSuiTx(i: Intent, net: NetworkDef): SuiBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'sui' || i.network !== net.id) throw new Error('not a Sui intent');
  if (net.chainRef !== SUI_MAINNET_GENESIS) throw new Error('unknown Sui network: only mainnet is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (genesis checkpoint digest)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in a Sui intent');
  if (i.memo !== undefined) throw new Error('Sui transfers do not carry a memo');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native SUI can be sent on Sui in this version');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 9) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing Sui parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing Sui parameter (expected expiration, gasBudget, gasPrice, payment)');

  const sender = suiAddressBytes(i.from), recipient = checkDestination(i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > U64_MAX) throw new Error('amount out of range');

  const gasPrice = canonicalU64('x.gasPrice', x.gasPrice, 1n);
  const gasBudget = canonicalU64('x.gasBudget', x.gasBudget, 1n);
  if (gasBudget > baseUnits(i.maxFee)) throw new Error('fee above approved maximum');
  if (gasBudget > SUI_MAX_GAS_BUDGET) throw new Error('gas budget above the protocol maximum');
  if (gasBudget < gasPrice) throw new Error('gas budget below the price of one gas unit');
  const expiration = canonicalU64('x.expiration', x.expiration, 0n);
  const payment = suiParsePayment(x.payment);
  if (payment.some((p) => p.objectId === i.to || p.objectId === i.from)) throw new Error('a gas payment coin cannot be the sender or the destination');

  const tx = concat(
    Uint8Array.of(0x00), // TransactionData::V1
    Uint8Array.of(0x00), // TransactionKind::ProgrammableTransaction
    uleb(2), // inputs
    Uint8Array.of(0x00), uleb(8), u64le(amount), // CallArg::Pure(bcs(u64 amount))
    Uint8Array.of(0x00), uleb(32), recipient, // CallArg::Pure(bcs(address recipient))
    uleb(2), // commands
    Uint8Array.of(0x02, 0x00), uleb(1), Uint8Array.of(0x01, 0x00, 0x00), // SplitCoins(GasCoin, [Input(0)])
    Uint8Array.of(0x01), uleb(1), Uint8Array.of(0x03, 0x00, 0x00, 0x00, 0x00), Uint8Array.of(0x01, 0x01, 0x00), // TransferObjects([NestedResult(0, 0)], Input(1))
    sender,
    uleb(payment.length), ...payment.flatMap((p) => [suiAddressBytes(p.objectId), u64le(p.version), uleb(32), digestBytes(p.digest)]), // GasData.payment
    sender, // GasData.owner: the sender pays its own gas (no sponsor)
    u64le(gasPrice), u64le(gasBudget),
    Uint8Array.of(0x01), u64le(expiration), // TransactionExpiration::Epoch
  );
  const signingDigest = blake2b256(concat(Uint8Array.of(0, 0, 0), tx)); // Intent { scope: TransactionData, version: V0, app: Sui }
  const txid = suiTxDigest(tx);
  return {
    tx, signingDigest, txid,
    describe: {
      network: net.name, operation: 'Pay SUI (split from the gas coin, transfer to the recipient)', from: i.from, to: i.to, amountMist: amount.toString(),
      gasBudgetMist: gasBudget.toString(), gasPriceMist: gasPrice.toString(), gasCoins: String(payment.length), expirationEpoch: expiration.toString(), txid,
    },
  };
}

/** Serialized signature: flag 0x00 (ed25519) || 64-byte signature || 32-byte public key. */
export function suiSerializeSignature(signature: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (signature.length !== 64 || publicKey.length !== 32) throw new Error('bad signature or key length');
  return concat(Uint8Array.of(0x00), signature, publicKey);
}

/** Split the broadcast payload "base64(tx):base64(signature)" produced by sign(); checks the shape, never the content. */
export function suiParseRaw(raw: string): { tx: Uint8Array; signature: Uint8Array; txid: string } {
  const parts = typeof raw === 'string' ? raw.split(':') : [];
  if (parts.length !== 2) throw new Error('not a Sui signed transaction');
  const tx = unb64(parts[0]!), signature = unb64(parts[1]!);
  if (tx.length < 100 || signature.length !== 97 || signature[0] !== 0x00) throw new Error('not a Sui signed transaction');
  return { tx, signature, txid: suiTxDigest(tx) };
}

export const suiPlugin: FamilyPlugin = {
  family: 'sui',
  curve: 'ed25519',
  path(net: NetworkDef): string {
    if (net.coinType !== 784) throw new Error('Sui derivation requires coin type 784');
    return "m/44'/784'/0'/0'/0'";
  },
  address: (_net: NetworkDef, publicKey: Uint8Array) => suiAddressFromPublicKey(publicKey),
  normalizeAddress(_net: NetworkDef, addr: string): string {
    // no checksum on Sui: hex case carries no information, so upper case is accepted and lowered; nothing is padded
    if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(addr)) throw new Error('invalid Sui address: expected 0x followed by 64 hex digits');
    const a = addr.toLowerCase();
    checkDestination(a);
    return a;
  },
  build(i: Intent, net: NetworkDef) {
    const b = buildSuiTx(i, net);
    return { signDocs: [b.signingDigest], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const b = buildSuiTx(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage || key.publicKey.length !== 32) throw new Error('Sui needs an ed25519 key');
    if (suiAddressFromPublicKey(key.publicKey) !== i.from) throw new Error('signing key does not control the source address');
    const sig = key.signMessage(b.signingDigest);
    if (sig.length !== 64 || !ed25519.verify(sig, b.signingDigest, key.publicKey)) throw new Error('signature self-check failed');
    return { raw: `${b64(b.tx)}:${b64(suiSerializeSignature(sig, key.publicKey))}`, txid: b.txid };
  },
};

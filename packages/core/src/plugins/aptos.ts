// Aptos (family "aptos"): native APT only, one entry function: 0x1::aptos_account::transfer(address, u64).
// Pure module: no network access, no side effects. The BCS RawTransaction and SignedTransaction are written by hand from the
// approved intent and proven byte-for-byte against @aptos-labs/ts-sdk in test/aptos.test.ts.
//
// References: aptos-core types/src/transaction (RawTransaction, SignedTransaction, TransactionAuthenticator), the BCS
// specification, AIP-40 (address format), the Aptos derivation path m/44'/637'/account'/0'/index' (SLIP-0010 ed25519, as used
// by Petra and the official SDK). Intent parameters (x), all canonical decimal u64:
//   sequence_number            the sender's next sequence number
//   max_gas_amount             gas units the transaction may use
//   gas_unit_price             octas per gas unit; max_gas_amount × gas_unit_price <= intent.maxFee
//   expiration_timestamp_secs  the transaction can never be committed in a block at or after this time (unix seconds)
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** chain id of the Aptos main network: part of every signed transaction (testnet is 2) */
export const APTOS_MAINNET_CHAIN_ID = 1;
/** network minimum gas unit price in octas (gas schedule `min_price_per_gas_unit`) */
export const APTOS_MIN_GAS_UNIT_PRICE = 100n;
/** network maximum gas units per transaction (gas schedule `maximum_number_of_gas_units`) */
export const APTOS_MAX_GAS_AMOUNT = 2_000_000n;
/** longest validity window (expiration - createdAt) the signer accepts, in seconds */
export const APTOS_MAX_VALIDITY_SEC = 900;

const UINT64_MAX = (1n << 64n) - 1n;
const X_KEYS = ['expiration_timestamp_secs', 'gas_unit_price', 'max_gas_amount', 'sequence_number'];
const enc = new TextEncoder();
const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (p) => parseInt(p, 16));
function concat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
}

/** Legacy Ed25519 account address: authentication key = sha3-256(public key || 0x00 scheme byte); the address is that key. */
export function aptosAddressOf(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return '0x' + hexOf(sha3_256(concat(publicKey, new Uint8Array([0]))));
}

/**
 * Decode a canonical account address (AIP-40 long form): "0x" + exactly 64 lowercase hex digits.
 * Short forms, missing leading zeros, upper case and the reserved special addresses 0x0–0xf (framework accounts) are refused.
 */
export function aptosDecodeAddress(addr: string): Uint8Array {
  if (typeof addr !== 'string' || !/^0x[0-9a-f]{64}$/.test(addr)) throw new Error('invalid Aptos address: expected 0x followed by 64 lowercase hexadecimal characters');
  const raw = bytesOf(addr.slice(2));
  if (raw.subarray(0, 31).every((b) => b === 0) && raw[31]! < 0x10) throw new Error('reserved Aptos address (0x0–0xf): not a wallet');
  return raw;
}

/**
 * Address of the primary fungible store that holds `owner`'s APT (fungible asset metadata object 0xa):
 * sha3-256(owner || metadata address || 0xFC). Deposit events name this store, not the owner.
 */
export function aptosAptStore(owner: string): string {
  const meta = new Uint8Array(32); meta[31] = 0x0a;
  return '0x' + hexOf(sha3_256(concat(aptosDecodeAddress(owner), meta, new Uint8Array([0xfc]))));
}

// ---- BCS writer (little-endian integers, ULEB128 lengths and enum variants) ----
class Bcs {
  private parts: Uint8Array[] = [];
  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('u8 out of range');
    this.parts.push(new Uint8Array([n])); return this;
  }
  u64(v: bigint): this {
    if (v < 0n || v > UINT64_MAX) throw new Error('u64 out of range');
    const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.parts.push(b); return this;
  }
  uleb(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error('uleb128 out of range');
    const out: number[] = [];
    let v = n;
    do { const byte = v % 128; v = Math.floor(v / 128); out.push(v > 0 ? byte | 0x80 : byte); } while (v > 0);
    this.parts.push(Uint8Array.from(out)); return this;
  }
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len) throw new Error('bad fixed-size field length');
    this.parts.push(b); return this;
  }
  /** vector<u8> / string: ULEB128 length then the bytes */
  bytes(b: Uint8Array): this { this.uleb(b.length); this.parts.push(b); return this; }
  str(s: string): this { return this.bytes(enc.encode(s)); }
  done(): Uint8Array { return concat(...this.parts); }
}

const PAYLOAD_ENTRY_FUNCTION = 2, AUTHENTICATOR_ED25519 = 0, AUTHENTICATOR_SINGLE_SENDER = 4, ACCOUNT_AUTHENTICATOR_NONE = 4, TRANSACTION_USER = 0;
const FRAMEWORK = new Uint8Array(32); FRAMEWORK[31] = 1; // 0x1
const RAW_TX_PREFIX = sha3_256(enc.encode('APTOS::RawTransaction'));
const TX_PREFIX = sha3_256(enc.encode('APTOS::Transaction'));

const canonicalU64 = (name: string, s: string | undefined, min: bigint, max: bigint): bigint => {
  if (s === undefined || !/^(0|[1-9]\d{0,19})$/.test(s)) throw new Error(`x.${name} must be a canonical decimal integer`);
  const v = BigInt(s);
  if (v < min || v > max) throw new Error(`x.${name} out of range`);
  return v;
};

export interface AptosTransferFields { sender: Uint8Array; recipient: Uint8Array; amount: bigint; sequence: bigint; maxGas: bigint; gasPrice: bigint; expiration: bigint }
/**
 * BCS RawTransaction of `0x1::aptos_account::transfer(recipient, amount)` on the main network. The only transaction encoder of
 * this module: the signer reaches it through buildAptosTx (which validates the intent), the API uses it to simulate.
 */
export function aptosEncodeTransfer(f: AptosTransferFields): Uint8Array {
  return new Bcs()
    .fixed(f.sender, 32) // sender: AccountAddress
    .u64(f.sequence) // sequence_number
    .uleb(PAYLOAD_ENTRY_FUNCTION) // payload: TransactionPayload::EntryFunction
    .fixed(FRAMEWORK, 32).str('aptos_account') // module: ModuleId { address: 0x1, name }
    .str('transfer') // function
    .uleb(0) // ty_args: none
    .uleb(2) // args: two BCS-encoded values
    .bytes(new Bcs().fixed(f.recipient, 32).done()) // to: address
    .bytes(new Bcs().u64(f.amount).done()) // amount: u64
    .u64(f.maxGas).u64(f.gasPrice).u64(f.expiration)
    .u8(APTOS_MAINNET_CHAIN_ID) // chain_id
    .done();
}

export interface AptosBuilt {
  /** BCS RawTransaction */
  rawTx: Uint8Array;
  /** sha3-256("APTOS::RawTransaction") || rawTx: the message ed25519 signs */
  signingMessage: Uint8Array;
  /** largest fee the network can charge: max_gas_amount × gas_unit_price, in octas */
  maxFee: bigint;
  describe: Record<string, string>;
}

/** Rebuild the exact RawTransaction from the intent alone. Throws on anything that is not a plain APT transfer. */
export function buildAptosTx(i: Intent, net: NetworkDef): AptosBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'aptos' || i.network !== net.id) throw new Error('not an Aptos intent');
  if (net.chainRef !== String(APTOS_MAINNET_CHAIN_ID)) throw new Error('unknown Aptos network: only the main network (chain id 1) is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (chain id)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in an Aptos intent');
  if (i.memo !== undefined) throw new Error('Aptos transfers carry no memo');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native APT can be sent on Aptos');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 8) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing Aptos parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n]))
    throw new Error('unknown or missing Aptos parameter (expected expiration_timestamp_secs, gas_unit_price, max_gas_amount, sequence_number)');

  const sender = aptosDecodeAddress(i.from), recipient = aptosDecodeAddress(i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > UINT64_MAX) throw new Error('amount out of range');

  const sequence = canonicalU64('sequence_number', x.sequence_number, 0n, UINT64_MAX);
  const maxGas = canonicalU64('max_gas_amount', x.max_gas_amount, 1n, APTOS_MAX_GAS_AMOUNT);
  const gasPrice = canonicalU64('gas_unit_price', x.gas_unit_price, APTOS_MIN_GAS_UNIT_PRICE, UINT64_MAX);
  const maxFee = maxGas * gasPrice;
  if (maxFee > baseUnits(i.maxFee)) throw new Error('fee above approved maximum');
  const expiration = canonicalU64('expiration_timestamp_secs', x.expiration_timestamp_secs, 1n, UINT64_MAX);
  if (expiration <= BigInt(i.createdAt)) throw new Error('expiration is not after the intent creation time');
  if (expiration < BigInt(i.expiresAt)) throw new Error('expiration ends before the approval window');
  if (expiration > BigInt(i.createdAt) + BigInt(APTOS_MAX_VALIDITY_SEC)) throw new Error('expiration too far in the future');

  const rawTx = aptosEncodeTransfer({ sender, recipient, amount, sequence, maxGas, gasPrice, expiration });

  return {
    rawTx, signingMessage: concat(RAW_TX_PREFIX, rawTx), maxFee,
    describe: {
      network: net.name, operation: '0x1::aptos_account::transfer (native APT)', from: i.from, to: i.to, amountOctas: amount.toString(),
      sequenceNumber: sequence.toString(), maxGasAmount: maxGas.toString(), gasUnitPrice: gasPrice.toString(), maxFeeOctas: maxFee.toString(),
      expirationTimestampSecs: expiration.toString(), chainId: String(APTOS_MAINNET_CHAIN_ID), rawTransaction: '0x' + hexOf(rawTx),
    },
  };
}

/** BCS SignedTransaction: RawTransaction || TransactionAuthenticator::Ed25519 { public_key, signature }. */
export function aptosSignedTx(rawTx: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  if (publicKey.length !== 32 || signature.length !== 64) throw new Error('bad signature or key length');
  return concat(rawTx, new Bcs().uleb(AUTHENTICATOR_ED25519).bytes(publicKey).bytes(signature).done());
}

/** Transaction hash: sha3-256(sha3-256("APTOS::Transaction") || BCS(Transaction::UserTransaction(signed))), "0x" + hex. */
export function aptosTxid(signedTx: Uint8Array): string {
  return '0x' + hexOf(sha3_256(concat(TX_PREFIX, new Bcs().uleb(TRANSACTION_USER).done(), signedTx)));
}

/** Bytes of a broadcast payload produced by this module ("0x" + hex of the BCS SignedTransaction). */
export function aptosRawBytes(raw: string): Uint8Array {
  if (typeof raw !== 'string' || !/^0x([0-9a-f]{2}){150,400}$/.test(raw)) throw new Error('not an Aptos signed transaction');
  return bytesOf(raw.slice(2));
}

/**
 * Body for POST /v1/transactions/simulate: the exact RawTransaction with an authenticator that cannot be submitted.
 * With the sender's public key: the Ed25519 authenticator with an all-zero signature (the API refuses a valid one there).
 * Without it (the API server only knows the address): TransactionAuthenticator::SingleSender(NoAccountAuthenticator),
 * which the node accepts for simulation only and which skips the authentication-key check.
 */
export function aptosSimulationTx(rawTx: Uint8Array, publicKey?: Uint8Array): Uint8Array {
  if (publicKey) return aptosSignedTx(rawTx, publicKey, new Uint8Array(64));
  return concat(rawTx, new Bcs().uleb(AUTHENTICATOR_SINGLE_SENDER).uleb(ACCOUNT_AUTHENTICATOR_NONE).done());
}

export const aptosPlugin: FamilyPlugin = {
  family: 'aptos',
  curve: 'ed25519',
  path(net: NetworkDef): string {
    if (net.coinType !== 637) throw new Error('Aptos derivation requires coin type 637');
    return "m/44'/637'/0'/0'/0'";
  },
  address: (_net: NetworkDef, publicKey: Uint8Array) => aptosAddressOf(publicKey),
  normalizeAddress(_net: NetworkDef, addr: string): string {
    // hexadecimal is case-insensitive: accept upper case and return the canonical lower-case long form; never pad or guess
    if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(addr)) throw new Error('invalid Aptos address: expected 0x followed by 64 hexadecimal characters');
    const a = addr.toLowerCase();
    aptosDecodeAddress(a);
    return a;
  },
  build(i: Intent, net: NetworkDef) {
    const b = buildAptosTx(i, net);
    return { signDocs: [b.signingMessage], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const b = buildAptosTx(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage || key.publicKey.length !== 32) throw new Error('Aptos needs an ed25519 key');
    if (aptosAddressOf(key.publicKey) !== i.from) throw new Error('signing key does not control the source account');
    const sig = key.signMessage(b.signingMessage);
    if (sig.length !== 64 || !ed25519.verify(sig, b.signingMessage, key.publicKey)) throw new Error('signature self-check failed');
    const signed = aptosSignedTx(b.rawTx, key.publicKey, sig);
    return { raw: '0x' + hexOf(signed), txid: aptosTxid(signed) };
  },
};

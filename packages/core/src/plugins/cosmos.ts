// Cosmos SDK family: one native-coin bank MsgSend, signed in SIGN_MODE_DIRECT (no IBC, no staking, no other denom, no
// multi-message transactions, no fee payer / granter, no extension options).
// Pure module. The chain parameters (chain id = chainRef, bech32 prefix, fee/transfer denom) come from the network
// definition, so another Cosmos SDK chain is a registry entry; only Cosmos Hub is registered today.
// The protobuf below is the canonical (ADR-027) encoding of the five messages involved, written by hand (~40 lines) and
// proven byte-for-byte against @cosmjs/proto-signing + @cosmjs/stargate in packages/core/test/cosmos.test.ts; cosmjs is a
// test-only dependency, the signer's runtime stays on @noble / @scure.
//
// Intent parameters (`x`, all decimal strings, all required):
//   account_number  the account's number on this chain (part of the signed document)
//   sequence        the account's next sequence (replay protection)
//   gas_limit       gas the transaction may use
//   fee_amount      fee in base units of the native denom, paid in full whatever gas is used; must be <= intent.maxFee
//   timeout_height  last block height at which the transaction may be included (always set: an approval never stays valid forever)
// `memo` is free text (exchanges identify deposits by it); absent = empty memo.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

const X_KEYS = ['account_number', 'fee_amount', 'gas_limit', 'sequence', 'timeout_height'];
const UINT = /^(0|[1-9]\d{0,18})$/;
/** protobuf uint64 fields are kept below 2^63 so that every implementation (Go int64 included) reads the same number */
const INT64_MAX = (1n << 63n) - 1n;
/** Upper bound on gas_limit accepted by this builder: a plain send uses about 0.1 M gas; nothing legitimate needs more than this. */
export const COSMOS_MAX_GAS = 2_000_000n;
/** SDK default `max_memo_characters` (Cosmos Hub allows 512); counted in bytes, as the chain does. */
export const COSMOS_MAX_MEMO_BYTES = 256;
const MSG_SEND = '/cosmos.bank.v1beta1.MsgSend', PUBKEY = '/cosmos.crypto.secp256k1.PubKey';
/** ModeInfo { single { mode: SIGN_MODE_DIRECT (1) } } */
const MODE_DIRECT = Uint8Array.of(0x0a, 0x02, 0x08, 0x01);
const enc = new TextEncoder();

const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
function varint(v: bigint): number[] {
  if (v < 0n || v > INT64_MAX) throw new Error('integer out of range');
  const out: number[] = [];
  while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return out;
}
/** Length-delimited field (wire type 2). Always written, even when empty (callers omit default values themselves). */
const bytesField = (field: number, b: Uint8Array): Uint8Array => cat([(field << 3) | 2], varint(BigInt(b.length)), b);
const stringField = (field: number, s: string): Uint8Array => bytesField(field, enc.encode(s));
/** Varint field (wire type 0); proto3 omits the default value 0. */
const uintField = (field: number, v: bigint): Uint8Array => (v === 0n ? new Uint8Array(0) : cat([field << 3], varint(v)));
const coin = (denom: string, amount: bigint): Uint8Array => cat(stringField(1, denom), stringField(2, amount.toString()));
const any = (typeUrl: string, value: Uint8Array): Uint8Array => cat(stringField(1, typeUrl), bytesField(2, value));

interface Params { chainId: string; prefix: string; denom: string }
function paramsOf(net: NetworkDef): Params {
  const c = net.cosmos;
  if (net.family !== 'cosmos' || !c) throw new Error('not a Cosmos SDK network');
  if (!/^[a-z][a-z0-9]{0,19}$/.test(c.bech32) || !/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(c.denom) || !/^[a-z0-9][a-z0-9._-]{2,49}$/.test(net.chainRef)) throw new Error('invalid Cosmos SDK network definition');
  return { chainId: net.chainRef, prefix: c.bech32, denom: c.denom };
}

/**
 * 20-byte account id of a bech32 address with this prefix. Only the canonical lower-case form is accepted; other prefixes
 * (another chain's address, validator `…valoper` addresses), bech32m, bad checksums and 32-byte (module / interchain
 * account) addresses throw.
 */
export function cosmosAddressBytes(prefix: string, addr: string): Uint8Array {
  if (typeof addr !== 'string' || !addr.startsWith(prefix + '1') || !/^[a-z0-9]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/.test(addr)) throw new Error(`invalid address: expected a ${prefix}1… account address`);
  let d: { prefix: string; bytes: Uint8Array };
  try { d = bech32.decodeToBytes(addr); } catch { throw new Error('invalid address: bad bech32 checksum'); }
  if (d.prefix !== prefix || d.bytes.length !== 20) throw new Error(`invalid address: expected a ${prefix}1… account address`);
  if (bech32.encode(prefix, bech32.toWords(d.bytes)) !== addr) throw new Error('non-canonical address');
  return d.bytes;
}
export function cosmosAddressFromPublicKey(prefix: string, publicKey: Uint8Array): string {
  if (publicKey.length !== 33 || (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) throw new Error('expected a 33-byte compressed secp256k1 public key');
  secp256k1.Point.fromBytes(publicKey); // throws when the point is not on the curve
  return bech32.encode(prefix, bech32.toWords(ripemd160(sha256(publicKey))));
}

/**
 * The single memo rule, used by the API and re-checked by the signer. The memo is sent exactly as approved, so anything
 * that would silently differ from what an exchange expects is refused instead: empty text, surrounding white space,
 * control characters, ill-formed Unicode, more than 256 bytes.
 */
export function cosmosMemo(memo: string | undefined): string {
  if (memo === undefined) return '';
  if (memo.length === 0) throw new Error('empty memo');
  const bytes = enc.encode(memo);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== memo) throw new Error('memo is not valid Unicode text');
  if (memo !== memo.trim()) throw new Error('memo starts or ends with white space');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(memo)) throw new Error('memo contains control characters');
  if (bytes.length > COSMOS_MAX_MEMO_BYTES) throw new Error(`memo too long: at most ${COSMOS_MAX_MEMO_BYTES} bytes`);
  return memo;
}

function uint(s: string | undefined, what: string): bigint {
  if (s === undefined || !UINT.test(s)) throw new Error(`invalid ${what}`);
  const v = BigInt(s);
  if (v > INT64_MAX) throw new Error(`${what} out of range`);
  return v;
}

interface Transfer extends Params { from: string; to: string; amount: bigint; memo: string; accountNumber: bigint; sequence: bigint; gasLimit: bigint; fee: bigint; timeoutHeight: bigint }

/** Everything the signer accepts, checked against the intent alone. */
function transferOf(i: Intent, net: NetworkDef): Transfer {
  const p = paramsOf(net);
  if (i.network !== net.id) throw new Error('intent is not for this network');
  if (i.chainRef !== net.chainRef) throw new Error('wrong chain: chain id mismatch');
  if (i.evm || i.btc || i.sol) throw new Error('foreign chain section in a Cosmos intent');
  if (i.asset !== 'native' || i.symbol !== net.native.symbol || i.decimals !== net.native.decimals) throw new Error(`only native ${net.native.symbol} can be sent on ${net.name}`);
  const x = i.x;
  if (!x) throw new Error('missing Cosmos parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing Cosmos parameters (expected account_number, fee_amount, gas_limit, sequence, timeout_height)');
  const accountNumber = uint(x.account_number, 'account_number'), sequence = uint(x.sequence, 'sequence');
  const gasLimit = uint(x.gas_limit, 'gas_limit'), timeoutHeight = uint(x.timeout_height, 'timeout_height');
  if (gasLimit < 1n || gasLimit > COSMOS_MAX_GAS) throw new Error('gas_limit out of range');
  if (timeoutHeight < 1n) throw new Error('timeout_height is required');
  const fee = uint(x.fee_amount, 'fee_amount'), amount = baseUnits(i.amount), maxFee = baseUnits(i.maxFee);
  if (fee <= 0n) throw new Error('fee must be positive');
  if (fee > maxFee) throw new Error('fee above the approved maximum');
  if (amount <= 0n) throw new Error('amount must be positive');
  cosmosAddressBytes(p.prefix, i.from);
  cosmosAddressBytes(p.prefix, i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  return { ...p, from: i.from, to: i.to, amount, memo: cosmosMemo(i.memo), accountNumber, sequence, gasLimit, fee, timeoutHeight };
}

/** TxBody { messages: [Any(MsgSend { from_address, to_address, amount: [Coin] })], memo, timeout_height } */
function txBody(t: Transfer): Uint8Array {
  const msg = cat(stringField(1, t.from), stringField(2, t.to), bytesField(3, coin(t.denom, t.amount)));
  return cat(bytesField(1, any(MSG_SEND, msg)), t.memo === '' ? [] : stringField(2, t.memo), uintField(3, t.timeoutHeight));
}
/** AuthInfo { signer_infos: [SignerInfo { public_key: Any(PubKey { key }), mode_info: DIRECT, sequence }], fee: Fee { amount: [Coin], gas_limit } } */
function authInfo(t: Transfer, publicKey: Uint8Array | undefined): Uint8Array {
  const signer = cat(publicKey ? bytesField(1, any(PUBKEY, bytesField(1, publicKey))) : [], bytesField(2, MODE_DIRECT), uintField(3, t.sequence));
  return cat(bytesField(1, signer), bytesField(2, cat(bytesField(1, coin(t.denom, t.fee)), uintField(2, t.gasLimit))));
}
/** SignDoc { body_bytes, auth_info_bytes, chain_id, account_number }: the bytes whose SHA-256 is signed. */
const signDoc = (t: Transfer, body: Uint8Array, auth: Uint8Array): Uint8Array => cat(bytesField(1, body), bytesField(2, auth), stringField(3, t.chainId), uintField(4, t.accountNumber));
/** TxRaw { body_bytes, auth_info_bytes, signatures: [sig] } */
const txRaw = (body: Uint8Array, auth: Uint8Array, signature: Uint8Array): Uint8Array => cat(bytesField(1, body), bytesField(2, auth), bytesField(3, signature));

function describe(t: Transfer): Record<string, string> {
  return { type: 'MsgSend', chainId: t.chainId, from: t.from, to: t.to, amount: t.amount.toString(), denom: t.denom, fee: t.fee.toString(), gasLimit: t.gasLimit.toString(),
    accountNumber: t.accountNumber.toString(), sequence: t.sequence.toString(), timeoutHeight: t.timeoutHeight.toString(), memo: t.memo, signMode: 'SIGN_MODE_DIRECT' };
}

/** `aux` may only carry the wallet's public key, and only if it hashes to the intent's source address. */
function auxKey(t: Transfer, aux?: Record<string, unknown>): Uint8Array | undefined {
  if (!aux) return undefined;
  const keys = Object.keys(aux);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== 'publicKey' || typeof aux.publicKey !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(aux.publicKey)) throw new Error('unknown helper data for a Cosmos transfer');
  const pk = hexToBytes(aux.publicKey);
  if (cosmosAddressFromPublicKey(t.prefix, pk) !== t.from) throw new Error('public key does not match the source address');
  return pk;
}

/** The exact SignDoc bytes for this intent and key (their SHA-256 is what gets signed). Refuses a key that is not `from`. */
export function cosmosSignDoc(i: Intent, net: NetworkDef, publicKey: Uint8Array): Uint8Array {
  const t = transferOf(i, net);
  if (cosmosAddressFromPublicKey(t.prefix, publicKey) !== t.from) throw new Error('public key does not match the source address');
  return signDoc(t, txBody(t), authInfo(t, publicKey));
}

/**
 * Base64 TxRaw of the same transfer with no public key and an empty signature: the form `/cosmos/tx/v1beta1/simulate`
 * accepts. It can never be broadcast successfully (no signature). Goes through the same checks as build().
 */
export function cosmosSimulationTx(i: Intent, net: NetworkDef): string {
  const t = transferOf(i, net);
  return Buffer.from(txRaw(txBody(t), authInfo(t, undefined), new Uint8Array(0))).toString('base64');
}

/** Transaction hash of a broadcast-ready payload (base64 TxRaw): SHA-256, upper-case hex as nodes and explorers print it. */
export function cosmosTxid(rawBase64: string): string {
  if (typeof rawBase64 !== 'string' || rawBase64.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(rawBase64)) throw new Error('invalid transaction payload');
  return bytesToHex(sha256(Uint8Array.from(Buffer.from(rawBase64, 'base64')))).toUpperCase();
}

export const cosmosPlugin: FamilyPlugin = {
  family: 'cosmos',
  curve: 'secp256k1',
  path(net) {
    paramsOf(net);
    if (net.coinType === undefined) throw new Error('not a Cosmos SDK network');
    return `m/44'/${net.coinType}'/0'/0/0`;
  },
  address(net, publicKey) { return cosmosAddressFromPublicKey(paramsOf(net).prefix, publicKey); },
  normalizeAddress(net, addr) {
    cosmosAddressBytes(paramsOf(net).prefix, addr);
    return addr;
  },
  /**
   * AuthInfo (and therefore the SignDoc) contains the signer's public key, which this method is not given: `from` (its
   * hash) commits to it instead. With `aux.publicKey` (verified against `from`) the result is the exact SignDoc; without
   * it, the same SignDoc with the public key left out of SignerInfo. sign() always uses the real key and refuses a key
   * that does not hash to `from`.
   */
  build(i, net, aux) {
    const t = transferOf(i, net);
    const pk = auxKey(t, aux);
    return { signDocs: [signDoc(t, txBody(t), authInfo(t, pk))], describe: { ...describe(t), publicKey: pk ? bytesToHex(pk) : '' } };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle, aux?: Record<string, unknown>): Signed {
    const t = transferOf(i, net);
    auxKey(t, aux);
    if (key.curve !== 'secp256k1' || !key.signDigest) throw new Error('Cosmos signing needs a secp256k1 key');
    if (cosmosAddressFromPublicKey(t.prefix, key.publicKey) !== t.from) throw new Error('source address is not controlled by this key');
    const body = txBody(t), auth = authInfo(t, key.publicKey);
    const digest = sha256(signDoc(t, body, auth));
    const sig = key.signDigest(digest).compact;
    // never release a signature that the chain would not accept: 64 bytes r||s, low-S, verifying against the key
    if (sig.length !== 64 || !secp256k1.verify(sig, digest, key.publicKey, { prehash: false, lowS: true })) throw new Error('signature self-check failed');
    const raw = Buffer.from(txRaw(body, auth, sig)).toString('base64');
    return { raw, txid: cosmosTxid(raw) };
  },
};

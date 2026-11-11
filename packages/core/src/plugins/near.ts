// NEAR Protocol (family "near"): native NEAR only, one Transfer action per transaction.
// Pure module: no network access, no side effects. The borsh Transaction is written by hand from the approved intent and
// proven byte-for-byte against @near-js/transactions in test/near.test.ts.
//
// References: nearcore core/primitives/src/transaction.rs (Transaction V0, SignedTransaction, Action), near-account-id
// (account id rules), near-seed-phrase / NEAR wallets (SLIP-0010 ed25519, m/44'/397'/0').
// The wallet's account is the implicit account of its key: account id = lowercase hex of the 32-byte ed25519 public key.
//
// Intent parameters (x):
//   nonce      the transaction nonce (access key nonce + 1), canonical decimal uint64
//   blockHash  base58 hash of a recent final block. It is the only thing that binds the transaction to a chain (NEAR
//              transactions carry no chain id) and it bounds its validity (86 400 blocks after that block).
//
// Fee: a NEAR transaction does not state its fee; the protocol charges gas at the block's gas price. The price is clamped by
// nearcore to 20 × the minimum price (chain/chain/src/types.rs BlockEconomicsConfig::max_gas_price), so the worst case is
// known: nearFeeCeiling(to). build() refuses an intent whose maxFee is below that ceiling; the API verifies on both sources
// that the live protocol parameters stay within the constants below before it proposes anything.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** genesis block hash of NEAR mainnet (chain_id "mainnet"), as reported by every node in `status.genesis_hash` */
export const NEAR_MAINNET_GENESIS = 'EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H';
/** highest gas price the protocol allows, in yoctoNEAR per gas: 20 × 10^8 (nearcore BlockEconomicsConfig) */
export const NEAR_MAX_GAS_PRICE = 2_000_000_000n;
/** upper bounds on the gas of a transfer (send + execution). Protocol 88: 0.446 Tgas to a named account, 8.35 Tgas to an implicit one. */
export const NEAR_GAS_BOUND_NAMED = 1_000_000_000_000n, NEAR_GAS_BOUND_IMPLICIT = 10_000_000_000_000n;

const UINT64_MAX = (1n << 64n) - 1n, UINT128_MAX = (1n << 128n) - 1n;
const X_KEYS = ['blockHash', 'nonce'];
const enc = new TextEncoder();
const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

/** implicit account id of an ed25519 public key: its 32 bytes in lowercase hex */
export function nearImplicitAccount(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return hexOf(publicKey);
}

/**
 * Validate a NEAR account id and say what it is. Accepted: an implicit account (64 lowercase hex characters) or a named
 * account (2–64 characters; lowercase letters and digits in parts separated by single ".", "-" or "_"; near-account-id rules).
 * Refused: upper case, the reserved "system" account, and the other derived account kinds (Ethereum-style "0x…" and the
 * 42-character "0s…" / "0u…" forms): this wallet does not send to them.
 */
export function nearAccountKind(id: string): 'implicit' | 'named' {
  if (typeof id !== 'string') throw new Error('invalid NEAR account id');
  if (id.length < 2 || id.length > 64) throw new Error('invalid NEAR account id: it must be 2 to 64 characters long');
  let sep = true; // true at the start and right after a separator: an alphanumeric must follow
  for (let k = 0; k < id.length; k++) {
    const c = id.charCodeAt(k);
    const alnum = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
    if (alnum) { sep = false; continue; }
    if ((c === 0x2e || c === 0x2d || c === 0x5f) && !sep) { sep = true; continue; }
    if (c >= 0x41 && c <= 0x5a) throw new Error('invalid NEAR account id: upper-case letters are not allowed');
    throw new Error('invalid NEAR account id: only lowercase letters, digits and single ".", "-" or "_" separators are allowed');
  }
  if (sep) throw new Error('invalid NEAR account id: it cannot end with a separator');
  if (/^[0-9a-f]{64}$/.test(id)) return 'implicit';
  if (id === 'system') throw new Error('"system" is a reserved NEAR account');
  if (/^0[a-z][0-9a-f]{40}$/.test(id)) throw new Error('Ethereum-style and other derived NEAR accounts (0x…, 0s…, 0u…) are not supported');
  return 'named';
}

/** Worst-case network fee of a transfer to `to`, in yoctoNEAR: gas bound × highest gas price the protocol allows. */
export function nearFeeCeiling(to: string): bigint {
  return (nearAccountKind(to) === 'implicit' ? NEAR_GAS_BOUND_IMPLICIT : NEAR_GAS_BOUND_NAMED) * NEAR_MAX_GAS_PRICE;
}

/** Canonical base58 of exactly 32 bytes (a NEAR block or transaction hash). */
export function nearDecodeHash(s: string): Uint8Array {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error('invalid NEAR hash');
  let raw: Uint8Array;
  try { raw = base58.decode(s); } catch { throw new Error('invalid NEAR hash'); }
  if (raw.length !== 32 || base58.encode(raw) !== s) throw new Error('invalid NEAR hash');
  return raw;
}

// ---- borsh writer (little-endian) ----
function concat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
}
const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (v: bigint): Uint8Array => { if (v < 0n || v > UINT64_MAX) throw new Error('uint64 out of range'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const u128 = (v: bigint): Uint8Array => {
  if (v < 0n || v > UINT128_MAX) throw new Error('uint128 out of range');
  const b = new Uint8Array(16), d = new DataView(b.buffer);
  d.setBigUint64(0, v & UINT64_MAX, true); d.setBigUint64(8, v >> 64n, true);
  return b;
};
const str = (s: string): Uint8Array => { const b = enc.encode(s); return concat(u32(b.length), b); };
const KEY_TYPE_ED25519 = 0, ACTION_TRANSFER = 3;

export interface NearBuilt {
  /** borsh Transaction (V0) */
  tx: Uint8Array;
  /** sha256(tx): the 32 bytes ed25519 signs; its base58 form is the transaction hash */
  hash: Uint8Array;
  txid: string;
  describe: Record<string, string>;
}

/** Rebuild the exact borsh Transaction from the intent alone. Throws on anything that is not a plain NEAR transfer. */
export function buildNearTx(i: Intent, net: NetworkDef): NearBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'near' || i.network !== net.id) throw new Error('not a NEAR intent');
  if (net.chainRef !== NEAR_MAINNET_GENESIS) throw new Error('unknown NEAR network: only mainnet is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (genesis hash)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in a NEAR intent');
  if (i.memo !== undefined) throw new Error('NEAR transfers do not carry a memo');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native NEAR can be sent on NEAR');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 24) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing NEAR parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing NEAR parameter (expected blockHash, nonce)');

  if (nearAccountKind(i.from) !== 'implicit') throw new Error('source is not an implicit NEAR account');
  const publicKey = Uint8Array.from(i.from.match(/../g)!, (h) => parseInt(h, 16));
  const kind = nearAccountKind(i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > UINT128_MAX) throw new Error('amount out of range');
  const ceiling = nearFeeCeiling(i.to);
  if (ceiling > baseUnits(i.maxFee)) throw new Error('fee above approved maximum: the worst-case network fee exceeds maxFee');

  if (x.nonce === undefined || !/^[1-9]\d{0,19}$/.test(x.nonce)) throw new Error('x.nonce must be a canonical positive decimal integer');
  const nonce = BigInt(x.nonce);
  if (nonce > UINT64_MAX) throw new Error('x.nonce out of range');
  const blockHash = nearDecodeHash(x.blockHash ?? '');

  const tx = concat(
    str(i.from), // signer_id
    new Uint8Array([KEY_TYPE_ED25519]), publicKey, // public_key
    u64(nonce), // nonce
    str(i.to), // receiver_id
    blockHash, // block_hash
    u32(1), // actions: exactly one
    new Uint8Array([ACTION_TRANSFER]), u128(amount), // Transfer { deposit }
  );
  const hash = sha256(tx), txid = base58.encode(hash);
  return {
    tx, hash, txid,
    describe: {
      network: net.name, operation: kind === 'implicit' ? 'Transfer (native NEAR, to an implicit account)' : 'Transfer (native NEAR)', from: i.from, to: i.to,
      amountYocto: amount.toString(), nonce: nonce.toString(), blockHash: x.blockHash!, feeCeilingYocto: ceiling.toString(), txid,
    },
  };
}

/** borsh SignedTransaction: the transaction followed by its ed25519 signature */
export function nearSignedTx(tx: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('bad signature length');
  return concat(tx, new Uint8Array([KEY_TYPE_ED25519]), signature);
}

/**
 * Transaction hash (base58) and signer account of a base64 SignedTransaction produced by this module; used by the API to
 * track what it relays. Only the outer shape is checked here (the network verifies the rest).
 */
export function nearSignedTxInfo(rawBase64: string): { txid: string; signerId: string } {
  if (typeof rawBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawBase64)) throw new Error('not a NEAR signed transaction');
  const raw = Uint8Array.from(atob(rawBase64), (c) => c.charCodeAt(0));
  // shortest transaction this module writes: 4 + 64 (signer) + 33 (key) + 8 (nonce) + 4 + 2 (receiver) + 32 (block) + 4 + 17 (one transfer)
  if (raw.length < 168 + 65 || raw[raw.length - 65] !== KEY_TYPE_ED25519) throw new Error('not a NEAR signed transaction');
  if (new DataView(raw.buffer, raw.byteOffset).getUint32(0, true) !== 64) throw new Error('not a NEAR signed transaction');
  const signerId = String.fromCharCode(...raw.subarray(4, 68));
  if (nearAccountKind(signerId) !== 'implicit' || signerId !== hexOf(raw.subarray(69, 101)) || raw[68] !== KEY_TYPE_ED25519) throw new Error('not a NEAR signed transaction');
  return { txid: base58.encode(sha256(raw.subarray(0, raw.length - 65))), signerId };
}

export const nearPlugin: FamilyPlugin = {
  family: 'near',
  curve: 'ed25519',
  path(net: NetworkDef): string {
    if (net.coinType !== 397) throw new Error('NEAR derivation requires coin type 397');
    return "m/44'/397'/0'";
  },
  address: (_net: NetworkDef, publicKey: Uint8Array) => nearImplicitAccount(publicKey),
  normalizeAddress(_net: NetworkDef, addr: string): string {
    nearAccountKind(addr);
    return addr;
  },
  build(i: Intent, net: NetworkDef) {
    const b = buildNearTx(i, net);
    return { signDocs: [b.hash], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const b = buildNearTx(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage || key.publicKey.length !== 32) throw new Error('NEAR needs an ed25519 key');
    if (nearImplicitAccount(key.publicKey) !== i.from) throw new Error('signing key does not control the source account');
    const sig = key.signMessage(b.hash);
    if (sig.length !== 64 || !ed25519.verify(sig, b.hash, key.publicKey)) throw new Error('signature self-check failed');
    return { raw: btoa(String.fromCharCode(...nearSignedTx(b.tx, sig))), txid: b.txid };
  },
};

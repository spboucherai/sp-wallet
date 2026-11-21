/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/plugins/polkadot.ts
 * Module           : plugins
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Polkadot (family "polkadot"): native DOT on Polkadot Asset Hub, one fixed call: Balances.transfer_keep_alive.
// Pure module: no network access, no side effects. The SCALE encoding below is written by hand for exactly this extrinsic
// and proven against @polkadot/types (test-only devDependency) and against live nodes (scripts/smoke-polkadot.mts).
//
// WHERE DOT LIVES: since the Asset Hub migration (4 November 2025) account balances, transfers, staking and governance are
// on the system parachain "Polkadot Asset Hub" (para 1000), not on the relay chain; exchanges deposit and withdraw there.
// Verified on chain on 2026-11-11: total issuance 1 711 644 484 DOT on Asset Hub, 245 998 DOT left on the relay chain.
// See docs/chains/polkadot.md for the sources.
//
// The account is an ED25519 account derived with SLIP-0010 at m/44'/354'/0'/0'/0' (the derivation Trust Wallet uses).
// It is NOT the sr25519 account that Polkadot.js / Talisman / Nova derive from the same phrase: the address differs, the
// funds are recoverable from this wallet's seed and this path (docs/chains/polkadot.md).
//
// Extrinsic (version 4, signed):
//   compact(length) ‖ 0x84 ‖ MultiAddress::Id(0x00 ‖ account) ‖ MultiSignature::Ed25519(0x00 ‖ signature) ‖ extra ‖ call
//   call  = pallet 10 (Balances) ‖ call 3 (transfer_keep_alive) ‖ MultiAddress::Id(0x00 ‖ dest) ‖ Compact<u128>(value)
//   extra = Era (mortal, 2 bytes) ‖ Compact(nonce) ‖ Compact(tip = 0) ‖ Option<asset id> = None (0x00) ‖ CheckMetadataHash mode = Disabled (0x00)
//   signed payload = call ‖ extra ‖ spec_version u32 ‖ transaction_version u32 ‖ genesis hash ‖ era block hash ‖ Option<metadata hash> = None (0x00)
//   (hashed with blake2b-256 first when longer than 256 bytes — never the case here, the rule is implemented anyway).
// This layout is the one of the transaction extensions listed in POLKADOT_EXTENSIONS, in that order; the extensions that
// are not named above contribute no bytes. It was reviewed for the runtime described by POLKADOT_REVIEWED: the API reads
// the runtime version and the metadata from two nodes before every transfer and refuses to prepare when the spec name,
// the transaction version, the extension list (names, types, implicit types), the Balances pallet index or the
// transfer_keep_alive call index / arguments differ (services/api/src/chains/polkadot.ts); the signer refuses any
// transaction version other than the reviewed one. A runtime upgrade that changes any of these therefore stops sends
// until this file is reviewed again (procedure in docs/chains/polkadot.md).
//
// The fee is not a field of a Polkadot transaction: the chain computes it from the length and the weight of the call.
// The signer bounds it by fixing the call and a zero tip; the API checks the chain's own quote against intent.maxFee.
//
// Intent parameters (`x`, all required, nothing else accepted):
//   spec_version  runtime spec version (u32) the transaction is valid for; >= POLKADOT_REVIEWED.minSpecVersion
//   tx_version    runtime transaction version; must equal POLKADOT_REVIEWED.transactionVersion
//   nonce         account nonce (u32)
//   era_block     number of the finalized block the mortal era starts at
//   era_hash      hash of that block (0x + 64 hex)
//   era_period    validity window in blocks: a power of two between 16 and POLKADOT_MAX_ERA_PERIOD
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { base58 } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** Genesis hash of Polkadot Asset Hub (the `chainRef`), without 0x. */
export const POLKADOT_ASSET_HUB_GENESIS = '68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f';
export const POLKADOT_SS58_PREFIX = 0;
export const POLKADOT_MAX_ERA_PERIOD = 256;
/**
 * Transaction extensions of the reviewed runtime, in order: [identifier, explicit type, implicit type] as rendered by
 * `renderType` in services/api/src/chains/polkadot-metadata.ts. "()" = contributes no bytes.
 */
export const POLKADOT_EXTENSIONS: readonly (readonly [string, string, string])[] = [
  ['AuthorizeCall', '()', '()'],
  ['CheckNonZeroSender', '()', '()'],
  ['CheckSpecVersion', '()', 'u32'],
  ['CheckTxVersion', '()', 'u32'],
  ['CheckGenesis', '()', 'H256{[u8;32]}'],
  ['CheckMortality', 'CheckMortality{Era}', 'H256{[u8;32]}'],
  ['CheckNonce', 'CheckNonce{Compact<u32>}', '()'],
  ['CheckWeight', '()', '()'],
  ['ChargeAssetTxPayment', 'ChargeAssetTxPayment{tip:Compact<u128>,asset_id:Option<Location>}', '()'],
  ['PrevalidateAttests', '()', '()'],
  ['CheckMetadataHash', 'CheckMetadataHash{mode:Mode}', 'Option<[u8;32]>'],
  ['EthSetOrigin', '()', '()'],
  ['StorageWeightReclaim', '()', '()'],
];
/** What this file was reviewed against (Polkadot Asset Hub, 2026-11-11). */
export const POLKADOT_REVIEWED = {
  specName: 'statemint', minSpecVersion: 2005002, transactionVersion: 15, extrinsicVersion: 4,
  pallet: { name: 'Balances', index: 10 }, call: { name: 'transfer_keep_alive', index: 3, args: 'dest:MultiAddress,value:Compact<u128>' },
  /** the MultiAddress variant used for both the signer and the destination */
  multiAddressId: 0,
  /** MultiSignature::Ed25519 */
  signatureEd25519: 0,
} as const;
const X_KEYS = ['era_block', 'era_hash', 'era_period', 'nonce', 'spec_version', 'tx_version'];
const U32_MAX = 0xffffffffn, U128_MAX = (1n << 128n) - 1n;

const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => {
  if (typeof s !== 'string' || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(s.slice(2 * k, 2 * k + 2), 16);
  return out;
};
const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const blake2b256 = (m: Uint8Array) => blake2b(m, { dkLen: 32 });

// ---------------------------------------------------------------- SCALE, the subset an extrinsic uses
/** Compact<uN>: 1, 2 or 4 bytes for values below 2^6, 2^14, 2^30, otherwise a length byte and the little-endian value. */
export function scaleCompact(v: bigint): Uint8Array {
  if (v < 0n || v > U128_MAX) throw new Error('integer out of range');
  if (v < 1n << 6n) return Uint8Array.of(Number(v << 2n));
  if (v < 1n << 14n) { const n = Number((v << 2n) | 1n); return Uint8Array.of(n & 0xff, n >> 8); }
  if (v < 1n << 30n) { const n = Number((v << 2n) | 2n); return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); }
  const bytes: number[] = [];
  for (let r = v; r > 0n; r >>= 8n) bytes.push(Number(r & 0xffn));
  return Uint8Array.from([((bytes.length - 4) << 2) | 3, ...bytes]);
}
const u32le = (v: bigint): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v), true); return b; };

/** Strict SCALE reader: rejects non-minimal compact integers and reading past the end. */
export class ScaleReader {
  bytes: Uint8Array; o = 0;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  take(n: number): Uint8Array { if (n < 0 || this.o + n > this.bytes.length) throw new Error('truncated SCALE data'); const s = this.bytes.subarray(this.o, this.o + n); this.o += n; return s; }
  u8(): number { return this.take(1)[0]!; }
  uint(n: number): bigint { const b = this.take(n); let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[k]!); return v; }
  compact(): bigint {
    const b0 = this.u8(), mode = b0 & 3;
    if (mode === 0) return BigInt(b0 >> 2);
    if (mode === 1) { const v = BigInt((b0 | (this.u8() << 8)) >> 2); if (v < 1n << 6n) throw new Error('non-canonical compact integer'); return v; }
    if (mode === 2) { const r = this.take(3); const v = BigInt(((b0 | (r[0]! << 8) | (r[1]! << 16)) >>> 2) + r[2]! * 2 ** 22); if (v < 1n << 14n) throw new Error('non-canonical compact integer'); return v; }
    const n = (b0 >> 2) + 4;
    if (n > 16) throw new Error('compact integer too large');
    const v = this.uint(n);
    if (v < 1n << 30n || v >> BigInt(8 * (n - 1)) === 0n) throw new Error('non-canonical compact integer');
    return v;
  }
  get done(): boolean { return this.o === this.bytes.length; }
}

// ---------------------------------------------------------------- SS58 addresses
const SS58PRE = new TextEncoder().encode('SS58PRE');
/** SS58 address of a 32-byte account id for a one-byte prefix (0–63): base58(prefix ‖ account ‖ first 2 bytes of blake2b-512("SS58PRE" ‖ prefix ‖ account)). */
export function ss58Encode(prefix: number, account: Uint8Array): string {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 63) throw new Error('unsupported SS58 prefix');
  if (account.length !== 32) throw new Error('account id must be 32 bytes');
  const body = cat([prefix], account);
  return base58.encode(cat(body, blake2b(cat(SS58PRE, body), { dkLen: 64 }).subarray(0, 2)));
}
/**
 * The 32-byte account id of a Polkadot address. Strict: base58, 35 bytes, prefix 0 (Polkadot — Kusama, generic-Substrate
 * "5…" and every other network's form of the same key are refused), valid checksum, canonical encoding.
 */
export function polkadotAccountId(addr: string): Uint8Array {
  if (typeof addr !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{34,47}$/.test(addr)) throw new Error('invalid address: expected a Polkadot address (starts with 1)');
  let raw: Uint8Array;
  try { raw = base58.decode(addr); } catch { throw new Error('invalid address: not base58'); }
  if (raw.length !== 35 || raw[0] !== POLKADOT_SS58_PREFIX) throw new Error('invalid address: not a Polkadot (prefix 0) account address');
  const account = raw.slice(1, 33);
  if (ss58Encode(POLKADOT_SS58_PREFIX, account) !== addr) throw new Error('invalid address: bad checksum');
  return account;
}
export function polkadotAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  ed25519.Point.fromBytes(publicKey); // throws when the key is not a curve point
  return ss58Encode(POLKADOT_SS58_PREFIX, publicKey);
}
function checkDestination(addr: string): Uint8Array {
  const a = polkadotAccountId(addr);
  if (a.every((v) => v === 0)) throw new Error('the zero account cannot receive funds');
  return a;
}

// ---------------------------------------------------------------- the transfer
/** Mortal era: period (power of two) and the block it starts at. Two bytes, little-endian: (log2(period) − 1) | (phase << 4). */
export function polkadotEra(period: number, block: bigint): Uint8Array {
  if (!Number.isInteger(period) || period < 16 || period > POLKADOT_MAX_ERA_PERIOD || (period & (period - 1)) !== 0) throw new Error('era period must be a power of two between 16 and ' + POLKADOT_MAX_ERA_PERIOD);
  const phase = Number(block % BigInt(period)); // quantize factor is 1 for periods up to 4096
  const enc = (Math.log2(period) - 1) | (phase << 4);
  return Uint8Array.of(enc & 0xff, enc >> 8);
}
const canonical = (name: string, s: string | undefined, min: bigint, max: bigint): bigint => {
  if (s === undefined || !/^(0|[1-9]\d{0,38})$/.test(s)) throw new Error(`${name} must be a canonical decimal integer`);
  const v = BigInt(s);
  if (v < min || v > max) throw new Error(`${name} out of range`);
  return v;
};

export interface PolkadotBuilt {
  call: Uint8Array; extra: Uint8Array;
  /** call ‖ extra ‖ implicit: what the signature commits to */
  payload: Uint8Array;
  /** the bytes actually signed: the payload, or its blake2b-256 when it is longer than 256 bytes */
  signDoc: Uint8Array;
  amount: bigint; nonce: bigint; eraBlock: bigint; period: number;
  describe: Record<string, string>;
}

/** Rebuild the exact call, extension data and signing payload from the intent alone. Throws on anything else than a plain DOT transfer. */
export function buildPolkadotTx(i: Intent, net: NetworkDef): PolkadotBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'polkadot' || i.network !== net.id) throw new Error('not a Polkadot intent');
  if (net.chainRef !== POLKADOT_ASSET_HUB_GENESIS) throw new Error('unknown Polkadot network: only Polkadot Asset Hub is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (genesis hash)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in a Polkadot intent');
  if (i.memo !== undefined) throw new Error('Polkadot transfers do not carry a memo');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native DOT can be sent on Polkadot in this version');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 10) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing Polkadot parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing Polkadot parameter (expected era_block, era_hash, era_period, nonce, spec_version, tx_version)');

  polkadotAccountId(i.from);
  const dest = checkDestination(i.to);
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > U128_MAX) throw new Error('amount out of range');
  baseUnits(i.maxFee); // the fee is charged by the chain (see header); the ceiling is enforced by the policy and checked by the API against the chain's quote

  const specVersion = canonical('x.spec_version', x.spec_version, BigInt(POLKADOT_REVIEWED.minSpecVersion), U32_MAX);
  const txVersion = canonical('x.tx_version', x.tx_version, 0n, U32_MAX);
  if (txVersion !== BigInt(POLKADOT_REVIEWED.transactionVersion)) throw new Error(`transaction version ${txVersion} has not been reviewed (expected ${POLKADOT_REVIEWED.transactionVersion}): the runtime changed its transaction format`);
  const nonce = canonical('x.nonce', x.nonce, 0n, U32_MAX);
  const eraBlock = canonical('x.era_block', x.era_block, 1n, U32_MAX);
  const period = Number(canonical('x.era_period', x.era_period, 16n, BigInt(POLKADOT_MAX_ERA_PERIOD)));
  if (typeof x.era_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(x.era_hash)) throw new Error('x.era_hash must be 0x followed by 64 lowercase hex digits');
  const eraHash = unhex(x.era_hash.slice(2));
  if (eraHash.every((v) => v === 0)) throw new Error('x.era_hash is empty');

  const call = cat([POLKADOT_REVIEWED.pallet.index, POLKADOT_REVIEWED.call.index, POLKADOT_REVIEWED.multiAddressId], dest, scaleCompact(amount));
  const extra = cat(polkadotEra(period, eraBlock), scaleCompact(nonce), scaleCompact(0n) /* tip */, [0x00] /* fee asset: native */, [0x00] /* metadata hash: disabled */);
  const implicit = cat(u32le(specVersion), u32le(txVersion), unhex(POLKADOT_ASSET_HUB_GENESIS), eraHash, [0x00] /* no metadata hash */);
  const payload = cat(call, extra, implicit);
  const signDoc = payload.length > 256 ? blake2b256(payload) : payload;
  return {
    call, extra, payload, signDoc, amount, nonce, eraBlock, period,
    describe: {
      network: net.name, operation: 'Balances.transfer_keep_alive (the sender account is never reaped)', from: i.from, to: i.to, amountPlanck: amount.toString(),
      nonce: nonce.toString(), tip: '0', specVersion: specVersion.toString(), transactionVersion: txVersion.toString(),
      validFromBlock: eraBlock.toString(), validForBlocks: String(period), eraBlockHash: x.era_hash, call: '0x' + hexOf(call),
    },
  };
}

/** Signed extrinsic (version 4): compact(length) ‖ 0x84 ‖ Id(account) ‖ Ed25519(signature) ‖ extra ‖ call. */
export function polkadotExtrinsic(b: { call: Uint8Array; extra: Uint8Array }, publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  if (publicKey.length !== 32 || signature.length !== 64) throw new Error('bad signature or key length');
  const inner = cat([0x80 | POLKADOT_REVIEWED.extrinsicVersion, POLKADOT_REVIEWED.multiAddressId], publicKey, [POLKADOT_REVIEWED.signatureEd25519], signature, b.extra, b.call);
  return cat(scaleCompact(BigInt(inner.length)), inner);
}
/** Extrinsic hash (the transaction id): 0x + blake2b-256 of the encoded extrinsic, length prefix included. */
export const polkadotTxid = (extrinsic: Uint8Array): string => '0x' + hexOf(blake2b256(extrinsic));

export interface PolkadotDecoded {
  signer: Uint8Array; signatureType: number; signature: Uint8Array;
  era: { period: number; phase: number } | null; nonce: bigint; tip: bigint; mode: number;
  pallet: number; callIndex: number; dest: Uint8Array; value: bigint;
  /** the bytes of the call and of the extension data, as found */
  call: Uint8Array; extra: Uint8Array;
}
/**
 * Decode a signed version-4 extrinsic carrying a Balances transfer (`dest: MultiAddress::Id, value: Compact<u128>`) under
 * the reviewed extension layout. Strict: canonical integers, no fee asset, nothing after the call. Any signature scheme
 * is read (ed25519 0, sr25519 1, ecdsa 2) so that transfers made by other wallets can be decoded too.
 */
export function polkadotDecodeExtrinsic(bytes: Uint8Array): PolkadotDecoded {
  const outer = new ScaleReader(bytes);
  const len = outer.compact();
  if (BigInt(bytes.length - outer.o) !== len) throw new Error('extrinsic length prefix does not match');
  const r = new ScaleReader(bytes.subarray(outer.o));
  if (r.u8() !== (0x80 | POLKADOT_REVIEWED.extrinsicVersion)) throw new Error('not a signed version-4 extrinsic');
  if (r.u8() !== POLKADOT_REVIEWED.multiAddressId) throw new Error('signer is not an account id');
  const signer = r.take(32).slice();
  const signatureType = r.u8();
  if (signatureType > 2) throw new Error('unknown signature scheme');
  const signature = r.take(signatureType === 2 ? 65 : 64).slice();
  const extraStart = r.o;
  const e0 = r.u8();
  let era: PolkadotDecoded['era'] = null;
  if (e0 !== 0) { const enc = e0 | (r.u8() << 8); const period = 2 << (enc & 15); era = { period, phase: (enc >> 4) * Math.max(period >> 12, 1) }; }
  const nonce = r.compact(), tip = r.compact();
  if (r.u8() !== 0) throw new Error('fee paid in another asset: not supported');
  const mode = r.u8();
  if (mode > 1) throw new Error('bad metadata hash mode');
  const extra = bytes.subarray(outer.o + extraStart, outer.o + r.o).slice(), callStart = r.o;
  const pallet = r.u8(), callIndex = r.u8();
  if (r.u8() !== POLKADOT_REVIEWED.multiAddressId) throw new Error('destination is not an account id');
  const dest = r.take(32).slice(), value = r.compact();
  if (!r.done) throw new Error('unexpected bytes after the call');
  return { signer, signatureType, signature, era, nonce, tip, mode, pallet, callIndex, dest, value, call: bytes.subarray(outer.o + callStart).slice(), extra };
}

/** Parse the broadcast payload made by sign() ("0x" + hex of the extrinsic); checks the shape, not the content. */
export function polkadotParseRaw(raw: string): { bytes: Uint8Array; txid: string; decoded: PolkadotDecoded } {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]{200,400}$/.test(raw)) throw new Error('not a Polkadot signed extrinsic');
  const bytes = unhex(raw.slice(2));
  return { bytes, txid: polkadotTxid(bytes), decoded: polkadotDecodeExtrinsic(bytes) };
}

export const polkadotPlugin: FamilyPlugin = {
  family: 'polkadot',
  curve: 'ed25519',
  path(net: NetworkDef): string {
    if (net.coinType !== 354) throw new Error('Polkadot derivation requires coin type 354');
    return "m/44'/354'/0'/0'/0'";
  },
  address: (_net: NetworkDef, publicKey: Uint8Array) => polkadotAddressFromPublicKey(publicKey),
  normalizeAddress(_net: NetworkDef, addr: string): string {
    checkDestination(addr);
    return addr;
  },
  build(i: Intent, net: NetworkDef, aux?: Record<string, unknown>) {
    if (aux && Object.keys(aux).length > 0) throw new Error('unknown helper data for a Polkadot transfer');
    const b = buildPolkadotTx(i, net);
    return { signDocs: [b.signDoc], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle, aux?: Record<string, unknown>): Signed {
    if (aux && Object.keys(aux).length > 0) throw new Error('unknown helper data for a Polkadot transfer');
    const b = buildPolkadotTx(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage || key.publicKey.length !== 32) throw new Error('Polkadot needs an ed25519 key');
    if (polkadotAddressFromPublicKey(key.publicKey) !== i.from) throw new Error('signing key does not control the source address');
    const sig = key.signMessage(b.signDoc);
    if (sig.length !== 64 || !ed25519.verify(sig, b.signDoc, key.publicKey)) throw new Error('signature self-check failed');
    const xt = polkadotExtrinsic(b, key.publicKey, sig);
    // decode what is about to be released with the strict decoder and compare it with the intent, field by field
    const d = polkadotDecodeExtrinsic(xt);
    if (hexOf(d.signer) !== hexOf(key.publicKey) || d.signatureType !== POLKADOT_REVIEWED.signatureEd25519 || !d.era || d.era.period !== b.period || BigInt(d.era.phase) !== b.eraBlock % BigInt(b.period)
      || d.nonce !== b.nonce || d.tip !== 0n || d.mode !== 0 || d.pallet !== POLKADOT_REVIEWED.pallet.index || d.callIndex !== POLKADOT_REVIEWED.call.index
      || ss58Encode(POLKADOT_SS58_PREFIX, d.dest) !== i.to || d.value !== b.amount || hexOf(d.call) !== hexOf(b.call)) throw new Error('transaction self-check failed');
    return { raw: '0x' + hexOf(xt), txid: polkadotTxid(xt) };
  },
};

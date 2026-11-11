// Bitcoin Cash: P2PKH transfers only. Pure module (no network access).
//
// Bitcoin Cash signatures use the BIP143-style digest with SIGHASH_FORKID (0x41), which @scure/btc-signer does not implement,
// so the transaction serialization and the digest are implemented here (about a hundred lines) and proven in the tests against
// libauth's virtual machine, the Bitcoin Cash Node sighash vectors and the CashAddr specification vectors.
//   digest:   https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/replay-protected-sighash.md
//   CashAddr: https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md
// The digest commits to the value of every input, so previous transactions are not needed: a wrong input value in the intent
// yields a signature the network rejects, never a larger fee.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check, hex } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

// ---------------------------------------------------------------- CashAddr

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
const HASH_SIZES = [20, 24, 28, 32, 40, 48, 56, 64];

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let k = 0; k < 5; k++) if ((c0 >> BigInt(k)) & 1n) c ^= GEN[k]!;
  }
  return c ^ 1n;
}
const prefixValues = (prefix: string) => [...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0];

/** Regroup bits. Decoding (5→8) is strict: no extra group and zero padding only. */
function regroup(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [], mask = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & mask); }
    acc &= (1 << bits) - 1;
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & mask); }
  else if (bits >= from || acc !== 0) throw new Error('invalid CashAddr padding');
  return out;
}

export interface CashAddr { prefix: string; /** 0 = P2PKH, 1 = P2SH */ type: number; hash: Uint8Array }

export function cashaddrEncode(prefix: string, type: number, hash: Uint8Array): string {
  const size = HASH_SIZES.indexOf(hash.length);
  if (size < 0 || !Number.isInteger(type) || type < 0 || type > 15 || !/^[a-z]+$/.test(prefix)) throw new Error('invalid CashAddr parts');
  const payload = regroup([(type << 3) | size, ...hash], 8, 5, true);
  const mod = polymod([...prefixValues(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
  const check = Array.from({ length: 8 }, (_, k) => Number((mod >> BigInt(5 * (7 - k))) & 31n));
  return `${prefix}:${[...payload, ...check].map((v) => CHARSET[v]).join('')}`;
}

/** Decode and verify the checksum. A string without a prefix is checked against `defaultPrefix` (the prefix is part of the checksum). */
export function cashaddrDecode(addr: string, defaultPrefix?: string): CashAddr {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) throw new Error('mixed-case CashAddr');
  const lower = addr.toLowerCase(), parts = lower.split(':');
  if (parts.length > 2) throw new Error('invalid CashAddr');
  const prefix = parts.length === 2 ? parts[0]! : defaultPrefix, body = parts[parts.length - 1]!;
  if (!prefix || !/^[a-z]+$/.test(prefix)) throw new Error('CashAddr prefix missing');
  if (body.length < 42 || body.length > 112) throw new Error('invalid CashAddr length');
  const values = [...body].map((ch) => CHARSET.indexOf(ch));
  if (values.some((v) => v < 0)) throw new Error('invalid CashAddr character');
  if (polymod([...prefixValues(prefix), ...values]) !== 0n) throw new Error('bad CashAddr checksum');
  const bytes = regroup(values.slice(0, -8), 5, 8, false), version = bytes[0]!;
  if (version & 0x80) throw new Error('reserved CashAddr version bit');
  const hash = Uint8Array.from(bytes.slice(1));
  if (hash.length !== HASH_SIZES[version & 7]) throw new Error('CashAddr hash length mismatch');
  return { prefix, type: version >> 3, hash };
}

// ---------------------------------------------------------------- transaction

const SIGHASH_ALL_FORKID = 0x41;
const SEQUENCE = 0xffffffff; // final: Bitcoin Cash has no replace-by-fee, and the lock time is 0
const MAX_MONEY = 21_000_000n * 100_000_000n;
export const BCH_MAX_INPUTS = 50;

export interface BchTx {
  version: number; locktime: number;
  inputs: { txid: string; vout: number; sequence: number; script: Uint8Array }[];
  outputs: { value: bigint; script: Uint8Array }[];
}

const cat = (...p: Uint8Array[]): Uint8Array => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64 = (n: bigint): Uint8Array => { if (n < 0n || n > 0xffffffffffffffffn) throw new Error('value out of range'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const varint = (n: number): Uint8Array => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('length out of range');
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return cat(Uint8Array.of(0xfe), u32(n));
};
const hash256 = (b: Uint8Array) => sha256(sha256(b));
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const outpoint = (i: { txid: string; vout: number }) => cat(hex.decode(i.txid).reverse(), u32(i.vout));
const encOutput = (o: { value: bigint; script: Uint8Array }) => cat(u64(o.value), varint(o.script.length), o.script);
/** minimal push of 1 to 75 bytes */
const push = (b: Uint8Array) => { if (b.length < 1 || b.length > 75) throw new Error('push out of range'); return cat(Uint8Array.of(b.length), b); };
const p2pkhScript = (h: Uint8Array) => cat(Uint8Array.of(0x76, 0xa9, 0x14), h, Uint8Array.of(0x88, 0xac));
const p2shScript = (h: Uint8Array) => cat(Uint8Array.of(0xa9, 0x14), h, Uint8Array.of(0x87));

export function encodeBchTx(t: BchTx): Uint8Array {
  return cat(u32(t.version), varint(t.inputs.length),
    ...t.inputs.map((i) => cat(outpoint(i), varint(i.script.length), i.script, u32(i.sequence))),
    varint(t.outputs.length), ...t.outputs.map(encOutput), u32(t.locktime));
}

/** Strict decoder (no trailing bytes); used to check the builder against published vectors and other implementations. */
export function decodeBchTx(raw: Uint8Array): BchTx {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let o = 0;
  const need = (n: number) => { if (o + n > raw.length) throw new Error('truncated transaction'); };
  const r32 = () => { need(4); const v = dv.getUint32(o, true); o += 4; return v; };
  const rvar = () => { need(1); const f = raw[o++]!; if (f < 0xfd) return f; if (f === 0xfd) { need(2); const v = dv.getUint16(o, true); o += 2; return v; } if (f === 0xfe) return r32(); throw new Error('unsupported length'); };
  const rbytes = (n: number) => { need(n); const b = raw.slice(o, o + n); o += n; return b; };
  const version = r32();
  const inputs = Array.from({ length: rvar() }, () => { const txid = hex.encode(rbytes(32).reverse()), vout = r32(), script = rbytes(rvar()); return { txid, vout, script, sequence: r32() }; });
  const outputs = Array.from({ length: rvar() }, () => { need(8); const value = dv.getBigUint64(o, true); o += 8; return { value, script: rbytes(rvar()) }; });
  const locktime = r32();
  if (o !== raw.length) throw new Error('trailing bytes after transaction');
  return { version, locktime, inputs, outputs };
}

/**
 * Replay-protected signature digest of one input. `hashType` is the 32-bit signature hash type; only
 * SIGHASH_ALL | SIGHASH_FORKID is implemented (low byte 0x41; the upper 24 bits are the fork id, 0 on Bitcoin Cash).
 */
export function bchSighash(t: BchTx, index: number, scriptCode: Uint8Array, value: bigint, hashType: number = SIGHASH_ALL_FORKID): Uint8Array {
  if ((hashType & 0xff) !== SIGHASH_ALL_FORKID) throw new Error('only SIGHASH_ALL|FORKID is supported');
  const i = t.inputs[index];
  if (!i) throw new Error('input index out of range');
  return hash256(cat(
    u32(t.version), hash256(cat(...t.inputs.map(outpoint))), hash256(cat(...t.inputs.map((x) => u32(x.sequence)))),
    outpoint(i), varint(scriptCode.length), scriptCode, u64(value), u32(i.sequence),
    hash256(cat(...t.outputs.map(encOutput))), u32(t.locktime), u32(hashType),
  ));
}

export const bchTxid = (raw: Uint8Array) => hex.encode(hash256(raw).reverse());

// ---------------------------------------------------------------- family plugin

const b58check = createBase58check(sha256);
const prefixOf = (net: NetworkDef) => { const p = net.utxo?.cashaddr; if (net.family !== 'bch' || !net.utxo || !p) throw new Error(`${net.id} is not a Bitcoin Cash network`); return p; };

function normalizeAddress(net: NetworkDef, addr: string): string {
  const prefix = prefixOf(net), a = addr.trim();
  if (!a.includes(':') && /^[13][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) {
    // Legacy Base58 form. Only pay-to-public-key-hash is accepted: the same key controls the coins whatever the chain the
    // address was created for. A legacy "3…" address is refused because on Bitcoin it usually is a SegWit script that
    // cannot be spent on Bitcoin Cash.
    const raw = b58check.decode(a);
    if (raw.length !== 21) throw new Error('invalid legacy address');
    if (raw[0] !== net.utxo!.pubKeyHash) throw new Error('legacy script address is ambiguous; use the CashAddr form (bitcoincash:p…)');
    return cashaddrEncode(prefix, 0, raw.slice(1));
  }
  const d = cashaddrDecode(a, prefix);
  if (d.prefix !== prefix) throw new Error(`address is not a ${net.name} address`);
  if (d.type !== 0 && d.type !== 1) throw new Error('unsupported CashAddr type (token-aware addresses are not supported)');
  if (d.hash.length !== 20) throw new Error('unsupported CashAddr hash size');
  return cashaddrEncode(prefix, d.type, d.hash);
}

const scriptOf = (net: NetworkDef, normalized: string): Uint8Array => { const d = cashaddrDecode(normalized, prefixOf(net)); return d.type === 0 ? p2pkhScript(d.hash) : p2shScript(d.hash); };

const UINT = /^(0|[1-9]\d{0,15})$/;
/** `x.inputs`: "<txid>:<vout>:<value>" joined by commas, in signing order. */
export const encodeBchInputs = (inputs: { txid: string; vout: number; value: bigint | string | number }[]) => inputs.map((u) => `${u.txid}:${u.vout}:${u.value}`).join(',');
function parseInputs(s: string): { txid: string; vout: number; value: bigint }[] {
  const items = s.split(',');
  if (items.length < 1 || items.length > BCH_MAX_INPUTS) throw new Error('unsupported number of inputs');
  const seen = new Set<string>();
  return items.map((it) => {
    const m = /^([0-9a-f]{64}):(0|[1-9]\d{0,9}):(0|[1-9]\d{0,15})$/.exec(it);
    if (!m) throw new Error('malformed input');
    const vout = Number(m[2]), value = BigInt(m[3]!);
    if (vout > 0xffffffff) throw new Error('malformed input');
    if (value <= 0n || value > MAX_MONEY) throw new Error('input value out of range');
    const k = `${m[1]}:${vout}`;
    if (seen.has(k)) throw new Error('duplicate input');
    seen.add(k);
    return { txid: m[1]!, vout, value };
  });
}

/** Rebuild the unsigned transaction from the intent alone. Inputs are P2PKH outputs of `from`; change returns to `from`. */
function plan(i: Intent, net: NetworkDef) {
  prefixOf(net);
  if (i.network !== net.id) throw new Error('intent is for another network');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch');
  if (i.asset !== 'native' || i.decimals !== net.native.decimals || i.symbol !== net.native.symbol) throw new Error('asset mismatch');
  if (i.memo !== undefined) throw new Error(`${net.name} transfers carry no memo`);
  if (i.evm || i.btc || i.sol || !i.x) throw new Error('intent chain section does not match network');
  const keys = Object.keys(i.x).sort().join(',');
  if (keys !== 'change,fee,inputs') throw new Error('unknown or missing chain parameters');
  if (!UINT.test(i.x.change!) || !UINT.test(i.x.fee!)) throw new Error('malformed chain parameters');
  if (normalizeAddress(net, i.from) !== i.from) throw new Error('source not normalized');
  if (normalizeAddress(net, i.to) !== i.to) throw new Error('destination not normalized');
  if (i.to === i.from) throw new Error('destination equals source');
  const from = cashaddrDecode(i.from);
  if (from.type !== 0) throw new Error('source must be P2PKH');
  const dust = BigInt(net.utxo!.dust), amount = baseUnits(i.amount), change = BigInt(i.x.change!), fee = BigInt(i.x.fee!);
  if (amount <= 0n || amount < dust) throw new Error('amount below dust');
  if (amount > MAX_MONEY || change > MAX_MONEY) throw new Error('amount out of range');
  if (change !== 0n && change < dust) throw new Error('change below dust');
  if (fee <= 0n) throw new Error('fee must be positive');
  if (fee > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const inputs = parseInputs(i.x.inputs!);
  if (inputs.reduce((s, u) => s + u.value, 0n) !== amount + change + fee) throw new Error('inputs != outputs + fee');
  const lock = p2pkhScript(from.hash);
  const tx: BchTx = {
    version: 2, locktime: 0,
    inputs: inputs.map((u) => ({ txid: u.txid, vout: u.vout, sequence: SEQUENCE, script: new Uint8Array(0) })),
    outputs: [{ value: amount, script: scriptOf(net, i.to) }, ...(change > 0n ? [{ value: change, script: lock }] : [])],
  };
  return { tx, inputs, lock, fromHash: from.hash, amount, change, fee };
}

/** The unsigned transaction a Bitcoin Cash intent describes (throws on anything unsupported). */
export const buildBchTx = (i: Intent, net: NetworkDef): BchTx => plan(i, net).tx;

/** Upper bound of the serialized size: 10 + 149 per P2PKH input (72-byte signature) + outputs. */
export const estimateBchSize = (nInputs: number, toIsP2sh: boolean, hasChange: boolean): number => 10 + 149 * nInputs + (toIsP2sh ? 32 : 34) + (hasChange ? 34 : 0);
export const bchIsP2sh = (net: NetworkDef, normalized: string): boolean => cashaddrDecode(normalized, prefixOf(net)).type === 1;

export const bchPlugin: FamilyPlugin = {
  family: 'bch',
  curve: 'secp256k1',
  path: (net) => `m/44'/${net.coinType ?? 145}'/0'/0/0`,
  address(net, publicKey) {
    if (publicKey.length !== 33) throw new Error('compressed public key required');
    return cashaddrEncode(prefixOf(net), 0, hash160(publicKey));
  },
  normalizeAddress,
  build(i, net) {
    const p = plan(i, net);
    return {
      signDocs: p.inputs.map((u, k) => bchSighash(p.tx, k, p.lock, u.value)),
      describe: { to: i.to, amount: p.amount.toString(), change: p.change.toString(), fee: p.fee.toString(), inputs: String(p.inputs.length) },
    };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const p = plan(i, net);
    if (key.curve !== 'secp256k1' || !key.signDigest || key.publicKey.length !== 33) throw new Error('secp256k1 signing key required');
    if (hex.encode(hash160(key.publicKey)) !== hex.encode(p.fromHash)) throw new Error('signing key does not control the source address');
    p.inputs.forEach((u, k) => {
      const digest = bchSighash(p.tx, k, p.lock, u.value);
      const sig = key.signDigest!(digest);
      if (!secp256k1.verify(sig.compact, digest, key.publicKey, { prehash: false, lowS: true })) throw new Error('signature self-check failed');
      p.tx.inputs[k]!.script = cat(push(cat(sig.der, Uint8Array.of(SIGHASH_ALL_FORKID))), push(key.publicKey));
    });
    const raw = encodeBchTx(p.tx);
    return { raw: hex.encode(raw), txid: bchTxid(raw) };
  },
};

// Cardano (family "cardano"): native ADA only, one fixed transaction shape (Conway era). No native assets, no staking, no
// scripts, no metadata, no withdrawals, no certificates.
// Pure module: no network access, no side effects. The CBOR below is written by hand for exactly this shape and proven
// against the official cardano-serialization-lib (test-only devDependency) in packages/core/test/cardano.test.ts, and the
// strict decoder is exercised on real mainnet transactions (packages/core/test/fixtures/cardano-mainnet-txs.json).
//
// Sources (read 2026-11-11):
// - Conway CDDL: https://github.com/IntersectMBO/cardano-ledger/blob/master/eras/conway/impl/cddl/data/conway.cddl
// - CIP-19 addresses: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0019/README.md
// - CIP-1852 derivation: https://github.com/cardano-foundation/CIPs/blob/master/CIP-1852/README.md
// - Fee and minimum-ADA rules: https://github.com/IntersectMBO/cardano-ledger (Shelley `minfee`, Babbage `getMinCoinTxOut`)
//
// The transaction:
//   [ body, witness_set, true, null ]
//   body        = { 0: #6.258([ [txid, index], … ]),            inputs, sorted, all owned by `from`
//                   1: [ [address(to), amount], [address(from), change]? ],
//                   2: fee, 3: ttl }                              ttl = last slot in which it may be included
//   witness_set = { 0: #6.258([ [payment public key, signature] ]) }
//   transaction id = blake2b-256(body bytes); the signature is Ed25519 over the transaction id.
// The ledger enforces sum(inputs) = sum(outputs) + fee exactly, so a wrong input value in the intent can only make the
// transaction invalid, never overpay; an input that carries native assets makes it invalid too (the assets would vanish).
//
// The wallet's address is a CIP-19 base address (type 0): payment key m/1852'/1815'/0'/0/0 + stake key m/1852'/1815'/0'/2/0,
// BIP32-Ed25519 / Icarus (services/isolated-signer/src/bip32-ed25519.ts) — the first address every Shelley wallet shows.
// The plugin's "public key" is therefore 64 bytes: payment key ‖ stake key. Only the payment key ever signs.
//
// Intent parameters (`x`, all required, nothing else accepted):
//   inputs  "txid:index:lovelace" joined by "," — 1..CARDANO_MAX_INPUTS, sorted by (txid, index), no duplicates
//   fee     lovelace, > 0 and <= intent.maxFee
//   change  lovelace returned to `from` ("0" = no change output)
//   ttl     absolute slot; must lie after intent.createdAt and at most CARDANO_MAX_TTL_AHEAD_SEC later
// and inputs = amount + fee + change must hold exactly. No memo.
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { base58, bech32 } from '@scure/base';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** Network magic of mainnet (the `chainRef`): https://book.world.dev.cardano.org/environments.html */
export const CARDANO_MAINNET_MAGIC = '764824073';
/** unix time of slot 0 on the current 1-second slot scale: Shelley began at slot 4 492 800 = 2020-07-29T21:44:51Z (1596059091) */
export const CARDANO_SLOT_ZERO_UNIX = 1_591_566_291;
/** a transaction may stay valid at most this long after the intent was created */
export const CARDANO_MAX_TTL_AHEAD_SEC = 7200;
export const CARDANO_MAX_INPUTS = 20;
/** protocol `maxTxSize` (bytes); a plain send with 20 inputs is about 1 kB */
export const CARDANO_MAX_TX_SIZE = 16384;
export const CARDANO_PATHS = { payment: "m/1852'/1815'/0'/0/0", stake: "m/1852'/1815'/0'/2/0" } as const;
const U64_MAX = (1n << 64n) - 1n;
const X_KEYS = ['change', 'fee', 'inputs', 'ttl'];
const BECH32_LIMIT = 128;

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
const blake2b224 = (m: Uint8Array) => blake2b(m, { dkLen: 28 });
const blake2b256 = (m: Uint8Array) => blake2b(m, { dkLen: 32 });

// ---------------------------------------------------------------- CBOR (RFC 8949), the subset a transaction uses
/** Head of a data item: major type + argument in its shortest form (canonical / deterministic encoding). */
function head(major: number, v: bigint): number[] {
  if (v < 0n || v > U64_MAX) throw new Error('integer out of range');
  const m = major << 5;
  if (v < 24n) return [m | Number(v)];
  if (v < 0x100n) return [m | 24, Number(v)];
  if (v < 0x10000n) return [m | 25, Number(v >> 8n), Number(v & 0xffn)];
  if (v < 0x100000000n) return [m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn))];
  return [m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn))];
}
const cUint = (v: bigint) => Uint8Array.from(head(0, v));
const cBytes = (b: Uint8Array) => cat(head(2, BigInt(b.length)), b);
const cArray = (items: Uint8Array[]) => cat(head(4, BigInt(items.length)), ...items);
/** Map with small unsigned keys, written in ascending key order. */
const cMap = (entries: [number, Uint8Array][]) => cat(head(5, BigInt(entries.length)), ...entries.flatMap(([k, v]) => [cUint(BigInt(k)), v]));
/** Conway `set<a>` / `nonempty_set<a>`: tag 258 around an array. */
const cSet = (items: Uint8Array[]) => cat(head(6, 258n), cArray(items));

export type Cbor = bigint | Uint8Array | string | boolean | null | Cbor[] | CborMap | CborTag;
/** a map keeps its entries in wire order */
export interface CborMap { map: [Cbor, Cbor][] }
export interface CborTag { tag: bigint; value: Cbor }
export const isCborMap = (v: Cbor): v is CborMap => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && 'map' in v;
export const isCborTag = (v: Cbor): v is CborTag => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && 'tag' in v;

/**
 * CBOR decoder. `strict` (default) accepts only what this module writes: shortest-form integers and lengths, definite
 * lengths, no floats, no duplicate map keys, no trailing bytes. With `strict: false` it also reads what other wallets
 * produce (indefinite lengths, non-minimal integers, negative integers as bigint, text) — used to read real transactions.
 * `spans`, when given, receives the byte range of every item of the top-level array (to hash a body exactly as sent).
 */
export function cborDecode(bytes: Uint8Array, opt: { strict?: boolean; spans?: [number, number][] } = {}): Cbor {
  const strict = opt.strict !== false;
  let o = 0, depth = 0;
  const need = (n: number) => { if (o + n > bytes.length) throw new Error('truncated CBOR'); };
  const arg = (info: number): bigint => {
    if (info < 24) return BigInt(info);
    if (info > 27) throw new Error('unsupported CBOR length');
    const n = 1 << (info - 24);
    need(n);
    let v = 0n;
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(bytes[o + k]!);
    o += n;
    if (strict && (v < 24n || (n > 1 && v < 1n << BigInt(4 * n)))) throw new Error('non-canonical CBOR integer');
    return v;
  };
  const len = (v: bigint): number => { if (v > BigInt(bytes.length)) throw new Error('truncated CBOR'); return Number(v); };
  const item = (top = false): Cbor => {
    if (++depth > 64) throw new Error('CBOR nested too deeply');
    need(1);
    const b = bytes[o++]!, major = b >> 5, info = b & 31;
    let out: Cbor;
    if (info === 31) {
      if (strict || major < 2 || major > 5) throw new Error('indefinite-length CBOR not accepted');
      const end = () => { need(1); if (bytes[o] === 0xff) { o++; return true; } return false; };
      if (major === 2 || major === 3) {
        const chunks: Uint8Array[] = [];
        while (!end()) { const c = item(); if (!(c instanceof Uint8Array) && typeof c !== 'string') throw new Error('bad CBOR chunk'); chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : c); }
        out = major === 2 ? cat(...chunks) : new TextDecoder().decode(cat(...chunks));
      } else if (major === 4) { const a: Cbor[] = []; while (!end()) a.push(item()); out = a; }
      else { const m: [Cbor, Cbor][] = []; while (!end()) { const k = item(); m.push([k, item()]); } out = { map: m }; }
    } else if (major === 0) out = arg(info);
    else if (major === 1) { if (strict) throw new Error('negative CBOR integer not accepted'); out = -1n - arg(info); }
    else if (major === 2 || major === 3) {
      const n = len(arg(info));
      need(n);
      const s = bytes.slice(o, o + n);
      o += n;
      if (major === 3) { if (strict) throw new Error('CBOR text not accepted'); out = new TextDecoder('utf-8', { fatal: true }).decode(s); } else out = s;
    } else if (major === 4) {
      const n = len(arg(info)), a: Cbor[] = [];
      for (let k = 0; k < n; k++) { const s = o; a.push(item()); if (top && opt.spans) opt.spans.push([s, o]); }
      out = a;
    } else if (major === 5) {
      const n = len(arg(info)), m: [Cbor, Cbor][] = [], seen = new Set<string>();
      for (let k = 0; k < n; k++) {
        const s = o, key = item(), id = hexOf(bytes.subarray(s, o));
        if (seen.has(id)) throw new Error('duplicate CBOR map key');
        seen.add(id);
        m.push([key, item()]);
      }
      out = { map: m };
    } else if (major === 6) out = { tag: arg(info), value: item() };
    else {
      if (info === 20) out = false; else if (info === 21) out = true; else if (info === 22) out = null;
      else throw new Error('unsupported CBOR simple value or float');
    }
    depth--;
    return out;
  };
  const v = item(true);
  if (o !== bytes.length) throw new Error('trailing bytes after CBOR item');
  return v;
}

// ---------------------------------------------------------------- addresses (CIP-19)
export interface CardanoAddress { type: number; network: number; payment: Uint8Array; stake?: Uint8Array; bytes: Uint8Array }
/**
 * Decode a Shelley address. Accepted: the canonical lower-case bech32 form with the `addr` prefix, mainnet network tag,
 * types 0–3 (57 bytes) and 6–7 (29 bytes). Refused: test networks, reward addresses (`stake1…`), pointer addresses
 * (types 4–5, retired by Conway), Byron addresses (base58), bech32m, wrong lengths, non-canonical encodings.
 */
export function cardanoAddressBytes(addr: string): CardanoAddress {
  if (typeof addr !== 'string' || !/^addr1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{53,98}$/.test(addr)) throw new Error('invalid address: expected a Cardano mainnet address (addr1…)');
  let d: { prefix: string; bytes: Uint8Array };
  try { d = bech32.decodeToBytes(addr as `${string}1${string}`, BECH32_LIMIT); } catch { throw new Error('invalid address: bad bech32 checksum'); }
  const b = d.bytes, type = (b[0] ?? 0xff) >> 4, network = (b[0] ?? 0xff) & 0x0f;
  if (d.prefix !== 'addr') throw new Error('invalid address: expected a Cardano mainnet address (addr1…)');
  if (network !== 1) throw new Error('invalid address: not a mainnet address');
  if (type <= 3 ? b.length !== 57 : type === 6 || type === 7 ? b.length !== 29 : true) throw new Error('invalid address: unsupported address type or length');
  if (bech32.encode('addr', bech32.toWords(b), BECH32_LIMIT) !== addr) throw new Error('non-canonical address');
  return { type, network, payment: b.slice(1, 29), ...(b.length === 57 ? { stake: b.slice(29, 57) } : {}), bytes: b };
}
/**
 * A destination this wallet pays: an address whose payment part is a KEY (types 0, 2, 6). Payment-script addresses
 * (types 1, 3, 7) are refused: ADA sent to a Plutus script without the datum it expects can be locked for ever, and no
 * exchange deposit address is one.
 */
export function cardanoDestination(addr: string): CardanoAddress {
  const a = cardanoAddressBytes(addr);
  if (a.type !== 0 && a.type !== 2 && a.type !== 6) throw new Error('unsupported destination: script addresses are refused (ADA sent to a contract without its datum can be lost)');
  return a;
}
const splitKeys = (publicKey: Uint8Array): { payment: Uint8Array; stake: Uint8Array } => {
  if (publicKey.length !== 64) throw new Error('Cardano needs the payment and the stake public keys (64 bytes)');
  const payment = publicKey.slice(0, 32), stake = publicKey.slice(32, 64);
  ed25519.Point.fromBytes(payment); ed25519.Point.fromBytes(stake); // throw when not curve points
  return { payment, stake };
};
/** Base address (type 0, mainnet) of a payment key and a stake key: header 0x01 ‖ blake2b-224(payment) ‖ blake2b-224(stake). */
export function cardanoBaseAddress(paymentKey: Uint8Array, stakeKey: Uint8Array): string {
  if (paymentKey.length !== 32 || stakeKey.length !== 32) throw new Error('ed25519 public keys must be 32 bytes');
  return bech32.encode('addr', bech32.toWords(cat([0x01], blake2b224(paymentKey), blake2b224(stakeKey))), BECH32_LIMIT);
}

// ---------------------------------------------------------------- the transfer
export interface CardanoInput { txid: string; index: number; value: bigint }
const canonicalU64 = (name: string, s: string | undefined, min: bigint): bigint => {
  if (s === undefined || !/^(0|[1-9]\d{0,19})$/.test(s)) throw new Error(`${name} must be a canonical decimal integer`);
  const v = BigInt(s);
  if (v < min || v > U64_MAX) throw new Error(`${name} out of range`);
  return v;
};
/** Parse x.inputs. Strict: canonical fields, sorted by (txid, index), no duplicates, 1..CARDANO_MAX_INPUTS entries. */
export function cardanoParseInputs(s: string | undefined): CardanoInput[] {
  if (typeof s !== 'string' || s.length === 0) throw new Error('x.inputs is missing');
  const parts = s.split(',');
  if (parts.length > CARDANO_MAX_INPUTS) throw new Error('too many inputs');
  let prev = '';
  return parts.map((p) => {
    const f = p.split(':');
    if (f.length !== 3 || !/^[0-9a-f]{64}$/.test(f[0]!) || !/^(0|[1-9]\d{0,4})$/.test(f[1]!) || Number(f[1]) > 0xffff) throw new Error('x.inputs entries must be txid:index:lovelace');
    const key = f[0]! + f[1]!.padStart(5, '0');
    if (key <= prev) throw new Error('x.inputs must be sorted by (txid, index) without duplicates');
    prev = key;
    return { txid: f[0]!, index: Number(f[1]), value: canonicalU64('x.inputs value', f[2], 1n) };
  });
}
export const cardanoFormatInputs = (inputs: CardanoInput[]): string =>
  [...inputs].sort((a, b) => (a.txid === b.txid ? a.index - b.index : a.txid < b.txid ? -1 : 1)).map((u) => `${u.txid}:${u.index}:${u.value}`).join(',');

/**
 * Serialized transaction output `[address, lovelace]`: the array form (`alonzo_transaction_output` in the Conway CDDL, "equally
 * valid" as the map form), which
 * is what the official serialization library and the wallets built on it write for an output without datum or script.
 */
export const cardanoOutputBytes = (address: Uint8Array, lovelace: bigint): Uint8Array => cArray([cBytes(address), cUint(lovelace)]);
/** Minimum lovelace an output must carry (Babbage rule): (160 + size of the serialized output) × coinsPerUTxOByte. */
export function cardanoMinAda(address: string, lovelace: bigint, coinsPerUtxoByte: bigint): bigint {
  // the minimum depends on the size of the amount itself: evaluate at the larger of the amount and the minimum it implies
  const a = cardanoAddressBytes(address).bytes;
  let min = (160n + BigInt(cardanoOutputBytes(a, lovelace).length)) * coinsPerUtxoByte;
  if (lovelace < min) min = (160n + BigInt(cardanoOutputBytes(a, min).length)) * coinsPerUtxoByte;
  return min;
}
/** Linear minimum fee of a transaction without scripts: minFeeA × size + minFeeB. */
export const cardanoMinFee = (sizeBytes: number, minFeeA: bigint, minFeeB: bigint): bigint => minFeeA * BigInt(sizeBytes) + minFeeB;
/** bytes of the witness set for one key: {0: 258([[vkey(32), signature(64)]])} */
const WITNESS_SIZE = 1 + 1 + 3 + 1 + 1 + 2 + 32 + 2 + 64;

/** body = {0: inputs, 1: outputs, 2: fee, 3: ttl}; a change of 0 means no change output */
function encodeBody(inputs: { txid: string; index: number }[], to: Uint8Array, amount: bigint, from: Uint8Array, change: bigint, fee: bigint, ttl: bigint): Uint8Array {
  return cMap([
    [0, cSet(inputs.map((u) => cArray([cBytes(unhex(u.txid)), cUint(BigInt(u.index))])))],
    [1, cArray([cardanoOutputBytes(to, amount), ...(change > 0n ? [cardanoOutputBytes(from, change)] : [])])],
    [2, cUint(fee)],
    [3, cUint(ttl)],
  ]);
}
/**
 * Size in bytes of the signed transaction these fields would make (same encoder as buildCardanoTx, no validation): used by
 * the API to find the fee, which depends on the size, which depends on the fee and the change.
 */
export function cardanoTxSizeOf(p: { inputs: { txid: string; index: number }[]; from: string; to: string; amount: bigint; change: bigint; fee: bigint; ttl: bigint }): number {
  return 1 + encodeBody(p.inputs, cardanoAddressBytes(p.to).bytes, p.amount, cardanoAddressBytes(p.from).bytes, p.change, p.fee, p.ttl).length + WITNESS_SIZE + 2;
}

export interface CardanoBuilt {
  /** CBOR transaction body: its blake2b-256 is the transaction id and the message signed */
  body: Uint8Array;
  /** transaction id (32 bytes) */
  hash: Uint8Array;
  txid: string;
  /**
   * size in bytes of the complete signed transaction (the signature has a fixed size) — what the fee is computed on. The
   * ledger itself measures one byte less (it leaves the `true` validity flag out), so a fee computed on this size is the
   * minimum plus 44 lovelace: the same convention as the official serialization library's `min_fee`.
   */
  size: number;
  inputs: CardanoInput[]; amount: bigint; fee: bigint; change: bigint; ttl: bigint;
  describe: Record<string, string>;
}

/** Rebuild the exact transaction body from the intent alone. Throws on anything that is not a plain ADA payment. */
export function buildCardanoTx(i: Intent, net: NetworkDef): CardanoBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'cardano' || i.network !== net.id) throw new Error('not a Cardano intent');
  if (net.chainRef !== CARDANO_MAINNET_MAGIC) throw new Error('unknown Cardano network: only mainnet is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (network magic)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in a Cardano intent');
  if (i.memo !== undefined) throw new Error('Cardano transfers do not carry a memo in this version');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native ADA can be sent on Cardano in this version');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 6) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing Cardano parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing Cardano parameter (expected change, fee, inputs, ttl)');

  const from = cardanoAddressBytes(i.from), to = cardanoDestination(i.to);
  if (from.type !== 0) throw new Error('the source must be this wallet\'s base address');
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > U64_MAX) throw new Error('amount out of range');
  const fee = canonicalU64('x.fee', x.fee, 1n);
  if (fee > baseUnits(i.maxFee)) throw new Error('fee above approved maximum');
  const change = canonicalU64('x.change', x.change, 0n);
  const ttl = canonicalU64('x.ttl', x.ttl, 1n);
  const ttlUnix = ttl + BigInt(CARDANO_SLOT_ZERO_UNIX);
  if (ttlUnix <= BigInt(i.createdAt)) throw new Error('validity window already closed (x.ttl is before the intent was created)');
  if (ttlUnix > BigInt(i.createdAt) + BigInt(CARDANO_MAX_TTL_AHEAD_SEC)) throw new Error('validity window too long (x.ttl too far ahead)');
  const inputs = cardanoParseInputs(x.inputs);
  const total = inputs.reduce((s, u) => s + u.value, 0n);
  if (total !== amount + fee + change) throw new Error('inputs do not equal amount + fee + change');

  const body = encodeBody(inputs, to.bytes, amount, from.bytes, change, fee, ttl);
  const size = 1 + body.length + WITNESS_SIZE + 2;
  if (size > CARDANO_MAX_TX_SIZE) throw new Error('transaction too large');
  const hash = blake2b256(body), txid = hexOf(hash);
  return {
    body, hash, txid, size, inputs, amount, fee, change, ttl,
    describe: {
      network: net.name, operation: 'Pay ADA (one payment output, change back to this wallet)', from: i.from, to: i.to, amountLovelace: amount.toString(),
      feeLovelace: fee.toString(), changeLovelace: change.toString(), inputs: String(inputs.length), inputsLovelace: total.toString(), ttlSlot: ttl.toString(),
      validUntil: new Date(Number(ttlUnix) * 1000).toISOString(), sizeBytes: String(size), txid,
    },
  };
}

/** Complete signed transaction: [body, {0: 258([[vkey, signature]])}, true, null]. */
export function cardanoSignedTx(body: Uint8Array, paymentKey: Uint8Array, signature: Uint8Array): Uint8Array {
  if (paymentKey.length !== 32 || signature.length !== 64) throw new Error('bad signature or key length');
  return cat([0x84], body, cMap([[0, cSet([cArray([cBytes(paymentKey), cBytes(signature)])])]]), [0xf5, 0xf6]);
}

export interface CardanoDecodedOutput { address: string; addressHex: string; lovelace: bigint; assets: number; extras: boolean }
export interface CardanoDecodedTx {
  txid: string; inputs: { txid: string; index: number }[]; outputs: CardanoDecodedOutput[]; fee: bigint; ttl: bigint | null;
  /** keys of the body map, in wire order */
  bodyKeys: number[]; witnesses: { publicKey: Uint8Array; signature: Uint8Array }[]; valid: boolean; hasAuxiliaryData: boolean;
}
const asArray = (v: Cbor | undefined): Cbor[] => { const a = v !== undefined && isCborTag(v) && v.tag === 258n ? v.value : v; if (!Array.isArray(a)) throw new Error('expected an array or a set'); return a; };
const asBig = (v: Cbor | undefined): bigint => { if (typeof v !== 'bigint' || v < 0n) throw new Error('expected an unsigned integer'); return v; };
const asBytes = (v: Cbor | undefined, n?: number): Uint8Array => { if (!(v instanceof Uint8Array) || (n !== undefined && v.length !== n)) throw new Error('expected a byte string'); return v; };
const field = (m: CborMap, key: number): Cbor | undefined => m.map.find(([k]) => k === BigInt(key))?.[1];
const shelleyAddress = (b: Uint8Array): string => {
  const type = b[0]! >> 4, net = b[0]! & 0x0f;
  if (type === 8) return base58.encode(b); // Byron (bootstrap) address
  return bech32.encode((type >= 14 ? 'stake' : 'addr') + (net === 1 ? '' : '_test'), bech32.toWords(b), 1023);
};
/**
 * Decode a complete transaction (any Shelley-to-Conway era shape: tagged or plain sets, legacy or map outputs, multi-asset
 * values). `strict` (default) accepts only canonical CBOR — the form this module writes; pass `strict: false` to read
 * transactions made by other software. The transaction id is computed over the body bytes exactly as they were received.
 */
export function cardanoDecodeTx(raw: Uint8Array, opt: { strict?: boolean } = {}): CardanoDecodedTx {
  const spans: [number, number][] = [];
  const tx = cborDecode(raw, { strict: opt.strict, spans });
  if (!Array.isArray(tx) || (tx.length !== 4 && tx.length !== 3) || !isCborMap(tx[0]!) || !isCborMap(tx[1]!)) throw new Error('not a Cardano transaction');
  const body = tx[0] as CborMap, wit = tx[1] as CborMap;
  const inputs = asArray(field(body, 0)).map((u) => { if (!Array.isArray(u) || u.length !== 2) throw new Error('bad input'); return { txid: hexOf(asBytes(u[0], 32)), index: Number(asBig(u[1])) }; });
  const fieldOutputs = field(body, 1);
  if (!Array.isArray(fieldOutputs)) throw new Error('bad outputs');
  const outputs = fieldOutputs.map((o): CardanoDecodedOutput => {
    let addr: Cbor | undefined, value: Cbor | undefined, extras = false;
    if (Array.isArray(o)) { addr = o[0]; value = o[1]; extras = o.length > 2; }
    else if (isCborMap(o)) { addr = field(o, 0); value = field(o, 1); extras = o.map.length > 2; }
    else throw new Error('bad output');
    const a = asBytes(addr);
    let lovelace: bigint, assets = 0;
    if (Array.isArray(value)) { lovelace = asBig(value[0]); const ma = value[1]; if (ma === undefined || !isCborMap(ma)) throw new Error('bad multi-asset value'); for (const [, names] of ma.map) assets += isCborMap(names) ? names.map.length : 0; }
    else lovelace = asBig(value);
    return { address: shelleyAddress(a), addressHex: hexOf(a), lovelace, assets, extras };
  });
  const ttl = field(body, 3);
  const vkeys = field(wit, 0);
  const witnesses = vkeys === undefined ? [] : asArray(vkeys).map((w) => { if (!Array.isArray(w) || w.length !== 2) throw new Error('bad witness'); return { publicKey: asBytes(w[0], 32), signature: asBytes(w[1], 64) }; });
  return {
    txid: hexOf(blake2b256(raw.subarray(spans[0]![0], spans[0]![1]))), inputs, outputs, fee: asBig(field(body, 2)), ttl: ttl === undefined ? null : asBig(ttl),
    bodyKeys: body.map.map(([k]) => Number(asBig(k))), witnesses, valid: tx.length === 3 ? true : tx[2] === true, hasAuxiliaryData: tx[tx.length - 1] !== null,
  };
}

/** Transaction id of a broadcast-ready payload (hex of the signed transaction made by sign()); checks the shape, not the content. */
export function cardanoTxid(rawHex: string): string {
  if (typeof rawHex !== 'string' || rawHex.length < 200 || rawHex.length > 2 * CARDANO_MAX_TX_SIZE) throw new Error('not a Cardano signed transaction');
  const d = cardanoDecodeTx(unhex(rawHex));
  if (d.witnesses.length !== 1 || !d.valid || d.hasAuxiliaryData) throw new Error('not a Cardano signed transaction');
  return d.txid;
}

export const cardanoPlugin: FamilyPlugin = {
  family: 'cardano',
  curve: 'ed25519',
  keyScheme: 'cip1852',
  /** the payment key path; the stake key (…/2/0) is derived next to it and never signs */
  path(net: NetworkDef): string {
    if (net.coinType !== 1815) throw new Error('Cardano derivation requires coin type 1815');
    return CARDANO_PATHS.payment;
  },
  address(_net: NetworkDef, publicKey: Uint8Array): string { const k = splitKeys(publicKey); return cardanoBaseAddress(k.payment, k.stake); },
  normalizeAddress(_net: NetworkDef, addr: string): string {
    // bech32 is case-insensitive as a whole: an all-upper-case address (QR codes) is lowered; mixed case is refused
    if (typeof addr !== 'string') throw new Error('invalid address');
    const a = addr === addr.toUpperCase() ? addr.toLowerCase() : addr;
    cardanoDestination(a);
    return a;
  },
  build(i: Intent, net: NetworkDef, aux?: Record<string, unknown>) {
    if (aux && Object.keys(aux).length > 0) throw new Error('unknown helper data for a Cardano transfer');
    const b = buildCardanoTx(i, net);
    return { signDocs: [b.hash], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle, aux?: Record<string, unknown>): Signed {
    if (aux && Object.keys(aux).length > 0) throw new Error('unknown helper data for a Cardano transfer');
    const b = buildCardanoTx(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage) throw new Error('Cardano needs an ed25519 key');
    const k = splitKeys(key.publicKey);
    if (cardanoBaseAddress(k.payment, k.stake) !== i.from) throw new Error('signing key does not control the source address');
    const sig = key.signMessage(b.hash);
    if (sig.length !== 64 || !ed25519.verify(sig, b.hash, k.payment)) throw new Error('signature self-check failed');
    const raw = cardanoSignedTx(b.body, k.payment, sig);
    // decode what is about to be released with the strict decoder and compare it with the intent, field by field
    const d = cardanoDecodeTx(raw);
    const expected = [[i.to, b.amount], ...(b.change > 0n ? [[i.from, b.change]] : [])] as [string, bigint][];
    if (raw.length !== b.size || d.txid !== b.txid || d.fee !== b.fee || d.ttl !== b.ttl || d.bodyKeys.join() !== '0,1,2,3' || d.inputs.length !== b.inputs.length
      || d.inputs.some((u, n) => u.txid !== b.inputs[n]!.txid || u.index !== b.inputs[n]!.index) || d.outputs.length !== expected.length
      || d.outputs.some((o, n) => o.address !== expected[n]![0] || o.lovelace !== expected[n]![1] || o.assets !== 0 || o.extras)) throw new Error('transaction self-check failed');
    return { raw: hexOf(raw), txid: b.txid };
  },
};

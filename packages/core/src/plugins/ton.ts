/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/plugins/ton.ts
 * Module           : plugins
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// TON (family "ton"): native Toncoin only, one outgoing message per transfer, standard wallet contract v4R2.
// Pure module: no network access, no side effects. Cells, the bag-of-cells container and the wallet messages are written by hand
// from the approved intent and proven against @ton/core + @ton/ton (cell hashes and BoC bytes) in test/ton.test.ts.
//
// Keys: ed25519 by SLIP-0010 at m/44'/607'/0' from the wallet's single BIP-39 seed. TON's own 24-word scheme is NOT used, so this
// address is not the one Tonkeeper derives from a TON-native phrase, and this wallet cannot be restored there from its words.
//
// Address = hash of the wallet's StateInit (v4R2 code, data = seqno 0 | subwallet id | public key | no plugins), workchain 0.
// One canonical text form everywhere in an intent: non-bounceable, URL-safe ("UQ…"). Whether the message bounces is NOT taken
// from the address text: it is the explicit, approved parameter x.bounce.
//
// Intent parameters (x), all required:
//   seqno       wallet sequence number the message is valid for (canonical decimal, uint32)
//   validUntil  unix time after which the wallet contract rejects the message
//   bounce      "1" (destination is an initialized contract) | "0" (it is not: funds must not be bounced back)
//   sendMode    "3" only: pay the forwarding fee separately + ignore action errors (what every standard wallet sends)
//   stateInit   "1" attach the wallet's code and data (first outgoing transfer: deploys the contract; seqno must be 0) | "0"
// The optional text comment is intent.memo.
//
// What ed25519 signs: the representation hash of the v4 signing message
//   subwallet_id:uint32 valid_until:uint32 seqno:uint32 op:uint8(0) mode:uint8 ^(internal message).
// The StateInit and the external envelope are not covered by the signature (protocol property); they are rebuilt here from the
// signing key and the intent. TON signatures carry no network id and no fee field: the fee is charged from the balance by
// the network's own price table, so intent.maxFee is a budget checked by the API, not a value this module can put on the wire.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { baseUnits } from '../amounts.ts';
import type { FamilyPlugin, KeyHandle, Signed } from '../families.ts';
import type { Intent } from '../intent.ts';
import type { NetworkDef } from '../networks.ts';

/** masterchain zero-state root hash of the TON main network (hex); the file hash is 5e994fcf…a0f6e */
export const TON_MAINNET_ZEROSTATE = '17a3a92992aabea785a7a090985a265cd31f323d849da51239737e321fb05569';
/** default subwallet id of v3/v4 wallets on workchain 0 */
export const TON_SUBWALLET_ID = 698983191;
/** representation hash of the wallet v4R2 code cell */
export const TON_V4R2_CODE_HASH = 'feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0';
/** wallet v4R2 code, bag of cells (base64) — the constant shipped in @ton/ton's WalletContractV4; its hash is checked on first use */
export const TON_V4R2_CODE_BOC = 'te6ccgECFAEAAtQAART/APSkE/S88sgLAQIBIAIDAgFIBAUE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBgcCASAICQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAKCwBZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEAgFYDA0AEbjJftRNDXCx+AA9sp37UTQgQFA1yH0BDACyMoHy//J0AGBAQj0Cm+hMYAIBIA4PABmtznaiaEAga5Drhf/AABmvHfaiaEAQa5DrhY/AAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVA==';
/** the only send mode this wallet signs: PAY_GAS_SEPARATELY (1) + IGNORE_ERRORS (2). 32 (destroy) and 128 (send everything) are never signed. */
export const TON_SEND_MODE = 3;
/** longest validity window (validUntil - createdAt) the signer accepts, in seconds */
export const TON_MAX_VALIDITY_SEC = 600;

const X_KEYS = ['bounce', 'sendMode', 'seqno', 'stateInit', 'validUntil']; // sorted
const UINT32_MAX = 0xffff_ffffn, COINS_MAX = (1n << 120n) - 1n;
const MAX_CELL_BITS = 1023, MAX_CELL_REFS = 4;
const TAG_BOUNCEABLE = 0x11, TAG_NON_BOUNCEABLE = 0x51, TAG_TESTNET = 0x80;
const enc = new TextEncoder();

const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => { let s = ''; for (const v of b) s += String.fromCharCode(v); return btoa(s); };
function unb64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('invalid base64');
  const raw = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (b64(raw) !== s) throw new Error('non-canonical base64');
  return raw;
}
function concat(...a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
}

// ---- cells ----

/** An ordinary (non-exotic, level 0) cell with its representation hash. */
export interface TonCell {
  /** data bytes; unused low bits of the last byte are zero */
  readonly data: Uint8Array;
  readonly bitLen: number;
  readonly refs: readonly TonCell[];
  readonly hash: Uint8Array;
  readonly depth: number;
}

/** data bytes with the completion tag (a 1 bit, then zeros) when the length is not a multiple of 8 */
function padded(data: Uint8Array, bitLen: number): Uint8Array {
  const out = Uint8Array.from(data.subarray(0, (bitLen + 7) >> 3));
  if (bitLen % 8 !== 0) out[out.length - 1] = (out[out.length - 1]! & (0xff << (8 - (bitLen % 8)))) | (0x80 >> (bitLen % 8));
  return out;
}

function makeCell(data: Uint8Array, bitLen: number, refs: readonly TonCell[]): TonCell {
  if (bitLen < 0 || bitLen > MAX_CELL_BITS || refs.length > MAX_CELL_REFS || data.length < (bitLen + 7) >> 3) throw new Error('cell overflow');
  const body = padded(data, bitLen);
  const clean = body.slice();
  if (bitLen % 8 !== 0) clean[clean.length - 1]! &= 0xff << (8 - (bitLen % 8)); // without the completion tag
  const depth = refs.length === 0 ? 0 : 1 + Math.max(...refs.map((r) => r.depth));
  if (depth > 1024) throw new Error('cell tree too deep');
  // representation: d1 (refs; ordinary, level 0), d2 (floor(bits/8) + ceil(bits/8)), padded data, depths, hashes
  const d = new Uint8Array([refs.length, (bitLen >> 3) + ((bitLen + 7) >> 3)]);
  const depths = new Uint8Array(refs.length * 2);
  refs.forEach((r, k) => { depths[2 * k] = r.depth >> 8; depths[2 * k + 1] = r.depth & 0xff; });
  const hash = sha256(concat(d, body, depths, ...refs.map((r) => r.hash)));
  return { data: clean, bitLen, refs: [...refs], hash, depth };
}

class CellBuilder {
  private buf = new Uint8Array(128);
  private len = 0;
  private refs: TonCell[] = [];
  get bits(): number { return this.len; }
  get refCount(): number { return this.refs.length; }
  get avail(): number { return MAX_CELL_BITS - this.len; }
  bit(v: boolean | number): this {
    if (this.len >= MAX_CELL_BITS) throw new Error('cell overflow');
    if (v) this.buf[this.len >> 3]! |= 0x80 >> (this.len & 7);
    this.len++;
    return this;
  }
  uint(v: bigint | number, n: number): this {
    const x = BigInt(v);
    if (x < 0n || x >> BigInt(n) !== 0n) throw new Error(`value does not fit in ${n} bits`);
    for (let k = n - 1; k >= 0; k--) this.bit(Number((x >> BigInt(k)) & 1n));
    return this;
  }
  bytes(b: Uint8Array): this { for (const v of b) this.uint(v, 8); return this; }
  /** Grams / Coins: VarUInteger 16 */
  coins(v: bigint): this {
    if (v < 0n || v > COINS_MAX) throw new Error('amount out of range');
    if (v === 0n) return this.uint(0, 4);
    const n = Math.ceil(v.toString(2).length / 8);
    return this.uint(n, 4).uint(v, n * 8);
  }
  /** MsgAddressInt addr_std$10, no anycast, workchain 0 */
  addr(hash: Uint8Array): this {
    if (hash.length !== 32) throw new Error('bad account id');
    return this.uint(0b100, 3).uint(0, 8).bytes(hash);
  }
  ref(c: TonCell): this {
    if (this.refs.length >= MAX_CELL_REFS) throw new Error('cell overflow');
    this.refs.push(c);
    return this;
  }
  /** append another cell's bits and references */
  append(c: TonCell): this {
    for (let k = 0; k < c.bitLen; k++) this.bit(c.data[k >> 3]! & (0x80 >> (k & 7)));
    for (const r of c.refs) this.ref(r);
    return this;
  }
  cell(): TonCell { return makeCell(this.buf.slice(0, (this.len + 7) >> 3), this.len, this.refs); }
}

function crc32c(b: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (const v of b) { crc ^= v; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1; }
  crc = (crc ^ 0xffffffff) >>> 0;
  return new Uint8Array([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24]); // little-endian
}
const BOC_MAGIC = [0xb5, 0xee, 0x9c, 0x72];

/**
 * Serialize one root cell as a bag of cells (serialized_boc#b5ee9c72, no index, CRC32-C). Cell order is the one @ton/core
 * emits (reverse post-order, references walked last to first, identical cells stored once), so the bytes are identical.
 */
export function tonSerializeBoc(root: TonCell): Uint8Array {
  const post: TonCell[] = [], seen = new Set<string>();
  const visit = (c: TonCell) => {
    const h = hexOf(c.hash);
    if (seen.has(h)) return;
    seen.add(h);
    for (let k = c.refs.length - 1; k >= 0; k--) visit(c.refs[k]!);
    post.push(c);
  };
  visit(root);
  const order = post.reverse();
  if (order.length > 255) throw new Error('too many cells');
  const index = new Map(order.map((c, k) => [hexOf(c.hash), k]));
  const cells = order.map((c) => concat(new Uint8Array([c.refs.length, (c.bitLen >> 3) + ((c.bitLen + 7) >> 3)]), padded(c.data, c.bitLen), new Uint8Array(c.refs.map((r) => index.get(hexOf(r.hash))!))));
  const total = cells.reduce((n, c) => n + c.length, 0);
  const offBytes = total < 0x100 ? 1 : total < 0x10000 ? 2 : 3;
  const size = new Uint8Array(offBytes);
  for (let k = 0; k < offBytes; k++) size[k] = (total >> (8 * (offBytes - 1 - k))) & 0xff;
  // flags byte: has_idx 0, has_crc32c 1, has_cache_bits 0, flags 00, ref size 001
  const body = concat(new Uint8Array([...BOC_MAGIC, 0x41, offBytes, order.length, 1, 0]), size, new Uint8Array([0]), ...cells);
  return concat(body, crc32c(body));
}

/**
 * Parse a bag of cells with exactly one root made only of ordinary cells (anything else throws). Used for the pinned wallet
 * code and, by the API, for account data and message bodies returned by its data sources.
 */
export function tonParseBoc(src: Uint8Array): TonCell {
  let o = 0;
  const need = (n: number) => { if (n < 0 || o + n > src.length) throw new Error('truncated bag of cells'); };
  const u = (n: number): number => { need(n); let v = 0; for (let k = 0; k < n; k++) v = v * 256 + src[o++]!; return v; };
  if (src.length < 10 || BOC_MAGIC.some((m, k) => src[k] !== m)) throw new Error('not a bag of cells');
  o = 4;
  const flags = u(1), hasIdx = (flags & 0x80) !== 0, hasCrc = (flags & 0x40) !== 0, refSize = flags & 7;
  if ((flags & 0x38) !== 0 || refSize < 1 || refSize > 2) throw new Error('unsupported bag of cells');
  const offBytes = u(1);
  if (offBytes < 1 || offBytes > 4) throw new Error('unsupported bag of cells');
  const count = u(refSize), roots = u(refSize), absent = u(refSize), total = u(offBytes);
  if (roots !== 1 || absent !== 0 || count < 1 || count > 4096) throw new Error('unsupported bag of cells');
  const rootIdx = u(refSize);
  if (rootIdx !== 0) throw new Error('unsupported bag of cells');
  if (hasIdx) { need(count * offBytes); o += count * offBytes; }
  if (src.length !== o + total + (hasCrc ? 4 : 0)) throw new Error('bag of cells length mismatch');
  if (hasCrc && crc32c(src.subarray(0, src.length - 4)).some((v, k) => v !== src[src.length - 4 + k])) throw new Error('bag of cells checksum mismatch');
  const raw: { data: Uint8Array; bitLen: number; refs: number[] }[] = [];
  for (let k = 0; k < count; k++) {
    const d1 = u(1), d2 = u(1);
    if (d1 > MAX_CELL_REFS) throw new Error('unsupported cell (exotic, with level or stored hashes)');
    const bytes = (d2 + 1) >> 1;
    need(bytes);
    const data = Uint8Array.from(src.subarray(o, o + bytes)); // a copy even when src is a Node Buffer (whose slice() is a view)
    o += bytes;
    let bitLen = bytes * 8;
    if (d2 & 1) { // not byte-aligned: strip the completion tag
      const last = data[bytes - 1]!;
      if (last === 0) throw new Error('bad cell padding');
      const tz = 31 - Math.clz32(last & -last);
      bitLen = bytes * 8 - tz - 1;
      data[bytes - 1] = last & ~(1 << tz);
    }
    const refs: number[] = [];
    for (let r = 0; r < d1; r++) { const idx = u(refSize); if (idx <= k || idx >= count) throw new Error('bad cell reference'); refs.push(idx); }
    raw.push({ data, bitLen, refs });
  }
  if (o !== src.length - (hasCrc ? 4 : 0)) throw new Error('bag of cells length mismatch');
  const built: TonCell[] = new Array(count);
  for (let k = count - 1; k >= 0; k--) built[k] = makeCell(raw[k]!.data, raw[k]!.bitLen, raw[k]!.refs.map((r) => built[r]!));
  return built[0]!;
}

/** read `n` bits (n <= 48) at bit offset `at` of a cell */
function readUint(c: TonCell, at: number, n: number): number {
  if (at < 0 || n > 48 || at + n > c.bitLen) throw new Error('cell underflow');
  let v = 0;
  for (let k = at; k < at + n; k++) v = v * 2 + (c.data[k >> 3]! & (0x80 >> (k & 7)) ? 1 : 0);
  return v;
}
function readBytes(c: TonCell, at: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = readUint(c, at + 8 * k, 8);
  return out;
}

// ---- wallet v4R2 ----

let codeCell: TonCell | undefined;
/** the wallet v4R2 code cell; throws unless the embedded constant hashes to the well-known code hash */
export function tonV4R2Code(): TonCell {
  if (!codeCell) {
    const c = tonParseBoc(unb64(TON_V4R2_CODE_BOC));
    if (hexOf(c.hash) !== TON_V4R2_CODE_HASH) throw new Error('wallet v4R2 code does not match its pinned hash');
    codeCell = c;
  }
  return codeCell;
}

const pubkeyOf = (publicKey: Uint8Array) => { if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes'); return publicKey; };
/** initial data of a v4R2 wallet: seqno 0, subwallet id, public key, empty plugin dictionary */
const walletData = (publicKey: Uint8Array) => new CellBuilder().uint(0, 32).uint(TON_SUBWALLET_ID, 32).bytes(pubkeyOf(publicKey)).bit(0).cell();
/** StateInit: no split_depth, no special, code, data, no libraries */
export const tonStateInit = (publicKey: Uint8Array): TonCell => new CellBuilder().uint(0b00110, 5).ref(tonV4R2Code()).ref(walletData(publicKey)).cell();
/** 32-byte account id of the v4R2 wallet of a public key (workchain 0) */
export const tonAccountId = (publicKey: Uint8Array): Uint8Array => tonStateInit(publicKey).hash;

/** Decode the persistent data of a deployed v4R2 wallet (as returned by a data source). */
export function tonWalletData(data: TonCell): { seqno: number; subwalletId: number; publicKey: Uint8Array; plugins: boolean } {
  if (data.bitLen !== 321) throw new Error('not wallet v4 data');
  const plugins = readUint(data, 320, 1) === 1;
  if (data.refs.length !== (plugins ? 1 : 0)) throw new Error('not wallet v4 data');
  return { seqno: readUint(data, 0, 32), subwalletId: readUint(data, 32, 32), publicKey: readBytes(data, 64, 32), plugins };
}

// ---- addresses ----

function crc16xmodem(b: Uint8Array): number {
  let crc = 0;
  for (const byte of b) {
    crc ^= byte << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** User-friendly address of a workchain-0 account: URL-safe base64 of tag | workchain | account id | CRC16. */
export function tonFormatAddress(accountId: Uint8Array, opts: { bounceable?: boolean } = {}): string {
  if (accountId.length !== 32) throw new Error('bad account id');
  const body = new Uint8Array(36);
  body[0] = opts.bounceable ? TAG_BOUNCEABLE : TAG_NON_BOUNCEABLE;
  body[1] = 0; // workchain 0
  body.set(accountId, 2);
  const crc = crc16xmodem(body.subarray(0, 34));
  body[34] = crc >> 8; body[35] = crc & 0xff; // big-endian
  return b64(body).replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Decode a destination: user-friendly "EQ…" / "UQ…" (base64 or base64url) or raw "0:<64 hex>". Returns the 32-byte account id.
 * Refused: testnet-only addresses, any workchain other than 0, bad checksums, and the all-zero account.
 */
export function tonParseAddress(addr: string): Uint8Array {
  if (typeof addr !== 'string') throw new Error('invalid TON address');
  let id: Uint8Array;
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(addr);
  if (raw) {
    if (raw[1] !== '0') throw new Error('only workchain 0 (basechain) addresses are supported');
    id = Uint8Array.from(raw[2]!.match(/../g)!, (h) => parseInt(h, 16));
  } else {
    if (!/^[A-Za-z0-9_\-+/]{48}$/.test(addr)) throw new Error('invalid TON address: expected 48 characters (EQ… / UQ…) or 0:<64 hex>');
    if (/[-_]/.test(addr) && /[+/]/.test(addr)) throw new Error('invalid TON address: mixed base64 alphabets');
    let b: Uint8Array;
    try { b = unb64(addr.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new Error('invalid TON address encoding'); }
    if (b.length !== 36) throw new Error('invalid TON address length');
    const crc = crc16xmodem(b.subarray(0, 34));
    if (b[34] !== crc >> 8 || b[35] !== (crc & 0xff)) throw new Error('invalid TON address checksum');
    const tag = b[0]!;
    if (tag & TAG_TESTNET) throw new Error('this is a testnet-only TON address');
    if (tag !== TAG_BOUNCEABLE && tag !== TAG_NON_BOUNCEABLE) throw new Error('invalid TON address flags');
    if (b[1] !== 0) throw new Error('only workchain 0 (basechain) addresses are supported');
    id = b.slice(2, 34);
  }
  if (id.every((v) => v === 0)) throw new Error('the zero address cannot receive funds');
  return id;
}

/** canonical form used in intents: non-bounceable, URL-safe */
export const tonNormalizeAddress = (addr: string): string => tonFormatAddress(tonParseAddress(addr));
/** raw "0:<hex>" form, for data-source queries */
export const tonRawAddress = (addr: string): string => '0:' + hexOf(tonParseAddress(addr));
/** the wallet's own address (shown non-bounceable so that a first deposit to the not-yet-deployed contract is not bounced back) */
export const tonAddressOf = (publicKey: Uint8Array): string => tonFormatAddress(tonAccountId(publicKey));
function canonicalId(addr: string, what: string): Uint8Array {
  const id = tonParseAddress(addr);
  if (tonFormatAddress(id) !== addr) throw new Error(`${what} address is not in canonical form (non-bounceable UQ…)`);
  return id;
}

// ---- messages ----

/** UTF-8 bytes of a text comment; throws on an empty or ill-formed string */
export function tonCommentBytes(memo: string): Uint8Array {
  if (typeof memo !== 'string' || memo.length === 0) throw new Error('empty comment');
  const bytes = enc.encode(memo);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== memo) throw new Error('comment is not valid Unicode text');
  return bytes;
}
/** text comment body: op 0 then the UTF-8 text, continued in a chain of references when it does not fit ("snake") */
function commentCell(bytes: Uint8Array): TonCell {
  const fill = (b: CellBuilder, rest: Uint8Array): TonCell => {
    const fit = Math.floor(b.avail / 8);
    if (rest.length <= fit) return b.bytes(rest).cell();
    return b.bytes(rest.subarray(0, fit)).ref(fill(new CellBuilder(), rest.subarray(fit))).cell();
  };
  return fill(new CellBuilder().uint(0, 32), bytes);
}

export interface TonTransfer { to: Uint8Array; amount: bigint; comment?: Uint8Array; seqno: number; validUntil: number; bounce: boolean }

/** int_msg_info$0 ihr_disabled:1 bounce bounced:0 src:addr_none dest value no-extra ihr_fee:0 fwd_fee:0 created_lt:0 created_at:0, no init, body */
function internalMessage(t: TonTransfer): TonCell {
  if (t.amount <= 0n) throw new Error('amount must be positive');
  const b = new CellBuilder().bit(0).bit(1).bit(t.bounce).bit(0).uint(0, 2).addr(t.to).coins(t.amount).bit(0).coins(0n).coins(0n).uint(0, 64).uint(0, 32).bit(0);
  if (!t.comment) return b.bit(0).cell(); // empty body, stored in place
  const body = commentCell(t.comment);
  // same placement rule as the reference encoder: in place when it fits, otherwise in a reference
  if (b.avail - 1 >= body.bitLen && b.refCount + body.refs.length <= MAX_CELL_REFS) return b.bit(0).append(body).cell();
  return b.bit(1).ref(body).cell();
}

/** The v4 signing message. Its representation hash is what ed25519 signs. */
export function tonSigningMessage(t: TonTransfer): TonCell {
  return new CellBuilder().uint(TON_SUBWALLET_ID, 32).uint(t.validUntil, 32).uint(t.seqno, 32).uint(0, 8).uint(TON_SEND_MODE, 8).ref(internalMessage(t)).cell();
}
/** message body: signature, then the signing message */
export function tonSignedBody(signing: TonCell, signature: Uint8Array): TonCell {
  if (signature.length !== 64) throw new Error('bad signature length');
  return new CellBuilder().bytes(signature).append(signing).cell();
}
const extInfo = (accountId: Uint8Array) => new CellBuilder().uint(0b10, 2).uint(0, 2).addr(accountId).coins(0n); // ext_in_msg_info$10 src:addr_none dest import_fee:0

/** External message to the wallet, optionally carrying its StateInit; laid out exactly as @ton/core's storeMessage does. */
export function tonExternalMessage(accountId: Uint8Array, body: TonCell, stateInit?: TonCell): TonCell {
  const b = extInfo(accountId);
  if (stateInit) {
    b.bit(1);
    if (b.avail - 2 < stateInit.bitLen + body.bitLen) b.bit(1).ref(stateInit);
    else b.bit(0).append(stateInit);
  } else b.bit(0);
  if (b.avail - 1 < body.bitLen || b.refCount + body.refs.length > MAX_CELL_REFS) return b.bit(1).ref(body).cell();
  return b.bit(0).append(body).cell();
}
/**
 * Normalized hash of an external-in message (TEP-467): no source, import fee 0, no StateInit, body in a reference. It is the
 * same whether or not the StateInit was attached and however a node re-packs the envelope; explorers and indexers use it.
 */
export const tonNormalizedHash = (accountId: Uint8Array, body: TonCell): Uint8Array => extInfo(accountId).bit(0).bit(1).ref(body).cell().hash;

/** Read back an external message built by this module (or the reference SDK): destination, body, whether a StateInit is attached, both hashes. */
export function tonReadExternal(rawBase64: string): { accountId: Uint8Array; body: TonCell; stateInit: boolean; cellHash: string; txid: string } {
  const m = tonParseBoc(unb64(rawBase64));
  // ext_in_msg_info$10, src addr_none$00, dest addr_std$10 without anycast in workchain 0, import_fee 0
  if (readUint(m, 0, 7) !== 0b1000100 || readUint(m, 7, 8) !== 0 || readUint(m, 271, 4) !== 0) throw new Error('not an external message to a basechain wallet');
  const accountId = readBytes(m, 15, 32);
  let at = 275, ref = 0, stateInit = false;
  if (readUint(m, at++, 1)) {
    stateInit = true;
    if (readUint(m, at++, 1)) ref++;
    else { if (readUint(m, at, 5) !== 0b00110) throw new Error('unsupported StateInit'); at += 5; ref += 2; }
  }
  let body: TonCell;
  if (readUint(m, at++, 1)) {
    if (at !== m.bitLen || m.refs.length !== ref + 1) throw new Error('malformed external message');
    body = m.refs[ref]!;
  } else {
    const b = new CellBuilder();
    for (let k = at; k < m.bitLen; k++) b.bit(readUint(m, k, 1));
    for (const r of m.refs.slice(ref)) b.ref(r);
    body = b.cell();
  }
  return { accountId, body, stateInit, cellHash: hexOf(m.hash), txid: hexOf(tonNormalizedHash(accountId, body)) };
}

const canonicalInt = (name: string, s: string | undefined, min: bigint, max: bigint): bigint => {
  if (s === undefined || !/^(0|[1-9]\d{0,19})$/.test(s)) throw new Error(`x.${name} must be a canonical decimal integer`);
  const v = BigInt(s);
  if (v < min || v > max) throw new Error(`x.${name} out of range`);
  return v;
};
const flag = (name: string, s: string | undefined): boolean => {
  if (s !== '0' && s !== '1') throw new Error(`x.${name} must be "0" or "1"`);
  return s === '1';
};

export interface TonBuilt {
  /** account id of the sending wallet */
  from: Uint8Array;
  /** the v4 signing message */
  signing: TonCell;
  /** its representation hash: the 32 bytes ed25519 signs */
  hash: Uint8Array;
  /** the wallet's StateInit must be attached (first outgoing transfer) */
  stateInit: boolean;
  describe: Record<string, string>;
}

/** Rebuild the exact signing message from the intent alone. Throws on anything that is not a plain Toncoin transfer. */
export function buildTonTransfer(i: Intent, net: NetworkDef): TonBuilt {
  if (i.v !== 1) throw new Error('unsupported intent version');
  if (net.family !== 'ton' || i.network !== net.id) throw new Error('not a TON intent');
  if (net.chainRef !== TON_MAINNET_ZEROSTATE) throw new Error('unknown TON network: only the main network is supported');
  if (i.chainRef !== net.chainRef) throw new Error('chain identity mismatch (masterchain zero state)');
  if (i.evm || i.btc || i.sol) throw new Error('unexpected chain section in a TON intent');
  if (i.asset !== 'native' || net.native.id !== 'native') throw new Error('only native Toncoin can be sent on TON in this version');
  if (i.symbol !== net.native.symbol || i.decimals !== net.native.decimals || i.decimals !== 9) throw new Error('asset metadata mismatch');
  const x = i.x;
  if (!x) throw new Error('missing TON parameters');
  const keys = Object.keys(x).sort();
  if (keys.length !== X_KEYS.length || keys.some((k, n) => k !== X_KEYS[n])) throw new Error('unknown or missing TON parameter (expected bounce, sendMode, seqno, stateInit, validUntil)');

  const from = canonicalId(i.from, 'source'), to = canonicalId(i.to, 'destination');
  if (i.from === i.to) throw new Error('destination equals source');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount > COINS_MAX) throw new Error('amount out of range');
  if (baseUnits(i.maxFee) <= 0n) throw new Error('fee budget must be positive');

  const seqno = canonicalInt('seqno', x.seqno, 0n, UINT32_MAX - 1n);
  const validUntil = canonicalInt('validUntil', x.validUntil, 1n, UINT32_MAX - 1n);
  if (validUntil <= BigInt(i.createdAt)) throw new Error('valid_until is not after the intent creation time');
  if (validUntil < BigInt(i.expiresAt)) throw new Error('valid_until ends before the approval window');
  if (validUntil > BigInt(i.createdAt) + BigInt(TON_MAX_VALIDITY_SEC)) throw new Error('valid_until too far in the future');
  if (x.sendMode !== String(TON_SEND_MODE)) throw new Error(`x.sendMode must be "${TON_SEND_MODE}" (pay fees separately, ignore errors)`);
  const bounce = flag('bounce', x.bounce), stateInit = flag('stateInit', x.stateInit);
  if (stateInit && seqno !== 0n) throw new Error('the wallet StateInit can only be attached to its first message (seqno 0)');
  const comment = i.memo === undefined ? undefined : tonCommentBytes(i.memo);

  const signing = tonSigningMessage({ to, amount, comment, seqno: Number(seqno), validUntil: Number(validUntil), bounce });
  return {
    from, signing, hash: signing.hash, stateInit,
    describe: {
      network: net.name, operation: 'Transfer (native TON, wallet v4R2)', from: i.from, to: i.to, amountNano: amount.toString(), seqno: seqno.toString(),
      validUntil: validUntil.toString(), bounce: bounce ? 'yes' : 'no', sendMode: x.sendMode, deploysWallet: stateInit ? 'yes' : 'no', comment: i.memo ?? '', signingHash: hexOf(signing.hash),
    },
  };
}

export const tonPlugin: FamilyPlugin = {
  family: 'ton',
  curve: 'ed25519',
  path(net: NetworkDef): string {
    if (net.coinType !== 607) throw new Error('TON derivation requires coin type 607');
    return "m/44'/607'/0'";
  },
  address: (_net: NetworkDef, publicKey: Uint8Array) => tonAddressOf(publicKey),
  normalizeAddress: (_net: NetworkDef, addr: string) => tonNormalizeAddress(addr),
  build(i: Intent, net: NetworkDef) {
    const b = buildTonTransfer(i, net);
    return { signDocs: [b.hash], describe: b.describe };
  },
  sign(i: Intent, net: NetworkDef, key: KeyHandle): Signed {
    const b = buildTonTransfer(i, net);
    if (key.curve !== 'ed25519' || !key.signMessage || key.publicKey.length !== 32) throw new Error('TON needs an ed25519 key');
    // the address commits to the code, the subwallet id and this public key
    if (tonAddressOf(key.publicKey) !== i.from) throw new Error('signing key does not control the source wallet');
    const sig = key.signMessage(b.hash);
    if (sig.length !== 64 || !ed25519.verify(sig, b.hash, key.publicKey)) throw new Error('signature self-check failed');
    const body = tonSignedBody(b.signing, sig);
    const message = tonExternalMessage(b.from, body, b.stateInit ? tonStateInit(key.publicKey) : undefined);
    return { raw: b64(tonSerializeBoc(message)), txid: hexOf(tonNormalizedHash(b.from, body)) };
  },
};

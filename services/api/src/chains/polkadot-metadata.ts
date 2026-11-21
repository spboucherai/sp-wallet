/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/polkadot-metadata.ts
 * Module           : chains
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

// Substrate runtime metadata (version 14, what `state_getMetadata` returns) — a reader written by hand for exactly what the
// Polkadot adapter relies on: the type registry, the pallets (calls, events, storage, constants) and the list of transaction
// extensions. It also decodes any SCALE value from its type id (used for System.Events and System.Account) and computes
// storage keys. API side only: nothing here is in the signer.
// Format: frame-metadata `RuntimeMetadataV14` + scale-info `PortableRegistry`
// (https://github.com/paritytech/frame-metadata/blob/main/frame-metadata/src/v14.rs, https://github.com/paritytech/scale-info).
// Proven against @polkadot/types on the live Asset Hub metadata in services/api/test/polkadot-adapter.test.ts.
import { blake2b } from '@noble/hashes/blake2.js';
import { ScaleReader } from '@spw/core';

export type TypeDef =
  | { kind: 'composite'; fields: Field[] }
  | { kind: 'variant'; variants: { name: string; index: number; fields: Field[] }[] }
  | { kind: 'sequence'; of: number }
  | { kind: 'array'; len: number; of: number }
  | { kind: 'tuple'; of: number[] }
  | { kind: 'primitive'; name: string }
  | { kind: 'compact'; of: number }
  | { kind: 'bits'; store: number; order: number };
export interface Field { name: string | null; type: number; typeName: string | null }
export interface PortableType { path: string[]; params: { name: string; type: number | null }[]; def: TypeDef }
export interface StorageEntry { name: string; modifier: number; hashers: number[]; key: number | null; value: number }
export interface Pallet { name: string; index: number; calls: number | null; events: number | null; storage: StorageEntry[]; constants: { name: string; type: number; value: Uint8Array }[] }
export interface Metadata { types: PortableType[]; pallets: Pallet[]; extrinsic: { type: number; version: number; extensions: { id: string; type: number; implicit: number }[] } }

const PRIMITIVES = ['bool', 'char', 'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'u256', 'i8', 'i16', 'i32', 'i64', 'i128', 'i256'];
const PRIMITIVE_SIZE: Record<string, number> = { bool: 1, char: 4, u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32, i8: 1, i16: 2, i32: 4, i64: 8, i128: 16, i256: 32 };
const dec = new TextDecoder('utf-8', { fatal: true });

/** Parse `RuntimeMetadataPrefixed` (magic "meta", version 14). Throws on any other version or a malformed document. */
export function parseMetadata(bytes: Uint8Array): Metadata {
  const r = new ScaleReader(bytes);
  if (r.uint(4) !== 0x6174656dn) throw new Error('metadata: bad magic');
  if (r.u8() !== 14) throw new Error('metadata: unsupported version (expected 14)');
  const count = (): number => { const n = r.compact(); if (n > BigInt(bytes.length)) throw new Error('metadata: bad length'); return Number(n); };
  const vec = <T>(f: () => T): T[] => { const n = count(), out: T[] = []; for (let k = 0; k < n; k++) out.push(f()); return out; };
  const str = (): string => dec.decode(r.take(count()));
  const opt = <T>(f: () => T): T | null => { const b = r.u8(); if (b === 0) return null; if (b !== 1) throw new Error('metadata: bad option'); return f(); };
  const id = (): number => Number(r.compact());
  const docs = () => { vec(str); };
  const field = (): Field => { const name = opt(str), type = id(), typeName = opt(str); docs(); return { name, type, typeName }; };
  const typeDef = (): TypeDef => {
    const tag = r.u8();
    if (tag === 0) return { kind: 'composite', fields: vec(field) };
    if (tag === 1) return { kind: 'variant', variants: vec(() => { const name = str(), fields = vec(field), index = r.u8(); docs(); return { name, index, fields }; }) };
    if (tag === 2) return { kind: 'sequence', of: id() };
    if (tag === 3) { const len = Number(r.uint(4)); return { kind: 'array', len, of: id() }; }
    if (tag === 4) return { kind: 'tuple', of: vec(id) };
    if (tag === 5) { const p = PRIMITIVES[r.u8()]; if (!p) throw new Error('metadata: unknown primitive'); return { kind: 'primitive', name: p }; }
    if (tag === 6) return { kind: 'compact', of: id() };
    if (tag === 7) return { kind: 'bits', store: id(), order: id() };
    throw new Error('metadata: unknown type definition');
  };
  const types: PortableType[] = [];
  const n = count();
  for (let k = 0; k < n; k++) {
    if (id() !== k) throw new Error('metadata: type ids are not sequential');
    const path = vec(str), params = vec(() => ({ name: str(), type: opt(id) })), def = typeDef();
    docs();
    types.push({ path, params, def });
  }
  const pallets = vec((): Pallet => {
    const name = str();
    const storage = opt(() => { str(); return vec((): StorageEntry => {
      const sname = str(), modifier = r.u8(), tag = r.u8();
      let hashers: number[] = [], key: number | null = null, value: number;
      if (tag === 0) value = id(); else if (tag === 1) { hashers = vec(() => r.u8()); key = id(); value = id(); } else throw new Error('metadata: bad storage entry');
      r.take(count()); docs();
      return { name: sname, modifier, hashers, key, value };
    }); }) ?? [];
    const calls = opt(id), events = opt(id);
    const constants = vec(() => { const cname = str(), type = id(), value = r.take(count()).slice(); docs(); return { name: cname, type, value }; });
    opt(id); // errors
    return { name, index: r.u8(), calls, events, storage, constants };
  });
  const type = id(), version = r.u8();
  const extensions = vec(() => ({ id: str(), type: id(), implicit: id() }));
  id(); // runtime type
  if (!r.done) throw new Error('metadata: trailing bytes');
  const check = (t: number) => { if (!Number.isInteger(t) || t < 0 || t >= types.length) throw new Error('metadata: dangling type id'); };
  for (const e of extensions) { check(e.type); check(e.implicit); }
  return { types, pallets, extrinsic: { type, version, extensions } };
}

/**
 * Canonical text of a type, used to compare what the node declares with what was reviewed. Rules: primitives by name;
 * Compact<T>, Vec<T>, [T;n], tuples structurally ("()" for a zero-sized type); Option<T>; any other enum by its name;
 * a struct as Name{field:type,…} when it is the type itself or one of its direct fields, by its name deeper down.
 */
export function renderType(m: Metadata, id: number, depth = 0): string {
  const t = m.types[id];
  if (!t) throw new Error('metadata: dangling type id');
  const name = t.path[t.path.length - 1] ?? '', d = t.def;
  if (d.kind === 'primitive') return d.name;
  if (d.kind === 'compact') return `Compact<${renderType(m, d.of, depth + 1)}>`;
  if (d.kind === 'sequence') return `Vec<${renderType(m, d.of, depth + 1)}>`;
  if (d.kind === 'array') return `[${renderType(m, d.of, depth + 1)};${d.len}]`;
  if (d.kind === 'tuple') return d.of.length === 0 ? '()' : `(${d.of.map((x) => renderType(m, x, depth + 1)).join(',')})`;
  if (d.kind === 'bits') return 'BitVec';
  if (d.kind === 'variant') {
    if (name === 'Option' && t.path.length === 1 && d.variants.length === 2 && d.variants[1]!.fields.length === 1) return `Option<${renderType(m, d.variants[1]!.fields[0]!.type, depth + 1)}>`;
    return name || 'enum';
  }
  if (d.fields.length === 0) return '()';
  if (depth > 1 && name) return name;
  return `${name}{${d.fields.map((f) => (f.name ? f.name + ':' : '') + renderType(m, f.type, depth + 1)).join(',')}}`;
}
export const renderFields = (m: Metadata, fields: Field[]): string => fields.map((f) => (f.name ? f.name + ':' : '') + renderType(m, f.type, 1)).join(',');

export const palletOf = (m: Metadata, name: string): Pallet => { const p = m.pallets.find((x) => x.name === name); if (!p) throw new Error(`metadata: no ${name} pallet`); return p; };
export function variantsOf(m: Metadata, id: number | null): { name: string; index: number; fields: Field[] }[] {
  const t = id === null ? undefined : m.types[id];
  if (!t || t.def.kind !== 'variant') throw new Error('metadata: expected an enum');
  return t.def.variants;
}
/** First type whose path ends with the given segments (e.g. ['OriginCaller']). */
export function typeByPath(m: Metadata, ...tail: string[]): number {
  const k = m.types.findIndex((t) => t.path.length >= tail.length && tail.every((s, n) => t.path[t.path.length - tail.length + n] === s));
  if (k < 0) throw new Error(`metadata: no type ${tail.join('::')}`);
  return k;
}

export type Value = bigint | number | boolean | string | Uint8Array | null | Value[] | { [k: string]: Value };
/** Decode one SCALE value of the given type. Enums become { variant, index, value }; byte arrays and Vec<u8> become Uint8Array. */
export function decodeValue(m: Metadata, id: number, r: ScaleReader, depth = 0): Value {
  if (depth > 96) throw new Error('scale: value nested too deeply');
  const t = m.types[id];
  if (!t) throw new Error('metadata: dangling type id');
  const d = t.def;
  const fields = (fs: Field[]): Value => {
    if (fs.length === 0) return null;
    if (fs.every((f) => f.name !== null)) return Object.fromEntries(fs.map((f) => [f.name!, decodeValue(m, f.type, r, depth + 1)]));
    const vs = fs.map((f) => decodeValue(m, f.type, r, depth + 1));
    return vs.length === 1 ? vs[0]! : vs;
  };
  const isU8 = (x: number) => { const e = m.types[x]?.def; return e?.kind === 'primitive' && e.name === 'u8'; };
  switch (d.kind) {
    case 'primitive': {
      if (d.name === 'bool') { const b = r.u8(); if (b > 1) throw new Error('scale: bad bool'); return b === 1; }
      if (d.name === 'str') return dec.decode(r.take(Number(r.compact())));
      const n = PRIMITIVE_SIZE[d.name]!;
      const v = r.uint(n);
      return d.name.startsWith('i') && v >> BigInt(8 * n - 1) ? v - (1n << BigInt(8 * n)) : v;
    }
    case 'compact': { const inner = m.types[d.of]?.def; if (inner && ((inner.kind === 'tuple' && inner.of.length === 0) || (inner.kind === 'composite' && inner.fields.length === 0))) return null; return r.compact(); }
    case 'sequence': { const n = Number(r.compact()); if (isU8(d.of)) return r.take(n).slice(); const out: Value[] = []; for (let k = 0; k < n; k++) out.push(decodeValue(m, d.of, r, depth + 1)); return out; }
    case 'array': { if (isU8(d.of)) return r.take(d.len).slice(); const out: Value[] = []; for (let k = 0; k < d.len; k++) out.push(decodeValue(m, d.of, r, depth + 1)); return out; }
    case 'tuple': return d.of.map((x) => decodeValue(m, x, r, depth + 1));
    case 'composite': return fields(d.fields);
    case 'variant': { const ix = r.u8(), v = d.variants.find((x) => x.index === ix); if (!v) throw new Error('scale: unknown enum variant'); return { variant: v.name, index: ix, value: fields(v.fields) }; }
    case 'bits': {
      const store = m.types[d.store]?.def, unit = store?.kind === 'primitive' ? PRIMITIVE_SIZE[store.name] ?? 1 : 1;
      const bits = Number(r.compact());
      return r.take(Math.ceil(bits / (8 * unit)) * unit).slice();
    }
  }
}

// ---------------------------------------------------------------- storage keys
const M64 = (1n << 64n) - 1n, P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n, P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (v: bigint, n: bigint) => ((v << n) | (v >> (64n - n))) & M64;
const rd = (b: Uint8Array, o: number, n: number): bigint => { let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[o + k]!); return v; };
/** XXH64 (https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md). */
export function xxhash64(input: Uint8Array, seed: bigint): bigint {
  const round = (acc: bigint, lane: bigint) => (rotl((acc + lane * P2) & M64, 31n) * P1) & M64;
  let o = 0, h: bigint;
  if (input.length >= 32) {
    let v1 = (seed + P1 + P2) & M64, v2 = (seed + P2) & M64, v3 = seed, v4 = (seed - P1) & M64;
    for (; o + 32 <= input.length; o += 32) { v1 = round(v1, rd(input, o, 8)); v2 = round(v2, rd(input, o + 8, 8)); v3 = round(v3, rd(input, o + 16, 8)); v4 = round(v4, rd(input, o + 24, 8)); }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    for (const v of [v1, v2, v3, v4]) h = (((h ^ round(0n, v)) * P1) + P4) & M64;
  } else h = (seed + P5) & M64;
  h = (h + BigInt(input.length)) & M64;
  for (; o + 8 <= input.length; o += 8) h = ((rotl(h ^ round(0n, rd(input, o, 8)), 27n) * P1) + P4) & M64;
  if (o + 4 <= input.length) { h = ((rotl(h ^ ((rd(input, o, 4) * P1) & M64), 23n) * P2) + P3) & M64; o += 4; }
  for (; o < input.length; o++) h = (rotl(h ^ ((BigInt(input[o]!) * P5) & M64), 11n) * P1) & M64;
  h ^= h >> 33n; h = (h * P2) & M64; h ^= h >> 29n; h = (h * P3) & M64; h ^= h >> 32n;
  return h;
}
const le64 = (v: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
/** twox128(text): the hash of pallet and storage item names in a storage key. */
export function twox128(text: string): Uint8Array {
  const b = new TextEncoder().encode(text), out = new Uint8Array(16);
  out.set(le64(xxhash64(b, 0n)), 0); out.set(le64(xxhash64(b, 1n)), 8);
  return out;
}
/** Storage key (0x hex) of a plain item, or of a map entry hashed with Blake2_128Concat. */
export function storageKey(pallet: string, item: string, blake2_128ConcatKey?: Uint8Array): string {
  return '0x' + hexOf(twox128(pallet)) + hexOf(twox128(item)) + (blake2_128ConcatKey ? hexOf(blake2b(blake2_128ConcatKey, { dkLen: 16 })) + hexOf(blake2_128ConcatKey) : '');
}

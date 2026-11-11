// MessagePack encoder for Hyperliquid L1 actions — only what an action can contain: nil, booleans, integers, strings, arrays and
// maps with string keys, written in INSERTION ORDER (the venue hashes the bytes, so key order is part of the signature).
// Written here instead of adding `@msgpack/msgpack`: ~60 lines, no new dependency on the signing path, and the refusal of floats,
// undefined and non-string keys is exactly what is wanted for a signed payload. Byte-for-byte equal to Python `msgpack.packb`
// (the official SDK) for these types — proven by the SDK signing vectors in test/hyperliquid/signing.test.ts.
// Format: https://github.com/msgpack/msgpack/blob/master/spec.md

export type MsgpackValue = null | boolean | number | string | MsgpackValue[] | { [key: string]: MsgpackValue };

const utf8 = new TextEncoder();

function header(out: number[], n: number, fix: [base: number, max: number] | null, b8: number | null, b16: number, b32: number): void {
  if (fix && n <= fix[1]) out.push(fix[0] | n);
  else if (b8 !== null && n <= 0xff) out.push(b8, n);
  else if (n <= 0xffff) out.push(b16, n >>> 8, n & 0xff);
  else if (n <= 0xffffffff) out.push(b32, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else throw new Error('msgpack: container too large');
}

function be(out: number[], v: bigint, bytes: number): void {
  for (let i = bytes - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
}

function int(out: number[], n: number): void {
  if (!Number.isSafeInteger(n)) throw new Error('msgpack: only safe integers are allowed (no floats in a signed action)');
  if (n >= 0) {
    if (n <= 0x7f) out.push(n);
    else if (n <= 0xff) out.push(0xcc, n);
    else if (n <= 0xffff) { out.push(0xcd); be(out, BigInt(n), 2); }
    else if (n <= 0xffffffff) { out.push(0xce); be(out, BigInt(n), 4); }
    else { out.push(0xcf); be(out, BigInt(n), 8); }
  } else if (n >= -32) out.push(0x100 + n);
  else if (n >= -0x80) out.push(0xd0, 0x100 + n);
  else if (n >= -0x8000) { out.push(0xd1); be(out, BigInt.asUintN(16, BigInt(n)), 2); }
  else if (n >= -0x80000000) { out.push(0xd2); be(out, BigInt.asUintN(32, BigInt(n)), 4); }
  else { out.push(0xd3); be(out, BigInt.asUintN(64, BigInt(n)), 8); }
}

function write(out: number[], v: MsgpackValue, depth: number): void {
  if (depth > 16) throw new Error('msgpack: nesting too deep');
  if (v === null) { out.push(0xc0); return; }
  switch (typeof v) {
    case 'boolean': out.push(v ? 0xc3 : 0xc2); return;
    case 'number': int(out, v); return;
    case 'string': {
      const b = utf8.encode(v);
      header(out, b.length, [0xa0, 31], 0xd9, 0xda, 0xdb);
      for (const x of b) out.push(x);
      return;
    }
    case 'object': {
      if (Array.isArray(v)) {
        header(out, v.length, [0x90, 15], null, 0xdc, 0xdd);
        for (const x of v) write(out, x, depth + 1);
        return;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('msgpack: plain objects only');
      const keys = Object.keys(v); // insertion order for string keys; integer-like keys would be reordered by JS, refuse them
      for (const k of keys) if (/^(0|[1-9]\d*)$/.test(k)) throw new Error('msgpack: integer-like map keys would lose their order');
      header(out, keys.length, [0x80, 15], null, 0xde, 0xdf);
      for (const k of keys) { write(out, k, depth + 1); write(out, v[k] as MsgpackValue, depth + 1); }
      return;
    }
    default: throw new Error(`msgpack: unsupported value of type ${typeof v}`);
  }
}

export function msgpackEncode(v: MsgpackValue): Uint8Array {
  const out: number[] = [];
  write(out, v, 0);
  return Uint8Array.from(out);
}

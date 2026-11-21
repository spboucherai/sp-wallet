/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/src/bip32-ed25519.ts
 * Module           : services
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

// BIP32-Ed25519 as Cardano uses it (CIP-1852 wallets): NOT SLIP-0010.
//
// Sources (read 2026-11-11):
// - CIP-3 "Icarus" master key generation: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0003/Icarus.md
// - CIP-1852 paths (m/1852'/1815'/account'/role/index): https://github.com/cardano-foundation/CIPs/blob/master/CIP-1852/README.md
// - Khovratovich & Law, "BIP32-Ed25519: Hierarchical Deterministic Keys over a Non-linear Keyspace" (2017), in the "V2"
//   variant implemented by IOHK's cardano-crypto (cbits/encrypted_sign.c, `DERIVATION_V2`) and by every Shelley wallet.
//
// Extended private key = (kL, kR, c): kL is the Ed25519 scalar (32 bytes, little-endian, already clamped — it is NOT hashed
// again when signing), kR the 32-byte nonce key, c the 32-byte chain code. Public key A = kL·G.
//
// Master key (Icarus):  PBKDF2-HMAC-SHA512(password = BIP-39 passphrase ("" here), salt = BIP-39 ENTROPY (not the BIP-39
//   seed), 4096 iterations, 96 bytes) = kL ‖ kR ‖ c, then kL[0] &= 0xF8, kL[31] &= 0x1F, kL[31] |= 0x40.
// Child i (V2), with i serialized as 4 bytes little-endian:
//   hardened (i ≥ 2^31):  Z = HMAC-SHA512(c, 0x00 ‖ kL ‖ kR ‖ i),  c' = right half of HMAC-SHA512(c, 0x01 ‖ kL ‖ kR ‖ i)
//   soft:                 Z = HMAC-SHA512(c, 0x02 ‖ A ‖ i),        c' = right half of HMAC-SHA512(c, 0x03 ‖ A ‖ i)
//   kL' = kL + 8 · ZL[0..28]   (little-endian integers, kept in 32 bytes; no reduction modulo the group order)
//   kR' = kR + ZR  mod 2^256
// Signature (standard Ed25519 with an already expanded key): r = SHA-512(kR ‖ M) mod ℓ, R = r·G,
//   S = r + SHA-512(R ‖ A ‖ M)·kL mod ℓ; the signature R ‖ S verifies with any RFC 8032 verifier.
//
// Proven in test/cardano.test.ts against the CIP-3 vector, published wallet vectors and the official
// cardano-serialization-lib (devDependency, tests only).
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';

export interface XPrv { kL: Uint8Array; kR: Uint8Array; chainCode: Uint8Array }

const L = ed25519.Point.Fn.ORDER;
const HARDENED = 0x80000000;
const leToBig = (b: Uint8Array): bigint => { let v = 0n; for (let k = b.length - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[k]!); return v; };
const bigToLe = (v: bigint, len: number): Uint8Array => { const out = new Uint8Array(len); for (let k = 0; k < len; k++) { out[k] = Number(v & 0xffn); v >>= 8n; } return out; };
const cat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const le32 = (i: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, i, true); return b; };

/** Icarus master key from BIP-39 entropy (16–32 bytes) and an optional passphrase. */
export function icarusMasterKey(entropy: Uint8Array, passphrase: Uint8Array = new Uint8Array(0)): XPrv {
  if (![16, 20, 24, 28, 32].includes(entropy.length)) throw new Error('BIP-39 entropy must be 16, 20, 24, 28 or 32 bytes');
  const d = pbkdf2(sha512, passphrase, entropy, { c: 4096, dkLen: 96 });
  d[0]! &= 0xf8; d[31]! &= 0x1f; d[31]! |= 0x40;
  return { kL: d.slice(0, 32), kR: d.slice(32, 64), chainCode: d.slice(64, 96) };
}

/** A = kL·G (kL taken modulo the group order, which does not change the point). */
export function xprvPublicKey(k: XPrv): Uint8Array {
  const s = leToBig(k.kL) % L;
  if (s === 0n) throw new Error('invalid extended key');
  return ed25519.Point.BASE.multiply(s).toBytes();
}

/** One derivation step (V2). `index` ≥ 2^31 is hardened. */
export function deriveChild(k: XPrv, index: number): XPrv {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('derivation index out of range');
  const i = le32(index);
  const [z, c] = index >= HARDENED
    ? [hmac(sha512, k.chainCode, cat(Uint8Array.of(0x00), k.kL, k.kR, i)), hmac(sha512, k.chainCode, cat(Uint8Array.of(0x01), k.kL, k.kR, i))]
    : (() => { const A = xprvPublicKey(k); return [hmac(sha512, k.chainCode, cat(Uint8Array.of(0x02), A, i)), hmac(sha512, k.chainCode, cat(Uint8Array.of(0x03), A, i))]; })();
  const kL = bigToLe((leToBig(k.kL) + 8n * leToBig(z.subarray(0, 28))) & ((1n << 256n) - 1n), 32);
  const kR = bigToLe((leToBig(k.kR) + leToBig(z.subarray(32, 64))) & ((1n << 256n) - 1n), 32);
  return { kL, kR, chainCode: c.slice(32, 64) };
}

/** Derive along a path such as m/1852'/1815'/0'/0/0. */
export function derivePath(master: XPrv, path: string): XPrv {
  if (!/^m(\/\d{1,10}'?)+$/.test(path)) throw new Error('invalid derivation path');
  let k = master;
  for (const seg of path.split('/').slice(1)) {
    const hardened = seg.endsWith("'"), n = Number(hardened ? seg.slice(0, -1) : seg);
    if (n >= HARDENED) throw new Error('invalid derivation path');
    k = deriveChild(k, hardened ? n + HARDENED : n);
  }
  return k;
}

/** Ed25519 signature with an extended key. Deterministic; verified against the public key before it is returned. */
export function xprvSign(k: XPrv, message: Uint8Array): Uint8Array {
  const a = leToBig(k.kL) % L, A = xprvPublicKey(k);
  const r = leToBig(sha512(cat(k.kR, message))) % L;
  if (r === 0n) throw new Error('signing failed');
  const R = ed25519.Point.BASE.multiply(r).toBytes();
  const h = leToBig(sha512(cat(R, A, message))) % L;
  const sig = cat(R, bigToLe((r + h * a) % L, 32));
  if (!ed25519.verify(sig, message, A)) throw new Error('signature self-check failed');
  return sig;
}

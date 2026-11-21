/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/build-sol.ts
 * Module           : core
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

import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { baseUnits } from './amounts.ts';
import { normalizeAddress } from './address.ts';
import { getAsset } from './networks.ts';
import type { Intent } from './intent.ts';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const enc = new TextEncoder();

function isOnCurve(b: Uint8Array): boolean {
  try { ed25519.Point.fromBytes(b); return true; } catch { return false; }
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const pid = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256.create();
    for (const s of seeds) h.update(s);
    h.update(new Uint8Array([bump])).update(pid).update(enc.encode('ProgramDerivedAddress'));
    const out = h.digest();
    if (!isOnCurve(out)) return base58.encode(out);
  }
  throw new Error('no PDA found');
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  return findProgramAddress([base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)], ATA_PROGRAM);
}
export const tokenProgramOf = (a: { program?: 'token' | 'token2022' }) => (a.program === 'token2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if (n === 0) { out.push(b); return out; } out.push(b | 0x80); }
}
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n: bigint) => { if (n < 0n || n >= 1n << 64n) throw new Error('u64 overflow'); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...a: (Uint8Array | number[])[]) => Uint8Array.from(a.flatMap((x) => Array.from(x)));

interface Ix { program: string; accounts: string[]; data: Uint8Array }

/** Rebuild the exact legacy transaction message bytes from an intent. Fixed instruction set only. */
export function buildSolMessage(i: Intent): Uint8Array {
  if (i.network !== 'solana' || !i.sol) throw new Error('not a Solana intent');
  const asset = getAsset('solana', i.asset);
  if (asset.decimals !== i.decimals || asset.symbol !== i.symbol) throw new Error('asset metadata mismatch');
  const from = normalizeAddress('solana', i.from), to = normalizeAddress('solana', i.to);
  if (from === to) throw new Error('source equals destination');
  const tp = tokenProgramOf(asset);
  const reserved = [SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, asset.id];
  if (reserved.includes(to)) throw new Error('destination is a program or mint');
  const amount = baseUnits(i.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  const price = baseUnits(i.sol.computeUnitPrice);
  // fee = 5000 lamports/signature + ceil(limit * microLamports / 1e6)
  const fee = 5000n + (BigInt(i.sol.computeUnitLimit) * price + 999_999n) / 1_000_000n;
  if (fee > baseUnits(i.maxFee)) throw new Error('fee exceeds approved maximum');
  const blockhash = base58.decode(i.sol.recentBlockhash);
  if (blockhash.length !== 32) throw new Error('bad blockhash');

  const ixs: Ix[] = [
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cat([2], u32le(i.sol.computeUnitLimit)) },
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cat([3], u64le(price)) },
  ];
  let writable: string[], readonly: string[];
  if (asset.id === 'native') {
    if (i.sol.createAta) throw new Error('createAta is invalid for native transfers');
    ixs.push({ program: SYSTEM_PROGRAM, accounts: [from, to], data: cat(u32le(2), u64le(amount)) });
    writable = [to]; readonly = [SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM];
  } else {
    const src = associatedTokenAddress(from, asset.id, tp), dst = associatedTokenAddress(to, asset.id, tp);
    if (i.sol.createAta) ixs.push({ program: ATA_PROGRAM, accounts: [from, dst, to, asset.id, SYSTEM_PROGRAM, tp], data: Uint8Array.of(1) });
    ixs.push({ program: tp, accounts: [src, asset.id, dst, from], data: cat([12], u64le(amount), [i.decimals]) }); // TransferChecked (same layout in Token-2022)
    writable = [src, dst];
    readonly = i.sol.createAta
      ? [to, asset.id, SYSTEM_PROGRAM, tp, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM]
      : [asset.id, tp, COMPUTE_BUDGET_PROGRAM];
  }
  const keys = [from, ...writable, ...readonly];
  if (new Set(keys).size !== keys.length) throw new Error('duplicate account keys');
  const idx = (k: string) => { const n = keys.indexOf(k); if (n < 0) throw new Error('unknown key'); return n; };
  const body: (Uint8Array | number[])[] = [[1, 0, readonly.length], compactU16(keys.length)];
  for (const k of keys) body.push(base58.decode(k));
  body.push(blockhash, compactU16(ixs.length));
  for (const ix of ixs) body.push([idx(ix.program)], compactU16(ix.accounts.length), ix.accounts.map(idx), compactU16(ix.data.length), ix.data);
  return cat(...body);
}

/** Wire format: compact signature count + 64-byte signature + message. */
export function solWireTransaction(signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('bad signature length');
  return cat([1], signature, message);
}

export function solFeeLamports(computeUnitLimit: number, computeUnitPrice: bigint): bigint {
  return 5000n + (BigInt(computeUnitLimit) * computeUnitPrice + 999_999n) / 1_000_000n;
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/families.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// Plugin contract for chain families beyond the three built-in ones (evm, btc, sol).
// One file per family implements this; the signer, the API pre-check and the address validator all go through it,
// so the bytes the owner approves, the bytes the API simulates and the bytes the signer signs come from the same code.
import type { Intent } from './intent.ts';
import type { NetworkDef } from './networks.ts';

/** Signing capability handed to a plugin by the signer. The private key itself never leaves the signer's key module. */
export interface KeyHandle {
  curve: 'secp256k1' | 'ed25519';
  /** secp256k1: 33-byte compressed key. ed25519: 32-byte key (Cardano, keyScheme 'cip1852': 64 bytes = payment key ‖ stake key; only the payment key signs). */
  publicKey: Uint8Array;
  /** secp256k1 only: sign a 32-byte digest (deterministic, low-S). */
  signDigest?(digest: Uint8Array): { compact: Uint8Array; recovery: number; der: Uint8Array };
  /** ed25519 only: sign a message. */
  signMessage?(message: Uint8Array): Uint8Array;
}

export interface Signed { raw: string; txid: string }

export interface FamilyPlugin {
  family: string;
  curve: 'secp256k1' | 'ed25519';
  /**
   * v8-cardano-polkadot: how an ed25519 key is derived from the seed. Absent / 'slip10' = SLIP-0010 from the BIP-39 seed (every
   * family before Cardano). 'cip1852' = BIP32-Ed25519 (Icarus master key from the BIP-39 entropy), which allows soft derivation.
   */
  keyScheme?: 'slip10' | 'cip1852';
  /** derivation path for this network (hardened-only for ed25519 / SLIP-0010) */
  path(net: NetworkDef): string;
  /** the wallet's address on this network, from its public key */
  address(net: NetworkDef, publicKey: Uint8Array): string;
  /** validate and normalize a destination address; throws when invalid */
  normalizeAddress(net: NetworkDef, addr: string): string;
  /**
   * Rebuild the exact transaction from the intent alone and return what will be signed.
   * Must throw on anything that is not a plain native transfer or an allowlisted token transfer,
   * on a fee above intent.maxFee, and on any field it does not understand. `aux` is unauthenticated helper data
   * (never trusted: everything in it must be verified against the intent).
   */
  build(i: Intent, net: NetworkDef, aux?: Record<string, unknown>): { signDocs: Uint8Array[]; describe: Record<string, string> };
  /** build + sign + serialize for broadcast */
  sign(i: Intent, net: NetworkDef, key: KeyHandle, aux?: Record<string, unknown>): Signed;
}

export const PLUGINS: Record<string, FamilyPlugin> = {};
export function registerFamily(p: FamilyPlugin): void { PLUGINS[p.family] = p; }
export function pluginFor(net: NetworkDef): FamilyPlugin {
  const p = PLUGINS[net.family];
  if (!p) throw new Error(`no implementation for chain family "${net.family}"`);
  return p;
}
export const isBuiltinFamily = (f: string) => f === 'evm' || f === 'btc' || f === 'sol';

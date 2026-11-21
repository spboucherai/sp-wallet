/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/address.ts
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

import { base58, bech32, bech32m } from '@scure/base';
import { getAddress, isAddress } from 'viem';
import { Address as BtcAddress } from '@scure/btc-signer';
import { pluginFor } from './families.ts';
import { btcParams } from './build-btc.ts';
import { getNetwork } from './networks.ts';

/** Returns the normalized address or throws. EVM → EIP-55 checksum form. */
export function normalizeAddress(network: string, addr: string): string {
  const n = getNetwork(network);
  const a = addr.trim();
  if (n.family === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('invalid EVM address');
    // Mixed-case input must carry a valid checksum; all-lower / all-upper is accepted and checksummed.
    const body = a.slice(2);
    const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
    if (mixed && !isAddress(a, { strict: true })) throw new Error('bad EVM checksum');
    const out = getAddress(a.toLowerCase());
    if (out === '0x0000000000000000000000000000000000000000') throw new Error('zero address');
    return out;
  }
  if (n.family === 'btc') {
    // this network only; decode validates checksum, prefix/version and program length
    const d = BtcAddress(btcParams(n)).decode(a);
    if (!['wpkh', 'wsh', 'tr', 'pkh', 'sh'].includes(d.type)) throw new Error(`unsupported ${n.name} address type`);
    if (n.utxo?.kind === 'pkh' && !['pkh', 'sh'].includes(d.type)) throw new Error(`unsupported ${n.name} address type`);
    const hrp = n.utxo?.bech32;
    if (hrp && a.toLowerCase().startsWith(hrp + '1')) {
      if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error('mixed-case bech32');
      const lower = a.toLowerCase();
      (d.type === 'tr' ? bech32m : bech32).decode(lower as `${string}1${string}`);
      return lower;
    }
    return a;
  }
  if (n.family !== 'sol') return pluginFor(n).normalizeAddress(n, a);
  const raw = base58.decode(a);
  if (raw.length !== 32) throw new Error('invalid Solana address');
  if (base58.encode(raw) !== a) throw new Error('non-canonical Solana address');
  return a;
}

export function isValidAddress(network: string, addr: string): boolean {
  try { normalizeAddress(network, addr); return true; } catch { return false; }
}

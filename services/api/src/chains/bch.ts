/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/bch.ts
 * Module           : chains
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

import { bchIsP2sh, encodeBchInputs, estimateBchSize, type NetworkDef } from '@spw/core';
import { utxoAdapter, type Source } from './btc.ts';
import type { Adapter } from './rpc.ts';

/**
 * Bitcoin Cash: same indexer sources and coin selection as the other Bitcoin-style chains (two independent indexers must agree
 * on the spendable coin set); the intent carries the coins in the plugin section `x`. No previous transactions are needed:
 * the signature digest commits to every input value. Chain identity is the first block after the last chain split (registry
 * `refHeight`, block 661648), because the genesis block is also Bitcoin's, Bitcoin SV's and eCash's.
 */
export function bchAdapter(n: NetworkDef, sources?: Source[]): Adapter {
  return utxoAdapter(n, {
    size: (k, to, hasChange) => estimateBchSize(k, bchIsP2sh(n, to), hasChange),
    section: async (chosen, change, fee) => ({ section: { x: { inputs: encodeBchInputs(chosen), change: change.toString(), fee: fee.toString() } } }),
  }, sources);
}

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/rpc-override.ts
 * Module           : services
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

// TEST ONLY. Lets an integration test point a network at a local fork (anvil). Never set in production: the API prints a
// loud warning at start when it is.
import { NETWORKS } from '@spw/core';
const raw = process.env.SPW_RPC_OVERRIDE;
if (raw) {
  const map = JSON.parse(raw) as Record<string, string[]>;
  for (const [id, urls] of Object.entries(map)) { const n = NETWORKS[id]; if (!n) throw new Error(`SPW_RPC_OVERRIDE: unknown network ${id}`); n.rpc = urls; }
  console.warn(`\n*** SPW_RPC_OVERRIDE is set: ${Object.keys(map).join(', ')} do NOT use their real endpoints. This must never happen in production. ***\n`);
}
export const rpcOverridden = !!raw;
/** v8: which networks are pointed elsewhere (a proof script may fork one EVM network and still read Solana from its real endpoints) */
export const rpcOverriddenNetworks: ReadonlySet<string> = new Set(raw ? Object.keys(JSON.parse(raw) as Record<string, unknown>) : []);

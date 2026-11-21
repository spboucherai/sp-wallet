/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/chains/index.ts
 * Module           : chains
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

import '../rpc-override.ts'; // must run before any adapter reads the registry
import { NETWORKS, type NetworkDef } from '@spw/core';
import { aptosAdapter } from './aptos.ts';
import { bchAdapter } from './bch.ts';
import { btcAdapter } from './btc.ts';
import { cardanoAdapter } from './cardano.ts';
import { cosmosAdapter } from './cosmos.ts';
import { evmAdapter } from './evm.ts';
import { nearAdapter } from './near.ts';
import { polkadotAdapter } from './polkadot.ts';
import { solAdapter } from './sol.ts';
import { stellarAdapter } from './stellar.ts';
import { suiAdapter } from './sui.ts';
import { tonAdapter } from './ton.ts';
import { tronAdapter } from './tron.ts';
import { xrplAdapter } from './xrpl.ts';
import type { Adapter } from './rpc.ts';

/** Adapter factories for plugin families (registered by each family's API module). */
export const ADAPTER_FACTORIES: Record<string, (n: NetworkDef) => Adapter> = { evm: evmAdapter, btc: btcAdapter, sol: solAdapter, aptos: aptosAdapter, bch: bchAdapter, cardano: cardanoAdapter, cosmos: cosmosAdapter, near: nearAdapter, polkadot: polkadotAdapter, stellar: stellarAdapter, sui: suiAdapter, ton: tonAdapter, tron: tronAdapter, xrpl: xrplAdapter };
const make = (n: NetworkDef): Adapter => { const f = ADAPTER_FACTORIES[n.family]; if (!f) throw new Error(`no API adapter for family ${n.family}`); return f(n); };
export const adapters: Record<string, Adapter> = Object.fromEntries((Object.values(NETWORKS) as NetworkDef[]).map((n) => [n.id, make(n)]));
export const adapterFor = (network: string): Adapter => { const a = adapters[network]; if (!a) throw new Error(`unknown network ${network}`); return a; };
export * from './rpc.ts';

/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/plugins/index.ts
 * Module           : plugins
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

// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.
import { registerFamily } from '../families.ts';
import { aptosPlugin } from './aptos.ts';
import { bchPlugin } from './bch.ts';
import { cardanoPlugin } from './cardano.ts';
import { cosmosPlugin } from './cosmos.ts';
import { nearPlugin } from './near.ts';
import { polkadotPlugin } from './polkadot.ts';
import { stellarPlugin } from './stellar.ts';
import { suiPlugin } from './sui.ts';
import { tonPlugin } from './ton.ts';
import { tronPlugin } from './tron.ts';
import { xrplPlugin } from './xrpl.ts';

for (const p of [aptosPlugin, bchPlugin, cardanoPlugin, cosmosPlugin, nearPlugin, polkadotPlugin, stellarPlugin, suiPlugin, tonPlugin, tronPlugin, xrplPlugin]) registerFamily(p);

export * from './aptos.ts';
export * from './bch.ts';
export * from './cardano.ts';
export * from './cosmos.ts';
export * from './near.ts';
export * from './polkadot.ts';
export * from './stellar.ts';
export * from './sui.ts';
export * from './ton.ts';
export * from './tron.ts';
export * from './xrpl.ts';

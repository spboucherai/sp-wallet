/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-swap-thorchain.mts
 * Module           : scripts
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

// Live READ-ONLY check of the THORChain swap adapter (price discovery). Nothing is built, signed or broadcast.
//   npx tsx scripts/smoke-swap-thorchain.mts
// See scripts/lib/smoke-native-swap.mts for what is verified.
import { THORCHAIN_API_VERSION, THORCHAIN_CONFIG } from '../packages/swap/src/providers/thorchain.ts';
import { native, smokeNativeSwap, token } from './lib/smoke-native-swap.mts';

await smokeNativeSwap(THORCHAIN_CONFIG, THORCHAIN_API_VERSION, [
  { from: native('bitcoin'), to: native('ethereum') },
  { from: native('ethereum'), to: native('bitcoin') },
  { from: native('bitcoin'), to: token('ethereum', 'USDC') },
  { from: native('dogecoin'), to: native('bitcoin') },
  { from: token('ethereum', 'USDC'), to: native('bitcoin') },
  { from: native('litecoin'), to: native('ethereum') },
  { from: native('xrpl'), to: native('tron') },
  { from: native('solana'), to: token('avalanche', 'USDC') },
  { from: native('bitcoin'), to: native('ethereum'), units: 20, slippageBps: 300, note: 'large: streaming expected' },
  { from: native('bitcoin'), to: native('ethereum'), usd: 2, expect: 'no_route', note: '(below recommended_min_amount_in)' },
  { from: native('bitcoin'), to: token('ethereum', 'LINK'), expect: 'unsupported', note: '(ETH.LINK pool is Staged)' },
]);

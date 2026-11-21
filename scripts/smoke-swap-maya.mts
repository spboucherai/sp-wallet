/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-swap-maya.mts
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

// Live READ-ONLY check of the Maya Protocol swap adapter (price discovery). Nothing is built, signed or broadcast.
//   npx tsx scripts/smoke-swap-maya.mts
// See scripts/lib/smoke-native-swap.mts for what is verified.
import { MAYA_API_VERSION, MAYA_CONFIG } from '../packages/swap/src/providers/maya.ts';
import { native, smokeNativeSwap, token } from './lib/smoke-native-swap.mts';

await smokeNativeSwap(MAYA_CONFIG, MAYA_API_VERSION, [
  { from: native('bitcoin'), to: native('ethereum') },
  { from: native('ethereum'), to: native('bitcoin') },
  { from: native('bitcoin'), to: token('ethereum', 'USDC') },
  { from: token('ethereum', 'USDT'), to: native('bitcoin') },
  { from: native('ethereum'), to: token('arbitrum', 'USDC') },
  { from: native('arbitrum'), to: native('bitcoin') },
  { from: native('bitcoin'), to: native('arbitrum') },
  { from: native('bitcoin'), to: native('ethereum'), units: 2, slippageBps: 300, note: 'large: streaming expected' },
  { from: native('ethereum'), to: native('bitcoin'), usd: 1, expect: 'no_route', note: '(cannot pay the BTC outbound fee)' },
  { from: native('dogecoin'), to: native('bitcoin'), expect: 'unsupported', note: '(Maya has no DOGE pool)' },
]);

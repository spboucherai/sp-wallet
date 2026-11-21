/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/gmx/index.ts
 * Module           : venues
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

export { createGmxAdapter, GMX_CAPABILITIES, GMX_ENDPOINTS, GMX_FUNDING_INTERVAL_SEC, type GmxAdapter, type GmxAdapterOptions, type GmxChain,
  type GmxFill, type GmxLiquidity, type GmxOrder, type GmxPosition } from './adapter.ts';
export { apiPrice as gmxApiPrice, bps as gmxBps, contractPrice as gmxContractPrice, toContractPrice as gmxToContractPrice, tokenAmount as gmxTokenAmount,
  usd as gmxUsd, perSecondToHourly as gmxPerSecondToHourly, priceStep as gmxPriceStep, MAX_UINT256, USD_DECIMALS } from './wire.ts';
